// SPDX-License-Identifier: AGPL-3.0-or-later
//! `P-PDF-TPL-07-{08..11}` integration tests for the admin-side PDF template
//! GraphQL surface.
//!
//! Invariants checked here (one test per Mikropaket):
//!
//! - `INV-PDF-GQL-TPL-01` (`P-PDF-TPL-07-08`):
//!   `uploadPdfTemplate` persists the [`PdfTemplate`] row, every declared
//!   bundle file row, the actual blobs in the PDF blob store, AND emits a
//!   `pdf_template.upload` audit log entry — all in a single mutation.
//! - `INV-PDF-GQL-TPL-02` (`P-PDF-TPL-07-09`):
//!   Non-admin sessions cannot reach any field of the admin surface (queries
//!   AND mutations). The error must be a GraphQL-level "Forbidden" — never
//!   a partial success.
//! - `INV-PDF-GQL-TPL-03` (`P-PDF-TPL-07-10`):
//!   When the manifest fails the V2 schema check (`PdfTemplateManifest`
//!   deserialise), the upload is refused **before** any blob is written.
//!   `pdf_templates`, `pdf_template_files`, AND the blob store must remain
//!   unchanged so the upload is fully atomic.
//! - `INV-PDF-GQL-TPL-04` (`P-PDF-TPL-07-11`):
//!   When the bundle declares a valid manifest but its Typst sources fail to
//!   compile, the upload is refused **after** content read but **before**
//!   any blob is written. Same atomicity guarantee as `INV-PDF-GQL-TPL-03`.
//! - `INV-PDF-GQL-TPL-08`:
//!   An administrator can atomically replace an uploaded bundle with a newer
//!   manifest version while the template UUID, workspace assignments and
//!   default selection remain stable.
//!
//! Setup mirrors `pdf_brand_admin_test.rs` — the production
//! [`PgPdfTemplateRepository`] + [`PdfBlobStore`] + the real [`PgAuditLogStore`]
//! are all wired in so the mutations roundtrip through actual SQLx + opendal
//! code paths.

#![allow(clippy::too_many_lines)]

use crate::helpers;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use myoxus_application::audit::AuditRecorder;
use myoxus_infrastructure::audit::PgAuditLogStore;
use myoxus_infrastructure::pdf_export::{
  PdfBlobStore, PgPdfTemplateRepository, PgPdfWorkspaceBrandAssetRepository, PgPdfWorkspaceTemplateAssignmentRepository,
};
use myoxus_infrastructure::storage::StorageAdapter;

// ---------------------------------------------------------------------------
// Fixture: a minimal but schema-valid V2 manifest the admin tests can mutate.
// ---------------------------------------------------------------------------

/// Build a minimal valid V2 manifest with the given slug. Every field that the
/// schema marks as required is populated with the smallest accepted value.
fn minimal_manifest(slug: &str, name: &str) -> Value {
  json!({
    "schema_version": "2.0",
    "id": slug,
    "name": name,
    "description": "Used by pdf_template_admin_test.",
    "version": "1.0.0",
    "engine": { "name": "typst", "version": "0.15.x" },
    "provenance": {
      "license_spdx": "AGPL-3.0-or-later",
      "copyright_notice": "Copyright 2026 Myoxus test contributors",
      "source_url": "https://example.test/templates",
      "source_revision": "1.0.0"
    },
    "entry": "main.typ",
    "assets": ["main.typ", "preamble.typ", "theme.typ"],
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
        "kind": "array<string>", "min_items": 0, "max_items": 0,
        "item_pattern": "^.*$", "default": []
      },
      "language":     { "kind": "enum", "values": ["en"], "default": "en" }
    },
    "inputs_schema": { "type": "object", "additionalProperties": false, "properties": {} }
  })
}

/// Bundled `theme.typ` source — taken verbatim from the V2 default template
/// so the Typst compile validator is guaranteed to accept it. Uses `r##"..."##`
/// because the inner Typst literals contain `"#…"` substrings that would
/// otherwise close a `r#"..."#` raw string early.
const VALID_THEME_TYP: &str = r##"// theme.typ for tests
#let header-text-fill = luma(150)
#let table-header-fill = luma(220)
#let table-caption-fill = luma(120)
#let blockquote-stroke = luma(180)
#let embed-card-stroke = luma(220)
#let attachment-stroke = luma(200)
#let unknown-block-fill = luma(150)
#let aichat-fill = luma(248)
#let snapshot-placeholder-fill = luma(240)
#let callout-info-fill = "#e8f4fd"
#let callout-info-stroke = "#1971c2"
#let callout-warn-fill = "#fff9db"
#let callout-warn-stroke = "#e67700"
#let callout-note-fill = "#f3f0ff"
#let callout-note-stroke = "#7048e8"
#let callout-tip-fill = "#ebfbee"
#let callout-tip-stroke = "#2f9e44"
"##;

/// Minimal stub preamble using the registry compiler's injected bindings.
const VALID_PREAMBLE_TYP: &str = r#"// preamble.typ for tests
#set document(title: doc-title, author: doc-author, keywords: doc-keywords, date: doc-date)
#set page(paper: paper, numbering: "1")
#set text(font: body-font, size: 11pt, fill: rgb(text-color), lang: lang)
"#;

const VALID_MAIN_TYP: &str = r#"// main.typ for tests
#include "theme.typ"
#include "preamble.typ"
"#;

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async fn setup_app() -> (
  axum::Router,
  PgPool,
  Arc<myoxus_infrastructure::auth::SqlxAuthStore>,
  Arc<PdfBlobStore>,
  tempfile::TempDir,
) {
  setup_app_with_timeout(None).await
}

async fn setup_app_with_timeout(
  timeout_seconds: Option<u64>,
) -> (
  axum::Router,
  PgPool,
  Arc<myoxus_infrastructure::auth::SqlxAuthStore>,
  Arc<PdfBlobStore>,
  tempfile::TempDir,
) {
  setup_app_with_budget(timeout_seconds, None).await
}

