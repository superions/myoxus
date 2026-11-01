//! Application service for the server-authoritative Document Graph.
//!
//! The service is the single boundary where raw Yjs reference extraction is
//! mapped to persisted graph occurrences. It also owns ACL redaction for graph
//! reads: persisted `available` targets are intentionally user-neutral, while
//! request-specific responses may downgrade them to `redacted`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Instant;

use chrono::Utc;
use myoxus_domain::database::{DatabaseEditingRepository, DatabaseProjectionRepository};
use myoxus_domain::document_graph::*;
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::entities::DocumentMetadataProjection;
use myoxus_domain::ids::*;
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use myoxus_domain::repositories::{DocumentGraphRepository, PageRequest, RepositoryError};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tracing::{debug, instrument, warn};
use uuid::Uuid;

use crate::doc::{DocLoadResult, DocService, DocumentGraphIndexHook};
use crate::document_metadata::{DocumentMetadataProjectionMode, DocumentMetadataService};
use crate::permission::{AccessController, DocResource, PermissionService, WorkspaceResource};
use crate::worker::WorkQueuePort;

pub const ERR_SERVICE_UNAVAILABLE: &str = "MIX_GRAPH_SERVICE_UNAVAILABLE";
pub const ERR_WORKSPACE_FORBIDDEN: &str = "MIX_GRAPH_WORKSPACE_FORBIDDEN";
pub const ERR_DOC_FORBIDDEN: &str = "MIX_GRAPH_DOC_FORBIDDEN";
pub const ERR_DOC_NOT_FOUND: &str = "MIX_GRAPH_DOC_NOT_FOUND";
pub const ERR_QUERY_INVALID: &str = "MIX_GRAPH_QUERY_INVALID";
pub const ERR_REINDEX_ENQUEUE_FAILED: &str = "MIX_GRAPH_REINDEX_ENQUEUE_FAILED";
pub const ERR_REINDEX_FAILED: &str = "MIX_GRAPH_REINDEX_FAILED";

pub const DOCUMENT_GRAPH_QUEUE: &str = "document-graph";
pub const JOB_REINDEX_DOCUMENT: &str = "documentGraph.reindexDocument";
pub const JOB_REINDEX_WORKSPACE_BATCH: &str = "documentGraph.reindexWorkspaceBatch";

#[derive(Debug, Clone)]
pub struct DocumentGraphLimits {
  pub max_graph_nodes: usize,
  pub max_graph_edges: usize,
  pub max_occurrences_per_edge: usize,
  pub max_reindex_batch: i64,
  pub max_catch_up_workspaces: i64,
  pub preview_max_chars: usize,
  pub stale_after_seconds: i64,
  pub enqueue_delay_ms: i64,
  pub max_reindex_attempts: i32,
}

impl Default for DocumentGraphLimits {
  fn default() -> Self {
    Self {
      max_graph_nodes: 250,
      max_graph_edges: 500,
      max_occurrences_per_edge: 25,
      max_reindex_batch: 100,
      max_catch_up_workspaces: 25,
      preview_max_chars: 256,
      stale_after_seconds: 300,
      enqueue_delay_ms: 0,
      max_reindex_attempts: 5,
    }
  }
}

#[derive(Debug, Clone)]
pub struct DocumentGraphQueue {
  pub queue: &'static str,
  pub job_name: &'static str,
  pub job_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DocumentGraphReindexOutcome {
  pub workspace_id: Option<WorkspaceId>,
  pub requested_count: i64,
  pub reindexed_count: i64,
  pub failed_count: i64,
  pub skipped_count: i64,
}

#[derive(Debug, Clone, Error)]
#[error("{code}: {message}")]
pub struct DocumentGraphServiceError {
  pub code: &'static str,
  pub message: String,
}

impl DocumentGraphServiceError {
  fn new(code: &'static str, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
    }
  }
}

impl From<RepositoryError> for DocumentGraphServiceError {
  fn from(error: RepositoryError) -> Self {
    match error {
      RepositoryError::NotFound(_) => Self::new(ERR_DOC_NOT_FOUND, "document graph resource not found"),
      RepositoryError::Conflict(message) => Self::new(ERR_QUERY_INVALID, message),
      RepositoryError::Validation(message) => Self::new(ERR_QUERY_INVALID, message),
      RepositoryError::Storage(message) => Self::new(ERR_SERVICE_UNAVAILABLE, format!("storage failure: {message}")),
    }
  }
}

pub type DocumentGraphResult<T> = Result<T, DocumentGraphServiceError>;

#[derive(Clone)]
pub struct DocumentGraphService {
  repo: Arc<dyn DocumentGraphRepository>,
  doc_service: Arc<DocService>,
  permission: Arc<PermissionService>,
  metadata: Arc<DocumentMetadataService>,
  projection_repo: Option<Arc<dyn DatabaseProjectionRepository>>,
  // Capture provenance remains Editing data; a reference projection alone
  // cannot prove a TaskSource document identity.
  task_source_repo: Option<Arc<dyn DatabaseEditingRepository>>,
  queue: Option<Arc<dyn WorkQueuePort>>,
  limits: DocumentGraphLimits,
}

