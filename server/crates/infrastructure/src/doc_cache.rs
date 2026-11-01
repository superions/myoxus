//! P102-CACHE-01..05: Redis-backed caches for document operations.
//!
//! ## Caches
//!
//! | Cache | Key pattern | Value | TTL |
//! |---|---|---|---|
//! | Snapshot (CACHE-01) | `<prefix>:doc_snapshot:<ws>:<doc>` | raw Yjs bytes (base64) | 120 s |
//! | Metadata (CACHE-02) | `<prefix>:doc_meta:<doc>` | JSON object | 60 s |
//! | Document list index | `<prefix>:document_metadata_index:<ws>:<version>` | JSON rows | configured bounded TTL |
//! | View dedup (CACHE-03) | `<prefix>:doc_view_dedup:<user>:<ws>:<doc>:<date>` | `"1"` | 86400 s (24 h) |
//! | Compaction lock (CACHE-04) | `<prefix>:doc_compact_lock:<doc>` | instance_id | 60 s |
//! | Timestamps (CACHE-05) | `<prefix>:doc_timestamps:<ws>` | JSON map | 30 s |
//!
//! ## Architecture Note (P102-CACHE-08)
//!
//! Redis keys are **globally shared** across all server instances. When one
//! instance invalidates a key (e.g. after a `push_update`), every other
//! instance automatically sees the deletion on the next cache lookup — no
//! CacheBus needed for these Redis-backed doc caches. The `CacheBus` (Redis
//! Pub/Sub) is only needed for *in-memory* (moka) caches that are local to
//! each process.
//!
//! ## Graceful degradation
//!
//! All operations return `None` / silently succeed on Redis errors. The cache
//! is a performance optimisation only — the DB path remains authoritative.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::NaiveDate;
use tracing::{debug, instrument, trace, warn};
use uuid::Uuid;

use myoxus_application::doc::DocCachePort;
use myoxus_application::ports::RedisPort;
use myoxus_domain::database::DatabasePageIdentity;
use myoxus_domain::entities::{DocumentMetadataIndexRow, DocumentMetadataProjection};

const INVENTORY_CACHE_IO_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(250);

/// Configuration for [`DocCache`] construction.
///
/// Extracted so callers can build it from `RedisConfig` without importing the
/// api-crate config types into the infrastructure crate.
pub struct RedisDocCacheConfig {
  pub snapshot_enabled: bool,
  pub snapshot_ttl: u64,
  pub snapshot_max_size_bytes: usize,
  pub metadata_enabled: bool,
  pub metadata_ttl: u64,
  pub metadata_projection_enabled: bool,
  pub metadata_projection_ttl: u64,
  pub document_metadata_index_enabled: bool,
  pub document_metadata_index_ttl: u64,
  pub document_metadata_index_max_size_bytes: usize,
  pub view_dedup_enabled: bool,
  pub compaction_lock_enabled: bool,
  pub compaction_lock_ttl: u64,
  pub timestamps_enabled: bool,
  pub timestamps_ttl: u64,
  pub timestamps_max_docs: usize,
}

/// Per-partition events observed by the Redis document cache.
///
/// Only `absent` is a TTL-relevant miss. Decode and transport failures,
/// disabled operations and values rejected by admission stay separate so the
/// tuner cannot mistake them for early expiry.
#[derive(Clone, Debug, Default)]
pub struct DocCacheEventCounters {
  pub hits: Arc<AtomicU64>,
  pub absent: Arc<AtomicU64>,
  pub decode_errors: Arc<AtomicU64>,
  pub read_errors: Arc<AtomicU64>,
  pub disabled: Arc<AtomicU64>,
  pub skipped_oversized: Arc<AtomicU64>,
  pub uncacheable: Arc<AtomicU64>,
  pub writes: Arc<AtomicU64>,
  pub write_errors: Arc<AtomicU64>,
  pub eviction_attempts: Arc<AtomicU64>,
  pub eviction_errors: Arc<AtomicU64>,
  pub evicted_keys: Arc<AtomicU64>,
  pub version_changes: Arc<AtomicU64>,
}

/// Handles for the auto-tuning engine and admin TTL overrides (P104-A).
///
/// All fields are `Arc<AtomicU64>` so the tuning cycle and the admin config
/// apply path can update TTLs at runtime without rebuilding the cache.
/// Cheap to clone — all fields are `Arc`-wrapped.
#[derive(Clone, Debug)]
pub struct DocCacheTuningHandles {
  /// Current TTL (seconds) applied to new snapshot cache entries.
  pub snapshot_ttl: Arc<AtomicU64>,
  /// Current TTL (seconds) applied to new metadata cache entries.
  pub metadata_ttl: Arc<AtomicU64>,
  pub metadata_projection_ttl: Arc<AtomicU64>,
  /// Current TTL (seconds) applied to new timestamps cache entries.
  pub timestamps_ttl: Arc<AtomicU64>,
  /// Event intervals for the four existing auto-tuned partitions.
  ///
  /// Only the tuning task may reset these counters. Status readers consume
  /// persisted tuning rows instead.
  pub snapshot_events: DocCacheEventCounters,
  pub metadata_events: DocCacheEventCounters,
  pub metadata_projection_events: DocCacheEventCounters,
  /// Fixed-TTL list-index counters; observed with the tuner cadence but never tuned.
  pub document_metadata_index_events: DocCacheEventCounters,
  /// Fixed-TTL lightweight Database inventory counters; observed, never tuned.
  pub database_page_inventory_events: DocCacheEventCounters,
  pub timestamps_events: DocCacheEventCounters,
}

impl Default for RedisDocCacheConfig {
  fn default() -> Self {
    Self {
      snapshot_enabled: true,
      snapshot_ttl: 120,
      snapshot_max_size_bytes: 10 * 1024 * 1024, // 10 MB
      metadata_enabled: true,
      metadata_ttl: 60,
      metadata_projection_enabled: true,
      metadata_projection_ttl: 60,
      document_metadata_index_enabled: true,
      document_metadata_index_ttl: 60,
      document_metadata_index_max_size_bytes: 2 * 1024 * 1024,
      view_dedup_enabled: true,
      compaction_lock_enabled: true,
      compaction_lock_ttl: 60,
      timestamps_enabled: true,
      timestamps_ttl: 30,
      timestamps_max_docs: 1000,
    }
  }
}

/// Redis-backed cache providing five doc-operation caches (P102-CACHE-01..05).
///
/// All methods degrade gracefully: Redis failures result in cache misses rather
/// than propagating errors to the caller.
#[derive(Clone)]
pub struct DocCache {
  redis: Arc<dyn RedisPort>,
  prefix: String,
  // ── Tunable TTLs (P104-A): Arc<AtomicU64> so they can be updated at runtime
  // without rebuilding the cache. The tuning cycle and admin overrides write here.
  snapshot_ttl: Arc<AtomicU64>,
  snapshot_max_size_bytes: usize,
  snapshot_enabled: bool,
  metadata_ttl: Arc<AtomicU64>,
  metadata_enabled: bool,
  metadata_projection_ttl: Arc<AtomicU64>,
  metadata_projection_enabled: bool,
  document_metadata_index_ttl: u64,
  document_metadata_index_max_size_bytes: usize,
  document_metadata_index_enabled: bool,
  view_dedup_enabled: bool,
  compaction_lock_enabled: bool,
  compaction_lock_ttl: u64,
  timestamps_ttl: Arc<AtomicU64>,
  timestamps_max_docs: usize,
  timestamps_enabled: bool,
  snapshot_events: DocCacheEventCounters,
  metadata_events: DocCacheEventCounters,
  metadata_projection_events: DocCacheEventCounters,
  document_metadata_index_events: DocCacheEventCounters,
  database_page_inventory_events: DocCacheEventCounters,
  timestamps_events: DocCacheEventCounters,
}

