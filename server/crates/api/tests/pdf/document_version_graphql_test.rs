// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for the document-version GraphQL surface.
//!
//! These queries serve document history and the PDF export version picker. Read operations must be workspace-read scoped and return
//! defaults for missing settings without creating database artefacts; write
//! operations must be doc-permission scoped and avoid partial snapshot rows on
//! validation/conflict failures.

use crate::helpers;
use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;
use yrs::{Any, Array as _, Doc, Map as _, MapPrelim, ReadTxn as _, Transact as _};
use yrs::{Text as _, updates::decoder::Decode as _};

use myoxus_application::doc::DocService;
use myoxus_application::document_version::{
  AutoVersionOutcome, DocumentVersionAutoTriggerRequest, DocumentVersionAutoTriggerService,
};
use myoxus_domain::entities::AutoVersionTrigger;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::document_version::{PgDocumentVersionRepository, PgDocumentVersioningSettingsRepository};
use myoxus_infrastructure::storage::StorageAdapter;

async fn setup_app() -> (axum::Router, PgPool, Arc<myoxus_infrastructure::auth::SqlxAuthStore>) {
  use myoxus_api::build_router_for_integration_tests as build_router;
  use myoxus_api::config::AppConfig;
  use myoxus_api::state::ApiState;
  use myoxus_application::admin::AdminService;
  use myoxus_application::auth::AuthService;
  use myoxus_application::doc::DocService;
  use myoxus_application::ports::blob_service::BlobService;
  use myoxus_application::workspace::WorkspaceService;
  use myoxus_infrastructure::admin::SqlxAdminStore;
  use myoxus_infrastructure::auth::SqlxAuthStore;
  use myoxus_infrastructure::blob::SqlxBlobStore;
  use myoxus_infrastructure::doc::SqlxDocStore;
  use myoxus_infrastructure::mail::LogMailAdapter;
  use myoxus_infrastructure::workspace::SqlxWorkspaceStore;

  let pool = helpers::setup_pool().await;
  let config = AppConfig::load().expect("config");
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("storage"));
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let blob_service = Arc::new(BlobService::new(blob_store, storage.clone(), "test-key".to_string()));

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
  let version_repo: Arc<dyn myoxus_domain::repositories::DocumentVersionRepository> =
    Arc::new(PgDocumentVersionRepository::new(pool.clone()));
  let settings_repo: Arc<dyn myoxus_domain::repositories::DocumentVersioningSettingsRepository> =
    Arc::new(PgDocumentVersioningSettingsRepository::new(pool.clone()));

  let state = ApiState::with_services(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    blob_service,
    storage,
  )
  .with_metrics_pool(pool.clone())
  .with_document_version_repo(version_repo)
  .with_document_version_settings_repo(settings_repo);

  (build_router(state), pool, auth_store)
}

async fn insert_version(pool: &PgPool, workspace_id: Uuid, doc_id: Uuid, actor_id: Uuid, label: &str) -> Uuid {
  let history_id: i64 =
    sqlx::query_scalar("INSERT INTO doc_histories (doc_id, workspace_id, snapshot) VALUES ($1, $2, $3) RETURNING id")
      .bind(doc_id)
      .bind(workspace_id)
      // [0, 0] is a valid empty Yjs v1 update. Restore tests exercise the
      // real decoder path, so arbitrary bytes would make the fixture invalid.
      .bind(vec![0_u8, 0])
      .fetch_one(pool)
      .await
      .expect("insert doc history");
  let version_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO document_version \
     (id, doc_id, workspace_id, doc_history_id, label, description, created_by, is_pinned) \
     VALUES ($1, $2, $3, $4, $5, $6, $7, true)",
  )
  .bind(version_id)
  .bind(doc_id)
  .bind(workspace_id)
  .bind(history_id)
  .bind(label)
  .bind("Created by document_version_graphql_test")
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("insert document version");
  version_id
}

async fn insert_version_with_snapshot(
  pool: &PgPool,
  workspace_id: Uuid,
  doc_id: Uuid,
  actor_id: Uuid,
  label: &str,
  snapshot: Vec<u8>,
) -> Uuid {
  let history_id: i64 =
    sqlx::query_scalar("INSERT INTO doc_histories (doc_id, workspace_id, snapshot) VALUES ($1, $2, $3) RETURNING id")
      .bind(doc_id)
      .bind(workspace_id)
      .bind(snapshot)
      .fetch_one(pool)
      .await
      .expect("insert doc history");
  let version_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO document_version \
     (id, doc_id, workspace_id, doc_history_id, label, description, created_by, is_pinned) \
     VALUES ($1, $2, $3, $4, $5, $6, $7, false)",
  )
  .bind(version_id)
  .bind(doc_id)
  .bind(workspace_id)
  .bind(history_id)
  .bind(label)
  .bind("Created by document version diff fixture")
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("insert document version");
  version_id
}

fn build_doc_version_yjs(blocks: &[(&str, &str)]) -> Vec<u8> {
  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();

  blocks_map.insert(&mut txn, "page-1", MapPrelim::default());
  let page_map = match blocks_map.get(&txn, "page-1") {
    Some(yrs::Out::YMap(map)) => map,
    _ => panic!("page-1 missing"),
  };
  page_map.insert(&mut txn, "sys:flavour", "myoxus:page");
  page_map.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  let children = match page_map.get(&txn, "sys:children") {
    Some(yrs::Out::YArray(array)) => array,
    _ => panic!("sys:children missing"),
  };

  for (id, text) in blocks {
    children.push_back(&mut txn, Any::String((*id).into()));
    blocks_map.insert(&mut txn, *id, MapPrelim::default());
    let block_map = match blocks_map.get(&txn, id) {
      Some(yrs::Out::YMap(map)) => map,
      _ => panic!("block missing"),
    };
    block_map.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
    block_map.insert(&mut txn, "prop:text", yrs::TextPrelim::new(*text));
    block_map.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  }

  drop(txn);
  doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
}

#[tokio::test]
async fn inv_docver_pdf_capture_binds_nonempty_snapshot_and_canonical_head() {
  use crate::pdf_export_v2_mutation_test::{
    assign_template, insert_template_with_manifest, manifest_permissive, setup_app,
  };
  use yrs::{Text as _, Update, updates::decoder::Decode as _};

  let (app, pool, auth_store) = setup_app().await;
  let (actor, session) = helpers::seed_user(&pool, &auth_store, "pdf-snapshot-capture").await;
  let ws = helpers::create_workspace(&pool, actor).await;
  let doc = helpers::create_doc(&pool, ws, actor).await;
  enable_pdf_auto_versioning(&pool, doc).await;
  let slug = format!("history-pdf-{}", Uuid::new_v4().simple());
  let template = insert_template_with_manifest(&pool, &slug, manifest_permissive(&slug), actor).await;
  assign_template(&pool, ws, template, actor).await;
  let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let original = build_doc_version_yjs(&[("pdf-paragraph", "Snapshot A: retain this exact exported content.")]);
  service
    .push_update(
      ws,
      doc,
      original.clone(),
      1,
      myoxus_application::doc::DocSpaceKind::Workspace,
    )
    .await
    .expect("persist content before export");
  let expected = service.load_full_doc(ws, doc).await.expect("export content A");

  let export = |selector: String| {
    json!({
      "query":"mutation($input: PdfExportInputV2Input!) { exportPdf(input:$input) { id status } }",
      "variables":{"input":{"workspaceId":ws.to_string(),"docId":doc.to_string(),"templateId":template.to_string(),"documentVersionId":selector}}
    })
  };
  let first = helpers::gql(&app, session, export("latest".into())).await;
  assert!(first.get("errors").is_none(), "{first}");
  let first_job = Uuid::parse_str(
    first
      .pointer("/data/exportPdf/id")
      .and_then(Value::as_str)
      .expect("latest job"),
  )
  .expect("job UUID");
  let captured: (Uuid, i64, i64, Vec<u8>, bool) = sqlx::query_as(
    "SELECT v.id, v.doc_history_id, v.version_no, h.snapshot, d.dirty_since_current_version
     FROM docs d JOIN document_version v ON v.id=d.current_version_id
     JOIN doc_histories h ON h.id=v.doc_history_id WHERE d.id=$1 AND v.event='pdf_export' AND v.kind='exported'",
  )
  .bind(doc)
  .fetch_one(&pool)
  .await
  .expect("export canonical version head");
  assert_eq!(captured.2, 1);
  assert_eq!(
    captured.3, expected,
    "latest export must capture nonempty server content A"
  );
  assert!(!captured.4);

  let ydoc = Doc::new();
  let change = {
    let blocks = ydoc.get_or_insert_map("blocks");
    let mut txn = ydoc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&original).expect("decode original"))
      .expect("load original");
    let Some(yrs::Out::YMap(paragraph)) = blocks.get(&txn, "pdf-paragraph") else {
      panic!("paragraph missing")
    };
    let Some(yrs::Out::YText(text)) = paragraph.get(&txn, "prop:text") else {
      panic!("text missing")
    };
    text.insert(&mut txn, 0, "Live state B. ");
    txn.encode_update_v1()
  };
  service
    .push_update(ws, doc, change, 2, myoxus_application::doc::DocSpaceKind::Workspace)
    .await
    .expect("change live content after export");
  assert_ne!(service.load_full_doc(ws, doc).await.expect("live B"), expected);
  let edited_head: (Uuid, bool, i64) =
    sqlx::query_as("SELECT current_version_id, dirty_since_current_version, metadata_revision FROM docs WHERE id=$1")
      .bind(doc)
      .fetch_one(&pool)
      .await
      .expect("canonical head after acknowledged content edit");
  assert_eq!(edited_head.0, captured.0, "editing must retain the named head");
  assert!(edited_head.1, "persisted live B must mark captured A as changed");
  let second = helpers::gql(&app, session, export(captured.0.to_string())).await;
  assert!(second.get("errors").is_none(), "{second}");
  let second_job = Uuid::parse_str(
    second
      .pointer("/data/exportPdf/id")
      .and_then(Value::as_str)
      .expect("explicit job"),
  )
  .expect("job UUID");
  for job in [first_job, second_job] {
    let (inputs, audit_version): (Value, Option<Uuid>) = sqlx::query_as(
      "SELECT j.render_inputs, a.document_version_id FROM pdf_export_jobs j JOIN pdf_export_render_audit a ON a.job_id=j.id WHERE j.id=$1",
    ).bind(job).fetch_one(&pool).await.expect("persisted render binding");
    assert_eq!(inputs.get("doc_history_id").and_then(Value::as_i64), Some(captured.1));
    assert_eq!(audit_version, Some(captured.0));
  }
  let (versions, histories): (i64, i64) = sqlx::query_as(
    "SELECT (SELECT COUNT(*) FROM document_version WHERE doc_id=$1), (SELECT COUNT(*) FROM doc_histories WHERE doc_id=$1)",
  ).bind(doc).fetch_one(&pool).await.expect("capture count after explicit export");
  assert_eq!(
    (versions, histories),
    (1, 1),
    "explicit export must not capture B or move the version head"
  );
  let exported_head: (Uuid, bool, i64) =
    sqlx::query_as("SELECT current_version_id, dirty_since_current_version, metadata_revision FROM docs WHERE id=$1")
      .bind(doc)
      .fetch_one(&pool)
      .await
      .expect("canonical head after explicit historical export");
  assert_eq!(exported_head, edited_head, "exporting A must not clear B's dirty state");

  sqlx::query("DELETE FROM pdf_export_render_audit WHERE workspace_id=$1")
    .bind(ws)
    .execute(&pool)
    .await
    .expect("cleanup export audit");
  sqlx::query("DELETE FROM pdf_export_jobs WHERE workspace_id=$1")
    .bind(ws)
    .execute(&pool)
    .await
    .expect("cleanup export jobs");
  sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE workspace_id=$1")
    .bind(ws)
    .execute(&pool)
    .await
    .expect("cleanup template assignment");
  sqlx::query("DELETE FROM pdf_templates WHERE id=$1")
    .bind(template)
    .execute(&pool)
    .await
    .expect("cleanup template");
  helpers::cleanup_users(&pool, &[actor]).await;
  let remaining: (i64, i64) =
    sqlx::query_as("SELECT (SELECT COUNT(*) FROM users WHERE id=$1), (SELECT COUNT(*) FROM workspaces WHERE id=$2)")
      .bind(actor)
      .bind(ws)
      .fetch_one(&pool)
      .await
      .expect("verify fixture cleanup");
  assert_eq!(
    remaining,
    (0, 0),
    "capture/export fixtures must not retain their actor or workspace"
  );
}

