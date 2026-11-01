// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-PDF-TPL-FONT-01-{07..10} integration tests for the admin font library.
//!
//! Invariants checked here (one test per Mikropaket):
//!
//! - INV-FONT-01 (`P-PDF-TPL-FONT-01-07`):
//!   `materialize_approved_fonts` only writes rows whose `license_status =
//!   'approved'` to disk. Pending and rejected rows are filtered at the SQL
//!   layer and the renderer's `extra_font_dirs` never sees them.
//! - INV-FONT-02 (`P-PDF-TPL-FONT-01-08`):
//!   Uploading a real OFL-licensed font (Lato) auto-detects the SPDX-style
//!   `OFL-1.1` license from the `name` table; the response carries the
//!   detected license and starts in `PENDING`.
//! - INV-FONT-03 (`P-PDF-TPL-FONT-01-09`):
//!   Uploading bytes that do not match any supported container produces a
//!   GraphQL error (no `pdf_fonts` row written, no orphaned blob).
//! - INV-FONT-04 (`P-PDF-TPL-FONT-01-10`):
//!   Uploading the same font twice yields a `conflict:` GraphQL error on
//!   the second attempt, mentions the existing row's id, and the second
//!   call is fully a no-op (still a single `pdf_fonts` row).
//!
//! Test setup wires the production [`PgPdfFontRepository`] and
//! [`PdfBlobStore`] into the router so the GraphQL `uploadPdfFont`
//! mutation roundtrips through real opendal and SQLx code paths. The
//! materializer test bypasses the router entirely and exercises the
//! worker-facing helper directly with a stub [`PdfFontReader`].

#![allow(clippy::too_many_lines)]

use crate::helpers;
use futures_util::FutureExt;
use sha2::Digest;
use std::future::Future;
use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::Row;
use sqlx::{Connection, PgPool};
use tower::ServiceExt;
use uuid::Uuid;

use myoxus_application::audit::AuditRecorder;
use myoxus_infrastructure::audit::PgAuditLogStore;
use myoxus_infrastructure::pdf_export::{PdfBlobStore, PgPdfFontRepository, PgPdfIccProfileRepository};
use myoxus_infrastructure::storage::StorageAdapter;
use myoxus_worker::PdfFontReader;
use myoxus_worker::font_materializer::materialize_approved_fonts;

/// Serializes tests that upload the bundled Lato fixture. Two tests share
/// the same SHA-256 (it is the same file), and the GraphQL mutation enforces
/// uniqueness on `pdf_fonts.sha256`, so without this mutex the parallel
/// runner would let one test win the insert and the other get a `conflict:`
/// error it never expected.
static LATO_UPLOAD_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn lato_lock() -> &'static tokio::sync::Mutex<()> {
  LATO_UPLOAD_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn run_graphql_upload_test<F, Fut>(test: F)
where
  F: FnOnce() -> Fut + Send + 'static,
  // Only the factory crosses the thread boundary. The future is constructed
  // inside that thread and driven to completion by its runtime, so requiring
  // it to migrate between executor threads would be a false test constraint.
  Fut: Future<Output = ()> + 'static,
{
  // async-graphql multipart upload parsing plus the full ApiState test router
  // can exceed the default test-harness stack on this integration binary.
  // Keep the production code untouched and make the E2E gate itself robust.
  std::thread::Builder::new()
    .name("pdf-font-lifecycle-upload".to_owned())
    .stack_size(16 * 1024 * 1024)
    .spawn(move || {
      tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("build test runtime")
        .block_on(test());
    })
    .expect("spawn pdf font lifecycle upload test")
    .join()
    .expect("pdf font lifecycle upload test panicked");
}

// ---------------------------------------------------------------------------
// Test app builder with PDF-font services wired
// ---------------------------------------------------------------------------

/// Build a router whose [`ApiState`] has the production
/// [`PgPdfFontRepository`] + [`PdfBlobStore`] + a real [`PgAuditLogStore`]
/// wired in. The base helper does not include these because most tests do
/// not need them.
async fn setup_app_with_fonts() -> (
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
  config.pdf_export.sync_threshold_blocks = 0;

  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage_dir = tempfile::tempdir().expect("font/ICC storage guard");
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

  let pdf_font_repo: Arc<dyn myoxus_domain::repositories::PdfFontRepository> =
    Arc::new(PgPdfFontRepository::new(pool.clone()));
  let pdf_blob_store = Arc::new(PdfBlobStore::new(storage_op));

  // Real audit recorder so `pdf_font.upload` events round-trip into
  // `admin_audit_log` (some tests assert on side-effect-free behaviour, but
  // the recorder must not silently drop entries).
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
  .with_pdf_icc_repo(Arc::new(PgPdfIccProfileRepository::new(pool.clone())))
  .with_pdf_font_repo(pdf_font_repo)
  .with_pdf_blob_store(pdf_blob_store.clone())
  .with_audit_recorder(audit_recorder);

  (build_router(state), pool, auth_store, pdf_blob_store, storage_dir)
}

