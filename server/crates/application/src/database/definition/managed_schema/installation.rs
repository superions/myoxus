// SPDX-License-Identifier: AGPL-3.0-or-later

//! Attach native source pins and stable bindings to newly materialized states.
use crate::database::{DatabaseResult, DatabaseServiceError, DatabaseStarterTemplateCatalog, ERR_TEMPLATE_INVALID};
use myoxus_domain::database::{
  DatabaseDomainError, DatabaseInitialState, DatabaseManagedSchemaInstallation, DatabaseManagedSchemaReadiness,
  DatabaseManagedSchemaVariant, DatabaseProfileKind, DatabaseProjectOptionPreset,
};

pub(crate) fn install_source_metadata(
  catalog: &DatabaseStarterTemplateCatalog,
  template_id: &str,
  state: &mut DatabaseInitialState,
) -> DatabaseResult<()> {
  if state.database.profile_kind == DatabaseProfileKind::Generic {
    return Ok(());
  }
  let (version, _) = catalog
    .current_source(template_id)
    .ok_or_else(|| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, "managed source missing"))?;
  install_source_metadata_at(catalog, template_id, version, state)
}

/// Install the exact edge target, including an intermediate retained version.
pub(crate) fn install_source_metadata_at(
  catalog: &DatabaseStarterTemplateCatalog,
  template_id: &str,
  version: &str,
  state: &mut DatabaseInitialState,
) -> DatabaseResult<()> {
  if state.database.profile_kind == DatabaseProfileKind::Generic {
    return Ok(());
  }
  let structure = state
    .database
    .profile_structure_preset
    .as_deref()
    .unwrap_or("tasks_only")
    .parse()
    .map_err(|error: DatabaseDomainError| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, error.to_string()))?;
  let option = |key: &str| -> DatabaseResult<DatabaseProjectOptionPreset> {
    serde_json::from_value(
      state
        .database
        .profile_config
        .get(key)
        .cloned()
        .unwrap_or(serde_json::Value::Null),
    )
    .map_err(|_| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, "managed template has no native option preset"))
  };
  let priority = option("priorityPreset")?;
  let complexity = option("complexityPreset")?;
  let currency = state
    .database
    .profile_config
    .get("defaultCurrency")
    .and_then(|value| value.as_str())
    .unwrap_or("EUR")
    .to_string();
  let spec = catalog
    .select_version(
      template_id,
      version,
      myoxus_domain::database::DatabaseTemplateSelection {
        priority,
        complexity,
        structure,
      },
    )
    .ok_or_else(|| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, "managed template missing"))?;
  let (_, digest) = catalog
    .version_source(template_id, version)
    .ok_or_else(|| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, "managed source missing"))?;
  state.database.managed_installation = Some(DatabaseManagedSchemaInstallation {
    template_id: template_id.into(),
    template_version: version.into(),
    template_digest: digest.into(),
    variant: DatabaseManagedSchemaVariant {
      priority,
      complexity,
      structure,
      currency,
    },
    schema_revision: 1,
    field_bindings: spec
      .fields
      .iter()
      .zip(&state.fields)
      .map(|(source, field)| (source.key.clone(), field.id))
      .collect(),
    view_bindings: spec
      .to_manifest()
      .map_err(|message| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, message))?
      .views
      .iter()
      .zip(&state.views)
      .map(|(source, view)| (source.key.clone(), view.id))
      .collect(),
    readiness: DatabaseManagedSchemaReadiness::Ready,
    reason_code: None,
  });
  Ok(())
}
