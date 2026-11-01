//! P83 — Invariant-first integration tests: workspace domain.
//!
//! Each test maps directly to a named invariant from
//! `docs/dev/server/business-logic-workspace.md`.
//!
//! Tests verify DB STATE after operations, not just HTTP / GraphQL responses.
//! Naming convention: `inv_{code}_{description}`.

use crate::helpers;

use serde_json::json;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// INV-WS-01 — Owner cannot leave their own workspace
//
// The workspace owner must transfer ownership before leaving.
// Invariant: leaveWorkspace returns an error for the owner, and the Owner
// membership row remains in workspace_memberships.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_ws01_owner_cannot_leave_workspace() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "inv_ws01_owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  // Try to leave workspace as owner
  let resp = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "mutation LW($id: String!) { leaveWorkspace(workspaceId: $id) }",
      "variables": { "id": workspace_id.to_string() }
    }),
  )
  .await;

  assert!(
    resp.get("errors").is_some(),
    "INV-WS-01: owner leaveWorkspace must return an error; got: {resp}"
  );

  // Assert: Owner membership still exists in DB
  let membership_exists: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND role = 'Owner')",
  )
  .bind(workspace_id)
  .bind(owner_id)
  .fetch_one(&pool)
  .await
  .expect("membership query");

  assert!(
    membership_exists,
    "INV-WS-01: Owner membership must remain in DB after failed leaveWorkspace"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// INV-WS-02 — Deleted workspace is soft-deleted and no longer visible to members
//
// deleteWorkspace sets deleted_at and removes the workspace from all members'
// visible workspace lists. DB memberships are preserved (soft-delete, not hard).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_ws02_deleted_workspace_is_soft_deleted_and_invisible() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "inv_ws02_owner").await;
  let (member_id, member_session) = helpers::seed_user(&pool, &auth_store, "inv_ws02_member").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  // Add second member
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, 'Collaborator', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(member_id)
  .execute(&pool)
  .await
  .expect("add member");

  // Precondition: member sees the workspace
  let before = helpers::gql(&app, member_session, json!({"query": "{ workspaces { id } }"})).await;
  let ids_before: Vec<String> = before["data"]["workspaces"]
    .as_array()
    .unwrap_or(&vec![])
    .iter()
    .filter_map(|w| w["id"].as_str().map(str::to_owned))
    .collect();
  assert!(
    ids_before.contains(&workspace_id.to_string()),
    "INV-WS-02 pre: member must see workspace before deletion"
  );

  // Delete workspace as owner
  let del_resp = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "mutation DW($id: String!) { deleteWorkspace(id: $id) }",
      "variables": { "id": workspace_id.to_string() }
    }),
  )
  .await;
  assert!(
    del_resp.get("errors").is_none(),
    "INV-WS-02: deleteWorkspace must succeed: {del_resp}"
  );

  // Assert: workspace has deleted_at set in DB (soft-delete)
  let deleted_at: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT deleted_at FROM workspaces WHERE id = $1")
      .bind(workspace_id)
      .fetch_optional(&pool)
      .await
      .expect("workspace query")
      .flatten();
  assert!(
    deleted_at.is_some(),
    "INV-WS-02: workspace must have deleted_at set after deleteWorkspace"
  );

  // Assert: workspace no longer appears in member's list
  let after = helpers::gql(&app, member_session, json!({"query": "{ workspaces { id } }"})).await;
  let ids_after: Vec<String> = after["data"]["workspaces"]
    .as_array()
    .unwrap_or(&vec![])
    .iter()
    .filter_map(|w| w["id"].as_str().map(str::to_owned))
    .collect();
  assert!(
    !ids_after.contains(&workspace_id.to_string()),
    "INV-WS-02: deleted workspace must not appear in member workspace list"
  );

  // Hard-delete to clean up (bypasses soft-delete filter)
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[owner_id, member_id]).await;
}

// ---------------------------------------------------------------------------
// INV-WS-03 — workspace memberCount matches DB row count
//
// The GraphQL `memberCount` field must equal the number of Accepted
// workspace_memberships rows for the workspace.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_ws03_workspace_member_count_matches_db() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "inv_ws03_owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  // Add 2 more members (owner already counts as 1 via create_workspace)
  let mut extra_user_ids: Vec<Uuid> = Vec::new();
  for i in 0..2usize {
    let uid = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, email, name, is_admin, email_verified_at) VALUES ($1, $2, $3, false, now())")
      .bind(uid)
      .bind(format!("inv-ws03-extra{i}-{uid}@example.test"))
      .bind(format!("Extra {i}"))
      .execute(&pool)
      .await
      .expect("insert extra user");
    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, 'Collaborator', 'Accepted', now())",
    )
    .bind(workspace_id)
    .bind(uid)
    .execute(&pool)
    .await
    .expect("insert membership");
    extra_user_ids.push(uid);
  }

  // GraphQL memberCount
  let resp = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": r#"query WM($id: String!) { workspace(id: $id) { memberCount } }"#,
      "variables": { "id": workspace_id.to_string() }
    }),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "INV-WS-03: memberCount query must not return errors: {resp}"
  );
  let gql_count = resp["data"]["workspace"]["memberCount"]
    .as_i64()
    .expect("memberCount must be a number");

  // DB count of Accepted memberships
  let db_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = $1 AND status = 'Accepted'")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("db count");

  assert_eq!(
    gql_count, db_count,
    "INV-WS-03: GraphQL memberCount ({gql_count}) must match DB Accepted membership count ({db_count})"
  );
  assert_eq!(db_count, 3, "INV-WS-03: expected 3 members (owner + 2 added)");

  // Cleanup
  let mut all_users = vec![owner_id];
  all_users.extend_from_slice(&extra_user_ids);
  helpers::cleanup_users(&pool, &all_users).await;
}
