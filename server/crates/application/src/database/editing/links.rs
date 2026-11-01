// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

impl DatabaseEditingService {
  /// Row content must remain owned by the Row workspace, even after a transfer.
  /// A null association is not a missing target.
  pub async fn resolve_content_document(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    content_document_id: Option<DocId>,
  ) -> DatabaseResult<Option<DatabaseRowContentDocument>> {
    self
      .resolve_document_target(actor, workspace_id, content_document_id, false)
      .await
  }

  /// Lateral links retain their SQL identity and stored qualification. Only a
  /// committed origin proof permits following that identity to its current owner;
  /// current destination permissions still decide every exposed field.
  pub async fn resolve_document_link(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    document_id: DocId,
  ) -> DatabaseResult<Option<DatabaseRowContentDocument>> {
    self
      .resolve_document_target(actor, workspace_id, Some(document_id), true)
      .await
  }

  pub(in crate::database) async fn resolve_document_target(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    content_document_id: Option<DocId>,
    follow_transfer: bool,
  ) -> DatabaseResult<Option<DatabaseRowContentDocument>> {
    let Some(document_id) = content_document_id else {
      return Ok(None);
    };
    let document = self
      .doc_service
      .get_metadata_including_deleted(document_id)
      .await
      .map_err(|error| DatabaseServiceError::new(ERR_STORAGE, format!("document metadata lookup failed: {error}")))?;
    let Some(document) = document else {
      return Ok(Some(DatabaseRowContentDocument {
        document_id,
        external_id: None,
        workspace_id: None,
        state: DatabaseRowContentDocumentState::Missing,
        title: None,
      }));
    };
    let origin_proved = document.workspace_id == Some(workspace_id)
      || (follow_transfer
        && document.workspace_id.is_some()
        && self
          .doc_service
          .has_committed_transfer_from(document_id, workspace_id)
          .await
          .map_err(|error| {
            DatabaseServiceError::new(ERR_STORAGE, format!("document transfer origin lookup failed: {error}"))
          })?);
    let actual_workspace_id = document.workspace_id.unwrap_or(workspace_id);
    let readable = origin_proved
      && !document.blocked
      && self
        .permission
        .can(
          &DocResource {
            user_id: actor,
            workspace_id: actual_workspace_id,
            doc_id: document_id,
          },
          DocAction::Read,
        )
        .await;
    if !readable {
      return Ok(Some(DatabaseRowContentDocument {
        document_id,
        external_id: None,
        workspace_id: None,
        state: DatabaseRowContentDocumentState::Redacted,
        title: None,
      }));
    }
    if document.deleted_at.is_some() {
      return Ok(Some(DatabaseRowContentDocument {
        document_id,
        external_id: None,
        workspace_id: None,
        state: DatabaseRowContentDocumentState::Deleted,
        title: None,
      }));
    }
    Ok(Some(DatabaseRowContentDocument {
      document_id,
      external_id: Some(document.external_id),
      workspace_id: Some(actual_workspace_id),
      state: DatabaseRowContentDocumentState::Available,
      title: Some(document.title),
    }))
  }

  pub(in crate::database) async fn assert_attachable_content_document(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    content_document_id: DocId,
  ) -> DatabaseResult<()> {
    let projection = self
      .resolve_content_document(actor, workspace_id, Some(content_document_id))
      .await?
      .expect("a supplied content document id always resolves to a state");
    match projection.state {
      DatabaseRowContentDocumentState::Available => Ok(()),
      DatabaseRowContentDocumentState::Missing => {
        Err(DatabaseServiceError::new(ERR_NOT_FOUND, "content document not found"))
      }
      DatabaseRowContentDocumentState::Deleted => Err(DatabaseServiceError::new(
        ERR_ROW_INVALID,
        "deleted document cannot be attached as Row content",
      )),
      DatabaseRowContentDocumentState::Redacted => Err(DatabaseServiceError::new(
        ERR_FORBIDDEN,
        "content document is outside the Row workspace or is not readable",
      )),
    }
  }

