//! Redis-backed cache for workspace storage quota resolution.
//!
//! The quota check runs on every doc write and blob upload. Without caching
//! this means 1-2 DB queries per write. `QuotaCache` reduces the hot path
//! to O(1) by caching both the effective quota limit and the current storage
//! usage in Redis.
//!
//! ## Key layout
//!
//! | Key pattern | Value | TTL |
//! |---|---|---|
//! | `<prefix>:quota:<workspace_id>` | `{"bytes": <u64>}` | 300 s |
//! | `<prefix>:usage:<workspace_id>` | `{"snapshot": <u64>, "blob": <u64>}` | 60 s |
//!
//! ## Graceful degradation
//!
//! All operations return `None` / silently succeed on Redis errors. The cache
//! is a performance optimisation only -- the DB path remains the authoritative
//! source of truth and will be hit on any cache miss or failure.

use std::sync::Arc;

use tracing::{debug, instrument, trace, warn};
use uuid::Uuid;

use myoxus_application::ports::RedisPort;

/// Default TTL for cached quota values (5 minutes).
const QUOTA_TTL_SECONDS: u64 = 300;

/// Default TTL for cached usage values (1 minute).
const USAGE_TTL_SECONDS: u64 = 60;

/// Default TTL for cached git sync status values (2 minutes).
const GIT_STATUS_TTL_SECONDS: u64 = 120;

/// Redis-backed cache for workspace storage quota and usage.
///
/// All methods are non-blocking and degrade gracefully: Redis failures
/// result in cache misses (return `None`) rather than errors propagating
/// to the caller.
#[derive(Clone)]
pub struct QuotaCache {
  redis: Arc<dyn RedisPort>,
  prefix: String,
  quota_ttl: u64,
  usage_ttl: u64,
  git_status_ttl: u64,
}

impl QuotaCache {
  /// Create a new `QuotaCache` with default TTLs.
  pub fn new(redis: Arc<dyn RedisPort>, prefix: impl Into<String>) -> Self {
    Self {
      redis,
      prefix: prefix.into(),
      quota_ttl: QUOTA_TTL_SECONDS,
      usage_ttl: USAGE_TTL_SECONDS,
      git_status_ttl: GIT_STATUS_TTL_SECONDS,
    }
  }

  /// Create a `QuotaCache` with custom TTLs (useful for testing).
  pub fn with_ttl(redis: Arc<dyn RedisPort>, prefix: impl Into<String>, quota_ttl: u64, usage_ttl: u64) -> Self {
    Self {
      redis,
      prefix: prefix.into(),
      quota_ttl,
      usage_ttl,
      git_status_ttl: GIT_STATUS_TTL_SECONDS,
    }
  }

  /// Create a `QuotaCache` with all TTLs configurable.
  pub fn with_all_ttls(
    redis: Arc<dyn RedisPort>,
    prefix: impl Into<String>,
    quota_ttl: u64,
    usage_ttl: u64,
    git_status_ttl: u64,
  ) -> Self {
    Self {
      redis,
      prefix: prefix.into(),
      quota_ttl,
      usage_ttl,
      git_status_ttl,
    }
  }

  fn quota_key(&self, workspace_id: Uuid) -> String {
    format!("{}:quota:{}", self.prefix, workspace_id)
  }

  fn usage_key(&self, workspace_id: Uuid) -> String {
    format!("{}:usage:{}", self.prefix, workspace_id)
  }

  /// Get cached effective quota for a workspace. Returns `None` on cache miss
  /// or Redis error.
  #[instrument(skip_all, level = "trace")]
  pub async fn get_quota(&self, workspace_id: Uuid) -> Option<u64> {
    let key = self.quota_key(workspace_id);
    match self.redis.get_string(&key).await {
      Ok(Some(value)) => match serde_json::from_str::<serde_json::Value>(&value) {
        Ok(obj) => {
          let bytes = obj.get("bytes").and_then(|v| v.as_u64());
          trace!(workspace_id = %workspace_id, bytes = ?bytes, "quota cache hit");
          bytes
        }
        Err(e) => {
          warn!(workspace_id = %workspace_id, error = %e, "quota cache: invalid JSON, treating as miss");
          None
        }
      },
      Ok(None) => {
        trace!(workspace_id = %workspace_id, "quota cache miss");
        None
      }
      Err(e) => {
        warn!(workspace_id = %workspace_id, error = %e, "quota cache: Redis error on get, treating as miss");
        None
      }
    }
  }