impl DocCache {
  /// Create a new `DocCache` from a Redis port and configuration.
  pub fn new(redis: Arc<dyn RedisPort>, prefix: impl Into<String>, config: &RedisDocCacheConfig) -> Self {
    Self {
      redis,
      prefix: prefix.into(),
      snapshot_ttl: Arc::new(AtomicU64::new(config.snapshot_ttl)),
      snapshot_max_size_bytes: config.snapshot_max_size_bytes,
      snapshot_enabled: config.snapshot_enabled,
      metadata_ttl: Arc::new(AtomicU64::new(config.metadata_ttl)),
      metadata_enabled: config.metadata_enabled,
      metadata_projection_ttl: Arc::new(AtomicU64::new(config.metadata_projection_ttl)),
      metadata_projection_enabled: config.metadata_projection_enabled,
      document_metadata_index_ttl: config.document_metadata_index_ttl,
      document_metadata_index_max_size_bytes: config.document_metadata_index_max_size_bytes,
      document_metadata_index_enabled: config.document_metadata_index_enabled,
      view_dedup_enabled: config.view_dedup_enabled,
      compaction_lock_enabled: config.compaction_lock_enabled,
      compaction_lock_ttl: config.compaction_lock_ttl,
      timestamps_ttl: Arc::new(AtomicU64::new(config.timestamps_ttl)),
      timestamps_max_docs: config.timestamps_max_docs,
      timestamps_enabled: config.timestamps_enabled,
      snapshot_events: DocCacheEventCounters::default(),
      metadata_events: DocCacheEventCounters::default(),
      metadata_projection_events: DocCacheEventCounters::default(),
      document_metadata_index_events: DocCacheEventCounters::default(),
      database_page_inventory_events: DocCacheEventCounters::default(),
      timestamps_events: DocCacheEventCounters::default(),
    }
  }

  /// Return a cheap clone of all tuning handles (Arc references to TTL atomics
  /// and hit/miss counters). Used by the auto-tuning engine and admin TTL override path.
  pub fn tuning_handles(&self) -> DocCacheTuningHandles {
    DocCacheTuningHandles {
      snapshot_ttl: Arc::clone(&self.snapshot_ttl),
      metadata_ttl: Arc::clone(&self.metadata_ttl),
      metadata_projection_ttl: Arc::clone(&self.metadata_projection_ttl),
      timestamps_ttl: Arc::clone(&self.timestamps_ttl),
      snapshot_events: self.snapshot_events.clone(),
      metadata_events: self.metadata_events.clone(),
      metadata_projection_events: self.metadata_projection_events.clone(),
      document_metadata_index_events: self.document_metadata_index_events.clone(),
      database_page_inventory_events: self.database_page_inventory_events.clone(),
      timestamps_events: self.timestamps_events.clone(),
    }
  }

  /// Snapshot counters for the fixed-TTL document-list partition.
  ///
  /// The tuning handles expose these counters for periodic observation, but
  /// the tuning decision arrays intentionally exclude the fixed-TTL partition.
  pub fn document_metadata_index_events(&self) -> DocCacheEventCounters {
    self.document_metadata_index_events.clone()
  }

  pub fn database_page_inventory_events(&self) -> DocCacheEventCounters {
    self.database_page_inventory_events.clone()
  }

  // ─── Key builders ─────────────────────────────────────────────────────────

  fn snapshot_key(&self, ws: Uuid, doc: Uuid) -> String {
    format!("{}:doc_snapshot:{}:{}", self.prefix, ws, doc)
  }

  fn metadata_key(&self, doc: Uuid) -> String {
    format!("{}:doc_meta:{}", self.prefix, doc)
  }

  fn metadata_projection_key(&self, ws: Uuid, doc: Uuid, projection_mode: &str, projection_version: &str) -> String {
    format!(
      "{}:doc_metadata_projection:{}:{}:{}:{}",
      self.prefix, ws, doc, projection_mode, projection_version
    )
  }

  fn document_metadata_index_key(&self, ws: Uuid, version: &str) -> String {
    format!("{}:document_metadata_index:{}:{}", self.prefix, ws, version)
  }

  fn database_page_inventory_key(&self, ws: Uuid, lifecycle: &str, limit: i64, offset: i64, version: &str) -> String {
    format!(
      "{}:database_page_inventory:{}:{}:{}:{}:{}",
      self.prefix, ws, lifecycle, limit, offset, version
    )
  }

  fn view_dedup_key(&self, user: Uuid, ws: Uuid, doc: &str, date: NaiveDate) -> String {
    format!("{}:doc_view_dedup:{}:{}:{}:{}", self.prefix, user, ws, doc, date)
  }

  fn compaction_lock_key(&self, doc: Uuid) -> String {
    format!("{}:doc_compact_lock:{}", self.prefix, doc)
  }

  fn timestamps_key(&self, ws: Uuid) -> String {
    format!("{}:doc_timestamps:{}", self.prefix, ws)
  }

  // ─── CACHE-01: Snapshot ───────────────────────────────────────────────────

  /// Retrieve a cached Yjs snapshot. Returns `None` on cache miss or Redis error.
  #[instrument(skip_all, level = "trace")]
  pub async fn get_snapshot(&self, ws: Uuid, doc: Uuid) -> Option<Vec<u8>> {
    if !self.snapshot_enabled {
      self.snapshot_events.disabled.fetch_add(1, Ordering::Relaxed);
      return None;
    }
    let key = self.snapshot_key(ws, doc);
    match self.redis.get_string(&key).await {
      Ok(Some(encoded)) => match BASE64.decode(&encoded) {
        Ok(bytes) => {
          self.snapshot_events.hits.fetch_add(1, Ordering::Relaxed);
          trace!(%ws, %doc, bytes = bytes.len(), "snapshot cache HIT");
          Some(bytes)
        }
        Err(e) => {
          self.snapshot_events.decode_errors.fetch_add(1, Ordering::Relaxed);
          warn!(%ws, %doc, error = %e, "snapshot cache: base64 decode error, treating as miss");
          None
        }
      },
      Ok(None) => {
        self.snapshot_events.absent.fetch_add(1, Ordering::Relaxed);
        trace!(%ws, %doc, "snapshot cache MISS");
        None
      }
      Err(e) => {
        self.snapshot_events.read_errors.fetch_add(1, Ordering::Relaxed);
        warn!(%ws, %doc, error = %e, "snapshot cache: Redis error on get, treating as miss");
        None
      }
    }
  }

  /// Store a Yjs snapshot in the cache. Skips payloads exceeding `snapshot_max_size_bytes`.
  #[instrument(skip_all, level = "trace")]
  pub async fn set_snapshot(&self, ws: Uuid, doc: Uuid, payload: &[u8]) {
    if !self.snapshot_enabled {
      self.snapshot_events.disabled.fetch_add(1, Ordering::Relaxed);
      return;
    }
    if payload.len() > self.snapshot_max_size_bytes {
      self.snapshot_events.skipped_oversized.fetch_add(1, Ordering::Relaxed);
      trace!(
        %ws, %doc,
        payload_bytes = payload.len(),
        max_bytes = self.snapshot_max_size_bytes,
        "snapshot cache: payload exceeds max size, skipping"
      );
      return;
    }
    let key = self.snapshot_key(ws, doc);
    let encoded = BASE64.encode(payload);
    let ttl = self.snapshot_ttl.load(Ordering::Acquire);
    if let Err(e) = self.redis.set_string(&key, &encoded, Some(ttl)).await {
      self.snapshot_events.write_errors.fetch_add(1, Ordering::Relaxed);
      warn!(%ws, %doc, error = %e, "snapshot cache: Redis error on set, ignoring");
    } else {
      self.snapshot_events.writes.fetch_add(1, Ordering::Relaxed);
      debug!(%ws, %doc, bytes = payload.len(), ttl, "snapshot cached");
    }
  }

