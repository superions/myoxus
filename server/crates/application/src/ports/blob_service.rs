//! Blob upload/download application service.
//!
//! [`BlobService`] orchestrates metadata bookkeeping (via [`BlobStore`]) and
//! object-storage I/O (via [`BlobStoragePort`]). It handles single-part and
//! multi-part uploads, HMAC-SHA256 signed URL generation and verification,
//! comment-attachment linking, soft-delete, and retention-based garbage
//! collection.

use crate::auth::{AuthError, AuthResult};
use crate::ports::blob::{BlobGcCandidate, BlobKey, BlobMetadata, BlobStatus, BlobStore, MultipartUploadedPart};
use crate::ports::{BlobPathWriteRequest, BlobStoragePort, BlobWriteRequest};
use base64::Engine;
use bytes::Bytes;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Constant-time byte comparison to prevent timing side-channel attacks
/// on HMAC token verification (APP-RV-02).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
  if a.len() != b.len() {
    return false;
  }
  let mut diff = 0u8;
  for (x, y) in a.iter().zip(b.iter()) {
    diff |= x ^ y;
  }
  diff == 0
}
use tracing::{debug, error, info, instrument, trace, warn};

/// Operation materialization does not transfer catalog ownership.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationBlobOwnership {
  Reused,
  OperationOwned,
  Committed,
}

impl OperationBlobOwnership {
  /// Receipt uncertainty must retain bytes, even if a SQL ACK was lost.
  pub fn may_compensate(self, receipt_proves_unpublished: bool) -> bool {
    self == Self::OperationOwned && receipt_proves_unpublished
  }
}

/// Exact byte proof consumed by the existing transfer publisher/compensator.
/// Comment attachments bind their `storage_key` in the Blob owner, not `doc_id`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OperationBlobMaterialization {
  pub operation_id: uuid::Uuid,
  pub resource: myoxus_domain::workspace_content_operation::WorkspaceContentResourceRef,
  pub object_key: String,
  pub sha256: String,
  pub size_bytes: u64,
  pub content_type: String,
  pub ownership: OperationBlobOwnership,
}

/// Shared exact-byte check; staging callers retain their existing error code.
pub fn verify_operation_blob_bytes(data: &[u8], expected_sha256: &str, expected_size: u64) -> AuthResult<()> {
  if data.len() as u64 != expected_size || hex::encode(Sha256::digest(data)) != expected_sha256 {
    return Err(AuthError::InvalidInput(
      myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode::StagingReplayConflict
        .as_str()
        .into(),
    ));
  }
  Ok(())
}

use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

pub struct BlobService {
  store: Arc<dyn BlobStore>,
  storage: Arc<dyn BlobStoragePort>,
  sign_key: String,
}

pub struct MultipartPartUploadSignature<'a> {
  pub path: &'a str,
  pub workspace_id: Uuid,
  pub key: &'a str,
  pub upload_id: &'a str,
  pub part_number: i32,
  pub expires_at: i64,
  pub token: &'a str,
}

/// Signed account-scoped workspace-import part. Unlike ordinary blobs, this
/// namespace has no workspace id because the target does not exist yet.
pub struct WorkspaceImportPartUploadSignature<'a> {
  pub path: &'a str,
  pub actor_id: Uuid,
  pub import_id: Uuid,
  pub part_number: i32,
  pub size_bytes: i64,
  pub content_hash: &'a str,
  pub expires_at: i64,
  pub token: &'a str,
}

impl BlobService {
  pub fn new(store: Arc<dyn BlobStore>, storage: Arc<dyn BlobStoragePort>, sign_key: String) -> Self {
    Self {
      store,
      storage,
      sign_key,
    }
  }

  fn parse_key(&self, key: &str) -> AuthResult<BlobKey> {
    BlobKey::parse(key).map_err(|msg| {
      warn!(key, error = %msg, "blob key validation failed");
      AuthError::Storage(format!("invalid blob key: {msg}"))
    })
  }

  /// Signs a canonical string for upload validation (Parity with Legacy verifyToken)
  pub fn sign_upload(&self, path: &str, fields: &[&str], exp: i64) -> String {
    trace!(path, exp, fields_count = fields.len(), "signing upload token");
    let mut canonical = vec![path.to_string()];
    canonical.extend(fields.iter().map(|s| s.to_string()));
    canonical.push(exp.to_string());

    let data = canonical.join("\n");
    let mut mac = HmacSha256::new_from_slice(self.sign_key.as_bytes()).expect("HMAC can take key of any size");
    mac.update(data.as_bytes());
    let result = mac.finalize();
    let code = base64::engine::general_purpose::STANDARD.encode(result.into_bytes());
    format!("{}-{}", exp, code)
  }

  /// Verifies an upload token (Parity with Legacy verifyToken)
  pub fn verify_token(&self, path: &str, fields: &[&str], token: &str) -> bool {
    trace!(path, fields_count = fields.len(), "verifying signed token");
    let parts: Vec<&str> = token.split('-').collect();
    if parts.len() != 2 {
      return false;
    }

    let exp_str = parts[0];
    let exp: i64 = exp_str.parse().unwrap_or(0);

    if exp < chrono::Utc::now().timestamp() {
      return false;
    }

    let expected = self.sign_upload(path, fields, exp);
    // APP-RV-02: constant-time comparison to prevent timing side-channel attacks
    constant_time_eq(expected.as_bytes(), token.as_bytes())
  }

  fn sign_blob_action(&self, action: &str, path: &str, fields: &[&str], exp: i64) -> String {
    let mut action_fields = vec![action];
    action_fields.extend(fields.iter().copied());
    self.sign_upload(path, &action_fields, exp)
  }

  fn verify_blob_action_token(
    &self,
    action: &str,
    path: &str,
    fields: &[&str],
    expires_at: i64,
    token: &str,
    now_ts: i64,
  ) -> bool {
    if expires_at < now_ts {
      return false;
    }
    let expected = self.sign_blob_action(action, path, fields, expires_at);
    constant_time_eq(expected.as_bytes(), token.as_bytes())
  }

