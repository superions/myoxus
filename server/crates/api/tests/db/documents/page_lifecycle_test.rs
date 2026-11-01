// SPDX-License-Identifier: AGPL-3.0-or-later
//! Transactional page-lifecycle invariants against the production SQL store.

use std::{collections::HashMap, sync::Arc};

use myoxus_application::{
  doc::{
    DocLoadCancellation, DocService, DocSpaceKind, DocUpdateStore, DocUpdateWrite, DocWriteTarget,
    PageLifecycleDriftClass, PageLifecycleRepairMode, PageProjectionCompleteness, PageProjectionPresenceEvidence,
    PermanentDeleteMode, PermanentDeleteRequest, ValidatedExternalYjsUpdate,
    content_mutation::{DocumentFragment, DocumentFragmentBlock, DocumentTextSegment},
  },
  metrics::{METRICS_CATEGORIES, MetricsPolicy, MetricsService},
  workspace::WorkspaceService,
};
use myoxus_domain::document_key::DocumentKey;
use myoxus_infrastructure::{auth::SqlxAuthStore, doc::SqlxDocStore, workspace::SqlxWorkspaceStore};
use sqlx::PgPool;
use uuid::Uuid;
use yrs::{Array, Map, ReadTxn, Transact, Update, updates::decoder::Decode};

use crate::helpers;

async fn setup_lifecycle(prefix: &str) -> (PgPool, Uuid, Uuid, DocService) {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (user_id, _) = helpers::seed_user(&pool, &auth_store, prefix).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  WorkspaceService::new(Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  )))
  .seed_root_doc(
    workspace_id,
    user_id,
    yjs::create_initial_workspace_doc("Lifecycle workspace"),
  )
  .await
  .expect("workspace root must be initialized");
  let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  (pool, user_id, workspace_id, service)
}

async fn push_registration_update(
  pool: &PgPool,
  workspace_id: Uuid,
  user_id: Uuid,
  external_id: &str,
  payload: Vec<u8>,
) -> myoxus_application::doc::DocUpdatePersistenceResult {
  try_push_registration_update(pool, workspace_id, user_id, external_id, payload)
    .await
    .expect("registration update must persist")
}

async fn try_push_registration_update(
  pool: &PgPool,
  workspace_id: Uuid,
  user_id: Uuid,
  external_id: &str,
  payload: Vec<u8>,
) -> myoxus_application::auth::AuthResult<myoxus_application::doc::DocUpdatePersistenceResult> {
  let permit = Arc::new(tokio::sync::Semaphore::new(1)).acquire_owned().await.unwrap();
  let (payload, decoded) = yjs::decode_update_v1_guarded(payload, permit).await.unwrap();
  SqlxDocStore::new(pool.clone())
    .push_update(DocUpdateWrite {
      sync_operation_id: Some(Uuid::new_v4()),
      connection_context: None,
      workspace_id,
      target: DocWriteTarget::External(DocumentKey::parse(external_id).unwrap()),
      payload,
      space_kind: DocSpaceKind::Workspace,
      actor_user_id: Some(user_id),
      client_format: None,
      client_capabilities: None,
      initial_provenance: None,
      validated_external_update: Some(ValidatedExternalYjsUpdate::new(decoded, 1024 * 1024)),
    })
    .await
}

#[tokio::test]
async fn page_registration_converges_delivery_order_restart_and_concurrent_retries() {
  use myoxus_application::doc::PageRegistrationState;
  let (pool, user_id, workspace_id, service) = setup_lifecycle("page-registration").await;
  for root_first in [true, false] {
    let external_id = format!("registration-{}", Uuid::new_v4());
    let intent = Uuid::new_v4().to_string();
    let leaf = yrs::Doc::new();
    let meta = leaf.get_or_insert_map("meta");
    {
      let mut tx = leaf.transact_mut();
      meta.insert(&mut tx, "pageCreationId", external_id.as_str());
      meta.insert(&mut tx, "pageCreationIntent", intent.as_str());
    }
    let marker = leaf.transact().encode_state_as_update_v1(&Default::default());
    let content = myoxus_application::markdown::markdown_to_yjs("", "Preserved registration paragraph.").unwrap();
    leaf
      .transact_mut()
      .apply_update(Update::decode_v1(&content).unwrap())
      .unwrap();
    let complete = leaf.transact().encode_state_as_update_v1(&Default::default());

    let root = yrs::Doc::new();
    root
      .transact_mut()
      .apply_update(Update::decode_v1(&service.load_full_doc(workspace_id, workspace_id).await.unwrap()).unwrap())
      .unwrap();
    let root_delta = {
      let mut tx = root.transact_mut();
      let before = tx.state_vector();
      let yrs::Out::YArray(pages) = tx.get_map("meta").unwrap().get(&tx, "pages").unwrap() else {
        panic!("root page list")
      };
      pages.push_back(
        &mut tx,
        yrs::MapPrelim::from([
          ("id", yrs::Any::from(external_id.as_str())),
          ("title", yrs::Any::from("")),
          ("creationIntent", yrs::Any::from(intent.as_str())),
        ]),
      );
      tx.encode_diff_v1(&before)
    };
    if root_first {
      push_registration_update(
        &pool,
        workspace_id,
        user_id,
        &workspace_id.to_string(),
        root_delta.clone(),
      )
      .await;
    }
    let pending = push_registration_update(&pool, workspace_id, user_id, &external_id, marker).await;
    assert_eq!(pending.page_registration, Some(PageRegistrationState::Pending));

    // A new service/store instance must resume from durable evidence. Concurrent
    // retransmissions share the same explicit creation and original SQL identity.
    let restarted = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
    assert_eq!(
      restarted
        .page_registration_state(workspace_id, pending.doc_id)
        .await
        .unwrap(),
      Some(PageRegistrationState::Pending)
    );
    let (first, retry) = tokio::join!(
      push_registration_update(&pool, workspace_id, user_id, &external_id, complete.clone()),
      push_registration_update(&pool, workspace_id, user_id, &external_id, complete.clone()),
    );
    assert_eq!(first.doc_id, pending.doc_id);
    assert_eq!(retry.doc_id, pending.doc_id);
    assert_eq!(first.page_registration, Some(PageRegistrationState::Registered));
    assert_eq!(retry.page_registration, Some(PageRegistrationState::Registered));
    push_registration_update(
      &pool,
      workspace_id,
      user_id,
      &workspace_id.to_string(),
      root_delta.clone(),
    )
    .await;
    let root_sequence = sequence(&pool, workspace_id, workspace_id).await;
    push_registration_update(&pool, workspace_id, user_id, &workspace_id.to_string(), root_delta).await;
    assert_eq!(
      sequence(&pool, workspace_id, workspace_id).await,
      root_sequence,
      "exact replay must not write another correction"
    );
    let root_state = restarted.load_full_doc(workspace_id, workspace_id).await.unwrap();
    assert_eq!(
      root_page_entry_ids(&root_state)
        .iter()
        .filter(|id| **id == external_id)
        .count(),
      1
    );
    let stored = restarted.load_full_doc(workspace_id, pending.doc_id).await.unwrap();
    let extracted = yjs::extract_text_from_yjs(&stored).unwrap();
    assert!(extracted.markdown.contains("Preserved registration paragraph."));
    assert_eq!(
      extracted.markdown,
      yjs::extract_text_from_yjs(&complete).unwrap().markdown
    );
    let identities: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1 AND external_id=$2")
      .bind(workspace_id)
      .bind(&external_id)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(identities, 1);
    let broadcast: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM outbox_events WHERE aggregate_id=$1 AND event_type='workspace_doc_broadcast' AND payload->>'lifecycleOperation'='page_registration')")
      .bind(pending.doc_id.to_string()).fetch_one(&pool).await.unwrap();
    assert!(
      broadcast,
      "registration's generated root changes must have durable delivery references"
    );

    restarted
      .trash_page(workspace_id, pending.doc_id, user_id)
      .await
      .unwrap();
    assert!(matches!(
      try_push_registration_update(&pool, workspace_id, user_id, &external_id, complete.clone()).await,
      Err(myoxus_application::auth::AuthError::NotFound(_))
    ));
    restarted
      .restore_page(workspace_id, pending.doc_id, user_id)
      .await
      .unwrap();
    let restored = push_registration_update(&pool, workspace_id, user_id, &external_id, complete.clone()).await;
    assert_eq!(restored.doc_id, pending.doc_id);
    assert_eq!(
      restarted.load_full_doc(workspace_id, pending.doc_id).await.unwrap(),
      stored
    );

    // This entry has never reached the server. Deleting already-known CRDT
    // items alone cannot prevent its first arrival after permanent deletion.
    let late_root = {
      let mut tx = root.transact_mut();
      let before = tx.state_vector();
      let yrs::Out::YArray(pages) = tx.get_map("meta").unwrap().get(&tx, "pages").unwrap() else {
        panic!("page list")
      };
      pages.push_back(
        &mut tx,
        yrs::MapPrelim::from([
          ("id", yrs::Any::from(external_id.as_str())),
          ("title", yrs::Any::from("")),
          ("creationIntent", yrs::Any::from(intent.as_str())),
        ]),
      );
      tx.encode_diff_v1(&before)
    };
    restarted
      .trash_page(workspace_id, pending.doc_id, user_id)
      .await
      .unwrap();
    let deleted = restarted
      .permanently_delete_documents(PermanentDeleteRequest {
        workspace_id,
        actor_user_id: Some(user_id),
        mode: PermanentDeleteMode::SelectedDocs,
        doc_ids: vec![external_id.clone()],
      })
      .await
      .unwrap();
    assert_eq!(deleted.deleted, 1);
    assert!(
      restarted
        .is_page_permanently_deleted(workspace_id, &DocumentKey::parse(external_id.clone()).unwrap())
        .await
        .unwrap()
    );
    assert!(
      !restarted
        .is_page_permanently_deleted(workspace_id, &DocumentKey::parse("never-created").unwrap())
        .await
        .unwrap()
    );

    assert!(matches!(
      try_push_registration_update(&pool, workspace_id, user_id, &external_id, complete.clone()).await,
      Err(myoxus_application::auth::AuthError::NotFound(_))
    ));
    assert!(matches!(
      restarted
        .push_update(workspace_id, pending.doc_id, complete, 0, DocSpaceKind::Workspace)
        .await,
      Err(myoxus_application::auth::AuthError::NotFound(_))
    ));
    push_registration_update(&pool, workspace_id, user_id, &workspace_id.to_string(), late_root).await;
    assert!(
      !root_page_entry_ids(&restarted.load_full_doc(workspace_id, workspace_id).await.unwrap()).contains(&external_id)
    );
    assert_eq!(
      sqlx::query_scalar::<_, String>(
        "SELECT state FROM page_registration_evidence WHERE workspace_id=$1 AND external_id=$2"
      )
      .bind(workspace_id)
      .bind(&external_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
      "deleted"
    );
  }
  helpers::cleanup_users(&pool, &[user_id]).await;
}

