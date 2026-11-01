// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::workspace_database::*;
/// Graph snapshots exist only under the caller's native write transaction.
pub(in crate::workspace_database) struct LockedProjectMutation {
  pub(in crate::workspace_database) semantics: DatabaseProjectMutationPolicy,
  pub(in crate::workspace_database) parent_before: Option<DatabaseTaskRelationGraph>,
  pub(in crate::workspace_database) blocker_before: Option<DatabaseTaskRelationGraph>,
}

impl PgDatabaseRepository {
  // Call only after the source Row locks. Ordinary Task Cell writers share
  // the lifecycle fence even when no Parent/BlockedBy graph is being edited.
  pub(in crate::workspace_database) async fn assert_project_task_sources_live(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
    project: bool,
  ) -> RepoResult<()> {
    let changed: bool =
      sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_database_rows WHERE id=ANY($2) AND database_id<>$1)")
        .bind(database_id)
        .bind(row_ids)
        .fetch_one(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?;
    if changed {
      return Err(RepositoryError::Conflict("database row owner changed"));
    }
    if !project {
      return Ok(());
    }
    let trashed: bool = sqlx::query_scalar(
      r#"
      SELECT EXISTS (SELECT 1 FROM workspace_database_rows
        WHERE database_id=$1 AND id=ANY($2) AND row_kind='task' AND deleted_at IS NOT NULL)
    "#,
    )
    .bind(database_id)
    .bind(row_ids)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if trashed {
      return Err(RepositoryError::NotFound("live database row"));
    }
    Ok(())
  }

