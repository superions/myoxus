//! Metrics endpoint handlers for the Myoxus server.
//!
//! Provides two metrics surfaces:
//!
//! - `GET /metrics` — JSON response with process uptime, request counters,
//!   average/max latency, and per-queue Redis worker statistics.
//! - `GET /metrics/prometheus` — Prometheus text-format scrape endpoint with
//!   the same counters plus DB pool connection state and entity counts.
//!
//! Metrics are maintained as atomic counters on [`ApiState`] and updated by
//! the logger middleware on every request.

use axum::{
  http::StatusCode,
  response::{IntoResponse, Json},
};
use serde::Serialize;
use tracing::{instrument, warn};

use crate::state::ApiState;

/// JSON body returned by `GET /metrics`.
#[derive(Debug, Serialize)]
pub(crate) struct MetricsResponse {
  /// Seconds since the server process started.
  process_uptime_seconds: u64,
  /// Total number of HTTP requests handled since startup.
  requests_total: u64,
  /// Number of requests that returned a 4xx or 5xx status code.
  requests_error_total: u64,
  /// Ratio of error requests to total requests (0.0–1.0).
  request_error_rate: f64,
  /// Average requests per second since startup.
  request_throughput_rps: f64,
  /// Average request latency across all requests (milliseconds).
  request_latency_avg_ms: f64,
  /// Maximum observed single-request latency (milliseconds).
  request_latency_max_ms: f64,
  /// Per-queue statistics collected from Redis.
  worker_queues: Vec<WorkerQueueMetricsResponse>,
}

/// Per-queue Redis worker metrics included in the metrics response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerQueueMetricsResponse {
  /// Queue name (e.g. `"notification"`, `"doc"`).
  pub(crate) queue: String,
  /// Number of jobs waiting or delayed.
  pub(crate) pending_ready: i64,
  /// Number of jobs in the permanently-failed set.
  pub(crate) failed: i64,
  /// Reserved for future dead-letter queue support; always `0`.
  pub(crate) dead_letter: i64,
  /// Reserved for future queue-lag tracking; always `0.0`.
  pub(crate) queue_lag_seconds: f64,
}

/// Stable queue-label set exported by both metrics endpoints.
///
/// Share the Admin inventory so an idle or newly added worker queue cannot
/// disappear from dashboard totals while remaining visible in job details.
const KNOWN_QUEUE_NAMES: &[&str] = crate::admin_queue::ADMIN_QUEUE_NAMES;

/// `GET /metrics` — returns a JSON snapshot of process-level metrics.
///
/// Does not require authentication. Business-metric policy never hides the
/// process-level operational surface.
#[instrument(skip_all, level = "debug")]
pub(crate) async fn metrics(axum::extract::State(state): axum::extract::State<ApiState>) -> impl IntoResponse {
  let requests_total = state.request_count();
  let requests_error_total = state.request_error_count();
  let request_error_rate = if requests_total == 0 {
    0.0
  } else {
    requests_error_total as f64 / requests_total as f64
  };
  let request_throughput_rps = if state.uptime_seconds() == 0 {
    0.0
  } else {
    requests_total as f64 / state.uptime_seconds() as f64
  };
  let request_latency_avg_ms = if requests_total == 0 {
    0.0
  } else {
    (state.request_latency_total_micros() as f64 / requests_total as f64) / 1000.0
  };
  let request_latency_max_ms = state.request_latency_max_micros() as f64 / 1000.0;
  let worker_queues = collect_worker_queue_metrics(&state).await.unwrap_or_default();

  Json(MetricsResponse {
    process_uptime_seconds: state.uptime_seconds(),
    requests_total,
    requests_error_total,
    request_error_rate,
    request_throughput_rps,
    request_latency_avg_ms,
    request_latency_max_ms,
    worker_queues,
  })
  .into_response()
}

