//! Root-document repair invariants shared by the CLI seed path.

use crate::helpers;

use helpers::setup_pool;
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Insert an orphaned workspace (owner_user_id = NULL).
async fn insert_orphaned_workspace(pool: &PgPool, name: &str) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO workspaces (id, owner_user_id, name, public, created_at, updated_at)
       VALUES ($1, NULL, $2, false, now(), now())"#,
  )
  .bind(id)
  .bind(name)
  .execute(pool)
  .await
  .expect("insert orphaned workspace");
  id
}

async fn root_doc_update_count(pool: &PgPool, workspace_id: Uuid) -> i64 {
  sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1")
    .bind(workspace_id)
    .fetch_one(pool)
    .await
    .expect("count root doc updates")
}

async fn seed_root_doc_snapshot(pool: &PgPool, workspace_id: Uuid, user_id: Uuid) {
  sqlx::query(
    r#"
      INSERT INTO docs (id, workspace_id, is_workspace_root, created_by, updated_by)
      VALUES ($1, $1, true, $2, $2)
      ON CONFLICT (id) DO NOTHING
      "#,
  )
  .bind(workspace_id)
  .bind(user_id)
  .execute(pool)
  .await
  .expect("insert root docs row");

  sqlx::query(
    r#"
      INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence)
      VALUES ($1, $1, $2, 1)
      ON CONFLICT (doc_id) DO UPDATE
      SET payload = EXCLUDED.payload,
          last_sequence = EXCLUDED.last_sequence,
          updated_at = now()
      "#,
  )
  .bind(workspace_id)
  .bind(yjs::create_initial_workspace_doc("cli-rv02c-snapshot"))
  .execute(pool)
  .await
  .expect("insert root doc snapshot");
}

/// Cleanup: remove workspace + any docs/doc_updates created during the test.
async fn cleanup_workspace(pool: &PgPool, ws_id: Uuid) {
  sqlx::query("DELETE FROM doc_updates WHERE doc_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM doc_snapshots WHERE doc_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .ok();
}

/// A compacted root doc can have no pending updates but still be fully seeded
/// through `doc_snapshots`. Re-seeding it would recreate the initial Yjs update
/// and break idempotence.
#[tokio::test]
async fn inv_cli_rv02d_seed_root_doc_skips_snapshot_only_root_doc() {
  let pool = setup_pool().await;
  let ws_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let workspace_svc = WorkspaceService::new(ws_store);

  let admin_id = helpers::create_user(&pool, "cli-rv02d-admin", true).await;
  let ws_id = insert_orphaned_workspace(&pool, "cli-rv02d-snapshot").await;
  seed_root_doc_snapshot(&pool, ws_id, admin_id).await;

  assert_eq!(
    root_doc_update_count(&pool, ws_id).await,
    0,
    "test setup must be snapshot-only"
  );

  let data = yjs::create_initial_workspace_doc("cli-rv02d-snapshot");
  workspace_svc
    .seed_root_doc(ws_id, admin_id, data)
    .await
    .expect("snapshot-only root doc seed must be idempotent");

  assert_eq!(
    root_doc_update_count(&pool, ws_id).await,
    0,
    "snapshot-only root doc must not receive a duplicate initial update"
  );

  cleanup_workspace(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}
