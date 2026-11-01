// SPDX-License-Identifier: AGPL-3.0-or-later
//! P113-AUDIT — Invariant tests for the admin audit log.
//!
//! Each test asserts on the `admin_audit_log` DB state after a mutation.
//! Naming: `inv_audit_{nn}_{description}`.
//!
//! INV-AUDIT-02: user creation → `user.create` row in `admin_audit_log`
//! INV-AUDIT-03: user deletion → `user.delete` row in `admin_audit_log`
//! INV-AUDIT-04: config update → `config.*` row with category='config'
//! INV-AUDIT-05: audit rows are ordered newest-first by `adminAuditLog` resolver
//! INV-AUDIT-06: `adminAuditLog` filter by category returns only matching rows
//! INV-AUDIT-07: `banUser` → `user.disable` row in `admin_audit_log`
//! INV-AUDIT-08: sensitive config values are not stored in audit log plaintext

use crate::helpers;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

// ─── INV-AUDIT-02 ────────────────────────────────────────────────────────────
// After createUser succeeds, a row with event_key='user.create' and
// category='user' must exist in admin_audit_log.

#[tokio::test]
async fn inv_audit02_user_create_records_event() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (_admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let email = format!("audit02-{}@example.test", Uuid::new_v4().simple());
  let create_resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": r#"mutation CU($e: String!) { admin { createUser(input: { email: $e }) { id email } } }"#,
      "variables": { "e": &email }
    }),
  )
  .await;
  assert!(create_resp.get("errors").is_none(), "createUser failed: {create_resp}");
  let user_id = create_resp["data"]["admin"]["createUser"]["id"]
    .as_str()
    .unwrap()
    .to_owned();
  let user_uuid = Uuid::parse_str(&user_id).unwrap();
  // Assert: audit row exists
  let row = sqlx::query(
    "SELECT event_key, category, new_value FROM admin_audit_log WHERE target_id = $1 AND event_key = 'user.create' LIMIT 1",
  )
  .bind(user_uuid.to_string())
  .fetch_optional(&pool)
  .await
  .expect("DB query");
  let row = row.expect("INV-AUDIT-02: no user.create row in admin_audit_log");
  assert_eq!(
    row.get::<String, _>("event_key"),
    "user.create",
    "INV-AUDIT-02: wrong event_key"
  );
  assert_eq!(row.get::<String, _>("category"), "user", "INV-AUDIT-02: wrong category");
  // new_value should contain the email
  let new_val: serde_json::Value = row.get("new_value");
  assert!(
    new_val["email"].as_str().map(|s| s.contains(&email)).unwrap_or(false),
    "INV-AUDIT-02: email missing from new_value"
  );
  // Cleanup
  sqlx::query("DELETE FROM admin_audit_log WHERE target_id = $1")
    .bind(user_uuid.to_string())
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_uuid)
    .execute(&pool)
    .await
    .ok();
}

// ─── INV-AUDIT-03 ────────────────────────────────────────────────────────────
// After deleteUser succeeds, a row with event_key='user.delete' must exist in
// admin_audit_log. Verifies audit is recorded even though the user row is gone.

#[tokio::test]
async fn inv_audit03_user_delete_records_event() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (_admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  // Create a throwaway user directly
  let user_id = helpers::create_user(&pool, "audit03_del", false).await;
  let delete_resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": r#"mutation DU($id: String!) { admin { deleteUser(id: $id) { success } } }"#,
      "variables": { "id": user_id.to_string() }
    }),
  )
  .await;
  assert!(delete_resp.get("errors").is_none(), "deleteUser failed: {delete_resp}");
  assert_eq!(
    delete_resp["data"]["admin"]["deleteUser"]["success"], true,
    "INV-AUDIT-03: success must be true"
  );
  // Assert: audit row with user.delete exists (target_id = user_id as string)
  let row = sqlx::query(
    "SELECT event_key, category FROM admin_audit_log WHERE target_id = $1 AND event_key = 'user.delete' LIMIT 1",
  )
  .bind(user_id.to_string())
  .fetch_optional(&pool)
  .await
  .expect("DB query");
  let row = row.expect("INV-AUDIT-03: no user.delete row in admin_audit_log");
  assert_eq!(
    row.get::<String, _>("event_key"),
    "user.delete",
    "INV-AUDIT-03: wrong event_key"
  );
  // Cleanup
  sqlx::query("DELETE FROM admin_audit_log WHERE target_id = $1")
    .bind(user_id.to_string())
    .execute(&pool)
    .await
    .ok();
}

