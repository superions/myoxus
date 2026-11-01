//! P102-SVC-03: DocCompactionService — snapshot compaction sub-service.
//!
//! Encapsulates the two compaction paths extracted from `DocService`:
//! - `maybe_compact` — threshold-based auto-compaction (called after each push_update).
//! - `merge_pending_updates` — explicit forced merge (CLI / admin tooling).
//!
//! This module does not import from write.rs (write calls compaction, not the other way).

use std::sync::Arc;

use tracing::{debug, info, instrument, warn};

use crate::auth::{AuthError, AuthResult};
use crate::doc::{DocCachePort, DocStore};

use uuid::Uuid;

/// Default threshold of pending updates before auto-compaction into a snapshot.
/// Can be overridden via config (P103-A-03).
pub(crate) const COMPACTION_UPDATE_THRESHOLD: usize = 500;

/// Sub-service responsible for compacting pending doc updates into snapshots.
///
/// Constructed by `DocService::new` and exposed as `DocService::compaction`.
/// Can also be injected into batch workers that only need compaction.
#[derive(Clone)]
pub struct DocCompactionService {
  pub(crate) store: Arc<dyn DocStore>,
  /// P102-CACHE-04: optional doc cache for compaction lock + post-compaction invalidation.
  pub(crate) doc_cache: Option<Arc<dyn DocCachePort>>,
  /// P103-A-03: Compaction threshold for regular docs (default: 500).
  pub(crate) threshold_default: usize,
  /// P103-A-03: Compaction threshold for root docs (doc_id == workspace_id, default: 50).
  /// Root docs are compacted more aggressively because they are loaded on every workspace open.
  pub(crate) threshold_root_doc: usize,
}

impl DocCompactionService {
  pub fn new(store: Arc<dyn DocStore>) -> Self {
    Self {
      store,
      doc_cache: None,
      threshold_default: COMPACTION_UPDATE_THRESHOLD,
      threshold_root_doc: 50,
    }
  }

  /// Attach a [`DocCachePort`] to enable distributed compaction locking and cache invalidation.
  pub fn with_doc_cache(mut self, cache: Arc<dyn DocCachePort>) -> Self {
    self.doc_cache = Some(cache);
    self
  }

  /// P103-A-03: Override compaction thresholds from config.
  pub fn with_thresholds(mut self, threshold_default: usize, threshold_root_doc: usize) -> Self {
    self.threshold_default = threshold_default;
    self.threshold_root_doc = threshold_root_doc;
    self
  }

