// SPDX-License-Identifier: AGPL-3.0-or-later
//! Password sign-in error paths, CSRF regression, password-reset security,
//! challenge endpoint, and avatar endpoint tests.

use crate::auth_test_helpers;

use auth_test_helpers::{make_session, setup_test_app, setup_test_app_with_config};

use std::fs;

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

fn test_user(id: uuid::Uuid, email: &str, pw_hash: Option<String>, disabled: bool) -> AuthUser {
  AuthUser {
    id,
    email: email.to_string(),
    name: None,
    avatar_url: None,
    password_hash: pw_hash,
    is_admin: false,
    disabled,
    email_verified_at: None,
    registered: true,
  }
}

#[tokio::test]
async fn sign_in_wrong_password_returns_bad_request() {
  let (app, store, _) = setup_test_app().await;
  store.insert_user(test_user(
    uuid::Uuid::new_v4(),
    "wrongpw@example.com",
    Some(hash_password_for_testing("correct-password").expect("hash should succeed")),
    false,
  ));

  let resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({"email": "wrongpw@example.com", "password": "wrong"}).to_string(),
        ))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
  assert_eq!(body_json(resp).await["name"], "WRONG_SIGN_IN_CREDENTIALS");
}

#[tokio::test]
async fn sign_in_nonexistent_email_returns_bad_request() {
  let (app, _, _) = setup_test_app().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({"email": "nobody@example.com", "password": "any"}).to_string(),
        ))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
  assert_eq!(body_json(resp).await["name"], "WRONG_SIGN_IN_CREDENTIALS");
}

#[tokio::test]
async fn disabled_user_cannot_sign_in() {
  let (app, store, _) = setup_test_app().await;
  store.insert_user(test_user(
    uuid::Uuid::new_v4(),
    "disabled@example.com",
    Some(hash_password_for_testing("password123").expect("hash should succeed")),
    true,
  ));
  let resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({"email": "disabled@example.com", "password": "password123"}).to_string(),
        ))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
  assert_eq!(body_json(resp).await["name"], "WRONG_SIGN_IN_CREDENTIALS");
}

#[tokio::test]
async fn sign_out_clears_session_cookies() {
  let (app, store, _) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(test_user(
    user_id,
    "signout@example.com",
    Some(hash_password_for_testing("password").expect("hash should succeed")),
    false,
  ));

  let sign_in = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({"email": "signout@example.com", "password": "password"}).to_string(),
        ))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(sign_in.status(), StatusCode::OK);

  let set_cookies: Vec<String> = sign_in
    .headers()
    .get_all(http::header::SET_COOKIE)
    .iter()
    .filter_map(|v| v.to_str().ok().map(str::to_string))
    .collect();
  let cookie_header = set_cookies
    .iter()
    .filter_map(|c| c.split(';').next().map(str::to_string))
    .collect::<Vec<_>>()
    .join("; ");
  let csrf_token = set_cookies
    .iter()
    .find(|c| c.starts_with("myoxus_csrf_token="))
    .and_then(|c| c.split(';').next())
    .and_then(|c| c.strip_prefix("myoxus_csrf_token="))
    .expect("myoxus_csrf_token should be set on sign-in")
    .to_string();

  let sign_out = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-out")
        .header(http::header::COOKIE, &cookie_header)
        .header("x-myoxus-csrf-token", &csrf_token)
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(sign_out.status(), StatusCode::OK);
  let cleared: Vec<String> = sign_out
    .headers()
    .get_all(http::header::SET_COOKIE)
    .iter()
    .filter_map(|v| v.to_str().ok().map(str::to_string))
    .collect();
  for name in ["myoxus_csrf_token", "affine_csrf_token"] {
    assert!(
      cleared
        .iter()
        .any(|cookie| cookie.starts_with(&format!("{name}=;")) && cookie.contains("Max-Age=0"))
    );
  }
  assert!(
    cleared
      .iter()
      .any(|c| c.contains("affine_session=;") && c.contains("Max-Age=0"))
  );
  assert!(
    cleared
      .iter()
      .any(|c| c.contains("affine_sid=;") && c.contains("Max-Age=0")),
    "legacy affine_sid compatibility cookie should be cleared on sign-out"
  );

  let session_resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri("/api/auth/session")
        .header(http::header::COOKIE, &cookie_header)
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(session_resp.status(), StatusCode::OK);
  assert!(
    body_json(session_resp).await["user"].is_null(),
    "user should be null after sign-out"
  );
}