// ─── INV-AUDIT-04 ────────────────────────────────────────────────────────────
// After adminUpdateConfig mutation, a row with category='config' must exist in
// admin_audit_log for the updated key.

#[tokio::test]
async fn inv_audit04_config_update_recorded() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (_admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  // Update a non-sensitive config key
  let config_key = "server.name";
  let config_val = format!("audit04-{}", Uuid::new_v4().simple());
  let update_resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": r#"mutation UAC($updates: [UpdateAppConfigInput!]!) {
        admin { adminUpdateConfig(updates: $updates) { applied fieldErrors { path message } } }
      }"#,
      "variables": {
        "updates": [{ "module": "server", "key": "name", "value": &config_val }]
      }
    }),
  )
  .await;
  assert!(
    update_resp.get("errors").is_none(),
    "adminUpdateConfig failed: {update_resp}"
  );
  assert_eq!(
    update_resp["data"]["admin"]["adminUpdateConfig"]["applied"], true,
    "INV-AUDIT-04: config update must be applied, got: {update_resp}"
  );
  // Assert the exact audit row for this mutation. Matching the unique value
  // keeps the full integration wrapper from passing on unrelated config rows.
  let row = sqlx::query(
    "SELECT event_key, category, new_value
       FROM admin_audit_log
      WHERE target_id = $1
        AND event_key = $2
        AND category = 'config'
        AND new_value = to_jsonb($3::text)
      ORDER BY created_at DESC
      LIMIT 1",
  )
  .bind(config_key)
  .bind("config.server.name.update")
  .bind(&config_val)
  .fetch_optional(&pool)
  .await
  .expect("DB query");
  let row = row.expect("INV-AUDIT-04: no config audit row in admin_audit_log");
  assert_eq!(
    row.get::<String, _>("category"),
    "config",
    "INV-AUDIT-04: wrong category"
  );
  let event_key: String = row.get("event_key");
  assert!(
    event_key.starts_with("config."),
    "INV-AUDIT-04: event_key should start with 'config.', got {event_key}"
  );
  // Cleanup
  sqlx::query("DELETE FROM admin_audit_log WHERE target_id = $1 AND category = 'config'")
    .bind(config_key)
    .execute(&pool)
    .await
    .expect("clean config audit rows");
  sqlx::query("DELETE FROM app_configs WHERE id = 'server.name'")
    .execute(&pool)
    .await
    .expect("clean server name override");
}

// ─── INV-AUDIT-05 ────────────────────────────────────────────────────────────
// `adminAuditLog` resolver returns entries newest-first.

#[tokio::test]
async fn inv_audit05_resolver_returns_newest_first() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (_admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  // Seed two audit rows with known ordering
  let tag = Uuid::new_v4().simple().to_string();
  sqlx::query(
    "INSERT INTO admin_audit_log (id, event_key, category, created_at) VALUES ($1, $2, 'workspace', now() - interval '2 seconds'), ($3, $4, 'workspace', now())",
  )
  .bind(Uuid::new_v4())
  .bind(format!("audit05-old-{tag}"))
  .bind(Uuid::new_v4())
  .bind(format!("audit05-new-{tag}"))
  .execute(&pool)
  .await
  .expect("seed");
  // Query resolver — filter by eventKeyPrefix to isolate our rows
  let list_resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": r#"query AL($prefix: String!) { admin { adminAuditLog(filter: { eventKeyPrefix: $prefix }, limit: 10, offset: 0) { eventKey createdAt } } }"#,
      "variables": { "prefix": "audit05-" }
    }),
  )
  .await;
  assert!(list_resp.get("errors").is_none(), "adminAuditLog failed: {list_resp}");
  let entries = list_resp["data"]["admin"]["adminAuditLog"].as_array().expect("array");
  assert!(entries.len() >= 2, "INV-AUDIT-05: expected ≥2 entries");
  let first_key = entries[0]["eventKey"].as_str().unwrap();
  assert!(
    first_key.contains("new"),
    "INV-AUDIT-05: newest entry must come first, got {first_key}"
  );
  // Cleanup
  sqlx::query("DELETE FROM admin_audit_log WHERE event_key LIKE 'audit05-%'")
    .execute(&pool)
    .await
    .ok();
}

// ─── INV-AUDIT-06 ────────────────────────────────────────────────────────────
// `adminAuditLog` filter by `category` returns only rows of that category.

