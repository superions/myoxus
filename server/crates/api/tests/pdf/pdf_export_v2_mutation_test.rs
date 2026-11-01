// SPDX-License-Identifier: AGPL-3.0-or-later
//! `P-PDF-TPL-11-{01,02}` integration tests for the V2 `exportPdf` mutation.
//!
//! The V2 mutation widens the input surface to the full L3 shape declared
//! in [`PdfExportInputV2`] (locale + paper_size + image_quality +
//! cover_page + toc_behavior + confidentiality_label + typed_inputs)
//! and runs [`validate_inputs_against_manifest`] before any render is
//! dispatched. This file proves two invariants:
//!
//! - `INV-PDF-EXP-V2-01` (`P-PDF-TPL-11-02`):
//!   An input that touches an off-capability (here: a confidentiality
//!   label against a manifest whose `confidentialityLabels.max_items == 0`)
//!   is refused with `extensions.class = "CapabilityViolation"` and a
//!   structured `violationsJson` payload. **No** `pdf_export_jobs` row
//!   is created and **no** `pdf_export.start` audit row is emitted.
//!
//! - `INV-PDF-EXP-V2-02` (`P-PDF-TPL-11-02`):
//!   When the input passes capability validation the mutation forwards
//!   to the canonical `exportPdf` dispatcher (slug-form template), which
//!   creates a `pdf_export_jobs` row and emits the standard audit
//!   event. This proves the new mutation does not break the existing
//!   audit/idempotency invariants.
//!
//! [`PdfExportInputV2`]: myoxus_application::pdf_export::render_context::PdfExportInputV2
//! [`validate_inputs_against_manifest`]: myoxus_application::pdf_export::capability_validator::validate_inputs_against_manifest

#![allow(clippy::too_many_lines)]

use crate::helpers;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures_util::FutureExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use myoxus_application::audit::AuditRecorder;
use myoxus_infrastructure::audit::PgAuditLogStore;
use myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository;
use myoxus_infrastructure::document_metadata_policy::PgDocumentMetadataPolicyRepository;
use myoxus_infrastructure::document_version::{PgDocumentVersionRepository, PgDocumentVersioningSettingsRepository};
use myoxus_infrastructure::pdf_export::{
  PdfBlobStore, PgPdfExportRenderAuditRepository, PgPdfFontRepository, PgPdfTemplateRepository,
  PgPdfWorkspaceBrandAssetRepository, PgPdfWorkspaceTemplateAssignmentRepository,
};
use myoxus_infrastructure::storage::StorageAdapter;

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

pub(super) async fn setup_app() -> (axum::Router, PgPool, Arc<myoxus_infrastructure::auth::SqlxAuthStore>) {
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
  // Force the queued/async path so the test does not depend on a
  // working renderer + Yjs snapshot — capability validation runs before
  // dispatch either way.
  config.pdf_export.sync_threshold_blocks = 0;

  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage_dir = format!("./test-storage/pdf-v2-mut-{}", Uuid::new_v4());
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
  let pdf_blob_store = Arc::new(PdfBlobStore::new(storage_op));
  let render_audit_repo: Arc<dyn myoxus_domain::repositories::PdfExportRenderAuditRepository> =
    Arc::new(PgPdfExportRenderAuditRepository::new(pool.clone()));
  let document_version_repo: Arc<dyn myoxus_domain::repositories::DocumentVersionRepository> =
    Arc::new(PgDocumentVersionRepository::new(pool.clone()));
  let document_version_settings_repo: Arc<dyn myoxus_domain::repositories::DocumentVersioningSettingsRepository> =
    Arc::new(PgDocumentVersioningSettingsRepository::new(pool.clone()));
  let document_metadata_policy_repo: Arc<dyn myoxus_domain::repositories::DocumentMetadataPolicyRepository> =
    Arc::new(PgDocumentMetadataPolicyRepository::new(pool.clone()));
  let document_metadata_repo: Arc<dyn myoxus_domain::repositories::DocumentMetadataRepository> =
    Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
  // V2 export dispatch reads the native document metadata projection before it
  // records the queued job. Keep the fixture router wired like production so a
  // missing service cannot mask template, policy or audit regressions.
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
  .with_document_version_repo(document_version_repo)
  .with_document_version_settings_repo(document_version_settings_repo)
  .with_document_metadata_policy_repo(document_metadata_policy_repo)
  .with_document_metadata_service(document_metadata_service)
  .with_audit_recorder(audit_recorder);

  (build_router(state), pool, auth_store)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// Build a minimal V2 manifest where `confidentialityLabels.max_items == 0`
/// — so the capability is *off* — but every other field is present so the
/// schema validator accepts the manifest.
fn manifest_with_disabled_classification(slug: &str) -> Value {
  json!({
    "schema_version": "2.0",
    "id": slug,
    "name": slug,
    "description": "V2 mutation test fixture (capability validation).",
    "version": "1.0.0",
    "engine": { "name": "typst", "version": "0.15.x" },
    "provenance": {
      "license_spdx": "AGPL-3.0-or-later",
      "copyright_notice": "Copyright 2026 Myoxus test contributors",
      "source_url": "https://example.test/templates/v2-disabled-classification",
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
      // The capability is OFF: max_items=0 means no labels are allowed,
      // and the input validator must reject any non-empty label.
      "confidentialityLabels": {
        "kind": "array<string>", "min_items": 0, "max_items": 0,
        "item_pattern": "^.*$", "default": []
      },
      "language": { "kind": "enum", "values": ["en"], "default": "en" }
    },
    "inputs_schema": { "type": "object", "additionalProperties": false, "properties": {} }
  })
}

/// Build a permissive manifest where every capability is on so `exportPdf`
/// can dispatch a clean job (used by INV-PDF-EXP-V2-02).
pub(super) fn manifest_permissive(slug: &str) -> Value {
  json!({
    "schema_version": "2.0",
    "id": slug,
    "name": slug,
    "description": "V2 mutation test fixture (permissive capabilities).",
    "version": "1.0.0",
    "engine": { "name": "typst", "version": "0.15.x" },
    "provenance": {
      "license_spdx": "AGPL-3.0-or-later",
      "copyright_notice": "Copyright 2026 Myoxus test contributors",
      "source_url": "https://example.test/templates/v2-permissive",
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
  })
}

pub(super) async fn insert_template_with_manifest(
  pool: &PgPool,
  slug: &str,
  manifest: Value,
  created_by: Uuid,
) -> Uuid {
  let id = Uuid::new_v4();
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
  .expect("insert pdf_templates");
  id
}

pub(super) async fn assign_template(pool: &PgPool, ws: Uuid, tpl: Uuid, by: Uuid) {
  sqlx::query(
    r#"INSERT INTO pdf_workspace_template_assignments
         (workspace_id, template_id, is_default, assigned_by, assigned_at)
       VALUES ($1, $2, false, $3, now())
       ON CONFLICT DO NOTHING"#,
  )
  .bind(ws)
  .bind(tpl)
  .bind(by)
  .execute(pool)
  .await
  .expect("insert assignment");
}

async fn insert_doc(pool: &PgPool, workspace_id: Uuid, actor_id: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by) \
     VALUES ($1, $2, 'PDF Version Bridge Doc', 'viewer', false, $3, $3)",
  )
  .bind(id)
  .bind(workspace_id)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("insert doc");
  id
}

