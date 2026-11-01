//! P83 — Invariant-first integration tests: auth domain.
//!
//! Each test maps directly to a named invariant from
//! `docs/dev/server/business-logic-auth.md`.
//!
//! Tests verify DB STATE after operations, not just HTTP / GraphQL responses.
//! Naming convention: `inv_{code}_{description}`.

use crate::helpers;

use axum::{body::Body, http::Request};
use myoxus_application::auth::hash_password_for_testing;
use serde_json::json;
use sqlx::Row;
use tower::ServiceExt;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// INV-A-01 — A new user gets a personal workspace on first sign-in
//
// After sign-in the auth handler calls `ensure_personal_workspace`.
// Invariant: exactly one workspace row owned by the user carries the explicit
// canonical userspace marker and has an Owner membership.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_a01_new_user_gets_personal_workspace() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  let email = format!("inv-a01-{}@example.test", Uuid::new_v4().simple());

  // Create user via admin mutation — this also calls ensure_personal_workspace
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation CreateUser($email: String!, $name: String!) { admin { createUser(input: { email: $email, name: $name }) { id } } }",
      "variables": { "email": &email, "name": "INV-A-01 User" }
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "INV-A-01: createUser failed: {resp}");
  let user_id: Uuid = resp["data"]["admin"]["createUser"]["id"]
    .as_str()
    .expect("user id")
    .parse()
    .expect("user id uuid");

  // Assert: a personal workspace owned by the user exists in DB
  let ws_row = sqlx::query(
    r#"SELECT w.id, m.role
       FROM workspaces w
       JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = $1
       WHERE w.owner_user_id = $1
         AND w.owner_principal_type = 'user'
         AND w.is_personal_workspace = TRUE
         AND w.deleted_at IS NULL
       LIMIT 1"#,
  )
  .bind(user_id)
  .fetch_optional(&pool)
  .await
  .expect("personal workspace query");

  assert!(ws_row.is_some(), "INV-A-01: no personal workspace found for new user");
  assert_eq!(
    ws_row
      .as_ref()
      .expect("workspace row must exist")
      .get::<String, _>("role"),
    "Owner",
    "INV-A-01: user must have Owner role in personal workspace"
  );

  helpers::cleanup_users(&pool, &[admin_id, user_id]).await;
}

