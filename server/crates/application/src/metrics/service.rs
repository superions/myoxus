//! Orchestration layer that ties together the recorder, the repository, and
//! the service-layer hook API.
//!
//! The service is deliberately thin — most of the interesting logic lives in
//! [`InMemoryMetricsRecorder`].  This layer exists so that:
//!
//! * Hooks can depend on a single `Arc<MetricsService>` rather than juggling
//!   the recorder + repo pair.
//! * The flush job has a single call point (`flush_now`) that snapshots,
//!   persists, and resets atomically from the caller's perspective.
//! * Admin status / debug endpoints have one place to query live state.

use std::sync::{
  Arc,
  atomic::{AtomicU64, Ordering},
};

use chrono::{DateTime, DurationRound, NaiveDate, TimeDelta, Utc};
use myoxus_domain::metrics::{
  CacheTuningHistorySample, CacheTuningRecord, CacheTuningSnapshot, MetricsRepository, MetricsStoreResult,
};
use serde_json::{Map as JsonMap, Value};
use tracing::{debug, instrument};

use super::{
  error::MetricsError,
  models::{MetricsCategory, MetricsPolicy},
  recorder::{InMemoryMetricsRecorder, MetricsRecorder},
};

/// Aggregate outcome of one flush tick — mirrors [`crate::telemetry::FlushStats`].
#[derive(Debug, Clone, Copy, Default)]
pub struct MetricsFlushStats {
  /// Number of series taken from the recorder.
  pub buffered: u64,
  /// Number of samples persisted (== buffered on the happy path; less if the
  /// repository silently skipped rows).
  pub inserted: u64,
}

pub struct MetricsService {
  recorder: Arc<InMemoryMetricsRecorder>,
  repo: Arc<dyn MetricsRepository>,
  /// Unix-seconds of the most recent successful flush; 0 = never.
  last_flush_unix_secs: AtomicU64,
  /// Row-count of the most recent flush (regardless of success).
  last_flush_count: AtomicU64,
}

impl MetricsService {
  pub fn new(recorder: Arc<InMemoryMetricsRecorder>, repo: Arc<dyn MetricsRepository>) -> Self {
    Self {
      recorder,
      repo,
      last_flush_unix_secs: AtomicU64::new(0),
      last_flush_count: AtomicU64::new(0),
    }
  }

  pub fn recorder(&self) -> &Arc<InMemoryMetricsRecorder> {
    &self.recorder
  }

  pub fn repo(&self) -> &Arc<dyn MetricsRepository> {
    &self.repo
  }

  /// Update the live policy.  Called by the config-reload path.
  pub fn set_policy(&self, policy: MetricsPolicy) {
    self.recorder.set_policy(policy);
  }

  /// Convenience wrapper for service-layer hooks.  Builds the labels map
  /// eagerly so the call site reads like a line of business code, not a
  /// JSON-builder ritual.
  ///
  /// Usage:
  /// ```ignore
  /// service.record(MetricsCategory::Auth, "user_signup", &[("provider", "password")]);
  /// ```
  pub fn record(&self, category: MetricsCategory, metric_name: &str, labels: &[(&str, &str)]) {
    let mut map = JsonMap::with_capacity(labels.len());
    for (k, v) in labels {
      map.insert((*k).to_string(), Value::String((*v).to_string()));
    }
    self.recorder.counter_inc(category.as_str(), metric_name, map, 1.0);
  }

  /// Fine-grained hook for emitting a non-unit delta (latency accumulators,
  /// byte-count sums).  Most call sites use [`Self::record`].
  pub fn record_with(&self, category: MetricsCategory, metric_name: &str, labels: JsonMap<String, Value>, delta: f64) {
    self.recorder.counter_inc(category.as_str(), metric_name, labels, delta);
  }

  /// Unix-seconds of the most recent successful flush, or `None` if the
  /// process has never flushed.
  pub fn last_flush_unix_secs(&self) -> Option<u64> {
    let v = self.last_flush_unix_secs.load(Ordering::Relaxed);
    if v == 0 { None } else { Some(v) }
  }

  pub fn last_flush_count(&self) -> u64 {
    self.last_flush_count.load(Ordering::Relaxed)
  }

