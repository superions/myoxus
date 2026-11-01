// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::workspace_database::*;

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn lock_task_capture_source(
    tx: &mut Transaction<'_, Postgres>,
    receipt: &DatabaseTaskCaptureReceipt,
  ) -> RepoResult<()> {
    let source_exists = sqlx::query_scalar::<_, Uuid>("SELECT id FROM docs WHERE id=$1 AND workspace_id=$2 AND external_id=$3 AND deleted_at IS NULL AND blocked=false FOR SHARE")
      .bind(receipt.source.document_id).bind(receipt.workspace_id).bind(&receipt.source.external_id)
      .fetch_optional(&mut **tx).await.map_err(Self::map_sqlx_error)?;
    if source_exists.is_none() {
      return Err(RepositoryError::Validation("capture source unavailable".into()));
    }
    Ok(())
  }
}

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn persist_get_task_capture_receipt(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
  ) -> RepoResult<Option<DatabaseTaskCaptureReceipt>> {
    let row = sqlx::query(
      "SELECT * FROM database_task_capture_receipts WHERE actor_id=$1 AND workspace_id=$2 AND request_id=$3",
    )
    .bind(actor)
    .bind(workspace)
    .bind(request)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    row
      .map(|r| {
        Ok(DatabaseTaskCaptureReceipt {
          actor_id: actor,
          workspace_id: workspace,
          request_id: request,
          fingerprint: r.try_get("fingerprint").map_err(Self::map_sqlx_error)?,
          database_id: r.try_get("database_id").map_err(Self::map_sqlx_error)?,
          row_id: r.try_get("row_id").map_err(Self::map_sqlx_error)?,
          edit_revision: r.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
          source: serde_json::from_value(r.try_get("source_json").map_err(Self::map_sqlx_error)?)
            .map_err(|e| RepositoryError::Storage(e.to_string()))?,
        })
      })
      .transpose()
  }

  pub(in crate::workspace_database) async fn persist_get_task_source(
    &self,
    row: DatabaseRowId,
  ) -> RepoResult<Option<DatabaseTaskSource>> {
    let r = sqlx::query("SELECT * FROM database_row_source_links WHERE row_id=$1")
      .bind(row)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_sqlx_error)?;
    r.map(|r| {
      Ok(DatabaseTaskSource {
        source_workspace_id: r.try_get("source_workspace_id").map_err(Self::map_sqlx_error)?,
        document_id: r.try_get("source_document_id").map_err(Self::map_sqlx_error)?,
        external_id: r.try_get("source_external_id").map_err(Self::map_sqlx_error)?,
        block_id: r.try_get("block_id").map_err(Self::map_sqlx_error)?,
        selection_anchor: r.try_get("selection_anchor").map_err(Self::map_sqlx_error)?,
      })
    })
    .transpose()
  }

  #[instrument(skip_all)]
  pub(in crate::workspace_database) async fn persist_create_task_capture(
    &self,
    title: String,
    cells: Vec<DatabaseCellValue>,
    receipt: DatabaseTaskCaptureReceipt,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord> {
    if receipt.source.source_workspace_id != receipt.workspace_id {
      return Err(RepositoryError::Validation("capture source workspace mismatch".into()));
    }
    self
      .insert_row(
        receipt.database_id,
        receipt.row_id,
        DatabaseRowKind::Task,
        title,
        receipt.actor_id,
        None,
        cells,
        precondition,
        Some(receipt),
        None,
      )
      .await
  }
}