async fn enable_pdf_auto_versioning(pool: &PgPool, doc_id: Uuid) {
  enable_auto_versioning(pool, doc_id, &["on-pdf-export"]).await;
}

async fn enable_auto_versioning(pool: &PgPool, doc_id: Uuid, triggers: &[&str]) {
  sqlx::query(
    "INSERT INTO document_versioning_settings (doc_id, enabled, auto_version_on, retention_count) \
     VALUES ($1, true, $2, 25)",
  )
  .bind(doc_id)
  .bind(triggers.iter().map(|trigger| trigger.to_string()).collect::<Vec<_>>())
  .execute(pool)
  .await
  .expect("insert document versioning settings");
}

async fn insert_original_doc(pool: &PgPool, workspace_id: Uuid, actor_id: Uuid, external_id: &str) -> Uuid {
  let doc_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, external_id, default_role, is_workspace_root, created_by, updated_by) \
     VALUES ($1, $2, $3, $4, 'viewer', false, $5, $5)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(format!("doc-{external_id}"))
  .bind(external_id)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("insert original-id doc");
  doc_id
}

fn errors_array(body: &Value) -> Vec<String> {
  body
    .get("errors")
    .and_then(Value::as_array)
    .map(|arr| {
      arr
        .iter()
        .filter_map(|err| err.get("message").and_then(Value::as_str).map(str::to_owned))
        .collect()
    })
    .unwrap_or_default()
}

#[tokio::test]
async fn inv_docver_gql01_lists_versions_and_settings_for_workspace_member() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql01").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let version_id = insert_version(&pool, workspace_id, doc_id, alice_id, "reviewed-v1").await;
  enable_pdf_auto_versioning(&pool, doc_id).await;

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "query Q($workspaceId: ID!, $docId: ID!, $versionId: ID!) { \
        documentVersions(workspaceId: $workspaceId, docId: $docId) { id docId label description isPinned docHistoryId createdBy } \
        documentVersion(id: $versionId) { id label isPinned } \
        documentVersioningSettings(workspaceId: $workspaceId, docId: $docId) { docId enabled retentionCount autoVersionOn } \
      }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string(), "versionId": version_id.to_string() }
    }),
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "INV-DOCVER-GQL-01: member must read document versions/settings: {body}"
  );
  assert_eq!(
    body.pointer("/data/documentVersions/0/id").and_then(Value::as_str),
    Some(version_id.to_string().as_str())
  );
  assert_eq!(
    body.pointer("/data/documentVersions/0/label").and_then(Value::as_str),
    Some("reviewed-v1")
  );
  assert_eq!(
    body.pointer("/data/documentVersion/label").and_then(Value::as_str),
    Some("reviewed-v1")
  );
  assert_eq!(
    body
      .pointer("/data/documentVersioningSettings/enabled")
      .and_then(Value::as_bool),
    Some(true)
  );
  assert_eq!(
    body
      .pointer("/data/documentVersioningSettings/autoVersionOn/0")
      .and_then(Value::as_str),
    Some("on_pdf_export")
  );

  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[tokio::test]
async fn inv_docver_gql02_rejects_non_member_and_returns_settings_defaults_without_insert() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql02").await;
  let (bobby_id, bobby_session) = helpers::seed_user(&pool, &auth_store, "bobby-docver-gql02").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;

  let member_body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "query Q($workspaceId: ID!, $docId: ID!) { documentVersioningSettings(workspaceId: $workspaceId, docId: $docId) { enabled retentionCount autoVersionOn } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
  )
  .await;
  assert!(
    member_body.get("errors").is_none(),
    "INV-DOCVER-GQL-02: member must receive default settings: {member_body}"
  );
  assert_eq!(
    member_body
      .pointer("/data/documentVersioningSettings/enabled")
      .and_then(Value::as_bool),
    Some(true)
  );
  assert_eq!(
    member_body
      .pointer("/data/documentVersioningSettings/retentionCount")
      .and_then(Value::as_i64),
    Some(10)
  );
  assert_eq!(
    member_body
      .pointer("/data/documentVersioningSettings/autoVersionOn/0")
      .and_then(Value::as_str),
    Some("on_pdf_export")
  );
  let settings_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_versioning_settings WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count settings rows");
  assert_eq!(
    settings_rows, 0,
    "INV-DOCVER-GQL-02: reading defaults must not insert a settings row"
  );

  let bobby_body = helpers::gql(
    &app,
    bobby_session,
    json!({
      "query": "query Q($workspaceId: ID!, $docId: ID!) { documentVersions(workspaceId: $workspaceId, docId: $docId) { id } documentVersioningSettings(workspaceId: $workspaceId, docId: $docId) { enabled } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
  )
  .await;
  assert!(
    !errors_array(&bobby_body).is_empty(),
    "INV-DOCVER-GQL-02: non-member must be rejected: {bobby_body}"
  );

  helpers::cleanup_users(&pool, &[alice_id, bobby_id]).await;
}

#[tokio::test]
async fn workspace_history_settings_enforce_permissions_minimum_and_atomic_patch() {
  let (app, pool, auth_store) = setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "history-settings-owner").await;
  let (member_id, member_session) = helpers::seed_user(&pool, &auth_store, "history-settings-member").await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  helpers::add_workspace_member(&pool, workspace_id, member_id).await;
  sqlx::query(
    "INSERT INTO document_edit_capture_runtime (singleton, last_poll_at) VALUES (true, now())
     ON CONFLICT (singleton) DO UPDATE SET last_poll_at=EXCLUDED.last_poll_at",
  )
  .execute(&pool)
  .await
  .expect("record healthy edit-capture worker heartbeat");

  let settings_query = json!({
    "query": "query Q($workspaceId: ID!) { workspaceHistorySettings(workspaceId: $workspaceId) { workspaceId namedVersioningEnabled autoVersionOn retentionCount editCaptureEnabled editCaptureIntervalMs effectiveEditCaptureEnabled effectiveEditCaptureIntervalMs enabledSource intervalSource legacyIntervalNormalized runtimeAvailable lastEditCaptureAt revision } }",
    "variables": { "workspaceId": workspace_id.to_string() }
  });
  let readable = helpers::gql(&app, member_session, settings_query.clone()).await;
  assert!(
    readable.get("errors").is_none(),
    "workspace readers must see the effective history policy: {readable}"
  );
  assert_eq!(
    readable
      .pointer("/data/workspaceHistorySettings/effectiveEditCaptureIntervalMs")
      .and_then(Value::as_i64),
    Some(86_400_000)
  );
  assert_eq!(
    readable
      .pointer("/data/workspaceHistorySettings/runtimeAvailable")
      .and_then(Value::as_bool),
    Some(true),
    "a recent worker heartbeat must activate the settings readback"
  );
  assert!(
    readable
      .pointer("/data/workspaceHistorySettings/lastEditCaptureAt")
      .is_some_and(Value::is_null),
    "a healthy idle worker must not invent a successful capture"
  );
  let revision = readable
    .pointer("/data/workspaceHistorySettings/revision")
    .and_then(Value::as_str)
    .expect("revision")
    .to_string();
  let rows_before: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM document_versioning_workspace_settings WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("count settings rows");
  assert_eq!(rows_before, 0, "settings reads must remain side-effect free");

  let invalid = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $input: UpdateWorkspaceHistorySettingsInput!) { updateWorkspaceHistorySettings(workspaceId: $workspaceId, input: $input) { revision } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "input": { "expectedRevision": revision, "editCaptureIntervalMs": 899_999 }
      }
    }),
  )
  .await;
  assert!(
    !errors_array(&invalid).is_empty(),
    "new intervals below 15 minutes must be rejected: {invalid}"
  );
  let rows_after_invalid: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM document_versioning_workspace_settings WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("count settings rows after validation failure");
  assert_eq!(
    rows_after_invalid, 0,
    "validation failure must not partially persist a workspace settings row"
  );

  let forbidden = helpers::gql(
    &app,
    member_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $input: UpdateWorkspaceHistorySettingsInput!) { updateWorkspaceHistorySettings(workspaceId: $workspaceId, input: $input) { revision } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "input": { "expectedRevision": revision, "editCaptureEnabled": false }
      }
    }),
  )
  .await;
  assert!(
    !errors_array(&forbidden).is_empty(),
    "a non-administrator workspace member must not update history policy: {forbidden}"
  );

  let saved = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $input: UpdateWorkspaceHistorySettingsInput!) { updateWorkspaceHistorySettings(workspaceId: $workspaceId, input: $input) { namedVersioningEnabled autoVersionOn retentionCount editCaptureEnabled editCaptureIntervalMs effectiveEditCaptureIntervalMs revision } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "input": {
          "expectedRevision": revision,
          "namedVersioningEnabled": true,
          "autoVersionOn": ["on_publish", "daily"],
          "retentionCount": 7,
          "editCaptureEnabled": false,
          "editCaptureIntervalMs": 1200000
        }
      }
    }),
  )
  .await;
  assert!(saved.get("errors").is_none(), "owner save must succeed: {saved}");
  assert_eq!(
    saved
      .pointer("/data/updateWorkspaceHistorySettings/editCaptureIntervalMs")
      .and_then(Value::as_i64),
    Some(1_200_000)
  );
  assert_eq!(
    saved
      .pointer("/data/updateWorkspaceHistorySettings/autoVersionOn")
      .and_then(Value::as_array)
      .map(Vec::len),
    Some(2),
    "workspace saves must preserve the full publication/daily trigger vector"
  );

  for pdf_override in [Some(true), Some(false), None] {
    let admin_update = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($input: AdminUpdateDocumentVersioningWorkspaceSettingsInput!) { admin { updateDocumentVersioningWorkspaceSettings(input: $input) { autoVersionOnPdfExport } } }",
        "variables": {
          "input": {
            "workspaceId": workspace_id.to_string(),
            "enabled": true,
            "autoVersionOnPdfExport": pdf_override,
            "retentionCount": 7
          }
        }
      }),
    )
    .await;
    assert!(
      admin_update.get("errors").is_none(),
      "Admin PDF-only update must succeed without replacing other trigger members: {admin_update}"
    );
    let persisted_triggers: Vec<String> =
      sqlx::query_scalar("SELECT auto_version_on FROM document_versioning_workspace_settings WHERE workspace_id = $1")
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("read trigger vector after Admin PDF-only update");
    assert!(persisted_triggers.contains(&"on-publish".to_string()));
    assert!(persisted_triggers.contains(&"daily".to_string()));
    assert_eq!(
      persisted_triggers.contains(&"on-pdf-export".to_string()),
      pdf_override == Some(true),
      "Admin PDF control must change only its own trigger member"
    );
  }

  sqlx::query(
    "UPDATE document_versioning_workspace_settings SET edit_capture_interval_ms = 30000 WHERE workspace_id = $1",
  )
  .bind(workspace_id)
  .execute(&pool)
  .await
  .expect("seed a previously accepted sub-minimum interval");
  let legacy = helpers::gql(&app, owner_session, settings_query).await;
  assert!(legacy.get("errors").is_none(), "legacy settings read: {legacy}");
  assert_eq!(
    legacy
      .pointer("/data/workspaceHistorySettings/editCaptureIntervalMs")
      .and_then(Value::as_i64),
    Some(30_000),
    "the persisted legacy value must remain intact"
  );
  assert_eq!(
    legacy
      .pointer("/data/workspaceHistorySettings/effectiveEditCaptureIntervalMs")
      .and_then(Value::as_i64),
    Some(900_000),
    "legacy sub-minimum values must resolve to the 15-minute floor"
  );
  assert_eq!(
    legacy
      .pointer("/data/workspaceHistorySettings/legacyIntervalNormalized")
      .and_then(Value::as_bool),
    Some(true)
  );

  helpers::cleanup_users(&pool, &[owner_id, member_id, admin_id]).await;
}

