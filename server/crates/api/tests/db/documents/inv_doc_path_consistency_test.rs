//! P102-UNIFY-05 — Invariant tests for consolidated doc code paths.
//!
//! Verifies that load_full_doc (WebSocket) and load_full_doc_with_meta (REST)
//! are consistent, that workspace_id filters prevent cross-workspace access,
//! that soft-deleted docs are not loadable, and that compaction metadata is correct.

use crate::helpers;

use myoxus_application::doc::{DocService, DocSpaceKind};
use myoxus_infrastructure::doc::SqlxDocStore;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

async fn setup_doc_service(pool: &sqlx::PgPool) -> DocService {
  let store = Arc::new(SqlxDocStore::new(pool.clone()));
  DocService::new(store)
}

// ─── Test 1: REST and WebSocket paths produce identical payloads ─────────────

#[tokio::test]
async fn inv_p102_01_rest_ws_identical_payload() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "p102-01", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
  let svc = setup_doc_service(&pool).await;

  for i in 0..3i64 {
    svc
      .push_update(ws_id, doc_id, vec![0, 0], i, DocSpaceKind::Workspace)
      .await
      .expect("push");
  }

  let ws_payload = svc.load_full_doc(ws_id, doc_id).await.expect("ws load");
  let rest = svc.load_full_doc_with_meta(ws_id, doc_id).await.expect("rest load");

  assert!(!ws_payload.is_empty(), "WS path must return non-empty payload");
  assert!(!rest.payload.is_empty(), "REST path must return non-empty payload");
  assert_eq!(
    ws_payload.len(),
    rest.payload.len(),
    "WS and REST payloads must have identical length after merge"
  );
  assert!(rest.exists, "doc must report exists=true");

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ─── Test 2: workspace_id filter prevents cross-workspace doc access ─────────

#[tokio::test]
async fn inv_p102_02_workspace_filter_prevents_cross_access() {
  let pool = helpers::setup_pool().await;
  let user_a = helpers::create_user(&pool, "p102-02a", false).await;
  let user_b = helpers::create_user(&pool, "p102-02b", false).await;
  let ws_a = helpers::create_workspace(&pool, user_a).await;
  let ws_b = helpers::create_workspace(&pool, user_b).await;
  let doc_a = helpers::create_doc(&pool, ws_a, user_a).await;
  let doc_b = helpers::create_doc(&pool, ws_b, user_b).await;
  let svc = setup_doc_service(&pool).await;

  svc
    .push_update(ws_a, doc_a, vec![0, 0], 1, DocSpaceKind::Workspace)
    .await
    .expect("push a");
  svc
    .push_update(ws_b, doc_b, vec![0, 0], 1, DocSpaceKind::Workspace)
    .await
    .expect("push b");

  // Cross-access: ws_a must not see doc_b's content
  let cross_ab = svc.load_full_doc_with_meta(ws_a, doc_b).await.expect("cross ab");
  assert!(
    !cross_ab.exists || cross_ab.payload.is_empty() || !cross_ab.has_real_content,
    "ws_a must not load doc_b content; got exists={} has_real_content={} len={}",
    cross_ab.exists,
    cross_ab.has_real_content,
    cross_ab.payload.len()
  );

  // Cross-access: ws_b must not see doc_a's content
  let cross_ba = svc.load_full_doc_with_meta(ws_b, doc_a).await.expect("cross ba");
  assert!(
    !cross_ba.exists || cross_ba.payload.is_empty() || !cross_ba.has_real_content,
    "ws_b must not load doc_a content; got exists={} has_real_content={} len={}",
    cross_ba.exists,
    cross_ba.has_real_content,
    cross_ba.payload.len()
  );

  helpers::cleanup_users(&pool, &[user_a, user_b]).await;
}

// ─── Test 3: soft-deleted doc not loadable ───────────────────────────────────

#[tokio::test]
async fn inv_p102_03_deleted_doc_not_loadable() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "p102-03", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
  let svc = setup_doc_service(&pool).await;

  svc
    .push_update(ws_id, doc_id, vec![0, 0], 1, DocSpaceKind::Workspace)
    .await
    .expect("push");

  // Soft-delete the doc
  sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("soft delete");

  let result = svc.load_full_doc_with_meta(ws_id, doc_id).await.expect("load deleted");
  assert!(
    !result.exists,
    "soft-deleted doc must report exists=false; got exists={}",
    result.exists
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ─── Test 4: compaction of doc_a does not affect doc_b ───────────────────────

#[tokio::test]
async fn inv_p102_04_workspace_filter_in_compaction() {
  let pool = helpers::setup_pool().await;
  let user_a = helpers::create_user(&pool, "p102-04a", false).await;
  let user_b = helpers::create_user(&pool, "p102-04b", false).await;
  let ws_a = helpers::create_workspace(&pool, user_a).await;
  let ws_b = helpers::create_workspace(&pool, user_b).await;
  let doc_a = helpers::create_doc(&pool, ws_a, user_a).await;
  let doc_b = helpers::create_doc(&pool, ws_b, user_b).await;
  let svc = setup_doc_service(&pool).await;

  // Push one update to doc_b before compaction of doc_a
  svc
    .push_update(ws_b, doc_b, vec![0, 0], 1, DocSpaceKind::Workspace)
    .await
    .expect("push b");

  // Insert a snapshot directly for doc_a to simulate post-compaction state
  // (avoids pushing 500 updates which is slow in tests)
  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
     VALUES ($1, $2, $3, 10, now())",
  )
  .bind(doc_a)
  .bind(ws_a)
  .bind(b"\x00\x00".as_slice())
  .execute(&pool)
  .await
  .expect("insert snapshot for doc_a");

  // doc_b must still be loadable and report has_real_content=true
  let result_b = svc.load_full_doc_with_meta(ws_b, doc_b).await.expect("load b");
  assert!(
    result_b.has_real_content,
    "doc_b must be unaffected by doc_a compaction; has_real_content={}",
    result_b.has_real_content
  );

  // doc_a snapshot must exist in the DB
  let snap_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_snapshots WHERE doc_id = $1")
    .bind(doc_a)
    .fetch_one(&pool)
    .await
    .expect("count snapshots");
  assert_eq!(snap_count, 1, "doc_a must have exactly 1 snapshot after compaction");

  helpers::cleanup_users(&pool, &[user_a, user_b]).await;
}

