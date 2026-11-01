// SPDX-License-Identifier: AGPL-3.0-or-later

//! Bounded reconciliation persists native readiness through the existing port.
//! Database change effects are emitted only after its transaction commits.
use super::planning::plan_forward_transition;
use super::verification::verify_installed_structure;
use crate::database::{
  DatabaseDefinitionService, DatabaseResult, DatabaseServiceError, DatabaseStarterTemplateCatalog,
  ERR_DATABASE_CONFLICT, ERR_NOT_FOUND,
};
use myoxus_domain::database::{DatabaseDefinitionRepository, DatabaseManagedSchemaReadiness};
use myoxus_domain::database_change::{DatabaseChangeEvent, DatabaseChangeKind};
use myoxus_domain::ids::DatabaseId;
use uuid::Uuid;

#[derive(Debug, Clone, Default)]
pub struct DatabaseManagedInitializationReport {
  pub ready: usize,
  pub unavailable: usize,
  pub defaults_ensured: usize,
  pub failures: Vec<(Uuid, String)>,
}

impl DatabaseDefinitionService {
  #[tracing::instrument(skip_all)]
  pub async fn initialize_managed_databases(&self) -> DatabaseResult<DatabaseManagedInitializationReport> {
    let mut report = DatabaseManagedInitializationReport::default();
    let mut after = None;
    loop {
      let workspaces = self.schema_repo.published_workspace_ids(after, 100).await?;
      if workspaces.is_empty() {
        break;
      }
      for workspace in &workspaces {
        let state = crate::workspace::tasks::workspace_tasks_initial_state(&self.starter_templates, *workspace, None)?;
        match self.schema_repo.ensure_workspace_tasks(state).await {
          Ok(_) => report.defaults_ensured += 1,
          Err(error) => report.failures.push((*workspace, error.to_string())),
        }
      }
      after = workspaces.last().copied();
    }
    let mut after = None;
    loop {
      let ids = self.schema_repo.managed_database_ids(after, 100).await?;
      if ids.is_empty() {
        break;
      }
      for id in &ids {
        match reconcile_managed_database(
          &self.starter_templates,
          self.schema_repo.as_ref(),
          *id,
          self.effects.change_notifications.as_ref(),
          self.projection.as_ref(),
        )
        .await
        {
          Ok(outcome) => {
            if outcome.ready {
              report.ready += 1;
            } else {
              report.unavailable += 1;
            }
          }
          Err(error) => {
            report.unavailable += 1;
            report.failures.push((*id, error.to_string()));
          }
        }
      }
      after = ids.last().copied();
    }
    Ok(report)
  }
}

pub struct DatabaseManagedReconciliation {
  pub ready: bool,
}

enum ReconciliationStep {
  Finished(bool),
  Advanced,
}

/// Commit one exact edge at a time and invalidate immediately after each commit.
/// A later failure never discards notifications for earlier committed versions.
#[tracing::instrument(skip_all)]
pub async fn reconcile_managed_database(
  catalog: &DatabaseStarterTemplateCatalog,
  repository: &dyn DatabaseDefinitionRepository,
  id: DatabaseId,
  changes: &dyn crate::ports::database_change::DatabaseChangeNotificationPort,
  projection: &crate::database::DatabaseProjectionService,
) -> DatabaseResult<DatabaseManagedReconciliation> {
  // Inventory bounds every route to at most256edges. Conflicts reload the native
  // winner, with a fresh bounded retry allowance after each committed edge.
  for _ in 0..=256 {
    let mut attempts = 0;
    let step = loop {
      match reconcile_managed_database_once(catalog, repository, id, changes, projection).await {
        Err(error) if error.code == ERR_DATABASE_CONFLICT && attempts < 2 => {
          attempts += 1;
        }
        result => break result?,
      }
    };
    match step {
      ReconciliationStep::Finished(ready) => return Ok(DatabaseManagedReconciliation { ready }),
      ReconciliationStep::Advanced => continue,
    }
  }
  Err(DatabaseServiceError::new(
    crate::database::ERR_TEMPLATE_INVALID,
    "MANAGED_TRANSITION_ROUTE_LIMIT",
  ))
}

async fn reconcile_managed_database_once(
  catalog: &DatabaseStarterTemplateCatalog,
  repository: &dyn DatabaseDefinitionRepository,
  id: DatabaseId,
  changes: &dyn crate::ports::database_change::DatabaseChangeNotificationPort,
  projection: &crate::database::DatabaseProjectionService,
) -> DatabaseResult<ReconciliationStep> {
  let record = repository
    .get_database_for_lifecycle(id)
    .await?
    .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database not found"))?;
  let Some(installed) = record.database.managed_installation.as_ref() else {
    return Ok(ReconciliationStep::Finished(false));
  };
  let Some((current_version, _)) = catalog.current_source(&installed.template_id) else {
    return Ok(ReconciliationStep::Finished(false));
  };
  // An older node must not write even readiness metadata on a newer/unknown
  // installation. The read projection already reports its local unavailability.
  if catalog
    .version_source(&installed.template_id, &installed.template_version)
    .is_none()
    || crate::database::definition::templates::compare_template_versions(&installed.template_version, current_version)
      .is_ok_and(|order| order == std::cmp::Ordering::Greater)
  {
    return Ok(ReconciliationStep::Finished(false));
  }
  let mut next = installed.clone();
  let mut replacement = None;
  let admission = (|| -> DatabaseResult<()> {
    verify_installed_structure(catalog, &record)?;
    replacement = plan_forward_transition(catalog, &record)?;
    if let Some(state) = &replacement {
      next = state
        .database
        .managed_installation
        .as_ref()
        .expect("managed target")
        .clone();
      next.schema_revision = installed.schema_revision + 1;
    }
    Ok(())
  })();
  let remaining = next.template_version != current_version;
  next.readiness = if admission.is_ok() && !remaining {
    DatabaseManagedSchemaReadiness::Ready
  } else {
    DatabaseManagedSchemaReadiness::Unavailable
  };
  next.reason_code = admission
    .err()
    .map(|error| error.message)
    .or_else(|| remaining.then(|| "MANAGED_UPDATE_INCOMPLETE".into()));
  let ready = next.readiness == DatabaseManagedSchemaReadiness::Ready;
  let advanced = replacement.is_some();
  let changed = serde_json::to_value(installed)
    .map_err(|error| DatabaseServiceError::new(crate::database::ERR_TEMPLATE_INVALID, error.to_string()))?
    != serde_json::to_value(&next)
      .map_err(|error| DatabaseServiceError::new(crate::database::ERR_TEMPLATE_INVALID, error.to_string()))?
    || advanced;
  if changed {
    let affected_rows = repository.commit_managed_schema(id, &record, replacement, next).await?;
    let event = DatabaseChangeEvent::system(record.database.workspace_id, id, DatabaseChangeKind::DatabaseUpdated);
    if let Err(error) = changes.publish_change(&event).await {
      tracing::warn!(database_id=%id,error=%error,"committed managed schema invalidation failed");
    }
    if let Err(error) = changes.publish_tasks_changed(&event).await {
      tracing::warn!(database_id=%id,error=%error,"committed managed Task invalidation failed");
    }
    for row_id in affected_rows {
      projection
        .enqueue_index_row(record.database.workspace_id, id, row_id, 0)
        .await;
    }
  }
  Ok(if advanced {
    ReconciliationStep::Advanced
  } else {
    ReconciliationStep::Finished(ready)
  })
}