#[tokio::test]
async fn inv_docver_gql03_accepts_canonical_client_doc_ids() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql03").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let external_id = format!("docver-client-doc-{workspace_id}");
  let doc_uuid = insert_original_doc(&pool, workspace_id, alice_id, &external_id).await;
  let version_id = insert_version(&pool, workspace_id, doc_uuid, alice_id, "client-id-version").await;

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "query Q($workspaceId: ID!, $docId: ID!) { documentVersions(workspaceId: $workspaceId, docId: $docId) { id label } documentVersioningSettings(workspaceId: $workspaceId, docId: $docId) { enabled } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": external_id }
    }),
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "INV-DOCVER-GQL-03: client doc IDs must be normalized with the canonical parser: {body}"
  );
  assert_eq!(
    body.pointer("/data/documentVersions/0/id").and_then(Value::as_str),
    Some(version_id.to_string().as_str())
  );
  assert_eq!(
    body.pointer("/data/documentVersions/0/label").and_then(Value::as_str),
    Some("client-id-version")
  );

  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[tokio::test]
async fn inv_docver_gql04_mutations_create_pin_unpin_and_update_settings() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql04").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;

  let create_body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $label: String!) { \
        createDocumentVersion(workspaceId: $workspaceId, docId: $docId, label: $label, description: \" first release \") { id label description isPinned docHistoryId } \
      }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string(), "label": " release-v1 " }
    }),
  )
  .await;
  assert!(
    create_body.get("errors").is_none(),
    "INV-DOCVER-GQL-04: createDocumentVersion must succeed: {create_body}"
  );
  let version_id = create_body
    .pointer("/data/createDocumentVersion/id")
    .and_then(Value::as_str)
    .expect("created version id")
    .to_string();
  assert_eq!(
    create_body
      .pointer("/data/createDocumentVersion/label")
      .and_then(Value::as_str),
    Some("v1")
  );
  assert_eq!(
    create_body
      .pointer("/data/createDocumentVersion/description")
      .and_then(Value::as_str),
    Some("first release")
  );

  let update_body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($id: ID!) { \
        updateDocumentVersion(id: $id, label: \"release-v1-reviewed\", description: \"reviewed build\") { id label description createdBy } \
      }",
      "variables": { "id": version_id }
    }),
  )
  .await;
  assert!(
    update_body.get("errors").is_none(),
    "INV-DOCVER-GQL-04: updateDocumentVersion must update mutable metadata: {update_body}"
  );
  assert_eq!(
    update_body
      .pointer("/data/updateDocumentVersion/label")
      .and_then(Value::as_str),
    Some("release-v1-reviewed")
  );
  assert_eq!(
    update_body
      .pointer("/data/updateDocumentVersion/description")
      .and_then(Value::as_str),
    Some("reviewed build")
  );

  let pin_body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($id: ID!) { pinDocumentVersion(id: $id) { id isPinned } }",
      "variables": { "id": version_id }
    }),
  )
  .await;
  assert!(
    pin_body.get("errors").is_none(),
    "INV-DOCVER-GQL-04: pinDocumentVersion must succeed: {pin_body}"
  );
  assert_eq!(
    pin_body
      .pointer("/data/pinDocumentVersion/isPinned")
      .and_then(Value::as_bool),
    Some(true)
  );

  let unpin_body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($id: ID!) { unpinDocumentVersion(id: $id) { id isPinned } }",
      "variables": { "id": version_id }
    }),
  )
  .await;
  assert!(
    unpin_body.get("errors").is_none(),
    "INV-DOCVER-GQL-04: unpinDocumentVersion must succeed: {unpin_body}"
  );
  assert_eq!(
    unpin_body
      .pointer("/data/unpinDocumentVersion/isPinned")
      .and_then(Value::as_bool),
    Some(false)
  );

  let settings_body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!) { \
        updateDocumentVersioningSettings(workspaceId: $workspaceId, docId: $docId, autoVersionOn: [on_pdf_export, daily], retentionCount: 12, enabled: true) { enabled retentionCount autoVersionOn } \
      }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
  )
  .await;
  assert!(
    settings_body.get("errors").is_none(),
    "INV-DOCVER-GQL-04: updateDocumentVersioningSettings must succeed: {settings_body}"
  );
  assert_eq!(
    settings_body
      .pointer("/data/updateDocumentVersioningSettings/enabled")
      .and_then(Value::as_bool),
    Some(true)
  );
  assert_eq!(
    settings_body
      .pointer("/data/updateDocumentVersioningSettings/retentionCount")
      .and_then(Value::as_i64),
    Some(12)
  );
  assert_eq!(
    settings_body
      .pointer("/data/updateDocumentVersioningSettings/autoVersionOn/0")
      .and_then(Value::as_str),
    Some("on_pdf_export")
  );

  let delete_body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($id: ID!) { deleteDocumentVersion(id: $id) }",
      "variables": { "id": version_id }
    }),
  )
  .await;
  assert!(
    delete_body.get("errors").is_none(),
    "INV-DOCVER-GQL-04: deleteDocumentVersion must delete unpinned version: {delete_body}"
  );
  assert_eq!(
    delete_body
      .pointer("/data/deleteDocumentVersion")
      .and_then(Value::as_bool),
    Some(true)
  );

  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[tokio::test]
async fn inv_docver_gql04_capture_current_state_is_explicit_and_replay_safe() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql04-capture").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let unnamed_key = Uuid::new_v4();

  let capture = |request_key: Uuid, name: Option<&str>, description: Option<&str>| {
    helpers::gql(
      &app,
      alice_session,
      json!({
        "query": "mutation Save($workspaceId: ID!, $docId: ID!, $requestKey: ID!, $name: String, $description: String) { captureDocumentHistory(workspaceId: $workspaceId, docId: $docId, requestKey: $requestKey, name: $name, description: $description) { historyId version { id label description docHistoryId } } }",
        "variables": {
          "workspaceId": workspace_id.to_string(),
          "docId": doc_id.to_string(),
          "requestKey": request_key.to_string(),
          "name": name,
          "description": description,
        }
      }),
    )
  };

  let unnamed = capture(unnamed_key, Some("   "), None).await;
  assert!(unnamed.get("errors").is_none(), "unnamed save failed: {unnamed}");
  assert!(
    unnamed
      .pointer("/data/captureDocumentHistory/version")
      .is_some_and(Value::is_null)
  );
  let unnamed_history_id = unnamed
    .pointer("/data/captureDocumentHistory/historyId")
    .and_then(Value::as_str)
    .expect("unnamed history id")
    .to_string();

  let replay = capture(unnamed_key, None, None).await;
  assert!(replay.get("errors").is_none(), "same-input replay failed: {replay}");
  assert_eq!(
    replay
      .pointer("/data/captureDocumentHistory/historyId")
      .and_then(Value::as_str),
    Some(unnamed_history_id.as_str())
  );

  let conflict = capture(unnamed_key, Some("different"), None).await;
  assert_eq!(
    conflict.pointer("/errors/0/extensions/class").and_then(Value::as_str),
    Some("Conflict"),
    "request-key reuse with changed input must conflict: {conflict}"
  );

  let named = capture(Uuid::new_v4(), Some(" release-v1 "), Some(" first release ")).await;
  assert!(named.get("errors").is_none(), "named save failed: {named}");
  assert_eq!(
    named
      .pointer("/data/captureDocumentHistory/version/label")
      .and_then(Value::as_str),
    Some("release-v1"),
    "an explicit user name must not be replaced by the simple-counter policy"
  );
  assert_eq!(
    named
      .pointer("/data/captureDocumentHistory/version/description")
      .and_then(Value::as_str),
    Some("first release")
  );
  assert_eq!(
    named
      .pointer("/data/captureDocumentHistory/version/docHistoryId")
      .and_then(Value::as_str),
    named
      .pointer("/data/captureDocumentHistory/historyId")
      .and_then(Value::as_str)
  );

  let invalid_description = capture(Uuid::new_v4(), None, Some("not allowed")).await;
  assert_eq!(
    invalid_description
      .pointer("/errors/0/extensions/class")
      .and_then(Value::as_str),
    Some("ValidationError")
  );
  let invalid_name = capture(Uuid::new_v4(), Some(&"x".repeat(161)), None).await;
  assert_eq!(
    invalid_name
      .pointer("/errors/0/extensions/class")
      .and_then(Value::as_str),
    Some("ValidationError")
  );

  let history_count: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_histories WHERE doc_id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let version_count: i64 = sqlx::query_scalar("SELECT count(*) FROM document_version WHERE doc_id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let request_count: i64 = sqlx::query_scalar("SELECT count(*) FROM document_history_capture_request WHERE doc_id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(history_count, 2, "replay and validation failures must not recapture");
  assert_eq!(version_count, 1, "only the explicitly named save creates a version");
  assert_eq!(request_count, 2, "only committed save requests are retained");

  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[tokio::test]
async fn inv_docver_gql04b_name_existing_history_preserves_capture_and_current_head() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql04b-name-history").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;

  let capture_a = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($w:ID!,$d:ID!,$key:ID!){captureDocumentHistory(workspaceId:$w,docId:$d,requestKey:$key){historyId}}",
      "variables": {"w":workspace_id.to_string(),"d":doc_id.to_string(),"key":Uuid::new_v4().to_string()}
    }),
  )
  .await;
  assert!(capture_a.get("errors").is_none(), "capture A: {capture_a}");
  let history_a = capture_a["data"]["captureDocumentHistory"]["historyId"]
    .as_str()
    .expect("history A")
    .to_string();
  let history_a_id = history_a.parse::<i64>().expect("history id");
  let history_before: Value = sqlx::query_scalar("SELECT to_jsonb(h) FROM doc_histories h WHERE id=$1")
    .bind(history_a_id)
    .fetch_one(&pool)
    .await
    .unwrap();

  let doc = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  doc
    .push_update(
      workspace_id,
      doc_id,
      build_doc_version_yjs(&[("paragraph", "Current content B")]),
      1,
      myoxus_application::doc::DocSpaceKind::Workspace,
    )
    .await
    .expect("persist B");
  let capture_b = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($w:ID!,$d:ID!,$key:ID!){captureDocumentHistory(workspaceId:$w,docId:$d,requestKey:$key,name:\"Current B\"){historyId version{id}}}",
      "variables": {"w":workspace_id.to_string(),"d":doc_id.to_string(),"key":Uuid::new_v4().to_string()}
    }),
  )
  .await;
  assert!(capture_b.get("errors").is_none(), "capture B: {capture_b}");
  let document_before: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM docs d WHERE id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();

  let name = |expected: Vec<String>, label: &str| {
    helpers::gql(
      &app,
      alice_session,
      json!({
        "query": "mutation M($w:ID!,$d:ID!,$h:ID!,$expected:[ID!]!,$name:String!){nameDocumentHistoryState(workspaceId:$w,docId:$d,historyId:$h,expectedVersionIds:$expected,name:$name){id label docHistoryId createdAt}}",
        "variables": {"w":workspace_id.to_string(),"d":doc_id.to_string(),"h":history_a,"expected":expected,"name":label}
      }),
    )
  };
  let named_a = name(Vec::new(), "Old A").await;
  assert!(named_a.get("errors").is_none(), "name A: {named_a}");
  assert_eq!(
    named_a["data"]["nameDocumentHistoryState"]["docHistoryId"].as_str(),
    Some(history_a.as_str())
  );
  let first_version = named_a["data"]["nameDocumentHistoryState"]["id"]
    .as_str()
    .expect("first reference")
    .to_string();

  let replay = name(Vec::new(), "Old A").await;
  assert_eq!(
    replay["data"]["nameDocumentHistoryState"]["id"].as_str(),
    Some(first_version.as_str()),
    "same naming request must return its existing reference: {replay}"
  );
  let conflict = name(Vec::new(), "Old A alternate").await;
  assert_eq!(
    conflict.pointer("/errors/0/extensions/class").and_then(Value::as_str),
    Some("Conflict"),
    "stale references must require reload: {conflict}"
  );
  let second = name(vec![first_version.clone()], "Old A alternate").await;
  assert!(second.get("errors").is_none(), "second deployed reference: {second}");

  let history_after: Value = sqlx::query_scalar("SELECT to_jsonb(h) FROM doc_histories h WHERE id=$1")
    .bind(history_a_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let document_after: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM docs d WHERE id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    history_after, history_before,
    "naming must not rewrite immutable capture A"
  );
  assert_eq!(
    document_after, document_before,
    "naming A must not move B's head or dirty state"
  );
  let references: i64 = sqlx::query_scalar("SELECT count(*) FROM document_version WHERE doc_history_id=$1")
    .bind(history_a_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(references, 2, "pre-existing multiple references remain supported");

  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[tokio::test]
async fn inv_docver_gql05_delete_pinned_blocked() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql05").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let version_id = insert_version(&pool, workspace_id, doc_id, alice_id, "protected-v1").await;

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($id: ID!) { deleteDocumentVersion(id: $id) }",
      "variables": { "id": version_id.to_string() }
    }),
  )
  .await;
  assert_eq!(
    body.pointer("/errors/0/extensions/class").and_then(Value::as_str),
    Some("Conflict"),
    "INV-DOCVER-GQL-05: deleting a pinned version must be blocked: {body}"
  );
  let still_exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_version WHERE id = $1")
    .bind(version_id)
    .fetch_one(&pool)
    .await
    .expect("count version");
  assert_eq!(still_exists, 1);

  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[tokio::test]