/// `GET /metrics/prometheus` — returns Prometheus-format metrics for scraping.
///
/// Emits `# TYPE` comment lines and gauge/counter values in Prometheus text
/// format 0.0.4.  Optionally includes DB pool metrics and entity counts when a
/// `metrics_pool` is configured.  Does not require authentication.
/// Business series are independently controlled by
/// `metrics.prometheus_enabled`; infrastructure metrics always remain visible.
#[instrument(skip_all, level = "debug")]
pub(crate) async fn metrics_prometheus(
  axum::extract::State(state): axum::extract::State<ApiState>,
) -> impl IntoResponse {
  let effective = state.effective_config().await;
  let requests_total = state.request_count();
  let requests_error_total = state.request_error_count();
  let request_error_rate = if requests_total == 0 {
    0.0
  } else {
    requests_error_total as f64 / requests_total as f64
  };
  let request_throughput_rps = if state.uptime_seconds() == 0 {
    0.0
  } else {
    requests_total as f64 / state.uptime_seconds() as f64
  };
  let request_latency_avg_ms = if requests_total == 0 {
    0.0
  } else {
    (state.request_latency_total_micros() as f64 / requests_total as f64) / 1000.0
  };
  let request_latency_max_ms = state.request_latency_max_micros() as f64 / 1000.0;
  let worker_queues = collect_worker_queue_metrics(&state).await.unwrap_or_default();

  let mut body = String::new();
  body.push_str("# TYPE myoxus_requests_total counter\n");
  body.push_str(&format!("myoxus_requests_total {}\n", requests_total));
  body.push_str("# TYPE myoxus_requests_error_total counter\n");
  body.push_str(&format!("myoxus_requests_error_total {}\n", requests_error_total));
  body.push_str("# TYPE myoxus_request_error_rate gauge\n");
  body.push_str(&format!("myoxus_request_error_rate {:.6}\n", request_error_rate));
  body.push_str("# TYPE myoxus_request_throughput_rps gauge\n");
  body.push_str(&format!(
    "myoxus_request_throughput_rps {:.6}\n",
    request_throughput_rps
  ));
  body.push_str("# TYPE myoxus_request_latency_avg_ms gauge\n");
  body.push_str(&format!(
    "myoxus_request_latency_avg_ms {:.6}\n",
    request_latency_avg_ms
  ));
  body.push_str("# TYPE myoxus_request_latency_max_ms gauge\n");
  body.push_str(&format!(
    "myoxus_request_latency_max_ms {:.6}\n",
    request_latency_max_ms
  ));
  for queue in worker_queues {
    body.push_str(&format!(
      "myoxus_worker_queue_pending_ready{{queue=\"{}\"}} {}\n",
      queue.queue, queue.pending_ready
    ));
    body.push_str(&format!(
      "myoxus_worker_queue_failed{{queue=\"{}\"}} {}\n",
      queue.queue, queue.failed
    ));
    body.push_str(&format!(
      "myoxus_worker_queue_dead_letter{{queue=\"{}\"}} {}\n",
      queue.queue, queue.dead_letter
    ));
    body.push_str(&format!(
      "myoxus_worker_queue_lag_seconds{{queue=\"{}\"}} {:.6}\n",
      queue.queue, queue.queue_lag_seconds
    ));
  }

  // P-Captcha-C: captcha verification counters
  body.push_str("# TYPE myoxus_captcha_verified_total counter\n");
  body.push_str(&format!(
    "myoxus_captcha_verified_total {}\n",
    state.captcha_verified_count()
  ));
  body.push_str("# TYPE myoxus_captcha_rejected_total counter\n");
  body.push_str(&format!(
    "myoxus_captcha_rejected_total {}\n",
    state.captcha_rejected_count()
  ));
  body.push_str("# TYPE myoxus_captcha_honeypot_total counter\n");
  body.push_str(&format!(
    "myoxus_captcha_honeypot_total {}\n",
    state.captcha_honeypot_count()
  ));

  // Frontend telemetry counters
  body.push_str(&state.telemetry().render_prometheus());

  // P-Metrics-B: business-metric counters (recorder state).  Gated by the
  // per-config `prometheus_enabled` flag so operators can run DB-only
  // without the scrape surface (e.g. during a noisy rollout).
  if effective
    .bool("metrics.prometheus_enabled")
    .unwrap_or(state.config_file_baseline.metrics.prometheus_enabled)
  {
    body.push_str(&state.metrics().render_prometheus());
    // P-Metrics-F: flush timing gauges for alerting (MetricsFlushStalled).
    body.push_str("# TYPE myoxus_metrics_last_flush_unix_secs gauge\n");
    body.push_str(&format!(
      "myoxus_metrics_last_flush_unix_secs {}\n",
      state.metrics().last_flush_unix_secs().unwrap_or(0)
    ));
    body.push_str("# TYPE myoxus_metrics_last_flush_count gauge\n");
    body.push_str(&format!(
      "myoxus_metrics_last_flush_count {}\n",
      state.metrics().last_flush_count()
    ));
    body.push_str("# TYPE myoxus_metrics_flush_interval_seconds gauge\n");
    body.push_str(&format!(
      "myoxus_metrics_flush_interval_seconds {}\n",
      state.config.metrics.flush_interval_seconds
    ));
  }

  // Cache metrics (P84-H-20)
  body.push_str(&state.query_cache.render_prometheus());

  // DB pool metrics
  if let Some(pool) = state.metrics_pool() {
    body.push_str("# TYPE myoxus_db_pool_connections gauge\n");
    body.push_str(&format!(
      "myoxus_db_pool_connections{{state=\"active\"}} {}\n",
      pool.size() - pool.num_idle() as u32
    ));
    body.push_str(&format!(
      "myoxus_db_pool_connections{{state=\"idle\"}} {}\n",
      pool.num_idle()
    ));
    body.push_str(&format!(
      "myoxus_db_pool_connections{{state=\"max\"}} {}\n",
      pool.size()
    ));

    // Product counters come from their application owner; the pool is used
    // here only for technical connection metrics.
    if let Ok(user_count) = state.admin().count_users(None).await {
      body.push_str("# TYPE myoxus_user_count gauge\n");
      body.push_str(&format!("myoxus_user_count {}\n", user_count));
    }
    if let Ok(ws_count) = state
      .admin()
      .count_workspaces(&myoxus_application::admin::AdminWorkspaceFilter::default())
      .await
    {
      body.push_str("# TYPE myoxus_workspace_count gauge\n");
      body.push_str(&format!("myoxus_workspace_count {}\n", ws_count));
    }
  }

  (
    StatusCode::OK,
    [(
      axum::http::header::CONTENT_TYPE,
      "text/plain; version=0.0.4; charset=utf-8",
    )],
    body,
  )
    .into_response()
}

