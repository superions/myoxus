// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

impl DatabaseEditingService {
  // ──────────────────────────────────────────────────────────────────────────
  // P-DB-26: bulk operations
  //
  // Every method in this block:
  //   * validates per-row domain rules **before** starting the SQL transaction
  //     so an invalid field on row 7 of 12 fails the whole batch without
  //     partial commits,
  //   * records one summary activity event and audit entry (not N noisy
  //     per-row entries), and
  //   * enqueues a single search reindex job covering every touched row.
  // ──────────────────────────────────────────────────────────────────────────

  /// Enforce the P-DB-26 row/fan-out caps at the service boundary. Callers
  /// passing an oversized batch receive [`ERR_LIMIT_EXCEEDED`] before any
  /// SQL is issued.
  pub(in crate::database) fn enforce_bulk_limits(&self, rows: usize, field_updates: usize) -> DatabaseResult<()> {
    if rows > DATABASE_BULK_MAX_ROWS_PER_OPERATION {
      return Err(DatabaseServiceError::new(
        ERR_LIMIT_EXCEEDED,
        format!(
          "bulk operation targets {} rows, exceeding the per-operation limit of {}",
          rows, DATABASE_BULK_MAX_ROWS_PER_OPERATION
        ),
      ));
    }
    if field_updates > DATABASE_BULK_MAX_FIELD_UPDATES_PER_OPERATION {
      return Err(DatabaseServiceError::new(
        ERR_LIMIT_EXCEEDED,
        format!(
          "bulk operation touches {} (row, field) updates, exceeding the per-operation limit of {}",
          field_updates, DATABASE_BULK_MAX_FIELD_UPDATES_PER_OPERATION
        ),
      ));
    }
    if rows == 0 {
      return Err(DatabaseServiceError::new(
        ERR_ROW_INVALID,
        "bulk operation requires at least one target row",
      ));
    }
    Ok(())
  }