impl DocumentGraphService {
  pub fn new(
    repo: Arc<dyn DocumentGraphRepository>,
    doc_service: Arc<DocService>,
    permission: Arc<PermissionService>,
    metadata: Arc<DocumentMetadataService>,
    projection_repo: Option<Arc<dyn DatabaseProjectionRepository>>,
    task_source_repo: Option<Arc<dyn DatabaseEditingRepository>>,
    queue: Option<Arc<dyn WorkQueuePort>>,
    limits: DocumentGraphLimits,
  ) -> Self {
    Self {
      repo,
      doc_service,
      permission,
      metadata,
      projection_repo,
      task_source_repo,
      queue,
      limits,
    }
  }

  /// Return the same fully constructed graph capability with a CLI/runtime
  /// queue selection. All persistence and policy dependencies remain intact.
  pub fn with_queue(mut self, queue: Option<Arc<dyn WorkQueuePort>>) -> Self {
    self.queue = queue;
    self
  }

  pub fn limits(&self) -> &DocumentGraphLimits {
    &self.limits
  }

  #[instrument(skip(self), fields(%workspace_id, %doc_id, reason = reason.as_str()), err)]
  pub async fn enqueue_document_reindex(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    reason: DocumentGraphReindexReason,
  ) -> DocumentGraphResult<DocumentGraphQueue> {
    self
      .repo
      .mark_doc_graph_stale(workspace_id, doc_id, reason.clone())
      .await?;
    let Some(queue) = &self.queue else {
      warn!(
        %workspace_id,
        %doc_id,
        reason = reason.as_str(),
        error_code = ERR_REINDEX_ENQUEUE_FAILED,
        "document graph queue is not configured; document remains stale"
      );
      return Ok(DocumentGraphQueue {
        queue: DOCUMENT_GRAPH_QUEUE,
        job_name: JOB_REINDEX_DOCUMENT,
        job_id: None,
      });
    };
    let payload = serde_json::json!({
      "workspace_id": workspace_id,
      "doc_id": doc_id,
      "reason": reason.as_str(),
    });
    match queue
      .add_job(
        DOCUMENT_GRAPH_QUEUE,
        JOB_REINDEX_DOCUMENT,
        payload,
        Some(self.limits.max_reindex_attempts.max(1) as u32),
        Some(self.limits.enqueue_delay_ms.max(0)),
      )
      .await
    {
      Ok(job_id) => {
        self.repo.mark_doc_graph_queued(workspace_id, doc_id, reason).await?;
        Ok(DocumentGraphQueue {
          queue: DOCUMENT_GRAPH_QUEUE,
          job_name: JOB_REINDEX_DOCUMENT,
          job_id: Some(job_id),
        })
      }
      Err(error) => {
        warn!(
          %workspace_id,
          %doc_id,
          reason = reason.as_str(),
          error = %error,
          error_code = ERR_REINDEX_ENQUEUE_FAILED,
          "document graph enqueue failed; document remains stale"
        );
        // P5 requires write paths to remain successful when Redis is
        // unavailable. The stale state is durable and the global catch-up job
        // will retry through the same worker path.
        Ok(DocumentGraphQueue {
          queue: DOCUMENT_GRAPH_QUEUE,
          job_name: JOB_REINDEX_DOCUMENT,
          job_id: None,
        })
      }
    }
  }

  #[instrument(skip(self), fields(%workspace_id, %doc_id), err)]
  pub async fn mark_document_deleted(&self, workspace_id: WorkspaceId, doc_id: DocId) -> DocumentGraphResult<()> {
    self.repo.mark_doc_graph_deleted(workspace_id, doc_id).await?;
    Ok(())
  }

  #[instrument(skip(self), fields(%workspace_id, limit, reason = reason.as_str()), err)]
  pub async fn enqueue_workspace_reindex(
    &self,
    workspace_id: WorkspaceId,
    limit: i64,
    reason: DocumentGraphReindexReason,
  ) -> DocumentGraphResult<DocumentGraphQueue> {
    self
      .enqueue_workspace_batch_job(Some(workspace_id), limit, 1, reason)
      .await
  }

  #[instrument(skip(self), fields(limit, workspace_limit, reason = reason.as_str()), err)]
  pub async fn enqueue_global_catch_up(
    &self,
    limit: i64,
    workspace_limit: i64,
    reason: DocumentGraphReindexReason,
  ) -> DocumentGraphResult<DocumentGraphQueue> {
    self
      .enqueue_workspace_batch_job(None, limit, workspace_limit, reason)
      .await
  }

