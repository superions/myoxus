//! Full-text search endpoint handler.
//!
//! Implements `GET /api/workspaces/{id}/search` which delegates to the configured
//! search backend (PostgreSQL FTS or external plugin). Returns ranked document
//! snippets matching the query string.

use std::sync::Arc;

use axum::{
  extract::{Path, Query, State},
  http::{HeaderMap, StatusCode},
  response::{IntoResponse, Json},
};
use myoxus_domain::entities::SearchDocument;
use myoxus_domain::repositories::{SearchSortBy, SortDirection};
use serde::{Deserialize, Serialize};
use tracing::{error, instrument, warn};
use uuid::Uuid;

use crate::state::ApiState;

/// Query parameters for `GET /api/workspaces/{id}/search`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchQueryParams {
  /// Full-text query string.
  q: String,
  /// BCP-47 language code for stemming (passed to the search backend).
  language: Option<String>,
  /// Maximum number of results to return (default 20).
  limit: Option<i64>,
  /// Number of results to skip for pagination (default 0).
  offset: Option<i64>,
  /// Sort field: `"relevance"` (default) or `"updated_at"`.
  sort_by: Option<String>,
  /// Sort direction: `"desc"` (default) or `"asc"`.
  sort_direction: Option<String>,
}

/// A single document hit in the search response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchDocumentResponse {
  /// UUID of the matched document.
  doc_id: Uuid,
  /// Document title.
  title: String,
  /// Plain-text content snippet.
  plain_text: String,
  /// Timestamp of the last modification.
  updated_at: chrono::DateTime<chrono::Utc>,
}

/// Response body for the search endpoint.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResponse {
  /// Ranked list of matching documents.
  items: Vec<SearchDocumentResponse>,
}

/// Map the `sort_by` query string to a [`SearchSortBy`] enum value.
///
/// Accepts `"updated_at"`, `"updatedat"`, or `"updated"` (case-insensitive);
/// everything else maps to [`SearchSortBy::Relevance`].
pub(crate) fn map_sort_by(value: Option<&str>) -> SearchSortBy {
  match value.unwrap_or("relevance").to_ascii_lowercase().as_str() {
    "updated_at" | "updatedat" | "updated" => SearchSortBy::UpdatedAt,
    _ => SearchSortBy::Relevance,
  }
}

/// Map the `sort_direction` query string to a [`SortDirection`] enum value.
///
/// `"asc"` maps to ascending; everything else (including the default `None`)
/// maps to descending.
pub(crate) fn map_sort_direction(value: Option<&str>) -> SortDirection {
  match value.unwrap_or("desc").to_ascii_lowercase().as_str() {
    "asc" => SortDirection::Asc,
    _ => SortDirection::Desc,
  }
}

/// Convert a domain [`SearchDocument`] into its HTTP response representation.
pub(crate) fn map_search_doc(doc: SearchDocument) -> SearchDocumentResponse {
  SearchDocumentResponse {
    doc_id: doc.doc_id,
    title: doc.title,
    plain_text: doc.plain_text,
    updated_at: doc.updated_at,
  }
}

/// `GET /api/workspaces/{id}/search` — full-text search within a workspace.
///
/// Authenticates the caller via session cookie, verifies workspace membership,
/// then delegates to [`crate::search::search_visible_docs`] which applies
/// per-document ACL filtering on top of the FTS results.
///
/// Returns `403 Forbidden` when the user does not have read access to the
/// workspace, `401 Unauthorized` when no valid session exists, and
/// `500 Internal Server Error` on unexpected backend failures.
#[instrument(skip_all)]
pub(crate) async fn search_docs_handler(
  State(state): State<ApiState>,
  Path(workspace_id): Path<String>,
  Query(params): Query<SearchQueryParams>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  // P81-F-02: Reject oversized search queries at the system boundary.
  if params.q.len() > 500 {
    warn!(query_len = params.q.len(), "search query exceeds 500-char limit");
    return Err(StatusCode::BAD_REQUEST);
  }

  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let cookies = crate::graphql::utils::parse_cookies(&headers);
  let session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
    .ok_or(StatusCode::UNAUTHORIZED)?;
  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .ok_or(StatusCode::UNAUTHORIZED)?;

  let results = crate::search::search_visible_docs(
    Arc::new(state.clone()),
    snapshot.user.id,
    crate::search::SearchQuery {
      workspace_id: workspace_uuid,
      query: params.q,
      language: params.language,
      limit: params.limit.unwrap_or(20),
      offset: params.offset.unwrap_or(0),
      sort_by: map_sort_by(params.sort_by.as_deref()),
      sort_direction: map_sort_direction(params.sort_direction.as_deref()),
      use_semantic_search: false,
    },
  )
  .await
  .map_err(|e| match e {
    myoxus_application::auth::AuthError::ActionForbidden => {
      warn!(workspace_id = %workspace_uuid, user_id = %snapshot.user.id, "search forbidden by acl");
      StatusCode::FORBIDDEN
    }
    myoxus_application::auth::AuthError::AuthenticationRequired => {
      warn!(workspace_id = %workspace_uuid, "search failed: authentication required");
      StatusCode::UNAUTHORIZED
    }
    _ => {
      error!(workspace_id = %workspace_uuid, user_id = %snapshot.user.id, error = %e, "search handler failed");
      StatusCode::INTERNAL_SERVER_ERROR
    }
  })?;

  Ok((
    StatusCode::OK,
    Json(SearchResponse {
      items: results.into_iter().map(map_search_doc).collect(),
    }),
  ))
}
