//! Sync lifecycle integration tests (P20-H).
//!
//! Tests the doc sync pipeline at the application/infrastructure layer:
//! push updates, load docs, verify timestamps, verify empty workspaces.
//! These do NOT test the WebSocket transport (that requires a running server)
//! but verify the data flow that the WebSocket handlers delegate to.

use crate::helpers;

use myoxus_application::auth::AuthError;
use myoxus_application::doc::{
  DocLoadCancellation, DocLoadStore, DocService, DocSpaceKind, DocUpdateStore, DocUpdateWrite, DocWriteTarget,
};
use myoxus_domain::document_key::DocumentKey;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_tests::sync_incident_fixture::SyncIncidentFixture;
use std::sync::Arc;
use uuid::Uuid;

async fn setup_doc_service(pool: &sqlx::PgPool) -> DocService {
  let store = Arc::new(SqlxDocStore::new(pool.clone()));
  DocService::new(store)
}

// ─── P20-H-04: System-Docs round-trip ───────────────────────────────────────

#[tokio::test]
async fn inv_sync_system_doc_roundtrip() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "sys-doc-rt", false).await;
  let ws_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'sys-doc-test')")
    .bind(ws_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("create workspace");

  let doc_service = setup_doc_service(&pool).await;

  // Simulate what the WebSocket handler does for a system document key.
  let system_doc_str = format!("db${}$folders", ws_id);

  // Push an update with external_id
  // Minimal valid Yjs v1 update: 0 structs, 0 delete-set entries.
  // The codec is stricter than yrs — it rejects malformed binaries.
  let yjs_payload = vec![0, 0];
  let doc_uuid = doc_service
    .push_external_update_raw(
      ws_id,
      DocumentKey::parse(system_doc_str.clone()).unwrap(),
      yjs_payload.clone(),
      DocSpaceKind::Workspace,
    )
    .await
    .expect("push system doc update");

  // Load timestamps — must contain the original string key
  let timestamps = doc_service
    .get_space_doc_timestamps(ws_id, None)
    .await
    .expect("get timestamps");
  assert!(
    timestamps.contains_key(&system_doc_str),
    "timestamps must return original system-doc string, got: {:?}",
    timestamps.keys().collect::<Vec<_>>()
  );

  // Load the doc — must return the pushed data
  let loaded = doc_service.load_full_doc(ws_id, doc_uuid).await.expect("load doc");
  assert!(!loaded.is_empty(), "loaded doc must not be empty");
  assert_eq!(
    doc_service.page_registration_state(ws_id, doc_uuid).await.unwrap(),
    None
  );
  let registrations: i64 = sqlx::query_scalar("SELECT count(*) FROM page_registration_evidence WHERE workspace_id=$1")
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    registrations, 0,
    "system documents do not participate in page registration"
  );

  // Cleanup
  sqlx::query("DELETE FROM doc_updates WHERE doc_id = $1")
    .bind(doc_uuid)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_uuid)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

// ─── P20-H-05: Empty workspace ──────────────────────────────────────────────