async fn enable_pdf_auto_versioning(pool: &PgPool, doc_id: Uuid) {
  sqlx::query(
    "INSERT INTO document_versioning_settings (doc_id, enabled, auto_version_on, retention_count) \
     VALUES ($1, true, $2, 10)",
  )
  .bind(doc_id)
  .bind(vec!["on-pdf-export".to_string()])
  .execute(pool)
  .await
  .expect("insert document versioning settings");
}

async fn insert_named_version(pool: &PgPool, workspace_id: Uuid, doc_id: Uuid, actor_id: Uuid, label: &str) -> Uuid {
  let history_id: i64 =
    sqlx::query_scalar("INSERT INTO doc_histories (doc_id, workspace_id, snapshot) VALUES ($1, $2, $3) RETURNING id")
      .bind(doc_id)
      .bind(workspace_id)
      .bind(vec![9_u8, 8, 7])
      .fetch_one(pool)
      .await
      .expect("insert doc history");
  let version_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO document_version \
      (id, doc_id, workspace_id, doc_history_id, label, description, created_by, is_pinned) \
     VALUES ($1, $2, $3, $4, $5, NULL, $6, false)",
  )
  .bind(version_id)
  .bind(doc_id)
  .bind(workspace_id)
  .bind(history_id)
  .bind(label)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("insert document version");
  version_id
}

async fn attribute_value_id(pool: &PgPool, field_key: &str, key: &str) -> Uuid {
  let query = match field_key {
    "classification" => "SELECT id FROM document_classification_definition WHERE key = $1",
    "retentionPolicy" => "SELECT id FROM document_retention_policy_definition WHERE key = $1",
    "audience" => "SELECT id FROM document_audience_definition WHERE key = $1",
    _ => panic!("unsupported typed document metadata value list: {field_key}"),
  };
  sqlx::query_scalar(query)
    .bind(key)
    .fetch_one(pool)
    .await
    .expect("attribute value id")
}

async fn set_classification_export_mode(pool: &PgPool, mode: &str) -> String {
  sqlx::query_scalar(
    "UPDATE document_metadata_field_definition SET export_mode = $1, updated_at = now() \
     WHERE key = 'classification' RETURNING export_mode",
  )
  .bind(mode)
  .fetch_one(pool)
  .await
  .expect("set classification export mode")
}

async fn current_classification_export_mode(pool: &PgPool) -> String {
  sqlx::query_scalar("SELECT export_mode FROM document_metadata_field_definition WHERE key = 'classification'")
    .fetch_one(pool)
    .await
    .expect("classification export mode")
}

async fn with_required_classification_export_mode<F, Fut>(pool: &PgPool, body: F)
where
  F: FnOnce() -> Fut,
  Fut: Future<Output = ()>,
{
  let previous_mode = current_classification_export_mode(pool).await;
  set_classification_export_mode(pool, "required").await;
  let result = AssertUnwindSafe(body()).catch_unwind().await;
  set_classification_export_mode(pool, &previous_mode).await;
  if let Err(payload) = result {
    std::panic::resume_unwind(payload);
  }
}

async fn set_doc_classification(pool: &PgPool, doc_id: Uuid, classification_id: Uuid, actor_id: Uuid) {
  sqlx::query(
    "UPDATE docs \
     SET classification_id = $2, classification_source = 'document', metadata_updated_by = $3, metadata_updated_at = now() \
     WHERE id = $1",
  )
  .bind(doc_id)
  .bind(classification_id)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("set classification");
}