#[tokio::test]
async fn inv_audit06_filter_by_category_is_exclusive() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (_admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let tag = Uuid::new_v4().simple().to_string();
  // Seed two distinct, currently valid categories.
  sqlx::query(
    "INSERT INTO admin_audit_log (id, event_key, category, created_at) VALUES ($1, $2, 'config', now()), ($3, $4, 'workspace', now())",
  )
  .bind(Uuid::new_v4())
  .bind(format!("audit06-config-{tag}"))
  .bind(Uuid::new_v4())
  .bind(format!("audit06-workspace-{tag}"))
  .execute(&pool)
  .await
  .expect("seed");
  // Query with category=config filter
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": r#"query AL { admin { adminAuditLog(filter: { category: "config" }, limit: 100, offset: 0) { category } } }"#
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "adminAuditLog failed: {resp}");
  let entries = resp["data"]["admin"]["adminAuditLog"].as_array().expect("array");
  for entry in entries {
    assert_eq!(
      entry["category"].as_str().unwrap(),
      "config",
      "INV-AUDIT-06: category filter leaked non-config entries"
    );
  }
  // Cleanup
  sqlx::query("DELETE FROM admin_audit_log WHERE event_key LIKE 'audit06-%'")
    .execute(&pool)
    .await
    .ok();
}

// ─── INV-AUDIT-07 ────────────────────────────────────────────────────────────
// After banUser succeeds, a row with event_key='user.disable' must exist in
// admin_audit_log, and the user's status column must be 'disabled'.

#[tokio::test]
async fn inv_audit07_ban_user_records_disable_and_sets_status() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (_admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let user_id = helpers::create_user(&pool, "audit07_ban", false).await;
  let ban_resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": r#"mutation BU($id: String!) { admin { banUser(id: $id) { id } } }"#,
      "variables": { "id": user_id.to_string() }
    }),
  )
  .await;
  assert!(ban_resp.get("errors").is_none(), "banUser failed: {ban_resp}");
  // Invariant A: DB status is 'disabled'
  let status: String = sqlx::query_scalar("SELECT status FROM users WHERE id = $1")
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .expect("status query");
  assert_eq!(status, "disabled", "INV-AUDIT-07: user.status should be 'disabled'");
  // Invariant B: audit row exists
  let row = sqlx::query(
    "SELECT event_key, category FROM admin_audit_log WHERE target_id = $1 AND event_key = 'user.disable' LIMIT 1",
  )
  .bind(user_id.to_string())
  .fetch_optional(&pool)
  .await
  .expect("audit query");
  let _ = row.expect("INV-AUDIT-07: no user.disable row in admin_audit_log");
  // Cleanup
  sqlx::query("DELETE FROM admin_audit_log WHERE target_id = $1")
    .bind(user_id.to_string())
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

// ─── INV-AUDIT-08 ────────────────────────────────────────────────────────────
// Config updates for sensitive keys (e.g. SMTP password) must not store
// the plaintext value in admin_audit_log.

#[tokio::test]
async fn inv_audit08_sensitive_config_not_stored_in_audit() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (_admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let secret_val = format!("supersecret-{}", Uuid::new_v4().simple());
  // mail.smtp_pass is sensitive.
  let update_resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": r#"
        mutation UAC($v: String!) {
          admin {
            adminUpdateConfig(updates: [
              { module: "mail", key: "smtp_user", value: "audit-test-user" },
              { module: "mail", key: "smtp_pass", value: $v }
            ]) {
              applied
              fieldErrors { path message }
            }
          }
        }
      "#,
      "variables": { "v": &secret_val }
    }),
  )
  .await;
  assert!(
    update_resp.get("errors").is_none(),
    "sensitive update failed: {update_resp}"
  );
  assert_eq!(
    update_resp["data"]["admin"]["adminUpdateConfig"]["applied"], true,
    "valid paired SMTP credentials must be accepted: {update_resp}"
  );
  // No audit row may contain the raw secret.
  let count: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE new_value::text LIKE $1")
    .bind(format!("%{secret_val}%"))
    .fetch_one(&pool)
    .await
    .expect("count query");
  assert_eq!(
    count, 0,
    "INV-AUDIT-08: secret value found in admin_audit_log.new_value — must be redacted"
  );
  // Cleanup — remove the audit and config rows for this key.
  sqlx::query("DELETE FROM admin_audit_log WHERE target_id = 'mail.smtp_pass'")
    .execute(&pool)
    .await
    .expect("cleanup sensitive audit row");
  sqlx::query("DELETE FROM app_configs WHERE id IN ('mail.smtp_user', 'mail.smtp_pass')")
    .execute(&pool)
    .await
    .expect("cleanup sensitive config row");
}
