// SPDX-License-Identifier: AGPL-3.0-or-later
//! Lifecycle-isolated target creation for Folder Extract.
//!
//! The service validates the complete authorized preflight before delegating
//! one atomic SQL mutation. It does not publish content: canonical resources
//! remain in the source Workspace until the Extract publication boundary.

use myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode;
use std::sync::Arc;

use async_trait::async_trait;
use myoxus_domain::entities::{OwnerPrincipalType, WorkspaceRole};
use myoxus_domain::ids::{WorkspaceContentOperationId, WorkspaceId};
use myoxus_domain::workspace_content_operation::{
  RedactedWorkspaceContentError, WorkspaceContentOperationKind, WorkspaceContentOperationRecord,
  WorkspaceContentOperationStatus, WorkspaceContentResourceKind,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::authorization::{
  WorkspaceContentAuthorizedPreflight, WorkspaceContentMemberRevision, WorkspaceContentOwnerPrincipal,
};
use crate::auth::{AuthError, AuthResult};
use crate::ports::BlobStoragePort;
use crate::workspace::WorkspaceName;

use super::WorkspaceContentStagingManifestRepository;
use super::worker::WorkspaceContentSemanticRecovery;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentExtractAclPlan {
  pub document_id: Uuid,
  pub source_workspace_id: WorkspaceId,
  pub target_workspace_id: WorkspaceId,
  pub permission_revision: String,
}

#[derive(Debug, Clone)]
pub struct WorkspaceContentExtractTargetRequest {
  pub operation: WorkspaceContentOperationRecord,
  pub target_workspace_id: WorkspaceId,
  pub name: WorkspaceName,
  pub source_folder_id: String,
  pub owner_principal: WorkspaceContentOwnerPrincipal,
  pub memberships: Vec<WorkspaceContentMemberRevision>,
  pub membership_revision: String,
  pub acl_plan: Vec<WorkspaceContentExtractAclPlan>,
  pub root_update: Vec<u8>,
  /// Server-captured Git scope, bound to the accepted preflight revision.
  pub git_sync_plan: Option<super::WorkspaceContentGitSyncPlan>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentExtractTarget {
  pub operation_id: WorkspaceContentOperationId,
  pub workspace_id: WorkspaceId,
  pub name: String,
}

/// Worker-only input from the published receipt. It contains no credentials,
/// staged payloads or live target document bodies.
pub struct WorkspaceContentExtractGitWork {
  pub operation_id: Uuid,
  pub source_workspace_id: Uuid,
  pub target_workspace_id: Uuid,
  pub source_folder_id: String,
  pub target_name: String,
  pub plan: super::WorkspaceContentGitSyncPlan,
  pub prepared_oid: Option<String>,
  /// `Some` binds written bytes; `None` binds a positively owned deletion.
  pub prepared_hashes: std::collections::BTreeMap<String, Option<String>>,
}

#[async_trait]
pub trait WorkspaceContentExtractTargetPort: Send + Sync {
  /// Create the hidden Workspace, ownership, exact accepted memberships, root
  /// document and ACL plan in one transaction. Exact replay is read-only.
  async fn create_extract_target(
    &self,
    request: WorkspaceContentExtractTargetRequest,
  ) -> AuthResult<WorkspaceContentExtractTarget>;
}

#[async_trait]
impl<T: WorkspaceContentExtractTargetPort + ?Sized> WorkspaceContentExtractTargetPort for Arc<T> {
  async fn create_extract_target(
    &self,
    request: WorkspaceContentExtractTargetRequest,
  ) -> AuthResult<WorkspaceContentExtractTarget> {
    (**self).create_extract_target(request).await
  }
}

#[async_trait]
pub trait WorkspaceContentExtractContextPort: Send + Sync {
  /// Resolve the owner captured at execution admission for this operation's
  /// unpublished target. This validates receipt ownership, not live actor
  /// authority; ordinary workspace access remains closed.
  async fn extract_target_owner(
    &self,
    operation: &WorkspaceContentOperationRecord,
  ) -> AuthResult<Option<WorkspaceContentOwnerPrincipal>>;

  /// Notify the members captured at execution admission, even if source
  /// membership changes while the authorized operation is running.
  async fn extract_recipient_snapshot(
    &self,
    operation: &WorkspaceContentOperationRecord,
  ) -> AuthResult<super::move_publication::WorkspaceContentRecipientSnapshot>;

  /// Resolve the immutable source folder bound while the hidden target was
  /// created. Publication never accepts this identity from a client or queue.
  async fn extract_source_folder_id(&self, operation_id: WorkspaceContentOperationId) -> AuthResult<String>;
}

#[async_trait]
pub trait WorkspaceContentExtractRecoveryPort: Send + Sync {
  /// Remove only an operation-owned, unpublished target and persist the safe
  /// execution failure. A published target is returned unchanged. Use the
  /// canonical Blob reference fence and finish private materialization cleanup
  /// before removing the target; staging cleanup belongs to the service above.
  async fn compensate_extract(
    &self,
    operation_id: WorkspaceContentOperationId,
    diagnostic_instance_id: &str,
    failure: RedactedWorkspaceContentError,
    storage: &dyn BlobStoragePort,
  ) -> AuthResult<WorkspaceContentOperationRecord>;

  /// Persist cleanup intent before external deletion, retaining the first failure
  /// or a winning cancellation. Already completed operations are returned intact.
  async fn mark_extract_cleanup_required(
    &self,
    operation_id: WorkspaceContentOperationId,
    diagnostic_instance_id: &str,
    failure: RedactedWorkspaceContentError,
  ) -> AuthResult<WorkspaceContentOperationRecord>;
}

pub struct WorkspaceContentExtractRecoveryService {
  recovery: Arc<dyn WorkspaceContentExtractRecoveryPort>,
  manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
  storage: Arc<dyn BlobStoragePort>,
  diagnostic_instance_id: String,
}

impl WorkspaceContentExtractRecoveryService {
  pub fn new(
    recovery: Arc<dyn WorkspaceContentExtractRecoveryPort>,
    manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
    storage: Arc<dyn BlobStoragePort>,
    diagnostic_instance_id: String,
  ) -> Self {
    Self {
      recovery,
      manifests,
      storage,
      diagnostic_instance_id,
    }
  }
}

#[async_trait]
impl WorkspaceContentSemanticRecovery for WorkspaceContentExtractRecoveryService {
  #[tracing::instrument(skip_all, fields(%operation_id, phase = "compensation", initial_cause = failure.code.as_str()))]
  async fn recover(
    &self,
    operation_id: WorkspaceContentOperationId,
    failure: RedactedWorkspaceContentError,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    // Persist compensation intent before deleting external bytes. A restart
    // must resume cleanup, not attempt publication with partially removed staging.
    let cleanup = self
      .recovery
      .mark_extract_cleanup_required(operation_id, &self.diagnostic_instance_id, failure.clone())
      .await
      .map_err(|error| {
        tracing::error!(%operation_id, phase = "compensation", step = "persist_cleanup_intent",
          cause = super::diagnostics::failure_code(&error).as_str(), "workspace_content.recovery_failed");
        error
      })?;
    if cleanup.status != WorkspaceContentOperationStatus::CleanupRequired {
      return Ok(cleanup);
    }
    let failure = cleanup.error.clone().unwrap_or(failure);
    let entries = self
      .manifests
      .list_staging_entries(operation_id)
      .await
      .map_err(|error| {
        super::diagnostics::record_failure(&cleanup, "compensation", &error);
        error
      })?;
    for entry in entries.into_iter().filter(|entry| {
      !matches!(
        entry.status,
        myoxus_domain::workspace_content_operation::WorkspaceContentStagingStatus::Published
          | myoxus_domain::workspace_content_operation::WorkspaceContentStagingStatus::Deleted
      )
    }) {
      if let Err(error) = self.storage.delete_blob(entry.object_key()).await {
        super::diagnostics::record_failure(
          &cleanup,
          "compensation",
          &AuthError::Storage(WorkspaceContentErrorCode::BlobCompensationFailed.as_str().into()),
        );
        super::diagnostics::record_port_failure(&error, "compensation");
        return Ok(cleanup);
      }
    }
    self
      .recovery
      .compensate_extract(
        operation_id,
        &self.diagnostic_instance_id,
        failure,
        self.storage.as_ref(),
      )
      .await
      .map_err(|error| {
        super::diagnostics::record_failure(&cleanup, "compensation", &error);
        error
      })
  }
}

pub struct WorkspaceContentExtractTargetService<P> {
  port: P,
}

impl<P: WorkspaceContentExtractTargetPort> WorkspaceContentExtractTargetService<P> {
  pub fn new(port: P) -> Self {
    Self { port }
  }

  pub async fn create(
    &self,
    operation: WorkspaceContentOperationRecord,
    name: WorkspaceName,
    mut authorized: WorkspaceContentAuthorizedPreflight,
  ) -> AuthResult<WorkspaceContentExtractTarget> {
    let target_workspace_id = authorized.graph.target_workspace_id;
    if operation.kind != WorkspaceContentOperationKind::ExtractFolder {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::PublicationKindInvalid.as_str().into(),
      ));
    }
    if operation.status != WorkspaceContentOperationStatus::Previewed {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::PublicationStateInvalid.as_str().into(),
      ));
    }
    if operation.source_workspace_id != authorized.graph.source_workspace_id
      || operation.actor_id.is_nil()
      || operation
        .target_workspace_id
        .is_some_and(|target| target != target_workspace_id)
      || target_workspace_id.is_nil()
      || target_workspace_id == operation.source_workspace_id
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string(),
      ));
    }
    if !operation
      .preview_revision
      .as_deref()
      .is_some_and(|revision| authorized.bind_accepted_revision(revision))
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::PreflightStale.as_str().into(),
      ));
    }
    if !authorized.blockers.is_empty() {
      return Err(AuthError::ActionForbidden);
    }
    let owner_principal = authorized
      .extract_target_principal
      .ok_or_else(|| AuthError::InvalidInput("XWS_OWNERSHIP_UNSUPPORTED".to_string()))?;
    let source_folder_id =
      authorized.graph.selection_root_folder_id.clone().ok_or_else(|| {
        AuthError::InvalidInput(WorkspaceContentErrorCode::OrganizerFolderMissing.as_str().to_string())
      })?;
    if owner_principal.principal_type == OwnerPrincipalType::System {
      return Err(AuthError::InvalidInput("XWS_OWNERSHIP_UNSUPPORTED".to_string()));
    }
    let mut memberships = authorized.extract_memberships;
    memberships.sort();
    if memberships
      .windows(2)
      .any(|window| window[0].user_id == window[1].user_id)
      || memberships.iter().any(|member| {
        member.user_id.is_nil()
          || member.role == WorkspaceRole::External
          || (owner_principal.principal_type == OwnerPrincipalType::Ou && member.role == WorkspaceRole::Owner)
      })
      || (owner_principal.principal_type == OwnerPrincipalType::User
        && !memberships
          .iter()
          .any(|member| member.user_id == owner_principal.principal_id && member.role == WorkspaceRole::Owner))
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::InventoryInvalid.as_str().to_string(),
      ));
    }
    let acl_plan = authorized
      .graph
      .resources
      .iter()
      .filter(|resource| resource.resource.kind() == WorkspaceContentResourceKind::Document)
      .map(|resource| {
        Ok(WorkspaceContentExtractAclPlan {
          document_id: resource.permission_resource_id.ok_or_else(|| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string())
          })?,
          source_workspace_id: operation.source_workspace_id,
          target_workspace_id,
          permission_revision: authorized.revision.clone(),
        })
      })
      .collect::<AuthResult<Vec<_>>>()?;
    let root_update = yjs::create_initial_workspace_doc(name.display());
    if root_update.is_empty() {
      return Err(AuthError::Storage(
        WorkspaceContentErrorCode::EncodingFailed.as_str().to_string(),
      ));
    }
    self
      .port
      .create_extract_target(WorkspaceContentExtractTargetRequest {
        operation,
        target_workspace_id,
        name,
        source_folder_id,
        owner_principal,
        memberships,
        membership_revision: authorized.revision,
        acl_plan,
        root_update,
        git_sync_plan: authorized.git_sync_plan,
      })
      .await
  }
}
