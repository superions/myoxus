// SPDX-License-Identifier: AGPL-3.0-or-later
//! Blob upload flow tests — create, complete, abort, multipart.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use axum::{
  body::Body,
  http::{Request, StatusCode},
};
use bytes::Bytes;
use http_body_util::BodyExt;
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, AuthStore, AuthUser, InMemoryAuthStore, NewSession};
use myoxus_application::doc::{DocService, PanicDocStore};
use myoxus_application::ports::blob::{
  BlobGcCandidate, BlobKey, BlobMetadata, BlobStatus, BlobStore, MultipartUploadedPart,
};
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::ports::{
  BlobReadResponse, BlobStoragePort, BlobWriteRequest, MultipartCompleteRequest, MultipartCreateRequest,
  MultipartCreateResponse, MultipartPartUrlRequest, MultipartPartUrlResponse, PortResult,
};
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::mail::LogMailAdapter;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tower::ServiceExt;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// In-memory mock implementations
// ---------------------------------------------------------------------------

#[derive(Default)]
struct MemoryBlobStore {
  records: Mutex<HashMap<(Uuid, String), BlobMetadata>>,
  parts: Mutex<HashMap<(Uuid, String, String, i32), String>>,
}

#[async_trait]
impl BlobStore for MemoryBlobStore {
  async fn create_blob_metadata(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    size: u64,
    mime: &str,
    checksum: Option<&str>,
  ) -> myoxus_application::auth::AuthResult<BlobMetadata> {
    let mut guard = self.records.lock().await;
    let now = chrono::Utc::now();
    let entry = guard
      .entry((workspace_id, key.as_str().to_string()))
      .or_insert_with(|| BlobMetadata {
        blob_id: Uuid::new_v4(),
        workspace_id,
        key: key.as_str().to_string(),
        size,
        mime: mime.to_string(),
        checksum: checksum.map(ToString::to_string),
        status: BlobStatus::Pending,
        upload_id: None,
        created_at: now,
        updated_at: now,
        deleted_at: None,
      });
    entry.size = size;
    entry.mime = mime.to_string();
    entry.checksum = checksum.map(ToString::to_string);
    entry.status = BlobStatus::Pending;
    entry.upload_id = None;
    entry.deleted_at = None;
    entry.updated_at = now;
    Ok(entry.clone())
  }

  async fn register_completed_blob_metadata(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    size: u64,
    mime: &str,
  ) -> myoxus_application::auth::AuthResult<()> {
    let mut metadata = self.create_blob_metadata(workspace_id, key, size, mime, None).await?;
    metadata.status = BlobStatus::Completed;
    self
      .records
      .lock()
      .await
      .insert((workspace_id, key.as_str().to_string()), metadata);
    Ok(())
  }

  async fn get_blob_metadata(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
  ) -> myoxus_application::auth::AuthResult<Option<BlobMetadata>> {
    let guard = self.records.lock().await;
    Ok(guard.get(&(workspace_id, key.as_str().to_string())).cloned())
  }

  async fn update_blob_status(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    status: BlobStatus,
  ) -> myoxus_application::auth::AuthResult<()> {
    let mut guard = self.records.lock().await;
    if let Some(record) = guard.get_mut(&(workspace_id, key.as_str().to_string())) {
      record.status = status;
      record.updated_at = chrono::Utc::now();
    }
    Ok(())
  }

  async fn set_upload_id(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    upload_id: &str,
  ) -> myoxus_application::auth::AuthResult<()> {
    let mut guard = self.records.lock().await;
    if let Some(record) = guard.get_mut(&(workspace_id, key.as_str().to_string())) {
      record.upload_id = Some(upload_id.to_string());
      record.status = BlobStatus::Uploading;
      record.updated_at = chrono::Utc::now();
    }
    Ok(())
  }

  async fn delete_blob_metadata(&self, workspace_id: Uuid, key: &BlobKey) -> myoxus_application::auth::AuthResult<()> {
    let mut guard = self.records.lock().await;
    guard.remove(&(workspace_id, key.as_str().to_string()));
    Ok(())
  }

  async fn upsert_multipart_part(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    upload_id: &str,
    part_number: i32,
    etag: &str,
  ) -> myoxus_application::auth::AuthResult<()> {
    let mut guard = self.parts.lock().await;
    guard.insert(
      (
        workspace_id,
        key.as_str().to_string(),
        upload_id.to_string(),
        part_number,
      ),
      etag.to_string(),
    );
    Ok(())
  }

  async fn list_multipart_parts(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    upload_id: &str,
  ) -> myoxus_application::auth::AuthResult<Vec<MultipartUploadedPart>> {
    let guard = self.parts.lock().await;
    let mut out = guard
      .iter()
      .filter_map(|((ws, k, up, pn), etag)| {
        if *ws == workspace_id && k == key.as_str() && up == upload_id {
          Some(MultipartUploadedPart {
            part_number: *pn,
            etag: etag.clone(),
          })
        } else {
          None
        }
      })
      .collect::<Vec<_>>();
    out.sort_by_key(|p| p.part_number);
    Ok(out)
  }

