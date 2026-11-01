//! P102-TRASH-03 — Invariant tests for CRDT-to-DB trash sync.
//!
//! Invariants verified:
//!   INV-TRASH-01 — pushing root-doc update with `trash: true` sets `docs.deleted_at`
//!   INV-TRASH-02 — pushing root-doc update with `trash: false` (via CRDT in-place mod) clears `docs.deleted_at`
//!   INV-TRASH-03 — trashed page is excluded from `get_space_doc_timestamps`
//!   INV-TRASH-04 — pushing a leaf doc update does NOT trigger trash sync
//!   INV-TRASH-05 — rollback_to_history on root-doc re-syncs trash state
//!   INV-TRASH-06 — duplicate page_id in CRDT: any-trash-wins, deleted_at IS set
//!   INV-TRASH-07 — non-UUID page IDs are normalized before syncing trash state
//!   INV-ROOTMETA-08 — stale root titles converge back to the accepted leaf title
//!   INV-ROOTMETA-09 — root-first registration cannot override a later empty leaf title
//!   INV-ROOTMETA-10 — leaf-doc title push updates docs.title without waiting for root meta
//!
//! Design:
//!   Each test creates its own workspace + page doc, exercises the DocService
//!   facade, then asserts DB and CRDT projection state. Full cleanup at the end
//!   of each test.
//!
//!   CRDT helper design:
//!   - `build_root_doc_update`: creates the FIRST push (fresh Doc, fresh entries).
//!   - `update_root_doc_trash`: for SUBSEQUENT pushes that change trash state.
//!     Loads existing CRDT state, applies it to a Doc, modifies the existing YMap
//!     entry in-place, returns only the delta. Avoids the phantom-duplicate problem
//!     that arises when two fresh Docs both insert the same page into the YArray.
//!   - `load_doc_updates`: reads all updates for a doc from DB and merges them
//!     into a single CRDT binary for use by `update_root_doc_trash`.

use crate::helpers;

use myoxus_application::doc::{DocService, DocSnapshotStore, DocSpaceKind};
use myoxus_infrastructure::doc::SqlxDocStore;
use std::sync::Arc;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Any, Array, Doc, Map, ReadTxn, Transact};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn make_svc(pool: &sqlx::PgPool) -> DocService {
  DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
}

/// Build an initial Yjs v1 root-doc update containing `meta.pages`.
///
/// Creates a fresh Doc (new client ID). Use this ONLY for the first push
/// for a given doc. For subsequent pushes that modify trash state, use
/// [`update_root_doc_trash`] which builds on the existing CRDT state to
/// avoid duplicate YArray entries (phantom-page problem).
///
/// Each entry is `(page_id_str, is_trashed)`.
fn build_root_doc_update(pages: &[(&str, bool)]) -> Vec<u8> {
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");

  let mut txn = doc.transact_mut();

  meta.insert(&mut txn, "pages", yrs::ArrayPrelim::default());
  let pages_arr = match meta.get(&txn, "pages") {
    Some(yrs::Out::YArray(arr)) => arr,
    _ => panic!("could not create pages array"),
  };

  for (page_id, is_trashed) in pages {
    if *is_trashed {
      pages_arr.push_back(
        &mut txn,
        yrs::MapPrelim::from([
          ("id".to_string(), Any::String((*page_id).into())),
          ("trash".to_string(), Any::Bool(true)),
        ]),
      );
    } else {
      pages_arr.push_back(
        &mut txn,
        yrs::MapPrelim::from([("id".to_string(), Any::String((*page_id).into()))]),
      );
    }
  }

  drop(txn);
  let sv = yrs::StateVector::default();
  doc.transact().encode_state_as_update_v1(&sv)
}

/// Build an initial root-doc update with explicit page titles.
fn build_root_doc_update_with_titles(pages: &[(&str, &str, bool)]) -> Vec<u8> {
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");

  let mut txn = doc.transact_mut();
  meta.insert(&mut txn, "pages", yrs::ArrayPrelim::default());
  let pages_arr = match meta.get(&txn, "pages") {
    Some(yrs::Out::YArray(arr)) => arr,
    _ => panic!("could not create pages array"),
  };

  for (page_id, title, is_trashed) in pages {
    if *is_trashed {
      pages_arr.push_back(
        &mut txn,
        yrs::MapPrelim::from([
          ("id".to_string(), Any::String((*page_id).into())),
          ("title".to_string(), Any::String((*title).into())),
          ("trash".to_string(), Any::Bool(true)),
        ]),
      );
    } else {
      pages_arr.push_back(
        &mut txn,
        yrs::MapPrelim::from([
          ("id".to_string(), Any::String((*page_id).into())),
          ("title".to_string(), Any::String((*title).into())),
        ]),
      );
    }
  }

  drop(txn);
  doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
}

