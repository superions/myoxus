//! MCP workspace blob read/list tool coverage.
//!
//! The MCP blob tools intentionally reuse the existing BlobService metadata and
//! storage ports. These tests seed bytes through that same service/storage pair
//! and then read them back through MCP so the gate covers ACLs, metadata shape
//! and byte-size limits without introducing a parallel blob path.

use std::sync::Arc;

use bytes::Bytes;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use myoxus_application::doc::DocService;
use myoxus_application::document_metadata::DocumentMetadataService;
use myoxus_application::permission::PermissionService;
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::ports::{BlobStoragePort, BlobWriteRequest};
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::blob::SqlxBlobStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository;
use myoxus_infrastructure::document_metadata_policy::PgDocumentMetadataPolicyRepository;
use myoxus_infrastructure::document_version::PgDocumentVersionRepository;
use myoxus_infrastructure::storage::StorageAdapter;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_mcp::auth::McpAuthContext;
use myoxus_mcp::tools::{McpToolState, McpUploadPolicy, dispatch_tool as unchecked_dispatch_tool};

use crate::helpers;
use futures_util::FutureExt;
#[path = "../../../mcp/src/output_schema_test_support.rs"]
mod output_schema_test_support;

// Preserve the legacy dispatch assertions while checking their real serialized
// success bodies against the productive discovery contract.
async fn dispatch_tool(
  name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let result = unchecked_dispatch_tool(name, params, auth, state).await?;
  if output_schema_test_support::has_core_contract(name) {
    let text = result["content"][0]["text"].as_str().expect("legacy text projection");
    let body = serde_json::from_str(text).unwrap_or_else(|_| json!({"message":text}));
    let schema = &myoxus_mcp::tool_registry::find_tool(name).unwrap().output_schema;
    output_schema_test_support::assert_required_output(schema, &body);
  }
  Ok(result)
}

pub(super) fn build_tool_state(pool: &sqlx::PgPool, blob_service: Arc<BlobService>) -> McpToolState {
  build_tool_state_with_upload_cap(pool, blob_service, 1024 * 1024)
}

fn build_tool_state_with_upload_cap(
  pool: &sqlx::PgPool,
  blob_service: Arc<BlobService>,
  max_upload_bytes: u64,
) -> McpToolState {
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let doc_service = DocService::new(doc_store);
  let document_services = myoxus_application::mcp::ApplicationMcpDocumentOperations::new(
    DocumentMetadataService::new(Arc::new(PgDocumentMetadataRepository::new(pool.clone()))),
    Arc::new(PgDocumentMetadataPolicyRepository::new(pool.clone())),
    Arc::new(PgDocumentVersionRepository::new(pool.clone())),
    Arc::new(doc_service.clone()),
  );
  McpToolState {
    html_catalog: Some(Arc::new(
      myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html"),
      ),
    )),
    workspace_service: WorkspaceService::new(workspace_store),
    workspace_settings_service: None,
    public_repository: None,
    public_delivery_enabled: false,
    document_publication_service: None,
    doc_service,
    comment_service: None,
    server_origin: Arc::from("https://myoxus.test"),
    permission_service: Arc::new(PermissionService::new(auth_store)),
    search_indexer: None,
    search_repository: None,
    assistant_packages: None,
    database_services: None,
    calendar: None,
    organization: None,
    users: None,
    workspace_tag_service: None,
    document_graph_service: None,
    document_template_service: None,
    template_registry: None,
    template_suggestions: None,
    workspace_automation_service: None,
    pdf_export_service: None,
    pdf_template_repo: None,
    pdf_assignment_repo: None,
    document_services: Arc::new(document_services),
    idempotency: Arc::new(myoxus_application::mcp::InMemoryMcpIdempotencyRepository::default()),
    blob_service: Some(blob_service),
    upload_policy: Some(McpUploadPolicy {
      max_upload_bytes,
      signed_url_ttl_seconds: 3600,
      mime_allowlist: vec!["text/plain".to_string(), "image/png".to_string()],
      mime_blocklist: Vec::new(),
      mime_validation_mode: "strict".to_string(),
      mime_policy_reader: Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpMimePolicyReader::new(
        pool.clone(),
      )),
    }),
    audit_recorder: myoxus_application::audit::AuditRecorder::noop(),
    metrics_service: Arc::new(myoxus_application::metrics::MetricsService::in_memory_stub()),
    document_cursor_signing_key: Arc::from(&b"mcp-blob-test-cursor-key"[..]),
    document_export_max_bytes: 8 * 1024 * 1024,
  }
}