  async fn clear_multipart_parts(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    upload_id: &str,
  ) -> myoxus_application::auth::AuthResult<()> {
    let mut guard = self.parts.lock().await;
    guard.retain(|(ws, k, up, _), _| !(*ws == workspace_id && k == key.as_str() && up == upload_id));
    Ok(())
  }

  async fn bind_comment_attachment(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _key: &BlobKey,
    _mime: &str,
    _size: u64,
    _created_by: Uuid,
  ) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }

  async fn attach_comment_attachment_to_comment(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _comment_id: Uuid,
    _key: &BlobKey,
    _user_id: Uuid,
  ) -> myoxus_application::auth::AuthResult<bool> {
    Ok(false)
  }

  async fn get_comment_attachment_download(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _key: &BlobKey,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_application::ports::blob::CommentAttachmentDownload>> {
    Ok(None)
  }

  async fn soft_delete_blob_metadata(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    when: chrono::DateTime<chrono::Utc>,
  ) -> myoxus_application::auth::AuthResult<bool> {
    let mut guard = self.records.lock().await;
    if let Some(record) = guard.get_mut(&(workspace_id, key.as_str().to_string())) {
      record.deleted_at = Some(when);
      return Ok(true);
    }
    Ok(false)
  }

  async fn hard_delete_blob_metadata(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
  ) -> myoxus_application::auth::AuthResult<bool> {
    let mut guard = self.records.lock().await;
    Ok(guard.remove(&(workspace_id, key.as_str().to_string())).is_some())
  }

  async fn list_retention_gc_candidates(
    &self,
    deleted_before: chrono::DateTime<chrono::Utc>,
    limit: i64,
  ) -> myoxus_application::auth::AuthResult<Vec<BlobGcCandidate>> {
    let guard = self.records.lock().await;
    let mut out = guard
      .values()
      .filter_map(|record| {
        let deleted_at = record.deleted_at?;
        if deleted_at <= deleted_before {
          Some(BlobGcCandidate {
            workspace_id: record.workspace_id,
            key: record.key.clone(),
            deleted_at,
          })
        } else {
          None
        }
      })
      .collect::<Vec<_>>();
    out.sort_by_key(|value| value.deleted_at);
    out.truncate(limit.max(0) as usize);
    Ok(out)
  }

  async fn list_workspace_blobs(
    &self,
    workspace_id: Uuid,
    limit: i64,
    offset: i64,
    include_deleted: bool,
  ) -> myoxus_application::auth::AuthResult<Vec<BlobMetadata>> {
    let guard = self.records.lock().await;
    let mut out = guard
      .values()
      .filter(|record| record.workspace_id == workspace_id)
      .filter(|record| include_deleted || record.deleted_at.is_none())
      .cloned()
      .collect::<Vec<_>>();
    out.sort_by_key(|record| std::cmp::Reverse(record.created_at));
    let start = offset.max(0) as usize;
    let end = (start + limit.max(0) as usize).min(out.len());
    if start >= out.len() {
      return Ok(Vec::new());
    }
    Ok(out[start..end].to_vec())
  }

  async fn list_workspace_blob_keys_for_deletion(
    &self,
    workspace_id: Uuid,
  ) -> myoxus_application::auth::AuthResult<Vec<String>> {
    Ok(
      self
        .records
        .lock()
        .await
        .values()
        .filter(|record| record.workspace_id == workspace_id)
        .map(|record| record.key.clone())
        .collect(),
    )
  }

  async fn sum_workspace_blob_size(
    &self,
    workspace_id: Uuid,
    include_deleted: bool,
  ) -> myoxus_application::auth::AuthResult<u64> {
    let guard = self.records.lock().await;
    Ok(
      guard
        .values()
        .filter(|record| record.workspace_id == workspace_id)
        .filter(|record| include_deleted || record.deleted_at.is_none())
        .map(|record| record.size)
        .sum(),
    )
  }

  async fn hard_delete_blob(&self, workspace_id: Uuid, key: &BlobKey) -> myoxus_application::auth::AuthResult<bool> {
    let mut guard = self.records.lock().await;
    Ok(guard.remove(&(workspace_id, key.as_str().to_string())).is_some())
  }

  async fn release_deleted_blobs_in_workspace(
    &self,
    workspace_id: Uuid,
    deleted_before: chrono::DateTime<chrono::Utc>,
    limit: i64,
  ) -> myoxus_application::auth::AuthResult<Vec<BlobGcCandidate>> {
    let guard = self.records.lock().await;
    let mut out = guard
      .values()
      .filter(|record| record.workspace_id == workspace_id)
      .filter_map(|record| {
        let deleted_at = record.deleted_at?;
        if deleted_at <= deleted_before {
          Some(BlobGcCandidate {
            workspace_id: record.workspace_id,
            key: record.key.clone(),
            deleted_at,
          })
        } else {
          None
        }
      })
      .collect::<Vec<_>>();
    out.sort_by_key(|value| value.deleted_at);
    out.truncate(limit.max(0) as usize);
    Ok(out)
  }
}

