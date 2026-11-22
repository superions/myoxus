//! Organization permission service.
//!
//! Encapsulates all permission decisions related to organisations,
//! organisation units (OUs), and the manager scope. The service has
//! exactly one responsibility: given a user, an OU, and an action, return
//! a decisive `bool` (or a structured `Decision` enum where the answer
//! must distinguish "deny", "needs approval", or "allow").
//!
//! Manager authority comes from the membership in the active organization unit.

use std::sync::Arc;

use tracing::{debug, instrument};

use myoxus_domain::entities::{
  OrganizationUnitRole, OrganizationUnitStatus, OwnerPrincipalType, PolicyState, WorkspaceRole,
  map_ou_role_to_max_workspace_role,
};
use myoxus_domain::ids::{OrganizationId, OrganizationUnitId, UserId};
use myoxus_domain::repositories::{
  OrganizationPolicyRepository, OrganizationUnitMemberRepository, OrganizationUnitRepository, RepoResult,
};

/// Where a project is supposed to be created.
#[derive(Debug, Clone, Copy)]
pub enum ProjectCreationScope {
  /// Root project under the organisation (no parent OU).
  OrganizationRoot,
  /// Project under a specific parent OU.
  Ou(OrganizationUnitId),
}

/// Decision tri-state for project / workspace creation. Mirrors
/// `PolicyState` but with explicit semantic intent so the GraphQL layer
/// can branch without re-translating.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectCreationDecision {
  /// Caller may create directly.
  Allowed,
  /// Caller must file an `organization_project_request`; admins decide.
  RequiresApproval,
  /// Caller is denied — either policy=disabled or scope mismatch.
  Denied,
}

/// Aggregate permission service for the organisation domain.
#[derive(Clone)]
pub struct OrganizationPermissionService {
  members: Arc<dyn OrganizationUnitMemberRepository>,
  units: Arc<dyn OrganizationUnitRepository>,
  policies: Arc<dyn OrganizationPolicyRepository>,
}

impl OrganizationPermissionService {
  pub fn new(
    members: Arc<dyn OrganizationUnitMemberRepository>,
    units: Arc<dyn OrganizationUnitRepository>,
    policies: Arc<dyn OrganizationPolicyRepository>,
  ) -> Self {
    Self {
      members,
      units,
      policies,
    }
  }

  // ── Core: is the user a manager for THIS unit? ─────────────────────────

  /// Requires a manager membership in the active unit.
  ///
  /// Single source of truth for "may this user act as a manager on this
  /// OU?" — every other permission method delegates here for the
  /// scope-test.
  #[instrument(skip(self))]
  pub async fn is_manager_for_unit(&self, user: UserId, unit: OrganizationUnitId) -> bool {
    match self.units.get_by_id(unit).await {
      Ok(Some(unit)) if unit.status == OrganizationUnitStatus::Active => {}
      Ok(_) => return false,
      Err(error) => {
        debug!(%error, unit_id=%unit, "unit lookup failed; treating as inactive");
        return false;
      }
    }
    match self.members.get(unit, user).await {
      Ok(Some(member)) => matches!(member.role, OrganizationUnitRole::Manager),
      Ok(None) => false,
      Err(e) => {
        debug!(error=%e, user_id=%user, unit_id=%unit, "membership lookup failed; treating as no manager");
        false
      }
    }
  }

  /// Walks up the parent chain of `unit` and returns `true` if `user` is
  /// a manager for `unit` itself or any ancestor. Useful for the "manage
  /// child resources" pattern (e.g. a Manager of a Referat may also
  /// manage a sub-Sachgebiet).
  ///
  /// Caps the walk at 32 levels to defend against a bad parent chain in
  /// the database (concept § Organisationsmodell does not bound the
  /// depth, but practical hierarchies stay well below this cap).
  #[instrument(skip(self))]
  pub async fn is_manager_for_unit_or_ancestor(&self, user: UserId, unit: OrganizationUnitId) -> bool {
    let mut current = Some(unit);
    let mut depth = 0u32;
    while let Some(uid) = current {
      if depth > 32 {
        debug!(start_unit=%unit, "ancestor walk exceeded 32 levels — bailing");
        return false;
      }
      if self.is_manager_for_unit(user, uid).await {
        return true;
      }
      current = match self.units.get_by_id(uid).await {
        Ok(Some(u)) => u.parent_unit_id,
        _ => None,
      };
      depth += 1;
    }
    false
  }

  // ── Composite checks ───────────────────────────────────────────────────

