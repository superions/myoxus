//! Permission service and the generic `AccessController` abstraction.
//!
//! [`PermissionService`] is the single entry point for all authorisation
//! checks in the application layer.  It resolves roles from the auth store
//! and delegates to the domain-level permission logic in
//! [`myoxus_domain::permission`].
//!
//! Two specialisations of [`AccessController`] are provided:
//! - For workspaces: `AccessController<WorkspaceResource>`
//! - For documents: `AccessController<DocResource>`

use crate::auth::{AuthError, AuthResult, AuthStore};
use async_trait::async_trait;
use myoxus_domain::entities::{DocRole, WorkspaceRole};
use myoxus_domain::permission::{DocAction, WorkspaceAction, fixup_doc_role};
use std::{
  collections::{HashMap, HashSet},
  sync::{Arc, OnceLock},
};
use tracing::{debug, instrument};
use uuid::Uuid;

use crate::organization::OrganizationPermissionService;

/// Generic access-control interface for a resource type `R`.
///
/// Implementations must be `Send + Sync` so they can be shared across Axum
/// handler futures.
#[async_trait]
pub trait AccessController<R>: Send + Sync {
  /// The action type checked against the resource.
  type Action;
  /// Return `true` if the subject may perform `action` on `resource`.
  async fn can(&self, resource: &R, action: Self::Action) -> bool;
  /// Assert that the subject may perform `action`.  Returns
  /// [`AuthError::ActionForbidden`] when the check fails.
  async fn assert(&self, resource: &R, action: Self::Action) -> Result<(), AuthError>;
}

/// Subject + resource descriptor for a workspace permission check.
pub struct WorkspaceResource {
  /// The user performing the action.
  pub user_id: Uuid,
  /// The workspace being accessed.
  pub workspace_id: Uuid,
}

/// Subject + resource descriptor for a document permission check.
pub struct DocResource {
  /// The user performing the action.
  pub user_id: Uuid,
  /// The workspace the document belongs to (used for workspace-role lookup).
  pub workspace_id: Uuid,
  /// Authorized server-internal document id.
  pub doc_id: Uuid,
}

/// Resolves roles and evaluates access-control decisions.
///
/// Implements [`AccessController<WorkspaceResource>`] and
/// [`AccessController<DocResource>`].
pub struct PermissionService {
  store: Arc<dyn AuthStore>,
  /// Optional OU permission service used to derive effective workspace access.
  ///
  /// Direct membership remains the raw role. A manager-scoped OU link raises
  /// only the effective role, capped at [`WorkspaceRole::Admin`].
  org_permission: OnceLock<Arc<OrganizationPermissionService>>,
}

/// Raw membership and the role used for authorization decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceAccess {
  /// Direct `workspace_memberships` role, if one exists.
  pub direct_role: Option<WorkspaceRole>,
  /// Direct role raised to `Admin` when the actor manages a linked OU.
  pub effective_role: Option<WorkspaceRole>,
}

/// Select the capability required to mutate an existing membership.
///
/// Target roles classify the mutation; they never grant authority. Human
/// ownership changes only through the atomic ownership-transfer path.
pub fn required_membership_mutation_action(
  current: WorkspaceRole,
  requested: Option<WorkspaceRole>,
) -> AuthResult<WorkspaceAction> {
  match requested {
    Some(WorkspaceRole::Owner) => Ok(WorkspaceAction::TransferOwner),
    Some(_) if current == WorkspaceRole::Owner => Err(AuthError::ActionForbidden),
    Some(next) if current == WorkspaceRole::Admin || next == WorkspaceRole::Admin => {
      Ok(WorkspaceAction::AdministratorsManage)
    }
    None if current == WorkspaceRole::Owner => Err(AuthError::ActionForbidden),
    None if current == WorkspaceRole::Admin => Ok(WorkspaceAction::AdministratorsManage),
    _ => Ok(WorkspaceAction::UsersManage),
  }
}

impl PermissionService {
  /// Construct a `PermissionService` backed by the given auth store.
  /// OU-manager fallback is disabled until [`Self::with_organization_permissions`]
  /// is called.
  pub fn new(store: Arc<dyn AuthStore>) -> Self {
    Self {
      store,
      org_permission: OnceLock::new(),
    }
  }

  /// Wire an [`OrganizationPermissionService`] so OU-manager scope can
  /// participate in the same effective-role resolution as direct membership.
  pub fn with_organization_permissions(self, perm: Arc<OrganizationPermissionService>) -> Self {
    let _ = self.org_permission.set(perm);
    self
  }

  /// Attach the organization resolver to an already shared permission service.
  ///
  /// Production constructs some workspace-scoped services before organization
  /// repositories are ready. Keeping this dependency in a one-shot cell means
  /// those consumers retain the same authoritative permission service instead
  /// of capturing a stale pre-organization instance.
  pub fn set_organization_permissions(&self, perm: Arc<OrganizationPermissionService>) -> bool {
    self.org_permission.set(perm).is_ok()
  }

