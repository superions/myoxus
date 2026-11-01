// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::workspace_database::*;

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn load_task_relation_graph(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    field_id: DatabaseFieldId,
  ) -> RepoResult<DatabaseTaskRelationGraph> {
    let cells = sqlx::query(
      r#"
        SELECT cell.row_id, cell.value_json
        FROM workspace_database_cell_values cell
        JOIN workspace_database_rows row
        ON row.id=cell.row_id
        WHERE row.database_id=$1
        AND cell.field_id=$2
        AND cell.value_json IS NOT NULL
      "#,
    )
    .bind(database_id)
    .bind(field_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let mut graph = DatabaseTaskRelationGraph::default();
    for cell in cells {
      let value: Value = cell.try_get("value_json").map_err(Self::map_sqlx_error)?;
      if let Ok(DatabaseCellValueData::Relation(targets)) =
        Self::map_cell_value_from_json(DatabaseFieldType::Relation, value)
      {
        graph
          .edges
          .insert(cell.try_get("row_id").map_err(Self::map_sqlx_error)?, targets);
      }
    }
    let targets = graph.edges.values().flatten().copied().collect::<Vec<_>>();
    let rows = sqlx::query(
      r#"
        SELECT id,database_id,row_kind,deleted_at IS NULL AS live
        FROM workspace_database_rows
        WHERE database_id=$1 OR id=ANY($2)
      "#,
    )
    .bind(database_id)
    .bind(targets)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    for row in rows {
      let kind: String = row.try_get("row_kind").map_err(Self::map_sqlx_error)?;
      graph.rows.insert(
        row.try_get("id").map_err(Self::map_sqlx_error)?,
        (
          row.try_get("database_id").map_err(Self::map_sqlx_error)?,
          DatabaseRowKind::from_str(&kind).map_err(|error| RepositoryError::Validation(error.to_string()))?,
          row.try_get("live").map_err(Self::map_sqlx_error)?,
        ),
      );
    }
    Ok(graph)
  }

  // Snapshot/lifecycle callers have no explicit Cell list. Select only the
  // real Relation owner, then reuse the same DB→Field→graph admission order.
  pub(in crate::workspace_database) async fn prepare_task_graph_mutation(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
  ) -> RepoResult<Option<LockedProjectMutation>> {
    let roles = Self::list_field_roles_for(&mut **tx, database_id).await?;
    let role_iter = || {
      roles
        .iter()
        .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id))
    };
    let mut fields = Vec::new();
    for blocked in [false, true] {
      let selected = if blocked {
        task_blocked_by_field(role_iter())
      } else {
        task_parent_field(role_iter())
      };
      let Some(field) = selected else { continue };
      let conflicting = if blocked {
        task_blocked_by_has_conflicting_task_role(field, role_iter())
      } else {
        task_parent_has_conflicting_task_role(field, role_iter())
      };
      if conflicting {
        continue;
      }
      let is_relation = sqlx::query_scalar::<_, bool>(
        "SELECT field_type='relation' FROM workspace_database_fields WHERE database_id=$1 AND id=$2",
      )
      .bind(database_id)
      .bind(field)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?
      .unwrap_or(false);
      if is_relation {
        fields.push(field);
      }
    }
    if fields.is_empty() {
      return Ok(None);
    }
    Self::prepare_project_mutation(tx, database_id, &fields, false).await
  }

  pub(in crate::workspace_database) async fn validate_task_relation_templates(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    values: &[(DatabaseRowKind, &BTreeMap<DatabaseFieldId, DatabaseCellValueData>)],
  ) -> RepoResult<()> {
    if values.is_empty() {
      return Ok(());
    }
    let Some(policy) = Self::prepare_task_graph_mutation(tx, database_id).await? else {
      return Ok(());
    };
    // Native future identities are allocated by the writer; Domain evaluates
    // the proposed values against facts captured under this same transaction.
    let planned = values
      .iter()
      .map(|(kind, cells)| (Uuid::new_v4(), *kind, *cells))
      .collect::<Vec<_>>();
    for (before, blocked) in [(&policy.parent_before, false), (&policy.blocker_before, true)] {
      let Some(before) = before else { continue };
      myoxus_domain::database::projects::validate_task_relation_template_values(
        database_id,
        &policy.semantics,
        before,
        &planned,
        blocked,
      )
      .map_err(RepositoryError::Validation)?;
    }
    Ok(())
  }

  pub(in crate::workspace_database) async fn validate_task_relations_after_write(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    policy: &LockedProjectMutation,
  ) -> RepoResult<()> {
    for (role, before, blocked) in [
      ("task.parent", &policy.parent_before, false),
      ("task.blockedBy", &policy.blocker_before, true),
    ] {
      if let Some(before) = before
        && let Some(field) = Self::project_role_field(policy, role)
      {
        let after = Self::load_task_relation_graph(tx, database_id, field).await?;
        Self::validate_task_relation_graph(database_id, policy, before, &after, blocked)?;
      }
    }
    Ok(())
  }

  pub(in crate::workspace_database) fn validate_task_relation_graph(
    database_id: DatabaseId,
    policy: &LockedProjectMutation,
    before: &DatabaseTaskRelationGraph,
    after: &DatabaseTaskRelationGraph,
    blocked: bool,
  ) -> RepoResult<()> {
    myoxus_domain::database::projects::validate_task_relation_graph(
      database_id,
      &policy.semantics,
      before,
      after,
      blocked,
    )
    .map_err(RepositoryError::Validation)
  }

  /// Validate the final bulk proposal before FK-backed projection. All graph
  /// Rows are locked; patch order must not reject an intermediate cycle that
  /// another patch removes in this same atomic mutation.
  pub(in crate::workspace_database) async fn validate_task_relations_proposal(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    policy: &LockedProjectMutation,
    patches: &[(DatabaseRowId, DatabaseFieldId, Option<DatabaseCellValueData>)],
  ) -> RepoResult<()> {
    Self::validate_task_relation_proposal(tx, database_id, policy, patches, false).await?;
    Self::validate_task_relation_proposal(tx, database_id, policy, patches, true).await
  }

  pub(in crate::workspace_database) async fn validate_task_relation_proposal(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    policy: &LockedProjectMutation,
    patches: &[(DatabaseRowId, DatabaseFieldId, Option<DatabaseCellValueData>)],
    blocked: bool,
  ) -> RepoResult<()> {
    let Some(before) = (if blocked {
      &policy.blocker_before
    } else {
      &policy.parent_before
    }) else {
      return Ok(());
    };
    let Some(parent) = Self::project_role_field(policy, if blocked { "task.blockedBy" } else { "task.parent" }) else {
      return Ok(());
    };
    let mut after = before.clone();
    for (row, field, value) in patches {
      if *field != parent {
        continue;
      }
      match value {
        Some(DatabaseCellValueData::Relation(targets)) => {
          after.edges.insert(*row, targets.clone());
        }
        None => {
          after.edges.remove(row);
        }
        _ => {
          return Err(RepositoryError::Validation(
            DatabaseTaskRelationReason::IncompatibleRoleConfiguration.validation_message(),
          ));
        }
      }
    }
    let targets = after.edges.values().flatten().copied().collect::<Vec<_>>();
    let rows = sqlx::query(
      "SELECT id,database_id,row_kind,deleted_at IS NULL AS live FROM workspace_database_rows WHERE id=ANY($1)",
    )
    .bind(targets)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    for row in rows {
      let kind: String = row.try_get("row_kind").map_err(Self::map_sqlx_error)?;
      after.rows.insert(
        row.try_get("id").map_err(Self::map_sqlx_error)?,
        (
          row.try_get("database_id").map_err(Self::map_sqlx_error)?,
          DatabaseRowKind::from_str(&kind).map_err(|error| RepositoryError::Validation(error.to_string()))?,
          row.try_get("live").map_err(Self::map_sqlx_error)?,
        ),
      );
    }
    Self::validate_task_relation_graph(database_id, policy, before, &after, blocked)
  }

  /// Serialize direct Task graph edits and actual reciprocal writers before their
  /// first Field/Row locks. NO KEY UPDATE leaves FK KEY SHARE admission free;
  /// UUID order makes cross-Database reciprocal edits use the same fence order.
  pub(in crate::workspace_database) async fn fence_task_relation_writers(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    fields: &[DatabaseFieldId],
    creates_row: bool,
  ) -> RepoResult<()> {
    let direct_graph: bool = sqlx::query_scalar(
      r#"SELECT EXISTS (
        SELECT 1 FROM database_field_roles role
        JOIN database_profiles profile ON profile.database_id=role.database_id
        WHERE role.database_id=$1 AND role.role_key IN ('task.parent','task.blockedBy')
          AND profile.profile_kind='project' AND ($3 OR role.field_id=ANY($2))
      )"#,
    )
    .bind(database_id)
    .bind(fields)
    .bind(creates_row)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let targets = Self::reciprocal_target_databases(tx, database_id, fields).await?;
    if !direct_graph && targets.is_empty() {
      return Ok(());
    }
    let mut scopes = targets.clone();
    scopes.push(database_id);
    scopes.sort();
    scopes.dedup();
    sqlx::query(
      r#"SELECT id FROM workspace_databases
         WHERE id=ANY($1) ORDER BY id FOR NO KEY UPDATE"#,
    )
    .bind(&scopes)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    sqlx::query(
      r#"SELECT id FROM workspace_database_fields
         WHERE database_id=$1 AND id=ANY($2) ORDER BY id FOR SHARE"#,
    )
    .bind(database_id)
    .bind(fields)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    // Discovery precedes the DB fences; a schema edit may have won that gap.
    // Never expand the lock set out of order after individual Fields are held.
    if Self::reciprocal_target_databases(tx, database_id, fields).await? != targets {
      return Err(RepositoryError::Conflict("database field edit revision"));
    }
    Ok(())
  }

  pub(in crate::workspace_database) async fn reciprocal_target_databases(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    fields: &[DatabaseFieldId],
  ) -> RepoResult<Vec<DatabaseId>> {
    sqlx::query_scalar(
      r#"SELECT DISTINCT target.database_id
         FROM workspace_database_fields source
         JOIN workspace_database_fields target
           ON target.id::text=source.config_json->>'reciprocalFieldId'
         WHERE source.database_id=$1 AND source.id=ANY($2)
           AND source.field_type='relation'
         ORDER BY target.database_id"#,
    )
    .bind(database_id)
    .bind(fields)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)
  }

  pub(in crate::workspace_database) async fn load_relation_projection_context(
    tx: &mut Transaction<'_, Postgres>,
    source_row_id: DatabaseRowId,
    source_field_id: DatabaseFieldId,
  ) -> RepoResult<(DatabaseId, DatabaseRelationFieldConfig)> {
    let row_database_sql = format!("SELECT database_id FROM {DATABASE_ROWS_TABLE} WHERE id = $1");
    let source_database_id: DatabaseId = sqlx::query_scalar(&row_database_sql)
      .bind(source_row_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_snapshot_sqlx_error)?
      .ok_or(RepositoryError::NotFound("database source row"))?;
    let field_row = sqlx::query(
      "SELECT config_json FROM workspace_database_fields WHERE id = $1 AND database_id = $2 AND field_type = 'relation'",
    )
    .bind(source_field_id)
    .bind(source_database_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_snapshot_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database relation field"))?;
    let config_json = field_row
      .try_get::<Value, _>("config_json")
      .map_err(Self::map_snapshot_sqlx_error)?;
    let config: DatabaseFieldConfig =
      serde_json::from_value(config_json).map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let DatabaseFieldConfig::Relation(config) = config else {
      return Err(RepositoryError::Validation(
        "relation edge projection requires relation field config".to_string(),
      ));
    };
    Ok((source_database_id, config))
  }

  pub(in crate::workspace_database) async fn maybe_load_relation_projection_context(
    tx: &mut Transaction<'_, Postgres>,
    source_row_id: DatabaseRowId,
    source_field_id: DatabaseFieldId,
  ) -> RepoResult<Option<(DatabaseId, DatabaseRelationFieldConfig)>> {
    let Some(field_row) = sqlx::query(
      r#"
        SELECT r.database_id, f.config_json
        FROM workspace_database_rows r
        JOIN workspace_database_fields f ON f.database_id = r.database_id
        WHERE r.id = $1 AND f.id = $2 AND f.field_type = 'relation'
      "#,
    )
    .bind(source_row_id)
    .bind(source_field_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?
    else {
      return Ok(None);
    };
    let source_database_id = field_row.try_get("database_id").map_err(Self::map_sqlx_error)?;
    let config_json = field_row
      .try_get::<Value, _>("config_json")
      .map_err(Self::map_sqlx_error)?;
    let config: DatabaseFieldConfig =
      serde_json::from_value(config_json).map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let DatabaseFieldConfig::Relation(config) = config else {
      return Err(RepositoryError::Validation(
        "relation edge projection requires relation field config".to_string(),
      ));
    };
    Ok(Some((source_database_id, config)))
  }

  pub(in crate::workspace_database) async fn relation_targets_from_edges(
    tx: &mut Transaction<'_, Postgres>,
    source_row_id: DatabaseRowId,
    source_field_id: DatabaseFieldId,
  ) -> RepoResult<Vec<DatabaseRowId>> {
    sqlx::query_scalar(
      r#"
        SELECT target_row_id
        FROM workspace_database_relation_edges
        WHERE source_row_id = $1 AND source_field_id = $2
        ORDER BY position ASC, target_row_id ASC
      "#,
    )
    .bind(source_row_id)
    .bind(source_field_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_snapshot_sqlx_error)
  }

  /// Resolve the canonical Task graph Cell, including a wrong-scope fallback
  /// so legacy removals retain invalid IDs without inserting invalid FKs.
  /// This grants no capability and cannot replace another actual field owner.
  pub(in crate::workspace_database) async fn authoritative_task_relation_cell(
    tx: &mut Transaction<'_, Postgres>,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
  ) -> RepoResult<Option<DatabaseId>> {
    sqlx::query_scalar(
      r#"SELECT row.database_id
         FROM workspace_database_rows row
         JOIN database_profiles profile ON profile.database_id=row.database_id AND profile.profile_kind='project'
         JOIN workspace_database_fields field ON field.database_id=row.database_id AND field.id=$2 AND field.field_type='relation'
         JOIN LATERAL (
           SELECT DISTINCT ON (role.role_key) role.field_id, role.role_key FROM database_field_roles role
           WHERE role.database_id=row.database_id AND role.role_key IN ('task.parent','task.blockedBy')
           ORDER BY role.role_key, CASE WHEN role.row_kind_scope='task' THEN 0 ELSE 1 END,
             coalesce(role.row_kind_scope,''),role.field_id
         ) parent ON parent.field_id=field.id
         WHERE row.id=$1 AND NOT EXISTS (
           SELECT 1 FROM database_field_roles other
           WHERE other.database_id=row.database_id AND other.field_id=field.id
             AND other.role_key<>parent.role_key AND other.row_kind_scope='task'
         ) AND NOT EXISTS (
           SELECT 1 FROM database_field_roles other
           WHERE row.row_kind<>'task' AND other.database_id=row.database_id AND other.field_id=field.id
             AND other.role_key<>parent.role_key AND other.row_kind_scope=row.row_kind
         )"#,
    ).bind(row_id).bind(field_id).fetch_optional(&mut **tx).await.map_err(Self::map_sqlx_error)
  }

  pub(in crate::workspace_database) async fn reciprocal_targets_for_update(
    tx: &mut Transaction<'_, Postgres>,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
  ) -> RepoResult<(Vec<DatabaseRowId>, bool)> {
    let parent = Self::authoritative_task_relation_cell(tx, row_id, field_id)
      .await?
      .is_some();
    if !parent {
      return Ok((Self::relation_targets_from_edges(tx, row_id, field_id).await?, false));
    }
    sqlx::query("SELECT id FROM workspace_database_rows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE")
      .bind(row_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?
      .ok_or(RepositoryError::NotFound("live database row"))?;
    let value = sqlx::query_scalar::<_, Option<Value>>(
      "SELECT value_json FROM workspace_database_cell_values WHERE row_id=$1 AND field_id=$2",
    )
    .bind(row_id)
    .bind(field_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .flatten();
    let Some(value) = value else {
      return Ok((Vec::new(), true));
    };
    match Self::map_cell_value_from_json(DatabaseFieldType::Relation, value)? {
      DatabaseCellValueData::Relation(targets) => Ok((targets, true)),
      _ => unreachable!("Relation parser"),
    }
  }

  pub(in crate::workspace_database) async fn sync_relation_edges_with_context(
    tx: &mut Transaction<'_, Postgres>,
    source_database_id: DatabaseId,
    source_row_id: DatabaseRowId,
    source_field_id: DatabaseFieldId,
    target_database_id: DatabaseId,
    target_row_ids: &[DatabaseRowId],
  ) -> RepoResult<()> {
    sqlx::query("DELETE FROM workspace_database_relation_edges WHERE source_row_id = $1 AND source_field_id = $2")
      .bind(source_row_id)
      .bind(source_field_id)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_snapshot_sqlx_error)?;

    for (position, target_row_id) in target_row_ids.iter().enumerate() {
      sqlx::query(
        r#"
          INSERT INTO workspace_database_relation_edges
            (source_database_id, source_row_id, source_field_id, target_database_id, target_row_id, position, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, now(), now())
          ON CONFLICT (source_row_id, source_field_id, target_row_id) DO UPDATE
            SET position = EXCLUDED.position,
                updated_at = now()
        "#,
      )
      .bind(source_database_id)
      .bind(source_row_id)
      .bind(source_field_id)
      .bind(target_database_id)
      .bind(*target_row_id)
      .bind(position as i32)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_snapshot_sqlx_error)?;
    }
    Ok(())
  }

  pub(in crate::workspace_database) async fn sync_relation_edges(
    tx: &mut Transaction<'_, Postgres>,
    source_row_id: DatabaseRowId,
    source_field_id: DatabaseFieldId,
    target_row_ids: &[DatabaseRowId],
  ) -> RepoResult<()> {
    if let Some(database) = Self::authoritative_task_relation_cell(tx, source_row_id, source_field_id).await? {
      return Self::sync_task_relation_edges(tx, database, source_row_id, source_field_id, target_row_ids).await;
    }
    let (source_database_id, config) =
      Self::load_relation_projection_context(tx, source_row_id, source_field_id).await?;
    Self::sync_relation_edges_with_context(
      tx,
      source_database_id,
      source_row_id,
      source_field_id,
      config.target_database_id,
      target_row_ids,
    )
    .await
  }

  pub(in crate::workspace_database) async fn write_relation_cell_without_mirror(
    tx: &mut Transaction<'_, Postgres>,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    target_row_ids: &[DatabaseRowId],
    updated_by: UserId,
  ) -> RepoResult<()> {
    sqlx::query_scalar::<_, DatabaseRowId>("SELECT id FROM workspace_database_rows WHERE id = $1 FOR UPDATE")
      .bind(row_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_snapshot_sqlx_error)?
      .ok_or(RepositoryError::NotFound(
        myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode::RelationRowMissing.as_str(),
      ))?;
    if target_row_ids.is_empty() {
      sqlx::query(
        r#"
          INSERT INTO workspace_database_cell_values
            (row_id, field_id, value_json, database_id, updated_by, edit_revision, updated_at)
          VALUES ($1, $2, NULL, (SELECT database_id FROM workspace_database_rows WHERE id = $1), $3, 1, now())
          ON CONFLICT (row_id, field_id) DO UPDATE
            SET value_json = NULL,
                database_id = EXCLUDED.database_id,
                updated_by = EXCLUDED.updated_by,
                edit_revision = workspace_database_cell_values.edit_revision + 1,
                updated_at = now()
        "#,
      )
      .bind(row_id)
      .bind(field_id)
      .bind(updated_by)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_snapshot_sqlx_error)?;
    } else {
      let value_json =
        serde_json::to_value(target_row_ids).map_err(|error| RepositoryError::Validation(error.to_string()))?;
      sqlx::query(
        r#"
          INSERT INTO workspace_database_cell_values
            (row_id, field_id, value_json, database_id, updated_by, edit_revision, updated_at)
          VALUES ($1, $2, $3, (SELECT database_id FROM workspace_database_rows WHERE id = $1), $4, 1, now())
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
      .bind(updated_by)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_snapshot_sqlx_error)?;
    }
    Self::sync_relation_edges(tx, row_id, field_id, target_row_ids).await
  }

  pub(in crate::workspace_database) async fn sync_task_relation_edges(
    tx: &mut Transaction<'_, Postgres>,
    source_database_id: DatabaseId,
    source_row_id: DatabaseRowId,
    source_field_id: DatabaseFieldId,
    target_row_ids: &[DatabaseRowId],
  ) -> RepoResult<()> {
    // Unresolved legacy IDs stay in the canonical Cell for explicit repair.
    // The FK index cannot represent them; incompatible reciprocal config must
    // never turn a graph repair into a write to another field.
    let valid = sqlx::query_scalar::<_, DatabaseRowId>(
      "SELECT id FROM workspace_database_rows WHERE database_id=$1 AND id=ANY($2)",
    )
    .bind(source_database_id)
    .bind(target_row_ids)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let targets = target_row_ids
      .iter()
      .copied()
      .filter(|target| valid.contains(target))
      .collect::<Vec<_>>();
    Self::sync_relation_edges_with_context(
      tx,
      source_database_id,
      source_row_id,
      source_field_id,
      source_database_id,
      &targets,
    )
    .await
  }

  /// Keeps the indexed edge projection and optional reciprocal field in the same
  /// SQL transaction as the canonical cell JSON. The application layer validates
  /// ACLs and reciprocal config shape before this persistence invariant runs.
  pub(in crate::workspace_database) async fn sync_relation_edges_and_reciprocals(
    tx: &mut Transaction<'_, Postgres>,
    source_row_id: DatabaseRowId,
    source_field_id: DatabaseFieldId,
    target_row_ids: &[DatabaseRowId],
    updated_by: UserId,
  ) -> RepoResult<()> {
    if let Some(database) = Self::authoritative_task_relation_cell(tx, source_row_id, source_field_id).await? {
      return Self::sync_task_relation_edges(tx, database, source_row_id, source_field_id, target_row_ids).await;
    }
    let (source_database_id, config) =
      Self::load_relation_projection_context(tx, source_row_id, source_field_id).await?;
    if let Some(reciprocal) = config.reciprocal_field_id {
      let previous = Self::relation_targets_from_edges(tx, source_row_id, source_field_id).await?;
      for target in target_row_ids.iter().filter(|target| !previous.contains(target)) {
        if Self::authoritative_task_relation_cell(tx, *target, reciprocal)
          .await?
          .is_some()
        {
          return Err(RepositoryError::Validation(
            DatabaseTaskRelationReason::IncompatibleRoleConfiguration.validation_message(),
          ));
        }
      }
    }
    let previous_target_row_ids = Self::relation_targets_from_edges(tx, source_row_id, source_field_id).await?;
    Self::sync_relation_edges_with_context(
      tx,
      source_database_id,
      source_row_id,
      source_field_id,
      config.target_database_id,
      target_row_ids,
    )
    .await?;

    let Some(reciprocal_field_id) = config.reciprocal_field_id else {
      return Ok(());
    };
    let mut impacted_row_ids = previous_target_row_ids;
    for target_row_id in target_row_ids {
      if !impacted_row_ids.contains(target_row_id) {
        impacted_row_ids.push(*target_row_id);
      }
    }
    for target_row_id in impacted_row_ids {
      let should_link_back = target_row_ids.contains(&target_row_id);
      let (mut reciprocal_targets, reciprocal_graph) =
        Self::reciprocal_targets_for_update(tx, target_row_id, reciprocal_field_id).await?;
      let previous_reciprocal_targets = reciprocal_targets.clone();
      reciprocal_targets.retain(|id| *id != source_row_id);
      if should_link_back {
        reciprocal_targets.push(source_row_id);
      }
      if reciprocal_graph && reciprocal_targets == previous_reciprocal_targets {
        continue;
      }
      Self::write_relation_cell_without_mirror(tx, target_row_id, reciprocal_field_id, &reciprocal_targets, updated_by)
        .await?;
      Self::mark_rollups_stale_for_relation_change(tx, target_row_id, reciprocal_field_id).await?;
    }
    Ok(())
  }

  pub(in crate::workspace_database) async fn clear_relation_edges_and_reciprocals(
    tx: &mut Transaction<'_, Postgres>,
    source_row_id: DatabaseRowId,
    source_field_id: DatabaseFieldId,
    updated_by: UserId,
  ) -> RepoResult<()> {
    let is_parent = Self::authoritative_task_relation_cell(tx, source_row_id, source_field_id)
      .await?
      .is_some();
    if is_parent {
      sqlx::query("DELETE FROM workspace_database_relation_edges WHERE source_row_id=$1 AND source_field_id=$2")
        .bind(source_row_id)
        .bind(source_field_id)
        .execute(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?;
      return Ok(());
    }
    let Some((_source_database_id, config)) =
      Self::maybe_load_relation_projection_context(tx, source_row_id, source_field_id).await?
    else {
      return Ok(());
    };
    let previous_target_row_ids = Self::relation_targets_from_edges(tx, source_row_id, source_field_id).await?;
    sqlx::query("DELETE FROM workspace_database_relation_edges WHERE source_row_id = $1 AND source_field_id = $2")
      .bind(source_row_id)
      .bind(source_field_id)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;

    let Some(reciprocal_field_id) = config.reciprocal_field_id else {
      return Ok(());
    };
    for target_row_id in previous_target_row_ids {
      let (mut reciprocal_targets, reciprocal_graph) =
        Self::reciprocal_targets_for_update(tx, target_row_id, reciprocal_field_id).await?;
      let previous_reciprocal_targets = reciprocal_targets.clone();
      reciprocal_targets.retain(|id| *id != source_row_id);
      if reciprocal_graph && reciprocal_targets == previous_reciprocal_targets {
        continue;
      }
      Self::write_relation_cell_without_mirror(tx, target_row_id, reciprocal_field_id, &reciprocal_targets, updated_by)
        .await?;
      Self::mark_rollups_stale_for_relation_change(tx, target_row_id, reciprocal_field_id).await?;
    }
    Ok(())
  }
}
