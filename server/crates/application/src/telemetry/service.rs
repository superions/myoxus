//! Ingest pipeline for client-side telemetry events.
//!
//! # Flow
//!
//! ```text
//! client event
//!   → validate schema
//!   → respect opt_out
//!   → derive category (if missing)
//!   → category allowlist (INV-TEL-02)
//!   → sampling
//!   → dedupe (INV-TEL-01, Redis SETNX)
//!   → PII strip
//!   → push to hot buffer
//! ```
//!
//! The hot buffer is flushed by a background worker via [`flush_batch`]
//! (P-Telemetry-C). Until flushed, events live only in memory; on crash the
//! buffer contents are lost. This is an explicit trade-off: `flush_interval_seconds`
//! defaults to 60s so the exposure window is bounded.
//!
//! Prometheus counters (carried over from the old DashMap service) continue
//! to tick on every accepted event so `/metrics` remains useful even before
//! the first flush.

use std::{
  collections::VecDeque,
  sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
  },
  time::Duration,
};

use chrono::Utc;
use dashmap::DashMap;
use myoxus_domain::telemetry::{TelemetryDedupeStore, TelemetryEventRecord, TelemetryRepository, TelemetryStoreError};
use rand::{Rng, thread_rng};
use serde_json::Value;
use tokio::sync::Mutex;
use tracing::{debug, trace, warn};

use super::error::TelemetryError;
use super::models::{FlushStats, TELEMETRY_SCHEMA_MAX, TELEMETRY_SCHEMA_MIN, TelemetryEvent};

/// Runtime knobs for the ingest service.
///
/// Mirrors the subset of `TelemetryConfig` (see `config.rs`) that the ingest
/// path needs at hot-path latencies. Built once per request by the caller
/// from the live [`crate::AppConfig`] snapshot.
#[derive(Debug, Clone)]
pub struct TelemetryPolicy {
  pub enabled: bool,
  /// Categories allowed to persist. Keys not present here → treated as
  /// disabled (fail-closed, INV-TEL-02).
  pub categories: std::collections::HashMap<String, bool>,
  /// Per-category sampling rate in `[0.0, 1.0]`.  Unknown categories → 0.0.
  pub sampling_rates: std::collections::HashMap<String, f32>,
  /// Dedupe TTL in hours.
  pub dedupe_ttl_hours: u64,
  /// Soft cap on hot-buffer size. Events beyond this cap are dropped and
  /// `buffer_overflow_total` increments.
  pub dedupe_max_entries: u64,
  /// Soft cap on flush-batch size.
  pub batch_max_events: u32,
}

impl TelemetryPolicy {
  fn category_enabled(&self, category: &str) -> bool {
    self.categories.get(category).copied().unwrap_or(false)
  }
  fn sampling_rate(&self, category: &str) -> f32 {
    self
      .sampling_rates
      .get(category)
      .copied()
      .map(|v| v.clamp(0.0, 1.0))
      .unwrap_or(0.0)
  }
}

/// Aggregated Prometheus counters maintained alongside the persistence path.
#[derive(Default)]
pub struct TelemetryCounters {
  /// Events offered (before filtering).
  pub offered_total: AtomicU64,
  /// Events accepted into the hot buffer.
  pub accepted_total: AtomicU64,
  /// Events rejected because telemetry is globally disabled.
  pub rejected_disabled_total: AtomicU64,
  /// Events rejected because the category is not allowlisted.
  pub rejected_category_total: AtomicU64,
  /// Events rejected by sampling.
  pub rejected_sampled_total: AtomicU64,
  /// Events rejected as duplicates (dedupe hit).
  pub rejected_duplicate_total: AtomicU64,
  /// Events rejected as invalid (schema).
  pub rejected_invalid_total: AtomicU64,
  /// Events dropped because the hot buffer was full.
  pub buffer_overflow_total: AtomicU64,
  /// Total events flushed to the repository.
  pub flushed_total: AtomicU64,
  /// Per-event-name counters.
  pub by_name: DashMap<String, AtomicU64>,
  /// Page-view counters.
  pub page_views: DashMap<String, AtomicU64>,
  /// Doc-operation counters.
  pub doc_ops: DashMap<String, AtomicU64>,
  /// Frontend-error counters.
  pub frontend_errors: DashMap<String, AtomicU64>,
}

