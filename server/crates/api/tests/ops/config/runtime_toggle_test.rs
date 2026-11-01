//! Integration tests for P42/P43 runtime toggle features.
//!
//! Covers signup and email-verification enforcement plus the template-registry
//! consumer toggle.

use crate::helpers;

use serde_json::json;
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// 1. Signup toggle rejects new users
// ---------------------------------------------------------------------------

#[tokio::test]
// INV: when signup is disabled in app_configs, registration endpoint rejects new users
async fn inv_signup_disabled_rejects_new_user() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  // Disable signups
  helpers::gql(
    &app,
    session_id,
    json!({"query": "mutation { admin { adminUpdateConfig(updates:[{module:\"auth\", key:\"allow_signup\", value:false}]) { applied } } }"}),
  )
  .await;

  // POST sign-in with a brand-new email (no password = magic link path)
  let new_email = format!("new-user-{}@example.test", uuid::Uuid::new_v4());
  let (status, body) = helpers::post_json(&app, session_id, "/api/auth/sign-in", json!({"email": new_email})).await;
  assert_eq!(status, 403, "signup must be rejected when disabled: {body}");

  // Cleanup
  sqlx::query("DELETE FROM app_configs WHERE id = 'auth.allow_signup'")
    .execute(&pool)
    .await
    .expect("clean signup config override");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ---------------------------------------------------------------------------
// 2. Email verification blocks unverified users
// ---------------------------------------------------------------------------

#[tokio::test]
// INV: when email verification is required, unverified users are blocked from protected endpoints
async fn inv_email_verification_blocks_unverified_users() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  // Enable email verification requirement
  helpers::gql(
    &app, admin_session,
    json!({"query": "mutation { admin { adminUpdateConfig(updates:[{module:\"auth\", key:\"require_email_verification\", value:true}]) { applied } } }"}),
  ).await;

  // Create an UNVERIFIED user (email_verified_at = NULL)
  let unverified_id = uuid::Uuid::new_v4();
  sqlx::query(
    "INSERT INTO users (id, email, name, is_admin, email_verified_at) VALUES ($1, $2, 'unverified', false, NULL)",
  )
  .bind(unverified_id)
  .bind(format!("unverified_{}@example.test", unverified_id))
  .execute(&pool)
  .await
  .expect("insert unverified user");
  let unverified_session = helpers::create_session(&auth_store, unverified_id).await;

  // GraphQL query with unverified user should fail
  let resp = helpers::gql(
    &app,
    unverified_session,
    json!({"query": "query { workspaces { id } }"}),
  )
  .await;
  assert!(resp.get("errors").is_some(), "unverified user must be blocked: {resp}");
  let err_ext = &resp["errors"][0]["extensions"];
  assert_eq!(
    err_ext["name"], "EMAIL_VERIFICATION_REQUIRED",
    "error name mismatch: {resp}"
  );

  // Cleanup
  sqlx::query("DELETE FROM app_configs WHERE id = 'auth.require_email_verification'")
    .execute(&pool)
    .await
    .expect("clean email-verification config override");
  helpers::cleanup_users(&pool, &[admin_id, unverified_id]).await;
}

// ---------------------------------------------------------------------------
// 3. Template registry toggle
// ---------------------------------------------------------------------------

#[tokio::test]
// INV: template registry toggle controls whether template endpoints are enabled or disabled
async fn inv_template_registry_toggle_controls_endpoint_availability() {
  let _guard = helpers::TEMPLATE_REGISTRY_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .expect("template registry lock");
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  // Disable template registry
  helpers::gql(
    &app, session_id,
    json!({"query": "mutation { admin { adminUpdateConfig(updates:[{module:\"template_registry\", key:\"enabled\", value:false}]) { applied } } }"}),
  ).await;

  // Query templateCatalog when disabled → expect empty array (not error)
  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": "query { admin { templateCatalog { id title } templateCatalogCount } }"}),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "templateCatalog query should not error when disabled: {resp}"
  );
  let catalog = resp["data"]["admin"]["templateCatalog"].as_array();
  assert!(
    catalog.is_none_or(|a| a.is_empty()),
    "templateCatalog must be empty when disabled"
  );
  assert_eq!(
    resp["data"]["admin"]["templateCatalogCount"], 0,
    "count must be 0 when disabled"
  );

  // Re-enable
  helpers::gql(
    &app, session_id,
    json!({"query": "mutation { admin { adminUpdateConfig(updates:[{module:\"template_registry\", key:\"enabled\", value:true}]) { applied } } }"}),
  ).await;

  // Query templateCatalog again → should work (may still be empty, but no errors)
  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": "query { admin { templateCatalog { id title } templateCatalogCount } }"}),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "templateCatalog should work when re-enabled: {resp}"
  );
  assert!(
    resp["data"]["admin"]["templateCatalog"].is_array(),
    "templateCatalog must be array when enabled"
  );

  // Cleanup
  sqlx::query("DELETE FROM app_configs WHERE id = 'template_registry.enabled'")
    .execute(&pool)
    .await
    .expect("clean template-registry config override");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}
