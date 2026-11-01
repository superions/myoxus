// SPDX-License-Identifier: AGPL-3.0-or-later

//! Consuming GraphQL contract for the shared membership-transition policy.

use crate::helpers;
use serde_json::json;

/// Equal timestamps must not make offset pages depend on insertion order.
/// Count/list remain accepted-only, and a Reader still cannot enumerate people.
#[test]
fn accepted_member_pages_have_total_order_and_preserve_users_read() {
  helpers::block_on_large_stack(
    "accepted_member_pages_have_total_order_and_preserve_users_read",
    || async {
      let (app, pool, auth) = helpers::setup_app().await;
      let mut users: Vec<_> = (0..7).map(|_| uuid::Uuid::new_v4()).collect();
      users.sort();
      // Reverse insertion deliberately disagrees with the required UUID tie-break.
      for user_id in users.iter().rev() {
        sqlx::query(
        "INSERT INTO users (id, email, name, email_verified_at, created_at) VALUES ($1, $2, 'MT-01 member', now(), '2026-01-01T00:00:00Z')",
      )
      .bind(user_id)
      .bind(format!("mt01-{user_id}@example.test"))
      .execute(&pool).await.expect("insert tied-time member");
      }
      let owner_session = helpers::create_session(&auth, users[0]).await;
      let reader_session = helpers::create_session(&auth, users[1]).await;
      let workspace = helpers::create_workspace(&pool, users[0]).await;
      for index in (1..users.len()).rev() {
        let role = if index == 1 { "Reader" } else { "Collaborator" };
        let status = match index {
          5 => "Pending",
          6 => "Revoked",
          _ => "Accepted",
        };
        sqlx::query("INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, $3, $4, now())")
        .bind(workspace).bind(users[index]).bind(role).bind(status)
        .execute(&pool).await.expect("insert membership state");
      }
      let query = "query($id: String!, $skip: Int!, $take: Int!) { workspace(id: $id) { memberCount members(skip: $skip, take: $take) { id status } } }";
      let mut pages = Vec::new();
      for skip in [0, 2, 4, 6] {
        pages.push(
          helpers::gql(
            &app,
            owner_session,
            json!({"query": query, "variables": {"id": workspace.to_string(), "skip": skip, "take": 2}}),
          )
          .await,
        );
      }
      let denied = helpers::gql(
        &app,
        reader_session,
        json!({"query": query, "variables": {"id": workspace.to_string(), "skip": 0, "take": 2}}),
      )
      .await;
      // Clean up before regression assertions, including the deliberately denied request.
      helpers::cleanup_workspaces(&pool, &[workspace]).await;
      helpers::cleanup_users(&pool, &users).await;

      let mut actual = Vec::new();
      for (page, expected_length) in pages.iter().zip([2, 2, 1, 0]) {
        assert!(page["errors"].is_null(), "accepted-member page failed: {page}");
        assert_eq!(page["data"]["workspace"]["memberCount"], 5);
        let members = page["data"]["workspace"]["members"].as_array().expect("member page");
        assert_eq!(members.len(), expected_length);
        for member in members {
          assert_eq!(member["status"], "Accepted");
          actual.push(member["id"].as_str().expect("member ID").to_owned());
        }
      }
      assert_eq!(actual, users[..5].iter().map(ToString::to_string).collect::<Vec<_>>());
      assert!(
        denied["errors"].as_array().is_some_and(|errors| !errors.is_empty()),
        "Reader must not enumerate members: {denied}"
      );
      assert!(denied["data"]["workspace"]["members"].is_null());
    },
  );
}

