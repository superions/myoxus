// SPDX-License-Identifier: AGPL-3.0-or-later
//! `P-PDF-TPL-11-{03,06}` integration tests for the assignment-validation
//! and audit-log additions to `export_pdf`.
//!
//! Invariants:
//!
//! - `INV-PDF-EXP-01` (`P-PDF-TPL-11-03`):
//!   When a UUID or slug is passed but the workspace does not have an
//!   active assignment for that template, the mutation is refused with
//!   `extensions.class = "Forbidden"` and `pdf_export_jobs` stays untouched.
//!
//! - `INV-PDF-EXP-02` (`P-PDF-TPL-11-06`):
//!   A successful start emits a single `pdf_export.start` audit row tied to
//!   the calling user. The async path (queued job) is the easier surface to
//!   exercise because the test harness has no Redis queue wired — the
//!   mutation lands a row in `pdf_export_jobs` with `status='queued'`,
//!   plus the audit entry.

#![allow(clippy::too_many_lines)]

use crate::helpers;
use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;
use yrs::{Any, Array as _, Doc, Map as _, MapPrelim, ReadTxn as _, Transact};

use myoxus_application::audit::AuditRecorder;
use myoxus_infrastructure::audit::PgAuditLogStore;
use myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository;
use myoxus_infrastructure::document_metadata_policy::PgDocumentMetadataPolicyRepository;
use myoxus_infrastructure::pdf_export::{
  PdfBlobStore, PgPdfExportRenderAuditRepository, PgPdfFontRepository, PgPdfTemplateRepository,
  PgPdfWorkspaceBrandAssetRepository, PgPdfWorkspaceTemplateAssignmentRepository,
};
use myoxus_infrastructure::storage::StorageAdapter;

// ---------------------------------------------------------------------------
// Test app builder. Mirrors pdf_workspace_admin_test::setup_app — wires the
// PDF template repo, assignment repo, brand repo, and the real
// PgAuditLogStore so the audit-log invariant survives schema changes.
// ---------------------------------------------------------------------------

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
  let mut config = AppConfig::load().expect("config");
  // The test fixture inserts a `pdf_templates` row without bundle files,
  // so the sync render path can't load the template bundle (no
  // `theme.typ` / `preamble.typ`). Force the async path so the
  // assignment + audit invariants get exercised without depending on
  // a working bundle. Tests that DO want to exercise the renderer wire
  // a real bundle (see `pdf_export_v2_mutation_test`).
  config.pdf_export.sync_threshold_blocks = 0;

  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage_dir = format!("./test-storage/pdf-exp-{}", Uuid::new_v4());
  let storage_adapter = Arc::new(StorageAdapter::new_fs(&storage_dir).expect("storage"));
  let storage: Arc<dyn myoxus_application::ports::BlobStoragePort> = storage_adapter.clone();
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

  let template_repo: Arc<dyn myoxus_domain::repositories::PdfTemplateRepository> =
    Arc::new(PgPdfTemplateRepository::new(pool.clone()));
  let assignment_repo: Arc<dyn myoxus_domain::repositories::PdfWorkspaceTemplateAssignmentRepository> =
    Arc::new(PgPdfWorkspaceTemplateAssignmentRepository::new(pool.clone()));
  let brand_repo: Arc<dyn myoxus_domain::repositories::PdfWorkspaceBrandAssetRepository> =
    Arc::new(PgPdfWorkspaceBrandAssetRepository::new(pool.clone()));
  let document_metadata_policy_repo: Arc<dyn myoxus_domain::repositories::DocumentMetadataPolicyRepository> =
    Arc::new(PgDocumentMetadataPolicyRepository::new(pool.clone()));
  let document_metadata_repo: Arc<dyn myoxus_domain::repositories::DocumentMetadataRepository> =
    Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
  let document_metadata_service =
    myoxus_application::document_metadata::DocumentMetadataService::new(document_metadata_repo);
  // The V2 hot-path switch (P-PDF-TPL-13) made `export_pdf` resolve
  // every template through the V2 registry — that lookup needs both the
  // template repo AND the blob store. Tests that exercise the sync render
  // path must wire the blob store; without it `export_pdf` returns
  // "pdf blob store is not configured on this server".
  let storage_op = storage_adapter.operator();
  let pdf_blob_store = Arc::new(PdfBlobStore::new(storage_op));

  let audit_store: Arc<dyn myoxus_domain::audit::AuditLogStore> = Arc::new(PgAuditLogStore::new(pool.clone()));
  let audit_recorder = AuditRecorder::new(audit_store);

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
  .with_pdf_template_repo(template_repo)
  .with_pdf_assignment_repo(assignment_repo)
  .with_pdf_brand_repo(brand_repo)
  .with_pdf_blob_store(pdf_blob_store)
  .with_pdf_font_repo(Arc::new(PgPdfFontRepository::new(pool.clone())))
  .with_pdf_render_audit_repo(Arc::new(PgPdfExportRenderAuditRepository::new(pool.clone())))
  .with_document_metadata_policy_repo(document_metadata_policy_repo)
  .with_document_metadata_service(document_metadata_service)
  .with_audit_recorder(audit_recorder);

  (build_router(state), pool, auth_store)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async fn insert_template(pool: &PgPool, slug: &str, created_by: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  // Full manifest matching the strict `PdfTemplateManifest` shape — the V2
  // hot path (P-PDF-TPL-13) loads templates through the registry, which
  // deserialises the manifest into the typed struct. A skeleton manifest
  // with only `capabilities: {}` no longer parses (missing required keys
  // like `colorVariant`/`headerStyle`/...), so test fixtures must ship the
  // full capability matrix.
  let manifest = json!({
    "schema_version": "2.0",
    "id": slug,
    "name": slug,
    "description": "Assignment-test fixture.",
    "version": "1.0.0",
    "engine": { "name": "typst", "version": "0.15.x" },
    "provenance": {
      "license_spdx": "AGPL-3.0-or-later",
      "copyright_notice": "Copyright 2026 Myoxus test contributors",
      "source_url": "https://example.test/templates/assignment-test",
      "source_revision": "1.0.0"
    },
    "entry": "main.typ",
    "assets": ["main.typ"],
    "capabilities": {
      "colorVariant": { "kind": "enum", "values": ["mono"], "default": "mono" },
      "headerStyle": { "kind": "enum", "values": ["minimal"], "default": "minimal" },
      "footerStyle": { "kind": "enum", "values": ["page-only"], "default": "page-only" },
      "coverPage": { "kind": "boolean", "default": false },
      "tocBehavior": { "kind": "enum", "values": ["off"], "default": "off" },
      "pageNumbering": { "kind": "enum", "values": ["arabic"], "default": "arabic" },
      "customMargins": { "kind": "boolean", "default": false },
      "accentColor": { "kind": "color", "default": "#000000" },
      "confidentialityLabels": {
        "kind": "array<string>", "min_items": 0, "max_items": 0,
        "item_pattern": "^.*$", "default": []
      },
      "language": { "kind": "enum", "values": ["en"], "default": "en" }
    },
    "inputs_schema": { "type": "object", "additionalProperties": false, "properties": {} }
  });
  sqlx::query(
    r#"INSERT INTO pdf_templates (id, slug, name, version, schema_version, manifest, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())"#,
  )
  .bind(id)
  .bind(slug)
  .bind(slug)
  .bind("1.0.0")
  .bind("2.0")
  .bind(&manifest)
  .bind(created_by)
  .execute(pool)
  .await
  .expect("insert pdf_templates");
  id
}

