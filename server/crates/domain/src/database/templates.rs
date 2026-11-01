//! File-authored starter sources use stable local keys; instance identities are allocated only during materialization.
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseProjectOptionPreset {
  ThreeStep,
  FiveStep,
}
impl DatabaseProjectOptionPreset {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::ThreeStep => "threeStep",
      Self::FiveStep => "fiveStep",
    }
  }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateField {
  pub key: String,
  pub name: String,
  pub field_type: DatabaseFieldType,
  pub required: bool,
  pub config: DatabaseTemplateFieldConfig,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub enum DatabaseTemplateFieldConfig {
  Direct(DatabaseFieldConfig),
  SelfRelation {
    allow_multiple: bool,
    max_targets: Option<i32>,
  },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateView {
  pub name: String,
  pub kind: DatabaseViewKind,
  pub config: DatabaseTemplateViewConfig,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub enum DatabaseTemplateViewConfig {
  Table {
    visible: Vec<String>,
    group: Option<String>,
  },
  Kanban {
    group: String,
    visible: Vec<String>,
  },
  List {
    visible: Vec<String>,
    group: Option<String>,
  },
  Gallery {
    visible: Vec<String>,
    cover: Option<String>,
    show_empty_cover: bool,
    group: Option<String>,
  },
  Calendar {
    date: String,
    visible: Vec<String>,
  },
  Timeline {
    start: String,
    end: Option<String>,
    visible: Vec<String>,
  },
  Progress {
    progress: String,
    group: Option<String>,
    visible: Vec<String>,
  },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateRole {
  pub role_key: String,
  pub row_kind_scope: Option<String>,
  pub field_key: String,
  pub required: bool,
  pub managed_state: Option<DatabaseProjectRoleManagedState>,
  pub config: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateSampleRow {
  pub key: String,
  pub row_kind: DatabaseRowKind,
  pub title: String,
  pub cells: Vec<(String, DatabaseCellValueData)>,
  pub relation_cells: Vec<(String, Vec<String>)>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateRowTemplate {
  pub key: String,
  pub name: String,
  pub description: Option<String>,
  pub row_kind: DatabaseRowKind,
  pub is_default: bool,
  pub initial_cells: Vec<(String, DatabaseCellValueData)>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateSpec {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub manifest: Option<DatabaseStarterTemplateManifest>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub metadata: Option<DatabaseTemplateMetadata>,
  pub id: String,
  pub name: String,
  pub description: String,
  pub category: DatabaseStarterTemplateCategory,
  pub profile_kind: DatabaseProfileKind,
  pub default_structure: Option<DatabaseProjectStructurePreset>,
  pub priority_preset: Option<DatabaseProjectOptionPreset>,
  pub complexity_preset: Option<DatabaseProjectOptionPreset>,
  pub fields: Vec<DatabaseTemplateField>,
  pub views: Vec<DatabaseTemplateView>,
  pub roles: Vec<DatabaseTemplateRole>,
  pub row_templates: Vec<DatabaseTemplateRowTemplate>,
  pub sample_rows: Vec<DatabaseTemplateSampleRow>,
}

/// Catalog selection is explicit; retained versions are never chosen by sorting paths.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateCatalogSource {
  pub format_version: u32,
  pub templates: Vec<DatabaseTemplateCatalogEntry>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub system_sources: Vec<DatabaseTemplateSystemSource>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateCatalogEntry {
  pub id: String,
  pub current: String,
  pub definitions: Vec<DatabaseTemplateFileReference>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub updates: Vec<super::definition::DatabaseTemplateUpdateReference>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub offering: Option<bool>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub default_variant: Option<DatabaseTemplateSelection>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateSelection {
  pub priority: DatabaseProjectOptionPreset,
  pub complexity: DatabaseProjectOptionPreset,
  pub structure: DatabaseProjectStructurePreset,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateVariantSelection {
  pub input: DatabaseTemplateSelection,
  pub variant: DatabaseTemplateSelection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseTemplateSourceRole {
  ProjectDefault,
  WorkspaceTasks,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateSystemSource {
  pub role: DatabaseTemplateSourceRole,
  pub template_id: String,
  pub selection: DatabaseTemplateSelection,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateFileReference {
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub selections: Vec<DatabaseTemplateVariantSelection>,
  pub version: String,
  pub path: String,
  pub sha256: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateCoreReference {
  pub id: String,
  pub version: String,
  pub path: String,
  pub sha256: String,
}

/// A task core has no references of its own. Variants may only extend these fields and roles.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateTaskCore {
  pub format_version: u32,
  pub id: String,
  pub version: String,
  pub fields: Vec<DatabaseTemplateField>,
  pub roles: Vec<DatabaseTemplateRole>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateDefinitionSource {
  /// Retained authored metadata; executable transition authority is the pinned update inventory.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub supported_predecessors: Vec<String>,
  pub format_version: u32,
  pub id: String,
  pub version: String,
  pub task_core: Option<DatabaseTemplateCoreReference>,
  pub variants: Vec<DatabaseTemplateVariantSource>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateVariantSource {
  pub option_extensions: Vec<DatabaseTemplateOptionExtension>,
  pub field_order: Vec<String>,
  pub role_order: Vec<String>,
  pub priority: DatabaseProjectOptionPreset,
  pub complexity: DatabaseProjectOptionPreset,
  pub structure: DatabaseProjectStructurePreset,
  pub spec: DatabaseTemplateSpec,
}

/// Finite additions to a common Select/Status option set; the common option identities and copy remain unchanged.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateOptionExtension {
  pub field_key: String,
  pub options: Vec<DatabaseSelectOption>,
  pub option_order: Vec<String>,
}
/// Copy/import facts that cannot be derived from executable definitions.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateMetadata {
  pub name_key: String,
  pub description_key: String,
  pub fields: Vec<DatabaseTemplateFieldMetadata>,
  pub views: Vec<DatabaseTemplateViewMetadata>,
  pub row_templates: Vec<DatabaseTemplateRowTemplateMetadata>,
  pub sample_rows: Vec<DatabaseTemplateSampleMetadata>,
  pub import_mappings: Vec<DatabaseStarterTemplateImportMappingManifest>,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateFieldMetadata {
  pub key: String,
  pub name_key: String,
  pub import_export_behavior: String,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateViewMetadata {
  pub key: String,
  pub name_key: String,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateRowTemplateMetadata {
  pub key: String,
  pub name_key: String,
  pub description_key: Option<String>,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseTemplateSampleMetadata {
  pub key: String,
  pub title_key: Option<String>,
}

impl DatabaseTemplateSpec {
  /// Derive structural facts from executable definitions. Immutable sources may
  /// retain a redundant manifest only as an exact assertion of this result.
  pub fn to_manifest(&self) -> Result<DatabaseStarterTemplateManifest, String> {
    let metadata = if let Some(metadata) = &self.metadata {
      metadata.clone()
    } else if let Some(assertion) = &self.manifest {
      DatabaseTemplateMetadata {
        name_key: assertion.name_key.clone(),
        description_key: assertion.description_key.clone(),
        fields: assertion
          .fields
          .iter()
          .map(|field| DatabaseTemplateFieldMetadata {
            key: field.key.clone(),
            name_key: field.name_key.clone(),
            import_export_behavior: field.import_export_behavior.clone(),
          })
          .collect(),
        views: assertion
          .views
          .iter()
          .map(|view| DatabaseTemplateViewMetadata {
            key: view.key.clone(),
            name_key: view.name_key.clone(),
          })
          .collect(),
        row_templates: assertion
          .row_templates
          .iter()
          .map(|row| DatabaseTemplateRowTemplateMetadata {
            key: row.key.clone(),
            name_key: row.name_key.clone(),
            description_key: row.description_key.clone(),
          })
          .collect(),
        sample_rows: assertion
          .sample_rows
          .iter()
          .map(|row| DatabaseTemplateSampleMetadata {
            key: row.key.clone(),
            title_key: row.title_key.clone(),
          })
          .collect(),
        import_mappings: assertion.import_mappings.clone(),
      }
    } else {
      return Err(format!("{} requires canonical copy/import metadata", self.id));
    };
    if metadata.fields.len() != self.fields.len()
      || metadata.views.len() != self.views.len()
      || metadata.row_templates.len() != self.row_templates.len()
      || metadata.sample_rows.len() != self.sample_rows.len()
    {
      return Err(format!(
        "{} metadata does not cover its executable definitions",
        self.id
      ));
    }
    let fields = self
      .fields
      .iter()
      .map(|field| {
        let copy = metadata
          .fields
          .iter()
          .find(|copy| copy.key == field.key)
          .ok_or_else(|| format!("{} missing field metadata {}", self.id, field.key))?;
        Ok(DatabaseStarterTemplateFieldManifest {
          key: field.key.clone(),
          name_key: copy.name_key.clone(),
          field_type: field.field_type,
          required: field.required,
          config_kind: if matches!(field.config, DatabaseTemplateFieldConfig::SelfRelation { .. }) {
            "self_relation".into()
          } else {
            field.field_type.as_str().into()
          },
          import_export_behavior: copy.import_export_behavior.clone(),
        })
      })
      .collect::<Result<Vec<_>, String>>()?;
    let manifest = DatabaseStarterTemplateManifest {
      schema_version: DATABASE_STARTER_TEMPLATE_SCHEMA_VERSION,
      id: self.id.clone(),
      category: self.category,
      profile_kind: self.profile_kind,
      name_key: metadata.name_key,
      description_key: metadata.description_key,
      default_structure: self.default_structure.map(|value| value.as_str().into()),
      fields,
      roles: self
        .roles
        .iter()
        .map(|role| DatabaseStarterTemplateRoleManifest {
          role_key: role.role_key.clone(),
          row_kind_scope: role.row_kind_scope.clone(),
          field_key: role.field_key.clone(),
          required: role.required,
          managed_state: role.managed_state,
        })
        .collect(),
      views: self
        .views
        .iter()
        .zip(&metadata.views)
        .enumerate()
        .map(|(index, (view, copy))| DatabaseStarterTemplateViewManifest {
          key: copy.key.clone(),
          name_key: copy.name_key.clone(),
          view_kind: view.kind,
          primary: index == 0,
          field_keys: view.config.field_keys(),
          visible_field_keys: view.config.visible_field_keys(),
          axis_field_keys: view.config.axis_field_keys(),
        })
        .collect(),
      row_templates: self
        .row_templates
        .iter()
        .map(|row| {
          let copy = metadata
            .row_templates
            .iter()
            .find(|copy| copy.key == row.key)
            .ok_or_else(|| format!("{} missing row-template metadata {}", self.id, row.key))?;
          Ok(DatabaseStarterTemplateRowTemplateManifest {
            key: row.key.clone(),
            name_key: copy.name_key.clone(),
            description_key: copy.description_key.clone(),
            row_kind: row.row_kind,
            is_default: row.is_default,
            initial_field_keys: row.initial_cells.iter().map(|(key, _)| key.clone()).collect(),
          })
        })
        .collect::<Result<Vec<_>, String>>()?,
      // Copy identities (such as sample-1) are independent of executable
      // sample keys used by local Row references. Their authored order binds
      // copy to the same ordered samples, just as it does for View metadata.
      sample_rows: self
        .sample_rows
        .iter()
        .zip(&metadata.sample_rows)
        .map(|(row, copy)| DatabaseStarterTemplateSampleRowManifest {
          key: copy.key.clone(),
          title_key: copy.title_key.clone(),
          field_keys: row.cells.iter().map(|(key, _)| key.clone()).collect(),
        })
        .collect(),
      import_mappings: metadata.import_mappings,
    };
    if let Some(assertion) = &self.manifest
      && serde_json::to_value(assertion).map_err(|error| error.to_string())?
        != serde_json::to_value(&manifest).map_err(|error| error.to_string())?
    {
      return Err(format!("{} source and manifest structure disagree", self.id));
    }
    Ok(manifest)
  }
}

impl DatabaseTemplateViewConfig {
  pub fn field_keys(&self) -> Vec<String> {
    let mut keys = self.axis_field_keys();
    keys.extend(self.visible_field_keys());
    let mut seen = std::collections::BTreeSet::new();
    keys.retain(|key| seen.insert(key.clone()));
    keys
  }

  pub fn visible_field_keys(&self) -> Vec<String> {
    match self {
      DatabaseTemplateViewConfig::Table { visible, .. }
      | DatabaseTemplateViewConfig::Kanban { visible, .. }
      | DatabaseTemplateViewConfig::List { visible, .. }
      | DatabaseTemplateViewConfig::Gallery { visible, .. }
      | DatabaseTemplateViewConfig::Calendar { visible, .. }
      | DatabaseTemplateViewConfig::Timeline { visible, .. }
      | DatabaseTemplateViewConfig::Progress { visible, .. } => visible.iter().map(|key| key.to_string()).collect(),
    }
  }

  pub fn axis_field_keys(&self) -> Vec<String> {
    let mut keys = Vec::new();
    match self {
      DatabaseTemplateViewConfig::Table { group, .. } | DatabaseTemplateViewConfig::List { group, .. } => {
        if let Some(group) = group {
          keys.push(group.to_string());
        }
      }
      DatabaseTemplateViewConfig::Gallery { cover, group, .. } => {
        keys.extend(cover.iter().map(|key| key.to_string()));
        if let Some(group) = group {
          keys.push(group.to_string());
        }
      }
      DatabaseTemplateViewConfig::Kanban { group, .. } => {
        keys.push(group.to_string());
      }
      DatabaseTemplateViewConfig::Calendar { date, .. } => {
        keys.push(date.to_string());
      }
      DatabaseTemplateViewConfig::Timeline { start, end, .. } => {
        keys.push(start.to_string());
        keys.extend(end.iter().map(|key| key.to_string()));
      }
      DatabaseTemplateViewConfig::Progress { progress, group, .. } => {
        keys.push(progress.to_string());
        if let Some(group) = group {
          keys.push(group.to_string());
        }
      }
    }
    keys
  }
}
