// SPDX-License-Identifier: AGPL-3.0-or-later
//! Blob download and REST endpoint tests — MIME preservation, unicode filenames,
//! list/delete/release lifecycle, ACL enforcement.

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

// ---------------------------------------------------------------------------
// Tests: list, delete, release, ACL
// ---------------------------------------------------------------------------

#[tokio::test]
async fn workspace_blob_list_delete_and_release_contracts_work() {
  let (app, state, auth_store) = setup_test_app().await;
  let (owner_id, owner_session_id) = create_user_session(&auth_store, "owner10@example.com").await;
  let workspace = state
    .workspace()
    .create_workspace(owner_id, None, None)
    .await
    .expect("creating workspace should succeed");

  let upload = graphql_multipart_upload(
    &app,
    owner_session_id,
    workspace.id,
    "listed.txt",
    "text/plain",
    b"blob-list-payload",
  )
  .await;
  assert!(upload.get("errors").is_none(), "setBlob failed unexpectedly: {upload}");

  let list_before = graphql(
        &app,
        owner_session_id,
        json!({
            "query": "query List($workspaceId: String!) { workspace(id: $workspaceId) { blobs { key size mime createdAt } blobsSize quota { blobLimit humanReadable { blobLimit } } } }",
            "variables": { "workspaceId": workspace.id.to_string() }
        }),
    )
    .await;
  assert!(list_before.get("errors").is_none(), "listBlobs failed: {list_before}");
  assert_eq!(
    list_before["data"]["workspace"]["blobs"]
      .as_array()
      .expect("workspace blobs field should be an array")
      .len(),
    1
  );
  assert_eq!(list_before["data"]["workspace"]["blobs"][0]["key"], "listed.txt");
  assert_eq!(list_before["data"]["workspace"]["blobsSize"], 17);
  assert!(
    list_before["data"]["workspace"]["quota"]["blobLimit"]
      .as_i64()
      .unwrap_or_default()
      > 0
  );

  let soft_deleted = graphql(
        &app,
        owner_session_id,
        json!({
            "query": "mutation Del($workspaceId: String!, $key: String!) { deleteBlob(workspaceId: $workspaceId, key: $key) }",
            "variables": { "workspaceId": workspace.id.to_string(), "key": "listed.txt" }
        }),
    )
    .await;
  assert!(
    soft_deleted.get("errors").is_none(),
    "deleteBlob failed: {soft_deleted}"
  );
  assert_eq!(soft_deleted["data"]["deleteBlob"], true);

  let list_after_delete = graphql(
    &app,
    owner_session_id,
    json!({
        "query": "query List($workspaceId: String!) { workspace(id: $workspaceId) { blobs { key } blobsSize } }",
        "variables": { "workspaceId": workspace.id.to_string() }
    }),
  )
  .await;
  assert!(
    list_after_delete.get("errors").is_none(),
    "list after delete failed: {list_after_delete}"
  );
  assert_eq!(
    list_after_delete["data"]["workspace"]["blobs"]
      .as_array()
      .expect("workspace blobs field should be an array after delete")
      .len(),
    0
  );
  assert_eq!(list_after_delete["data"]["workspace"]["blobsSize"], 0);

  let released = graphql(
    &app,
    owner_session_id,
    json!({
        "query": "mutation Release($workspaceId: String!) { releaseDeletedBlobs(workspaceId: $workspaceId) }",
        "variables": { "workspaceId": workspace.id.to_string() }
    }),
  )
  .await;
  assert!(
    released.get("errors").is_none(),
    "releaseDeletedBlobs failed: {released}"
  );
  assert_eq!(released["data"]["releaseDeletedBlobs"], true);
}

#[tokio::test]
async fn workspace_blobs_enforce_acl_and_delete_accepts_deprecated_hash_arg() {
  let (app, state, auth_store) = setup_test_app().await;
  let (owner_id, owner_session_id) = create_user_session(&auth_store, "owner11@example.com").await;
  let (_outsider_id, outsider_session_id) = create_user_session(&auth_store, "outsider11@example.com").await;
  let workspace = state
    .workspace()
    .create_workspace(owner_id, None, None)
    .await
    .expect("creating workspace should succeed");

  let upload = graphql_multipart_upload(
    &app,
    owner_session_id,
    workspace.id,
    "legacy-hash.txt",
    "text/plain",
    b"hash-compat",
  )
  .await;
  assert!(upload.get("errors").is_none(), "setBlob failed unexpectedly: {upload}");

  let outsider_list = graphql(
    &app,
    outsider_session_id,
    json!({
        "query": "query List($workspaceId: String!) { workspace(id: $workspaceId) { blobs { key } } }",
        "variables": { "workspaceId": workspace.id.to_string() }
    }),
  )
  .await;
  assert!(
    outsider_list.get("errors").is_some(),
    "outsider must not list blobs: {outsider_list}"
  );
  assert_eq!(outsider_list["errors"][0]["extensions"]["name"], "ACTION_FORBIDDEN");

  let legacy_delete = graphql(
        &app,
        owner_session_id,
        json!({
            "query": "mutation Del($workspaceId: String!, $hash: String!) { deleteBlob(workspaceId: $workspaceId, hash: $hash) }",
            "variables": { "workspaceId": workspace.id.to_string(), "hash": "legacy-hash.txt" }
        }),
    )
    .await;
  assert!(
    legacy_delete.get("errors").is_none(),
    "legacy delete failed: {legacy_delete}"
  );
  assert_eq!(legacy_delete["data"]["deleteBlob"], true);
}

