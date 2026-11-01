// SPDX-License-Identifier: AGPL-3.0-or-later
mod definitions;
pub(super) mod query;
mod state;
mod tasks;
use crate::workspace_database::*;
const DATABASE_PAGE_INVENTORY_SQL: &str = r#"
  SELECT
    d.system_role,
    d.id,
    COALESCE(p.profile_kind, 'generic') AS profile_kind,
    d.title,
    d.description,
    d.deleted_at,
    d.edit_revision,
    d.created_at,
    d.updated_at
  FROM workspace_databases d
  LEFT JOIN database_profiles p ON p.database_id = d.id
  WHERE d.workspace_id = $1 AND d.system_role IS NULL
    AND ($2 = 'any'
      OR ($2 = 'active' AND d.deleted_at IS NULL)
      OR ($2 = 'trashed' AND d.deleted_at IS NOT NULL))
  ORDER BY d.updated_at DESC, d.id ASC
  LIMIT $3 OFFSET $4
"#;

#[derive(Clone, Copy, Default)]
struct DatabaseQueryShape {
  filter_group_count: usize,
  filter_max_depth: usize,
  operator_count: usize,
}

fn database_query_shape(query: &DatabaseRowsQuery) -> DatabaseQueryShape {
  fn visit(group: &DatabaseFilterGroup, depth: usize, shape: &mut DatabaseQueryShape) {
    shape.filter_group_count += 1;
    shape.filter_max_depth = shape.filter_max_depth.max(depth);
    shape.operator_count += group.rules.len();
    for child in &group.groups {
      visit(child, depth + 1, shape);
    }
  }

  let mut shape = DatabaseQueryShape {
    operator_count: query.filter.len(),
    ..Default::default()
  };
  if let Some(group) = &query.filter_tree {
    visit(group, 1, &mut shape);
  }
  shape
}