// ---------------------------------------------------------------------------
// Multipart helper for `uploadPdfFont`
// ---------------------------------------------------------------------------

/// POST a GraphQL multipart request that calls the AdminRoot `uploadPdfFont`
/// mutation. The `license` argument is set to `null` (auto-detect) unless
/// `license_override` is `Some`.
async fn upload_font(
  app: &axum::Router,
  session_id: Uuid,
  filename: &str,
  bytes: &[u8],
  license_override: Option<&str>,
) -> Value {
  let operations = json!({
    "query": "mutation Upload($file: Upload!, $license: String) { \
      admin { \
        uploadPdfFont(file: $file, license: $license) { \
          id familyName style weight sha256 license licenseStatus uploadedAt \
        } \
      } \
    }",
    "variables": {
      "file": null,
      "license": license_override
    }
  })
  .to_string();
  upload_asset(app, session_id, filename, bytes, &operations, "font/ttf").await
}

async fn upload_asset(
  app: &axum::Router,
  session_id: Uuid,
  filename: &str,
  bytes: &[u8],
  operations: &str,
  mime: &str,
) -> Value {
  let boundary = "X-BOUNDARY-PDF-ASSET-UPLOAD";
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
  body.extend_from_slice(format!("Content-Type: {mime}\r\n\r\n").as_bytes());
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

/// Read the bundled Lato Regular fixture. Lato's `name` table contains an
/// SIL Open Font License description, which is what INV-FONT-02 depends on
/// for license auto-detection.
fn load_lato_regular() -> Vec<u8> {
  let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
  let fixture = manifest_dir.join("../../static/fonts/lato-regular.ttf");
  std::fs::read(&fixture).unwrap_or_else(|err| panic!("missing fixture {}: {err}", fixture.display()))
}

fn load_inter_woff2() -> Vec<u8> {
  let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
  let fixture = manifest_dir.join("../../static/fonts/inter-regular-latin.woff2");
  std::fs::read(&fixture).unwrap_or_else(|err| panic!("missing fixture {}: {err}", fixture.display()))
}

async fn cleanup_font_by_sha(pool: &PgPool, sha256: &str) {
  // Remove the fixture before deleting its uploader; keep SQL failures visible.
  sqlx::query("DELETE FROM pdf_fonts WHERE sha256 = $1")
    .bind(sha256)
    .execute(pool)
    .await
    .expect("remove owned font fixture rows");
}

async fn cleanup_user(pool: &PgPool, user_id: Uuid) {
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("remove owned font fixture rows");
  sqlx::query("DELETE FROM sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("remove owned font fixture rows");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("remove owned font fixture rows");
}

// ---------------------------------------------------------------------------
// INV-FONT-01 — pending font is NOT materialized for the renderer
// ---------------------------------------------------------------------------

/// Stub reader that returns canned bytes for any blob_key. The materializer
/// only cares that the read succeeds; the bytes themselves never reach
/// TypstWorld in this test (the renderer is not invoked).
struct StubFontReader {
  payload: Vec<u8>,
}

#[async_trait]
impl PdfFontReader for StubFontReader {
  async fn read_font(&self, _blob_key: &str) -> Result<Vec<u8>, String> {
    Ok(self.payload.clone())
  }
}

fn sfnt_fixture_bytes() -> Vec<u8> {
  let mut bytes = vec![0x00, 0x01, 0x00, 0x00];
  bytes.extend_from_slice(b"synthetic-sfnt-materializer-fixture");
  bytes
}

#[tokio::test]
async fn inv_font01_pending_font_not_used_in_render() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone()));
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let pending_sha = format!("{:x}", uuid::Uuid::new_v4().as_u128());
  let approved_sha = format!("{:x}", uuid::Uuid::new_v4().as_u128());
  let approved_woff2_sha = format!("{:x}", uuid::Uuid::new_v4().as_u128());
  let rejected_sha = format!("{:x}", uuid::Uuid::new_v4().as_u128());

  // Insert three rows distinguished only by license_status. All point at
  // distinct (synthetic) blob_keys so the stub reader serves them all.
  for (sha, status) in &[
    (&pending_sha, "pending"),
    (&approved_sha, "approved"),
    (&approved_woff2_sha, "approved"),
    (&rejected_sha, "rejected"),
  ] {
    sqlx::query(
      "INSERT INTO pdf_fonts (id, family_name, style, weight, blob_key, sha256, license, license_status, uploaded_by) \
       VALUES ($1, $2, 'Regular', 400, $3, $4, 'OFL-1.1', $5, $6)",
    )
    .bind(Uuid::new_v4())
    .bind(format!("FontFamily-{status}"))
    .bind(if *sha == &approved_woff2_sha {
      format!("pdf-fonts/{sha}.woff2")
    } else {
      format!("pdf-fonts/{sha}.ttf")
    })
    .bind(*sha)
    .bind(*status)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("insert font row");
  }

  let reader: Arc<dyn PdfFontReader> = Arc::new(StubFontReader {
    payload: sfnt_fixture_bytes(),
  });
  let repository: Arc<dyn myoxus_domain::repositories::PdfFontRepository> =
    Arc::new(PgPdfFontRepository::new(pool.clone()));
  let dir = materialize_approved_fonts(&repository, Some(&reader))
    .await
    .expect("materializer must return a tempdir when an approved font exists");

  // The tempdir must contain exactly one file — the approved font's sha256.
  let mut entries: Vec<_> = std::fs::read_dir(dir.path())
    .expect("read tempdir")
    .filter_map(|e| e.ok().map(|d| d.file_name().to_string_lossy().into_owned()))
    .collect();
  entries.sort();

  assert_eq!(
    entries.len(),
    1,
    "INV-FONT-01: only the approved font may be materialized; got {entries:?}"
  );
  assert!(
    entries[0].starts_with(&approved_sha),
    "INV-FONT-01: tempdir entry must be the approved font's sha256, got {} (approved sha={approved_sha})",
    entries[0]
  );

  // Cleanup
  for sha in [&pending_sha, &approved_sha, &approved_woff2_sha, &rejected_sha] {
    cleanup_font_by_sha(&pool, sha).await;
  }
  cleanup_user(&pool, admin_id).await;
}