  fn append_query(base_path: &str, query: &str) -> String {
    if base_path.contains('?') {
      format!("{base_path}&{query}")
    } else {
      format!("{base_path}?{query}")
    }
  }

  pub fn create_signed_upload_url(
    &self,
    base_path: &str,
    workspace_id: Uuid,
    key: &str,
    ttl_seconds: u64,
  ) -> AuthResult<String> {
    let parsed_key = self.parse_key(key)?;
    let expires_at = chrono::Utc::now().timestamp() + ttl_seconds as i64;
    let fields = [&workspace_id.to_string()[..], parsed_key.as_str()];
    let token = self.sign_blob_action("upload", base_path, &fields, expires_at);
    let query = format!(
      "workspaceId={}&key={}&expires={}&token={}",
      workspace_id,
      urlencoding::encode(parsed_key.as_str()),
      expires_at,
      urlencoding::encode(&token),
    );
    let signed = Self::append_query(base_path, &query);
    info!(%workspace_id, key = %parsed_key.as_str(), ttl_seconds, "created signed upload url");
    Ok(signed)
  }

  pub fn create_signed_download_url(
    &self,
    base_path: &str,
    workspace_id: Uuid,
    key: &str,
    ttl_seconds: u64,
  ) -> AuthResult<String> {
    let parsed_key = self.parse_key(key)?;
    let expires_at = chrono::Utc::now().timestamp() + ttl_seconds as i64;
    let fields = [&workspace_id.to_string()[..], parsed_key.as_str()];
    let token = self.sign_blob_action("download", base_path, &fields, expires_at);
    let query = format!(
      "workspaceId={}&key={}&expires={}&token={}",
      workspace_id,
      urlencoding::encode(parsed_key.as_str()),
      expires_at,
      urlencoding::encode(&token),
    );
    let signed = Self::append_query(base_path, &query);
    info!(%workspace_id, key = %parsed_key.as_str(), ttl_seconds, "created signed download url");
    Ok(signed)
  }

  pub fn create_signed_multipart_part_upload_url(
    &self,
    base_path: &str,
    workspace_id: Uuid,
    key: &str,
    upload_id: &str,
    part_number: i32,
    ttl_seconds: u64,
  ) -> AuthResult<String> {
    let parsed_key = self.parse_key(key)?;
    let expires_at = chrono::Utc::now().timestamp() + ttl_seconds as i64;
    let workspace_str = workspace_id.to_string();
    let part_str = part_number.to_string();
    let fields = [
      workspace_str.as_str(),
      parsed_key.as_str(),
      upload_id,
      part_str.as_str(),
    ];
    let token = self.sign_blob_action("upload-part", base_path, &fields, expires_at);
    let query = format!(
      "workspaceId={}&key={}&uploadId={}&partNumber={}&expires={}&token={}",
      workspace_id,
      urlencoding::encode(parsed_key.as_str()),
      urlencoding::encode(upload_id),
      part_number,
      expires_at,
      urlencoding::encode(&token),
    );
    let signed = Self::append_query(base_path, &query);
    info!(
        %workspace_id,
        key = %parsed_key.as_str(),
        upload_id,
        part_number,
        ttl_seconds,
        "created signed multipart part upload url"
    );
    Ok(signed)
  }