/// An effective OU `Admin` may manage roles through `Manager`, while
/// administrator and ownership transitions retain their stronger guards.
#[test]
fn effective_ou_manager_membership_mutations_preserve_admin_and_owner_boundaries() {
  helpers::block_on_large_stack(
    "effective_ou_manager_membership_mutations_preserve_admin_and_owner_boundaries",
    || async {
      let (app, pool, auth) = helpers::setup_app().await;
      let (manager_id, manager_session) = helpers::seed_user(&pool, &auth, "xws_permission_manager").await;
      let (outsider_id, outsider_session) = helpers::seed_user(&pool, &auth, "xws_permission_outsider").await;
      let (user_owner_id, user_owner_session) = helpers::seed_user(&pool, &auth, "xws_permission_user_owner").await;
      let creator_id = helpers::create_user(&pool, "xws_permission_creator", false).await;
      let member_id = helpers::create_user(&pool, "xws_permission_member", false).await;
      let admin_id = helpers::create_user(&pool, "xws_permission_admin", false).await;
      let co_owner_id = helpers::create_user(&pool, "xws_permission_co_owner", false).await;

      let organization_id = helpers::default_organization_id(&pool).await;
      let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
      let unit_id =
        helpers::create_organization_unit(&pool, organization_id, unit_type_id, None, "XWS permission unit").await;
      helpers::make_manager_of(&pool, manager_id, unit_id).await;

      let workspace_id = uuid::Uuid::new_v4();
      sqlx::query(
        r#"INSERT INTO workspaces (
             id, owner_user_id, name, public, owner_principal_type,
             owner_principal_id, management_unit_id, created_by_user_id
           )
           VALUES ($1, NULL, 'XWS permission workspace', FALSE, 'ou', $2, $2, $3)"#,
      )
      .bind(workspace_id)
      .bind(unit_id)
      .bind(creator_id)
      .execute(&pool)
      .await
      .expect("insert shared workspace");
      sqlx::query(
        r#"INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
           VALUES ($1, $2, 'owner')"#,
      )
      .bind(unit_id)
      .bind(workspace_id)
      .execute(&pool)
      .await
      .expect("link shared workspace owner");
      for (user_id, role) in [(member_id, "Collaborator"), (admin_id, "Admin")] {
        sqlx::query(
          r#"INSERT INTO workspace_memberships
               (workspace_id, user_id, role, status, joined_at)
             VALUES ($1, $2, $3, 'Accepted', now())"#,
        )
        .bind(workspace_id)
        .bind(user_id)
        .bind(role)
        .execute(&pool)
        .await
        .expect("insert target membership");
      }

      let promote_manager = helpers::gql(
        &app,
        manager_session,
        json!({
          "query": "mutation($workspace: ID!, $user: ID!) { grantMember(workspaceId: $workspace, userId: $user, permission: Manager) }",
          "variables": {
            "workspace": workspace_id.to_string(),
            "user": member_id.to_string(),
          }
        }),
      )
      .await;
      assert!(
        promote_manager["errors"].is_null() && promote_manager["data"]["grantMember"] == true,
        "effective OU Admin must manage a non-admin membership: {promote_manager}"
      );

      let promoted_role: String =
        sqlx::query_scalar("SELECT role::text FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
          .bind(workspace_id)
          .bind(member_id)
          .fetch_one(&pool)
          .await
          .expect("load promoted membership");
      assert_eq!(promoted_role, "Manager");

      for (label, user_id, permission) in [
        ("promote Manager to Admin", member_id, "Admin"),
        ("demote Admin to Manager", admin_id, "Manager"),
        ("transfer human ownership", member_id, "Owner"),
      ] {
        let response = helpers::gql(
          &app,
          manager_session,
          json!({
            "query": format!(
              "mutation($workspace: ID!, $user: ID!) {{ grantMember(workspaceId: $workspace, userId: $user, permission: {permission}) }}"
            ),
            "variables": {
              "workspace": workspace_id.to_string(),
              "user": user_id.to_string(),
            }
          }),
        )
        .await;
        assert!(
          response["errors"].as_array().is_some_and(|errors| !errors.is_empty()),
          "{label} must require a stronger capability: {response}"
        );
      }

      let outsider_mutation = helpers::gql(
        &app,
        outsider_session,
        json!({
          "query": "mutation($workspace: ID!, $user: ID!) { grantMember(workspaceId: $workspace, userId: $user, permission: Manager) }",
          "variables": {
            "workspace": workspace_id.to_string(),
            "user": member_id.to_string(),
          }
        }),
      )
      .await;
      assert!(
        outsider_mutation["errors"]
          .as_array()
          .is_some_and(|errors| !errors.is_empty()),
        "a non-manager must not mutate workspace roles: {outsider_mutation}"
      );

      let user_workspace_id = helpers::create_workspace(&pool, user_owner_id).await;
      sqlx::query(
        r#"INSERT INTO workspace_memberships
             (workspace_id, user_id, role, status, joined_at)
           VALUES ($1, $2, 'Owner', 'Accepted', now())"#,
      )
      .bind(user_workspace_id)
      .bind(co_owner_id)
      .execute(&pool)
      .await
      .expect("insert legacy co-owner fixture");

      for (operation, response) in [
        (
          "demote owner",
          helpers::gql(
            &app,
            user_owner_session,
            json!({
              "query": "mutation($workspace: ID!, $user: ID!) { grantMember(workspaceId: $workspace, userId: $user, permission: Manager) }",
              "variables": {
                "workspace": user_workspace_id.to_string(),
                "user": co_owner_id.to_string(),
              }
            }),
          )
          .await,
        ),
        (
          "revoke owner",
          helpers::gql(
            &app,
            user_owner_session,
            json!({
              "query": "mutation($workspace: ID!, $user: ID!) { revokeMember(workspaceId: $workspace, userId: $user) }",
              "variables": {
                "workspace": user_workspace_id.to_string(),
                "user": co_owner_id.to_string(),
              }
            }),
          )
          .await,
        ),
      ] {
        assert!(
          response["errors"].as_array().is_some_and(|errors| !errors.is_empty()),
          "{operation} must use ownership transfer instead: {response}"
        );
      }

      helpers::cleanup_workspaces(&pool, &[workspace_id, user_workspace_id]).await;
      helpers::cleanup_organization_units(&pool, &[unit_id]).await;
      helpers::cleanup_users(
        &pool,
        &[
          manager_id,
          outsider_id,
          user_owner_id,
          creator_id,
          member_id,
          admin_id,
          co_owner_id,
        ],
      )
      .await;
    },
  );
}
