//! Port traits for the business-metrics persistence pipeline.
//!
//! The application-layer recorder (`MetricsRecorder`) holds the live in-memory
//! counters; this module defines the boundary across which snapshots cross to
//! long-term storage.  Adapters live in `myoxus-infrastructure::metrics`.
//!
//! See `docs/dev/server/metrics.md` for the invariant catalog (INV-MET-01…08)
//! and `todo/metrics.md` for the implementation plan.

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::Value;
use thiserror::Error;

/// A single minute-bucket sample as produced by the recorder and consumed by
/// the flush job.
///
/// `labels` is a JSON object (never an array or scalar) — the PK on
/// `metrics_raw` depends on a deterministic labels-serialization, so the
/// recorder normalizes the map ordering before handing the record over.
#[derive(Debug, Clone)]
pub struct MetricSample {
  /// Minute-truncated bucket (`date_trunc('minute', now())`).
  pub minute: DateTime<Utc>,
  /// One of `METRICS_CATEGORIES`.
  pub category: String,
  /// Metric name (e.g. `user_signup`, `doc_create`).
  pub metric_name: String,
  /// Normalized labels map — guaranteed to be a JSON object.
  pub labels: Value,
  /// Counter delta accumulated during the minute window.
  pub value: f64,
}

/// Per-call repository errors.
#[derive(Debug, Error)]
pub enum MetricsStoreError {
  #[error("metrics store backend error: {0}")]
  Backend(String),
}

pub type MetricsStoreResult<T> = Result<T, MetricsStoreError>;

/// Aggregate cache-tuning status for one cache owner.
#[derive(Debug, Clone, Default)]
pub struct CacheTuningSnapshot {
  pub hit_rate_1h: Option<f64>,
  pub hit_rate_24h: Option<f64>,
  pub last_action: Option<String>,
  pub last_action_at: Option<DateTime<Utc>>,
}

/// One hourly cache-tuning history point.
#[derive(Debug, Clone)]
pub struct CacheTuningHistorySample {
  pub bucket: DateTime<Utc>,
  pub hit_rate: f64,
  pub ttl_seconds: i32,
}

/// Persistence record emitted by one cache-tuning cycle.
///
/// The tuning algorithm owns the recommendation; repositories only persist
/// and query its bounded operational history.
#[derive(Debug, Clone)]
pub struct CacheTuningRecord {
  pub cache_name: String,
  pub hits: i64,
  pub misses: i64,
  pub hit_rate: f64,
  pub invalidations_local: i64,
  pub invalidations_remote: i64,
  pub current_ttl_seconds: i32,
  pub recommended_ttl_seconds: i32,
  pub action_taken: String,
  pub cycle_type: String,
  pub measured_at: DateTime<Utc>,
}

/// Long-term persistence of business-metric samples and rollups.
#[async_trait]
pub trait MetricsRepository: Send + Sync {
  /// Bulk-UPSERT a flush batch into `metrics_raw`.
  ///
  /// Implementations MUST honor the `(minute, category, metric_name, labels)`
  /// UNIQUE constraint (INV-MET-03).  Conflicting rows are updated by adding
  /// the incoming `value` to the existing value — this keeps re-flushes after
  /// a partial failure accumulative rather than overwriting.  Returns the
  /// number of input samples processed (not the number of physical INSERTs).
  async fn insert_minute_batch(&self, samples: &[MetricSample]) -> MetricsStoreResult<u64>;

  /// Aggregate all `metrics_raw` rows for `day` into `metrics_daily`.
  ///
  /// Idempotent: calling twice for the same day produces identical rollups
  /// (INV-MET-04).  Implementations use `INSERT … ON CONFLICT DO UPDATE`
  /// keyed on the daily PK and recompute `sum`/`count` from the raw rows.
  /// Returns the number of daily rows written.
  async fn rollup_day(&self, day: NaiveDate) -> MetricsStoreResult<u64>;

  /// Delete `metrics_raw` rows with `minute < cutoff`.  Returns the rowcount
  /// so callers can expose it as a counter (INV-MET-05).
  async fn prune_raw_before(&self, cutoff: DateTime<Utc>) -> MetricsStoreResult<u64>;

  /// Delete `metrics_daily` rows with `day < cutoff`.  Returns the rowcount.
  async fn prune_daily_before(&self, cutoff: NaiveDate) -> MetricsStoreResult<u64>;

  /// Count `metrics_raw` rows with `minute >= since` (admin status endpoint).
  async fn count_recent(&self, since: DateTime<Utc>) -> MetricsStoreResult<u64>;

  /// Count `metrics_daily` rows with `day >= since` (admin status endpoint).
  async fn count_daily_since(&self, since: NaiveDate) -> MetricsStoreResult<u64>;

  /// Return recent tuning aggregates and the newest action for one cache.
  async fn cache_tuning_snapshot(&self, cache_name: &str) -> MetricsStoreResult<CacheTuningSnapshot>;

  /// Return hourly tuning history for one cache over a bounded window.
  async fn cache_tuning_history(
    &self,
    cache_name: &str,
    hours: i64,
  ) -> MetricsStoreResult<Vec<CacheTuningHistorySample>>;

  /// Persist one cache-tuning decision for operational history and guards.
  async fn record_cache_tuning(&self, record: &CacheTuningRecord) -> MetricsStoreResult<()>;

  /// Detect a recent increase/decrease oscillation for an hourly tuner.
  async fn cache_tuning_is_oscillating(&self, cache_name: &str) -> MetricsStoreResult<bool>;

  /// Return the TTL observed around 24 hours ago, when available.
  async fn cache_tuning_ttl_around_24h(&self, cache_name: &str) -> MetricsStoreResult<Option<i32>>;

  /// Delete expired hourly and daily tuning history in one repository call.
  async fn prune_cache_tuning_history(&self) -> MetricsStoreResult<(u64, u64)>;

  /// Return the latest fresh daily recommendation used during startup.
  async fn latest_daily_cache_ttl(&self, cache_name: &str) -> MetricsStoreResult<Option<i32>>;
}