#[tokio::test]
async fn inv_font01b_mislabeled_woff2_bytes_not_materialized() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone()));
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let approved_sha = format!("{:x}", uuid::Uuid::new_v4().as_u128());
  sqlx::query(
    "INSERT INTO pdf_fonts (id, family_name, style, weight, blob_key, sha256, license, license_status, uploaded_by) \
     VALUES ($1, 'MislabeledWoff2', 'Regular', 400, $2, $3, 'OFL-1.1', 'approved', $4)",
  )
  .bind(Uuid::new_v4())
  .bind(format!("pdf-fonts/{approved_sha}.ttf"))
  .bind(&approved_sha)
  .bind(admin_id)
  .execute(&pool)
  .await
  .expect("insert mislabeled approved font row");

  let reader: Arc<dyn PdfFontReader> = Arc::new(StubFontReader {
    payload: b"wOF2actual-browser-font-payload".to_vec(),
  });
  let repository: Arc<dyn myoxus_domain::repositories::PdfFontRepository> =
    Arc::new(PgPdfFontRepository::new(pool.clone()));
  let dir = materialize_approved_fonts(&repository, Some(&reader))
    .await
    .expect("materializer returns a tempdir for approved rows even when bytes are skipped");

  let entries: Vec<_> = std::fs::read_dir(dir.path())
    .expect("read tempdir")
    .filter_map(|e| e.ok().map(|d| d.file_name().to_string_lossy().into_owned()))
    .collect();
  assert!(
    entries.is_empty(),
    "INV-FONT-01B: WOFF2 bytes mislabeled as .ttf must not be materialized; got {entries:?}"
  );

  cleanup_font_by_sha(&pool, &approved_sha).await;
  cleanup_user(&pool, admin_id).await;
}

// ---------------------------------------------------------------------------
// INV-FONT-02 — uploading a real OFL font auto-detects OFL-1.1
// ---------------------------------------------------------------------------

