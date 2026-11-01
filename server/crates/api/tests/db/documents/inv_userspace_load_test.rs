//! LRN-20260424-USERSPACE-LOAD — Invariant tests: userspace doc first-load
//! and metadata-cache `exists` consistency.
//!
//! Regression target (2026-04-24 Journal blank page):
//!   - WebSocket handler returned DOC_NOT_FOUND for userspace docs whose row is
//!     legitimately absent from the `docs` table on first load.
//!   - `load_full_doc_with_meta` cache-HIT path ignored the stored `exists`
//!     field, so the result flipped between DB miss (exists=false) and the
//!     subsequent cache hit (exists=true). This caused alternating
//!     blank/working pages for the same doc.
//!
//! Invariants tested:
//!   INV-USERSPACE-LOAD-01: Cache HIT with `{exists:false, deleted_at:false}`
//!     returns `exists=false` (cache must respect the stored exists field).
//!   INV-USERSPACE-LOAD-02: Two consecutive loads for a doc with no `docs`
//!     row return the same `exists=false` — DB-miss + cache-HIT agree.
//!   INV-USERSPACE-LOAD-03: `load_full_doc_with_tracking` with
//!     `is_workspace_space=false` succeeds for a doc with no `docs` row and
//!     returns `exists=false, payload=[]` — service layer must not error;
//!     the WS handler is responsible for accepting this as a valid
//!     empty-first-load state for userspace docs.

use crate::helpers;

use std::sync::Arc;

use myoxus_application::doc::{DocLoadService, DocService};
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::doc_cache::{DocCache, RedisDocCacheConfig};
use myoxus_infrastructure::redis::InMemoryRedisAdapter;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;

fn make_cache() -> Arc<DocCache> {
  let redis = Arc::new(InMemoryRedisAdapter::new("test"));
  Arc::new(DocCache::new(redis, "myoxus", &RedisDocCacheConfig::default()))
}

// ── INV-USERSPACE-LOAD-01 ────────────────────────────────────────────────────

/// INV-USERSPACE-LOAD-01: Metadata cache HIT respects the stored `exists` field.
///
/// Pre-fix: `load_full_doc_with_meta` read only `deleted_at` from the cache
/// entry. A DB-miss write-through stores `{exists:false, deleted_at:false}`,
/// which then read back as `exists=true` on the next call — inconsistent with
/// the DB path which returns `found && !deleted`.
///
/// This test poisons the cache with the exact shape the DB-miss path writes
/// and asserts the read back respects `exists:false`.
#[tokio::test]
async fn inv_userspace_load_01_cache_hit_respects_exists_field() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let cache = make_cache();

  let ws_id = uuid::Uuid::new_v4();
  let doc_id = uuid::Uuid::new_v4();

  cache
    .set_metadata(doc_id, &serde_json::json!({"exists": false, "deleted_at": false}))
    .await;

  let doc_svc = DocService::new(doc_store).with_doc_cache(cache.clone());
  let result = doc_svc
    .load
    .load_full_doc_with_meta(ws_id, doc_id)
    .await
    .expect("INV-USERSPACE-LOAD-01: load must not error");

  assert!(
    !result.exists,
    "INV-USERSPACE-LOAD-01: cache HIT must respect exists=false, got exists=true"
  );
}

// ── INV-USERSPACE-LOAD-02 ────────────────────────────────────────────────────

/// INV-USERSPACE-LOAD-02: DB-miss + cache-HIT paths agree on `exists=false`.
///
/// Simulates the userspace-first-load pattern: no row in `docs` for the
/// (workspace_id, doc_id) pair. The first call triggers a DB miss and a
/// write-through of `{exists:false, deleted_at:false}`. The second call
/// must return the same `exists=false` from cache.
#[tokio::test]
async fn inv_userspace_load_02_db_miss_and_cache_hit_agree() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let cache = make_cache();

  let ws_id = uuid::Uuid::new_v4();
  let doc_id = uuid::Uuid::new_v4();

  let doc_svc = DocService::new(doc_store).with_doc_cache(cache.clone());

  let first = doc_svc
    .load
    .load_full_doc_with_meta(ws_id, doc_id)
    .await
    .expect("INV-USERSPACE-LOAD-02: first load must not error");
  assert!(!first.exists, "INV-USERSPACE-LOAD-02: first load must see exists=false");

  let cached = cache
    .get_metadata(doc_id)
    .await
    .expect("INV-USERSPACE-LOAD-02: DB-miss path must write-through metadata cache");
  assert_eq!(
    cached.get("exists").and_then(|v| v.as_bool()),
    Some(false),
    "INV-USERSPACE-LOAD-02: write-through must store exists=false"
  );

  let second = doc_svc
    .load
    .load_full_doc_with_meta(ws_id, doc_id)
    .await
    .expect("INV-USERSPACE-LOAD-02: second load must not error");
  assert!(
    !second.exists,
    "INV-USERSPACE-LOAD-02: cache-HIT must agree with DB-miss (exists=false)"
  );
}

