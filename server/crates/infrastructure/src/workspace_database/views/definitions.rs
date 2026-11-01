// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::workspace_database::*;

impl PgDatabaseRepository {
  pub(in crate::workspace_database) fn map_view_config_to_json(config: &DatabaseViewConfig) -> RepoResult<Value> {
    serde_json::to_value(config).map_err(|error| RepositoryError::Validation(error.to_string()))
  }

  pub(in crate::workspace_database) fn map_view_icon_to_json(icon: &DatabaseViewIcon) -> RepoResult<Value> {
    serde_json::to_value(icon).map_err(|error| RepositoryError::Validation(error.to_string()))
  }

  pub(in crate::workspace_database) fn map_view(row: sqlx::postgres::PgRow) -> RepoResult<DatabaseView> {
    let view_kind = DatabaseViewKind::from_str(
      row
        .try_get::<String, _>("view_kind")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let config_json: Value = row.try_get("config_json").map_err(Self::map_sqlx_error)?;
    let config = serde_json::from_value::<DatabaseViewConfig>(config_json)
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let icon = row
      .try_get::<Option<Value>, _>("icon_json")
      .map_err(Self::map_sqlx_error)?
      .map(serde_json::from_value::<DatabaseViewIcon>)
      .transpose()
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Ok(DatabaseView {
      id: row.try_get("id").map_err(Self::map_sqlx_error)?,
      database_id: row.try_get("database_id").map_err(Self::map_sqlx_error)?,
      name: row.try_get("name").map_err(Self::map_sqlx_error)?,
      view_kind,
      icon,
      config,
      position: row.try_get("position").map_err(Self::map_sqlx_error)?,
      edit_revision: row.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
      created_at: row.try_get("created_at").map_err(Self::map_sqlx_error)?,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
    })
  }

  pub(in crate::workspace_database) async fn list_views_for(
    executor: impl sqlx::Executor<'_, Database = Postgres>,
    database_id: DatabaseId,
  ) -> RepoResult<Vec<DatabaseView>> {
    let rows = sqlx::query(
      r#"
        SELECT id, database_id, name, view_kind, icon_json, config_json, position, edit_revision, created_at, updated_at
        FROM workspace_database_views
        WHERE database_id = $1
        ORDER BY position ASC, id ASC
      "#,
    )
    .bind(database_id)
    .fetch_all(executor)
    .await
    .map_err(Self::map_snapshot_sqlx_error)?;

    rows.into_iter().map(Self::map_view).collect()
  }

  pub(in crate::workspace_database) async fn persist_create_view(
    &self,
    view: DatabaseView,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseView> {
    let config_json = Self::map_view_config_to_json(&view.config)?;
    let icon_json = view.icon.as_ref().map(Self::map_view_icon_to_json).transpose()?;
    let mut tx = self.begin_write().await?;
    let row = sqlx::query(
      r#"
        INSERT INTO workspace_database_views
          (id, database_id, name, view_kind, icon_json, config_json, position, edit_revision, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, database_id, name, view_kind, icon_json, config_json, position, edit_revision, created_at, updated_at
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
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let view = Self::map_view(row)?;
    Self::assert_database_workspace(&mut tx, view.database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(view)
  }

  pub(in crate::workspace_database) async fn persist_update_view(
    &self,
    view_id: DatabaseViewId,
    name: Option<String>,
    view_kind: Option<DatabaseViewKind>,
    icon: Option<Option<DatabaseViewIcon>>,
    config: Option<DatabaseViewConfig>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseView> {
    let mut tx = self.begin_write().await?;
    let actual_revision =
      Self::lock_entity_edit_revision(&mut tx, "workspace_database_views", view_id, "database view").await?;
    Self::assert_edit_precondition(actual_revision, precondition, "database view edit revision")?;
    let config_json = config.as_ref().map(Self::map_view_config_to_json).transpose()?;
    let icon_changed = icon.is_some();
    let icon_json = icon.flatten().as_ref().map(Self::map_view_icon_to_json).transpose()?;
    let view_kind_text = view_kind.map(DatabaseViewKind::as_str);
    let row = sqlx::query(
      r#"
        UPDATE workspace_database_views
        SET name = COALESCE($2, name),
            view_kind = COALESCE($3, view_kind),
            config_json = COALESCE($4, config_json),
            icon_json = CASE WHEN $5 THEN $6 ELSE icon_json END,
            edit_revision = edit_revision + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING id, database_id, name, view_kind, icon_json, config_json, position, edit_revision, created_at, updated_at
      "#,
    )
    .bind(view_id)
    .bind(name)
    .bind(view_kind_text)
    .bind(config_json)
    .bind(icon_changed)
    .bind(icon_json)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database view"))?;
    let view = Self::map_view(row)?;
    Self::assert_database_workspace(&mut tx, view.database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(view)
  }

  pub(in crate::workspace_database) async fn persist_delete_view(
    &self,
    view_id: DatabaseViewId,
    precondition: DatabaseEditPrecondition,
    replacement_role: Option<DatabaseViewRole>,
  ) -> RepoResult<()> {
    let mut tx = self.begin_write().await?;
    let actual_revision =
      Self::lock_entity_edit_revision(&mut tx, "workspace_database_views", view_id, "database view").await?;
    Self::assert_edit_precondition(actual_revision, precondition, "database view edit revision")?;
    let database_id =
      sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_views WHERE id = $1")
        .bind(view_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
    if let Some(role) = replacement_role {
      let sql = format!(
        r#"
          UPDATE {DATABASE_VIEW_ROLES_TABLE}
          SET view_id = $3, updated_at = $4
          WHERE database_id = $1 AND role_key = $2 AND view_id = $5
        "#,
      );
      let updated = sqlx::query(&sql)
        .bind(role.database_id)
        .bind(role.role_key)
        .bind(role.view_id)
        .bind(role.updated_at)
        .bind(view_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
      if updated.rows_affected() != 1 {
        return Err(RepositoryError::Conflict("database view role assignment"));
      }
    }
    let result = sqlx::query("DELETE FROM workspace_database_views WHERE id = $1")
      .bind(view_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("database view"));
    }
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  pub(in crate::workspace_database) async fn persist_reorder_views(
    &self,
    database_id: DatabaseId,
    view_ids: Vec<DatabaseViewId>,
    expected_edit_revisions: &HashMap<DatabaseViewId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<DatabaseView>> {
    let mut tx = self.begin_write().await?;
    let locked = sqlx::query(
      r#"
        SELECT id, edit_revision
        FROM workspace_database_views
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
      .map(|row| row.try_get::<DatabaseViewId, _>("id").map_err(Self::map_sqlx_error))
      .collect::<RepoResult<std::collections::HashSet<_>>>()?;
    let requested_ids = view_ids.iter().copied().collect::<std::collections::HashSet<_>>();
    if locked_ids != requested_ids || requested_ids.len() != view_ids.len() {
      return Err(RepositoryError::Validation(
        "view reorder must include every view exactly once".to_string(),
      ));
    }
    for row in &locked {
      let view_id: DatabaseViewId = row.try_get("id").map_err(Self::map_sqlx_error)?;
      let revision: i64 = row.try_get("edit_revision").map_err(Self::map_sqlx_error)?;
      if !force
        && expected_edit_revisions
          .get(&view_id)
          .is_some_and(|expected| *expected != revision)
      {
        return Err(RepositoryError::Conflict("database view edit revision"));
      }
    }
    let result = sqlx::query(
      r#"
        UPDATE workspace_database_views view
        SET position = ordered.ordinality::int - 1,
            edit_revision = view.edit_revision + 1,
            updated_at = now()
        FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, ordinality)
        WHERE view.database_id = $1 AND view.id = ordered.id
      "#,
    )
    .bind(database_id)
    .bind(&view_ids)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if result.rows_affected() != view_ids.len() as u64 {
      return Err(RepositoryError::NotFound("database view"));
    }
    let views = Self::list_views_for(&mut *tx, database_id).await?;
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(views)
  }
}
