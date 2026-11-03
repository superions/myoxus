// SPDX-License-Identifier: AGPL-3.0-or-later
//! One-shot timing for personal Database reminders. Native edits own the
//! caller transaction and lock their reminder before its shared schedule.
use super::*;

/// Upsert native timing after its source row is locked. Cell edits pass their
/// previously read generation; an ordinary same-offset Set command intentionally
/// replaces the current live generation under the native owner lock.
pub(crate) async fn set_in(
  conn: &mut PgConnection,
  id: Uuid,
  workspace: Uuid,
  user: Uuid,
  trigger: DateTime<Utc>,
  expected: Option<i64>,
) -> RepoResult<()> {
  let old = sqlx::query("SELECT target_json,generation FROM scheduling_schedules WHERE id=$1 FOR UPDATE")
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(storage)?;
  if let Some(expected) = expected {
    if old
      .as_ref()
      .is_none_or(|old| old.get::<i64, _>("generation") != expected)
    {
      return Err(RepositoryError::Conflict("database reminder schedule revision"));
    }
  }
  if let Some(old) = &old {
    let target: ScheduleTarget = serde_json::from_value(old.get("target_json")).map_err(storage)?;
    if !matches!(target,ScheduleTarget::DatabaseReminder{reminder_id} if reminder_id==id) {
      return Err(blocked("databaseReminderScheduleOwnerMismatch"));
    }
  }
  let target = serde_json::to_value(ScheduleTarget::DatabaseReminder { reminder_id: id }).map_err(storage)?;
  let nominal = serde_json::to_value(ScheduleValue::LocalDateTime(trigger.naive_utc())).map_err(storage)?;
  sqlx::query("INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,next_nominal,next_due_at,next_admission_at) VALUES($1,$2,$3,'UTC',$4,$5,$6,$6) ON CONFLICT(id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,actor_id=EXCLUDED.actor_id,lifecycle='active',generation=scheduling_schedules.generation+1,revision=scheduling_schedules.revision+1,next_nominal=EXCLUDED.next_nominal,next_due_at=EXCLUDED.next_due_at,next_admission_at=EXCLUDED.next_admission_at,blocked_reason=NULL,updated_at=clock_timestamp()")
    .bind(id).bind(workspace).bind(user).bind(target).bind(nominal).bind(trigger).execute(conn).await.map_err(storage)?;
  Ok(())
}

/// Source cancellation keeps the original trigger for native status/history
/// projections while fencing any already queued generation.
pub(crate) async fn end_in(conn: &mut PgConnection, ids: &[Uuid], bump: bool) -> RepoResult<()> {
  if ids.is_empty() {
    return Ok(());
  }
  let updated=sqlx::query("UPDATE scheduling_schedules SET lifecycle='ended',generation=generation+CASE WHEN $2 THEN 1 ELSE 0 END,revision=revision+1,blocked_reason=NULL,updated_at=clock_timestamp() WHERE id=ANY($1) AND target_json->>'kind'='database_reminder'")
    .bind(ids).bind(bump).execute(conn).await.map_err(storage)?;
  if updated.rows_affected() != ids.len() as u64 {
    return Err(blocked("databaseReminderScheduleOwnerMismatch"));
  }
  Ok(())
}

/// A fired generation can be invalidated without resurrecting its one-shot or
/// erasing native completion history. Later queued validation sees the new fence.
pub(crate) async fn invalidate_in(conn: &mut PgConnection, ids: &[Uuid]) -> RepoResult<()> {
  if ids.is_empty() {
    return Ok(());
  }
  let updated=sqlx::query("UPDATE scheduling_schedules SET generation=generation+1,revision=revision+1,updated_at=clock_timestamp() WHERE id=ANY($1) AND target_json->>'kind'='database_reminder'")
    .bind(ids).execute(conn).await.map_err(storage)?;
  if updated.rows_affected() != ids.len() as u64 {
    return Err(blocked("databaseReminderScheduleOwnerMismatch"));
  }
  Ok(())
}

