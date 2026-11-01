// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-PDF-TPL-10-{05,06} integration tests for the workspace-scoped read-only
//! PDF surface (`availablePdfTemplates`, `documentBrandingProfile`,
//! `pdfExportSettings`).
//!
//! Invariants:
//!
//! - INV-WS-PDF-01 (`P-PDF-TPL-10-05`):
//!   `availablePdfTemplates` only returns templates that are explicitly
//!   assigned to the calling user's workspace. Templates assigned to
//!   another workspace must never leak through, and unassigned templates
//!   in the global registry must be invisible.
//! - INV-WS-PDF-02 (`P-PDF-TPL-10-06`):
//!   `documentBrandingProfile` and `pdfExportSettings` reject non-members
//!   with an `ActionForbidden`-shaped GraphQL error. Members of the same
//!   workspace see the row (or the empty default).
//!
//! Setup builds a router whose [`ApiState`] has the production
//! [`PgPdfTemplateRepository`], [`PgPdfWorkspaceTemplateAssignmentRepository`],
//! and [`PgPdfWorkspaceBrandAssetRepository`] wired in, so the resolvers
//! roundtrip through real SQLx code paths.

#![allow(clippy::too_many_lines)]

use crate::helpers;
use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use myoxus_domain::entities::{PdfTemplate, PdfWorkspaceBrandAsset};
use myoxus_domain::repositories::PdfWorkspaceBrandAssetRepository;
use myoxus_infrastructure::pdf_export::{
  PgPdfTemplateRepository, PgPdfWorkspaceBrandAssetRepository, PgPdfWorkspaceTemplateAssignmentRepository,
};
use myoxus_infrastructure::storage::StorageAdapter;

// ---------------------------------------------------------------------------
// Test app builder with workspace-scoped PDF services wired
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
  let config = AppConfig::load().expect("config");

  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage_adapter = Arc::new(StorageAdapter::new_fs("./test-storage").expect("storage"));
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
  .with_pdf_brand_repo(brand_repo);

  (build_router(state), pool, auth_store)
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/// Insert a minimal `pdf_templates` row with a single capability so the test
/// can assert that the `capabilities` JSON survives the resolver round-trip.
async fn insert_template(pool: &PgPool, slug: &str, name: &str, created_by: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  let manifest = json!({
    "schema_version": "2.0",
    "id": slug,
    "name": name,
    "description": "Workspace read-only PDF test fixture.",
    "version": "1.0.0",
    "engine": { "name": "typst", "version": "0.15.x" },
    "provenance": {
      "license_spdx": "AGPL-3.0-or-later",
      "copyright_notice": "Copyright 2026 Myoxus test contributors",
      "source_url": "https://example.test/templates/workspace-readonly",
      "source_revision": "1.0.0"
    },
    "entry": "main.typ",
    "assets": ["main.typ"],
    "capabilities": {
      "coverPage": { "kind": "boolean", "default": false }
    },
    "inputs_schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["title"],
      "properties": {
        "title": { "type": "string", "minLength": 1 }
      }
    }
  });
  let template = PdfTemplate {
    id,
    slug: slug.to_string(),
    name: name.to_string(),
    version: "1.0.0".to_string(),
    schema_version: "2.0".to_string(),
    manifest,
    created_by: Some(created_by),
    created_at: chrono::Utc::now(),
    deleted_at: None,
  };
  // PdfTemplateRepository::create demands a non-empty file slice; insert
  // directly to keep the fixture path simple.
  sqlx::query(
    r#"INSERT INTO pdf_templates (id, slug, name, version, schema_version, manifest, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())"#,
  )
  .bind(template.id)
  .bind(&template.slug)
  .bind(&template.name)
  .bind(&template.version)
  .bind(&template.schema_version)
  .bind(&template.manifest)
  .bind(template.created_by)
  .execute(pool)
  .await
  .expect("insert pdf_templates row");
  id
}

async fn assign_template(pool: &PgPool, ws: Uuid, tpl: Uuid, assigner: Uuid, is_default: bool) {
  sqlx::query(
    r#"INSERT INTO pdf_workspace_template_assignments
        (workspace_id, template_id, is_default, assigned_by, assigned_at)
       VALUES ($1, $2, $3, $4, now())"#,
  )
  .bind(ws)
  .bind(tpl)
  .bind(is_default)
  .bind(assigner)
  .execute(pool)
  .await
  .expect("assign template");
}

