//! P102-VIEW-05 — Invariant tests: consolidated view tracking via DocLoadService.
//!
//! These tests verify that view tracking (P73-C) works correctly across all
//! call sites now that it is centralised in `DocLoadService::load_full_doc_with_tracking`
//! and `DocLoadService::fire_view_tracking` (P102-VIEW-01).
//!
//! Invariants tested:
//!   INV-P102-V01: REST GET /rpc/.../docs/{doc} records a view in workspace_doc_view_daily.
//!   INV-P102-V02: is_workspace_space=false → no view row written (userspace guard, P96-F1).
//!   INV-P102-V03: Two loads with same (user, ws, doc, day) → exactly 1 unique_view row.
//!   INV-P102-V04: WebSocket-path load (load_full_doc_with_tracking) records a view.
//!   INV-P102-V05: fire_view_tracking (MCP path) writes a view row asynchronously.
//!   INV-P102-V06: User not in workspace membership → guest_views incremented.
//!   INV-P102-V07: Content endpoint GET /rpc/.../docs/{doc}/content records a view.

use crate::helpers;

use axum::{body::Body, http::Request};
use myoxus_application::doc::{DOC_VIEW_DEDUP, DocLoadService};
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use sqlx::Row;
use std::sync::Arc;
use tokio::time::Duration;
use tower::ServiceExt;

// ─── Polling helper ──────────────────────────────────────────────────────────

/// Poll `workspace_doc_view_daily` until a row appears for the given (ws, doc)
/// pair, or panic after `timeout_ms` milliseconds.
///
/// Fire-and-forget view tracking runs in a spawned task — this replaces
/// `tokio::time::sleep` with deterministic polling so tests are not flaky
/// under load.
async fn poll_view_row(
  pool: &sqlx::PgPool,
  ws_id: uuid::Uuid,
  doc_id_str: &str,
  timeout_ms: u64,
) -> sqlx::postgres::PgRow {
  let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
  loop {
    if let Some(row) = sqlx::query(
      "SELECT total_views, unique_views, guest_views FROM workspace_doc_view_daily WHERE workspace_id = $1 AND doc_id = $2",
    )
    .bind(ws_id)
    .bind(doc_id_str)
    .fetch_optional(pool)
    .await
    .expect("poll_view_row: query must not fail")
    {
      return row;
    }
    assert!(
      tokio::time::Instant::now() < deadline,
      "poll_view_row: no row in workspace_doc_view_daily for ws={ws_id} doc={doc_id_str} within {timeout_ms}ms"
    );
    tokio::time::sleep(Duration::from_millis(25)).await;
  }
}

/// Seed a minimal doc_snapshot so the doc is loadable (exists=true).
async fn seed_snapshot(pool: &sqlx::PgPool, ws_id: uuid::Uuid, doc_id: uuid::Uuid) {
  let placeholder: Vec<u8> = vec![0u8; 4];
  sqlx::query("INSERT INTO doc_snapshots (workspace_id, doc_id, payload, last_sequence, updated_at) VALUES ($1, $2, $3, 0, now()) ON CONFLICT (doc_id) DO NOTHING")
    .bind(ws_id).bind(doc_id).bind(&placeholder)
    .execute(pool).await.expect("seed snapshot");
}

// ─── INV-P102-V01 ────────────────────────────────────────────────────────────

