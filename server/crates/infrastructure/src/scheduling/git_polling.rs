// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native configuration projects one inactivity interval. Run activity advances
//! its cursor in the same SQL transaction, including manual/failed completion.
use super::*;
use myoxus_domain::git_sync::{GitSyncProfile, TriggerMode};

/// The caller holds the native profile lock. Keep definition changes after any
/// native Run mutations: Run activity locks only this schedule, never a profile.
pub(crate) async fn replace_in(
  conn: &mut PgConnection,
  previous: Option<&GitSyncProfile>,
  updated: &GitSyncProfile,
) -> RepoResult<()> {
  let current=sqlx::query("SELECT id,activity_at FROM scheduling_schedules WHERE target_json->>'kind'='git_polling' AND target_json->>'profile_id'=$1 FOR UPDATE")
    .bind(updated.id.to_string()).fetch_optional(&mut *conn).await.map_err(storage)?;
  if updated.trigger_mode != TriggerMode::Polling {
    if let Some(row) = current {
      sqlx::query("UPDATE scheduling_schedules SET lifecycle='ended',generation=generation+1,revision=revision+1,next_nominal=NULL,next_due_at=NULL,next_admission_at=NULL,blocked_reason=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lifecycle<>'ended'")
        .bind(row.get::<Uuid,_>("id")).execute(conn).await.map_err(storage)?;
    }
    return Ok(());
  }
  let changed = previous.is_none_or(|old| {
    old.trigger_mode != updated.trigger_mode
      || old.enabled != updated.enabled
      || old.polling_interval_secs != updated.polling_interval_secs
      || old.owner_id != updated.owner_id
      || old.workspace_id != updated.workspace_id
  });
  if current.is_some() && !changed {
    return Ok(());
  }
  let id = current.as_ref().map_or_else(Uuid::new_v4, |row| row.get("id"));
  let interval = updated.polling_interval_secs;
  if updated.enabled && interval.is_none_or(|seconds| seconds <= 0) {
    return Err(blocked("gitPollingIntervalInvalid"));
  }
  let history: Option<DateTime<Utc>> = sqlx::query_scalar(
    "SELECT max(GREATEST(started_at,COALESCE(finished_at,started_at))) FROM git_sync_runs WHERE profile_id=$1",
  )
  .bind(updated.id)
  .fetch_one(&mut *conn)
  .await
  .map_err(storage)?;
  let activity = current
    .as_ref()
    .and_then(|row| row.get::<Option<DateTime<Utc>>, _>("activity_at"))
    .into_iter()
    .chain(history)
    .max();
  let next = if updated.enabled {
    Some(match activity {
      Some(at) => at
        .checked_add_signed(
          Duration::try_seconds(interval.unwrap()).ok_or_else(|| blocked("gitPollingIntervalOverflow"))?,
        )
        .ok_or_else(|| blocked("gitPollingIntervalOverflow"))?,
      None => Utc::now(),
    })
  } else {
    None
  };
  let nominal = next
    .map(|next| serde_json::to_value(ScheduleValue::LocalDateTime(next.naive_utc())))
    .transpose()
    .map_err(storage)?;
  let target = serde_json::to_value(ScheduleTarget::GitPolling { profile_id: updated.id }).map_err(storage)?;
  // interval_seconds is a locked native-definition projection, never another
  // editable rule. Activity updates use this current tuple's interval after
  // waiting for its lock, not a pre-wait snapshot of native configuration.
  sqlx::query("INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,lifecycle,next_nominal,next_due_at,next_admission_at,interval_seconds,activity_at) VALUES($1,$2,$3,'UTC',$4,$5,$6,$7,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,actor_id=EXCLUDED.actor_id,lifecycle=EXCLUDED.lifecycle,generation=scheduling_schedules.generation+1,revision=scheduling_schedules.revision+1,next_nominal=EXCLUDED.next_nominal,next_due_at=EXCLUDED.next_due_at,next_admission_at=EXCLUDED.next_admission_at,interval_seconds=EXCLUDED.interval_seconds,activity_at=EXCLUDED.activity_at,blocked_reason=NULL,updated_at=clock_timestamp()")
    .bind(id).bind(updated.workspace_id).bind(updated.owner_id).bind(target).bind(if updated.enabled{"active"}else{"ended"}).bind(nominal).bind(next).bind(interval).bind(activity).execute(conn).await.map_err(storage)?;
  Ok(())
}

impl PgSchedulingRepository {
  #[tracing::instrument(skip_all,fields(schedule_id=%id,profile_id=%profile))]
  pub(super) async fn admit_git_polling(
    &self,
    id: Uuid,
    profile: Uuid,
    generation: i64,
    revision: i64,
    now: DateTime<Utc>,
  ) -> RepoResult<Option<usize>> {
    let policy = self
      .git_policy
      .as_ref()
      .ok_or_else(|| blocked("gitPollingPolicyUnavailable"))?
      .policy()
      .await
      .map_err(|_| blocked("gitPollingPolicyUnavailable"))?;
    if !policy.enabled || !policy.auto_sync_allowed {
      return Err(blocked("gitPollingDisabled"));
    }
    let admitted = crate::git_sync::SqlxGitSyncStore::new(self.pool.clone())
      .admit_polling_slot(id, profile, generation, revision, now, &policy)
      .await
      .map_err(|_| blocked("gitPollingAdmissionUnavailable"))?;
    Ok(admitted)
  }
}
