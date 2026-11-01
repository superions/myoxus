// SPDX-License-Identifier: AGPL-3.0-or-later
//! Central authorization and TOCTOU guard for workspace content operations.
//!
//! The graph builder owns content topology. This module binds that graph to the
//! existing effective permission model, owner principal, and exact confirmation
//! set. Workspace membership mutations are not implicit content effects.
//! Resolver and worker code must not reproduce these decisions.
//! Extract is admitted using workspace organization authority and preserves
//! that decision in its private target receipt rather than reauthorizing jobs.

use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use myoxus_domain::entities::{DocRole, OwnerPrincipalType, WorkspaceRole};
use myoxus_domain::ids::UserId;
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use myoxus_domain::workspace_content_operation::{
  WorkspaceContentBlocker, WorkspaceContentConfirmation, WorkspaceContentErrorCode, WorkspaceContentOperationKind,
  WorkspaceContentResourceKind,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};
use crate::permission::{AccessController, PermissionService, WorkspaceResource};

use super::preflight::WorkspaceContentPreflightGraph;

const MAX_AUTHORIZATION_REVISION_BYTES: usize = 128;

/// Stable owner identity. It intentionally has no display name or provenance.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentOwnerPrincipal {
  pub principal_type: OwnerPrincipalType,
  pub principal_id: Uuid,
}

/// One accepted source or target membership bound to the revision.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentMemberRevision {
  pub user_id: UserId,
  pub role: WorkspaceRole,
}

/// One server-derived membership effect for an existing target workspace.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentMembershipImpact {
  pub user_id: UserId,
  pub current_role: Option<WorkspaceRole>,
  pub required_role: WorkspaceRole,
}

/// Authorization-relevant state of one workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentWorkspaceRevision {
  pub workspace_id: Uuid,
  pub owner_principal: WorkspaceContentOwnerPrincipal,
  pub policy_revision: String,
  pub accepted_members: Vec<WorkspaceContentMemberRevision>,
}

/// Transactionally observed policy/ACL input supplied by the persistence tier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentAuthorizationState {
  pub source: WorkspaceContentWorkspaceRevision,
  pub target: Option<WorkspaceContentWorkspaceRevision>,
  pub document_acl_revision: String,
  /// Includes direct ACL and OU-policy/link state that can alter effective
  /// capabilities without changing a direct workspace membership.
  pub permission_revision: String,
}

/// Policy-state source. Implementations must read one coherent server snapshot.
#[async_trait]
pub trait WorkspaceContentAuthorizationSource: Send + Sync {
  async fn load_authorization_state(
    &self,
    graph: &WorkspaceContentPreflightGraph,
    include_copy_acl: bool,
  ) -> AuthResult<WorkspaceContentAuthorizationState>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentAuthorizationOptions {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub overview: Option<super::overview::WorkspaceContentOverviewSnapshot>,
  pub copy_document_acl: bool,
  pub extract_target_principal: Option<WorkspaceContentOwnerPrincipal>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub git_sync_plan: Option<super::WorkspaceContentGitSyncPlan>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub git_sync_blockers: Vec<WorkspaceContentBlocker>,
}

/// Membership effect plus the existing central mutation capability it needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentAuthorizedMembershipImpact {
  pub impact: WorkspaceContentMembershipImpact,
  pub required_action: WorkspaceAction,
}

/// Server-authoritative preflight projection consumed by API and execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentAuthorizedPreflight {
  /// Current native facts permit this legacy hash only for empty affected scopes.
  #[serde(skip)]
  pub legacy_empty_revision: Option<String>,
  pub graph: WorkspaceContentPreflightGraph,
  pub membership_impacts: Vec<WorkspaceContentAuthorizedMembershipImpact>,
  pub extract_memberships: Vec<WorkspaceContentMemberRevision>,
  /// Exact source owner carried only for Extract target creation.
  pub extract_target_principal: Option<WorkspaceContentOwnerPrincipal>,
  pub git_sync_plan: Option<super::WorkspaceContentGitSyncPlan>,
  pub required_confirmations: Vec<WorkspaceContentConfirmation>,
  pub blockers: Vec<WorkspaceContentBlocker>,
  pub revision: String,
}

impl WorkspaceContentAuthorizedPreflight {
  /// Keep receipts bound to the stored acceptance after the bounded legacy check.
  pub fn bind_accepted_revision(&mut self, revision: &str) -> bool {
    if self.revision != revision && self.legacy_empty_revision.as_deref() != Some(revision) {
      return false;
    }
    self.revision = revision.into();
    true
  }
}

#[derive(Debug, Error)]
pub enum WorkspaceContentAuthorizationError {
  #[error("workspace content authorization state is invalid")]
  InvalidState,
  #[error("workspace content preflight is stale")]
  Stale { code: WorkspaceContentErrorCode },
  #[error("workspace content confirmation set does not match the accepted preflight")]
  ConfirmationMismatch,
  #[error("workspace content operation remains blocked")]
  Blocked { blockers: Vec<WorkspaceContentBlocker> },
  #[error(transparent)]
  Authorization(#[from] AuthError),
}

/// Permission-backed preflight and execute-time stale guard.
pub struct WorkspaceContentAuthorizer<S> {
  permission: Arc<PermissionService>,
  source: S,
}

impl<S: WorkspaceContentAuthorizationSource> WorkspaceContentAuthorizer<S> {
  /// Retry is a new external-write admission, not a replay of former authority.
  pub(crate) async fn authorize_git_management(&self, actor_id: UserId, workspaces: &[uuid::Uuid]) -> AuthResult<()> {
    for workspace_id in workspaces {
      let resource = WorkspaceResource {
        user_id: actor_id,
        workspace_id: *workspace_id,
      };
      self
        .permission
        .assert(&resource, WorkspaceAction::SettingsUpdate)
        .await?;
    }
    Ok(())
  }
  pub fn new(permission: Arc<PermissionService>, source: S) -> Self {
    Self { permission, source }
  }