#[tokio::test]
async fn legacy_affine_sid_cookie_is_set_and_accepted() {
  let (app, store, _) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(test_user(
    user_id,
    "legacy-sid@example.com",
    Some(hash_password_for_testing("password").expect("hash should succeed")),
    false,
  ));

  let sign_in = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({"email": "legacy-sid@example.com", "password": "password"}).to_string(),
        ))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(sign_in.status(), StatusCode::OK);

  let set_cookies: Vec<String> = sign_in
    .headers()
    .get_all(http::header::SET_COOKIE)
    .iter()
    .filter_map(|v| v.to_str().ok().map(str::to_string))
    .collect();
  let legacy_sid = set_cookies
    .iter()
    .find(|c| c.starts_with("affine_sid="))
    .and_then(|c| c.split(';').next())
    .expect("legacy affine_sid should be set on sign-in")
    .to_string();
  let csrf_cookie = set_cookies
    .iter()
    .find(|c| c.starts_with("myoxus_csrf_token="))
    .and_then(|c| c.split(';').next())
    .expect("myoxus_csrf_token should be set on sign-in")
    .to_string();
  let csrf_token = csrf_cookie
    .strip_prefix("myoxus_csrf_token=")
    .expect("csrf cookie has expected name")
    .to_string();
  let cookie_header = format!("{legacy_sid}; {csrf_cookie}");

  let session_resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri("/api/auth/session")
        .header(http::header::COOKIE, &cookie_header)
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(session_resp.status(), StatusCode::OK);
  assert_eq!(
    body_json(session_resp).await["user"]["email"],
    "legacy-sid@example.com",
    "legacy affine_sid cookie should authenticate existing clients"
  );

  let sign_out = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-out")
        .header(http::header::COOKIE, &cookie_header)
        .header("x-myoxus-csrf-token", csrf_token)
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(sign_out.status(), StatusCode::OK);
}

#[tokio::test]
async fn sign_in_with_invalid_email_format_returns_bad_request() {
  let (app, _, _) = setup_test_app().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({"email": "not-an-email", "password": "test"}).to_string(),
        ))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
  assert_eq!(body_json(resp).await["name"], "INVALID_EMAIL");
}

// ─── CSRF protection regression tests (SC-H-06) ─────────────────────────

/// SC-H-06: sign-out WITHOUT x-myoxus-csrf-token header must return 403.
#[tokio::test]
async fn csrf_sign_out_without_header_returns_403() {
  let (app, store, _) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(test_user(user_id, "csrf-no-header@example.com", None, false));
  let session = store
    .create_session(make_session(user_id, "csrf-valid-token"))
    .await
    .expect("session creation should succeed");

  let resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-out")
        .header(
          http::header::COOKIE,
          format!("affine_session={}; myoxus_csrf_token=csrf-valid-token", session.id),
        )
        // The retired header cannot substitute for the missing Myoxus header.
        .header("x-affine-csrf-token", "csrf-valid-token")
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(
    resp.status(),
    StatusCode::FORBIDDEN,
    "sign-out without CSRF header must be 403"
  );
}

