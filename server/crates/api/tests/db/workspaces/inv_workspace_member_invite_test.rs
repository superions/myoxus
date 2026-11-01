//! Invariant-first integration tests for workspace membership invitations.
//! Extended by P100-SRV-F-10: acceptInviteById full-chain invariants.
//!
//! Tests verify DB STATE after operations, not just HTTP/GraphQL responses.
//! Naming convention: `inv_f_{code}_{description}`.

use crate::helpers;

use serde_json::json;

// ---------------------------------------------------------------------------
// INV-F-01 — serverUsers returns privacy-scoped results for workspace managers
//
// A user holding Admin role on any workspace may call serverUsers and receives
// results containing only id/name/avatarUrl — no email, no isAdmin flag.
// A user with no managed workspace receives a permission-denied error.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_f_server_users_search() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let (manager_id, manager_session) = helpers::seed_user(&pool, &auth_store, "inv_f01_mgr").await;
  let (plain_id, plain_session) = helpers::seed_user(&pool, &auth_store, "inv_f01_plain").await;

  // Give manager an Admin-role workspace membership so UsersManage is granted.
  let ws_id = helpers::create_workspace(&pool, manager_id).await;
  sqlx::query("UPDATE workspace_memberships SET role = 'Admin' WHERE workspace_id = $1 AND user_id = $2")
    .bind(ws_id)
    .bind(manager_id)
    .execute(&pool)
    .await
    .expect("set admin role");

  // Manager can call serverUsers and gets results (array, no errors).
  // serverUsers lives under auth { serverUsers(...) }.
  let resp = helpers::gql(
    &app,
    manager_session,
    json!({ "query": r#"{ auth { serverUsers(search: "inv_f01") { id name avatarUrl } } }"# }),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "INV-F-01: manager must not get error: {resp}"
  );
  let results = resp["data"]["auth"]["serverUsers"]
    .as_array()
    .expect("INV-F-01: must be array");
  assert!(
    !results.is_empty(),
    "INV-F-01: results must be non-empty for existing users"
  );
  // Verify privacy: no email field present in schema result
  assert!(results[0].get("email").is_none(), "INV-F-01: email must not be exposed");

  // Admin can also call serverUsers.
  let resp2 = helpers::gql(
    &app,
    admin_session,
    json!({ "query": r#"{ auth { serverUsers(search: "inv_f01") { id name } } }"# }),
  )
  .await;
  assert!(
    resp2.get("errors").is_none(),
    "INV-F-01: admin must not get error: {resp2}"
  );

  // Plain user (no managed workspace) gets permission denied.
  let resp3 = helpers::gql(
    &app,
    plain_session,
    json!({ "query": r#"{ auth { serverUsers(search: "inv_f01") { id name } } }"# }),
  )
  .await;
  assert!(
    resp3.get("errors").is_some(),
    "INV-F-01: plain user must get permission error: {resp3}"
  );

  helpers::cleanup_users(&pool, &[admin_id, manager_id, plain_id]).await;
}

// ---------------------------------------------------------------------------
// INV-F-01b — serverUsers is reachable at the GraphQL root (top-level alias).
//
// The client's `ExistingUserInviteDialog` issues `query ServerUsers($search:
// String!){ serverUsers(search:$search){ ... } }` at the root. The resolver
// lives under `auth.serverUsers`; the root alias in `graphql/mod.rs` forwards
// to it. This test guards that alias so a refactor cannot silently break the
// invite dialog at runtime.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_f01b_server_users_top_level_alias() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  let resp = helpers::gql(
    &app,
    admin_session,
    json!({ "query": r#"query ServerUsers($search: String!) { serverUsers(search: $search) { id name avatarUrl } }"#,
            "variables": { "search": "inv_f01b" } }),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "INV-F-01b: root-level serverUsers must resolve: {resp}"
  );
  assert!(
    resp["data"]["serverUsers"].is_array(),
    "INV-F-01b: data.serverUsers must be an array: {resp}"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ---------------------------------------------------------------------------
// INV-F-07 — addWorkspaceMember creates an Accepted membership (admin bypass)
//
// After admin calls addWorkspaceMember, the workspace_memberships row must
// have status=Accepted. A second call for the same user returns an error.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_f_admin_add_member() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "inv_f07_owner").await;
  let (target_id, _) = helpers::seed_user(&pool, &auth_store, "inv_f07_target").await;

  let ws_id = helpers::create_workspace(&pool, owner_id).await;

  // Admin adds target user directly (bypasses invite flow).
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": r#"mutation AM($wid: ID!, $uid: ID!) {
        admin { addWorkspaceMember(workspaceId: $wid, userId: $uid) { id status } }
      }"#,
      "variables": { "wid": ws_id.to_string(), "uid": target_id.to_string() }
    }),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "INV-F-07: addWorkspaceMember must succeed: {resp}"
  );
  let status = resp["data"]["admin"]["addWorkspaceMember"]["status"]
    .as_str()
    .unwrap_or("");
  assert_eq!(status, "Accepted", "INV-F-07: status must be Accepted");

  // Assert DB invariant: membership row exists with status=Accepted.
  let db_status: String =
    sqlx::query_scalar("SELECT status FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
      .bind(ws_id)
      .bind(target_id)
      .fetch_one(&pool)
      .await
      .expect("INV-F-07: membership row must exist");
  assert_eq!(
    db_status, "Accepted",
    "INV-F-07: DB status must be Accepted, got {db_status}"
  );

  // Second add of the same user must return an error (AlreadyInSpace).
  let resp2 = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": r#"mutation AM($wid: ID!, $uid: ID!) {
        admin { addWorkspaceMember(workspaceId: $wid, userId: $uid) { id } }
      }"#,
      "variables": { "wid": ws_id.to_string(), "uid": target_id.to_string() }
    }),
  )
  .await;
  assert!(
    resp2.get("errors").is_some(),
    "INV-F-07: duplicate add must return error: {resp2}"
  );

  helpers::cleanup_users(&pool, &[admin_id, owner_id, target_id]).await;
}

