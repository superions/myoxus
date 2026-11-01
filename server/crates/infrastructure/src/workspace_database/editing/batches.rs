// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::workspace_automation::PgWorkspaceAutomationRepository;
use crate::workspace_database::*;

impl PgDatabaseRepository {
  // ─────────────────────────────────────────────────────────────────────────
  // P-DB-26: bulk operations — atomic transactions, FOR UPDATE locks,
  // FTS-aware deletes, and a single `RepoResult<RowId>` per requested row.
  // ─────────────────────────────────────────────────────────────────────────

  pub(in crate::workspace_database) async fn persist_bulk_delete_rows(
    &self,
    row_ids: &[DatabaseRowId],
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseRowId>>> {
    if row_ids.is_empty() {
      return Ok(Vec::new());
    }
    let mut tx = self.begin_write().await?;
    PgWorkspaceAutomationRepository::lock_document_review_tasks(&mut tx, row_ids).await?;

    let database_id = if let Some(database_id) = precondition.expected_database_id {
      database_id
    } else {
      sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_rows WHERE id = $1")
        .bind(row_ids[0])
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::NotFound("database row"))?
    };
    Self::lock_managed_admission(&mut tx, database_id).await?;
    let _parent_policy = Self::prepare_task_graph_mutation(&mut tx, database_id).await?;
    // Lock the target rows in id order so concurrent reorders can't race
    // the batch.
    let known_rows = sqlx::query(
      r#"
        SELECT id, edit_revision
        FROM workspace_database_rows
        WHERE id = ANY($1) AND database_id = $2
        ORDER BY id ASC
        FOR UPDATE
      "#,
    )
    .bind(row_ids)
    .bind(database_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    let mut known_set = std::collections::HashSet::new();
    for row in known_rows {
      let row_id: DatabaseRowId = row.try_get("id").map_err(Self::map_sqlx_error)?;
      let revision: i64 = row.try_get("edit_revision").map_err(Self::map_sqlx_error)?;
      known_set.insert(row_id);
      if !force
        && expected_edit_revisions
          .get(&row_id)
          .is_some_and(|expected| *expected != revision)
      {
        return Err(RepositoryError::Conflict("database row edit revision"));
      }
    }

    // P-DB-26: real soft-delete. Stamps `deleted_at = now()` on every live
    // row in the batch. Already-soft-deleted rows are silently re-stamped
    // so a retry is idempotent. Rows already absent from the table surface
    // as NotFound through the `known_set` check below.
    let updated = sqlx::query(
      r#"
        UPDATE workspace_database_rows
        SET deleted_at = COALESCE(deleted_at, now()),
            updated_by = $2,
            edit_revision = edit_revision + 1,
            updated_at = now()
        WHERE id = ANY($1) AND database_id = $3
      "#,
    )
    .bind(row_ids)
    .bind(updated_by)
    .bind(database_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .rows_affected();

    // Only admitted, locked Rows own these side effects. Raw input IDs can
    // include another Database's Rows that must remain NotFound and untouched.
    let mut scoped_row_ids = known_set.iter().copied().collect::<Vec<_>>();
    scoped_row_ids.sort_unstable();
    // Drop FTS search rows for admitted targets so search hits never
    // return tombstones.
    let _ = sqlx::query("DELETE FROM workspace_database_row_search WHERE row_id = ANY($1)")
      .bind(&scoped_row_ids)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    sqlx::query("DELETE FROM database_document_references WHERE row_id = ANY($1)")
      .bind(&scoped_row_ids)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    Self::cancel_rows_reminders(&mut tx, &scoped_row_ids).await?;

    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    PgWorkspaceAutomationRepository::invalidate_document_review_tasks(&mut tx, row_ids).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    let _ = updated;

    // Build per-row outcomes in the same order as the input.
    Ok(
      row_ids
        .iter()
        .map(|row_id| {
          if known_set.contains(row_id) {
            Ok(*row_id)
          } else {
            Err(RepositoryError::NotFound("database row"))
          }
        })
        .collect(),
    )
  }

  pub(in crate::workspace_database) async fn persist_bulk_restore_rows(
    &self,
    row_ids: &[DatabaseRowId],
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseRowRecord>>> {
    if row_ids.is_empty() {
      return Ok(Vec::new());
    }
    let mut tx = self.begin_write().await?;

    let database_id = if let Some(database_id) = precondition.expected_database_id {
      database_id
    } else {
      sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_rows WHERE id = $1")
        .bind(row_ids[0])
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::NotFound("database row"))?
    };
    Self::lock_managed_admission(&mut tx, database_id).await?;
    let parent_policy = Self::prepare_task_graph_mutation(&mut tx, database_id).await?;
    let locked = sqlx::query(
      r#"
        SELECT id, edit_revision
        FROM workspace_database_rows
        WHERE id = ANY($1) AND database_id = $2
        ORDER BY id ASC
        FOR UPDATE
      "#,
    )
    .bind(row_ids)
    .bind(database_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    let mut known_set = std::collections::HashSet::new();
    for row in locked {
      let row_id: DatabaseRowId = row.try_get("id").map_err(Self::map_sqlx_error)?;
      let revision: i64 = row.try_get("edit_revision").map_err(Self::map_sqlx_error)?;
      known_set.insert(row_id);
      if !force
        && expected_edit_revisions
          .get(&row_id)
          .is_some_and(|expected| *expected != revision)
      {
        return Err(RepositoryError::Conflict("database row edit revision"));
      }
    }
    let restored_ids: std::collections::HashSet<DatabaseRowId> = sqlx::query_scalar::<_, DatabaseRowId>(
      r#"
        UPDATE workspace_database_rows
        SET deleted_at = NULL,
            updated_by = $2,
            edit_revision = edit_revision + 1,
            updated_at = now()
        WHERE id = ANY($1) AND database_id = $3 AND deleted_at IS NOT NULL
        RETURNING id
      "#,
    )
    .bind(row_ids)
    .bind(updated_by)
    .bind(database_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .into_iter()
    .collect();
    if let Some(policy) = parent_policy.as_ref() {
      for (role, before, blocked) in [
        ("task.parent", &policy.parent_before, false),
        ("task.blockedBy", &policy.blocker_before, true),
      ] {
        if before.is_none() {
          continue;
        }
        let Some(field) = Self::project_role_field(policy, role) else {
          continue;
        };
        let graph = Self::load_task_relation_graph(&mut tx, database_id, field).await?;
        let accepted = myoxus_domain::database::projects::restored_task_relation_edges(
          database_id,
          &policy.semantics,
          &graph,
          &restored_ids,
          blocked,
        )
        .map_err(RepositoryError::Validation)?;
        for (row, targets) in accepted {
          Self::sync_task_relation_edges(&mut tx, database_id, row, field, &targets).await?;
        }
      }
    }
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;

    let mut outcomes = Vec::with_capacity(row_ids.len());
    for row_id in row_ids {
      if restored_ids.contains(row_id) {
        match self.get_row(*row_id).await? {
          Some(record) => outcomes.push(Ok(record)),
          None => outcomes.push(Err(RepositoryError::NotFound("database row"))),
        }
      } else if known_set.contains(row_id) {
        // Row exists but was not soft-deleted: surface Ok with the live
        // record so the wizard can render "already restored".
        match self.get_row(*row_id).await? {
          Some(record) => outcomes.push(Ok(record)),
          None => outcomes.push(Err(RepositoryError::NotFound("database row"))),
        }
      } else {
        outcomes.push(Err(RepositoryError::NotFound("database row")));
      }
    }
    Ok(outcomes)
  }

  pub(in crate::workspace_database) async fn persist_bulk_set_cell_value(
    &self,
    row_ids: &[DatabaseRowId],
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    reminder_reschedules: Vec<DatabaseRowReminderReschedule>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseCellWriteOutcome>>> {
    if row_ids.is_empty() {
      return Ok(Vec::new());
    }
    let payload = Self::map_cell_value_to_json(&value)?;
    let mut tx = self.begin_write().await?;
    PgWorkspaceAutomationRepository::lock_document_review_tasks(&mut tx, row_ids).await?;
    let database_id =
      sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_rows WHERE id = $1")
        .bind(row_ids[0])
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::NotFound("database row"))?;
    let project_policy = Self::prepare_project_mutation(&mut tx, database_id, &[field_id], false).await?;

    let known_rows = sqlx::query_scalar::<_, DatabaseRowId>(
      r#"
        SELECT id
        FROM workspace_database_rows
        WHERE id = ANY($1) AND database_id = $2
          AND (NOT $3 OR deleted_at IS NULL)
        ORDER BY id ASC
        FOR UPDATE
      "#,
    )
    .bind(row_ids)
    .bind(database_id)
    .bind(
      project_policy
        .as_ref()
        .is_some_and(|policy| policy.parent_before.is_some() || policy.blocker_before.is_some()),
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    Self::assert_project_task_sources_live(&mut tx, database_id, &known_rows, project_policy.is_some()).await?;
    let known_set: std::collections::HashSet<DatabaseRowId> = known_rows.iter().copied().collect();
    if project_policy
      .as_ref()
      .is_some_and(|policy| policy.parent_before.is_some() || policy.blocker_before.is_some())
      && row_ids.iter().any(|row| !known_set.contains(row))
    {
      return Err(RepositoryError::NotFound("live database row"));
    }

    let mut previous_values = HashMap::new();
    for row_id in &known_rows {
      previous_values.insert(
        *row_id,
        Self::previous_cell_value(&mut tx, *row_id, field_id, Some(&value)).await?,
      );
    }
    let field_type_text = sqlx::query_scalar::<_, String>(
      "SELECT field_type FROM workspace_database_fields WHERE id = $1 AND database_id = $2",
    )
    .bind(field_id)
    .bind(database_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database field"))?;
    let field_type =
      DatabaseFieldType::from_str(&field_type_text).map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let revision_rows = sqlx::query(
      r#"
        SELECT row_id, edit_revision
        FROM workspace_database_cell_values
        WHERE field_id = $2 AND row_id = ANY($1)
      "#,
    )
    .bind(row_ids)
    .bind(field_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let mut actual_revisions = HashMap::new();
    for row in revision_rows {
      actual_revisions.insert(
        row
          .try_get::<DatabaseRowId, _>("row_id")
          .map_err(Self::map_sqlx_error)?,
        row.try_get::<i64, _>("edit_revision").map_err(Self::map_sqlx_error)?,
      );
    }
    for row_id in row_ids {
      let actual = actual_revisions.get(row_id).copied().unwrap_or(0);
      if !force
        && expected_edit_revisions
          .get(row_id)
          .is_some_and(|expected| *expected != actual)
      {
        return Err(RepositoryError::Conflict("database cell edit revision"));
      }
    }

    let written = sqlx::query(
      r#"
        INSERT INTO workspace_database_cell_values
          (row_id, field_id, value_json, database_id, updated_by, edit_revision, updated_at)
        SELECT r.id, $2, $3, r.database_id, $4, 1, now()
        FROM workspace_database_rows r
        WHERE r.id = ANY($1) AND r.database_id = $5
        ON CONFLICT (row_id, field_id)
        DO UPDATE SET value_json = EXCLUDED.value_json,
                      updated_by = EXCLUDED.updated_by,
                      edit_revision = workspace_database_cell_values.edit_revision + 1,
                      updated_at = EXCLUDED.updated_at
        RETURNING row_id, edit_revision
      "#,
    )
    .bind(row_ids)
    .bind(field_id)
    .bind(payload)
    .bind(updated_by)
    .bind(database_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    let written_revisions = written
      .into_iter()
      .map(|row| {
        Ok((
          row
            .try_get::<DatabaseRowId, _>("row_id")
            .map_err(Self::map_sqlx_error)?,
          row.try_get::<i64, _>("edit_revision").map_err(Self::map_sqlx_error)?,
        ))
      })
      .collect::<RepoResult<HashMap<_, _>>>()?;
    let reminder_targets = if matches!(&value, DatabaseCellValueData::DateTime(_)) {
      known_rows.iter().map(|row_id| (*row_id, field_id)).collect::<Vec<_>>()
    } else {
      Vec::new()
    };
    Self::reschedule_database_row_reminders(&mut tx, &reminder_targets, reminder_reschedules).await?;

    if let Some(policy) = project_policy.as_ref() {
      for row_id in &known_rows {
        Self::apply_project_side_effects(&mut tx, database_id, *row_id, &[field_id], updated_by, policy).await?;
        Self::validate_project_task_dates_after_write(
          &mut tx,
          database_id,
          *row_id,
          policy,
          &HashMap::from([(field_id, Some(value.clone()))]),
        )
        .await?;
      }
      Self::validate_project_hierarchy(&mut tx, database_id, policy).await?;
      if (policy.parent_before.is_some() || policy.blocker_before.is_some())
        && let DatabaseCellValueData::Relation(targets) = &value
      {
        for row_id in &known_rows {
          Self::sync_relation_edges_and_reciprocals(&mut tx, *row_id, field_id, targets, updated_by).await?;
        }
      }
    }
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    let intent_changes = known_rows
      .iter()
      .map(|row_id| DatabaseCommittedCellChange {
        row_id: *row_id,
        field_id,
        previous_value: previous_values.get(row_id).cloned().flatten(),
        value: Some(value.clone()),
        edit_revision: written_revisions[row_id],
      })
      .collect::<Vec<_>>();
    Self::insert_row_change_intents(&mut tx, database_id, updated_by, &intent_changes, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;

    let mut outcomes = Vec::with_capacity(row_ids.len());
    for row_id in row_ids {
      if !known_set.contains(row_id) {
        outcomes.push(Err(RepositoryError::NotFound("database row")));
        continue;
      }
      let cell = DatabaseCellValue {
        row_id: *row_id,
        field_id,
        field_type,
        value: value.clone(),
        updated_by: Some(updated_by),
        edit_revision: written_revisions[row_id],
        updated_at: chrono::Utc::now(),
      };
      outcomes.push(Ok(DatabaseCellWriteOutcome {
        change: DatabaseCommittedCellChange {
          row_id: *row_id,
          field_id,
          previous_value: previous_values.get(row_id).cloned().flatten(),
          value: Some(cell.value.clone()),
          edit_revision: cell.edit_revision,
        },
        cell,
      }));
    }
    Ok(outcomes)
  }

  pub(in crate::workspace_database) async fn persist_bulk_clear_cell_value(
    &self,
    row_ids: &[DatabaseRowId],
    field_id: DatabaseFieldId,
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseCommittedCellChange>>> {
    if row_ids.is_empty() {
      return Ok(Vec::new());
    }
    let mut tx = self.begin_write().await?;
    PgWorkspaceAutomationRepository::lock_document_review_tasks(&mut tx, row_ids).await?;
    let database_id =
      sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_rows WHERE id = $1")
        .bind(row_ids[0])
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::NotFound("database row"))?;
    let project_policy = Self::prepare_project_mutation(&mut tx, database_id, &[field_id], false).await?;

    let known_rows = sqlx::query_scalar::<_, DatabaseRowId>(
      r#"
        SELECT id
        FROM workspace_database_rows
        WHERE id = ANY($1) AND database_id = $2
          AND (NOT $3 OR deleted_at IS NULL)
        ORDER BY id ASC
        FOR UPDATE
      "#,
    )
    .bind(row_ids)
    .bind(database_id)
    .bind(
      project_policy
        .as_ref()
        .is_some_and(|policy| policy.parent_before.is_some() || policy.blocker_before.is_some()),
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    Self::assert_project_task_sources_live(&mut tx, database_id, &known_rows, project_policy.is_some()).await?;
    let known_set: std::collections::HashSet<DatabaseRowId> = known_rows.iter().copied().collect();
    if project_policy
      .as_ref()
      .is_some_and(|policy| policy.parent_before.is_some() || policy.blocker_before.is_some())
      && row_ids.iter().any(|row| !known_set.contains(row))
    {
      return Err(RepositoryError::NotFound("live database row"));
    }

    let revision_rows = sqlx::query(
      r#"
        SELECT row_id, edit_revision
        FROM workspace_database_cell_values
        WHERE field_id = $2 AND row_id = ANY($1)
      "#,
    )
    .bind(row_ids)
    .bind(field_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let mut actual_revisions = HashMap::new();
    for row in revision_rows {
      actual_revisions.insert(
        row
          .try_get::<DatabaseRowId, _>("row_id")
          .map_err(Self::map_sqlx_error)?,
        row.try_get::<i64, _>("edit_revision").map_err(Self::map_sqlx_error)?,
      );
    }
    for row_id in row_ids {
      let actual = actual_revisions.get(row_id).copied().unwrap_or(0);
      if !force
        && expected_edit_revisions
          .get(row_id)
          .is_some_and(|expected| *expected != actual)
      {
        return Err(RepositoryError::Conflict("database cell edit revision"));
      }
    }

    let mut previous = HashMap::new();
    for row_id in &known_rows {
      previous.insert(
        *row_id,
        Self::previous_cell_value(&mut tx, *row_id, field_id, None).await?,
      );
    }
    let written = sqlx::query(
      r#"
        INSERT INTO workspace_database_cell_values
          (row_id, field_id, value_json, database_id, updated_by, edit_revision, updated_at)
        SELECT r.id, $2, NULL, r.database_id, $3, 1, now()
        FROM workspace_database_rows r
        WHERE r.id = ANY($1) AND r.database_id = $4
        ON CONFLICT (row_id, field_id)
        DO UPDATE SET value_json = NULL,
                      database_id = EXCLUDED.database_id,
                      updated_by = EXCLUDED.updated_by,
                      edit_revision = workspace_database_cell_values.edit_revision + 1,
                      updated_at = EXCLUDED.updated_at
        RETURNING row_id, edit_revision
      "#,
    )
    .bind(row_ids)
    .bind(field_id)
    .bind(updated_by)
    .bind(database_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    let mut revisions = HashMap::new();
    for row in written {
      revisions.insert(
        row
          .try_get::<DatabaseRowId, _>("row_id")
          .map_err(Self::map_sqlx_error)?,
        row.try_get::<i64, _>("edit_revision").map_err(Self::map_sqlx_error)?,
      );
    }
    if let Some(policy) = project_policy.as_ref() {
      for row_id in &known_rows {
        Self::apply_project_side_effects(&mut tx, database_id, *row_id, &[field_id], updated_by, policy).await?;
      }
      Self::validate_project_hierarchy(&mut tx, database_id, policy).await?;
      if policy.parent_before.is_some() || policy.blocker_before.is_some() {
        for row_id in &known_rows {
          Self::clear_relation_edges_and_reciprocals(&mut tx, *row_id, field_id, updated_by).await?;
        }
      }
    }

    Self::cancel_cell_reminders(&mut tx, row_ids, field_id).await?;

    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    let intent_changes = known_rows
      .iter()
      .map(|row_id| DatabaseCommittedCellChange {
        row_id: *row_id,
        field_id,
        previous_value: previous.get(row_id).cloned().flatten(),
        value: None,
        edit_revision: revisions[row_id],
      })
      .collect::<Vec<_>>();
    Self::insert_row_change_intents(&mut tx, database_id, updated_by, &intent_changes, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;

    Ok(
      row_ids
        .iter()
        .map(|row_id| {
          if known_set.contains(row_id) {
            Ok(DatabaseCommittedCellChange {
              row_id: *row_id,
              field_id,
              previous_value: previous.remove(row_id).flatten(),
              value: None,
              edit_revision: revisions[row_id],
            })
          } else {
            Err(RepositoryError::NotFound("database row"))
          }
        })
        .collect(),
    )
  }

  pub(in crate::workspace_database) async fn persist_bulk_apply_cell_patches(
    &self,
    database_id: DatabaseId,
    patches: &[(DatabaseRowId, DatabaseFieldId, Option<DatabaseCellValueData>)],
    updated_by: UserId,
    expected_edit_revisions: &HashMap<(DatabaseRowId, DatabaseFieldId), i64>,
    force: bool,
    reminder_reschedules: Vec<DatabaseRowReminderReschedule>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseCommittedCellChange>>> {
    if patches.is_empty() {
      return Ok(Vec::new());
    }
    let mut targets = std::collections::HashSet::new();
    for (row_id, field_id, value) in patches {
      if !targets.insert((*row_id, *field_id)) {
        return Err(RepositoryError::Conflict("duplicate database cell target"));
      }
      if value.is_none() && !expected_edit_revisions.contains_key(&(*row_id, *field_id)) {
        return Err(RepositoryError::Conflict(
          "database cell edit revision required for Clear",
        ));
      }
    }
    let mut tx = self.begin_write().await?;
    if let Some(fence) = precondition.automation_effect {
      if crate::workflow_runtime::lock_runtime_effect(&mut tx, &fence)
        .await?
        .is_some()
      {
        tx.commit().await.map_err(Self::map_sqlx_error)?;
        return Ok(Vec::new());
      }
      Self::assert_correction_bulk_input(
        &mut tx,
        fence,
        database_id,
        patches,
        updated_by,
        expected_edit_revisions,
        force,
      )
      .await?;
    }

    // Validate that every target row belongs to this database, is alive, and
    // that every target field is part of this database. The whole batch is
    // rolled back if any check fails — partial application would be silent
    // corruption.
    let distinct_rows: Vec<DatabaseRowId> = {
      let mut seen = std::collections::BTreeSet::new();
      for (row_id, _, _) in patches {
        seen.insert(*row_id);
      }
      seen.into_iter().collect()
    };
    let distinct_fields: Vec<DatabaseFieldId> = {
      let mut seen = std::collections::BTreeSet::new();
      for (_, field_id, _) in patches {
        seen.insert(*field_id);
      }
      seen.into_iter().collect()
    };
    PgWorkspaceAutomationRepository::lock_document_review_tasks(&mut tx, &distinct_rows).await?;
    let project_policy = Self::prepare_project_mutation(&mut tx, database_id, &distinct_fields, false).await?;

    let locked_rows = sqlx::query(
      r#"
        SELECT id, created_at, updated_at, row_kind
        FROM workspace_database_rows
        WHERE database_id = $1 AND id = ANY($2) AND deleted_at IS NULL
        ORDER BY id ASC
        FOR UPDATE
      "#,
    )
    .bind(database_id)
    .bind(&distinct_rows)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let mut row_times = HashMap::new();
    for row in locked_rows {
      row_times.insert(
        row.try_get::<DatabaseRowId, _>("id").map_err(Self::map_sqlx_error)?,
        (
          row
            .try_get::<DateTime<Utc>, _>("created_at")
            .map_err(Self::map_sqlx_error)?,
          row
            .try_get::<DateTime<Utc>, _>("updated_at")
            .map_err(Self::map_sqlx_error)?,
          row.try_get::<String, _>("row_kind").map_err(Self::map_sqlx_error)? == "task",
        ),
      );
    }
    for row_id in &distinct_rows {
      if !row_times.contains_key(row_id) {
        return Err(RepositoryError::NotFound("database row"));
      }
    }

    let fields = Self::list_fields_for(&mut *tx, database_id).await?;
    let field_types = fields
      .iter()
      .map(|field| (field.id, field.field_type))
      .collect::<HashMap<_, _>>();
    for field_id in &distinct_fields {
      if !field_types.contains_key(field_id) {
        return Err(RepositoryError::NotFound("database field"));
      }
    }

    for (row_id, field_id, _) in patches {
      let actual = sqlx::query_scalar::<_, i64>(
        "SELECT edit_revision FROM workspace_database_cell_values WHERE row_id = $1 AND field_id = $2",
      )
      .bind(row_id)
      .bind(field_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?
      .unwrap_or(0);
      if !force
        && expected_edit_revisions
          .get(&(*row_id, *field_id))
          .is_some_and(|expected| *expected != actual)
      {
        return Err(RepositoryError::Conflict("database cell edit revision"));
      }
    }

    if let Some(policy) = project_policy.as_ref() {
      Self::validate_task_relations_proposal(&mut tx, database_id, policy, patches).await?;
    }

    // Serialize each patch as JSON and upsert in a single transaction.
    // sqlx does not bind a list of records natively, so we keep this
    // statement-by-statement inside the same transaction. This keeps the
    // lock scope tight while still giving us all-or-nothing semantics.
    let mut committed_changes = Vec::with_capacity(patches.len());
    for (row_id, field_id, value) in patches {
      let previous_value = Self::previous_cell_value(&mut tx, *row_id, *field_id, value.as_ref()).await?;
      let payload = value.as_ref().map(Self::map_cell_value_to_json).transpose()?;
      let revision = sqlx::query_scalar::<_, i64>(
        r#"
          INSERT INTO workspace_database_cell_values
            (row_id, field_id, value_json, database_id, updated_by, edit_revision, updated_at)
          VALUES ($1, $2, $3, $5, $4, 1, now())
          ON CONFLICT (row_id, field_id)
          DO UPDATE SET value_json = EXCLUDED.value_json,
                        updated_by = EXCLUDED.updated_by,
                        database_id = EXCLUDED.database_id,
                        edit_revision = workspace_database_cell_values.edit_revision + 1,
                        updated_at = EXCLUDED.updated_at
          RETURNING edit_revision
        "#,
      )
      .bind(row_id)
      .bind(field_id)
      .bind(payload)
      .bind(updated_by)
      .bind(database_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
      committed_changes.push(Ok(DatabaseCommittedCellChange {
        row_id: *row_id,
        field_id: *field_id,
        previous_value,
        value: value.clone(),
        edit_revision: revision,
      }));
      if let Some(DatabaseCellValueData::Relation(target_row_ids)) = value {
        Self::sync_relation_edges_and_reciprocals(&mut tx, *row_id, *field_id, target_row_ids, updated_by).await?;
        Self::mark_rollups_stale_for_relation_change(&mut tx, *row_id, *field_id).await?;
      } else if value.is_none() {
        if field_types.get(field_id) == Some(&DatabaseFieldType::Relation) {
          Self::sync_relation_edges_and_reciprocals(&mut tx, *row_id, *field_id, &[], updated_by).await?;
          Self::mark_rollups_stale_for_relation_change(&mut tx, *row_id, *field_id).await?;
        }
        Self::cancel_cell_reminders(&mut tx, &[*row_id], *field_id).await?;
      }
      Self::mark_rollups_stale_for_target_cell_change(&mut tx, *row_id, *field_id).await?;
      Self::mark_formulas_stale_for_cell_change(&mut tx, *row_id, *field_id).await?;
    }
    // Read the final image in this transaction, not the application's earlier
    // snapshot. Rows stay locked until range checks and all effects succeed.
    let views = Self::list_views_for(&mut *tx, database_id).await?;
    let cells = sqlx::query(
      "SELECT cv.row_id, cv.field_id, f.field_type, cv.value_json, cv.updated_by, cv.edit_revision, cv.updated_at FROM workspace_database_cell_values cv JOIN workspace_database_fields f ON f.id = cv.field_id WHERE cv.row_id = ANY($1) AND cv.value_json IS NOT NULL",
    )
    .bind(&distinct_rows).fetch_all(&mut *tx).await.map_err(Self::map_sqlx_error)?
    .into_iter().map(Self::map_cell).collect::<RepoResult<Vec<_>>>()?;
    for (row_id, (created_at, updated_at, task)) in &row_times {
      let row_cells = cells
        .iter()
        .filter(|cell| cell.row_id == *row_id)
        .cloned()
        .collect::<Vec<_>>();
      if let Some(policy) = project_policy.as_ref() {
        let changes = patches
          .iter()
          .filter(|(id, _, _)| id == row_id)
          .map(|(_, field_id, value)| (*field_id, value.clone()))
          .collect::<HashMap<_, _>>();
        validate_project_task_temporal_ranges(
          &fields,
          &views,
          task
            .then(|| Self::project_role_field(policy, "task.startDate"))
            .flatten(),
          task.then(|| Self::project_role_field(policy, "task.dueDate")).flatten(),
          &row_cells,
          *created_at,
          *updated_at,
          &changes,
          false,
        )
        .map_err(RepositoryError::Validation)?;
      } else {
        validate_database_temporal_ranges(&fields, &views, &row_cells, *created_at, *updated_at, &HashMap::new())
          .map_err(RepositoryError::Validation)?;
      }
    }
    let reminder_targets = patches
      .iter()
      .filter_map(|(row_id, field_id, value)| {
        matches!(value, Some(DatabaseCellValueData::DateTime(_))).then_some((*row_id, *field_id))
      })
      .collect::<Vec<_>>();
    Self::reschedule_database_row_reminders(&mut tx, &reminder_targets, reminder_reschedules).await?;
    if let Some(policy) = project_policy.as_ref() {
      let mut changed_by_row = HashMap::<DatabaseRowId, Vec<DatabaseFieldId>>::new();
      for (row_id, field_id, _) in patches {
        changed_by_row.entry(*row_id).or_default().push(*field_id);
      }
      for (row_id, changed_fields) in changed_by_row {
        Self::apply_project_side_effects(&mut tx, database_id, row_id, &changed_fields, updated_by, policy).await?;
      }
      Self::validate_project_hierarchy(&mut tx, database_id, policy).await?;
    }

    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    let intent_changes = committed_changes
      .iter()
      .filter_map(|change| change.as_ref().ok().cloned())
      .collect::<Vec<_>>();
    Self::insert_row_change_intents(&mut tx, database_id, updated_by, &intent_changes, precondition).await?;

    if let Some(fence) = precondition.automation_effect {
      let proposal_digest:String=sqlx::query_scalar("SELECT accepted_json->'taskMaintenance'->'plan'->'proposal'->>'digest' FROM workspace_automation_runs WHERE id=$1")
        .bind(fence.run_id).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
      crate::workflow_runtime::acknowledge_runtime_effect(
        &mut tx,
        &fence,
        serde_json::json!({"proposalDigest":proposal_digest,"applied":true}),
      )
      .await?;
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;

    Ok(committed_changes)
  }

  pub(in crate::workspace_database) async fn persist_bulk_update_row_positions(
    &self,
    database_id: DatabaseId,
    updates: &[(DatabaseRowId, i32)],
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseRowRecord>>> {
    if updates.is_empty() {
      return Ok(Vec::new());
    }
    let mut tx = self.begin_write().await?;
    Self::lock_managed_admission(&mut tx, database_id).await?;

    let row_ids: Vec<DatabaseRowId> = updates.iter().map(|(row_id, _)| *row_id).collect();
    let known_rows = sqlx::query(
      r#"
        SELECT id, edit_revision
        FROM workspace_database_rows
        WHERE database_id = $1 AND id = ANY($2)
        ORDER BY id ASC
        FOR UPDATE
      "#,
    )
    .bind(database_id)
    .bind(&row_ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if known_rows.len() != row_ids.len() {
      return Err(RepositoryError::NotFound("database row"));
    }
    for row in known_rows {
      let row_id: DatabaseRowId = row.try_get("id").map_err(Self::map_sqlx_error)?;
      let revision: i64 = row.try_get("edit_revision").map_err(Self::map_sqlx_error)?;
      if !force
        && expected_edit_revisions
          .get(&row_id)
          .is_some_and(|expected| *expected != revision)
      {
        return Err(RepositoryError::Conflict("database row edit revision"));
      }
    }

    // Rewrite `position` for each requested row.
    for (row_id, position) in updates {
      sqlx::query(
        r#"
          UPDATE workspace_database_rows
          SET position = $3,
              updated_by = $4,
              edit_revision = edit_revision + 1,
              updated_at = now()
          WHERE database_id = $1 AND id = $2
        "#,
      )
      .bind(database_id)
      .bind(row_id)
      .bind(*position)
      .bind(updated_by)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }

    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;

    // Read back the rewritten rows ordered by `(position, id)` so the
    // caller can re-render an ordered view directly. `deleted_at` is
    // synthesized from the joined `docs` row (or NULL when the row is
    // not linked to a document) to match the per-row contract used by
    // `get_row`.
    let records = sqlx::query(
      r#"
        SELECT r.id, r.database_id, r.doc_id, r.title, r.position,
               r.row_kind, r.created_by, r.updated_by, r.edit_revision, r.created_at, r.updated_at,
               d.deleted_at AS deleted_at
        FROM workspace_database_rows r
        LEFT JOIN docs d ON d.id = r.doc_id
        WHERE r.database_id = $1 AND r.id = ANY($2)
        ORDER BY r.position ASC, r.id ASC
      "#,
    )
    .bind(database_id)
    .bind(&row_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;

    let mut records_by_id: std::collections::HashMap<DatabaseRowId, DatabaseRowRecord> =
      std::collections::HashMap::new();
    for row in records {
      let mapped = Self::map_row(row)?;
      records_by_id.insert(
        mapped.id,
        DatabaseRowRecord {
          row: mapped,
          cells: Vec::new(),
          cell_revisions: Vec::new(),
        },
      );
    }
    Ok(
      row_ids
        .iter()
        .map(|row_id| {
          records_by_id
            .remove(row_id)
            .ok_or(RepositoryError::NotFound("database row"))
        })
        .collect(),
    )
  }
}