async fn clear_doc_classification(pool: &PgPool, doc_id: Uuid, actor_id: Uuid) {
  sqlx::query(
    "UPDATE docs \
     SET classification_id = NULL, classification_source = 'document', metadata_updated_by = $2, metadata_updated_at = now() \
     WHERE id = $1",
  )
  .bind(doc_id)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("clear classification");
}

async fn count_export_jobs(pool: &PgPool, ws: Uuid) -> i64 {
  sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pdf_export_jobs WHERE workspace_id = $1")
    .bind(ws)
    .fetch_one(pool)
    .await
    .expect("count export jobs")
}

async fn count_document_versions(pool: &PgPool, doc_id: Uuid) -> i64 {
  sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM document_version WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(pool)
    .await
    .expect("count document versions")
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

fn error_class(body: &Value) -> Option<String> {
  body
    .pointer("/errors/0/extensions/class")
    .and_then(Value::as_str)
    .map(str::to_owned)
}

async fn cleanup(pool: &PgPool, ws: Uuid, tpls: &[Uuid], users: &[Uuid]) {
  for &u in users {
    let _ = sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
      .bind(u)
      .execute(pool)
      .await;
  }
  let _ = sqlx::query("DELETE FROM pdf_export_render_audit WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM pdf_export_jobs WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM document_version WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query(
    "DELETE FROM document_versioning_settings WHERE doc_id IN (SELECT id FROM docs WHERE workspace_id = $1)",
  )
  .bind(ws)
  .execute(pool)
  .await;
  let _ = sqlx::query("DELETE FROM doc_histories WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  for &t in tpls {
    let _ = sqlx::query("DELETE FROM pdf_template_files WHERE template_id = $1")
      .bind(t)
      .execute(pool)
      .await;
    let _ = sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
      .bind(t)
      .execute(pool)
      .await;
  }
  let _ = sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  for &u in users {
    let _ = sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
      .bind(u)
      .execute(pool)
      .await;
    let _ = sqlx::query("DELETE FROM users WHERE id = $1")
      .bind(u)
      .execute(pool)
      .await;
  }
}

// ---------------------------------------------------------------------------
// INV-PDF-EXP-V2-01 — capability-disabled input is rejected
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_pdf_exp_v2_01_capability_disabled_input_is_rejected() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-v2-01").await;
  let ws = helpers::create_workspace(&pool, alice_id).await;

  let slug = format!("v2-01-{}", Uuid::new_v4().simple());
  let manifest = manifest_with_disabled_classification(&slug);
  let tpl = insert_template_with_manifest(&pool, &slug, manifest, admin_id).await;
  assign_template(&pool, ws, tpl, admin_id).await;
  let doc_id = insert_doc(&pool, ws, alice_id).await;

  // Pre-condition: a clean export-jobs table for this workspace.
  assert_eq!(count_export_jobs(&pool, ws).await, 0);

  // exportPdf with confidentialityLabel set against a manifest where the
  // capability is OFF — the validator must reject before any DB write.
  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation E($i: PdfExportInputV2Input!) { exportPdf(input: $i) { id status } }",
      "variables": {
        "i": {
          "workspaceId": ws.to_string(),
          "docId": doc_id.to_string(),
          "templateId": tpl.to_string(),
          "confidentialityLabel": "Internal-Only",
        }
      }
    }),
  )
  .await;

  // The error class must surface so the client can branch on it.
  assert_eq!(
    error_class(&body).as_deref(),
    Some("CapabilityViolation"),
    "INV-PDF-EXP-V2-01: refusal must carry extensions.class = CapabilityViolation: {body}"
  );
  // Negative: no job row, no audit row.
  assert_eq!(
    count_export_jobs(&pool, ws).await,
    0,
    "INV-PDF-EXP-V2-01: rejected mutation must not create a pdf_export_jobs row"
  );
  assert_eq!(
    count_export_audit(&pool, alice_id).await,
    0,
    "INV-PDF-EXP-V2-01: rejected mutation must not emit a pdf_export.start audit row"
  );

  cleanup(&pool, ws, &[tpl], &[alice_id, admin_id]).await;
}

// ---------------------------------------------------------------------------
// INV-PDF-EXP-V2-02 — clean input dispatches a job through the V2 path.
// ---------------------------------------------------------------------------
//
// The assigned template remains selectable by slug, while dispatch persists
// its canonical UUID and enforces the same assignment as UUID selections.

#[tokio::test]
async fn inv_pdf_exp_v2_02_clean_input_dispatches_job() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-v2-02").await;
  let ws = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = insert_doc(&pool, ws, alice_id).await;

  // Insert a permissive manifest + assignment so the workspace member
  // can dispatch through the V2 mutation.
  let slug = format!("v2-02-{}", Uuid::new_v4().simple());
  let tpl = insert_template_with_manifest(&pool, &slug, manifest_permissive(&slug), admin_id).await;
  assign_template(&pool, ws, tpl, admin_id).await;

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation E($i: PdfExportInputV2Input!) { exportPdf(input: $i) { id status } }",
      "variables": {
        "i": {
          "workspaceId": ws.to_string(),
          "docId": doc_id.to_string(),
          "templateId": slug,
          "locale": "en",
          "paperSize": "A4",
          "tocBehavior": "off",
        }
      }
    }),
  )
  .await;

  // The mutation must succeed (no errors array).
  assert!(
    body.get("errors").is_none(),
    "INV-PDF-EXP-V2-02: clean V2 input must succeed: {body}"
  );
  let job_id = body
    .pointer("/data/exportPdf/id")
    .and_then(Value::as_str)
    .map(str::to_owned);
  assert!(
    job_id.is_some(),
    "INV-PDF-EXP-V2-02: response must carry a job id: {body}"
  );
  // The async path returns `queued`. The test app pinned
  // sync_threshold_blocks=0 to keep us on this branch.
  let status = body.pointer("/data/exportPdf/status").and_then(Value::as_str);
  assert_eq!(
    status,
    Some("queued"),
    "INV-PDF-EXP-V2-02: job must be queued (sync threshold disabled): {body}"
  );

  // Job row exists.
  assert_eq!(
    count_export_jobs(&pool, ws).await,
    1,
    "INV-PDF-EXP-V2-02: exactly one pdf_export_jobs row must exist"
  );

  cleanup(&pool, ws, &[tpl], &[alice_id, admin_id]).await;
}