  /// Cache the effective quota for a workspace (TTL configurable, default 300s).
  #[instrument(skip_all, level = "trace")]
  pub async fn set_quota(&self, workspace_id: Uuid, quota_bytes: u64) {
    let key = self.quota_key(workspace_id);
    let value = serde_json::json!({"bytes": quota_bytes}).to_string();
    if let Err(e) = self.redis.set_string(&key, &value, Some(self.quota_ttl)).await {
      warn!(workspace_id = %workspace_id, error = %e, "quota cache: Redis error on set, ignoring");
    } else {
      debug!(workspace_id = %workspace_id, quota_bytes, ttl = self.quota_ttl, "quota cached");
    }
  }

  /// Invalidate cached quota for a workspace.
  #[instrument(skip_all, level = "trace")]
  pub async fn invalidate(&self, workspace_id: Uuid) {
    let key = self.quota_key(workspace_id);
    if let Err(e) = self.redis.delete_key(&key).await {
      warn!(workspace_id = %workspace_id, error = %e, "quota cache: Redis error on invalidate, ignoring");
    } else {
      debug!(workspace_id = %workspace_id, "quota cache invalidated");
    }
  }

  /// Invalidate ALL cached quotas (used when global config changes).
  ///
  /// Since `RedisPort` does not expose a `SCAN`+`DEL` pattern, this method
  /// is a best-effort no-op hint. Callers should design their invalidation
  /// strategy around per-workspace invalidation via `invalidate`. For
  /// global config changes, the short TTL (300s) ensures eventual consistency.
  ///
  /// If the `RedisPort` implementation supports key scanning in the future,
  /// this method can be upgraded.
  #[instrument(skip_all, level = "trace")]
  pub async fn invalidate_all(&self) {
    // Without SCAN support on the RedisPort trait, we cannot enumerate keys.
    // Log a warning so operators know cached values will expire naturally.
    warn!(
      prefix = %self.prefix,
      quota_ttl = self.quota_ttl,
      "invalidate_all: no SCAN support on RedisPort; cached quotas will expire within TTL"
    );
  }

  /// Get cached storage usage for a workspace. Returns `None` on cache miss.
  ///
  /// Returns `(snapshot_bytes, blob_bytes)` on hit.
  #[instrument(skip_all, level = "trace")]
  pub async fn get_usage(&self, workspace_id: Uuid) -> Option<(u64, u64)> {
    let key = self.usage_key(workspace_id);
    match self.redis.get_string(&key).await {
      Ok(Some(value)) => match serde_json::from_str::<serde_json::Value>(&value) {
        Ok(obj) => {
          let snapshot = obj.get("snapshot").and_then(|v| v.as_u64())?;
          let blob = obj.get("blob").and_then(|v| v.as_u64())?;
          trace!(workspace_id = %workspace_id, snapshot, blob, "usage cache hit");
          Some((snapshot, blob))
        }
        Err(e) => {
          warn!(workspace_id = %workspace_id, error = %e, "usage cache: invalid JSON, treating as miss");
          None
        }
      },
      Ok(None) => {
        trace!(workspace_id = %workspace_id, "usage cache miss");
        None
      }
      Err(e) => {
        warn!(workspace_id = %workspace_id, error = %e, "usage cache: Redis error on get, treating as miss");
        None
      }
    }
  }

  /// Update cached storage usage (write-through, TTL configurable, default 60s).
  #[instrument(skip_all, level = "trace")]
  pub async fn set_usage(&self, workspace_id: Uuid, snapshot_bytes: u64, blob_bytes: u64) {
    let key = self.usage_key(workspace_id);
    let value = serde_json::json!({"snapshot": snapshot_bytes, "blob": blob_bytes}).to_string();
    if let Err(e) = self.redis.set_string(&key, &value, Some(self.usage_ttl)).await {
      warn!(workspace_id = %workspace_id, error = %e, "usage cache: Redis error on set, ignoring");
    } else {
      debug!(workspace_id = %workspace_id, snapshot_bytes, blob_bytes, ttl = self.usage_ttl, "usage cached");
    }
  }

