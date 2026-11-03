// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native Task recurrence orchestration; never an optional automation package.

use crate::{
  database::{DatabaseEditingService, DatabaseResult},
  scheduling::admission::RecurringTaskSource,
};
use async_trait::async_trait;
use myoxus_domain::{ids::*, recurrence::*, scheduling::*, workspace_automation::AcceptedRecurringTask};
use std::sync::Arc;

/// A changed fixed rule starts after both the preserved civil slot and the
/// current instant. Comparing civil values matters when the zone itself changes.
pub fn fixed_change_next(
  rule: &RecurrenceRule,
  now: chrono::DateTime<chrono::Utc>,
  boundary: Option<Occurrence>,
) -> Result<Option<Occurrence>, CalculationError> {
  let reference = boundary.map_or(now, |slot| slot.due_at.max(now));
  let mut next = crate::scheduling::next_after(rule, reference, CalculationBudget::default())?;
  // IANA offsets can cross a civil date. A bounded follow-up handles that
  // without changing the slot's original identity or widening scan budgets.
  for _ in 0..5 {
    match (next, boundary) {
      (Some(slot), Some(boundary)) if slot.nominal.local_datetime() <= boundary.nominal.local_datetime() => {
        next = crate::scheduling::next_after(rule, slot.due_at, CalculationBudget::default())?;
      }
      _ => return Ok(next),
    }
  }
  Err(CalculationError::ScanBudgetExceeded)
}

#[derive(Clone)]
pub struct TaskRecurrenceService {
  repo: Arc<dyn TaskRecurrenceRepository>,
  editing: Arc<DatabaseEditingService>,
}

impl TaskRecurrenceService {
  pub fn new(repo: Arc<dyn TaskRecurrenceRepository>, editing: Arc<DatabaseEditingService>) -> Self {
    Self { repo, editing }
  }

  #[tracing::instrument(skip_all)]
  pub async fn for_row(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    row: DatabaseRowId,
  ) -> DatabaseResult<Option<TaskRecurrenceRead>> {
    self.editing.assert_recurrence_access(actor, workspace, false).await?;
    let mut view = self.repo.read_for_row(workspace, row).await?;
    if let Some(view) = &mut view {
      self.readiness(view).await;
    }
    Ok(view)
  }

  #[allow(clippy::too_many_arguments)]
  #[tracing::instrument(skip_all)]
  pub async fn preview(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    rule: ScheduleRule,
    zone: AdmissionZone,
    after: Option<chrono::DateTime<chrono::Utc>>,
    reference: Option<ScheduleValue>,
    count: u8,
    change: Option<(uuid::Uuid, i64)>,
  ) -> DatabaseResult<Vec<RecurrencePreviewItem>> {
    self.editing.assert_recurrence_access(actor, workspace, false).await?;
    let invalid =
      || crate::database::DatabaseServiceError::new(crate::database::ERR_ROW_INVALID, "invalid recurrence preview");
    if !(1..=5).contains(&count) {
      return Err(invalid());
    }
    rule.validate(zone).map_err(|_| invalid())?;
    let changing = if let Some((id, revision)) = change {
      if after.is_some() {
        return Err(invalid());
      }
      let view = self.repo.read(workspace, id).await?.ok_or_else(invalid)?;
      if view.schedule.revision != revision {
        return Err(crate::database::DatabaseServiceError::new(
          crate::database::ERR_DATABASE_CONFLICT,
          "task recurrence series revision",
        ));
      }
      if view.schedule.lifecycle == ScheduleLifecycle::Ended {
        return Ok(vec![]);
      }
      Some(view)
    } else {
      None
    };
    match rule {
      ScheduleRule::Fixed { rule } => {
        if reference.is_some() {
          return Err(invalid());
        }
        // Series changes preserve the already materialized next member, even
        // across zone edits. Use the same civil/instant boundary as SQL control.
        let occurrences = if let Some(view) = changing {
          let first = fixed_change_next(
            &rule,
            chrono::Utc::now(),
            view.preserved_next.and_then(|member| member.slot),
          )
          .map_err(|_| invalid())?;
          if let Some(first) = first {
            let mut result = vec![first];
            if count > 1 {
              result.extend(
                crate::scheduling::preview(&rule, Some(first.due_at), count - 1, CalculationBudget::default())
                  .map_err(|_| invalid())?,
              );
            }
            result
          } else {
            vec![]
          }
        } else {
          crate::scheduling::preview(&rule, after, count, CalculationBudget::default()).map_err(|error| {
            crate::database::DatabaseServiceError::new(crate::database::ERR_ROW_INVALID, error.to_string())
          })?
        };
        Ok(
          occurrences
            .into_iter()
            .map(|occurrence| RecurrencePreviewItem {
              occurrence,
              completion_reference: None,
            })
            .collect(),
        )
      }
      ScheduleRule::AfterCompletion { interval, .. } => {
        if after.is_some() {
          return Err(invalid());
        }
        let mut reference = reference.ok_or_else(invalid)?;
        if let Some(view) = changing {
          let date_only = match view.schedule.rule {
            Some(ScheduleRule::AfterCompletion { date_only, .. }) => date_only,
            Some(ScheduleRule::Fixed { rule }) => matches!(rule.start, ScheduleValue::Date(_)),
            None => return Err(invalid()),
          };
          if date_only != matches!(reference, ScheduleValue::Date(_)) {
            return Err(invalid());
          }
        }
        let mut preview = Vec::with_capacity(usize::from(count));
        for _ in 0..count {
          let occurrence = crate::scheduling::relative_after(reference, interval, zone).map_err(|error| {
            crate::database::DatabaseServiceError::new(crate::database::ERR_ROW_INVALID, error.to_string())
          })?;
          preview.push(RecurrencePreviewItem {
            occurrence,
            completion_reference: Some(reference),
          });
          reference = occurrence.nominal;
        }
        Ok(preview)
      }
    }
  }

