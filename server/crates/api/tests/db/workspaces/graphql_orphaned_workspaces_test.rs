//! Invariant tests for orphaned workspace detection (P16-B-03).
//!
//! Verifies INV-OW-01 through INV-OW-07: the three orphaned criteria
//! (no owner, deleted owner, no members), healthy-workspace negative,
//! non-admin-block, count consistency, and OU-owned workspace negative.
//!
//! Requires migrations 0039_orphaned_workspaces (nullable owner_user_id) and
//! 0209_workspace_ownership_classification (explicit owner principals).

use crate::helpers;

use myoxus_application::auth::AuthStore;
use serde_json::{Value, json};
use uuid::Uuid;

// ─── GraphQL helpers ─────────────────────────────────────────────────────────

async fn query_orphaned(app: &axum::Router, session: Uuid) -> Value {
  helpers::gql(
    app,
    session,
    json!({
      "query": "{ admin { orphanedWorkspaces(skip: 0, take: 100) { id name owner { id } } } }"
    }),
  )
  .await
}

async fn query_orphaned_count(app: &axum::Router, session: Uuid) -> Value {
  helpers::gql(
    app,
    session,
    json!({ "query": "{ admin { orphanedWorkspacesCount } }" }),
  )
  .await
}

async fn reassign_owner(app: &axum::Router, session: Uuid, workspace_id: Uuid, new_owner_id: Uuid) -> Value {
  helpers::gql(
    app,
    session,
    json!({
      "query": "mutation($workspaceId: String!, $newOwnerId: String!) { admin { reassignWorkspaceOwner(workspaceId: $workspaceId, newOwnerId: $newOwnerId) } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "newOwnerId": new_owner_id.to_string(),
      }
    }),
  )
  .await
}

/// Create a workspace directly in the DB, returning its UUID.
async fn insert_workspace(pool: &sqlx::PgPool, name: &str, owner_id: Option<Uuid>) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO workspaces (id, owner_user_id, name, public, created_at, updated_at)
       VALUES ($1, $2, $3, false, now(), now())"#,
  )
  .bind(id)
  .bind(owner_id)
  .bind(name)
  .execute(pool)
  .await
  .expect("insert workspace");
  id
}

/// Add a workspace membership.
async fn insert_membership(pool: &sqlx::PgPool, workspace_id: Uuid, user_id: Uuid) {
  sqlx::query(
    r#"INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'Collaborator', 'Accepted', now())
       ON CONFLICT DO NOTHING"#,
  )
  .bind(workspace_id)
  .bind(user_id)
  .execute(pool)
  .await
  .expect("insert membership");
}

/// Cleanup helper — removes workspace + memberships created during a test.
async fn cleanup_workspace(pool: &sqlx::PgPool, ws_id: Uuid) {
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .expect("cleanup workspace memberships");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .expect("cleanup workspace");
}

