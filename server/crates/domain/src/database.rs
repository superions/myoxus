//! Server-owned Database domain contract.
//!
//! These types deliberately do not depend on Collections, Yjs, GraphQL or SQLx.
//! A workspace database is its own product model: the server owns fields,
//! views, rows and cell values, while editor blocks only store references.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::str::FromStr;

use crate::ids::{DatabaseFieldId, DatabaseId, DatabaseRowId, DatabaseViewId, DocId, UserId, WorkspaceId};
use crate::template_registry::TemplateCatalogEntryId;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use unicode_segmentation::UnicodeSegmentation;
use uuid::Uuid;

/// Product category used by server-owned Database starter templates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseStarterTemplateCategory {
  Database,
  Project,
}

impl DatabaseStarterTemplateCategory {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Database => "database",
      Self::Project => "project",
    }
  }
}

impl FromStr for DatabaseStarterTemplateCategory {
  type Err = DatabaseDomainError;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "database" => Ok(Self::Database),
      "project" => Ok(Self::Project),
      _ => Err(DatabaseDomainError::InvalidStarterTemplate(format!(
        "invalid starter template category: {value}"
      ))),
    }
  }
}

pub const DATABASE_STARTER_TEMPLATE_SCHEMA_VERSION: u32 = 1;

/// Stable registry-facing contract for a server-owned Database starter
/// template.
///
/// The runtime catalog may still be built in Rust, but it must be expressible
/// through this manifest shape before it can be exposed to clients or later
/// externalized into a bundle. References use stable local keys rather than
/// allocated UUIDs so imports can allocate fresh Database IDs safely.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStarterTemplateManifest {
  pub schema_version: u32,
  pub id: String,
  pub category: DatabaseStarterTemplateCategory,
  pub profile_kind: DatabaseProfileKind,
  pub name_key: String,
  pub description_key: String,
  pub default_structure: Option<String>,
  pub fields: Vec<DatabaseStarterTemplateFieldManifest>,
  pub roles: Vec<DatabaseStarterTemplateRoleManifest>,
  pub views: Vec<DatabaseStarterTemplateViewManifest>,
  pub row_templates: Vec<DatabaseStarterTemplateRowTemplateManifest>,
  #[serde(default)]
  pub sample_rows: Vec<DatabaseStarterTemplateSampleRowManifest>,
  #[serde(default)]
  pub import_mappings: Vec<DatabaseStarterTemplateImportMappingManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStarterTemplateFieldManifest {
  pub key: String,
  pub name_key: String,
  pub field_type: DatabaseFieldType,
  pub required: bool,
  pub config_kind: String,
  #[serde(default)]
  pub import_export_behavior: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStarterTemplateRoleManifest {
  pub role_key: String,
  pub row_kind_scope: Option<String>,
  pub field_key: String,
  pub required: bool,
  #[serde(default)]
  pub managed_state: Option<DatabaseProjectRoleManagedState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStarterTemplateViewManifest {
  pub key: String,
  pub name_key: String,
  pub view_kind: DatabaseViewKind,
  pub primary: bool,
  pub field_keys: Vec<String>,
  #[serde(default)]
  pub visible_field_keys: Vec<String>,
  #[serde(default)]
  pub axis_field_keys: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseStarterTemplateValidationBoundary {
  Field,
  View,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error("{message}")]
pub struct DatabaseStarterTemplateContractError {
  pub boundary: DatabaseStarterTemplateValidationBoundary,
  pub message: String,
}

impl DatabaseStarterTemplateContractError {
  fn field(message: impl Into<String>) -> Self {
    Self {
      boundary: DatabaseStarterTemplateValidationBoundary::Field,
      message: message.into(),
    }
  }

  fn view(message: impl Into<String>) -> Self {
    Self {
      boundary: DatabaseStarterTemplateValidationBoundary::View,
      message: message.into(),
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStarterTemplateRowTemplateManifest {
  pub key: String,
  pub name_key: String,
  pub description_key: Option<String>,
  pub row_kind: DatabaseRowKind,
  pub is_default: bool,
  pub initial_field_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStarterTemplateSampleRowManifest {
  pub key: String,
  pub title_key: Option<String>,
  pub field_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStarterTemplateImportMappingManifest {
  pub key: String,
  pub name_key: String,
  pub column_mappings: Vec<DatabaseStarterTemplateImportColumnManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStarterTemplateImportColumnManifest {
  pub source_header: String,
  pub field_key: String,
  pub required: bool,
}

impl DatabaseStarterTemplateManifest {
  pub fn validate(&self) -> Result<(), DatabaseDomainError> {
    if self.schema_version != DATABASE_STARTER_TEMPLATE_SCHEMA_VERSION {
      return Err(DatabaseDomainError::InvalidStarterTemplate(format!(
        "unsupported starter template schema version {}",
        self.schema_version
      )));
    }
    validate_starter_template_id(&self.id)?;
    validate_starter_template_i18n_key(&self.name_key, "name")?;
    validate_starter_template_i18n_key(&self.description_key, "description")?;
    if self.profile_kind == DatabaseProfileKind::Project && self.category != DatabaseStarterTemplateCategory::Project {
      return Err(DatabaseDomainError::InvalidStarterTemplate(format!(
        "{} has Project profile but non-Project category",
        self.id
      )));
    }
    if self.fields.is_empty() {
      return Err(DatabaseDomainError::InvalidStarterTemplate(format!(
        "{} must define at least one field",
        self.id
      )));
    }
    if self.views.is_empty() {
      return Err(DatabaseDomainError::InvalidStarterTemplate(format!(
        "{} must define at least one view",
        self.id
      )));
    }

    let mut field_keys = BTreeSet::new();
    let mut title_field_count = 0usize;
    for field in &self.fields {
      validate_local_template_key(&self.id, "field", &field.key)?;
      validate_starter_template_i18n_key(&field.name_key, "field name")?;
      validate_non_empty_fragment(&self.id, "field config kind", &field.config_kind)?;
      if !field_keys.insert(field.key.as_str()) {
        return Err(DatabaseDomainError::InvalidStarterTemplate(format!(
          "{} defines duplicate field key {}",
          self.id, field.key
        )));
      }
      if field.field_type == DatabaseFieldType::Title {
        title_field_count += 1;
      }
    }
    if title_field_count != 1 {
      return Err(DatabaseDomainError::InvalidStarterTemplate(format!(
        "{} must define exactly one title field",
        self.id
      )));
    }

    let mut view_keys = BTreeSet::new();
    let mut primary_views = 0usize;
    for view in &self.views {
      validate_local_template_key(&self.id, "view", &view.key)?;
      validate_starter_template_i18n_key(&view.name_key, "view name")?;
      if !view_keys.insert(view.key.as_str()) {
        return Err(DatabaseDomainError::InvalidStarterTemplate(format!(
          "{} defines duplicate view key {}",
          self.id, view.key
        )));
      }
      if view.primary {
        primary_views += 1;
      }
      validate_field_refs(&self.id, "view", &view.key, &view.field_keys, &field_keys)?;
    }
    if primary_views != 1 {
      return Err(DatabaseDomainError::InvalidStarterTemplate(format!(
        "{} must define exactly one primary view",
        self.id
      )));
    }

    for role in &self.roles {
      validate_non_empty_fragment(&self.id, "role key", &role.role_key)?;
      validate_field_ref(&self.id, "role", &role.role_key, &role.field_key, &field_keys)?;
    }

    if !self.row_templates.is_empty() {
      let default_count = self
        .row_templates
        .iter()
        .filter(|row_template| row_template.is_default)
        .count();
      if default_count != 1 {
        return Err(DatabaseDomainError::InvalidStarterTemplate(format!(
          "{} must define exactly one default row template",
          self.id
        )));
      }
    }
    let mut row_template_keys = BTreeSet::new();
    for row_template in &self.row_templates {
      validate_local_template_key(&self.id, "row template", &row_template.key)?;
      validate_starter_template_i18n_key(&row_template.name_key, "row template name")?;
      if let Some(description_key) = &row_template.description_key {
        validate_starter_template_i18n_key(description_key, "row template description")?;
      }
      if self.profile_kind == DatabaseProfileKind::Generic && row_template.row_kind != DatabaseRowKind::Record {
        return Err(DatabaseDomainError::InvalidStarterTemplate(format!(
          "{} generic template row template {} must use record row kind",
          self.id, row_template.key
        )));
      }
      if !row_template_keys.insert(row_template.key.as_str()) {
        return Err(DatabaseDomainError::InvalidStarterTemplate(format!(
          "{} defines duplicate row template key {}",
          self.id, row_template.key
        )));
      }
      validate_field_refs(
        &self.id,
        "row template",
        &row_template.key,
        &row_template.initial_field_keys,
        &field_keys,
      )?;
    }

    let mut sample_keys = BTreeSet::new();
    for sample_row in &self.sample_rows {
      validate_local_template_key(&self.id, "sample row", &sample_row.key)?;
      if let Some(title_key) = &sample_row.title_key {
        validate_starter_template_i18n_key(title_key, "sample row title")?;
      }
      if !sample_keys.insert(sample_row.key.as_str()) {
        return Err(DatabaseDomainError::InvalidStarterTemplate(format!(
          "{} defines duplicate sample row key {}",
          self.id, sample_row.key
        )));
      }
      validate_field_refs(
        &self.id,
        "sample row",
        &sample_row.key,
        &sample_row.field_keys,
        &field_keys,
      )?;
    }

    let mut import_mapping_keys = BTreeSet::new();
    for mapping in &self.import_mappings {
      validate_local_template_key(&self.id, "import mapping", &mapping.key)?;
      validate_starter_template_i18n_key(&mapping.name_key, "import mapping name")?;
      if !import_mapping_keys.insert(mapping.key.as_str()) {
        return Err(DatabaseDomainError::InvalidStarterTemplate(format!(
          "{} defines duplicate import mapping key {}",
          self.id, mapping.key
        )));
      }
      for column in &mapping.column_mappings {
        validate_non_empty_fragment(&self.id, "import source header", &column.source_header)?;
        validate_field_ref(&self.id, "import mapping", &mapping.key, &column.field_key, &field_keys)?;
      }
    }

    if self.profile_kind == DatabaseProfileKind::Project {
      self
        .validate_project_contract()
        .map_err(|error| DatabaseDomainError::InvalidStarterTemplate(error.message))?;
    }

    Ok(())
  }

  /// Validate the exact Project role, row-template and view-policy contract.
  ///
  /// Generic starter validation only proves referential integrity. Project
  /// creation additionally needs semantic exactness so a missing role cannot
  /// be rediscovered later by field name, position or type.
  pub fn validate_project_contract(&self) -> Result<(), DatabaseStarterTemplateContractError> {
    if self.profile_kind != DatabaseProfileKind::Project {
      return Ok(());
    }
    let structure = self
      .default_structure
      .as_deref()
      .ok_or_else(|| DatabaseStarterTemplateContractError::field("Project starter is missing structure preset"))?
      .parse::<DatabaseProjectStructurePreset>()
      .map_err(|error| DatabaseStarterTemplateContractError::field(error.to_string()))?;
    let fields = self
      .fields
      .iter()
      .map(|field| (field.key.as_str(), field))
      .collect::<BTreeMap<_, _>>();
    let expected_roles = DATABASE_PROJECT_SEMANTIC_CATALOG
      .iter()
      .copied()
      .filter(|role| role.applies_to(structure))
      .collect::<Vec<_>>();

    let mut actual_role_keys = BTreeSet::new();
    for role in &self.roles {
      let identity = (role.role_key.as_str(), role.row_kind_scope.as_deref());
      if !actual_role_keys.insert(identity) {
        return Err(DatabaseStarterTemplateContractError::field(format!(
          "Project starter defines duplicate role {} for scope {:?}",
          role.role_key, role.row_kind_scope
        )));
      }
    }

    for expected in &expected_roles {
      let expected_scope = expected.row_kind_scope.as_str();
      let role = self
        .roles
        .iter()
        .find(|role| role.role_key == expected.role_key && role.row_kind_scope.as_deref() == Some(expected_scope))
        .ok_or_else(|| {
          DatabaseStarterTemplateContractError::field(format!(
            "Project starter is missing role {} for scope {}",
            expected.role_key, expected_scope
          ))
        })?;
      if role.field_key != expected.field_key
        || role.required != expected.required
        || role.managed_state != Some(expected.managed_state)
      {
        return Err(DatabaseStarterTemplateContractError::field(format!(
          "Project role {} has invalid scope/key/requiredness/managed-state contract",
          expected.role_key
        )));
      }
      let field = fields.get(role.field_key.as_str()).ok_or_else(|| {
        DatabaseStarterTemplateContractError::field(format!(
          "Project role {} references missing field {}",
          role.role_key, role.field_key
        ))
      })?;
      if field.field_type != expected.field_type {
        return Err(DatabaseStarterTemplateContractError::field(format!(
          "Project role {} expects field type {} but {} uses {}",
          role.role_key,
          expected.field_type.as_str(),
          role.field_key,
          field.field_type.as_str()
        )));
      }
    }

    let template_roles = self
      .roles
      .iter()
      .filter(|role| role.role_key == "project.template")
      .collect::<Vec<_>>();
    if template_roles.len() != 1
      || template_roles[0].row_kind_scope.is_some()
      || template_roles[0].field_key != "title"
      || template_roles[0].required
      || template_roles[0].managed_state.is_some()
    {
      return Err(DatabaseStarterTemplateContractError::field(
        "Project starter must define exactly one optional project.template metadata role on title",
      ));
    }
    let expected_role_count = expected_roles.len() + 1;
    if self.roles.len() != expected_role_count {
      return Err(DatabaseStarterTemplateContractError::field(format!(
        "Project starter defines {} roles but preset {} requires exactly {}",
        self.roles.len(),
        structure.as_str(),
        expected_role_count
      )));
    }

    for field in &self.fields {
      let expected_required = expected_roles
        .iter()
        .any(|role| role.field_key == field.key && role.required);
      if field.required != expected_required {
        return Err(DatabaseStarterTemplateContractError::field(format!(
          "Project field {} requiredness does not match its semantic roles",
          field.key
        )));
      }
    }

    let expected_row_kinds = [
      Some(DatabaseRowKind::Task),
      structure.has_phases().then_some(DatabaseRowKind::Phase),
      structure.has_milestones().then_some(DatabaseRowKind::Milestone),
    ]
    .into_iter()
    .flatten()
    .collect::<BTreeSet<_>>();
    let actual_row_kinds = self
      .row_templates
      .iter()
      .map(|template| template.row_kind)
      .collect::<BTreeSet<_>>();
    if self.row_templates.len() != expected_row_kinds.len() || actual_row_kinds != expected_row_kinds {
      return Err(DatabaseStarterTemplateContractError::field(format!(
        "Project preset {} has an invalid row-template set",
        structure.as_str()
      )));
    }
    for template in &self.row_templates {
      for field_key in &template.initial_field_keys {
        if !expected_roles
          .iter()
          .any(|role| role.row_kind_scope == template.row_kind && role.field_key == field_key)
        {
          return Err(DatabaseStarterTemplateContractError::field(format!(
            "Project {} row template initializes unresolved field {}",
            template.row_kind.as_str(),
            field_key
          )));
        }
      }
    }

    let expected_policies = database_project_view_policies(structure);
    if self.views.len() != expected_policies.len() {
      return Err(DatabaseStarterTemplateContractError::view(format!(
        "Project preset {} defines an invalid view count",
        structure.as_str()
      )));
    }
    for policy in expected_policies {
      let view = self
        .views
        .iter()
        .find(|view| view.view_kind == policy.view_kind)
        .ok_or_else(|| {
          DatabaseStarterTemplateContractError::view(format!(
            "Project starter is missing {} view",
            policy.view_kind.as_str()
          ))
        })?;
      let resolve_role = |role_key: &str| {
        expected_roles
          .iter()
          .find(|role| role.role_key == role_key)
          .map(|role| role.field_key.to_string())
          .ok_or_else(|| {
            DatabaseStarterTemplateContractError::view(format!(
              "Project view {} references unavailable role {}",
              policy.view_kind.as_str(),
              role_key
            ))
          })
      };
      let expected_visible = policy
        .visible_role_keys
        .iter()
        .map(|role_key| resolve_role(role_key))
        .collect::<Result<Vec<_>, _>>()?;
      let expected_axes = policy
        .axes
        .iter()
        .map(|axis| resolve_role(axis.role_key))
        .collect::<Result<Vec<_>, _>>()?;
      if view.visible_field_keys != expected_visible || view.axis_field_keys != expected_axes {
        return Err(DatabaseStarterTemplateContractError::view(format!(
          "Project {} view violates its semantic visibility or axis policy",
          policy.view_kind.as_str()
        )));
      }
    }
    Ok(())
  }
}

fn validate_starter_template_id(id: &str) -> Result<(), DatabaseDomainError> {
  if id.starts_with("myoxus.") && id.split('.').all(|segment| !segment.trim().is_empty()) {
    return Ok(());
  }
  Err(DatabaseDomainError::InvalidStarterTemplate(format!(
    "starter template id must be a myoxus-owned dotted id: {id}"
  )))
}

fn validate_starter_template_i18n_key(key: &str, label: &str) -> Result<(), DatabaseDomainError> {
  if key.starts_with("com.myoxus.database.") && !key.contains('_') {
    return Ok(());
  }
  Err(DatabaseDomainError::InvalidStarterTemplate(format!(
    "{label} must use a stable com.myoxus.database.* i18n key: {key}"
  )))
}

fn validate_non_empty_fragment(id: &str, label: &str, value: &str) -> Result<(), DatabaseDomainError> {
  if !value.trim().is_empty() {
    return Ok(());
  }
  Err(DatabaseDomainError::InvalidStarterTemplate(format!(
    "{id} has empty {label}"
  )))
}

fn validate_local_template_key(id: &str, label: &str, key: &str) -> Result<(), DatabaseDomainError> {
  validate_non_empty_fragment(id, label, key)?;
  if key
    .chars()
    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '.' || ch == '_' || ch == '-')
  {
    return Ok(());
  }
  Err(DatabaseDomainError::InvalidStarterTemplate(format!(
    "{id} has invalid {label} key {key}"
  )))
}

fn validate_field_refs(
  id: &str,
  owner_label: &str,
  owner_key: &str,
  refs: &[String],
  field_keys: &BTreeSet<&str>,
) -> Result<(), DatabaseDomainError> {
  for field_key in refs {
    validate_field_ref(id, owner_label, owner_key, field_key, field_keys)?;
  }
  Ok(())
}

fn validate_field_ref(
  id: &str,
  owner_label: &str,
  owner_key: &str,
  field_key: &str,
  field_keys: &BTreeSet<&str>,
) -> Result<(), DatabaseDomainError> {
  if field_keys.contains(field_key) {
    return Ok(());
  }
  Err(DatabaseDomainError::InvalidStarterTemplate(format!(
    "{id} {owner_label} {owner_key} references unknown field {field_key}"
  )))
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum DatabaseDomainError {
  #[error("invalid database field type: {0}")]
  InvalidFieldType(String),
  #[error("invalid database view kind: {0}")]
  InvalidViewKind(String),
  #[error("invalid database profile kind: {0}")]
  InvalidProfileKind(String),
  #[error("invalid database row kind: {0}")]
  InvalidRowKind(String),
  #[error("invalid database starter template: {0}")]
  InvalidStarterTemplate(String),
  #[error("invalid database rollup stale state: {0}")]
  InvalidRollupStaleState(String),
  #[error("invalid database formula stale state: {0}")]
  InvalidFormulaStaleState(String),
  #[error("invalid database domain value: {0}")]
  Validation(String),
}

#[cfg(test)]
mod tests {

  #[test]
  fn personal_reminder_triggers_preserve_literal_timezone_baselines() {
    let instant = |raw: &str| DateTime::parse_from_rfc3339(raw).unwrap().with_timezone(&Utc);
    let value = DatabaseDateTimeValue {
      start: instant("2026-07-06T00:00:00Z"),
      end: None,
      all_day: true,
      time_zone: "Europe/Berlin".into(),
    };
    assert_eq!(
      database_row_reminder_trigger_at(&value, 60).unwrap(),
      instant("2026-07-06T06:00:00Z")
    );
    let timed = DatabaseDateTimeValue {
      start: instant("2026-07-06T09:00:00Z"),
      all_day: false,
      ..value
    };
    assert_eq!(
      database_row_reminder_trigger_at(&timed, 15).unwrap(),
      instant("2026-07-06T08:45:00Z")
    );
    assert!(database_row_reminder_trigger_at(&timed, -1).is_err());
    assert!(
      database_row_reminder_all_day_baseline(
        NaiveDate::from_ymd_opt(2011, 12, 30).unwrap(),
        "Pacific/Apia".parse().unwrap()
      )
      .is_err()
    );
  }

  use super::*;

  fn minimal_snapshot(schema_version: u32) -> DatabaseSnapshot {
    DatabaseSnapshot {
      schema_version,
      exported_at: Utc::now(),
      source: DatabaseSnapshotSource {
        product: "myoxus".to_string(),
        format: "database-json-snapshot".to_string(),
        database_id: Some("database-source".to_string()),
        exported_by: None,
      },
      database: DatabaseSnapshotDatabase {
        managed_template: None,
        id: "database_0".to_string(),
        profile_kind: DatabaseProfileKind::Generic,
        profile_structure_preset: None,
        profile_config: serde_json::json!({}),
        title: "Snapshot contract".to_string(),
        description: None,
        fields: vec![
          DatabaseSnapshotField {
            id: "field_title".to_string(),
            name: "Title".to_string(),
            field_type: DatabaseFieldType::Title,
            config: DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Title),
            position: 0,
            required: true,
            read_only: false,
          },
          DatabaseSnapshotField {
            id: "field_done".to_string(),
            name: "Done".to_string(),
            field_type: DatabaseFieldType::Checkbox,
            config: DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Checkbox),
            position: 1,
            required: false,
            read_only: false,
          },
        ],
        views: vec![DatabaseSnapshotView {
          id: "view_table".to_string(),
          name: "Table".to_string(),
          view_kind: DatabaseViewKind::Table,
          icon: None,
          config: DatabaseSnapshotViewConfig::Table(DatabaseSnapshotTableViewConfig {
            title_field_id: "field_title".to_string(),
            visible_field_ids: vec!["field_title".to_string(), "field_done".to_string()],
            field_widths: BTreeMap::new(),
            search_field_ids: Vec::new(),
            sort: Vec::new(),
            filter: Vec::new(),
            filter_tree: None,
            group: None,
            subgroup: None,
          }),
          position: 0,
        }],
        field_roles: Vec::new(),
        view_roles: Vec::new(),
        rows: vec![DatabaseSnapshotRow {
          id: "row_0".to_string(),
          title: "Imported row".to_string(),
          position: 0,
          row_kind: DatabaseRowKind::Record,
          source: None,
          content_document: Some(DatabaseSnapshotContentDocument {
            document_key: "row-content-0".to_string(),
            title: "Imported row content".to_string(),
            yjs_update_base64: "AAA=".to_string(),
            asset_keys: vec!["asset/image.png".to_string()],
          }),
          cells: vec![DatabaseSnapshotCellValue {
            field_id: "field_done".to_string(),
            field_type: DatabaseFieldType::Checkbox,
            value: DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Checkbox(true)),
          }],
          projections: Vec::new(),
        }],
        row_templates: Vec::new(),
      },
      databases: Vec::new(),
      files_manifest: vec![DatabaseSnapshotFileManifestEntry {
        blob_key: "asset/image.png".to_string(),
        name: Some("image.png".to_string()),
        mime: Some("image/png".to_string()),
        size: Some(0),
        field_name: None,
        row_id: Some("row_0".to_string()),
      }],
      workspace_tags_manifest: Vec::new(),
      diagnostics: Vec::new(),
    }
  }

  #[test]
  fn database_snapshot_json_serializes_schema_fields_views_rows_and_values() {
    let snapshot = minimal_snapshot(DATABASE_SNAPSHOT_SCHEMA_VERSION);
    let json = serde_json::to_value(&snapshot).expect("snapshot serializes");

    assert_eq!(json["schemaVersion"], DATABASE_SNAPSHOT_SCHEMA_VERSION);
    assert_eq!(json["database"]["fields"][0]["fieldType"], "title");
    assert_eq!(json["database"]["views"][0]["config"]["kind"], "table");
    assert_eq!(json["database"]["rows"][0]["title"], "Imported row");
    assert_eq!(
      json["database"]["rows"][0]["contentDocument"]["documentKey"],
      "row-content-0"
    );
    assert_eq!(json["database"]["rows"][0]["cells"][0]["value"]["kind"], "domain");
    assert_eq!(
      json["database"]["rows"][0]["cells"][0]["value"]["value"]["kind"],
      "checkbox"
    );

    let decoded: DatabaseSnapshot = serde_json::from_value(json).expect("snapshot roundtrips");
    assert_eq!(decoded.schema_version, DATABASE_SNAPSHOT_SCHEMA_VERSION);
    assert_eq!(decoded.database.fields.len(), 2);
    assert_eq!(decoded.database.views.len(), 1);
    assert_eq!(decoded.database.rows.len(), 1);
    assert_eq!(
      decoded.database.rows[0]
        .content_document
        .as_ref()
        .expect("content document")
        .asset_keys,
      vec!["asset/image.png"]
    );
  }

  #[test]
  fn gantt_view_kind_config_and_schedule_window_roundtrip_without_timeline_fallback() {
    let config = DatabaseViewConfig::Gantt(DatabaseGanttViewConfig {
      title_field_id: Uuid::new_v4(),
      start_field_id: Uuid::new_v4(),
      end_field_id: Some(Uuid::new_v4()),
      visible_field_ids: Vec::new(),
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      group: None,
      zoom: DatabaseTimelineZoom::Quarter,
      dependency_field_id: Some(Uuid::new_v4()),
    });
    let json = serde_json::to_value(&config).expect("Gantt config serializes");
    assert_eq!(json["kind"], "gantt");
    assert_eq!(json["zoom"], "quarter");
    let decoded: DatabaseViewConfig = serde_json::from_value(json).expect("Gantt config roundtrips");
    assert!(matches!(decoded, DatabaseViewConfig::Gantt(_)));
    assert_eq!(DatabaseViewKind::from_str("gantt").unwrap(), DatabaseViewKind::Gantt);
    assert_eq!(DatabaseViewKind::Gantt.as_str(), "gantt");

    let window = DatabaseScheduleWindow {
      all_day_calendar: false,
      field_id: Uuid::new_v4(),
      end_field_id: Some(Uuid::new_v4()),
      start: Utc::now(),
      end: Utc::now(),
    };
    let window_json = serde_json::to_value(&window).expect("schedule window serializes");
    assert!(window_json.get("endFieldId").is_some());
    let decoded: DatabaseScheduleWindow = serde_json::from_value(window_json).expect("schedule window roundtrips");
    assert_eq!(decoded.end_field_id, window.end_field_id);
  }

  #[test]
  fn gantt_snapshot_preserves_group_zoom_and_dependency_field() {
    let snapshot_config = DatabaseSnapshotViewConfig::Gantt(DatabaseSnapshotGanttViewConfig {
      title_field_id: "title".to_string(),
      start_field_id: "start".to_string(),
      end_field_id: Some("end".to_string()),
      visible_field_ids: vec!["title".to_string(), "start".to_string()],
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      group: Some(DatabaseSnapshotGroupRule {
        field_id: "status".to_string(),
        descending: true,
        show_empty_groups: true,
      }),
      zoom: DatabaseTimelineZoom::Year,
      dependency_field_id: Some("blocked_by".to_string()),
    });
    let json = serde_json::to_value(&snapshot_config).expect("Gantt snapshot config serializes");
    assert_eq!(json["kind"], "gantt");
    assert_eq!(json["group"]["fieldId"], "status");
    assert_eq!(json["dependencyFieldId"], "blocked_by");
    let decoded: DatabaseSnapshotViewConfig = serde_json::from_value(json).expect("Gantt snapshot config roundtrips");
    let DatabaseSnapshotViewConfig::Gantt(decoded) = decoded else {
      panic!("snapshot must preserve the Gantt variant");
    };
    assert_eq!(decoded.zoom, DatabaseTimelineZoom::Year);
    assert_eq!(decoded.end_field_id.as_deref(), Some("end"));
    assert_eq!(decoded.dependency_field_id.as_deref(), Some("blocked_by"));
  }

  #[test]
  fn database_snapshot_json_keeps_unknown_schema_version_for_application_rejection() {
    let snapshot = minimal_snapshot(DATABASE_SNAPSHOT_SCHEMA_VERSION + 1);
    let encoded = serde_json::to_vec(&snapshot).expect("future snapshot serializes");
    let decoded: DatabaseSnapshot = serde_json::from_slice(&encoded).expect("future snapshot parses");

    assert!(decoded.schema_version > DATABASE_SNAPSHOT_SCHEMA_VERSION);
  }

  #[test]
  fn database_view_icon_accepts_only_system_icons_or_one_unicode_grapheme() {
    DatabaseViewIcon::System(DatabaseViewSystemIcon::Timeline)
      .validate()
      .expect("known system icon is valid");
    DatabaseViewIcon::Emoji("👩‍💻".to_string())
      .validate()
      .expect("a composed emoji is one grapheme");

    for invalid in ["", "  ", "📊📅", "<svg></svg>", "https://example.test/icon"] {
      assert!(
        DatabaseViewIcon::Emoji(invalid.to_string()).validate().is_err(),
        "arbitrary or multi-grapheme icon payload must be rejected: {invalid}"
      );
    }
  }

  #[test]
  fn saved_sort_support_is_an_explicit_field_kind_contract() {
    let sortable = [
      DatabaseFieldType::Title,
      DatabaseFieldType::Text,
      DatabaseFieldType::RichText,
      DatabaseFieldType::Number,
      DatabaseFieldType::Percent,
      DatabaseFieldType::Currency,
      DatabaseFieldType::Duration,
      DatabaseFieldType::Checkbox,
      DatabaseFieldType::Date,
      DatabaseFieldType::DateTime,
      DatabaseFieldType::UniqueId,
      DatabaseFieldType::Select,
      DatabaseFieldType::Status,
      DatabaseFieldType::User,
      DatabaseFieldType::Users,
      DatabaseFieldType::Url,
      DatabaseFieldType::Email,
      DatabaseFieldType::Phone,
      DatabaseFieldType::CreatedTime,
      DatabaseFieldType::UpdatedTime,
    ];
    let unsupported = [
      DatabaseFieldType::MultiSelect,
      DatabaseFieldType::Tags,
      DatabaseFieldType::Files,
      DatabaseFieldType::Relation,
      DatabaseFieldType::Rollup,
      DatabaseFieldType::Formula,
      DatabaseFieldType::CreatedBy,
      DatabaseFieldType::UpdatedBy,
      DatabaseFieldType::DocumentLink,
    ];

    assert!(sortable.into_iter().all(DatabaseFieldType::supports_saved_sort));
    assert!(
      unsupported
        .into_iter()
        .all(|field_type| !field_type.supports_saved_sort())
    );
  }

  #[test]
  fn server_search_support_excludes_unprojectable_field_kinds() {
    assert!(!DatabaseFieldType::Files.supports_server_search());
    assert!(DatabaseFieldType::Title.supports_server_search());
    assert!(DatabaseFieldType::Text.supports_server_search());
    assert!(DatabaseFieldType::Relation.supports_server_search());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// P-DB-26: bulk operation contracts
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum number of rows a single bulk operation may target.
///
/// This is intentionally a hard, deterministic limit so the service layer can
/// reject pathologically large requests up front instead of discovering them
/// partway through a multi-statement transaction. Bulk operations are
/// all-or-nothing: if the limit is exceeded, no rows are touched.
pub const DATABASE_BULK_MAX_ROWS_PER_OPERATION: usize = 500;

/// Maximum number of `(row, field)` cell updates a single bulk multi-field
/// operation may target. This caps memory pressure and the number of
/// statements issued inside the wrapping transaction.
pub const DATABASE_BULK_MAX_FIELD_UPDATES_PER_OPERATION: usize = 5_000;

/// A single row's worth of cell updates inside a bulk operation.
///
/// `row_id` identifies the row to patch. `cells` is a list of `(field_id,
/// value)` pairs. Empty `cells` is allowed and treated as a no-op for that
/// row (its outcome will still appear in the diagnostic stream so the client
/// can render a stable ordered list).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBulkRowPatch {
  pub row_id: DatabaseRowId,
  pub cells: Vec<DatabaseBulkCellUpdate>,
}

/// Explicit cell intent; Clear retains the cell revision as a tombstone.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseBulkCellIntent {
  Set(DatabaseCellValueData),
  Clear,
}

/// One field intent inside an atomic bulk row patch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBulkCellUpdate {
  pub field_id: DatabaseFieldId,
  pub intent: DatabaseBulkCellIntent,
}

/// A single row's position change inside a bulk reorder operation (used by
/// Kanban DnD and List manual reorder).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBulkPositionUpdate {
  pub row_id: DatabaseRowId,
  pub position: i32,
}

/// A single target row for a bulk delete/restore operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBulkRowTarget {
  pub row_id: DatabaseRowId,
}

/// Per-row diagnostic for a bulk operation.
///
/// Either `row_id` is present and `error` is `None` (success), or `error` is
/// populated with the structured failure code and message. `error_code` is
/// always a stable short string from
/// `MIX_DATABASE_*` so the UI can localize the message without parsing
/// free-form text.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBulkRowOutcome {
  pub row_id: DatabaseRowId,
  pub success: bool,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
}

impl DatabaseBulkRowOutcome {
  pub fn ok(row_id: DatabaseRowId) -> Self {
    Self {
      row_id,
      success: true,
      error_code: None,
      error_message: None,
    }
  }

  pub fn err(row_id: DatabaseRowId, code: impl Into<String>, message: impl Into<String>) -> Self {
    Self {
      row_id,
      success: false,
      error_code: Some(code.into()),
      error_message: Some(message.into()),
    }
  }
}

/// Aggregate result of a bulk operation.
///
/// `succeeded` and `failed` are diagnostic lists — together they always cover
/// every row the client requested. The caller can render a structured toast
/// (e.g. "3 of 12 updated, 9 failed: cell invalid") without re-deriving the
/// counts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBulkOperationResult {
  pub succeeded: Vec<DatabaseRowId>,
  pub failed: Vec<DatabaseBulkRowOutcome>,
  pub total: usize,
  pub success_count: usize,
  pub failure_count: usize,
  pub transaction_committed: bool,
}

impl DatabaseBulkOperationResult {
  /// Construct a result from a list of per-row outcomes. The caller must
  /// guarantee that `outcomes` covers every requested row exactly once.
  pub fn from_outcomes(outcomes: Vec<DatabaseBulkRowOutcome>, committed: bool) -> Self {
    let total = outcomes.len();
    let mut succeeded = Vec::new();
    let mut failed = Vec::new();
    for outcome in outcomes {
      if outcome.success {
        succeeded.push(outcome.row_id);
      } else {
        failed.push(outcome);
      }
    }
    let success_count = succeeded.len();
    let failure_count = failed.len();
    Self {
      succeeded,
      failed,
      total,
      success_count,
      failure_count,
      transaction_committed: committed,
    }
  }
}

/// Sentinel error codes for bulk operations. These mirror the
/// `MIX_DATABASE_*` codes already used in [`DatabaseServiceError`]; the bulk
/// path attaches them to individual rows so a partial failure can be reported
/// to the client without aborting the rest of the batch.
pub mod database_bulk_error_codes {
  /// Row id is unknown (deleted, archived, or never existed).
  pub const ROW_NOT_FOUND: &str = "MIX_DATABASE_NOT_FOUND";
  /// Row belongs to a different database than the one being edited.
  pub const ROW_INVALID: &str = "MIX_DATABASE_ROW_INVALID";
  /// Field id is unknown on this database.
  pub const FIELD_INVALID: &str = "MIX_DATABASE_FIELD_INVALID";
  /// Cell value is not valid for the field type.
  pub const CELL_INVALID: &str = "MIX_DATABASE_CELL_VALUE_INVALID";
  /// A projection/read-only field was written to.
  pub const CELL_VALUE_READONLY: &str = "MIX_DATABASE_CELL_VALUE_READONLY";
  /// Field/relation target points at an invalid or unauthorized target.
  pub const RELATION_TARGET_INVALID: &str = "MIX_DATABASE_RELATION_TARGET_INVALID";
  /// Document link points at a non-existent or unauthorized document.
  pub const DOCUMENT_LINK_INVALID: &str = "MIX_DATABASE_DOCUMENT_LINK_INVALID";
  /// User assignment points at a non-member.
  pub const ASSIGNMENT_INVALID: &str = "MIX_DATABASE_ASSIGNMENT_INVALID";
  /// Forbidden (e.g. not a workspace member, or lacking the required action).
  pub const FORBIDDEN: &str = "MIX_DATABASE_FORBIDDEN";
  /// Storage / internal failure.
  pub const STORAGE: &str = "MIX_DATABASE_STORAGE";
}

/// Project scheduling belongs to semantic fields, independently of saved
/// Views. Legacy-invalid pairs remain editable through unrelated properties;
/// only creation or an explicit start/due change validates the pair.
pub fn validate_project_task_date_range(
  fields: &[DatabaseField],
  start_field_id: Option<DatabaseFieldId>,
  due_field_id: Option<DatabaseFieldId>,
  cells: &[DatabaseCellValue],
  changes: &HashMap<DatabaseFieldId, Option<DatabaseCellValueData>>,
  creating: bool,
) -> Result<(), String> {
  let (Some(start_id), Some(due_id)) = (start_field_id, due_field_id) else {
    return Ok(());
  };
  if !creating && !changes.contains_key(&start_id) && !changes.contains_key(&due_id) {
    return Ok(());
  }
  let value = |id| match changes.get(&id) {
    Some(value) => value.as_ref(),
    None => cells.iter().find(|cell| cell.field_id == id).map(|cell| &cell.value),
  };
  // Two all-day cells represent calendar dates in their respective zones;
  // timed or mixed pairs keep their actual UTC instant ordering.
  let calendar = [start_id, due_id]
    .into_iter()
    .all(|id| matches!(value(id), Some(DatabaseCellValueData::DateTime(value)) if value.all_day));
  let timestamp = DateTime::<Utc>::UNIX_EPOCH;
  let start = schedule_boundary_instant(fields, cells, timestamp, timestamp, start_id, changes, false, calendar)?;
  let due = schedule_boundary_instant(fields, cells, timestamp, timestamp, due_id, changes, false, calendar)?;
  if start.zip(due).is_some_and(|(start, due)| due < start) {
    return Err("Project Task due date must not precede its start date".to_string());
  }
  Ok(())
}

/// Validate Project semantics and the remaining saved-View ranges. The exact
/// Task role pair is already checked with its calendar/instant semantics;
/// unrelated saved-View ranges retain their existing policy.
#[expect(
  clippy::too_many_arguments,
  reason = "the same final-image contract is shared by application and locked transactional writers"
)]
pub fn validate_project_task_temporal_ranges(
  fields: &[DatabaseField],
  views: &[DatabaseView],
  start_field_id: Option<DatabaseFieldId>,
  due_field_id: Option<DatabaseFieldId>,
  cells: &[DatabaseCellValue],
  created_at: DateTime<Utc>,
  updated_at: DateTime<Utc>,
  changes: &HashMap<DatabaseFieldId, Option<DatabaseCellValueData>>,
  creating: bool,
) -> Result<(), String> {
  validate_project_task_date_range(fields, start_field_id, due_field_id, cells, changes, creating)?;
  let views = views
    .iter()
    .filter(|view| {
      let pair = match &view.config {
        DatabaseViewConfig::Timeline(config) => Some((Some(config.start_field_id), config.end_field_id)),
        DatabaseViewConfig::Gantt(config) => Some((Some(config.start_field_id), config.end_field_id)),
        _ => None,
      };
      !(start_field_id.is_some() && due_field_id.is_some() && pair == Some((start_field_id, due_field_id)))
    })
    .cloned()
    .collect::<Vec<_>>();
  validate_database_temporal_ranges(fields, &views, cells, created_at, updated_at, changes)
}

