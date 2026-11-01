// SPDX-License-Identifier: AGPL-3.0-or-later
//! Organization wiring within the API crate.
//!
//! [`build_services`] composes infrastructure-owned organization capabilities
//! into the application services used by GraphQL resolvers. This module keeps
//! only API-specific cache invalidation around manager-capability transitions;
//! user-feature persistence itself belongs to infrastructure.

use std::sync::Arc;

use crate::state::ApiState;
use async_trait::async_trait;
use myoxus_application::organization::ManagerCapabilityWriter;
use myoxus_application::organization::permission::UserFeatureLookup;
use myoxus_application::organization::{OrganizationImportExportService, UserEmailLookup};
use myoxus_domain::ids::UserId;
use sqlx::PgPool;

/// Shared writer for the global Manager capability.
///
/// GraphQL admin mutations and OIDC OU sync both call this adapter so
/// `user_features` writes and user-feature cache invalidation stay in one API
/// integration point.
#[derive(Clone)]
pub struct ManagerCapabilityWriterAdapter {
  state: Arc<ApiState>,
}

impl ManagerCapabilityWriterAdapter {
  pub fn new(state: Arc<ApiState>) -> Self {
    Self { state }
  }
}

#[async_trait]
impl ManagerCapabilityWriter for ManagerCapabilityWriterAdapter {
  async fn ensure_manager_capability(&self, user_id: UserId) -> Result<bool, String> {
    ensure_manager_capability(&self.state, user_id).await
  }

  async fn revoke_manager_capability_if_no_more(&self, user_id: UserId) -> Result<bool, String> {
    revoke_manager_capability_if_no_more(&self.state, user_id).await
  }
}

/// Ensure `FeatureType.Manager` is active for a user with at least one
/// OU-manager membership. Returns `true` only on inactive -> active transition.
pub async fn ensure_manager_capability(state: &Arc<ApiState>, user_id: UserId) -> Result<bool, String> {
  let transitioned = state
    .manager_capability_writer()
    .ensure_manager_capability(user_id)
    .await?;
  if transitioned {
    state.invalidate_user_feature_cache_l2(user_id).await;
  }
  Ok(transitioned)
}

/// Revoke `FeatureType.Manager` only when the user has no remaining
/// OU-manager memberships. Returns `true` only on active -> inactive transition.
pub async fn revoke_manager_capability_if_no_more(state: &Arc<ApiState>, user_id: UserId) -> Result<bool, String> {
  let transitioned = state
    .manager_capability_writer()
    .revoke_manager_capability_if_no_more(user_id)
    .await?;
  if transitioned {
    state.invalidate_user_feature_cache_l2(user_id).await;
  }
  Ok(transitioned)
}

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
  let feature_lookup: Arc<dyn UserFeatureLookup> = Arc::new(
    myoxus_infrastructure::organization::PgUserFeatureLookup::new(pool.clone()),
  );
  let email_lookup: Arc<dyn UserEmailLookup> =
    Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone()));
  let import_writer: Arc<dyn myoxus_application::organization::OrganizationImportWriter> = Arc::new(
    myoxus_infrastructure::organization::PgOrganizationImportWriter::new(pool),
  );
  let permission = Arc::new(myoxus_application::organization::OrganizationPermissionService::new(
    organization_unit_member_repo.clone(),
    organization_unit_repo.clone(),
    organization_unit_workspace_repo.clone(),
    organization_policy_repo.clone(),
    feature_lookup,
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