/// The application-level telemetry ingest service.
///
/// Holds:
/// * a `TelemetryRepository` for persistence,
/// * a `TelemetryDedupeStore` for replay protection,
/// * an in-memory hot buffer awaiting flush,
/// * Prometheus counters.
pub struct TelemetryIngestService {
  repo: Arc<dyn TelemetryRepository>,
  dedupe: Arc<dyn TelemetryDedupeStore>,
  hot_buffer: Mutex<VecDeque<TelemetryEventRecord>>,
  counters: TelemetryCounters,
  /// Unix-seconds timestamp of the most recent successful flush, or `0` when
  /// the process has not flushed yet. Surfaced via the admin status endpoint.
  last_flush_unix_secs: AtomicU64,
  /// Row-count of the most recent flush (regardless of success). Separate
  /// from the `flushed_total` cumulative counter so the GUI can show the
  /// size of the last tick without computing a delta.
  last_flush_count: AtomicU64,
}

impl TelemetryIngestService {
  pub fn new(repo: Arc<dyn TelemetryRepository>, dedupe: Arc<dyn TelemetryDedupeStore>) -> Self {
    Self {
      repo,
      dedupe,
      hot_buffer: Mutex::new(VecDeque::new()),
      counters: TelemetryCounters::default(),
      last_flush_unix_secs: AtomicU64::new(0),
      last_flush_count: AtomicU64::new(0),
    }
  }

  /// Construct a service backed by in-memory stores.  Used by test helpers
  /// and as the initial value in builders that later call
  /// `ApiState::with_telemetry_service` to install the real Postgres/Redis
  /// adapters.
  pub fn in_memory_stub() -> Self {
    Self::new(
      Arc::new(InMemoryTelemetryRepo::default()),
      Arc::new(InMemoryTelemetryDedupe::default()),
    )
  }

  pub fn counters(&self) -> &TelemetryCounters {
    &self.counters
  }

  /// Current hot-buffer length (projected through Admin GraphQL
  /// `admin { telemetryStatus }`).
  pub async fn buffer_len(&self) -> usize {
    self.hot_buffer.lock().await.len()
  }

  /// Snapshot of per-event-name counters (tests + admin status).
  pub fn events_by_name(&self) -> Vec<(String, u64)> {
    self
      .counters
      .by_name
      .iter()
      .map(|e| (e.key().clone(), e.value().load(Ordering::Relaxed)))
      .collect()
  }

  /// Snapshot of page-view counters.
  pub fn page_views(&self) -> Vec<(String, u64)> {
    self
      .counters
      .page_views
      .iter()
      .map(|e| (e.key().clone(), e.value().load(Ordering::Relaxed)))
      .collect()
  }

  /// Snapshot of doc-operation counters.
  pub fn doc_ops(&self) -> Vec<(String, u64)> {
    self
      .counters
      .doc_ops
      .iter()
      .map(|e| (e.key().clone(), e.value().load(Ordering::Relaxed)))
      .collect()
  }

  /// Snapshot of frontend-error counters.
  pub fn frontend_errors(&self) -> Vec<(String, u64)> {
    self
      .counters
      .frontend_errors
      .iter()
      .map(|e| (e.key().clone(), e.value().load(Ordering::Relaxed)))
      .collect()
  }

  /// Grand total accepted events.
  pub fn events_total(&self) -> u64 {
    self.counters.accepted_total.load(Ordering::Relaxed)
  }

