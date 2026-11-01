//! Integration tests for the Template Registry (P40-C).
//!
//! Tests the template lifecycle: import, publish, duplicate handling,
//! validation, assignment, and revision deprecation.

use crate::helpers;

use axum::{body::Body, http::Request};
use bytes::Bytes;
use chrono::Utc;
use http_body_util::BodyExt;
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::ports::{
  BlobReadResponse, BlobStoragePort, BlobWriteRequest, MultipartCompleteRequest, MultipartCreateRequest,
  MultipartCreateResponse, MultipartPartUrlRequest, MultipartPartUrlResponse, PortError, PortResult,
};
use myoxus_application::{
  admin::AdminService,
  auth::AuthService,
  doc::{
    ASSIGNED_TEMPLATE_SOURCE_PROTECTED, DocService, DocSpaceKind, PageLifecycleService, PermanentDeleteMode,
    PermanentDeleteRequest, PermanentDeleteStatus,
  },
  ports::blob_service::BlobService,
  template_registry::{
    TEMPLATE_IMPORT_FORMAT_REJECTED_EVENT, TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION, TemplateRegistryAuditEventFilter,
    TemplateRegistryService,
  },
  workspace::WorkspaceService,
};
use myoxus_infrastructure::{
  admin::SqlxAdminStore, auth::SqlxAuthStore, blob::SqlxBlobStore, doc::SqlxDocStore,
  document_metadata::PgDocumentMetadataRepository, workspace::SqlxWorkspaceStore,
};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use myoxus_application::template_registry::TemplateRegistryStore as _;
use myoxus_domain::template_registry::{
  RevisionState, TemplateCatalogEntry, TemplateRegistryAuditAction, TemplateRegistryAuditEvent, TemplateRevision,
  TemplateRevisionId, TemplateSource, TemplateStatus, compute_builtin_expected_hash,
};
use myoxus_domain::{entities::DocumentMetadataPatch, repositories::DocumentMetadataRepository as _};
use myoxus_infrastructure::template_registry::SqlxTemplateRegistryStore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

/// Load guide fixtures from the same native configuration as release delivery.
/// The cutover cases select retained initial revisions to model old readers;
/// current seeding uses only configured new-workspace exports.
fn guide_bundle_fixtures(current: bool) -> Vec<Vec<u8>> {
  use myoxus_application::template_registry::bundle::{self, TemplatePurpose};
  use myoxus_domain::feature_bundle::{FeatureBundleSource, FeatureComponentKind};
  let base: FeatureBundleSource = myoxus_contracts::config_document::decode_typed_yaml_document(include_str!(
    "../../../../templates/features/base/manifest.yaml"
  ))
  .unwrap();
  let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates");
  base
    .components
    .iter()
    .filter(|component| component.kind == FeatureComponentKind::DocumentTemplate)
    .filter(|component| {
      !current
        || base.exports.iter().any(|export| {
          export.source.component == component.id
            && export
              .document
              .as_ref()
              .is_some_and(|policy| policy.new_workspace_default)
        })
    })
    .filter_map(|component| {
      let bytes = std::fs::read(root.join(&component.path)).unwrap();
      let parsed = bundle::parse_bundle(&bytes).unwrap();
      if parsed.manifest.purpose != Some(TemplatePurpose::Guide) {
        return None;
      }
      if !current
        && myoxus_application::template_registry::released_system_baseline_version(&parsed.manifest.template_id)
          != Some(parsed.manifest.version.as_str())
      {
        return None;
      }
      Some(bytes)
    })
    .collect()
}

/// Create a valid template ZIP bundle with the given metadata.
fn create_test_bundle(slug: &str, version: &str, title: &str) -> Vec<u8> {
  create_test_bundle_with_content_and_preview(slug, version, title, &valid_template_content(), None)
}

fn create_test_bundle_with_preview(slug: &str, version: &str, title: &str, preview: Option<&[u8]>) -> Vec<u8> {
  create_test_bundle_with_content_and_preview(slug, version, title, &valid_template_content(), preview)
}

fn valid_template_content() -> Vec<u8> {
  yjs::markdown_to_yjs("Template", "Validated template content").expect("valid native template content")
}

fn create_test_bundle_with_content(slug: &str, version: &str, title: &str, content: &[u8]) -> Vec<u8> {
  create_test_bundle_with_content_and_preview(slug, version, title, content, None)
}

fn create_test_bundle_with_content_and_preview(
  slug: &str,
  version: &str,
  title: &str,
  content: &[u8],
  preview: Option<&[u8]>,
) -> Vec<u8> {
  let manifest = serde_json::json!({
      "template_id": slug,
      "version": version,
      "title": title,
      "description": "Test template",
      "category": "test"
  });
  let mut buf = Vec::new();
  {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    zip
      .start_file("manifest.json", zip::write::FileOptions::<()>::default())
      .expect("test setup");
    write!(zip, "{}", manifest).expect("zip write failed");
    zip
      .start_file("content.template.zip", zip::write::FileOptions::<()>::default())
      .expect("test setup");
    zip.write_all(content).expect("zip write_all failed");
    if let Some(preview) = preview {
      zip
        .start_file("preview.svg", zip::write::FileOptions::<()>::default())
        .expect("test setup");
      zip.write_all(preview).expect("zip write_all failed");
    }
    zip.finish().expect("zip finish failed");
  }
  buf
}

fn create_test_bundle_with_ignored_entries(slug: &str, version: &str, title: &str) -> Vec<u8> {
  let manifest = serde_json::json!({
      "template_id": slug,
      "version": version,
      "title": title,
      "description": "Test template",
      "category": "test"
  });
  let content = valid_template_content();
  let mut buf = Vec::new();
  {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let options = zip::write::FileOptions::<()>::default();
    zip.start_file("manifest.json", options).expect("test setup");
    write!(zip, "{}", manifest).expect("zip write failed");
    zip.start_file("content.template.zip", options).expect("test setup");
    zip.write_all(&content).expect("zip write_all failed");
    zip
      .start_file("__MACOSX/._content.template.zip", options)
      .expect("test setup");
    zip.write_all(b"noise").expect("zip write_all failed");
    zip.finish().expect("zip finish failed");
  }
  buf
}

fn create_path_traversal_bundle(slug: &str, version: &str, title: &str) -> Vec<u8> {
  let manifest = serde_json::json!({
      "template_id": slug,
      "version": version,
      "title": title,
      "description": "Test template",
      "category": "test"
  });
  let mut buf = Vec::new();
  {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let options = zip::write::FileOptions::<()>::default();
    zip.start_file("manifest.json", options).expect("test setup");
    write!(zip, "{}", manifest).expect("zip write failed");
    zip.start_file("../evil.txt", options).expect("test setup");
    zip.write_all(b"evil").expect("zip write_all failed");
    zip.finish().expect("zip finish failed");
  }
  buf
}

fn create_raw_workspace_bundle() -> Vec<u8> {
  let snapshot = valid_template_content();
  let mut buf = Vec::new();
  {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let options = zip::write::FileOptions::<()>::default();
    zip.start_file("doc-data/abc.snapshot", options).expect("test setup");
    zip.write_all(&snapshot).expect("zip write_all failed");
    zip.finish().expect("zip finish failed");
  }
  buf
}

fn create_upstream_snapshot_bundle() -> Vec<u8> {
  let mut buf = Vec::new();
  {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let options = zip::write::FileOptions::<()>::default();
    zip
      .start_file("workspace/page:home.snapshot.json", options)
      .expect("test setup");
    zip
      .write_all(br#"{"meta":{"id":"page:home","title":"Portable template"},"blocks":{"type":"block","id":"page","flavour":"affine:page","props":{},"children":[]}}"#)
      .expect("zip write_all failed");
    zip.finish().expect("zip finish failed");
  }
  buf
}

fn create_invalid_upstream_snapshot_bundle() -> Vec<u8> {
  let mut buf = Vec::new();
  {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let options = zip::write::FileOptions::<()>::default();
    zip
      .start_file("workspace/page:home.snapshot.json", options)
      .expect("test setup");
    zip
      .write_all(br#"{"meta":{"id":"page:home""#)
      .expect("zip write_all failed");
    zip.finish().expect("zip finish failed");
  }
  buf
}

fn create_upstream_snapshot_bundle_with_missing_asset_ref() -> Vec<u8> {
  let mut buf = Vec::new();
  {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let options = zip::write::FileOptions::<()>::default();
    zip
      .start_file("workspace/page:home.snapshot.json", options)
      .expect("test setup");
    zip
      .write_all(br#"{"meta":{"id":"page:home"},"blocks":[{"props":{"sourceId":"asset-missing.bin"}}]}"#)
      .expect("zip write_all failed");
    zip.finish().expect("zip finish failed");
  }
  buf
}

fn create_upstream_snapshot_bundle_with_virgultum_tokens() -> Vec<u8> {
  let mut buf = Vec::new();
  {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let options = zip::write::FileOptions::<()>::default();
    zip
      .start_file("workspace/page:home.snapshot.json", options)
      .expect("test setup");
    zip
      .write_all(
        br#"{"meta":{"id":"page:home","flavour":"affine:page"},"blocks":{"type":"block","id":"page","flavour":"affine:page","props":{"sys:children":[],"prop:locked":false},"children":[]}}"#,
      )
      .expect("zip write_all failed");
    zip.finish().expect("zip finish failed");
  }
  buf
}

fn create_snapshot_like_bundle_without_snapshot_entry() -> Vec<u8> {
  let mut buf = Vec::new();
  {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let options = zip::write::FileOptions::<()>::default();
    zip.start_file("workspace/info.json", options).expect("test setup");
    zip.write_all(br#"{"name":"fixture"}"#).expect("zip write_all failed");
    zip.start_file("assets/asset-1.bin", options).expect("test setup");
    zip.write_all(b"asset-data").expect("zip write_all failed");
    zip.finish().expect("zip finish failed");
  }
  buf
}

async fn setup_graphql_template_registry_app() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = helpers::setup_pool().await;
  let config = AppConfig::load().expect("AppConfig::load failed");
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let storage: Arc<dyn BlobStoragePort> = Arc::new(helpers::DummyStorage);

  let auth_service = AuthService::new(
    auth_store.clone(),
    Arc::new(myoxus_infrastructure::mail::LogMailAdapter),
    storage.clone(),
    config.server.session_ttl,
    config.server.session_ttr,
  );
  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);
  let blob_service = Arc::new(BlobService::new(blob_store, storage.clone(), "test-key".to_string()));
  let template_service = TemplateRegistryService::new(Arc::new(SqlxTemplateRegistryStore::new(pool.clone())));

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
  .with_document_metadata_service(myoxus_application::document_metadata::DocumentMetadataService::new(
    Arc::new(PgDocumentMetadataRepository::new(pool.clone())),
  ))
  .with_template_registry_service(template_service)
  .with_audit_recorder(myoxus_application::audit::AuditRecorder::new(Arc::new(
    myoxus_infrastructure::audit::PgAuditLogStore::new(pool.clone()),
  )));

  // Ensure template registry is enabled (previous test runs may have left it disabled)
  sqlx::query("DELETE FROM app_configs WHERE id = 'template_registry.enabled'")
    .execute(&pool)
    .await
    .expect("reset template registry configuration");

  state
    .refresh_config_overrides()
    .await
    .expect("refresh template registry configuration");

  (build_router(state), pool, auth_store)
}

async fn setup_template_registry_export_app() -> (axum::Router, PgPool, Arc<SqlxAuthStore>, Arc<TestBlobStorage>) {
  let pool = helpers::setup_pool().await;
  let config = AppConfig::load().expect("AppConfig::load failed");
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let storage = Arc::new(TestBlobStorage::default());

  let auth_service = AuthService::new(
    auth_store.clone(),
    Arc::new(myoxus_infrastructure::mail::LogMailAdapter),
    storage.clone(),
    config.server.session_ttl,
    config.server.session_ttr,
  );
  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let blob_service = Arc::new(BlobService::new(blob_store, storage.clone(), "test-key".to_string()));
  let template_service = TemplateRegistryService::new(Arc::new(SqlxTemplateRegistryStore::new(pool.clone())))
    .with_materialization(doc_service.clone(), storage.clone());

  let state = ApiState::with_services(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    blob_service,
    storage.clone(),
  )
  .with_metrics_pool(pool.clone())
  .with_document_metadata_service(myoxus_application::document_metadata::DocumentMetadataService::new(
    Arc::new(PgDocumentMetadataRepository::new(pool.clone())),
  ))
  .with_template_registry_service(template_service);

  let _ = state.refresh_config_overrides().await;

  (build_router(state), pool, auth_store, storage)
}

async fn graphql_multipart_template_import(
  app: &axum::Router,
  session_id: Uuid,
  file_name: &str,
  content_type: &str,
  content: &[u8],
) -> Value {
  let boundary = "X-BOUNDARY-TEMPLATE-IMPORT";
  let operations = json!({
    "query": "mutation ImportTemplate($file: Upload!) { admin { importTemplate(file: $file) { detectedFormat normalized ignoredEntriesCount errorCatalogVersion entry { id slug title } revision { id version state } warnings { code path severity } } } }",
    "variables": {
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
  body.extend_from_slice(
    format!(
      "Content-Disposition: form-data; name=\"0\"; filename=\"{}\"\r\n",
      file_name
    )
    .as_bytes(),
  );
  body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
  body.extend_from_slice(content);
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(body))
        .expect("building multipart GraphQL request should not fail"),
    )
    .await
    .expect("sending multipart GraphQL request should not fail");

  let bytes = response
    .into_body()
    .collect()
    .await
    .expect("collecting multipart response body should not fail")
    .to_bytes();
  serde_json::from_slice(&bytes).expect("multipart GraphQL response should be valid JSON")
}

async fn graphql_json(app: &axum::Router, session_id: Uuid, payload: Value) -> Value {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(serde_json::to_vec(&payload).expect("payload serialization")))
        .expect("building JSON GraphQL request should not fail"),
    )
    .await
    .expect("sending JSON GraphQL request should not fail");
  let bytes = response
    .into_body()
    .collect()
    .await
    .expect("collecting JSON GraphQL response should not fail")
    .to_bytes();
  serde_json::from_slice(&bytes).expect("JSON GraphQL response should be valid JSON")
}

async fn list_audit_events(
  pool: &PgPool,
  filter: Option<TemplateRegistryAuditEventFilter>,
  skip: i64,
  take: i64,
) -> Vec<TemplateRegistryAuditEvent> {
  SqlxTemplateRegistryStore::new(pool.clone())
    .list_audit_events(filter, skip, take)
    .await
    .expect("list_audit_events should succeed")
}

fn audit_event<'a>(events: &'a [TemplateRegistryAuditEvent], event_type: &str) -> &'a TemplateRegistryAuditEvent {
  events
    .iter()
    .find(|event| event.event_type == event_type)
    .unwrap_or_else(|| panic!("expected audit event {event_type}, got {events:?}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
  hex::encode(Sha256::digest(bytes))
}

fn create_test_content_zip_with_entries(entries: &[(&str, &[u8])]) -> Vec<u8> {
  let mut buf = Vec::new();
  {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let options = zip::write::FileOptions::<()>::default();
    for (name, content) in entries {
      zip.start_file(*name, options).expect("test setup");
      zip.write_all(content).expect("zip write_all failed");
    }
    zip.finish().expect("zip finish failed");
  }
  buf
}

fn create_test_bundle_with_content_zip(slug: &str, version: &str, title: &str, content_zip: &[u8]) -> Vec<u8> {
  let manifest = serde_json::json!({
      "template_id": slug,
      "version": version,
      "title": title,
      "description": "Test template",
      "category": "test"
  });
  let mut buf = Vec::new();
  {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let options = zip::write::FileOptions::<()>::default();
    zip.start_file("manifest.json", options).expect("test setup");
    write!(zip, "{}", manifest).expect("zip write failed");
    zip.start_file("content.template.zip", options).expect("test setup");
    zip.write_all(content_zip).expect("zip write_all failed");
    zip.finish().expect("zip finish failed");
  }
  buf
}

fn zip_entry_names_from_bytes(bytes: &[u8]) -> Vec<String> {
  let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("zip archive should be readable");
  let mut names = Vec::with_capacity(archive.len());
  for i in 0..archive.len() {
    names.push(
      archive
        .by_index(i)
        .expect("zip entry should be readable")
        .name()
        .to_string(),
    );
  }
  names.sort();
  names
}

async fn assert_template_artifacts_absent(pool: &PgPool, template_id: Uuid, revision_id: Uuid, slug: &str) {
  let catalog_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_catalog_entries WHERE slug = $1")
    .bind(slug)
    .fetch_one(pool)
    .await
    .expect("template catalog count query should succeed");
  assert_eq!(catalog_count, 0, "template catalog entry should be removed");

  let revision_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_revisions WHERE id = $1")
    .bind(revision_id)
    .fetch_one(pool)
    .await
    .expect("template revision count query should succeed");
  assert_eq!(revision_count, 0, "template revision should be removed");

  let import_job_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM template_import_jobs WHERE result_revision_id = $1")
      .bind(revision_id)
      .fetch_one(pool)
      .await
      .expect("template import job count query should succeed");
  assert_eq!(import_job_count, 0, "template import job should be removed");

  let policy_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_template_policies WHERE template_id = $1")
    .bind(template_id)
    .fetch_one(pool)
    .await
    .expect("template policy count query should succeed");
  assert_eq!(policy_count, 0, "template policies should be removed");

  let instance_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM workspace_template_instances WHERE template_id = $1")
      .bind(template_id)
      .fetch_one(pool)
      .await
      .expect("template instance count query should succeed");
  assert_eq!(instance_count, 0, "template instances should be removed");
}

fn extract_nested_content_zip_bytes(bundle_bytes: &[u8]) -> Vec<u8> {
  let mut archive =
    zip::ZipArchive::new(std::io::Cursor::new(bundle_bytes)).expect("outer bundle must be a valid ZIP archive");
  let mut content_file = archive
    .by_name("content.template.zip")
    .expect("outer bundle must contain content.template.zip");
  let mut content_bytes = Vec::new();
  std::io::copy(&mut content_file, &mut content_bytes).expect("reading content.template.zip should not fail");
  content_bytes
}

#[derive(Default)]
struct TestBlobStorage {
  blobs: Mutex<HashMap<String, (Bytes, Option<String>)>>,
  next_read_edit: Mutex<Option<ReadEdit>>,
  next_read_edit_key: Mutex<Option<String>>,
}

struct ReadEdit {
  documents: DocService,
  workspace_id: Uuid,
  doc_id: Uuid,
  replacement: Vec<u8>,
}

impl TestBlobStorage {
  fn get(&self, key: &str) -> Option<(Bytes, Option<String>)> {
    self.blobs.lock().expect("blob mutex poisoned").get(key).cloned()
  }

  fn edit_document_on_next_read(&self, edit: ReadEdit) {
    *self.next_read_edit.lock().expect("read edit mutex poisoned") = Some(edit);
  }
}

#[derive(Default)]
struct FailingBlobStorage;

#[async_trait::async_trait]
impl BlobStoragePort for TestBlobStorage {
  async fn write_blob(&self, req: BlobWriteRequest) -> PortResult<()> {
    self
      .blobs
      .lock()
      .expect("blob mutex poisoned")
      .insert(req.key, (req.body, req.content_type));
    Ok(())
  }

  async fn read_blob(&self, key: &str) -> PortResult<BlobReadResponse> {
    let edit = {
      let mut selected = self.next_read_edit_key.lock().expect("read key mutex poisoned");
      if selected.as_deref().is_none_or(|selected| selected == key) {
        selected.take();
        self.next_read_edit.lock().expect("read edit mutex poisoned").take()
      } else {
        None
      }
    };
    if let Some(edit) = edit {
      let current = edit
        .documents
        .load_full_doc(edit.workspace_id, edit.doc_id)
        .await
        .map_err(|error| PortError::Transport(error.to_string()))?;
      let update = yjs::restore_document_snapshot(&current, &edit.replacement)
        .map_err(|error| PortError::Transport(error.to_string()))?;
      edit
        .documents
        .push_update_raw(edit.workspace_id, edit.doc_id, update, DocSpaceKind::Workspace)
        .await
        .map_err(|error| PortError::Transport(error.to_string()))?;
    }
    let (data, content_type) = self.get(key).ok_or_else(|| PortError::NotFound(key.to_string()))?;
    Ok(BlobReadResponse {
      key: key.to_string(),
      content_type,
      content_length: data.len() as u64,
      data,
      last_modified: Some(Utc::now()),
    })
  }

  async fn read_blob_bounded(&self, key: &str, max_bytes: u64) -> PortResult<BlobReadResponse> {
    let (data, _) = self.get(key).ok_or_else(|| PortError::NotFound(key.to_owned()))?;
    if data.len() as u64 > max_bytes {
      return Err(PortError::InvalidInput("blob exceeds read limit".into()));
    }
    self.read_blob(key).await
  }

  async fn delete_blob(&self, key: &str) -> PortResult<()> {
    self.blobs.lock().expect("blob mutex poisoned").remove(key);
    Ok(())
  }

  async fn put_avatar(&self, key: &str, data: Bytes, content_type: &str) -> PortResult<String> {
    self
      .blobs
      .lock()
      .expect("blob mutex poisoned")
      .insert(key.to_string(), (data, Some(content_type.to_string())));
    Ok(key.to_string())
  }

  async fn get_avatar(&self, key: &str) -> PortResult<BlobReadResponse> {
    self.read_blob(key).await
  }

  async fn delete_avatar(&self, key: &str) -> PortResult<()> {
    self.delete_blob(key).await
  }

  async fn create_multipart_upload(&self, _req: MultipartCreateRequest) -> PortResult<MultipartCreateResponse> {
    Err(PortError::InvalidInput(
      "multipart not supported in test storage".to_string(),
    ))
  }

  async fn create_multipart_part_url(&self, _req: MultipartPartUrlRequest) -> PortResult<MultipartPartUrlResponse> {
    Err(PortError::InvalidInput(
      "multipart not supported in test storage".to_string(),
    ))
  }

  async fn complete_multipart_upload(&self, _req: MultipartCompleteRequest) -> PortResult<()> {
    Err(PortError::InvalidInput(
      "multipart not supported in test storage".to_string(),
    ))
  }

  async fn abort_multipart_upload(&self, _upload_id: Uuid) -> PortResult<()> {
    Err(PortError::InvalidInput(
      "multipart not supported in test storage".to_string(),
    ))
  }
}

#[async_trait::async_trait]
impl BlobStoragePort for FailingBlobStorage {
  async fn write_blob(&self, _req: BlobWriteRequest) -> PortResult<()> {
    Err(PortError::Transport("intentional write failure".to_string()))
  }

  async fn read_blob(&self, _key: &str) -> PortResult<BlobReadResponse> {
    Err(PortError::NotFound("intentional".to_string()))
  }

  async fn delete_blob(&self, _key: &str) -> PortResult<()> {
    Ok(())
  }

  async fn put_avatar(&self, _key: &str, _data: Bytes, _content_type: &str) -> PortResult<String> {
    Err(PortError::Transport("intentional avatar write failure".to_string()))
  }

  async fn get_avatar(&self, _key: &str) -> PortResult<BlobReadResponse> {
    Err(PortError::NotFound("intentional".to_string()))
  }

  async fn delete_avatar(&self, _key: &str) -> PortResult<()> {
    Ok(())
  }

  async fn create_multipart_upload(&self, _req: MultipartCreateRequest) -> PortResult<MultipartCreateResponse> {
    Err(PortError::Transport("intentional multipart failure".to_string()))
  }

  async fn complete_multipart_upload(&self, _req: MultipartCompleteRequest) -> PortResult<()> {
    Err(PortError::Transport("intentional multipart failure".to_string()))
  }

  async fn create_multipart_part_url(&self, _req: MultipartPartUrlRequest) -> PortResult<MultipartPartUrlResponse> {
    Err(PortError::Transport("intentional multipart failure".to_string()))
  }

  async fn abort_multipart_upload(&self, _upload_id: Uuid) -> PortResult<()> {
    Err(PortError::Transport("intentional multipart failure".to_string()))
  }
}

/// Build a TemplateRegistryService backed by the test database.
fn build_service(pool: &PgPool) -> TemplateRegistryService {
  let store = Arc::new(SqlxTemplateRegistryStore::new(pool.clone()));
  TemplateRegistryService::new(store)
}

fn build_service_with_blob_port(pool: &PgPool, storage: Arc<dyn BlobStoragePort>) -> TemplateRegistryService {
  let store = Arc::new(SqlxTemplateRegistryStore::new(pool.clone()));
  TemplateRegistryService::new(store).with_blob_storage(storage)
}

fn build_service_with_storage(pool: &PgPool, storage: Arc<TestBlobStorage>) -> TemplateRegistryService {
  build_service_with_blob_port(pool, storage)
}

fn build_materializing_service(pool: &PgPool, storage: Arc<TestBlobStorage>) -> TemplateRegistryService {
  let store = Arc::new(SqlxTemplateRegistryStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let doc_service = DocService::new(doc_store);
  TemplateRegistryService::new(store).with_materialization(doc_service, storage)
}

#[sqlx::test(migrations = false)]
async fn inv_workspace_source_capture_is_current_authorized_and_closed(pool: PgPool) {
  use myoxus_application::{
    document_metadata::DocumentMetadataService,
    document_template::{
      DocumentTemplateCaptureError, DocumentTemplateCaptureRequest, DocumentTemplateError, DocumentTemplateMetadata,
      DocumentTemplateService,
    },
    permission::PermissionService,
    template_registry::{
      TemplateRegistryZipLimits,
      bundle::{self, TemplatePurpose, TitlePolicy},
      source_export::{
        DocumentTemplateBundleMetadata, DocumentTemplateSourceExportError, LocalizedDocumentTemplateCapture,
        compose_source_export,
      },
    },
  };
  myoxus_infrastructure::migrations::run(&pool).await.unwrap();
  let user = helpers::create_user(&pool, "source-capture-owner", true).await;
  let outsider = helpers::create_user(&pool, "source-capture-outsider", false).await;
  let workspace = helpers::create_workspace(&pool, user).await;
  helpers::create_workspace_root_doc(&pool, workspace, user).await;
  let documents = Arc::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))));
  let repository = Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
  let metadata = DocumentMetadataService::new(repository.clone());
  let templates = DocumentTemplateService::new(
    repository,
    documents.clone(),
    Arc::new(PermissionService::new(Arc::new(SqlxAuthStore::from_pool(pool.clone())))),
  );
  let storage = Arc::new(TestBlobStorage::default());
  let blobs = BlobService::new(
    Arc::new(SqlxBlobStore::new(pool.clone())),
    storage.clone(),
    "test-key".into(),
  );
  let image = Bytes::from_static(
    br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>"#,
  );
  blobs
    .upload_single_part_blob(workspace, "source-image", image.clone(), "image/svg+xml", None, None)
    .await
    .unwrap();
  blobs
    .upload_single_part_blob(
      workspace,
      "unrelated-file",
      Bytes::from_static(b"private unrelated bytes"),
      "text/plain",
      None,
      None,
    )
    .await
    .unwrap();
  let snapshot = json!({
    "meta": {"id":"capture-source", "title":"Source {{input.topic}}"},
    "blocks": [
      {"id":"page","flavour":"myoxus:page","children":["note"],"props":{"title":{"$virgultum:internal:text$":true,"delta":[{"insert":"Source {{input.topic}}"}]}}},
      {"id":"note","flavour":"myoxus:note","children":["paragraph","image","duplicate"],"props":{}},
      {"id":"paragraph","flavour":"myoxus:paragraph","children":[],"props":{"type":"text","text":{"$virgultum:internal:text$":true,"delta":[{"insert":"Keep {{input.topic}}","attributes":{"bold":true}}]}}},
      {"id":"image","flavour":"myoxus:image","children":[],"props":{"sourceId":"source-image","workspaceId":workspace.to_string()}},
      {"id":"duplicate","flavour":"myoxus:image","children":[],"props":{"sourceId":"source-image"}}
    ]
  });
  let source_blocks = serde_json::from_value::<Vec<yjs::PortableSnapshotBlock>>(snapshot["blocks"].clone()).unwrap();
  let source_update = yjs::snapshot_blocks_to_yjs(&source_blocks).unwrap();
  let (source, _) = documents
    .create_page_from_snapshot_with_sync_updates(workspace, user, Some("Source {{input.topic}}".into()), source_update)
    .await
    .unwrap();
  metadata.set_template_state(source.id, user, true).await.unwrap();
  metadata
    .set_metadata(
      source.id,
      user,
      DocumentMetadataPatch {
        template_category: Some(Some("building-blocks".into())),
        template_tags: Some(Some(vec!["decisions".into()])),
        ..Default::default()
      },
    )
    .await
    .unwrap();
  let discovered = templates
    .list_sources(
      myoxus_application::document_template::DocumentTemplateSourceRequest {
        actor_id: user,
        workspace_id: workspace,
        limit: 10,
        offset: 0,
      },
      &metadata,
      None,
    )
    .await
    .unwrap();
  assert_eq!(discovered.sources[0].category.as_deref(), Some("building-blocks"));
  assert_eq!(discovered.sources[0].tags, ["decisions"]);
  let before = documents.load_full_doc_consistent(workspace, source.id).await.unwrap();
  let root_before = documents.load_full_doc_consistent(workspace, workspace).await.unwrap();
  let projection = metadata.get_projection_uncached(source.id, workspace).await.unwrap();
  let head = documents
    .store()
    .preview_source_identity(workspace, source.id)
    .await
    .unwrap()
    .unwrap();
  let registry_count = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM template_catalog_entries")
    .fetch_one(&pool)
    .await
    .unwrap();
  let request = |actor_id| DocumentTemplateCaptureRequest {
    actor_id,
    workspace_id: workspace,
    external_ids: vec![source.external_id.clone()],
  };
  let limits = TemplateRegistryZipLimits::default();
  let captured = templates
    .capture_sources(request(user), &blobs, limits)
    .await
    .unwrap()
    .remove(0);
  assert_eq!(captured.assets.len(), 1, "only the referenced image is captured once");
  assert_eq!(captured.assets[0].bytes, image);
  assert_eq!(captured.assets[0].mime, "image/svg+xml");
  let captured_references = yjs::extract_portable_asset_references(&captured.update).unwrap();
  assert_eq!(captured_references.len(), 2);
  assert!(
    captured_references
      .iter()
      .all(|reference| reference.source_key == captured.assets[0].path && reference.workspace_id.is_none())
  );
  assert!(
    yjs::extract_text_from_yjs(&captured.update)
      .unwrap()
      .markdown
      .contains("**Keep {{input.topic}}**")
  );
  assert_eq!(
    (captured.document_revision, captured.metadata_revision),
    (head.revision, projection.metadata_revision)
  );
  assert_eq!(
    documents.load_full_doc_consistent(workspace, source.id).await.unwrap(),
    before
  );
  assert_eq!(
    metadata.get_projection_uncached(source.id, workspace).await.unwrap(),
    projection
  );
  assert_eq!(
    documents.load_full_doc_consistent(workspace, workspace).await.unwrap(),
    root_before
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM template_catalog_entries")
      .fetch_one(&pool)
      .await
      .unwrap(),
    registry_count
  );
  let mut german = snapshot.clone();
  german["blocks"][0]["props"]["title"]["delta"][0]["insert"] = json!("Quelle {{input.topic}}");
  german["blocks"][2]["props"]["text"]["delta"][0]["insert"] = json!("Behalte {{input.topic}}");
  let german_blocks = serde_json::from_value::<Vec<yjs::PortableSnapshotBlock>>(german["blocks"].clone()).unwrap();
  let (german, _) = documents
    .create_page_from_snapshot_with_sync_updates(
      workspace,
      user,
      Some("Quelle {{input.topic}}".into()),
      yjs::snapshot_blocks_to_yjs(&german_blocks).unwrap(),
    )
    .await
    .unwrap();
  metadata.set_template_state(german.id, user, true).await.unwrap();
  let mut captures = templates
    .capture_sources(
      DocumentTemplateCaptureRequest {
        actor_id: user,
        workspace_id: workspace,
        external_ids: vec![source.external_id.clone(), german.external_id],
      },
      &blobs,
      limits,
    )
    .await
    .unwrap()
    .into_iter();
  let captured = captures.next().unwrap();
  let german = captures.next().unwrap();
  let bundle_metadata = DocumentTemplateBundleMetadata {
    template_id: "direct-source".into(),
    version: "1.0.0".into(),
    title: "Reusable selection name".into(),
    locale: "en".into(),
    description: Some("An authored source".into()),
    category: Some("building-blocks".into()),
    tags: vec!["technical-projects".into()],
    title_policy: Some(TitlePolicy::TemplateDate),
  };
  let variants = [LocalizedDocumentTemplateCapture {
    locale: "de".into(),
    source: german,
  }];
  let exported = compose_source_export(bundle_metadata.clone(), &captured, &variants, limits).unwrap();
  let parsed = bundle::parse_bundle(&exported.bytes).unwrap();
  assert_eq!(exported.filename, "direct-source-1.0.0.zip");
  assert_eq!(exported.container_checksum, parsed.bundle_checksum);
  assert_eq!(exported.content_checksum, parsed.content_checksum);
  assert_eq!(parsed.manifest.title, "Reusable selection name");
  assert_eq!(
    (parsed.manifest.kind.as_deref(), parsed.manifest.purpose),
    (Some("page"), Some(TemplatePurpose::Template))
  );
  assert_eq!(parsed.manifest.title_policy, Some(TitlePolicy::TemplateDate));
  assert_eq!(parsed.manifest.category.as_deref(), Some("building-blocks"));
  assert_eq!(
    parsed.manifest.localized_contents.keys().collect::<Vec<_>>(),
    vec!["de"]
  );
  for (expected, bytes) in [
    (&captured, &parsed.content_bytes),
    (&variants[0].source, &parsed.localized_contents["de"]),
  ] {
    let decoded =
      myoxus_workspace_import::WorkspaceDecoder::new(myoxus_workspace_import::WorkspaceImportLimits::default())
        .decode_snapshot_bytes(bytes)
        .unwrap();
    let myoxus_workspace_import::DecodedDocumentContent::SnapshotBlocks(blocks) = &decoded.documents[0].content else {
      panic!("native Snapshot body")
    };
    let restored = yjs::snapshot_blocks_to_yjs(blocks).unwrap();
    assert!(yjs::native_documents_have_same_content(&expected.update, &restored).unwrap());
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut resource = Vec::new();
    archive
      .by_name(&expected.assets[0].path)
      .unwrap()
      .read_to_end(&mut resource)
      .unwrap();
    assert_eq!(resource, expected.assets[0].bytes);
    let mut body = String::new();
    archive
      .by_name("source.snapshot.json")
      .unwrap()
      .read_to_string(&mut body)
      .unwrap();
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["meta"], json!({"id":"direct-source","title":expected.title}));
  }
  let mut conflicting_language = bundle_metadata;
  conflicting_language.locale = "DE".into();
  assert!(matches!(
    compose_source_export(conflicting_language, &captured, &variants, limits),
    Err(DocumentTemplateSourceExportError::InvalidLocale)
  ));
  assert!(
    templates
      .capture_sources(request(outsider), &blobs, limits)
      .await
      .is_err()
  );
  assert!(matches!(
    templates
      .capture_sources(
        request(user),
        &blobs,
        TemplateRegistryZipLimits {
          max_entries: 1,
          ..limits
        }
      )
      .await,
    Err(DocumentTemplateCaptureError::LimitExceeded)
  ));

  blobs
    .soft_delete_blob(workspace, "source-image", Utc::now())
    .await
    .unwrap();
  assert!(matches!(
    templates.capture_sources(request(user), &blobs, limits).await,
    Err(DocumentTemplateCaptureError::AssetUnavailable)
  ));
  metadata.set_template_state(source.id, user, false).await.unwrap();
  assert!(matches!(
    templates.capture_sources(request(user), &blobs, limits).await,
    Err(DocumentTemplateCaptureError::Template(DocumentTemplateError::NotFound))
  ));
}

