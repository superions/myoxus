//! P83 — Invariant-first integration tests: document permissions domain.
//!
//! Each test maps to a named invariant (INV-DP-*).
//!
//! Tests verify DB STATE after operations, not just HTTP / GraphQL responses.
//! Naming convention: `inv_{code}_{description}`.

use crate::helpers;

use serde_json::json;

// ---------------------------------------------------------------------------
// INV-DP-01 — Granted doc permission is persisted in doc_user_permissions
//
// After grantDocUserRoles, a row must exist in doc_user_permissions with
// the correct user_id, doc_id, and role value.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_dp01_doc_permission_stored_in_db() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "inv_dp01_owner").await;
  let grantee_a = helpers::create_user(&pool, "inv_dp01_grantee_a", false).await;
  let grantee_b = helpers::create_user(&pool, "inv_dp01_grantee_b", false).await;
  let grantee_ids = vec![grantee_a, grantee_b];
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;

  let resp = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": r#"mutation G($input: GrantDocUserRolesInput!) { grantDocUserRoles(input: $input) }"#,
      "variables": {
        "input": {
          "workspaceId": workspace_id.to_string(),
          "docId": doc_id.to_string(),
          "userIds": grantee_ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
          "role": "Reader"
        }
      }
    }),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "INV-DP-01: grantDocUserRoles must succeed: {resp}"
  );

  let persisted_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM doc_user_permissions WHERE user_id = ANY($1) AND doc_id = $2 AND role = 'Reader'",
  )
  .bind(&grantee_ids)
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("doc_user_permissions query");

  assert_eq!(
    persisted_count, 2,
    "INV-DP-01: bulk grant must persist the requested role for every grantee"
  );

  helpers::cleanup_users(&pool, &[owner_id, grantee_a, grantee_b]).await;
}

// ---------------------------------------------------------------------------
// INV-DP-02 — Revoked doc permission is removed from doc_user_permissions
//
// After revokeDocUserRoles, the row in doc_user_permissions must be deleted.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_dp02_revoked_permission_removed_from_db() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "inv_dp02_owner").await;
  let grantee_a = helpers::create_user(&pool, "inv_dp02_grantee_a", false).await;
  let grantee_b = helpers::create_user(&pool, "inv_dp02_grantee_b", false).await;
  let grantee_ids = vec![grantee_a, grantee_b];
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;

  for grantee_id in &grantee_ids {
    sqlx::query("INSERT INTO doc_user_permissions (user_id, doc_id, role) VALUES ($1, $2, 'Editor')")
      .bind(grantee_id)
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("direct grant");
  }

  let before: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM doc_user_permissions WHERE user_id = ANY($1) AND doc_id = $2")
      .bind(&grantee_ids)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("pre-condition check");
  assert_eq!(
    before, 2,
    "INV-DP-02 pre: both permission rows must exist before revoke"
  );

  // Revoke via GraphQL mutation
  let resp = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": r#"mutation R($input: RevokeDocUserRoleInput!) { revokeDocUserRoles(input: $input) }"#,
      "variables": {
        "input": {
          "workspaceId": workspace_id.to_string(),
          "docId": doc_id.to_string(),
          "userIds": grantee_ids.iter().map(ToString::to_string).collect::<Vec<_>>()
        }
      }
    }),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "INV-DP-02: revokeDocUserRoles must succeed: {resp}"
  );

  let after: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM doc_user_permissions WHERE user_id = ANY($1) AND doc_id = $2")
      .bind(&grantee_ids)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("post-revoke check");
  assert_eq!(
    after, 0,
    "INV-DP-02: bulk revoke must delete every requested permission row"
  );

  helpers::cleanup_users(&pool, &[owner_id, grantee_a, grantee_b]).await;
}

// ---------------------------------------------------------------------------
// INV-DP-03 — Workspace member can read workspace docs without a doc-level grant
//
// A user with an Accepted workspace_memberships row should be able to call
// the doc query without a permission-denied error.  This tests the fallback
// path: workspace membership grants at least Reader access to workspace docs.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_dp03_workspace_member_can_read_workspace_docs() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _owner_session) = helpers::seed_user(&pool, &auth_store, "inv_dp03_owner").await;
  let (member_id, member_session) = helpers::seed_user(&pool, &auth_store, "inv_dp03_member").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;

  // Add member to workspace with Collaborator role
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, 'Collaborator', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(member_id)
  .execute(&pool)
  .await
  .expect("add workspace member");

  // Assert: member can query the doc without permission denied
  let resp = helpers::gql(
    &app,
    member_session,
    json!({
      "query": r#"query D($wsId: String!, $docId: String!) { workspace(id: $wsId) { doc(docId: $docId) { id } } }"#,
      "variables": {
        "wsId": workspace_id.to_string(),
        "docId": doc_id.to_string()
      }
    }),
  )
  .await;

  // No permission-denied errors must appear
  let has_permission_error = resp
    .get("errors")
    .and_then(|e| e.as_array())
    .map(|errs| {
      errs.iter().any(|e| {
        e["message"]
          .as_str()
          .map(|m| m.to_lowercase().contains("permission") || m.to_lowercase().contains("forbidden"))
          .unwrap_or(false)
      })
    })
    .unwrap_or(false);

  assert!(
    !has_permission_error,
    "INV-DP-03: workspace Collaborator must not receive a permission error reading a workspace doc: {resp}"
  );

  helpers::cleanup_users(&pool, &[owner_id, member_id]).await;
}
