// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariant tests for the PDF template registry trait + caching wrapper
//! (`P-PDF-TPL-06-05`, `P-PDF-TPL-06-06`).
//!
//! `inv_reg01` covers the DB-backed [`PgPdfTemplateRegistry`]: it must
//! materialise the manifest *and* every bundle file from the blob store
//! into a [`LoadedTemplate`] without leaking storage layer types.
//!
//! `inv_reg02` covers the cache wrapper: cached entries hide DB mutations
//! until [`PdfTemplateRegistry::invalidate`] is called, and the next load
//! after an invalidation must re-fetch from the inner registry.

use sqlx::postgres::PgConnectOptions;
use std::str::FromStr;
use std::sync::Arc;

use opendal::Operator;
use opendal::services::Memory;
use sqlx::PgPool;
use uuid::Uuid;

use myoxus_domain::entities::{PdfTemplate, PdfTemplateFile};
use myoxus_domain::repositories::PdfTemplateRepository;
use myoxus_infrastructure::pdf_export::{
  CachingPdfTemplateRegistry, PdfBlobStore, PgPdfTemplateRegistry, PgPdfTemplateRepository,
};
use myoxus_pdf_export::template_v2::PdfTemplateRegistry;

async fn setup_pool() -> PgPool {
  let database_url =
    std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL must be set for pdf_template_registry tests");
  let options = PgConnectOptions::from_str(&database_url).expect("test database URL");
  assert_eq!(options.get_database(), Some("myoxus_test"));
  assert_eq!(options.get_port(), 5434, "registry tests require the isolated stack");
  let pool = PgPool::connect(&database_url)
    .await
    .expect("postgres must be reachable");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrations must succeed");
  pool
}

async fn seed_user(pool: &PgPool) -> Uuid {
  let user_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(format!("registry-test-{user_id}@example.test"))
    .bind("Registry Test User")
    .execute(pool)
    .await
    .expect("seed user");
  user_id
}

/// Minimal valid V2 manifest JSON — enough for `serde_json::from_value` to
/// succeed against `PdfTemplateManifest` without the file actually
/// containing every L2 field. Keep the language `en` so the
/// validate_locale check passes.
fn minimal_manifest_v2(id: &str) -> serde_json::Value {
  serde_json::json!({
    "schema_version": "2.0",
    "id": id,
    "name": "Test Template",
    "description": "Used by registry invariant tests",
    "version": "1.0.0",
    "engine": { "name": "typst", "version": "0.15.x" },
    "provenance": {
      "license_spdx": "AGPL-3.0-or-later",
      "copyright_notice": "Copyright 2026 Myoxus test contributors",
      "source_url": "https://example.test/templates/registry-test",
      "source_revision": "1.0.0"
    },
    "entry": "main.typ",
    "assets": ["main.typ", "theme.typ"],
    "capabilities": {
      "colorVariant": { "kind": "enum", "values": ["mono"], "default": "mono" },
      "headerStyle": { "kind": "enum", "values": ["none"], "default": "none" },
      "footerStyle": { "kind": "enum", "values": ["none"], "default": "none" },
      "coverPage": { "kind": "boolean", "default": false },
      "tocBehavior": { "kind": "enum", "values": ["off"], "default": "off" },
      "pageNumbering": { "kind": "enum", "values": ["arabic"], "default": "arabic" },
      "customMargins": { "kind": "boolean", "default": false },
      "accentColor": { "kind": "color", "default": "#000000" },
      "confidentialityLabels": {
        "kind": "array<string>",
        "min_items": 0,
        "max_items": 0,
        "item_pattern": "^.*$",
        "default": []
      },
      "language": { "kind": "enum", "values": ["en"], "default": "en" }
    },
    "inputs_schema": { "type": "object", "properties": {}, "required": [] }
  })
}

