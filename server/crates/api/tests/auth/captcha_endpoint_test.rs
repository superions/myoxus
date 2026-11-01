// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-Captcha-B integration tests for `GET /api/auth/challenge`.
//!
//! Invariants:
//!
//! * **INV-CAPTCHA-05 (feature gate):** when `captcha.enabled = false`, the
//!   challenge endpoint MUST respond `503 Service Unavailable` so the client
//!   can detect the feature-off case without needing an out-of-band flag.
//! * **INV-CAPTCHA-04 (challenge shape):** when enabled with a valid hmac,
//!   the endpoint MUST return a JSON body with the ALTCHA fields
//!   (`algorithm`, `challenge`, `salt`, `signature`, `maxnumber`).

use axum::{body::Body, http::Request};
use base64::{Engine, engine::general_purpose};
use http_body_util::BodyExt;
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use serde_json::Value;
use tower::ServiceExt;

fn state_with<F: FnOnce(&mut AppConfig)>(mutate: F) -> ApiState {
  let mut config = AppConfig::load().expect("config loads");
  mutate(&mut config);
  ApiState::new(config)
}

#[tokio::test]
async fn inv_captcha05_challenge_endpoint_returns_503_when_disabled() {
  let state = state_with(|c| {
    c.captcha.enabled = false;
  });
  let app = build_router(state);
  let response = app
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/api/auth/challenge")
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(response.status(), 503, "disabled captcha must return 503");
}

/// INV-CAPTCHA-07 (honeypot): a non-empty value in the configured honeypot
/// field causes `/api/auth/sign-in` to reject with `CAPTCHA_HONEYPOT`
/// BEFORE any credential check runs.
#[tokio::test]
async fn inv_captcha07_honeypot_field_set_rejects_sign_in() {
  let state = state_with(|c| {
    c.captcha.enabled = false; // honeypot runs even when captcha is off
    c.captcha.honeypot_field_name = "website".to_string();
  });
  let app = build_router(state);
  let body = serde_json::json!({
    "email": "nobody@myoxus.local",
    "password": "anything",
    "website": "http://spam.example", // honeypot triggered
  });
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(response.status(), 400, "honeypot must reject with 400");
  let body_bytes = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body_bytes).expect("json");
  assert_eq!(
    json["name"], "CAPTCHA_HONEYPOT",
    "error name must be CAPTCHA_HONEYPOT: {json}"
  );
}

/// INV-CAPTCHA-08 (disabled skip): when captcha is disabled and no honeypot
/// trap is triggered, `/api/auth/sign-in` MUST NOT demand a captcha token —
/// the request proceeds to credential validation, which for a non-existent
/// user yields WRONG_SIGN_IN_CREDENTIALS, not CAPTCHA_MISSING_TOKEN.
#[tokio::test]
async fn inv_captcha08_disabled_captcha_skips_verification() {
  let state = state_with(|c| {
    c.captcha.enabled = false;
  });
  let app = build_router(state);
  let body = serde_json::json!({
    "email": "ghost@myoxus.local",
    "password": "wrong",
  });
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("request"),
    )
    .await
    .expect("response");
  let status = response.status();
  let body_bytes = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body_bytes).expect("json");
  assert_ne!(
    json.get("name").and_then(|v| v.as_str()),
    Some("CAPTCHA_MISSING_TOKEN"),
    "disabled captcha must not demand a token, got {status} {json}"
  );
}

/// INV-CAPTCHA-09 (enabled requires token): when captcha is enabled and the
/// request omits `x-captcha-token`, sign-in MUST reject with
/// `CAPTCHA_MISSING_TOKEN` before hitting credential checks.
#[tokio::test]
async fn inv_captcha09_enabled_rejects_missing_token() {
  let state = state_with(|c| {
    c.captcha.enabled = true;
    c.captcha.hmac_key = "k".repeat(32);
    c.captcha.algorithm = "SHA-256".to_string();
  });
  let app = build_router(state);
  let body = serde_json::json!({
    "email": "ghost@myoxus.local",
    "password": "wrong",
  });
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(response.status(), 400, "missing captcha token must reject");
  let body_bytes = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body_bytes).expect("json");
  assert_eq!(
    json["name"], "CAPTCHA_MISSING_TOKEN",
    "error name must be CAPTCHA_MISSING_TOKEN: {json}"
  );
}

