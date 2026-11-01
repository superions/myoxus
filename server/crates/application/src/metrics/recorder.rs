//! In-memory metrics recorder with cardinality guard and Prometheus rendering.
//!
//! Invariants enforced here (see `docs/dev/server/metrics.md`):
//!
//! * INV-MET-01 — `counter_inc` with a disabled category is a no-op before
//!   the hash-map lookup happens.
//! * INV-MET-06 — per-metric cardinality is hard-capped; samples beyond the
//!   limit are dropped and counted in `cardinality_drops_total`.
//! * INV-MET-08 — recorder never walks `labels` to look for PII.  Callers are
//!   responsible for passing only allow-listed, non-PII labels; the recorder's
//!   cardinality guard protects against *accidental* PII leakage via unique
//!   user-IDs-as-labels (which would explode cardinality long before reaching
//!   a meaningful PII volume).

use std::{
  collections::BTreeMap,
  sync::{
    Arc, RwLock,
    atomic::{AtomicU64, Ordering},
  },
};

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use myoxus_domain::metrics::MetricSample;
use serde_json::{Map as JsonMap, Value};
use tracing::warn;

use super::models::MetricsPolicy;

/// Aggregated counters maintained alongside per-series state — rendered into
/// `/metrics/prometheus` and surfaced in the admin status endpoint.
#[derive(Default, Debug)]
pub struct MetricsCounters {
  /// Total calls to `counter_inc` (accepted + dropped).  Useful to spot
  /// hot loops at a glance.
  pub offered_total: AtomicU64,
  /// Calls that actually landed in a series.
  pub accepted_total: AtomicU64,
  /// Calls rejected because the category was disabled (INV-MET-01).
  pub rejected_disabled_total: AtomicU64,
  /// Samples dropped by the cardinality guard (INV-MET-06) — exposed as
  /// `myoxus_metrics_cardinality_drops_total`.
  pub cardinality_drops_total: AtomicU64,
  /// Total snapshots produced (≈ flush ticks served).
  pub snapshots_total: AtomicU64,
}

/// Trait abstraction over the concrete in-memory implementation.  Kept small
/// so the flush job and Prometheus exporter can depend on a single interface
/// and so tests can plug in fakes.
pub trait MetricsRecorder: Send + Sync {
  /// Record a single delta.  `labels` is the caller's raw map — the recorder
  /// normalizes key order (BTreeMap) before storing.
  fn counter_inc(&self, category: &str, metric_name: &str, labels: JsonMap<String, Value>, delta: f64);

  /// Flush-ready snapshot of every active series, bucketed to `minute`.
  /// The returned vector is consumed by the flush job (`insert_minute_batch`).
  fn snapshot(&self, minute: DateTime<Utc>) -> Vec<MetricSample>;

  /// Read-only view of every active series, bucketed to `minute`.
  ///
  /// This is intentionally separate from [`Self::snapshot`]: admin live
  /// status polling must be diagnostic-only and must not increment
  /// flush/snapshot counters or otherwise mutate recorder accounting.
  fn inspect_series(&self, minute: DateTime<Utc>) -> Vec<MetricSample>;

  /// Clear all accumulated counters.  Called by the flush job immediately
  /// after `insert_minute_batch` succeeds so the next minute bucket starts
  /// from zero.
  fn reset_after_flush(&self);

  /// Cumulative counters used by the admin status endpoint and the Prometheus
  /// exporter (`myoxus_metrics_*_total`).
  fn counters(&self) -> &MetricsCounters;

  /// Current number of distinct series across all metrics.  Used by tests
  /// and by the admin live-stats widget.
  fn active_series(&self) -> usize;

  /// Render the running counters in Prometheus text format 0.0.4.  Appended
  /// to `/metrics/prometheus` next to the existing process-level metrics.
  fn render_prometheus(&self) -> String;
}

/// Key used to identify a single series within a metric.
///
/// A canonical JSON serialization of the labels map is used so that two hooks
/// that emit the same logical labels in different insertion orders collapse
/// onto the same series.
type SeriesKey = (String, String, String); // (category, metric_name, labels_canonical)

