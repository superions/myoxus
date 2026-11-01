// SPDX-License-Identifier: AGPL-3.0-or-later
//! Top-level sync runner — the single entry point called by the `GitSyncQueueHandler`.
//!
//! # Sync pipeline
//!
//! ```text
//!  1. Claim the exact durable run/job and acquire the profile lock.
//!  2. Validate policy/profile/credential state and reset the mirror to the
//!     authenticated remote revision recorded as `commit_before`.
//!  3. Load every required DB/Git state fail-closed, plan paths, and prepare
//!     inbound Markdown/Yjs payloads before any remote mutation.
//!  4. Apply all Git-working-tree actions and abort the whole attempt if any
//!     required action fails.
//!  5. Commit/push and accept success only after the authenticated remote ref
//!     equals the intended commit.
//!  6. Stage inbound file objects under a durable promotion ledger.
//!  7. Commit documents, bindings, baselines, conflicts, version links,
//!     counters, partial items, promotion state and the terminal run through
//!     one PostgreSQL transaction.
//!  8. Clean stages only after a proven DB outcome. Periodic reconciliation
//!     classifies abandoned runs and promotion records after process failure.
//! ```
//!
//! # Error handling
//!
//! Errors before remote movement release or fail the same run through a
//! job-correlated compare-and-set. Errors after a verified remote movement
//! record `reconciliation_required`; an unobservable push outcome deliberately
//! remains `Running` until authenticated periodic reconciliation. Normal
//! persisted state is never written through best-effort per-item calls.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use sqlx::PgPool;
use tracing::{debug, error, info, instrument, trace, warn};
use uuid::Uuid;

use myoxus_application::git_sync::backend::{GitOperationGuard, GitRepositoryPort};
use myoxus_application::git_sync::doc_reconcile_plan;
use myoxus_application::git_sync::export::{self, GitSyncManifest, PathPlanDocument};
use myoxus_application::git_sync::file_reconcile::{self, FileReconcileAction, GitFileEntry};
use myoxus_application::git_sync::finalization::GitSyncRunFinalizationDraft;
use myoxus_application::git_sync::reconcile::{BaselineState, ReconcileAction};
use myoxus_application::git_sync::remote_commit::{self, RemoteCommitError};
use myoxus_application::git_sync::{GitSyncCoordinationError, GitSyncRepositoryCoordination, GitSyncRepositoryScope};
use myoxus_application::ports::{BlobStoragePort, RedisPort};
use myoxus_domain::git_sync::{BindingId, GitSyncRunSource, SyncDirection};
use myoxus_infrastructure::{
  disk,
  git_sync::{
    Git2Adapter, GitSyncNativeOwnership, MirrorLockError, PgGitSyncRepositoryCoordination, SqlxGitSyncStore,
    acquire_profile_mirror,
  },
};

use super::{credential, error::SyncError, executor, loader, locking, partial, persist, repo};

fn mirror_lock_error(error: MirrorLockError, profile_id: Uuid, phase: &'static str) -> SyncError {
  match error {
    MirrorLockError::Busy => SyncError::AlreadySyncing(profile_id),
    MirrorLockError::Unsafe(message) => SyncError::permanent(message, profile_id, phase),
    MirrorLockError::Filesystem(error) => {
      SyncError::retryable(format!("physical mirror lock unavailable: {error}"), profile_id, phase)
    }
  }
}

fn repository_guard_error(error: GitSyncCoordinationError, profile_id: Uuid) -> SyncError {
  match error {
    GitSyncCoordinationError::Busy | GitSyncCoordinationError::Unavailable => {
      SyncError::retryable(error.to_string(), profile_id, "repository_guard")
    }
    GitSyncCoordinationError::InvalidScope | GitSyncCoordinationError::Lost => {
      SyncError::permanent(error.to_string(), profile_id, "repository_guard")
    }
  }
}

struct RunnerOperationOwnership {
  _mirror: Arc<myoxus_infrastructure::git_sync::MirrorDirectoryGuard>,
  _repository: Arc<GitSyncNativeOwnership>,
}

impl fmt::Debug for RunnerOperationOwnership {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("RunnerOperationOwnership")
  }
}

/// Configuration passed to the runner from the worker handler.
#[derive(Clone)]
pub struct RunnerConfig {
  /// Same native reader used by Web/Public, injected from initialized services.
  /// Outbound publication fails closed when unavailable.
  pub overview_service: Option<myoxus_application::workspace_overview::WorkspaceOverviewService>,
  /// Public origin used for canonical document-reference URLs.
  pub server_origin: String,
  /// Base directory for cloned repositories.
  pub repo_base_dir: PathBuf,
  /// Static Git-Sync policy from YAML/ENV; DB overrides are resolved at run time.
  pub static_policy: crate::config::GitSyncPolicyConfig,
  /// Universal live configuration snapshot shared with request handlers.
  pub config_overrides: Arc<tokio::sync::RwLock<crate::config_reload::ConfigOverrides>>,
  /// Server's crypto.private_key for credential decryption.
  pub crypto_key: String,
  /// Timeout in seconds for git network operations (clone, fetch, push).
  pub network_timeout_secs: u64,
  /// Timeout in seconds for git local operations (checkout, commit).
  pub local_timeout_secs: u64,
  /// Maximum number of document/Markdown actions claimed from a durable
  /// partial-sync session per run. `0` keeps the run unlimited.
  ///
  /// The loader still compares the full state; this limit is applied only to
  /// mutating doc actions so batches can continue without hiding conflicts or
  /// starving pending session items.
  pub max_docs_per_sync: usize,
  /// Positive shallow clone/fetch depth for network remotes.
  ///
  /// `0` is rejected by configuration validation. Local test remotes may still
  /// be cloned fully because libgit2 cannot shallow-fetch local transports.
  pub clone_depth: u32,
  /// Maximum push retry attempts before failing.
  pub push_max_retries: u32,
  /// Git commit author name for sync commits.
  pub commit_author_name: String,
  /// Git commit author email for sync commits.
  pub commit_author_email: String,
  /// Number of docs above which Yjs conversion switches to parallel mode.
  pub parallel_conversion_threshold: usize,
  /// Maximum total size in MB for all local git mirror repos. 0 = unlimited.
  pub max_mirror_storage_mb: u64,
  /// Minimum free disk space in MB required before clone/fetch.
  pub min_free_disk_mb: u64,
  /// TTL for the per-profile distributed sync lock in Redis (ROB-26).
  /// Must cover the max expected sync wall-clock; defaults to 300s.
  pub lock_ttl_seconds: u64,
  /// Required lock-role Redis adapter for profile leases and stale-run inspection.
  pub lock_redis: Arc<dyn RedisPort>,
  /// Cache-role Redis adapter, or the established session-role fallback, used
  /// only for Git status cache invalidation.
  pub cache_redis: Arc<dyn RedisPort>,
  /// Redis namespace for cache key construction.
  pub redis_namespace: String,
  /// Fallback MIME allowlist from startup config (used when DB has no override).
  pub mime_allowlist_admin: Vec<String>,
  /// Fallback MIME blocklist from startup config (used when DB has no override).
  pub mime_blocklist_admin: Vec<String>,
  /// Fallback MIME validation mode from startup config ("strict" or "warn").
  pub mime_validation_mode: String,
}

impl std::fmt::Debug for RunnerConfig {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("RunnerConfig")
      .field("repo_base_dir", &self.repo_base_dir)
      .field("network_timeout_secs", &self.network_timeout_secs)
      .field("local_timeout_secs", &self.local_timeout_secs)
      .field("max_docs_per_sync", &self.max_docs_per_sync)
      .field("clone_depth", &self.clone_depth)
      .field("push_max_retries", &self.push_max_retries)
      .field("parallel_conversion_threshold", &self.parallel_conversion_threshold)
      .field("max_mirror_storage_mb", &self.max_mirror_storage_mb)
      .field("min_free_disk_mb", &self.min_free_disk_mb)
      .field("lock_ttl_seconds", &self.lock_ttl_seconds)
      .field("lock_redis", &"...")
      .field("cache_redis", &"...")
      .finish()
  }
}

impl Default for RunnerConfig {
  fn default() -> Self {
    Self {
      overview_service: None,
      repo_base_dir: std::env::temp_dir().join("myoxus-git-sync"),
      server_origin: "https://myoxus.test".to_string(),
      static_policy: crate::config::GitSyncPolicyConfig::default(),
      config_overrides: Arc::new(tokio::sync::RwLock::new(
        crate::config_reload::ConfigOverrides::default(),
      )),
      crypto_key: String::new(),
      network_timeout_secs: 120,
      local_timeout_secs: 30,
      max_docs_per_sync: 0,
      clone_depth: 1,
      push_max_retries: 1,
      commit_author_name: "Myoxus Sync".to_string(),
      commit_author_email: "sync@myoxus.local".to_string(),
      parallel_conversion_threshold: 10,
      max_mirror_storage_mb: 1024,
      min_free_disk_mb: 500,
      lock_ttl_seconds: 300,
      lock_redis: Arc::new(myoxus_infrastructure::redis::InMemoryRedisAdapter::new(
        "myoxus:git-sync-test-lock",
      )),
      cache_redis: Arc::new(myoxus_infrastructure::redis::InMemoryRedisAdapter::new(
        "myoxus:git-sync-test-cache",
      )),
      redis_namespace: "myoxus".to_string(),
      mime_allowlist_admin: Vec::new(),
      mime_blocklist_admin: Vec::new(),
      mime_validation_mode: "warn".to_string(),
    }
  }
}

impl RunnerConfig {
  pub async fn effective_policy(&self) -> Result<super::policy::EffectiveGitSyncPolicy, String> {
    let overrides = self.config_overrides.read().await;
    super::policy::resolve_git_sync_policy(&self.static_policy, &overrides.overrides)
  }
}

/// Recover process-abandoned `Running` rows at startup and on the periodic
/// reconciliation interval.
///
/// Repository ownership precedes the distributed profile lock so this pass
/// cannot classify a run still active on another server or CLI writer. The authenticated remote ref is
/// then compared with the source OID persisted before working-tree mutation:
/// unchanged remotes produce an ordinary failed run; changed or unknown source
/// state produces an explicit reconciliation marker.
#[instrument(skip(pool, config, blob_storage))]
pub async fn reconcile_stale_running_runs(pool: &PgPool, config: &RunnerConfig, blob_storage: &dyn BlobStoragePort) {
  let store = SqlxGitSyncStore::new(pool.clone());
  let stale_locks = locking::new_locks();
  let stale_after_seconds = config
    .lock_ttl_seconds
    .saturating_mul(2)
    .max(
      config
        .network_timeout_secs
        .saturating_add(config.local_timeout_secs)
        .saturating_mul(2),
    )
    .max(900);
  let cutoff = chrono::Utc::now() - chrono::Duration::seconds(stale_after_seconds as i64);
  let stale_runs = match store.list_stale_running_runs(cutoff, 100).await {
    Ok(runs) => runs,
    Err(error) => {
      warn!(%error, "could not inspect stale Git-Sync runs during startup");
      Vec::new()
    }
  };
  let effective_policy = match config.effective_policy().await {
    Ok(policy) => policy,
    Err(error) => {
      warn!(%error, "stale Git-Sync runs remain untouched because effective policy is unavailable");
      recover_blob_promotions(&store, blob_storage, cutoff).await;
      return;
    }
  };
  let ssh_host_key_policy = effective_policy.ssh_host_key_policy;
  let https_certificate_policy = effective_policy.https_certificate_policy;
  let allowed_hosts = effective_policy.allowed_hosts.into_iter().collect::<Vec<_>>();

  for run in stale_runs {
    let Some(job_id) = run.job_id.as_deref() else {
      error!(run_id = %run.id, profile_id = %run.profile_id, "stale Git-Sync run has no queue job identity");
      continue;
    };
    let inspection_lock_ttl = config
      .lock_ttl_seconds
      .max(config.network_timeout_secs.saturating_mul(2))
      .saturating_add(config.local_timeout_secs)
      .saturating_add(60);
    let initial_profile = match store.get_profile(run.profile_id).await {
      Ok(profile) => profile,
      Err(error) => {
        warn!(run_id = %run.id, %error, "stale-run profile unavailable before branch coordination");
        continue;
      }
    };
    let scope = match GitSyncRepositoryScope::new(&initial_profile.repo_url, &initial_profile.branch) {
      Ok(scope) => scope,
      Err(error) => {
        warn!(run_id = %run.id, %error, "stale-run scope invalid");
        continue;
      }
    };
    let repository_guard = match PgGitSyncRepositoryCoordination::new(pool.clone()).acquire(&scope).await {
      Ok(guard) => GitSyncNativeOwnership::new(guard),
      Err(error) => {
        warn!(run_id = %run.id, %error, "stale-run branch is unavailable for inspection");
        continue;
      }
    };
    let profile_guard = match locking::acquire(&stale_locks, run.profile_id, &config.lock_redis, inspection_lock_ttl)
      .await
    {
      Ok(guard) => guard,
      Err(SyncError::AlreadySyncing(_)) => {
        debug!(run_id = %run.id, profile_id = %run.profile_id, "stale-run inspection skipped because another server owns the profile lock");
        continue;
      }
      Err(error) => {
        warn!(run_id = %run.id, profile_id = %run.profile_id, %error, "stale-run inspection skipped because distributed lock state is unavailable");
        continue;
      }
    };
    let mirror_guard = match acquire_profile_mirror(&config.repo_base_dir, run.profile_id).await {
      Ok(guard) => Arc::new(guard),
      Err(MirrorLockError::Busy) => {
        debug!(run_id = %run.id, profile_id = %run.profile_id, "stale-run inspection skipped because native mirror work is still active");
        continue;
      }
      Err(error) => {
        warn!(run_id = %run.id, profile_id = %run.profile_id, %error, "stale-run inspection skipped because physical mirror ownership cannot be verified");
        continue;
      }
    };

    let classification = reconcile_one_stale_running_run(
      &store,
      pool,
      config,
      &run,
      job_id,
      ssh_host_key_policy,
      https_certificate_policy,
      allowed_hosts.clone(),
      &profile_guard,
      mirror_guard,
      &scope,
      initial_profile.scope_revision,
      &repository_guard,
    )
    .await;
    if let Err(error) = classification {
      warn!(run_id = %run.id, profile_id = %run.profile_id, %error, "stale Git-Sync run remains for operator reconciliation");
    }
  }
  recover_blob_promotions(&store, blob_storage, cutoff).await;
}

