//! In-process query cache backed by [moka](https://docs.rs/moka).
//!
//! [`QueryCache`] holds per-key caches for hot-path DB lookups (server config,
//! user features, throttle config, and workspace settings).
//! Each cache is constructed with a configurable TTL and max capacity from
//! [`CacheConfig`].
//!
//! P84-H-IV: All cache lookups use `try_get_with()` for proper error
//! propagation — DB errors are never cached.
//!
//! P84-H-V: Each cache instance tracks hit/miss counts via atomic counters
//! exposed through [`CacheMetrics`].
//!
//! P84-I-II: Three-tier caching (moka L1 → Redis L2 → PostgreSQL L3) for user
//! features and workspace settings. The Redis L2 layer is optional — when no
//! cache Redis adapter is configured, the lookup falls through directly from
//! moka to PostgreSQL.
//!
//! P84-J-09: Dynamic TTL application via `moka::Expiry`.  moka `Cache` TTL is
//! fixed at construction.  `AtomicTtlExpiry` reads the current TTL from an
//! `Arc<AtomicU64>` on every entry creation so tuning-cycle changes take effect
//! immediately for new insertions.  When a TTL *decreases*, `invalidate_cache`
//! flushes existing entries so the shorter TTL is applied right away.
//!
//! This replaces the temporary `RwLock`/`DashMap` caches introduced in P84-D.

use dashmap::DashMap;
use moka::Expiry;
use moka::future::Cache;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

// ─── P84-J-09: Dynamic TTL expiry ─────────────────────────────────────────────

/// Reads the effective TTL from an `Arc<AtomicU64>` at entry creation time.
///
/// This allows the cache TTL to be changed at runtime (by storing a new value
/// in the atomic) without rebuilding the moka `Cache` instance.  New entries
/// will pick up the updated TTL on their next insertion.
///
/// When the TTL *decreases*, the tuning cycle also calls [`QueryCache::invalidate_cache`]
/// so that entries inserted under the old (longer) TTL are evicted immediately.
struct AtomicTtlExpiry(Arc<AtomicU64>);

impl<K, V> Expiry<K, V> for AtomicTtlExpiry {
  fn expire_after_create(&self, _key: &K, _value: &V, _created_at: Instant) -> Option<Duration> {
    Some(Duration::from_secs(self.0.load(Ordering::Acquire)))
  }
}

/// Configurable TTLs and capacities for the in-process query caches.
///
/// Loaded from the `cache` section of the YAML config.  All fields have
/// sensible defaults so the section can be omitted entirely.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(default)]
pub struct CacheConfig {
  /// TTL in seconds for cached server runtime config (default: 300).
  pub server_config_ttl_seconds: u64,
  /// TTL in seconds for per-user feature overrides (default: 120).
  pub user_features_ttl_seconds: u64,
  /// TTL in seconds for the throttle.enabled flag (default: 30).
  pub throttle_config_ttl_seconds: u64,
  /// Max entries in the user features cache (default: 50,000).
  pub user_features_max_capacity: u64,

  // ─── P84-I-II: Three-tier cache configuration ────────────────────────
  /// Moka L1 TTL for per-user feature overrides — Redis L2 layer (default: 120s).
  /// (The moka L1 TTL is `user_features_ttl_seconds` above; this controls L2.)
  pub user_features_redis_ttl_seconds: u64,
  /// Moka L1 TTL for workspace settings (default: 120s).
  pub ws_settings_ttl_seconds: u64,
  /// Redis L2 TTL for workspace settings (default: 300s).
  pub ws_settings_redis_ttl_seconds: u64,
  /// Max entries in the workspace settings cache (default: 10,000).
  pub ws_settings_max_capacity: u64,

  // ─── P84-J: Auto-tuning configuration ───────────────────────────────
  /// P84-J-10: Enable/disable hourly TTL tuning cycle (default: true).
  pub tuning_hourly_enabled: bool,
  /// P84-J-15: Enable/disable daily TTL tuning cycle (default: true).
  pub tuning_daily_enabled: bool,
  /// P84-J-08: Minimum TTL for server_config (default: 60s).
  pub server_config_min_ttl_seconds: u64,
  /// P84-J-08: Maximum TTL for server_config (default: 3600s).
  pub server_config_max_ttl_seconds: u64,
  /// P84-J-08: Minimum TTL for user_features (default: 30s).
  pub user_features_min_ttl_seconds: u64,
  /// P84-J-08: Maximum TTL for user_features (default: 600s).
  pub user_features_max_ttl_seconds: u64,
  /// P84-J-08: Minimum TTL for throttle_config (default: 10s).
  pub throttle_config_min_ttl_seconds: u64,
  /// P84-J-08: Maximum TTL for throttle_config (default: 120s).
  pub throttle_config_max_ttl_seconds: u64,
  /// P84-J-08: Minimum TTL for ws_settings (default: 30s).
  pub ws_settings_min_ttl_seconds: u64,
  /// P84-J-08: Maximum TTL for ws_settings (default: 600s).
  pub ws_settings_max_ttl_seconds: u64,