#[derive(Default)]
struct DummyBlobStorage {
  objects: Mutex<HashMap<String, BlobReadResponse>>,
}

#[async_trait]
impl BlobStoragePort for DummyBlobStorage {
  async fn write_blob(&self, req: BlobWriteRequest) -> PortResult<()> {
    let mut guard = self.objects.lock().await;
    let content_length = req.body.len() as u64;
    guard.insert(
      req.key.clone(),
      BlobReadResponse {
        key: req.key,
        content_type: req.content_type,
        data: req.body,
        last_modified: Some(chrono::Utc::now()),
        content_length,
      },
    );
    Ok(())
  }

  async fn read_blob(&self, key: &str) -> PortResult<BlobReadResponse> {
    let guard = self.objects.lock().await;
    guard
      .get(key)
      .cloned()
      .ok_or_else(|| myoxus_application::ports::PortError::NotFound(format!("blob key not found: {key}")))
  }

  async fn delete_blob(&self, key: &str) -> PortResult<()> {
    let mut guard = self.objects.lock().await;
    guard.remove(key);
    Ok(())
  }

  async fn put_avatar(&self, key: &str, _data: Bytes, _content_type: &str) -> PortResult<String> {
    Ok(key.to_string())
  }

  async fn get_avatar(&self, key: &str) -> PortResult<BlobReadResponse> {
    self.read_blob(key).await
  }

  async fn delete_avatar(&self, _key: &str) -> PortResult<()> {
    Ok(())
  }

  async fn create_multipart_upload(&self, _req: MultipartCreateRequest) -> PortResult<MultipartCreateResponse> {
    unimplemented!()
  }

  async fn create_multipart_part_url(&self, _req: MultipartPartUrlRequest) -> PortResult<MultipartPartUrlResponse> {
    unimplemented!()
  }

  async fn complete_multipart_upload(&self, _req: MultipartCompleteRequest) -> PortResult<()> {
    unimplemented!()
  }

  async fn abort_multipart_upload(&self, _upload_id: Uuid) -> PortResult<()> {
    unimplemented!()
  }
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async fn setup_test_app() -> (axum::Router, Arc<ApiState>, Arc<InMemoryAuthStore>) {
  let config = AppConfig::load().expect("AppConfig should load successfully");
  setup_test_app_with_config(config).await
}

async fn setup_test_app_with_config(config: AppConfig) -> (axum::Router, Arc<ApiState>, Arc<InMemoryAuthStore>) {
  let auth_store = Arc::new(InMemoryAuthStore::default());
  let storage = Arc::new(DummyBlobStorage::default());
  let auth_service = AuthService::new(
    auth_store.clone(),
    Arc::new(LogMailAdapter),
    storage.clone(),
    3600,
    3600,
  );
  let workspace_service = WorkspaceService::new(auth_store.clone());
  let admin_service = AdminService::new(Arc::new(InMemoryAdminStore));
  let doc_service = DocService::new(Arc::new(PanicDocStore));
  let blob_service = Arc::new(BlobService::new(
    Arc::new(MemoryBlobStore::default()),
    storage.clone(),
    "test-sign-key".to_string(),
  ));

  let state = Arc::new(ApiState::with_services(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    blob_service,
    storage,
  ));

  (build_router((*state).clone()), state, auth_store)
}

async fn create_user_session(store: &InMemoryAuthStore, email: &str) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: email.to_string(),
    name: Some(email.to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });

  let session = store
    .create_session(NewSession {
      id: Uuid::new_v4(),
      user_id,
      csrf_token: "csrf".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("creating user session should succeed");

  (user_id, session.id)
}

async fn graphql(app: &axum::Router, cookie_session: Uuid, payload: Value) -> Value {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={cookie_session}"))
        .body(Body::from(payload.to_string()))
        .expect("building GraphQL request should not fail"),
    )
    .await
    .expect("sending GraphQL request should not fail");

  let body = response
    .into_body()
    .collect()
    .await
    .expect("collecting GraphQL response body should not fail")
    .to_bytes();
  serde_json::from_slice(&body).expect("GraphQL response should be valid JSON")
}