// ---------------------------------------------------------------------------
// INV-PDF-EXP-V2-03 — non-member is rejected before any template work
// ---------------------------------------------------------------------------
//
// SEC: a caller without workspace `Read` permission MUST be rejected
// before the V2 mutation touches the template registry or the
// capability validator. Otherwise the response shape (TemplateError vs.
// CapabilityViolation vs. delegated Forbidden) leaks information about
// which templates exist and what capabilities they declare. The test
// passes a templateId that does NOT exist; if the permission check
// were skipped, the response would surface a "template not found"
// TemplateError class — leaking the existence of the template
// namespace. With the gate in place the response carries the
// permission-failure class instead.

#[tokio::test]
async fn inv_pdf_exp_v2_03_non_member_rejected_before_registry_work() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  // Workspace owned by Alice; Eve is NOT a member.
  let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice-v2-03").await;
  let (eve_id, eve_session) = helpers::seed_user(&pool, &auth_store, "eve-v2-03").await;
  let ws = helpers::create_workspace(&pool, alice_id).await;

  // Eve probes with a deliberately-nonexistent template UUID. If the
  // permission gate were missing, the registry load would surface a
  // TemplateError; with the gate, Eve gets a permission denial and
  // never learns whether the template id resolves.
  let nonexistent_tpl = Uuid::new_v4();
  let body = helpers::gql(
    &app,
    eve_session,
    json!({
      "query": "mutation E($i: PdfExportInputV2Input!) { exportPdf(input: $i) { id status } }",
      "variables": {
        "i": {
          "workspaceId": ws.to_string(),
          "docId": Uuid::new_v4().to_string(),
          "templateId": nonexistent_tpl.to_string(),
        }
      }
    }),
  )
  .await;

  assert!(
    body.get("errors").is_some(),
    "INV-PDF-EXP-V2-03: non-member must be rejected: {body}"
  );
  // The response MUST NOT carry "TemplateError" — that class would
  // confirm the registry lookup happened, leaking the template
  // namespace's response shape to non-members.
  let class = error_class(&body);
  assert_ne!(
    class.as_deref(),
    Some("TemplateError"),
    "INV-PDF-EXP-V2-03: registry was reached before permission check — permission gap regressed: {body}"
  );
  // No job + no audit row.
  assert_eq!(
    count_export_jobs(&pool, ws).await,
    0,
    "INV-PDF-EXP-V2-03: rejected mutation must not create a pdf_export_jobs row"
  );
  assert_eq!(
    count_export_audit(&pool, eve_id).await,
    0,
    "INV-PDF-EXP-V2-03: rejected mutation must not emit a pdf_export.start audit row"
  );

  cleanup(&pool, ws, &[], &[alice_id, eve_id, admin_id]).await;
}

// ---------------------------------------------------------------------------
// INV-PDF-EXP-V2-04 — typed_inputs JSON-Schema validation (FOLLOWUP-01)
// ---------------------------------------------------------------------------
//
// The manifest's `inputs_schema` constrains the shape of `typed_inputs`.
// A `typed_inputs` payload that violates the schema (here: missing
// required `title`) must be rejected with
// `extensions.class = "CapabilityViolation"` carrying a structured
// `violationsJson` payload. Without this guard the renderer would
// receive arbitrary JSON masquerading as L3 input.

/// Build a manifest whose `inputs_schema` requires `title: string` (1..200
/// chars), additionalProperties: false. Mirrors the bundled `default`
/// template's contract.
fn manifest_with_title_schema(slug: &str) -> Value {
  json!({
    "schema_version": "2.0",
    "id": slug,
    "name": slug,
    "description": "V2 mutation typed_inputs test fixture.",
    "version": "1.0.0",
    "engine": { "name": "typst", "version": "0.15.x" },
    "provenance": {
      "license_spdx": "AGPL-3.0-or-later",
      "copyright_notice": "Copyright 2026 Myoxus test contributors",
      "source_url": "https://example.test/templates/v2-typed-inputs",
      "source_revision": "1.0.0"
    },
    "entry": "main.typ",
    "assets": ["main.typ"],
    "capabilities": {
      "colorVariant": { "kind": "enum", "values": ["mono"], "default": "mono" },
      "headerStyle":  { "kind": "enum", "values": ["minimal"], "default": "minimal" },
      "footerStyle":  { "kind": "enum", "values": ["page-only"], "default": "page-only" },
      "coverPage":    { "kind": "boolean", "default": false },
      "tocBehavior":  { "kind": "enum", "values": ["off"], "default": "off" },
      "pageNumbering":{ "kind": "enum", "values": ["arabic"], "default": "arabic" },
      "customMargins":{ "kind": "boolean", "default": false },
      "accentColor":  { "kind": "color", "default": "#000000" },
      "confidentialityLabels": {
        "kind": "array<string>", "min_items": 0, "max_items": 0,
        "item_pattern": "^.*$", "default": []
      },
      "language": { "kind": "enum", "values": ["en"], "default": "en" }
    },
    "inputs_schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["title"],
      "properties": {
        "title": { "type": "string", "minLength": 1, "maxLength": 200 }
      }
    }
  })
}