  // ─── P84-J-18: Admin fixed-TTL overrides (disables auto-tuning) ─────────
  /// P84-J-18: Fixed TTL override for server_config.
  pub server_config_fixed_ttl_seconds: Option<u64>,
  /// P84-J-18: Fixed TTL override for user_features.
  pub user_features_fixed_ttl_seconds: Option<u64>,
  /// P84-J-18: Fixed TTL override for throttle_config.
  pub throttle_config_fixed_ttl_seconds: Option<u64>,
  /// P84-J-18: Fixed TTL override for ws_settings.
  pub ws_settings_fixed_ttl_seconds: Option<u64>,

  // ─── P104-B: Doc-cache auto-tuning bounds (+100%/-50% per cycle) ─────────
  /// P104-B: Minimum TTL for doc_snapshot cache (default: 60s = 0.5× default 120s).
  pub doc_snapshot_min_ttl_seconds: u64,
  /// P104-B: Maximum TTL for doc_snapshot cache (default: 240s = 2× default 120s).
  pub doc_snapshot_max_ttl_seconds: u64,
  /// P104-B: Fixed TTL override for doc_snapshot. When set, auto-tuning is disabled.
  pub doc_snapshot_fixed_ttl_seconds: Option<u64>,
  /// P104-B: Minimum TTL for doc_metadata cache (default: 30s = 0.5× default 60s).
  pub doc_metadata_min_ttl_seconds: u64,
  /// P104-B: Maximum TTL for doc_metadata cache (default: 120s = 2× default 60s).
  pub doc_metadata_max_ttl_seconds: u64,
  /// P104-B: Fixed TTL override for doc_metadata.
  pub doc_metadata_fixed_ttl_seconds: Option<u64>,
  /// P104-B: Minimum TTL for doc_metadata_projection cache (default: 30s).
  pub doc_metadata_projection_min_ttl_seconds: u64,
  /// P104-B: Maximum TTL for doc_metadata_projection cache (default: 120s).
  pub doc_metadata_projection_max_ttl_seconds: u64,
  /// P104-B: Fixed TTL override for doc_metadata_projection.
  pub doc_metadata_projection_fixed_ttl_seconds: Option<u64>,
  /// P104-B: Minimum TTL for doc_timestamps cache (default: 15s = 0.5× default 30s).
  pub doc_timestamps_min_ttl_seconds: u64,
  /// P104-B: Maximum TTL for doc_timestamps cache (default: 60s = 2× default 30s).
  pub doc_timestamps_max_ttl_seconds: u64,
  /// P104-B: Fixed TTL override for doc_timestamps.
  pub doc_timestamps_fixed_ttl_seconds: Option<u64>,
}

impl Default for CacheConfig {
  fn default() -> Self {
    Self {
      server_config_ttl_seconds: 300,
      user_features_ttl_seconds: 120,
      throttle_config_ttl_seconds: 30,
      user_features_max_capacity: 50_000,
      // P84-I-II defaults
      user_features_redis_ttl_seconds: 300,
      ws_settings_ttl_seconds: 120,
      ws_settings_redis_ttl_seconds: 300,
      ws_settings_max_capacity: 10_000,
      // P84-J auto-tuning defaults
      tuning_hourly_enabled: true,
      tuning_daily_enabled: true,
      server_config_min_ttl_seconds: 60,
      server_config_max_ttl_seconds: 3600,
      user_features_min_ttl_seconds: 30,
      user_features_max_ttl_seconds: 600,
      throttle_config_min_ttl_seconds: 10,
      throttle_config_max_ttl_seconds: 120,
      ws_settings_min_ttl_seconds: 30,
      ws_settings_max_ttl_seconds: 600,
      // P84-J-18: fixed overrides default to None (auto-tuning enabled)
      server_config_fixed_ttl_seconds: None,
      user_features_fixed_ttl_seconds: None,
      throttle_config_fixed_ttl_seconds: None,
      ws_settings_fixed_ttl_seconds: None,
      // P104-B: doc-cache bounds (0.5×/2× of each default TTL)
      doc_snapshot_min_ttl_seconds: 60,
      doc_snapshot_max_ttl_seconds: 240,
      doc_snapshot_fixed_ttl_seconds: None,
      doc_metadata_min_ttl_seconds: 30,
      doc_metadata_max_ttl_seconds: 120,
      doc_metadata_fixed_ttl_seconds: None,
      doc_metadata_projection_min_ttl_seconds: 30,
      doc_metadata_projection_max_ttl_seconds: 120,
      doc_metadata_projection_fixed_ttl_seconds: None,
      doc_timestamps_min_ttl_seconds: 15,
      doc_timestamps_max_ttl_seconds: 60,
      doc_timestamps_fixed_ttl_seconds: None,
    }
  }
}