async fn setup_app_with_budget(
  timeout_seconds: Option<u64>,
  max_memory_mb: Option<u32>,
) -> (
  axum::Router,
  PgPool,
  Arc<myoxus_infrastructure::auth::SqlxAuthStore>,
  Arc<PdfBlobStore>,
  tempfile::TempDir,
) {
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
  if let Some(seconds) = timeout_seconds {
    config.pdf_export.limits.render_timeout_seconds = seconds;
  }
  if let Some(mb) = max_memory_mb {
    config.pdf_export.limits.max_memory_mb = mb;
  }

  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage_dir = tempfile::tempdir().expect("isolated template bundle storage");
  let storage_adapter = Arc::new(
    StorageAdapter::new_fs(storage_dir.path().to_str().expect("UTF-8 temporary storage path")).expect("storage"),
  );
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
  .with_pdf_blob_store(pdf_blob_store.clone())
  .with_audit_recorder(audit_recorder);

  (build_router(state), pool, auth_store, pdf_blob_store, storage_dir)
}

// ---------------------------------------------------------------------------
// Multipart helper for `uploadPdfTemplate`
// ---------------------------------------------------------------------------

/// Build and POST a multipart upload or replacement request. Each entry in
/// `files` is `(in_bundle_path, raw_bytes)` and is mapped to
/// `variables.files.<i>` per the GraphQL multipart-spec.
async fn template_bundle_mutation(
  app: &axum::Router,
  session_id: Uuid,
  template_id: Option<Uuid>,
  manifest: &Value,
  files: &[(&str, &[u8])],
) -> Value {
  let (boundary, query) = if template_id.is_some() {
    (
      "X-BOUNDARY-PDF-TEMPLATE-REPLACE",
      "mutation Replace($id: ID!, $manifest: JSON!, $filePaths: [String!]!, $files: [Upload!]!, \
       $rightsConfirmed: Boolean!) { \
        admin { replacePdfTemplateBundle(id: $id, manifest: $manifest, filePaths: $filePaths, files: $files, \
                          rightsConfirmed: $rightsConfirmed) { \
          id slug name version schemaVersion createdBy \
        } } \
      }",
    )
  } else {
    (
      "X-BOUNDARY-PDF-TEMPLATE-UPLOAD",
      "mutation Up($manifest: JSON!, $filePaths: [String!]!, $files: [Upload!]!, \
       $rightsConfirmed: Boolean!) { \
        admin { uploadPdfTemplate(manifest: $manifest, filePaths: $filePaths, files: $files, \
                          rightsConfirmed: $rightsConfirmed) { \
          id slug name version schemaVersion createdBy \
        } } \
      }",
    )
  };

  // Build the operations payload. We pass a `[null, null, ...]` placeholder
  // for `files` so the multipart spec can plug in the real uploads via `map`.
  let placeholder_files: Vec<Value> = files.iter().map(|_| Value::Null).collect();
  let file_paths: Vec<Value> = files.iter().map(|(p, _)| Value::String((*p).to_owned())).collect();

  let operations = json!({
    "query": query,
    "variables": {
      "id": template_id.map(|id| id.to_string()),
      "manifest": manifest,
      "filePaths": file_paths,
      "files": placeholder_files,
      "rightsConfirmed": true
    }
  })
  .to_string();

  // Per spec: each multipart file has a unique form-name (we use the index
  // 0..N-1) and the `map` JSON declares which `variables` slot it fills.
  let map: Value = files
    .iter()
    .enumerate()
    .map(|(i, _)| {
      (
        i.to_string(),
        Value::Array(vec![Value::String(format!("variables.files.{i}"))]),
      )
    })
    .collect::<serde_json::Map<_, _>>()
    .into();
  let map_str = map.to_string();

  let mut body = Vec::new();
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"operations\"\r\n\r\n");
  body.extend_from_slice(operations.as_bytes());
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"map\"\r\n\r\n");
  body.extend_from_slice(map_str.as_bytes());
  body.extend_from_slice(b"\r\n");
  for (i, (path, bytes)) in files.iter().enumerate() {
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(format!("Content-Disposition: form-data; name=\"{i}\"; filename=\"{path}\"\r\n").as_bytes());
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n");
  }
  body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(body))
        .expect("multipart request"),
    )
    .await
    .expect("response");

  let bytes = resp.into_body().collect().await.expect("body").to_bytes();
  serde_json::from_slice(&bytes).expect("multipart GraphQL JSON")
}

async fn upload_template(app: &axum::Router, session_id: Uuid, manifest: &Value, files: &[(&str, &[u8])]) -> Value {
  template_bundle_mutation(app, session_id, None, manifest, files).await
}

async fn replace_template(
  app: &axum::Router,
  session_id: Uuid,
  template_id: Uuid,
  manifest: &Value,
  files: &[(&str, &[u8])],
) -> Value {
  template_bundle_mutation(app, session_id, Some(template_id), manifest, files).await
}

async fn preview_template(app: &axum::Router, session_id: Uuid, template_id: &str, locale: Option<&str>) -> Value {
  preview_template_with_workspace(app, session_id, template_id, locale, None).await
}