#[tokio::test]
async fn inv_pdf_exp_v2_04_typed_inputs_missing_required_field_rejected() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-v2-04").await;
  let ws = helpers::create_workspace(&pool, alice_id).await;

  let slug = format!("v2-04-{}", Uuid::new_v4().simple());
  let tpl = insert_template_with_manifest(&pool, &slug, manifest_with_title_schema(&slug), admin_id).await;
  assign_template(&pool, ws, tpl, admin_id).await;
  let doc_id = insert_doc(&pool, ws, alice_id).await;

  // typed_inputs missing the required `title` field — schema violation.
  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation E($i: PdfExportInputV2Input!) { exportPdf(input: $i) { id status } }",
      "variables": {
        "i": {
          "workspaceId": ws.to_string(),
          "docId": doc_id.to_string(),
          "templateId": tpl.to_string(),
          "typedInputs": {} // empty object → missing required `title`
        }
      }
    }),
  )
  .await;

  assert_eq!(
    error_class(&body).as_deref(),
    Some("CapabilityViolation"),
    "INV-PDF-EXP-V2-04: missing typed_inputs field must be rejected with CapabilityViolation: {body}"
  );
  // The structured payload should mention the typed_inputs failure.
  let violations_json = body
    .pointer("/errors/0/extensions/violationsJson")
    .and_then(Value::as_str)
    .unwrap_or("");
  assert!(
    violations_json.contains("TypedInputsSchemaFailed") || violations_json.contains("MissingRequired"),
    "INV-PDF-EXP-V2-04: violationsJson must mention the schema failure, got: {violations_json}"
  );
  assert_eq!(count_export_jobs(&pool, ws).await, 0);

  cleanup(&pool, ws, &[tpl], &[alice_id, admin_id]).await;
}

// ---------------------------------------------------------------------------
// INV-PDF-EXP-V2-06 — V2 fields are persisted in audit.l3_inputs (FOLLOWUP-02)
// ---------------------------------------------------------------------------
//
// The audit row for a successful V2 dispatch must carry every L3 field the
// caller submitted, not a renderer-internal subset. Without this
// guard the compliance trail under-records the actual render input and
// the forensic timeline cannot answer "what did this user request?".

#[tokio::test]
async fn inv_pdf_exp_v2_06_audit_l3_inputs_capture_v2_extras() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-v2-06").await;
  let ws = helpers::create_workspace(&pool, alice_id).await;

  let slug = format!("v2-06-{}", Uuid::new_v4().simple());
  let tpl = insert_template_with_manifest(&pool, &slug, manifest_permissive(&slug), admin_id).await;
  assign_template(&pool, ws, tpl, admin_id).await;
  let doc_id = insert_doc(&pool, ws, alice_id).await;

  // Submit every V2-only field so we can verify each landed in audit.l3_inputs.
  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation E($i: PdfExportInputV2Input!) { exportPdf(input: $i) { id status } }",
      "variables": {
        "i": {
          "workspaceId": ws.to_string(),
          "docId": doc_id.to_string(),
          "templateId": tpl.to_string(),
          "locale": "en",
          "paperSize": "A4",
          "imageQuality": "high",
          "coverPage": true,
          "tocBehavior": "auto",
          "footerStyle": "brand-and-page",
          "pageNumbering": "roman",
          "colorVariant": "mono",
          "confidentialityLabel": "Internal"
        }
      }
    }),
  )
  .await;
  assert!(body.get("errors").is_none(), "exportPdf must succeed: {body}");
  let job_id = body
    .pointer("/data/exportPdf/id")
    .and_then(Value::as_str)
    .expect("job id");

  let row = sqlx::query("SELECT l3_inputs, classification FROM pdf_export_render_audit WHERE job_id = $1")
    .bind(Uuid::parse_str(job_id).expect("uuid"))
    .fetch_optional(&pool)
    .await
    .expect("audit query");
  let row = row.expect("INV-PDF-EXP-V2-06: audit row must exist for the dispatched job");
  let l3: Value = sqlx::Row::try_get(&row, "l3_inputs").expect("l3_inputs col");
  let classification: Option<String> = sqlx::Row::try_get(&row, "classification").expect("classification col");

  // Every V2-only field must appear in l3_inputs.
  for (key, expected) in [
    ("paper_size", "A4"),
    ("image_quality", "high"),
    ("toc_behavior", "auto"),
    ("footer_style", "brand-and-page"),
    ("page_numbering", "roman"),
    ("color_variant", "mono"),
    ("confidentiality_label", "Internal"),
  ] {
    assert_eq!(
      l3.get(key).and_then(Value::as_str),
      Some(expected),
      "INV-PDF-EXP-V2-06: l3_inputs must carry {key} = {expected:?}; got {l3}"
    );
  }
  assert_eq!(
    l3.get("cover_page").and_then(Value::as_bool),
    Some(true),
    "INV-PDF-EXP-V2-06: cover_page must be in l3_inputs"
  );
  for forbidden_key in ["template_id", "page_format", "include_toc", "language"] {
    assert!(
      l3.get(forbidden_key).is_none(),
      "INV-PDF-EXP-V2-06: l3_inputs must stay in the V2 namespace; unexpected {forbidden_key} in {l3}"
    );
  }
  // classification column mirrors confidentiality_label.
  assert_eq!(
    classification.as_deref(),
    Some("Internal"),
    "INV-PDF-EXP-V2-06: classification column must mirror the confidentiality_label"
  );

  cleanup(&pool, ws, &[tpl], &[alice_id, admin_id]).await;
}

