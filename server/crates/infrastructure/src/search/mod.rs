//! PostgreSQL-backed search repository and application search store.
//!
//! [`SqlxSearchRepository`] implements both [`SearchRepository`] (low-level
//! domain trait) and the application-layer [`ApplicationSearchStore`] (which
//! adds reindex run management).  Full-text search uses PostgreSQL `tsvector`
//! with a language-aware FTS configuration selected from the document's
//! declared language.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use tracing::{debug, error, instrument};
use uuid::Uuid;

use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::search::{
  SearchReindexMode, SearchReindexRun, SearchReindexStatus, SearchSourceDoc, SearchStore as ApplicationSearchStore,
};
use myoxus_domain::entities::SearchDocument;
use myoxus_domain::repositories::{
  PageRequest, RepoResult, RepositoryError, SearchPageRequest, SearchRepository, SearchSortBy, SortDirection,
};
use myoxus_domain::workspace_tags::{WorkspaceTagColorRole, WorkspaceTagSearchProjection};

/// PostgreSQL-backed implementation of [`SearchRepository`] and
/// [`ApplicationSearchStore`].
pub struct SqlxSearchRepository {
  /// Database connection pool.
  pool: PgPool,
}

impl SqlxSearchRepository {
  /// Construct a `SqlxSearchRepository` from an existing pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in search repository");
    RepositoryError::Storage(err.to_string())
  }

  fn map_db_err_auth(err: sqlx::Error) -> AuthError {
    error!(error = %err, "database error in search store");
    AuthError::Storage(err.to_string())
  }

  fn map_row(row: sqlx::postgres::PgRow) -> SearchDocument {
    SearchDocument {
      workspace_id: row.get("workspace_id"),
      doc_id: row.get("doc_id"),
      title: row.get("title"),
      plain_text: row.get("plain_text"),
      workspace_tags: row
        .try_get::<serde_json::Value, _>("workspace_tags")
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default(),
      search_vector: None,
      updated_at: row.get("updated_at"),
    }
  }

  /// Map an IETF language tag (or `None`) to a PostgreSQL FTS configuration
  /// name.  Falls back to `"simple"` for unrecognised locales.
  fn fts_config(language: Option<&str>) -> &'static str {
    match language.unwrap_or("simple").trim().to_ascii_lowercase().as_str() {
      "en" | "en-us" | "en-gb" | "english" => "english",
      "de" | "de-de" | "de-at" | "de-ch" | "german" => "german",
      _ => "simple",
    }
  }

  fn parse_reindex_mode(value: &str) -> SearchReindexMode {
    match value {
      "incremental" => SearchReindexMode::Incremental,
      _ => SearchReindexMode::Full,
    }
  }

  fn parse_reindex_status(value: &str) -> SearchReindexStatus {
    match value {
      "completed" => SearchReindexStatus::Completed,
      "failed" => SearchReindexStatus::Failed,
      _ => SearchReindexStatus::Running,
    }
  }
}

