// SPDX-License-Identifier: AGPL-3.0-or-later
//! Server-authoritative admission and actor-scoped control for XWS operations.
//!
//! Transports provide stable identities and explicit confirmations. This
//! service reloads topology and authorization at execution admission; Extract
//! then delegates completion to its durable receipt. No GraphQL field or
//! worker payload can become business authority.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use myoxus_domain::ids::{UserId, WorkspaceContentOperationId};
use myoxus_domain::workspace_content_operation::{
  WorkspaceContentConfirmation, WorkspaceContentErrorCode, WorkspaceContentOperationKind,
  WorkspaceContentOperationRecord, WorkspaceContentOperationStatus, WorkspaceContentResourceKind,
};
use sha2::{Digest, Sha256};
use tracing::{Instrument, instrument, warn};
use uuid::Uuid;

use crate::audit::{AuditActor, AuditCategory, AuditEvent, AuditRecorder, AuditTarget};
use crate::auth::{AuthError, AuthResult};
use crate::ports::BlobStoragePort;
use crate::workspace::WorkspaceName;

use super::authorization::{
  WorkspaceContentAuthorizationError, WorkspaceContentAuthorizationOptions, WorkspaceContentAuthorizationSource,
  WorkspaceContentAuthorizedPreflight, WorkspaceContentAuthorizer,
};
use super::coordination::WorkspaceContentClusterCoordinator;
use super::extract::{WorkspaceContentExtractTargetPort, WorkspaceContentExtractTargetService};
use super::preflight::{WorkspaceContentGraphBuilder, WorkspaceContentGraphInput};
use super::{
  MAX_EXTRACT_WORKSPACE_NAME_BYTES, MAX_OPERATION_SELECTION_RESOURCES, MAX_ORGANIZER_ENTRY_ID_BYTES,
  MAX_ORGANIZER_INDEX_BYTES, WorkspaceContentControlRepository, WorkspaceContentExecuteRequest,
  WorkspaceContentExecutionMembership, WorkspaceContentLinkIntent, WorkspaceContentLinkIntentRepository,
  WorkspaceContentOperationRepository, WorkspaceContentOperationRequest, WorkspaceContentOperationSelection,
  WorkspaceContentOperationStatusProjection, WorkspaceContentStagingManifestRepository,
};

const OPERATION_NAMESPACE: Uuid = Uuid::from_u128(0x5c2a_8c31_74de_5ea0_80e1_9d55_8c2d_4c31);
const TARGET_NAMESPACE: Uuid = Uuid::from_u128(0x968b_fde7_fa83_5aa9_8522_a027_900e_875c);

/// Result of loading a coherent graph snapshot from authoritative stores.
pub struct WorkspaceContentPreparedGraph {
  pub input: WorkspaceContentGraphInput,
  pub authorization_options: WorkspaceContentAuthorizationOptions,
  /// Target organizer revision used only by Link publication. The content
  /// revision remains the execute-time binding for the complete preflight.
  pub target_organizer_revision: Option<String>,
}

/// Persistence-backed topology source. Implementations must reject resources
/// outside the source workspace and targets outside the current deployment.
#[async_trait]
pub trait WorkspaceContentGraphSourcePort: Send + Sync {
  async fn prepare_with_origin(
    &self,
    actor_id: UserId,
    operation_id: Uuid,
    request: &WorkspaceContentOperationRequest,
    mapping_overrides: Vec<myoxus_domain::workspace_content_operation::WorkspaceContentIdMapping>,
    origin_operation_id: Option<Uuid>,
  ) -> AuthResult<WorkspaceContentPreparedGraph>;
  async fn prepare(
    &self,
    actor_id: UserId,
    operation_id: Uuid,
    request: &WorkspaceContentOperationRequest,
    mapping_overrides: Vec<myoxus_domain::workspace_content_operation::WorkspaceContentIdMapping>,
  ) -> AuthResult<WorkspaceContentPreparedGraph>;
}

/// Object-safe authorization boundary used by API control.
#[async_trait]
pub trait WorkspaceContentAuthorizationPort: Send + Sync {
  async fn authorize_git_retry(
    &self,
    actor_id: UserId,
    source_workspace_id: Uuid,
    target_workspace_id: Uuid,
  ) -> AuthResult<()>;
  async fn authorize(
    &self,
    actor_id: UserId,
    input: WorkspaceContentGraphInput,
    options: WorkspaceContentAuthorizationOptions,
  ) -> Result<WorkspaceContentAuthorizedPreflight, WorkspaceContentAuthorizationError>;
}

