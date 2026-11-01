// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-PDF-TPL-09-{08..10} integration tests for the workspace document-branding
//! admin GraphQL surface.
//!
//! Upload and branding invariants:
//!
//! - INV-PDF-GQL-08 (`P-PDF-TPL-09-08`):
//!   `uploadDocumentBrandLogo` round-trips an SVG payload through the
//!   [`sanitize_svg`] AST sanitiser before writing the blob, so
//!   `<script>` blocks, on-* handlers, and other XSS vectors never reach
//!   storage. The test uploads an SVG that bundles a script tag and an
//!   inline event handler, fetches the persisted blob from the
//!   `StorageAdapter`'s opendal operator, and asserts none of the
//!   dangerous substrings remain.
//! - INV-PDF-GQL-09 (`P-PDF-TPL-09-09`):
//!   `updateDocumentBrandingColors` rejects every literal that is not a 7-character
//!   `#RRGGBB` hex value. A free-form colour name (`"red"`), a 4-character
//!   short form (`"#FFF"`), and a literal with non-hex digits (`"#GGHHII"`)
//!   all fail validation; the document-branding row stays at its default state
//!   (`custom_primary_color IS NULL`).
//! - INV-PDF-GQL-10 (`P-PDF-TPL-09-10`):
//!   An upload that overshoots `pdf_export.max_brand_asset_size_mb` is
//!   rejected with a "size limit" error, and **no blob is written** to
//!   storage. The cap is enforced at read time so an attacker cannot DoS
//!   the server with an unbounded multipart payload.
//!
//! These cases wire the production [`PgPdfWorkspaceBrandAssetRepository`]
//! and a real [`PdfBlobStore`] backed by a per-test filesystem-scoped
//! [`StorageAdapter`] so the upload round-trips through actual SQLx + opendal
//! code paths. The audit recorder is the real [`PgAuditLogStore`] so the
//! audit-trail invariants survive any future schema migration.

#![allow(clippy::too_many_lines)]

use crate::helpers;
use futures_util::FutureExt;
use std::sync::Arc;

use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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
// Test app builder with document-branding services + blob store wired
// ---------------------------------------------------------------------------

async fn setup_app() -> (
  axum::Router,
  PgPool,
  Arc<myoxus_infrastructure::auth::SqlxAuthStore>,
  Arc<StorageAdapter>,
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
  let config = AppConfig::load().expect("config");

  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  // A fresh per-test directory so concurrent runs do not see each other's blobs.
  let storage_dir = tempfile::tempdir().expect("temporary branding storage");
  let storage_adapter =
    Arc::new(StorageAdapter::new_fs(storage_dir.path().to_str().expect("UTF-8 path")).expect("storage"));
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
  .with_pdf_template_repo(Arc::new(PgPdfTemplateRepository::new(pool.clone())))
  .with_pdf_assignment_repo(Arc::new(PgPdfWorkspaceTemplateAssignmentRepository::new(pool.clone())))
  .with_pdf_brand_repo(brand_repo)
  .with_pdf_blob_store(pdf_blob_store)
  .with_audit_recorder(audit_recorder);

  (build_router(state), pool, auth_store, storage_adapter, storage_dir)
}

// ---------------------------------------------------------------------------
// Multipart helper for `uploadDocumentBrandLogo`
// ---------------------------------------------------------------------------

/// POST a GraphQL multipart request that calls `uploadDocumentBrandLogo`. Returns the
/// parsed JSON body. `kind` is the GraphQL enum literal `"Large"` or `"Small"`.
async fn upload_document_brand_logo(
  app: &axum::Router,
  session_id: Uuid,
  workspace_id: Uuid,
  kind: &str,
  filename: &str,
  content_type: &str,
  bytes: &[u8],
) -> Value {
  let boundary = "X-BOUNDARY-PDF-BRAND-UPLOAD";
  let operations = json!({
    "query": "mutation Up($ws: ID!, $kind: BrandLogoKind!, $file: Upload!) { \
      admin { \
        uploadDocumentBrandLogo(workspaceId: $ws, kind: $kind, file: $file) { \
          workspaceId logoLargeBlob logoSmallBlob \
        } \
      } \
    }",
    "variables": {
      "ws": workspace_id.to_string(),
      "kind": kind,
      "file": null
    }
  })
  .to_string();
  let map = json!({ "0": ["variables.file"] }).to_string();

  let mut body = Vec::new();
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"operations\"\r\n\r\n");
  body.extend_from_slice(operations.as_bytes());
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"map\"\r\n\r\n");
  body.extend_from_slice(map.as_bytes());
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(format!("Content-Disposition: form-data; name=\"0\"; filename=\"{filename}\"\r\n").as_bytes());
  body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
  body.extend_from_slice(bytes);
  body.extend_from_slice(b"\r\n");
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

