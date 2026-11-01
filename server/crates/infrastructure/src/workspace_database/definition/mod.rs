// SPDX-License-Identifier: AGPL-3.0-or-later
//! Initial native Database persistence within a caller-owned transaction.

mod managed_schema;

use crate::workspace_database::*;

impl PgDatabaseRepository {
  /// Inserts the complete initial state without committing or publishing effects.
  /// Import provenance remains attached to Rows so cancellation can find them.
  /// Accepted setup uses the same complete initial writer. Fresh Work Items
  /// also receive native public IDs before the caller commits its receipt ACK.
  pub(crate) async fn insert_project_starter_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    state: DatabaseInitialState,
    actor: UserId,
  ) -> RepoResult<DatabaseRecord> {
    let mut rows = state.rows.clone();
    let database_id = state.database.id;
    let record = Self::insert_initial_state_in_tx(tx, state, None).await?;
    for row in &mut rows {
      row.cells = Self::allocate_unique_id_cells(tx, database_id, row.row.id, actor).await?;
    }
    Self::insert_snapshot_cells_and_templates(tx, database_id, actor, &rows, &[]).await?;
    Ok(record)
  }
  pub(crate) async fn insert_initial_state_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    state: DatabaseInitialState,
    import_job_id: Option<DatabaseImportJobId>,
  ) -> RepoResult<DatabaseRecord> {
    let DatabaseInitialState {
      database,
      fields,
      views,
      roles,
      view_roles,
      rows,
      row_templates,
      workspace_tags,
    } = state;
    let database_id = database.id;
    let actor = database.updated_by.or(database.created_by).unwrap_or_default();
    for tag in &workspace_tags {
      crate::workspace_tags::PgWorkspaceTagRepository::insert_tag_in_tx(tx, tag)
        .await
        .map_err(Self::map_sqlx_error)?;
    }
    let mut record = Self::insert_database_bundle(tx, database, fields, views, roles, view_roles).await?;
    sqlx::query("SELECT set_config('myoxus.managed_schema_write','on',true)")
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    Self::insert_snapshot_rows_and_templates(tx, database_id, actor, &rows, &row_templates, import_job_id).await?;
    sqlx::query("SELECT set_config('myoxus.managed_schema_write','off',true)")
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    record.row_count = rows.len() as i64;
    Ok(record)
  }

  pub(crate) async fn insert_database_bundle(
    tx: &mut Transaction<'_, Postgres>,
    database: Database,
    fields: Vec<DatabaseField>,
    views: Vec<DatabaseView>,
    field_roles: Vec<DatabaseFieldRole>,
    view_roles: Vec<DatabaseViewRole>,
  ) -> RepoResult<DatabaseRecord> {
    if database.profile_kind == DatabaseProfileKind::Project && database.managed_installation.is_none() {
      return Err(RepositoryError::Validation(
        "Project creation requires the admitted server descriptor".into(),
      ));
    }
    if database.profile_kind == DatabaseProfileKind::Generic
      && (database.managed_installation.is_some() || database.system_role.is_some())
    {
      return Err(RepositoryError::Validation(
        "Generic cannot install managed metadata".into(),
      ));
    }
    sqlx::query("SELECT set_config('myoxus.managed_schema_write','on',true)")
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let installation = database
      .managed_installation
      .as_ref()
      .map(serde_json::to_value)
      .transpose()
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let system_role = database.system_role.map(DatabaseSystemRole::as_str);
    let requested_profile_kind = database.profile_kind;
    let requested_profile_structure_preset = database.profile_structure_preset.clone();
    let requested_profile_config = database.profile_config.clone();
    let has_profile_config = requested_profile_config
      .as_object()
      .map(|config| !config.is_empty())
      .unwrap_or(true);
    if requested_profile_kind == DatabaseProfileKind::Generic && (!field_roles.is_empty() || !view_roles.is_empty()) {
      return Err(RepositoryError::Validation(
        "generic databases cannot persist profile roles".to_string(),
      ));
    }
    if requested_profile_kind == DatabaseProfileKind::Generic && requested_profile_structure_preset.is_some() {
      return Err(RepositoryError::Validation(
        "generic databases cannot persist profile structure metadata".to_string(),
      ));
    }
    if field_roles
      .iter()
      .any(|role| role.profile_kind != requested_profile_kind)
    {
      return Err(RepositoryError::Validation(
        "database field roles must match the database profile kind".to_string(),
      ));
    }
    if view_roles
      .iter()
      .any(|role| role.profile_kind != requested_profile_kind || role.database_id != database.id)
    {
      return Err(RepositoryError::Validation(
        "database view roles must match the database profile".to_string(),
      ));
    }
    for role in &view_roles {
      let expected_kind = role
        .expected_view_kind()
        .ok_or_else(|| RepositoryError::Validation(format!("unknown database view role {}", role.role_key)))?;
      if !views
        .iter()
        .any(|view| view.id == role.view_id && view.database_id == database.id && view.view_kind == expected_kind)
      {
        return Err(RepositoryError::Validation(format!(
          "database view role {} must target a same-database {} view",
          role.role_key,
          expected_kind.as_str()
        )));
      }
    }

    let database_row = sqlx::query(
      r#"
        INSERT INTO workspace_databases
          (id, workspace_id, title, description, created_by, updated_by, created_at, updated_at,system_role,managed_installation)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8,$9,$10)
        RETURNING
          system_role,managed_installation,
          id,
          workspace_id,
          'generic' AS profile_kind,
          NULL::text AS profile_structure_preset,
          '{}'::jsonb AS profile_config,
          title,
          description,
          created_by,
          updated_by,
          deleted_at,
          deleted_by,
          edit_revision,
          created_at,
          updated_at
      "#,
    )
    .bind(database.id)
    .bind(database.workspace_id)
    .bind(database.title)
    .bind(database.description)
    .bind(database.created_by)
    .bind(database.updated_by)
    .bind(database.created_at)
    .bind(database.updated_at)
    .bind(system_role)
    .bind(installation)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_snapshot_sqlx_error)?;
    let mut database = Self::map_database(database_row)?;

    if requested_profile_kind != DatabaseProfileKind::Generic || has_profile_config {
      let insert_profile_sql = format!(
        r#"
          INSERT INTO {DATABASE_PROFILES_TABLE}
            (database_id, profile_kind, profile_version, structure_preset, config_json, created_at, updated_at)
          VALUES ($1, $2, 1, $3, $4, $5, $6)
        "#,
      );
      let structure_preset = match requested_profile_kind {
        DatabaseProfileKind::Project => requested_profile_structure_preset.as_deref(),
        DatabaseProfileKind::Generic => None,
      };
      if requested_profile_kind == DatabaseProfileKind::Project && structure_preset.is_none() {
        return Err(RepositoryError::Validation(
          "project profile databases require an explicit structure preset".to_string(),
        ));
      }
      sqlx::query(&insert_profile_sql)
        .bind(database.id)
        .bind(requested_profile_kind.as_str())
        .bind(structure_preset)
        .bind(&requested_profile_config)
        .bind(database.created_at)
        .bind(database.updated_at)
        .execute(&mut **tx)
        .await
        .map_err(Self::map_snapshot_sqlx_error)?;
      database.profile_kind = requested_profile_kind;
      database.profile_structure_preset = requested_profile_structure_preset;
      database.profile_config = requested_profile_config;
    }

    for field in fields {
      let config_json = Self::map_field_config_to_json(&field.config)?;
      sqlx::query(
        r#"
          INSERT INTO workspace_database_fields
          (id, database_id, name, field_type, config_json, position, required, edit_revision, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
      )
      .bind(field.id)
      .bind(field.database_id)
      .bind(field.name)
      .bind(field.field_type.as_str())
      .bind(config_json)
      .bind(field.position)
      .bind(field.required)
      .bind(field.edit_revision)
      .bind(field.created_at)
      .bind(field.updated_at)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_snapshot_sqlx_error)?;
    }

    for view in views {
      let config_json = Self::map_view_config_to_json(&view.config)?;
      let icon_json = view.icon.as_ref().map(Self::map_view_icon_to_json).transpose()?;
      sqlx::query(
        r#"
          INSERT INTO workspace_database_views
          (id, database_id, name, view_kind, icon_json, config_json, position, edit_revision, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
      )
      .bind(view.id)
      .bind(view.database_id)
      .bind(view.name)
      .bind(view.view_kind.as_str())
      .bind(icon_json)
      .bind(config_json)
      .bind(view.position)
      .bind(view.edit_revision)
      .bind(view.created_at)
      .bind(view.updated_at)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_snapshot_sqlx_error)?;
    }

    for role in field_roles {
      let insert_role_sql = format!(
        r#"
          INSERT INTO {DATABASE_FIELD_ROLES_TABLE}
            (database_id, profile_kind, role_key, row_kind_scope, field_id, required, config_json, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        "#,
      );
      sqlx::query(&insert_role_sql)
        .bind(role.database_id)
        .bind(role.profile_kind.as_str())
        .bind(role.role_key)
        .bind(role.row_kind_scope)
        .bind(role.field_id)
        .bind(role.required)
        .bind(role.config)
        .bind(role.created_at)
        .bind(role.updated_at)
        .execute(&mut **tx)
        .await
        .map_err(Self::map_snapshot_sqlx_error)?;
    }

    for role in view_roles {
      let insert_role_sql = format!(
        r#"
          INSERT INTO {DATABASE_VIEW_ROLES_TABLE}
            (database_id, profile_kind, role_key, view_id, required, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
      );
      sqlx::query(&insert_role_sql)
        .bind(role.database_id)
        .bind(role.profile_kind.as_str())
        .bind(role.role_key)
        .bind(role.view_id)
        .bind(role.required)
        .bind(role.created_at)
        .bind(role.updated_at)
        .execute(&mut **tx)
        .await
        .map_err(Self::map_snapshot_sqlx_error)?;
    }

    let fields = Self::list_fields_for(&mut **tx, database.id).await?;
    let views = Self::list_views_for(&mut **tx, database.id).await?;
    let field_roles = Self::list_field_roles_for(&mut **tx, database.id).await?;
    let view_roles = Self::list_view_roles_for(&mut **tx, database.id).await?;
    sqlx::query("SELECT set_config('myoxus.managed_schema_write','off',true)")
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let mut record = DatabaseRecord {
      managed_schema: None,

      database,
      fields,
      views,
      field_roles,
      view_roles,
      row_count: 0,
    };
    record.managed_schema = record.project_managed_schema();
    Ok(record)
  }

  pub(crate) async fn insert_snapshot_rows_and_templates(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    fallback_actor: UserId,
    rows: &[DatabaseRowRecord],
    row_templates: &[DatabaseRowTemplate],
    import_job_id: Option<DatabaseImportJobId>,
  ) -> RepoResult<()> {
    Self::insert_snapshot_rows(tx, database_id, rows, import_job_id).await?;
    Self::insert_snapshot_cells_and_templates(tx, database_id, fallback_actor, rows, row_templates).await
  }
}