/// Validate a final Row projection against every configured schedule range.
/// The repository repeats this invariant under its row locks, so concurrent
/// changes to an untouched endpoint cannot invalidate a committed bulk patch.
pub fn validate_database_temporal_ranges(
  fields: &[DatabaseField],
  views: &[DatabaseView],
  cells: &[DatabaseCellValue],
  created_at: DateTime<Utc>,
  updated_at: DateTime<Utc>,
  changes: &HashMap<DatabaseFieldId, Option<DatabaseCellValueData>>,
) -> Result<(), String> {
  for view in views {
    let (start_field_id, end_field_id, label) = match &view.config {
      DatabaseViewConfig::Timeline(config) => (config.start_field_id, config.end_field_id, "timeline"),
      DatabaseViewConfig::Gantt(config) => (config.start_field_id, config.end_field_id, "gantt"),
      _ => continue,
    };
    let all_day_calendar = matches!(&view.config, DatabaseViewConfig::Gantt(_));
    let start = schedule_boundary_instant(
      fields,
      cells,
      created_at,
      updated_at,
      start_field_id,
      changes,
      false,
      all_day_calendar,
    )?;
    let end = if let Some(end_field_id) = end_field_id {
      schedule_boundary_instant(
        fields,
        cells,
        created_at,
        updated_at,
        end_field_id,
        changes,
        false,
        all_day_calendar,
      )?
    } else {
      schedule_boundary_instant(
        fields,
        cells,
        created_at,
        updated_at,
        start_field_id,
        changes,
        true,
        all_day_calendar,
      )?
    };
    if start.zip(end).is_some_and(|(start, end)| end < start) {
      return Err(format!("{label} end must not be before its start"));
    }
  }
  Ok(())
}