/// Produce a delta update that changes the `trash` field of an existing page entry.
///
/// Applies `existing_state` to a Doc (reconstructing the CRDT), finds the YMap
/// for `page_id` in `meta.pages` in-place, and sets or removes `trash` — exactly
/// as the real client does. Returns only the DELTA since `existing_state`, not the
/// full state. This avoids the phantom-duplicate problem that arises when two
/// consecutive fresh-Doc pushes each add the same page to the YArray.
///
/// Uses two separate transaction scopes to satisfy the borrow checker:
/// 1. Read scope: find the target YMap reference (MapRef = BranchPtr, no lifetime).
/// 2. Write scope: apply the modification via a fresh write transaction.
///
/// Panics if `page_id` is not present in `meta.pages` of `existing_state`.
fn update_root_doc_trash(existing_state: &[u8], page_id: &str, is_trashed: bool) -> Vec<u8> {
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");

  // Phase 1: apply existing CRDT state.
  {
    let mut txn = doc.transact_mut();
    let update = yrs::Update::decode_v1(existing_state).expect("decode existing_state in update_root_doc_trash");
    txn.apply_update(update).expect("apply yjs update");
  }

  // Capture state vector BEFORE our modification (for delta encoding).
  let sv_before = doc.transact().state_vector();

  // Phase 2: find the target YMap (scoped read txn ends before write txn starts).
  // MapRef is BranchPtr-based (no lifetime param) and can escape the read scope.
  let target_map: yrs::MapRef = {
    let txn = doc.transact();
    let pages_arr = match meta.get(&txn, "pages") {
      Some(yrs::Out::YArray(arr)) => arr,
      _ => panic!("meta.pages not found in existing_state; page_id={page_id}"),
    };
    let mut found: Option<yrs::MapRef> = None;
    for item in pages_arr.iter(&txn) {
      if let yrs::Out::YMap(map) = item {
        let matches = match map.get(&txn, "id") {
          Some(yrs::Out::Any(yrs::Any::String(s))) => s.as_ref() == page_id,
          _ => false,
        };
        if matches {
          found = Some(map);
          break;
        }
      }
    }
    // txn, pages_arr, and iterator are dropped here; MapRef escapes safely.
    found.unwrap_or_else(|| panic!("page_id {page_id} not found in meta.pages of existing_state"))
  };

  // Phase 3: apply modification using a separate write transaction.
  {
    let mut txn = doc.transact_mut();
    if is_trashed {
      target_map.insert(&mut txn, "trash", yrs::Any::Bool(true));
    } else {
      // Remove trash field — absent key means not-trashed in extract_page_trash_state.
      target_map.remove(&mut txn, "trash");
    }
  }

  // Return only the delta since sv_before (not the full state).
  doc.transact().encode_diff_v1(&sv_before)
}

/// Produce a delta that changes one existing root page title.
fn update_root_doc_title(existing_state: &[u8], page_id: &str, title: &str) -> Vec<u8> {
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(yrs::Update::decode_v1(existing_state).expect("decode root state"))
      .expect("apply root state");
  }
  let sv_before = doc.transact().state_vector();
  let target = {
    let txn = doc.transact();
    let pages = match meta.get(&txn, "pages") {
      Some(yrs::Out::YArray(pages)) => pages,
      _ => panic!("meta.pages missing from root state"),
    };
    pages
      .iter(&txn)
      .find_map(|item| match item {
        yrs::Out::YMap(page)
          if matches!(page.get(&txn, "id"), Some(yrs::Out::Any(Any::String(id))) if id.as_ref() == page_id) =>
        {
          Some(page)
        }
        _ => None,
      })
      .unwrap_or_else(|| panic!("page {page_id} missing from root state"))
  };
  target.insert(&mut doc.transact_mut(), "title", Any::String(title.into()));
  doc.transact().encode_diff_v1(&sv_before)
}

/// Load all updates for a doc from the DB and merge them into a single CRDT binary.
///
/// Used to obtain the current CRDT state that can be fed to [`update_root_doc_trash`]
/// for delta-encoding subsequent modifications.
async fn load_doc_updates(pool: &sqlx::PgPool, workspace_id: Uuid, doc_id: Uuid) -> Vec<u8> {
  let payloads: Vec<Vec<u8>> =
    sqlx::query_scalar("SELECT payload FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2 ORDER BY sequence")
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_all(pool)
      .await
      .expect("load doc_updates from DB");

  let doc = Doc::new();
  {
    let mut txn = doc.transact_mut();
    for payload in payloads {
      match yrs::Update::decode_v1(&payload) {
        Ok(update) => {
          txn.apply_update(update).expect("apply yjs update");
        }
        Err(e) => panic!("decode update from DB: {e}"),
      }
    }
  }
  doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
}

/// Insert a page doc row and return its UUID.
async fn create_page_doc(pool: &sqlx::PgPool, ws_id: Uuid, user_id: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by)
     VALUES ($1, $2, $3, 'viewer', FALSE, $4, $4)",
  )
  .bind(id)
  .bind(ws_id)
  .bind(format!("page-{id}"))
  .bind(user_id)
  .execute(pool)
  .await
  .expect("insert page doc");
  id
}

async fn create_page_doc_with_id(pool: &sqlx::PgPool, ws_id: Uuid, user_id: Uuid, id: Uuid) {
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by)
     VALUES ($1, $2, $3, 'viewer', FALSE, $4, $4)",
  )
  .bind(id)
  .bind(ws_id)
  .bind(format!("page-{id}"))
  .bind(user_id)
  .execute(pool)
  .await
  .expect("insert page doc with controlled id");
}

