// SPDX-License-Identifier: AGPL-3.0-or-later

//! Structural verification rebinds native identities without inspecting or
//! reseeding mutable Rows, Cells or Row templates. Guards retain native policy.
use super::install_source_metadata_at;
use crate::database::{
  DatabaseLimits, DatabaseResult, DatabaseServiceError, DatabaseStarterTemplateCatalog, ERR_FORBIDDEN,
  ERR_TEMPLATE_INVALID,
};
use myoxus_domain::database::{
  DatabaseInitialState, DatabaseManagedSchemaReadiness, DatabaseProfileKind, DatabaseRecord, DatabaseTemplateSelection,
};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(in crate::database) fn assert_structure_edit(record: &DatabaseRecord) -> DatabaseResult<()> {
  if record.database.profile_kind == DatabaseProfileKind::Project {
    return Err(DatabaseServiceError::new(
      ERR_FORBIDDEN,
      "managed database structure is protected",
    ));
  }
  Ok(())
}

pub(in crate::database::definition) fn assert_metadata_lifecycle_edit(record: &DatabaseRecord) -> DatabaseResult<()> {
  if record.database.system_role.is_some()
    || (record.database.profile_kind == DatabaseProfileKind::Project
      && record
        .database
        .managed_installation
        .as_ref()
        .is_none_or(|installed| installed.readiness != DatabaseManagedSchemaReadiness::Ready))
  {
    return Err(DatabaseServiceError::new(
      ERR_FORBIDDEN,
      "managed database metadata or lifecycle is unavailable",
    ));
  }
  Ok(())
}

/// Rebind only declared structural identities; mutable Rows/Cells/templates are never part of verification.
pub(crate) fn expected_state_at(
  catalog: &DatabaseStarterTemplateCatalog,
  record: &DatabaseRecord,
  version: &str,
) -> DatabaseResult<DatabaseInitialState> {
  let installed = record
    .database
    .managed_installation
    .as_ref()
    .ok_or_else(|| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, "MANAGED_SCHEMA_NOT_INSTALLED"))?;
  let variant = &installed.variant;
  let spec = catalog
    .select_version(
      &installed.template_id,
      version,
      DatabaseTemplateSelection {
        priority: variant.priority,
        complexity: variant.complexity,
        structure: variant.structure,
      },
    )
    .ok_or_else(|| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, "MANAGED_SOURCE_UNAVAILABLE"))?;
  let mut state = crate::database::definition::templates::materialize_template(
    &DatabaseLimits::default(),
    record.database.created_by.unwrap_or_default(),
    record.database.workspace_id,
    &record.database.title,
    record.database.description.clone(),
    false,
    &variant.currency,
    spec.clone(),
  )?;
  install_source_metadata_at(catalog, &installed.template_id, version, &mut state)?;
  let generated = state
    .database
    .managed_installation
    .as_ref()
    .expect("Project materialization installs metadata");
  let mut ids = BTreeMap::from([(state.database.id, record.database.id)]);
  for (key, id) in &generated.field_bindings {
    if let Some(existing) = installed.field_bindings.get(key) {
      ids.insert(*id, *existing);
    }
  }
  for (key, id) in &generated.view_bindings {
    if let Some(existing) = installed.view_bindings.get(key) {
      ids.insert(*id, *existing);
    }
  }
  fn rewrite(value: &mut serde_json::Value, ids: &BTreeMap<Uuid, Uuid>) {
    match value {
      serde_json::Value::String(text) => {
        if let Ok(id) = Uuid::parse_str(text) {
          if let Some(mapped) = ids.get(&id) {
            *text = mapped.to_string();
          }
        }
      }
      serde_json::Value::Array(values) => {
        for value in values {
          rewrite(value, ids)
        }
      }
      serde_json::Value::Object(values) => {
        for value in values.values_mut() {
          rewrite(value, ids)
        }
      }
      _ => {}
    }
  }
  let mut value = serde_json::to_value(&state.database)
    .map_err(|error| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, error.to_string()))?;
  rewrite(&mut value, &ids);
  state.database = serde_json::from_value(value)
    .map_err(|error| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, error.to_string()))?;
  macro_rules! rebind {
    ($field:ident) => {{
      let mut value = serde_json::to_value(&state.$field)
        .map_err(|error| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, error.to_string()))?;
      rewrite(&mut value, &ids);
      state.$field = serde_json::from_value(value)
        .map_err(|error| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, error.to_string()))?;
    }};
  }
  rebind!(fields);
  rebind!(views);
  rebind!(roles);
  rebind!(view_roles);
  state.database.created_by = record.database.created_by;
  state.database.updated_by = record.database.updated_by;
  Ok(state)
}

pub(crate) fn structural_value(record: &DatabaseRecord) -> serde_json::Value {
  serde_json::json!({"profile":record.database.profile_kind,"structure":record.database.profile_structure_preset,"config":record.database.profile_config,
    "fields":record.fields.iter().map(|field|serde_json::json!([field.id,field.name,field.field_type,field.config,field.position,field.required])).collect::<Vec<_>>(),
    "views":record.views.iter().map(|view|serde_json::json!([view.id,view.name,view.view_kind,view.icon,view.config,view.position])).collect::<Vec<_>>(),
    "roles":record.field_roles.iter().map(|role|(format!("{}:{:?}",role.role_key,role.row_kind_scope),serde_json::json!([role.field_id,role.required,role.config]))).collect::<BTreeMap<_,_>>(),
    "viewRoles":record.view_roles.iter().map(|role|(role.role_key.clone(),serde_json::json!([role.view_id,role.required]))).collect::<BTreeMap<_,_>>()})
}

pub(super) fn verify_installed_structure(
  catalog: &DatabaseStarterTemplateCatalog,
  record: &DatabaseRecord,
) -> DatabaseResult<()> {
  let installed = record
    .database
    .managed_installation
    .as_ref()
    .ok_or_else(|| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, "MANAGED_SCHEMA_NOT_INSTALLED"))?;
  let (_, digest) = catalog
    .version_source(&installed.template_id, &installed.template_version)
    .ok_or_else(|| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, "MANAGED_SOURCE_UNAVAILABLE"))?;
  if digest != installed.template_digest {
    return Err(DatabaseServiceError::new(
      ERR_TEMPLATE_INVALID,
      "MANAGED_SOURCE_DIGEST_MISMATCH",
    ));
  }
  let expected = expected_state_at(catalog, record, &installed.template_version)?;
  let expected_record = DatabaseRecord {
    database: expected.database.clone(),
    fields: expected.fields.clone(),
    views: expected.views.clone(),
    field_roles: expected.roles.clone(),
    view_roles: expected.view_roles.clone(),
    row_count: 0,
    managed_schema: None,
  };
  let expected_installation = expected
    .database
    .managed_installation
    .as_ref()
    .expect("native expected state installs source metadata");
  if installed.field_bindings != expected_installation.field_bindings
    || installed.view_bindings != expected_installation.view_bindings
    || installed.variant != expected_installation.variant
    || structural_value(record) != structural_value(&expected_record)
  {
    return Err(DatabaseServiceError::new(
      ERR_TEMPLATE_INVALID,
      "MANAGED_STRUCTURE_MISMATCH",
    ));
  }
  Ok(())
}
