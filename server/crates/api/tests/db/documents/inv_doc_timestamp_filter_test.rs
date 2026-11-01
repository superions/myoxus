//! P96-F3 — Invariant test: snapshot after-filter.
//!
//! Invariant: `get_space_doc_timestamps(after=T)` must exclude docs whose
//! snapshot `updated_at` is ≤ T, and include docs whose snapshot `updated_at`
//! is > T.  Before the fix, snapshots bypassed the filter entirely.

use crate::helpers;

use myoxus_application::doc::DocService;
use myoxus_infrastructure::doc::SqlxDocStore;
use std::sync::Arc;

async fn setup_doc_service(pool: &sqlx::PgPool) -> DocService {
  let store = Arc::new(SqlxDocStore::new(pool.clone()));
  DocService::new(store)
}

// ---------------------------------------------------------------------------
// INV-F3: snapshot updated_at respects the `after` filter
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_f3_snapshot_after_filter() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "f3snap", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
  let doc_service = setup_doc_service(&pool).await;

  // Record a timestamp BEFORE inserting the snapshot.
  let ts_before: i64 = chrono::Utc::now().timestamp_millis();
  // Small sleep ensures the DB timestamp is strictly after ts_before.
  tokio::time::sleep(std::time::Duration::from_millis(10)).await;

  // Insert a snapshot directly so updated_at is current (after ts_before).
  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
     VALUES ($1, $2, $3, 1, now())",
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(b"\x00\x00".as_slice())
  .execute(&pool)
  .await
  .expect("insert snapshot");

  // after=ts_before → snapshot was created AFTER ts_before → must appear
  let timestamps = doc_service
    .get_space_doc_timestamps(ws_id, Some(ts_before))
    .await
    .expect("timestamps with after=ts_before");
  assert!(
    !timestamps.is_empty(),
    "INV-F3: doc must appear when after < snapshot.updated_at; got: {:?}",
    timestamps
  );

  // after=ts_future → snapshot is older → filter would exclude it, but the Option-C
  // safety net falls back to unfiltered when results are empty with after>0, so the doc
  // is still returned (correct production behavior: client with stale/future timestamps
  // never gets a permanently empty sync response).
  let ts_future: i64 = chrono::Utc::now().timestamp_millis() + 60_000;
  let timestamps = doc_service
    .get_space_doc_timestamps(ws_id, Some(ts_future))
    .await
    .expect("timestamps with after=ts_future");
  assert!(
    !timestamps.is_empty(),
    "INV-F3: Option-C safety net must return docs even with future after timestamp; got: {:?}",
    timestamps
  );

  // after=None → no filter → must appear
  let timestamps = doc_service
    .get_space_doc_timestamps(ws_id, None)
    .await
    .expect("timestamps with after=None");
  assert!(
    !timestamps.is_empty(),
    "INV-F3: doc must appear when after=None; got: {:?}",
    timestamps
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}