#[test]
fn inv_font02_auto_detect_ofl_license() {
  run_graphql_upload_test(|| async {
    let _guard = lato_lock().lock().await;
    let (app, pool, auth_store, _blob_store, _storage_dir) = setup_app_with_fonts().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

    let bytes = load_lato_regular();
    let sha256 = {
      use sha2::{Digest, Sha256};
      let mut hasher = Sha256::new();
      hasher.update(&bytes);
      format!("{:x}", hasher.finalize())
    };
    // Make sure no leftover row from a prior crash blocks the upload.
    cleanup_font_by_sha(&pool, &sha256).await;

    let resp = upload_font(&app, session_id, "lato-regular.ttf", &bytes, None).await;
    assert!(
      resp.get("errors").is_none(),
      "INV-FONT-02: upload must succeed, got: {resp}"
    );

    let font = &resp["data"]["admin"]["uploadPdfFont"];
    assert_eq!(
      font["license"].as_str(),
      Some("OFL-1.1"),
      "INV-FONT-02: Lato's `name` table must auto-detect as OFL-1.1, got {font}"
    );
    assert_eq!(
      font["licenseStatus"].as_str(),
      Some("Pending"),
      "INV-FONT-02: every newly-uploaded font must start in Pending, got {font}"
    );
    assert_eq!(
      font["sha256"].as_str(),
      Some(sha256.as_str()),
      "INV-FONT-02: returned sha256 must match the uploaded payload"
    );

    // DB-level check: exactly one row exists with the expected sha256 and
    // status pending. This is the invariant the renderer pipeline test
    // (INV-FONT-01) ultimately depends on.
    let row = sqlx::query("SELECT license_status::TEXT AS s FROM pdf_fonts WHERE sha256 = $1")
      .bind(&sha256)
      .fetch_one(&pool)
      .await
      .expect("row must exist after upload");
    let status: String = row.get("s");
    assert_eq!(
      status, "pending",
      "INV-FONT-02: DB row license_status must be `pending`, got {status}"
    );

    // Cleanup
    cleanup_font_by_sha(&pool, &sha256).await;
    cleanup_user(&pool, admin_id).await;
  });
}

// ---------------------------------------------------------------------------
// INV-FONT-03 — corrupt input is rejected at the validator
// ---------------------------------------------------------------------------

#[test]
fn inv_font03_corrupt_font_file_rejected() {
  run_graphql_upload_test(|| async {
    let (app, pool, auth_store, _blob_store, _storage_dir) = setup_app_with_fonts().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

    // Random 1 KiB blob — magic bytes cannot match SFNT/WOFF/WOFF2.
    let garbage: Vec<u8> = (0u8..=255u8).cycle().take(1024).collect();

    let resp = upload_font(&app, session_id, "garbage.bin", &garbage, Some("OFL-1.1")).await;

    let errors = resp
      .get("errors")
      .and_then(|e| e.as_array())
      .cloned()
      .unwrap_or_default();
    assert!(
      !errors.is_empty(),
      "INV-FONT-03: corrupt font must produce a GraphQL error, got: {resp}"
    );
    let message = errors[0]["message"].as_str().unwrap_or_default().to_lowercase();
    assert!(
      message.contains("font format") || message.contains("unrecognised") || message.contains("unsupported"),
      "INV-FONT-03: error message must point at the font-format problem, got: {message}"
    );

    // Negative DB check — no row was written for this corrupt upload.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pdf_fonts WHERE uploaded_by = $1")
      .bind(admin_id)
      .fetch_one(&pool)
      .await
      .expect("count");
    assert_eq!(
      count, 0,
      "INV-FONT-03: rejected upload must not leave a pdf_fonts row behind"
    );

    cleanup_user(&pool, admin_id).await;
  });
}

#[test]
fn inv_font03b_real_woff2_upload_rejected_without_db_row() {
  run_graphql_upload_test(|| async {
    let (app, pool, auth_store, _blob_store, _storage_dir) = setup_app_with_fonts().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

    let bytes = load_inter_woff2();
    let sha256 = {
      use sha2::{Digest, Sha256};
      let mut hasher = Sha256::new();
      hasher.update(&bytes);
      format!("{:x}", hasher.finalize())
    };
    cleanup_font_by_sha(&pool, &sha256).await;

    let resp = upload_font(&app, session_id, "inter-regular-latin.woff2", &bytes, Some("OFL-1.1")).await;
    let errors = resp
      .get("errors")
      .and_then(|e| e.as_array())
      .cloned()
      .unwrap_or_default();
    assert!(
      !errors.is_empty(),
      "INV-FONT-03B: WOFF2 upload must produce a GraphQL error, got: {resp}"
    );
    let message = errors[0]["message"].as_str().unwrap_or_default();
    assert!(
      message.contains("WOFF2") && message.contains("not supported for PDF export"),
      "INV-FONT-03B: error must explicitly reject WOFF2 for PDF export, got: {message}"
    );

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pdf_fonts WHERE sha256 = $1 OR uploaded_by = $2")
      .bind(&sha256)
      .bind(admin_id)
      .fetch_one(&pool)
      .await
      .expect("count");
    assert_eq!(
      count, 0,
      "INV-FONT-03B: rejected WOFF2 upload must not leave a pdf_fonts row behind"
    );

    cleanup_user(&pool, admin_id).await;
  });
}

