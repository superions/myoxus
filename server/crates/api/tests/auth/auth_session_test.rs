// SPDX-License-Identifier: AGPL-3.0-or-later
//! Session management integration tests (sign-in, refresh, sign-out, multi-account).

use crate::auth_test_helpers;

use auth_test_helpers::{make_session, setup_test_app};

use axum::{
  body::Body,
  http::{self, Request, Response, StatusCode},
};
use http_body_util::BodyExt;
use myoxus_application::auth::{AuthStore, AuthUser, hash_password_for_testing};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn body_json(resp: Response<axum::body::Body>) -> Value {
  let bytes = resp
    .into_body()
    .collect()
    .await
    .expect("body collection should succeed")
    .to_bytes();
  serde_json::from_slice(&bytes).expect("response should be valid JSON")
}

fn test_user(id: uuid::Uuid, email: &str, pw_hash: Option<String>) -> AuthUser {
  AuthUser {
    id,
    email: email.to_string(),
    name: None,
    avatar_url: None,
    password_hash: pw_hash,
    is_admin: false,
    disabled: false,
    email_verified_at: None,
    registered: true,
  }
}

#[tokio::test]
async fn password_sign_in_sets_session_and_session_endpoint_reads_it() {
  let (app, store, _) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  let password = "test-password";
  let hash = hash_password_for_testing(password).expect("password hash should succeed");
  store.insert_user(test_user(user_id, "test@example.com", Some(hash)));

  let sign_in = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({"email": "test@example.com", "password": password}).to_string(),
        ))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(sign_in.status(), StatusCode::OK);

  let session_cookie = sign_in
    .headers()
    .get_all(http::header::SET_COOKIE)
    .iter()
    .find(|c| {
      c.to_str()
        .expect("cookie should be valid UTF-8")
        .starts_with("affine_session=")
    })
    .expect("affine_session cookie should be set")
    .clone();

  let resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri("/api/auth/session")
        .header(http::header::COOKIE, session_cookie)
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(resp.status(), StatusCode::OK);
  assert_eq!(body_json(resp).await["user"]["id"], user_id.to_string());
}

#[tokio::test]
async fn test_session_refresh() {
  let (app, store, _) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(test_user(user_id, "refresh@example.com", None));

  let mut s = make_session(user_id, "csrf123");
  s.refresh_after = chrono::Utc::now() - chrono::Duration::minutes(1);
  s.created_at = chrono::Utc::now() - chrono::Duration::hours(1);
  let session = store.create_session(s).await.expect("session creation should succeed");

  let resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri("/api/auth/session")
        .header(
          http::header::COOKIE,
          format!("affine_session={}; affine_csrf_token=csrf123", session.id),
        )
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(resp.status(), StatusCode::OK);
  assert!(resp.headers().get_all(http::header::SET_COOKIE).iter().any(|c| {
    c.to_str()
      .expect("cookie should be valid UTF-8")
      .starts_with("affine_session=")
  }));
  let cookies: Vec<_> = resp
    .headers()
    .get_all(http::header::SET_COOKIE)
    .iter()
    .map(|c| c.to_str().expect("valid cookie header"))
    .collect();
  assert!(
    cookies
      .iter()
      .any(|c| c.starts_with("myoxus_csrf_token=csrf123;") && c.contains("SameSite=Lax") && !c.contains("HttpOnly"))
  );
  assert!(
    cookies
      .iter()
      .any(|c| c.starts_with("affine_csrf_token=;") && c.contains("Max-Age=0"))
  );
}

