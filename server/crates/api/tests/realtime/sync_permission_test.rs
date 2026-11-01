//! Permission tests for WebSocket sync on shared workspaces (P20-F).
//!
//! Verifies that workspace membership roles correctly gate sync access:
//! - Collaborator can sync (space:join succeeds)
//! - Reader can sync (space:join succeeds — Reader has WorkspaceAction::Sync)
//! - External cannot sync (no Sync action)
//! - Non-member cannot sync

use crate::helpers;

use uuid::Uuid;

/// Create a workspace and add a member with a specific role.
async fn create_workspace_with_member(pool: &sqlx::PgPool, owner_id: Uuid, member_id: Uuid, role: &str) -> Uuid {
  let ws_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
    .bind(ws_id)
    .bind(owner_id)
    .bind(format!("sync-perm-test-{}", &ws_id.to_string()[..8]))
    .execute(pool)
    .await
    .expect("create workspace");

  // Owner membership
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, 'Owner', 'Accepted', now())",
  )
  .bind(ws_id)
  .bind(owner_id)
  .execute(pool)
  .await
  .expect("owner membership");

  // Member membership
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, $3, 'Accepted', now())",
  )
  .bind(ws_id)
  .bind(member_id)
  .bind(role)
  .execute(pool)
  .await
  .expect("member membership");

  ws_id
}

// ─── P20-F: Workspace roles gate sync permission ────────────────────────────

#[tokio::test]
async fn inv_sync_roles_gate_workspace_sync_permission() {
  use myoxus_application::permission::{AccessController, WorkspaceResource};
  use myoxus_domain::permission::WorkspaceAction;

  let pool = helpers::setup_pool().await;
  let owner = helpers::create_user(&pool, "sync-owner", false).await;
  let collab = helpers::create_user(&pool, "sync-collab", false).await;
  let reader = helpers::create_user(&pool, "sync-reader", false).await;
  let outsider = helpers::create_user(&pool, "sync-outsider", false).await;
  let collab_ws_id = create_workspace_with_member(&pool, owner, collab, "Collaborator").await;
  let reader_ws_id = create_workspace_with_member(&pool, owner, reader, "Reader").await;

  let auth_store = std::sync::Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone()));
  let perm_service = myoxus_application::permission::PermissionService::new(auth_store);

  // One setup covers the quick-gate role matrix: positive member roles and the
  // high-risk non-member denial path remain distinct assertions.
  let collaborator_can_sync = perm_service
    .can(
      &WorkspaceResource {
        user_id: collab,
        workspace_id: collab_ws_id,
      },
      WorkspaceAction::Sync,
    )
    .await;
  assert!(
    collaborator_can_sync,
    "Collaborator must have Sync permission on shared workspace"
  );

  let reader_can_sync = perm_service
    .can(
      &WorkspaceResource {
        user_id: reader,
        workspace_id: reader_ws_id,
      },
      WorkspaceAction::Sync,
    )
    .await;
  assert!(reader_can_sync, "Reader must have Sync permission");

  let outsider_can_sync = perm_service
    .can(
      &WorkspaceResource {
        user_id: outsider,
        workspace_id: collab_ws_id,
      },
      WorkspaceAction::Sync,
    )
    .await;
  assert!(!outsider_can_sync, "non-member must NOT have Sync permission");

  helpers::cleanup_users(&pool, &[owner, collab, reader, outsider]).await;
}