fn create_blob_upload_payload(workspace_id: Uuid, key: &str, size: i32, mime: &str) -> Value {
  json!({
      "query": "mutation CreateBlobUpload($workspaceId: String!, $key: String!, $size: Int!, $mime: String!) { createBlobUpload(workspaceId: $workspaceId, key: $key, size: $size, mime: $mime) { method blobKey alreadyUploaded uploadUrl headers expiresAt uploadId partSize uploadedParts { partNumber etag } } }",
      "variables": {
          "workspaceId": workspace_id.to_string(),
          "key": key,
          "size": size,
          "mime": mime,
      }
  })
}

async fn graphql_multipart_upload(
  app: &axum::Router,
  cookie_session: Uuid,
  workspace_id: Uuid,
  file_name: &str,
  content_type: &str,
  content: &[u8],
) -> Value {
  let boundary = "X-BOUNDARY-MYOXUS";
  let operations = json!({
        "query": "mutation SetBlob($workspaceId: String!, $blob: Upload!) { setBlob(workspaceId: $workspaceId, blob: $blob) }",
        "variables": {
            "workspaceId": workspace_id.to_string(),
            "blob": null
        }
    })
    .to_string();
  let map = json!({ "0": ["variables.blob"] }).to_string();

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
        .header("cookie", format!("affine_session={cookie_session}"))
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

#[tokio::test]
async fn signed_storage_upload_rejects_invalid_signature_and_checksum_before_completing() {
  let (app, state, _) = setup_test_app().await;
  let workspace_id = Uuid::new_v4();
  let body = Bytes::from_static(b"content-addressed asset");
  let checksum = hex::encode(Sha256::digest(&body));
  let key = format!("assets/{checksum}");
  state
    .blob()
    .initialize_upload_with_metadata(workspace_id, &key, body.len() as u64, "text/plain", Some(&checksum))
    .await
    .expect("initialize signed upload metadata");
  let upload_url = state
    .blob()
    .create_signed_upload_url("/api/storage/upload", workspace_id, &key, 3600)
    .expect("create signed upload URL");

  let invalid_url = upload_url.replacen("token=", "token=invalid", 1);
  let invalid_signature = app
    .clone()
    .oneshot(
      Request::builder()
        .method("PUT")
        .uri(invalid_url)
        .header("content-type", "text/plain")
        .body(Body::from(body.clone()))
        .expect("build invalid-signature request"),
    )
    .await
    .expect("send invalid-signature request");
  assert_eq!(invalid_signature.status(), StatusCode::UNAUTHORIZED);

  let checksum_mismatch = app
    .clone()
    .oneshot(
      Request::builder()
        .method("PUT")
        .uri(upload_url.clone())
        .header("content-type", "text/plain")
        .body(Body::from(Bytes::from_static(b"content-addressed asseT")))
        .expect("build checksum-mismatch request"),
    )
    .await
    .expect("send checksum-mismatch request");
  assert_eq!(checksum_mismatch.status(), StatusCode::CONFLICT);
  assert_eq!(
    state
      .blob()
      .get_blob_metadata(workspace_id, &key)
      .await
      .expect("read metadata after checksum mismatch")
      .expect("pending metadata")
      .status,
    BlobStatus::Pending
  );

  let completed = app
    .oneshot(
      Request::builder()
        .method("PUT")
        .uri(upload_url)
        .header("content-type", "text/plain")
        .body(Body::from(body))
        .expect("build valid signed-upload request"),
    )
    .await
    .expect("send valid signed-upload request");
  assert_eq!(completed.status(), StatusCode::OK);
  assert_eq!(
    state
      .blob()
      .get_blob_metadata(workspace_id, &key)
      .await
      .expect("read completed metadata")
      .expect("completed metadata")
      .status,
    BlobStatus::Completed
  );
}

// ---------------------------------------------------------------------------
// Tests: create/initialize upload
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_blob_upload_initializes_and_marks_existing_complete_as_uploaded() {
  let (app, state, auth_store) = setup_test_app().await;
  let (user_id, session_id) = create_user_session(&auth_store, "owner@example.com").await;

  let workspace = state
    .workspace()
    .create_workspace(user_id, None, None)
    .await
    .expect("creating workspace should succeed");
  let workspace_id = workspace.id;
  let key = "docs/file.txt";

  let first = graphql(
    &app,
    session_id,
    create_blob_upload_payload(workspace_id, key, 12, "text/plain"),
  )
  .await;
  assert!(first.get("errors").is_none(), "unexpected graphql errors: {first}");
  assert_eq!(first["data"]["createBlobUpload"]["method"], "Graphql");
  assert_eq!(first["data"]["createBlobUpload"]["blobKey"], key);
  assert_eq!(first["data"]["createBlobUpload"]["alreadyUploaded"], false);

  state
    .blob()
    .complete_upload(workspace_id, key)
    .await
    .expect("completing blob upload should succeed");

  let second = graphql(
    &app,
    session_id,
    create_blob_upload_payload(workspace_id, key, 12, "text/plain"),
  )
  .await;
  assert!(second.get("errors").is_none(), "unexpected graphql errors: {second}");
  assert_eq!(second["data"]["createBlobUpload"]["alreadyUploaded"], true);
}

#[tokio::test]
async fn create_blob_upload_rejects_metadata_mismatch() {
  let (app, state, auth_store) = setup_test_app().await;
  let (user_id, session_id) = create_user_session(&auth_store, "owner2@example.com").await;

  let workspace = state
    .workspace()
    .create_workspace(user_id, None, None)
    .await
    .expect("creating workspace should succeed");
  let workspace_id = workspace.id;
  let key = "docs/mismatch.bin";

  let first = graphql(
    &app,
    session_id,
    create_blob_upload_payload(workspace_id, key, 128, "application/octet-stream"),
  )
  .await;
  assert!(first.get("errors").is_none(), "unexpected graphql errors: {first}");

  let mismatch = graphql(
    &app,
    session_id,
    create_blob_upload_payload(workspace_id, key, 256, "application/octet-stream"),
  )
  .await;
  assert!(
    mismatch.get("errors").is_some(),
    "expected graphql error, got: {mismatch}"
  );
  assert_eq!(mismatch["errors"][0]["extensions"]["name"], "INVALID_INPUT");
}

#[tokio::test]
async fn create_blob_upload_requires_workspace_blob_write_permission() {
  let (app, state, auth_store) = setup_test_app().await;
  let (owner_id, owner_session_id) = create_user_session(&auth_store, "owner3@example.com").await;
  let (_outsider_id, outsider_session_id) = create_user_session(&auth_store, "outsider@example.com").await;

  let workspace = state
    .workspace()
    .create_workspace(owner_id, None, None)
    .await
    .expect("creating workspace should succeed");
  let workspace_id = workspace.id;

  let owner_ok = graphql(
    &app,
    owner_session_id,
    create_blob_upload_payload(workspace_id, "docs/acl.txt", 1, "text/plain"),
  )
  .await;
  assert!(
    owner_ok.get("errors").is_none(),
    "owner request failed unexpectedly: {owner_ok}"
  );

  let outsider = graphql(
    &app,
    outsider_session_id,
    create_blob_upload_payload(workspace_id, "docs/acl.txt", 1, "text/plain"),
  )
  .await;
  assert!(
    outsider.get("errors").is_some(),
    "expected access error, got: {outsider}"
  );
  assert_eq!(outsider["errors"][0]["extensions"]["name"], "ACTION_FORBIDDEN");
}

#[tokio::test]
async fn set_blob_supports_legacy_single_part_upload_contract() {
  let (app, state, auth_store) = setup_test_app().await;
  let (owner_id, owner_session_id) = create_user_session(&auth_store, "owner4@example.com").await;
  let workspace = state
    .workspace()
    .create_workspace(owner_id, None, None)
    .await
    .expect("creating workspace should succeed");

  let payload = b"hello-single-part";
  let response =
    graphql_multipart_upload(&app, owner_session_id, workspace.id, "small.txt", "text/plain", payload).await;

  assert!(
    response.get("errors").is_none(),
    "unexpected graphql errors: {response}"
  );
  assert_eq!(response["data"]["setBlob"], "small.txt");

  let blob = state
    .blob()
    .get_blob(workspace.id, "small.txt")
    .await
    .expect("fetching uploaded blob should succeed");
  assert_eq!(blob.data, Bytes::copy_from_slice(payload));
  assert_eq!(blob.content_type.as_deref(), Some("text/plain"));
}

#[tokio::test]
async fn multipart_part_upload_url_flow_is_repeatable_and_tracks_etag() {
  let (app, state, auth_store) = setup_test_app().await;
  let (owner_id, owner_session_id) = create_user_session(&auth_store, "owner5@example.com").await;
  let workspace = state
    .workspace()
    .create_workspace(owner_id, None, None)
    .await
    .expect("creating workspace should succeed");
  let key = "video/large.bin";

  let init = graphql(
    &app,
    owner_session_id,
    create_blob_upload_payload(workspace.id, key, 10 * 1024 * 1024, "application/octet-stream"),
  )
  .await;
  assert!(init.get("errors").is_none(), "unexpected init errors: {init}");
  assert_eq!(init["data"]["createBlobUpload"]["method"], "Multipart");
  let upload_id = init["data"]["createBlobUpload"]["uploadId"]
    .as_str()
    .expect("createBlobUpload should return an uploadId")
    .to_string();

  let part_url_query = json!({
      "query": "query PartUrl($workspaceId: String!, $key: String!, $uploadId: String!, $partNumber: Int!) { workspace(id: $workspaceId) { blobUploadPartUrl(key: $key, uploadId: $uploadId, partNumber: $partNumber) { uploadUrl expiresAt } } }",
      "variables": {
          "workspaceId": workspace.id.to_string(),
          "key": key,
          "uploadId": upload_id,
          "partNumber": 1
      }
  });
  let part_url_response = graphql(&app, owner_session_id, part_url_query).await;
  assert!(
    part_url_response.get("errors").is_none(),
    "unexpected part url errors: {part_url_response}"
  );
  let upload_url = part_url_response["data"]["workspace"]["blobUploadPartUrl"]["uploadUrl"]
    .as_str()
    .expect("blobUploadPartUrl should return an uploadUrl")
    .to_string();

  let first_part = app
    .clone()
    .oneshot(
      Request::builder()
        .method("PUT")
        .uri(upload_url.clone())
        .body(Body::from(Vec::from("first-part-payload".as_bytes())))
        .expect("building first part PUT request should not fail"),
    )
    .await
    .expect("sending first part PUT request should not fail");
  assert_eq!(first_part.status(), StatusCode::OK);
  let first_etag = first_part
    .headers()
    .get("etag")
    .and_then(|v| v.to_str().ok())
    .expect("first part response should include an etag header")
    .to_string();

  let second_part = app
    .clone()
    .oneshot(
      Request::builder()
        .method("PUT")
        .uri(upload_url)
        .body(Body::from(Vec::from("updated-part-payload".as_bytes())))
        .expect("building second part PUT request should not fail"),
    )
    .await
    .expect("sending second part PUT request should not fail");
  assert_eq!(second_part.status(), StatusCode::OK);
  let second_etag = second_part
    .headers()
    .get("etag")
    .and_then(|v| v.to_str().ok())
    .expect("second part response should include an etag header")
    .to_string();
  assert_ne!(first_etag, second_etag);

  let resumed = graphql(
    &app,
    owner_session_id,
    create_blob_upload_payload(workspace.id, key, 10 * 1024 * 1024, "application/octet-stream"),
  )
  .await;
  assert!(resumed.get("errors").is_none(), "unexpected resumed errors: {resumed}");
  assert_eq!(resumed["data"]["createBlobUpload"]["method"], "Multipart");
  let uploaded_parts = resumed["data"]["createBlobUpload"]["uploadedParts"]
    .as_array()
    .expect("uploadedParts should be an array");
  assert_eq!(uploaded_parts.len(), 1);
  assert_eq!(uploaded_parts[0]["partNumber"], 1);
  assert_eq!(uploaded_parts[0]["etag"], second_etag);
}

#[tokio::test]
async fn complete_blob_upload_merges_parts_and_validates_order() {
  let (app, state, auth_store) = setup_test_app().await;
  let (owner_id, owner_session_id) = create_user_session(&auth_store, "owner6@example.com").await;
  let workspace = state
    .workspace()
    .create_workspace(owner_id, None, None)
    .await
    .expect("creating workspace should succeed");
  let key = "video/final.bin";

  let init = graphql(
    &app,
    owner_session_id,
    create_blob_upload_payload(workspace.id, key, 10 * 1024 * 1024, "application/octet-stream"),
  )
  .await;
  let upload_id = init["data"]["createBlobUpload"]["uploadId"]
    .as_str()
    .expect("createBlobUpload should return an uploadId for multipart flow")
    .to_string();

  let part1_url = graphql(
        &app,
        owner_session_id,
        json!({
            "query": "query PartUrl($workspaceId: String!, $key: String!, $uploadId: String!, $partNumber: Int!) { workspace(id: $workspaceId) { blobUploadPartUrl(key: $key, uploadId: $uploadId, partNumber: $partNumber) { uploadUrl } } }",
            "variables": {
                "workspaceId": workspace.id.to_string(),
                "key": key,
                "uploadId": upload_id,
                "partNumber": 1
            }
        }),
    )
    .await["data"]["workspace"]["blobUploadPartUrl"]["uploadUrl"]
        .as_str()
        .expect("blobUploadPartUrl should return an uploadUrl for part 1")
        .to_string();
  let part1 = app
    .clone()
    .oneshot(
      Request::builder()
        .method("PUT")
        .uri(part1_url)
        .body(Body::from(Vec::from("hello ".as_bytes())))
        .expect("building part 1 PUT request should not fail"),
    )
    .await
    .expect("sending part 1 PUT request should not fail");
  let etag1 = part1
    .headers()
    .get("etag")
    .and_then(|v| v.to_str().ok())
    .expect("part 1 response should include an etag header")
    .to_string();

  let part2_url = graphql(
        &app,
        owner_session_id,
        json!({
            "query": "query PartUrl($workspaceId: String!, $key: String!, $uploadId: String!, $partNumber: Int!) { workspace(id: $workspaceId) { blobUploadPartUrl(key: $key, uploadId: $uploadId, partNumber: $partNumber) { uploadUrl } } }",
            "variables": {
                "workspaceId": workspace.id.to_string(),
                "key": key,
                "uploadId": upload_id,
                "partNumber": 2
            }
        }),
    )
    .await["data"]["workspace"]["blobUploadPartUrl"]["uploadUrl"]
        .as_str()
        .expect("blobUploadPartUrl should return an uploadUrl for part 2")
        .to_string();
  let part2 = app
    .clone()
    .oneshot(
      Request::builder()
        .method("PUT")
        .uri(part2_url)
        .body(Body::from(Vec::from("world".as_bytes())))
        .expect("building part 2 PUT request should not fail"),
    )
    .await
    .expect("sending part 2 PUT request should not fail");
  let etag2 = part2
    .headers()
    .get("etag")
    .and_then(|v| v.to_str().ok())
    .expect("part 2 response should include an etag header")
    .to_string();

  let complete = graphql(
        &app,
        owner_session_id,
        json!({
            "query": "mutation Complete($workspaceId: String!, $key: String!, $uploadId: String!, $parts: [BlobUploadPartInput!]) { completeBlobUpload(workspaceId: $workspaceId, key: $key, uploadId: $uploadId, parts: $parts) }",
            "variables": {
                "workspaceId": workspace.id.to_string(),
                "key": key,
                "uploadId": upload_id,
                "parts": [
                    {"partNumber": 1, "etag": etag1},
                    {"partNumber": 2, "etag": etag2}
                ]
            }
        }),
    )
    .await;
  assert!(complete.get("errors").is_none(), "complete upload failed: {complete}");
  assert_eq!(complete["data"]["completeBlobUpload"], key);

  let blob = state
    .blob()
    .get_blob(workspace.id, key)
    .await
    .expect("fetching completed multipart blob should succeed");
  assert_eq!(blob.data, Bytes::copy_from_slice(b"hello world"));

  let bad = graphql(
        &app,
        owner_session_id,
        json!({
            "query": "mutation Complete($workspaceId: String!, $key: String!, $uploadId: String!, $parts: [BlobUploadPartInput!]) { completeBlobUpload(workspaceId: $workspaceId, key: $key, uploadId: $uploadId, parts: $parts) }",
            "variables": {
                "workspaceId": workspace.id.to_string(),
                "key": key,
                "uploadId": upload_id,
                "parts": [
                    {"partNumber": 2, "etag": "\"x\""}
                ]
            }
        }),
    )
    .await;
  assert!(
    bad.get("errors").is_none(),
    "completed uploads should be idempotent: {bad}"
  );
}

#[tokio::test]
async fn abort_blob_upload_cleans_parts_and_prevents_completion() {
  let (app, _state, auth_store) = setup_test_app().await;
  let (owner_id, owner_session_id) = create_user_session(&auth_store, "owner7@example.com").await;
  let _ = owner_id;
  // create workspace through mutation to ensure ACL links are present
  let ws = graphql(
    &app,
    owner_session_id,
    json!({"query":"mutation { createWorkspace { id } }"}),
  )
  .await;
  let ws_id = ws["data"]["createWorkspace"]["id"]
    .as_str()
    .expect("createWorkspace should return an id")
    .to_string();

  let init = graphql(
        &app,
        owner_session_id,
        json!({
            "query": "mutation Create($workspaceId: String!, $key: String!, $size: Int!, $mime: String!) { createBlobUpload(workspaceId: $workspaceId, key: $key, size: $size, mime: $mime) { uploadId } }",
            "variables": {
                "workspaceId": ws_id,
                "key": "video/abort.bin",
                "size": 10 * 1024 * 1024,
                "mime": "application/octet-stream"
            }
        }),
    )
    .await;
  let upload_id = init["data"]["createBlobUpload"]["uploadId"]
    .as_str()
    .expect("createBlobUpload should return an uploadId before abort")
    .to_string();

  let aborted = graphql(
        &app,
        owner_session_id,
        json!({
            "query": "mutation Abort($workspaceId: String!, $key: String!, $uploadId: String!) { abortBlobUpload(workspaceId: $workspaceId, key: $key, uploadId: $uploadId) }",
            "variables": {
                "workspaceId": ws_id,
                "key": "video/abort.bin",
                "uploadId": upload_id
            }
        }),
    )
    .await;
  assert!(aborted.get("errors").is_none(), "abort failed: {aborted}");
  assert_eq!(aborted["data"]["abortBlobUpload"], true);

  let complete = graphql(
        &app,
        owner_session_id,
        json!({
            "query": "mutation Complete($workspaceId: String!, $key: String!, $uploadId: String!) { completeBlobUpload(workspaceId: $workspaceId, key: $key, uploadId: $uploadId) }",
            "variables": {
                "workspaceId": ws_id,
                "key": "video/abort.bin",
                "uploadId": upload_id
            }
        }),
    )
    .await;
  assert!(
    complete.get("errors").is_some(),
    "completion should fail after abort: {complete}"
  );
}

// ---------------------------------------------------------------------------
// P83-K-03: Error-path tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_blob_upload_unauthenticated_returns_error() {
  let (app, _, _) = setup_test_app().await;
  let ws_id = Uuid::new_v4();

  let resp = graphql(
    &app,
    Uuid::nil(),
    create_blob_upload_payload(ws_id, "secret.txt", 1, "text/plain"),
  )
  .await;

  let is_error = resp.get("errors").is_some() || resp["data"]["createBlobUpload"].is_null() || resp["data"].is_null();
  assert!(is_error, "unauthenticated blob upload must fail, got: {resp}");
}