#[tokio::test]
async fn inv_bridge01_pdf_export_with_label_uses_history_snapshot() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-bridge-01").await;
  let ws = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = insert_doc(&pool, ws, alice_id).await;
  enable_pdf_auto_versioning(&pool, doc_id).await;

  let slug = format!("bridge-01-{}", Uuid::new_v4().simple());
  let tpl = insert_template_with_manifest(&pool, &slug, manifest_permissive(&slug), admin_id).await;
  assign_template(&pool, ws, tpl, admin_id).await;
  let version_id = insert_named_version(&pool, ws, doc_id, alice_id, "reviewed-v1").await;

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation E($i: PdfExportInputV2Input!) { exportPdf(input: $i) { id status } }",
      "variables": {
        "i": {
          "workspaceId": ws.to_string(),
          "docId": doc_id.to_string(),
          "templateId": tpl.to_string(),
          "documentVersionId": version_id.to_string()
        }
      }
    }),
  )
  .await;
  assert!(
    body.get("errors").is_none(),
    "INV-BRIDGE-01: export with named version must dispatch: {body}"
  );
  let job_id = Uuid::parse_str(
    body
      .pointer("/data/exportPdf/id")
      .and_then(Value::as_str)
      .expect("job id"),
  )
  .expect("uuid job");

  let row = sqlx::query(
    "SELECT j.render_inputs, a.doc_version_label, a.document_version_id, \
            a.document_metadata_snapshot, a.metadata_validation, a.l3_inputs \
     FROM pdf_export_jobs j \
     JOIN pdf_export_render_audit a ON a.job_id = j.id \
     WHERE j.id = $1",
  )
  .bind(job_id)
  .fetch_one(&pool)
  .await
  .expect("job/audit row");
  let render_inputs: Value = sqlx::Row::try_get(&row, "render_inputs").expect("render_inputs");
  let l3_inputs: Value = sqlx::Row::try_get(&row, "l3_inputs").expect("l3_inputs");
  let audit_label: Option<String> = sqlx::Row::try_get(&row, "doc_version_label").expect("doc_version_label");
  let audit_version_id: Option<Uuid> = sqlx::Row::try_get(&row, "document_version_id").expect("document_version_id");
  let attrs: Value = sqlx::Row::try_get(&row, "document_metadata_snapshot").expect("document_metadata_snapshot");
  let validation: Value = sqlx::Row::try_get(&row, "metadata_validation").expect("metadata_validation");

  assert_eq!(audit_label.as_deref(), Some("reviewed-v1"));
  assert_eq!(
    audit_version_id,
    Some(version_id),
    "INV-BRIDGE-01: audit must store the resolved document_version.id"
  );
  assert!(l3_inputs.get("document_version_id").is_none());
  assert!(l3_inputs.get("version_label").is_none());
  assert!(l3_inputs.get("doc_history_id").is_none());
  assert_eq!(
    attrs.pointer("/version/versionId").and_then(Value::as_str),
    Some(version_id.to_string().as_str()),
    "INV-BRIDGE-01: documentMetadata.version must describe the selected version: {attrs}"
  );
  assert_eq!(
    validation
      .pointer("/blocked_actions")
      .and_then(Value::as_array)
      .map(Vec::len),
    Some(0)
  );
  assert!(
    render_inputs.get("doc_history_id").and_then(Value::as_i64).is_some(),
    "INV-BRIDGE-01: worker payload must pin the DocHistory snapshot: {render_inputs}"
  );

  cleanup(&pool, ws, &[tpl], &[alice_id, admin_id]).await;
}