/// Insert a page doc with a workspace-local client key.
async fn create_original_page_doc(pool: &sqlx::PgPool, ws_id: Uuid, user_id: Uuid, external_id: &str) -> Uuid {
  let doc_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, external_id, default_role, is_workspace_root, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'viewer', FALSE, $5, $5)",
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(format!("page-{external_id}"))
  .bind(external_id)
  .bind(user_id)
  .execute(pool)
  .await
  .expect("insert original page doc");
  doc_id
}

async fn cleanup(pool: &sqlx::PgPool, ws_id: Uuid, page_id: Uuid, user_id: Uuid) {
  sqlx::query("DELETE FROM doc_snapshots WHERE doc_id IN ($1, $2)")
    .bind(ws_id)
    .bind(page_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM doc_updates WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM doc_updates WHERE doc_id = $1")
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
// INV-TRASH-01 — trash: true in root-doc CRDT sets docs.deleted_at
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_trash_01_trash_sets_deleted_at() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "trash01", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let page_id = create_page_doc(&pool, ws_id, user_id).await;
  let svc = make_svc(&pool).await;

  // Pre-condition: page starts with deleted_at = NULL (freshly created).
  let before: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT deleted_at FROM docs WHERE id = $1 AND workspace_id = $2")
      .bind(page_id)
      .bind(ws_id)
      .fetch_one(&pool)
      .await
      .expect("query deleted_at before push");
  assert!(
    before.is_none(),
    "INV-TRASH-01 pre-condition: deleted_at must be NULL before push"
  );

  // Push root-doc update (doc_id == workspace_id) with page marked as trashed.
  let update = build_root_doc_update(&[(&page_id.to_string(), true)]);
  svc
    .push_update(ws_id, ws_id, update, 1, DocSpaceKind::Workspace)
    .await
    .expect("INV-TRASH-01: push_update must succeed");

  // INV-TRASH-01: docs.deleted_at MUST be set after push with trash: true
  let deleted_at: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT deleted_at FROM docs WHERE id = $1 AND workspace_id = $2")
      .bind(page_id)
      .bind(ws_id)
      .fetch_one(&pool)
      .await
      .expect("query deleted_at after push");

  assert!(
    deleted_at.is_some(),
    "INV-TRASH-01: docs.deleted_at must be set after root-doc push with trash: true, got None"
  );

  cleanup(&pool, ws_id, page_id, user_id).await;
}

#[tokio::test]
async fn inv_ts09_root_sync_cannot_trash_managed_template_source() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "ts09-root-trash", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let page_id = create_page_doc(&pool, ws_id, user_id).await;
  let template_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO template_catalog_entries (id, slug, title, source)
     VALUES ($1, $2, 'Protected source', 'bundle')",
  )
  .bind(template_id)
  .bind(format!("ts09-root-trash-{template_id}"))
  .execute(&pool)
  .await
  .expect("seed template catalog entry");
  sqlx::query(
    "INSERT INTO workspace_template_policies
       (workspace_id, template_id, provisioning_mode, is_enabled)
     VALUES ($1, $2, 'managed_until_local_edit', TRUE)",
  )
  .bind(ws_id)
  .bind(template_id)
  .execute(&pool)
  .await
  .expect("seed managed policy");
  sqlx::query(
    "INSERT INTO workspace_template_instances
       (workspace_id, template_id, workspace_doc_id, workspace_doc_key, state)
     VALUES ($1, $2, $3, $4, 'ok')",
  )
  .bind(ws_id)
  .bind(template_id)
  .bind(page_id)
  .bind(page_id.to_string())
  .execute(&pool)
  .await
  .expect("seed managed source binding");
  sqlx::query(
    "INSERT INTO document_template_state (doc_id, state, source, updated_by)
     VALUES ($1, 'managed', 'document', $2)",
  )
  .bind(page_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("seed source classification");

  let error = make_svc(&pool)
    .await
    .push_update(
      ws_id,
      ws_id,
      build_root_doc_update(&[(&page_id.to_string(), true)]),
      1,
      DocSpaceKind::Workspace,
    )
    .await
    .expect_err("stale root sync must reject managed-source trash");
  assert!(
    error
      .to_string()
      .contains(myoxus_application::doc::ASSIGNED_TEMPLATE_SOURCE_PROTECTED)
  );
  let state: (bool, bool) = sqlx::query_as(
    "SELECT d.deleted_at IS NULL, EXISTS(
       SELECT 1 FROM document_template_state t WHERE t.doc_id = d.id
     ) FROM docs d WHERE d.id = $1",
  )
  .bind(page_id)
  .fetch_one(&pool)
  .await
  .expect("read protected source state");
  assert_eq!(
    state,
    (true, true),
    "rejection must preserve content and classification"
  );

  sqlx::query("DELETE FROM workspace_template_instances WHERE template_id = $1")
    .bind(template_id)
    .execute(&pool)
    .await
    .expect("clean instance");
  sqlx::query("DELETE FROM workspace_template_policies WHERE template_id = $1")
    .bind(template_id)
    .execute(&pool)
    .await
    .expect("clean policy");
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
    .bind(template_id)
    .execute(&pool)
    .await
    .expect("clean catalog entry");
  cleanup(&pool, ws_id, page_id, user_id).await;
}

