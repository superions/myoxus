use super::*;

impl DatabaseDefinitionService {
  #[instrument(
    skip(self, name, config),
    fields(actor_id = %actor, database_id = %database_id, field_id = tracing::field::Empty, field_type = tracing::field::Empty, required)
  )]
  pub async fn create_field(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    name: String,
    field_type: DatabaseFieldType,
    config: DatabaseFieldConfig,
    required: bool,
  ) -> DatabaseResult<DatabaseField> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    managed_schema::assert_structure_edit(&record)?;
    if record.fields.len() >= self.limits.max_fields_per_database {
      return Err(DatabaseServiceError::new(
        ERR_LIMIT_EXCEEDED,
        "database field limit exceeded",
      ));
    }
    if field_type == DatabaseFieldType::Title {
      return Err(DatabaseServiceError::new(
        ERR_FIELD_INVALID,
        "title field is created with the database and cannot be added later",
      ));
    }
    let name = crate::database::definition::rules::validate_title(&name)?;
    let mut config = config;
    crate::database::definition::rules::validate_field_config(field_type, &config)?;
    let field_id = Uuid::new_v4();
    let span = tracing::Span::current();
    span.record("field_id", tracing::field::display(field_id));
    span.record("field_type", field_type.as_str());
    access::validate_relation_field_config(
      &self.permission,
      &self.schema_repo,
      actor,
      &record.database,
      field_id,
      &config,
    )
    .await?;
    access::validate_rollup_field_config(
      &self.permission,
      &self.schema_repo,
      actor,
      &record.database,
      &record.fields,
      &config,
    )
    .await?;
    let formula_analysis =
      crate::database::definition::rules::validate_formula_field_config(&record.fields, Some(field_id), &mut config)?;
    let now = Utc::now();
    let field = self
      .schema_repo
      .create_field(
        DatabaseField {
          id: field_id,
          database_id,
          name,
          field_type,
          config,
          position: record.fields.iter().map(|field| field.position).max().unwrap_or(-1) + 1,
          required,
          edit_revision: 1,
          created_at: now,
          updated_at: now,
        },
        DatabaseEditPrecondition::default()
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id),
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    if let Some(analysis) = formula_analysis {
      self
        .projection_repo
        .replace_formula_dependencies(field_id, analysis.dependency_field_ids)
        .await?;
    }
    info!(field_id = %field_id, field_type = field_type.as_str(), required, "database field created");
    // P-DB-29B-C: emit a `FieldCreated` event so collaborators receive
    // the new column without polling.
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::FieldCreated,
        actor,
        DatabaseChangeTarget {
          row_id: None,
          field_id: Some(field_id),
          view_id: None,
        },
      )
      .await;
    Ok(field)
  }

  #[instrument(
    skip(self, name, config, required),
    fields(actor_id = %actor, database_id = %database_id, field_id = %field_id, renamed = tracing::field::Empty, config_changed = tracing::field::Empty, required_changed = tracing::field::Empty)
  )]
  pub async fn update_field(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    field_id: DatabaseFieldId,
    name: Option<String>,
    config: Option<DatabaseFieldConfig>,
    required: Option<bool>,
  ) -> DatabaseResult<DatabaseField> {
    self
      .update_field_with_edit_precondition(
        actor,
        database_id,
        field_id,
        name,
        config,
        required,
        DatabaseEditPrecondition::default(),
      )
      .await
  }

  #[expect(
    clippy::too_many_arguments,
    reason = "the established mutation boundary keeps identity and precondition fields explicit"
  )]
  pub(super) async fn update_field_with_edit_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    field_id: DatabaseFieldId,
    name: Option<String>,
    config: Option<DatabaseFieldConfig>,
    required: Option<bool>,
    precondition: DatabaseEditPrecondition,
  ) -> DatabaseResult<DatabaseField> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let precondition = precondition
      .in_workspace(record.database.workspace_id)
      .in_database(record.database.id);
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    managed_schema::assert_structure_edit(&record)?;
    let field = record
      .fields
      .iter()
      .find(|field| field.id == field_id)
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database field not found"))?;
    let mut config = config;
    let mut formula_analysis = None;
    if let Some(config) = config.as_mut() {
      crate::database::definition::rules::validate_field_config(field.field_type, config)?;
      access::validate_relation_field_config(
        &self.permission,
        &self.schema_repo,
        actor,
        &record.database,
        field_id,
        config,
      )
      .await?;
      access::validate_rollup_field_config(
        &self.permission,
        &self.schema_repo,
        actor,
        &record.database,
        &record.fields,
        config,
      )
      .await?;
      formula_analysis =
        crate::database::definition::rules::validate_formula_field_config(&record.fields, Some(field_id), config)?;
    }
    let name = name
      .map(|value| crate::database::definition::rules::validate_title(&value))
      .transpose()?;
    let renamed = name.is_some();
    let config_changed = config.is_some();
    let required_changed = required.is_some();
    let span = tracing::Span::current();
    span.record("renamed", renamed);
    span.record("config_changed", config_changed);
    span.record("required_changed", required_changed);
    let field = self
      .schema_repo
      .update_field(field_id, name, config, required, precondition)
      .await
      .map_err(DatabaseServiceError::from)?;
    if let Some(analysis) = formula_analysis {
      self
        .projection_repo
        .replace_formula_dependencies(field_id, analysis.dependency_field_ids)
        .await?;
    }
    info!(renamed, config_changed, required_changed, "database field updated");
    // P-DB-29B-C: emit a `FieldUpdated` event so collaborators see
    // the renamed column / new select options.
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::FieldUpdated,
        actor,
        DatabaseChangeTarget {
          row_id: None,
          field_id: Some(field_id),
          view_id: None,
        },
      )
      .await;
    Ok(field)
  }

  #[instrument(
    skip(self),
    fields(actor_id = %actor, database_id = %database_id, field_id = %field_id)
  )]
  pub async fn delete_field(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    field_id: DatabaseFieldId,
  ) -> DatabaseResult<()> {
    self
      .delete_field_with_edit_precondition(actor, database_id, field_id, DatabaseEditPrecondition::default())
      .await
  }

  pub(super) async fn delete_field_with_edit_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    field_id: DatabaseFieldId,
    precondition: DatabaseEditPrecondition,
  ) -> DatabaseResult<()> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let precondition = precondition
      .in_workspace(record.database.workspace_id)
      .in_database(record.database.id);
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    managed_schema::assert_structure_edit(&record)?;
    let field = record
      .fields
      .iter()
      .find(|field| field.id == field_id)
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database field not found"))?;
    let required_by_role = record
      .field_roles
      .iter()
      .any(|role| role.field_id == field_id && role.required);
    if field.field_type == DatabaseFieldType::Title || field.required || required_by_role {
      return Err(DatabaseServiceError::new(
        ERR_FIELD_REQUIRED,
        "required database fields or semantic roles cannot be deleted",
      ));
    }
    if let Some(view) = crate::database::definition::rules::structural_view_axis_reference(field_id, &record.views) {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_CONFIG_INVALID,
        format!("field is used as the structural axis for database view {}", view.id),
      ));
    }
    self
      .schema_repo
      .delete_field(field_id, precondition)
      .await
      .map_err(|error| {
        error!(error = %error, "database field delete failed at repository layer");
        error
      })?;
    info!(field_id = %field_id, "database field deleted");
    // P-DB-29B-C: emit a `FieldDeleted` event so collaborators drop
    // the column from their tables and formulas.
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::FieldDeleted,
        actor,
        DatabaseChangeTarget {
          row_id: None,
          field_id: Some(field_id),
          view_id: None,
        },
      )
      .await;
    Ok(())
  }

  #[instrument(
    skip(self, field_ids),
    fields(actor_id = %actor, database_id = %database_id, field_count = tracing::field::Empty)
  )]
  pub async fn reorder_fields(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    field_ids: Vec<DatabaseFieldId>,
  ) -> DatabaseResult<Vec<DatabaseField>> {
    self
      .reorder_fields_with_edit_preconditions(actor, database_id, field_ids, &HashMap::new(), false)
      .await
  }

  pub(super) async fn reorder_fields_with_edit_preconditions(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    field_ids: Vec<DatabaseFieldId>,
    expected_edit_revisions: &HashMap<DatabaseFieldId, i64>,
    force: bool,
  ) -> DatabaseResult<Vec<DatabaseField>> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    managed_schema::assert_structure_edit(&record)?;
    let existing = record.fields.iter().map(|field| field.id).collect::<BTreeSet<_>>();
    let requested = field_ids.iter().copied().collect::<BTreeSet<_>>();
    if existing != requested {
      return Err(DatabaseServiceError::new(
        ERR_FIELD_INVALID,
        "field reorder must include exactly every field once",
      ));
    }
    let field_count = field_ids.len();
    tracing::Span::current().record("field_count", field_count);
    let fields = self
      .schema_repo
      .reorder_fields(
        database_id,
        field_ids,
        expected_edit_revisions,
        force,
        DatabaseEditPrecondition::default()
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id),
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    info!(field_count, "database fields reordered");
    // P-DB-29B-C: emit a `FieldsReordered` event so collaborators see
    // the new column order without a refetch.
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::FieldReordered,
        actor,
        DatabaseChangeTarget {
          row_id: None,
          field_id: None,
          view_id: None,
        },
      )
      .await;
    Ok(fields)
  }

  /// `update_field` with stale-write precondition.
  #[instrument(
    skip(self, name, config, required),
    fields(actor_id = %actor, database_id = %database_id, field_id = %field_id, force, has_expected = expected_edit_revision.is_some())
  )]
  #[expect(
    clippy::too_many_arguments,
    reason = "the public mutation contract keeps identity and optimistic concurrency explicit"
  )]
  pub async fn update_field_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    field_id: DatabaseFieldId,
    name: Option<String>,
    config: Option<DatabaseFieldConfig>,
    required: Option<bool>,
    expected_edit_revision: Option<i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseField> {
    let result = self
      .update_field_with_edit_precondition(
        actor,
        database_id,
        field_id,
        name,
        config,
        required,
        DatabaseEditPrecondition::new(expected_edit_revision, force),
      )
      .await;
    match result {
      Ok(field) => {
        if force {
          self
            .effects
            .record_audit(
              "database.field.overwrite",
              AuditCategory::Database,
              Some(AuditTarget::entity(
                "database_field",
                field_id,
                Some(field.name.clone()),
              )),
              actor,
              Some(serde_json::json!({ "expectedEditRevision": expected_edit_revision })),
              Some(serde_json::json!({ "editRevision": field.edit_revision, "forced": true })),
            )
            .await;
        }
        Ok(field)
      }
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::Field) => {
        let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
        let latest = record
          .fields
          .iter()
          .find(|field| field.id == field_id)
          .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database field not found"))?;
        Err(
          DatabaseServiceError::new(ERR_FIELD_CONFLICT, "database field changed since editing began")
            .with_latest_state(serde_json::json!({
              "kind": "field",
              "databaseId": database_id,
              "fieldId": field_id,
              "editRevision": latest.edit_revision,
              "name": latest.name,
              "fieldKind": latest.field_type.as_str(),
              "config": latest.config,
              "required": latest.required,
            })),
        )
      }
      Err(error) => Err(error),
    }
  }

  pub async fn delete_field_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    field_id: DatabaseFieldId,
    expected_edit_revision: Option<i64>,
    force: bool,
  ) -> DatabaseResult<()> {
    let result = self
      .delete_field_with_edit_precondition(
        actor,
        database_id,
        field_id,
        DatabaseEditPrecondition::new(expected_edit_revision, force),
      )
      .await;
    match result {
      Ok(()) => {
        if force {
          self
            .effects
            .record_audit(
              "database.field.delete.overwrite",
              AuditCategory::Database,
              Some(AuditTarget::entity("database_field", field_id, None)),
              actor,
              Some(serde_json::json!({ "expectedEditRevision": expected_edit_revision })),
              Some(serde_json::json!({ "forced": true })),
            )
            .await;
        }
        Ok(())
      }
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::Field) => {
        let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
        let latest = record
          .fields
          .iter()
          .find(|field| field.id == field_id)
          .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database field not found"))?;
        Err(
          DatabaseServiceError::new(ERR_FIELD_CONFLICT, "database field changed since editing began")
            .with_latest_state(serde_json::json!({
              "kind": "field",
              "databaseId": database_id,
              "fieldId": field_id,
              "editRevision": latest.edit_revision,
              "name": latest.name,
            })),
        )
      }
      Err(error) => Err(error),
    }
  }

  pub async fn reorder_fields_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    field_ids: Vec<DatabaseFieldId>,
    expected_edit_revisions: &HashMap<DatabaseFieldId, i64>,
    force: bool,
  ) -> DatabaseResult<Vec<DatabaseField>> {
    let result = self
      .reorder_fields_with_edit_preconditions(actor, database_id, field_ids, expected_edit_revisions, force)
      .await;
    match result {
      Ok(fields) => Ok(fields),
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::Field) => {
        let latest = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
        Err(
          DatabaseServiceError::new(ERR_FIELD_CONFLICT, "database field order changed since editing began")
            .with_latest_state(serde_json::json!({
              "kind": "field_order",
              "databaseId": database_id,
              "fields": latest.fields.iter().map(|field| serde_json::json!({
                "fieldId": field.id,
                "position": field.position,
                "editRevision": field.edit_revision,
              })).collect::<Vec<_>>(),
            })),
        )
      }
      Err(error) => Err(error),
    }
  }
}