async fn scan_all(service: &DocService, workspace_id: Uuid, limit: u16) -> Vec<PageProjectionPresenceEvidence> {
  let mut cursor = None;
  let mut items = Vec::new();
  loop {
    let page = service
      .page_lifecycle_repair
      .scan(
        workspace_id,
        cursor.as_deref(),
        Some(limit),
        DocLoadCancellation::default(),
      )
      .await
      .expect("bounded projection scan");
    items.extend(page.items);
    cursor = page.next_cursor;
    if cursor.is_none() {
      return items;
    }
  }
}

#[tokio::test]
async fn page_projection_scan_and_exact_repair_are_bounded_dual_identity_safe_and_replayable() {
  let (pool, user_id, workspace_id, service) = setup_lifecycle("page-projection-bounded").await;
  let uuid_default = service
    .create_page_lifecycle(workspace_id, user_id, Some("UUID default".to_string()), None)
    .await
    .expect("create UUID-default control")
    .document
    .id;
  let nano_external = "projection-NanoKey7Gt4Ks9P";
  let nano_internal = materialize_browser_page(&pool, workspace_id, user_id, nano_external, "Nano page").await;
  let uuid_shaped_external = nano_internal.to_string();
  let uuid_shaped_internal = materialize_browser_page(
    &pool,
    workspace_id,
    user_id,
    &uuid_shaped_external,
    "UUID-shaped external page",
  )
  .await;
  assert_ne!(uuid_shaped_internal, nano_internal);
  let corrupt_leaf = helpers::create_doc(&pool, workspace_id, user_id).await;
  append_raw_update(&pool, workspace_id, corrupt_leaf, vec![0xff, 0x00, 0x7f]).await;

  let cancelled = DocLoadCancellation::default();
  cancelled.cancel();
  assert!(
    service
      .page_lifecycle_repair
      .scan(workspace_id, None, Some(2), cancelled)
      .await
      .expect_err("cancelled scan must fail before retaining a decoder or DB resource")
      .to_string()
      .contains("cancelled")
  );
  assert!(
    service
      .page_lifecycle_repair
      .scan(
        workspace_id,
        Some("not-an-opaque-cursor"),
        Some(2),
        DocLoadCancellation::default(),
      )
      .await
      .expect_err("malformed cursor must fail closed")
      .to_string()
      .contains("MIX_PAGE_PROJECTION_CURSOR_INVALID")
  );
  for invalid_limit in [0, 201] {
    assert!(
      service
        .page_lifecycle_repair
        .scan(workspace_id, None, Some(invalid_limit), DocLoadCancellation::default(),)
        .await
        .expect_err("scan limit outside 1..=200 must fail")
        .to_string()
        .contains("MIX_PAGE_PROJECTION_LIMIT_INVALID")
    );
  }

  let mut cursor = None;
  let mut evidence = Vec::new();
  loop {
    let page = service
      .page_lifecycle_repair
      .scan(workspace_id, cursor.as_deref(), Some(2), DocLoadCancellation::default())
      .await
      .expect("bounded projection scan");
    assert!(page.items.len() <= 2, "scan must enforce its requested page size");
    if page.next_cursor.is_some() {
      assert_eq!(page.completeness, PageProjectionCompleteness::Incomplete);
      assert!(!page.healthy, "an incomplete scan must never claim workspace health");
    }
    evidence.extend(page.items.iter().map(|item| item.source_id.clone()));
    cursor = page.next_cursor;
    if cursor.is_none() {
      assert_eq!(page.completeness, PageProjectionCompleteness::Complete);
      assert!(
        !page.healthy,
        "complete discovery must retain findings from earlier pages"
      );
      break;
    }
  }
  let unique = evidence.iter().collect::<std::collections::BTreeSet<_>>();
  assert_eq!(unique.len(), evidence.len(), "pagination must not duplicate evidence");
  assert!(evidence.contains(&uuid_default.to_string()));
  assert!(evidence.contains(&nano_external.to_string()));
  assert!(evidence.contains(&uuid_shaped_external));
  assert!(evidence.contains(&corrupt_leaf.to_string()));

  let inspected = service
    .page_lifecycle_repair
    .inspect(workspace_id, &uuid_shaped_external, DocLoadCancellation::default())
    .await
    .expect("inspect exact UUID-shaped external key");
  assert_eq!(inspected.external_doc_id, uuid_shaped_external);
  assert!(inspected.sql_present && inspected.root_present && inspected.leaf_present);
  assert!(
    inspected.findings.is_empty(),
    "UUID syntax must not override exact external identity"
  );
  assert!(
    service
      .page_lifecycle_repair
      .repair_exact(
        workspace_id,
        &uuid_default.to_string(),
        user_id,
        &inspected.fingerprint,
        PageLifecycleRepairMode::Apply,
        DocLoadCancellation::default(),
      )
      .await
      .expect_err("a fingerprint from another external key must fail even when both are clean")
      .to_string()
      .contains("MIX_PAGE_REPAIR_REPORT_STALE")
  );
  assert!(
    service
      .page_lifecycle_repair
      .inspect(workspace_id, &corrupt_leaf.to_string(), DocLoadCancellation::default(),)
      .await
      .is_err(),
    "exact inspection must decode and reject its one selected corrupt leaf"
  );

  let first_page = service
    .page_lifecycle_repair
    .scan(workspace_id, None, Some(1), DocLoadCancellation::default())
    .await
    .expect("start cursor stability probe");
  let stable_cursor = first_page.next_cursor.expect("bounded first page needs continuation");
  let other_workspace = helpers::create_workspace(&pool, user_id).await;
  WorkspaceService::new(Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  )))
  .seed_root_doc(
    other_workspace,
    user_id,
    yjs::create_initial_workspace_doc("Other cursor workspace"),
  )
  .await
  .expect("second root must be initialized");
  assert!(
    service
      .page_lifecycle_repair
      .scan(
        other_workspace,
        Some(&stable_cursor),
        Some(1),
        DocLoadCancellation::default(),
      )
      .await
      .expect_err("cursor must remain bound to its workspace")
      .to_string()
      .contains("MIX_PAGE_PROJECTION_CURSOR_INVALID")
  );
  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  let root_change = append_raw_root_pages_update(
    &root_state,
    &[("projection-cursor-change".to_string(), "Cursor change".to_string())],
  );
  append_raw_update(&pool, workspace_id, workspace_id, root_change).await;
  assert!(
    service
      .page_lifecycle_repair
      .scan(
        workspace_id,
        Some(&stable_cursor),
        Some(1),
        DocLoadCancellation::default(),
      )
      .await
      .is_err(),
    "cursor must not continue after root sequence replacement"
  );

  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  let removal = yjs::remove_pages_from_root_doc(&root_state, &[nano_external.to_string()]).unwrap();
  append_raw_update(&pool, workspace_id, workspace_id, removal.update).await;
  let drift = service
    .page_lifecycle_repair
    .inspect(workspace_id, nano_external, DocLoadCancellation::default())
    .await
    .expect("inspect one exact drift target");
  assert!(
    drift
      .findings
      .iter()
      .any(|finding| { finding.drift_class == PageLifecycleDriftClass::MissingRootEntry && finding.repairable })
  );
  let preview = service
    .page_lifecycle_repair
    .repair_exact(
      workspace_id,
      nano_external,
      user_id,
      &drift.fingerprint,
      PageLifecycleRepairMode::DryRun,
      DocLoadCancellation::default(),
    )
    .await
    .expect("preview one exact target");
  assert!(!preview.changed);
  let applied = service
    .page_lifecycle_repair
    .repair_exact(
      workspace_id,
      nano_external,
      user_id,
      &drift.fingerprint,
      PageLifecycleRepairMode::Apply,
      DocLoadCancellation::default(),
    )
    .await
    .expect("apply one exact target");
  assert!(applied.changed);
  let replay = service
    .page_lifecycle_repair
    .repair_exact(
      workspace_id,
      nano_external,
      user_id,
      &drift.fingerprint,
      PageLifecycleRepairMode::Apply,
      DocLoadCancellation::default(),
    )
    .await
    .expect("replay completed exact repair");
  assert!(!replay.changed);

  helpers::cleanup_users(&pool, &[user_id]).await;
}

