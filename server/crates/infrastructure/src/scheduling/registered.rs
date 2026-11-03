// SPDX-License-Identifier: AGPL-3.0-or-later
//! Registered system work shares SQL admission and the existing outbox. Native
//! queues still own delayed promotion, leases, execution and retry/backoff.
use super::*;
use myoxus_application::scheduling::registered::next_after;
use myoxus_domain::scheduling::registered::{RegisteredDispatch, RegisteredJob, RegisteredWorker, WorkerSchedule};

pub(super) async fn register(pool: &PgPool, workers: Vec<RegisteredWorker>, now: DateTime<Utc>) -> RepoResult<usize> {
  let unique: std::collections::BTreeSet<_> = workers.iter().map(|worker| worker.job).collect();
  if workers.len() != RegisteredJob::ALL.len() || unique.len() != RegisteredJob::ALL.len() {
    return Err(blocked("registeredWorkerInventoryIncomplete"));
  }
  for worker in workers {
    let future = next_after(&worker.schedule.timing, now).map_err(calculation_error)?;
    let definition = serde_json::json!({"kind":"registered_worker","definition":worker.schedule});
    let target = serde_json::to_value(ScheduleTarget::RegisteredJob { job: worker.job }).map_err(storage)?;
    let mut tx = pool.begin().await.map_err(storage)?;
    let row=sqlx::query("SELECT target_json,rule_json,next_due_at,next_admission_at,lifecycle FROM scheduling_schedules WHERE id=$1 FOR UPDATE")
      .bind(worker.job.schedule_id()).fetch_one(&mut *tx).await.map_err(storage)?;
    if row.get::<serde_json::Value, _>("target_json") != target {
      return Err(blocked("registeredScheduleOwnerMismatch"));
    }
    let old = row.get::<Option<serde_json::Value>, _>("rule_json");
    let changed = old.as_ref() != Some(&definition);
    let due = row.get::<Option<DateTime<Utc>>, _>("next_due_at");
    let accepted: bool = if old.is_none() {
      due.is_some()
    } else if let Some(due) = due {
      sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM scheduling_occurrences WHERE schedule_id=$1 AND nominal_due_at=$2)",
      )
      .bind(worker.job.schedule_id())
      .bind(due)
      .fetch_one(&mut *tx)
      .await
      .map_err(storage)?
    } else {
      false
    };
    let preserve = due.is_some_and(|due| due > now) && (accepted || !changed);
    let next = if preserve {
      due
    } else if worker.schedule.enabled {
      Some(future)
    } else {
      None
    };
    // Existing future queue work (including tracking-only legacy admission)
    // suppresses a second startup slot, even if the startup configuration changed.
    let admission = if worker.schedule.enabled {
      if preserve && accepted {
        next
      } else if preserve && !changed {
        row.get::<Option<DateTime<Utc>>, _>("next_admission_at").or(Some(now))
      } else {
        Some(now)
      }
    } else {
      next
    };
    let nominal = next
      .map(|at| serde_json::to_value(ScheduleValue::LocalDateTime(at.naive_utc())))
      .transpose()
      .map_err(storage)?;
    let lifecycle = if worker.schedule.enabled { "active" } else { "ended" };
    sqlx::query("UPDATE scheduling_schedules SET rule_json=$2,lifecycle=$3,generation=generation+CASE WHEN $4 THEN 1 ELSE 0 END,revision=revision+1,next_nominal=$5,next_due_at=$6,next_admission_at=$7,blocked_reason=NULL,updated_at=clock_timestamp() WHERE id=$1")
      .bind(worker.job.schedule_id()).bind(definition).bind(lifecycle).bind(changed).bind(nominal).bind(next).bind(admission).execute(&mut *tx).await.map_err(storage)?;
    tx.commit().await.map_err(storage)?;
  }
  Ok(unique.len())
}

