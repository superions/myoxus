// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for `GET /api/telemetry/status` (P-Telemetry-F).
//!
//! The endpoint is unauthenticated and exposes only the runtime policy
//! knobs the client needs for opt-out + pre-sampling:
//!   - `enabled`, `categories`, `samplingRates`, `schema.{min,max}`.
//!
//! It must NOT leak internals such as hot-buffer state, Prometheus
//! counters, or per-user data.

use crate::helpers;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};

async fn make_app() -> axum::Router {
  let pool = helpers::setup_pool().await;
  let config = AppConfig::load().expect("config");
  let state = ApiState::new(config).with_metrics_pool(pool);
  build_router(state)
}

async fn get_status(app: axum::Router) -> Value {
  let resp = app
    .oneshot(
      Request::builder()
        .uri("/api/telemetry/status")
        .body(Body::empty())
        .expect("req"),
    )
    .await
    .expect("oneshot");
  assert_eq!(resp.status(), 200);
  let bytes = resp.into_body().collect().await.expect("body").to_bytes();
  serde_json::from_slice(&bytes).expect("json")
}

/// The response has exactly the four documented top-level keys and no
/// surprise internals (user_id lists, buffer stats, counters, etc.).
#[tokio::test]
async fn inv_tel_status_public_schema_only() {
  let app = make_app().await;
  let body = get_status(app).await;

  assert!(body.get("enabled").is_some(), "missing 'enabled'");
  assert!(body.get("categories").is_some(), "missing 'categories'");
  assert!(body.get("samplingRates").is_some(), "missing 'samplingRates'");
  assert!(body.get("schema").is_some(), "missing 'schema'");

  let obj = body.as_object().expect("object");
  assert_eq!(
    obj.len(),
    4,
    "status response must have exactly 4 keys, got: {:?}",
    obj.keys().collect::<Vec<_>>()
  );

  // Positive assertion: the fields the client reads are the right types.
  assert!(body["enabled"].is_boolean());
  assert!(body["categories"].is_object());
  assert!(body["samplingRates"].is_object());
  let schema = &body["schema"];
  assert!(schema["min"].is_number());
  assert!(schema["max"].is_number());

  // Negative: no PII or internal leaks.
  for forbidden in ["users", "user_ids", "events", "buffered", "inserted", "prometheus"] {
    assert!(
      body.get(forbidden).is_none(),
      "status leaked forbidden key '{forbidden}'"
    );
  }
}

/// Schema min/max must be the published constants.  A mismatch here would
/// mean the client and server disagree on what `schemaVersion` to send.
#[tokio::test]
async fn inv_tel_status_reports_schema_range() {
  let app = make_app().await;
  let body = get_status(app).await;
  assert_eq!(
    body["schema"]["min"],
    myoxus_application::telemetry::TELEMETRY_SCHEMA_MIN
  );
  assert_eq!(
    body["schema"]["max"],
    myoxus_application::telemetry::TELEMETRY_SCHEMA_MAX
  );
}
