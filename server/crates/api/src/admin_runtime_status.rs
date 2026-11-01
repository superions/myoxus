// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Canonical admin runtime snapshots for metrics and telemetry.
//!
//! The admin UI consumes these snapshots through `admin { ... }` GraphQL
//! resolvers. Keeping the snapshot builders outside the GraphQL resolver keeps
//! business/runtime derivation in one server-side place and avoids re-creating
//! the same aggregation rules in the client.

use std::{collections::BTreeMap, sync::atomic::Ordering};

use chrono::{DateTime, Duration, NaiveDate, Utc};
use myoxus_application::metrics::MetricsRecorder;
use serde::Serialize;
use serde_json::Value;
use tracing::{debug, info, instrument, warn};

use crate::state::ApiState;

/// Snapshot of one in-memory series for the admin top-list.
#[derive(Clone, Debug, Serialize)]
pub struct AdminMetricsTopSeries {
  pub category: String,
  pub name: String,
  pub labels: Value,
  pub value: f64,
}

/// Runtime counters mirrored from `MetricsCounters`.
#[derive(Clone, Debug, Serialize)]
pub struct AdminMetricsCounters {
  pub offered_total: u64,
  pub accepted_total: u64,
  pub rejected_disabled_total: u64,
  pub cardinality_drops_total: u64,
  pub snapshots_total: u64,
}

/// Admin GraphQL response for the metrics runtime state.
#[derive(Clone, Debug, Serialize)]
pub struct AdminMetricsStatusResponse {
  pub enabled: bool,
  pub prometheus_enabled: bool,
  pub persistence_enabled: bool,
  pub categories: BTreeMap<String, bool>,
  pub flush_interval_seconds: u64,
  pub retention_raw_days: u32,
  pub retention_daily_days: u32,
  pub cardinality_limit_per_metric: u32,
  pub label_workspace_id_enabled: bool,
  pub active_series: u64,
  pub persisted_24h: Option<u64>,
  pub daily_rollups_7d: Option<u64>,
  pub last_flush_at: Option<DateTime<Utc>>,
  pub last_flush_count: u64,
  pub counters: AdminMetricsCounters,
  pub top_series: Vec<AdminMetricsTopSeries>,
}

/// Admin GraphQL response for an operator-triggered metrics flush.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct AdminMetricsFlushResponse {
  pub buffered: u64,
  pub inserted: u64,
}

/// Runtime counters mirrored from `TelemetryCounters`.
#[derive(Clone, Debug, Serialize)]
pub struct AdminTelemetryCounters {
  pub offered_total: u64,
  pub accepted_total: u64,
  pub rejected_disabled_total: u64,
  pub rejected_category_total: u64,
  pub rejected_sampled_total: u64,
  pub rejected_duplicate_total: u64,
  pub rejected_invalid_total: u64,
  pub buffer_overflow_total: u64,
  pub flushed_total: u64,
}

/// Admin GraphQL response for the telemetry runtime state.
#[derive(Clone, Debug, Serialize)]
pub struct AdminTelemetryStatusResponse {
  pub enabled: bool,
  pub categories: BTreeMap<String, bool>,
  pub sampling_rates: BTreeMap<String, f32>,
  pub retention_raw_days: u32,
  pub retention_daily_days: u32,
  pub flush_interval_seconds: u64,
  pub batch_max_events: u32,
  pub dedupe_ttl_hours: u64,
  pub ingest_rate_limit_per_ip_per_min: u32,
  pub counters: AdminTelemetryCounters,
  pub hot_buffer_len: u64,
  pub persisted_24h: Option<u64>,
  pub daily_rollups_7d: Option<u64>,
  pub last_flush_at: Option<DateTime<Utc>>,
  pub last_flush_count: u64,
  pub dedupe_hit_rate: f32,
}

/// Admin GraphQL response for an operator-triggered telemetry flush.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct AdminTelemetryFlushResponse {
  pub buffered: u64,
  pub inserted: u64,
}

