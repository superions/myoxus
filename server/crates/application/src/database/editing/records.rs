// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

impl DatabaseEditingService {
  pub async fn create_row(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    title: Option<String>,
    initial_cells: Vec<(DatabaseFieldId, DatabaseCellValueData)>,
  ) -> DatabaseResult<DatabaseRowRecord> {
    self
      .create_row_with_view_precondition(actor, database_id, title, initial_cells, None)
      .await
  }

  /// Create through the canonical path, optionally guarding the selected View
  /// whose fields/group rule supplied the interactive creation intent.
  pub async fn create_row_with_view_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    title: Option<String>,
    initial_cells: Vec<(DatabaseFieldId, DatabaseCellValueData)>,
    creation_view: Option<(DatabaseViewId, i64)>,
  ) -> DatabaseResult<DatabaseRowRecord> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    if creation_view.is_some_and(|(id, _)| !record.views.iter().any(|view| view.id == id)) {
      return Err(DatabaseServiceError::new(ERR_NOT_FOUND, "database view not found"));
    }
    let row_kind = match record.database.profile_kind {
      DatabaseProfileKind::Project => DatabaseRowKind::Task,
      DatabaseProfileKind::Generic => DatabaseRowKind::Record,
    };
    let result = self
      .create_row_with_kind_impl(
        actor,
        record,
        row_kind,
        title,
        initial_cells,
        creation_view,
        None,
        None,
        None,
        None,
      )
      .await;
    match result {
      Ok(created) => Ok(created),
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::View) => {
        let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
        let latest = record
          .views
          .iter()
          .find(|view| Some(view.id) == creation_view.map(|(id, _)| id))
          .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database view not found"))?;
        Err(
          DatabaseServiceError::new(ERR_VIEW_CONFLICT, "database view changed since creation began").with_latest_state(
            serde_json::json!({
              "kind": "view", "databaseId": database_id, "viewId": latest.id,
              "editRevision": latest.edit_revision, "name": latest.name,
              "viewKind": latest.view_kind.as_str(), "icon": latest.icon, "config": latest.config,
            }),
          ),
        )
      }
      result => result,
    }
  }

  pub(crate) async fn create_row_with_kind(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_kind: DatabaseRowKind,
    title: Option<String>,
    initial_cells: Vec<(DatabaseFieldId, DatabaseCellValueData)>,
    creation_template: (Uuid, i64),
    content: Option<(
      &crate::document_template::DocumentTemplateService,
      crate::document_template::PreparedDocumentTemplateContent,
    )>,
  ) -> DatabaseResult<DatabaseRowRecord> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    self
      .create_row_with_kind_impl(
        actor,
        record,
        row_kind,
        title,
        initial_cells,
        None,
        Some(creation_template),
        None,
        content,
        None,
      )
      .await
  }

  /// Use normal Row validation and publication with an already reserved native
  /// effect identity. The writer owns atomic effect acknowledgement.
  #[allow(clippy::too_many_arguments)]
  pub(crate) async fn create_automation_row(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    workspace_id: WorkspaceId,
    row_id: DatabaseRowId,
    title: String,
    cells: Vec<(DatabaseFieldId, DatabaseCellValueData)>,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> DatabaseResult<DatabaseRowRecord> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    if record.database.workspace_id != workspace_id {
      return Err(DatabaseServiceError::new(ERR_FORBIDDEN, "automation target moved"));
    }
    let kind = match record.database.profile_kind {
      DatabaseProfileKind::Project => DatabaseRowKind::Task,
      DatabaseProfileKind::Generic => DatabaseRowKind::Record,
    };
    self
      .create_row_with_kind_impl(
        actor,
        record,
        kind,
        Some(title),
        cells,
        None,
        None,
        None,
        None,
        Some((row_id, fence)),
      )
      .await
  }

  /// Validate Cells before preparing optional template content. Row, Cells,
  /// source receipt/content association and notification intent then share one
  /// native commit. A failed Row publication compensates its prepared document.
  #[instrument(
    skip(self, record, title, initial_cells, capture, content),
    fields(actor_id = %actor, database_id = %record.database.id, row_kind = tracing::field::Empty, row_id = tracing::field::Empty, initial_cells = tracing::field::Empty)
  )]
  pub(in crate::database) async fn create_row_with_kind_impl(
    &self,
    actor: UserId,
    record: DatabaseRecord,
    row_kind: DatabaseRowKind,
    title: Option<String>,
    initial_cells: Vec<(DatabaseFieldId, DatabaseCellValueData)>,
    creation_view: Option<(DatabaseViewId, i64)>,
    creation_template: Option<(Uuid, i64)>,
    capture: Option<DatabaseTaskCaptureReceipt>,
    content: Option<(
      &crate::document_template::DocumentTemplateService,
      crate::document_template::PreparedDocumentTemplateContent,
    )>,
    automation: Option<(
      DatabaseRowId,
      myoxus_domain::workspace_automation::AutomationEffectFence,
    )>,
  ) -> DatabaseResult<DatabaseRowRecord> {
    access::assert_workspace(
      &self.permission,
      actor,
      record.database.workspace_id,
      WorkspaceAction::CreateDoc,
    )
    .await?;
    let title = crate::database::editing::rules::clean_title(title);
    let row_id = automation.map_or_else(Uuid::new_v4, |(id, _)| id);
    let initial_cell_count = initial_cells.len();
    let field_map = record
      .fields
      .iter()
      .map(|field| (field.id, field))
      .collect::<HashMap<_, _>>();
    let mut cells = Vec::new();
    for (field_id, value) in initial_cells {
      let field = field_map
        .get(&field_id)
        .ok_or_else(|| DatabaseServiceError::new(ERR_CELL_INVALID, "unknown field id"))?;
      let Some(value) =
        crate::database::editing::rules::normalize_editable_cell_value(field.field_type, value, &self.limits)?
      else {
        continue;
      };
      let parent_input = access::validate_parent_cell_input(
        &self.limits,
        &self.row_repo,
        &record,
        &[],
        field,
        &value,
        Some(row_kind),
      )
      .await?;
      if !parent_input {
        crate::database::editing::rules::validate_cell_value(field, &value, &self.limits)?;
      }
      self
        .validate_workspace_tag_references(record.database.workspace_id, None, &value)
        .await?;
      if let DatabaseCellValueData::Relation(target_row_ids) = &value
        && !parent_input
      {
        self
          .validate_relation_targets(actor, record.database.workspace_id, field, target_row_ids)
          .await?;
      }
      if let DatabaseCellValueData::DocumentLink(value) = &value {
        access::validate_document_link_value(&self.doc_service, record.database.workspace_id, value).await?;
      }
      if let DatabaseCellValueData::Files(value) = &value {
        self
          .validate_files_value(record.database.workspace_id, field, value)
          .await?;
      }
      access::validate_user_cell_membership(&self.workspace_store, record.database.workspace_id, &value).await?;
      cells.push(DatabaseCellValue {
        row_id,
        field_id,
        field_type: field.field_type,
        value,
        updated_by: Some(actor),
        edit_revision: 1,
        updated_at: Utc::now(),
      });
    }
    let row_timestamp = Utc::now();
    crate::database::editing::rules::validate_timeline_row_ranges(
      &record,
      &cells,
      row_timestamp,
      row_timestamp,
      &HashMap::new(),
      true,
      row_kind,
    )?;
    let prepared_doc = if let Some((templates, content)) = content {
      Some(
        templates
          .create_row_body(actor, record.database.workspace_id, title.clone(), content)
          .await
          .map_err(|_| {
            DatabaseServiceError::new(ERR_ROW_TEMPLATE_APPLY_FAILED, "failed to create Row template body")
          })?,
      )
    } else {
      None
    };
    let mut write_precondition = DatabaseEditPrecondition::default()
      .in_workspace(record.database.workspace_id)
      .in_database(record.database.id)
      .for_creation_view(creation_view)
      .for_creation_template(creation_template);
    write_precondition.automation_effect = automation.map(|(_, fence)| fence);
    let result = if let Some(mut receipt) = capture {
      receipt.row_id = row_id;
      self
        .row_repo
        .create_task_capture(title, cells, receipt, write_precondition)
        .await
    } else if let Some(doc) = prepared_doc.as_ref() {
      self
        .row_repo
        .create_row_with_content_document(
          record.database.id,
          row_id,
          row_kind,
          title,
          actor,
          cells,
          write_precondition,
          doc.id,
        )
        .await
    } else {
      self
        .row_repo
        .create_row(
          record.database.id,
          row_id,
          row_kind,
          title,
          actor,
          cells,
          write_precondition,
        )
        .await
    }
    .map_err(DatabaseServiceError::from);
    let mut created = match result {
      Ok(created) => created,
      Err(error) => {
        if let Some(doc) = prepared_doc {
          if let Err(cleanup_error) = self.doc_service.delete_doc(record.database.workspace_id, doc.id).await {
            warn!(document_id=%doc.id,?cleanup_error,"failed to compensate unpublished Row template body");
          }
        }
        return Err(error);
      }
    };
    crate::database::views::projection::attach_projection_cells(&mut created, &record.fields);
    self
      .effects
      .record_activity(
        record.database.workspace_id,
        record.database.id,
        Some(created.row.id),
        DatabaseActivityEventType::RowCreated,
        actor,
        serde_json::json!({
          "rowKind": created.row.row_kind.as_str(),
          "title": created.row.title.clone(),
          "initialCellCount": initial_cell_count,
        }),
      )
      .await;
    self
      .effects
      .record_audit(
        "database.row.create",
        AuditCategory::Database,
        Some(AuditTarget::entity(
          "database_row",
          created.row.id,
          Some(created.row.title.clone()),
        )),
        actor,
        None,
        Some(serde_json::json!({
          "databaseId": record.database.id,
          "rowKind": created.row.row_kind.as_str(),
          "title": created.row.title.clone(),
        })),
      )
      .await;
    // P-DB-25: refresh the FTS row so the new row becomes searchable
    // within the freshness SLA. Keystroke debounce is 0s here because
    // the row is brand-new and the title is final.
    self
      .projection
      .enqueue_index_row(record.database.workspace_id, record.database.id, created.row.id, 0)
      .await;
    let span = tracing::Span::current();
    span.record("row_kind", created.row.row_kind.as_str());
    span.record("row_id", tracing::field::display(created.row.id));
    span.record("initial_cells", initial_cell_count);
    debug!(initial_cells = initial_cell_count, "database row created");
    // P-DB-29B-C: emit a `RowCreated` event after the row is committed so
    // collaborators receive a fresh-row CRDT update. We do **not** emit
    // a separate event for each initial cell — one event per row is the
    // contract clients implement against.
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        record.database.id,
        DatabaseChangeKind::RowCreated,
        actor,
        DatabaseChangeTarget {
          row_id: Some(created.row.id),
          field_id: None,
          view_id: None,
        },
      )
      .await;
    Ok(created)
  }
  #[instrument(
    skip(self),
    fields(actor_id = %actor, database_id = %database_id, row_id = %row_id, position, previous_position = tracing::field::Empty)
  )]
  pub async fn update_row_position(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    position: i32,
  ) -> DatabaseResult<DatabaseRowRecord> {
    self
      .update_row_position_with_edit_precondition(
        actor,
        database_id,
        row_id,
        position,
        DatabaseEditPrecondition::default(),
      )
      .await
  }

  pub(in crate::database) async fn update_row_position_with_edit_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    position: i32,
    precondition: DatabaseEditPrecondition,
  ) -> DatabaseResult<DatabaseRowRecord> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let precondition = precondition
      .in_workspace(record.database.workspace_id)
      .in_database(record.database.id);
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
      record.database.workspace_id,
      WorkspaceAction::CreateDoc,
    )
    .await?;
    let previous_position = row.row.position;
    let mut updated = self
      .row_repo
      .update_row_position(database_id, row_id, position.max(0), actor, precondition)
      .await
      .map_err(DatabaseServiceError::from)?;
    crate::database::views::projection::attach_projection_cells(&mut updated, &record.fields);
    self
      .effects
      .record_activity(
        record.database.workspace_id,
        record.database.id,
        Some(row_id),
        DatabaseActivityEventType::RowPositionChanged,
        actor,
        serde_json::json!({
          "oldPosition": previous_position,
          "newPosition": updated.row.position,
        }),
      )
      .await;
    self
      .effects
      .record_audit(
        "database.row.position.update",
        AuditCategory::Database,
        Some(AuditTarget::entity(
          "database_row",
          row_id,
          Some(updated.row.title.clone()),
        )),
        actor,
        Some(serde_json::json!({ "position": previous_position })),
        Some(serde_json::json!({ "position": updated.row.position })),
      )
      .await;
    tracing::Span::current().record("previous_position", previous_position);
    debug!(
      previous_position,
      position = updated.row.position,
      "database row position updated"
    );
    // P-DB-29B-C: emit a `RowMoved` event after the row position is
    // committed so collaborators see the row appear in its new index.
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::RowMoved,
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

  #[instrument(
    skip(self),
    fields(actor_id = %actor, database_id = %database_id, row_id = %row_id, row_kind = tracing::field::Empty)
  )]
  pub async fn delete_row(&self, actor: UserId, database_id: DatabaseId, row_id: DatabaseRowId) -> DatabaseResult<()> {
    self
      .delete_row_with_edit_precondition(actor, database_id, row_id, DatabaseEditPrecondition::default())
      .await
  }

  pub(in crate::database) async fn delete_row_with_edit_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    precondition: DatabaseEditPrecondition,
  ) -> DatabaseResult<()> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let precondition = precondition
      .in_workspace(record.database.workspace_id)
      .in_database(record.database.id);
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
      record.database.workspace_id,
      WorkspaceAction::CreateDoc,
    )
    .await?;
    self.row_repo.delete_row(row_id, precondition).await.map_err(|error| {
      error!(error = %error, "database row delete failed at repository layer");
      DatabaseServiceError::from(error)
    })?;
    self
      .effects
      .record_activity(
        record.database.workspace_id,
        record.database.id,
        Some(row_id),
        DatabaseActivityEventType::RowDeleted,
        actor,
        serde_json::json!({
          "rowKind": row.row.row_kind.as_str(),
          "title": row.row.title.clone(),
        }),
      )
      .await;
    self
      .effects
      .record_audit(
        "database.row.delete",
        AuditCategory::Database,
        Some(AuditTarget::entity("database_row", row_id, Some(row.row.title.clone()))),
        actor,
        Some(serde_json::json!({
          "rowKind": row.row.row_kind.as_str(),
          "title": row.row.title.clone(),
        })),
        None,
      )
      .await;
    // Refresh the combined search/reference projection only after canonical
    // soft-delete commits. The idempotent worker removes both projections for
    // a tombstoned Row.
    self
      .projection
      .enqueue_index_row(record.database.workspace_id, database_id, row_id, 0)
      .await;
    tracing::Span::current().record("row_kind", row.row.row_kind.as_str());
    info!(row_kind = row.row.row_kind.as_str(), "database row deleted");
    // P-DB-29B-C: emit a `RowDeleted` event after the row is gone
    // so collaborators receive a `recordDelete` collaboration update.
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::RowDeleted,
        actor,
        DatabaseChangeTarget {
          row_id: Some(row_id),
          field_id: None,
          view_id: None,
        },
      )
      .await;
    Ok(())
  }

  /// `delete_row` with stale-write precondition.
  #[instrument(
    skip(self),
    fields(actor_id = %actor, database_id = %database_id, row_id = %row_id, force, has_expected = expected_edit_revision.is_some())
  )]
  pub async fn delete_row_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    expected_edit_revision: Option<i64>,
    force: bool,
  ) -> DatabaseResult<()> {
    let result = self
      .delete_row_with_edit_precondition(
        actor,
        database_id,
        row_id,
        DatabaseEditPrecondition::new(expected_edit_revision, force),
      )
      .await;
    match result {
      Ok(()) => {
        if force {
          self
            .effects
            .record_audit(
              "database.row.delete.overwrite",
              AuditCategory::Database,
              Some(AuditTarget::entity("database_row", row_id, None)),
              actor,
              Some(serde_json::json!({ "expectedEditRevision": expected_edit_revision })),
              Some(serde_json::json!({ "forced": true })),
            )
            .await;
        }
        Ok(())
      }
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::Row) => {
        let latest = self
          .row_repo
          .get_row(row_id)
          .await?
          .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"))?;
        Err(
          DatabaseServiceError::new(ERR_ROW_CONFLICT, "database row changed since editing began").with_latest_state(
            serde_json::json!({
              "kind": "row",
              "databaseId": database_id,
              "rowId": row_id,
              "editRevision": latest.row.edit_revision,
              "title": latest.row.title,
              "position": latest.row.position,
              "deletedAt": latest.row.deleted_at,
            }),
          ),
        )
      }
      Err(error) => Err(error),
    }
  }
  /// `update_row_position` with stale-write precondition.
  #[instrument(
    skip(self),
    fields(actor_id = %actor, database_id = %database_id, row_id = %row_id, new_position, force, has_expected = expected_edit_revision.is_some())
  )]
  pub async fn update_row_position_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    new_position: i32,
    expected_edit_revision: Option<i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseRowRecord> {
    let result = self
      .update_row_position_with_edit_precondition(
        actor,
        database_id,
        row_id,
        new_position,
        DatabaseEditPrecondition::new(expected_edit_revision, force),
      )
      .await;
    match result {
      Ok(row) => Ok(row),
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::Row) => {
        let latest = self
          .row_repo
          .get_row(row_id)
          .await?
          .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"))?;
        Err(
          DatabaseServiceError::new(ERR_ROW_CONFLICT, "database row changed since editing began").with_latest_state(
            serde_json::json!({
              "kind": "row",
              "databaseId": database_id,
              "rowId": row_id,
              "editRevision": latest.row.edit_revision,
              "position": latest.row.position,
              "title": latest.row.title,
            }),
          ),
        )
      }
      Err(error) => Err(error),
    }
  }
}
