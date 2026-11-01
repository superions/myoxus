// SPDX-License-Identifier: AGPL-3.0-or-later
//! Durable Git-Sync run dispatch.
//!
//! PostgreSQL owns run intent. Redis delivery is replayed with a stable
//! run-derived job identifier, and the run is acknowledged as queued only
//! after that identifier is persisted back to PostgreSQL.

use myoxus_domain::git_sync::{GitSyncRun, RunStatus};
use myoxus_infrastructure::git_sync::{PendingGitSyncDispatch, SqlxGitSyncStore};
use myoxus_worker::{JobOptions, RedisQueue};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct DispatchPass {
  pub attempted: usize,
  pub acknowledged: usize,
  pub failures: Vec<String>,
}

pub async fn dispatch_run(
  queue: &RedisQueue,
  store: &SqlxGitSyncStore,
  pending: PendingGitSyncDispatch,
) -> Result<GitSyncRun, String> {
  if pending.run.status == RunStatus::Running {
    if pending.run.job_id.is_some() {
      return Ok(pending.run);
    }
    return Err("running Git-Sync run has no persisted queue job id".to_string());
  }
  if pending.run.status != RunStatus::Pending {
    return Err(format!(
      "Git-Sync run {} is not dispatchable in status {}",
      pending.run.id, pending.run.status
    ));
  }

  let job_id = pending
    .run
    .job_id
    .clone()
    .unwrap_or_else(|| format!("git-sync-{}", pending.run.id));
  let persisted = store
    .persist_dispatch_job_id(pending.run.id, &job_id)
    .await
    .map_err(|error| format!("persist queue job for Git-Sync run {}: {error}", pending.run.id))?;
  let payload = serde_json::json!({
    "profileId": persisted.profile_id.to_string(),
    "direction": persisted.direction.to_string(),
    "runId": persisted.id.to_string(),
    "trigger": persisted.trigger_source.to_string(),
  });
  queue
    .enqueue_idempotent("git-sync", &job_id, "git-sync.syncRun", payload, JobOptions::default())
    .await
    .map_err(|error| format!("enqueue Git-Sync run {}: {error}", persisted.id))?;
  Ok(persisted)
}

pub async fn dispatch_pending_runs(
  queue: &RedisQueue,
  store: &SqlxGitSyncStore,
  limit: i64,
) -> Result<DispatchPass, String> {
  let pending = store
    .list_pending_dispatches(limit)
    .await
    .map_err(|error| format!("load pending Git-Sync runs: {error}"))?;
  let mut result = DispatchPass {
    attempted: pending.len(),
    ..DispatchPass::default()
  };
  for run in pending {
    match dispatch_run(queue, store, run).await {
      Ok(_) => result.acknowledged += 1,
      Err(error) => result.failures.push(error),
    }
  }
  Ok(result)
}

pub fn pending_dispatch(run: GitSyncRun) -> PendingGitSyncDispatch {
  PendingGitSyncDispatch { run }
}
