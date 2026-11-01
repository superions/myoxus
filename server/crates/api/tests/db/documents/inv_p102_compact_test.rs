//! P102-TRASH-04 — Invariant tests for the CLI compact-doc operation.
//!
//! Invariants verified:
//!   INV-COMPACT-01 — merge_pending_updates creates a snapshot and removes pending updates
//!   INV-COMPACT-02 — dry-run (min_updates > actual) does not create a snapshot
//!
//! The CLI `compact-doc` delegates to `DocService::merge_pending_updates`, so
//! testing that method directly verifies the full compaction path.

use crate::helpers;

use myoxus_application::doc::{DocService, DocSpaceKind};
use myoxus_infrastructure::doc::SqlxDocStore;
use std::sync::Arc;
use uuid::Uuid;

async fn make_svc(pool: &sqlx::PgPool) -> DocService {
  DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
}

async fn cleanup(pool: &sqlx::PgPool, ws_id: Uuid, doc_id: Uuid, user_id: Uuid) {
  sqlx::query("DELETE FROM doc_snapshots WHERE doc_id IN ($1, $2)")
    .bind(ws_id)
    .bind(doc_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM doc_updates WHERE workspace_id = $1")
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
// INV-COMPACT-01 — merge_pending_updates snapshots without losing broadcasts
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_compact_01_compact_creates_snapshot() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "compact01", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
  let svc = make_svc(&pool).await;

  // Push 3 updates so there are pending updates to compact.
  for i in 1..=3i64 {
    svc
      .push_update(ws_id, doc_id, vec![0u8, 0u8], i, DocSpaceKind::Workspace)
      .await
      .expect("push");
  }

  // Pre-condition: updates exist, no snapshot yet.
  let update_count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count before");
  assert!(update_count_before >= 3, "pre-condition: at least 3 updates must exist");

  // INV-COMPACT-01: compact with min_updates=1 must merge all updates into a snapshot.
  let merged = svc
    .merge_pending_updates(ws_id, doc_id, 1)
    .await
    .expect("merge_pending_updates must succeed");

  assert!(
    merged >= 3,
    "INV-COMPACT-01: must report ≥3 merged updates, got {merged}"
  );

  // After compaction: snapshot must exist.
  let snapshot_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM doc_snapshots WHERE doc_id = $1)")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("snapshot check");
  assert!(
    snapshot_exists,
    "INV-COMPACT-01: doc_snapshots must have an entry after compaction"
  );

  // Updates covered by unprocessed realtime outbox events must remain until
  // delivery. Removing them here would make a committed write disappear from
  // another connected client merely because compaction won the race.
  let update_count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count after");
  assert_eq!(
    update_count_after, update_count_before,
    "INV-COMPACT-01: compaction must retain updates awaiting realtime delivery"
  );
  let protected_broadcasts: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM outbox_events
     WHERE aggregate_id = $1::text
       AND event_type = 'workspace_doc_broadcast'
       AND processed_at IS NULL",
  )
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("pending broadcast count");
  assert_eq!(
    protected_broadcasts, update_count_after,
    "every retained update must be protected by a pending realtime broadcast"
  );

  cleanup(&pool, ws_id, doc_id, user_id).await;
}

// ---------------------------------------------------------------------------
// INV-COMPACT-02 — min_updates guard: no compaction when threshold not met
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_compact_02_min_updates_guard_prevents_compaction() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "compact02", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
  let svc = make_svc(&pool).await;

  // Push 2 updates.
  for i in 1..=2i64 {
    svc
      .push_update(ws_id, doc_id, vec![0u8, 0u8], i, DocSpaceKind::Workspace)
      .await
      .expect("push");
  }

  // Call with min_updates=10 — should NOT compact (only 2 updates < 10).
  let merged = svc
    .merge_pending_updates(ws_id, doc_id, 10)
    .await
    .expect("merge_pending_updates must not error");

  assert_eq!(
    merged, 0,
    "INV-COMPACT-02: must return 0 when update count < min_updates"
  );

  // No snapshot should have been written.
  let snapshot_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM doc_snapshots WHERE doc_id = $1)")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("snapshot check");
  assert!(
    !snapshot_exists,
    "INV-COMPACT-02: no snapshot must be written when min_updates guard fires"
  );

  cleanup(&pool, ws_id, doc_id, user_id).await;
}
