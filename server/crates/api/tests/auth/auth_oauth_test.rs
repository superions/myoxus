// SPDX-License-Identifier: AGPL-3.0-or-later
//! OAuth preflight, session/user alias, and calendar OAuth integration tests.

use crate::auth_test_helpers;

use auth_test_helpers::{setup_test_app, setup_test_app_with_config};

use axum::{
  body::Body,
  http::{self, Request, StatusCode},
};
use http_body_util::BodyExt;
use myoxus_api::config::{AppConfig, OAuthCustomProviderConfig};
use myoxus_application::auth::{AuthStore, AuthUser, hash_password_for_testing};
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn oauth_preflight_supports_github_when_configured() {
  let mut config = AppConfig::load().expect("AppConfig::load should succeed");
  config.oauth.github_client_id = Some("test-github-id".to_string());
  config.oauth.github_client_secret = Some("test-github-secret".to_string());

  let (app, _, _) = setup_test_app_with_config(config).await;

  let response = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/oauth/preflight")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({
            "provider": "github",
            "client_nonce": "nonce-123",
            "client": "web"
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
  let url = json["url"].as_str().expect("url field should be a string");
  assert!(url.contains("github.com/login/oauth/authorize"));
}

#[tokio::test]
async fn oauth_preflight_supports_configured_oidc_provider() {
  let mut config = AppConfig::load().expect("AppConfig::load should succeed");
  config.oauth.providers.insert(
    "oidc".to_string(),
    OAuthCustomProviderConfig {
      client_id: "oidc-client".to_string(),
      client_secret: "oidc-secret".to_string(),
      issuer_url: None,
      discovery_url: None,
      auth_url: "https://auth.example.com/application/o/authorize/".to_string(),
      token_url: "https://auth.example.com/application/o/token/".to_string(),
      userinfo_url: "https://auth.example.com/application/o/userinfo/".to_string(),
      jwks_url: None,
      scopes: vec!["openid".to_string(), "profile".to_string(), "email".to_string()],
      claims: Default::default(),
      group_mapping: Default::default(),
      group_directory: None,
      user_id_field: "sub".to_string(),
      user_email_field: "email".to_string(),
      user_name_field: "name".to_string(),
      user_avatar_field: "picture".to_string(),
    },
  );

  let (app, _, _) = setup_test_app_with_config(config).await;
  let response = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/oauth/preflight")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({
            "provider": "OIDC",
            "client_nonce": "nonce-oidc",
            "client": "web"
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
  let url = json["url"].as_str().expect("url field should be a string");
  assert!(url.starts_with("https://auth.example.com/application/o/authorize/"));
  assert!(url.contains("scope=openid+profile+email") || url.contains("scope=openid%20profile%20email"));
  let redirect_uri = url
    .split_once('?')
    .and_then(|(_, query)| {
      query.split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == "redirect_uri").then(|| {
          urlencoding::decode(value)
            .expect("redirect_uri must decode")
            .to_string()
        })
      })
    })
    .expect("OIDC authorize URL must contain redirect_uri");
  assert!(
    redirect_uri.ends_with("/api/oauth/callback"),
    "OIDC providers such as Authentik require the authorize redirect_uri to match the registered callback: {redirect_uri}"
  );
}

#[tokio::test]
async fn session_alias_matches_auth_session_contract() {
  let (app, store, _) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: "session-alias@example.com".to_string(),
    name: Some("Session Alias".to_string()),
    avatar_url: None,
    password_hash: Some(hash_password_for_testing("password123").expect("test password hash")),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  let session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id,
      csrf_token: "csrf-session-alias".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("session creation should succeed");

  let response = app
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri("/session")
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
  assert_eq!(json["user"]["id"], user_id.to_string());
}

#[tokio::test]
async fn user_alias_returns_session_user_payload() {
  let (app, store, _) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: "user-alias@example.com".to_string(),
    name: Some("User Alias".to_string()),
    avatar_url: None,
    password_hash: Some(hash_password_for_testing("password123").expect("test password hash")),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  let session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id,
      csrf_token: "csrf-user-alias".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("session creation should succeed");

  let response = app
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri("/user")
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
  assert_eq!(json["id"], user_id.to_string());
  assert_eq!(json["email"], "user-alias@example.com");
}

#[tokio::test]
async fn calendar_oauth_preflight_alias_matches_oauth_preflight() {
  let mut config = AppConfig::load().expect("AppConfig::load should succeed");
  config.oauth.github_client_id = Some("test-github-id".to_string());
  config.oauth.github_client_secret = Some("test-github-secret".to_string());
  let (app, _, _) = setup_test_app_with_config(config).await;

  let response = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/calendar/oauth/preflight")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({
            "provider": "github",
            "client_nonce": "nonce-calendar",
            "client": "web"
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
  let url = json["url"].as_str().expect("url field should be a string");
  assert!(url.contains("github.com/login/oauth/authorize"));
}

#[tokio::test]
async fn calendar_oauth_callback_get_alias_is_wired() {
  let (app, _, _) = setup_test_app().await;
  let response = app
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri("/api/calendar/oauth/callback?code=test-code&state=missing-state&client_nonce=test-nonce")
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(response.status(), StatusCode::BAD_REQUEST);
  let body = response
    .into_body()
    .collect()
    .await
    .expect("body collection should succeed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("response should be valid JSON");
  assert_eq!(json["name"], "OAUTH_STATE_EXPIRED");
}