async fn insert_doc(pool: &PgPool, ws_id: Uuid, created_by: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO docs (id, workspace_id, title, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, now(), now())"#,
  )
  .bind(id)
  .bind(ws_id)
  .bind("Test Doc")
  .bind(created_by)
  .execute(pool)
  .await
  .expect("insert doc");
  id
}

/// Build a minimal Yjs v1 update that the PDF builder can decode into an
/// IR with `paragraphs` paragraph blocks under a single page. Mirrors the
/// helper in `pdf_export_api_test.rs`.
fn build_pdf_doc_yjs(paragraphs: usize) -> Vec<u8> {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();
  blocks.insert(&mut txn, "page-1", MapPrelim::default());
  let page_map = match blocks.get(&txn, "page-1") {
    Some(yrs::Out::YMap(m)) => m,
    _ => panic!("page-1 missing"),
  };
  page_map.insert(&mut txn, "sys:flavour", "myoxus:page");
  page_map.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  let children = match page_map.get(&txn, "sys:children") {
    Some(yrs::Out::YArray(a)) => a,
    _ => panic!("sys:children missing"),
  };
  for i in 0..paragraphs {
    let id = format!("p-{i}");
    children.push_back(&mut txn, Any::String(id.clone().into()));
    blocks.insert(&mut txn, id.as_str(), MapPrelim::default());
    let bmap = match blocks.get(&txn, id.as_str()) {
      Some(yrs::Out::YMap(m)) => m,
      _ => panic!("paragraph missing"),
    };
    bmap.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
  }
  drop(txn);
  doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
}

async fn insert_doc_snapshot(pool: &PgPool, ws_id: Uuid, doc_id: Uuid, payload: Vec<u8>) {
  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at) \
     VALUES ($1, $2, $3, 0, now())",
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(payload)
  .execute(pool)
  .await
  .expect("insert doc_snapshots");
}

async fn count_export_jobs(pool: &PgPool, ws_id: Uuid) -> i64 {
  sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pdf_export_jobs WHERE workspace_id = $1")
    .bind(ws_id)
    .fetch_one(pool)
    .await
    .expect("count export jobs")
}

async fn count_export_audit(pool: &PgPool, actor: Uuid) -> i64 {
  sqlx::query_scalar::<_, i64>(
    "SELECT COUNT(*) FROM admin_audit_log WHERE event_key = 'pdf_export.start' AND actor_user_id = $1",
  )
  .bind(actor)
  .fetch_one(pool)
  .await
  .expect("count export audit")
}