  /// Return the user's direct membership role, or `None` if not a member.
  ///
  /// This method intentionally does not apply OU-manager scope. Callers that
  /// make authorization or capability decisions must use
  /// [`Self::resolve_workspace_access`] instead.
  #[instrument(skip_all)]
  pub async fn get_workspace_role(&self, user_id: Uuid, workspace_id: Uuid) -> Option<WorkspaceRole> {
    self
      .store
      .get_workspace_role(user_id, workspace_id)
      .await
      .unwrap_or(None)
  }

  /// Resolve direct membership and the server-authoritative effective role.
  ///
  /// Repository errors for the direct role are propagated. An OU lookup error
  /// is logged and fails closed by retaining the direct role without elevation.
  #[instrument(skip_all)]
  pub async fn resolve_workspace_access(&self, user_id: Uuid, workspace_id: Uuid) -> AuthResult<WorkspaceAccess> {
    let direct_role = self.store.get_workspace_role(user_id, workspace_id).await?;
    if direct_role.is_some_and(|role| role >= WorkspaceRole::Admin) {
      return Ok(WorkspaceAccess {
        direct_role,
        effective_role: direct_role,
      });
    }

    let effective_role = match self.org_permission.get() {
      Some(org_permission) => match org_permission.can_manage_ou_workspace(user_id, workspace_id).await {
        Ok(true) => Some(WorkspaceRole::Admin),
        Ok(false) => direct_role,
        Err(error) => {
          debug!(
            error = %error,
            user_id = %user_id,
            workspace_id = %workspace_id,
            "OU-manager scope lookup failed; retaining direct workspace role"
          );
          direct_role
        }
      },
      None => direct_role,
    };

    Ok(WorkspaceAccess {
      direct_role,
      effective_role,
    })
  }

  /// Return the effective workspace role used by capabilities and mutation
  /// guards. The raw membership remains available through
  /// [`Self::get_workspace_role`].
  #[instrument(skip_all)]
  pub async fn get_effective_workspace_role(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
  ) -> AuthResult<Option<WorkspaceRole>> {
    Ok(
      self
        .resolve_workspace_access(user_id, workspace_id)
        .await?
        .effective_role,
    )
  }

  /// Admit a shared template-catalog operation once, without document grants.
  /// External is excluded only from this catalog; ordinary workspace/document
  /// authorization and public delivery keep their existing semantics.
  #[instrument(skip_all)]
  pub async fn assert_template_catalog_read(&self, user_id: Uuid, workspace_id: Uuid) -> AuthResult<()> {
    match self.get_effective_workspace_role(user_id, workspace_id).await? {
      Some(role) if role != WorkspaceRole::External && role.can(WorkspaceAction::Read) => Ok(()),
      _ => Err(AuthError::ActionForbidden),
    }
  }

  /// Return the user's per-document role override, or `None` if no override
  /// exists.
  #[instrument(skip_all)]
  pub async fn get_doc_role(&self, user_id: Uuid, doc_id: Uuid) -> Option<DocRole> {
    self.store.get_doc_role(user_id, doc_id).await.unwrap_or(None)
  }

  /// Resolve the effective document role from the effective workspace role and
  /// an explicit document grant.
  #[instrument(skip_all)]
  pub async fn get_effective_doc_role(&self, user_id: Uuid, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<DocRole> {
    let workspace_role = self.get_effective_workspace_role(user_id, workspace_id).await?;
    let document_role = self.store.get_doc_role(user_id, doc_id).await?;
    Ok(fixup_doc_role(workspace_role, document_role))
  }

  /// Return the subset of `doc_ids` for which the user may read document data.
  ///
  /// This is deliberately a two-read operation: one workspace-role lookup and
  /// one bulk override lookup. Callers must pass already loaded candidates;
  /// this method never loads document content or performs per-document SQL.
  #[instrument(skip_all)]
  pub async fn readable_doc_ids(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_ids: &[Uuid],
  ) -> AuthResult<HashSet<Uuid>> {
    let roles = self.effective_doc_roles(user_id, workspace_id, doc_ids).await?;
    Ok(
      roles
        .iter()
        .filter_map(|(doc_id, role)| role.can(DocAction::Read).then_some(*doc_id))
        .collect(),
    )
  }

  /// Resolve effective roles for a candidate document set with one workspace
  /// lookup and one bulk override lookup. List projections use this to retain
  /// action-specific UI permissions without falling back to per-row queries.
  #[instrument(skip_all)]
  pub async fn effective_doc_roles(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_ids: &[Uuid],
  ) -> AuthResult<HashMap<Uuid, DocRole>> {
    if doc_ids.is_empty() {
      return Ok(HashMap::new());
    }

    let workspace_role = self.get_effective_workspace_role(user_id, workspace_id).await?;
    let explicit_roles = self.store.get_doc_roles_bulk(user_id, doc_ids).await?;
    Ok(
      doc_ids
        .iter()
        .copied()
        .map(|doc_id| {
          (
            doc_id,
            fixup_doc_role(workspace_role, explicit_roles.get(&doc_id).copied()),
          )
        })
        .collect(),
    )
  }
}

#[async_trait]
impl AccessController<WorkspaceResource> for PermissionService {
  type Action = WorkspaceAction;

