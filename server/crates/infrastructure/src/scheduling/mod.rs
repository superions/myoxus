// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL owns replica-safe admission; Glirulus/native effects own execution.

use chrono::{DateTime, Duration, Utc};
use myoxus_application::scheduling::admission::{AdmissionReport, RecurringTaskSource, task_slots};
use myoxus_application::workspace_automation::{recurring_task, runtime::WorkspaceAutomationRuntime};
use myoxus_domain::{
  repositories::{RepoResult, RepositoryError},
  scheduling::*,
  workspace_automation::*,
};
use sqlx::{PgConnection, PgPool, Row};
use std::sync::Arc;
use uuid::Uuid;

use crate::workflow_runtime::GlirulusWorkspaceAutomationRuntime;

pub mod calendar;
pub mod database_reminders;
pub mod git_cron;
pub(crate) mod git_polling;
pub mod git_rotation;
pub mod registered;
pub mod registered_import;
pub mod reminders;
mod review;

pub(crate) fn storage(error: impl std::error::Error + 'static) -> RepositoryError {
  // PostgreSQL error detail can contain a complete rejected accepted-input row.
  // Retain structural diagnostics only, never payloads in errors or spans.
  let error = &error as &dyn std::error::Error;
  let metadata = match error.downcast_ref::<sqlx::Error>() {
    Some(sqlx::Error::Database(error)) => format!(
      "sqlstate={} constraint={}",
      error.code().as_deref().unwrap_or("unknown"),
      error.constraint().unwrap_or("none")
    ),
    Some(sqlx::Error::ColumnNotFound(column)) => format!("missingColumn={column}"),
    Some(sqlx::Error::ColumnDecode { index, .. }) => format!("columnDecode={index}"),
    Some(_) => "databaseTransport".to_owned(),
    None => "typedDecode".to_owned(),
  };
  RepositoryError::Storage(format!("scheduling: {metadata}"))
}
fn blocked(reason: &'static str) -> RepositoryError {
  RepositoryError::Validation(reason.into())
}

fn calculation_error(error: CalculationError) -> RepositoryError {
  blocked(match error {
    CalculationError::ScanBudgetExceeded => "recurrenceScanBudgetExceeded",
    CalculationError::ResultBudgetExceeded => "recurrenceResultBudgetExceeded",
    CalculationError::DateOutOfRange => "recurrenceDateOutOfRange",
    _ => "taskCalculationUnavailable",
  })
}

#[derive(Clone)]
pub struct PgSchedulingRepository {
  pool: PgPool,
  runtime: Arc<GlirulusWorkspaceAutomationRuntime>,
  task_source: Option<Arc<dyn RecurringTaskSource>>,
  review_source:
    Option<Arc<dyn myoxus_application::document_metadata::review::admission::ScheduledDocumentReviewSource>>,
  database_reminders: Option<(
    Arc<dyn myoxus_domain::database::DatabaseReminderRepository>,
    myoxus_application::database::DatabaseMutationEffects,
  )>,
  git_policy: Option<Arc<dyn myoxus_application::scheduling::git::ScheduledGitPolicySource>>,
  git_rotation_providers: Option<Vec<myoxus_application::git_sync::GitTokenRotationProviderKind>>,
}

impl PgSchedulingRepository {
  pub fn new(pool: PgPool, runtime: Arc<GlirulusWorkspaceAutomationRuntime>) -> Self {
    Self {
      pool,
      runtime,
      task_source: None,
      review_source: None,
      database_reminders: None,
      git_policy: None,
      git_rotation_providers: None,
    }
  }

  pub fn with_task_source(mut self, source: Arc<dyn RecurringTaskSource>) -> Self {
    self.task_source = Some(source);
    self
  }

  pub fn with_git_policy(
    mut self,
    source: Arc<dyn myoxus_application::scheduling::git::ScheduledGitPolicySource>,
  ) -> Self {
    self.git_policy = Some(source);
    self
  }

  pub fn with_git_rotation_providers(
    mut self,
    providers: Vec<myoxus_application::git_sync::GitTokenRotationProviderKind>,
  ) -> Self {
    self.git_rotation_providers = Some(providers);
    self
  }

  pub fn with_database_reminders(
    mut self,
    repo: Arc<dyn myoxus_domain::database::DatabaseReminderRepository>,
    effects: myoxus_application::database::DatabaseMutationEffects,
  ) -> Self {
    self.database_reminders = Some((repo, effects));
    self
  }