  /// Invalidate the cached snapshot for a document.
  #[instrument(skip_all, level = "trace")]
  pub async fn invalidate_snapshot(&self, ws: Uuid, doc: Uuid) {
    if !self.snapshot_enabled {
      self.snapshot_events.disabled.fetch_add(1, Ordering::Relaxed);
      return;
    }
    let key = self.snapshot_key(ws, doc);
    self.snapshot_events.eviction_attempts.fetch_add(1, Ordering::Relaxed);
    if let Err(e) = self.redis.delete_key(&key).await {
      self.snapshot_events.eviction_errors.fetch_add(1, Ordering::Relaxed);
      warn!(%ws, %doc, error = %e, "snapshot cache: Redis error on invalidate, ignoring");
    } else {
      debug!(%ws, %doc, "snapshot cache invalidated");
    }
  }

  // ─── CACHE-02: Metadata ───────────────────────────────────────────────────

  /// Retrieve cached doc metadata JSON. Returns `None` on miss or error.
  #[instrument(skip_all, level = "trace")]
  pub async fn get_metadata(&self, doc: Uuid) -> Option<serde_json::Value> {
    if !self.metadata_enabled {
      self.metadata_events.disabled.fetch_add(1, Ordering::Relaxed);
      return None;
    }
    let key = self.metadata_key(doc);
    match self.redis.get_string(&key).await {
      Ok(Some(json_str)) => match serde_json::from_str(&json_str) {
        Ok(val) => {
          self.metadata_events.hits.fetch_add(1, Ordering::Relaxed);
          trace!(%doc, "metadata cache HIT");
          Some(val)
        }
        Err(e) => {
          self.metadata_events.decode_errors.fetch_add(1, Ordering::Relaxed);
          warn!(%doc, error = %e, "metadata cache: JSON parse error, treating as miss");
          None
        }
      },
      Ok(None) => {
        self.metadata_events.absent.fetch_add(1, Ordering::Relaxed);
        trace!(%doc, "metadata cache MISS");
        None
      }
      Err(e) => {
        self.metadata_events.read_errors.fetch_add(1, Ordering::Relaxed);
        warn!(%doc, error = %e, "metadata cache: Redis error on get, treating as miss");
        None
      }
    }
  }

  /// Store doc metadata JSON in the cache.
  #[instrument(skip_all, level = "trace")]
  pub async fn set_metadata(&self, doc: Uuid, meta: &serde_json::Value) {
    if !self.metadata_enabled {
      self.metadata_events.disabled.fetch_add(1, Ordering::Relaxed);
      return;
    }
    let key = self.metadata_key(doc);
    let ttl = self.metadata_ttl.load(Ordering::Acquire);
    match serde_json::to_string(meta) {
      Ok(json_str) => {
        if let Err(e) = self.redis.set_string(&key, &json_str, Some(ttl)).await {
          self.metadata_events.write_errors.fetch_add(1, Ordering::Relaxed);
          warn!(%doc, error = %e, "metadata cache: Redis error on set, ignoring");
        } else {
          self.metadata_events.writes.fetch_add(1, Ordering::Relaxed);
          debug!(%doc, ttl, "metadata cached");
        }
      }
      Err(e) => {
        self.metadata_events.uncacheable.fetch_add(1, Ordering::Relaxed);
        warn!(%doc, error = %e, "metadata cache: JSON serialization failed, ignoring");
      }
    }
  }

  /// Invalidate cached metadata for a document.
  #[instrument(skip_all, level = "trace")]
  pub async fn invalidate_metadata(&self, doc: Uuid) {
    if !self.metadata_enabled {
      self.metadata_events.disabled.fetch_add(1, Ordering::Relaxed);
      return;
    }
    let key = self.metadata_key(doc);
    self.metadata_events.eviction_attempts.fetch_add(1, Ordering::Relaxed);
    if let Err(e) = self.redis.delete_key(&key).await {
      self.metadata_events.eviction_errors.fetch_add(1, Ordering::Relaxed);
      warn!(%doc, error = %e, "metadata cache: Redis error on invalidate, ignoring");
    } else {
      debug!(%doc, "metadata cache invalidated");
    }
  }

  /// Retrieve cached canonical document metadata projection.
  #[instrument(skip_all, level = "trace")]
  pub async fn get_metadata_projection(
    &self,
    ws: Uuid,
    doc: Uuid,
    projection_mode: &str,
    projection_version: &str,
  ) -> Option<DocumentMetadataProjection> {
    if !self.metadata_projection_enabled {
      self.metadata_projection_events.disabled.fetch_add(1, Ordering::Relaxed);
      return None;
    }
    let key = self.metadata_projection_key(ws, doc, projection_mode, projection_version);
    match self.redis.get_string(&key).await {
      Ok(Some(json_str)) => match serde_json::from_str::<DocumentMetadataProjection>(&json_str) {
        Ok(value) => {
          self.metadata_projection_events.hits.fetch_add(1, Ordering::Relaxed);
          trace!(%ws, %doc, projection_mode, projection_version, "metadata projection cache HIT");
          Some(value)
        }
        Err(error) => {
          self
            .metadata_projection_events
            .decode_errors
            .fetch_add(1, Ordering::Relaxed);
          warn!(%ws, %doc, projection_mode, projection_version, %error, "metadata projection cache: JSON parse error, treating as miss");
          None
        }
      },
      Ok(None) => {
        self.metadata_projection_events.absent.fetch_add(1, Ordering::Relaxed);
        trace!(%ws, %doc, projection_mode, projection_version, "metadata projection cache MISS");
        None
      }
      Err(error) => {
        self
          .metadata_projection_events
          .read_errors
          .fetch_add(1, Ordering::Relaxed);
        warn!(%ws, %doc, projection_mode, projection_version, %error, "metadata projection cache: Redis error on get, treating as miss");
        None
      }
    }
  }

  /// Store canonical document metadata projection.
  #[instrument(skip_all, level = "trace")]
  pub async fn set_metadata_projection(
    &self,
    ws: Uuid,
    doc: Uuid,
    projection_mode: &str,
    projection_version: &str,
    projection: &DocumentMetadataProjection,
  ) {
    if !self.metadata_projection_enabled {
      self.metadata_projection_events.disabled.fetch_add(1, Ordering::Relaxed);
      return;
    }
    let key = self.metadata_projection_key(ws, doc, projection_mode, projection_version);
    let ttl = self.metadata_projection_ttl.load(Ordering::Acquire);
    match serde_json::to_string(projection) {
      Ok(json_str) => {
        if let Err(error) = self.redis.set_string(&key, &json_str, Some(ttl)).await {
          self
            .metadata_projection_events
            .write_errors
            .fetch_add(1, Ordering::Relaxed);
          warn!(%ws, %doc, projection_mode, projection_version, %error, "metadata projection cache: Redis error on set, ignoring");
        } else {
          self.metadata_projection_events.writes.fetch_add(1, Ordering::Relaxed);
          debug!(%ws, %doc, projection_mode, projection_version, ttl, "metadata projection cached");
        }
      }
      Err(error) => {
        self
          .metadata_projection_events
          .uncacheable
          .fetch_add(1, Ordering::Relaxed);
        warn!(%ws, %doc, projection_mode, projection_version, %error, "metadata projection cache: JSON serialization failed, ignoring");
      }
    }
  }