#[async_trait]
impl<S> WorkspaceContentAuthorizationPort for WorkspaceContentAuthorizer<S>
where
  S: WorkspaceContentAuthorizationSource + Send + Sync,
{
  async fn authorize_git_retry(
    &self,
    actor_id: UserId,
    source_workspace_id: Uuid,
    target_workspace_id: Uuid,
  ) -> AuthResult<()> {
    self
      .authorize_git_management(actor_id, &[source_workspace_id, target_workspace_id])
      .await
  }
  async fn authorize(
    &self,
    actor_id: UserId,
    input: WorkspaceContentGraphInput,
    options: WorkspaceContentAuthorizationOptions,
  ) -> Result<WorkspaceContentAuthorizedPreflight, WorkspaceContentAuthorizationError> {
    let graph = WorkspaceContentGraphBuilder.build(input).map_err(|error| {
      use super::preflight::WorkspaceContentGraphError;
      let (code, error_kind) = match error {
        WorkspaceContentGraphError::EmptySelection => (WorkspaceContentErrorCode::RequestInvalid, "empty_selection"),
        WorkspaceContentGraphError::SelectedResourceUnsupported => (
          WorkspaceContentErrorCode::SelectedResourceUnsupported,
          "unsupported_resource",
        ),
        WorkspaceContentGraphError::InvalidWorkspaceBoundary => {
          (WorkspaceContentErrorCode::MappingPlanInvalid, "workspace_boundary")
        }
        WorkspaceContentGraphError::InvalidResourceSnapshot => {
          (WorkspaceContentErrorCode::InventoryInvalid, "resource_snapshot")
        }
        WorkspaceContentGraphError::DuplicateResource => (
          WorkspaceContentErrorCode::ResourceIdentityAmbiguous,
          "duplicate_resource",
        ),
        WorkspaceContentGraphError::UnclassifiedRelation(_) => {
          (WorkspaceContentErrorCode::InventoryInvalid, "unclassified_relation")
        }
        WorkspaceContentGraphError::NonTransferableOwnedDependency(_) => (
          WorkspaceContentErrorCode::SelectedResourceUnsupported,
          "non_owned_relation",
        ),
        WorkspaceContentGraphError::IncompleteOwnedDependency => (
          WorkspaceContentErrorCode::OwnedDocumentMissing,
          "incomplete_owned_dependency",
        ),
        WorkspaceContentGraphError::InvalidTargetInventory => {
          (WorkspaceContentErrorCode::InventoryInvalid, "target_inventory")
        }
        WorkspaceContentGraphError::FolderNotFound => {
          (WorkspaceContentErrorCode::OrganizerFolderMissing, "folder_missing")
        }
        WorkspaceContentGraphError::SuffixSpaceExhausted => (
          WorkspaceContentErrorCode::MappingPlanInvalid,
          "route_key_space_exhausted",
        ),
        WorkspaceContentGraphError::RevisionSerialization => {
          (WorkspaceContentErrorCode::EncodingFailed, "revision_encoding")
        }
      };
      tracing::error!(
        phase = "typed_plan",
        error_kind,
        cause = code.as_str(),
        "workspace_content.preflight_failed"
      );
      WorkspaceContentAuthorizationError::Authorization(AuthError::InvalidInput(code.as_str().into()))
    })?;
    self.preflight(actor_id, graph, options).await
  }
}

/// Complete preflight response consumed by GraphQL.
#[derive(Debug, Clone)]
pub struct WorkspaceContentPreflightResult {
  pub operation: WorkspaceContentOperationRecord,
  pub preflight: WorkspaceContentAuthorizedPreflight,
}

/// Shared control service for GraphQL and future trusted adapters.
pub struct WorkspaceContentControlService {
  operations: Arc<dyn WorkspaceContentOperationRepository>,
  control: Arc<dyn WorkspaceContentControlRepository>,
  manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
  links: Arc<dyn WorkspaceContentLinkIntentRepository>,
  graph_source: Arc<dyn WorkspaceContentGraphSourcePort>,
  authorization: Arc<dyn WorkspaceContentAuthorizationPort>,
  coordinator: Arc<WorkspaceContentClusterCoordinator>,
  extract_targets: Arc<dyn WorkspaceContentExtractTargetPort>,
  staging_storage: Arc<dyn BlobStoragePort>,
  audit: AuditRecorder,
}

impl WorkspaceContentControlService {
  #[allow(clippy::too_many_arguments)]
  pub fn new(
    operations: Arc<dyn WorkspaceContentOperationRepository>,
    control: Arc<dyn WorkspaceContentControlRepository>,
    manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
    links: Arc<dyn WorkspaceContentLinkIntentRepository>,
    graph_source: Arc<dyn WorkspaceContentGraphSourcePort>,
    authorization: Arc<dyn WorkspaceContentAuthorizationPort>,
    coordinator: Arc<WorkspaceContentClusterCoordinator>,
    extract_targets: Arc<dyn WorkspaceContentExtractTargetPort>,
    staging_storage: Arc<dyn BlobStoragePort>,
    audit: AuditRecorder,
  ) -> Self {
    Self {
      operations,
      control,
      manifests,
      links,
      graph_source,
      authorization,
      coordinator,
      extract_targets,
      staging_storage,
      audit,
    }
  }

  #[instrument(skip(self, request), fields(actor_id = %actor_id, kind = request.kind.as_str()))]
  pub async fn preflight(
    &self,
    actor_id: UserId,
    idempotency_id: Uuid,
    request: WorkspaceContentOperationRequest,
  ) -> AuthResult<WorkspaceContentPreflightResult> {
    self
      .preflight_with_origin(actor_id, idempotency_id, request, None, Vec::new())
      .await
  }