async fn sequence(pool: &PgPool, workspace_id: Uuid, doc_id: Uuid) -> i64 {
  sqlx::query_scalar(
    "SELECT GREATEST(
       COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2), 0),
       COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $2), 0)
     )",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .fetch_one(pool)
  .await
  .expect("sequence must be readable")
}

async fn append_raw_update(pool: &PgPool, workspace_id: Uuid, doc_id: Uuid, payload: Vec<u8>) {
  let next = sequence(pool, workspace_id, doc_id).await + 1;
  sqlx::query("INSERT INTO doc_updates (workspace_id, doc_id, payload, sequence) VALUES ($1, $2, $3, $4)")
    .bind(workspace_id)
    .bind(doc_id)
    .bind(payload)
    .bind(next)
    .execute(pool)
    .await
    .expect("test drift update must persist");
}

async fn materialize_browser_page(
  pool: &PgPool,
  workspace_id: Uuid,
  user_id: Uuid,
  external_id: &str,
  title: &str,
) -> Uuid {
  let payload = myoxus_application::markdown::empty_page_to_yjs(title);
  let permit = Arc::new(tokio::sync::Semaphore::new(1))
    .acquire_owned()
    .await
    .expect("decoder permit");
  let (payload, decoded) = yjs::decode_update_v1_guarded(payload, permit)
    .await
    .expect("browser page update must decode");
  let persisted = SqlxDocStore::new(pool.clone())
    .push_update(DocUpdateWrite {
      sync_operation_id: Some(Uuid::new_v4()),
      connection_context: None,
      workspace_id,
      target: DocWriteTarget::External(DocumentKey::parse(external_id).expect("valid browser document key")),
      payload,
      space_kind: DocSpaceKind::Workspace,
      actor_user_id: Some(user_id),
      client_format: None,
      client_capabilities: None,
      initial_provenance: None,
      validated_external_update: Some(ValidatedExternalYjsUpdate::new(decoded, 1024 * 1024)),
    })
    .await
    .expect("browser first write must materialize one docs row");
  let root_state = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
    .load_full_doc(workspace_id, workspace_id)
    .await
    .expect("workspace root must load");
  let root_delta = yjs::add_pages_to_root_doc(
    std::slice::from_ref(&root_state),
    &[(external_id.to_string(), title.to_string())],
  )
  .expect("browser root update must be valid");
  let root_with_page = yjs::merge_updates(vec![root_state, root_delta.clone()]).expect("browser root state must merge");
  let created_at_ms = chrono::Utc::now().timestamp_millis();
  let root_metadata = yjs::update_root_page_metadata(
    &root_with_page,
    external_id,
    Some(title),
    Some(false),
    Some(created_at_ms),
    created_at_ms,
  )
  .expect("browser root metadata must be valid");
  assert_eq!(root_metadata.matched_entries, 1);
  append_raw_update(
    pool,
    workspace_id,
    workspace_id,
    yjs::merge_updates(vec![root_delta, root_metadata.update]).expect("browser root delta must merge"),
  )
  .await;
  persisted.doc_id
}

fn paragraph_fragment(text: &str) -> DocumentFragment {
  DocumentFragment {
    schema_version: yjs::DOCUMENT_FRAGMENT_SCHEMA.to_string(),
    blocks: vec![DocumentFragmentBlock::Paragraph {
      properties: None,
      text: vec![DocumentTextSegment {
        text: text.to_string(),
        bold: false,
        italic: false,
        strike: false,
        code: false,
        latex: None,
        link: None,
        reference: None,
        footnote: None,
        ..Default::default()
      }],
    }],
  }
}

fn root_page_projection_by_key(state: &[u8], document_key: &str) -> (String, bool, i64, i64) {
  let doc = yrs::Doc::new();
  let meta = doc.get_or_insert_map("meta");
  doc
    .transact_mut()
    .apply_update(Update::decode_v1(state).expect("root state must decode"))
    .expect("root state must apply");
  let txn = doc.transact();
  let pages = match meta.get(&txn, "pages") {
    Some(yrs::Out::YArray(pages)) => pages,
    other => panic!("root meta.pages must be an array, got {other:?}"),
  };
  pages
    .iter(&txn)
    .find_map(|entry| {
      let yrs::Out::YMap(page) = entry else {
        return None;
      };
      let matches = matches!(
        page.get(&txn, "id"),
        Some(yrs::Out::Any(yrs::Any::String(id))) if id.as_ref() == document_key
      );
      matches.then(|| {
        let title = match page.get(&txn, "title") {
          Some(yrs::Out::Any(yrs::Any::String(value))) => value.to_string(),
          other => panic!("root title must be a string, got {other:?}"),
        };
        let trashed = matches!(page.get(&txn, "trash"), Some(yrs::Out::Any(yrs::Any::Bool(true))));
        let timestamp = |key| match page.get(&txn, key) {
          Some(yrs::Out::Any(yrs::Any::Number(value))) => value.as_f64().expect("numeric timestamp") as i64,
          other => panic!("root {key} must be numeric, got {other:?}"),
        };
        (title, trashed, timestamp("createDate"), timestamp("updatedDate"))
      })
    })
    .expect("root projection must contain the page")
}