#[tokio::test]
async fn inv_blob_upload_non_member_returns_action_forbidden() {
  let (app, state, auth_store) = setup_test_app().await;
  let (owner_id, _) = create_user_session(&auth_store, "bk03_owner@example.com").await;
  let (_other_id, other_session) = create_user_session(&auth_store, "bk03_other@example.com").await;
  let workspace = state
    .workspace()
    .create_workspace(owner_id, None, None)
    .await
    .expect("creating workspace should succeed");

  let resp = graphql(
    &app,
    other_session,
    create_blob_upload_payload(workspace.id, "file.txt", 1, "text/plain"),
  )
  .await;

  assert!(
    resp.get("errors").is_some(),
    "non-member upload must return error, got: {resp}"
  );
  assert_eq!(resp["errors"][0]["extensions"]["name"], "ACTION_FORBIDDEN");
}

// ---------------------------------------------------------------------------
// T02-F-04 — inv_blob_upload_empty_content_type_handled_gracefully
//
// Invariant: uploading a blob whose multipart file part has no Content-Type
// header must not corrupt the MIME stored in the backend. The server must
// either reject the upload (4xx) or normalise to a safe default
// ("application/octet-stream"). An empty/null MIME in storage is never allowed.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_blob_upload_empty_content_type_handled_gracefully() {
  let (app, state, auth_store) = setup_test_app().await;
  let (owner_id, owner_session_id) = create_user_session(&auth_store, "t02f04_owner@example.com").await;
  let workspace = state
    .workspace()
    .create_workspace(owner_id, None, None)
    .await
    .expect("T02-F-04: creating workspace should succeed");

  // Build a multipart request for setBlob with NO Content-Type on the file part.
  let boundary = "X-BOUNDARY-T02F04";
  let operations = json!({
    "query": "mutation SetBlob($workspaceId: String!, $blob: Upload!) { setBlob(workspaceId: $workspaceId, blob: $blob) }",
    "variables": { "workspaceId": workspace.id.to_string(), "blob": null }
  })
  .to_string();
  let map = json!({ "0": ["variables.blob"] }).to_string();

  let mut body: Vec<u8> = Vec::new();
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"operations\"\r\n\r\n");
  body.extend_from_slice(operations.as_bytes());
  body.extend_from_slice(b"\r\n");

  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"map\"\r\n\r\n");
  body.extend_from_slice(map.as_bytes());
  body.extend_from_slice(b"\r\n");

  // File part: deliberately omit Content-Type header.
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"0\"; filename=\"no-type.bin\"\r\n\r\n");
  body.extend_from_slice(b"binary-payload");
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .header("cookie", format!("affine_session={owner_session_id}"))
        .body(Body::from(body))
        .expect("T02-F-04: building multipart request should not fail"),
    )
    .await
    .expect("T02-F-04: sending multipart request should not fail");

  let bytes = response
    .into_body()
    .collect()
    .await
    .expect("T02-F-04: collecting response body should not fail")
    .to_bytes();
  let resp: Value = serde_json::from_slice(&bytes).expect("T02-F-04: response must be valid JSON");

  if resp.get("errors").is_some() {
    // Rejection is acceptable — invariant satisfied by preventing corrupt MIME.
    return;
  }

  // If accepted: verify the stored MIME is a non-empty safe default.
  let blob = state
    .blob()
    .get_blob(workspace.id, "no-type.bin")
    .await
    .expect("T02-F-04: fetching uploaded blob should succeed");
  let stored_mime = blob.content_type.as_deref().unwrap_or("");
  assert!(
    !stored_mime.is_empty(),
    "T02-F-04: stored MIME must not be empty when Content-Type is omitted, got empty string"
  );
  assert_eq!(
    stored_mime, "application/octet-stream",
    "T02-F-04: missing Content-Type must normalise to application/octet-stream, got: {stored_mime:?}"
  );
}