async fn cleanup_workspace(pool: &PgPool, ws: Uuid) {
  sqlx::query("DELETE FROM pdf_export_settings WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await
    .expect("remove owned test rows");
  sqlx::query("DELETE FROM document_brand_profiles WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await
    .expect("remove owned test rows");
  sqlx::query("DELETE FROM brand_assets WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await
    .expect("remove owned test rows");
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await
    .expect("remove owned test rows");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws)
    .execute(pool)
    .await
    .expect("remove owned test rows");
}

async fn cleanup_user(pool: &PgPool, user_id: Uuid) {
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("remove owned test rows");
  sqlx::query("DELETE FROM sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("remove owned test rows");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("remove owned test rows");
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-08 — uploaded SVG is sanitised before storage
// ---------------------------------------------------------------------------

#[test]
fn inv_gql08_upload_logo_sanitizes_svg() {
  helpers::block_on_large_stack("inv-gql08-upload-logo-sanitizes-svg", || async {
    let (app, pool, auth_store, storage_adapter, _storage_dir) = setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice").await;

    let ws = helpers::create_workspace(&pool, alice_id).await;

    // Hand-crafted SVG that bundles every XSS vector we promise to strip:
    //   - inline `<script>` block
    //   - `onload` event handler on the root
    //   - `onclick` on a child element
    //   - `xlink:href="javascript:..."` on an `<a>` link
    //   - `<foreignObject>` containing HTML
    let dirty_svg = br##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert('root')">
    <script>alert('xss-hell')</script>
    <rect width="10" height="10" onclick="alert('rect')" fill="#0000ff"/>
    <a xlink:href="javascript:alert('link')"><circle cx="5" cy="5" r="3"/></a>
    <foreignObject width="10" height="10">
      <body xmlns="http://www.w3.org/1999/xhtml"><script>alert('inside')</script></body>
    </foreignObject>
  </svg>"##;

    let resp =
      upload_document_brand_logo(&app, admin_session, ws, "Large", "logo.svg", "image/svg+xml", dirty_svg).await;
    assert!(
      resp.get("errors").is_none(),
      "INV-PDF-GQL-08: upload of dirty-but-parseable svg must succeed: {resp}"
    );

    let blob_key = resp
      .pointer("/data/admin/uploadDocumentBrandLogo/logoLargeBlob")
      .and_then(|v| v.as_str())
      .expect("logoLargeBlob path on response")
      .to_string();
    assert!(
      blob_key.starts_with(&format!("pdf-brand/{ws}/")) && blob_key.ends_with("/large.svg"),
      "INV-PDF-GQL-08: blob key must be operation-owned under pdf-brand/<ws>/<operation>/large.svg, got {blob_key}"
    );

    // Pull the persisted blob back from storage and assert no XSS substring made it through.
    let stored = storage_adapter
      .operator()
      .read(&blob_key)
      .await
      .expect("read sanitised blob");
    let stored_str = std::str::from_utf8(stored.to_vec().as_slice())
      .expect("usvg always emits UTF-8")
      .to_string();

    for forbidden in ["script", "alert", "onload", "onclick", "javascript:", "foreignObject"] {
      assert!(
        !stored_str.contains(forbidden),
        "INV-PDF-GQL-08: sanitised svg must not contain '{forbidden}'\nstored:\n{stored_str}"
      );
    }
    // Sanity: it is still a non-trivial SVG. usvg normalises `<rect>` / `<circle>`
    // into `<path>` elements during the AST round-trip, so we check for any
    // rendering element instead of the original tag names.
    assert!(stored_str.contains("<svg"), "must still be an svg");
    assert!(
      stored_str.contains("<path") || stored_str.contains("<rect") || stored_str.contains("<circle"),
      "must preserve at least one rendering element after sanitisation: {stored_str}"
    );
    let mut hasher = Sha256::new();
    hasher.update(stored.to_vec().as_slice());
    let expected_sha = format!("{:x}", hasher.finalize());
    let stored_sha: String = sqlx::query_scalar(
      "SELECT sha256 FROM brand_assets WHERE scope = 'workspace' AND workspace_id = $1 AND slot = 'logo' AND variant = 'large' AND quality_class = 'print'",
    )
    .bind(ws)
    .fetch_one(&pool)
    .await
    .expect("read persisted document-logo sha256");
    assert_eq!(
      stored_sha, expected_sha,
      "INV-PDF-GQL-08: logo audit/idempotency hash must track uploaded bytes, not the stable storage key"
    );

    // Cleanup
    let _ = storage_adapter.operator().delete(&blob_key).await;
    cleanup_workspace(&pool, ws).await;
    for uid in [alice_id, admin_id] {
      cleanup_user(&pool, uid).await;
    }
  });
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-09 — non-`#RRGGBB` colour literals are refused
// ---------------------------------------------------------------------------

#[test]
fn inv_gql09_invalid_color_hex_rejected() {
  helpers::block_on_large_stack("inv-gql09-invalid-color-hex-rejected", || async {
    let (app, pool, auth_store, _storage, _storage_dir) = setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice").await;

    let ws = helpers::create_workspace(&pool, alice_id).await;

    for bad in ["red", "#FFF", "#GGHHII", "rgb(0,0,0)", "#1234567"] {
      let body = helpers::gql(
        &app,
        admin_session,
        json!({
          "query": "mutation M($ws: ID!, $p: String, $a: String) { admin { updateDocumentBrandingColors(workspaceId: $ws, primary: $p, accent: $a) { workspaceId brandColorPrimary } } }",
          "variables": { "ws": ws.to_string(), "p": bad, "a": "#112233" }
        }),
      )
      .await;
      let errs = errors_array(&body);
      assert!(
        !errs.is_empty(),
        "INV-PDF-GQL-09: malformed color literal '{bad}' must be rejected: {body}"
      );
      assert!(
        errs.iter().any(|m| m.contains("color must be")),
        "INV-PDF-GQL-09: error message must explain the format requirement, got {errs:?}"
      );
    }

    let partial = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($ws: ID!, $p: String) { admin { updateDocumentBrandingColors(workspaceId: $ws, primary: $p) { workspaceId brandColorPrimary } } }",
        "variables": { "ws": ws.to_string(), "p": "#0a1bff" }
      }),
    )
    .await;
    let partial_errors = errors_array(&partial);
    assert!(
      partial_errors.iter().any(|m| m.contains("both primary and accent")),
      "INV-PDF-GQL-09: one-sided custom colours must be rejected: {partial}"
    );

    // After all rejections the document-branding row must still be in its default
    // state — i.e. either no row at all (preferred — never written) or a row
    // with `custom_primary_color IS NULL`.
    let stored: Option<Option<String>> =
      sqlx::query_scalar("SELECT custom_primary_color FROM document_brand_profiles WHERE workspace_id = $1")
        .bind(ws)
        .fetch_optional(&pool)
        .await
        .expect("read custom_primary_color");
    match stored {
      None => { /* nothing written — perfect */ }
      Some(inner) => assert!(
        inner.is_none(),
        "INV-PDF-GQL-09: rejected colour update must not write a value, got {inner:?}"
      ),
    }

    // The same mutation with a valid lower-case literal must succeed and
    // round-trip (proves the rejection above is real validation, not a typo).
    let ok = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($ws: ID!, $p: String, $a: String) { admin { updateDocumentBrandingColors(workspaceId: $ws, primary: $p, accent: $a) { brandColorPrimary brandColorAccent } } }",
        "variables": { "ws": ws.to_string(), "p": "#0a1bff", "a": "#ffcc00" }
      }),
    )
    .await;
    assert!(
      ok.get("errors").is_none(),
      "INV-PDF-GQL-09: a valid #RRGGBB literal must succeed: {ok}"
    );
    assert_eq!(
      ok.pointer("/data/admin/updateDocumentBrandingColors/brandColorPrimary")
        .and_then(|v| v.as_str()),
      Some("#0a1bff")
    );
    assert_eq!(
      ok.pointer("/data/admin/updateDocumentBrandingColors/brandColorAccent")
        .and_then(|v| v.as_str()),
      Some("#ffcc00")
    );

    cleanup_workspace(&pool, ws).await;
    for uid in [alice_id, admin_id] {
      cleanup_user(&pool, uid).await;
    }
  });
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-10 — over-cap upload rejected, no blob written
// ---------------------------------------------------------------------------

