//! Integration tests for document ACL enforcement (reader/writer/owner roles).
use crate::helpers;

use myoxus_application::auth::AuthStore;
use myoxus_application::doc::DocService;
use myoxus_application::permission::{AccessController, DocResource, PermissionService};
use myoxus_application::workspace::WorkspaceStore;
use myoxus_domain::entities::DocRole;
use myoxus_domain::permission::DocAction;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

async fn setup_db() -> PgPool {
  helpers::setup_pool().await
}

#[tokio::test]
// INV: doc ACL correctly grants/denies actions based on workspace and doc roles
async fn inv_doc_acl_role_enforcement_grants_and_denies_actions() {
  let pool = setup_db().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let doc_service = DocService::new(doc_store.clone());
  let perm_service = PermissionService::new(auth_store.clone());

  // 1. Setup Admin, User and Workspace
  let admin = auth_store
    .fulfill_user("admin_acl@example.com", Some("Admin"), None)
    .await
    .expect("create admin user");
  let guest = auth_store
    .fulfill_user("guest_acl@example.com", Some("Guest"), None)
    .await
    .expect("create guest user");
  let ws = workspace_store
    .create_workspace(admin.id, myoxus_application::workspace::WorkspaceName::default_name())
    .await
    .expect("create workspace");
  let doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'ACL Protected')")
    .bind(doc_id)
    .bind(ws.id)
    .execute(&pool)
    .await
    .expect("insert doc");

  let resource = DocResource {
    user_id: guest.id,
    workspace_id: ws.id,
    doc_id,
  };

  // 2. Guest has no access initially
  assert!(!perm_service.can(&resource, DocAction::Read).await);

  // 3. Grant ACL Reader permission
  doc_service
    .grant_doc_permission(doc_id, guest.id, DocRole::Reader)
    .await
    .expect("grant reader permission");

  // 4. Guest should now have Read access
  assert!(perm_service.can(&resource, DocAction::Read).await);
  // But still no Write access
  assert!(!perm_service.can(&resource, DocAction::Update).await);

  // 5. Upgrade to Editor
  doc_service
    .grant_doc_permission(doc_id, guest.id, DocRole::Editor)
    .await
    .expect("grant editor permission");
  assert!(perm_service.can(&resource, DocAction::Update).await);

  // 6. Revoke permission
  doc_service
    .revoke_doc_permission(doc_id, guest.id)
    .await
    .expect("revoke doc permission");
  assert!(!perm_service.can(&resource, DocAction::Read).await);

  // Cleanup: remove all test artifacts (users cascade to workspaces, docs, permissions)
  helpers::cleanup_users(&pool, &[admin.id, guest.id]).await;
}
