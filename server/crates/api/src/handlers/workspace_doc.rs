//! REST workspace-doc fetch, history, and renderer endpoint handlers.
//!
//! Implements the workspace-document REST surface:
//! - `GET /api/workspaces/{id}/docs/{doc_id}` — fetch current Yjs doc binary
//! - `GET /api/workspaces/{id}/docs/{doc_id}/history` — list doc snapshots
//! - `GET /api/workspaces/{id}/docs/{doc_id}/history/{ts}` — fetch a snapshot
//! - `POST /api/workspaces/{id}/docs/{doc_id}/history/{ts}` — restore a snapshot
//! - `GET /rpc/workspaces/{id}/docs/{doc_id}/render` — server-side Markdown render

use std::collections::HashSet;

use axum::{
  Json,
  extract::{Path, Query, State},
  http::{HeaderMap, HeaderValue, StatusCode, header},
  response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use tracing::{debug, error, instrument, warn};
use uuid::Uuid;

use myoxus_application::doc::DocSpaceKind;
use myoxus_domain::{document_key::DocumentKey, permission::DocAction};

use crate::state::ApiState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewQuery {
  format: Option<String>,
  color_scheme: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewErrorBody {
  code: &'static str,
  message: &'static str,
  retry_after_ms: Option<u64>,
}

/// Authorized private Page preview. Cached bytes never bypass either the
/// initial ACL check or the final check immediately before delivery.
#[instrument(skip_all)]
pub(crate) async fn workspace_doc_preview_handler(
  State(state): State<ApiState>,
  Path((workspace_id, guid)): Path<(String, String)>,
  Query(query): Query<PreviewQuery>,
  headers: HeaderMap,
) -> Response {
  match workspace_doc_preview(state, workspace_id, guid, query, headers).await {
    Ok(response) => response,
    Err((status, body, retry_after_seconds)) => {
      let mut response = (status, Json(body)).into_response();
      response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
      response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
      if let Some(seconds) = retry_after_seconds {
        if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
          response.headers_mut().insert(header::RETRY_AFTER, value);
        }
      }
      response
    }
  }
}

type PreviewHttpError = (StatusCode, PreviewErrorBody, Option<u64>);

async fn workspace_doc_preview(
  state: ApiState,
  workspace_id: String,
  guid: String,
  query: PreviewQuery,
  headers: HeaderMap,
) -> Result<Response, PreviewHttpError> {
  let request_started = std::time::Instant::now();
  let workspace_id =
    Uuid::parse_str(&workspace_id).map_err(|_| preview_http_error(StatusCode::BAD_REQUEST, "invalid_request", None))?;
  let document_key = crate::handlers::rpc::parse_document_key_or_pseudo_not_found(&guid)
    .map_err(|status| preview_http_error(status, "document_not_found", None))?;
  let actor_id = crate::require_workspace_read_user(&state, &headers, workspace_id)
    .await
    .map_err(|status| preview_http_error(status, "access_denied", None))?;
  let authorized = crate::document_access::authorize_workspace_document(
    &state,
    actor_id,
    workspace_id,
    DocSpaceKind::Workspace,
    &document_key,
    DocAction::Read,
  )
  .await
  .map_err(crate::document_access::status_from_auth_error)
  .map_err(|status| preview_http_error(status, "access_denied", None))?;
  let doc_id = authorized.doc_id;
  let format = match query.format.as_deref().unwrap_or("svg") {
    "svg" => crate::preview::CachedPreviewFormat::Svg,
    "png" => crate::preview::CachedPreviewFormat::Png,
    _ => return Err(preview_http_error(StatusCode::BAD_REQUEST, "invalid_format", None)),
  };
  let color_scheme = match query.color_scheme.as_deref() {
    None => None,
    Some("light") => Some(crate::preview::PreviewColorScheme::Light),
    Some("dark") => Some(crate::preview::PreviewColorScheme::Dark),
    Some(_) => {
      return Err(preview_http_error(
        StatusCode::BAD_REQUEST,
        "invalid_color_scheme",
        None,
      ));
    }
  };
  let request_permit = state
    .preview_runtime
    .try_admit_request()
    .map_err(preview_operation_http_error)?;
  let config = {
    let overrides = state.config_overrides.read().await;
    crate::config_reload::resolve_preview_config(&state.config, &overrides)
  };
  let identity = current_preview_identity(&state, workspace_id, doc_id).await?;
  if !identity.public_mode.eq_ignore_ascii_case("page") {
    return Err(preview_http_error(
      StatusCode::UNPROCESSABLE_ENTITY,
      "unsupported_mode",
      None,
    ));
  }

  let operation_state = state.clone();
  let operation_config = config.clone();
  let mut operation = tokio::spawn(async move {
    // Admission remains occupied if the HTTP waiter times out. Dropping the
    // JoinHandle detaches this task, so Moka's per-key initializer and any
    // blocking renderer retain their ownership until the work actually ends.
    let _request_permit = request_permit;
    let mut attempts = 0u32;
    let mut render_identity = identity.clone();
    loop {
      match operation_state
        .preview_runtime
        .render(
          actor_id,
          operation_state.clone(),
          workspace_id,
          doc_id,
          render_identity.clone(),
          operation_config.clone(),
          format,
          color_scheme,
        )
        .await
      {
        Err(crate::preview::PreviewOperationError::Stale) if attempts < operation_config.retry_count => {
          attempts += 1;
          render_identity = operation_state
            .doc()
            .store()
            .preview_source_identity(workspace_id, doc_id)
            .await
            .map_err(|error| crate::preview::PreviewOperationError::Unavailable(error.to_string()))?
            .filter(|identity| !identity.deleted)
            .ok_or_else(|| crate::preview::PreviewOperationError::Unavailable("document is unavailable".to_string()))?;
        }
        result => break result,
      }
    }
  });
  let (preview, cache_hit, cache_key) = tokio::time::timeout(
    std::time::Duration::from_millis(config.request_timeout_ms),
    &mut operation,
  )
  .await
  .map_err(|_| preview_operation_http_error(crate::preview::PreviewOperationError::Timeout))?
  .map_err(|_| {
    preview_operation_http_error(crate::preview::PreviewOperationError::Unavailable(
      "preview operation task failed".to_string(),
    ))
  })?
  .map_err(preview_operation_http_error)?;

  // Revocation, deletion and updates racing the render all fail closed here.
  crate::document_access::authorize_workspace_document(
    &state,
    actor_id,
    workspace_id,
    DocSpaceKind::Workspace,
    &document_key,
    DocAction::Read,
  )
  .await
  .map_err(crate::document_access::status_from_auth_error)
  .map_err(|status| preview_http_error(status, "access_denied", None))?;
  let final_identity = current_preview_identity(&state, workspace_id, doc_id).await?;
  if final_identity.revision != cache_key.revision
    || final_identity.metadata_revision != cache_key.metadata_revision
    || final_identity.title != cache_key.title
    || final_identity.public_mode != cache_key.public_mode
    || final_identity.deleted
  {
    return Err(preview_http_error(StatusCode::CONFLICT, "preview_stale", Some(1)));
  }
  state
    .preview_runtime
    .validate_delivery(&state, workspace_id, &cache_key, &preview, color_scheme)
    .await
    .map_err(preview_operation_http_error)?;
  if preview.empty {
    return Ok((StatusCode::NO_CONTENT, [(header::CACHE_CONTROL, "private, no-store")]).into_response());
  }

  // Conditional requests share the full authorization and freshness path above.
  // An ETag is a representation validator, never permission to reuse an image.
  let not_modified = preview_not_modified(&headers, &preview.etag);
  let mut response = if not_modified {
    StatusCode::NOT_MODIFIED.into_response()
  } else {
    preview.output.bytes.clone().into_response()
  };
  response.headers_mut().insert(
    header::ETAG,
    HeaderValue::from_str(&preview.etag).expect("quoted SHA-256 is a header value"),
  );
  response.headers_mut().append(
    header::VARY,
    HeaderValue::from_static("Cookie, Authorization, Accept-Encoding"),
  );
  response
    .headers_mut()
    .insert(header::CONTENT_TYPE, HeaderValue::from_static(preview.output.mime_type));
  response.headers_mut().insert(
    header::CACHE_CONTROL,
    HeaderValue::from_static("private, no-cache, must-revalidate"),
  );
  response
    .headers_mut()
    .insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
  response.headers_mut().insert(
    "x-doc-revision",
    HeaderValue::from_str(&cache_key.revision.to_string()).expect("integer revision is a header value"),
  );
  response.headers_mut().insert(
    "x-preview-width",
    HeaderValue::from_str(&preview.output.width.to_string()).expect("integer width is a header value"),
  );
  response.headers_mut().insert(
    "x-preview-height",
    HeaderValue::from_str(&preview.output.height.to_string()).expect("integer height is a header value"),
  );
  response.headers_mut().insert(
    "x-preview-content-height",
    HeaderValue::from_str(&preview.output.content_height.to_string())
      .expect("integer content height is a header value"),
  );
  response.headers_mut().insert(
    "x-preview-partial",
    HeaderValue::from_static(if preview.output.partial { "true" } else { "false" }),
  );
  response.headers_mut().insert(
    "x-preview-truncated",
    HeaderValue::from_static(if preview.output.truncated { "true" } else { "false" }),
  );
  response.headers_mut().insert(
    "x-preview-cache",
    HeaderValue::from_static(if cache_hit { "hit" } else { "miss" }),
  );
  if format == crate::preview::CachedPreviewFormat::Svg {
    response.headers_mut().insert(
      header::CONTENT_SECURITY_POLICY,
      HeaderValue::from_static("default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"),
    );
  }
  debug!(
    %workspace_id,
    %doc_id,
    ?format,
    revision = cache_key.revision,
    cache_hit,
    response_status = response.status().as_u16(),
    response_body_bytes = if not_modified { 0 } else { preview.output.bytes.len() },
    elapsed_ms = request_started.elapsed().as_millis() as u64,
    "delivered private document preview"
  );
  Ok(response)
}

/// GET uses weak entity-tag comparison (RFC 9110 section 13.1.2).
/// Scan quoted tags because commas are legal inside opaque entity-tag values.
fn preview_not_modified(headers: &HeaderMap, etag: &str) -> bool {
  let etag = etag.strip_prefix("W/").unwrap_or(etag);
  headers.get_all(header::IF_NONE_MATCH).iter().any(|value| {
    let mut remaining = value.as_bytes().trim_ascii();
    while !remaining.is_empty() {
      remaining = remaining.trim_ascii_start();
      if remaining == b"*" {
        return true;
      }
      if remaining.starts_with(b",") {
        remaining = &remaining[1..];
        continue;
      }
      if remaining.starts_with(b"W/") {
        remaining = &remaining[2..];
      }
      if !remaining.starts_with(b"\"") {
        return false;
      }
      let Some(end) = remaining[1..].iter().position(|byte| *byte == b'"').map(|end| end + 1) else {
        return false;
      };
      let candidate = &remaining[..=end];
      remaining = remaining[end + 1..].trim_ascii_start();
      if !remaining.is_empty() && !remaining.starts_with(b",") {
        return false;
      }
      if candidate == etag.as_bytes() {
        return true;
      }
    }
    false
  })
}

async fn current_preview_identity(
  state: &ApiState,
  workspace_id: Uuid,
  doc_id: Uuid,
) -> Result<myoxus_application::doc::DocPreviewSourceIdentity, PreviewHttpError> {
  let identity = state
    .doc()
    .store()
    .preview_source_identity(workspace_id, doc_id)
    .await
    .map_err(|error| {
      error!(%workspace_id, %doc_id, %error, "preview source identity read failed");
      preview_http_error(StatusCode::SERVICE_UNAVAILABLE, "preview_unavailable", Some(1))
    })?
    .ok_or_else(|| preview_http_error(StatusCode::NOT_FOUND, "document_not_found", None))?;
  if identity.deleted {
    return Err(preview_http_error(StatusCode::NOT_FOUND, "document_not_found", None));
  }
  Ok(identity)
}

fn preview_operation_http_error(error: crate::preview::PreviewOperationError) -> PreviewHttpError {
  use crate::preview::PreviewOperationError;
  match error {
    PreviewOperationError::Busy => preview_http_error(StatusCode::TOO_MANY_REQUESTS, "preview_busy", Some(1)),
    PreviewOperationError::Timeout => preview_http_error(StatusCode::SERVICE_UNAVAILABLE, "preview_timeout", Some(1)),
    PreviewOperationError::Stale => preview_http_error(StatusCode::CONFLICT, "preview_stale", Some(1)),
    PreviewOperationError::Unsupported => {
      preview_http_error(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_mode", None)
    }
    PreviewOperationError::Limit => preview_http_error(StatusCode::UNPROCESSABLE_ENTITY, "preview_limit", None),
    PreviewOperationError::Invalid => preview_http_error(StatusCode::UNPROCESSABLE_ENTITY, "preview_invalid", None),
    PreviewOperationError::Unavailable(_) => {
      preview_http_error(StatusCode::SERVICE_UNAVAILABLE, "preview_unavailable", Some(1))
    }
  }
}

fn preview_http_error(status: StatusCode, code: &'static str, retry_after_seconds: Option<u64>) -> PreviewHttpError {
  (
    status,
    PreviewErrorBody {
      code,
      message: code,
      retry_after_ms: retry_after_seconds.map(|seconds| seconds * 1_000),
    },
    retry_after_seconds,
  )
}

/// Truncate `input` to `max_len` Unicode scalar values, appending `"..."` if truncated.
pub(crate) fn truncate_chars(input: &str, max_len: usize) -> String {
  if input.chars().count() <= max_len {
    return input.to_string();
  }
  let mut out = input.chars().take(max_len).collect::<String>();
  out.push_str("...");
  out
}

/// Render the captured shell after the caller has resolved sharing policy.
pub(crate) fn render_workspace_html(
  state: &ApiState,
  title: Option<&str>,
  summary: Option<&str>,
  avatar: Option<&str>,
  indexable: bool,
) -> Result<String, StatusCode> {
  use myoxus_public_render::response_pages::{WorkspacePageContext, render_workspace_page};
  let renderer = state.html_renderer().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  render_workspace_page(
    renderer,
    &WorkspacePageContext {
      title,
      summary,
      avatar,
      indexable,
    },
  )
  .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// Parse a doc-history timestamp from either a millisecond Unix epoch integer
/// string or an RFC 3339 datetime string.
///
/// Returns `None` if the string cannot be parsed in either format.
pub(crate) fn parse_history_timestamp(timestamp: &str) -> Option<chrono::DateTime<chrono::Utc>> {
  if let Ok(raw_millis) = timestamp.parse::<i64>() {
    return chrono::DateTime::<chrono::Utc>::from_timestamp_millis(raw_millis);
  }
  chrono::DateTime::parse_from_rfc3339(timestamp)
    .ok()
    .map(|dt| dt.with_timezone(&chrono::Utc))
}

/// `GET /api/workspaces/{workspace_id}/docs/{guid}` — download the current merged Yjs binary for a document.
///
/// Merges the latest snapshot and all pending updates server-side and returns the
/// combined binary as `application/octet-stream`.  Adds a `publish-mode` response
/// header for publicly shared documents.
#[instrument(skip_all)]
pub(crate) async fn workspace_doc_handler(
  State(state): State<ApiState>,
  Path((workspace_id, guid)): Path<(String, String)>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|e| {
    warn!(workspace_id = %workspace_id, error = %e, "workspace doc: invalid workspace UUID");
    StatusCode::BAD_REQUEST
  })?;
  let document_key = crate::handlers::rpc::parse_document_key_or_pseudo_not_found(&guid)?;
  let user_id = crate::require_workspace_read_user(&state, &headers, workspace_uuid).await?;
  let authorized = crate::document_access::authorize_workspace_document(
    &state,
    user_id,
    workspace_uuid,
    DocSpaceKind::Workspace,
    &document_key,
    DocAction::Read,
  )
  .await
  .map_err(crate::document_access::status_from_auth_error)?;
  let doc_uuid = authorized.doc_id;
  let doc_result = state
    .doc()
    .load_full_doc_with_meta(workspace_uuid, doc_uuid)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  if !doc_result.exists {
    warn!(workspace_id = %workspace_uuid, doc_id = %doc_uuid, "doc not found");
    return Err(StatusCode::NOT_FOUND);
  }
  let payload = doc_result.payload;
  debug!(%workspace_uuid, %doc_uuid, response_bytes = payload.len(), "serving workspace doc");
  let mut response = payload.into_response();
  response.headers_mut().insert(
    axum::http::header::CONTENT_TYPE,
    "application/octet-stream"
      .parse()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  let metadata = state.doc().get_doc_metadata(doc_uuid).await.map_err(|e| {
    error!(workspace_id = %workspace_uuid, doc_id = %doc_uuid, error = %e, "document metadata lookup failed");
    StatusCode::INTERNAL_SERVER_ERROR
  })?;
  let publish_mode = metadata
    .and_then(|doc| doc.public_mode)
    .map(|v| {
      if v.eq_ignore_ascii_case("edgeless") {
        "edgeless"
      } else {
        "page"
      }
    })
    .unwrap_or("page");
  response.headers_mut().insert(
    "publish-mode",
    publish_mode.parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  Ok(response)
}

/// `GET /api/workspaces/{workspace_id}/docs/{guid}/histories/{timestamp}` — fetch a historical snapshot.
///
/// Returns the most recent `doc_histories` entry at or before `timestamp`
/// (accepted as Unix milliseconds or RFC 3339).  The payload is served
/// with `Cache-Control: immutable` because history entries are never mutated.
#[instrument(skip_all)]
pub(crate) async fn workspace_doc_history_handler(
  State(state): State<ApiState>,
  Path((workspace_id, guid, timestamp)): Path<(String, String, String)>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let ts = parse_history_timestamp(&timestamp).ok_or(StatusCode::BAD_REQUEST)?;
  read_history_snapshot(state, workspace_id, guid, headers, None, Some(ts)).await
}

/// Exact immutable snapshot read. Authorization is shared with the deployed
/// timestamp endpoint; a snapshot from another document is never substituted.
pub(crate) async fn workspace_doc_history_by_id_handler(
  State(state): State<ApiState>,
  Path((workspace_id, guid, history_id)): Path<(String, String, String)>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let id = history_id
    .parse::<i64>()
    .ok()
    .filter(|id| *id > 0)
    .ok_or(StatusCode::BAD_REQUEST)?;
  read_history_snapshot(state, workspace_id, guid, headers, Some(id), None).await
}

async fn read_history_snapshot(
  state: ApiState,
  workspace_id: String,
  guid: String,
  headers: HeaderMap,
  history_id: Option<i64>,
  timestamp: Option<chrono::DateTime<chrono::Utc>>,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|e| {
    warn!(workspace_id = %workspace_id, error = %e, "doc history: invalid workspace UUID");
    StatusCode::BAD_REQUEST
  })?;
  let document_key = crate::handlers::rpc::parse_document_key_or_pseudo_not_found(&guid)?;
  let user_id = crate::require_workspace_read_user(&state, &headers, workspace_uuid).await?;
  let authorized = crate::document_access::authorize_workspace_document(
    &state,
    user_id,
    workspace_uuid,
    DocSpaceKind::Workspace,
    &document_key,
    DocAction::Read,
  )
  .await
  .map_err(crate::document_access::status_from_auth_error)?;
  let doc_uuid = authorized.doc_id;
  let lookup = match (history_id, timestamp) {
    (Some(id), None) => state.doc().history_entry(id).await,
    (None, Some(ts)) => state.doc().history_at_or_before(workspace_uuid, doc_uuid, ts).await,
    _ => return Err(StatusCode::BAD_REQUEST),
  };
  let entry = lookup
    .map_err(|error| {
      error!(workspace_id = %workspace_uuid, doc_id = %doc_uuid, %error, "document history lookup failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?
    .ok_or_else(|| {
      warn!(workspace_id = %workspace_uuid, doc_id = %doc_uuid, "doc history not found");
      StatusCode::NOT_FOUND
    })?;
  if entry.doc_id != doc_uuid || entry.workspace_id != workspace_uuid {
    return Err(StatusCode::NOT_FOUND);
  }
  let mut response = entry.snapshot.into_response();
  response.headers_mut().insert(
    axum::http::header::CONTENT_TYPE,
    "application/octet-stream"
      .parse()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  response.headers_mut().insert(
    axum::http::header::CACHE_CONTROL,
    // Raw history is immutable; its committed reference lineage is not.
    // Undo can revisit this same workspace/history URL with another mapping.
    "private, no-store"
      .parse()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  Ok(response)
}

/// `GET /workspace` — serve a minimal HTML shell for the workspace root path.
///
/// Returns a generic Open Graph page (no workspace-specific metadata) because
/// no workspace ID is available at this path level.
#[instrument(skip_all)]
pub(crate) async fn workspace_renderer_root_handler(
  State(state): State<ApiState>,
) -> Result<impl IntoResponse, StatusCode> {
  Ok((
    StatusCode::OK,
    [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
    render_workspace_html(&state, None, None, None, false)?,
  ))
}

/// `GET /workspace/{*path}` — serve workspace/document Open Graph HTML pages.
///
/// Parses the path to extract a workspace ID and optional document ID, then
/// queries the database for sharing settings and metadata.  Returns an HTML
/// page with `<meta>` Open Graph tags populated from the doc/workspace data.
///
/// If the workspace or document has sharing disabled, or if the request cannot
/// be resolved, a generic non-indexable HTML shell is returned.  Requests that
/// include Markdown in `Accept` headers receive `text/markdown` for crawlers
/// that support content negotiation.
#[instrument(skip_all)]
pub(crate) async fn workspace_renderer_handler(
  State(state): State<ApiState>,
  Path(path): Path<String>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let trimmed = path.trim_matches('/');
  if trimmed.is_empty() {
    return Ok((
      StatusCode::OK,
      [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
      render_workspace_html(&state, None, None, None, false)?,
    ));
  }

  let static_paths = HashSet::from(["all", "home", "search", "collection", "tag", "trash"]);
  let markdown_types = HashSet::from(["text/markdown", "application/markdown", "text/x-markdown"]);
  let segments = trimmed.split('/').collect::<Vec<_>>();
  let Some(workspace_raw) = segments.first() else {
    return Ok((
      StatusCode::OK,
      [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
      render_workspace_html(&state, None, None, None, false)?,
    ));
  };
  let Ok(workspace_id) = Uuid::parse_str(workspace_raw) else {
    return Ok((
      StatusCode::OK,
      [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
      render_workspace_html(&state, None, None, None, false)?,
    ));
  };
  let workspace = state.workspace().get_workspace(workspace_id).await.map_err(|error| {
    error!(%workspace_id, %error, "renderer workspace lookup failed");
    StatusCode::INTERNAL_SERVER_ERROR
  })?;

  let sub = segments.get(1).copied();
  let is_workspace_path =
    sub.is_none() || sub.map(|value| static_paths.contains(value)).unwrap_or(false) || segments.len() > 2;
  let is_doc_path = sub.is_some() && !is_workspace_path && sub != Some(*workspace_raw) && segments.len() == 2;

  if is_doc_path {
    let doc_raw = sub.unwrap_or_default();
    let Ok(document_key) = DocumentKey::parse(doc_raw) else {
      return Ok((
        StatusCode::NOT_FOUND,
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        render_workspace_html(&state, None, None, None, false)?,
      ));
    };
    let Some(doc_id) = state
      .doc()
      .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &document_key)
      .await
      .map_err(|error| {
        error!(%workspace_id, %error, "renderer document-key resolution failed");
        StatusCode::INTERNAL_SERVER_ERROR
      })?
    else {
      return Ok((
        StatusCode::NOT_FOUND,
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        render_workspace_html(&state, None, None, None, false)?,
      ));
    };
    let metadata = state.doc().get_doc_metadata(doc_id).await.map_err(|error| {
      error!(workspace_id = %workspace_id, doc_id = %doc_id, %error, "renderer document lookup failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let Some(metadata) = metadata.filter(|doc| doc.workspace_id == Some(workspace_id)) else {
      warn!(workspace_id = %workspace_id, doc_id = %doc_id, "renderer: doc not found");
      return Ok((
        StatusCode::NOT_FOUND,
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        render_workspace_html(&state, None, None, None, false)?,
      ));
    };
    let Some(workspace) = workspace.as_ref() else {
      return Ok((
        StatusCode::NOT_FOUND,
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        render_workspace_html(&state, None, None, None, false)?,
      ));
    };
    let allow_preview = workspace.enable_sharing && (workspace.enable_url_preview || metadata.public_mode.is_some());
    if !allow_preview {
      return Ok((
        StatusCode::NOT_FOUND,
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        render_workspace_html(&state, None, None, None, false)?,
      ));
    }
    let title = metadata.title;
    let summary = if let Some(repository) = state.search_repository() {
      repository
        .get_search_doc(workspace_id, doc_id)
        .await
        .map_err(|error| {
          error!(%workspace_id, %doc_id, %error, "renderer search projection lookup failed");
          StatusCode::INTERNAL_SERVER_ERROR
        })?
        .map(|doc| doc.plain_text)
        .unwrap_or_default()
    } else {
      String::new()
    };
    let accept = headers
      .get(axum::http::header::ACCEPT)
      .and_then(|v| v.to_str().ok())
      .unwrap_or_default()
      .to_ascii_lowercase();
    if markdown_types.iter().any(|t| accept.contains(t)) {
      let markdown = format!("# {}\n\n{}\n", title, summary);
      return Ok((
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
        markdown,
      ));
    }
    let avatar = workspace
      .avatar_key
      .clone()
      .map(|value| format!("{}/api/avatars/{}", state.config.server.origin, value));
    return Ok((
      StatusCode::OK,
      [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
      render_workspace_html(
        &state,
        Some(&title),
        Some(&truncate_chars(&summary, 260)),
        avatar.as_deref(),
        true,
      )?,
    ));
  }

  let Some(workspace) = workspace else {
    return Ok((
      StatusCode::OK,
      [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
      render_workspace_html(&state, None, None, None, false)?,
    ));
  };
  if !(workspace.enable_sharing && workspace.enable_url_preview) {
    return Ok((
      StatusCode::OK,
      [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
      render_workspace_html(&state, None, None, None, false)?,
    ));
  }
  let title = workspace.name;
  let avatar = workspace
    .avatar_key
    .map(|value| format!("{}/api/avatars/{}", state.config.server.origin, value));
  Ok((
    StatusCode::OK,
    [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
    render_workspace_html(&state, Some(&title), None, avatar.as_deref(), true)?,
  ))
}

#[cfg(test)]
mod preview_validator_tests {
  use super::*;

  #[test]
  fn get_validator_uses_weak_comparison_and_preserves_quoted_commas() {
    for (input, expected) in [
      ("\"current\"", true),
      ("W/\"current\"", true),
      (" \t* \t", true),
      ("\"other,tag\", W/\"current\"", true),
      (", , \"current\",", true),
      ("\"other\"", false),
      ("\"other, W/\"current\"", false),
      ("current", false),
      ("\"current\"suffix", false),
      ("w/\"current\"", false),
    ] {
      let mut headers = HeaderMap::new();
      headers.append(header::IF_NONE_MATCH, HeaderValue::from_static(input));
      assert_eq!(preview_not_modified(&headers, "\"current\""), expected, "{input}");
    }
    let mut headers = HeaderMap::new();
    headers.append(header::IF_NONE_MATCH, HeaderValue::from_static("\"other\""));
    headers.append(header::IF_NONE_MATCH, HeaderValue::from_static("W/\"current\""));
    assert!(preview_not_modified(&headers, "\"current\""));
  }
}
