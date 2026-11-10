// SPDX-License-Identifier: AGPL-3.0-or-later
//! Derived SQL persistence on the canonical Database repository and pool.

mod hooks;
mod references;
mod values;

use super::*;
use myoxus_domain::workspace_tags::WorkspaceTagSearchProjection;

#[async_trait]
impl DatabaseProjectionRepository for PgDatabaseRepository {
  /// Search stored text within the selected workspace and optional Database.
  /// Actor-facing authorization stays with the consuming Application owner.
  async fn search_rows(&self, filter: DatabaseSearchFilter) -> RepoResult<Vec<DatabaseSearchHit>> {
    let limit = filter.first.unwrap_or(100).clamp(1, 500);
    let query = filter.query.trim();
    if query.is_empty() {
      return Ok(Vec::new());
    }
    // Projection refresh time still breaks rank ties; display the canonical Row's modification time.
    let rows = sqlx::query(
      r#"
        SELECT s.row_id, s.database_id, r.title, r.doc_id IS NOT NULL AS has_content_document, r.updated_at,
               ts_headline('simple', r.title || ' ' || s.tsv::text, websearch_to_tsquery('simple', $2),
                 'MaxFragments=1, MinWords=3, MaxWords=12') AS snippet
          FROM workspace_database_row_search s
          JOIN workspace_database_rows r ON r.id = s.row_id
          JOIN workspace_databases d ON d.id = s.database_id AND d.deleted_at IS NULL
         WHERE s.workspace_id = $1
           AND ($3::uuid IS NULL OR s.database_id = $3)
           AND s.tsv @@ websearch_to_tsquery('simple', $2)
         ORDER BY ts_rank(s.tsv, websearch_to_tsquery('simple', $2)) DESC, s.updated_at DESC, s.row_id
         LIMIT $4 OFFSET $5
      "#,
    )
    .bind(filter.workspace_id)
    .bind(query)
    .bind(filter.database_id)
    .bind(limit)
    .bind(filter.offset.unwrap_or(0).max(0))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    rows
      .into_iter()
      .map(|row| {
        let row_id: DatabaseRowId = sqlx::Row::get(&row, "row_id");
        let database_id: DatabaseId = sqlx::Row::get(&row, "database_id");
        let title: String = sqlx::Row::get(&row, "title");
        let snippet: Option<String> = sqlx::Row::get(&row, "snippet");
        let updated_at: DateTime<Utc> = sqlx::Row::get(&row, "updated_at");
        Ok(DatabaseSearchHit {
          row_id,
          database_id,
          title,
          snippet,
          has_content_document: row.try_get("has_content_document").map_err(Self::map_sqlx_error)?,
          updated_at,
        })
      })
      .collect::<RepoResult<Vec<_>>>()
  }

