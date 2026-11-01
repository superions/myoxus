// SPDX-License-Identifier: AGPL-3.0-or-later
//! `P-PDF-TPL-AUDIT-01-{05,07}` integration tests for the render-audit log.
//!
//! Invariants:
//!
//! - `INV-PDF-AUDIT-RENDER-01` (`P-PDF-TPL-AUDIT-01-05`):
//!   Every successful `export_pdf` invocation creates exactly one
//!   row in `pdf_export_render_audit`, keyed to the same job id, with
//!   the actor + workspace + doc + locale + L3-input snapshot intact.
//!
//! - `INV-PDF-AUDIT-RENDER-03` (`P-PDF-TPL-AUDIT-01-07`):
//!   Two consecutive renders against the same workspace produce
//!   `render_appearance_hash` values that **change** when the effective Theme DB
//!   branding profile was mutated between calls and **stay equal** when
//!   nothing changed. This is the load-bearing compliance invariant — without
//!   it an auditor cannot reconstruct which brand and font asset snapshot was
//!   active.

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
  PdfBlobStore, PgPdfExportRenderAuditRepository, PgPdfFontRepository, PgPdfIccProfileRepository,
  PgPdfTemplateRepository, PgPdfWorkspaceBrandAssetRepository, PgPdfWorkspaceTemplateAssignmentRepository,
  seed_system_icc_profiles,
};
use myoxus_infrastructure::storage::StorageAdapter;

