// SPDX-License-Identifier: AGPL-3.0-or-later
//! Current Git policy and identifier-only native execution handoffs.
//!
//! Shared scheduling owns Cron, polling and rotation timing; native Git owns
//! execution, credential policy and provider outcomes.

use sqlx::PgPool;

use myoxus_infrastructure::git_sync::SqlxGitSyncStore;
use myoxus_worker::{JobOptions, RedisQueue};

/// Hand off the already admitted native attempt, without touching credentials
/// or re-admitting after an enqueue ACK is lost. Existing job attempts/backoff
/// remain authoritative for the native provider's unknown-outcome fence.
#[tracing::instrument(skip_all,fields(attempt_id=%envelope.attempt_id))]
pub async fn dispatch_rotation_intent(
  pool: &PgPool,
  queue: &RedisQueue,
  envelope: &myoxus_domain::scheduling::GitRotationDispatch,
) -> Result<(), String> {
  if !myoxus_infrastructure::scheduling::git_rotation::delivery_is_current(pool, envelope)
    .await
    .map_err(|_| "rotation delivery receipt unavailable")?
  {
    return Ok(());
  }
  let job_id = format!("git-sync-token-rotation-{}", envelope.attempt_id);
  let payload = serde_json::json!({
    "profileId": envelope.profile_id.to_string(),
    "attemptId": envelope.attempt_id.to_string(),
  });
  queue
    .enqueue_idempotent(
      "git-sync",
      &job_id,
      "git-sync.tokenRotation",
      payload,
      JobOptions::default(),
    )
    .await
    .map_err(|_| "native rotation queue handoff unavailable")?;
  Ok(())
}

pub struct SharedGitPolicySource(crate::state::ApiState);

impl SharedGitPolicySource {
  pub fn new(state: crate::state::ApiState) -> Self {
    Self(state)
  }
}

#[async_trait::async_trait]
impl myoxus_application::scheduling::git::ScheduledGitPolicySource for SharedGitPolicySource {
  #[tracing::instrument(skip_all)]
  async fn policy(&self) -> myoxus_application::auth::AuthResult<myoxus_application::git_sync::GitSyncLifecyclePolicy> {
    self
      .0
      .effective_git_sync_policy()
      .await
      .map(|policy| policy.lifecycle_policy())
      .map_err(|_| myoxus_application::auth::AuthError::Storage("Git scheduling policy unavailable".into()))
  }
}

/// Publish only the accepted native Run identified by a frozen shared receipt.
/// Lost enqueue ACKs use the existing stable Git job and native receiver guard;
/// no cursor selection or network call belongs in its SQL admission transaction.
#[tracing::instrument(skip_all,fields(run_id=%envelope.run_id))]
pub async fn dispatch_scheduled_intent(
  pool: &PgPool,
  queue: &RedisQueue,
  envelope: &myoxus_domain::scheduling::GitScheduleDispatch,
  source: myoxus_domain::git_sync::GitSyncRunSource,
) -> Result<(), String> {
  if !myoxus_infrastructure::scheduling::git_cron::delivery_is_current(pool, envelope, source)
    .await
    .map_err(|_| "Git scheduling receipt unavailable")?
  {
    return Ok(());
  }
  let store = SqlxGitSyncStore::new(pool.clone());
  let run = store
    .get_run(envelope.run_id)
    .await
    .map_err(|_| "Scheduled Git native Run unavailable")?;
  if run.status != myoxus_domain::git_sync::RunStatus::Pending {
    return Ok(());
  }
  super::dispatch::dispatch_run(queue, &store, super::dispatch::pending_dispatch(run)).await?;
  Ok(())
}
