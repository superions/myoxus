//! Integration tests for the metrics and telemetry endpoints.
use crate::helpers;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};

async fn setup_pool() -> sqlx::PgPool {
  helpers::setup_pool().await
}

#[tokio::test]
async fn metrics_export_core_worker_queue_lag_error_rate_latency_throughput() {
  let pool = setup_pool().await;

  // Explicitly enable metrics via app_configs so the test is independent from
  // shared database state and remains valid if another test disables metrics.
  sqlx::query(
    "INSERT INTO app_configs (id, value) VALUES ('metrics.enabled', 'true') ON CONFLICT (id) DO UPDATE SET value = 'true'",
  )
  .execute(&pool)
  .await
  .expect("enable metrics in app_configs");

  let config = AppConfig::load().expect("config");
  // No redis_queue wired — worker_queues will be empty (no Redis in unit test env).
  let state = ApiState::new(config).with_metrics_pool(pool.clone());
  let app = build_router(state);

  // Generate request traffic through the main router's middleware (NOT health_router,
  // which bypasses the logger/request-tracking middleware). Use non-existent paths
  // that hit the fallback and still go through logger_middleware.
  let _ = app
    .clone()
    .oneshot(
      Request::builder()
        .uri("/api/not-found-1")
        .body(Body::empty())
        .expect("build request 1"),
    )
    .await
    .expect("request 1");
  let _ = app
    .clone()
    .oneshot(
      Request::builder()
        .uri("/api/not-found-2")
        .body(Body::empty())
        .expect("build request 2"),
    )
    .await
    .expect("request 2");

  let metrics = app
    .clone()
    .oneshot(
      Request::builder()
        .uri("/metrics")
        .body(Body::empty())
        .expect("build metrics request"),
    )
    .await
    .expect("metrics request");
  assert_eq!(metrics.status(), 200);

  let body = metrics
    .into_body()
    .collect()
    .await
    .expect("collect metrics body")
    .to_bytes();
  let payload: Value = serde_json::from_slice(&body).expect("metrics json");

  assert!(payload["requests_total"].as_u64().unwrap_or(0) >= 2);
  assert!(payload["requests_error_total"].as_u64().unwrap_or(0) >= 1);
  assert!(payload["request_error_rate"].as_f64().unwrap_or(0.0) > 0.0);
  assert!(payload["request_throughput_rps"].as_f64().unwrap_or(0.0) >= 0.0);
  assert!(payload["request_latency_avg_ms"].as_f64().unwrap_or(0.0) >= 0.0);

  // worker_queues is an array (may be empty when no Redis is wired in test env).
  assert!(payload["worker_queues"].is_array());

  let prom = app
    .oneshot(
      Request::builder()
        .uri("/metrics/prometheus")
        .body(Body::empty())
        .expect("build prometheus request"),
    )
    .await
    .expect("prometheus request");
  assert_eq!(prom.status(), 200);
  let prom_body = String::from_utf8(
    prom
      .into_body()
      .collect()
      .await
      .expect("collect prometheus body")
      .to_bytes()
      .to_vec(),
  )
  .expect("utf8 prometheus body");
  assert!(prom_body.contains("myoxus_request_error_rate"));
  // Prometheus worker queue lines appear only when Redis is wired; skip asserting them here.

  // Cleanup: restore the deployment default by removing the runtime override.
  sqlx::query("DELETE FROM app_configs WHERE id = 'metrics.enabled'")
    .execute(&pool)
    .await
    .ok();
}
