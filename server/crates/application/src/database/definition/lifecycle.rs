use super::*;

impl DatabaseDefinitionService {
  #[instrument(
    skip(self, title, description),
    fields(workspace_id = %workspace_id, actor_id = %actor, database_id = tracing::field::Empty, view_kind = tracing::field::Empty, initial_field_count = tracing::field::Empty)
  )]
  pub async fn create_database(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    title: String,
    description: Option<String>,
    initial_view_kind: InitialDatabaseViewKind,
  ) -> DatabaseResult<DatabaseRecord> {
    let title = self.validate_database_creation(actor, workspace_id, &title).await?;
    let now = Utc::now();
    let database_id = Uuid::new_v4();
    let title_field_id = Uuid::new_v4();
    let mut fields = vec![DatabaseField {
      id: title_field_id,
      database_id,
      name: "Title".to_string(),
      field_type: DatabaseFieldType::Title,
      config: DatabaseFieldConfig::Title,
      position: 0,
      required: true,
      edit_revision: 1,
      created_at: now,
      updated_at: now,
    }];
    let view_kind: DatabaseViewKind = initial_view_kind.into();
    let view_config = if view_kind == DatabaseViewKind::Kanban {
      let status_field_id = Uuid::new_v4();
      fields.push(DatabaseField {
        id: status_field_id,
        database_id,
        name: "Status".to_string(),
        field_type: DatabaseFieldType::Status,
        config: DatabaseFieldConfig::Status(default_database_status_field_config()),
        position: 1,
        required: false,
        edit_revision: 1,
        created_at: now,
        updated_at: now,
      });
      DatabaseViewConfig::Kanban(DatabaseKanbanViewConfig {
        title_field_id,
        group_field_id: status_field_id,
        visible_field_ids: fields.iter().map(|field| field.id).collect(),
        cover_field_id: None,
        card_density: DatabaseCardDensity::Default,
        sort: Vec::new(),
        filter: Vec::new(),
        filter_tree: None,
      })
    } else {
      DatabaseViewConfig::Table(DatabaseTableViewConfig {
        title_field_id,
        visible_field_ids: vec![title_field_id],
        field_widths: BTreeMap::new(),
        search_field_ids: vec![title_field_id],
        sort: Vec::new(),
        filter: Vec::new(),
        filter_tree: None,
        group: None,
        subgroup: None,
      })
    };
    crate::database::views::rules::validate_view_config(
      view_kind,
      &view_config,
      &fields,
      self.limits.max_fields_per_database,
    )?;
    let view = DatabaseView {
      id: Uuid::new_v4(),
      database_id,
      name: match view_kind {
        DatabaseViewKind::Table => "Table".to_string(),
        DatabaseViewKind::Kanban => "Kanban".to_string(),
        DatabaseViewKind::List => "List".to_string(),
        DatabaseViewKind::Gallery => "Gallery".to_string(),
        DatabaseViewKind::Calendar => "Calendar".to_string(),
        DatabaseViewKind::Timeline => "Timeline".to_string(),
        DatabaseViewKind::Gantt => "Gantt".to_string(),
        DatabaseViewKind::Progress => "Progress".to_string(),
      },
      view_kind,
      icon: None,
      config: view_config,
      position: 0,
      edit_revision: 1,
      created_at: now,
      updated_at: now,
    };
    let initial_field_count = fields.len();
    let span = tracing::Span::current();
    span.record("database_id", tracing::field::display(database_id));
    span.record("view_kind", view_kind.as_str());
    span.record("initial_field_count", initial_field_count);
    let record = self
      .schema_repo
      .create_database(DatabaseInitialState {
        database: Database {
          system_role: None,
          managed_installation: None,

          id: database_id,
          workspace_id,
          profile_kind: DatabaseProfileKind::Generic,
          profile_structure_preset: None,
          profile_config: serde_json::json!({}),
          title,
          description: description.and_then(|value| {
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
          }),
          created_by: Some(actor),
          updated_by: Some(actor),
          deleted_at: None,
          deleted_by: None,
          edit_revision: 1,
          created_at: now,
          updated_at: now,
        },
        fields,
        views: vec![view],
        roles: Vec::new(),
        view_roles: Vec::new(),
        rows: Vec::new(),
        row_templates: Vec::new(),
        workspace_tags: Vec::new(),
      })
      .await
      .map_err(|error| {
        error!(error = %error, "database create failed at repository layer");
        error
      })?;
    info!(initial_field_count, view_kind = view_kind.as_str(), "database created");
    // P-DB-29B-C: emit a `DatabaseCreated` event after the database is
    // committed so collaborators see the brand-new database in their
    // sidebar / presence surface without polling.
    self
      .effects
      .emit_change(
        workspace_id,
        database_id,
        DatabaseChangeKind::DatabaseCreated,
        actor,
        DatabaseChangeTarget {
          row_id: None,
          field_id: None,
          view_id: None,
        },
      )
      .await;
    Ok(record)
  }

  #[instrument(skip(self, input), fields(workspace_id = %input.workspace_id, actor = %actor))]
  pub async fn create_project(&self, actor: UserId, input: CreateDatabaseProject) -> DatabaseResult<DatabaseRecord> {
    self
      .create_database_from_template(
        actor,
        CreateDatabaseFromTemplate {
          workspace_id: input.workspace_id,
          template_id: self
            .starter_templates
            .system_source(DatabaseTemplateSourceRole::ProjectDefault)
            .ok_or_else(|| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, "default Project source unavailable"))?
            .template_id
            .clone(),
          title: input.title,
          description: input.description,
          include_sample_rows: false,
          priority_preset: input.priority_preset,
          complexity_preset: input.complexity_preset,
          structure_preset: input.structure_preset,
          default_currency: input.default_currency,
        },
      )
      .await
  }

  /// Check creation ACL/title without writes before a transport admits a retry key.
  #[instrument(skip_all)]
  pub async fn validate_database_creation(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    title: &str,
  ) -> DatabaseResult<String> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::CreateDoc).await?;
    crate::database::definition::rules::validate_title(title)
  }

  /// Load active or trashed metadata and check the existing creator/manager policy.
  /// This does not waive the actual mutation's lifecycle or revision preconditions.
  #[instrument(skip_all)]
  pub async fn validate_database_management(
    &self,
    actor: UserId,
    database_id: DatabaseId,
  ) -> DatabaseResult<DatabaseRecord> {
    let record = self.get_database_for_lifecycle(actor, database_id).await?;
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    Ok(record)
  }

  /// Reauthorize a completed purge receipt against its persisted original principal.
  /// Callers must take workspace/creator identity from that trusted receipt, never
  /// from new caller assertions; current workspace read access is still mandatory.
  #[instrument(skip_all)]
  pub async fn validate_database_receipt_authority(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    created_by: Option<UserId>,
  ) -> DatabaseResult<()> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    access::assert_database_manager_principal(&self.permission, actor, workspace_id, created_by).await
  }

  pub async fn get_database(&self, actor: UserId, database_id: DatabaseId) -> DatabaseResult<DatabaseRecord> {
    access::get_database(&self.permission, &self.schema_repo, actor, database_id).await
  }

  pub(crate) async fn get_database_for_lifecycle(
    &self,
    actor: UserId,
    database_id: DatabaseId,
  ) -> DatabaseResult<DatabaseRecord> {
    let record = self
      .schema_repo
      .get_database_for_lifecycle(database_id)
      .await?
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database not found"))?;
    access::assert_workspace(
      &self.permission,
      actor,
      record.database.workspace_id,
      WorkspaceAction::Read,
    )
    .await?;
    Ok(record)
  }

  #[instrument(
    skip(self, title, description),
    fields(actor_id = %actor, database_id = %database_id, renamed = tracing::field::Empty, description_changed = tracing::field::Empty)
  )]
  pub async fn update_database(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    title: Option<String>,
    description: Option<Option<String>>,
  ) -> DatabaseResult<DatabaseRecord> {
    self
      .update_database_with_edit_precondition(
        actor,
        database_id,
        title,
        description,
        DatabaseEditPrecondition::default(),
      )
      .await
  }

  pub(super) async fn update_database_with_edit_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    title: Option<String>,
    description: Option<Option<String>>,
    precondition: DatabaseEditPrecondition,
  ) -> DatabaseResult<DatabaseRecord> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let precondition = precondition
      .in_workspace(record.database.workspace_id)
      .in_database(record.database.id);
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    managed_schema::assert_metadata_lifecycle_edit(&record)?;
    let title = title
      .map(|value| crate::database::definition::rules::validate_title(&value))
      .transpose()?;
    let renamed = title.is_some();
    let description_changed = description.is_some();
    let span = tracing::Span::current();
    span.record("renamed", renamed);
    span.record("description_changed", description_changed);
    let record = self
      .schema_repo
      .update_database(database_id, title, description, actor, precondition)
      .await
      .map_err(DatabaseServiceError::from)?;
    info!(renamed, description_changed, "database updated");
    // P-DB-29B-C: emit a `DatabaseUpdated` event so collaborators see
    // rename / description changes without polling.
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::DatabaseUpdated,
        actor,
        DatabaseChangeTarget {
          row_id: None,
          field_id: None,
          view_id: None,
        },
      )
      .await;
    Ok(record)
  }

  pub(super) async fn trash_database_with_edit_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    precondition: DatabaseEditPrecondition,
  ) -> DatabaseResult<DatabaseRecord> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let precondition = precondition
      .in_workspace(record.database.workspace_id)
      .in_database(record.database.id);
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    managed_schema::assert_metadata_lifecycle_edit(&record)?;
    let trashed = self
      .schema_repo
      .trash_database(database_id, actor, precondition)
      .await
      .map_err(|error| {
        error!(error = %error, "database trash failed at repository layer");
        error
      })?;
    info!("database moved to trash");
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::DatabaseTrashed,
        actor,
        DatabaseChangeTarget {
          row_id: None,
          field_id: None,
          view_id: None,
        },
      )
      .await;
    Ok(trashed)
  }

  pub(super) async fn restore_database_with_edit_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    precondition: DatabaseEditPrecondition,
  ) -> DatabaseResult<DatabaseRecord> {
    let record = self.get_database_for_lifecycle(actor, database_id).await?;
    let precondition = precondition
      .in_workspace(record.database.workspace_id)
      .in_database(record.database.id);
    if record.database.deleted_at.is_none() {
      return Err(DatabaseServiceError::new(ERR_NOT_FOUND, "trashed database not found"));
    }
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    managed_schema::assert_metadata_lifecycle_edit(&record)?;
    let restored = self
      .schema_repo
      .restore_database(database_id, actor, precondition)
      .await?;
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::DatabaseRestored,
        actor,
        DatabaseChangeTarget {
          row_id: None,
          field_id: None,
          view_id: None,
        },
      )
      .await;
    Ok(restored)
  }

  pub(super) async fn delete_database_permanently_with_edit_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    precondition: DatabaseEditPrecondition,
  ) -> DatabaseResult<()> {
    let record = self.get_database_for_lifecycle(actor, database_id).await?;
    let precondition = precondition
      .in_workspace(record.database.workspace_id)
      .in_database(record.database.id);
    if record.database.deleted_at.is_none() {
      return Err(DatabaseServiceError::new(
        ERR_QUERY_INVALID,
        "database must be trashed before permanent deletion",
      ));
    }
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    managed_schema::assert_metadata_lifecycle_edit(&record)?;
    self.schema_repo.purge_database(database_id, precondition).await?;
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::DatabaseDeleted,
        actor,
        DatabaseChangeTarget {
          row_id: None,
          field_id: None,
          view_id: None,
        },
      )
      .await;
    Ok(())
  }

  pub async fn update_database_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    title: Option<String>,
    description: Option<Option<String>>,
    expected_edit_revision: Option<i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseRecord> {
    let result = self
      .update_database_with_edit_precondition(
        actor,
        database_id,
        title,
        description,
        DatabaseEditPrecondition::new(expected_edit_revision, force),
      )
      .await;
    match result {
      Ok(record) => Ok(record),
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::Database) => {
        let latest = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
        Err(
          DatabaseServiceError::new(ERR_DATABASE_CONFLICT, "database metadata changed since editing began")
            .with_latest_state(serde_json::json!({
              "kind": "database",
              "databaseId": database_id,
              "editRevision": latest.database.edit_revision,
              "title": latest.database.title,
              "description": latest.database.description,
            })),
        )
      }
      Err(error) => Err(error),
    }
  }

  pub async fn trash_database_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    expected_edit_revision: Option<i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseRecord> {
    let result = self
      .trash_database_with_edit_precondition(
        actor,
        database_id,
        DatabaseEditPrecondition::new(expected_edit_revision, force),
      )
      .await;
    match result {
      Ok(record) => Ok(record),
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::Database) => {
        let latest = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
        Err(
          DatabaseServiceError::new(ERR_DATABASE_CONFLICT, "database metadata changed since editing began")
            .with_latest_state(serde_json::json!({
              "kind": "database",
              "databaseId": database_id,
              "editRevision": latest.database.edit_revision,
              "title": latest.database.title,
            })),
        )
      }
      Err(error) => Err(error),
    }
  }

  pub async fn restore_database_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    expected_edit_revision: Option<i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseRecord> {
    self
      .restore_database_with_edit_precondition(
        actor,
        database_id,
        DatabaseEditPrecondition::new(expected_edit_revision, force),
      )
      .await
  }

  pub async fn delete_database_permanently_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    expected_edit_revision: Option<i64>,
    force: bool,
  ) -> DatabaseResult<()> {
    self
      .delete_database_permanently_with_edit_precondition(
        actor,
        database_id,
        DatabaseEditPrecondition::new(expected_edit_revision, force),
      )
      .await
  }
}
