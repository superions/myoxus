use super::*;

pub(super) async fn assert_database_manager(
  permission: &Arc<PermissionService>,
  actor: UserId,
  database: &Database,
) -> DatabaseResult<()> {
  assert_database_manager_principal(permission, actor, database.workspace_id, database.created_by).await
}

pub(super) async fn assert_database_manager_principal(
  permission: &Arc<PermissionService>,
  actor: UserId,
  workspace_id: WorkspaceId,
  created_by: Option<UserId>,
) -> DatabaseResult<()> {
  if created_by == Some(actor) {
    return Ok(());
  }
  let role = permission
    .get_effective_workspace_role(actor, workspace_id)
    .await
    .ok()
    .flatten()
    .unwrap_or(WorkspaceRole::External);
  if role >= WorkspaceRole::Manager {
    Ok(())
  } else {
    Err(DatabaseServiceError::new(
      ERR_FORBIDDEN,
      "database metadata action forbidden",
    ))
  }
}

pub(super) async fn assert_workspace(
  permission: &Arc<PermissionService>,
  actor: UserId,
  workspace_id: WorkspaceId,
  action: WorkspaceAction,
) -> DatabaseResult<()> {
  permission
    .assert(
      &WorkspaceResource {
        user_id: actor,
        workspace_id,
      },
      action,
    )
    .await
    .map_err(|_| DatabaseServiceError::new(ERR_FORBIDDEN, "database action forbidden"))
}

pub(super) async fn get_database(
  permission: &Arc<PermissionService>,
  schema_repo: &Arc<dyn DatabaseDefinitionRepository>,
  actor: UserId,
  database_id: DatabaseId,
) -> DatabaseResult<DatabaseRecord> {
  let record = schema_repo
    .get_database(database_id)
    .await?
    .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database not found"))?;
  assert_workspace(permission, actor, record.database.workspace_id, WorkspaceAction::Read).await?;
  Ok(record)
}

/// Check blocker identity before generic Relation validation while retaining native cardinality limits.
pub(super) async fn validate_blocked_by_cell_input(
  limits: &DatabaseLimits,
  row_repo: &Arc<dyn DatabaseEditingRepository>,
  record: &DatabaseRecord,
  row_ids: &[DatabaseRowId],
  field: &DatabaseField,
  value: &DatabaseCellValueData,
  creating_kind: Option<DatabaseRowKind>,
) -> DatabaseResult<bool> {
  let iter = || {
    record
      .field_roles
      .iter()
      .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id))
  };
  let other_owner = |kind| task_blocked_by_field_has_other_kind_owner(field.id, kind, iter());
  if creating_kind.is_some_and(|kind| other_owner(kind)) {
    return Ok(false);
  }
  let mut sources = Vec::with_capacity(row_ids.len());
  for id in row_ids {
    sources.push(row_repo.get_row(*id).await?);
  }
  if !sources.is_empty()
    && sources
      .iter()
      .all(|row| row.as_ref().is_some_and(|row| other_owner(row.row.row_kind)))
  {
    return Ok(false);
  }
  let DatabaseCellValueData::Relation(targets) = value else {
    return Err(DatabaseTaskRelationReason::IncompatibleRoleConfiguration.into());
  };
  let only_removal = !row_ids.is_empty()
    && sources.iter().all(|row| {
      let previous = row
        .as_ref()
        .and_then(|row| row.cells.iter().find(|cell| cell.field_id == field.id))
        .and_then(|cell| {
          if let DatabaseCellValueData::Relation(ids) = &cell.value {
            Some(ids.as_slice())
          } else {
            None
          }
        })
        .unwrap_or_default();
      task_relation_edges_only_removed(previous, targets)
    });
  if targets.is_empty() || only_removal {
    return Ok(true);
  }
  if !record.field_roles.iter().any(|role| {
    role.role_key == "task.blockedBy" && role.field_id == field.id && role.row_kind_scope.as_deref() == Some("task")
  }) || !task_blocked_by_config_compatible(record.database.id, &field.config)
  {
    return Err(DatabaseTaskRelationReason::IncompatibleRoleConfiguration.into());
  }
  if targets.iter().collect::<HashSet<_>>().len() != targets.len() {
    return Err(DatabaseTaskRelationReason::DuplicateTargets.into());
  }
  if targets.iter().any(|target| row_ids.contains(target)) {
    return Err(DatabaseTaskRelationReason::SelfBlockedBy.into());
  }
  for target in targets {
    let target = row_repo
      .get_row(*target)
      .await?
      .ok_or_else(|| DatabaseServiceError::from(DatabaseTaskRelationReason::UnavailableTarget))?;
    if target.row.database_id != record.database.id {
      return Err(DatabaseTaskRelationReason::ForeignDatabase.into());
    }
    if target.row.deleted_at.is_some() {
      return Err(DatabaseTaskRelationReason::UnavailableTarget.into());
    }
    if target.row.row_kind != DatabaseRowKind::Task {
      return Err(DatabaseTaskRelationReason::WrongRowKind.into());
    }
  }
  // Preserve configured native cardinality, but keep typed graph reasons and
  // explicit legacy subset repair ahead of generic Relation validation.
  crate::database::editing::rules::validate_cell_value(field, value, &limits)?;
  Ok(true)
}