#[test]
fn inv_gql10_oversized_logo_rejected_with_size_limit_error() {
  helpers::block_on_large_stack("inv-gql10-oversized-logo", || async {
    let (app, pool, auth_store, storage_adapter, _storage_dir) = setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice").await;

    let ws = helpers::create_workspace(&pool, alice_id).await;

    // Default cap is 8 MiB. Build a 9 MiB PNG (correct magic header, the rest
    // is junk — `read_upload_capped` enforces the size cap before format
    // detection, so a malformed PNG triggers the same path as a real one).
    let mut oversized = Vec::with_capacity(9 * 1_048_576);
    oversized.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    oversized.resize(9 * 1_048_576, 0xAB);

    let resp = upload_document_brand_logo(&app, admin_session, ws, "Large", "huge.png", "image/png", &oversized).await;
    let errs = errors_array(&resp);
    assert!(
      !errs.is_empty(),
      "INV-PDF-GQL-10: oversized upload must be rejected: {resp}"
    );
    assert!(
      errs.iter().any(|m| m.contains("size limit")),
      "INV-PDF-GQL-10: error must mention the size limit, got {errs:?}"
    );

    let entries = storage_adapter
      .operator()
      .list_with("pdf-brand/")
      .recursive(true)
      .await
      .expect("list branding storage");
    assert!(
      entries.iter().all(|entry| !entry.metadata().mode().is_file()),
      "oversized upload must write no file at any operation key"
    );

    // No row may have been written for this workspace either.
    let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_brand_profiles WHERE workspace_id = $1")
      .bind(ws)
      .fetch_one(&pool)
      .await
      .expect("count document-branding rows");
    assert_eq!(
      row_count, 0,
      "INV-PDF-GQL-10: rejected upload must not create a document-branding row"
    );

    cleanup_workspace(&pool, ws).await;
    for uid in [alice_id, admin_id] {
      cleanup_user(&pool, uid).await;
    }
  });
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-11 — document color palettes come from the effective theme
// ---------------------------------------------------------------------------

#[test]
fn inv_gql11_document_brand_color_palettes_are_server_resolved() {
  helpers::block_on_large_stack("inv-gql11-document-brand-palettes", || async {
    let (app, pool, auth_store, _storage_adapter, _storage_dir) = setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice").await;
    let ws = helpers::create_workspace(&pool, alice_id).await;

    let resp = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "query Q($ws: ID!) { admin { documentBrandColorPalettes(workspaceId: $ws) { themeSlug themeName paletteKey name primaryColor accentColor ruleColor textColor backgroundColor isDefault } } }",
        "variables": { "ws": ws.to_string() }
      }),
    )
    .await;
    assert!(
      resp.get("errors").is_none(),
      "INV-PDF-GQL-11: palette query must not error: {resp}"
    );
    let palettes = resp
      .pointer("/data/admin/documentBrandColorPalettes")
      .and_then(|v| v.as_array())
      .expect("palettes array");
    assert!(
      palettes.len() >= 4,
      "INV-PDF-GQL-11: every theme must expose the reduced document palette set: {palettes:?}"
    );
    let default_count = palettes
      .iter()
      .filter(|p| p.get("isDefault").and_then(|v| v.as_bool()) == Some(true))
      .count();
    assert_eq!(
      default_count, 1,
      "INV-PDF-GQL-11: exactly one palette may be the server-side default"
    );
    for key in ["balanced", "muted", "accent_line", "plain"] {
      assert!(
        palettes
          .iter()
          .any(|p| p.get("paletteKey").and_then(|v| v.as_str()) == Some(key)),
        "INV-PDF-GQL-11: missing required palette key {key}: {palettes:?}"
      );
    }
    for palette in palettes {
      for field in [
        "primaryColor",
        "accentColor",
        "ruleColor",
        "textColor",
        "backgroundColor",
      ] {
        let color = palette.get(field).and_then(|v| v.as_str()).expect("color");
        assert!(
          color.starts_with('#') && color.len() == 7,
          "INV-PDF-GQL-11: {field} must be a #RRGGBB color, got {color}"
        );
      }
    }

    cleanup_workspace(&pool, ws).await;
    for uid in [alice_id, admin_id] {
      cleanup_user(&pool, uid).await;
    }
  });
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-13 — policy selection keeps theme palettes referenced by key
// ---------------------------------------------------------------------------

