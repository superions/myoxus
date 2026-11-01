// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native Row and Cell editing operations and reusable value rules.
use super::*;
pub mod changes;
mod movement;
pub mod presentation;
pub mod rules;
pub mod templates;

mod batches;
mod links;
pub mod maintenance;
mod records;
mod review;
pub(crate) use review::task_description_value;

#[derive(Clone)]
pub struct DatabaseEditingService {
  pub(super) reminders: Arc<DatabaseReminderService>,
  pub(super) schema_repo: Arc<dyn DatabaseDefinitionRepository>,
  pub(super) row_repo: Arc<dyn DatabaseEditingRepository>,
  pub(super) doc_service: DocService,
  pub(super) workspace_store: Arc<dyn WorkspaceStore>,
  pub(super) permission: Arc<PermissionService>,
  pub(super) limits: DatabaseLimits,
  pub(super) effects: DatabaseMutationEffects,
  pub(super) blob_service: DatabaseCapability<Arc<BlobService>>,
  pub(super) workspace_tags: DatabaseCapability<Arc<WorkspaceTagService>>,
  pub(super) projection: Arc<DatabaseProjectionService>,
}

pub mod capture;
