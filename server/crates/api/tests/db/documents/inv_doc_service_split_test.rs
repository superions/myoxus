//! P102-SVC-06: Regression tests for the DocService split into 4 sub-services.
//!
//! Each test verifies a distinct invariant — NOT just that an endpoint is reachable,
//! but that DB state after operations matches documented invariants.
//!
//! Invariants tested:
//!   INV-P102-SVC-01: Facade load returns non-empty payload after an update is pushed.
//!   INV-P102-SVC-02: After 501 push_update calls the snapshot table is populated (auto-compaction ran).
//!   INV-P102-SVC-03: capture_history_snapshot + rollback_to_history creates a new update row.
//!   INV-P102-SVC-04: Direct sub-service access via state.doc().load.load_full_doc() works.
//!   INV-P102-SVC-05: load_full_doc honors doc_snapshots.last_sequence and does not replay compacted updates.
//!   INV-P102-SVC-06: get_snapshot merges pending updates after a compacted snapshot.

use crate::helpers;

use myoxus_api::{config::AppConfig, state::ApiState};
use myoxus_application::admin::AdminService;
use myoxus_application::auth::AuthService;
use myoxus_application::doc::{DocService, DocSpaceKind};
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::admin::SqlxAdminStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::blob::SqlxBlobStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::storage::StorageAdapter;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use sqlx::{PgPool, Row};
use std::sync::Arc;

/// Build a minimal ApiState backed by real Postgres stores (no router needed).
async fn setup_state(pool: PgPool) -> (Arc<ApiState>, PgPool) {
  let config = AppConfig::load().expect("config");
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("storage"));
  let mailer = Arc::new(myoxus_infrastructure::mail::LogMailAdapter);

  let auth_service = AuthService::new(
    auth_store.clone(),
    mailer,
    storage.clone(),
    config.server.session_ttl,
    config.server.session_ttr,
  );
  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);
  let blob_service = Arc::new(BlobService::new(blob_store, storage.clone(), "test-key".to_string()));

  let state = Arc::new(ApiState::with_services(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    blob_service,
    storage,
  ));
  (state, pool)
}