async fn inv_docver_gql06_restore_creates_new_history_not_in_place() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql06").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let a = build_doc_version_yjs(&[("paragraph", "State A: retain this text")]);
  let version_id = insert_version_with_snapshot(&pool, workspace_id, doc_id, alice_id, "reviewed-v1", a.clone()).await;
  let doc = Arc::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))));
  doc
    .push_update(
      workspace_id,
      doc_id,
      a.clone(),
      1,
      myoxus_application::doc::DocSpaceKind::Workspace,
    )
    .await
    .unwrap();
  let live = Doc::new();
  live
    .transact_mut()
    .apply_update(yrs::Update::decode_v1(&a).unwrap())
    .unwrap();
  let blocks = live.get_or_insert_map("blocks");
  let paragraph = blocks
    .get(&live.transact(), "paragraph")
    .unwrap()
    .cast::<yrs::MapRef>()
    .unwrap();
  let text = paragraph
    .get(&live.transact(), "prop:text")
    .unwrap()
    .cast::<yrs::TextRef>()
    .unwrap();
  let b_delta = {
    let mut txn = live.transact_mut();
    text.insert(&mut txn, 0, "State B supersedes ");
    txn.encode_update_v1()
  };
  doc
    .push_update(
      workspace_id,
      doc_id,
      b_delta,
      2,
      myoxus_application::doc::DocSpaceKind::Workspace,
    )
    .await
    .unwrap();
  let b = doc.load_full_doc(workspace_id, doc_id).await.unwrap();
  let business_before: Value = sqlx::query_scalar(
    "SELECT to_jsonb(d) - ARRAY['updated_at','sync_state_vector_v1','current_version_id','dirty_since_current_version','last_versioned_at','metadata_updated_by','metadata_updated_at','metadata_revision'] FROM docs d WHERE id=$1"
  ).bind(doc_id).fetch_one(&pool).await.unwrap();
  let revision = doc.history.revision(workspace_id, doc_id).await.unwrap();
  let source_history_id: i64 = sqlx::query_scalar("SELECT doc_history_id FROM document_version WHERE id = $1")
    .bind(version_id)
    .fetch_one(&pool)
    .await
    .expect("source history id");

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($id: ID!, $revision: String!) { restoreDocumentVersion(id: $id, expectedRevision: $revision) { id label docHistoryId isPinned } }",
      "variables": { "id": version_id.to_string(), "revision": revision.to_string() }
    }),
  )
  .await;
  assert!(
    body.get("errors").is_none(),
    "INV-DOCVER-GQL-06: restoreDocumentVersion must succeed: {body}"
  );
  let restored_id = body
    .pointer("/data/restoreDocumentVersion/id")
    .and_then(Value::as_str)
    .expect("restored id")
    .parse::<Uuid>()
    .expect("restored uuid");
  let restored_label = body
    .pointer("/data/restoreDocumentVersion/label")
    .and_then(Value::as_str)
    .expect("restored label");
  assert!(
    restored_label.starts_with("restore-from-reviewed-v1-"),
    "INV-DOCVER-GQL-06: restore label must be allocated by the canonical restore label service: {restored_label}"
  );
  let restored_history_id = body
    .pointer("/data/restoreDocumentVersion/docHistoryId")
    .and_then(Value::as_str)
    .map(|value| value.parse::<i64>().expect("snapshot ID is a decimal string"))
    .expect("restored history id");
  assert_ne!(
    restored_history_id, source_history_id,
    "INV-DOCVER-GQL-06: restore must create a new history snapshot, not reuse source"
  );

  let version_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_version WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count versions");
  assert_eq!(version_count, 2);
  let relation_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM document_version_relation \
     WHERE from_version_id = $1 AND to_version_id = $2 AND relation = 'restored_from'",
  )
  .bind(restored_id)
  .bind(version_id)
  .fetch_one(&pool)
  .await
  .expect("count restored_from relation");
  assert_eq!(
    relation_count, 1,
    "INV-DOCVER-GQL-06: restore must persist restored_from relation"
  );
  let update_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count updates");
  assert_eq!(
    update_count, 3,
    "restore appends one update without resetting the chain"
  );
  let content = |bytes: &[u8]| {
    let doc = Doc::new();
    doc
      .transact_mut()
      .apply_update(yrs::Update::decode_v1(bytes).unwrap())
      .unwrap();
    yrs::types::ToJson::to_json(&doc.get_or_insert_map("blocks"), &doc.transact())
  };
  assert_eq!(
    content(&doc.load_full_doc(workspace_id, doc_id).await.unwrap()),
    content(&a)
  );
  let head: (Uuid, bool) =
    sqlx::query_as("SELECT current_version_id,dirty_since_current_version FROM docs WHERE id=$1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(head, (restored_id, false));
  let business_after: Value = sqlx::query_scalar(
    "SELECT to_jsonb(d) - ARRAY['updated_at','sync_state_vector_v1','current_version_id','dirty_since_current_version','last_versioned_at','metadata_updated_by','metadata_updated_at','metadata_revision'] FROM docs d WHERE id=$1"
  ).bind(doc_id).fetch_one(&pool).await.unwrap();
  assert_eq!(
    business_after, business_before,
    "content restore must not rewind canonical business metadata"
  );
  let histories = doc.list_history(workspace_id, doc_id, 0, 10).await.unwrap();
  assert_eq!(histories.len(), 3);
  assert_eq!(doc.history_entry(source_history_id).await.unwrap().unwrap().snapshot, a);
  let recovery = histories
    .iter()
    .find(|h| h.id != source_history_id && h.id != restored_history_id)
    .unwrap();
  assert_eq!(
    content(&doc.history_entry(recovery.id).await.unwrap().unwrap().snapshot),
    content(&b)
  );

  let replay = helpers::gql(&app, alice_session, json!({
    "query":"mutation M($id: ID!, $revision: String!) { restoreDocumentVersion(id:$id, expectedRevision:$revision) { id } }",
    "variables":{"id":version_id.to_string(),"revision":revision.to_string()}
  })).await;
  assert!(
    replay.to_string().contains("MIX_DOCUMENT_MUTATION_CONFLICT"),
    "lost-response retry must reject the old revision: {replay}"
  );
  assert_eq!(doc.list_history(workspace_id, doc_id, 0, 10).await.unwrap().len(), 3);
  assert_eq!(doc.history.revision(workspace_id, doc_id).await.unwrap(), revision + 1);

  // The previous state remains selectable without manufacturing a named version.
  let recovered = helpers::gql(&app, alice_session, json!({
    "query":"mutation M($workspaceId: String!, $docId: String!, $snapshotId: ID!, $revision: String!) { recoverDoc(workspaceId:$workspaceId, guid:$docId, snapshotId:$snapshotId, expectedRevision:$revision) }",
    "variables":{"workspaceId":workspace_id.to_string(),"docId":doc_id.to_string(),"snapshotId":recovery.id.to_string(),"revision":(revision+1).to_string()}
  })).await;
  assert!(recovered.get("errors").is_none(), "recover previous B: {recovered}");
  assert_eq!(
    content(&doc.load_full_doc(workspace_id, doc_id).await.unwrap()),
    content(&b)
  );
  let head: (Uuid, bool) =
    sqlx::query_as("SELECT current_version_id,dirty_since_current_version FROM docs WHERE id=$1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(head, (restored_id, true));
  let named_count: i64 = sqlx::query_scalar("SELECT count(*) FROM document_version WHERE doc_id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(named_count, 2);

  // Exercise a real unique-constraint failure after deriving the restore and
  // inserting its recovery snapshot, not a mock rejecting before any writes.
  use myoxus_domain::repositories::DocumentVersionRepository;
  let repo = Arc::new(PgDocumentVersionRepository::new(pool.clone()));
  let source = repo.get(version_id).await.unwrap().unwrap();
  let before_failed_restore: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM docs d WHERE id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let revision_before_failure = doc.history.revision(workspace_id, doc_id).await.unwrap();
  let history_count_before_failure = doc.list_history(workspace_id, doc_id, 0, 10).await.unwrap().len();
  let outbox_before: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE aggregate_id=$1")
    .bind(doc_id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
  let restore_service = myoxus_application::document_version::DocumentVersionRestoreService::new(doc.clone(), repo);
  let failure = restore_service
    .restore_at_revision(
      &source,
      myoxus_domain::audit::AuditActor::user(alice_id, None),
      Some(source.label.clone()),
      Some(revision_before_failure),
    )
    .await
    .expect_err("duplicate persisted label must roll back the whole restore");
  assert!(
    matches!(
      failure,
      myoxus_application::document_version::DocumentVersionRestoreError::History(_)
    ),
    "must reach the transaction: {failure}"
  );
  assert_eq!(
    doc.history.revision(workspace_id, doc_id).await.unwrap(),
    revision_before_failure
  );
  assert_eq!(
    doc.list_history(workspace_id, doc_id, 0, 10).await.unwrap().len(),
    history_count_before_failure
  );
  assert_eq!(
    content(&doc.load_full_doc(workspace_id, doc_id).await.unwrap()),
    content(&b)
  );
  let after_failed_restore: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM docs d WHERE id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(after_failed_restore, before_failed_restore);
  let outbox_after: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE aggregate_id=$1")
    .bind(doc_id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(outbox_after, outbox_before);
  let persisted_versions: i64 = sqlx::query_scalar("SELECT count(*) FROM document_version WHERE doc_id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(persisted_versions, 2);
  let next_version: i64 =
    sqlx::query_scalar("SELECT next_value FROM document_version_label_counter WHERE doc_id=$1 AND counter_key='seq'")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(next_version, 3, "failed restore must roll back its number allocation");
  let restore_audits: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE actor_user_id=$1 AND event_key IN ('document.restore','document_version.restore')")
    .bind(alice_id).fetch_one(&pool).await.unwrap();
  assert_eq!(restore_audits, 2, "audit exists only for the two committed restores");

  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1")
    .bind(alice_id)
    .execute(&pool)
    .await
    .expect("cleanup restore audit evidence");
  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[tokio::test]
async fn inv_docver_gql07_mutations_reject_non_member_before_side_effects() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql07").await;
  let (bobby_id, bobby_session) = helpers::seed_user(&pool, &auth_store, "bobby-docver-gql07").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let version_id = insert_version(&pool, workspace_id, doc_id, alice_id, "member-only-v1").await;

  let create_body = helpers::gql(
    &app,
    bobby_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!) { createDocumentVersion(workspaceId: $workspaceId, docId: $docId, label: \"forbidden\") { id } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
  )
  .await;
  assert!(
    !errors_array(&create_body).is_empty(),
    "INV-DOCVER-GQL-07: non-member createDocumentVersion must be rejected: {create_body}"
  );

  let capture_body = helpers::gql(
    &app,
    bobby_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $requestKey: ID!) { captureDocumentHistory(workspaceId: $workspaceId, docId: $docId, requestKey: $requestKey) { historyId } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "requestKey": Uuid::new_v4().to_string(),
      }
    }),
  )
  .await;
  assert!(
    !errors_array(&capture_body).is_empty(),
    "INV-DOCVER-GQL-07: non-member captureDocumentHistory must be rejected: {capture_body}"
  );

  let restore_body = helpers::gql(
    &app,
    bobby_session,
    json!({
      "query": "mutation M($id: ID!) { restoreDocumentVersion(id: $id) { id } }",
      "variables": { "id": version_id.to_string() }
    }),
  )
  .await;
  assert!(
    !errors_array(&restore_body).is_empty(),
    "INV-DOCVER-GQL-07: non-member restoreDocumentVersion must be rejected: {restore_body}"
  );

  // External membership has no workspace-wide Editor floor, so revoking the
  // document grant really removes Restore rather than retaining inherited access.
  sqlx::query("INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, 'External', 'Accepted', now())")
    .bind(workspace_id)
    .bind(bobby_id)
    .execute(&pool)
    .await
    .expect("insert external member for document-only permissions");
  let grant = |role: &str| {
    json!({
      "query":"mutation M($input: GrantDocUserRolesInput!) { grantDocUserRoles(input:$input) }",
      "variables":{"input":{"workspaceId":workspace_id.to_string(),"docId":doc_id.to_string(),"userIds":[bobby_id.to_string()],"role":role}}
    })
  };
  let granted = helpers::gql(&app, alice_session, grant("Editor")).await;
  assert!(granted.get("errors").is_none(), "grant editor: {granted}");
  let prepared = helpers::gql(
    &app,
    bobby_session,
    json!({
      "query":"query M($w: ID!, $d: ID!) { documentHistoryRevision(workspaceId:$w,docId:$d) }",
      "variables":{"w":workspace_id.to_string(),"d":doc_id.to_string()}
    }),
  )
  .await;
  assert!(prepared.get("errors").is_none(), "prepare while authorized: {prepared}");
  let revision = prepared["data"]["documentHistoryRevision"].as_str().unwrap();
  let revoked = helpers::gql(&app, alice_session, grant("Reader")).await;
  assert!(revoked.get("errors").is_none(), "revoke restore permission: {revoked}");
  let metadata_before: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM docs d WHERE id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let rejected = helpers::gql(&app, bobby_session, json!({
    "query":"mutation M($id:ID!,$revision:String!) { restoreDocumentVersion(id:$id,expectedRevision:$revision) { id } }",
    "variables":{"id":version_id.to_string(),"revision":revision}
  })).await;
  assert!(
    !errors_array(&rejected).is_empty(),
    "permissions must be checked again after confirmation: {rejected}"
  );
  let history_id: i64 = sqlx::query_scalar("SELECT doc_history_id FROM document_version WHERE id=$1")
    .bind(version_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let rejected_name = helpers::gql(
    &app,
    bobby_session,
    json!({
      "query":"mutation M($w:ID!,$d:ID!,$h:ID!,$expected:[ID!]!){nameDocumentHistoryState(workspaceId:$w,docId:$d,historyId:$h,expectedVersionIds:$expected,name:\"forbidden name\"){id}}",
      "variables":{"w":workspace_id.to_string(),"d":doc_id.to_string(),"h":history_id.to_string(),"expected":[version_id.to_string()]}
    }),
  )
  .await;
  assert!(
    !errors_array(&rejected_name).is_empty(),
    "read-only member must not name or discover a history state: {rejected_name}"
  );
  let other_doc = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let foreign = helpers::gql(
    &app,
    alice_session,
    json!({
      "query":"mutation M($w:String!,$d:String!,$h:ID!) { recoverDoc(workspaceId:$w,guid:$d,snapshotId:$h) }",
      "variables":{"w":workspace_id.to_string(),"d":other_doc.to_string(),"h":history_id.to_string()}
    }),
  )
  .await;
  assert!(
    foreign.to_string().contains("history not found"),
    "cross-document snapshot rejected: {foreign}"
  );
  let metadata_after: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM docs d WHERE id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(metadata_after, metadata_before);

  let version_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_version WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count versions");
  let history_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_histories WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count histories");
  let update_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count updates");
  let capture_request_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM document_history_capture_request WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("count capture requests");
  assert_eq!(
    version_count, 1,
    "INV-DOCVER-GQL-07: rejected writes must not add version rows"
  );
  assert_eq!(
    history_count, 1,
    "INV-DOCVER-GQL-07: rejected writes must not add history snapshots"
  );
  assert_eq!(
    update_count, 0,
    "INV-DOCVER-GQL-07: rejected restore must not append doc updates"
  );
  assert_eq!(
    capture_request_count, 0,
    "INV-DOCVER-GQL-07: rejected captures must not reserve request keys"
  );

  helpers::cleanup_users(&pool, &[alice_id, bobby_id]).await;
}

#[tokio::test]
async fn inv_docver_gql08_simple_counter_ignores_duplicate_requested_label_without_orphan_history() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql08").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  insert_version(&pool, workspace_id, doc_id, alice_id, "release-v1").await;

  let doc = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  doc
    .push_update(
      workspace_id,
      doc_id,
      build_doc_version_yjs(&[("paragraph", "Acknowledged checkpoint content")]),
      1,
      myoxus_application::doc::DocSpaceKind::Workspace,
    )
    .await
    .expect("persist nonempty document");
  let expected = doc
    .load_full_doc(workspace_id, doc_id)
    .await
    .expect("server materialization");

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!) { createDocumentVersion(workspaceId: $workspaceId, docId: $docId, label: \"release-v1\") { id } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
  )
  .await;
  assert!(
    body.get("errors").is_none(),
    "INV-DOCVER-GQL-08: simple-counter policy must allocate a unique label even when the requested label already exists: {body}"
  );

  let version_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_version WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count versions");
  let history_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_histories WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count histories");
  assert_eq!(
    version_count, 2,
    "INV-DOCVER-GQL-08: simple-counter allocation must create one additional version"
  );
  assert_eq!(
    history_count, 2,
    "INV-DOCVER-GQL-08: successful create must capture exactly one matching history snapshot"
  );

  let row: (String, i64, Vec<u8>, bool) = sqlx::query_as(
    "SELECT v.label, v.version_no, h.snapshot, d.dirty_since_current_version
     FROM docs d JOIN document_version v ON v.id = d.current_version_id
     JOIN doc_histories h ON h.id = v.doc_history_id WHERE d.id = $1",
  )
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("committed current version");
  assert_eq!(
    (&*row.0, row.1),
    ("v2", 2),
    "label and version number must reserve seq only once"
  );
  assert_eq!(
    row.2, expected,
    "capture must bind acknowledged nonempty server content"
  );
  assert!(!row.3, "capture marks the canonical version clean");

  let unnamed = doc.capture_history_snapshot(doc_id).await.expect("unnamed capture");
  let unnamed_refs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_version WHERE doc_history_id = $1")
    .bind(unnamed)
    .fetch_one(&pool)
    .await
    .expect("unnamed references");
  assert_eq!(unnamed_refs, 0);
  let head_number: i64 = sqlx::query_scalar(
    "SELECT v.version_no FROM docs d JOIN document_version v ON v.id=d.current_version_id WHERE d.id=$1",
  )
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("head after unnamed capture");
  assert_eq!(head_number, 2, "unnamed capture must not move the named head");

  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[tokio::test]
async fn inv_docver_gql09_publish_trigger_creates_version_before_publish() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql09").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  sqlx::query("UPDATE workspaces SET public = true WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("make on-publish version workspace eligible");
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  enable_auto_versioning(&pool, doc_id, &["on-publish"]).await;

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($workspaceId: String!, $docId: String!) { publishDoc(workspaceId: $workspaceId, docId: $docId) { id public mode } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
  )
  .await;
  assert!(
    body.get("errors").is_none(),
    "INV-DOCVER-GQL-09: publishDoc with on_publish auto-version must succeed: {body}"
  );
  assert_eq!(
    body.pointer("/data/publishDoc/public").and_then(Value::as_bool),
    Some(true)
  );

  let row: (String, String, i64) =
    sqlx::query_as("SELECT label, event, doc_history_id FROM document_version WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("publish-created version");
  assert!(
    row.0.starts_with('v'),
    "INV-DOCVER-GQL-09: publish trigger label must be allocated by the canonical label service: {}",
    row.0
  );
  assert_eq!(
    row.1, "publish",
    "INV-DOCVER-GQL-09: publish trigger must persist the publish event"
  );
  assert!(
    row.2 > 0,
    "INV-DOCVER-GQL-09: publish trigger must point at a DocHistory snapshot"
  );

  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[tokio::test]
async fn inv_docver_gql10_daily_trigger_skips_unchanged_doc() {
  let (_app, pool, auth_store) = setup_app().await;
  let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql10").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  enable_auto_versioning(&pool, doc_id, &["daily"]).await;

  let version_repo = Arc::new(PgDocumentVersionRepository::new(pool.clone()));
  let settings_repo = Arc::new(PgDocumentVersioningSettingsRepository::new(pool.clone()));
  let doc_service = Arc::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))));
  doc_service
    .push_update(
      workspace_id,
      doc_id,
      build_doc_version_yjs(&[("daily", "Daily nonempty content")]),
      1,
      myoxus_application::doc::DocSpaceKind::Workspace,
    )
    .await
    .expect("persist daily content");
  let expected = doc_service
    .load_full_doc(workspace_id, doc_id)
    .await
    .expect("daily server content");
  let service = DocumentVersionAutoTriggerService::new(doc_service, version_repo.clone(), settings_repo.clone());

  let request = || DocumentVersionAutoTriggerRequest {
    doc_id,
    workspace_id,
    actor_id: alice_id,
    trigger: AutoVersionTrigger::Daily,
    description: Some("test daily".to_string()),
    skip_unchanged: true,
  };
  let (first, competing) = tokio::join!(
    service.create_for_trigger(request()),
    service.create_for_trigger(request())
  );
  let outcomes = [
    first.expect("first daily capture"),
    competing.expect("competing daily capture"),
  ];
  assert_eq!(
    outcomes
      .iter()
      .filter(|outcome| matches!(outcome, AutoVersionOutcome::Created(_)))
      .count(),
    1
  );
  assert_eq!(
    outcomes
      .iter()
      .filter(|outcome| matches!(
        outcome,
        AutoVersionOutcome::Skipped(myoxus_application::document_version::AutoVersionSkipReason::Unchanged)
      ))
      .count(),
    1
  );

  let second = service.run_daily().await.expect("second daily auto-version scan");
  assert_eq!(
    second.created, 0,
    "INV-DOCVER-GQL-10: unchanged daily scan must not create another version"
  );
  assert_eq!(
    second.skipped_unchanged, 1,
    "INV-DOCVER-GQL-10: unchanged doc must be counted as skipped_unchanged"
  );

  let version_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_version WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count daily versions");
  let history_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_histories WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count daily histories");
  assert_eq!(version_count, 1);
  assert_eq!(
    history_count, 1,
    "INV-DOCVER-GQL-10: unchanged daily scan must not capture a second history snapshot"
  );
  let captured: Vec<u8> = sqlx::query_scalar(
    "SELECT h.snapshot FROM docs d JOIN document_version v ON v.id=d.current_version_id
     JOIN doc_histories h ON h.id=v.doc_history_id WHERE d.id=$1 AND NOT d.dirty_since_current_version",
  )
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("daily canonical head");
  assert_eq!(captured, expected);

  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[tokio::test]
async fn inv_docver_capture_conflict_rolls_back_history_counter_and_metadata() {
  use myoxus_domain::repositories::{DocumentMetadataRepository, DocumentVersionRepository};
  let (app, pool, auth_store) = setup_app().await;
  let (actor, session) = helpers::seed_user(&pool, &auth_store, "capture-atomic-conflict").await;
  let workspace = helpers::create_workspace(&pool, actor).await;
  let doc = helpers::create_doc(&pool, workspace, actor).await;
  // The first existing row consumes seq=1, but its manual label conflicts with
  // the next generated v2. The real unique constraint fails after capture.
  let existing = insert_version(&pool, workspace, doc, actor, "v2").await;
  myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository::new(pool.clone())
    .mark_current_version(doc, existing, chrono::Utc::now(), actor)
    .await
    .expect("initial head");
  let before: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM docs d WHERE id=$1")
    .bind(doc)
    .fetch_one(&pool)
    .await
    .expect("metadata before rejection");
  let request = json!({
    "query": "mutation($workspace: ID!, $doc: ID!) { createDocumentVersion(workspaceId:$workspace, docId:$doc, label:\"ignored-by-counter-policy\") { id label versionNo } }",
    "variables": {"workspace":workspace.to_string(), "doc":doc.to_string()}
  });
  let rejected = helpers::gql(&app, session, request.clone()).await;
  assert_eq!(
    rejected.pointer("/errors/0/extensions/class").and_then(Value::as_str),
    Some("Conflict"),
    "{rejected}"
  );
  let counts: (i64, i64, i64) = sqlx::query_as(
    "SELECT (SELECT COUNT(*) FROM doc_histories WHERE doc_id=$1),
     (SELECT COUNT(*) FROM document_version WHERE doc_id=$1),
     (SELECT next_value FROM document_version_label_counter WHERE doc_id=$1 AND counter_key='seq')",
  )
  .bind(doc)
  .fetch_one(&pool)
  .await
  .expect("transaction rollback");
  assert_eq!(
    counts,
    (1, 1, 2),
    "failure must not retain a history, version or consumed counter"
  );
  let after: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM docs d WHERE id=$1")
    .bind(doc)
    .fetch_one(&pool)
    .await
    .expect("metadata after rejection");
  assert_eq!(after, before, "failure must not change any document metadata");

  PgDocumentVersionRepository::new(pool.clone())
    .update_metadata(existing, "original", None)
    .await
    .expect("resolve label conflict normally");
  let accepted = helpers::gql(&app, session, request).await;
  assert!(accepted.get("errors").is_none(), "{accepted}");
  assert_eq!(
    accepted
      .pointer("/data/createDocumentVersion/label")
      .and_then(Value::as_str),
    Some("v2")
  );
  assert_eq!(
    accepted
      .pointer("/data/createDocumentVersion/versionNo")
      .and_then(Value::as_i64),
    Some(2)
  );
  helpers::cleanup_users(&pool, &[actor]).await;
}

#[tokio::test]
async fn inv_docver_gql11_diff_detects_added_blocks() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql11").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let from_id = insert_version_with_snapshot(
    &pool,
    workspace_id,
    doc_id,
    alice_id,
    "before-added-block",
    build_doc_version_yjs(&[("p-1", "Alpha")]),
  )
  .await;
  let to_id = insert_version_with_snapshot(
    &pool,
    workspace_id,
    doc_id,
    alice_id,
    "after-added-block",
    build_doc_version_yjs(&[("p-1", "Alpha"), ("p-2", "Beta")]),
  )
  .await;

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "query Q($fromId: ID!, $toId: ID!) { \
        documentVersionDiff(fromId: $fromId, toId: $toId) { \
          stateVector { changed fromStateVectorSha256 toStateVectorSha256 } \
          fromBlockCount toBlockCount extractionPartial \
          blockDiffs { blockId kind fromText toText } \
          textDiffs { blockId } \
        } \
      }",
      "variables": { "fromId": from_id.to_string(), "toId": to_id.to_string() }
    }),
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "INV-DOCVER-GQL-11: diff query must succeed for same-doc versions: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/documentVersionDiff/stateVector/changed")
      .and_then(Value::as_bool),
    Some(true)
  );
  assert_eq!(
    body
      .pointer("/data/documentVersionDiff/fromBlockCount")
      .and_then(Value::as_i64),
    Some(2)
  );
  assert_eq!(
    body
      .pointer("/data/documentVersionDiff/toBlockCount")
      .and_then(Value::as_i64),
    Some(3)
  );
  let diffs = body
    .pointer("/data/documentVersionDiff/blockDiffs")
    .and_then(Value::as_array)
    .expect("block diffs");
  assert!(
    diffs.iter().any(|diff| {
      diff.get("blockId").and_then(Value::as_str) == Some("p-2")
        && diff.get("kind").and_then(Value::as_str) == Some("added")
        && diff.get("toText").and_then(Value::as_str) == Some("Beta")
    }),
    "INV-DOCVER-GQL-11: added block p-2 must be reported: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/documentVersionDiff/textDiffs")
      .and_then(Value::as_array)
      .map(Vec::len),
    Some(0),
    "INV-DOCVER-GQL-11: pure added block should not create modified-block text diffs"
  );

  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[tokio::test]