// ─── Per-cache metrics (H-20) ─────────────────────────────────────────────────

/// Atomic hit/miss/invalidation counters for a single cache instance.
///
/// Cloned cheaply because the inner atomics are `Arc`-wrapped.
///
/// P84-J-01: Extended with `invalidations_local` (triggered by local mutations)
/// and `invalidations_remote` (triggered by Redis Pub/Sub messages from other
/// instances) to support the cache-TTL auto-tuning system (P84-J).
#[derive(Clone, Debug)]
pub struct CacheMetrics {
  /// Cache instance name (e.g. `"server_config"`, `"user_features"`).
  pub name: &'static str,
  /// Total cache hits since last [`CacheMetrics::snapshot_and_reset`] (or process start).
  pub hits: Arc<AtomicU64>,
  /// Total cache misses since last reset.
  pub misses: Arc<AtomicU64>,
  /// Cache invalidations triggered by local mutations (this instance).
  pub invalidations_local: Arc<AtomicU64>,
  /// Cache invalidations triggered by remote Pub/Sub messages (other instances).
  pub invalidations_remote: Arc<AtomicU64>,
}

/// Point-in-time snapshot of cache metrics.  All counters are reset to zero
/// after a snapshot is taken so each snapshot covers only the interval since
/// the previous snapshot.
///
/// P84-J-03: Used by the hourly / daily TTL-tuning cycles.
#[derive(Debug, Clone)]
pub struct CacheMetricsSnapshot {
  /// Cache instance name.
  pub cache_name: String,
  /// Cache hits during the measurement interval.
  pub hits: u64,
  /// Cache misses during the measurement interval.
  pub misses: u64,
  /// Hit rate as a ratio in [0.0, 1.0].
  pub hit_rate: f64,
  /// Local invalidations during the measurement interval.
  pub invalidations_local: u64,
  /// Remote invalidations (Pub/Sub) during the measurement interval.
  pub invalidations_remote: u64,
  /// Total requests (hits + misses) during the measurement interval.
  pub total_requests: u64,
  /// When this snapshot was taken.
  pub measured_at: chrono::DateTime<chrono::Utc>,
}

impl CacheMetrics {
  fn new(name: &'static str) -> Self {
    Self {
      name,
      hits: Arc::new(AtomicU64::new(0)),
      misses: Arc::new(AtomicU64::new(0)),
      invalidations_local: Arc::new(AtomicU64::new(0)),
      invalidations_remote: Arc::new(AtomicU64::new(0)),
    }
  }

  /// Record a cache hit.
  pub fn record_hit(&self) {
    self.hits.fetch_add(1, Ordering::Relaxed);
  }

  /// Record a cache miss.
  pub fn record_miss(&self) {
    self.misses.fetch_add(1, Ordering::Relaxed);
  }

  /// Record a local cache invalidation (triggered by a mutation on this instance).
  pub fn record_invalidation_local(&self) {
    self.invalidations_local.fetch_add(1, Ordering::Relaxed);
  }

  /// Record a remote cache invalidation (triggered by a Redis Pub/Sub message).
  pub fn record_invalidation_remote(&self) {
    self.invalidations_remote.fetch_add(1, Ordering::Relaxed);
  }

  /// Total hits.
  pub fn hits_total(&self) -> u64 {
    self.hits.load(Ordering::Relaxed)
  }

  /// Total misses.
  pub fn misses_total(&self) -> u64 {
    self.misses.load(Ordering::Relaxed)
  }

  /// Total local invalidations.
  pub fn invalidations_local_total(&self) -> u64 {
    self.invalidations_local.load(Ordering::Relaxed)
  }

  /// Total remote invalidations.
  pub fn invalidations_remote_total(&self) -> u64 {
    self.invalidations_remote.load(Ordering::Relaxed)
  }

  /// Hit rate as a ratio in [0.0, 1.0].  Returns 0.0 when no lookups
  /// have been recorded yet.
  pub fn hit_rate(&self) -> f64 {
    let h = self.hits_total();
    let m = self.misses_total();
    let total = h + m;
    if total == 0 { 0.0 } else { h as f64 / total as f64 }
  }