// ---------------------------------------------------------------------------
// INV-FONT-04 — duplicate sha256 yields a `conflict:` error and is a no-op
// ---------------------------------------------------------------------------

#[test]
fn inv_font04_duplicate_sha256_rejected_with_explicit_error() {
  run_graphql_upload_test(|| async {
    let _guard = lato_lock().lock().await;
    let (app, pool, auth_store, blob_store, _storage_dir) = setup_app_with_fonts().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

    let bytes = load_lato_regular();
    let sha256 = {
      use sha2::{Digest, Sha256};
      let mut hasher = Sha256::new();
      hasher.update(&bytes);
      format!("{:x}", hasher.finalize())
    };
    cleanup_font_by_sha(&pool, &sha256).await;

    // 1) First upload should succeed.
    let first = upload_font(&app, session_id, "lato-regular.ttf", &bytes, None).await;
    assert!(
      first.get("errors").is_none(),
      "INV-FONT-04: first upload must succeed, got: {first}"
    );
    let first_id = first["data"]["admin"]["uploadPdfFont"]["id"]
      .as_str()
      .expect("id present on first upload")
      .to_owned();

    // 2) Second upload with identical bytes must fail with a `conflict:`
    //    error mentioning the existing row's id.
    let second = upload_font(&app, session_id, "lato-regular.ttf", &bytes, None).await;
    let errors = second
      .get("errors")
      .and_then(|e| e.as_array())
      .cloned()
      .unwrap_or_default();
    assert!(
      !errors.is_empty(),
      "INV-FONT-04: second upload must produce a GraphQL error, got: {second}"
    );
    let message = errors[0]["message"].as_str().unwrap_or_default();
    assert!(
      message.starts_with("conflict:"),
      "INV-FONT-04: error must use the canonical `conflict:` prefix, got: {message}"
    );
    assert!(
      message.contains(&first_id),
      "INV-FONT-04: conflict message must mention the existing row's id ({first_id}), got: {message}"
    );

    // 3) Exactly one row exists.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pdf_fonts WHERE sha256 = $1")
      .bind(&sha256)
      .fetch_one(&pool)
      .await
      .expect("count");
    assert_eq!(
      count, 1,
      "INV-FONT-04: dedup must keep the table at exactly one row for this sha256, got {count}"
    );

    let key: String = sqlx::query_scalar("SELECT blob_key FROM pdf_fonts WHERE id=$1")
      .bind(Uuid::parse_str(&first_id).unwrap())
      .fetch_one(&pool)
      .await
      .expect("committed key");
    assert_eq!(
      blob_store.get_template_file(&key).await.expect("committed font bytes"),
      bytes
    );

    cleanup_font_by_sha(&pool, &sha256).await;
    cleanup_user(&pool, admin_id).await;
  });
}

fn stored_asset_file_count(path: &std::path::Path) -> usize {
  std::fs::read_dir(path)
    .expect("read scoped asset storage")
    .map(|entry| {
      let entry = entry.expect("read asset entry");
      if entry.file_type().expect("asset type").is_dir() {
        stored_asset_file_count(&entry.path())
      } else {
        1
      }
    })
    .sum()
}

async fn upload_icc(app: &axum::Router, session: Uuid, name: &str, bytes: &[u8]) -> Value {
  let operations=json!({"query":"mutation($file:Upload!,$name:String!){admin{uploadIccProfile(file:$file,name:$name,profileType:sRGB){id name sha256}}}","variables":{"file":null,"name":name}}).to_string();
  upload_asset(
    app,
    session,
    "profile.icc",
    bytes,
    &operations,
    "application/octet-stream",
  )
  .await
}