async fn inv_docver_gql12_diff_detects_text_changes() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql12").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let from_id = insert_version_with_snapshot(
    &pool,
    workspace_id,
    doc_id,
    alice_id,
    "before-text-change",
    build_doc_version_yjs(&[("p-1", "Alpha old line")]),
  )
  .await;
  let to_id = insert_version_with_snapshot(
    &pool,
    workspace_id,
    doc_id,
    alice_id,
    "after-text-change",
    build_doc_version_yjs(&[("p-1", "Alpha new line")]),
  )
  .await;

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "query Q($fromId: ID!, $toId: ID!) { \
        documentVersionDiff(fromId: $fromId, toId: $toId) { \
          blockDiffs { blockId kind fromText toText } \
          textDiffs { blockId fromText toText removedLines addedLines removedWords addedWords } \
        } \
      }",
      "variables": { "fromId": from_id.to_string(), "toId": to_id.to_string() }
    }),
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "INV-DOCVER-GQL-12: text diff query must succeed: {body}"
  );
  let block_diffs = body
    .pointer("/data/documentVersionDiff/blockDiffs")
    .and_then(Value::as_array)
    .expect("block diffs");
  assert!(
    block_diffs.iter().any(|diff| {
      diff.get("blockId").and_then(Value::as_str) == Some("p-1")
        && diff.get("kind").and_then(Value::as_str) == Some("modified")
        && diff.get("fromText").and_then(Value::as_str) == Some("Alpha old line")
        && diff.get("toText").and_then(Value::as_str) == Some("Alpha new line")
    }),
    "INV-DOCVER-GQL-12: modified p-1 block must be reported: {body}"
  );
  let text_diff = body
    .pointer("/data/documentVersionDiff/textDiffs/0")
    .expect("first text diff");
  assert_eq!(text_diff.get("blockId").and_then(Value::as_str), Some("p-1"));
  assert_eq!(
    text_diff
      .get("removedWords")
      .and_then(Value::as_array)
      .and_then(|words| words.first())
      .and_then(Value::as_str),
    Some("old")
  );
  assert_eq!(
    text_diff
      .get("addedWords")
      .and_then(Value::as_array)
      .and_then(|words| words.first())
      .and_then(Value::as_str),
    Some("new")
  );

  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[tokio::test]