impl PgDatabaseRepository {
  pub(in crate::workspace_database) fn map_database_summary(row: sqlx::postgres::PgRow) -> RepoResult<DatabaseSummary> {
    let profile_kind = DatabaseProfileKind::from_str(
      row
        .try_get::<String, _>("profile_kind")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Ok(DatabaseSummary {
      system_role: match row
        .try_get::<Option<String>, _>("system_role")
        .map_err(Self::map_sqlx_error)?
        .as_deref()
      {
        None => None,
        Some("workspace_tasks") => Some(DatabaseSystemRole::WorkspaceTasks),
        Some(_) => return Err(RepositoryError::Validation("unknown Database system role".into())),
      },
      id: row.try_get("id").map_err(Self::map_sqlx_error)?,
      workspace_id: row.try_get("workspace_id").map_err(Self::map_sqlx_error)?,
      profile_kind,
      profile_structure_preset: row.try_get("profile_structure_preset").map_err(Self::map_sqlx_error)?,
      title: row.try_get("title").map_err(Self::map_sqlx_error)?,
      description: row.try_get("description").map_err(Self::map_sqlx_error)?,
      deleted_at: row.try_get("deleted_at").map_err(Self::map_sqlx_error)?,
      edit_revision: row.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
      created_at: row.try_get("created_at").map_err(Self::map_sqlx_error)?,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
      row_count: row.try_get("row_count").map_err(Self::map_sqlx_error)?,
      field_count: row.try_get("field_count").map_err(Self::map_sqlx_error)?,
      view_count: row.try_get("view_count").map_err(Self::map_sqlx_error)?,
    })
  }

  pub(in crate::workspace_database) fn map_database_page_identity(
    row: sqlx::postgres::PgRow,
  ) -> RepoResult<DatabasePageIdentity> {
    let profile_kind = DatabaseProfileKind::from_str(
      row
        .try_get::<String, _>("profile_kind")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Ok(DatabasePageIdentity {
      system_role: match row
        .try_get::<Option<String>, _>("system_role")
        .map_err(Self::map_sqlx_error)?
        .as_deref()
      {
        None => None,
        Some("workspace_tasks") => Some(DatabaseSystemRole::WorkspaceTasks),
        Some(_) => return Err(RepositoryError::Validation("unknown Database system role".into())),
      },
      id: row.try_get("id").map_err(Self::map_sqlx_error)?,
      profile_kind,
      title: row.try_get("title").map_err(Self::map_sqlx_error)?,
      description: row.try_get("description").map_err(Self::map_sqlx_error)?,
      deleted_at: row.try_get("deleted_at").map_err(Self::map_sqlx_error)?,
      edit_revision: row.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
      created_at: row.try_get("created_at").map_err(Self::map_sqlx_error)?,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
    })
  }
}
#[async_trait]
impl DatabaseViewRepository for PgDatabaseRepository {
  async fn promote_view_user_state(
    &self,
    view_id: DatabaseViewId,
    user_id: UserId,
    config: DatabaseViewConfig,
    expected_view_edit_revision: i64,
    expected_state_edit_revision: i64,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseView> {
    self
      .persist_promote_view_user_state(
        view_id,
        user_id,
        config,
        expected_view_edit_revision,
        expected_state_edit_revision,
        precondition,
      )
      .await
  }
  async fn reset_view_user_state(
    &self,
    view_id: DatabaseViewId,
    user_id: UserId,
    expected_edit_revision: Option<i64>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<()> {
    self
      .persist_reset_view_user_state(view_id, user_id, expected_edit_revision, precondition)
      .await
  }
  async fn upsert_view_user_state(
    &self,
    state: DatabaseViewUserState,
    expected_edit_revision: Option<i64>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseViewUserState> {
    self
      .persist_upsert_view_user_state(state, expected_edit_revision, precondition)
      .await
  }
  async fn get_view_user_state(
    &self,
    view_id: DatabaseViewId,
    user_id: UserId,
  ) -> RepoResult<Option<DatabaseViewUserState>> {
    self.persist_get_view_user_state(view_id, user_id).await
  }
  async fn reorder_views(
    &self,
    database_id: DatabaseId,
    view_ids: Vec<DatabaseViewId>,
    expected_edit_revisions: &HashMap<DatabaseViewId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<DatabaseView>> {
    self
      .persist_reorder_views(database_id, view_ids, expected_edit_revisions, force, precondition)
      .await
  }
  async fn delete_view(
    &self,
    view_id: DatabaseViewId,
    precondition: DatabaseEditPrecondition,
    replacement_role: Option<DatabaseViewRole>,
  ) -> RepoResult<()> {
    self.persist_delete_view(view_id, precondition, replacement_role).await
  }
  async fn update_view(
    &self,
    view_id: DatabaseViewId,
    name: Option<String>,
    view_kind: Option<DatabaseViewKind>,
    icon: Option<Option<DatabaseViewIcon>>,
    config: Option<DatabaseViewConfig>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseView> {
    self
      .persist_update_view(view_id, name, view_kind, icon, config, precondition)
      .await
  }
  async fn create_view(&self, view: DatabaseView, precondition: DatabaseEditPrecondition) -> RepoResult<DatabaseView> {
    self.persist_create_view(view, precondition).await
  }
  async fn task_destinations(
    &self,
    workspace_id: WorkspaceId,
    first: i64,
    after: Option<DatabaseId>,
  ) -> RepoResult<DatabaseTaskDestinations> {
    let default_row = sqlx::query("SELECT id,title,edit_revision,managed_installation FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks'")
      .bind(workspace_id).fetch_optional(&self.pool).await.map_err(Self::map_sqlx_error)?;
    let default_destination = if let Some(row) = default_row {
      Some(self.task_destination(row, DatabaseLifecycleFilter::Any).await?)
    } else {
      None
    };
    let first = first.clamp(1, 100) as usize;
    let mut roots = sqlx::query("SELECT d.id,d.title,d.edit_revision,d.managed_installation FROM workspace_databases d JOIN database_profiles p ON p.database_id=d.id AND p.profile_kind='project' WHERE d.workspace_id=$1 AND d.system_role IS NULL AND d.deleted_at IS NULL AND ($2::uuid IS NULL OR d.id>$2) ORDER BY d.id LIMIT $3")
      .bind(workspace_id).bind(after).bind(first as i64+1).fetch_all(&self.pool).await.map_err(Self::map_sqlx_error)?;
    let more = roots.len() > first;
    if more {
      roots.truncate(first);
    }
    let next_cursor = if more {
      roots.last().map(|row| row.get::<Uuid, _>("id"))
    } else {
      None
    };
    let mut projects = Vec::new();
    let mut unavailable_projects = Vec::new();
    for row in roots {
      let destination = self.task_destination(row, DatabaseLifecycleFilter::Active).await?;
      if destination.managed_schema.readiness == DatabaseManagedSchemaReadiness::Unavailable {
        unavailable_projects.push(DatabaseUnavailableProject {
          database_id: destination.database_id,
          title: destination.title.clone(),
          reason_code: destination
            .managed_schema
            .reason_code
            .clone()
            .unwrap_or_else(|| "MANAGED_SCHEMA_UNAVAILABLE".into()),
        });
      }
      projects.push(destination);
    }
    let coverage_complete = !more
      && unavailable_projects.is_empty()
      && default_destination
        .as_ref()
        .is_some_and(|destination| destination.managed_schema.readiness == DatabaseManagedSchemaReadiness::Ready);
    Ok(DatabaseTaskDestinations {
      default_destination,
      projects,
      next_cursor,
      unavailable_projects,
      coverage_complete,
    })
  }

  #[instrument(skip_all)]
  async fn task_children(&self, read: DatabaseTaskChildrenRead) -> RepoResult<DatabaseTaskChildrenPage> {
    self.read_task_children(read).await
  }

  async fn task_blocking(&self, read: DatabaseTaskBlockingRead) -> RepoResult<DatabaseTaskBlockingPage> {
    self.read_task_blocking(read).await
  }

  async fn task_parent(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
  ) -> RepoResult<DatabaseTaskParentProjection> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    // Capability and legacy diagnostics describe one schema/Cell/Row snapshot.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let field = sqlx::query_scalar::<_, DatabaseFieldId>(
      r#"
        SELECT role.field_id
        FROM database_field_roles role
        JOIN database_profiles profile
        ON profile.database_id=role.database_id
        WHERE role.database_id=$1
        AND role.role_key='task.parent'
        AND profile.profile_kind='project'
        ORDER BY CASE WHEN role.row_kind_scope='task' THEN 0 ELSE 1 END,
                 COALESCE(role.row_kind_scope,''), role.field_id
        LIMIT 1
      "#,
    )
    .bind(database_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let Some(field_id) = field else {
      tx.commit().await.map_err(Self::map_sqlx_error)?;
      return Ok(DatabaseTaskParentProjection {
        available: false,
        field_id: None,
        parent_row_ids: Vec::new(),
        diagnostics: vec![DatabaseTaskRelationReason::MissingRole],
      });
    };
    let config = sqlx::query_scalar::<_, Value>(
      r#"
        SELECT field.config_json
        FROM workspace_database_fields field
        JOIN database_field_roles role
        ON role.field_id=field.id
        AND role.database_id=field.database_id
        WHERE field.id=$1
        AND field.database_id=$2
        AND role.role_key='task.parent'
        AND role.row_kind_scope='task'
        AND field.field_type='relation'
      "#,
    )
    .bind(field_id)
    .bind(database_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let roles = Self::list_field_roles_for(&mut *tx, database_id).await?;
    let parent_alias = task_parent_has_conflicting_task_role(
      field_id,
      roles
        .iter()
        .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id)),
    );
    let config_available = !parent_alias
      && config
        .and_then(|value| serde_json::from_value::<DatabaseFieldConfig>(value).ok())
        .is_some_and(|config| task_parent_config_compatible(database_id, &config));
    let graph = Self::load_task_relation_graph(&mut tx, database_id, field_id).await?;
    let is_task = graph
      .rows
      .get(&row_id)
      .is_some_and(|(scope, kind, _)| *scope == database_id && *kind == DatabaseRowKind::Task);
    let available = config_available && is_task;
    let mut diagnostics = graph.diagnostics(database_id, row_id);
    if !config_available {
      diagnostics.insert(0, DatabaseTaskRelationReason::IncompatibleRoleConfiguration);
    }
    if !is_task && !diagnostics.contains(&DatabaseTaskRelationReason::WrongRowKind) {
      diagnostics.push(DatabaseTaskRelationReason::WrongRowKind);
    }
    let projection = DatabaseTaskParentProjection {
      available,
      field_id: Some(field_id),
      parent_row_ids: graph.edges.get(&row_id).cloned().unwrap_or_default(),
      diagnostics,
    };
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(projection)
  }

  async fn list_workspace_tasks(&self, read: DatabaseTasksRead) -> RepoResult<DatabaseTasksPage> {
    self.read_workspace_tasks(read).await
  }

  async fn list_workspace_task_references(
    &self,
    read: DatabaseTaskReferencesRead,
  ) -> RepoResult<Vec<DatabaseTaskReferenceRecord>> {
    self.read_workspace_task_references(read).await
  }

  #[instrument(skip(self), fields(workspace_id = %workspace_id, limit = page.limit, offset = page.offset))]
  async fn list_database_page_identities(
    &self,
    workspace_id: WorkspaceId,
    page: PageRequest,
    lifecycle: DatabaseLifecycleFilter,
  ) -> RepoResult<Vec<DatabasePageIdentity>> {
    let lifecycle = match lifecycle {
      DatabaseLifecycleFilter::Active => "active",
      DatabaseLifecycleFilter::Trashed => "trashed",
      DatabaseLifecycleFilter::Any => "any",
    };
    let rows = sqlx::query(DATABASE_PAGE_INVENTORY_SQL)
      .bind(workspace_id)
      .bind(lifecycle)
      .bind(page.limit)
      .bind(page.offset)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_sqlx_error)?;

    rows.into_iter().map(Self::map_database_page_identity).collect()
  }

  #[instrument(skip(self), fields(workspace_id = %workspace_id), err)]
  async fn database_page_inventory_revision(&self, workspace_id: WorkspaceId) -> RepoResult<i64> {
    sqlx::query_scalar(
      "SELECT COALESCE(r.revision, 0) FROM (SELECT $1::uuid AS workspace_id) seed LEFT JOIN workspace_database_page_inventory_revision r USING (workspace_id)",
    )
    .bind(workspace_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)
  }

  #[instrument(skip(self), fields(workspace_id = %workspace_id, limit = page.limit, offset = page.offset), err)]
  async fn list_database_page_identities_versioned(
    &self,
    workspace_id: WorkspaceId,
    page: PageRequest,
    lifecycle: DatabaseLifecycleFilter,
  ) -> RepoResult<DatabasePageIdentitySnapshot> {
    let lifecycle = match lifecycle {
      DatabaseLifecycleFilter::Active => "active",
      DatabaseLifecycleFilter::Trashed => "trashed",
      DatabaseLifecycleFilter::Any => "any",
    };
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let revision = sqlx::query_scalar(
      "SELECT COALESCE(r.revision, 0) FROM (SELECT $1::uuid AS workspace_id) seed LEFT JOIN workspace_database_page_inventory_revision r USING (workspace_id)",
    )
    .bind(workspace_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let rows = sqlx::query(DATABASE_PAGE_INVENTORY_SQL)
      .bind(workspace_id)
      .bind(lifecycle)
      .bind(page.limit)
      .bind(page.offset)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(DatabasePageIdentitySnapshot {
      revision,
      rows: rows
        .into_iter()
        .map(Self::map_database_page_identity)
        .collect::<RepoResult<Vec<_>>>()?,
    })
  }

  #[instrument(skip(self, filter), fields(workspace_id = %workspace_id, limit = page.limit, offset = page.offset))]
  async fn list_databases(
    &self,
    workspace_id: WorkspaceId,
    page: PageRequest,
    filter: DatabaseInventoryFilter,
  ) -> RepoResult<Vec<DatabaseSummary>> {
    let sort = match filter.sort {
      DatabaseInventorySort::UpdatedDesc => "updated_desc",
      DatabaseInventorySort::TitleAsc => "title_asc",
      DatabaseInventorySort::TitleDesc => "title_desc",
    };
    let profile_kind = filter.profile_kind.map(DatabaseProfileKind::as_str);
    let lifecycle = match filter.lifecycle {
      DatabaseLifecycleFilter::Active => "active",
      DatabaseLifecycleFilter::Trashed => "trashed",
      DatabaseLifecycleFilter::Any => "any",
    };
    let rows = sqlx::query(
      r#"
        WITH inventory_page AS MATERIALIZED (
          SELECT
            d.id,
            d.workspace_id,
            d.system_role,
            COALESCE(p.profile_kind, 'generic') AS profile_kind,
            p.structure_preset AS profile_structure_preset,
            d.title,
            d.description,
            d.deleted_at,
            d.edit_revision,
            d.created_at,
            d.updated_at
          FROM workspace_databases d
          LEFT JOIN database_profiles p ON p.database_id = d.id
          WHERE d.workspace_id = $1 AND d.system_role IS NULL
            AND ($8 = 'any'
              OR ($8 = 'active' AND d.deleted_at IS NULL)
              OR ($8 = 'trashed' AND d.deleted_at IS NOT NULL))
            AND (
              $2::text IS NULL
              OR strpos(lower(d.title), lower($2)) > 0
              OR strpos(lower(COALESCE(d.description, '')), lower($2)) > 0
            )
            AND ($3::text IS NULL OR COALESCE(p.profile_kind, 'generic') = $3)
            AND ($4::uuid[] IS NULL OR d.id = ANY($4))
          ORDER BY
            CASE WHEN $5 = 'title_asc' THEN lower(d.title) END ASC NULLS LAST,
            CASE WHEN $5 = 'title_desc' THEN lower(d.title) END DESC NULLS LAST,
            CASE WHEN $5 = 'updated_desc' THEN d.updated_at END DESC NULLS LAST,
            d.id ASC
          LIMIT $6 OFFSET $7
        ),
        row_counts AS (
          SELECT r.database_id, count(*)::bigint AS row_count
          FROM workspace_database_rows r
          JOIN inventory_page page ON page.id = r.database_id
          WHERE r.deleted_at IS NULL
          GROUP BY r.database_id
        ),
        field_counts AS (
          SELECT f.database_id, count(*)::bigint AS field_count
          FROM workspace_database_fields f
          JOIN inventory_page page ON page.id = f.database_id
          GROUP BY f.database_id
        ),
        view_counts AS (
          SELECT v.database_id, count(*)::bigint AS view_count
          FROM workspace_database_views v
          JOIN inventory_page page ON page.id = v.database_id
          GROUP BY v.database_id
        )
        SELECT
          page.*,
          COALESCE(rows.row_count, 0)::bigint AS row_count,
          COALESCE(fields.field_count, 0)::bigint AS field_count,
          COALESCE(views.view_count, 0)::bigint AS view_count
        FROM inventory_page page
        LEFT JOIN row_counts rows ON rows.database_id = page.id
        LEFT JOIN field_counts fields ON fields.database_id = page.id
        LEFT JOIN view_counts views ON views.database_id = page.id
        ORDER BY
          CASE WHEN $5 = 'title_asc' THEN lower(page.title) END ASC NULLS LAST,
          CASE WHEN $5 = 'title_desc' THEN lower(page.title) END DESC NULLS LAST,
          CASE WHEN $5 = 'updated_desc' THEN page.updated_at END DESC NULLS LAST,
          page.id ASC
      "#,
    )
    .bind(workspace_id)
    .bind(filter.search.as_deref())
    .bind(profile_kind)
    .bind(filter.database_ids.as_deref())
    .bind(sort)
    .bind(page.limit)
    .bind(page.offset)
    .bind(lifecycle)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;

    rows.into_iter().map(Self::map_database_summary).collect()
  }

  async fn get_database_summary(
    &self,
    database_id: DatabaseId,
    lifecycle: DatabaseLifecycleFilter,
  ) -> RepoResult<Option<DatabaseSummary>> {
    let lifecycle = match lifecycle {
      DatabaseLifecycleFilter::Active => "active",
      DatabaseLifecycleFilter::Trashed => "trashed",
      DatabaseLifecycleFilter::Any => "any",
    };
    let row = sqlx::query(
      r#"
        SELECT
          d.id,
          d.workspace_id,
            d.system_role,
          COALESCE(p.profile_kind, 'generic') AS profile_kind,
          p.structure_preset AS profile_structure_preset,
          d.title,
          d.description,
          d.deleted_at,
          d.edit_revision,
          d.created_at,
          d.updated_at,
          (SELECT count(*)::bigint FROM workspace_database_rows r
            WHERE r.database_id = d.id AND r.deleted_at IS NULL) AS row_count,
          (SELECT count(*)::bigint FROM workspace_database_fields f
            WHERE f.database_id = d.id) AS field_count,
          (SELECT count(*)::bigint FROM workspace_database_views v
            WHERE v.database_id = d.id) AS view_count
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
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    row.map(Self::map_database_summary).transpose()
  }

  async fn list_database_scopes(&self, page: PageRequest) -> RepoResult<Vec<(WorkspaceId, DatabaseId)>> {
    sqlx::query_as(
      "SELECT workspace_id, id FROM workspace_databases WHERE deleted_at IS NULL ORDER BY workspace_id, id LIMIT $1 OFFSET $2",
    )
      .bind(page.limit.clamp(1, DATABASE_MAX_ROWS_PER_PAGE))
      .bind(page.offset.max(0))
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_sqlx_error)
  }

  /// Executes the complete validated view query before pagination.
  /// Count and row reads share one repeatable-read transaction; unsupported
  /// plans fail instead of falling back to an unbounded Application scan.
  async fn list_rows_filtered_paged(
    &self,
    database_id: DatabaseId,
    actor_id: UserId,
    query: DatabaseRowsQuery,
    page: PageRequest,
  ) -> RepoResult<DatabaseFilteredRowsPage> {
    let limit = page.limit.clamp(1, DATABASE_MAX_ROWS_PER_PAGE);
    let offset = page.offset.max(0);
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let fields = Self::list_fields_for(&mut *tx, database_id).await?;
    let query_shape = database_query_shape(&query);
    let plan = DatabaseRowQueryPlan::compile(&query, limit, offset, actor_id, &fields, DATABASE_QUERY_TABLES)?;
    let started_at = std::time::Instant::now();

    let count_sql = plan.count_sql();
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql).bind(database_id);
    for bind in plan.predicate_binds() {
      count_query = match bind {
        DatabaseRowQueryBind::Uuid(value) => count_query.bind(*value),
        DatabaseRowQueryBind::Text(value) => count_query.bind(value.clone()),
        DatabaseRowQueryBind::TextArray(value) => count_query.bind(value.clone()),
        DatabaseRowQueryBind::Bool(value) => count_query.bind(*value),
        DatabaseRowQueryBind::F64(value) => count_query.bind(*value),
        DatabaseRowQueryBind::I64(value) => count_query.bind(*value),
        DatabaseRowQueryBind::Json(value) => count_query.bind(value.clone()),
      };
    }
    let total_count = count_query.fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;

    let rows_sql = plan.rows_sql();
    let mut row_query = sqlx::query(&rows_sql).bind(database_id);
    for bind in plan.row_binds() {
      row_query = match bind {
        DatabaseRowQueryBind::Uuid(value) => row_query.bind(value),
        DatabaseRowQueryBind::Text(value) => row_query.bind(value),
        DatabaseRowQueryBind::TextArray(value) => row_query.bind(value),
        DatabaseRowQueryBind::Bool(value) => row_query.bind(value),
        DatabaseRowQueryBind::F64(value) => row_query.bind(value),
        DatabaseRowQueryBind::I64(value) => row_query.bind(value),
        DatabaseRowQueryBind::Json(value) => row_query.bind(value),
      };
    }
    let rows = row_query.fetch_all(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    let mut records = rows
      .into_iter()
      .map(Self::map_row)
      .collect::<RepoResult<Vec<_>>>()?
      .into_iter()
      .map(|row| DatabaseRowRecord {
        row,
        cells: Vec::new(),
        cell_revisions: Vec::new(),
      })
      .collect::<Vec<_>>();
    let record_indexes = records
      .iter()
      .enumerate()
      .map(|(index, record)| (record.row.id, index))
      .collect::<HashMap<_, _>>();
    let row_ids = records.iter().map(|record| record.row.id).collect::<Vec<_>>();
    if row_ids.is_empty() {
      tx.commit().await.map_err(Self::map_sqlx_error)?;
      debug!(
        database_id = %database_id,
        view_id = ?query.view_id,
        operator_count = query_shape.operator_count,
        filter_group_count = query_shape.filter_group_count,
        filter_max_depth = query_shape.filter_max_depth,
        sort_count = query.sort.len(),
        has_search = query.search.as_ref().is_some_and(|value| !value.trim().is_empty()),
        requested_page_size = limit,
        elapsed_ms = started_at.elapsed().as_millis(),
        result_count = 0,
        "database row query executed"
      );
      return Ok(DatabaseFilteredRowsPage {
        rows: Vec::new(),
        total_count,
      });
    }
    let cell_rows = sqlx::query(
      r#"
        SELECT cv.row_id, cv.field_id, f.field_type, cv.value_json, cv.updated_by, cv.edit_revision, cv.updated_at
        FROM workspace_database_cell_values cv
        JOIN workspace_database_fields f ON f.id = cv.field_id
        WHERE cv.row_id = ANY($1)
        ORDER BY f.position ASC, f.id ASC
      "#,
    )
    .bind(&row_ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    for cell_row in cell_rows {
      let row_id: DatabaseRowId = cell_row.try_get("row_id").map_err(Self::map_sqlx_error)?;
      let field_id: DatabaseFieldId = cell_row.try_get("field_id").map_err(Self::map_sqlx_error)?;
      if let Some(index) = record_indexes.get(&row_id).copied() {
        let has_value = cell_row
          .try_get::<Option<Value>, _>("value_json")
          .map_err(Self::map_sqlx_error)?
          .is_some();
        records[index].cell_revisions.push(DatabaseCellRevision {
          row_id,
          field_id,
          edit_revision: cell_row.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
          has_value,
        });
        if has_value {
          records[index].cells.push(Self::map_cell(cell_row)?);
        }
      }
    }
    for cell in Self::list_rollup_cells_for_rows_in(&mut *tx, &row_ids).await? {
      if let Some(index) = record_indexes.get(&cell.row_id).copied() {
        records[index].cells.push(cell);
      }
    }
    for cell in Self::list_formula_cells_for_rows_in(&mut *tx, &row_ids).await? {
      if let Some(index) = record_indexes.get(&cell.row_id).copied() {
        records[index].cells.push(cell);
      }
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    debug!(
      database_id = %database_id,
      view_id = ?query.view_id,
      operator_count = query_shape.operator_count,
      filter_group_count = query_shape.filter_group_count,
      filter_max_depth = query_shape.filter_max_depth,
      sort_count = query.sort.len(),
      has_search = query.search.as_ref().is_some_and(|value| !value.trim().is_empty()),
      requested_page_size = limit,
      elapsed_ms = started_at.elapsed().as_millis(),
      result_count = records.len(),
      "database row query executed"
    );
    Ok(DatabaseFilteredRowsPage {
      rows: records,
      total_count,
    })
  }

  async fn aggregate_row_groups(
    &self,
    database_id: DatabaseId,
    actor_id: UserId,
    query: DatabaseRowsQuery,
    group_field_id: DatabaseFieldId,
    subgroup_field_id: Option<DatabaseFieldId>,
  ) -> RepoResult<Vec<DatabaseRowGroupCount>> {
    let started_at = std::time::Instant::now();
    let query_shape = database_query_shape(&query);
    let fields = Self::list_fields_for(&self.pool, database_id).await?;
    let field_types = fields
      .iter()
      .map(|field| (field.id, field.field_type))
      .collect::<HashMap<_, _>>();
    let group_field_type = field_types
      .get(&group_field_id)
      .copied()
      .ok_or_else(|| RepositoryError::Validation("database group field is unknown".to_string()))?;
    let subgroup_field_type = subgroup_field_id
      .map(|field_id| {
        field_types
          .get(&field_id)
          .copied()
          .ok_or_else(|| RepositoryError::Validation("database subgroup field is unknown".to_string()))
      })
      .transpose()?;
    let plan = DatabaseRowQueryPlan::compile(
      &query,
      DATABASE_MAX_ROWS_PER_PAGE,
      0,
      actor_id,
      &fields,
      DATABASE_QUERY_TABLES,
    )?;
    let sql = plan.group_sql(group_field_type, subgroup_field_type);
    let mut sql_query = sqlx::query(&sql).bind(database_id);
    for bind in plan.group_binds(group_field_id, subgroup_field_id) {
      sql_query = match bind {
        DatabaseRowQueryBind::Uuid(value) => sql_query.bind(value),
        DatabaseRowQueryBind::Text(value) => sql_query.bind(value),
        DatabaseRowQueryBind::TextArray(value) => sql_query.bind(value),
        DatabaseRowQueryBind::Bool(value) => sql_query.bind(value),
        DatabaseRowQueryBind::F64(value) => sql_query.bind(value),
        DatabaseRowQueryBind::I64(value) => sql_query.bind(value),
        DatabaseRowQueryBind::Json(value) => sql_query.bind(value),
      };
    }
    let rows = sql_query.fetch_all(&self.pool).await.map_err(Self::map_sqlx_error)?;
    let groups = rows
      .into_iter()
      .map(|row| {
        Ok(DatabaseRowGroupCount {
          key: row.try_get("key").map_err(Self::map_sqlx_error)?,
          subgroup_key: row.try_get("subgroup_key").map_err(Self::map_sqlx_error)?,
          row_count: row.try_get("row_count").map_err(Self::map_sqlx_error)?,
        })
      })
      .collect::<RepoResult<Vec<_>>>()?;
    debug!(
      database_id = %database_id,
      view_id = ?query.view_id,
      operator_count = query_shape.operator_count,
      filter_group_count = query_shape.filter_group_count,
      filter_max_depth = query_shape.filter_max_depth,
      group_depth = if subgroup_field_id.is_some() { 2 } else { 1 },
      result_count = groups.len(),
      elapsed_ms = started_at.elapsed().as_millis(),
      "database row group query executed"
    );
    Ok(groups)
  }

  async fn aggregate_progress(
    &self,
    database_id: DatabaseId,
    actor_id: UserId,
    query: DatabaseRowsQuery,
    spec: DatabaseProgressAggregateSpec,
  ) -> RepoResult<Vec<DatabaseProgressAggregateCount>> {
    let started_at = std::time::Instant::now();
    let query_shape = database_query_shape(&query);
    let fields = Self::list_fields_for(&self.pool, database_id).await?;
    let group_field_type = spec
      .group_field_id
      .map(|field_id| {
        fields
          .iter()
          .find(|field| field.id == field_id)
          .map(|field| field.field_type)
          .ok_or_else(|| RepositoryError::Validation("database progress group field is unknown".to_string()))
      })
      .transpose()?;
    let plan = DatabaseRowQueryPlan::compile(
      &query,
      DATABASE_MAX_ROWS_PER_PAGE,
      0,
      actor_id,
      &fields,
      DATABASE_QUERY_TABLES,
    )?;
    let sql = plan.progress_sql(&spec, group_field_type);
    let mut sql_query = sqlx::query(&sql).bind(database_id);
    for bind in plan.progress_binds(&spec) {
      sql_query = match bind {
        DatabaseRowQueryBind::Uuid(value) => sql_query.bind(value),
        DatabaseRowQueryBind::Text(value) => sql_query.bind(value),
        DatabaseRowQueryBind::TextArray(value) => sql_query.bind(value),
        DatabaseRowQueryBind::Bool(value) => sql_query.bind(value),
        DatabaseRowQueryBind::F64(value) => sql_query.bind(value),
        DatabaseRowQueryBind::I64(value) => sql_query.bind(value),
        DatabaseRowQueryBind::Json(value) => sql_query.bind(value),
      };
    }
    let aggregates = sql_query
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_sqlx_error)?
      .into_iter()
      .map(|row| {
        Ok(DatabaseProgressAggregateCount {
          group_key: row.try_get("group_key").map_err(Self::map_sqlx_error)?,
          group_label: row.try_get("group_label").map_err(Self::map_sqlx_error)?,
          total_count: row.try_get("total_count").map_err(Self::map_sqlx_error)?,
          completed_count: row.try_get("completed_count").map_err(Self::map_sqlx_error)?,
          blocked_count: row.try_get("blocked_count").map_err(Self::map_sqlx_error)?,
          overdue_count: row.try_get("overdue_count").map_err(Self::map_sqlx_error)?,
          progress_value_count: row.try_get("progress_value_count").map_err(Self::map_sqlx_error)?,
          average_progress: row.try_get("average_progress").map_err(Self::map_sqlx_error)?,
        })
      })
      .collect::<RepoResult<Vec<_>>>()?;
    debug!(
      database_id = %database_id,
      view_id = ?query.view_id,
      operator_count = query_shape.operator_count,
      filter_group_count = query_shape.filter_group_count,
      filter_max_depth = query_shape.filter_max_depth,
      grouped = spec.group_field_id.is_some(),
      result_count = aggregates.len(),
      elapsed_ms = started_at.elapsed().as_millis(),
      "database progress aggregate query executed"
    );
    Ok(aggregates)
  }

  async fn list_rows(&self, database_id: DatabaseId, page: PageRequest) -> RepoResult<Vec<DatabaseRowRecord>> {
    let rows = sqlx::query(
      r#"
        SELECT r.id, r.database_id, r.doc_id, r.title, r.position,
               r.row_kind, r.created_by, r.updated_by, r.edit_revision, r.created_at, r.updated_at,
               r.deleted_at AS deleted_at
        FROM workspace_database_rows r
        WHERE r.database_id = $1
          AND r.deleted_at IS NULL
        ORDER BY r.position ASC, r.id ASC
        LIMIT $2 OFFSET $3
      "#,
    )
    .bind(database_id)
    .bind(page.limit)
    .bind(page.offset)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    let mut records = rows
      .into_iter()
      .map(Self::map_row)
      .collect::<RepoResult<Vec<_>>>()?
      .into_iter()
      .map(|row| DatabaseRowRecord {
        row,
        cells: Vec::new(),
        cell_revisions: Vec::new(),
      })
      .collect::<Vec<_>>();
    let record_indexes = records
      .iter()
      .enumerate()
      .map(|(index, record)| (record.row.id, index))
      .collect::<HashMap<_, _>>();
    let row_ids = records.iter().map(|record| record.row.id).collect::<Vec<_>>();
    if row_ids.is_empty() {
      return Ok(Vec::new());
    }

    let cell_rows = sqlx::query(
      r#"
        SELECT cv.row_id, cv.field_id, f.field_type, cv.value_json, cv.updated_by, cv.edit_revision, cv.updated_at
        FROM workspace_database_cell_values cv
        JOIN workspace_database_fields f ON f.id = cv.field_id
        WHERE cv.row_id = ANY($1) AND cv.value_json IS NOT NULL
        ORDER BY f.position ASC, f.id ASC
      "#,
    )
    .bind(&row_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    for cell in cell_rows
      .into_iter()
      .map(Self::map_cell)
      .collect::<RepoResult<Vec<_>>>()?
    {
      if let Some(index) = record_indexes.get(&cell.row_id).copied() {
        records[index].cells.push(cell);
      }
    }
    for revision in self.list_cell_revisions_for_rows(&row_ids).await? {
      if let Some(index) = record_indexes.get(&revision.row_id).copied() {
        records[index].cell_revisions.push(revision);
      }
    }
    for cell in self.list_rollup_cells_for_rows(&row_ids).await? {
      if let Some(index) = record_indexes.get(&cell.row_id).copied() {
        records[index].cells.push(cell);
      }
    }
    for cell in self.list_formula_cells_for_rows(&row_ids).await? {
      if let Some(index) = record_indexes.get(&cell.row_id).copied() {
        records[index].cells.push(cell);
      }
    }
    Ok(records)
  }

  async fn count_rows(&self, database_id: DatabaseId) -> RepoResult<i64> {
    sqlx::query_scalar::<_, i64>(
      "SELECT COUNT(*)::BIGINT FROM workspace_database_rows WHERE database_id = $1 AND deleted_at IS NULL",
    )
    .bind(database_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)
  }
}
