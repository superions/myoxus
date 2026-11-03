// SPDX-License-Identifier: AGPL-3.0-or-later

//! Plan one admitted edge from the current installation; reconciliation reloads
//! committed identities before planning its next edge. Typed native operations
//! are validated against the actual rebound Field configs before persistence.
use super::verification::expected_state_at;
use crate::database::{DatabaseResult, DatabaseServiceError, DatabaseStarterTemplateCatalog, ERR_TEMPLATE_INVALID};
use myoxus_domain::database::{DatabaseInitialState, DatabaseRecord};

pub(super) fn plan_forward_transition(
  catalog: &DatabaseStarterTemplateCatalog,
  record: &DatabaseRecord,
) -> DatabaseResult<Option<DatabaseInitialState>> {
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
  let route = catalog
    .update_route(&installed.template_id, &installed.template_version)
    .ok_or_else(|| DatabaseServiceError::new(ERR_TEMPLATE_INVALID, "MANAGED_TRANSITION_UNSUPPORTED"))?;
  if let Some(edge) = route.first() {
    if edge.source.sha256 != installed.template_digest {
      return Err(DatabaseServiceError::new(
        ERR_TEMPLATE_INVALID,
        "MANAGED_SOURCE_DIGEST_MISMATCH",
      ));
    }
    // Rebuild only the next edge from canonical committed bindings. Planning
    // later edges here would allocate identities before their predecessors commit.
    let state = expected_state_at(catalog, record, &edge.target.version)?;
    let new = state.database.managed_installation.as_ref().expect("managed target");
    if !installed
      .field_bindings
      .keys()
      .all(|key| new.field_bindings.contains_key(key))
      || !installed
        .view_bindings
        .keys()
        .all(|key| new.view_bindings.contains_key(key))
    {
      return Err(DatabaseServiceError::new(
        ERR_TEMPLATE_INVALID,
        "MANAGED_TRANSITION_REQUIRES_REVIEWED_CONVERSION",
      ));
    }
    // The immutable edge alone grants a finite Select mapping or metadata-only
    // Status append. Neither may reinterpret existing Status values/defaults.
    if record.fields.iter().any(|old| {
      state
        .fields
        .iter()
        .find(|field| field.id == old.id)
        .is_none_or(|field| {
          if field.field_type != old.field_type || field.required != old.required {
            return true;
          }
          let field_key = installed
            .field_bindings
            .iter()
            .find(|(_, id)| **id == old.id)
            .map(|(key, _)| key.as_str());
          let explicit = edge.operations.iter().find_map(|operation| {
            let myoxus_domain::database::DatabaseTemplateUpdateOperation::MapSelectOptions {
              field_key: key,
              mapping,
            } = operation;
            (Some(key.as_str()) == field_key).then_some(mapping.clone())
          });
          if field.config == old.config && explicit.is_none() {
            return false;
          }
          if let (
            myoxus_domain::database::DatabaseFieldConfig::Status(before),
            myoxus_domain::database::DatabaseFieldConfig::Status(after),
          ) = (&old.config, &field.config)
          {
            return explicit.is_some()
              || myoxus_domain::database::validate_status_option_append(before, after).is_err();
          }
          myoxus_domain::database::DatabaseSelectOptionMapping::new(
            &old.config,
            &field.config,
            explicit.unwrap_or_default(),
          )
          .is_err()
        })
    }) || record.field_roles.iter().any(|old| {
      state
        .roles
        .iter()
        .find(|role| role.role_key == old.role_key && role.row_kind_scope == old.row_kind_scope)
        .is_none_or(|role| role.field_id != old.field_id || role.required != old.required || role.config != old.config)
    }) {
      return Err(DatabaseServiceError::new(
        ERR_TEMPLATE_INVALID,
        "MANAGED_TRANSITION_REQUIRES_REVIEWED_CONVERSION",
      ));
    }
    return Ok(Some(state));
  }
  Ok(None)
}