fn auth_with_scopes(user_id: Uuid, scopes: &[&str]) -> McpAuthContext {
  McpAuthContext {
    user_id,
    scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
    key_id: Uuid::new_v4(),
  }
}

async fn persist_auth_key(pool: &sqlx::PgPool, auth: &McpAuthContext) {
  sqlx::query(
    "INSERT INTO api_keys (id, user_id, name, key_hash, scopes)
     VALUES ($1, $2, 'mcp-blob-idempotency-test', $3, $4)",
  )
  .bind(auth.key_id)
  .bind(auth.user_id)
  .bind(format!("mcp-blob-idempotency-test-{}", auth.key_id))
  .bind(&auth.scopes)
  .execute(pool)
  .await
  .expect("insert MCP blob test API key");
}

fn inner_json(value: Value) -> Value {
  let text = value["content"][0]["text"].as_str().expect("content text");
  serde_json::from_str(text).expect("inner JSON")
}

pub(super) fn blob_test_services(
  pool: &sqlx::PgPool,
) -> (Arc<BlobService>, Arc<dyn BlobStoragePort>, tempfile::TempDir) {
  let storage_dir = tempfile::tempdir().expect("temp storage dir");
  let storage_root = storage_dir.path().to_string_lossy().to_string();
  let storage_adapter = Arc::new(StorageAdapter::new_fs(&storage_root).expect("storage adapter"));
  let storage: Arc<dyn BlobStoragePort> = storage_adapter.clone();
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let blob_service = Arc::new(BlobService::new(
    blob_store,
    storage.clone(),
    "mcp-blob-test".to_string(),
  ));
  (blob_service, storage, storage_dir)
}

async fn seed_blob(
  blob_service: &BlobService,
  storage: &Arc<dyn BlobStoragePort>,
  workspace_id: Uuid,
  key: &str,
  mime: &str,
  bytes: &'static [u8],
) {
  blob_service
    .initialize_upload(workspace_id, key, bytes.len() as u64, mime)
    .await
    .expect("initialize blob metadata");
  storage
    .write_blob(BlobWriteRequest {
      key: format!("{workspace_id}/{key}"),
      content_type: Some(mime.to_string()),
      body: Bytes::from_static(bytes),
    })
    .await
    .expect("write blob bytes");
  blob_service
    .complete_upload(workspace_id, key)
    .await
    .expect("complete blob upload");
}