// ── INV-USERSPACE-LOAD-03 ────────────────────────────────────────────────────

/// INV-USERSPACE-LOAD-03: `load_full_doc_with_tracking` with
/// `is_workspace_space=false` succeeds for a doc with no `docs` row.
///
/// The retained full-load service must preserve empty-first-load semantics.
/// The current WebSocket path uses streaming materialization; the persisted
/// owner/physical-container regression below exercises that consuming path.
#[tokio::test]
async fn inv_userspace_load_03_tracking_load_userspace_empty_ok() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let ws_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let workspace_service = WorkspaceService::new(ws_store);
  let load_svc = DocLoadService::new(doc_store);

  let user_id = helpers::create_user(&pool, "usload03", false).await;
  // Userspace: space_id == user_id, doc has no row in `docs`.
  let space_id = user_id;
  let doc_id = user_id;

  let result = load_svc
    .load_full_doc_with_tracking(space_id, doc_id, user_id, false, workspace_service)
    .await
    .expect("INV-USERSPACE-LOAD-03: load_full_doc_with_tracking must succeed for empty userspace doc");

  assert!(
    !result.exists,
    "INV-USERSPACE-LOAD-03: empty userspace doc must report exists=false"
  );
  assert!(
    result.payload.is_empty(),
    "INV-USERSPACE-LOAD-03: empty userspace doc payload must be empty"
  );
  assert!(
    !result.has_real_content,
    "INV-USERSPACE-LOAD-03: empty userspace doc must report has_real_content=false"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// Private consumers must resolve the existing physical snapshot/tail through
/// document ownership, including compaction and timestamp discovery.
#[tokio::test]
async fn inv_userspace_load_04_owner_streams_durable_snapshot_and_tail_without_disclosure() {
  use myoxus_application::doc::{DocLoadCancellation, DocSnapshotStore, DocSpaceKind};
  use myoxus_domain::document_key::DocumentKey;
  use yrs::updates::decoder::Decode;
  use yrs::{GetString, ReadTxn, StateVector, Text, Transact};

  let pool = helpers::setup_pool().await;
  let owner = helpers::create_user(&pool, "usload04-owner", false).await;
  let stranger = helpers::create_user(&pool, "usload04-stranger", false).await;
  let container = helpers::create_workspace(&pool, owner).await;
  let store = Arc::new(SqlxDocStore::new(pool.clone()));
  let service = DocService::new(store.clone());
  let key = DocumentKey::parse(format!("private-{}", uuid::Uuid::new_v4())).unwrap();
  let source = yrs::Doc::new();
  let text = source.get_or_insert_text("content");
  let base = {
    let mut txn = source.transact_mut();
    text.insert(&mut txn, 0, "private base");
    txn.encode_state_as_update_v1(&StateVector::default())
  };
  service
    .push_external_update_raw(owner, key.clone(), base.clone(), DocSpaceKind::Userspace)
    .await
    .expect("persist real userspace update");
  let doc_id = service
    .resolve_document_key(owner, DocSpaceKind::Userspace, &key)
    .await
    .unwrap()
    .expect("resolve authoritative userspace identity");

  let loaded = service
    .load
    .load_diff_with_meta(
      uuid::Uuid::new_v4(),
      owner,
      doc_id,
      None,
      1024 * 1024,
      DocLoadCancellation::default(),
    )
    .await
    .expect("stream owner update before compaction");
  let restored = yrs::Doc::new();
  restored
    .transact_mut()
    .apply_update(yrs::Update::decode_v1(&loaded.missing).unwrap())
    .unwrap();
  assert_eq!(
    restored.get_or_insert_text("content").get_string(&restored.transact()),
    "private base"
  );
  assert!(loaded.exists && loaded.has_real_content);

  let sequence: i64 = sqlx::query_scalar("SELECT max(sequence) FROM doc_updates WHERE doc_id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    service
      .compaction
      .merge_pending_updates(owner, doc_id, 1)
      .await
      .unwrap(),
    1,
    "compact through the actual owner-scoped readers and writer"
  );
  // A private document can outlive its original active container. Subsequent
  // accepted updates must continue above its existing snapshot watermark.
  let next_container = helpers::create_workspace(&pool, owner).await;
  sqlx::query("UPDATE workspaces SET deleted_at=now() WHERE id=$1")
    .bind(container)
    .execute(&pool)
    .await
    .expect("retire owned original container without deleting its retained rows");
  let vector = source.transact().state_vector();
  let tail = {
    let mut txn = source.transact_mut();
    text.insert(&mut txn, 12, " tail");
    txn.encode_diff_v1(&vector)
  };
  service
    .push_external_update_raw(owner, key.clone(), tail, DocSpaceKind::Userspace)
    .await
    .expect("persist update after compaction");
  let (tail_container, tail_sequence): (uuid::Uuid, i64) =
    sqlx::query_as("SELECT workspace_id, sequence FROM doc_updates WHERE doc_id=$1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(tail_container, next_container);
  assert!(
    tail_sequence > sequence,
    "durable tail stays above the global snapshot watermark"
  );
  assert_eq!(
    service
      .compaction
      .merge_pending_updates(owner, doc_id, 1)
      .await
      .unwrap(),
    1
  );
  assert_eq!(
    store
      .get_snapshot_with_meta(owner, doc_id)
      .await
      .unwrap()
      .unwrap()
      .last_sequence,
    tail_sequence
  );

  for (caller, expected) in [(owner, "private base tail"), (stranger, "")] {
    let loaded = service
      .load
      .load_diff_with_meta(
        uuid::Uuid::new_v4(),
        caller,
        doc_id,
        None,
        1024 * 1024,
        DocLoadCancellation::default(),
      )
      .await
      .expect("stream authoritative owner scope");
    let restored = yrs::Doc::new();
    restored
      .transact_mut()
      .apply_update(yrs::Update::decode_v1(&loaded.missing).unwrap())
      .unwrap();
    assert_eq!(
      restored.get_or_insert_text("content").get_string(&restored.transact()),
      expected
    );
    assert_eq!(loaded.exists, caller == owner);
    assert_eq!(loaded.has_real_content, caller == owner);
  }

  let clocks = service
    .get_space_doc_timestamps(owner, None)
    .await
    .expect("discover private clocks");
  assert!(
    clocks.contains_key(key.as_str()),
    "reconnecting sync discovers its durable private document"
  );
  assert!(
    service
      .get_space_doc_timestamps(stranger, None)
      .await
      .unwrap()
      .is_empty()
  );
  assert!(
    !service
      .get_space_doc_timestamps(container, None)
      .await
      .unwrap()
      .contains_key(key.as_str())
  );
  let physical: uuid::Uuid = sqlx::query_scalar("SELECT workspace_id FROM doc_snapshots WHERE doc_id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read compacted physical FK");
  assert_eq!(
    physical, container,
    "private compaction retains the deployed storage model"
  );
  sqlx::query("DELETE FROM outbox_events WHERE aggregate_type='doc' AND aggregate_id=$1")
    .bind(doc_id.to_string())
    .execute(&pool)
    .await
    .expect("delete owned compaction event");

  for table in ["doc_updates", "doc_snapshots"] {
    sqlx::query(&format!("DELETE FROM {table} WHERE doc_id=$1"))
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("delete owned private binary state");
  }
  sqlx::query("DELETE FROM docs WHERE id=$1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("delete owned private metadata");
  helpers::cleanup_workspaces(&pool, &[container, next_container]).await;
  helpers::cleanup_users(&pool, &[owner, stranger]).await;
}