#[test]
fn inv_gql13_document_brand_color_policy_roundtrips_palette_and_plain() {
  helpers::block_on_large_stack("inv-gql13-document-brand-policy", || async {
    let (app, pool, auth_store, _storage_adapter, _storage_dir) = setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice").await;
    let ws = helpers::create_workspace(&pool, alice_id).await;

    let set_mutation = "mutation M($ws: ID!, $policy: DocumentBrandColorPolicy!, $key: String!) { admin { setDocumentBrandingColorPolicy(workspaceId: $ws, policy: $policy, paletteKey: $key) { colorPolicy colorPaletteKey brandColorPrimary brandColorAccent brandColorRule brandColorText brandColorBackground } } }";

    let muted = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": set_mutation,
        "variables": { "ws": ws.to_string(), "policy": "theme_palette", "key": "muted" }
      }),
    )
    .await;
    assert!(
      muted.get("errors").is_none(),
      "INV-PDF-GQL-13: selecting a named theme palette must succeed: {muted}"
    );
    assert_eq!(
      muted
        .pointer("/data/admin/setDocumentBrandingColorPolicy/colorPolicy")
        .and_then(|v| v.as_str()),
      Some("theme_palette")
    );
    assert_eq!(
      muted
        .pointer("/data/admin/setDocumentBrandingColorPolicy/colorPaletteKey")
        .and_then(|v| v.as_str()),
      Some("muted")
    );
    let custom_count: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM document_brand_profiles WHERE workspace_id = $1 AND custom_primary_color IS NULL AND custom_accent_color IS NULL",
    )
    .bind(ws)
    .fetch_one(&pool)
    .await
    .expect("count custom color columns");
    assert_eq!(
      custom_count, 1,
      "INV-PDF-GQL-13: palette selection must not duplicate theme colours into custom columns"
    );

    let plain = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": set_mutation,
        "variables": { "ws": ws.to_string(), "policy": "plain", "key": "plain" }
      }),
    )
    .await;
    assert!(
      plain.get("errors").is_none(),
      "INV-PDF-GQL-13: selecting plain document colours must succeed: {plain}"
    );
    assert_eq!(
      plain
        .pointer("/data/admin/setDocumentBrandingColorPolicy/colorPolicy")
        .and_then(|v| v.as_str()),
      Some("plain")
    );
    assert_eq!(
      plain
        .pointer("/data/admin/setDocumentBrandingColorPolicy/colorPaletteKey")
        .and_then(|v| v.as_str()),
      Some("plain")
    );

    let invalid = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": set_mutation,
        "variables": { "ws": ws.to_string(), "policy": "theme_palette", "key": "plain" }
      }),
    )
    .await;
    let errs = errors_array(&invalid);
    assert!(
      errs.iter().any(|message| message.contains("plain is its own")),
      "INV-PDF-GQL-13: theme_palette/plain ambiguity must be rejected: {invalid}"
    );

    cleanup_workspace(&pool, ws).await;
    for uid in [alice_id, admin_id] {
      cleanup_user(&pool, uid).await;
    }
  });
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-12 — reset affects document branding only, not PDF settings
// ---------------------------------------------------------------------------