/// Preserve typed Parent-role errors before generic Relation validation; pure removals may repair old edges.
pub(super) async fn validate_parent_cell_input(
  limits: &DatabaseLimits,
  row_repo: &Arc<dyn DatabaseEditingRepository>,
  record: &DatabaseRecord,
  row_ids: &[DatabaseRowId],
  field: &DatabaseField,
  value: &DatabaseCellValueData,
  creating_kind: Option<DatabaseRowKind>,
) -> DatabaseResult<bool> {
  if record.database.profile_kind == DatabaseProfileKind::Project
    && task_blocked_by_owns_cell(
      field,
      creating_kind.unwrap_or(DatabaseRowKind::Task),
      &record.field_roles,
    )
  {
    return validate_blocked_by_cell_input(limits, row_repo, record, row_ids, field, value, creating_kind).await;
  }
  if record.database.profile_kind != DatabaseProfileKind::Project
    || field.field_type != DatabaseFieldType::Relation
    || task_parent_has_conflicting_task_role(
      field.id,
      record
        .field_roles
        .iter()
        .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id)),
    )
    || task_parent_field(
      record
        .field_roles
        .iter()
        .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id)),
    ) != Some(field.id)
  {
    return Ok(false);
  }
  let has_other_owner = |kind| {
    task_parent_field_has_other_kind_owner(
      field.id,
      kind,
      record
        .field_roles
        .iter()
        .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id)),
    )
  };
  if creating_kind.is_some_and(|kind| has_other_owner(kind)) {
    return Ok(false);
  }
  let mut source_rows = Vec::with_capacity(row_ids.len());
  for id in row_ids {
    source_rows.push(row_repo.get_row(*id).await?);
  }
  if !source_rows.is_empty()
    && source_rows
      .iter()
      .all(|row| row.as_ref().is_some_and(|row| has_other_owner(row.row.row_kind)))
  {
    return Ok(false);
  }
  let DatabaseCellValueData::Relation(targets) = value else {
    return Err(DatabaseTaskRelationReason::IncompatibleRoleConfiguration.into());
  };
  if targets.is_empty() {
    return Ok(true);
  }
  let mut only_removal = !row_ids.is_empty();
  for row in &source_rows {
    let previous = row
      .as_ref()
      .and_then(|row| row.cells.iter().find(|cell| cell.field_id == field.id))
      .and_then(|cell| match &cell.value {
        DatabaseCellValueData::Relation(targets) => Some(targets.as_slice()),
        _ => None,
      })
      .unwrap_or_default();
    if !task_relation_edges_only_removed(previous, targets) {
      only_removal = false;
    }
  }
  if only_removal {
    return Ok(true);
  }
  if !record.field_roles.iter().any(|role| {
    role.role_key == "task.parent" && role.field_id == field.id && role.row_kind_scope.as_deref() == Some("task")
  }) || field.field_type != DatabaseFieldType::Relation
    || !task_parent_config_compatible(record.database.id, &field.config)
  {
    return Err(DatabaseTaskRelationReason::IncompatibleRoleConfiguration.into());
  }
  if targets.len() > 1 {
    return Err(DatabaseTaskRelationReason::MultipleParents.into());
  }
  if row_ids.contains(&targets[0]) {
    return Err(DatabaseTaskRelationReason::SelfParent.into());
  }
  let target = row_repo
    .get_row(targets[0])
    .await?
    .ok_or_else(|| DatabaseServiceError::from(DatabaseTaskRelationReason::UnavailableTarget))?;
  if target.row.database_id != record.database.id {
    return Err(DatabaseTaskRelationReason::ForeignDatabase.into());
  }
  if target.row.deleted_at.is_some() {
    return Err(DatabaseTaskRelationReason::UnavailableTarget.into());
  }
  if target.row.row_kind != DatabaseRowKind::Task {
    return Err(DatabaseTaskRelationReason::WrongRowKind.into());
  }
  Ok(true)
}