/// DashMap-backed recorder.  One entry per active series.
///
/// The underlying `DashMap` provides concurrent-safe inserts; we intentionally
/// store `f64` by encoding it into an `AtomicU64` bit-pattern so that CAS
/// loops stay lock-free on the hot path (service-layer hooks must not block).
pub struct InMemoryMetricsRecorder {
  /// `(category, name, labels_canonical) → bit-packed f64 counter`.
  series: DashMap<SeriesKey, Arc<AtomicU64>>,
  /// Per-metric series count (used for the cardinality guard).
  /// Key = `(category, metric_name)`, value = live series count.
  cardinality: DashMap<(String, String), AtomicU64>,
  /// Cumulative counters exposed via `counters()`.
  counters: MetricsCounters,
  /// Snapshot of the runtime policy.  Callers update via `set_policy` on
  /// config reload.  Read path is a short read-guard + Arc clone; the write
  /// path (config reload) is rare enough that RwLock contention is trivial.
  policy: RwLock<Arc<MetricsPolicy>>,
}

impl InMemoryMetricsRecorder {
  pub fn new(policy: MetricsPolicy) -> Self {
    Self {
      series: DashMap::new(),
      cardinality: DashMap::new(),
      counters: MetricsCounters::default(),
      policy: RwLock::new(Arc::new(policy)),
    }
  }

  /// Replace the live policy snapshot — called by the config-reload path.
  pub fn set_policy(&self, policy: MetricsPolicy) {
    *self.policy.write().expect("metrics policy lock poisoned") = Arc::new(policy);
  }

  /// Borrow the current policy snapshot (cheap — Arc clone under the hood).
  pub fn policy(&self) -> Arc<MetricsPolicy> {
    self.policy.read().expect("metrics policy lock poisoned").clone()
  }

  /// Serialize a labels map deterministically so that two calls with the
  /// same keys in different insertion orders produce the same canonical
  /// form.  Uses `BTreeMap` to sort keys, then `to_string` for a compact
  /// UTF-8 representation.
  fn canonicalize_labels(labels: &JsonMap<String, Value>) -> String {
    let sorted: BTreeMap<&String, &Value> = labels.iter().collect();
    serde_json::to_string(&sorted).unwrap_or_else(|_| "{}".to_string())
  }

  /// Deterministically rebuild the labels JSON from the canonical string.
  fn deserialize_canonical(canonical: &str) -> Value {
    serde_json::from_str(canonical).unwrap_or(Value::Object(JsonMap::new()))
  }

  /// CAS-loop add for an `AtomicU64` holding an `f64` bit-pattern.
  fn atomic_add_f64(counter: &AtomicU64, delta: f64) -> f64 {
    loop {
      let current_bits = counter.load(Ordering::Relaxed);
      let current = f64::from_bits(current_bits);
      let new = current + delta;
      let new_bits = new.to_bits();
      if counter
        .compare_exchange_weak(current_bits, new_bits, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
      {
        return new;
      }
    }
  }

  /// Collect active series without touching counters or lifecycle state.
  fn collect_samples(&self, minute: DateTime<Utc>) -> Vec<MetricSample> {
    self
      .series
      .iter()
      .map(|entry| {
        let (category, metric_name, canonical) = entry.key();
        let value = f64::from_bits(entry.value().load(Ordering::Relaxed));
        MetricSample {
          minute,
          category: category.clone(),
          metric_name: metric_name.clone(),
          labels: Self::deserialize_canonical(canonical),
          value,
        }
      })
      .collect()
  }
}

impl MetricsRecorder for InMemoryMetricsRecorder {
  fn counter_inc(&self, category: &str, metric_name: &str, mut labels: JsonMap<String, Value>, delta: f64) {
    self.counters.offered_total.fetch_add(1, Ordering::Relaxed);

    let policy = self.policy();
    if !policy.category_enabled(category) {
      self.counters.rejected_disabled_total.fetch_add(1, Ordering::Relaxed);
      return;
    }

    // INV-MET-06: strip `workspace_id` label when the per-config toggle is off
    // so hooks can emit it unconditionally without inflating cardinality.
    if !policy.label_workspace_id_enabled {
      labels.remove("workspace_id");
    }

    let labels_canonical = Self::canonicalize_labels(&labels);
    let key: SeriesKey = (category.to_string(), metric_name.to_string(), labels_canonical);

    // Fast path: existing series.
    if let Some(entry) = self.series.get(&key) {
      Self::atomic_add_f64(&entry, delta);
      self.counters.accepted_total.fetch_add(1, Ordering::Relaxed);
      return;
    }

    // Slow path: new series — consult the cardinality guard.
    let card_key = (category.to_string(), metric_name.to_string());
    let limit = policy.cardinality_limit_per_metric as u64;
    let current = self
      .cardinality
      .entry(card_key.clone())
      .or_insert_with(|| AtomicU64::new(0))
      .load(Ordering::Relaxed);
    if current >= limit {
      self.counters.cardinality_drops_total.fetch_add(1, Ordering::Relaxed);
      warn!(
        category = %category,
        metric = %metric_name,
        limit = limit,
        "metrics cardinality limit reached — dropping sample (INV-MET-06)"
      );
      return;
    }

    // Race-safe insert: if another thread won, we fall through to the CAS add.
    let entry = self.series.entry(key).or_insert_with(|| {
      self
        .cardinality
        .entry(card_key)
        .or_insert_with(|| AtomicU64::new(0))
        .fetch_add(1, Ordering::Relaxed);
      Arc::new(AtomicU64::new(0u64))
    });
    Self::atomic_add_f64(&entry, delta);
    self.counters.accepted_total.fetch_add(1, Ordering::Relaxed);
  }

