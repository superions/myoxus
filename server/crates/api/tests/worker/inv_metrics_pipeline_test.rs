// SPDX-License-Identifier: AGPL-3.0-or-later
//! End-to-end invariant tests for the business-metrics pipeline (P-Metrics-G).
//!
//! Each test is named after the invariant it guards (INV-MET-*) and exercises
//! the service → recorder → `metrics_raw` / `metrics_daily` path against a
//! real Postgres instance.  Tests follow the telemetry-pipeline pattern: a
//! live `MetricsService` wired with the real `SqlxMetricsRepository`.
//!
//! The recorder-only unit tests in `myoxus_application::metrics::recorder`
//! cover the pure in-memory guards (cardinality, category gate, canonical
//! labels).  These tests complement them with DB-level assertions.

use crate::helpers;

use std::sync::Arc;

use axum::{body::Body, http::Request};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use myoxus_api::{
  build_router_for_integration_tests as build_router,
  config::AppConfig,
  metrics_worker::{MetricsQueueHandler, flush_on_shutdown},
  state::ApiState,
};
use myoxus_application::metrics::{InMemoryMetricsRecorder, MetricsCategory, MetricsPolicy, MetricsService};
use myoxus_domain::metrics::MetricsRepository;
use myoxus_infrastructure::metrics::SqlxMetricsRepository;
use myoxus_worker::{Job, JobHandler, JobOptions};

fn test_job(name: &str) -> Job {
  Job {
    id: format!("test-{name}"),
    name: name.to_string(),
    data: json!({}),
    opts: JobOptions::default(),
    timestamp: Utc::now().timestamp_millis(),
    attempts_made: 0,
    finished_on: None,
    failed_reason: None,
    heartbeat: None,
    return_value: None,
  }
}

/// Build a `MetricsService` backed by the shared test pool.  The recorder is
/// seeded with a permissive policy (core test categories enabled, cardinality
/// 10k) that callers can override via `mutate`.
fn make_service(pool: &PgPool, mutate: impl FnOnce(&mut MetricsPolicy)) -> Arc<MetricsService> {
  let mut policy = MetricsPolicy {
    enabled: true,
    categories: ["auth", "workspace", "doc", "collab", "ai"]
      .iter()
      .map(|c| (c.to_string(), true))
      .collect(),
    label_workspace_id_enabled: false,
    cardinality_limit_per_metric: 10_000,
  };
  mutate(&mut policy);
  let recorder = Arc::new(InMemoryMetricsRecorder::new(policy));
  let repo: Arc<dyn MetricsRepository> = Arc::new(SqlxMetricsRepository::new(pool.clone()));
  Arc::new(MetricsService::new(recorder, repo))
}

async fn make_router_with_service(pool: &PgPool, svc: Arc<MetricsService>) -> axum::Router {
  let mut config = AppConfig::load().expect("config");
  // Ensure Prometheus export of business metrics is on for the inv_met03 /
  // inv_met08 scrape assertions.
  config.metrics.enabled = true;
  config.metrics.prometheus_enabled = true;
  // Enable /metrics/prometheus at the handler level too.
  sqlx::query(
    "INSERT INTO app_configs (id, value) VALUES ('metrics.enabled', 'true')
     ON CONFLICT (id) DO UPDATE SET value = 'true'",
  )
  .execute(pool)
  .await
  .expect("enable metrics in app_configs");

  let state = ApiState::new(config)
    .with_metrics_pool(pool.clone())
    .with_metrics_service(svc);
  build_router(state)
}

async fn cleanup_metric(pool: &PgPool, metric_name: &str) {
  sqlx::query("DELETE FROM metrics_raw WHERE metric_name = $1")
    .bind(metric_name)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM metrics_daily WHERE metric_name = $1")
    .bind(metric_name)
    .execute(pool)
    .await
    .ok();
}