  /// Total number of lookups (hits + misses).
  pub fn total_lookups(&self) -> u64 {
    self.hits_total() + self.misses_total()
  }

  /// Reset all counters to zero (used by the hit-rate monitoring task after
  /// each reporting window).
  pub fn reset(&self) {
    self.hits.store(0, Ordering::Relaxed);
    self.misses.store(0, Ordering::Relaxed);
    self.invalidations_local.store(0, Ordering::Relaxed);
    self.invalidations_remote.store(0, Ordering::Relaxed);
  }

  /// Atomically read all counters and reset them to zero, returning a
  /// [`CacheMetricsSnapshot`] covering the interval since the last call.
  ///
  /// P84-J-03: Used by TTL-tuning cycles to get a clean per-interval view.
  pub fn snapshot_and_reset(&self) -> CacheMetricsSnapshot {
    let hits = self.hits.swap(0, Ordering::SeqCst);
    let misses = self.misses.swap(0, Ordering::SeqCst);
    let invalidations_local = self.invalidations_local.swap(0, Ordering::SeqCst);
    let invalidations_remote = self.invalidations_remote.swap(0, Ordering::SeqCst);
    let total_requests = hits + misses;
    let hit_rate = if total_requests == 0 {
      0.0
    } else {
      hits as f64 / total_requests as f64
    };
    CacheMetricsSnapshot {
      cache_name: self.name.to_string(),
      hits,
      misses,
      hit_rate,
      invalidations_local,
      invalidations_remote,
      total_requests,
      measured_at: chrono::Utc::now(),
    }
  }
}

// ─── QueryCache ───────────────────────────────────────────────────────────────

/// In-process query caches for hot-path DB lookups.
///
/// All caches use moka's lock-free, concurrent `Cache` with time-based
/// eviction.  The struct is cheaply cloneable (inner caches are `Arc`-wrapped).
///
/// **H-18**: Callers should use `QueryCache::try_get_with_metrics` (or the
/// typed helpers on `ApiState`) which use `try_get_with()` so DB errors are
/// never cached.
///
/// **H-20**: Per-cache hit/miss counters are maintained and accessible via
/// [`QueryCache::all_metrics`].
#[derive(Clone)]
pub struct QueryCache {
  /// Cached server runtime config values (keyed by config id).
  pub server_config: Cache<String, serde_json::Value>,
  /// Cached per-user feature overrides (keyed by user UUID).
  ///
  /// The `Vec<String>` holds feature names that are activated for the user
  /// (e.g. `["unlimited_copilot"]`).
  pub user_features: Cache<(Uuid, u64, u64), Vec<String>>,
  /// Cached boolean flags from `app_configs` (e.g. `"throttle.enabled"`).
  pub throttle_config: Cache<String, bool>,

  // ─── P84-I-II: Three-tier cache instances ────────────────────────────
  /// Cached workspace settings (moka L1).
  /// Stores `(enable_ai, enable_sharing, enable_url_preview, enable_doc_embedding)`.
  pub ws_settings: Cache<(Uuid, u64, u64), WorkspaceSettingsCached>,
  user_feature_generations: Arc<KeyGenerations>,
  ws_settings_generations: Arc<KeyGenerations>,
  user_feature_population_loads: Arc<AtomicU64>,
  ws_settings_population_loads: Arc<AtomicU64>,
  /// Cached OIDC discovery documents keyed by discovery URL.
  ///
  /// Discovery metadata is runtime provider configuration, not identity data.
  /// It is cached briefly to avoid per-login metadata fetches while still
  /// allowing IdP endpoint/key-rollover changes to take effect quickly.
  pub oidc_discovery: Cache<String, serde_json::Value>,
  /// Cached OIDC JWKS documents keyed by JWKS URL.
  ///
  /// JWT validation must never cache failures. Callers use `try_get_with()` so
  /// a temporary IdP/network error cannot poison future logins.
  pub oidc_jwks: Cache<String, serde_json::Value>,

  // Per-cache metrics (H-20)
  pub metrics_server_config: CacheMetrics,
  pub metrics_user_features: CacheMetrics,
  pub metrics_throttle_config: CacheMetrics,
  pub metrics_ws_settings: CacheMetrics,

  // P84-J / P84-J-09: Current effective TTL per cache (in seconds).
  // Shared with AtomicTtlExpiry — updating the atomic immediately affects new
  // insertions.  On TTL decrease, invalidate_cache() is also called to flush
  // existing entries.  Also used by Prometheus gauge
  // `myoxus_cache_current_ttl_seconds`.
  pub current_ttl_server_config: Arc<AtomicU64>,
  pub current_ttl_user_features: Arc<AtomicU64>,
  pub current_ttl_throttle_config: Arc<AtomicU64>,
  pub current_ttl_ws_settings: Arc<AtomicU64>,
}