  fn snapshot(&self, minute: DateTime<Utc>) -> Vec<MetricSample> {
    self.counters.snapshots_total.fetch_add(1, Ordering::Relaxed);
    self.collect_samples(minute)
  }

  fn inspect_series(&self, minute: DateTime<Utc>) -> Vec<MetricSample> {
    self.collect_samples(minute)
  }

  fn reset_after_flush(&self) {
    // Clearing the series map also resets the cardinality budget — the next
    // minute may re-admit previously-seen series, which is the desired
    // behaviour (the cardinality limit is a sustained-rate guard, not a
    // lifetime ban).
    self.series.clear();
    self.cardinality.clear();
  }

  fn counters(&self) -> &MetricsCounters {
    &self.counters
  }

  fn active_series(&self) -> usize {
    self.series.len()
  }

  fn render_prometheus(&self) -> String {
    let mut out = String::new();
    out.push_str("# TYPE myoxus_metrics_offered_total counter\n");
    out.push_str(&format!(
      "myoxus_metrics_offered_total {}\n",
      self.counters.offered_total.load(Ordering::Relaxed)
    ));
    out.push_str("# TYPE myoxus_metrics_accepted_total counter\n");
    out.push_str(&format!(
      "myoxus_metrics_accepted_total {}\n",
      self.counters.accepted_total.load(Ordering::Relaxed)
    ));
    out.push_str("# TYPE myoxus_metrics_rejected_disabled_total counter\n");
    out.push_str(&format!(
      "myoxus_metrics_rejected_disabled_total {}\n",
      self.counters.rejected_disabled_total.load(Ordering::Relaxed)
    ));
    out.push_str("# TYPE myoxus_metrics_cardinality_drops_total counter\n");
    out.push_str(&format!(
      "myoxus_metrics_cardinality_drops_total {}\n",
      self.counters.cardinality_drops_total.load(Ordering::Relaxed)
    ));
    out.push_str("# TYPE myoxus_metrics_active_series gauge\n");
    out.push_str(&format!("myoxus_metrics_active_series {}\n", self.active_series()));

    // Per-series counters — business metrics live here.  Name format:
    //   myoxus_metric_{category}_{metric_name}{labels} value
    // The category prefix keeps the Prometheus namespace tidy and prevents
    // two categories from colliding on the same metric name (e.g. `session`).
    let policy = self.policy();
    if !policy.enabled {
      return out;
    }
    if policy.categories.values().all(|v| !v) {
      return out;
    }
    let mut by_name: BTreeMap<String, Vec<(String, f64)>> = BTreeMap::new();
    for entry in self.series.iter() {
      let (category, metric_name, canonical) = entry.key();
      let value = f64::from_bits(entry.value().load(Ordering::Relaxed));
      let prom_name = format!(
        "myoxus_metric_{}_{}",
        sanitize_prom_name(category),
        sanitize_prom_name(metric_name)
      );
      let labels_fragment = labels_to_prom(canonical);
      by_name.entry(prom_name).or_default().push((labels_fragment, value));
    }
    for (name, rows) in by_name {
      out.push_str(&format!("# TYPE {name} counter\n"));
      for (labels_fragment, value) in rows {
        out.push_str(&format!("{name}{labels_fragment} {value}\n"));
      }
    }
    out
  }
}

/// Prometheus-safe identifier: `[a-zA-Z_][a-zA-Z0-9_]*`.  Anything else is
/// replaced with `_`.
fn sanitize_prom_name(raw: &str) -> String {
  let mut out = String::with_capacity(raw.len());
  for (i, c) in raw.chars().enumerate() {
    let ok = if i == 0 {
      c.is_ascii_alphabetic() || c == '_'
    } else {
      c.is_ascii_alphanumeric() || c == '_'
    };
    out.push(if ok { c } else { '_' });
  }
  if out.is_empty() { "_".to_string() } else { out }
}

/// Convert a canonical labels JSON into a Prometheus label fragment
/// (`{k="v",k2="v2"}`), escaping embedded double-quotes and backslashes.
fn labels_to_prom(canonical: &str) -> String {
  let parsed = InMemoryMetricsRecorder::deserialize_canonical(canonical);
  let Some(obj) = parsed.as_object() else {
    return String::new();
  };
  if obj.is_empty() {
    return String::new();
  }
  let mut pairs: Vec<String> = Vec::with_capacity(obj.len());
  for (k, v) in obj {
    let key_safe = sanitize_prom_name(k);
    let val_raw = match v {
      Value::String(s) => s.clone(),
      other => other.to_string(),
    };
    let val_escaped = val_raw.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    pairs.push(format!("{key_safe}=\"{val_escaped}\""));
  }
  format!("{{{}}}", pairs.join(","))
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn policy(enabled: bool, cardinality: u32) -> MetricsPolicy {
    let mut categories = std::collections::HashMap::new();
    for c in METRICS_CATEGORIES_FOR_TEST {
      categories.insert((*c).to_string(), true);
    }
    MetricsPolicy {
      enabled,
      categories,
      label_workspace_id_enabled: false,
      cardinality_limit_per_metric: cardinality,
    }
  }

  const METRICS_CATEGORIES_FOR_TEST: &[&str] = &["auth", "workspace", "doc", "collab", "ai"];

  #[test]
  fn counter_inc_accumulates() {
    let r = InMemoryMetricsRecorder::new(policy(true, 10));
    let mut labels = JsonMap::new();
    labels.insert("method".into(), json!("password"));
    r.counter_inc("auth", "user_signin", labels.clone(), 1.0);
    r.counter_inc("auth", "user_signin", labels.clone(), 2.0);
    let samples = r.snapshot(Utc::now());
    assert_eq!(samples.len(), 1);
    assert_eq!(samples[0].value, 3.0);
    assert_eq!(samples[0].metric_name, "user_signin");
  }

  #[test]
  fn inspect_series_is_read_only_snapshot_increments_accounting() {
    let r = InMemoryMetricsRecorder::new(policy(true, 10));
    r.counter_inc("auth", "user_signin", JsonMap::new(), 1.0);

    let inspected = r.inspect_series(Utc::now());
    assert_eq!(inspected.len(), 1);
    assert_eq!(r.counters().snapshots_total.load(Ordering::Relaxed), 0);

    let flushed = r.snapshot(Utc::now());
    assert_eq!(flushed.len(), 1);
    assert_eq!(r.counters().snapshots_total.load(Ordering::Relaxed), 1);
  }

  #[test]
  fn disabled_category_is_noop() {
    let mut p = policy(true, 10);
    p.categories.insert("auth".into(), false);
    let r = InMemoryMetricsRecorder::new(p);
    r.counter_inc("auth", "user_signup", JsonMap::new(), 1.0);
    assert_eq!(r.snapshot(Utc::now()).len(), 0);
    assert_eq!(r.counters().rejected_disabled_total.load(Ordering::Relaxed), 1);
  }

  #[test]
  fn master_switch_off_rejects() {
    let r = InMemoryMetricsRecorder::new(policy(false, 10));
    r.counter_inc("auth", "user_signup", JsonMap::new(), 1.0);
    assert_eq!(r.snapshot(Utc::now()).len(), 0);
    assert_eq!(r.counters().rejected_disabled_total.load(Ordering::Relaxed), 1);
  }

  #[test]
  fn cardinality_limit_drops_excess() {
    let r = InMemoryMetricsRecorder::new(policy(true, 2));
    for i in 0..5 {
      let mut labels = JsonMap::new();
      labels.insert("id".into(), json!(i));
      r.counter_inc("auth", "user_signup", labels, 1.0);
    }
    assert_eq!(r.active_series(), 2);
    assert_eq!(r.counters().cardinality_drops_total.load(Ordering::Relaxed), 3);
  }

  #[test]
  fn snapshot_clears_on_reset() {
    let r = InMemoryMetricsRecorder::new(policy(true, 10));
    r.counter_inc("doc", "doc_create", JsonMap::new(), 1.0);
    assert_eq!(r.snapshot(Utc::now()).len(), 1);
    r.reset_after_flush();
    assert_eq!(r.snapshot(Utc::now()).len(), 0);
    assert_eq!(r.active_series(), 0);
  }

  #[test]
  fn canonical_labels_collapse_series() {
    let r = InMemoryMetricsRecorder::new(policy(true, 10));
    let mut a = JsonMap::new();
    a.insert("a".into(), json!("1"));
    a.insert("b".into(), json!("2"));
    let mut b = JsonMap::new();
    b.insert("b".into(), json!("2"));
    b.insert("a".into(), json!("1"));
    r.counter_inc("doc", "doc_create", a, 1.0);
    r.counter_inc("doc", "doc_create", b, 1.0);
    assert_eq!(r.active_series(), 1);
    assert_eq!(r.snapshot(Utc::now())[0].value, 2.0);
  }

  #[test]
  fn prometheus_render_includes_business_series() {
    let r = InMemoryMetricsRecorder::new(policy(true, 10));
    let mut labels = JsonMap::new();
    labels.insert("method".into(), json!("password"));
    r.counter_inc("auth", "user_signin", labels, 1.0);
    let body = r.render_prometheus();
    assert!(body.contains("myoxus_metric_auth_user_signin"));
    assert!(body.contains("method=\"password\""));
    assert!(body.contains("myoxus_metrics_active_series 1"));
  }

  /// Load sanity: 1_000 concurrent hook invocations should stay sub-ms for
  /// the normal tail while allowing occasional scheduler stalls on loaded CI
  /// runners. Guards against a future regression that would add blocking I/O
  /// or excessive locking to the hot path (P-Metrics-G).
  #[test]
  fn concurrent_hooks_stay_scheduler_tolerant() {
    use std::sync::Arc as StdArc;
    use std::thread;
    use std::time::Instant;

    let r = StdArc::new(InMemoryMetricsRecorder::new(policy(true, 10_000)));
    let threads = 8;
    let per_thread = 125; // 8 * 125 = 1_000 total hooks
    let mut durations_ns: Vec<Vec<u128>> = Vec::with_capacity(threads);
    for _ in 0..threads {
      durations_ns.push(Vec::with_capacity(per_thread));
    }

    let mut handles = Vec::with_capacity(threads);
    for tid in 0..threads {
      let r = StdArc::clone(&r);
      handles.push(thread::spawn(move || {
        let mut local: Vec<u128> = Vec::with_capacity(per_thread);
        for i in 0..per_thread {
          let mut labels = JsonMap::new();
          labels.insert("method".into(), json!("password"));
          labels.insert("tenant".into(), json!(format!("t{tid}_{i}")));
          let t0 = Instant::now();
          r.counter_inc("auth", "user_signin", labels, 1.0);
          local.push(t0.elapsed().as_nanos());
        }
        local
      }));
    }
    for (i, h) in handles.into_iter().enumerate() {
      durations_ns[i] = h.join().expect("thread");
    }

    let mut all: Vec<u128> = durations_ns.into_iter().flatten().collect();
    all.sort_unstable();
    let p95 = all[(all.len() * 95) / 100];
    let p99 = all[(all.len() * 99) / 100];
    assert!(
      p95 < 1_000_000,
      "p95 hook overhead must stay < 1ms, got {p95} ns (samples={})",
      all.len()
    );
    assert!(
      p99 < 10_000_000,
      "p99 hook overhead must stay < 10ms on loaded runners, got {p99} ns (samples={})",
      all.len()
    );
    assert_eq!(
      r.counters().offered_total.load(Ordering::Relaxed),
      (threads * per_thread) as u64
    );
  }
}
