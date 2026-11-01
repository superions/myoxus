// SPDX-License-Identifier: AGPL-3.0-or-later
//! Portable formats share native import/content owners; jobs retain their current lifecycle.
pub(super) mod content;
mod csv;
mod jobs;
pub(super) mod json;
mod legacy_migration;
mod notion;
pub mod notion_import;
pub(super) mod workspace_content;
use crate::database::{
  DatabaseCapability, DatabaseEditingService, DatabaseJobEnqueuer, DatabaseLimits, DatabaseProjectionService,
  DatabaseStarterTemplateCatalog, DatabaseViewService,
};
use crate::doc::DocService;
use crate::permission::PermissionService;
use crate::ports::blob_service::BlobService;
use crate::template_registry::TemplateRegistryService;
use crate::workspace::WorkspaceStore;
use crate::workspace_tags::WorkspaceTagService;
pub use legacy_migration::{
  LegacyDatabaseBlockReferencePlan, LegacyDatabaseDocumentSource, LegacyDatabaseFieldPlan,
  LegacyDatabaseMigrationApplyResult, LegacyDatabaseMigrationPlan, LegacyDatabasePlan, LegacyDatabaseRowPlan,
  LegacyDatabaseViewPlan, plan_fresh_workspace_legacy_database_migration, plan_legacy_database_migration,
};
use myoxus_domain::database::{
  DatabaseDefinitionRepository, DatabaseEditingRepository, DatabaseImportExportRepository, DatabaseViewRepository,
};
use std::sync::Arc;
pub use workspace_content::{WorkspaceContentDatabaseIdentityPlan, WorkspaceContentDatabasePublicationBundle};

#[derive(Clone)]
pub struct DatabaseImportExportService {
  pub(super) starter_templates: Arc<DatabaseStarterTemplateCatalog>,
  pub(super) schema_repo: Arc<dyn DatabaseDefinitionRepository>,
  pub(super) row_repo: Arc<dyn DatabaseEditingRepository>,
  pub(super) view_query_repo: Arc<dyn DatabaseViewRepository>,
  pub(super) import_export_repo: Arc<dyn DatabaseImportExportRepository>,
  pub(super) doc_service: DocService,
  pub(super) workspace_store: Arc<dyn WorkspaceStore>,
  pub(super) permission: Arc<PermissionService>,
  pub(super) limits: DatabaseLimits,
  pub(super) blob_service: DatabaseCapability<Arc<BlobService>>,
  pub(super) template_registry: DatabaseCapability<TemplateRegistryService>,
  pub(super) job_queue: DatabaseCapability<Arc<dyn DatabaseJobEnqueuer>>,
  pub(super) workspace_tags: DatabaseCapability<Arc<WorkspaceTagService>>,
  pub(super) rows: Arc<DatabaseEditingService>,
  pub(super) views: Arc<DatabaseViewService>,
  pub(super) projection: Arc<DatabaseProjectionService>,
}

impl DatabaseImportExportService {
  pub fn limits(&self) -> &DatabaseLimits {
    &self.limits
  }
}