  /// Retrieve a complete actor-independent document-list projection.
  #[instrument(skip_all, level = "trace")]
  pub async fn get_document_metadata_index(
    &self,
    workspace_id: Uuid,
    version: &str,
  ) -> Option<Vec<DocumentMetadataIndexRow>> {
    if !self.document_metadata_index_enabled {
      self
        .document_metadata_index_events
        .disabled
        .fetch_add(1, Ordering::Relaxed);
      return None;
    }
    let key = self.document_metadata_index_key(workspace_id, version);
    match tokio::time::timeout(INVENTORY_CACHE_IO_TIMEOUT, self.redis.get_string(&key)).await {
      Ok(Ok(Some(json))) => match serde_json::from_str(&json) {
        Ok(rows) => {
          self.document_metadata_index_events.hits.fetch_add(1, Ordering::Relaxed);
          Some(rows)
        }
        Err(error) => {
          self
            .document_metadata_index_events
            .decode_errors
            .fetch_add(1, Ordering::Relaxed);
          warn!(%workspace_id, %error, "document metadata index cache decode failed");
          None
        }
      },
      Ok(Ok(None)) => {
        self
          .document_metadata_index_events
          .absent
          .fetch_add(1, Ordering::Relaxed);
        None
      }
      Ok(Err(error)) => {
        self
          .document_metadata_index_events
          .read_errors
          .fetch_add(1, Ordering::Relaxed);
        warn!(%workspace_id, %error, "document metadata index cache read failed");
        None
      }
      Err(_) => {
        self
          .document_metadata_index_events
          .read_errors
          .fetch_add(1, Ordering::Relaxed);
        warn!(%workspace_id, "document metadata index cache read timed out");
        None
      }
    }
  }

  /// Store a complete document-list projection. Oversized lists bypass Redis.
  #[instrument(skip_all, level = "trace")]
  pub async fn set_document_metadata_index(
    &self,
    workspace_id: Uuid,
    version: &str,
    rows: &[DocumentMetadataIndexRow],
  ) {
    if !self.document_metadata_index_enabled {
      self
        .document_metadata_index_events
        .disabled
        .fetch_add(1, Ordering::Relaxed);
      return;
    }
    let json = match serde_json::to_string(rows) {
      Ok(json) => json,
      Err(error) => {
        self
          .document_metadata_index_events
          .uncacheable
          .fetch_add(1, Ordering::Relaxed);
        warn!(%workspace_id, %error, "document metadata index cache serialization failed");
        return;
      }
    };
    if json.len() > self.document_metadata_index_max_size_bytes {
      self
        .document_metadata_index_events
        .skipped_oversized
        .fetch_add(1, Ordering::Relaxed);
      return;
    }
    let key = self.document_metadata_index_key(workspace_id, version);
    match tokio::time::timeout(
      INVENTORY_CACHE_IO_TIMEOUT,
      self
        .redis
        .set_string(&key, &json, Some(self.document_metadata_index_ttl)),
    )
    .await
    {
      Ok(Ok(())) => {
        self
          .document_metadata_index_events
          .writes
          .fetch_add(1, Ordering::Relaxed);
      }
      Ok(Err(error)) => {
        self
          .document_metadata_index_events
          .write_errors
          .fetch_add(1, Ordering::Relaxed);
        warn!(%workspace_id, %error, "document metadata index cache write failed");
      }
      Err(_) => {
        self
          .document_metadata_index_events
          .write_errors
          .fetch_add(1, Ordering::Relaxed);
        warn!(%workspace_id, "document metadata index cache write timed out");
      }
    }
  }

  /// Retrieve one count-free Database inventory page.
  #[instrument(skip_all, level = "trace")]
  pub async fn get_database_page_inventory(
    &self,
    workspace_id: Uuid,
    lifecycle: &str,
    limit: i64,
    offset: i64,
    version: &str,
  ) -> Option<Vec<DatabasePageIdentity>> {
    let events = &self.database_page_inventory_events;
    if !self.document_metadata_index_enabled {
      events.disabled.fetch_add(1, Ordering::Relaxed);
      return None;
    }
    let key = self.database_page_inventory_key(workspace_id, lifecycle, limit, offset, version);
    match tokio::time::timeout(INVENTORY_CACHE_IO_TIMEOUT, self.redis.get_string(&key)).await {
      Ok(Ok(Some(json))) => match serde_json::from_str(&json) {
        Ok(rows) => {
          events.hits.fetch_add(1, Ordering::Relaxed);
          Some(rows)
        }
        Err(error) => {
          events.decode_errors.fetch_add(1, Ordering::Relaxed);
          warn!(%workspace_id, %error, "database page inventory cache decode failed");
          None
        }
      },
      Ok(Ok(None)) => {
        events.absent.fetch_add(1, Ordering::Relaxed);
        None
      }
      Ok(Err(error)) => {
        events.read_errors.fetch_add(1, Ordering::Relaxed);
        warn!(%workspace_id, %error, "database page inventory cache read failed");
        None
      }
      Err(_) => {
        events.read_errors.fetch_add(1, Ordering::Relaxed);
        warn!(%workspace_id, "database page inventory cache read timed out");
        None
      }
    }
  }

  /// Store one count-free Database inventory page, including an empty page.
  #[instrument(skip_all, level = "trace")]
  pub async fn set_database_page_inventory(
    &self,
    workspace_id: Uuid,
    lifecycle: &str,
    limit: i64,
    offset: i64,
    version: &str,
    rows: &[DatabasePageIdentity],
  ) {
    let events = &self.database_page_inventory_events;
    if !self.document_metadata_index_enabled {
      events.disabled.fetch_add(1, Ordering::Relaxed);
      return;
    }
    let Ok(json) = serde_json::to_string(rows).inspect_err(|error| {
      events.uncacheable.fetch_add(1, Ordering::Relaxed);
      warn!(%workspace_id, %error, "database page inventory cache serialization failed");
    }) else {
      return;
    };
    if json.len() > self.document_metadata_index_max_size_bytes {
      events.skipped_oversized.fetch_add(1, Ordering::Relaxed);
      return;
    }
    let key = self.database_page_inventory_key(workspace_id, lifecycle, limit, offset, version);
    match tokio::time::timeout(
      INVENTORY_CACHE_IO_TIMEOUT,
      self
        .redis
        .set_string(&key, &json, Some(self.document_metadata_index_ttl)),
    )
    .await
    {
      Ok(Ok(())) => {
        events.writes.fetch_add(1, Ordering::Relaxed);
      }
      Ok(Err(error)) => {
        events.write_errors.fetch_add(1, Ordering::Relaxed);
        warn!(%workspace_id, %error, "database page inventory cache write failed");
      }
      Err(_) => {
        events.write_errors.fetch_add(1, Ordering::Relaxed);
        warn!(%workspace_id, "database page inventory cache write timed out");
      }
    }
  }