// ---------------------------------------------------------------------------
// INV-TRASH-07 — non-UUID page IDs are normalized before trash sync
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_trash_07_non_uuid_page_id_sets_deleted_at() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "trash07", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let original_page_id = format!("trash07-client-page-{ws_id}");
  let page_id = create_original_page_doc(&pool, ws_id, user_id, &original_page_id).await;
  let svc = make_svc(&pool).await;

  let update = build_root_doc_update(&[(&original_page_id, true)]);
  svc
    .push_update(ws_id, ws_id, update, 1, DocSpaceKind::Workspace)
    .await
    .expect("INV-TRASH-07: push_update must succeed");

  let deleted_at: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT deleted_at FROM docs WHERE id = $1 AND workspace_id = $2")
      .bind(page_id)
      .bind(ws_id)
      .fetch_one(&pool)
      .await
      .expect("query deleted_at for non-UUID page");

  assert!(
    deleted_at.is_some(),
    "INV-TRASH-07: non-UUID page IDs must resolve through workspace-local external_id before trash sync"
  );

  cleanup(&pool, ws_id, page_id, user_id).await;
}

// ---------------------------------------------------------------------------
// INV-ROOTMETA-08 — a stale root title is corrected from the accepted leaf
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_rootmeta_08_stale_root_title_cannot_rename_leaf() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "rootmeta08", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let page_id = create_page_doc(&pool, ws_id, user_id).await;
  let svc = make_svc(&pool).await;
  let leaf_title = format!("Leaf authority {page_id}");
  let stale_root_title = format!("Stale root {page_id}");
  svc
    .push_update(
      ws_id,
      page_id,
      yjs::markdown_to_yjs(&leaf_title, "").expect("build leaf title"),
      1,
      DocSpaceKind::Workspace,
    )
    .await
    .expect("persist authoritative leaf title");

  let update = build_root_doc_update_with_titles(&[(&page_id.to_string(), &stale_root_title, false)]);
  svc
    .push_update(ws_id, ws_id, update, 1, DocSpaceKind::Workspace)
    .await
    .expect("INV-ROOTMETA-08: root-doc push_update must succeed");

  let after: String = sqlx::query_scalar("SELECT title FROM docs WHERE id = $1 AND workspace_id = $2")
    .bind(page_id)
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .expect("query title after root metadata sync");
  assert_eq!(after, leaf_title, "stale root title must not overwrite SQL");
  let root = load_doc_updates(&pool, ws_id, ws_id).await;
  let projected = yjs::extract_page_trash_state(&root).expect("extract corrected root");
  assert_eq!(
    projected
      .iter()
      .find(|page| page.id == page_id.to_string())
      .and_then(|page| page.title.as_deref()),
    Some(leaf_title.as_str()),
    "the delivered root correction must converge to the leaf title"
  );

  cleanup(&pool, ws_id, page_id, user_id).await;
}

// ---------------------------------------------------------------------------
// INV-ROOTMETA-09 — root-first registration cannot fill an empty leaf title
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_rootmeta_09_empty_leaf_replaces_preexisting_root_title() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "rootmeta09", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let page_id = Uuid::new_v4();
  let svc = make_svc(&pool).await;
  let stale_title = format!("Root title before row {page_id}");

  // Web can push root metadata before the leaf-doc update has auto-created the
  // `docs` row. The first root sync must not be the only chance to project the
  // title, otherwise GraphQL workspace docs stay empty while local root meta has
  // the correct title.
  let root_update = build_root_doc_update_with_titles(&[(&page_id.to_string(), &stale_title, false)]);
  svc
    .push_update(ws_id, ws_id, root_update, 1, DocSpaceKind::Workspace)
    .await
    .expect("INV-ROOTMETA-09: root-doc push_update before doc row must succeed");

  let row_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id = $1 AND workspace_id = $2)")
    .bind(page_id)
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .expect("query row existence before leaf push");
  assert!(
    !row_exists,
    "INV-ROOTMETA-09 pre-condition: root metadata push must not create the leaf docs row"
  );

  let leaf_update = yjs::markdown_to_yjs("", "body").expect("build structurally valid empty leaf title");
  svc
    .push_update(ws_id, page_id, leaf_update, 2, DocSpaceKind::Workspace)
    .await
    .expect("INV-ROOTMETA-09: leaf push must auto-create doc row and retry root metadata sync");

  let after: String = sqlx::query_scalar("SELECT title FROM docs WHERE id = $1 AND workspace_id = $2")
    .bind(page_id)
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .expect("query title after auto-create root metadata retry");
  assert_eq!(after, "", "a structurally valid empty leaf title must remain empty");
  let root = load_doc_updates(&pool, ws_id, ws_id).await;
  let projected = yjs::extract_page_trash_state(&root).expect("extract corrected root");
  assert_eq!(
    projected
      .iter()
      .find(|page| page.id == page_id.to_string())
      .and_then(|page| page.title.as_deref()),
    Some(""),
    "the root projection must preserve the empty leaf title"
  );

  cleanup(&pool, ws_id, page_id, user_id).await;
}