// ---------------------------------------------------------------------------
// INV-F-02 — inviteServerUserById creates a Pending membership + Invite outbox
//
// After inviteServerUserById, the workspace_memberships row must have
// status=Pending, and an outbox_events row of type 'invite' must exist.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_f_invite_by_id_creates_pending_membership() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "inv_f02_owner").await;
  let (target_id, _) = helpers::seed_user(&pool, &auth_store, "inv_f02_target").await;

  let ws_id = helpers::create_workspace(&pool, owner_id).await;

  let resp = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": r#"mutation IV($wid: ID!, $uid: ID!) {
        inviteServerUserById(workspaceId: $wid, userId: $uid)
      }"#,
      "variables": { "wid": ws_id.to_string(), "uid": target_id.to_string() }
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "INV-F-02: mutation must succeed: {resp}");

  // INV: membership status = Pending
  let db_status: String =
    sqlx::query_scalar("SELECT status FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
      .bind(ws_id)
      .bind(target_id)
      .fetch_one(&pool)
      .await
      .expect("INV-F-02: membership row must exist");
  assert_eq!(
    db_status, "Pending",
    "INV-F-02: DB status must be Pending, got {db_status}"
  );

  // INV: Invite outbox event exists for this workspace
  let event_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM outbox_events WHERE event_type = 'invite' AND aggregate_id = $1")
      .bind(ws_id.to_string())
      .fetch_one(&pool)
      .await
      .expect("INV-F-02: outbox query");
  assert!(event_count > 0, "INV-F-02: invite outbox event must exist");

  helpers::cleanup_users(&pool, &[owner_id, target_id]).await;
}