async fn inv_docver_gql13_diff_rejects_non_member() {
  let (app, pool, auth_store) = setup_app().await;
  let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-gql13").await;
  let (bobby_id, bobby_session) = helpers::seed_user(&pool, &auth_store, "bobby-docver-gql13").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let from_id = insert_version_with_snapshot(
    &pool,
    workspace_id,
    doc_id,
    alice_id,
    "before-non-member-diff",
    build_doc_version_yjs(&[("p-1", "Alpha")]),
  )
  .await;
  let to_id = insert_version_with_snapshot(
    &pool,
    workspace_id,
    doc_id,
    alice_id,
    "after-non-member-diff",
    build_doc_version_yjs(&[("p-1", "Beta")]),
  )
  .await;

  let body = helpers::gql(
    &app,
    bobby_session,
    json!({
      "query": "query Q($fromId: ID!, $toId: ID!) { \
        documentVersionDiff(fromId: $fromId, toId: $toId) { textDiffs { fromText toText } } \
      }",
      "variables": { "fromId": from_id.to_string(), "toId": to_id.to_string() }
    }),
  )
  .await;

  assert!(
    !errors_array(&body).is_empty(),
    "INV-DOCVER-GQL-13: non-member must be rejected before diff data is returned: {body}"
  );
  assert!(
    body.pointer("/data/documentVersionDiff").is_none(),
    "INV-DOCVER-GQL-13: unauthorized diff must not return snapshot-derived fields: {body}"
  );

  helpers::cleanup_users(&pool, &[alice_id, bobby_id]).await;
}

