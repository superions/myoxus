// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

impl DatabaseViewService {
  /// `update_view` with stale-write precondition.
  #[instrument(
    skip(self, name, view_kind, config),
    fields(actor_id = %actor, database_id = %database_id, view_id = %view_id, force, has_expected = expected_edit_revision.is_some())
  )]
  #[expect(
    clippy::too_many_arguments,
    reason = "the public mutation contract keeps identity and optimistic concurrency explicit"
  )]
  pub async fn update_view_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: DatabaseViewId,
    name: Option<String>,
    view_kind: Option<DatabaseViewKind>,
    config: Option<DatabaseViewConfig>,
    expected_edit_revision: Option<i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseView> {
    self
      .update_view_with_icon_precondition(
        actor,
        database_id,
        view_id,
        name,
        view_kind,
        None,
        config,
        expected_edit_revision,
        force,
      )
      .await
  }

  #[expect(
    clippy::too_many_arguments,
    reason = "the public mutation contract keeps identity and optimistic concurrency explicit"
  )]
  pub async fn update_view_with_icon_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: DatabaseViewId,
    name: Option<String>,
    view_kind: Option<DatabaseViewKind>,
    icon: Option<Option<DatabaseViewIcon>>,
    config: Option<DatabaseViewConfig>,
    expected_edit_revision: Option<i64>,
    force: bool,
  ) -> DatabaseResult<DatabaseView> {
    let result = self
      .update_view_with_edit_precondition(
        actor,
        database_id,
        view_id,
        name,
        view_kind,
        icon,
        config,
        DatabaseEditPrecondition::new(expected_edit_revision, force),
      )
      .await;
    match result {
      Ok(view) => Ok(view),
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::View) => {
        let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
        let latest = record
          .views
          .iter()
          .find(|view| view.id == view_id)
          .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database view not found"))?;
        Err(
          DatabaseServiceError::new(ERR_VIEW_CONFLICT, "database view changed since editing began").with_latest_state(
            serde_json::json!({
              "kind": "view",
              "databaseId": database_id,
              "viewId": view_id,
              "editRevision": latest.edit_revision,
              "name": latest.name,
              "viewKind": latest.view_kind.as_str(),
              "icon": latest.icon,
              "config": latest.config,
            }),
          ),
        )
      }
      Err(error) => Err(error),
    }
  }

  pub async fn delete_view_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: DatabaseViewId,
    replacement_view_id: Option<DatabaseViewId>,
    expected_edit_revision: Option<i64>,
    force: bool,
  ) -> DatabaseResult<()> {
    let result = self
      .delete_view_with_edit_precondition(
        actor,
        database_id,
        view_id,
        replacement_view_id,
        DatabaseEditPrecondition::new(expected_edit_revision, force),
      )
      .await;
    match result {
      Ok(()) => Ok(()),
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::View) => {
        let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
        let latest = record
          .views
          .iter()
          .find(|view| view.id == view_id)
          .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database view not found"))?;
        Err(
          DatabaseServiceError::new(ERR_VIEW_CONFLICT, "database view changed since editing began").with_latest_state(
            serde_json::json!({
              "kind": "view",
              "databaseId": database_id,
              "viewId": view_id,
              "editRevision": latest.edit_revision,
              "name": latest.name,
            }),
          ),
        )
      }
      Err(error) => Err(error),
    }
  }

  pub async fn reorder_views_with_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_ids: Vec<DatabaseViewId>,
    expected_edit_revisions: &HashMap<DatabaseViewId, i64>,
    force: bool,
  ) -> DatabaseResult<Vec<DatabaseView>> {
    let result = self
      .reorder_views_with_edit_preconditions(actor, database_id, view_ids, expected_edit_revisions, force)
      .await;
    match result {
      Ok(views) => Ok(views),
      Err(error) if error.is_edit_conflict(DatabaseEditConflictKind::View) => {
        let latest = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
        Err(
          DatabaseServiceError::new(ERR_VIEW_CONFLICT, "database view order changed since editing began")
            .with_latest_state(serde_json::json!({
              "kind": "view_order",
              "databaseId": database_id,
              "views": latest.views.iter().map(|view| serde_json::json!({
                "viewId": view.id,
                "position": view.position,
                "editRevision": view.edit_revision,
              })).collect::<Vec<_>>(),
            })),
        )
      }
      Err(error) => Err(error),
    }
  }

  #[instrument(
    skip(self, name, config),
    fields(actor_id = %actor, database_id = %database_id, view_id = tracing::field::Empty, view_kind = tracing::field::Empty)
  )]
  pub async fn create_view(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    name: String,
    view_kind: DatabaseViewKind,
    config: DatabaseViewConfig,
  ) -> DatabaseResult<DatabaseView> {
    self
      .create_view_with_icon(actor, database_id, name, view_kind, None, config)
      .await
  }

  pub async fn create_view_with_icon(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    name: String,
    view_kind: DatabaseViewKind,
    icon: Option<DatabaseViewIcon>,
    config: DatabaseViewConfig,
  ) -> DatabaseResult<DatabaseView> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    crate::database::definition::managed_schema::assert_structure_edit(&record)?;
    if record.views.len() >= self.limits.max_views_per_database {
      return Err(DatabaseServiceError::new(
        ERR_LIMIT_EXCEEDED,
        "database view limit exceeded",
      ));
    }
    if let Some(icon) = &icon {
      icon
        .validate()
        .map_err(|error| DatabaseServiceError::new(ERR_VIEW_CONFIG_INVALID, error.to_string()))?;
    }
    crate::database::views::rules::validate_view_config(
      view_kind,
      &config,
      &record.fields,
      self.limits.max_fields_per_database,
    )?;
    let now = Utc::now();
    let view = self
      .view_query_repo
      .create_view(
        DatabaseView {
          id: Uuid::new_v4(),
          database_id,
          name: crate::database::definition::rules::validate_title(&name)?,
          view_kind,
          icon,
          config,
          position: record.views.iter().map(|view| view.position).max().unwrap_or(-1) + 1,
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
    let span = tracing::Span::current();
    span.record("view_id", tracing::field::display(view.id));
    span.record("view_kind", view_kind.as_str());
    info!(view_id = %view.id, view_kind = view_kind.as_str(), "database view created");
    // P-DB-29B-C: emit a `ViewCreated` event so collaborators see
    // the new view appear in their sidebar.
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::ViewCreated,
        actor,
        DatabaseChangeTarget {
          row_id: None,
          field_id: None,
          view_id: Some(view.id),
        },
      )
      .await;
    Ok(view)
  }

  #[instrument(
    skip(self, name, view_kind, config),
    fields(actor_id = %actor, database_id = %database_id, view_id = %view_id, renamed = tracing::field::Empty, kind_changed = tracing::field::Empty, config_changed = tracing::field::Empty)
  )]
  pub async fn update_view(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: DatabaseViewId,
    name: Option<String>,
    view_kind: Option<DatabaseViewKind>,
    config: Option<DatabaseViewConfig>,
  ) -> DatabaseResult<DatabaseView> {
    self
      .update_view_with_edit_precondition(
        actor,
        database_id,
        view_id,
        name,
        view_kind,
        None,
        config,
        DatabaseEditPrecondition::default(),
      )
      .await
  }

  #[expect(
    clippy::too_many_arguments,
    reason = "the established mutation boundary keeps identity and precondition fields explicit"
  )]
  pub(in crate::database) async fn update_view_with_edit_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: DatabaseViewId,
    name: Option<String>,
    view_kind: Option<DatabaseViewKind>,
    icon: Option<Option<DatabaseViewIcon>>,
    config: Option<DatabaseViewConfig>,
    precondition: DatabaseEditPrecondition,
  ) -> DatabaseResult<DatabaseView> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let precondition = precondition
      .in_workspace(record.database.workspace_id)
      .in_database(record.database.id);
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    crate::database::definition::managed_schema::assert_structure_edit(&record)?;
    let view = record
      .views
      .iter()
      .find(|view| view.id == view_id)
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database view not found"))?;
    let next_kind = view_kind.unwrap_or(view.view_kind);
    if let Some(role) = record.view_roles.iter().find(|role| role.view_id == view_id)
      && role.expected_view_kind() != Some(next_kind)
    {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_REQUIRED,
        format!(
          "view is assigned to required role {} and cannot change kind",
          role.role_key
        ),
      ));
    }
    if let Some(Some(icon)) = &icon {
      icon
        .validate()
        .map_err(|error| DatabaseServiceError::new(ERR_VIEW_CONFIG_INVALID, error.to_string()))?;
    }
    // A kind-only change must still match the retained configuration.
    crate::database::views::rules::validate_view_config(
      next_kind,
      config.as_ref().unwrap_or(&view.config),
      &record.fields,
      self.limits.max_fields_per_database,
    )?;
    let name = name
      .map(|value| crate::database::definition::rules::validate_title(&value))
      .transpose()?;
    let renamed = name.is_some();
    let kind_changed = view_kind.is_some();
    let config_changed = config.is_some();
    let view = self
      .view_query_repo
      .update_view(view_id, name, view_kind, icon, config, precondition)
      .await
      .map_err(DatabaseServiceError::from)?;
    let span = tracing::Span::current();
    span.record("renamed", renamed);
    span.record("kind_changed", kind_changed);
    span.record("config_changed", config_changed);
    info!(renamed, kind_changed, config_changed, "database view updated");
    // P-DB-29B-C: emit a `ViewUpdated` event so collaborators see
    // the renamed / reconfigured view.
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::ViewUpdated,
        actor,
        DatabaseChangeTarget {
          row_id: None,
          field_id: None,
          view_id: Some(view_id),
        },
      )
      .await;
    Ok(view)
  }

  #[instrument(
    skip(self),
    fields(actor_id = %actor, database_id = %database_id, view_id = %view_id)
  )]
  pub async fn delete_view(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: DatabaseViewId,
  ) -> DatabaseResult<()> {
    self
      .delete_view_with_edit_precondition(actor, database_id, view_id, None, DatabaseEditPrecondition::default())
      .await
  }

  pub(in crate::database) async fn delete_view_with_edit_precondition(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: DatabaseViewId,
    replacement_view_id: Option<DatabaseViewId>,
    precondition: DatabaseEditPrecondition,
  ) -> DatabaseResult<()> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let precondition = precondition
      .in_workspace(record.database.workspace_id)
      .in_database(record.database.id);
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    crate::database::definition::managed_schema::assert_structure_edit(&record)?;
    if !record.views.iter().any(|view| view.id == view_id) {
      return Err(DatabaseServiceError::new(ERR_NOT_FOUND, "database view not found"));
    }
    let replacement_role = record
      .view_roles
      .iter()
      .find(|role| role.view_id == view_id && role.required)
      .map(|role| {
        let replacement_view_id = replacement_view_id.ok_or_else(|| {
          DatabaseServiceError::new(
            ERR_VIEW_REQUIRED,
            format!("required view role {} needs a replacement view", role.role_key),
          )
        })?;
        if replacement_view_id == view_id {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_REQUIRED,
            "replacement view must differ from the deleted view",
          ));
        }
        let replacement = record
          .views
          .iter()
          .find(|view| view.id == replacement_view_id)
          .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_REQUIRED, "replacement view not found"))?;
        if role.expected_view_kind() != Some(replacement.view_kind) {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_REQUIRED,
            format!("replacement view kind is incompatible with role {}", role.role_key),
          ));
        }
        Ok(DatabaseViewRole {
          view_id: replacement.id,
          updated_at: Utc::now(),
          ..role.clone()
        })
      })
      .transpose()?;
    if replacement_view_id.is_some() && replacement_role.is_none() {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_REQUIRED,
        "replacementViewId is valid only for a required profile view",
      ));
    }
    self
      .view_query_repo
      .delete_view(view_id, precondition, replacement_role)
      .await
      .map_err(DatabaseServiceError::from)?;
    info!("database view deleted");
    // P-DB-29B-C: emit a `ViewDeleted` event so collaborators drop
    // the view from their sidebar.
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::ViewDeleted,
        actor,
        DatabaseChangeTarget {
          row_id: None,
          field_id: None,
          view_id: Some(view_id),
        },
      )
      .await;
    Ok(())
  }

  pub async fn reorder_views(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_ids: Vec<DatabaseViewId>,
  ) -> DatabaseResult<Vec<DatabaseView>> {
    self
      .reorder_views_with_edit_preconditions(actor, database_id, view_ids, &HashMap::new(), false)
      .await
  }

  pub(in crate::database) async fn reorder_views_with_edit_preconditions(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_ids: Vec<DatabaseViewId>,
    expected_edit_revisions: &HashMap<DatabaseViewId, i64>,
    force: bool,
  ) -> DatabaseResult<Vec<DatabaseView>> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    access::assert_database_manager(&self.permission, actor, &record.database).await?;
    crate::database::definition::managed_schema::assert_structure_edit(&record)?;
    let existing = record.views.iter().map(|view| view.id).collect::<BTreeSet<_>>();
    let requested = view_ids.iter().copied().collect::<BTreeSet<_>>();
    if existing != requested || requested.len() != view_ids.len() {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_INVALID,
        "view reorder must include exactly every view once",
      ));
    }
    let views = self
      .view_query_repo
      .reorder_views(
        database_id,
        view_ids,
        expected_edit_revisions,
        force,
        DatabaseEditPrecondition::default()
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id),
      )
      .await
      .map_err(DatabaseServiceError::from)?;
    self
      .effects
      .emit_change(
        record.database.workspace_id,
        database_id,
        DatabaseChangeKind::ViewReordered,
        actor,
        DatabaseChangeTarget::default(),
      )
      .await;
    Ok(views)
  }
}