  async fn enqueue_workspace_batch_job(
    &self,
    workspace_id: Option<WorkspaceId>,
    limit: i64,
    workspace_limit: i64,
    reason: DocumentGraphReindexReason,
  ) -> DocumentGraphResult<DocumentGraphQueue> {
    let limit = self.validate_limit(limit, self.limits.max_reindex_batch, "limit")?;
    let workspace_limit =
      self.validate_limit(workspace_limit, self.limits.max_catch_up_workspaces, "workspace_limit")?;
    let Some(queue) = &self.queue else {
      return Err(DocumentGraphServiceError::new(
        ERR_SERVICE_UNAVAILABLE,
        "document graph queue is not configured",
      ));
    };
    let payload = serde_json::json!({
      "workspace_id": workspace_id,
      "limit": limit,
      "workspace_limit": workspace_limit,
      "reason": reason.as_str(),
    });
    let job_id = queue
      .add_job(
        DOCUMENT_GRAPH_QUEUE,
        JOB_REINDEX_WORKSPACE_BATCH,
        payload,
        Some(self.limits.max_reindex_attempts.max(1) as u32),
        Some(self.limits.enqueue_delay_ms.max(0)),
      )
      .await
      .map_err(|error| {
        warn!(
          workspace_id = ?workspace_id,
          limit,
          workspace_limit,
          reason = reason.as_str(),
          error = %error,
          error_code = ERR_REINDEX_ENQUEUE_FAILED,
          "document graph workspace batch enqueue failed"
        );
        DocumentGraphServiceError::new(
          ERR_REINDEX_ENQUEUE_FAILED,
          "document graph workspace batch enqueue failed",
        )
      })?;
    Ok(DocumentGraphQueue {
      queue: DOCUMENT_GRAPH_QUEUE,
      job_name: JOB_REINDEX_WORKSPACE_BATCH,
      job_id: Some(job_id),
    })
  }

  #[instrument(skip(self), fields(%workspace_id, %doc_id), err)]
  pub async fn reindex_document_now(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
  ) -> DocumentGraphResult<DocumentGraphReindexOutcome> {
    let started = Instant::now();
    let loaded = match self.doc_service.load_full_doc_with_meta(workspace_id, doc_id).await {
      Ok(loaded) => loaded,
      Err(error) => {
        let error = DocumentGraphServiceError::new(ERR_REINDEX_FAILED, error.to_string());
        if let Err(mark_error) = self
          .repo
          .mark_doc_graph_failed(workspace_id, doc_id, error.code, &error.message)
          .await
        {
          warn!(
            %workspace_id,
            %doc_id,
            error = %mark_error,
            "document graph load failure state could not be persisted"
          );
        }
        warn!(
          %workspace_id,
          %doc_id,
          error_code = error.code,
          error = %error.message,
          duration_ms = started.elapsed().as_millis(),
          "document graph reindex failed while loading the document"
        );
        return Err(error);
      }
    };

    // A soft-deleted document still has a `docs` row and can retain a deleted
    // graph state. A permanently deleted document has already cascaded its
    // graph rows; the repository's conditional insert makes this cleanup an
    // idempotent no-op. In either case there is no extraction work to retry.
    if !loaded.exists {
      self.repo.mark_doc_graph_deleted(workspace_id, doc_id).await?;
      return Ok(DocumentGraphReindexOutcome {
        workspace_id: Some(workspace_id),
        requested_count: 1,
        skipped_count: 1,
        ..Default::default()
      });
    }

    self.repo.mark_doc_graph_extracting(workspace_id, doc_id).await?;
    let outcome = self.reindex_document_now_inner(workspace_id, doc_id, loaded).await;
    if let Err(error) = &outcome {
      if let Err(mark_error) = self
        .repo
        .mark_doc_graph_failed(workspace_id, doc_id, error.code, &error.message)
        .await
      {
        warn!(
          %workspace_id,
          %doc_id,
          error = %mark_error,
          "document graph failure state could not be persisted"
        );
      }
      warn!(
        %workspace_id,
        %doc_id,
        error_code = error.code,
        error = %error.message,
        duration_ms = started.elapsed().as_millis(),
        "document graph reindex failed"
      );
    }
    outcome
  }

  async fn reindex_document_now_inner(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    loaded: DocLoadResult,
  ) -> DocumentGraphResult<DocumentGraphReindexOutcome> {
    let extraction = yjs::extract_document_references_from_yjs(&loaded.payload)
      .map_err(|error| DocumentGraphServiceError::new(ERR_REINDEX_FAILED, error))?;
    let mut occurrences = Vec::with_capacity(extraction.occurrences.len());
    for raw in extraction.occurrences {
      // A malformed explicit qualification is unresolved, never the containing workspace.
      let target_workspace_id = match raw.target_workspace_id.as_deref() {
        None => Some(workspace_id),
        Some(value) => Uuid::parse_str(value).ok(),
      };
      let (target_doc_id, target_state) = match target_workspace_id {
        Some(scope) => {
          let (_, id, state) = self.resolve_target_state(scope, &raw.raw_target_doc_id).await?;
          (id, state)
        }
        None => (None, DocumentGraphTargetState::Unresolved),
      };
      let source_position = serde_json::to_value(&raw.position)
        .map_err(|_| DocumentGraphServiceError::new(ERR_REINDEX_FAILED, "reference position serialization failed"))?;
      let params_json = canonical_json(raw.params_json);
      let markdown_preview = truncate_chars(raw.markdown_preview.as_str(), self.limits.preview_max_chars);
      occurrences.push(DocumentGraphOccurrence {
        id: Uuid::new_v4(),
        workspace_id,
        source_doc_id: doc_id,
        source_block_id: raw.source_block_id,
        source_position: source_position.clone(),
        target_workspace_id,
        source_parent_block_id: raw.source_parent_block_id,
        source_parent_flavour: raw.source_parent_flavour,
        raw_target_doc_id: raw.raw_target_doc_id,
        target_doc_id,
        link_kind: map_yjs_link_kind(raw.link_kind),
        params_key: params_key(&serde_json::json!({"params": params_json, "position": source_position})),
        params_json,
        markdown_preview,
        target_state,
        extracted_at: Utc::now(),
        source_updated_at: loaded.updated_at,
        created_at: Utc::now(),
      });
    }
    let occurrence_count = occurrences.len() as i64;
    self
      .repo
      .replace_doc_occurrences(workspace_id, doc_id, loaded.updated_at, occurrences)
      .await?;
    Ok(
      DocumentGraphReindexOutcome {
        workspace_id: Some(workspace_id),
        requested_count: 1,
        reindexed_count: 1,
        failed_count: 0,
        skipped_count: 0,
      }
      .with_occurrence_count(occurrence_count),
    )
  }