  pub fn with_document_review_source(
    mut self,
    source: Arc<dyn myoxus_application::document_metadata::review::admission::ScheduledDocumentReviewSource>,
  ) -> Self {
    self.review_source = Some(source);
    self
  }

  pub fn map_plan(row: sqlx::postgres::PgRow) -> RepoResult<ScheduledPlan> {
    let nominal: Option<serde_json::Value> = row.try_get("next_nominal").map_err(storage)?;
    let due: Option<DateTime<Utc>> = row.try_get("next_due_at").map_err(storage)?;
    Ok(ScheduledPlan {
      id: row.try_get("id").map_err(storage)?,
      zone: AdmissionZone::try_from(row.try_get::<String, _>("admission_zone").map_err(storage)?).map_err(storage)?,
      workspace_id: row.try_get("workspace_id").map_err(storage)?,
      actor_id: row.try_get("actor_id").map_err(storage)?,
      target: serde_json::from_value(row.try_get("target_json").map_err(storage)?).map_err(storage)?,
      rule: row
        .try_get::<Option<serde_json::Value>, _>("rule_json")
        .map_err(storage)?
        .map(serde_json::from_value)
        .transpose()
        .map_err(storage)?,
      lifecycle: match row.try_get::<String, _>("lifecycle").map_err(storage)?.as_str() {
        "active" => ScheduleLifecycle::Active,
        "paused" => ScheduleLifecycle::Paused,
        "ended" => ScheduleLifecycle::Ended,
        _ => return Err(blocked("invalidScheduleLifecycle")),
      },
      generation: row.try_get("generation").map_err(storage)?,
      revision: row.try_get("revision").map_err(storage)?,
      next: match (nominal, due) {
        (Some(nominal), Some(due_at)) => Some(Occurrence {
          nominal: serde_json::from_value(nominal).map_err(storage)?,
          due_at,
        }),
        (None, None) => None,
        _ => return Err(blocked("invalidScheduleCursor")),
      },
      next_admission_at: row.try_get("next_admission_at").map_err(storage)?,
      next_cause_member_id: row.try_get("next_cause_member_id").map_err(storage)?,
      blocked_reason: row.try_get("blocked_reason").map_err(storage)?,
    })
  }

  pub async fn create_in(tx: &mut PgConnection, plan: &ScheduledPlan) -> RepoResult<()> {
    if plan.generation != 1
      || plan.revision != 1
      || plan.actor_id.is_none()
      || plan.lifecycle != ScheduleLifecycle::Active
      || plan.blocked_reason.is_some()
      || plan.next.is_some() != plan.next_admission_at.is_some()
      || (plan.next_cause_member_id.is_some() && !matches!(plan.rule, Some(ScheduleRule::AfterCompletion { .. })))
      || (plan.next.is_some()
        && matches!(plan.rule, Some(ScheduleRule::AfterCompletion { .. }))
        && plan.next_cause_member_id.is_none())
    {
      return Err(blocked("invalidSchedule"));
    }
    if let Some(rule) = &plan.rule {
      rule.validate(plan.zone).map_err(storage)?;
    }
    sqlx::query("INSERT INTO scheduling_schedules(id,workspace_id,actor_id,target_json,rule_json,generation,revision,next_nominal,next_due_at,next_admission_at,admission_zone,next_cause_member_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)")
      .bind(plan.id).bind(plan.workspace_id).bind(plan.actor_id)
      .bind(serde_json::to_value(&plan.target).map_err(storage)?)
      .bind(plan.rule.as_ref().map(serde_json::to_value).transpose().map_err(storage)?)
      .bind(plan.generation).bind(plan.revision)
      .bind(plan.next.map(|next| serde_json::to_value(next.nominal)).transpose().map_err(storage)?)
      .bind(plan.next.map(|next| next.due_at)).bind(plan.next_admission_at)
      .bind(String::from(plan.zone))
      .bind(plan.next_cause_member_id)
      .execute(tx).await.map_err(storage)?;
    Ok(())
  }

