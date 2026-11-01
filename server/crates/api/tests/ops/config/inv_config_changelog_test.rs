// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariant tests for config changelog (P91-CFG-D-T02).

use crate::helpers;

use serde_json::json;
use sqlx::Row;

/// INV-CFG-CL03: adminConfigChangelog returns entries ordered newest-first (reads admin_audit_log)
#[tokio::test]
async fn inv_cfg_cl03_changelog_query_ordered_desc() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  // Two sequential updates for copilot.enabled
  for val in [true, false] {
    helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"mutation U($u:[UpdateAppConfigInput!]!){admin{adminUpdateConfig(updates:$u){applied}}}"#,
        "variables": { "u": [{"module":"copilot","key":"enabled","value":val}] }
      }),
    )
    .await;
  }

  let resp = helpers::gql(
    &app,
    session_id,
    json!({ "query": "query{admin{configChangelog(limit:10){id configKey changedAt}}}" }),
  )
  .await;

  assert!(resp.get("errors").is_none(), "query failed: {resp}");

  let entries = resp["data"]["admin"]["configChangelog"]
    .as_array()
    .expect("entries array");

  // Verify at least 2 entries exist and changedAt is non-empty
  let our_entries: Vec<_> = entries.iter().filter(|e| e["configKey"] == "copilot.enabled").collect();
  assert!(
    our_entries.len() >= 2,
    "expected >= 2 changelog entries for copilot.enabled"
  );

  // Newest entry must appear before older ones (ordered by the query).
  // IDs are now UUIDs — compare changedAt timestamps instead.
  let timestamps: Vec<&str> = our_entries
    .iter()
    .map(|e| e["changedAt"].as_str().unwrap_or(""))
    .collect();
  assert!(
    timestamps[0] >= timestamps[1],
    "first entry changedAt must be >= second (newest-first order)"
  );

  // Cleanup
  sqlx::query("DELETE FROM admin_audit_log WHERE category = 'config' AND target_id = 'copilot.enabled'")
    .execute(&pool)
    .await
    .expect("cleanup audit log");
  sqlx::query("DELETE FROM app_configs WHERE id = 'copilot.enabled'")
    .execute(&pool)
    .await
    .expect("cleanup app_configs");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-CFG-CL04: adminConfigChangelog requires admin session
#[tokio::test]
async fn inv_cfg_cl04_changelog_requires_admin() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  // Seed a non-admin user
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "nonadmin-cl04").await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({ "query": "query{admin{configChangelog(limit:5){id configKey}}}" }),
  )
  .await;

  let errors = resp.get("errors").and_then(|e| e.as_array());
  assert!(
    errors.is_some() && !errors.unwrap().is_empty(),
    "non-admin must receive a GraphQL error, got: {resp}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}