  /// Invalidate cached usage for a workspace (e.g. after a blob upload or doc write).
  #[instrument(skip_all, level = "trace")]
  pub async fn invalidate_usage(&self, workspace_id: Uuid) {
    let key = self.usage_key(workspace_id);
    if let Err(e) = self.redis.delete_key(&key).await {
      warn!(workspace_id = %workspace_id, error = %e, "usage cache: Redis error on invalidate, ignoring");
    } else {
      debug!(workspace_id = %workspace_id, "usage cache invalidated");
    }
  }

  // ── P38-C: Git Sync Status Cache ─────────────────────────────────────

  fn git_status_key(&self, workspace_id: Uuid) -> String {
    format!("{}:git_status:{}", self.prefix, workspace_id)
  }

  /// Get cached git sync status for a workspace.
  /// Returns `None` on cache miss or Redis error.
  #[instrument(skip_all, level = "trace")]
  pub async fn get_git_status(&self, workspace_id: Uuid) -> Option<GitSyncStatusCached> {
    let key = self.git_status_key(workspace_id);
    match self.redis.get_string(&key).await {
      Ok(Some(json)) => GitSyncStatusCached::from_json(&json),
      Ok(None) => None,
      Err(e) => {
        trace!(workspace_id = %workspace_id, error = %e, "git_status cache miss (Redis error)");
        None
      }
    }
  }

  /// Cache git sync status (TTL configurable, default 120s).
  #[instrument(skip_all, level = "trace")]
  pub async fn set_git_status(&self, workspace_id: Uuid, status: &GitSyncStatusCached) {
    let key = self.git_status_key(workspace_id);
    if let Ok(json) = serde_json::to_string(status)
      && let Err(e) = self.redis.set_string(&key, &json, Some(self.git_status_ttl)).await
    {
      warn!(workspace_id = %workspace_id, error = %e, "git_status cache: set failed, ignoring");
    }
  }

  /// Invalidate git sync status cache (after sync run completion).
  #[instrument(skip_all, level = "trace")]
  pub async fn invalidate_git_status(&self, workspace_id: Uuid) {
    let key = self.git_status_key(workspace_id);
    if let Err(e) = self.redis.delete_key(&key).await {
      warn!(workspace_id = %workspace_id, error = %e, "git_status cache: invalidate failed, ignoring");
    }
  }
}

/// Cached git sync status for a workspace.
///
/// The schema version deliberately invalidates the historic doc-only cache
/// payload (`open_conflicts`, `total_bindings`). Mixed doc/file status must not
/// reuse stale aggregate-only JSON because that would hide file conflicts until
/// TTL expiry.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GitSyncStatusCached {
  pub schema_version: u8,
  pub open_conflicts: i32,
  pub total_bindings: i32,
  pub open_doc_conflicts: i32,
  pub open_file_conflicts: i32,
  pub total_doc_bindings: i32,
  pub total_file_bindings: i32,
  pub partial_session_id: Option<String>,
  pub partial_status: Option<String>,
  pub partial_has_more: bool,
  pub partial_total_items: i32,
  pub partial_processed_items: i32,
  pub partial_failed_items: i32,
}

impl GitSyncStatusCached {
  pub const CURRENT_SCHEMA_VERSION: u8 = 3;

  #[allow(clippy::too_many_arguments)]
  pub fn new(
    open_doc_conflicts: i32,
    open_file_conflicts: i32,
    total_doc_bindings: i32,
    total_file_bindings: i32,
    partial_session_id: Option<String>,
    partial_status: Option<String>,
    partial_has_more: bool,
    partial_total_items: i32,
    partial_processed_items: i32,
    partial_failed_items: i32,
  ) -> Self {
    Self {
      schema_version: Self::CURRENT_SCHEMA_VERSION,
      open_conflicts: open_doc_conflicts + open_file_conflicts,
      total_bindings: total_doc_bindings + total_file_bindings,
      open_doc_conflicts,
      open_file_conflicts,
      total_doc_bindings,
      total_file_bindings,
      partial_session_id,
      partial_status,
      partial_has_more,
      partial_total_items,
      partial_processed_items,
      partial_failed_items,
    }
  }

