// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native transition receipts precede the existing outbox wake-up and runtime.

use super::*;
use myoxus_domain::workspace_automation::AcceptedAutomationRun;

/// The caller already owns the canonical Task Row lock. Competing Run/definition
/// orders fail closed with NOWAIT rather than waiting behind an effect claim.
pub(crate) async fn advance_completed_member_in(
  tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
  row_id: DatabaseRowId,
) -> RepoResult<()> {
  let rows = crate::workspace_database::DATABASE_ROWS_TABLE;
  let candidates: Vec<(Uuid,Uuid)> = sqlx::query_as(&format!("SELECT m.id,m.series_id FROM task_recurrence_members m JOIN task_recurrence_series s ON s.id=m.series_id JOIN {rows} r ON r.id=m.row_id WHERE m.row_id=$1 AND r.row_kind='task' AND r.deleted_at IS NULL AND s.current_member_id=m.id AND m.advanced_at IS NULL ORDER BY m.series_id"))
    .bind(row_id).fetch_all(&mut **tx).await.map_err(storage)?;
  for (member, series) in candidates {
    let plan = sqlx::query("SELECT * FROM scheduling_schedules WHERE id=$1 FOR UPDATE NOWAIT")
      .bind(series)
      .fetch_one(&mut **tx)
      .await
      .map_err(storage)?;
    let plan = PgSchedulingRepository::map_plan(plan)?;
    if !matches!(&plan.rule, Some(ScheduleRule::AfterCompletion { .. })) {
      continue;
    }
    if plan.lifecycle == ScheduleLifecycle::Ended {
      continue;
    }
    let current: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM task_recurrence_series s JOIN task_recurrence_members m ON m.id=s.current_member_id WHERE s.id=$1 AND m.id=$2 AND m.advanced_at IS NULL)")
      .bind(series).bind(member).fetch_one(&mut **tx).await.map_err(storage)?;
    if !current {
      continue;
    }
    let completed: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
      .fetch_one(&mut **tx)
      .await
      .map_err(storage)?;
    advance_member_in(tx, &plan, member, "complete", completed).await?;
  }
  Ok(())
}

pub(super) fn relative_slot(
  reference: chrono::DateTime<chrono::Utc>,
  interval: RelativeInterval,
  date_only: bool,
  zone: AdmissionZone,
) -> RepoResult<Occurrence> {
  let local = reference.with_timezone(&zone.timezone()).naive_local();
  let reference = if date_only {
    ScheduleValue::Date(local.date())
  } else {
    ScheduleValue::LocalDateTime(local)
  };
  myoxus_application::scheduling::relative_after(reference, interval, zone).map_err(storage)
}

/// Complete and explicit Skip share this first-write receipt. A paused Complete
/// retains its fact without a successor; explicit Skip never changes the pause.
pub(super) async fn advance_member_in(
  tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
  plan: &ScheduledPlan,
  member: Uuid,
  kind: &str,
  at: chrono::DateTime<chrono::Utc>,
) -> RepoResult<()> {
  if !matches!(kind, "complete" | "skip") || plan.lifecycle == ScheduleLifecycle::Ended {
    return Err(invalid());
  }
  let current: bool =
    sqlx::query_scalar("SELECT COALESCE(current_member_id=$2,false) FROM task_recurrence_series WHERE id=$1")
      .bind(plan.id)
      .bind(member)
      .fetch_one(&mut **tx)
      .await
      .map_err(storage)?;
  let slot = match &plan.rule {
    Some(ScheduleRule::AfterCompletion { interval, date_only })
      if current && (kind == "skip" || plan.lifecycle == ScheduleLifecycle::Active) =>
    {
      Some(relative_slot(at, *interval, *date_only, plan.zone)?)
    }
    _ => None,
  };
  let successor = slot.map(|slot| task_occurrence_id(plan.id, slot.nominal, Some(member)));
  let changed=sqlx::query("UPDATE task_recurrence_members SET advanced_at=$2,advance_kind=$3,successor_occurrence_id=$4,successor_reference_at=$5 WHERE id=$1 AND series_id=$6 AND advanced_at IS NULL")
    .bind(member).bind(at).bind(kind).bind(successor).bind(slot.map(|_|at)).bind(plan.id)
    .execute(&mut **tx).await.map_err(storage)?;
  if changed.rows_affected() == 0 {
    return Ok(());
  }
  if let Some(slot) = slot {
    sqlx::query("UPDATE scheduling_schedules SET next_nominal=$2,next_due_at=$3,next_admission_at=$4,next_cause_member_id=$5,blocked_reason=NULL,updated_at=now() WHERE id=$1")
      .bind(plan.id).bind(serde_json::to_value(slot.nominal).map_err(storage)?).bind(slot.due_at).bind(at).bind(member)
      .execute(&mut **tx).await.map_err(storage)?;
    wake_in(tx, plan, member).await?;
  }
  Ok(())
}

pub(super) async fn wake_in(tx: &mut PgConnection, plan: &ScheduledPlan, member: Uuid) -> RepoResult<()> {
  let event = Uuid::new_v5(&member, b"completion-wake");
  let payload = TaskRecurrenceWake {
    workspace_id: plan.workspace_id,
    schedule_id: plan.id,
    member_id: member,
    generation: plan.generation,
  };
  sqlx::query("INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,payload,created_at) VALUES($1,'task_recurrence_due','task_recurrence_series',$2,$3,now()) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,processed_at=NULL,created_at=now()")
    .bind(event).bind(plan.id.to_string()).bind(serde_json::to_value(payload).map_err(storage)?)
    .execute(tx).await.map_err(storage)?;
  Ok(())
}

pub(crate) async fn lock_completion_source_in(tx: &mut PgConnection, run: &AcceptedAutomationRun) -> RepoResult<()> {
  let task = run.recurring_task.as_ref().ok_or_else(invalid)?;
  let Some(cause) = task.cause_member_id else {
    return Ok(());
  };
  let table = crate::workspace_database::DATABASE_ROWS_TABLE;
  let source: Option<Uuid> = sqlx::query_scalar(&format!("SELECT d.workspace_id FROM task_recurrence_members m JOIN {table} r ON r.id=m.row_id JOIN workspace_databases d ON d.id=r.database_id WHERE m.id=$1 AND m.series_id=$2 AND m.successor_occurrence_id=$3 AND m.advanced_at IS NOT NULL AND r.row_kind='task' AND r.deleted_at IS NULL AND d.deleted_at IS NULL FOR SHARE OF m,r,d NOWAIT"))
    .bind(cause).bind(task.series_id).bind(task.occurrence_id).fetch_optional(&mut *tx).await.map_err(storage)?;
  crate::workflow_runtime::effects::lock_runtime_read_authority(
    tx,
    run.actor_id.ok_or_else(invalid)?,
    source.ok_or_else(invalid)?,
  )
  .await
}