#[tokio::test]
async fn inv_audit_docver01_create_logged_with_actor() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-audit01").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!) { createDocumentVersion(workspaceId: $workspaceId, docId: $docId, label: \"audit-create\", description: \"audit test\") { id label } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
  )
  .await;
  assert!(
    body.get("errors").is_none(),
    "INV-AUDIT-DOCVER-01: create failed: {body}"
  );
  let version_id = body
    .pointer("/data/createDocumentVersion/id")
    .and_then(Value::as_str)
    .expect("created version id");

  let row = sqlx::query(
    "SELECT event_key, category, actor_user_id, target_id, new_value \
     FROM admin_audit_log \
     WHERE event_key = 'document_version.create' AND actor_user_id = $1 \
     ORDER BY created_at DESC LIMIT 1",
  )
  .bind(alice_id)
  .fetch_optional(&pool)
  .await
  .expect("fetch audit row")
  .expect("INV-AUDIT-DOCVER-01: missing document_version.create audit row");

  assert_eq!(row.get::<String, _>("category"), "document_version");
  assert_eq!(row.get::<Option<Uuid>, _>("actor_user_id"), Some(alice_id));
  assert_eq!(row.get::<String, _>("target_id"), version_id);
  let new_value: Value = row.get("new_value");
  assert_eq!(new_value.get("label").and_then(Value::as_str), Some("v1"));
  let doc_id_s = doc_id.to_string();
  assert_eq!(new_value.get("docId").and_then(Value::as_str), Some(doc_id_s.as_str()));

  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(alice_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[tokio::test]
async fn inv_audit_docver02_restore_logged_with_source_version() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-docver-audit02").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;

  let create_body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!) { createDocumentVersion(workspaceId: $workspaceId, docId: $docId, label: \"audit-restore-source\") { id label } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
  )
  .await;
  assert!(
    create_body.get("errors").is_none(),
    "INV-AUDIT-DOCVER-02: create failed: {create_body}"
  );
  let source_id = create_body
    .pointer("/data/createDocumentVersion/id")
    .and_then(Value::as_str)
    .expect("source version id")
    .to_string();

  let restore_body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation M($id: ID!) { restoreDocumentVersion(id: $id) { id label } }",
      "variables": { "id": source_id }
    }),
  )
  .await;
  assert!(
    restore_body.get("errors").is_none(),
    "INV-AUDIT-DOCVER-02: restore failed: {restore_body}"
  );
  let restored_id = restore_body
    .pointer("/data/restoreDocumentVersion/id")
    .and_then(Value::as_str)
    .expect("restored version id");

  let row = sqlx::query(
    "SELECT event_key, category, actor_user_id, target_id, old_value, new_value \
     FROM admin_audit_log \
     WHERE event_key = 'document_version.restore' AND actor_user_id = $1 \
     ORDER BY created_at DESC LIMIT 1",
  )
  .bind(alice_id)
  .fetch_optional(&pool)
  .await
  .expect("fetch audit row")
  .expect("INV-AUDIT-DOCVER-02: missing document_version.restore audit row");

  assert_eq!(row.get::<String, _>("category"), "document_version");
  assert_eq!(row.get::<Option<Uuid>, _>("actor_user_id"), Some(alice_id));
  assert_eq!(row.get::<String, _>("target_id"), restored_id);
  let old_value: Value = row.get("old_value");
  let new_value: Value = row.get("new_value");
  assert_eq!(old_value.get("id").and_then(Value::as_str), Some(source_id.as_str()));
  assert_eq!(
    new_value.get("sourceVersionId").and_then(Value::as_str),
    Some(source_id.as_str())
  );
  assert_eq!(new_value.get("sourceLabel").and_then(Value::as_str), Some("v1"));
  assert_eq!(new_value["id"], restored_id);
  assert_eq!(old_value["createdBy"], alice_id.to_string());
  assert_eq!(new_value["createdBy"], alice_id.to_string());
  assert_eq!(old_value["isPinned"], false);
  assert_eq!(new_value["isPinned"], false);
  assert!(new_value["recoveryHistoryId"].as_i64().is_some_and(|id| id > 0));
  for value in [&old_value, &new_value] {
    chrono::DateTime::parse_from_rfc3339(value["createdAt"].as_str().unwrap()).unwrap();
    assert_eq!(value["docId"], doc_id.to_string());
    assert_eq!(value["workspaceId"], workspace_id.to_string());
    assert!(value.get("description").is_some());
  }

  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(alice_id)
    .execute(&pool)
    .await
    .expect("remove restore audit fixture");
  helpers::cleanup_users(&pool, &[alice_id]).await;
}

#[test]
fn history_comparison_reconstructs_ordered_prose_without_losing_graphemes() {
  use myoxus_application::document_version::diff::{DocumentTextRunKind as Kind, diff_snapshots};
  for (old, current) in [
    ("red red blue", "red blue red"),
    ("  punctuation,\tkept!\r\nNext.  ", " punctuation;\tkept?\r\nNext!  "),
    ("Cafe\u{301} 👩🏽‍💻 世界 🇩🇪", "👩🏽‍💻 Cafe\u{301}! 世界 🇫🇷"),
    ("", "new paragraph"),
    ("removed paragraph", ""),
    ("unchanged", "unchanged"),
  ] {
    let result = diff_snapshots(
      &build_doc_version_yjs(&[("z-first", old)]),
      &build_doc_version_yjs(&[("z-first", current)]),
    )
    .unwrap();
    let block = result
      .comparison_blocks
      .iter()
      .find(|block| block.block_id == "z-first")
      .unwrap();
    let reconstructed = |excluded| {
      block
        .runs
        .iter()
        .filter(|run| run.kind != excluded)
        .map(|run| run.text.as_str())
        .collect::<String>()
    };
    assert_eq!(reconstructed(Kind::Added), old);
    assert_eq!(reconstructed(Kind::Removed), current);
    for (text, excluded) in [(old, Kind::Added), (current, Kind::Removed)] {
      let mut boundaries: std::collections::BTreeSet<_> = text
        .char_indices()
        .map(|(offset, _)| offset)
        .chain([text.len()])
        .collect();
      for cluster in ["e\u{301}", "👩🏽‍💻", "🇩🇪", "🇫🇷"] {
        for (start, _) in text.match_indices(cluster) {
          boundaries.retain(|offset| *offset <= start || *offset >= start + cluster.len());
        }
      }
      let mut offset = 0;
      for run in block.runs.iter().filter(|run| run.kind != excluded) {
        offset += run.text.len();
        assert!(boundaries.contains(&offset), "run split a grapheme: {run:?}");
      }
    }
    if old != current {
      assert!(block.runs.iter().any(|run| run.kind != Kind::Unchanged));
    }
  }
}

#[test]
fn history_comparison_keeps_native_order_and_reports_unplaced_or_unsupported_content() {
  use myoxus_application::document_version::diff::{
    DocumentComparisonBlockKind as BlockKind, DocumentComparisonNoticeKind as Notice, DocumentTextRunKind as Kind,
    diff_snapshots,
  };
  let old = build_doc_version_yjs(&[("z", "First"), ("deleted", "Removed context"), ("a", "Last")]);
  let current = build_doc_version_yjs(&[("z", "First"), ("new", "Added context"), ("a", "Last")]);
  let result = diff_snapshots(&old, &current).unwrap();
  assert_eq!(
    result
      .comparison_blocks
      .iter()
      .map(|block| block.block_id.as_str())
      .collect::<Vec<_>>(),
    ["page-1", "z", "new", "deleted", "a"]
  );
  assert_eq!(
    result
      .comparison_blocks
      .iter()
      .find(|b| b.block_id == "deleted")
      .unwrap()
      .kind,
    BlockKind::Removed
  );
  assert_eq!(
    result
      .comparison_blocks
      .iter()
      .find(|b| b.block_id == "new")
      .unwrap()
      .kind,
    BlockKind::Added
  );
  let moved = diff_snapshots(&old, &build_doc_version_yjs(&[("a", "Last"), ("z", "First")])).unwrap();
  let deletion = moved
    .comparison_blocks
    .iter()
    .find(|b| b.block_id == "deleted")
    .unwrap();
  assert!(!deletion.placement_known);
  assert!(
    moved
      .notices
      .iter()
      .any(|n| n.kind == Notice::AmbiguousRemovalAnchor && n.block_id.as_deref() == Some("deleted"))
  );
  assert!(moved.notices.iter().any(|n| n.kind == Notice::StructureChanged));
  for block in moved
    .comparison_blocks
    .iter()
    .filter(|b| b.block_id == "z" || b.block_id == "a")
  {
    assert!(
      block.runs.iter().all(|run| run.kind == Kind::Unchanged),
      "movement cannot fabricate prose edits"
    );
  }
  let native = Doc::new();
  native
    .transact_mut()
    .apply_update(yrs::Update::decode_v1(&current).unwrap())
    .unwrap();
  let blocks = native.get_or_insert_map("blocks");
  {
    let mut tx = native.transact_mut();
    let Some(yrs::Out::YMap(paragraph)) = blocks.get(&tx, "z") else {
      panic!("paragraph")
    };
    let Some(yrs::Out::YText(text)) = paragraph.get(&tx, "prop:text") else {
      panic!("text")
    };
    text.format(
      &mut tx,
      0,
      5,
      yrs::types::Attrs::from([(Arc::from("bold"), Any::Bool(true))]),
    );
  }
  let styled = diff_snapshots(
    &current,
    &native
      .transact()
      .encode_state_as_update_v1(&yrs::StateVector::default()),
  )
  .unwrap();
  assert!(
    styled.extraction_partial,
    "native styling alone must be reported as omitted"
  );
  assert!(
    !styled
      .notices
      .iter()
      .any(|n| n.kind == Notice::UnsupportedContent || n.kind == Notice::StructureChanged)
  );
  let styled_prose = styled.comparison_blocks.iter().find(|b| b.block_id == "z").unwrap();
  assert!(styled_prose.runs.iter().all(|run| run.kind == Kind::Unchanged));
  assert!(
    styled
      .text_diffs
      .iter()
      .any(|b| b.block_id == "z" && b.to_text.contains("**")),
    "retain deployed formatted summaries"
  );
  {
    let mut tx = native.transact_mut();
    let Some(yrs::Out::YMap(paragraph)) = blocks.get(&tx, "z") else {
      panic!("paragraph")
    };
    paragraph.insert(&mut tx, "sys:flavour", "myoxus:image");
    let Some(yrs::Out::YArray(children)) = paragraph.get(&tx, "sys:children") else {
      panic!("children")
    };
    children.push_back(&mut tx, "page-1"); // A cycle is not silently hidden.
    blocks.insert(
      &mut tx,
      "unreachable",
      MapPrelim::from([("sys:flavour", "myoxus:paragraph")]),
    );
  }
  let partial = diff_snapshots(
    &current,
    &native
      .transact()
      .encode_state_as_update_v1(&yrs::StateVector::default()),
  )
  .unwrap();
  assert!(partial.extraction_partial);
  assert!(partial.notices.iter().any(|n| n.kind == Notice::IncompleteStructure));
  assert!(partial.notices.iter().any(|n| n.kind == Notice::UnsupportedContent));
  let prose = partial.comparison_blocks.iter().find(|b| b.block_id == "z").unwrap();
  assert!(
    prose.runs.iter().all(|run| run.kind == Kind::Unchanged),
    "styling is not authored prose"
  );
  assert_eq!(prose.runs[0].text, "First");
  assert!(
    diff_snapshots(&[255], &current).is_err(),
    "invalid bytes cannot establish equality"
  );
  let unsupported_root = Doc::new();
  unsupported_root.get_or_insert_text("content").insert(
    &mut unsupported_root.transact_mut(),
    0,
    "outside native blocks",
  );
  let bytes = unsupported_root
    .transact()
    .encode_state_as_update_v1(&yrs::StateVector::default());
  assert!(diff_snapshots(&bytes, &bytes).unwrap().extraction_partial);
  let expensive = build_doc_version_yjs(&[("z", &"a".repeat(2100))]);
  let other = build_doc_version_yjs(&[("z", &"b".repeat(2100))]);
  assert!(matches!(
    diff_snapshots(&expensive, &other),
    Err(myoxus_application::document_version::DocumentVersionDiffError::Limit(_))
  ));
}

