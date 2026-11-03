// SPDX-License-Identifier: AGPL-3.0-or-later
//! Recurrence adopts through native Editing and publishes only committed deltas.

use super::*;
use crate::workspace_automation::recurring_task::due_value;
use myoxus_domain::{recurrence::*, scheduling::*, workspace_automation::*};

fn invalid() -> DatabaseServiceError {
  DatabaseServiceError::new(
    ERR_ROW_INVALID,
    "open native Task and current recurrence inputs required",
  )
}

fn task_field<'a>(record: &'a DatabaseRecord, role: &str) -> DatabaseResult<&'a DatabaseField> {
  let mapping = record
    .field_roles
    .iter()
    .find(|field| {
      field.profile_kind == DatabaseProfileKind::Project
        && field.row_kind_scope.as_deref() == Some("task")
        && field.role_key == role
    })
    .ok_or_else(invalid)?;
  if record.field_roles.iter().any(|other| {
    other.field_id == mapping.field_id && other.row_kind_scope.as_deref() == Some("task") && other.role_key != role
  }) {
    return Err(invalid());
  }
  record
    .fields
    .iter()
    .find(|field| field.id == mapping.field_id)
    .ok_or_else(invalid)
}

impl DatabaseEditingService {
  pub(crate) async fn assert_recurrence_access(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    write: bool,
  ) -> DatabaseResult<()> {
    access::assert_workspace(
      &self.permission,
      actor,
      workspace,
      if write {
        WorkspaceAction::CreateDoc
      } else {
        WorkspaceAction::Read
      },
    )
    .await
  }