  /// Bounded work plus per-plan timeout/retry. A bad recipe never acknowledges
  /// its pending slot or prevents existing outbox delivery on the next tick.
  #[tracing::instrument(skip_all)]
  pub async fn dispatch_due(&self, now: DateTime<Utc>, limit: i64) -> RepoResult<AdmissionReport> {
    let rows = sqlx::query("SELECT id,generation,revision FROM scheduling_schedules s WHERE target_json->>'kind' IN ('recurring_task','document_review','calendar_reminder','database_reminder','git_cron','git_polling','git_rotation','registered_job') AND (lifecycle='active' OR (lifecycle='paused' AND EXISTS(SELECT 1 FROM task_recurrence_members m WHERE m.id=s.next_cause_member_id AND m.series_id=s.id AND m.advance_kind='skip'))) AND next_admission_at<=$1 ORDER BY next_admission_at,id LIMIT $2")
      .bind(now).bind(limit.clamp(1,50)).fetch_all(&self.pool).await.map_err(storage)?;
    let started = tokio::time::Instant::now();
    let mut report = AdmissionReport::default();
    for row in rows {
      if started.elapsed() >= std::time::Duration::from_millis(500) {
        report.budget_exhausted = true;
        break;
      }
      let id: Uuid = row.try_get("id").map_err(storage)?;
      let generation: i64 = row.try_get("generation").map_err(storage)?;
      let revision: i64 = row.try_get("revision").map_err(storage)?;
      let one = self.attempt(id, generation, revision, now).await?;
      report.admitted += one.admitted;
      report.blocked += one.blocked;
      report.raced += one.raced;
    }
    Ok(report)
  }

  /// A closed native completion wake-up accelerates its own SQL intent only.
  /// Losing this event still leaves the ordinary bounded admission cursor due.
  pub async fn dispatch_completion(
    &self,
    wake: &myoxus_domain::recurrence::TaskRecurrenceWake,
    now: DateTime<Utc>,
  ) -> RepoResult<AdmissionReport> {
    let row = sqlx::query("SELECT revision FROM scheduling_schedules s WHERE id=$1 AND workspace_id=$2 AND generation=$3 AND next_cause_member_id=$4 AND (lifecycle='active' OR (lifecycle='paused' AND EXISTS(SELECT 1 FROM task_recurrence_members m WHERE m.id=s.next_cause_member_id AND m.series_id=s.id AND m.advance_kind='skip'))) AND next_admission_at<=$5 AND rule_json->>'kind'='after_completion'")
      .bind(wake.schedule_id).bind(wake.workspace_id).bind(wake.generation).bind(wake.member_id).bind(now)
      .fetch_optional(&self.pool).await.map_err(storage)?;
    let Some(row) = row else {
      return Ok(AdmissionReport::default());
    };
    self
      .attempt(
        wake.schedule_id,
        wake.generation,
        row.try_get("revision").map_err(storage)?,
        now,
      )
      .await
  }

  async fn attempt(&self, id: Uuid, generation: i64, revision: i64, now: DateTime<Utc>) -> RepoResult<AdmissionReport> {
    let mut report = AdmissionReport::default();
    match tokio::time::timeout(
      std::time::Duration::from_millis(250),
      self.admit(id, generation, revision, now),
    )
    .await
    {
      Ok(Ok(Some(count))) => report.admitted += count,
      Ok(Ok(None)) => report.raced += 1,
      result => {
        if let Ok(Err(RepositoryError::Storage(message))) = &result {
          let metadata = if message.starts_with("scheduling:") {
            message.as_str()
          } else {
            "authorityStorage"
          };
          tracing::warn!(schedule_id=%id, metadata, "scheduled admission storage unavailable");
        }
        let reason = match &result {
          Ok(Err(RepositoryError::Validation(reason))) if reason.len() <= 128 => reason.as_str(),
          Err(_) => "taskAdmissionTimedOut",
          _ => "taskAdmissionUnavailable",
        };
        report.blocked += 1;
        // Compare the original generation/revision: never overwrite a newer
        // native lifecycle/configuration with a stale failure observation.
        sqlx::query("WITH current AS (SELECT id FROM scheduling_schedules s WHERE id=$1 AND generation=$2 AND revision=$3 AND (lifecycle='active' OR (lifecycle='paused' AND EXISTS(SELECT 1 FROM task_recurrence_members m WHERE m.id=s.next_cause_member_id AND m.series_id=s.id AND m.advance_kind='skip'))) AND next_admission_at<=$6 FOR UPDATE SKIP LOCKED) UPDATE scheduling_schedules s SET blocked_reason=$4,next_admission_at=$5,updated_at=now() FROM current WHERE s.id=current.id")
            .bind(id).bind(generation).bind(revision).bind(reason)
            .bind(now + Duration::seconds(30)).bind(now).execute(&self.pool).await.map_err(storage)?;
        tracing::warn!(schedule_id=%id, reason, "scheduled native admission blocked");
      }
    }
    Ok(report)
  }