#[derive(Debug, Default)]
struct KeyGenerations {
  global: AtomicU64,
  keys: DashMap<Uuid, Arc<AtomicU64>>,
  fill_guards: DashMap<Uuid, Arc<Mutex<()>>>,
  global_fill_guard: Arc<RwLock<()>>,
}

impl KeyGenerations {
  fn versioned_key(&self, key: Uuid) -> (Uuid, u64, u64) {
    let generation = self
      .keys
      .entry(key)
      .or_insert_with(|| Arc::new(AtomicU64::new(0)))
      .clone();
    (
      key,
      self.global.load(Ordering::SeqCst),
      generation.load(Ordering::SeqCst),
    )
  }

  fn fill_guard(&self, key: Uuid) -> Arc<Mutex<()>> {
    self
      .fill_guards
      .entry(key)
      .or_insert_with(|| Arc::new(Mutex::new(())))
      .clone()
  }

  fn global_fill_guard(&self) -> Arc<RwLock<()>> {
    self.global_fill_guard.clone()
  }

  fn invalidate(&self, key: Uuid) {
    self
      .keys
      .entry(key)
      .or_insert_with(|| Arc::new(AtomicU64::new(0)))
      .fetch_add(1, Ordering::SeqCst);
  }

  fn invalidate_all(&self) {
    self.global.fetch_add(1, Ordering::SeqCst);
  }
}

/// Cached workspace settings for the three-tier cache.
///
/// Stored as a compact struct in moka L1 and serialised to JSON in Redis L2.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceSettingsCached {
  pub enable_ai: bool,
  pub enable_sharing: bool,
  pub enable_url_preview: bool,
  pub enable_doc_embedding: bool,
}

impl QueryCache {
  /// Build all caches from the given configuration.
  ///
  /// P84-J-09: `Arc<AtomicU64>` TTL handles are created first and shared with
  /// both the `AtomicTtlExpiry` (used by moka to compute per-entry TTLs) and
  /// the `current_ttl_*` fields (used by Prometheus and the tuning cycles).
  /// Updating a `current_ttl_*` atomic immediately affects all *new* insertions;
  /// calling [`QueryCache::invalidate_cache`] additionally evicts existing
  /// entries so a TTL decrease takes effect right away.
  pub fn new(config: &CacheConfig) -> Self {
    // Create TTL atomics first so they can be shared with the cache builders.
    let ttl_server_config = Arc::new(AtomicU64::new(config.server_config_ttl_seconds));
    let ttl_user_features = Arc::new(AtomicU64::new(config.user_features_ttl_seconds));
    let ttl_throttle_config = Arc::new(AtomicU64::new(config.throttle_config_ttl_seconds));
    let ttl_ws_settings = Arc::new(AtomicU64::new(config.ws_settings_ttl_seconds));

    Self {
      server_config: Cache::builder()
        .max_capacity(10)
        .expire_after(AtomicTtlExpiry(ttl_server_config.clone()))
        .build(),
      user_features: Cache::builder()
        .max_capacity(config.user_features_max_capacity)
        .expire_after(AtomicTtlExpiry(ttl_user_features.clone()))
        .build(),
      throttle_config: Cache::builder()
        .max_capacity(5)
        .expire_after(AtomicTtlExpiry(ttl_throttle_config.clone()))
        .build(),
      // P84-I-II: three-tier cache instance
      ws_settings: Cache::builder()
        .max_capacity(config.ws_settings_max_capacity)
        .expire_after(AtomicTtlExpiry(ttl_ws_settings.clone()))
        .build(),
      user_feature_generations: Arc::new(KeyGenerations::default()),
      ws_settings_generations: Arc::new(KeyGenerations::default()),
      user_feature_population_loads: Arc::new(AtomicU64::new(0)),
      ws_settings_population_loads: Arc::new(AtomicU64::new(0)),
      oidc_discovery: Cache::builder()
        .max_capacity(64)
        .time_to_live(Duration::from_secs(300))
        .build(),
      oidc_jwks: Cache::builder()
        .max_capacity(64)
        .time_to_live(Duration::from_secs(300))
        .build(),
      metrics_server_config: CacheMetrics::new("server_config"),
      metrics_user_features: CacheMetrics::new("user_features"),
      metrics_throttle_config: CacheMetrics::new("throttle_config"),
      metrics_ws_settings: CacheMetrics::new("ws_settings"),
      // P84-J-09: share the same atomics with the cache builders above.
      current_ttl_server_config: ttl_server_config,
      current_ttl_user_features: ttl_user_features,
      current_ttl_throttle_config: ttl_throttle_config,
      current_ttl_ws_settings: ttl_ws_settings,
    }
  }

