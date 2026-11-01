// SPDX-License-Identifier: AGPL-3.0-or-later
//! Narrow, point-in-time template context. Callers must authorize Workspace Read;
//! organization administration and the actor's OU memberships are unrelated.

use crate::{
  auth::{AuthError, AuthResult},
  workspace::WorkspaceStore,
};
use myoxus_domain::{
  entities::{OrganizationUnitWorkspaceRelationship, OwnerPrincipalType},
  ids::WorkspaceId,
  repositories::{OrganizationRepository, OrganizationUnitRepository, OrganizationUnitWorkspaceRepository},
};
use std::sync::Arc;
use tracing::instrument;

#[derive(Default)]
pub struct OrganizationTemplateContext {
  pub organization_name: Option<String>,
  pub organization_unit_name: Option<String>,
}

pub struct OrganizationTemplateContextService {
  workspaces: Arc<dyn WorkspaceStore>,
  organizations: Arc<dyn OrganizationRepository>,
  links: Arc<dyn OrganizationUnitWorkspaceRepository>,
  units: Arc<dyn OrganizationUnitRepository>,
}

impl OrganizationTemplateContextService {
  pub fn new(
    workspaces: Arc<dyn WorkspaceStore>,
    organizations: Arc<dyn OrganizationRepository>,
    links: Arc<dyn OrganizationUnitWorkspaceRepository>,
    units: Arc<dyn OrganizationUnitRepository>,
  ) -> Self {
    Self {
      workspaces,
      organizations,
      links,
      units,
    }
  }

  /// Unrequested fields perform no reads. Missing/corrupt field data is nullable;
  /// transport failures abort rather than masquerading as legitimate absence.
  #[instrument(skip_all)]
  pub async fn resolve(
    &self,
    workspace_id: WorkspaceId,
    organization: bool,
    owner_unit: bool,
  ) -> AuthResult<OrganizationTemplateContext> {
    let mut context = OrganizationTemplateContext::default();
    if organization {
      context.organization_name = self
        .organizations
        .get_by_key("myoxus")
        .await
        .map_err(|_| unavailable())?
        .and_then(|org| name(&org.name));
    }
    if owner_unit {
      // Ownership and links are independent persisted projections. Only their
      // agreement authorizes an OU name; managed/linked units are never selected.
      if let Some((OwnerPrincipalType::Ou, principal_id)) = self.workspaces.read_owner_principal(workspace_id).await? {
        let links = self
          .links
          .list_for_workspace(workspace_id)
          .await
          .map_err(|_| unavailable())?;
        let mut owners = links
          .iter()
          .filter(|link| link.relationship == OrganizationUnitWorkspaceRelationship::Owner);
        if let Some(owner) = owners.next()
          && owners.next().is_none()
          && owner.unit_id == principal_id
        {
          context.organization_unit_name = self
            .units
            .get_by_id(principal_id)
            .await
            .map_err(|_| unavailable())?
            .and_then(|unit| name(&unit.name));
        }
      }
    }
    Ok(context)
  }
}

fn name(value: &str) -> Option<String> {
  let value = value.trim();
  (!value.is_empty()).then(|| value.to_owned())
}

fn unavailable() -> AuthError {
  AuthError::Storage("organization template context unavailable".into())
}