fn schedule_boundary_instant(
  fields: &[DatabaseField],
  cells: &[DatabaseCellValue],
  created_at: DateTime<Utc>,
  updated_at: DateTime<Utc>,
  field_id: DatabaseFieldId,
  changes: &HashMap<DatabaseFieldId, Option<DatabaseCellValueData>>,
  use_range_end: bool,
  all_day_calendar: bool,
) -> Result<Option<DateTime<Utc>>, String> {
  let Some(field) = fields.iter().find(|field| field.id == field_id) else {
    return Ok(None);
  };
  let changed_value = changes.get(&field_id);
  let value = match changed_value {
    Some(value) => value.as_ref(),
    None => cells
      .iter()
      .find(|cell| cell.field_id == field_id)
      .map(|cell| &cell.value),
  };
  Ok(match (field.field_type, value) {
    (DatabaseFieldType::Date, Some(DatabaseCellValueData::Date(value))) => (if use_range_end {
      value.end.unwrap_or(value.start)
    } else {
      value.start
    })
    .and_hms_opt(0, 0, 0)
    .map(|value| value.and_utc()),
    (DatabaseFieldType::DateTime, Some(DatabaseCellValueData::DateTime(value))) => {
      let instant = if use_range_end {
        value.end.unwrap_or(value.start)
      } else {
        value.start
      };
      if all_day_calendar && value.all_day {
        // Gantt compares calendar coordinates, matching its window query and
        // client projection. Timeline retains its existing instant semantics.
        let zone = value
          .time_zone
          .parse::<chrono_tz::Tz>()
          .map_err(|_| "gantt all-day timezone must be a valid IANA identifier".to_string())?;
        instant
          .with_timezone(&zone)
          .date_naive()
          .and_hms_opt(0, 0, 0)
          .map(|day| day.and_utc())
      } else {
        Some(instant)
      }
    }
    (DatabaseFieldType::CreatedTime, _) if changed_value.is_none() => Some(created_at),
    (DatabaseFieldType::UpdatedTime, _) if changed_value.is_none() => Some(updated_at),
    (DatabaseFieldType::CreatedTime, Some(DatabaseCellValueData::CreatedTime(value)))
    | (DatabaseFieldType::UpdatedTime, Some(DatabaseCellValueData::UpdatedTime(value))) => Some(*value),
    _ => None,
  })
}

pub mod definition;
pub use definition::*;
pub mod editing;
pub use editing::*;
pub mod views;
pub use views::*;
pub mod import_export;
pub use import_export::*;
pub mod projections;
pub use projections::*;

pub mod templates;
pub use templates::*;

pub mod reminders;
pub use reminders::*;

pub mod projects;
pub use projects::*;