  #[instrument(skip(self), fields(%workspace_id, limit), err)]
  pub async fn reindex_workspace_batch_now(
    &self,
    workspace_id: WorkspaceId,
    limit: i64,
  ) -> DocumentGraphResult<DocumentGraphReindexOutcome> {
    let limit = self.validate_limit(limit, self.limits.max_reindex_batch, "limit")?;
    let candidates = self.repo.list_reindex_candidates(workspace_id, limit).await?;
    let mut outcome = DocumentGraphReindexOutcome {
      workspace_id: Some(workspace_id),
      requested_count: candidates.len() as i64,
      ..Default::default()
    };
    for doc_id in candidates {
      match self.reindex_document_now(workspace_id, doc_id).await {
        Ok(_) => outcome.reindexed_count += 1,
        Err(error) => {
          outcome.failed_count += 1;
          warn!(%workspace_id, %doc_id, error_code = error.code, error = %error.message, "document graph batch item failed");
        }
      }
    }
    Ok(outcome)
  }

  #[instrument(skip(self), fields(limit, workspace_limit), err)]
  pub async fn reindex_due_workspaces_batch_now(
    &self,
    limit: i64,
    workspace_limit: i64,
  ) -> DocumentGraphResult<DocumentGraphReindexOutcome> {
    let limit = self.validate_limit(limit, self.limits.max_reindex_batch, "limit")?;
    let workspace_limit =
      self.validate_limit(workspace_limit, self.limits.max_catch_up_workspaces, "workspace_limit")?;
    let workspaces = self
      .repo
      .list_workspaces_with_reindex_candidates(workspace_limit)
      .await?;
    let mut outcome = DocumentGraphReindexOutcome {
      requested_count: workspaces.len() as i64,
      ..Default::default()
    };
    for workspace_id in workspaces {
      match self.reindex_workspace_batch_now(workspace_id, limit).await {
        Ok(batch) => {
          outcome.reindexed_count += batch.reindexed_count;
          outcome.failed_count += batch.failed_count;
          outcome.skipped_count += batch.skipped_count;
        }
        Err(error) => {
          outcome.failed_count += 1;
          warn!(%workspace_id, error_code = error.code, error = %error.message, "document graph workspace batch failed");
        }
      }
    }
    Ok(outcome)
  }

  #[instrument(skip(self), fields(%user_id, %workspace_id, %doc_id, direction = direction.as_str()), err)]
  pub async fn read_document_links(
    &self,
    user_id: UserId,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    direction: DocumentGraphDirection,
    page: DocumentGraphPage,
    include_occurrences: bool,
  ) -> DocumentGraphResult<DocumentGraphReadModel> {
    self.assert_doc_read(user_id, workspace_id, doc_id).await?;
    self
      .read_workspace_graph(
        user_id,
        workspace_id,
        DocumentGraphQuery {
          focus_doc_id: Some(doc_id),
          direction,
          page,
          metadata_filter: None,
          include_occurrences,
        },
      )
      .await
  }