pub(super) async fn validate_relation_field_config(
  permission: &Arc<PermissionService>,
  schema_repo: &Arc<dyn DatabaseDefinitionRepository>,
  actor: UserId,
  source_database: &Database,
  source_field_id: DatabaseFieldId,
  config: &DatabaseFieldConfig,
) -> DatabaseResult<()> {
  let DatabaseFieldConfig::Relation(config) = config else {
    return Ok(());
  };
  let target = get_database(permission, schema_repo, actor, config.target_database_id).await?;
  if target.database.workspace_id != source_database.workspace_id {
    return Err(DatabaseServiceError::new(
      ERR_RELATION_TARGET_DATABASE_INVALID,
      "relation target database must be in the same workspace",
    ));
  }
  if let Some(reciprocal_field_id) = config.reciprocal_field_id {
    let Some(reciprocal_field) = target.fields.iter().find(|field| field.id == reciprocal_field_id) else {
      return Err(DatabaseServiceError::new(
        ERR_RELATION_RECIPROCAL_INVALID,
        "reciprocal field does not exist in target database",
      ));
    };
    let DatabaseFieldConfig::Relation(reciprocal_config) = &reciprocal_field.config else {
      return Err(DatabaseServiceError::new(
        ERR_RELATION_RECIPROCAL_INVALID,
        "reciprocal field must also be a relation field",
      ));
    };
    if reciprocal_config.target_database_id != source_database.id {
      return Err(DatabaseServiceError::new(
        ERR_RELATION_RECIPROCAL_INVALID,
        "reciprocal field must target the source database",
      ));
    }
    if let Some(back_reference_field_id) = reciprocal_config.reciprocal_field_id
      && back_reference_field_id != source_field_id
    {
      return Err(DatabaseServiceError::new(
        ERR_RELATION_RECIPROCAL_INVALID,
        "reciprocal field must point back to the source relation field",
      ));
    }
  }
  Ok(())
}

pub(super) async fn validate_rollup_field_config(
  permission: &Arc<PermissionService>,
  schema_repo: &Arc<dyn DatabaseDefinitionRepository>,
  actor: UserId,
  source_database: &Database,
  fields: &[DatabaseField],
  config: &DatabaseFieldConfig,
) -> DatabaseResult<()> {
  let DatabaseFieldConfig::Rollup(config) = config else {
    return Ok(());
  };
  let Some(source_relation_field) = fields.iter().find(|field| field.id == config.source_relation_field_id) else {
    return Err(DatabaseServiceError::new(
      ERR_ROLLUP_SOURCE_RELATION_INVALID,
      "rollup source relation field does not exist",
    ));
  };
  let DatabaseFieldConfig::Relation(source_relation_config) = &source_relation_field.config else {
    return Err(DatabaseServiceError::new(
      ERR_ROLLUP_SOURCE_RELATION_INVALID,
      "rollup source field must be a relation field",
    ));
  };
  let target_record = get_database(
    permission,
    schema_repo,
    actor,
    source_relation_config.target_database_id,
  )
  .await?;
  if target_record.database.workspace_id != source_database.workspace_id {
    return Err(DatabaseServiceError::new(
      ERR_ROLLUP_SOURCE_RELATION_INVALID,
      "rollup source relation must target a database in the same workspace",
    ));
  }
  let Some(target_field) = target_record
    .fields
    .iter()
    .find(|field| field.id == config.target_field_id)
  else {
    return Err(DatabaseServiceError::new(
      ERR_ROLLUP_TARGET_FIELD_INVALID,
      "rollup target field does not exist in the relation target database",
    ));
  };
  if target_field.field_type == DatabaseFieldType::Rollup {
    return Err(DatabaseServiceError::new(
      ERR_ROLLUP_TARGET_FIELD_INVALID,
      "rollup target field cannot be another rollup",
    ));
  }
  if !crate::database::definition::rules::aggregate_accepts_target(config.aggregate, target_field.field_type) {
    return Err(DatabaseServiceError::new(
      ERR_ROLLUP_AGGREGATE_INVALID,
      "rollup aggregate is not compatible with the target field type",
    ));
  }
  Ok(())
}