  async fn preflight_with_origin(
    &self,
    actor_id: UserId,
    idempotency_id: Uuid,
    request: WorkspaceContentOperationRequest,
    origin_operation_id: Option<WorkspaceContentOperationId>,
    mapping_overrides: Vec<myoxus_domain::workspace_content_operation::WorkspaceContentIdMapping>,
  ) -> AuthResult<WorkspaceContentPreflightResult> {
    let operation_id = operation_id(actor_id, idempotency_id);
    let now = Utc::now();
    let correlation = WorkspaceContentOperationRecord {
      id: operation_id,
      idempotency_id,
      actor_id,
      kind: request.kind,
      source_workspace_id: request.source_workspace_id,
      target_workspace_id: Some(request.target_workspace_id),
      status: WorkspaceContentOperationStatus::Draft,
      preview_revision: None,
      manifest_hash: String::new(),
      error: None,
      diagnostic_instance_id: None,
      created_at: now,
      updated_at: now,
    };
    validate_request(actor_id, idempotency_id, &request).map_err(|error| {
      super::diagnostics::record_failure(&correlation, "request_validation", &error);
      error
    })?;
    let prepared = super::diagnostics::in_phase(
      &correlation,
      "source_read",
      self
        .graph_source
        .prepare_with_origin(actor_id, operation_id, &request, mapping_overrides, origin_operation_id),
    )
    .await
    .map_err(|error| error.into_source())?;
    let authorized = self
      .authorization
      .authorize(actor_id, prepared.input, prepared.authorization_options)
      .instrument(tracing::info_span!("workspace_content.phase", operation_id = %operation_id, operation_kind = request.kind.as_str(), phase = "typed_plan"))
      .await
      .map_err(|error| {
        let error = map_authorization_error(error);
        super::diagnostics::record_failure(&correlation, "typed_plan", &error);
        error
      })?;
    let mappings = authorized
      .graph
      .mappings
      .iter()
      .map(|mapping| mapping.mapping.clone())
      .collect::<Vec<_>>();
    let manifest_hash = hash_json(&mappings)?;
    let now = Utc::now();
    let created = self
      .operations
      .create_or_get(WorkspaceContentOperationRecord {
        id: operation_id,
        idempotency_id,
        actor_id,
        kind: request.kind,
        source_workspace_id: request.source_workspace_id,
        target_workspace_id: (request.kind
          != myoxus_domain::workspace_content_operation::WorkspaceContentOperationKind::ExtractFolder)
          .then_some(request.target_workspace_id),
        status: WorkspaceContentOperationStatus::Draft,
        preview_revision: Some(authorized.revision.clone()),
        manifest_hash: manifest_hash.clone(),
        error: None,
        diagnostic_instance_id: None,
        created_at: now,
        updated_at: now,
      })
      .await?;
    self
      .control
      .store_request(operation_id, &request, origin_operation_id)
      .await?;
    self
      .control
      .store_git_undo_plan(
        operation_id,
        authorized.git_sync_plan.as_ref().filter(|plan| plan.undo.is_some()),
      )
      .await?;
    if request.kind != myoxus_domain::workspace_content_operation::WorkspaceContentOperationKind::ExtractFolder {
      self
        .manifests
        .store_manifest(operation_id, &manifest_hash, &mappings, &[])
        .await?;
    }
    if request.kind == myoxus_domain::workspace_content_operation::WorkspaceContentOperationKind::Link {
      let WorkspaceContentOperationSelection::Resources { resources } = &request.selection else {
        unreachable!("validated Link selects one resource");
      };
      let target = resources[0].clone();
      self
        .links
        .store_link_intent(WorkspaceContentLinkIntent {
          operation_id,
          entry_id: request.link_entry_id.clone().expect("validated Link entry"),
          parent_id: request.link_parent_id.clone().expect("validated Link parent"),
          index: request.link_index.clone().expect("validated Link index"),
          organizer_revision: prepared
            .target_organizer_revision
            .clone()
            .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::OrganizerDecode.as_str().to_string()))?,
          target,
        })
        .await?;
    }
    let operation = match created.record.status {
      WorkspaceContentOperationStatus::Draft => {
        self
          .operations
          .transition(
            operation_id,
            WorkspaceContentOperationStatus::Draft,
            WorkspaceContentOperationStatus::Previewed,
            None,
            None,
          )
          .await?
      }
      WorkspaceContentOperationStatus::Previewed => created.record,
      _ => created.record,
    };
    self
      .record_audit(
        "workspace_content.previewed",
        &operation,
        serde_json::json!({
          "resourceCount": authorized.graph.resources.len(),
          "membershipImpactCount": authorized.membership_impacts.len(),
          "confirmationCount": authorized.required_confirmations.len(),
          "blockerCount": authorized.blockers.len(),
          "blockers": authorized.blockers,
          "missingResources": authorized.graph.missing_resources.iter()
            .filter(|resource| resource.kind() != myoxus_domain::workspace_content_operation::WorkspaceContentResourceKind::Blob)
            .take(64).collect::<Vec<_>>(),
          "diagnosticLimit": 64,
          "brokenReferenceCount": authorized.graph.broken_reference_count,
        }),
      )
      .await;
    Ok(WorkspaceContentPreflightResult {
      operation,
      preflight: authorized,
    })
  }

  /// Workspace read permission is enforced by the transport; receipts remain
  /// actor-scoped so settings cannot offer another person's Retry authority.
  pub async fn pending_git_operations(
    &self,
    actor_id: UserId,
    workspace_id: Uuid,
  ) -> AuthResult<Vec<WorkspaceContentOperationStatusProjection>> {
    let mut operations = Vec::new();
    for id in self
      .operations
      .pending_git_operation_ids(workspace_id, actor_id)
      .await?
    {
      operations.push(self.status(id, actor_id).await?);
    }
    Ok(operations)
  }

  /// Admit a counter-Move for content ownership. Shared Tag/Blob catalogs are not
  /// inverted; receipt-bound position lineage restores their classifications.
  pub async fn undo_preflight(
    &self,
    actor_id: UserId,
    origin_operation_id: WorkspaceContentOperationId,
    idempotency_id: Uuid,
  ) -> AuthResult<WorkspaceContentPreflightResult> {
    use myoxus_domain::workspace_content_operation::WorkspaceContentOperationKind;

    let origin = self.actor_operation(origin_operation_id, actor_id).await?;
    if self
      .operations
      .git_work_status(origin_operation_id)
      .await?
      .is_some_and(|git| git.pending)
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::GitSyncUndoPending.as_str().into(),
      ));
    }
    if origin.status != WorkspaceContentOperationStatus::Succeeded
      || !matches!(
        origin.kind,
        WorkspaceContentOperationKind::Move | WorkspaceContentOperationKind::ExtractFolder
      )
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::UndoHasNoCommittedOriginReceipt
          .as_str()
          .to_string(),
      ));
    }
    let target_workspace_id = origin
      .target_workspace_id
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().to_string()))?;
    let mappings = self.manifests.list_mappings(origin_operation_id).await?;
    super::reject_collection_mappings(&mappings).inspect_err(|_| {
      tracing::error!(
        operation_id = %operation_id(actor_id, idempotency_id), origin_operation_id = %origin_operation_id,
        operation_kind = "move", phase = "typed_plan", error_kind = "invalid_input",
        cause = WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str(),
        "workspace_content.preflight_failed"
      );
    })?;
    if mappings.is_empty() {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string(),
      ));
    }
    super::reject_tag_relocation_mappings(&mappings)?;
    let reverse_mappings = mappings
      .iter()
      .filter(|mapping| {
        !matches!(
          mapping.source.kind(),
          WorkspaceContentResourceKind::Tag | WorkspaceContentResourceKind::Blob
        )
      })
      .map(|mapping| {
        myoxus_domain::workspace_content_operation::WorkspaceContentIdMapping::new(
          mapping.target.clone(),
          mapping.source.clone(),
        )
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))
      })
      .collect::<AuthResult<Vec<_>>>()?;
    let mut resources = mappings
      .iter()
      .filter(|mapping| {
        !matches!(
          mapping.target.kind(),
          WorkspaceContentResourceKind::Tag | WorkspaceContentResourceKind::Blob
        )
      })
      .map(|mapping| mapping.target.clone())
      .collect::<Vec<_>>();
    if resources.is_empty() {
      resources = mappings
        .iter()
        .map(|mapping| mapping.target.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    }
    let request = WorkspaceContentOperationRequest {
      kind: WorkspaceContentOperationKind::Move,
      source_workspace_id: target_workspace_id,
      target_workspace_id: origin.source_workspace_id,
      selection: WorkspaceContentOperationSelection::Resources { resources },
      copy_document_acl: false,
      extract_workspace_name: None,
      git_sync_choice: None,
      link_entry_id: None,
      link_parent_id: None,
      link_index: None,
    };
    self
      .preflight_with_origin(
        actor_id,
        idempotency_id,
        request,
        Some(origin_operation_id),
        reverse_mappings,
      )
      .await
  }

  /// Admit an actor-confirmed operation. Move uses this durable authority;
  /// for Extract, hidden-target creation
  /// durably captures this authorization and the current source memberships;
  /// queue waiting and worker execution do not require continuing actor rights.
  #[instrument(skip(self, confirmations), fields(operation_id = %operation_id, actor_id = %actor_id))]
  pub async fn execute(
    &self,
    operation_id: WorkspaceContentOperationId,
    actor_id: UserId,
    revision: String,
    mut confirmations: Vec<WorkspaceContentConfirmation>,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    let operation = self.actor_operation(operation_id, actor_id).await?;
    if operation.status == WorkspaceContentOperationStatus::Queued
      || operation.status == WorkspaceContentOperationStatus::Running
      || operation.status == WorkspaceContentOperationStatus::Succeeded
    {
      return Ok(operation);
    }
    if operation.status != WorkspaceContentOperationStatus::Previewed {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::OperationStateInvalid.as_str().to_string(),
      ));
    }
    let (request, origin_operation_id) = self
      .control
      .load_request(operation_id)
      .await?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
    validate_request(actor_id, operation.idempotency_id, &request).inspect_err(|error| {
      super::diagnostics::record_failure(&operation, "request_validation", error);
    })?;
    super::reject_collection_mappings(&self.manifests.list_mappings(operation_id).await?).inspect_err(|error| {
      super::diagnostics::record_failure(&operation, "typed_plan", error);
    })?;
    let prepared = self
      .graph_source
      .prepare_with_origin(
        actor_id,
        operation_id,
        &request,
        self.undo_mapping_overrides(origin_operation_id).await?,
        origin_operation_id,
      )
      .await?;
    let mut authorized = self
      .authorization
      .authorize(actor_id, prepared.input, prepared.authorization_options)
      .await
      .map_err(map_authorization_error)?;
    confirmations.sort();
    confirmations.dedup();
    if confirmations != authorized.required_confirmations {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::PreviewConfirmationMismatch.as_str().into(),
      ));
    }
    if !authorized.bind_accepted_revision(&revision) || operation.preview_revision.as_deref() != Some(revision.as_str())
    {
      return Err(AuthError::InvalidInput("XWS_PREFLIGHT_STALE".to_string()));
    }
    if !authorized.blockers.is_empty() {
      return Err(AuthError::ActionForbidden);
    }
    let confirmation_count = confirmations.len();
    let membership_impact_count = authorized.membership_impacts.len();
    let execution_memberships = authorized
      .membership_impacts
      .iter()
      .map(|impact| WorkspaceContentExecutionMembership {
        user_id: impact.impact.user_id,
        role: impact.impact.required_role,
      })
      .collect::<Vec<_>>();
    self
      .control
      .store_execution_memberships(operation_id, &execution_memberships)
      .await?;
    if request.kind == myoxus_domain::workspace_content_operation::WorkspaceContentOperationKind::ExtractFolder {
      let mappings = authorized
        .graph
        .mappings
        .iter()
        .map(|mapping| mapping.mapping.clone())
        .collect::<Vec<_>>();
      let name = WorkspaceName::parse(
        request
          .extract_workspace_name
          .as_deref()
          .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::RequestInvalid.as_str().to_string()))?,
      )
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::RequestInvalid.as_str().to_string()))?;
      WorkspaceContentExtractTargetService::new(self.extract_targets.clone())
        .create(operation.clone(), name, authorized)
        .await?;
      // Extract mappings reference the reserved target workspace and therefore
      // cannot satisfy the manifest FK before the isolated target exists.
      // Persist them only after target creation and before queue publication.
      self
        .manifests
        .store_manifest(operation_id, &operation.manifest_hash, &mappings, &[])
        .await?;
    }
    let queued = self
      .control
      .queue_previewed(&WorkspaceContentExecuteRequest {
        operation_id,
        actor_id,
        revision,
        confirmations,
      })
      .await?;
    if let Err(error) = self.coordinator.wake_operation(operation_id).await {
      warn!(%operation_id, dependency = error.dependency(), "durable XWS operation queued; wake-up deferred to reconciler");
    }
    self
      .record_audit(
        "workspace_content.queued",
        &queued,
        serde_json::json!({
          "confirmationCount": confirmation_count,
          "membershipImpactCount": membership_impact_count,
        }),
      )
      .await;
    Ok(queued)
  }

  pub async fn status(
    &self,
    operation_id: WorkspaceContentOperationId,
    actor_id: UserId,
  ) -> AuthResult<WorkspaceContentOperationStatusProjection> {
    let record = self.actor_operation(operation_id, actor_id).await?;
    let (_, origin_operation_id) = self
      .control
      .load_request(operation_id)
      .await?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
    Ok(WorkspaceContentOperationStatusProjection {
      git_sync: self.operations.git_work_status(operation_id).await?,
      record,
      origin_operation_id,
    })
  }

  /// Operator projection for one known operation identity. Discovery remains
  /// in the indexed audit stream; this method exposes only redacted aggregate
  /// state and never payload or staging keys.
  pub async fn operator_status(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<WorkspaceContentOperationStatusProjection> {
    let record = self
      .operations
      .get(operation_id)
      .await?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
    let (_, origin_operation_id) = self
      .control
      .load_request(operation_id)
      .await?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
    Ok(WorkspaceContentOperationStatusProjection {
      git_sync: self.operations.git_work_status(operation_id).await?,
      record,
      origin_operation_id,
    })
  }

  pub async fn cancel(
    &self,
    operation_id: WorkspaceContentOperationId,
    actor_id: UserId,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    self.actor_operation(operation_id, actor_id).await?;
    let cancelled = self.control.cancel_unpublished(operation_id, actor_id).await?;
    if self.cleanup_cancelled_blobs(&cancelled).await.is_err() {
      return self.control.mark_cancel_cleanup_required(operation_id).await;
    }
    let entries = self.manifests.list_staging_entries(operation_id).await?;
    for entry in entries.iter().filter(|entry| {
      !matches!(
        entry.status,
        myoxus_domain::workspace_content_operation::WorkspaceContentStagingStatus::Deleted
          | myoxus_domain::workspace_content_operation::WorkspaceContentStagingStatus::Published
      )
    }) {
      if self.delete_staged_object(&cancelled, entry).await.is_err() {
        let cleanup_required = self.control.mark_cancel_cleanup_required(operation_id).await?;
        self
          .record_audit(
            "workspace_content.cancel_cleanup_required",
            &cleanup_required,
            serde_json::json!({"stagingObjectCount": entries.len()}),
          )
          .await;
        return Ok(cleanup_required);
      }
    }
    self.control.mark_staging_deleted(operation_id).await?;
    self
      .record_audit(
        "workspace_content.cancelled",
        &cancelled,
        serde_json::json!({"stagingObjectCount": entries.len()}),
      )
      .await;
    Ok(cancelled)
  }

  /// Re-authorize and resume one actor-owned failed operation from its durable
  /// step. A changed permission/topology revision requires a new preflight.
  pub async fn retry(
    &self,
    operation_id: WorkspaceContentOperationId,
    actor_id: UserId,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    let operation = self.actor_operation(operation_id, actor_id).await?;
    if operation.status == WorkspaceContentOperationStatus::Succeeded
      && self
        .operations
        .git_work_status(operation_id)
        .await?
        .is_some_and(|state| state.pending)
    {
      let target = operation
        .target_workspace_id
        .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::OperationStateInvalid.as_str().into()))?;
      self
        .authorization
        .authorize_git_retry(actor_id, operation.source_workspace_id, target)
        .await?;
      self.operations.retry_git_work(operation_id, actor_id).await?;
      if self.operations.has_reconcilable_git_work(operation_id).await?
        && let Err(error) = self.coordinator.wake_git_operation(operation_id).await
      {
        warn!(%operation_id, dependency = error.dependency(), "durable Git retry queued; wake-up deferred");
      }
      return Ok(operation);
    }
    if operation.status != WorkspaceContentOperationStatus::Failed {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::OperationStateInvalid.as_str().to_string(),
      ));
    }
    if operation.kind == WorkspaceContentOperationKind::ExtractFolder && operation.target_workspace_id.is_none() {
      // Successful Extract compensation removes its hidden target. Requeueing
      // that receipt cannot reconstruct the authorization snapshot safely.
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::ExtractTargetWorkspaceIsMissing
          .as_str()
          .to_string(),
      ));
    }
    let (request, origin_operation_id) = self
      .control
      .load_request(operation_id)
      .await?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
    validate_request(actor_id, operation.idempotency_id, &request).inspect_err(|error| {
      super::diagnostics::record_failure(&operation, "request_validation", error);
    })?;
    super::reject_collection_mappings(&self.manifests.list_mappings(operation_id).await?).inspect_err(|error| {
      super::diagnostics::record_failure(&operation, "typed_plan", error);
    })?;
    let prepared = self
      .graph_source
      .prepare_with_origin(
        actor_id,
        operation_id,
        &request,
        self.undo_mapping_overrides(origin_operation_id).await?,
        origin_operation_id,
      )
      .await?;
    let mut authorized = self
      .authorization
      .authorize(actor_id, prepared.input, prepared.authorization_options)
      .await
      .map_err(map_authorization_error)?;
    if !authorized.blockers.is_empty() {
      return Err(AuthError::ActionForbidden);
    }
    if !operation
      .preview_revision
      .as_deref()
      .is_some_and(|revision| authorized.bind_accepted_revision(revision))
    {
      return Err(AuthError::InvalidInput("XWS_PREFLIGHT_STALE".to_string()));
    }
    let queued = self
      .control
      .retry_failed(operation_id, actor_id, &authorized.revision)
      .await?;
    if let Err(error) = self.coordinator.wake_operation(operation_id).await {
      warn!(%operation_id, dependency = error.dependency(), "durable XWS retry queued; wake-up deferred");
    }
    self
      .record_audit("workspace_content.retry_queued", &queued, serde_json::json!({}))
      .await;
    Ok(queued)
  }

  /// Retry an operator-visible cleanup step. This does not infer actor
  /// authority and must only be called behind the existing operator gate.
  pub async fn resume_cleanup(
    &self,
    operation_id: WorkspaceContentOperationId,
    operator_id: UserId,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    let running = self.control.resume_cleanup_required(operation_id).await?;
    if let Err(error) = self.coordinator.wake_operation(operation_id).await {
      warn!(%operation_id, dependency = error.dependency(), "durable XWS cleanup resumed; wake-up deferred");
    }
    self
      .record_operator_audit(
        "workspace_content.cleanup_resumed",
        operator_id,
        &running,
        serde_json::json!({}),
      )
      .await;
    Ok(running)
  }

  /// Complete a cancellation cleanup after deleting operation-owned staging.
  pub async fn cleanup_cancelled(
    &self,
    operation_id: WorkspaceContentOperationId,
    operator_id: UserId,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    let operation = self
      .operations
      .get(operation_id)
      .await?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
    if operation.status != WorkspaceContentOperationStatus::CleanupRequired
      || !operation
        .error
        .as_ref()
        .is_some_and(|error| error.is_cancellation_cleanup())
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::OperationStateInvalid.as_str().to_string(),
      ));
    }
    for entry in self
      .manifests
      .list_staging_entries(operation_id)
      .await?
      .into_iter()
      .filter(|entry| {
        !matches!(
          entry.status,
          myoxus_domain::workspace_content_operation::WorkspaceContentStagingStatus::Deleted
            | myoxus_domain::workspace_content_operation::WorkspaceContentStagingStatus::Published
        )
      })
    {
      self.delete_staged_object(&operation, &entry).await?;
    }
    self.cleanup_cancelled_blobs(&operation).await?;
    self.control.mark_staging_deleted(operation_id).await?;
    let cancelled = self.control.complete_cancel_cleanup(operation_id).await?;
    self
      .record_operator_audit(
        "workspace_content.cancel_cleanup_completed",
        operator_id,
        &cancelled,
        serde_json::json!({}),
      )
      .await;
    Ok(cancelled)
  }

  async fn cleanup_cancelled_blobs(&self, operation: &WorkspaceContentOperationRecord) -> AuthResult<()> {
    super::diagnostics::in_phase(operation, "compensation", async {
      for target in self.control.cancelled_private_blob_targets(operation.id).await? {
        self
          .staging_storage
          .delete_blob(&format!("{}/{}", target.workspace_id(), target.resource_id()))
          .await
          .map_err(|error| {
            super::diagnostics::record_port_failure(&error, "compensation");
            AuthError::Storage(WorkspaceContentErrorCode::CancellationCleanupRequired.as_str().into())
          })?;
      }
      Ok(())
    })
    .await
    .map_err(|error| error.into_source())
  }

  // Both cancellation paths retain the durable cancellation cause. Storage
  // cleanup failures are secondary diagnostics, never invalid staging payloads.
  async fn delete_staged_object(
    &self,
    operation: &WorkspaceContentOperationRecord,
    entry: &myoxus_domain::workspace_content_operation::WorkspaceContentStagingEntry,
  ) -> AuthResult<()> {
    super::diagnostics::in_phase(operation, "compensation", async {
      self
        .staging_storage
        .delete_blob(entry.object_key())
        .await
        .map_err(|error| {
          super::diagnostics::record_port_failure(&error, "compensation");
          AuthError::Storage(WorkspaceContentErrorCode::BlobCompensationFailed.as_str().into())
        })
    })
    .await
    .map_err(|error| error.into_source())
  }

  async fn actor_operation(
    &self,
    operation_id: WorkspaceContentOperationId,
    actor_id: UserId,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    self
      .operations
      .get(operation_id)
      .await?
      .filter(|record| record.actor_id == actor_id)
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))
  }

  async fn undo_mapping_overrides(
    &self,
    origin_operation_id: Option<WorkspaceContentOperationId>,
  ) -> AuthResult<Vec<myoxus_domain::workspace_content_operation::WorkspaceContentIdMapping>> {
    let Some(origin_operation_id) = origin_operation_id else {
      return Ok(Vec::new());
    };
    self
      .manifests
      .list_mappings(origin_operation_id)
      .await?
      .into_iter()
      .filter(|mapping| {
        !matches!(
          mapping.source.kind(),
          WorkspaceContentResourceKind::Tag | WorkspaceContentResourceKind::Blob
        )
      })
      .map(|mapping| {
        myoxus_domain::workspace_content_operation::WorkspaceContentIdMapping::new(mapping.target, mapping.source)
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))
      })
      .collect()
  }

  async fn record_audit(
    &self,
    event_key: &'static str,
    operation: &WorkspaceContentOperationRecord,
    details: serde_json::Value,
  ) {
    self
      .audit
      .record(
        AuditEvent::mutation(
          event_key,
          AuditCategory::Workspace,
          Some(AuditTarget::entity("workspace_content_operation", operation.id, None)),
          AuditActor::user(operation.actor_id, None),
          None,
          Some(serde_json::json!({
            "operationId": operation.id,
            "operationKind": operation.kind.as_str(),
            "sourceWorkspaceId": operation.source_workspace_id,
            "targetWorkspaceId": operation.target_workspace_id,
            "status": operation.status.as_str(),
            "details": details,
          })),
        )
        .with_metadata(serde_json::json!({
          "diagnosticInstanceId": operation.diagnostic_instance_id,
        })),
      )
      .await;
  }

  async fn record_operator_audit(
    &self,
    event_key: &'static str,
    operator_id: UserId,
    operation: &WorkspaceContentOperationRecord,
    details: serde_json::Value,
  ) {
    self
      .audit
      .record(
        AuditEvent::mutation(
          event_key,
          AuditCategory::Workspace,
          Some(AuditTarget::entity(
            "workspace_content_operation",
            operation.id,
            None::<String>,
          )),
          AuditActor::user(operator_id, None),
          None,
          Some(serde_json::json!({
            "operationId": operation.id,
            "operationKind": operation.kind.as_str(),
            "sourceWorkspaceId": operation.source_workspace_id,
            "targetWorkspaceId": operation.target_workspace_id,
            "status": operation.status.as_str(),
            "details": details,
          })),
        )
        .with_metadata(serde_json::json!({
          "diagnosticInstanceId": operation.diagnostic_instance_id,
        })),
      )
      .await;
  }
}