  fn from_json(json: &str) -> Option<Self> {
    let cached: Self = serde_json::from_str(json).ok()?;
    (cached.schema_version == Self::CURRENT_SCHEMA_VERSION).then_some(cached)
  }
}

impl std::fmt::Debug for QuotaCache {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("QuotaCache")
      .field("prefix", &self.prefix)
      .field("quota_ttl", &self.quota_ttl)
      .field("usage_ttl", &self.usage_ttl)
      .field("git_status_ttl", &self.git_status_ttl)
      .finish()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::redis::InMemoryRedisAdapter;

  fn test_cache() -> QuotaCache {
    let redis = Arc::new(InMemoryRedisAdapter::new("test"));
    QuotaCache::new(redis, "myoxus")
  }

  fn test_cache_with_ttl(quota_ttl: u64, usage_ttl: u64) -> QuotaCache {
    let redis = Arc::new(InMemoryRedisAdapter::new("test"));
    QuotaCache::with_ttl(redis, "myoxus", quota_ttl, usage_ttl)
  }

  #[tokio::test]
  async fn cache_miss_returns_none() {
    let cache = test_cache();
    let ws_id = Uuid::new_v4();
    assert_eq!(cache.get_quota(ws_id).await, None);
    assert_eq!(cache.get_usage(ws_id).await, None);
  }

  #[test]
  fn git_sync_status_cache_rejects_legacy_doc_only_payload() {
    let legacy = r#"{"open_conflicts":1,"total_bindings":2}"#;

    assert!(
      GitSyncStatusCached::from_json(legacy).is_none(),
      "legacy doc-only cache payload must not hide file counters"
    );
  }

  #[test]
  fn git_sync_status_cache_aggregates_explicit_doc_file_counters() {
    let cached = GitSyncStatusCached::new(
      1,
      2,
      3,
      4,
      Some("session-1".into()),
      Some("Open".into()),
      true,
      10,
      4,
      1,
    );

    assert_eq!(cached.schema_version, GitSyncStatusCached::CURRENT_SCHEMA_VERSION);
    assert_eq!(cached.open_conflicts, 3);
    assert_eq!(cached.total_bindings, 7);
    assert_eq!(cached.open_doc_conflicts, 1);
    assert_eq!(cached.open_file_conflicts, 2);
    assert_eq!(cached.total_doc_bindings, 3);
    assert_eq!(cached.total_file_bindings, 4);
    assert_eq!(cached.partial_session_id.as_deref(), Some("session-1"));
    assert_eq!(cached.partial_status.as_deref(), Some("Open"));
    assert!(cached.partial_has_more);
    assert_eq!(cached.partial_total_items, 10);
    assert_eq!(cached.partial_processed_items, 4);
    assert_eq!(cached.partial_failed_items, 1);
  }

  #[tokio::test]
  async fn set_then_get_quota_returns_value() {
    let cache = test_cache();
    let ws_id = Uuid::new_v4();
    cache.set_quota(ws_id, 1_073_741_824).await;
    assert_eq!(cache.get_quota(ws_id).await, Some(1_073_741_824));
  }

  #[tokio::test]
  async fn set_then_get_usage_returns_value() {
    let cache = test_cache();
    let ws_id = Uuid::new_v4();
    cache.set_usage(ws_id, 123_456, 789_012).await;
    assert_eq!(cache.get_usage(ws_id).await, Some((123_456, 789_012)));
  }

  #[tokio::test]
  async fn invalidate_removes_quota_entry() {
    let cache = test_cache();
    let ws_id = Uuid::new_v4();
    cache.set_quota(ws_id, 1_000_000).await;
    assert!(cache.get_quota(ws_id).await.is_some());
    cache.invalidate(ws_id).await;
    assert_eq!(cache.get_quota(ws_id).await, None);
  }