async fn recover_blob_promotions(
  store: &SqlxGitSyncStore,
  blob_storage: &dyn BlobStoragePort,
  older_than: chrono::DateTime<chrono::Utc>,
) {
  let promotions = match store.list_recoverable_blob_promotions(older_than, 100).await {
    Ok(promotions) => promotions,
    Err(error) => {
      warn!(%error, "could not inspect durable Git-Sync blob promotions");
      return;
    }
  };
  for promotion in promotions {
    let mut cleanup_failed = false;
    if let Err(error) = blob_storage.delete_blob(&promotion.stage_key).await {
      warn!(
        promotion_id = %promotion.id,
        stage_key = %promotion.stage_key,
        %error,
        "failed to recover Git-Sync blob stage"
      );
      cleanup_failed = true;
    }
    if !promotion.db_committed && promotion.newly_promoted == Some(true) {
      if let Err(error) = store
        .cleanup_unreferenced_blob_object(blob_storage, &promotion.final_key)
        .await
      {
        warn!(promotion_id=%promotion.id,%error,"failed to recover uncommitted Git-Sync object");
        cleanup_failed = true;
      }
    }

    if !cleanup_failed && let Err(error) = store.delete_blob_promotion_records(&[promotion.id]).await {
      warn!(promotion_id = %promotion.id, %error, "failed to remove recovered blob promotion ledger");
    }
  }
}

#[allow(clippy::too_many_arguments)]
async fn reconcile_one_stale_running_run(
  store: &SqlxGitSyncStore,
  pool: &PgPool,
  config: &RunnerConfig,
  run: &myoxus_domain::git_sync::GitSyncRun,
  job_id: &str,
  ssh_host_key_policy: myoxus_application::git_sync::backend::SshHostKeyPolicy,
  https_certificate_policy: myoxus_application::git_sync::backend::HttpsCertificatePolicy,
  allowed_hosts: Vec<String>,
  profile_guard: &locking::ProfileLockGuard,
  mirror_guard: Arc<myoxus_infrastructure::git_sync::MirrorDirectoryGuard>,
  scope: &GitSyncRepositoryScope,
  scope_revision: i64,
  repository_guard: &Arc<GitSyncNativeOwnership>,
) -> Result<(), SyncError> {
  let profile = store.get_profile(run.profile_id).await.map_err(|error| {
    SyncError::permanent(
      format!("load stale-run profile: {error}"),
      run.profile_id,
      "stale_run_reconciliation",
    )
  })?;
  if !scope.matches(&profile.repo_url, &profile.branch) || profile.scope_revision != scope_revision {
    return Err(SyncError::permanent(
      "stale-run branch changed before inspection",
      run.profile_id,
      "stale_run_reconciliation",
    ));
  }
  let credential_id = profile.credential_id.ok_or_else(|| {
    SyncError::permanent(
      "stale-run profile has no credential",
      run.profile_id,
      "stale_run_reconciliation",
    )
  })?;
  let encrypted = store
    .get_credential_encrypted_data(credential_id)
    .await
    .map_err(|error| {
      SyncError::permanent(
        format!("load stale-run credential: {error}"),
        run.profile_id,
        "stale_run_reconciliation",
      )
    })?;
  let credential_json = credential::decrypt(&config.crypto_key, &encrypted)?;
  let auth = credential::build_auth(run.profile_id, profile.auth_method, &credential_json)?;
  let git_repo = Git2Adapter::with_config(
    config.network_timeout_secs,
    config.local_timeout_secs,
    config.clone_depth,
  )
  .with_ssh_host_key_policy(pool.clone(), ssh_host_key_policy, "stale_run_reconciliation", None)
  .with_https_certificate_policy(https_certificate_policy, allowed_hosts);
  let operation_guard: Arc<dyn GitOperationGuard> = Arc::new(RunnerOperationOwnership {
    _mirror: mirror_guard,
    _repository: Arc::clone(repository_guard),
  });
  git_repo
    .retain_operation_guard(operation_guard)
    .await
    .map_err(|error| {
      SyncError::from_git_error(error, "retain stale-run mirror ownership", "stale_run_reconciliation")
    })?;
  let max_storage_mb = match profile.max_mirror_storage_mb {
    Some(limit) if limit >= 0 => limit as u64,
    Some(limit) => {
      return Err(SyncError::permanent(
        format!("invalid max_mirror_storage_mb override: {limit}"),
        profile.id,
        "stale_run_reconciliation",
      ));
    }
    None => config.max_mirror_storage_mb,
  };
  let ensure_owned = |phase| profile_guard.ensure_owned(phase);
  let remote_oid = repo::prepare_remote_observation(
    &git_repo,
    &profile,
    &auth,
    &config.repo_base_dir,
    repo::MirrorMaterializationContext {
      attempt_id: run.id,
      max_storage_mb,
      min_free_disk_mb: config.min_free_disk_mb,
    },
    &ensure_owned,
  )
  .await?;
  profile_guard.ensure_owned("stale_run_reconciliation")?;
  repository_guard
    .ensure_owned()
    .await
    .map_err(|error| repository_guard_error(error, run.profile_id))?;
  let source_unchanged = run.commit_before.as_deref() == Some(remote_oid.as_str());
  let reason = if source_unchanged {
    "stale Running run recovered at startup; authenticated remote remained at the recorded source revision"
  } else {
    "stale Running run recovered at startup; authenticated remote differs from or cannot be compared with the recorded source revision"
  };
  let updated = if source_unchanged {
    store
      .fail_stale_running_run_without_remote_change(run.id, run.profile_id, job_id, &remote_oid, reason)
      .await
  } else {
    store
      .mark_reconciliation_required(run, job_id, &remote_oid, reason)
      .await
  }
  .map_err(|error| {
    SyncError::permanent(
      format!("persist stale-run classification: {error}"),
      run.profile_id,
      "stale_run_reconciliation",
    )
  })?;
  if !updated {
    return Err(SyncError::permanent(
      "stale run changed while startup reconciliation was in progress",
      run.profile_id,
      "stale_run_reconciliation",
    ));
  }
  repository_guard
    .ensure_owned()
    .await
    .map_err(|error| repository_guard_error(error, run.profile_id))?;
  warn!(
    run_id = %run.id,
    profile_id = %run.profile_id,
    %remote_oid,
    reconciliation_required = !source_unchanged,
    "stale Git-Sync run classified"
  );
  Ok(())
}

/// Execute a complete sync run.
///
/// This is the single entry point called by the `GitSyncQueueHandler`.
/// It orchestrates the full lifecycle: lock → load → reconcile → execute → persist.
///
/// # Returns
///
/// - `Ok(json)` only after verified remote truth and atomic finalization
/// - `Err(SyncError)` on fatal errors that should trigger a worker retry
#[instrument(skip(pool, config, locks, blob_storage), fields(%profile_id, %run_id))]
#[expect(
  clippy::too_many_arguments,
  reason = "the sync runner exposes its mandatory runtime capabilities and trigger context"
)]
pub async fn run_sync(
  pool: &PgPool,
  config: &RunnerConfig,
  locks: &locking::ProfileLocks,
  blob_storage: &dyn BlobStoragePort,
  profile_id: Uuid,
  run_id: Uuid,
  queue_job_id: &str,
  direction: SyncDirection,
  trigger_source: GitSyncRunSource,
) -> Result<serde_json::Value, SyncError> {
  // Queue delivery may outlive terminal SQL history. A missing durable intent
  // is a no-op, never permission to reconstruct work or touch the repository.
  match SqlxGitSyncStore::new(pool.clone()).get_run(run_id).await {
    Ok(_) => {}
    Err(myoxus_infrastructure::git_sync::GitSyncStoreError::NotFound) => {
      return Ok(serde_json::json!({"runId":run_id,"status":"Skipped","reason":"run_missing"}));
    }
    Err(error) => {
      return Err(SyncError::database(
        format!("load durable run intent: {error}"),
        "run_admission",
      ));
    }
  }
  let effective_policy = config.effective_policy().await.ok();
  let ssh_host_key_policy = effective_policy
    .as_ref()
    .map(|policy| policy.ssh_host_key_policy)
    .unwrap_or(config.static_policy.ssh_host_key_policy);
  let https_certificate_policy = effective_policy
    .as_ref()
    .map(|policy| policy.https_certificate_policy)
    .unwrap_or(config.static_policy.https_certificate_policy);
  let allowed_hosts = effective_policy
    .map(|policy| policy.allowed_hosts.into_iter().collect::<Vec<_>>())
    .unwrap_or_else(|| config.static_policy.allowed_hosts.clone());
  let git_repo = Git2Adapter::with_config(
    config.network_timeout_secs,
    config.local_timeout_secs,
    config.clone_depth,
  )
  .with_ssh_host_key_policy(pool.clone(), ssh_host_key_policy, "sync_run", None)
  .with_https_certificate_policy(https_certificate_policy, allowed_hosts);

  run_sync_with_git_repo_admission(
    pool,
    config,
    locks,
    blob_storage,
    &git_repo,
    profile_id,
    run_id,
    queue_job_id,
    direction,
    trigger_source,
  )
  .await
}

/// Execute a sync run using an injected Git backend.
///
/// Production calls [`run_sync`], which wires the single supported
/// [`Git2Adapter`]. Tests use this seam to exercise the full runner without
/// weakening production URL validation or introducing local `file://` profiles.
#[doc(hidden)]
#[instrument(skip(pool, config, locks, blob_storage, git_repo), fields(%profile_id, %run_id))]
pub async fn run_sync_with_git_repo(
  pool: &PgPool,
  config: &RunnerConfig,
  locks: &locking::ProfileLocks,
  blob_storage: &dyn BlobStoragePort,
  git_repo: &dyn GitRepositoryPort,
  profile_id: Uuid,
  run_id: Uuid,
) -> Result<serde_json::Value, SyncError> {
  let store = SqlxGitSyncStore::new(pool.clone());
  let run = store
    .get_run(run_id)
    .await
    .map_err(|error| SyncError::permanent(format!("load run admission: {error}"), profile_id, "run_admission"))?;
  let job_id = run
    .job_id
    .clone()
    .ok_or_else(|| SyncError::permanent("run has no persisted queue job id", profile_id, "run_admission"))?;
  run_sync_with_git_repo_admission(
    pool,
    config,
    locks,
    blob_storage,
    git_repo,
    profile_id,
    run_id,
    &job_id,
    run.direction,
    run.trigger_source,
  )
  .await
}