  #[instrument(skip(self, query), fields(%user_id, %workspace_id), err)]
  pub async fn read_workspace_graph(
    &self,
    user_id: UserId,
    workspace_id: WorkspaceId,
    query: DocumentGraphQuery,
  ) -> DocumentGraphResult<DocumentGraphReadModel> {
    self.assert_workspace_read(user_id, workspace_id).await?;
    let page = PageRequest {
      limit: query.page.first.min(self.limits.max_graph_edges as i64),
      offset: query.page.offset.max(0),
    };
    let mut edges = self
      .repo
      .list_workspace_edges(
        workspace_id,
        DocumentGraphQuery {
          page: DocumentGraphPage {
            first: page.limit,
            offset: page.offset,
          },
          ..query.clone()
        },
      )
      .await?;
    if query.include_occurrences {
      self.attach_edge_occurrences(workspace_id, &mut edges).await?;
    }
    let candidate_doc_ids = edges
      .iter()
      .flat_map(|edge| {
        std::iter::once(edge.source_doc_id).chain(
          (edge.target_state == DocumentGraphTargetState::Available)
            .then_some(edge.target_doc_id)
            .flatten(),
        )
      })
      .collect::<HashSet<_>>();
    // Both caches are request-local. Authorization is never reused across
    // reads, and only successfully materialized nodes enter the node cache.
    let mut read_permissions = HashMap::<(WorkspaceId, DocId), bool>::with_capacity(candidate_doc_ids.len());
    let mut readable_nodes = HashMap::<(WorkspaceId, DocId), DocumentGraphNode>::with_capacity(candidate_doc_ids.len());
    let mut nodes = HashMap::<(WorkspaceId, String), DocumentGraphNode>::new();
    let mut filtered_edges = Vec::new();
    let mut redacted_count = 0i64;
    let mut resolved_targets = HashMap::new();
    for mut edge in edges.drain(..) {
      if !self
        .can_doc_read_cached(user_id, workspace_id, edge.source_doc_id, &mut read_permissions)
        .await
      {
        continue;
      }
      let source = self
        .readable_node_cached(user_id, workspace_id, edge.source_doc_id, &mut readable_nodes)
        .await?;
      nodes.insert((source.workspace_id, source.raw_doc_id.clone()), source.clone());
      let original_target_scope = edge.target_workspace_id;
      // Persisted occurrence qualification remains the original native address.
      // Resolve its current owner for this read; never widen the source query.
      if let Some(scope) = edge.target_workspace_id
        && DocumentKey::parse(&edge.raw_target_doc_id).is_ok()
      {
        let address = (scope, edge.raw_target_doc_id.clone());
        let resolved = if let Some(resolved) = resolved_targets.get(&address) {
          *resolved
        } else {
          let identity = self
            .repo
            .resolve_reference_target(scope, &edge.raw_target_doc_id, edge.target_doc_id)
            .await?;
          let resolved = match identity {
            Some((scope, id)) => (
              Some(scope),
              Some(id),
              if matches!(
                edge.target_state,
                DocumentGraphTargetState::Missing | DocumentGraphTargetState::Unresolved
              ) {
                DocumentGraphTargetState::Available
              } else {
                edge.target_state
              },
            ),
            None => (None, None, DocumentGraphTargetState::Missing),
          };
          resolved_targets.insert(address, resolved);
          resolved
        };
        edge.target_workspace_id = resolved.0.or(Some(scope));
        edge.target_doc_id = resolved.1;
        edge.target_state = resolved.2;
        for occurrence in &mut edge.occurrences {
          occurrence.target_workspace_id = edge.target_workspace_id;
          occurrence.target_doc_id = edge.target_doc_id;
          occurrence.target_state = edge.target_state;
        }
      }
      // An unqualified source alias must not disclose its new workspace when
      // that destination is denied. Explicit old qualification remains known.
      if let (Some(scope), Some(id)) = (edge.target_workspace_id, edge.target_doc_id)
        && Some(scope) != original_target_scope
        && !self
          .can_doc_read_cached(user_id, scope, id, &mut read_permissions)
          .await
      {
        redacted_count += 1;
        edge.target_workspace_id = original_target_scope;
        if let Some(scope) = original_target_scope {
          nodes.insert(
            (scope, edge.raw_target_doc_id.clone()),
            DocumentGraphNode {
              workspace_id: scope,
              doc_id: None,
              raw_doc_id: edge.raw_target_doc_id.clone(),
              title: None,
              document_type: None,
              status: None,
              classification: None,
              deleted: false,
              redacted: true,
            },
          );
        }
        edge.target_doc_id = None;
        edge.target_state = DocumentGraphTargetState::Redacted;
        edge.first_occurrence_preview = None;
        edge.occurrences.clear();
      }
      let mut readable_target = None;
      let target =
        if let (Some(target_doc_id), Some(target_workspace_id)) = (edge.target_doc_id, edge.target_workspace_id) {
          match edge.target_state {
            DocumentGraphTargetState::Available => {
              if self
                .can_doc_read_cached(user_id, target_workspace_id, target_doc_id, &mut read_permissions)
                .await
              {
                let target = self
                  .readable_node_cached(user_id, target_workspace_id, target_doc_id, &mut readable_nodes)
                  .await?;
                readable_target = Some(target.clone());
                Some(target)
              } else {
                redacted_count += 1;
                edge.target_doc_id = None;
                edge.target_state = DocumentGraphTargetState::Redacted;
                edge.first_occurrence_preview = None;
                edge.occurrences.clear();
                Some(DocumentGraphNode {
                  workspace_id: target_workspace_id,
                  doc_id: None,
                  raw_doc_id: edge.raw_target_doc_id.clone(),
                  title: None,
                  document_type: None,
                  status: None,
                  classification: None,
                  deleted: false,
                  redacted: true,
                })
              }
            }
            DocumentGraphTargetState::Deleted => Some(DocumentGraphNode {
              workspace_id: target_workspace_id,
              doc_id: None,
              raw_doc_id: edge.raw_target_doc_id.clone(),
              title: None,
              document_type: None,
              status: None,
              classification: None,
              deleted: true,
              redacted: false,
            }),
            _ => None,
          }
        } else {
          None
        };
      if let Some(target) = target {
        nodes.insert((target.workspace_id, target.raw_doc_id.clone()), target);
      }
      if self
        .edge_matches_metadata_filter(&source, readable_target.as_ref(), query.metadata_filter.as_ref())
        .await?
      {
        filtered_edges.push(edge);
      }
      if filtered_edges.len() >= self.limits.max_graph_edges {
        break;
      }
    }
    let mut nodes: Vec<DocumentGraphNode> = nodes.into_values().take(self.limits.max_graph_nodes).collect();
    nodes.sort_by(|a, b| (a.workspace_id, &a.raw_doc_id).cmp(&(b.workspace_id, &b.raw_doc_id)));
    debug!(
      %workspace_id,
      edge_count = filtered_edges.len(),
      node_count = nodes.len(),
      redacted_count,
      "document graph read model built"
    );
    let projection_repo = self.projection_repo.clone();
    let mut database_references = if query.focus_doc_id.is_none()
      || matches!(
        query.direction,
        DocumentGraphDirection::Incoming | DocumentGraphDirection::Both
      ) {
      match projection_repo {
        Some(repo) => {
          let page = PageRequest {
            limit: self.limits.max_graph_edges.saturating_sub(filtered_edges.len()) as i64,
            offset: query.page.offset.max(0),
          };
          if page.limit == 0 {
            Vec::new()
          } else if let Some(doc_id) = query.focus_doc_id {
            repo
              .list_document_references_for_targets(workspace_id, &[doc_id], page)
              .await?
          } else {
            repo.list_document_references_for_workspace(workspace_id, page).await?
          }
        }
        None => Vec::new(),
      }
    } else {
      Vec::new()
    };
    for reference in &mut database_references {
      let original_target_scope = reference.target_workspace_id;
      if let Some(target_doc_id) = reference.resolved_target_doc_id {
        if let Some(origin) = reference.target_workspace_id {
          let metadata = self
            .doc_service
            .get_metadata_including_deleted(target_doc_id)
            .await
            .map_err(|error| {
              DocumentGraphServiceError::new(
                ERR_SERVICE_UNAVAILABLE,
                format!("database document reference lookup failed: {error}"),
              )
            })?;
          let is_task_source =
            reference.reference_kind == myoxus_domain::database::DatabaseDocumentReferenceKind::TaskSource;
          let task_source = if is_task_source {
            match self.task_source_repo.as_ref() {
              Some(repo) => repo.get_task_source(reference.row_id).await?,
              None => None,
            }
          } else {
            None
          };
          let actual = if let Some(doc) = metadata {
            // A captured origin is scoped identity, unlike a normal document
            // reference that may follow a committed workspace transfer.
            let origin_matches = !is_task_source
              || task_source.as_ref().is_some_and(|source| {
                source.source_workspace_id == workspace_id
                  && source.source_workspace_id == origin
                  && source.document_id == target_doc_id
                  && source.external_id == doc.external_id
              });
            if origin_matches
              && !doc.blocked
              && doc.deleted_at.is_none()
              && (doc.workspace_id == Some(origin)
                || (!is_task_source
                  && self
                    .doc_service
                    .has_committed_transfer_from(target_doc_id, origin)
                    .await
                    .map_err(|error| {
                      DocumentGraphServiceError::new(
                        ERR_SERVICE_UNAVAILABLE,
                        format!("database document reference origin unavailable: {error}"),
                      )
                    })?))
            {
              doc.workspace_id
            } else {
              None
            }
          } else {
            None
          };
          reference.target_workspace_id = actual;
        }
        let readable = match reference.target_workspace_id {
          Some(scope) => {
            self
              .can_doc_read_cached(user_id, scope, target_doc_id, &mut read_permissions)
              .await
          }
          None => false,
        };
        if !readable {
          reference.resolved_target_doc_id = None;
          reference.target_workspace_id = original_target_scope;
        }
      }
    }
    Ok(DocumentGraphReadModel {
      nodes,
      edges: filtered_edges,
      database_references,
      index_summary: self.repo.get_workspace_index_summary(workspace_id).await?,
    })
  }