  async fn can(&self, resource: &WorkspaceResource, action: Self::Action) -> bool {
    self
      .get_effective_workspace_role(resource.user_id, resource.workspace_id)
      .await
      .ok()
      .flatten()
      .is_some_and(|role| role.can(action))
  }

  async fn assert(&self, resource: &WorkspaceResource, action: Self::Action) -> Result<(), AuthError> {
    if self.can(resource, action).await {
      Ok(())
    } else {
      Err(AuthError::ActionForbidden)
    }
  }
}

#[async_trait]
impl AccessController<DocResource> for PermissionService {
  type Action = DocAction;

  async fn can(&self, resource: &DocResource, action: Self::Action) -> bool {
    self
      .get_effective_doc_role(resource.user_id, resource.workspace_id, resource.doc_id)
      .await
      .is_ok_and(|role| role.can(action))
  }

  async fn assert(&self, resource: &DocResource, action: Self::Action) -> Result<(), AuthError> {
    if self.can(resource, action).await {
      Ok(())
    } else {
      Err(AuthError::ActionForbidden)
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::auth::InMemoryAuthStore;

  #[tokio::test]
  async fn test_workspace_access_controller() {
    let store = Arc::new(InMemoryAuthStore::default());
    let service = PermissionService::new(store);
    let resource = WorkspaceResource {
      user_id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
    };

    // Default is no access (External role)
    assert!(!service.can(&resource, WorkspaceAction::Sync).await);
  }

  #[tokio::test]
  async fn readable_doc_ids_matches_single_document_permission_results() {
    let store = Arc::new(InMemoryAuthStore::default());
    let user_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let readable = Uuid::new_v4();
    let commenter = Uuid::new_v4();
    let denied = Uuid::new_v4();
    store.set_doc_role(user_id, readable, DocRole::Reader);
    store.set_doc_role(user_id, commenter, DocRole::Commenter);
    let service = PermissionService::new(store);

    let candidates = [readable, commenter, denied];
    let bulk = service
      .readable_doc_ids(user_id, workspace_id, &candidates)
      .await
      .expect("bulk permission lookup should succeed");
    let mut expected = HashSet::new();
    for doc_id in candidates {
      if service
        .can(
          &DocResource {
            user_id,
            workspace_id,
            doc_id,
          },
          DocAction::Read,
        )
        .await
      {
        expected.insert(doc_id);
      }
    }
    assert_eq!(bulk, expected);
  }

  #[test]
  fn membership_mutation_policy_preserves_role_boundaries() {
    use WorkspaceAction::{AdministratorsManage, TransferOwner, UsersManage};

    for role in [
      WorkspaceRole::External,
      WorkspaceRole::Reader,
      WorkspaceRole::Commenter,
      WorkspaceRole::Collaborator,
      WorkspaceRole::Manager,
    ] {
      assert_eq!(required_membership_mutation_action(role, None).unwrap(), UsersManage);
      assert_eq!(
        required_membership_mutation_action(WorkspaceRole::Reader, Some(role)).unwrap(),
        UsersManage
      );
    }

    assert_eq!(
      required_membership_mutation_action(WorkspaceRole::Admin, None).unwrap(),
      AdministratorsManage
    );
    assert_eq!(
      required_membership_mutation_action(WorkspaceRole::Manager, Some(WorkspaceRole::Admin)).unwrap(),
      AdministratorsManage
    );
    assert_eq!(
      required_membership_mutation_action(WorkspaceRole::Admin, Some(WorkspaceRole::Manager)).unwrap(),
      AdministratorsManage
    );
    assert_eq!(
      required_membership_mutation_action(WorkspaceRole::Reader, Some(WorkspaceRole::Owner)).unwrap(),
      TransferOwner
    );
    assert!(matches!(
      required_membership_mutation_action(WorkspaceRole::Owner, None),
      Err(AuthError::ActionForbidden)
    ));
    assert!(matches!(
      required_membership_mutation_action(WorkspaceRole::Owner, Some(WorkspaceRole::Admin)),
      Err(AuthError::ActionForbidden)
    ));
  }
}
