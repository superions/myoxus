// SPDX-License-Identifier: AGPL-3.0-or-later

//! Immutable assistant catalogs and explicit native service composition.
mod catalog;
mod saved_setup;
pub use saved_setup::*;
mod context_documents;
mod task_handover;
pub use context_documents::{ContextDocumentContext, context_documents_admission, context_documents_digest};
pub mod setup;
pub use setup::*;
mod preparation;
mod presentation;
mod project_setup;
mod validation;

pub use catalog::{
  AssistantPackageCatalog, AssistantPackageInventory, AssistantPackageSourcePort, validate_assistant_selection,
};
pub use preparation::{AssistantAppliedProject, PreparedWorkspaceAssistant, plan_digest, review_project_admission};
pub use presentation::resolve_fields;
pub use validation::validate_assistant_package;
pub(crate) use validation::workspace_setup_source;

use crate::database::{DatabaseDefinitionService, DatabaseStarterTemplateCatalog, DatabaseViewService};
use myoxus_domain::database::{default_database_currency_code, normalize_database_currency_code};
use std::sync::Arc;

#[derive(Clone)]
pub struct AssistantPackageService {
  packages: Arc<AssistantPackageCatalog>,
  templates: Arc<DatabaseStarterTemplateCatalog>,
  definition: Arc<DatabaseDefinitionService>,
  views: Arc<DatabaseViewService>,
  workspace_store: Arc<dyn crate::workspace::WorkspaceStore>,
  project_placement: Option<Arc<crate::document_template::DocumentTemplateService>>,
  document_components: Option<Arc<crate::template_registry::TemplateRegistryService>>,
  default_currency: String,
  default_locale: String,
  context_workflows_enabled: bool,
}
impl AssistantPackageService {
  pub(crate) fn context_workflows_enabled(&self) -> bool {
    self.context_workflows_enabled
  }
  pub fn with_context_workflows_enabled(mut self, enabled: bool) -> Self {
    self.context_workflows_enabled = enabled;
    self
  }
  /// Only the real native pair enables selected document effects; absent
  /// capabilities keep ordinary Project/Empty preparation available.
  pub fn with_document_components(
    mut self,
    documents: Arc<crate::document_template::DocumentTemplateService>,
    registry: Arc<crate::template_registry::TemplateRegistryService>,
  ) -> Self {
    self.project_placement = Some(documents);
    self.document_components = Some(registry);
    self
  }
  pub fn with_project_placement(mut self, documents: Arc<crate::document_template::DocumentTemplateService>) -> Self {
    self.project_placement = Some(documents);
    self
  }
  pub fn default_locale(&self) -> &str {
    &self.default_locale
  }
  pub fn new(
    packages: Arc<AssistantPackageCatalog>,
    templates: Arc<DatabaseStarterTemplateCatalog>,
    definition: Arc<DatabaseDefinitionService>,
    views: Arc<DatabaseViewService>,
    workspace_store: Arc<dyn crate::workspace::WorkspaceStore>,
    default_currency: String,
    default_locale: String,
  ) -> Self {
    Self {
      context_workflows_enabled: false,
      project_placement: None,
      document_components: None,
      packages,
      templates,
      definition,
      views,
      workspace_store,
      // Preserve unsupported configuration as unavailable at native prepare;
      // never substitute another language for the reviewed operator snapshot.
      default_locale: default_locale
        .trim()
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase(),
      // Keep the immutable operator snapshot aligned with native creation.
      default_currency: normalize_database_currency_code(&default_currency)
        .unwrap_or_else(default_database_currency_code),
    }
  }
}

#[cfg(test)]
mod tests;

pub(crate) fn unavailable_project_components() -> crate::database::DatabaseServiceError {
  validation::invalid("selected Project effects require their native execution capability")
}

mod maintenance;

mod task_preparation;
