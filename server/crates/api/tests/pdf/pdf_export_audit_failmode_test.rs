// SPDX-License-Identifier: AGPL-3.0-or-later
//! `P-PDF-TPL-AUDIT-01-06` integration test: when the render-audit
//! insert fails, the `export_pdf` mutation must abort and **not**
//! land a row in `pdf_export_jobs`.
//!
//! The audit recorder runs synchronously on the critical path; a
//! storage failure here is the load-bearing compliance signal because
//! a missing audit row is the only way an unobserved render could ever
//! occur. We verify the negative path with a fault-injecting mock repo.

#![allow(clippy::too_many_lines)]

use crate::helpers;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;
use yrs::{Any, Array as _, Doc, Map as _, MapPrelim, ReadTxn as _, Transact};

use myoxus_application::audit::AuditRecorder;
use myoxus_domain::entities::PdfExportRenderAudit;
use myoxus_domain::repositories::{PdfExportRenderAuditRepository, RepoResult, RepositoryError};
use myoxus_infrastructure::audit::PgAuditLogStore;
use myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository;
use myoxus_infrastructure::document_metadata_policy::PgDocumentMetadataPolicyRepository;
use myoxus_infrastructure::pdf_export::{
  PdfBlobStore, PgPdfFontRepository, PgPdfTemplateRepository, PgPdfWorkspaceBrandAssetRepository,
  PgPdfWorkspaceTemplateAssignmentRepository,
};
use myoxus_infrastructure::storage::StorageAdapter;

// ─── Fault-injecting mock repository ────────────────────────────────────────

/// Repo that always fails the `record` call. Every other method falls
/// back to "not implemented" because `export_pdf` only calls
/// `record` from the synchronous critical path.
#[derive(Debug)]
struct FailingAuditRepo;

#[async_trait]
impl PdfExportRenderAuditRepository for FailingAuditRepo {
  async fn record(&self, _entry: &PdfExportRenderAudit) -> RepoResult<()> {
    Err(RepositoryError::Storage("simulated DB failure".into()))
  }
  async fn list_for_workspace(&self, _w: Uuid, _l: i64) -> RepoResult<Vec<PdfExportRenderAudit>> {
    Ok(vec![])
  }
  async fn list_for_actor(&self, _a: Uuid, _l: i64) -> RepoResult<Vec<PdfExportRenderAudit>> {
    Ok(vec![])
  }
  async fn purge_before(&self, _b: chrono::DateTime<chrono::Utc>) -> RepoResult<u64> {
    Ok(0)
  }
}

// ─── Test app builder ───────────────────────────────────────────────────────

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
  let storage_dir = format!("./test-storage/pdf-fail-{}", Uuid::new_v4());
  let storage_adapter = Arc::new(StorageAdapter::new_fs(&storage_dir).expect("storage"));
  let storage_op = storage_adapter.operator();
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
  let render_audit_repo: Arc<dyn myoxus_domain::repositories::PdfExportRenderAuditRepository> =
    Arc::new(FailingAuditRepo);
  let pdf_blob_store = Arc::new(PdfBlobStore::new(storage_op));
  let document_metadata_policy_repo: Arc<dyn myoxus_domain::repositories::DocumentMetadataPolicyRepository> =
    Arc::new(PgDocumentMetadataPolicyRepository::new(pool.clone()));
  let document_metadata_repo: Arc<dyn myoxus_domain::repositories::DocumentMetadataRepository> =
    Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
  let document_metadata_service =
    myoxus_application::document_metadata::DocumentMetadataService::new(document_metadata_repo);

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
  .with_pdf_render_audit_repo(render_audit_repo)
  .with_document_metadata_policy_repo(document_metadata_policy_repo)
  .with_document_metadata_service(document_metadata_service)
  .with_audit_recorder(audit_recorder);

  (build_router(state), pool, auth_store)
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

async fn insert_doc(pool: &PgPool, ws_id: Uuid, by: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO docs (id, workspace_id, title, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, now(), now())"#,
  )
  .bind(id)
  .bind(ws_id)
  .bind("Failmode Test")
  .bind(by)
  .execute(pool)
  .await
  .expect("insert doc");
  id
}

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