  /// Compacts pending updates into a snapshot after the threshold is reached.
  ///
  /// **Threshold**: `COMPACTION_UPDATE_THRESHOLD` = 500 updates. The call is a
  /// no-op while the number of pending updates remains below that threshold.
  ///
  /// **Compaction side effects** (through `save_snapshot`, atomically in one
  /// transaction): limit check, snapshot upsert, delivered-update cleanup,
  /// outbox event, storage-statistics recalculation, title backfill and cache
  /// invalidation.
  ///
  /// **Non-fatal**: the central write path logs `maybe_compact` failures at
  /// WARN without propagating them. The next `push_update` retries compaction.
  pub async fn maybe_compact(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<()> {
    // P103-A-03: root docs (doc_id == workspace_id) use a lower threshold so they are
    // compacted more aggressively. All other docs use the default threshold.
    let threshold = if doc_id == workspace_id {
      self.threshold_root_doc
    } else {
      self.threshold_default
    };
    // Count first. Loading every binary payload merely to decide that the
    // threshold has not been reached turns each sync write into an unbounded
    // allocation and can exhaust the API container under concurrent clients.
    let pending_count = self.store.count_pending_updates(doc_id).await?;
    if pending_count < threshold as i64 {
      return Ok(());
    }

    // P102-CACHE-04: acquire distributed compaction lock to avoid duplicate compaction
    // across instances. If the lock is not acquired, skip (another instance is compacting).
    let lock_token = Uuid::new_v4();
    let lock_held = if let Some(cache) = &self.doc_cache {
      if !cache.acquire_compaction_lock(doc_id, lock_token).await {
        debug!(%doc_id, "compaction lock held by another instance, skipping");
        return Ok(());
      }
      true
    } else {
      false
    };

    // F-06: Perform all compaction work inside a nested async block so that the lock
    // is always released in BOTH the success and error paths.  The `?` operator inside
    // the block propagates into `compaction_result`; the lock-release runs unconditionally
    // after the block, regardless of whether the compaction succeeded.
    let compaction_result = async {
      let updates = self.store.get_updates_after(workspace_id, doc_id, -1).await?;
      if updates.is_empty() {
        return Ok(());
      }
      let last_sequence = updates.iter().map(|u| u.sequence).max().unwrap_or(0);
      let snapshot = self.store.get_snapshot(workspace_id, doc_id).await?.unwrap_or_default();

      let update_count = updates.len();
      let mut all = vec![snapshot];
      all.extend(updates.into_iter().map(|u| u.payload));

      // DBG-01-C-03: log Yjs decode failures with full context so corrupt client
      // binaries are easy to identify in production logs.
      let merged = match yjs::merge_updates(all) {
        Ok(m) => m,
        Err(e) => {
          warn!(
            %workspace_id,
            %doc_id,
            update_count,
            error = %e,
            "Yjs merge failed during compaction — likely corrupt client update binary"
          );
          return Err(AuthError::Storage(e));
        }
      };

      info!(%doc_id, last_sequence, merged_size = merged.len(), "auto-compacting doc updates into snapshot");
      self
        .store
        .save_snapshot(doc_id, workspace_id, merged, last_sequence)
        .await?;

      // P102-CACHE-01: invalidate snapshot cache after compaction (new snapshot supersedes cached one).
      if let Some(cache) = &self.doc_cache {
        cache.invalidate_snapshot(workspace_id, doc_id).await;
      }

      Ok::<(), AuthError>(())
    }
    .await;

    // Always release the lock, even when compaction failed.
    // Without this, the lock would hang until Redis TTL (60 s), blocking all
    // compaction for this doc on every instance.
    if lock_held && let Some(cache) = &self.doc_cache {
      cache.release_compaction_lock(doc_id).await;
      if compaction_result.is_err() {
        warn!(%doc_id, "compaction lock released after save_snapshot error");
      } else {
        debug!(%doc_id, "compaction lock released after successful compaction");
      }
    }

    compaction_result
  }

  /// Merge all pending updates for a doc into a new snapshot using Y.js.
  ///
  /// Returns the number of updates merged, or 0 if nothing to merge.
  /// Only merges if there are at least `min_updates` pending.
  #[instrument(skip(self))]
  pub async fn merge_pending_updates(&self, workspace_id: Uuid, doc_id: Uuid, min_updates: usize) -> AuthResult<usize> {
    let pending_count = self.store.count_pending_updates(doc_id).await?;
    if pending_count < min_updates as i64 {
      debug!(%workspace_id, %doc_id, pending_count, min_updates, "not enough pending updates to merge");
      return Ok(0);
    }

    let updates = self.store.get_updates_after(workspace_id, doc_id, -1).await?;
    if updates.is_empty() {
      return Ok(0);
    }

    let update_count = updates.len();
    let last_sequence = updates.iter().map(|u| u.sequence).max().unwrap_or(0);
    let snapshot = self.store.get_snapshot(workspace_id, doc_id).await?.unwrap_or_default();

    let mut all = vec![snapshot];
    all.extend(updates.into_iter().map(|u| u.payload));

    let merged = yjs::merge_updates(all).map_err(AuthError::Storage)?;

    info!(%doc_id, %workspace_id, update_count, last_sequence, merged_size = merged.len(), "merging pending doc updates into snapshot");
    self
      .store
      .save_snapshot(doc_id, workspace_id, merged, last_sequence)
      .await?;

    // P102-CACHE-01: invalidate snapshot cache after explicit merge.
    if let Some(cache) = &self.doc_cache {
      cache.invalidate_snapshot(workspace_id, doc_id).await;
    }

    Ok(update_count)
  }
}