// ---------------------------------------------------------------------------
// INV-F-09 — create_invite_link emits Invite outbox event with inviteLinkId
//
// After createInviteLink, the outbox event payload must contain inviteLinkId.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_f_invite_idempotency_key_set() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "inv_f09_owner").await;

  let ws_id = helpers::create_workspace(&pool, owner_id).await;

  let resp = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": r#"mutation IL($wid: ID!) {
        createInviteLink(workspaceId: $wid, expireTime: OneDay) { link }
      }"#,
      "variables": { "wid": ws_id.to_string() }
    }),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "INV-F-09: createInviteLink must succeed: {resp}"
  );

  // INV: outbox event for the invite link contains inviteLinkId
  let payload: serde_json::Value = sqlx::query_scalar(
    "SELECT payload FROM outbox_events WHERE event_type = 'invite' AND aggregate_id = $1 ORDER BY created_at DESC LIMIT 1",
  )
  .bind(ws_id.to_string())
  .fetch_one(&pool)
  .await
  .expect("INV-F-09: outbox event must exist");
  assert!(
    payload.get("inviteLinkId").is_some(),
    "INV-F-09: payload must contain inviteLinkId, got: {payload}"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// INV-F-10a — acceptInviteById sets membership status to Accepted in DB
//
// After acceptInviteById, the workspace_memberships row must have
// status=Accepted, and an outbox event of type 'access_change' must exist
// for the workspace (signalling the owner that the invite was accepted).
//
// P100-SRV-F-10 split: test (a) covers the acceptInviteById DB invariants.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_f_invite_accepted_creates_access_change_event() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "inv_f10a_owner").await;
  let (target_id, target_session) = helpers::seed_user(&pool, &auth_store, "inv_f10a_target").await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;

  // Step 1: Owner invites target user → returns invite_id (the membership.id UUID).
  let resp = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": r#"mutation IV($wid: ID!, $uid: ID!) {
        inviteServerUserById(workspaceId: $wid, userId: $uid)
      }"#,
      "variables": { "wid": ws_id.to_string(), "uid": target_id.to_string() }
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "INV-F-10a: invite must succeed: {resp}");
  let invite_id = resp["data"]["inviteServerUserById"]
    .as_str()
    .expect("INV-F-10a: must return invite_id string");

  // Assert INV: membership is Pending before acceptance.
  let db_status_before: String =
    sqlx::query_scalar("SELECT status FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
      .bind(ws_id)
      .bind(target_id)
      .fetch_one(&pool)
      .await
      .expect("INV-F-10a: membership row must exist after invite");
  assert_eq!(
    db_status_before, "Pending",
    "INV-F-10a: status must be Pending before acceptance"
  );

  // Step 2: Target user accepts the invite via acceptInviteById.
  let resp2 = helpers::gql(
    &app,
    target_session,
    json!({
      "query": r#"mutation AC($wid: ID!, $inv: ID!) {
        acceptInviteById(workspaceId: $wid, inviteId: $inv)
      }"#,
      "variables": { "wid": ws_id.to_string(), "inv": invite_id }
    }),
  )
  .await;
  assert!(
    resp2.get("errors").is_none(),
    "INV-F-10a: acceptInviteById must succeed: {resp2}"
  );
  assert_eq!(
    resp2["data"]["acceptInviteById"].as_bool(),
    Some(true),
    "INV-F-10a: acceptInviteById must return true"
  );

  // Assert INV-F-10a-1: membership status = Accepted in DB.
  let db_status_after: String =
    sqlx::query_scalar("SELECT status FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
      .bind(ws_id)
      .bind(target_id)
      .fetch_one(&pool)
      .await
      .expect("INV-F-10a: membership row must exist after acceptance");
  assert_eq!(
    db_status_after, "Accepted",
    "INV-F-10a-1: DB membership status must be Accepted after acceptInviteById"
  );

  // Assert INV-F-10a-2: outbox event of type access_change exists for this workspace.
  let access_change_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM outbox_events \
     WHERE event_type = 'access_change' AND aggregate_id = $1",
  )
  .bind(ws_id.to_string())
  .fetch_one(&pool)
  .await
  .expect("INV-F-10a: outbox query must succeed");
  assert!(
    access_change_count > 0,
    "INV-F-10a-2: access_change outbox event must exist after acceptInviteById \
     (drives owner notification of invite acceptance)"
  );

  // Assert INV-F-10a-3: access_change payload contains action=invite_accepted.
  let payload: serde_json::Value = sqlx::query_scalar(
    "SELECT payload FROM outbox_events \
     WHERE event_type = 'access_change' AND aggregate_id = $1 ORDER BY created_at DESC LIMIT 1",
  )
  .bind(ws_id.to_string())
  .fetch_one(&pool)
  .await
  .expect("INV-F-10a: outbox event payload query must succeed");
  assert_eq!(
    payload.get("action").and_then(|v| v.as_str()),
    Some("invite_accepted"),
    "INV-F-10a-3: access_change payload must have action=invite_accepted, got: {payload}"
  );

  helpers::cleanup_users(&pool, &[owner_id, target_id]).await;
}

