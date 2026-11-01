//! Blob upload, multipart-upload, and comment-attachment download handlers.
//!
//! Implements the REST blob surface used by the web client:
//! - `PUT /api/workspaces/{id}/blobs/{key}` — single-chunk upload
//! - `POST /api/workspaces/{id}/blobs` — multipart upload (chunked)
//! - `GET /api/workspaces/{id}/blobs/{key}` — blob download / redirect
//! - `DELETE /api/workspaces/{id}/blobs/{key}` — blob deletion
//! - `GET /api/workspaces/{id}/blobs` — list blob keys
//! - `GET /api/workspaces/{id}/comments/{id}/attachment` — comment-attachment download

use axum::{
  body::Bytes,
  extract::{Path, Query, State},
  http::{HeaderMap, StatusCode, header},
  response::IntoResponse,
};
use myoxus_application::permission::{AccessController, WorkspaceResource};
use myoxus_application::ports::blob::BlobStatus;
use myoxus_application::ports::blob_service::MultipartPartUploadSignature;
use myoxus_domain::permission::WorkspaceAction;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tracing::{info, instrument, warn};
use uuid::Uuid;

use crate::state::ApiState;

/// L-07: Expected Content-Type values for upload endpoints.
const EXPECTED_UPLOAD_CONTENT_TYPES: &[&str] = &[
  "multipart/form-data",
  "application/octet-stream",
  "application/x-www-form-urlencoded",
];

/// Log a warning if the upload Content-Type header is present but unexpected.
/// Does NOT reject the request — some clients omit Content-Type entirely.
fn warn_unexpected_upload_content_type(headers: &HeaderMap, endpoint: &str) {
  if let Some(ct) = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) {
    let base = ct.split(';').next().unwrap_or(ct).trim();
    if !EXPECTED_UPLOAD_CONTENT_TYPES
      .iter()
      .any(|&expected| base.eq_ignore_ascii_case(expected))
    {
      warn!(
        endpoint = endpoint,
        content_type = ct,
        "unexpected Content-Type on upload — expected one of {:?}",
        EXPECTED_UPLOAD_CONTENT_TYPES
      );
    }
  }
}

/// Enforce MIME policy on upload bytes.
///
/// Reads MIME policy from the universal live configuration snapshot and calls
/// `detect_mime` + `evaluate_policy`.
///
/// Returns `Ok(())` for Allow and Warn decisions (Warn logs automatically in
/// `evaluate_policy`). Returns `Err(StatusCode::UNSUPPORTED_MEDIA_TYPE)` for
/// Deny decisions in strict mode.
///
/// Only the first 8 KB of `bytes` are needed for magic-byte detection, but we
/// accept the full slice to avoid an extra copy at the call site.
#[instrument(skip_all)]
pub(crate) async fn enforce_mime_policy(
  state: &ApiState,
  bytes: &[u8],
  file_name: &str,
  declared_mime: &str,
) -> Result<(), StatusCode> {
  use myoxus_application::mime_policy::{MimePolicyDecision, detect_mime, evaluate_policy};
  use myoxus_infrastructure::mime_policy_config::{MimePolicyFallback, resolve_mime_policy_config};

  let effective = state.effective_config().await;
  let fallback = MimePolicyFallback {
    allowlist: &effective.base.git_sync.mime_allowlist_admin,
    blocklist: &effective.base.git_sync.mime_blocklist_admin,
    validation_mode: &effective.base.git_sync.mime_validation_mode,
  };
  let config = resolve_mime_policy_config(&effective.overrides.overrides, &fallback);

  let detection = detect_mime(bytes, file_name, declared_mime);
  let decision = evaluate_policy(&detection, &config);

  match decision {
    MimePolicyDecision::Allow | MimePolicyDecision::Warn { .. } => Ok(()),
    MimePolicyDecision::Deny { reason } => {
      warn!(
        file_name = file_name,
        effective_mime = %detection.effective_mime,
        confidence = %detection.confidence,
        reason = %reason,
        "MIME policy denied upload"
      );
      Err(StatusCode::UNSUPPORTED_MEDIA_TYPE)
    }
  }
}

