//! Internal doc-content RPC endpoint handler.
//!
//! Implements `GET /rpc/workspaces/{workspace_id}/docs/{doc_id}` which exposes
//! raw Yjs document binary content for server-to-server consumption (e.g. renderer
//! service, search indexer). The response is base64-encoded Yjs state-vector bytes.

use base64::Engine;

use axum::{
  body::Bytes,
  extract::{Path, Query, State},
  http::{HeaderMap, StatusCode},
  response::{IntoResponse, Json},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{instrument, trace};
use uuid::Uuid;

use myoxus_application::doc::DocSpaceKind;
use myoxus_application::markdown::{AuthorizedMarkdownDocument, MarkdownProjectionPolicy, MarkdownReferenceLookup};
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::permission::DocAction;

use crate::state::ApiState;

/// Optional query parameters for RPC doc-content and markdown endpoints.
#[derive(Debug, Deserialize)]
pub(crate) struct RpcDocQuery {
  /// When `"true"`, appends the full base64-encoded Yjs state to the plain-text response.
  full: Option<String>,
  /// When `"true"`, the markdown response includes a trailing newline for AI editor compatibility.
  #[serde(rename = "aiEditable")]
  ai_editable: Option<String>,
}

/// JSON body returned by the doc-content and workspace-content RPC endpoints.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RpcDocContentResponse {
  /// UUID string of the owning workspace.
  workspace_id: String,
  /// Canonical workspace-local external document key.
  external_id: String,
  /// Deprecated same-value alias for `external_id`.
  doc_id: String,
  /// Human-readable document title.
  title: String,
  /// Plain-text representation extracted by the search indexer.
  plain_text: String,
  /// Timestamp of the last write to the document.
  updated_at: chrono::DateTime<chrono::Utc>,
}

/// Validate a client-visible document key, treating `db$` projections as 404.
///
/// NestJS-style pseudo-doc IDs (e.g. `"db$root"`) are used for internal
/// database-backed docs that have no Yjs content.  We surface these as
/// `NOT_FOUND` rather than a parse error to preserve the original API contract.
pub(crate) fn parse_document_key_or_pseudo_not_found(doc_id: &str) -> Result<DocumentKey, StatusCode> {
  if doc_id.starts_with("db$") {
    return Err(StatusCode::NOT_FOUND);
  }
  DocumentKey::parse(doc_id).map_err(|_| StatusCode::BAD_REQUEST)
}

/// `GET /rpc/workspaces/{workspace_id}/docs/{doc_id}` — rohes gemergtes Yjs-Binary zurückgeben.
///
/// Lädt den vollständig gemergten Yjs-Payload via [`DocService::load_full_doc_with_meta`]
/// und liefert ihn als Response-Body zurück.
///
/// # Auth
///
/// Erfordert Workspace-Read-Berechtigung (`require_workspace_read_user`). Anfragen ohne
/// gültige Session (Cookie oder Bearer-Token) erhalten `401 Unauthorized`.
///
/// # Response
///
/// - Body: rohes Yjs-Binary (application/octet-stream)
/// - Header `X-Doc-Timestamp`: Millisekunden-Timestamp des letzten Snapshot-Writes aus der DB
/// - `404 Not Found` wenn Dokument nicht existiert oder `deleted_at IS NOT NULL`
///
/// # Proxy-Modus
///
/// Wenn `config.doc_service.endpoint` gesetzt ist, wird die Anfrage an den
/// Remote-Doc-Service weitergeleitet statt lokal verarbeitet. Cookies werden
/// transparent weitergegeben.
#[instrument(skip_all)]
pub(crate) async fn rpc_get_doc_handler(
  State(state): State<ApiState>,
  Path((workspace_id, doc_id)): Path<(String, String)>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let document_key = parse_document_key_or_pseudo_not_found(&doc_id)?;
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
  if let Some(endpoint) = remote_doc_service_endpoint(&state) {
    let timeout = std::time::Duration::from_secs(state.config.http.proxy_timeout_seconds);
    return proxy_doc_service_get(
      state.http_client(),
      &endpoint,
      &format!("/rpc/workspaces/{workspace_id}/docs/{doc_id}"),
      &headers,
      None,
      timeout,
    )
    .await;
  }
  let doc_uuid = authorized.doc_id;
  // P102-VIEW-03: Use load_full_doc_with_tracking so REST doc loads also record
  // analytics. Tracking is fire-and-forget; response is not delayed.
  let workspace_svc = state.workspace().clone();
  let result = state
    .doc()
    .load
    .load_full_doc_with_tracking(workspace_uuid, doc_uuid, user_id, true, workspace_svc)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  if !result.exists {
    trace!(%workspace_uuid, %doc_uuid, "rpc doc not found");
    return Err(StatusCode::NOT_FOUND);
  }
  trace!(%workspace_uuid, %doc_uuid, size = result.payload.len(), "rpc doc served");
  let mut response = result.payload.into_response();
  if let Some(ts) = result.updated_at.map(|dt| dt.timestamp_millis().to_string())
    && let Ok(value) = ts.parse()
  {
    response.headers_mut().insert("x-doc-timestamp", value);
  }
  Ok(response)
}