  async fn admit(&self, id: Uuid, generation: i64, revision: i64, now: DateTime<Utc>) -> RepoResult<Option<usize>> {
    let observed = sqlx::query("SELECT * FROM scheduling_schedules WHERE id=$1")
      .bind(id)
      .fetch_optional(&self.pool)
      .await
      .map_err(storage)?;
    let Some(observed) = observed else { return Ok(None) };
    if observed.get::<serde_json::Value, _>("target_json")["kind"] == "registered_job" {
      return registered::admit(&self.pool, id, generation, revision, now).await;
    }
    // Personal/external Calendar reminders need no synthetic workspace. Their
    // closed adapter runs before the non-null Task/Review model is decoded.
    if observed.get::<serde_json::Value, _>("target_json")["kind"] == "calendar_reminder" {
      return self.admit_calendar_reminder(id, generation, revision, now).await;
    }
    if observed.get::<serde_json::Value, _>("target_json")["kind"] == "database_reminder" {
      return self.admit_database_reminder(id, generation, revision, now).await;
    }
    if observed.get::<serde_json::Value, _>("target_json")["kind"] == "git_cron" {
      return self.admit_git_cron(id, generation, revision, now).await;
    }
    if observed.get::<serde_json::Value, _>("target_json")["kind"] == "git_rotation" {
      return self.admit_git_rotation(id, generation, revision, now).await;
    }
    if observed.get::<serde_json::Value, _>("target_json")["kind"] == "git_polling" {
      let target: ScheduleTarget = serde_json::from_value(observed.get("target_json")).map_err(storage)?;
      let ScheduleTarget::GitPolling { profile_id } = target else {
        return Err(blocked("gitPollingTargetInvalid"));
      };
      return self.admit_git_polling(id, profile_id, generation, revision, now).await;
    }
    let plan = Self::map_plan(observed)?;
    if plan.generation != generation
      || plan.revision != revision
      || plan.lifecycle == ScheduleLifecycle::Ended
      || plan.next_admission_at.is_none_or(|due| due > now)
    {
      return Ok(None);
    }
    if matches!(&plan.target, ScheduleTarget::DocumentReview { .. }) {
      return self.admit_document_review(&plan, now).await;
    }
    let actor = plan.actor_id.ok_or_else(|| blocked("taskActorUnavailable"))?;
    let source = self
      .task_source
      .as_ref()
      .ok_or_else(|| blocked("taskSourceUnavailable"))?;
    let slots = task_slots(&plan, now).map_err(calculation_error)?;
    let mut accepted = Vec::new();
    for slot in &slots {
      let task = source.prepare(&plan, *slot).await.map_err(blocked)?;
      let ScheduleTarget::RecurringTask { series_id } = plan.target else {
        return Err(blocked("taskSeriesUnavailable"));
      };
      let occurrence = task_occurrence_id(plan.id, slot.nominal, plan.next_cause_member_id);
      if task.schedule_id != plan.id
        || task.series_id != series_id
        || task.generation != generation
        || task.zone != plan.zone
        || task.occurrence_id != occurrence
        || task.cause_member_id != plan.next_cause_member_id
        || task.slot != *slot
        || task.row_id != Uuid::new_v5(&occurrence, b"row")
      {
        return Err(blocked("taskPreparedInputMismatch"));
      }
      let definition = recurring_task::definition().map_err(|_| blocked("taskDefinitionUnavailable"))?;
      self
        .runtime
        .register_definition(definition.clone())
        .await
        .map_err(|_| blocked("taskRuntimeUnavailable"))?;
      accepted.push(AcceptedAutomationRun {
        recurring_task: Some(task),
        run_id: task_run_id(occurrence, generation),
        workspace_id: plan.workspace_id,
        actor_id: Some(actor),
        automation_id: None,
        trigger: None,
        workspace_setup: None,
        confirmed_request: None,
        document_review: None,
        task_handover: None,
        task_maintenance: None,
        personal_rule: None,
        definition,
      });
    }
    let next = match (&plan.rule, slots.last()) {
      (Some(ScheduleRule::Fixed { rule }), Some(last)) => {
        myoxus_application::scheduling::next_after(rule, last.due_at, CalculationBudget::default())
          .map_err(calculation_error)?
      }
      _ => None,
    };
    let mut tx = self.pool.begin().await.map_err(storage)?;
    crate::workflow_runtime::effects::lock_runtime_authority(&mut tx, actor, plan.workspace_id, false).await?;
    // Native roots precede schedule locks. NOWAIT preserves the existing
    // canonical writer's competing root/Run lock order without a deadlock wait.
    for run in &accepted {
      let task = recurring_task::validate(run).map_err(|_| blocked("taskPreparedInputMismatch"))?;
      let live: Option<Uuid> = sqlx::query_scalar("SELECT d.id FROM workspace_databases d JOIN database_profiles p ON p.database_id=d.id AND p.profile_kind='project' WHERE d.id=$1 AND d.workspace_id=$2 AND d.deleted_at IS NULL FOR SHARE OF d,p NOWAIT")
        .bind(task.database_id).bind(plan.workspace_id).fetch_optional(&mut *tx).await.map_err(storage)?;
      if live.is_none() {
        return Err(blocked("taskDestinationUnavailable"));
      }
      crate::recurrence::lock_completion_source_in(&mut tx, run)
        .await
        .map_err(|error| match error {
          RepositoryError::Validation(_) => blocked("taskSourceUnavailable"),
          error => error,
        })?;
      assert_task_input_in(&mut tx, run).await?;
    }
    let locked = sqlx::query("SELECT * FROM scheduling_schedules WHERE id=$1 AND generation=$2 AND revision=$3 AND lifecycle=$5 AND next_admission_at<=$4 FOR UPDATE SKIP LOCKED")
      .bind(id).bind(generation).bind(revision).bind(now).bind(match plan.lifecycle {ScheduleLifecycle::Active=>"active",ScheduleLifecycle::Paused=>"paused",ScheduleLifecycle::Ended=>"ended"})
      .fetch_optional(&mut *tx).await.map_err(storage)?;
    if locked.is_none() {
      return Ok(None);
    }
    if plan.lifecycle == ScheduleLifecycle::Paused {
      let skip: Option<Uuid> = sqlx::query_scalar("SELECT id FROM task_recurrence_members WHERE id=$1 AND series_id=$2 AND advance_kind='skip' AND successor_occurrence_id IS NOT NULL FOR SHARE NOWAIT")
        .bind(plan.next_cause_member_id).bind(plan.id).fetch_optional(&mut *tx).await.map_err(storage)?;
      if skip.is_none() {
        return Ok(None);
      }
    }
    let mut count = 0;
    for run in &accepted {
      let task = run.recurring_task.as_ref().expect("closed Task acceptance");
      // Explicit generation changes may replace unstarted work, not an ACK.
      // Its prior frozen Run remains history; a committed/deleted member is
      // protected by its association even when no live Row can be found.
      let inserted = sqlx::query("INSERT INTO scheduling_occurrences(id,schedule_id,nominal_json,nominal_due_at,generation,dispatch_id,cause_member_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET generation=EXCLUDED.generation,dispatch_id=EXCLUDED.dispatch_id,run_id=NULL,nominal_json=EXCLUDED.nominal_json,nominal_due_at=EXCLUDED.nominal_due_at,admitted_at=now() WHERE scheduling_occurrences.schedule_id=EXCLUDED.schedule_id AND scheduling_occurrences.cause_member_id IS NOT DISTINCT FROM EXCLUDED.cause_member_id AND (EXCLUDED.cause_member_id IS NOT NULL OR scheduling_occurrences.nominal_json=EXCLUDED.nominal_json) AND scheduling_occurrences.generation<EXCLUDED.generation AND NOT EXISTS(SELECT 1 FROM task_recurrence_members m WHERE m.occurrence_id=scheduling_occurrences.id)")
        .bind(task.occurrence_id).bind(id).bind(serde_json::to_value(task.slot.nominal).map_err(storage)?)
        .bind(task.slot.due_at).bind(generation).bind(run.run_id).bind(task.cause_member_id).execute(&mut *tx).await.map_err(storage)?;
      if inserted.rows_affected() == 0 {
        continue;
      }
      sqlx::query("INSERT INTO workspace_automation_runs(id,workspace_id,origin_kind,confirmed_actor_id,idempotency_key,status,accepted_json,scheduling_occurrence_id) VALUES($1,$2,'recurring_task',$3,$4,'queued',$5,$6)")
        .bind(run.run_id).bind(run.workspace_id).bind(actor).bind(format!("{}:{generation}",task.occurrence_id))
        .bind(serde_json::to_value(run).map_err(storage)?).bind(task.occurrence_id)
        .execute(&mut *tx).await.map_err(storage)?;
      self
        .runtime
        .create_recurring_task_snapshot_in(&mut tx, run)
        .await
        .map_err(|_| blocked("taskRuntimeUnavailable"))?;
      sqlx::query("UPDATE scheduling_occurrences SET run_id=$2 WHERE id=$1")
        .bind(task.occurrence_id)
        .bind(run.run_id)
        .execute(&mut *tx)
        .await
        .map_err(storage)?;
      count += 1;
    }
    sqlx::query("UPDATE scheduling_schedules SET next_nominal=$2,next_due_at=$3,next_admission_at=$4,next_cause_member_id=NULL,blocked_reason=NULL,updated_at=now() WHERE id=$1")
      .bind(id).bind(next.map(|next| serde_json::to_value(next.nominal)).transpose().map_err(storage)?)
      .bind(next.map(|next| next.due_at)).bind(next.and_then(|_| slots.last().map(|slot| slot.due_at)))
      .execute(&mut *tx).await.map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(Some(count))
  }
}