// ---------------------------------------------------------------------------
// INV-A-02 — Session is revoked in DB after sign-out
//
// After /api/auth/sign-out the `revoked_at` column must be set in `sessions`.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_a02_session_invalidated_after_sign_out() {
  let (app, pool, _auth_store) = helpers::setup_app().await;
  let email = format!("inv-a02-{}@example.test", Uuid::new_v4().simple());
  let password = "InvA02Pass!";
  let pw_hash = hash_password_for_testing(password).expect("hash");

  let user_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO users (id, email, name, password_hash, is_admin, email_verified_at) VALUES ($1, $2, $3, $4, false, now())",
  )
  .bind(user_id)
  .bind(&email)
  .bind("INV-A-02 User")
  .bind(&pw_hash)
  .execute(&pool)
  .await
  .expect("insert user");

  // Sign in to get a session
  let sign_in_resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "email": email, "password": password }).to_string()))
        .expect("build request"),
    )
    .await
    .expect("sign-in response");
  assert_eq!(sign_in_resp.status(), 200, "INV-A-02: sign-in must succeed");

  // Extract session cookie
  let set_cookie = sign_in_resp
    .headers()
    .get_all("set-cookie")
    .iter()
    .filter_map(|v| v.to_str().ok())
    .find(|c| c.starts_with("affine_session="))
    .expect("affine_session cookie");
  let session_id: Uuid = set_cookie
    .strip_prefix("affine_session=")
    .and_then(|rest| rest.split(';').next())
    .and_then(|s| s.parse().ok())
    .expect("session uuid");

  // Extract CSRF cookie (sign-out requires CSRF header matching CSRF cookie)
  let csrf_token = sign_in_resp
    .headers()
    .get_all("set-cookie")
    .iter()
    .filter_map(|v| v.to_str().ok())
    .find(|c| c.starts_with("myoxus_csrf_token="))
    .and_then(|c| c.strip_prefix("myoxus_csrf_token="))
    .and_then(|rest| rest.split(';').next())
    .map(str::to_owned)
    .unwrap_or_default();

  // Sign out — include session + CSRF cookie + CSRF header
  let sign_out_resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-out")
        .header(
          "cookie",
          format!("affine_session={session_id}; myoxus_csrf_token={csrf_token}"),
        )
        .header("x-myoxus-csrf-token", &csrf_token)
        .body(Body::empty())
        .expect("build request"),
    )
    .await
    .expect("sign-out response");
  assert_eq!(sign_out_resp.status(), 200, "INV-A-02: sign-out must succeed");

  // Assert: session has revoked_at set in DB
  let revoked_at: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT revoked_at FROM sessions WHERE id = $1")
      .bind(session_id)
      .fetch_optional(&pool)
      .await
      .expect("session query")
      .flatten();

  assert!(
    revoked_at.is_some(),
    "INV-A-02: session {session_id} must have revoked_at set after sign-out"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// INV-A-03 — Magic-link OTP is consumed (consumed_at set) on use
//
// Insert an OTP directly into DB, then call /api/auth/magic-link.
// Assert: consumed_at IS NOT NULL in magic_link_otps.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_a03_magic_link_otp_consumed_on_use() {
  let (app, pool, _auth_store) = helpers::setup_app().await;
  let email = format!("inv-a03-{}@example.test", Uuid::new_v4().simple());
  let otp = format!("{:06}", 123456u32);

  // Pre-create user so the OTP flow can find them
  let user_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, is_admin, email_verified_at) VALUES ($1, $2, $3, false, now())")
    .bind(user_id)
    .bind(&email)
    .bind("INV-A-03 User")
    .execute(&pool)
    .await
    .expect("insert user");

  // Create a verification_token first (infrastructure code decodes it non-optionally)
  let vt_id: Uuid = sqlx::query_scalar(
    "INSERT INTO verification_tokens (user_id, kind, token_hash, email, expires_at) VALUES ($1, 'SignIn', $2, $3, now() + INTERVAL '30 minutes') RETURNING id",
  )
  .bind(user_id)
  .bind(format!("vt-{}", Uuid::new_v4()))
  .bind(&email)
  .fetch_one(&pool)
  .await
  .expect("insert verification_token");

  // Insert OTP directly — unique email per test run so plain INSERT is safe
  sqlx::query(
    "INSERT INTO magic_link_otps (email, otp_hash, verification_token_id, expires_at) VALUES (lower($1), $2, $3, now() + INTERVAL '30 minutes')",
  )
  .bind(&email)
  .bind(&otp)
  .bind(vt_id)
  .execute(&pool)
  .await
  .expect("insert otp");

  // Assert OTP exists and is not consumed yet
  let before: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT consumed_at FROM magic_link_otps WHERE lower(email) = lower($1)")
      .bind(&email)
      .fetch_optional(&pool)
      .await
      .expect("otp query before")
      .flatten();
  assert!(before.is_none(), "INV-A-03: OTP must not be consumed before use");

  // Use OTP via /api/auth/magic-link
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/magic-link")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "email": email, "token": otp }).to_string()))
        .expect("build request"),
    )
    .await
    .expect("magic-link response");
  assert_eq!(resp.status(), 200, "INV-A-03: magic-link sign-in must succeed");

  // Assert: consumed_at IS NOT NULL
  let consumed_at: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT consumed_at FROM magic_link_otps WHERE lower(email) = lower($1)")
      .bind(&email)
      .fetch_optional(&pool)
      .await
      .expect("otp query after")
      .flatten();
  assert!(
    consumed_at.is_some(),
    "INV-A-03: OTP must have consumed_at set after use — single-use invariant broken"
  );

  // magic_link_otps CASCADE-deleted when verification_token is deleted,
  // which in turn is CASCADE-deleted when the user is deleted via cleanup_users.
  helpers::cleanup_users(&pool, &[user_id]).await;
}
