// SPDX-License-Identifier: AGPL-3.0-or-later

//! Authorized native Task/Field presentation, resolved against current ownership
//! and managed readiness. Descriptors never grant native write capabilities.
use super::AssistantPackageService;
use super::validation::invalid;
use crate::database::DatabaseResult;
use myoxus_domain::assistant_package::*;
use myoxus_domain::database::*;
use myoxus_domain::ids::*;
use myoxus_domain::repositories::RepositoryError;
use std::collections::BTreeSet;

impl AssistantPackageService {
  #[tracing::instrument(skip_all)]
  pub async fn resolve_presentation(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    context: AssistantPackageContext,
    database_id: Option<DatabaseId>,
    row_id: Option<DatabaseRowId>,
  ) -> DatabaseResult<AssistantResolvedPresentation> {
    self.views.assert_workspace_read(actor, workspace_id).await?;
    let descriptor = self
      .default_descriptor(context)
      .ok_or_else(|| invalid("native presentation package unavailable"))?;
    let mut result = AssistantResolvedPresentation {
      descriptor,
      database_id,
      row_id,
      managed_schema: None,
      fields: Vec::new(),
      unavailable_reason: None,
    };
    if matches!(
      context,
      AssistantPackageContext::WorkspaceCreation
        | AssistantPackageContext::ProjectCreation
        | AssistantPackageContext::TaskHome
        | AssistantPackageContext::TaskInventory
    ) {
      return Ok(result);
    }
    let mut row_fields: Option<BTreeSet<DatabaseFieldId>> = None;
    let database_id = if let Some(row) = row_id {
      let hint = database_id.ok_or_else(|| invalid("native Row context requires its Database hint"))?;
      let row = self
        .views
        .get_row_for_read(actor, hint, row, true)
        .await?
        .ok_or(RepositoryError::NotFound("database row"))?;
      if row.row.row_kind != DatabaseRowKind::Task {
        return Err(RepositoryError::NotFound("native Task").into());
      }
      row_fields = Some(row.cells.iter().map(|cell| cell.field_id).collect());
      row.row.database_id
    } else if let Some(database) = database_id {
      database
    } else {
      let destinations = self.views.task_destinations(actor, workspace_id, 1, None).await?;
      let Some(default) = destinations.default_destination else {
        result.unavailable_reason = Some("WORKSPACE_TASKS_UNAVAILABLE".into());
        return Ok(result);
      };
      default.database_id
    };
    let record = self.definition.get_database(actor, database_id).await?;
    if record.database.workspace_id != workspace_id {
      return Err(RepositoryError::NotFound("database").into());
    }
    result.database_id = Some(database_id);
    result.managed_schema = record.managed_schema.clone();
    if record
      .managed_schema
      .as_ref()
      .is_none_or(|schema| schema.readiness != DatabaseManagedSchemaReadiness::Ready)
    {
      result.unavailable_reason = Some("MANAGED_SCHEMA_UNAVAILABLE".into());
      return Ok(result);
    }
    result.fields = resolve_fields(&result.descriptor, &record).map_err(invalid)?;
    if context == AssistantPackageContext::TaskDetail && row_fields.is_none() {
      result.unavailable_reason = Some("TASK_ROW_CONTEXT_REQUIRED".into());
      return Ok(result);
    }
    for group in result
      .descriptor
      .presentation
      .steps
      .iter_mut()
      .flat_map(|step| step.groups.iter_mut())
      .chain(
        result
          .descriptor
          .presentation
          .dialogs
          .iter_mut()
          .flat_map(|dialog| dialog.groups.iter_mut()),
      )
    {
      group.controls.retain(|control| {
        let AssistantControl::NativeCell { binding, presence } = control else {
          return true;
        };
        let Some(field) = result.fields.iter().find(|field| field.binding == *binding) else {
          return false;
        };
        match presence {
          AssistantCellPresence::Always => true,
          AssistantCellPresence::Present => row_fields
            .as_ref()
            .is_none_or(|fields| fields.contains(&field.field_id)),
          AssistantCellPresence::Empty => row_fields
            .as_ref()
            .is_none_or(|fields| !fields.contains(&field.field_id)),
        }
      });
    }
    Ok(result)
  }
}

pub fn resolve_fields(
  descriptor: &AssistantPackageDescriptor,
  record: &DatabaseRecord,
) -> Result<Vec<AssistantResolvedField>, String> {
  let installation = record
    .database
    .managed_installation
    .as_ref()
    .ok_or("native managed bindings unavailable")?;
  if record
    .managed_schema
    .as_ref()
    .is_none_or(|schema| schema.readiness != DatabaseManagedSchemaReadiness::Ready)
  {
    return Err("native managed schema unavailable".into());
  }
  let mut fields = Vec::new();
  for control in descriptor
    .presentation
    .steps
    .iter()
    .flat_map(|step| step.groups.iter())
    .chain(
      descriptor
        .presentation
        .dialogs
        .iter()
        .flat_map(|dialog| dialog.groups.iter()),
    )
    .flat_map(|group| group.controls.iter())
  {
    let AssistantControl::NativeCell { binding, .. } = control else {
      continue;
    };
    if fields
      .iter()
      .any(|field: &AssistantResolvedField| field.binding == *binding)
    {
      continue;
    }
    let id = match binding {
      AssistantFieldBinding::Role { role_key } => record
        .field_roles
        .iter()
        .find(|role| role.role_key == *role_key && role.row_kind_scope.as_deref() == Some("task"))
        .map(|role| role.field_id),
      AssistantFieldBinding::Field { field_key } => installation.field_bindings.get(field_key).copied(),
    };
    let id = if let Some(id) = id {
      id
    } else {
      let semantic = DATABASE_PROJECT_SEMANTIC_CATALOG.iter().find(|role| {
        role.row_kind_scope == DatabaseRowKind::Task
          && match binding {
            AssistantFieldBinding::Role { role_key } => role.role_key == role_key,
            AssistantFieldBinding::Field { field_key } => role.field_key == field_key,
          }
      });
      if semantic.is_some_and(|role| !role.applies_to(installation.variant.structure)) {
        continue;
      }
      return Err("native presentation binding unavailable".into());
    };
    let field = record
      .fields
      .iter()
      .find(|field| field.id == id)
      .ok_or("native presentation Field unavailable")?;
    fields.push(AssistantResolvedField {
      binding: binding.clone(),
      field_id: id,
      field_type: field.field_type,
      name: field.name.clone(),
      required: field.required,
      config: field.config.clone(),
    });
  }
  Ok(fields)
}