impl PgSchedulingRepository {
  #[tracing::instrument(skip_all,fields(reminder_id=%id))]
  pub(super) async fn admit_database_reminder(
    &self,
    id: Uuid,
    generation: i64,
    revision: i64,
    now: DateTime<Utc>,
  ) -> RepoResult<Option<usize>> {
    let Some((repo, effects)) = &self.database_reminders else {
      return Err(blocked("databaseReminderSourceUnavailable"));
    };
    let observed=sqlx::query("SELECT r.user_id,s.next_due_at FROM database_row_reminders r JOIN scheduling_schedules s ON s.id=r.id WHERE r.id=$1 AND s.generation=$2 AND s.revision=$3 AND s.lifecycle='active' AND s.next_admission_at<=$4")
      .bind(id).bind(generation).bind(revision).bind(now).fetch_optional(&self.pool).await.map_err(storage)?;
    let Some(observed) = observed else { return Ok(None) };
    let trigger: DateTime<Utc> = observed.get("next_due_at");
    let Some(prepared) = repo
      .prepare_database_row_reminder_dispatch(id, generation, trigger, observed.get("user_id"))
      .await?
    else {
      repo
        .cancel_database_row_reminder_generation(id, generation, now)
        .await?;
      return Ok(Some(0));
    };
    let native = &prepared.reminder;
    let payload = myoxus_application::database::reminders::database_row_reminder_delivery_payload(&prepared);
    let mut tx = self.pool.begin().await.map_err(storage)?;
    // Native writers lock their reminder before the shared schedule. They own
    // all field/Task-state cancellation hooks, so this late compare fences the
    // preparation snapshot without duplicating those business rules in SQL.
    let row =
      sqlx::query("SELECT * FROM database_row_reminders WHERE id=$1 AND status IN('scheduled','claimed') FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(storage)?;
    let Some(row) = row else { return Ok(None) };
    if row.get::<Uuid, _>("workspace_id") != native.workspace_id
      || row.get::<Uuid, _>("database_id") != native.database_id
      || row.get::<Uuid, _>("row_id") != native.row_id
      || row.get::<Uuid, _>("field_id") != native.field_id
      || row.get::<Uuid, _>("user_id") != native.user_id
    {
      return Ok(None);
    }
    let schedule=sqlx::query("SELECT target_json FROM scheduling_schedules WHERE id=$1 AND generation=$2 AND revision=$3 AND next_due_at=$4 AND next_admission_at<=$5 AND lifecycle='active' FOR UPDATE")
      .bind(id).bind(generation).bind(revision).bind(trigger).bind(now).fetch_optional(&mut *tx).await.map_err(storage)?;
    let Some(schedule) = schedule else { return Ok(None) };
    let target: ScheduleTarget = serde_json::from_value(schedule.get("target_json")).map_err(storage)?;
    if !matches!(target,ScheduleTarget::DatabaseReminder{reminder_id} if reminder_id==id) {
      return Err(blocked("databaseReminderScheduleOwnerMismatch"));
    }
    let nominal = ScheduleValue::LocalDateTime(trigger.naive_utc());
    let occurrence = occurrence_id(id, nominal);
    let dispatch = Uuid::new_v5(&occurrence, format!("database-reminder:{generation}").as_bytes());
    let inserted=sqlx::query("INSERT INTO scheduling_occurrences(id,schedule_id,nominal_json,nominal_due_at,generation,dispatch_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET generation=EXCLUDED.generation,dispatch_id=EXCLUDED.dispatch_id WHERE scheduling_occurrences.schedule_id=EXCLUDED.schedule_id AND scheduling_occurrences.nominal_json=EXCLUDED.nominal_json AND scheduling_occurrences.generation<EXCLUDED.generation AND scheduling_occurrences.run_id IS NULL")
      .bind(occurrence).bind(id).bind(serde_json::to_value(nominal).map_err(storage)?).bind(trigger).bind(generation).bind(dispatch).execute(&mut *tx).await.map_err(storage)?;
    if inserted.rows_affected() != 1 {
      return Err(blocked("databaseReminderOccurrenceConflict"));
    }
    sqlx::query("UPDATE database_row_reminders SET status='fired',fired_at=$2,updated_at=$2 WHERE id=$1")
      .bind(id)
      .bind(now)
      .execute(&mut *tx)
      .await
      .map_err(storage)?;
    // An ended one-shot retains its trigger/revision for existing API/history
    // readback and old queued envelopes. Only admission eligibility ends here.
    sqlx::query("UPDATE scheduling_schedules SET lifecycle='ended',revision=revision+1,blocked_reason=NULL,updated_at=$2 WHERE id=$1")
      .bind(id).bind(now).execute(&mut *tx).await.map_err(storage)?;
    sqlx::query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,created_at) VALUES($1,'database_reminder',$2,'database_reminder_due',$3,$4)")
      .bind(dispatch).bind(id.to_string()).bind(payload).bind(now).execute(&mut *tx).await.map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    myoxus_application::database::reminders::record_database_reminder_admitted(effects, &prepared).await;
    Ok(Some(1))
  }
}

/// The existing notification consumer repeats full native validation. This
/// transport fence rejects a superseded outbox without a second timing sweep.
pub async fn delivery_is_current(
  pool: &PgPool,
  envelope: &myoxus_application::database::DatabaseRowReminderDispatchEnvelope,
) -> RepoResult<bool> {
  sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM database_row_reminders r JOIN scheduling_schedules s ON s.id=r.id WHERE r.id=$1 AND s.generation=$2 AND s.next_due_at=$3 AND r.user_id=$4 AND r.workspace_id=$5 AND r.database_id=$6 AND r.row_id=$7 AND r.field_id=$8 AND r.status='fired' AND s.target_json->>'kind'='database_reminder')")
    .bind(envelope.reminder_id).bind(envelope.schedule_revision).bind(envelope.trigger_at).bind(envelope.user_id).bind(envelope.workspace_id).bind(envelope.database_id).bind(envelope.row_id).bind(envelope.field_id).fetch_one(pool).await.map_err(storage)
}