#[async_trait]
impl SearchRepository for SqlxSearchRepository {
  #[instrument(skip(self))]
  async fn get_search_doc(&self, workspace_id: Uuid, doc_id: Uuid) -> RepoResult<Option<SearchDocument>> {
    let row = sqlx::query(
      r#"SELECT workspace_id, doc_id, title, plain_text, workspace_tags, updated_at
         FROM search_content
         WHERE workspace_id = $1 AND doc_id = $2"#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(Self::map_row))
  }

  /// Insert or update a search document.  The `search_vector` column is
  /// rebuilt from `title` and `plain_text` using the `simple` FTS config. The
  /// list-summary metadata projection is committed in the same transaction so
  /// clients cannot observe divergent successful writes.
  #[instrument(skip(self, doc))]
  async fn upsert_search_doc(&self, doc: &SearchDocument) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query(
      r#"
            INSERT INTO search_content
              (workspace_id, doc_id, title, plain_text, workspace_tags, search_vector, updated_at)
            VALUES ($1, $2, $3, $4, $5,
                    to_tsvector('simple', $3 || ' ' || $4 || ' ' || $5::text), $6)
            ON CONFLICT (workspace_id, doc_id)
            DO UPDATE SET
                title = EXCLUDED.title,
                plain_text = EXCLUDED.plain_text,
                workspace_tags = EXCLUDED.workspace_tags,
                search_vector = EXCLUDED.search_vector,
                updated_at = EXCLUDED.updated_at
            "#,
    )
    .bind(doc.workspace_id)
    .bind(doc.doc_id)
    .bind(&doc.title)
    .bind(&doc.plain_text)
    .bind(serde_json::to_value(&doc.workspace_tags).map_err(|error| RepositoryError::Validation(error.to_string()))?)
    .bind(doc.updated_at)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let updated = sqlx::query(
      "UPDATE docs
          SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('plain_text', $3::text)
        WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL",
    )
    .bind(doc.workspace_id)
    .bind(doc.doc_id)
    .bind(&doc.plain_text)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if updated.rows_affected() != 1 {
      return Err(RepositoryError::NotFound("document"));
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Delete a single search document identified by workspace and document ID.
  #[instrument(skip(self))]
  async fn delete_search_doc(&self, workspace_id: Uuid, doc_id: Uuid) -> RepoResult<()> {
    sqlx::query("DELETE FROM search_content WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Execute a workspace-scoped full-text search.  Combines `simple` and
  /// locale-aware FTS ranks, with an `ILIKE` fallback for short tokens.
  /// Returns an empty slice when the query is blank.
  #[instrument(skip(self))]
  async fn search_docs(&self, req: SearchPageRequest) -> RepoResult<Vec<SearchDocument>> {
    let normalized_query = req.query.trim().to_string();
    if normalized_query.is_empty() {
      return Ok(Vec::new());
    }

    let fts_config = Self::fts_config(req.language.as_deref());
    let like = format!("%{}%", normalized_query);
    debug!(
        workspace_id = %req.workspace_id,
        fts_config,
        limit = req.page.limit,
        offset = req.page.offset,
        query_len = normalized_query.len(),
        "executing workspace-scoped full text search"
    );
    let rows = sqlx::query(
      r#"
            WITH ranked AS (
                SELECT
                    workspace_id,
                    doc_id,
                    title,
                    plain_text,
                    workspace_tags,
                    updated_at,
                    ts_rank_cd(search_vector, plainto_tsquery('simple', $2)) AS simple_rank,
                    ts_rank_cd(
                        to_tsvector($3::regconfig, title || ' ' || plain_text),
                        websearch_to_tsquery($3::regconfig, $2)
                    ) AS locale_rank
                FROM search_content
                WHERE workspace_id = $1
                  AND (
                    search_vector @@ plainto_tsquery('simple', $2)
                    OR to_tsvector($3::regconfig, title || ' ' || plain_text)
                       @@ websearch_to_tsquery($3::regconfig, $2)
                    OR title ILIKE $4
                    OR plain_text ILIKE $4
                  )
            )
            SELECT workspace_id, doc_id, title, plain_text, workspace_tags, updated_at
            FROM ranked
            ORDER BY
                CASE WHEN $5 = 'relevance' AND $6 = 'asc'
                    THEN (locale_rank * 0.8 + simple_rank * 0.2)
                END ASC,
                CASE WHEN $5 = 'relevance' AND $6 = 'desc'
                    THEN (locale_rank * 0.8 + simple_rank * 0.2)
                END DESC,
                CASE WHEN $5 = 'updated_at' AND $6 = 'asc'
                    THEN updated_at
                END ASC,
                CASE WHEN $5 = 'updated_at' AND $6 = 'desc'
                    THEN updated_at
                END DESC,
                updated_at DESC, doc_id ASC
            LIMIT $7 OFFSET $8
            "#,
    )
    .bind(req.workspace_id)
    .bind(&normalized_query)
    .bind(fts_config)
    .bind(&like)
    .bind(match req.sort_by {
      SearchSortBy::Relevance => "relevance",
      SearchSortBy::UpdatedAt => "updated_at",
    })
    .bind(match req.sort_direction {
      SortDirection::Asc => "asc",
      SortDirection::Desc => "desc",
    })
    .bind(req.page.limit)
    .bind(req.page.offset)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  /// P1 (SRV-01): field-scoped full-text search.
  ///
  /// `field` has already been validated by the search-query plan compiler.
  /// The implementation dispatches to a column-restricted `to_tsvector` /
  /// `websearch_to_tsquery` so that `field = "title"` only ever matches
  /// documents whose `title` column produces a hit, and likewise for
  /// `plainText`. The fallback `ILIKE` matches the existing `search_docs`
  /// behaviour so that short tokens do not silently disappear.
  #[instrument(skip(self))]
  async fn search_docs_in_field(
    &self,
    workspace_id: Uuid,
    field: &str,
    keyword: &str,
    language: Option<&str>,
    page: PageRequest,
  ) -> RepoResult<Vec<SearchDocument>> {
    let normalised = keyword.trim();
    if normalised.is_empty() {
      return Ok(Vec::new());
    }
    let column = match field {
      "plainText" => "plain_text",
      "title" => "title",
      // Defensive: the plan compiler rejects unknown fields, but if a
      // caller bypasses the compiler we still refuse to scan arbitrary
      // columns.
      _ => {
        return Err(RepositoryError::Validation(format!(
          "search_docs_in_field: unsupported field {field}"
        )));
      }
    };
    let fts_config = Self::fts_config(language);
    let like = format!("%{}%", normalised);
    let sql = format!(
      r#"
            SELECT workspace_id, doc_id, title, plain_text, workspace_tags, updated_at
            FROM search_content
            WHERE workspace_id = $1
              AND (
                to_tsvector($2::regconfig, COALESCE({column}, ''))
                  @@ websearch_to_tsquery($2::regconfig, $3)
                OR {column} ILIKE $4
              )
            ORDER BY
              ts_rank_cd(
                to_tsvector($2::regconfig, COALESCE({column}, '')),
                websearch_to_tsquery($2::regconfig, $3)
              ) DESC,
              updated_at DESC
            LIMIT $5 OFFSET $6
            "#
    );
    let rows = sqlx::query(&sql)
      .bind(workspace_id)
      .bind(fts_config)
      .bind(normalised)
      .bind(&like)
      .bind(page.limit.max(0))
      .bind(page.offset.max(0))
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    debug!(
      workspace_id = %workspace_id,
      field,
      query_len = normalised.len(),
      hits = rows.len(),
      "field-scoped search executed"
    );
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  /// P1 (SRV-01): list every indexed document id in the workspace, bounded by
  /// `limit`. Powers the `MustNot` set-algebra step.
  #[instrument(skip(self))]
  async fn list_doc_ids_in_workspace(&self, workspace_id: Uuid, limit: i64) -> RepoResult<Vec<uuid::Uuid>> {
    let rows = sqlx::query(
      r#"
            SELECT doc_id
            FROM search_content
            WHERE workspace_id = $1
            ORDER BY doc_id
            LIMIT $2
            "#,
    )
    .bind(workspace_id)
    .bind(limit.max(0))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(|row| row.get::<uuid::Uuid, _>("doc_id")).collect())
  }

  /// P1 (SRV-01): list every document id in the workspace whose `field`
  /// column is non-null and non-empty. Powers the `Exists` operator.
  #[instrument(skip(self))]
  async fn list_doc_ids_with_field_exists(&self, workspace_id: Uuid, field: &str) -> RepoResult<Vec<uuid::Uuid>> {
    let column = match field {
      "plainText" => "plain_text",
      "title" => "title",
      _ => {
        return Err(RepositoryError::Validation(format!(
          "list_doc_ids_with_field_exists: unsupported field {field}"
        )));
      }
    };
    let sql = format!(
      r#"
            SELECT doc_id
            FROM search_content
            WHERE workspace_id = $1 AND {column} IS NOT NULL AND {column} <> ''
            ORDER BY doc_id
            "#
    );
    let rows = sqlx::query(&sql)
      .bind(workspace_id)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(|row| row.get::<uuid::Uuid, _>("doc_id")).collect())
  }

  /// P1 (SRV-01): hydrate `SearchDocument` rows for a precomputed doc-id set.
  #[instrument(skip(self, ids))]
  async fn list_search_docs_by_ids(&self, workspace_id: Uuid, ids: &[uuid::Uuid]) -> RepoResult<Vec<SearchDocument>> {
    if ids.is_empty() {
      return Ok(Vec::new());
    }
    let rows = sqlx::query(
      r#"
            SELECT workspace_id, doc_id, title, plain_text, workspace_tags, updated_at
            FROM search_content
            WHERE workspace_id = $1 AND doc_id = ANY($2)
            ORDER BY updated_at DESC
            "#,
    )
    .bind(workspace_id)
    .bind(ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self))]
  async fn cleanup_trashed_documents(&self) -> RepoResult<u64> {
    sqlx::query("DELETE FROM search_content WHERE doc_id IN (SELECT id FROM docs WHERE deleted_at IS NOT NULL)")
      .execute(&self.pool)
      .await
      .map(|result| result.rows_affected())
      .map_err(Self::map_db_err)
  }
}

#[async_trait]
impl ApplicationSearchStore for SqlxSearchRepository {
  /// Fetch a single search document by workspace + document ID, returning
  /// `None` when not found.
  #[instrument(skip(self))]
  async fn get_search_doc(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Option<SearchDocument>> {
    let row = sqlx::query(
      r#"
            SELECT workspace_id, doc_id, title, plain_text, workspace_tags, updated_at
            FROM search_content
            WHERE workspace_id = $1 AND doc_id = $2
            "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;
    Ok(row.map(Self::map_row))
  }

  #[instrument(skip(self, doc_ids))]
  async fn list_search_docs_by_ids(&self, workspace_id: Uuid, doc_ids: &[Uuid]) -> AuthResult<Vec<SearchDocument>> {
    SearchRepository::list_search_docs_by_ids(self, workspace_id, doc_ids)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))
  }

  /// Upsert a search document (application-layer variant, delegates to
  /// [`SearchRepository::upsert_search_doc`]).
  #[instrument(skip(self, doc))]
  async fn upsert_search_doc(&self, doc: SearchDocument) -> AuthResult<()> {
    SearchRepository::upsert_search_doc(self, &doc)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  #[instrument(skip(self))]
  async fn list_document_workspace_tags(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<Vec<WorkspaceTagSearchProjection>> {
    use std::str::FromStr;

    let rows = sqlx::query(
      r#"
        SELECT tag.id, tag.name, tag.slug, tag.color_role
          FROM workspace_tag_document_assignments assignment
          JOIN workspace_tags tag
            ON tag.workspace_id = assignment.workspace_id
           AND tag.id = assignment.tag_id
         WHERE assignment.workspace_id = $1
           AND assignment.doc_id = $2
         ORDER BY assignment.position ASC
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;

    rows
      .into_iter()
      .map(|row| {
        let color_role: String = row.get("color_role");
        let color_role =
          WorkspaceTagColorRole::from_str(&color_role).map_err(|error| AuthError::Storage(error.to_string()))?;
        Ok(WorkspaceTagSearchProjection {
          id: row.get("id"),
          name: row.get("name"),
          slug: row.get("slug"),
          color_role,
        })
      })
      .collect()
  }

  /// Delete a search document (application-layer variant, delegates to
  /// [`SearchRepository::delete_search_doc`]).
  #[instrument(skip(self))]
  async fn delete_search_doc(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<()> {
    SearchRepository::delete_search_doc(self, workspace_id, doc_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Delete all search documents belonging to a workspace.  Returns the
  /// number of deleted rows.
  #[instrument(skip(self))]
  async fn delete_search_docs_by_workspace(&self, workspace_id: Uuid) -> AuthResult<i64> {
    let result = sqlx::query("DELETE FROM search_content WHERE workspace_id = $1")
      .bind(workspace_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err_auth)?;
    Ok(result.rows_affected() as i64)
  }

  /// Create a new reindex run record with `status = 'running'`.  Returns the
  /// fully-populated [`SearchReindexRun`].
  #[instrument(skip(self))]
  async fn create_reindex_run(
    &self,
    mode: SearchReindexMode,
    workspace_id: Option<Uuid>,
    cursor_updated_at: Option<DateTime<Utc>>,
  ) -> AuthResult<SearchReindexRun> {
    let mode_str = match mode {
      SearchReindexMode::Full => "full",
      SearchReindexMode::Incremental => "incremental",
    };
    let row = sqlx::query(
      r#"
            INSERT INTO search_reindex_runs (
                mode,
                workspace_id,
                status,
                cursor_updated_at,
                cursor_doc_id,
                processed_count,
                indexed_count,
                started_at,
                updated_at,
                finished_at,
                error_message
            )
            VALUES ($1, $2, 'running', $3, NULL, 0, 0, now(), now(), NULL, NULL)
            RETURNING id, workspace_id, mode, status, cursor_updated_at, cursor_doc_id,
                      processed_count, indexed_count, started_at, updated_at, finished_at, error_message
            "#,
    )
    .bind(mode_str)
    .bind(workspace_id)
    .bind(cursor_updated_at)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;

    Ok(SearchReindexRun {
      id: row.get("id"),
      workspace_id: row.get("workspace_id"),
      mode: Self::parse_reindex_mode(row.get::<&str, _>("mode")),
      status: Self::parse_reindex_status(row.get::<&str, _>("status")),
      cursor_updated_at: row.get("cursor_updated_at"),
      cursor_doc_id: row.get("cursor_doc_id"),
      processed_count: row.get("processed_count"),
      indexed_count: row.get("indexed_count"),
      started_at: row.get("started_at"),
      updated_at: row.get("updated_at"),
      finished_at: row.get("finished_at"),
      error_message: row.get("error_message"),
    })
  }

  /// Fetch a reindex run by ID, returning `None` when not found.
  #[instrument(skip(self))]
  async fn get_reindex_run(&self, run_id: Uuid) -> AuthResult<Option<SearchReindexRun>> {
    let row = sqlx::query(
      r#"
            SELECT id, workspace_id, mode, status, cursor_updated_at, cursor_doc_id,
                   processed_count, indexed_count, started_at, updated_at, finished_at, error_message
            FROM search_reindex_runs
            WHERE id = $1
            "#,
    )
    .bind(run_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;

    Ok(row.map(|row| SearchReindexRun {
      id: row.get("id"),
      workspace_id: row.get("workspace_id"),
      mode: Self::parse_reindex_mode(row.get::<&str, _>("mode")),
      status: Self::parse_reindex_status(row.get::<&str, _>("status")),
      cursor_updated_at: row.get("cursor_updated_at"),
      cursor_doc_id: row.get("cursor_doc_id"),
      processed_count: row.get("processed_count"),
      indexed_count: row.get("indexed_count"),
      started_at: row.get("started_at"),
      updated_at: row.get("updated_at"),
      finished_at: row.get("finished_at"),
      error_message: row.get("error_message"),
    }))
  }

  /// Advance the pagination cursor and increment processed/indexed counters
  /// for an in-progress reindex run.
  #[instrument(skip(self))]
  async fn update_reindex_progress(
    &self,
    run_id: Uuid,
    cursor_updated_at: DateTime<Utc>,
    cursor_doc_id: Uuid,
    processed_inc: i64,
    indexed_inc: i64,
  ) -> AuthResult<()> {
    sqlx::query(
      r#"
            UPDATE search_reindex_runs
            SET cursor_updated_at = $2,
                cursor_doc_id = $3,
                processed_count = processed_count + $4,
                indexed_count = indexed_count + $5,
                updated_at = now()
            WHERE id = $1
            "#,
    )
    .bind(run_id)
    .bind(cursor_updated_at)
    .bind(cursor_doc_id)
    .bind(processed_inc)
    .bind(indexed_inc)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;
    Ok(())
  }

  /// Mark a reindex run as `completed` and record the finish timestamp.
  #[instrument(skip(self))]
  async fn complete_reindex_run(&self, run_id: Uuid) -> AuthResult<()> {
    sqlx::query(
      "UPDATE search_reindex_runs SET status = 'completed', finished_at = now(), updated_at = now() WHERE id = $1",
    )
    .bind(run_id)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;
    Ok(())
  }

  /// Mark a reindex run as `failed`, recording the error message and finish
  /// timestamp.
  #[instrument(skip(self))]
  async fn fail_reindex_run(&self, run_id: Uuid, error_message: String) -> AuthResult<()> {
    sqlx::query(
            "UPDATE search_reindex_runs SET status = 'failed', error_message = $2, finished_at = now(), updated_at = now() WHERE id = $1",
        )
        .bind(run_id)
        .bind(error_message)
        .execute(&self.pool)
        .await
        .map_err(Self::map_db_err_auth)?;
    Ok(())
  }

  /// Fetch a page of source documents for reindexing, optionally scoped to a
  /// single workspace. Uses keyset pagination on the latest authoritative
  /// document/snapshot/update activity and document ID, so update-only edits
  /// cannot remain behind an incremental cursor.
  #[instrument(skip(self))]
  async fn list_docs_for_reindex(
    &self,
    workspace_id: Option<Uuid>,
    cursor_updated_at: Option<DateTime<Utc>>,
    cursor_doc_id: Option<Uuid>,
    limit: i64,
  ) -> AuthResult<Vec<SearchSourceDoc>> {
    let rows = sqlx::query(
      r#"
            SELECT d.workspace_id,
                   d.id AS doc_id,
                   d.title,
                   GREATEST(
                     d.updated_at,
                     COALESCE(snapshot.latest_at, d.updated_at),
                     COALESCE(update_tail.latest_at, d.updated_at)
                   ) AS source_updated_at
            FROM docs d
            LEFT JOIN LATERAL (
              SELECT MAX(updated_at) AS latest_at
                FROM doc_snapshots
               WHERE workspace_id = d.workspace_id AND doc_id = d.id
            ) snapshot ON true
            LEFT JOIN LATERAL (
              SELECT MAX(server_timestamp) AS latest_at
                FROM doc_updates
               WHERE workspace_id = d.workspace_id AND doc_id = d.id
            ) update_tail ON true
            WHERE d.workspace_id IS NOT NULL
              AND d.deleted_at IS NULL
              AND ($1::uuid IS NULL OR d.workspace_id = $1)
              AND (
                $2::timestamptz IS NULL
                OR GREATEST(
                     d.updated_at,
                     COALESCE(snapshot.latest_at, d.updated_at),
                     COALESCE(update_tail.latest_at, d.updated_at)
                   ) > $2
                OR (GREATEST(
                      d.updated_at,
                      COALESCE(snapshot.latest_at, d.updated_at),
                      COALESCE(update_tail.latest_at, d.updated_at)
                    ) = $2
                    AND d.id > COALESCE($3, '00000000-0000-0000-0000-000000000000'::uuid))
              )
            ORDER BY source_updated_at ASC, d.id ASC
            LIMIT $4
            "#,
    )
    .bind(workspace_id)
    .bind(cursor_updated_at)
    .bind(cursor_doc_id)
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;

    Ok(
      rows
        .into_iter()
        .map(|row| SearchSourceDoc {
          workspace_id: row.get("workspace_id"),
          doc_id: row.get("doc_id"),
          title: row.get("title"),
          updated_at: row.get("source_updated_at"),
        })
        .collect(),
    )
  }
}

use myoxus_domain::entities::HybridSearchResult;

/// Hybrid search combining pgvector cosine similarity (`copilot_embeddings`)
/// with PostgreSQL full-text search (`search_content`) via Reciprocal Rank
/// Fusion (RRF, k=60).
///
/// The CTE computes independent rankings for each signal, then fuses them with
/// `1/(k + rank)` so that documents appearing in both result sets are boosted.
/// The vector signal must match the query model and dimension; retained vectors
/// from another encoder cannot contribute even when their source is still live.
/// Rank the best chunk per eligible document before limiting, so long documents
/// cannot consume the result page with duplicate rows or lose their title.
#[instrument(skip(pool, query_text, query_embedding))]
pub async fn hybrid_search(
  pool: &PgPool,
  workspace_id: Uuid,
  query_text: &str,
  query_embedding: &[f32],
  model: &str,
  limit: i32,
) -> Result<Vec<HybridSearchResult>, RepositoryError> {
  let query_trimmed = query_text.trim();
  if query_trimmed.is_empty() {
    return Ok(Vec::new());
  }
  debug!(
    %workspace_id,
    query_len = query_trimmed.len(),
    embedding_dim = query_embedding.len(),
    limit,
    "executing hybrid search (FTS + vector RRF)"
  );

  // Format the embedding as a PostgreSQL vector literal: '[0.1,0.2,...]'
  let embedding_literal = format!(
    "[{}]",
    query_embedding
      .iter()
      .map(|f| f.to_string())
      .collect::<Vec<_>>()
      .join(",")
  );

  let dimensions = query_embedding.len();
  let distance = crate::copilot::embedding_store::SqlxCopilotEmbeddingRepository::distance_sql(dimensions)?;
  let rows = sqlx::query(&format!(
    r#"
    WITH vector_sources AS (
        SELECT DISTINCT ON (e.source_id) e.source_id AS doc_id, e.chunk_text, d.title,
               {distance} AS distance
        FROM copilot_embeddings e
        JOIN docs d ON d.workspace_id=e.workspace_id AND d.id::text=e.source_id
        WHERE e.workspace_id = $2 AND e.source_type = 'doc' AND e.model=$5 AND vector_dims(e.embedding)={dimensions}
          AND d.deleted_at IS NULL AND NOT d.blocked AND NOT d.is_workspace_root
          AND d.external_id NOT LIKE 'db$%' AND d.external_id NOT LIKE 'userdata$%'
          AND NOT (COALESCE((SELECT ignored_doc_ids FROM copilot_workspaces WHERE workspace_id=$2),'[]'::jsonb) ? d.id::text)
          AND NOT EXISTS (SELECT 1 FROM (SELECT state FROM copilot_jobs j WHERE j.workspace_id=e.workspace_id AND j.job_type='copilot.embedding.add' AND j.payload->>'model'=e.model AND COALESCE(j.payload->>'dimensions','1536')=vector_dims(e.embedding)::text AND j.payload->>'sourceId'=e.source_id AND j.payload->>'sourceType'='doc' ORDER BY created_at DESC,id DESC LIMIT 1) latest WHERE latest.state<>'finished')
        ORDER BY e.source_id, {distance}, e.chunk_index
    ),
    vector_results AS (
        SELECT doc_id, chunk_text, title,
               ROW_NUMBER() OVER (ORDER BY distance, doc_id) AS vector_rank
        FROM vector_sources
        ORDER BY distance, doc_id
        LIMIT $4
    ),
    fts_results AS (
        SELECT doc_id::text AS doc_id, title,
               ROW_NUMBER() OVER (
                 ORDER BY ts_rank(search_vector, plainto_tsquery('simple', $3)) DESC
               ) AS fts_rank
        FROM search_content
        WHERE workspace_id = $2
          AND search_vector @@ plainto_tsquery('simple', $3)
        LIMIT $4
    )
    SELECT COALESCE(v.doc_id, f.doc_id) AS doc_id,
           COALESCE(f.title, v.title) AS title,
           v.chunk_text,
           (1.0::double precision /
             (60.0::double precision + COALESCE(v.vector_rank, 1000)::double precision)) +
           (1.0::double precision /
             (60.0::double precision + COALESCE(f.fts_rank, 1000)::double precision)) AS rrf_score
    FROM vector_results v
    FULL OUTER JOIN fts_results f ON v.doc_id = f.doc_id
    ORDER BY rrf_score DESC
    LIMIT $4
    "#,
  ))
  .bind(&embedding_literal)
  .bind(workspace_id)
  .bind(query_trimmed)
  .bind(limit)
  .bind(model)
  .fetch_all(pool)
  .await
  .map_err(|e| {
    error!(error = %e, "hybrid search query failed");
    RepositoryError::Storage(e.to_string())
  })?;

  Ok(
    rows
      .into_iter()
      .map(|row| HybridSearchResult {
        doc_id: row.get("doc_id"),
        title: row.get("title"),
        chunk_text: row.get("chunk_text"),
        rrf_score: row.get::<f64, _>("rrf_score"),
      })
      .collect(),
  )
}