#[allow(clippy::too_many_arguments)]
async fn run_sync_with_git_repo_admission(
  pool: &PgPool,
  config: &RunnerConfig,
  locks: &locking::ProfileLocks,
  blob_storage: &dyn BlobStoragePort,
  git_repo: &dyn GitRepositoryPort,
  profile_id: Uuid,
  run_id: Uuid,
  queue_job_id: &str,
  direction: SyncDirection,
  trigger_source: GitSyncRunSource,
) -> Result<serde_json::Value, SyncError> {
  let store = SqlxGitSyncStore::new(pool.clone());
  let initial_profile = store.get_profile(profile_id).await.map_err(|error| {
    SyncError::permanent(
      format!("load repository scope: {error}"),
      profile_id,
      "repository_guard",
    )
  })?;
  let scope = GitSyncRepositoryScope::new(&initial_profile.repo_url, &initial_profile.branch)
    .map_err(|error| repository_guard_error(error, profile_id))?;
  let coordinator = PgGitSyncRepositoryCoordination::new(pool.clone());
  let repository_guard = coordinator
    .acquire(&scope)
    .await
    .map_err(|error| repository_guard_error(error, profile_id))?;
  let repository_guard = GitSyncNativeOwnership::new(repository_guard);
  let result = run_sync_with_repository_guard(
    pool,
    config,
    locks,
    blob_storage,
    git_repo,
    profile_id,
    run_id,
    queue_job_id,
    direction,
    trigger_source,
    &scope,
    initial_profile.scope_revision,
    &repository_guard,
  )
  .await;
  if result.is_ok() {
    repository_guard
      .ensure_owned()
      .await
      .map_err(|error| repository_guard_error(error, profile_id))?;
  }
  result
}

