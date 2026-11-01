// SPDX-License-Identifier: AGPL-3.0-or-later
//! End-to-end invariants for the persisted Typst engine cutover.
//!
//! The suite deliberately uses the configured blob-storage port rather than
//! `PdfBlobStore`: the operator CLI and server must see the same keys through
//! the production abstraction. It runs serially against the isolated test
//! Postgres because the product migration owns the complete active admin
//! template set.

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tempfile::TempDir;
use tokio::time::sleep;
use uuid::Uuid;

use myoxus_application::ports::{BlobStoragePort, BlobWriteRequest};
use myoxus_infrastructure::pdf_export::{
  SYSTEM_TEMPLATE_SLUGS, TemplateEngineMigrationAction, TemplateEngineMigrationError, TemplateEngineMigrationService,
  seed_system_pdf_templates as seed_system_pdf_templates_from_root, verify_active_pdf_template_engines,
};
use myoxus_infrastructure::storage::{S3StorageConfig, StorageAdapter};
use myoxus_infrastructure::{pdf_export::PdfBlobStore, pdf_export::PgPdfTemplateRepository};

const DEFAULT_TEST_DATABASE_URL: &str = "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test";
const REQUIRED_FILES: &[(&str, &[u8])] = &[
  ("main.typ", include_bytes!("../../../templates/pdf/default/main.typ")),
  (
    "preamble.typ",
    include_bytes!("../../../templates/pdf/default/preamble.typ"),
  ),
  ("theme.typ", include_bytes!("../../../templates/pdf/default/theme.typ")),
  (
    "i18n/en.json",
    include_bytes!("../../../templates/pdf/default/i18n/en.json"),
  ),
  (
    "i18n/de.json",
    include_bytes!("../../../templates/pdf/default/i18n/de.json"),
  ),
];

fn isolated_database_url() -> String {
  let url = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| DEFAULT_TEST_DATABASE_URL.to_owned());
  let options = PgConnectOptions::from_str(&url).expect("TEST_DATABASE_URL must be a PostgreSQL URL");
  assert_eq!(options.get_database(), Some("myoxus_test"));
  assert_eq!(
    options.get_port(),
    5434,
    "migration tests may only use the isolated test stack"
  );
  url
}

async fn setup() -> (PgPool, TempDir, Arc<dyn BlobStoragePort>, Uuid) {
  let pool = PgPoolOptions::new()
    .max_connections(8)
    .connect(&isolated_database_url())
    .await
    .expect("connect isolated Postgres");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("apply migrations");

  // This suite owns the complete admin-template set because the production
  // command does too. The dedicated serial matrix suite prevents overlap.
  sqlx::query(
    "DELETE FROM pdf_workspace_template_assignments WHERE template_id IN \
     (SELECT id FROM pdf_templates WHERE slug = ANY($1))",
  )
  .bind(SYSTEM_TEMPLATE_SLUGS.to_vec())
  .execute(&pool)
  .await
  .expect("remove stale system-template assignments");
  sqlx::query("DELETE FROM pdf_templates WHERE slug = ANY($1)")
    .bind(SYSTEM_TEMPLATE_SLUGS.to_vec())
    .execute(&pool)
    .await
    .expect("remove stale system-template fixtures");
  sqlx::query(
    "DELETE FROM pdf_workspace_template_assignments WHERE template_id IN \
     (SELECT id FROM pdf_templates WHERE created_by IS NOT NULL)",
  )
  .execute(&pool)
  .await
  .expect("remove stale admin-template assignments");
  sqlx::query("DELETE FROM pdf_templates WHERE created_by IS NOT NULL")
    .execute(&pool)
    .await
    .expect("remove stale admin-template fixtures");
  let user_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'PDF migration owner', 'active')")
    .bind(user_id)
    .bind(format!("pdf-engine-migration-{user_id}@example.test"))
    .execute(&pool)
    .await
    .expect("create migration owner");

  let storage = TempDir::new().expect("create isolated blob root");
  let blobs: Arc<dyn BlobStoragePort> = Arc::new(
    StorageAdapter::new_fs(storage.path().to_str().expect("UTF-8 blob root")).expect("create filesystem storage"),
  );
  (pool, storage, blobs, user_id)
}