  /// Validate, filter, dedupe, strip PII, and enqueue a single event.
  ///
  /// Returns `Ok(())` on accept, `Err(TelemetryError)` on reject. Callers may
  /// inspect [`TelemetryError::is_policy_drop`] to distinguish silent drops
  /// from genuine failures.
  pub async fn ingest(&self, event: TelemetryEvent, policy: &TelemetryPolicy) -> Result<(), TelemetryError> {
    self.counters.offered_total.fetch_add(1, Ordering::Relaxed);

    // Global enablement (INV-TEL-03)
    if !policy.enabled {
      self.counters.rejected_disabled_total.fetch_add(1, Ordering::Relaxed);
      return Err(TelemetryError::Disabled);
    }

    // Client-declared opt-out wins over everything.
    if event.opt_out {
      self.counters.rejected_disabled_total.fetch_add(1, Ordering::Relaxed);
      return Err(TelemetryError::Disabled);
    }

    // Schema validation
    if event.event_id.trim().is_empty() {
      self.counters.rejected_invalid_total.fetch_add(1, Ordering::Relaxed);
      return Err(TelemetryError::Invalid("empty eventId".into()));
    }
    if event.event_id.len() > 128 {
      self.counters.rejected_invalid_total.fetch_add(1, Ordering::Relaxed);
      return Err(TelemetryError::Invalid("eventId too long".into()));
    }
    if event.event_name.trim().is_empty() || event.event_name.len() > 128 {
      self.counters.rejected_invalid_total.fetch_add(1, Ordering::Relaxed);
      return Err(TelemetryError::Invalid("eventName empty or too long".into()));
    }
    if event.schema_version < TELEMETRY_SCHEMA_MIN || event.schema_version > TELEMETRY_SCHEMA_MAX {
      self.counters.rejected_invalid_total.fetch_add(1, Ordering::Relaxed);
      return Err(TelemetryError::Invalid(format!(
        "unsupported schemaVersion {}",
        event.schema_version
      )));
    }

    // Category resolution
    let category = event
      .category
      .clone()
      .unwrap_or_else(|| derive_category(&event.event_name).to_string());

    // Category allowlist (INV-TEL-02, fail-closed)
    if !policy.category_enabled(&category) {
      self.counters.rejected_category_total.fetch_add(1, Ordering::Relaxed);
      return Err(TelemetryError::CategoryDisabled(category));
    }

    // Sampling — never call rand if rate is 0.0 or 1.0.
    let rate = policy.sampling_rate(&category);
    if rate <= 0.0 {
      self.counters.rejected_sampled_total.fetch_add(1, Ordering::Relaxed);
      return Err(TelemetryError::SampledOut);
    }
    if rate < 1.0 {
      let roll: f32 = thread_rng().r#gen();
      if roll >= rate {
        self.counters.rejected_sampled_total.fetch_add(1, Ordering::Relaxed);
        return Err(TelemetryError::SampledOut);
      }
    }

    // Dedupe (INV-TEL-01)
    let ttl = Duration::from_secs(policy.dedupe_ttl_hours.saturating_mul(3600)).as_secs();
    let first_seen = self.dedupe.try_register(&event.event_id, ttl).await?;
    if !first_seen {
      self.counters.rejected_duplicate_total.fetch_add(1, Ordering::Relaxed);
      return Err(TelemetryError::Duplicate);
    }

    // PII strip (INV-TEL-04)
    let params = strip_pii(&event.params);
    let user_properties = strip_pii(&event.user_properties);
    let context = strip_pii(&event.context);

    let record = TelemetryEventRecord {
      event_id: event.event_id.clone(),
      event_name: event.event_name.clone(),
      category: category.clone(),
      user_id: event.user_id,
      client_id: event.client_id.clone(),
      session_id: event.session_id.clone(),
      schema_version: event.schema_version,
      params,
      user_properties,
      context,
      client_timestamp: event.resolved_client_timestamp(),
    };

    // Tick Prometheus counters (mirrors old DashMap service so /metrics stays
    // backwards-compatible).
    self.tick_name_counters(&event);

    // Push to hot buffer (bounded).
    let mut buf = self.hot_buffer.lock().await;
    if buf.len() as u64 >= policy.dedupe_max_entries {
      self.counters.buffer_overflow_total.fetch_add(1, Ordering::Relaxed);
      warn!(
        category = %category,
        buffer_len = buf.len(),
        cap = policy.dedupe_max_entries,
        "telemetry hot buffer overflow — dropping event"
      );
      return Err(TelemetryError::Store(TelemetryStoreError::Backend(
        "hot buffer full".into(),
      )));
    }
    buf.push_back(record);
    drop(buf);
    self.counters.accepted_total.fetch_add(1, Ordering::Relaxed);
    trace!(event_name = %event.event_name, category = %category, "telemetry event accepted");

    Ok(())
  }