/// INV-CAPTCHA-10 (admin status auth): `/api/admin/captcha/status` MUST reject
/// unauthenticated callers (401) so counters and the `hmac_key_configured`
/// boolean are never leaked to anonymous clients.
#[tokio::test]
async fn inv_captcha10_admin_status_requires_admin_auth() {
  let state = state_with(|c| {
    c.captcha.enabled = true;
    c.captcha.hmac_key = "k".repeat(32);
  });
  let app = build_router(state);
  let response = app
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/api/admin/captcha/status")
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(
    response.status(),
    401,
    "admin captcha status must require authentication"
  );
}

/// Build a solved ALTCHA payload string using the given hmac_key and an
/// explicit expiry. Used by the replay / expired / rotation tests below.
fn build_solved_payload(hmac_key: &str, expires: chrono::DateTime<chrono::Utc>) -> String {
  use altcha_lib_rs::{ChallengeOptions, Payload, algorithm::AltchaAlgorithm, create_challenge, solve_challenge};
  let challenge = create_challenge(ChallengeOptions {
    algorithm: Some(AltchaAlgorithm::Sha256),
    max_number: Some(1000),
    hmac_key,
    expires: Some(expires),
    ..Default::default()
  })
  .expect("challenge");
  let number = solve_challenge(
    &challenge.challenge,
    &challenge.salt,
    Some(challenge.algorithm),
    Some(challenge.maxnumber),
    0,
  )
  .expect("solve");
  serde_json::to_string(&Payload {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    number,
    salt: challenge.salt,
    signature: challenge.signature,
    took: None,
  })
  .expect("payload json")
}

/// INV-CAPTCHA-03 (replay): a valid ALTCHA solution MUST be usable at most
/// once. The second sign-in with the same token is rejected with
/// `CAPTCHA_VERIFICATION_FAILED` (reason: `captcha_replay`).
#[tokio::test]
async fn inv_captcha03_signin_rejects_replay() {
  let hmac = "k".repeat(32);
  let state = state_with(|c| {
    c.captcha.enabled = true;
    c.captcha.hmac_key = hmac.clone();
    c.captcha.algorithm = "SHA-256".to_string();
    c.captcha.max_number = 1000;
  });
  let token = build_solved_payload(&hmac, chrono::Utc::now() + chrono::Duration::seconds(60));
  let body = serde_json::json!({
    "email": "ghost@myoxus.local",
    "password": "wrong",
  })
  .to_string();

  let make_req = || {
    Request::builder()
      .method("POST")
      .uri("/api/auth/sign-in")
      .header("content-type", "application/json")
      .header("x-captcha-token", &token)
      .body(Body::from(body.clone()))
      .expect("request")
  };

  let app1 = build_router(state.clone());
  let first = app1.oneshot(make_req()).await.expect("first response");
  let first_bytes = first.into_body().collect().await.expect("body").to_bytes();
  let first_json: Value = serde_json::from_slice(&first_bytes).expect("json");
  let first_name = first_json.get("name").and_then(|v| v.as_str()).unwrap_or("");
  assert!(
    !first_name.starts_with("CAPTCHA_"),
    "first submission must pass captcha (got captcha error {first_name}): {first_json}"
  );

  let app2 = build_router(state);
  let replay = app2.oneshot(make_req()).await.expect("replay response");
  let replay_bytes = replay.into_body().collect().await.expect("body").to_bytes();
  let replay_json: Value = serde_json::from_slice(&replay_bytes).expect("json");
  assert_eq!(
    replay_json["name"], "CAPTCHA_REPLAY",
    "replay must be rejected with CAPTCHA_REPLAY: {replay_json}"
  );
}

