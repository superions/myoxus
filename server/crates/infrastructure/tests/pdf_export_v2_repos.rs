// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariant tests for PDF-Export V2 repository implementations.
//!
//! Coverage package: P-PDF-TPL-03 (P-PDF-TPL-03-04 through
//! P-PDF-TPL-03-06 plus related repository invariants).
//!
//! Each test asserts a concrete DB-state invariant after an operation —
//! not merely that a call succeeds. All tests clean up their rows at the end.

use chrono::Utc;
use opendal::Operator;
use opendal::services::Memory;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use myoxus_domain::entities::{
  PdfDocumentBrandLogoSlot, PdfFont, PdfFontLicense, PdfFontLicenseStatus, PdfIccProfileType, PdfTemplate,
  PdfTemplateFile, PdfWorkspaceBrandAsset,
};
use myoxus_domain::repositories::{
  PdfDocumentBrandLogoAsset, PdfFontRepository, PdfIccProfileRepository, PdfTemplateRepository,
  PdfWorkspaceBrandAssetRepository, PdfWorkspaceTemplateAssignmentRepository, RepositoryError,
};
use myoxus_infrastructure::pdf_export::{
  PdfBlobStore, PgPdfFontRepository, PgPdfIccProfileRepository, PgPdfTemplateRepository,
  PgPdfWorkspaceBrandAssetRepository, PgPdfWorkspaceTemplateAssignmentRepository, SYSTEM_ICC_PROFILE_NAMES,
  list_files_for_template, seed_system_icc_profiles,
};

async fn setup_pool() -> PgPool {
  let database_url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .expect("TEST_DATABASE_URL must be set for pdf_export_v2_repos tests");
  let pool = PgPool::connect(&database_url)
    .await
    .expect("postgres must be reachable");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrations must succeed");
  pool
}

/// Seed a minimal user + workspace; return (user_id, workspace_id).
async fn seed_user_workspace(pool: &PgPool) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  let ws_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(format!("pdf-test-{}@example.test", user_id))
    .bind("PDF Test User")
    .execute(pool)
    .await
    .expect("seed user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
    .bind(ws_id)
    .bind(user_id)
    .bind("PDF Test Workspace")
    .execute(pool)
    .await
    .expect("seed workspace");
  (user_id, ws_id)
}

fn new_template(created_by: Uuid, slug: &str) -> PdfTemplate {
  PdfTemplate {
    id: Uuid::new_v4(),
    slug: slug.to_owned(),
    name: "Test Template".to_owned(),
    version: "1.0.0".to_owned(),
    schema_version: "2.0".to_owned(),
    manifest: serde_json::json!({"schema_version": "2.0", "id": slug}),
    created_by: Some(created_by),
    created_at: Utc::now(),
    deleted_at: None,
  }
}

fn new_file(template_id: Uuid, file_path: &str) -> PdfTemplateFile {
  PdfTemplateFile {
    template_id,
    file_path: file_path.to_owned(),
    blob_key: format!("pdf-templates/{}/{}", template_id, file_path),
    content_hash: "deadbeef".to_owned(),
  }
}

// ── inv_repo01 ────────────────────────────────────────────────────────────────
/// INV-REPO-01: create() writes template row + N file rows; get_by_id returns it.
#[tokio::test]
async fn inv_repo01_create_template_persists_files() {
  let pool = setup_pool().await;
  let (user_id, _) = seed_user_workspace(&pool).await;
  let repo = PgPdfTemplateRepository::new(pool.clone());

  let tpl = new_template(user_id, &format!("inv01-{}", Uuid::new_v4()));
  let files = vec![new_file(tpl.id, "main.typ"), new_file(tpl.id, "theme.typ")];

  repo.create(&tpl, &files, None).await.expect("create must succeed");

  let fetched = repo.get_by_id(tpl.id).await.expect("get_by_id must succeed");
  assert!(
    fetched.is_some(),
    "INV-REPO-01: template must be retrievable after create"
  );
  assert_eq!(fetched.unwrap().slug, tpl.slug);

  let stored_files = list_files_for_template(&pool, tpl.id).await.expect("list files");
  assert_eq!(stored_files.len(), 2, "INV-REPO-01: both files must be persisted");

  // Cleanup
  sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
    .bind(tpl.id)
    .execute(&pool)
    .await
    .ok();
}