  /// Ingest a batch of events. Errors for individual events do not abort the
  /// rest. Returns `(accepted, dropped)`.
  pub async fn ingest_batch(&self, events: Vec<TelemetryEvent>, policy: &TelemetryPolicy) -> (usize, usize) {
    let mut accepted = 0usize;
    let mut dropped = 0usize;
    for event in events {
      match self.ingest(event, policy).await {
        Ok(()) => accepted += 1,
        Err(_) => dropped += 1,
      }
    }
    (accepted, dropped)
  }

  /// Drain up to `batch_max_events` from the hot buffer and bulk-insert them.
  /// Intended to be called from the worker job (P-Telemetry-C).
  pub async fn flush_batch(&self, batch_max_events: u32) -> Result<FlushStats, TelemetryError> {
    let cap = batch_max_events.max(1) as usize;
    let drained: Vec<TelemetryEventRecord> = {
      let mut buf = self.hot_buffer.lock().await;
      let take = buf.len().min(cap);
      buf.drain(..take).collect()
    };
    if drained.is_empty() {
      return Ok(FlushStats::default());
    }
    let buffered = drained.len() as u64;
    let inserted = self.repo.insert_batch(&drained).await.map_err(TelemetryError::from)?;
    self.counters.flushed_total.fetch_add(inserted, Ordering::Relaxed);
    let now_secs = Utc::now().timestamp().max(0) as u64;
    self.last_flush_unix_secs.store(now_secs, Ordering::Relaxed);
    self.last_flush_count.store(inserted, Ordering::Relaxed);
    debug!(buffered, inserted, "telemetry flush complete");
    Ok(FlushStats { buffered, inserted })
  }

  /// Unix-seconds timestamp of the most recent successful flush (or `None`
  /// if the process has not flushed yet).
  pub fn last_flush_unix_secs(&self) -> Option<u64> {
    match self.last_flush_unix_secs.load(Ordering::Relaxed) {
      0 => None,
      v => Some(v),
    }
  }

  /// Row-count of the most recent flush tick.
  pub fn last_flush_count(&self) -> u64 {
    self.last_flush_count.load(Ordering::Relaxed)
  }

  /// Daily-rollup row count since `since`, for the admin status endpoint.
  pub async fn daily_rollups_since(&self, since: chrono::NaiveDate) -> Result<u64, TelemetryError> {
    Ok(self.repo.count_daily_rollups_since(since).await?)
  }

  pub async fn rollup_previous_day(&self) -> Result<Option<u64>, TelemetryError> {
    Ok(self.repo.rollup_previous_day().await?)
  }

  pub async fn apply_retention(&self, raw_days: u32, daily_days: u32) -> Result<Option<(u64, u64)>, TelemetryError> {
    Ok(self.repo.apply_retention(raw_days.max(1), daily_days.max(1)).await?)
  }

  /// Fast path for server-internal counter ticks that bypass the full ingest
  /// pipeline (no dedupe, no persistence, no config policy). Used by
  /// non-client subsystems like the template registry to surface metrics.
  ///
  /// `events` is a slice of JSON objects each with at least `eventName`.
  /// Unknown shapes are silently ignored.
  pub fn record_events(&self, events: &[Value]) {
    for raw in events {
      self.counters.offered_total.fetch_add(1, Ordering::Relaxed);
      self.counters.accepted_total.fetch_add(1, Ordering::Relaxed);
      let Some(name) = raw.get("eventName").and_then(Value::as_str) else {
        continue;
      };
      let dummy = TelemetryEvent {
        event_id: String::new(),
        schema_version: 1,
        event_name: name.to_string(),
        category: None,
        params: raw.get("params").cloned().unwrap_or(Value::Null),
        user_properties: Value::Null,
        context: Value::Null,
        user_id: None,
        client_id: None,
        session_id: None,
        timestamp_micros: None,
        opt_out: false,
      };
      self.tick_name_counters(&dummy);
    }
  }

