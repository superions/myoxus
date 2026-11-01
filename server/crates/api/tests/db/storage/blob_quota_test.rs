// SPDX-License-Identifier: AGPL-3.0-or-later
//! Blob quota and size-limit enforcement tests.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use axum::{body::Body, http::Request};
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

// ---------------------------------------------------------------------------
// Tests: max upload size enforcement
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_blob_upload_respects_configured_max_upload_size() {
  let mut config = AppConfig::load().expect("AppConfig should load successfully");
  config.storage.max_upload_mb = 0; // 0 MB = 0 bytes
  let (app, state, auth_store) = setup_test_app_with_config(config).await;
  let (owner_id, owner_session_id) = create_user_session(&auth_store, "owner9@example.com").await;
  let workspace = state
    .workspace()
    .create_workspace(owner_id, None, None)
    .await
    .expect("creating workspace should succeed");

  let too_large = graphql(
    &app,
    owner_session_id,
    create_blob_upload_payload(workspace.id, "docs/large.bin", 17, "application/octet-stream"),
  )
  .await;
  assert!(
    too_large.get("errors").is_some(),
    "expected upload limit error, got: {too_large}"
  );
  assert_eq!(too_large["errors"][0]["extensions"]["name"], "INVALID_INPUT");
}