// ---------------------------------------------------------------------------
// INV-P102-SVC-01: Facade load returns non-empty payload after an update is pushed.
//
// After push_update via DocService facade, load_full_doc via the same facade must
// return a non-empty Vec<u8> (the stored binary Yjs update).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_svc_01_load_via_facade() {
  let pool = helpers::setup_pool().await;
  let (state, pool) = setup_state(pool).await;

  let owner_id = helpers::create_user(&pool, "svc01", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  // [0, 0] is a valid empty Yjs v1 update (see yrs::Update::default().encode_v1())
  let payload = vec![0u8, 0];
  state
    .doc()
    .push_update(ws_id, doc_id, payload.clone(), 0, DocSpaceKind::Workspace)
    .await
    .expect("INV-P102-SVC-01: push_update must succeed");

  let loaded = state
    .doc()
    .load_full_doc(ws_id, doc_id)
    .await
    .expect("INV-P102-SVC-01: load_full_doc must succeed");

  assert!(
    !loaded.is_empty(),
    "INV-P102-SVC-01: loaded payload must be non-empty after push_update"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// INV-P102-SVC-02: After 501 push_update calls, the snapshot table is populated.
//
// Compaction threshold is 500. After exceeding it, doc_snapshots must contain a
// row for the doc_id — proving DocCompactionService::maybe_compact ran.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_svc_02_write_triggers_compaction() {
  let pool = helpers::setup_pool().await;
  let (state, pool) = setup_state(pool).await;

  let owner_id = helpers::create_user(&pool, "svc02", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  // Push 501 updates to cross the 500-update compaction threshold.
  for i in 0i64..501 {
    state
      .doc()
      .push_update(ws_id, doc_id, vec![0u8, 0], i, DocSpaceKind::Workspace)
      .await
      .expect("INV-P102-SVC-02: push_update must succeed");
  }

  let row = sqlx::query("SELECT payload FROM doc_snapshots WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_optional(&pool)
    .await
    .expect("INV-P102-SVC-02: snapshot query must not fail");

  assert!(
    row.is_some(),
    "INV-P102-SVC-02: doc_snapshots row must exist after 501 updates (compaction must have run)"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// INV-P102-SVC-03: capture_history_snapshot + rollback_to_history creates a new update row.
//
// After rollback_to_history, a new row in doc_updates with the snapshot payload
// must exist — the rollback is implemented as a new update entry.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_svc_03_history_rollback() {
  let pool = helpers::setup_pool().await;
  let (state, pool) = setup_state(pool).await;

  let owner_id = helpers::create_user(&pool, "svc03", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  // Push one update so the doc has non-empty content.
  state
    .doc()
    .push_update(ws_id, doc_id, vec![0u8, 0], 0, DocSpaceKind::Workspace)
    .await
    .expect("INV-P102-SVC-03: push_update must succeed");

  let history_id = state
    .doc()
    .capture_history_snapshot(doc_id)
    .await
    .expect("INV-P102-SVC-03: capture_history_snapshot must succeed");

  assert!(history_id > 0, "INV-P102-SVC-03: history_id must be positive");

  let row_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("INV-P102-SVC-03: count query must not fail");

  let ok = state
    .doc()
    .rollback_to_history(doc_id, history_id)
    .await
    .expect("INV-P102-SVC-03: rollback_to_history must succeed");
  assert!(ok, "INV-P102-SVC-03: rollback must return true");

  let row_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("INV-P102-SVC-03: count query after rollback must not fail");

  assert!(
    row_after > row_before,
    "INV-P102-SVC-03: rollback must add a new update row (row_after={row_after}, row_before={row_before})"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// INV-P102-SVC-04: Direct sub-service access via state.doc().load.load_full_doc() works.
//
// The DocService::load field (Arc<DocLoadService>) must be directly callable,
// confirming the P102-SVC split exposed correct public sub-service fields.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_svc_04_sub_service_direct_access() {
  let pool = helpers::setup_pool().await;
  let (state, pool) = setup_state(pool).await;

  let owner_id = helpers::create_user(&pool, "svc04", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  state
    .doc()
    .push_update(ws_id, doc_id, vec![0u8, 0], 0, DocSpaceKind::Workspace)
    .await
    .expect("INV-P102-SVC-04: push_update must succeed");

  // Access load sub-service directly (not via the facade method).
  let loaded = state
    .doc()
    .load
    .load_full_doc(ws_id, doc_id)
    .await
    .expect("INV-P102-SVC-04: direct sub-service load must succeed");

  assert!(
    !loaded.is_empty(),
    "INV-P102-SVC-04: direct DocLoadService access must return non-empty payload"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// INV-P102-SVC-05: load_full_doc honors doc_snapshots.last_sequence.
//
// `doc_snapshots.payload` already contains every update up to `last_sequence`.
// Replaying compacted historical rows resurrects stale CRDT state and made the
// server-side trash cleaner see a different root document than REST/browser
// loads. This regression gate stores an intentionally invalid historical update
// at `sequence = last_sequence`; pre-fix load_full_doc fetched it and failed
// while the correct behavior returns the snapshot unchanged.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_svc_05_load_full_doc_honors_snapshot_last_sequence() {
  let pool = helpers::setup_pool().await;
  let (state, pool) = setup_state(pool).await;

  let owner_id = helpers::create_user(&pool, "svc05", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  let snapshot_payload = vec![0u8, 0];

  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
     VALUES ($1, $2, $3, 1, now())",
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(snapshot_payload.clone())
  .execute(&pool)
  .await
  .expect("INV-P102-SVC-05: insert snapshot");

  sqlx::query(
    "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
     VALUES ($1, $2, $3, 1)",
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(vec![1u8, 2, 3])
  .execute(&pool)
  .await
  .expect("INV-P102-SVC-05: insert compacted historical update");

  let loaded = state
    .doc()
    .load_full_doc(ws_id, doc_id)
    .await
    .expect("INV-P102-SVC-05: load_full_doc must ignore compacted updates");

  assert_eq!(
    loaded, snapshot_payload,
    "INV-P102-SVC-05: load_full_doc must return the snapshot when there are no updates after last_sequence"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// INV-P102-SVC-06: get_snapshot merges pending updates after a snapshot.
//
// MCP read/patch flows use DocService::get_snapshot as a convenience helper.
// That helper must not return only the compacted snapshot when newer
// doc_updates exist; otherwise server-authored edits become invisible until
// the next compaction. This regression starts with an empty snapshot and a
// newer Markdown update so the old stale-snapshot behavior would extract no
// content at all.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_svc_06_get_snapshot_merges_pending_updates_after_snapshot() {
  let pool = helpers::setup_pool().await;
  let (state, pool) = setup_state(pool).await;

  let owner_id = helpers::create_user(&pool, "svc06", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  let pending_update = yjs::markdown_to_yjs(
    "Pending Snapshot Merge",
    "# Pending Snapshot Merge\n\nFresh pending body",
  )
  .expect("INV-P102-SVC-06: fixture markdown must convert to Yjs");

  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
     VALUES ($1, $2, $3, 1, now())",
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(vec![0u8, 0])
  .execute(&pool)
  .await
  .expect("INV-P102-SVC-06: insert compacted empty snapshot");

  sqlx::query(
    "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
     VALUES ($1, $2, $3, 2)",
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(pending_update)
  .execute(&pool)
  .await
  .expect("INV-P102-SVC-06: insert pending update after snapshot");

  let loaded = state
    .doc()
    .get_snapshot(ws_id, doc_id)
    .await
    .expect("INV-P102-SVC-06: get_snapshot must succeed")
    .expect("INV-P102-SVC-06: pending update must produce a merged snapshot");
  let markdown = myoxus_application::markdown::yjs_to_markdown(&loaded)
    .expect("INV-P102-SVC-06: merged Yjs must be extractable")
    .expect("INV-P102-SVC-06: merged Yjs must contain Markdown");

  assert!(
    markdown.markdown.contains("Fresh pending body"),
    "INV-P102-SVC-06: get_snapshot must include pending updates after snapshot, got: {}",
    markdown.markdown
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}