#[allow(clippy::too_many_arguments)]
async fn run_sync_with_repository_guard(
  pool: &PgPool,
  config: &RunnerConfig,
  locks: &locking::ProfileLocks,
  blob_storage: &dyn BlobStoragePort,
  git_repo: &dyn GitRepositoryPort,
  profile_id: Uuid,
  run_id: Uuid,
  queue_job_id: &str,
  direction: SyncDirection,
  trigger_source: GitSyncRunSource,
  scope: &GitSyncRepositoryScope,
  scope_revision: i64,
  repository_guard: &Arc<GitSyncNativeOwnership>,
) -> Result<serde_json::Value, SyncError> {
  // 1. Acquire the mandatory distributed profile lock before any local or
  //    durable side effect. ROB-26 keeps the TTL operator-configurable.
  let lock_guard = locking::acquire(locks, profile_id, &config.lock_redis, config.lock_ttl_seconds).await?;
  let mirror_guard = Arc::new(
    acquire_profile_mirror(&config.repo_base_dir, profile_id)
      .await
      .map_err(|error| mirror_lock_error(error, profile_id, "acquire_mirror_lock"))?,
  );
  let operation_guard: Arc<dyn GitOperationGuard> = Arc::new(RunnerOperationOwnership {
    _mirror: mirror_guard,
    _repository: Arc::clone(repository_guard),
  });
  git_repo
    .retain_operation_guard(operation_guard)
    .await
    .map_err(|error| SyncError::from_git_error(error, "retain native mirror ownership", "acquire_mirror_lock"))?;

  let store = SqlxGitSyncStore::new(pool.clone());

  // 2. Atomically claim the exact durable intent before profile credentials,
  // repository state, bindings, blobs, or Git I/O are touched.
  let Some(mut run) = store
    .claim_pending_run(run_id, profile_id, direction, trigger_source, queue_job_id)
    .await
    .map_err(|error| SyncError::permanent(format!("claim run: {error}"), profile_id, "run_admission"))?
  else {
    return Err(SyncError::permanent(
      "Git-Sync run is terminal, stale, disabled, or no longer matches profile policy",
      profile_id,
      "run_admission",
    ));
  };

  // 3. Load profile after admission.
  let profile = match store.get_profile(profile_id).await {
    Ok(profile) => profile,
    Err(store_error) => {
      let error = SyncError::permanent(format!("load profile: {store_error}"), profile_id, "load_profile");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };

  if !scope.matches(&profile.repo_url, &profile.branch) || profile.scope_revision != scope_revision {
    let error = SyncError::permanent(
      "Git-Sync repository scope changed while acquiring ownership",
      profile_id,
      "repository_guard",
    );
    persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
    return Err(error);
  }

  if let Err(cause) = store.assert_profile_scope_unambiguous(&profile).await {
    let error = SyncError::permanent(
      format!("Git-Sync scope preflight: {cause}"),
      profile_id,
      "scope_preflight",
    );
    persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
    return Err(error);
  }
  let binding_preflight = match store.assert_bound_documents_in_workspace(&profile).await {
    Ok(()) => store.assert_bound_files_in_workspace(&profile).await,
    Err(cause) => Err(cause),
  };
  if let Err(cause) = binding_preflight {
    let error = SyncError::permanent(
      format!("Git-Sync binding preflight: {cause}"),
      profile_id,
      "scope_preflight",
    );
    persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
    return Err(error);
  }
  let writer_scope = match store.writer_scope(&profile).await {
    Ok(scope) => scope,
    Err(cause) => {
      let error = SyncError::permanent(
        format!("Git-Sync scope inventory: {cause}"),
        profile_id,
        "scope_preflight",
      );
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };

  // Workspace membership remains the concrete document-access boundary for
  // Git-Sync. Organization/manager roles can govern configuration elsewhere,
  // but they do not authorize a runner to mutate this workspace after the
  // profile owner lost accepted membership.
  let has_access = store
    .owner_has_active_workspace_access(profile.owner_id, profile.workspace_id)
    .await
    .unwrap_or(false);

  if !has_access {
    let msg = format!(
      "profile owner {} no longer has workspace access (workspace {})",
      profile.owner_id, profile.workspace_id
    );
    warn!(profile_id = %profile_id, owner_id = %profile.owner_id, workspace_id = %profile.workspace_id, "membership check failed");
    persist::finalize_run(
      &store,
      &mut run,
      0,
      0,
      0,
      0,
      None,
      Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::InternalError)),
    )
    .await?;
    return Err(SyncError::permanent(msg, profile_id, "membership_check"));
  }

  let policy = match config.effective_policy().await {
    Ok(policy) => policy,
    Err(msg) => {
      persist::finalize_run(
        &store,
        &mut run,
        0,
        0,
        0,
        0,
        None,
        Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::InternalError)),
      )
      .await?;
      return Err(SyncError::permanent(msg, profile_id, "load_policy"));
    }
  };
  if let Some(msg) = policy.profile_violation(&profile) {
    warn!(profile_id = %profile_id, reason = %msg, "git-sync runner blocked by current policy");
    persist::finalize_run(
      &store,
      &mut run,
      0,
      0,
      0,
      0,
      None,
      Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::InternalError)),
    )
    .await?;
    return Err(SyncError::permanent(msg, profile_id, "validate_policy"));
  }
  if trigger_source == GitSyncRunSource::HistoryCapture
    && (!policy.auto_sync_allowed || !policy.is_sync_direction_allowed(run.direction))
  {
    let msg = "history capture sync is not allowed by current automatic-sync policy".to_string();
    persist::finalize_run(
      &store,
      &mut run,
      0,
      0,
      0,
      0,
      None,
      Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::InternalError)),
    )
    .await?;
    return Err(SyncError::permanent(msg, profile_id, "validate_policy"));
  }

  // 4. Load + decrypt credentials
  let Some(credential_id) = profile.credential_id else {
    let msg = "profile has no credential configured".to_string();
    persist::finalize_run(
      &store,
      &mut run,
      0,
      0,
      0,
      0,
      None,
      Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::GitAuth)),
    )
    .await?;
    return Err(SyncError::permanent(msg, profile_id, "load_credential"));
  };

  // P50-C-01: Check credential expiry before decryption
  let cred_ref = match store.get_credential(credential_id).await {
    Ok(cred_ref) => cred_ref,
    Err(e) => {
      let msg = format!("load credential ref: {e}");
      persist::finalize_run(
        &store,
        &mut run,
        0,
        0,
        0,
        0,
        None,
        Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::GitAuth)),
      )
      .await?;
      return Err(SyncError::permanent(msg, profile_id, "load_credential"));
    }
  };
  if cred_ref.is_expired() {
    let msg = format!(
      "credentials expired at {} — please rotate credentials to resume syncing",
      cred_ref.expires_at.expect("is_expired() guarantees expires_at is Some")
    );
    warn!(profile_id = %profile_id, credential_id = %credential_id, "credential expired, refusing to sync");
    persist::finalize_run(
      &store,
      &mut run,
      0,
      0,
      0,
      0,
      None,
      Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::GitAuth)),
    )
    .await?;
    return Err(SyncError::permanent(msg, profile_id, "credential_expiry_check"));
  }
  if cred_ref.expires_within(chrono::Duration::days(7)) {
    warn!(
      profile_id = %profile_id,
      credential_id = %credential_id,
      expires_at = ?cred_ref.expires_at,
      "credential expires within 7 days — consider rotating"
    );
  }

  let encrypted = match store.get_credential_encrypted_data(credential_id).await {
    Ok(encrypted) => encrypted,
    Err(e) => {
      let msg = format!("load credential: {e}");
      persist::finalize_run(
        &store,
        &mut run,
        0,
        0,
        0,
        0,
        None,
        Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::GitAuth)),
      )
      .await?;
      return Err(SyncError::permanent(msg, profile_id, "load_credential"));
    }
  };
  let cred_json = match credential::decrypt(&config.crypto_key, &encrypted) {
    Ok(cred_json) => cred_json,
    Err(e) => {
      let msg = e.to_string();
      persist::finalize_run(
        &store,
        &mut run,
        0,
        0,
        0,
        0,
        None,
        Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::GitAuth)),
      )
      .await?;
      return Err(e);
    }
  };
  // ROB-25: build_auth now validates required fields and returns
  // Permanent on missing/empty token/password/privateKey instead of
  // silently producing a GitAuth with empty credentials.
  let auth = match credential::build_auth(profile_id, profile.auth_method, &cred_json) {
    Ok(auth) => auth,
    Err(e) => {
      let msg = e.to_string();
      persist::finalize_run(
        &store,
        &mut run,
        0,
        0,
        0,
        0,
        None,
        Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::GitAuth)),
      )
      .await?;
      return Err(e);
    }
  };

  // 5. Validate profile inputs (defense-in-depth, ROB-09)
  if !profile.repo_url.starts_with("https://")
    && !profile.repo_url.starts_with("ssh://")
    && !profile.repo_url.starts_with("git@")
  {
    let msg = format!(
      "invalid repo URL scheme: {} — only https://, ssh://, and git@ are allowed",
      profile.repo_url
    );
    persist::finalize_run(
      &store,
      &mut run,
      0,
      0,
      0,
      0,
      None,
      Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::InternalError)),
    )
    .await?;
    return Err(SyncError::permanent(msg, profile_id, "validate_profile"));
  }
  if profile.root_path.starts_with('/') || profile.root_path.contains("..") || profile.root_path.contains('\0') {
    let msg = format!(
      "invalid root_path: '{}' — must be relative, no traversal",
      profile.root_path
    );
    persist::finalize_run(
      &store,
      &mut run,
      0,
      0,
      0,
      0,
      None,
      Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::InternalError)),
    )
    .await?;
    return Err(SyncError::permanent(msg, profile_id, "validate_profile"));
  }
  if profile.branch.contains("..") || profile.branch.contains('\0') || profile.branch.contains(' ') {
    let msg = format!(
      "invalid branch name: '{}' — contains prohibited characters",
      profile.branch
    );
    persist::finalize_run(
      &store,
      &mut run,
      0,
      0,
      0,
      0,
      None,
      Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::InternalError)),
    )
    .await?;
    return Err(SyncError::permanent(msg, profile_id, "validate_profile"));
  }

  // UF-03/GSH-06A: Disk limits are operational safety rails, not product quotas.
  // Per-profile settings intentionally override the global guard so an admin
  // can give one large mirror a higher/lower technical limit without changing
  // business entitlements.
  let effective_mirror_limit_mb: u64 = match profile.max_mirror_storage_mb {
    Some(limit) if limit >= 0 => limit as u64,
    Some(limit) => {
      let msg = format!("invalid max_mirror_storage_mb override: {limit}");
      persist::finalize_run(
        &store,
        &mut run,
        0,
        0,
        0,
        0,
        None,
        Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::InternalError)),
      )
      .await?;
      return Err(SyncError::permanent(msg, profile_id, "disk_preflight"));
    }
    None => config.max_mirror_storage_mb,
  };
  trace!(
    effective_mirror_limit_mb,
    profile_override = ?profile.max_mirror_storage_mb,
    global_limit_mb = config.max_mirror_storage_mb,
    "resolved effective mirror storage limit"
  );

  // 6. Prepare Git working tree (clone/fetch/checkout)
  let repo_dir = repo::repo_dir(&config.repo_base_dir, profile_id);
  if let Err(msg) = disk::preflight_check(
    &config.repo_base_dir,
    effective_mirror_limit_mb,
    config.min_free_disk_mb,
  )
  .await
  {
    warn!(profile_id = %profile_id, error = %msg, "git-sync disk preflight blocked run before git I/O");
    persist::finalize_run(
      &store,
      &mut run,
      0,
      0,
      0,
      0,
      None,
      Some((msg.clone(), myoxus_domain::git_sync::ErrorClass::InternalError)),
    )
    .await?;
    return Err(SyncError::permanent(msg, profile_id, "disk_preflight"));
  }

  repository_guard
    .ensure_owned()
    .await
    .map_err(|error| repository_guard_error(error, profile_id))?;
  let ensure_owned = |phase| lock_guard.ensure_owned(phase);
  let prepared = match repo::prepare(
    git_repo,
    &profile,
    &auth,
    &config.repo_base_dir,
    Some(repo::MirrorMaterializationContext {
      attempt_id: run_id,
      max_storage_mb: effective_mirror_limit_mb,
      min_free_disk_mb: config.min_free_disk_mb,
    }),
    &ensure_owned,
  )
  .await
  {
    Ok(prepared) => prepared,
    Err(error) => {
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  let source_local_oid = match git_repo.head_oid().await {
    Ok(oid) => oid,
    Err(error) => {
      let error = SyncError::from_git_error(error, "read prepared local HEAD", "observe_source_revision");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  let source_remote_oid = prepared.source_remote_oid;
  if source_local_oid != source_remote_oid {
    let error = SyncError::Retryable {
      message: format!(
        "prepared local HEAD {source_local_oid} does not match remote branch {} at {source_remote_oid}",
        profile.branch
      ),
      profile_id,
      phase: "observe_source_revision",
    };
    persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
    return Err(error);
  }
  match store
    .record_running_source_oid(run_id, queue_job_id, &source_remote_oid)
    .await
  {
    Ok(true) => run.commit_before = Some(source_remote_oid.clone()),
    Ok(false) => {
      let error = SyncError::permanent(
        "running Git-Sync admission changed before source revision could be recorded",
        profile_id,
        "record_source_revision",
      );
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
    Err(store_error) => {
      let error = SyncError::permanent(
        format!("record Git-Sync source revision: {store_error}"),
        profile_id,
        "record_source_revision",
      );
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  }

  // 6. Load states from DB and Git working tree
  let open_partial_before_load = match store.get_open_partial_session(profile_id).await {
    Ok(session) => session,
    Err(store_error) => {
      let error = SyncError::permanent(
        format!("load partial session: {store_error}"),
        profile_id,
        "partial_session",
      );
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  // PERF-01: Find last SUCCESSFUL sync for delta-tracking.
  // Load last 10 runs (not 1!) because the most recent run is the CURRENT one (Pending/Running).
  // We need to find the most recent Completed run before this one.
  let previous_runs = match store.get_runs_by_profile(profile_id, 10).await {
    Ok(runs) => runs,
    Err(store_error) => {
      let error = SyncError::database(format!("load previous Git-Sync runs: {store_error}"), "load_state");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  let last_completed = previous_runs
    .iter()
    .find(|r| r.id != run_id && r.status == myoxus_domain::git_sync::RunStatus::Completed);
  let last_sync = if open_partial_before_load.is_some() {
    None
  } else {
    last_completed.map(|r| r.started_at)
  };
  let last_commit_oid = if open_partial_before_load.is_some() {
    None
  } else {
    last_completed.and_then(|r| r.commit_after.clone())
  };
  if let Some(ts) = last_sync {
    debug!(last_sync = %ts, last_oid = ?last_commit_oid, "delta-tracking: using previous successful run");
  } else if let Some(session) = &open_partial_before_load {
    debug!(session_id = %session.id, "partial session open — loading full state for stable pending work");
  } else {
    debug!("no previous successful run — full sync");
  }

  let normalized_root = profile.root_path.trim().trim_matches('/');
  let configured_root = if normalized_root.is_empty() {
    repo_dir.clone()
  } else {
    repo_dir.join(normalized_root)
  };
  if !configured_root.exists() {
    let manifest_exists = git_repo.read_file(&profile.manifest_path).await.is_ok();
    if last_completed.is_some() || manifest_exists {
      let error = SyncError::permanent(
        format!(
          "established Git-Sync root `{}` is missing from the checked-out branch",
          profile.root_path
        ),
        profile_id,
        "missing_root",
      );
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
    if let Err(io_error) = tokio::fs::create_dir_all(&configured_root).await {
      let error = SyncError::permanent(
        format!("create initial Git-Sync root `{}`: {io_error}", profile.root_path),
        profile_id,
        "initial_root",
      );
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
    info!(root_path = %profile.root_path, "created empty initial Git-Sync root");
  }

  let load_result = match loader::load_myoxus_docs_since(
    pool,
    profile.workspace_id,
    last_sync,
    config.parallel_conversion_threshold,
  )
  .await
  {
    Ok(result) => result,
    Err(error) => {
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  let mut myoxus_docs = load_result.docs;
  if load_result.conversion_failures > 0 {
    let error = SyncError::permanent(
      format!(
        "{} document conversion(s) failed before Git mutation: {:?}",
        load_result.conversion_failures, load_result.failed_doc_ids
      ),
      profile_id,
      "document_projection",
    );
    persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
    return Err(error);
  }
  // PERF-07: Check memory limit
  if config.max_docs_per_sync > 0 && load_result.total_docs_in_workspace as usize > config.max_docs_per_sync {
    warn!(
      total = load_result.total_docs_in_workspace,
      limit = config.max_docs_per_sync,
      "workspace exceeds max_docs_per_sync — sync will be partial"
    );
  }

  // Reconciliation requires the complete current Git side. A commit delta is
  // not current state: omitted unchanged paths would look deleted.

  // 7. Load existing bindings + baselines
  let bindings = match store.get_bindings_by_profile(profile_id).await {
    Ok(bindings) => bindings,
    Err(store_error) => {
      let error = SyncError::database(format!("load document bindings: {store_error}"), "load_state");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  let mut file_bindings = match store.get_file_bindings_by_profile_for_view(profile_id, true).await {
    Ok(bindings) => bindings,
    Err(store_error) => {
      let error = SyncError::database(format!("load file bindings: {store_error}"), "path_preflight");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  for path in bindings.iter().map(|binding| binding.repo_path.as_str()).chain(
    file_bindings
      .iter()
      .filter(|binding| !binding.tombstoned)
      .map(|binding| binding.repo_path.as_str()),
  ) {
    if writer_scope
      .excludes(path)
      .map_err(|error| SyncError::permanent(error.to_string(), profile_id, "scope_preflight"))?
    {
      let error = SyncError::permanent(
        "active Git-Sync binding enters a delegated repository scope",
        profile_id,
        "scope_preflight",
      );
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  }
  // Disconnect keeps tombstones for history, not as instructions to delete
  // still-present files in the excluded subtree on the next source run.
  file_bindings = file_bindings
    .into_iter()
    .filter_map(|binding| {
      if !binding.tombstoned {
        return Some(Ok(binding));
      }
      match writer_scope.excludes(&binding.repo_path) {
        Ok(false) => Some(Ok(binding)),
        Ok(true) => None,
        Err(error) => Some(Err(SyncError::permanent(
          error.to_string(),
          profile_id,
          "scope_preflight",
        ))),
      }
    })
    .collect::<Result<Vec<_>, _>>()?;
  let previous_manifest = match git_repo.read_file(&profile.manifest_path).await {
    Ok(bytes) => Some(bytes),
    Err(myoxus_application::git_sync::backend::GitError::NotFound(_)) => None,
    Err(cause) => {
      let error = SyncError::from_git_error(cause, "read overview ownership", "overview_preflight");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  let previous_manifest = match previous_manifest
    .map(|bytes| {
      serde_json::from_slice::<GitSyncManifest>(&bytes)
        .map_err(|error| format!("invalid overview manifest JSON at {}:{}", error.line(), error.column()))
    })
    .transpose()
  {
    Ok(manifest) => manifest,
    Err(message) => {
      let error = SyncError::permanent(message, profile_id, "overview_preflight");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  let previous_manifest = match previous_manifest
    .map(|manifest| {
      writer_scope
        .owned_manifest(&manifest)
        .map_err(|error| error.to_string())
    })
    .transpose()
  {
    Ok(manifest) => manifest,
    Err(message) => {
      let error = SyncError::permanent(message, profile_id, "scope_preflight");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  let ordinary_paths = bindings
    .iter()
    .map(|binding| binding.repo_path.clone())
    .chain(
      file_bindings
        .iter()
        .filter(|binding| !binding.tombstoned)
        .map(|binding| binding.repo_path.clone()),
    )
    .collect::<Vec<_>>();
  // Classify before parsing/reserving ordinary identities. The previous
  // manifest remains the sole ownership source even for edited/missing outputs.
  let git_files = match loader::load_git_files(
    &repo_dir,
    &profile.root_path,
    previous_manifest.as_ref(),
    profile.workspace_id,
    &ordinary_paths,
    &writer_scope,
  ) {
    Ok(files) => files,
    Err(message) => {
      let error = SyncError::permanent(message, profile_id, "overview_preflight");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  let baseline_rows = match store.get_baselines_by_profile(profile_id).await {
    Ok(baselines) => baselines,
    Err(store_error) => {
      let error = SyncError::database(format!("load document baselines: {store_error}"), "load_state");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  let baselines: Vec<(BindingId, BaselineState)> = baseline_rows
    .into_iter()
    .map(|bl| {
      (
        bl.binding_id,
        BaselineState {
          content_hash: bl.content_hash,
        },
      )
    })
    .collect();
  info!(
    bindings = bindings.len(),
    file_bindings = file_bindings.len(),
    baselines = baselines.len(),
    "loaded bindings + baselines"
  );

  // Allocate the complete outbound document set before any worktree write.
  // File bindings and unbound Git Markdown paths participate as occupied
  // owners so a document can never overwrite another synchronized object.
  let binding_by_doc: std::collections::HashMap<Uuid, &myoxus_domain::git_sync::GitSyncBinding> =
    bindings.iter().map(|binding| (binding.doc_id, binding)).collect();
  let mut occupied_paths = std::collections::BTreeMap::new();
  for binding in file_bindings.iter().filter(|binding| !binding.tombstoned) {
    if let Some(previous) = occupied_paths.insert(binding.repo_path.clone(), format!("file:{}", binding.id)) {
      let error = SyncError::permanent(
        format!(
          "duplicate active repository path `{}` owned by {previous} and file:{}",
          binding.repo_path, binding.id
        ),
        profile_id,
        "path_preflight",
      );
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  }
  let bound_document_paths: HashSet<&str> = bindings.iter().map(|binding| binding.repo_path.as_str()).collect();
  for (repo_path, _) in &git_files {
    if !bound_document_paths.contains(repo_path.as_str()) {
      occupied_paths
        .entry(repo_path.clone())
        .or_insert_with(|| "unbound-git-document".to_string());
    }
  }
  let path_inputs: Vec<PathPlanDocument> = myoxus_docs
    .iter()
    .map(|doc| PathPlanDocument {
      doc_id: doc.doc_id,
      title: doc.title.clone(),
      folder_names: doc.folder_path.clone(),
      existing_repo_path: binding_by_doc.get(&doc.doc_id).map(|binding| binding.repo_path.clone()),
    })
    .collect();
  let planned_paths = match export::plan_document_paths(&profile.root_path, &path_inputs, &occupied_paths) {
    Ok(paths) => export::paths_by_document(&paths),
    Err(path_error) => {
      let error = SyncError::permanent(path_error.to_string(), profile_id, "path_preflight");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  for path in planned_paths.values() {
    if writer_scope
      .excludes(path)
      .map_err(|error| SyncError::permanent(error.to_string(), profile_id, "path_preflight"))?
    {
      let error = SyncError::permanent(
        "planned Git-Sync document enters a delegated repository scope",
        profile_id,
        "path_preflight",
      );
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  }
  let active_doc_ids: HashSet<Uuid> = myoxus_docs.iter().map(|doc| doc.doc_id).collect();
  let mut path_reservations: Vec<(Uuid, String)> = planned_paths
    .iter()
    .map(|(doc_id, repo_path)| (*doc_id, repo_path.clone()))
    .collect();
  path_reservations.extend(
    bindings
      .iter()
      .filter(|binding| !active_doc_ids.contains(&binding.doc_id))
      .map(|binding| (binding.doc_id, binding.repo_path.clone())),
  );
  if matches!(run.direction, SyncDirection::Bidirectional | SyncDirection::MyoxusToGit)
    && let Err(reservation_error) = store
      .validate_document_paths_available(profile_id, &path_reservations)
      .await
  {
    let error = SyncError::permanent(
      format!("reserve outbound repository paths: {reservation_error}"),
      profile_id,
      "path_preflight",
    );
    persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
    return Err(error);
  }
  for doc in &mut myoxus_docs {
    doc.planned_repo_path = planned_paths.get(&doc.doc_id).cloned();
  }
  let binding_by_id = bindings
    .iter()
    .map(|binding| (binding.id, binding.doc_id))
    .collect::<std::collections::HashMap<_, _>>();
  let baseline_doc_ids = baselines
    .iter()
    .filter_map(|(binding_id, _)| binding_by_id.get(binding_id).copied())
    .collect::<HashSet<_>>();
  let existing_paths = bindings
    .iter()
    .map(|binding| (binding.doc_id, binding.repo_path.clone()))
    .collect::<std::collections::HashMap<_, _>>();
  let projection_since = open_partial_before_load
    .as_ref()
    .and_then(|session| session.source_workspace_watermark)
    .or(last_sync);
  let pending_partial_doc_ids = if let Some(session) = &open_partial_before_load {
    let limit = if config.max_docs_per_sync == 0 {
      usize::MAX
    } else {
      config.max_docs_per_sync
    };
    match store.peek_next_pending_partial_doc_ids(session.id, limit).await {
      Ok(doc_ids) => Some(doc_ids.into_iter().collect::<HashSet<_>>()),
      Err(store_error) => {
        let error = SyncError::permanent(
          format!("preview partial document batch: {store_error}"),
          profile_id,
          "partial_items",
        );
        persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
        return Err(error);
      }
    }
  } else {
    None
  };
  let mut projection_selection = match loader::select_projection_doc_ids(
    pool,
    profile.workspace_id,
    &myoxus_docs,
    &load_result.effective_updated_at,
    projection_since,
    &baseline_doc_ids,
    &existing_paths,
    pending_partial_doc_ids.as_ref(),
  )
  .await
  {
    Ok(selection) => selection,
    Err(error) => {
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  let open_conflict_ids = match store.open_conflict_document_ids(profile_id).await {
    Ok(ids) => ids,
    Err(error) => {
      let error = SyncError::database(format!("load unresolved document projection: {error}"), "load_state");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  // Global run completion is not per-document acknowledgement. Backfilling an
  // unresolved local edit from its old baseline would turn the next Git change
  // into a destructive Pull instead of another observation of the conflict.
  projection_selection
    .doc_ids
    .extend(open_conflict_ids.into_iter().filter(|id| {
      active_doc_ids.contains(id)
        && pending_partial_doc_ids
          .as_ref()
          .is_none_or(|pending| pending.contains(id))
    }));
  debug!(
    selected = projection_selection.doc_ids.len(),
    total = myoxus_docs.len(),
    used_fresh_document_graph = projection_selection.used_fresh_document_graph,
    "selected document payloads for Git projection"
  );
  if let Err(error) = loader::authorize_projection_documents(
    pool,
    profile.workspace_id,
    profile.owner_id,
    &load_result.reference_external_ids.keys().copied().collect(),
  )
  .await
  {
    persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
    return Err(error);
  }
  let (projection_capture, projection_ids) = match loader::capture_myoxus_docs_in_path_plan(
    pool,
    profile.workspace_id,
    &config.server_origin,
    &myoxus_docs,
    &load_result.reference_documents,
    &load_result.reference_external_ids,
    &projection_selection.doc_ids,
  )
  .await
  {
    Ok(captured) => captured,
    Err(error) => {
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  // Plan ordinary file ownership before interpreting image destinations. This
  // uses the existing policy-filtered file plan and performs no blob writes.
  let file_reconcile_result = reconcile_file_pipeline(
    &store,
    pool,
    blob_storage,
    config,
    &profile,
    run.direction,
    &repo_dir,
    &projection_capture,
    &planned_paths,
    &mut file_bindings,
    &writer_scope,
  )
  .await;
  if let Some(error) = file_reconcile_result.error {
    persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
    return Err(error);
  }

  let mut asset_keys_by_path = file_bindings
    .iter()
    .filter(|binding| !binding.tombstoned)
    .map(|binding| (binding.repo_path.clone(), binding.blob_key.clone()))
    .collect::<HashMap<_, _>>();
  for action in &file_reconcile_result.actions {
    match action {
      FileReconcileAction::PushToGit {
        repo_path, blob_key, ..
      } => {
        asset_keys_by_path.insert(repo_path.clone(), blob_key.clone());
      }
      FileReconcileAction::PullToMyoxus {
        repo_path,
        content_hash,
        ..
      } => {
        asset_keys_by_path.insert(
          repo_path.clone(),
          myoxus_application::git_sync::file_reconcile::blob_key_for_content(profile.id, content_hash),
        );
      }
      FileReconcileAction::DeleteFromMyoxus { repo_path, .. }
      | FileReconcileAction::DeleteFromGit { repo_path, .. } => {
        asset_keys_by_path.remove(repo_path);
      }
      _ => {}
    }
  }
  let asset_paths = asset_keys_by_path
    .iter()
    .fold(HashMap::<String, String>::new(), |mut paths, (path, key)| {
      paths
        .entry(key.clone())
        .and_modify(|existing| {
          if path < existing {
            *existing = path.clone();
          }
        })
        .or_insert_with(|| path.clone());
      paths
    });
  let (conversion_failures, failed_doc_ids, projection_metrics, projection_capture) =
    match loader::project_myoxus_docs_in_path_plan(
      &mut myoxus_docs,
      &load_result.reference_external_ids,
      projection_capture,
      &projection_ids,
      config.parallel_conversion_threshold,
      &asset_paths,
    )
    .await
    {
      Ok(result) => result,
      Err(error) => {
        persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
        return Err(error);
      }
    };
  if conversion_failures > 0 {
    let error = SyncError::permanent(
      format!("{conversion_failures} document conversion(s) failed before Git mutation: {failed_doc_ids:?}"),
      profile_id,
      "document_projection",
    );
    persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
    return Err(error);
  }

  // P38-E-04: Pre-build baseline HashMap once for O(1) lookups.
  let baseline_by_binding: std::collections::HashMap<BindingId, &BaselineState> =
    baselines.iter().map(|(bid, bl)| (*bid, bl)).collect();

  // PERF-01 fix: Metadata-only docs (unchanged, no payload loaded) have content_hash: None.
  // The reconcile algorithm would see this as "no content" and might generate false conflicts.
  // Fix: backfill their content_hash from the baseline, so reconcile sees "hash == baseline" → NoChange.
  let baseline_hash_by_doc: std::collections::HashMap<Uuid, String> = bindings
    .iter()
    .filter_map(|b| {
      baseline_by_binding
        .get(&b.id)
        .map(|bl| (b.doc_id, bl.content_hash.clone()))
    })
    .collect();

  for doc in &mut myoxus_docs {
    if doc.markdown.is_none()
      && doc.content_hash.is_none()
      && let Some(hash) = baseline_hash_by_doc.get(&doc.doc_id)
    {
      doc.content_hash = Some(hash.clone());
      trace!(doc_id = %doc.doc_id, "backfilled content_hash from baseline for unchanged doc");
    }
  }

  // 8. Reconcile (pure function)
  let mut sync_result = doc_reconcile_plan::plan_doc_sync_for_direction(
    &profile,
    run.direction,
    &myoxus_docs,
    &bindings,
    &baselines,
    &git_files,
  );
  if matches!(run.direction, SyncDirection::Bidirectional | SyncDirection::MyoxusToGit) {
    for action in &mut sync_result.actions {
      let Some(binding) = binding_by_doc.get(&action.doc_id) else {
        continue;
      };
      let Some(planned_path) = planned_paths.get(&action.doc_id) else {
        continue;
      };
      if binding.repo_path != *planned_path && matches!(action.action, ReconcileAction::NoChange) {
        action.action = ReconcileAction::PushToGit;
      }
    }
  }
  let partial_batch = match partial::prepare_partial_batch(
    &store,
    profile_id,
    run.direction,
    run_id,
    config.max_docs_per_sync,
    load_result.workspace_watermark,
    Some(source_remote_oid.clone()),
    &sync_result.actions,
  )
  .await
  {
    Ok(batch) => batch,
    Err(error) => {
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  let doc_actions = partial::filter_doc_actions_for_partial(&sync_result.actions, &partial_batch);
  let prepared_myoxus_documents = match executor::prepare_myoxus_document_actions(
    pool,
    &doc_actions,
    &git_files,
    &profile,
    &config.server_origin,
    &load_result.reference_documents,
    &load_result.reference_external_ids,
    &bindings,
    &planned_paths,
    &asset_keys_by_path,
  )
  .await
  {
    Ok(prepared) => prepared,
    Err(message) => {
      let error = SyncError::permanent(message, profile_id, "prepare_myoxus_documents");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, 0).await?;
      return Err(error);
    }
  };
  let doc_actions = prepared_myoxus_documents.actions.clone();
  let (docs_created, docs_updated, docs_deleted, doc_conflicts_found) = partial::count_selected_actions(&doc_actions);
  info!(
    actions = doc_actions.len(),
    full_actions = sync_result.actions.len(),
    partial = partial_batch.is_active(),
    created = docs_created,
    updated = docs_updated,
    deleted = docs_deleted,
    conflicts = doc_conflicts_found,
    "reconcile complete"
  );

  if let Err(error) = loader::authorize_projection_documents(
    pool,
    profile.workspace_id,
    profile.owner_id,
    &load_result.reference_external_ids.keys().copied().collect(),
  )
  .await
  {
    persist_attempt_error(&store, &mut run, queue_job_id, &error, doc_conflicts_found).await?;
    return Err(error);
  }
  if let Err(error) = authorize_document_mutations(
    pool,
    &profile,
    &prepared_myoxus_documents.upserts,
    &prepared_myoxus_documents.deletes,
  )
  .await
  {
    persist_attempt_error(&store, &mut run, queue_job_id, &error, doc_conflicts_found).await?;
    return Err(error);
  }
  // Prepare from actual retained files and this selected batch before any
  // mirror write. Full reconciliation and partial-session inputs stay intact.
  let prepared_projection = async {
    let (documents, bodies) = executor::effective_manifest_documents(
      profile.workspace_id,
      &myoxus_docs,
      &doc_actions,
      &bindings,
      &git_files,
      &prepared_myoxus_documents,
      previous_manifest.as_ref(),
    )?;
    let mut manifest = GitSyncManifest::new(
      profile.workspace_id,
      load_result.organizer_snapshot.revision.clone(),
      load_result.organizer_folders.clone(),
      documents,
    );
    let mut writes = std::collections::BTreeMap::new();
    let mut deletes = Vec::new();
    if run.direction != SyncDirection::GitToMyoxus {
      let service = config
        .overview_service
        .as_ref()
        .ok_or("native overview reader is unavailable")?;
      let observed =
        loader::observed_output_paths(&repo_dir, &profile.root_path, previous_manifest.as_ref(), &writer_scope).await?;
      let prepared = executor::prepare_overview_publication(
        pool,
        &profile,
        &config.server_origin,
        service,
        &load_result.organizer_snapshot,
        manifest,
        bodies,
        &prepared_myoxus_documents,
        &doc_actions,
        &bindings,
        &file_reconcile_result.actions,
        &file_bindings,
        observed,
        previous_manifest.as_ref(),
        &asset_paths,
        projection_capture,
        &writer_scope,
      )
      .await?;
      manifest = prepared.manifest;
      writes = prepared.writes;
      deletes = prepared.deletes;
    }
    let bytes = manifest.to_json().map_err(|error| error.to_string())?.into_bytes();
    Ok::<_, String>((bytes, writes, deletes))
  }
  .await;
  let (prepared_manifest_bytes, overview_writes, overview_deletes) = match prepared_projection {
    Ok(prepared) => prepared,
    Err(message) => {
      let error = SyncError::permanent(message, profile_id, "overview_projection");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, doc_conflicts_found).await?;
      return Err(error);
    }
  };
  let mut overview_changed = false;
  // Retire old derived bytes first, including a README handed to a new ordinary
  // owner. No later derived cleanup can delete that owner's newly written file.
  for path in overview_deletes {
    if let Err(cause) = git_repo.delete_file(&path).await {
      let error = SyncError::from_git_error(cause, "retire overview output", "overview_projection");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, doc_conflicts_found).await?;
      return Err(error);
    }
    overview_changed = true;
  }
  // 9. Execute doc git-side actions (write/delete Markdown files)
  let git_batch = executor::execute_git_actions(git_repo, &doc_actions, &myoxus_docs, &profile, &bindings).await;
  let git_ok = git_batch.successes;
  let git_fail = git_batch.failures;
  if !git_batch.failed_doc_ids.is_empty() {
    warn!(failed_docs = ?git_batch.failed_doc_ids, "git-side partial failures");
  }

  // File reconcile is pure read + compute and therefore safe before the commit.
  // Git-side file actions must also run before commit_and_push; otherwise the
  // local working tree would be changed after the remote commit has already
  // been pushed, which makes the run look successful while the bytes never land.

  let file_git_exec_result = executor::execute_file_git_actions(
    &file_reconcile_result.actions,
    git_repo,
    blob_storage,
    profile.workspace_id,
    profile.id,
  )
  .await;

  if !file_git_exec_result.errors.is_empty() {
    warn!(
      profile_id = %profile.id,
      workspace_id = %profile.workspace_id,
      error_count = file_git_exec_result.errors.len(),
      "git-sync: pre-commit file git execution had per-file errors"
    );
    for fe in &file_git_exec_result.errors {
      warn!(
        profile_id = %profile.id,
        file_path = %fe.repo_path,
        action = %fe.action,
        error = %fe.message,
        "git-sync: pre-commit file git execution error"
      );
    }
  }

  info!(
    profile_id = %profile.id,
    pushed = file_git_exec_result.pushed.len(),
    deleted_git = file_git_exec_result.deleted_git.len(),
    errors = file_git_exec_result.errors.len(),
    git_changed = file_git_exec_result.git_changed,
    "git-sync: pre-commit file git execution complete"
  );
  if git_batch.failures > 0 || !file_git_exec_result.errors.is_empty() {
    let error = SyncError::permanent(
      format!(
        "pre-push execution failed (document errors: {}, file errors: {}); no remote update attempted",
        git_batch.failures,
        file_git_exec_result.errors.len()
      ),
      profile_id,
      "pre_push_execution",
    );
    persist_attempt_error(&store, &mut run, queue_job_id, &error, doc_conflicts_found).await?;
    return Err(error);
  }

  let manifest_bytes = prepared_manifest_bytes;
  for (path, bytes) in overview_writes {
    match git_repo.read_file(&path).await {
      Ok(existing) if existing == bytes => continue,
      Ok(_) | Err(myoxus_application::git_sync::backend::GitError::NotFound(_)) => {}
      Err(cause) => {
        let error = SyncError::from_git_error(cause, "read overview output", "overview_projection");
        persist_attempt_error(&store, &mut run, queue_job_id, &error, doc_conflicts_found).await?;
        return Err(error);
      }
    }
    if let Err(cause) = git_repo.write_file(&path, &bytes).await {
      let error = SyncError::from_git_error(cause, "write overview output", "overview_projection");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, doc_conflicts_found).await?;
      return Err(error);
    }
    overview_changed = true;
  }
  let manifest_changed = if run.direction == SyncDirection::GitToMyoxus {
    false
  } else {
    match git_repo.read_file(&profile.manifest_path).await {
      Ok(existing) if existing == manifest_bytes => false,
      Ok(_) | Err(myoxus_application::git_sync::backend::GitError::NotFound(_)) => {
        if let Err(write_error) = git_repo.write_file(&profile.manifest_path, &manifest_bytes).await {
          let error = SyncError::permanent(
            format!("write Git-Sync manifest: {write_error}"),
            profile_id,
            "manifest",
          );
          persist_attempt_error(&store, &mut run, queue_job_id, &error, doc_conflicts_found).await?;
          return Err(error);
        }
        true
      }
      Err(manifest_error) => {
        let error = SyncError::permanent(
          format!("read Git-Sync manifest: {manifest_error}"),
          profile_id,
          "manifest",
        );
        persist_attempt_error(&store, &mut run, queue_job_id, &error, doc_conflicts_found).await?;
        return Err(error);
      }
    }
  };

  let git_changed = git_batch.git_changed || file_git_exec_result.git_changed || manifest_changed || overview_changed;
  let files_pushed = file_git_exec_result.pushed.len() as u32;
  let files_pulled = file_reconcile_result
    .actions
    .iter()
    .filter(|a| matches!(a, FileReconcileAction::PullToMyoxus { .. }))
    .count() as u32;

  // Prepare every deterministic normal-state fact before the remote can move.
  // Blob promotion is durable and rollback-owned until the final SQL commit.
  let file_myoxus_exec_result = executor::execute_file_myoxus_actions_durable(
    &file_reconcile_result.actions,
    git_repo,
    blob_storage,
    profile.workspace_id,
    profile.id,
    &store,
    run_id,
  )
  .await;
  if !file_myoxus_exec_result.errors.is_empty() {
    let mut reason = format!(
      "pre-push blob preparation failed for {} file(s)",
      file_myoxus_exec_result.errors.len()
    );
    if let Err(cleanup_error) =
      executor::cleanup_file_promotions(&store, blob_storage, &file_myoxus_exec_result.pulled, false).await
    {
      reason.push_str(&format!("; {cleanup_error}"));
    }
    let error = SyncError::permanent(reason, profile_id, "prepare_file_objects");
    persist_attempt_error(&store, &mut run, queue_job_id, &error, doc_conflicts_found).await?;
    return Err(error);
  }

  let executed_file_actions = executed_file_actions_for_persist(
    &file_reconcile_result.actions,
    &file_git_exec_result,
    &file_myoxus_exec_result,
  );
  // Use the admitted operation inventory, including unpersisted native media.
  // Reloading SQL here would discard new candidates before atomic finalization.
  let facts = match persist::build_persistence_draft(
    &doc_actions,
    &myoxus_docs,
    &bindings,
    &git_files,
    &git_batch.written_paths,
    &executed_file_actions,
    &file_bindings,
    &prepared_myoxus_documents.upserts,
    &prepared_myoxus_documents.imported_hashes,
    &profile,
    run_id,
  ) {
    Ok(facts) => facts,
    Err(mut reason) => {
      if let Err(cleanup_error) =
        executor::cleanup_file_promotions(&store, blob_storage, &file_myoxus_exec_result.pulled, false).await
      {
        reason.push_str(&format!("; {cleanup_error}"));
      }
      let error = SyncError::permanent(reason, profile_id, "build_finalization");
      persist_attempt_error(&store, &mut run, queue_job_id, &error, doc_conflicts_found).await?;
      return Err(error);
    }
  };
  let new_binding_count = facts
    .document_bindings
    .iter()
    .filter(|binding| !bindings.iter().any(|current| current.id == binding.id))
    .count() as i32;
  let tombstoned = facts.document_tombstone_ids.len() as i32;
  let version_links_created = facts.version_links.len();
  let mut file_counters = FileRunCounters {
    denied: file_reconcile_result.denied,
    errors: 0,
    ..FileRunCounters::default()
  };
  for action in &executed_file_actions {
    match action {
      FileReconcileAction::PullToMyoxus { .. } => file_counters.pulled += 1,
      FileReconcileAction::PushToGit { .. } => file_counters.pushed += 1,
      FileReconcileAction::DeleteFromGit { .. } | FileReconcileAction::DeleteFromMyoxus { .. } => {
        file_counters.deleted += 1
      }
      FileReconcileAction::Conflict { .. } => file_counters.conflicted += 1,
      FileReconcileAction::NoChange { .. } => {}
    }
  }
  let partial_finalization = partial::build_partial_finalization(&partial_batch, run_id, &doc_actions, &[]);
  run.docs_created = docs_created;
  run.docs_updated = docs_updated;
  run.docs_deleted = docs_deleted;
  run.conflicts_found = doc_conflicts_found;
  let finalization_draft = GitSyncRunFinalizationDraft {
    run: run.clone(),
    workspace_id: profile.workspace_id,
    expected_job_id: queue_job_id.to_string(),
    document_upserts: prepared_myoxus_documents.upserts,
    document_deletes: prepared_myoxus_documents.deletes,
    persistence: facts,
    blob_promotion_ids: file_myoxus_exec_result
      .pulled
      .iter()
      .filter_map(|file| file.promotion_id)
      .collect(),
    partial: partial_finalization,
  };
  if let Err(mut reason) = finalization_draft.validate() {
    if let Err(cleanup_error) =
      executor::cleanup_file_promotions(&store, blob_storage, &file_myoxus_exec_result.pulled, false).await
    {
      reason.push_str(&format!("; {cleanup_error}"));
    }
    let error = SyncError::permanent(reason, profile_id, "validate_finalization_draft");
    persist_attempt_error(&store, &mut run, queue_job_id, &error, doc_conflicts_found).await?;
    return Err(error);
  }

  // Blob preparation is asynchronous. Recheck live document access and write
  // capabilities at the publication boundary, never against cached bodies.
  let access = async {
    loader::authorize_projection_documents(
      pool,
      profile.workspace_id,
      profile.owner_id,
      &load_result.reference_external_ids.keys().copied().collect(),
    )
    .await?;
    authorize_document_mutations(
      pool,
      &profile,
      &finalization_draft.document_upserts,
      &finalization_draft.document_deletes,
    )
    .await
  }
  .await;
  if let Err(error) = access {
    let error =
      match executor::cleanup_file_promotions(&store, blob_storage, &file_myoxus_exec_result.pulled, false).await {
        Ok(()) => error,
        Err(cleanup) => SyncError::permanent(
          format!("{error}; authorization cleanup failed: {cleanup}"),
          profile_id,
          "authorization_cleanup",
        ),
      };
    persist_attempt_error(&store, &mut run, queue_job_id, &error, doc_conflicts_found).await?;
    return Err(error);
  }

  // 10. Commit and push after every deterministic mutation fact and durable
  //     blob promotion has been prepared. Normal Myoxus product state remains
  //     untouched until the guarded final transaction.
  //
  //     Count doc push/pull actions for commit trailers (traceability).
  let docs_pushed = doc_actions
    .iter()
    .filter(|a| {
      matches!(
        a.action,
        ReconcileAction::PushToGit | ReconcileAction::CreateInGit | ReconcileAction::DeleteInGit
      )
    })
    .count() as u32;
  let docs_pulled = doc_actions
    .iter()
    .filter(|a| {
      matches!(
        a.action,
        ReconcileAction::PullToMyoxus | ReconcileAction::CreateInMyoxus
      )
    })
    .count() as u32;
  let trailers = remote_commit::CommitTrailers {
    workspace_id: profile.workspace_id,
    run_id,
    profile_id,
    direction: run.direction.to_string(),
    docs_pushed,
    docs_pulled,
    files_pushed,
    files_pulled,
  };
  // Setup stashes are local preparation state. Dispose of them before push so
  // normal post-push completion performs no filesystem operation.
  repo::drop_stashes(git_repo).await;
  repository_guard
    .ensure_owned()
    .await
    .map_err(|error| repository_guard_error(error, profile_id))?;
  let push_receipt = if git_changed {
    match remote_commit::commit_and_push(
      git_repo,
      &profile,
      &auth,
      &config.commit_author_name,
      &config.commit_author_email,
      config.push_max_retries,
      &trailers,
    )
    .await
    {
      Ok(oid) => oid,
      Err(remote_error) => {
        let e = match remote_error {
          RemoteCommitError::Git { context, source } => SyncError::from_git_error(source, context, "commit_and_push"),
          RemoteCommitError::Retryable(message) => SyncError::Retryable {
            message,
            profile_id,
            phase: "commit_and_push",
          },
          RemoteCommitError::OutcomeUnknown { message, intended_oid } => SyncError::RemoteOutcomeUnknown {
            message,
            profile_id,
            intended_oid,
            phase: "commit_and_push",
          },
        };
        if matches!(e, SyncError::RemoteOutcomeUnknown { .. }) {
          error!(
            run_id = %run_id,
            profile_id = %profile_id,
            error = %e,
            "remote push outcome is unknown; retaining Running state for authenticated reconciliation"
          );
          return Err(e);
        }
        // Push failed — no DB changes made, working tree is reset by commit_and_push.
        // Retryable failures release the exact run back to Pending; permanent
        // failures become terminal before the queue is acknowledged.
        persist_attempt_error(&store, &mut run, queue_job_id, &e, doc_conflicts_found).await?;
        return Err(e);
      }
    }
  } else {
    None
  };
  let commit_oid = push_receipt.as_ref().map(|receipt| receipt.observed_remote_oid.clone());
  repository_guard
    .ensure_owned()
    .await
    .map_err(|error| repository_guard_error(error, profile_id))?;
  let final_remote_oid = commit_oid.clone().unwrap_or_else(|| source_remote_oid.clone());
  let plan = match finalization_draft.bind_remote_oid(final_remote_oid.clone()) {
    Ok(plan) => plan,
    Err(reason) => {
      let error = SyncError::permanent(reason, profile_id, "bind_remote_oid");
      persist_post_push_failure(
        &store,
        &mut run,
        queue_job_id,
        &error,
        doc_conflicts_found,
        commit_oid.as_deref(),
      )
      .await?;
      return Err(error);
    }
  };
  let (conflicts_created, file_conflicts_created);
  match store.commit_post_push(&plan).await {
    Ok(finalized) => {
      conflicts_created = finalized.document_conflicts_created;
      file_conflicts_created = finalized.file_conflicts_created;
      run = finalized.run;
    }
    Err(myoxus_infrastructure::git_sync::GitSyncStoreError::CommitOutcomeUnknown {
      message,
      document_conflicts_created,
      file_conflicts_created: created_files,
      ..
    }) => match store.get_run(run_id).await {
      Ok(persisted)
        if persisted.status == myoxus_domain::git_sync::RunStatus::Completed
          && persisted.job_id.as_deref() == Some(queue_job_id)
          && persisted.commit_after.as_deref() == Some(final_remote_oid.as_str())
          && persisted.observed_remote_oid.as_deref() == Some(final_remote_oid.as_str()) =>
      {
        warn!(
          run_id = %run_id,
          %message,
          "post-push commit acknowledgement was lost; committed run state proves success"
        );
        run = persisted;
        conflicts_created = document_conflicts_created;
        file_conflicts_created = created_files;
      }
      Ok(persisted) if persisted.status == myoxus_domain::git_sync::RunStatus::Running => {
        let failure_message = format!(
          "post-push commit acknowledgement failed and a fresh read proves the run is still Running: {message}"
        );
        let finalization_error = SyncError::permanent(failure_message, profile_id, "finalize_transaction");
        persist_post_push_failure(
          &store,
          &mut run,
          queue_job_id,
          &finalization_error,
          doc_conflicts_found,
          commit_oid.as_deref(),
        )
        .await?;
        return Err(finalization_error);
      }
      Ok(persisted) => {
        return Err(SyncError::permanent(
          format!(
            "post-push commit outcome conflicts with persisted run status {} after: {message}",
            persisted.status
          ),
          profile_id,
          "finalize_transaction_unknown",
        ));
      }
      Err(read_error) => {
        return Err(SyncError::permanent(
          format!(
            "post-push commit outcome remains unknown; retained promoted objects because run truth could not be read after {message}: {read_error}"
          ),
          profile_id,
          "finalize_transaction_unknown",
        ));
      }
    },
    Err(error) => {
      // The verified remote has moved. Keep the durable promotion ledger and
      // prepared objects for reconciliation/recovery instead of erasing the
      // evidence that distinguishes them from normal committed state.
      let message = format!("post-push database transaction rolled back: {error}");
      let finalization_error = SyncError::permanent(message, profile_id, "finalize_transaction");
      persist_post_push_failure(
        &store,
        &mut run,
        queue_job_id,
        &finalization_error,
        doc_conflicts_found,
        commit_oid.as_deref(),
      )
      .await?;
      return Err(finalization_error);
    }
  }
  if let Err(cleanup_error) =
    executor::cleanup_file_promotions(&store, blob_storage, &file_myoxus_exec_result.pulled, true).await
  {
    warn!(
      run_id = %run_id,
      %cleanup_error,
      "committed Git-Sync blob stages remain in the durable recovery ledger"
    );
  }
  let mx_ok = doc_actions
    .iter()
    .filter(|action| {
      matches!(
        action.action,
        ReconcileAction::CreateInMyoxus | ReconcileAction::PullToMyoxus | ReconcileAction::DeleteInMyoxus
      )
    })
    .count() as i32;
  let mx_fail = 0;
  let file_execution_errors = 0usize;

  // P38-E-01: Invalidate git status cache after run completion so the
  // resolver fetches fresh counts on the next query.
  invalidate_git_status_cache(config, profile.workspace_id).await;
  let partial_session_after = match store.get_latest_partial_session(profile_id).await {
    Ok(session) => session,
    Err(error) => {
      warn!(
        run_id = %run_id,
        profile_id = %profile_id,
        %error,
        "completed run persisted, but latest partial-session status could not be reloaded for the response"
      );
      None
    }
  };
  let partial_status_session = partial_session_after.as_ref().or(partial_batch.session.as_ref());
  let partial_has_more = partial_status_session
    .map(|session| session.status == myoxus_domain::git_sync::PartialSessionStatus::Open)
    .unwrap_or(false);

  Ok(serde_json::json!({
    "runId": run_id.to_string(),
    "status": run.status.to_string(),
    "docsCreated": docs_created,
    "docsUpdated": docs_updated,
    "docsDeleted": docs_deleted,
    "conflictsFound": doc_conflicts_found,
    "commitOid": commit_oid,
    "gitActionsOk": git_ok,
    "gitActionsFailed": git_fail,
    "myoxusActionsOk": mx_ok,
    "myoxusActionsFailed": mx_fail,
    "newBindings": new_binding_count,
    "tombstonedBindings": tombstoned,
    "conflictsCreated": conflicts_created,
    "fileConflictsCreated": file_conflicts_created,
    "filesPulled": file_counters.pulled,
    "filesPushed": file_counters.pushed,
    "filesDeleted": file_counters.deleted,
    "filesConflicted": file_counters.conflicted,
    "filesDenied": file_counters.denied,
    "fileErrors": file_counters.errors,
    "fileExecPulled": file_myoxus_exec_result.pulled.len(),
    "fileExecPushed": file_git_exec_result.pushed.len(),
    "fileExecDeletedGit": file_git_exec_result.deleted_git.len(),
    "fileExecDeletedMyoxus": file_myoxus_exec_result.deleted_myoxus.len(),
    "fileExecErrors": file_execution_errors,
    "versionLinksCreated": version_links_created,
    "projectedDocumentPayloads": projection_metrics.payload_reads,
    "documentProjectionConcurrency": projection_metrics.worker_concurrency,
    "documentReferenceInventories": projection_metrics.reference_inventory_builds,
    "documentGraphDependenciesUsed": projection_selection.used_fresh_document_graph,
    "partial": partial_batch.is_active(),
    "partialHasMore": partial_has_more,
    "partialSelectedItems": partial_batch.selected_items.len(),
    "partialSession": partial_status_session.map(|session| serde_json::json!({
      "id": session.id.to_string(),
      "status": session.status.to_string(),
      "totalItems": session.total_items,
      "processedItems": session.processed_items,
      "failedItems": session.failed_items,
    })),
  }))
}

async fn persist_attempt_error(
  store: &SqlxGitSyncStore,
  run: &mut myoxus_domain::git_sync::GitSyncRun,
  queue_job_id: &str,
  error: &SyncError,
  conflicts_found: i32,
) -> Result<(), SyncError> {
  if error.is_retryable() {
    match store
      .release_run_for_retry(run.id, queue_job_id, &error.to_string(), error.to_error_class())
      .await
    {
      Ok(true) => {
        run.status = myoxus_domain::git_sync::RunStatus::Pending;
        run.error_message = Some(error.to_string());
        run.error_class = Some(error.to_error_class());
        return Ok(());
      }
      Ok(false) => {}
      Err(store_error) => {
        error!(run_id = %run.id, error = %store_error, "failed to release retryable Git-Sync run");
      }
    }
    persist::finalize_run(
      store,
      run,
      0,
      0,
      0,
      conflicts_found,
      None,
      Some((
        format!("retry state persistence failed after: {error}"),
        myoxus_domain::git_sync::ErrorClass::InternalError,
      )),
    )
    .await?;
    return Err(SyncError::permanent(
      format!("could not persist retryable run state after: {error}"),
      run.profile_id,
      "retry_state",
    ));
  }

  persist::finalize_run(
    store,
    run,
    0,
    0,
    0,
    conflicts_found,
    None,
    Some((error.to_string(), error.to_error_class())),
  )
  .await?;
  Ok(())
}

async fn persist_post_push_failure(
  store: &SqlxGitSyncStore,
  run: &mut myoxus_domain::git_sync::GitSyncRun,
  queue_job_id: &str,
  failure: &SyncError,
  conflicts_found: i32,
  pushed_remote_oid: Option<&str>,
) -> Result<(), SyncError> {
  let Some(observed_remote_oid) = pushed_remote_oid else {
    return persist_attempt_error(store, run, queue_job_id, failure, conflicts_found).await;
  };
  let reason = failure.to_string();
  match store
    .mark_reconciliation_required(run, queue_job_id, observed_remote_oid, &reason)
    .await
  {
    Ok(true) => {
      run.status = myoxus_domain::git_sync::RunStatus::Failed;
      run.finished_at = Some(chrono::Utc::now());
      run.commit_after = None;
      run.observed_remote_oid = Some(observed_remote_oid.to_string());
      run.reconciliation_required = true;
      run.reconciliation_reason = Some(reason.clone());
      run.error_message = Some(reason);
      run.error_class = Some(myoxus_domain::git_sync::ErrorClass::InternalError);
      error!(
        run_id = %run.id,
        profile_id = %run.profile_id,
        %observed_remote_oid,
        "remote moved but Git-Sync finalization failed; reconciliation recorded"
      );
      Ok(())
    }
    Ok(false) => Err(SyncError::permanent(
      format!(
        "remote moved to {observed_remote_oid}, but reconciliation marker did not match the running job after: {failure}"
      ),
      run.profile_id,
      "record_reconciliation",
    )),
    Err(store_error) => Err(SyncError::permanent(
      format!(
        "remote moved to {observed_remote_oid}, but reconciliation marker could not be persisted after {failure}: {store_error}"
      ),
      run.profile_id,
      "record_reconciliation",
    )),
  }
}

fn executed_file_actions_for_persist(
  actions: &[FileReconcileAction],
  git_exec: &executor::FileExecutionResult,
  myoxus_exec: &executor::FileExecutionResult,
) -> Vec<FileReconcileAction> {
  let pushed: HashSet<(&str, &str)> = git_exec
    .pushed
    .iter()
    .map(|p| (p.repo_path.as_str(), p.blob_key.as_str()))
    .collect();
  let deleted_git: HashSet<&str> = git_exec.deleted_git.iter().map(String::as_str).collect();
  let pulled: HashSet<&str> = myoxus_exec.pulled.iter().map(|p| p.repo_path.as_str()).collect();
  let deleted_myoxus: HashSet<(&str, &str)> = myoxus_exec
    .deleted_myoxus_paths
    .iter()
    .zip(myoxus_exec.deleted_myoxus.iter())
    .map(|(repo_path, blob_key)| (repo_path.as_str(), blob_key.as_str()))
    .collect();
  let conflicts: HashSet<&str> = myoxus_exec.conflicts.iter().map(|c| c.repo_path.as_str()).collect();

  actions
    .iter()
    .filter_map(|action| match action {
      FileReconcileAction::PullToMyoxus { repo_path, .. } if pulled.contains(repo_path.as_str()) => {
        Some(action.clone())
      }
      FileReconcileAction::PushToGit {
        repo_path, blob_key, ..
      } if pushed.contains(&(repo_path.as_str(), blob_key.as_str())) => Some(action.clone()),
      FileReconcileAction::DeleteFromGit { repo_path, .. } if deleted_git.contains(repo_path.as_str()) => {
        Some(action.clone())
      }
      FileReconcileAction::DeleteFromMyoxus { repo_path, blob_key }
        if deleted_myoxus.contains(&(repo_path.as_str(), blob_key.as_str())) =>
      {
        Some(action.clone())
      }
      FileReconcileAction::Conflict { repo_path, .. } if conflicts.contains(repo_path.as_str()) => Some(action.clone()),
      _ => None,
    })
    .collect()
}

/// P38-E-01: Invalidate the git sync status Redis cache for a workspace.
///
/// Called after every sync run finalization so the `gitSyncStatus` resolver
/// fetches fresh conflict/binding counts on the next query.
async fn invalidate_git_status_cache(config: &RunnerConfig, workspace_id: Uuid) {
  let cache = myoxus_infrastructure::quota_cache::QuotaCache::new(config.cache_redis.clone(), &config.redis_namespace);
  cache.invalidate_git_status(workspace_id).await;
  debug!(workspace_id = %workspace_id, "invalidated git_status cache after sync run");
}

// ─── File Pipeline (M2-C2) ─────────────────────────────────────────────────

/// Counters for the file sync pipeline, reported in the run summary JSON.
#[derive(Debug, Default)]
pub struct FileRunCounters {
  pub pulled: usize,
  pub pushed: usize,
  pub deleted: usize,
  pub conflicted: usize,
  pub denied: usize,
  pub errors: usize,
}

/// Result of the file reconcile phase (steps 1-4).
/// Contains the reconciled actions and denied count, ready for counting and persist.
struct FileReconcileResult {
  actions: Vec<FileReconcileAction>,
  denied: usize,
  /// State-loading errors are fatal: treating them as an empty side would
  /// manufacture deletes, conflicts or false success.
  error: Option<SyncError>,
}

/// Prepared identities are allocation facts, not edit permission. Resolve
/// current effective roles for ordinary imports, updates and deletions.
async fn authorize_document_mutations(
  pool: &PgPool,
  profile: &myoxus_domain::git_sync::GitSyncProfile,
  upserts: &[myoxus_application::git_sync::finalization::PreparedDocumentUpsert],
  deletes: &[Uuid],
) -> Result<(), SyncError> {
  use myoxus_domain::permission::{DocAction, WorkspaceAction};
  if upserts.is_empty() && deletes.is_empty() {
    return Ok(());
  }
  let permissions = loader::projection_permissions(pool);
  let needs_create = upserts.iter().any(|document| document.expected_create);
  let workspace_role = permissions
    .get_effective_workspace_role(profile.owner_id, profile.workspace_id)
    .await
    .map_err(|error| SyncError::permanent(error.to_string(), profile.id, "document_authorization"))?;
  if needs_create && workspace_role.is_none_or(|role| !role.can(WorkspaceAction::CreateDoc)) {
    return Err(SyncError::permanent(
      "document creation is no longer authorized",
      profile.id,
      "document_authorization",
    ));
  }
  let update_ids = upserts
    .iter()
    .filter(|document| !document.expected_create)
    .map(|document| document.doc_id)
    .collect::<HashSet<_>>();
  let ids = update_ids
    .iter()
    .copied()
    .chain(deletes.iter().copied())
    .collect::<Vec<_>>();
  let roles = permissions
    .effective_doc_roles(profile.owner_id, profile.workspace_id, &ids)
    .await
    .map_err(|error| SyncError::permanent(error.to_string(), profile.id, "document_authorization"))?;
  if update_ids
    .iter()
    .any(|id| roles.get(id).is_none_or(|role| !role.can(DocAction::Update)))
    || deletes
      .iter()
      .any(|id| roles.get(id).is_none_or(|role| !role.can(DocAction::Trash)))
  {
    return Err(SyncError::permanent(
      "document mutation is no longer authorized",
      profile.id,
      "document_authorization",
    ));
  }
  Ok(())
}

/// File reconcile phase (steps 1-4): load states, reconcile, return actions.
///
/// This runs BEFORE the git commit so file counts can be included in commit
/// trailers (M4 fix). No DB mutations happen here — only reads + pure reconcile.
async fn reconcile_file_pipeline(
  store: &SqlxGitSyncStore,
  pool: &PgPool,
  blob_storage: &dyn BlobStoragePort,
  runner_config: &RunnerConfig,
  profile: &myoxus_domain::git_sync::GitSyncProfile,
  direction: SyncDirection,
  repo_dir: &std::path::Path,
  captured: &myoxus_application::markdown::PreparedMarkdownBatchExport,
  planned_paths: &HashMap<Uuid, String>,
  myoxus_file_bindings: &mut Vec<myoxus_domain::git_sync::GitSyncFileBinding>,
  scope: &export::GitSyncWriterScope,
) -> FileReconcileResult {
  // 1. Resolve MIME policy from the universal live configuration snapshot.
  let fallback = myoxus_infrastructure::mime_policy_config::MimePolicyFallback {
    allowlist: &runner_config.mime_allowlist_admin,
    blocklist: &runner_config.mime_blocklist_admin,
    validation_mode: &runner_config.mime_validation_mode,
  };
  let overrides = runner_config.config_overrides.read().await;
  let mime_config =
    myoxus_infrastructure::mime_policy_config::resolve_mime_policy_config(&overrides.overrides, &fallback);
  drop(overrides);

  let file_load = match loader::load_git_file_objects(repo_dir, &profile.root_path, &mime_config, scope).await {
    Ok(files) => files,
    Err(message) => {
      return FileReconcileResult {
        actions: Vec::new(),
        denied: 0,
        error: Some(SyncError::permanent(message, profile.id, "overview_preflight")),
      };
    }
  };

  let denied = file_load.denied_count;

  // New editor media enter the existing pure file plan as candidate bindings.
  // They are persisted only by the guarded finalization after a verified push.
  if direction != SyncDirection::GitToMyoxus {
    if let Err(message) = loader::admit_referenced_assets(
      pool,
      blob_storage,
      profile,
      captured,
      repo_dir,
      planned_paths,
      myoxus_file_bindings,
      &mime_config,
      scope,
    )
    .await
    {
      return FileReconcileResult {
        actions: Vec::new(),
        denied,
        error: Some(SyncError::permanent(message, profile.id, "asset_preflight")),
      };
    }
  }
  for binding in myoxus_file_bindings.iter().filter(|binding| !binding.tombstoned) {
    match scope.excludes(&binding.repo_path) {
      Ok(false) => {}
      Ok(true) | Err(_) => {
        return FileReconcileResult {
          actions: Vec::new(),
          denied,
          error: Some(SyncError::permanent(
            "Git-Sync asset enters a delegated repository scope",
            profile.id,
            "asset_preflight",
          )),
        };
      }
    }
  }

  if file_load.items.is_empty() && myoxus_file_bindings.is_empty() {
    trace!("no file objects on either side — file pipeline skipped");
    return FileReconcileResult {
      actions: Vec::new(),
      denied,
      error: None,
    };
  }

  let file_baselines = match store.get_file_baselines_by_profile(profile.id).await {
    Ok(b) => b,
    Err(e) => {
      warn!(error = %e, "failed to load file baselines — aborting file reconcile");
      return FileReconcileResult {
        actions: Vec::new(),
        denied,
        error: Some(SyncError::database(
          format!("load file baselines: {e}"),
          "file_reconcile",
        )),
      };
    }
  };

  info!(
    git_files = file_load.items.len(),
    myoxus_bindings = myoxus_file_bindings.len(),
    baselines = file_baselines.len(),
    denied = file_load.denied_count,
    "file pipeline: loaded states"
  );

  // 3. Build the git_files HashMap for the reconcile function.
  let mut git_files_map: std::collections::HashMap<String, GitFileEntry> = file_load
    .items
    .into_iter()
    .map(|item| {
      (
        item.repo_path,
        GitFileEntry {
          content_hash: item.content_hash,
          bytes: item.bytes,
          mime_type: item.mime_result.effective_mime.clone(),
        },
      )
    })
    .collect();

  // 4. Reconcile files (pure function).
  let file_actions =
    file_reconcile::reconcile_files(&mut git_files_map, myoxus_file_bindings, &file_baselines, direction);

  // Count action types for logging.
  let mut n_pull = 0usize;
  let mut n_push = 0usize;
  let mut n_del = 0usize;
  let mut n_conflict = 0usize;
  let mut n_no_change = 0usize;
  for action in &file_actions {
    match action {
      FileReconcileAction::PullToMyoxus { .. } => n_pull += 1,
      FileReconcileAction::PushToGit { .. } => n_push += 1,
      FileReconcileAction::DeleteFromGit { .. } | FileReconcileAction::DeleteFromMyoxus { .. } => n_del += 1,
      FileReconcileAction::Conflict { .. } => n_conflict += 1,
      FileReconcileAction::NoChange { .. } => n_no_change += 1,
    }
  }

  info!(
    pull = n_pull,
    push = n_push,
    delete = n_del,
    conflict = n_conflict,
    no_change = n_no_change,
    "file reconcile complete"
  );

  FileReconcileResult {
    actions: file_actions,
    denied,
    error: None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::git_sync_engine::executor::{FileConflict, PulledFile, PushedFile};

  #[test]
  fn executed_file_actions_for_persist_keeps_only_successful_side_effects() {
    let actions = vec![
      FileReconcileAction::PushToGit {
        repo_path: "assets/ok.png".to_string(),
        blob_key: "blob-ok".to_string(),
        content_hash: "h-ok".to_string(),
      },
      FileReconcileAction::PushToGit {
        repo_path: "assets/failed.png".to_string(),
        blob_key: "blob-failed".to_string(),
        content_hash: "h-failed".to_string(),
      },
      FileReconcileAction::PullToMyoxus {
        repo_path: "assets/pulled.png".to_string(),
        content_hash: "h-pulled".to_string(),
        bytes: vec![1, 2, 3],
        mime_type: "image/png".to_string(),
      },
      FileReconcileAction::DeleteFromGit {
        repo_path: "assets/deleted-git.png".to_string(),
        blob_key: "blob-deleted-git".to_string(),
      },
      FileReconcileAction::DeleteFromMyoxus {
        repo_path: "assets/deleted-myoxus.png".to_string(),
        blob_key: "blob-deleted-myoxus".to_string(),
      },
      FileReconcileAction::Conflict {
        repo_path: "assets/conflict.png".to_string(),
        git_hash: "git".to_string(),
        myoxus_hash: "myoxus".to_string(),
        baseline_hash: "base".to_string(),
      },
    ];

    let mut git_exec = executor::FileExecutionResult::default();
    git_exec.pushed.push(PushedFile {
      repo_path: "assets/ok.png".to_string(),
      blob_key: "blob-ok".to_string(),
      content_hash: "h-ok".to_string(),
    });
    git_exec.deleted_git.push("assets/deleted-git.png".to_string());

    let mut myoxus_exec = executor::FileExecutionResult::default();
    myoxus_exec.pulled.push(PulledFile {
      repo_path: "assets/pulled.png".to_string(),
      blob_key: "git-sync/profile/assets/pulled.png".to_string(),
      storage_key: "workspace/fixture-object".into(),
      content_hash: "h-pulled".to_string(),
      mime_type: "image/png".to_string(),
      size: 3,
      newly_promoted: true,
      promotion_id: None,
      stage_key: None,
    });
    myoxus_exec
      .deleted_myoxus_paths
      .push("assets/deleted-myoxus.png".to_string());
    myoxus_exec.deleted_myoxus.push("blob-deleted-myoxus".to_string());
    myoxus_exec.conflicts.push(FileConflict {
      repo_path: "assets/conflict.png".to_string(),
      git_hash: "git".to_string(),
      myoxus_hash: "myoxus".to_string(),
      baseline_hash: "base".to_string(),
    });

    let persisted = executed_file_actions_for_persist(&actions, &git_exec, &myoxus_exec);
    assert_eq!(
      persisted.len(),
      5,
      "failed file actions must not be persisted as successful bindings/baselines"
    );
    assert!(
      !persisted.iter().any(
        |action| matches!(action, FileReconcileAction::PushToGit { repo_path, .. } if repo_path == "assets/failed.png")
      ),
      "failed PushToGit must be filtered out"
    );
  }
}