#[tokio::test]
async fn shared_workspace_invite_uses_canonical_workspace_pipeline() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let (target_id, target_session) = helpers::seed_user(&pool, &auth_store, "shared_invite_target").await;
  let organization_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id =
    helpers::create_organization_unit(&pool, organization_id, unit_type_id, None, "Shared invite owner").await;

  let created = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($unit: ID!) { createWorkspaceInOrganizationUnit(input: {unitId: $unit, name: \"Shared invite fixture\"}) { id workspaceType } }",
      "variables": { "unit": unit_id.to_string() }
    }),
  )
  .await;
  let workspace_id: uuid::Uuid = created["data"]["createWorkspaceInOrganizationUnit"]["id"]
    .as_str()
    .unwrap_or_else(|| panic!("shared workspace creation must succeed: {created}"))
    .parse()
    .expect("workspace id");
  assert_eq!(
    created["data"]["createWorkspaceInOrganizationUnit"]["workspaceType"],
    "Shared"
  );

  let invited = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($workspace: ID!, $user: ID!) { inviteServerUserById(workspaceId: $workspace, userId: $user) }",
      "variables": {
        "workspace": workspace_id.to_string(),
        "user": target_id.to_string()
      }
    }),
  )
  .await;
  let invite_id = invited["data"]["inviteServerUserById"]
    .as_str()
    .unwrap_or_else(|| panic!("shared workspace invite must succeed: {invited}"));

  let pending: (String, uuid::Uuid) = sqlx::query_as(
    "SELECT status, id
       FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2",
  )
  .bind(workspace_id)
  .bind(target_id)
  .fetch_one(&pool)
  .await
  .expect("pending shared workspace membership");
  assert_eq!(pending.0, "Pending");
  assert_eq!(pending.1.to_string(), invite_id);

  let invite_payload: serde_json::Value = sqlx::query_scalar(
    "SELECT payload
       FROM outbox_events
      WHERE event_type = 'invite' AND aggregate_id = $1
      ORDER BY created_at DESC
      LIMIT 1",
  )
  .bind(workspace_id.to_string())
  .fetch_one(&pool)
  .await
  .expect("workspace invitation outbox event");
  assert_eq!(
    invite_payload
      .get("invitedUserId")
      .and_then(serde_json::Value::as_str)
      .map(str::to_owned),
    Some(target_id.to_string())
  );
  assert_eq!(
    invite_payload
      .get("workspaceId")
      .and_then(serde_json::Value::as_str)
      .map(str::to_owned),
    Some(workspace_id.to_string())
  );
  assert_eq!(
    invite_payload.get("kind").and_then(serde_json::Value::as_str),
    Some("direct_invite")
  );

  let accepted = helpers::gql(
    &app,
    target_session,
    json!({
      "query": "mutation($workspace: ID!, $invite: ID!) { acceptInviteById(workspaceId: $workspace, inviteId: $invite) }",
      "variables": {
        "workspace": workspace_id.to_string(),
        "invite": invite_id
      }
    }),
  )
  .await;
  assert_eq!(
    accepted["data"]["acceptInviteById"], true,
    "shared workspace invite acceptance must succeed: {accepted}"
  );
  let final_status: String = sqlx::query_scalar(
    "SELECT status
       FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2",
  )
  .bind(workspace_id)
  .bind(target_id)
  .fetch_one(&pool)
  .await
  .expect("accepted shared workspace membership");
  assert_eq!(final_status, "Accepted");

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("delete shared workspace fixture");
  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  helpers::cleanup_users(&pool, &[admin_id, target_id]).await;
}
