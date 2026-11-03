// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native profile writes keep their existing transaction/lock order. This owner
//! stores only shared cursor state; native Git still owns the editable rule.
use super::*;
use myoxus_domain::git_sync::{GitSyncProfile, TriggerMode};

/// The caller locks the profile before reading `previous` and before changing
/// native fields. Unchanged rule writes retain the locked shared cursor, never
/// a stale caller snapshot that predates an admitted Cron slot.
pub(crate) async fn replace_in(
  conn: &mut PgConnection,
  previous: Option<&GitSyncProfile>,
  updated: &GitSyncProfile,
) -> RepoResult<()> {
  let row=sqlx::query("SELECT target_json,next_due_at,pending_due_at,lifecycle,workspace_id,actor_id FROM scheduling_schedules WHERE id=$1 FOR UPDATE")
    .bind(updated.id).fetch_optional(&mut *conn).await.map_err(storage)?;
  if let Some(row) = &row {
    let target: ScheduleTarget = serde_json::from_value(row.get("target_json")).map_err(storage)?;
    if !matches!(target,ScheduleTarget::GitCron{profile_id} if profile_id==updated.id) {
      return Err(blocked("gitCronScheduleOwnerMismatch"));
    }
  } else if previous.is_some_and(|old| old.trigger_mode == TriggerMode::Cron) {
    return Err(blocked("gitCronScheduleMissing"));
  }

  if updated.trigger_mode != TriggerMode::Cron {
    if row.as_ref().is_some_and(|row| {
      row.get::<String, _>("lifecycle") != "ended"
        || row.get::<Option<DateTime<Utc>>, _>("next_due_at").is_some()
        || row.get::<Option<DateTime<Utc>>, _>("pending_due_at").is_some()
    }) {
      sqlx::query("UPDATE scheduling_schedules SET lifecycle='ended',generation=generation+1,revision=revision+1,next_nominal=NULL,next_due_at=NULL,next_admission_at=NULL,pending_due_at=NULL,blocked_reason=NULL,updated_at=clock_timestamp() WHERE id=$1")
        .bind(updated.id).execute(conn).await.map_err(storage)?;
    }
    return Ok(());
  }
  let zone = updated
    .cron_timezone
    .as_deref()
    .ok_or_else(|| blocked("gitCronZoneMissing"))?;
  let expression = updated
    .cron_expression
    .as_deref()
    .ok_or_else(|| blocked("gitCronExpressionMissing"))?;
  validate_definition(expression, zone, updated.cron_misfire_policy.is_some())?;
  let changed = previous.is_none_or(|old| {
    old.trigger_mode != updated.trigger_mode
      || old.enabled != updated.enabled
      || old.cron_expression != updated.cron_expression
      || old.cron_timezone != updated.cron_timezone
      || old.cron_misfire_policy != updated.cron_misfire_policy
  });
  let context_changed = row.as_ref().is_some_and(|row| {
    row.get::<Uuid, _>("workspace_id") != updated.workspace_id
      || row.get::<Option<Uuid>, _>("actor_id") != Some(updated.owner_id)
  });
  if !changed && !context_changed && row.is_some() {
    return Ok(());
  }
  let (next, pending) = if changed {
    (
      updated.cron_next_scheduled_at,
      updated.cron_pending_misfire_scheduled_for,
    )
  } else if let Some(row) = &row {
    (row.get("next_due_at"), row.get("pending_due_at"))
  } else {
    (
      updated.cron_next_scheduled_at,
      updated.cron_pending_misfire_scheduled_for,
    )
  };
  if updated.enabled && next.is_none() {
    return Err(blocked("gitCronCursorMissing"));
  }
  let nominal = next
    .map(|next| serde_json::to_value(ScheduleValue::LocalDateTime(next.naive_utc())))
    .transpose()
    .map_err(storage)?;
  let target = serde_json::to_value(ScheduleTarget::GitCron { profile_id: updated.id }).map_err(storage)?;
  let admission = next.map(|next| pending.map_or(next, |pending| pending.min(next)));
  sqlx::query("INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,lifecycle,next_nominal,next_due_at,next_admission_at,pending_due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,actor_id=EXCLUDED.actor_id,admission_zone=EXCLUDED.admission_zone,lifecycle=EXCLUDED.lifecycle,generation=scheduling_schedules.generation+1,revision=scheduling_schedules.revision+1,next_nominal=EXCLUDED.next_nominal,next_due_at=EXCLUDED.next_due_at,next_admission_at=EXCLUDED.next_admission_at,pending_due_at=EXCLUDED.pending_due_at,blocked_reason=NULL,updated_at=clock_timestamp()")
    .bind(updated.id).bind(updated.workspace_id).bind(updated.owner_id).bind(zone).bind(target).bind(if updated.enabled{"active"}else{"ended"}).bind(nominal).bind(next).bind(admission).bind(pending).execute(conn).await.map_err(storage)?;
  Ok(())
}

fn validate_definition(expression: &str, zone: &str, has_policy: bool) -> RepoResult<()> {
  if !has_policy {
    return Err(blocked("gitCronPolicyMissing"));
  }
  myoxus_application::scheduling::cron::CronSchedule::parse(expression, zone)
    .map_err(|_| blocked("gitCronDefinitionInvalid"))?;
  Ok(())
}