#[sqlx::test(migrations = false)]
async fn inv_builtin_completion_cannot_race_the_released_catalog_owner(pool: PgPool) {
  use myoxus_application::template_registry::bundle::{self, TemplatePurpose};
  use myoxus_domain::template_registry::{ProvisioningMode, SelectionMode};
  use std::time::Duration;
  myoxus_infrastructure::migrations::run(&pool).await.unwrap();
  let registry = build_service(&pool);
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let user = helpers::create_user(&pool, "cutover-completion-owner", true).await;
  let workspace = helpers::create_workspace(&pool, user).await;
  helpers::create_workspace_root_doc(&pool, workspace, user).await;
  let entry = registry
    .store()
    .get_catalog_entry_by_slug("business-daily")
    .await
    .unwrap()
    .unwrap();
  registry
    .assign_template_to_workspace(
      workspace,
      entry.id,
      SelectionMode::Published,
      None,
      ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .unwrap();
  let parsed = bundle::parse_bundle(include_bytes!(
    "../../../../templates/documents/business-daily/1.0.0.zip"
  ))
  .unwrap();
  let (source, _) = documents
    .create_page_from_snapshot_with_sync_updates(
      workspace,
      user,
      Some(parsed.manifest.title.clone()),
      parsed.content_bytes,
    )
    .await
    .unwrap();
  registry
    .store()
    .attribute_materialized_document(source.id, user, "de", TemplatePurpose::Template)
    .await
    .unwrap();
  let before = documents.load_full_doc_consistent(workspace, source.id).await.unwrap();

  // Hold the same catalog lock as the release commit. The tests below exercise
  // the real release pipeline; here the old completion must serialize with its
  // ownership fence before acquiring a document lock or inserting a binding.
  let mut cutover = pool.begin().await.unwrap();
  sqlx::query("SELECT id FROM template_catalog_entries WHERE id=$1 FOR NO KEY UPDATE")
    .bind(entry.id)
    .fetch_one(&mut *cutover)
    .await
    .unwrap();
  let store = SqlxTemplateRegistryStore::new(pool.clone());
  let key = source.id.to_string();
  let mut writers = tokio::task::JoinSet::new();
  writers.spawn(async move {
    store
      .upsert_builtin_instance_applied(workspace, "business-daily", "old-builder-hash", "de", Some(&key))
      .await
  });
  tokio::time::timeout(Duration::from_secs(5), async {
    loop {
      assert!(writers.try_join_next().is_none(), "legacy completion escaped the release ownership lock");
      let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM template_catalog_entries%')")
        .fetch_one(&pool).await.unwrap();
      if waiting { break; }
      tokio::time::sleep(Duration::from_millis(10)).await;
    }
  }).await.expect("builtin completion must wait at the catalog fence");
  sqlx::query("UPDATE template_catalog_entries SET source='bundle',builder_version=NULL WHERE id=$1")
    .bind(entry.id)
    .execute(&mut *cutover)
    .await
    .unwrap();
  cutover.commit().await.unwrap();
  assert!(
    tokio::time::timeout(Duration::from_secs(5), writers.join_next())
      .await
      .unwrap()
      .unwrap()
      .unwrap()
      .is_err()
  );
  let bindings: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM workspace_template_instances WHERE workspace_id=$1 AND template_id=$2")
      .bind(workspace)
      .bind(entry.id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(bindings, 0, "a converted entry cannot regain a nullable legacy binding");
  assert_eq!(
    documents.load_full_doc_consistent(workspace, source.id).await.unwrap(),
    before
  );
}

#[sqlx::test(migrations = false)]
async fn inv_released_builtin_cutover_preserves_real_content_policies_pins_and_restart(pool: PgPool) {
  use myoxus_application::template_registry::bundle::{self, TemplatePurpose};
  use myoxus_domain::template_registry::{InstanceState, ProvisioningMode, SelectionMode};
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("isolated upgrade database");
  let asset = include_bytes!("../../../../templates/documents/business-daily/1.0.0.zip");
  let parsed = bundle::parse_bundle(asset).expect("committed native daily");
  let storage = Arc::new(TestBlobStorage::default());
  let registry = build_materializing_service(&pool, storage.clone());
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let user = helpers::create_user(&pool, "released-daily-owner", true).await;
  let original = registry
    .store()
    .get_catalog_entry_by_slug("business-daily")
    .await
    .unwrap()
    .unwrap();
  assert_eq!(original.source, TemplateSource::Builtin);
  assert!(
    registry
      .import_from_bundle_with_filename_detailed(asset, "daily.zip", user)
      .await
      .unwrap_err()
      .to_string()
      .contains("builtin")
  );

  // A genuine earlier release staged before an interrupted cutover can already
  // be pinned. Its content and blob are real; the migration must preserve it.
  let mut old_manifest = parsed.manifest.clone();
  old_manifest.version = "0.9.0".into();
  let old_bytes =
    bundle::create_export_bundle(&old_manifest, &parsed.content_bytes, None, &parsed.localized_contents).unwrap();
  let old_key = "test/released-daily/0.9.0.zip";
  storage
    .write_blob(BlobWriteRequest {
      key: old_key.into(),
      content_type: Some("application/zip".into()),
      body: Bytes::from(old_bytes),
    })
    .await
    .unwrap();
  let pinned_revision = Uuid::new_v4();
  sqlx::query("INSERT INTO template_revisions(id,template_id,version,state,bundle_blob_id,checksum,manifest_json,published_at,release_managed_publication) VALUES($1,$2,'0.9.0','published',$3,$4,$5,now(),true)")
    .bind(pinned_revision).bind(original.id).bind(old_key).bind(&parsed.content_checksum)
    .bind(serde_json::to_value(&old_manifest).unwrap()).execute(&pool).await.unwrap();

  let mut sources = Vec::new();
  let mut protected = Vec::new();
  for (index, locale) in ["de", "en", "fr", "es"].into_iter().enumerate() {
    let workspace = helpers::create_workspace(&pool, user).await;
    helpers::create_workspace_root_doc(&pool, workspace, user).await;
    let policy = registry
      .assign_template_to_workspace(
        workspace,
        original.id,
        SelectionMode::Published,
        None,
        ProvisioningMode::ManagedUntilLocalEdit,
      )
      .await
      .unwrap();
    let title = if index == 1 {
      "Reader-edited daily".to_string()
    } else if locale == "de" {
      parsed.manifest.title.clone()
    } else {
      parsed.manifest.localized_contents[locale].title.clone()
    };
    let (source, _) = documents
      .create_page_from_snapshot_with_sync_updates(
        workspace,
        user,
        Some(title),
        parsed.content_for_locale(locale).to_vec(),
      )
      .await
      .unwrap();
    registry
      .store()
      .attribute_materialized_document(source.id, user, locale, TemplatePurpose::Template)
      .await
      .unwrap();
    let synthetic = compute_builtin_expected_hash(&original.slug, original.builder_version.unwrap(), locale);
    registry
      .store()
      .upsert_builtin_instance_applied(
        workspace,
        &original.slug,
        &synthetic,
        locale,
        Some(&source.id.to_string()),
      )
      .await
      .unwrap();
    if index == 2 {
      sqlx::query(
        "UPDATE workspace_template_instances SET workspace_doc_id=NULL WHERE workspace_id=$1 AND template_id=$2",
      )
      .bind(workspace)
      .bind(original.id)
      .execute(&pool)
      .await
      .unwrap();
      sqlx::query("UPDATE workspace_template_policies SET is_enabled=false WHERE id=$1")
        .bind(policy.id)
        .execute(&pool)
        .await
        .unwrap();
    }
    if index == 3 {
      sqlx::query(
        "UPDATE workspace_template_policies SET selection_mode='pinned_revision',selected_revision_id=$2 WHERE id=$1",
      )
      .bind(policy.id)
      .bind(pinned_revision)
      .execute(&pool)
      .await
      .unwrap();
    }
    let ordinary = documents
      .page_lifecycle
      .create(workspace, user, Some("Protected working document".into()), None)
      .await
      .unwrap();
    for id in [workspace, source.id, ordinary.document.id] {
      protected.push((
        workspace,
        id,
        documents.load_full_doc_consistent(workspace, id).await.unwrap(),
      ));
    }
    let before_policy = registry.store().get_policy(policy.id).await.unwrap().unwrap();
    sources.push((workspace, source.id, before_policy, index, synthetic));
  }
  let (first, concurrent) = tokio::join!(
    registry.adopt_released_builtin_baseline(asset, "daily.zip"),
    registry.adopt_released_builtin_baseline(asset, "daily.zip")
  );
  first.expect("first validated cutover");
  concurrent.expect("concurrent validated cutover");
  let entry = registry.store().get_catalog_entry(original.id).await.unwrap().unwrap();
  let revision = registry
    .store()
    .list_revisions(entry.id, 0, 200)
    .await
    .unwrap()
    .into_iter()
    .find(|revision| revision.version == "1.0.0")
    .unwrap();
  assert_eq!(
    revision.state,
    myoxus_domain::template_registry::RevisionState::Deprecated
  );
  assert_eq!(
    registry
      .store()
      .get_latest_published_revision(entry.id)
      .await
      .unwrap()
      .unwrap()
      .id,
    pinned_revision,
    "adoption stages frozen history without taking publication authority"
  );
  // Recover a partial native state too, without reprocessing already adopted
  // bindings or changing their content. Subsequent current selection is separate.
  sqlx::query("UPDATE workspace_template_instances SET revision_id=NULL WHERE workspace_id=$1 AND template_id=$2")
    .bind(sources[0].0)
    .bind(entry.id)
    .execute(&pool)
    .await
    .unwrap();
  registry
    .adopt_released_builtin_baseline(asset, "daily.zip")
    .await
    .unwrap();
  registry
    .commit_shipped_catalog_selection(&[myoxus_application::template_registry::ShippedTemplateSelection {
      template_id: entry.id,
      current_revision_id: Some(revision.id),
      history_revision_ids: vec![pinned_revision],
      new_workspace_default: false,
    }])
    .await
    .expect("select current separately through the native Feature owner");
  assert_eq!(entry.id, original.id);
  assert_eq!(entry.source, TemplateSource::Bundle);
  assert_eq!(entry.builder_version, None);
  for (workspace, source, old_policy, index, synthetic) in &sources {
    let instance = registry
      .store()
      .list_instances_for_workspace(*workspace)
      .await
      .unwrap()
      .into_iter()
      .find(|instance| instance.template_id == entry.id)
      .unwrap();
    let applied_revision = if *index == 3 { pinned_revision } else { revision.id };
    assert_eq!(instance.revision_id, applied_revision);
    assert_eq!(
      instance.workspace_doc_id,
      if *index == 1 { None } else { Some(*source) }
    );
    if *index == 1 {
      assert_eq!(instance.workspace_doc_key, None);
    }
    assert_eq!(instance.expected_hash, None);
    assert_eq!(
      instance.state,
      if *index == 1 {
        InstanceState::Detached
      } else {
        InstanceState::Ok
      }
    );
    let bytes = documents.load_full_doc_consistent(*workspace, *source).await.unwrap();
    let actual = format!("{:x}", Sha256::digest(&bytes));
    assert_ne!(&actual, synthetic);
    assert_eq!(instance.current_hash.as_deref(), Some(actual.as_str()));
    assert_eq!(
      instance.last_applied_hash.as_deref(),
      if *index == 1 { None } else { Some(actual.as_str()) }
    );
    let policy = registry.store().get_policy(old_policy.id).await.unwrap().unwrap();
    assert_eq!(policy.id, old_policy.id);
    assert_eq!(policy.is_enabled, old_policy.is_enabled);
    assert_eq!(policy.selection_mode, old_policy.selection_mode);
    assert_eq!(policy.selected_revision_id, old_policy.selected_revision_id);
    assert_eq!(policy.provisioning_mode, old_policy.provisioning_mode);
    let central: (Option<Uuid>, Option<Uuid>, Option<Uuid>, String) =
      sqlx::query_as("SELECT template_id,revision_id,instance_id,state FROM document_template_state WHERE doc_id=$1")
        .bind(source)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
      central,
      if *index == 1 {
        (None, None, None, "seeded".into())
      } else {
        (
          Some(entry.id),
          Some(applied_revision),
          Some(instance.id),
          "managed".into(),
        )
      }
    );
  }
  let restarted = build_materializing_service(&pool, storage);
  let (_, repeated) = restarted.register_shipped_bundle(asset, "daily.zip").await.unwrap();
  assert_eq!(repeated.id, revision.id);
  for (workspace, _, policy, _, _) in &sources {
    if policy.is_enabled {
      restarted
        .reconcile_workspace_templates(*workspace)
        .await
        .expect("normal worker after cutover");
    }
  }
  for (workspace, doc, before) in protected {
    assert_eq!(
      documents.load_full_doc_consistent(workspace, doc).await.unwrap(),
      before,
      "cutover must never rewrite a source, root or ordinary working document"
    );
  }
  let (workspace, source, _, _, _) = &sources[1];
  assert!(!restarted.is_managed_source(*workspace, *source).await.unwrap());
  documents
    .trash_page(*workspace, *source, user)
    .await
    .expect("edited source regains ordinary reader lifecycle");
  assert!(documents.get_metadata(*source).await.unwrap().is_none());
}

#[sqlx::test(migrations = false)]
async fn inv_released_trashed_guide_restores_as_ordinary_content_without_reseeding(pool: PgPool) {
  use myoxus_application::template_registry::bundle::{self, TemplatePurpose};
  use myoxus_domain::template_registry::{InstanceState, ProvisioningMode, SelectionMode};
  myoxus_infrastructure::migrations::run(&pool).await.unwrap();
  let asset = include_bytes!("../../../../templates/documents/getting-started-myoxus/1.0.0.zip");
  let parsed = bundle::parse_bundle(asset).unwrap();
  let registry = build_materializing_service(&pool, Arc::new(TestBlobStorage::default()));
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let user = helpers::create_user(&pool, "trashed-guide-cutover-owner", true).await;
  let workspace = helpers::create_workspace(&pool, user).await;
  helpers::create_workspace_root_doc(&pool, workspace, user).await;
  let entry = registry
    .store()
    .get_catalog_entry_by_slug("getting-started-myoxus")
    .await
    .unwrap()
    .unwrap();
  registry
    .assign_template_to_workspace(
      workspace,
      entry.id,
      SelectionMode::Published,
      None,
      ProvisioningMode::SeedOnce,
    )
    .await
    .unwrap();
  let (reader, _) = documents
    .create_page_from_snapshot_with_sync_updates(workspace, user, Some(parsed.manifest.title), parsed.content_bytes)
    .await
    .unwrap();
  // Earlier clients incorrectly classified their ordinary reader guide as a
  // template. Trash keeps the document and that attribution available to restore.
  registry
    .store()
    .attribute_materialized_document(reader.id, user, "de", TemplatePurpose::Template)
    .await
    .unwrap();
  let hash = compute_builtin_expected_hash(&entry.slug, entry.builder_version.unwrap(), "de");
  registry
    .store()
    .upsert_builtin_instance_applied(workspace, &entry.slug, &hash, "de", Some(&reader.id.to_string()))
    .await
    .unwrap();
  let original_binding: Uuid =
    sqlx::query_scalar("SELECT id FROM workspace_template_instances WHERE workspace_id=$1 AND template_id=$2")
      .bind(workspace)
      .bind(entry.id)
      .fetch_one(&pool)
      .await
      .unwrap();
  let body_before = documents.load_full_doc_consistent(workspace, reader.id).await.unwrap();
  documents
    .page_lifecycle
    .trash(workspace, reader.id, user)
    .await
    .unwrap();
  let root_trashed = documents.load_full_doc_consistent(workspace, workspace).await.unwrap();
  registry
    .register_shipped_bundle(asset, "getting-started.zip")
    .await
    .unwrap();
  let upgraded = registry.store().list_instances_for_workspace(workspace).await.unwrap();
  assert_eq!(upgraded.len(), 1);
  assert_eq!(upgraded[0].id, original_binding);
  assert_eq!(upgraded[0].state, InstanceState::Retired);
  assert_eq!(upgraded[0].workspace_doc_id, Some(reader.id));
  let flags: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_template_state WHERE doc_id=$1")
    .bind(reader.id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    flags, 0,
    "restoring an ordinary guide must not revive obsolete template ownership"
  );
  assert_eq!(
    documents.load_full_doc_consistent(workspace, workspace).await.unwrap(),
    root_trashed
  );
  registry.reconcile_workspace_templates(workspace).await.unwrap();
  let leaves: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id=$1 AND NOT is_workspace_root")
    .bind(workspace)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(leaves, 1, "trash suppresses automatic replacement");
  documents
    .page_lifecycle
    .restore(workspace, reader.id, user)
    .await
    .unwrap();
  assert_eq!(
    documents.load_full_doc_consistent(workspace, reader.id).await.unwrap(),
    body_before
  );
  registry.reconcile_workspace_templates(workspace).await.unwrap();
  let restored = registry.store().list_instances_for_workspace(workspace).await.unwrap();
  assert_eq!(restored[0].id, original_binding);
  assert_eq!(restored[0].workspace_doc_id, Some(reader.id));
  let flags: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_template_state WHERE doc_id=$1")
    .bind(reader.id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(flags, 0);
  assert_eq!(
    documents.load_full_doc_consistent(workspace, reader.id).await.unwrap(),
    body_before
  );
}

#[sqlx::test(migrations = false)]
async fn inv_released_guide_cutover_preserves_readers_deletions_copies_and_failed_creation_attribution(pool: PgPool) {
  use myoxus_application::template_registry::bundle::{self, TemplatePurpose};
  use myoxus_domain::template_registry::{InstanceState, ProvisioningMode, SelectionMode};
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("isolated reader upgrade");
  let storage = Arc::new(TestBlobStorage::default());
  let registry = build_materializing_service(&pool, storage.clone());
  let mut assets = Vec::new();
  for bytes in guide_bundle_fixtures(false) {
    let parsed = bundle::parse_bundle(&bytes).unwrap();
    if registry
      .store()
      .get_catalog_entry_by_slug(&parsed.manifest.template_id)
      .await
      .unwrap()
      .is_some_and(|entry| entry.source == TemplateSource::Builtin)
    {
      assets.push(bytes);
    }
  }
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let user = helpers::create_user(&pool, "released-guide-owner", true).await;
  let workspace = helpers::create_workspace(&pool, user).await;
  helpers::create_workspace_root_doc(&pool, workspace, user).await;
  let mut readers = Vec::new();
  for (index, bytes) in assets.iter().enumerate() {
    let parsed = bundle::parse_bundle(bytes).unwrap();
    let entry = registry
      .store()
      .get_catalog_entry_by_slug(&parsed.manifest.template_id)
      .await
      .unwrap()
      .unwrap();
    let policy = registry
      .assign_template_to_workspace(
        workspace,
        entry.id,
        SelectionMode::Published,
        None,
        ProvisioningMode::SeedOnce,
      )
      .await
      .unwrap();
    let title = if index == 0 {
      "Reader-owned English learning notes".into()
    } else {
      parsed.manifest.localized_contents["en"].title.clone()
    };
    let (doc, _) = documents
      .create_page_from_snapshot_with_sync_updates(
        workspace,
        user,
        Some(title),
        parsed.content_for_locale("en").to_vec(),
      )
      .await
      .unwrap();
    // One reader retains an old positive builtin flag. The cutover must remove
    // that misclassification, without replacing its edited native page.
    registry
      .store()
      .attribute_materialized_document(
        doc.id,
        user,
        "en",
        if index == 0 {
          TemplatePurpose::Template
        } else {
          TemplatePurpose::Guide
        },
      )
      .await
      .unwrap();
    let synthetic = compute_builtin_expected_hash(&entry.slug, entry.builder_version.unwrap(), "en");
    registry
      .store()
      .upsert_builtin_instance_applied(workspace, &entry.slug, &synthetic, "en", Some(&doc.id.to_string()))
      .await
      .unwrap();
    if index == 1 {
      documents.delete_doc(workspace, doc.id).await.unwrap();
    }
    let body = if index == 1 {
      None
    } else {
      Some(documents.load_full_doc_consistent(workspace, doc.id).await.unwrap())
    };
    if index == assets.len() - 1 {
      sqlx::query("UPDATE template_catalog_entries SET status='disabled' WHERE id=$1")
        .bind(entry.id)
        .execute(&pool)
        .await
        .unwrap();
    }
    readers.push((entry, policy, doc.id, body));
  }
  let root_before = documents.load_full_doc_consistent(workspace, workspace).await.unwrap();
  let mut registered = Vec::new();
  for bytes in &assets {
    registered.push(registry.register_shipped_bundle(bytes, "guide.zip").await.unwrap());
  }
  let disabled = registered
    .iter()
    .find(|(entry, _)| entry.id == readers.last().unwrap().0.id)
    .unwrap();
  assert_eq!(disabled.0.status, TemplateStatus::Disabled);
  assert!(
    !registry.ensure_shipped_default_policy(&disabled.0.slug).await.unwrap(),
    "an operator-disabled identity must neither fail startup nor activate a default"
  );

  let upgraded = registry.store().list_instances_for_workspace(workspace).await.unwrap();
  assert_eq!(upgraded.len(), readers.len());
  for (old_entry, old_policy, doc, before) in &readers {
    let (entry, revision) = registered.iter().find(|(entry, _)| entry.id == old_entry.id).unwrap();
    assert_eq!(entry.source, TemplateSource::Bundle);
    let instance = upgraded
      .iter()
      .find(|instance| instance.template_id == entry.id)
      .unwrap();
    assert_eq!(instance.revision_id, revision.id);
    assert_eq!(
      instance.workspace_doc_id,
      if before.is_some() { Some(*doc) } else { None }
    );
    assert_eq!(instance.expected_hash, None);
    let policy = registry.store().get_policy(old_policy.id).await.unwrap().unwrap();
    assert_eq!(policy.id, old_policy.id);
    assert_eq!(policy.is_enabled, old_policy.is_enabled);
    if let Some(before) = before {
      assert_eq!(instance.state, InstanceState::Ok);
      assert_eq!(
        documents.load_full_doc_consistent(workspace, *doc).await.unwrap(),
        *before
      );
    } else {
      assert_eq!(instance.state, InstanceState::Retired);
    }
  }
  assert_eq!(
    documents.load_full_doc_consistent(workspace, workspace).await.unwrap(),
    root_before
  );
  let states: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM document_template_state n JOIN docs d ON d.id=n.doc_id WHERE d.workspace_id=$1",
  )
  .bind(workspace)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!(states, 0, "all reader guides remain ordinary content");
  let restarted = build_materializing_service(&pool, storage);
  for bytes in &assets {
    restarted.register_shipped_bundle(bytes, "guide.zip").await.unwrap();
  }
  let repeated = restarted.reconcile_workspace_templates(workspace).await.unwrap();
  assert_eq!(
    repeated
      .iter()
      .map(|instance| (instance.id, instance.workspace_doc_id))
      .collect::<std::collections::BTreeSet<_>>(),
    upgraded
      .iter()
      .map(|instance| (instance.id, instance.workspace_doc_id))
      .collect()
  );
  let live_before: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM docs WHERE workspace_id=$1 AND NOT is_workspace_root AND deleted_at IS NULL",
  )
  .bind(workspace)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!(
    live_before,
    readers.iter().filter(|(_, _, _, body)| body.is_some()).count() as i64,
    "deleted reader binding suppresses recreation"
  );

  use myoxus_application::template_registry::suggestions::{
    TemplateSuggestionRequest, TemplateSuggestionService, TemplateSuggestionSurface,
  };
  let suggestions = TemplateSuggestionService::new(Arc::new(restarted.clone()), None, None);
  let request = TemplateSuggestionRequest {
    workspace_id: workspace,
    user_id: Some(user),
    surface: TemplateSuggestionSurface::SidebarNewPage,
    locale: "en".into(),
    client_version: 1,
    document_type_id: None,
    status_id: None,
    classification_id: None,
    mode: None,
    collection_id: None,
    current_doc_id: None,
    first: Some(1),
    after: None,
    library: None,
  };
  let projection = suggestions.suggest(request.clone()).await.unwrap();
  assert!(
    projection.items.is_empty(),
    "guides never become reusable picker candidates"
  );
  assert_eq!(
    projection.guide_deliveries.len(),
    5,
    "guide delivery is independent of picker pagination"
  );
  assert!(!projection.reconcile_required);
  for (entry, _, doc, body) in &readers {
    let delivery = projection
      .guide_deliveries
      .iter()
      .find(|delivery| delivery.slug == entry.slug)
      .unwrap();
    assert!(!delivery.pending, "deleted guide bindings suppress another delivery");
    assert_eq!(delivery.document_id, body.as_ref().map(|_| doc.to_string()));
  }

  let reader = &readers[0];
  let instance = upgraded
    .iter()
    .find(|instance| instance.template_id == reader.0.id)
    .unwrap();
  sqlx::raw_sql("CREATE FUNCTION cutover_reject_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT NEW.is_workspace_root THEN RAISE EXCEPTION 'injected cutover copy creation'; END IF; RETURN NEW; END $$; CREATE TRIGGER cutover_reject_creation BEFORE INSERT ON docs FOR EACH ROW EXECUTE FUNCTION cutover_reject_creation();").execute(&pool).await.unwrap();
  let failure = restarted
    .apply_manual_update(workspace, instance.template_id, instance.revision_id)
    .await
    .unwrap_err();
  assert!(failure.to_string().contains("injected cutover copy creation"));
  sqlx::raw_sql("DROP TRIGGER cutover_reject_creation ON docs; DROP FUNCTION cutover_reject_creation();")
    .execute(&pool)
    .await
    .unwrap();
  sqlx::raw_sql("CREATE FUNCTION cutover_reject_attribution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_doc_id IS DISTINCT FROM OLD.workspace_doc_id THEN RAISE EXCEPTION 'injected cutover copy attribution'; END IF; RETURN NEW; END $$; CREATE TRIGGER cutover_reject_attribution BEFORE UPDATE OF workspace_doc_id ON workspace_template_instances FOR EACH ROW EXECUTE FUNCTION cutover_reject_attribution();").execute(&pool).await.unwrap();
  let failure = restarted
    .apply_manual_update(workspace, instance.template_id, instance.revision_id)
    .await
    .unwrap_err();
  assert!(failure.to_string().contains("injected cutover copy attribution"));
  sqlx::raw_sql("DROP TRIGGER cutover_reject_attribution ON workspace_template_instances; DROP FUNCTION cutover_reject_attribution();").execute(&pool).await.unwrap();
  let live_after_failure: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM docs WHERE workspace_id=$1 AND NOT is_workspace_root AND deleted_at IS NULL",
  )
  .bind(workspace)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!(live_after_failure, live_before);
  assert_eq!(
    restarted
      .store()
      .get_instance(instance.id)
      .await
      .unwrap()
      .unwrap()
      .workspace_doc_id,
    Some(reader.2)
  );
  sqlx::query("UPDATE app_configs SET value='\"fr\"'::jsonb WHERE id='i18n.default_locale'")
    .execute(&pool)
    .await
    .unwrap();
  let copy = restarted
    .apply_manual_update(workspace, instance.template_id, instance.revision_id)
    .await
    .unwrap();
  assert_eq!(copy.id, instance.id);
  assert_ne!(copy.workspace_doc_id, instance.workspace_doc_id);
  assert_eq!(copy.locale_hash.as_deref(), Some("fr"));
  let projection = suggestions.suggest(request).await.unwrap();
  let delivery = projection
    .guide_deliveries
    .iter()
    .find(|delivery| delivery.slug == reader.0.slug)
    .unwrap();
  assert_eq!(delivery.document_id, copy.workspace_doc_key);
  assert!(!delivery.pending);

  for (_, _, doc, before) in &readers {
    if let Some(before) = before {
      assert_eq!(
        documents.load_full_doc_consistent(workspace, *doc).await.unwrap(),
        *before,
        "existing reader body survives every copy attempt"
      );
    }
  }
}