fn template_manifest(slug: &str, engine: &str) -> Value {
  let mut manifest: Value = serde_json::from_slice(include_bytes!("../../../templates/pdf/default/manifest.json"))
    .expect("bundled default manifest");
  manifest["id"] = Value::String(slug.to_owned());
  manifest["name"] = Value::String(format!("Migration fixture {slug}"));
  manifest["engine"]["version"] = Value::String(engine.to_owned());
  manifest
}

async fn insert_template(
  pool: &PgPool,
  blobs: &Arc<dyn BlobStoragePort>,
  owner_id: Uuid,
  slug: &str,
  engine: &str,
) -> (Uuid, Value) {
  let template_id = Uuid::new_v4();
  let manifest = template_manifest(slug, engine);
  sqlx::query(
    "INSERT INTO pdf_templates (id, slug, name, version, schema_version, manifest, created_by) \
     VALUES ($1, $2, $3, '1.3.0', '2.0', $4, $5)",
  )
  .bind(template_id)
  .bind(slug)
  .bind(format!("Migration fixture {slug}"))
  .bind(&manifest)
  .bind(owner_id)
  .execute(pool)
  .await
  .expect("insert template");

  for (path, body) in REQUIRED_FILES {
    let key = format!("pdf-templates/{template_id}/{path}");
    blobs
      .write_blob(BlobWriteRequest {
        key: key.clone(),
        content_type: None,
        body: Bytes::copy_from_slice(body),
      })
      .await
      .expect("write template blob");
    sqlx::query(
      "INSERT INTO pdf_template_files (template_id, file_path, blob_key, content_hash) VALUES ($1, $2, $3, $4)",
    )
    .bind(template_id)
    .bind(path)
    .bind(key)
    .bind(format!("{:x}", Sha256::digest(body)))
    .execute(pool)
    .await
    .expect("insert template file row");
  }
  (template_id, manifest)
}

async fn manifest(pool: &PgPool, template_id: Uuid) -> Value {
  sqlx::query_scalar("SELECT manifest FROM pdf_templates WHERE id = $1")
    .bind(template_id)
    .fetch_one(pool)
    .await
    .expect("read template manifest")
}

async fn cleanup(pool: &PgPool, owner_id: Uuid) {
  sqlx::query(
    "DELETE FROM pdf_workspace_template_assignments WHERE template_id IN \
     (SELECT id FROM pdf_templates WHERE created_by = $1)",
  )
  .bind(owner_id)
  .execute(pool)
  .await
  .expect("clean template assignments");
  sqlx::query("DELETE FROM pdf_templates WHERE created_by = $1")
    .bind(owner_id)
    .execute(pool)
    .await
    .expect("clean template fixtures");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(owner_id)
    .execute(pool)
    .await
    .expect("clean migration owner");
}

#[tokio::test]
async fn engine_migration_is_atomic_and_preserves_template_bundles() {
  let (pool, _storage, blobs, owner_id) = setup().await;
  let (first_id, first_before) = insert_template(&pool, &blobs, owner_id, "migration-alpha", "0.14.x").await;
  let (second_id, second_before) = insert_template(&pool, &blobs, owner_id, "migration-beta", "0.14.2").await;
  let service = TemplateEngineMigrationService::new(pool.clone(), blobs.clone());

  let dry_run = service.preflight("0.14", "0.15").await.expect("compatible dry-run");
  assert!(dry_run.dry_run);
  assert_eq!(dry_run.migrated, 2);
  assert!(
    dry_run
      .templates
      .iter()
      .all(|item| item.action == TemplateEngineMigrationAction::Migrate
        && item.file_hashes.len() == 5
        && item.compiled)
  );
  assert_eq!(manifest(&pool, first_id).await, first_before, "dry-run must not write");
  assert_eq!(
    manifest(&pool, second_id).await,
    second_before,
    "dry-run must not write"
  );

  let confirmed = service.confirm("0.14", "0.15").await.expect("atomic confirm");
  assert!(!confirmed.dry_run);
  assert_eq!(confirmed.migrated, 2);
  for (template_id, before) in [(first_id, first_before), (second_id, second_before)] {
    let after = manifest(&pool, template_id).await;
    let mut expected = before;
    expected["engine"]["version"] = Value::String("0.15.x".to_owned());
    assert_eq!(after, expected, "only /engine/version may change");
    for (path, bytes) in REQUIRED_FILES {
      let key: String =
        sqlx::query_scalar("SELECT blob_key FROM pdf_template_files WHERE template_id = $1 AND file_path = $2")
          .bind(template_id)
          .bind(path)
          .fetch_one(&pool)
          .await
          .expect("read retained blob key");
      assert_eq!(
        blobs.read_blob(&key).await.expect("read retained blob").data.as_ref(),
        *bytes
      );
    }
  }
  cleanup(&pool, owner_id).await;
}