fn errors_array(body: &Value) -> Vec<String> {
  body
    .get("errors")
    .and_then(|v| v.as_array())
    .map(|arr| {
      arr
        .iter()
        .filter_map(|e| e.get("message").and_then(|m| m.as_str()).map(str::to_owned))
        .collect()
    })
    .unwrap_or_default()
}

fn error_class(body: &Value) -> Option<String> {
  body
    .pointer("/errors/0/extensions/class")
    .and_then(Value::as_str)
    .map(str::to_owned)
}

async fn cleanup(pool: &PgPool, ws_id: Uuid, doc_id: Uuid, tpl_id: Uuid, user_id: Uuid) {
  let _ = sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM pdf_export_jobs WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
    .bind(tpl_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await;
}

// ---------------------------------------------------------------------------
// INV-PDF-EXP-01 — unassigned template UUID is rejected
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_exp01_unassigned_template_rejected() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, _admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-exp01").await;
  let ws = helpers::create_workspace(&pool, alice_id).await;
  let tpl_slug = format!("tpl-exp01-{}", Uuid::new_v4().simple());
  let tpl = insert_template(&pool, &tpl_slug, admin_id).await;
  let doc = insert_doc(&pool, ws, alice_id).await;

  // Pre-condition: no pdf_export_jobs.
  assert_eq!(count_export_jobs(&pool, ws).await, 0);

  for template_ref in [tpl.to_string(), tpl_slug] {
    // No assignment exists → mutation must reject.
    let body = helpers::gql(
      &app,
      alice_session,
      json!({
        "query": "mutation Start($input: PdfExportInputV2Input!) { exportPdf(input: $input) { id status } }",
        "variables": {
          "input": {
            "workspaceId": ws.to_string(),
            "docId": doc.to_string(),
            "templateId": template_ref,
          }
        }
      }),
    )
    .await;
    let errs = errors_array(&body);
    assert!(
      !errs.is_empty(),
      "INV-PDF-EXP-01: unassigned template must be rejected: {body}"
    );
    assert_eq!(
      error_class(&body).as_deref(),
      Some("Forbidden"),
      "INV-PDF-EXP-01: refusal must carry extensions.class = Forbidden"
    );
    assert_eq!(
      count_export_jobs(&pool, ws).await,
      0,
      "INV-PDF-EXP-01: rejected mutation must not create a pdf_export_jobs row"
    );
    assert_eq!(
      count_export_audit(&pool, alice_id).await,
      0,
      "INV-PDF-EXP-01: rejected mutation must not emit a pdf_export.start audit row"
    );
  }

  cleanup(&pool, ws, doc, tpl, alice_id).await;
  let _ = sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(admin_id)
    .execute(&pool)
    .await;
}

// ---------------------------------------------------------------------------
// INV-PDF-EXP-02 — successful start emits exactly one audit row
// ---------------------------------------------------------------------------

// Multi-threaded runtime is required because the sync render path calls
// `tokio::task::block_in_place` inside the Typst pipeline.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_exp02_successful_start_emits_audit() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, _admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-exp02").await;
  let ws = helpers::create_workspace(&pool, alice_id).await;
  let tpl_slug = format!("tpl-exp02-{}", Uuid::new_v4().simple());
  let tpl = insert_template(&pool, &tpl_slug, admin_id).await;
  let doc = insert_doc(&pool, ws, alice_id).await;
  // Seed a small Yjs snapshot so the sync render path can decode the doc.
  insert_doc_snapshot(&pool, ws, doc, build_pdf_doc_yjs(3)).await;

  // Assign the template to the workspace so the validation passes.
  sqlx::query(
    r#"INSERT INTO pdf_workspace_template_assignments
         (workspace_id, template_id, is_default, assigned_by, assigned_at)
       VALUES ($1, $2, false, $3, now())"#,
  )
  .bind(ws)
  .bind(tpl)
  .bind(admin_id)
  .execute(&pool)
  .await
  .expect("insert assignment");

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation Start($input: PdfExportInputV2Input!) { exportPdf(input: $input) { id status } }",
      "variables": {
        "input": {
          "workspaceId": ws.to_string(),
          "docId": doc.to_string(),
          "templateId": tpl.to_string(),
        }
      }
    }),
  )
  .await;
  assert!(
    body.get("errors").is_none(),
    "INV-PDF-EXP-02: assigned template start must succeed: {body}"
  );

  // Without a Redis queue wired, the row lands as `queued` — that's the
  // async path, which still emits the audit entry.
  assert_eq!(
    count_export_jobs(&pool, ws).await,
    1,
    "INV-PDF-EXP-02: successful start must persist exactly one pdf_export_jobs row"
  );
  assert_eq!(
    count_export_audit(&pool, alice_id).await,
    1,
    "INV-PDF-EXP-02: successful start must emit exactly one pdf_export.start audit row"
  );

  cleanup(&pool, ws, doc, tpl, alice_id).await;
  let _ = sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(admin_id)
    .execute(&pool)
    .await;
}