#[test]
fn inv_gql12_reset_workspace_document_branding_preserves_pdf_settings() {
  helpers::block_on_large_stack("inv-gql12-reset-document-branding", || async {
    let (app, pool, auth_store, storage_adapter, _storage_dir) = setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice").await;
    let ws = helpers::create_workspace(&pool, alice_id).await;

    let png_signature_only = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    let upload = upload_document_brand_logo(
      &app,
      admin_session,
      ws,
      "Large",
      "logo.png",
      "image/png",
      &png_signature_only,
    )
    .await;
    assert!(
      upload.get("errors").is_none(),
      "INV-PDF-GQL-12: setup logo upload must succeed: {upload}"
    );

    let text_and_colors = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($ws: ID!) { admin { updateDocumentBrandingText(workspaceId: $ws, footerText: \"Workspace footer\") { workspaceId } updateDocumentBrandingColors(workspaceId: $ws, primary: \"#112233\", accent: \"#445566\") { workspaceId } } }",
        "variables": { "ws": ws.to_string() }
      }),
    )
    .await;
    assert!(
      text_and_colors.get("errors").is_none(),
      "INV-PDF-GQL-12: setup document branding mutations must succeed: {text_and_colors}"
    );

    let settings = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($ws: ID!) { admin { updatePdfExportSettings(workspaceId: $ws, paperSize: \"A4\", locale: \"de-DE\", imageQuality: \"high\", ligaturesEnabled: false) { defaultPaperSize defaultLocale defaultImageQuality ligaturesEnabled } } }",
        "variables": { "ws": ws.to_string() }
      }),
    )
    .await;
    assert!(
      settings.get("errors").is_none(),
      "INV-PDF-GQL-12: setup pdf settings mutation must succeed: {settings}"
    );

    let doc_rows_before: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM document_brand_profiles WHERE scope = 'workspace' AND workspace_id = $1",
    )
    .bind(ws)
    .fetch_one(&pool)
    .await
    .expect("count document profile rows before reset");
    assert_eq!(
      doc_rows_before, 1,
      "INV-PDF-GQL-12: setup must create one workspace document profile"
    );

    let reset = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($ws: ID!) { admin { resetWorkspaceDocumentBranding(workspaceId: $ws) { workspaceId logoLargeBlob footerText brandColorPrimary brandColorAccent } } }",
        "variables": { "ws": ws.to_string() }
      }),
    )
    .await;
    assert!(
      reset.get("errors").is_none(),
      "INV-PDF-GQL-12: reset mutation must not error: {reset}"
    );

    let doc_rows_after: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM document_brand_profiles WHERE scope = 'workspace' AND workspace_id = $1",
    )
    .bind(ws)
    .fetch_one(&pool)
    .await
    .expect("count document profile rows after reset");
    assert_eq!(
      doc_rows_after, 0,
      "INV-PDF-GQL-12: reset must remove the workspace-owned document profile"
    );

    let asset_rows_after: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM brand_assets WHERE scope = 'workspace' AND workspace_id = $1")
        .bind(ws)
        .fetch_one(&pool)
        .await
        .expect("count brand asset rows after reset");
    assert_eq!(
      asset_rows_after, 0,
      "INV-PDF-GQL-12: reset must remove unreachable workspace document-logo asset rows"
    );

    let logo_path = upload
      .pointer("/data/admin/uploadDocumentBrandLogo/logoLargeBlob")
      .and_then(Value::as_str)
      .expect("actual committed key");
    let logo_bytes = storage_adapter
      .operator()
      .read(logo_path)
      .await
      .expect("captured logo remains readable");
    assert_eq!(
      logo_bytes.to_vec(),
      png_signature_only,
      "reset must retain bytes captured by admitted exports"
    );

    let settings_after = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "query Q($ws: ID!) { admin { pdfExportSettings(workspaceId: $ws) { defaultPaperSize defaultLocale defaultImageQuality ligaturesEnabled } } }",
        "variables": { "ws": ws.to_string() }
      }),
    )
    .await;
    assert!(
      settings_after.get("errors").is_none(),
      "INV-PDF-GQL-12: settings query after reset must not error: {settings_after}"
    );
    assert_eq!(
      settings_after
        .pointer("/data/admin/pdfExportSettings/defaultPaperSize")
        .and_then(|v| v.as_str()),
      Some("A4"),
      "INV-PDF-GQL-12: reset must not touch PDF paper settings"
    );
    assert_eq!(
      settings_after
        .pointer("/data/admin/pdfExportSettings/defaultLocale")
        .and_then(|v| v.as_str()),
      Some("de-DE"),
      "INV-PDF-GQL-12: reset must not touch PDF locale settings"
    );
    assert_eq!(
      settings_after
        .pointer("/data/admin/pdfExportSettings/ligaturesEnabled")
        .and_then(|v| v.as_bool()),
      Some(false),
      "INV-PDF-GQL-12: reset must not touch PDF ligature settings"
    );

    cleanup_workspace(&pool, ws).await;
    for uid in [alice_id, admin_id] {
      cleanup_user(&pool, uid).await;
    }
  });
}