/// Build the admin metrics runtime snapshot without transport/auth concerns.
#[instrument(skip_all, level = "debug")]
pub async fn metrics_status_snapshot(state: &ApiState) -> AdminMetricsStatusResponse {
  let cfg = &state.config.metrics;
  let svc = state.metrics();
  let counters = svc.recorder().counters();

  let persisted_24h = match svc.count_recent(Utc::now() - Duration::hours(24)).await {
    Ok(n) => Some(n),
    Err(err) => {
      warn!(error = ?err, "metrics count_recent(24h) query failed");
      None
    }
  };

  let daily_rollups_7d = match svc
    .count_daily_since(
      (Utc::now() - Duration::days(7))
        .date_naive()
        .max(NaiveDate::from_ymd_opt(1970, 1, 1).expect("valid epoch date")),
    )
    .await
  {
    Ok(n) => Some(n),
    Err(err) => {
      warn!(error = ?err, "metrics count_daily_since(7d) query failed");
      None
    }
  };

  // Use the diagnostic read-view, not `snapshot()`: status polling must not
  // affect flush accounting or make operational counters drift.
  let now = Utc::now();
  let mut all = svc.recorder().inspect_series(now);
  all.sort_by(|a, b| b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal));
  let top_series = all
    .into_iter()
    .take(10)
    .map(|s| AdminMetricsTopSeries {
      category: s.category,
      name: s.metric_name,
      labels: s.labels,
      value: s.value,
    })
    .collect();

  let snapshot = AdminMetricsStatusResponse {
    enabled: cfg.enabled,
    prometheus_enabled: cfg.prometheus_enabled,
    persistence_enabled: cfg.persistence_enabled,
    categories: cfg.categories.iter().map(|(k, v)| (k.clone(), *v)).collect(),
    flush_interval_seconds: cfg.flush_interval_seconds,
    retention_raw_days: cfg.retention_raw_days,
    retention_daily_days: cfg.retention_daily_days,
    cardinality_limit_per_metric: cfg.cardinality_limit_per_metric,
    label_workspace_id_enabled: cfg.label_workspace_id_enabled,
    active_series: svc.active_series() as u64,
    persisted_24h,
    daily_rollups_7d,
    last_flush_at: svc
      .last_flush_unix_secs()
      .and_then(|s| DateTime::<Utc>::from_timestamp(s as i64, 0)),
    last_flush_count: svc.last_flush_count(),
    counters: AdminMetricsCounters {
      offered_total: counters.offered_total.load(Ordering::Relaxed),
      accepted_total: counters.accepted_total.load(Ordering::Relaxed),
      rejected_disabled_total: counters.rejected_disabled_total.load(Ordering::Relaxed),
      cardinality_drops_total: counters.cardinality_drops_total.load(Ordering::Relaxed),
      snapshots_total: counters.snapshots_total.load(Ordering::Relaxed),
    },
    top_series,
  };

  debug!(
    enabled = snapshot.enabled,
    active = snapshot.active_series,
    persisted_24h = ?snapshot.persisted_24h,
    "admin metrics status snapshot built"
  );
  snapshot
}

/// Drain the in-process metrics recorder and persist the current samples.
#[instrument(skip_all, level = "debug")]
pub async fn flush_metrics_now(state: &ApiState) -> Result<AdminMetricsFlushResponse, String> {
  match state.metrics().flush_now().await {
    Ok(stats) => {
      info!(
        buffered = stats.buffered,
        inserted = stats.inserted,
        "admin-triggered metrics flush"
      );
      Ok(AdminMetricsFlushResponse {
        buffered: stats.buffered,
        inserted: stats.inserted,
      })
    }
    Err(err) => {
      warn!(error = ?err, "admin-triggered metrics flush failed");
      Err(err.to_string())
    }
  }
}

