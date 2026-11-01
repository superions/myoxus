//! Integration tests for health, readiness, and liveness endpoints.
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use serde_json::Value;
use tower::ServiceExt;

fn test_state() -> ApiState {
  let mut config = AppConfig::load().expect("config");
  config.metrics.enabled = true;
  let state = ApiState::new(config);
  state.set_ready(true);
  state
}

#[tokio::test]
async fn partial_state_is_not_ready() {
  let state = ApiState::new(AppConfig::load().expect("config"));
  let app = build_router(state);
  let response = app
    .oneshot(
      Request::builder()
        .uri("/ready")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(response.status(), 503);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let payload: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert_eq!(payload["status"], "not ready");
}

#[tokio::test]
async fn health_ready_live_and_metrics_are_exposed() {
  let app = build_router(test_state());

  let health = app
    .clone()
    .oneshot(
      Request::builder()
        .uri("/health")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(health.status(), 200);
  let health_body = health.into_body().collect().await.expect("collect body").to_bytes();
  let health_payload: Value = serde_json::from_slice(&health_body).expect("JSON parse");
  assert_eq!(health_payload["status"], "ok");
  assert!(health_payload["checks"].is_array());

  let ready = app
    .clone()
    .oneshot(
      Request::builder()
        .uri("/ready")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(ready.status(), 200);
  let ready_body = ready.into_body().collect().await.expect("collect body").to_bytes();
  let ready_payload: Value = serde_json::from_slice(&ready_body).expect("JSON parse");
  assert_eq!(ready_payload["status"], "ready");
  assert!(ready_payload["checks"].is_array());

  let live = app
    .clone()
    .oneshot(
      Request::builder()
        .uri("/live")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(live.status(), 200);
  let live_body = live.into_body().collect().await.expect("collect body").to_bytes();
  let live_payload: Value = serde_json::from_slice(&live_body).expect("JSON parse");
  assert_eq!(live_payload["status"], "live");
  assert!(
    live_payload["checks"]
      .as_array()
      .expect("expected JSON field")
      .is_empty()
  );

  let metrics = app
    .oneshot(
      Request::builder()
        .uri("/metrics")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(metrics.status(), 200);
  let body = metrics.into_body().collect().await.expect("collect body").to_bytes();
  let payload = String::from_utf8(body.to_vec()).expect("JSON parse");
  assert!(payload.contains("requests_total"));

  // `metrics.enabled` controls business-event recording. It must never hide
  // the process-health exporter used by infrastructure monitoring.
  let mut disabled_config = AppConfig::load().expect("config");
  disabled_config.metrics.enabled = false;
  let disabled_metrics = build_router(ApiState::new(disabled_config))
    .oneshot(
      Request::builder()
        .uri("/metrics/prometheus")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(disabled_metrics.status(), 200);
  let disabled_body = disabled_metrics
    .into_body()
    .collect()
    .await
    .expect("collect body")
    .to_bytes();
  let disabled_payload = String::from_utf8(disabled_body.to_vec()).expect("Prometheus text");
  assert!(disabled_payload.contains("myoxus_requests_total"));
}

/// /health returns uptime_seconds as a non-negative integer.
#[tokio::test]
async fn health_contains_uptime_seconds() {
  let app = build_router(test_state());
  let resp = app
    .oneshot(
      Request::builder()
        .uri("/health")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  let body = resp.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert!(json["uptime_seconds"].as_u64().is_some());
}

/// /ready status field is "ready" (distinct from /health "ok").
#[tokio::test]
async fn ready_status_differs_from_health() {
  let app = build_router(test_state());
  let h = app
    .clone()
    .oneshot(
      Request::builder()
        .uri("/health")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  let h_body = h.into_body().collect().await.expect("collect body").to_bytes();
  let h_json: Value = serde_json::from_slice(&h_body).expect("JSON parse");
  let r = app
    .oneshot(
      Request::builder()
        .uri("/ready")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  let r_body = r.into_body().collect().await.expect("collect body").to_bytes();
  let r_json: Value = serde_json::from_slice(&r_body).expect("JSON parse");
  assert_eq!(h_json["status"], "ok");
  assert_eq!(r_json["status"], "ready");
}

/// /metrics returns JSON with all expected top-level fields.
#[tokio::test]
async fn metrics_json_shape() {
  let app = build_router(test_state());
  let resp = app
    .oneshot(
      Request::builder()
        .uri("/metrics")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(resp.status(), 200);
  let body = resp.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert!(
    json["process_uptime_seconds"].as_u64().is_some(),
    "process_uptime_seconds must be present as u64, got: {}",
    json["process_uptime_seconds"]
  );
  assert!(
    json["requests_total"].as_u64().is_some(),
    "requests_total must be present as u64, got: {}",
    json["requests_total"]
  );
  assert!(
    json["requests_error_total"].as_u64().is_some(),
    "requests_error_total must be present as u64, got: {}",
    json["requests_error_total"]
  );
  assert!(
    json["request_error_rate"].as_f64().is_some_and(|v| v >= 0.0),
    "request_error_rate must be a non-negative f64, got: {}",
    json["request_error_rate"]
  );
  assert!(
    json["request_throughput_rps"].as_f64().is_some_and(|v| v >= 0.0),
    "request_throughput_rps must be a non-negative f64, got: {}",
    json["request_throughput_rps"]
  );
  assert!(
    json["request_latency_avg_ms"].as_f64().is_some_and(|v| v >= 0.0),
    "request_latency_avg_ms must be a non-negative f64, got: {}",
    json["request_latency_avg_ms"]
  );
  assert!(
    json["request_latency_max_ms"].as_f64().is_some_and(|v| v >= 0.0),
    "request_latency_max_ms must be a non-negative f64, got: {}",
    json["request_latency_max_ms"]
  );
  assert!(json["worker_queues"].is_array(), "worker_queues must be an array");
}