  /// Flush all entries in the named cache (P84-J-09).
  ///
  /// Called by the tuning cycle whenever a TTL *decreases* so that entries
  /// that were inserted with the old (longer) TTL are evicted immediately.
  /// New insertions will already pick up the shorter TTL via `AtomicTtlExpiry`.
  pub fn invalidate_cache(&self, cache_name: &str) {
    match cache_name {
      "server_config" => self.server_config.invalidate_all(),
      "user_features" => self.invalidate_all_user_features(),
      "throttle_config" => self.throttle_config.invalidate_all(),
      "ws_settings" => self.invalidate_all_ws_settings(),
      "oidc_discovery" => self.oidc_discovery.invalidate_all(),
      "oidc_jwks" => self.oidc_jwks.invalidate_all(),
      _ => tracing::warn!(cache = cache_name, "invalidate_cache: unknown cache name"),
    }
  }

  /// Return the currently reachable L1 key for one user's feature projection.
  pub fn user_features_key(&self, user_id: Uuid) -> (Uuid, u64, u64) {
    self.user_feature_generations.versioned_key(user_id)
  }

  /// Return the currently reachable L1 key for one workspace's settings.
  pub fn ws_settings_key(&self, workspace_id: Uuid) -> (Uuid, u64, u64) {
    self.ws_settings_generations.versioned_key(workspace_id)
  }

  /// Serialize the final L1/L2 commit with invalidation for one user.
  pub fn user_features_fill_guard(&self, user_id: Uuid) -> Arc<Mutex<()>> {
    self.user_feature_generations.fill_guard(user_id)
  }

  /// Coordinate a feature fill with cache-wide invalidation.
  pub fn user_features_global_fill_guard(&self) -> Arc<RwLock<()>> {
    self.user_feature_generations.global_fill_guard()
  }

  /// Serialize the final L1/L2 commit with invalidation for one workspace.
  pub fn ws_settings_fill_guard(&self, workspace_id: Uuid) -> Arc<Mutex<()>> {
    self.ws_settings_generations.fill_guard(workspace_id)
  }

  /// Coordinate a settings fill with cache-wide invalidation.
  pub fn ws_settings_global_fill_guard(&self) -> Arc<RwLock<()>> {
    self.ws_settings_generations.global_fill_guard()
  }

  /// Advance one feature key so a pre-invalidation fill stays unreachable.
  pub async fn invalidate_user_features(&self, user_id: Uuid) {
    self.user_feature_generations.invalidate(user_id);
    self.user_features.invalidate(&self.user_features_key(user_id)).await;
  }

  /// Advance one settings key so a pre-invalidation fill stays unreachable.
  pub async fn invalidate_ws_settings(&self, workspace_id: Uuid) {
    self.ws_settings_generations.invalidate(workspace_id);
    self.ws_settings.invalidate(&self.ws_settings_key(workspace_id)).await;
  }

  /// Advance the feature cache-wide generation and discard all visible L1 entries.
  pub fn invalidate_all_user_features(&self) {
    self.user_feature_generations.invalidate_all();
    self.user_features.invalidate_all();
  }

  /// Advance the settings cache-wide generation and discard all visible L1 entries.
  pub fn invalidate_all_ws_settings(&self) {
    self.ws_settings_generations.invalidate_all();
    self.ws_settings.invalidate_all();
  }

  /// Record execution of the backing L2/L3 feature loader, not a freshness read.
  pub fn record_user_feature_population_load(&self) {
    self.user_feature_population_loads.fetch_add(1, Ordering::Relaxed);
  }

  /// Return backing feature loader executions for causal stampede diagnostics.
  pub fn user_feature_population_loads(&self) -> u64 {
    self.user_feature_population_loads.load(Ordering::Relaxed)
  }

  /// Record execution of the backing L2/L3 settings loader.
  pub fn record_ws_settings_population_load(&self) {
    self.ws_settings_population_loads.fetch_add(1, Ordering::Relaxed);
  }

  /// Return backing settings loader executions for causal stampede diagnostics.
  pub fn ws_settings_population_loads(&self) -> u64 {
    self.ws_settings_population_loads.load(Ordering::Relaxed)
  }