#[tokio::test]
async fn inv_sync_empty_workspace_timestamps() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "empty-ws", false).await;
  let ws_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'empty-ws-test')")
    .bind(ws_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("create workspace");

  let doc_service = setup_doc_service(&pool).await;

  // Empty workspace must return empty timestamps
  let timestamps = doc_service
    .get_space_doc_timestamps(ws_id, None)
    .await
    .expect("get timestamps");
  assert!(timestamps.is_empty(), "empty workspace must have no doc timestamps");

  // Load root doc (workspace_id as doc_id) — must return initial empty state
  let root_doc = doc_service.load_full_doc(ws_id, ws_id).await.expect("load root doc");
  assert!(
    !root_doc.is_empty(),
    "root doc must return initial state (not empty bytes)"
  );

  // Cleanup
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

// ─── P20-H-03: Reconnect loads all updates ──────────────────────────────────

#[tokio::test]
async fn inv_sync_reconnect_loads_all_updates() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "reconnect", false).await;
  let ws_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'reconnect-test')")
    .bind(ws_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("create workspace");

  let doc_service = setup_doc_service(&pool).await;

  // Push 3 updates sequentially (simulating edits over time)
  for i in 0..3 {
    let payload = vec![0, 0]; // minimal valid Yjs v1 update (codec strict)
    doc_service
      .push_update(ws_id, doc_id, payload, i + 1, DocSpaceKind::Workspace)
      .await
      .expect("push update");
  }

  // "Reconnect" — load_full_doc must merge all 3 updates
  let loaded = doc_service.load_full_doc(ws_id, doc_id).await.expect("load full doc");
  assert!(!loaded.is_empty(), "doc must contain merged updates after reconnect");

  // Timestamps must show this doc
  let timestamps = doc_service
    .get_space_doc_timestamps(ws_id, None)
    .await
    .expect("timestamps");
  assert!(
    timestamps.contains_key(&doc_id.to_string()),
    "doc must appear in timestamps"
  );

  // Cleanup
  sqlx::query("DELETE FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

// P-BUG-SYNC-00/04: the incident-sized snapshot and tail must pass through the
// bounded repository stream into one load/diff materialization. A client state
// vector receives only the missing tail; malformed state and cancellation fail
// closed rather than returning the full document.
#[tokio::test]
async fn inv_sync_incident_fixture_streams_one_materialization_without_fallback() {
  use yrs::updates::decoder::Decode;
  use yrs::{GetString, ReadTxn, Text, Transact};

  let pool = helpers::setup_pool().await;
  let owner_id = helpers::create_user(&pool, "sync-incident-stream", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  let fixture = SyncIncidentFixture::generate();
  fixture.assert_contract();

  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
     VALUES ($1, $2, $3, 0, now())",
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(&fixture.root_snapshot)
  .execute(&pool)
  .await
  .expect("insert incident root snapshot");
  for (index, update) in fixture.root_tail_updates.iter().enumerate() {
    sqlx::query(
      "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
       VALUES ($1, $2, $3, $4)",
    )
    .bind(doc_id)
    .bind(ws_id)
    .bind(update)
    .bind(index as i64 + 1)
    .execute(&pool)
    .await
    .expect("insert incident tail update");
  }

  let service = setup_doc_service(&pool).await;
  let full = service
    .load
    .load_diff_with_meta(
      Uuid::new_v4(),
      ws_id,
      doc_id,
      None,
      8 * 1024 * 1024,
      DocLoadCancellation::default(),
    )
    .await
    .expect("stream full incident fixture");
  assert_eq!(full.update_count, 51, "one snapshot plus exactly 50 tail rows");
  assert_eq!(
    full.input_bytes,
    fixture.root_snapshot.len() + fixture.root_tail_updates.iter().map(Vec::len).sum::<usize>()
  );

  let client_state = yjs::get_state_vector(&fixture.root_snapshot).expect("snapshot state vector");
  let incremental = service
    .load
    .load_diff_with_meta(
      Uuid::new_v4(),
      ws_id,
      doc_id,
      Some(client_state),
      8 * 1024 * 1024,
      DocLoadCancellation::default(),
    )
    .await
    .expect("stream incremental incident fixture");
  assert!(
    incremental.missing.len() < full.missing.len(),
    "a snapshot-aware client must receive a smaller tail diff"
  );

  let reconstructed = yrs::Doc::new();
  let root_text = reconstructed.get_or_insert_text("synthetic-root");
  {
    let mut txn = reconstructed.transact_mut();
    txn
      .apply_update(yrs::Update::decode_v1(&fixture.root_snapshot).expect("decode snapshot"))
      .expect("apply snapshot");
    txn
      .apply_update(yrs::Update::decode_v1(&incremental.missing).expect("decode missing tail"))
      .expect("apply missing tail");
  }
  let visible = root_text.get_string(&reconstructed.transact());
  assert!(visible.ends_with("tail-49;"));

  let invalid = service
    .load
    .load_diff_with_meta(
      Uuid::new_v4(),
      ws_id,
      doc_id,
      Some(vec![0xff]),
      8 * 1024 * 1024,
      DocLoadCancellation::default(),
    )
    .await
    .expect_err("malformed state vector must fail closed");
  assert!(matches!(invalid, AuthError::InvalidYjsStateVector));

  let cancelled = DocLoadCancellation::default();
  cancelled.cancel();
  let error = service
    .load
    .load_diff_with_meta(Uuid::new_v4(), ws_id, doc_id, None, 8 * 1024 * 1024, cancelled)
    .await
    .expect_err("cancelled socket load must stop");
  assert!(matches!(error, AuthError::DocSyncCancelled));

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// Compaction atomically replaces snapshot + covered tail. The load repository
// must therefore retain one repeatable-read view across both table reads; an
// old snapshot combined with a newly deleted tail loses document state.
#[tokio::test]
async fn inv_sync_snapshot_and_tail_remain_consistent_during_compaction() {
  use std::time::Duration;
  use yrs::updates::decoder::Decode;
  use yrs::{GetString, ReadTxn, StateVector, Text, Transact, WriteTxn};

  let pool = helpers::setup_pool().await;
  let owner_id = helpers::create_user(&pool, "sync-stream-compaction", false).await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;

  let source = yrs::Doc::new();
  let source_text = source.get_or_insert_text("content");
  let snapshot = {
    let mut txn = source.transact_mut();
    source_text.insert(&mut txn, 0, "base");
    txn.encode_state_as_update_v1(&StateVector::default())
  };
  let snapshot_vector = source.transact().state_vector();
  let tail = {
    let mut txn = source.transact_mut();
    source_text.insert(&mut txn, 4, " tail");
    txn.encode_diff_v1(&snapshot_vector)
  };
  let compacted_snapshot = source.transact().encode_state_as_update_v1(&StateVector::default());

  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
     VALUES ($1, $2, $3, 0, now())",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(&snapshot)
  .execute(&pool)
  .await
  .expect("insert pre-compaction snapshot");
  sqlx::query(
    "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
     VALUES ($1, $2, $3, 1)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(&tail)
  .execute(&pool)
  .await
  .expect("insert pre-compaction tail");

  let mut compaction = pool.begin().await.expect("begin synthetic compaction");
  sqlx::query("LOCK TABLE doc_updates IN ACCESS EXCLUSIVE MODE")
    .execute(&mut *compaction)
    .await
    .expect("hold tail read until the load snapshot is established");

  let store = Arc::new(SqlxDocStore::new(pool.clone()));
  let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
  let stream = {
    let store = store.clone();
    tokio::spawn(async move {
      store
        .stream_doc_state(
          Uuid::new_v4(),
          workspace_id,
          doc_id,
          sender,
          DocLoadCancellation::default(),
        )
        .await
    })
  };
  let streamed_snapshot = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
    .await
    .expect("repository must stream the snapshot before querying the locked tail")
    .expect("snapshot row must be present");
  assert_eq!(streamed_snapshot, snapshot);

  sqlx::query(
    "UPDATE doc_snapshots SET payload = $3, last_sequence = 1, updated_at = now()
     WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(&compacted_snapshot)
  .execute(&mut *compaction)
  .await
  .expect("replace compacted snapshot");
  sqlx::query("DELETE FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2 AND sequence <= 1")
    .bind(workspace_id)
    .bind(doc_id)
    .execute(&mut *compaction)
    .await
    .expect("delete compacted tail");
  compaction.commit().await.expect("commit synthetic compaction");

  let streamed_tail = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
    .await
    .expect("repeatable-read stream must finish after compaction releases the tail table")
    .expect("the established read view must still contain the old tail");
  assert_eq!(streamed_tail, tail);
  assert!(
    receiver.recv().await.is_none(),
    "stream must contain exactly snapshot plus tail"
  );
  let meta = stream.await.expect("stream task joins").expect("stream succeeds");
  assert_eq!(meta.stats.update_count, 2);

  let reconstructed = yrs::Doc::new();
  let reconstructed_text = reconstructed.get_or_insert_text("content");
  {
    let mut txn = reconstructed.transact_mut();
    txn
      .apply_update(yrs::Update::decode_v1(&streamed_snapshot).expect("decode streamed snapshot"))
      .expect("apply streamed snapshot");
    txn
      .apply_update(yrs::Update::decode_v1(&streamed_tail).expect("decode streamed tail"))
      .expect("apply streamed tail");
  }
  assert_eq!(reconstructed_text.get_string(&reconstructed.transact()), "base tail");

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ─── P20-C-03: Concurrent writes have monotonic sequences ───────────────────

#[tokio::test]
async fn inv_sync_concurrent_writes_monotonic_sequence() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "concurrent", false).await;
  let ws_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'concurrent-test')")
    .bind(ws_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("create workspace");

  let store = Arc::new(SqlxDocStore::new(pool.clone()));

  // Push 5 updates "concurrently" (same timestamp would collide with old impl)
  for _ in 0..5 {
    store
      .push_update(DocUpdateWrite {
        sync_operation_id: None,
        connection_context: None,
        workspace_id: ws_id,
        target: DocWriteTarget::Internal(doc_id),
        payload: vec![0, 0],
        space_kind: DocSpaceKind::Workspace,
        actor_user_id: None,
        client_format: None,
        client_capabilities: None,
        initial_provenance: None,
        validated_external_update: None,
      })
      .await
      .expect("push update");
  }

  // Verify sequences are 1,2,3,4,5 (monotonic, no duplicates)
  let rows = sqlx::query("SELECT sequence FROM doc_updates WHERE doc_id = $1 ORDER BY sequence ASC")
    .bind(doc_id)
    .fetch_all(&pool)
    .await
    .expect("fetch doc_updates sequences");
  let sequences: Vec<i64> = rows.iter().map(|r| sqlx::Row::get(r, "sequence")).collect();
  assert_eq!(
    sequences,
    vec![1, 2, 3, 4, 5],
    "sequences must be monotonic 1..5, got: {sequences:?}"
  );

  // Cleanup
  sqlx::query("DELETE FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

// ─── P101-TIMESTAMP: merge preserves createDate through push→load pipeline ──

/// P101-TIMESTAMP: When a root doc contains `meta.pages[*].createDate`,
/// pushing multiple updates and loading them back (which triggers
/// `merge_updates`) must preserve the createDate values — not lose or
/// corrupt them. The old two-step merge resurrected deleted pages and
/// produced phantom entries with missing/wrong createDate (epoch 0 →
/// 16.01.1970 in the UI).
#[tokio::test]
async fn inv_p101_merge_preserves_create_date_through_pipeline() {
  use yrs::updates::decoder::Decode;
  use yrs::{Any, Array, Doc, Map, Transact, Update};

  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "p101-ts", false).await;
  let ws_id = Uuid::new_v4();
  let doc_id = ws_id; // root doc uses workspace_id as doc_id
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'p101-timestamp-test')")
    .bind(ws_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("create workspace");

  let doc_service = setup_doc_service(&pool).await;

  // Build Yjs updates that mimic a real client creating pages:
  // Update 1: create meta.pages array + add page1 with createDate
  // Update 2: add page2 with createDate
  // Update 3: delete page2
  let create_date_1: f64 = 1775170563828.0; // 2026-04-01 ~10:00 UTC
  let create_date_2: f64 = 1775232588194.0; // 2026-04-01 ~03:00 UTC

  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");

  let upd1 = {
    let mut tx = doc.transact_mut();
    let pages = meta.insert(&mut tx, "pages", yrs::ArrayPrelim::default());
    let page1 = yrs::MapPrelim::from([
      (String::from("id"), Any::String("page1".into())),
      (String::from("createDate"), Any::from(create_date_1)),
    ]);
    pages.push_back(&mut tx, page1);
    tx.encode_update_v1()
  };

  let upd2 = {
    let tx = doc.transact();
    let pages = match meta.get(&tx, "pages") {
      Some(yrs::Out::YArray(arr)) => arr,
      _ => panic!("pages should be YArray"),
    };
    drop(tx);
    let mut tx = doc.transact_mut();
    let page2 = yrs::MapPrelim::from([
      (String::from("id"), Any::String("page2".into())),
      (String::from("createDate"), Any::from(create_date_2)),
    ]);
    pages.push_back(&mut tx, page2);
    tx.encode_update_v1()
  };

  let upd3 = {
    let tx = doc.transact();
    let pages = match meta.get(&tx, "pages") {
      Some(yrs::Out::YArray(arr)) => arr,
      _ => panic!("pages should be YArray"),
    };
    drop(tx);
    let mut tx = doc.transact_mut();
    pages.remove(&mut tx, 1); // delete page2
    tx.encode_update_v1()
  };

  // Push each update sequentially (simulating 3 sync messages)
  for (i, payload) in [upd1, upd2, upd3].iter().enumerate() {
    doc_service
      .push_update(ws_id, doc_id, payload.clone(), (i + 1) as i64, DocSpaceKind::Workspace)
      .await
      .expect("push update");
  }

  // Load full doc — this triggers merge_updates internally
  let loaded = doc_service.load_full_doc(ws_id, doc_id).await.expect("load full doc");

  // Decode the merged output and verify:
  // 1. Only page1 survives (page2 was deleted)
  // 2. page1.createDate is correct (not 0, not missing)
  let verify_doc = Doc::new();
  let verify_meta = verify_doc.get_or_insert_map("meta");
  {
    let mut tx = verify_doc.transact_mut();
    tx.apply_update(Update::decode_v1(&loaded).expect("decode merged"))
      .expect("apply yjs update");
  }

  let tx = verify_doc.transact();
  match verify_meta.get(&tx, "pages") {
    Some(yrs::Out::YArray(pages)) => {
      assert_eq!(
        pages.len(&tx),
        1,
        "after merge, only page1 should survive (page2 was deleted)"
      );
      if let Some(yrs::Out::YMap(page)) = pages.get(&tx, 0) {
        // Verify id
        if let Some(yrs::Out::Any(Any::String(id))) = page.get(&tx, "id") {
          assert_eq!(id.as_ref(), "page1");
        } else {
          panic!("page1 missing id field");
        }
        // Verify createDate is the original value (not 0 / epoch)
        match page.get(&tx, "createDate") {
          Some(yrs::Out::Any(Any::Number(ts))) => {
            assert!(
              (ts.as_f64().expect("numeric timestamp") - create_date_1).abs() < 1.0,
              "createDate should be {} but got {} (corrupted by merge)",
              create_date_1,
              ts
            );
          }
          other => panic!("createDate missing or wrong type: {:?}", other),
        }
      } else {
        panic!("first page entry is not a YMap");
      }
    }
    other => panic!("pages should be YArray, got {:?}", other),
  }

  // Cleanup
  sqlx::query("DELETE FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}
