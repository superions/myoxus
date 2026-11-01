// SPDX-License-Identifier: AGPL-3.0-or-later
//! Conservative SQL-history and filesystem maintenance for Git Sync.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use thiserror::Error;
use uuid::Uuid;

use myoxus_application::ports::RedisPort;
use myoxus_infrastructure::git_sync::{
  MirrorLockError, MirrorStorageError, SqlxGitSyncStore, StagingCleanupCandidate, acquire_profile_mirror,
  inspect_cleanup_inventory, remove_canonical_mirror, remove_staging_candidate,
};

use super::error::SyncError;
use super::locking::{self, ProfileLocks};

const STAGING_RETENTION: Duration = Duration::hours(24);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitSyncMaintenanceReport {
  pub cleaned_canonical_mirrors: usize,
  pub cleaned_staging: usize,
  pub retained_existing_mirrors: usize,
  pub retained_current_staging: usize,
  pub retained_unfinished_staging: usize,
  pub retained_busy_candidates: usize,
  pub retained_unknown_entries: usize,
  pub sql_history: GitSyncSqlHistoryReport,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncSqlHistoryReport {
  pub deleted: BTreeMap<String, u64>,
  pub protected_profiles: u64,
  pub busy_profiles: u64,
  pub processed_profiles: u64,
  pub budget_exhausted: bool,
}

impl GitSyncSqlHistoryReport {
  fn add(&mut self, batch: myoxus_infrastructure::git_sync::store::GitSyncHistoryCleanupBatch) {
    self.protected_profiles += batch.protected_profiles;
    self.busy_profiles += batch.busy_profiles;
    for (kind, count) in batch.deleted {
      *self.deleted.entry(kind).or_default() += count;
    }
  }
}

#[derive(Debug, Error)]
pub enum GitSyncMaintenanceError {
  #[error("load Git-Sync cleanup ownership: {0}")]
  Store(#[from] myoxus_infrastructure::git_sync::GitSyncStoreError),
  #[error("inspect or mutate Git-Sync mirror storage: {0}")]
  Storage(#[from] MirrorStorageError),
  #[error("acquire Git-Sync cleanup ownership for profile {profile_id}: {message}")]
  Ownership { profile_id: Uuid, message: String },
}

#[derive(Default)]
struct ProfileCandidates {
  canonical: bool,
  staging: Vec<StagingCleanupCandidate>,
}

pub struct GitSyncMaintenance {
  store: SqlxGitSyncStore,
  repo_base: PathBuf,
  locks: ProfileLocks,
  redis: Arc<dyn RedisPort>,
  lock_ttl_seconds: u64,
}

impl GitSyncMaintenance {
  pub fn new(
    store: SqlxGitSyncStore,
    repo_base: PathBuf,
    locks: ProfileLocks,
    redis: Arc<dyn RedisPort>,
    lock_ttl_seconds: u64,
  ) -> Self {
    Self {
      store,
      repo_base,
      locks,
      redis,
      lock_ttl_seconds,
    }
  }

  pub async fn cleanup(&self) -> Result<GitSyncMaintenanceReport, GitSyncMaintenanceError> {
    self.cleanup_at(Utc::now()).await
  }

  /// The existing nightly owner supplies one effective policy snapshot. SQL
  /// expiration does not acquire a Git/Redis/mirror lock or perform remote I/O.
  pub async fn cleanup_with_retention(
    &self,
    retention_days: u32,
  ) -> Result<GitSyncMaintenanceReport, GitSyncMaintenanceError> {
    let mut sql_history = GitSyncSqlHistoryReport::default();
    match tokio::time::timeout(
      std::time::Duration::from_secs(60),
      self.cleanup_sql_history(retention_days, &mut sql_history),
    )
    .await
    {
      Ok(Ok(())) => {}
      Ok(Err(error)) => {
        tracing::error!(%error,deleted_rows=sql_history.deleted.values().sum::<u64>(),
          protected_profiles=sql_history.protected_profiles,busy_profiles=sql_history.busy_profiles,
          "Git-Sync SQL maintenance failed after completed batches");
        return Err(error);
      }
      // Dropping an in-flight SQLx transaction rolls it back. Counts include
      // completed batches only; unfinished eligible work resumes next night.
      Err(_) => sql_history.budget_exhausted = true,
    }
    let mut report = self.cleanup().await?;
    report.sql_history = sql_history;
    Ok(report)
  }

  async fn cleanup_sql_history(
    &self,
    days: u32,
    report: &mut GitSyncSqlHistoryReport,
  ) -> Result<(), GitSyncMaintenanceError> {
    let cutoff = self.store.history_retention_cutoff(days).await?;
    let mut after = None;
    loop {
      let profiles = self.store.history_cleanup_profile_ids(after).await?;
      if profiles.is_empty() {
        break;
      }
      after = profiles.last().copied();
      'profiles: for profile in profiles {
        report.processed_profiles += 1;
        // Auxiliary expiration must finish (or protect the profile) before any
        // parent deletion. Each committed batch freshly locks/rechecks state.
        for auxiliary in [true, false] {
          loop {
            let result = if auxiliary {
              self.store.cleanup_auxiliary_history(profile, cutoff, 1_000).await
            } else {
              self.store.cleanup_terminal_runs(profile, cutoff, 1_000).await
            };
            let batch = match result {
              Ok(batch) => batch,
              Err(myoxus_infrastructure::git_sync::GitSyncStoreError::Database(ref error))
                if error
                  .as_database_error()
                  .is_some_and(|db| db.code().as_deref() == Some("55P03")) =>
              {
                report.busy_profiles += 1;
                continue 'profiles;
              }
              Err(error) => return Err(error.into()),
            };
            let protected = batch.protected_profiles > 0 || batch.busy_profiles > 0;
            let full = batch.deleted_rows() == 1_000;
            report.add(batch);
            if protected {
              continue 'profiles;
            }
            if !full {
              break;
            }
          }
        }
      }
    }
    Ok(())
  }

  async fn cleanup_at(&self, now: DateTime<Utc>) -> Result<GitSyncMaintenanceReport, GitSyncMaintenanceError> {
    let persisted_profiles: HashSet<_> = self.store.list_profile_ids().await?.into_iter().collect();
    let inventory = inspect_cleanup_inventory(&self.repo_base).await?;
    let mut report = GitSyncMaintenanceReport {
      retained_unknown_entries: inventory.retained_unknown_entries,
      ..GitSyncMaintenanceReport::default()
    };
    let mut candidates: HashMap<Uuid, ProfileCandidates> = HashMap::new();

    for profile_id in inventory.canonical_profile_ids {
      if persisted_profiles.contains(&profile_id) {
        report.retained_existing_mirrors += 1;
      } else {
        candidates.entry(profile_id).or_default().canonical = true;
      }
    }
    for staging in inventory.staging {
      if staging.ownership.created_at > now - STAGING_RETENTION {
        report.retained_current_staging += 1;
      } else {
        candidates
          .entry(staging.ownership.profile_id)
          .or_default()
          .staging
          .push(staging);
      }
    }

    for (profile_id, candidate) in candidates {
      let distributed = match locking::acquire(&self.locks, profile_id, &self.redis, self.lock_ttl_seconds).await {
        Ok(guard) => guard,
        Err(SyncError::AlreadySyncing(_)) => {
          report.retained_busy_candidates += candidate_count(&candidate);
          continue;
        }
        Err(error) => {
          return Err(GitSyncMaintenanceError::Ownership {
            profile_id,
            message: error.to_string(),
          });
        }
      };
      let _physical = match acquire_profile_mirror(&self.repo_base, profile_id).await {
        Ok(guard) => guard,
        Err(MirrorLockError::Busy) => {
          report.retained_busy_candidates += candidate_count(&candidate);
          continue;
        }
        Err(error) => {
          return Err(GitSyncMaintenanceError::Ownership {
            profile_id,
            message: error.to_string(),
          });
        }
      };
      distributed
        .ensure_owned("git_sync_mirror_cleanup")
        .map_err(|error| GitSyncMaintenanceError::Ownership {
          profile_id,
          message: error.to_string(),
        })?;
      let state = self.store.profile_cleanup_state(profile_id).await?;

      if candidate.canonical {
        if state.exists {
          report.retained_existing_mirrors += 1;
        } else {
          distributed
            .ensure_owned("git_sync_canonical_cleanup")
            .map_err(|error| GitSyncMaintenanceError::Ownership {
              profile_id,
              message: error.to_string(),
            })?;
          if remove_canonical_mirror(&self.repo_base, profile_id).await? {
            report.cleaned_canonical_mirrors += 1;
          }
        }
      }
      if state.has_unfinished_run {
        report.retained_unfinished_staging += candidate.staging.len();
        continue;
      }
      for staging in candidate.staging {
        distributed
          .ensure_owned("git_sync_staging_cleanup")
          .map_err(|error| GitSyncMaintenanceError::Ownership {
            profile_id,
            message: error.to_string(),
          })?;
        if remove_staging_candidate(&staging).await? {
          report.cleaned_staging += 1;
        }
      }
    }
    Ok(report)
  }
}

fn candidate_count(candidate: &ProfileCandidates) -> usize {
  usize::from(candidate.canonical) + candidate.staging.len()
}
