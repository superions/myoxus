//! Security regression integration tests.
//!
//! Tests require a running Postgres instance (test stack).
//! Run with: TEST_DATABASE_URL=postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test cargo test -p myoxus-api --test integration security_regression_test

use myoxus_application::auth::AuthStore;
use myoxus_application::doc::DocService;
use myoxus_application::workspace::WorkspaceStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

async fn setup_db() -> PgPool {
  let database_url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  let pool = PgPool::connect(&database_url)
    .await
    .expect("Failed to connect to test database");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("Failed to run migrations");
  pool
}

/// Unique email for test isolation
fn test_email(prefix: &str) -> String {
  format!("{prefix}-{}@test.local", Uuid::new_v4().simple())
}

/// API-RV-06c: Soft-deleted docs must not be returned via RPC content queries.
#[tokio::test]
async fn inv_api_rv06_soft_deleted_doc_not_in_content() {
  let pool = setup_db().await;
  let auth = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let ws_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let doc_service = DocService::new(doc_store.clone());

  // Create user + workspace
  let user = auth
    .fulfill_user(&test_email("rv06"), Some("RV06"), None)
    .await
    .expect("DB operation");
  let ws = ws_store
    .create_workspace(
      user.id,
      myoxus_application::workspace::WorkspaceName::parse("RV06 WS").unwrap(),
    )
    .await
    .expect("DB operation");

  // Create doc
  let doc_id = Uuid::new_v4();
  doc_service
    .create_doc(ws.id, doc_id, "Secret Doc".to_string(), false, user.id)
    .await
    .expect("DB operation");

  // Verify doc exists
  let meta = doc_service.get_doc_metadata(doc_id).await.expect("DB operation");
  assert!(meta.is_some(), "doc must exist before deletion");

  // Soft-delete
  doc_service.soft_delete_doc(doc_id).await.expect("DB operation");

  // Verify doc metadata returns None (deleted_at IS NULL filter)
  let meta_after = doc_service.get_doc_metadata(doc_id).await.expect("DB operation");
  assert!(
    meta_after.is_none(),
    "soft-deleted doc must not be returned by get_doc_metadata"
  );

  // Cleanup
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("DB operation");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws.id)
    .execute(&pool)
    .await
    .expect("DB operation");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user.id)
    .execute(&pool)
    .await
    .expect("DB operation");
}

/// INF-RV-02b: Pending membership must not count as shared workspace.
#[tokio::test]
async fn inv_inf_rv02_pending_invite_not_shared() {
  let pool = setup_db().await;
  let auth = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let ws_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));

  // Create two users
  let user_a = auth
    .fulfill_user(&test_email("rv02a"), Some("UserA"), None)
    .await
    .expect("DB operation");
  let user_b = auth
    .fulfill_user(&test_email("rv02b"), Some("UserB"), None)
    .await
    .expect("DB operation");

  // Create workspace owned by A
  let ws = ws_store
    .create_workspace(
      user_a.id,
      myoxus_application::workspace::WorkspaceName::parse("Shared Test WS").unwrap(),
    )
    .await
    .expect("DB operation");

  // A is accepted member (auto-added by create_workspace)
  // Add B as PENDING member
  ws_store
    .add_or_update_member(
      ws.id,
      user_b.id,
      myoxus_domain::entities::WorkspaceRole::Collaborator,
      myoxus_domain::entities::MembershipStatus::Pending,
      None,
    )
    .await
    .expect("DB operation");

  // has_shared_workspace must return false — B is only Pending
  let shared = auth
    .has_shared_workspace(user_a.id, user_b.id)
    .await
    .expect("DB operation");
  assert!(!shared, "pending membership must not count as shared workspace");

  // Accept B and verify it now counts
  ws_store
    .add_or_update_member(
      ws.id,
      user_b.id,
      myoxus_domain::entities::WorkspaceRole::Collaborator,
      myoxus_domain::entities::MembershipStatus::Accepted,
      None,
    )
    .await
    .expect("DB operation");

  let shared_after = auth
    .has_shared_workspace(user_a.id, user_b.id)
    .await
    .expect("DB operation");
  assert!(shared_after, "accepted membership must count as shared workspace");

  // Cleanup
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws.id)
    .execute(&pool)
    .await
    .expect("DB operation");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws.id)
    .execute(&pool)
    .await
    .expect("DB operation");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_a.id)
    .execute(&pool)
    .await
    .expect("DB operation");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_b.id)
    .execute(&pool)
    .await
    .expect("DB operation");
}