async fn cleanup_user(pool: &sqlx::PgPool, user_id: Uuid) {
  sqlx::query("DELETE FROM workspace_memberships WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("cleanup user memberships");
  sqlx::query("DELETE FROM workspaces WHERE owner_user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("cleanup user workspaces");
  sqlx::query("DELETE FROM sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("cleanup user sessions");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("cleanup user");
}

/// Extract workspace IDs from an orphanedWorkspaces response.
fn extract_ids(resp: &Value) -> Vec<String> {
  resp["data"]["admin"]["orphanedWorkspaces"]
    .as_array()
    .expect("orphaned workspaces query")
    .iter()
    .filter_map(|w| w["id"].as_str().map(String::from))
    .collect()
}

// ─── INV-OW-01: Workspace with NULL owner is orphaned ────────────────────────

#[tokio::test]
async fn inv_ow01_null_owner_is_orphaned() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  let ws_id = insert_workspace(&pool, "inv-ow01-null-owner", None).await;

  let resp = query_orphaned(&app, admin_session).await;
  assert!(resp.get("errors").is_none(), "GQL error: {resp}");
  let ids = extract_ids(&resp);
  assert!(
    ids.contains(&ws_id.to_string()),
    "NULL-owner workspace must be orphaned"
  );

  cleanup_workspace(&pool, ws_id).await;
  cleanup_user(&pool, admin_id).await;
}

// ─── INV-OW-02: Workspace whose owner was deleted is orphaned ────────────────

#[tokio::test]
async fn inv_ow02_deleted_owner_is_orphaned() {
  let (app, pool, auth_store) = helpers::setup_app_with_pdf_admin_repos().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  // Create a regular user, give them a workspace + membership, then delete
  let doomed_user = helpers::create_user(&pool, "doomed", false).await;
  let surviving_member = helpers::create_user(&pool, "surviving-member", false).await;
  let ws_id = insert_workspace(&pool, "inv-ow02-deleted-owner", Some(doomed_user)).await;
  insert_membership(&pool, ws_id, doomed_user).await;
  insert_membership(&pool, ws_id, surviving_member).await;

  // Before deletion: should NOT be orphaned (has owner + member)
  let resp = query_orphaned(&app, admin_session).await;
  assert!(resp.get("errors").is_none(), "GQL error: {resp}");
  let ids = extract_ids(&resp);
  assert!(
    !ids.contains(&ws_id.to_string()),
    "should not be orphaned before owner deletion"
  );

  // Exercise the account lifecycle rather than bypassing the owner-principal
  // transition with raw SQL. Shared content must become system-owned while
  // the deleted user's membership is removed.
  auth_store
    .delete_user(doomed_user)
    .await
    .expect("delete workspace owner");

  let assignment_actor = sqlx::query_scalar::<_, Option<Uuid>>(
    "SELECT assigned_by FROM pdf_workspace_template_assignments WHERE workspace_id = $1 AND is_default = TRUE",
  )
  .bind(ws_id)
  .fetch_one(&pool)
  .await
  .expect("read preserved default PDF assignment");
  assert_eq!(
    assignment_actor,
    Some(doomed_user),
    "account deletion must preserve the retained historical PDF assignment actor"
  );
  let actor_status = sqlx::query_scalar::<_, String>("SELECT status::text FROM users WHERE id = $1")
    .bind(doomed_user)
    .fetch_one(&pool)
    .await
    .expect("historical actor identity remains valid");
  assert_eq!(
    actor_status, "deleted",
    "the historical actor must no longer be operational"
  );

  // The shared workspace is orphaned because its active user owner is gone.
  let resp = query_orphaned(&app, admin_session).await;
  assert!(resp.get("errors").is_none(), "GQL error: {resp}");
  let ids = extract_ids(&resp);
  assert!(
    ids.contains(&ws_id.to_string()),
    "workspace with deleted owner must be orphaned"
  );

  cleanup_workspace(&pool, ws_id).await;
  cleanup_user(&pool, doomed_user).await;
  cleanup_user(&pool, surviving_member).await;
  cleanup_user(&pool, admin_id).await;
}

// ─── INV-OW-03: Workspace with no accepted members is orphaned ───────────────

#[tokio::test]
async fn inv_ow03_no_members_is_orphaned() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  // Owner exists, but workspace has zero memberships
  let owner = helpers::create_user(&pool, "lonely-owner", false).await;
  let ws_id = insert_workspace(&pool, "inv-ow03-no-members", Some(owner)).await;

  let resp = query_orphaned(&app, admin_session).await;
  assert!(resp.get("errors").is_none(), "GQL error: {resp}");
  let ids = extract_ids(&resp);
  assert!(
    ids.contains(&ws_id.to_string()),
    "workspace with no members must be orphaned"
  );

  cleanup_workspace(&pool, ws_id).await;
  cleanup_user(&pool, owner).await;
  cleanup_user(&pool, admin_id).await;
}

// ─── INV-OW-04: Healthy workspace is NOT orphaned ────────────────────────────

#[tokio::test]
async fn inv_ow04_healthy_workspace_not_orphaned() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  let owner = helpers::create_user(&pool, "healthy-owner", false).await;
  let ws_id = insert_workspace(&pool, "inv-ow04-healthy", Some(owner)).await;
  insert_membership(&pool, ws_id, owner).await;

  let resp = query_orphaned(&app, admin_session).await;
  assert!(resp.get("errors").is_none(), "GQL error: {resp}");
  let ids = extract_ids(&resp);
  assert!(
    !ids.contains(&ws_id.to_string()),
    "healthy workspace must NOT be orphaned"
  );

  cleanup_workspace(&pool, ws_id).await;
  cleanup_user(&pool, owner).await;
  cleanup_user(&pool, admin_id).await;
}

// ─── INV-OW-05: Non-admin cannot query orphaned workspaces ───────────────────

#[tokio::test]
async fn inv_ow05_non_admin_blocked() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "regular").await;

  let resp = query_orphaned(&app, user_session).await;
  assert!(resp.get("errors").is_some(), "non-admin must be rejected");

  cleanup_user(&pool, user_id).await;
}

// ─── INV-OW-06: Our orphans appear in both list and count ───────────────────