  fn tick_name_counters(&self, event: &TelemetryEvent) {
    self
      .counters
      .by_name
      .entry(event.event_name.clone())
      .or_default()
      .fetch_add(1, Ordering::Relaxed);

    match event.event_name.as_str() {
      "pageView" | "page_view" => {
        let page = event.params.get("page").and_then(Value::as_str).unwrap_or("unknown");
        self
          .counters
          .page_views
          .entry(page.to_string())
          .or_default()
          .fetch_add(1, Ordering::Relaxed);
      }
      n if n.starts_with("doc.") || n.starts_with("Doc") => {
        let op = n.split('.').nth(1).unwrap_or(n);
        self
          .counters
          .doc_ops
          .entry(op.to_string())
          .or_default()
          .fetch_add(1, Ordering::Relaxed);
      }
      "error" | "frontend_error" | "unhandledError" => {
        let t = event.params.get("type").and_then(Value::as_str).unwrap_or("unknown");
        self
          .counters
          .frontend_errors
          .entry(t.to_string())
          .or_default()
          .fetch_add(1, Ordering::Relaxed);
      }
      _ => {}
    }
  }

  /// Persisted-row count for the admin status endpoint.
  pub async fn persisted_since(&self, since: chrono::DateTime<Utc>) -> Result<u64, TelemetryError> {
    Ok(self.repo.count_recent(since).await?)
  }

  /// Render Prometheus-compatible counters.  Kept bug-compatible with the old
  /// service so existing Grafana dashboards keep working.
  pub fn render_prometheus(&self) -> String {
    let mut buf = String::new();
    buf.push_str("# TYPE myoxus_frontend_events_total counter\n");
    buf.push_str(&format!(
      "myoxus_frontend_events_total {}\n",
      self.counters.accepted_total.load(Ordering::Relaxed)
    ));
    buf.push_str("# TYPE myoxus_telemetry_offered_total counter\n");
    buf.push_str(&format!(
      "myoxus_telemetry_offered_total {}\n",
      self.counters.offered_total.load(Ordering::Relaxed)
    ));
    buf.push_str("# TYPE myoxus_telemetry_rejected_total counter\n");
    for (label, counter) in [
      ("disabled", &self.counters.rejected_disabled_total),
      ("category", &self.counters.rejected_category_total),
      ("sampled", &self.counters.rejected_sampled_total),
      ("duplicate", &self.counters.rejected_duplicate_total),
      ("invalid", &self.counters.rejected_invalid_total),
    ] {
      buf.push_str(&format!(
        "myoxus_telemetry_rejected_total{{reason=\"{}\"}} {}\n",
        label,
        counter.load(Ordering::Relaxed)
      ));
    }
    buf.push_str("# TYPE myoxus_telemetry_buffer_overflow_total counter\n");
    buf.push_str(&format!(
      "myoxus_telemetry_buffer_overflow_total {}\n",
      self.counters.buffer_overflow_total.load(Ordering::Relaxed)
    ));
    buf.push_str("# TYPE myoxus_telemetry_flushed_total counter\n");
    buf.push_str(&format!(
      "myoxus_telemetry_flushed_total {}\n",
      self.counters.flushed_total.load(Ordering::Relaxed)
    ));

    let mut by_name: Vec<(String, u64)> = self
      .counters
      .by_name
      .iter()
      .map(|e| (e.key().clone(), e.value().load(Ordering::Relaxed)))
      .collect();
    by_name.sort_by_key(|item| std::cmp::Reverse(item.1));
    by_name.truncate(50);
    if !by_name.is_empty() {
      buf.push_str("# TYPE myoxus_frontend_event_count counter\n");
      for (name, count) in &by_name {
        buf.push_str(&format!(
          "myoxus_frontend_event_count{{event=\"{}\"}} {}\n",
          prom_escape(name),
          count
        ));
      }
    }

    for (metric, map) in [
      ("myoxus_frontend_page_views_total", &self.counters.page_views),
      ("myoxus_frontend_doc_operations_total", &self.counters.doc_ops),
      ("myoxus_frontend_errors_total", &self.counters.frontend_errors),
    ] {
      let snapshot: Vec<(String, u64)> = map
        .iter()
        .map(|e| (e.key().clone(), e.value().load(Ordering::Relaxed)))
        .collect();
      if snapshot.is_empty() {
        continue;
      }
      buf.push_str(&format!("# TYPE {metric} counter\n"));
      let label = if metric.contains("page_views") {
        "page"
      } else if metric.contains("doc_operations") {
        "op"
      } else {
        "type"
      };
      for (k, count) in &snapshot {
        buf.push_str(&format!("{metric}{{{label}=\"{}\"}} {count}\n", prom_escape(k)));
      }
    }
    buf
  }
}