// ---------------------------------------------------------------------------
// Tests: MIME type preservation (SVG-H0 regression)
// ---------------------------------------------------------------------------

/// SVG-H0 regression: blob download must return the DB-stored MIME type,
/// not fall back to application/octet-stream (which breaks SVG rendering
/// for User B in shared workspaces).
#[tokio::test]
async fn blob_download_preserves_mime_type_from_db() {
  let (app, state, auth_store) = setup_test_app().await;
  let (owner_id, owner_session_id) = create_user_session(&auth_store, "mime-owner@example.com").await;
  let workspace = state
    .workspace()
    .create_workspace(owner_id, None, None)
    .await
    .expect("creating workspace should succeed");

  let svg_payload = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"10\"/></svg>";
  let upload = graphql_multipart_upload(
    &app,
    owner_session_id,
    workspace.id,
    "diagram.svg",
    "image/svg+xml",
    svg_payload,
  )
  .await;
  assert!(upload.get("errors").is_none(), "SVG upload failed: {upload}");

  let blob = state
    .blob()
    .get_blob(workspace.id, "diagram.svg")
    .await
    .expect("fetching SVG blob should succeed");
  assert_eq!(
    blob.content_type.as_deref(),
    Some("image/svg+xml"),
    "SVG blob must preserve image/svg+xml MIME, got {:?}",
    blob.content_type
  );

  let pdf_payload = b"%PDF-1.4 fake";
  let upload_pdf = graphql_multipart_upload(
    &app,
    owner_session_id,
    workspace.id,
    "report.pdf",
    "application/pdf",
    pdf_payload,
  )
  .await;
  assert!(upload_pdf.get("errors").is_none(), "PDF upload failed: {upload_pdf}");

  let pdf_blob = state
    .blob()
    .get_blob(workspace.id, "report.pdf")
    .await
    .expect("fetching PDF blob should succeed");
  assert_eq!(
    pdf_blob.content_type.as_deref(),
    Some("application/pdf"),
    "PDF blob must preserve application/pdf MIME, got {:?}",
    pdf_blob.content_type
  );
}

/// Existing stored MIME values must not turn full or ranged downloads into
/// executable application-origin documents; ordinary media previews stay inline.
#[tokio::test]
async fn blob_download_isolates_active_content_and_preserves_media() {
  let (app, state, auth_store) = setup_test_app().await;
  let (owner_id, session_id) = create_user_session(&auth_store, "download-isolation@example.com").await;
  let workspace = state.workspace().create_workspace(owner_id, None, None).await.unwrap();
  for (index, mime, disposition) in [
    (0, "text/html; charset=utf-8", "attachment"),
    (1, "image/svg+xml", "inline"),
    (2, "application/xhtml+xml", "attachment"),
    (3, "image/png", "inline"),
    (4, "application/pdf", "inline"),
    (5, "audio/mpeg", "inline"),
    (6, "video/mp4", "inline"),
  ] {
    let key = format!("isolation-{index}");
    // Seed storage directly: this also covers pre-existing files and misleading MIME.
    state
      .blob()
      .upload_single_part_blob(
        workspace.id,
        &key,
        Bytes::from_static(b"<script>bad()</script>"),
        mime,
        Some(mime.to_string()),
        None,
      )
      .await
      .unwrap();
    for ranged in [false, true] {
      let mut request = Request::builder()
        .uri(format!("/api/workspaces/{}/blobs/{key}", workspace.id))
        .header("cookie", format!("affine_session={session_id}"));
      if ranged {
        request = request.header("range", "bytes=0-7");
      }
      let response = app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
      assert_eq!(
        response.status(),
        if ranged {
          StatusCode::PARTIAL_CONTENT
        } else {
          StatusCode::OK
        }
      );
      assert_eq!(response.headers()["content-type"], mime);
      assert_eq!(response.headers()["content-security-policy"], "sandbox allow-downloads");
      assert_eq!(response.headers()["x-content-type-options"], "nosniff");
      assert_eq!(
        response.headers()["content-disposition"],
        format!("{disposition}; filename=\"{key}\"")
      );
      let body = response.into_body().collect().await.unwrap().to_bytes();
      assert_eq!(
        body.as_ref(),
        if ranged {
          &b"<script>"[..]
        } else {
          &b"<script>bad()</script>"[..]
        }
      );
    }
  }
}

/// SVG-H1 regression: blob download must not 500 on non-ASCII filenames.
#[tokio::test]
async fn blob_download_handles_unicode_filename() {
  let (app, state, auth_store) = setup_test_app().await;
  let (owner_id, owner_session_id) = create_user_session(&auth_store, "unicode-owner@example.com").await;
  let workspace = state
    .workspace()
    .create_workspace(owner_id, None, None)
    .await
    .expect("creating workspace should succeed");

  let upload = graphql_multipart_upload(
    &app,
    owner_session_id,
    workspace.id,
    "diagramm-übersicht.svg",
    "image/svg+xml",
    b"<svg/>",
  )
  .await;
  assert!(
    upload.get("errors").is_none(),
    "upload with unicode name failed: {upload}"
  );

  let cookie = format!("affine_session={}", owner_session_id);
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!(
          "/api/workspaces/{}/blobs/{}",
          workspace.id, "diagramm-übersicht.svg"
        ))
        .header("Cookie", &cookie)
        .body(Body::empty())
        .expect("building blob download request should not fail"),
    )
    .await
    .expect("sending blob download request should not fail");

  assert_ne!(
    response.status(),
    StatusCode::INTERNAL_SERVER_ERROR,
    "unicode filename must not cause 500"
  );
}
