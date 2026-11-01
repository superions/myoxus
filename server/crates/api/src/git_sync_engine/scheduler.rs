// SPDX-License-Identifier: AGPL-3.0-or-later
//! Durable Cron admission and polling candidate selection for Git Sync.
//!
//! The server loop owns timing and queue enqueueing; this module owns the
//! policy-aware "is this profile due now?" decision so tests do not need Redis.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use myoxus_application::git_sync::{GitTokenRotationError, GitTokenRotationService, GitTokenRotationStoreError};
use myoxus_infrastructure::git_sync::SqlxGitSyncStore;
use myoxus_worker::{JobOptions, RedisQueue};

use super::policy::EffectiveGitSyncPolicy;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PollingSyncCandidate {
  pub profile_id: Uuid,
  pub sync_direction: String,
}

/// Admit and publish due token rotations through the existing schedule tick
/// and queue. PostgreSQL owns admission; Redis carries identifiers only.
pub async fn admit_due_token_rotations(
  queue: &RedisQueue,
  service: &GitTokenRotationService,
  now: DateTime<Utc>,
  limit: usize,
) -> Result<usize, String> {
  let candidates = service
    .due_profile_ids(now, limit)
    .await
    .map_err(|error| format!("load due token rotations: {error}"))?;
  let mut published = 0;
  for profile_id in candidates {
    let attempt = match service.admit_attempt(profile_id, now, false).await {
      Ok(Some(attempt)) => attempt,
      Ok(None)
      | Err(GitTokenRotationError::Store(
        GitTokenRotationStoreError::RotationInProgress | GitTokenRotationStoreError::UnfinishedRun,
      )) => continue,
      Err(error) => return Err(format!("admit token rotation for profile {profile_id}: {error}")),
    };
    let job_id = format!("git-sync-token-rotation-{}", attempt.attempt_id);
    let payload = serde_json::json!({
      "profileId": attempt.profile_id.to_string(),
      "attemptId": attempt.attempt_id.to_string(),
    });
    if let Err(error) = queue
      .enqueue_idempotent(
        "git-sync",
        &job_id,
        "git-sync.tokenRotation",
        payload,
        JobOptions::default(),
      )
      .await
    {
      service
        .record_dispatch_failure(attempt, now)
        .await
        .map_err(|state_error| {
          format!(
            "enqueue token rotation {job_id} failed ({error}); recording pre-request failure also failed: {state_error}"
          )
        })?;
      return Err(format!("enqueue token rotation {job_id}: {error}"));
    }
    published += 1;
  }
  Ok(published)
}

/// Drain a bounded batch of due Cron profiles after one generic Redis tick.
///
/// PostgreSQL profile locks and scheduled-slot uniqueness own correctness.
/// Redis is only a cluster-safe wake-up and dispatch transport.
pub async fn admit_due_cron_profiles(
  pool: &PgPool,
  queue: &RedisQueue,
  policy: &EffectiveGitSyncPolicy,
  now: DateTime<Utc>,
  limit: usize,
) -> Result<usize, String> {
  if !policy.enabled || !policy.auto_sync_allowed {
    return Ok(0);
  }

  let store = SqlxGitSyncStore::new(pool.clone());
  let lifecycle_policy = policy.lifecycle_policy();
  let mut processed = 0;
  for _ in 0..limit {
    let Some(admission) = store
      .admit_next_due_cron(now, &lifecycle_policy)
      .await
      .map_err(|error| format!("admit due Cron profile: {error}"))?
    else {
      break;
    };
    processed += 1;
    tracing::info!(
      profile_id = %admission.profile_id,
      skipped_occurrences = admission.skipped_occurrences,
      pending_misfire_scheduled_for = ?admission.pending_misfire_scheduled_for,
      policy_denial = ?admission.policy_denial,
      run_admitted = admission.run.is_some(),
      "processed durable Git-Sync Cron schedule state"
    );
    if let Some(run) = admission.run {
      super::dispatch::dispatch_run(queue, &store, super::dispatch::pending_dispatch(run)).await?;
    }
  }
  Ok(processed)
}

/// Return polling profiles due for a new run under the current effective policy.
///
/// The interval is measured against the latest run activity
/// `max(started_at, finished_at)` for every terminal and non-terminal status.
/// This prevents rapid re-enqueue loops after failed/completed runs without
/// turning stale Pending/Running rows into a permanent block.
pub async fn due_polling_profiles(
  pool: &PgPool,
  policy: &EffectiveGitSyncPolicy,
  now: DateTime<Utc>,
) -> Result<Vec<PollingSyncCandidate>, String> {
  if !policy.enabled || !policy.auto_sync_allowed {
    return Ok(Vec::new());
  }

  let rows = SqlxGitSyncStore::new(pool.clone())
    .list_polling_profiles()
    .await
    .map_err(|e| format!("failed to load polling git sync profiles: {e}"))?;

  let mut due = Vec::new();
  for row in rows {
    let direction = row.sync_direction;
    let auth_method = row.auth_method;
    let repo_url = row.repo_url;
    let interval_secs = row.polling_interval_secs;
    let last_activity_at = row.last_activity_at;

    if !policy
      .allowed_directions
      .contains(normalize_sync_direction_db_value(&direction))
    {
      continue;
    }
    if !policy
      .allowed_auth_methods
      .contains(normalize_auth_method_db_value(&auth_method))
    {
      continue;
    }
    if !policy.is_repo_host_allowed(&repo_url) {
      continue;
    }
    if interval_secs <= 0 {
      continue;
    }
    if let Some(last_activity_at) = last_activity_at
      && now.signed_duration_since(last_activity_at).num_seconds() < interval_secs
    {
      continue;
    }

    due.push(PollingSyncCandidate {
      profile_id: row.profile_id,
      sync_direction: direction,
    });
  }

  Ok(due)
}

fn normalize_sync_direction_db_value(value: &str) -> &str {
  match value {
    "Bidirectional" | "bidirectional" => "bidirectional",
    "MyoxusToGit" | "myoxus_to_git" => "myoxus_to_git",
    "GitToMyoxus" | "git_to_myoxus" => "git_to_myoxus",
    _ => value,
  }
}

fn normalize_auth_method_db_value(value: &str) -> &str {
  match value {
    "HttpsToken" | "https_token" => "https_token",
    "HttpsPassword" | "https_password" => "https_password",
    "SshKey" | "ssh_key" => "ssh_key",
    _ => value,
  }
}