  /// Scope is checked before loading recipes, including closed/deleted members.
  #[tracing::instrument(skip_all)]
  pub async fn read(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    id: uuid::Uuid,
  ) -> DatabaseResult<Option<TaskRecurrenceRead>> {
    self.editing.assert_recurrence_access(actor, workspace, false).await?;
    let mut view = self.repo.read(workspace, id).await?;
    if let Some(view) = &mut view {
      self.readiness(view).await;
    }
    Ok(view)
  }

  pub async fn list(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    after: Option<uuid::Uuid>,
    first: u32,
  ) -> DatabaseResult<Vec<TaskRecurrenceRead>> {
    self.editing.assert_recurrence_access(actor, workspace, false).await?;
    let mut views = self.repo.list(workspace, after, first).await?;
    for view in &mut views {
      self.readiness(view).await;
    }
    Ok(views)
  }

  async fn readiness(&self, view: &mut TaskRecurrenceRead) {
    if view.schedule.lifecycle == ScheduleLifecycle::Ended {
      return;
    }
    if let Some(member) = view.series.current_member_id {
      let source = match self.repo.member(view.series.workspace_id, view.series.id, member).await {
        Ok(Some(member)) => Some(member.row_id),
        _ => None,
      };
      let available = if let (Some(actor), Some(row)) = (view.schedule.actor_id, source) {
        self.editing.assert_recurrence_source_read(actor, row).await.is_ok()
      } else {
        false
      };
      if !available {
        view.schedule.blocked_reason = Some("taskSourceUnavailable".into());
        return;
      }
    }
    // Readback checks the confirming actor, never the reader as a substitute.
    let now = chrono::Utc::now();
    let slot = view
      .schedule
      .next
      .or_else(|| view.preserved_next.as_ref().and_then(|member| member.slot))
      .unwrap_or(Occurrence {
        nominal: ScheduleValue::LocalDateTime(now.with_timezone(&view.schedule.zone.timezone()).naive_local()),
        due_at: now,
      });
    if let Err(error) = self
      .editing
      .prepare_recurring_task(&view.schedule, &view.series.recipe, slot)
      .await
    {
      view.schedule.blocked_reason = Some(
        match error.code {
          crate::database::ERR_FORBIDDEN => "taskPermissionUnavailable",
          crate::database::ERR_NOT_FOUND => "taskDestinationUnavailable",
          crate::database::ERR_STORAGE => "taskSourceUnavailable",
          _ => "taskRecipeUnavailable",
        }
        .into(),
      );
    }
  }