async fn history_comparison_readback(pool: &PgPool, doc: Uuid) -> Value {
  // Exact owned rows, not just counts: the projection must not acknowledge edits,
  // alter persisted bytes, capture history or reserve names. Authorization may
  // refresh the existing derived-metadata cache stamp; it is not content.
  sqlx::query_scalar("SELECT jsonb_build_object(
    'doc', (SELECT to_jsonb(d) - 'metadata_materialized_at' FROM docs d WHERE id=$1),
    'histories', (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY id),'[]') FROM doc_histories h WHERE doc_id=$1),
    'versions', (SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]') FROM document_version v WHERE doc_id=$1),
    'updates', (SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY sequence),'[]') FROM doc_updates u WHERE doc_id=$1),
    'snapshot', (SELECT to_jsonb(s) FROM doc_snapshots s WHERE doc_id=$1),
    'ack', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY workspace_id),'[]') FROM document_edit_capture_state c WHERE doc_id=$1))")
    .bind(doc).fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn history_diff_reads_current_uncaptured_tail_and_enforces_both_scopes_without_writes() {
  use futures_util::FutureExt;
  use myoxus_application::doc::DocHistoryStore;
  use std::panic::AssertUnwindSafe;
  let (app, pool, auth) = setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth, "history-current-diff").await;
  let (reader, reader_session) = helpers::seed_user(&pool, &auth, "history-denied-diff").await;
  let ws = helpers::create_workspace(&pool, owner).await;
  let foreign = helpers::create_workspace(&pool, owner).await;
  let doc = helpers::create_doc(&pool, ws, owner).await;
  let other = helpers::create_doc(&pool, ws, owner).await;
  let result = AssertUnwindSafe(async {
    let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
    let old = "red red blue. Cafe\u{301} 👩🏽‍💻\n";
    let current = "red blue red! Cafe\u{301} 👩🏽‍💻\n";
    let original = build_doc_version_yjs(&[("z-paragraph", old)]);
    service.push_update(ws, doc, original.clone(), 1, myoxus_application::doc::DocSpaceKind::Workspace).await.unwrap();
    let history = service.capture_history_snapshot(doc).await.unwrap();
    service.compaction.merge_pending_updates(ws, doc, 1).await.unwrap();
    let native = Doc::new();
    native.transact_mut().apply_update(yrs::Update::decode_v1(&original).unwrap()).unwrap();
    let blocks = native.get_or_insert_map("blocks");
    let update = {
      let mut tx = native.transact_mut();
      let Some(yrs::Out::YMap(p)) = blocks.get(&tx, "z-paragraph") else { panic!("paragraph") };
      let Some(yrs::Out::YText(text)) = p.get(&tx, "prop:text") else { panic!("text") };
      let length = text.len(&tx);
      text.remove_range(&mut tx, 0, length);
      text.insert(&mut tx, 0, current);
      tx.encode_update_v1()
    };
    service.push_update(ws, doc, update, 2, myoxus_application::doc::DocSpaceKind::Workspace).await.unwrap();
    let before = history_comparison_readback(&pool, doc).await;
    let query = |workspace: Uuid, document: Uuid, snapshot: String| json!({
      "query": "query Q($w:String!,$d:String!,$s:ID!) { workspace(id:$w) { historyDiff(guid:$d,snapshotId:$s) { snapshotId currentRevision readAt extractionPartial comparisonBlocks { blockId kind placementKnown runs { kind text } } notices { kind blockId } } } }",
      "variables":{"w":workspace.to_string(),"d":document.to_string(),"s":snapshot}
    });
    let body = helpers::gql(&app, session, query(ws, doc, history.to_string())).await;
    assert!(body.get("errors").is_none(), "history-current query: {body}");
    let comparison = &body["data"]["workspace"]["historyDiff"];
    assert_eq!(comparison["snapshotId"], history.to_string());
    assert_eq!(comparison["currentRevision"], "2");
    let time = chrono::DateTime::parse_from_rfc3339(comparison["readAt"].as_str().unwrap()).unwrap();
    assert!((chrono::Utc::now() - time.with_timezone(&chrono::Utc)).num_seconds() < 10);
    let block = comparison["comparisonBlocks"].as_array().unwrap().iter().find(|b| b["blockId"] == "z-paragraph").unwrap();
    for (excluded, expected) in [("added", old), ("removed", current)] {
      assert_eq!(block["runs"].as_array().unwrap().iter().filter(|r| r["kind"] != excluded).map(|r| r["text"].as_str().unwrap()).collect::<String>(), expected);
    }
    for (scope, document, snapshot) in [(foreign, doc, history.to_string()), (ws, other, history.to_string()), (ws, doc, "9007199254740993".into()), (ws, doc, "-1".into())] {
      let denied = helpers::gql(&app, session, query(scope, document, snapshot)).await;
      assert!(!errors_array(&denied).is_empty(), "foreign/absent comparison must fail: {denied}");
    }
    sqlx::query("INSERT INTO workspace_memberships (workspace_id,user_id,role,status,joined_at) VALUES ($1,$2,'External','Accepted',now())")
      .bind(ws).bind(reader).execute(&pool).await.unwrap();
    let denied = helpers::gql(&app, reader_session, query(ws, doc, history.to_string())).await;
    assert!(!errors_array(&denied).is_empty(), "Workspace_Read does not imply Doc_Read: {denied}");
    assert!(matches!(SqlxDocStore::new(pool.clone()).read_history_comparison(ws,doc,history,1).await, Err(myoxus_application::auth::AuthError::DocSyncPayloadTooLarge { .. })));
    assert_eq!(history_comparison_readback(&pool, doc).await, before);
  }).catch_unwind().await;
  sqlx::query("DELETE FROM workspaces WHERE id=ANY($1)")
    .bind([ws, foreign])
    .execute(&pool)
    .await
    .expect("delete owned diff workspaces");
  sqlx::query("DELETE FROM users WHERE id=ANY($1)")
    .bind([owner, reader])
    .execute(&pool)
    .await
    .expect("delete owned diff users");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn history_comparison_cannot_splice_move_or_compaction_revisions() {
  use futures_util::FutureExt;
  use myoxus_application::doc::DocHistoryStore;
  use std::{panic::AssertUnwindSafe, time::Duration};
  let (_, pool, auth) = setup_app().await;
  let (owner, _) = helpers::seed_user(&pool, &auth, "history-consistent-diff").await;
  let source = helpers::create_workspace(&pool, owner).await;
  let target = helpers::create_workspace(&pool, owner).await;
  let doc = helpers::create_doc(&pool, source, owner).await;
  let result = AssertUnwindSafe(async {
    let initial = build_doc_version_yjs(&[("z", "historical")]);
    let current = build_doc_version_yjs(&[("z", "current")]);
    let native = Doc::new();
    native.transact_mut().apply_update(yrs::Update::decode_v1(&current).unwrap()).unwrap();
    let blocks = native.get_or_insert_map("blocks");
    let tail = {
      let mut tx = native.transact_mut();
      let Some(yrs::Out::YMap(p)) = blocks.get(&tx, "z") else { panic!("paragraph") };
      let Some(yrs::Out::YText(text)) = p.get(&tx, "prop:text") else { panic!("text") };
      let end = text.len(&tx);
      text.insert(&mut tx, end, " pending");
      tx.encode_update_v1()
    };
    let compacted = yjs::merge_updates(vec![current.clone(),tail.clone()]).unwrap();
    let history: i64 = sqlx::query_scalar("INSERT INTO doc_histories(doc_id,workspace_id,snapshot) VALUES($1,$2,$3) RETURNING id")
      .bind(doc).bind(source).bind(&initial).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO doc_snapshots(doc_id,workspace_id,payload,last_sequence) VALUES($1,$2,$3,1)")
      .bind(doc).bind(source).bind(&current).execute(&pool).await.unwrap();
    // Writer and reader occupy the shared two-connection fixture pool. Observe
    // the barrier through a third, test-owned connection, without widening it.
    use sqlx::Connection as _;
    let mut observer = sqlx::PgConnection::connect(&std::env::var("TEST_DATABASE_URL").expect("isolated test database")).await.unwrap();
    for moves in [false, true] {
      sqlx::query("UPDATE doc_snapshots SET payload=$2,last_sequence=1 WHERE doc_id=$1").bind(doc).bind(&current).execute(&pool).await.unwrap();
      sqlx::query("INSERT INTO doc_updates(doc_id,workspace_id,payload,sequence) VALUES($1,$2,$3,2)").bind(doc).bind(source).bind(&tail).execute(&pool).await.unwrap();
      // Pause after the compacted snapshot read, before reading its tail.
      // Compaction removes that tail; Move additionally republishes ownership.
      // READ COMMITTED would silently lose ' pending' and report revision 1.
      let mut writer = pool.begin().await.unwrap();
      sqlx::query("LOCK TABLE doc_updates IN ACCESS EXCLUSIVE MODE").execute(&mut *writer).await.unwrap();
      let read = tokio::spawn({
        let pool = pool.clone();
        async move { SqlxDocStore::new(pool).read_history_comparison(source, doc, history, 32 * 1024 * 1024).await }
      });
      let blocked = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
          let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT sequence, CASE WHEN octet_length(payload)%')")
            .fetch_one(&mut observer).await.unwrap();
          if waiting { break; }
          tokio::time::sleep(Duration::from_millis(20)).await;
        }
      }).await;
      if blocked.is_err() {
        writer.rollback().await.unwrap();
        match read.await {
          Ok(Err(error)) => panic!("comparison failed before reaching the tail read: {error}"),
          Ok(Ok(value)) => panic!("comparison unexpectedly finished without its barrier at revision {}", value.current_revision),
          Err(error) => panic!("comparison reader failed: {error}"),
        }
      }
      let destination = if moves { target } else { source };
      sqlx::query("UPDATE docs SET workspace_id=$1 WHERE id=$2").bind(destination).bind(doc).execute(&mut *writer).await.unwrap();
      sqlx::query("UPDATE doc_histories SET workspace_id=$1 WHERE doc_id=$2").bind(destination).bind(doc).execute(&mut *writer).await.unwrap();
      sqlx::query("UPDATE doc_snapshots SET workspace_id=$1,payload=$3,last_sequence=2 WHERE doc_id=$2").bind(destination).bind(doc).bind(&compacted).execute(&mut *writer).await.unwrap();
      sqlx::query("DELETE FROM doc_updates WHERE doc_id=$1").bind(doc).execute(&mut *writer).await.unwrap();
      writer.commit().await.unwrap();
      let comparison = tokio::time::timeout(Duration::from_secs(5), read).await.unwrap().unwrap().unwrap();
      assert_eq!(comparison.history_snapshot, initial);
      assert_eq!(comparison.current_snapshot, compacted);
      assert_eq!(comparison.current_revision, 2);
      let store = SqlxDocStore::new(pool.clone());
      if moves {
        assert!(matches!(store.read_history_comparison(source,doc,history,32*1024*1024).await, Err(myoxus_application::auth::AuthError::NotFound(_))));
      }
      let after = store.read_history_comparison(destination,doc,history,32*1024*1024).await.unwrap();
      assert_eq!(after.history_snapshot, initial);
      assert_eq!(after.current_snapshot, compacted);
      assert_eq!(after.current_revision, 2);
    }
  }).catch_unwind().await;
  sqlx::query("DELETE FROM workspaces WHERE id=ANY($1)")
    .bind([source, target])
    .execute(&pool)
    .await
    .expect("delete owned comparison race workspaces");
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(owner)
    .execute(&pool)
    .await
    .expect("delete owned comparison race actor");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}