#[tokio::test]
async fn inv_bridge02_auto_trigger_creates_version_before_render() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-bridge-02").await;
  let ws = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = insert_doc(&pool, ws, alice_id).await;
  enable_pdf_auto_versioning(&pool, doc_id).await;

  let slug = format!("bridge-02-{}", Uuid::new_v4().simple());
  let tpl = insert_template_with_manifest(&pool, &slug, manifest_permissive(&slug), admin_id).await;
  assign_template(&pool, ws, tpl, admin_id).await;
  let versions_before = count_document_versions(&pool, doc_id).await;

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation E($i: PdfExportInputV2Input!) { exportPdf(input: $i) { id status } }",
      "variables": {
        "i": {
          "workspaceId": ws.to_string(),
          "docId": doc_id.to_string(),
          "templateId": tpl.to_string(),
          "documentVersionId": "latest"
        }
      }
    }),
  )
  .await;
  assert!(
    body.get("errors").is_none(),
    "INV-BRIDGE-02: latest + on_pdf_export must dispatch: {body}"
  );
  let job_id = Uuid::parse_str(
    body
      .pointer("/data/exportPdf/id")
      .and_then(Value::as_str)
      .expect("job id"),
  )
  .expect("uuid job");
  assert_eq!(
    count_document_versions(&pool, doc_id).await,
    versions_before + 1,
    "INV-BRIDGE-02: first latest export must create exactly one version"
  );

  let version_row =
    sqlx::query("SELECT id, label, doc_history_id, event, kind FROM document_version WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("auto version row");
  let version_id: Uuid = sqlx::Row::try_get(&version_row, "id").expect("id");
  let label: String = sqlx::Row::try_get(&version_row, "label").expect("label");
  let history_id: i64 = sqlx::Row::try_get(&version_row, "doc_history_id").expect("doc_history_id");
  let event: String = sqlx::Row::try_get(&version_row, "event").expect("event");
  let kind: String = sqlx::Row::try_get(&version_row, "kind").expect("kind");
  assert!(!label.trim().is_empty(), "auto label must be stable and non-empty");
  assert_eq!(event, "pdf_export");
  assert_eq!(kind, "exported");

  let row = sqlx::query(
    "SELECT j.render_inputs, a.doc_version_label, a.document_version_id, \
            a.document_metadata_snapshot, a.metadata_validation, a.l3_inputs \
     FROM pdf_export_jobs j \
     JOIN pdf_export_render_audit a ON a.job_id = j.id \
     WHERE j.id = $1",
  )
  .bind(job_id)
  .fetch_one(&pool)
  .await
  .expect("job/audit row");
  let render_inputs: Value = sqlx::Row::try_get(&row, "render_inputs").expect("render_inputs");
  let l3_inputs: Value = sqlx::Row::try_get(&row, "l3_inputs").expect("l3_inputs");
  let audit_label: Option<String> = sqlx::Row::try_get(&row, "doc_version_label").expect("doc_version_label");
  let audit_version_id: Option<Uuid> = sqlx::Row::try_get(&row, "document_version_id").expect("document_version_id");
  let attrs: Value = sqlx::Row::try_get(&row, "document_metadata_snapshot").expect("document_metadata_snapshot");
  let validation: Value = sqlx::Row::try_get(&row, "metadata_validation").expect("metadata_validation");

  assert_eq!(audit_label.as_deref(), Some(label.as_str()));
  assert_eq!(
    audit_version_id,
    Some(version_id),
    "INV-BRIDGE-02: audit must store the resolved latest version id"
  );
  assert!(l3_inputs.get("version_label").is_none());
  assert_eq!(
    render_inputs.get("doc_history_id").and_then(Value::as_i64),
    Some(history_id)
  );
  assert_eq!(
    attrs.pointer("/version/label").and_then(Value::as_str),
    Some(label.as_str())
  );
  assert_eq!(attrs.pointer("/version/kind").and_then(Value::as_str), Some("exported"));
  assert_eq!(
    attrs.pointer("/version/event").and_then(Value::as_str),
    Some("pdf_export")
  );
  assert_eq!(
    validation
      .pointer("/blocked_actions")
      .and_then(Value::as_array)
      .map(Vec::len),
    Some(0)
  );

  let second = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation E($i: PdfExportInputV2Input!) { exportPdf(input: $i) { id status } }",
      "variables": {
        "i": {
          "workspaceId": ws.to_string(),
          "docId": doc_id.to_string(),
          "templateId": tpl.to_string(),
          "documentVersionId": "latest"
        }
      }
    }),
  )
  .await;
  assert!(
    second.get("errors").is_none(),
    "INV-BRIDGE-02: idempotent retry must succeed: {second}"
  );
  assert_eq!(
    count_document_versions(&pool, doc_id).await,
    versions_before + 1,
    "INV-BRIDGE-02: idempotent latest retry must not create a second version"
  );

  cleanup(&pool, ws, &[tpl], &[alice_id, admin_id]).await;
}

#[tokio::test]
async fn inv_bridge04_required_classification_blocks_before_job_or_version() {
  let (app, pool, auth_store) = setup_app().await;
  with_required_classification_export_mode(&pool, || async {
    let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
    let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-bridge-04").await;
    let ws = helpers::create_workspace(&pool, alice_id).await;
    let doc_id = insert_doc(&pool, ws, alice_id).await;
    clear_doc_classification(&pool, doc_id, alice_id).await;
    enable_pdf_auto_versioning(&pool, doc_id).await;

    let slug = format!("bridge-04-{}", Uuid::new_v4().simple());
    let tpl = insert_template_with_manifest(&pool, &slug, manifest_permissive(&slug), admin_id).await;
    assign_template(&pool, ws, tpl, admin_id).await;

    let body = helpers::gql(
      &app,
      alice_session,
      json!({
        "query": "mutation E($i: PdfExportInputV2Input!) { exportPdf(input: $i) { id status } }",
        "variables": {
          "i": {
            "workspaceId": ws.to_string(),
            "docId": doc_id.to_string(),
            "templateId": tpl.to_string(),
            "documentVersionId": "latest"
          }
        }
      }),
    )
    .await;

    assert_eq!(
      error_class(&body).as_deref(),
      Some("ValidationError"),
      "blocked export must be structured: {body}"
    );
    assert_eq!(
      body.pointer("/errors/0/extensions/code").and_then(Value::as_str),
      Some("DOCUMENT_EXPORT_BLOCKED")
    );
    assert_eq!(
      count_export_jobs(&pool, ws).await,
      0,
      "blocked export must not create a job"
    );
    assert_eq!(
      count_document_versions(&pool, doc_id).await,
      0,
      "blocked export must not create a version"
    );

    cleanup(&pool, ws, &[tpl], &[alice_id, admin_id]).await;
  })
  .await;
}