  /// Every control uses the caller's current ordinary Task-editing rights; a
  /// different confirming actor does not imply a Manager-only permission tier.
  #[tracing::instrument(skip_all)]
  pub async fn control(&self, mut command: TaskRecurrenceControl) -> DatabaseResult<TaskRecurrenceRead> {
    self
      .editing
      .assert_recurrence_access(command.actor_id, command.workspace_id, true)
      .await?;
    let mut view = self
      .repo
      .read(command.workspace_id, command.series_id)
      .await?
      .ok_or_else(|| {
        crate::database::DatabaseServiceError::new(crate::database::ERR_NOT_FOUND, "Task recurrence unavailable")
      })?;
    let action = match &mut command.change {
      TaskRecurrenceChange::Pause => "task.recurrence.pause",
      TaskRecurrenceChange::Resume => "task.recurrence.resume",
      TaskRecurrenceChange::End => "task.recurrence.end",
      TaskRecurrenceChange::Update { rule, zone, recipe } => {
        if let ScheduleRule::AfterCompletion { date_only, .. } = rule {
          *date_only = match &view.schedule.rule {
            Some(ScheduleRule::AfterCompletion { date_only, .. }) => *date_only,
            Some(ScheduleRule::Fixed { rule }) => matches!(rule.start, ScheduleValue::Date(_)),
            None => false,
          };
        }
        rule.validate(*zone).map_err(|_| {
          crate::database::DatabaseServiceError::new(crate::database::ERR_ROW_INVALID, "invalid Task recurrence rule")
        })?;
        // A series edit is a new explicit confirmation. Pause/Resume alone
        // never silently replaces the original confirming actor.
        view.schedule.rule = Some(rule.clone());
        view.schedule.zone = *zone;
        view.schedule.actor_id = Some(command.actor_id);
        recipe.title = crate::database::definition::rules::validate_title(&recipe.title)?;
        let now = chrono::Utc::now();
        self
          .editing
          .prepare_recurring_task(
            &view.schedule,
            recipe,
            Occurrence {
              nominal: ScheduleValue::LocalDateTime(now.with_timezone(&zone.timezone()).naive_local()),
              due_at: now,
            },
          )
          .await?;
        "task.recurrence.update"
      }
    };
    let (actor, workspace, id) = (command.actor_id, command.workspace_id, command.series_id);
    self.repo.control(command).await?;
    self.editing.audit_recurrence_control(actor, id, action).await;
    self.read(actor, workspace, id).await?.ok_or_else(|| {
      crate::database::DatabaseServiceError::new(crate::database::ERR_NOT_FOUND, "Task recurrence unavailable")
    })
  }

  #[tracing::instrument(skip_all)]
  pub async fn skip(&self, command: TaskRecurrenceSkip) -> DatabaseResult<TaskRecurrenceRead> {
    let (actor, workspace, id) = (command.actor_id, command.workspace_id, command.series_id);
    let member_id = command.member_id;
    if self.editing.skip_recurrence(&*self.repo, command).await? {
      self
        .editing
        .audit_recurrence_control(actor, id, "task.recurrence.skip")
        .await;
    }
    let mut view = self.read(actor, workspace, id).await?.ok_or_else(|| {
      crate::database::DatabaseServiceError::new(crate::database::ERR_NOT_FOUND, "Task recurrence unavailable")
    })?;
    // The command addresses an explicit retained member, which can predate the
    // bounded recent history. Its immutable winning receipt stays in readback.
    if !view.members.iter().any(|member| member.id == member_id)
      && let Some(member) = self.repo.member(workspace, id, member_id).await?
    {
      view.members.push(member);
    }
    Ok(view)
  }

  /// Adopt in the explicitly confirmed workspace with native Row/Due revisions.
  /// Fixed start becomes the first Due; relative mode pins kind from native Due
  /// without rewriting it. Activation always returns that same original Task.
  #[tracing::instrument(skip_all)]
  pub async fn configure(&self, command: ConfigureTaskRecurrence) -> DatabaseResult<TaskRecurrenceActivation> {
    self
      .editing
      .assert_recurrence_access(command.actor_id, command.workspace_id, true)
      .await?;
    self
      .editing
      .adopt_recurrence(
        &*self.repo,
        command.actor_id,
        command.workspace_id,
        command.database_id,
        command.row_id,
        command.expected_row_revision,
        command.expected_due_revision,
        command.rule,
        command.zone,
        command.recipe,
      )
      .await
  }
}

#[async_trait]
impl RecurringTaskSource for TaskRecurrenceService {
  async fn prepare(&self, plan: &ScheduledPlan, slot: Occurrence) -> Result<AcceptedRecurringTask, &'static str> {
    let ScheduleTarget::RecurringTask { series_id } = plan.target else {
      return Err("taskSeriesUnavailable");
    };
    if series_id != plan.id {
      return Err("taskSeriesUnavailable");
    }
    let series = self
      .repo
      .series(plan.workspace_id, series_id)
      .await
      .map_err(|_| "taskSeriesUnavailable")?
      .ok_or("taskSeriesUnavailable")?;
    if let Some(member) = plan.next_cause_member_id {
      let row = self
        .repo
        .advancement_source(plan.workspace_id, series_id, member)
        .await
        .map_err(|_| "taskSourceUnavailable")?
        .ok_or("taskSourceUnavailable")?;
      self
        .editing
        .assert_recurrence_source_read(plan.actor_id.ok_or("taskActorUnavailable")?, row)
        .await
        .map_err(|_| "taskSourceUnavailable")?;
    }
    self
      .editing
      .prepare_recurring_task(plan, &series.recipe, slot)
      .await
      .map_err(|error| match error.code {
        crate::database::ERR_FORBIDDEN => "taskPermissionUnavailable",
        crate::database::ERR_NOT_FOUND => "taskDestinationUnavailable",
        crate::database::ERR_STORAGE => "taskSourceUnavailable",
        _ => "taskRecipeUnavailable",
      })
  }
}
