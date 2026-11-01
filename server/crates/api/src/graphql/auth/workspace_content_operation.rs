// SPDX-License-Identifier: AGPL-3.0-or-later
//! Typed GraphQL projections for server-authoritative XWS operations.

use async_graphql::{Enum, Error, ErrorExtensions, InputObject, SimpleObject};
use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::workspace_content_operation::control::WorkspaceContentPreflightResult;
use myoxus_application::workspace_content_operation::control::reserved_target_id;
use myoxus_application::workspace_content_operation::preflight::WorkspaceContentConflictKind;
use myoxus_application::workspace_content_operation::{
  WorkspaceContentOperationRequest, WorkspaceContentOperationSelection,
};
use myoxus_domain::entities::WorkspaceRole as WorkspaceRoleModel;
use myoxus_domain::permission::WorkspaceAction;
use myoxus_domain::workspace_content_operation::{
  TargetMembershipConfirmation, WorkspaceContentBlocker, WorkspaceContentConfirmation, WorkspaceContentErrorCode,
  WorkspaceContentOperationKind, WorkspaceContentOperationRecord, WorkspaceContentOperationStatus,
  WorkspaceContentResourceKind, WorkspaceContentResourceRef,
};
use uuid::Uuid;

use super::WorkspaceRole;

/// Preserve operation causes inside the existing GraphQL error envelope. The
/// shared HTTP/error category remains unchanged; clients select copy by name.
pub(super) fn map_workspace_content_error(error: AuthError) -> Error {
  let cause = match &error {
    AuthError::InvalidInput(code) | AuthError::NotFound(code) => WorkspaceContentErrorCode::parse(code),
    AuthError::Storage(code) => {
      Some(WorkspaceContentErrorCode::parse(code).unwrap_or(WorkspaceContentErrorCode::StorageUnavailable))
    }
    _ => None,
  };
  let mut projected = crate::graphql::utils::map_gql_error(error);
  if let Some(cause) = cause {
    projected.message = cause.safe_message().unwrap_or(cause.as_str()).to_string();
    projected = projected.extend_with(|_, extensions| extensions.set("name", cause.as_str()));
  }
  projected
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum WorkspaceContentOperationKindType {
  Move,
  Copy,
  Link,
  ExtractFolder,
}

impl From<WorkspaceContentOperationKindType> for WorkspaceContentOperationKind {
  fn from(value: WorkspaceContentOperationKindType) -> Self {
    match value {
      WorkspaceContentOperationKindType::Move => Self::Move,
      WorkspaceContentOperationKindType::Copy => Self::Copy,
      WorkspaceContentOperationKindType::Link => Self::Link,
      WorkspaceContentOperationKindType::ExtractFolder => Self::ExtractFolder,
    }
  }
}

impl From<WorkspaceContentOperationKind> for WorkspaceContentOperationKindType {
  fn from(value: WorkspaceContentOperationKind) -> Self {
    match value {
      WorkspaceContentOperationKind::Move => Self::Move,
      WorkspaceContentOperationKind::Copy => Self::Copy,
      WorkspaceContentOperationKind::Link => Self::Link,
      WorkspaceContentOperationKind::ExtractFolder => Self::ExtractFolder,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum WorkspaceContentResourceKindType {
  Document,
  Database,
  Collection,
  Folder,
  Tag,
  Blob,
}

impl From<WorkspaceContentResourceKindType> for WorkspaceContentResourceKind {
  fn from(value: WorkspaceContentResourceKindType) -> Self {
    match value {
      WorkspaceContentResourceKindType::Document => Self::Document,
      WorkspaceContentResourceKindType::Database => Self::Database,
      WorkspaceContentResourceKindType::Collection => Self::Collection,
      WorkspaceContentResourceKindType::Folder => Self::Folder,
      WorkspaceContentResourceKindType::Tag => Self::Tag,
      WorkspaceContentResourceKindType::Blob => Self::Blob,
    }
  }
}

impl From<WorkspaceContentResourceKind> for WorkspaceContentResourceKindType {
  fn from(value: WorkspaceContentResourceKind) -> Self {
    match value {
      WorkspaceContentResourceKind::Document => Self::Document,
      WorkspaceContentResourceKind::Database => Self::Database,
      WorkspaceContentResourceKind::Collection => Self::Collection,
      WorkspaceContentResourceKind::Folder => Self::Folder,
      WorkspaceContentResourceKind::Tag => Self::Tag,
      WorkspaceContentResourceKind::Blob => Self::Blob,
    }
  }
}

#[derive(Debug, InputObject, Clone)]
pub struct WorkspaceContentResourceInput {
  pub kind: WorkspaceContentResourceKindType,
  #[graphql(validator(max_length = 512))]
  pub id: String,
}

#[derive(Debug, InputObject, Clone)]
pub struct WorkspaceContentPreflightInput {
  pub idempotency_id: Uuid,
  pub kind: WorkspaceContentOperationKindType,
  pub source_workspace_id: Uuid,
  pub target_workspace_id: Option<Uuid>,
  #[graphql(validator(max_items = 256))]
  pub resources: Option<Vec<WorkspaceContentResourceInput>>,
  #[graphql(validator(max_length = 512))]
  pub folder_id: Option<String>,
  pub copy_document_acl: Option<bool>,
  #[graphql(validator(max_length = 256))]
  pub extract_workspace_name: Option<String>,
  pub git_sync_choice: Option<WorkspaceContentGitSyncChoiceType>,
  #[graphql(validator(max_length = 512))]
  pub link_entry_id: Option<String>,
  #[graphql(validator(max_length = 512))]
  pub link_parent_id: Option<String>,
  #[graphql(validator(max_length = 512))]
  pub link_index: Option<String>,
}

impl WorkspaceContentPreflightInput {
  pub fn into_request(self, actor_id: Uuid) -> AuthResult<(Uuid, WorkspaceContentOperationRequest)> {
    let kind: WorkspaceContentOperationKind = self.kind.into();
    if self.resources.as_ref().is_some_and(|resources| {
      resources
        .iter()
        .any(|resource| resource.kind == WorkspaceContentResourceKindType::Collection)
    }) {
      let cause = WorkspaceContentErrorCode::SelectedResourceUnsupported;
      tracing::error!(
        operation_id = %myoxus_application::workspace_content_operation::control::operation_id(actor_id, self.idempotency_id),
        operation_kind = kind.as_str(), phase = "request_validation", cause = cause.as_str(),
        "workspace_content.request_rejected"
      );
      return Err(AuthError::InvalidInput(cause.as_str().into()));
    }
    let target_workspace_id = match (kind, self.target_workspace_id) {
      (WorkspaceContentOperationKind::ExtractFolder, None) => reserved_target_id(actor_id, self.idempotency_id),
      (WorkspaceContentOperationKind::ExtractFolder, Some(_)) => {
        return Err(AuthError::InvalidInput(
          "Extract target identity is server-owned".to_string(),
        ));
      }
      (_, Some(target)) => target,
      (_, None) => {
        return Err(AuthError::InvalidInput("target workspace is required".to_string()));
      }
    };
    let selection = match (self.resources, self.folder_id) {
      (Some(resources), None) => WorkspaceContentOperationSelection::Resources {
        resources: resources
          .into_iter()
          .map(|resource| {
            WorkspaceContentResourceRef::new(self.source_workspace_id, resource.kind.into(), resource.id)
              .map_err(|_| AuthError::InvalidInput("invalid workspace content resource".to_string()))
          })
          .collect::<AuthResult<Vec<_>>>()?,
      },
      (None, Some(folder_id)) => WorkspaceContentOperationSelection::FolderSubtree { folder_id },
      _ => {
        return Err(AuthError::InvalidInput(
          "exactly one workspace content selection is required".to_string(),
        ));
      }
    };
    Ok((
      self.idempotency_id,
      WorkspaceContentOperationRequest {
        kind,
        source_workspace_id: self.source_workspace_id,
        target_workspace_id,
        selection,
        copy_document_acl: self.copy_document_acl.unwrap_or(false),
        extract_workspace_name: self.extract_workspace_name,
        git_sync_choice: self.git_sync_choice.map(Into::into),
        link_entry_id: self.link_entry_id,
        link_parent_id: self.link_parent_id,
        link_index: self.link_index,
      },
    ))
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum WorkspaceContentGitSyncChoiceType {
  Move,
  Disconnect,
}

impl From<WorkspaceContentGitSyncChoiceType>
  for myoxus_application::workspace_content_operation::WorkspaceContentGitSyncChoice
{
  fn from(value: WorkspaceContentGitSyncChoiceType) -> Self {
    match value {
      WorkspaceContentGitSyncChoiceType::Move => Self::Move,
      WorkspaceContentGitSyncChoiceType::Disconnect => Self::Disconnect,
    }
  }
}

impl From<myoxus_application::workspace_content_operation::WorkspaceContentGitSyncChoice>
  for WorkspaceContentGitSyncChoiceType
{
  fn from(value: myoxus_application::workspace_content_operation::WorkspaceContentGitSyncChoice) -> Self {
    match value {
      myoxus_application::workspace_content_operation::WorkspaceContentGitSyncChoice::Move => Self::Move,
      myoxus_application::workspace_content_operation::WorkspaceContentGitSyncChoice::Disconnect => Self::Disconnect,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum WorkspaceContentConfirmationKindType {
  AddTargetMember,
  CopyDocumentAcl,
  DisablePublicShare,
}

#[derive(Debug, InputObject, Clone)]
pub struct WorkspaceContentConfirmationInput {
  pub kind: WorkspaceContentConfirmationKindType,
  pub user_id: Option<Uuid>,
  pub role: Option<WorkspaceRole>,
  pub resource: Option<WorkspaceContentResourceInput>,
  pub resource_workspace_id: Option<Uuid>,
}

impl WorkspaceContentConfirmationInput {
  pub fn into_domain(self) -> AuthResult<WorkspaceContentConfirmation> {
    match self.kind {
      WorkspaceContentConfirmationKindType::AddTargetMember => {
        let user_id = self
          .user_id
          .ok_or_else(|| AuthError::InvalidInput("membership confirmation user is missing".to_string()))?;
        let role = match self
          .role
          .ok_or_else(|| AuthError::InvalidInput("membership confirmation role is missing".to_string()))?
        {
          WorkspaceRole::Admin => WorkspaceRoleModel::Admin,
          WorkspaceRole::Manager => WorkspaceRoleModel::Manager,
          WorkspaceRole::Collaborator => WorkspaceRoleModel::Collaborator,
          WorkspaceRole::Commenter => WorkspaceRoleModel::Commenter,
          WorkspaceRole::Reader => WorkspaceRoleModel::Reader,
          WorkspaceRole::Owner | WorkspaceRole::External => {
            return Err(AuthError::InvalidInput(
              "membership confirmation role is invalid".to_string(),
            ));
          }
        };
        Ok(WorkspaceContentConfirmation::AddTargetMember {
          membership: TargetMembershipConfirmation::new(user_id, role)
            .map_err(|_| AuthError::InvalidInput("membership confirmation is invalid".to_string()))?,
        })
      }
      WorkspaceContentConfirmationKindType::DisablePublicShare => Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::RequestInvalid.as_str().into(),
      )),
      WorkspaceContentConfirmationKindType::CopyDocumentAcl => {
        let input = self
          .resource
          .ok_or_else(|| AuthError::InvalidInput("confirmation resource is missing".to_string()))?;
        let workspace_id = self
          .resource_workspace_id
          .ok_or_else(|| AuthError::InvalidInput("confirmation resource workspace is missing".to_string()))?;
        let resource = WorkspaceContentResourceRef::new(workspace_id, input.kind.into(), input.id)
          .map_err(|_| AuthError::InvalidInput("confirmation resource is invalid".to_string()))?;
        Ok(WorkspaceContentConfirmation::CopyDocumentAcl { resource })
      }
    }
  }
}

#[derive(Debug, InputObject, Clone)]
pub struct WorkspaceContentExecuteInput {
  pub operation_id: Uuid,
  #[graphql(validator(max_length = 128))]
  pub revision: String,
  #[graphql(validator(max_items = 512))]
  pub confirmations: Vec<WorkspaceContentConfirmationInput>,
}

#[derive(Debug, InputObject, Clone)]
pub struct WorkspaceContentRedirectInput {
  pub workspace_id: Uuid,
  pub resource: WorkspaceContentResourceInput,
}

#[derive(Debug, SimpleObject, Clone)]
pub struct WorkspaceContentRedirectType {
  pub workspace_id: Uuid,
  pub kind: WorkspaceContentResourceKindType,
  pub id: String,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum WorkspaceContentOperationStatusType {
  Draft,
  Previewed,
  Queued,
  Running,
  Succeeded,
  Cancelled,
  Failed,
  CleanupRequired,
}

impl From<WorkspaceContentOperationStatus> for WorkspaceContentOperationStatusType {
  fn from(value: WorkspaceContentOperationStatus) -> Self {
    match value {
      WorkspaceContentOperationStatus::Draft => Self::Draft,
      WorkspaceContentOperationStatus::Previewed => Self::Previewed,
      WorkspaceContentOperationStatus::Queued => Self::Queued,
      WorkspaceContentOperationStatus::Running => Self::Running,
      WorkspaceContentOperationStatus::Succeeded => Self::Succeeded,
      WorkspaceContentOperationStatus::Cancelled => Self::Cancelled,
      WorkspaceContentOperationStatus::Failed => Self::Failed,
      WorkspaceContentOperationStatus::CleanupRequired => Self::CleanupRequired,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "SCREAMING_SNAKE_CASE")]
pub enum WorkspaceContentErrorCodeType {
  #[graphql(name = "XWS_OPERATION_STATE_INVALID")]
  OperationStateInvalid,
  #[graphql(name = "XWS_MOVE_DOCUMENT_METADATA_CHANGED")]
  MoveDocumentMetadataChanged,
  #[graphql(name = "XWS_MOVE_DOCUMENT_ACL_CHANGED")]
  MoveDocumentAclChanged,
  #[graphql(name = "XWS_EXTRACT_OPERATION_REVISION_CHANGED")]
  ExtractOperationRevisionChanged,
  #[graphql(name = "XWS_EXTRACT_TARGET_REPLAY_CHANGED")]
  ExtractTargetReplayChanged,
  #[graphql(name = "XWS_EXTRACT_TARGET_LIFECYCLE_CHANGED")]
  ExtractTargetLifecycleChanged,
  #[graphql(name = "XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_CHANGED")]
  ExtractMembershipSnapshotChanged,
  #[graphql(name = "XWS_EXTRACT_RECOVERY_TARGET_RECEIPT_IS_MISSING")]
  ExtractRecoveryTargetReceiptIsMissing,
  #[graphql(name = "XWS_PUBLISHED_EXTRACT_CANNOT_BE_COMPENSATED")]
  PublishedExtractCannotBeCompensated,
  #[graphql(name = "XWS_EXTRACT_RECOVERY_STATE_CHANGED")]
  ExtractRecoveryStateChanged,
  #[graphql(name = "XWS_EXTRACT_RECOVERY_TARGET_LIFECYCLE_CHANGED")]
  ExtractRecoveryTargetLifecycleChanged,
  #[graphql(name = "XWS_COPY_TARGET_POLICY_CHANGED")]
  CopyTargetPolicyChanged,
  #[graphql(name = "XWS_COPY_TARGET_PAGE_DIRECTORY_CHANGED")]
  CopyTargetPageDirectoryChanged,
  #[graphql(name = "XWS_MOVE_REVISION_MANIFEST_REPLAY_CHANGED")]
  MoveRevisionManifestReplayChanged,
  #[graphql(name = "XWS_MOVE_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW")]
  MoveTagLineageRequiresAFreshPreview,
  #[graphql(name = "XWS_MOVE_REFERENCES_REQUIRE_A_FRESH_PREVIEW")]
  MoveReferencesRequireAFreshPreview,
  #[graphql(name = "XWS_MOVE_OPERATION_REVISION_CHANGED")]
  MoveOperationRevisionChanged,
  #[graphql(name = "XWS_MOVE_TAG_LINEAGE_IS_MISSING")]
  MoveTagLineageIsMissing,
  #[graphql(name = "XWS_MOVE_DATABASE_REVISION_IS_MISSING")]
  MoveDatabaseRevisionIsMissing,
  #[graphql(name = "XWS_MOVE_DATABASE_CHILD_OWNERSHIP_CHANGED")]
  MoveDatabaseChildOwnershipChanged,
  #[graphql(name = "XWS_MOVE_DOCUMENT_REVISION_IS_MISSING")]
  MoveDocumentRevisionIsMissing,
  #[graphql(name = "XWS_MOVE_DOCUMENT_CLASSIFICATIONS_CHANGED")]
  MoveDocumentClassificationsChanged,
  #[graphql(name = "XWS_MOVE_DOCUMENT_OWNERSHIP_CHANGED")]
  MoveDocumentOwnershipChanged,
  #[graphql(name = "XWS_MOVE_DOCUMENT_CHILD_COUNT_IS_MISSING")]
  MoveDocumentChildCountIsMissing,
  #[graphql(name = "XWS_MOVE_DOCUMENT_CHILD_OWNERSHIP_CHANGED")]
  MoveDocumentChildOwnershipChanged,
  #[graphql(name = "XWS_MOVE_REFERENCE_SOURCE_CHANGED")]
  MoveReferenceSourceChanged,
  #[graphql(name = "XWS_MOVE_REFERENCE_PLAN_IS_MISSING")]
  MoveReferencePlanIsMissing,
  #[graphql(name = "XWS_MOVE_TARGET_PAGE_DIRECTORY_CHANGED")]
  MoveTargetPageDirectoryChanged,
  #[graphql(name = "XWS_EXTRACT_TARGET_ACTIVATION_CHANGED")]
  ExtractTargetActivationChanged,
  #[graphql(name = "XWS_EXTRACT_TARGET_RECEIPT_CHANGED")]
  ExtractTargetReceiptChanged,
  #[graphql(name = "XWS_EXTRACT_BLOB_STAGING_STATE_CHANGED")]
  ExtractBlobStagingStateChanged,
  #[graphql(name = "XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_IS_INVALID")]
  ExtractMembershipSnapshotIsInvalid,
  #[graphql(name = "XWS_EXTRACT_RECIPIENT_SNAPSHOT_CHANGED")]
  ExtractRecipientSnapshotChanged,
  #[graphql(name = "XWS_MOVE_RECIPIENT_SNAPSHOT_CHANGED")]
  MoveRecipientSnapshotChanged,
  #[graphql(name = "XWS_MOVE_MAPPING_CHANGED")]
  MoveMappingChanged,
  #[graphql(name = "XWS_MOVE_PERSISTED_REVISION_MANIFEST_CHANGED")]
  MovePersistedRevisionManifestChanged,
  #[graphql(name = "XWS_PREPARED_TAG_IDENTITY_WAS_RETIRED")]
  PreparedTagIdentityWasRetired,
  #[graphql(name = "XWS_PREPARED_TAG_IS_NO_LONGER_REUSABLE")]
  PreparedTagIsNoLongerReusable,
  #[graphql(name = "XWS_CONCURRENT_TAG_IDENTITY_IS_NOT_REUSABLE")]
  ConcurrentTagIdentityIsNotReusable,
  #[graphql(name = "XWS_MOVED_TAG_CELL_DISAPPEARED")]
  MovedTagCellDisappeared,
  #[graphql(name = "XWS_MOVED_TAG_TEMPLATE_DISAPPEARED")]
  MovedTagTemplateDisappeared,
  #[graphql(name = "XWS_MOVED_TAG_FILTER_DISAPPEARED")]
  MovedTagFilterDisappeared,
  #[graphql(name = "XWS_MOVED_TAG_PREDICATE_DISAPPEARED")]
  MovedTagPredicateDisappeared,
  #[graphql(name = "XWS_MOVED_TAG_FILTER_CONTAINER_CHANGED")]
  MovedTagFilterContainerChanged,
  #[graphql(name = "XWS_OWNED_TAG_CLASSIFICATION_CHANGED")]
  OwnedTagClassificationChanged,
  #[graphql(name = "XWS_PLANNED_TAG_IDENTITY_WAS_RETIRED")]
  PlannedTagIdentityWasRetired,
  #[graphql(name = "XWS_PLANNED_TAG_IS_NO_LONGER_REUSABLE")]
  PlannedTagIsNoLongerReusable,
  #[graphql(name = "XWS_UNDO_HAS_NO_COMMITTED_ORIGIN_RECEIPT")]
  UndoHasNoCommittedOriginReceipt,
  #[graphql(name = "XWS_UNDO_ORIGIN_LINEAGE_HASH_CHANGED")]
  UndoOriginLineageHashChanged,
  #[graphql(name = "XWS_UNDO_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW")]
  UndoTagLineageRequiresAFreshPreview,
  #[graphql(name = "XWS_UNDO_EXTRACT_HAS_NO_MATCHING_PUBLISHED_FOLDER_RECEIPT")]
  UndoExtractHasNoMatchingPublishedFolderReceipt,
  #[graphql(name = "XWS_MOVE_REVISION_CHANGED_DURING_PUBLICATION")]
  MoveRevisionChangedDuringPublication,
  #[graphql(name = "XWS_EXTRACT_TARGET_WORKSPACE_IS_MISSING")]
  ExtractTargetWorkspaceIsMissing,
  #[graphql(name = "XWS_EXTRACT_TARGET_RECEIPT_IS_MISSING")]
  ExtractTargetReceiptIsMissing,
  #[graphql(name = "XWS_EXTRACT_TARGET_LIFECYCLE_OWNERSHIP_CHANGED")]
  ExtractTargetLifecycleOwnershipChanged,
  #[graphql(name = "XWS_EXTRACT_TARGET_OWNERSHIP_CHANGED")]
  ExtractTargetOwnershipChanged,
  #[graphql(name = "XWS_EXTRACT_TARGET_ROOT_CHANGED")]
  ExtractTargetRootChanged,
  #[graphql(name = "XWS_MOVE_TARGET_MISSING")]
  MoveTargetMissing,
  #[graphql(name = "XWS_WORKSPACE_CONTENT_TARGET_MEMBERSHIP_CHANGED")]
  WorkspaceContentTargetMembershipChanged,
  #[graphql(name = "XWS_PUBLICATION_SERIALIZATION_CONFLICT")]
  PublicationSerializationConflict,
  #[graphql(name = "XWS_PUBLICATION_DEADLOCK")]
  PublicationDeadlock,
  #[graphql(name = "XWS_DATABASE_EDIT_CONFLICT")]
  DatabaseEditConflict,
  #[graphql(name = "XWS_DATABASE_IMPORT_CONFLICT")]
  DatabaseImportConflict,
  #[graphql(name = "XWS_MOVE_CONTENT_REVISION_CHANGED")]
  MoveContentRevisionChanged,
  #[graphql(name = "XWS_MOVE_RELATED_ROWS_CHANGED")]
  MoveRelatedRowsChanged,
  #[graphql(name = "XWS_MOVE_WORKSPACE_ROOT_CHANGED")]
  MoveWorkspaceRootChanged,
  #[graphql(name = "XWS_MOVE_HISTORY_REFERENCES_CHANGED")]
  MoveHistoryReferencesChanged,
  #[graphql(name = "XWS_MOVE_TAG_PLAN_CHANGED")]
  MoveTagPlanChanged,
  #[graphql(name = "XWS_MOVE_DATABASE_CONTENT_CHANGED")]
  MoveDatabaseContentChanged,
  #[graphql(name = "XWS_MOVE_ORGANIZER_REFERENCES_CHANGED")]
  MoveOrganizerReferencesChanged,
  #[graphql(name = "XWS_MOVE_BLOB_METADATA_CHANGED")]
  MoveBlobMetadataChanged,
  #[graphql(name = "XWS_MOVE_NATIVE_REFERENCE_PLAN_CHANGED")]
  MoveNativeReferencePlanChanged,
  #[graphql(name = "XWS_MOVE_DOCUMENT_IDENTITY_CHANGED")]
  MoveDocumentIdentityChanged,
  #[graphql(name = "XWS_MOVE_WORKSPACE_POLICY_CHANGED")]
  MoveWorkspacePolicyChanged,
  #[graphql(name = "XWS_MOVE_UNDO_FOLDER_CHANGED")]
  MoveUndoFolderChanged,
  #[graphql(name = "XWS_PREVIEW_CONFIRMATION_MISMATCH")]
  PreviewConfirmationMismatch,
  #[graphql(name = "XWS_LINK_INTENT_WORKSPACE_CHANGED")]
  LinkIntentWorkspaceChanged,
  #[graphql(name = "XWS_LINK_ORGANIZER_CHANGED")]
  LinkOrganizerChanged,
  #[graphql(name = "XWS_LINK_TARGET_UNAVAILABLE")]
  LinkTargetUnavailable,
  #[graphql(name = "XWS_NATIVE_REFERENCE_SNAPSHOT_CHANGED")]
  NativeReferenceSnapshotChanged,
  #[graphql(name = "XWS_NATIVE_REFERENCE_PLAN_MISSING")]
  NativeReferencePlanMissing,
  #[graphql(name = "XWS_NATIVE_REFERENCE_VERSION_UNSUPPORTED")]
  NativeReferenceVersionUnsupported,
  #[graphql(name = "XWS_TARGET_STORAGE_LIMIT")]
  TargetStorageLimit,
  #[graphql(name = "XWS_CANCELLATION_CLEANUP_REQUIRED")]
  CancellationCleanupRequired,
  #[graphql(name = "XWS_OPERATION_MISSING")]
  OperationMissing,
  #[graphql(name = "XWS_STORAGE_UNAVAILABLE")]
  XwsStorageUnavailable,
  #[graphql(name = "XWS_DATABASE_UNAVAILABLE")]
  XwsDatabaseUnavailable,
  #[graphql(name = "XWS_LINK_INTENT_MISSING")]
  XwsLinkIntentMissing,
  #[graphql(name = "XWS_SELECTED_RESOURCE_UNSUPPORTED")]
  XwsSelectedResourceUnsupported,
  #[graphql(name = "XWS_BLOB_INTEGRITY_MISMATCH")]
  XwsBlobIntegrityMismatch,
  #[graphql(name = "XWS_BLOB_SIZE_LIMIT")]
  XwsBlobSizeLimit,
  #[graphql(name = "XWS_STAGING_MANIFEST_INVALID")]
  XwsStagingManifestInvalid,
  #[graphql(name = "XWS_STAGING_REPLAY_CONFLICT")]
  XwsStagingReplayConflict,
  #[graphql(name = "XWS_DOCUMENT_SNAPSHOT_INVALID")]
  XwsDocumentSnapshotInvalid,
  #[graphql(name = "XWS_DOCUMENT_METADATA_INVALID")]
  XwsDocumentMetadataInvalid,
  #[graphql(name = "XWS_DATABASE_SNAPSHOT_INVALID")]
  XwsDatabaseSnapshotInvalid,
  #[graphql(name = "XWS_DATABASE_IDENTITY_INVALID")]
  XwsDatabaseIdentityInvalid,
  #[graphql(name = "XWS_MAPPING_PLAN_INVALID")]
  XwsMappingPlanInvalid,
  #[graphql(name = "XWS_SOURCE_TAG_INVALID")]
  XwsSourceTagInvalid,
  #[graphql(name = "XWS_TARGET_DEFINITION_CHANGED")]
  XwsTargetDefinitionChanged,
  #[graphql(name = "XWS_TARGET_DEFINITION_MISSING")]
  XwsTargetDefinitionMissing,
  #[graphql(name = "XWS_RELATION_TARGET_OUTSIDE_SELECTION")]
  XwsRelationTargetOutsideSelection,
  #[graphql(name = "XWS_RELATION_ROW_MISSING")]
  XwsRelationRowMissing,
  #[graphql(name = "XWS_RESOURCE_IDENTITY_AMBIGUOUS")]
  XwsResourceIdentityAmbiguous,
  #[graphql(name = "XWS_OWNED_BLOB_MAPPING_MISSING")]
  XwsOwnedBlobMappingMissing,
  #[graphql(name = "XWS_OWNED_DOCUMENT_MISSING")]
  XwsOwnedDocumentMissing,
  #[graphql(name = "XWS_ENCODING_FAILED")]
  XwsEncodingFailed,
  #[graphql(name = "XWS_INVENTORY_INVALID")]
  XwsInventoryInvalid,
  #[graphql(name = "XWS_INVENTORY_LIMIT")]
  XwsInventoryLimit,
  #[graphql(name = "XWS_BLOB_MATERIALIZATION_FAILED")]
  XwsBlobMaterializationFailed,
  #[graphql(name = "XWS_BLOB_COMPENSATION_FAILED")]
  XwsBlobCompensationFailed,
  #[graphql(name = "XWS_SOURCE_WORKSPACE_MISSING")]
  XwsSourceWorkspaceMissing,
  #[graphql(name = "XWS_REQUEST_INVALID")]
  XwsRequestInvalid,
  #[graphql(name = "XWS_GIT_SYNC_HANDOFF_UNAVAILABLE")]
  XwsGitSyncHandoffUnavailable,
  XwsGitSyncRemoteUnavailable,
  XwsGitSyncMetadataConflict,
  XwsGitSyncMetadataAuthDenied,
  XwsGitSyncOutboundCleanupPending,
  XwsGitSyncUndoPending,
  XwsGitSyncUndoOwnershipChanged,
  XwsGitSyncUndoContentChanged,
  XwsGitSyncUndoTargetNotEmpty,

  XwsPreflightStale,
  XwsWorkspaceNameConflict,
  XwsOwnershipUnsupported,
  XwsWorkerExecutionFailed,
  #[graphql(name = "XWS_PUBLICATION_KIND_INVALID")]
  XwsPublicationKindInvalid,
  #[graphql(name = "XWS_PUBLICATION_STATE_INVALID")]
  XwsPublicationStateInvalid,
  #[graphql(name = "XWS_PUBLICATION_MAPPINGS_EMPTY")]
  XwsPublicationMappingsEmpty,
  #[graphql(name = "XWS_EXTRACT_FOLDER_BINDING_INVALID")]
  XwsExtractFolderBindingInvalid,
  #[graphql(name = "XWS_PUBLICATION_STAGING_UNEXPECTED")]
  XwsPublicationStagingUnexpected,
  #[graphql(name = "XWS_DIAGNOSTIC_INSTANCE_INVALID")]
  XwsDiagnosticInstanceInvalid,
  #[graphql(name = "XWS_TARGET_WORKSPACE_MISSING")]
  XwsTargetWorkspaceMissing,
  #[graphql(name = "XWS_DISTINCT_WORKSPACES_REQUIRED")]
  XwsDistinctWorkspacesRequired,
  #[graphql(name = "XWS_RECIPIENTS_EMPTY")]
  XwsRecipientsEmpty,
  #[graphql(name = "XWS_RECIPIENT_BINDING_INVALID")]
  XwsRecipientBindingInvalid,
  #[graphql(name = "XWS_RECIPIENT_COUNT_INVALID")]
  XwsRecipientCountInvalid,
  #[graphql(name = "XWS_RECIPIENT_KINDS_INVALID")]
  XwsRecipientKindsInvalid,
  #[graphql(name = "XWS_RECIPIENT_REVISION_INVALID")]
  XwsRecipientRevisionInvalid,
  #[graphql(name = "XWS_RECIPIENT_DUPLICATE")]
  XwsRecipientDuplicate,
  #[graphql(name = "XWS_RECIPIENT_ACTOR_MISSING")]
  XwsRecipientActorMissing,
  #[graphql(name = "XWS_RECIPIENT_REPLAY_CONFLICT")]
  XwsRecipientReplayConflict,
  #[graphql(name = "XWS_BLOB_STAGING_ENTRY_MISSING")]
  XwsBlobStagingEntryMissing,
  #[graphql(name = "XWS_TARGET_BLOB_BYTES_CONFLICT")]
  XwsTargetBlobBytesConflict,
  #[graphql(name = "XWS_TARGET_BLOB_METADATA_CONFLICT")]
  XwsTargetBlobMetadataConflict,
  #[graphql(name = "XWS_TARGET_DOCUMENT_KEY_CONFLICT")]
  XwsTargetDocumentKeyConflict,
  #[graphql(name = "XWS_TAG_IDENTITY_CHANGED")]
  XwsTagIdentityChanged,
  #[graphql(name = "XWS_DATABASE_IDENTITY_CHANGED")]
  XwsDatabaseIdentityChanged,
  #[graphql(name = "XWS_COLLECTION_IDENTITY_CHANGED")]
  XwsCollectionIdentityChanged,
  #[graphql(name = "XWS_RESOURCE_COUNT_INVALID")]
  XwsResourceCountInvalid,
  #[graphql(name = "XWS_PUBLICATION_TERMINAL_CONFLICT")]
  XwsPublicationTerminalConflict,
  #[graphql(name = "XWS_SOURCE_DOCUMENT_MISSING")]
  XwsSourceDocumentMissing,
  #[graphql(name = "XWS_SOURCE_BLOB_MISSING")]
  XwsSourceBlobMissing,
  #[graphql(name = "XWS_SOURCE_TAG_MISSING")]
  XwsSourceTagMissing,
  #[graphql(name = "XWS_SOURCE_DATABASE_MISSING")]
  XwsSourceDatabaseMissing,
  #[graphql(name = "XWS_SOURCE_ROOT_MISSING")]
  XwsSourceRootMissing,
  #[graphql(name = "XWS_PUBLICATION_WORKSPACE_MISSING")]
  XwsPublicationWorkspaceMissing,
  #[graphql(name = "XWS_TAG_ASSIGNMENT_CONSTRAINT")]
  XwsTagAssignmentConstraint,
  #[graphql(name = "XWS_DATABASE_UNIQUE_CONSTRAINT")]
  XwsDatabaseUniqueConstraint,
  #[graphql(name = "XWS_DATABASE_FOREIGN_KEY_CONSTRAINT")]
  XwsDatabaseForeignKeyConstraint,
  #[graphql(name = "XWS_DATABASE_CHECK_CONSTRAINT")]
  XwsDatabaseCheckConstraint,
  #[graphql(name = "XWS_DATABASE_NOT_NULL_CONSTRAINT")]
  XwsDatabaseNotNullConstraint,
  #[graphql(name = "XWS_ORGANIZER_DECODE")]
  XwsOrganizerDecode,
  #[graphql(name = "XWS_ORGANIZER_MALFORMED_ROW")]
  XwsOrganizerMalformedRow,
  #[graphql(name = "XWS_ORGANIZER_FOLDER_MISSING")]
  XwsOrganizerFolderMissing,
  #[graphql(name = "XWS_ORGANIZER_ENTRY_MISSING")]
  XwsOrganizerEntryMissing,
  #[graphql(name = "XWS_ORGANIZER_PARENT_MISSING")]
  XwsOrganizerParentMissing,
  #[graphql(name = "XWS_ORGANIZER_CYCLE")]
  XwsOrganizerCycle,
  #[graphql(name = "XWS_ORGANIZER_DUPLICATE")]
  XwsOrganizerDuplicate,
  #[graphql(name = "XWS_ORGANIZER_NAME_INVALID")]
  XwsOrganizerNameInvalid,
  #[graphql(name = "XWS_ORGANIZER_LINK_TYPE_INVALID")]
  XwsOrganizerLinkTypeInvalid,
  #[graphql(name = "XWS_ORGANIZER_TARGET_INVALID")]
  XwsOrganizerTargetInvalid,
  #[graphql(name = "XWS_ORGANIZER_WORKSPACE_TARGET_INVALID")]
  XwsOrganizerWorkspaceTargetInvalid,
  #[graphql(name = "XWS_ORGANIZER_ENTRY_AT_ROOT")]
  XwsOrganizerEntryAtRoot,
  #[graphql(name = "XWS_ORGANIZER_MUTATION_EMPTY")]
  XwsOrganizerMutationEmpty,
  #[graphql(name = "XWS_ORGANIZER_ORDER_INVALID")]
  XwsOrganizerOrderInvalid,
  #[graphql(name = "XWS_ORGANIZER_REINDEX_REQUIRED")]
  XwsOrganizerReindexRequired,
  #[graphql(name = "XWS_ORGANIZER_REVISION_STALE")]
  XwsOrganizerRevisionStale,
  #[graphql(name = "XWS_ORGANIZER_KEY_INVALID")]
  XwsOrganizerKeyInvalid,
  #[graphql(name = "XWS_COLLECTION_DECODE")]
  XwsCollectionDecode,
  #[graphql(name = "XWS_WORKER_RETRY_EXHAUSTED")]
  XwsWorkerRetryExhausted,
  #[graphql(name = "XWS_UNEXPECTED_VALIDATION")]
  XwsUnexpectedValidation,
  #[graphql(name = "XWS_TRANSFER_FORBIDDEN")]
  XwsTransferForbidden,
}

impl From<WorkspaceContentErrorCode> for WorkspaceContentErrorCodeType {
  fn from(value: WorkspaceContentErrorCode) -> Self {
    match value {
      WorkspaceContentErrorCode::ExtractOperationRevisionChanged => Self::ExtractOperationRevisionChanged,
      WorkspaceContentErrorCode::ExtractTargetReplayChanged => Self::ExtractTargetReplayChanged,
      WorkspaceContentErrorCode::ExtractTargetLifecycleChanged => Self::ExtractTargetLifecycleChanged,
      WorkspaceContentErrorCode::ExtractMembershipSnapshotChanged => Self::ExtractMembershipSnapshotChanged,
      WorkspaceContentErrorCode::ExtractRecoveryTargetReceiptIsMissing => Self::ExtractRecoveryTargetReceiptIsMissing,
      WorkspaceContentErrorCode::PublishedExtractCannotBeCompensated => Self::PublishedExtractCannotBeCompensated,
      WorkspaceContentErrorCode::ExtractRecoveryStateChanged => Self::ExtractRecoveryStateChanged,
      WorkspaceContentErrorCode::ExtractRecoveryTargetLifecycleChanged => Self::ExtractRecoveryTargetLifecycleChanged,
      WorkspaceContentErrorCode::CopyTargetPolicyChanged => Self::CopyTargetPolicyChanged,
      WorkspaceContentErrorCode::CopyTargetPageDirectoryChanged => Self::CopyTargetPageDirectoryChanged,
      WorkspaceContentErrorCode::MoveRevisionManifestReplayChanged => Self::MoveRevisionManifestReplayChanged,
      WorkspaceContentErrorCode::MoveTagLineageRequiresAFreshPreview => Self::MoveTagLineageRequiresAFreshPreview,
      WorkspaceContentErrorCode::MoveReferencesRequireAFreshPreview => Self::MoveReferencesRequireAFreshPreview,
      WorkspaceContentErrorCode::MoveOperationRevisionChanged => Self::MoveOperationRevisionChanged,
      WorkspaceContentErrorCode::MoveTagLineageIsMissing => Self::MoveTagLineageIsMissing,
      WorkspaceContentErrorCode::MoveDatabaseRevisionIsMissing => Self::MoveDatabaseRevisionIsMissing,
      WorkspaceContentErrorCode::MoveDatabaseChildOwnershipChanged => Self::MoveDatabaseChildOwnershipChanged,
      WorkspaceContentErrorCode::MoveDocumentRevisionIsMissing => Self::MoveDocumentRevisionIsMissing,
      WorkspaceContentErrorCode::MoveDocumentClassificationsChanged => Self::MoveDocumentClassificationsChanged,
      WorkspaceContentErrorCode::MoveDocumentOwnershipChanged => Self::MoveDocumentOwnershipChanged,
      WorkspaceContentErrorCode::MoveDocumentChildCountIsMissing => Self::MoveDocumentChildCountIsMissing,
      WorkspaceContentErrorCode::MoveDocumentChildOwnershipChanged => Self::MoveDocumentChildOwnershipChanged,
      WorkspaceContentErrorCode::MoveReferenceSourceChanged => Self::MoveReferenceSourceChanged,
      WorkspaceContentErrorCode::MoveReferencePlanIsMissing => Self::MoveReferencePlanIsMissing,
      WorkspaceContentErrorCode::MoveTargetPageDirectoryChanged => Self::MoveTargetPageDirectoryChanged,
      WorkspaceContentErrorCode::ExtractTargetActivationChanged => Self::ExtractTargetActivationChanged,
      WorkspaceContentErrorCode::ExtractTargetReceiptChanged => Self::ExtractTargetReceiptChanged,
      WorkspaceContentErrorCode::ExtractBlobStagingStateChanged => Self::ExtractBlobStagingStateChanged,
      WorkspaceContentErrorCode::ExtractMembershipSnapshotIsInvalid => Self::ExtractMembershipSnapshotIsInvalid,
      WorkspaceContentErrorCode::ExtractRecipientSnapshotChanged => Self::ExtractRecipientSnapshotChanged,
      WorkspaceContentErrorCode::MoveRecipientSnapshotChanged => Self::MoveRecipientSnapshotChanged,
      WorkspaceContentErrorCode::MoveMappingChanged => Self::MoveMappingChanged,
      WorkspaceContentErrorCode::MovePersistedRevisionManifestChanged => Self::MovePersistedRevisionManifestChanged,
      WorkspaceContentErrorCode::PreparedTagIdentityWasRetired => Self::PreparedTagIdentityWasRetired,
      WorkspaceContentErrorCode::PreparedTagIsNoLongerReusable => Self::PreparedTagIsNoLongerReusable,
      WorkspaceContentErrorCode::ConcurrentTagIdentityIsNotReusable => Self::ConcurrentTagIdentityIsNotReusable,
      WorkspaceContentErrorCode::MovedTagCellDisappeared => Self::MovedTagCellDisappeared,
      WorkspaceContentErrorCode::MovedTagTemplateDisappeared => Self::MovedTagTemplateDisappeared,
      WorkspaceContentErrorCode::MovedTagFilterDisappeared => Self::MovedTagFilterDisappeared,
      WorkspaceContentErrorCode::MovedTagPredicateDisappeared => Self::MovedTagPredicateDisappeared,
      WorkspaceContentErrorCode::MovedTagFilterContainerChanged => Self::MovedTagFilterContainerChanged,
      WorkspaceContentErrorCode::OwnedTagClassificationChanged => Self::OwnedTagClassificationChanged,
      WorkspaceContentErrorCode::PlannedTagIdentityWasRetired => Self::PlannedTagIdentityWasRetired,
      WorkspaceContentErrorCode::PlannedTagIsNoLongerReusable => Self::PlannedTagIsNoLongerReusable,
      WorkspaceContentErrorCode::UndoHasNoCommittedOriginReceipt => Self::UndoHasNoCommittedOriginReceipt,
      WorkspaceContentErrorCode::UndoOriginLineageHashChanged => Self::UndoOriginLineageHashChanged,
      WorkspaceContentErrorCode::UndoTagLineageRequiresAFreshPreview => Self::UndoTagLineageRequiresAFreshPreview,
      WorkspaceContentErrorCode::UndoExtractHasNoMatchingPublishedFolderReceipt => {
        Self::UndoExtractHasNoMatchingPublishedFolderReceipt
      }
      WorkspaceContentErrorCode::MoveRevisionChangedDuringPublication => Self::MoveRevisionChangedDuringPublication,
      WorkspaceContentErrorCode::ExtractTargetWorkspaceIsMissing => Self::ExtractTargetWorkspaceIsMissing,
      WorkspaceContentErrorCode::ExtractTargetReceiptIsMissing => Self::ExtractTargetReceiptIsMissing,
      WorkspaceContentErrorCode::ExtractTargetLifecycleOwnershipChanged => Self::ExtractTargetLifecycleOwnershipChanged,
      WorkspaceContentErrorCode::ExtractTargetOwnershipChanged => Self::ExtractTargetOwnershipChanged,
      WorkspaceContentErrorCode::ExtractTargetRootChanged => Self::ExtractTargetRootChanged,
      WorkspaceContentErrorCode::MoveTargetMissing => Self::MoveTargetMissing,
      WorkspaceContentErrorCode::WorkspaceContentTargetMembershipChanged => {
        Self::WorkspaceContentTargetMembershipChanged
      }
      WorkspaceContentErrorCode::PublicationSerializationConflict => Self::PublicationSerializationConflict,
      WorkspaceContentErrorCode::PublicationDeadlock => Self::PublicationDeadlock,
      WorkspaceContentErrorCode::DatabaseEditConflict => Self::DatabaseEditConflict,
      WorkspaceContentErrorCode::DatabaseImportConflict => Self::DatabaseImportConflict,
      WorkspaceContentErrorCode::MoveContentRevisionChanged => Self::MoveContentRevisionChanged,
      WorkspaceContentErrorCode::MoveRelatedRowsChanged => Self::MoveRelatedRowsChanged,
      WorkspaceContentErrorCode::MoveWorkspaceRootChanged => Self::MoveWorkspaceRootChanged,
      WorkspaceContentErrorCode::MoveHistoryReferencesChanged => Self::MoveHistoryReferencesChanged,
      WorkspaceContentErrorCode::MoveTagPlanChanged => Self::MoveTagPlanChanged,
      WorkspaceContentErrorCode::MoveDatabaseContentChanged => Self::MoveDatabaseContentChanged,
      WorkspaceContentErrorCode::MoveOrganizerReferencesChanged => Self::MoveOrganizerReferencesChanged,
      WorkspaceContentErrorCode::MoveBlobMetadataChanged => Self::MoveBlobMetadataChanged,
      WorkspaceContentErrorCode::MoveNativeReferencePlanChanged => Self::MoveNativeReferencePlanChanged,
      WorkspaceContentErrorCode::MoveDocumentIdentityChanged => Self::MoveDocumentIdentityChanged,
      WorkspaceContentErrorCode::MoveWorkspacePolicyChanged => Self::MoveWorkspacePolicyChanged,
      WorkspaceContentErrorCode::MoveUndoFolderChanged => Self::MoveUndoFolderChanged,
      WorkspaceContentErrorCode::PreviewConfirmationMismatch => Self::PreviewConfirmationMismatch,
      WorkspaceContentErrorCode::LinkIntentWorkspaceChanged => Self::LinkIntentWorkspaceChanged,
      WorkspaceContentErrorCode::LinkOrganizerChanged => Self::LinkOrganizerChanged,
      WorkspaceContentErrorCode::LinkTargetUnavailable => Self::LinkTargetUnavailable,
      WorkspaceContentErrorCode::NativeReferenceSnapshotChanged => Self::NativeReferenceSnapshotChanged,
      WorkspaceContentErrorCode::NativeReferencePlanMissing => Self::NativeReferencePlanMissing,
      WorkspaceContentErrorCode::NativeReferenceVersionUnsupported => Self::NativeReferenceVersionUnsupported,
      WorkspaceContentErrorCode::TargetStorageLimit => Self::TargetStorageLimit,
      WorkspaceContentErrorCode::CancellationCleanupRequired => Self::CancellationCleanupRequired,
      WorkspaceContentErrorCode::OperationMissing => Self::OperationMissing,
      WorkspaceContentErrorCode::StorageUnavailable => Self::XwsStorageUnavailable,
      WorkspaceContentErrorCode::DatabaseUnavailable => Self::XwsDatabaseUnavailable,
      WorkspaceContentErrorCode::LinkIntentMissing => Self::XwsLinkIntentMissing,
      WorkspaceContentErrorCode::SelectedResourceUnsupported => Self::XwsSelectedResourceUnsupported,
      WorkspaceContentErrorCode::BlobIntegrityMismatch => Self::XwsBlobIntegrityMismatch,
      WorkspaceContentErrorCode::BlobSizeLimit => Self::XwsBlobSizeLimit,
      WorkspaceContentErrorCode::StagingManifestInvalid => Self::XwsStagingManifestInvalid,
      WorkspaceContentErrorCode::StagingReplayConflict => Self::XwsStagingReplayConflict,
      WorkspaceContentErrorCode::DocumentSnapshotInvalid => Self::XwsDocumentSnapshotInvalid,
      WorkspaceContentErrorCode::DocumentMetadataInvalid => Self::XwsDocumentMetadataInvalid,
      WorkspaceContentErrorCode::DatabaseSnapshotInvalid => Self::XwsDatabaseSnapshotInvalid,
      WorkspaceContentErrorCode::DatabaseIdentityInvalid => Self::XwsDatabaseIdentityInvalid,
      WorkspaceContentErrorCode::MappingPlanInvalid => Self::XwsMappingPlanInvalid,
      WorkspaceContentErrorCode::SourceTagInvalid => Self::XwsSourceTagInvalid,
      WorkspaceContentErrorCode::TargetDefinitionChanged => Self::XwsTargetDefinitionChanged,
      WorkspaceContentErrorCode::TargetDefinitionMissing => Self::XwsTargetDefinitionMissing,
      WorkspaceContentErrorCode::RelationTargetOutsideSelection => Self::XwsRelationTargetOutsideSelection,
      WorkspaceContentErrorCode::RelationRowMissing => Self::XwsRelationRowMissing,
      WorkspaceContentErrorCode::ResourceIdentityAmbiguous => Self::XwsResourceIdentityAmbiguous,
      WorkspaceContentErrorCode::OwnedBlobMappingMissing => Self::XwsOwnedBlobMappingMissing,
      WorkspaceContentErrorCode::OwnedDocumentMissing => Self::XwsOwnedDocumentMissing,
      WorkspaceContentErrorCode::EncodingFailed => Self::XwsEncodingFailed,
      WorkspaceContentErrorCode::InventoryInvalid => Self::XwsInventoryInvalid,
      WorkspaceContentErrorCode::InventoryLimit => Self::XwsInventoryLimit,
      WorkspaceContentErrorCode::BlobMaterializationFailed => Self::XwsBlobMaterializationFailed,
      WorkspaceContentErrorCode::BlobCompensationFailed => Self::XwsBlobCompensationFailed,
      WorkspaceContentErrorCode::SourceWorkspaceMissing => Self::XwsSourceWorkspaceMissing,
      WorkspaceContentErrorCode::RequestInvalid => Self::XwsRequestInvalid,
      WorkspaceContentErrorCode::GitSyncHandoffUnavailable => Self::XwsGitSyncHandoffUnavailable,
      WorkspaceContentErrorCode::GitSyncRemoteUnavailable => Self::XwsGitSyncRemoteUnavailable,
      WorkspaceContentErrorCode::GitSyncMetadataConflict => Self::XwsGitSyncMetadataConflict,
      WorkspaceContentErrorCode::GitSyncMetadataAuthDenied => Self::XwsGitSyncMetadataAuthDenied,
      WorkspaceContentErrorCode::GitSyncOutboundCleanupPending => Self::XwsGitSyncOutboundCleanupPending,
      WorkspaceContentErrorCode::GitSyncUndoPending => Self::XwsGitSyncUndoPending,
      WorkspaceContentErrorCode::GitSyncUndoOwnershipChanged => Self::XwsGitSyncUndoOwnershipChanged,
      WorkspaceContentErrorCode::GitSyncUndoContentChanged => Self::XwsGitSyncUndoContentChanged,
      WorkspaceContentErrorCode::GitSyncUndoTargetNotEmpty => Self::XwsGitSyncUndoTargetNotEmpty,
      WorkspaceContentErrorCode::PreflightStale => Self::XwsPreflightStale,
      WorkspaceContentErrorCode::OperationStateInvalid => Self::OperationStateInvalid,
      WorkspaceContentErrorCode::MoveDocumentMetadataChanged => Self::MoveDocumentMetadataChanged,
      WorkspaceContentErrorCode::MoveDocumentAclChanged => Self::MoveDocumentAclChanged,
      WorkspaceContentErrorCode::WorkspaceNameConflict => Self::XwsWorkspaceNameConflict,
      WorkspaceContentErrorCode::OwnershipUnsupported => Self::XwsOwnershipUnsupported,
      WorkspaceContentErrorCode::WorkerExecutionFailed => Self::XwsWorkerExecutionFailed,
      WorkspaceContentErrorCode::PublicationKindInvalid => Self::XwsPublicationKindInvalid,
      WorkspaceContentErrorCode::PublicationStateInvalid => Self::XwsPublicationStateInvalid,
      WorkspaceContentErrorCode::PublicationMappingsEmpty => Self::XwsPublicationMappingsEmpty,
      WorkspaceContentErrorCode::ExtractFolderBindingInvalid => Self::XwsExtractFolderBindingInvalid,
      WorkspaceContentErrorCode::PublicationStagingUnexpected => Self::XwsPublicationStagingUnexpected,
      WorkspaceContentErrorCode::DiagnosticInstanceInvalid => Self::XwsDiagnosticInstanceInvalid,
      WorkspaceContentErrorCode::TargetWorkspaceMissing => Self::XwsTargetWorkspaceMissing,
      WorkspaceContentErrorCode::DistinctWorkspacesRequired => Self::XwsDistinctWorkspacesRequired,
      WorkspaceContentErrorCode::RecipientsEmpty => Self::XwsRecipientsEmpty,
      WorkspaceContentErrorCode::RecipientBindingInvalid => Self::XwsRecipientBindingInvalid,
      WorkspaceContentErrorCode::RecipientCountInvalid => Self::XwsRecipientCountInvalid,
      WorkspaceContentErrorCode::RecipientKindsInvalid => Self::XwsRecipientKindsInvalid,
      WorkspaceContentErrorCode::RecipientRevisionInvalid => Self::XwsRecipientRevisionInvalid,
      WorkspaceContentErrorCode::RecipientDuplicate => Self::XwsRecipientDuplicate,
      WorkspaceContentErrorCode::RecipientActorMissing => Self::XwsRecipientActorMissing,
      WorkspaceContentErrorCode::RecipientReplayConflict => Self::XwsRecipientReplayConflict,
      WorkspaceContentErrorCode::BlobStagingEntryMissing => Self::XwsBlobStagingEntryMissing,
      WorkspaceContentErrorCode::TargetBlobBytesConflict => Self::XwsTargetBlobBytesConflict,
      WorkspaceContentErrorCode::TargetBlobMetadataConflict => Self::XwsTargetBlobMetadataConflict,
      WorkspaceContentErrorCode::TargetDocumentKeyConflict => Self::XwsTargetDocumentKeyConflict,
      WorkspaceContentErrorCode::TagIdentityChanged => Self::XwsTagIdentityChanged,
      WorkspaceContentErrorCode::DatabaseIdentityChanged => Self::XwsDatabaseIdentityChanged,
      WorkspaceContentErrorCode::CollectionIdentityChanged => Self::XwsCollectionIdentityChanged,
      WorkspaceContentErrorCode::ResourceCountInvalid => Self::XwsResourceCountInvalid,
      WorkspaceContentErrorCode::PublicationTerminalConflict => Self::XwsPublicationTerminalConflict,
      WorkspaceContentErrorCode::SourceDocumentMissing => Self::XwsSourceDocumentMissing,
      WorkspaceContentErrorCode::SourceBlobMissing => Self::XwsSourceBlobMissing,
      WorkspaceContentErrorCode::SourceTagMissing => Self::XwsSourceTagMissing,
      WorkspaceContentErrorCode::SourceDatabaseMissing => Self::XwsSourceDatabaseMissing,
      WorkspaceContentErrorCode::SourceRootMissing => Self::XwsSourceRootMissing,
      WorkspaceContentErrorCode::PublicationWorkspaceMissing => Self::XwsPublicationWorkspaceMissing,
      WorkspaceContentErrorCode::TagAssignmentConstraint => Self::XwsTagAssignmentConstraint,
      WorkspaceContentErrorCode::DatabaseUniqueConstraint => Self::XwsDatabaseUniqueConstraint,
      WorkspaceContentErrorCode::DatabaseForeignKeyConstraint => Self::XwsDatabaseForeignKeyConstraint,
      WorkspaceContentErrorCode::DatabaseCheckConstraint => Self::XwsDatabaseCheckConstraint,
      WorkspaceContentErrorCode::DatabaseNotNullConstraint => Self::XwsDatabaseNotNullConstraint,
      WorkspaceContentErrorCode::OrganizerDecode => Self::XwsOrganizerDecode,
      WorkspaceContentErrorCode::OrganizerMalformedRow => Self::XwsOrganizerMalformedRow,
      WorkspaceContentErrorCode::OrganizerFolderMissing => Self::XwsOrganizerFolderMissing,
      WorkspaceContentErrorCode::OrganizerEntryMissing => Self::XwsOrganizerEntryMissing,
      WorkspaceContentErrorCode::OrganizerParentMissing => Self::XwsOrganizerParentMissing,
      WorkspaceContentErrorCode::OrganizerCycle => Self::XwsOrganizerCycle,
      WorkspaceContentErrorCode::OrganizerDuplicate => Self::XwsOrganizerDuplicate,
      WorkspaceContentErrorCode::OrganizerNameInvalid => Self::XwsOrganizerNameInvalid,
      WorkspaceContentErrorCode::OrganizerLinkTypeInvalid => Self::XwsOrganizerLinkTypeInvalid,
      WorkspaceContentErrorCode::OrganizerTargetInvalid => Self::XwsOrganizerTargetInvalid,
      WorkspaceContentErrorCode::OrganizerWorkspaceTargetInvalid => Self::XwsOrganizerWorkspaceTargetInvalid,
      WorkspaceContentErrorCode::OrganizerEntryAtRoot => Self::XwsOrganizerEntryAtRoot,
      WorkspaceContentErrorCode::OrganizerMutationEmpty => Self::XwsOrganizerMutationEmpty,
      WorkspaceContentErrorCode::OrganizerOrderInvalid => Self::XwsOrganizerOrderInvalid,
      WorkspaceContentErrorCode::OrganizerReindexRequired => Self::XwsOrganizerReindexRequired,
      WorkspaceContentErrorCode::OrganizerRevisionStale => Self::XwsOrganizerRevisionStale,
      WorkspaceContentErrorCode::OrganizerKeyInvalid => Self::XwsOrganizerKeyInvalid,
      WorkspaceContentErrorCode::CollectionDecode => Self::XwsCollectionDecode,
      WorkspaceContentErrorCode::WorkerRetryExhausted => Self::XwsWorkerRetryExhausted,
      WorkspaceContentErrorCode::UnexpectedValidation => Self::XwsUnexpectedValidation,
      WorkspaceContentErrorCode::TransferForbidden => Self::XwsTransferForbidden,
    }
  }
}

#[derive(Debug, SimpleObject, Clone)]
pub struct WorkspaceContentOperationType {
  pub id: Uuid,
  pub kind: WorkspaceContentOperationKindType,
  pub source_workspace_id: Uuid,
  pub target_workspace_id: Option<Uuid>,
  pub status: WorkspaceContentOperationStatusType,
  pub revision: Option<String>,
  pub error_code: Option<WorkspaceContentErrorCodeType>,
  pub error_message: Option<String>,
  /// Actual failing boundary; older operation records can have no phase.
  pub error_phase: Option<String>,
  pub origin_operation_id: Option<Uuid>,
  /// Content success is independent from outstanding external Git metadata.
  pub git_sync_pending: bool,
  pub git_sync_error_code: Option<WorkspaceContentErrorCodeType>,
  pub git_sync_retry_exhausted: bool,
  pub git_sync: Option<WorkspaceContentGitSyncPreflightType>,
}

impl WorkspaceContentOperationType {
  pub fn from_projection(
    projection: myoxus_application::workspace_content_operation::WorkspaceContentOperationStatusProjection,
  ) -> Self {
    let mut result = Self::from_record(projection.record, projection.origin_operation_id);
    if let Some(git) = projection.git_sync {
      result.git_sync_pending = git.pending;
      result.git_sync_error_code = git.error_code.map(Into::into);
      result.git_sync_retry_exhausted = git.retry_exhausted;
      result.git_sync = Some((&git.summary).into());
    }
    result
  }
  pub fn from_record(record: WorkspaceContentOperationRecord, origin_operation_id: Option<Uuid>) -> Self {
    Self {
      id: record.id,
      kind: record.kind.into(),
      source_workspace_id: record.source_workspace_id,
      target_workspace_id: record.target_workspace_id,
      status: record.status.into(),
      revision: record.preview_revision,
      error_code: record.error.as_ref().map(|error| error.code.into()),
      error_phase: record.error.as_ref().and_then(|error| error.phase.clone()),
      error_message: record.error.map(|error| error.message().to_string()),
      origin_operation_id,
      git_sync_pending: false,
      git_sync_error_code: None,
      git_sync_retry_exhausted: false,
      git_sync: None,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum WorkspaceContentBlockerType {
  PermissionDenied,
  BrokenReference,
  TargetPolicy,
  MembershipPermission,
  PublicShareConflict,
  WorkspaceNameConflict,
  OwnershipUnsupported,
  ExternalDeployment,
  GitSyncScopeAmbiguous,
  GitSyncOwnershipUnproven,
  GitSyncConflicts,
  GitSyncManagementDenied,
  GitSyncBusy,
  GitSyncHandoffUnavailable,
}

impl From<WorkspaceContentBlocker> for WorkspaceContentBlockerType {
  fn from(value: WorkspaceContentBlocker) -> Self {
    match value {
      WorkspaceContentBlocker::PermissionDenied => Self::PermissionDenied,
      WorkspaceContentBlocker::BrokenReference => Self::BrokenReference,
      WorkspaceContentBlocker::TargetPolicy => Self::TargetPolicy,
      WorkspaceContentBlocker::MembershipPermission => Self::MembershipPermission,
      WorkspaceContentBlocker::PublicShareConflict => Self::PublicShareConflict,
      WorkspaceContentBlocker::WorkspaceNameConflict => Self::WorkspaceNameConflict,
      WorkspaceContentBlocker::OwnershipUnsupported => Self::OwnershipUnsupported,
      WorkspaceContentBlocker::ExternalDeployment => Self::ExternalDeployment,
      WorkspaceContentBlocker::GitSyncScopeAmbiguous => Self::GitSyncScopeAmbiguous,
      WorkspaceContentBlocker::GitSyncOwnershipUnproven => Self::GitSyncOwnershipUnproven,
      WorkspaceContentBlocker::GitSyncConflicts => Self::GitSyncConflicts,
      WorkspaceContentBlocker::GitSyncManagementDenied => Self::GitSyncManagementDenied,
      WorkspaceContentBlocker::GitSyncBusy => Self::GitSyncBusy,
      WorkspaceContentBlocker::GitSyncHandoffUnavailable => Self::GitSyncHandoffUnavailable,
    }
  }
}

#[derive(Debug, SimpleObject, Clone)]
pub struct WorkspaceContentResourceType {
  pub workspace_id: Uuid,
  pub kind: WorkspaceContentResourceKindType,
  pub id: String,
}

impl From<&WorkspaceContentResourceRef> for WorkspaceContentResourceType {
  fn from(value: &WorkspaceContentResourceRef) -> Self {
    Self {
      workspace_id: value.workspace_id(),
      kind: value.kind().into(),
      id: value.resource_id().to_string(),
    }
  }
}

#[derive(Debug, SimpleObject, Clone)]
pub struct WorkspaceContentConfirmationType {
  pub kind: WorkspaceContentConfirmationKindType,
  pub user_id: Option<Uuid>,
  pub role: Option<WorkspaceRole>,
  pub resource: Option<WorkspaceContentResourceType>,
}

impl From<&WorkspaceContentConfirmation> for WorkspaceContentConfirmationType {
  fn from(value: &WorkspaceContentConfirmation) -> Self {
    match value {
      WorkspaceContentConfirmation::AddTargetMember { membership } => Self {
        kind: WorkspaceContentConfirmationKindType::AddTargetMember,
        user_id: Some(membership.user_id()),
        role: Some(membership.role().into()),
        resource: None,
      },
      WorkspaceContentConfirmation::CopyDocumentAcl { resource } => Self {
        kind: WorkspaceContentConfirmationKindType::CopyDocumentAcl,
        user_id: None,
        role: None,
        resource: Some(resource.into()),
      },
      WorkspaceContentConfirmation::DisablePublicShare { resource } => Self {
        kind: WorkspaceContentConfirmationKindType::DisablePublicShare,
        user_id: None,
        role: None,
        resource: Some(resource.into()),
      },
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum WorkspaceContentRequiredCapabilityType {
  UsersManage,
  AdministratorsManage,
}

impl WorkspaceContentRequiredCapabilityType {
  fn from_action(value: WorkspaceAction) -> AuthResult<Self> {
    match value {
      WorkspaceAction::UsersManage => Ok(Self::UsersManage),
      WorkspaceAction::AdministratorsManage => Ok(Self::AdministratorsManage),
      _ => Err(AuthError::InvalidInput(
        "workspace content membership capability is invalid".to_string(),
      )),
    }
  }
}

#[derive(Debug, SimpleObject, Clone)]
pub struct WorkspaceContentMembershipImpactType {
  pub user_id: Uuid,
  pub current_role: Option<WorkspaceRole>,
  pub required_role: WorkspaceRole,
  pub required_capability: WorkspaceContentRequiredCapabilityType,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum WorkspaceContentConflictKindType {
  Key,
  Schema,
  PublicSharing,
}

impl From<WorkspaceContentConflictKind> for WorkspaceContentConflictKindType {
  fn from(value: WorkspaceContentConflictKind) -> Self {
    match value {
      WorkspaceContentConflictKind::Key => Self::Key,
      WorkspaceContentConflictKind::Schema => Self::Schema,
      WorkspaceContentConflictKind::PublicSharing => Self::PublicSharing,
    }
  }
}

#[derive(Debug, SimpleObject, Clone)]
pub struct WorkspaceContentConflictType {
  pub kind: WorkspaceContentConflictKindType,
  pub resource: WorkspaceContentResourceType,
  pub suggested_name: Option<String>,
}

#[derive(Debug, SimpleObject, Clone)]
pub struct WorkspaceContentKindCountType {
  pub kind: WorkspaceContentResourceKindType,
  pub count: i32,
}

#[derive(Debug, SimpleObject, Clone)]
pub struct WorkspaceContentGitSyncPreflightType {
  pub is_undo: bool,
  pub choice: WorkspaceContentGitSyncChoiceType,
  pub repository: String,
  pub branch: String,
  pub source_profile_id: Uuid,
  pub new_root: String,
  pub own_manifest: String,
  pub intended_enabled: bool,
}

impl From<&myoxus_application::workspace_content_operation::WorkspaceContentGitSyncPlan>
  for WorkspaceContentGitSyncPreflightType
{
  fn from(plan: &myoxus_application::workspace_content_operation::WorkspaceContentGitSyncPlan) -> Self {
    Self::from(&myoxus_application::workspace_content_operation::WorkspaceContentGitSyncSummary::from(plan))
  }
}

impl From<&myoxus_application::workspace_content_operation::WorkspaceContentGitSyncSummary>
  for WorkspaceContentGitSyncPreflightType
{
  fn from(plan: &myoxus_application::workspace_content_operation::WorkspaceContentGitSyncSummary) -> Self {
    Self {
      is_undo: plan.is_undo,
      choice: plan.choice.into(),
      repository: plan.repository.clone(),
      branch: plan.branch.clone(),
      source_profile_id: plan.source_profile_id,
      new_root: plan.new_root.clone(),
      own_manifest: plan.own_manifest.clone(),
      intended_enabled: plan.intended_enabled,
    }
  }
}

#[derive(Debug, SimpleObject, Clone)]
pub struct WorkspaceContentPreflightType {
  pub operation: WorkspaceContentOperationType,
  pub revision: String,
  pub blockers: Vec<WorkspaceContentBlockerType>,
  pub git_sync: Option<WorkspaceContentGitSyncPreflightType>,
  /// Identities only: preflight may be denied read permission on a linked
  /// resource, so titles and content are never projected in blocker details.
  pub missing_resources: Vec<WorkspaceContentResourceType>,
  pub required_confirmations: Vec<WorkspaceContentConfirmationType>,
  pub membership_impacts: Vec<WorkspaceContentMembershipImpactType>,
  pub conflicts: Vec<WorkspaceContentConflictType>,
  pub resource_counts: Vec<WorkspaceContentKindCountType>,
  pub resource_count: i32,
  pub membership_impact_count: i32,
}

impl WorkspaceContentPreflightType {
  pub fn from_result(result: WorkspaceContentPreflightResult, origin_operation_id: Option<Uuid>) -> AuthResult<Self> {
    let preflight = result.preflight;
    let membership_impacts = preflight
      .membership_impacts
      .iter()
      .map(|impact| {
        Ok(WorkspaceContentMembershipImpactType {
          user_id: impact.impact.user_id,
          current_role: impact.impact.current_role.map(Into::into),
          required_role: impact.impact.required_role.into(),
          required_capability: WorkspaceContentRequiredCapabilityType::from_action(impact.required_action)?,
        })
      })
      .collect::<AuthResult<Vec<_>>>()?;
    Ok(Self {
      operation: WorkspaceContentOperationType::from_record(result.operation, origin_operation_id),
      revision: preflight.revision,
      blockers: preflight.blockers.iter().copied().map(Into::into).collect(),
      git_sync: if preflight.blockers.contains(&WorkspaceContentBlocker::PermissionDenied)
        || preflight
          .blockers
          .contains(&WorkspaceContentBlocker::GitSyncManagementDenied)
      {
        None
      } else {
        preflight.git_sync_plan.as_ref().map(Into::into)
      },
      missing_resources: if preflight.blockers.contains(&WorkspaceContentBlocker::PermissionDenied) {
        // Do not expose graph-derived identities from content the actor cannot read.
        Vec::new()
      } else {
        // Contained omissions are executable, not a request to repair the source.
        preflight.graph.missing_resources.iter().map(Into::into).collect()
      },
      required_confirmations: preflight.required_confirmations.iter().map(Into::into).collect(),
      membership_impact_count: i32::try_from(membership_impacts.len()).unwrap_or(i32::MAX),
      membership_impacts,
      conflicts: preflight
        .graph
        .conflicts
        .iter()
        .map(|conflict| WorkspaceContentConflictType {
          kind: conflict.kind.into(),
          resource: (&conflict.resource).into(),
          suggested_name: conflict.suggested_name.clone(),
        })
        .collect(),
      resource_counts: preflight
        .graph
        .kind_counts
        .iter()
        .map(|count| WorkspaceContentKindCountType {
          kind: count.kind.into(),
          count: i32::try_from(count.count).unwrap_or(i32::MAX),
        })
        .collect(),
      resource_count: i32::try_from(preflight.graph.resources.len()).unwrap_or(i32::MAX),
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn operation_causes_reach_clients_without_widening_the_error_category() {
    let cause = WorkspaceContentErrorCode::StagingManifestInvalid;
    let projected = map_workspace_content_error(AuthError::InvalidInput(cause.as_str().into()));
    let extensions = projected.extensions.as_ref().unwrap();
    assert_eq!(
      extensions.get("name"),
      Some(&async_graphql::Value::from(cause.as_str()))
    );
    assert_eq!(extensions.get("code"), Some(&async_graphql::Value::from("BAD REQUEST")));
    assert_eq!(projected.message, cause.safe_message().unwrap());

    let projected = map_workspace_content_error(AuthError::Storage("credential-adjacent dependency detail".into()));
    assert_eq!(
      projected.message,
      WorkspaceContentErrorCode::StorageUnavailable.safe_message().unwrap()
    );
    assert!(!format!("{projected:?}").contains("credential-adjacent"));
  }
}