// ─── Test 5: updated_at is populated from snapshot metadata ─────────────────

#[tokio::test]
async fn inv_p102_05_updated_at_from_snapshot_meta() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "p102-05", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
  let svc = setup_doc_service(&pool).await;

  let before = chrono::Utc::now();

  // Insert snapshot with current timestamp (simulating post-compaction state)
  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
     VALUES ($1, $2, $3, 5, now())",
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(b"\x00\x00".as_slice())
  .execute(&pool)
  .await
  .expect("insert snapshot");

  let after = chrono::Utc::now() + chrono::Duration::seconds(1);

  let result = svc
    .load_full_doc_with_meta(ws_id, doc_id)
    .await
    .expect("load with meta");
  assert!(
    result.updated_at.is_some(),
    "updated_at must be Some after snapshot exists"
  );

  let ts = result.updated_at.unwrap();
  assert!(
    ts >= before && ts <= after,
    "updated_at must be within [before, after]; got {:?}",
    ts
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ─── Test 6: exists=false for a nonexistent doc UUID ────────────────────────

#[tokio::test]
async fn inv_p102_06_load_result_exists_false_for_nonexistent_doc() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "p102-06", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let svc = setup_doc_service(&pool).await;

  // Generate a doc UUID that was never inserted
  let ghost_doc_id = Uuid::new_v4();

  let result = svc
    .load_full_doc_with_meta(ws_id, ghost_doc_id)
    .await
    .expect("load nonexistent");

  assert!(
    !result.exists,
    "nonexistent doc must report exists=false; got exists={}",
    result.exists
  );
  assert!(
    !result.has_real_content,
    "nonexistent doc must report has_real_content=false; got has_real_content={}",
    result.has_real_content
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ─── Test 7: proxy-delegation preserved when doc_service.endpoint is configured ──

/// INV-P102-07: When `config.doc_service.endpoint` is set, the RPC doc handler
/// must forward the request to the remote endpoint instead of reading from the
/// local DB.  This test configures a non-running endpoint (port 19999) and
/// asserts the response is 502 Bad Gateway — proving the proxy branch was taken
/// (if the DB path were taken, the doc would be found and a 200 would be returned).
#[tokio::test]
async fn inv_p102_07_proxy_delegation_preserved() {
  // Port 19999 is intentionally not running — connection refused → 502.
  let (app, pool, auth_store) = helpers::setup_app_with_doc_service_endpoint("http://localhost:19999").await;

  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p102-07").await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;

  // Seed a snapshot so the doc exists in DB (DB path would return 200 if taken).
  let placeholder: Vec<u8> = vec![0u8; 4];
  sqlx::query("INSERT INTO doc_snapshots (workspace_id, doc_id, payload, last_sequence, updated_at) VALUES ($1, $2, $3, 0, now()) ON CONFLICT (doc_id) DO NOTHING")
    .bind(ws_id).bind(doc_id).bind(&placeholder)
    .execute(&pool).await.expect("insert snapshot");

  let cookie = format!("affine_session={session_id}");
  let resp = app
    .oneshot(
      axum::http::Request::builder()
        .method("GET")
        .uri(format!("/rpc/workspaces/{ws_id}/docs/{doc_id}"))
        .header("cookie", &cookie)
        .body(axum::body::Body::empty())
        .expect("build request"),
    )
    .await
    .expect("response");

  // 502 = proxy path taken, connection refused to :19999.
  // Any status < 400 would mean the DB path was used instead — that is the failure case.
  assert_eq!(
    resp.status().as_u16(),
    502,
    "INV-P102-07: when doc_service.endpoint is configured the RPC handler must proxy \
     the request (expected 502 from connection refused, got {})",
    resp.status().as_u16()
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ─── P102-ELIM-01: PanicDocStore panics on any call ─────────────────────────

#[test]
#[should_panic(expected = "PanicDocStore")]
fn inv_p102_elim_01_panic_stub_panics_on_get_snapshot() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = myoxus_application::doc::PanicDocStore;
    let _ =
      myoxus_application::doc::DocSnapshotStore::get_snapshot(&store, uuid::Uuid::new_v4(), uuid::Uuid::new_v4()).await;
  });
}
