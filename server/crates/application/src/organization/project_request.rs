//! Project-creation request workflow.
//!
//! Encapsulates the three-state project-creation Pfad
//! (`Allowed`/`RequiresApproval`/`Denied`) so resolvers and CLI commands
//! never re-implement the branching themselves
//! (Learning `LRN-20260502-ORG-A-04`).
//!
//! - `Allowed` → caller proceeds with a direct insert (out of scope for
//!   this service; the resolver wires up the project + optional workspace
//!   itself).
//! - `RequiresApproval` → this service inserts a row in
//!   `organization_project_request` with status `pending`.
//! - `Denied` → returns a `ProjectRequestOutcome::Denied` for the caller
//!   to surface as `PolicyViolation`.

use std::sync::Arc;

use chrono::Utc;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use myoxus_domain::entities::{OrganizationProjectRequest, ProjectRequestScope, ProjectRequestStatus};
use myoxus_domain::ids::{
  OrganizationId, OrganizationProjectRequestId, OrganizationUnitId, OrganizationUnitTypeId, UserId,
};
use myoxus_domain::repositories::{OrganizationProjectRequestRepository, RepoResult};

use super::permission::{OrganizationPermissionService, ProjectCreationDecision, ProjectCreationScope};

/// Outcome of `ProjectRequestService::request_creation`. The caller
/// branches on the variant; `Allowed` does NOT do the actual project
/// insert (that's the caller's responsibility), it merely confirms the
/// caller may proceed.
#[derive(Debug, Clone)]
pub enum ProjectRequestOutcome {
  /// Caller may proceed with direct project creation.
  AllowedDirect,
  /// A pending request was filed; admin decision is awaited.
  PendingApproval(OrganizationProjectRequestId),
  /// Policy denies the request entirely.
  Denied,
}

/// Application service that orchestrates the policy-driven project flow.
#[derive(Clone)]
pub struct ProjectRequestService {
  requests: Arc<dyn OrganizationProjectRequestRepository>,
  permissions: Arc<OrganizationPermissionService>,
}

impl ProjectRequestService {
  pub fn new(
    requests: Arc<dyn OrganizationProjectRequestRepository>,
    permissions: Arc<OrganizationPermissionService>,
  ) -> Self {
    Self { requests, permissions }
  }

  /// Drives a manager's project-creation through the policy gate.
  ///
  /// Returns the outcome the caller should react to; on
  /// `PendingApproval`, the row is already persisted with status
  /// `pending`.
  #[instrument(skip_all, fields(user=%input.requested_by, org=%input.organization_id))]
  pub async fn request_creation(&self, input: CreateProjectRequestInput) -> RepoResult<ProjectRequestOutcome> {
    let scope = match input.parent_unit_id {
      Some(uid) => ProjectCreationScope::Ou(uid),
      None => ProjectCreationScope::OrganizationRoot,
    };
    let decision = self
      .permissions
      .can_create_project_in_scope(input.requested_by, input.organization_id, scope)
      .await?;

    match decision {
      ProjectCreationDecision::Allowed => {
        info!(
          scope = ?scope,
          "project creation policy=Allowed — caller may insert directly"
        );
        Ok(ProjectRequestOutcome::AllowedDirect)
      }
      ProjectCreationDecision::RequiresApproval => {
        let request_scope = if input.parent_unit_id.is_some() {
          ProjectRequestScope::Ou
        } else {
          ProjectRequestScope::OrganizationRoot
        };
        let now = Utc::now();
        let mut row = OrganizationProjectRequest {
          id: Uuid::new_v4(),
          organization_id: input.organization_id,
          requested_by: input.requested_by,
          requested_scope: request_scope,
          parent_unit_id: input.parent_unit_id,
          proposed_name: input.proposed_name,
          proposed_type_id: input.proposed_type_id,
          proposed_members: input.proposed_members,
          proposed_workspace: input.proposed_workspace,
          status: ProjectRequestStatus::Pending,
          decided_by: None,
          decided_at: None,
          metadata: input.metadata,
          created_at: now,
          updated_at: now,
        };
        let saved = self.requests.create(&row).await?;
        // Re-stamp from persisted row in case DB altered defaults.
        row = saved;
        info!(
          request_id = %row.id,
          scope = ?scope,
          "project creation policy=RequiresApproval — request filed"
        );
        Ok(ProjectRequestOutcome::PendingApproval(row.id))
      }
      ProjectCreationDecision::Denied => {
        warn!(scope = ?scope, "project creation policy=Denied — refusing");
        Ok(ProjectRequestOutcome::Denied)
      }
    }
  }

  /// Admin decision on a request.
  ///
  /// `Approve` and `Reject` are the only legal transitions from
  /// `Pending`; the requestor may also call `Cancel`. Implementations of
  /// `OrganizationProjectRequestRepository::decide` enforce the
  /// transition matrix.
  #[instrument(skip(self))]
  pub async fn decide(
    &self,
    id: OrganizationProjectRequestId,
    new_status: ProjectRequestStatus,
    decider: UserId,
  ) -> RepoResult<()> {
    self.requests.decide(id, new_status, decider).await
  }
}

/// Input for `ProjectRequestService::request_creation`.
#[derive(Debug, Clone)]
pub struct CreateProjectRequestInput {
  pub organization_id: OrganizationId,
  pub requested_by: UserId,
  pub parent_unit_id: Option<OrganizationUnitId>,
  pub proposed_name: String,
  pub proposed_type_id: Option<OrganizationUnitTypeId>,
  pub proposed_members: Vec<UserId>,
  pub proposed_workspace: bool,
  pub metadata: serde_json::Value,
}