#[tokio::test]
async fn sign_out_rejects_mismatched_csrf() {
  let (app, store, _) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(test_user(user_id, "test@example.com", None));
  let session = store
    .create_session(make_session(user_id, "correct-token"))
    .await
    .expect("session creation should succeed");

  let resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-out")
        .header(
          http::header::COOKIE,
          format!("affine_session={}; myoxus_csrf_token=correct-token", session.id),
        )
        .header("x-myoxus-csrf-token", "wrong-token")
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn sign_out_with_foreign_user_id_keeps_current_session() {
  let (app, store, _) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  let foreign_user_id = uuid::Uuid::new_v4();
  store.insert_user(test_user(user_id, "session-user@example.com", None));
  let session = store
    .create_session(make_session(user_id, "csrf-keep-session"))
    .await
    .expect("session creation should succeed");

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri(format!("/api/auth/sign-out?user_id={foreign_user_id}"))
        .header(
          http::header::COOKIE,
          format!("affine_session={}; myoxus_csrf_token=csrf-keep-session", session.id),
        )
        .header("x-myoxus-csrf-token", "csrf-keep-session")
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(resp.status(), StatusCode::OK);

  let still_valid = app
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri("/api/auth/session")
        .header(http::header::COOKIE, format!("affine_session={}", session.id))
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(still_valid.status(), StatusCode::OK);
  assert_eq!(body_json(still_valid).await["user"]["id"], user_id.to_string());
}

#[tokio::test]
async fn session_endpoints_support_multi_account_switch_with_shared_cookie_context() {
  let (app, store, _) = setup_test_app().await;
  let user1_id = uuid::Uuid::new_v4();
  let user2_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user1_id,
    email: "multi-u1@example.com".to_string(),
    name: Some("U1".to_string()),
    avatar_url: None,
    password_hash: Some(hash_password_for_testing("u1-password").expect("hash")),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  store.insert_user(AuthUser {
    id: user2_id,
    email: "multi-u2@example.com".to_string(),
    name: Some("U2".to_string()),
    avatar_url: None,
    password_hash: Some(hash_password_for_testing("u2-password").expect("hash")),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });

  let extract_cookies = |resp: &Response<axum::body::Body>| -> String {
    resp
      .headers()
      .get_all(http::header::SET_COOKIE)
      .iter()
      .filter_map(|v| v.to_str().ok())
      .filter_map(|c| c.split(';').next())
      .collect::<Vec<_>>()
      .join("; ")
  };

  let sign_in1 = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({"email": "multi-u1@example.com", "password": "u1-password"}).to_string(),
        ))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(sign_in1.status(), StatusCode::OK);
  let first_cookies = extract_cookies(&sign_in1);

  let sign_in2 = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .header(http::header::COOKIE, first_cookies.clone())
        .body(Body::from(
          json!({"email": "multi-u2@example.com", "password": "u2-password"}).to_string(),
        ))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(sign_in2.status(), StatusCode::OK);
  let second_cookies = extract_cookies(&sign_in2);

  let sessions_resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri("/api/auth/sessions")
        .header(http::header::COOKIE, second_cookies)
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(sessions_resp.status(), StatusCode::OK);
  let sessions_json = body_json(sessions_resp).await;
  let users = sessions_json["users"].as_array().expect("users array");
  assert_eq!(users.len(), 2);
  assert_eq!(users[0]["id"], user1_id.to_string());
  assert_eq!(users[1]["id"], user2_id.to_string());

  let session_resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri("/api/auth/session")
        .header(http::header::COOKIE, first_cookies)
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(session_resp.status(), StatusCode::OK);
  assert_eq!(body_json(session_resp).await["user"]["id"], user1_id.to_string());
}

#[tokio::test]
async fn session_without_cookie_returns_null_user() {
  let (app, _, _) = setup_test_app().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri("/api/auth/session")
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(resp.status(), StatusCode::OK);
  assert!(
    body_json(resp).await["user"].is_null(),
    "user should be null without session cookie"
  );
}

#[tokio::test]
async fn session_with_expired_session_returns_null_user() {
  let (app, store, _) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(test_user(user_id, "expired@example.com", None));

  let mut s = make_session(user_id, "csrf-expired");
  s.expires_at = chrono::Utc::now() - chrono::Duration::hours(1);
  s.refresh_after = chrono::Utc::now() - chrono::Duration::hours(2);
  s.created_at = chrono::Utc::now() - chrono::Duration::hours(3);
  let session = store.create_session(s).await.expect("session creation should succeed");

  let resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri("/api/auth/session")
        .header(http::header::COOKIE, format!("affine_session={}", session.id))
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(resp.status(), StatusCode::OK);
  assert!(
    body_json(resp).await["user"].is_null(),
    "user should be null for expired session"
  );
}
