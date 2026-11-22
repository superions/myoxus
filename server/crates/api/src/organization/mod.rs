// SPDX-License-Identifier: AGPL-3.0-or-later
//! Organization wiring within the API crate.
//!
//! [`build_services`] composes infrastructure-owned organization capabilities
//! into the application services used by GraphQL resolvers. This module keeps
//! API-specific cache invalidation around changes to a user's Manager status.

use std::sync::Arc;

use crate::state::ApiState;
use async_trait::async_trait;
use myoxus_application::organization::{OrganizationImportExportService, UserEmailLookup};
use myoxus_domain::ids::UserId;
use sqlx::PgPool;

/// Convenience wiring: takes the seven concrete Postgres repositories
/// and produces the three `Arc`-wrapped services. Used by `server.rs`
/// and the test harness so every resolver shares the same instance.
#[allow(clippy::too_many_arguments)]
pub fn build_services(
  pool: PgPool,
  organization_repo: Arc<dyn myoxus_domain::repositories::OrganizationRepository>,
  organization_unit_type_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitTypeRepository>,
  organization_unit_member_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitMemberRepository>,
  organization_unit_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitRepository>,
  organization_unit_workspace_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitWorkspaceRepository>,
  organization_policy_repo: Arc<dyn myoxus_domain::repositories::OrganizationPolicyRepository>,
  organization_project_request_repo: Arc<dyn myoxus_domain::repositories::OrganizationProjectRequestRepository>,
) -> (
  Arc<myoxus_application::organization::OrganizationPermissionService>,
  Arc<myoxus_application::organization::ProjectRequestService>,
  Arc<OrganizationImportExportService>,
) {
  let email_lookup: Arc<dyn UserEmailLookup> =
    Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone()));
  let import_writer: Arc<dyn myoxus_application::organization::OrganizationImportWriter> = Arc::new(
    myoxus_infrastructure::organization::PgOrganizationImportWriter::new(pool),
  );
  let permission = Arc::new(myoxus_application::organization::OrganizationPermissionService::new(
    organization_unit_member_repo.clone(),
    organization_unit_repo.clone(),
    organization_policy_repo.clone(),
  ));
  let project_request = Arc::new(myoxus_application::organization::ProjectRequestService::new(
    organization_project_request_repo,
    permission.clone(),
  ));
  let import_export = Arc::new(OrganizationImportExportService::new(
    organization_repo,
    organization_unit_type_repo,
    organization_unit_repo,
    organization_unit_member_repo,
    organization_unit_workspace_repo,
    organization_policy_repo,
    email_lookup,
    import_writer,
  ));
  (permission, project_request, import_export)
}

/// API effect adapter retains local fill guards, L2 deletion and existing fan-out.
pub struct MembershipEffectsAdapter(pub Arc<ApiState>);
#[async_trait]
impl myoxus_application::organization::OrganizationMembershipEffects for MembershipEffectsAdapter {
  async fn invalidate_features(&self, user_id: UserId) {
    self.0.invalidate_user_feature_cache_l2(user_id).await;
  }
}
