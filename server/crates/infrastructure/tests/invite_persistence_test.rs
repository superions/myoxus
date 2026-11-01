//! Integration tests for workspace invitation persistence and expiry.
use myoxus_application::workspace::{WorkspaceService, WorkspaceStore};
use myoxus_domain::entities::{MembershipStatus, WorkspaceRole};
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

// Helper to get DB pool
async fn get_pool() -> PgPool {
  let database_url =
    std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://myoxus:myoxus@localhost:5432/myoxus".to_string());
  PgPool::connect(&database_url)
    .await
    .expect("Failed to connect to database")
}

#[tokio::test]
async fn test_invite_and_join_persistence() {
  let pool = get_pool().await;

  // Run migrations (to ensure schema is up to date for this test)
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("Failed to run migrations");

  let store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  ));
  let workspace_service = WorkspaceService::new(store.clone());

  // 1. Setup Owner
  let owner_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)")
    .bind(owner_id)
    .bind(format!("owner_{}@example.com", owner_id))
    .bind("Owner Name")
    .execute(&pool)
    .await
    .unwrap();

  // 2. Create Workspace
  let ws = workspace_service
    .create_workspace(owner_id, None, None)
    .await
    .expect("Failed to create workspace");

  // 3. Create Invite Link
  let expire_ms = 3600 * 1000; // 1 hour
  let link = workspace_service
    .create_invite_link(ws.id, owner_id, expire_ms)
    .await
    .expect("Failed to create link");
  assert_eq!(link.workspace_id, ws.id);
  assert!(link.expires_at.is_some());
  assert!(link.revoked_at.is_none());

  // 4. Join via Link
  let new_user_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)")
    .bind(new_user_id)
    .bind(format!("newuser_{}@example.com", new_user_id))
    .bind("New User")
    .execute(&pool)
    .await
    .unwrap();

  let join_res = workspace_service
    .accept_invite_by_link(new_user_id, &link.token_hash)
    .await
    .expect("Failed to join via link");
  assert!(join_res);

  // Verify membership
  let member = store
    .get_member(ws.id, new_user_id)
    .await
    .unwrap()
    .expect("Member not found after link join");
  assert_eq!(member.status, MembershipStatus::UnderReview); // Default for link joins in current implementation

  // 5. Email Invite Flow
  let invitee_id = Uuid::new_v4();
  let invitee_email = format!("invitee_{}@example.com", invitee_id);
  sqlx::query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)")
    .bind(invitee_id)
    .bind(&invitee_email)
    .bind("Invitee Name")
    .execute(&pool)
    .await
    .unwrap();

  // Use a mock auth store for fulfilling users (normally the real AuthStore would do this)
  // For this persistence test, we just want to see if the invitation record is created correctly.
  let invite_results = store
    .add_or_update_member(
      ws.id,
      invitee_id,
      WorkspaceRole::Collaborator,
      MembershipStatus::Pending,
      Some(owner_id),
    )
    .await
    .expect("Failed to invite via store");

  assert_eq!(invite_results.user.id, invitee_id);
  assert_eq!(invite_results.status, MembershipStatus::Pending);

  // 6. Accept Email Invite
  let accept_res = workspace_service
    .accept_invite_by_id(invitee_id, invite_results.invite_id)
    .await
    .expect("Failed to accept email invite");
  assert!(accept_res);

  // Verify membership status updated
  let final_member = store
    .get_member(ws.id, invitee_id)
    .await
    .unwrap()
    .expect("Member not found after accept");
  assert_eq!(final_member.status, MembershipStatus::Accepted);

  // 7. Update Member Role
  workspace_service
    .update_member_role(ws.id, invitee_id, WorkspaceRole::Admin)
    .await
    .expect("Failed to update role");
  let updated_member = store
    .get_member(ws.id, invitee_id)
    .await
    .unwrap()
    .expect("Member not found after role update");
  assert_eq!(updated_member.role, WorkspaceRole::Admin);

  // 8. Transfer Ownership
  workspace_service
    .transfer_ownership(ws.id, owner_id, invitee_id)
    .await
    .expect("Failed to transfer ownership");

  // Check new owner
  let ws_after = workspace_service.get_workspace(ws.id).await.unwrap().unwrap();
  assert_eq!(ws_after.owner_user_id, Some(invitee_id));

  // Check roles flipped
  let old_owner_member = store.get_member(ws.id, owner_id).await.unwrap().unwrap();
  assert_eq!(old_owner_member.role, WorkspaceRole::Admin);
  let new_owner_member = store.get_member(ws.id, invitee_id).await.unwrap().unwrap();
  assert_eq!(new_owner_member.role, WorkspaceRole::Owner);

  // 9. Leave Workspace
  workspace_service
    .leave_workspace(new_user_id, ws.id)
    .await
    .expect("Failed to leave workspace");
  let gone_member = store.get_member(ws.id, new_user_id).await.unwrap();
  assert!(gone_member.is_none());

  // 10. Revoke Member
  workspace_service
    .revoke_member(ws.id, owner_id)
    .await
    .expect("Failed to revoke member");
  let revoked_member = store.get_member(ws.id, owner_id).await.unwrap();
  assert!(revoked_member.is_none());
}