  /// Workspace creation under a specific OU. Returns `true` iff:
  ///  * the caller is a manager for the OU (`is_manager_for_unit`),
  ///  * the org policy `manager_can_create_workspaces` is `true`.
  #[instrument(skip(self))]
  pub async fn can_create_workspace_in_ou(
    &self,
    user: UserId,
    org: OrganizationId,
    unit: OrganizationUnitId,
  ) -> RepoResult<bool> {
    if !self.is_manager_for_unit(user, unit).await {
      return Ok(false);
    }
    let policy = self.policies.get(org).await?;
    Ok(policy.manager_can_create_workspaces)
  }

  /// May `user` manage members (`reader`/`member`/`manager`-additions and
  /// removals) of `unit`? Requires manager-scope on the OU plus the
  /// `manager_can_manage_ou_members` policy.
  #[instrument(skip(self))]
  pub async fn can_manage_ou_members(
    &self,
    user: UserId,
    org: OrganizationId,
    unit: OrganizationUnitId,
  ) -> RepoResult<bool> {
    if !self.is_manager_for_unit(user, unit).await {
      return Ok(false);
    }
    let policy = self.policies.get(org).await?;
    Ok(policy.manager_can_manage_ou_members)
  }

  /// Returns the policy decision for project creation in `scope`.
  ///
  /// Scope-`OrganizationRoot` consults `manager_root_project_creation`,
  /// scope-`Ou(unit)` consults `manager_unit_project_creation` AND
  /// requires manager-scope on the OU.
  #[instrument(skip(self))]
  pub async fn can_create_project_in_scope(
    &self,
    user: UserId,
    org: OrganizationId,
    scope: ProjectCreationScope,
  ) -> RepoResult<ProjectCreationDecision> {
    let policy = self.policies.get(org).await?;
    match scope {
      ProjectCreationScope::OrganizationRoot => {
        if !self.members.manages_organization(user, org).await? {
          return Ok(ProjectCreationDecision::Denied);
        }
        Ok(decision_from_policy(policy.manager_root_project_creation))
      }
      ProjectCreationScope::Ou(unit) => {
        if !self.is_manager_for_unit(user, unit).await {
          return Ok(ProjectCreationDecision::Denied);
        }
        Ok(decision_from_policy(policy.manager_unit_project_creation))
      }
    }
  }

  /// Maximum workspace-role a manager may assign in an OU-owned workspace.
  ///
  /// `WorkspaceRole::Admin` is the cap (concept § Rollenmodell — Manager).
  /// Owner/system-level rights stay reserved for system admins.
  pub fn max_workspace_role_for_ou_role(&self, ou_role: OrganizationUnitRole) -> WorkspaceRole {
    map_ou_role_to_max_workspace_role(ou_role)
  }

  /// May `user` own a workspace as `OwnerPrincipal::User`? Used by the
  /// classic "personal workspace" path — always allowed for the user's
  /// own workspaces; admins can override by setting principal=`system`.
  pub fn can_own_personal_workspace(&self, _user: UserId, principal: OwnerPrincipalType) -> bool {
    matches!(principal, OwnerPrincipalType::User)
  }
}

fn decision_from_policy(policy: PolicyState) -> ProjectCreationDecision {
  match policy {
    PolicyState::Allowed => ProjectCreationDecision::Allowed,
    PolicyState::RequiresApproval => ProjectCreationDecision::RequiresApproval,
    PolicyState::Disabled => ProjectCreationDecision::Denied,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// `decision_from_policy` is the only piece of pure logic worth a unit
  /// test — the rest of the service requires DB-backed repositories and
  /// is covered by the integration tests in `crates/api/tests/`.
  #[test]
  fn decision_from_policy_maps_three_states() {
    assert_eq!(
      decision_from_policy(PolicyState::Allowed),
      ProjectCreationDecision::Allowed
    );
    assert_eq!(
      decision_from_policy(PolicyState::RequiresApproval),
      ProjectCreationDecision::RequiresApproval
    );
    assert_eq!(
      decision_from_policy(PolicyState::Disabled),
      ProjectCreationDecision::Denied
    );
  }

  /// `map_ou_role_to_max_workspace_role` must cap manager at `Admin`,
  /// never `Owner`.
  #[test]
  fn manager_caps_at_workspace_admin_not_owner() {
    use myoxus_domain::entities::WorkspaceRole;
    assert_eq!(
      map_ou_role_to_max_workspace_role(OrganizationUnitRole::Manager),
      WorkspaceRole::Admin,
      "OU-manager must not unlock workspace-Owner"
    );
    assert_eq!(
      map_ou_role_to_max_workspace_role(OrganizationUnitRole::Member),
      WorkspaceRole::Collaborator
    );
    assert_eq!(
      map_ou_role_to_max_workspace_role(OrganizationUnitRole::Reader),
      WorkspaceRole::Reader
    );
  }
}
