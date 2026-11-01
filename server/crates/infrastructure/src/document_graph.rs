//! SQLx repository for the server-authoritative Document Graph.

use std::str::FromStr;

use async_trait::async_trait;
use myoxus_domain::document_graph::*;
use myoxus_domain::ids::*;
use myoxus_domain::repositories::{DocumentGraphRepository, PageRequest, RepoResult, RepositoryError};
use sqlx::{PgPool, Row};
use tracing::{debug, instrument};

pub struct PgDocumentGraphRepository {
  pool: PgPool,
}

impl PgDocumentGraphRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_sqlx_error(err: sqlx::Error) -> RepositoryError {
    if let sqlx::Error::Database(db) = &err
      && let Some(code) = db.code()
      && matches!(code.as_ref(), "23505" | "23503" | "23514")
    {
      debug!(constraint = ?db.constraint(), message = %db.message(), "document graph constraint violation");
      return RepositoryError::Conflict("document graph constraint violation");
    }
    RepositoryError::Storage(err.to_string())
  }

  fn parse_link_kind(value: String) -> RepoResult<DocumentGraphLinkKind> {
    DocumentGraphLinkKind::from_str(value.as_str()).map_err(|error| RepositoryError::Validation(error.to_string()))
  }

  fn parse_target_state(value: String) -> RepoResult<DocumentGraphTargetState> {
    DocumentGraphTargetState::from_str(value.as_str()).map_err(|error| RepositoryError::Validation(error.to_string()))
  }

  fn parse_stale_state(value: String) -> RepoResult<DocumentGraphStaleState> {
    DocumentGraphStaleState::from_str(value.as_str()).map_err(|error| RepositoryError::Validation(error.to_string()))
  }

  fn map_occurrence(row: sqlx::postgres::PgRow) -> RepoResult<DocumentGraphOccurrence> {
    let link_kind = Self::parse_link_kind(row.try_get("link_kind").map_err(Self::map_sqlx_error)?)?;
    let target_state = Self::parse_target_state(row.try_get("target_state").map_err(Self::map_sqlx_error)?)?;
    Ok(DocumentGraphOccurrence {
      id: row.try_get("id").map_err(Self::map_sqlx_error)?,
      workspace_id: row.try_get("workspace_id").map_err(Self::map_sqlx_error)?,
      source_doc_id: row.try_get("source_doc_id").map_err(Self::map_sqlx_error)?,
      source_position: row.try_get("source_position").map_err(Self::map_sqlx_error)?,
      target_workspace_id: row.try_get("target_workspace_id").map_err(Self::map_sqlx_error)?,
      source_block_id: row.try_get("source_block_id").map_err(Self::map_sqlx_error)?,
      source_parent_block_id: row.try_get("source_parent_block_id").map_err(Self::map_sqlx_error)?,
      source_parent_flavour: row.try_get("source_parent_flavour").map_err(Self::map_sqlx_error)?,
      raw_target_doc_id: row.try_get("raw_target_doc_id").map_err(Self::map_sqlx_error)?,
      target_doc_id: row.try_get("target_doc_id").map_err(Self::map_sqlx_error)?,
      link_kind,
      params_json: row.try_get("params_json").map_err(Self::map_sqlx_error)?,
      params_key: row.try_get("params_key").map_err(Self::map_sqlx_error)?,
      markdown_preview: row.try_get("markdown_preview").map_err(Self::map_sqlx_error)?,
      target_state,
      extracted_at: row.try_get("extracted_at").map_err(Self::map_sqlx_error)?,
      source_updated_at: row.try_get("source_updated_at").map_err(Self::map_sqlx_error)?,
      created_at: row.try_get("created_at").map_err(Self::map_sqlx_error)?,
    })
  }

  fn map_index_state(row: sqlx::postgres::PgRow) -> RepoResult<DocumentGraphIndexState> {
    let stale_state = Self::parse_stale_state(row.try_get("stale_state").map_err(Self::map_sqlx_error)?)?;
    Ok(DocumentGraphIndexState {
      workspace_id: row.try_get("workspace_id").map_err(Self::map_sqlx_error)?,
      doc_id: row.try_get("doc_id").map_err(Self::map_sqlx_error)?,
      source_updated_at: row.try_get("source_updated_at").map_err(Self::map_sqlx_error)?,
      indexed_at: row.try_get("indexed_at").map_err(Self::map_sqlx_error)?,
      queued_at: row.try_get("queued_at").map_err(Self::map_sqlx_error)?,
      started_at: row.try_get("started_at").map_err(Self::map_sqlx_error)?,
      failed_at: row.try_get("failed_at").map_err(Self::map_sqlx_error)?,
      stale_state,
      error_code: row.try_get("error_code").map_err(Self::map_sqlx_error)?,
      error_message: row.try_get("error_message").map_err(Self::map_sqlx_error)?,
      attempt_count: row.try_get("attempt_count").map_err(Self::map_sqlx_error)?,
      occurrence_count: row.try_get("occurrence_count").map_err(Self::map_sqlx_error)?,
    })
  }

  async fn upsert_state(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    stale_state: DocumentGraphStaleState,
    reason: Option<DocumentGraphReindexReason>,
  ) -> RepoResult<()> {
    debug!(
      %workspace_id,
      %doc_id,
      stale_state = stale_state.as_str(),
      reason = reason.as_ref().map(DocumentGraphReindexReason::as_str),
      "upserting document graph index state"
    );
    sqlx::query(
      r#"
        INSERT INTO document_graph_index_state
          (workspace_id, doc_id, stale_state, queued_at, started_at, failed_at, error_code, error_message)
        SELECT
          $1,
          $2,
          $3,
          CASE WHEN $3 = 'queued' THEN now() ELSE NULL END,
          CASE WHEN $3 = 'extracting' THEN now() ELSE NULL END,
          NULL,
          NULL,
          NULL
        FROM docs
        WHERE id = $2 AND workspace_id = $1
        ON CONFLICT (workspace_id, doc_id) DO UPDATE
        SET stale_state = EXCLUDED.stale_state,
            queued_at = CASE WHEN EXCLUDED.stale_state = 'queued' THEN now() ELSE document_graph_index_state.queued_at END,
            started_at = CASE WHEN EXCLUDED.stale_state = 'extracting' THEN now() ELSE document_graph_index_state.started_at END,
            failed_at = NULL,
            error_code = NULL,
            error_message = NULL
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(stale_state.as_str())
    .execute(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(())
  }
}

#[async_trait]
impl DocumentGraphRepository for PgDocumentGraphRepository {
  #[instrument(skip(self, occurrences), fields(workspace_id = %workspace_id, doc_id = %doc_id, occurrence_count = occurrences.len()))]
  async fn replace_doc_occurrences(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    source_updated_at: Option<chrono::DateTime<chrono::Utc>>,
    occurrences: Vec<DocumentGraphOccurrence>,
  ) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    sqlx::query("DELETE FROM document_graph_occurrences WHERE workspace_id = $1 AND source_doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;

    for occurrence in &occurrences {
      sqlx::query(
        r#"
          INSERT INTO document_graph_occurrences
            (id, workspace_id, source_doc_id, source_block_id, source_parent_block_id,
             source_parent_flavour, raw_target_doc_id, target_doc_id, link_kind,
             params_json, params_key, markdown_preview, target_state, extracted_at,
             source_updated_at, created_at, target_workspace_id, source_position)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), $14, now(), $15, $16)
        "#,
      )
      .bind(occurrence.id)
      .bind(workspace_id)
      .bind(doc_id)
      .bind(&occurrence.source_block_id)
      .bind(&occurrence.source_parent_block_id)
      .bind(&occurrence.source_parent_flavour)
      .bind(&occurrence.raw_target_doc_id)
      .bind(occurrence.target_doc_id)
      .bind(occurrence.link_kind.as_str())
      .bind(&occurrence.params_json)
      .bind(&occurrence.params_key)
      .bind(&occurrence.markdown_preview)
      .bind(occurrence.target_state.as_str())
      .bind(source_updated_at)
      .bind(occurrence.target_workspace_id)
      .bind(&occurrence.source_position)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }

    sqlx::query(
      r#"
        INSERT INTO document_graph_index_state
          (workspace_id, doc_id, source_updated_at, indexed_at, stale_state, error_code, error_message, occurrence_count)
        VALUES ($1, $2, $3, now(), 'current', NULL, NULL, $4)
        ON CONFLICT (workspace_id, doc_id) DO UPDATE
        SET source_updated_at = EXCLUDED.source_updated_at,
            indexed_at = now(),
            stale_state = 'current',
            error_code = NULL,
            error_message = NULL,
            occurrence_count = EXCLUDED.occurrence_count
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(source_updated_at)
    .bind(occurrences.len() as i32)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  async fn mark_doc_graph_stale(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    reason: DocumentGraphReindexReason,
  ) -> RepoResult<()> {
    self
      .upsert_state(workspace_id, doc_id, DocumentGraphStaleState::Stale, Some(reason))
      .await
  }

  async fn mark_doc_graph_queued(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    reason: DocumentGraphReindexReason,
  ) -> RepoResult<()> {
    self
      .upsert_state(workspace_id, doc_id, DocumentGraphStaleState::Queued, Some(reason))
      .await
  }

  async fn mark_doc_graph_extracting(&self, workspace_id: WorkspaceId, doc_id: DocId) -> RepoResult<()> {
    self
      .upsert_state(workspace_id, doc_id, DocumentGraphStaleState::Extracting, None)
      .await
  }

  async fn mark_doc_graph_failed(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    error_code: &str,
    error_message: &str,
  ) -> RepoResult<()> {
    sqlx::query(
      r#"
        INSERT INTO document_graph_index_state
          (workspace_id, doc_id, stale_state, failed_at, error_code, error_message, attempt_count)
        SELECT $1, $2, 'failed', now(), $3, $4, 1
        FROM docs
        WHERE id = $2 AND workspace_id = $1
        ON CONFLICT (workspace_id, doc_id) DO UPDATE
        SET stale_state = 'failed',
            failed_at = now(),
            error_code = $3,
            error_message = $4,
            attempt_count = document_graph_index_state.attempt_count + 1
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(error_code)
    .bind(error_message)
    .execute(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  #[instrument(skip(self), fields(workspace_id = %workspace_id, doc_id = %doc_id))]
  async fn mark_doc_graph_deleted(&self, workspace_id: WorkspaceId, doc_id: DocId) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    sqlx::query("DELETE FROM document_graph_occurrences WHERE workspace_id = $1 AND source_doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    sqlx::query(
      r#"
        INSERT INTO document_graph_index_state
          (workspace_id, doc_id, stale_state, indexed_at, occurrence_count)
        SELECT $1, $2, 'deleted', now(), 0
        FROM docs
        WHERE id = $2 AND workspace_id = $1
        ON CONFLICT (workspace_id, doc_id) DO UPDATE
        SET stale_state = 'deleted',
            indexed_at = now(),
            occurrence_count = 0,
            error_code = NULL,
            error_message = NULL
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  async fn list_doc_occurrences(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
    direction: DocumentGraphDirection,
    page: PageRequest,
  ) -> RepoResult<Vec<DocumentGraphOccurrence>> {
    let rows = sqlx::query(
      r#"
        SELECT id, workspace_id, source_doc_id, source_block_id, source_parent_block_id,
               source_parent_flavour, raw_target_doc_id, target_doc_id, link_kind,
               params_json, params_key, markdown_preview, target_state, extracted_at,
               source_updated_at, created_at, target_workspace_id, source_position
        FROM document_graph_occurrences
        WHERE workspace_id = $1
          AND (
            ($3 = 'outgoing' AND source_doc_id = $2)
            OR ($3 = 'incoming' AND target_doc_id = $2)
            OR ($3 = 'both' AND (source_doc_id = $2 OR target_doc_id = $2))
          )
        ORDER BY source_doc_id ASC, target_state ASC, link_kind ASC, raw_target_doc_id ASC, source_block_id ASC
        LIMIT $4 OFFSET $5
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(direction.as_str())
    .bind(page.limit)
    .bind(page.offset)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    rows.into_iter().map(Self::map_occurrence).collect()
  }

  async fn list_workspace_edges(
    &self,
    workspace_id: WorkspaceId,
    query: DocumentGraphQuery,
  ) -> RepoResult<Vec<DocumentGraphEdge>> {
    let rows = sqlx::query(
      r#"
        SELECT o.source_doc_id,
               o.target_workspace_id,
               o.target_doc_id,
               o.raw_target_doc_id,
               o.target_state,
               o.link_kind,
               COUNT(*)::BIGINT AS occurrence_count,
               MIN(NULLIF(o.markdown_preview, '')) AS first_occurrence_preview,
               COALESCE(MAX(s.stale_state), 'current') AS stale_state
        FROM document_graph_occurrences o
        LEFT JOIN document_graph_index_state s
          ON s.workspace_id = o.workspace_id AND s.doc_id = o.source_doc_id
        WHERE o.workspace_id = $1
          AND (
            $2::uuid IS NULL
            OR ($3 = 'outgoing' AND o.source_doc_id = $2)
            OR ($3 = 'incoming' AND o.target_doc_id = $2)
            OR ($3 = 'both' AND (o.source_doc_id = $2 OR o.target_doc_id = $2))
          )
        GROUP BY o.source_doc_id, o.target_workspace_id, o.target_doc_id, o.raw_target_doc_id, o.target_state, o.link_kind
        ORDER BY o.source_doc_id ASC, o.target_workspace_id ASC, o.target_state ASC, o.link_kind ASC, o.raw_target_doc_id ASC
        LIMIT $4 OFFSET $5
      "#,
    )
    .bind(workspace_id)
    .bind(query.focus_doc_id)
    .bind(query.direction.as_str())
    .bind(query.page.first)
    .bind(query.page.offset)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;

    rows
      .into_iter()
      .map(|row| {
        Ok(DocumentGraphEdge {
          source_doc_id: row.try_get("source_doc_id").map_err(Self::map_sqlx_error)?,
          target_workspace_id: row.try_get("target_workspace_id").map_err(Self::map_sqlx_error)?,
          target_doc_id: row.try_get("target_doc_id").map_err(Self::map_sqlx_error)?,
          raw_target_doc_id: row.try_get("raw_target_doc_id").map_err(Self::map_sqlx_error)?,
          target_state: Self::parse_target_state(row.try_get("target_state").map_err(Self::map_sqlx_error)?)?,
          link_kind: Self::parse_link_kind(row.try_get("link_kind").map_err(Self::map_sqlx_error)?)?,
          occurrence_count: row.try_get("occurrence_count").map_err(Self::map_sqlx_error)?,
          first_occurrence_preview: row.try_get("first_occurrence_preview").map_err(Self::map_sqlx_error)?,
          stale_state: Self::parse_stale_state(row.try_get("stale_state").map_err(Self::map_sqlx_error)?)?,
          occurrences: Vec::new(),
        })
      })
      .collect()
  }

  async fn list_edge_occurrences(
    &self,
    workspace_id: WorkspaceId,
    source_doc_id: DocId,
    target_workspace_id: Option<WorkspaceId>,
    target_doc_id: Option<DocId>,
    raw_target_doc_id: &str,
    link_kind: DocumentGraphLinkKind,
    target_state: DocumentGraphTargetState,
    page: PageRequest,
  ) -> RepoResult<Vec<DocumentGraphOccurrence>> {
    let rows = sqlx::query(
      r#"
        SELECT id, workspace_id, source_doc_id, source_block_id, source_parent_block_id,
               source_parent_flavour, raw_target_doc_id, target_doc_id, link_kind,
               params_json, params_key, markdown_preview, target_state, extracted_at,
               source_updated_at, created_at, target_workspace_id, source_position
        FROM document_graph_occurrences
        WHERE workspace_id = $1
          AND source_doc_id = $2
          AND target_doc_id IS NOT DISTINCT FROM $3
          AND raw_target_doc_id = $4
          AND link_kind = $5
          AND target_state = $6
          AND target_workspace_id IS NOT DISTINCT FROM $9
        ORDER BY source_doc_id ASC, target_state ASC, link_kind ASC, raw_target_doc_id ASC, source_block_id ASC
        LIMIT $7 OFFSET $8
      "#,
    )
    .bind(workspace_id)
    .bind(source_doc_id)
    .bind(target_doc_id)
    .bind(raw_target_doc_id)
    .bind(link_kind.as_str())
    .bind(target_state.as_str())
    .bind(page.limit)
    .bind(page.offset)
    .bind(target_workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    rows.into_iter().map(Self::map_occurrence).collect()
  }

  async fn get_index_state(
    &self,
    workspace_id: WorkspaceId,
    doc_id: DocId,
  ) -> RepoResult<Option<DocumentGraphIndexState>> {
    let row = sqlx::query(
      r#"
        SELECT workspace_id, doc_id, source_updated_at, indexed_at, queued_at, started_at,
               failed_at, stale_state, error_code, error_message, attempt_count, occurrence_count
        FROM document_graph_index_state
        WHERE workspace_id = $1 AND doc_id = $2
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    row.map(Self::map_index_state).transpose()
  }

  #[instrument(skip(self, external_id), fields(%workspace_id))]
  async fn resolve_reference_target(
    &self,
    workspace_id: WorkspaceId,
    external_id: &str,
    _indexed_doc_id: Option<DocId>,
  ) -> RepoResult<Option<(WorkspaceId, DocId)>> {
    use myoxus_application::doc::{DocMetadataStore, DocSpaceKind};
    use myoxus_domain::workspace_content_operation::{WorkspaceContentResourceKind, WorkspaceContentResourceRef};
    let store = crate::doc::SqlxDocStore::new(self.pool.clone());
    // Workspace-local identity, including trash, outranks historical redirects.
    if let Some(doc_id) = store
      .resolve_external_doc_id(workspace_id, DocSpaceKind::Workspace, external_id)
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))?
    {
      return Ok(Some((workspace_id, doc_id)));
    }
    let source = WorkspaceContentResourceRef::new(workspace_id, WorkspaceContentResourceKind::Document, external_id)
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    let target = crate::workspace_content_operation::resolve_document_reference_in_tx(&mut tx, &source)
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let resolved = if let Some(target) = target {
      sqlx::query_scalar::<_, DocId>("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2")
        .bind(target.workspace_id())
        .bind(target.resource_id())
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .map(|id| (target.workspace_id(), id))
    } else {
      None
    };
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(resolved)
  }

  async fn get_document_node(&self, workspace_id: WorkspaceId, doc_id: DocId) -> RepoResult<Option<DocumentGraphNode>> {
    let row = sqlx::query(
      r#"
        SELECT id, external_id, title, deleted_at
        FROM docs
        WHERE workspace_id = $1 AND id = $2
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(row.map(|row| {
      DocumentGraphNode {
        workspace_id,
        doc_id: Some(row.get("id")),
        raw_doc_id: row.get("external_id"),
        title: row.get("title"),
        document_type: None,
        status: None,
        classification: None,
        deleted: row
          .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("deleted_at")
          .ok()
          .flatten()
          .is_some(),
        redacted: false,
      }
    }))
  }

  async fn get_workspace_index_summary(&self, workspace_id: WorkspaceId) -> RepoResult<DocumentGraphIndexSummary> {
    let row = sqlx::query(
      r#"
        SELECT
          COUNT(*) FILTER (WHERE s.stale_state = 'current')::BIGINT AS current_count,
          COUNT(*) FILTER (WHERE s.stale_state = 'stale')::BIGINT AS stale_count,
          COUNT(*) FILTER (WHERE s.stale_state = 'queued')::BIGINT AS queued_count,
          COUNT(*) FILTER (WHERE s.stale_state = 'extracting')::BIGINT AS extracting_count,
          COUNT(*) FILTER (WHERE s.stale_state = 'failed')::BIGINT AS failed_count,
          COUNT(*) FILTER (WHERE s.stale_state = 'deleted')::BIGINT AS deleted_count,
          COUNT(*) FILTER (WHERE s.stale_state IS NULL)::BIGINT AS missing_state_count
        FROM docs d
        LEFT JOIN document_graph_index_state s
          ON s.workspace_id = d.workspace_id AND s.doc_id = d.id
        WHERE d.workspace_id = $1
      "#,
    )
    .bind(workspace_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(DocumentGraphIndexSummary {
      workspace_id,
      current_count: row.try_get("current_count").map_err(Self::map_sqlx_error)?,
      stale_count: row.try_get("stale_count").map_err(Self::map_sqlx_error)?,
      queued_count: row.try_get("queued_count").map_err(Self::map_sqlx_error)?,
      extracting_count: row.try_get("extracting_count").map_err(Self::map_sqlx_error)?,
      failed_count: row.try_get("failed_count").map_err(Self::map_sqlx_error)?,
      deleted_count: row.try_get("deleted_count").map_err(Self::map_sqlx_error)?,
      missing_state_count: row.try_get("missing_state_count").map_err(Self::map_sqlx_error)?,
    })
  }

  async fn list_reindex_candidates(&self, workspace_id: WorkspaceId, limit: i64) -> RepoResult<Vec<DocId>> {
    sqlx::query_scalar(
      r#"
        SELECT d.id
        FROM docs d
        LEFT JOIN document_graph_index_state s
          ON s.workspace_id = d.workspace_id AND s.doc_id = d.id
        WHERE d.workspace_id = $1
          AND d.deleted_at IS NULL
          AND (s.doc_id IS NULL OR s.stale_state IN ('stale', 'failed'))
        ORDER BY COALESCE(s.failed_at, s.queued_at, s.indexed_at, d.updated_at) ASC NULLS FIRST, d.id ASC
        LIMIT $2
      "#,
    )
    .bind(workspace_id)
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)
  }

  async fn list_workspaces_with_reindex_candidates(&self, limit: i64) -> RepoResult<Vec<WorkspaceId>> {
    sqlx::query_scalar(
      r#"
        SELECT DISTINCT d.workspace_id
        FROM docs d
        LEFT JOIN document_graph_index_state s
          ON s.workspace_id = d.workspace_id AND s.doc_id = d.id
        WHERE d.workspace_id IS NOT NULL
          AND d.deleted_at IS NULL
          AND (s.doc_id IS NULL OR s.stale_state IN ('stale', 'failed'))
        ORDER BY d.workspace_id ASC
        LIMIT $1
      "#,
    )
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)
  }
}