async fn preview_template_with_workspace(
  app: &axum::Router,
  session_id: Uuid,
  template_id: &str,
  locale: Option<&str>,
  workspace_id: Option<Uuid>,
) -> Value {
  helpers::gql(
    app,
    session_id,
    json!({
      "query": "query Preview($templateId: String!, $locale: String, $workspaceId: String) { \
        pdfTemplatePreviewPdf(templateId: $templateId, locale: $locale, workspaceId: $workspaceId) \
      }",
      "variables": {
        "templateId": template_id,
        "locale": locale,
        "workspaceId": workspace_id.map(|id| id.to_string())
      }
    }),
  )
  .await
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

fn error_classes(body: &Value) -> Vec<String> {
  body
    .get("errors")
    .and_then(|v| v.as_array())
    .map(|arr| {
      arr
        .iter()
        .filter_map(|e| {
          e.pointer("/extensions/class")
            .and_then(Value::as_str)
            .map(str::to_owned)
        })
        .collect()
    })
    .unwrap_or_default()
}

async fn count_templates_with_slug(pool: &PgPool, slug: &str) -> i64 {
  sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pdf_templates WHERE slug = $1")
    .bind(slug)
    .fetch_one(pool)
    .await
    .expect("count templates")
}

async fn count_template_files(pool: &PgPool, slug: &str) -> i64 {
  sqlx::query_scalar::<_, i64>(
    r#"SELECT COUNT(*) FROM pdf_template_files f
       JOIN pdf_templates t ON t.id = f.template_id
       WHERE t.slug = $1"#,
  )
  .bind(slug)
  .fetch_one(pool)
  .await
  .expect("count template_files")
}

async fn count_audit_log(pool: &PgPool, event_key: &str, actor: Uuid) -> i64 {
  sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM admin_audit_log WHERE event_key = $1 AND actor_user_id = $2")
    .bind(event_key)
    .bind(actor)
    .fetch_one(pool)
    .await
    .expect("count audit log")
}

/// Asserts the blob store has *no* file under the given template slug. The
/// bootstrap test paths use `pdf-templates/<template_id>/<file_path>` keys,
/// so for failed uploads (which never made it past validation) no blob
/// should exist for any template_id with that slug.
async fn count_blobs_for_slug(pool: &PgPool, slug: &str) -> i64 {
  sqlx::query_scalar::<_, i64>(
    r#"SELECT COUNT(*) FROM pdf_template_files f
       JOIN pdf_templates t ON t.id = f.template_id
       WHERE t.slug = $1"#,
  )
  .bind(slug)
  .fetch_one(pool)
  .await
  .expect("count blobs")
}

async fn cleanup_template_by_slug(pool: &PgPool, slug: &str) {
  // ON DELETE CASCADE on pdf_template_files takes care of bundle rows.
  sqlx::query("DELETE FROM pdf_templates WHERE slug = $1")
    .bind(slug)
    .execute(pool)
    .await
    .expect("clean owned PDF template fixture");
}

async fn cleanup_template_by_id(pool: &PgPool, template_id: Uuid) {
  sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
    .bind(template_id)
    .execute(pool)
    .await
    .expect("clean owned PDF template fixture");
}

async fn cleanup_workspace(pool: &PgPool, workspace_id: Uuid) {
  sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean owned PDF template fixture");
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean owned PDF template fixture");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean owned PDF template fixture");
}

async fn cleanup_user(pool: &PgPool, user_id: Uuid) {
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("clean owned PDF template fixture");
  sqlx::query("DELETE FROM sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("clean owned PDF template fixture");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("clean owned PDF template fixture");
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-TPL-01 — full upload roundtrip
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_gql01_template_upload_persists_files_and_audit_log() {
  let (app, pool, auth_store, blob_store, _storage_dir) = setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let slug = format!("tpl-gql01-{}", Uuid::new_v4().simple());
  cleanup_template_by_slug(&pool, &slug).await; // pre-clean

  let manifest = minimal_manifest(&slug, "GQL01 Template");
  let body = upload_template(
    &app,
    admin_session,
    &manifest,
    &[
      ("main.typ", VALID_MAIN_TYP.as_bytes()),
      ("preamble.typ", VALID_PREAMBLE_TYP.as_bytes()),
      ("theme.typ", VALID_THEME_TYP.as_bytes()),
    ],
  )
  .await;
  assert!(
    body.get("errors").is_none(),
    "INV-PDF-GQL-TPL-01: upload must succeed: {body}"
  );

  // Row was persisted.
  assert_eq!(
    count_templates_with_slug(&pool, &slug).await,
    1,
    "INV-PDF-GQL-TPL-01: exactly one pdf_templates row must exist for the slug"
  );
  // Bundle files were persisted (3 files in this minimal bundle).
  assert_eq!(
    count_template_files(&pool, &slug).await,
    3,
    "INV-PDF-GQL-TPL-01: every declared bundle file must be persisted"
  );
  // Audit log fired.
  assert_eq!(
    count_audit_log(&pool, "pdf_template.upload", admin_id).await,
    1,
    "INV-PDF-GQL-TPL-01: upload must emit a single pdf_template.upload audit row"
  );

  // Each blob is reachable from the blob store using the stored key.
  let template_id_str = body
    .pointer("/data/admin/uploadPdfTemplate/id")
    .and_then(Value::as_str)
    .expect("uploadPdfTemplate must return id");
  let template_id = Uuid::parse_str(template_id_str).expect("parse template id");
  let main_key = format!("pdf-templates/{template_id}/main.typ");
  let main_bytes = blob_store.get_template_file(&main_key).await.expect("main.typ blob");
  assert_eq!(
    main_bytes,
    VALID_MAIN_TYP.as_bytes(),
    "INV-PDF-GQL-TPL-01: blob bytes must match upload"
  );

  cleanup_template_by_slug(&pool, &slug).await;
  cleanup_user(&pool, admin_id).await;
}

#[test]
fn inv_gql08_template_replacement_preserves_identity_assignments_and_default() {
  helpers::block_on_large_stack("inv-gql08-template-replacement", || async {
    let (app, pool, auth_store, blob_store, _storage_dir) = setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let workspace_id = helpers::create_workspace(&pool, admin_id).await;
    let slug = format!("tpl-gql08-{}", Uuid::new_v4().simple());
    cleanup_template_by_slug(&pool, &slug).await;

    let manifest = minimal_manifest(&slug, "GQL08 Template");
    let upload = upload_template(
      &app,
      admin_session,
      &manifest,
      &[
        ("main.typ", VALID_MAIN_TYP.as_bytes()),
        ("preamble.typ", VALID_PREAMBLE_TYP.as_bytes()),
        ("theme.typ", VALID_THEME_TYP.as_bytes()),
      ],
    )
    .await;
    assert!(
      upload.get("errors").is_none(),
      "INV-PDF-GQL-TPL-08: initial upload must succeed: {upload}"
    );
    let template_id = Uuid::parse_str(
      upload
        .pointer("/data/admin/uploadPdfTemplate/id")
        .and_then(Value::as_str)
        .expect("uploaded template id"),
    )
    .expect("uploaded template UUID");
    let original_blob_key = format!("pdf-templates/{template_id}/main.typ");

    let assign = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($ws: ID!, $tpl: ID!) { admin { assignPdfTemplateToWorkspace(workspaceId: $ws, templateId: $tpl) { templateId } } }",
        "variables": { "ws": workspace_id.to_string(), "tpl": template_id.to_string() }
      }),
    )
    .await;
    assert!(
      assign.get("errors").is_none(),
      "assign uploaded template to workspace: {assign}"
    );
    let set_default = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($ws: ID!, $tpl: ID!) { admin { setWorkspaceDefaultPdfTemplate(workspaceId: $ws, templateId: $tpl) { defaultTemplateId } } }",
        "variables": { "ws": workspace_id.to_string(), "tpl": template_id.to_string() }
      }),
    )
    .await;
    assert!(
      set_default.get("errors").is_none(),
      "assign uploaded template as workspace default: {set_default}"
    );

    let mut replacement_manifest = minimal_manifest(&slug, "GQL08 Template Revised");
    replacement_manifest["version"] = json!("1.1.0");
    replacement_manifest["provenance"]["source_revision"] = json!("1.1.0");
    let revised_main = format!("{VALID_MAIN_TYP}\n// replacement revision\n");
    let replacement = replace_template(
      &app,
      admin_session,
      template_id,
      &replacement_manifest,
      &[
        ("main.typ", revised_main.as_bytes()),
        ("preamble.typ", VALID_PREAMBLE_TYP.as_bytes()),
        ("theme.typ", VALID_THEME_TYP.as_bytes()),
      ],
    )
    .await;
    assert!(
      replacement.get("errors").is_none(),
      "INV-PDF-GQL-TPL-08: newer replacement must succeed: {replacement}"
    );
    let template_id_string = template_id.to_string();
    assert_eq!(
      replacement
        .pointer("/data/admin/replacePdfTemplateBundle/id")
        .and_then(Value::as_str),
      Some(template_id_string.as_str()),
      "INV-PDF-GQL-TPL-08: replacement must preserve the template UUID"
    );
    assert_eq!(
      replacement
        .pointer("/data/admin/replacePdfTemplateBundle/version")
        .and_then(Value::as_str),
      Some("1.1.0")
    );

    let assignment = sqlx::query_as::<_, (Uuid, bool)>(
      "SELECT template_id, is_default \
       FROM pdf_workspace_template_assignments \
      WHERE workspace_id = $1 AND is_default = true",
    )
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("workspace assignment after replacement");
    assert_eq!(assignment, (template_id, true));
    assert_eq!(count_templates_with_slug(&pool, &slug).await, 1);
    assert_eq!(
      count_audit_log(&pool, "pdf_template.replace_bundle", admin_id).await,
      1,
      "INV-PDF-GQL-TPL-08: replacement must emit one audit event"
    );

    let new_blob_key: String = sqlx::query_scalar(
      "SELECT f.blob_key \
       FROM pdf_template_files f \
      WHERE f.template_id = $1 AND f.file_path = 'main.typ'",
    )
    .bind(template_id)
    .fetch_one(&pool)
    .await
    .expect("replacement main.typ blob key");
    assert_ne!(
      new_blob_key, original_blob_key,
      "INV-PDF-GQL-TPL-08: replacement blobs must use revisioned keys"
    );
    assert_eq!(
      blob_store
        .get_template_file(&new_blob_key)
        .await
        .expect("replacement main.typ blob"),
      revised_main.as_bytes()
    );
    assert_eq!(
      blob_store
        .get_template_file(&original_blob_key)
        .await
        .expect("captured prior revision"),
      VALID_MAIN_TYP.as_bytes(),
      "INV-PDF-GQL-TPL-08: replacement must preserve bytes captured by admitted exports"
    );

    cleanup_workspace(&pool, workspace_id).await;
    cleanup_template_by_slug(&pool, &slug).await;
    cleanup_user(&pool, admin_id).await;
  });
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-TPL-02 — non-admin rejected
// ---------------------------------------------------------------------------