/// `POST /rpc/workspaces/{workspace_id}/docs/{doc_id}/diff` — Yjs-Diff gegen einen State-Vector berechnen.
///
/// Der Request-Body ist der aktuelle Yjs-State-Vector des Aufrufers (rohes Binary).
/// Der Response-Body ist die Konkatenation von Missing-Diff und neuem Server-State-Vector.
/// Drei Custom-Header geben die genauen Byte-Bereiche an:
///
/// - `X-Doc-Missing-Offset` — `"start,end"` Byte-Range des Diff-Teils im Response-Body
/// - `X-Doc-State-Offset` — `"start,end"` Byte-Range des State-Vector-Teils im Response-Body
/// - `X-Doc-Timestamp` — Millisekunden-Timestamp des letzten DB-Writes
///
/// Wenn der Request-Body leer ist (kein State-Vector), wird das vollständige Dokument
/// als Diff zurückgegeben.
///
/// # Auth
///
/// Erfordert Workspace-Read-Berechtigung. Identisch zu [`rpc_get_doc_handler`].
///
/// # Proxy-Modus
///
/// Identisch zu [`rpc_get_doc_handler`] — Request wird bei konfiguriertem Remote-Endpoint
/// transparent weitergeleitet inkl. Body und Auth-Cookies.
#[instrument(skip_all)]
pub(crate) async fn rpc_get_doc_diff_handler(
  State(state): State<ApiState>,
  Path((workspace_id, doc_id)): Path<(String, String)>,
  headers: HeaderMap,
  body: Bytes,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let document_key = parse_document_key_or_pseudo_not_found(&doc_id)?;
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
  if let Some(endpoint) = remote_doc_service_endpoint(&state) {
    let timeout = std::time::Duration::from_secs(state.config.http.proxy_timeout_seconds);
    return proxy_doc_service_post(
      state.http_client(),
      &endpoint,
      &format!("/rpc/workspaces/{workspace_id}/docs/{doc_id}/diff"),
      &headers,
      body,
      None,
      timeout,
    )
    .await;
  }
  let doc_uuid = authorized.doc_id;
  let result = state
    .doc()
    .load_full_doc_with_meta(workspace_uuid, doc_uuid)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  if !result.exists {
    return Err(StatusCode::NOT_FOUND);
  }
  let payload = result.payload;
  let updated_at = result.updated_at;

  let state_vector = body.to_vec();
  let diff = if state_vector.is_empty() {
    payload.clone()
  } else {
    yjs::get_missing_diff(&payload, &state_vector).map_err(|_| StatusCode::BAD_REQUEST)?
  };
  let new_state = yjs::get_state_vector(&payload).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  let mut combined = Vec::with_capacity(diff.len() + new_state.len());
  combined.extend_from_slice(&diff);
  combined.extend_from_slice(&new_state);
  let mut response = combined.into_response();
  if let Some(ts) = updated_at.map(|dt| dt.timestamp_millis().to_string())
    && let Ok(value) = ts.parse()
  {
    response.headers_mut().insert("x-doc-timestamp", value);
  }
  if let Ok(value) = format!("0,{}", diff.len()).parse() {
    response.headers_mut().insert("x-doc-missing-offset", value);
  }
  if let Ok(value) = format!("{},{}", diff.len(), diff.len() + new_state.len()).parse() {
    response.headers_mut().insert("x-doc-state-offset", value);
  }
  Ok(response)
}