/// Query parameters for `PUT /api/blob-upload/part` (legacy multipart part upload).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BlobUploadPartQuery {
  workspace_id: String,
  key: String,
  upload_id: String,
  part_number: i32,
  /// Unix timestamp in milliseconds at which the signed URL expires.
  expires: i64,
  /// HMAC token proving this URL was issued by the server.
  token: String,
}

/// Query parameters for `PUT /api/storage/upload` (single-part upload).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageUploadQuery {
  #[serde(alias = "workspace_id")]
  workspace_id: String,
  key: String,
  /// Unix timestamp in milliseconds at which the signed URL expires (`exp` alias for compat).
  #[serde(alias = "exp")]
  expires: i64,
  /// HMAC token proving this URL was issued by the server.
  token: String,
}

/// Query parameters for `PUT /api/storage/multipart` (multipart part upload).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageMultipartPartQuery {
  #[serde(alias = "workspace_id")]
  workspace_id: String,
  key: String,
  #[serde(alias = "upload_id")]
  upload_id: String,
  #[serde(alias = "part_number")]
  part_number: i32,
  /// Unix timestamp in milliseconds at which the signed URL expires (`exp` alias for compat).
  #[serde(alias = "exp")]
  expires: i64,
  /// HMAC token proving this URL was issued by the server.
  token: String,
}

/// Parse an HTTP `Range: bytes=…` header and return an inclusive `(start, end)` byte range.
///
/// Returns `None` if the range is syntactically invalid, out of bounds, or
/// `total_len` is zero.  Supports the following `Range` forms:
/// - `bytes=<start>-<end>` — explicit start and end
/// - `bytes=<start>-` — from start to end of file
/// - `bytes=-<suffix>` — last `suffix` bytes of the file
pub(crate) fn parse_range_header(range_header: &str, total_len: usize) -> Option<(usize, usize)> {
  if total_len == 0 {
    return None;
  }
  let prefix = "bytes=";
  let rest = range_header.strip_prefix(prefix)?;
  let (start_s, end_s) = rest.split_once('-')?;
  if start_s.is_empty() {
    let suffix_len: usize = end_s.parse().ok()?;
    if suffix_len == 0 {
      return None;
    }
    let start = total_len.saturating_sub(suffix_len);
    return Some((start, total_len - 1));
  }
  let start: usize = start_s.parse().ok()?;
  if start >= total_len {
    return None;
  }
  if end_s.is_empty() {
    return Some((start, total_len - 1));
  }
  let end: usize = end_s.parse().ok()?;
  if end < start {
    return None;
  }
  Some((start, end.min(total_len - 1)))
}