  /// Creates a normal workspace page titled from the Row and attaches it.
  /// `create_page` is required here rather than metadata-only creation: its
  /// root-YDoc registration makes the page discoverable by every synced client.
  /// A failed optimistic attach permanently removes the just-created metadata,
  /// root registration and updates so repeated clicks cannot leave hidden
  /// orphan documents.
  #[instrument(
    skip(self),
    fields(actor_id = %actor, database_id = %database_id, row_id = %row_id, content_document_id = tracing::field::Empty)
  )]
  pub async fn create_row_content_document(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    expected_edit_revision: i64,
  ) -> DatabaseResult<DatabaseRowRecord> {
    self
      .create_row_content_document_with_sync_updates(actor, database_id, row_id, expected_edit_revision)
      .await
      .map(|(record, _)| record)
  }

  /// Variant used by API mutations that must fan the persisted leaf and root
  /// deltas out to clients already connected to the workspace sync room.
  #[instrument(
    skip(self),
    fields(actor_id = %actor, database_id = %database_id, row_id = %row_id, content_document_id = tracing::field::Empty)
  )]
  pub async fn create_row_content_document_with_sync_updates(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    expected_edit_revision: i64,
  ) -> DatabaseResult<(DatabaseRowRecord, crate::doc::CreatedPageSyncUpdates)> {
    self
      .create_empty_row_content_document(actor, database_id, row_id, expected_edit_revision)
      .await
  }

  // Empty content uses the existing optimistic attachment lifecycle; body
  // templates instead publish their prepared document in the Row creation tx.
  pub(in crate::database) async fn create_empty_row_content_document(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    expected_edit_revision: i64,
  ) -> DatabaseResult<(DatabaseRowRecord, crate::doc::CreatedPageSyncUpdates)> {
    let database = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let row = self
      .row_repo
      .get_row(row_id)
      .await?
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"))?;
    if row.row.database_id != database_id {
      return Err(DatabaseServiceError::new(
        ERR_ROW_INVALID,
        "row does not belong to database",
      ));
    }
    access::assert_workspace(
      &self.permission,
      actor,
      database.database.workspace_id,
      WorkspaceAction::CreateDoc,
    )
    .await?;
    let title = Some(row.row.title.clone());
    let (content_document, sync_updates) = self
      .doc_service
      .create_page_with_sync_updates(database.database.workspace_id, actor, title)
      .await
      .map_err(|error| DatabaseServiceError::new(ERR_STORAGE, format!("content document creation failed: {error}")))?;
    let content_document_id = content_document.id;
    tracing::Span::current().record("content_document_id", tracing::field::display(content_document_id));
    let updated = self
      .attach_created_row_content_document(
        actor,
        database_id,
        row_id,
        database.database.workspace_id,
        content_document_id,
        expected_edit_revision,
      )
      .await?;
    Ok((updated, sync_updates))
  }

  pub(in crate::database) async fn attach_created_row_content_document(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    workspace_id: WorkspaceId,
    content_document_id: DocId,
    expected_edit_revision: i64,
  ) -> DatabaseResult<DatabaseRowRecord> {
    match self
      .attach_row_content_document(actor, database_id, row_id, content_document_id, expected_edit_revision)
      .await
    {
      Ok(updated) => Ok(updated),
      Err(error) => {
        if let Err(cleanup_error) = self.doc_service.delete_doc(workspace_id, content_document_id).await {
          error!(
            %database_id,
            %row_id,
            %content_document_id,
            error = %cleanup_error,
            "failed to compensate unattached Row content document"
          );
          self
            .effects
            .record_audit(
              "database.row.content_document.compensation_failed",
              AuditCategory::Database,
              Some(AuditTarget::entity("database_row", row_id, None::<String>)),
              actor,
              None,
              Some(serde_json::json!({
                "databaseId": database_id,
                "contentDocumentId": content_document_id,
              })),
            )
            .await;
        }
        Err(error)
      }
    }
  }

  /// Attaches one readable same-workspace document as optional Row content.
  #[instrument(
    skip(self),
    fields(actor_id = %actor, database_id = %database_id, row_id = %row_id, content_document_id = %content_document_id, previous_content_document_id = tracing::field::Empty)
  )]
  pub async fn attach_row_content_document(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    content_document_id: DocId,
    expected_edit_revision: i64,
  ) -> DatabaseResult<DatabaseRowRecord> {
    let database = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let row = self
      .row_repo
      .get_row(row_id)
      .await?
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"))?;
    if row.row.database_id != database_id {
      return Err(DatabaseServiceError::new(
        ERR_ROW_INVALID,
        "row does not belong to database",
      ));
    }
    access::assert_workspace(
      &self.permission,
      actor,
      database.database.workspace_id,
      WorkspaceAction::CreateDoc,
    )
    .await?;
    self
      .assert_attachable_content_document(actor, database.database.workspace_id, content_document_id)
      .await?;
    let previous_content_document_id = row.row.content_document_id;
    let updated = self
      .row_repo
      .attach_row_content_document(
        row_id,
        content_document_id,
        actor,
        DatabaseEditPrecondition::new(Some(expected_edit_revision), false).in_workspace(database.database.workspace_id),
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    self
      .effects
      .record_activity(
        database.database.workspace_id,
        database.database.id,
        Some(row_id),
        DatabaseActivityEventType::RowContentDocumentAttached,
        actor,
        serde_json::json!({
          "contentDocumentId": content_document_id,
          "previousContentDocumentId": previous_content_document_id,
        }),
      )
      .await;
    self
      .effects
      .record_audit(
        "database.row.content_document.attach",
        AuditCategory::Database,
        Some(AuditTarget::entity("database_row", row_id, None::<String>)),
        actor,
        previous_content_document_id.map(|value| serde_json::json!({ "contentDocumentId": value })),
        Some(serde_json::json!({ "contentDocumentId": content_document_id })),
      )
      .await;
    self
      .projection
      .enqueue_index_row(database.database.workspace_id, database_id, row_id, 0)
      .await;
    tracing::Span::current().record(
      "previous_content_document_id",
      tracing::field::debug(previous_content_document_id),
    );
    self
      .effects
      .emit_change(
        database.database.workspace_id,
        database_id,
        DatabaseChangeKind::CellUpdated,
        actor,
        DatabaseChangeTarget {
          row_id: Some(row_id),
          field_id: None,
          view_id: None,
        },
      )
      .await;
    Ok(updated)
  }

  /// Detaches optional Row content without deleting the normal document.
  #[instrument(
    skip(self),
    fields(actor_id = %actor, database_id = %database_id, row_id = %row_id, previous_content_document_id = tracing::field::Empty)
  )]
  pub async fn detach_row_content_document(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    expected_edit_revision: i64,
  ) -> DatabaseResult<DatabaseRowRecord> {
    let database = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let row = self
      .row_repo
      .get_row(row_id)
      .await?
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"))?;
    if row.row.database_id != database_id {
      return Err(DatabaseServiceError::new(
        ERR_ROW_INVALID,
        "row does not belong to database",
      ));
    }
    access::assert_workspace(
      &self.permission,
      actor,
      database.database.workspace_id,
      WorkspaceAction::CreateDoc,
    )
    .await?;
    let previous_content_document_id = row.row.content_document_id;
    let updated = self
      .row_repo
      .detach_row_content_document(
        row_id,
        actor,
        DatabaseEditPrecondition::new(Some(expected_edit_revision), false).in_workspace(database.database.workspace_id),
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    self
      .effects
      .record_activity(
        database.database.workspace_id,
        database.database.id,
        Some(row_id),
        DatabaseActivityEventType::RowContentDocumentDetached,
        actor,
        serde_json::json!({ "previousContentDocumentId": previous_content_document_id }),
      )
      .await;
    self
      .effects
      .record_audit(
        "database.row.content_document.detach",
        AuditCategory::Database,
        Some(AuditTarget::entity("database_row", row_id, None::<String>)),
        actor,
        previous_content_document_id.map(|value| serde_json::json!({ "contentDocumentId": value })),
        None,
      )
      .await;
    self
      .projection
      .enqueue_index_row(database.database.workspace_id, database_id, row_id, 0)
      .await;
    tracing::Span::current().record(
      "previous_content_document_id",
      tracing::field::debug(previous_content_document_id),
    );
    self
      .effects
      .emit_change(
        database.database.workspace_id,
        database_id,
        DatabaseChangeKind::CellUpdated,
        actor,
        DatabaseChangeTarget {
          row_id: Some(row_id),
          field_id: None,
          view_id: None,
        },
      )
      .await;
    Ok(updated)
  }

  pub(in crate::database) async fn validate_relation_targets(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    field: &DatabaseField,
    target_row_ids: &[DatabaseRowId],
  ) -> DatabaseResult<()> {
    let DatabaseFieldConfig::Relation(config) = &field.config else {
      return Err(DatabaseServiceError::new(
        ERR_RELATION_TARGET_DATABASE_INVALID,
        "relation cell requires relation field config",
      ));
    };
    for target_row_id in target_row_ids {
      let target_row = self
        .row_repo
        .get_row(*target_row_id)
        .await?
        .ok_or_else(|| DatabaseServiceError::new(ERR_RELATION_TARGET_ROW_INVALID, "target row not found"))?;
      if target_row.row.database_id != config.target_database_id {
        return Err(DatabaseServiceError::new(
          ERR_RELATION_TARGET_DATABASE_INVALID,
          "target row does not belong to the configured target database",
        ));
      }
      access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    }
    Ok(())
  }

  pub(in crate::database) async fn validate_files_value(
    &self,
    workspace_id: WorkspaceId,
    field: &DatabaseField,
    value: &DatabaseFilesValue,
  ) -> DatabaseResult<()> {
    let DatabaseFieldConfig::Files(config) = &field.config else {
      return Err(DatabaseServiceError::new(
        ERR_FIELD_INVALID,
        "files cell requires files field config",
      ));
    };
    let blob_service = self
      .blob_service
      .as_ref()
      .cloned()
      .ok_or_else(|| DatabaseServiceError::new(ERR_STORAGE, "blob service is not configured"))?;
    let allowed_categories = if config.allowed_mime_categories.is_empty() {
      vec![DatabaseFileMimeCategory::Any]
    } else {
      config.allowed_mime_categories.clone()
    };
    for file in &value.files {
      let metadata = blob_service
        .get_blob_metadata(workspace_id, &file.blob_key)
        .await
        .map_err(|error| DatabaseServiceError::new(ERR_STORAGE, format!("blob metadata lookup failed: {error}")))?
        .ok_or_else(|| DatabaseServiceError::new(ERR_FILES_INVALID, "files cell references an unknown blob"))?;
      if metadata.deleted_at.is_some() || metadata.status != BlobStatus::Completed {
        return Err(DatabaseServiceError::new(
          ERR_FILES_INVALID,
          "files cell references an unavailable blob",
        ));
      }
      if let Some(max_size) = config.max_item_size
        && metadata.size > max_size as u64
      {
        return Err(DatabaseServiceError::new(
          ERR_FILES_INVALID,
          "files cell references a blob larger than the configured limit",
        ));
      }
      if !allowed_categories
        .iter()
        .any(|category| category.matches_mime(&metadata.mime))
      {
        return Err(DatabaseServiceError::new(
          ERR_FILES_INVALID,
          "files cell references a blob with a disallowed mime type",
        ));
      }
      if let Some(mime) = &file.mime
        && mime.trim() != metadata.mime
      {
        return Err(DatabaseServiceError::new(
          ERR_FILES_INVALID,
          "files cell mime metadata must match the referenced blob",
        ));
      }
      if let Some(size) = file.size
        && size as u64 != metadata.size
      {
        return Err(DatabaseServiceError::new(
          ERR_FILES_INVALID,
          "files cell size metadata must match the referenced blob",
        ));
      }
    }
    Ok(())
  }
}