/// Admit one future native queue slot, not every missed unqueued slot. Like
/// the former scheduler, a past cursor computes the next Cron/interval from now.
#[tracing::instrument(skip_all,fields(schedule_id=%id))]
pub async fn admit(
  pool: &PgPool,
  id: Uuid,
  generation: i64,
  revision: i64,
  now: DateTime<Utc>,
) -> RepoResult<Option<usize>> {
  let mut tx = pool.begin().await.map_err(storage)?;
  let row=sqlx::query("SELECT target_json,rule_json,next_due_at FROM scheduling_schedules WHERE id=$1 AND target_json->>'kind'='registered_job' AND generation=$2 AND revision=$3 AND lifecycle='active' AND next_admission_at<=$4 FOR UPDATE SKIP LOCKED")
    .bind(id).bind(generation).bind(revision).bind(now).fetch_optional(&mut *tx).await.map_err(storage)?;
  let Some(row) = row else { return Ok(None) };
  let target: ScheduleTarget = serde_json::from_value(row.get("target_json")).map_err(storage)?;
  let ScheduleTarget::RegisteredJob { job } = target else {
    return Err(blocked("registeredWorkerTargetInvalid"));
  };
  if job.schedule_id() != id {
    return Err(blocked("registeredWorkerIdentityMismatch"));
  }
  let rule: serde_json::Value = row.get("rule_json");
  let definition: WorkerSchedule = serde_json::from_value(
    rule
      .get("definition")
      .cloned()
      .ok_or_else(|| blocked("registeredWorkerDefinitionMissing"))?,
  )
  .map_err(storage)?;
  if !definition.enabled {
    return Err(blocked("registeredWorkerDisabled"));
  }
  let old_due: Option<DateTime<Utc>> = row.get("next_due_at");
  let due = match old_due {
    Some(at) if at > now => at,
    _ => next_after(&definition.timing, now).map_err(calculation_error)?,
  };
  let already: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM scheduling_occurrences WHERE schedule_id=$1 AND nominal_due_at=$2)",
  )
  .bind(id)
  .bind(due)
  .fetch_one(&mut *tx)
  .await
  .map_err(storage)?;
  let nominal = ScheduleValue::LocalDateTime(due.naive_utc());
  if !already {
    let slot = occurrence_id(id, nominal);
    let envelope = RegisteredDispatch {
      schedule_id: id,
      generation,
      dispatch_id: slot,
      scheduled_for: due,
      job,
      data: definition.data,
    };
    sqlx::query("INSERT INTO scheduling_occurrences(id,schedule_id,nominal_json,nominal_due_at,generation,dispatch_id,native_job_id) VALUES($1,$2,$3,$4,$5,$1,$6)")
      .bind(slot).bind(id).bind(serde_json::to_value(nominal).map_err(storage)?).bind(due).bind(generation).bind(envelope.job_id()).execute(&mut *tx).await.map_err(storage)?;
    sqlx::query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'registered_job',$2,'registered_job_due',$3)")
      .bind(Uuid::new_v5(&slot,b"scheduling:registered-worker")).bind(id.to_string()).bind(serde_json::to_value(envelope).map_err(storage)?).execute(&mut *tx).await.map_err(storage)?;
  }
  sqlx::query("UPDATE scheduling_schedules SET next_nominal=$2,next_due_at=$3,next_admission_at=$3,revision=revision+1,blocked_reason=NULL,updated_at=clock_timestamp() WHERE id=$1")
    .bind(id).bind(serde_json::to_value(nominal).map_err(storage)?).bind(due).execute(&mut *tx).await.map_err(storage)?;
  tx.commit().await.map_err(storage)?;
  Ok(Some(usize::from(!already)))
}

pub async fn delivery_is_current(pool: &PgPool, envelope: &RegisteredDispatch) -> RepoResult<bool> {
  if envelope.schedule_id != envelope.job.schedule_id() {
    return Err(blocked("registeredWorkerIdentityMismatch"));
  }
  sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduling_occurrences WHERE id=$1 AND schedule_id=$2 AND generation=$3 AND dispatch_id=$1 AND native_job_id=$4 AND nominal_due_at=$5)")
    .bind(envelope.dispatch_id).bind(envelope.schedule_id).bind(envelope.generation).bind(envelope.job_id()).bind(envelope.scheduled_for).fetch_one(pool).await.map_err(storage)
}