  /// Build the complete authorization projection without mutating state.
  pub async fn preflight(
    &self,
    actor_id: UserId,
    graph: WorkspaceContentPreflightGraph,
    mut options: WorkspaceContentAuthorizationOptions,
  ) -> Result<WorkspaceContentAuthorizedPreflight, WorkspaceContentAuthorizationError> {
    let mappings = graph
      .mappings
      .iter()
      .map(|planned| planned.mapping.clone())
      .collect::<Vec<_>>();
    if !super::overview::has_folder_mappings(&mappings) {
      options.overview = None;
    }
    if let Some(overview) = &options.overview {
      if overview.source.workspace_id != graph.source_workspace_id
        || overview.source.revision < 0
        || overview
          .target
          .as_ref()
          .is_some_and(|target| target.workspace_id != graph.target_workspace_id || target.revision < 0)
        || (graph.kind != WorkspaceContentOperationKind::ExtractFolder && overview.target.is_none())
        || overview.extracted_folder_id != graph.selection_root_folder_id
      {
        return Err(WorkspaceContentAuthorizationError::InvalidState);
      }
    }
    validate_options(graph.kind, &options)?;
    if graph
      .resources
      .iter()
      .any(|resource| resource.resource.kind() == WorkspaceContentResourceKind::Collection)
      || graph.mappings.iter().any(|planned| {
        planned.mapping.source.kind() == WorkspaceContentResourceKind::Collection
          || planned.mapping.target.kind() == WorkspaceContentResourceKind::Collection
      })
    {
      return Err(
        AuthError::InvalidInput(WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str().into()).into(),
      );
    }
    // Existing-workspace transfers need canonical actor capabilities, not
    // unrelated owner/membership/policy snapshots. Only Extract inherits them.
    let state = if graph.kind == WorkspaceContentOperationKind::ExtractFolder {
      let mut state = self.source.load_authorization_state(&graph, false).await?;
      normalize_and_validate_state(&graph, &mut state)?;
      Some(state)
    } else {
      None
    };

    let evaluation = self.evaluate_permissions(actor_id, &graph).await?;
    let mut blockers = graph.blockers.iter().copied().collect::<BTreeSet<_>>();
    blockers.extend(options.git_sync_blockers.iter().copied());
    if !evaluation.source_allowed || !evaluation.target_allowed {
      blockers.insert(WorkspaceContentBlocker::PermissionDenied);
    }
    if options.git_sync_plan.as_ref().is_some_and(|plan| plan.undo.is_some()) {
      for workspace_id in [graph.source_workspace_id, graph.target_workspace_id] {
        if !self
          .permission
          .can(
            &WorkspaceResource {
              user_id: actor_id,
              workspace_id,
            },
            WorkspaceAction::SettingsUpdate,
          )
          .await
        {
          blockers.insert(WorkspaceContentBlocker::GitSyncManagementDenied);
        }
      }
    }

    let mut required_confirmations = BTreeSet::new();
    let membership_impacts = Vec::new();
    let mut extract_memberships = Vec::new();
    let mut extract_target_principal = None;

    match graph.kind {
      WorkspaceContentOperationKind::Copy if options.copy_document_acl => {
        // Explicit grants are document-scoped data, not a request to enroll
        // every source member in the destination workspace.
        for resource in graph
          .resources
          .iter()
          .filter(|resource| resource.resource.kind() == WorkspaceContentResourceKind::Document)
        {
          required_confirmations.insert(WorkspaceContentConfirmation::CopyDocumentAcl {
            resource: resource.resource.clone(),
          });
        }
      }
      WorkspaceContentOperationKind::ExtractFolder => {
        let state = state.as_ref().ok_or(WorkspaceContentAuthorizationError::InvalidState)?;
        let requested = options
          .extract_target_principal
          .as_ref()
          .ok_or(WorkspaceContentAuthorizationError::InvalidState)?;
        if requested != &state.source.owner_principal {
          blockers.insert(WorkspaceContentBlocker::OwnershipUnsupported);
        }
        extract_memberships = state.source.accepted_members.clone();
        extract_target_principal = Some(state.source.owner_principal.clone());
        if options.git_sync_plan.is_some()
          && !evaluation
            .source_effective_role
            .is_some_and(|role| role.can(WorkspaceAction::SettingsUpdate))
        {
          blockers.insert(WorkspaceContentBlocker::GitSyncManagementDenied);
        }
      }
      _ => {}
    }

    let required_confirmations = required_confirmations.into_iter().collect::<Vec<_>>();
    let blockers = blockers.into_iter().collect::<Vec<_>>();
    let revision = authorization_revision(
      actor_id,
      &graph,
      &options,
      &extract_target_principal,
      &required_confirmations,
    )?;
    let legacy_empty_revision = if options
      .overview
      .as_ref()
      .is_some_and(|overview| overview.affected_settings_empty(graph.kind, &mappings))
    {
      let mut legacy_options = options.clone();
      legacy_options.overview = None;
      Some(authorization_revision(
        actor_id,
        &graph,
        &legacy_options,
        &extract_target_principal,
        &required_confirmations,
      )?)
    } else {
      None
    };
    let revision = if let Some(overview) = &options.overview {
      overview.accepted_revision(&revision)
    } else {
      revision
    };
    Ok(WorkspaceContentAuthorizedPreflight {
      legacy_empty_revision,
      graph,
      membership_impacts,
      extract_memberships,
      extract_target_principal,
      git_sync_plan: options.git_sync_plan,
      required_confirmations,
      blockers,
      revision,
    })
  }

