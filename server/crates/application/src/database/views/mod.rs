// SPDX-License-Identifier: AGPL-3.0-or-later
//! Actor-safe discovery, saved definitions and personal View state.
use super::*;
mod definitions;
mod query;
pub mod rules;
mod state;
mod tasks;

#[derive(Clone)]
pub struct DatabaseViewService {
  pub(super) schema_repo: Arc<dyn DatabaseDefinitionRepository>,
  pub(super) row_repo: Arc<dyn DatabaseEditingRepository>,
  pub(super) view_query_repo: Arc<dyn DatabaseViewRepository>,
  pub(super) workspace_store: Arc<dyn WorkspaceStore>,
  pub(super) permission: Arc<PermissionService>,
  pub(super) limits: DatabaseLimits,
  pub(super) effects: DatabaseMutationEffects,
  pub(super) workspace_tags: DatabaseCapability<Arc<WorkspaceTagService>>,
  pub(super) page_inventory_cache: DatabaseCapability<Arc<dyn DocCachePort>>,
  pub(super) page_inventory_loads: Cache<(Uuid, String, i64, i64, i64), Vec<DatabasePageIdentity>>,
}
pub mod projection;