#[test]
fn inv_gql02_non_admin_rejected_with_unauthorized() {
  helpers::block_on_large_stack("inv-gql02-non-admin-rejected", || async {
    let (app, pool, auth_store, _blob_store, _storage_dir) = setup_app().await;
    let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-gql02").await;
    let slug = format!("tpl-gql02-{}", Uuid::new_v4().simple());

    // Mutation must reject.
    let body = upload_template(
      &app,
      alice_session,
      &minimal_manifest(&slug, "GQL02 Template"),
      &[
        ("main.typ", VALID_MAIN_TYP.as_bytes()),
        ("preamble.typ", VALID_PREAMBLE_TYP.as_bytes()),
        ("theme.typ", VALID_THEME_TYP.as_bytes()),
      ],
    )
    .await;
    let errs = errors_array(&body);
    assert!(
      !errs.is_empty(),
      "INV-PDF-GQL-TPL-02: upload by non-admin must fail: {body}"
    );

    // Query side must also reject.
    let body = helpers::gql(
      &app,
      alice_session,
      json!({ "query": "{ admin { pdfTemplates { id slug } } }" }),
    )
    .await;
    let errs = errors_array(&body);
    assert!(
      !errs.is_empty(),
      "INV-PDF-GQL-TPL-02: pdfTemplates query by non-admin must fail: {body}"
    );

    // Nothing was persisted.
    assert_eq!(count_templates_with_slug(&pool, &slug).await, 0);

    cleanup_template_by_slug(&pool, &slug).await;
    cleanup_user(&pool, alice_id).await;
  });
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-TPL-03 — invalid manifest atomic-reject
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_gql03_invalid_manifest_rejected_before_blob_write() {
  let (app, pool, auth_store, _blob_store, _storage_dir) = setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let slug = format!("tpl-gql03-{}", Uuid::new_v4().simple());
  cleanup_template_by_slug(&pool, &slug).await;

  // Manifest is missing the required `engine` field — schema validation
  // rejects it before any blob is written.
  let mut bad_manifest = minimal_manifest(&slug, "GQL03 Template");
  bad_manifest.as_object_mut().unwrap().remove("engine");

  let body = upload_template(
    &app,
    admin_session,
    &bad_manifest,
    &[
      ("main.typ", VALID_MAIN_TYP.as_bytes()),
      ("preamble.typ", VALID_PREAMBLE_TYP.as_bytes()),
      ("theme.typ", VALID_THEME_TYP.as_bytes()),
    ],
  )
  .await;
  let errs = errors_array(&body);
  assert!(
    !errs.is_empty(),
    "INV-PDF-GQL-TPL-03: upload with bad manifest must fail: {body}"
  );

  // No row, no file, no blob.
  assert_eq!(
    count_templates_with_slug(&pool, &slug).await,
    0,
    "INV-PDF-GQL-TPL-03: rejected upload must not create a pdf_templates row"
  );
  assert_eq!(
    count_blobs_for_slug(&pool, &slug).await,
    0,
    "INV-PDF-GQL-TPL-03: rejected upload must not create any blob rows"
  );
  assert_eq!(
    count_audit_log(&pool, "pdf_template.upload", admin_id).await,
    0,
    "INV-PDF-GQL-TPL-03: rejected upload must not emit an audit log entry"
  );

  cleanup_template_by_slug(&pool, &slug).await;
  cleanup_user(&pool, admin_id).await;
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-TPL-04 — Typst compile failure atomic-reject
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_gql04_typst_compile_failure_rejects_upload() {
  let (app, pool, auth_store, _blob_store, _storage_dir) = setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let slug = format!("tpl-gql04-{}", Uuid::new_v4().simple());
  cleanup_template_by_slug(&pool, &slug).await;

  // Manifest validates fine; preamble fails Typst with `#error("boom")`,
  // which the validator surfaces as `CompileError::CompileFailed`.
  let manifest = minimal_manifest(&slug, "GQL04 Template");
  let broken_preamble = format!("{VALID_PREAMBLE_TYP}\n#panic(\"boom\")\n");

  let body = upload_template(
    &app,
    admin_session,
    &manifest,
    &[
      ("main.typ", VALID_MAIN_TYP.as_bytes()),
      ("preamble.typ", broken_preamble.as_bytes()),
      ("theme.typ", VALID_THEME_TYP.as_bytes()),
    ],
  )
  .await;
  let errs = errors_array(&body);
  assert!(
    !errs.is_empty(),
    "INV-PDF-GQL-TPL-04: upload with broken Typst must fail: {body}"
  );

  // No row, no file, no blob.
  assert_eq!(
    count_templates_with_slug(&pool, &slug).await,
    0,
    "INV-PDF-GQL-TPL-04: rejected upload must not create a pdf_templates row"
  );
  assert_eq!(
    count_blobs_for_slug(&pool, &slug).await,
    0,
    "INV-PDF-GQL-TPL-04: rejected upload must not create any blob rows"
  );

  cleanup_template_by_slug(&pool, &slug).await;
  cleanup_user(&pool, admin_id).await;
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-TPL-05 — preview resolver auth + success paths
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_gql05_template_preview_renders_base64_pdf_by_uuid_and_slug() {
  let (app, pool, auth_store, _blob_store, _storage_dir) = setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let slug = format!("tpl-gql05-{}", Uuid::new_v4().simple());
  cleanup_template_by_slug(&pool, &slug).await;

  let manifest = minimal_manifest(&slug, "GQL05 Template");
  let upload = upload_template(
    &app,
    admin_session,
    &manifest,
    &[
      ("main.typ", VALID_MAIN_TYP.as_bytes()),
      ("preamble.typ", VALID_PREAMBLE_TYP.as_bytes()),
      ("theme.typ", VALID_THEME_TYP.as_bytes()),
    ],
  )
  .await;
  assert!(
    upload.get("errors").is_none(),
    "INV-PDF-GQL-TPL-05: upload must succeed before preview: {upload}"
  );
  let template_id = upload
    .pointer("/data/admin/uploadPdfTemplate/id")
    .and_then(Value::as_str)
    .expect("template id");

  for template_ref in [template_id, slug.as_str()] {
    let body = preview_template(&app, admin_session, template_ref, Some("de-DE")).await;
    assert!(
      body.get("errors").is_none(),
      "INV-PDF-GQL-TPL-05: preview must render for `{template_ref}`: {body}"
    );
    let encoded = body
      .pointer("/data/pdfTemplatePreviewPdf")
      .and_then(Value::as_str)
      .expect("preview base64 payload");
    let pdf_bytes = BASE64_STANDARD.decode(encoded).expect("preview base64 decodes");
    assert!(
      pdf_bytes.starts_with(b"%PDF-"),
      "INV-PDF-GQL-TPL-05: preview payload must be a PDF byte stream"
    );
  }

  cleanup_template_by_slug(&pool, &slug).await;
  cleanup_user(&pool, admin_id).await;
}

#[tokio::test]
async fn inv_gql06_template_preview_rejects_non_admin_and_unknown_registry_ref() {
  let (app, pool, auth_store, _blob_store, _storage_dir) = setup_app().await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-gql06").await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let missing_slug = format!("tpl-gql06-missing-{}", Uuid::new_v4().simple());

  let body = preview_template(&app, alice_session, &missing_slug, None).await;
  assert!(
    !errors_array(&body).is_empty(),
    "INV-PDF-GQL-TPL-06: non-admin preview must fail: {body}"
  );

  let body = preview_template(&app, admin_session, &missing_slug, None).await;
  let errs = errors_array(&body);
  assert!(
    errs.iter().any(|msg| msg.contains("template registry")),
    "INV-PDF-GQL-TPL-06: unknown preview ref must surface a registry error: {body}"
  );

  cleanup_user(&pool, alice_id).await;
  cleanup_user(&pool, admin_id).await;
}

#[tokio::test]
async fn inv_gql06b_template_preview_allows_workspace_members_for_assigned_templates_only() {
  let (app, pool, auth_store, _blob_store, _storage_dir) = setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-gql06b").await;
  let (bobby_id, bobby_session) = helpers::seed_user(&pool, &auth_store, "bobby-gql06b").await;
  let ws_alpha = helpers::create_workspace(&pool, alice_id).await;
  let ws_beta = helpers::create_workspace(&pool, bobby_id).await;
  let slug = format!("tpl-gql06b-{}", Uuid::new_v4().simple());
  cleanup_template_by_slug(&pool, &slug).await;

  let manifest = minimal_manifest(&slug, "GQL06B Template");
  let upload = upload_template(
    &app,
    admin_session,
    &manifest,
    &[
      ("main.typ", VALID_MAIN_TYP.as_bytes()),
      ("preamble.typ", VALID_PREAMBLE_TYP.as_bytes()),
      ("theme.typ", VALID_THEME_TYP.as_bytes()),
    ],
  )
  .await;
  assert!(
    upload.get("errors").is_none(),
    "INV-PDF-GQL-TPL-06B: upload must succeed before workspace preview: {upload}"
  );
  let template_id = Uuid::parse_str(
    upload
      .pointer("/data/admin/uploadPdfTemplate/id")
      .and_then(Value::as_str)
      .expect("template id"),
  )
  .expect("uuid template id");

  sqlx::query(
    "INSERT INTO pdf_workspace_template_assignments \
     (workspace_id, template_id, is_default, assigned_by, assigned_at) \
     VALUES ($1, $2, false, $3, now())",
  )
  .bind(ws_alpha)
  .bind(template_id)
  .bind(admin_id)
  .execute(&pool)
  .await
  .expect("assign template to alice workspace");

  let body = preview_template_with_workspace(
    &app,
    alice_session,
    &template_id.to_string(),
    Some("en-US"),
    Some(ws_alpha),
  )
  .await;
  assert!(
    body.get("errors").is_none(),
    "INV-PDF-GQL-TPL-06B: workspace member must preview assigned template: {body}"
  );
  let encoded = body
    .pointer("/data/pdfTemplatePreviewPdf")
    .and_then(Value::as_str)
    .expect("workspace preview base64 payload");
  let pdf_bytes = BASE64_STANDARD
    .decode(encoded)
    .expect("workspace preview base64 decodes");
  assert!(
    pdf_bytes.starts_with(b"%PDF-"),
    "INV-PDF-GQL-TPL-06B: workspace preview payload must be a PDF byte stream"
  );

  let unassigned_body = preview_template_with_workspace(
    &app,
    bobby_session,
    &template_id.to_string(),
    Some("en-US"),
    Some(ws_beta),
  )
  .await;
  assert!(
    !errors_array(&unassigned_body).is_empty(),
    "INV-PDF-GQL-TPL-06B: member of another workspace must not preview unassigned template: {unassigned_body}"
  );

  let non_member_body = preview_template_with_workspace(
    &app,
    bobby_session,
    &template_id.to_string(),
    Some("en-US"),
    Some(ws_alpha),
  )
  .await;
  assert!(
    !errors_array(&non_member_body).is_empty(),
    "INV-PDF-GQL-TPL-06B: non-member must not preview alpha workspace template: {non_member_body}"
  );

  cleanup_workspace(&pool, ws_alpha).await;
  cleanup_workspace(&pool, ws_beta).await;
  cleanup_template_by_slug(&pool, &slug).await;
  for uid in [alice_id, bobby_id, admin_id] {
    cleanup_user(&pool, uid).await;
  }
}

#[tokio::test]
async fn inv_gql07_template_preview_surfaces_render_errors_without_persisting_cache() {
  let (app, pool, auth_store, blob_store, _storage_dir) = setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let slug = format!("tpl-gql07-{}", Uuid::new_v4().simple());
  cleanup_template_by_slug(&pool, &slug).await;

  let mut manifest = minimal_manifest(&slug, "GQL07 Template");
  let manifest_obj = manifest.as_object_mut().expect("manifest object");
  manifest_obj.insert("assets".to_owned(), json!(["main.typ", "broken.typ"]));
  manifest_obj.insert("entry".to_owned(), json!("broken.typ"));

  let template_id = Uuid::new_v4();
  let now = chrono::Utc::now();
  let parsed_manifest: myoxus_domain::pdf_template_manifest::PdfTemplateManifest =
    serde_json::from_value(manifest.clone()).expect("valid manifest");
  let (main_blob, main_hash) = blob_store
    .put_template_file(template_id, "main.typ", b"// unused main\n")
    .await
    .expect("write main");
  let broken_source = br#"#panic("preview boom")"#;
  let (broken_blob, broken_hash) = blob_store
    .put_template_file(template_id, "broken.typ", broken_source)
    .await
    .expect("write broken source");

  let row = myoxus_domain::entities::PdfTemplate {
    id: template_id,
    slug: slug.clone(),
    name: "GQL07 Template".to_owned(),
    version: "1.0.0".to_owned(),
    schema_version: parsed_manifest.schema_version.clone(),
    manifest,
    created_by: Some(admin_id),
    created_at: now,
    deleted_at: None,
  };
  let file_records = vec![
    myoxus_domain::entities::PdfTemplateFile {
      template_id,
      file_path: "main.typ".to_owned(),
      blob_key: main_blob,
      content_hash: main_hash,
    },
    myoxus_domain::entities::PdfTemplateFile {
      template_id,
      file_path: "broken.typ".to_owned(),
      blob_key: broken_blob,
      content_hash: broken_hash,
    },
  ];
  let repo = PgPdfTemplateRepository::new(pool.clone());
  myoxus_domain::repositories::PdfTemplateRepository::create(&repo, &row, &file_records, None)
    .await
    .expect("insert render-error fixture");

  let body = preview_template(&app, admin_session, &slug, None).await;
  let errs = errors_array(&body);
  assert!(
    errs
      .iter()
      .any(|msg| msg.contains("template preview render failed") || msg.contains("preview render failed")),
    "INV-PDF-GQL-TPL-07: render failure must surface as preview render error: {body}"
  );
  assert!(
    error_classes(&body).iter().any(|class| class == "TemplateError"),
    "INV-PDF-GQL-TPL-07: render failure must expose TemplateError class: {body}"
  );

  // Repeat once to ensure the failed load was not cached as a successful
  // preview. A cached failure would make this assertion meaningless by hiding
  // the renderer path from subsequent calls.
  let body = preview_template(&app, admin_session, &slug, None).await;
  assert!(
    !errors_array(&body).is_empty(),
    "INV-PDF-GQL-TPL-07: repeated render failure must still be an error: {body}"
  );

  cleanup_template_by_id(&pool, template_id).await;
  cleanup_user(&pool, admin_id).await;
}

/// The actual mutation/preview consumers must preserve failure atomicity and
/// retry behavior when a finite template exceeds a compiler resource budget.
#[test]
fn compiler_timeout_preserves_template_revision_and_preview_cache() {
  helpers::block_on_large_stack("compiler_timeout_preserves_template_revision_and_preview_cache", || {
    compiler_resource_regression(false)
  });
}

#[test]
fn compiler_memory_limit_preserves_template_revision_and_next_preview() {
  helpers::block_on_large_stack(
    "compiler_memory_limit_preserves_template_revision_and_next_preview",
    || compiler_resource_regression(true),
  );
}

async fn compiler_resource_regression(memory: bool) {
  let (app, pool, auth_store, blob_store, _storage_dir) =
    setup_app_with_budget(Some(if memory { 30 } else { 1 }), memory.then_some(512)).await;
  let (admin_id, session) = helpers::seed_admin(&pool, &auth_store).await;
  let slug = format!("tpl-timeout-{}", Uuid::new_v4().simple());
  use futures_util::FutureExt;
  let outcome = std::panic::AssertUnwindSafe(async {
    let mut manifest = minimal_manifest(&slug, "Compiler lifetime");
    let slow: Vec<u8> = if memory {
      format!("{VALID_PREAMBLE_TYP}\n#let heap = range(12000000)").into_bytes()
    } else {
      b"#for n in range(10000) { for m in range(10000) { let s = str(n + m) } }".to_vec()
    };
    let expected_message = if memory { "memory limit" } else { "timed out" };
    let expected_class = if memory { "TooLarge" } else { "Timeout" };
    let slow_files: &[(&str, &[u8])] = &[
      ("main.typ", VALID_MAIN_TYP.as_bytes()),
      ("theme.typ", VALID_THEME_TYP.as_bytes()),
      ("preamble.typ", slow.as_slice()),
    ];
    let failed = upload_template(&app, session, &manifest, slow_files).await;
    assert!(
      errors_array(&failed).iter().any(|msg| msg.contains(expected_message)),
      "upload: {failed}"
    );
    if memory {
      assert!(
        error_classes(&failed).iter().any(|class| class == expected_class),
        "upload resource class: {failed}"
      );
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM pdf_templates WHERE slug = $1")
      .bind(&slug)
      .fetch_one(&pool)
      .await
      .expect("template count");
    assert_eq!(count, 0, "failed compilation cannot publish a template");

    let normal: &[(&str, &[u8])] = &[
      ("main.typ", VALID_MAIN_TYP.as_bytes()),
      ("theme.typ", VALID_THEME_TYP.as_bytes()),
      ("preamble.typ", VALID_PREAMBLE_TYP.as_bytes()),
    ];
    let uploaded = upload_template(&app, session, &manifest, normal).await;
    assert!(errors_array(&uploaded).is_empty(), "subsequent upload: {uploaded}");
    let id = Uuid::parse_str(
      uploaded
        .pointer("/data/admin/uploadPdfTemplate/id")
        .and_then(Value::as_str)
        .expect("uploaded id"),
    )
    .unwrap();
    let before: Vec<(String, String, String)> = sqlx::query_as(
      "SELECT file_path, blob_key, content_hash FROM pdf_template_files WHERE template_id = $1 ORDER BY file_path",
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .expect("prior bundle");
    manifest["version"] = json!("1.0.1");
    let failed = replace_template(&app, session, id, &manifest, slow_files).await;
    assert!(
      errors_array(&failed).iter().any(|msg| msg.contains(expected_message)),
      "replacement: {failed}"
    );
    if memory {
      assert!(
        error_classes(&failed).iter().any(|class| class == expected_class),
        "replacement resource class: {failed}"
      );
    }
    let version: String = sqlx::query_scalar("SELECT version FROM pdf_templates WHERE id = $1")
      .bind(id)
      .fetch_one(&pool)
      .await
      .expect("version");
    assert_eq!(version, "1.0.0");
    let after: Vec<(String, String, String)> = sqlx::query_as(
      "SELECT file_path, blob_key, content_hash FROM pdf_template_files WHERE template_id = $1 ORDER BY file_path",
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .expect("unchanged bundle");
    assert_eq!(after, before, "failed compilation must preserve all prior blobs");

    // Store the expensive source directly as an isolated preview fixture: upload
    // validation correctly refuses it, so it cannot otherwise reach preview.
    let (key, hash) = blob_store
      .put_template_revision_file(id, "preamble.typ", &slow)
      .await
      .expect("slow preview fixture");
    sqlx::query("UPDATE pdf_template_files SET blob_key = $1, content_hash = $2 WHERE template_id = $3 AND file_path = 'preamble.typ'").bind(&key).bind(&hash).bind(id).execute(&pool).await.expect("preview fixture binding");
    for _ in 0..2 {
      let started = std::time::Instant::now();
      let body = preview_template(&app, session, &slug, None).await;
      assert!(
        error_classes(&body).iter().any(|class| class == expected_class),
        "preview resource class: {body}"
      );
      assert!(
        memory || started.elapsed() >= Duration::from_millis(900),
        "failed preview must execute again rather than cache failure"
      );
      assert!(body.pointer("/data/pdfTemplatePreviewPdf").is_none_or(Value::is_null));
    }
    let (_, old_key, old_hash) = before.iter().find(|(path, _, _)| path == "preamble.typ").unwrap();
    sqlx::query("UPDATE pdf_template_files SET blob_key = $1, content_hash = $2 WHERE template_id = $3 AND file_path = 'preamble.typ'").bind(old_key).bind(old_hash).bind(id).execute(&pool).await.expect("restore normal source");
    let preview = preview_template(&app, session, &slug, None).await;
    assert!(errors_array(&preview).is_empty(), "next preview succeeds: {preview}");
  }).catch_unwind().await;
  cleanup_template_by_slug(&pool, &slug).await;
  cleanup_user(&pool, admin_id).await;
  if let Err(payload) = outcome {
    std::panic::resume_unwind(payload);
  }
}

#[test]
fn template_mutations_roll_back_with_audit_and_retain_captured_bundle_bytes() {
  helpers::block_on_large_stack("pdf-template-atomic-audit", || async {
    use futures_util::FutureExt;
    let (app, pool, auth, blobs, dir) = setup_app().await;
    let (admin, session) = helpers::seed_admin(&pool, &auth).await;
    let slug = format!("atomic-template-{}", Uuid::new_v4());
    let constraint = format!("tpl_audit_{}", admin.simple());
    let manifest = minimal_manifest(&slug, "Atomic template");
    let files = [
      ("main.typ", VALID_MAIN_TYP.as_bytes()),
      ("preamble.typ", VALID_PREAMBLE_TYP.as_bytes()),
      ("theme.typ", VALID_THEME_TYP.as_bytes()),
    ];
    let result=std::panic::AssertUnwindSafe(async {
      sqlx::query(&format!("ALTER TABLE admin_audit_log ADD CONSTRAINT {constraint} CHECK(actor_user_id IS DISTINCT FROM '{admin}' OR event_key NOT LIKE 'pdf_template.%') NOT VALID"))
        .execute(&pool).await.unwrap();
      let failed=upload_template(&app,session,&manifest,&files).await;
      assert!(failed["errors"].as_array().unwrap().iter().any(|e|e["message"].as_str().unwrap().contains(&constraint)),"upload audit failure: {failed}");
      assert_eq!(count_templates_with_slug(&pool,&slug).await,0);
      assert_eq!(count_audit_log(&pool,"pdf_template.upload",admin).await,0);
      fn file_count(path:&std::path::Path)->usize {
        std::fs::read_dir(path).unwrap().map(|entry|{let entry=entry.unwrap();if entry.file_type().unwrap().is_dir(){file_count(&entry.path())}else{1}}).sum()
      }
      assert_eq!(file_count(dir.path()),0,"failed initial upload removes only its UUID-owned bytes");
      sqlx::query(&format!("ALTER TABLE admin_audit_log DROP CONSTRAINT {constraint}")).execute(&pool).await.unwrap();
      let uploaded=upload_template(&app,session,&manifest,&files).await;
      assert!(uploaded.get("errors").is_none(),"upload: {uploaded}");
      assert_eq!(count_audit_log(&pool,"pdf_template.upload",admin).await,1);
      let id=Uuid::parse_str(uploaded["data"]["admin"]["uploadPdfTemplate"]["id"].as_str().unwrap()).unwrap();
      let snapshot=||async {
        sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('header',(SELECT to_jsonb(t) FROM pdf_templates t WHERE id=$1),'files',(SELECT jsonb_agg(to_jsonb(f) ORDER BY file_path) FROM pdf_template_files f WHERE template_id=$1))")
          .bind(id).fetch_one(&pool).await.unwrap()
      };
      let before=snapshot().await;
      let old_keys:Vec<(String,String)>=sqlx::query_as("SELECT file_path,blob_key FROM pdf_template_files WHERE template_id=$1 ORDER BY file_path")
        .bind(id).fetch_all(&pool).await.unwrap();
      let mut next=manifest.clone();next["version"]=json!("1.1.0");next["provenance"]["source_revision"]=json!("1.1.0");
      let revised=format!("{VALID_MAIN_TYP}\n// immutable revision\n");
      let replacement_files=[("main.typ",revised.as_bytes()),("preamble.typ",VALID_PREAMBLE_TYP.as_bytes()),("theme.typ",VALID_THEME_TYP.as_bytes())];
      sqlx::query(&format!("ALTER TABLE admin_audit_log ADD CONSTRAINT {constraint} CHECK(actor_user_id IS DISTINCT FROM '{admin}' OR event_key NOT LIKE 'pdf_template.%') NOT VALID"))
        .execute(&pool).await.unwrap();
      for fields in [format!("updatePdfTemplateMetadata(id:\"{id}\",name:\"Changed\"){{name}}"),format!("deletePdfTemplate(id:\"{id}\")")] {
        let failed=helpers::gql(&app,session,json!({"query":format!("mutation{{admin{{{fields}}}}}")})).await;
        assert!(failed["errors"].as_array().unwrap().iter().any(|e|e["message"].as_str().unwrap().contains(&constraint)),"atomic mutation: {failed}");
        assert_eq!(snapshot().await,before,"failed audit preserves the full header/inventory and reuse inputs");
      }
      let failed=replace_template(&app,session,id,&next,&replacement_files).await;
      assert!(failed["errors"].as_array().unwrap().iter().any(|e|e["message"].as_str().unwrap().contains(&constraint)),"replacement audit failure: {failed}");
      assert_eq!(snapshot().await,before);
      for (path,key) in &old_keys {
        let expected=files.iter().find(|(name,_)|name==path).unwrap().1;
        assert_eq!(blobs.get_template_file(key).await.unwrap(),expected,"captured prior bytes remain intact");
      }
      sqlx::query(&format!("ALTER TABLE admin_audit_log DROP CONSTRAINT {constraint}")).execute(&pool).await.unwrap();
      let replaced=replace_template(&app,session,id,&next,&replacement_files).await;
      assert!(replaced.get("errors").is_none(),"replacement: {replaced}");
      assert_eq!(count_audit_log(&pool,"pdf_template.replace_bundle",admin).await,1);
      let replaced_state=snapshot().await;
      let stale=replace_template(&app,session,id,&next,&replacement_files).await;
      assert!(stale["errors"].as_array().is_some_and(|errors|!errors.is_empty()),"same-version replacement is rejected");
      assert_eq!(snapshot().await,replaced_state);
      assert_eq!(count_audit_log(&pool,"pdf_template.replace_bundle",admin).await,1);
      for _ in 0..2 {
        let renamed=helpers::gql(&app,session,json!({"query":"mutation($id:ID!){admin{updatePdfTemplateMetadata(id:$id,name:\"Changed\"){name}}}","variables":{"id":id.to_string()}})).await;
        assert_eq!(renamed["data"]["admin"]["updatePdfTemplateMetadata"]["name"],"Changed");
      }
      assert_eq!(count_audit_log(&pool,"pdf_template.update_metadata",admin).await,2,"metadata keeps audit-on-valid-no-op behavior");
      let fields=format!("mutation{{admin{{deletePdfTemplate(id:\"{id}\")}}}}");
      let deleted=helpers::gql(&app,session,json!({"query":fields})).await;
      assert_eq!(deleted["data"]["admin"]["deletePdfTemplate"],true);
      let noop=helpers::gql(&app,session,json!({"query":fields})).await;
      assert_eq!(noop["data"]["admin"]["deletePdfTemplate"],false);
      assert_eq!(count_audit_log(&pool,"pdf_template.delete",admin).await,1,"delete no-op stays unaudited");
      for (path,key) in old_keys {
        assert_eq!(blobs.get_template_file(&key).await.unwrap(),files.iter().find(|(name,_)|name==&path).unwrap().1);
      }
    }).catch_unwind().await;
    sqlx::query(&format!(
      "ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS {constraint}"
    ))
    .execute(&pool)
    .await
    .unwrap();
    cleanup_template_by_slug(&pool, &slug).await;
    cleanup_user(&pool, admin).await;
    if let Err(panic) = result {
      std::panic::resume_unwind(panic)
    }
  });
}
