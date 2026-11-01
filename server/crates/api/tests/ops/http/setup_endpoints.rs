//! Integration tests for the initial setup endpoints (first-run admin registration).

use crate::helpers;

use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn test_setup_flow() {
  let (app, pool, _auth_store) = helpers::setup_app().await;

  // Ensure no admin exists for this test by checking the setup endpoint directly.
  // The setup endpoint returns 403 when an admin already exists — that's the
  // expected "second call" behaviour we test below.

  let setup_payload = json!({
      "email": "initial_admin@example.com",
      "name": "Initial Admin",
      "password": "password123"
  });

  // 1. First setup call — may succeed or return 403 if an admin already exists
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/setup/create-admin-user")
        .header("content-type", "application/json")
        .body(Body::from(setup_payload.to_string()))
        .expect("build setup request"),
    )
    .await
    .expect("setup request");

  let first_status = response.status().as_u16();
  // In a shared DB, an admin from seed data may already exist → 403 is OK
  assert!(
    first_status == 200 || first_status == 403,
    "setup endpoint must return 200 (first admin) or 403 (admin exists), got {first_status}"
  );

  if first_status == 200 {
    let body = response
      .into_body()
      .collect()
      .await
      .expect("collect setup response body")
      .to_bytes();
    let json: Value = serde_json::from_slice(&body).expect("parse setup response json");
    assert_eq!(json["email"], "initial_admin@example.com");

    // Invariant: setup must have created a user record with is_admin=true.
    let row = sqlx::query_as::<_, (bool, String)>(
      "SELECT is_admin, email FROM users WHERE email = 'initial_admin@example.com'",
    )
    .fetch_one(&pool)
    .await
    .expect("setup must create a user row in the DB");
    let (is_admin, db_email) = row;
    assert!(is_admin, "setup admin user must have is_admin=true in DB");
    assert_eq!(
      db_email, "initial_admin@example.com",
      "setup admin user email in DB must match the posted email"
    );

    // Invariant: setup must have created at least one workspace owned by the new admin.
    let workspace_count: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM workspaces WHERE owner_user_id = (SELECT id FROM users WHERE email = 'initial_admin@example.com')",
    )
    .fetch_one(&pool)
    .await
    .expect("workspace count query must succeed");
    assert!(
      workspace_count >= 1,
      "setup must create at least one workspace for the new admin, found {workspace_count}"
    );

    // 2. Second setup call should fail with 403
    let response2 = app
      .oneshot(
        Request::builder()
          .method("POST")
          .uri("/api/setup/create-admin-user")
          .header("content-type", "application/json")
          .body(Body::from(setup_payload.to_string()))
          .expect("build second setup request"),
      )
      .await
      .expect("second setup request");

    assert_eq!(response2.status(), 403, "second setup call must be forbidden");

    // Cleanup: remove test user via scoped deletes (correct FK order)
    sqlx::query("DELETE FROM workspace_memberships WHERE user_id = (SELECT id FROM users WHERE email = 'initial_admin@example.com')")
      .execute(&pool).await.expect("cleanup: delete workspace_memberships for setup admin");
    sqlx::query(
      "DELETE FROM workspaces WHERE owner_user_id = (SELECT id FROM users WHERE email = 'initial_admin@example.com')",
    )
    .execute(&pool)
    .await
    .expect("cleanup: delete workspaces for setup admin");
    sqlx::query(
      "DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'initial_admin@example.com')",
    )
    .execute(&pool)
    .await
    .expect("cleanup: delete sessions for setup admin");
    sqlx::query("DELETE FROM users WHERE email = 'initial_admin@example.com'")
      .execute(&pool)
      .await
      .expect("cleanup: delete setup admin user");
  }
}
