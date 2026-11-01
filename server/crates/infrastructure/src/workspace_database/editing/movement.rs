// SPDX-License-Identifier: AGPL-3.0-or-later

//! Identity-preserving Task movement. Database/Field/Row locks and deferred composite FKs are one transaction.
use super::*;
use crate::workspace_automation::PgWorkspaceAutomationRepository;

fn bounded_task_move_selection(selection_count: usize, source: DatabaseId, target: DatabaseId) -> bool {
  (1..=100).contains(&selection_count) && source != target
}

impl PgDatabaseRepository {
  fn validate_task_move_selection(input: &DatabaseTaskMoveInput) -> RepoResult<()> {
    if !bounded_task_move_selection(
      input.selection.len(),
      input.source_database_id,
      input.target_database_id,
    ) {
      return Err(RepositoryError::Validation("INVALID_BOUNDED_SELECTION".into()));
    }
    Ok(())
  }

  async fn task_move_records(
    tx: &mut Transaction<'_, Postgres>,
    input: &DatabaseTaskMoveInput,
    catalog: &myoxus_application::database::DatabaseStarterTemplateCatalog,
  ) -> RepoResult<(DatabaseRecord, DatabaseRecord)> {
    let mut records = Vec::new();
    for id in [input.source_database_id, input.target_database_id] {
      let row=sqlx::query("SELECT d.*,COALESCE(p.profile_kind,'generic') AS profile_kind,p.structure_preset AS profile_structure_preset,COALESCE(p.config_json,'{}'::jsonb) AS profile_config FROM workspace_databases d LEFT JOIN database_profiles p ON p.database_id=d.id WHERE d.id=$1 AND d.workspace_id=$2")
        .bind(id).bind(input.workspace_id).fetch_optional(&mut **tx).await.map_err(Self::map_sqlx_error)?.ok_or(RepositoryError::NotFound("database"))?;
      let mut database = Self::map_database(row)?;
      if let Some(installed) = database.managed_installation.as_mut() {
        if !catalog
          .current_source(&installed.template_id)
          .is_some_and(|(version, digest)| version == installed.template_version && digest == installed.template_digest)
        {
          installed.readiness = DatabaseManagedSchemaReadiness::Unavailable;
          installed.reason_code = Some("MANAGED_SOURCE_UNAVAILABLE_ON_NODE".into());
        }
      }
      records.push(DatabaseRecord {
        database,
        fields: Self::list_fields_for(&mut **tx, id).await?,
        views: Self::list_views_for(&mut **tx, id).await?,
        field_roles: Self::list_field_roles_for(&mut **tx, id).await?,
        view_roles: Self::list_view_roles_for(&mut **tx, id).await?,
        row_count: 0,
        managed_schema: None,
      });
    }
    let target = records.pop().expect("target");
    let source = records.pop().expect("source");
    Ok((source, target))
  }

  async fn task_move_authority(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    input: &DatabaseTaskMoveInput,
  ) -> RepoResult<()> {
    // This is the same accepted membership authority as the native workspace
    // permission store, held through commit so revocation cannot cross the write.
    let member=sqlx::query("SELECT m.user_id FROM workspace_memberships m JOIN workspaces w ON w.id=m.workspace_id AND w.lifecycle_state='active' AND w.deleted_at IS NULL JOIN users u ON u.id=m.user_id AND u.status='active' WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.status='Accepted' AND m.role IN ('Owner','Admin','Manager','Collaborator') FOR SHARE OF m,w,u")
      .bind(input.workspace_id).bind(actor).fetch_optional(&mut **tx).await.map_err(Self::map_sqlx_error)?;
    if member.is_none() {
      return Err(RepositoryError::Validation("task move permission unavailable".into()));
    }
    Ok(())
  }

