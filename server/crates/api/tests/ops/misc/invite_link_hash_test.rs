//! INF-RV-03 verification: invite link tokens are stored as raw UUIDs in the DB.
//!
//! The raw token returned to the caller is stored verbatim in the
//! `workspace_invite_links.token_hash` column (no hashing — column name is
//! a legacy artefact).  Lookup by raw token must succeed.
//!
//! Run with:
//!   TEST_DATABASE_URL=postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test \
//!     cargo test -p myoxus-api --test integration invite_link_hash_test

use myoxus_application::auth::AuthStore;
use myoxus_application::workspace::{WorkspaceService, WorkspaceStore};
use myoxus_infrastructure::auth::SqlxAuthStore;
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

fn test_email(prefix: &str) -> String {
  format!("{prefix}-{}@test.local", Uuid::new_v4().simple())
}

/// INF-RV-03: token_hash column stores the raw UUID token (no hashing).
/// The field name is a legacy artefact — we store raw tokens directly.
#[tokio::test]
async fn inv_inf_rv03_invite_link_token_hashed_in_db() {
  let pool = setup_db().await;
  let auth = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let ws_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let ws_service = WorkspaceService::new(ws_store.clone());

  // 1. Create user + workspace
  let user = auth
    .fulfill_user(&test_email("rv03"), Some("RV03"), None)
    .await
    .expect("create rv03 user");
  let ws = ws_store
    .create_workspace(
      user.id,
      myoxus_application::workspace::WorkspaceName::parse("RV03 WS").unwrap(),
    )
    .await
    .expect("create rv03 workspace");

  // 2. Create invite link — returns the raw token in `token_hash` field
  let link = ws_service
    .create_invite_link(ws.id, user.id, 3_600_000)
    .await
    .expect("create invite link");
  let raw_token = &link.token_hash;
  assert!(!raw_token.is_empty(), "raw token must not be empty");

  // 3. Query DB directly for the stored token_hash
  let db_token: String = sqlx::query_scalar("SELECT token_hash FROM workspace_invite_links WHERE workspace_id = $1")
    .bind(ws.id)
    .fetch_one(&pool)
    .await
    .expect("invite link row must exist in DB");

  // 4. DB value must equal the raw token (stored verbatim — no hashing)
  assert_eq!(
    &db_token, raw_token,
    "token_hash in DB must equal the raw token (stored as-is)"
  );

  // 5. Token must look like a UUID (36-char hyphenated form)
  assert_eq!(db_token.len(), 36, "raw token must be a UUID (36 chars)");
  assert!(
    uuid::Uuid::parse_str(&db_token).is_ok(),
    "token_hash must be a valid UUID, got: {db_token}"
  );

  // 6. Lookup by raw token must find the link
  let found = ws_service
    .get_invite_link_by_token(raw_token)
    .await
    .expect("get invite link by token");
  assert!(found.is_some(), "get_invite_link_by_token must find the link");
  assert_eq!(found.expect("invite link must be found").workspace_id, ws.id);

  // Cleanup
  sqlx::query("DELETE FROM workspace_invite_links WHERE workspace_id = $1")
    .bind(ws.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user.id)
    .execute(&pool)
    .await
    .ok();
}