/// `GET /rpc/workspaces/{workspace_id}/docs/{doc_id}/content` — strukturierten Text-Content zurückgeben.
///
/// Gibt Titel und Plain-Text des Dokuments zurück, die vom Search-Indexer in der Tabelle
/// `search_content` gespeichert wurden. Das SQL-Join verbindet `docs` (Basis-Metadaten)
/// mit `search_content` (extrahierter Volltext) via `sd.doc_id = d.id` — fehlt ein
/// Eintrag in `search_content`, ist `plain_text` im Response leer (nicht `null`).
///
/// Gelöschte Dokumente (`deleted_at IS NOT NULL`) werden als `404 Not Found` behandelt.
///
/// # Query-Parameter
///
/// - `full=true` — Hängt das vollständige base64-kodierte Yjs-Binary als `[yjs_base64:...]`-Marker
///   an den `plain_text`-Wert an. Ermöglicht KI-Tooling Zugriff auf die Rohstruktur des Dokuments.
///
/// # Response-Format
///
/// JSON als [`RpcDocContentResponse`] mit `workspaceId`, `externalId`, `docId`, `title`, `plainText`, `updatedAt`.
///
/// # Auth
///
/// Erfordert Workspace-Read-Berechtigung. Identisch zu [`rpc_get_doc_handler`].
#[instrument(skip_all)]
pub(crate) async fn rpc_get_doc_content_handler(
  State(state): State<ApiState>,
  Path((workspace_id, doc_id)): Path<(String, String)>,
  headers: HeaderMap,
  Query(query): Query<RpcDocQuery>,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let document_key = parse_document_key_or_pseudo_not_found(&doc_id)?;
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
  if let Some(endpoint) = remote_doc_service_endpoint(&state) {
    let query = if query.full.is_some() {
      Some(format!("full={}", query.full.as_deref().unwrap_or_default()))
    } else {
      None
    };
    let timeout = std::time::Duration::from_secs(state.config.http.proxy_timeout_seconds);
    return proxy_doc_service_get(
      state.http_client(),
      &endpoint,
      &format!("/rpc/workspaces/{workspace_id}/docs/{doc_id}/content"),
      &headers,
      query.as_deref(),
      timeout,
    )
    .await;
  }
  let doc_uuid = authorized.doc_id;
  let metadata = state
    .doc()
    .get_doc_metadata(doc_uuid)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .filter(|doc| doc.workspace_id == Some(workspace_uuid))
    .ok_or(StatusCode::NOT_FOUND)?;

  // P102-VIEW-07: fire view tracking on content-endpoint access so that
  // server-to-server reads (renderer, AI) also appear in workspace_doc_view_daily.
  state
    .doc()
    .load
    .fire_view_tracking(workspace_uuid, doc_uuid, user_id, true, state.workspace().clone());

  let mut plain_text = if let Some(repository) = state.search_repository() {
    repository
      .get_search_doc(workspace_uuid, doc_uuid)
      .await
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
      .map(|doc| doc.plain_text)
      .unwrap_or_default()
  } else {
    String::new()
  };
  if query.full.as_deref() == Some("true") {
    let doc_result = state
      .doc()
      .load_full_doc_with_meta(workspace_uuid, doc_uuid)
      .await
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if doc_result.exists {
      plain_text = format!(
        "{}\n\n[yjs_base64:{}]",
        plain_text,
        base64::engine::general_purpose::STANDARD.encode(doc_result.payload)
      );
    }
  }
  let resp = RpcDocContentResponse {
    workspace_id,
    external_id: doc_id.clone(),
    doc_id,
    title: metadata.title,
    plain_text,
    updated_at: metadata.updated_at,
  };
  Ok((StatusCode::OK, Json(resp)).into_response())
}