/// INV-P102-V01: A REST GET doc load must write a view row to workspace_doc_view_daily.
#[tokio::test]
async fn inv_p102_view_01_rest_load_tracks_view() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "rv01").await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
  let cookie = format!("affine_session={session_id}");

  seed_snapshot(&pool, ws_id, doc_id).await;

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/rpc/workspaces/{ws_id}/docs/{doc_id}"))
        .header("cookie", &cookie)
        .body(Body::empty())
        .expect("build request"),
    )
    .await
    .expect("response");
  let status = resp.status().as_u16();
  assert!(status < 500, "REST doc load must not 5xx, got {status}");

  // Poll until the fire-and-forget tracking task has written the view row.
  let row = poll_view_row(&pool, ws_id, &doc_id.to_string(), 2000).await;
  let total_views: i64 = row.get("total_views");
  assert!(
    total_views >= 1,
    "INV-P102-V01: total_views must be >= 1 after REST load, got {total_views}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ─── INV-P102-V02 ────────────────────────────────────────────────────────────

/// INV-P102-V02: load_full_doc_with_tracking with is_workspace_space=false must not write
/// any view row (userspace guard, P96-F1).
#[tokio::test]
async fn inv_p102_view_02_userspace_no_tracking() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let ws_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let workspace_service = WorkspaceService::new(ws_store);
  let load_svc = DocLoadService::new(doc_store.clone());

  let user_id = helpers::create_user(&pool, "rv02", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;

  seed_snapshot(&pool, ws_id, doc_id).await;

  // is_workspace_space = false → tracking must be skipped
  let _result = load_svc
    .load_full_doc_with_tracking(ws_id, doc_id, user_id, false, workspace_service)
    .await
    .expect("load_full_doc_with_tracking must succeed");

  // Negative assertion: wait briefly then confirm no row was written.
  // For negative checks, a short sleep is unavoidable — there is no event to poll for.
  tokio::time::sleep(Duration::from_millis(200)).await;

  let count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM workspace_doc_view_daily WHERE workspace_id = $1 AND doc_id = $2")
      .bind(ws_id)
      .bind(doc_id.to_string())
      .fetch_one(&pool)
      .await
      .expect("count query");

  assert_eq!(
    count, 0,
    "INV-P102-V02: userspace load must not write to workspace_doc_view_daily, got {count}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ─── INV-P102-V03 ────────────────────────────────────────────────────────────

/// INV-P102-V03: Two loads with same (user, workspace, doc, day) → exactly 1 unique_view.
#[tokio::test]
async fn inv_p102_view_03_dedup_within_day() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let ws_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let workspace_service = WorkspaceService::new(ws_store);
  let load_svc = DocLoadService::new(doc_store.clone());

  let user_id = helpers::create_user(&pool, "rv03", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;

  seed_snapshot(&pool, ws_id, doc_id).await;

  // Pre-clear dedup key to ensure a clean slate for this test.
  let today = chrono::Utc::now().date_naive();
  let key = (user_id, ws_id, doc_id.to_string(), today);
  DOC_VIEW_DEDUP.remove(&key);

  // First load → dedup key absent → is_unique=true.
  load_svc
    .load_full_doc_with_tracking(ws_id, doc_id, user_id, true, workspace_service.clone())
    .await
    .expect("first load");

  // Second load — same key already in dedup set → is_unique=false.
  load_svc
    .load_full_doc_with_tracking(ws_id, doc_id, user_id, true, workspace_service.clone())
    .await
    .expect("second load");

  // Poll until both views are recorded (total_views == 2).
  let deadline = tokio::time::Instant::now() + Duration::from_millis(2000);
  let row = loop {
    let row = poll_view_row(&pool, ws_id, &doc_id.to_string(), 2000).await;
    let total: i64 = row.get("total_views");
    if total >= 2 {
      break row;
    }
    assert!(
      tokio::time::Instant::now() < deadline,
      "INV-P102-V03: total_views did not reach 2 within timeout"
    );
    tokio::time::sleep(Duration::from_millis(25)).await;
  };

  let unique: i64 = row.get("unique_views");
  let total: i64 = row.get("total_views");

  assert_eq!(
    unique, 1,
    "INV-P102-V03: dedup must yield exactly 1 unique_view for repeated same-day loads, got {unique}"
  );
  assert_eq!(
    total, 2,
    "INV-P102-V03: total_views must be 2 for two loads, got {total}"
  );

  // Cleanup dedup key.
  DOC_VIEW_DEDUP.remove(&(user_id, ws_id, doc_id.to_string(), today));
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ─── INV-P102-V04 ────────────────────────────────────────────────────────────

/// INV-P102-V04: WebSocket-path doc load (load_full_doc_with_tracking) records a view row.
///
/// The WebSocket sync handler calls `load_full_doc_with_tracking` directly, not through
/// the REST handler. This test verifies that the service-level call alone is sufficient
/// to guarantee a view is recorded — confirming the WS code path is covered.
#[tokio::test]
async fn inv_p102_view_04_websocket_path_tracks_view() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let ws_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let workspace_service = WorkspaceService::new(ws_store);
  let load_svc = DocLoadService::new(doc_store.clone());

  let user_id = helpers::create_user(&pool, "rv04", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;

  seed_snapshot(&pool, ws_id, doc_id).await;

  // Simulate the WebSocket handler path — direct service call, is_workspace_space=true.
  let today = chrono::Utc::now().date_naive();
  DOC_VIEW_DEDUP.remove(&(user_id, ws_id, doc_id.to_string(), today));
  load_svc
    .load_full_doc_with_tracking(ws_id, doc_id, user_id, true, workspace_service)
    .await
    .expect("ws-path load");

  let row = poll_view_row(&pool, ws_id, &doc_id.to_string(), 2000).await;
  let total: i64 = row.get("total_views");
  assert!(
    total >= 1,
    "INV-P102-V04: WS-path load must write a view row, got {total}"
  );

  DOC_VIEW_DEDUP.remove(&(user_id, ws_id, doc_id.to_string(), today));
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ─── INV-P102-V05 ────────────────────────────────────────────────────────────

/// INV-P102-V05: fire_view_tracking (MCP path) writes a view row asynchronously.
///
/// MCP `read_doc` does not call `load_full_doc_with_tracking` — it calls the
/// lower-level `get_snapshot` directly, then calls `fire_view_tracking` to record
/// the view in a separate task. This test verifies that fire_view_tracking alone
/// is sufficient to produce a workspace_doc_view_daily row.
#[tokio::test]
async fn inv_p102_view_05_mcp_fire_view_tracking() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let ws_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let workspace_service = WorkspaceService::new(ws_store);
  let load_svc = DocLoadService::new(doc_store.clone());

  let user_id = helpers::create_user(&pool, "rv05", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;

  let today = chrono::Utc::now().date_naive();
  DOC_VIEW_DEDUP.remove(&(user_id, ws_id, doc_id.to_string(), today));

  // Simulate the MCP path — fire-and-forget, no await.
  load_svc.fire_view_tracking(ws_id, doc_id, user_id, true, workspace_service);

  // Poll until the spawned task writes the row.
  let row = poll_view_row(&pool, ws_id, &doc_id.to_string(), 2000).await;
  let total: i64 = row.get("total_views");
  assert!(
    total >= 1,
    "INV-P102-V05: fire_view_tracking must produce a view row, got {total}"
  );

  DOC_VIEW_DEDUP.remove(&(user_id, ws_id, doc_id.to_string(), today));
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ─── INV-P102-V06 ────────────────────────────────────────────────────────────

/// INV-P102-V06: Guest detection — user not in workspace membership → guest_views incremented.
///
/// When a user accesses a workspace doc but has no membership record (e.g. a public
/// workspace or shared link), the view row must have guest_views > 0.
#[tokio::test]
async fn inv_p102_view_06_guest_detection() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let ws_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let workspace_service = WorkspaceService::new(ws_store);
  let load_svc = DocLoadService::new(doc_store.clone());

  let owner_id = helpers::create_user(&pool, "rv06owner", false).await;
  let guest_id = helpers::create_user(&pool, "rv06guest", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  seed_snapshot(&pool, ws_id, doc_id).await;

  let today = chrono::Utc::now().date_naive();
  DOC_VIEW_DEDUP.remove(&(guest_id, ws_id, doc_id.to_string(), today));

  // guest_id is not in workspace_memberships → workspace_service.get_member returns None.
  load_svc
    .load_full_doc_with_tracking(ws_id, doc_id, guest_id, true, workspace_service)
    .await
    .expect("guest load");

  let row = poll_view_row(&pool, ws_id, &doc_id.to_string(), 2000).await;
  let guest_views: i64 = row.get("guest_views");
  assert!(
    guest_views >= 1,
    "INV-P102-V06: guest user load must increment guest_views, got {guest_views}"
  );

  DOC_VIEW_DEDUP.remove(&(guest_id, ws_id, doc_id.to_string(), today));
  helpers::cleanup_users(&pool, &[owner_id, guest_id]).await;
}

// ─── INV-P102-V07 ────────────────────────────────────────────────────────────

/// INV-P102-V07: Content endpoint GET /rpc/.../docs/{doc}/content records a view.
///
/// The content endpoint is used by server-to-server consumers (renderer, AI).
/// These accesses must be recorded in workspace_doc_view_daily (P102-VIEW-07).
#[tokio::test]
async fn inv_p102_view_07_content_endpoint_tracks_view() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "rv07").await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
  let cookie = format!("affine_session={session_id}");

  // seed docs row with a title + search_content row so content endpoint returns 200
  sqlx::query("UPDATE docs SET title = 'Test Doc' WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("set title");
  sqlx::query("INSERT INTO search_content (workspace_id, doc_id, plain_text) VALUES ($1, $2, 'hello world') ON CONFLICT (workspace_id, doc_id) DO UPDATE SET plain_text = EXCLUDED.plain_text")
    .bind(ws_id).bind(doc_id).execute(&pool).await.expect("search doc");

  let today = chrono::Utc::now().date_naive();
  DOC_VIEW_DEDUP.remove(&(user_id, ws_id, doc_id.to_string(), today));

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/rpc/workspaces/{ws_id}/docs/{doc_id}/content"))
        .header("cookie", &cookie)
        .body(Body::empty())
        .expect("build request"),
    )
    .await
    .expect("response");
  let status = resp.status().as_u16();
  assert!(status < 500, "content endpoint must not 5xx, got {status}");

  let row = poll_view_row(&pool, ws_id, &doc_id.to_string(), 2000).await;
  let total: i64 = row.get("total_views");
  assert!(
    total >= 1,
    "INV-P102-V07: total_views must be >= 1 after content load, got {total}"
  );

  DOC_VIEW_DEDUP.remove(&(user_id, ws_id, doc_id.to_string(), today));
  helpers::cleanup_users(&pool, &[user_id]).await;
}