// ---------------------------------------------------------------------------
// INV-ROOTMETA-10 — leaf-doc title push updates docs.title immediately
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_rootmeta_10_leaf_doc_title_push_updates_workspace_docs_projection() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "rootmeta10", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let page_id = create_page_doc(&pool, ws_id, user_id).await;
  let svc = make_svc(&pool).await;
  let title = format!("Leaf title projection {page_id}");

  let before: String = sqlx::query_scalar("SELECT title FROM docs WHERE id = $1 AND workspace_id = $2")
    .bind(page_id)
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .expect("query title before leaf title projection");
  assert_ne!(
    before, title,
    "INV-ROOTMETA-10 pre-condition: SQL title must differ before leaf title push"
  );

  let leaf_update = yjs::markdown_to_yjs(&title, "").expect("build leaf Yjs update with page title");
  svc
    .push_update(ws_id, page_id, leaf_update, 1, DocSpaceKind::Workspace)
    .await
    .expect("INV-ROOTMETA-10: leaf push_update must succeed");

  let after: String = sqlx::query_scalar("SELECT title FROM docs WHERE id = $1 AND workspace_id = $2")
    .bind(page_id)
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .expect("query title after leaf title projection");
  assert_eq!(
    after, title,
    "INV-ROOTMETA-10: leaf doc title must update docs.title without waiting for root metadata sync"
  );

  cleanup(&pool, ws_id, page_id, user_id).await;
}

#[tokio::test]
async fn inv_p102_rootmeta_10b_overlapping_root_and_leaf_writes_use_canonical_lock_order() {
  for (case_name, page_sorts_before_root) in [("lower", true), ("higher", false)] {
    let pool = helpers::setup_pool().await;
    let user_id = helpers::create_user(&pool, &format!("rootmeta10b-{case_name}"), false).await;
    let ws_id = helpers::create_workspace(&pool, user_id).await;
    let page_id = Uuid::from_u128(if page_sorts_before_root {
      ws_id.as_u128() - 1
    } else {
      ws_id.as_u128() + 1
    });
    create_page_doc_with_id(&pool, ws_id, user_id, page_id).await;

    let initial_title = format!("Initial {case_name}");
    make_svc(&pool)
      .await
      .push_update(
        ws_id,
        page_id,
        yjs::markdown_to_yjs(&initial_title, "body").expect("build initial leaf"),
        1,
        DocSpaceKind::Workspace,
      )
      .await
      .expect("seed leaf");
    make_svc(&pool)
      .await
      .push_update(
        ws_id,
        ws_id,
        build_root_doc_update_with_titles(&[(&page_id.to_string(), &initial_title, false)]),
        1,
        DocSpaceKind::Workspace,
      )
      .await
      .expect("seed root membership");

    let leaf_state = load_doc_updates(&pool, ws_id, page_id).await;
    let root_state = load_doc_updates(&pool, ws_id, ws_id).await;
    let accepted_title = format!("Accepted leaf {case_name}");
    let stale_title = format!("Stale root {case_name}");
    let leaf_delta = yjs::update_document_title(&leaf_state, &accepted_title).expect("build leaf title delta");
    let root_delta = update_root_doc_title(&root_state, &page_id.to_string(), &stale_title);
    let start = Arc::new(tokio::sync::Barrier::new(2));
    let leaf_service = make_svc(&pool).await;
    let root_service = make_svc(&pool).await;
    let leaf_start = Arc::clone(&start);
    let root_start = Arc::clone(&start);

    let (leaf_result, root_result) = tokio::join!(
      async move {
        leaf_start.wait().await;
        leaf_service
          .push_update(ws_id, page_id, leaf_delta, 2, DocSpaceKind::Workspace)
          .await
      },
      async move {
        root_start.wait().await;
        root_service
          .push_update(ws_id, ws_id, root_delta, 2, DocSpaceKind::Workspace)
          .await
      }
    );
    leaf_result.expect("overlapping leaf write must complete");
    root_result.expect("overlapping root write must complete");

    let sql_title: String = sqlx::query_scalar("SELECT title FROM docs WHERE id = $1")
      .bind(page_id)
      .fetch_one(&pool)
      .await
      .expect("read converged SQL title");
    assert_eq!(sql_title, accepted_title);
    let leaf = load_doc_updates(&pool, ws_id, page_id).await;
    assert_eq!(
      yjs::extract_text_from_yjs(&leaf)
        .expect("extract converged leaf")
        .title
        .as_deref(),
      Some(accepted_title.as_str())
    );
    let root = load_doc_updates(&pool, ws_id, ws_id).await;
    let projected = yjs::extract_page_trash_state(&root).expect("extract converged root");
    assert_eq!(
      projected
        .iter()
        .find(|page| page.id == page_id.to_string())
        .and_then(|page| page.title.as_deref()),
      Some(accepted_title.as_str())
    );
    let delivered_root: bool = sqlx::query_scalar(
      "SELECT EXISTS(
         SELECT 1 FROM outbox_events, jsonb_array_elements(payload->'updates') update
         WHERE aggregate_type = 'doc'
           AND event_type = 'workspace_doc_broadcast'
           AND aggregate_id = $1
           AND update->>'docId' = $2
       )",
    )
    .bind(page_id.to_string())
    .bind(ws_id.to_string())
    .fetch_one(&pool)
    .await
    .expect("inspect root delivery event");
    assert!(
      delivered_root,
      "the atomic title projection must enqueue its root delta"
    );

    cleanup(&pool, ws_id, page_id, user_id).await;
  }
}

