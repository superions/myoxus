//! P102-MOD-05: Sub-trait isolation tests.
//!
//! Invariant: each Panic stub panics with a descriptive message identifying
//! the specific sub-trait and method called.
//!
//! These are pure unit tests — no database required.

use myoxus_application::doc::traits::{
  DocHistoryStore, DocMetadataStore, DocPermissionStore, DocSnapshotStore, DocUpdateStore, DocViewStore,
  PanicDocHistoryStore, PanicDocMetadataStore, PanicDocPermissionStore, PanicDocSnapshotStore, PanicDocUpdateStore,
  PanicDocViewStore,
};
use uuid::Uuid;

// ── DocSnapshotStore stub ──────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "PanicDocSnapshotStore: get_snapshot called")]
fn inv_p102_mod_01_snapshot_stub_panics_get_snapshot() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocSnapshotStore;
    let _ = store.get_snapshot(Uuid::new_v4(), Uuid::new_v4()).await;
  });
}

#[test]
#[should_panic(expected = "PanicDocSnapshotStore: get_snapshot_with_meta called")]
fn inv_p102_mod_01_snapshot_stub_panics_get_snapshot_with_meta() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocSnapshotStore;
    let _ = store.get_snapshot_with_meta(Uuid::new_v4(), Uuid::new_v4()).await;
  });
}

#[test]
#[should_panic(expected = "PanicDocSnapshotStore: save_snapshot called")]
fn inv_p102_mod_01_snapshot_stub_panics_save_snapshot() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocSnapshotStore;
    let _ = store.save_snapshot(Uuid::new_v4(), Uuid::new_v4(), vec![], 0).await;
  });
}

// ── DocUpdateStore stub ───────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "PanicDocUpdateStore: push_update called")]
fn inv_p102_mod_02_update_stub_panics_push_update() {
  use myoxus_application::doc::{DocSpaceKind, DocUpdateWrite, DocWriteTarget};
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocUpdateStore;
    let _ = store
      .push_update(DocUpdateWrite {
        sync_operation_id: None,
        connection_context: None,
        workspace_id: Uuid::new_v4(),
        target: DocWriteTarget::Internal(Uuid::new_v4()),
        payload: vec![],
        space_kind: DocSpaceKind::Workspace,
        actor_user_id: None,
        client_format: None,
        client_capabilities: None,
        initial_provenance: None,
        validated_external_update: None,
      })
      .await;
  });
}

#[test]
#[should_panic(expected = "PanicDocUpdateStore: get_updates_after called")]
fn inv_p102_mod_02_update_stub_panics_get_updates_after() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocUpdateStore;
    let _ = store.get_updates_after(Uuid::new_v4(), Uuid::new_v4(), -1).await;
  });
}

#[test]
#[should_panic(expected = "PanicDocUpdateStore: count_pending_updates called")]
fn inv_p102_mod_02_update_stub_panics_count_pending() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocUpdateStore;
    let _ = store.count_pending_updates(Uuid::new_v4()).await;
  });
}

// ── DocMetadataStore stub ─────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "PanicDocMetadataStore: get_doc_metadata called")]
fn inv_p102_mod_03_metadata_stub_panics_get_doc_metadata() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocMetadataStore;
    let _ = store.get_doc_metadata(Uuid::new_v4()).await;
  });
}

#[test]
#[should_panic(expected = "PanicDocMetadataStore: soft_delete_doc called")]
fn inv_p102_mod_03_metadata_stub_panics_soft_delete() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocMetadataStore;
    let _ = store.soft_delete_doc(Uuid::new_v4()).await;
  });
}

// ── DocViewStore stub ─────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "PanicDocViewStore: record_doc_view called")]
fn inv_p102_mod_04_view_stub_panics_record_doc_view() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocViewStore;
    let _ = store.record_doc_view(Uuid::new_v4(), "test-doc", false, false).await;
  });
}

#[test]
#[should_panic(expected = "PanicDocViewStore: upsert_member_last_access called")]
fn inv_p102_mod_04_view_stub_panics_upsert_last_access() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocViewStore;
    let _ = store
      .upsert_member_last_access(Uuid::new_v4(), Uuid::new_v4(), "test-doc")
      .await;
  });
}

// ── DocHistoryStore stub ──────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "PanicDocHistoryStore: create_history_entry called")]
fn inv_p102_mod_05_history_stub_panics_create_entry() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocHistoryStore;
    let _ = store.create_history_entry(Uuid::new_v4(), Uuid::new_v4(), vec![]).await;
  });
}

#[test]
#[should_panic(expected = "PanicDocHistoryStore: get_history_entry called")]
fn inv_p102_mod_05_history_stub_panics_get_entry() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocHistoryStore;
    let _ = store.get_history_entry(42).await;
  });
}

// ── DocPermissionStore stub ───────────────────────────────────────────────────

#[test]
#[should_panic(expected = "PanicDocPermissionStore: get_user_doc_role called")]
fn inv_p102_mod_06_permission_stub_panics_get_role() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocPermissionStore;
    let _ = store.get_user_doc_role(Uuid::new_v4(), Uuid::new_v4()).await;
  });
}

#[test]
#[should_panic(expected = "PanicDocPermissionStore: list_doc_permissions called")]
fn inv_p102_mod_06_permission_stub_panics_list_permissions() {
  let rt = tokio::runtime::Runtime::new().unwrap();
  rt.block_on(async {
    let store = PanicDocPermissionStore;
    let _ = store.list_doc_permissions(Uuid::new_v4()).await;
  });
}
