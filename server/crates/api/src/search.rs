//! Full-text search request helpers and authorization-gated search execution.
//!
//! Defines [`SearchQuery`] (with normalised limit/offset clamping) and
//! [`search_visible_docs`], which enforces workspace permission through the
//! existing repository/embedding ports and [`AccessController`].
//! Results are filtered to documents the calling user has permission to read.

use std::sync::Arc;

use chrono::Utc;
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::permission::{AccessController, WorkspaceResource};
use myoxus_domain::entities::SearchDocument;
use myoxus_domain::permission::WorkspaceAction;
use myoxus_domain::repositories::{PageRequest, SearchPageRequest, SearchSortBy, SortDirection};

use crate::state::ApiState;

/// Validated search request parameters.
#[derive(Debug, Clone)]
pub struct SearchQuery {
  /// Workspace to search within.
  pub workspace_id: Uuid,
  /// Raw user-supplied query string.
  pub query: String,
  /// Optional IETF language tag for locale-aware FTS ranking.
  pub language: Option<String>,
  /// Maximum number of results to return (clamped to 1-100).
  pub limit: i64,
  /// Number of results to skip (non-negative).
  pub offset: i64,
  /// Column to sort by.
  pub sort_by: SearchSortBy,
  /// Sort direction.
  pub sort_direction: SortDirection,
  /// When `true`, use hybrid search (FTS + vector RRF) instead of pure FTS.
  /// Falls back to pure FTS if the embedding provider is not configured.
  pub use_semantic_search: bool,
}

impl SearchQuery {
  /// Return the limit clamped to `[1, 100]`.
  pub fn normalized_limit(&self) -> i64 {
    self.limit.clamp(1, 100)
  }

  /// Return the offset clamped to `[0, inf)`.
  pub fn normalized_offset(&self) -> i64 {
    self.offset.max(0)
  }
}

/// Execute a full-text search and return only documents the user can read.
///
/// Asserts workspace read permission first, then fetches results in windows
/// from the search repository, checking per-document ACL for each hit.
/// Fails closed when no search repository is configured.
///
/// When `use_semantic_search` is `true`, attempts hybrid search (FTS + vector
/// RRF) via `hybrid_search()`.  Falls back to pure FTS if the embedding
/// provider is not configured or returns an error (P71-B).
#[instrument(skip(state, params), fields(user_id = %user_id, workspace_id = %params.workspace_id, limit = params.limit, offset = params.offset))]
pub async fn search_visible_docs(
  state: Arc<ApiState>,
  user_id: Uuid,
  params: SearchQuery,
) -> AuthResult<Vec<SearchDocument>> {
  let pc = state.permission_service();
  pc.assert(
    &WorkspaceResource {
      user_id,
      workspace_id: params.workspace_id,
    },
    WorkspaceAction::Read,
  )
  .await?;

  let repo = state.search_repository().ok_or_else(|| {
    warn!(
      workspace_id = %params.workspace_id,
      user_id = %user_id,
      "search repository is not configured; rejecting search request"
    );
    AuthError::Storage("search repository is not configured".to_string())
  })?;

  // P71-B: Hybrid search path when useSemanticSearch is requested.
  if params.use_semantic_search {
    if let Some(pool) = state.metrics_pool() {
      let embedding_cfg = &state.config.copilot.embedding;
      if embedding_cfg.endpoint.is_some() {
        let requested_limit = params.normalized_limit();
        let mut remaining_skip = params.normalized_offset();
        let hybrid_fetch_limit = requested_limit.saturating_add(remaining_skip).clamp(1, i32::MAX as i64) as i32;
        match state.embed_copilot_query(&params.query).await {
          Ok(embedding) => {
            let hybrid_results = myoxus_infrastructure::search::hybrid_search(
              &pool,
              params.workspace_id,
              &params.query,
              &embedding,
              &embedding_cfg.model,
              hybrid_fetch_limit,
            )
            .await
            .map_err(|e| AuthError::Storage(e.to_string()))?;

            let candidate_ids: Vec<Uuid> = hybrid_results
              .iter()
              .filter_map(|result| Uuid::parse_str(&result.doc_id).ok())
              .collect();
            let readable = pc
              .readable_doc_ids(user_id, params.workspace_id, &candidate_ids)
              .await?;
            let mut collected = Vec::new();
            for hr in hybrid_results {
              let doc_id_str = &hr.doc_id;
              let Ok(doc_id) = Uuid::parse_str(doc_id_str) else {
                warn!(
                  workspace_id = %params.workspace_id,
                  doc_id = %doc_id_str,
                  "hybrid search returned invalid internal doc UUID, skipping result"
                );
                continue;
              };
              if readable.contains(&doc_id) {
                if remaining_skip > 0 {
                  remaining_skip -= 1;
                  continue;
                }
                collected.push(SearchDocument {
                  workspace_id: params.workspace_id,
                  doc_id,
                  title: hr.title.unwrap_or_default(),
                  plain_text: hr.chunk_text.unwrap_or_default(),
                  workspace_tags: Vec::new(),
                  search_vector: None,
                  updated_at: Utc::now(),
                });
                if (collected.len() as i64) >= requested_limit {
                  break;
                }
              }
            }
            debug!(returned = collected.len(), "hybrid search completed with acl filtering");
            return Ok(collected);
          }
          Err(e) => {
            warn!(
              workspace_id = %params.workspace_id,
              error = %e,
              "embedding endpoint not available, falling back to FTS"
            );
          }
        }
      } else {
        warn!(
          workspace_id = %params.workspace_id,
          "embedding endpoint not configured, falling back to FTS"
        );
      }
    } else {
      warn!(
        workspace_id = %params.workspace_id,
        "metrics pool not configured, cannot run hybrid search -- falling back to FTS"
      );
    }
  }

  // ACL-aware pagination: fetch in windows from DB and keep only docs readable for this user.
  let mut collected = Vec::new();
  let requested_limit = params.normalized_limit();
  let mut remaining_skip = params.normalized_offset();
  let mut db_offset = 0_i64;
  let db_window = (requested_limit * 2).clamp(20, 200);

  while (collected.len() as i64) < requested_limit {
    let page = repo
      .search_docs(SearchPageRequest {
        query: params.query.clone(),
        language: params.language.clone(),
        sort_by: params.sort_by.clone(),
        sort_direction: params.sort_direction.clone(),
        workspace_id: params.workspace_id,
        page: PageRequest {
          limit: db_window,
          offset: db_offset,
        },
      })
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?;

    if page.is_empty() {
      break;
    }

    db_offset += page.len() as i64;

    let candidate_ids: Vec<Uuid> = page.iter().map(|doc| doc.doc_id).collect();
    let readable = pc
      .readable_doc_ids(user_id, params.workspace_id, &candidate_ids)
      .await?;
    for doc in page {
      if readable.contains(&doc.doc_id) {
        if remaining_skip > 0 {
          remaining_skip -= 1;
          continue;
        }
        collected.push(doc);
        if (collected.len() as i64) >= requested_limit {
          break;
        }
      }
    }
  }

  debug!(returned = collected.len(), "search completed with acl filtering");
  info!(
      workspace_id = %params.workspace_id,
      user_id = %user_id,
      returned = collected.len(),
      "search visibility filtering completed"
  );
  Ok(collected)
}