fn root_page_projection(state: &[u8], doc_id: Uuid) -> (String, bool, i64, i64) {
  root_page_projection_by_key(state, &doc_id.to_string())
}

fn root_page_entry_ids(state: &[u8]) -> Vec<String> {
  yjs::extract_workspace_root_metadata(state)
    .expect("root pages must project")
    .pages
    .into_iter()
    .map(|entry| entry.id)
    .collect()
}

fn append_raw_root_pages_update(root_state: &[u8], pages: &[(String, String)]) -> Vec<u8> {
  let doc = yrs::Doc::new();
  let meta = doc.get_or_insert_map("meta");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(root_state).expect("root fixture must decode"))
      .expect("root fixture must apply");
  }
  let before = doc.transact().state_vector();
  {
    let mut txn = doc.transact_mut();
    let pages_array = match meta.get(&txn, "pages") {
      Some(yrs::Out::YArray(pages_array)) => pages_array,
      other => panic!("root meta.pages must be an array, got {other:?}"),
    };
    for (page_id, title) in pages {
      pages_array.push_back(
        &mut txn,
        yrs::MapPrelim::from([
          ("id".to_string(), yrs::Any::String(page_id.clone().into())),
          ("title".to_string(), yrs::Any::String(title.clone().into())),
        ]),
      );
    }
  }
  doc.transact().encode_diff_v1(&before)
}

async fn install_insert_failure(pool: &PgPool, doc_id: Uuid) -> (String, String) {
  let suffix = Uuid::new_v4().simple().to_string();
  let function = format!("test_page_lifecycle_fail_{suffix}");
  let trigger = format!("test_page_lifecycle_trigger_{suffix}");
  sqlx::query(&format!(
    "CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.doc_id = '{doc_id}'::uuid THEN
           RAISE EXCEPTION 'injected page lifecycle failure';
         END IF;
         RETURN NEW;
       END $$"
  ))
  .execute(pool)
  .await
  .expect("failure function must install");
  sqlx::query(&format!(
    "CREATE TRIGGER {trigger} BEFORE INSERT ON doc_updates
     FOR EACH ROW EXECUTE FUNCTION {function}()"
  ))
  .execute(pool)
  .await
  .expect("failure trigger must install");
  (trigger, function)
}

async fn remove_insert_failure(pool: &PgPool, trigger: &str, function: &str) {
  sqlx::query(&format!("DROP TRIGGER {trigger} ON doc_updates"))
    .execute(pool)
    .await
    .expect("failure trigger must be removed");
  sqlx::query(&format!("DROP FUNCTION {function}()"))
    .execute(pool)
    .await
    .expect("failure function must be removed");
}

async fn install_metadata_update_failure(pool: &PgPool, doc_id: Uuid) -> (String, String) {
  let suffix = Uuid::new_v4().simple().to_string();
  let function = format!("test_page_metadata_fail_{suffix}");
  let trigger = format!("test_page_metadata_trigger_{suffix}");
  sqlx::query(&format!(
    "CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.id = '{doc_id}'::uuid THEN
           RAISE EXCEPTION 'injected page metadata failure';
         END IF;
         RETURN NEW;
       END $$"
  ))
  .execute(pool)
  .await
  .expect("metadata failure function must install");
  sqlx::query(&format!(
    "CREATE TRIGGER {trigger} BEFORE UPDATE ON docs
     FOR EACH ROW EXECUTE FUNCTION {function}()"
  ))
  .execute(pool)
  .await
  .expect("metadata failure trigger must install");
  (trigger, function)
}

async fn remove_metadata_update_failure(pool: &PgPool, trigger: &str, function: &str) {
  sqlx::query(&format!("DROP TRIGGER {trigger} ON docs"))
    .execute(pool)
    .await
    .expect("metadata failure trigger must be removed");
  sqlx::query(&format!("DROP FUNCTION {function}()"))
    .execute(pool)
    .await
    .expect("metadata failure function must be removed");
}

