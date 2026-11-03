// SPDX-License-Identifier: AGPL-3.0-or-later
//! Recipe/adoption persistence shares canonical Task Editing transactions.

use crate::{scheduling::PgSchedulingRepository, workspace_database::PgDatabaseRepository};
mod advance;
mod lifecycle;
pub(crate) use advance::{advance_completed_member_in, lock_completion_source_in};
use async_trait::async_trait;
use myoxus_application::workspace_automation::recurring_task::due_value;
use myoxus_domain::{
  database::*,
  ids::*,
  recurrence::*,
  repositories::{RepoResult, RepositoryError},
  scheduling::*,
  workspace_automation::AcceptedRecurringTask,
};
use sqlx::{PgConnection, PgPool, Row};
use std::sync::Arc;
use uuid::Uuid;

fn storage(_: impl std::fmt::Display) -> RepositoryError {
  RepositoryError::Storage("Task recurrence persistence unavailable".into())
}
fn invalid() -> RepositoryError {
  RepositoryError::Validation("open native Task required for recurrence".into())
}

pub struct PgTaskRecurrenceRepository {
  pool: PgPool,
  databases: Arc<PgDatabaseRepository>,
}

impl PgTaskRecurrenceRepository {
  pub fn new(pool: PgPool, databases: Arc<PgDatabaseRepository>) -> Self {
    Self { pool, databases }
  }
}

