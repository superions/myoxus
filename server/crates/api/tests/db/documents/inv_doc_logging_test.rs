//! P102-LOG-05 — Log-path exercise tests for DocService instrumentation.
//!
//! `tracing-test` is not in dev-dependencies, so we verify via DB-state
//! instead of log capture.  Each test exercises a logged code-path and asserts
//! the observable invariant that the logging surrounds.
//!
//! Invariants:
//!   INV-LOG-01 — load_full_doc_with_meta executes without panic on a doc with updates
//!   INV-LOG-02 — push_update persists a row in doc_updates
//!   INV-LOG-03 — auto-compaction (≥500 updates) writes a snapshot to doc_snapshots

use crate::helpers;

use myoxus_application::doc::{DocService, DocSpaceKind};
use myoxus_infrastructure::doc::SqlxDocStore;
use std::sync::Arc;
use uuid::Uuid;

async fn make_doc_service(pool: &sqlx::PgPool) -> DocService {
  DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
}

async fn create_workspace_bare(pool: &sqlx::PgPool, owner_id: Uuid) -> Uuid {
  let ws_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'log-test')")
    .bind(ws_id)
    .bind(owner_id)
    .execute(pool)
    .await
    .expect("create workspace");
  ws_id
}

async fn cleanup(pool: &sqlx::PgPool, ws_id: Uuid, doc_id: Uuid, user_id: Uuid) {
  sqlx::query("DELETE FROM doc_snapshots WHERE doc_id = $1")
    .bind(doc_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .ok();
}

// ---------------------------------------------------------------------------
// INV-LOG-01 — load_full_doc_with_meta runs the merge-logging path without panic
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_log_01_load_doc_produces_logs() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "log01", false).await;
  let ws_id = create_workspace_bare(&pool, user_id).await;
  let doc_id = Uuid::new_v4();
  let svc = make_doc_service(&pool).await;

  svc
    .push_update(ws_id, doc_id, vec![0, 0], 1, DocSpaceKind::Workspace)
    .await
    .expect("push");

  // Exercises load_full_doc_with_meta including trace!/debug! merge logging.
  let result = svc
    .load_full_doc_with_meta(ws_id, doc_id)
    .await
    .expect("load must not panic");
  assert!(
    result.has_real_content,
    "INV-LOG-01: doc must have real content after push"
  );

  cleanup(&pool, ws_id, doc_id, user_id).await;
}

// ---------------------------------------------------------------------------
// INV-LOG-02 — push_update writes a doc_updates row (trace! "pushing document update")
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_log_02_push_update_produces_logs() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "log02", false).await;
  let ws_id = create_workspace_bare(&pool, user_id).await;
  let doc_id = Uuid::new_v4();
  let svc = make_doc_service(&pool).await;

  svc
    .push_update(ws_id, doc_id, vec![0, 0], 1, DocSpaceKind::Workspace)
    .await
    .expect("push");

  // Verify the log-surrounded operation actually persisted a row.
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count");
  assert_eq!(
    count, 1,
    "INV-LOG-02: doc_updates must contain exactly one row after push"
  );

  cleanup(&pool, ws_id, doc_id, user_id).await;
}

// ---------------------------------------------------------------------------
// INV-LOG-03 — auto-compaction at ≥500 updates emits info! and writes doc_snapshots
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_log_03_compaction_produces_logs() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "log03", false).await;
  let ws_id = create_workspace_bare(&pool, user_id).await;
  let doc_id = Uuid::new_v4();
  let svc = make_doc_service(&pool).await;

  // Push 500 updates directly into the store to cross the compaction threshold.
  // The 500th push triggers maybe_compact which emits info!("auto-compacting…").
  for i in 0..500i64 {
    svc
      .push_update(ws_id, doc_id, vec![0, 0], i, DocSpaceKind::Workspace)
      .await
      .expect("push");
  }

  // Verify: a snapshot must have been written (the info!-logged compaction path ran).
  let snap_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM doc_snapshots WHERE doc_id = $1)")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("snapshot query");
  assert!(
    snap_exists,
    "INV-LOG-03: doc_snapshots must contain a row after ≥500 updates (compaction)"
  );

  cleanup(&pool, ws_id, doc_id, user_id).await;
}