#[tokio::test]
async fn incompatible_or_changed_bundle_leaves_every_manifest_unchanged() {
  let (pool, _storage, blobs, owner_id) = setup().await;
  let (compatible_id, compatible_before) =
    insert_template(&pool, &blobs, owner_id, "migration-compatible", "0.14.x").await;
  let (incompatible_id, incompatible_before) =
    insert_template(&pool, &blobs, owner_id, "migration-incompatible", "0.13.x").await;
  let service = TemplateEngineMigrationService::new(pool.clone(), blobs.clone());

  assert!(matches!(
    service.confirm("0.14", "0.15").await,
    Err(TemplateEngineMigrationError::IncompatibleEngine { template_id, .. }) if template_id == incompatible_id
  ));
  assert_eq!(manifest(&pool, compatible_id).await, compatible_before);
  assert_eq!(manifest(&pool, incompatible_id).await, incompatible_before);

  sqlx::query("UPDATE pdf_templates SET deleted_at = now() WHERE id = $1")
    .bind(incompatible_id)
    .execute(&pool)
    .await
    .expect("exclude incompatible fixture");
  sqlx::query(
    "UPDATE pdf_template_files SET content_hash = 'tampered' WHERE template_id = $1 AND file_path = 'main.typ'",
  )
  .bind(compatible_id)
  .execute(&pool)
  .await
  .expect("simulate concurrent file metadata drift");
  assert!(matches!(
    service.confirm("0.14", "0.15").await,
    Err(TemplateEngineMigrationError::ContentHashMismatch { template_id, .. }) if template_id == compatible_id
  ));
  assert_eq!(manifest(&pool, compatible_id).await, compatible_before);
  cleanup(&pool, owner_id).await;
}

#[tokio::test]
async fn concurrent_manifest_write_aborts_publication_and_startup_guard_tracks_cutover() {
  let (pool, _storage, blobs, owner_id) = setup().await;
  let missing_system_error = verify_active_pdf_template_engines(&pool)
    .await
    .expect_err("a server without stable system templates must not become ready");
  assert!(
    missing_system_error
      .to_string()
      .contains("required system PDF template")
  );
  let (template_id, before) = insert_template(&pool, &blobs, owner_id, "migration-race", "0.14.x").await;

  // Seed the three stable binary-owned templates so the guard's only failure
  // is the deliberately old administrator template.
  let fs_adapter =
    StorageAdapter::new_fs(_storage.path().to_str().expect("UTF-8 blob root")).expect("create seed storage adapter");
  let repository = Arc::new(PgPdfTemplateRepository::new(pool.clone()));
  seed_system_pdf_templates(repository, Arc::new(PdfBlobStore::new(fs_adapter.operator())))
    .await
    .expect("seed current system templates");
  assert!(verify_active_pdf_template_engines(&pool).await.is_err());

  let mut blocker = pool.begin().await.expect("begin race transaction");
  // Hold a table-level SHARE lock so confirm completes its external preflight
  // but cannot acquire the publication lock until this simulated
  // administrator write commits.
  sqlx::query("LOCK TABLE pdf_templates IN SHARE MODE")
    .execute(&mut *blocker)
    .await
    .expect("hold migration publication lock");

  let service = TemplateEngineMigrationService::new(pool.clone(), blobs.clone());
  let task = tokio::spawn(async move { service.confirm("0.14", "0.15").await });
  let mut reached_lock = false;
  for _ in 0..100 {
    let waiting: i64 = sqlx::query_scalar(
      "SELECT count(*) FROM pg_stat_activity \
       WHERE datname = current_database() AND query LIKE 'LOCK TABLE pdf_templates%' \
         AND wait_event_type = 'Lock'",
    )
    .fetch_one(&pool)
    .await
    .expect("inspect waiting migration transaction");
    if waiting > 0 {
      reached_lock = true;
      break;
    }
    sleep(Duration::from_millis(50)).await;
  }
  assert!(reached_lock, "confirm must reach the locked publication snapshot");

  let mut concurrent = before.clone();
  concurrent["description"] = Value::String("Concurrent administrator edit".to_owned());
  sqlx::query("UPDATE pdf_templates SET manifest = $2 WHERE id = $1")
    .bind(template_id)
    .bind(&concurrent)
    .execute(&mut *blocker)
    .await
    .expect("publish concurrent edit");
  blocker.commit().await.expect("commit concurrent edit");

  assert!(matches!(
    task.await.expect("join migration task"),
    Err(TemplateEngineMigrationError::ConcurrentChange)
  ));
  assert_eq!(manifest(&pool, template_id).await, concurrent);

  let service = TemplateEngineMigrationService::new(pool.clone(), blobs);
  service.confirm("0.14", "0.15").await.expect("retry after drift");
  assert!(verify_active_pdf_template_engines(&pool).await.is_ok());

  cleanup(&pool, owner_id).await;
  for slug in SYSTEM_TEMPLATE_SLUGS {
    sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE template_id IN (SELECT id FROM pdf_templates WHERE slug = $1)")
      .bind(slug)
      .execute(&pool)
      .await
      .expect("clean system template assignments");
    sqlx::query("DELETE FROM pdf_templates WHERE slug = $1")
      .bind(slug)
      .execute(&pool)
      .await
      .expect("clean system template fixture");
  }
}