#[async_trait]
impl TaskRecurrenceRepository for PgTaskRecurrenceRepository {
  async fn read_for_row(&self, workspace: WorkspaceId, row: DatabaseRowId) -> RepoResult<Option<TaskRecurrenceRead>> {
    lifecycle::read_for_row(&self.pool, workspace, row).await
  }
  async fn read(&self, workspace: WorkspaceId, id: Uuid) -> RepoResult<Option<TaskRecurrenceRead>> {
    lifecycle::read(&self.pool, workspace, id).await
  }
  async fn list(&self, workspace: WorkspaceId, after: Option<Uuid>, first: u32) -> RepoResult<Vec<TaskRecurrenceRead>> {
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM task_recurrence_series WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3")
      .bind(workspace).bind(after).bind(i64::from(first.clamp(1,50))).fetch_all(&self.pool).await.map_err(storage)?;
    let mut views = Vec::new();
    for id in ids {
      if let Some(view) = self.read(workspace, id).await? {
        views.push(view);
      }
    }
    Ok(views)
  }
  async fn member(
    &self,
    workspace: WorkspaceId,
    series: Uuid,
    member: Uuid,
  ) -> RepoResult<Option<TaskRecurrenceMember>> {
    let mut tx = self.pool.begin().await.map_err(storage)?;
    lifecycle::member_in(&mut tx, workspace, series, member).await
  }
  async fn control(&self, command: TaskRecurrenceControl) -> RepoResult<()> {
    lifecycle::control(self, command).await
  }
  async fn skip(
    &self,
    command: TaskRecurrenceSkip,
    target: Option<TaskRecurrenceSkipTarget>,
  ) -> RepoResult<TaskRecurrenceSkipOutcome> {
    lifecycle::skip(self, command, target).await
  }
  async fn series(&self, workspace: WorkspaceId, id: Uuid) -> RepoResult<Option<TaskRecurrenceSeries>> {
    let row = sqlx::query(
      "SELECT id,workspace_id,recipe_json,current_member_id,created_at FROM task_recurrence_series WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(storage)?;
    row
      .map(|row| {
        Ok(TaskRecurrenceSeries {
          id: row.try_get("id").map_err(storage)?,
          workspace_id: row.try_get("workspace_id").map_err(storage)?,
          recipe: serde_json::from_value(row.try_get("recipe_json").map_err(storage)?).map_err(storage)?,
          current_member_id: row.try_get("current_member_id").map_err(storage)?,
          created_at: row.try_get("created_at").map_err(storage)?,
        })
      })
      .transpose()
  }

  #[tracing::instrument(skip_all)]
  async fn adopt(
    &self,
    adoption: AdoptTaskSeries,
    reminders: Vec<DatabaseRowReminderReschedule>,
  ) -> RepoResult<Option<DatabaseCellWriteOutcome>> {
    match (&adoption.rule, adoption.first, adoption.series.current_member_id) {
      (ScheduleRule::Fixed { rule }, Some(first), None) if first.nominal == rule.start => {}
      (ScheduleRule::AfterCompletion { .. }, None, Some(member))
        if member == Uuid::new_v5(&adoption.series.id, b"adopted") => {}
      _ => return Err(invalid()),
    }
    let mut tx = self.pool.begin().await.map_err(storage)?;
    self.databases.capture_managed_admission(&mut tx).await?;
    let workspace = adoption.series.workspace_id;
    crate::workflow_runtime::effects::lock_runtime_authority(&mut tx, adoption.actor_id, workspace, false).await?;
    crate::workspace_automation::PgWorkspaceAutomationRepository::lock_document_review_tasks(
      &mut tx,
      &[adoption.row_id],
    )
    .await?;
    let mut databases = vec![adoption.database_id, adoption.series.recipe.database_id];
    databases.sort();
    databases.dedup();
    for database in databases {
      PgDatabaseRepository::lock_managed_admission(&mut tx, database).await?;
      // Also fence non-key lifecycle/owner changes when an unchanged first Due
      // needs no Cell write and therefore acquires no later mutation root lock.
      let live: Option<Uuid> = sqlx::query_scalar("SELECT d.id FROM workspace_databases d JOIN database_profiles p ON p.database_id=d.id AND p.profile_kind='project' WHERE d.id=$1 AND d.workspace_id=$2 AND d.deleted_at IS NULL FOR SHARE OF d,p NOWAIT")
        .bind(database).bind(workspace).fetch_optional(&mut *tx).await.map_err(storage)?;
      if live.is_none() {
        return Err(invalid());
      }
      PgDatabaseRepository::lock_project_definition_fields(&mut tx, database).await?;
    }
    let rows_table = crate::workspace_database::DATABASE_ROWS_TABLE;
    let cells_table = crate::workspace_database::DATABASE_CELL_VALUES_TABLE;
    let fields_table = crate::workspace_database::DATABASE_FIELDS_TABLE;
    let row = sqlx::query(&format!("SELECT edit_revision FROM {rows_table} WHERE id=$1 AND database_id=$2 AND row_kind='task' AND deleted_at IS NULL FOR UPDATE"))
      .bind(adoption.row_id).bind(adoption.database_id).fetch_optional(&mut *tx).await.map_err(storage)?
      .ok_or_else(invalid)?;
    if row.try_get::<i64, _>("edit_revision").map_err(storage)? != adoption.expected_row_revision {
      return Err(RepositoryError::Conflict("database row edit revision"));
    }
    // The native Row lock serializes every adoption; lifecycle stays solely on
    // scheduling_schedules rather than a duplicated native 'active' flag.
    let associated: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM task_recurrence_members m JOIN scheduling_schedules s ON s.id=m.series_id WHERE m.row_id=$1 AND s.lifecycle<>'ended')")
      .bind(adoption.row_id).fetch_one(&mut *tx).await.map_err(storage)?;
    if associated {
      return Err(RepositoryError::Conflict(
        "Task already belongs to an active recurrence",
      ));
    }
    let roles = sqlx::query(&format!("SELECT r.role_key,r.field_id,f.config_json FROM database_field_roles r JOIN {fields_table} f ON f.id=r.field_id AND f.database_id=r.database_id WHERE r.database_id=$1 AND r.profile_kind='project' AND r.row_kind_scope='task' AND r.role_key IN ('task.status','task.dueDate')"))
      .bind(adoption.database_id).fetch_all(&mut *tx).await.map_err(storage)?;
    if !roles.iter().any(|row| {
      row
        .try_get::<String, _>("role_key")
        .is_ok_and(|key| key == "task.dueDate")
        && row
          .try_get::<Uuid, _>("field_id")
          .is_ok_and(|id| id == adoption.due_field_id)
    }) {
      return Err(invalid());
    }
    let status_role = roles
      .iter()
      .find(|row| {
        row
          .try_get::<String, _>("role_key")
          .is_ok_and(|key| key == "task.status")
          && row
            .try_get::<Uuid, _>("field_id")
            .is_ok_and(|id| id == adoption.status_field_id)
      })
      .ok_or_else(invalid)?;
    let config: DatabaseFieldConfig =
      serde_json::from_value(status_role.try_get("config_json").map_err(storage)?).map_err(storage)?;
    let DatabaseFieldConfig::Status(config) = config else {
      return Err(invalid());
    };
    let status: Option<serde_json::Value> = sqlx::query_scalar(&format!(
      "SELECT value_json FROM {cells_table} WHERE row_id=$1 AND field_id=$2"
    ))
    .bind(adoption.row_id)
    .bind(adoption.status_field_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(storage)?;
    let status = status
      .map(|value| PgDatabaseRepository::map_cell_value_from_json(DatabaseFieldType::Status, value))
      .transpose()?;
    let status = match &status {
      Some(DatabaseCellValueData::Status(id)) => id,
      None => &config.default_option_id,
      _ => return Err(invalid()),
    };
    if !config.options.iter().any(|option| {
      option.id == *status
        && matches!(
          option.group,
          DatabaseStatusGroup::NotStarted | DatabaseStatusGroup::Active
        )
    }) {
      return Err(invalid());
    }
    let current = sqlx::query(&format!(
      "SELECT value_json,edit_revision FROM {cells_table} WHERE row_id=$1 AND field_id=$2"
    ))
    .bind(adoption.row_id)
    .bind(adoption.due_field_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(storage)?;
    let revision = current
      .as_ref()
      .map(|row| row.try_get::<i64, _>("edit_revision"))
      .transpose()
      .map_err(storage)?
      .unwrap_or(0);
    if revision != adoption.expected_due_revision {
      return Err(RepositoryError::Conflict("database cell edit revision"));
    }
    let current = current
      .map(|row| {
        PgDatabaseRepository::map_cell_value_from_json(
          DatabaseFieldType::DateTime,
          row.try_get("value_json").map_err(storage)?,
        )
      })
      .transpose()?;
    let due = adoption
      .first
      .map(|first| DatabaseCellValueData::DateTime(due_value(first, adoption.zone)));
    let changed = if due.is_none() || current.as_ref() == due.as_ref() {
      None
    } else {
      Some(
        self
          .databases
          .update_cell_value_in_tx(
            &mut tx,
            adoption.row_id,
            adoption.due_field_id,
            due.ok_or_else(invalid)?,
            adoption.actor_id,
            DatabaseEditPrecondition::new(Some(adoption.expected_due_revision), false)
              .in_workspace(workspace)
              .in_database(adoption.database_id),
            Some(reminders),
          )
          .await?,
      )
    };
    let plan = ScheduledPlan {
      id: adoption.series.id,
      workspace_id: workspace,
      actor_id: Some(adoption.actor_id),
      zone: adoption.zone,
      target: ScheduleTarget::RecurringTask {
        series_id: adoption.series.id,
      },
      rule: Some(adoption.rule),
      lifecycle: ScheduleLifecycle::Active,
      generation: 1,
      revision: 1,
      next: adoption.next,
      next_cause_member_id: None,
      next_admission_at: adoption.next.and_then(|_| adoption.first.map(|first| first.due_at)),
      blocked_reason: None,
    };
    PgSchedulingRepository::create_in(&mut tx, &plan).await?;
    sqlx::query("INSERT INTO task_recurrence_series(id,workspace_id,recipe_json,created_at,current_member_id) VALUES($1,$2,$3,$4,$5)")
      .bind(adoption.series.id)
      .bind(workspace)
      .bind(serde_json::to_value(&adoption.series.recipe).map_err(storage)?)
      .bind(adoption.series.created_at)
      .bind(adoption.series.current_member_id)
      .execute(&mut *tx)
      .await
      .map_err(storage)?;
    let occurrence = if let Some(first) = adoption.first {
      let occurrence = occurrence_id(plan.id, first.nominal);
      sqlx::query("INSERT INTO scheduling_occurrences(id,schedule_id,nominal_json,nominal_due_at,generation,dispatch_id) VALUES($1,$2,$3,$4,1,$5)")
      .bind(occurrence).bind(plan.id).bind(serde_json::to_value(first.nominal).map_err(storage)?)
      .bind(first.due_at).bind(Uuid::new_v5(&occurrence,b"adoption")).execute(&mut *tx).await.map_err(storage)?;
      Some(occurrence)
    } else {
      None
    };
    let member = occurrence.or(adoption.series.current_member_id).ok_or_else(invalid)?;
    sqlx::query("INSERT INTO task_recurrence_members(id,occurrence_id,series_id,row_id,database_id,adopted) VALUES($1,$2,$3,$4,$5,true)")
      .bind(member).bind(occurrence).bind(plan.id).bind(adoption.row_id).bind(adoption.database_id).execute(&mut *tx).await.map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(changed)
  }

  async fn advancement_source(
    &self,
    workspace: WorkspaceId,
    series: Uuid,
    member: Uuid,
  ) -> RepoResult<Option<DatabaseRowId>> {
    sqlx::query_scalar("SELECT m.row_id FROM task_recurrence_members m JOIN task_recurrence_series s ON s.id=m.series_id WHERE s.workspace_id=$1 AND s.id=$2 AND m.id=$3 AND m.advanced_at IS NOT NULL AND m.successor_occurrence_id IS NOT NULL")
      .bind(workspace).bind(series).bind(member).fetch_optional(&self.pool).await.map_err(storage)
  }
}

/// Called by the existing native ACK after canonical Row creation, inside that
/// same transaction. Neither a later callback nor a missing Row can repair it.
pub(crate) async fn record_member_in(
  tx: &mut PgConnection,
  task: &AcceptedRecurringTask,
  result: &serde_json::Value,
) -> RepoResult<()> {
  if result
    .get("row_id")
    .and_then(serde_json::Value::as_str)
    .and_then(|value| Uuid::parse_str(value).ok())
    != Some(task.row_id)
  {
    return Err(invalid());
  }
  let table = crate::workspace_database::DATABASE_ROWS_TABLE;
  let current: bool = sqlx::query_scalar(&format!(
    "SELECT EXISTS(SELECT 1 FROM {table} WHERE id=$1 AND database_id=$2 AND row_kind='task' AND deleted_at IS NULL)"
  ))
  .bind(task.row_id)
  .bind(task.database_id)
  .fetch_one(&mut *tx)
  .await
  .map_err(storage)?;
  if !current {
    return Err(invalid());
  }
  sqlx::query("INSERT INTO task_recurrence_members(id,occurrence_id,series_id,row_id,database_id) VALUES($1,$1,$2,$3,$4) ON CONFLICT(occurrence_id) DO NOTHING")
    .bind(task.occurrence_id).bind(task.series_id).bind(task.row_id).bind(task.database_id).execute(&mut *tx).await.map_err(storage)?;
  let member: (Uuid, Uuid, Uuid) =
    sqlx::query_as("SELECT series_id,row_id,database_id FROM task_recurrence_members WHERE occurrence_id=$1")
      .bind(task.occurrence_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(storage)?;
  if member != (task.series_id, task.row_id, task.database_id) {
    return Err(invalid());
  }
  if let Some(cause) = task.cause_member_id {
    let changed = sqlx::query("UPDATE task_recurrence_series SET current_member_id=$3 WHERE id=$1 AND current_member_id=$2 AND EXISTS(SELECT 1 FROM task_recurrence_members WHERE id=$2 AND series_id=$1 AND successor_occurrence_id=$3)")
      .bind(task.series_id).bind(cause).bind(task.occurrence_id).execute(&mut *tx).await.map_err(storage)?;
    if changed.rows_affected() != 1 {
      return Err(invalid());
    }
  }
  Ok(())
}