/// Count search results visible to the user after ACL filtering.
///
/// Mirrors [`search_visible_docs`] but returns a total count rather than a
/// page of results.
#[instrument(skip(state), fields(user_id = %user_id, workspace_id = %params.workspace_id))]
pub async fn count_visible_docs(state: Arc<ApiState>, user_id: Uuid, params: SearchQuery) -> AuthResult<i64> {
  let pc = state.permission_service();
  pc.assert(
    &WorkspaceResource {
      user_id,
      workspace_id: params.workspace_id,
    },
    WorkspaceAction::Read,
  )
  .await?;

  let repo = state.search_repository().ok_or_else(|| {
    warn!(
      workspace_id = %params.workspace_id,
      user_id = %user_id,
      "search repository is not configured; rejecting aggregate request"
    );
    AuthError::Storage("search repository is not configured".to_string())
  })?;

  let mut count = 0_i64;
  let mut db_offset = 0_i64;
  let db_window = 200_i64;

  loop {
    let page = repo
      .search_docs(SearchPageRequest {
        query: params.query.clone(),
        language: params.language.clone(),
        sort_by: params.sort_by.clone(),
        sort_direction: params.sort_direction.clone(),
        workspace_id: params.workspace_id,
        page: PageRequest {
          limit: db_window,
          offset: db_offset,
        },
      })
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?;
    if page.is_empty() {
      break;
    }
    db_offset += page.len() as i64;
    let candidate_ids: Vec<Uuid> = page.iter().map(|doc| doc.doc_id).collect();
    let readable = pc
      .readable_doc_ids(user_id, params.workspace_id, &candidate_ids)
      .await?;
    for doc in page {
      if readable.contains(&doc.doc_id) {
        count += 1;
      }
    }
  }

  info!(
      workspace_id = %params.workspace_id,
      user_id = %user_id,
      total = count,
      "counted visible search docs"
  );
  Ok(count)
}