  /// Invalidate all projection modes/versions for one document.
  #[instrument(skip_all, level = "trace")]
  pub async fn invalidate_metadata_projection(&self, ws: Uuid, doc: Uuid) {
    if !self.metadata_projection_enabled {
      self.metadata_projection_events.disabled.fetch_add(1, Ordering::Relaxed);
      return;
    }
    // This is a logical pattern. RedisPort owns the role/deployment namespace.
    let pattern = format!("{}:doc_metadata_projection:{}:{}:*", self.prefix, ws, doc);
    self
      .metadata_projection_events
      .eviction_attempts
      .fetch_add(1, Ordering::Relaxed);
    match self.redis.delete_by_pattern(&pattern).await {
      Ok(deleted) => {
        self
          .metadata_projection_events
          .evicted_keys
          .fetch_add(deleted as u64, Ordering::Relaxed);
        debug!(%ws, %doc, deleted, "metadata projection cache invalidated");
      }
      Err(error) => {
        self
          .metadata_projection_events
          .eviction_errors
          .fetch_add(1, Ordering::Relaxed);
        warn!(%ws, %doc, %error, "metadata projection cache: Redis error on invalidate, ignoring");
      }
    }
  }

  // ─── CACHE-03: View Dedup ─────────────────────────────────────────────────

  /// Check-and-set a unique doc view for the given (user, workspace, doc, date) tuple.
  ///
  /// Returns `true` if this is the first view today (the SETNX succeeded),
  /// `false` if the key already existed (duplicate view).
  ///
  /// Falls back to `false` (non-unique) on Redis error to avoid over-counting.
  #[instrument(skip_all, level = "trace")]
  pub async fn check_and_set_view_dedup(&self, user: Uuid, ws: Uuid, doc: &str, date: NaiveDate) -> bool {
    if !self.view_dedup_enabled {
      return false;
    }
    let key = self.view_dedup_key(user, ws, doc, date);
    // TTL = 25 hours to survive date-rollover differences between instances.
    const VIEW_DEDUP_TTL: u64 = 90_000;
    match self.redis.setnx_string(&key, "1", Some(VIEW_DEDUP_TTL)).await {
      Ok(true) => {
        trace!(%user, %ws, doc, %date, "view dedup: unique view (SETNX set)");
        true
      }
      Ok(false) => {
        trace!(%user, %ws, doc, %date, "view dedup: duplicate view (key existed)");
        false
      }
      Err(e) => {
        warn!(%user, %ws, doc, %date, error = %e, "view dedup: Redis error, treating as non-unique");
        false
      }
    }
  }

  // ─── CACHE-04: Compaction Lock ────────────────────────────────────────────

  /// Try to acquire a distributed compaction lock for a document.
  ///
  /// Returns `true` if the lock was acquired, `false` if another instance
  /// already holds it or on Redis error.
  #[instrument(skip_all, level = "trace")]
  pub async fn acquire_compaction_lock(&self, doc: Uuid, instance_id: Uuid) -> bool {
    if !self.compaction_lock_enabled {
      // When disabled, always allow compaction (no distributed coordination).
      return true;
    }
    let key = self.compaction_lock_key(doc);
    let value = instance_id.to_string();
    match self
      .redis
      .setnx_string(&key, &value, Some(self.compaction_lock_ttl))
      .await
    {
      Ok(acquired) => {
        if acquired {
          debug!(%doc, %instance_id, ttl = self.compaction_lock_ttl, "compaction lock acquired");
        } else {
          trace!(%doc, "compaction lock held by another instance");
        }
        acquired
      }
      Err(e) => {
        warn!(%doc, error = %e, "compaction lock: Redis error on acquire, proceeding without lock");
        // Fail open — better to allow compaction than to deadlock.
        true
      }
    }
  }

  /// Release the compaction lock for a document.
  #[instrument(skip_all, level = "trace")]
  pub async fn release_compaction_lock(&self, doc: Uuid) {
    if !self.compaction_lock_enabled {
      return;
    }
    let key = self.compaction_lock_key(doc);
    if let Err(e) = self.redis.delete_key(&key).await {
      warn!(%doc, error = %e, "compaction lock: Redis error on release, ignoring (TTL will expire it)");
    } else {
      debug!(%doc, "compaction lock released");
    }
  }

  // ─── CACHE-05: Timestamps ─────────────────────────────────────────────────

  /// Retrieve cached doc timestamps for a workspace. Returns `None` on miss or error.
  #[instrument(skip_all, level = "trace")]
  pub async fn get_timestamps(&self, ws: Uuid) -> Option<HashMap<String, i64>> {
    if !self.timestamps_enabled {
      self.timestamps_events.disabled.fetch_add(1, Ordering::Relaxed);
      return None;
    }
    let key = self.timestamps_key(ws);
    match self.redis.get_string(&key).await {
      Ok(Some(json_str)) => match serde_json::from_str::<HashMap<String, i64>>(&json_str) {
        Ok(map) => {
          self.timestamps_events.hits.fetch_add(1, Ordering::Relaxed);
          trace!(%ws, count = map.len(), "timestamps cache HIT");
          Some(map)
        }
        Err(e) => {
          self.timestamps_events.decode_errors.fetch_add(1, Ordering::Relaxed);
          warn!(%ws, error = %e, "timestamps cache: JSON parse error, treating as miss");
          None
        }
      },
      Ok(None) => {
        self.timestamps_events.absent.fetch_add(1, Ordering::Relaxed);
        trace!(%ws, "timestamps cache MISS");
        None
      }
      Err(e) => {
        self.timestamps_events.read_errors.fetch_add(1, Ordering::Relaxed);
        warn!(%ws, error = %e, "timestamps cache: Redis error on get, treating as miss");
        None
      }
    }
  }

  /// Store doc timestamps for a workspace. Skips if the map exceeds `timestamps_max_docs`.
  #[instrument(skip_all, level = "trace")]
  pub async fn set_timestamps(&self, ws: Uuid, timestamps: &HashMap<String, i64>) {
    if !self.timestamps_enabled {
      self.timestamps_events.disabled.fetch_add(1, Ordering::Relaxed);
      return;
    }
    if timestamps.len() > self.timestamps_max_docs {
      self.timestamps_events.skipped_oversized.fetch_add(1, Ordering::Relaxed);
      trace!(
        %ws,
        count = timestamps.len(),
        max = self.timestamps_max_docs,
        "timestamps cache: map too large, skipping"
      );
      return;
    }
    let key = self.timestamps_key(ws);
    let ttl = self.timestamps_ttl.load(Ordering::Acquire);
    match serde_json::to_string(timestamps) {
      Ok(json_str) => {
        if let Err(e) = self.redis.set_string(&key, &json_str, Some(ttl)).await {
          self.timestamps_events.write_errors.fetch_add(1, Ordering::Relaxed);
          warn!(%ws, error = %e, "timestamps cache: Redis error on set, ignoring");
        } else {
          self.timestamps_events.writes.fetch_add(1, Ordering::Relaxed);
          debug!(%ws, count = timestamps.len(), ttl, "timestamps cached");
        }
      }
      Err(e) => {
        self.timestamps_events.uncacheable.fetch_add(1, Ordering::Relaxed);
        warn!(%ws, error = %e, "timestamps cache: JSON serialization failed, ignoring");
      }
    }
  }

  /// Invalidate cached timestamps for a workspace (e.g. after a doc write).
  #[instrument(skip_all, level = "trace")]
  pub async fn invalidate_timestamps(&self, ws: Uuid) {
    if !self.timestamps_enabled {
      self.timestamps_events.disabled.fetch_add(1, Ordering::Relaxed);
      return;
    }
    let key = self.timestamps_key(ws);
    self.timestamps_events.eviction_attempts.fetch_add(1, Ordering::Relaxed);
    if let Err(e) = self.redis.delete_key(&key).await {
      self.timestamps_events.eviction_errors.fetch_add(1, Ordering::Relaxed);
      warn!(%ws, error = %e, "timestamps cache: Redis error on invalidate, ignoring");
    } else {
      debug!(%ws, "timestamps cache invalidated");
    }
  }

  // ── P103-B-04: Admin flush helpers ────────────────────────────────────────

