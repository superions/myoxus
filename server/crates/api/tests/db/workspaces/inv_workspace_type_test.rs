//! Workspace ownership classification invariants on the user-facing GraphQL
//! resolver.
//!
//! Invariants tested:
//! - the explicit canonical userspace marker yields `Personal`;
//! - another user-owned workspace remains `UserOwned`, independent of members;
//! - OU ownership yields `Shared` without a parallel team projection.

use crate::helpers;

use serde_json::json;

// ---------------------------------------------------------------------------
// INV-G-WS-01 — Personal workspace classification
//
// Only the explicit canonical userspace marker may resolve as Personal.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_g_workspace_type_personal() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "inv_gwt01_owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  sqlx::query("UPDATE workspaces SET is_personal_workspace = TRUE WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("mark canonical personal userspace");

  let resp = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "query T($id: String!) { workspace(id: $id) { workspaceType } }",
      "variables": { "id": workspace_id.to_string() }
    }),
  )
  .await;

  let ws = &resp["data"]["workspace"];
  assert_eq!(
    ws["workspaceType"].as_str().unwrap_or(""),
    "Personal",
    "INV-G-WS-01: explicitly marked userspace must be 'Personal'; got: {resp}"
  );
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// INV-G-WS-02 — Additional user-owned workspace classification
//
// Adding collaborators does not transfer ownership to an OU.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_g_workspace_type_user_owned_is_independent_of_member_count() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "inv_gwt02_owner").await;
  let (member_id, _) = helpers::seed_user(&pool, &auth_store, "inv_gwt02_member").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  // Add second member directly in DB (Accepted status)
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
     VALUES ($1, $2, 'Collaborator', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(member_id)
  .execute(&pool)
  .await
  .expect("insert second member");

  let resp = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "query T($id: String!) { workspace(id: $id) { workspaceType } }",
      "variables": { "id": workspace_id.to_string() }
    }),
  )
  .await;

  let ws = &resp["data"]["workspace"];
  assert_eq!(
    ws["workspaceType"].as_str().unwrap_or(""),
    "UserOwned",
    "INV-G-WS-02: a user-owned workspace must remain 'UserOwned' with multiple members; got: {resp}"
  );
  helpers::cleanup_users(&pool, &[owner_id, member_id]).await;
}

#[tokio::test]
async fn inv_g_workspace_type_shared_is_derived_from_ou_owner() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (creator_id, creator_session) = helpers::seed_user(&pool, &auth_store, "inv_gwt03_creator").await;
  let workspace_id = helpers::create_workspace(&pool, creator_id).await;
  let unit_id = uuid::Uuid::new_v4();

  sqlx::query(
    r#"INSERT INTO organization_unit
         (id, organization_id, unit_type_id, name, slug, status, created_by)
       SELECT $1, organization_id, id, $2, $3, 'active', $4
         FROM organization_unit_type
        WHERE key = 'team' AND can_own_workspaces = TRUE
        LIMIT 1"#,
  )
  .bind(unit_id)
  .bind("Invariant shared owner")
  .bind(format!("inv-shared-{unit_id}"))
  .bind(creator_id)
  .execute(&pool)
  .await
  .expect("create owning OU");
  sqlx::query("INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship) VALUES ($1, $2, 'owner')")
    .bind(unit_id)
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("assign OU owner");
  sqlx::query(
    r#"UPDATE workspaces
          SET owner_user_id = NULL,
              owner_principal_type = 'ou',
              owner_principal_id = $1,
              management_unit_id = $1,
              is_personal_workspace = FALSE
        WHERE id = $2"#,
  )
  .bind(unit_id)
  .bind(workspace_id)
  .execute(&pool)
  .await
  .expect("project OU ownership");
  sqlx::query("UPDATE workspace_memberships SET role = 'Admin' WHERE workspace_id = $1 AND role = 'Owner'")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("demote former human owner");

  let resp = helpers::gql(
    &app,
    creator_session,
    json!({
      "query": "query T($id: String!) { workspace(id: $id) { workspaceType } }",
      "variables": { "id": workspace_id.to_string() }
    }),
  )
  .await;

  let ws = &resp["data"]["workspace"];
  assert_eq!(
    ws["workspaceType"], "Shared",
    "OU ownership must classify as Shared: {resp}"
  );
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("delete shared workspace fixture");
  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(unit_id)
    .execute(&pool)
    .await
    .expect("delete OU fixture");
  helpers::cleanup_users(&pool, &[creator_id]).await;
}