/// Clean up all template registry rows created during a test.
async fn cleanup_template(pool: &PgPool, slug: &str) {
  let mut tx = pool.begin().await.expect("begin owned template cleanup");
  let entry_id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM template_catalog_entries WHERE slug = $1")
    .bind(slug)
    .fetch_optional(&mut *tx)
    .await
    .expect("resolve owned template cleanup");
  if let Some(id) = entry_id {
    sqlx::query("DELETE FROM template_registry_audit_events WHERE template_id=$1")
      .bind(id)
      .execute(&mut *tx)
      .await
      .expect("delete owned registry audits");
    sqlx::query("DELETE FROM admin_audit_log WHERE target_id=$1")
      .bind(id.to_string())
      .execute(&mut *tx)
      .await
      .expect("delete owned domain audits");
    sqlx::query("DELETE FROM workspace_template_instances WHERE template_id = $1")
      .bind(id)
      .execute(&mut *tx)
      .await
      .expect("delete owned template rows");
    sqlx::query("DELETE FROM workspace_template_policies WHERE template_id = $1")
      .bind(id)
      .execute(&mut *tx)
      .await
      .expect("delete owned template rows");
    sqlx::query("DELETE FROM template_import_jobs WHERE result_revision_id IN (SELECT id FROM template_revisions WHERE template_id = $1)")
            .bind(id).execute(&mut *tx).await.expect("delete owned template rows");
    sqlx::query("DELETE FROM template_revisions WHERE template_id = $1")
      .bind(id)
      .execute(&mut *tx)
      .await
      .expect("delete owned template rows");
    sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
      .bind(id)
      .execute(&mut *tx)
      .await
      .expect("delete owned template rows");
  }
  tx.commit().await.expect("commit owned template cleanup");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_template_import_creates_catalog_entry() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-import", true).await;
  let slug = &format!("test-import-{}", Uuid::new_v4().simple());
  let bundle = create_test_bundle(slug, "1.0.0", "Import Test");

  let (entry, revision, _warnings) = service
    .import_from_bundle(&bundle, user_id)
    .await
    .expect("import_from_bundle failed");

  assert_eq!(&entry.slug, slug);
  assert_eq!(entry.title, "Import Test");
  assert_eq!(revision.version, "1.0.0");
  assert_eq!(revision.state.to_string(), "Validated");
  assert_eq!(
    revision.created_by,
    Some(user_id),
    "administrator import keeps its caller"
  );

  // Verify DB state
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_catalog_entries WHERE slug = $1")
    .bind(slug)
    .fetch_one(&pool)
    .await
    .expect("test setup");
  assert_eq!(count, 1);
  let rev_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_revisions WHERE template_id = $1")
    .bind(entry.id)
    .fetch_one(&pool)
    .await
    .expect("test setup");
  assert_eq!(rev_count, 1);

  cleanup_template(&pool, slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[sqlx::test(migrations = false)]
async fn inv_ts09_shipped_bundle_registration_reuses_one_published_revision_without_actor(pool: PgPool) {
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("owned template database migrations");
  let service = build_service_with_storage(&pool, Arc::new(TestBlobStorage::default()));
  let slug = format!("shipped-registration-{}", Uuid::new_v4().simple());
  let bundle = create_test_bundle(&slug, "1.0.0", "Shipped Registration");

  let (first, concurrent) = tokio::join!(
    service.register_shipped_bundle(&bundle, "shipped-registration.zip"),
    service.register_shipped_bundle(&bundle, "shipped-registration.zip")
  );
  let (first_entry, first_revision) = first.expect("first shipped registration");
  let (concurrent_entry, concurrent_revision) = concurrent.expect("concurrent shipped registration");
  assert_eq!(concurrent_entry.id, first_entry.id);
  assert_eq!(concurrent_revision.id, first_revision.id);
  assert_eq!(concurrent_revision.state, RevisionState::Published);
  let (second_entry, second_revision) = service
    .register_shipped_bundle(&bundle, "shipped-registration.zip")
    .await
    .expect("repeated shipped registration");

  assert_eq!(first_entry.id, second_entry.id);
  assert_eq!(first_revision.id, second_revision.id);
  assert_eq!(first_revision.state.to_string(), "Published");
  assert_eq!(first_revision.created_by, None);
  let store = SqlxTemplateRegistryStore::new(pool.clone());
  let published = store
    .get_revision(first_revision.id)
    .await
    .expect("stored revision")
    .expect("published revision");
  let mut stale_validation = published.clone();
  stale_validation.state = RevisionState::Validated;
  stale_validation.published_at = None;
  store
    .update_revision(&stale_validation)
    .await
    .expect_err("stale validation cannot roll publication back");
  let validated_again = service
    .validate_template_bundle(published.id)
    .await
    .expect("idempotent content validation");
  assert_eq!(validated_again.state, RevisionState::Published);
  assert_eq!(validated_again.published_at, published.published_at);
  let revision_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_revisions WHERE template_id = $1")
    .bind(first_entry.id)
    .fetch_one(&pool)
    .await
    .expect("revision count");
  assert_eq!(revision_count, 1, "restart registration must reuse the revision");

  // SQLx owns and drops the entire fixture database, including import/audit rows.
}

#[tokio::test]
async fn inv_template_publish_changes_state() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-pub", true).await;
  let slug = &format!("test-publish-{}", Uuid::new_v4().simple());
  let bundle = create_test_bundle(slug, "1.0.0", "Publish Test");

  let (_entry, revision, _) = service
    .import_from_bundle(&bundle, user_id)
    .await
    .expect("import_from_bundle failed");
  let published = service
    .publish_revision(revision.id)
    .await
    .expect("publish_revision failed");

  assert_eq!(published.state.to_string(), "Published");
  assert!(published.published_at.is_some());

  // Verify DB state
  let db_state: String = sqlx::query_scalar("SELECT state FROM template_revisions WHERE id = $1")
    .bind(revision.id)
    .fetch_one(&pool)
    .await
    .expect("test setup");
  assert_eq!(db_state, "published");

  cleanup_template(&pool, slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_duplicate_import_reuses_entry() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-dup", true).await;
  let slug = &format!("test-dup-{}", Uuid::new_v4().simple());

  let bundle_v1 = create_test_bundle(slug, "1.0.0", "Dup Test");
  let (entry1, _, _) = service
    .import_from_bundle(&bundle_v1, user_id)
    .await
    .expect("import_from_bundle failed");

  let bundle_v2 = create_test_bundle(slug, "2.0.0", "Dup Test v2");
  let (entry2, _, _) = service
    .import_from_bundle(&bundle_v2, user_id)
    .await
    .expect("import_from_bundle failed");

  assert_eq!(entry1.id, entry2.id, "same slug must reuse catalog entry");

  // Only 1 catalog entry, but 2 revisions
  let entry_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_catalog_entries WHERE slug = $1")
    .bind(slug)
    .fetch_one(&pool)
    .await
    .expect("test setup");
  assert_eq!(entry_count, 1);
  let rev_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_revisions WHERE template_id = $1")
    .bind(entry1.id)
    .fetch_one(&pool)
    .await
    .expect("test setup");
  assert_eq!(rev_count, 2);

  cleanup_template(&pool, slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_invalid_bundle_returns_errors() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-inv", true).await;

  // Not a ZIP at all
  let result = service.import_from_bundle(b"not-a-zip", user_id).await;
  assert!(result.is_err(), "invalid ZIP must return an error");

  // ZIP with invalid manifest (missing required fields)
  let manifest = serde_json::json!({
      "template_id": "",
      "version": "not-semver",
      "title": ""
  });
  let mut buf = Vec::new();
  {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    zip
      .start_file("manifest.json", zip::write::FileOptions::<()>::default())
      .expect("test setup");
    write!(zip, "{}", manifest).expect("zip write failed");
    zip
      .start_file("content.template.zip", zip::write::FileOptions::<()>::default())
      .expect("test setup");
    zip.write_all(b"x").expect("zip write_all failed");
    zip.finish().expect("zip finish failed");
  }
  let result = service.import_from_bundle(&buf, user_id).await;
  assert!(result.is_err(), "invalid manifest must return validation errors");

  let invalid_content_slug = format!("invalid-native-content-{}", Uuid::new_v4().simple());
  let invalid_content = create_test_bundle_with_content(
    &invalid_content_slug,
    "1.0.0",
    "Invalid native content",
    b"fake-content-zip",
  );
  let result = service.import_from_bundle(&invalid_content, user_id).await;
  assert!(result.is_err(), "invalid native content must fail before publication");
  let persisted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_catalog_entries WHERE slug = $1")
    .bind(&invalid_content_slug)
    .fetch_one(&pool)
    .await
    .expect("count rejected template artifacts");
  assert_eq!(
    persisted, 0,
    "invalid native content must not create a selectable catalog entry"
  );

  let invalid_upstream = create_invalid_upstream_snapshot_bundle();
  let result = service.import_from_bundle(&invalid_upstream, user_id).await;
  assert!(
    result.is_err(),
    "invalid upstream snapshot must return validation errors"
  );
  let message = result.unwrap_err().to_string();
  assert!(
    message.contains("SNAPSHOT_JSON_INVALID"),
    "error must expose stable snapshot parser code, got: {message}"
  );

  let missing_asset = create_upstream_snapshot_bundle_with_missing_asset_ref();
  let result = service.import_from_bundle(&missing_asset, user_id).await;
  assert!(
    result.is_err(),
    "upstream snapshot with missing asset ref must return validation errors"
  );
  let message = result.unwrap_err().to_string();
  assert!(
    message.contains("SNAPSHOT_ASSET_REFERENCE_MISSING"),
    "error must expose stable missing-asset code, got: {message}"
  );

  let missing_snapshot = create_snapshot_like_bundle_without_snapshot_entry();
  let result = service.import_from_bundle(&missing_snapshot, user_id).await;
  assert!(
    result.is_err(),
    "snapshot-like ZIP without snapshot entry must return validation errors"
  );
  let message = result.unwrap_err().to_string();
  assert!(
    message.contains("SNAPSHOT_ENTRY_MISSING"),
    "error must expose stable missing-snapshot code, got: {message}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_error_codes_contract_stable() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-error-code-contract", true).await;

  let unsupported_template_json = serde_json::json!({
    "name": "contract-template",
    "type": "template",
    "content": {"blocks": []}
  })
  .to_string()
  .into_bytes();

  let cases: Vec<(&str, Vec<u8>, &str)> = vec![
    (
      "broken-upstream.zip",
      create_invalid_upstream_snapshot_bundle(),
      "SNAPSHOT_JSON_INVALID",
    ),
    (
      "missing-asset-upstream.zip",
      create_upstream_snapshot_bundle_with_missing_asset_ref(),
      "SNAPSHOT_ASSET_REFERENCE_MISSING",
    ),
    (
      "unsupported-template.json",
      unsupported_template_json,
      "UNSUPPORTED_TEMPLATE_JSON",
    ),
  ];

  for (filename, payload, expected_code) in cases {
    let err = service
      .import_from_bundle_with_filename_detailed(&payload, filename, user_id)
      .await
      .expect_err("case should fail with stable error code");
    let err_text = err.to_string();
    assert!(
      err_text.contains(expected_code),
      "expected error text to contain stable code {expected_code}, got: {err_text}"
    );

    let report: Value = sqlx::query_scalar(
      "SELECT validation_report_json FROM template_import_jobs WHERE created_by = $1 ORDER BY started_at DESC LIMIT 1",
    )
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .expect("validation report should exist");
    assert_eq!(report["status"], "failed");
    assert_eq!(
      report["error"]["code"], expected_code,
      "expected stable error code in job summary for case {filename}"
    );
    sqlx::query("DELETE FROM template_import_jobs WHERE created_by = $1")
      .bind(user_id)
      .execute(&pool)
      .await
      .expect("job cleanup should succeed");
  }

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_upstream_snapshot_accepts_virgultum_tokens() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-upstream-token-policy", true).await;
  let slug = format!("upstream-token-policy-{}", Uuid::new_v4().simple());
  let filename = format!("{slug}.zip");
  cleanup_template(&pool, &slug).await;

  let bundle = create_upstream_snapshot_bundle_with_virgultum_tokens();
  let outcome = service
    .import_from_bundle_with_filename_detailed(&bundle, &filename, user_id)
    .await
    .expect("upstream snapshot with virgultum-like token fields must import");

  assert_eq!(outcome.detected_format.as_str(), "upstream_snapshot_zip");
  assert!(outcome.normalized);
  assert_eq!(outcome.entry.slug, slug);
  assert_eq!(outcome.revision.source_format, "upstream_snapshot_zip");
  assert_eq!(outcome.revision.detected_format, "myoxus_bundle");

  cleanup_template(&pool, &outcome.entry.slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_assign_creates_policy() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-assign", true).await;
  let slug = &format!("test-assign-{}", Uuid::new_v4().simple());
  let bundle = create_test_bundle(slug, "1.0.0", "Assign Test");

  let (entry, _, _) = service
    .import_from_bundle(&bundle, user_id)
    .await
    .expect("import_from_bundle failed");

  // Create a workspace for the policy
  let ws_id = helpers::create_workspace(&pool, user_id).await;

  let policy = service
    .assign_template_to_workspace(
      ws_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::SeedOnce,
    )
    .await
    .expect("test setup");

  assert_eq!(policy.workspace_id, ws_id);
  assert_eq!(policy.template_id, entry.id);

  // Verify DB state
  let count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM workspace_template_policies WHERE workspace_id = $1 AND template_id = $2")
      .bind(ws_id)
      .bind(entry.id)
      .fetch_one(&pool)
      .await
      .expect("test setup");
  assert_eq!(count, 1);

  cleanup_template(&pool, slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_drift_scan_preserves_instance_without_live_evidence() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-drift", true).await;
  let slug = &format!("test-drift-{}", Uuid::new_v4().simple());
  let bundle = create_test_bundle(slug, "1.0.0", "Drift Test");
  let (entry, rev, _) = service
    .import_from_bundle(&bundle, user_id)
    .await
    .expect("import_from_bundle failed");
  service.publish_revision(rev.id).await.expect("publish_revision failed");
  let ws_id = helpers::create_workspace(&pool, user_id).await;

  // Recorded hashes alone cannot authorize a lifecycle transition.
  let inst_id = Uuid::new_v4();
  sqlx::query(
        "INSERT INTO workspace_template_instances (id, workspace_id, template_id, revision_id, state, last_applied_hash, current_hash) \
         VALUES ($1, $2, $3, $4, 'ok', 'original_hash', 'different_hash')",
    ).bind(inst_id).bind(ws_id).bind(entry.id).bind(rev.id).execute(&pool).await.expect("DB execute failed");

  let drifted = service.scan_drift(ws_id).await.expect("scan_drift failed");
  assert!(drifted.is_empty(), "drift scan must require live document evidence");

  // Verify DB state: instance is detached with timestamp
  let (db_state, detached_at): (String, Option<chrono::DateTime<chrono::Utc>>) =
    sqlx::query_as("SELECT state, detached_at FROM workspace_template_instances WHERE id = $1")
      .bind(inst_id)
      .fetch_one(&pool)
      .await
      .expect("test setup");
  assert_eq!(db_state, "ok");
  assert!(detached_at.is_none(), "uncertain drift must preserve the instance");

  cleanup_template(&pool, slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_drift_scan_detaches_a_live_modified_instance() {
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage);
  let user_id = helpers::create_user(&pool, "tmpl-live-drift", true).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("test-live-drift-{}", Uuid::new_v4().simple());
  let initial = yjs::markdown_to_yjs("Live drift", "Original content").unwrap();
  let bundle = create_test_bundle_with_content(&slug, "1.0.0", "Live Drift", &initial);
  let (entry, revision, _) = service
    .import_from_bundle(&bundle, user_id)
    .await
    .expect("import bundle");
  service.publish_revision(revision.id).await.expect("publish revision");
  service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .expect("assign template");
  let instance = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("materialize source")
    .into_iter()
    .next()
    .expect("materialized instance");
  let doc_id = instance.workspace_doc_id.expect("materialized document");
  let next_sequence: i64 =
    sqlx::query_scalar("SELECT COALESCE(MAX(sequence), 0) + 1 FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("read next document sequence");
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  documents
    .push_update(
      workspace_id,
      doc_id,
      yjs::markdown_to_yjs("Live drift", "Locally edited content").unwrap(),
      next_sequence,
      DocSpaceKind::Workspace,
    )
    .await
    .expect("persist local edit");

  let drifted = service.scan_drift(workspace_id).await.expect("scan live drift");
  assert_eq!(drifted.len(), 1);
  assert_eq!(drifted[0].id, instance.id);
  assert_eq!(
    drifted[0].state,
    myoxus_domain::template_registry::InstanceState::Detached
  );
  assert_eq!(drifted[0].workspace_doc_id, Some(doc_id));

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_publish_deprecates_previous() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-depr", true).await;
  let slug = &format!("test-depr-{}", Uuid::new_v4().simple());

  // Import and publish v1
  let bundle_v1 = create_test_bundle(slug, "1.0.0", "Deprecate Test");
  let (_, rev_v1, _) = service
    .import_from_bundle(&bundle_v1, user_id)
    .await
    .expect("import_from_bundle failed");
  service
    .publish_revision(rev_v1.id)
    .await
    .expect("publish_revision failed");

  // Import and publish v2
  let bundle_v2 = create_test_bundle(slug, "2.0.0", "Deprecate Test v2");
  let (_, rev_v2, _) = service
    .import_from_bundle(&bundle_v2, user_id)
    .await
    .expect("import_from_bundle failed");
  service
    .publish_revision(rev_v2.id)
    .await
    .expect("publish_revision failed");

  // v1 should now be deprecated, v2 published
  let v1_state: String = sqlx::query_scalar("SELECT state FROM template_revisions WHERE id = $1")
    .bind(rev_v1.id)
    .fetch_one(&pool)
    .await
    .expect("test setup");
  assert_eq!(v1_state, "deprecated", "v1 must be deprecated after v2 publish");

  let v2_state: String = sqlx::query_scalar("SELECT state FROM template_revisions WHERE id = $1")
    .bind(rev_v2.id)
    .fetch_one(&pool)
    .await
    .expect("test setup");
  assert_eq!(v2_state, "published", "v2 must be published");

  cleanup_template(&pool, slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_publish_failure_keeps_existing_published_revision() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-publish-rollback", true).await;
  let slug = &format!("test-publish-rollback-{}", Uuid::new_v4().simple());

  // Import + publish v1.
  let bundle_v1 = create_test_bundle(slug, "1.0.0", "Publish Rollback");
  let (entry, rev_v1, _) = service
    .import_from_bundle(&bundle_v1, user_id)
    .await
    .expect("import_from_bundle failed");
  service
    .publish_revision(rev_v1.id)
    .await
    .expect("publish_revision failed");

  // Import v2, then force it back to draft to simulate an invalid publish attempt.
  let bundle_v2 = create_test_bundle(slug, "2.0.0", "Publish Rollback v2");
  let (_, rev_v2, _) = service
    .import_from_bundle(&bundle_v2, user_id)
    .await
    .expect("import_from_bundle failed");
  sqlx::query("UPDATE template_revisions SET state = 'draft', published_at = NULL WHERE id = $1")
    .bind(rev_v2.id)
    .execute(&pool)
    .await
    .expect("forced state update should succeed");

  let publish_err = service
    .publish_revision(rev_v2.id)
    .await
    .expect_err("publishing draft must fail");
  let error_message = publish_err.to_string();
  assert!(
    error_message.contains("cannot publish revision"),
    "unexpected publish error message: {error_message}"
  );

  // Existing published revision must remain unchanged.
  let v1_state: String = sqlx::query_scalar("SELECT state FROM template_revisions WHERE id = $1")
    .bind(rev_v1.id)
    .fetch_one(&pool)
    .await
    .expect("query state failed");
  assert_eq!(v1_state, "published");

  let v2_state: String = sqlx::query_scalar("SELECT state FROM template_revisions WHERE id = $1")
    .bind(rev_v2.id)
    .fetch_one(&pool)
    .await
    .expect("query state failed");
  assert_eq!(v2_state, "draft");

  cleanup_template(&pool, &entry.slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_ts10_retire_deletes_source_and_explicit_reassign_materializes_once() {
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage);
  let user_id = helpers::create_user(&pool, "tmpl-retire", true).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("test-retire-{}", Uuid::new_v4().simple());
  let bundle = create_test_bundle_with_content(
    &slug,
    "1.0.0",
    "Retire Test",
    &yjs::markdown_to_yjs("Retire Test", "Managed source").unwrap(),
  );
  let (entry, revision, _) = service
    .import_from_bundle(&bundle, user_id)
    .await
    .expect("import bundle");
  service.publish_revision(revision.id).await.expect("publish revision");
  let policy = service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .expect("assign template");
  let original = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("materialize source")
    .into_iter()
    .next()
    .expect("source instance");
  let original_source_id = original.workspace_doc_id.expect("source document");

  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let ordinary_doc_id = Uuid::new_v4();
  documents
    .create_doc(workspace_id, ordinary_doc_id, "Ordinary note".into(), false, user_id)
    .await
    .expect("create ordinary document");

  let interrupted = service
    .store()
    .begin_central_source_retirement(workspace_id, entry.id)
    .await
    .expect("start interrupted retirement")
    .expect("retiring source");
  assert_eq!(interrupted.workspace_doc_id, Some(original_source_id));
  assert!(
    documents.get_metadata(original_source_id).await.unwrap().is_some(),
    "marking retirement alone must not pretend document cleanup completed"
  );

  service
    .retire_template_assignment_with_actor(policy.id, Some(user_id))
    .await
    .expect("retire assignment");

  assert!(
    documents.get_metadata(original_source_id).await.unwrap().is_none(),
    "central retirement must permanently delete the bound source"
  );
  assert!(
    documents.get_metadata(ordinary_doc_id).await.unwrap().is_some(),
    "ordinary documents must survive source retirement"
  );
  assert!(
    service.store().get_policy(policy.id).await.unwrap().is_none(),
    "completed retirement must remove the active policy"
  );
  let retired = service
    .store()
    .find_instance(workspace_id, entry.id)
    .await
    .unwrap()
    .expect("historical instance");
  assert_eq!(retired.state, myoxus_domain::template_registry::InstanceState::Retired);
  assert!(retired.workspace_doc_id.is_none());
  assert!(retired.workspace_doc_key.is_none());

  let first_reassignment = service.assign_template_to_workspace(
    workspace_id,
    entry.id,
    myoxus_domain::template_registry::SelectionMode::Published,
    None,
    myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
  );
  let second_reassignment = service.assign_template_to_workspace(
    workspace_id,
    entry.id,
    myoxus_domain::template_registry::SelectionMode::Published,
    None,
    myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
  );
  let (first_reassignment, second_reassignment) = tokio::join!(first_reassignment, second_reassignment);
  assert_ne!(
    first_reassignment.is_ok(),
    second_reassignment.is_ok(),
    "one explicit reassignment must win the policy race"
  );
  let replacement_policy = first_reassignment
    .or(second_reassignment)
    .expect("one explicit reassignment");
  let replacement = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("materialize replacement")
    .into_iter()
    .find(|instance| instance.template_id == entry.id)
    .expect("replacement instance");
  let replacement_source_id = replacement.workspace_doc_id.expect("replacement source");
  assert_ne!(replacement_source_id, original_source_id);
  assert_eq!(
    replacement.id, original.id,
    "historical binding identity remains stable"
  );

  let repeated = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("repeat reconcile")
    .into_iter()
    .find(|instance| instance.template_id == entry.id)
    .expect("stable replacement");
  assert_eq!(repeated.workspace_doc_id, Some(replacement_source_id));
  let live_source_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1 AND id IN ($2, $3) AND deleted_at IS NULL")
      .bind(workspace_id)
      .bind(original_source_id)
      .bind(replacement_source_id)
      .fetch_one(&pool)
      .await
      .expect("count live sources");
  assert_eq!(live_source_count, 1, "reassignment must leave exactly one live source");

  service
    .retire_template_assignment(replacement_policy.id)
    .await
    .expect("retire replacement for cleanup");
  documents
    .delete_doc(workspace_id, ordinary_doc_id)
    .await
    .expect("delete ordinary fixture");
  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_ts10_builtin_retire_and_explicit_reassign_use_server_lifecycle() {
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage);
  let user_id = helpers::create_user(&pool, "tmpl-retire-builtin", true).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("builtin-retire-{}", Uuid::new_v4().simple());
  let now = Utc::now();
  let entry = TemplateCatalogEntry {
    id: Uuid::new_v4(),
    slug: slug.clone(),
    title: "Builtin retirement".to_string(),
    description: None,
    category: Some("test".to_string()),
    tags: Vec::new(),
    status: TemplateStatus::Active,
    source: TemplateSource::Builtin,
    builder_version: Some(1),
    min_client_version: 0,
    created_at: now,
    updated_at: now,
    archived_at: None,
  };
  service
    .store()
    .create_catalog_entry(&entry)
    .await
    .expect("create builtin");
  let policy = service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .expect("assign builtin");

  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let original_source_id = Uuid::new_v4();
  documents
    .create_doc(
      workspace_id,
      original_source_id,
      "Builtin source".into(),
      false,
      user_id,
    )
    .await
    .expect("create builtin source");
  service
    .store()
    .attribute_materialized_document(
      original_source_id,
      user_id,
      "en",
      myoxus_application::template_registry::bundle::TemplatePurpose::Template,
    )
    .await
    .expect("attribute builtin source");
  let expected_hash = compute_builtin_expected_hash(&slug, 1, "en");
  service
    .store()
    .upsert_builtin_instance_applied(
      workspace_id,
      &slug,
      &expected_hash,
      "en",
      Some(&original_source_id.to_string()),
    )
    .await
    .expect("bind builtin source");

  service
    .retire_template_assignment(policy.id)
    .await
    .expect("retire builtin assignment");
  assert!(documents.get_metadata(original_source_id).await.unwrap().is_none());

  let replacement_policy = service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .expect("explicit builtin reassignment");
  let replacement_source_id = Uuid::new_v4();
  documents
    .create_doc(
      workspace_id,
      replacement_source_id,
      "Replacement builtin source".into(),
      false,
      user_id,
    )
    .await
    .expect("create replacement source");
  service
    .store()
    .attribute_materialized_document(
      replacement_source_id,
      user_id,
      "en",
      myoxus_application::template_registry::bundle::TemplatePurpose::Template,
    )
    .await
    .expect("attribute replacement source");
  service
    .store()
    .upsert_builtin_instance_applied(
      workspace_id,
      &slug,
      &expected_hash,
      "en",
      Some(&replacement_source_id.to_string()),
    )
    .await
    .expect("bind replacement source");
  service
    .store()
    .upsert_builtin_instance_applied(
      workspace_id,
      &slug,
      &expected_hash,
      "en",
      Some(&replacement_source_id.to_string()),
    )
    .await
    .expect("repeated report remains idempotent");
  let binding: (String, Option<Uuid>) = sqlx::query_as(
    "SELECT state, workspace_doc_id FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_one(&pool)
  .await
  .expect("read replacement binding");
  assert_eq!(binding.0, "ok");
  assert_eq!(binding.1, Some(replacement_source_id));

  service
    .retire_template_assignment(replacement_policy.id)
    .await
    .expect("retire builtin replacement for cleanup");
  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_archive_disables_policies() {
  use futures_util::FutureExt;
  use std::panic::{AssertUnwindSafe, resume_unwind};
  let (app, pool, auth_store) = setup_graphql_template_registry_app().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-arch", true).await;
  let slug = format!("test-archive-{}", Uuid::new_v4().simple());
  let trigger = format!("template_archive_{}", Uuid::new_v4().simple());
  let outcome = AssertUnwindSafe(async {
    let bundle = create_test_bundle(&slug, "1.0.0", "Archive Test");
    let (entry, revision, _) = service.import_from_bundle(&bundle, user_id).await.expect("import");
    let ws_id = helpers::create_workspace(&pool, user_id).await;
    let policy = service.assign_template_to_workspace(
      ws_id, entry.id, myoxus_domain::template_registry::SelectionMode::Published, None,
      myoxus_domain::template_registry::ProvisioningMode::SeedOnce,
    ).await.expect("assignment");
    let session = helpers::create_session(&auth_store, user_id).await;
    let mutate = |operation: &'static str| {
      let app = app.clone();
      let id = entry.id.to_string();
      async move { helpers::gql(&app, session, json!({
        "query": format!("mutation($id:ID!){{admin{{{operation}(templateId:$id){{id status}}}}}}"),
        "variables":{"id":id}
      })).await }
    };
    for operation in ["disableTemplate", "enableTemplate"] {
      let response = mutate(operation).await;
      assert!(response["errors"].is_null(), "transition must succeed");
      assert_eq!(response["data"]["admin"][operation]["id"], entry.id.to_string());
      assert!(service.store().get_policy(policy.id).await.expect("policy").expect("exists").is_enabled,
        "disable/enable must preserve enabled policies");
    }
    let already_active = mutate("enableTemplate").await;
    assert_eq!(already_active["errors"][0]["message"], "template is already active");
    sqlx::query(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned policy rollback probe'; END $$"))
      .execute(&pool).await.expect("failure function");
    sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE UPDATE ON workspace_template_policies FOR EACH ROW WHEN (OLD.template_id='{id}'::uuid) EXECUTE FUNCTION {trigger}()", id=entry.id))
      .execute(&pool).await.expect("failure trigger");
    let failed = mutate("archiveTemplate").await;
    assert!(failed["errors"].is_array(), "policy failure must reject archive");
    let unchanged = service.store().get_catalog_entry(entry.id).await.expect("catalog").expect("exists");
    assert_eq!(unchanged.status, TemplateStatus::Active);
    assert!(unchanged.archived_at.is_none());
    assert!(service.store().get_policy(policy.id).await.expect("policy").expect("exists").is_enabled);
    let archive_audits: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND event_key='template.archive'")
      .bind(entry.id.to_string()).fetch_one(&pool).await.expect("audit count");
    assert_eq!(archive_audits, 0, "rollback cannot emit successful archive audit");
    sqlx::query(&format!("DROP TRIGGER {trigger} ON workspace_template_policies")).execute(&pool).await.expect("remove failure trigger");
    assert!(mutate("archiveTemplate").await["errors"].is_null());
    let archived = service.store().get_catalog_entry(entry.id).await.expect("catalog").expect("exists");
    assert_eq!(archived.status, TemplateStatus::Archived);
    assert!(archived.archived_at.is_some());
    assert!(!service.store().get_policy(policy.id).await.expect("policy").expect("exists").is_enabled);
    assert_eq!(mutate("archiveTemplate").await["errors"][0]["message"], "template is already archived");
    assert!(mutate("disableTemplate").await["errors"].is_null());
    let disabled = service.store().get_catalog_entry(entry.id).await.expect("disabled catalog").expect("exists");
    assert_eq!(disabled.archived_at, archived.archived_at, "disable retains archive timestamp");
    assert_eq!(mutate("disableTemplate").await["errors"][0]["message"], "template is already disabled");
    assert!(mutate("enableTemplate").await["errors"].is_null());
    let enabled = service.store().get_catalog_entry(entry.id).await.expect("catalog").expect("exists");
    assert_eq!(enabled.status, TemplateStatus::Active);
    assert!(enabled.archived_at.is_none());
    assert!(!service.store().get_policy(policy.id).await.expect("policy").expect("exists").is_enabled,
      "enable must not restore disabled policies");
    assert_eq!(enabled.slug, entry.slug);
    assert_eq!(enabled.source, entry.source);
    assert_eq!(enabled.builder_version, entry.builder_version);
    assert!(service.store().get_revision(revision.id).await.expect("revision").is_some());
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND actor_user_id=$2 AND metadata->>'source'='graphql'")
      .bind(entry.id.to_string()).bind(user_id).fetch_one(&pool).await.expect("attributed audit count");
    assert_eq!(audits, 5, "successful transitions audit exactly once");
  }).catch_unwind().await;
  sqlx::query(&format!(
    "DROP TRIGGER IF EXISTS {trigger} ON workspace_template_policies"
  ))
  .execute(&pool)
  .await
  .expect("cleanup trigger");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {trigger}()"))
    .execute(&pool)
    .await
    .expect("cleanup function");
  cleanup_template(&pool, &slug).await;
  sqlx::query("DELETE FROM workspaces WHERE owner_user_id=$1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("cleanup owned workspace");
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("cleanup owned user");
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_template_export_rest_download_headers_and_canonical_bundle() {
  use futures_util::FutureExt;
  let (app, pool, auth_store, storage) = setup_template_registry_export_app().await;
  let user_id = helpers::create_user(&pool, "tmpl-export", true).await;
  let outsider_id = helpers::create_user(&pool, "tmpl-export-outsider", true).await;
  let regular_id = helpers::create_user(&pool, "tmpl-export-regular", false).await;
  let session_id = helpers::create_session(&auth_store, user_id).await;
  let slug = format!("test-export-{}", Uuid::new_v4().simple());
  let outcome = std::panic::AssertUnwindSafe(async {
  let bundle = create_test_bundle(&slug, "1.0.0", "Export Test");
  let service = build_service_with_storage(&pool, storage.clone());
  let (_, rev, _) = service
    .import_from_bundle(&bundle, user_id)
    .await
    .expect("import_from_bundle failed");
  service.publish_revision(rev.id).await.expect("publish_revision failed");

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/api/admin/templates/export/{}", rev.id))
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .expect("building export request should not fail"),
    )
    .await
    .expect("sending export request should not fail");

  assert_eq!(response.status(), axum::http::StatusCode::OK);
  assert_eq!(
    response.headers().get("content-type").and_then(|v| v.to_str().ok()),
    Some("application/zip")
  );
  let expected_disposition = format!("attachment; filename=\"template-{}-{}.zip\"", slug, rev.version);
  assert_eq!(
    response
      .headers()
      .get("content-disposition")
      .and_then(|v| v.to_str().ok()),
    Some(expected_disposition.as_str())
  );
  assert_eq!(
    response.headers().get("cache-control").and_then(|v| v.to_str().ok()),
    Some("no-store")
  );

  let container_header = response.headers()["x-template-export-container-sha256"].to_str().unwrap().to_owned();
  let content_header = response.headers()["x-template-export-content-sha256"].to_str().unwrap().to_owned();

  let body = response
    .into_body()
    .collect()
    .await
    .expect("collecting export body should not fail")
    .to_bytes();

  let body_checksum = sha256_hex(&body);
  let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&body)).expect("export must produce a valid ZIP");
  let mut entry_names = Vec::with_capacity(archive.len());
  for i in 0..archive.len() {
    entry_names.push(
      archive
        .by_index(i)
        .expect("reading zip entry should not fail")
        .name()
        .to_string(),
    );
  }
  entry_names.sort();
  assert_eq!(
    entry_names,
    vec!["content.template.zip".to_string(), "manifest.json".to_string()],
    "export archive must be the canonical internal bundle"
  );
  let content_bytes = {
    let mut content_file = archive
      .by_name("content.template.zip")
      .expect("export archive must contain canonical content.template.zip");
    let mut bytes = Vec::new();
    std::io::copy(&mut content_file, &mut bytes).expect("reading content.template.zip should not fail");
    bytes
  };
  let content_checksum = sha256_hex(&content_bytes);

  assert_eq!(container_header, body_checksum);
  assert_eq!(content_header, content_checksum);

  let workspace = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace, user_id).await;
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let (source, _) = documents
    .create_page_from_snapshot_with_sync_updates(
      workspace,
      user_id,
      Some("Unpublished {{input.topic}}".into()),
      yjs::markdown_to_yjs("Unpublished {{input.topic}}", "Keep **{{input.topic}}** editable.").unwrap(),
    )
    .await
    .unwrap();
  let metadata = myoxus_application::document_metadata::DocumentMetadataService::new(Arc::new(
    PgDocumentMetadataRepository::new(pool.clone()),
  ));
  myoxus_application::document_template::DocumentTemplateMetadata::set_template_state(&metadata, source.id, user_id, true).await.unwrap();
  let before = documents.load_full_doc_consistent(workspace, source.id).await.unwrap();
  let projection = metadata.get_projection_uncached(source.id, workspace).await.unwrap();
  let direct_slug = format!("direct-export-{}", Uuid::new_v4().simple());
  let request = json!({
    "workspaceId":workspace,
    "source":{"docId":source.external_id},
    "metadata":{"templateId":direct_slug,"version":"1.0.0","title":"Reusable workspace source","locale":"en","titlePolicy":"template"}
  });
  let post = |session: Uuid, request: Value| {
    let app = app.clone();
    async move {
      app.oneshot(Request::builder().method("POST").uri("/api/admin/templates/workspace-source/export")
        .header("cookie", format!("affine_session={session}"))
        .header("content-type","application/json")
        .body(Body::from(serde_json::to_vec(&request).unwrap())).unwrap()).await.unwrap()
    }
  };
  let direct = post(session_id, request.clone()).await;
  assert_eq!(direct.status(), axum::http::StatusCode::OK);
  assert_eq!(direct.headers()["content-type"], "application/zip");
  let container = direct.headers()["x-template-export-container-sha256"].to_str().unwrap().to_owned();
  let content = direct.headers()["x-template-export-content-sha256"].to_str().unwrap().to_owned();
  let bytes = direct.into_body().collect().await.unwrap().to_bytes();
  let parsed = myoxus_application::template_registry::bundle::parse_bundle(&bytes).unwrap();
  assert_eq!(container, sha256_hex(&bytes));
  assert_eq!(content, parsed.content_checksum);
  assert_eq!(parsed.manifest.template_id, direct_slug);
  let decoded = myoxus_workspace_import::WorkspaceDecoder::new(myoxus_workspace_import::WorkspaceImportLimits::default()).decode_snapshot_bytes(&parsed.content_bytes).unwrap();
  let myoxus_workspace_import::DecodedDocumentContent::SnapshotBlocks(blocks) = &decoded.documents[0].content else {panic!("native workspace source body")};
  let restored = yjs::snapshot_blocks_to_yjs(blocks).unwrap();
  assert!(yjs::native_documents_have_same_content(&before, &restored).unwrap());
  assert_eq!(documents.load_full_doc_consistent(workspace, source.id).await.unwrap(), before);
  assert_eq!(metadata.get_projection_uncached(source.id, workspace).await.unwrap(), projection);
  assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM template_catalog_entries WHERE slug=$1").bind(&direct_slug).fetch_one(&pool).await.unwrap(), 0, "a direct download must not create a Registry entry/revision");
  let outsider_session = helpers::create_session(&auth_store, outsider_id).await;
  let denied = post(outsider_session, request.clone()).await;
  assert_eq!(denied.status(), axum::http::StatusCode::NOT_FOUND, "a source-scoped denial must retain the global Admin session");
  let regular_session = helpers::create_session(&auth_store, regular_id).await;
  assert_eq!(post(regular_session, request).await.status(), axum::http::StatusCode::FORBIDDEN);

  }).catch_unwind().await;
  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id, outsider_id, regular_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_template_export_cleanup_is_idempotent_and_removes_db_artifacts() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-export-cleanup", true).await;
  let slug = format!("test-export-cleanup-{}", Uuid::new_v4().simple());
  let bundle = create_test_bundle(&slug, "1.0.0", "Export Cleanup Test");
  let (entry, rev, _) = service
    .import_from_bundle(&bundle, user_id)
    .await
    .expect("import_from_bundle failed");
  service.publish_revision(rev.id).await.expect("publish_revision failed");

  cleanup_template(&pool, &entry.slug).await;
  cleanup_template(&pool, &entry.slug).await;

  let catalog_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_catalog_entries WHERE id = $1")
    .bind(entry.id)
    .fetch_one(&pool)
    .await
    .expect("catalog cleanup check should succeed");
  let revision_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_revisions WHERE id = $1")
    .bind(rev.id)
    .fetch_one(&pool)
    .await
    .expect("revision cleanup check should succeed");
  let job_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_import_jobs WHERE result_revision_id = $1")
    .bind(rev.id)
    .fetch_one(&pool)
    .await
    .expect("job cleanup check should succeed");
  let instance_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM workspace_template_instances WHERE template_id = $1")
      .bind(entry.id)
      .fetch_one(&pool)
      .await
      .expect("instance cleanup check should succeed");
  let policy_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_template_policies WHERE template_id = $1")
    .bind(entry.id)
    .fetch_one(&pool)
    .await
    .expect("policy cleanup check should succeed");

  assert_eq!(catalog_count, 0, "catalog entry should be removed");
  assert_eq!(revision_count, 0, "template revision should be removed");
  assert_eq!(job_count, 0, "import job rows should be removed");
  assert_eq!(instance_count, 0, "template instances should be removed");
  assert_eq!(policy_count, 0, "template policies should be removed");

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_export_roundtrip_rest_export_reimport_compatibility() {
  let (app, pool, auth_store, storage) = setup_template_registry_export_app().await;
  let user_id = helpers::create_user(&pool, "tmpl-export-roundtrip", true).await;
  let session_id = helpers::create_session(&auth_store, user_id).await;
  let slug = format!("test-export-roundtrip-{}", Uuid::new_v4().simple());
  let version = "1.0.0";
  let title = "Export Roundtrip Test";
  let content_zip = create_test_content_zip_with_entries(&[(
    "workspace/template.snapshot.json",
    br#"{"meta":{"id":"template","title":"Export roundtrip"},"blocks":{"type":"block","id":"page","flavour":"affine:page","props":{},"children":[]}}"#,
  )]);
  let bundle = create_test_bundle_with_content_zip(&slug, version, title, &content_zip);
  let service = build_service_with_storage(&pool, storage.clone());
  let (entry, rev, _) = service
    .import_from_bundle(&bundle, user_id)
    .await
    .expect("import_from_bundle failed");
  service.publish_revision(rev.id).await.expect("publish_revision failed");

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/api/admin/templates/export/{}", rev.id))
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .expect("building export request should not fail"),
    )
    .await
    .expect("sending export request should not fail");

  assert_eq!(response.status(), axum::http::StatusCode::OK);
  let exported_body = response
    .into_body()
    .collect()
    .await
    .expect("collecting export body should not fail")
    .to_bytes();
  let exported_bundle = exported_body.to_vec();
  let exported_bundle_parsed = myoxus_application::template_registry::bundle::parse_bundle(&exported_bundle)
    .expect("exported bundle must parse as myoxus_bundle");
  assert_eq!(exported_bundle_parsed.format.as_str(), "myoxus_bundle");
  assert_eq!(exported_bundle_parsed.manifest.template_id, slug);
  assert_eq!(exported_bundle_parsed.manifest.version, version);
  assert_eq!(exported_bundle_parsed.manifest.title, title);

  let exported_content_zip = extract_nested_content_zip_bytes(&exported_bundle);
  assert_eq!(
    zip_entry_names_from_bytes(&content_zip),
    zip_entry_names_from_bytes(&exported_content_zip)
  );

  // Remove the original revision before re-importing the exported bundle, since
  // the registry enforces one revision per template/version pair.
  cleanup_template(&pool, &entry.slug).await;

  // Assumption: re-importing the exported bundle is expected to reuse the slug
  // and create a compatible revision, not a new catalog entry.
  let reimport = match service
    .import_from_bundle_with_filename_detailed(&exported_bundle, "roundtrip-export.zip", user_id)
    .await
  {
    Ok(result) => result,
    Err(err) => {
      cleanup_template(&pool, &entry.slug).await;
      helpers::cleanup_users(&pool, &[user_id]).await;
      panic!("reimport of exported bundle failed: {err}");
    }
  };
  assert_eq!(reimport.entry.slug, slug);
  assert_eq!(reimport.entry.title, title);
  assert_eq!(reimport.revision.version, version);
  assert_eq!(reimport.detected_format.as_str(), "myoxus_bundle");
  assert!(
    !reimport.normalized,
    "canonical myoxus_bundle exports should not require normalization"
  );
  assert_eq!(reimport.ignored_entries_count, 0);

  let reimport_bundle_blob_id = reimport
    .revision
    .bundle_blob_id
    .as_deref()
    .expect("reimported revision must have a bundle blob");
  let stored_reimport_bundle = storage
    .get(reimport_bundle_blob_id)
    .expect("reimported bundle should be stored")
    .0;
  let reimport_content_zip = extract_nested_content_zip_bytes(&stored_reimport_bundle);
  assert_eq!(
    zip_entry_names_from_bytes(&content_zip),
    zip_entry_names_from_bytes(&reimport_content_zip),
    "reimported bundle must preserve the nested content.zip structure"
  );

  cleanup_template(&pool, &entry.slug).await;
  cleanup_template(&pool, &entry.slug).await;

  let catalog_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_catalog_entries WHERE slug = $1")
    .bind(&entry.slug)
    .fetch_one(&pool)
    .await
    .expect("cleanup check should succeed");
  let revision_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_revisions WHERE template_id = $1")
    .bind(reimport.entry.id)
    .fetch_one(&pool)
    .await
    .expect("cleanup check should succeed");
  let job_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_import_jobs WHERE created_by = $1")
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .expect("cleanup check should succeed");

  assert_eq!(
    catalog_count, 0,
    "catalog entry should be removed after idempotent cleanup"
  );
  assert_eq!(
    revision_count, 0,
    "all revisions should be removed after idempotent cleanup"
  );
  assert_eq!(
    job_count, 0,
    "all import jobs for the test user should be removed after idempotent cleanup"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_import_rejects_multi_doc_internal_content() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "tmpl-export-multi-doc", true).await;
  let slug = format!("test-export-multi-doc-{}", Uuid::new_v4().simple());
  let content_zip = create_test_content_zip_with_entries(&[
    (
      "workspace/page-1.snapshot.json",
      br#"{"meta":{"id":"page-1"},"blocks":[]}"#,
    ),
    (
      "workspace/page-2.snapshot.json",
      br#"{"meta":{"id":"page-2"},"blocks":[]}"#,
    ),
  ]);
  let bundle = create_test_bundle_with_content_zip(&slug, "1.0.0", "Multi Doc Import", &content_zip);
  let service = build_service(&pool);
  let error = service
    .import_from_bundle(&bundle, user_id)
    .await
    .expect_err("multi-document template content must not become publishable");
  assert!(error.to_string().contains("MIX_WORKSPACE_IMPORT_ARCHIVE_LIMIT"));
  let catalog_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_catalog_entries WHERE slug = $1")
    .bind(&slug)
    .fetch_one(&pool)
    .await
    .expect("catalog count");
  assert_eq!(catalog_count, 0, "rejected content must not create a catalog entry");
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_import_persists_bundle_blob_and_preview() {
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_service_with_storage(&pool, storage.clone());
  let user_id = helpers::create_user(&pool, "tmpl-storage", true).await;
  let slug = &format!("test-storage-{}", Uuid::new_v4().simple());
  let preview = br#"<svg viewBox="0 0 10 10"></svg>"#;
  let bundle = create_test_bundle_with_preview(slug, "1.0.0", "Stored Bundle Test", Some(preview));

  let (_entry, revision, _) = service
    .import_from_bundle_with_filename(&bundle, "stored-bundle.template.zip", user_id)
    .await
    .expect("import_from_bundle_with_filename failed");

  let bundle_blob_id = revision.bundle_blob_id.as_deref().expect("bundle_blob_id must be set");
  assert!(
    bundle_blob_id.starts_with(&format!("template-registry/bundles/{}/1.0.0/", slug)),
    "bundle_blob_id must be a real storage key, got: {bundle_blob_id}"
  );
  let (stored_bundle, stored_bundle_content_type) = storage.get(bundle_blob_id).expect("bundle blob must be written");
  let parsed_stored_bundle = myoxus_application::template_registry::bundle::parse_bundle(&stored_bundle)
    .expect("stored bundle must be a valid canonical template bundle");
  assert_eq!(parsed_stored_bundle.format.as_str(), "myoxus_bundle");
  assert_eq!(parsed_stored_bundle.manifest.template_id, *slug);
  assert_eq!(parsed_stored_bundle.manifest.version, "1.0.0");
  assert_eq!(parsed_stored_bundle.manifest.title, "Stored Bundle Test");
  yjs::validate_update_v1(&parsed_stored_bundle.content_bytes).expect("stored content must remain valid native Yjs");
  assert_eq!(
    parsed_stored_bundle.preview_bytes.as_deref(),
    Some(preview.as_slice()),
    "preview bytes in stored canonical bundle must match input preview"
  );
  assert_eq!(stored_bundle_content_type.as_deref(), Some("application/zip"));

  let preview_blob_id = revision
    .preview_blob_id
    .as_deref()
    .expect("preview_blob_id must be set");
  assert!(
    preview_blob_id.starts_with(&format!("template-registry/previews/{}/1.0.0/", slug)),
    "preview_blob_id must be a real storage key, got: {preview_blob_id}"
  );
  let (stored_preview, stored_preview_content_type) =
    storage.get(preview_blob_id).expect("preview blob must be written");
  assert_eq!(stored_preview, Bytes::from_static(preview));
  assert_eq!(stored_preview_content_type.as_deref(), Some("image/svg+xml"));

  cleanup_template(&pool, slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_import_graphql_multipart_returns_metadata() {
  let _guard = helpers::TEMPLATE_REGISTRY_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .expect("template registry lock");
  let (app, pool, auth_store) = setup_graphql_template_registry_app().await;
  let user_id = helpers::create_user(&pool, "tmpl-gql-import", true).await;
  let session_id = helpers::create_session(&auth_store, user_id).await;
  let slug = format!("tmpl-gql-import-{}", Uuid::new_v4().simple());
  let bundle = create_test_bundle_with_ignored_entries(&slug, "1.0.0", "GraphQL Import Test");

  let resp = graphql_multipart_template_import(&app, session_id, "graph-import.zip", "application/zip", &bundle).await;
  assert!(resp.get("errors").is_none(), "unexpected graphql errors: {resp}");

  let data = &resp["data"]["admin"]["importTemplate"];
  assert_eq!(data["detectedFormat"], "myoxus_bundle");
  assert_eq!(data["normalized"], false);
  assert_eq!(data["ignoredEntriesCount"], 1);
  assert_eq!(data["errorCatalogVersion"], TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION);
  assert_eq!(data["entry"]["slug"], slug);
  assert_eq!(data["entry"]["title"], "GraphQL Import Test");
  assert_eq!(data["revision"]["version"], "1.0.0");
  assert_eq!(data["revision"]["state"], "Validated");
  let warnings = data["warnings"].as_array().expect("warnings should be an array");
  assert!(
    warnings.iter().any(|warning| warning["code"] == "EMPTY_TAGS"),
    "expected EMPTY_TAGS warning, got: {warnings:?}"
  );

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_audit_contract_covers_lifecycle_events_and_required_fields() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-gql-audit", true).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let slug = format!("tmpl-gql-audit-{}", Uuid::new_v4().simple());
  let bundle = create_test_bundle_with_ignored_entries(&slug, "1.0.0", "GraphQL Audit Contract");

  let outcome = service
    .import_from_bundle_with_filename_detailed(&bundle, "audit-import.zip", user_id)
    .await
    .expect("import_from_bundle_with_filename_detailed should succeed");
  let entry = outcome.entry;
  let revision = outcome.revision;
  let warnings = outcome.warnings;
  assert_eq!(
    warnings.len(),
    1,
    "expected one non-fatal warning in the import contract"
  );
  let revision_id_string = revision.id.to_string();

  let import_job_id: Uuid = sqlx::query_scalar("SELECT id FROM template_import_jobs WHERE result_revision_id = $1")
    .bind(revision.id)
    .fetch_one(&pool)
    .await
    .expect("template import job should exist");

  let import_events = list_audit_events(
    &pool,
    Some(TemplateRegistryAuditEventFilter {
      import_job_id: Some(import_job_id),
      ..Default::default()
    }),
    0,
    20,
  )
  .await;
  assert_eq!(
    import_events.len(),
    2,
    "expected started and completed import audit events"
  );

  let started = audit_event(&import_events, "template.import.started");
  assert_eq!(started.action, TemplateRegistryAuditAction::Imported);
  assert_eq!(started.actor_user_id, Some(user_id));
  assert_eq!(started.import_job_id, Some(import_job_id));
  assert_eq!(started.template_id, None);
  assert_eq!(started.revision_id, None);
  assert_eq!(started.source_format.as_deref(), Some("unknown"));
  assert_eq!(started.detected_format.as_deref(), Some("unknown"));
  assert_eq!(started.normalizer_version.as_deref(), Some("unknown"));
  assert_eq!(
    started.error_catalog_version.as_deref(),
    Some(TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION)
  );
  assert_eq!(started.error_code.as_deref(), Some("NONE"));
  assert_eq!(
    started
      .payload_json
      .as_ref()
      .and_then(|json| json.get("filename"))
      .and_then(Value::as_str),
    Some("audit-import.zip")
  );

  let validated_events = list_audit_events(
    &pool,
    Some(TemplateRegistryAuditEventFilter {
      action: Some(TemplateRegistryAuditAction::Validated),
      revision_id: Some(revision.id),
      ..Default::default()
    }),
    0,
    20,
  )
  .await;
  let validated = audit_event(&validated_events, "template.import.validated");
  assert_eq!(validated.action, TemplateRegistryAuditAction::Validated);
  assert_eq!(validated.actor_user_id, None);
  assert_eq!(validated.template_id, Some(entry.id));
  assert_eq!(validated.revision_id, Some(revision.id));
  assert_eq!(validated.import_job_id, None);
  assert_eq!(validated.source_format.as_deref(), Some("myoxus_bundle"));
  assert_eq!(validated.detected_format.as_deref(), Some("myoxus_bundle"));
  assert_eq!(validated.normalizer_version.as_deref(), Some("none"));
  assert_eq!(validated.ignored_entries_count, Some(1));
  assert_eq!(
    validated.error_catalog_version.as_deref(),
    Some(TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION)
  );
  assert_eq!(validated.error_code.as_deref(), Some("NONE"));
  assert_eq!(
    validated
      .payload_json
      .as_ref()
      .and_then(|json| json.get("revision_id"))
      .and_then(Value::as_str),
    Some(revision_id_string.as_str())
  );

  let completed = audit_event(&import_events, "template.import.completed");
  assert_eq!(completed.action, TemplateRegistryAuditAction::Imported);
  assert_eq!(completed.actor_user_id, Some(user_id));
  assert_eq!(completed.template_id, Some(entry.id));
  assert_eq!(completed.revision_id, Some(revision.id));
  assert_eq!(completed.import_job_id, Some(import_job_id));
  assert_eq!(completed.source_format.as_deref(), Some("myoxus_bundle"));
  assert_eq!(completed.detected_format.as_deref(), Some("myoxus_bundle"));
  assert_eq!(completed.normalizer_version.as_deref(), Some("none"));
  assert_eq!(completed.ignored_entries_count, Some(1));
  assert_eq!(
    completed.error_catalog_version.as_deref(),
    Some(TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION)
  );
  assert_eq!(completed.error_code.as_deref(), Some("NONE"));
  assert_eq!(
    completed
      .payload_json
      .as_ref()
      .and_then(|json| json.get("warning_count"))
      .and_then(Value::as_u64),
    Some(1)
  );
  assert_eq!(
    completed
      .payload_json
      .as_ref()
      .and_then(|json| json.get("normalized"))
      .and_then(Value::as_bool),
    Some(false)
  );

  let published = service
    .publish_revision(revision.id)
    .await
    .expect("publish_revision should succeed");
  assert_eq!(published.state, RevisionState::Published);

  let publish_events = list_audit_events(
    &pool,
    Some(TemplateRegistryAuditEventFilter {
      action: Some(TemplateRegistryAuditAction::Published),
      revision_id: Some(revision.id),
      ..Default::default()
    }),
    0,
    20,
  )
  .await;
  let publish = audit_event(&publish_events, "template.revision.published");
  assert_eq!(publish.action, TemplateRegistryAuditAction::Published);
  assert_eq!(publish.actor_user_id, None);
  assert_eq!(publish.template_id, Some(entry.id));
  assert_eq!(publish.revision_id, Some(revision.id));
  assert_eq!(publish.source_format.as_deref(), Some("myoxus_bundle"));
  assert_eq!(publish.detected_format.as_deref(), Some("myoxus_bundle"));
  assert_eq!(publish.normalizer_version.as_deref(), Some("none"));
  assert_eq!(publish.error_code.as_deref(), Some("NONE"));
  assert_eq!(
    publish
      .payload_json
      .as_ref()
      .and_then(|json| json.get("version"))
      .and_then(Value::as_str),
    Some("1.0.0")
  );

  let export_bytes = service
    .export_revision(
      revision.id,
      b"template-content",
      None,
      &std::collections::BTreeMap::new(),
    )
    .await
    .expect("export_revision should succeed");
  assert!(!export_bytes.is_empty(), "export should produce a bundle");

  let export_events = list_audit_events(
    &pool,
    Some(TemplateRegistryAuditEventFilter {
      action: Some(TemplateRegistryAuditAction::Exported),
      revision_id: Some(revision.id),
      ..Default::default()
    }),
    0,
    20,
  )
  .await;
  let export = audit_event(&export_events, "template.export.completed");
  assert_eq!(export.action, TemplateRegistryAuditAction::Exported);
  assert_eq!(export.actor_user_id, None);
  assert_eq!(export.template_id, Some(entry.id));
  assert_eq!(export.revision_id, Some(revision.id));
  assert_eq!(export.source_format.as_deref(), Some("myoxus_bundle"));
  assert_eq!(export.detected_format.as_deref(), Some("myoxus_bundle"));
  assert_eq!(export.normalizer_version.as_deref(), Some("none"));
  assert_eq!(export.error_code.as_deref(), Some("NONE"));
  assert_eq!(
    export
      .payload_json
      .as_ref()
      .and_then(|json| json.get("export_size"))
      .and_then(Value::as_u64),
    Some(export_bytes.len() as u64)
  );

  let policy = service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::SeedOnce,
    )
    .await
    .expect("assign_template_to_workspace should succeed");
  let policy_id_string = policy.id.to_string();

  let assignment_events = list_audit_events(
    &pool,
    Some(TemplateRegistryAuditEventFilter {
      action: Some(TemplateRegistryAuditAction::Assigned),
      policy_id: Some(policy.id),
      ..Default::default()
    }),
    0,
    20,
  )
  .await;
  let assignment = audit_event(&assignment_events, "template.assignment.created");
  assert_eq!(assignment.action, TemplateRegistryAuditAction::Assigned);
  assert_eq!(assignment.actor_user_id, None);
  assert_eq!(assignment.template_id, Some(entry.id));
  assert_eq!(assignment.revision_id, Some(revision.id));
  assert_eq!(assignment.workspace_id, Some(workspace_id));
  assert_eq!(assignment.policy_id, Some(policy.id));
  assert_eq!(assignment.source_format.as_deref(), Some("myoxus_bundle"));
  assert_eq!(assignment.detected_format.as_deref(), Some("myoxus_bundle"));
  assert_eq!(assignment.normalizer_version.as_deref(), Some("none"));
  assert_eq!(assignment.ignored_entries_count, Some(1));
  assert_eq!(
    assignment.error_catalog_version.as_deref(),
    Some(TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION)
  );
  assert_eq!(assignment.error_code.as_deref(), Some("NONE"));
  assert_eq!(
    assignment
      .payload_json
      .as_ref()
      .and_then(|json| json.get("selection_mode"))
      .and_then(Value::as_str),
    Some("Published")
  );
  assert_eq!(
    assignment
      .payload_json
      .as_ref()
      .and_then(|json| json.get("provisioning_mode"))
      .and_then(Value::as_str),
    Some("SeedOnce")
  );
  assert_eq!(
    assignment
      .payload_json
      .as_ref()
      .and_then(|json| json.get("policy_id"))
      .and_then(Value::as_str),
    Some(policy_id_string.as_str())
  );

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_graphql_template_jobs_summary_contract_is_stable() {
  let _guard = helpers::TEMPLATE_REGISTRY_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .expect("template registry lock");
  let (app, pool, auth_store) = setup_graphql_template_registry_app().await;
  let user_id = helpers::create_user(&pool, "tmpl-gql-job-summary", true).await;
  let session_id = helpers::create_session(&auth_store, user_id).await;
  let slug = format!("tmpl-gql-job-summary-{}", Uuid::new_v4().simple());
  let bundle = create_test_bundle_with_ignored_entries(&slug, "1.0.0", "GraphQL Job Summary");

  let import_resp =
    graphql_multipart_template_import(&app, session_id, "job-summary.zip", "application/zip", &bundle).await;
  assert!(
    import_resp.get("errors").is_none(),
    "unexpected graphql errors: {import_resp}"
  );
  let entry_id = import_resp["data"]["admin"]["importTemplate"]["entry"]["id"]
    .as_str()
    .expect("import response must include entry id")
    .to_string();
  let revision_id = import_resp["data"]["admin"]["importTemplate"]["revision"]["id"]
    .as_str()
    .expect("import response must include revision id")
    .to_string();

  let jobs_resp = graphql_json(
    &app,
    session_id,
    json!({
      "query": "query TemplateJobs($skip: Int!, $take: Int!) { admin { templateJobs(skip: $skip, take: $take) { jobType state templateId workspaceId startedAt finishedAt summaryJson } } }",
      "variables": {"skip": 0, "take": 20}
    }),
  )
  .await;
  assert!(
    jobs_resp.get("errors").is_none(),
    "unexpected templateJobs errors: {jobs_resp}"
  );
  let jobs = jobs_resp["data"]["admin"]["templateJobs"]
    .as_array()
    .expect("templateJobs should be an array");
  let import_job = jobs
    .iter()
    .find(|job| {
      job["jobType"]
        .as_str()
        .map(|value| value.eq_ignore_ascii_case("import"))
        .unwrap_or(false)
        && job["templateId"].as_str() == Some(entry_id.as_str())
    })
    .expect("expected import job in templateJobs");
  assert_eq!(
    import_job["state"].as_str().unwrap().to_ascii_lowercase(),
    "completed",
    "import job should be completed"
  );
  let summary_json = import_job["summaryJson"]
    .as_str()
    .expect("templateJobs summaryJson must be a string");
  let summary: Value = serde_json::from_str(summary_json).expect("summaryJson must parse as JSON");
  assert_eq!(summary["status"], "completed");
  assert_eq!(summary["result_revision_id"], revision_id);
  assert_eq!(
    summary["error_catalog_version"],
    TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION
  );
  assert_eq!(summary["detected_format"], "myoxus_bundle");
  assert_eq!(summary["normalized"], false);
  assert_eq!(summary["ignored_entries_count"], 1);
  assert!(summary["started_at"].is_string(), "summary must include started_at");
  assert!(summary["finished_at"].is_string(), "summary must include finished_at");
  assert!(
    summary["error"].is_null(),
    "completed summary must not carry an error object"
  );
  assert!(
    summary["failed_stage"].is_null(),
    "completed summary must not carry a failed stage"
  );
  let stage_names: Vec<String> = summary["stages"]
    .as_array()
    .expect("summary stages should be an array")
    .iter()
    .map(|stage| {
      stage["name"]
        .as_str()
        .expect("stage name should be a string")
        .to_string()
    })
    .collect();
  assert_eq!(
    stage_names,
    vec!["detect", "unpack", "normalize", "validate", "persist"],
    "summary should expose the full import pipeline"
  );
  assert!(
    summary["warnings"]
      .as_array()
      .expect("summary warnings should be an array")
      .iter()
      .any(|warning| warning["code"] == "EMPTY_TAGS"),
    "summary should carry validation warnings"
  );

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_import_persists_canonical_metadata_in_job_report() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-meta-canonical", true).await;
  let slug = format!("tmpl-meta-canonical-{}", Uuid::new_v4().simple());
  let bundle = create_test_bundle(&slug, "1.0.0", "Canonical Metadata Test");

  let result = service
    .import_from_bundle_with_filename_detailed(&bundle, "canonical-input.zip", user_id)
    .await
    .expect("import_from_bundle_with_filename_detailed failed");

  let report: Value = sqlx::query_scalar(
    "SELECT validation_report_json FROM template_import_jobs WHERE result_revision_id = $1 ORDER BY started_at DESC LIMIT 1",
  )
  .bind(result.revision.id)
  .fetch_one(&pool)
  .await
  .expect("import job report should exist");

  assert_eq!(report["status"], "completed");
  assert_eq!(report["result_revision_id"], result.revision.id.to_string());
  assert_eq!(report["detected_format"], "myoxus_bundle");
  assert_eq!(report["normalized"], false);
  assert_eq!(report["ignored_entries_count"], 0);
  assert_eq!(report["error_catalog_version"], TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION);
  let stage_names: Vec<String> = report["stages"]
    .as_array()
    .expect("stages should be an array")
    .iter()
    .map(|stage| {
      stage["name"]
        .as_str()
        .expect("stage name should be a string")
        .to_string()
    })
    .collect();
  assert_eq!(
    stage_names,
    vec!["detect", "unpack", "normalize", "validate", "persist"],
    "successful import should record the full stage pipeline"
  );
  let (
    source_format,
    detected_format,
    normalizer_version,
    ignored_entries_count,
    error_catalog_version,
    normalization_warnings_json,
  ): (
    String,
    String,
    String,
    i32,
    String,
    Value,
  ) = sqlx::query_as(
    "SELECT source_format, detected_format, normalizer_version, ignored_entries_count, error_catalog_version, normalization_warnings_json \
     FROM template_revisions WHERE id = $1",
  )
  .bind(result.revision.id)
  .fetch_one(&pool)
  .await
  .expect("revision metadata should exist");
  assert_eq!(source_format, "myoxus_bundle");
  assert_eq!(detected_format, "myoxus_bundle");
  assert_eq!(normalizer_version, "none");
  assert_eq!(ignored_entries_count, 0);
  assert_eq!(error_catalog_version, TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION);
  let warnings = normalization_warnings_json
    .as_array()
    .expect("normalization_warnings_json should be an array");
  assert_eq!(warnings.len(), 1);
  assert_eq!(warnings[0]["code"], "EMPTY_TAGS");

  cleanup_template(&pool, &result.entry.slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_import_rejects_undecodable_raw_workspace_before_revision() {
  let pool = helpers::setup_pool().await;
  let service = build_service(&pool);
  let user_id = helpers::create_user(&pool, "tmpl-meta-raw", true).await;
  let bundle = create_raw_workspace_bundle();
  let filename = format!("raw-workspace-{}.affine.zip", Uuid::new_v4().simple());

  let error = service
    .import_from_bundle_with_filename_detailed(&bundle, &filename, user_id)
    .await
    .expect_err("raw workspace markers without a supported portable document must fail");
  assert!(error.to_string().contains("INVALID_TEMPLATE_CONTENT"));

  let report: Value = sqlx::query_scalar(
    "SELECT validation_report_json FROM template_import_jobs WHERE created_by = $1 ORDER BY started_at DESC LIMIT 1",
  )
  .bind(user_id)
  .fetch_one(&pool)
  .await
  .expect("import job report should exist");

  assert_eq!(report["status"], "failed");
  assert_eq!(report["detected_format"], "raw_workspace_zip");
  assert_eq!(report["normalized"], true);
  assert_eq!(report["error"]["code"], "INVALID_TEMPLATE_CONTENT");
  let revision_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM template_revisions r JOIN template_import_jobs j ON j.result_revision_id = r.id WHERE j.created_by = $1",
  )
  .bind(user_id)
  .fetch_one(&pool)
  .await
  .expect("revision count");
  assert_eq!(revision_count, 0, "rejected raw content must not create a revision");
  sqlx::query("DELETE FROM template_import_jobs WHERE created_by = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("cleanup import jobs");
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_import_graphql_multipart_rejects_path_style_zip_error() {
  let _guard = helpers::TEMPLATE_REGISTRY_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .expect("template registry lock");
  let (app, pool, auth_store) = setup_graphql_template_registry_app().await;
  let user_id = helpers::create_user(&pool, "tmpl-gql-path", true).await;
  let session_id = helpers::create_session(&auth_store, user_id).await;
  let slug = format!("tmpl-gql-path-{}", Uuid::new_v4().simple());
  let bundle = create_path_traversal_bundle(&slug, "1.0.0", "Path Error Test");

  let resp = graphql_multipart_template_import(&app, session_id, "path-error.zip", "application/zip", &bundle).await;
  let errors = resp["errors"].as_array().expect("errors should be present");
  assert!(!errors.is_empty(), "expected graphql errors: {resp}");
  assert_eq!(errors[0]["path"], serde_json::json!(["admin", "importTemplate"]));
  assert_eq!(errors[0]["extensions"]["name"], "INVALID_INPUT");
  assert_eq!(errors[0]["extensions"]["code"], "BAD REQUEST");
  assert_eq!(errors[0]["extensions"]["type"], "BAD_REQUEST");
  let message = errors[0]["extensions"]["data"]["message"]
    .as_str()
    .expect("structured import error message");
  assert_eq!(message, "ZIP_SLIP_PATH: workspace archive contains a traversal path");
  assert!(
    !message.contains("../evil.txt"),
    "archive errors must not reflect attacker-controlled paths"
  );

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_import_graphql_multipart_rejects_upstream_template_json() {
  let _guard = helpers::TEMPLATE_REGISTRY_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .expect("template registry lock");
  let (app, pool, auth_store) = setup_graphql_template_registry_app().await;
  let user_id = helpers::create_user(&pool, "tmpl-gql-json", true).await;
  let session_id = helpers::create_session(&auth_store, user_id).await;
  let slug = format!("tmpl-gql-json-{}", Uuid::new_v4().simple());
  let payload = serde_json::json!({
    "name": slug,
    "type": "template",
    "preview": "<svg viewBox=\"0 0 10 10\"></svg>",
    "content": {
      "blocks": []
    }
  })
  .to_string();

  let resp = graphql_multipart_template_import(
    &app,
    session_id,
    "upstream-template.json",
    "application/json",
    payload.as_bytes(),
  )
  .await;

  let errors = resp["errors"].as_array().expect("errors should be present");
  assert!(!errors.is_empty(), "expected graphql errors: {resp}");
  assert_eq!(errors[0]["path"], serde_json::json!(["admin", "importTemplate"]));
  assert_eq!(errors[0]["extensions"]["name"], "INVALID_INPUT");
  assert_eq!(errors[0]["extensions"]["code"], "BAD REQUEST");
  assert_eq!(errors[0]["extensions"]["type"], "BAD_REQUEST");
  assert!(
    errors[0]["extensions"]["data"]["message"]
      .as_str()
      .expect("error message should be a string")
      .contains("UNSUPPORTED_TEMPLATE_JSON"),
    "expected UNSUPPORTED_TEMPLATE_JSON error, got: {resp}"
  );

  let import_job_id: Uuid =
    sqlx::query_scalar("SELECT id FROM template_import_jobs WHERE created_by = $1 ORDER BY started_at DESC LIMIT 1")
      .bind(user_id)
      .fetch_one(&pool)
      .await
      .expect("import job should exist");
  let rejected_events = list_audit_events(
    &pool,
    Some(TemplateRegistryAuditEventFilter {
      event_type: Some(TEMPLATE_IMPORT_FORMAT_REJECTED_EVENT.to_string()),
      import_job_id: Some(import_job_id),
      ..Default::default()
    }),
    0,
    20,
  )
  .await;
  let rejected = audit_event(&rejected_events, TEMPLATE_IMPORT_FORMAT_REJECTED_EVENT);
  assert_eq!(rejected.action, TemplateRegistryAuditAction::Failed);
  assert_eq!(rejected.actor_user_id, Some(user_id));
  assert_eq!(rejected.import_job_id, Some(import_job_id));
  assert_eq!(rejected.template_id, None);
  assert_eq!(rejected.revision_id, None);
  assert_eq!(rejected.source_format.as_deref(), Some("unknown"));
  assert_eq!(rejected.detected_format.as_deref(), Some("unknown"));
  assert_eq!(rejected.normalizer_version.as_deref(), Some("unknown"));
  assert_eq!(rejected.ignored_entries_count, Some(0));
  assert_eq!(
    rejected.error_catalog_version.as_deref(),
    Some(TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION)
  );
  assert_eq!(rejected.error_code.as_deref(), Some("UNSUPPORTED_TEMPLATE_JSON"));
  assert_eq!(
    rejected
      .payload_json
      .as_ref()
      .and_then(|json| json.get("filename"))
      .and_then(Value::as_str),
    Some("upstream-template.json")
  );
  assert_eq!(
    rejected
      .payload_json
      .as_ref()
      .and_then(|json| json.get("stage"))
      .and_then(Value::as_str),
    Some("detect")
  );
  assert_eq!(
    rejected
      .payload_json
      .as_ref()
      .and_then(|json| json.get("error_code"))
      .and_then(Value::as_str),
    Some("UNSUPPORTED_TEMPLATE_JSON")
  );

  cleanup_template(&pool, &slug).await;
  sqlx::query("DELETE FROM template_import_jobs WHERE created_by = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("cleanup import jobs should succeed");
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_upstream_snapshot_import_publish_export_reimport_roundtrip() {
  let (app, pool, auth_store, storage) = setup_template_registry_export_app().await;
  let user_id = helpers::create_user(&pool, "tmpl-upstream-roundtrip", true).await;
  let session_id = helpers::create_session(&auth_store, user_id).await;
  let bundle = create_upstream_snapshot_bundle();
  let service = build_service_with_storage(&pool, storage.clone());
  cleanup_template(&pool, "upstream-snapshot-roundtrip").await;

  let import = service
    .import_from_bundle_with_filename_detailed(&bundle, "upstream-snapshot-roundtrip.zip", user_id)
    .await
    .expect("upstream snapshot import should succeed");
  assert_eq!(import.detected_format.as_str(), "upstream_snapshot_zip");
  assert!(
    import.normalized,
    "upstream snapshot import must be marked as normalized"
  );
  assert_eq!(import.revision.version, "1.0.0");
  assert_eq!(import.entry.slug, "upstream-snapshot-roundtrip");
  let stored_bundle_key = import
    .revision
    .bundle_blob_id
    .as_ref()
    .expect("imported revision must have bundle_blob_id");
  let (stored_bundle_bytes, stored_content_type) = storage
    .get(stored_bundle_key)
    .expect("normalized bundle blob should be written");
  assert_eq!(
    stored_content_type.as_deref(),
    Some("application/zip"),
    "normalized bundle must be written as zip blob"
  );
  let stored_bundle_parsed = myoxus_application::template_registry::bundle::parse_bundle(&stored_bundle_bytes)
    .expect("stored bundle should parse as template bundle");
  assert_eq!(
    stored_bundle_parsed.format.as_str(),
    "myoxus_bundle",
    "stored artifact must be normalized to internal bundle format"
  );
  assert_eq!(
    zip_entry_names_from_bytes(&stored_bundle_bytes),
    vec!["content.template.zip".to_string(), "manifest.json".to_string()],
    "normalized stored bundle must contain only canonical entries"
  );

  service
    .publish_revision(import.revision.id)
    .await
    .expect("publish_revision failed");

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/api/admin/templates/export/{}", import.revision.id))
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .expect("building export request should not fail"),
    )
    .await
    .expect("sending export request should not fail");
  assert_eq!(response.status(), axum::http::StatusCode::OK);
  let exported_bundle = response
    .into_body()
    .collect()
    .await
    .expect("collecting export body should not fail")
    .to_bytes()
    .to_vec();

  let exported_parsed = myoxus_application::template_registry::bundle::parse_bundle(&exported_bundle)
    .expect("exported bundle should parse");
  assert_eq!(exported_parsed.format.as_str(), "myoxus_bundle");
  assert_eq!(exported_parsed.manifest.template_id, import.entry.slug);
  assert_eq!(exported_parsed.manifest.version, "1.0.0");

  cleanup_template(&pool, &import.entry.slug).await;

  let reimport = service
    .import_from_bundle_with_filename_detailed(&exported_bundle, "roundtrip-from-export.zip", user_id)
    .await
    .expect("reimport of exported myoxus bundle should succeed");
  assert_eq!(reimport.detected_format.as_str(), "myoxus_bundle");
  assert!(!reimport.normalized);
  assert_eq!(reimport.entry.slug, import.entry.slug);
  assert_eq!(reimport.revision.version, import.revision.version);

  cleanup_template(&pool, &reimport.entry.slug).await;
  cleanup_template(&pool, &reimport.entry.slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_registry_store_revision_crud_roundtrip() {
  let pool = helpers::setup_pool().await;
  let store = SqlxTemplateRegistryStore::new(pool.clone());
  let user_id = helpers::create_user(&pool, "tmpl-store-crud", true).await;
  let slug = format!("tmpl-store-crud-{}", Uuid::new_v4().simple());

  let entry = TemplateCatalogEntry {
    id: Uuid::new_v4(),
    slug: slug.clone(),
    title: "Store CRUD".to_string(),
    description: Some("Store CRUD test".to_string()),
    category: Some("test".to_string()),
    tags: vec!["store".to_string()],
    status: TemplateStatus::Active,
    source: myoxus_domain::template_registry::TemplateSource::Bundle,
    builder_version: None,
    min_client_version: 0,
    created_at: Utc::now(),
    updated_at: Utc::now(),
    archived_at: None,
  };
  store
    .create_catalog_entry(&entry)
    .await
    .expect("create_catalog_entry should succeed");

  let revision_id = TemplateRevisionId::new_v4();
  let mut revision = TemplateRevision {
    id: revision_id,
    template_id: entry.id,
    version: "1.0.0".to_string(),
    state: RevisionState::Draft,
    bundle_blob_id: Some("blob-1".to_string()),
    preview_blob_id: None,
    checksum: Some("checksum-1".to_string()),
    manifest: Some(json!({"template_id": slug, "version":"1.0.0", "title":"Store CRUD"})),
    release_notes: Some("initial".to_string()),
    created_by: Some(user_id),
    created_at: Utc::now(),
    published_at: None,
    source_format: "upstream_snapshot_zip".to_string(),
    normalizer_version: myoxus_application::template_registry::TEMPLATE_REGISTRY_NORMALIZER_VERSION.to_string(),
    detected_format: "myoxus_bundle".to_string(),
    ignored_entries_count: 2,
    error_catalog_version: myoxus_application::template_registry::TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION.to_string(),
    normalization_warnings: vec![myoxus_domain::template_registry::NormalizationWarning {
      code: "EMPTY_TAGS".to_string(),
      message: "no tags specified".to_string(),
      field: Some("tags".to_string()),
      path: Some("/manifest/tags".to_string()),
    }],
  };
  store
    .create_revision(&revision)
    .await
    .expect("create_revision should succeed");

  let loaded = store
    .get_revision(revision_id)
    .await
    .expect("get_revision should succeed")
    .expect("revision should exist");
  assert_eq!(loaded.id, revision.id);
  assert_eq!(loaded.source_format, revision.source_format);
  assert_eq!(loaded.detected_format, revision.detected_format);
  assert_eq!(loaded.normalizer_version, revision.normalizer_version);
  assert_eq!(loaded.ignored_entries_count, revision.ignored_entries_count);
  assert_eq!(loaded.error_catalog_version, revision.error_catalog_version);
  assert_eq!(loaded.normalization_warnings.len(), 1);

  revision.release_notes = Some("updated release notes".to_string());
  revision.state = RevisionState::Published;
  revision.published_at = Some(Utc::now());
  store
    .update_revision(&revision)
    .await
    .expect("update_revision should succeed");

  let listed = store
    .list_revisions(entry.id, 0, 50)
    .await
    .expect("list_revisions should succeed");
  assert!(
    listed
      .iter()
      .any(|item| item.id == revision_id && item.release_notes.as_deref() == Some("updated release notes")),
    "updated revision should be listed"
  );

  let latest_published = store
    .get_latest_published_revision(entry.id)
    .await
    .expect("get_latest_published_revision should succeed")
    .expect("published revision should exist");
  assert_eq!(latest_published.id, revision_id);

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_registry_migration_defaults_backfill_legacy_revision_rows() {
  let pool = helpers::setup_pool().await;
  let store = SqlxTemplateRegistryStore::new(pool.clone());
  let user_id = helpers::create_user(&pool, "tmpl-migration-backfill", true).await;
  let slug = format!("tmpl-migration-backfill-{}", Uuid::new_v4().simple());
  let template_id = Uuid::new_v4();
  let revision_id = Uuid::new_v4();

  sqlx::query(
    "INSERT INTO template_catalog_entries (id, slug, title, description, category, tags, status, created_by, created_at, archived_at) \
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, NOW(), NULL)",
  )
  .bind(template_id)
  .bind(&slug)
  .bind("Migration Backfill")
  .bind("legacy row simulation")
  .bind("test")
  .bind(Vec::<String>::new())
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert catalog entry should succeed");

  // Simulate pre-format-metadata row insert by omitting 0072/0073 fields.
  sqlx::query(
    "INSERT INTO template_revisions \
      (id, template_id, version, state, bundle_blob_id, preview_blob_id, checksum, manifest_json, release_notes, created_by, created_at, published_at) \
     VALUES \
      ($1, $2, $3, 'draft', $4, NULL, $5, $6, '', $7, NOW(), NULL)",
  )
  .bind(revision_id)
  .bind(template_id)
  .bind("1.0.0")
  .bind("legacy-bundle")
  .bind("legacy-checksum")
  .bind(json!({"template_id": slug, "version":"1.0.0", "title":"Legacy"}))
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert legacy revision row should succeed");

  let loaded = store
    .get_revision(revision_id)
    .await
    .expect("get_revision should succeed")
    .expect("legacy revision should be readable after migration");
  assert_eq!(loaded.source_format, "legacy_unknown");
  assert_eq!(loaded.normalizer_version, "none");
  assert_eq!(loaded.detected_format, "unknown");
  assert_eq!(loaded.ignored_entries_count, 0);
  assert_eq!(loaded.error_catalog_version, "unknown");
  assert!(loaded.normalization_warnings.is_empty());

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_ts09_assigned_shipped_bundle_materializes_with_workspace_actor() {
  let (app, pool, auth_store) = setup_graphql_template_registry_app().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage);
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "tmpl-materialize").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("test-materialize-{}", Uuid::new_v4().simple());
  // A workspace root is not a document. Exercise the actual browser export
  // shape, including native Text markers and nested block children.
  let source = serde_json::json!({
    "meta": {"id":"source", "title":"Meeting {{workspace.name}}"},
    "blocks": {"type":"block", "id":"page", "flavour":"myoxus:page", "version":2,
      "props":{"title":{"$blocksuite:internal:text$":true,"delta":[{"insert":"Meeting {{workspace.name}}"}]}},
      "children":[{"type":"block","id":"note","flavour":"myoxus:note","version":1,"props":{},
        "children":[{"type":"block","id":"paragraph","flavour":"myoxus:paragraph","version":1,
          "props":{"type":"text","text":{"$blocksuite:internal:text$":true,"delta":[{"insert":"Creator {{creator.name}}","attributes":{"bold":true}}]}},"children":[]}]}]}
  });
  let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
  zip
    .start_file("source.snapshot.json", zip::write::FileOptions::<()>::default())
    .unwrap();
  zip.write_all(&serde_json::to_vec(&source).unwrap()).unwrap();
  let source_zip = zip.finish().unwrap().into_inner();
  let bundle = create_test_bundle_with_content_zip(&slug, "1.0.0", "Materialize Test", &source_zip);

  let (entry, revision) = service
    .register_shipped_bundle(&bundle, "materialized-shipped-template.zip")
    .await
    .expect("shipped registration failed");
  assert_eq!(
    revision.created_by, None,
    "server-supplied revision has no fabricated actor"
  );
  service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .expect("assign_template_to_workspace failed");

  let results = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("reconcile_workspace_templates failed");
  assert_eq!(results.len(), 1);
  let instance = &results[0];
  assert_eq!(instance.workspace_id, workspace_id);
  assert_eq!(instance.template_id, entry.id);
  assert_eq!(instance.revision_id, revision.id);
  assert_eq!(
    instance.state.to_string().to_ascii_lowercase(),
    "ok",
    "materialization failed with error: {:?}",
    instance.last_error_message
  );
  assert!(
    instance.workspace_doc_id.is_some(),
    "materialized instance must have a workspace_doc_id"
  );
  assert!(
    instance.last_applied_hash.is_some(),
    "materialized instance must store last_applied_hash"
  );
  assert_eq!(instance.last_applied_hash, instance.current_hash);

  let doc_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE id = $1")
    .bind(instance.workspace_doc_id.expect("workspace_doc_id must exist"))
    .fetch_one(&pool)
    .await
    .expect("doc existence query should succeed");
  assert_eq!(doc_count, 1, "reconcile should materialize a real workspace doc");
  let attribution: (String, Option<Uuid>, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
    "SELECT state, template_id, revision_id, instance_id FROM document_template_state WHERE doc_id = $1",
  )
  .bind(instance.workspace_doc_id.expect("workspace_doc_id must exist"))
  .fetch_one(&pool)
  .await
  .expect("materialized document attribution must exist");
  assert_eq!(attribution.0, "managed");
  assert_eq!(attribution.1, None, "Registry identity stays in the instance binding");
  assert_eq!(attribution.2, None, "Registry revision stays in the instance binding");
  assert_eq!(attribution.3, None, "Registry instance stays in the instance binding");

  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let state = documents
    .load_full_doc(workspace_id, instance.workspace_doc_id.unwrap())
    .await
    .unwrap();
  let extracted = yjs::extract_text_from_yjs(&state).unwrap();
  assert_eq!(extracted.title.as_deref(), Some("Meeting {{workspace.name}}"));
  assert!(extracted.markdown.contains("**Creator {{creator.name}}**"));
  let blocks = yjs::extract_blocks_from_yjs(&state).unwrap();
  assert_eq!(
    blocks
      .blocks
      .iter()
      .filter(|block| block.flavour == "myoxus:page")
      .count(),
    1
  );
  assert!(instance.workspace_doc_key.as_ref().is_some_and(|key| !key.is_empty()));

  let source_id = instance.workspace_doc_id.expect("workspace_doc_id must exist");
  let source_key = instance
    .workspace_doc_key
    .as_deref()
    .expect("workspace_doc_key must exist");

  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let discovery = json!({
    "query": "query Sources($workspaceId: ID!) { admin { workspaceTemplateSources(workspaceId: $workspaceId, take: 1) { sources { docId title documentRevision metadataRevision identifier version category } nextOffset } } }",
    "variables": { "workspaceId": workspace_id.to_string() }
  });
  let denied = graphql_json(&app, session_id, discovery.clone()).await;
  assert!(denied["errors"].is_array(), "discovery requires Admin access: {denied}");
  assert_eq!(denied["errors"][0]["extensions"]["code"], "FORBIDDEN");
  let denied = graphql_json(&app, admin_session, discovery.clone()).await;
  assert!(
    denied["errors"].is_array(),
    "Admin discovery must retain workspace visibility: {denied}"
  );
  assert_eq!(denied["errors"][0]["extensions"]["code"], "NOT FOUND");
  helpers::add_workspace_member(&pool, workspace_id, admin_id).await;
  let discovered = graphql_json(&app, admin_session, discovery).await;
  assert!(discovered["errors"].is_null(), "source discovery failed: {discovered}");
  let page = &discovered["data"]["admin"]["workspaceTemplateSources"];
  let source = &page["sources"][0];
  assert_eq!(page["sources"].as_array().unwrap().len(), 1);
  assert!(page["nextOffset"].is_null());
  assert_eq!(source["docId"], source_key);
  assert_eq!(source["identifier"], slug);
  assert_eq!(source["version"], "1.0.0");
  assert_eq!(source["category"], "test");
  let expected = documents
    .store()
    .preview_source_identity(workspace_id, source_id)
    .await
    .unwrap()
    .unwrap();
  let metadata_revision: i64 = sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id = $1")
    .bind(source_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(source["title"], expected.title);
  assert_eq!(source["documentRevision"], expected.revision);
  // The preview identity's timestamp is not the metadata mutation counter.
  assert_eq!(source["metadataRevision"], metadata_revision);

  // Editing is deliberately preserved for assigned sources.
  let title_delta = yjs::update_document_title(&state, "Managed source edited").unwrap();
  documents
    .push_update_raw(workspace_id, source_id, title_delta, DocSpaceKind::Workspace)
    .await
    .expect("managed source content must remain editable");

  let trash_error = documents
    .trash_page(workspace_id, source_id, user_id)
    .await
    .expect_err("ordinary trash must reject a managed source");
  assert!(trash_error.to_string().contains(ASSIGNED_TEMPLATE_SOURCE_PROTECTED));

  let root = documents.load_full_doc(workspace_id, workspace_id).await.unwrap();
  let stale_client_trash = yjs::update_root_page_metadata(
    &root,
    source_key,
    None,
    Some(true),
    None,
    chrono::Utc::now().timestamp_millis(),
  )
  .unwrap();
  let stale_error = documents
    .push_update_raw(
      workspace_id,
      workspace_id,
      stale_client_trash.update,
      DocSpaceKind::Workspace,
    )
    .await
    .expect_err("stale root projection must not trash a managed source");
  assert!(stale_error.to_string().contains(ASSIGNED_TEMPLATE_SOURCE_PROTECTED));

  let unmark_error = PgDocumentMetadataRepository::new(pool.clone())
    .apply_patch(
      source_id,
      user_id,
      &DocumentMetadataPatch {
        template_state: Some(None),
        ..DocumentMetadataPatch::default()
      },
    )
    .await
    .expect_err("ordinary unmark must reject a managed source");
  assert!(unmark_error.to_string().contains(ASSIGNED_TEMPLATE_SOURCE_PROTECTED));

  let classification_error = PgDocumentMetadataRepository::new(pool.clone())
    .apply_patch(
      source_id,
      user_id,
      &DocumentMetadataPatch {
        template_category: Some(Some("building-blocks".to_string())),
        template_tags: Some(Some(vec!["project".to_string()])),
        ..DocumentMetadataPatch::default()
      },
    )
    .await
    .expect_err("custom metadata must not override Registry classification");
  assert!(classification_error.to_string().contains("managed in Admin Templates"));

  let deleted = documents
    .permanently_delete_documents(PermanentDeleteRequest {
      workspace_id,
      actor_user_id: Some(user_id),
      mode: PermanentDeleteMode::SelectedDocs,
      doc_ids: vec![source_key.to_string()],
    })
    .await
    .unwrap();
  assert_eq!(deleted.documents[0].status, PermanentDeleteStatus::Forbidden);
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM docs WHERE id = $1")
      .bind(source_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
    1,
    "rejected destructive writes must leave the source intact"
  );

  let ordinary = PageLifecycleService::new(Arc::new(SqlxDocStore::new(pool.clone())))
    .create(workspace_id, user_id, Some("Ordinary target".to_string()), None)
    .await
    .unwrap();
  documents
    .trash_page(workspace_id, ordinary.document.id, user_id)
    .await
    .expect("ordinary documents must retain trash behavior");

  let forged_retirement = graphql_json(
    &app,
    session_id,
    json!({
      "query": "mutation Retire($workspaceId: String!, $slug: String!) { reportTemplateBuilderTrashed(workspaceId: $workspaceId, slug: $slug) }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "slug": slug
      }
    }),
  )
  .await;
  assert!(
    forged_retirement["errors"][0]["message"]
      .as_str()
      .is_some_and(|message| message.contains("client-reported retirement is unsupported")),
    "ordinary clients must not turn source deletion into Registry retirement: {forged_retirement}"
  );
  let instance_state: String =
    sqlx::query_scalar("SELECT state FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2")
      .bind(workspace_id)
      .bind(entry.id)
      .fetch_one(&pool)
      .await
      .expect("read protected instance after forged retirement");
  assert_ne!(instance_state, "retired");

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id, admin_id]).await;
}

#[tokio::test]
async fn inv_template_reconcile_is_idempotent_for_existing_materialized_instance() {
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage);
  let user_id = helpers::create_user(&pool, "tmpl-reconcile-idempotent", true).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("test-reconcile-idempotent-{}", Uuid::new_v4().simple());
  let yjs_content = yjs::markdown_to_yjs("Idempotent", "Preserve this body").unwrap();
  let bundle = create_test_bundle_with_content(&slug, "1.0.0", "Reconcile Idempotent", &yjs_content);

  let (entry, revision, _) = service
    .import_from_bundle(&bundle, user_id)
    .await
    .expect("import_from_bundle failed");
  service
    .publish_revision(revision.id)
    .await
    .expect("publish_revision failed");
  service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::SeedOnce,
    )
    .await
    .expect("assign_template_to_workspace failed");

  let placeholder_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspace_template_instances (id, workspace_id, template_id, revision_id, state) VALUES ($1,$2,$3,$4,'ok')")
    .bind(placeholder_id).bind(workspace_id).bind(entry.id).bind(revision.id)
    .execute(&pool).await.expect("seed the old worker's documentless row");

  let first = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("first reconcile failed");
  assert_eq!(first.len(), 1);
  let first_instance = first[0].clone();

  assert_eq!(first_instance.id, placeholder_id);
  assert!(first_instance.workspace_doc_id.is_some());

  let second = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("second reconcile failed");
  assert_eq!(second.len(), 1);
  let second_instance = &second[0];

  assert_eq!(second_instance.id, first_instance.id);
  assert_eq!(second_instance.workspace_doc_id, first_instance.workspace_doc_id);
  assert_eq!(second_instance.revision_id, first_instance.revision_id);
  assert_eq!(second_instance.last_applied_hash, first_instance.last_applied_hash);
  assert_eq!(second_instance.current_hash, first_instance.current_hash);
  assert_eq!(
    second_instance.state.to_string().to_ascii_lowercase(),
    "ok",
    "reconcile ended in non-ok state: {:?}",
    second_instance.last_error_message
  );

  let instance_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_one(&pool)
  .await
  .expect("instance count query should succeed");
  assert_eq!(
    instance_count, 1,
    "reconcile must stay idempotent and not create duplicate instances"
  );

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_import_failure_is_rollback_safe_and_retryable() {
  let pool = helpers::setup_pool().await;
  let failing_service = build_service_with_blob_port(&pool, Arc::new(FailingBlobStorage));
  let user_id = helpers::create_user(&pool, "tmpl-import-retry", true).await;
  let slug = format!("tmpl-import-retry-{}", Uuid::new_v4().simple());
  let bundle = create_test_bundle(&slug, "1.0.0", "Import Retry");

  let err = failing_service
    .import_from_bundle_with_filename_detailed(&bundle, "retry-test.zip", user_id)
    .await
    .expect_err("import should fail when blob storage write fails");
  assert!(
    err.to_string().contains("intentional write failure"),
    "expected storage write failure, got: {err}"
  );

  let failed_job_state: String =
    sqlx::query_scalar("SELECT state FROM template_import_jobs WHERE created_by = $1 ORDER BY started_at DESC LIMIT 1")
      .bind(user_id)
      .fetch_one(&pool)
      .await
      .expect("failed import job should exist");
  assert_eq!(failed_job_state, "failed");

  let failed_entry_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM template_catalog_entries WHERE slug = $1")
    .bind(&slug)
    .fetch_one(&pool)
    .await
    .expect("catalog count query should succeed");
  assert_eq!(
    failed_entry_count, 0,
    "failed import must not persist catalog/revision artifacts"
  );

  let storage = Arc::new(TestBlobStorage::default());
  let retry_service = build_service_with_storage(&pool, storage);
  let retry = retry_service
    .import_from_bundle_with_filename_detailed(&bundle, "retry-test.zip", user_id)
    .await
    .expect("retry import should succeed");
  assert_eq!(retry.entry.slug, slug);
  assert_eq!(retry.revision.version, "1.0.0");

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_reconcile_parallel_runs_do_not_create_duplicate_instances() {
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage);
  let user_id = helpers::create_user(&pool, "tmpl-reconcile-parallel", true).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("tmpl-reconcile-parallel-{}", Uuid::new_v4().simple());
  let yjs_content = yjs::markdown_to_yjs("Parallel Reconcile", "Preserve this body").unwrap();
  let bundle = create_test_bundle_with_content(&slug, "1.0.0", "Parallel Reconcile", &yjs_content);

  let (entry, revision, _) = service
    .import_from_bundle(&bundle, user_id)
    .await
    .expect("import_from_bundle failed");
  service
    .publish_revision(revision.id)
    .await
    .expect("publish_revision failed");
  service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::SeedOnce,
    )
    .await
    .expect("assign_template_to_workspace failed");

  let (first, second) = tokio::join!(
    service.reconcile_workspace_templates(workspace_id),
    service.reconcile_workspace_templates(workspace_id)
  );
  let first = first.expect("first reconcile should succeed");
  let second = second.expect("second reconcile should succeed");
  assert_eq!(first.len(), 1);
  assert_eq!(second.len(), 1);

  let instance_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM workspace_template_instances WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(workspace_id)
  .bind(entry.id)
  .fetch_one(&pool)
  .await
  .expect("instance count query should succeed");
  assert_eq!(
    instance_count, 1,
    "parallel reconcile runs must not create duplicate instances"
  );
  let document_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM docs WHERE workspace_id = $1 AND is_workspace_root = FALSE AND deleted_at IS NULL",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("document count query should succeed");
  assert_eq!(document_count, 1, "the losing attempt must not leak a document");
  let root_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1 AND is_workspace_root = TRUE")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("root count query should succeed");
  assert_eq!(root_count, 1, "parallel provisioning must reuse the workspace root");

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_ts03_bundle_reconcile_repairs_a_missing_source_idempotently() {
  let (app, pool, auth_store, storage) = setup_template_registry_export_app().await;
  let service = build_materializing_service(&pool, storage);
  let (user_id, session) = helpers::seed_user(&pool, &auth_store, "tmpl-reconcile-missing").await;
  let (reader, reader_session) = helpers::seed_user(&pool, &auth_store, "tmpl-reconcile-reader").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::add_workspace_member(&pool, workspace_id, reader).await;
  sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2")
    .bind(workspace_id)
    .bind(reader)
    .execute(&pool)
    .await
    .unwrap();
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("tmpl-reconcile-missing-{}", Uuid::new_v4().simple());
  let bundle = create_test_bundle_with_content(
    &slug,
    "1.0.0",
    "Missing Source Repair",
    &yjs::markdown_to_yjs("Repair Source", "Persisted replacement body").unwrap(),
  );
  let (entry, revision, _) = service
    .import_from_bundle(&bundle, user_id)
    .await
    .expect("import bundle");
  service.publish_revision(revision.id).await.expect("publish revision");
  service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .expect("assign template");
  let original = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("initial reconcile")[0]
    .workspace_doc_id
    .expect("initial source");
  sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
    .bind(original)
    .execute(&pool)
    .await
    .expect("trash original source");

  let request = |provision: bool| {
    json!({
      "query":"mutation Repair($workspaceId:String!,$provision:Boolean){workspaceTemplateReconcileSlugs(workspaceId:$workspaceId,locale:\"en\",provisionSources:$provision){slug}}",
      "variables":{"workspaceId":workspace_id.to_string(),"provision":provision},
    })
  };
  let passive = graphql_json(&app, session, request(false)).await;
  assert!(passive.get("errors").is_none(), "{passive}");
  let untouched = service
    .store()
    .find_instance(workspace_id, entry.id)
    .await
    .unwrap()
    .unwrap();
  assert_eq!(
    untouched.workspace_doc_id,
    Some(original),
    "passive binding reads do not repair sources"
  );
  let denied = graphql_json(&app, reader_session, request(true)).await;
  assert_eq!(denied["errors"][0]["extensions"]["name"], "ACTION_FORBIDDEN");
  let repaired = graphql_json(&app, session, request(true)).await;
  assert!(repaired.get("errors").is_none(), "{repaired}");
  let repaired = service
    .store()
    .find_instance(workspace_id, entry.id)
    .await
    .unwrap()
    .unwrap();
  let replacement = repaired.workspace_doc_id.expect("replacement source");
  assert_ne!(replacement, original);
  let content = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
    .load_full_doc(workspace_id, replacement)
    .await
    .expect("read replacement source");
  let extracted = yjs::extract_text_from_yjs(&content).expect("extract replacement source");
  assert_eq!(extracted.title.as_deref(), Some("Repair Source"));
  assert!(extracted.markdown.contains("Persisted replacement body"));

  let repeated = graphql_json(&app, session, request(true)).await;
  assert!(repeated.get("errors").is_none(), "{repeated}");
  let stable = service
    .store()
    .find_instance(workspace_id, entry.id)
    .await
    .unwrap()
    .unwrap();
  assert_eq!(stable.workspace_doc_id, Some(replacement));
  let live_docs: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM docs
     WHERE workspace_id = $1 AND is_workspace_root = FALSE AND deleted_at IS NULL",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("count live sources");
  assert_eq!(live_docs, 1, "repair and retry must retain one canonical source");

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id, reader]).await;
}

#[tokio::test]
async fn inv_template_reconcile_revision_update_does_not_detach_instance() {
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage);
  let user_id = helpers::create_user(&pool, "tmpl-reconcile-update-no-detach", true).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("test-reconcile-update-no-detach-{}", Uuid::new_v4().simple());

  let bundle_v1 = create_test_bundle_with_content(
    &slug,
    "1.0.0",
    "Reconcile Update Test",
    &yjs::markdown_to_yjs("Reconcile V1", "Original content").unwrap(),
  );
  let (entry, revision_v1, _) = service
    .import_from_bundle(&bundle_v1, user_id)
    .await
    .expect("import v1 failed");
  service
    .publish_revision(revision_v1.id)
    .await
    .expect("publish v1 failed");
  service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::SeedOnce,
    )
    .await
    .expect("assign_template_to_workspace failed");

  let first = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("first reconcile failed");
  assert_eq!(first.len(), 1);
  let first_instance = first[0].clone();
  assert_eq!(first_instance.revision_id, revision_v1.id);

  let bundle_v2 = create_test_bundle_with_content(
    &slug,
    "2.0.0",
    "Reconcile Update Test",
    &yjs::markdown_to_yjs("Reconcile V2", "Updated content").unwrap(),
  );
  let (_, revision_v2, _) = service
    .import_from_bundle(&bundle_v2, user_id)
    .await
    .expect("import v2 failed");
  service
    .publish_revision(revision_v2.id)
    .await
    .expect("publish v2 failed");

  let second = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("second reconcile failed");
  assert_eq!(second.len(), 1);
  let second_instance = &second[0];

  assert_eq!(second_instance.id, first_instance.id);
  assert_eq!(second_instance.workspace_doc_id, first_instance.workspace_doc_id);
  assert_ne!(revision_v1.id, revision_v2.id);
  assert_eq!(second_instance.revision_id, revision_v1.id);
  assert_eq!(
    second_instance.last_applied_hash, first_instance.last_applied_hash,
    "SeedOnce must preserve the original materialized document"
  );
  assert_eq!(second_instance.last_applied_hash, second_instance.current_hash);
  assert_eq!(
    second_instance.state.to_string().to_ascii_lowercase(),
    "ok",
    "server-side reconcile revision updates must not force-detach instances"
  );

  let (db_state, detached_at): (String, Option<chrono::DateTime<chrono::Utc>>) =
    sqlx::query_as("SELECT state, detached_at FROM workspace_template_instances WHERE id = $1")
      .bind(second_instance.id)
      .fetch_one(&pool)
      .await
      .expect("instance query should succeed");
  assert_eq!(db_state, "ok");
  assert!(
    detached_at.is_none(),
    "instance must not be detached after server-side reconcile update"
  );

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_reconcile_managed_update_preserves_identity_and_updates_source() {
  use futures_util::FutureExt;
  use myoxus_application::template_registry::ShippedTemplateSelection;
  use myoxus_domain::template_registry::{ProvisioningMode, SelectionMode};
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage);
  let user_id = helpers::create_user(&pool, "tmpl-reconcile-managed-update", true).await;
  let slug = format!("tmpl-reconcile-managed-update-{}", Uuid::new_v4().simple());
  let result = std::panic::AssertUnwindSafe(async {
    let workspace_id = helpers::create_workspace(&pool, user_id).await;
    helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;

    let bundle_v1 = create_test_bundle_with_content(
      &slug,
      "1.0.0",
      "Managed Update",
      &yjs::markdown_to_yjs("Managed Update V1", "Original managed content").unwrap(),
    );
    let (entry, revision_v1) = service
      .stage_shipped_catalog_bundle(&bundle_v1, "released-document.zip")
      .await
      .expect("import v1");
    service
      .commit_shipped_catalog_selection(&[ShippedTemplateSelection {
        template_id: entry.id,
        current_revision_id: Some(revision_v1.id),
        history_revision_ids: vec![],
        new_workspace_default: true,
      }])
      .await
      .expect("select released v1");
    // Reproduce the deployed release-owned seed-once default without changing its
    // positive provenance. Fresh seeding must also correct that purpose mismatch.
    sqlx::query(
      "UPDATE template_default_policies SET provisioning_mode='seed_once' WHERE template_id=$1 AND release_managed",
    )
    .bind(entry.id)
    .execute(&pool)
    .await
    .unwrap();
    service
      .assign_template_to_workspace(
        workspace_id,
        entry.id,
        SelectionMode::Published,
        None,
        ProvisioningMode::SeedOnce,
      )
      .await
      .expect("reproduce previously seeded release assignment");
    let first = service
      .reconcile_workspace_templates(workspace_id)
      .await
      .expect("materialize v1")
      .into_iter()
      .next()
      .expect("v1 instance");
    let doc_id = first.workspace_doc_id.expect("v1 document");

    let fresh_workspace = helpers::create_workspace(&pool, user_id).await;
    helpers::create_workspace_root_doc(&pool, fresh_workspace, user_id).await;
    service
      .store()
      .apply_default_policies_to_new_workspace(fresh_workspace)
      .await
      .unwrap();
    let fresh_policy = service
      .store()
      .list_policies_for_workspace(fresh_workspace)
      .await
      .unwrap()
      .into_iter()
      .find(|policy| policy.template_id == entry.id)
      .unwrap();
    assert_eq!(fresh_policy.provisioning_mode, ProvisioningMode::ManagedUntilLocalEdit);
    let fresh_first = service
      .reconcile_workspace_templates(fresh_workspace)
      .await
      .unwrap()
      .into_iter()
      .find(|instance| instance.template_id == entry.id)
      .unwrap();

    let bundle_v2 = create_test_bundle_with_content(
      &slug,
      "2.0.0",
      "Managed Update",
      &yjs::markdown_to_yjs("Managed Update V2", "Updated managed content").unwrap(),
    );
    let (_, revision_v2) = service
      .stage_shipped_catalog_bundle(&bundle_v2, "released-document.zip")
      .await
      .expect("import v2");
    service
      .commit_shipped_catalog_selection(&[ShippedTemplateSelection {
        template_id: entry.id,
        current_revision_id: Some(revision_v2.id),
        history_revision_ids: vec![revision_v1.id],
        new_workspace_default: true,
      }])
      .await
      .expect("select released v2 and correct old seeded policy");

    let second = service
      .reconcile_workspace_templates(workspace_id)
      .await
      .expect("apply managed update")
      .into_iter()
      .next()
      .expect("updated instance");
    assert_eq!(second.id, first.id);
    assert_eq!(second.workspace_doc_id, Some(doc_id));
    assert_eq!(second.revision_id, revision_v2.id);
    assert_eq!(second.state, myoxus_domain::template_registry::InstanceState::Ok);
    let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
    let live = documents
      .load_full_doc(workspace_id, doc_id)
      .await
      .expect("read updated source");
    let extracted = yjs::extract_text_from_yjs(&live).expect("extract updated source");
    assert_eq!(extracted.title.as_deref(), Some("Managed Update V2"));
    assert!(extracted.markdown.contains("Updated managed content"));
    assert!(!extracted.markdown.contains("Original managed content"));

    let fresh_next = service
      .reconcile_workspace_templates(fresh_workspace)
      .await
      .unwrap()
      .into_iter()
      .find(|instance| instance.template_id == entry.id)
      .unwrap();
    assert_eq!(fresh_next.id, fresh_first.id);
    assert_eq!(fresh_next.workspace_doc_id, fresh_first.workspace_doc_id);
    assert_eq!(fresh_next.revision_id, revision_v2.id);
    let fresh_content = documents
      .load_full_doc(fresh_workspace, fresh_next.workspace_doc_id.unwrap())
      .await
      .unwrap();
    assert!(
      yjs::extract_text_from_yjs(&fresh_content)
        .unwrap()
        .markdown
        .contains("Updated managed content")
    );
  })
  .catch_unwind()
  .await;

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_template_reconcile_preserves_edit_inserted_after_initial_drift_check() {
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage.clone());
  let user_id = helpers::create_user(&pool, "tmpl-reconcile-update-race", true).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("tmpl-reconcile-update-race-{}", Uuid::new_v4().simple());

  let bundle_v1 = create_test_bundle_with_content(
    &slug,
    "1.0.0",
    "Race V1",
    &yjs::markdown_to_yjs("Race V1", "Original managed content").unwrap(),
  );
  let (entry, revision_v1, _) = service
    .import_from_bundle(&bundle_v1, user_id)
    .await
    .expect("import v1");
  service.publish_revision(revision_v1.id).await.expect("publish v1");
  service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .expect("assign managed template");
  let first = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("materialize v1")
    .remove(0);
  let doc_id = first.workspace_doc_id.expect("materialized source");

  let bundle_v2 = create_test_bundle_with_content(
    &slug,
    "2.0.0",
    "Race V2",
    &yjs::markdown_to_yjs("Race V2", "Central replacement content").unwrap(),
  );
  let (_, revision_v2, _) = service
    .import_from_bundle(&bundle_v2, user_id)
    .await
    .expect("import v2");
  service.publish_revision(revision_v2.id).await.expect("publish v2");

  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  storage.edit_document_on_next_read(ReadEdit {
    documents: documents.clone(),
    workspace_id,
    doc_id,
    replacement: yjs::markdown_to_yjs("Local edit", "This edit must survive the update race").unwrap(),
  });
  let reconciled = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("reconcile must preserve the raced edit")
    .remove(0);

  assert_eq!(reconciled.revision_id, revision_v1.id);
  assert_eq!(
    reconciled.state,
    myoxus_domain::template_registry::InstanceState::Detached
  );
  let live = documents
    .load_full_doc(workspace_id, doc_id)
    .await
    .expect("read preserved source");
  let extracted = yjs::extract_text_from_yjs(&live).expect("extract preserved source");
  assert_eq!(extracted.title.as_deref(), Some("Local edit"));
  assert!(extracted.markdown.contains("This edit must survive the update race"));
  assert!(!extracted.markdown.contains("Central replacement content"));

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_reconcile_manual_update_only_reports_availability() {
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage);
  let user_id = helpers::create_user(&pool, "tmpl-reconcile-manual-update", true).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("tmpl-reconcile-manual-update-{}", Uuid::new_v4().simple());
  let bundle_v1 = create_test_bundle_with_content(
    &slug,
    "1.0.0",
    "Manual Update",
    &yjs::markdown_to_yjs("Manual Update V1", "Keep until explicit action").unwrap(),
  );
  let (entry, revision_v1, _) = service
    .import_from_bundle(&bundle_v1, user_id)
    .await
    .expect("import v1");
  service.publish_revision(revision_v1.id).await.expect("publish v1");
  service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::ManualUpdate,
    )
    .await
    .expect("assign manual template");
  let first = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("materialize v1")
    .into_iter()
    .next()
    .expect("v1 instance");
  let doc_id = first.workspace_doc_id.expect("v1 document");

  let bundle_v2 = create_test_bundle_with_content(
    &slug,
    "2.0.0",
    "Manual Update",
    &yjs::markdown_to_yjs("Manual Update V2", "Do not apply automatically").unwrap(),
  );
  let (_, revision_v2, _) = service
    .import_from_bundle(&bundle_v2, user_id)
    .await
    .expect("import v2");
  service.publish_revision(revision_v2.id).await.expect("publish v2");

  let second = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("report manual update availability")
    .into_iter()
    .next()
    .expect("manual instance");
  assert_eq!(second.workspace_doc_id, Some(doc_id));
  assert_eq!(second.revision_id, revision_v1.id);
  assert_eq!(
    second.state,
    myoxus_domain::template_registry::InstanceState::UpdateAvailable
  );
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let live = documents
    .load_full_doc(workspace_id, doc_id)
    .await
    .expect("read manual source");
  let extracted = yjs::extract_text_from_yjs(&live).expect("extract manual source");
  assert_eq!(extracted.title.as_deref(), Some("Manual Update V1"));
  assert!(extracted.markdown.contains("Keep until explicit action"));
  assert!(!extracted.markdown.contains("Do not apply automatically"));

  let applied = service
    .apply_manual_update(workspace_id, entry.id, revision_v2.id)
    .await
    .expect("explicit manual update");
  assert_eq!(applied.revision_id, revision_v2.id);
  assert_eq!(applied.state, myoxus_domain::template_registry::InstanceState::Ok);
  let updated = documents
    .load_full_doc(workspace_id, doc_id)
    .await
    .expect("read explicitly updated source");
  let updated = yjs::extract_text_from_yjs(&updated).expect("extract explicitly updated source");
  assert_eq!(updated.title.as_deref(), Some("Manual Update V2"));
  assert!(updated.markdown.contains("Do not apply automatically"));

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_pinned_deprecated_revision_survives_published_successor() {
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage);
  let user_id = helpers::create_user(&pool, "tmpl-pinned-deprecated", true).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("tmpl-pinned-deprecated-{}", Uuid::new_v4().simple());
  let bundle_v1 = create_test_bundle_with_content(
    &slug,
    "1.0.0",
    "Pinned Revision",
    &yjs::markdown_to_yjs("Pinned V1", "Remain pinned to A").unwrap(),
  );
  let (entry, revision_v1, _) = service
    .import_from_bundle(&bundle_v1, user_id)
    .await
    .expect("import v1");
  service.publish_revision(revision_v1.id).await.expect("publish v1");
  service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::PinnedRevision,
      Some(revision_v1.id),
      myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .expect("pin revision A");

  let bundle_v2 = create_test_bundle_with_content(
    &slug,
    "2.0.0",
    "Pinned Revision",
    &yjs::markdown_to_yjs("Published V2", "Successor B").unwrap(),
  );
  let (_, revision_v2, _) = service
    .import_from_bundle(&bundle_v2, user_id)
    .await
    .expect("import v2");
  service.publish_revision(revision_v2.id).await.expect("publish v2");

  let pinned = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("reconcile pinned deprecated revision")
    .remove(0);
  assert_eq!(pinned.revision_id, revision_v1.id);
  let persisted_v1 = service
    .store()
    .get_revision(revision_v1.id)
    .await
    .expect("load pinned revision")
    .expect("pinned revision exists");
  assert_eq!(persisted_v1.state, RevisionState::Deprecated);

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_failed_explicit_manual_update_preserves_old_revision() {
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage.clone());
  let user_id = helpers::create_user(&pool, "tmpl-manual-update-failure", true).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("tmpl-manual-update-failure-{}", Uuid::new_v4().simple());
  let bundle_v1 = create_test_bundle_with_content(
    &slug,
    "1.0.0",
    "Manual Failure",
    &yjs::markdown_to_yjs("Manual Failure V1", "Preserve revision A").unwrap(),
  );
  let (entry, revision_v1, _) = service
    .import_from_bundle(&bundle_v1, user_id)
    .await
    .expect("import v1");
  service.publish_revision(revision_v1.id).await.expect("publish v1");
  service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::ManualUpdate,
    )
    .await
    .expect("assign manual update");
  let first = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("materialize v1")
    .remove(0);
  let doc_id = first.workspace_doc_id.expect("v1 source");
  let before = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
    .load_full_doc(workspace_id, doc_id)
    .await
    .expect("read v1 source");

  let bundle_v2 = create_test_bundle_with_content(
    &slug,
    "2.0.0",
    "Manual Failure",
    &yjs::markdown_to_yjs("Manual Failure V2", "Unavailable replacement").unwrap(),
  );
  let (_, revision_v2, _) = service
    .import_from_bundle(&bundle_v2, user_id)
    .await
    .expect("import v2");
  service.publish_revision(revision_v2.id).await.expect("publish v2");
  storage
    .delete_blob(revision_v2.bundle_blob_id.as_deref().expect("v2 bundle key"))
    .await
    .expect("remove v2 fixture");

  service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("report available update");
  assert!(
    service
      .apply_manual_update(workspace_id, entry.id, revision_v2.id)
      .await
      .is_err(),
    "failed explicit update must be reported"
  );
  let preserved = service
    .store()
    .list_instances_for_workspace(workspace_id)
    .await
    .expect("reload instance")
    .remove(0);
  assert_eq!(preserved.revision_id, revision_v1.id);
  assert_eq!(
    preserved.state,
    myoxus_domain::template_registry::InstanceState::UpdateAvailable
  );
  assert_eq!(preserved.last_error_code.as_deref(), Some("UPDATE_FAILED"));
  let after = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
    .load_full_doc(workspace_id, doc_id)
    .await
    .expect("reload v1 source");
  assert_eq!(after, before);

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_reconcile_preserves_source_when_live_drift_is_uncertain() {
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage);
  let user_id = helpers::create_user(&pool, "tmpl-reconcile-uncertain", true).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("tmpl-reconcile-uncertain-{}", Uuid::new_v4().simple());

  let bundle_v1 = create_test_bundle_with_content(
    &slug,
    "1.0.0",
    "Uncertain Reconcile",
    &yjs::markdown_to_yjs("Uncertain V1", "Preserve this content").unwrap(),
  );
  let (entry, revision_v1, _) = service
    .import_from_bundle(&bundle_v1, user_id)
    .await
    .expect("import v1 failed");
  service
    .publish_revision(revision_v1.id)
    .await
    .expect("publish v1 failed");
  service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .expect("assign failed");
  let first = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("first reconcile failed");
  let first_instance = first.first().expect("first instance");
  let doc_id = first_instance.workspace_doc_id.expect("materialized doc");
  let updates_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count source updates");

  sqlx::query("UPDATE workspace_template_instances SET last_applied_hash = NULL WHERE id = $1")
    .bind(first_instance.id)
    .execute(&pool)
    .await
    .expect("make drift evidence unavailable");
  let bundle_v2 = create_test_bundle_with_content(
    &slug,
    "2.0.0",
    "Uncertain Reconcile",
    &yjs::markdown_to_yjs("Uncertain V2", "Replacement content").unwrap(),
  );
  let (_, revision_v2, _) = service
    .import_from_bundle(&bundle_v2, user_id)
    .await
    .expect("import v2 failed");
  service
    .publish_revision(revision_v2.id)
    .await
    .expect("publish v2 failed");

  let second = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("uncertain reconcile must remain recoverable");
  let preserved = second.first().expect("preserved instance");
  assert_eq!(preserved.workspace_doc_id, Some(doc_id));
  assert_eq!(preserved.revision_id, revision_v1.id);
  assert_eq!(
    preserved.state,
    myoxus_domain::template_registry::InstanceState::UpdateAvailable
  );
  assert_eq!(preserved.last_error_code.as_deref(), Some("UPDATE_FAILED"));
  let updates_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("recount source updates");
  assert_eq!(
    updates_after, updates_before,
    "uncertain update must not touch source content"
  );

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_template_reconcile_failed_update_preserves_existing_source() {
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage.clone());
  let user_id = helpers::create_user(&pool, "tmpl-reconcile-failed-update", true).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("tmpl-reconcile-failed-update-{}", Uuid::new_v4().simple());

  let bundle_v1 = create_test_bundle_with_content(
    &slug,
    "1.0.0",
    "Failed Update",
    &yjs::markdown_to_yjs("Failed Update V1", "Preserve this content").unwrap(),
  );
  let (entry, revision_v1, _) = service
    .import_from_bundle(&bundle_v1, user_id)
    .await
    .expect("import v1");
  service.publish_revision(revision_v1.id).await.expect("publish v1");
  service
    .assign_template_to_workspace(
      workspace_id,
      entry.id,
      myoxus_domain::template_registry::SelectionMode::Published,
      None,
      myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .expect("assign template");
  let first = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("materialize v1")
    .into_iter()
    .next()
    .expect("v1 instance");
  let doc_id = first.workspace_doc_id.expect("v1 document");
  let updates_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count v1 updates");

  let bundle_v2 = create_test_bundle_with_content(
    &slug,
    "2.0.0",
    "Failed Update",
    &yjs::markdown_to_yjs("Failed Update V2", "Replacement content").unwrap(),
  );
  let (_, revision_v2, _) = service
    .import_from_bundle(&bundle_v2, user_id)
    .await
    .expect("import v2");
  service.publish_revision(revision_v2.id).await.expect("publish v2");
  storage
    .delete_blob(revision_v2.bundle_blob_id.as_deref().expect("v2 bundle storage key"))
    .await
    .expect("remove v2 bundle fixture");

  let second = service
    .reconcile_workspace_templates(workspace_id)
    .await
    .expect("failed update remains a recoverable reconcile result")
    .into_iter()
    .next()
    .expect("preserved instance");
  assert_eq!(second.workspace_doc_id, Some(doc_id));
  assert_eq!(second.revision_id, revision_v1.id);
  assert_eq!(second.state, myoxus_domain::template_registry::InstanceState::Error);
  assert_eq!(second.last_error_code.as_deref(), Some("UPDATE_FAILED"));
  let updates_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("recount v1 updates");
  assert_eq!(
    updates_after, updates_before,
    "failed update must leave live content untouched"
  );

  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_report_template_builder_applied_denies_reader() {
  let (app, pool, auth_store) = setup_graphql_template_registry_app().await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "template-report-owner").await;
  let (reader_id, reader_session) = helpers::seed_user(&pool, &auth_store, "template-report-reader").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  helpers::add_workspace_member(&pool, workspace_id, reader_id).await;
  sqlx::query("UPDATE workspace_memberships SET role = 'Reader' WHERE workspace_id = $1 AND user_id = $2")
    .bind(workspace_id)
    .bind(reader_id)
    .execute(&pool)
    .await
    .expect("restrict member to reader");

  let response = graphql_json(
    &app,
    reader_session,
    json!({
      "query": "mutation Report($input: ReportBuilderAppliedInput!) { reportTemplateBuilderApplied(input: $input) }",
      "variables": {
        "input": {
          "workspaceId": workspace_id.to_string(),
          "slug": "daily-notes",
          "appliedHash": "stale-or-untrusted",
          "locale": "en",
          "docId": Uuid::new_v4().to_string()
        }
      }
    }),
  )
  .await;

  assert_eq!(response["errors"][0]["extensions"]["name"], "ACTION_FORBIDDEN");
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_template_instances WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("count rejected bindings");
  assert_eq!(count, 0, "reader report must not mutate Registry state");

  helpers::cleanup_users(&pool, &[owner_id, reader_id]).await;
}

#[tokio::test]
async fn inv_multilingual_focus_preserves_recorded_source_locale_and_full_revision_identity() {
  use futures_util::FutureExt;
  use myoxus_application::template_registry::bundle;
  let (app, pool, auth_store, storage) = setup_template_registry_export_app().await;
  let user_id = helpers::create_user(&pool, "tmpl-multilingual-focus", true).await;
  let session_id = helpers::create_session(&auth_store, user_id).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let slug = format!("test-focus-locales-{}", Uuid::new_v4().simple());
  let filename = format!("{slug}.zip");
  let outcome = std::panic::AssertUnwindSafe(async {
    let service = build_materializing_service(&pool, storage.clone());
    let canonical: String = sqlx::query_scalar("SELECT key FROM language_definition WHERE id = document_metadata_default_language_id()")
      .fetch_one(&pool).await.unwrap();
    assert_eq!(service.store().resolve_bundle_source_language(None).await.unwrap(), canonical);
    let asset = include_bytes!("../../../../templates/documents/meeting-focus/1.1.1.zip");
    let mut parsed = bundle::parse_bundle(asset).unwrap();
    parsed.manifest.template_id = slug.clone();
    let bytes = bundle::create_export_bundle(&parsed.manifest, &parsed.content_bytes, None, &parsed.localized_contents).unwrap();
    let (entry, revision) = service.register_shipped_bundle(&bytes, &filename).await.unwrap();
    assert_eq!(revision.manifest.as_ref().unwrap()["localized_contents"]["fr"]["title"], "Fokus · Compte rendu de réunion");
    let projection = graphql_json(&app, session_id, json!({
      "query": "query($id: ID!) { admin { templateRevisions(templateId: $id) { version manifest } } }",
      "variables": {"id": entry.id.to_string()}
    })).await;
    assert!(projection.get("errors").is_none(), "{projection}");
    assert_eq!(projection["data"]["admin"]["templateRevisions"][0]["manifest"], serde_json::to_value(&parsed.manifest).unwrap());
    let response = app.clone().oneshot(Request::builder()
      .uri(format!("/api/admin/templates/export/{}", revision.id))
      .header("cookie", format!("affine_session={session_id}"))
      .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let exported = response.into_body().collect().await.unwrap().to_bytes();
    let exported = bundle::parse_bundle(&exported).unwrap();
    assert_eq!(exported.localized_contents, parsed.localized_contents);
    assert_eq!(serde_json::to_value(exported.manifest).unwrap(), serde_json::to_value(&parsed.manifest).unwrap());
    service.assign_template_to_workspace(workspace_id, entry.id,
      myoxus_domain::template_registry::SelectionMode::Published, None,
      myoxus_domain::template_registry::ProvisioningMode::ManagedUntilLocalEdit).await.unwrap();
    // A recorded choice is persisted before source creation, as for a resumed
    // provisioner. Reconciliation must use it rather than the default payload.
    sqlx::query("INSERT INTO workspace_template_instances (id, workspace_id, template_id, revision_id, state, locale_hash) VALUES ($1,$2,$3,$4,'ok','fr')")
      .bind(Uuid::new_v4()).bind(workspace_id).bind(entry.id).bind(revision.id).execute(&pool).await.unwrap();
    let instances = service.reconcile_workspace_templates(workspace_id).await.unwrap();
    let first = &instances[0];
    assert_eq!(first.locale_hash.as_deref(), Some("fr"));
    let doc_id = first.workspace_doc_id.expect("French source materialized");
    let language: String = sqlx::query_scalar("SELECT l.key FROM docs d JOIN language_definition l ON l.id = d.language_id WHERE d.id = $1")
      .bind(doc_id).fetch_one(&pool).await.unwrap();
    assert_eq!(language, "fr");
    let document = DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))).load_full_doc(workspace_id, doc_id).await.unwrap();
    assert_eq!(yjs::extract_structural_document_title(&document).unwrap().as_deref(), Some("Fokus · Compte rendu de réunion"));
    assert_eq!(first.last_applied_hash.as_deref(), Some(sha256_hex(&document).as_str()));
    // Correct SHA-256 is insufficient: even an unselected native alternative
    // must decode before import may write or accept an existing revision.
    let mut invalid_locales = parsed.localized_contents.clone();
    invalid_locales.insert("es".into(), b"not a native document".to_vec());
    let mut invalid_manifest = parsed.manifest.clone();
    invalid_manifest.localized_contents.get_mut("es").unwrap().sha256 = sha256_hex(&invalid_locales["es"]);
    let invalid = bundle::create_export_bundle(&invalid_manifest, &parsed.content_bytes, None, &invalid_locales).unwrap();
    let error = service.import_shipped_bundle(&invalid, &filename).await.err().expect("invalid unselected native payload rejected");
    assert!(error.to_string().contains("INVALID_TEMPLATE_CONTENT"), "{error}");
    assert_eq!(service.store().list_revisions(entry.id, 0, 100).await.unwrap().len(), 1);
    // Only another locale changes: the default checksum remains identical.
    let mut mutated = parsed.localized_contents.clone();
    mutated.insert("es".into(), parsed.localized_contents["en"].clone());
    let mut changed_manifest = parsed.manifest.clone();
    changed_manifest.localized_contents.get_mut("es").unwrap().sha256 = format!("{:x}", Sha256::digest(&mutated["es"]));
    let changed = bundle::create_export_bundle(&changed_manifest, &parsed.content_bytes, None, &mutated).unwrap();
    assert_eq!(bundle::parse_bundle(&changed).unwrap().content_checksum, parsed.content_checksum);
    let error = service.register_shipped_bundle(&changed, &filename).await.err().expect("immutable variant rejected");
    assert!(error.to_string().contains("different content"));
    assert_eq!(service.store().get_revision(revision.id).await.unwrap().unwrap().manifest, revision.manifest);
    let changed_preview = bundle::create_export_bundle(&parsed.manifest, &parsed.content_bytes,
      Some(br#"<svg xmlns="http://www.w3.org/2000/svg"><text>Different preview</text></svg>"#),
      &parsed.localized_contents).unwrap();
    let error = service.register_shipped_bundle(&changed_preview, &filename).await.err().expect("immutable preview rejected");
    assert!(error.to_string().contains("different content"));
    // The next revision changes its default to Spanish, while retaining French.
    let mut next_manifest = parsed.manifest.clone();
    next_manifest.version = "1.2.0".into();
    next_manifest.locale = Some("es".into());
    let spanish = parsed.localized_contents["es"].clone();
    next_manifest.checksum = Some(format!("{:x}", Sha256::digest(&spanish)));
    let mut next_locales = parsed.localized_contents.clone();
    next_locales.remove("es");
    next_manifest.localized_contents.remove("es");
    next_locales.insert("de".into(), parsed.content_bytes.clone());
    next_manifest.localized_contents.insert("de".into(), bundle::LocalizedContent {
      path: "localized/de.template.zip".into(), sha256: parsed.content_checksum.clone(),
      title: parsed.manifest.title.clone(), description: parsed.manifest.description.clone(),
    });
    let next = bundle::create_export_bundle(&next_manifest, &spanish, None, &next_locales).unwrap();
    let (_, next_revision) = service.register_shipped_bundle(&next, &filename).await.unwrap();
    drop(service);
    let restarted = build_materializing_service(&pool, storage.clone());
    let instances = restarted.reconcile_workspace_templates(workspace_id).await.unwrap();
    let after = &instances[0];
    assert_eq!(after.workspace_doc_id, Some(doc_id));
    assert_eq!(after.revision_id, next_revision.id);
    assert_eq!(after.locale_hash.as_deref(), Some("fr"));
    let document = DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))).load_full_doc(workspace_id, doc_id).await.unwrap();
    assert_eq!(yjs::extract_structural_document_title(&document).unwrap().as_deref(), Some("Fokus · Compte rendu de réunion"));
    assert_eq!(after.last_applied_hash.as_deref(), Some(sha256_hex(&document).as_str()));
    assert_eq!(after.current_hash, after.last_applied_hash);
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM template_revisions WHERE template_id = $1")
      .bind(entry.id).fetch_one(&pool).await.unwrap();
    assert_eq!(rows, 2);
  }).catch_unwind().await;
  // Include failed imports, whose result_revision_id is absent. The exact
  // unique filename identifies only this test's jobs and their startup audits.
  let jobs: Vec<Uuid> = sqlx::query_scalar("SELECT DISTINCT import_job_id FROM template_registry_audit_events WHERE payload_json->>'filename' = $1 AND import_job_id IS NOT NULL")
    .bind(&filename).fetch_all(&pool).await.expect("resolve owned import jobs");
  sqlx::query("DELETE FROM template_registry_audit_events WHERE import_job_id = ANY($1)")
    .bind(&jobs)
    .execute(&pool)
    .await
    .expect("delete owned import audits");
  sqlx::query("DELETE FROM template_import_jobs WHERE id = ANY($1)")
    .bind(&jobs)
    .execute(&pool)
    .await
    .expect("delete owned import jobs");
  cleanup_template(&pool, &slug).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[derive(Default)]
struct RecordingTemplateQueue(Mutex<Vec<(String, String, Value)>>);
#[async_trait::async_trait]
impl myoxus_application::worker::WorkQueuePort for RecordingTemplateQueue {
  async fn add_job(
    &self,
    queue: &str,
    name: &str,
    data: Value,
    _attempts: Option<u32>,
    _delay: Option<i64>,
  ) -> myoxus_application::auth::AuthResult<String> {
    self.0.lock().unwrap().push((queue.into(), name.into(), data));
    Ok(Uuid::new_v4().to_string())
  }
}

#[sqlx::test(migrations = false)]
async fn inv_configured_guides_seed_once_and_preserve_reader_copies(pool: PgPool) {
  use myoxus_domain::template_registry::{InstanceState, ProvisioningMode, SelectionMode};
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("isolated guide database migrations");
  let assets = guide_bundle_fixtures(true);
  let storage = Arc::new(TestBlobStorage::default());
  let user_id = helpers::create_user(&pool, "configured-guide-owner", true).await;
  let search_queue = Arc::new(RecordingTemplateQueue::default());
  let restarted = build_materializing_service(&pool, storage.clone())
    .with_asset_materialization(Arc::new(BlobService::new(
      Arc::new(SqlxBlobStore::new(pool.clone())),
      storage.clone(),
      "test-key".into(),
    )))
    .with_reconcile_queue(search_queue.clone())
    .unwrap();
  let mut registered = Vec::new();
  for bytes in &assets {
    let (entry, revision) = restarted.register_shipped_bundle(bytes, "guide.zip").await.unwrap();
    // A preserved policy is valid too; the return value only reports insertion.
    restarted.ensure_shipped_default_policy(&entry.slug).await.unwrap();
    registered.push((entry, revision));
  }

  sqlx::query("UPDATE app_configs SET value = '\"fr\"'::jsonb WHERE id = 'i18n.default_locale'")
    .execute(&pool)
    .await
    .unwrap();
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  for (entry, _) in &registered {
    let policy = restarted
      .assign_template_to_workspace(
        workspace_id,
        entry.id,
        SelectionMode::Published,
        None,
        ProvisioningMode::ManagedUntilLocalEdit,
      )
      .await
      .unwrap();
    assert_eq!(policy.provisioning_mode, ProvisioningMode::SeedOnce);
  }
  let first = restarted.reconcile_workspace_templates(workspace_id).await.unwrap();
  assert_eq!(first.len(), registered.len());
  let indexed_documents = search_queue
    .0
    .lock()
    .unwrap()
    .iter()
    .filter(|(queue, name, _)| queue == "indexer" && name == "indexer.indexDoc")
    .map(|(_, _, data)| {
      assert_eq!(data["kind"], "deferred");
      assert_eq!(data["workspaceId"], workspace_id.to_string());
      data["docId"].as_str().unwrap().parse::<Uuid>().unwrap()
    })
    .collect::<std::collections::HashSet<_>>();
  assert_eq!(
    indexed_documents,
    first
      .iter()
      .map(|instance| instance.workspace_doc_id.unwrap())
      .collect(),
    "server-created ordinary guides must become searchable without a reader edit"
  );
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  for instance in &first {
    assert_eq!(instance.state, InstanceState::Ok);
    assert_eq!(instance.locale_hash.as_deref(), Some("fr"));
    let doc_id = instance.workspace_doc_id.unwrap();
    let language: String =
      sqlx::query_scalar("SELECT l.key FROM docs d JOIN language_definition l ON l.id = d.language_id WHERE d.id = $1")
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(language, "fr");
    let native = documents.load_full_doc(workspace_id, doc_id).await.unwrap();
    assert_eq!(
      instance.last_applied_hash.as_deref(),
      Some(format!("{:x}", Sha256::digest(&native)).as_str())
    );
    let revision = restarted
      .store()
      .get_revision(instance.revision_id)
      .await
      .unwrap()
      .unwrap();
    assert_eq!(
      yjs::extract_structural_document_title(&native).unwrap().unwrap(),
      revision.manifest.unwrap()["localized_contents"]["fr"]["title"]
        .as_str()
        .unwrap()
    );
  }
  let template_states: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM document_template_state t JOIN docs d ON d.id = t.doc_id WHERE d.workspace_id = $1",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!(
    template_states, 0,
    "guide delivery must not create reusable template attribution"
  );
  sqlx::query("UPDATE app_configs SET value = '\"en\"'::jsonb WHERE id = 'i18n.default_locale'")
    .execute(&pool)
    .await
    .unwrap();
  let edited = &first[0];
  let old_doc_id = edited.workspace_doc_id.unwrap();
  let before = documents.load_full_doc(workspace_id, old_doc_id).await.unwrap();
  let edit = yjs::update_document_title(&before, "Reader-owned learning notes").unwrap();
  documents
    .push_update_raw(workspace_id, old_doc_id, edit, DocSpaceKind::Workspace)
    .await
    .unwrap();
  let reader_content = documents.load_full_doc(workspace_id, old_doc_id).await.unwrap();
  assert!(restarted.scan_drift(workspace_id).await.unwrap().is_empty());
  let again = restarted.reconcile_workspace_templates(workspace_id).await.unwrap();
  assert_eq!(
    again
      .iter()
      .map(|instance| instance.workspace_doc_id)
      .collect::<std::collections::HashSet<_>>(),
    first.iter().map(|instance| instance.workspace_doc_id).collect()
  );
  assert_eq!(
    documents.load_full_doc(workspace_id, old_doc_id).await.unwrap(),
    reader_content
  );

  let removed_guide = &first[1];
  documents
    .delete_doc(workspace_id, removed_guide.workspace_doc_id.unwrap())
    .await
    .unwrap();
  let after_delete = restarted.reconcile_workspace_templates(workspace_id).await.unwrap();
  assert_eq!(
    after_delete
      .iter()
      .find(|instance| instance.id == removed_guide.id)
      .unwrap()
      .state,
    InstanceState::Retired
  );
  assert!(
    documents
      .store()
      .get_doc_metadata(removed_guide.workspace_doc_id.unwrap())
      .await
      .unwrap()
      .is_none()
  );
  // A failed guide attachment must compensate only the newly created copy.
  let before_failed_copy: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  sqlx::raw_sql("CREATE FUNCTION myoxus_qa_reject_guide_rebind() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_doc_id IS DISTINCT FROM OLD.workspace_doc_id THEN RAISE EXCEPTION 'injected guide attachment failure' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$; CREATE TRIGGER myoxus_qa_guide_rebind BEFORE UPDATE OF workspace_doc_id ON workspace_template_instances FOR EACH ROW EXECUTE FUNCTION myoxus_qa_reject_guide_rebind();")
    .execute(&pool).await.unwrap();
  let failed_copy = restarted
    .apply_manual_update(workspace_id, edited.template_id, edited.revision_id)
    .await
    .err()
    .unwrap();
  assert!(failed_copy.to_string().contains("injected guide attachment failure"));
  sqlx::raw_sql("DROP TRIGGER myoxus_qa_guide_rebind ON workspace_template_instances; DROP FUNCTION myoxus_qa_reject_guide_rebind();")
    .execute(&pool).await.unwrap();
  let after_failed_copy: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    before_failed_copy, after_failed_copy,
    "failed installation must leave no orphan ordinary copy"
  );
  assert_eq!(
    documents.load_full_doc(workspace_id, old_doc_id).await.unwrap(),
    reader_content
  );
  assert_eq!(
    restarted
      .store()
      .get_instance(edited.id)
      .await
      .unwrap()
      .unwrap()
      .workspace_doc_id,
    Some(old_doc_id)
  );
  let new_copy = restarted
    .apply_manual_update(workspace_id, edited.template_id, edited.revision_id)
    .await
    .unwrap();
  assert_eq!(new_copy.id, edited.id);
  assert_ne!(new_copy.workspace_doc_id, edited.workspace_doc_id);
  assert_eq!(
    new_copy.locale_hash.as_deref(),
    Some("en"),
    "an explicit new copy uses the fresh document language"
  );
  assert_eq!(
    documents.load_full_doc(workspace_id, old_doc_id).await.unwrap(),
    reader_content
  );
  let deliberate_reinstall = restarted
    .apply_manual_update(workspace_id, removed_guide.template_id, removed_guide.revision_id)
    .await
    .unwrap();
  assert_ne!(deliberate_reinstall.workspace_doc_id, removed_guide.workspace_doc_id);
  assert_eq!(deliberate_reinstall.state, InstanceState::Ok);
  assert_eq!(deliberate_reinstall.locale_hash.as_deref(), Some("en"));
  let soft_deleted_guide = &first[2];
  sqlx::query("UPDATE workspace_template_policies SET provisioning_mode = 'managed_until_local_edit' WHERE workspace_id = $1 AND template_id = $2")
    .bind(workspace_id).bind(soft_deleted_guide.template_id).execute(&pool).await.unwrap();
  assert!(
    !restarted
      .is_managed_source(workspace_id, soft_deleted_guide.workspace_doc_id.unwrap())
      .await
      .unwrap(),
    "ordinary guides retain trash/delete permissions even with a historical managed policy"
  );
  let count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  documents
    .soft_delete_doc(soft_deleted_guide.workspace_doc_id.unwrap())
    .await
    .unwrap();
  let after_trash = restarted.reconcile_workspace_templates(workspace_id).await.unwrap();
  assert_eq!(
    after_trash
      .iter()
      .find(|instance| instance.id == soft_deleted_guide.id)
      .unwrap()
      .state,
    InstanceState::Retired
  );
  let count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    count_before, count_after,
    "automatic delivery must not recreate a soft-deleted guide"
  );
  let policy = restarted
    .store()
    .list_policies_for_workspace(workspace_id)
    .await
    .unwrap()
    .into_iter()
    .find(|policy| policy.template_id == edited.template_id)
    .unwrap();
  let retained_new_copy = documents
    .load_full_doc(workspace_id, new_copy.workspace_doc_id.unwrap())
    .await
    .unwrap();
  restarted
    .retire_template_assignment_with_actor(policy.id, Some(user_id))
    .await
    .unwrap();
  assert_eq!(
    documents
      .load_full_doc(workspace_id, new_copy.workspace_doc_id.unwrap())
      .await
      .unwrap(),
    retained_new_copy,
    "central guide retirement must retain the reader's document"
  );
  assert_eq!(
    documents.load_full_doc(workspace_id, old_doc_id).await.unwrap(),
    reader_content
  );
  restarted
    .assign_template_to_workspace(
      workspace_id,
      edited.template_id,
      SelectionMode::Published,
      None,
      ProvisioningMode::SeedOnce,
    )
    .await
    .unwrap();
  let reinstalled = restarted.reconcile_workspace_templates(workspace_id).await.unwrap();
  let fresh = reinstalled
    .iter()
    .find(|instance| instance.template_id == edited.template_id)
    .unwrap();
  assert_ne!(fresh.workspace_doc_id, new_copy.workspace_doc_id);
  assert_eq!(
    documents
      .load_full_doc(workspace_id, new_copy.workspace_doc_id.unwrap())
      .await
      .unwrap(),
    retained_new_copy
  );
  let final_states: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM document_template_state t JOIN docs d ON d.id = t.doc_id WHERE d.workspace_id = $1",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!(final_states, 0);
}

#[sqlx::test(migrations = false)]
async fn inv_meeting_notes_retirement_preserves_choices_custom_sources_and_working_documents(pool: PgPool) {
  use myoxus_application::template_registry::bundle::{self, TemplatePurpose};
  use myoxus_domain::template_registry::{InstanceState, ProvisioningMode, SelectionMode};
  myoxus_infrastructure::migrations::run(&pool).await.unwrap();
  let asset = include_bytes!("../../../../templates/documents/meeting-notes/1.0.0.zip");
  let parsed = bundle::parse_bundle(asset).unwrap();
  let registry = build_materializing_service(&pool, Arc::new(TestBlobStorage::default()));
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let user = helpers::create_user(&pool, "retired-meeting-owner", true).await;
  let original = registry
    .store()
    .get_catalog_entry_by_slug("meeting-notes")
    .await
    .unwrap()
    .unwrap();
  let (focus, _) = registry
    .register_shipped_bundle(
      include_bytes!("../../../../templates/documents/meeting-focus/1.1.1.zip"),
      "focus.zip",
    )
    .await
    .unwrap();
  let mut sources = Vec::new();
  for index in 0..5 {
    let workspace = helpers::create_workspace(&pool, user).await;
    helpers::create_workspace_root_doc(&pool, workspace, user).await;
    let mode = if index == 3 {
      ProvisioningMode::SeedOnce
    } else {
      ProvisioningMode::ManagedUntilLocalEdit
    };
    let policy = registry
      .assign_template_to_workspace(workspace, original.id, SelectionMode::Published, None, mode)
      .await
      .unwrap();
    let (source, _) = documents
      .create_page_from_snapshot_with_sync_updates(
        workspace,
        user,
        Some(if index == 1 {
          "Edited source".into()
        } else {
          parsed.manifest.title.clone()
        }),
        parsed.content_bytes.clone(),
      )
      .await
      .unwrap();
    registry
      .store()
      .attribute_materialized_document(source.id, user, "de", TemplatePurpose::Template)
      .await
      .unwrap();
    registry
      .store()
      .upsert_builtin_instance_applied(
        workspace,
        "meeting-notes",
        &compute_builtin_expected_hash("meeting-notes", original.builder_version.unwrap(), "de"),
        "de",
        Some(&source.id.to_string()),
      )
      .await
      .unwrap();
    if index == 2 {
      sqlx::query("UPDATE workspace_template_policies SET is_enabled=false WHERE id=$1")
        .bind(policy.id)
        .execute(&pool)
        .await
        .unwrap();
    }
    if index == 4 {
      let replacement = registry
        .assign_template_to_workspace(
          workspace,
          focus.id,
          SelectionMode::Published,
          None,
          ProvisioningMode::SeedOnce,
        )
        .await
        .unwrap();
      sqlx::query("UPDATE workspace_template_policies SET is_enabled=false WHERE id=$1")
        .bind(replacement.id)
        .execute(&pool)
        .await
        .unwrap();
    }
    let before = documents.load_full_doc_consistent(workspace, source.id).await.unwrap();
    let (working, _) = documents
      .create_page_from_snapshot_with_sync_updates(
        workspace,
        user,
        Some("Independent meeting".into()),
        parsed.content_bytes.clone(),
      )
      .await
      .unwrap();
    let working_before = documents.load_full_doc_consistent(workspace, working.id).await.unwrap();
    sources.push((workspace, source.id, policy, before, working.id, working_before));
  }
  let (_, baseline) = registry
    .register_shipped_bundle(asset, "meeting-notes.zip")
    .await
    .unwrap();
  // A real pin and an edit saved after cutover are not automatic replacements.
  for pin in [true, false] {
    let workspace = helpers::create_workspace(&pool, user).await;
    helpers::create_workspace_root_doc(&pool, workspace, user).await;
    let policy = registry
      .assign_template_to_workspace(
        workspace,
        original.id,
        if pin {
          SelectionMode::PinnedRevision
        } else {
          SelectionMode::Published
        },
        pin.then_some(baseline.id),
        ProvisioningMode::ManagedUntilLocalEdit,
      )
      .await
      .unwrap();
    let source = registry
      .reconcile_workspace_templates(workspace)
      .await
      .unwrap()
      .into_iter()
      .find(|instance| instance.template_id == original.id)
      .unwrap()
      .workspace_doc_id
      .unwrap();
    if !pin {
      let current = documents.load_full_doc_consistent(workspace, source).await.unwrap();
      let update = yjs::restore_document_snapshot(
        &current,
        &yjs::markdown_to_yjs(
          "Freshly edited source",
          "Do not wait for a drift scan to protect this edit",
        )
        .unwrap(),
      )
      .unwrap();
      documents
        .push_update_raw(workspace, source, update, DocSpaceKind::Workspace)
        .await
        .unwrap();
      assert_eq!(
        registry
          .store()
          .find_instance(workspace, original.id)
          .await
          .unwrap()
          .unwrap()
          .state,
        InstanceState::Ok
      );
    }
    let before = documents.load_full_doc_consistent(workspace, source).await.unwrap();
    let (working, _) = documents
      .create_page_from_snapshot_with_sync_updates(
        workspace,
        user,
        Some("Independent meeting".into()),
        parsed.content_bytes.clone(),
      )
      .await
      .unwrap();
    let working_before = documents.load_full_doc_consistent(workspace, working.id).await.unwrap();
    sources.push((workspace, source, policy, before, working.id, working_before));
  }
  registry.retire_shipped_meeting_notes(asset).await.unwrap();
  let archived = registry.store().get_catalog_entry(original.id).await.unwrap().unwrap();
  assert_eq!(archived.status, TemplateStatus::Archived);
  for (index, (workspace, source, policy, before, working, working_before)) in sources.iter().enumerate() {
    assert_eq!(
      &documents.load_full_doc_consistent(*workspace, *working).await.unwrap(),
      working_before
    );
    let instance = registry
      .store()
      .find_instance(*workspace, original.id)
      .await
      .unwrap()
      .unwrap();
    if index == 0 {
      assert!(documents.get_metadata(*source).await.unwrap().is_none());
      assert_eq!(instance.state, InstanceState::Retired);
      assert!(registry.store().get_policy(policy.id).await.unwrap().is_none());
      let mappings = registry.page_default_replacements(*workspace).await.unwrap();
      assert_eq!(mappings.len(), 1);
      assert_eq!(mappings[0].retired_source_doc_id, source.to_string());
      let replacement = registry
        .store()
        .find_instance(*workspace, focus.id)
        .await
        .unwrap()
        .unwrap();
      assert_eq!(
        mappings[0].replacement_source_doc_id.clone(),
        replacement.workspace_doc_key
      );
    } else {
      assert_eq!(
        &documents.load_full_doc_consistent(*workspace, *source).await.unwrap(),
        before
      );
      assert_eq!(instance.state, InstanceState::Detached);
      let attribution: (String, Option<Uuid>, Option<Uuid>) =
        sqlx::query_as("SELECT state,template_id,instance_id FROM document_template_state WHERE doc_id=$1")
          .bind(source)
          .fetch_one(&pool)
          .await
          .unwrap();
      assert_eq!(attribution, ("seeded".into(), None, None));
      let retained = registry.store().get_policy(policy.id).await.unwrap().unwrap();
      assert!(!retained.is_enabled);
      assert_eq!(retained.selection_mode, policy.selection_mode);
      assert_eq!(retained.provisioning_mode, policy.provisioning_mode);
      assert!(registry.page_default_replacements(*workspace).await.unwrap().is_empty());
    }
    assert!(instance.workspace_doc_id.is_none());
    assert!(instance.workspace_doc_key.is_none());
  }
  let revisions = registry.store().list_revisions(original.id, 0, 100).await.unwrap();
  registry.retire_shipped_meeting_notes(asset).await.unwrap();
  assert_eq!(
    registry
      .store()
      .list_revisions(original.id, 0, 100)
      .await
      .unwrap()
      .len(),
    revisions.len()
  );
  for (workspace, source, _, before, working, working_before) in sources.iter().skip(1) {
    registry.reconcile_workspace_templates(*workspace).await.unwrap();
    assert_eq!(
      &documents.load_full_doc_consistent(*workspace, *source).await.unwrap(),
      before
    );
    assert_eq!(
      &documents.load_full_doc_consistent(*workspace, *working).await.unwrap(),
      working_before
    );
    let focus_policy = registry
      .store()
      .list_policies_for_workspace(*workspace)
      .await
      .unwrap()
      .into_iter()
      .find(|p| p.template_id == focus.id);
    assert!(focus_policy.is_none_or(|p| !p.is_enabled));
  }
}

#[sqlx::test(migrations = false)]
async fn inv_meeting_notes_replacement_fences_an_edit_during_focus_delivery(pool: PgPool) {
  use myoxus_application::template_registry::TemplateDefaultReplacementRequest;
  use myoxus_domain::template_registry::{InstanceState, ProvisioningMode, SelectionMode};
  myoxus_infrastructure::migrations::run(&pool).await.unwrap();
  let storage = Arc::new(TestBlobStorage::default());
  let registry = build_materializing_service(&pool, storage.clone());
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let user = helpers::create_user(&pool, "retirement-delivery-race", true).await;
  let workspace = helpers::create_workspace(&pool, user).await;
  helpers::create_workspace_root_doc(&pool, workspace, user).await;
  let baseline = include_bytes!("../../../../templates/documents/meeting-notes/1.0.0.zip");
  let (source_entry, _) = registry.register_shipped_bundle(baseline, "notes.zip").await.unwrap();
  let (_, focus_revision) = registry
    .register_shipped_bundle(
      include_bytes!("../../../../templates/documents/meeting-focus/1.1.1.zip"),
      "focus.zip",
    )
    .await
    .unwrap();
  registry
    .assign_template_to_workspace(
      workspace,
      source_entry.id,
      SelectionMode::Published,
      None,
      ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .unwrap();
  let source = registry
    .reconcile_workspace_templates(workspace)
    .await
    .unwrap()
    .into_iter()
    .find(|instance| instance.template_id == source_entry.id)
    .unwrap()
    .workspace_doc_id
    .unwrap();
  *storage.next_read_edit_key.lock().unwrap() = focus_revision.bundle_blob_id.clone();
  storage.edit_document_on_next_read(ReadEdit {
    documents: documents.clone(),
    workspace_id: workspace,
    doc_id: source,
    replacement: yjs::markdown_to_yjs(
      "Saved during replacement",
      "This edit must survive automatic retirement",
    )
    .unwrap(),
  });
  assert!(
    registry
      .replace_default_assignments(TemplateDefaultReplacementRequest {
        source_slug: "meeting-notes",
        replacement_slug: "meeting-focus",
        after_policy_id: None,
        limit: 1,
        apply: true,
      })
      .await
      .is_err()
  );
  assert!(
    storage.next_read_edit.lock().unwrap().is_none(),
    "the actual Fokus delivery must trigger the intervening write"
  );
  let retained = documents.load_full_doc_consistent(workspace, source).await.unwrap();
  assert!(
    yjs::extract_text_from_yjs(&retained)
      .unwrap()
      .markdown
      .contains("This edit must survive automatic retirement")
  );
  assert!(documents.get_metadata(source).await.unwrap().is_some());
  let root = documents.load_full_doc_consistent(workspace, workspace).await.unwrap();
  assert!(
    yjs::extract_workspace_root_metadata(&root)
      .unwrap()
      .pages
      .iter()
      .any(|page| page.id == source.to_string())
  );
  assert!(
    registry.page_default_replacements(workspace).await.unwrap().is_empty(),
    "a failed delete must not remap the edited source preference"
  );
  registry.retire_shipped_meeting_notes(baseline).await.unwrap();
  assert_eq!(
    documents.load_full_doc_consistent(workspace, source).await.unwrap(),
    retained
  );
  let instance = registry
    .store()
    .find_instance(workspace, source_entry.id)
    .await
    .unwrap()
    .unwrap();
  assert_eq!(instance.state, InstanceState::Detached);
  assert!(instance.workspace_doc_id.is_none());
  assert!(registry.page_default_replacements(workspace).await.unwrap().is_empty());
}

#[sqlx::test(migrations = false)]
async fn inv_feature_release_delivery_reuses_registry_jobs_and_retires_omitted_exports(pool: PgPool) {
  use myoxus_application::feature_bundle::register_feature_document_sources;
  use myoxus_domain::template_registry::{ProvisioningMode, SelectionMode};
  myoxus_infrastructure::migrations::run(&pool).await.unwrap();
  let root = tempfile::tempdir().unwrap();
  let capture = |version: &str, sources: &[(&str, &str, &[u8], Option<bool>)]| {
    let mut components = Vec::new();
    let mut exports = Vec::new();
    for (slug, native_version, bytes, default) in sources {
      let component = format!("document.{slug}.{native_version}");
      let path = format!("documents/{slug}/{native_version}.zip");
      std::fs::create_dir_all(root.path().join(&path).parent().unwrap()).unwrap();
      std::fs::write(root.path().join(&path), bytes).unwrap();
      components.push(json!({"id":component,"kind":"documentTemplate","path":path}));
      if let Some(default) = default {
        exports.push(json!({"id":format!("document.{slug}"),"source":{"component":component,
          "export":format!("{slug}@{native_version}")},"document":{"newWorkspaceDefault":default}}));
      }
    }
    let source: myoxus_domain::feature_bundle::FeatureBundleSource = serde_json::from_value(json!({
      "formatVersion":1,"id":"myoxus.features.delivery-test","version":version,
      "capabilities":{"documentTemplate":1},"components":components,"links":[],"exports":exports,
    }))
    .unwrap();
    std::fs::write(
      root.path().join("manifest.yaml"),
      myoxus_contracts::config_document::encode_config_yaml(&source).unwrap(),
    )
    .unwrap();
    myoxus_infrastructure::feature_bundles::capture_feature_source(root.path(), "manifest.yaml").unwrap()
  };
  let asset = |slug, version, title| {
    use myoxus_application::template_registry::bundle::{self, TemplatePurpose, TitlePolicy};
    let bytes = create_test_bundle_with_content(
      slug,
      version,
      title,
      &yjs::markdown_to_yjs(title, &format!("Actual native body: {title}")).unwrap(),
    );
    let mut parsed = bundle::parse_bundle(&bytes).unwrap();
    parsed.manifest.purpose = Some(TemplatePurpose::Template);
    parsed.manifest.title_policy = Some(TitlePolicy::Template);
    bundle::create_export_bundle(
      &parsed.manifest,
      &parsed.content_bytes,
      None,
      &parsed.localized_contents,
    )
    .unwrap()
  };
  let changed_v1 = asset("release-changed", "1.0.0", "Changed first");
  let changed_v2 = asset("release-changed", "2.0.0", "Changed next");
  let removed = asset("release-removed", "1.0.0", "Removed source");
  let added = asset("release-added", "1.0.0", "Added source");
  let mut guide =
    myoxus_application::template_registry::bundle::parse_bundle(&asset("release-guide", "1.0.0", "Independent guide"))
      .unwrap();
  guide.manifest.purpose = Some(myoxus_application::template_registry::bundle::TemplatePurpose::Guide);
  let guide = myoxus_application::template_registry::bundle::create_export_bundle(
    &guide.manifest,
    &guide.content_bytes,
    None,
    &guide.localized_contents,
  )
  .unwrap();
  let old = capture(
    "1.0.0",
    &[
      ("release-changed", "1.0.0", &changed_v1, Some(true)),
      ("release-removed", "1.0.0", &removed, Some(true)),
      ("release-guide", "1.0.0", &guide, Some(true)),
    ],
  );
  let queue = Arc::new(RecordingTemplateQueue::default());
  let registry = build_materializing_service(&pool, Arc::new(TestBlobStorage::default()))
    .with_reconcile_queue(queue.clone())
    .unwrap();
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let user = helpers::create_user(&pool, "feature-delivery-owner", true).await;
  let workspace = helpers::create_workspace(&pool, user).await;
  let empty = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces(id,owner_user_id,name,initial_content_policy) VALUES($1,$2,'Empty release delivery','empty')")
    .bind(empty).bind(user).execute(&pool).await.unwrap();
  sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status,joined_at) VALUES($1,$2,'Owner','Accepted',now())")
    .bind(empty).bind(user).execute(&pool).await.unwrap();
  for id in [workspace, empty] {
    helpers::create_workspace_root_doc(&pool, id, user).await;
  }
  let first = register_feature_document_sources(&registry, std::slice::from_ref(&old), &[old.pin()])
    .await
    .unwrap();
  assert_eq!(first.scheduled_workspaces, 1);
  assert!(
    registry
      .store()
      .list_instances_for_workspace(workspace)
      .await
      .unwrap()
      .is_empty(),
    "publication queues delivery, never writes source bodies itself"
  );
  let queued = queue.0.lock().unwrap().clone();
  assert!(queued.iter().any(|(queue, name, data)| queue == "template-registry"
    && name == "template-registry.reconcileWorkspace"
    && data["workspaceId"] == workspace.to_string()
    && data["reconcileJobId"].is_string()));
  let first_sources = registry.reconcile_workspace_templates(workspace).await.unwrap();
  let changed_id = registry
    .store()
    .get_catalog_entry_by_slug("release-changed")
    .await
    .unwrap()
    .unwrap()
    .id;
  let removed_id = registry
    .store()
    .get_catalog_entry_by_slug("release-removed")
    .await
    .unwrap()
    .unwrap()
    .id;
  let before = first_sources
    .iter()
    .find(|source| source.template_id == changed_id)
    .unwrap()
    .workspace_doc_id
    .unwrap();
  let removed_source = first_sources
    .iter()
    .find(|source| source.template_id == removed_id)
    .unwrap();
  let removed_doc = removed_source.workspace_doc_id.unwrap();
  let removed_key = removed_source.workspace_doc_key.clone().unwrap();
  let removed_body = documents
    .load_full_doc_consistent(workspace, removed_doc)
    .await
    .unwrap();
  let (working, _) = documents
    .create_page_from_snapshot_with_sync_updates(workspace, user, Some("Removed source".into()), removed_body)
    .await
    .unwrap();
  let working_body = documents.load_full_doc_consistent(workspace, working.id).await.unwrap();
  let guide_id = registry
    .store()
    .get_catalog_entry_by_slug("release-guide")
    .await
    .unwrap()
    .unwrap()
    .id;
  let guide_doc = first_sources
    .iter()
    .find(|source| source.template_id == guide_id)
    .unwrap()
    .workspace_doc_id
    .unwrap();
  let guide_body = documents.load_full_doc_consistent(workspace, guide_doc).await.unwrap();
  let removed_revision = removed_source.revision_id;
  let mut preserved = Vec::new();
  for choice in ["pinned", "disabled", "edited"] {
    let protected_workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspaces(id,owner_user_id,name,initial_content_policy) VALUES($1,$2,$3,'empty')")
      .bind(protected_workspace)
      .bind(user)
      .bind(choice)
      .execute(&pool)
      .await
      .unwrap();
    helpers::create_workspace_root_doc(&pool, protected_workspace, user).await;
    let mut policy = registry
      .assign_template_to_workspace(
        protected_workspace,
        removed_id,
        if choice == "pinned" {
          SelectionMode::PinnedRevision
        } else {
          SelectionMode::Published
        },
        (choice == "pinned").then_some(removed_revision),
        ProvisioningMode::ManagedUntilLocalEdit,
      )
      .await
      .unwrap();
    let source = registry
      .reconcile_workspace_templates(protected_workspace)
      .await
      .unwrap()
      .remove(0);
    let document = source.workspace_doc_id.unwrap();
    if choice == "disabled" {
      policy.is_enabled = false;
      registry.store().update_policy(&policy).await.unwrap();
    }
    if choice == "edited" {
      let body = documents
        .load_full_doc_consistent(protected_workspace, document)
        .await
        .unwrap();
      let edited = yjs::restore_document_snapshot(
        &body,
        &yjs::markdown_to_yjs("Authored custom source", "Keep this actual user edit").unwrap(),
      )
      .unwrap();
      documents
        .push_update_raw(protected_workspace, document, edited, DocSpaceKind::Workspace)
        .await
        .unwrap();
    }
    let policy = registry.store().get_policy(policy.id).await.unwrap().unwrap();
    preserved.push((
      choice,
      protected_workspace,
      document,
      policy,
      documents
        .load_full_doc_consistent(protected_workspace, document)
        .await
        .unwrap(),
    ));
  }
  registry
    .assign_template_to_workspace(
      empty,
      changed_id,
      SelectionMode::Published,
      None,
      ProvisioningMode::ManagedUntilLocalEdit,
    )
    .await
    .unwrap();
  let empty_before = registry.reconcile_workspace_templates(empty).await.unwrap()[0]
    .workspace_doc_id
    .unwrap();
  // The unchanged handler bookkeeping is completed after driving its actual
  // application delegate; subsequent selection must discover native deltas.
  sqlx::query("UPDATE template_reconcile_jobs SET state='completed',finished_at=now() WHERE scope='workspace'")
    .execute(&pool)
    .await
    .unwrap();
  let next = capture(
    "2.0.0",
    &[
      ("release-changed", "1.0.0", &changed_v1, None),
      ("release-changed", "2.0.0", &changed_v2, Some(false)),
      ("release-added", "1.0.0", &added, Some(true)),
    ],
  );
  let update = register_feature_document_sources(&registry, std::slice::from_ref(&next), &[next.pin()])
    .await
    .unwrap();
  assert_eq!(
    update.scheduled_workspaces, 3,
    "ordinary, explicit Empty and edited-source withdrawal consume deltas; pin/disable do not"
  );
  let pending_replay = register_feature_document_sources(&registry, std::slice::from_ref(&next), &[next.pin()])
    .await
    .unwrap();
  assert_eq!(
    pending_replay.scheduled_workspaces, 0,
    "durable pending jobs prevent duplicate release scheduling"
  );
  let after = registry.reconcile_workspace_templates(workspace).await.unwrap();
  let empty_after = registry.reconcile_workspace_templates(empty).await.unwrap();
  let changed = after.iter().find(|source| source.template_id == changed_id).unwrap();
  assert_eq!(
    changed.workspace_doc_id,
    Some(before),
    "default=false does not withdraw an active assignment"
  );
  assert_eq!(empty_after.len(), 1, "Empty receives no implicit added default");
  assert_eq!(empty_after[0].workspace_doc_id, Some(empty_before));
  let expected = myoxus_application::template_registry::bundle::parse_bundle(&changed_v2).unwrap();
  for (workspace, document) in [(workspace, before), (empty, empty_before)] {
    assert!(
      yjs::native_documents_have_same_content(
        &documents.load_full_doc_consistent(workspace, document).await.unwrap(),
        &expected.content_bytes
      )
      .unwrap(),
      "managed sources must contain the next actual native body"
    );
  }
  let added_id = registry
    .store()
    .get_catalog_entry_by_slug("release-added")
    .await
    .unwrap()
    .unwrap()
    .id;
  let added_source = after.iter().find(|source| source.template_id == added_id).unwrap();
  let expected = myoxus_application::template_registry::bundle::parse_bundle(&added).unwrap();
  assert!(
    yjs::native_documents_have_same_content(
      &documents
        .load_full_doc_consistent(workspace, added_source.workspace_doc_id.unwrap())
        .await
        .unwrap(),
      &expected.content_bytes
    )
    .unwrap()
  );
  assert!(
    !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM docs WHERE id=$1)")
      .bind(removed_doc)
      .fetch_one(&pool)
      .await
      .unwrap()
  );
  assert!(
    !sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(SELECT 1 FROM workspace_template_policies WHERE workspace_id=$1 AND template_id=$2)"
    )
    .bind(workspace)
    .bind(removed_id)
    .fetch_one(&pool)
    .await
    .unwrap()
  );
  assert!(
    registry
      .page_default_replacements(workspace)
      .await
      .unwrap()
      .iter()
      .any(|effect| effect.retired_source_doc_id == removed_key && effect.replacement_source_doc_id.is_none()),
    "a deleted standalone export must clear only its stale default reference, without guessing a replacement"
  );
  assert_eq!(
    documents.load_full_doc_consistent(workspace, working.id).await.unwrap(),
    working_body
  );
  assert_eq!(
    documents.load_full_doc_consistent(workspace, guide_doc).await.unwrap(),
    guide_body,
    "withdrawal removes guide delivery ownership, never the ordinary reader copy"
  );
  for (choice, protected_workspace, document, policy, body) in preserved {
    registry
      .reconcile_workspace_templates(protected_workspace)
      .await
      .unwrap();
    assert_eq!(
      documents
        .load_full_doc_consistent(protected_workspace, document)
        .await
        .unwrap(),
      body,
      "{choice}"
    );
    assert!(
      registry
        .page_default_replacements(protected_workspace)
        .await
        .unwrap()
        .is_empty(),
      "{choice}: live bodies retain their preference"
    );
    if choice == "edited" {
      assert!(registry.store().get_policy(policy.id).await.unwrap().is_none());
      let native: (String, String, Option<Uuid>) =
        sqlx::query_as("SELECT state,source,template_id FROM document_template_state WHERE doc_id=$1")
          .bind(document)
          .fetch_one(&pool)
          .await
          .unwrap();
      assert_eq!(native, ("seeded".into(), "document".into(), None));
    } else {
      assert_eq!(
        serde_json::to_value(registry.store().get_policy(policy.id).await.unwrap().unwrap()).unwrap(),
        serde_json::to_value(policy).unwrap()
      );
      assert_eq!(
        registry
          .store()
          .find_instance(protected_workspace, removed_id)
          .await
          .unwrap()
          .unwrap()
          .workspace_doc_id,
        Some(document)
      );
    }
  }
  // An explicit retirement is a durable opt-out, even while its release default
  // remains true. Startup must not re-create the deleted reusable source.
  let added_policy = registry
    .store()
    .list_policies_for_workspace(workspace)
    .await
    .unwrap()
    .into_iter()
    .find(|policy| policy.template_id == added_id)
    .unwrap();
  registry.retire_template_assignment(added_policy.id).await.unwrap();
  sqlx::query("UPDATE template_reconcile_jobs SET state='completed',finished_at=now() WHERE scope='workspace'")
    .execute(&pool)
    .await
    .unwrap();
  let replay = register_feature_document_sources(&registry, std::slice::from_ref(&next), &[next.pin()])
    .await
    .unwrap();
  assert_eq!(
    replay.scheduled_workspaces, 0,
    "unchanged startup must schedule no full rebuild"
  );
  assert!(
    !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM docs WHERE id=$1)")
      .bind(added_source.workspace_doc_id)
      .fetch_one(&pool)
      .await
      .unwrap()
  );
  assert_eq!(
    registry
      .store()
      .find_instance(workspace, changed_id)
      .await
      .unwrap()
      .unwrap()
      .workspace_doc_id,
    Some(before)
  );
}

#[tokio::test]
async fn inv_feature_document_catalog_selection_is_atomic_and_preserves_native_bindings() {
  use futures_util::FutureExt;
  use myoxus_application::template_registry::ShippedTemplateSelection;
  use myoxus_domain::template_registry::{ProvisioningMode, SelectionMode};
  let pool = helpers::setup_pool().await;
  let storage = Arc::new(TestBlobStorage::default());
  let service = build_materializing_service(&pool, storage.clone());
  let user = helpers::create_user(&pool, "feature-doc-selection", true).await;
  let slugs = [
    format!("feature-doc-{}", Uuid::new_v4().simple()),
    format!("feature-doc-{}", Uuid::new_v4().simple()),
  ];
  let result = std::panic::AssertUnwindSafe(async {
    let workspace = helpers::create_workspace(&pool, user).await;
    helpers::create_workspace_root_doc(&pool, workspace, user).await;
    let mut staged = Vec::new();
    for slug in &slugs {
      let (entry, first) = service.stage_shipped_catalog_bundle(&create_test_bundle(slug, "1.0.0", "First"), "document.zip").await.unwrap();
      let (_, next) = service.stage_shipped_catalog_bundle(&create_test_bundle(slug, "2.0.0", "Next"), "document.zip").await.unwrap();
      assert!(service.store().get_latest_published_revision(entry.id).await.unwrap().is_none(), "staging must not select current");
      staged.push((entry, first, next));
    }
    let first_selection: Vec<_> = staged.iter().map(|(entry, first, next)| ShippedTemplateSelection {
      template_id: entry.id, current_revision_id: Some(first.id), history_revision_ids: vec![next.id], new_workspace_default: true,
    }).collect();
    let (first, repeated) = tokio::join!(service.commit_shipped_catalog_selection(&first_selection), service.commit_shipped_catalog_selection(&first_selection));
    assert_eq!(first.unwrap().current.len(), 2);
    assert_eq!(repeated.unwrap().current.len(), 2);
    let mut false_defaults = first_selection.clone();
    for item in &mut false_defaults { item.new_workspace_default = false; }
    service.commit_shipped_catalog_selection(&false_defaults).await.unwrap();
    for (entry, _, _) in &staged {
      let policy: (bool, bool) = sqlx::query_as("SELECT apply_to_new_workspaces,release_managed FROM template_default_policies WHERE template_id=$1")
        .bind(entry.id).fetch_one(&pool).await.unwrap();
      assert_eq!(policy, (false, true), "authored true-to-false changes only release-owned defaults");
    }
    service.commit_shipped_catalog_selection(&first_selection).await.unwrap();
    for (entry, _, _) in &staged {
      let policy: (bool, bool) = sqlx::query_as("SELECT apply_to_new_workspaces,release_managed FROM template_default_policies WHERE template_id=$1")
        .bind(entry.id).fetch_one(&pool).await.unwrap();
      assert_eq!(policy, (true, true), "authored false-to-true remains supported");
    }
    // Either lock ordering must retain an explicit operator policy save.
    let (release, operator) = tokio::join!(
      service.commit_shipped_catalog_selection(&first_selection),
      service.set_new_workspace_default_for_slug(&slugs[0], false),
    );
    release.unwrap();
    assert!(operator.unwrap());
    let policy: (bool, bool) = sqlx::query_as("SELECT apply_to_new_workspaces,release_managed FROM template_default_policies WHERE template_id=$1")
      .bind(staged[0].0.id).fetch_one(&pool).await.unwrap();
    assert_eq!(policy, (false, false));
    // A later explicit operator save becomes the sole policy authority even
    // when it saves the same boolean as the release's previous default.
    service.set_new_workspace_default_for_slug(&slugs[1], true).await.unwrap();
    let (entry, revision, next) = &staged[0];
    service.assign_template_to_workspace(workspace, entry.id, SelectionMode::PinnedRevision, Some(revision.id), ProvisioningMode::ManualUpdate).await.unwrap();
    let instance = service.reconcile_workspace_templates(workspace).await.unwrap().into_iter().find(|instance| instance.template_id == entry.id).unwrap();
    let document = instance.workspace_doc_id.unwrap();
    let before: Value = sqlx::query_scalar("SELECT jsonb_build_object('instance',(SELECT to_jsonb(i) FROM workspace_template_instances i WHERE i.id=$1),'policy',(SELECT to_jsonb(p) FROM workspace_template_policies p WHERE p.workspace_id=$2 AND p.template_id=$3),'doc',(SELECT to_jsonb(d) FROM docs d WHERE d.id=$4),'updates',(SELECT jsonb_agg(to_jsonb(u) ORDER BY sequence) FROM doc_updates u WHERE u.doc_id=$4))")
      .bind(instance.id).bind(workspace).bind(entry.id).bind(document).fetch_one(&pool).await.unwrap();
    // A genuine revision-backed prior builtin can change catalog source without
    // the legacy instance-adoption migration or any document/binding mutation.
    // Set the historical storage fact atomically: the ordinary catalog metadata
    // setter deliberately cannot change source ownership.
    let prior_builtin = sqlx::query("UPDATE template_catalog_entries SET source='builtin',builder_version=1,status='disabled' WHERE id=$1 AND source='bundle' AND builder_version IS NULL")
      .bind(entry.id).execute(&pool).await.unwrap();
    assert_eq!(prior_builtin.rows_affected(), 1);
    service.set_new_workspace_default_for_slug(&slugs[0], false).await.unwrap();
    let operator_default_before: Value = sqlx::query_scalar("SELECT to_jsonb(p) FROM template_default_policies p WHERE p.template_id=$1")
      .bind(entry.id).fetch_one(&pool).await.unwrap();
    let next_selection: Vec<_> = staged.iter().map(|(entry, first, next)| ShippedTemplateSelection {
      template_id: entry.id, current_revision_id: Some(next.id), history_revision_ids: vec![first.id], new_workspace_default: false,
    }).collect();
    service.commit_shipped_catalog_selection(&next_selection).await.unwrap();
    assert_eq!(service.store().get_revision(revision.id).await.unwrap().unwrap().state, RevisionState::Deprecated);
    assert_eq!(service.store().get_latest_published_revision(entry.id).await.unwrap().unwrap().id, next.id);
    assert_eq!(service.store().get_catalog_entry(entry.id).await.unwrap().unwrap().source, TemplateSource::Bundle);
    let after: Value = sqlx::query_scalar("SELECT jsonb_build_object('instance',(SELECT to_jsonb(i) FROM workspace_template_instances i WHERE i.id=$1),'policy',(SELECT to_jsonb(p) FROM workspace_template_policies p WHERE p.workspace_id=$2 AND p.template_id=$3),'doc',(SELECT to_jsonb(d) FROM docs d WHERE d.id=$4),'updates',(SELECT jsonb_agg(to_jsonb(u) ORDER BY sequence) FROM doc_updates u WHERE u.doc_id=$4))")
      .bind(instance.id).bind(workspace).bind(entry.id).bind(document).fetch_one(&pool).await.unwrap();
    assert_eq!(before, after, "release current must preserve exact existing docs, updates, pins and bindings");
    let default: bool = sqlx::query_scalar("SELECT apply_to_new_workspaces FROM template_default_policies WHERE template_id=$1").bind(entry.id).fetch_one(&pool).await.unwrap();
    assert!(!default, "explicit operator opt-out remains canonical");
    let operator_default_after: Value = sqlx::query_scalar("SELECT to_jsonb(p) FROM template_default_policies p WHERE p.template_id=$1")
      .bind(entry.id).fetch_one(&pool).await.unwrap();
    assert_eq!(operator_default_before, operator_default_after);
    assert_eq!(service.store().get_catalog_entry(entry.id).await.unwrap().unwrap().status, TemplateStatus::Disabled);
    let preserved_true: bool = sqlx::query_scalar("SELECT apply_to_new_workspaces FROM template_default_policies WHERE template_id=$1")
      .bind(staged[1].0.id).fetch_one(&pool).await.unwrap();
    assert!(preserved_true, "unknown-provenance existing true policy remains canonical for source default=false");
    // Fail after the first root's retirement has executed: the complete native
    // selection, including previous Published state, must roll back.
    let mut ordered = staged.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|(entry, _, _)| entry.id);
    let invalid = vec![
      ShippedTemplateSelection { template_id: ordered[0].0.id, current_revision_id: None, history_revision_ids: vec![ordered[0].1.id, ordered[0].2.id], new_workspace_default: false },
      ShippedTemplateSelection { template_id: ordered[1].0.id, current_revision_id: Some(Uuid::new_v4()), history_revision_ids: vec![], new_workspace_default: false },
    ];
    assert!(service.commit_shipped_catalog_selection(&invalid).await.is_err());
    for (entry, _, next) in &staged {
      assert_eq!(service.store().get_latest_published_revision(entry.id).await.unwrap().unwrap().id, next.id);
    }
    assert!(service.commit_shipped_catalog_selection(&first_selection).await.is_err(), "old node must not downgrade server current");
    // CLI-native imports have no synthetic actor. Authorship must remain None
    // when an operator later validates/publishes that revision through Admin.
    let cli_bundle = create_test_bundle(&slugs[0], "99.0.0", "CLI-authored operator current");
    let parsed = myoxus_application::template_registry::bundle::parse_bundle(&cli_bundle).unwrap();
    let blob_key = parsed.content_checksum.clone();
    storage.write_blob(BlobWriteRequest { key: blob_key.clone(),content_type:Some("application/zip".into()),body:Bytes::from(cli_bundle) }).await.unwrap();
    let (_, custom) = service.import_template_bundle(myoxus_application::template_registry::ImportTemplateBundleRequest {
      slug:&parsed.manifest.template_id,title:&parsed.manifest.title,description:parsed.manifest.description.as_deref(),
      category:parsed.manifest.category.as_deref(),tags:parsed.manifest.tags.clone(),version:&parsed.manifest.version,
      bundle_blob_id:&blob_key,preview_blob_id:None,checksum:&parsed.content_checksum,
      manifest:serde_json::to_value(&parsed.manifest).unwrap(),created_by:None,
    }).await.unwrap();
    assert_eq!(custom.created_by,None);
    assert_eq!(custom.state,RevisionState::Draft);
    service.validate_template_bundle(custom.id).await.unwrap();
    // The ordinary native publication owner shares the release root lock.
    // Its deliberately higher operator version is not a release high-water mark.
    let (published, selected) = tokio::join!(service.publish_revision_with_actor(custom.id,Some(user)), service.commit_shipped_catalog_selection(&next_selection));
    let published = published.unwrap();
    assert_eq!(published.id, custom.id);
    assert_eq!(published.created_by,None,"publication must not rewrite immutable authorship");
    selected.unwrap();
    let publication: (bool,Option<Uuid>) = sqlx::query_as("SELECT release_managed_publication,created_by FROM template_revisions WHERE id=$1").bind(custom.id).fetch_one(&pool).await.unwrap();
    assert_eq!(publication,(false,None));
    let custom_before: Value = sqlx::query_scalar("SELECT to_jsonb(r) FROM template_revisions r WHERE id=$1").bind(custom.id).fetch_one(&pool).await.unwrap();
    let report = service.commit_shipped_catalog_selection(&next_selection).await.unwrap();
    assert!(report.operator_current_preserved.contains(&entry.id));
    assert_eq!(service.store().get_latest_published_revision(entry.id).await.unwrap().unwrap().id, custom.id);
    let retired: Vec<_> = staged.iter().map(|(entry, first, next)| ShippedTemplateSelection {
      template_id: entry.id, current_revision_id: None, history_revision_ids: vec![first.id, next.id], new_workspace_default: false,
    }).collect();
    service.commit_shipped_catalog_selection(&retired).await.unwrap();
    assert_eq!(service.store().get_latest_published_revision(entry.id).await.unwrap().unwrap().id, custom.id);
    let custom_after: Value = sqlx::query_scalar("SELECT to_jsonb(r) FROM template_revisions r WHERE id=$1").bind(custom.id).fetch_one(&pool).await.unwrap();
    assert_eq!(custom_before,custom_after,"release replacement and retirement must preserve an actorless operator-selected current exactly");
    assert!(service.store().get_latest_published_revision(staged[1].0.id).await.unwrap().is_none());
    let retired_release: (String,bool) = sqlx::query_as("SELECT state,release_managed_publication FROM template_revisions WHERE id=$1").bind(staged[1].2.id).fetch_one(&pool).await.unwrap();
    assert_eq!(retired_release,("deprecated".into(),true),"release history must retain its own downgrade evidence");
    assert!(service.commit_shipped_catalog_selection(&first_selection).await.is_err(), "old node cannot resurrect a lower version after current retirement");
    let fresh = helpers::create_workspace(&pool, user).await;
    service.store().apply_default_policies_to_new_workspace(fresh).await.unwrap();
    let retired_seed: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_template_policies WHERE workspace_id=$1 AND template_id=$2").bind(fresh).bind(staged[1].0.id).fetch_one(&pool).await.unwrap();
    assert_eq!(retired_seed, 0, "retained history cannot seed an implicit new-workspace assignment");
    // An explicit Admin publication of a server-authored validated source is
    // also operator-owned, even when the next release names that exact target.
    let (_, system_staged) = service.stage_shipped_catalog_bundle(&create_test_bundle(&slugs[1],"3.0.0","Server-authored operator selection"),"server-authored.zip").await.unwrap();
    assert_eq!(system_staged.created_by,None);
    assert_eq!(system_staged.state,RevisionState::Validated);
    service.publish_revision_with_actor(system_staged.id,Some(user)).await.unwrap();
    let same_target = [ShippedTemplateSelection {
      template_id:staged[1].0.id,current_revision_id:Some(system_staged.id),history_revision_ids:vec![staged[1].1.id,staged[1].2.id],new_workspace_default:false,
    }];
    let preserved = service.commit_shipped_catalog_selection(&same_target).await.unwrap();
    let mut preserved_owners = vec![staged[0].0.id,staged[1].0.id];
    preserved_owners.sort();
    assert_eq!(preserved.operator_current_preserved,preserved_owners,"complete selection protects both named and entirely omitted operator publications");
    service.commit_shipped_catalog_selection(&retired).await.unwrap();
    assert_eq!(service.store().get_latest_published_revision(staged[1].0.id).await.unwrap().unwrap().id,system_staged.id);
    let owned: bool = sqlx::query_scalar("SELECT release_managed_publication FROM template_revisions WHERE id=$1").bind(system_staged.id).fetch_one(&pool).await.unwrap();
    assert!(!owned,"release must not adopt an explicit publication of its own immutable child");

  }).catch_unwind().await;
  for slug in &slugs {
    cleanup_template(&pool, slug).await;
  }
  helpers::cleanup_users(&pool, &[user]).await;
  if let Err(error) = result {
    std::panic::resume_unwind(error);
  }
}

#[sqlx::test(migrations = false)]
async fn inv_pinned_library_source_requires_live_native_binding_content_and_access(pool: PgPool) {
  use myoxus_application::{
    permission::PermissionService,
    template_registry::suggestions::{TemplateSuggestionError, TemplateSuggestionService},
  };
  use myoxus_domain::template_registry::{ProvisioningMode, SelectionMode};
  myoxus_infrastructure::migrations::run(&pool).await.unwrap();
  let user = helpers::create_user(&pool, "pinned-library-owner", true).await;
  let outsider = helpers::create_user(&pool, "pinned-library-outsider", false).await;
  let workspace = helpers::create_workspace(&pool, user).await;
  helpers::create_workspace_root_doc(&pool, workspace, user).await;
  let registry = Arc::new(build_materializing_service(&pool, Arc::new(TestBlobStorage::default())));
  let slug = format!("pinned-library-{}", Uuid::new_v4().simple());
  let (entry, revision, _) = registry
    .import_from_bundle(&create_test_bundle(&slug, "1.0.0", "Pinned source"), user)
    .await
    .unwrap();
  registry.publish_revision(revision.id).await.unwrap();
  let policy = registry
    .assign_template_to_workspace(
      workspace,
      entry.id,
      SelectionMode::PinnedRevision,
      Some(revision.id),
      ProvisioningMode::SeedOnce,
    )
    .await
    .unwrap();
  let instance = registry
    .reconcile_workspace_templates(workspace)
    .await
    .unwrap()
    .into_iter()
    .find(|i| i.template_id == entry.id)
    .unwrap();
  assert_eq!(instance.state, myoxus_domain::template_registry::InstanceState::Ok);
  let doc_id = instance.workspace_doc_id.unwrap();
  let metadata = Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
  sqlx::query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'External','Accepted')",
  )
  .bind(workspace)
  .bind(outsider)
  .execute(&pool)
  .await
  .unwrap();
  sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) VALUES($1,$2,'Owner')")
    .bind(outsider)
    .bind(doc_id)
    .execute(&pool)
    .await
    .unwrap();
  let suggestions = TemplateSuggestionService::new(
    registry.clone(),
    None,
    Some(Arc::new(PermissionService::new(Arc::new(SqlxAuthStore::from_pool(
      pool.clone(),
    ))))),
  )
  .with_document_metadata_service(myoxus_application::document_metadata::DocumentMetadataService::new(
    metadata.clone(),
  ));
  let before = registry.store().get_instance(instance.id).await.unwrap().unwrap();
  let item = suggestions
    .resolve_pinned_library_source(user, workspace, &slug, "1.0.0", "en", 1)
    .await
    .unwrap()
    .unwrap();
  assert_eq!(item.template_id, entry.id.to_string());
  assert_eq!(item.source_revision_id, Some(revision.id));
  assert_eq!(item.template_doc_id, instance.workspace_doc_key);
  assert_eq!(
    serde_json::to_value(registry.store().get_instance(instance.id).await.unwrap()).unwrap(),
    serde_json::to_value(Some(&before)).unwrap(),
    "lookup must not reconcile or record drift"
  );
  assert!(
    suggestions
      .resolve_pinned_library_source(user, workspace, &slug, "9.0.0", "en", 1)
      .await
      .unwrap()
      .is_none()
  );
  assert!(matches!(
    suggestions
      .resolve_pinned_library_source(outsider, workspace, &slug, "1.0.0", "en", 1)
      .await,
    Err(TemplateSuggestionError::WorkspaceForbidden)
  ));

  // SeedOnce has no managed-source protection: ordinary native unmark must
  // make this association unavailable even though bytes and instance stay intact.
  metadata
    .apply_patch(
      doc_id,
      user,
      &DocumentMetadataPatch {
        template_state: Some(None),
        ..Default::default()
      },
    )
    .await
    .unwrap();
  assert!(
    suggestions
      .resolve_pinned_library_source(user, workspace, &slug, "1.0.0", "en", 1)
      .await
      .unwrap()
      .is_none()
  );
  metadata
    .apply_patch(
      doc_id,
      user,
      &DocumentMetadataPatch {
        template_state: Some(Some("seeded".into())),
        ..Default::default()
      },
    )
    .await
    .unwrap();
  assert!(
    suggestions
      .resolve_pinned_library_source(user, workspace, &slug, "1.0.0", "en", 1)
      .await
      .unwrap()
      .is_some()
  );
  let documents = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let original = documents.load_full_doc_consistent(workspace, doc_id).await.unwrap();
  let update =
    yjs::restore_document_snapshot(&original, &yjs::markdown_to_yjs("Changed", "Local edit").unwrap()).unwrap();
  documents
    .push_update_raw(workspace, doc_id, update, DocSpaceKind::Workspace)
    .await
    .unwrap();
  assert!(
    suggestions
      .resolve_pinned_library_source(user, workspace, &slug, "1.0.0", "en", 1)
      .await
      .unwrap()
      .is_none()
  );
  let after = registry.store().get_instance(instance.id).await.unwrap().unwrap();
  assert_eq!(after.revision_id, before.revision_id);
  assert_eq!(after.last_applied_hash, before.last_applied_hash);
  assert_eq!(
    after.state, before.state,
    "read-only lookup must not run drift reconciliation"
  );
  assert_eq!(
    registry
      .store()
      .get_policy(policy.id)
      .await
      .unwrap()
      .unwrap()
      .is_enabled,
    policy.is_enabled
  );
}