/// `GET /rpc/workspaces/{workspace_id}/docs/{doc_id}/markdown` — return Markdown text.
///
/// Returns the metadata title followed by the canonical current Markdown body.
/// When `aiEditable=true`,
/// a trailing newline is appended so that AI editors can append content cleanly.
#[instrument(skip_all)]
pub(crate) async fn rpc_get_doc_markdown_handler(
  State(state): State<ApiState>,
  Path((workspace_id, doc_id)): Path<(String, String)>,
  headers: HeaderMap,
  Query(query): Query<RpcDocQuery>,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let document_key = parse_document_key_or_pseudo_not_found(&doc_id)?;
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
  if let Some(endpoint) = remote_doc_service_endpoint(&state) {
    let query = if query.ai_editable.is_some() {
      Some(format!(
        "aiEditable={}",
        query.ai_editable.as_deref().unwrap_or_default()
      ))
    } else {
      None
    };
    let timeout = std::time::Duration::from_secs(state.config.http.proxy_timeout_seconds);
    return proxy_doc_service_get(
      state.http_client(),
      &endpoint,
      &format!("/rpc/workspaces/{workspace_id}/docs/{doc_id}/markdown"),
      &headers,
      query.as_deref(),
      timeout,
    )
    .await;
  }
  let doc_uuid = authorized.doc_id;
  let metadata = state
    .doc()
    .get_doc_metadata(doc_uuid)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .filter(|doc| doc.workspace_id == Some(workspace_uuid))
    .ok_or(StatusCode::NOT_FOUND)?;
  let title = metadata.title;
  let payload = state
    .doc()
    .load_full_doc(workspace_uuid, doc_uuid)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  let candidates = state
    .doc()
    .list_workspace_docs(workspace_uuid, 10_001, 0)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  if candidates.len() == 10_001 {
    return Err(StatusCode::PAYLOAD_TOO_LARGE);
  }
  let candidate_ids = candidates.iter().map(|doc| doc.id).collect::<Vec<_>>();
  let readable = state
    .permission_service()
    .readable_doc_ids(user_id, workspace_uuid, &candidate_ids)
    .await
    .map_err(crate::document_access::status_from_auth_error)?;
  let references = MarkdownReferenceLookup::new(
    &format!(
      "{}/workspace/{workspace_uuid}",
      state.config.server.origin.trim_end_matches('/')
    ),
    candidates
      .into_iter()
      .filter(|doc| !doc.blocked && readable.contains(&doc.id))
      .map(|doc| AuthorizedMarkdownDocument {
        external_id: doc.external_id,
        title: doc.title,
      }),
  )
  .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  let body = myoxus_application::markdown::project_document_with_references(
    &payload,
    &title,
    MarkdownProjectionPolicy::default(),
    &references,
  )
  .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
  .markdown;
  let ai_editable = query.ai_editable.as_deref() == Some("true");
  let markdown = if ai_editable {
    format!("# {}\n\n{}\n", title, body)
  } else {
    format!("# {}\n\n{}", title, body)
  };
  Ok((StatusCode::OK, markdown).into_response())
}