  /// Snapshot + persist + reset.  Returns the number of samples the repo
  /// accepted; any error short-circuits before the recorder is reset so that
  /// the next tick can retry without data loss (the partially-flushed rows
  /// will UPSERT idempotently in the repo — INV-MET-03).
  #[instrument(skip(self), level = "debug")]
  pub async fn flush_now(&self) -> Result<MetricsFlushStats, MetricsError> {
    let minute = Utc::now()
      .duration_trunc(TimeDelta::minutes(1))
      .unwrap_or_else(|_| Utc::now());
    let samples = self.recorder.snapshot(minute);
    let buffered = samples.len() as u64;
    if samples.is_empty() {
      debug!("metrics flush: recorder empty, nothing to persist");
      self
        .last_flush_unix_secs
        .store(Utc::now().timestamp().max(0) as u64, Ordering::Relaxed);
      self.last_flush_count.store(0, Ordering::Relaxed);
      return Ok(MetricsFlushStats {
        buffered: 0,
        inserted: 0,
      });
    }
    let inserted = self.repo.insert_minute_batch(&samples).await?;
    self.recorder.reset_after_flush();
    self
      .last_flush_unix_secs
      .store(Utc::now().timestamp().max(0) as u64, Ordering::Relaxed);
    self.last_flush_count.store(inserted, Ordering::Relaxed);
    debug!(buffered, inserted, "metrics flush complete");
    Ok(MetricsFlushStats { buffered, inserted })
  }

  /// Rollup wrapper — the worker job calls this under an advisory lock for
  /// idempotency (INV-MET-04).
  pub async fn rollup_day(&self, day: NaiveDate) -> MetricsStoreResult<u64> {
    self.repo.rollup_day(day).await
  }

  /// Retention wrapper — the worker job decides the cutoff from config.
  pub async fn prune_raw_before(&self, cutoff: DateTime<Utc>) -> MetricsStoreResult<u64> {
    let n = self.repo.prune_raw_before(cutoff).await?;
    if n > 0 {
      debug!(pruned = n, "metrics retention: metrics_raw pruned");
    }
    Ok(n)
  }

  pub async fn prune_daily_before(&self, cutoff: NaiveDate) -> MetricsStoreResult<u64> {
    let n = self.repo.prune_daily_before(cutoff).await?;
    if n > 0 {
      debug!(pruned = n, "metrics retention: metrics_daily pruned");
    }
    Ok(n)
  }

  /// Admin status: `COUNT(*)` from `metrics_raw` since cutoff.
  pub async fn count_recent(&self, since: DateTime<Utc>) -> MetricsStoreResult<u64> {
    self.repo.count_recent(since).await
  }

  pub async fn count_daily_since(&self, since: NaiveDate) -> MetricsStoreResult<u64> {
    self.repo.count_daily_since(since).await
  }

  pub async fn cache_tuning_snapshot(&self, cache_name: &str) -> MetricsStoreResult<CacheTuningSnapshot> {
    self.repo.cache_tuning_snapshot(cache_name).await
  }

  pub async fn cache_tuning_history(
    &self,
    cache_name: &str,
    hours: i64,
  ) -> MetricsStoreResult<Vec<CacheTuningHistorySample>> {
    self.repo.cache_tuning_history(cache_name, hours).await
  }

  pub async fn record_cache_tuning(&self, record: &CacheTuningRecord) -> MetricsStoreResult<()> {
    self.repo.record_cache_tuning(record).await
  }

  pub async fn cache_tuning_is_oscillating(&self, cache_name: &str) -> MetricsStoreResult<bool> {
    self.repo.cache_tuning_is_oscillating(cache_name).await
  }

  pub async fn cache_tuning_ttl_around_24h(&self, cache_name: &str) -> MetricsStoreResult<Option<i32>> {
    self.repo.cache_tuning_ttl_around_24h(cache_name).await
  }

  pub async fn prune_cache_tuning_history(&self) -> MetricsStoreResult<(u64, u64)> {
    self.repo.prune_cache_tuning_history().await
  }

  pub async fn latest_daily_cache_ttl(&self, cache_name: &str) -> MetricsStoreResult<Option<i32>> {
    self.repo.latest_daily_cache_ttl(cache_name).await
  }

  /// Number of distinct series currently held by the recorder.
  pub fn active_series(&self) -> usize {
    self.recorder.active_series()
  }