  /// Delete all snapshot cache entries for this prefix. Returns deleted count.
  #[instrument(skip_all, level = "debug")]
  pub async fn flush_snapshot_cache(&self) -> usize {
    // All flush patterns are logical DocCache keys. The Redis adapter applies
    // its configured role namespace exactly once.
    let pattern = format!("{}:doc_snapshot:*", self.prefix);
    self.snapshot_events.eviction_attempts.fetch_add(1, Ordering::Relaxed);
    match self.redis.delete_by_pattern(&pattern).await {
      Ok(n) => {
        self.snapshot_events.evicted_keys.fetch_add(n as u64, Ordering::Relaxed);
        debug!(%pattern, deleted = n, "snapshot cache flushed (P103-B-04)");
        n
      }
      Err(e) => {
        self.snapshot_events.eviction_errors.fetch_add(1, Ordering::Relaxed);
        warn!(%pattern, error = %e, "snapshot cache flush failed, returning 0");
        0
      }
    }
  }

  /// Delete all metadata cache entries for this prefix. Returns deleted count.
  #[instrument(skip_all, level = "debug")]
  pub async fn flush_metadata_cache(&self) -> usize {
    let pattern = format!("{}:doc_meta:*", self.prefix);
    self.metadata_events.eviction_attempts.fetch_add(1, Ordering::Relaxed);
    match self.redis.delete_by_pattern(&pattern).await {
      Ok(n) => {
        self.metadata_events.evicted_keys.fetch_add(n as u64, Ordering::Relaxed);
        debug!(%pattern, deleted = n, "metadata cache flushed (P103-B-04)");
        n
      }
      Err(e) => {
        self.metadata_events.eviction_errors.fetch_add(1, Ordering::Relaxed);
        warn!(%pattern, error = %e, "metadata cache flush failed, returning 0");
        0
      }
    }
  }

  /// Delete all metadata projection cache entries for this prefix. Returns deleted count.
  #[instrument(skip_all, level = "debug")]
  pub async fn flush_metadata_projection_cache(&self) -> usize {
    let pattern = format!("{}:doc_metadata_projection:*", self.prefix);
    self
      .metadata_projection_events
      .eviction_attempts
      .fetch_add(1, Ordering::Relaxed);
    match self.redis.delete_by_pattern(&pattern).await {
      Ok(n) => {
        self
          .metadata_projection_events
          .evicted_keys
          .fetch_add(n as u64, Ordering::Relaxed);
        debug!(%pattern, deleted = n, "metadata projection cache flushed");
        n
      }
      Err(e) => {
        self
          .metadata_projection_events
          .eviction_errors
          .fetch_add(1, Ordering::Relaxed);
        warn!(%pattern, error = %e, "metadata projection cache flush failed, returning 0");
        0
      }
    }
  }

  /// Delete all doc-related cache entries (snapshot, metadata, timestamps,
  /// compaction locks). Returns the total deleted count.
  #[instrument(skip_all, level = "debug")]
  pub async fn flush_all_doc_caches(&self) -> usize {
    let mut total = 0usize;
    for (suffix, events) in [
      ("doc_snapshot:*", Some(&self.snapshot_events)),
      ("doc_meta:*", Some(&self.metadata_events)),
      ("doc_metadata_projection:*", Some(&self.metadata_projection_events)),
      ("document_metadata_index:*", Some(&self.document_metadata_index_events)),
      ("database_page_inventory:*", Some(&self.database_page_inventory_events)),
      ("doc_timestamps:*", Some(&self.timestamps_events)),
      ("doc_compact_lock:*", None),
    ] {
      let pattern = format!("{}:{}", self.prefix, suffix);
      if let Some(events) = events {
        events.eviction_attempts.fetch_add(1, Ordering::Relaxed);
      }
      match self.redis.delete_by_pattern(&pattern).await {
        Ok(n) => {
          if let Some(events) = events {
            events.evicted_keys.fetch_add(n as u64, Ordering::Relaxed);
          }
          debug!(%pattern, deleted = n, "doc cache partition flushed (P103-B-04)");
          total += n;
        }
        Err(e) => {
          if let Some(events) = events {
            events.eviction_errors.fetch_add(1, Ordering::Relaxed);
          }
          warn!(%pattern, error = %e, "doc cache flush partition failed, continuing");
        }
      }
    }
    debug!(total, "all doc caches flushed (P103-B-04)");
    total
  }
}

// ── DocCachePort trait impl ───────────────────────────────────────────────────

#[async_trait]
impl DocCachePort for DocCache {
  async fn get_snapshot(&self, ws: Uuid, doc: Uuid) -> Option<Vec<u8>> {
    self.get_snapshot(ws, doc).await
  }
  async fn set_snapshot(&self, ws: Uuid, doc: Uuid, payload: &[u8]) {
    self.set_snapshot(ws, doc, payload).await
  }
  async fn invalidate_snapshot(&self, ws: Uuid, doc: Uuid) {
    self.invalidate_snapshot(ws, doc).await
  }
  async fn get_metadata(&self, doc: Uuid) -> Option<serde_json::Value> {
    self.get_metadata(doc).await
  }
  async fn set_metadata(&self, doc: Uuid, meta: &serde_json::Value) {
    self.set_metadata(doc, meta).await
  }
  async fn invalidate_metadata(&self, doc: Uuid) {
    self.invalidate_metadata(doc).await
  }
  async fn get_metadata_projection(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    projection_mode: &str,
    projection_version: &str,
  ) -> Option<DocumentMetadataProjection> {
    self
      .get_metadata_projection(workspace_id, doc_id, projection_mode, projection_version)
      .await
  }
  async fn set_metadata_projection(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    projection_mode: &str,
    projection_version: &str,
    projection: &DocumentMetadataProjection,
  ) {
    self
      .set_metadata_projection(workspace_id, doc_id, projection_mode, projection_version, projection)
      .await
  }
  async fn record_metadata_projection_version_change(&self) {
    self
      .metadata_projection_events
      .version_changes
      .fetch_add(1, Ordering::Relaxed);
  }
  async fn get_document_metadata_index(
    &self,
    workspace_id: Uuid,
    version: &str,
  ) -> Option<Vec<DocumentMetadataIndexRow>> {
    self.get_document_metadata_index(workspace_id, version).await
  }
  async fn set_document_metadata_index(&self, workspace_id: Uuid, version: &str, rows: &[DocumentMetadataIndexRow]) {
    self.set_document_metadata_index(workspace_id, version, rows).await
  }
  async fn get_database_page_inventory(
    &self,
    workspace_id: Uuid,
    lifecycle: &str,
    limit: i64,
    offset: i64,
    version: &str,
  ) -> Option<Vec<DatabasePageIdentity>> {
    self
      .get_database_page_inventory(workspace_id, lifecycle, limit, offset, version)
      .await
  }
  async fn set_database_page_inventory(
    &self,
    workspace_id: Uuid,
    lifecycle: &str,
    limit: i64,
    offset: i64,
    version: &str,
    rows: &[DatabasePageIdentity],
  ) {
    self
      .set_database_page_inventory(workspace_id, lifecycle, limit, offset, version, rows)
      .await
  }
  async fn invalidate_metadata_projection(&self, workspace_id: Uuid, doc_id: Uuid) {
    self.invalidate_metadata_projection(workspace_id, doc_id).await
  }
  async fn check_and_set_view_dedup(&self, user: Uuid, ws: Uuid, doc: &str, date: NaiveDate) -> bool {
    self.check_and_set_view_dedup(user, ws, doc, date).await
  }
  async fn acquire_compaction_lock(&self, doc: Uuid, instance_id: Uuid) -> bool {
    self.acquire_compaction_lock(doc, instance_id).await
  }
  async fn release_compaction_lock(&self, doc: Uuid) {
    self.release_compaction_lock(doc).await
  }
  async fn get_timestamps(&self, ws: Uuid) -> Option<std::collections::HashMap<String, i64>> {
    self.get_timestamps(ws).await
  }
  async fn set_timestamps(&self, ws: Uuid, timestamps: &std::collections::HashMap<String, i64>) {
    self.set_timestamps(ws, timestamps).await
  }
  async fn invalidate_timestamps(&self, ws: Uuid) {
    self.invalidate_timestamps(ws).await
  }