#[test]
fn font_audit_failure_rolls_back_upload_status_and_delete_without_losing_bytes() {
  run_graphql_upload_test(|| async {
    let _guard = lato_lock().lock().await;
    let (app, pool, auth, blobs, dir) = setup_app_with_fonts().await;
    let (admin, session) = helpers::seed_admin(&pool, &auth).await;
    let bytes = load_lato_regular();
    let sha = format!("{:x}", sha2::Sha256::digest(&bytes));
    cleanup_font_by_sha(&pool, &sha).await;
    let constraint = format!("font_audit_{}", admin.simple());
    let result=std::panic::AssertUnwindSafe(async {
      sqlx::query(&format!("ALTER TABLE admin_audit_log ADD CONSTRAINT {constraint} CHECK(actor_user_id IS DISTINCT FROM '{admin}') NOT VALID"))
        .execute(&pool).await.expect("inject new-write audit failure");
      let failed=upload_font(&app,session,"lato.ttf",&bytes,None).await;
      assert!(failed["errors"].as_array().unwrap().iter().any(|e|e["message"].as_str().unwrap().contains(&constraint)),"audit failure must reject upload: {failed}");
      let rows:i64=sqlx::query_scalar("SELECT count(*) FROM pdf_fonts WHERE sha256=$1").bind(&sha).fetch_one(&pool).await.unwrap();
      assert_eq!(rows,0);
      assert_eq!(stored_asset_file_count(dir.path()),0,"failed upload removes only its fresh staging");
      sqlx::query(&format!("ALTER TABLE admin_audit_log DROP CONSTRAINT {constraint}")).execute(&pool).await.unwrap();
      // An independent connection leaves both fixture-pool connections free.
      // Block INSERT until both prechecks have staged their immutable files.
      let mut barrier_conn=sqlx::PgConnection::connect_with(&pool.connect_options()).await.expect("race barrier connection");
      let mut barrier=barrier_conn.begin().await.unwrap();
      sqlx::query("LOCK TABLE pdf_fonts IN SHARE MODE").execute(&mut *barrier).await.unwrap();
      let release=async {
        let staged=tokio::time::timeout(std::time::Duration::from_secs(10),async {
          while stored_asset_file_count(dir.path())<2 {tokio::time::sleep(std::time::Duration::from_millis(10)).await;}
        }).await.is_ok();
        barrier.rollback().await.expect("release race barrier");
        staged
      };
      let (first,second,staged)=tokio::join!(upload_font(&app,session,"lato.ttf",&bytes,None),upload_font(&app,session,"lato.ttf",&bytes,None),release);
      assert!(staged,"both writers must pass the precheck before either insert wins");
      let mut winners=[first,second].into_iter().filter(|value|value.get("errors").is_none());
      let uploaded=winners.next().expect("one successful writer");
      assert!(winners.next().is_none(),"SHA uniqueness admits exactly one writer");
      assert_eq!(stored_asset_file_count(dir.path()),1,"failed duplicate removes only its own staging");
      assert!(uploaded.get("errors").is_none(),"upload: {uploaded}");
      let id=Uuid::parse_str(uploaded["data"]["admin"]["uploadPdfFont"]["id"].as_str().unwrap()).unwrap();
      let (before,key):(Value,String)=sqlx::query_as("SELECT to_jsonb(f),blob_key FROM pdf_fonts f WHERE id=$1").bind(id).fetch_one(&pool).await.unwrap();
      let audit_before:i64=sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE actor_user_id=$1").bind(admin).fetch_one(&pool).await.unwrap();
      sqlx::query(&format!("ALTER TABLE admin_audit_log ADD CONSTRAINT {constraint} CHECK(actor_user_id IS DISTINCT FROM '{admin}') NOT VALID"))
        .execute(&pool).await.unwrap();
      for fields in [format!("approvePdfFont(id:\"{id}\"){{licenseStatus}}"),
        format!("rejectPdfFont(id:\"{id}\",reason:\"License review pending\"){{licenseStatus}}"),
        format!("deletePdfFont(id:\"{id}\")")] {
        let response=helpers::gql(&app,session,json!({"query":format!("mutation{{admin{{{fields}}}}}")})).await;
        assert!(response["errors"].as_array().unwrap().iter().any(|e|e["message"].as_str().unwrap().contains(&constraint)),"audit failure: {response}");
        let after:Value=sqlx::query_scalar("SELECT to_jsonb(f) FROM pdf_fonts f WHERE id=$1").bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(after,before,"status/license/timestamps remain unchanged");
        assert_eq!(blobs.get_template_file(&key).await.unwrap(),bytes);
        let audits:i64=sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE actor_user_id=$1").bind(admin).fetch_one(&pool).await.unwrap();
        assert_eq!(audits,audit_before);
      }
      sqlx::query(&format!("ALTER TABLE admin_audit_log DROP CONSTRAINT {constraint}")).execute(&pool).await.unwrap();
      for fields in [format!("approvePdfFont(id:\"{id}\"){{licenseStatus}}"),
        format!("rejectPdfFont(id:\"{id}\",reason:\"License review pending\"){{licenseStatus}}"),
        format!("deletePdfFont(id:\"{id}\")")] {
        let response=helpers::gql(&app,session,json!({"query":format!("mutation{{admin{{{fields}}}}}")})).await;
        assert!(response.get("errors").is_none(),"successful transition: {response}");
      }
      let events:Vec<(String,Option<Value>,Option<Value>)>=sqlx::query_as("SELECT event_key,old_value,new_value FROM admin_audit_log WHERE actor_user_id=$1 AND target_id=$2 ORDER BY created_at,id")
        .bind(admin).bind(id.to_string()).fetch_all(&pool).await.unwrap();
      assert_eq!(events.len(),4);
      assert_eq!(events[1].0,"pdf_font.approve");
      assert_eq!(events[1].1.as_ref().unwrap()["licenseStatus"],"pending");
      assert_eq!(events[1].2.as_ref().unwrap()["licenseStatus"],"approved");
      assert_eq!(events[2].1.as_ref().unwrap()["licenseStatus"],"approved");
      assert_eq!(events[2].2.as_ref().unwrap()["reason"],"License review pending");
      assert_eq!(events[3].1.as_ref().unwrap()["licenseStatus"],"rejected");
      assert!(events[3].2.is_none());
      assert!(matches!(blobs.get_template_file(&key).await,Err(myoxus_domain::repositories::RepositoryError::NotFound(_))),"cleanup follows committed deletion");
      // A legacy bundled marker remains immutable at this add-on boundary.
      sqlx::query("INSERT INTO pdf_fonts(id,family_name,style,weight,blob_key,sha256,license,license_status,uploaded_by) VALUES($1,'Bundled marker','Regular',400,'protected',$2,'OFL-1.1','approved',NULL)")
        .bind(id).bind(&sha).execute(&pool).await.unwrap();
      let protected=helpers::gql(&app,session,json!({"query":format!("mutation{{admin{{deletePdfFont(id:\"{id}\")}}}}")})).await;
      assert_eq!(protected["data"]["admin"]["deletePdfFont"],false);
      let count:i64=sqlx::query_scalar("SELECT count(*) FROM pdf_fonts WHERE id=$1").bind(id).fetch_one(&pool).await.unwrap();
      assert_eq!(count,1);
    }).catch_unwind().await;
    sqlx::query(&format!(
      "ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS {constraint}"
    ))
    .execute(&pool)
    .await
    .unwrap();
    cleanup_font_by_sha(&pool, &sha).await;
    cleanup_user(&pool, admin).await;
    if let Err(panic) = result {
      std::panic::resume_unwind(panic)
    }
  });
}

