// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

impl PgDatabaseRepository {
  /// Replace IDs-only document references within the caller's transaction.
  /// Reference rows do not grant access to their source or target documents.
  pub(crate) async fn replace_document_references(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: WorkspaceId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
  ) -> RepoResult<()> {
    sqlx::query("DELETE FROM database_document_references WHERE row_id = $1")
      .bind(row_id)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;

    sqlx::query(
      r#"
        INSERT INTO database_document_references
          (workspace_id, database_id, row_id, field_id, reference_kind,
           raw_target_doc_id, resolved_target_doc_id, refreshed_at, target_workspace_id)
        SELECT $1, $2, r.id, NULL, 'row_content_document', r.doc_id::text,
               CASE WHEN d.workspace_id = $1 THEN d.id ELSE NULL END, now(), $1
        FROM workspace_database_rows r
        LEFT JOIN docs d ON d.id = r.doc_id
        WHERE r.id = $3 AND r.deleted_at IS NULL AND r.doc_id IS NOT NULL
      "#,
    )
    .bind(workspace_id)
    .bind(database_id)
    .bind(row_id)
    .execute(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    sqlx::query(
      r#"
        INSERT INTO database_document_references
          (workspace_id, database_id, row_id, field_id, reference_kind,
           raw_target_doc_id, resolved_target_doc_id, refreshed_at, target_workspace_id)
        SELECT $1, $2, c.row_id, c.field_id, 'document_link_field',
               c.value_json->>'docId',
               CASE WHEN d.workspace_id = scope.id THEN d.id ELSE NULL END,
               now(), scope.id
        FROM workspace_database_cell_values c
        JOIN workspace_database_rows r ON r.id = c.row_id AND r.deleted_at IS NULL
        JOIN workspace_database_fields f ON f.id = c.field_id AND f.field_type = 'document_link'
        CROSS JOIN LATERAL (
          SELECT CASE WHEN NOT (c.value_json ? 'workspaceId') THEN $1::uuid
                 WHEN c.value_json->>'workspaceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 THEN (c.value_json->>'workspaceId')::uuid ELSE NULL END AS id
        ) scope
        LEFT JOIN docs d ON d.id = (c.value_json->>'docId')::uuid
        WHERE c.row_id = $3
          AND c.value_json IS NOT NULL
          AND NULLIF(c.value_json->>'docId', '') IS NOT NULL
      "#,
    )
    .bind(workspace_id)
    .bind(database_id)
    .bind(row_id)
    .execute(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    sqlx::query("INSERT INTO database_document_references (workspace_id,database_id,row_id,field_id,reference_kind,raw_target_doc_id,resolved_target_doc_id,refreshed_at,target_workspace_id) SELECT $1,$2,s.row_id,NULL,'task_source',s.source_document_id::text,CASE WHEN d.workspace_id=s.source_workspace_id AND d.external_id=s.source_external_id THEN d.id ELSE NULL END,now(),s.source_workspace_id FROM database_row_source_links s JOIN workspace_database_rows r ON r.id=s.row_id AND r.deleted_at IS NULL LEFT JOIN docs d ON d.id=s.source_document_id WHERE s.row_id=$3")
      .bind(workspace_id).bind(database_id).bind(row_id).execute(&mut **tx).await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  pub(super) fn map_document_reference(row: sqlx::postgres::PgRow) -> RepoResult<DatabaseDocumentReference> {
    let reference_kind: String = row.try_get("reference_kind").map_err(Self::map_sqlx_error)?;
    Ok(DatabaseDocumentReference {
      workspace_id: row.try_get("workspace_id").map_err(Self::map_sqlx_error)?,
      target_workspace_id: row.try_get("target_workspace_id").map_err(Self::map_sqlx_error)?,
      database_id: row.try_get("database_id").map_err(Self::map_sqlx_error)?,
      database_title: row.try_get("database_title").map_err(Self::map_sqlx_error)?,
      row_id: row.try_get("row_id").map_err(Self::map_sqlx_error)?,
      row_title: row.try_get("row_title").map_err(Self::map_sqlx_error)?,
      field_id: row.try_get("field_id").map_err(Self::map_sqlx_error)?,
      field_name: row.try_get("field_name").map_err(Self::map_sqlx_error)?,
      reference_kind: DatabaseDocumentReferenceKind::from_str(&reference_kind)
        .map_err(|error| RepositoryError::Validation(error.to_string()))?,
      raw_target_doc_id: row.try_get("raw_target_doc_id").map_err(Self::map_sqlx_error)?,
      resolved_target_doc_id: row.try_get("resolved_target_doc_id").map_err(Self::map_sqlx_error)?,
      refreshed_at: row.try_get("refreshed_at").map_err(Self::map_sqlx_error)?,
    })
  }

  pub(super) async fn list_document_references(
    &self,
    workspace_id: WorkspaceId,
    target_doc_ids: &[DocId],
    include_all_workspace_references: bool,
    page: PageRequest,
  ) -> RepoResult<Vec<DatabaseDocumentReference>> {
    let rows = sqlx::query(
      r#"
        SELECT refs.workspace_id, refs.database_id, db.title AS database_title,
               refs.row_id, row.title AS row_title, refs.field_id,
               field.name AS field_name, refs.reference_kind,
               refs.raw_target_doc_id, refs.resolved_target_doc_id,
               refs.refreshed_at, refs.target_workspace_id
        FROM database_document_references refs
        JOIN workspace_databases db ON db.id = refs.database_id
        JOIN workspace_database_rows row ON row.id = refs.row_id AND row.deleted_at IS NULL
        LEFT JOIN workspace_database_fields field ON field.id = refs.field_id
        WHERE refs.workspace_id = $1
          AND db.deleted_at IS NULL
          AND (refs.reference_kind <> 'task_source'
            OR (db.workspace_id = $1 AND row.database_id = db.id))
          AND (
            $2
            OR refs.resolved_target_doc_id = ANY($3)
            OR (refs.target_workspace_id = $1 AND refs.resolved_target_doc_id IS NULL AND refs.raw_target_doc_id = ANY($4))
          )
        ORDER BY db.title ASC, row.position ASC, row.id ASC, field.position ASC NULLS FIRST
        LIMIT $5 OFFSET $6
      "#,
    )
    .bind(workspace_id)
    .bind(include_all_workspace_references)
    .bind(target_doc_ids)
    .bind(target_doc_ids.iter().map(ToString::to_string).collect::<Vec<_>>())
    .bind(page.limit.clamp(1, DATABASE_MAX_ROWS_PER_PAGE))
    .bind(page.offset.max(0))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    rows.into_iter().map(Self::map_document_reference).collect()
  }
}