  /// P-DB-26: bulk field edit — set the same cell value on many rows in one
  /// transaction.
  ///
  /// `value` is normalized and validated against `field_type` once for the
  /// whole batch. Every target row must belong to `database_id` and be alive
  /// (not soft-deleted); the batch is atomic — any per-row validation
  /// failure or storage error rolls back the entire operation.
  #[instrument(
    skip(self, row_ids, value),
    fields(actor_id = %actor, database_id = %database_id, field_id = %field_id, requested = tracing::field::Empty, succeeded = tracing::field::Empty, failed = tracing::field::Empty)
  )]
  pub async fn bulk_set_cell_value(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    self
      .bulk_set_cell_value_with_edit_preconditions(actor, database_id, row_ids, field_id, value, &HashMap::new(), false)
      .await
  }

  #[expect(
    clippy::too_many_arguments,
    reason = "the established bulk mutation boundary keeps conflict inputs explicit"
  )]
  pub(in crate::database) async fn bulk_set_cell_value_with_edit_preconditions(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    self.enforce_bulk_limits(row_ids.len(), row_ids.len())?;
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
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
      .ok_or_else(|| DatabaseServiceError::new(ERR_FIELD_INVALID, "unknown field id"))?
      .clone();
    if crate::database::editing::rules::is_projection_field(field.field_type) {
      return Err(DatabaseServiceError::new(
        ERR_CELL_VALUE_READONLY,
        "database projection cells are read-only",
      ));
    }
    // Check cell tokens before the new schema can reject an old draft value.
    // These bulk-set tokens are Cell revisions, not Row revisions.
    let mut rows = Vec::with_capacity(row_ids.len());
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
      if matches!(
        field.field_type,
        DatabaseFieldType::Select | DatabaseFieldType::MultiSelect
      ) && !force
        && expected_edit_revisions.get(row_id).is_some_and(|expected| {
          *expected
            != row
              .cell_revisions
              .iter()
              .find(|slot| slot.field_id == field_id)
              .map_or(0, |slot| slot.edit_revision)
        })
      {
        return Err(RepositoryError::Conflict("database cell edit revision").into());
      }
      rows.push(row);
    }
    let normalized =
      crate::database::editing::rules::normalize_editable_cell_value(field.field_type, value.clone(), &self.limits)?
        .ok_or_else(|| {
          DatabaseServiceError::new(ERR_CELL_INVALID, "use bulk_clear_cell_value to remove cell values")
        })?;
    let parent_input = access::validate_parent_cell_input(
      &self.limits,
      &self.row_repo,
      &record,
      row_ids,
      &field,
      &normalized,
      None,
    )
    .await?;
    if !parent_input {
      crate::database::editing::rules::validate_cell_value(&field, &normalized, &self.limits)?;
    }
    let previous_tags = if matches!(&normalized, DatabaseCellValueData::Tags(_)) {
      Some(
        self
          .common_workspace_tag_references(database_id, row_ids, field_id)
          .await?,
      )
    } else {
      None
    };
    let previous_value = previous_tags.map(DatabaseCellValueData::Tags);
    self
      .validate_workspace_tag_references(record.database.workspace_id, previous_value.as_ref(), &normalized)
      .await?;
    if let DatabaseCellValueData::Relation(targets) = &normalized
      && !parent_input
    {
      self
        .validate_relation_targets(actor, record.database.workspace_id, &field, targets)
        .await?;
    }
    if let DatabaseCellValueData::DocumentLink(value) = &normalized {
      access::validate_document_link_value(&self.doc_service, record.database.workspace_id, value).await?;
    }
    if let DatabaseCellValueData::Files(value) = &normalized {
      self
        .validate_files_value(record.database.workspace_id, &field, value)
        .await?;
    }
    access::validate_user_cell_membership(&self.workspace_store, record.database.workspace_id, &normalized).await?;

    for row in &rows {
      crate::database::editing::rules::validate_timeline_row_ranges(
        &record,
        &row.cells,
        row.row.created_at,
        row.row.updated_at,
        &HashMap::from([(field_id, Some(normalized.clone()))]),
        false,
        row.row.row_kind,
      )?;
    }

    let mut reminder_reschedules = Vec::new();
    if let DatabaseCellValueData::DateTime(date_time) = &normalized {
      for row_id in row_ids {
        reminder_reschedules.extend(
          self
            .reminders
            .database_row_reminder_reschedules(*row_id, field_id, date_time)
            .await?,
        );
      }
    }

    let outcomes = self
      .row_repo
      .bulk_set_cell_value(
        row_ids,
        field_id,
        normalized.clone(),
        actor,
        expected_edit_revisions,
        force,
        reminder_reschedules,
        DatabaseEditPrecondition::default()
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id),
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    // The repository returns each committed Cell and its locked preimage so the
    // caller can recover the updated value. The diagnostic stream only needs
    // the row id, so we walk outcomes in lock-step with the input list.
    let diagnostics: Vec<DatabaseBulkRowOutcome> = outcomes
      .iter()
      .zip(row_ids.iter())
      .map(|(outcome, row_id)| match outcome {
        Ok(_) => DatabaseBulkRowOutcome::ok(*row_id),
        Err(err) => DatabaseBulkRowOutcome::err(*row_id, database_bulk_error_code_for(err), err.to_string()),
      })
      .collect();
    self
      .effects
      .record_activity(
        record.database.workspace_id,
        record.database.id,
        None,
        DatabaseActivityEventType::BulkRowsUpdated,
        actor,
        serde_json::json!({
          "fieldId": field_id,
          "fieldName": field.name.clone(),
          "derivedRoleKeys": myoxus_domain::database::projects::project_side_effect_roles(&record, field_id),
          "requestedRowIds": row_ids.len(),
          "succeeded": diagnostics.iter().filter(|d| d.success).count(),
          "failed": diagnostics.iter().filter(|d| !d.success).count(),
        }),
      )
      .await;
    self
      .effects
      .record_audit(
        "database.row.bulk.cell.set",
        AuditCategory::Database,
        Some(AuditTarget::entity("database", database_id, None)),
        actor,
        Some(serde_json::json!({
          "fieldId": field_id,
          "rowIds": row_ids.len(),
        })),
        Some(serde_json::json!({
          "succeeded": diagnostics.iter().filter(|d| d.success).count(),
          "failed": diagnostics.iter().filter(|d| !d.success).count(),
          "derivedRoleKeys": myoxus_domain::database::projects::project_side_effect_roles(&record, field_id),
        })),
      )
      .await;
    let result = DatabaseBulkOperationResult::from_outcomes(diagnostics, true);
    let span = tracing::Span::current();
    span.record("requested", row_ids.len());
    span.record("succeeded", result.success_count);
    span.record("failed", result.failure_count);
    if result.failure_count > 0 {
      warn!(
        succeeded = result.success_count,
        failed = result.failure_count,
        "database bulk cell set: partial failure (rolled back to all-or-nothing contract)"
      );
    } else {
      info!(requested = row_ids.len(), "database bulk cell set committed");
    }
    // P-DB-29B-C: broadcast one CellUpdated per committed row.
    let outcome_flags: Vec<bool> = outcomes.iter().map(|o| o.is_ok()).collect();
    self
      .emit_bulk_cell_updated(&record, actor, field_id, &outcome_flags, row_ids)
      .await;
    Ok(result)
  }

  /// P-DB-29B-C: bulk cell set/clear committed ⇒ broadcast one
  /// one event per successfully updated row so collaborators see every edit
  /// without polling. Project role side effects use a row-level target because
  /// several role-managed cells changed in the same transaction.
  pub(in crate::database) async fn emit_bulk_cell_updated(
    &self,
    record: &DatabaseRecord,
    actor: UserId,
    field_id: DatabaseFieldId,
    outcomes_ok: &[bool],
    row_ids: &[DatabaseRowId],
  ) {
    let workspace_id = record.database.workspace_id;
    let database_id = record.database.id;
    let has_project_side_effects =
      !myoxus_domain::database::projects::project_side_effect_roles(record, field_id).is_empty();
    for (success, row_id) in outcomes_ok.iter().zip(row_ids.iter()) {
      if *success {
        self
          .effects
          .emit_change(
            workspace_id,
            database_id,
            if has_project_side_effects {
              DatabaseChangeKind::RowUpdated
            } else {
              DatabaseChangeKind::CellUpdated
            },
            actor,
            DatabaseChangeTarget {
              row_id: Some(*row_id),
              field_id: (!has_project_side_effects).then_some(field_id),
              view_id: None,
            },
          )
          .await;
      }
    }
  }

  /// P-DB-26: bulk cell clear — wipe a single cell on many rows in one
  /// transaction. Every affected row is reindexed.
  #[instrument(
    skip(self, row_ids),
    fields(actor_id = %actor, database_id = %database_id, field_id = %field_id, requested = tracing::field::Empty, succeeded = tracing::field::Empty, failed = tracing::field::Empty)
  )]
  pub async fn bulk_clear_cell_value(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
    field_id: DatabaseFieldId,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    self
      .bulk_clear_cell_value_with_edit_preconditions(actor, database_id, row_ids, field_id, &HashMap::new(), false)
      .await
  }

  pub(in crate::database) async fn bulk_clear_cell_value_with_edit_preconditions(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
    field_id: DatabaseFieldId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    self.enforce_bulk_limits(row_ids.len(), row_ids.len())?;
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
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
      .ok_or_else(|| DatabaseServiceError::new(ERR_FIELD_INVALID, "unknown field id"))?;
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
      crate::database::editing::rules::validate_cell_clear(&record, row.row.row_kind, field)?;
      crate::database::editing::rules::validate_timeline_row_ranges(
        &record,
        &row.cells,
        row.row.created_at,
        row.row.updated_at,
        &HashMap::from([(field_id, None)]),
        false,
        row.row.row_kind,
      )?;
    }

    let outcomes = self
      .row_repo
      .bulk_clear_cell_value(
        row_ids,
        field_id,
        actor,
        expected_edit_revisions,
        force,
        DatabaseEditPrecondition::default()
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id),
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    let diagnostics: Vec<DatabaseBulkRowOutcome> = outcomes
      .iter()
      .zip(row_ids.iter())
      .map(|(outcome, row_id)| match outcome {
        Ok(_) => DatabaseBulkRowOutcome::ok(*row_id),
        Err(err) => DatabaseBulkRowOutcome::err(*row_id, database_bulk_error_code_for(err), err.to_string()),
      })
      .collect();
    self
      .effects
      .record_activity(
        record.database.workspace_id,
        record.database.id,
        None,
        DatabaseActivityEventType::BulkRowsUpdated,
        actor,
        serde_json::json!({
          "fieldId": field_id,
          "fieldName": field.name.clone(),
          "action": "clear",
          "derivedRoleKeys": myoxus_domain::database::projects::project_side_effect_roles(&record, field_id),
          "requestedRowIds": row_ids.len(),
          "succeeded": diagnostics.iter().filter(|d| d.success).count(),
          "failed": diagnostics.iter().filter(|d| !d.success).count(),
        }),
      )
      .await;
    self
      .effects
      .record_audit(
        "database.row.bulk.cell.clear",
        AuditCategory::Database,
        Some(AuditTarget::entity("database", database_id, None)),
        actor,
        Some(serde_json::json!({
          "fieldId": field_id,
          "rowIds": row_ids.len(),
        })),
        Some(serde_json::json!({
          "succeeded": diagnostics.iter().filter(|d| d.success).count(),
          "failed": diagnostics.iter().filter(|d| !d.success).count(),
          "derivedRoleKeys": myoxus_domain::database::projects::project_side_effect_roles(&record, field_id),
        })),
      )
      .await;
    let result = DatabaseBulkOperationResult::from_outcomes(diagnostics, true);
    let span = tracing::Span::current();
    span.record("requested", row_ids.len());
    span.record("succeeded", result.success_count);
    span.record("failed", result.failure_count);
    if result.failure_count > 0 {
      warn!(
        succeeded = result.success_count,
        failed = result.failure_count,
        "database bulk cell clear: partial failure"
      );
    } else {
      info!(requested = row_ids.len(), "database bulk cell clear committed");
    }
    // P-DB-29B-C: broadcast one CellUpdated per cleared row.
    let outcome_flags: Vec<bool> = outcomes.iter().map(|o| o.is_ok()).collect();
    self
      .emit_bulk_cell_updated(&record, actor, field_id, &outcome_flags, row_ids)
      .await;
    Ok(result)
  }

  /// P-DB-26: bulk multi-field edit — apply many cell writes, possibly across
  /// many rows, in one transaction.
  ///
  /// Total `(row, field)` writes are capped at
  /// [`DATABASE_BULK_MAX_FIELD_UPDATES_PER_OPERATION`] to bound memory and
  /// statement count.
  #[instrument(
    skip(self, patches),
    fields(actor_id = %actor, database_id = %database_id, requested_rows = tracing::field::Empty, field_updates = tracing::field::Empty)
  )]
  pub async fn bulk_apply_cell_patches(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    patches: &[DatabaseBulkRowPatch],
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    self
      .bulk_apply_cell_patches_with_edit_preconditions(actor, database_id, patches, &HashMap::new(), false)
      .await
  }

  pub(in crate::database) async fn bulk_apply_cell_patches_with_edit_preconditions(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    patches: &[DatabaseBulkRowPatch],
    expected_edit_revisions: &HashMap<(DatabaseRowId, DatabaseFieldId), i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    self
      .bulk_apply_cell_patches_guarded(actor, database_id, patches, expected_edit_revisions, force, None)
      .await
  }
  pub(in crate::database) async fn bulk_apply_cell_patches_guarded(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    patches: &[DatabaseBulkRowPatch],
    expected_edit_revisions: &HashMap<(DatabaseRowId, DatabaseFieldId), i64>,
    force: bool,
    automation_effect: Option<myoxus_domain::workspace_automation::AutomationEffectFence>,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    if patches.is_empty() {
      return Err(DatabaseServiceError::new(
        ERR_ROW_INVALID,
        "bulk operation requires at least one row patch",
      ));
    }
    let mut flat: Vec<(DatabaseRowId, DatabaseFieldId, Option<DatabaseCellValueData>)> = Vec::new();
    let mut targets = HashSet::new();
    for patch in patches {
      for cell in &patch.cells {
        if !targets.insert((patch.row_id, cell.field_id)) {
          return Err(DatabaseServiceError::new(
            ERR_CELL_INVALID,
            "a bulk cell target may appear only once",
          ));
        }
        let value = match &cell.intent {
          DatabaseBulkCellIntent::Set(value) => Some(value.clone()),
          DatabaseBulkCellIntent::Clear => {
            if !expected_edit_revisions.contains_key(&(patch.row_id, cell.field_id)) {
              return Err(DatabaseServiceError::new(
                ERR_CELL_INVALID,
                "Clear requires an expected cell edit revision",
              ));
            }
            None
          }
        };
        flat.push((patch.row_id, cell.field_id, value));
      }
    }
    self.enforce_bulk_limits(patches.len(), flat.len())?;
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    access::assert_workspace(
      &self.permission,
      actor,
      record.database.workspace_id,
      WorkspaceAction::CreateDoc,
    )
    .await?;

    let row_ids = patches.iter().map(|patch| patch.row_id).collect::<HashSet<_>>();
    let mut rows = HashMap::with_capacity(row_ids.len());
    for row_id in row_ids {
      let row = self
        .row_repo
        .get_row(row_id)
        .await?
        .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"))?;
      if row.row.database_id != database_id {
        return Err(DatabaseServiceError::new(
          ERR_ROW_INVALID,
          "bulk row does not belong to the requested database",
        ));
      }
      if row.row.deleted_at.is_some() {
        return Err(DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"));
      }
      rows.insert(row_id, row);
    }

    if !force {
      for (row_id, field_id, _) in &flat {
        if !record.fields.iter().any(|field| {
          field.id == *field_id
            && matches!(
              field.field_type,
              DatabaseFieldType::Select | DatabaseFieldType::MultiSelect
            )
        }) {
          continue;
        }
        let row = &rows[row_id];
        if expected_edit_revisions
          .get(&(*row_id, *field_id))
          .is_some_and(|expected| {
            *expected
              != row
                .cell_revisions
                .iter()
                .find(|slot| slot.field_id == *field_id)
                .map_or(0, |slot| slot.edit_revision)
          })
        {
          return Err(RepositoryError::Conflict("database cell edit revision").into());
        }
      }
    }

    // Pre-validate every cell write against the database's field set.
    let mut normalized_flat = Vec::with_capacity(flat.len());
    for (row_id, field_id, value) in flat {
      let field = record
        .fields
        .iter()
        .find(|candidate| candidate.id == field_id)
        .ok_or_else(|| {
          DatabaseServiceError::new(
            ERR_FIELD_INVALID,
            format!("unknown field id on row {}: {}", row_id, field_id),
          )
        })?;
      if crate::database::editing::rules::is_projection_field(field.field_type) {
        return Err(DatabaseServiceError::new(
          ERR_CELL_VALUE_READONLY,
          "database projection cells are read-only",
        ));
      }
      let Some(value) = value else {
        crate::database::editing::rules::validate_cell_clear(&record, rows[&row_id].row.row_kind, field)?;
        normalized_flat.push((row_id, field_id, None));
        continue;
      };
      let normalized =
        crate::database::editing::rules::normalize_editable_cell_value(field.field_type, value, &self.limits)?
          .ok_or_else(|| {
            DatabaseServiceError::new(ERR_CELL_INVALID, "use bulk_clear_cell_value to remove cell values")
          })?;
      let parent_input = access::validate_parent_cell_input(
        &self.limits,
        &self.row_repo,
        &record,
        &[row_id],
        field,
        &normalized,
        None,
      )
      .await?;
      if !parent_input {
        crate::database::editing::rules::validate_cell_value(field, &normalized, &self.limits)?;
      }
      let previous_value = rows.get(&row_id).and_then(|row| {
        row
          .cells
          .iter()
          .find(|cell| cell.field_id == field_id)
          .map(|cell| &cell.value)
      });
      self
        .validate_workspace_tag_references(record.database.workspace_id, previous_value, &normalized)
        .await?;
      if let DatabaseCellValueData::Relation(targets) = &normalized
        && !parent_input
      {
        self
          .validate_relation_targets(actor, record.database.workspace_id, field, targets)
          .await?;
      }
      if let DatabaseCellValueData::DocumentLink(value) = &normalized {
        access::validate_document_link_value(&self.doc_service, record.database.workspace_id, value).await?;
      }
      if let DatabaseCellValueData::Files(value) = &normalized {
        self
          .validate_files_value(record.database.workspace_id, field, value)
          .await?;
      }
      access::validate_user_cell_membership(&self.workspace_store, record.database.workspace_id, &normalized).await?;
      normalized_flat.push((row_id, field_id, Some(normalized)));
    }
    flat = normalized_flat;

    let mut changes_by_row = HashMap::<DatabaseRowId, HashMap<DatabaseFieldId, Option<DatabaseCellValueData>>>::new();
    for (row_id, field_id, value) in &flat {
      changes_by_row
        .entry(*row_id)
        .or_default()
        .insert(*field_id, value.clone());
    }
    for (row_id, changes) in changes_by_row {
      let row = rows.get(&row_id).expect("validated bulk row must remain available");
      crate::database::editing::rules::validate_timeline_row_ranges(
        &record,
        &row.cells,
        row.row.created_at,
        row.row.updated_at,
        &changes,
        false,
        row.row.row_kind,
      )?;
    }

    let mut reminder_reschedules = Vec::new();
    for (row_id, field_id, value) in &flat {
      if let Some(DatabaseCellValueData::DateTime(date_time)) = value {
        reminder_reschedules.extend(
          self
            .reminders
            .database_row_reminder_reschedules(*row_id, *field_id, date_time)
            .await?,
        );
      }
    }

    let mut precondition = DatabaseEditPrecondition::default()
      .in_workspace(record.database.workspace_id)
      .in_database(record.database.id);
    if let Some(fence) = automation_effect {
      precondition = precondition.for_automation_effect(fence);
    }
    let committed = self
      .row_repo
      .bulk_apply_cell_patches(
        database_id,
        &flat,
        actor,
        expected_edit_revisions,
        force,
        reminder_reschedules,
        precondition,
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    if automation_effect.is_some() && committed.is_empty() {
      return Ok(DatabaseBulkOperationResult::from_outcomes(Vec::new(), true));
    }

    let derived_role_keys = flat
      .iter()
      .flat_map(|(_, field_id, _)| myoxus_domain::database::projects::project_side_effect_roles(&record, *field_id))
      .copied()
      .collect::<BTreeSet<_>>();

    let mut diagnostics: Vec<DatabaseBulkRowOutcome> = Vec::with_capacity(patches.len());
    for patch in patches {
      if patch.cells.is_empty() {
        diagnostics.push(DatabaseBulkRowOutcome::ok(patch.row_id));
      } else {
        // At least one cell succeeded for this row ⇒ success.
        diagnostics.push(DatabaseBulkRowOutcome::ok(patch.row_id));
      }
    }
    self
      .effects
      .record_activity(
        record.database.workspace_id,
        record.database.id,
        None,
        DatabaseActivityEventType::BulkRowsUpdated,
        actor,
        serde_json::json!({
          "rows": diagnostics.iter().filter(|d| d.success).count(),
          "fieldUpdates": flat.len(),
          "derivedRoleKeys": &derived_role_keys,
        }),
      )
      .await;
    self
      .effects
      .record_audit(
        "database.row.bulk.cells.apply",
        AuditCategory::Database,
        Some(AuditTarget::entity("database", database_id, None)),
        actor,
        Some(serde_json::json!({
          "rows": patches.len(),
          "fieldUpdates": flat.len(),
        })),
        Some(serde_json::json!({
          "rows": diagnostics.iter().filter(|d| d.success).count(),
          "derivedRoleKeys": &derived_role_keys,
        })),
      )
      .await;
    let result = DatabaseBulkOperationResult::from_outcomes(diagnostics, true);
    let span = tracing::Span::current();
    span.record("requested_rows", patches.len());
    span.record("field_updates", flat.len());
    info!(
      requested_rows = patches.len(),
      field_updates = flat.len(),
      "database bulk cell patches committed"
    );
    // Project side effects are a single row-level change set. Other fields
    // retain their precise per-cell events.
    let workspace_id = record.database.workspace_id;
    let database_id = record.database.id;
    let project_side_effect_rows = flat
      .iter()
      .filter(|(_, field_id, _)| {
        !myoxus_domain::database::projects::project_side_effect_roles(&record, *field_id).is_empty()
      })
      .map(|(row_id, _, _)| *row_id)
      .collect::<HashSet<_>>();
    for row_id in &project_side_effect_rows {
      self
        .effects
        .emit_change(
          workspace_id,
          database_id,
          DatabaseChangeKind::RowUpdated,
          actor,
          DatabaseChangeTarget {
            row_id: Some(*row_id),
            field_id: None,
            view_id: None,
          },
        )
        .await;
    }
    for (row_id, field_id, _value) in &flat {
      if project_side_effect_rows.contains(row_id) {
        continue;
      }
      self
        .effects
        .emit_change(
          workspace_id,
          database_id,
          DatabaseChangeKind::CellUpdated,
          actor,
          DatabaseChangeTarget {
            row_id: Some(*row_id),
            field_id: Some(*field_id),
            view_id: None,
          },
        )
        .await;
    }
    Ok(result)
  }

  /// P-DB-26: bulk soft-delete — many rows in one transaction. Already
  /// deleted rows are tolerated (idempotent retry).
  #[instrument(
    skip(self, row_ids),
    fields(actor_id = %actor, database_id = %database_id, requested = tracing::field::Empty, succeeded = tracing::field::Empty, failed = tracing::field::Empty)
  )]
  pub async fn bulk_delete_rows(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    self
      .bulk_delete_rows_with_edit_preconditions(actor, database_id, row_ids, &HashMap::new(), false)
      .await
  }

  pub(in crate::database) async fn bulk_delete_rows_with_edit_preconditions(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    self.enforce_bulk_limits(row_ids.len(), row_ids.len())?;
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    access::assert_workspace(
      &self.permission,
      actor,
      record.database.workspace_id,
      WorkspaceAction::CreateDoc,
    )
    .await?;
    let outcomes = self
      .row_repo
      .bulk_delete_rows(
        row_ids,
        actor,
        expected_edit_revisions,
        force,
        DatabaseEditPrecondition::default()
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id)
          .in_database(record.database.id),
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    let diagnostics: Vec<DatabaseBulkRowOutcome> = outcomes
      .iter()
      .zip(row_ids.iter())
      .map(|(outcome, row_id)| match outcome {
        Ok(_) => DatabaseBulkRowOutcome::ok(*row_id),
        Err(err) => DatabaseBulkRowOutcome::err(*row_id, database_bulk_error_code_for(err), err.to_string()),
      })
      .collect();
    self
      .effects
      .record_activity(
        record.database.workspace_id,
        record.database.id,
        None,
        DatabaseActivityEventType::BulkRowsDeleted,
        actor,
        serde_json::json!({
          "requestedRowIds": row_ids.len(),
          "succeeded": diagnostics.iter().filter(|d| d.success).count(),
          "failed": diagnostics.iter().filter(|d| !d.success).count(),
        }),
      )
      .await;
    self
      .effects
      .record_audit(
        "database.row.bulk.delete",
        AuditCategory::Database,
        Some(AuditTarget::entity("database", database_id, None)),
        actor,
        Some(serde_json::json!({ "rowIds": row_ids.len() })),
        Some(serde_json::json!({
          "succeeded": diagnostics.iter().filter(|d| d.success).count(),
          "failed": diagnostics.iter().filter(|d| !d.success).count(),
        })),
      )
      .await;
    let result = DatabaseBulkOperationResult::from_outcomes(diagnostics, true);
    let span = tracing::Span::current();
    span.record("requested", row_ids.len());
    span.record("succeeded", result.success_count);
    span.record("failed", result.failure_count);
    if result.failure_count > 0 {
      warn!(
        succeeded = result.success_count,
        failed = result.failure_count,
        "database bulk row delete: partial failure"
      );
    } else {
      info!(requested = row_ids.len(), "database bulk row delete committed");
    }
    // P-DB-29B-C: broadcast one RowDeleted per deleted row.
    let workspace_id = record.database.workspace_id;
    let database_id = record.database.id;
    for (outcome, row_id) in outcomes.iter().zip(row_ids.iter()) {
      if outcome.is_ok() {
        self
          .projection
          .enqueue_index_row(workspace_id, database_id, *row_id, 0)
          .await;
        self
          .effects
          .emit_change(
            workspace_id,
            database_id,
            DatabaseChangeKind::RowDeleted,
            actor,
            DatabaseChangeTarget {
              row_id: Some(*row_id),
              field_id: None,
              view_id: None,
            },
          )
          .await;
      }
    }
    Ok(result)
  }

  /// P-DB-26: bulk restore — restore previously soft-deleted rows in one
  /// transaction. Live rows are left as-is (idempotent retry).
  #[instrument(
    skip(self, row_ids),
    fields(actor_id = %actor, database_id = %database_id, requested = tracing::field::Empty, succeeded = tracing::field::Empty, failed = tracing::field::Empty)
  )]
  pub async fn bulk_restore_rows(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    self
      .bulk_restore_rows_with_edit_preconditions(actor, database_id, row_ids, &HashMap::new(), false)
      .await
  }

  pub(in crate::database) async fn bulk_restore_rows_with_edit_preconditions(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    self.enforce_bulk_limits(row_ids.len(), row_ids.len())?;
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    access::assert_workspace(
      &self.permission,
      actor,
      record.database.workspace_id,
      WorkspaceAction::CreateDoc,
    )
    .await?;
    let outcomes = self
      .row_repo
      .bulk_restore_rows(
        row_ids,
        actor,
        expected_edit_revisions,
        force,
        DatabaseEditPrecondition::default()
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id)
          .in_database(record.database.id),
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    let diagnostics: Vec<DatabaseBulkRowOutcome> = outcomes
      .iter()
      .zip(row_ids.iter())
      .map(|(outcome, row_id)| match outcome {
        Ok(_) => DatabaseBulkRowOutcome::ok(*row_id),
        Err(err) => DatabaseBulkRowOutcome::err(*row_id, database_bulk_error_code_for(err), err.to_string()),
      })
      .collect();
    self
      .effects
      .record_activity(
        record.database.workspace_id,
        record.database.id,
        None,
        DatabaseActivityEventType::BulkRowsRestored,
        actor,
        serde_json::json!({
          "requestedRowIds": row_ids.len(),
          "succeeded": diagnostics.iter().filter(|d| d.success).count(),
          "failed": diagnostics.iter().filter(|d| !d.success).count(),
        }),
      )
      .await;
    self
      .effects
      .record_audit(
        "database.row.bulk.restore",
        AuditCategory::Database,
        Some(AuditTarget::entity("database", database_id, None)),
        actor,
        Some(serde_json::json!({ "rowIds": row_ids.len() })),
        Some(serde_json::json!({
          "succeeded": diagnostics.iter().filter(|d| d.success).count(),
          "failed": diagnostics.iter().filter(|d| !d.success).count(),
        })),
      )
      .await;
    let result = DatabaseBulkOperationResult::from_outcomes(diagnostics, true);
    let span = tracing::Span::current();
    span.record("requested", row_ids.len());
    span.record("succeeded", result.success_count);
    span.record("failed", result.failure_count);
    if result.failure_count > 0 {
      warn!(
        succeeded = result.success_count,
        failed = result.failure_count,
        "database bulk row restore: partial failure"
      );
    } else {
      info!(requested = row_ids.len(), "database bulk row restore committed");
    }
    // P-DB-29B-C: broadcast one RowRestored per restored row.
    let workspace_id = record.database.workspace_id;
    let database_id = record.database.id;
    for (outcome, row_id) in outcomes.iter().zip(row_ids.iter()) {
      if outcome.is_ok() {
        self
          .projection
          .enqueue_index_row(workspace_id, database_id, *row_id, 0)
          .await;
        self
          .effects
          .emit_change(
            workspace_id,
            database_id,
            DatabaseChangeKind::RowRestored,
            actor,
            DatabaseChangeTarget {
              row_id: Some(*row_id),
              field_id: None,
              view_id: None,
            },
          )
          .await;
      }
    }
    Ok(result)
  }

  /// P-DB-26: bulk position rewrite — Kanban DnD and list reorder commit a
  /// single atomic batch. The whole batch rolls back if any row id is
  /// missing from `database_id`.
  #[instrument(
    skip(self, updates),
    fields(actor_id = %actor, database_id = %database_id, requested = tracing::field::Empty, succeeded = tracing::field::Empty, failed = tracing::field::Empty)
  )]
  pub async fn bulk_update_row_positions(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    updates: &[DatabaseBulkPositionUpdate],
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    self
      .bulk_update_row_positions_with_edit_preconditions(actor, database_id, updates, &HashMap::new(), false)
      .await
  }

  pub(in crate::database) async fn bulk_update_row_positions_with_edit_preconditions(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    updates: &[DatabaseBulkPositionUpdate],
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    self.enforce_bulk_limits(updates.len(), updates.len())?;
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    access::assert_workspace(
      &self.permission,
      actor,
      record.database.workspace_id,
      WorkspaceAction::CreateDoc,
    )
    .await?;
    let raw: Vec<(DatabaseRowId, i32)> = updates.iter().map(|u| (u.row_id, u.position.max(0))).collect();
    let outcomes = self
      .row_repo
      .bulk_update_row_positions(
        database_id,
        &raw,
        actor,
        expected_edit_revisions,
        force,
        DatabaseEditPrecondition::default()
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id),
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    let diagnostics: Vec<DatabaseBulkRowOutcome> = outcomes
      .iter()
      .zip(updates.iter())
      .map(|(outcome, update)| match outcome {
        Ok(_) => DatabaseBulkRowOutcome::ok(update.row_id),
        Err(err) => DatabaseBulkRowOutcome::err(update.row_id, database_bulk_error_code_for(err), err.to_string()),
      })
      .collect();
    self
      .effects
      .record_activity(
        record.database.workspace_id,
        record.database.id,
        None,
        DatabaseActivityEventType::BulkRowPositionsChanged,
        actor,
        serde_json::json!({
          "rows": diagnostics.iter().filter(|d| d.success).count(),
        }),
      )
      .await;
    self
      .effects
      .record_audit(
        "database.row.bulk.position.update",
        AuditCategory::Database,
        Some(AuditTarget::entity("database", database_id, None)),
        actor,
        Some(serde_json::json!({ "rows": updates.len() })),
        Some(serde_json::json!({
          "rows": diagnostics.iter().filter(|d| d.success).count(),
        })),
      )
      .await;
    let result = DatabaseBulkOperationResult::from_outcomes(diagnostics, true);
    let span = tracing::Span::current();
    span.record("requested", updates.len());
    span.record("succeeded", result.success_count);
    span.record("failed", result.failure_count);
    if result.failure_count > 0 {
      warn!(
        succeeded = result.success_count,
        failed = result.failure_count,
        "database bulk row position update: partial failure"
      );
    } else {
      debug!(requested = updates.len(), "database bulk row position update committed");
    }
    // P-DB-29B-C: broadcast one RowMoved per moved row.
    let workspace_id = record.database.workspace_id;
    let database_id = record.database.id;
    for (outcome, update) in outcomes.iter().zip(updates.iter()) {
      if outcome.is_ok() {
        self
          .effects
          .emit_change(
            workspace_id,
            database_id,
            DatabaseChangeKind::RowMoved,
            actor,
            DatabaseChangeTarget {
              row_id: Some(update.row_id),
              field_id: None,
              view_id: None,
            },
          )
          .await;
      }
    }
    Ok(result)
  }

  /// `bulk_set_cell_value` with stale-write preconditions.
  ///
  /// P-DB-29B-C contract: `expected_per_row` maps each target row to the
  /// target Cell revision observed by the caller. When a supplied revision no
  /// longer matches that Cell's current edit revision,
  /// the entire bulk operation is rejected (no partial commits) with a
  /// `MIX_DATABASE_BULK_CONFLICT` and a `latest_state` payload listing
  /// every conflicting row. `force=true` audits a forced overwrite and
  /// proceeds with the write.
  #[instrument(
    skip(self, expected_per_row, value),
    fields(actor_id = %actor, database_id = %database_id, field_id = %field_id, requested = tracing::field::Empty, succeeded = tracing::field::Empty, failed = tracing::field::Empty)
  )]
  #[expect(
    clippy::too_many_arguments,
    reason = "the public bulk mutation contract keeps identity and conflict policy explicit"
  )]
  pub async fn bulk_set_cell_value_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
    expected_per_row: &HashMap<DatabaseRowId, i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    let result = self
      .bulk_set_cell_value_with_edit_preconditions(
        actor,
        database_id,
        row_ids,
        field_id,
        value,
        expected_per_row,
        force,
      )
      .await;
    self
      .finish_bulk_precondition_result(
        actor,
        database_id,
        "database.cell.bulk.overwrite",
        expected_per_row,
        force,
        result,
      )
      .await
  }

  /// `bulk_clear_cell_value` with stale-write preconditions. Same
  /// semantics as [`bulk_set_cell_value_with_precondition`].
  pub async fn bulk_clear_cell_value_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
    field_id: DatabaseFieldId,
    expected_per_row: &HashMap<DatabaseRowId, i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    let result = self
      .bulk_clear_cell_value_with_edit_preconditions(actor, database_id, row_ids, field_id, expected_per_row, force)
      .await;
    self
      .finish_bulk_precondition_result(
        actor,
        database_id,
        "database.cell.bulk.clear.overwrite",
        expected_per_row,
        force,
        result,
      )
      .await
  }

  /// `bulk_apply_cell_patches` with stale-write preconditions. Each
  /// patch carries an expected cell revision; any stale patch aborts the
  /// whole transaction with a `BULK_CONFLICT` carrying the guarded targets
  /// for reload. It does not permit retrying only part of the original intent.
  pub async fn bulk_apply_cell_patches_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    patches: &[DatabaseBulkRowPatch],
    expected_per_cell: &HashMap<(DatabaseRowId, DatabaseFieldId), i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    let result = self
      .bulk_apply_cell_patches_with_edit_preconditions(actor, database_id, patches, expected_per_cell, force)
      .await;
    match result {
      Ok(result) => Ok(result),
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::Cell) => Err(
        DatabaseServiceError::new(
          ERR_BULK_CONFLICT,
          "one or more database cells changed since editing began",
        )
        .with_latest_state(serde_json::json!({
          "kind": "bulk",
          "databaseId": database_id,
          "targets": expected_per_cell.iter().map(|((row_id, field_id), expected)| serde_json::json!({
            "rowId": row_id,
            "fieldId": field_id,
            "expectedEditRevision": expected,
          })).collect::<Vec<_>>(),
        })),
      ),
      Err(error) => Err(error),
    }
  }

  /// `bulk_delete_rows` with stale-write preconditions. Same semantics
  /// as the cell-write variants: any stale delete target aborts the
  /// whole batch (no partial deletes) when `force=false`.
  pub async fn bulk_delete_rows_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
    expected_per_row: &HashMap<DatabaseRowId, i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    let result = self
      .bulk_delete_rows_with_edit_preconditions(actor, database_id, row_ids, expected_per_row, force)
      .await;
    self
      .finish_bulk_precondition_result(
        actor,
        database_id,
        "database.row.bulk.delete.overwrite",
        expected_per_row,
        force,
        result,
      )
      .await
  }

  /// `bulk_restore_rows` with stale-write preconditions.
  pub async fn bulk_restore_rows_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
    expected_per_row: &HashMap<DatabaseRowId, i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    let result = self
      .bulk_restore_rows_with_edit_preconditions(actor, database_id, row_ids, expected_per_row, force)
      .await;
    self
      .finish_bulk_precondition_result(
        actor,
        database_id,
        "database.row.bulk.restore.overwrite",
        expected_per_row,
        force,
        result,
      )
      .await
  }

  /// `bulk_update_row_positions` with stale-write preconditions.
  pub async fn bulk_update_row_positions_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    updates: &[DatabaseBulkPositionUpdate],
    expected_per_row: &HashMap<DatabaseRowId, i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    let result = self
      .bulk_update_row_positions_with_edit_preconditions(actor, database_id, updates, expected_per_row, force)
      .await;
    self
      .finish_bulk_precondition_result(
        actor,
        database_id,
        "database.row.bulk.position.overwrite",
        expected_per_row,
        force,
        result,
      )
      .await
  }

  pub(in crate::database) async fn finish_bulk_precondition_result(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    overwrite_action: &'static str,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    result: DatabaseResult<DatabaseBulkOperationResult>,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    match result {
      Ok(result) => {
        if force {
          self
            .effects
            .record_audit(
              overwrite_action,
              AuditCategory::Database,
              Some(AuditTarget::entity("database", database_id, None)),
              actor,
              Some(serde_json::json!({ "expectedEditRevisions": expected_edit_revisions })),
              Some(serde_json::json!({
                "forced": true,
                "successCount": result.success_count,
              })),
            )
            .await;
        }
        Ok(result)
      }
      Err(error)
        if error.is_edit_conflict(DatabaseEditConflictKind::Row)
          || error.is_edit_conflict(DatabaseEditConflictKind::Cell) =>
      {
        let mut conflicts = Vec::with_capacity(expected_edit_revisions.len());
        for (row_id, expected_revision) in expected_edit_revisions {
          if let Some(latest) = self.row_repo.get_row(*row_id).await? {
            conflicts.push(serde_json::json!({
              "rowId": row_id,
              "expectedEditRevision": expected_revision,
              "rowEditRevision": latest.row.edit_revision,
              "cellRevisions": latest.cell_revisions,
              "title": latest.row.title,
            }));
          }
        }
        Err(
          DatabaseServiceError::new(
            ERR_BULK_CONFLICT,
            "one or more Database targets changed since editing began",
          )
          .with_latest_state(serde_json::json!({
            "kind": "bulk",
            "databaseId": database_id,
            "conflicts": conflicts,
          })),
        )
      }
      Err(error) => Err(error),
    }
  }
}
