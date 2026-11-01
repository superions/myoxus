// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::workspace_database::*;

impl PgDatabaseRepository {
  /// Root admission precedes View/personal-state locks, including absent-state
  /// inserts. A managed update takes the same root exclusively before remapping.
  async fn lock_view_state_owner(
    tx: &mut Transaction<'_, Postgres>,
    view_id: DatabaseViewId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseId> {
    let database_id =
      sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_views WHERE id=$1")
        .bind(view_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::NotFound("database view"))?;
    Self::lock_managed_admission(tx, database_id).await?;
    Self::assert_database_workspace(tx, database_id, precondition).await?;
    Ok(database_id)
  }
  pub(in crate::workspace_database) fn map_view_user_state(
    row: sqlx::postgres::PgRow,
  ) -> RepoResult<DatabaseViewUserState> {
    let sort = row
      .try_get::<Option<Value>, _>("sort_json")
      .map_err(Self::map_sqlx_error)?
      .map(serde_json::from_value::<Vec<DatabaseSortRule>>)
      .transpose()
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let filter_tree = row
      .try_get::<Option<Value>, _>("filter_tree_json")
      .map_err(Self::map_sqlx_error)?
      .map(serde_json::from_value::<DatabaseFilterGroup>)
      .transpose()
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let field_width_overrides = serde_json::from_value(
      row
        .try_get("field_width_overrides_json")
        .map_err(Self::map_sqlx_error)?,
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let collapsed_group_keys =
      serde_json::from_value(row.try_get("collapsed_group_keys_json").map_err(Self::map_sqlx_error)?)
        .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Ok(DatabaseViewUserState {
      view_id: row.try_get("view_id").map_err(Self::map_sqlx_error)?,
      user_id: row.try_get("user_id").map_err(Self::map_sqlx_error)?,
      search_text: row.try_get("search_text").map_err(Self::map_sqlx_error)?,
      sort,
      filter_tree,
      field_width_overrides,
      collapsed_group_keys,
      edit_revision: row.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
      created_at: row.try_get("created_at").map_err(Self::map_sqlx_error)?,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
    })
  }

  pub(in crate::workspace_database) async fn persist_get_view_user_state(
    &self,
    view_id: DatabaseViewId,
    user_id: UserId,
  ) -> RepoResult<Option<DatabaseViewUserState>> {
    sqlx::query(
      r#"
        SELECT view_id, user_id, search_text, sort_json, filter_tree_json,
               field_width_overrides_json, collapsed_group_keys_json,
               edit_revision, created_at, updated_at
        FROM database_view_user_states
        WHERE view_id = $1 AND user_id = $2
      "#,
    )
    .bind(view_id)
    .bind(user_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?
    .map(Self::map_view_user_state)
    .transpose()
  }

  pub(in crate::workspace_database) async fn persist_upsert_view_user_state(
    &self,
    state: DatabaseViewUserState,
    expected_edit_revision: Option<i64>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseViewUserState> {
    let sort_json = state
      .sort
      .as_ref()
      .map(serde_json::to_value)
      .transpose()
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let filter_tree_json = state
      .filter_tree
      .as_ref()
      .map(serde_json::to_value)
      .transpose()
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let field_widths_json = serde_json::to_value(&state.field_width_overrides)
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let collapsed_groups_json = serde_json::to_value(&state.collapsed_group_keys)
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;

    let mut tx = self.begin_write().await?;
    Self::lock_view_state_owner(&mut tx, state.view_id, precondition).await?;
    // Tokens are opaque and sequence-backed across Reset/Recreate. Sequence gaps
    // after conflicts or rollbacks are intentional; zero means no persisted row.
    let row = sqlx::query(
      r#"
        INSERT INTO database_view_user_states
          (view_id, user_id, search_text, sort_json, filter_tree_json,
           field_width_overrides_json, collapsed_group_keys_json,
           edit_revision, created_at, updated_at)
        SELECT $1, $2, $3, $4, $5, $6, $7, nextval('database_view_user_state_edit_revision_seq'), now(), now()
        WHERE $8::bigint IS NULL
           OR $8 = 0
           OR EXISTS (
             SELECT 1
             FROM database_view_user_states current_state
             WHERE current_state.view_id = $1
               AND current_state.user_id = $2
           )
        ON CONFLICT (view_id, user_id) DO UPDATE
        SET search_text = EXCLUDED.search_text,
            sort_json = EXCLUDED.sort_json,
            filter_tree_json = EXCLUDED.filter_tree_json,
            field_width_overrides_json = EXCLUDED.field_width_overrides_json,
            collapsed_group_keys_json = EXCLUDED.collapsed_group_keys_json,
            edit_revision = nextval('database_view_user_state_edit_revision_seq'),
            updated_at = now()
        WHERE $8::bigint IS NULL
           OR database_view_user_states.edit_revision = $8
        RETURNING view_id, user_id, search_text, sort_json, filter_tree_json,
                  field_width_overrides_json, collapsed_group_keys_json,
                  edit_revision, created_at, updated_at
      "#,
    )
    .bind(state.view_id)
    .bind(state.user_id)
    .bind(state.search_text)
    .bind(sort_json)
    .bind(filter_tree_json)
    .bind(field_widths_json)
    .bind(collapsed_groups_json)
    .bind(expected_edit_revision)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::Conflict("database view user-state edit revision"))?;
    let state = Self::map_view_user_state(row)?;
    let database_id =
      sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_views WHERE id = $1")
        .bind(state.view_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(state)
  }

  pub(in crate::workspace_database) async fn persist_reset_view_user_state(
    &self,
    view_id: DatabaseViewId,
    user_id: UserId,
    expected_edit_revision: Option<i64>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<()> {
    let mut tx = self.begin_write().await?;
    let database_id = Self::lock_view_state_owner(&mut tx, view_id, precondition).await?;
    let result = sqlx::query(
      r#"
        DELETE FROM database_view_user_states
        WHERE view_id = $1 AND user_id = $2
          AND ($3::bigint IS NULL OR edit_revision = $3)
      "#,
    )
    .bind(view_id)
    .bind(user_id)
    .bind(expected_edit_revision)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if expected_edit_revision.is_some() && result.rows_affected() != 1 {
      return Err(RepositoryError::Conflict("database view user-state edit revision"));
    }
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  pub(in crate::workspace_database) async fn persist_promote_view_user_state(
    &self,
    view_id: DatabaseViewId,
    user_id: UserId,
    config: DatabaseViewConfig,
    expected_view_edit_revision: i64,
    expected_state_edit_revision: i64,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseView> {
    let config_json = Self::map_view_config_to_json(&config)?;
    let mut tx = self.begin_write().await?;
    Self::lock_view_state_owner(&mut tx, view_id, precondition).await?;

    let view_revision =
      Self::lock_entity_edit_revision(&mut tx, "workspace_database_views", view_id, "database view").await?;
    if view_revision != expected_view_edit_revision {
      return Err(RepositoryError::Conflict("database view edit revision"));
    }
    let state_revision = sqlx::query_scalar::<_, i64>(
      r#"
        SELECT edit_revision
        FROM database_view_user_states
        WHERE view_id = $1 AND user_id = $2
        FOR UPDATE
      "#,
    )
    .bind(view_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database view user state"))?;
    if state_revision != expected_state_edit_revision {
      return Err(RepositoryError::Conflict("database view user-state edit revision"));
    }

    let row = sqlx::query(
      r#"
        UPDATE workspace_database_views
        SET config_json = $2,
            edit_revision = edit_revision + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING id, database_id, name, view_kind, icon_json, config_json,
                  position, edit_revision, created_at, updated_at
      "#,
    )
    .bind(view_id)
    .bind(config_json)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let view = Self::map_view(row)?;
    // Only exploratory sort/filter become shared. Search, field widths and
    // collapsed groups are actor-owned display state and must survive Save to
    // view inside the same optimistic transaction.
    let cleared = sqlx::query(
      r#"
        UPDATE database_view_user_states
        SET sort_json = NULL,
            filter_tree_json = NULL,
            edit_revision = nextval('database_view_user_state_edit_revision_seq'),
            updated_at = now()
        WHERE view_id = $1 AND user_id = $2 AND edit_revision = $3
      "#,
    )
    .bind(view_id)
    .bind(user_id)
    .bind(expected_state_edit_revision)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if cleared.rows_affected() != 1 {
      return Err(RepositoryError::Conflict("database view user-state edit revision"));
    }
    Self::assert_database_workspace(&mut tx, view.database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(view)
  }
}
