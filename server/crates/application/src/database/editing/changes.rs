// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

impl DatabaseEditingService {
  /// Preserve every normal value, conflict and side-effect rule while binding
  /// this write to the accepted automation's original target and claim.
  #[allow(clippy::too_many_arguments)]
  pub(crate) async fn update_automation_cell(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
    expected_edit_revision: i64,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> DatabaseResult<DatabaseCellValue> {
    self
      .update_cell_value_with_edit_precondition(
        actor,
        database_id,
        row_id,
        field_id,
        value,
        DatabaseEditPrecondition::new(Some(expected_edit_revision), false)
          .in_workspace(workspace_id)
          .in_database(database_id)
          .for_automation_effect(fence),
      )
      .await
  }

  /// Preserve the deployed Generic-only lifetime key and self-notice behavior.
  /// Project Task intent is owned exclusively by the original SQL transaction.
  pub(in crate::database) async fn notify_assignment_change(
    &self,
    actor: UserId,
    record: &DatabaseRecord,
    change: &DatabaseCommittedCellChange,
  ) {
    if record.database.profile_kind != DatabaseProfileKind::Generic {
      return;
    }
    let Some(DatabaseCellValueData::Users(new_users)) = &change.value else {
      return;
    };
    let current = match access::get_database(&self.permission, &self.schema_repo, actor, record.database.id).await {
      Ok(current)
        if current.database.workspace_id == record.database.workspace_id
          && current.database.profile_kind == DatabaseProfileKind::Generic
          && current.database.deleted_at.is_none() =>
      {
        current
      }
      _ => return,
    };
    let row = match self.row_repo.get_row(change.row_id).await {
      Ok(Some(row)) if row.row.database_id == current.database.id => row,
      _ => return,
    };
    let Some(field) = current
      .fields
      .iter()
      .find(|field| field.id == change.field_id && field.field_type == DatabaseFieldType::Users)
    else {
      return;
    };
    let previous = match &change.previous_value {
      Some(DatabaseCellValueData::Users(users)) => users.as_slice(),
      _ => &[],
    };
    for recipient in new_users
      .iter()
      .copied()
      .filter(|user| !previous.contains(user))
      .collect::<BTreeSet<_>>()
    {
      self
        .effects
        .notify_assignee(
          recipient,
          current.database.workspace_id,
          current.database.id,
          change.row_id,
          &row.row.title,
          change.field_id,
          &field.name,
        )
        .await;
    }
  }
  #[instrument(
    skip(self, value),
    fields(actor_id = %actor, database_id = %database_id, row_id = %row_id, field_id = %field_id, field_type = tracing::field::Empty, target_document_id = tracing::field::Empty)
  )]
  pub async fn update_cell_value(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
  ) -> DatabaseResult<DatabaseCellValue> {
    self
      .update_cell_value_with_edit_precondition(
        actor,
        database_id,
        row_id,
        field_id,
        value,
        DatabaseEditPrecondition::default(),
      )
      .await
  }

  pub(in crate::database) async fn update_cell_value_with_edit_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
    precondition: DatabaseEditPrecondition,
  ) -> DatabaseResult<DatabaseCellValue> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    if precondition
      .expected_workspace_id
      .is_some_and(|id| id != record.database.workspace_id)
      || precondition
        .expected_database_id
        .is_some_and(|id| id != record.database.id)
    {
      return Err(DatabaseServiceError::new(
        ERR_FORBIDDEN,
        "database mutation owner changed",
      ));
    }
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
    let field = record
      .fields
      .iter()
      .find(|field| field.id == field_id)
      .ok_or_else(|| DatabaseServiceError::new(ERR_CELL_INVALID, "unknown field id"))?;
    if crate::database::editing::rules::is_projection_field(field.field_type) {
      return Err(DatabaseServiceError::new(
        ERR_CELL_VALUE_READONLY,
        "database projection cells are read-only",
      ));
    }
    // An old schema's Select value may no longer validate. Preserve its native
    // conflict path first; the SQL owner still fences concurrent changes.
    if matches!(
      field.field_type,
      DatabaseFieldType::Select | DatabaseFieldType::MultiSelect
    ) && !precondition.force
      && let Some(expected) = precondition.expected_edit_revision
      && expected
        != row
          .cell_revisions
          .iter()
          .find(|slot| slot.field_id == field_id)
          .map_or(0, |slot| slot.edit_revision)
    {
      return Err(RepositoryError::Conflict("database cell edit revision").into());
    }
    if field.field_type == DatabaseFieldType::Title {
      let DatabaseCellValueData::Text(title) = value else {
        return Err(DatabaseServiceError::new(
          ERR_CELL_INVALID,
          "title updates require a text value",
        ));
      };
      let previous_title = row.row.title.clone();
      let updated_record = self
        .row_repo
        .update_row_title(
          row_id,
          crate::database::definition::rules::validate_title(&title)?,
          actor,
          precondition,
        )
        .await?;
      let updated_cell = DatabaseCellValue {
        row_id,
        field_id,
        field_type: DatabaseFieldType::Title,
        value: DatabaseCellValueData::Text(title.clone()),
        updated_by: Some(actor),
        edit_revision: updated_record.row.edit_revision,
        updated_at: Utc::now(),
      };
      // P-DB-24: title updates emit activity + audit
      self
        .effects
        .record_activity(
          record.database.workspace_id,
          record.database.id,
          Some(row_id),
          DatabaseActivityEventType::RowUpdated,
          actor,
          serde_json::json!({
            "fieldId": field_id,
            "fieldName": "title",
            "oldTitle": previous_title,
          }),
        )
        .await;
      self
        .effects
        .record_audit(
          "database.row.title.update",
          AuditCategory::Database,
          Some(AuditTarget::entity("database_row", row_id, Some(title.clone()))),
          actor,
          Some(serde_json::json!({ "title": previous_title })),
          Some(serde_json::json!({ "title": title })),
        )
        .await;
      // P-DB-25: title is the highest-weight 'A' content in the FTS row,
      // so a rename must refresh the projection. The non-title cell path
      // also calls this helper — keeping it in both branches means
      // renames are visible in `databaseSearch` without waiting for the
      // worker. The 3000ms debounce collapses rapid keystroke edits.
      self
        .projection
        .enqueue_index_row(record.database.workspace_id, record.database.id, row_id, 3000)
        .await;
      // Title values are row-owned, so they leave this function before the
      // ordinary cell branch below. Publish the committed row change here or
      // remote clients will retain a stale title after normal and forced saves.
      self
        .effects
        .emit_change(
          record.database.workspace_id,
          record.database.id,
          DatabaseChangeKind::RowUpdated,
          actor,
          DatabaseChangeTarget {
            row_id: Some(row_id),
            field_id: Some(field_id),
            view_id: None,
          },
        )
        .await;
      return Ok(updated_cell);
    }
    let Some(value) =
      crate::database::editing::rules::normalize_editable_cell_value(field.field_type, value, &self.limits)?
    else {
      // Keep clear semantics in one path. The dedicated implementation also
      // owns activity, audit, search refresh and collaboration broadcast.
      let cleared = self
        .clear_cell_value_with_edit_precondition(actor, database_id, row_id, field_id, precondition)
        .await?;
      return Ok(DatabaseCellValue {
        row_id,
        field_id,
        field_type: field.field_type,
        value: crate::database::editing::rules::empty_editable_cell_value(field.field_type)?,
        updated_by: Some(actor),
        edit_revision: cleared.edit_revision,
        updated_at: Utc::now(),
      });
    };
    let old_value = row
      .cells
      .iter()
      .find(|cell| cell.field_id == field_id)
      .map(|cell| cell.value.clone());
    let parent_input =
      access::validate_parent_cell_input(&self.limits, &self.row_repo, &record, &[row_id], field, &value, None).await?;
    if !parent_input {
      crate::database::editing::rules::validate_cell_value(field, &value, &self.limits)?;
    }
    self
      .validate_workspace_tag_references(record.database.workspace_id, old_value.as_ref(), &value)
      .await?;
    if let DatabaseCellValueData::Relation(target_row_ids) = &value
      && !parent_input
    {
      self
        .validate_relation_targets(actor, record.database.workspace_id, field, target_row_ids)
        .await?;
    }
    if let DatabaseCellValueData::DocumentLink(value) = &value {
      tracing::Span::current().record("target_document_id", tracing::field::display(value.doc_id));
      access::validate_document_link_value(&self.doc_service, record.database.workspace_id, value).await?;
    }
    if let DatabaseCellValueData::Files(value) = &value {
      self
        .validate_files_value(record.database.workspace_id, field, value)
        .await?;
    }
    access::validate_user_cell_membership(&self.workspace_store, record.database.workspace_id, &value).await?;
    crate::database::editing::rules::validate_timeline_row_ranges(
      &record,
      &row.cells,
      row.row.created_at,
      row.row.updated_at,
      &HashMap::from([(field_id, Some(value.clone()))]),
      false,
      row.row.row_kind,
    )?;
    let reminder_reschedules = if let DatabaseCellValueData::DateTime(date_time) = &value {
      Some(
        self
          .reminders
          .database_row_reminder_reschedules(row_id, field_id, date_time)
          .await?,
      )
    } else {
      None
    };
    let updated = self
      .row_repo
      .update_cell_value(row_id, field_id, value, actor, precondition, reminder_reschedules)
      .await
      .map_err(DatabaseServiceError::from)?;
    self
      .publish_committed_cell_update(actor, &record, &row, field, &updated)
      .await;
    Ok(updated.cell)
  }

  /// Publish the ordinary native effects once, using the committed Cell change.
  /// Retained receipt replays must not call this owner a second time.
  pub(crate) async fn publish_committed_cell_update(
    &self,
    actor: UserId,
    record: &DatabaseRecord,
    row: &DatabaseRowRecord,
    field: &DatabaseField,
    outcome: &DatabaseCellWriteOutcome,
  ) {
    let row_id = row.row.id;
    let field_id = field.id;
    let change = &outcome.change;
    let updated = &outcome.cell;
    let old_value = &change.previous_value;
    let project_side_effect_roles = myoxus_domain::database::projects::project_side_effect_roles(record, field_id);
    let project_activity_type = myoxus_domain::database::projects::project_activity_type(record, field_id);
    // P-DB-24: Record activity + audit + (for Users) assignee notifications.
    let actor_id = actor;
    let old_value_for_audit = old_value
      .as_ref()
      .map(|value| serde_json::to_value(value).unwrap_or(serde_json::Value::Null));
    let updated_value_for_audit = if project_side_effect_roles.is_empty() {
      serde_json::to_value(updated.value.clone()).unwrap_or(serde_json::Value::Null)
    } else {
      serde_json::json!({
        "value": serde_json::to_value(updated.value.clone()).unwrap_or(serde_json::Value::Null),
        "derivedRoleKeys": project_side_effect_roles,
      })
    };
    let activity_value = match &updated.value {
      DatabaseCellValueData::Select(value) | DatabaseCellValueData::Status(value) => Some(value.clone()),
      _ => None,
    };
    let activity_value_label = match (&field.config, activity_value.as_deref()) {
      (DatabaseFieldConfig::Status(config), Some(option_id)) => config
        .options
        .iter()
        .find(|option| option.id == option_id)
        .map(|option| option.name.as_str()),
      _ => None,
    };
    self
      .effects
      .record_activity(
        record.database.workspace_id,
        record.database.id,
        Some(row_id),
        project_activity_type.unwrap_or(DatabaseActivityEventType::CellChanged),
        actor_id,
        serde_json::json!({
          "fieldId": field_id,
          "fieldType": field.field_type.as_str(),
          "fieldName": field.name.clone(),
          "value": activity_value.clone(),
          "valueLabel": activity_value_label,
          "derivedRoleKeys": project_side_effect_roles,
        }),
      )
      .await;
    self
      .effects
      .record_audit(
        "database.cell.update",
        AuditCategory::Database,
        Some(AuditTarget::entity("database_row", row_id, Some(row.row.title.clone()))),
        actor_id,
        old_value_for_audit,
        Some(updated_value_for_audit),
      )
      .await;
    self.notify_assignment_change(actor, record, change).await;
    if field.field_type == DatabaseFieldType::Users && record.database.profile_kind == DatabaseProfileKind::Generic {
      self.effects.record_activity(record.database.workspace_id, record.database.id, Some(row_id),
        DatabaseActivityEventType::RowAssignmentChanged, actor_id,
        serde_json::json!({ "fieldId": field_id, "fieldName": field.name.clone(), "added": match &updated.value { DatabaseCellValueData::Users(users) => users.clone(), _ => vec![] } })).await;
    }
    if matches!(field.field_type, DatabaseFieldType::Select | DatabaseFieldType::Status)
      && project_activity_type.is_none()
      && record.database.profile_kind != DatabaseProfileKind::Project
    {
      self
        .effects
        .record_activity(
          record.database.workspace_id,
          record.database.id,
          Some(row_id),
          DatabaseActivityEventType::RowStatusChanged,
          actor_id,
          serde_json::json!({
            "fieldId": field_id,
            "fieldName": field.name.clone(),
            "value": activity_value,
          }),
        )
        .await;
    }
    // P-DB-25: refresh the FTS row. 3000ms debounce collapses rapid
    // keystroke edits on the same row into the most recent state.
    self
      .projection
      .enqueue_index_row(record.database.workspace_id, record.database.id, row_id, 3000)
      .await;
    // Role-managed Project writes update several cells atomically. A single
    // row-level event makes remote consumers refetch the complete change set;
    // ordinary writes retain the narrower cell target.
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        record.database.id,
        if project_side_effect_roles.is_empty() {
          DatabaseChangeKind::CellUpdated
        } else {
          DatabaseChangeKind::RowUpdated
        },
        actor,
        DatabaseChangeTarget {
          row_id: Some(row_id),
          field_id: project_side_effect_roles.is_empty().then_some(field_id),
          view_id: None,
        },
      )
      .await;
    tracing::Span::current().record("field_type", field.field_type.as_str());
    debug!(field_type = field.field_type.as_str(), "database cell value updated");
  }

  #[instrument(
    skip(self),
    fields(actor_id = %actor, database_id = %database_id, row_id = %row_id, field_id = %field_id, field_type = tracing::field::Empty)
  )]
  pub async fn clear_cell_value(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
  ) -> DatabaseResult<DatabaseCellRevision> {
    self
      .clear_cell_value_with_edit_precondition(
        actor,
        database_id,
        row_id,
        field_id,
        DatabaseEditPrecondition::default(),
      )
      .await
  }

  pub(in crate::database) async fn clear_cell_value_with_edit_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    precondition: DatabaseEditPrecondition,
  ) -> DatabaseResult<DatabaseCellRevision> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    if precondition
      .expected_workspace_id
      .is_some_and(|id| id != record.database.workspace_id)
      || precondition
        .expected_database_id
        .is_some_and(|id| id != record.database.id)
    {
      return Err(DatabaseServiceError::new(
        ERR_FORBIDDEN,
        "database mutation owner changed",
      ));
    }
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
    let field = record
      .fields
      .iter()
      .find(|field| field.id == field_id)
      .ok_or_else(|| DatabaseServiceError::new(ERR_CELL_INVALID, "unknown field id"))?;
    crate::database::editing::rules::validate_cell_clear(&record, row.row.row_kind, field)?;
    let old_value = row
      .cells
      .iter()
      .find(|cell| cell.field_id == field_id)
      .map(|cell| cell.value.clone());
    let project_side_effect_roles = myoxus_domain::database::projects::project_side_effect_roles(&record, field_id);
    let project_activity_type = myoxus_domain::database::projects::project_activity_type(&record, field_id);
    crate::database::editing::rules::validate_timeline_row_ranges(
      &record,
      &row.cells,
      row.row.created_at,
      row.row.updated_at,
      &HashMap::from([(field_id, None)]),
      false,
      row.row.row_kind,
    )?;
    let cleared = self
      .row_repo
      .clear_cell_value(row_id, field_id, actor, precondition)
      .await?;
    // P-DB-24: cleared cells emit activity + audit
    self
      .effects
      .record_activity(
        record.database.workspace_id,
        record.database.id,
        Some(row_id),
        project_activity_type.unwrap_or(DatabaseActivityEventType::CellCleared),
        actor,
        serde_json::json!({
          "fieldId": field_id,
          "fieldType": field.field_type.as_str(),
          "fieldName": field.name.clone(),
          "derivedRoleKeys": project_side_effect_roles,
          "cleared": true,
        }),
      )
      .await;
    self
      .effects
      .record_audit(
        "database.cell.clear",
        AuditCategory::Database,
        Some(AuditTarget::entity("database_row", row_id, Some(row.row.title.clone()))),
        actor,
        old_value.map(|value| serde_json::to_value(value).unwrap_or(serde_json::Value::Null)),
        (!project_side_effect_roles.is_empty()).then(|| {
          serde_json::json!({
            "value": null,
            "derivedRoleKeys": project_side_effect_roles,
          })
        }),
      )
      .await;
    tracing::Span::current().record("field_type", field.field_type.as_str());
    debug!(field_type = field.field_type.as_str(), "database cell value cleared");
    // P-DB-25: refresh the FTS row after a clear so the cleared cell
    // no longer contributes to search hits.
    self
      .projection
      .enqueue_index_row(record.database.workspace_id, database_id, row_id, 3000)
      .await;
    // Project role side effects require one row-level refresh; ordinary clears
    // keep the narrower cell event.
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        if project_side_effect_roles.is_empty() {
          DatabaseChangeKind::CellUpdated
        } else {
          DatabaseChangeKind::RowUpdated
        },
        actor,
        DatabaseChangeTarget {
          row_id: Some(row_id),
          field_id: project_side_effect_roles.is_empty().then_some(field_id),
          view_id: None,
        },
      )
      .await;
    Ok(cleared.revision)
  }
  /// Update one cell against the revision captured when editing began.
  ///
  /// The repository compares and increments the cell revision while holding
  /// the parent row lock. This wrapper only enriches a rejected write with the
  /// latest typed value needed by the conflict dialog.
  #[instrument(
    skip(self, value),
    fields(actor_id = %actor, database_id = %database_id, row_id = %row_id, field_id = %field_id, force, has_expected = expected_edit_revision.is_some())
  )]
  #[expect(
    clippy::too_many_arguments,
    reason = "the public mutation contract keeps identity and optimistic concurrency explicit"
  )]
  pub async fn update_cell_value_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
    expected_edit_revision: Option<i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseCellValue> {
    let attempted_value = value.clone();
    let result = self
      .update_cell_value_with_edit_precondition(
        actor,
        database_id,
        row_id,
        field_id,
        value,
        DatabaseEditPrecondition::new(expected_edit_revision, force),
      )
      .await;
    let updated = match result {
      Ok(updated) => updated,
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::Row) => {
        let latest = self
          .row_repo
          .get_row(row_id)
          .await?
          .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"))?;
        return Err(
          DatabaseServiceError::new(ERR_ROW_CONFLICT, "database row changed since editing began").with_latest_state(
            serde_json::json!({
              "kind": "row",
              "databaseId": database_id,
              "rowId": row_id,
              "editRevision": latest.row.edit_revision,
              "title": latest.row.title,
              "position": latest.row.position,
              "attemptedValue": attempted_value,
            }),
          ),
        );
      }
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::Cell) => {
        let latest = self
          .row_repo
          .get_row(row_id)
          .await?
          .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"))?;
        let latest_cell = latest.cells.iter().find(|cell| cell.field_id == field_id);
        let latest_revision = latest
          .cell_revisions
          .iter()
          .find(|revision| revision.field_id == field_id)
          .map(|revision| revision.edit_revision)
          .unwrap_or(0);
        let latest_display_value =
          latest_cell.map(|cell| crate::database::editing::presentation::machine_cell_value(&cell.value));
        return Err(
          DatabaseServiceError::new(ERR_CELL_CONFLICT, "database cell changed since editing began").with_latest_state(
            serde_json::json!({
              "kind": "cell",
              "databaseId": database_id,
              "rowId": row_id,
              "fieldId": field_id,
              "fieldKind": latest_cell.map(|cell| cell.field_type.as_str()),
              "editRevision": latest_revision,
              "value": latest_cell.map(|cell| &cell.value),
              "displayValue": latest_display_value,
              "attemptedValue": attempted_value,
            }),
          ),
        );
      }
      Err(error) => return Err(error),
    };
    if force {
      self
        .effects
        .record_audit(
          "database.cell.overwrite",
          AuditCategory::Database,
          Some(AuditTarget::entity("database_row", row_id, None)),
          actor,
          Some(serde_json::json!({ "expectedEditRevision": expected_edit_revision })),
          Some(serde_json::json!({ "editRevision": updated.edit_revision, "forced": true })),
        )
        .await;
    }
    Ok(updated)
  }

  pub async fn clear_cell_value_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    expected_edit_revision: Option<i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseCellRevision> {
    let result = self
      .clear_cell_value_with_edit_precondition(
        actor,
        database_id,
        row_id,
        field_id,
        DatabaseEditPrecondition::new(expected_edit_revision, force),
      )
      .await;
    match result {
      Ok(revision) => {
        if force {
          self
            .effects
            .record_audit(
              "database.cell.clear.overwrite",
              AuditCategory::Database,
              Some(AuditTarget::entity("database_row", row_id, None)),
              actor,
              Some(serde_json::json!({ "expectedEditRevision": expected_edit_revision })),
              Some(serde_json::json!({ "forced": true })),
            )
            .await;
        }
        Ok(revision)
      }
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::Cell) => {
        let latest = self
          .row_repo
          .get_row(row_id)
          .await?
          .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"))?;
        let latest_cell = latest.cells.iter().find(|cell| cell.field_id == field_id);
        let latest_revision = latest
          .cell_revisions
          .iter()
          .find(|revision| revision.field_id == field_id)
          .map(|revision| revision.edit_revision)
          .unwrap_or(0);
        let latest_display_value =
          latest_cell.map(|cell| crate::database::editing::presentation::machine_cell_value(&cell.value));
        Err(
          DatabaseServiceError::new(ERR_CELL_CONFLICT, "database cell changed since editing began").with_latest_state(
            serde_json::json!({
              "kind": "cell",
              "databaseId": database_id,
              "rowId": row_id,
              "fieldId": field_id,
              "fieldKind": latest_cell.map(|cell| cell.field_type.as_str()),
              "editRevision": latest_revision,
              "value": latest_cell.map(|cell| &cell.value),
              "displayValue": latest_display_value,
              "attemptedValue": serde_json::Value::Null,
            }),
          ),
        )
      }
      Err(error) => Err(error),
    }
  }
  pub(in crate::database) async fn validate_workspace_tag_references(
    &self,
    workspace_id: WorkspaceId,
    previous_value: Option<&DatabaseCellValueData>,
    value: &DatabaseCellValueData,
  ) -> DatabaseResult<()> {
    let DatabaseCellValueData::Tags(tag_ids) = value else {
      return Ok(());
    };
    let previous_tag_ids = match previous_value {
      Some(DatabaseCellValueData::Tags(tag_ids)) => tag_ids.as_slice(),
      _ => &[],
    };
    let service = self
      .workspace_tags
      .as_ref()
      .cloned()
      .ok_or_else(|| DatabaseServiceError::new(ERR_STORAGE, "workspace tag service is not configured"))?;
    service
      .validate_reference_update(workspace_id, previous_tag_ids, tag_ids)
      .await
      .map(|_| ())
      .map_err(|error| DatabaseServiceError::new(error.code, error.message))
  }

  pub(in crate::database) async fn common_workspace_tag_references(
    &self,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
    field_id: DatabaseFieldId,
  ) -> DatabaseResult<Vec<Uuid>> {
    // A shared bulk value may retain an archived tag only when every target
    // row already references it. The intersection expresses that rule once,
    // before the repository enters its atomic bulk transaction.
    let mut common: Option<HashSet<Uuid>> = None;
    for row_id in row_ids {
      let row = self
        .row_repo
        .get_row(*row_id)
        .await?
        .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"))?;
      if row.row.database_id != database_id {
        return Err(DatabaseServiceError::new(
          ERR_ROW_INVALID,
          "bulk row does not belong to the requested database",
        ));
      }
      let existing = row
        .cells
        .iter()
        .find(|cell| cell.field_id == field_id)
        .and_then(|cell| match &cell.value {
          DatabaseCellValueData::Tags(tag_ids) => Some(tag_ids.iter().copied().collect::<HashSet<_>>()),
          _ => None,
        })
        .unwrap_or_default();
      match &mut common {
        Some(common) => common.retain(|tag_id| existing.contains(tag_id)),
        None => common = Some(existing),
      }
    }
    Ok(common.unwrap_or_default().into_iter().collect())
  }
}
