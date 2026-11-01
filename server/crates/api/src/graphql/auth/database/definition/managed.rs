// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseSystemRole", rename_items = "PascalCase")]
pub enum DatabaseSystemRoleType {
  WorkspaceTasks,
}

impl From<domain::DatabaseSystemRole> for DatabaseSystemRoleType {
  fn from(value: domain::DatabaseSystemRole) -> Self {
    match value {
      domain::DatabaseSystemRole::WorkspaceTasks => Self::WorkspaceTasks,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseManagedSchemaReadiness", rename_items = "PascalCase")]
pub enum DatabaseManagedSchemaReadinessType {
  Ready,
  Unavailable,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseManagedSchemaVariant")]
pub struct DatabaseManagedSchemaVariantObjectType {
  pub priority: ProjectOptionPresetType,
  pub complexity: ProjectOptionPresetType,
  pub structure: ProjectStructurePresetType,
  pub currency: String,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseTaskBinding")]
pub struct DatabaseTaskBindingObjectType {
  pub role_key: String,
  pub field_id: ID,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseManagedSchema")]
pub struct DatabaseManagedSchemaObjectType {
  pub readiness: DatabaseManagedSchemaReadinessType,
  pub reason_code: Option<String>,
  pub template_id: String,
  pub template_version: String,
  pub template_digest: String,
  pub variant: DatabaseManagedSchemaVariantObjectType,
  pub schema_revision: i64,
  pub can_edit_structure: bool,
  pub can_edit_metadata: bool,
  pub can_manage_lifecycle: bool,
  /// Validated role identities are guaranteed only while readiness is Ready.
  pub task_bindings: Vec<DatabaseTaskBindingObjectType>,
}

pub(in crate::graphql::auth::database) fn map_managed_schema(
  value: domain::DatabaseManagedSchema,
) -> DatabaseManagedSchemaObjectType {
  let option = |value| match value {
    domain::DatabaseProjectOptionPreset::ThreeStep => ProjectOptionPresetType::ThreeStep,
    domain::DatabaseProjectOptionPreset::FiveStep => ProjectOptionPresetType::FiveStep,
  };
  DatabaseManagedSchemaObjectType {
    readiness: match value.readiness {
      domain::DatabaseManagedSchemaReadiness::Ready => DatabaseManagedSchemaReadinessType::Ready,
      domain::DatabaseManagedSchemaReadiness::Unavailable => DatabaseManagedSchemaReadinessType::Unavailable,
    },
    reason_code: value.reason_code,
    template_id: value.template_id,
    template_version: value.template_version,
    template_digest: value.template_digest,
    variant: DatabaseManagedSchemaVariantObjectType {
      priority: option(value.variant.priority),
      complexity: option(value.variant.complexity),
      structure: match value.variant.structure {
        domain::DatabaseProjectStructurePreset::TasksOnly => ProjectStructurePresetType::TasksOnly,
        domain::DatabaseProjectStructurePreset::Phases => ProjectStructurePresetType::Phases,
        domain::DatabaseProjectStructurePreset::Milestones => ProjectStructurePresetType::Milestones,
        domain::DatabaseProjectStructurePreset::PhasesAndMilestones => ProjectStructurePresetType::PhasesAndMilestones,
      },
      currency: value.variant.currency,
    },
    schema_revision: value.schema_revision,
    can_edit_structure: value.can_edit_structure,
    can_edit_metadata: value.can_edit_metadata,
    can_manage_lifecycle: value.can_manage_lifecycle,
    task_bindings: value
      .task_bindings
      .into_iter()
      .map(|binding| DatabaseTaskBindingObjectType {
        role_key: binding.role_key,
        field_id: binding.field_id.to_string().into(),
      })
      .collect(),
  }
}