/// Keep timing identity and the existing-outbox intent in the native Run's
/// admission transaction. `run_id` on scheduling_occurrences is a workflow FK;
/// a Git Run instead owns its closed dispatch identity, never that FK.
pub(crate) async fn record_run_in(
  conn: &mut PgConnection,
  schedule: Uuid,
  generation: i64,
  due: DateTime<Utc>,
  run: &myoxus_domain::git_sync::GitSyncRun,
) -> RepoResult<()> {
  use myoxus_domain::git_sync::GitSyncRunSource;
  if !matches!(run.trigger_source, GitSyncRunSource::Cron | GitSyncRunSource::Polling)
    || (run.trigger_source == GitSyncRunSource::Cron && run.scheduled_for != Some(due))
    || (run.trigger_source == GitSyncRunSource::Polling && run.scheduled_for.is_some())
  {
    return Err(blocked("gitScheduledRunSourceMismatch"));
  }
  let nominal = ScheduleValue::LocalDateTime(due.naive_utc());
  let slot = occurrence_id(schedule, nominal);
  let inserted=sqlx::query("INSERT INTO scheduling_occurrences(id,schedule_id,nominal_json,nominal_due_at,generation,dispatch_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING")
    .bind(slot).bind(schedule).bind(serde_json::to_value(nominal).map_err(storage)?).bind(due).bind(generation).bind(run.id).execute(&mut *conn).await.map_err(storage)?;
  if inserted.rows_affected() != 1 {
    return Err(blocked("gitCronSlotAlreadyAdmitted"));
  }
  let event = Uuid::new_v5(&run.id, b"scheduling:git-cron");
  let payload = serde_json::to_value(myoxus_domain::scheduling::GitScheduleDispatch {
    schedule_id: schedule,
    generation,
    run_id: run.id,
  })
  .map_err(storage)?;
  let (aggregate, event_type) = if run.trigger_source == GitSyncRunSource::Cron {
    ("git_cron", "git_cron_due")
  } else {
    ("git_polling", "git_polling_due")
  };
  sqlx::query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())")
    .bind(event).bind(aggregate).bind(run.profile_id.to_string()).bind(event_type).bind(payload).execute(conn).await.map_err(storage)?;
  Ok(())
}

impl PgSchedulingRepository {
  #[tracing::instrument(skip_all,fields(profile_id=%id))]
  pub(super) async fn admit_git_cron(
    &self,
    id: Uuid,
    generation: i64,
    revision: i64,
    now: DateTime<Utc>,
  ) -> RepoResult<Option<usize>> {
    let source = self
      .git_policy
      .as_ref()
      .ok_or_else(|| blocked("gitCronPolicyUnavailable"))?;
    let policy = source.policy().await.map_err(|_| blocked("gitCronPolicyUnavailable"))?;
    // A disabled global capability retains native cursors. Use the common
    // bounded backoff so older disabled Git plans cannot starve unrelated work.
    if !policy.enabled || !policy.auto_sync_allowed {
      return Err(blocked("gitCronDisabled"));
    }
    let admitted = crate::git_sync::SqlxGitSyncStore::new(self.pool.clone())
      .admit_cron_slot(id, generation, revision, now, &policy)
      .await
      .map_err(|_| blocked("gitCronAdmissionUnavailable"))?;
    Ok(admitted.map(|admission|{
      tracing::info!(profile_id=%id,skipped_occurrences=admission.skipped_occurrences,pending_misfire_scheduled_for=?admission.pending_misfire_scheduled_for,run_admitted=admission.run.is_some(),policy_denied=admission.policy_denial.is_some(),"processed shared Git Cron cursor");
      usize::from(admission.run.is_some())
    }))
  }
}

/// Native acceptance survives subsequent clock advances. Match the frozen slot
/// generation and native dispatch ID; native Run/profile lifecycle decides
/// whether this accepted execution can still start or continue.
pub async fn delivery_is_current(
  pool: &PgPool,
  envelope: &myoxus_domain::scheduling::GitScheduleDispatch,
  source: myoxus_domain::git_sync::GitSyncRunSource,
) -> RepoResult<bool> {
  if !matches!(
    source,
    myoxus_domain::git_sync::GitSyncRunSource::Cron | myoxus_domain::git_sync::GitSyncRunSource::Polling
  ) {
    return Err(blocked("gitScheduledRunSourceMismatch"));
  }
  sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduling_occurrences o JOIN scheduling_schedules s ON s.id=o.schedule_id JOIN git_sync_runs r ON r.id=o.dispatch_id WHERE o.schedule_id=$1 AND o.generation=$2 AND r.id=$3 AND r.trigger_source=$4 AND s.target_json->>'profile_id'=r.profile_id::text AND ((r.trigger_source='Cron' AND r.scheduled_for=o.nominal_due_at) OR (r.trigger_source='Polling' AND r.scheduled_for IS NULL)) AND r.status='Pending')")
    .bind(envelope.schedule_id).bind(envelope.generation).bind(envelope.run_id).bind(source.to_string()).fetch_one(pool).await.map_err(storage)
}
