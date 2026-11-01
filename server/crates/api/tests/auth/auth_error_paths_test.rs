//! Negative-path tests for critical auth endpoints (P22-D-01).
//!
//! Verifies that error conditions are handled correctly:
//! - Sign-in with wrong password
//! - Sign-in with non-existent email
//! - GraphQL query with expired/invalid session
//! - Admin endpoint with non-admin user

use crate::helpers;

use axum::body::Body;
use axum::http::Request;
use serde_json::{Value, json};
use tower::ServiceExt;

/// Sign in via REST with wrong password must return 401/403.
#[tokio::test]
async fn auth_wrong_password_rejected() {
  let (app, pool, _auth_store) = helpers::setup_app().await;

  // Create a user with a known password
  let user_id = helpers::create_user(&pool, "wrong-pw", false).await;
  // Set a password hash (bcrypt of "correct-password")
  let hash = "$2b$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; // invalid hash
  sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
    .bind(hash)
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();

  let email = format!("wrong-pw_{user_id}@example.test");
  let res = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .body(Body::from(
          json!({"email": email, "password": "wrong-password"}).to_string(),
        ))
        .expect("request body must be constructible"),
    )
    .await
    .expect("sign-in request must not fail at transport level");

  let status = res.status().as_u16();
  assert!(
    status == 401 || status == 403 || status == 400,
    "wrong password must be rejected, got {status}"
  );

  // Cleanup
  sqlx::query("DELETE FROM sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE owner_user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

/// GraphQL query with invalid session cookie must return error.
#[tokio::test]
async fn auth_invalid_session_rejected() {
  let (app, _pool, _auth_store) = helpers::setup_app().await;

  let fake_session = uuid::Uuid::new_v4();
  let resp = helpers::gql(&app, fake_session, json!({"query": "{ currentUser { id } }"})).await;

  // Either returns null data or an error
  let has_user = resp["data"]["currentUser"]["id"].is_string();
  assert!(!has_user, "invalid session must not return a user");
}

/// Non-admin user must not access admin endpoints.
#[tokio::test]
async fn auth_non_admin_cannot_access_admin_panel() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session) = helpers::seed_user(&pool, &auth_store, "non-admin").await;

  let resp = helpers::gql(
    &app,
    session,
    json!({"query": "{ admin { users(filter: { skip: 0, first: 10 }) { id } } }"}),
  )
  .await;

  assert!(
    resp.get("errors").is_some(),
    "non-admin must be rejected from admin panel"
  );

  // Cleanup
  sqlx::query("DELETE FROM sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE owner_user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

/// Sign in with non-existent email must not crash.
#[tokio::test]
async fn auth_nonexistent_email_handled() {
  let (app, _pool, _auth_store) = helpers::setup_app().await;

  let res = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .body(Body::from(
          json!({"email": "does-not-exist-9999@example.test", "password": "anything"}).to_string(),
        ))
        .expect("request body must be constructible"),
    )
    .await
    .expect("sign-in request must not fail at transport level");

  let status = res.status().as_u16();
  assert!(
    status == 401 || status == 403 || status == 400 || status == 404,
    "non-existent email must be rejected gracefully, got {status}"
  );
}

/// Sign in with wrong password returns 400 WRONG_SIGN_IN_CREDENTIALS, not 500.
#[tokio::test]
async fn auth_wrong_password_returns_credential_error() {
  let (app, pool, _auth_store) = helpers::setup_app().await;

  // Create a user with a real password hash
  let user_id = helpers::create_user(&pool, "wrong-pw2", false).await;
  let email = format!("wrong-pw2_{user_id}@example.test");
  let hash = myoxus_application::auth::hash_password_for_testing("correct-password-123").expect("hash password");
  sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
    .bind(&hash)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("set password hash");

  let res = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .body(Body::from(
          json!({"email": email, "password": "wrong-password-456"}).to_string(),
        ))
        .expect("request body must be constructible"),
    )
    .await
    .expect("sign-in request must not fail at transport level");

  let status = res.status().as_u16();
  assert!(
    status == 400 || status == 401 || status == 403,
    "wrong password must return 4xx, got {status}"
  );
  // Must not be 500
  assert_ne!(status, 500, "wrong password must not cause internal error");

  let body_bytes = http_body_util::BodyExt::collect(res.into_body())
    .await
    .expect("body")
    .to_bytes();
  let body: Value = serde_json::from_slice(&body_bytes).unwrap_or_else(|_| json!({}));
  // Verify error name if present
  if let Some(name) = body.get("name").and_then(|v| v.as_str()) {
    assert_eq!(name, "WRONG_SIGN_IN_CREDENTIALS", "error name mismatch: {body}");
  }

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// Sign in with email that does not exist returns proper error, not 500.
#[tokio::test]
async fn auth_nonexistent_email_returns_credential_error() {
  let (app, _pool, _auth_store) = helpers::setup_app().await;

  let unique_email = format!("nonexistent-{}@example.test", uuid::Uuid::new_v4());
  let res = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .body(Body::from(
          json!({"email": unique_email, "password": "some-password"}).to_string(),
        ))
        .expect("request body must be constructible"),
    )
    .await
    .expect("sign-in request must not fail at transport level");

  let status = res.status().as_u16();
  assert!(
    (400..500).contains(&status),
    "non-existent email must return 4xx client error, got {status}"
  );
  assert_ne!(status, 500, "non-existent email must not cause 500");
}