async fn insert_template(pool: &PgPool, slug: &str, created_by: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  let manifest = json!({
    "schema_version": "2.0",
    "id": slug,
    "name": slug,
    "description": "Audit failmode integration test fixture.",
    "version": "1.0.0",
    "engine": { "name": "typst", "version": "0.15.x" },
    "provenance": {
      "license_spdx": "AGPL-3.0-or-later",
      "copyright_notice": "Copyright 2026 Myoxus test contributors",
      "source_url": "https://example.test/templates/audit-failmode",
      "source_revision": "1.0.0"
    },
    "entry": "main.typ",
    "assets": ["main.typ"],
    "capabilities": {
      "colorVariant": { "kind": "enum", "values": ["mono", "accent", "brand"], "default": "mono" },
      "headerStyle":  { "kind": "enum", "values": ["none", "minimal", "branded"], "default": "minimal" },
      "footerStyle":  { "kind": "enum", "values": ["none", "minimal", "page-only", "brand-and-page"], "default": "page-only" },
      "coverPage":    { "kind": "boolean", "default": false },
      "tocBehavior":  { "kind": "enum", "values": ["off", "auto", "force"], "default": "off" },
      "pageNumbering":{ "kind": "enum", "values": ["arabic", "roman", "none"], "default": "arabic" },
      "customMargins":{ "kind": "boolean", "default": false },
      "accentColor":  { "kind": "color", "default": "#1F2937" },
      "confidentialityLabels": {
        "kind": "array<string>", "min_items": 0, "max_items": 4,
        "item_pattern": "^[A-Za-z0-9 _-]{1,32}$",
        "default": ["Public", "Internal", "Confidential", "Secret"]
      },
      "language": { "kind": "enum", "values": ["en", "de"], "default": "en" }
    },
    "inputs_schema": { "type": "object", "additionalProperties": false, "properties": {} }
  });
  sqlx::query(
    r#"INSERT INTO pdf_templates (id, slug, name, version, schema_version, manifest, created_by, created_at)
       VALUES ($1, $2, $3, '1.0.0', '2.0', $4, $5, now())"#,
  )
  .bind(id)
  .bind(slug)
  .bind(slug)
  .bind(&manifest)
  .bind(created_by)
  .execute(pool)
  .await
  .expect("insert pdf template");
  id
}

async fn assign_template(pool: &PgPool, ws: Uuid, tpl: Uuid, by: Uuid) {
  sqlx::query(
    r#"INSERT INTO pdf_workspace_template_assignments
         (workspace_id, template_id, is_default, assigned_by, assigned_at)
       VALUES ($1, $2, false, $3, now())"#,
  )
  .bind(ws)
  .bind(tpl)
  .bind(by)
  .execute(pool)
  .await
  .expect("assign pdf template");
}

async fn count_jobs(pool: &PgPool, ws: Uuid) -> i64 {
  sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pdf_export_jobs WHERE workspace_id = $1")
    .bind(ws)
    .fetch_one(pool)
    .await
    .expect("count")
}

async fn cleanup(pool: &PgPool, ws: Uuid, doc: Uuid, tpl: Uuid, user: Uuid) {
  let _ = sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
    .bind(tpl)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM doc_snapshots WHERE doc_id = $1")
    .bind(doc)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user)
    .execute(pool)
    .await;
}

// ─── INV-PDF-AUDIT-RENDER-02 — render-audit DB fail aborts the render ───────

#[test]
fn inv_audit_render02_db_write_fail_aborts_render() {
  helpers::block_on_large_stack("inv_audit_render02_db_write_fail_aborts_render", || async {
    let (app, pool, auth_store) = setup_app().await;
    let (alice, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-failmode").await;
    let ws = helpers::create_workspace(&pool, alice).await;
    let doc = insert_doc(&pool, ws, alice).await;
    insert_doc_snapshot(&pool, ws, doc, build_pdf_doc_yjs(2)).await;
    let tpl = insert_template(&pool, &format!("failmode-{}", Uuid::new_v4().simple()), alice).await;
    assign_template(&pool, ws, tpl, alice).await;

    let body: Value = helpers::gql(
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
    let errs = body
      .get("errors")
      .and_then(Value::as_array)
      .cloned()
      .unwrap_or_default();
    assert!(
      !errs.is_empty(),
      "INV-PDF-AUDIT-RENDER-02: failing audit-recorder must abort the render: {body}"
    );
    let msg = errs[0].pointer("/message").and_then(Value::as_str).unwrap_or("");
    assert!(
      msg.contains("audit"),
      "INV-PDF-AUDIT-RENDER-02: error must mention the render-audit failure (got {msg:?})"
    );

    assert_eq!(
      count_jobs(&pool, ws).await,
      0,
      "INV-PDF-AUDIT-RENDER-02: aborted render must not insert any pdf_export_jobs row"
    );

    cleanup(&pool, ws, doc, tpl, alice).await;
  });
}