/// INV-CAPTCHA-12 (widget payload): the official ALTCHA browser widget emits
/// base64-encoded JSON. The HTTP auth path MUST accept that representation,
/// not only the raw JSON shape used by low-level Rust tests.
#[tokio::test]
async fn inv_captcha12_signin_accepts_widget_base64_payload() {
  let hmac = "k".repeat(32);
  let state = state_with(|c| {
    c.captcha.enabled = true;
    c.captcha.hmac_key = hmac.clone();
    c.captcha.algorithm = "SHA-256".to_string();
    c.captcha.max_number = 1000;
  });
  let raw_token = build_solved_payload(&hmac, chrono::Utc::now() + chrono::Duration::seconds(60));
  let widget_token = general_purpose::STANDARD.encode(raw_token.as_bytes());
  let app = build_router(state);
  let body = serde_json::json!({
    "email": "ghost@myoxus.local",
    "password": "wrong",
  });
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .header("x-captcha-token", &widget_token)
        .body(Body::from(body.to_string()))
        .expect("request"),
    )
    .await
    .expect("response");
  let body_bytes = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body_bytes).expect("json");
  let name = json.get("name").and_then(|v| v.as_str()).unwrap_or("");
  assert!(
    !name.starts_with("CAPTCHA_"),
    "widget base64 token must pass captcha before credential validation: {json}"
  );
}

/// INV-CAPTCHA-04 (expired): a token whose challenge.expires is in the past
/// MUST be rejected even if the signature is valid.
#[tokio::test]
async fn inv_captcha04_signin_rejects_expired_token() {
  let hmac = "k".repeat(32);
  let state = state_with(|c| {
    c.captcha.enabled = true;
    c.captcha.hmac_key = hmac.clone();
    c.captcha.algorithm = "SHA-256".to_string();
    c.captcha.max_number = 1000;
  });
  let token = build_solved_payload(&hmac, chrono::Utc::now() - chrono::Duration::seconds(120));
  let app = build_router(state);
  let body = serde_json::json!({
    "email": "ghost@myoxus.local",
    "password": "wrong",
  });
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .header("x-captcha-token", &token)
        .body(Body::from(body.to_string()))
        .expect("request"),
    )
    .await
    .expect("response");
  let body_bytes = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body_bytes).expect("json");
  assert_eq!(
    json["name"], "CAPTCHA_EXPIRED",
    "expired token must reject with CAPTCHA_EXPIRED: {json}"
  );
}

/// INV-CAPTCHA-11 (hmac rotation): a token signed with key A MUST fail
/// verification after the server rotates to key B. This is the operator
/// safety net — rotating the hmac key instantly invalidates every in-flight
/// challenge without requiring a restart of the widget.
#[tokio::test]
async fn inv_captcha11_hmac_key_rotation_invalidates_pending_challenges() {
  let token = build_solved_payload(&"a".repeat(32), chrono::Utc::now() + chrono::Duration::seconds(60));
  let state_after_rotation = state_with(|c| {
    c.captcha.enabled = true;
    c.captcha.hmac_key = "b".repeat(32); // rotated
    c.captcha.algorithm = "SHA-256".to_string();
    c.captcha.max_number = 1000;
  });
  let app = build_router(state_after_rotation);
  let body = serde_json::json!({
    "email": "ghost@myoxus.local",
    "password": "wrong",
  });
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .header("x-captcha-token", &token)
        .body(Body::from(body.to_string()))
        .expect("request"),
    )
    .await
    .expect("response");
  let body_bytes = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body_bytes).expect("json");
  assert_eq!(
    json["name"], "CAPTCHA_INVALID_SIGNATURE",
    "post-rotation token must be rejected with CAPTCHA_INVALID_SIGNATURE: {json}"
  );
}

#[tokio::test]
async fn inv_captcha04_challenge_endpoint_returns_altcha_shape_when_enabled() {
  let state = state_with(|c| {
    c.captcha.enabled = true;
    c.captcha.hmac_key = "k".repeat(32);
    c.captcha.algorithm = "SHA-256".to_string();
    c.captcha.max_number = 1000;
  });
  let app = build_router(state);
  let response = app
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/api/auth/challenge")
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(response.status(), 200, "enabled captcha must return 200");
  let body = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("json");
  for field in ["algorithm", "challenge", "salt", "signature", "maxnumber"] {
    assert!(json.get(field).is_some(), "challenge body missing `{field}`: {json}");
  }
  assert_eq!(json["algorithm"], "SHA-256");
}