async fn upsert_brand(pool: &PgPool, ws: Uuid, default_template_id: Uuid, updated_by: Uuid) {
  let asset = PdfWorkspaceBrandAsset {
    workspace_id: ws,
    logo_large_blob: None,
    logo_large_sha256: None,
    logo_small_blob: None,
    logo_small_sha256: None,
    company_name: Some("Acme GmbH".to_string()),
    legal_text: Some("Acme GmbH".to_string()),
    footer_text: Some("Strictly confidential".to_string()),
    color_policy: "custom".to_string(),
    color_palette_key: None,
    brand_color_primary: Some("#0044AA".to_string()),
    brand_color_accent: Some("#FF8800".to_string()),
    brand_color_rule: Some("#FF8800".to_string()),
    brand_color_text: Some("#333333".to_string()),
    brand_color_background: Some("#ffffff".to_string()),
    default_paper_size: Some("A4".to_string()),
    default_locale: Some("de".to_string()),
    default_color_profile: Some("sRGB".to_string()),
    default_image_quality: Some("high".to_string()),
    ligatures_enabled: true,
    default_template_id: Some(default_template_id),
    updated_at: chrono::Utc::now(),
    updated_by,
  };
  let repo = PgPdfWorkspaceBrandAssetRepository::new(pool.clone());
  repo
    .set_document_branding_text(ws, asset.footer_text.clone(), updated_by, asset.updated_at, None)
    .await
    .expect("document branding text upsert");
  repo
    .set_document_branding_colors(
      ws,
      asset.brand_color_primary.clone(),
      asset.brand_color_accent.clone(),
      updated_by,
      asset.updated_at,
      None,
    )
    .await
    .expect("document branding colors upsert");
  repo
    .upsert_pdf_export_settings(
      &myoxus_domain::repositories::PdfExportSettingsPatch::replace(&asset),
      None,
    )
    .await
    .expect("pdf export settings upsert");
}

async fn cleanup_workspace(pool: &PgPool, ws: Uuid) {
  // brand assets and assignments have FKs to workspaces, drop them first
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
  let _ = sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
    .bind(ws)
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
}

async fn cleanup_template(pool: &PgPool, tpl: Uuid) {
  let _ = sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE template_id = $1")
    .bind(tpl)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
    .bind(tpl)
    .execute(pool)
    .await;
}

async fn cleanup_user(pool: &PgPool, user_id: Uuid) {
  let _ = sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user_id)
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

// ---------------------------------------------------------------------------
// INV-WS-PDF-01 — assigned-only template filtering
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_ws_pdf_01_user_only_sees_assigned_templates() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, _admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice").await;
  let (bobby_id, _bobby_session) = helpers::seed_user(&pool, &auth_store, "bobby").await;

  let ws_alpha = helpers::create_workspace(&pool, alice_id).await;
  let ws_beta = helpers::create_workspace(&pool, bobby_id).await;

  let tpl_alpha_only = insert_template(&pool, "tpl-alpha-only", "Alpha Only", admin_id).await;
  let tpl_beta_only = insert_template(&pool, "tpl-beta-only", "Beta Only", admin_id).await;
  let tpl_unassigned = insert_template(&pool, "tpl-unassigned", "Unassigned", admin_id).await;

  // Each workspace already owns its canonical system default. Add one custom
  // assignment per workspace and keep another custom template unassigned.
  assign_template(&pool, ws_alpha, tpl_alpha_only, admin_id, false).await;
  assign_template(&pool, ws_beta, tpl_beta_only, admin_id, false).await;

  let body = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "query Q($ws: ID!) { availablePdfTemplates(workspaceId: $ws) { id slug name version capabilities inputsSchema isDefault } }",
      "variables": { "ws": ws_alpha.to_string() }
    }),
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "INV-WS-PDF-01: alice as alpha member must read templates: {body}"
  );
  let templates = body
    .pointer("/data/availablePdfTemplates")
    .and_then(|v| v.as_array())
    .cloned()
    .expect("availablePdfTemplates array");

  assert_eq!(
    templates.len(),
    2,
    "INV-WS-PDF-01: system default plus alpha assignment expected — got {templates:?}"
  );
  let row = templates
    .iter()
    .find(|template| template.pointer("/id").and_then(Value::as_str) == Some(tpl_alpha_only.to_string().as_str()))
    .expect("alpha-only template");
  assert_eq!(
    row.pointer("/id").and_then(|v| v.as_str()),
    Some(tpl_alpha_only.to_string().as_str())
  );
  assert_eq!(row.pointer("/slug").and_then(|v| v.as_str()), Some("tpl-alpha-only"));
  assert_eq!(row.pointer("/isDefault").and_then(|v| v.as_bool()), Some(false));
  // Capability JSON survives the round-trip.
  assert_eq!(
    row.pointer("/capabilities/coverPage/kind").and_then(|v| v.as_str()),
    Some("boolean"),
    "INV-WS-PDF-01: capabilities JSON must round-trip"
  );
  assert_eq!(
    row.pointer("/inputsSchema/required/0").and_then(|v| v.as_str()),
    Some("title"),
    "INV-WS-PDF-01: inputs_schema JSON must round-trip so the export dialog can prefill typed inputs"
  );
  // Crucially: tpl_beta_only and tpl_unassigned must NOT appear.
  for forbidden in [tpl_beta_only, tpl_unassigned] {
    let leaked = templates
      .iter()
      .any(|t| t.pointer("/id").and_then(|v| v.as_str()) == Some(forbidden.to_string().as_str()));
    assert!(
      !leaked,
      "INV-WS-PDF-01: template {forbidden} must not leak across workspaces"
    );
  }

  // Cleanup — drop assignments + templates + workspaces + users.
  cleanup_workspace(&pool, ws_alpha).await;
  cleanup_workspace(&pool, ws_beta).await;
  for tpl in [tpl_alpha_only, tpl_beta_only, tpl_unassigned] {
    cleanup_template(&pool, tpl).await;
  }
  for uid in [alice_id, bobby_id, admin_id] {
    cleanup_user(&pool, uid).await;
  }
}