  pub async fn index_status(
    &self,
    user_id: UserId,
    workspace_id: WorkspaceId,
    doc_id: Option<DocId>,
  ) -> DocumentGraphResult<(DocumentGraphIndexSummary, Option<DocumentGraphIndexState>)> {
    self.assert_workspace_read(user_id, workspace_id).await?;
    let state = if let Some(doc_id) = doc_id {
      self.assert_doc_read(user_id, workspace_id, doc_id).await?;
      self.repo.get_index_state(workspace_id, doc_id).await?
    } else {
      None
    };
    Ok((self.repo.get_workspace_index_summary(workspace_id).await?, state))
  }

  /// Admin/CLI status read that intentionally bypasses user ACL redaction.
  ///
  /// User-facing GraphQL must keep using [`Self::index_status`]. The CLI is a
  /// direct database administration surface and has no authenticated user
  /// context, but it should still consume the same service/repository contract
  /// instead of issuing ad-hoc SQL.
  pub async fn admin_index_status(
    &self,
    workspace_id: WorkspaceId,
    doc_id: Option<DocId>,
  ) -> DocumentGraphResult<(DocumentGraphIndexSummary, Option<DocumentGraphIndexState>)> {
    let summary = self.repo.get_workspace_index_summary(workspace_id).await?;
    let state = match doc_id {
      Some(doc_id) => self.repo.get_index_state(workspace_id, doc_id).await?,
      None => None,
    };
    Ok((summary, state))
  }