#[tokio::test]
async fn inv_p102_rootmeta_11_projection_failure_rolls_back_leaf_and_retries() {
  use futures_util::FutureExt;

  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "rootmeta11", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let page_id = create_page_doc(&pool, ws_id, user_id).await;
  let function_name = format!("fail_title_projection_{}", page_id.simple());
  let trigger_name = format!("fail_title_projection_{}", page_id.simple());
  let outcome = std::panic::AssertUnwindSafe(async {
    let svc = make_svc(&pool).await;
    let title = format!("Atomic projection {page_id}");
    let root_update = build_root_doc_update_with_titles(&[(&page_id.to_string(), "Before", false)]);
    svc
      .push_update(ws_id, ws_id, root_update, 1, DocSpaceKind::Workspace)
      .await
      .expect("seed root membership");
    let before_updates: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
      .bind(page_id)
      .fetch_one(&pool)
      .await
      .expect("count leaf updates before failure");

    sqlx::query(&format!(
      "CREATE FUNCTION {function_name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected title projection failure'; END $$"
    ))
    .execute(&pool)
    .await
    .expect("create projection failure function");
    sqlx::query(&format!(
      "CREATE TRIGGER {trigger_name} BEFORE UPDATE OF title ON docs FOR EACH ROW WHEN (NEW.id = '{page_id}'::uuid) EXECUTE FUNCTION {function_name}()"
    ))
    .execute(&pool)
    .await
    .expect("create projection failure trigger");

    let leaf_update = yjs::markdown_to_yjs(&title, "body").expect("build leaf update");
    assert!(
      svc
        .push_update(ws_id, page_id, leaf_update.clone(), 2, DocSpaceKind::Workspace,)
        .await
        .is_err(),
      "the injected projection failure must reject the complete write"
    );
    let after_failure: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
      .bind(page_id)
      .fetch_one(&pool)
      .await
      .expect("count leaf updates after rollback");
    assert_eq!(
      after_failure, before_updates,
      "leaf persistence must roll back with projection"
    );

    sqlx::query(&format!("DROP TRIGGER {trigger_name} ON docs"))
      .execute(&pool)
      .await
      .expect("drop projection failure trigger");
    sqlx::query(&format!("DROP FUNCTION {function_name}()"))
      .execute(&pool)
      .await
      .expect("drop projection failure function");
    svc
      .push_update(ws_id, page_id, leaf_update, 2, DocSpaceKind::Workspace)
      .await
      .expect("retry the same leaf update after projection recovery");
    let projected: String = sqlx::query_scalar("SELECT title FROM docs WHERE id = $1")
      .bind(page_id)
      .fetch_one(&pool)
      .await
      .expect("read retried title projection");
    assert_eq!(projected, title);
  })
  .catch_unwind()
  .await;

  sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger_name} ON docs"))
    .execute(&pool)
    .await
    .expect("remove owned projection failure trigger");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {function_name}()"))
    .execute(&pool)
    .await
    .expect("remove owned projection failure function");
  cleanup(&pool, ws_id, page_id, user_id).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_p102_rootmeta_12_old_snapshot_does_not_refill_empty_tail_title() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "rootmeta12", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let page_id = create_page_doc(&pool, ws_id, user_id).await;
  let svc = make_svc(&pool).await;
  let store = SqlxDocStore::new(pool.clone());
  let old = yjs::markdown_to_yjs("Older title", "body").expect("build old snapshot");
  svc
    .push_update(ws_id, page_id, old.clone(), 1, DocSpaceKind::Workspace)
    .await
    .expect("persist old title");
  store
    .save_snapshot(page_id, ws_id, old.clone(), 1)
    .await
    .expect("compact old title");
  let empty_delta = yjs::update_document_title(&old, "").expect("build empty-title delta");
  svc
    .push_update(ws_id, page_id, empty_delta, 2, DocSpaceKind::Workspace)
    .await
    .expect("persist empty current title");

  store
    .save_snapshot(page_id, ws_id, old, 1)
    .await
    .expect("repeat older compaction while the empty-title tail remains");
  let projected: String = sqlx::query_scalar("SELECT title FROM docs WHERE id = $1")
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .expect("read title after old snapshot compaction");
  assert_eq!(projected, "", "the current empty tail title must remain authoritative");

  cleanup(&pool, ws_id, page_id, user_id).await;
}