/// Build the admin telemetry runtime snapshot without transport/auth concerns.
#[instrument(skip_all, level = "debug")]
pub async fn telemetry_status_snapshot(state: &ApiState) -> AdminTelemetryStatusResponse {
  let cfg = &state.config.telemetry;
  let svc = state.telemetry();
  let counters = svc.counters();

  let persisted_24h = match svc.persisted_since(Utc::now() - Duration::hours(24)).await {
    Ok(n) => Some(n),
    Err(err) => {
      warn!(error = ?err, "persisted_since(24h) query failed");
      None
    }
  };

  let daily_rollups_7d = match svc
    .daily_rollups_since((Utc::now() - Duration::days(7)).date_naive())
    .await
  {
    Ok(n) => Some(n),
    Err(err) => {
      warn!(error = ?err, "daily_rollups_since(7d) query failed");
      None
    }
  };

  let offered = counters.offered_total.load(Ordering::Relaxed);
  let duplicates = counters.rejected_duplicate_total.load(Ordering::Relaxed);
  let dedupe_hit_rate = if offered == 0 {
    0.0
  } else {
    ((duplicates as f64) / (offered as f64)).clamp(0.0, 1.0) as f32
  };

  let snapshot = AdminTelemetryStatusResponse {
    enabled: cfg.enabled,
    categories: cfg.categories.iter().map(|(k, v)| (k.clone(), *v)).collect(),
    sampling_rates: cfg
      .sampling_rates
      .iter()
      .map(|(k, v)| (k.clone(), v.clamp(0.0, 1.0)))
      .collect(),
    retention_raw_days: cfg.retention_raw_days,
    retention_daily_days: cfg.retention_daily_days,
    flush_interval_seconds: cfg.flush_interval_seconds,
    batch_max_events: cfg.batch_max_events,
    dedupe_ttl_hours: cfg.dedupe_ttl_hours,
    ingest_rate_limit_per_ip_per_min: cfg.ingest_rate_limit_per_ip_per_min,
    counters: AdminTelemetryCounters {
      offered_total: counters.offered_total.load(Ordering::Relaxed),
      accepted_total: counters.accepted_total.load(Ordering::Relaxed),
      rejected_disabled_total: counters.rejected_disabled_total.load(Ordering::Relaxed),
      rejected_category_total: counters.rejected_category_total.load(Ordering::Relaxed),
      rejected_sampled_total: counters.rejected_sampled_total.load(Ordering::Relaxed),
      rejected_duplicate_total: counters.rejected_duplicate_total.load(Ordering::Relaxed),
      rejected_invalid_total: counters.rejected_invalid_total.load(Ordering::Relaxed),
      buffer_overflow_total: counters.buffer_overflow_total.load(Ordering::Relaxed),
      flushed_total: counters.flushed_total.load(Ordering::Relaxed),
    },
    hot_buffer_len: svc.buffer_len().await as u64,
    persisted_24h,
    daily_rollups_7d,
    last_flush_at: svc
      .last_flush_unix_secs()
      .and_then(|s| DateTime::<Utc>::from_timestamp(s as i64, 0)),
    last_flush_count: svc.last_flush_count(),
    dedupe_hit_rate,
  };

  debug!(
    enabled = snapshot.enabled,
    buffer = snapshot.hot_buffer_len,
    accepted = snapshot.counters.accepted_total,
    "admin telemetry status snapshot built"
  );
  snapshot
}

/// Drain the in-process telemetry hot buffer and persist the current batch.
#[instrument(skip_all, level = "debug")]
pub async fn flush_telemetry_now(state: &ApiState) -> Result<AdminTelemetryFlushResponse, String> {
  let batch_max = state.config.telemetry.batch_max_events;
  match state.telemetry().flush_batch(batch_max).await {
    Ok(stats) => {
      info!(
        buffered = stats.buffered,
        inserted = stats.inserted,
        "admin-triggered telemetry flush"
      );
      Ok(AdminTelemetryFlushResponse {
        buffered: stats.buffered,
        inserted: stats.inserted,
      })
    }
    Err(err) => {
      warn!(error = ?err, "admin-triggered telemetry flush failed");
      Err(err.to_string())
    }
  }
}
