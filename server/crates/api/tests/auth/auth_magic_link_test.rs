// SPDX-License-Identifier: AGPL-3.0-or-later
//! Magic-link and open-app sign-in integration tests.

use crate::auth_test_helpers;

use auth_test_helpers::setup_test_app;

use axum::{
  body::Body,
  http::{self, Request, StatusCode},
};
use http_body_util::BodyExt;
use myoxus_application::auth::{AuthStore, AuthUser};
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn preflight_reports_registered_flag() {
  let (app, store, _) = setup_test_app().await;

  // 1. Not registered
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/preflight")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "email": "new@example.com" }).to_string()))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");

  assert_eq!(response.status(), StatusCode::OK);
  let body = response
    .into_body()
    .collect()
    .await
    .expect("body collection should succeed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("response should be valid JSON");
  assert_eq!(json["registered"], false);

  // 2. Registered
  store.insert_user(AuthUser {
    id: uuid::Uuid::new_v4(),
    email: "old@example.com".to_string(),
    name: None,
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: None,
    registered: true,
  });

  let response = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/preflight")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "email": "old@example.com" }).to_string()))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");

  assert_eq!(response.status(), StatusCode::OK);
  let body = response
    .into_body()
    .collect()
    .await
    .expect("body collection should succeed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("response should be valid JSON");
  assert_eq!(json["registered"], true);
}

#[tokio::test]
async fn test_magic_link_flow() {
  let (app, _store, mailer) = setup_test_app().await;
  let email = "magic@example.com";

  // 1. Request magic link
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "email": email }).to_string()))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");

  assert_eq!(response.status(), StatusCode::OK);

  // 2. Check if mail was "sent" and extract OTP
  let otp = {
    let sent_mails = mailer.sent_mails.lock().expect("mailer lock should not be poisoned");
    assert_eq!(sent_mails.len(), 1);
    assert_eq!(sent_mails[0].to, email);

    let body = &sent_mails[0].body;
    if body.contains("class=\"otp\">") {
      let start = body
        .find(r#"class="otp">"#)
        .expect("otp class div should exist in template")
        + 12;
      let end = body[start..]
        .find("</div>")
        .expect("closing div should follow otp content")
        + start;
      body[start..end].to_string()
    } else {
      // Fallback: extract from link
      let start = body.find("token=").expect("token= should appear in magic link") + 6;
      let end = body[start..].find("&").expect("& delimiter should follow token value") + start;
      body[start..end].to_string()
    }
  };

  // 3. Callback with OTP
  let response = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/magic-link")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({
              "email": email,
              "token": otp,
              "client_nonce": null
          })
          .to_string(),
        ))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");

  assert_eq!(response.status(), StatusCode::OK);
  let body = response
    .into_body()
    .collect()
    .await
    .expect("body collection should succeed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("response should be valid JSON");
  assert!(json["id"].is_string());
}

#[tokio::test]
async fn test_open_app_sign_in_flow() {
  let (app, store, _) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: "open@example.com".to_string(),
    name: None,
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: None,
    registered: true,
  });

  let session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id,
      csrf_token: "csrf123".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("session creation should succeed");

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/open-app/sign-in-code")
        .header(http::header::COOKIE, format!("affine_session={}", session.id))
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");

  assert_eq!(response.status(), StatusCode::OK);
  let body = response
    .into_body()
    .collect()
    .await
    .expect("body collection should succeed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("response should be valid JSON");
  let code = json["code"].as_str().expect("code field should be a string");

  let response = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/open-app/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "code": code }).to_string()))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");

  assert_eq!(response.status(), StatusCode::OK);
  let body = response
    .into_body()
    .collect()
    .await
    .expect("body collection should succeed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("response should be valid JSON");
  assert_eq!(json["id"], user_id.to_string());
}