  async fn resolve_target_state(
    &self,
    workspace_id: WorkspaceId,
    raw_target_doc_id: &str,
  ) -> DocumentGraphResult<(Option<WorkspaceId>, Option<DocId>, DocumentGraphTargetState)> {
    let Ok(document_key) = DocumentKey::parse(raw_target_doc_id.to_string()) else {
      return Ok((None, None, DocumentGraphTargetState::Unresolved));
    };
    let target = self
      .repo
      .resolve_reference_target(workspace_id, document_key.as_str(), None)
      .await
      .map_err(|error| {
        DocumentGraphServiceError::new(
          ERR_SERVICE_UNAVAILABLE,
          format!("document graph target resolution unavailable: {error}"),
        )
      })?;
    let Some((scope, target_doc_id)) = target else {
      return Ok((None, None, DocumentGraphTargetState::Missing));
    };
    match self.repo.get_document_node(scope, target_doc_id).await? {
      Some(node) if node.deleted => Ok((Some(scope), Some(target_doc_id), DocumentGraphTargetState::Deleted)),
      Some(_) => Ok((Some(scope), Some(target_doc_id), DocumentGraphTargetState::Available)),
      None => Ok((None, None, DocumentGraphTargetState::Missing)),
    }
  }

  async fn attach_edge_occurrences(
    &self,
    workspace_id: WorkspaceId,
    edges: &mut [DocumentGraphEdge],
  ) -> DocumentGraphResult<()> {
    let page = PageRequest {
      limit: self.limits.max_occurrences_per_edge as i64,
      offset: 0,
    };
    for edge in edges {
      edge.occurrences = self
        .repo
        .list_edge_occurrences(
          workspace_id,
          edge.source_doc_id,
          edge.target_workspace_id,
          edge.target_doc_id,
          &edge.raw_target_doc_id,
          edge.link_kind,
          edge.target_state,
          page.clone(),
        )
        .await?;
    }
    Ok(())
  }

  async fn readable_node(
    &self,
    user_id: UserId,
    workspace_id: WorkspaceId,
    doc_id: DocId,
  ) -> DocumentGraphResult<DocumentGraphNode> {
    self.assert_doc_read(user_id, workspace_id, doc_id).await?;
    let mut node = self
      .repo
      .get_document_node(workspace_id, doc_id)
      .await?
      .ok_or_else(|| DocumentGraphServiceError::new(ERR_DOC_NOT_FOUND, "document graph document not found"))?;
    if !node.deleted
      && let Ok(projection) = self
        .metadata
        .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
        .await
    {
      apply_metadata_projection(&mut node, &projection);
    }
    Ok(node)
  }

  async fn can_doc_read_cached(
    &self,
    user_id: UserId,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    cache: &mut HashMap<(WorkspaceId, DocId), bool>,
  ) -> bool {
    if let Some(can_read) = cache.get(&(workspace_id, doc_id)) {
      return *can_read;
    }
    let can_read = self.can_doc_read(user_id, workspace_id, doc_id).await;
    cache.insert((workspace_id, doc_id), can_read);
    can_read
  }

  async fn readable_node_cached(
    &self,
    user_id: UserId,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    cache: &mut HashMap<(WorkspaceId, DocId), DocumentGraphNode>,
  ) -> DocumentGraphResult<DocumentGraphNode> {
    if let Some(node) = cache.get(&(workspace_id, doc_id)) {
      return Ok(node.clone());
    }
    let node = self.readable_node(user_id, workspace_id, doc_id).await?;
    cache.insert((workspace_id, doc_id), node.clone());
    Ok(node)
  }

  async fn edge_matches_metadata_filter(
    &self,
    source: &DocumentGraphNode,
    readable_target: Option<&DocumentGraphNode>,
    filter: Option<&DocumentGraphMetadataFilter>,
  ) -> DocumentGraphResult<bool> {
    let Some(filter) = filter else {
      return Ok(true);
    };
    if node_matches_filter(source, filter) {
      return Ok(true);
    }
    if let Some(target) = readable_target {
      return Ok(node_matches_filter(target, filter));
    }
    Ok(false)
  }

  async fn assert_workspace_read(&self, user_id: UserId, workspace_id: WorkspaceId) -> DocumentGraphResult<()> {
    self
      .permission
      .assert(&WorkspaceResource { user_id, workspace_id }, WorkspaceAction::Read)
      .await
      .map_err(|_| DocumentGraphServiceError::new(ERR_WORKSPACE_FORBIDDEN, "document graph workspace access forbidden"))
  }

  async fn assert_doc_read(
    &self,
    user_id: UserId,
    workspace_id: WorkspaceId,
    doc_id: DocId,
  ) -> DocumentGraphResult<()> {
    if self.can_doc_read(user_id, workspace_id, doc_id).await {
      Ok(())
    } else {
      Err(DocumentGraphServiceError::new(
        ERR_DOC_FORBIDDEN,
        "document graph document access forbidden",
      ))
    }
  }

  async fn can_doc_read(&self, user_id: UserId, workspace_id: WorkspaceId, doc_id: DocId) -> bool {
    self
      .permission
      .can(
        &DocResource {
          user_id,
          workspace_id,
          doc_id,
        },
        DocAction::Read,
      )
      .await
  }

  fn validate_limit(&self, value: i64, max: i64, name: &str) -> DocumentGraphResult<i64> {
    if value <= 0 || value > max {
      return Err(DocumentGraphServiceError::new(
        ERR_QUERY_INVALID,
        format!("{name} must be between 1 and {max}"),
      ));
    }
    Ok(value)
  }
}