  // ── P103-B-04: Admin flush overrides ────────────────────────────────────────

  async fn flush_snapshot_cache(&self) -> usize {
    self.flush_snapshot_cache().await
  }

  async fn flush_metadata_cache(&self) -> usize {
    self.flush_metadata_cache().await
  }

  async fn flush_metadata_projection_cache(&self) -> usize {
    self.flush_metadata_projection_cache().await
  }

  async fn flush_all_doc_caches(&self) -> usize {
    self.flush_all_doc_caches().await
  }
}

impl std::fmt::Debug for DocCache {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("DocCache")
      .field("prefix", &self.prefix)
      .field("snapshot_enabled", &self.snapshot_enabled)
      .field("snapshot_ttl", &self.snapshot_ttl)
      .field("snapshot_max_size_bytes", &self.snapshot_max_size_bytes)
      .field("metadata_enabled", &self.metadata_enabled)
      .field("metadata_ttl", &self.metadata_ttl)
      .field("metadata_projection_enabled", &self.metadata_projection_enabled)
      .field("metadata_projection_ttl", &self.metadata_projection_ttl)
      .field("document_metadata_index_enabled", &self.document_metadata_index_enabled)
      .field("document_metadata_index_ttl", &self.document_metadata_index_ttl)
      .field(
        "document_metadata_index_max_size_bytes",
        &self.document_metadata_index_max_size_bytes,
      )
      .field("view_dedup_enabled", &self.view_dedup_enabled)
      .field("compaction_lock_enabled", &self.compaction_lock_enabled)
      .field("compaction_lock_ttl", &self.compaction_lock_ttl)
      .field("timestamps_enabled", &self.timestamps_enabled)
      .field("timestamps_ttl", &self.timestamps_ttl)
      .finish()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::redis::InMemoryRedisAdapter;
  use myoxus_domain::entities::{DocumentMetadataJournal, DocumentMetadataPolicy, DocumentMetadataSystemFacts};

  fn test_cache() -> DocCache {
    let redis = Arc::new(InMemoryRedisAdapter::new("test"));
    DocCache::new(redis, "myoxus", &RedisDocCacheConfig::default())
  }

  fn test_cache_all_disabled() -> DocCache {
    let redis = Arc::new(InMemoryRedisAdapter::new("test"));
    DocCache::new(
      redis,
      "myoxus",
      &RedisDocCacheConfig {
        snapshot_enabled: false,
        metadata_enabled: false,
        metadata_projection_enabled: false,
        view_dedup_enabled: false,
        compaction_lock_enabled: false,
        timestamps_enabled: false,
        ..Default::default()
      },
    )
  }

  fn test_projection(ws: Uuid, doc: Uuid, revision: i64) -> DocumentMetadataProjection {
    let now = chrono::Utc::now();
    DocumentMetadataProjection {
      doc_id: doc,
      workspace_id: ws,
      projection_version: String::new(),
      metadata_revision: revision,
      metadata_updated_at: Some(now),
      metadata_updated_by: None,
      system: DocumentMetadataSystemFacts {
        created_at: now,
        updated_at: now,
        created_by: None,
        updated_by: None,
        metadata_updated_at: Some(now),
        metadata_updated_by: None,
      },
      fields: Vec::new(),
      audience: Vec::new(),
      template: None,
      journal: DocumentMetadataJournal { journal_date: None },
      presentation: None,
      integration: None,
      policy: DocumentMetadataPolicy::default(),
    }
  }

  // ─── Snapshot tests ───────────────────────────────────────────────────────

  #[tokio::test]
  async fn snapshot_miss_returns_none() {
    let cache = test_cache();
    assert!(cache.get_snapshot(Uuid::new_v4(), Uuid::new_v4()).await.is_none());
  }

  #[tokio::test]
  async fn snapshot_set_then_get_roundtrips() {
    let cache = test_cache();
    let ws = Uuid::new_v4();
    let doc = Uuid::new_v4();
    let payload = b"yjs-binary-data".to_vec();
    cache.set_snapshot(ws, doc, &payload).await;
    assert_eq!(cache.get_snapshot(ws, doc).await, Some(payload));
  }

  #[tokio::test]
  async fn snapshot_invalidate_removes_entry() {
    let cache = test_cache();
    let ws = Uuid::new_v4();
    let doc = Uuid::new_v4();
    cache.set_snapshot(ws, doc, b"data").await;
    assert!(cache.get_snapshot(ws, doc).await.is_some());
    cache.invalidate_snapshot(ws, doc).await;
    assert!(cache.get_snapshot(ws, doc).await.is_none());
  }

  #[tokio::test]
  async fn snapshot_skips_oversized_payload() {
    let redis = Arc::new(InMemoryRedisAdapter::new("test"));
    let cache = DocCache::new(
      redis,
      "myoxus",
      &RedisDocCacheConfig {
        snapshot_max_size_bytes: 5,
        ..Default::default()
      },
    );
    let ws = Uuid::new_v4();
    let doc = Uuid::new_v4();
    cache.set_snapshot(ws, doc, b"123456789").await; // 9 bytes > 5 limit
    assert!(
      cache.get_snapshot(ws, doc).await.is_none(),
      "oversized payload must not be cached"
    );
  }

  #[tokio::test]
  async fn snapshot_disabled_always_misses() {
    let cache = test_cache_all_disabled();
    let ws = Uuid::new_v4();
    let doc = Uuid::new_v4();
    cache.set_snapshot(ws, doc, b"data").await;
    assert!(cache.get_snapshot(ws, doc).await.is_none());
  }

  // ─── Metadata tests ───────────────────────────────────────────────────────

  #[tokio::test]
  async fn metadata_set_then_get_roundtrips() {
    let cache = test_cache();
    let doc = Uuid::new_v4();
    let meta = serde_json::json!({"title": "Test Doc", "deleted_at": null});
    cache.set_metadata(doc, &meta).await;
    let result = cache.get_metadata(doc).await.expect("should be cached");
    assert_eq!(result["title"], "Test Doc");
  }

  #[tokio::test]
  async fn metadata_invalidate_removes_entry() {
    let cache = test_cache();
    let doc = Uuid::new_v4();
    cache.set_metadata(doc, &serde_json::json!({"x": 1})).await;
    assert!(cache.get_metadata(doc).await.is_some());
    cache.invalidate_metadata(doc).await;
    assert!(cache.get_metadata(doc).await.is_none());
  }