/// SC-H-06: sign-out WITH correct CSRF token must succeed.
#[tokio::test]
async fn csrf_sign_out_with_correct_token_succeeds() {
  let (app, store, _) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(test_user(user_id, "csrf-correct@example.com", None, false));
  let session = store
    .create_session(make_session(user_id, "csrf-matching-token"))
    .await
    .expect("session creation should succeed");

  let retired_only = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-out")
        .header(
          http::header::COOKIE,
          format!("affine_session={}; affine_csrf_token=csrf-matching-token", session.id),
        )
        .header("x-myoxus-csrf-token", "csrf-matching-token")
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(
    retired_only.status(),
    StatusCode::FORBIDDEN,
    "the retired CSRF cookie must not be accepted as an alias"
  );

  let resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-out")
        .header(
          http::header::COOKIE,
          format!("affine_session={}; myoxus_csrf_token=csrf-matching-token", session.id),
        )
        .header("x-myoxus-csrf-token", "csrf-matching-token")
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(
    resp.status(),
    StatusCode::OK,
    "sign-out with correct CSRF token must succeed"
  );
}

// ─── Password reset email target regression test (SC-C-02) ──────────────

/// SC-C-02: sendChangePasswordEmail uses the common local-callback contract and
/// sends only to the authenticated user's email, never caller-supplied email.
#[tokio::test]
async fn password_reset_email_sent_to_authenticated_user_not_attacker() {
  // Use a fixed origin so the callbackUrl validation passes regardless of local.yaml.
  let mut config = myoxus_api::config::AppConfig::load().expect("AppConfig::load");
  config.server.origin = "http://localhost:3001".to_string();
  config.i18n.default_locale = "de".into();
  config.mail.enable_notification_emails = false;
  let (app, store, mailer) = setup_test_app_with_config(config).await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: "victim@example.com".to_string(),
    name: Some("Victim".to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  // Account mail uses the recipient locale despite disabled optional categories.
  store
    .patch_user_preferences(
      user_id,
      myoxus_application::auth::UserPreferencesPatch {
        locale: Some(Some("fr".into())),
        timezone: Some(Some("America/New_York".into())),
        date_format: Some(Some("year-month-day".into())),
        time_format: Some(Some("12-hour".into())),
        receive_invitation_email: Some(Some(false)),
        receive_mention_email: Some(Some(false)),
        receive_comment_email: Some(Some(false)),
        ..Default::default()
      },
    )
    .await
    .expect("recipient presentation and opt-outs");
  let session = store
    .create_session(make_session(user_id, "csrf-pwreset"))
    .await
    .expect("session creation should succeed");

  let query = json!({
    "query": "mutation($callbackUrl: String, $email: String) { sendChangePasswordEmail(callbackUrl: $callbackUrl, email: $email) }",
    "variables": {"callbackUrl": "/reset-password?returnTo=%2Fsettings", "email": "attacker@evil.com"}
  });
  let resp = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(query.to_string()))
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(resp.status(), StatusCode::OK);
  let json = body_json(resp).await;
  assert!(
    json.get("errors").is_none(),
    "sendChangePasswordEmail should succeed: {json}"
  );
  assert_eq!(json["data"]["sendChangePasswordEmail"], true);

  let sent = mailer.sent_mails.lock().expect("mailer lock should not be poisoned");
  let reset_mail = sent
    .iter()
    .find(|m| m.subject.contains("Réinitialisez votre mot de passe"))
    .expect("a password reset email must have been sent");
  assert_eq!(
    reset_mail.to, "victim@example.com",
    "password reset email must go to authenticated user, not attacker"
  );
  assert_ne!(reset_mail.to, "attacker@evil.com", "must NEVER send to attacker email");
  assert!(
    reset_mail
      .body
      .contains("href=\"http:&#x2F;&#x2F;localhost:3001&#x2F;reset-password?"),
    "mail must link to the server-origin reset route using an escaped HTML attribute"
  );
  assert!(!reset_mail.body.contains("attacker@evil.com"));
}