/// Derive a category from an event name when the client didn't set one.
///
/// Canonical mapping for legacy clients that still emit raw event names
/// without a `category` field.
pub(crate) fn derive_category(event_name: &str) -> &'static str {
  match event_name {
    "pageView" | "page_view" => "page_view",
    n if n.starts_with("doc.") || n.starts_with("Doc") => "doc_op",
    "error" | "frontend_error" | "unhandledError" => "error",
    n if n.starts_with("auth.") || n.starts_with("Auth") => "auth",
    n if n.starts_with("admin.") || n.starts_with("Admin") => "admin_action",
    n if n.starts_with("ai.") || n.starts_with("copilot.") || n.starts_with("Ai") => "ai_interaction",
    _ => "error",
  }
}

/// Fields that are always scrubbed from any user-supplied JSON before
/// persistence (INV-TEL-04). Matching is case-insensitive on keys.
const PII_KEYS: &[&str] = &[
  "ip",
  "ipaddress",
  "ip_address",
  "remoteaddr",
  "remote_addr",
  "remoteaddress",
  "xforwardedfor",
  "x_forwarded_for",
  "email",
  "emailaddress",
  "email_address",
  "mail",
  "phone",
  "phonenumber",
  "phone_number",
  "firstname",
  "first_name",
  "lastname",
  "last_name",
  "fullname",
  "full_name",
  "name",
  "password",
  "secret",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
];

fn strip_pii(value: &Value) -> Value {
  match value {
    Value::Object(map) => {
      let mut out = serde_json::Map::with_capacity(map.len());
      for (k, v) in map {
        let key_lower = k.to_ascii_lowercase().replace(['-', ' '], "_");
        let is_pii = PII_KEYS
          .iter()
          .any(|p| key_lower == *p || key_lower.ends_with(&format!("_{p}")));
        if is_pii {
          continue;
        }
        out.insert(k.clone(), strip_pii(v));
      }
      Value::Object(out)
    }
    Value::Array(arr) => Value::Array(arr.iter().map(strip_pii).collect()),
    other => other.clone(),
  }
}