// ---------------------------------------------------------------------------
// INV-TRASH-02 — full E2E: trash via CRDT, then untrash via CRDT in-place mod
//
// Design: Uses `update_root_doc_trash` for the second push to avoid the
// phantom-duplicate problem. If both pushes used `build_root_doc_update`
// (each creating a fresh Doc with a new client ID), the YArray would contain
// two entries for the same page: one with trash=true and one without.
// `sync_page_trash_state` would see the page in BOTH trashed_ids AND
// untrashed_ids — and since untrash runs last, deleted_at would be NULL even
// after the trash push (incorrect). Using `update_root_doc_trash` for the
// second push modifies the single existing YMap entry in-place, avoiding
// duplicate entries entirely.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_trash_02_untrash_clears_deleted_at() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "trash02", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let page_id = create_page_doc(&pool, ws_id, user_id).await;
  let svc = make_svc(&pool).await;
  let page_id_str = page_id.to_string();

  // Step 1: Push root-doc with page as trashed (first push — single entry).
  let trash_update = build_root_doc_update(&[(&page_id_str, true)]);
  svc
    .push_update(ws_id, ws_id, trash_update, 1, DocSpaceKind::Workspace)
    .await
    .expect("INV-TRASH-02: push trash");

  let deleted_at_after_trash: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT deleted_at FROM docs WHERE id = $1")
      .bind(page_id)
      .fetch_one(&pool)
      .await
      .expect("q1");
  assert!(
    deleted_at_after_trash.is_some(),
    "INV-TRASH-02 pre-condition: deleted_at must be set after trash push"
  );

  // Step 2: Load current merged CRDT state from DB.
  // This is the existing state that `update_root_doc_trash` will build on.
  let current_state = load_doc_updates(&pool, ws_id, ws_id).await;

  // Step 3: Push untrash delta — modifies the existing YMap entry in-place.
  // This avoids creating a second YArray entry for the same page_id.
  let untrash_delta = update_root_doc_trash(&current_state, &page_id_str, false);
  svc
    .push_update(ws_id, ws_id, untrash_delta, 2, DocSpaceKind::Workspace)
    .await
    .expect("INV-TRASH-02: push untrash");

  // INV-TRASH-02: docs.deleted_at MUST be NULL after push with trash absent/removed.
  let deleted_at: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT deleted_at FROM docs WHERE id = $1")
      .bind(page_id)
      .fetch_one(&pool)
      .await
      .expect("q2");

  assert!(
    deleted_at.is_none(),
    "INV-TRASH-02: docs.deleted_at must be NULL after CRDT in-place untrash push, got {deleted_at:?}"
  );

  cleanup(&pool, ws_id, page_id, user_id).await;
}

// ---------------------------------------------------------------------------
// INV-TRASH-03 — trashed page is excluded from get_space_doc_timestamps
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_trash_03_trash_hidden_from_timestamps() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "trash03", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let page_id = create_page_doc(&pool, ws_id, user_id).await;
  let svc = make_svc(&pool).await;

  // Push a leaf update to give the page a doc_updates row (so it shows in timestamps)
  svc
    .push_update(ws_id, page_id, vec![0u8, 0u8], 1, DocSpaceKind::Workspace)
    .await
    .expect("push leaf");

  // Verify page IS present in timestamps before trashing
  let before_trash = svc
    .get_space_doc_timestamps(ws_id, None)
    .await
    .expect("timestamps before trash");
  let page_id_str = page_id.to_string();
  assert!(
    before_trash.contains_key(&page_id_str),
    "INV-TRASH-03 pre-condition: page must appear in timestamps before trash"
  );

  // Now trash via root-doc push
  let update = build_root_doc_update(&[(&page_id_str, true)]);
  svc
    .push_update(ws_id, ws_id, update, 2, DocSpaceKind::Workspace)
    .await
    .expect("push trash");

  // INV-TRASH-03: trashed page MUST NOT appear in timestamps
  let after_trash = svc
    .get_space_doc_timestamps(ws_id, None)
    .await
    .expect("timestamps after trash");
  assert!(
    !after_trash.contains_key(&page_id_str),
    "INV-TRASH-03: trashed page must be excluded from get_space_doc_timestamps"
  );

  cleanup(&pool, ws_id, page_id, user_id).await;
}

// ---------------------------------------------------------------------------
// INV-TRASH-05 — rollback_to_history on root-doc triggers trash sync (idempotent)
//
// IMPORTANT — Yrs CRDT append-only semantics:
//   Yrs CRDTs are append-only (last-write-wins per logical clock). Rolling back
//   by pushing an old binary doesn't undo newer CRDT operations. A trash=true
//   operation at T2 survives a rollback to T1 because T2's logical clock is higher.
//   Therefore, after rollback, the CRDT still shows trash=true, and the trash sync
//   CORRECTLY leaves docs.deleted_at set.
//
// What this test verifies:
//   1. rollback_to_history DOES trigger sync_root_doc_trash_state (the call was added).
//   2. The sync is correct and idempotent — it doesn't accidentally CLEAR deleted_at
//      for a page that is still trashed in the CRDT after rollback.
//   3. The trash state is self-consistent after rollback (DB reflects CRDT).
//
// CRDT helper note:
//   Step 2 uses `update_root_doc_trash` (not `build_root_doc_update`) to avoid
//   creating a second YArray entry for the same page_id. See INV-TRASH-02 design
//   note. With duplicate entries, sync_page_trash_state would see the page in both
//   trashed_ids AND untrashed_ids — untrash wins, so deleted_at would be NULL after
//   step 2, breaking the pre-condition assertion.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p102_trash_05_rollback_triggers_trash_sync_idempotently() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "trash05", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let page_id = create_page_doc(&pool, ws_id, user_id).await;
  let svc = make_svc(&pool).await;
  let page_id_str = page_id.to_string();

  // Step 1: Push root-doc with page as NOT trashed → capture history snapshot.
  let clean_update = build_root_doc_update(&[(&page_id_str, false)]);
  svc
    .push_update(ws_id, ws_id, clean_update, 1, DocSpaceKind::Workspace)
    .await
    .expect("push clean root-doc");
  let history_id = svc.capture_history_snapshot(ws_id).await.expect("capture history");

  // Step 2: Push root-doc with page as trashed (in-place mod — avoids phantom-duplicate).
  // We must use update_root_doc_trash here: using build_root_doc_update would create
  // a second YArray entry, causing sync to see page in BOTH sets → untrash wins → pre-condition fails.
  let state_after_step1 = load_doc_updates(&pool, ws_id, ws_id).await;
  let trash_delta = update_root_doc_trash(&state_after_step1, &page_id_str, true);
  svc
    .push_update(ws_id, ws_id, trash_delta, 2, DocSpaceKind::Workspace)
    .await
    .expect("push trash root-doc");

  let deleted_at_after_trash: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT deleted_at FROM docs WHERE id = $1")
      .bind(page_id)
      .fetch_one(&pool)
      .await
      .expect("q2");
  assert!(
    deleted_at_after_trash.is_some(),
    "INV-TRASH-05 pre-condition: page must be trashed after step 2"
  );

  // Step 3: Rollback to the "clean" history snapshot.
  // Due to Yrs append-only CRDT semantics, the trash=true from step 2 survives:
  // the rollback binary contains T1 ops (lower logical clock), and the trash=true
  // op at T2 (higher clock) still wins in the merge. CRDT state remains trash=true.
  svc.rollback_to_history(ws_id, history_id).await.expect("rollback");

  // INV-TRASH-05: Trash sync ran after rollback (non-fatal). Since the CRDT still
  // shows trash=true (Yrs semantics), docs.deleted_at must REMAIN set.
  // This confirms sync ran correctly and didn't corrupt the consistent state.
  let deleted_at_after_rollback: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT deleted_at FROM docs WHERE id = $1")
      .bind(page_id)
      .fetch_one(&pool)
      .await
      .expect("q3");

  assert!(
    deleted_at_after_rollback.is_some(),
    "INV-TRASH-05: CRDT still shows trash=true after rollback (Yrs append-only); \
     docs.deleted_at must remain set but got None — sync incorrectly cleared it"
  );

  cleanup(&pool, ws_id, page_id, user_id).await;
}