  /// Return all current TTL handles as `(name, Arc<AtomicU64>)` pairs.
  ///
  /// P84-J: Used by Prometheus gauge `myoxus_cache_current_ttl_seconds` and
  /// by the tuning cycle to enumerate and update TTL recommendations.
  pub fn all_current_ttls(&self) -> [(&'static str, &Arc<AtomicU64>); 4] {
    [
      ("server_config", &self.current_ttl_server_config),
      ("user_features", &self.current_ttl_user_features),
      ("throttle_config", &self.current_ttl_throttle_config),
      ("ws_settings", &self.current_ttl_ws_settings),
    ]
  }

  /// Return all per-cache metrics handles, useful for iterating over all
  /// caches in the Prometheus renderer.
  pub fn all_metrics(&self) -> [&CacheMetrics; 4] {
    [
      &self.metrics_server_config,
      &self.metrics_user_features,
      &self.metrics_throttle_config,
      &self.metrics_ws_settings,
    ]
  }

  /// Return `(name, entry_count)` pairs for all caches — used by the
  /// Prometheus `myoxus_cache_size` gauge.
  pub fn all_entry_counts(&self) -> [(&'static str, u64); 4] {
    [
      ("server_config", self.server_config.entry_count()),
      ("user_features", self.user_features.entry_count()),
      ("throttle_config", self.throttle_config.entry_count()),
      ("ws_settings", self.ws_settings.entry_count()),
    ]
  }

  /// Render Prometheus text-format metrics for all caches.
  ///
  /// Emits `myoxus_cache_hits_total`, `myoxus_cache_misses_total`, and
  /// `myoxus_cache_size` per cache name.
  pub fn render_prometheus(&self) -> String {
    let mut out = String::new();
    out.push_str("# TYPE myoxus_cache_hits_total counter\n");
    for m in self.all_metrics() {
      out.push_str(&format!(
        "myoxus_cache_hits_total{{cache=\"{}\"}} {}\n",
        m.name,
        m.hits_total()
      ));
    }
    out.push_str("# TYPE myoxus_cache_misses_total counter\n");
    for m in self.all_metrics() {
      out.push_str(&format!(
        "myoxus_cache_misses_total{{cache=\"{}\"}} {}\n",
        m.name,
        m.misses_total()
      ));
    }
    // P84-J-01: Invalidation counters
    out.push_str("# TYPE myoxus_cache_invalidations_local_total counter\n");
    for m in self.all_metrics() {
      out.push_str(&format!(
        "myoxus_cache_invalidations_local_total{{cache=\"{}\"}} {}\n",
        m.name,
        m.invalidations_local_total()
      ));
    }
    out.push_str("# TYPE myoxus_cache_invalidations_remote_total counter\n");
    for m in self.all_metrics() {
      out.push_str(&format!(
        "myoxus_cache_invalidations_remote_total{{cache=\"{}\"}} {}\n",
        m.name,
        m.invalidations_remote_total()
      ));
    }
    out.push_str("# TYPE myoxus_cache_size gauge\n");
    for (name, count) in self.all_entry_counts() {
      out.push_str(&format!("myoxus_cache_size{{cache=\"{}\"}} {}\n", name, count));
    }
    // P84-J-25: Current effective TTL per cache.
    out.push_str("# TYPE myoxus_cache_current_ttl_seconds gauge\n");
    for (name, ttl_atomic) in self.all_current_ttls() {
      out.push_str(&format!(
        "myoxus_cache_current_ttl_seconds{{cache=\"{}\"}} {}\n",
        name,
        ttl_atomic.load(Ordering::Acquire)
      ));
    }
    out
  }
}

impl std::fmt::Debug for QueryCache {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("QueryCache")
      .field("server_config_entries", &self.server_config.entry_count())
      .field("user_features_entries", &self.user_features.entry_count())
      .field("throttle_config_entries", &self.throttle_config.entry_count())
      .field("ws_settings_entries", &self.ws_settings.entry_count())
      .finish()
  }
}

// ─── Hit-rate monitoring (H-21) ───────────────────────────────────────────────

/// Background task that periodically checks cache hit rates and logs warnings
/// when they fall below the acceptable threshold.
///
/// This runs every `interval` (typically 5 minutes) and is the foundation for
/// the P84-J auto-tuning feature.  The task exits when `shutdown_rx` fires.
pub async fn run_cache_hit_rate_monitor(
  cache: QueryCache,
  interval: Duration,
  mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) {
  const HIT_RATE_THRESHOLD: f64 = 0.50;
  const MIN_LOOKUPS: u64 = 100;

  loop {
    tokio::select! {
        _ = tokio::time::sleep(interval) => {},
        _ = shutdown_rx.changed() => {
            tracing::debug!("cache hit-rate monitor shutting down");
            return;
        }
    }

    for m in cache.all_metrics() {
      let total = m.total_lookups();
      let rate = m.hit_rate();
      if total >= MIN_LOOKUPS && rate < HIT_RATE_THRESHOLD {
        tracing::warn!(
          cache = m.name,
          hit_rate = format!("{:.1}%", rate * 100.0),
          hits = m.hits_total(),
          misses = m.misses_total(),
          "cache hit rate below threshold — consider increasing TTL or capacity"
        );
      } else {
        tracing::debug!(
          cache = m.name,
          hit_rate = format!("{:.1}%", rate * 100.0),
          total_lookups = total,
          "cache hit-rate check"
        );
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn default_cache_config_has_expected_values() {
    let cfg = CacheConfig::default();
    assert_eq!(cfg.server_config_ttl_seconds, 300);
    assert_eq!(cfg.user_features_ttl_seconds, 120);
    assert_eq!(cfg.throttle_config_ttl_seconds, 30);
    assert_eq!(cfg.user_features_max_capacity, 50_000);
    // P84-I-II
    assert_eq!(cfg.user_features_redis_ttl_seconds, 300);
    assert_eq!(cfg.ws_settings_ttl_seconds, 120);
    assert_eq!(cfg.ws_settings_redis_ttl_seconds, 300);
    assert_eq!(cfg.ws_settings_max_capacity, 10_000);
  }

  #[tokio::test]
  async fn query_cache_insert_and_retrieve() {
    let cache = QueryCache::new(&CacheConfig::default());

    // user_features
    let uid = Uuid::new_v4();
    cache
      .user_features
      .insert(cache.user_features_key(uid), vec!["unlimited_copilot".to_string()])
      .await;
    assert_eq!(
      cache.user_features.get(&cache.user_features_key(uid)).await,
      Some(vec!["unlimited_copilot".to_string()])
    );

    // throttle_config
    cache
      .throttle_config
      .insert("throttle.enabled".to_string(), false)
      .await;
    assert_eq!(
      cache.throttle_config.get(&"throttle.enabled".to_string()).await,
      Some(false)
    );
  }

  #[tokio::test]
  async fn query_cache_invalidate_removes_entry() {
    let cache = QueryCache::new(&CacheConfig::default());
    let uid = Uuid::new_v4();
    cache
      .user_features
      .insert(cache.user_features_key(uid), vec!["unlimited_copilot".to_string()])
      .await;
    assert!(cache.user_features.get(&cache.user_features_key(uid)).await.is_some());

    cache.invalidate_user_features(uid).await;
    assert!(cache.user_features.get(&cache.user_features_key(uid)).await.is_none());
  }

  #[test]
  fn cache_metrics_hit_rate_computation() {
    let m = CacheMetrics::new("test");
    assert_eq!(m.hit_rate(), 0.0);

    // 7 hits, 3 misses → 70%
    for _ in 0..7 {
      m.record_hit();
    }
    for _ in 0..3 {
      m.record_miss();
    }
    assert_eq!(m.hits_total(), 7);
    assert_eq!(m.misses_total(), 3);
    assert!((m.hit_rate() - 0.7).abs() < f64::EPSILON);
    assert_eq!(m.total_lookups(), 10);
  }

  #[test]
  fn cache_metrics_reset() {
    let m = CacheMetrics::new("test");
    m.record_hit();
    m.record_miss();
    assert_eq!(m.total_lookups(), 2);
    m.reset();
    assert_eq!(m.total_lookups(), 0);
  }

  #[test]
  fn render_prometheus_includes_all_caches() {
    let cache = QueryCache::new(&CacheConfig::default());
    cache.metrics_server_config.record_hit();
    let prom = cache.render_prometheus();
    assert!(prom.contains("myoxus_cache_hits_total{cache=\"server_config\"} 1"));
    assert!(!prom.contains("cache=\"app_config\""));
    assert!(prom.contains("myoxus_cache_size{cache=\"user_features\"}"));
    // P84-I-II
    assert!(prom.contains("myoxus_cache_size{cache=\"ws_settings\"}"));
  }

  #[tokio::test]
  async fn ws_settings_cache_insert_and_retrieve() {
    let cache = QueryCache::new(&CacheConfig::default());
    let ws_id = Uuid::new_v4();
    let settings = WorkspaceSettingsCached {
      enable_ai: true,
      enable_sharing: false,
      enable_url_preview: true,
      enable_doc_embedding: false,
    };
    cache
      .ws_settings
      .insert(cache.ws_settings_key(ws_id), settings.clone())
      .await;
    assert_eq!(
      cache.ws_settings.get(&cache.ws_settings_key(ws_id)).await,
      Some(settings)
    );
  }
}