#[test]
fn icc_audit_failure_and_duplicate_upload_preserve_bytes_and_default_references() {
  run_graphql_upload_test(|| async {
    let (app, pool, auth, blobs, dir) = setup_app_with_fonts().await;
    let (admin, session) = helpers::seed_admin(&pool, &auth).await;
    let ws = helpers::create_workspace(&pool, admin).await;
    let name = format!("ICC atomic {}", Uuid::new_v4());
    let mut profile = moxcms::ColorProfile::new_srgb();
    profile.description = Some(moxcms::ProfileText::PlainString(name.clone()));
    let bytes = profile.encode().expect("encode genuine unique sRGB profile");
    let sha = format!("{:x}", sha2::Sha256::digest(&bytes));
    let constraint = format!("icc_audit_{}", admin.simple());
    let result=std::panic::AssertUnwindSafe(async {
      sqlx::query(&format!("ALTER TABLE admin_audit_log ADD CONSTRAINT {constraint} CHECK(actor_user_id IS DISTINCT FROM '{admin}') NOT VALID")).execute(&pool).await.unwrap();
      let failed=upload_icc(&app,session,&name,&bytes).await;
      assert!(failed["errors"].as_array().unwrap().iter().any(|e|e["message"].as_str().unwrap().contains(&constraint)),"upload failure: {failed}");
      let rows:i64=sqlx::query_scalar("SELECT count(*) FROM pdf_icc_profiles WHERE sha256=$1").bind(&sha).fetch_one(&pool).await.unwrap();
      assert_eq!(rows,0);assert_eq!(stored_asset_file_count(dir.path()),0);
      sqlx::query(&format!("ALTER TABLE admin_audit_log DROP CONSTRAINT {constraint}")).execute(&pool).await.unwrap();
      let (one,two)=tokio::join!(upload_icc(&app,session,&name,&bytes),upload_icc(&app,session,&name,&bytes));
      let winners=[&one,&two].into_iter().filter(|r|r.get("errors").is_none()).collect::<Vec<_>>();
      assert_eq!(winners.len(),1,"row dedup keeps one winner: {one} {two}");
      let id=Uuid::parse_str(winners[0]["data"]["admin"]["uploadIccProfile"]["id"].as_str().unwrap()).unwrap();
      let (before,key):(Value,String)=sqlx::query_as("SELECT to_jsonb(p),blob_key FROM pdf_icc_profiles p WHERE id=$1").bind(id).fetch_one(&pool).await.unwrap();
      assert_eq!(blobs.get_template_file(&key).await.unwrap(),bytes,"duplicate loser preserves winner's real profile bytes");
      assert_eq!(stored_asset_file_count(dir.path()),1,"loser cleans only its own staging");
      sqlx::query("INSERT INTO pdf_export_settings(scope,workspace_id,default_color_profile_id) VALUES('workspace',$1,$2)").bind(ws).bind(id).execute(&pool).await.unwrap();
      sqlx::query(&format!("ALTER TABLE admin_audit_log ADD CONSTRAINT {constraint} CHECK(actor_user_id IS DISTINCT FROM '{admin}') NOT VALID")).execute(&pool).await.unwrap();
      let fields=format!("mutation{{admin{{deleteIccProfile(id:\"{id}\")}}}}");
      let failed=helpers::gql(&app,session,json!({"query":fields})).await;
      assert!(failed["errors"].as_array().unwrap().iter().any(|e|e["message"].as_str().unwrap().contains(&constraint)),"delete failure: {failed}");
      let after:Value=sqlx::query_scalar("SELECT to_jsonb(p) FROM pdf_icc_profiles p WHERE id=$1").bind(id).fetch_one(&pool).await.unwrap();
      assert_eq!(before,after);
      let reference:Option<Uuid>=sqlx::query_scalar("SELECT default_color_profile_id FROM pdf_export_settings WHERE workspace_id=$1").bind(ws).fetch_one(&pool).await.unwrap();
      assert_eq!(reference,Some(id));assert_eq!(blobs.get_template_file(&key).await.unwrap(),bytes);
      let audits:i64=sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE actor_user_id=$1 AND target_id=$2").bind(admin).bind(id.to_string()).fetch_one(&pool).await.unwrap();
      assert_eq!(audits,1,"failed delete cannot add an audit");
      sqlx::query(&format!("ALTER TABLE admin_audit_log DROP CONSTRAINT {constraint}")).execute(&pool).await.unwrap();
      let deleted=helpers::gql(&app,session,json!({"query":fields})).await;
      assert_eq!(deleted["data"]["admin"]["deleteIccProfile"],true);
      let reference:Option<Uuid>=sqlx::query_scalar("SELECT default_color_profile_id FROM pdf_export_settings WHERE workspace_id=$1").bind(ws).fetch_one(&pool).await.unwrap();
      assert_eq!(reference,None,"deployed ON DELETE SET NULL policy is preserved");
      assert!(matches!(blobs.get_template_file(&key).await,Err(myoxus_domain::repositories::RepositoryError::NotFound(_))));
      let events:Vec<(String,Option<Value>,Option<Value>)>=sqlx::query_as("SELECT event_key,old_value,new_value FROM admin_audit_log WHERE actor_user_id=$1 AND target_id=$2 ORDER BY created_at,id")
        .bind(admin).bind(id.to_string()).fetch_all(&pool).await.unwrap();
      assert_eq!(events.len(),2);assert_eq!(events[0].0,"pdf_icc.upload");assert_eq!(events[1].0,"pdf_icc.delete");
      assert_eq!(events[0].2,events[1].1,"locked before/after metadata is continuous");
      // System-marker rows keep the same public deletion policy, not a new guard.
      let system=sqlx::query_scalar::<_,Uuid>("INSERT INTO pdf_icc_profiles(name,profile_type,blob_key,sha256,uploaded_by) VALUES($1,'sRGB','legacy-system',$2,NULL) RETURNING id")
        .bind(&name).bind(&sha).fetch_one(&pool).await.unwrap();
      let deleted=helpers::gql(&app,session,json!({"query":format!("mutation{{admin{{deleteIccProfile(id:\"{system}\")}}}}")})).await;
      assert_eq!(deleted["data"]["admin"]["deleteIccProfile"],true);
    }).catch_unwind().await;
    sqlx::query(&format!(
      "ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS {constraint}"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM pdf_icc_profiles WHERE sha256=$1")
      .bind(&sha)
      .execute(&pool)
      .await
      .unwrap();
    sqlx::query("DELETE FROM workspaces WHERE id=$1")
      .bind(ws)
      .execute(&pool)
      .await
      .unwrap();
    cleanup_user(&pool, admin).await;
    if let Err(panic) = result {
      std::panic::resume_unwind(panic)
    }
  });
}