pub(super) async fn validate_user_cell_membership(
  workspace_store: &Arc<dyn WorkspaceStore>,
  workspace_id: WorkspaceId,
  value: &DatabaseCellValueData,
) -> DatabaseResult<()> {
  match value {
    DatabaseCellValueData::User(user_id)
      if !workspace_store
        .has_accepted_member(workspace_id, *user_id)
        .await
        .map_err(workspace_lookup_error)? =>
    {
      return Err(DatabaseServiceError::new(
        ERR_CELL_INVALID,
        "user cell values must reference workspace members",
      ));
    }
    DatabaseCellValueData::Users(user_ids) => {
      for user_id in user_ids {
        if !workspace_store
          .has_accepted_member(workspace_id, *user_id)
          .await
          .map_err(workspace_lookup_error)?
        {
          return Err(DatabaseServiceError::new(
            ERR_CELL_INVALID,
            "users cell values must reference workspace members",
          ));
        }
      }
    }
    _ => {}
  }
  Ok(())
}

pub(super) async fn validate_document_link_value(
  doc_service: &DocService,
  workspace_id: WorkspaceId,
  value: &DatabaseDocumentLinkValue,
) -> DatabaseResult<()> {
  if doc_service
    .get_metadata(value.doc_id)
    .await
    .map_err(workspace_lookup_error)?
    .is_some_and(|doc| doc.deleted_at.is_none() && doc.workspace_id == Some(value.workspace_id.unwrap_or(workspace_id)))
  {
    Ok(())
  } else {
    Err(DatabaseServiceError::new(
      ERR_CELL_INVALID,
      "document link must reference an existing document in its declared workspace",
    ))
  }
}

/// A former Database is a navigation hint only for a native managed Task moved
/// within the same authorized workspace. Generic Rows never acquire redirects.
pub(super) async fn row_read_owner(
  permission: &Arc<PermissionService>,
  schema_repo: &Arc<dyn DatabaseDefinitionRepository>,
  row_repo: &Arc<dyn DatabaseEditingRepository>,
  actor: UserId,
  database_hint: DatabaseId,
  row_id: DatabaseRowId,
  expected_workspace: Option<WorkspaceId>,
) -> DatabaseResult<Option<(DatabaseRecord, DatabaseRowRecord)>> {
  let Some(hint) = schema_repo.get_database_for_lifecycle(database_hint).await? else {
    return Ok(None);
  };
  if expected_workspace.is_some_and(|workspace| workspace != hint.database.workspace_id) {
    return Ok(None);
  }
  assert_workspace(permission, actor, hint.database.workspace_id, WorkspaceAction::Read).await?;
  let Some(row) = row_repo.get_row(row_id).await? else {
    return Ok(None);
  };
  let current = if row.row.database_id == database_hint {
    hint
  } else {
    if row.row.row_kind != DatabaseRowKind::Task || hint.database.profile_kind != DatabaseProfileKind::Project {
      return Ok(None);
    }
    let Some(current) = schema_repo.get_database_for_lifecycle(row.row.database_id).await? else {
      return Ok(None);
    };
    if current.database.workspace_id != hint.database.workspace_id
      || current.database.profile_kind != DatabaseProfileKind::Project
    {
      return Ok(None);
    }
    current
  };
  assert_workspace(permission, actor, current.database.workspace_id, WorkspaceAction::Read).await?;
  Ok(Some((current, row)))
}
