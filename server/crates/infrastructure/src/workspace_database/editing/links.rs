// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::workspace_database::*;

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn persist_create_row_with_content_document(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    row_kind: DatabaseRowKind,
    title: String,
    created_by: UserId,
    cells: Vec<DatabaseCellValue>,
    precondition: DatabaseEditPrecondition,
    content_document_id: DocId,
  ) -> RepoResult<DatabaseRowRecord> {
    self
      .insert_row(
        database_id,
        row_id,
        row_kind,
        title,
        created_by,
        None,
        cells,
        precondition,
        None,
        Some(content_document_id),
      )
      .await
  }

  pub(in crate::workspace_database) async fn persist_attach_row_content_document(
    &self,
    row_id: DatabaseRowId,
    content_document_id: Uuid,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord> {
    let mut tx = self.begin_write().await?;
    let record =
      Self::attach_row_content_document_in_tx(&mut tx, row_id, content_document_id, updated_by, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(record)
  }

  /// Reuse native association validation within a caller's leaf/root/effect ACK
  /// transaction. Automated creation locks the target Row before document roots.
  pub(crate) async fn attach_row_content_document_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    row_id: DatabaseRowId,
    content_document_id: Uuid,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord> {
    let actual_revision =
      Self::lock_entity_edit_revision(tx, "workspace_database_rows", row_id, "database row").await?;
    Self::assert_edit_precondition(actual_revision, precondition, "database row edit revision")?;
    let current_content_document_id =
      sqlx::query_scalar::<_, Option<Uuid>>("SELECT doc_id FROM workspace_database_rows WHERE id = $1")
        .bind(row_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?;
    if current_content_document_id.is_some_and(|current| current != content_document_id) {
      return Err(RepositoryError::Validation(
        "database row already has a different content document".to_string(),
      ));
    }
    let row_workspace_id = sqlx::query_scalar::<_, Uuid>(
      r#"
        SELECT d.workspace_id
        FROM workspace_database_rows r
        JOIN workspace_databases d ON d.id = r.database_id
        WHERE r.id = $1 AND d.deleted_at IS NULL
      "#,
    )
    .bind(row_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database row"))?;
    let doc_workspace_id =
      sqlx::query_scalar::<_, Uuid>(r#"SELECT workspace_id FROM docs WHERE id = $1 AND deleted_at IS NULL"#)
        .bind(content_document_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::NotFound("document"))?;
    if doc_workspace_id != row_workspace_id {
      return Err(RepositoryError::Validation(
        "document must live in the same workspace as the database row".to_string(),
      ));
    }
    let row = sqlx::query(
      r#"
        UPDATE workspace_database_rows r
        SET doc_id = $2,
            updated_by = $3,
            edit_revision = edit_revision + 1,
            updated_at = now()
        WHERE r.id = $1
        RETURNING r.id, r.database_id, r.doc_id, r.title, r.position,
          r.row_kind, r.created_by, r.updated_by, r.edit_revision, r.created_at, r.updated_at,
          (SELECT d.deleted_at FROM docs d WHERE d.id = r.doc_id) AS deleted_at
      "#,
    )
    .bind(row_id)
    .bind(content_document_id)
    .bind(updated_by)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database row"))?;
    let mapped_row = Self::map_row(row)?;
    Self::assert_database_workspace(tx, mapped_row.database_id, precondition).await?;
    Ok(DatabaseRowRecord {
      row: mapped_row,
      cells: Vec::new(),
      cell_revisions: Vec::new(),
    })
  }

  pub(in crate::workspace_database) async fn persist_detach_row_content_document(
    &self,
    row_id: DatabaseRowId,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord> {
    let mut tx = self.begin_write().await?;
    let actual_revision =
      Self::lock_entity_edit_revision(&mut tx, "workspace_database_rows", row_id, "database row").await?;
    Self::assert_edit_precondition(actual_revision, precondition, "database row edit revision")?;
    let row = sqlx::query(
      r#"
        UPDATE workspace_database_rows r
        SET doc_id = NULL,
            updated_by = $2,
            edit_revision = edit_revision + 1,
            updated_at = now()
        WHERE r.id = $1
        RETURNING r.id, r.database_id, r.doc_id, r.title, r.position,
          r.row_kind, r.created_by, r.updated_by, r.edit_revision, r.created_at, r.updated_at,
          (SELECT d.deleted_at FROM docs d WHERE d.id = r.doc_id) AS deleted_at
      "#,
    )
    .bind(row_id)
    .bind(updated_by)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database row"))?;
    let mapped_row = Self::map_row(row)?;
    Self::assert_database_workspace(&mut tx, mapped_row.database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(DatabaseRowRecord {
      row: mapped_row,
      cells: Vec::new(),
      cell_revisions: Vec::new(),
    })
  }
}
