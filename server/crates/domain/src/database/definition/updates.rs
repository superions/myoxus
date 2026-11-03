// SPDX-License-Identifier: AGPL-3.0-or-later

//! Immutable transition authority; definitions remain the sole schema source.

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateUpdateEndpoint {
  pub version: String,
  pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateUpdateReference {
  pub from: String,
  pub to: String,
  pub path: String,
  pub sha256: String,
}

/// Closed native operations; unknown instructions are rejected during capture.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseTemplateUpdateOperation {
  MapSelectOptions {
    field_key: String,
    mapping: std::collections::BTreeMap<String, String>,
  },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateUpdateSource {
  pub format_version: u32,
  pub template_id: String,
  pub source: DatabaseTemplateUpdateEndpoint,
  pub target: DatabaseTemplateUpdateEndpoint,
  pub operations: Vec<DatabaseTemplateUpdateOperation>,
}

/// Structural-only edges cannot reinterpret existing native values or role
/// admission. Presentation and additive fields/views remain definition-owned.
pub fn validate_structural_template_update(
  source: &crate::database::DatabaseTemplateSpec,
  target: &crate::database::DatabaseTemplateSpec,
) -> Result<(), String> {
  validate_template_update(source, target, &[])
}

/// Validate every operation against one native variant. Callers apply this to
/// each admitted source/target variant before installing any instance.
pub fn validate_template_update(
  source: &crate::database::DatabaseTemplateSpec,
  target: &crate::database::DatabaseTemplateSpec,
  operations: &[DatabaseTemplateUpdateOperation],
) -> Result<(), String> {
  use crate::database::{DatabaseProfileKind, DatabaseTemplateFieldConfig};
  let mut mappings = std::collections::BTreeMap::new();
  for operation in operations {
    let DatabaseTemplateUpdateOperation::MapSelectOptions { field_key, mapping } = operation;
    if field_key.trim().is_empty() || mappings.insert(field_key.as_str(), mapping).is_some() {
      return Err("repeated or blank Select mapping field".into());
    }
    if !source.fields.iter().any(|field| field.key == *field_key) {
      return Err(format!("Select mapping source field unavailable: {field_key}"));
    }
  }
  if source.id != target.id
    || source.profile_kind != DatabaseProfileKind::Project
    || target.profile_kind != DatabaseProfileKind::Project
    || source.default_structure != target.default_structure
    || source.priority_preset != target.priority_preset
    || source.complexity_preset != target.complexity_preset
  {
    return Err("update requires the same managed native variant".into());
  }
  for field in &source.fields {
    let next = target
      .fields
      .iter()
      .find(|next| next.key == field.key)
      .ok_or("structural update cannot remove a field")?;
    if next.field_type != field.field_type || next.required != field.required {
      return Err(format!(
        "unsupported type/cardinality or requiredness change: {}",
        field.key
      ));
    }
    let mapping = mappings.get(field.key.as_str()).copied();
    let same = serde_json::to_value(&next.config).map_err(|error| error.to_string())?
      == serde_json::to_value(&field.config).map_err(|error| error.to_string())?;
    if !same || mapping.is_some() {
      let (DatabaseTemplateFieldConfig::Direct(before), DatabaseTemplateFieldConfig::Direct(after)) =
        (&field.config, &next.config)
      else {
        return Err(format!("unsupported native field conversion: {}", field.key));
      };
      if let (
        crate::database::DatabaseFieldConfig::Status(before),
        crate::database::DatabaseFieldConfig::Status(after),
      ) = (before, after)
      {
        if mapping.is_some() {
          return Err("Status options cannot use Select mappings".into());
        }
        validate_status_option_append(before, after).map_err(|error| format!("{}: {error}", field.key))?;
      } else {
        DatabaseSelectOptionMapping::new(before, after, mapping.cloned().unwrap_or_default())
          .map_err(|error| format!("{}: {error}", field.key))?;
      }
    }
  }
  for role in &source.roles {
    let next = target
      .roles
      .iter()
      .find(|next| next.role_key == role.role_key && next.row_kind_scope == role.row_kind_scope)
      .ok_or("structural update cannot remove a native role")?;
    if next.field_key != role.field_key
      || next.required != role.required
      || next.managed_state != role.managed_state
      || next.config != role.config
    {
      return Err("structural update cannot change native role policy".into());
    }
  }
  let before = source.to_manifest()?;
  let after = target.to_manifest()?;
  if before
    .views
    .iter()
    .any(|view| !after.views.iter().any(|next| next.key == view.key))
  {
    return Err("structural update cannot remove a bound View".into());
  }
  Ok(())
}

/// Adding a lifecycle choice is metadata-only. Existing values, ordering,
/// groups and the absent-Cell default must retain their exact interpretation.
pub fn validate_status_option_append(
  source: &crate::database::DatabaseStatusFieldConfig,
  target: &crate::database::DatabaseStatusFieldConfig,
) -> Result<(), String> {
  crate::database::validate_database_status_field_config(target)?;
  if source.default_option_id != target.default_option_id || !target.options.starts_with(&source.options) {
    return Err("Status updates may only append options without changing existing semantics".into());
  }
  Ok(())
}

/// Stable value-conversion diagnostics; callers add only native identity paths,
/// never the original content value, before surfacing a failed edge.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, thiserror::Error)]
#[error("{reason:?} at {path}")]
pub struct DatabaseSelectUpdateError {
  pub reason: DatabaseSelectUpdateReason,
  pub path: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DatabaseSelectUpdateReason {
  UnknownSourceOption,
  MissingTargetOption,
  IncompatibleValueType,
  AmbiguousGroupReference,
}
impl DatabaseSelectUpdateError {
  pub fn validation_message(&self) -> String {
    format!(
      "MANAGED_SELECT_UPDATE:{}",
      serde_json::to_string(self).expect("native update diagnostic serializes")
    )
  }
  pub fn from_validation_message(message: &str) -> Option<Self> {
    serde_json::from_str(message.strip_prefix("MANAGED_SELECT_UPDATE:")?).ok()
  }
  fn new(reason: DatabaseSelectUpdateReason) -> Self {
    Self {
      reason,
      path: String::new(),
    }
  }
  pub fn at_path(mut self, path: impl Into<String>) -> Self {
    self.path = path.into();
    self
  }
}

/// A validated simultaneous mapping. No replacement can become the input of
/// another replacement in the same edge. Empty/native null slots stay empty.
#[derive(Debug, Clone)]
pub struct DatabaseSelectOptionMapping {
  source: std::collections::BTreeSet<String>,
  target: std::collections::BTreeSet<String>,
  mapping: std::collections::BTreeMap<String, String>,
  multiple: bool,
}
impl DatabaseSelectOptionMapping {
  pub fn new(
    source: &crate::database::DatabaseFieldConfig,
    target: &crate::database::DatabaseFieldConfig,
    mapping: std::collections::BTreeMap<String, String>,
  ) -> Result<Self, String> {
    use crate::database::DatabaseFieldConfig;
    let (before, after, multiple) = match (source, target) {
      (DatabaseFieldConfig::Select(before), DatabaseFieldConfig::Select(after)) => (before, after, false),
      (DatabaseFieldConfig::MultiSelect(before), DatabaseFieldConfig::MultiSelect(after)) => (before, after, true),
      _ => return Err("Select mapping requires unchanged native Select cardinality".into()),
    };
    let source = before
      .options
      .iter()
      .map(|option| option.id.clone())
      .collect::<std::collections::BTreeSet<_>>();
    let target = after
      .options
      .iter()
      .map(|option| option.id.clone())
      .collect::<std::collections::BTreeSet<_>>();
    if source.len() != before.options.len()
      || target.len() != after.options.len()
      || source
        .iter()
        .chain(&target)
        .any(|id| id.is_empty() || id == "__empty__")
      || mapping
        .iter()
        .any(|(old, new)| !source.contains(old) || !target.contains(new))
      || source
        .iter()
        .any(|old| !target.contains(old) && !mapping.contains_key(old))
    {
      return Err("invalid or incomplete Select option mapping".into());
    }
    Ok(Self {
      source,
      target,
      mapping,
      multiple,
    })
  }
  pub fn map_option_id(&self, value: &str) -> Result<String, DatabaseSelectUpdateError> {
    if value.is_empty() {
      return Ok(value.into());
    }
    if !self.source.contains(value) {
      return Err(DatabaseSelectUpdateError::new(
        DatabaseSelectUpdateReason::UnknownSourceOption,
      ));
    }
    let mapped = self.mapping.get(value).map(String::as_str).unwrap_or(value);
    if !self.target.contains(mapped) {
      return Err(DatabaseSelectUpdateError::new(
        DatabaseSelectUpdateReason::MissingTargetOption,
      ));
    }
    Ok(mapped.into())
  }
  pub fn map_ids(&self, values: &[String]) -> Result<Vec<String>, DatabaseSelectUpdateError> {
    let mut seen = std::collections::BTreeSet::new();
    let mut result = Vec::new();
    for value in values {
      let mapped = self.map_option_id(value)?;
      if seen.insert(mapped.clone()) {
        result.push(mapped);
      }
    }
    Ok(result)
  }
  pub fn map_value(
    &self,
    value: &crate::database::DatabaseCellValueData,
  ) -> Result<crate::database::DatabaseCellValueData, DatabaseSelectUpdateError> {
    use crate::database::DatabaseCellValueData;
    match value {
      DatabaseCellValueData::Select(value) if !self.multiple => {
        Ok(DatabaseCellValueData::Select(self.map_option_id(value)?))
      }
      DatabaseCellValueData::MultiSelect(values) if self.multiple => {
        Ok(DatabaseCellValueData::MultiSelect(self.map_ids(values)?))
      }
      _ => Err(DatabaseSelectUpdateError::new(
        DatabaseSelectUpdateReason::IncompatibleValueType,
      )),
    }
  }
}
