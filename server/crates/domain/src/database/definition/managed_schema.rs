// SPDX-License-Identifier: AGPL-3.0-or-later

//! Server-owned managed definitions and their actor-independent capability projection.
use crate::database::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseSystemRole {
  WorkspaceTasks,
}
impl DatabaseSystemRole {
  pub fn as_str(self) -> &'static str {
    "workspace_tasks"
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseManagedSchemaReadiness {
  Ready,
  Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseManagedSchemaVariant {
  pub priority: DatabaseProjectOptionPreset,
  pub complexity: DatabaseProjectOptionPreset,
  pub structure: DatabaseProjectStructurePreset,
  pub currency: String,
}

/// Persisted native identities. Neither portable imports nor clients may author this installation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseManagedSchemaInstallation {
  pub template_id: String,
  pub template_version: String,
  pub template_digest: String,
  pub variant: DatabaseManagedSchemaVariant,
  pub schema_revision: i64,
  pub field_bindings: BTreeMap<String, DatabaseFieldId>,
  pub view_bindings: BTreeMap<String, DatabaseViewId>,
  pub readiness: DatabaseManagedSchemaReadiness,
  pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTaskBinding {
  pub role_key: String,
  pub field_id: DatabaseFieldId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseManagedSchema {
  pub readiness: DatabaseManagedSchemaReadiness,
  pub reason_code: Option<String>,
  pub template_id: String,
  pub template_version: String,
  pub template_digest: String,
  pub variant: DatabaseManagedSchemaVariant,
  pub schema_revision: i64,
  pub can_edit_structure: bool,
  pub can_edit_metadata: bool,
  pub can_manage_lifecycle: bool,
  pub task_bindings: Vec<DatabaseTaskBinding>,
}

impl DatabaseRecord {
  /// Readiness is server-owned; Generic has no managed identity or capabilities.
  pub fn project_managed_schema(&self) -> Option<DatabaseManagedSchema> {
    if self.database.profile_kind == DatabaseProfileKind::Generic {
      return None;
    }
    let installed = self.database.managed_installation.as_ref();
    let ready = installed.is_some_and(|state| state.readiness == DatabaseManagedSchemaReadiness::Ready);
    let system = self.database.system_role.is_some();
    Some(DatabaseManagedSchema {
      readiness: if ready {
        DatabaseManagedSchemaReadiness::Ready
      } else {
        DatabaseManagedSchemaReadiness::Unavailable
      },
      reason_code: installed
        .and_then(|state| state.reason_code.clone())
        .or_else(|| (!ready).then(|| "MANAGED_SCHEMA_NOT_INSTALLED".into())),
      template_id: installed.map(|state| state.template_id.clone()).unwrap_or_default(),
      template_version: installed
        .map(|state| state.template_version.clone())
        .unwrap_or_default(),
      template_digest: installed.map(|state| state.template_digest.clone()).unwrap_or_default(),
      variant: installed
        .map(|state| state.variant.clone())
        .unwrap_or(DatabaseManagedSchemaVariant {
          priority: DatabaseProjectOptionPreset::ThreeStep,
          complexity: DatabaseProjectOptionPreset::ThreeStep,
          structure: DatabaseProjectStructurePreset::TasksOnly,
          currency: default_database_currency_code(),
        }),
      schema_revision: installed.map(|state| state.schema_revision).unwrap_or(0),
      can_edit_structure: false,
      can_edit_metadata: ready && !system,
      can_manage_lifecycle: ready && !system,
      task_bindings: if ready {
        self
          .field_roles
          .iter()
          .filter(|role| role.row_kind_scope.as_deref() == Some("task"))
          .map(|role| DatabaseTaskBinding {
            role_key: role.role_key.clone(),
            field_id: role.field_id,
          })
          .collect()
      } else {
        Vec::new()
      },
    })
  }
}

/// Portable source facts, not installation authority or a request to promote a system role.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseManagedTemplateSource {
  pub template_id: String,
  pub template_version: String,
  pub template_digest: String,
  pub variant: DatabaseManagedSchemaVariant,
  pub field_keys: BTreeMap<String, String>,
  pub view_keys: BTreeMap<String, String>,
}