fn deterministic_id(namespace: Uuid, actor_id: UserId, idempotency_id: Uuid) -> Uuid {
  let mut material = Vec::with_capacity(32);
  material.extend_from_slice(actor_id.as_bytes());
  material.extend_from_slice(idempotency_id.as_bytes());
  Uuid::new_v5(&namespace, &material)
}

pub fn reserved_target_id(actor_id: UserId, idempotency_id: Uuid) -> Uuid {
  deterministic_id(TARGET_NAMESPACE, actor_id, idempotency_id)
}

/// Content-free correlation identity, available before a preview is admitted.
pub fn operation_id(actor_id: UserId, idempotency_id: Uuid) -> Uuid {
  deterministic_id(OPERATION_NAMESPACE, actor_id, idempotency_id)
}

fn hash_json(value: &impl serde::Serialize) -> AuthResult<String> {
  serde_json::to_vec(value)
    .map(|bytes| hex::encode(Sha256::digest(bytes)))
    .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::EncodingFailed.as_str().to_string()))
}

fn validate_request(
  actor_id: UserId,
  idempotency_id: Uuid,
  request: &WorkspaceContentOperationRequest,
) -> AuthResult<()> {
  use myoxus_domain::workspace_content_operation::WorkspaceContentOperationKind;

  if actor_id.is_nil()
    || idempotency_id.is_nil()
    || request.source_workspace_id.is_nil()
    || request.target_workspace_id.is_nil()
    || request.source_workspace_id == request.target_workspace_id
  {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::RequestInvalid.as_str().to_string(),
    ));
  }
  match &request.selection {
    WorkspaceContentOperationSelection::Resources { resources } => {
      if resources
        .iter()
        .any(|resource| resource.kind() == WorkspaceContentResourceKind::Collection)
      {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str().into(),
        ));
      }
      if resources.is_empty()
        || resources.len() > MAX_OPERATION_SELECTION_RESOURCES
        || resources
          .iter()
          .any(|resource| resource.workspace_id() != request.source_workspace_id)
      {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::RequestInvalid.as_str().to_string(),
        ));
      }
    }
    WorkspaceContentOperationSelection::FolderSubtree { folder_id } => {
      if request.kind != WorkspaceContentOperationKind::ExtractFolder
        || invalid_bounded_text(folder_id, MAX_ORGANIZER_ENTRY_ID_BYTES)
      {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::RequestInvalid.as_str().to_string(),
        ));
      }
    }
  }
  let extract = request.kind == WorkspaceContentOperationKind::ExtractFolder;
  if !extract && request.git_sync_choice.is_some() {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::RequestInvalid.as_str().to_string(),
    ));
  }
  if extract
    != request
      .extract_workspace_name
      .as_deref()
      .is_some_and(|name| !invalid_bounded_text(name, MAX_EXTRACT_WORKSPACE_NAME_BYTES))
    || (!extract && request.copy_document_acl && request.kind != WorkspaceContentOperationKind::Copy)
  {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::RequestInvalid.as_str().to_string(),
    ));
  }
  let link = request.kind == WorkspaceContentOperationKind::Link;
  if link
    != [
      request.link_entry_id.as_deref(),
      request.link_parent_id.as_deref(),
      request.link_index.as_deref(),
    ]
    .iter()
    .all(|value| value.is_some())
    || request
      .link_entry_id
      .as_deref()
      .is_some_and(|value| invalid_bounded_text(value, MAX_ORGANIZER_ENTRY_ID_BYTES))
    || request
      .link_parent_id
      .as_deref()
      .is_some_and(|value| invalid_bounded_text(value, MAX_ORGANIZER_ENTRY_ID_BYTES))
    || request
      .link_index
      .as_deref()
      .is_some_and(|value| invalid_bounded_text(value, MAX_ORGANIZER_INDEX_BYTES))
  {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::RequestInvalid.as_str().to_string(),
    ));
  }
  if link
    && !matches!(
      &request.selection,
      WorkspaceContentOperationSelection::Resources { resources } if resources.len() == 1
    )
  {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::RequestInvalid.as_str().to_string(),
    ));
  }
  if link
    && matches!(&request.selection, WorkspaceContentOperationSelection::Resources { resources }
      if resources.iter().any(|resource| !matches!(resource.kind(),
        WorkspaceContentResourceKind::Document | WorkspaceContentResourceKind::Database | WorkspaceContentResourceKind::Tag)))
  {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str().into(),
    ));
  }
  Ok(())
}

fn invalid_bounded_text(value: &str, max_bytes: usize) -> bool {
  value.is_empty() || value.len() > max_bytes || value.trim() != value || value.chars().any(char::is_control)
}

fn map_authorization_error(error: WorkspaceContentAuthorizationError) -> AuthError {
  match error {
    WorkspaceContentAuthorizationError::Authorization(error) => error,
    WorkspaceContentAuthorizationError::Stale { .. } => AuthError::InvalidInput("XWS_PREFLIGHT_STALE".to_string()),
    WorkspaceContentAuthorizationError::ConfirmationMismatch => {
      AuthError::InvalidInput(WorkspaceContentErrorCode::PreviewConfirmationMismatch.as_str().into())
    }
    WorkspaceContentAuthorizationError::Blocked { .. } => AuthError::ActionForbidden,
    WorkspaceContentAuthorizationError::InvalidState => {
      AuthError::InvalidInput(WorkspaceContentErrorCode::RequestInvalid.as_str().into())
    }
  }
}
