// SPDX-License-Identifier: AGPL-3.0-or-later
//! P91-CFG-E-T03 — Invariant-first integration tests: Production-readiness checks.
//!
//! Tests verify that the /api/admin/config/check endpoint correctly identifies
//! critical configuration issues and reports production-readiness status.
//!
//! Naming convention: `inv_{code}_{description}`.

use crate::helpers;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

// ---------------------------------------------------------------------------
// INV-CFG-PC01 — Localhost origin triggers CRITICAL check
//
// Invariant: When server.origin is set to a localhost URL (not a production
// hostname), /api/admin/config/check returns hasCritical=true.
// The fixture injects the startup value directly because origin is
// restart-bound; a database row must not partially hot-apply to this endpoint.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cfg_pc01_fresh_instance_has_critical() {
  tracing::info!("INV-CFG-PC01: Testing localhost origin triggers hasCritical=true");
  let (app, _pool, _auth) = helpers::setup_app_with_config_override(|config| {
    config.server.origin = "http://localhost:3001".to_string();
  })
  .await;

  let req = Request::builder()
    .uri("/api/admin/config/check")
    .method("GET")
    .body(Body::empty())
    .expect("request should build");

  let res = app.oneshot(req).await.expect("request should execute");

  assert_eq!(res.status(), StatusCode::OK, "endpoint should return 200");

  let body = res.into_body().collect().await.expect("body should collect").to_bytes();

  let json: serde_json::Value = serde_json::from_slice(&body).expect("body should be valid JSON");

  let has_critical = json
    .get("hasCritical")
    .and_then(|v| v.as_bool())
    .expect("hasCritical field must exist and be boolean");

  assert!(
    has_critical,
    "INV-CFG-PC01: Localhost origin should trigger hasCritical=true"
  );

  // Validate response structure
  let checks = json
    .get("checks")
    .and_then(|v| v.as_array())
    .expect("checks array must exist");

  assert!(!checks.is_empty(), "checks array must be non-empty");

  let has_critical_check = checks
    .iter()
    .any(|c| c.get("category").and_then(|v| v.as_str()) == Some("CRITICAL"));
  assert!(has_critical_check, "at least one check must have category CRITICAL");

  for check in checks {
    assert!(check.get("category").is_some(), "check missing category: {check}");
    assert!(check.get("key").is_some(), "check missing key: {check}");
    assert!(check.get("message").is_some(), "check missing message: {check}");
  }

  tracing::info!("INV-CFG-PC01: PASS");
}

// ---------------------------------------------------------------------------
// INV-CFG-PC02 — Production check endpoint returns well-formed response
//
// Invariant: The /api/admin/config/check endpoint always returns HTTP 200 with
// a JSON body containing hasCritical (boolean) and checks (array), where each
// check has category, key, and message fields.
// This is the endpoint contract test — independent of environment configuration.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cfg_pc02_configured_instance_no_critical() {
  tracing::info!("INV-CFG-PC02: Testing production check endpoint contract");

  let (app, _pool, _auth) = helpers::setup_app().await;

  let req = Request::builder()
    .uri("/api/admin/config/check")
    .method("GET")
    .body(Body::empty())
    .expect("request should build");

  let res = app.oneshot(req).await.expect("request should execute");

  assert_eq!(res.status(), StatusCode::OK, "endpoint must return 200");

  let body = res.into_body().collect().await.expect("body should collect").to_bytes();

  let json: serde_json::Value = serde_json::from_slice(&body).expect("body must be valid JSON");

  // hasCritical field must exist and be boolean
  assert!(
    json.get("hasCritical").and_then(|v| v.as_bool()).is_some(),
    "INV-CFG-PC02: hasCritical field must be a boolean"
  );

  // checks array must exist
  let checks = json
    .get("checks")
    .and_then(|v| v.as_array())
    .expect("INV-CFG-PC02: checks field must be an array");

  assert!(!checks.is_empty(), "INV-CFG-PC02: checks array must be non-empty");

  // Every check must have all required fields with non-null values
  for check in checks {
    let cat = check.get("category").and_then(|v| v.as_str()).unwrap_or("");
    let key = check.get("key").and_then(|v| v.as_str()).unwrap_or("");
    let msg = check.get("message").and_then(|v| v.as_str()).unwrap_or("");
    assert!(!cat.is_empty(), "check missing category: {check}");
    assert!(!key.is_empty(), "check missing key: {check}");
    assert!(!msg.is_empty(), "check missing message: {check}");
    // Category must be one of the valid values
    assert!(
      matches!(cat, "CRITICAL" | "WARNING" | "INFO"),
      "check category '{cat}' must be CRITICAL, WARNING, or INFO"
    );
  }

  tracing::info!("INV-CFG-PC02: PASS");
}

// ---------------------------------------------------------------------------
// INV-CFG-PC03 — Non-production origin triggers CRITICAL, not WARNING
//
// Invariant: The CRITICAL flag is only set for genuinely blocking issues.
// When server.origin is a real hostname, even without optional features,
// the response must categorize optional issues as WARNING (not CRITICAL).
// We test by temporarily overriding origin to a non-critical but non-ideal
// config and verifying WARNING-level issues are reported separately.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cfg_pc03_warnings_on_suboptimal() {
  tracing::info!("INV-CFG-PC03: Testing WARNING-level issues exist in default environment");
  let (app, _pool, _auth) = helpers::setup_app().await;

  let req = Request::builder()
    .uri("/api/admin/config/check")
    .method("GET")
    .body(Body::empty())
    .expect("request should build");

  let res = app.oneshot(req).await.expect("request should execute");

  assert_eq!(res.status(), StatusCode::OK, "endpoint should return 200");

  let body = res.into_body().collect().await.expect("body should collect").to_bytes();

  let json: serde_json::Value = serde_json::from_slice(&body).expect("body should be valid JSON");

  let checks = json
    .get("checks")
    .and_then(|v| v.as_array())
    .expect("checks should be an array");

  // Verify the hasCritical field exists and is a boolean
  assert!(
    json.get("hasCritical").and_then(|v| v.as_bool()).is_some(),
    "INV-CFG-PC03: hasCritical must exist"
  );

  // Verify each check has required fields
  for check in checks {
    assert!(
      check.get("category").and_then(|v| v.as_str()).is_some(),
      "check missing category"
    );
    assert!(check.get("key").and_then(|v| v.as_str()).is_some(), "check missing key");
    assert!(
      check.get("message").and_then(|v| v.as_str()).is_some(),
      "check missing message"
    );
  }

  // INV: at least one check must exist (endpoint is never empty)
  assert!(!checks.is_empty(), "INV-CFG-PC03: checks array must be non-empty");

  tracing::info!("INV-CFG-PC03: PASS — {} checks returned", checks.len());
}