#[tokio::test]
async fn page_lifecycle_keeps_sql_leaf_and_root_projection_consistent() {
  let (pool, user_id, workspace_id, service) = setup_lifecycle("page-life-consistent").await;
  let created = service
    .create_page_lifecycle(
      workspace_id,
      user_id,
      Some("Initial title".to_string()),
      Some(paragraph_fragment("Typed initial body")),
    )
    .await
    .expect("create lifecycle must commit");
  let doc_id = created.document.id;
  assert_eq!(
    created.document.external_id,
    doc_id.to_string(),
    "server-created pages must preserve the shipped UUID-default external identity"
  );
  let leaf = created.leaf.as_ref().expect("create must return the exact leaf delta");
  assert_eq!(leaf.doc_id, doc_id, "leaf persistence remains keyed by docs.id");
  assert_eq!(
    created.workspace_root.doc_id, workspace_id,
    "root persistence remains keyed by the workspace UUID"
  );
  assert_eq!(leaf.sequence, sequence(&pool, workspace_id, doc_id).await);
  assert_eq!(
    created.workspace_root.sequence,
    sequence(&pool, workspace_id, workspace_id).await
  );
  let stored_leaf: Vec<u8> =
    sqlx::query_scalar("SELECT payload FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2 AND sequence = $3")
      .bind(workspace_id)
      .bind(doc_id)
      .bind(leaf.sequence)
      .fetch_one(&pool)
      .await
      .expect("created leaf delta must be persisted");
  assert_eq!(stored_leaf, leaf.delta);

  let leaf_state = service
    .load_full_doc(workspace_id, doc_id)
    .await
    .expect("leaf must load");
  let extracted = yjs::extract_text_from_yjs(&leaf_state).expect("leaf text must project");
  assert_eq!(extracted.title.as_deref(), Some("Initial title"));
  assert!(extracted.markdown.contains("Typed initial body"));
  let root_state = service
    .load_full_doc(workspace_id, workspace_id)
    .await
    .expect("root must load");
  assert_eq!(
    root_page_entry_ids(&root_state)
      .into_iter()
      .filter(|entry_id| entry_id == &doc_id.to_string())
      .count(),
    1,
    "the UUID-default wire key must appear exactly once in root metadata"
  );
  let (title, trashed, created_at_ms, updated_at_ms) = root_page_projection(&root_state, doc_id);
  assert_eq!(title, "Initial title");
  assert!(!trashed);
  assert_eq!(created_at_ms, created.document.created_at.timestamp_millis());
  assert_eq!(updated_at_ms, created.document.updated_at.timestamp_millis());

  let renamed = service
    .rename_page(workspace_id, doc_id, user_id, "Renamed title".to_string(), None)
    .await
    .expect("rename lifecycle must commit");
  assert!(renamed.leaf.is_some(), "rename must expose its exact leaf delta");
  let leaf_state = service
    .load_full_doc(workspace_id, doc_id)
    .await
    .expect("renamed leaf must load");
  assert_eq!(
    yjs::extract_text_from_yjs(&leaf_state)
      .expect("renamed leaf must project")
      .title
      .as_deref(),
    Some("Renamed title")
  );
  let root_state = service
    .load_full_doc(workspace_id, workspace_id)
    .await
    .expect("renamed root must load");
  assert_eq!(root_page_projection(&root_state, doc_id).0, "Renamed title");
  let change: (i64, i64) =
    sqlx::query_as("SELECT first_sequence,last_sequence FROM document_change_batches WHERE doc_id=$1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("meaningful lifecycle rename accumulates the leaf");
  assert_eq!(
    change,
    (
      renamed.leaf.as_ref().unwrap().sequence,
      renamed.leaf.as_ref().unwrap().sequence
    )
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM document_change_batches WHERE doc_id=$1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
    0,
    "the companion root is excluded"
  );

  let trashed_commit = service
    .trash_page(workspace_id, doc_id, user_id)
    .await
    .expect("trash lifecycle must commit");
  assert!(trashed_commit.leaf.is_none(), "trash must not write the leaf document");
  let root_state = service
    .load_full_doc(workspace_id, workspace_id)
    .await
    .expect("trashed root must load");
  assert!(root_page_projection(&root_state, doc_id).1);
  assert!(
    service
      .get_metadata_including_deleted(doc_id)
      .await
      .unwrap()
      .unwrap()
      .deleted_at
      .is_some()
  );

  service
    .restore_page(workspace_id, doc_id, user_id)
    .await
    .expect("restore lifecycle must commit");
  let root_state = service
    .load_full_doc(workspace_id, workspace_id)
    .await
    .expect("restored root must load");
  assert!(!root_page_projection(&root_state, doc_id).1);
  assert!(
    service
      .get_metadata(doc_id)
      .await
      .unwrap()
      .unwrap()
      .deleted_at
      .is_none()
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn page_lifecycle_writer_preserves_external_root_key_and_internal_persistence() {
  let (pool, user_id, workspace_id, service) = setup_lifecycle("page-life-external-key").await;
  let external_id = "browser-page-NanoKey7Zk2QaLm9";
  let doc_id = materialize_browser_page(&pool, workspace_id, user_id, external_id, "Browser title").await;
  assert_ne!(external_id, doc_id.to_string());

  sqlx::query(
    "INSERT INTO doc_user_permissions (user_id, doc_id, role)
     VALUES ($1, $2, 'Owner')
     ON CONFLICT (user_id, doc_id) DO UPDATE SET role = EXCLUDED.role",
  )
  .bind(user_id)
  .bind(doc_id)
  .execute(&pool)
  .await
  .expect("fixture permission must use the internal UUID");

  let projection_before = service
    .page_lifecycle_repair
    .inspect(workspace_id, external_id, DocLoadCancellation::default())
    .await
    .unwrap();

  service
    .rename_page(workspace_id, doc_id, user_id, "Browser renamed".to_string(), None)
    .await
    .expect("rename must address the external root entry");
  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  assert_eq!(
    root_page_projection_by_key(&root_state, external_id).0,
    "Browser renamed"
  );
  assert!(!root_page_entry_ids(&root_state).contains(&doc_id.to_string()));

  service
    .trash_page(workspace_id, doc_id, user_id)
    .await
    .expect("trash must address the external root entry");
  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  assert!(root_page_projection_by_key(&root_state, external_id).1);

  service
    .restore_page(workspace_id, doc_id, user_id)
    .await
    .expect("restore must address the external root entry");
  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  assert!(!root_page_projection_by_key(&root_state, external_id).1);
  assert_eq!(
    root_page_entry_ids(&root_state)
      .into_iter()
      .filter(|entry_id| entry_id == external_id)
      .count(),
    1,
    "normal lifecycle operations must retain exactly one external root entry"
  );

  let stored_external_id: String = sqlx::query_scalar("SELECT external_id FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(stored_external_id, external_id);
  assert!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap()
      > 0,
    "leaf updates remain keyed by the internal UUID"
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_user_permissions WHERE user_id = $1 AND doc_id = $2")
      .bind(user_id)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
    1,
    "permissions remain keyed by the internal UUID"
  );
  let lifecycle_outbox: Vec<(String, serde_json::Value)> = sqlx::query_as(
    "SELECT aggregate_id, payload
     FROM outbox_events
     WHERE aggregate_type = 'doc'
       AND event_type = 'workspace_doc_broadcast'
       AND aggregate_id = $1
     ORDER BY created_at",
  )
  .bind(doc_id.to_string())
  .fetch_all(&pool)
  .await
  .unwrap();
  assert_eq!(
    lifecycle_outbox.len(),
    4,
    "first sync and three lifecycle writes emit once"
  );
  let lifecycle_operations = lifecycle_outbox
    .iter()
    .filter_map(|(_, payload)| payload["lifecycleOperation"].as_str())
    .collect::<Vec<_>>();
  assert_eq!(lifecycle_operations, ["doc_update", "rename", "trash", "restore"]);
  assert!(lifecycle_outbox.iter().all(|(aggregate_id, payload)| {
    let direct_doc_id_is_internal = payload["docId"].as_str().is_none_or(|id| id == doc_id.to_string());
    let update_doc_ids_are_internal = payload["updates"].as_array().is_none_or(|updates| {
      updates.iter().all(|update| {
        matches!(update["docId"].as_str(), Some(id) if id == doc_id.to_string() || id == workspace_id.to_string())
      })
    });
    aggregate_id == &doc_id.to_string() && direct_doc_id_is_internal && update_doc_ids_are_internal
  }));

  let projection_after = service
    .page_lifecycle_repair
    .inspect(workspace_id, external_id, DocLoadCancellation::default())
    .await
    .unwrap();
  assert_eq!(
    projection_after.findings, projection_before.findings,
    "normal lifecycle writes must preserve the bounded projection contract"
  );

  service.trash_page(workspace_id, doc_id, user_id).await.unwrap();
  let deleted = service
    .permanently_delete_documents(PermanentDeleteRequest {
      workspace_id,
      actor_user_id: Some(user_id),
      mode: PermanentDeleteMode::SelectedDocs,
      doc_ids: vec![external_id.to_string()],
    })
    .await
    .expect("permanent delete must resolve the external key once");
  assert_eq!(deleted.deleted, 1);
  assert_eq!(deleted.root_meta_removed, 1);
  assert_eq!(deleted.documents[0].resolved_doc_id, Some(doc_id));
  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  let remaining_ids = root_page_entry_ids(&root_state);
  assert!(!remaining_ids.contains(&external_id.to_string()));
  assert!(!remaining_ids.contains(&doc_id.to_string()));
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
    0
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn page_projection_exact_repair_preserves_external_root_key_without_uuid_shadow_entry() {
  let (pool, user_id, workspace_id, service) = setup_lifecycle("page-life-repair-external").await;
  let external_id = "browser-repair-NanoKey8Vm4QrT6";
  let doc_id = materialize_browser_page(&pool, workspace_id, user_id, external_id, "").await;
  let content = myoxus_application::markdown::markdown_to_yjs("", "Untitled content must survive repair.").unwrap();
  // Keep one valid page block while adding real content to the rootless fixture.
  sqlx::query("DELETE FROM doc_updates WHERE workspace_id=$1 AND doc_id=$2")
    .bind(workspace_id)
    .bind(doc_id)
    .execute(&pool)
    .await
    .unwrap();
  append_raw_update(&pool, workspace_id, doc_id, content).await;
  let leaf_before = service.load_full_doc(workspace_id, doc_id).await.unwrap();

  let clean = service
    .page_lifecycle_repair
    .inspect(workspace_id, external_id, DocLoadCancellation::default())
    .await
    .unwrap();
  assert!(clean.findings.is_empty());
  assert_eq!(clean.external_doc_id, external_id);

  service.trash_page(workspace_id, doc_id, user_id).await.unwrap();
  let deleted = service
    .page_lifecycle_repair
    .inspect(workspace_id, external_id, DocLoadCancellation::default())
    .await
    .unwrap();
  assert_eq!(deleted.is_trashed, Some(true));
  assert!(deleted.findings.is_empty());
  service.restore_page(workspace_id, doc_id, user_id).await.unwrap();

  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  let removal = yjs::remove_pages_from_root_doc(&root_state, &[external_id.to_string()]).unwrap();
  assert_eq!(removal.removed_entries, 1);
  append_raw_update(&pool, workspace_id, workspace_id, removal.update).await;
  let metadata_before = service.get_metadata(doc_id).await.unwrap().unwrap();
  let updates_before: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let outbox_before: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE aggregate_type = 'doc'")
    .fetch_one(&pool)
    .await
    .unwrap();

  let inspection = service
    .page_lifecycle_repair
    .inspect(workspace_id, external_id, DocLoadCancellation::default())
    .await
    .unwrap();
  assert!(inspection.fingerprint.starts_with("d0c1d01b20260828"));
  let finding = inspection
    .findings
    .iter()
    .find(|finding| finding.external_doc_id.as_deref() == Some(external_id))
    .expect("missing external root entry must be reported");
  assert_eq!(finding.drift_class, PageLifecycleDriftClass::MissingRootEntry);
  assert!(finding.repairable);
  assert_eq!(finding.external_doc_id.as_deref(), Some(external_id));
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_updates WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
    updates_before,
    "audit must remain read-only"
  );

  let preview = service
    .page_lifecycle_repair
    .repair_exact(
      workspace_id,
      external_id,
      user_id,
      &inspection.fingerprint,
      PageLifecycleRepairMode::DryRun,
      DocLoadCancellation::default(),
    )
    .await
    .unwrap();
  assert!(!preview.changed);
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_updates WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
    updates_before,
    "dry-run must not write"
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM outbox_events WHERE aggregate_type = 'doc'")
      .fetch_one(&pool)
      .await
      .unwrap(),
    outbox_before,
    "dry-run must not emit an outbox event"
  );

  let applied = service
    .page_lifecycle_repair
    .repair_exact(
      workspace_id,
      external_id,
      user_id,
      &inspection.fingerprint,
      PageLifecycleRepairMode::Apply,
      DocLoadCancellation::default(),
    )
    .await
    .unwrap();
  assert!(applied.changed);
  assert!(applied.commit.as_ref().unwrap().leaf_sequence.is_none());
  assert_eq!(service.load_full_doc(workspace_id, doc_id).await.unwrap(), leaf_before);
  let metadata_after = service.get_metadata(doc_id).await.unwrap().unwrap();
  assert_eq!(metadata_after.created_at, metadata_before.created_at);
  assert_eq!(metadata_after.updated_at, metadata_before.updated_at);
  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  let root_ids = root_page_entry_ids(&root_state);
  assert_eq!(root_ids.iter().filter(|id| id.as_str() == external_id).count(), 1);
  assert!(!root_ids.contains(&doc_id.to_string()));

  let repeated = service
    .page_lifecycle_repair
    .repair_exact(
      workspace_id,
      external_id,
      user_id,
      &inspection.fingerprint,
      PageLifecycleRepairMode::Apply,
      DocLoadCancellation::default(),
    )
    .await
    .expect("repeated dual-ID apply must be a no-op");
  assert!(!repeated.changed);
  assert!(repeated.commit.is_none());
  let post = service
    .page_lifecycle_repair
    .inspect(workspace_id, external_id, DocLoadCancellation::default())
    .await
    .unwrap();
  assert!(post.findings.is_empty());
  assert_eq!(post.normalized_title.as_deref(), Some(""));
  service.trash_page(workspace_id, doc_id, user_id).await.unwrap();
  assert!(
    service
      .get_metadata_including_deleted(doc_id)
      .await
      .unwrap()
      .unwrap()
      .deleted_at
      .is_some()
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn page_projection_exact_inspection_refuses_ambiguous_external_observations_and_stale_state() {
  let (pool, user_id, workspace_id, service) = setup_lifecycle("page-life-repair-ambiguity").await;
  let nano_external_id = "browser-audit-NanoKey4Ks8WxP3";
  let nano_doc_id =
    materialize_browser_page(&pool, workspace_id, user_id, nano_external_id, "Nano collision owner").await;
  let uuid_shaped_external_id = nano_doc_id.to_string();
  let uuid_shaped_doc_id = materialize_browser_page(
    &pool,
    workspace_id,
    user_id,
    &uuid_shaped_external_id,
    "UUID-shaped external match",
  )
  .await;
  assert_ne!(uuid_shaped_doc_id, nano_doc_id);

  let repair_target = service
    .create_page_lifecycle(workspace_id, user_id, Some("Legacy report target".to_string()), None)
    .await
    .unwrap()
    .document
    .id;
  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  let missing_root = yjs::remove_pages_from_root_doc(&root_state, &[repair_target.to_string()]).unwrap();
  append_raw_update(&pool, workspace_id, workspace_id, missing_root.update).await;

  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  let ambiguous_entries = append_raw_root_pages_update(
    &root_state,
    &[
      (nano_external_id.to_string(), "Duplicate external key".to_string()),
      (
        "genuine-non-uuid-orphan".to_string(),
        "Unmatched root evidence".to_string(),
      ),
    ],
  );
  append_raw_update(&pool, workspace_id, workspace_id, ambiguous_entries).await;

  let updates_before: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let uuid_shaped = service
    .page_lifecycle_repair
    .inspect(workspace_id, &uuid_shaped_external_id, DocLoadCancellation::default())
    .await
    .unwrap();
  assert!(uuid_shaped.sql_present && uuid_shaped.root_present && uuid_shaped.leaf_present);
  assert!(
    uuid_shaped.findings.is_empty(),
    "an exact external match must win over UUID syntax"
  );

  let duplicate = service
    .page_lifecycle_repair
    .inspect(workspace_id, nano_external_id, DocLoadCancellation::default())
    .await
    .unwrap();
  let duplicate_finding = duplicate
    .findings
    .iter()
    .find(|finding| finding.drift_class == PageLifecycleDriftClass::Orphan)
    .expect("duplicate root key must remain explicit evidence");
  assert!(!duplicate_finding.repairable);
  assert_eq!(duplicate_finding.external_doc_id.as_deref(), Some(nano_external_id));

  let genuine_orphan = service
    .page_lifecycle_repair
    .inspect(workspace_id, "genuine-non-uuid-orphan", DocLoadCancellation::default())
    .await
    .unwrap();
  assert!(!genuine_orphan.sql_present);
  assert!(genuine_orphan.root_present);
  assert!(genuine_orphan.findings.iter().all(|finding| !finding.repairable));

  let duplicate_apply = service
    .page_lifecycle_repair
    .repair_exact(
      workspace_id,
      nano_external_id,
      user_id,
      &duplicate.fingerprint,
      PageLifecycleRepairMode::Apply,
      DocLoadCancellation::default(),
    )
    .await
    .expect_err("duplicate external observations must never reach repair writes");
  assert!(
    duplicate_apply
      .to_string()
      .contains("MIX_PAGE_REPAIR_TARGET_NOT_REPAIRABLE")
  );

  let repair_inspection = service
    .page_lifecycle_repair
    .inspect(workspace_id, &repair_target.to_string(), DocLoadCancellation::default())
    .await
    .unwrap();
  sqlx::query("UPDATE docs SET title = 'Concurrent target change' WHERE id = $1")
    .bind(repair_target)
    .execute(&pool)
    .await
    .unwrap();
  let stale = service
    .page_lifecycle_repair
    .repair_exact(
      workspace_id,
      &repair_target.to_string(),
      user_id,
      &repair_inspection.fingerprint,
      PageLifecycleRepairMode::DryRun,
      DocLoadCancellation::default(),
    )
    .await
    .expect_err("a changed exact inspection fingerprint must fail closed");
  assert!(stale.to_string().contains("MIX_PAGE_REPAIR_REPORT_STALE"));
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_updates WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
    updates_before,
    "ambiguity refusal and stale repair must not append Yjs updates"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn page_lifecycle_trash_permissions_preserve_uuid_and_external_restore_contract() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "page-life-trash-owner").await;
  let (reader_id, reader_session) = helpers::seed_user(&pool, &auth_store, "page-life-trash-reader").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Reader', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(reader_id)
  .execute(&pool)
  .await
  .expect("reader membership must persist");

  let uuid_default_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let external_doc_id = Uuid::new_v4();
  let external_key = "browser-trash-NanoKey5Hd8LpQ2";
  sqlx::query(
    "INSERT INTO docs (id, external_id, workspace_id, title, is_workspace_root, created_by, updated_by, deleted_at)
     VALUES ($1, $2, $3, 'External trash fixture', false, $4, $4, now())",
  )
  .bind(external_doc_id)
  .bind(external_key)
  .bind(workspace_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("external trash fixture must persist");
  sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
    .bind(uuid_default_id)
    .execute(&pool)
    .await
    .expect("UUID-default fixture must enter trash");

  let query = "query TrashPermissions($workspaceId: String!, $docId: String!) {
    workspace(id: $workspaceId) {
      doc(docId: $docId) {
        id
        title
        summary
        permissions { Doc_Read Doc_Restore Doc_Delete }
      }
    }
  }";
  for document_key in [uuid_default_id.to_string(), external_key.to_string()] {
    let owner_response = helpers::gql(
      &app,
      owner_session,
      serde_json::json!({
        "query": query,
        "variables": { "workspaceId": workspace_id.to_string(), "docId": document_key.clone() }
      }),
    )
    .await;
    assert!(
      owner_response.get("errors").is_none(),
      "an owner must resolve trash lifecycle permissions: {owner_response}"
    );
    let document = &owner_response["data"]["workspace"]["doc"];
    assert_eq!(document["id"], document_key);
    assert!(document["title"].is_string());
    assert!(
      document["summary"].is_null(),
      "trash metadata must not load document content"
    );
    assert_eq!(document["permissions"]["Doc_Read"], true);
    assert_eq!(document["permissions"]["Doc_Restore"], true);
    assert_eq!(document["permissions"]["Doc_Delete"], true);

    let reader_response = helpers::gql(
      &app,
      reader_session,
      serde_json::json!({
        "query": query,
        "variables": { "workspaceId": workspace_id.to_string(), "docId": document_key.clone() }
      }),
    )
    .await;
    assert!(
      reader_response.get("errors").is_some(),
      "a reader must not gain trash lifecycle metadata or permissions: {reader_response}"
    );
  }

  helpers::cleanup_users(&pool, &[owner_id, reader_id]).await;
}

#[tokio::test]
async fn page_lifecycle_rolls_back_create_when_root_write_fails() {
  let (pool, user_id, workspace_id, service) = setup_lifecycle("page-life-rollback").await;
  let root_sequence_before = sequence(&pool, workspace_id, workspace_id).await;
  let (trigger, function) = install_insert_failure(&pool, workspace_id).await;
  let result = service
    .create_page_lifecycle(workspace_id, user_id, Some("Must roll back".to_string()), None)
    .await;
  remove_insert_failure(&pool, &trigger, &function).await;

  assert!(result.is_err(), "injected root failure must fail the lifecycle call");
  let partial_docs: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1 AND title = $2")
    .bind(workspace_id)
    .bind("Must roll back")
    .fetch_one(&pool)
    .await
    .expect("partial metadata check must succeed");
  assert_eq!(
    partial_docs, 0,
    "metadata and leaf writes before the root failure must roll back"
  );
  assert_eq!(sequence(&pool, workspace_id, workspace_id).await, root_sequence_before);

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn page_lifecycle_rolls_back_yjs_deltas_when_metadata_update_fails() {
  let (pool, user_id, workspace_id, service) = setup_lifecycle("page-life-update-rollback").await;
  let created = service
    .create_page_lifecycle(workspace_id, user_id, Some("Stable title".to_string()), None)
    .await
    .expect("setup create must commit");
  let doc_id = created.document.id;
  let leaf_sequence_before = sequence(&pool, workspace_id, doc_id).await;
  let root_sequence_before = sequence(&pool, workspace_id, workspace_id).await;

  let (trigger, function) = install_metadata_update_failure(&pool, doc_id).await;
  let rename = service
    .rename_page(workspace_id, doc_id, user_id, "Rejected rename".to_string(), None)
    .await;
  remove_metadata_update_failure(&pool, &trigger, &function).await;
  assert!(rename.is_err(), "injected final metadata failure must reject rename");
  assert_eq!(sequence(&pool, workspace_id, doc_id).await, leaf_sequence_before);
  assert_eq!(sequence(&pool, workspace_id, workspace_id).await, root_sequence_before);
  let leaf_state = service
    .load_full_doc(workspace_id, doc_id)
    .await
    .expect("leaf must load");
  assert_eq!(
    yjs::extract_text_from_yjs(&leaf_state).unwrap().title.as_deref(),
    Some("Stable title")
  );
  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  assert_eq!(root_page_projection(&root_state, doc_id).0, "Stable title");

  let (trigger, function) = install_metadata_update_failure(&pool, doc_id).await;
  let trash = service.trash_page(workspace_id, doc_id, user_id).await;
  remove_metadata_update_failure(&pool, &trigger, &function).await;
  assert!(trash.is_err(), "injected final metadata failure must reject trash");
  assert_eq!(sequence(&pool, workspace_id, workspace_id).await, root_sequence_before);
  assert!(service.get_metadata(doc_id).await.unwrap().is_some());
  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  assert!(!root_page_projection(&root_state, doc_id).1);

  service
    .trash_page(workspace_id, doc_id, user_id)
    .await
    .expect("setup trash must commit");
  let trashed_root_sequence = sequence(&pool, workspace_id, workspace_id).await;
  let (trigger, function) = install_metadata_update_failure(&pool, doc_id).await;
  let restore = service.restore_page(workspace_id, doc_id, user_id).await;
  remove_metadata_update_failure(&pool, &trigger, &function).await;
  assert!(restore.is_err(), "injected final metadata failure must reject restore");
  assert_eq!(sequence(&pool, workspace_id, workspace_id).await, trashed_root_sequence);
  assert!(
    service
      .get_metadata_including_deleted(doc_id)
      .await
      .unwrap()
      .unwrap()
      .deleted_at
      .is_some()
  );
  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  assert!(root_page_projection(&root_state, doc_id).1);

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn page_lifecycle_serializes_parallel_create_and_rename_operations() {
  let (pool, user_id, workspace_id, service) = setup_lifecycle("page-life-concurrent").await;
  let (first, second) = tokio::join!(
    service.create_page_lifecycle(workspace_id, user_id, Some("Concurrent A".to_string()), None),
    service.create_page_lifecycle(workspace_id, user_id, Some("Concurrent B".to_string()), None),
  );
  let first = first.expect("first create must commit");
  let second = second.expect("second create must commit");
  let root_state = service
    .load_full_doc(workspace_id, workspace_id)
    .await
    .expect("root after concurrent creates must load");
  let entries = yjs::extract_page_trash_state(&root_state).expect("root pages must project");
  assert!(entries.iter().any(|entry| entry.id == first.document.id.to_string()));
  assert!(entries.iter().any(|entry| entry.id == second.document.id.to_string()));

  let doc_id = first.document.id;
  let (rename_a, rename_b) = tokio::join!(
    service.rename_page(workspace_id, doc_id, user_id, "Rename winner A".to_string(), None),
    service.rename_page(workspace_id, doc_id, user_id, "Rename winner B".to_string(), None),
  );
  rename_a.expect("first rename must commit");
  rename_b.expect("second rename must commit");
  let metadata = service
    .get_metadata(doc_id)
    .await
    .unwrap()
    .expect("renamed metadata must exist");
  let leaf_state = service
    .load_full_doc(workspace_id, doc_id)
    .await
    .expect("renamed leaf must load");
  let leaf_title = yjs::extract_text_from_yjs(&leaf_state)
    .expect("renamed leaf must project")
    .title
    .expect("renamed leaf must have a title");
  let root_state = service
    .load_full_doc(workspace_id, workspace_id)
    .await
    .expect("renamed root must load");
  let root_title = root_page_projection(&root_state, doc_id).0;
  assert_eq!(metadata.title, leaf_title);
  assert_eq!(metadata.title, root_title);
  assert!(matches!(metadata.title.as_str(), "Rename winner A" | "Rename winner B"));

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn failed_page_lifecycle_records_failure_without_committed_outcome() {
  let (pool, user_id, workspace_id, service) = setup_lifecycle("page-life-metric").await;
  let metrics = Arc::new(MetricsService::in_memory_stub());
  let mut policy = MetricsPolicy {
    enabled: true,
    categories: HashMap::new(),
    label_workspace_id_enabled: false,
    cardinality_limit_per_metric: 100,
  };
  for category in METRICS_CATEGORIES {
    policy.categories.insert((*category).to_string(), true);
  }
  metrics.set_policy(policy);
  let service = service.with_metrics_service(metrics.clone());
  sqlx::query(
    "INSERT INTO user_preferences (user_id, values)
     VALUES ($1, '{\"defaultDocumentLanguage\":\"de\"}'::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET values = EXCLUDED.values, updated_at = now()",
  )
  .bind(user_id)
  .execute(&pool)
  .await
  .unwrap();
  let (trigger, function) = install_insert_failure(&pool, workspace_id).await;
  let result = service
    .create_page_lifecycle(workspace_id, user_id, Some("Metric failure".to_string()), None)
    .await;
  remove_insert_failure(&pool, &trigger, &function).await;
  assert!(result.is_err());
  let rendered = metrics.render_prometheus();
  assert!(
    rendered.contains("myoxus_metric_collab_page_lifecycle_total"),
    "lifecycle metric must be exported: {rendered}"
  );
  assert!(
    rendered.contains("outcome=\"failed\""),
    "failure outcome must be exported: {rendered}"
  );
  assert!(
    !rendered.contains("outcome=\"committed\""),
    "a failed transaction must not record a committed outcome: {rendered}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn projection_exact_repair_handles_all_safe_drift_and_second_apply_writes_nothing() {
  let (pool, user_id, workspace_id, service) = setup_lifecycle("page-life-repair").await;
  let metrics = Arc::new(MetricsService::in_memory_stub());
  let mut policy = MetricsPolicy {
    enabled: true,
    categories: HashMap::new(),
    label_workspace_id_enabled: false,
    cardinality_limit_per_metric: 100,
  };
  for category in METRICS_CATEGORIES {
    policy.categories.insert((*category).to_string(), true);
  }
  metrics.set_policy(policy);
  let service = service.with_metrics_service(metrics.clone());

  let mut created = Vec::new();
  for title in ["Missing root", "Missing leaf", "Title drift", "Trash drift"] {
    created.push(
      service
        .create_page_lifecycle(workspace_id, user_id, Some(title.to_string()), None)
        .await
        .expect("repair fixture page must be created")
        .document
        .id,
    );
  }
  let [missing_root, missing_leaf, title_drift, trash_drift] = created.as_slice() else {
    panic!("four fixture pages expected")
  };
  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  let removal = yjs::remove_pages_from_root_doc(&root_state, &[missing_root.to_string()]).unwrap();
  append_raw_update(&pool, workspace_id, workspace_id, removal.update).await;
  sqlx::query("DELETE FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2")
    .bind(workspace_id)
    .bind(missing_leaf)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("UPDATE docs SET title = 'Wrong SQL title' WHERE id = $1")
    .bind(title_drift)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
    .bind(trash_drift)
    .execute(&pool)
    .await
    .unwrap();

  let missing_sql = Uuid::new_v4();
  let foreign_workspace = helpers::create_workspace(&pool, user_id).await;
  WorkspaceService::new(Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  )))
  .seed_root_doc(
    foreign_workspace,
    user_id,
    yjs::create_initial_workspace_doc("Foreign lifecycle workspace"),
  )
  .await
  .unwrap();
  let foreign_doc = service
    .create_page_lifecycle(foreign_workspace, user_id, Some("Foreign page".to_string()), None)
    .await
    .unwrap()
    .document
    .id;
  let root_state = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  let root_only = yjs::add_pages_to_root_doc(
    &[root_state],
    &[
      (missing_sql.to_string(), "Root-only page".to_string()),
      ("invalid-page-identity".to_string(), "Ambiguous orphan".to_string()),
      (foreign_doc.to_string(), "Cross-workspace collision".to_string()),
    ],
  )
  .unwrap();
  append_raw_update(&pool, workspace_id, workspace_id, root_only).await;

  let update_count_before_audit: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let outbox_before_audit: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE aggregate_type = 'doc'")
    .fetch_one(&pool)
    .await
    .unwrap();
  let evidence = scan_all(&service, workspace_id, 2).await;
  let classes = evidence
    .iter()
    .flat_map(|item| item.findings.iter().map(|finding| finding.drift_class))
    .collect::<std::collections::BTreeSet<_>>();
  for expected in [
    PageLifecycleDriftClass::MissingRootEntry,
    PageLifecycleDriftClass::MissingSqlMetadata,
    PageLifecycleDriftClass::MissingLeaf,
    PageLifecycleDriftClass::TitleMismatch,
    PageLifecycleDriftClass::TrashMismatch,
    PageLifecycleDriftClass::Orphan,
  ] {
    assert!(classes.contains(&expected), "scan must classify {expected:?}");
  }
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_updates WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
    update_count_before_audit,
    "bounded scan must not write Yjs updates"
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM outbox_events WHERE aggregate_type = 'doc'")
      .fetch_one(&pool)
      .await
      .unwrap(),
    outbox_before_audit,
    "bounded scan must not write outbox events"
  );

  let selected = [
    missing_root.to_string(),
    missing_leaf.to_string(),
    title_drift.to_string(),
    trash_drift.to_string(),
    missing_sql.to_string(),
  ];
  let mut inspections = Vec::new();
  for external_doc_id in &selected {
    let inspection = service
      .page_lifecycle_repair
      .inspect(workspace_id, external_doc_id, DocLoadCancellation::default())
      .await
      .unwrap();
    assert!(inspection.findings.iter().any(|finding| finding.repairable));
    let preview = service
      .page_lifecycle_repair
      .repair_exact(
        workspace_id,
        external_doc_id,
        user_id,
        &inspection.fingerprint,
        PageLifecycleRepairMode::DryRun,
        DocLoadCancellation::default(),
      )
      .await
      .unwrap();
    assert!(!preview.changed);
    inspections.push(inspection);
  }
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_updates WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
    update_count_before_audit,
    "exact dry-runs must not write"
  );

  for inspection in &inspections {
    let applied = service
      .page_lifecycle_repair
      .repair_exact(
        workspace_id,
        &inspection.external_doc_id,
        user_id,
        &inspection.fingerprint,
        PageLifecycleRepairMode::Apply,
        DocLoadCancellation::default(),
      )
      .await
      .unwrap();
    assert!(applied.changed);
  }
  let outbox_after_apply: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE aggregate_type = 'doc'")
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(outbox_after_apply - outbox_before_audit, selected.len() as i64);
  let update_count_after_apply: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let repaired_language: Option<Uuid> = sqlx::query_scalar("SELECT language_id FROM docs WHERE id = $1")
    .bind(missing_sql)
    .fetch_one(&pool)
    .await
    .unwrap();
  let lifecycle_language: Option<Uuid> = sqlx::query_scalar("SELECT language_id FROM docs WHERE id = $1")
    .bind(missing_root)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert!(repaired_language.is_some());
  assert_eq!(repaired_language, lifecycle_language);

  for inspection in inspections {
    let replay = service
      .page_lifecycle_repair
      .repair_exact(
        workspace_id,
        &inspection.external_doc_id,
        user_id,
        &inspection.fingerprint,
        PageLifecycleRepairMode::Apply,
        DocLoadCancellation::default(),
      )
      .await
      .expect("repeating a completed exact repair must be a no-op");
    assert!(!replay.changed);
    assert!(replay.commit.is_none());
  }
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_updates WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
    update_count_after_apply
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM outbox_events WHERE aggregate_type = 'doc'")
      .fetch_one(&pool)
      .await
      .unwrap(),
    outbox_after_apply
  );
  let post = scan_all(&service, workspace_id, 2).await;
  let remaining = post.iter().flat_map(|item| item.findings.iter()).collect::<Vec<_>>();
  assert!(
    remaining
      .iter()
      .all(|finding| finding.drift_class == PageLifecycleDriftClass::Orphan && !finding.repairable),
    "only explicitly non-repairable orphan identities may remain: {remaining:?}"
  );
  let rendered = metrics.render_prometheus();
  assert!(rendered.contains("myoxus_metric_collab_page_lifecycle_repair_total"));
  assert!(rendered.contains("outcome=\"previewed\""));
  assert!(rendered.contains("outcome=\"repaired\""));
  assert!(rendered.contains("outcome=\"unchanged\""));

  helpers::cleanup_users(&pool, &[user_id]).await;
}