/// Collect per-queue statistics from Redis for all known queues.
///
/// Returns an empty `Vec` when no `redis_queue` is configured (e.g. in tests
/// or when Redis is disabled).  Individual queue errors are logged as warnings
/// and skipped rather than failing the entire collection.
#[instrument(skip_all, level = "debug")]
pub(crate) async fn collect_worker_queue_metrics(state: &ApiState) -> Result<Vec<WorkerQueueMetricsResponse>, ()> {
  let Some(queue) = state.redis_queue() else {
    return Ok(Vec::new());
  };
  let mut result = Vec::new();
  for name in KNOWN_QUEUE_NAMES {
    match queue.queue_stats(name).await {
      Ok(stats) => result.push(WorkerQueueMetricsResponse {
        queue: name.to_string(),
        pending_ready: stats.waiting,
        failed: stats.failed,
        dead_letter: 0,
        queue_lag_seconds: 0.0,
      }),
      Err(err) => {
        warn!(queue = %name, error = %err, "redis queue stats failed");
      }
    }
  }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::KNOWN_QUEUE_NAMES;

  #[test]
  fn operational_database_queues_are_exported_by_metrics() {
    assert!(KNOWN_QUEUE_NAMES.contains(&"database"));
    assert!(KNOWN_QUEUE_NAMES.contains(&"workspace-automation"));
    assert!(KNOWN_QUEUE_NAMES.contains(&"workspace-content-operation"));
    assert!(!KNOWN_QUEUE_NAMES.contains(&"workspace-database"));
  }
}