/// Every workspace PDF write must roll back with its failed audit, including
/// both default owners and replacement bytes. Concurrent uploads form one
/// locked before/after chain and retain every committed capture.
#[test]
fn workspace_pdf_mutations_are_atomic_and_logo_captures_are_immutable() {
  helpers::block_on_large_stack("pdf-workspace-atomic-audit", || async {
    let (app, pool, auth_store, storage, _storage_dir) = setup_app().await;
    let (admin, session) = helpers::seed_admin(&pool, &auth_store).await;
    let ws = helpers::create_workspace(&pool, admin).await;
    let templates = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    let constraint = format!("pdf_audit_reject_{}", ws.simple());
    let result = std::panic::AssertUnwindSafe(async {
      for id in templates {
        sqlx::query("INSERT INTO pdf_templates (id, slug, name, version, schema_version, manifest, created_by) VALUES ($1,$2,'Atomic audit','1.0.0','2.0','{}',$3)")
          .bind(id).bind(format!("atomic-{id}")).bind(admin).execute(&pool).await.expect("seed template");
      }
      let call = |fields: String| helpers::gql(&app, session, json!({"query":format!("mutation($ws:ID!){{admin{{{fields}}}}}"),"variables":{"ws":ws.to_string()}}));
      let assign = |id| format!("assignPdfTemplateToWorkspace(workspaceId:$ws,templateId:\"{id}\"){{templateId}}");
      for id in &templates[..2] {
        let response = call(assign(*id)).await;
        assert!(response.get("errors").is_none(), "assign: {response}");
      }
      let default = |id| format!("setWorkspaceDefaultPdfTemplate(workspaceId:$ws,templateId:\"{id}\"){{defaultTemplateId}}");
      let response = call(default(templates[0])).await;
      assert!(response.get("errors").is_none(), "initial default: {response}");
      // Deployed assignment defaults can predate the settings mirror.
      sqlx::query("DELETE FROM pdf_export_settings WHERE workspace_id=$1").bind(ws).execute(&pool).await.unwrap();
      let original = b"\x89PNG\r\n\x1a\noriginal";
      let upload = upload_document_brand_logo(&app,session,ws,"Large","logo.png","image/png",original).await;
      assert!(upload.get("errors").is_none(), "initial logo: {upload}");
      let old_key = upload.pointer("/data/admin/uploadDocumentBrandLogo/logoLargeBlob").and_then(Value::as_str).unwrap().to_owned();
      let snapshot = || async {
        sqlx::query_scalar::<_, Value>("SELECT jsonb_build_object('profile',(SELECT to_jsonb(p) FROM document_brand_profiles p WHERE workspace_id=$1),'settings',(SELECT to_jsonb(s) FROM pdf_export_settings s WHERE workspace_id=$1),'assets',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM brand_assets a WHERE workspace_id=$1),'assignments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY template_id) FROM pdf_workspace_template_assignments a WHERE workspace_id=$1),'audit',(SELECT count(*) FROM admin_audit_log WHERE target_id=$1::text))")
          .bind(ws).fetch_one(&pool).await.expect("snapshot all owners")
      };
      let before = snapshot().await;
      // Enforce the fault on new writes without rejecting existing audit history.
      sqlx::query(&format!("ALTER TABLE admin_audit_log ADD CONSTRAINT {constraint} CHECK (target_id IS DISTINCT FROM '{ws}') NOT VALID"))
        .execute(&pool).await.expect("inject scoped audit failure");
      let mutations = vec![
        assign(templates[2]),
        format!("unassignPdfTemplateFromWorkspace(workspaceId:$ws,templateId:\"{}\")",templates[1]),
        default(templates[1]),
        "updatePdfExportSettings(workspaceId:$ws,locale:\"fr\",ligaturesEnabled:false){defaultLocale}".into(),
        "updateDocumentBrandingText(workspaceId:$ws,footerText:\"changed\"){footerText}".into(),
        "updateDocumentBrandingColors(workspaceId:$ws,primary:\"#112233\",accent:\"#445566\"){brandColorPrimary}".into(),
        "setDocumentBrandingColorPolicy(workspaceId:$ws,policy:plain,paletteKey:\"plain\"){colorPolicy}".into(),
        "deleteDocumentBrandLogo(workspaceId:$ws,kind:Large){logoLargeBlob}".into(),
        "resetWorkspaceDocumentBranding(workspaceId:$ws){logoLargeBlob}".into(),
      ];
      for mutation in &mutations {
        let response = call(mutation.clone()).await;
        assert!(errors_array(&response).iter().any(|error| error.contains(&constraint)), "injected audit failure must reject {mutation}: {response}");
        assert_eq!(snapshot().await,before,"all rows and audit counts must roll back: {mutation}");
      }
      let failed = upload_document_brand_logo(&app,session,ws,"Large","replacement.png","image/png",b"\x89PNG\r\n\x1a\nfailed").await;
      assert!(errors_array(&failed).iter().any(|error| error.contains(&constraint)), "audit failure must reject same-format replacement: {failed}");
      assert_eq!(snapshot().await,before,"failed replacement must restore asset metadata");
      assert_eq!(storage.operator().read(&old_key).await.unwrap().to_vec(),original,"failed replacement must preserve actual old bytes");
      let files = storage.operator().list_with("pdf-brand/").recursive(true).await.unwrap();
      assert_eq!(files.iter().filter(|e|e.metadata().mode().is_file()).count(),1,"only committed original remains; staged loser is removed");
      sqlx::query(&format!("ALTER TABLE admin_audit_log DROP CONSTRAINT {constraint}")).execute(&pool).await.unwrap();

      // Successful calls now commit their corresponding state and audit.
      let success = [mutations[0].clone(),mutations[2].clone(),
        format!("unassignPdfTemplateFromWorkspace(workspaceId:$ws,templateId:\"{}\")",templates[0]),
        mutations[3].clone(),mutations[4].clone(),mutations[5].clone(),mutations[6].clone()];
      for mutation in success {
        let response = call(mutation.clone()).await;
        assert!(response.get("errors").is_none(), "successful {mutation}: {response}");
      }
      let a = b"\x89PNG\r\n\x1a\nwriter-a";
      let b = b"\x89PNG\r\n\x1a\nwriter-b";
      let (left,right) = tokio::join!(
        upload_document_brand_logo(&app,session,ws,"Large","a.png","image/png",a),
        upload_document_brand_logo(&app,session,ws,"Large","b.png","image/png",b));
      let mut keys = vec![];
      for (response,bytes) in [(&left,a.as_slice()),(&right,b.as_slice())] {
        assert!(response.get("errors").is_none(), "concurrent upload: {response}");
        // Resolver readback can observe the later committed writer; audit owns
        // each operation's actual immutable key and serialized previous key.
        let hash = format!("{:x}",Sha256::digest(bytes));
        let key:String=sqlx::query_scalar("SELECT new_value->>'blobKey' FROM admin_audit_log WHERE target_id=$1 AND event_key='document_branding.upload_logo' AND new_value->>'sha256'=$2")
          .bind(ws.to_string()).bind(hash).fetch_one(&pool).await.unwrap();
        assert_eq!(storage.operator().read(&key).await.unwrap().to_vec(),bytes,"committed writer bytes remain readable");
        keys.push(key);
      }
      assert_ne!(keys[0],keys[1]);
      let chain:Vec<(Value,Value)>=sqlx::query_as("SELECT old_value,new_value FROM admin_audit_log WHERE target_id=$1 AND event_key='document_branding.upload_logo' ORDER BY created_at,id")
        .bind(ws.to_string()).fetch_all(&pool).await.unwrap();
      assert_eq!(chain.len(),3);
      assert_eq!(chain[1].0["blobKey"],chain[0].1["blobKey"]);
      assert_eq!(chain[2].0["blobKey"],chain[1].1["blobKey"],"locked timeline must be continuous");
      for mutation in [mutations[7].clone(),mutations[8].clone()] {
        let response=call(mutation).await;
        assert!(response.get("errors").is_none(), "delete/reset: {response}");
      }
      assert_eq!(storage.operator().read(&old_key).await.unwrap().to_vec(),original);
      for key in keys { assert!(storage.operator().read(&key).await.is_ok(),"delete/reset retain admitted captures"); }
      let events:Vec<(String,Value,Value)>=sqlx::query_as("SELECT event_key,old_value,new_value FROM admin_audit_log WHERE target_id=$1 AND event_key IN ('pdf_export_settings.update','document_branding.update_text','document_branding.update_colors','document_branding.set_color_policy') ORDER BY created_at,id")
        .bind(ws.to_string()).fetch_all(&pool).await.unwrap();
      assert_eq!(events.len(),4,"one success audit per converted settings/text/colors/policy mutation");
      assert!(events.iter().all(|(_,old,new)|old!=new),"audits record actual before and after");
      let default_audit:Value=sqlx::query_scalar("SELECT old_value FROM admin_audit_log WHERE target_id=$1 AND event_key='pdf_workspace.set_default' ORDER BY created_at DESC,id DESC LIMIT 1")
        .bind(ws.to_string()).fetch_one(&pool).await.unwrap();
      assert_eq!(default_audit["previousTemplateId"],templates[0].to_string());
      let settings:(String,Uuid)=sqlx::query_as("SELECT default_locale,default_template_id FROM pdf_export_settings WHERE workspace_id=$1")
        .bind(ws).fetch_one(&pool).await.unwrap();
      assert_eq!(settings,("fr".into(),templates[1]),"reset preserves export settings and default");
    }).catch_unwind().await;
    sqlx::query(&format!(
      "ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS {constraint}"
    ))
    .execute(&pool)
    .await
    .expect("remove failure injector");
    cleanup_workspace(&pool, ws).await;
    for id in templates {
      sqlx::query("DELETE FROM pdf_templates WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .expect("remove template");
    }
    cleanup_user(&pool, admin).await;
    if let Err(panic) = result {
      std::panic::resume_unwind(panic);
    }
  });
}