/// `PUT /api/blob-upload/part` — legacy multipart part upload endpoint.
///
/// Validates the HMAC token, writes the part bytes to object storage, and
/// records the part ETag (SHA-256 of the body) in the blob metadata table.
/// Returns 200 with an `etag` header on success.
#[instrument(skip_all)]
pub(crate) async fn blob_upload_part_handler(
  State(state): State<ApiState>,
  Query(params): Query<BlobUploadPartQuery>,
  headers: HeaderMap,
  body: Bytes,
) -> Result<impl IntoResponse, StatusCode> {
  warn_unexpected_upload_content_type(&headers, "/api/blob-upload/part");
  let workspace_id = Uuid::parse_str(&params.workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  if params.part_number <= 0 {
    return Err(StatusCode::BAD_REQUEST);
  }

  let valid = state
    .blob()
    .verify_signed_multipart_part_upload_url(MultipartPartUploadSignature {
      path: "/api/blob-upload/part",
      workspace_id,
      key: &params.key,
      upload_id: &params.upload_id,
      part_number: params.part_number,
      expires_at: params.expires,
      token: &params.token,
    });
  if !valid {
    warn!(workspace_id = %workspace_id, key = %params.key, upload_id = %params.upload_id, part_number = params.part_number, "multipart part upload token validation failed");
    return Err(StatusCode::UNAUTHORIZED);
  }
  if body.len() as u64 > state.config.storage.multipart_part_size_bytes {
    return Err(StatusCode::PAYLOAD_TOO_LARGE);
  }

  let metadata = state
    .blob()
    .get_blob_metadata(workspace_id, &params.key)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  let Some(metadata) = metadata else {
    return Err(StatusCode::NOT_FOUND);
  };
  if metadata.upload_id.as_deref() != Some(params.upload_id.as_str()) {
    return Err(StatusCode::CONFLICT);
  }

  let part_storage_key = format!(
    "{workspace_id}/multipart/{}/{:05}",
    params.upload_id, params.part_number
  );
  state
    .storage()
    .write_blob(myoxus_application::ports::BlobWriteRequest {
      key: part_storage_key,
      content_type: Some("application/octet-stream".to_string()),
      body: body.clone(),
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

  let mut hasher = Sha256::new();
  hasher.update(&body);
  let etag = format!("\"{:x}\"", hasher.finalize());
  state
    .blob()
    .upsert_multipart_part(workspace_id, &params.key, &params.upload_id, params.part_number, &etag)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

  Ok((StatusCode::OK, [("etag", etag)]))
}

/// `PUT /api/storage/upload` — single-part blob upload.
///
/// Validates the HMAC signed URL token, checks that the body size matches the
/// declared size, writes the bytes to object storage, and marks the upload as
/// complete in the metadata store.
#[instrument(skip_all)]
pub(crate) async fn storage_upload_handler(
  State(state): State<ApiState>,
  Query(params): Query<StorageUploadQuery>,
  headers: HeaderMap,
  body: Bytes,
) -> Result<impl IntoResponse, StatusCode> {
  warn_unexpected_upload_content_type(&headers, "/api/storage/upload");
  let workspace_id = Uuid::parse_str(&params.workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let valid = state.blob().verify_signed_upload_url(
    "/api/storage/upload",
    workspace_id,
    &params.key,
    params.expires,
    &params.token,
  );
  if !valid {
    warn!(%workspace_id, key = %params.key, "storage upload token validation failed");
    return Err(StatusCode::UNAUTHORIZED);
  }
  let metadata = state
    .blob()
    .get_blob_metadata(workspace_id, &params.key)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;
  if metadata.status == BlobStatus::Completed {
    return Err(StatusCode::CONFLICT);
  }
  if body.len() as u64 > state.config.storage.max_upload_bytes() {
    return Err(StatusCode::PAYLOAD_TOO_LARGE);
  }
  if metadata.size != body.len() as u64 {
    return Err(StatusCode::CONFLICT);
  }
  if let Some(expected) = metadata.checksum.as_deref() {
    let actual = hex::encode(Sha256::digest(&body));
    if !actual.eq_ignore_ascii_case(expected) {
      warn!(%workspace_id, key = %params.key, "storage upload checksum validation failed");
      return Err(StatusCode::CONFLICT);
    }
  }

  // MIME policy enforcement — check before writing to storage.
  enforce_mime_policy(&state, &body, &params.key, &metadata.mime).await?;

  let content_type = headers
    .get(axum::http::header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .map(|v| v.to_string())
    .or_else(|| Some(metadata.mime.clone()));
  let storage_key = format!("{workspace_id}/{}", params.key);
  state
    .storage()
    .write_blob(myoxus_application::ports::BlobWriteRequest {
      key: storage_key,
      content_type,
      body: body.clone(),
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  state
    .blob()
    .complete_upload(workspace_id, &params.key)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

  Ok(StatusCode::OK)
}

/// `PUT /api/storage/multipart` — multipart part upload.
///
/// Identical to [`blob_upload_part_handler`] but uses the `/api/storage/multipart`
/// path and the corresponding signed URL format expected by the newer client SDK.
#[instrument(skip_all)]
pub(crate) async fn storage_multipart_part_handler(
  State(state): State<ApiState>,
  Query(params): Query<StorageMultipartPartQuery>,
  headers: HeaderMap,
  body: Bytes,
) -> Result<impl IntoResponse, StatusCode> {
  warn_unexpected_upload_content_type(&headers, "/api/storage/multipart");
  let workspace_id = Uuid::parse_str(&params.workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  if params.part_number <= 0 {
    return Err(StatusCode::BAD_REQUEST);
  }
  let valid = state
    .blob()
    .verify_signed_multipart_part_upload_url(MultipartPartUploadSignature {
      path: "/api/storage/multipart",
      workspace_id,
      key: &params.key,
      upload_id: &params.upload_id,
      part_number: params.part_number,
      expires_at: params.expires,
      token: &params.token,
    });
  if !valid {
    warn!(%workspace_id, key = %params.key, upload_id = %params.upload_id, part_number = params.part_number, "storage multipart token validation failed");
    return Err(StatusCode::UNAUTHORIZED);
  }
  if body.len() as u64 > state.config.storage.multipart_part_size_bytes {
    return Err(StatusCode::PAYLOAD_TOO_LARGE);
  }
  let metadata = state
    .blob()
    .get_blob_metadata(workspace_id, &params.key)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;
  if metadata.upload_id.as_deref() != Some(params.upload_id.as_str()) {
    return Err(StatusCode::CONFLICT);
  }

  let part_storage_key = format!(
    "{workspace_id}/multipart/{}/{:05}",
    params.upload_id, params.part_number
  );
  state
    .storage()
    .write_blob(myoxus_application::ports::BlobWriteRequest {
      key: part_storage_key,
      content_type: Some("application/octet-stream".to_string()),
      body: body.clone(),
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

  let mut hasher = Sha256::new();
  hasher.update(&body);
  let etag = format!("\"{:x}\"", hasher.finalize());
  state
    .blob()
    .upsert_multipart_part(workspace_id, &params.key, &params.upload_id, params.part_number, &etag)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  Ok((StatusCode::OK, [("etag", etag)]))
}

// Upload MIME policy also permits legacy/warn-mode files. Enforce isolation at
// delivery, including ranges and comments, so stored active content never gains
// the application's origin or script privileges when opened as a document.
pub(crate) fn secure_download_headers(headers: &mut HeaderMap, mime: &str, filename: &str) -> Result<(), StatusCode> {
  let mime = mime.split(';').next().unwrap_or(mime).trim().to_ascii_lowercase();
  let inline = matches!(
    mime.as_str(),
    "image/png"
      | "image/jpeg"
      | "image/gif"
      | "image/webp"
      | "image/avif"
      | "image/bmp"
      | "image/svg+xml"
      | "application/pdf"
  ) || mime.starts_with("audio/")
    || mime.starts_with("video/");
  let disposition = if inline { "inline" } else { "attachment" };
  headers.insert(
    header::CONTENT_DISPOSITION,
    format!("{disposition}; filename=\"{filename}\"")
      .parse()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  headers.insert(
    header::CONTENT_SECURITY_POLICY,
    header::HeaderValue::from_static("sandbox allow-downloads"),
  );
  headers.insert(
    header::X_CONTENT_TYPE_OPTIONS,
    header::HeaderValue::from_static("nosniff"),
  );
  Ok(())
}

/// `GET /api/workspaces/{workspace_id}/blobs/{*key}` — download a workspace blob.
///
/// Requires a valid session cookie with at least `BlobsRead` permission on the
/// workspace.  Supports range requests for partial content delivery (video/audio).
/// Previewable media stays inline; other files download as attachments.
/// All file responses are sandboxed, including partial responses.
#[instrument(skip_all)]
pub(crate) async fn download_blob_handler(
  State(state): State<ApiState>,
  Path((workspace_id, key)): Path<(String, String)>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  tracing::debug!(%workspace_uuid, key = %key, "handling blob download request");
  let cookies = crate::graphql::utils::parse_cookies(&headers);
  let session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
    .ok_or(StatusCode::UNAUTHORIZED)?;
  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .ok_or(StatusCode::UNAUTHORIZED)?;

  let pc = state.permission_service();
  pc.assert(
    &WorkspaceResource {
      user_id: snapshot.user.id,
      workspace_id: workspace_uuid,
    },
    WorkspaceAction::BlobsRead,
  )
  .await
  .map_err(|_| StatusCode::FORBIDDEN)?;

  let blob = state
    .blob()
    .get_blob(workspace_uuid, &key)
    .await
    .map_err(|_| StatusCode::NOT_FOUND)?;

  let raw_filename = key.split('/').next_back().unwrap_or("download.bin");
  // Sanitize filename for Content-Disposition: keep only ASCII printable,
  // replace anything problematic with underscore to avoid 500 from
  // HeaderValue::parse on non-ASCII filenames.
  let filename: String = raw_filename
    .chars()
    .map(|c| {
      if c.is_ascii_graphic() && c != '"' && c != '\\' {
        c
      } else {
        '_'
      }
    })
    .collect();
  let content_type = blob
    .content_type
    .clone()
    .unwrap_or_else(|| "application/octet-stream".to_string());
  let range_header = headers
    .get(axum::http::header::RANGE)
    .and_then(|v| v.to_str().ok())
    .map(|s| s.to_string());
  let data = blob.data.to_vec();
  let total_len = data.len();
  let cache_control = "private, max-age=3600";

  if let Some(range_header) = range_header {
    let Some((start, end)) = parse_range_header(&range_header, total_len) else {
      warn!(%workspace_uuid, key = %key, range = %range_header, total_len, "invalid range header for blob download");
      return Err(StatusCode::RANGE_NOT_SATISFIABLE);
    };
    let slice = data[start..=end].to_vec();
    let content_range = format!("bytes {}-{}/{}", start, end, total_len);
    let mut response = axum::response::Response::new(axum::body::Body::from(slice));
    *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    let headers = response.headers_mut();
    headers.insert(
      axum::http::header::CONTENT_TYPE,
      content_type.parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    headers.insert(
      axum::http::header::ACCEPT_RANGES,
      "bytes".parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    headers.insert(
      axum::http::header::CONTENT_RANGE,
      content_range.parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    headers.insert(
      axum::http::header::CONTENT_LENGTH,
      (end - start + 1)
        .to_string()
        .parse()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    secure_download_headers(headers, &content_type, &filename)?;
    headers.insert(
      axum::http::header::CACHE_CONTROL,
      cache_control.parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    info!(%workspace_uuid, key = %key, start, end, total_len, "served ranged blob download");
    return Ok(response);
  }

  let mut response = axum::response::Response::new(axum::body::Body::from(data));
  *response.status_mut() = StatusCode::OK;
  let headers = response.headers_mut();
  headers.insert(
    axum::http::header::CONTENT_TYPE,
    content_type.parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  headers.insert(
    axum::http::header::ACCEPT_RANGES,
    "bytes".parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  headers.insert(
    axum::http::header::CONTENT_LENGTH,
    total_len
      .to_string()
      .parse()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  secure_download_headers(headers, &content_type, &filename)?;
  headers.insert(
    axum::http::header::CACHE_CONTROL,
    cache_control.parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  info!(%workspace_uuid, key = %key, total_len, "served full blob download");
  Ok(response)
}

/// `GET /api/workspaces/{workspace_id}/docs/{doc_id}/comment-attachments/{key}` — download a comment attachment.
///
/// Requires a valid session with at least workspace read permission.  Serves
/// the file with `Cache-Control: private, max-age=2592000, immutable` because
/// comment attachments are content-addressed and never mutated after upload.
#[instrument(skip_all)]
pub(crate) async fn comment_attachment_handler(
  State(state): State<ApiState>,
  Path((workspace_id, doc_id, key)): Path<(String, String, String)>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let document_key = myoxus_domain::document_key::DocumentKey::parse(doc_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let user_id = crate::require_workspace_read_user(&state, &headers, workspace_uuid).await?;
  let authorized = crate::document_access::authorize_workspace_document(
    &state,
    user_id,
    workspace_uuid,
    myoxus_application::doc::DocSpaceKind::Workspace,
    &document_key,
    myoxus_domain::permission::DocAction::CommentsRead,
  )
  .await
  .map_err(crate::document_access::status_from_auth_error)?;
  let doc_uuid = authorized.doc_id;
  let attachment = state
    .blob()
    .comment_attachment_download(workspace_uuid, doc_uuid, &key)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;
  let storage_key = format!("{workspace_uuid}/{}", attachment.storage_key);
  let blob = state
    .storage()
    .read_blob(&storage_key)
    .await
    .map_err(|_| StatusCode::NOT_FOUND)?;
  let mime = attachment.mime_type;
  let size = attachment.size_bytes as usize;
  let filename = key.split('/').next_back().unwrap_or("attachment.bin");
  let mut response = blob.data.to_vec().into_response();
  response.headers_mut().insert(
    axum::http::header::CONTENT_TYPE,
    mime.parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  response.headers_mut().insert(
    axum::http::header::CONTENT_LENGTH,
    size
      .to_string()
      .parse()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  secure_download_headers(response.headers_mut(), &mime, filename)?;
  response.headers_mut().insert(
    axum::http::header::CACHE_CONTROL,
    "private, max-age=2592000, immutable"
      .parse()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  Ok(response)
}