/// Rechecked by every canonical native effect and its ACK in the caller's Tx.
pub(crate) async fn lock_task_effect(tx: &mut PgConnection, run: &AcceptedAutomationRun) -> RepoResult<()> {
  let task = recurring_task::validate(run).map_err(|_| blocked("invalidRecurringTask"))?;
  let row = sqlx::query("SELECT s.generation,s.lifecycle,s.actor_id,s.workspace_id,s.target_json,o.generation AS occurrence_generation,o.dispatch_id,o.nominal_json,o.nominal_due_at,o.cause_member_id,EXISTS(SELECT 1 FROM task_recurrence_members m WHERE m.id=o.cause_member_id AND m.series_id=s.id AND m.advance_kind='skip' AND m.successor_occurrence_id=o.id) AS explicit_skip FROM scheduling_schedules s JOIN scheduling_occurrences o ON o.schedule_id=s.id WHERE s.id=$1 AND o.id=$2 FOR SHARE OF s,o NOWAIT")
    .bind(task.schedule_id).bind(task.occurrence_id).fetch_optional(&mut *tx).await.map_err(storage)?
    .ok_or_else(|| blocked("taskScheduleUnavailable"))?;
  let acknowledged: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_automation_actions WHERE run_id=$1 AND node_key='action:0' AND effect_key='apply' AND status='succeeded' AND result_json IS NOT NULL)")
    .bind(run.run_id).fetch_one(&mut *tx).await.map_err(storage)?;
  if (!acknowledged
    && (row.try_get::<i64, _>("generation").map_err(storage)? != task.generation
      || row.try_get::<i64, _>("occurrence_generation").map_err(storage)? != task.generation
      || row.try_get::<Option<Uuid>, _>("actor_id").map_err(storage)? != run.actor_id
      || !(row.try_get::<String, _>("lifecycle").map_err(storage)? == "active"
        || (row.try_get::<String, _>("lifecycle").map_err(storage)? == "paused"
          && row.try_get::<bool, _>("explicit_skip").map_err(storage)?))))
    || row.try_get::<Uuid, _>("workspace_id").map_err(storage)? != run.workspace_id
    || row.try_get::<Uuid, _>("dispatch_id").map_err(storage)? != run.run_id
    || row.try_get::<Option<Uuid>, _>("cause_member_id").map_err(storage)? != task.cause_member_id
    || row.try_get::<serde_json::Value, _>("target_json").map_err(storage)?
      != serde_json::to_value(ScheduleTarget::RecurringTask {
        series_id: task.series_id,
      })
      .map_err(storage)?
    || row.try_get::<serde_json::Value, _>("nominal_json").map_err(storage)?
      != serde_json::to_value(task.slot.nominal).map_err(storage)?
    || row.try_get::<DateTime<Utc>, _>("nominal_due_at").map_err(storage)? != task.slot.due_at
  {
    return Err(blocked("taskScheduleGenerationChanged"));
  }
  if !acknowledged {
    crate::recurrence::lock_completion_source_in(tx, run).await?;
    assert_task_input_in(tx, run).await?;
  }
  Ok(())
}

