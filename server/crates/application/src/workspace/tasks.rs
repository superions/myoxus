// SPDX-License-Identifier: AGPL-3.0-or-later

//! Canonical Workspace Tasks provisioning without a Workspace/Database service dependency cycle.
use crate::database::{DatabaseLimits, DatabaseResult, DatabaseStarterTemplateCatalog};
use myoxus_domain::database::*;
use myoxus_domain::ids::*;
use std::sync::Arc;

pub fn workspace_tasks_initial_state(
  catalog: &DatabaseStarterTemplateCatalog,
  workspace_id: WorkspaceId,
  actor: Option<UserId>,
) -> DatabaseResult<DatabaseInitialState> {
  let source = catalog
    .system_source(DatabaseTemplateSourceRole::WorkspaceTasks)
    .expect("admitted catalog retains the canonical Workspace Tasks source");
  let id = source.template_id.as_str();
  let spec = catalog
    .select(
      id,
      source.selection.priority,
      source.selection.complexity,
      source.selection.structure,
    )
    .expect("admitted catalog retains its declared Workspace Tasks selection")
    .clone();
  let mut state = crate::database::definition::templates::materialize_template(
    &DatabaseLimits::default(),
    actor.unwrap_or_default(),
    workspace_id,
    "Workspace Tasks",
    None,
    false,
    "EUR",
    spec,
  )?;
  crate::database::definition::managed_schema::install_source_metadata(catalog, id, &mut state)?;
  state.database.system_role = Some(DatabaseSystemRole::WorkspaceTasks);
  state.database.created_by = actor;
  state.database.updated_by = actor;
  for template in &mut state.row_templates {
    template.created_by = actor;
    template.updated_by = actor;
  }
  Ok(state)
}

pub struct WorkspaceTasksInitializer {
  catalog: Arc<DatabaseStarterTemplateCatalog>,
  repository: Arc<dyn DatabaseDefinitionRepository>,
  changes: Arc<dyn crate::ports::database_change::DatabaseChangeNotificationPort>,
  projection: Arc<crate::database::DatabaseProjectionService>,
}
impl WorkspaceTasksInitializer {
  pub fn new(
    catalog: Arc<DatabaseStarterTemplateCatalog>,
    repository: Arc<dyn DatabaseDefinitionRepository>,
    projection: Arc<crate::database::DatabaseProjectionService>,
  ) -> Self {
    Self {
      catalog,
      repository,
      projection,
      changes: Arc::new(crate::ports::database_change::NullDatabaseChangeNotification),
    }
  }
  pub fn with_change_notifications(
    mut self,
    changes: Arc<dyn crate::ports::database_change::DatabaseChangeNotificationPort>,
  ) -> Self {
    self.changes = changes;
    self
  }
  pub async fn ensure(&self, workspace_id: WorkspaceId, actor: Option<UserId>) -> DatabaseResult<DatabaseRecord> {
    let record = self
      .repository
      .ensure_workspace_tasks(workspace_tasks_initial_state(&self.catalog, workspace_id, actor)?)
      .await?;
    crate::database::definition::managed_schema::reconcile_managed_database(
      &self.catalog,
      self.repository.as_ref(),
      record.database.id,
      self.changes.as_ref(),
      self.projection.as_ref(),
    )
    .await?;
    self
      .repository
      .get_database_for_lifecycle(record.database.id)
      .await?
      .ok_or_else(|| myoxus_domain::repositories::RepositoryError::NotFound("database").into())
  }
}