#[tokio::test]
async fn configured_s3_storage_materialises_the_same_atomic_cutover() {
  let (pool, _storage, _filesystem_blobs, owner_id) = setup().await;
  let prefix = format!("pdf-engine-migration-test/{}/", Uuid::new_v4());
  let s3: Arc<dyn BlobStoragePort> = Arc::new(
    StorageAdapter::new_s3(
      S3StorageConfig {
        bucket: &std::env::var("MINIO_BUCKET").unwrap_or_else(|_| "myoxus-ci".to_owned()),
        prefix: Some(&prefix),
        endpoint: Some(&std::env::var("MINIO_ENDPOINT").unwrap_or_else(|_| "http://localhost:9000".to_owned())),
        region: Some(&std::env::var("MINIO_REGION").unwrap_or_else(|_| "us-east-1".to_owned())),
        access_key: Some(&std::env::var("MINIO_ACCESS_KEY").unwrap_or_else(|_| "minioadmin".to_owned())),
        secret_key: Some(&std::env::var("MINIO_SECRET_KEY").unwrap_or_else(|_| "minioadmin".to_owned())),
        io_timeout_seconds: Some(10),
        max_retries: Some(2),
      },
      None,
    )
    .expect("create isolated MinIO adapter"),
  );
  let (template_id, before) = insert_template(&pool, &s3, owner_id, "migration-minio", "0.14.x").await;
  let service = TemplateEngineMigrationService::new(pool.clone(), s3.clone());

  let preview = service.preflight("0.14", "0.15").await.expect("MinIO dry-run");
  assert_eq!(preview.migrated, 1);
  assert_eq!(manifest(&pool, template_id).await, before);
  service.confirm("0.14", "0.15").await.expect("MinIO confirm");
  assert_eq!(manifest(&pool, template_id).await["engine"]["version"], "0.15.x");

  for (path, _) in REQUIRED_FILES {
    s3.delete_blob(&format!("pdf-templates/{template_id}/{path}"))
      .await
      .expect("clean MinIO fixture blob");
  }
  cleanup(&pool, owner_id).await;
}

async fn seed_system_pdf_templates(
  repository: Arc<dyn myoxus_domain::repositories::PdfTemplateRepository>,
  blob_store: Arc<PdfBlobStore>,
) -> Result<usize, myoxus_domain::repositories::RepositoryError> {
  seed_system_pdf_templates_from_root(
    repository,
    blob_store,
    &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/pdf"),
    16 * 1024 * 1024,
    std::time::Duration::from_secs(120),
  )
  .await
}
