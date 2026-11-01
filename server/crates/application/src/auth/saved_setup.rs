// SPDX-License-Identifier: AGPL-3.0-or-later
//! Personal reusable selections contain no target identity or execution state.
use super::{AssistanceMode, AuthError, AuthResult};
use myoxus_domain::assistant_package::{AssistantPackageContext, AssistantWorkflowIdentity};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase", deny_unknown_fields)]
pub enum SavedSetupValue {
  Boolean(bool),
  Choice(String),
  Currency(String),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedDocumentSourceReference {
  pub component_id: String,
  pub template_id: String,
  pub version: String,
  pub digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedDatabaseSourceReference {
  pub component_id: String,
  pub definition_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedAssistantSelection {
  pub package_id: String,
  pub defaults: BTreeMap<String, SavedSetupValue>,
  pub document_sources: Vec<SavedDocumentSourceReference>,
  pub database_sources: Vec<SavedDatabaseSourceReference>,
  pub workflow: Option<AssistantWorkflowIdentity>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedSetupConfiguration {
  pub id: Uuid,
  pub name: String,
  pub context: AssistantPackageContext,
  pub package: SavedAssistantSelection,
  pub project: Option<SavedAssistantSelection>,
  pub setup: Option<SavedAssistantSelection>,
  pub assistance_mode: Option<AssistanceMode>,
}
#[derive(Debug, Clone, Default)]
pub struct SavedSetupPatch {
  pub id: Uuid,
  pub value: Option<SavedSetupConfiguration>,
}
fn bounded(value: &str, limit: usize) -> bool {
  !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}
impl SavedSetupConfiguration {
  pub fn validate(&self) -> AuthResult<()> {
    let invalid = || AuthError::InvalidInput("invalid saved setup configuration".into());
    if self.id.is_nil()
      || !bounded(&self.name, 128)
      || !matches!(
        self.context,
        AssistantPackageContext::WorkspaceCreation
          | AssistantPackageContext::ProjectCreation
          | AssistantPackageContext::TaskContainerAssistance
      )
      || (self.project.is_some() && self.setup.is_some())
      || (self.context != AssistantPackageContext::WorkspaceCreation
        && (self.project.is_some() || self.setup.is_some()))
    {
      return Err(invalid());
    }
    for selection in std::iter::once(&self.package)
      .chain(self.project.iter())
      .chain(self.setup.iter())
    {
      if !bounded(&selection.package_id, 160)
        || selection.defaults.len() > 64
        || selection.document_sources.len() + selection.database_sources.len() > 64
      {
        return Err(invalid());
      }
      for (key, value) in &selection.defaults {
        if !bounded(key, 160)
          || !match value {
            SavedSetupValue::Boolean(_) => true,
            SavedSetupValue::Choice(value) => bounded(value, 160),
            SavedSetupValue::Currency(value) => {
              myoxus_domain::database::normalize_database_currency_code(value).as_ref() == Some(value)
            }
          }
        {
          return Err(invalid());
        }
      }
      let mut components = BTreeSet::new();
      for source in &selection.document_sources {
        if !bounded(&source.component_id, 160)
          || !bounded(&source.template_id, 160)
          || !bounded(&source.version, 64)
          || source.digest.len() != 64
          || !source
            .digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
          || !components.insert(&source.component_id)
        {
          return Err(invalid());
        }
      }
      for source in &selection.database_sources {
        if !bounded(&source.component_id, 160)
          || !bounded(&source.definition_id, 160)
          || !components.insert(&source.component_id)
        {
          return Err(invalid());
        }
      }
      if let Some(workflow) = &selection.workflow {
        if !bounded(&workflow.id, 160)
          || !bounded(&workflow.version, 64)
          || workflow.digest.len() != 64
          || !workflow
            .digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
          return Err(invalid());
        }
      }
    }
    Ok(())
  }
}