impl DocumentGraphReindexOutcome {
  fn with_occurrence_count(self, occurrence_count: i64) -> Self {
    debug!(occurrence_count, "document graph reindex occurrence count");
    self
  }
}

fn map_yjs_link_kind(kind: yjs::DocumentReferenceLinkKind) -> DocumentGraphLinkKind {
  match kind {
    yjs::DocumentReferenceLinkKind::InlineReference => DocumentGraphLinkKind::InlineReference,
    yjs::DocumentReferenceLinkKind::EmbedLinkedDoc => DocumentGraphLinkKind::EmbedLinkedDoc,
    yjs::DocumentReferenceLinkKind::EmbedSyncedDoc => DocumentGraphLinkKind::EmbedSyncedDoc,
    yjs::DocumentReferenceLinkKind::SurfaceRef => DocumentGraphLinkKind::SurfaceRef,
    yjs::DocumentReferenceLinkKind::DatabaseCellReference => DocumentGraphLinkKind::DatabaseCellReference,
  }
}

fn params_key(value: &Value) -> String {
  let serialized = serde_json::to_vec(value).unwrap_or_default();
  let digest = Sha256::digest(serialized);
  format!("{digest:x}")
}

fn canonical_json(value: Value) -> Value {
  match value {
    Value::Array(values) => Value::Array(values.into_iter().map(canonical_json).collect()),
    Value::Object(object) => {
      let mut sorted = BTreeMap::new();
      for (key, value) in object {
        sorted.insert(key, canonical_json(value));
      }
      Value::Object(sorted.into_iter().collect::<Map<String, Value>>())
    }
    value => value,
  }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
  if value.chars().count() <= max_chars {
    value.to_string()
  } else {
    value.chars().take(max_chars).collect()
  }
}

fn apply_metadata_projection(node: &mut DocumentGraphNode, projection: &DocumentMetadataProjection) {
  node.status = metadata_field_label(projection, "status");
  node.document_type = metadata_field_label(projection, "documentType");
  node.classification = metadata_field_label(projection, "classification");
}

fn metadata_field_label(projection: &DocumentMetadataProjection, key: &str) -> Option<String> {
  projection
    .fields
    .iter()
    .find(|field| field.key == key)
    .and_then(|field| {
      field
        .reference
        .as_ref()
        .map(|reference| reference.label.clone())
        .or_else(|| field.text_value.clone())
    })
}

fn node_matches_filter(node: &DocumentGraphNode, filter: &DocumentGraphMetadataFilter) -> bool {
  filter_values_match(&filter.statuses, node.status.as_deref())
    && filter_values_match(&filter.document_types, node.document_type.as_deref())
    && filter_values_match(&filter.classifications, node.classification.as_deref())
}

fn filter_values_match(values: &[String], candidate: Option<&str>) -> bool {
  values.is_empty()
    || candidate
      .map(|candidate| values.iter().any(|value| value == candidate))
      .unwrap_or(false)
}

pub fn parse_reindex_reason(value: &str) -> DocumentGraphResult<DocumentGraphReindexReason> {
  DocumentGraphReindexReason::from_str(value)
    .map_err(|_| DocumentGraphServiceError::new(ERR_QUERY_INVALID, "invalid document graph reindex reason"))
}

#[async_trait::async_trait]
impl DocumentGraphIndexHook for DocumentGraphService {
  async fn enqueue_document_graph_reindex(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    reason: DocumentGraphReindexReason,
  ) -> Result<(), String> {
    self
      .enqueue_document_reindex(workspace_id, doc_id, reason)
      .await
      .map(|_| ())
      .map_err(|error| error.to_string())
  }

  async fn mark_document_graph_deleted(&self, workspace_id: WorkspaceId, doc_id: DocId) -> Result<(), String> {
    self
      .mark_document_deleted(workspace_id, doc_id)
      .await
      .map_err(|error| error.to_string())
  }

  async fn database_reference_refreshes_before_delete(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
  ) -> Result<Vec<myoxus_domain::database::DatabaseDocumentReferenceRefresh>, String> {
    let Some(repo) = self.projection_repo.as_ref() else {
      return Ok(Vec::new());
    };
    repo
      .list_document_reference_refreshes_for_target(workspace_id, doc_id)
      .await
      .map_err(|error| error.to_string())
  }

  async fn enqueue_database_reference_refreshes(
    &self,
    refreshes: Vec<myoxus_domain::database::DatabaseDocumentReferenceRefresh>,
  ) -> Result<(), String> {
    let projection_repo = self.projection_repo.clone();
    for refresh in refreshes {
      let queued = if let Some(queue) = &self.queue {
        queue
          .add_job(
            crate::database::DATABASE_QUEUE,
            crate::database::JOB_INDEX_ROW,
            serde_json::json!({
              "workspace_id": refresh.workspace_id,
              "database_id": refresh.database_id,
              "row_id": refresh.row_id,
            }),
            None,
            Some(0),
          )
          .await
          .is_ok()
      } else {
        false
      };
      if !queued && let Some(repo) = &projection_repo {
        repo
          .refresh_document_references_for_row(refresh.row_id)
          .await
          .map_err(|error| error.to_string())?;
      }
    }
    Ok(())
  }
}