#[tokio::test]
async fn password_reset_email_rejects_external_callback_without_sending_mail() {
  let mut config = myoxus_api::config::AppConfig::load().expect("AppConfig::load");
  config.server.origin = "https://workspace.example.test/base".to_string();
  let (app, store, mailer) = setup_test_app_with_config(config).await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: "callback-victim@example.com".to_string(),
    name: None,
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  let session = store
    .create_session(make_session(user_id, "csrf-callback-abuse"))
    .await
    .expect("session creation should succeed");

  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(
          json!({
            "query": "mutation($callbackUrl:String){sendChangePasswordEmail(callbackUrl:$callbackUrl)}",
            "variables": {"callbackUrl": "https://attacker.example/reset"}
          })
          .to_string(),
        ))
        .expect("request"),
    )
    .await
    .expect("response");
  let response = body_json(response).await;
  assert!(
    response.get("errors").is_some(),
    "external callback must be rejected: {response}"
  );
  assert!(
    mailer.sent_mails.lock().expect("mailer lock").is_empty(),
    "invalid callback must not send a mail"
  );
}

// P-Captcha-B: the legacy pre-ALTCHA challenge shape (`challenge` + `resource`
// as UUIDs) was replaced by the ALTCHA challenge object. Equivalent coverage
// now lives in `captcha_endpoint_test.rs` (INV-CAPTCHA-04 / 05).

#[tokio::test]
async fn avatar_endpoint_serves_blob_data() {
  let (app, _, _) = setup_test_app().await;
  let avatar_id = uuid::Uuid::new_v4().to_string();
  let avatar_dir = "./test-storage/avatars";
  let avatar_path = format!("{avatar_dir}/{avatar_id}");
  let payload = b"avatar-bytes";

  fs::create_dir_all(avatar_dir).expect("avatar_dir creation should succeed");
  fs::write(&avatar_path, payload).expect("avatar file write should succeed");

  let resp = app
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri(format!("/api/avatars/{avatar_id}"))
        .body(Body::empty())
        .expect("request builder should succeed"),
    )
    .await
    .expect("HTTP request should succeed");
  assert_eq!(resp.status(), StatusCode::OK);
  let bytes = resp
    .into_body()
    .collect()
    .await
    .expect("body collection should succeed")
    .to_bytes();
  assert_eq!(bytes.as_ref(), payload);

  let _ = fs::remove_file(avatar_path);
}

#[tokio::test]
async fn graphql_email_change_commits_account_token_and_session_revocation() {
  let (app, store, _) = setup_test_app().await;
  let id = uuid::Uuid::new_v4();
  let mut user = test_user(id, "email-before@example.test", None, false);
  user.email_verified_at = Some(chrono::Utc::now());
  store.insert_user(user);
  let session = store
    .create_session(make_session(id, &uuid::Uuid::new_v4().to_string()))
    .await
    .expect("session");
  let token = "graphql-email-change-proof";
  store
    .create_verification_token(
      Some(id),
      "VerifyEmail",
      token,
      None,
      chrono::Utc::now() + chrono::Duration::hours(1),
      None,
    )
    .await
    .expect("token");
  let response = crate::helpers::gql(
    &app,
    session.id,
    json!({
      "query":"mutation($token:String!,$email:String!){changeEmail(token:$token,email:$email){id email}}",
      "variables":{"token":token,"email":"email-after%40example.test"}
    }),
  )
  .await;
  assert!(response["errors"].is_null(), "GraphQL email change must succeed");
  assert_eq!(response["data"]["changeEmail"]["id"], id.to_string());
  assert_eq!(response["data"]["changeEmail"]["email"], "email-after@example.test");
  let persisted = store.get_user_by_id(id).await.expect("account").expect("exists");
  assert_eq!(persisted.email, "email-after@example.test");
  assert!(persisted.email_verified_at.is_some());
  assert!(
    store
      .get_verification_token(token)
      .await
      .expect("token")
      .expect("exists")
      .used_at
      .is_some()
  );
  assert!(
    store
      .get_session(session.id)
      .await
      .expect("session")
      .expect("exists")
      .revoked_at
      .is_some()
  );
  let denied = crate::helpers::gql(&app, session.id, json!({"query":"query {currentUser {id}}"})).await;
  assert!(denied["errors"].is_null(), "authenticated query schema remains valid");
  assert!(
    denied["data"]["currentUser"].is_null(),
    "old session cannot authenticate"
  );
}