// ---------------------------------------------------------------------------
// App builder — mirrors pdf_export_assignment_test::setup_app + audit repo.
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
  config.pdf_export.sync_threshold_blocks = 0;

  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage_dir = format!("./test-storage/pdf-audit-{}", Uuid::new_v4());
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
    Arc::new(PgPdfExportRenderAuditRepository::new(pool.clone()));
  let pdf_blob_store = Arc::new(PdfBlobStore::new(storage_op));
  let icc_repo: Arc<dyn myoxus_domain::repositories::PdfIccProfileRepository> =
    Arc::new(PgPdfIccProfileRepository::new(pool.clone()));
  seed_system_icc_profiles(icc_repo, pdf_blob_store.clone())
    .await
    .expect("seed bundled ICC profiles for render-audit tests");
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async fn insert_template(pool: &PgPool, slug: &str, created_by: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  let manifest = json!({
    "schema_version": "2.0",
    "id": slug,
    "name": slug,
    "description": "Render audit integration test fixture.",
    "version": "1.0.0",
    "engine": { "name": "typst", "version": "0.15.x" },
    "provenance": {
      "license_spdx": "AGPL-3.0-or-later",
      "copyright_notice": "Copyright 2026 Myoxus test contributors",
      "source_url": "https://example.test/templates/render-audit",
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
  .bind("Audit Test Doc")
  .bind(created_by)
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

async fn assign(pool: &PgPool, ws: Uuid, tpl: Uuid, by: Uuid) {
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
  .expect("insert assignment");
}

async fn render_audits_for_actor(pool: &PgPool, actor: Uuid) -> Vec<(Uuid, Uuid, String, String, String, Value)> {
  sqlx::query_as::<_, (Uuid, Uuid, String, String, String, Value)>(
    "SELECT id, job_id, render_appearance_hash, locale, template_version, l3_inputs \
       FROM pdf_export_render_audit \
       WHERE actor_id = $1 \
       ORDER BY created_at ASC",
  )
  .bind(actor)
  .fetch_all(pool)
  .await
  .expect("read render audits")
}

async fn render_inputs_for_job(pool: &PgPool, job_id: Uuid) -> Value {
  sqlx::query_scalar::<_, Value>("SELECT render_inputs FROM pdf_export_jobs WHERE id = $1")
    .bind(job_id)
    .fetch_one(pool)
    .await
    .expect("read pdf_export_jobs.render_inputs")
}

async fn cleanup(pool: &PgPool, ws: Uuid, doc: Uuid, tpl: Uuid, user_id: Uuid) {
  let _ = sqlx::query("DELETE FROM pdf_export_render_audit WHERE actor_id = $1")
    .bind(user_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM pdf_export_jobs WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM pdf_export_settings WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM document_brand_profiles WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM brand_assets WHERE workspace_id = $1")
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
// INV-PDF-AUDIT-RENDER-04 — PDF settings and document branding stay separate
// ---------------------------------------------------------------------------

#[test]
fn inv_audit_render04_pdf_settings_and_document_branding_boundary() {
  helpers::block_on_large_stack(
    "inv_audit_render04_pdf_settings_and_document_branding_boundary",
    || async {
      let (app, pool, auth_store) = setup_app().await;
      let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
      let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-render04").await;
      let ws = helpers::create_workspace(&pool, alice_id).await;
      let tpl = insert_template(&pool, &format!("tpl-render04-{}", Uuid::new_v4().simple()), admin_id).await;
      let doc = insert_doc(&pool, ws, alice_id).await;
      insert_doc_snapshot(&pool, ws, doc, build_pdf_doc_yjs(2)).await;
      assign(&pool, ws, tpl, admin_id).await;

      let configure = helpers::gql(
        &app,
        admin_session,
        json!({
          "query": r##"
            mutation Configure(
              $ws: ID!,
              $footer: String,
              $primary: String,
              $accent: String,
              $paper: String,
              $locale: String,
              $profile: String,
              $quality: String,
              $ligatures: Boolean
            ) {
              admin {
                updateDocumentBrandingText(workspaceId: $ws, footerText: $footer) {
                  footerText
                }
                updateDocumentBrandingColors(workspaceId: $ws, primary: $primary, accent: $accent) {
                  brandColorPrimary
                  brandColorAccent
                }
                updatePdfExportSettings(
                  workspaceId: $ws,
                  paperSize: $paper,
                  locale: $locale,
                  colorProfile: $profile,
                  imageQuality: $quality,
                  ligaturesEnabled: $ligatures
                ) {
                  defaultPaperSize
                  defaultLocale
                  defaultColorProfile
                  defaultImageQuality
                  ligaturesEnabled
                }
              }
            }
          "##,
          "variables": {
            "ws": ws.to_string(),
            "footer": "Legal footer 2026",
            "primary": "#112233",
            "accent": "#445566",
            "paper": "Letter",
            "locale": "de",
            "profile": "CMYK_SWOP",
            "quality": "lossless",
            "ligatures": false
          }
        }),
      )
      .await;
      assert!(
        configure.get("errors").is_none(),
        "INV-PDF-AUDIT-RENDER-04: admin configuration must succeed: {configure}"
      );

      let body = helpers::gql(
        &app,
        alice_session,
        json!({
          "query": "mutation Start($input: PdfExportInputV2Input!) { exportPdf(input: $input) { id status } }",
          "variables": {
            "input": {
              "workspaceId": ws.to_string(),
              "docId": doc.to_string(),
              "templateId": tpl.to_string()
            }
          }
        }),
      )
      .await;
      assert!(
        body.get("errors").is_none(),
        "INV-PDF-AUDIT-RENDER-04: export without explicit policy inputs must succeed: {body}"
      );
      let job_id = body
        .pointer("/data/exportPdf/id")
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
        .expect("job id from response");

      let render_inputs = render_inputs_for_job(&pool, job_id).await;
      for (field, expected) in [
        ("paper_size", json!("Letter")),
        ("locale", json!("de")),
        ("color_profile", json!("CMYK_SWOP")),
        ("image_quality", json!("lossless")),
        ("ligatures_enabled", json!(false)),
      ] {
        assert_eq!(
          render_inputs.get(field),
          Some(&expected),
          "INV-PDF-AUDIT-RENDER-04: {field} must come from pdf_export_settings when omitted in exportPdf input"
        );
      }
      assert_eq!(
        render_inputs.pointer("/document_branding/footer_text"),
        Some(&json!("Legal footer 2026")),
        "INV-PDF-AUDIT-RENDER-04: footer must come from document_brand_profiles"
      );
      assert_eq!(
        render_inputs.pointer("/document_branding/primary"),
        Some(&json!("#112233")),
        "INV-PDF-AUDIT-RENDER-04: primary color must come from document_brand_profiles"
      );
      assert_eq!(
        render_inputs.pointer("/document_branding/accent"),
        Some(&json!("#445566")),
        "INV-PDF-AUDIT-RENDER-04: accent color must come from document_brand_profiles"
      );
      assert!(
        render_inputs.pointer("/document_branding/color_profile").is_none()
          && render_inputs.pointer("/document_branding/image_quality").is_none()
          && render_inputs.pointer("/document_branding/ligatures_enabled").is_none(),
        "INV-PDF-AUDIT-RENDER-04: PDF settings must not be nested into document branding: {render_inputs}"
      );
      assert!(
        render_inputs.get("brand_color_primary").is_none() && render_inputs.get("brand_color_accent").is_none(),
        "INV-PDF-AUDIT-RENDER-04: document colors must remain under document_branding, not top-level legacy keys"
      );

      let audits = render_audits_for_actor(&pool, alice_id).await;
      assert_eq!(audits.len(), 1, "first render must create exactly one audit row");
      assert_eq!(audits[0].1, job_id, "audit row job_id must match first job");
      assert_eq!(audits[0].5["paper_size"], "Letter");
      assert_eq!(audits[0].5["locale"], "de");
      assert_eq!(audits[0].5["color_profile"], "CMYK_SWOP");
      assert_eq!(audits[0].5["image_quality"], "lossless");
      assert_eq!(audits[0].5["ligatures_enabled"], false);
      assert_eq!(audits[0].5["document_branding"]["footer_text"], "Legal footer 2026");
      assert_eq!(audits[0].5["document_branding"]["primary"], "#112233");
      assert_eq!(audits[0].5["document_branding"]["accent"], "#445566");

      // Mutating only PDF export settings must change the audited render
      // policy but not the document-branding/theme snapshot hash. This guards
      // the owner boundary against future regressions in `effective_pdf_render_appearance_hash`.
      let settings_only = helpers::gql(
        &app,
        admin_session,
        json!({
          "query": r#"
            mutation SettingsOnly(
              $ws: ID!,
              $paper: String,
              $locale: String,
              $profile: String,
              $quality: String,
              $ligatures: Boolean
            ) {
              admin {
                updatePdfExportSettings(
                  workspaceId: $ws,
                  paperSize: $paper,
                  locale: $locale,
                  colorProfile: $profile,
                  imageQuality: $quality,
                  ligaturesEnabled: $ligatures
                ) {
                  defaultPaperSize
                  defaultLocale
                  defaultColorProfile
                  defaultImageQuality
                  ligaturesEnabled
                }
              }
            }
          "#,
          "variables": {
            "ws": ws.to_string(),
            "paper": "A5",
            "locale": "en",
            "profile": "sRGB",
            "quality": "low",
            "ligatures": true
          }
        }),
      )
      .await;
      assert!(
        settings_only.get("errors").is_none(),
        "INV-PDF-AUDIT-RENDER-04: settings-only update must succeed: {settings_only}"
      );

      let doc2 = insert_doc(&pool, ws, alice_id).await;
      insert_doc_snapshot(&pool, ws, doc2, build_pdf_doc_yjs(3)).await;
      let body2 = helpers::gql(
        &app,
        alice_session,
        json!({
          "query": "mutation Start($input: PdfExportInputV2Input!) { exportPdf(input: $input) { id status } }",
          "variables": {
            "input": {
              "workspaceId": ws.to_string(),
              "docId": doc2.to_string(),
              "templateId": tpl.to_string()
            }
          }
        }),
      )
      .await;
      assert!(
        body2.get("errors").is_none(),
        "INV-PDF-AUDIT-RENDER-04: export after settings-only update must succeed: {body2}"
      );

      let audits = render_audits_for_actor(&pool, alice_id).await;
      assert_eq!(audits.len(), 2, "second render must create a second audit row");
      assert_eq!(
        audits[0].2, audits[1].2,
        "INV-PDF-AUDIT-RENDER-04: PDF settings-only updates must not change the document branding/theme hash"
      );
      assert_eq!(audits[1].5["paper_size"], "A5");
      assert_eq!(audits[1].5["locale"], "en");
      assert_eq!(audits[1].5["color_profile"], "sRGB");
      assert_eq!(audits[1].5["image_quality"], "low");
      assert_eq!(audits[1].5["ligatures_enabled"], true);
      assert_eq!(
        audits[1].5["document_branding"]["footer_text"], "Legal footer 2026",
        "INV-PDF-AUDIT-RENDER-04: settings-only update must not clear document branding"
      );

      let brand_only = helpers::gql(
        &app,
        admin_session,
        json!({
          "query": r#"
            mutation BrandOnly($ws: ID!, $footer: String, $primary: String, $accent: String) {
              admin {
                updateDocumentBrandingText(workspaceId: $ws, footerText: $footer) {
                  footerText
                }
                updateDocumentBrandingColors(workspaceId: $ws, primary: $primary, accent: $accent) {
                  brandColorPrimary
                  brandColorAccent
                }
              }
            }
          "#,
          "variables": {
            "ws": ws.to_string(),
            "footer": "Legal footer 2026 revised",
            "primary": "#223344",
            "accent": "#556677"
          }
        }),
      )
      .await;
      assert!(
        brand_only.get("errors").is_none(),
        "INV-PDF-AUDIT-RENDER-04: brand-only update must succeed: {brand_only}"
      );

      let doc3 = insert_doc(&pool, ws, alice_id).await;
      insert_doc_snapshot(&pool, ws, doc3, build_pdf_doc_yjs(4)).await;
      let body3 = helpers::gql(
        &app,
        alice_session,
        json!({
          "query": "mutation Start($input: PdfExportInputV2Input!) { exportPdf(input: $input) { id status } }",
          "variables": {
            "input": {
              "workspaceId": ws.to_string(),
              "docId": doc3.to_string(),
              "templateId": tpl.to_string()
            }
          }
        }),
      )
      .await;
      assert!(
        body3.get("errors").is_none(),
        "INV-PDF-AUDIT-RENDER-04: export after brand-only update must succeed: {body3}"
      );

      let audits = render_audits_for_actor(&pool, alice_id).await;
      assert_eq!(audits.len(), 3, "third render must create a third audit row");
      assert_ne!(
        audits[1].2, audits[2].2,
        "INV-PDF-AUDIT-RENDER-04: document-branding updates must change the document branding/theme hash"
      );
      assert_eq!(audits[2].5["paper_size"], "A5");
      assert_eq!(audits[2].5["locale"], "en");
      assert_eq!(audits[2].5["color_profile"], "sRGB");
      assert_eq!(audits[2].5["image_quality"], "low");
      assert_eq!(audits[2].5["ligatures_enabled"], true);
      assert_eq!(
        audits[2].5["document_branding"]["footer_text"],
        "Legal footer 2026 revised"
      );
      assert_eq!(audits[2].5["document_branding"]["primary"], "#223344");
      assert_eq!(audits[2].5["document_branding"]["accent"], "#556677");

      let _ = sqlx::query("DELETE FROM doc_snapshots WHERE doc_id = $1")
        .bind(doc3)
        .execute(&pool)
        .await;
      let _ = sqlx::query("DELETE FROM docs WHERE id = $1")
        .bind(doc3)
        .execute(&pool)
        .await;
      let _ = sqlx::query("DELETE FROM doc_snapshots WHERE doc_id = $1")
        .bind(doc2)
        .execute(&pool)
        .await;
      let _ = sqlx::query("DELETE FROM docs WHERE id = $1")
        .bind(doc2)
        .execute(&pool)
        .await;
      cleanup(&pool, ws, doc, tpl, alice_id).await;
      let _ = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(admin_id)
        .execute(&pool)
        .await;
    },
  );
}

// ---------------------------------------------------------------------------
// INV-PDF-AUDIT-RENDER-01 — every export creates an audit row
// ---------------------------------------------------------------------------

#[test]
fn inv_audit_render01_every_export_creates_entry() {
  helpers::block_on_large_stack("inv_audit_render01_every_export_creates_entry", || async {
    let (app, pool, auth_store) = setup_app().await;
    let _guard = helpers::THEME_BRANDING_LOCK
      .get_or_init(|| tokio::sync::Mutex::new(()))
      .lock()
      .await;
    let (admin_id, _admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-render01").await;
    myoxus_infrastructure::branding::set_theme_profile(&pool, None, "stuttgart", "system", Some(admin_id))
      .await
      .expect("pin global theme for render-audit snapshot test");
    let ws = helpers::create_workspace(&pool, alice_id).await;
    let tpl = insert_template(&pool, &format!("tpl-render01-{}", Uuid::new_v4().simple()), admin_id).await;
    let doc = insert_doc(&pool, ws, alice_id).await;
    insert_doc_snapshot(&pool, ws, doc, build_pdf_doc_yjs(2)).await;
    assign(&pool, ws, tpl, admin_id).await;

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
            "locale": "de"
          }
        }
      }),
    )
    .await;
    assert!(
      body.get("errors").is_none(),
      "INV-PDF-AUDIT-RENDER-01: start must succeed: {body}"
    );
    let job_id = body
      .pointer("/data/exportPdf/id")
      .and_then(Value::as_str)
      .and_then(|s| Uuid::parse_str(s).ok())
      .expect("job id from response");

    let audits = render_audits_for_actor(&pool, alice_id).await;
    assert_eq!(
      audits.len(),
      1,
      "INV-PDF-AUDIT-RENDER-01: must create exactly one audit row"
    );
    assert_eq!(
      audits[0].1, job_id,
      "INV-PDF-AUDIT-RENDER-01: audit row job_id must match the started job"
    );
    assert_eq!(
      audits[0].3, "de",
      "INV-PDF-AUDIT-RENDER-01: audit row locale must round-trip the input"
    );
    assert_eq!(
      audits[0].4, "1.0.0",
      "INV-PDF-AUDIT-RENDER-01: audit row template_version must round-trip from pdf_templates"
    );
    assert!(
      !audits[0].2.is_empty(),
      "INV-PDF-AUDIT-RENDER-01: render_appearance_hash must persist the effective Theme DB snapshot hash"
    );
    assert_eq!(
      audits[0].5.get("theme_slug").and_then(Value::as_str),
      Some("stuttgart"),
      "INV-PDF-AUDIT-RENDER-01: render audit must record the effective default theme slug"
    );
    assert!(
      audits[0].5.get("document_branding").is_some(),
      "INV-PDF-AUDIT-RENDER-01: render audit must include effective theme branding"
    );
    assert!(
      audits[0].5.get("theme_font_assets").is_some(),
      "INV-PDF-AUDIT-RENDER-01: render audit must include pinned theme font assets"
    );

    cleanup(&pool, ws, doc, tpl, alice_id).await;
    let _ = sqlx::query("DELETE FROM users WHERE id = $1")
      .bind(admin_id)
      .execute(&pool)
      .await;
  });
}

// ---------------------------------------------------------------------------
// INV-PDF-AUDIT-RENDER-03 — appearance hash changes when appearance mutates
// ---------------------------------------------------------------------------

#[test]
fn inv_audit_render03_appearance_hash_changes_when_theme_changes() {
  helpers::block_on_large_stack(
    "inv_audit_render03_appearance_hash_changes_when_theme_changes",
    || async {
      let (app, pool, auth_store) = setup_app().await;
      // `setup_pool()` seeds theme data under THEME_BRANDING_LOCK. Acquiring
      // the same lock before `setup_app()` would deadlock; acquire it after
      // setup and keep it for the mutable global-theme assertions below.
      let _guard = helpers::THEME_BRANDING_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
      let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
      let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice-render03").await;
      myoxus_infrastructure::branding::set_theme_profile(&pool, None, "stuttgart", "system", Some(admin_id))
        .await
        .expect("pin initial global theme for render-audit delta test");
      let ws = helpers::create_workspace(&pool, alice_id).await;
      let tpl = insert_template(&pool, &format!("tpl-render03-{}", Uuid::new_v4().simple()), admin_id).await;
      let doc = insert_doc(&pool, ws, alice_id).await;
      insert_doc_snapshot(&pool, ws, doc, build_pdf_doc_yjs(2)).await;
      assign(&pool, ws, tpl, admin_id).await;

      // Render #1 — default global Theme DB profile.
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
      assert!(body.get("errors").is_none(), "render #1 must succeed: {body}");

      let set_theme = helpers::gql(
        &app,
        admin_session,
        json!({
          "query": r#"
          mutation SetTheme($input: SetThemeProfileInput!) {
            admin {
              setThemeProfile(input: $input) {
                themeMode
                theme { slug }
              }
            }
          }
        "#,
          "variables": {
            "input": { "themeSlug": "hamburg", "themeMode": "dark" }
          }
        }),
      )
      .await;
      assert!(
        set_theme.get("errors").is_none(),
        "setThemeProfile must update the effective Theme DB profile before render #2: {set_theme}"
      );
      assert_eq!(
        set_theme["data"]["admin"]["setThemeProfile"]["theme"]["slug"], "hamburg",
        "render #2 must use the mutated global profile"
      );

      // Render #2 — must hit a fresh job because the options_hash factors in
      // template_id which is unchanged, but the idempotency window is 60 s. To
      // sidestep idempotency we change the doc fixture (insert a second
      // doc-snapshot with different content); easier path: render against a
      // second doc.
      let doc2 = insert_doc(&pool, ws, alice_id).await;
      insert_doc_snapshot(&pool, ws, doc2, build_pdf_doc_yjs(3)).await;

      let body2 = helpers::gql(
        &app,
        alice_session,
        json!({
          "query": "mutation Start($input: PdfExportInputV2Input!) { exportPdf(input: $input) { id status } }",
          "variables": {
            "input": {
              "workspaceId": ws.to_string(),
              "docId": doc2.to_string(),
              "templateId": tpl.to_string(),
            }
          }
        }),
      )
      .await;
      assert!(body2.get("errors").is_none(), "render #2 must succeed: {body2}");

      let audits = render_audits_for_actor(&pool, alice_id).await;
      assert_eq!(audits.len(), 2, "exactly two audit rows expected");
      let h1 = &audits[0].2;
      let h2 = &audits[1].2;
      assert_ne!(
        h1, h2,
        "INV-PDF-AUDIT-RENDER-03: render appearance hash must differ after the effective Theme DB profile changed between renders"
      );
      assert_eq!(
        audits[0].5.get("theme_slug").and_then(Value::as_str),
        Some("stuttgart"),
        "INV-PDF-AUDIT-RENDER-03: render #1 must snapshot the default global theme"
      );
      assert_eq!(
        audits[1].5.get("theme_slug").and_then(Value::as_str),
        Some("hamburg"),
        "INV-PDF-AUDIT-RENDER-03: render #2 must snapshot the updated global theme"
      );

      // Cleanup both docs.
      myoxus_infrastructure::branding::set_theme_profile(&pool, None, "stuttgart", "system", Some(admin_id))
        .await
        .expect("reset global theme after audit test");
      let _ = sqlx::query("DELETE FROM doc_snapshots WHERE doc_id = $1")
        .bind(doc2)
        .execute(&pool)
        .await;
      let _ = sqlx::query("DELETE FROM docs WHERE id = $1")
        .bind(doc2)
        .execute(&pool)
        .await;
      cleanup(&pool, ws, doc, tpl, alice_id).await;
      let _ = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(admin_id)
        .execute(&pool)
        .await;
    },
  );
}
