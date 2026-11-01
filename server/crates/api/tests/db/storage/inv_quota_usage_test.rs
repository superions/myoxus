// SPDX-License-Identifier: AGPL-3.0-or-later
//! P96-F2-C03 — Invariant: quotaUsage.storageQuota returns the real SUM(size),
//! not 0. Regression test for NUMERIC/INT8 type mismatch (missing ::bigint cast).

use crate::helpers;

use serde_json::json;

/// INV-F2-C01: quotaUsage.storageQuota must equal the sum of all blob sizes
/// belonging to the user's workspaces. Before the ::bigint fix, SUM(BIGINT)
/// returned NUMERIC which SQLx decoded as 0 silently.
#[tokio::test]
async fn inv_f2_quota_usage_returns_real_value() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "inv_f2_quota").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  // Insert two blobs directly with known sizes.
  for (key, size) in [("blob-a", 1024_i64), ("blob-b", 2048_i64)] {
    sqlx::query(
      "INSERT INTO blobs (workspace_id, key, size, mime, status) VALUES ($1, $2, $3, 'application/octet-stream', 'completed')",
    )
    .bind(workspace_id)
    .bind(key)
    .bind(size)
    .execute(&pool)
    .await
    .expect("insert blob");
  }

  let resp = helpers::gql(
    &app,
    session_id,
    json!({ "query": "{ currentUser { quotaUsage { storageQuota } } }" }),
  )
  .await;

  assert!(resp.get("errors").is_none(), "GraphQL errors: {resp}");
  let used = resp["data"]["currentUser"]["quotaUsage"]["storageQuota"]
    .as_i64()
    .expect("storageQuota must be an integer");
  assert!(
    used >= 3072,
    "INV-F2: storageQuota must be >= 3072 (sum of inserted blobs), got {used}. \
     If this is 0, the ::bigint cast is missing on the SUM() query."
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}