impl PgDatabaseRepository {
  pub(in crate::workspace_database) fn assert_edit_precondition(
    actual_edit_revision: i64,
    precondition: DatabaseEditPrecondition,
    entity: &'static str,
  ) -> RepoResult<()> {
    if !precondition.force
      && precondition
        .expected_edit_revision
        .is_some_and(|expected| expected != actual_edit_revision)
    {
      return Err(RepositoryError::Conflict(entity));
    }
    Ok(())
  }

  /// Revalidate the workspace used for authorization before committing.
  ///
  /// Database mutations already hold the affected child rows until commit. If
  /// an identity-preserving Move wins first, this read observes the new owner
  /// and rolls the mutation back. If the mutation wins first, its child locks
  /// force Move to recapture a changed revision manifest and fail stale. No
  /// long-lived transfer lock or write-path trigger is involved.
  pub(in crate::workspace_database) async fn assert_database_workspace(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<()> {
    if precondition
      .expected_database_id
      .is_some_and(|expected| expected != database_id)
    {
      return Err(RepositoryError::NotFound("database row"));
    }
    let Some(expected_workspace_id) = precondition.expected_workspace_id else {
      return Ok(());
    };
    let actual_workspace_id =
      sqlx::query_scalar::<_, WorkspaceId>("SELECT workspace_id FROM workspace_databases WHERE id = $1")
        .bind(database_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::NotFound("database"))?;
    if actual_workspace_id != expected_workspace_id {
      return Err(RepositoryError::Conflict("database workspace changed"));
    }
    Ok(())
  }

  pub(in crate::workspace_database) async fn lock_entity_edit_revision(
    tx: &mut Transaction<'_, Postgres>,
    table: &'static str,
    id: Uuid,
    entity: &'static str,
  ) -> RepoResult<i64> {
    if table == "workspace_database_rows" {
      let owner: Uuid = sqlx::query_scalar("SELECT database_id FROM workspace_database_rows WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::NotFound(entity))?;
      Self::lock_managed_admission(tx, owner).await?;
    }
    let sql = format!("SELECT edit_revision FROM {table} WHERE id = $1 FOR UPDATE");
    sqlx::query_scalar::<_, i64>(&sql)
      .bind(id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?
      .ok_or(RepositoryError::NotFound(entity))
  }

  pub(in crate::workspace_database) fn map_field_config_to_json(config: &DatabaseFieldConfig) -> RepoResult<Value> {
    serde_json::to_value(config).map_err(|error| RepositoryError::Validation(error.to_string()))
  }

  pub(in crate::workspace_database) fn map_database(row: sqlx::postgres::PgRow) -> RepoResult<Database> {
    let profile_kind = DatabaseProfileKind::from_str(
      row
        .try_get::<String, _>("profile_kind")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Ok(Database {
      system_role: match row
        .try_get::<Option<String>, _>("system_role")
        .map_err(Self::map_sqlx_error)?
        .as_deref()
      {
        None => None,
        Some("workspace_tasks") => Some(DatabaseSystemRole::WorkspaceTasks),
        Some(_) => return Err(RepositoryError::Validation("unknown database system role".into())),
      },
      managed_installation: row
        .try_get::<Option<Value>, _>("managed_installation")
        .map_err(Self::map_sqlx_error)?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| RepositoryError::Validation(format!("invalid managed installation: {error}")))?,

      id: row.try_get("id").map_err(Self::map_sqlx_error)?,
      workspace_id: row.try_get("workspace_id").map_err(Self::map_sqlx_error)?,
      profile_kind,
      profile_structure_preset: row.try_get("profile_structure_preset").map_err(Self::map_sqlx_error)?,
      profile_config: row.try_get("profile_config").map_err(Self::map_sqlx_error)?,
      title: row.try_get("title").map_err(Self::map_sqlx_error)?,
      description: row.try_get("description").map_err(Self::map_sqlx_error)?,
      created_by: row.try_get("created_by").map_err(Self::map_sqlx_error)?,
      updated_by: row.try_get("updated_by").map_err(Self::map_sqlx_error)?,
      deleted_at: row.try_get("deleted_at").map_err(Self::map_sqlx_error)?,
      deleted_by: row.try_get("deleted_by").map_err(Self::map_sqlx_error)?,
      edit_revision: row.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
      created_at: row.try_get("created_at").map_err(Self::map_sqlx_error)?,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
    })
  }

  pub(in crate::workspace_database) fn map_field_role(row: sqlx::postgres::PgRow) -> RepoResult<DatabaseFieldRole> {
    let profile_kind = DatabaseProfileKind::from_str(
      row
        .try_get::<String, _>("profile_kind")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Ok(DatabaseFieldRole {
      database_id: row.try_get("database_id").map_err(Self::map_sqlx_error)?,
      profile_kind,
      role_key: row.try_get("role_key").map_err(Self::map_sqlx_error)?,
      row_kind_scope: row.try_get("row_kind_scope").map_err(Self::map_sqlx_error)?,
      field_id: row.try_get("field_id").map_err(Self::map_sqlx_error)?,
      required: row.try_get("required").map_err(Self::map_sqlx_error)?,
      config: row.try_get("config_json").map_err(Self::map_sqlx_error)?,
      created_at: row.try_get("created_at").map_err(Self::map_sqlx_error)?,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
    })
  }

  pub(in crate::workspace_database) fn map_view_role(row: sqlx::postgres::PgRow) -> RepoResult<DatabaseViewRole> {
    let profile_kind = DatabaseProfileKind::from_str(
      row
        .try_get::<String, _>("profile_kind")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Ok(DatabaseViewRole {
      database_id: row.try_get("database_id").map_err(Self::map_sqlx_error)?,
      profile_kind,
      role_key: row.try_get("role_key").map_err(Self::map_sqlx_error)?,
      view_id: row.try_get("view_id").map_err(Self::map_sqlx_error)?,
      required: row.try_get("required").map_err(Self::map_sqlx_error)?,
      created_at: row.try_get("created_at").map_err(Self::map_sqlx_error)?,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
    })
  }

  pub(in crate::workspace_database) fn map_field(row: sqlx::postgres::PgRow) -> RepoResult<DatabaseField> {
    let field_type = DatabaseFieldType::from_str(
      row
        .try_get::<String, _>("field_type")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let config_json: Value = row.try_get("config_json").map_err(Self::map_sqlx_error)?;
    let config = serde_json::from_value::<DatabaseFieldConfig>(config_json)
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Ok(DatabaseField {
      id: row.try_get("id").map_err(Self::map_sqlx_error)?,
      database_id: row.try_get("database_id").map_err(Self::map_sqlx_error)?,
      name: row.try_get("name").map_err(Self::map_sqlx_error)?,
      field_type,
      config,
      position: row.try_get("position").map_err(Self::map_sqlx_error)?,
      required: row.try_get("required").map_err(Self::map_sqlx_error)?,
      edit_revision: row.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
      created_at: row.try_get("created_at").map_err(Self::map_sqlx_error)?,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
    })
  }

  pub(in crate::workspace_database) async fn list_fields_for(
    executor: impl sqlx::Executor<'_, Database = Postgres>,
    database_id: DatabaseId,
  ) -> RepoResult<Vec<DatabaseField>> {
    let rows = sqlx::query(
      r#"
        SELECT id, database_id, name, field_type, config_json, position, required, edit_revision, created_at, updated_at
        FROM workspace_database_fields
        WHERE database_id = $1
        ORDER BY position ASC, id ASC
      "#,
    )
    .bind(database_id)
    .fetch_all(executor)
    .await
    .map_err(Self::map_snapshot_sqlx_error)?;

    rows.into_iter().map(Self::map_field).collect()
  }

  pub(in crate::workspace_database) async fn list_field_roles_for(
    executor: impl sqlx::Executor<'_, Database = Postgres>,
    database_id: DatabaseId,
  ) -> RepoResult<Vec<DatabaseFieldRole>> {
    let sql = format!(
      r#"
        SELECT database_id, profile_kind, role_key, row_kind_scope, field_id, required, config_json, created_at, updated_at
        FROM {DATABASE_FIELD_ROLES_TABLE}
        WHERE database_id = $1
        ORDER BY profile_kind ASC, role_key ASC, row_kind_scope ASC NULLS FIRST
      "#,
    );
    let rows = sqlx::query(&sql)
      .bind(database_id)
      .fetch_all(executor)
      .await
      .map_err(Self::map_snapshot_sqlx_error)?;

    rows.into_iter().map(Self::map_field_role).collect()
  }

  pub(in crate::workspace_database) async fn list_view_roles_for(
    executor: impl sqlx::Executor<'_, Database = Postgres>,
    database_id: DatabaseId,
  ) -> RepoResult<Vec<DatabaseViewRole>> {
    let sql = format!(
      r#"
        SELECT database_id, profile_kind, role_key, view_id, required, created_at, updated_at
        FROM {DATABASE_VIEW_ROLES_TABLE}
        WHERE database_id = $1
        ORDER BY role_key ASC
      "#,
    );
    let rows = sqlx::query(&sql)
      .bind(database_id)
      .fetch_all(executor)
      .await
      .map_err(Self::map_snapshot_sqlx_error)?;

    rows.into_iter().map(Self::map_view_role).collect()
  }

  #[instrument(skip(self), fields(database_id = %database_id, lifecycle = ?lifecycle))]
  pub(in crate::workspace_database) async fn get_record_with_lifecycle(
    &self,
    database_id: DatabaseId,
    lifecycle: DatabaseLifecycleFilter,
  ) -> RepoResult<Option<DatabaseRecord>> {
    let lifecycle = match lifecycle {
      DatabaseLifecycleFilter::Active => "active",
      DatabaseLifecycleFilter::Trashed => "trashed",
      DatabaseLifecycleFilter::Any => "any",
    };
    // Root installation, Fields and role bindings describe one admitted
    // generation even when an atomic forward update commits during this read.
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let Some(row) = sqlx::query(
      r#"
        SELECT
          d.system_role, d.managed_installation,
          d.id,
          d.workspace_id,
          COALESCE(p.profile_kind, 'generic') AS profile_kind,
          p.structure_preset AS profile_structure_preset,
          COALESCE(p.config_json, '{}'::jsonb) AS profile_config,
          d.title,
          d.description,
          d.created_by,
          d.updated_by,
          d.deleted_at,
          d.deleted_by,
          d.edit_revision,
          d.created_at,
          d.updated_at
        FROM workspace_databases d
        LEFT JOIN database_profiles p ON p.database_id = d.id
        WHERE d.id = $1
          AND ($2 = 'any'
            OR ($2 = 'active' AND d.deleted_at IS NULL)
            OR ($2 = 'trashed' AND d.deleted_at IS NOT NULL))
      "#,
    )
    .bind(database_id)
    .bind(lifecycle)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    else {
      return Ok(None);
    };

    let database = Self::map_database(row)?;
    let fields = Self::list_fields_for(&mut *tx, database_id).await?;
    let views = Self::list_views_for(&mut *tx, database_id).await?;
    let field_roles = Self::list_field_roles_for(&mut *tx, database_id).await?;
    let view_roles = Self::list_view_roles_for(&mut *tx, database_id).await?;
    let row_count = sqlx::query_scalar(
      "SELECT count(*)::bigint FROM workspace_database_rows WHERE database_id=$1 AND deleted_at IS NULL",
    )
    .bind(database_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    let mut record = DatabaseRecord {
      managed_schema: None,

      database,
      fields,
      views,
      field_roles,
      view_roles,
      row_count,
    };
    if let Some(installed) = record.database.managed_installation.as_mut() {
      let available = self
        .database_templates
        .current_source(&installed.template_id)
        .is_some_and(|(version, digest)| version == installed.template_version && digest == installed.template_digest);
      if !available {
        installed.readiness = DatabaseManagedSchemaReadiness::Unavailable;
        installed.reason_code = Some("MANAGED_SOURCE_UNAVAILABLE_ON_NODE".into());
      }
    }
    record.managed_schema = record.project_managed_schema();
    Ok(Some(record))
  }

  pub(in crate::workspace_database) async fn get_record(
    &self,
    database_id: DatabaseId,
  ) -> RepoResult<Option<DatabaseRecord>> {
    self
      .get_record_with_lifecycle(database_id, DatabaseLifecycleFilter::Active)
      .await
  }

  /// One malformed instance is reported by identity; transport/storage failures
  /// still fail the read rather than masquerading as unavailable product state.
  pub(in crate::workspace_database) async fn task_destination(
    &self,
    root: sqlx::postgres::PgRow,
    lifecycle: DatabaseLifecycleFilter,
  ) -> RepoResult<DatabaseTaskDestination> {
    let id = root.try_get("id").map_err(Self::map_sqlx_error)?;
    let reason = match self.get_record_with_lifecycle(id, lifecycle).await {
      Ok(Some(record)) => {
        if let Some(managed_schema) = record.managed_schema {
          return Ok(DatabaseTaskDestination {
            database_id: id,
            title: record.database.title,
            edit_revision: record.database.edit_revision,
            managed_schema,
          });
        }
        "MANAGED_PROFILE_UNAVAILABLE"
      }
      Ok(None) => "MANAGED_DATABASE_UNAVAILABLE",
      Err(RepositoryError::Validation(_)) => "MANAGED_INSTANCE_INVALID",
      Err(error) => return Err(error),
    };
    let raw: Option<Value> = root.try_get("managed_installation").map_err(Self::map_sqlx_error)?;
    let installation: Option<DatabaseManagedSchemaInstallation> =
      raw.and_then(|value| serde_json::from_value(value).ok());
    Ok(DatabaseTaskDestination {
      database_id: id,
      title: root.try_get("title").map_err(Self::map_sqlx_error)?,
      edit_revision: root.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
      managed_schema: DatabaseManagedSchema {
        readiness: DatabaseManagedSchemaReadiness::Unavailable,
        reason_code: Some(reason.into()),
        template_id: installation
          .as_ref()
          .map(|value| value.template_id.clone())
          .unwrap_or_default(),
        template_version: installation
          .as_ref()
          .map(|value| value.template_version.clone())
          .unwrap_or_default(),
        template_digest: installation
          .as_ref()
          .map(|value| value.template_digest.clone())
          .unwrap_or_default(),
        variant: installation
          .as_ref()
          .map(|value| value.variant.clone())
          .unwrap_or(DatabaseManagedSchemaVariant {
            priority: DatabaseProjectOptionPreset::ThreeStep,
            complexity: DatabaseProjectOptionPreset::ThreeStep,
            structure: DatabaseProjectStructurePreset::TasksOnly,
            currency: default_database_currency_code(),
          }),
        schema_revision: installation.as_ref().map(|value| value.schema_revision).unwrap_or(0),
        can_edit_structure: false,
        can_edit_metadata: false,
        can_manage_lifecycle: false,
        task_bindings: Vec::new(),
      },
    })
  }

  pub(crate) async fn capture_managed_admission(&self, tx: &mut Transaction<'_, Postgres>) -> RepoResult<()> {
    Self::capture_catalog_admission(tx, &self.database_templates).await
  }

  /// Caller-owned transactions admit only this node's validated immutable catalog.
  pub(crate) async fn capture_catalog_admission(
    tx: &mut sqlx::PgConnection,
    catalog: &myoxus_application::database::DatabaseStarterTemplateCatalog,
  ) -> RepoResult<()> {
    sqlx::query("SELECT set_config('myoxus.admitted_database_sources',$1,true)")
      .bind(
        serde_json::to_string(&catalog.admitted_sources())
          .map_err(|error| RepositoryError::Validation(error.to_string()))?,
      )
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  pub(in crate::workspace_database) async fn assert_root_management_admitted(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
  ) -> RepoResult<()> {
    let row=sqlx::query("SELECT d.system_role,COALESCE(p.profile_kind,'generic') AS profile_kind,myoxus_database_source_admitted(d.managed_installation) AS admitted FROM workspace_databases d LEFT JOIN database_profiles p ON p.database_id=d.id WHERE d.id=$1 FOR KEY SHARE OF d")
      .bind(database_id).fetch_optional(&mut **tx).await.map_err(Self::map_sqlx_error)?.ok_or(RepositoryError::NotFound("database"))?;
    if row.get::<Option<String>, _>("system_role").is_some()
      || (row.get::<String, _>("profile_kind") == "project" && !row.get::<bool, _>("admitted"))
    {
      return Err(RepositoryError::Validation(
        "managed database metadata or lifecycle is unavailable".into(),
      ));
    }
    Ok(())
  }

  pub(crate) async fn lock_managed_admission(tx: &mut sqlx::PgConnection, database_id: DatabaseId) -> RepoResult<()> {
    let row=sqlx::query("SELECT d.managed_installation,COALESCE(p.profile_kind,'generic') AS profile_kind FROM workspace_databases d LEFT JOIN database_profiles p ON p.database_id=d.id WHERE d.id=$1 AND d.deleted_at IS NULL FOR KEY SHARE OF d")
      .bind(database_id).fetch_optional(&mut *tx).await.map_err(Self::map_sqlx_error)?.ok_or(RepositoryError::NotFound("active database"))?;
    if row.get::<String, _>("profile_kind") == "generic" {
      return Ok(());
    }
    let installed: Option<Value> = row.get("managed_installation");
    let allowed: String =
      sqlx::query_scalar("SELECT COALESCE(NULLIF(current_setting('myoxus.admitted_database_sources',true),''),'[]')")
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
    let allowed: Vec<(String, String, String)> =
      serde_json::from_str(&allowed).map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let installed = installed.ok_or_else(|| RepositoryError::Validation("managed schema unavailable".into()))?;
    if installed["readiness"] != "ready"
      || !allowed.iter().any(|(id, version, digest)| {
        installed["templateId"] == *id
          && installed["templateVersion"] == *version
          && installed["templateDigest"] == *digest
      })
    {
      return Err(RepositoryError::Validation(
        "managed schema unavailable on this node".into(),
      ));
    }
    Ok(())
  }
}
#[async_trait]
impl DatabaseDefinitionRepository for PgDatabaseRepository {
  async fn published_workspace_ids(&self, after: Option<WorkspaceId>, limit: i64) -> RepoResult<Vec<WorkspaceId>> {
    sqlx::query_scalar("SELECT id FROM workspaces WHERE lifecycle_state='active' AND deleted_at IS NULL AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2")
      .bind(after).bind(limit.clamp(1,100)).fetch_all(&self.pool).await.map_err(Self::map_sqlx_error)
  }

  async fn managed_database_ids(&self, after: Option<DatabaseId>, limit: i64) -> RepoResult<Vec<DatabaseId>> {
    sqlx::query_scalar("SELECT d.id FROM workspace_databases d JOIN database_profiles p ON p.database_id=d.id AND p.profile_kind='project' WHERE ($1::uuid IS NULL OR d.id>$1) ORDER BY d.id LIMIT $2")
      .bind(after).bind(limit.clamp(1,100)).fetch_all(&self.pool).await.map_err(Self::map_sqlx_error)
  }

  async fn ensure_workspace_tasks(&self, state: DatabaseInitialState) -> RepoResult<DatabaseRecord> {
    let mut tx = self.begin_write().await?;
    let id = Self::ensure_workspace_tasks_in_tx(&mut tx, &self.database_templates, state).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    self
      .get_record_with_lifecycle(id, DatabaseLifecycleFilter::Any)
      .await?
      .ok_or(RepositoryError::NotFound("Workspace Tasks"))
  }

  async fn commit_managed_schema(
    &self,
    database_id: DatabaseId,
    expected_source: &DatabaseRecord,
    replacement: Option<DatabaseInitialState>,
    installation: DatabaseManagedSchemaInstallation,
  ) -> RepoResult<Vec<DatabaseRowId>> {
    self
      .commit_managed_schema_in_tx(database_id, expected_source, replacement, installation)
      .await
  }

  #[instrument(skip_all)]
  async fn create_database(&self, state: DatabaseInitialState) -> RepoResult<DatabaseRecord> {
    let mut tx = self.begin_write().await?;
    let record = Self::insert_initial_state_in_tx(&mut tx, state, None).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(record)
  }

  async fn get_database(&self, database_id: DatabaseId) -> RepoResult<Option<DatabaseRecord>> {
    self.get_record(database_id).await
  }

  async fn get_database_for_lifecycle(&self, database_id: DatabaseId) -> RepoResult<Option<DatabaseRecord>> {
    self
      .get_record_with_lifecycle(database_id, DatabaseLifecycleFilter::Any)
      .await
  }

  #[instrument(skip(self, title, description), fields(database_id = %database_id, updated_by = %updated_by))]
  async fn update_database(
    &self,
    database_id: DatabaseId,
    title: Option<String>,
    description: Option<Option<String>>,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRecord> {
    let mut tx = self.begin_write().await?;
    let actual_revision =
      Self::lock_entity_edit_revision(&mut tx, "workspace_databases", database_id, "database").await?;
    Self::assert_edit_precondition(actual_revision, precondition, "database edit revision")?;
    Self::assert_root_management_admitted(&mut tx, database_id).await?;
    let description_set = description.is_some();
    let description_value = description.flatten();
    let row = sqlx::query(
      r#"
        UPDATE workspace_databases
        SET title = COALESCE($2, title),
            description = CASE WHEN $3 THEN $4 ELSE description END,
            updated_by = $5,
            edit_revision = edit_revision + 1,
            updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id
      "#,
    )
    .bind(database_id)
    .bind(title)
    .bind(description_set)
    .bind(description_value)
    .bind(updated_by)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if row.is_none() {
      return Err(RepositoryError::NotFound("database"));
    }
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    self
      .get_record(database_id)
      .await?
      .ok_or(RepositoryError::NotFound("database"))
  }

  #[instrument(skip(self), fields(database_id = %database_id, deleted_by = %deleted_by))]
  async fn trash_database(
    &self,
    database_id: DatabaseId,
    deleted_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRecord> {
    let mut tx = self.begin_write().await?;
    let actual_revision =
      Self::lock_entity_edit_revision(&mut tx, "workspace_databases", database_id, "database").await?;
    Self::assert_edit_precondition(actual_revision, precondition, "database edit revision")?;
    Self::assert_root_management_admitted(&mut tx, database_id).await?;
    let result = sqlx::query(
      r#"
        UPDATE workspace_databases
        SET deleted_at = now(), deleted_by = $2, updated_by = $2,
            edit_revision = edit_revision + 1, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
      "#,
    )
    .bind(database_id)
    .bind(deleted_by)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if result.rows_affected() != 1 {
      return Err(RepositoryError::NotFound("active database"));
    }
    // Whole-Database Trash must invalidate queued Task generations too;
    // restoring the root never resurrects a personal reminder.
    Self::cancel_database_task_reminders(&mut tx, database_id).await?;
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    self
      .get_record_with_lifecycle(database_id, DatabaseLifecycleFilter::Trashed)
      .await?
      .ok_or(RepositoryError::NotFound("trashed database"))
  }

  #[instrument(skip(self), fields(database_id = %database_id, restored_by = %restored_by))]
  async fn restore_database(
    &self,
    database_id: DatabaseId,
    restored_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRecord> {
    let mut tx = self.begin_write().await?;
    let actual_revision =
      Self::lock_entity_edit_revision(&mut tx, "workspace_databases", database_id, "database").await?;
    Self::assert_edit_precondition(actual_revision, precondition, "database edit revision")?;
    Self::assert_root_management_admitted(&mut tx, database_id).await?;
    let result = sqlx::query(
      r#"
        UPDATE workspace_databases
        SET deleted_at = NULL, deleted_by = NULL, updated_by = $2,
            edit_revision = edit_revision + 1, updated_at = now()
        WHERE id = $1 AND deleted_at IS NOT NULL
      "#,
    )
    .bind(database_id)
    .bind(restored_by)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if result.rows_affected() != 1 {
      return Err(RepositoryError::NotFound("trashed database"));
    }
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    self
      .get_record(database_id)
      .await?
      .ok_or(RepositoryError::NotFound("active database"))
  }

  #[instrument(skip(self), fields(database_id = %database_id))]
  async fn purge_database(&self, database_id: DatabaseId, precondition: DatabaseEditPrecondition) -> RepoResult<()> {
    let mut tx = self.begin_write().await?;
    let actual_revision =
      Self::lock_entity_edit_revision(&mut tx, "workspace_databases", database_id, "database").await?;
    Self::assert_edit_precondition(actual_revision, precondition, "database edit revision")?;
    Self::assert_root_management_admitted(&mut tx, database_id).await?;
    // The owner row is the source for the transfer-safe workspace precondition.
    // Revalidate it before deletion; checking after the DELETE would turn every
    // authorized purge into a false NotFound and roll the transaction back.
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    let (system_role, trashed): (Option<String>, bool) =
      sqlx::query_as("SELECT system_role,deleted_at IS NOT NULL FROM workspace_databases WHERE id=$1")
        .bind(database_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
    if system_role.is_some() {
      return Err(RepositoryError::Validation(
        "workspace tasks container is protected".into(),
      ));
    }
    if !trashed {
      return Err(RepositoryError::NotFound("trashed database"));
    }
    // This bounded capability cannot authorize isolated schema edits or another
    // aggregate. The locked, already-trashed ordinary root owns its cascade.
    sqlx::query("SELECT set_config('myoxus.database_cleanup_id',$1,true)")
      .bind(database_id.to_string())
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    // Project role mappings intentionally restrict isolated Field/View deletion.
    // Remove their owning profile first so whole-Database deletion can cascade
    // without weakening those role invariants.
    sqlx::query("DELETE FROM database_profiles WHERE database_id = $1")
      .bind(database_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let result = sqlx::query("DELETE FROM workspace_databases WHERE id = $1 AND deleted_at IS NOT NULL")
      .bind(database_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("trashed database"));
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  async fn create_field(
    &self,
    field: DatabaseField,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseField> {
    let config_json = Self::map_field_config_to_json(&field.config)?;
    let mut tx = self.begin_write().await?;
    let row = sqlx::query(
      r#"
        INSERT INTO workspace_database_fields
          (id, database_id, name, field_type, config_json, position, required, edit_revision, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, database_id, name, field_type, config_json, position, required, edit_revision, created_at, updated_at
      "#,
    )
    .bind(field.id)
    .bind(field.database_id)
    .bind(field.name)
    .bind(field.field_type.as_str())
    .bind(config_json)
    .bind(field.position)
    .bind(field.required)
    .bind(field.edit_revision)
    .bind(field.created_at)
    .bind(field.updated_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let field = Self::map_field(row)?;
    Self::assert_database_workspace(&mut tx, field.database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(field)
  }

  async fn update_field(
    &self,
    field_id: DatabaseFieldId,
    name: Option<String>,
    config: Option<DatabaseFieldConfig>,
    required: Option<bool>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseField> {
    let mut tx = self.begin_write().await?;
    if config.is_some() {
      let database_id =
        sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_fields WHERE id=$1")
          .bind(field_id)
          .fetch_optional(&mut *tx)
          .await
          .map_err(Self::map_sqlx_error)?
          .ok_or(RepositoryError::NotFound("database field"))?;
      // Match Parent writers' DB-before-Field order before checking canonical
      // usage. Names and non-Parent fields keep their existing schema contract.
      Self::fence_task_relation_writers(&mut tx, database_id, &[field_id], false).await?;
    }
    let actual_revision =
      Self::lock_entity_edit_revision(&mut tx, "workspace_database_fields", field_id, "database field").await?;
    Self::assert_edit_precondition(actual_revision, precondition, "database field edit revision")?;
    if let Some(next_config) = config.as_ref() {
      let existing = sqlx::query(
        r#"SELECT field.database_id, field.config_json
        FROM workspace_database_fields field
        JOIN database_profiles profile ON profile.database_id = field.database_id AND profile.profile_kind = 'project'
        JOIN database_field_roles role ON role.database_id = field.database_id AND role.field_id = field.id
          AND role.role_key = 'task.status' AND role.row_kind_scope = 'task'
        WHERE field.id = $1"#,
      )
      .bind(field_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
      if let Some(existing) = existing {
        let DatabaseFieldConfig::Status(next) = next_config else {
          return Err(RepositoryError::Validation(
            "database project task status config invalid".into(),
          ));
        };
        validate_database_status_field_config(next).map_err(RepositoryError::Validation)?;
        let database_id: DatabaseId = existing.try_get("database_id").map_err(Self::map_sqlx_error)?;
        let current: DatabaseFieldConfig =
          serde_json::from_value(existing.try_get("config_json").map_err(Self::map_sqlx_error)?)
            .map_err(|error| RepositoryError::Validation(error.to_string()))?;
        let DatabaseFieldConfig::Status(current) = current else {
          return Err(RepositoryError::Validation(
            "database project task status config invalid".into(),
          ));
        };
        validate_database_status_field_config(&current).map_err(RepositoryError::Validation)?;
        let used_ids = sqlx::query_scalar::<_, String>(
          r#"SELECT DISTINCT cell.value_json #>> '{}'
          FROM workspace_database_cell_values cell
          JOIN workspace_database_rows row ON row.id = cell.row_id AND row.database_id = $2 AND row.row_kind = 'task'
          WHERE cell.field_id = $1 AND jsonb_typeof(cell.value_json) = 'string'"#,
        )
        .bind(field_id)
        .bind(database_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
        validate_project_task_status_config_update(&current, next, &used_ids).map_err(RepositoryError::Validation)?;
      }
    }
    if let Some(next) = config.as_ref() {
      let field=sqlx::query("SELECT field.database_id,field.field_type,field.config_json,
        EXISTS(SELECT 1 FROM database_profiles profile WHERE profile.database_id=field.database_id AND profile.profile_kind='project') AS is_project
        FROM workspace_database_fields field WHERE field.id=$1")
        .bind(field_id).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
      let database_id: DatabaseId = field.try_get("database_id").map_err(Self::map_sqlx_error)?;
      let roles = Self::list_field_roles_for(&mut *tx, database_id).await?;
      let role_iter = || {
        roles
          .iter()
          .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id))
      };
      if field.try_get::<bool, _>("is_project").map_err(Self::map_sqlx_error)?
        && field.try_get::<String, _>("field_type").map_err(Self::map_sqlx_error)? == "relation"
        && ((task_parent_field(role_iter()) == Some(field_id)
          && !task_parent_has_conflicting_task_role(field_id, role_iter()))
          || (task_blocked_by_field(role_iter()) == Some(field_id)
            && !task_blocked_by_has_conflicting_task_role(field_id, role_iter())))
      {
        let active: bool = sqlx::query_scalar(
          r#"SELECT EXISTS (
          SELECT 1 FROM workspace_database_cell_values cell
          JOIN workspace_database_rows row ON row.id=cell.row_id AND row.row_kind='task'
          WHERE row.database_id=$1 AND cell.field_id=$2
            AND cell.value_json IS NOT NULL AND cell.value_json NOT IN ('null'::jsonb,'[]'::jsonb)
        ) OR EXISTS (
          SELECT 1 FROM workspace_database_row_templates template
          WHERE $3::boolean AND template.database_id=$1 AND template.row_kind='task'
            AND template.initial_cell_values_json->$2::text IS NOT NULL
            AND template.initial_cell_values_json->$2::text NOT IN ('null'::jsonb,'[]'::jsonb)
        )"#,
        )
        .bind(database_id)
        .bind(field_id)
        .bind(task_blocked_by_field(role_iter()) == Some(field_id))
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
        let current: DatabaseFieldConfig =
          serde_json::from_value(field.try_get("config_json").map_err(Self::map_sqlx_error)?)
            .map_err(|error| RepositoryError::Validation(error.to_string()))?;
        let blocked = task_blocked_by_field(role_iter()) == Some(field_id);
        let compatible = |config: &DatabaseFieldConfig| {
          if blocked {
            task_blocked_by_config_compatible(database_id, config)
          } else {
            task_parent_config_compatible(database_id, config)
          }
        };
        if active && current != *next && !(compatible(&current) && compatible(next)) {
          return Err(RepositoryError::Validation(
            DatabaseTaskRelationReason::IncompatibleRoleConfiguration.validation_message(),
          ));
        }
        if active
          && blocked
          && current != *next
          && let DatabaseFieldConfig::Relation(config) = next
        {
          let max = if config.allow_multiple {
            config.max_targets.map(i64::from)
          } else {
            Some(1)
          };
          if let Some(max) = max {
            let too_many: bool = sqlx::query_scalar(
              r#"SELECT EXISTS (
              SELECT 1 FROM workspace_database_cell_values cell
              JOIN workspace_database_rows row ON row.id=cell.row_id AND row.database_id=$1 AND row.row_kind='task'
              WHERE cell.field_id=$2 AND CASE WHEN jsonb_typeof(cell.value_json)='array'
                THEN jsonb_array_length(cell.value_json)>$3 ELSE false END
            ) OR EXISTS (
              SELECT 1 FROM workspace_database_row_templates template
              WHERE template.database_id=$1 AND template.row_kind='task'
                AND CASE WHEN jsonb_typeof(template.initial_cell_values_json->$2::text)='array'
                  THEN jsonb_array_length(template.initial_cell_values_json->$2::text)>$3 ELSE false END
            )"#,
            )
            .bind(database_id)
            .bind(field_id)
            .bind(max)
            .fetch_one(&mut *tx)
            .await
            .map_err(Self::map_sqlx_error)?;
            if too_many {
              return Err(RepositoryError::Validation(
                DatabaseTaskRelationReason::IncompatibleRoleConfiguration.validation_message(),
              ));
            }
          }
        }
      }
    }
    let config_json = config.as_ref().map(Self::map_field_config_to_json).transpose()?;
    let row = sqlx::query(
      r#"
        UPDATE workspace_database_fields
        SET name = COALESCE($2, name),
            config_json = COALESCE($3, config_json),
            required = COALESCE($4, required),
            edit_revision = edit_revision + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING id, database_id, name, field_type, config_json, position, required, edit_revision, created_at, updated_at
      "#,
    )
    .bind(field_id)
    .bind(name)
    .bind(config_json)
    .bind(required)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database field"))?;
    let field = Self::map_field(row)?;
    if matches!(
      &field.config,
      DatabaseFieldConfig::DateTime(config) if !config.allow_reminders
    ) {
      Self::cancel_field_reminders(&mut tx, field_id).await?;
    }
    Self::assert_database_workspace(&mut tx, field.database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(field)
  }

  async fn delete_field(&self, field_id: DatabaseFieldId, precondition: DatabaseEditPrecondition) -> RepoResult<()> {
    let mut tx = self.begin_write().await?;
    let database_id =
      sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_fields WHERE id = $1")
        .bind(field_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::NotFound("database field"))?;
    Self::fence_task_relation_writers(&mut tx, database_id, &[field_id], false).await?;
    let actual_revision =
      Self::lock_entity_edit_revision(&mut tx, "workspace_database_fields", field_id, "database field").await?;
    Self::assert_edit_precondition(actual_revision, precondition, "database field edit revision")?;
    // Templates retain only live schema keys. Use the native DB/field/template
    // lock order and advance the affected content template's revision.
    sqlx::query(
      r#"
      UPDATE workspace_database_row_templates
         SET initial_cell_values_json = initial_cell_values_json - $2::text,
             edit_revision = edit_revision + 1,
             updated_at = now()
       WHERE database_id = $1 AND initial_cell_values_json ? $2::text
    "#,
    )
    .bind(database_id)
    .bind(field_id.to_string())
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    // Optional semantic roles belong to the field lifecycle. Removing their
    // mappings in the same transaction keeps the restrictive role FK useful
    // while preventing a partially deleted Project schema.
    sqlx::query("DELETE FROM database_field_roles WHERE database_id = $1 AND field_id = $2 AND required = FALSE")
      .bind(database_id)
      .bind(field_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let result = sqlx::query("DELETE FROM workspace_database_fields WHERE id = $1")
      .bind(field_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("database field"));
    }
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  async fn reorder_fields(
    &self,
    database_id: DatabaseId,
    field_ids: Vec<DatabaseFieldId>,
    expected_edit_revisions: &HashMap<DatabaseFieldId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<DatabaseField>> {
    let mut tx = self.begin_write().await?;
    let locked = sqlx::query(
      r#"
        SELECT id, edit_revision
        FROM workspace_database_fields
        WHERE database_id = $1
        ORDER BY id
        FOR UPDATE
      "#,
    )
    .bind(database_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let locked_ids = locked
      .iter()
      .map(|row| row.try_get::<DatabaseFieldId, _>("id").map_err(Self::map_sqlx_error))
      .collect::<RepoResult<std::collections::HashSet<_>>>()?;
    let requested_ids = field_ids.iter().copied().collect::<std::collections::HashSet<_>>();
    if locked_ids != requested_ids || requested_ids.len() != field_ids.len() {
      return Err(RepositoryError::Validation(
        "field reorder must include every field exactly once".to_string(),
      ));
    }
    for row in &locked {
      let field_id: DatabaseFieldId = row.try_get("id").map_err(Self::map_sqlx_error)?;
      let revision: i64 = row.try_get("edit_revision").map_err(Self::map_sqlx_error)?;
      if !force
        && expected_edit_revisions
          .get(&field_id)
          .is_some_and(|expected| *expected != revision)
      {
        return Err(RepositoryError::Conflict("database field edit revision"));
      }
    }
    let result = sqlx::query(
      r#"
        UPDATE workspace_database_fields field
        SET position = ordered.ordinality::int - 1,
            edit_revision = field.edit_revision + 1,
            updated_at = now()
        FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, ordinality)
        WHERE field.database_id = $1 AND field.id = ordered.id
      "#,
    )
    .bind(database_id)
    .bind(&field_ids)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if result.rows_affected() != field_ids.len() as u64 {
      return Err(RepositoryError::NotFound("database field"));
    }
    let fields = Self::list_fields_for(&mut *tx, database_id).await?;
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(fields)
  }
}
