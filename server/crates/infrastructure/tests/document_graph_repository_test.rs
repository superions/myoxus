// SPDX-License-Identifier: AGPL-3.0-or-later

use myoxus_domain::document_graph::DocumentGraphReindexReason;
use myoxus_domain::repositories::DocumentGraphRepository;
use myoxus_infrastructure::document_graph::PgDocumentGraphRepository;
use sqlx::PgPool;
use uuid::Uuid;

async fn setup_pool() -> PgPool {
  let database_url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  let pool = PgPool::connect(&database_url)
    .await
    .expect("test postgres must be reachable");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("document graph migrations must apply");
  pool
}

#[tokio::test]
async fn graph_state_writes_are_idempotent_across_soft_and_hard_delete() {
  let pool = setup_pool().await;
  let repo = PgDocumentGraphRepository::new(pool.clone());
  let owner_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let live_doc_id = Uuid::new_v4();
  let soft_deleted_doc_id = Uuid::new_v4();

  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'Graph owner', 'active')")
    .bind(owner_id)
    .bind(format!("document-graph-{owner_id}@example.test"))
    .execute(&pool)
    .await
    .expect("seed graph owner");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'Graph workspace')")
    .bind(workspace_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("seed graph workspace");
  for doc_id in [live_doc_id, soft_deleted_doc_id] {
    sqlx::query(
      "INSERT INTO docs (id, workspace_id, title, created_at, updated_at) VALUES ($1, $2, 'Graph doc', now(), now())",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("seed graph document");
  }

  repo
    .mark_doc_graph_stale(workspace_id, live_doc_id, DocumentGraphReindexReason::DocUpdated)
    .await
    .expect("live document accepts graph state");
  let live_state: Option<String> =
    sqlx::query_scalar("SELECT stale_state FROM document_graph_index_state WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(live_doc_id)
      .fetch_optional(&pool)
      .await
      .expect("read live graph state");
  assert_eq!(live_state.as_deref(), Some("stale"));

  sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
    .bind(soft_deleted_doc_id)
    .execute(&pool)
    .await
    .expect("soft-delete graph document");
  repo
    .mark_doc_graph_deleted(workspace_id, soft_deleted_doc_id)
    .await
    .expect("soft-deleted document keeps a deleted graph marker");
  let soft_deleted_state: Option<String> =
    sqlx::query_scalar("SELECT stale_state FROM document_graph_index_state WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(soft_deleted_doc_id)
      .fetch_optional(&pool)
      .await
      .expect("read soft-deleted graph state");
  assert_eq!(soft_deleted_state.as_deref(), Some("deleted"));

  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(live_doc_id)
    .execute(&pool)
    .await
    .expect("hard-delete graph document");
  repo
    .mark_doc_graph_extracting(workspace_id, live_doc_id)
    .await
    .expect("late extracting state is an idempotent no-op");
  repo
    .mark_doc_graph_failed(workspace_id, live_doc_id, "MIX_GRAPH_QUERY_INVALID", "late failure")
    .await
    .expect("late failure state is an idempotent no-op");
  repo
    .mark_doc_graph_deleted(workspace_id, live_doc_id)
    .await
    .expect("late deleted state is an idempotent no-op");
  let hard_deleted_state_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*)::BIGINT FROM document_graph_index_state WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(workspace_id)
  .bind(live_doc_id)
  .fetch_one(&pool)
  .await
  .expect("count hard-deleted graph state");
  assert_eq!(hard_deleted_state_count, 0);

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("cleanup graph workspace");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("cleanup graph owner");
}