fn prom_escape(s: &str) -> String {
  s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

/// In-memory [`TelemetryRepository`] — stores events in a `Vec` and exposes a
/// snapshot accessor for assertion.  Used by tests and by the default
/// `ApiState::new` path before real adapters are wired in.
#[derive(Default)]
pub struct InMemoryTelemetryRepo {
  rows: std::sync::Mutex<Vec<TelemetryEventRecord>>,
}

impl InMemoryTelemetryRepo {
  pub fn snapshot(&self) -> Vec<TelemetryEventRecord> {
    self.rows.lock().unwrap().clone()
  }
}

#[async_trait::async_trait]
impl TelemetryRepository for InMemoryTelemetryRepo {
  async fn insert_batch(&self, events: &[TelemetryEventRecord]) -> myoxus_domain::telemetry::TelemetryStoreResult<u64> {
    let mut rows = self.rows.lock().unwrap();
    rows.extend(events.iter().cloned());
    Ok(events.len() as u64)
  }
  async fn count_recent(&self, _since: chrono::DateTime<Utc>) -> myoxus_domain::telemetry::TelemetryStoreResult<u64> {
    Ok(self.rows.lock().unwrap().len() as u64)
  }
  async fn count_daily_rollups_since(
    &self,
    _since: chrono::NaiveDate,
  ) -> myoxus_domain::telemetry::TelemetryStoreResult<u64> {
    Ok(0)
  }
  async fn rollup_previous_day(&self) -> myoxus_domain::telemetry::TelemetryStoreResult<Option<u64>> {
    Ok(Some(0))
  }
  async fn apply_retention(
    &self,
    _raw_days: u32,
    _daily_days: u32,
  ) -> myoxus_domain::telemetry::TelemetryStoreResult<Option<(u64, u64)>> {
    Ok(Some((0, 0)))
  }
}

/// In-memory [`TelemetryDedupeStore`] — first-seen tracking in a `HashSet`.
#[derive(Default)]
pub struct InMemoryTelemetryDedupe {
  seen: std::sync::Mutex<std::collections::HashSet<String>>,
}

#[async_trait::async_trait]
impl TelemetryDedupeStore for InMemoryTelemetryDedupe {
  async fn try_register(
    &self,
    event_id: &str,
    _ttl_seconds: u64,
  ) -> myoxus_domain::telemetry::TelemetryStoreResult<bool> {
    Ok(self.seen.lock().unwrap().insert(event_id.to_string()))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;
  use std::collections::HashMap;

  fn svc() -> TelemetryIngestService {
    TelemetryIngestService::in_memory_stub()
  }

  fn policy_all_on() -> TelemetryPolicy {
    let mut categories = HashMap::new();
    let mut rates = HashMap::new();
    for c in ["page_view", "doc_op", "error", "auth", "admin_action", "ai_interaction"] {
      categories.insert(c.to_string(), true);
      rates.insert(c.to_string(), 1.0);
    }
    TelemetryPolicy {
      enabled: true,
      categories,
      sampling_rates: rates,
      dedupe_ttl_hours: 1,
      dedupe_max_entries: 100,
      batch_max_events: 10,
    }
  }

  fn mkevent(id: &str, name: &str) -> TelemetryEvent {
    TelemetryEvent {
      event_id: id.to_string(),
      schema_version: 1,
      event_name: name.to_string(),
      category: None,
      params: Value::Null,
      user_properties: Value::Null,
      context: Value::Null,
      user_id: None,
      client_id: None,
      session_id: None,
      timestamp_micros: None,
      opt_out: false,
    }
  }

  #[tokio::test]
  async fn ingest_strips_pii_from_context() {
    let service = svc();
    let policy = policy_all_on();
    let mut ev = mkevent("e1", "pageView");
    ev.context = json!({"ip": "10.0.0.1", "userAgent": "x", "email": "leak@example.com"});
    ev.user_properties = json!({"email": "leak@example.com", "plan": "pro"});
    service.ingest(ev, &policy).await.expect("accept");

    let stats = service.flush_batch(100).await.unwrap();
    assert_eq!(stats.inserted, 1);

    // Pull from the MemRepo by downcasting.  We have no handle, so round-trip
    // via the hot buffer before flush: instead re-run with an inspectable repo.
    // (See the dedicated repo-aware test below.)
    assert!(!service.render_prometheus().contains("leak@example.com"));
  }

  #[tokio::test]
  async fn pii_keys_removed_from_persisted_record() {
    let repo = Arc::new(InMemoryTelemetryRepo::default());
    let dedupe = Arc::new(InMemoryTelemetryDedupe::default());
    let service = TelemetryIngestService::new(repo.clone(), dedupe);
    let policy = policy_all_on();
    let mut ev = mkevent("e1", "pageView");
    ev.context = json!({"ip": "1.2.3.4", "page": "/editor"});
    ev.user_properties = json!({"email": "x@y.z", "role": "owner"});
    service.ingest(ev, &policy).await.unwrap();
    service.flush_batch(100).await.unwrap();

    let rows = repo.snapshot();
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert!(row.context.get("ip").is_none(), "ip must be stripped");
    assert_eq!(row.context.get("page").and_then(Value::as_str), Some("/editor"));
    assert!(row.user_properties.get("email").is_none(), "email must be stripped");
    assert_eq!(row.user_properties.get("role").and_then(Value::as_str), Some("owner"));
  }

  #[tokio::test]
  async fn ingest_drops_event_on_disabled_category() {
    let service = svc();
    let mut policy = policy_all_on();
    policy.categories.insert("page_view".into(), false);
    let err = service.ingest(mkevent("e1", "pageView"), &policy).await.unwrap_err();
    assert!(matches!(err, TelemetryError::CategoryDisabled(_)));
    assert!(err.is_policy_drop());
  }

  #[tokio::test]
  async fn sampling_rate_zero_drops_all() {
    let service = svc();
    let mut policy = policy_all_on();
    policy.sampling_rates.insert("page_view".into(), 0.0);
    for i in 0..20 {
      let err = service
        .ingest(mkevent(&format!("e{i}"), "pageView"), &policy)
        .await
        .unwrap_err();
      assert!(matches!(err, TelemetryError::SampledOut));
    }
  }

  #[tokio::test]
  async fn sampling_rate_one_keeps_all() {
    let service = svc();
    let policy = policy_all_on();
    for i in 0..20 {
      service
        .ingest(mkevent(&format!("e{i}"), "pageView"), &policy)
        .await
        .expect("sampling 1.0 accepts");
    }
    assert_eq!(service.buffer_len().await, 20);
  }

  #[tokio::test]
  async fn dedupe_rejects_replay() {
    let service = svc();
    let policy = policy_all_on();
    service.ingest(mkevent("same", "pageView"), &policy).await.unwrap();
    let err = service.ingest(mkevent("same", "pageView"), &policy).await.unwrap_err();
    assert!(matches!(err, TelemetryError::Duplicate));
  }

  #[tokio::test]
  async fn disabled_returns_error() {
    let service = svc();
    let mut policy = policy_all_on();
    policy.enabled = false;
    let err = service.ingest(mkevent("e1", "pageView"), &policy).await.unwrap_err();
    assert!(matches!(err, TelemetryError::Disabled));
  }

  #[tokio::test]
  async fn opt_out_event_is_dropped() {
    let service = svc();
    let policy = policy_all_on();
    let mut ev = mkevent("e1", "pageView");
    ev.opt_out = true;
    let err = service.ingest(ev, &policy).await.unwrap_err();
    assert!(matches!(err, TelemetryError::Disabled));
  }

  #[tokio::test]
  async fn flush_drains_buffer() {
    let service = svc();
    let policy = policy_all_on();
    for i in 0..5 {
      service
        .ingest(mkevent(&format!("e{i}"), "pageView"), &policy)
        .await
        .unwrap();
    }
    assert_eq!(service.buffer_len().await, 5);
    let stats = service.flush_batch(100).await.unwrap();
    assert_eq!(stats.buffered, 5);
    assert_eq!(stats.inserted, 5);
    assert_eq!(service.buffer_len().await, 0);
  }

  #[tokio::test]
  async fn invalid_event_rejected() {
    let service = svc();
    let policy = policy_all_on();
    let mut ev = mkevent("", "pageView");
    ev.event_id = "".into();
    assert!(matches!(
      service.ingest(ev, &policy).await.unwrap_err(),
      TelemetryError::Invalid(_)
    ));
  }

  #[test]
  fn derive_category_covers_known_prefixes() {
    assert_eq!(derive_category("pageView"), "page_view");
    assert_eq!(derive_category("doc.create"), "doc_op");
    assert_eq!(derive_category("auth.login"), "auth");
    assert_eq!(derive_category("admin.flag"), "admin_action");
    assert_eq!(derive_category("ai.chat"), "ai_interaction");
    assert_eq!(derive_category("unhandledError"), "error");
  }
}