#[tokio::test]
async fn inv_mcp_blob01_list_metadata_and_read_small_blob_with_size_gate() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-blob01-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let (blob_service, storage, _storage_dir) = blob_test_services(&pool);
  seed_blob(
    &blob_service,
    &storage,
    workspace_id,
    "docs/example.txt",
    "text/plain",
    b"hello from mcp blob",
  )
  .await;

  let outcome = std::panic::AssertUnwindSafe(async {
    let state = build_tool_state(&pool, blob_service);
    let auth = auth_with_scopes(owner_id, &["read:docs"]);

    let listed = inner_json(
      dispatch_tool(
        "blob_list",
        &json!({
          "workspace_id": workspace_id.to_string(),
          "limit": 10,
        }),
        &auth,
        &state,
      )
      .await
      .expect("list blobs"),
    );
    assert!(
      listed["blobs"]
        .as_array()
        .expect("blobs array")
        .iter()
        .any(|blob| blob["key"].as_str() == Some("docs/example.txt")),
      "blob_list must include the seeded blob metadata: {listed}"
    );

    let metadata = inner_json(
      dispatch_tool(
        "blob_get_metadata",
        &json!({
          "workspace_id": workspace_id.to_string(),
          "key": "docs/example.txt",
        }),
        &auth,
        &state,
      )
      .await
      .expect("get blob metadata"),
    );
    assert_eq!(
      metadata.pointer("/blob/mime").and_then(Value::as_str),
      Some("text/plain")
    );
    assert_eq!(
      metadata.pointer("/blob/status").and_then(Value::as_str),
      Some("completed")
    );

    let read = inner_json(
      dispatch_tool(
        "blob_read",
        &json!({
          "workspace_id": workspace_id.to_string(),
          "key": "docs/example.txt",
          "max_bytes": 1024,
        }),
        &auth,
        &state,
      )
      .await
      .expect("read blob"),
    );
    assert_eq!(read["encoding"], "base64");
    assert_eq!(
      read["dataBase64"].as_str(),
      Some("aGVsbG8gZnJvbSBtY3AgYmxvYg=="),
      "blob_read must return base64 content, not a secret URL: {read}"
    );

    let too_small = dispatch_tool(
      "blob_read",
      &json!({
        "workspace_id": workspace_id.to_string(),
        "key": "docs/example.txt",
        "max_bytes": 4,
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("max_bytes below blob size must fail before returning bytes");
    assert_eq!(too_small.0, -32602);
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_blob02_upload_read_and_delete_uses_existing_policy_and_store() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-blob02-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let (blob_service, _storage, _storage_dir) = blob_test_services(&pool);
  let outcome = std::panic::AssertUnwindSafe(async {
    let mut state = build_tool_state(&pool, blob_service);
    let auth = auth_with_scopes(owner_id, &["read:docs", "write:docs"]);
    persist_auth_key(&pool, &auth).await;
    state.idempotency =
      Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));

    let upload_params = json!({
      "workspace_id": workspace_id.to_string(),
      "key": "mcp/uploaded.txt",
      "mime": "text/plain",
      "dataBase64": "dXBsb2FkZWQgdGhyb3VnaCBtY3A=",
      "idempotency_key": "blob-upload-once",
    });
    let upload_response = dispatch_tool("blob_upload", &upload_params, &auth, &state)
      .await
      .expect("upload blob");
    assert_eq!(
      dispatch_tool("blob_upload", &upload_params, &auth, &state)
        .await
        .expect("replay blob upload"),
      upload_response
    );
    let uploaded = inner_json(upload_response);
    assert_eq!(
      uploaded.pointer("/blob/status").and_then(Value::as_str),
      Some("completed")
    );
    assert_eq!(
      uploaded.pointer("/blob/checksum").and_then(Value::as_str),
      Some("bb2905a124dc11ba0cdb1db05f8ddc0a97b32df2d43c3d8f62222f9dc4a8fc7c")
    );

    let read = inner_json(
      dispatch_tool(
        "blob_read",
        &json!({
          "workspace_id": workspace_id.to_string(),
          "key": "mcp/uploaded.txt",
          "max_bytes": 128,
        }),
        &auth,
        &state,
      )
      .await
      .expect("read uploaded blob"),
    );
    assert_eq!(read["dataBase64"].as_str(), Some("dXBsb2FkZWQgdGhyb3VnaCBtY3A="));

    let delete_params = json!({
      "workspace_id": workspace_id.to_string(),
      "key": "mcp/uploaded.txt",
      "idempotency_key": "blob-delete-once",
    });
    let delete_response = dispatch_tool("blob_delete", &delete_params, &auth, &state)
      .await
      .expect("soft-delete blob");
    assert_eq!(
      dispatch_tool("blob_delete", &delete_params, &auth, &state)
        .await
        .expect("replay blob delete"),
      delete_response
    );
    let deleted = inner_json(delete_response);
    assert_eq!(deleted["deleted"].as_bool(), Some(true));
    assert_eq!(deleted["permanently"].as_bool(), Some(false));

    let listed_deleted = inner_json(
      dispatch_tool(
        "blob_list",
        &json!({
          "workspace_id": workspace_id.to_string(),
          "include_deleted": true,
        }),
        &auth,
        &state,
      )
      .await
      .expect("list deleted blobs"),
    );
    let blob = listed_deleted["blobs"]
      .as_array()
      .expect("blobs array")
      .iter()
      .find(|blob| blob["key"].as_str() == Some("mcp/uploaded.txt"))
      .expect("soft-deleted blob metadata");
    assert!(
      blob["deletedAt"].as_str().is_some(),
      "soft-delete must set deletedAt instead of bypassing metadata: {blob}"
    );
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_blob03_upload_rejects_mime_policy_and_size_limit() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-blob03-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let (blob_service, _storage, _storage_dir) = blob_test_services(&pool);
  let outcome = std::panic::AssertUnwindSafe(async {
    let state = build_tool_state_with_upload_cap(&pool, blob_service, 8);
    let auth = auth_with_scopes(owner_id, &["read:docs", "write:docs"]);

    let too_large = dispatch_tool(
      "blob_upload",
      &json!({
        "workspace_id": workspace_id.to_string(),
        "key": "mcp/too-large.txt",
        "mime": "text/plain",
        "dataBase64": "dGhpcyBpcyB0b28gbGFyZ2U=",
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("upload above configured cap must fail");
    assert_eq!(too_large.0, -32602);

    let oversized_invalid_base64 = dispatch_tool(
      "blob_upload",
      &json!({
        "workspace_id": workspace_id.to_string(),
        "key": "mcp/oversized-invalid.txt",
        "mime": "text/plain",
        "dataBase64": "!!!!!!!!!!!!!!!!",
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("oversized payload must fail before base64 decode");
    assert_eq!(oversized_invalid_base64.0, -32602);
    assert!(
      oversized_invalid_base64.1.contains("base64 payload exceeds"),
      "size gate should run before decode errors: {oversized_invalid_base64:?}"
    );

    let mime_denied = dispatch_tool(
      "blob_upload",
      &json!({
        "workspace_id": workspace_id.to_string(),
        "key": "mcp/program.bin",
        "mime": "application/octet-stream",
        "dataBase64": "AAECAwQ=",
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("strict text/plain policy must reject binary upload");
    assert_eq!(mime_denied.0, -32602);
    assert!(
      mime_denied.1.contains("MIME policy"),
      "denial should identify the shared MIME policy: {mime_denied:?}"
    );
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_document_asset_prepare_and_image_insert_are_hash_bound_and_causally_readable() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-document-asset-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let other_workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let workspace_service = WorkspaceService::new(Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  )));
  for workspace in [workspace_id, other_workspace_id] {
    workspace_service
      .seed_root_doc(
        workspace,
        owner_id,
        yjs::create_initial_workspace_doc("MCP document asset workspace"),
      )
      .await
      .expect("seed workspace root");
  }
  let (blob_service, storage, _storage_dir) = blob_test_services(&pool);
  let outcome = std::panic::AssertUnwindSafe(async {
    let mut state = build_tool_state(&pool, blob_service.clone());
    let auth = auth_with_scopes(owner_id, &["read:docs", "write:docs"]);
    persist_auth_key(&pool, &auth).await;
    state.idempotency =
      Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));

    let png = Bytes::from_static(&[
      0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, b'I', b'H', b'D', b'R',
    ]);
    let hash = hex::encode(Sha256::digest(&png));
    let oversized_prepare = dispatch_tool(
      "document_asset_upload_prepare",
      &json!({
        "workspace_id": workspace_id,
        "filename": "too-large.png",
        "mime": "image/png",
        "byte_size": 1024 * 1024 + 1,
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("asset prepare must enforce the configured upload cap");
    assert_eq!(oversized_prepare.0, -32602);
    let prepare_params = json!({
      "workspace_id": workspace_id,
      "filename": "diagram.png",
      "mime": "image/png",
      "byte_size": png.len(),
      "sha256": hash,
    });
    let first_prepare = inner_json(
      dispatch_tool("document_asset_upload_prepare", &prepare_params, &auth, &state)
        .await
        .expect("prepare document asset"),
    );
    let asset_ref = first_prepare["assetRef"]
      .as_str()
      .expect("opaque asset ref")
      .to_string();
    assert_eq!(asset_ref, format!("assets/{hash}"));
    assert_eq!(first_prepare["alreadyUploaded"], false);
    assert!(first_prepare["uploadUrl"].as_str().is_some());

    let retry_prepare = inner_json(
      dispatch_tool("document_asset_upload_prepare", &prepare_params, &auth, &state)
        .await
        .expect("retry matching asset prepare"),
    );
    assert_eq!(retry_prepare["assetRef"], asset_ref);
    assert_eq!(retry_prepare["alreadyUploaded"], false);
    assert!(retry_prepare["uploadUrl"].as_str().is_some());

    let mut conflicting_prepare = prepare_params.clone();
    conflicting_prepare["byte_size"] = json!(png.len() + 1);
    let conflict = dispatch_tool("document_asset_upload_prepare", &conflicting_prepare, &auth, &state)
      .await
      .expect_err("matching hash with conflicting metadata must fail");
    assert_eq!(conflict.0, -32009);
    let denied_mime = dispatch_tool(
      "document_asset_upload_prepare",
      &json!({
        "workspace_id": workspace_id,
        "filename": "program.bin",
        "mime": "application/octet-stream",
        "byte_size": 4,
        "sha256": "1111111111111111111111111111111111111111111111111111111111111111",
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("current strict MIME policy must reject the asset");
    assert_eq!(denied_mime.0, -32602);

    storage
      .write_blob(BlobWriteRequest {
        key: format!("{workspace_id}/{asset_ref}"),
        content_type: Some("image/png".to_string()),
        body: png.clone(),
      })
      .await
      .expect("write prepared asset bytes");
    blob_service
      .complete_upload(workspace_id, &asset_ref)
      .await
      .expect("complete prepared asset");
    let completed = inner_json(
      dispatch_tool("document_asset_upload_prepare", &prepare_params, &auth, &state)
        .await
        .expect("recognize completed asset"),
    );
    assert_eq!(completed["alreadyUploaded"], true);
    assert!(completed["uploadUrl"].is_null());

    let created = state
      .doc_service
      .create_page_lifecycle(
        workspace_id,
        owner_id,
        Some("Native image target".to_string()),
        Some(myoxus_application::doc::DocumentFragment {
          schema_version: yjs::DOCUMENT_FRAGMENT_SCHEMA.to_string(),
          blocks: vec![myoxus_application::doc::DocumentFragmentBlock::Paragraph {
            properties: None,
            text: vec![myoxus_application::doc::DocumentTextSegment {
              text: "Anchor".to_string(),
              ..Default::default()
            }],
          }],
        }),
      )
      .await
      .expect("create image target document");
    let full_doc = state
      .doc_service
      .load_full_doc(workspace_id, created.document.id)
      .await
      .expect("load image target document");
    let anchor_id = yjs::extract_blocks_from_yjs(&full_doc)
      .expect("extract anchor block")
      .blocks
      .into_iter()
      .find(|block| block.text == "Anchor")
      .expect("anchor paragraph")
      .id;
    let append_params = json!({
      "workspace_id": workspace_id,
      "external_id": created.document.external_id,
      "asset_ref": asset_ref,
      "caption": "Appended image",
      "idempotency_key": "image-append-once",
    });
    let appended = dispatch_tool("document_image_insert", &append_params, &auth, &state)
      .await
      .expect("append native image");
    assert_eq!(
      dispatch_tool("document_image_insert", &append_params, &auth, &state)
        .await
        .expect("replay native image append"),
      appended
    );
    dispatch_tool(
      "document_image_insert",
      &json!({
        "workspace_id": workspace_id,
        "external_id": created.document.external_id,
        "asset_ref": asset_ref,
        "after_block_id": anchor_id,
        "caption": "Positioned image",
        "idempotency_key": "image-after-once",
      }),
      &auth,
      &state,
    )
    .await
    .expect("insert native image after stable block");

    let read = inner_json(
      dispatch_tool(
        "read_doc",
        &json!({ "workspace_id": workspace_id, "external_id": created.document.external_id }),
        &auth,
        &state,
      )
      .await
      .expect("causal document readback"),
    );
    let blocks = read["document"]["blocks"].to_string();
    assert_eq!(
      blocks.matches(&asset_ref).count(),
      2,
      "both native image blocks must retain the asset ref: {blocks}"
    );
    assert!(blocks.contains("Appended image") && blocks.contains("Positioned image"));

    let pending_hash = "2222222222222222222222222222222222222222222222222222222222222222";
    dispatch_tool(
      "document_asset_upload_prepare",
      &json!({
        "workspace_id": workspace_id,
        "filename": "pending.png",
        "mime": "image/png",
        "byte_size": 16,
        "sha256": pending_hash,
      }),
      &auth,
      &state,
    )
    .await
    .expect("prepare pending asset");
    let pending = dispatch_tool(
      "document_image_insert",
      &json!({
        "workspace_id": workspace_id,
        "external_id": created.document.external_id,
        "asset_ref": format!("assets/{pending_hash}"),
        "idempotency_key": "pending-image-rejected",
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("pending asset must not enter a document");
    assert_eq!(pending.0, -32009);

    let other_document = state
      .doc_service
      .create_page(other_workspace_id, owner_id, Some("Other workspace".to_string()))
      .await
      .expect("create other-workspace document");
    let cross_workspace = dispatch_tool(
      "document_image_insert",
      &json!({
        "workspace_id": other_workspace_id,
        "external_id": other_document.external_id,
        "asset_ref": asset_ref,
        "idempotency_key": "cross-workspace-image-rejected",
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("asset lookup must remain workspace-bound");
    assert_eq!(cross_workspace.0, -32004);

    dispatch_tool(
      "folder_path_ensure",
      &json!({
        "workspace_id": workspace_id,
        "path": ["Asset imports"],
        "idempotency_key": "asset-import-folder",
      }),
      &auth,
      &state,
    )
    .await
    .expect("create asset import destination");
    let imported = inner_json(
      dispatch_tool(
        "document_import",
        &json!({
          "workspace_id": workspace_id,
          "title": "Imported native image",
          "fragment": {
            "schemaVersion": yjs::DOCUMENT_FRAGMENT_SCHEMA,
            "blocks": [{ "kind": "image", "source": asset_ref, "alt": "Imported image" }],
          },
          "folder_path": ["Asset imports"],
          "idempotency_key": "asset-import-once",
        }),
        &auth,
        &state,
      )
      .await
      .expect("import completed structured image asset"),
    );
    let imported_read = inner_json(
      dispatch_tool(
        "read_doc",
        &json!({ "workspace_id": workspace_id, "external_id": imported["externalId"] }),
        &auth,
        &state,
      )
      .await
      .expect("read imported native image"),
    );
    let imported_blocks = imported_read["document"]["blocks"].to_string();
    assert!(imported_blocks.contains(&asset_ref) && imported_blocks.contains("Imported image"));

    let doc_count_before: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("count documents before pending-asset import");
    let pending_import = dispatch_tool(
      "document_import",
      &json!({
        "workspace_id": workspace_id,
        "title": "Must not be created",
        "fragment": {
          "schemaVersion": yjs::DOCUMENT_FRAGMENT_SCHEMA,
          "blocks": [{ "kind": "image", "source": format!("assets/{pending_hash}"), "alt": "Pending" }],
        },
        "folder_path": ["Asset imports"],
        "idempotency_key": "pending-asset-import-rejected",
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("structured import must preflight pending assets before creating a page");
    assert_eq!(pending_import.0, -32009);
    let doc_count_after: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("count documents after pending-asset import");
    assert_eq!(doc_count_after, doc_count_before);
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