/// `GET /rpc/workspaces/{workspace_id}/content` — Text-Content aller Docs eines Workspace (Bulk-Endpoint).
///
/// Gibt die zuletzt aktualisierten 200 Dokumente des Workspace zurück, jedes mit Titel
/// und Plain-Text-Content, sortiert nach `updated_at DESC`. Gedacht für serverseitiges
/// Bulk-Content-Ingestion (z.B. KI-Indexing-Pipelines, Crawler).
///
/// # Limitierung
///
/// Maximal **200 Dokumente** pro Aufruf (hardcodiertes `LIMIT 200` in der SQL-Query).
/// Paginierung wird nicht unterstützt — für vollständige Indexierung muss der Endpoint
/// in regelmäßigen Intervallen aufgerufen werden, da neue Docs an vorderster Stelle
/// erscheinen (`ORDER BY updated_at DESC`).
///
/// # Response-Format
///
/// ```json
/// { "workspaceId": "...", "docs": [ { "workspaceId": "...", "externalId": "...", "docId": "...", "title": "...",
///   "plainText": "...", "updatedAt": "..." }, ... ] }
/// ```
///
/// Docs ohne Search-Indexer-Eintrag (`search_content` leer) haben `plainText: ""`.
/// Gelöschte Docs (`deleted_at IS NOT NULL`) werden nicht zurückgegeben.
///
/// # Auth
///
/// Erfordert Workspace-Read-Berechtigung. Identisch zu [`rpc_get_doc_handler`].
#[instrument(skip_all)]
pub(crate) async fn rpc_get_workspace_content_handler(
  State(state): State<ApiState>,
  Path(workspace_id): Path<String>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let user_id = crate::require_workspace_read_user(&state, &headers, workspace_uuid).await?;
  let docs = state
    .doc()
    .list_content_docs_in_workspace(workspace_uuid, 200)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  let candidate_ids: Vec<Uuid> = docs.iter().map(|doc| doc.id).collect();
  let readable = state
    .permission_service()
    .readable_doc_ids(user_id, workspace_uuid, &candidate_ids)
    .await
    .map_err(crate::document_access::status_from_auth_error)?;
  let search_docs = if let Some(repository) = state.search_repository() {
    repository
      .list_search_docs_by_ids(workspace_uuid, &candidate_ids)
      .await
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
      .into_iter()
      .map(|doc| (doc.doc_id, doc.plain_text))
      .collect::<std::collections::HashMap<_, _>>()
  } else {
    std::collections::HashMap::new()
  };
  let items = docs
    .into_iter()
    .filter(|doc| readable.contains(&doc.id))
    .map(|doc| {
      let external_id = doc.external_id;
      RpcDocContentResponse {
        workspace_id: workspace_id.clone(),
        external_id: external_id.clone(),
        doc_id: external_id,
        title: doc.title,
        plain_text: search_docs.get(&doc.id).cloned().unwrap_or_default(),
        updated_at: doc.updated_at,
      }
    })
    .collect::<Vec<_>>();
  Ok(
    (
      StatusCode::OK,
      Json(json!({ "workspaceId": workspace_id, "docs": items })),
    )
      .into_response(),
  )
}

/// Return the configured remote doc-service base URL, or `None` when the server
/// should handle doc requests locally.
///
/// Returns `None` when `config.doc_service.endpoint` is empty or equals the
/// server's own origin (to prevent self-proxy loops).
/// API-RV-09: Validate that the doc-service endpoint is a trusted destination
/// before forwarding session cookies. Only same-origin or HTTPS endpoints are
/// accepted. Self-proxy loops are rejected.
pub(crate) fn remote_doc_service_endpoint(state: &ApiState) -> Option<String> {
  let endpoint = state.config.doc_service.endpoint.as_ref()?.trim();
  if endpoint.is_empty() {
    return None;
  }
  // Reject self-proxy loop (API-RV-07a: canonical origin comparison)
  if origins_equivalent(endpoint, &state.config.server.origin) {
    return None;
  }
  // Only allow http://localhost and https:// endpoints for cookie forwarding
  let is_localhost = endpoint.starts_with("http://localhost") || endpoint.starts_with("http://127.0.0.1");
  let is_https = endpoint.starts_with("https://");
  if !is_localhost && !is_https {
    tracing::warn!(
      endpoint,
      "doc_service.endpoint rejected: only https:// or localhost allowed for cookie forwarding"
    );
    return None;
  }
  Some(endpoint.trim_end_matches('/').to_string())
}

/// Proxy a GET request to the remote doc service, forwarding auth cookies.
#[instrument(skip_all)]
pub(crate) async fn proxy_doc_service_get(
  client: &reqwest::Client,
  endpoint: &str,
  path: &str,
  headers: &HeaderMap,
  query: Option<&str>,
  timeout: std::time::Duration,
) -> Result<axum::response::Response, StatusCode> {
  let mut url = format!("{endpoint}{path}");
  if let Some(query) = query.filter(|q| !q.trim().is_empty()) {
    url.push('?');
    url.push_str(query);
  }
  proxy_doc_service_request(client, reqwest::Method::GET, &url, headers, None, timeout).await
}

/// Proxy a POST request (with binary body) to the remote doc service.
#[instrument(skip_all)]
pub(crate) async fn proxy_doc_service_post(
  client: &reqwest::Client,
  endpoint: &str,
  path: &str,
  headers: &HeaderMap,
  body: Bytes,
  query: Option<&str>,
  timeout: std::time::Duration,
) -> Result<axum::response::Response, StatusCode> {
  let mut url = format!("{endpoint}{path}");
  if let Some(query) = query.filter(|q| !q.trim().is_empty()) {
    url.push('?');
    url.push_str(query);
  }
  proxy_doc_service_request(client, reqwest::Method::POST, &url, headers, Some(body), timeout).await
}