/// changePassword with an invalid/garbage token returns error, not 500.
#[tokio::test]
async fn auth_change_password_invalid_token_rejected() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "chgpw-inv").await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation ChangePassword($token: String!, $newPassword: String!) { changePassword(token: $token, newPassword: $newPassword) }",
      "variables": {
        "token": "totally-invalid-garbage-token-12345",
        "newPassword": "NewPassword123!"
      }
    }),
  )
  .await;

  assert!(
    resp.get("errors").is_some(),
    "changePassword with invalid token must return an error, got: {resp}"
  );
  let error_name = resp["errors"][0]["extensions"]["name"].as_str().unwrap_or("");
  assert!(
    error_name == "INVALID_EMAIL_TOKEN" || error_name == "NOT_FOUND" || error_name == "LINK_EXPIRED",
    "expected InvalidToken/NotFound/LinkExpired error, got: {error_name}"
  );

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// Disabled user cannot sign in — returns credential error.
#[tokio::test]
async fn auth_disabled_user_cannot_sign_in() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  // Create a regular user with a password
  let user_id = helpers::create_user(&pool, "disabled-usr", false).await;
  let email = format!("disabled-usr_{user_id}@example.test");
  let hash = myoxus_application::auth::hash_password_for_testing("ValidPassword123!").expect("hash password");
  sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
    .bind(&hash)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("set password hash");

  // Verify sign-in works BEFORE disabling
  let res_before = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .body(Body::from(
          json!({"email": email, "password": "ValidPassword123!"}).to_string(),
        ))
        .expect("request body must be constructible"),
    )
    .await
    .expect("pre-disable sign-in request must not fail at transport level");
  let status_before = res_before.status().as_u16();
  assert!(
    status_before == 200 || status_before == 201,
    "sign-in must succeed before disabling, got {status_before}"
  );

  // Disable user via admin mutation (banUser)
  let ban_resp = helpers::gql(
    &app,
    admin_session,
    json!({"query": format!("mutation {{ admin {{ banUser(id:\"{user_id}\") {{ id disabled }} }} }}")}),
  )
  .await;
  assert!(ban_resp.get("errors").is_none(), "banUser failed: {ban_resp}");
  assert_eq!(
    ban_resp["data"]["admin"]["banUser"]["disabled"], true,
    "user must be disabled after ban"
  );

  // Try sign-in with disabled user — must be rejected
  let res_after = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .body(Body::from(
          json!({"email": email, "password": "ValidPassword123!"}).to_string(),
        ))
        .expect("request body must be constructible"),
    )
    .await
    .expect("post-disable sign-in request must not fail at transport level");
  let status_after = res_after.status().as_u16();
  assert!(
    (400..500).contains(&status_after),
    "disabled user sign-in must be rejected with 4xx, got {status_after}"
  );
  assert_ne!(status_after, 500, "disabled user sign-in must not cause 500");

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id, admin_id]).await;
}

// ---------------------------------------------------------------------------
// T02-F-03 — inv_disabled_user_login_is_blocked
//
// Invariant: a user with disabled=true in the DB must not be able to sign in.
// No new session row must be created for them.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_disabled_user_login_is_blocked() {
  let (app, pool, _auth_store) = helpers::setup_app().await;

  // Step 1: Create user with a known password.
  let user_id = helpers::create_user(&pool, "t02f03", false).await;
  let email = format!("t02f03_{user_id}@example.test");
  let hash = myoxus_application::auth::hash_password_for_testing("TestPassword123!").expect("hash password");
  sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
    .bind(&hash)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("T02-F-03: set password hash");

  // Step 2: Manually disable the user via direct DB update.
  sqlx::query("UPDATE users SET status = 'disabled' WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("T02-F-03: disable user in DB");

  // Step 3: Count sessions before the attempt to detect spurious session creation.
  let sessions_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = $1")
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .expect("T02-F-03: session count before");

  // Step 4: Attempt sign-in — must be rejected.
  let res = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .body(Body::from(
          json!({"email": email, "password": "TestPassword123!"}).to_string(),
        ))
        .expect("T02-F-03: request body must be constructible"),
    )
    .await
    .expect("T02-F-03: sign-in request must not fail at transport level");

  let status = res.status().as_u16();
  assert!(
    (400..500).contains(&status),
    "T02-F-03: disabled user sign-in must be rejected with 4xx, got {status}"
  );
  assert_ne!(status, 500, "T02-F-03: disabled user sign-in must not cause 500");

  // Step 5: DB invariant — no new session must have been created.
  let sessions_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = $1")
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .expect("T02-F-03: session count after");
  assert_eq!(
    sessions_after, sessions_before,
    "T02-F-03: no new session must be created for a disabled user, before={sessions_before} after={sessions_after}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}