  async fn task_move_preview_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    input: DatabaseTaskMoveInput,
    source: &DatabaseRecord,
    target: &DatabaseRecord,
  ) -> RepoResult<DatabaseTaskMovePreview> {
    let mut reasons = Vec::new();
    if !bounded_task_move_selection(
      input.selection.len(),
      input.source_database_id,
      input.target_database_id,
    ) {
      reasons.push("INVALID_BOUNDED_SELECTION".into());
    }
    if source.database.workspace_id != input.workspace_id || target.database.workspace_id != input.workspace_id {
      reasons.push("TARGET_WORKSPACE_MISMATCH".into());
    }
    if source.database.system_role != Some(DatabaseSystemRole::WorkspaceTasks)
      || target.database.system_role.is_some()
      || target.database.profile_kind != DatabaseProfileKind::Project
    {
      reasons.push("REQUIRES_WORKSPACE_TASKS_TO_PROJECT".into());
    }
    if source.database.deleted_at.is_some() || target.database.deleted_at.is_some() {
      reasons.push("CONTAINER_UNAVAILABLE".into());
    }
    for (record, schema, edit) in [
      (source, input.source_schema_revision, input.source_edit_revision),
      (target, input.target_schema_revision, input.target_edit_revision),
    ] {
      if record
        .database
        .managed_installation
        .as_ref()
        .is_none_or(|state| state.readiness != DatabaseManagedSchemaReadiness::Ready || state.schema_revision != schema)
      {
        reasons.push("SCHEMA_REVISION_CHANGED_OR_UNAVAILABLE".into());
      }
      if record.database.edit_revision != edit {
        reasons.push("CONTAINER_REVISION_CHANGED".into());
      }
    }
    if !reasons.is_empty() {
      return Ok(DatabaseTaskMovePreview {
        input,
        eligible: false,
        reasons,
        required_related_tasks: Vec::new(),
        boundaries: Vec::new(),
        allocates_display_ids: true,
      });
    }
    let ids = input
      .selection
      .iter()
      .map(|selection| selection.row_id)
      .collect::<BTreeSet<_>>();
    if ids.len() != input.selection.len() {
      reasons.push("DUPLICATE_SELECTION".into());
    }
    let row_ids = ids.iter().copied().collect::<Vec<_>>();
    let rows=sqlx::query("SELECT id,database_id,row_kind,deleted_at,edit_revision,created_by_job_id FROM workspace_database_rows WHERE id=ANY($1) ORDER BY id")
      .bind(&row_ids).fetch_all(&mut **tx).await.map_err(Self::map_sqlx_error)?;
    if rows.len() != ids.len() {
      reasons.push("SELECTED_TASK_UNAVAILABLE".into());
    }
    let mut import_jobs = BTreeSet::new();
    for row in rows {
      let id: Uuid = row.get("id");
      if let Some(job) = row.get::<Option<Uuid>, _>("created_by_job_id") {
        import_jobs.insert(job);
      }
      let selected = input
        .selection
        .iter()
        .find(|selection| selection.row_id == id)
        .expect("selected Row");
      if row.get::<Uuid, _>("database_id") != input.source_database_id
        || row.get::<String, _>("row_kind") != "task"
        || row.get::<Option<DateTime<Utc>>, _>("deleted_at").is_some()
      {
        reasons.push("SELECTED_TASK_OWNER_OR_LIFECYCLE_CHANGED".into());
      }
      if row.get::<i64, _>("edit_revision") != selected.expected_edit_revision {
        reasons.push("ROW_REVISION_CHANGED".into());
      }
    }
    if !reasons.is_empty() {
      return Ok(DatabaseTaskMovePreview {
        input,
        eligible: false,
        reasons: vec!["SELECTED_TASK_UNAVAILABLE_OR_CHANGED".into()],
        required_related_tasks: Vec::new(),
        boundaries: Vec::new(),
        allocates_display_ids: true,
      });
    }
    if !import_jobs.is_empty() {
      let jobs = sqlx::query("SELECT id,status FROM database_import_jobs WHERE id=ANY($1) ORDER BY id FOR SHARE")
        .bind(import_jobs.into_iter().collect::<Vec<_>>())
        .fetch_all(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?;
      if jobs.iter().any(|job| {
        !matches!(
          job.get::<String, _>("status").as_str(),
          "succeeded" | "failed" | "cancelled"
        )
      }) {
        return Ok(DatabaseTaskMovePreview {
          input,
          eligible: false,
          reasons: vec!["TASK_IMPORT_IN_PROGRESS".into()],
          required_related_tasks: Vec::new(),
          boundaries: Vec::new(),
          allocates_display_ids: true,
        });
      }
    }
    let revisions = Self::list_cell_revisions_for_rows_in(&mut **tx, &row_ids).await?;
    for selected in &input.selection {
      let actual = revisions
        .iter()
        .filter(|revision| revision.row_id == selected.row_id)
        .map(|revision| (revision.field_id, revision.edit_revision))
        .collect::<BTreeMap<_, _>>();
      if actual != selected.cell_revisions {
        reasons.push("CELL_REVISIONS_CHANGED".into());
      }
    }
    let edges=sqlx::query("SELECT edge.source_row_id,edge.source_field_id,edge.target_row_id,related.deleted_at,related.row_kind,related.database_id,related_database.workspace_id AS related_workspace_id FROM workspace_database_relation_edges edge JOIN workspace_database_rows related ON related.id=CASE WHEN edge.source_row_id=ANY($1) THEN edge.target_row_id ELSE edge.source_row_id END JOIN workspace_databases related_database ON related_database.id=related.database_id WHERE (edge.source_row_id=ANY($1))<>(edge.target_row_id=ANY($1)) ORDER BY edge.source_row_id,edge.source_field_id,edge.target_row_id LIMIT 501")
      .bind(&row_ids).fetch_all(&mut **tx).await.map_err(Self::map_sqlx_error)?;
    let mut required = BTreeSet::new();
    let mut boundaries = Vec::new();
    if edges.len() > 500 {
      reasons.push("GRAPH_BOUNDARY_LIMIT".into());
    }
    for edge in edges {
      if edge.get::<Uuid, _>("related_workspace_id") != input.workspace_id {
        reasons.push("EXTERNAL_RELATION_REQUIRES_REPAIR".into());
        continue;
      }
      let from: Uuid = edge.get("source_row_id");
      let to: Uuid = edge.get("target_row_id");
      let inbound = !ids.contains(&from);
      let related = if inbound { from } else { to };
      if edge.get::<Uuid, _>("database_id") == input.source_database_id && edge.get::<String, _>("row_kind") == "task" {
        required.insert(related);
      } else {
        reasons.push("EXTERNAL_RELATION_REQUIRES_REPAIR".into());
      }
      boundaries.push(DatabaseTaskMoveBoundary {
        row_id: if inbound { to } else { from },
        field_id: edge.get("source_field_id"),
        related_row_id: related,
        inbound,
        recoverable_trash: edge.get::<Option<DateTime<Utc>>, _>("deleted_at").is_some(),
      });
    }
    if !boundaries.is_empty() {
      reasons.push("RELATED_TASKS_OR_REFERENCES_REQUIRE_EXPLICIT_REPAIR".into());
    }
    for (role, id, kind) in [
      ("task.phase", input.phase_row_id, "phase"),
      ("task.milestone", input.milestone_row_id, "milestone"),
    ] {
      if let Some(id) = id {
        let supported = target
          .field_roles
          .iter()
          .any(|binding| binding.role_key == role && binding.row_kind_scope.as_deref() == Some("task"));
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_database_rows WHERE id=$1 AND database_id=$2 AND row_kind=$3 AND deleted_at IS NULL)")
          .bind(id).bind(input.target_database_id).bind(kind).fetch_one(&mut **tx).await.map_err(Self::map_sqlx_error)?;
        if !supported || !exists {
          reasons.push("TARGET_STRUCTURE_MEMBERSHIP_UNAVAILABLE".into());
        }
      }
    }
    reasons.sort();
    reasons.dedup();
    Ok(DatabaseTaskMovePreview {
      input,
      eligible: reasons.is_empty(),
      reasons,
      required_related_tasks: required.into_iter().collect(),
      boundaries,
      allocates_display_ids: true,
    })
  }

  pub(in crate::workspace_database) async fn task_move_preview(
    &self,
    actor: UserId,
    input: DatabaseTaskMoveInput,
  ) -> RepoResult<DatabaseTaskMovePreview> {
    Self::validate_task_move_selection(&input)?;
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    Self::task_move_authority(&mut tx, actor, &input).await?;
    let (source, target) = Self::task_move_records(&mut tx, &input, &self.database_templates).await?;
    Self::task_move_preview_in_tx(&mut tx, input, &source, &target).await
  }

  pub(in crate::workspace_database) async fn task_move_commit(
    &self,
    actor: UserId,
    input: DatabaseTaskMoveInput,
  ) -> RepoResult<DatabaseTaskMoveResult> {
    // Bound caller-controlled lock arrays before acquiring any transaction or authority locks.
    Self::validate_task_move_selection(&input)?;
    let mut tx = self.begin_write().await?;
    Self::task_move_authority(&mut tx, actor, &input).await?;
    PgWorkspaceAutomationRepository::lock_document_review_tasks(
      &mut tx,
      &input.selection.iter().map(|row| row.row_id).collect::<Vec<_>>(),
    )
    .await?;
    let mut containers = vec![input.source_database_id, input.target_database_id];
    containers.sort();
    containers.dedup();
    sqlx::query("SELECT id FROM workspace_databases WHERE id=ANY($1) AND workspace_id=$2 ORDER BY id FOR UPDATE")
      .bind(&containers)
      .bind(input.workspace_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let (source, target) = Self::task_move_records(&mut tx, &input, &self.database_templates).await?;
    // Preserved role-managed facts are not user Cell edits. Acquire the native
    // graph policy for row admission without unlocking direct managed writes.
    let source_policy = Self::prepare_project_mutation(&mut tx, input.source_database_id, &[], true).await?;
    let target_policy = Self::prepare_project_mutation(&mut tx, input.target_database_id, &[], true).await?;
    sqlx::query("SELECT id FROM workspace_database_fields WHERE database_id=ANY($1) ORDER BY database_id,id FOR SHARE")
      .bind(&containers)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let mut row_ids = input.selection.iter().map(|row| row.row_id).collect::<Vec<_>>();
    row_ids.sort();
    sqlx::query("SELECT id FROM workspace_database_rows WHERE id=ANY($1) AND database_id=$2 ORDER BY id FOR UPDATE")
      .bind(&row_ids)
      .bind(input.source_database_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    sqlx::query(
      "SELECT row_id FROM workspace_database_cell_values WHERE row_id=ANY($1) AND database_id=$2 ORDER BY row_id,field_id FOR UPDATE",
    )
    .bind(&row_ids)
    .bind(input.source_database_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let preview = Self::task_move_preview_in_tx(&mut tx, input.clone(), &source, &target).await?;
    if !preview.eligible {
      return Err(RepositoryError::Validation(format!(
        "task move rejected: {}",
        preview.reasons.join(",")
      )));
    }
    let source_state = source.database.managed_installation.as_ref().expect("admitted source");
    let target_state = target.database.managed_installation.as_ref().expect("admitted target");
    let mut from = Vec::new();
    let mut to = Vec::new();
    for (key, id) in &source_state.field_bindings {
      let mapped = *target_state
        .field_bindings
        .get(key)
        .ok_or_else(|| RepositoryError::Validation("target does not accept common native Task field".into()))?;
      let field = source
        .fields
        .iter()
        .find(|field| field.id == *id)
        .ok_or(RepositoryError::NotFound("source field"))?;
      if !target
        .fields
        .iter()
        .any(|field_target| field_target.id == mapped && field_target.field_type == field.field_type)
      {
        return Err(RepositoryError::Validation("target common Task type mismatch".into()));
      }
      from.push(*id);
      to.push(mapped);
    }
    sqlx::query("SET CONSTRAINTS fk_workspace_database_cells_field_database,fk_workspace_database_cells_row_database,fk_workspace_database_relations_source_field_database,fk_workspace_database_relations_source_row_database,fk_workspace_database_relations_target_row_database,fk_database_row_reminders_field_database,fk_database_row_reminders_row_database DEFERRED")
      .execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    sqlx::query("SELECT set_config('myoxus.task_move','on',true)")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    sqlx::query("WITH ordered AS (SELECT id,row_number() OVER(ORDER BY position,id) AS n FROM workspace_database_rows WHERE id=ANY($1)),base AS(SELECT COALESCE(max(position),-1) AS n FROM workspace_database_rows WHERE database_id=$2) UPDATE workspace_database_rows row SET database_id=$2,position=(base.n+ordered.n)::int,edit_revision=row.edit_revision+1,updated_by=$3,updated_at=now() FROM ordered,base WHERE row.id=ordered.id AND row.database_id=$4")
      .bind(&row_ids).bind(input.target_database_id).bind(actor).bind(input.source_database_id).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    sqlx::query("UPDATE workspace_database_cell_values cell SET database_id=$3,field_id=mapped.target FROM unnest($1::uuid[],$2::uuid[]) mapped(source,target) WHERE cell.row_id=ANY($4) AND cell.field_id=mapped.source")
      .bind(&from).bind(&to).bind(input.target_database_id).bind(&row_ids).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    sqlx::query("UPDATE workspace_database_relation_edges edge SET source_database_id=$3,source_field_id=mapped.target FROM unnest($1::uuid[],$2::uuid[]) mapped(source,target) WHERE edge.source_row_id=ANY($4) AND edge.source_field_id=mapped.source")
      .bind(&from).bind(&to).bind(input.target_database_id).bind(&row_ids).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    sqlx::query("UPDATE workspace_database_relation_edges SET target_database_id=$1 WHERE target_row_id=ANY($2)")
      .bind(input.target_database_id)
      .bind(&row_ids)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    sqlx::query("UPDATE database_document_references SET database_id=$1 WHERE row_id=ANY($2)")
      .bind(input.target_database_id)
      .bind(&row_ids)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    sqlx::query("UPDATE database_document_references ref SET field_id=mapped.target FROM unnest($1::uuid[],$2::uuid[]) mapped(source,target) WHERE ref.row_id=ANY($3) AND ref.field_id=mapped.source")
      .bind(&from).bind(&to).bind(&row_ids).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    sqlx::query("UPDATE workspace_database_row_search SET database_id=$1 WHERE row_id=ANY($2)")
      .bind(input.target_database_id)
      .bind(&row_ids)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    for table in ["workspace_database_formula_values", "workspace_database_rollup_values"] {
      sqlx::query(&format!("UPDATE {table} projection SET database_id=$4,field_id=mapped.target,stale_state='stale',updated_at=now() FROM unnest($1::uuid[],$2::uuid[]) mapped(source,target) WHERE projection.row_id=ANY($3) AND projection.field_id=mapped.source"))
        .bind(&from).bind(&to).bind(&row_ids).bind(input.target_database_id).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    }
    let target_has_derived = target
      .fields
      .iter()
      .any(|field| matches!(field.field_type, DatabaseFieldType::Formula | DatabaseFieldType::Rollup));
    for row_id in &row_ids {
      for cell in Self::allocate_unique_id_cells(&mut tx, input.target_database_id, *row_id, actor).await? {
        sqlx::query("INSERT INTO workspace_database_cell_values(row_id,field_id,database_id,value_json,updated_by,updated_at,edit_revision) VALUES($1,$2,$3,$4,$5,now(),1) ON CONFLICT(row_id,field_id) DO UPDATE SET value_json=EXCLUDED.value_json,updated_by=EXCLUDED.updated_by,updated_at=now(),edit_revision=workspace_database_cell_values.edit_revision+1")
          .bind(*row_id).bind(cell.field_id).bind(input.target_database_id).bind(Self::map_cell_value_to_json(&cell.value)?).bind(actor).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
        if target_has_derived {
          Self::mark_formulas_stale_for_cell_change(&mut tx, *row_id, cell.field_id).await?;
          Self::mark_rollups_stale_for_target_cell_change(&mut tx, *row_id, cell.field_id).await?;
        }
      }
      for (role, value) in [
        ("task.phase", input.phase_row_id),
        ("task.milestone", input.milestone_row_id),
      ] {
        if let Some(value) = value {
          let field = target
            .field_roles
            .iter()
            .find(|binding| binding.role_key == role && binding.row_kind_scope.as_deref() == Some("task"))
            .expect("admitted membership")
            .field_id;
          sqlx::query("INSERT INTO workspace_database_cell_values(row_id,field_id,database_id,value_json,updated_by,edit_revision) VALUES($1,$2,$3,$4,$5,1)")
            .bind(*row_id).bind(field).bind(input.target_database_id).bind(serde_json::json!([value])).bind(actor).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
          Self::sync_relation_edges_with_context(
            &mut tx,
            input.target_database_id,
            *row_id,
            field,
            input.target_database_id,
            &[value],
          )
          .await?;
          if target_has_derived {
            Self::mark_rollups_stale_for_relation_change(&mut tx, *row_id, field).await?;
            Self::mark_rollups_stale_for_target_cell_change(&mut tx, *row_id, field).await?;
            Self::mark_formulas_stale_for_cell_change(&mut tx, *row_id, field).await?;
          }
        }
      }
    }
    Self::remap_moved_reminders(&mut tx, &from, &to, input.target_database_id, &row_ids).await?;
    for row_id in &row_ids {
      if !Self::task_reminder_is_open(&mut tx, input.target_database_id, *row_id).await? {
        Self::cancel_moved_closed_task_reminders(&mut tx, *row_id).await?;
      }
    }
    if let Some(policy) = source_policy.as_ref() {
      Self::validate_project_hierarchy(&mut tx, input.source_database_id, policy).await?;
    }
    if let Some(policy) = target_policy.as_ref() {
      Self::validate_project_hierarchy(&mut tx, input.target_database_id, policy).await?;
    }
    sqlx::query("SET CONSTRAINTS ALL IMMEDIATE")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    PgWorkspaceAutomationRepository::invalidate_document_review_tasks(&mut tx, &row_ids).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    let mut rows = Vec::new();
    for id in row_ids {
      rows.push(self.get_row(id).await?.ok_or(RepositoryError::NotFound("moved Task"))?);
    }
    Ok(DatabaseTaskMoveResult {
      source_database_id: input.source_database_id,
      target_database_id: input.target_database_id,
      rows,
    })
  }
}