  async fn evaluate_permissions(
    &self,
    actor_id: UserId,
    graph: &WorkspaceContentPreflightGraph,
  ) -> Result<WorkspaceContentPermissionEvaluation, WorkspaceContentAuthorizationError> {
    let source_resource = WorkspaceResource {
      user_id: actor_id,
      workspace_id: graph.source_workspace_id,
    };
    let target_resource = WorkspaceResource {
      user_id: actor_id,
      workspace_id: graph.target_workspace_id,
    };
    let source_effective_role = self
      .permission
      .get_effective_workspace_role(actor_id, graph.source_workspace_id)
      .await?;
    // Extract delegates one workspace organization decision to the durable
    // operation. Document grants are transferred data, not actor prerequisites.
    if graph.kind == WorkspaceContentOperationKind::ExtractFolder {
      let allowed = source_effective_role.is_some_and(|role| role.can(WorkspaceAction::OrganizeUpdate));
      return Ok(WorkspaceContentPermissionEvaluation {
        source_effective_role,
        target_effective_role: None,
        transfer_allowed: allowed,
        source_allowed: allowed,
        target_allowed: true,
        checked_workspace_actions: vec![WorkspaceAction::OrganizeUpdate],
        document_decisions: Vec::new(),
      });
    }
    let target_effective_role = if graph.kind == WorkspaceContentOperationKind::ExtractFolder {
      None
    } else {
      self
        .permission
        .get_effective_workspace_role(actor_id, graph.target_workspace_id)
        .await?
    };

    // Move's Manager floor already grants source organization and document
    // access. Do not turn transferred document ACLs into actor prerequisites.
    let transfer_allowed = if graph.kind == WorkspaceContentOperationKind::Move {
      self
        .permission
        .can(&source_resource, WorkspaceAction::ContentTransfer)
        .await
    } else {
      true
    };
    let mut source_allowed = transfer_allowed;
    let mut document_decisions = Vec::new();
    let mut checked_workspace_actions = BTreeSet::new();

    for resource in &graph.resources {
      let workspace_action = match resource.resource.kind() {
        WorkspaceContentResourceKind::Database => Some(WorkspaceAction::Read),
        WorkspaceContentResourceKind::Collection => {
          return Err(
            AuthError::InvalidInput(WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str().into()).into(),
          );
        }
        WorkspaceContentResourceKind::Folder => Some(WorkspaceAction::Read),
        WorkspaceContentResourceKind::Tag => Some(WorkspaceAction::PropertiesRead),
        WorkspaceContentResourceKind::Blob => {
          if graph.roots.contains(&resource.resource) {
            source_allowed = false;
          }
          None
        }
        WorkspaceContentResourceKind::Document => None,
      };
      if let Some(action) = workspace_action
        && checked_workspace_actions.insert(action)
      {
        source_allowed &= self.permission.can(&source_resource, action).await;
      }
      if graph.kind != WorkspaceContentOperationKind::Move
        && resource.resource.kind() == WorkspaceContentResourceKind::Document
      {
        let doc_id = resource
          .permission_resource_id
          .ok_or(WorkspaceContentAuthorizationError::InvalidState)?;
        let action = if graph.kind == WorkspaceContentOperationKind::Copy {
          DocAction::Copy
        } else {
          DocAction::Read
        };
        let role = self
          .permission
          .get_effective_doc_role(actor_id, graph.source_workspace_id, doc_id)
          .await?;
        let allowed = role.can(action);
        source_allowed &= allowed;
        document_decisions.push(WorkspaceContentDocumentDecision {
          doc_id,
          action,
          role,
          allowed,
        });
      }
    }
    document_decisions.sort_by_key(|decision| decision.doc_id);

    let target_allowed = match graph.kind {
      // Extract has already returned its source-workspace organization decision.
      WorkspaceContentOperationKind::ExtractFolder => true,
      WorkspaceContentOperationKind::Link => self.permission.can(&target_resource, WorkspaceAction::CreateDoc).await,
      WorkspaceContentOperationKind::Move | WorkspaceContentOperationKind::Copy => {
        self.permission.can(&target_resource, WorkspaceAction::CreateDoc).await
      }
    };
    Ok(WorkspaceContentPermissionEvaluation {
      source_effective_role,
      target_effective_role,
      transfer_allowed,
      source_allowed,
      target_allowed,
      checked_workspace_actions: checked_workspace_actions.into_iter().collect(),
      document_decisions,
    })
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceContentDocumentDecision {
  doc_id: Uuid,
  action: DocAction,
  role: DocRole,
  allowed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceContentPermissionEvaluation {
  source_effective_role: Option<WorkspaceRole>,
  target_effective_role: Option<WorkspaceRole>,
  transfer_allowed: bool,
  source_allowed: bool,
  target_allowed: bool,
  checked_workspace_actions: Vec<WorkspaceAction>,
  document_decisions: Vec<WorkspaceContentDocumentDecision>,
}

fn validate_options(
  kind: WorkspaceContentOperationKind,
  options: &WorkspaceContentAuthorizationOptions,
) -> Result<(), WorkspaceContentAuthorizationError> {
  if (kind != WorkspaceContentOperationKind::Copy && options.copy_document_acl)
    || (kind == WorkspaceContentOperationKind::ExtractFolder) != options.extract_target_principal.is_some()
    || (kind != WorkspaceContentOperationKind::ExtractFolder
      && (options.git_sync_plan.is_some() || !options.git_sync_blockers.is_empty()))
  {
    return Err(WorkspaceContentAuthorizationError::InvalidState);
  }
  Ok(())
}

fn normalize_and_validate_state(
  graph: &WorkspaceContentPreflightGraph,
  state: &mut WorkspaceContentAuthorizationState,
) -> Result<(), WorkspaceContentAuthorizationError> {
  if state.source.workspace_id != graph.source_workspace_id
    || invalid_revision(&state.source.policy_revision)
    || invalid_revision(&state.document_acl_revision)
    || invalid_revision(&state.permission_revision)
  {
    return Err(WorkspaceContentAuthorizationError::InvalidState);
  }
  normalize_workspace_revision(&mut state.source)?;
  match graph.kind {
    WorkspaceContentOperationKind::ExtractFolder => {
      if state.target.is_some() {
        return Err(WorkspaceContentAuthorizationError::InvalidState);
      }
    }
    _ => {
      let target = state
        .target
        .as_mut()
        .ok_or(WorkspaceContentAuthorizationError::InvalidState)?;
      if target.workspace_id != graph.target_workspace_id || invalid_revision(&target.policy_revision) {
        return Err(WorkspaceContentAuthorizationError::InvalidState);
      }
      normalize_workspace_revision(target)?;
    }
  }
  Ok(())
}

fn normalize_workspace_revision(
  snapshot: &mut WorkspaceContentWorkspaceRevision,
) -> Result<(), WorkspaceContentAuthorizationError> {
  if snapshot.workspace_id.is_nil()
    || snapshot.owner_principal.principal_id.is_nil()
    || invalid_revision(&snapshot.policy_revision)
  {
    return Err(WorkspaceContentAuthorizationError::InvalidState);
  }
  snapshot.accepted_members.sort();
  if snapshot
    .accepted_members
    .windows(2)
    .any(|window| window[0].user_id == window[1].user_id)
    || snapshot
      .accepted_members
      .iter()
      .any(|member| member.user_id.is_nil() || member.role == WorkspaceRole::External)
  {
    return Err(WorkspaceContentAuthorizationError::InvalidState);
  }
  Ok(())
}

fn authorization_revision(
  actor_id: UserId,
  graph: &WorkspaceContentPreflightGraph,
  options: &WorkspaceContentAuthorizationOptions,
  extract_target_principal: &Option<WorkspaceContentOwnerPrincipal>,
  required_confirmations: &[WorkspaceContentConfirmation],
) -> Result<String, WorkspaceContentAuthorizationError> {
  if matches!(
    graph.kind,
    WorkspaceContentOperationKind::Move | WorkspaceContentOperationKind::ExtractFolder
  ) {
    // Preview binds the selected identities and unchanged owner, not mutable
    // content/permission snapshots. Execute captures the current source state.
    return serde_json::to_vec(&(
      super::REFERENCE_ADMISSION_VERSION,
      actor_id,
      graph.source_workspace_id,
      graph.target_workspace_id,
      &graph.selection_root_folder_id,
      &graph.roots,
      &graph.mappings,
      &graph.references,
      &graph.missing_resources,
      options,
      extract_target_principal,
      required_confirmations,
    ))
    .map(|bytes| hex::encode(Sha256::digest(bytes)))
    .map_err(|_| WorkspaceContentAuthorizationError::InvalidState);
  }
  // Copy/Link bind the content selection and explicit confirmations, not
  // unrelated workspace membership or policy revisions. Execute still checks
  // current canonical authority before queueing.
  serde_json::to_vec(&(actor_id, graph.kind, &graph.revision, options, required_confirmations))
    .map(|bytes| hex::encode(Sha256::digest(bytes)))
    .map_err(|_| WorkspaceContentAuthorizationError::InvalidState)
}

fn invalid_revision(value: &str) -> bool {
  value.is_empty()
    || value.len() > MAX_AUTHORIZATION_REVISION_BYTES
    || value.trim() != value
    || value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
  use std::sync::Mutex;

  use myoxus_domain::entities::{MembershipStatus, WorkspaceRole};
  use myoxus_domain::workspace_content_operation::WorkspaceContentResourceRef;

  use super::*;
  use crate::auth::{AuthUser, InMemoryAuthStore};
  use crate::organizer::{OrganizerRow, OrganizerSnapshot, OrganizerSnapshotNode};
  use crate::workspace::WorkspaceStore;
  use crate::workspace_content_operation::preflight::{
    WorkspaceContentGraphBuilder, WorkspaceContentGraphInput, WorkspaceContentGraphResource, WorkspaceContentSelection,
  };

  #[derive(Clone)]
  struct MemoryAuthorizationSource {
    state: Arc<Mutex<WorkspaceContentAuthorizationState>>,
  }

  #[async_trait]
  impl WorkspaceContentAuthorizationSource for MemoryAuthorizationSource {
    async fn load_authorization_state(
      &self,
      _graph: &WorkspaceContentPreflightGraph,
      _include_copy_acl: bool,
    ) -> AuthResult<WorkspaceContentAuthorizationState> {
      Ok(self.state.lock().expect("authorization state lock").clone())
    }
  }

  fn user(id: Uuid) -> AuthUser {
    AuthUser {
      id,
      email: format!("{id}@example.test"),
      name: Some("XWS actor".to_string()),
      avatar_url: None,
      password_hash: None,
      is_admin: false,
      disabled: false,
      email_verified_at: None,
      registered: true,
    }
  }

  async fn permissions(
    actor_id: Uuid,
    source_workspace_id: Uuid,
    source_role: WorkspaceRole,
    target_workspace_id: Uuid,
    target_role: Option<WorkspaceRole>,
  ) -> Arc<PermissionService> {
    let store = Arc::new(InMemoryAuthStore::default());
    store.insert_user(user(actor_id));
    if source_role != WorkspaceRole::External {
      WorkspaceStore::add_or_update_member(
        store.as_ref(),
        source_workspace_id,
        actor_id,
        source_role,
        MembershipStatus::Accepted,
        None,
      )
      .await
      .unwrap();
    }
    if let Some(role) = target_role.filter(|role| *role != WorkspaceRole::External) {
      WorkspaceStore::add_or_update_member(
        store.as_ref(),
        target_workspace_id,
        actor_id,
        role,
        MembershipStatus::Accepted,
        None,
      )
      .await
      .unwrap();
    }
    Arc::new(PermissionService::new(store))
  }

  fn graph(
    kind: WorkspaceContentOperationKind,
    source_workspace_id: Uuid,
    target_workspace_id: Uuid,
    resource_kind: WorkspaceContentResourceKind,
    publicly_shared: bool,
  ) -> WorkspaceContentPreflightGraph {
    let resource_id = match resource_kind {
      WorkspaceContentResourceKind::Document => "document-key".to_string(),
      _ => Uuid::new_v5(&source_workspace_id, resource_kind.as_str().as_bytes()).to_string(),
    };
    let permission_resource_id = (resource_kind == WorkspaceContentResourceKind::Document)
      .then(|| Uuid::new_v5(&source_workspace_id, b"document-acl"));
    let relation = match resource_kind {
      WorkspaceContentResourceKind::Document => "docs",
      WorkspaceContentResourceKind::Folder => "doc_updates",
      _ => "workspace_databases",
    };
    let resource = WorkspaceContentGraphResource {
      database_system_role: None,
      resource: WorkspaceContentResourceRef::new(source_workspace_id, resource_kind, resource_id).unwrap(),
      permission_resource_id,
      revision: "content-revision".to_string(),
      display_name: Some("Resource".to_string()),
      schema_revision: None,
      persistence_relations: vec![relation.to_string()],
      publicly_shared,
      tag_archived: false,
    };
    let selection = if kind == WorkspaceContentOperationKind::ExtractFolder {
      WorkspaceContentSelection::FolderSubtree {
        organizer: OrganizerSnapshot {
          workspace_id: source_workspace_id,
          revision: "organizer-revision".to_string(),
          roots: vec![OrganizerSnapshotNode {
            row: OrganizerRow {
              id: resource.resource.resource_id().to_string(),
              parent_id: None,
              index: "a0".to_string(),
              row_type: "folder".to_string(),
              data: resource.resource.resource_id().to_string(),
              target_workspace_id: None,
            },
            children: Vec::new(),
          }],
        },
        folder_id: resource.resource.resource_id().to_string(),
      }
    } else {
      WorkspaceContentSelection::Resources(vec![resource.resource.clone()])
    };
    WorkspaceContentGraphBuilder
      .build(WorkspaceContentGraphInput {
        operation_id: Uuid::nil(),
        kind,
        source_workspace_id,
        target_workspace_id,
        selection,
        resources: vec![resource],
        references: Vec::new(),
        target_definitions: Vec::new(),
        target_resource_ids: Vec::new(),
        mapping_overrides: Vec::new(),
      })
      .unwrap()
  }

  fn principal(principal_id: Uuid) -> WorkspaceContentOwnerPrincipal {
    WorkspaceContentOwnerPrincipal {
      principal_type: OwnerPrincipalType::User,
      principal_id,
    }
  }

  fn workspace_revision(
    workspace_id: Uuid,
    owner: WorkspaceContentOwnerPrincipal,
    members: Vec<WorkspaceContentMemberRevision>,
  ) -> WorkspaceContentWorkspaceRevision {
    WorkspaceContentWorkspaceRevision {
      workspace_id,
      owner_principal: owner,
      policy_revision: format!("policy-{workspace_id}"),
      accepted_members: members,
    }
  }

  fn state(
    actor_id: Uuid,
    source_workspace_id: Uuid,
    target_workspace_id: Option<Uuid>,
    source_role: WorkspaceRole,
    target_role: Option<WorkspaceRole>,
  ) -> WorkspaceContentAuthorizationState {
    WorkspaceContentAuthorizationState {
      source: workspace_revision(
        source_workspace_id,
        principal(actor_id),
        vec![WorkspaceContentMemberRevision {
          user_id: actor_id,
          role: source_role,
        }],
      ),
      target: target_workspace_id.map(|workspace_id| {
        workspace_revision(
          workspace_id,
          principal(Uuid::new_v5(&workspace_id, b"owner")),
          target_role
            .map(|role| {
              vec![WorkspaceContentMemberRevision {
                user_id: actor_id,
                role,
              }]
            })
            .unwrap_or_default(),
        )
      }),
      document_acl_revision: "document-acl-revision".to_string(),
      permission_revision: "permission-revision".to_string(),
    }
  }

  #[tokio::test]
  async fn move_applies_public_policy_without_confirmations_or_unrelated_permission_fences() {
    let actor_id = Uuid::new_v4();
    let source_workspace_id = Uuid::new_v4();
    let target_workspace_id = Uuid::new_v4();
    let added_user_id = Uuid::new_v4();
    let graph = graph(
      WorkspaceContentOperationKind::Move,
      source_workspace_id,
      target_workspace_id,
      WorkspaceContentResourceKind::Document,
      true,
    );
    let mut authorization_state = state(
      actor_id,
      source_workspace_id,
      Some(target_workspace_id),
      WorkspaceRole::Admin,
      Some(WorkspaceRole::Owner),
    );
    authorization_state
      .source
      .accepted_members
      .push(WorkspaceContentMemberRevision {
        user_id: added_user_id,
        role: WorkspaceRole::Admin,
      });
    let state = Arc::new(Mutex::new(authorization_state));
    let source = MemoryAuthorizationSource { state: state.clone() };
    let authorizer = WorkspaceContentAuthorizer::new(
      permissions(
        actor_id,
        source_workspace_id,
        WorkspaceRole::Admin,
        target_workspace_id,
        Some(WorkspaceRole::Owner),
      )
      .await,
      source,
    );
    let preview = authorizer
      .preflight(actor_id, graph.clone(), WorkspaceContentAuthorizationOptions::default())
      .await
      .unwrap();
    assert!(preview.blockers.is_empty());
    assert!(preview.membership_impacts.is_empty());
    assert!(preview.required_confirmations.is_empty());
    state.lock().unwrap().permission_revision = "permission-revision-2".to_string();
    let refreshed = authorizer
      .preflight(actor_id, graph, WorkspaceContentAuthorizationOptions::default())
      .await
      .expect("rebuild changed Move preflight");
    assert_eq!(refreshed.revision, preview.revision);
  }

  #[tokio::test]
  async fn manager_can_move_and_copy_acl_without_enrolling_source_admins() {
    let actor_id = Uuid::new_v4();
    let source_workspace_id = Uuid::new_v4();
    let target_workspace_id = Uuid::new_v4();
    let added_user_id = Uuid::new_v4();
    let mut authorization_state = state(
      actor_id,
      source_workspace_id,
      Some(target_workspace_id),
      WorkspaceRole::Manager,
      Some(WorkspaceRole::Manager),
    );
    authorization_state
      .source
      .accepted_members
      .push(WorkspaceContentMemberRevision {
        user_id: added_user_id,
        role: WorkspaceRole::Admin,
      });
    let source = MemoryAuthorizationSource {
      state: Arc::new(Mutex::new(authorization_state)),
    };
    let move_graph = graph(
      WorkspaceContentOperationKind::Move,
      source_workspace_id,
      target_workspace_id,
      WorkspaceContentResourceKind::Document,
      false,
    );
    let authorizer = WorkspaceContentAuthorizer::new(
      permissions(
        actor_id,
        source_workspace_id,
        WorkspaceRole::Manager,
        target_workspace_id,
        Some(WorkspaceRole::Manager),
      )
      .await,
      source,
    );

    let move_preview = authorizer
      .preflight(actor_id, move_graph, WorkspaceContentAuthorizationOptions::default())
      .await
      .unwrap();
    assert!(move_preview.blockers.is_empty());
    assert!(move_preview.membership_impacts.is_empty());
    assert!(move_preview.required_confirmations.is_empty());

    let copy_graph = graph(
      WorkspaceContentOperationKind::Copy,
      source_workspace_id,
      target_workspace_id,
      WorkspaceContentResourceKind::Document,
      false,
    );
    let copy_preview = authorizer
      .preflight(
        actor_id,
        copy_graph.clone(),
        WorkspaceContentAuthorizationOptions::default(),
      )
      .await
      .unwrap();
    assert!(copy_preview.blockers.is_empty());
    assert!(copy_preview.required_confirmations.is_empty());

    let copy_acl_preview = authorizer
      .preflight(
        actor_id,
        copy_graph,
        WorkspaceContentAuthorizationOptions {
          overview: None,
          copy_document_acl: true,
          extract_target_principal: None,
          ..Default::default()
        },
      )
      .await
      .unwrap();
    assert!(copy_acl_preview.blockers.is_empty());
    assert!(copy_acl_preview.membership_impacts.is_empty());
    assert_eq!(
      copy_acl_preview.required_confirmations.len(),
      1,
      "copying document ACLs remains an explicit user decision"
    );
  }

  #[tokio::test]
  async fn operation_role_matrix_uses_only_the_canonical_workspace_capabilities() {
    let cases = [
      (WorkspaceContentOperationKind::Link, WorkspaceRole::External, false),
      (WorkspaceContentOperationKind::Link, WorkspaceRole::Collaborator, true),
      (WorkspaceContentOperationKind::Link, WorkspaceRole::Manager, true),
      (WorkspaceContentOperationKind::Link, WorkspaceRole::Admin, true),
      (WorkspaceContentOperationKind::Link, WorkspaceRole::Owner, true),
      (WorkspaceContentOperationKind::Copy, WorkspaceRole::External, false),
      (WorkspaceContentOperationKind::Copy, WorkspaceRole::Collaborator, true),
      (WorkspaceContentOperationKind::Copy, WorkspaceRole::Manager, true),
      (WorkspaceContentOperationKind::Copy, WorkspaceRole::Admin, true),
      (WorkspaceContentOperationKind::Copy, WorkspaceRole::Owner, true),
      (WorkspaceContentOperationKind::Move, WorkspaceRole::External, false),
      (WorkspaceContentOperationKind::Move, WorkspaceRole::Manager, true),
      (WorkspaceContentOperationKind::Move, WorkspaceRole::Admin, true),
      (WorkspaceContentOperationKind::Move, WorkspaceRole::Owner, true),
      (
        WorkspaceContentOperationKind::ExtractFolder,
        WorkspaceRole::External,
        false,
      ),
      (
        WorkspaceContentOperationKind::ExtractFolder,
        WorkspaceRole::Manager,
        true,
      ),
      (WorkspaceContentOperationKind::ExtractFolder, WorkspaceRole::Admin, true),
      (WorkspaceContentOperationKind::ExtractFolder, WorkspaceRole::Owner, true),
    ];

    for (kind, role, allowed) in cases {
      let actor_id = Uuid::new_v4();
      let source_workspace_id = Uuid::new_v4();
      let target_workspace_id = Uuid::new_v4();
      let target_role = (kind != WorkspaceContentOperationKind::ExtractFolder).then_some(role);
      let mut authorization_state = state(
        actor_id,
        source_workspace_id,
        target_role.map(|_| target_workspace_id),
        role,
        target_role,
      );
      if role == WorkspaceRole::External {
        authorization_state.source.accepted_members.clear();
        if let Some(target) = authorization_state.target.as_mut() {
          target.accepted_members.clear();
        }
      }
      let authorizer = WorkspaceContentAuthorizer::new(
        permissions(actor_id, source_workspace_id, role, target_workspace_id, target_role).await,
        MemoryAuthorizationSource {
          state: Arc::new(Mutex::new(authorization_state)),
        },
      );
      let resource_kind = if kind == WorkspaceContentOperationKind::ExtractFolder {
        WorkspaceContentResourceKind::Folder
      } else {
        WorkspaceContentResourceKind::Document
      };
      let options = WorkspaceContentAuthorizationOptions {
        overview: None,
        copy_document_acl: false,
        extract_target_principal: (kind == WorkspaceContentOperationKind::ExtractFolder).then(|| principal(actor_id)),
        ..Default::default()
      };

      let preview = authorizer
        .preflight(
          actor_id,
          graph(kind, source_workspace_id, target_workspace_id, resource_kind, false),
          options,
        )
        .await
        .unwrap_or_else(|error| panic!("{kind:?} preflight failed for {role:?}: {error:?}"));

      assert_eq!(
        preview.blockers.is_empty(),
        allowed,
        "{kind:?} permission result changed for {role:?}: {:?}",
        preview.blockers
      );
    }
  }

  #[tokio::test]
  async fn copy_and_link_need_only_source_read_and_destination_write() {
    for kind in [WorkspaceContentOperationKind::Copy, WorkspaceContentOperationKind::Link] {
      for (source_role, target_role, allowed) in [
        (WorkspaceRole::Reader, WorkspaceRole::Collaborator, true),
        (WorkspaceRole::External, WorkspaceRole::Collaborator, false),
        (WorkspaceRole::Reader, WorkspaceRole::Reader, false),
      ] {
        let actor = Uuid::new_v4();
        let source_id = Uuid::new_v4();
        let target_id = Uuid::new_v4();
        let authorizer = WorkspaceContentAuthorizer::new(
          permissions(actor, source_id, source_role, target_id, Some(target_role)).await,
          MemoryAuthorizationSource {
            state: Arc::new(Mutex::new(state(
              actor,
              source_id,
              Some(target_id),
              source_role,
              Some(target_role),
            ))),
          },
        );
        let preview = authorizer
          .preflight(
            actor,
            graph(
              kind,
              source_id,
              target_id,
              WorkspaceContentResourceKind::Document,
              false,
            ),
            WorkspaceContentAuthorizationOptions::default(),
          )
          .await
          .unwrap();
        assert_eq!(
          preview.blockers.is_empty(),
          allowed,
          "{kind:?}: {source_role:?} -> {target_role:?}"
        );
        assert!(preview.membership_impacts.is_empty());
      }
    }
  }

  #[tokio::test]
  async fn collection_ownership_is_unsupported_even_with_copy_capabilities() {
    let actor = Uuid::new_v4();
    let source_id = Uuid::new_v4();
    let target_id = Uuid::new_v4();
    let authorizer = WorkspaceContentAuthorizer::new(
      permissions(
        actor,
        source_id,
        WorkspaceRole::Reader,
        target_id,
        Some(WorkspaceRole::Collaborator),
      )
      .await,
      MemoryAuthorizationSource {
        state: Arc::new(Mutex::new(state(
          actor,
          source_id,
          Some(target_id),
          WorkspaceRole::Reader,
          Some(WorkspaceRole::Collaborator),
        ))),
      },
    );
    let mut graph = graph(
      WorkspaceContentOperationKind::Copy,
      source_id,
      target_id,
      WorkspaceContentResourceKind::Document,
      false,
    );
    // Persisted historical graphs can predate the fresh-selection rejection.
    let old_source = graph.mappings[0].mapping.source.clone();
    let old_target = graph.mappings[0].mapping.target.clone();
    graph.resources[0].resource = WorkspaceContentResourceRef::new(
      source_id,
      WorkspaceContentResourceKind::Collection,
      old_source.resource_id(),
    )
    .unwrap();
    graph.mappings[0].mapping = myoxus_domain::workspace_content_operation::WorkspaceContentIdMapping::new(
      graph.resources[0].resource.clone(),
      WorkspaceContentResourceRef::new(
        target_id,
        WorkspaceContentResourceKind::Collection,
        old_target.resource_id(),
      )
      .unwrap(),
    )
    .unwrap();
    for action in [
      super::super::preflight::WorkspaceContentMappingAction::Create,
      super::super::preflight::WorkspaceContentMappingAction::Reuse,
    ] {
      graph.mappings[0].action = action;
      assert!(
        matches!(authorizer.preflight(actor, graph.clone(), WorkspaceContentAuthorizationOptions::default()).await,
        Err(WorkspaceContentAuthorizationError::Authorization(AuthError::InvalidInput(code))) if code == WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str())
      );
    }
  }

  #[tokio::test]
  async fn move_uses_transfer_on_source_and_create_doc_on_target() {
    let actor_id = Uuid::new_v4();
    let source_workspace_id = Uuid::new_v4();
    let target_workspace_id = Uuid::new_v4();
    let graph = graph(
      WorkspaceContentOperationKind::Move,
      source_workspace_id,
      target_workspace_id,
      WorkspaceContentResourceKind::Document,
      false,
    );

    for (target_role, allowed) in [(WorkspaceRole::Collaborator, true), (WorkspaceRole::Reader, false)] {
      let authorizer = WorkspaceContentAuthorizer::new(
        permissions(
          actor_id,
          source_workspace_id,
          WorkspaceRole::Admin,
          target_workspace_id,
          Some(target_role),
        )
        .await,
        MemoryAuthorizationSource {
          state: Arc::new(Mutex::new(state(
            actor_id,
            source_workspace_id,
            Some(target_workspace_id),
            WorkspaceRole::Admin,
            Some(target_role),
          ))),
        },
      );

      let preview = authorizer
        .preflight(actor_id, graph.clone(), WorkspaceContentAuthorizationOptions::default())
        .await
        .expect("build asymmetric Move permission preflight");
      assert_eq!(
        preview.blockers.is_empty(),
        allowed,
        "target role {target_role:?} did not follow CreateDoc"
      );
    }
  }

  #[tokio::test]
  async fn move_does_not_enroll_or_block_on_the_source_owner() {
    let actor_id = Uuid::new_v4();
    let owner_id = Uuid::new_v4();
    let source_workspace_id = Uuid::new_v4();
    let target_workspace_id = Uuid::new_v4();
    let graph = graph(
      WorkspaceContentOperationKind::Move,
      source_workspace_id,
      target_workspace_id,
      WorkspaceContentResourceKind::Document,
      false,
    );
    let mut authorization_state = state(
      actor_id,
      source_workspace_id,
      Some(target_workspace_id),
      WorkspaceRole::Admin,
      Some(WorkspaceRole::Owner),
    );
    authorization_state
      .source
      .accepted_members
      .push(WorkspaceContentMemberRevision {
        user_id: owner_id,
        role: WorkspaceRole::Owner,
      });
    let authorizer = WorkspaceContentAuthorizer::new(
      permissions(
        actor_id,
        source_workspace_id,
        WorkspaceRole::Admin,
        target_workspace_id,
        Some(WorkspaceRole::Owner),
      )
      .await,
      MemoryAuthorizationSource {
        state: Arc::new(Mutex::new(authorization_state)),
      },
    );

    let preview = authorizer
      .preflight(actor_id, graph, WorkspaceContentAuthorizationOptions::default())
      .await
      .unwrap();
    assert!(preview.blockers.is_empty());
    assert!(preview.membership_impacts.is_empty());
    assert!(preview.required_confirmations.is_empty());
  }

  #[tokio::test]
  async fn extract_binds_scope_and_owner_but_captures_current_memberships() {
    let actor_id = Uuid::new_v4();
    let reader_id = Uuid::new_v4();
    let source_workspace_id = Uuid::new_v4();
    let target_workspace_id = Uuid::new_v4();
    let mut authorization_state = state(actor_id, source_workspace_id, None, WorkspaceRole::Owner, None);
    authorization_state
      .source
      .accepted_members
      .push(WorkspaceContentMemberRevision {
        user_id: reader_id,
        role: WorkspaceRole::Reader,
      });
    let state = Arc::new(Mutex::new(authorization_state));
    let source = MemoryAuthorizationSource { state: state.clone() };
    let authorizer = WorkspaceContentAuthorizer::new(
      permissions(
        actor_id,
        source_workspace_id,
        WorkspaceRole::Owner,
        target_workspace_id,
        None,
      )
      .await,
      source,
    );
    let graph = graph(
      WorkspaceContentOperationKind::ExtractFolder,
      source_workspace_id,
      target_workspace_id,
      WorkspaceContentResourceKind::Folder,
      false,
    );
    let options = WorkspaceContentAuthorizationOptions {
      overview: None,
      copy_document_acl: false,
      extract_target_principal: Some(principal(actor_id)),
      ..Default::default()
    };
    let preview = authorizer
      .preflight(actor_id, graph.clone(), options.clone())
      .await
      .unwrap();
    assert!(preview.blockers.is_empty());
    assert_eq!(preview.extract_memberships.len(), 2);
    let git_preview = authorizer
      .preflight(
        actor_id,
        graph.clone(),
        WorkspaceContentAuthorizationOptions {
          git_sync_plan: Some(super::super::WorkspaceContentGitSyncPlan {
            undo: None,
            target_configuration: None,
            choice: super::super::WorkspaceContentGitSyncChoice::Move,
            source_profile_id: Uuid::new_v4(),
            source_profile_owner_id: actor_id,
            source_profile_updated_at: chrono::Utc::now(),
            source_scope_revision: 0,
            direction: myoxus_domain::git_sync::SyncDirection::Bidirectional,
            trigger: myoxus_domain::git_sync::TriggerMode::Manual,
            intended_enabled: true,
            repository: "file:///repo".into(),
            branch: "main".into(),
            source_root: "content".into(),
            source_manifest: ".myoxus/git-sync-manifest.json".into(),
            target_root: "content/folder".into(),
            target_manifest: "content/folder/.myoxus/git-sync-manifest.json".into(),
            remote_oid: None,
            observed_hashes: Default::default(),
            manifest_inventory: None,
            documents: Vec::new(),
            files: Vec::new(),
            shared_files: Vec::new(),
            delegated_descendants: Vec::new(),
          }),
          ..options.clone()
        },
      )
      .await
      .unwrap();
    assert!(git_preview.blockers.is_empty());
    assert_ne!(git_preview.revision, preview.revision);
    let wrong_principal_preview = authorizer
      .preflight(
        actor_id,
        graph.clone(),
        WorkspaceContentAuthorizationOptions {
          overview: None,
          copy_document_acl: false,
          extract_target_principal: Some(principal(Uuid::new_v4())),
          ..Default::default()
        },
      )
      .await
      .unwrap();
    assert_eq!(
      wrong_principal_preview.blockers,
      vec![WorkspaceContentBlocker::OwnershipUnsupported]
    );
    state
      .lock()
      .unwrap()
      .source
      .accepted_members
      .iter_mut()
      .find(|member| member.user_id == reader_id)
      .unwrap()
      .role = WorkspaceRole::Manager;
    let refreshed = authorizer
      .preflight(actor_id, graph, options)
      .await
      .expect("rebuild changed Extract preflight");
    assert_eq!(refreshed.revision, preview.revision);
    assert!(
      refreshed
        .extract_memberships
        .iter()
        .any(|member| member.user_id == reader_id && member.role == WorkspaceRole::Manager)
    );
    {
      let mut changed = state.lock().unwrap();
      changed.document_acl_revision = "changed-acl".to_string();
      changed.permission_revision = "changed-permissions".to_string();
      changed.source.policy_revision = "changed-policy".to_string();
    }
    let mut content_changed = preview.graph.clone();
    content_changed.revision = "changed-content".to_string();
    let current = authorizer
      .preflight(
        actor_id,
        content_changed,
        WorkspaceContentAuthorizationOptions {
          overview: None,
          copy_document_acl: false,
          extract_target_principal: Some(principal(actor_id)),
          ..Default::default()
        },
      )
      .await
      .unwrap();
    assert_eq!(current.revision, preview.revision);
  }
  #[tokio::test]
  async fn folder_plans_bind_overview_revisions_and_bound_legacy_empty_settings() {
    use super::super::overview::{
      OVERVIEW_PREVIEW_PREFIX, WorkspaceContentOverviewSnapshot, WorkspaceContentOverviewState,
    };
    use myoxus_domain::workspace_content_operation::WorkspaceContentResourceRef;
    use myoxus_domain::workspace_overview::{
      FolderOverviewSettings, OverviewOrderBy, OverviewRegisterPresentation, WorkspaceOverviewSettings,
    };
    for kind in [
      WorkspaceContentOperationKind::Copy,
      WorkspaceContentOperationKind::Move,
      WorkspaceContentOperationKind::ExtractFolder,
    ] {
      let actor = Uuid::new_v4();
      let source = Uuid::new_v4();
      let target = Uuid::new_v4();
      let target_role = (kind != WorkspaceContentOperationKind::ExtractFolder).then_some(WorkspaceRole::Owner);
      let authorizer = WorkspaceContentAuthorizer::new(
        permissions(actor, source, WorkspaceRole::Owner, target, target_role).await,
        MemoryAuthorizationSource {
          state: Arc::new(Mutex::new(state(
            actor,
            source,
            target_role.map(|_| target),
            WorkspaceRole::Owner,
            target_role,
          ))),
        },
      );
      let graph = graph(kind, source, target, WorkspaceContentResourceKind::Folder, false);
      let folder = graph
        .mappings
        .iter()
        .find(|planned| planned.mapping.source.kind() == WorkspaceContentResourceKind::Folder)
        .unwrap()
        .mapping
        .source
        .resource_id()
        .to_owned();
      let mut options = WorkspaceContentAuthorizationOptions {
        overview: None,
        copy_document_acl: false,
        extract_target_principal: (kind == WorkspaceContentOperationKind::ExtractFolder).then(|| principal(actor)),
        ..Default::default()
      };
      let legacy = authorizer
        .preflight(actor, graph.clone(), options.clone())
        .await
        .unwrap();
      options.overview = Some(WorkspaceContentOverviewSnapshot {
        source: WorkspaceContentOverviewState {
          workspace_id: source,
          revision: 0,
          settings: WorkspaceOverviewSettings::default(),
        },
        target: target_role.map(|_| WorkspaceContentOverviewState {
          workspace_id: target,
          revision: 0,
          settings: WorkspaceOverviewSettings::default(),
        }),
        extracted_folder_id: graph.selection_root_folder_id.clone(),
      });
      let aware = authorizer
        .preflight(actor, graph.clone(), options.clone())
        .await
        .unwrap();
      assert!(aware.revision.starts_with(OVERVIEW_PREVIEW_PREFIX));
      assert!(
        aware.clone().bind_accepted_revision(&legacy.revision),
        "empty deployed plans remain executable"
      );
      options.overview.as_mut().unwrap().source.revision += 1;
      let mut changed = authorizer
        .preflight(actor, graph.clone(), options.clone())
        .await
        .unwrap();
      assert!(
        !changed.bind_accepted_revision(&aware.revision),
        "current previews bind the exact native source revision"
      );
      if options.overview.as_ref().unwrap().target.is_some() {
        options.overview.as_mut().unwrap().source.revision = 0;
        // The target row is an independent optimistic-concurrency boundary.
        options.overview.as_mut().unwrap().target.as_mut().unwrap().revision += 1;
        let mut changed = authorizer
          .preflight(actor, graph.clone(), options.clone())
          .await
          .unwrap();
        assert!(
          !changed.bind_accepted_revision(&aware.revision),
          "current previews bind the target revision too"
        );
      }
      options.overview.as_mut().unwrap().source.settings.folders.insert(
        folder,
        FolderOverviewSettings {
          introduction: Some(
            WorkspaceContentResourceRef::new(source, WorkspaceContentResourceKind::Document, "unmapped-introduction")
              .unwrap(),
          ),
          register_presentation: None,
        },
      );
      let mut configured = authorizer
        .preflight(actor, graph.clone(), options.clone())
        .await
        .unwrap();
      assert!(
        !configured.bind_accepted_revision(&legacy.revision),
        "a deployed plan cannot silently absorb a new binding"
      );
      if kind == WorkspaceContentOperationKind::ExtractFolder {
        let source = &mut options.overview.as_mut().unwrap().source;
        source.settings.folders.clear();
        source.settings.register_presentation = Some(OverviewRegisterPresentation {
          display_properties: vec!["system:title".into()],
          order_by: OverviewOrderBy {
            property_type: "system".into(),
            key: "title".into(),
            desc: false,
          },
        });
        let mut inherited = authorizer.preflight(actor, graph, options).await.unwrap();
        assert!(
          !inherited.bind_accepted_revision(&legacy.revision),
          "Extract also owns the effective presentation it promotes"
        );
      }
    }
  }
}