async fn assert_task_input_in(tx: &mut PgConnection, run: &AcceptedAutomationRun) -> RepoResult<()> {
  use myoxus_domain::database::{
    DatabaseCellValueData as Cell, DatabaseFieldConfig, DatabaseStatusFieldConfig, DatabaseStatusGroup,
  };
  let task = recurring_task::validate(run).map_err(|_| blocked("taskInputUnavailable"))?;
  let roles = sqlx::query("SELECT r.field_id,r.role_key,f.config_json,EXISTS(SELECT 1 FROM database_field_roles other WHERE other.database_id=r.database_id AND other.field_id=r.field_id AND other.row_kind_scope='task' AND other.role_key<>r.role_key) AS aliased FROM database_field_roles r JOIN workspace_database_fields f ON f.id=r.field_id AND f.database_id=r.database_id WHERE r.database_id=$1 AND r.row_kind_scope='task' AND r.profile_kind='project' AND r.role_key=ANY($2) FOR SHARE OF r,f NOWAIT")
    .bind(task.database_id).bind(vec!["task.description","task.assignees","task.priority","task.status","task.dueDate"])
    .fetch_all(&mut *tx).await.map_err(storage)?;
  let mut fields = std::collections::BTreeSet::new();
  let mut required = std::collections::BTreeSet::new();
  for cell in &task.cells {
    if !fields.insert(cell.field_id) {
      return Err(blocked("taskInputUnavailable"));
    }
    let role = roles
      .iter()
      .find(|row| row.try_get::<Uuid, _>("field_id").is_ok_and(|id| id == cell.field_id))
      .ok_or_else(|| blocked("taskInputUnavailable"))?;
    if role.try_get::<bool, _>("aliased").map_err(storage)? {
      return Err(blocked("taskInputUnavailable"));
    }
    let key: String = role.try_get("role_key").map_err(storage)?;
    match (key.as_str(), &cell.value) {
      ("task.description", Cell::RichText(_)) => {}
      ("task.priority", Cell::Select(value)) => {
        let config: DatabaseFieldConfig =
          serde_json::from_value(role.try_get("config_json").map_err(storage)?).map_err(storage)?;
        if !matches!(config, DatabaseFieldConfig::Select(config) if config.options.iter().any(|option| option.id==*value))
        {
          return Err(blocked("taskPriorityUnavailable"));
        }
      }
      ("task.assignees", Cell::Users(users)) => {
        let users: std::collections::BTreeSet<_> = users.iter().copied().collect();
        let current: Vec<Uuid> = sqlx::query_scalar("SELECT m.user_id FROM workspace_memberships m WHERE m.user_id=ANY($1) AND m.workspace_id=$2 AND m.status='Accepted' ORDER BY m.user_id FOR SHARE OF m NOWAIT")
          .bind(users.iter().copied().collect::<Vec<_>>()).bind(run.workspace_id)
          .fetch_all(&mut *tx).await.map_err(storage)?;
        if current.len() != users.len() {
          return Err(blocked("taskAssigneeUnavailable"));
        }
      }
      ("task.status", Cell::Status(value)) => {
        let config: DatabaseStatusFieldConfig =
          serde_json::from_value(role.try_get("config_json").map_err(storage)?).map_err(storage)?;
        if !config.options.iter().any(|option| {
          option.id == *value
            && matches!(
              option.group,
              DatabaseStatusGroup::NotStarted | DatabaseStatusGroup::Active
            )
        }) {
          return Err(blocked("taskOpenStatusUnavailable"));
        }
        required.insert("status");
      }
      ("task.dueDate", Cell::DateTime(value)) => {
        if *value != recurring_task::due_value(task.slot, task.zone) {
          return Err(blocked("taskDueMismatch"));
        }
        required.insert("due");
      }
      _ => return Err(blocked("taskInputUnavailable")),
    }
  }
  if required.len() != 2 {
    return Err(blocked("taskInputUnavailable"));
  }
  Ok(())
}
