use std::sync::Arc;

use myoxus_application::doc::DocService;
use myoxus_infrastructure::doc::SqlxDocStore;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

async fn test_pool() -> sqlx::PgPool {
  let url = std::env::var("TEST_DATABASE_URL")
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  PgPoolOptions::new()
    .max_connections(3)
    .connect(&url)
    .await
    .expect("connect TEST_DATABASE_URL")
}

async fn insert_doc_fixture(pool: &sqlx::PgPool, workspace_id: Uuid, doc_id: Uuid, user_id: Uuid) {
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'PDF worker test', 'active')")
    .bind(user_id)
    .bind(format!("pdf-worker-{user_id}@example.test"))
    .execute(pool)
    .await
    .expect("insert user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'PDF worker test')")
    .bind(workspace_id)
    .bind(user_id)
    .execute(pool)
    .await
    .expect("insert workspace");
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'PDF worker test doc')")
    .bind(doc_id)
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("insert doc");
}

async fn cleanup_fixture(pool: &sqlx::PgPool, workspace_id: Uuid, user_id: Uuid) {
  let _ = sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await;
}

fn doc_service(pool: &sqlx::PgPool) -> DocService {
  DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
}

#[tokio::test]
async fn inv_pdf_pipeline_load_01_merges_updates_without_snapshot() {
  let pool = test_pool().await;
  let workspace_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  let user_id = Uuid::new_v4();
  insert_doc_fixture(&pool, workspace_id, doc_id, user_id).await;

  let update = yjs::create_initial_workspace_doc("pdf export current state");
  sqlx::query("INSERT INTO doc_updates (workspace_id, doc_id, payload, sequence) VALUES ($1, $2, $3, 1)")
    .bind(workspace_id)
    .bind(doc_id)
    .bind(update.clone())
    .execute(&pool)
    .await
    .expect("insert pending update");

  let loaded = myoxus_worker::pdf_pipeline::load_doc_binary(&doc_service(&pool), workspace_id, doc_id)
    .await
    .expect("load doc binary");
  let expected = yjs::merge_updates(vec![update]).expect("merge expected update");

  assert_eq!(
    loaded, expected,
    "PDF export must render pending doc_updates even before doc_snapshots compaction creates a row"
  );

  cleanup_fixture(&pool, workspace_id, user_id).await;
}

#[tokio::test]
async fn inv_pdf_pipeline_load_02_ignores_updates_at_or_below_snapshot_sequence() {
  let pool = test_pool().await;
  let workspace_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  let user_id = Uuid::new_v4();
  insert_doc_fixture(&pool, workspace_id, doc_id, user_id).await;

  let snapshot = yjs::create_initial_workspace_doc("pdf export compacted state");
  let pending = yjs::create_initial_workspace_doc("pdf export pending state");
  sqlx::query("INSERT INTO doc_snapshots (workspace_id, doc_id, payload, last_sequence) VALUES ($1, $2, $3, 1)")
    .bind(workspace_id)
    .bind(doc_id)
    .bind(snapshot.clone())
    .execute(&pool)
    .await
    .expect("insert snapshot");
  sqlx::query(
    "INSERT INTO doc_updates (workspace_id, doc_id, payload, sequence) VALUES ($1, $2, $3, 1), ($1, $2, $4, 2)",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(snapshot.clone())
  .bind(pending.clone())
  .execute(&pool)
  .await
  .expect("insert updates");

  let loaded = myoxus_worker::pdf_pipeline::load_doc_binary(&doc_service(&pool), workspace_id, doc_id)
    .await
    .expect("load doc binary");
  let expected = yjs::merge_updates(vec![snapshot, pending]).expect("merge snapshot plus pending update");

  assert_eq!(
    loaded, expected,
    "PDF export must merge only updates above doc_snapshots.last_sequence"
  );

  cleanup_fixture(&pool, workspace_id, user_id).await;
}