  #[tokio::test]
  async fn metadata_projection_mode_and_version_are_isolated() {
    let cache = test_cache();
    let ws = Uuid::new_v4();
    let doc = Uuid::new_v4();
    let native_v1 = test_projection(ws, doc, 1);
    let legacy_v1 = test_projection(ws, doc, 2);
    cache
      .set_metadata_projection(ws, doc, "myoxus-native", "v1", &native_v1)
      .await;
    cache
      .set_metadata_projection(ws, doc, "affine-legacy", "v1", &legacy_v1)
      .await;

    assert_eq!(
      cache
        .get_metadata_projection(ws, doc, "myoxus-native", "v1")
        .await
        .map(|p| p.metadata_revision),
      Some(1),
      "native projection cache entry must not collide with legacy mode"
    );
    assert_eq!(
      cache
        .get_metadata_projection(ws, doc, "affine-legacy", "v1")
        .await
        .map(|p| p.metadata_revision),
      Some(2),
      "legacy projection cache entry must not collide with native mode"
    );
    assert!(
      cache
        .get_metadata_projection(ws, doc, "myoxus-native", "v2")
        .await
        .is_none(),
      "projection_version must be part of the cache key"
    );
  }

  #[tokio::test]
  async fn metadata_projection_invalidate_and_flush_remove_entries() {
    let cache = test_cache();
    let ws = Uuid::new_v4();
    let other_ws = Uuid::new_v4();
    let doc = Uuid::new_v4();
    cache
      .set_metadata_projection(ws, doc, "myoxus-native", "v1", &test_projection(ws, doc, 1))
      .await;
    cache
      .set_metadata_projection(other_ws, doc, "myoxus-native", "v1", &test_projection(other_ws, doc, 2))
      .await;

    cache.invalidate_metadata_projection(ws, doc).await;
    assert!(
      cache
        .get_metadata_projection(ws, doc, "myoxus-native", "v1")
        .await
        .is_none(),
      "document-scoped invalidation must remove the targeted workspace/doc entry"
    );
    assert!(
      cache
        .get_metadata_projection(other_ws, doc, "myoxus-native", "v1")
        .await
        .is_some(),
      "document-scoped invalidation must not cross workspace boundaries"
    );

    assert_eq!(cache.flush_metadata_projection_cache().await, 1);
    assert!(
      cache
        .get_metadata_projection(other_ws, doc, "myoxus-native", "v1")
        .await
        .is_none(),
      "projection flush must remove remaining projection keys"
    );
  }

  // ─── View dedup tests ─────────────────────────────────────────────────────

  #[tokio::test]
  async fn view_dedup_first_call_returns_true() {
    let cache = test_cache();
    let user = Uuid::new_v4();
    let ws = Uuid::new_v4();
    let date = chrono::Utc::now().date_naive();
    let is_unique = cache.check_and_set_view_dedup(user, ws, "doc-abc", date).await;
    assert!(is_unique, "first view must be unique");
  }

  #[tokio::test]
  async fn view_dedup_second_call_returns_false() {
    let cache = test_cache();
    let user = Uuid::new_v4();
    let ws = Uuid::new_v4();
    let date = chrono::Utc::now().date_naive();
    assert!(cache.check_and_set_view_dedup(user, ws, "doc-abc", date).await);
    assert!(
      !cache.check_and_set_view_dedup(user, ws, "doc-abc", date).await,
      "duplicate view must not be unique"
    );
  }

  #[tokio::test]
  async fn view_dedup_different_users_are_isolated() {
    let cache = test_cache();
    let ws = Uuid::new_v4();
    let date = chrono::Utc::now().date_naive();
    let user1 = Uuid::new_v4();
    let user2 = Uuid::new_v4();
    assert!(cache.check_and_set_view_dedup(user1, ws, "doc", date).await);
    assert!(
      cache.check_and_set_view_dedup(user2, ws, "doc", date).await,
      "different users must each be unique"
    );
  }

  // ─── Compaction lock tests ────────────────────────────────────────────────

  #[tokio::test]
  async fn compaction_lock_first_acquire_succeeds() {
    let cache = test_cache();
    let doc = Uuid::new_v4();
    let instance = Uuid::new_v4();
    assert!(cache.acquire_compaction_lock(doc, instance).await);
  }

  #[tokio::test]
  async fn compaction_lock_second_acquire_fails() {
    let cache = test_cache();
    let doc = Uuid::new_v4();
    assert!(cache.acquire_compaction_lock(doc, Uuid::new_v4()).await);
    assert!(
      !cache.acquire_compaction_lock(doc, Uuid::new_v4()).await,
      "lock must be exclusive"
    );
  }

  #[tokio::test]
  async fn compaction_lock_release_allows_reacquire() {
    let cache = test_cache();
    let doc = Uuid::new_v4();
    let inst = Uuid::new_v4();
    assert!(cache.acquire_compaction_lock(doc, inst).await);
    cache.release_compaction_lock(doc).await;
    assert!(
      cache.acquire_compaction_lock(doc, inst).await,
      "after release, lock must be available again"
    );
  }

  #[tokio::test]
  async fn compaction_lock_disabled_always_grants() {
    let cache = test_cache_all_disabled();
    let doc = Uuid::new_v4();
    // Even "locking" twice must succeed when disabled.
    assert!(cache.acquire_compaction_lock(doc, Uuid::new_v4()).await);
    assert!(cache.acquire_compaction_lock(doc, Uuid::new_v4()).await);
  }

  // ─── Timestamps tests ─────────────────────────────────────────────────────

  #[tokio::test]
  async fn timestamps_set_then_get_roundtrips() {
    let cache = test_cache();
    let ws = Uuid::new_v4();
    let mut ts = HashMap::new();
    ts.insert("doc-abc".to_string(), 1_700_000_000_i64);
    ts.insert("doc-xyz".to_string(), 1_700_000_001_i64);
    cache.set_timestamps(ws, &ts).await;
    let cached = cache.get_timestamps(ws).await.expect("should be cached");
    assert_eq!(cached.len(), 2);
    assert_eq!(cached["doc-abc"], 1_700_000_000);
  }

  #[tokio::test]
  async fn timestamps_invalidate_removes_entry() {
    let cache = test_cache();
    let ws = Uuid::new_v4();
    let mut ts = HashMap::new();
    ts.insert("doc-abc".to_string(), 1_i64);
    cache.set_timestamps(ws, &ts).await;
    assert!(cache.get_timestamps(ws).await.is_some());
    cache.invalidate_timestamps(ws).await;
    assert!(cache.get_timestamps(ws).await.is_none());
  }

  #[tokio::test]
  async fn timestamps_skips_oversized_map() {
    let redis = Arc::new(InMemoryRedisAdapter::new("test"));
    let cache = DocCache::new(
      redis,
      "myoxus",
      &RedisDocCacheConfig {
        timestamps_max_docs: 2,
        ..Default::default()
      },
    );
    let ws = Uuid::new_v4();
    let mut ts = HashMap::new();
    ts.insert("a".to_string(), 1_i64);
    ts.insert("b".to_string(), 2_i64);
    ts.insert("c".to_string(), 3_i64); // 3 > max 2
    cache.set_timestamps(ws, &ts).await;
    assert!(
      cache.get_timestamps(ws).await.is_none(),
      "oversized map must not be cached"
    );
  }

  #[tokio::test]
  async fn different_workspaces_are_isolated() {
    let cache = test_cache();
    let ws1 = Uuid::new_v4();
    let ws2 = Uuid::new_v4();
    let doc = Uuid::new_v4();
    cache.set_snapshot(ws1, doc, b"ws1-data").await;
    cache.set_snapshot(ws2, doc, b"ws2-data").await;
    assert_eq!(cache.get_snapshot(ws1, doc).await, Some(b"ws1-data".to_vec()));
    assert_eq!(cache.get_snapshot(ws2, doc).await, Some(b"ws2-data".to_vec()));
    cache.invalidate_snapshot(ws1, doc).await;
    assert!(cache.get_snapshot(ws1, doc).await.is_none());
    assert!(
      cache.get_snapshot(ws2, doc).await.is_some(),
      "invalidating ws1 must not affect ws2"
    );
  }
}