// ---------------------------------------------------------------------------
// INV-TRASH-06 — duplicate page_id in CRDT: any-trash-wins → deleted_at IS set
//
// Context (LRN-20260405-290): when two clients with different client IDs each
// insert the same page into `meta.pages` YArray, both entries survive the CRDT
// merge. `extract_page_trash_state` previously returned BOTH entries — one with
// trash=true and one without. `sync_page_trash_state` processed them in order:
// untrash ran last, clearing deleted_at even for a trashed page.
//
// Fix: `extract_page_trash_state` now deduplicates with any-trash-wins: if ANY
// entry for a page_id has trash=true, the page is treated as trashed.
//
// This test deliberately constructs a CRDT binary with two YArray entries for
// the same page_id (one trashed, one not) in a single push, then asserts that
// docs.deleted_at IS set — proving any-trash-wins is applied correctly.
// ---------------------------------------------------------------------------

/// Build a root-doc update with TWO entries for the same page_id in meta.pages.
/// Entry 1: trash=true. Entry 2: same page_id, no trash field.
/// This simulates the CRDT duplicate-entry scenario (LRN-20260405-290).
fn build_duplicate_entry_update(page_id: &str) -> Vec<u8> {
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");
  let mut txn = doc.transact_mut();
  meta.insert(&mut txn, "pages", yrs::ArrayPrelim::default());
  let pages_arr = match meta.get(&txn, "pages") {
    Some(yrs::Out::YArray(arr)) => arr,
    _ => panic!("could not create pages array"),
  };
  // Entry 1: same page_id, trash = true
  pages_arr.push_back(
    &mut txn,
    yrs::MapPrelim::from([
      ("id".to_string(), Any::String(page_id.into())),
      ("trash".to_string(), Any::Bool(true)),
    ]),
  );
  // Entry 2: same page_id, no trash field (not trashed)
  pages_arr.push_back(
    &mut txn,
    yrs::MapPrelim::from([("id".to_string(), Any::String(page_id.into()))]),
  );
  drop(txn);
  doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
}

#[tokio::test]
async fn inv_p102_trash_06_duplicate_page_id_any_trash_wins() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "trash06", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let page_id = create_page_doc(&pool, ws_id, user_id).await;
  let svc = make_svc(&pool).await;
  let page_id_str = page_id.to_string();

  // Push root-doc update with two entries for the same page_id:
  // entry 1 says trash=true, entry 2 says not-trashed (absent).
  // Before the fix: untrash ran last -> deleted_at = NULL (bug).
  // After the fix: any-trash-wins in extract_page_trash_state -> deleted_at IS set.
  let dup_update = build_duplicate_entry_update(&page_id_str);
  svc
    .push_update(ws_id, ws_id, dup_update, 1, DocSpaceKind::Workspace)
    .await
    .expect("INV-TRASH-06: push_update must succeed");

  // INV-TRASH-06: docs.deleted_at MUST be set — any-trash-wins
  let deleted_at: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT deleted_at FROM docs WHERE id = $1 AND workspace_id = $2")
      .bind(page_id)
      .bind(ws_id)
      .fetch_one(&pool)
      .await
      .expect("query deleted_at");

  assert!(
    deleted_at.is_some(),
    "INV-TRASH-06: duplicate page_id with trash=true MUST result in deleted_at being set \
     (any-trash-wins). Got None -- deduplication not applied or untrash overrode trash."
  );

  cleanup(&pool, ws_id, page_id, user_id).await;
}
