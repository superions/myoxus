// SPDX-License-Identifier: AGPL-3.0-or-later
//! The native credential/rotation transaction owns admission. Shared timing and
//! outbox retain identifiers and expiry/configuration projections, never secrets.
use super::*;
use myoxus_application::git_sync::GitTokenRotationAttempt;

#[derive(Clone, Copy)]
pub(crate) struct RotationFence {
  pub credential_id: Uuid,
  pub generation: i64,
  pub revision: i64,
}

/// Call only after native consumer, credential and rotation locks. Match the
/// projection hook's key->schedule order before the steward can change context.
pub(crate) async fn lock_fence_in(
  conn: &mut PgConnection,
  fence: RotationFence,
  now: DateTime<Utc>,
) -> RepoResult<Option<DateTime<Utc>>> {
  sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))")
    .bind(format!("git-rotation-schedule:{}", fence.credential_id))
    .execute(&mut *conn)
    .await
    .map_err(storage)?;
  sqlx::query_scalar("SELECT next_due_at FROM scheduling_schedules WHERE id=$1 AND target_json->>'kind'='git_rotation' AND target_json->>'credential_id'=$1::text AND generation=$2 AND revision=$3 AND lifecycle='active' AND next_admission_at<=$4 FOR UPDATE")
    .bind(fence.credential_id).bind(fence.generation).bind(fence.revision).bind(now).fetch_optional(conn).await.map_err(storage)
}

pub(crate) async fn record_in(
  conn: &mut PgConnection,
  fence: RotationFence,
  due: DateTime<Utc>,
  attempt: GitTokenRotationAttempt,
  dispatch: bool,
) -> RepoResult<()> {
  let nominal = ScheduleValue::LocalDateTime(due.naive_utc());
  let slot = occurrence_id(fence.credential_id, nominal);
  // Explicit native reconfiguration can reset a pre-request Failed attempt at
  // the same expiry instant. Only a newer definition generation may replace
  // that closed one-shot receipt; Rotating/unknown outcomes remain native-fenced.
  let written=sqlx::query("INSERT INTO scheduling_occurrences(id,schedule_id,nominal_json,nominal_due_at,generation,dispatch_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(schedule_id,nominal_json) WHERE cause_member_id IS NULL DO UPDATE SET generation=EXCLUDED.generation,dispatch_id=EXCLUDED.dispatch_id,admitted_at=clock_timestamp() WHERE scheduling_occurrences.generation<EXCLUDED.generation")
    .bind(slot).bind(fence.credential_id).bind(serde_json::to_value(nominal).map_err(storage)?).bind(due).bind(fence.generation).bind(attempt.attempt_id).execute(&mut *conn).await.map_err(storage)?;
  if written.rows_affected() != 1 {
    return Err(blocked("gitRotationSlotAlreadyAdmitted"));
  }
  if !dispatch {
    return Ok(());
  }
  let payload = serde_json::to_value(myoxus_domain::scheduling::GitRotationDispatch {
    schedule_id: fence.credential_id,
    generation: fence.generation,
    profile_id: attempt.profile_id,
    attempt_id: attempt.attempt_id,
  })
  .map_err(storage)?;
  sqlx::query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'git_rotation',$2,'git_rotation_due',$3)")
    .bind(Uuid::new_v5(&attempt.attempt_id,b"scheduling:git-rotation")).bind(fence.credential_id.to_string()).bind(payload).execute(conn).await.map_err(storage)?;
  Ok(())
}

impl PgSchedulingRepository {
  #[tracing::instrument(skip_all,fields(credential_id=%id))]
  pub(super) async fn admit_git_rotation(
    &self,
    id: Uuid,
    generation: i64,
    revision: i64,
    now: DateTime<Utc>,
  ) -> RepoResult<Option<usize>> {
    let providers = self
      .git_rotation_providers
      .as_ref()
      .ok_or_else(|| blocked("gitRotationCapabilityUnavailable"))?;
    let attempt = crate::git_sync::SqlxGitSyncStore::new(self.pool.clone())
      .admit_rotation_slot(id, generation, revision, now, providers)
      .await
      .map_err(|_| blocked("gitRotationAdmissionUnavailable"))?;
    Ok(attempt.map(|_| 1))
  }
}

pub async fn delivery_is_current(
  pool: &PgPool,
  envelope: &myoxus_domain::scheduling::GitRotationDispatch,
) -> RepoResult<bool> {
  sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduling_occurrences o JOIN git_token_rotation r ON r.latest_attempt_id=o.dispatch_id JOIN git_sync_profiles p ON p.id=r.profile_id WHERE o.schedule_id=$1 AND o.generation=$2 AND o.dispatch_id=$3 AND r.profile_id=$4 AND r.state='Rotating' AND r.admitted_credential_id=$1 AND p.credential_id=$1)")
    .bind(envelope.schedule_id).bind(envelope.generation).bind(envelope.attempt_id).bind(envelope.profile_id).fetch_one(pool).await.map_err(storage)
}