#[tokio::test]
async fn inv_ow06_orphans_in_list_and_count() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  // Create two orphaned workspaces (no members)
  let owner = helpers::create_user(&pool, "count-test-owner", false).await;
  let ws1 = insert_workspace(&pool, "inv-ow06-a", Some(owner)).await;
  let ws2 = insert_workspace(&pool, "inv-ow06-b", Some(owner)).await;

  // Both must appear in the list
  let list_resp = query_orphaned(&app, admin_session).await;
  assert!(list_resp.get("errors").is_none(), "GQL error: {list_resp}");
  let ids = extract_ids(&list_resp);
  assert!(ids.contains(&ws1.to_string()), "ws1 must be in orphaned list");
  assert!(ids.contains(&ws2.to_string()), "ws2 must be in orphaned list");

  // Count must be positive and >= list length (count has no LIMIT)
  let count_resp = query_orphaned_count(&app, admin_session).await;
  assert!(count_resp.get("errors").is_none(), "GQL error: {count_resp}");
  let count = count_resp["data"]["admin"]["orphanedWorkspacesCount"]
    .as_i64()
    .expect("orphanedWorkspacesCount must be int");
  assert!(count >= 2, "count must be at least 2 (got {count})");

  cleanup_workspace(&pool, ws1).await;
  cleanup_workspace(&pool, ws2).await;
  cleanup_user(&pool, owner).await;
  cleanup_user(&pool, admin_id).await;
}

// ─── INV-OW-07: OU ownership never enters user-owner repair ─────────────────

#[tokio::test]
async fn inv_ow07_ou_owned_workspace_cannot_be_reassigned_to_user() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let member_id = helpers::create_user(&pool, "ou-workspace-member", false).await;

  let count_before_resp = query_orphaned_count(&app, admin_session).await;
  assert!(
    count_before_resp.get("errors").is_none(),
    "GQL error: {count_before_resp}"
  );
  let count_before = count_before_resp["data"]["admin"]["orphanedWorkspacesCount"]
    .as_i64()
    .expect("orphanedWorkspacesCount must be int");

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "Orphan Negative OU").await;
  let ws_id = Uuid::new_v4();
  sqlx::query(
    r#"
    INSERT INTO workspaces (
      id, owner_user_id, owner_principal_type, owner_principal_id,
      management_unit_id, created_by_user_id, is_personal_workspace,
      name, public, created_at, updated_at
    )
    VALUES ($1, NULL, 'ou', $2, $2, $3, FALSE, $4, FALSE, now(), now())
    "#,
  )
  .bind(ws_id)
  .bind(unit_id)
  .bind(admin_id)
  .bind("inv-ow07-ou-owned")
  .execute(&pool)
  .await
  .expect("insert OU-owned workspace");
  sqlx::query(
    r#"
    INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
    VALUES ($1, $2, 'owner')
    "#,
  )
  .bind(unit_id)
  .bind(ws_id)
  .execute(&pool)
  .await
  .expect("link OU owner to workspace");

  let list_resp = query_orphaned(&app, admin_session).await;
  assert!(list_resp.get("errors").is_none(), "GQL error: {list_resp}");
  assert!(
    !extract_ids(&list_resp).contains(&ws_id.to_string()),
    "OU ownership remains authoritative even without a human workspace member"
  );

  let reassign_resp = reassign_owner(&app, admin_session, ws_id, member_id).await;
  assert!(
    reassign_resp.get("errors").is_some(),
    "direct admin mutation must not convert an OU-owned workspace: {reassign_resp}"
  );
  let ownership = sqlx::query_as::<_, (String, Option<Uuid>, Option<Uuid>)>(
    r#"
    SELECT owner_principal_type::text, owner_principal_id, owner_user_id
    FROM workspaces
    WHERE id = $1
    "#,
  )
  .bind(ws_id)
  .fetch_one(&pool)
  .await
  .expect("load OU workspace ownership after rejected mutation");
  assert_eq!(ownership.0, "ou");
  assert_eq!(ownership.1, Some(unit_id));
  assert_eq!(ownership.2, None);

  let count_after_resp = query_orphaned_count(&app, admin_session).await;
  assert!(
    count_after_resp.get("errors").is_none(),
    "GQL error: {count_after_resp}"
  );
  let count_after = count_after_resp["data"]["admin"]["orphanedWorkspacesCount"]
    .as_i64()
    .expect("orphanedWorkspacesCount must be int");
  assert_eq!(
    count_after, count_before,
    "healthy OU-owned workspace must not increase the orphaned count"
  );

  cleanup_workspace(&pool, ws_id).await;
  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  cleanup_user(&pool, member_id).await;
  cleanup_user(&pool, admin_id).await;
}