  /// Render the recorder state into Prometheus text format.  Appended by the
  /// `/metrics/prometheus` handler alongside the process-level counters.
  pub fn render_prometheus(&self) -> String {
    self.recorder.render_prometheus()
  }
}

/// No-op repository used by the in-memory service stub below and by tests
/// that only need the recorder path.
#[derive(Default)]
pub struct InMemoryMetricsRepo;

#[async_trait::async_trait]
impl MetricsRepository for InMemoryMetricsRepo {
  async fn insert_minute_batch(&self, samples: &[myoxus_domain::metrics::MetricSample]) -> MetricsStoreResult<u64> {
    Ok(samples.len() as u64)
  }
  async fn rollup_day(&self, _day: NaiveDate) -> MetricsStoreResult<u64> {
    Ok(0)
  }
  async fn prune_raw_before(&self, _cutoff: DateTime<Utc>) -> MetricsStoreResult<u64> {
    Ok(0)
  }
  async fn prune_daily_before(&self, _cutoff: NaiveDate) -> MetricsStoreResult<u64> {
    Ok(0)
  }
  async fn count_recent(&self, _since: DateTime<Utc>) -> MetricsStoreResult<u64> {
    Ok(0)
  }
  async fn count_daily_since(&self, _since: NaiveDate) -> MetricsStoreResult<u64> {
    Ok(0)
  }
  async fn cache_tuning_snapshot(&self, _cache_name: &str) -> MetricsStoreResult<CacheTuningSnapshot> {
    Ok(CacheTuningSnapshot::default())
  }
  async fn cache_tuning_history(
    &self,
    _cache_name: &str,
    _hours: i64,
  ) -> MetricsStoreResult<Vec<CacheTuningHistorySample>> {
    Ok(Vec::new())
  }
  async fn record_cache_tuning(&self, _record: &CacheTuningRecord) -> MetricsStoreResult<()> {
    Ok(())
  }
  async fn cache_tuning_is_oscillating(&self, _cache_name: &str) -> MetricsStoreResult<bool> {
    Ok(false)
  }
  async fn cache_tuning_ttl_around_24h(&self, _cache_name: &str) -> MetricsStoreResult<Option<i32>> {
    Ok(None)
  }
  async fn prune_cache_tuning_history(&self) -> MetricsStoreResult<(u64, u64)> {
    Ok((0, 0))
  }
  async fn latest_daily_cache_ttl(&self, _cache_name: &str) -> MetricsStoreResult<Option<i32>> {
    Ok(None)
  }
}

impl MetricsService {
  /// Build a metrics service backed by in-memory stores.  Used by the server
  /// bootstrap path before the real Postgres-backed repo is attached, and by
  /// tests that only care about the recorder.
  pub fn in_memory_stub() -> Self {
    let recorder = Arc::new(InMemoryMetricsRecorder::new(MetricsPolicy::default()));
    let repo: Arc<dyn MetricsRepository> = Arc::new(InMemoryMetricsRepo);
    Self::new(recorder, repo)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn policy_on() -> MetricsPolicy {
    let mut p = MetricsPolicy {
      enabled: true,
      cardinality_limit_per_metric: 100,
      ..Default::default()
    };
    for c in super::super::models::METRICS_CATEGORIES {
      p.categories.insert((*c).to_string(), true);
    }
    p
  }

  #[tokio::test]
  async fn flush_now_persists_and_resets() {
    let svc = MetricsService::in_memory_stub();
    svc.set_policy(policy_on());
    svc.record(MetricsCategory::Auth, "user_signup", &[("provider", "password")]);
    svc.record(MetricsCategory::Auth, "user_signup", &[("provider", "password")]);
    assert_eq!(svc.active_series(), 1);
    let stats = svc.flush_now().await.expect("flush");
    assert_eq!(stats.buffered, 1);
    assert_eq!(stats.inserted, 1);
    assert_eq!(svc.active_series(), 0);
    assert!(svc.last_flush_unix_secs().is_some());
    assert_eq!(svc.last_flush_count(), 1);
  }

  #[tokio::test]
  async fn flush_now_empty_is_noop_but_stamps_time() {
    let svc = MetricsService::in_memory_stub();
    svc.set_policy(policy_on());
    let stats = svc.flush_now().await.expect("flush");
    assert_eq!(stats.buffered, 0);
    assert_eq!(stats.inserted, 0);
    assert!(svc.last_flush_unix_secs().is_some());
  }
}