// ── inv_repo02 ────────────────────────────────────────────────────────────────
/// INV-REPO-02: set_default flips previous default to false atomically.
#[tokio::test]
async fn inv_repo02_set_default_resets_previous_default() {
  let pool = setup_pool().await;
  let (user_id, ws_id) = seed_user_workspace(&pool).await;
  let tpl_repo = PgPdfTemplateRepository::new(pool.clone());
  let asgn_repo = PgPdfWorkspaceTemplateAssignmentRepository::new(pool.clone());

  let tpl_a = new_template(user_id, &format!("inv02a-{}", Uuid::new_v4()));
  let tpl_b = new_template(user_id, &format!("inv02b-{}", Uuid::new_v4()));
  tpl_repo.create(&tpl_a, &[], None).await.expect("create A");
  tpl_repo.create(&tpl_b, &[], None).await.expect("create B");
  asgn_repo
    .assign(ws_id, tpl_a.id, user_id, None)
    .await
    .expect("assign A");
  asgn_repo
    .assign(ws_id, tpl_b.id, user_id, None)
    .await
    .expect("assign B");

  asgn_repo
    .set_default(ws_id, tpl_a.id, user_id, None)
    .await
    .expect("set A as default");
  asgn_repo
    .set_default(ws_id, tpl_b.id, user_id, None)
    .await
    .expect("set B as default");

  let assignments = asgn_repo.list_for_workspace(ws_id).await.expect("list");
  let defaults: Vec<_> = assignments.iter().filter(|a| a.is_default).collect();
  assert_eq!(defaults.len(), 1, "INV-REPO-02: exactly one default must exist");
  assert_eq!(defaults[0].template_id, tpl_b.id, "INV-REPO-02: B must be the default");

  // Cleanup
  sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM pdf_templates WHERE id IN ($1, $2)")
    .bind(tpl_a.id)
    .bind(tpl_b.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

// ── inv_repo03 ────────────────────────────────────────────────────────────────
/// INV-REPO-03: soft_delete hides template from list(false) but not list(true).
#[tokio::test]
async fn inv_repo03_soft_delete_hides_template() {
  let pool = setup_pool().await;
  let (user_id, _) = seed_user_workspace(&pool).await;
  let repo = PgPdfTemplateRepository::new(pool.clone());

  let tpl = new_template(user_id, &format!("inv03-{}", Uuid::new_v4()));
  repo.create(&tpl, &[], None).await.expect("create");
  repo.soft_delete(tpl.id, None).await.expect("soft_delete");

  let active = repo.list(false).await.expect("list active");
  assert!(
    !active.iter().any(|t| t.id == tpl.id),
    "INV-REPO-03: soft-deleted template must NOT appear in list(false)"
  );

  let including_deleted = repo.list(true).await.expect("list all");
  assert!(
    including_deleted.iter().any(|t| t.id == tpl.id),
    "INV-REPO-03: soft-deleted template MUST appear in list(true)"
  );

  // Cleanup
  sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
    .bind(tpl.id)
    .execute(&pool)
    .await
    .ok();
}

// ── inv_repo04 ────────────────────────────────────────────────────────────────
/// INV-REPO-04: split document-branding and PDF-settings writes never clear
/// each other's owner fields.
#[tokio::test]
async fn inv_repo04_brand_upsert_idempotent() {
  let pool = setup_pool().await;
  let (user_id, ws_id) = seed_user_workspace(&pool).await;
  let repo = PgPdfWorkspaceBrandAssetRepository::new(pool.clone());

  let asset = PdfWorkspaceBrandAsset {
    workspace_id: ws_id,
    logo_large_blob: None,
    logo_large_sha256: None,
    logo_small_blob: None,
    logo_small_sha256: None,
    company_name: None,
    legal_text: None,
    footer_text: Some("First footer".to_owned()),
    color_policy: "custom".to_owned(),
    color_palette_key: None,
    brand_color_primary: Some("#0044aa".to_owned()),
    brand_color_accent: Some("#ff8800".to_owned()),
    brand_color_rule: Some("#ff8800".to_owned()),
    brand_color_text: Some("#333333".to_owned()),
    brand_color_background: Some("#ffffff".to_owned()),
    default_paper_size: None,
    default_locale: None,
    default_color_profile: None,
    default_image_quality: None,
    ligatures_enabled: true,
    default_template_id: None,
    updated_at: Utc::now(),
    updated_by: user_id,
  };
  repo
    .set_document_branding_text(ws_id, asset.footer_text.clone(), user_id, asset.updated_at, None)
    .await
    .expect("document branding text upsert");
  repo
    .set_document_branding_colors(
      ws_id,
      asset.brand_color_primary.clone(),
      asset.brand_color_accent.clone(),
      user_id,
      asset.updated_at,
      None,
    )
    .await
    .expect("document branding colors upsert");
  repo
    .set_document_logo_blob(
      ws_id,
      PdfDocumentBrandLogoSlot::Large,
      Some(PdfDocumentBrandLogoAsset {
        blob_key: "pdf-brand/test/logo-large.svg".to_string(),
        sha256: "a".repeat(64),
        mime: "image/svg+xml".to_string(),
        byte_size: 321,
      }),
      user_id,
      asset.updated_at,
      None,
    )
    .await
    .expect("document logo upsert");

  let updated = PdfWorkspaceBrandAsset {
    footer_text: None,
    brand_color_primary: None,
    brand_color_accent: None,
    default_paper_size: Some("Letter".to_owned()),
    ..asset.clone()
  };
  repo
    .upsert_pdf_export_settings(
      &myoxus_domain::repositories::PdfExportSettingsPatch::replace(&updated),
      None,
    )
    .await
    .expect("pdf export settings upsert");

  let doc_row_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM document_brand_profiles WHERE workspace_id = $1")
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .expect("count document_brand_profiles");
  assert_eq!(
    doc_row_count.0, 1,
    "INV-REPO-04: exactly one document branding row must exist"
  );
  let settings_row_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pdf_export_settings WHERE workspace_id = $1")
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .expect("count pdf_export_settings");
  assert_eq!(
    settings_row_count.0, 1,
    "INV-REPO-04: exactly one PDF settings row must exist"
  );

  let fetched = repo.get(ws_id).await.expect("get").expect("must exist");
  assert_eq!(
    fetched.footer_text.as_deref(),
    Some("First footer"),
    "INV-REPO-04: settings-only writes must not clear document branding"
  );
  assert_eq!(
    fetched.brand_color_primary.as_deref(),
    Some("#0044aa"),
    "INV-REPO-04: settings-only writes must not clear document colors"
  );
  assert_eq!(
    fetched.default_paper_size.as_deref(),
    Some("Letter"),
    "INV-REPO-04: PDF settings writes must update the settings owner"
  );
  let logo_metadata: (String, i64) = sqlx::query_as(
    "SELECT mime, byte_size FROM brand_assets WHERE workspace_id = $1 AND slot = 'logo' AND variant = 'large'",
  )
  .bind(ws_id)
  .fetch_one(&pool)
  .await
  .expect("document logo metadata");
  assert_eq!(logo_metadata, ("image/svg+xml".to_string(), 321));

  // Cleanup
  sqlx::query("DELETE FROM pdf_export_settings WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM document_brand_profiles WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM brand_assets WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

// ── inv_repo05 ────────────────────────────────────────────────────────────────
/// INV-REPO-05: inserting a font with a duplicate sha256 returns a Conflict error.
#[tokio::test]
async fn inv_repo05_font_unique_sha256_blocks_dup_insert() {
  let pool = setup_pool().await;
  let (user_id, _) = seed_user_workspace(&pool).await;
  let repo = PgPdfFontRepository::new(pool.clone());

  let sha = format!("sha256unique{}", Uuid::new_v4().simple());
  let font = PdfFont {
    id: Uuid::new_v4(),
    family_name: "Test Family".to_owned(),
    style: "Regular".to_owned(),
    weight: 400,
    blob_key: format!("pdf-fonts/{}.ttf", sha),
    sha256: sha.clone(),
    license: PdfFontLicense::Ofl11,
    license_status: PdfFontLicenseStatus::Pending,
    uploaded_by: Some(user_id),
    uploaded_at: Utc::now(),
    approved_by: None,
    approved_at: None,
  };

  repo.create(&font, None).await.expect("first insert must succeed");

  let dup = PdfFont {
    id: Uuid::new_v4(),
    ..font.clone()
  };
  let result = repo.create(&dup, None).await;
  assert!(
    matches!(result, Err(RepositoryError::Conflict(_))),
    "INV-REPO-05: duplicate sha256 must return Conflict, got: {:?}",
    result
  );

  // Cleanup
  sqlx::query("DELETE FROM pdf_fonts WHERE sha256 = $1")
    .bind(&sha)
    .execute(&pool)
    .await
    .ok();
}

// ── inv_repo06 ────────────────────────────────────────────────────────────────
/// INV-REPO-06: PdfBlobStore put/get roundtrip; returned sha256 matches hand-computed digest.
#[tokio::test]
async fn inv_repo06_blob_store_roundtrip() {
  let op = Operator::new(Memory::default()).expect("memory operator");
  let store = PdfBlobStore::new(op);

  let payload = b"hello pdf blob world";
  let tpl_id = Uuid::new_v4();

  let (blob_key, sha_returned) = store
    .put_template_file(tpl_id, "main.typ", payload)
    .await
    .expect("put must succeed");

  let downloaded = store.get_template_file(&blob_key).await.expect("get must succeed");

  assert_eq!(
    downloaded, payload,
    "INV-REPO-06: downloaded bytes must match uploaded bytes"
  );

  let mut hasher = Sha256::new();
  hasher.update(payload);
  let expected_sha = format!("{:x}", hasher.finalize());
  assert_eq!(
    sha_returned, expected_sha,
    "INV-REPO-06: returned sha256 must match hand-computed digest"
  );
}

// ── inv_repo07 ────────────────────────────────────────────────────────────────
/// INV-REPO-07 (P-PDF-TPL-COLOR-01-09): the `pdf_icc_profiles.name` UNIQUE
/// constraint blocks duplicate-name inserts even when SHA-256 differs, and
/// the `sha256` UNIQUE constraint blocks duplicate-content inserts even when
/// the name differs. Both surface as `RepositoryError::Conflict`.
#[tokio::test]
async fn inv_repo07_icc_unique_name_and_sha256_block_dup_insert() {
  let pool = setup_pool().await;
  let (user_id, _) = seed_user_workspace(&pool).await;
  let repo = PgPdfIccProfileRepository::new(pool.clone());

  let unique_suffix = Uuid::new_v4().simple().to_string();
  let name = format!("ICC Test {unique_suffix}");
  let sha = format!("sha256icc{unique_suffix}");
  let blob_key = format!("pdf-icc/{sha}.icc");

  // First insert succeeds.
  let row = repo
    .create(&name, PdfIccProfileType::Srgb, &blob_key, &sha, Some(user_id), None)
    .await
    .expect("first icc insert must succeed");
  assert_eq!(row.name, name, "INV-REPO-07: persisted name must match input");
  assert_eq!(row.sha256, sha, "INV-REPO-07: persisted sha256 must match input");

  // Same name, different sha → name UNIQUE blocks it.
  let other_sha = format!("sha256-other-{unique_suffix}");
  let dup_name = repo
    .create(
      &name,
      PdfIccProfileType::Srgb,
      &format!("pdf-icc/{other_sha}.icc"),
      &other_sha,
      Some(user_id),
      None,
    )
    .await;
  assert!(
    matches!(dup_name, Err(RepositoryError::Conflict(_))),
    "INV-REPO-07: duplicate name must return Conflict, got: {:?}",
    dup_name
  );

  // Different name, same sha → sha256 UNIQUE blocks it.
  let dup_sha = repo
    .create(
      &format!("Other ICC {unique_suffix}"),
      PdfIccProfileType::Srgb,
      &blob_key,
      &sha,
      Some(user_id),
      None,
    )
    .await;
  assert!(
    matches!(dup_sha, Err(RepositoryError::Conflict(_))),
    "INV-REPO-07: duplicate sha256 must return Conflict, got: {:?}",
    dup_sha
  );

  // Cleanup.
  sqlx::query("DELETE FROM pdf_icc_profiles WHERE id = $1")
    .bind(row.id)
    .execute(&pool)
    .await
    .ok();
}

// ── inv_repo08 ────────────────────────────────────────────────────────────────
/// INV-REPO-08 (P-PDF-TPL-COLOR-01-09): create → list → get → delete is a
/// closed lifecycle. After delete, `get` returns `None` and the row is gone
/// from `list`. Calling `delete` a second time returns `false` (idempotent).
#[tokio::test]
async fn inv_repo08_icc_create_list_get_delete_lifecycle() {
  let pool = setup_pool().await;
  let (user_id, _) = seed_user_workspace(&pool).await;
  let repo = PgPdfIccProfileRepository::new(pool.clone());

  let unique_suffix = Uuid::new_v4().simple().to_string();
  let name = format!("ICC Lifecycle {unique_suffix}");
  let sha = format!("sha256lifecycle{unique_suffix}");
  let blob_key = format!("pdf-icc/{sha}.icc");

  let row = repo
    .create(&name, PdfIccProfileType::Cmyk, &blob_key, &sha, Some(user_id), None)
    .await
    .expect("create must succeed");

  let by_id = repo.get(row.id).await.expect("get must succeed");
  assert!(
    by_id.is_some(),
    "INV-REPO-08: get must return the row right after create"
  );
  assert_eq!(
    by_id.unwrap().profile_type,
    PdfIccProfileType::Cmyk,
    "INV-REPO-08: profile_type must round-trip through the DB"
  );

  let by_name = repo.get_by_name(&name).await.expect("get_by_name must succeed");
  assert!(
    by_name.is_some(),
    "INV-REPO-08: get_by_name must locate the row by its unique name"
  );
  assert_eq!(by_name.unwrap().id, row.id);

  let listed = repo.list().await.expect("list must succeed");
  assert!(
    listed.iter().any(|p| p.id == row.id),
    "INV-REPO-08: list must include freshly created profile"
  );

  let removed = repo.delete(row.id, None).await.expect("delete must succeed");
  assert!(
    removed.is_some(),
    "INV-REPO-08: first delete must report `true` (row existed)"
  );

  let after = repo.get(row.id).await.expect("get must succeed");
  assert!(after.is_none(), "INV-REPO-08: get after delete must return None");

  let removed_again = repo.delete(row.id, None).await.expect("second delete must succeed");
  assert!(
    removed_again.is_none(),
    "INV-REPO-08: second delete must report `false` (idempotent on missing id)"
  );
}

// ── inv_repo09 ────────────────────────────────────────────────────────────────
/// INV-REPO-09 (P-PDF-TPL-FONT-01-09): font lookup by primary key returns
/// the freshly inserted row and `None` for unknown ids. The detail view and
/// approve/reject mutations rely on this contract for audit-log payloads.
#[tokio::test]
async fn inv_repo09_font_get_by_id_round_trip() {
  let pool = setup_pool().await;
  let (user_id, _) = seed_user_workspace(&pool).await;
  let repo = PgPdfFontRepository::new(pool.clone());

  let sha = format!("sha256getid{}", Uuid::new_v4().simple());
  let font = PdfFont {
    id: Uuid::new_v4(),
    family_name: "Get-By-Id Family".to_owned(),
    style: "Regular".to_owned(),
    weight: 400,
    blob_key: format!("pdf-fonts/{sha}.ttf"),
    sha256: sha.clone(),
    license: PdfFontLicense::Apache20,
    license_status: PdfFontLicenseStatus::Pending,
    uploaded_by: Some(user_id),
    uploaded_at: Utc::now(),
    approved_by: None,
    approved_at: None,
  };
  repo.create(&font, None).await.expect("create must succeed");

  let by_id = repo.get(font.id).await.expect("get must succeed");
  let row = by_id.expect("INV-REPO-09: get must return the row right after create");
  assert_eq!(row.family_name, font.family_name);
  assert_eq!(row.style, font.style);
  assert_eq!(row.weight, font.weight);
  assert_eq!(row.license, PdfFontLicense::Apache20);
  assert_eq!(row.license_status, PdfFontLicenseStatus::Pending);

  let unknown = repo.get(Uuid::new_v4()).await.expect("get must succeed");
  assert!(unknown.is_none(), "INV-REPO-09: get on unknown id must return None");

  // Cleanup
  sqlx::query("DELETE FROM pdf_fonts WHERE sha256 = $1")
    .bind(&sha)
    .execute(&pool)
    .await
    .ok();
}

// ── inv_repo10 ────────────────────────────────────────────────────────────────
/// INV-REPO-10 (P-PDF-TPL-FONT-01-09): create → set_status(Approved) →
/// delete is a closed lifecycle. After delete, `get` returns `None` and the
/// row is gone from `list`. Calling `delete` a second time returns `false`
/// (idempotent on missing id) and `set_status` against an unknown id raises
/// `NotFound` rather than silently no-op-ing.
#[tokio::test]
async fn inv_repo10_font_lifecycle_status_and_delete() {
  let pool = setup_pool().await;
  let (user_id, _) = seed_user_workspace(&pool).await;
  let repo = PgPdfFontRepository::new(pool.clone());

  let sha = format!("sha256lifecycle{}", Uuid::new_v4().simple());
  let font = PdfFont {
    id: Uuid::new_v4(),
    family_name: "Lifecycle Family".to_owned(),
    style: "Italic".to_owned(),
    weight: 700,
    blob_key: format!("pdf-fonts/{sha}.woff2"),
    sha256: sha.clone(),
    license: PdfFontLicense::Ofl11,
    license_status: PdfFontLicenseStatus::Pending,
    uploaded_by: Some(user_id),
    uploaded_at: Utc::now(),
    approved_by: None,
    approved_at: None,
  };
  repo.create(&font, None).await.expect("create must succeed");

  repo
    .set_status(font.id, PdfFontLicenseStatus::Approved, Some(user_id), None, None)
    .await
    .expect("approve must succeed");

  let after_approve = repo
    .get(font.id)
    .await
    .expect("get must succeed")
    .expect("row must still exist after approve");
  assert_eq!(
    after_approve.license_status,
    PdfFontLicenseStatus::Approved,
    "INV-REPO-10: license_status must be Approved after set_status"
  );
  assert_eq!(
    after_approve.approved_by,
    Some(user_id),
    "INV-REPO-10: approved_by must equal the approver after Approved transition"
  );
  assert!(
    after_approve.approved_at.is_some(),
    "INV-REPO-10: approved_at must be populated after Approved transition"
  );

  let listed_approved = repo
    .list(Some(PdfFontLicenseStatus::Approved))
    .await
    .expect("list filtered must succeed");
  assert!(
    listed_approved.iter().any(|f| f.id == font.id),
    "INV-REPO-10: list(Approved) must include the approved row"
  );

  let removed = repo.delete(font.id, None).await.expect("delete must succeed");
  assert!(
    removed.is_some(),
    "INV-REPO-10: first delete must report `true` (row existed)"
  );

  let after_delete = repo.get(font.id).await.expect("get must succeed");
  assert!(after_delete.is_none(), "INV-REPO-10: get after delete must return None");

  let removed_again = repo.delete(font.id, None).await.expect("second delete must succeed");
  assert!(
    removed_again.is_none(),
    "INV-REPO-10: second delete must report `false` (idempotent on missing id)"
  );

  let set_unknown = repo
    .set_status(
      Uuid::new_v4(),
      PdfFontLicenseStatus::Approved,
      Some(user_id),
      None,
      None,
    )
    .await;
  assert!(
    matches!(set_unknown, Err(RepositoryError::NotFound(_))),
    "INV-REPO-10: set_status on unknown id must surface NotFound, got: {:?}",
    set_unknown
  );

  // Defensive cleanup if any branch above produced a stray row.
  sqlx::query("DELETE FROM pdf_fonts WHERE sha256 = $1")
    .bind(&sha)
    .execute(&pool)
    .await
    .ok();
}

// ── inv_repo11 ────────────────────────────────────────────────────────────────
/// INV-REPO-11 (P-PDF-TPL-COLOR-01-06): the system bootstrap inserts the full
/// RGB+CMYK profile set, each with `uploaded_by IS NULL`, persists matching
/// blobs, and is fully idempotent on a second invocation.
#[tokio::test]
async fn inv_repo11_icc_bootstrap_seeds_system_profiles_idempotently() {
  let pool = setup_pool().await;

  // Wipe any pre-existing system rows so the assertions below describe the
  // bootstrap effect, not whatever a previous test run left behind.
  sqlx::query("DELETE FROM pdf_icc_profiles WHERE name = ANY($1)")
    .bind(SYSTEM_ICC_PROFILE_NAMES)
    .execute(&pool)
    .await
    .expect("pre-test wipe of system seeds");

  let repo: std::sync::Arc<dyn PdfIccProfileRepository> =
    std::sync::Arc::new(PgPdfIccProfileRepository::new(pool.clone()));
  let op = Operator::new(Memory::default()).expect("memory op");
  let blob_store = std::sync::Arc::new(PdfBlobStore::new(op.clone()));

  // First invocation: must insert every bundled system profile.
  let inserted = seed_system_icc_profiles(repo.clone(), blob_store.clone())
    .await
    .expect("first bootstrap call must succeed");
  assert_eq!(
    inserted,
    SYSTEM_ICC_PROFILE_NAMES.len(),
    "INV-REPO-11: first bootstrap must insert the full bundled profile set"
  );

  // All system rows must have uploaded_by IS NULL, valid profile types, and
  // content-addressed blob keys.
  let rows = sqlx::query_as::<_, (String, Uuid, String, Option<Uuid>, String, String)>(
    "SELECT name, id, profile_type, uploaded_by, sha256, blob_key \
       FROM pdf_icc_profiles WHERE name = ANY($1) ORDER BY name",
  )
  .bind(SYSTEM_ICC_PROFILE_NAMES)
  .fetch_all(&pool)
  .await
  .expect("seed rows must exist after bootstrap");
  assert_eq!(
    rows.len(),
    SYSTEM_ICC_PROFILE_NAMES.len(),
    "INV-REPO-11: bootstrap must create every bundled ICC system row"
  );

  let mut saw_srgb = false;
  let mut saw_cmyk = 0usize;
  for (name, _id, profile_type, uploaded_by, sha256, blob_key) in rows {
    if profile_type == "sRGB" {
      saw_srgb = true;
    } else if profile_type == "CMYK" {
      saw_cmyk += 1;
    } else {
      panic!("INV-REPO-11: unexpected ICC profile_type {profile_type} for {name}");
    }
    assert!(
      uploaded_by.is_none(),
      "INV-REPO-11: system-seeded profile {name} must carry uploaded_by IS NULL"
    );
    assert_eq!(
      blob_key,
      format!("pdf-icc/{}.icc", sha256),
      "INV-REPO-11: blob_key must follow the pdf-icc/<sha256>.icc convention"
    );
    let blob_exists = op.stat(&blob_key).await.map(|_| true).unwrap_or(false);
    assert!(
      blob_exists,
      "INV-REPO-11: ICC blob for {name} must be persisted to the store at {blob_key}"
    );
  }
  assert!(saw_srgb, "INV-REPO-11: bootstrap must include an sRGB system profile");
  assert_eq!(
    saw_cmyk, 2,
    "INV-REPO-11: bootstrap must include both bundled CMYK profiles"
  );

  // Second invocation must be a no-op (returns 0, still exactly the same rows).
  let inserted_again = seed_system_icc_profiles(repo.clone(), blob_store.clone())
    .await
    .expect("second bootstrap call must succeed (idempotent)");
  assert_eq!(
    inserted_again, 0,
    "INV-REPO-11: second bootstrap must report zero inserted rows"
  );

  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pdf_icc_profiles WHERE name = ANY($1)")
    .bind(SYSTEM_ICC_PROFILE_NAMES)
    .fetch_one(&pool)
    .await
    .expect("count must succeed");
  assert_eq!(
    count,
    SYSTEM_ICC_PROFILE_NAMES.len() as i64,
    "INV-REPO-11: idempotent bootstrap must leave exactly the bundled system rows"
  );

  // Cleanup: remove the seeds so concurrent test runs start from a clean slate.
  sqlx::query("DELETE FROM pdf_icc_profiles WHERE name = ANY($1)")
    .bind(SYSTEM_ICC_PROFILE_NAMES)
    .execute(&pool)
    .await
    .ok();
}

// ── inv_repo12 ────────────────────────────────────────────────────────────────
/// INV-REPO-12 (P-THEME-DB): bundled fonts are not duplicated into
/// `pdf_fonts`. The PDF font repository is the operator upload add-on flow;
/// bundled Theme/PDF assets are owned by `font_families`/`font_assets`.
#[tokio::test]
async fn inv_repo12_pdf_font_repo_exposes_only_uploaded_addons() {
  let pool = setup_pool().await;
  let repo = PgPdfFontRepository::new(pool.clone());
  myoxus_infrastructure::branding::seed_system_theme_branding(&pool)
    .await
    .expect("Theme DB font catalog seed");

  let system_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pdf_fonts WHERE uploaded_by IS NULL")
    .fetch_one(&pool)
    .await
    .expect("count legacy system font rows");
  assert_eq!(
    system_rows, 0,
    "INV-REPO-12: bundled fonts must not be represented as pdf_fonts system rows"
  );

  let bundled_pdf_assets: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM font_assets fa \
       JOIN font_families ff ON ff.id = fa.family_id \
      WHERE ff.source = 'bundled' AND fa.usage = 'pdf' \
        AND fa.format IN ('variable_ttf','ttf','otf')",
  )
  .fetch_one(&pool)
  .await
  .expect("count Theme DB PDF font assets");
  assert!(
    bundled_pdf_assets >= 21,
    "INV-REPO-12: bundled PDF-capable fonts must live in font_assets, got {bundled_pdf_assets}"
  );

  let approved = repo
    .list(Some(PdfFontLicenseStatus::Approved))
    .await
    .expect("approved uploaded add-on font list");
  assert!(
    approved.iter().all(|font| font.uploaded_by.is_some()),
    "INV-REPO-12: pdfFonts must expose only uploaded add-ons, not bundled system fonts"
  );
}