// ── inv_reg01 ─────────────────────────────────────────────────────────────────
/// INV-REG-01 (P-PDF-TPL-06-05): `PgPdfTemplateRegistry::load` returns a
/// `LoadedTemplate` with the manifest deserialised into the typed
/// `PdfTemplateManifest` and every referenced bundle file materialised from
/// the blob store with byte-exact content.
#[tokio::test]
async fn inv_reg01_load_returns_files_from_blob_store() {
  let pool = setup_pool().await;
  let user_id = seed_user(&pool).await;

  let slug = format!("inv-reg01-{}", Uuid::new_v4().simple());
  let manifest = minimal_manifest_v2(&slug);

  let blob_store = Arc::new(PdfBlobStore::new(Operator::new(Memory::default()).expect("memory op")));

  // Upload two bundle files and capture their (blob_key, sha256) pairs.
  let template_id = Uuid::new_v4();
  let main_bytes = b"// main.typ\n#set page(paper: \"a4\")\n";
  let theme_bytes = b"// theme.typ\n#let accent = rgb(\"#000000\")\n";
  let (main_key, main_sha) = blob_store
    .put_template_file(template_id, "main.typ", main_bytes)
    .await
    .expect("put main.typ");
  let (theme_key, theme_sha) = blob_store
    .put_template_file(template_id, "theme.typ", theme_bytes)
    .await
    .expect("put theme.typ");

  // Persist the template + file rows.
  let tpl_repo: Arc<dyn PdfTemplateRepository> = Arc::new(PgPdfTemplateRepository::new(pool.clone()));
  let tpl = PdfTemplate {
    id: template_id,
    slug: slug.clone(),
    name: "Registry Test".to_owned(),
    version: "1.0.0".to_owned(),
    schema_version: "2.0".to_owned(),
    manifest: manifest.clone(),
    created_by: Some(user_id),
    created_at: chrono::Utc::now(),
    deleted_at: None,
  };
  let files = vec![
    PdfTemplateFile {
      template_id,
      file_path: "main.typ".to_owned(),
      blob_key: main_key,
      content_hash: main_sha,
    },
    PdfTemplateFile {
      template_id,
      file_path: "theme.typ".to_owned(),
      blob_key: theme_key,
      content_hash: theme_sha,
    },
  ];
  tpl_repo.create(&tpl, &files, None).await.expect("create template");

  let registry = PgPdfTemplateRegistry::new(pool.clone(), tpl_repo, blob_store);
  let loaded = registry.load(template_id).await.expect("load must succeed");

  assert_eq!(loaded.id, template_id, "INV-REG-01: id must round-trip");
  assert_eq!(loaded.slug, slug, "INV-REG-01: slug must round-trip");
  assert_eq!(loaded.manifest.id, slug, "INV-REG-01: manifest.id must round-trip");
  assert_eq!(
    loaded.files.len(),
    2,
    "INV-REG-01: every referenced file must be materialised"
  );
  assert_eq!(
    loaded.files.get("main.typ").map(|v| v.as_slice()),
    Some(main_bytes.as_slice()),
    "INV-REG-01: main.typ bytes must match what was uploaded"
  );
  assert_eq!(
    loaded.files.get("theme.typ").map(|v| v.as_slice()),
    Some(theme_bytes.as_slice()),
    "INV-REG-01: theme.typ bytes must match what was uploaded"
  );

  // Cleanup.
  sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
    .bind(template_id)
    .execute(&pool)
    .await
    .expect("cleanup test-owned registry row");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("cleanup test-owned registry row");
}

// ── inv_reg02 ─────────────────────────────────────────────────────────────────
/// INV-REG-02 (P-PDF-TPL-06-06): the caching wrapper holds the first
/// snapshot until invalidated. We mutate the underlying manifest after a
/// cached load and confirm the wrapper still serves the original until
/// `invalidate` is called, after which the fresh row is loaded.
#[tokio::test]
async fn inv_reg02_caching_wrapper_invalidate_clears_local_snapshot() {
  let pool = setup_pool().await;
  let user_id = seed_user(&pool).await;

  let slug = format!("inv-reg02-{}", Uuid::new_v4().simple());
  let mut manifest = minimal_manifest_v2(&slug);
  manifest["name"] = serde_json::json!("Original Name");

  let blob_store = Arc::new(PdfBlobStore::new(Operator::new(Memory::default()).expect("memory op")));
  let template_id = Uuid::new_v4();
  let (main_key, main_sha) = blob_store
    .put_template_file(template_id, "main.typ", b"x")
    .await
    .expect("put main");

  let tpl_repo: Arc<dyn PdfTemplateRepository> = Arc::new(PgPdfTemplateRepository::new(pool.clone()));
  let tpl = PdfTemplate {
    id: template_id,
    slug: slug.clone(),
    name: "Registry Cache Test".to_owned(),
    version: "1.0.0".to_owned(),
    schema_version: "2.0".to_owned(),
    manifest: manifest.clone(),
    created_by: Some(user_id),
    created_at: chrono::Utc::now(),
    deleted_at: None,
  };
  tpl_repo
    .create(
      &tpl,
      &[PdfTemplateFile {
        template_id,
        file_path: "main.typ".to_owned(),
        blob_key: main_key,
        content_hash: main_sha,
      }],
      None,
    )
    .await
    .expect("create template");

  let inner: Arc<dyn PdfTemplateRegistry> =
    Arc::new(PgPdfTemplateRegistry::new(pool.clone(), tpl_repo.clone(), blob_store));
  let cached = CachingPdfTemplateRegistry::new(inner, None, Uuid::new_v4());

  // First load populates the cache with the original manifest.
  let first = cached.load(template_id).await.expect("first load");
  assert_eq!(
    first.manifest.name, "Original Name",
    "INV-REG-02: first load must reflect the original manifest"
  );

  // Mutate the underlying manifest. Without cache invalidation, the wrapper
  // must still return the original snapshot.
  let mut bumped = manifest.clone();
  bumped["name"] = serde_json::json!("Bumped Name");
  tpl_repo
    .update_manifest(template_id, &bumped)
    .await
    .expect("update_manifest");

  let still_cached = cached.load(template_id).await.expect("second load");
  assert_eq!(
    still_cached.manifest.name, "Original Name",
    "INV-REG-02: cached wrapper must hide DB mutations until invalidated"
  );

  // Invalidate locally; the next load must reflect the fresh DB state.
  cached.invalidate(template_id).await.expect("invalidate");
  let after_invalidate = cached.load(template_id).await.expect("third load");
  assert_eq!(
    after_invalidate.manifest.name, "Bumped Name",
    "INV-REG-02: after invalidate the next load must reflect the fresh manifest"
  );

  // Cleanup.
  sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
    .bind(template_id)
    .execute(&pool)
    .await
    .expect("cleanup test-owned registry row");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("cleanup test-owned registry row");
}