// ---------------------------------------------------------------------------
// INV-WS-PDF-02 — non-member cannot see brand assets / settings
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_ws_pdf_02_non_member_cannot_see_brand_assets() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, _admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, alice_session) = helpers::seed_user(&pool, &auth_store, "alice").await;
  let (bobby_id, bobby_session) = helpers::seed_user(&pool, &auth_store, "bobby").await;

  // Alice's workspace, with a configured brand-asset row pointing at a
  // template that Alice can use.
  let ws_alpha = helpers::create_workspace(&pool, alice_id).await;
  let tpl = insert_template(&pool, "tpl-brand", "Brand Tpl", admin_id).await;
  assign_template(&pool, ws_alpha, tpl, admin_id, false).await;
  upsert_brand(&pool, ws_alpha, tpl, alice_id).await;

  // Member sees the document-branding row and its derived settings.
  let member_brand = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "query Q($ws: ID!) { documentBrandingProfile(workspaceId: $ws) { workspaceId footerText brandColorPrimary brandColorAccent } }",
      "variables": { "ws": ws_alpha.to_string() }
    }),
  )
  .await;
  assert!(
    member_brand.get("errors").is_none(),
    "INV-WS-PDF-02: member must read document branding: {member_brand}"
  );
  assert_eq!(
    member_brand
      .pointer("/data/documentBrandingProfile/footerText")
      .and_then(|v| v.as_str()),
    Some("Strictly confidential")
  );
  assert_eq!(
    member_brand
      .pointer("/data/documentBrandingProfile/brandColorPrimary")
      .and_then(|v| v.as_str()),
    Some("#0044aa")
  );

  let member_settings = helpers::gql(
    &app,
    alice_session,
    json!({
      "query": "query Q($ws: ID!) { pdfExportSettings(workspaceId: $ws) { defaultTemplateId defaultLocale defaultPaperSize defaultColorProfile defaultImageQuality ligaturesEnabled } }",
      "variables": { "ws": ws_alpha.to_string() }
    }),
  )
  .await;
  assert!(
    member_settings.get("errors").is_none(),
    "INV-WS-PDF-02: member must read pdf export settings: {member_settings}"
  );
  assert_eq!(
    member_settings
      .pointer("/data/pdfExportSettings/defaultLocale")
      .and_then(|v| v.as_str()),
    Some("de")
  );
  assert_eq!(
    member_settings
      .pointer("/data/pdfExportSettings/defaultTemplateId")
      .and_then(|v| v.as_str()),
    Some(tpl.to_string().as_str())
  );

  // Bobby is a different user with no membership in alpha — both queries
  // must be rejected.
  let bobby_brand = helpers::gql(
    &app,
    bobby_session,
    json!({
      "query": "query Q($ws: ID!) { documentBrandingProfile(workspaceId: $ws) { workspaceId } }",
      "variables": { "ws": ws_alpha.to_string() }
    }),
  )
  .await;
  let bobby_brand_errors = errors_array(&bobby_brand);
  assert!(
    !bobby_brand_errors.is_empty(),
    "INV-WS-PDF-02: non-member must be rejected on documentBrandingProfile: {bobby_brand}"
  );
  // `data` must not contain the asset.
  assert!(
    bobby_brand
      .pointer("/data/documentBrandingProfile")
      .map(|v| v.is_null())
      .unwrap_or(true),
    "INV-WS-PDF-02: data must not leak when forbidden: {bobby_brand}"
  );

  let bobby_settings = helpers::gql(
    &app,
    bobby_session,
    json!({
      "query": "query Q($ws: ID!) { pdfExportSettings(workspaceId: $ws) { defaultLocale } }",
      "variables": { "ws": ws_alpha.to_string() }
    }),
  )
  .await;
  let bobby_settings_errors = errors_array(&bobby_settings);
  assert!(
    !bobby_settings_errors.is_empty(),
    "INV-WS-PDF-02: non-member must be rejected on pdfExportSettings: {bobby_settings}"
  );

  let bobby_templates = helpers::gql(
    &app,
    bobby_session,
    json!({
      "query": "query Q($ws: ID!) { availablePdfTemplates(workspaceId: $ws) { id } }",
      "variables": { "ws": ws_alpha.to_string() }
    }),
  )
  .await;
  let bobby_templates_errors = errors_array(&bobby_templates);
  assert!(
    !bobby_templates_errors.is_empty(),
    "INV-WS-PDF-02: non-member must be rejected on availablePdfTemplates: {bobby_templates}"
  );

  // Cleanup
  cleanup_workspace(&pool, ws_alpha).await;
  cleanup_template(&pool, tpl).await;
  for uid in [alice_id, bobby_id, admin_id] {
    cleanup_user(&pool, uid).await;
  }
}