  #[expect(
    clippy::too_many_arguments,
    reason = "the signed upload boundary keeps every authenticated scope component explicit"
  )]
  pub fn create_signed_workspace_import_part_upload_url(
    &self,
    base_path: &str,
    actor_id: Uuid,
    import_id: Uuid,
    part_number: i32,
    size_bytes: i64,
    content_hash: &str,
    ttl_seconds: u64,
  ) -> AuthResult<String> {
    if part_number < 1
      || size_bytes < 1
      || content_hash.len() != 64
      || !content_hash.bytes().all(|b| b.is_ascii_hexdigit())
    {
      return Err(AuthError::InvalidInput(
        "workspace import part manifest is invalid".to_string(),
      ));
    }
    let expires_at = chrono::Utc::now().timestamp() + ttl_seconds as i64;
    let actor = actor_id.to_string();
    let import = import_id.to_string();
    let part = part_number.to_string();
    let size = size_bytes.to_string();
    let fields = [
      actor.as_str(),
      import.as_str(),
      part.as_str(),
      size.as_str(),
      content_hash,
    ];
    let token = self.sign_blob_action("workspace-import-part", base_path, &fields, expires_at);
    let query = format!(
      "actorId={actor_id}&importId={import_id}&partNumber={part_number}&sizeBytes={size_bytes}&contentHash={}&expires={expires_at}&token={}",
      urlencoding::encode(content_hash),
      urlencoding::encode(&token),
    );
    Ok(Self::append_query(base_path, &query))
  }

  pub fn verify_signed_upload_url(
    &self,
    path: &str,
    workspace_id: Uuid,
    key: &str,
    expires_at: i64,
    token: &str,
  ) -> bool {
    let parsed_key = match BlobKey::parse(key) {
      Ok(v) => v,
      Err(_) => return false,
    };
    let fields = [&workspace_id.to_string()[..], parsed_key.as_str()];
    self.verify_blob_action_token(
      "upload",
      path,
      &fields,
      expires_at,
      token,
      chrono::Utc::now().timestamp(),
    )
  }

  pub fn verify_signed_download_url(
    &self,
    path: &str,
    workspace_id: Uuid,
    key: &str,
    expires_at: i64,
    token: &str,
  ) -> bool {
    let parsed_key = match BlobKey::parse(key) {
      Ok(v) => v,
      Err(_) => return false,
    };
    let fields = [&workspace_id.to_string()[..], parsed_key.as_str()];
    self.verify_blob_action_token(
      "download",
      path,
      &fields,
      expires_at,
      token,
      chrono::Utc::now().timestamp(),
    )
  }

  pub fn verify_signed_multipart_part_upload_url(&self, signature: MultipartPartUploadSignature<'_>) -> bool {
    let parsed_key = match BlobKey::parse(signature.key) {
      Ok(v) => v,
      Err(_) => return false,
    };
    let workspace_str = signature.workspace_id.to_string();
    let part_str = signature.part_number.to_string();
    let fields = [
      workspace_str.as_str(),
      parsed_key.as_str(),
      signature.upload_id,
      part_str.as_str(),
    ];
    self.verify_blob_action_token(
      "upload-part",
      signature.path,
      &fields,
      signature.expires_at,
      signature.token,
      chrono::Utc::now().timestamp(),
    )
  }

  pub fn verify_signed_workspace_import_part_upload_url(
    &self,
    signature: WorkspaceImportPartUploadSignature<'_>,
  ) -> bool {
    if signature.part_number < 1
      || signature.size_bytes < 1
      || signature.content_hash.len() != 64
      || !signature.content_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
      return false;
    }
    let actor = signature.actor_id.to_string();
    let import = signature.import_id.to_string();
    let part = signature.part_number.to_string();
    let size = signature.size_bytes.to_string();
    let fields = [
      actor.as_str(),
      import.as_str(),
      part.as_str(),
      size.as_str(),
      signature.content_hash,
    ];
    self.verify_blob_action_token(
      "workspace-import-part",
      signature.path,
      &fields,
      signature.expires_at,
      signature.token,
      chrono::Utc::now().timestamp(),
    )
  }

  #[instrument(skip(self))]
  pub async fn initialize_upload(
    &self,
    workspace_id: Uuid,
    key: &str,
    size: u64,
    mime: &str,
  ) -> AuthResult<BlobMetadata> {
    self
      .initialize_upload_with_metadata(workspace_id, key, size, mime, None)
      .await
  }

  #[instrument(skip(self))]
  pub async fn get_blob_metadata(&self, workspace_id: Uuid, key: &str) -> AuthResult<Option<BlobMetadata>> {
    let parsed_key = self.parse_key(key)?;
    debug!(%workspace_id, key = %parsed_key.as_str(), "fetching blob metadata");
    self.store.get_blob_metadata(workspace_id, &parsed_key).await
  }

  #[instrument(skip(self))]
  pub async fn prepare_multipart_upload(
    &self,
    workspace_id: Uuid,
    key: &str,
    size: u64,
    mime: &str,
  ) -> AuthResult<(String, Vec<MultipartUploadedPart>)> {
    let parsed_key = self.parse_key(key)?;
    if let Some(existing) = self.store.get_blob_metadata(workspace_id, &parsed_key).await? {
      if existing.size != size {
        return Err(AuthError::InvalidInput("Blob size mismatch".to_string()));
      }
      if existing.mime != mime {
        return Err(AuthError::InvalidInput("Blob mime mismatch".to_string()));
      }
      if existing.status == BlobStatus::Completed {
        return Err(AuthError::InvalidInput("Blob already completed".to_string()));
      }

      let upload_id = existing.upload_id.unwrap_or_else(|| Uuid::new_v4().to_string());
      self.store.set_upload_id(workspace_id, &parsed_key, &upload_id).await?;
      let parts = self
        .store
        .list_multipart_parts(workspace_id, &parsed_key, &upload_id)
        .await?;
      return Ok((upload_id, parts));
    }

    self
      .store
      .create_blob_metadata(workspace_id, &parsed_key, size, mime, None)
      .await?;
    let upload_id = Uuid::new_v4().to_string();
    self.store.set_upload_id(workspace_id, &parsed_key, &upload_id).await?;
    Ok((upload_id, Vec::new()))
  }

  #[instrument(skip(self))]
  pub async fn upsert_multipart_part(
    &self,
    workspace_id: Uuid,
    key: &str,
    upload_id: &str,
    part_number: i32,
    etag: &str,
  ) -> AuthResult<()> {
    let parsed_key = self.parse_key(key)?;
    self
      .store
      .upsert_multipart_part(workspace_id, &parsed_key, upload_id, part_number, etag)
      .await
  }

  #[instrument(skip(self))]
  pub async fn list_multipart_parts(
    &self,
    workspace_id: Uuid,
    key: &str,
    upload_id: &str,
  ) -> AuthResult<Vec<MultipartUploadedPart>> {
    let parsed_key = self.parse_key(key)?;
    self
      .store
      .list_multipart_parts(workspace_id, &parsed_key, upload_id)
      .await
  }

  #[instrument(skip(self))]
  pub async fn clear_multipart_parts(&self, workspace_id: Uuid, key: &str, upload_id: &str) -> AuthResult<()> {
    let parsed_key = self.parse_key(key)?;
    self
      .store
      .clear_multipart_parts(workspace_id, &parsed_key, upload_id)
      .await
  }

  #[instrument(skip(self))]
  pub async fn bind_comment_attachment(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    key: &str,
    mime: &str,
    size: u64,
    created_by: Uuid,
  ) -> AuthResult<()> {
    let parsed_key = self.parse_key(key)?;
    self
      .store
      .bind_comment_attachment(workspace_id, doc_id, &parsed_key, mime, size, created_by)
      .await
  }

  #[instrument(skip(self))]
  pub async fn attach_comment_attachment_to_comment(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    comment_id: Uuid,
    key: &str,
    user_id: Uuid,
  ) -> AuthResult<bool> {
    let parsed_key = self.parse_key(key)?;
    let attached = self
      .store
      .attach_comment_attachment_to_comment(workspace_id, doc_id, comment_id, &parsed_key, user_id)
      .await?;
    info!(
        %workspace_id,
        %doc_id,
        %comment_id,
        key = %parsed_key.as_str(),
        %user_id,
        attached,
        "handled comment attachment linkage"
    );
    Ok(attached)
  }

  #[instrument(skip(self))]
  pub async fn comment_attachment_download(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    key: &str,
  ) -> AuthResult<Option<crate::ports::blob::CommentAttachmentDownload>> {
    let parsed_key = self.parse_key(key)?;
    self
      .store
      .get_comment_attachment_download(workspace_id, doc_id, &parsed_key)
      .await
  }

  #[instrument(skip(self))]
  pub async fn initialize_upload_with_metadata(
    &self,
    workspace_id: Uuid,
    key: &str,
    size: u64,
    mime: &str,
    checksum: Option<&str>,
  ) -> AuthResult<BlobMetadata> {
    let parsed_key = self.parse_key(key)?;
    info!(%workspace_id, key = %parsed_key.as_str(), size, mime, checksum = ?checksum, "initializing blob upload");
    self
      .store
      .create_blob_metadata(workspace_id, &parsed_key, size, mime, checksum)
      .await
  }

  /// Register an object that a trusted server-side producer has already
  /// committed to storage.
  #[instrument(skip(self))]
  pub async fn register_completed_blob(&self, workspace_id: Uuid, key: &str, size: u64, mime: &str) -> AuthResult<()> {
    let parsed_key = self.parse_key(key)?;
    self
      .store
      .register_completed_blob_metadata(workspace_id, &parsed_key, size, mime)
      .await
  }

  /// Store a complete single-part workspace blob through the normal metadata
  /// and object-storage ports.
  ///
  /// This is used by trusted server-side upload entry points that already
  /// performed ACL, size and MIME-policy checks. It intentionally does not
  /// create signed URLs or multipart state.
  #[instrument(skip(self, body))]
  pub async fn upload_single_part_blob(
    &self,
    workspace_id: Uuid,
    key: &str,
    body: Bytes,
    mime: &str,
    content_type: Option<String>,
    checksum: Option<&str>,
  ) -> AuthResult<BlobMetadata> {
    let metadata = self
      .initialize_upload_with_metadata(workspace_id, key, body.len() as u64, mime, checksum)
      .await?;
    let storage_key = format!("{workspace_id}/{}", metadata.key);
    if let Err(err) = self
      .storage
      .write_blob(BlobWriteRequest {
        key: storage_key,
        content_type,
        body,
      })
      .await
    {
      let _ = self
        .set_upload_status(workspace_id, &metadata.key, BlobStatus::Failed)
        .await;
      return Err(AuthError::Storage(err.to_string()));
    }
    if let Err(err) = self.complete_upload(workspace_id, &metadata.key).await {
      let _ = self
        .set_upload_status(workspace_id, &metadata.key, BlobStatus::Failed)
        .await;
      return Err(err);
    }

    Ok(BlobMetadata {
      status: BlobStatus::Completed,
      ..metadata
    })
  }

  /// Store a protected local file through normal blob metadata while the
  /// storage adapter streams it in bounded chunks.
  #[instrument(skip(self, path))]
  pub async fn upload_blob_from_path(
    &self,
    workspace_id: Uuid,
    key: &str,
    path: std::path::PathBuf,
    size: u64,
    mime: &str,
    checksum: Option<&str>,
  ) -> AuthResult<BlobMetadata> {
    let metadata = self
      .initialize_upload_with_metadata(workspace_id, key, size, mime, checksum)
      .await?;
    let storage_key = format!("{workspace_id}/{}", metadata.key);
    if let Err(error) = self
      .storage
      .write_blob_from_path(BlobPathWriteRequest {
        key: storage_key,
        content_type: Some(mime.to_string()),
        path,
        expected_size: size,
      })
      .await
    {
      let _ = self
        .set_upload_status(workspace_id, &metadata.key, BlobStatus::Failed)
        .await;
      return Err(AuthError::Storage(error.to_string()));
    }
    self.complete_upload(workspace_id, &metadata.key).await?;
    Ok(BlobMetadata {
      status: BlobStatus::Completed,
      ..metadata
    })
  }

  /// Idempotently remove a blob created for an unpublished import target.
  pub async fn delete_imported_blob(&self, workspace_id: Uuid, key: &str) -> AuthResult<()> {
    let parsed_key = self.parse_key(key)?;
    self
      .storage
      .delete_blob(&format!("{workspace_id}/{}", parsed_key.as_str()))
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    self.store.hard_delete_blob_metadata(workspace_id, &parsed_key).await?;
    Ok(())
  }

  #[instrument(skip(self))]
  pub async fn complete_upload(&self, workspace_id: Uuid, key: &str) -> AuthResult<()> {
    let parsed_key = self.parse_key(key)?;
    info!(%workspace_id, key = %parsed_key.as_str(), "completing blob upload");
    self
      .store
      .update_blob_status(workspace_id, &parsed_key, BlobStatus::Completed)
      .await
  }

  #[instrument(skip(self))]
  pub async fn set_upload_status(&self, workspace_id: Uuid, key: &str, status: BlobStatus) -> AuthResult<()> {
    let parsed_key = self.parse_key(key)?;
    self.store.update_blob_status(workspace_id, &parsed_key, status).await
  }

  #[instrument(skip(self))]
  pub async fn get_blob(&self, workspace_id: Uuid, key: &str) -> AuthResult<crate::ports::BlobReadResponse> {
    let parsed_key = self.parse_key(key)?;
    let meta = self
      .store
      .get_blob_metadata(workspace_id, &parsed_key)
      .await?
      .ok_or_else(|| AuthError::Storage("Blob not found".into()))?;

    if meta.status != BlobStatus::Completed {
      warn!(%workspace_id, key = %parsed_key.as_str(), status = ?meta.status, "blob requested before upload completion");
      return Err(AuthError::Storage("Blob upload not completed".into()));
    }

    let storage_key = format!("{}/{}", workspace_id, parsed_key.as_str());
    debug!(%workspace_id, key = %parsed_key.as_str(), storage_key, mime = %meta.mime, "reading blob from storage");
    let mut response = self.storage.read_blob(&storage_key).await.map_err(|e| {
      error!(%workspace_id, key = %parsed_key.as_str(), error = %e, "failed to read blob from storage");
      AuthError::Storage(e.to_string())
    })?;

    // Prefer the MIME type from DB metadata over the storage backend's
    // content_type — the FS backend never sets it, so it returns None,
    // causing SVGs (and other non-trivial types) to be served as
    // application/octet-stream.
    if response.content_type.is_none() || response.content_type.as_deref() == Some("application/octet-stream") {
      response.content_type = Some(meta.mime.clone());
    }

    Ok(response)
  }

  /// Speech inputs must be completed canonical attachments in the authorized
  /// workspace. Both database and actual stored size are checked before use.
  #[instrument(skip_all)]
  pub async fn get_blob_bounded(
    &self,
    workspace_id: Uuid,
    key: &str,
    max_bytes: u64,
  ) -> AuthResult<crate::ports::BlobReadResponse> {
    let parsed_key = self.parse_key(key)?;
    let meta = self
      .store
      .get_blob_metadata(workspace_id, &parsed_key)
      .await?
      .ok_or_else(|| AuthError::InvalidInput("audio attachment not found".into()))?;
    if meta.status != BlobStatus::Completed || meta.size == 0 || meta.size > max_bytes {
      return Err(AuthError::InvalidInput(
        "audio attachment is incomplete, empty or exceeds the configured input limit".into(),
      ));
    }
    let storage_key = format!("{workspace_id}/{}", parsed_key.as_str());
    let mut response = self
      .storage
      .read_blob_bounded(&storage_key, max_bytes)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    if response.data.len() as u64 != meta.size {
      return Err(AuthError::InvalidInput(
        "audio attachment size does not match its metadata".into(),
      ));
    }
    response.content_type = Some(meta.mime);
    Ok(response)
  }

  #[instrument(skip(self))]
  pub async fn soft_delete_blob(
    &self,
    workspace_id: Uuid,
    key: &str,
    when: chrono::DateTime<chrono::Utc>,
  ) -> AuthResult<bool> {
    let parsed_key = self.parse_key(key)?;
    let deleted = self
      .store
      .soft_delete_blob_metadata(workspace_id, &parsed_key, when)
      .await?;
    info!(
        %workspace_id,
        key = %parsed_key.as_str(),
        deleted,
        "soft-delete request handled for blob metadata"
    );
    Ok(deleted)
  }

  #[instrument(skip(self))]
  pub async fn list_blob_gc_candidates(
    &self,
    deleted_before: chrono::DateTime<chrono::Utc>,
    limit: i64,
  ) -> AuthResult<Vec<BlobGcCandidate>> {
    let safe_limit = limit.clamp(1, 5000);
    let candidates = self
      .store
      .list_retention_gc_candidates(deleted_before, safe_limit)
      .await?;
    debug!(
        deleted_before = %deleted_before,
        limit = safe_limit,
        candidates = candidates.len(),
        "loaded blob GC candidates"
    );
    Ok(candidates)
  }

  #[instrument(skip(self))]
  pub async fn purge_retained_deleted_blobs(
    &self,
    deleted_before: chrono::DateTime<chrono::Utc>,
    limit: i64,
  ) -> AuthResult<u64> {
    let candidates = self.list_blob_gc_candidates(deleted_before, limit).await?;
    let mut purged = 0u64;

    for candidate in candidates {
      let storage_key = format!("{}/{}", candidate.workspace_id, candidate.key);
      if let Err(err) = self.storage.delete_blob(&storage_key).await {
        warn!(
            workspace_id = %candidate.workspace_id,
            key = %candidate.key,
            deleted_at = %candidate.deleted_at,
            error = %err,
            "failed to delete blob content during GC, skipping metadata purge"
        );
        continue;
      }

      let parsed_key = match BlobKey::parse(&candidate.key) {
        Ok(v) => v,
        Err(err) => {
          warn!(
              workspace_id = %candidate.workspace_id,
              key = %candidate.key,
              error = %err,
              "invalid blob key in GC candidate, skipping metadata purge"
          );
          continue;
        }
      };
      let deleted = self
        .store
        .hard_delete_blob_metadata(candidate.workspace_id, &parsed_key)
        .await?;
      if deleted {
        purged += 1;
      } else {
        debug!(
            workspace_id = %candidate.workspace_id,
            key = %candidate.key,
            "blob metadata already purged by concurrent worker"
        );
      }
    }

    info!(
        deleted_before = %deleted_before,
        limit,
        purged,
        "blob retention GC pass completed"
    );
    Ok(purged)
  }

  #[instrument(skip(self))]
  pub async fn list_workspace_blobs(
    &self,
    workspace_id: Uuid,
    limit: i64,
    offset: i64,
    include_deleted: bool,
  ) -> AuthResult<Vec<BlobMetadata>> {
    self
      .store
      .list_workspace_blobs(workspace_id, limit, offset, include_deleted)
      .await
  }

  /// Return active audio blobs for the Copilot transcription dispatcher.
  pub async fn list_workspace_audio_blobs(&self, workspace_id: Uuid) -> AuthResult<Vec<(String, String)>> {
    Ok(
      self
        .store
        .list_workspace_blobs(workspace_id, i64::MAX, 0, false)
        .await?
        .into_iter()
        .filter(|blob| blob.mime.starts_with("audio/"))
        .map(|blob| (blob.key, blob.mime))
        .collect(),
    )
  }

  /// Return every persisted blob key before a workspace metadata cascade.
  ///
  /// The ordinary inventory endpoint is deliberately page-limited. Workspace
  /// deletion therefore uses a dedicated unbounded key projection before the
  /// metadata cascade, so every object-store entry remains discoverable.
  pub async fn list_all_workspace_blob_keys(&self, workspace_id: Uuid) -> AuthResult<Vec<String>> {
    self.store.list_workspace_blob_keys_for_deletion(workspace_id).await
  }

  #[instrument(skip(self))]
  pub async fn workspace_blob_size(&self, workspace_id: Uuid, include_deleted: bool) -> AuthResult<u64> {
    self.store.sum_workspace_blob_size(workspace_id, include_deleted).await
  }

  /// Return active blob bytes across all active workspaces linked to a user.
  pub async fn user_workspace_blob_size(&self, user_id: Uuid) -> AuthResult<u64> {
    self.store.sum_user_workspace_blob_size(user_id).await
  }

  #[instrument(skip(self))]
  pub async fn hard_delete_blob(&self, workspace_id: Uuid, key: &str) -> AuthResult<bool> {
    let parsed_key = self.parse_key(key)?;
    let storage_key = format!("{workspace_id}/{}", parsed_key.as_str());
    if let Err(err) = self.storage.delete_blob(&storage_key).await {
      warn!(
          %workspace_id,
          key = %parsed_key.as_str(),
          error = %err,
          "blob content delete failed during hard-delete, retaining metadata"
      );
      return Err(AuthError::Storage(
        "blob content deletion failed; metadata retained".into(),
      ));
    }
    self.store.hard_delete_blob(workspace_id, &parsed_key).await
  }

  #[instrument(skip(self))]
  pub async fn release_deleted_blobs_in_workspace(
    &self,
    workspace_id: Uuid,
    deleted_before: chrono::DateTime<chrono::Utc>,
    limit: i64,
  ) -> AuthResult<u64> {
    let candidates = self
      .store
      .release_deleted_blobs_in_workspace(workspace_id, deleted_before, limit)
      .await?;
    let mut purged = 0_u64;
    for candidate in candidates {
      let storage_key = format!("{}/{}", candidate.workspace_id, candidate.key);
      if self.storage.delete_blob(&storage_key).await.is_ok() {
        let parsed_key = BlobKey::parse(&candidate.key)
          .map_err(|e| AuthError::Storage(format!("invalid blob key in release flow: {e}")))?;
        if self.store.hard_delete_blob(candidate.workspace_id, &parsed_key).await? {
          purged += 1;
        }
      }
    }
    Ok(purged)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::api_key::encode_base62;
  use crate::ports::blob::{BlobStatus, BlobStore};
  use crate::ports::{
    BlobReadResponse, BlobStoragePort, BlobWriteRequest, MultipartCompleteRequest, MultipartCreateRequest,
    MultipartCreateResponse, MultipartPartUrlRequest, MultipartPartUrlResponse, PortError, PortResult,
  };
  use async_trait::async_trait;
  use bytes::Bytes;
  use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
  };

  #[derive(Default)]
  struct DummyBlobStore {
    hard_delete_calls: AtomicUsize,
    listed_blobs: Vec<BlobMetadata>,
  }

  #[derive(Default)]
  struct DummyBlobStorage {
    delete_calls: AtomicUsize,
    fail_delete: bool,
  }

  #[async_trait]
  impl BlobStore for DummyBlobStore {
    async fn create_blob_metadata(
      &self,
      _workspace_id: Uuid,
      _key: &BlobKey,
      _size: u64,
      _mime: &str,
      _checksum: Option<&str>,
    ) -> AuthResult<BlobMetadata> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn register_completed_blob_metadata(
      &self,
      _workspace_id: Uuid,
      _key: &BlobKey,
      _size: u64,
      _mime: &str,
    ) -> AuthResult<()> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn get_blob_metadata(&self, _workspace_id: Uuid, _key: &BlobKey) -> AuthResult<Option<BlobMetadata>> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn update_blob_status(&self, _workspace_id: Uuid, _key: &BlobKey, _status: BlobStatus) -> AuthResult<()> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn set_upload_id(&self, _workspace_id: Uuid, _key: &BlobKey, _upload_id: &str) -> AuthResult<()> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn delete_blob_metadata(&self, _workspace_id: Uuid, _key: &BlobKey) -> AuthResult<()> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn upsert_multipart_part(
      &self,
      _workspace_id: Uuid,
      _key: &BlobKey,
      _upload_id: &str,
      _part_number: i32,
      _etag: &str,
    ) -> AuthResult<()> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn list_multipart_parts(
      &self,
      _workspace_id: Uuid,
      _key: &BlobKey,
      _upload_id: &str,
    ) -> AuthResult<Vec<crate::ports::blob::MultipartUploadedPart>> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn clear_multipart_parts(&self, _workspace_id: Uuid, _key: &BlobKey, _upload_id: &str) -> AuthResult<()> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn bind_comment_attachment(
      &self,
      _workspace_id: Uuid,
      _doc_id: Uuid,
      _key: &BlobKey,
      _mime: &str,
      _size: u64,
      _created_by: Uuid,
    ) -> AuthResult<()> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn attach_comment_attachment_to_comment(
      &self,
      _workspace_id: Uuid,
      _doc_id: Uuid,
      _comment_id: Uuid,
      _key: &BlobKey,
      _user_id: Uuid,
    ) -> AuthResult<bool> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn get_comment_attachment_download(
      &self,
      _workspace_id: Uuid,
      _doc_id: Uuid,
      _key: &BlobKey,
    ) -> AuthResult<Option<crate::ports::blob::CommentAttachmentDownload>> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn soft_delete_blob_metadata(
      &self,
      _workspace_id: Uuid,
      _key: &BlobKey,
      _when: chrono::DateTime<chrono::Utc>,
    ) -> AuthResult<bool> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn hard_delete_blob_metadata(&self, _workspace_id: Uuid, _key: &BlobKey) -> AuthResult<bool> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn list_retention_gc_candidates(
      &self,
      _deleted_before: chrono::DateTime<chrono::Utc>,
      _limit: i64,
    ) -> AuthResult<Vec<crate::ports::blob::BlobGcCandidate>> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn list_workspace_blobs(
      &self,
      workspace_id: Uuid,
      limit: i64,
      offset: i64,
      include_deleted: bool,
    ) -> AuthResult<Vec<BlobMetadata>> {
      Ok(
        self
          .listed_blobs
          .iter()
          .filter(|blob| blob.workspace_id == workspace_id)
          .filter(|blob| include_deleted || blob.deleted_at.is_none())
          .skip(offset.max(0) as usize)
          .take(limit.clamp(1, 200) as usize)
          .cloned()
          .collect(),
      )
    }
    async fn list_workspace_blob_keys_for_deletion(&self, workspace_id: Uuid) -> AuthResult<Vec<String>> {
      Ok(
        self
          .listed_blobs
          .iter()
          .filter(|blob| blob.workspace_id == workspace_id)
          .map(|blob| blob.key.clone())
          .collect(),
      )
    }
    async fn sum_workspace_blob_size(&self, _workspace_id: Uuid, _include_deleted: bool) -> AuthResult<u64> {
      Err(AuthError::Storage("unused".into()))
    }
    async fn hard_delete_blob(&self, _workspace_id: Uuid, _key: &BlobKey) -> AuthResult<bool> {
      self.hard_delete_calls.fetch_add(1, Ordering::SeqCst);
      Ok(true)
    }
    async fn release_deleted_blobs_in_workspace(
      &self,
      _workspace_id: Uuid,
      _deleted_before: chrono::DateTime<chrono::Utc>,
      _limit: i64,
    ) -> AuthResult<Vec<BlobGcCandidate>> {
      Err(AuthError::Storage("unused".into()))
    }
  }

  #[async_trait]
  impl BlobStoragePort for DummyBlobStorage {
    async fn write_blob(&self, _req: BlobWriteRequest) -> PortResult<()> {
      Ok(())
    }
    async fn read_blob(&self, _key: &str) -> PortResult<BlobReadResponse> {
      Ok(BlobReadResponse {
        key: "dummy".into(),
        content_type: None,
        data: Bytes::new(),
        last_modified: None,
        content_length: 0,
      })
    }
    async fn delete_blob(&self, _key: &str) -> PortResult<()> {
      self.delete_calls.fetch_add(1, Ordering::SeqCst);
      if self.fail_delete {
        Err(PortError::Transport("injected delete failure".into()))
      } else {
        Ok(())
      }
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
      Err(PortError::InvalidInput(
        "NullBlobStorage does not support multipart uploads".to_string(),
      ))
    }
    async fn create_multipart_part_url(&self, _req: MultipartPartUrlRequest) -> PortResult<MultipartPartUrlResponse> {
      Err(PortError::InvalidInput(
        "NullBlobStorage does not support multipart uploads".to_string(),
      ))
    }
    async fn complete_multipart_upload(&self, _req: MultipartCompleteRequest) -> PortResult<()> {
      Err(PortError::InvalidInput(
        "NullBlobStorage does not support multipart uploads".to_string(),
      ))
    }
    async fn abort_multipart_upload(&self, _upload_id: Uuid) -> PortResult<()> {
      Err(PortError::InvalidInput(
        "NullBlobStorage does not support multipart uploads".to_string(),
      ))
    }
  }

  fn service() -> BlobService {
    BlobService::new(
      Arc::new(DummyBlobStore::default()),
      Arc::new(DummyBlobStorage::default()),
      "unit-test-sign-key".to_string(),
    )
  }

  fn service_with(store: Arc<DummyBlobStore>, storage: Arc<DummyBlobStorage>) -> BlobService {
    BlobService::new(store, storage, "unit-test-sign-key".to_string())
  }

  fn query_param<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    let (_, query) = url.split_once('?')?;
    query.split('&').find_map(|pair| {
      let mut it = pair.splitn(2, '=');
      let k = it.next()?;
      let v = it.next().unwrap_or_default();
      if k == key { Some(v) } else { None }
    })
  }

  #[tokio::test]
  async fn hard_delete_retains_metadata_when_storage_delete_fails() {
    let store = Arc::new(DummyBlobStore::default());
    let storage = Arc::new(DummyBlobStorage {
      fail_delete: true,
      ..Default::default()
    });
    let service = service_with(Arc::clone(&store), Arc::clone(&storage));

    let err = service
      .hard_delete_blob(Uuid::new_v4(), "folder/blob.bin")
      .await
      .expect_err("storage failure must prevent metadata purge");

    assert!(matches!(
      err,
      AuthError::Storage(message) if message == "blob content deletion failed; metadata retained"
    ));
    assert_eq!(storage.delete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(store.hard_delete_calls.load(Ordering::SeqCst), 0);
  }

  #[tokio::test]
  async fn hard_delete_purges_metadata_only_after_storage_delete_succeeds() {
    let store = Arc::new(DummyBlobStore::default());
    let storage = Arc::new(DummyBlobStorage::default());
    let service = service_with(Arc::clone(&store), Arc::clone(&storage));

    let deleted = service
      .hard_delete_blob(Uuid::new_v4(), "folder/blob.bin")
      .await
      .expect("successful content deletion must allow metadata purge");

    assert!(deleted);
    assert_eq!(storage.delete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(store.hard_delete_calls.load(Ordering::SeqCst), 1);
  }

  #[tokio::test]
  async fn deletion_inventory_is_not_limited_to_an_inventory_page() {
    let workspace_id = Uuid::new_v4();
    let now = chrono::Utc::now();
    let listed_blobs = (0..450)
      .map(|index| BlobMetadata {
        blob_id: Uuid::new_v4(),
        workspace_id,
        key: format!("objects/{index}.bin"),
        size: 1,
        mime: "application/octet-stream".to_string(),
        checksum: None,
        status: BlobStatus::Completed,
        upload_id: None,
        created_at: now,
        updated_at: now,
        deleted_at: None,
      })
      .collect();
    let service = service_with(
      Arc::new(DummyBlobStore {
        listed_blobs,
        ..Default::default()
      }),
      Arc::new(DummyBlobStorage::default()),
    );

    let keys = service
      .list_all_workspace_blob_keys(workspace_id)
      .await
      .expect("workspace deletion inventory");

    assert_eq!(keys.len(), 450);
    assert_eq!(keys.first().map(String::as_str), Some("objects/0.bin"));
    assert_eq!(keys.last().map(String::as_str), Some("objects/449.bin"));
  }

  #[test]
  fn signed_upload_url_is_verifiable_and_expires() {
    let service = service();
    let workspace_id = Uuid::new_v4();
    let path = "/api/storage/upload";
    let key = "folder/object.bin";
    let signed = service
      .create_signed_upload_url(path, workspace_id, key, 60)
      .expect("signed upload url");

    let expires: i64 = query_param(&signed, "expires").unwrap().parse().unwrap();
    let token = urlencoding::decode(query_param(&signed, "token").unwrap())
      .unwrap()
      .into_owned();

    assert!(service.verify_signed_upload_url(path, workspace_id, key, expires, &token));
    assert!(!service.verify_signed_upload_url(path, workspace_id, key, expires - 120, &token));
  }

  #[test]
  fn signed_download_url_rejects_upload_token_reuse() {
    let service = service();
    let workspace_id = Uuid::new_v4();
    let path = "/api/workspaces/w1/blobs/file";
    let key = "folder/file.txt";

    let upload_url = service
      .create_signed_upload_url(path, workspace_id, key, 300)
      .expect("signed upload");
    let download_url = service
      .create_signed_download_url(path, workspace_id, key, 300)
      .expect("signed download");

    let expires: i64 = query_param(&download_url, "expires").unwrap().parse().unwrap();
    let download_token = urlencoding::decode(query_param(&download_url, "token").unwrap())
      .unwrap()
      .into_owned();
    let upload_token = urlencoding::decode(query_param(&upload_url, "token").unwrap())
      .unwrap()
      .into_owned();

    assert!(service.verify_signed_download_url(path, workspace_id, key, expires, &download_token));
    assert!(!service.verify_signed_download_url(path, workspace_id, key, expires, &upload_token));
  }

  #[test]
  fn workspace_import_part_signature_binds_every_staging_dimension() {
    let service = service();
    let actor_id = Uuid::new_v4();
    let import_id = Uuid::new_v4();
    let path = "/api/workspace-import/upload-part";
    let content_hash = "a".repeat(64);
    let signed = service
      .create_signed_workspace_import_part_upload_url(path, actor_id, import_id, 2, 4096, &content_hash, 300)
      .expect("signed workspace import part");
    let expires_at = query_param(&signed, "expires").unwrap().parse().unwrap();
    let token = urlencoding::decode(query_param(&signed, "token").unwrap())
      .unwrap()
      .into_owned();
    let verify = |actor_id, import_id, part_number, size_bytes, content_hash: &str| {
      service.verify_signed_workspace_import_part_upload_url(WorkspaceImportPartUploadSignature {
        path,
        actor_id,
        import_id,
        part_number,
        size_bytes,
        content_hash,
        expires_at,
        token: &token,
      })
    };

    assert!(verify(actor_id, import_id, 2, 4096, &content_hash));
    assert!(!verify(Uuid::new_v4(), import_id, 2, 4096, &content_hash));
    assert!(!verify(actor_id, Uuid::new_v4(), 2, 4096, &content_hash));
    assert!(!verify(actor_id, import_id, 3, 4096, &content_hash));
    assert!(!verify(actor_id, import_id, 2, 4097, &content_hash));
    assert!(!verify(actor_id, import_id, 2, 4096, &"b".repeat(64)));
  }

  /// APP-RV-02c: Wrong tokens are rejected uniformly — no early prefix matching.
  #[test]
  fn wrong_token_rejected_uniformly() {
    let service = service();
    let path = "/api/upload";
    let fields = &["ws1", "file.bin"];
    let token = service.sign_upload(path, fields, chrono::Utc::now().timestamp() + 300);

    // Completely wrong token
    assert!(!service.verify_token(path, fields, "999999-AAAAAAA"));
    // Same expiry but different signature
    let parts: Vec<&str> = token.split('-').collect();
    let wrong = format!("{}-WRONG{}", parts[0], &parts[1][5..]);
    assert!(!service.verify_token(path, fields, &wrong));
    // Prefix match (first chars identical, rest different)
    let prefix_wrong = format!("{}X", &token[..token.len() - 1]);
    assert!(!service.verify_token(path, fields, &prefix_wrong));
    // Correct token still works
    assert!(service.verify_token(path, fields, &token));
  }

  /// APP-RV-01b: Base62 encoding produces consistent length for 32-byte inputs.
  #[test]
  fn base62_consistent_length() {
    let a = [0u8; 32];
    let b = [0xFF; 32];
    let c = [0x80; 32];
    let ea = encode_base62(&a);
    let eb = encode_base62(&b);
    let ec = encode_base62(&c);
    // All should be exactly 43 characters (ceil(256 * ln2 / ln62))
    assert_eq!(ea.len(), 43, "zero input: {ea}");
    assert_eq!(eb.len(), 43, "max input: {eb}");
    assert_eq!(ec.len(), 43, "mid input: {ec}");
  }

  /// APP-RV-01c: Different 32-byte inputs produce different Base62 outputs.
  #[test]
  fn base62_no_trivial_collisions() {
    use std::collections::HashSet;
    let mut seen = HashSet::new();
    for i in 0u8..=255 {
      let mut input = [0u8; 32];
      input[0] = i;
      let encoded = encode_base62(&input);
      assert!(seen.insert(encoded), "collision at input[0]={i}");
    }
  }
}
