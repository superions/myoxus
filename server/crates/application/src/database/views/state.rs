// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

impl DatabaseViewService {
  fn personal_state_conflict(
    database_id: DatabaseId,
    view_id: DatabaseViewId,
    latest: Option<DatabaseViewUserState>,
  ) -> DatabaseServiceError {
    DatabaseServiceError::new(
      ERR_VIEW_CONFLICT,
      "personal database view state changed since editing began",
    )
    .with_latest_state(serde_json::json!({"kind":"viewUserState",
        "databaseId":database_id,"viewId":view_id,"state":latest}))
  }

  pub async fn effective_view_state(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: DatabaseViewId,
  ) -> DatabaseResult<DatabaseEffectiveViewState> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let view = record
      .views
      .iter()
      .find(|view| view.id == view_id)
      .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "database view not found"))?;
    let personal_state = self
      .view_query_repo
      .get_view_user_state(view_id, actor)
      .await
      .map_err(DatabaseServiceError::from)?;
    let can_edit_shared = access::assert_database_manager(&self.permission, actor, &record.database)
      .await
      .is_ok();
    let can_edit_rows = record.database.deleted_at.is_none()
      && self
        .permission
        .can(
          &WorkspaceResource {
            user_id: actor,
            workspace_id: record.database.workspace_id,
          },
          WorkspaceAction::CreateDoc,
        )
        .await;
    let saved_sort = view.config.sort_rules().to_vec();
    let saved_filter_tree = view.config.effective_filter_tree();
    let effective_sort = personal_state
      .as_ref()
      .and_then(|state| state.sort.clone())
      .unwrap_or_else(|| saved_sort.clone());
    let effective_filter_tree = match personal_state.as_ref().and_then(|state| state.filter_tree.as_ref()) {
      Some(filter_tree) if filter_tree.is_empty() => None,
      Some(filter_tree) => Some(filter_tree.clone()),
      None => saved_filter_tree.clone(),
    };
    let search_text = personal_state
      .as_ref()
      .map(|state| state.search_text.clone())
      .unwrap_or_default();
    let mut effective_field_widths = match &view.config {
      DatabaseViewConfig::Table(config) => config.field_widths.clone(),
      _ => BTreeMap::new(),
    };
    if let Some(personal_state) = &personal_state {
      effective_field_widths.extend(personal_state.field_width_overrides.clone());
    }
    Ok(DatabaseEffectiveViewState {
      view_id,
      saved_sort,
      saved_filter_tree,
      personal_state,
      effective_sort,
      effective_filter_tree,
      search_text,
      effective_field_widths,
      can_edit_shared,
      can_edit_rows,
    })
  }

  #[expect(
    clippy::too_many_arguments,
    reason = "the public view-state contract mirrors independent persisted fields"
  )]
  pub async fn upsert_view_user_state(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: DatabaseViewId,
    search_text: String,
    sort: Option<Vec<DatabaseSortRule>>,
    filter_tree: Option<DatabaseFilterGroup>,
    field_width_overrides: BTreeMap<DatabaseFieldId, i32>,
    collapsed_group_keys: Vec<String>,
    expected_edit_revision: Option<i64>,
  ) -> DatabaseResult<DatabaseViewUserState> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    if !record.views.iter().any(|view| view.id == view_id) {
      return Err(DatabaseServiceError::new(ERR_VIEW_INVALID, "database view not found"));
    }
    if let Some(expected) = expected_edit_revision {
      let latest = self.view_query_repo.get_view_user_state(view_id, actor).await?;
      if latest.as_ref().map_or(0, |state| state.edit_revision) != expected {
        return Err(Self::personal_state_conflict(database_id, view_id, latest));
      }
    }
    if search_text.chars().count() > 500 {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_CONFIG_INVALID,
        "personal database search text is too long",
      ));
    }
    let fields_by_id = record
      .fields
      .iter()
      .map(|field| (field.id, field))
      .collect::<HashMap<_, _>>();
    if let Some(sort) = &sort {
      for rule in sort {
        if fields_by_id
          .get(&rule.field_id)
          .is_none_or(|field| !field.field_type.supports_saved_sort())
        {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_CONFIG_INVALID,
            "personal sort field does not have typed ordering semantics",
          ));
        }
      }
    }
    if let Some(filter_tree) = &filter_tree
      && !filter_tree.is_empty()
    {
      Self::validate_filter_group_for_fields(filter_tree, &fields_by_id)?;
    }
    for (field_id, width) in &field_width_overrides {
      if !fields_by_id.contains_key(field_id) || *width <= 0 {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_CONFIG_INVALID,
          "personal field-width override is invalid",
        ));
      }
    }
    if collapsed_group_keys.len() > 500 || collapsed_group_keys.iter().any(|key| key.chars().count() > 256) {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_CONFIG_INVALID,
        "personal collapsed-group state is too large",
      ));
    }
    let now = Utc::now();
    let result = self
      .view_query_repo
      .upsert_view_user_state(
        DatabaseViewUserState {
          view_id,
          user_id: actor,
          search_text: search_text.trim().to_string(),
          sort,
          filter_tree,
          field_width_overrides,
          collapsed_group_keys,
          edit_revision: expected_edit_revision.unwrap_or_default(),
          created_at: now,
          updated_at: now,
        },
        expected_edit_revision,
        DatabaseEditPrecondition::default()
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id),
      )
      .await;
    match result {
      Ok(state) => Ok(state),
      Err(RepositoryError::Conflict("database view user-state edit revision")) => {
        let latest = self
          .view_query_repo
          .get_view_user_state(view_id, actor)
          .await
          .map_err(DatabaseServiceError::from)?;
        Err(Self::personal_state_conflict(database_id, view_id, latest))
      }
      Err(error) => Err(DatabaseServiceError::from(error)),
    }
  }

  pub async fn reset_view_user_state(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: DatabaseViewId,
    expected_edit_revision: Option<i64>,
  ) -> DatabaseResult<()> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    if !record.views.iter().any(|view| view.id == view_id) {
      return Err(DatabaseServiceError::new(ERR_VIEW_INVALID, "database view not found"));
    }
    let result = self
      .view_query_repo
      .reset_view_user_state(
        view_id,
        actor,
        expected_edit_revision,
        DatabaseEditPrecondition::default()
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id),
      )
      .await;
    match result {
      Ok(()) => Ok(()),
      Err(RepositoryError::Conflict("database view user-state edit revision")) => {
        let latest = self
          .view_query_repo
          .get_view_user_state(view_id, actor)
          .await
          .map_err(DatabaseServiceError::from)?;
        Err(Self::personal_state_conflict(database_id, view_id, latest))
      }
      Err(error) => Err(DatabaseServiceError::from(error)),
    }
  }

  pub async fn save_view_user_state_to_shared_view(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: DatabaseViewId,
    expected_view_edit_revision: i64,
  ) -> DatabaseResult<DatabaseView> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    let view = record
      .views
      .iter()
      .find(|view| view.id == view_id)
      .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "database view not found"))?;
    let state = self
      .view_query_repo
      .get_view_user_state(view_id, actor)
      .await
      .map_err(DatabaseServiceError::from)?
      .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_CONFIG_INVALID, "personal view state does not exist"))?;
    let mut config = view.config.clone();
    let saved_filter_tree = config.effective_filter_tree();
    let promoted_filter_tree = match state.filter_tree {
      Some(filter_tree) if filter_tree.is_empty() => None,
      Some(filter_tree) => Some(filter_tree),
      None => saved_filter_tree,
    };
    config.replace_query_state(
      state.sort.unwrap_or_else(|| config.sort_rules().to_vec()),
      promoted_filter_tree,
    );
    crate::database::views::rules::validate_view_config(
      view.view_kind,
      &config,
      &record.fields,
      self.limits.max_fields_per_database,
    )?;
    let result = self
      .view_query_repo
      .promote_view_user_state(
        view_id,
        actor,
        config,
        expected_view_edit_revision,
        state.edit_revision,
        DatabaseEditPrecondition::default()
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id),
      )
      .await;
    match result {
      Ok(view) => Ok(view),
      Err(RepositoryError::Conflict("database view edit revision" | "database view user-state edit revision")) => {
        let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
        let latest_view = record.views.iter().find(|candidate| candidate.id == view_id);
        let latest_state = self
          .view_query_repo
          .get_view_user_state(view_id, actor)
          .await
          .map_err(DatabaseServiceError::from)?;
        Err(
          DatabaseServiceError::new(ERR_VIEW_CONFLICT, "database view state changed since editing began")
            .with_latest_state(serde_json::json!({
              "kind": "view",
              "databaseId": database_id,
              "viewId": view_id,
              "editRevision": latest_view.map(|view| view.edit_revision),
              "personalState": latest_state,
            })),
        )
      }
      Err(error) => Err(DatabaseServiceError::from(error)),
    }
  }
}