  /// Skip uses ordinary Task status publication, but its receipt and successor
  /// are committed in the same SQL transaction as the Archived transition.
  #[tracing::instrument(skip_all)]
  pub(crate) async fn skip_recurrence(
    &self,
    repo: &dyn TaskRecurrenceRepository,
    command: TaskRecurrenceSkip,
  ) -> DatabaseResult<bool> {
    self
      .assert_recurrence_access(command.actor_id, command.workspace_id, true)
      .await?;
    let view = repo
      .read(command.workspace_id, command.series_id)
      .await?
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "Task recurrence unavailable"))?;
    if view.schedule.lifecycle == ScheduleLifecycle::Ended {
      return Err(invalid());
    }
    let member = repo
      .member(command.workspace_id, command.series_id, command.member_id)
      .await?
      .ok_or_else(invalid)?;
    // A committed Complete/Skip wins over a later replay even if the original
    // Task moved or was deleted. Only its authorized series receipt is read.
    if member.advanced_at.is_some() {
      return Ok(repo.skip(command, None).await?.accepted);
    }
    let row = self
      .row_repo
      .get_row(member.row_id)
      .await?
      .filter(|row| row.row.row_kind == DatabaseRowKind::Task && row.row.deleted_at.is_none())
      .ok_or_else(invalid)?;
    let record = access::get_database(
      &self.permission,
      &self.schema_repo,
      command.actor_id,
      row.row.database_id,
    )
    .await?;
    self
      .assert_recurrence_access(command.actor_id, record.database.workspace_id, true)
      .await?;
    if record.database.deleted_at.is_some() || record.database.profile_kind != DatabaseProfileKind::Project {
      return Err(invalid());
    }
    let field = task_field(&record, "task.status")?;
    let DatabaseFieldConfig::Status(config) = &field.config else {
      return Err(invalid());
    };
    let archived = config
      .options
      .iter()
      .find(|option| option.group == DatabaseStatusGroup::Archived)
      .ok_or_else(invalid)?;
    let actor = command.actor_id;
    let outcome = repo
      .skip(
        command,
        Some(TaskRecurrenceSkipTarget {
          database_id: record.database.id,
          workspace_id: record.database.workspace_id,
          row_id: member.row_id,
          status_field_id: field.id,
          archived_option_id: archived.id.clone(),
        }),
      )
      .await?;
    if let Some(cell) = outcome.changed_cell {
      self
        .publish_committed_cell_update(actor, &record, &row, field, &cell)
        .await;
    }
    Ok(outcome.accepted)
  }

  pub(crate) async fn audit_recurrence_control(&self, actor: UserId, id: Uuid, action: &'static str) {
    self
      .effects
      .record_audit(
        action,
        AuditCategory::Database,
        Some(AuditTarget::entity("task_recurrence_series", id, None)),
        actor,
        None,
        None,
      )
      .await;
  }

  async fn recurrence_destination(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    id: DatabaseId,
  ) -> DatabaseResult<DatabaseRecord> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, id).await?;
    if record.database.workspace_id != workspace
      || record.database.deleted_at.is_some()
      || record.database.profile_kind != DatabaseProfileKind::Project
      || !record
        .managed_schema
        .as_ref()
        .is_some_and(|schema| schema.readiness == DatabaseManagedSchemaReadiness::Ready)
    {
      return Err(invalid());
    }
    access::assert_workspace(&self.permission, actor, workspace, WorkspaceAction::CreateDoc).await?;
    Ok(record)
  }

  pub(crate) async fn prepare_recurring_task(
    &self,
    plan: &ScheduledPlan,
    recipe: &TaskRecurrenceRecipe,
    slot: Occurrence,
  ) -> DatabaseResult<AcceptedRecurringTask> {
    let actor = plan.actor_id.ok_or_else(invalid)?;
    let record = self
      .recurrence_destination(actor, plan.workspace_id, recipe.database_id)
      .await?;
    let status = task_field(&record, "task.status")?;
    let DatabaseFieldConfig::Status(config) = &status.config else {
      return Err(invalid());
    };
    let open = config
      .options
      .iter()
      .find(|option| {
        option.id == config.default_option_id
          && matches!(
            option.group,
            DatabaseStatusGroup::NotStarted | DatabaseStatusGroup::Active
          )
      })
      .or_else(|| {
        config
          .options
          .iter()
          .find(|option| option.group == DatabaseStatusGroup::NotStarted)
      })
      .or_else(|| {
        config
          .options
          .iter()
          .find(|option| option.group == DatabaseStatusGroup::Active)
      })
      .ok_or_else(invalid)?;
    let mut cells = vec![
      WorkspaceAutomationCellInput {
        field_id: status.id,
        value: DatabaseCellValueData::Status(open.id.clone()),
      },
      WorkspaceAutomationCellInput {
        field_id: task_field(&record, "task.dueDate")?.id,
        value: DatabaseCellValueData::DateTime(due_value(slot, plan.zone)),
      },
      WorkspaceAutomationCellInput {
        field_id: task_field(&record, "task.assignees")?.id,
        value: DatabaseCellValueData::Users(recipe.assignees.clone()),
      },
    ];
    if let Some(description) = &recipe.description {
      cells.push(WorkspaceAutomationCellInput {
        field_id: task_field(&record, "task.description")?.id,
        value: DatabaseCellValueData::RichText(description.clone()),
      });
    }
    if let Some(priority) = &recipe.priority {
      cells.push(WorkspaceAutomationCellInput {
        field_id: task_field(&record, "task.priority")?.id,
        value: DatabaseCellValueData::Select(priority.clone()),
      });
    }
    for cell in &cells {
      let field = record
        .fields
        .iter()
        .find(|field| field.id == cell.field_id)
        .ok_or_else(invalid)?;
      rules::validate_cell_value(field, &cell.value, &self.limits)?;
      access::validate_user_cell_membership(&self.workspace_store, plan.workspace_id, &cell.value).await?;
    }
    let ScheduleTarget::RecurringTask { series_id } = plan.target else {
      return Err(invalid());
    };
    let occurrence_id = task_occurrence_id(plan.id, slot.nominal, plan.next_cause_member_id);
    Ok(AcceptedRecurringTask {
      cause_member_id: plan.next_cause_member_id,
      schedule_id: plan.id,
      zone: plan.zone,
      occurrence_id,
      series_id,
      generation: plan.generation,
      slot,
      row_id: Uuid::new_v5(&occurrence_id, b"row"),
      database_id: recipe.database_id,
      title: crate::database::definition::rules::validate_title(&recipe.title)?,
      cells,
    })
  }

  #[allow(clippy::too_many_arguments)]
  #[tracing::instrument(skip_all)]
  pub(crate) async fn adopt_recurrence(
    &self,
    repo: &dyn TaskRecurrenceRepository,
    actor: UserId,
    expected_workspace: WorkspaceId,
    database: DatabaseId,
    row_id: DatabaseRowId,
    expected_row_revision: i64,
    expected_due_revision: i64,
    mut rule: ScheduleRule,
    zone: AdmissionZone,
    mut recipe: TaskRecurrenceRecipe,
  ) -> DatabaseResult<TaskRecurrenceActivation> {
    rule.validate(zone).map_err(|_| invalid())?;
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database).await?;
    let workspace = record.database.workspace_id;
    if workspace != expected_workspace {
      return Err(DatabaseServiceError::new(
        ERR_NOT_FOUND,
        "Task recurrence source unavailable",
      ));
    }
    self.recurrence_destination(actor, workspace, database).await?;
    let row = self
      .row_repo
      .get_row(row_id)
      .await?
      .filter(|row| {
        row.row.database_id == database && row.row.row_kind == DatabaseRowKind::Task && row.row.deleted_at.is_none()
      })
      .ok_or_else(invalid)?;
    if expected_row_revision < 1 || expected_due_revision < 0 {
      return Err(invalid());
    }
    let due_field = task_field(&record, "task.dueDate")?;
    let (first, next, validation) = match &mut rule {
      ScheduleRule::Fixed { rule } => {
        let first = crate::scheduling::fixed_occurrence(rule.start, zone.timezone())
          .map_err(|_| invalid())?
          .ok_or_else(invalid)?;
        let next =
          crate::scheduling::next_after(rule, first.due_at, CalculationBudget::default()).map_err(|_| invalid())?;
        (Some(first), next, first)
      }
      ScheduleRule::AfterCompletion { interval, date_only } => {
        *date_only = row
          .cells
          .iter()
          .find(|cell| cell.field_id == due_field.id)
          .is_some_and(|cell| matches!(&cell.value, DatabaseCellValueData::DateTime(value) if value.all_day));
        let local = Utc::now().with_timezone(&zone.timezone()).naive_local();
        let reference = if *date_only {
          ScheduleValue::Date(local.date())
        } else {
          ScheduleValue::LocalDateTime(local)
        };
        let validation = crate::scheduling::relative_after(reference, *interval, zone).map_err(|_| invalid())?;
        (None, None, validation)
      }
    };
    recipe.title = crate::database::definition::rules::validate_title(&recipe.title)?;
    let id = Uuid::new_v4();
    let series = TaskRecurrenceSeries {
      id,
      workspace_id: workspace,
      recipe,
      current_member_id: matches!(rule, ScheduleRule::AfterCompletion { .. }).then(|| Uuid::new_v5(&id, b"adopted")),
      created_at: Utc::now(),
    };
    let plan = ScheduledPlan {
      id: series.id,
      workspace_id: workspace,
      actor_id: Some(actor),
      target: ScheduleTarget::RecurringTask { series_id: series.id },
      zone,
      rule: Some(rule.clone()),
      lifecycle: ScheduleLifecycle::Active,
      generation: 1,
      revision: 1,
      next,
      next_cause_member_id: None,
      next_admission_at: next.and_then(|_| first.map(|first| first.due_at)),
      blocked_reason: None,
    };
    self.prepare_recurring_task(&plan, &series.recipe, validation).await?;
    let mut reminders = Vec::new();
    if let Some(first) = first {
      let due = due_value(first, zone);
      rules::validate_cell_value(due_field, &DatabaseCellValueData::DateTime(due.clone()), &self.limits)?;
      rules::validate_timeline_row_ranges(
        &record,
        &row.cells,
        row.row.created_at,
        row.row.updated_at,
        &HashMap::from([(due_field.id, Some(DatabaseCellValueData::DateTime(due.clone())))]),
        false,
        DatabaseRowKind::Task,
      )?;
      reminders = self
        .reminders
        .database_row_reminder_reschedules(row_id, due_field.id, &due)
        .await?;
    }
    let changed = repo
      .adopt(
        AdoptTaskSeries {
          series: series.clone(),
          actor_id: actor,
          database_id: database,
          row_id,
          expected_row_revision,
          expected_due_revision,
          due_field_id: due_field.id,
          status_field_id: task_field(&record, "task.status")?.id,
          rule,
          zone,
          first,
          next,
        },
        reminders,
      )
      .await?;
    if let Some(changed) = changed {
      self
        .publish_committed_cell_update(actor, &record, &row, due_field, &changed)
        .await;
    }
    self
      .effects
      .record_audit(
        "task.recurrence.create",
        AuditCategory::Database,
        Some(AuditTarget::entity("task_recurrence_series", series.id, None)),
        actor,
        None,
        Some(serde_json::json!({"databaseId":database,"rowId":row_id,"seriesId":series.id})),
      )
      .await;
    let member = self.row_repo.get_row(row_id).await?.ok_or_else(invalid)?;
    Ok(TaskRecurrenceActivation { series, member })
  }

  pub(crate) async fn assert_recurrence_source_read(&self, actor: UserId, row_id: DatabaseRowId) -> DatabaseResult<()> {
    let row = self
      .row_repo
      .get_row(row_id)
      .await?
      .filter(|row| row.row.deleted_at.is_none() && row.row.row_kind == DatabaseRowKind::Task)
      .ok_or_else(invalid)?;
    let record = access::get_database(&self.permission, &self.schema_repo, actor, row.row.database_id).await?;
    if record.database.deleted_at.is_some()
      || record.database.profile_kind != DatabaseProfileKind::Project
      || !record
        .managed_schema
        .as_ref()
        .is_some_and(|schema| schema.readiness == DatabaseManagedSchemaReadiness::Ready)
    {
      return Err(invalid());
    }
    Ok(())
  }
}