/// Make an HTTP request to the remote doc service and stream the response back.
///
/// Forwards `Cookie` and `Content-Type` request headers.  Copies
/// `Content-Type`, `Cache-Control`, `Content-Disposition`, and the three
/// `X-Doc-*` custom headers from the upstream response.
///
/// P84-D-01: Accepts a shared `&reqwest::Client` instead of building one per
/// request.  Per-request timeout is applied on the `RequestBuilder`.
#[instrument(skip_all)]
pub(crate) async fn proxy_doc_service_request(
  client: &reqwest::Client,
  method: reqwest::Method,
  url: &str,
  headers: &HeaderMap,
  body: Option<Bytes>,
  timeout: std::time::Duration,
) -> Result<axum::response::Response, StatusCode> {
  let mut request = client.request(method, url).timeout(timeout);

  if let Some(cookie) = headers
    .get(axum::http::header::COOKIE)
    .and_then(|value| value.to_str().ok())
  {
    request = request.header(axum::http::header::COOKIE, cookie);
  }
  if let Some(content_type) = headers
    .get(axum::http::header::CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
  {
    request = request.header(axum::http::header::CONTENT_TYPE, content_type);
  }
  if let Some(body) = body {
    request = request.body(body.to_vec());
  }

  let upstream = request.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
  let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
  let upstream_headers = upstream.headers().clone();
  let bytes = upstream.bytes().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
  let mut response = bytes.into_response();
  *response.status_mut() = status;
  for header in [
    axum::http::header::CONTENT_TYPE,
    axum::http::header::CACHE_CONTROL,
    axum::http::header::CONTENT_DISPOSITION,
  ] {
    if let Some(value) = upstream_headers.get(&header).cloned() {
      response.headers_mut().insert(header, value);
    }
  }
  for header in ["x-doc-timestamp", "x-doc-missing-offset", "x-doc-state-offset"] {
    if let Some(value) = upstream_headers.get(header).cloned() {
      response.headers_mut().insert(header, value);
    }
  }
  Ok(response)
}

/// Canonicalise an origin by stripping the trailing slash and removing the
/// default port for the scheme (`:443` for HTTPS, `:80` for HTTP).
/// This lets us detect self-proxy loops even when one side includes the
/// default port explicitly (e.g. `https://host:443` vs `https://host`).
fn canonical_origin(origin: &str) -> String {
  let s = origin.trim_end_matches('/');
  if let Some(base) = s.strip_suffix(":443")
    && base.starts_with("https://")
  {
    return base.to_string();
  }
  if let Some(base) = s.strip_suffix(":80")
    && base.starts_with("http://")
  {
    return base.to_string();
  }
  s.to_string()
}

/// Compare two origins for equivalence, accounting for default-port elision.
fn origins_equivalent(a: &str, b: &str) -> bool {
  canonical_origin(a) == canonical_origin(b)
}

#[cfg(test)]
mod tests {
  use super::*;

  /// API-RV-07c: https default port 443 is equivalent to omitted port.
  #[test]
  fn self_proxy_detects_equivalent_origins() {
    assert!(origins_equivalent("https://host", "https://host:443"));
    assert!(origins_equivalent("https://host:443", "https://host"));
    assert!(origins_equivalent("https://host:443/", "https://host/"));
  }

  /// API-RV-07c: http default port 80 is equivalent to omitted port.
  #[test]
  fn self_proxy_detects_http_default_port() {
    assert!(origins_equivalent("http://host", "http://host:80"));
    assert!(origins_equivalent("http://host:80", "http://host"));
    assert!(origins_equivalent("http://host:80/", "http://host/"));
  }

  /// API-RV-07c: different hosts or non-default ports must NOT match.
  #[test]
  fn self_proxy_allows_different_origins() {
    assert!(!origins_equivalent("https://host:3001", "https://other:3001"));
    assert!(!origins_equivalent("https://host", "https://other"));
    assert!(!origins_equivalent("http://host:8080", "http://host"));
    // :443 on http is NOT a default port — schemes differ
    assert!(!origins_equivalent("http://host:443", "http://host"));
  }
}