  /// P-DB-25: refresh the FTS row for a database row. The text content is
  /// built from the title plus server-side projection of the searchable
  /// cell values (Text, Email, URL, Phone, Select label). The upsert is
  /// idempotent; the worker calls it after every cell write.
  async fn upsert_search_row(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    expected_row_edit_revision: i64,
    title: String,
    tsv_text: String,
    workspace_tags: Vec<WorkspaceTagSearchProjection>,
  ) -> RepoResult<()> {
    let mut tx = self.begin_write().await?;
    Self::lock_managed_admission(&mut tx, database_id).await?;
    let row_meta: Option<(Uuid, Uuid)> = sqlx::query_as(
      "SELECT database.workspace_id,row.database_id FROM workspace_database_rows row JOIN workspace_databases database ON database.id=row.database_id WHERE row.id=$1 AND row.database_id=$2 AND row.edit_revision=$3 AND row.deleted_at IS NULL AND database.deleted_at IS NULL FOR SHARE OF row",
    ).bind(row_id).bind(database_id).bind(expected_row_edit_revision).fetch_optional(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    let (workspace_id, database_id) =
      row_meta.ok_or(RepositoryError::Conflict("database search projection changed"))?;
    let title_text = title.clone();
    let tsv_text = tsv_text.clone();
    sqlx::query(
      r#"
        INSERT INTO workspace_database_row_search
          (workspace_id, database_id, row_id, workspace_tags, title, search_text, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (row_id) DO UPDATE
          SET workspace_id = EXCLUDED.workspace_id, database_id = EXCLUDED.database_id,
              workspace_tags = EXCLUDED.workspace_tags,
              title = EXCLUDED.title,
              search_text = EXCLUDED.search_text,
              updated_at = now()
      "#,
    )
    .bind(workspace_id)
    .bind(database_id)
    .bind(row_id)
    .bind(serde_json::to_value(workspace_tags).map_err(|error| RepositoryError::Validation(error.to_string()))?)
    .bind(title_text)
    .bind(tsv_text)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    Self::replace_document_references(&mut tx, workspace_id, database_id, row_id).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  /// P-DB-25: remove the FTS row when the source row is deleted. The
  /// `ON DELETE CASCADE` on the FK takes care of the actual row removal;
  /// this is a defensive explicit delete for callers that bypass the
  /// cascade.
  async fn delete_search_row(&self, row_id: DatabaseRowId) -> RepoResult<()> {
    let mut tx = self.begin_write().await?;
    sqlx::query("DELETE FROM workspace_database_row_search WHERE row_id = $1")
      .bind(row_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    sqlx::query("DELETE FROM database_document_references WHERE row_id = $1")
      .bind(row_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  async fn list_stale_rollup_projection_tasks(
    &self,
    workspace_id: Option<WorkspaceId>,
    limit: i64,
    database_limit: i64,
  ) -> RepoResult<Vec<DatabaseRollupProjectionTask>> {
    let mut tx = self.begin_write().await?;
    let rows = sqlx::query(
      r#"
        WITH candidate_databases AS (
          SELECT DISTINCT d.id
          FROM workspace_databases d
          JOIN workspace_database_fields f ON f.database_id = d.id AND f.field_type = 'rollup'
          JOIN workspace_database_rows r ON r.database_id = d.id
          LEFT JOIN workspace_database_rollup_values rv ON rv.row_id = r.id AND rv.field_id = f.id
          WHERE ($1::uuid IS NULL OR d.workspace_id = $1)
            AND d.deleted_at IS NULL
            AND (NOT EXISTS(SELECT 1 FROM database_profiles profile WHERE profile.database_id=d.id AND profile.profile_kind='project') OR myoxus_database_source_admitted(d.managed_installation))
            AND r.deleted_at IS NULL
            AND (rv.row_id IS NULL OR rv.stale_state IN ('stale', 'failed', 'recompute_pending'))
          ORDER BY d.id
          LIMIT $2
        )
        SELECT f.database_id, r.id AS row_id, f.id AS field_id, f.config_json
        FROM workspace_database_rows r
        JOIN workspace_database_fields f ON f.database_id = r.database_id AND f.field_type = 'rollup'
        JOIN candidate_databases cd ON cd.id = f.database_id
        LEFT JOIN workspace_database_rollup_values rv ON rv.row_id = r.id AND rv.field_id = f.id
        WHERE r.deleted_at IS NULL
          AND (rv.row_id IS NULL OR rv.stale_state IN ('stale', 'failed', 'recompute_pending'))
        ORDER BY f.database_id, r.position ASC, r.id ASC, f.position ASC, f.id ASC
        LIMIT $3
      "#,
    )
    .bind(workspace_id)
    .bind(database_limit.max(1))
    .bind(limit.max(1))
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    tx.commit().await.map_err(Self::map_sqlx_error)?;
    rows
      .into_iter()
      .map(|row| {
        let config_json: Value = row.try_get("config_json").map_err(Self::map_sqlx_error)?;
        let config = serde_json::from_value::<DatabaseFieldConfig>(config_json)
          .map_err(|error| RepositoryError::Validation(error.to_string()))?;
        let DatabaseFieldConfig::Rollup(config) = config else {
          return Err(RepositoryError::Validation(
            "rollup task field config must be rollup".to_string(),
          ));
        };
        Ok(DatabaseRollupProjectionTask {
          database_id: row.try_get("database_id").map_err(Self::map_sqlx_error)?,
          row_id: row.try_get("row_id").map_err(Self::map_sqlx_error)?,
          field_id: row.try_get("field_id").map_err(Self::map_sqlx_error)?,
          config,
        })
      })
      .collect()
  }

  async fn list_rollup_target_values(
    &self,
    source_row_id: DatabaseRowId,
    source_relation_field_id: DatabaseFieldId,
    target_field_id: DatabaseFieldId,
  ) -> RepoResult<Vec<DatabaseRollupTargetValue>> {
    let target_field = sqlx::query(
      r#"
        SELECT id, database_id, name, field_type, config_json, position, required, edit_revision, created_at, updated_at
        FROM workspace_database_fields
        WHERE id = $1
      "#,
    )
    .bind(target_field_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database rollup target field"))?;
    let target_field = Self::map_field(target_field)?;

    let rows = sqlx::query(
      r#"
        SELECT edge.target_row_id, target_row.title, cv.value_json
        FROM workspace_database_relation_edges edge
        JOIN workspace_database_rows target_row ON target_row.id = edge.target_row_id
        LEFT JOIN workspace_database_cell_values cv
          ON cv.row_id = edge.target_row_id AND cv.field_id = $3
        WHERE edge.source_row_id = $1 AND edge.source_field_id = $2
        ORDER BY edge.position ASC, edge.target_row_id ASC
      "#,
    )
    .bind(source_row_id)
    .bind(source_relation_field_id)
    .bind(target_field_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;

    rows
      .into_iter()
      .map(|row| {
        let target_row_id = row.try_get("target_row_id").map_err(Self::map_sqlx_error)?;
        let value = if target_field.field_type == DatabaseFieldType::Title {
          Some(DatabaseCellValueData::Text(
            row.try_get("title").map_err(Self::map_sqlx_error)?,
          ))
        } else {
          row
            .try_get::<Option<Value>, _>("value_json")
            .map_err(Self::map_sqlx_error)?
            .map(|value| Self::map_cell_value_from_json(target_field.field_type, value))
            .transpose()?
        };
        Ok(DatabaseRollupTargetValue { target_row_id, value })
      })
      .collect()
  }

  async fn upsert_rollup_projection_value(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: Option<DatabaseRollupScalarValue>,
    source_hash: Option<String>,
    stale_state: DatabaseRollupStaleState,
    error_code: Option<String>,
    error_message: Option<String>,
  ) -> RepoResult<()> {
    let mut tx = self.begin_write().await?;
    Self::lock_projection_owner(&mut tx, database_id, row_id, field_id, "rollup").await?;
    let value_json = value
      .map(|value| serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string())))
      .transpose()?;
    let is_failed = stale_state == DatabaseRollupStaleState::Failed;
    sqlx::query(
      r#"
        INSERT INTO workspace_database_rollup_values
          (database_id, row_id, field_id, value_json, source_hash, stale_state,
           computed_at, failed_at, error_code, error_message, updated_at)
        VALUES (
          $1, $2, $3, $4, $5, $6,
          CASE WHEN $6 = 'current' THEN now() ELSE NULL END,
          CASE WHEN $7 THEN now() ELSE NULL END,
          $8, $9, now()
        )
        ON CONFLICT (row_id, field_id) DO UPDATE
          SET value_json = EXCLUDED.value_json,
              source_hash = EXCLUDED.source_hash,
              stale_state = EXCLUDED.stale_state,
              computed_at = EXCLUDED.computed_at,
              failed_at = EXCLUDED.failed_at,
              error_code = EXCLUDED.error_code,
              error_message = EXCLUDED.error_message,
              updated_at = now()
      "#,
    )
    .bind(database_id)
    .bind(row_id)
    .bind(field_id)
    .bind(value_json)
    .bind(source_hash)
    .bind(stale_state.as_str())
    .bind(is_failed)
    .bind(error_code)
    .bind(error_message)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  async fn replace_formula_dependencies(
    &self,
    formula_field_id: DatabaseFieldId,
    dependency_field_ids: Vec<DatabaseFieldId>,
  ) -> RepoResult<()> {
    let mut tx = self.begin_write().await?;
    sqlx::query("DELETE FROM workspace_database_formula_dependencies WHERE formula_field_id = $1")
      .bind(formula_field_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    for dependency_field_id in dependency_field_ids {
      sqlx::query(
        r#"
          INSERT INTO workspace_database_formula_dependencies (formula_field_id, dependency_field_id)
          VALUES ($1, $2)
          ON CONFLICT (formula_field_id, dependency_field_id) DO NOTHING
        "#,
      )
      .bind(formula_field_id)
      .bind(dependency_field_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  async fn list_stale_formula_projection_tasks(
    &self,
    workspace_id: Option<WorkspaceId>,
    limit: i64,
    database_limit: i64,
  ) -> RepoResult<Vec<DatabaseFormulaProjectionTask>> {
    let mut tx = self.begin_write().await?;
    let rows = sqlx::query(
      r#"
        WITH candidate_databases AS (
          SELECT DISTINCT d.id
          FROM workspace_databases d
          JOIN workspace_database_fields f ON f.database_id = d.id AND f.field_type = 'formula'
          JOIN workspace_database_rows r ON r.database_id = d.id
          LEFT JOIN workspace_database_formula_values fv ON fv.row_id = r.id AND fv.field_id = f.id
          WHERE ($1::uuid IS NULL OR d.workspace_id = $1)
            AND d.deleted_at IS NULL
            AND (NOT EXISTS(SELECT 1 FROM database_profiles profile WHERE profile.database_id=d.id AND profile.profile_kind='project') OR myoxus_database_source_admitted(d.managed_installation))
            AND r.deleted_at IS NULL
            AND (fv.row_id IS NULL OR fv.stale_state IN ('stale', 'failed', 'recompute_pending'))
          ORDER BY d.id
          LIMIT $2
        )
        SELECT f.database_id, r.id AS row_id, f.id AS field_id, f.config_json
        FROM workspace_database_rows r
        JOIN workspace_database_fields f ON f.database_id = r.database_id AND f.field_type = 'formula'
        JOIN candidate_databases cd ON cd.id = f.database_id
        LEFT JOIN workspace_database_formula_values fv ON fv.row_id = r.id AND fv.field_id = f.id
        WHERE r.deleted_at IS NULL
          AND (fv.row_id IS NULL OR fv.stale_state IN ('stale', 'failed', 'recompute_pending'))
        ORDER BY f.database_id, r.position ASC, r.id ASC, f.position ASC, f.id ASC
        LIMIT $3
      "#,
    )
    .bind(workspace_id)
    .bind(database_limit.max(1))
    .bind(limit.max(1))
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    tx.commit().await.map_err(Self::map_sqlx_error)?;
    rows
      .into_iter()
      .map(|row| {
        let config_json: Value = row.try_get("config_json").map_err(Self::map_sqlx_error)?;
        let config = serde_json::from_value::<DatabaseFieldConfig>(config_json)
          .map_err(|error| RepositoryError::Validation(error.to_string()))?;
        let DatabaseFieldConfig::Formula(config) = config else {
          return Err(RepositoryError::Validation(
            "formula task field config must be formula".to_string(),
          ));
        };
        Ok(DatabaseFormulaProjectionTask {
          database_id: row.try_get("database_id").map_err(Self::map_sqlx_error)?,
          row_id: row.try_get("row_id").map_err(Self::map_sqlx_error)?,
          field_id: row.try_get("field_id").map_err(Self::map_sqlx_error)?,
          config,
        })
      })
      .collect()
  }

  async fn list_formula_source_values(
    &self,
    row_id: DatabaseRowId,
    dependency_field_ids: Vec<DatabaseFieldId>,
  ) -> RepoResult<Vec<DatabaseFormulaSourceValue>> {
    if dependency_field_ids.is_empty() {
      return Ok(Vec::new());
    }
    let rows = sqlx::query(
      r#"
        SELECT f.id AS field_id, f.field_type, r.title, cv.value_json
        FROM workspace_database_fields f
        JOIN workspace_database_rows r ON r.database_id = f.database_id
        LEFT JOIN workspace_database_cell_values cv
          ON cv.row_id = r.id AND cv.field_id = f.id
        WHERE r.id = $1 AND f.id = ANY($2)
        ORDER BY f.position ASC, f.id ASC
      "#,
    )
    .bind(row_id)
    .bind(&dependency_field_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    rows
      .into_iter()
      .map(|row| {
        let field_id = row.try_get("field_id").map_err(Self::map_sqlx_error)?;
        let field_type = DatabaseFieldType::from_str(
          row
            .try_get::<String, _>("field_type")
            .map_err(Self::map_sqlx_error)?
            .as_str(),
        )
        .map_err(|error| RepositoryError::Validation(error.to_string()))?;
        let value = if field_type == DatabaseFieldType::Title {
          Some(DatabaseCellValueData::Text(
            row.try_get("title").map_err(Self::map_sqlx_error)?,
          ))
        } else {
          row
            .try_get::<Option<Value>, _>("value_json")
            .map_err(Self::map_sqlx_error)?
            .map(|value| Self::map_cell_value_from_json(field_type, value))
            .transpose()?
        };
        Ok(DatabaseFormulaSourceValue {
          field_id,
          field_type,
          value,
        })
      })
      .collect()
  }

  async fn upsert_formula_projection_value(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: Option<DatabaseFormulaScalarValue>,
    source_hash: Option<String>,
    stale_state: DatabaseFormulaStaleState,
    error_code: Option<String>,
    error_message: Option<String>,
  ) -> RepoResult<()> {
    let mut tx = self.begin_write().await?;
    Self::lock_projection_owner(&mut tx, database_id, row_id, field_id, "formula").await?;
    let value_json = value
      .map(|value| serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string())))
      .transpose()?;
    let is_failed = stale_state == DatabaseFormulaStaleState::Failed;
    sqlx::query(
      r#"
        INSERT INTO workspace_database_formula_values
          (database_id, row_id, field_id, value_json, source_hash, stale_state,
           computed_at, failed_at, error_code, error_message, updated_at)
        VALUES (
          $1, $2, $3, $4, $5, $6,
          CASE WHEN $6 = 'current' THEN now() ELSE NULL END,
          CASE WHEN $7 THEN now() ELSE NULL END,
          $8, $9, now()
        )
        ON CONFLICT (row_id, field_id) DO UPDATE
          SET value_json = EXCLUDED.value_json,
              source_hash = EXCLUDED.source_hash,
              stale_state = EXCLUDED.stale_state,
              computed_at = EXCLUDED.computed_at,
              failed_at = EXCLUDED.failed_at,
              error_code = EXCLUDED.error_code,
              error_message = EXCLUDED.error_message,
              updated_at = now()
      "#,
    )
    .bind(database_id)
    .bind(row_id)
    .bind(field_id)
    .bind(value_json)
    .bind(source_hash)
    .bind(stale_state.as_str())
    .bind(is_failed)
    .bind(error_code)
    .bind(error_message)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  async fn list_document_references_for_targets(
    &self,
    workspace_id: WorkspaceId,
    target_doc_ids: &[DocId],
    page: PageRequest,
  ) -> RepoResult<Vec<DatabaseDocumentReference>> {
    if target_doc_ids.is_empty() {
      return Ok(Vec::new());
    }
    self
      .list_document_references(workspace_id, target_doc_ids, false, page)
      .await
  }

  async fn list_document_references_for_workspace(
    &self,
    workspace_id: WorkspaceId,
    page: PageRequest,
  ) -> RepoResult<Vec<DatabaseDocumentReference>> {
    self.list_document_references(workspace_id, &[], true, page).await
  }

  async fn list_document_reference_refreshes_for_target(
    &self,
    workspace_id: WorkspaceId,
    target_doc_id: DocId,
  ) -> RepoResult<Vec<DatabaseDocumentReferenceRefresh>> {
    let rows = sqlx::query(
      r#"
        SELECT DISTINCT database_document_references.workspace_id,
                        database_document_references.database_id,
                        database_document_references.row_id
        FROM database_document_references
        JOIN workspace_databases
          ON workspace_databases.id = database_document_references.database_id
         AND workspace_databases.deleted_at IS NULL
        WHERE database_document_references.workspace_id = $1
          AND (
            database_document_references.resolved_target_doc_id = $2
            OR database_document_references.raw_target_doc_id = $2::text
          )
        ORDER BY database_document_references.database_id ASC,
                 database_document_references.row_id ASC
      "#,
    )
    .bind(workspace_id)
    .bind(target_doc_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    rows
      .into_iter()
      .map(|row| {
        Ok(DatabaseDocumentReferenceRefresh {
          workspace_id: row.try_get("workspace_id").map_err(Self::map_sqlx_error)?,
          database_id: row.try_get("database_id").map_err(Self::map_sqlx_error)?,
          row_id: row.try_get("row_id").map_err(Self::map_sqlx_error)?,
        })
      })
      .collect()
  }

  async fn refresh_document_references_for_row(&self, row_id: DatabaseRowId) -> RepoResult<()> {
    let mut tx = self.begin_write().await?;
    let row_meta: Option<(WorkspaceId, DatabaseId)> = sqlx::query_as(
      r#"
        SELECT db.workspace_id, row.database_id
        FROM workspace_database_rows row
        JOIN workspace_databases db ON db.id = row.database_id
        WHERE row.id = $1
          AND row.deleted_at IS NULL
          AND db.deleted_at IS NULL
      "#,
    )
    .bind(row_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    match row_meta {
      Some((workspace_id, database_id)) => {
        Self::replace_document_references(&mut tx, workspace_id, database_id, row_id).await?;
      }
      None => {
        sqlx::query("DELETE FROM database_document_references WHERE row_id = $1")
          .bind(row_id)
          .execute(&mut *tx)
          .await
          .map_err(Self::map_sqlx_error)?;
      }
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }
}