  pub(in crate::workspace_database) async fn prepare_project_mutation(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    directly_edited_fields: &[DatabaseFieldId],
    creates_row: bool,
  ) -> RepoResult<Option<LockedProjectMutation>> {
    Self::lock_managed_admission(tx, database_id).await?;

    Self::fence_task_relation_writers(tx, database_id, directly_edited_fields, creates_row).await?;
    let profile = sqlx::query(
      r#"
        SELECT profile_kind, structure_preset
        FROM database_profiles
        WHERE database_id = $1
      "#,
    )
    .bind(database_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let Some(profile) = profile else {
      return Ok(None);
    };
    let profile_kind: String = profile.try_get("profile_kind").map_err(Self::map_sqlx_error)?;
    if profile_kind != DatabaseProfileKind::Project.as_str() {
      return Ok(None);
    }

    // Acquire definition locks before any Row locks. Every decision below is
    // derived from these same transaction-local definitions, never a UI cache.
    sqlx::query("SELECT id FROM workspace_database_fields WHERE database_id=$1 ORDER BY id FOR SHARE")
      .bind(database_id)
      .fetch_all(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let fields = Self::list_fields_for(&mut **tx, database_id).await?;
    let roles = Self::list_field_roles_for(&mut **tx, database_id).await?;
    let structure: Option<String> = profile.try_get("structure_preset").map_err(Self::map_sqlx_error)?;
    let structure = structure
      .as_deref()
      .map(DatabaseProjectStructurePreset::from_str)
      .transpose()
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let semantics = myoxus_domain::database::projects::prepare_project_mutation(
      &roles,
      &fields,
      structure,
      directly_edited_fields,
      creates_row,
    )
    .map_err(RepositoryError::Validation)?;
    let enforces_hierarchy = semantics.enforce_hierarchy;
    let edits_parent = semantics.edits_parent;
    let edits_blocker = semantics.edits_blocker;
    let parent_field = semantics.roles.get("task.parent").map(|(field, _)| *field);
    let blocker_field = semantics.roles.get("task.blockedBy").map(|(field, _)| *field);
    if edits_parent || edits_blocker {
      let live: bool = sqlx::query_scalar("SELECT deleted_at IS NULL FROM workspace_databases WHERE id=$1")
        .bind(database_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .unwrap_or(false);
      if !live {
        return Err(RepositoryError::NotFound("active database"));
      }
    }

    if enforces_hierarchy || edits_parent || edits_blocker {
      // Hierarchy validation reads multiple rows. Lock them in deterministic
      // order so concurrent relation writes cannot validate one graph and
      // commit against another. Ordinary Project field writes avoid this
      // database-wide lock. NO KEY UPDATE keeps the graph stable while allowing
      // ordinary Relation edge inserts to acquire FK KEY SHARE on these IDs.
      // Upgrade the actual source Row only after this complete lock round.
      sqlx::query(
        r#"
          SELECT id
          FROM workspace_database_rows
          WHERE database_id = $1
          ORDER BY id
          FOR NO KEY UPDATE
        "#,
      )
      .bind(database_id)
      .fetch_all(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }
    Ok(Some(LockedProjectMutation {
      parent_before: if edits_parent {
        Some(Self::load_task_relation_graph(tx, database_id, parent_field.expect("bound parent role")).await?)
      } else {
        None
      },
      blocker_before: if edits_blocker {
        Some(Self::load_task_relation_graph(tx, database_id, blocker_field.expect("bound blocker role")).await?)
      } else {
        None
      },
      semantics,
    }))
  }

  pub(in crate::workspace_database) fn project_role_field(
    policy: &LockedProjectMutation,
    role_key: &str,
  ) -> Option<DatabaseFieldId> {
    policy.semantics.roles.get(role_key).map(|(field_id, _)| *field_id)
  }

  // Called while the Row is locked, after the write, so concurrent start/due
  // edits cannot each validate against an earlier application snapshot.
  pub(in crate::workspace_database) async fn validate_project_task_dates_after_write(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    policy: &LockedProjectMutation,
    changes: &HashMap<DatabaseFieldId, Option<DatabaseCellValueData>>,
  ) -> RepoResult<()> {
    let fields = Self::list_fields_for(&mut **tx, database_id).await?;
    let cells = sqlx::query(
      "SELECT cv.row_id, cv.field_id, f.field_type, cv.value_json, cv.updated_by, cv.edit_revision, cv.updated_at FROM workspace_database_cell_values cv JOIN workspace_database_fields f ON f.id = cv.field_id WHERE cv.row_id = $1 AND cv.value_json IS NOT NULL",
    ).bind(row_id).fetch_all(&mut **tx).await.map_err(Self::map_sqlx_error)?
      .into_iter().map(Self::map_cell).collect::<RepoResult<Vec<_>>>()?;
    let views = Self::list_views_for(&mut **tx, database_id).await?;
    let times = sqlx::query("SELECT created_at, updated_at, row_kind FROM workspace_database_rows WHERE id = $1")
      .bind(row_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let task = times.try_get::<String, _>("row_kind").map_err(Self::map_sqlx_error)? == "task";
    validate_project_task_temporal_ranges(
      &fields,
      &views,
      task
        .then(|| Self::project_role_field(policy, "task.startDate"))
        .flatten(),
      task.then(|| Self::project_role_field(policy, "task.dueDate")).flatten(),
      &cells,
      times.try_get("created_at").map_err(Self::map_sqlx_error)?,
      times.try_get("updated_at").map_err(Self::map_sqlx_error)?,
      changes,
      false,
    )
    .map_err(RepositoryError::Validation)
  }

  pub(in crate::workspace_database) async fn write_project_derived_cell(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: Option<DatabaseCellValueData>,
    updated_by: UserId,
  ) -> RepoResult<()> {
    let value_json = value.as_ref().map(Self::map_cell_value_to_json).transpose()?;
    sqlx::query(
      r#"
        INSERT INTO workspace_database_cell_values
          (row_id, field_id, value_json, database_id, updated_by, edit_revision, updated_at)
        VALUES ($1, $2, $3, $4, $5, 1, now())
        ON CONFLICT (row_id, field_id) DO UPDATE
          SET value_json = EXCLUDED.value_json,
              database_id = EXCLUDED.database_id,
              updated_by = EXCLUDED.updated_by,
              edit_revision = workspace_database_cell_values.edit_revision + 1,
              updated_at = now()
      "#,
    )
    .bind(row_id)
    .bind(field_id)
    .bind(value_json)
    .bind(database_id)
    .bind(updated_by)
    .execute(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    Self::mark_rollups_stale_for_target_cell_change(tx, row_id, field_id).await?;
    Self::mark_formulas_stale_for_cell_change(tx, row_id, field_id).await?;
    Ok(())
  }

  pub(in crate::workspace_database) async fn apply_project_side_effects(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    changed_fields: &[DatabaseFieldId],
    updated_by: UserId,
    policy: &LockedProjectMutation,
  ) -> RepoResult<Vec<DatabaseFieldId>> {
    let row_kind = sqlx::query_scalar::<_, String>(
      "SELECT row_kind FROM workspace_database_rows WHERE database_id = $1 AND id = $2",
    )
    .bind(database_id)
    .bind(row_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database row"))?;
    if row_kind != DatabaseRowKind::Task.as_str() {
      return Ok(Vec::new());
    }

    // Cancel immutable queued generations as well as pending schedules. Reopen
    // never changes cancelled reminders back to scheduled.
    if !Self::task_reminder_is_open(tx, database_id, row_id).await? {
      Self::cancel_closed_task_reminders(tx, row_id).await?;
    }
    let status_value = if let Some(status_field) = Self::project_role_field(policy, "task.status")
      && changed_fields.contains(&status_field)
    {
      sqlx::query_scalar::<_,Value>("SELECT value_json FROM workspace_database_cell_values WHERE row_id=$1 AND field_id=$2 AND value_json IS NOT NULL")
        .bind(row_id).bind(status_field).fetch_optional(&mut **tx).await.map_err(Self::map_sqlx_error)?
        .and_then(|value|value.as_str().map(str::to_string))
    } else {
      None
    };
    let has_completed_at = if let Some(field) = Self::project_role_field(policy, "task.completedAt") {
      sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM workspace_database_cell_values WHERE row_id=$1 AND field_id=$2 AND value_json IS NOT NULL)")
        .bind(row_id).bind(field).fetch_one(&mut **tx).await.map_err(Self::map_sqlx_error)?
    } else {
      false
    };
    let effects = myoxus_domain::database::projects::project_cell_effects(
      &policy.semantics,
      DatabaseRowKind::Task,
      changed_fields,
      status_value.as_deref(),
      has_completed_at,
      updated_by,
      Utc::now(),
    )
    .map_err(RepositoryError::Validation)?;
    let mut derived = Vec::with_capacity(effects.len());
    for effect in effects {
      Self::write_project_derived_cell(tx, database_id, row_id, effect.field_id, effect.value, updated_by).await?;
      derived.push(effect.field_id);
    }
    Ok(derived)
  }

  pub(in crate::workspace_database) async fn validate_project_hierarchy(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    policy: &LockedProjectMutation,
  ) -> RepoResult<()> {
    Self::validate_task_relations_after_write(tx, database_id, policy).await?;
    if !policy.semantics.enforce_hierarchy {
      return Ok(());
    }
    let Some(task_phase_field) = Self::project_role_field(policy, "task.phase") else {
      return Ok(());
    };
    let Some(task_milestone_field) = Self::project_role_field(policy, "task.milestone") else {
      return Ok(());
    };
    let Some(milestone_phase_field) = Self::project_role_field(policy, "milestone.phase") else {
      return Ok(());
    };

    let row_rows = sqlx::query(
      r#"
        SELECT id, row_kind
        FROM workspace_database_rows
        WHERE database_id = $1 AND deleted_at IS NULL
      "#,
    )
    .bind(database_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let mut row_kinds = HashMap::with_capacity(row_rows.len());
    for row in row_rows {
      row_kinds.insert(
        row.try_get::<DatabaseRowId, _>("id").map_err(Self::map_sqlx_error)?,
        DatabaseRowKind::from_str(&row.try_get::<String, _>("row_kind").map_err(Self::map_sqlx_error)?)
          .map_err(|error| RepositoryError::Validation(error.to_string()))?,
      );
    }
    let relation_rows = sqlx::query(
      r#"
        SELECT row_id, field_id, value_json
        FROM workspace_database_cell_values cell
        JOIN workspace_database_rows row ON row.id = cell.row_id
        WHERE row.database_id = $1
          AND cell.field_id = ANY($2)
          AND cell.value_json IS NOT NULL
      "#,
    )
    .bind(database_id)
    .bind(vec![task_phase_field, task_milestone_field, milestone_phase_field])
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let mut relations = HashMap::<(DatabaseRowId, DatabaseFieldId), Vec<DatabaseRowId>>::new();
    for row in relation_rows {
      let row_id = row.try_get("row_id").map_err(Self::map_sqlx_error)?;
      let field_id = row.try_get("field_id").map_err(Self::map_sqlx_error)?;
      let value = Self::map_cell_value_from_json(
        DatabaseFieldType::Relation,
        row.try_get("value_json").map_err(Self::map_sqlx_error)?,
      )?;
      let DatabaseCellValueData::Relation(targets) = value else {
        return Err(RepositoryError::Validation(format!(
          "{PROJECT_HIERARCHY_ERROR}: role relation has invalid storage"
        )));
      };
      relations.insert((row_id, field_id), targets);
    }

    myoxus_domain::database::projects::validate_project_hierarchy(&policy.semantics, &row_kinds, &relations)
      .map_err(RepositoryError::Validation)
  }
}