async fn count_raw(pool: &PgPool, metric_name: &str) -> i64 {
  let (c,): (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM metrics_raw WHERE metric_name = $1")
    .bind(metric_name)
    .fetch_one(pool)
    .await
    .expect("count_raw");
  c
}

async fn sum_raw_value(pool: &PgPool, metric_name: &str) -> f64 {
  let (s,): (Option<f64>,) = sqlx::query_as("SELECT SUM(value) FROM metrics_raw WHERE metric_name = $1")
    .bind(metric_name)
    .fetch_one(pool)
    .await
    .expect("sum_raw");
  s.unwrap_or(0.0)
}

// ─── INV-MET-03 happy path: record → flush → metrics_raw ─────────────────────

/// Recording a hook and then flushing persists exactly one row in
/// `metrics_raw` with the accumulated delta.
#[tokio::test]
async fn inv_met01_signup_increments_counter() {
  let pool = helpers::setup_pool().await;
  let metric = format!("inv_met01_signup_{}", Uuid::new_v4().simple());
  let svc = make_service(&pool, |_| {});

  svc.record(MetricsCategory::Auth, &metric, &[("provider", "password")]);
  svc.record(MetricsCategory::Auth, &metric, &[("provider", "password")]);
  let stats = svc.flush_now().await.expect("flush");
  assert_eq!(stats.buffered, 1, "one distinct series");
  assert_eq!(stats.inserted, 1, "one UPSERT row");

  assert_eq!(count_raw(&pool, &metric).await, 1);
  let total = sum_raw_value(&pool, &metric).await;
  assert!((total - 2.0).abs() < f64::EPSILON, "value must sum to 2.0, got {total}");

  cleanup_metric(&pool, &metric).await;
}

// ─── INV-MET-01 fail-closed: disabled category drops ──────────────────────────

/// When a category is toggled off in the policy the hook is a no-op — no row
/// reaches the recorder or the DB after a flush.
#[tokio::test]
async fn inv_met02_disabled_category_skips_increment() {
  let pool = helpers::setup_pool().await;
  let metric = format!("inv_met02_{}", Uuid::new_v4().simple());
  let svc = make_service(&pool, |p| {
    p.categories.insert("auth".into(), false);
  });

  svc.record(MetricsCategory::Auth, &metric, &[]);
  let stats = svc.flush_now().await.expect("flush");
  assert_eq!(stats.buffered, 0);
  assert_eq!(stats.inserted, 0);

  assert_eq!(count_raw(&pool, &metric).await, 0);
}

// ─── INV-MET-02 / INV-MET-03: Prometheus surface ──────────────────────────────

/// After a recorded hook the Prometheus scrape body MUST contain both the
/// business-metric series name and the recorder-level bookkeeping counters.
#[tokio::test]
async fn inv_met03_prometheus_exports_business_metrics() {
  let pool = helpers::setup_pool().await;
  let metric = format!("inv_met03_{}", Uuid::new_v4().simple());
  let svc = make_service(&pool, |_| {});
  svc.record(MetricsCategory::Doc, &metric, &[("source", "ws")]);

  let app = make_router_with_service(&pool, svc.clone()).await;
  let resp = app
    .oneshot(
      Request::builder()
        .uri("/metrics/prometheus")
        .body(Body::empty())
        .expect("req"),
    )
    .await
    .expect("resp");
  assert_eq!(resp.status(), 200);
  let body = resp.into_body().collect().await.expect("body").to_bytes();
  let text = String::from_utf8(body.to_vec()).expect("utf8");

  let expected_series = format!("myoxus_metric_doc_{metric}");
  assert!(
    text.contains(&expected_series),
    "body must contain business-series `{expected_series}`\nbody:\n{text}"
  );
  assert!(text.contains("source=\"ws\""), "label preserved in scrape");
  assert!(text.contains("myoxus_metrics_active_series"), "recorder gauge present");
  assert!(
    text.contains("myoxus_metrics_flush_interval_seconds"),
    "flush-timing gauge exposed for MetricsFlushStalled alert"
  );
}

// ─── INV-MET-04 rollup idempotence ────────────────────────────────────────────

/// Seeding two `metrics_raw` rows for yesterday and running the rollup
/// produces one `metrics_daily` entry with the summed value.  A second run is
/// idempotent (same sum, same count).
#[tokio::test]
async fn inv_met04_daily_rollup_aggregates() {
  let pool = helpers::setup_pool().await;
  let svc = make_service(&pool, |_| {});
  let metric = format!("inv_met04_{}", Uuid::new_v4().simple());

  let yesterday = Utc::now() - Duration::days(1);
  let day = yesterday.date_naive();
  let minute1 = yesterday.date_naive().and_hms_opt(10, 0, 0).unwrap().and_utc();
  let minute2 = yesterday.date_naive().and_hms_opt(11, 0, 0).unwrap().and_utc();
  for (m, v) in [(minute1, 3.0f64), (minute2, 5.0f64)] {
    sqlx::query(
      "INSERT INTO metrics_raw (minute, category, metric_name, labels, value)
       VALUES ($1, 'doc', $2, '{}'::jsonb, $3)",
    )
    .bind(m)
    .bind(&metric)
    .bind(v)
    .execute(&pool)
    .await
    .expect("seed raw");
  }
  // Pre-clean any stale rollup row.
  sqlx::query("DELETE FROM metrics_daily WHERE day = $1 AND metric_name = $2")
    .bind(day)
    .bind(&metric)
    .execute(&pool)
    .await
    .ok();

  let handler = MetricsQueueHandler {
    service: svc,
    pool: pool.clone(),
    persistence_enabled: true,
    retention_raw_days: 14,
    retention_daily_days: 90,
  };
  for attempt in 1..=2 {
    let result = handler
      .process(&test_job("metrics.rollup"))
      .await
      .unwrap_or_else(|error| panic!("rollup {attempt}: {error}"))
      .expect("rollup result");
    assert!(
      result["rows_upserted"].as_u64().is_some_and(|rows| rows >= 1),
      "rollup attempt {attempt} must execute the worker's guarded persistence path"
    );
  }

  let (sum, count): (f64, i64) = sqlx::query_as(
    "SELECT sum::float8, count::bigint FROM metrics_daily
     WHERE day = $1 AND metric_name = $2 AND category = 'doc'",
  )
  .bind(day)
  .bind(&metric)
  .fetch_one(&pool)
  .await
  .expect("daily row");
  assert!((sum - 8.0).abs() < f64::EPSILON, "rollup sum must be 8.0, got {sum}");
  assert_eq!(count, 2, "two contributing minute buckets");

  cleanup_metric(&pool, &metric).await;
}

// ─── INV-MET-05 retention ─────────────────────────────────────────────────────

/// The retention job prunes rows in `metrics_raw` older than
/// `retention_raw_days` but leaves younger rows untouched.
#[tokio::test]
async fn inv_met05_retention_prunes_old_rows() {
  let pool = helpers::setup_pool().await;
  let svc = make_service(&pool, |_| {});
  let metric = format!("inv_met05_{}", Uuid::new_v4().simple());

  let old_minute = (Utc::now() - Duration::days(30))
    .date_naive()
    .and_hms_opt(0, 0, 0)
    .unwrap()
    .and_utc();
  let fresh_minute = (Utc::now() - Duration::hours(2))
    .date_naive()
    .and_hms_opt(0, 0, 0)
    .unwrap()
    .and_utc();
  for (m, label) in [(old_minute, "old"), (fresh_minute, "fresh")] {
    sqlx::query(
      "INSERT INTO metrics_raw (minute, category, metric_name, labels, value)
       VALUES ($1, 'doc', $2, jsonb_build_object('age', $3::text), 1.0)",
    )
    .bind(m)
    .bind(&metric)
    .bind(label)
    .execute(&pool)
    .await
    .expect("seed row");
  }

  let handler = MetricsQueueHandler {
    service: svc.clone(),
    pool: pool.clone(),
    persistence_enabled: true,
    retention_raw_days: 14,
    retention_daily_days: 90,
  };
  handler
    .process(&test_job("metrics.retention"))
    .await
    .expect("retention");

  let (old_count,): (i64,) =
    sqlx::query_as("SELECT COUNT(*)::bigint FROM metrics_raw WHERE metric_name = $1 AND labels->>'age' = 'old'")
      .bind(&metric)
      .fetch_one(&pool)
      .await
      .expect("old count");
  let (fresh_count,): (i64,) =
    sqlx::query_as("SELECT COUNT(*)::bigint FROM metrics_raw WHERE metric_name = $1 AND labels->>'age' = 'fresh'")
      .bind(&metric)
      .fetch_one(&pool)
      .await
      .expect("fresh count");
  assert_eq!(old_count, 0, "30d-old row must be pruned");
  assert_eq!(fresh_count, 1, "2h-old row must survive");

  cleanup_metric(&pool, &metric).await;
}

// ─── INV-MET-06 workspace-id toggle ───────────────────────────────────────────

/// The recorder strips the `workspace_id` label when
/// `label_workspace_id_enabled=false`, so hooks can emit it unconditionally
/// without exploding cardinality.  When the toggle is on the label is kept.
#[tokio::test]
async fn inv_met06_workspace_label_toggle_honored() {
  let pool = helpers::setup_pool().await;

  // Toggle OFF: two different workspace_ids collapse into a single series.
  let metric_off = format!("inv_met06_off_{}", Uuid::new_v4().simple());
  let svc_off = make_service(&pool, |p| {
    p.label_workspace_id_enabled = false;
  });
  svc_off.record(
    MetricsCategory::Workspace,
    &metric_off,
    &[("workspace_id", "ws-a"), ("source", "graphql")],
  );
  svc_off.record(
    MetricsCategory::Workspace,
    &metric_off,
    &[("workspace_id", "ws-b"), ("source", "graphql")],
  );
  svc_off.flush_now().await.expect("flush off");
  assert_eq!(
    count_raw(&pool, &metric_off).await,
    1,
    "toggle off → workspace_id stripped → collapsed to 1 series"
  );
  let sum_off = sum_raw_value(&pool, &metric_off).await;
  assert!((sum_off - 2.0).abs() < f64::EPSILON);
  cleanup_metric(&pool, &metric_off).await;

  // Toggle ON: two workspace_ids yield two distinct series.
  let metric_on = format!("inv_met06_on_{}", Uuid::new_v4().simple());
  let svc_on = make_service(&pool, |p| {
    p.label_workspace_id_enabled = true;
  });
  svc_on.record(
    MetricsCategory::Workspace,
    &metric_on,
    &[("workspace_id", "ws-a"), ("source", "graphql")],
  );
  svc_on.record(
    MetricsCategory::Workspace,
    &metric_on,
    &[("workspace_id", "ws-b"), ("source", "graphql")],
  );
  svc_on.flush_now().await.expect("flush on");
  assert_eq!(
    count_raw(&pool, &metric_on).await,
    2,
    "toggle on → two distinct workspace_ids → 2 series"
  );
  cleanup_metric(&pool, &metric_on).await;
}

// ─── INV-MET-06 cardinality cap ───────────────────────────────────────────────

/// Samples beyond the per-metric cardinality cap are dropped and counted in
/// `cardinality_drops_total` — they MUST NOT reach the DB either.
#[tokio::test]
async fn inv_met07_cardinality_limit_enforced() {
  let pool = helpers::setup_pool().await;
  let metric = format!("inv_met07_{}", Uuid::new_v4().simple());
  let svc = make_service(&pool, |p| {
    p.cardinality_limit_per_metric = 3;
  });

  for i in 0..7 {
    svc.record(MetricsCategory::Ai, &metric, &[("tenant", &format!("t{i}"))]);
  }
  let stats = svc.flush_now().await.expect("flush");
  assert_eq!(stats.buffered, 3, "recorder caps at 3 distinct series");
  assert_eq!(count_raw(&pool, &metric).await, 3, "DB mirrors recorder cap");

  cleanup_metric(&pool, &metric).await;
}

// ─── INV-MET-02 existing Prometheus names preserved ───────────────────────────

/// Adding the business-metrics exporter MUST NOT rename or drop any of the
/// infrastructure metric names Grafana dashboards and alerts already scrape.
#[tokio::test]
async fn inv_met08_existing_prometheus_names_unchanged() {
  let pool = helpers::setup_pool().await;
  let svc = make_service(&pool, |_| {});
  let app = make_router_with_service(&pool, svc).await;
  let resp = app
    .oneshot(
      Request::builder()
        .uri("/metrics/prometheus")
        .body(Body::empty())
        .expect("req"),
    )
    .await
    .expect("resp");
  assert_eq!(resp.status(), 200);
  let body = resp.into_body().collect().await.expect("body").to_bytes();
  let text = String::from_utf8(body.to_vec()).expect("utf8");

  for baseline in [
    "myoxus_requests_total",
    "myoxus_requests_error_total",
    "myoxus_request_error_rate",
    "myoxus_request_throughput_rps",
    "myoxus_request_latency_avg_ms",
    "myoxus_request_latency_max_ms",
    "myoxus_captcha_verified_total",
    "myoxus_captcha_rejected_total",
  ] {
    assert!(
      text.contains(baseline),
      "existing Prometheus metric `{baseline}` MUST remain exposed (INV-MET-02)"
    );
  }
}

// ─── INV-MET-07 graceful shutdown ─────────────────────────────────────────────

/// On graceful shutdown the final flush drains the recorder into `metrics_raw`
/// so no pending delta is lost.
#[tokio::test]
async fn inv_met09_graceful_shutdown_flushes_buffer() {
  let pool = helpers::setup_pool().await;
  let metric = format!("inv_met09_{}", Uuid::new_v4().simple());
  let svc = make_service(&pool, |_| {});
  svc.record(MetricsCategory::Collab, &metric, &[("space_type", "workspace")]);
  assert_eq!(svc.active_series(), 1);

  flush_on_shutdown(&svc, true).await;

  assert_eq!(svc.active_series(), 0, "shutdown must reset recorder");
  assert_eq!(
    count_raw(&pool, &metric).await,
    1,
    "shutdown must persist buffered delta"
  );

  cleanup_metric(&pool, &metric).await;
}

/// Disabling persistence keeps in-memory/Prometheus series intact and prevents
/// the recurring worker from growing the database.
#[tokio::test]
async fn persistence_disabled_skips_database_flush() {
  let pool = helpers::setup_pool().await;
  let metric = format!("persistence_disabled_{}", Uuid::new_v4().simple());
  let svc = make_service(&pool, |_| {});
  svc.record(MetricsCategory::Doc, &metric, &[]);
  let handler = MetricsQueueHandler {
    service: svc.clone(),
    pool: pool.clone(),
    persistence_enabled: false,
    retention_raw_days: 14,
    retention_daily_days: 90,
  };

  let result = handler
    .process(&test_job("metrics.flush"))
    .await
    .expect("disabled persistence is a successful no-op")
    .expect("worker result");
  assert_eq!(result["skipped"], "persistence_disabled");
  assert_eq!(svc.active_series(), 1, "Prometheus series must remain available");
  assert_eq!(
    count_raw(&pool, &metric).await,
    0,
    "disabled persistence must not write rows"
  );
}

// ─── INV-MET-08 no PII in admin status ────────────────────────────────────────

/// The admin-status response MUST NOT expose per-user, per-IP, or session
/// identifiers, even structurally.  Walks the serialized JSON shape for a
/// forbidden-key allow-list (same technique as inv_tel13).
#[tokio::test]
async fn inv_met10_labels_contain_no_pii() {
  use myoxus_api::admin_runtime_status::{AdminMetricsCounters, AdminMetricsStatusResponse, AdminMetricsTopSeries};
  use std::collections::BTreeMap;

  let sample = AdminMetricsStatusResponse {
    enabled: true,
    prometheus_enabled: true,
    persistence_enabled: true,
    label_workspace_id_enabled: false,
    categories: BTreeMap::from([("auth".to_string(), true)]),
    flush_interval_seconds: 60,
    retention_raw_days: 14,
    retention_daily_days: 90,
    cardinality_limit_per_metric: 10_000,
    active_series: 0,
    persisted_24h: Some(0),
    daily_rollups_7d: Some(0),
    last_flush_at: None,
    last_flush_count: 0,
    counters: AdminMetricsCounters {
      offered_total: 0,
      accepted_total: 0,
      rejected_disabled_total: 0,
      cardinality_drops_total: 0,
      snapshots_total: 0,
    },
    top_series: vec![AdminMetricsTopSeries {
      category: "auth".into(),
      name: "user_signin".into(),
      labels: json!({"method": "password"}),
      value: 1.0,
    }],
  };
  let value = serde_json::to_value(&sample).expect("serialize");

  fn walk_keys(v: &Value, seen: &mut Vec<String>) {
    match v {
      Value::Object(map) => {
        for (k, sub) in map {
          seen.push(k.clone());
          walk_keys(sub, seen);
        }
      }
      Value::Array(items) => items.iter().for_each(|x| walk_keys(x, seen)),
      _ => {}
    }
  }
  let mut keys = Vec::new();
  walk_keys(&value, &mut keys);

  for bad in &[
    "user_id",
    "userId",
    "email",
    "ip",
    "ip_address",
    "ipAddress",
    "client_id",
    "clientId",
    "session_id",
    "sessionId",
    "remote_addr",
    "remoteAddr",
  ] {
    assert!(
      !keys.iter().any(|k| k == bad),
      "admin metrics status must not expose `{bad}` — keys seen: {keys:?}"
    );
  }

  // Label allow-list: no hook emits PII keys.  Spot-check the top_series
  // label bag against the same forbidden list.
  let labels_str = serde_json::to_string(&sample.top_series[0].labels).unwrap();
  for bad in &["email", "ip", "user_id", "session_id"] {
    assert!(
      !labels_str.contains(bad),
      "top_series.labels must not contain `{bad}` (INV-MET-08), got: {labels_str}"
    );
  }
}
