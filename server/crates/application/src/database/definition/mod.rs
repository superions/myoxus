//! Database creation, lifecycle, fields and currently assigned saved definitions.
use super::*;
mod fields;
mod lifecycle;
pub mod rules;
pub mod templates;
pub use templates::{
  DatabaseStarterTemplateCatalog, DatabaseStarterTemplateSource, DatabaseTemplateCatalogSelection,
  DatabaseTemplateCurrentTarget, DatabaseTemplateInventory, DatabaseTemplateOffering,
  validate_database_template_definition, validate_database_template_selection,
};

#[derive(Clone)]
pub struct DatabaseDefinitionService {
  pub(super) schema_repo: Arc<dyn DatabaseDefinitionRepository>,
  pub(super) projection_repo: Arc<dyn DatabaseProjectionRepository>,
  pub(super) projection: Arc<DatabaseProjectionService>,
  pub(super) permission: Arc<PermissionService>,
  pub(super) limits: DatabaseLimits,
  pub(super) effects: DatabaseMutationEffects,
  pub(super) starter_templates: Arc<DatabaseStarterTemplateCatalog>,
}

impl DatabaseDefinitionService {
  /// Immutable source metadata shared by native defaults and package preparation.
  pub fn starter_template_catalog(&self) -> &DatabaseStarterTemplateCatalog {
    &self.starter_templates
  }

  pub fn new(
    schema_repo: Arc<dyn DatabaseDefinitionRepository>,
    projection_repo: Arc<dyn DatabaseProjectionRepository>,
    permission: Arc<PermissionService>,
    limits: DatabaseLimits,
    effects: DatabaseMutationEffects,
    starter_templates: Arc<DatabaseStarterTemplateCatalog>,
    projection: Arc<DatabaseProjectionService>,
  ) -> Self {
    Self {
      schema_repo,
      projection_repo,
      projection,
      permission,
      limits,
      effects,
      starter_templates,
    }
  }
}

pub mod managed_schema;
pub use managed_schema::DatabaseManagedInitializationReport;