#[tokio::test]
async fn inv_bridge05_required_classification_succeeds_after_attribute_is_set() {
  let (app, pool, auth_store) = setup_app().await;
  with_required_classification_export_mode(&pool, || async {
    let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
    let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-bridge-05").await;
    let ws = helpers::create_workspace(&pool, alice_id).await;
    let doc_id = insert_doc(&pool, ws, alice_id).await;
    enable_pdf_auto_versioning(&pool, doc_id).await;
    let classification_id = attribute_value_id(&pool, "classification", "internal").await;
    set_doc_classification(&pool, doc_id, classification_id, alice_id).await;

    let slug = format!("bridge-05-{}", Uuid::new_v4().simple());
    let tpl = insert_template_with_manifest(&pool, &slug, manifest_permissive(&slug), admin_id).await;
    assign_template(&pool, ws, tpl, admin_id).await;

    let body = helpers::gql(
      &app,
      alice_session,
      json!({
        "query": "mutation E($i: PdfExportInputV2Input!) { exportPdf(input: $i) { id status } }",
        "variables": {
          "i": {
            "workspaceId": ws.to_string(),
            "docId": doc_id.to_string(),
            "templateId": tpl.to_string(),
            "documentVersionId": "latest"
          }
        }
      }),
    )
    .await;
    assert!(
      body.get("errors").is_none(),
      "export must succeed after classification is set: {body}"
    );
    let job_id = Uuid::parse_str(
      body
        .pointer("/data/exportPdf/id")
        .and_then(Value::as_str)
        .expect("job id"),
    )
    .expect("uuid job");
    let row = sqlx::query(
      "SELECT document_metadata_snapshot, metadata_validation \
       FROM pdf_export_render_audit WHERE job_id = $1",
    )
    .bind(job_id)
    .fetch_one(&pool)
    .await
    .expect("audit row");
    let attrs: Value = sqlx::Row::try_get(&row, "document_metadata_snapshot").expect("document_metadata_snapshot");
    let validation: Value = sqlx::Row::try_get(&row, "metadata_validation").expect("metadata_validation");
    assert_eq!(
      attrs.pointer("/classification/key").and_then(Value::as_str),
      Some("internal")
    );
    assert_eq!(
      attrs.pointer("/version/event").and_then(Value::as_str),
      Some("pdf_export")
    );
    assert_eq!(
      validation
        .pointer("/blocked_actions")
        .and_then(Value::as_array)
        .map(Vec::len),
      Some(0),
      "successful export audit must carry the validation result: {validation}"
    );

    cleanup(&pool, ws, &[tpl], &[alice_id, admin_id]).await;
  })
  .await;
}

#[tokio::test]
async fn inv_bridge03_latest_selector_rejects_foreign_workspace_doc() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-bridge-03").await;
  let ws = helpers::create_workspace(&pool, alice_id).await;
  let foreign_ws = helpers::create_workspace(&pool, alice_id).await;
  let foreign_doc_id = insert_doc(&pool, foreign_ws, alice_id).await;
  enable_pdf_auto_versioning(&pool, foreign_doc_id).await;

  let slug = format!("bridge-03-{}", Uuid::new_v4().simple());
  let tpl = insert_template_with_manifest(&pool, &slug, manifest_permissive(&slug), admin_id).await;
  assign_template(&pool, ws, tpl, admin_id).await;

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation E($i: PdfExportInputV2Input!) { exportPdf(input: $i) { id status } }",
      "variables": {
        "i": {
          "workspaceId": ws.to_string(),
          "docId": foreign_doc_id.to_string(),
          "templateId": tpl.to_string(),
          "documentVersionId": "latest"
        }
      }
    }),
  )
  .await;

  assert_eq!(
    body.pointer("/errors/0/extensions/name").and_then(Value::as_str),
    Some("NOT_FOUND"),
    "INV-BRIDGE-03: a foreign-workspace document must be hidden as not found: {body}"
  );
  assert_eq!(count_export_jobs(&pool, ws).await, 0);
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM document_version WHERE doc_id = $1")
      .bind(foreign_doc_id)
      .fetch_one(&pool)
      .await
      .expect("count versions"),
    0,
    "INV-BRIDGE-03: rejected selector must not create an auto version"
  );

  cleanup(&pool, foreign_ws, &[], &[]).await;
  cleanup(&pool, ws, &[tpl], &[alice_id, admin_id]).await;
}

#[tokio::test]
async fn inv_pdf_exp_v2_05_typed_inputs_satisfying_schema_dispatches() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-v2-05").await;
  let ws = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = insert_doc(&pool, ws, alice_id).await;

  let slug = format!("v2-05-{}", Uuid::new_v4().simple());
  let tpl = insert_template_with_manifest(&pool, &slug, manifest_with_title_schema(&slug), admin_id).await;
  assign_template(&pool, ws, tpl, admin_id).await;

  // typed_inputs that satisfies the schema → mutation must succeed.
  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "mutation E($i: PdfExportInputV2Input!) { exportPdf(input: $i) { id status } }",
      "variables": {
        "i": {
          "workspaceId": ws.to_string(),
          "docId": doc_id.to_string(),
          "templateId": tpl.to_string(),
          "typedInputs": { "title": "Valid Title" }
        }
      }
    }),
  )
  .await;
  assert!(
    body.get("errors").is_none(),
    "INV-PDF-EXP-V2-05: schema-conforming typed_inputs must pass validation: {body}"
  );
  assert_eq!(count_export_jobs(&pool, ws).await, 1);

  cleanup(&pool, ws, &[tpl], &[alice_id, admin_id]).await;
}