  #[tokio::test]
  async fn invalidate_usage_removes_entry() {
    let cache = test_cache();
    let ws_id = Uuid::new_v4();
    cache.set_usage(ws_id, 100, 200).await;
    assert!(cache.get_usage(ws_id).await.is_some());
    cache.invalidate_usage(ws_id).await;
    assert_eq!(cache.get_usage(ws_id).await, None);
  }

  #[tokio::test]
  async fn ttl_expires_quota_entry() {
    let cache = test_cache_with_ttl(1, 1);
    let ws_id = Uuid::new_v4();
    cache.set_quota(ws_id, 500_000).await;
    assert!(cache.get_quota(ws_id).await.is_some());
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    assert_eq!(cache.get_quota(ws_id).await, None, "quota must expire after TTL");
  }

  #[tokio::test]
  async fn ttl_expires_usage_entry() {
    let cache = test_cache_with_ttl(1, 1);
    let ws_id = Uuid::new_v4();
    cache.set_usage(ws_id, 100, 200).await;
    assert!(cache.get_usage(ws_id).await.is_some());
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    assert_eq!(cache.get_usage(ws_id).await, None, "usage must expire after TTL");
  }

  #[tokio::test]
  async fn different_workspaces_are_isolated() {
    let cache = test_cache();
    let ws1 = Uuid::new_v4();
    let ws2 = Uuid::new_v4();
    cache.set_quota(ws1, 1_000).await;
    cache.set_quota(ws2, 2_000).await;
    cache.set_usage(ws1, 10, 20).await;
    cache.set_usage(ws2, 30, 40).await;
    assert_eq!(cache.get_quota(ws1).await, Some(1_000));
    assert_eq!(cache.get_quota(ws2).await, Some(2_000));
    assert_eq!(cache.get_usage(ws1).await, Some((10, 20)));
    assert_eq!(cache.get_usage(ws2).await, Some((30, 40)));
    cache.invalidate(ws1).await;
    assert_eq!(cache.get_quota(ws1).await, None);
    assert_eq!(cache.get_quota(ws2).await, Some(2_000));
  }

  #[tokio::test]
  async fn overwrite_quota_updates_value() {
    let cache = test_cache();
    let ws_id = Uuid::new_v4();
    cache.set_quota(ws_id, 1_000).await;
    assert_eq!(cache.get_quota(ws_id).await, Some(1_000));
    cache.set_quota(ws_id, 2_000).await;
    assert_eq!(cache.get_quota(ws_id).await, Some(2_000));
  }

  #[tokio::test]
  async fn overwrite_usage_updates_value() {
    let cache = test_cache();
    let ws_id = Uuid::new_v4();
    cache.set_usage(ws_id, 100, 200).await;
    assert_eq!(cache.get_usage(ws_id).await, Some((100, 200)));
    cache.set_usage(ws_id, 300, 400).await;
    assert_eq!(cache.get_usage(ws_id).await, Some((300, 400)));
  }

  /// Graceful degradation: corrupted JSON in Redis should return None, not panic.
  #[tokio::test]
  async fn corrupted_json_returns_none() {
    let redis = Arc::new(InMemoryRedisAdapter::new("test"));
    let cache = QuotaCache::new(redis.clone(), "myoxus");
    let ws_id = Uuid::new_v4();

    // Manually inject invalid JSON via the RedisPort.
    let quota_key = format!("myoxus:quota:{}", ws_id);
    redis.set_string(&quota_key, "not-json", None).await.unwrap();
    assert_eq!(cache.get_quota(ws_id).await, None);

    let usage_key = format!("myoxus:usage:{}", ws_id);
    redis.set_string(&usage_key, "{\"snapshot\":1}", None).await.unwrap();
    // Missing "blob" field should return None.
    assert_eq!(cache.get_usage(ws_id).await, None);
  }

  /// Zero values are valid and should be cached correctly.
  #[tokio::test]
  async fn zero_values_are_cached() {
    let cache = test_cache();
    let ws_id = Uuid::new_v4();
    cache.set_quota(ws_id, 0).await;
    assert_eq!(cache.get_quota(ws_id).await, Some(0));
    cache.set_usage(ws_id, 0, 0).await;
    assert_eq!(cache.get_usage(ws_id).await, Some((0, 0)));
  }
}
