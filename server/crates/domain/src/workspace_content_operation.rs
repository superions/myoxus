// SPDX-License-Identifier: AGPL-3.0-or-later

//! Transport-neutral contracts for cross-workspace content operations.
//!
//! These types contain durable product identities and decisions only. They
//! deliberately have no API-node, queue, route, credential, or payload fields;
//! persistence and transport projections are owned by later layers.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::entities::WorkspaceRole;
use crate::ids::{UserId, WorkspaceContentOperationId, WorkspaceId};

const MAX_RESOURCE_ID_BYTES: usize = 512;
const MAX_STAGING_KEY_BYTES: usize = 1024;
const SHA256_HEX_BYTES: usize = 64;
const MAX_STAGED_OBJECT_BYTES: i64 = 8 * 1024 * 1024 * 1024;
const MAX_REDACTED_ERROR_BYTES: usize = 512;

/// Supported cross-workspace operation families.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceContentOperationKind {
  Move,
  Copy,
  Link,
  ExtractFolder,
}

impl WorkspaceContentOperationKind {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Move => "move",
      Self::Copy => "copy",
      Self::Link => "link",
      Self::ExtractFolder => "extract_folder",
    }
  }
}

/// Resource families understood by the dependency manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceContentResourceKind {
  Document,
  Database,
  Collection,
  Folder,
  Tag,
  Blob,
}

impl WorkspaceContentResourceKind {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Document => "document",
      Self::Database => "database",
      Self::Collection => "collection",
      Self::Folder => "folder",
      Self::Tag => "tag",
      Self::Blob => "blob",
    }
  }
}

/// A resource identity qualified by its authoritative workspace.
///
/// The resource id remains textual because document keys and folder row ids
/// are not universally UUIDs. Construction rejects ambiguous whitespace,
/// missing ids, nil workspaces, and unbounded input.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentResourceRef {
  workspace_id: Uuid,
  kind: WorkspaceContentResourceKind,
  resource_id: String,
}

impl WorkspaceContentResourceRef {
  pub fn new(
    workspace_id: Uuid,
    kind: WorkspaceContentResourceKind,
    resource_id: impl Into<String>,
  ) -> Result<Self, WorkspaceContentDomainError> {
    let resource_id = resource_id.into();
    if workspace_id.is_nil() {
      return Err(WorkspaceContentDomainError::MissingWorkspaceQualification);
    }
    if resource_id.is_empty()
      || resource_id.trim() != resource_id
      || resource_id.len() > MAX_RESOURCE_ID_BYTES
      || resource_id.chars().any(char::is_control)
    {
      return Err(WorkspaceContentDomainError::InvalidResourceId);
    }
    Ok(Self {
      workspace_id,
      kind,
      resource_id,
    })
  }

  pub const fn workspace_id(&self) -> Uuid {
    self.workspace_id
  }

  pub const fn kind(&self) -> WorkspaceContentResourceKind {
    self.kind
  }

  pub fn resource_id(&self) -> &str {
    &self.resource_id
  }
}

/// Durable operation state. Publication details remain an application concern.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceContentOperationStatus {
  Draft,
  Previewed,
  Queued,
  Running,
  Succeeded,
  Cancelled,
  Failed,
  CleanupRequired,
}

impl WorkspaceContentOperationStatus {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Draft => "draft",
      Self::Previewed => "previewed",
      Self::Queued => "queued",
      Self::Running => "running",
      Self::Succeeded => "succeeded",
      Self::Cancelled => "cancelled",
      Self::Failed => "failed",
      Self::CleanupRequired => "cleanup_required",
    }
  }

  /// Return whether the durable state machine permits a transition.
  ///
  /// A running operation may be cancelled only while the application service
  /// proves that publication has not occurred.
  /// Completed failure compensation moves directly from cleanup to failed;
  /// it must not re-enter running publication merely to terminalize cleanup.
  pub const fn can_transition_to(self, next: Self) -> bool {
    matches!(
      (self, next),
      (Self::Draft, Self::Previewed | Self::Cancelled | Self::Failed)
        | (Self::Previewed, Self::Queued | Self::Cancelled | Self::Failed)
        | (Self::Queued, Self::Running | Self::Cancelled | Self::Failed)
        | (
          Self::Running,
          Self::Running | Self::Succeeded | Self::Cancelled | Self::Failed | Self::CleanupRequired
        )
        | (Self::Failed, Self::Queued)
        | (Self::Cancelled, Self::CleanupRequired)
        | (Self::CleanupRequired, Self::Running | Self::Cancelled | Self::Failed)
    )
  }
}

/// Explicit user decisions accepted from a matching preflight revision.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceContentConfirmation {
  AddTargetMember {
    membership: TargetMembershipConfirmation,
  },
  CopyDocumentAcl {
    resource: WorkspaceContentResourceRef,
  },
  /// Historical decoding only; publication now applies destination policy.
  DisablePublicShare {
    resource: WorkspaceContentResourceRef,
  },
}

/// A target membership impact that the actor must confirm explicitly.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetMembershipConfirmation {
  user_id: Uuid,
  role: WorkspaceRole,
}

impl TargetMembershipConfirmation {
  pub fn new(user_id: Uuid, role: WorkspaceRole) -> Result<Self, WorkspaceContentDomainError> {
    if user_id.is_nil() {
      return Err(WorkspaceContentDomainError::InvalidUserId);
    }
    if role == WorkspaceRole::Owner {
      return Err(WorkspaceContentDomainError::HumanOwnerMembershipForbidden);
    }
    Ok(Self { user_id, role })
  }

  pub const fn user_id(&self) -> Uuid {
    self.user_id
  }

  pub const fn role(&self) -> WorkspaceRole {
    self.role
  }
}

/// Stable preflight blockers. Details belong to redacted projections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceContentBlocker {
  PermissionDenied,
  BrokenReference,
  TargetPolicy,
  MembershipPermission,
  /// Historical display only; sharing differences are resolved at publication.
  PublicShareConflict,
  WorkspaceNameConflict,
  OwnershipUnsupported,
  ExternalDeployment,
  GitSyncScopeAmbiguous,
  GitSyncOwnershipUnproven,
  GitSyncConflicts,
  GitSyncManagementDenied,
  GitSyncBusy,
  /// Extract cannot publish a Git-enabled scope until its durable SQL handoff exists.
  GitSyncHandoffUnavailable,
}

/// Stable public error codes shared by GraphQL, workers, and clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WorkspaceContentErrorCode {
  #[serde(rename = "XWS_TARGET_STORAGE_LIMIT")]
  TargetStorageLimit,
  #[serde(rename = "XWS_CANCELLATION_CLEANUP_REQUIRED")]
  CancellationCleanupRequired,
  #[serde(rename = "XWS_OPERATION_MISSING")]
  OperationMissing,
  #[serde(rename = "XWS_STORAGE_UNAVAILABLE")]
  StorageUnavailable,
  #[serde(rename = "XWS_DATABASE_UNAVAILABLE")]
  DatabaseUnavailable,
  #[serde(rename = "XWS_LINK_INTENT_MISSING")]
  LinkIntentMissing,
  #[serde(rename = "XWS_SELECTED_RESOURCE_UNSUPPORTED")]
  SelectedResourceUnsupported,
  #[serde(rename = "XWS_BLOB_INTEGRITY_MISMATCH")]
  BlobIntegrityMismatch,
  #[serde(rename = "XWS_BLOB_SIZE_LIMIT")]
  BlobSizeLimit,
  #[serde(rename = "XWS_STAGING_MANIFEST_INVALID")]
  StagingManifestInvalid,
  #[serde(rename = "XWS_STAGING_REPLAY_CONFLICT")]
  StagingReplayConflict,
  #[serde(rename = "XWS_DOCUMENT_SNAPSHOT_INVALID")]
  DocumentSnapshotInvalid,
  #[serde(rename = "XWS_DOCUMENT_METADATA_INVALID")]
  DocumentMetadataInvalid,
  #[serde(rename = "XWS_DATABASE_SNAPSHOT_INVALID")]
  DatabaseSnapshotInvalid,
  #[serde(rename = "XWS_DATABASE_IDENTITY_INVALID")]
  DatabaseIdentityInvalid,
  #[serde(rename = "XWS_MAPPING_PLAN_INVALID")]
  MappingPlanInvalid,
  #[serde(rename = "XWS_SOURCE_TAG_INVALID")]
  SourceTagInvalid,
  #[serde(rename = "XWS_TARGET_DEFINITION_CHANGED")]
  TargetDefinitionChanged,
  #[serde(rename = "XWS_TARGET_DEFINITION_MISSING")]
  TargetDefinitionMissing,
  #[serde(rename = "XWS_RELATION_TARGET_OUTSIDE_SELECTION")]
  RelationTargetOutsideSelection,
  #[serde(rename = "XWS_RELATION_ROW_MISSING")]
  RelationRowMissing,
  #[serde(rename = "XWS_RESOURCE_IDENTITY_AMBIGUOUS")]
  ResourceIdentityAmbiguous,
  #[serde(rename = "XWS_OWNED_BLOB_MAPPING_MISSING")]
  OwnedBlobMappingMissing,
  #[serde(rename = "XWS_OWNED_DOCUMENT_MISSING")]
  OwnedDocumentMissing,
  #[serde(rename = "XWS_ENCODING_FAILED")]
  EncodingFailed,
  #[serde(rename = "XWS_INVENTORY_INVALID")]
  InventoryInvalid,
  #[serde(rename = "XWS_INVENTORY_LIMIT")]
  InventoryLimit,
  #[serde(rename = "XWS_BLOB_MATERIALIZATION_FAILED")]
  BlobMaterializationFailed,
  #[serde(rename = "XWS_BLOB_COMPENSATION_FAILED")]
  BlobCompensationFailed,
  #[serde(rename = "XWS_SOURCE_WORKSPACE_MISSING")]
  SourceWorkspaceMissing,
  #[serde(rename = "XWS_REQUEST_INVALID")]
  RequestInvalid,
  #[serde(rename = "XWS_GIT_SYNC_HANDOFF_UNAVAILABLE")]
  GitSyncHandoffUnavailable,
  #[serde(rename = "XWS_GIT_SYNC_REMOTE_UNAVAILABLE")]
  GitSyncRemoteUnavailable,
  #[serde(rename = "XWS_GIT_SYNC_METADATA_CONFLICT")]
  GitSyncMetadataConflict,
  #[serde(rename = "XWS_GIT_SYNC_METADATA_AUTH_DENIED")]
  GitSyncMetadataAuthDenied,
  #[serde(rename = "XWS_GIT_SYNC_OUTBOUND_CLEANUP_PENDING")]
  GitSyncOutboundCleanupPending,
  #[serde(rename = "XWS_GIT_SYNC_UNDO_PENDING")]
  GitSyncUndoPending,
  #[serde(rename = "XWS_GIT_SYNC_UNDO_OWNERSHIP_CHANGED")]
  GitSyncUndoOwnershipChanged,
  #[serde(rename = "XWS_GIT_SYNC_UNDO_CONTENT_CHANGED")]
  GitSyncUndoContentChanged,
  #[serde(rename = "XWS_GIT_SYNC_UNDO_TARGET_NOT_EMPTY")]
  GitSyncUndoTargetNotEmpty,

  #[serde(rename = "XWS_PREFLIGHT_STALE")]
  PreflightStale,
  #[serde(rename = "XWS_OPERATION_STATE_INVALID")]
  OperationStateInvalid,
  #[serde(rename = "XWS_MOVE_DOCUMENT_METADATA_CHANGED")]
  MoveDocumentMetadataChanged,
  #[serde(rename = "XWS_MOVE_DOCUMENT_ACL_CHANGED")]
  MoveDocumentAclChanged,
  #[serde(rename = "XWS_EXTRACT_OPERATION_REVISION_CHANGED")]
  ExtractOperationRevisionChanged,
  #[serde(rename = "XWS_EXTRACT_TARGET_REPLAY_CHANGED")]
  ExtractTargetReplayChanged,
  #[serde(rename = "XWS_EXTRACT_TARGET_LIFECYCLE_CHANGED")]
  ExtractTargetLifecycleChanged,
  #[serde(rename = "XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_CHANGED")]
  ExtractMembershipSnapshotChanged,
  #[serde(rename = "XWS_EXTRACT_RECOVERY_TARGET_RECEIPT_IS_MISSING")]
  ExtractRecoveryTargetReceiptIsMissing,
  #[serde(rename = "XWS_PUBLISHED_EXTRACT_CANNOT_BE_COMPENSATED")]
  PublishedExtractCannotBeCompensated,
  #[serde(rename = "XWS_EXTRACT_RECOVERY_STATE_CHANGED")]
  ExtractRecoveryStateChanged,
  #[serde(rename = "XWS_EXTRACT_RECOVERY_TARGET_LIFECYCLE_CHANGED")]
  ExtractRecoveryTargetLifecycleChanged,
  #[serde(rename = "XWS_COPY_TARGET_POLICY_CHANGED")]
  CopyTargetPolicyChanged,
  #[serde(rename = "XWS_COPY_TARGET_PAGE_DIRECTORY_CHANGED")]
  CopyTargetPageDirectoryChanged,
  #[serde(rename = "XWS_MOVE_REVISION_MANIFEST_REPLAY_CHANGED")]
  MoveRevisionManifestReplayChanged,
  #[serde(rename = "XWS_MOVE_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW")]
  MoveTagLineageRequiresAFreshPreview,
  #[serde(rename = "XWS_MOVE_REFERENCES_REQUIRE_A_FRESH_PREVIEW")]
  MoveReferencesRequireAFreshPreview,
  #[serde(rename = "XWS_MOVE_OPERATION_REVISION_CHANGED")]
  MoveOperationRevisionChanged,
  #[serde(rename = "XWS_MOVE_TAG_LINEAGE_IS_MISSING")]
  MoveTagLineageIsMissing,
  #[serde(rename = "XWS_MOVE_DATABASE_REVISION_IS_MISSING")]
  MoveDatabaseRevisionIsMissing,
  #[serde(rename = "XWS_MOVE_DATABASE_CHILD_OWNERSHIP_CHANGED")]
  MoveDatabaseChildOwnershipChanged,
  #[serde(rename = "XWS_MOVE_DOCUMENT_REVISION_IS_MISSING")]
  MoveDocumentRevisionIsMissing,
  #[serde(rename = "XWS_MOVE_DOCUMENT_CLASSIFICATIONS_CHANGED")]
  MoveDocumentClassificationsChanged,
  #[serde(rename = "XWS_MOVE_DOCUMENT_OWNERSHIP_CHANGED")]
  MoveDocumentOwnershipChanged,
  #[serde(rename = "XWS_MOVE_DOCUMENT_CHILD_COUNT_IS_MISSING")]
  MoveDocumentChildCountIsMissing,
  #[serde(rename = "XWS_MOVE_DOCUMENT_CHILD_OWNERSHIP_CHANGED")]
  MoveDocumentChildOwnershipChanged,
  #[serde(rename = "XWS_MOVE_REFERENCE_SOURCE_CHANGED")]
  MoveReferenceSourceChanged,
  #[serde(rename = "XWS_MOVE_REFERENCE_PLAN_IS_MISSING")]
  MoveReferencePlanIsMissing,
  #[serde(rename = "XWS_MOVE_TARGET_PAGE_DIRECTORY_CHANGED")]
  MoveTargetPageDirectoryChanged,
  #[serde(rename = "XWS_EXTRACT_TARGET_ACTIVATION_CHANGED")]
  ExtractTargetActivationChanged,
  #[serde(rename = "XWS_EXTRACT_TARGET_RECEIPT_CHANGED")]
  ExtractTargetReceiptChanged,
  #[serde(rename = "XWS_EXTRACT_BLOB_STAGING_STATE_CHANGED")]
  ExtractBlobStagingStateChanged,
  #[serde(rename = "XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_IS_INVALID")]
  ExtractMembershipSnapshotIsInvalid,
  #[serde(rename = "XWS_EXTRACT_RECIPIENT_SNAPSHOT_CHANGED")]
  ExtractRecipientSnapshotChanged,
  #[serde(rename = "XWS_MOVE_RECIPIENT_SNAPSHOT_CHANGED")]
  MoveRecipientSnapshotChanged,
  #[serde(rename = "XWS_MOVE_MAPPING_CHANGED")]
  MoveMappingChanged,
  #[serde(rename = "XWS_MOVE_PERSISTED_REVISION_MANIFEST_CHANGED")]
  MovePersistedRevisionManifestChanged,
  #[serde(rename = "XWS_PREPARED_TAG_IDENTITY_WAS_RETIRED")]
  PreparedTagIdentityWasRetired,
  #[serde(rename = "XWS_PREPARED_TAG_IS_NO_LONGER_REUSABLE")]
  PreparedTagIsNoLongerReusable,
  #[serde(rename = "XWS_CONCURRENT_TAG_IDENTITY_IS_NOT_REUSABLE")]
  ConcurrentTagIdentityIsNotReusable,
  #[serde(rename = "XWS_MOVED_TAG_CELL_DISAPPEARED")]
  MovedTagCellDisappeared,
  #[serde(rename = "XWS_MOVED_TAG_TEMPLATE_DISAPPEARED")]
  MovedTagTemplateDisappeared,
  #[serde(rename = "XWS_MOVED_TAG_FILTER_DISAPPEARED")]
  MovedTagFilterDisappeared,
  #[serde(rename = "XWS_MOVED_TAG_PREDICATE_DISAPPEARED")]
  MovedTagPredicateDisappeared,
  #[serde(rename = "XWS_MOVED_TAG_FILTER_CONTAINER_CHANGED")]
  MovedTagFilterContainerChanged,
  #[serde(rename = "XWS_OWNED_TAG_CLASSIFICATION_CHANGED")]
  OwnedTagClassificationChanged,
  #[serde(rename = "XWS_PLANNED_TAG_IDENTITY_WAS_RETIRED")]
  PlannedTagIdentityWasRetired,
  #[serde(rename = "XWS_PLANNED_TAG_IS_NO_LONGER_REUSABLE")]
  PlannedTagIsNoLongerReusable,
  #[serde(rename = "XWS_UNDO_HAS_NO_COMMITTED_ORIGIN_RECEIPT")]
  UndoHasNoCommittedOriginReceipt,
  #[serde(rename = "XWS_UNDO_ORIGIN_LINEAGE_HASH_CHANGED")]
  UndoOriginLineageHashChanged,
  #[serde(rename = "XWS_UNDO_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW")]
  UndoTagLineageRequiresAFreshPreview,
  #[serde(rename = "XWS_UNDO_EXTRACT_HAS_NO_MATCHING_PUBLISHED_FOLDER_RECEIPT")]
  UndoExtractHasNoMatchingPublishedFolderReceipt,
  #[serde(rename = "XWS_MOVE_REVISION_CHANGED_DURING_PUBLICATION")]
  MoveRevisionChangedDuringPublication,
  #[serde(rename = "XWS_EXTRACT_TARGET_WORKSPACE_IS_MISSING")]
  ExtractTargetWorkspaceIsMissing,
  #[serde(rename = "XWS_EXTRACT_TARGET_RECEIPT_IS_MISSING")]
  ExtractTargetReceiptIsMissing,
  #[serde(rename = "XWS_EXTRACT_TARGET_LIFECYCLE_OWNERSHIP_CHANGED")]
  ExtractTargetLifecycleOwnershipChanged,
  #[serde(rename = "XWS_EXTRACT_TARGET_OWNERSHIP_CHANGED")]
  ExtractTargetOwnershipChanged,
  #[serde(rename = "XWS_EXTRACT_TARGET_ROOT_CHANGED")]
  ExtractTargetRootChanged,
  #[serde(rename = "XWS_MOVE_TARGET_MISSING")]
  MoveTargetMissing,
  #[serde(rename = "XWS_WORKSPACE_CONTENT_TARGET_MEMBERSHIP_CHANGED")]
  WorkspaceContentTargetMembershipChanged,
  #[serde(rename = "XWS_PUBLICATION_SERIALIZATION_CONFLICT")]
  PublicationSerializationConflict,
  #[serde(rename = "XWS_PUBLICATION_DEADLOCK")]
  PublicationDeadlock,
  #[serde(rename = "XWS_DATABASE_EDIT_CONFLICT")]
  DatabaseEditConflict,
  #[serde(rename = "XWS_DATABASE_IMPORT_CONFLICT")]
  DatabaseImportConflict,
  #[serde(rename = "XWS_MOVE_CONTENT_REVISION_CHANGED")]
  MoveContentRevisionChanged,
  #[serde(rename = "XWS_MOVE_RELATED_ROWS_CHANGED")]
  MoveRelatedRowsChanged,
  #[serde(rename = "XWS_MOVE_WORKSPACE_ROOT_CHANGED")]
  MoveWorkspaceRootChanged,
  #[serde(rename = "XWS_MOVE_HISTORY_REFERENCES_CHANGED")]
  MoveHistoryReferencesChanged,
  #[serde(rename = "XWS_MOVE_TAG_PLAN_CHANGED")]
  MoveTagPlanChanged,
  #[serde(rename = "XWS_MOVE_DATABASE_CONTENT_CHANGED")]
  MoveDatabaseContentChanged,
  #[serde(rename = "XWS_MOVE_ORGANIZER_REFERENCES_CHANGED")]
  MoveOrganizerReferencesChanged,
  #[serde(rename = "XWS_MOVE_BLOB_METADATA_CHANGED")]
  MoveBlobMetadataChanged,
  #[serde(rename = "XWS_MOVE_NATIVE_REFERENCE_PLAN_CHANGED")]
  MoveNativeReferencePlanChanged,
  #[serde(rename = "XWS_MOVE_DOCUMENT_IDENTITY_CHANGED")]
  MoveDocumentIdentityChanged,
  #[serde(rename = "XWS_MOVE_WORKSPACE_POLICY_CHANGED")]
  MoveWorkspacePolicyChanged,
  #[serde(rename = "XWS_MOVE_UNDO_FOLDER_CHANGED")]
  MoveUndoFolderChanged,
  #[serde(rename = "XWS_PREVIEW_CONFIRMATION_MISMATCH")]
  PreviewConfirmationMismatch,
  #[serde(rename = "XWS_LINK_INTENT_WORKSPACE_CHANGED")]
  LinkIntentWorkspaceChanged,
  #[serde(rename = "XWS_LINK_ORGANIZER_CHANGED")]
  LinkOrganizerChanged,
  #[serde(rename = "XWS_LINK_TARGET_UNAVAILABLE")]
  LinkTargetUnavailable,
  #[serde(rename = "XWS_NATIVE_REFERENCE_SNAPSHOT_CHANGED")]
  NativeReferenceSnapshotChanged,
  #[serde(rename = "XWS_NATIVE_REFERENCE_PLAN_MISSING")]
  NativeReferencePlanMissing,
  #[serde(rename = "XWS_NATIVE_REFERENCE_VERSION_UNSUPPORTED")]
  NativeReferenceVersionUnsupported,
  #[serde(rename = "XWS_WORKSPACE_NAME_CONFLICT")]
  WorkspaceNameConflict,
  #[serde(rename = "XWS_OWNERSHIP_UNSUPPORTED")]
  OwnershipUnsupported,
  #[serde(rename = "XWS_WORKER_EXECUTION_FAILED")]
  WorkerExecutionFailed,
  #[serde(rename = "XWS_PUBLICATION_KIND_INVALID")]
  PublicationKindInvalid,
  #[serde(rename = "XWS_PUBLICATION_STATE_INVALID")]
  PublicationStateInvalid,
  #[serde(rename = "XWS_PUBLICATION_MAPPINGS_EMPTY")]
  PublicationMappingsEmpty,
  #[serde(rename = "XWS_EXTRACT_FOLDER_BINDING_INVALID")]
  ExtractFolderBindingInvalid,
  #[serde(rename = "XWS_PUBLICATION_STAGING_UNEXPECTED")]
  PublicationStagingUnexpected,
  #[serde(rename = "XWS_DIAGNOSTIC_INSTANCE_INVALID")]
  DiagnosticInstanceInvalid,
  #[serde(rename = "XWS_TARGET_WORKSPACE_MISSING")]
  TargetWorkspaceMissing,
  #[serde(rename = "XWS_DISTINCT_WORKSPACES_REQUIRED")]
  DistinctWorkspacesRequired,
  #[serde(rename = "XWS_RECIPIENTS_EMPTY")]
  RecipientsEmpty,
  #[serde(rename = "XWS_RECIPIENT_BINDING_INVALID")]
  RecipientBindingInvalid,
  #[serde(rename = "XWS_RECIPIENT_COUNT_INVALID")]
  RecipientCountInvalid,
  #[serde(rename = "XWS_RECIPIENT_KINDS_INVALID")]
  RecipientKindsInvalid,
  #[serde(rename = "XWS_RECIPIENT_REVISION_INVALID")]
  RecipientRevisionInvalid,
  #[serde(rename = "XWS_RECIPIENT_DUPLICATE")]
  RecipientDuplicate,
  #[serde(rename = "XWS_RECIPIENT_ACTOR_MISSING")]
  RecipientActorMissing,
  #[serde(rename = "XWS_RECIPIENT_REPLAY_CONFLICT")]
  RecipientReplayConflict,
  #[serde(rename = "XWS_BLOB_STAGING_ENTRY_MISSING")]
  BlobStagingEntryMissing,
  #[serde(rename = "XWS_TARGET_BLOB_BYTES_CONFLICT")]
  TargetBlobBytesConflict,
  #[serde(rename = "XWS_TARGET_BLOB_METADATA_CONFLICT")]
  TargetBlobMetadataConflict,
  #[serde(rename = "XWS_TARGET_DOCUMENT_KEY_CONFLICT")]
  TargetDocumentKeyConflict,
  #[serde(rename = "XWS_TAG_IDENTITY_CHANGED")]
  /// Display-only cause for historical Tag-relocation jobs. Current transfers
  /// reconcile catalogs and cannot fail merely because a Tag receives a new ID.
  TagIdentityChanged,
  #[serde(rename = "XWS_DATABASE_IDENTITY_CHANGED")]
  DatabaseIdentityChanged,
  #[serde(rename = "XWS_COLLECTION_IDENTITY_CHANGED")]
  CollectionIdentityChanged,
  #[serde(rename = "XWS_RESOURCE_COUNT_INVALID")]
  ResourceCountInvalid,
  #[serde(rename = "XWS_PUBLICATION_TERMINAL_CONFLICT")]
  PublicationTerminalConflict,
  #[serde(rename = "XWS_SOURCE_DOCUMENT_MISSING")]
  SourceDocumentMissing,
  #[serde(rename = "XWS_SOURCE_BLOB_MISSING")]
  SourceBlobMissing,
  #[serde(rename = "XWS_SOURCE_TAG_MISSING")]
  SourceTagMissing,
  #[serde(rename = "XWS_SOURCE_DATABASE_MISSING")]
  SourceDatabaseMissing,
  #[serde(rename = "XWS_SOURCE_ROOT_MISSING")]
  SourceRootMissing,
  #[serde(rename = "XWS_PUBLICATION_WORKSPACE_MISSING")]
  PublicationWorkspaceMissing,
  #[serde(rename = "XWS_TAG_ASSIGNMENT_CONSTRAINT")]
  TagAssignmentConstraint,
  #[serde(rename = "XWS_DATABASE_UNIQUE_CONSTRAINT")]
  DatabaseUniqueConstraint,
  #[serde(rename = "XWS_DATABASE_FOREIGN_KEY_CONSTRAINT")]
  DatabaseForeignKeyConstraint,
  #[serde(rename = "XWS_DATABASE_CHECK_CONSTRAINT")]
  DatabaseCheckConstraint,
  #[serde(rename = "XWS_DATABASE_NOT_NULL_CONSTRAINT")]
  DatabaseNotNullConstraint,
  #[serde(rename = "XWS_ORGANIZER_DECODE")]
  OrganizerDecode,
  #[serde(rename = "XWS_ORGANIZER_MALFORMED_ROW")]
  OrganizerMalformedRow,
  #[serde(rename = "XWS_ORGANIZER_FOLDER_MISSING")]
  OrganizerFolderMissing,
  #[serde(rename = "XWS_ORGANIZER_ENTRY_MISSING")]
  OrganizerEntryMissing,
  #[serde(rename = "XWS_ORGANIZER_PARENT_MISSING")]
  OrganizerParentMissing,
  #[serde(rename = "XWS_ORGANIZER_CYCLE")]
  OrganizerCycle,
  #[serde(rename = "XWS_ORGANIZER_DUPLICATE")]
  OrganizerDuplicate,
  #[serde(rename = "XWS_ORGANIZER_NAME_INVALID")]
  OrganizerNameInvalid,
  #[serde(rename = "XWS_ORGANIZER_LINK_TYPE_INVALID")]
  OrganizerLinkTypeInvalid,
  #[serde(rename = "XWS_ORGANIZER_TARGET_INVALID")]
  OrganizerTargetInvalid,
  #[serde(rename = "XWS_ORGANIZER_WORKSPACE_TARGET_INVALID")]
  OrganizerWorkspaceTargetInvalid,
  #[serde(rename = "XWS_ORGANIZER_ENTRY_AT_ROOT")]
  OrganizerEntryAtRoot,
  #[serde(rename = "XWS_ORGANIZER_MUTATION_EMPTY")]
  OrganizerMutationEmpty,
  #[serde(rename = "XWS_ORGANIZER_ORDER_INVALID")]
  OrganizerOrderInvalid,
  #[serde(rename = "XWS_ORGANIZER_REINDEX_REQUIRED")]
  OrganizerReindexRequired,
  #[serde(rename = "XWS_ORGANIZER_REVISION_STALE")]
  OrganizerRevisionStale,
  #[serde(rename = "XWS_ORGANIZER_KEY_INVALID")]
  OrganizerKeyInvalid,
  #[serde(rename = "XWS_COLLECTION_DECODE")]
  CollectionDecode,
  #[serde(rename = "XWS_WORKER_RETRY_EXHAUSTED")]
  WorkerRetryExhausted,
  #[serde(rename = "XWS_UNEXPECTED_VALIDATION")]
  UnexpectedValidation,
  #[serde(rename = "XWS_TRANSFER_FORBIDDEN")]
  TransferForbidden,
}

impl WorkspaceContentErrorCode {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::TargetStorageLimit => "XWS_TARGET_STORAGE_LIMIT",
      Self::CancellationCleanupRequired => "XWS_CANCELLATION_CLEANUP_REQUIRED",
      Self::OperationMissing => "XWS_OPERATION_MISSING",
      Self::StorageUnavailable => "XWS_STORAGE_UNAVAILABLE",
      Self::DatabaseUnavailable => "XWS_DATABASE_UNAVAILABLE",
      Self::LinkIntentMissing => "XWS_LINK_INTENT_MISSING",
      Self::SelectedResourceUnsupported => "XWS_SELECTED_RESOURCE_UNSUPPORTED",
      Self::BlobIntegrityMismatch => "XWS_BLOB_INTEGRITY_MISMATCH",
      Self::BlobSizeLimit => "XWS_BLOB_SIZE_LIMIT",
      Self::StagingManifestInvalid => "XWS_STAGING_MANIFEST_INVALID",
      Self::StagingReplayConflict => "XWS_STAGING_REPLAY_CONFLICT",
      Self::DocumentSnapshotInvalid => "XWS_DOCUMENT_SNAPSHOT_INVALID",
      Self::DocumentMetadataInvalid => "XWS_DOCUMENT_METADATA_INVALID",
      Self::DatabaseSnapshotInvalid => "XWS_DATABASE_SNAPSHOT_INVALID",
      Self::DatabaseIdentityInvalid => "XWS_DATABASE_IDENTITY_INVALID",
      Self::MappingPlanInvalid => "XWS_MAPPING_PLAN_INVALID",
      Self::SourceTagInvalid => "XWS_SOURCE_TAG_INVALID",
      Self::TargetDefinitionChanged => "XWS_TARGET_DEFINITION_CHANGED",
      Self::TargetDefinitionMissing => "XWS_TARGET_DEFINITION_MISSING",
      Self::RelationTargetOutsideSelection => "XWS_RELATION_TARGET_OUTSIDE_SELECTION",
      Self::RelationRowMissing => "XWS_RELATION_ROW_MISSING",
      Self::ResourceIdentityAmbiguous => "XWS_RESOURCE_IDENTITY_AMBIGUOUS",
      Self::OwnedBlobMappingMissing => "XWS_OWNED_BLOB_MAPPING_MISSING",
      Self::OwnedDocumentMissing => "XWS_OWNED_DOCUMENT_MISSING",
      Self::EncodingFailed => "XWS_ENCODING_FAILED",
      Self::InventoryInvalid => "XWS_INVENTORY_INVALID",
      Self::InventoryLimit => "XWS_INVENTORY_LIMIT",
      Self::BlobMaterializationFailed => "XWS_BLOB_MATERIALIZATION_FAILED",
      Self::BlobCompensationFailed => "XWS_BLOB_COMPENSATION_FAILED",
      Self::SourceWorkspaceMissing => "XWS_SOURCE_WORKSPACE_MISSING",
      Self::RequestInvalid => "XWS_REQUEST_INVALID",
      Self::GitSyncHandoffUnavailable => "XWS_GIT_SYNC_HANDOFF_UNAVAILABLE",
      Self::GitSyncRemoteUnavailable => "XWS_GIT_SYNC_REMOTE_UNAVAILABLE",
      Self::GitSyncMetadataConflict => "XWS_GIT_SYNC_METADATA_CONFLICT",
      Self::GitSyncMetadataAuthDenied => "XWS_GIT_SYNC_METADATA_AUTH_DENIED",
      Self::GitSyncOutboundCleanupPending => "XWS_GIT_SYNC_OUTBOUND_CLEANUP_PENDING",
      Self::GitSyncUndoPending => "XWS_GIT_SYNC_UNDO_PENDING",
      Self::GitSyncUndoOwnershipChanged => "XWS_GIT_SYNC_UNDO_OWNERSHIP_CHANGED",
      Self::GitSyncUndoContentChanged => "XWS_GIT_SYNC_UNDO_CONTENT_CHANGED",
      Self::GitSyncUndoTargetNotEmpty => "XWS_GIT_SYNC_UNDO_TARGET_NOT_EMPTY",
      Self::PreflightStale => "XWS_PREFLIGHT_STALE",
      Self::OperationStateInvalid => "XWS_OPERATION_STATE_INVALID",
      Self::MoveDocumentMetadataChanged => "XWS_MOVE_DOCUMENT_METADATA_CHANGED",
      Self::MoveDocumentAclChanged => "XWS_MOVE_DOCUMENT_ACL_CHANGED",
      Self::ExtractOperationRevisionChanged => "XWS_EXTRACT_OPERATION_REVISION_CHANGED",
      Self::ExtractTargetReplayChanged => "XWS_EXTRACT_TARGET_REPLAY_CHANGED",
      Self::ExtractTargetLifecycleChanged => "XWS_EXTRACT_TARGET_LIFECYCLE_CHANGED",
      Self::ExtractMembershipSnapshotChanged => "XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_CHANGED",
      Self::ExtractRecoveryTargetReceiptIsMissing => "XWS_EXTRACT_RECOVERY_TARGET_RECEIPT_IS_MISSING",
      Self::PublishedExtractCannotBeCompensated => "XWS_PUBLISHED_EXTRACT_CANNOT_BE_COMPENSATED",
      Self::ExtractRecoveryStateChanged => "XWS_EXTRACT_RECOVERY_STATE_CHANGED",
      Self::ExtractRecoveryTargetLifecycleChanged => "XWS_EXTRACT_RECOVERY_TARGET_LIFECYCLE_CHANGED",
      Self::CopyTargetPolicyChanged => "XWS_COPY_TARGET_POLICY_CHANGED",
      Self::CopyTargetPageDirectoryChanged => "XWS_COPY_TARGET_PAGE_DIRECTORY_CHANGED",
      Self::MoveRevisionManifestReplayChanged => "XWS_MOVE_REVISION_MANIFEST_REPLAY_CHANGED",
      Self::MoveTagLineageRequiresAFreshPreview => "XWS_MOVE_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW",
      Self::MoveReferencesRequireAFreshPreview => "XWS_MOVE_REFERENCES_REQUIRE_A_FRESH_PREVIEW",
      Self::MoveOperationRevisionChanged => "XWS_MOVE_OPERATION_REVISION_CHANGED",
      Self::MoveTagLineageIsMissing => "XWS_MOVE_TAG_LINEAGE_IS_MISSING",
      Self::MoveDatabaseRevisionIsMissing => "XWS_MOVE_DATABASE_REVISION_IS_MISSING",
      Self::MoveDatabaseChildOwnershipChanged => "XWS_MOVE_DATABASE_CHILD_OWNERSHIP_CHANGED",
      Self::MoveDocumentRevisionIsMissing => "XWS_MOVE_DOCUMENT_REVISION_IS_MISSING",
      Self::MoveDocumentClassificationsChanged => "XWS_MOVE_DOCUMENT_CLASSIFICATIONS_CHANGED",
      Self::MoveDocumentOwnershipChanged => "XWS_MOVE_DOCUMENT_OWNERSHIP_CHANGED",
      Self::MoveDocumentChildCountIsMissing => "XWS_MOVE_DOCUMENT_CHILD_COUNT_IS_MISSING",
      Self::MoveDocumentChildOwnershipChanged => "XWS_MOVE_DOCUMENT_CHILD_OWNERSHIP_CHANGED",
      Self::MoveReferenceSourceChanged => "XWS_MOVE_REFERENCE_SOURCE_CHANGED",
      Self::MoveReferencePlanIsMissing => "XWS_MOVE_REFERENCE_PLAN_IS_MISSING",
      Self::MoveTargetPageDirectoryChanged => "XWS_MOVE_TARGET_PAGE_DIRECTORY_CHANGED",
      Self::ExtractTargetActivationChanged => "XWS_EXTRACT_TARGET_ACTIVATION_CHANGED",
      Self::ExtractTargetReceiptChanged => "XWS_EXTRACT_TARGET_RECEIPT_CHANGED",
      Self::ExtractBlobStagingStateChanged => "XWS_EXTRACT_BLOB_STAGING_STATE_CHANGED",
      Self::ExtractMembershipSnapshotIsInvalid => "XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_IS_INVALID",
      Self::ExtractRecipientSnapshotChanged => "XWS_EXTRACT_RECIPIENT_SNAPSHOT_CHANGED",
      Self::MoveRecipientSnapshotChanged => "XWS_MOVE_RECIPIENT_SNAPSHOT_CHANGED",
      Self::MoveMappingChanged => "XWS_MOVE_MAPPING_CHANGED",
      Self::MovePersistedRevisionManifestChanged => "XWS_MOVE_PERSISTED_REVISION_MANIFEST_CHANGED",
      Self::PreparedTagIdentityWasRetired => "XWS_PREPARED_TAG_IDENTITY_WAS_RETIRED",
      Self::PreparedTagIsNoLongerReusable => "XWS_PREPARED_TAG_IS_NO_LONGER_REUSABLE",
      Self::ConcurrentTagIdentityIsNotReusable => "XWS_CONCURRENT_TAG_IDENTITY_IS_NOT_REUSABLE",
      Self::MovedTagCellDisappeared => "XWS_MOVED_TAG_CELL_DISAPPEARED",
      Self::MovedTagTemplateDisappeared => "XWS_MOVED_TAG_TEMPLATE_DISAPPEARED",
      Self::MovedTagFilterDisappeared => "XWS_MOVED_TAG_FILTER_DISAPPEARED",
      Self::MovedTagPredicateDisappeared => "XWS_MOVED_TAG_PREDICATE_DISAPPEARED",
      Self::MovedTagFilterContainerChanged => "XWS_MOVED_TAG_FILTER_CONTAINER_CHANGED",
      Self::OwnedTagClassificationChanged => "XWS_OWNED_TAG_CLASSIFICATION_CHANGED",
      Self::PlannedTagIdentityWasRetired => "XWS_PLANNED_TAG_IDENTITY_WAS_RETIRED",
      Self::PlannedTagIsNoLongerReusable => "XWS_PLANNED_TAG_IS_NO_LONGER_REUSABLE",
      Self::UndoHasNoCommittedOriginReceipt => "XWS_UNDO_HAS_NO_COMMITTED_ORIGIN_RECEIPT",
      Self::UndoOriginLineageHashChanged => "XWS_UNDO_ORIGIN_LINEAGE_HASH_CHANGED",
      Self::UndoTagLineageRequiresAFreshPreview => "XWS_UNDO_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW",
      Self::UndoExtractHasNoMatchingPublishedFolderReceipt => {
        "XWS_UNDO_EXTRACT_HAS_NO_MATCHING_PUBLISHED_FOLDER_RECEIPT"
      }
      Self::MoveRevisionChangedDuringPublication => "XWS_MOVE_REVISION_CHANGED_DURING_PUBLICATION",
      Self::ExtractTargetWorkspaceIsMissing => "XWS_EXTRACT_TARGET_WORKSPACE_IS_MISSING",
      Self::ExtractTargetReceiptIsMissing => "XWS_EXTRACT_TARGET_RECEIPT_IS_MISSING",
      Self::ExtractTargetLifecycleOwnershipChanged => "XWS_EXTRACT_TARGET_LIFECYCLE_OWNERSHIP_CHANGED",
      Self::ExtractTargetOwnershipChanged => "XWS_EXTRACT_TARGET_OWNERSHIP_CHANGED",
      Self::ExtractTargetRootChanged => "XWS_EXTRACT_TARGET_ROOT_CHANGED",
      Self::MoveTargetMissing => "XWS_MOVE_TARGET_MISSING",
      Self::WorkspaceContentTargetMembershipChanged => "XWS_WORKSPACE_CONTENT_TARGET_MEMBERSHIP_CHANGED",
      Self::PublicationSerializationConflict => "XWS_PUBLICATION_SERIALIZATION_CONFLICT",
      Self::PublicationDeadlock => "XWS_PUBLICATION_DEADLOCK",
      Self::DatabaseEditConflict => "XWS_DATABASE_EDIT_CONFLICT",
      Self::DatabaseImportConflict => "XWS_DATABASE_IMPORT_CONFLICT",
      Self::MoveContentRevisionChanged => "XWS_MOVE_CONTENT_REVISION_CHANGED",
      Self::MoveRelatedRowsChanged => "XWS_MOVE_RELATED_ROWS_CHANGED",
      Self::MoveWorkspaceRootChanged => "XWS_MOVE_WORKSPACE_ROOT_CHANGED",
      Self::MoveHistoryReferencesChanged => "XWS_MOVE_HISTORY_REFERENCES_CHANGED",
      Self::MoveTagPlanChanged => "XWS_MOVE_TAG_PLAN_CHANGED",
      Self::MoveDatabaseContentChanged => "XWS_MOVE_DATABASE_CONTENT_CHANGED",
      Self::MoveOrganizerReferencesChanged => "XWS_MOVE_ORGANIZER_REFERENCES_CHANGED",
      Self::MoveBlobMetadataChanged => "XWS_MOVE_BLOB_METADATA_CHANGED",
      Self::MoveNativeReferencePlanChanged => "XWS_MOVE_NATIVE_REFERENCE_PLAN_CHANGED",
      Self::MoveDocumentIdentityChanged => "XWS_MOVE_DOCUMENT_IDENTITY_CHANGED",
      Self::MoveWorkspacePolicyChanged => "XWS_MOVE_WORKSPACE_POLICY_CHANGED",
      Self::MoveUndoFolderChanged => "XWS_MOVE_UNDO_FOLDER_CHANGED",
      Self::PreviewConfirmationMismatch => "XWS_PREVIEW_CONFIRMATION_MISMATCH",
      Self::LinkIntentWorkspaceChanged => "XWS_LINK_INTENT_WORKSPACE_CHANGED",
      Self::LinkOrganizerChanged => "XWS_LINK_ORGANIZER_CHANGED",
      Self::LinkTargetUnavailable => "XWS_LINK_TARGET_UNAVAILABLE",
      Self::NativeReferenceSnapshotChanged => "XWS_NATIVE_REFERENCE_SNAPSHOT_CHANGED",
      Self::NativeReferencePlanMissing => "XWS_NATIVE_REFERENCE_PLAN_MISSING",
      Self::NativeReferenceVersionUnsupported => "XWS_NATIVE_REFERENCE_VERSION_UNSUPPORTED",
      Self::WorkspaceNameConflict => "XWS_WORKSPACE_NAME_CONFLICT",
      Self::OwnershipUnsupported => "XWS_OWNERSHIP_UNSUPPORTED",
      Self::WorkerExecutionFailed => "XWS_WORKER_EXECUTION_FAILED",
      Self::PublicationKindInvalid => "XWS_PUBLICATION_KIND_INVALID",
      Self::PublicationStateInvalid => "XWS_PUBLICATION_STATE_INVALID",
      Self::PublicationMappingsEmpty => "XWS_PUBLICATION_MAPPINGS_EMPTY",
      Self::ExtractFolderBindingInvalid => "XWS_EXTRACT_FOLDER_BINDING_INVALID",
      Self::PublicationStagingUnexpected => "XWS_PUBLICATION_STAGING_UNEXPECTED",
      Self::DiagnosticInstanceInvalid => "XWS_DIAGNOSTIC_INSTANCE_INVALID",
      Self::TargetWorkspaceMissing => "XWS_TARGET_WORKSPACE_MISSING",
      Self::DistinctWorkspacesRequired => "XWS_DISTINCT_WORKSPACES_REQUIRED",
      Self::RecipientsEmpty => "XWS_RECIPIENTS_EMPTY",
      Self::RecipientBindingInvalid => "XWS_RECIPIENT_BINDING_INVALID",
      Self::RecipientCountInvalid => "XWS_RECIPIENT_COUNT_INVALID",
      Self::RecipientKindsInvalid => "XWS_RECIPIENT_KINDS_INVALID",
      Self::RecipientRevisionInvalid => "XWS_RECIPIENT_REVISION_INVALID",
      Self::RecipientDuplicate => "XWS_RECIPIENT_DUPLICATE",
      Self::RecipientActorMissing => "XWS_RECIPIENT_ACTOR_MISSING",
      Self::RecipientReplayConflict => "XWS_RECIPIENT_REPLAY_CONFLICT",
      Self::BlobStagingEntryMissing => "XWS_BLOB_STAGING_ENTRY_MISSING",
      Self::TargetBlobBytesConflict => "XWS_TARGET_BLOB_BYTES_CONFLICT",
      Self::TargetBlobMetadataConflict => "XWS_TARGET_BLOB_METADATA_CONFLICT",
      Self::TargetDocumentKeyConflict => "XWS_TARGET_DOCUMENT_KEY_CONFLICT",
      Self::TagIdentityChanged => "XWS_TAG_IDENTITY_CHANGED",
      Self::DatabaseIdentityChanged => "XWS_DATABASE_IDENTITY_CHANGED",
      Self::CollectionIdentityChanged => "XWS_COLLECTION_IDENTITY_CHANGED",
      Self::ResourceCountInvalid => "XWS_RESOURCE_COUNT_INVALID",
      Self::PublicationTerminalConflict => "XWS_PUBLICATION_TERMINAL_CONFLICT",
      Self::SourceDocumentMissing => "XWS_SOURCE_DOCUMENT_MISSING",
      Self::SourceBlobMissing => "XWS_SOURCE_BLOB_MISSING",
      Self::SourceTagMissing => "XWS_SOURCE_TAG_MISSING",
      Self::SourceDatabaseMissing => "XWS_SOURCE_DATABASE_MISSING",
      Self::SourceRootMissing => "XWS_SOURCE_ROOT_MISSING",
      Self::PublicationWorkspaceMissing => "XWS_PUBLICATION_WORKSPACE_MISSING",
      Self::TagAssignmentConstraint => "XWS_TAG_ASSIGNMENT_CONSTRAINT",
      Self::DatabaseUniqueConstraint => "XWS_DATABASE_UNIQUE_CONSTRAINT",
      Self::DatabaseForeignKeyConstraint => "XWS_DATABASE_FOREIGN_KEY_CONSTRAINT",
      Self::DatabaseCheckConstraint => "XWS_DATABASE_CHECK_CONSTRAINT",
      Self::DatabaseNotNullConstraint => "XWS_DATABASE_NOT_NULL_CONSTRAINT",
      Self::OrganizerDecode => "XWS_ORGANIZER_DECODE",
      Self::OrganizerMalformedRow => "XWS_ORGANIZER_MALFORMED_ROW",
      Self::OrganizerFolderMissing => "XWS_ORGANIZER_FOLDER_MISSING",
      Self::OrganizerEntryMissing => "XWS_ORGANIZER_ENTRY_MISSING",
      Self::OrganizerParentMissing => "XWS_ORGANIZER_PARENT_MISSING",
      Self::OrganizerCycle => "XWS_ORGANIZER_CYCLE",
      Self::OrganizerDuplicate => "XWS_ORGANIZER_DUPLICATE",
      Self::OrganizerNameInvalid => "XWS_ORGANIZER_NAME_INVALID",
      Self::OrganizerLinkTypeInvalid => "XWS_ORGANIZER_LINK_TYPE_INVALID",
      Self::OrganizerTargetInvalid => "XWS_ORGANIZER_TARGET_INVALID",
      Self::OrganizerWorkspaceTargetInvalid => "XWS_ORGANIZER_WORKSPACE_TARGET_INVALID",
      Self::OrganizerEntryAtRoot => "XWS_ORGANIZER_ENTRY_AT_ROOT",
      Self::OrganizerMutationEmpty => "XWS_ORGANIZER_MUTATION_EMPTY",
      Self::OrganizerOrderInvalid => "XWS_ORGANIZER_ORDER_INVALID",
      Self::OrganizerReindexRequired => "XWS_ORGANIZER_REINDEX_REQUIRED",
      Self::OrganizerRevisionStale => "XWS_ORGANIZER_REVISION_STALE",
      Self::OrganizerKeyInvalid => "XWS_ORGANIZER_KEY_INVALID",
      Self::CollectionDecode => "XWS_COLLECTION_DECODE",
      Self::WorkerRetryExhausted => "XWS_WORKER_RETRY_EXHAUSTED",
      Self::UnexpectedValidation => "XWS_UNEXPECTED_VALIDATION",
      Self::TransferForbidden => "XWS_TRANSFER_FORBIDDEN",
    }
  }
}

impl WorkspaceContentErrorCode {
  /// Parse the durable code without collapsing newly introduced causes into
  /// the legacy worker failure. Old persisted codes remain readable.
  pub fn parse(value: &str) -> Option<Self> {
    match value {
      "XWS_TARGET_STORAGE_LIMIT" => Some(Self::TargetStorageLimit),
      "XWS_CANCELLATION_CLEANUP_REQUIRED" => Some(Self::CancellationCleanupRequired),
      "XWS_OPERATION_MISSING" => Some(Self::OperationMissing),
      "XWS_STORAGE_UNAVAILABLE" => Some(Self::StorageUnavailable),
      "XWS_DATABASE_UNAVAILABLE" => Some(Self::DatabaseUnavailable),
      "XWS_LINK_INTENT_MISSING" => Some(Self::LinkIntentMissing),
      "XWS_SELECTED_RESOURCE_UNSUPPORTED" => Some(Self::SelectedResourceUnsupported),
      "XWS_BLOB_INTEGRITY_MISMATCH" => Some(Self::BlobIntegrityMismatch),
      "XWS_BLOB_SIZE_LIMIT" => Some(Self::BlobSizeLimit),
      "XWS_STAGING_MANIFEST_INVALID" => Some(Self::StagingManifestInvalid),
      "XWS_STAGING_REPLAY_CONFLICT" => Some(Self::StagingReplayConflict),
      "XWS_DOCUMENT_SNAPSHOT_INVALID" => Some(Self::DocumentSnapshotInvalid),
      "XWS_DOCUMENT_METADATA_INVALID" => Some(Self::DocumentMetadataInvalid),
      "XWS_DATABASE_SNAPSHOT_INVALID" => Some(Self::DatabaseSnapshotInvalid),
      "XWS_DATABASE_IDENTITY_INVALID" => Some(Self::DatabaseIdentityInvalid),
      "XWS_MAPPING_PLAN_INVALID" => Some(Self::MappingPlanInvalid),
      "XWS_SOURCE_TAG_INVALID" => Some(Self::SourceTagInvalid),
      "XWS_TARGET_DEFINITION_CHANGED" => Some(Self::TargetDefinitionChanged),
      "XWS_TARGET_DEFINITION_MISSING" => Some(Self::TargetDefinitionMissing),
      "XWS_RELATION_TARGET_OUTSIDE_SELECTION" => Some(Self::RelationTargetOutsideSelection),
      "XWS_RELATION_ROW_MISSING" => Some(Self::RelationRowMissing),
      "XWS_RESOURCE_IDENTITY_AMBIGUOUS" => Some(Self::ResourceIdentityAmbiguous),
      "XWS_OWNED_BLOB_MAPPING_MISSING" => Some(Self::OwnedBlobMappingMissing),
      "XWS_OWNED_DOCUMENT_MISSING" => Some(Self::OwnedDocumentMissing),
      "XWS_ENCODING_FAILED" => Some(Self::EncodingFailed),
      "XWS_INVENTORY_INVALID" => Some(Self::InventoryInvalid),
      "XWS_INVENTORY_LIMIT" => Some(Self::InventoryLimit),
      "XWS_BLOB_MATERIALIZATION_FAILED" => Some(Self::BlobMaterializationFailed),
      "XWS_BLOB_COMPENSATION_FAILED" => Some(Self::BlobCompensationFailed),
      "XWS_SOURCE_WORKSPACE_MISSING" => Some(Self::SourceWorkspaceMissing),
      "XWS_REQUEST_INVALID" => Some(Self::RequestInvalid),
      "XWS_GIT_SYNC_HANDOFF_UNAVAILABLE" => Some(Self::GitSyncHandoffUnavailable),
      "XWS_GIT_SYNC_REMOTE_UNAVAILABLE" => Some(Self::GitSyncRemoteUnavailable),
      "XWS_GIT_SYNC_METADATA_CONFLICT" => Some(Self::GitSyncMetadataConflict),
      "XWS_GIT_SYNC_METADATA_AUTH_DENIED" => Some(Self::GitSyncMetadataAuthDenied),
      "XWS_GIT_SYNC_OUTBOUND_CLEANUP_PENDING" => Some(Self::GitSyncOutboundCleanupPending),
      "XWS_GIT_SYNC_UNDO_PENDING" => Some(Self::GitSyncUndoPending),
      "XWS_GIT_SYNC_UNDO_OWNERSHIP_CHANGED" => Some(Self::GitSyncUndoOwnershipChanged),
      "XWS_GIT_SYNC_UNDO_CONTENT_CHANGED" => Some(Self::GitSyncUndoContentChanged),
      "XWS_GIT_SYNC_UNDO_TARGET_NOT_EMPTY" => Some(Self::GitSyncUndoTargetNotEmpty),
      "XWS_PREFLIGHT_STALE" => Some(Self::PreflightStale),
      "XWS_OPERATION_STATE_INVALID" => Some(Self::OperationStateInvalid),
      "XWS_MOVE_DOCUMENT_METADATA_CHANGED" => Some(Self::MoveDocumentMetadataChanged),
      "XWS_MOVE_DOCUMENT_ACL_CHANGED" => Some(Self::MoveDocumentAclChanged),
      "XWS_EXTRACT_OPERATION_REVISION_CHANGED" => Some(Self::ExtractOperationRevisionChanged),
      "XWS_EXTRACT_TARGET_REPLAY_CHANGED" => Some(Self::ExtractTargetReplayChanged),
      "XWS_EXTRACT_TARGET_LIFECYCLE_CHANGED" => Some(Self::ExtractTargetLifecycleChanged),
      "XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_CHANGED" => Some(Self::ExtractMembershipSnapshotChanged),
      "XWS_EXTRACT_RECOVERY_TARGET_RECEIPT_IS_MISSING" => Some(Self::ExtractRecoveryTargetReceiptIsMissing),
      "XWS_PUBLISHED_EXTRACT_CANNOT_BE_COMPENSATED" => Some(Self::PublishedExtractCannotBeCompensated),
      "XWS_EXTRACT_RECOVERY_STATE_CHANGED" => Some(Self::ExtractRecoveryStateChanged),
      "XWS_EXTRACT_RECOVERY_TARGET_LIFECYCLE_CHANGED" => Some(Self::ExtractRecoveryTargetLifecycleChanged),
      "XWS_COPY_TARGET_POLICY_CHANGED" => Some(Self::CopyTargetPolicyChanged),
      "XWS_COPY_TARGET_PAGE_DIRECTORY_CHANGED" => Some(Self::CopyTargetPageDirectoryChanged),
      "XWS_MOVE_REVISION_MANIFEST_REPLAY_CHANGED" => Some(Self::MoveRevisionManifestReplayChanged),
      "XWS_MOVE_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW" => Some(Self::MoveTagLineageRequiresAFreshPreview),
      "XWS_MOVE_REFERENCES_REQUIRE_A_FRESH_PREVIEW" => Some(Self::MoveReferencesRequireAFreshPreview),
      "XWS_MOVE_OPERATION_REVISION_CHANGED" => Some(Self::MoveOperationRevisionChanged),
      "XWS_MOVE_TAG_LINEAGE_IS_MISSING" => Some(Self::MoveTagLineageIsMissing),
      "XWS_MOVE_DATABASE_REVISION_IS_MISSING" => Some(Self::MoveDatabaseRevisionIsMissing),
      "XWS_MOVE_DATABASE_CHILD_OWNERSHIP_CHANGED" => Some(Self::MoveDatabaseChildOwnershipChanged),
      "XWS_MOVE_DOCUMENT_REVISION_IS_MISSING" => Some(Self::MoveDocumentRevisionIsMissing),
      "XWS_MOVE_DOCUMENT_CLASSIFICATIONS_CHANGED" => Some(Self::MoveDocumentClassificationsChanged),
      "XWS_MOVE_DOCUMENT_OWNERSHIP_CHANGED" => Some(Self::MoveDocumentOwnershipChanged),
      "XWS_MOVE_DOCUMENT_CHILD_COUNT_IS_MISSING" => Some(Self::MoveDocumentChildCountIsMissing),
      "XWS_MOVE_DOCUMENT_CHILD_OWNERSHIP_CHANGED" => Some(Self::MoveDocumentChildOwnershipChanged),
      "XWS_MOVE_REFERENCE_SOURCE_CHANGED" => Some(Self::MoveReferenceSourceChanged),
      "XWS_MOVE_REFERENCE_PLAN_IS_MISSING" => Some(Self::MoveReferencePlanIsMissing),
      "XWS_MOVE_TARGET_PAGE_DIRECTORY_CHANGED" => Some(Self::MoveTargetPageDirectoryChanged),
      "XWS_EXTRACT_TARGET_ACTIVATION_CHANGED" => Some(Self::ExtractTargetActivationChanged),
      "XWS_EXTRACT_TARGET_RECEIPT_CHANGED" => Some(Self::ExtractTargetReceiptChanged),
      "XWS_EXTRACT_BLOB_STAGING_STATE_CHANGED" => Some(Self::ExtractBlobStagingStateChanged),
      "XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_IS_INVALID" => Some(Self::ExtractMembershipSnapshotIsInvalid),
      "XWS_EXTRACT_RECIPIENT_SNAPSHOT_CHANGED" => Some(Self::ExtractRecipientSnapshotChanged),
      "XWS_MOVE_RECIPIENT_SNAPSHOT_CHANGED" => Some(Self::MoveRecipientSnapshotChanged),
      "XWS_MOVE_MAPPING_CHANGED" => Some(Self::MoveMappingChanged),
      "XWS_MOVE_PERSISTED_REVISION_MANIFEST_CHANGED" => Some(Self::MovePersistedRevisionManifestChanged),
      "XWS_PREPARED_TAG_IDENTITY_WAS_RETIRED" => Some(Self::PreparedTagIdentityWasRetired),
      "XWS_PREPARED_TAG_IS_NO_LONGER_REUSABLE" => Some(Self::PreparedTagIsNoLongerReusable),
      "XWS_CONCURRENT_TAG_IDENTITY_IS_NOT_REUSABLE" => Some(Self::ConcurrentTagIdentityIsNotReusable),
      "XWS_MOVED_TAG_CELL_DISAPPEARED" => Some(Self::MovedTagCellDisappeared),
      "XWS_MOVED_TAG_TEMPLATE_DISAPPEARED" => Some(Self::MovedTagTemplateDisappeared),
      "XWS_MOVED_TAG_FILTER_DISAPPEARED" => Some(Self::MovedTagFilterDisappeared),
      "XWS_MOVED_TAG_PREDICATE_DISAPPEARED" => Some(Self::MovedTagPredicateDisappeared),
      "XWS_MOVED_TAG_FILTER_CONTAINER_CHANGED" => Some(Self::MovedTagFilterContainerChanged),
      "XWS_OWNED_TAG_CLASSIFICATION_CHANGED" => Some(Self::OwnedTagClassificationChanged),
      "XWS_PLANNED_TAG_IDENTITY_WAS_RETIRED" => Some(Self::PlannedTagIdentityWasRetired),
      "XWS_PLANNED_TAG_IS_NO_LONGER_REUSABLE" => Some(Self::PlannedTagIsNoLongerReusable),
      "XWS_UNDO_HAS_NO_COMMITTED_ORIGIN_RECEIPT" => Some(Self::UndoHasNoCommittedOriginReceipt),
      "XWS_UNDO_ORIGIN_LINEAGE_HASH_CHANGED" => Some(Self::UndoOriginLineageHashChanged),
      "XWS_UNDO_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW" => Some(Self::UndoTagLineageRequiresAFreshPreview),
      "XWS_UNDO_EXTRACT_HAS_NO_MATCHING_PUBLISHED_FOLDER_RECEIPT" => {
        Some(Self::UndoExtractHasNoMatchingPublishedFolderReceipt)
      }
      "XWS_MOVE_REVISION_CHANGED_DURING_PUBLICATION" => Some(Self::MoveRevisionChangedDuringPublication),
      "XWS_EXTRACT_TARGET_WORKSPACE_IS_MISSING" => Some(Self::ExtractTargetWorkspaceIsMissing),
      "XWS_EXTRACT_TARGET_RECEIPT_IS_MISSING" => Some(Self::ExtractTargetReceiptIsMissing),
      "XWS_EXTRACT_TARGET_LIFECYCLE_OWNERSHIP_CHANGED" => Some(Self::ExtractTargetLifecycleOwnershipChanged),
      "XWS_EXTRACT_TARGET_OWNERSHIP_CHANGED" => Some(Self::ExtractTargetOwnershipChanged),
      "XWS_EXTRACT_TARGET_ROOT_CHANGED" => Some(Self::ExtractTargetRootChanged),
      "XWS_MOVE_TARGET_MISSING" => Some(Self::MoveTargetMissing),
      "XWS_WORKSPACE_CONTENT_TARGET_MEMBERSHIP_CHANGED" => Some(Self::WorkspaceContentTargetMembershipChanged),
      "XWS_PUBLICATION_SERIALIZATION_CONFLICT" => Some(Self::PublicationSerializationConflict),
      "XWS_PUBLICATION_DEADLOCK" => Some(Self::PublicationDeadlock),
      "XWS_DATABASE_EDIT_CONFLICT" => Some(Self::DatabaseEditConflict),
      "XWS_DATABASE_IMPORT_CONFLICT" => Some(Self::DatabaseImportConflict),
      "XWS_MOVE_CONTENT_REVISION_CHANGED" => Some(Self::MoveContentRevisionChanged),
      "XWS_MOVE_RELATED_ROWS_CHANGED" => Some(Self::MoveRelatedRowsChanged),
      "XWS_MOVE_WORKSPACE_ROOT_CHANGED" => Some(Self::MoveWorkspaceRootChanged),
      "XWS_MOVE_HISTORY_REFERENCES_CHANGED" => Some(Self::MoveHistoryReferencesChanged),
      "XWS_MOVE_TAG_PLAN_CHANGED" => Some(Self::MoveTagPlanChanged),
      "XWS_MOVE_DATABASE_CONTENT_CHANGED" => Some(Self::MoveDatabaseContentChanged),
      "XWS_MOVE_ORGANIZER_REFERENCES_CHANGED" => Some(Self::MoveOrganizerReferencesChanged),
      "XWS_MOVE_BLOB_METADATA_CHANGED" => Some(Self::MoveBlobMetadataChanged),
      "XWS_MOVE_NATIVE_REFERENCE_PLAN_CHANGED" => Some(Self::MoveNativeReferencePlanChanged),
      "XWS_MOVE_DOCUMENT_IDENTITY_CHANGED" => Some(Self::MoveDocumentIdentityChanged),
      "XWS_MOVE_WORKSPACE_POLICY_CHANGED" => Some(Self::MoveWorkspacePolicyChanged),
      "XWS_MOVE_UNDO_FOLDER_CHANGED" => Some(Self::MoveUndoFolderChanged),
      "XWS_PREVIEW_CONFIRMATION_MISMATCH" => Some(Self::PreviewConfirmationMismatch),
      "XWS_LINK_INTENT_WORKSPACE_CHANGED" => Some(Self::LinkIntentWorkspaceChanged),
      "XWS_LINK_ORGANIZER_CHANGED" => Some(Self::LinkOrganizerChanged),
      "XWS_LINK_TARGET_UNAVAILABLE" => Some(Self::LinkTargetUnavailable),
      "XWS_NATIVE_REFERENCE_SNAPSHOT_CHANGED" => Some(Self::NativeReferenceSnapshotChanged),
      "XWS_NATIVE_REFERENCE_PLAN_MISSING" => Some(Self::NativeReferencePlanMissing),
      "XWS_NATIVE_REFERENCE_VERSION_UNSUPPORTED" => Some(Self::NativeReferenceVersionUnsupported),
      "XWS_WORKSPACE_NAME_CONFLICT" => Some(Self::WorkspaceNameConflict),
      "XWS_OWNERSHIP_UNSUPPORTED" => Some(Self::OwnershipUnsupported),
      "XWS_WORKER_EXECUTION_FAILED" => Some(Self::WorkerExecutionFailed),
      "XWS_PUBLICATION_KIND_INVALID" => Some(Self::PublicationKindInvalid),
      "XWS_PUBLICATION_STATE_INVALID" => Some(Self::PublicationStateInvalid),
      "XWS_PUBLICATION_MAPPINGS_EMPTY" => Some(Self::PublicationMappingsEmpty),
      "XWS_EXTRACT_FOLDER_BINDING_INVALID" => Some(Self::ExtractFolderBindingInvalid),
      "XWS_PUBLICATION_STAGING_UNEXPECTED" => Some(Self::PublicationStagingUnexpected),
      "XWS_DIAGNOSTIC_INSTANCE_INVALID" => Some(Self::DiagnosticInstanceInvalid),
      "XWS_TARGET_WORKSPACE_MISSING" => Some(Self::TargetWorkspaceMissing),
      "XWS_DISTINCT_WORKSPACES_REQUIRED" => Some(Self::DistinctWorkspacesRequired),
      "XWS_RECIPIENTS_EMPTY" => Some(Self::RecipientsEmpty),
      "XWS_RECIPIENT_BINDING_INVALID" => Some(Self::RecipientBindingInvalid),
      "XWS_RECIPIENT_COUNT_INVALID" => Some(Self::RecipientCountInvalid),
      "XWS_RECIPIENT_KINDS_INVALID" => Some(Self::RecipientKindsInvalid),
      "XWS_RECIPIENT_REVISION_INVALID" => Some(Self::RecipientRevisionInvalid),
      "XWS_RECIPIENT_DUPLICATE" => Some(Self::RecipientDuplicate),
      "XWS_RECIPIENT_ACTOR_MISSING" => Some(Self::RecipientActorMissing),
      "XWS_RECIPIENT_REPLAY_CONFLICT" => Some(Self::RecipientReplayConflict),
      "XWS_BLOB_STAGING_ENTRY_MISSING" => Some(Self::BlobStagingEntryMissing),
      "XWS_TARGET_BLOB_BYTES_CONFLICT" => Some(Self::TargetBlobBytesConflict),
      "XWS_TARGET_BLOB_METADATA_CONFLICT" => Some(Self::TargetBlobMetadataConflict),
      "XWS_TARGET_DOCUMENT_KEY_CONFLICT" => Some(Self::TargetDocumentKeyConflict),
      "XWS_TAG_IDENTITY_CHANGED" => Some(Self::TagIdentityChanged),
      "XWS_DATABASE_IDENTITY_CHANGED" => Some(Self::DatabaseIdentityChanged),
      "XWS_COLLECTION_IDENTITY_CHANGED" => Some(Self::CollectionIdentityChanged),
      "XWS_RESOURCE_COUNT_INVALID" => Some(Self::ResourceCountInvalid),
      "XWS_PUBLICATION_TERMINAL_CONFLICT" => Some(Self::PublicationTerminalConflict),
      "XWS_SOURCE_DOCUMENT_MISSING" => Some(Self::SourceDocumentMissing),
      "XWS_SOURCE_BLOB_MISSING" => Some(Self::SourceBlobMissing),
      "XWS_SOURCE_TAG_MISSING" => Some(Self::SourceTagMissing),
      "XWS_SOURCE_DATABASE_MISSING" => Some(Self::SourceDatabaseMissing),
      "XWS_SOURCE_ROOT_MISSING" => Some(Self::SourceRootMissing),
      "XWS_PUBLICATION_WORKSPACE_MISSING" => Some(Self::PublicationWorkspaceMissing),
      "XWS_TAG_ASSIGNMENT_CONSTRAINT" => Some(Self::TagAssignmentConstraint),
      "XWS_DATABASE_UNIQUE_CONSTRAINT" => Some(Self::DatabaseUniqueConstraint),
      "XWS_DATABASE_FOREIGN_KEY_CONSTRAINT" => Some(Self::DatabaseForeignKeyConstraint),
      "XWS_DATABASE_CHECK_CONSTRAINT" => Some(Self::DatabaseCheckConstraint),
      "XWS_DATABASE_NOT_NULL_CONSTRAINT" => Some(Self::DatabaseNotNullConstraint),
      "XWS_ORGANIZER_DECODE" => Some(Self::OrganizerDecode),
      "XWS_ORGANIZER_MALFORMED_ROW" => Some(Self::OrganizerMalformedRow),
      "XWS_ORGANIZER_FOLDER_MISSING" => Some(Self::OrganizerFolderMissing),
      "XWS_ORGANIZER_ENTRY_MISSING" => Some(Self::OrganizerEntryMissing),
      "XWS_ORGANIZER_PARENT_MISSING" => Some(Self::OrganizerParentMissing),
      "XWS_ORGANIZER_CYCLE" => Some(Self::OrganizerCycle),
      "XWS_ORGANIZER_DUPLICATE" => Some(Self::OrganizerDuplicate),
      "XWS_ORGANIZER_NAME_INVALID" => Some(Self::OrganizerNameInvalid),
      "XWS_ORGANIZER_LINK_TYPE_INVALID" => Some(Self::OrganizerLinkTypeInvalid),
      "XWS_ORGANIZER_TARGET_INVALID" => Some(Self::OrganizerTargetInvalid),
      "XWS_ORGANIZER_WORKSPACE_TARGET_INVALID" => Some(Self::OrganizerWorkspaceTargetInvalid),
      "XWS_ORGANIZER_ENTRY_AT_ROOT" => Some(Self::OrganizerEntryAtRoot),
      "XWS_ORGANIZER_MUTATION_EMPTY" => Some(Self::OrganizerMutationEmpty),
      "XWS_ORGANIZER_ORDER_INVALID" => Some(Self::OrganizerOrderInvalid),
      "XWS_ORGANIZER_REINDEX_REQUIRED" => Some(Self::OrganizerReindexRequired),
      "XWS_ORGANIZER_REVISION_STALE" => Some(Self::OrganizerRevisionStale),
      "XWS_ORGANIZER_KEY_INVALID" => Some(Self::OrganizerKeyInvalid),
      "XWS_COLLECTION_DECODE" => Some(Self::CollectionDecode),
      "XWS_WORKER_RETRY_EXHAUSTED" => Some(Self::WorkerRetryExhausted),
      "XWS_UNEXPECTED_VALIDATION" => Some(Self::UnexpectedValidation),
      "XWS_TRANSFER_FORBIDDEN" => Some(Self::TransferForbidden),
      _ => None,
    }
  }

  /// Dependency availability and unpublished cleanup can be retried; invalid
  /// owned content or a violated invariant requires a new valid request.
  pub const fn retryable(self) -> bool {
    matches!(
      self,
      Self::StorageUnavailable
        | Self::DatabaseUnavailable
        | Self::BlobMaterializationFailed
        | Self::BlobCompensationFailed
    )
  }

  /// Content-free explanation; safe for durable storage, audit and translation.
  pub const fn safe_message(self) -> Option<&'static str> {
    match self {
      Self::TargetStorageLimit => Some("The destination exceeds the configured technical storage limit."),
      Self::CancellationCleanupRequired => {
        Some("The cancelled operation still requires cleanup of unpublished staging.")
      }
      Self::OperationMissing => Some("The workspace content operation or its admitted request is missing."),
      Self::StorageUnavailable => Some("Operation storage is temporarily unavailable."),
      Self::DatabaseUnavailable => Some("The operation repository is temporarily unavailable."),
      Self::LinkIntentMissing => Some("The admitted link intent is missing."),
      Self::SelectedResourceUnsupported => Some("This selected resource cannot be transferred."),
      Self::BlobIntegrityMismatch => Some("Attachment bytes differ from the admitted integrity information."),
      Self::BlobSizeLimit => Some("An attachment exceeds the operation size limit."),
      Self::StagingManifestInvalid => Some("The admitted staging manifest is missing, malformed or inconsistent."),
      Self::StagingReplayConflict => Some("Staged operation data conflicts with its durable replay."),
      Self::PreflightStale => Some("The admitted snapshot or mapping is no longer valid. Review the operation again."),
      Self::OperationStateInvalid => Some("The operation's current state does not permit this action."),
      Self::MoveDocumentMetadataChanged => Some("Document metadata changed since transfer preparation."),
      Self::MoveDocumentAclChanged => Some("Document permissions changed since transfer preparation."),
      Self::ExtractOperationRevisionChanged => Some("Extract operation revision changed."),
      Self::ExtractTargetReplayChanged => Some("Extract target replay changed."),
      Self::ExtractTargetLifecycleChanged => Some("Extract target lifecycle changed."),
      Self::ExtractMembershipSnapshotChanged => Some("Extract membership snapshot changed."),
      Self::ExtractRecoveryTargetReceiptIsMissing => Some("Extract recovery target receipt is missing."),
      Self::PublishedExtractCannotBeCompensated => Some("published Extract cannot be compensated."),
      Self::ExtractRecoveryStateChanged => Some("Extract recovery state changed."),
      Self::ExtractRecoveryTargetLifecycleChanged => Some("Extract recovery target lifecycle changed."),
      Self::CopyTargetPolicyChanged => Some("Copy target policy changed."),
      Self::CopyTargetPageDirectoryChanged => Some("Copy target page directory changed."),
      Self::MoveRevisionManifestReplayChanged => Some("Move revision manifest replay changed."),
      Self::MoveTagLineageRequiresAFreshPreview => Some("Move Tag lineage requires a fresh preview."),
      Self::MoveReferencesRequireAFreshPreview => Some("Move references require a fresh preview."),
      Self::MoveOperationRevisionChanged => Some("Move operation revision changed."),
      Self::MoveTagLineageIsMissing => Some("Move Tag lineage is missing."),
      Self::MoveDatabaseRevisionIsMissing => Some("Move Database revision is missing."),
      Self::MoveDatabaseChildOwnershipChanged => Some("Move Database child ownership changed."),
      Self::MoveDocumentRevisionIsMissing => Some("Move Document revision is missing."),
      Self::MoveDocumentClassificationsChanged => Some("Move Document classifications changed."),
      Self::MoveDocumentOwnershipChanged => Some("Move Document ownership changed."),
      Self::MoveDocumentChildCountIsMissing => Some("Move Document child count is missing."),
      Self::MoveDocumentChildOwnershipChanged => Some("Move Document child ownership changed."),
      Self::MoveReferenceSourceChanged => Some("Move reference source changed."),
      Self::MoveReferencePlanIsMissing => Some("Move reference plan is missing."),
      Self::MoveTargetPageDirectoryChanged => Some("Move target page directory changed."),
      Self::ExtractTargetActivationChanged => Some("Extract target activation changed."),
      Self::ExtractTargetReceiptChanged => Some("Extract target receipt changed."),
      Self::ExtractBlobStagingStateChanged => Some("Extract Blob staging state changed."),
      Self::ExtractMembershipSnapshotIsInvalid => Some("Extract membership snapshot is invalid."),
      Self::ExtractRecipientSnapshotChanged => Some("Extract recipient snapshot changed."),
      Self::MoveRecipientSnapshotChanged => Some("Move recipient snapshot changed."),
      Self::MoveMappingChanged => Some("Move mapping changed."),
      Self::MovePersistedRevisionManifestChanged => Some("Move persisted revision manifest changed."),
      Self::PreparedTagIdentityWasRetired => Some("The prepared Tag identity was retired."),
      Self::PreparedTagIsNoLongerReusable => Some("The prepared Tag is no longer reusable."),
      Self::ConcurrentTagIdentityIsNotReusable => Some("A concurrent Tag identity is not reusable."),
      Self::MovedTagCellDisappeared => Some("A moved Tag cell disappeared."),
      Self::MovedTagTemplateDisappeared => Some("A moved Tag template disappeared."),
      Self::MovedTagFilterDisappeared => Some("A moved Tag filter disappeared."),
      Self::MovedTagPredicateDisappeared => Some("A moved Tag predicate disappeared."),
      Self::MovedTagFilterContainerChanged => Some("The moved Tag filter container changed."),
      Self::OwnedTagClassificationChanged => Some("An owned Tag classification changed."),
      Self::PlannedTagIdentityWasRetired => Some("The planned Tag identity was retired."),
      Self::PlannedTagIsNoLongerReusable => Some("The planned Tag is no longer reusable."),
      Self::UndoHasNoCommittedOriginReceipt => Some("Undo has no committed origin receipt."),
      Self::UndoOriginLineageHashChanged => Some("Undo origin lineage hash changed."),
      Self::UndoTagLineageRequiresAFreshPreview => Some("Undo Tag lineage requires a fresh preview."),
      Self::UndoExtractHasNoMatchingPublishedFolderReceipt => {
        Some("Undo Extract has no matching published folder receipt.")
      }
      Self::MoveRevisionChangedDuringPublication => Some("Move revision changed during publication."),
      Self::ExtractTargetWorkspaceIsMissing => Some("Extract target workspace is missing."),
      Self::ExtractTargetReceiptIsMissing => Some("Extract target receipt is missing."),
      Self::ExtractTargetLifecycleOwnershipChanged => Some("Extract target lifecycle ownership changed."),
      Self::ExtractTargetOwnershipChanged => Some("Extract target ownership changed."),
      Self::ExtractTargetRootChanged => Some("Extract target root changed."),
      Self::MoveTargetMissing => Some("Move target missing."),
      Self::WorkspaceContentTargetMembershipChanged => Some("workspace content target membership changed."),
      Self::PublicationSerializationConflict => Some("Publication serialization conflict."),
      Self::PublicationDeadlock => Some("Publication deadlock."),
      Self::DatabaseEditConflict => Some("Database edit conflict."),
      Self::DatabaseImportConflict => Some("Database import conflict."),
      Self::MoveContentRevisionChanged => Some("Move content revision changed."),
      Self::MoveRelatedRowsChanged => Some("Move related rows changed."),
      Self::MoveWorkspaceRootChanged => Some("Move workspace root changed."),
      Self::MoveHistoryReferencesChanged => Some("Move history references changed."),
      Self::MoveTagPlanChanged => Some("Move Tag plan changed."),
      Self::MoveDatabaseContentChanged => Some("Move Database content changed."),
      Self::MoveOrganizerReferencesChanged => Some("Move Organizer references changed."),
      Self::MoveBlobMetadataChanged => Some("Move Blob metadata changed."),
      Self::MoveNativeReferencePlanChanged => Some("Move native reference plan changed."),
      Self::MoveDocumentIdentityChanged => Some("Move document identity changed."),
      Self::MoveWorkspacePolicyChanged => Some("Move workspace policy changed."),
      Self::MoveUndoFolderChanged => Some("Move Undo folder changed."),
      Self::PreviewConfirmationMismatch => Some("Preview confirmation mismatch."),
      Self::LinkIntentWorkspaceChanged => Some("Link intent workspace changed."),
      Self::LinkOrganizerChanged => Some("Link Organizer changed."),
      Self::LinkTargetUnavailable => Some("Link target unavailable."),
      Self::NativeReferenceSnapshotChanged => Some("Native reference snapshot changed."),
      Self::NativeReferencePlanMissing => Some("Native reference plan missing."),
      Self::NativeReferenceVersionUnsupported => Some("Native reference version unsupported."),
      Self::DocumentSnapshotInvalid => Some("The owned document snapshot is malformed or cannot be decoded."),
      Self::DocumentMetadataInvalid => Some("The owned document metadata is missing or invalid."),
      Self::DatabaseSnapshotInvalid => Some("The owned Database snapshot is malformed or incomplete."),
      Self::DatabaseIdentityInvalid => Some("A Database or nested identity is missing or invalid."),
      Self::MappingPlanInvalid => Some("The admitted typed identity mapping is missing or invalid."),
      Self::SourceTagInvalid => Some("The owned source Tag definition is missing or malformed."),
      Self::TargetDefinitionChanged => Some("A destination definition changed after preview."),
      Self::TargetDefinitionMissing => Some("The destination definition selected for reuse no longer exists."),
      Self::RelationTargetOutsideSelection => Some("A Database relation points outside the supported Copy selection."),
      Self::RelationRowMissing => Some("A Database relation references an unknown row."),
      Self::ResourceIdentityAmbiguous => Some("The resource identity cannot be mapped unambiguously."),
      Self::OwnedBlobMappingMissing => Some("An owned attachment has no admitted mapping."),
      Self::OwnedDocumentMissing => Some("The admitted owned document payload is missing."),
      Self::EncodingFailed => Some("Operation-owned data could not be encoded."),
      Self::InventoryInvalid => Some("The typed source inventory is missing or malformed."),
      Self::InventoryLimit => Some("The resource inventory exceeds the bounded server limit."),
      Self::BlobMaterializationFailed => Some("Attachment materialization failed."),
      Self::BlobCompensationFailed => Some("Cleanup of unpublished operation-owned attachments requires retry."),
      Self::SourceWorkspaceMissing => Some("The source workspace is missing."),
      Self::RequestInvalid => Some("The selected operation request is invalid."),
      Self::GitSyncHandoffUnavailable => Some("The Git-Sync extraction handoff is not yet available."),
      Self::GitSyncUndoPending => {
        Some("Finish outstanding Git work or resolve affected conflicts before undoing extraction.")
      }
      Self::GitSyncUndoOwnershipChanged => {
        Some("Git scope ownership changed after extraction; Undo cannot reverse that scope.")
      }
      Self::GitSyncUndoContentChanged => {
        Some("Git files changed after extraction; review the remote content before Undo.")
      }
      Self::GitSyncUndoTargetNotEmpty => {
        Some("The extracted Workspace has independent content that cannot be reversed by this receipt.")
      }
      Self::GitSyncRemoteUnavailable => {
        Some("The Workspace is available; Git metadata is pending because the remote or writer is unavailable.")
      }
      Self::GitSyncMetadataConflict => Some(
        "The Workspace is available; recorded Git ownership or file bytes changed and require review before Retry.",
      ),
      Self::GitSyncMetadataAuthDenied => {
        Some("The Workspace is available; repair Git authentication or metadata-write permission before Retry.")
      }
      Self::GitSyncOutboundCleanupPending => Some(
        "The Workspace is available and detached Git files are retained. Metadata cleanup waits for a permitted outbound source sync.",
      ),
      Self::PublicationKindInvalid => Some("The publication operation is neither a move nor a folder extraction."),
      Self::PublicationStateInvalid => Some("The operation is not running and cannot publish its contents."),
      Self::PublicationMappingsEmpty => Some("The transfer has no resource mappings to publish."),
      Self::ExtractFolderBindingInvalid => Some("The extraction folder does not match the private target receipt."),
      Self::PublicationStagingUnexpected => Some("A move unexpectedly contains extraction staging entries."),
      Self::DiagnosticInstanceInvalid => Some("The worker diagnostic identity is invalid."),
      Self::TargetWorkspaceMissing => Some("The transfer destination workspace is missing."),
      Self::DistinctWorkspacesRequired => Some("Source and destination must be different workspaces."),
      Self::RecipientsEmpty => Some("The source-member notification snapshot is empty."),
      Self::RecipientBindingInvalid => {
        Some("A source-member notification is bound to another operation, actor or workspace.")
      }
      Self::RecipientCountInvalid => Some("A notification resource count does not match the transfer manifest."),
      Self::RecipientKindsInvalid => Some("A notification contains duplicate, unordered or unmapped resource types."),
      Self::RecipientRevisionInvalid => Some("A notification snapshot revision is missing or inconsistent."),
      Self::RecipientDuplicate => Some("The notification snapshot contains a duplicate recipient."),
      Self::RecipientActorMissing => Some("The transfer actor is missing from the notification snapshot."),
      Self::RecipientReplayConflict => Some("Published notifications do not match this operation's replay."),
      Self::BlobStagingEntryMissing => Some("An attachment has no verified extraction staging entry."),
      Self::TargetBlobBytesConflict => Some("An attachment in the destination has different bytes under the same key."),
      Self::TargetBlobMetadataConflict => Some("An attachment key is already registered in the destination."),
      Self::TargetDocumentKeyConflict => Some("A different destination document already uses the mapped key."),
      Self::TagIdentityChanged => Some("The move mapping would change a canonical tag identity."),
      Self::DatabaseIdentityChanged => Some("The move mapping would change a canonical database identity."),
      Self::CollectionIdentityChanged => Some("The move mapping would change a canonical collection identity."),
      Self::ResourceCountInvalid => Some("The publication resource count exceeds the supported range."),
      Self::PublicationTerminalConflict => Some("The operation changed state before publication could be committed."),
      Self::SourceDocumentMissing => Some("A source document disappeared before publication."),
      Self::SourceBlobMissing => Some("A source attachment disappeared before publication."),
      Self::SourceTagMissing => Some("A source tag disappeared before publication."),
      Self::SourceDatabaseMissing => Some("A source database disappeared before publication."),
      Self::SourceRootMissing => Some("A required workspace page-directory document is missing."),
      Self::PublicationWorkspaceMissing => {
        Some("A source or destination workspace is absent or has the wrong lifecycle state.")
      }
      Self::TagAssignmentConstraint => Some("A Tag assignment violates a workspace-scoped catalog reference."),
      Self::DatabaseUniqueConstraint => {
        Some("Publication conflicts with an existing database identity or unique value.")
      }
      Self::DatabaseForeignKeyConstraint => {
        Some("Publication would leave a database reference pointing to a missing resource.")
      }
      Self::DatabaseCheckConstraint => Some("Publication violates a database consistency rule."),
      Self::DatabaseNotNullConstraint => Some("A required database field is missing during publication."),
      Self::OrganizerDecode => Some("The folder document cannot be decoded."),
      Self::OrganizerMalformedRow => Some("A folder or link row has malformed fields."),
      Self::OrganizerFolderMissing => Some("The selected folder no longer exists."),
      Self::OrganizerEntryMissing => Some("A selected folder entry no longer exists."),
      Self::OrganizerParentMissing => Some("A folder entry has a missing or non-folder parent."),
      Self::OrganizerCycle => Some("The folder hierarchy contains a cycle."),
      Self::OrganizerDuplicate => Some("The folder document contains duplicate links to a resource."),
      Self::OrganizerNameInvalid => Some("A folder name is empty or exceeds 256 characters."),
      Self::OrganizerLinkTypeInvalid => Some("A folder entry uses an unsupported link type."),
      Self::OrganizerTargetInvalid => Some("A folder link has no resource target."),
      Self::OrganizerWorkspaceTargetInvalid => {
        Some("A workspace link has an invalid or inconsistent target workspace.")
      }
      Self::OrganizerEntryAtRoot => Some("A non-folder entry is placed at the Organizer root."),
      Self::OrganizerMutationEmpty => Some("The folder projection contains no mutation."),
      Self::OrganizerOrderInvalid => Some("A folder entry has an invalid ordering key."),
      Self::OrganizerReindexRequired => Some("Folder ordering requires an order-preserving repair before transfer."),
      Self::OrganizerRevisionStale => Some("The folder hierarchy changed after its transfer projection was prepared."),
      Self::OrganizerKeyInvalid => Some("The Organizer system-document key is invalid."),
      Self::CollectionDecode => Some("A workspace collection projection cannot be decoded."),
      Self::WorkerRetryExhausted => Some("The worker exhausted its retry budget after dependency failures."),
      Self::UnexpectedValidation => {
        Some("The server returned an unregistered validation failure; diagnostic correlation is required.")
      }
      Self::TransferForbidden => Some("The admitted transfer receipt does not authorize this publication."),
      _ => None,
    }
  }
}

/// Bounded, explicitly redacted diagnostic stored with a failed operation.
///
/// The message may describe a category or operator action, but must never
/// contain credentials, raw payloads, document titles, blob keys, or content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedWorkspaceContentError {
  pub code: WorkspaceContentErrorCode,
  message: String,
  /// Actual failing boundary; legacy failures have no recorded phase.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub phase: Option<String>,
}

impl RedactedWorkspaceContentError {
  pub fn new(code: WorkspaceContentErrorCode, message: impl Into<String>) -> Result<Self, WorkspaceContentDomainError> {
    let message = message.into();
    if message.is_empty() || message.len() > MAX_REDACTED_ERROR_BYTES || message.chars().any(char::is_control) {
      return Err(WorkspaceContentDomainError::InvalidRedactedError);
    }
    Ok(Self {
      code,
      message,
      phase: None,
    })
  }

  pub fn with_phase(mut self, phase: &str) -> Self {
    assert!(
      !phase.is_empty() && phase.len() <= 64 && phase.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    );
    self.phase = Some(phase.to_string());
    self
  }

  /// Read old cancellation markers without using free-form messages for new failures.
  pub fn is_cancellation_cleanup(&self) -> bool {
    self.code == WorkspaceContentErrorCode::CancellationCleanupRequired
      || (self.code == WorkspaceContentErrorCode::WorkerExecutionFailed
        && self.message == "workspace content cancellation cleanup requires retry")
  }

  pub fn message(&self) -> &str {
    &self.message
  }
}

/// Deterministic source-to-target identity mapping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentIdMapping {
  pub source: WorkspaceContentResourceRef,
  pub target: WorkspaceContentResourceRef,
}

impl WorkspaceContentIdMapping {
  pub fn new(
    source: WorkspaceContentResourceRef,
    target: WorkspaceContentResourceRef,
  ) -> Result<Self, WorkspaceContentDomainError> {
    if source.kind() != target.kind() {
      return Err(WorkspaceContentDomainError::ResourceKindMismatch);
    }
    Ok(Self { source, target })
  }
}

/// Durable operation metadata. Content and credentials are deliberately absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentOperationRecord {
  pub id: WorkspaceContentOperationId,
  pub idempotency_id: Uuid,
  pub actor_id: UserId,
  pub kind: WorkspaceContentOperationKind,
  pub source_workspace_id: WorkspaceId,
  pub target_workspace_id: Option<WorkspaceId>,
  pub status: WorkspaceContentOperationStatus,
  pub preview_revision: Option<String>,
  pub manifest_hash: String,
  pub error: Option<RedactedWorkspaceContentError>,
  /// Redacted diagnostics only; this value never owns execution or a lease.
  pub diagnostic_instance_id: Option<String>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Publication state for one payload in the operation-owned staging namespace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceContentStagingStatus {
  Staged,
  Published,
  CleanupRequired,
  Deleted,
}

impl WorkspaceContentStagingStatus {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Staged => "staged",
      Self::Published => "published",
      Self::CleanupRequired => "cleanup_required",
      Self::Deleted => "deleted",
    }
  }
}

/// Bounded reference to a payload stored outside PostgreSQL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentStagingEntry {
  pub operation_id: WorkspaceContentOperationId,
  pub sequence: i32,
  pub resource: WorkspaceContentResourceRef,
  object_key: String,
  content_hash: String,
  pub size_bytes: i64,
  pub status: WorkspaceContentStagingStatus,
}

impl WorkspaceContentStagingEntry {
  pub fn new(
    operation_id: WorkspaceContentOperationId,
    sequence: i32,
    resource: WorkspaceContentResourceRef,
    object_key: impl Into<String>,
    content_hash: impl Into<String>,
    size_bytes: i64,
  ) -> Result<Self, WorkspaceContentDomainError> {
    let object_key = object_key.into();
    let content_hash = content_hash.into();
    if operation_id.is_nil() || sequence < 0 {
      return Err(WorkspaceContentDomainError::InvalidStagingIdentity);
    }
    if object_key.is_empty()
      || object_key.len() > MAX_STAGING_KEY_BYTES
      || object_key.trim() != object_key
      || object_key.chars().any(char::is_control)
    {
      return Err(WorkspaceContentDomainError::InvalidStagingKey);
    }
    if !is_sha256_hex(&content_hash) {
      return Err(WorkspaceContentDomainError::InvalidContentHash);
    }
    if !(1..=MAX_STAGED_OBJECT_BYTES).contains(&size_bytes) {
      return Err(WorkspaceContentDomainError::InvalidStagedObjectSize);
    }
    Ok(Self {
      operation_id,
      sequence,
      resource,
      object_key,
      content_hash,
      size_bytes,
      status: WorkspaceContentStagingStatus::Staged,
    })
  }

  pub fn object_key(&self) -> &str {
    &self.object_key
  }

  pub fn content_hash(&self) -> &str {
    &self.content_hash
  }
}

/// One durable compensation step. The target is a qualified product identity,
/// never raw content or a storage credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentCompensation {
  pub id: i64,
  pub operation_id: WorkspaceContentOperationId,
  pub sequence: i64,
  pub kind: String,
  pub target: WorkspaceContentResourceRef,
  pub completed_at: Option<DateTime<Utc>>,
  pub last_error: Option<RedactedWorkspaceContentError>,
  pub created_at: DateTime<Utc>,
}

fn is_sha256_hex(value: &str) -> bool {
  value.len() == SHA256_HEX_BYTES && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum WorkspaceContentDomainError {
  #[error("workspace-qualified resource requires a non-nil workspace id")]
  MissingWorkspaceQualification,
  #[error("resource id is invalid")]
  InvalidResourceId,
  #[error("user id is invalid")]
  InvalidUserId,
  #[error("human Owner membership cannot be created by a content operation")]
  HumanOwnerMembershipForbidden,
  #[error("source and target resource kinds differ")]
  ResourceKindMismatch,
  #[error("redacted operation error is invalid")]
  InvalidRedactedError,
  #[error("staging identity is invalid")]
  InvalidStagingIdentity,
  #[error("staging object key is invalid")]
  InvalidStagingKey,
  #[error("staging content hash must be lowercase or uppercase SHA-256 hex")]
  InvalidContentHash,
  #[error("staging object size is outside the supported bound")]
  InvalidStagedObjectSize,
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn state_machine_allows_only_the_declared_edges() {
    let states = [
      WorkspaceContentOperationStatus::Draft,
      WorkspaceContentOperationStatus::Previewed,
      WorkspaceContentOperationStatus::Queued,
      WorkspaceContentOperationStatus::Running,
      WorkspaceContentOperationStatus::Succeeded,
      WorkspaceContentOperationStatus::Cancelled,
      WorkspaceContentOperationStatus::Failed,
      WorkspaceContentOperationStatus::CleanupRequired,
    ];
    let allowed = [
      (states[0], states[1]),
      (states[0], states[5]),
      (states[0], states[6]),
      (states[1], states[2]),
      (states[1], states[5]),
      (states[1], states[6]),
      (states[2], states[3]),
      (states[2], states[5]),
      (states[2], states[6]),
      (states[3], states[3]), // Persist the latest retry cause without changing execution state.
      (states[3], states[4]),
      (states[3], states[5]),
      (states[3], states[6]),
      (states[3], states[7]),
      (states[5], states[7]),
      (states[6], states[2]),
      (states[7], states[3]),
      (states[7], states[5]),
      (states[7], states[6]),
    ];

    for from in states {
      for to in states {
        assert_eq!(
          from.can_transition_to(to),
          allowed.contains(&(from, to)),
          "unexpected transition {from:?} -> {to:?}"
        );
      }
    }
  }

  #[test]
  fn resource_refs_require_unambiguous_workspace_qualification() {
    let workspace_id = Uuid::new_v4();
    assert_eq!(
      WorkspaceContentResourceRef::new(Uuid::nil(), WorkspaceContentResourceKind::Document, "doc"),
      Err(WorkspaceContentDomainError::MissingWorkspaceQualification)
    );
    for invalid in ["", " doc", "doc ", "doc\nkey"] {
      assert_eq!(
        WorkspaceContentResourceRef::new(workspace_id, WorkspaceContentResourceKind::Document, invalid),
        Err(WorkspaceContentDomainError::InvalidResourceId)
      );
    }
  }

  #[test]
  fn target_membership_cannot_create_a_human_owner() {
    assert_eq!(
      TargetMembershipConfirmation::new(Uuid::new_v4(), WorkspaceRole::Owner),
      Err(WorkspaceContentDomainError::HumanOwnerMembershipForbidden)
    );
    let manager = TargetMembershipConfirmation::new(Uuid::new_v4(), WorkspaceRole::Manager)
      .expect("Manager is a supported membership impact");
    assert_eq!(manager.role(), WorkspaceRole::Manager);
  }

  #[test]
  fn identity_mapping_cannot_change_resource_family() {
    let source =
      WorkspaceContentResourceRef::new(Uuid::new_v4(), WorkspaceContentResourceKind::Document, "source-doc").unwrap();
    let target = WorkspaceContentResourceRef::new(
      Uuid::new_v4(),
      WorkspaceContentResourceKind::Database,
      Uuid::new_v4().to_string(),
    )
    .unwrap();
    assert_eq!(
      WorkspaceContentIdMapping::new(source, target),
      Err(WorkspaceContentDomainError::ResourceKindMismatch)
    );
  }

  #[test]
  fn serialized_contract_contains_only_stable_product_identity() {
    let resource = WorkspaceContentResourceRef::new(
      Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
      WorkspaceContentResourceKind::Document,
      "document-key",
    )
    .unwrap();
    assert_eq!(
      serde_json::to_value(resource).unwrap(),
      serde_json::json!({
        "workspaceId": "11111111-1111-4111-8111-111111111111",
        "kind": "document",
        "resourceId": "document-key"
      })
    );
    assert_eq!(
      serde_json::to_value(WorkspaceContentErrorCode::PreflightStale).unwrap(),
      "XWS_PREFLIGHT_STALE"
    );
  }

  #[test]
  fn staging_manifest_rejects_unbounded_or_ambiguous_metadata() {
    let operation_id = Uuid::new_v4();
    let resource =
      WorkspaceContentResourceRef::new(Uuid::new_v4(), WorkspaceContentResourceKind::Blob, "blob-id").unwrap();
    let hash = "a".repeat(SHA256_HEX_BYTES);
    assert!(
      WorkspaceContentStagingEntry::new(
        operation_id,
        0,
        resource.clone(),
        "workspace-content/operation/blob",
        &hash,
        1,
      )
      .is_ok()
    );
    for (key, hash, size, expected) in [
      (
        " key",
        "a".repeat(SHA256_HEX_BYTES),
        1,
        WorkspaceContentDomainError::InvalidStagingKey,
      ),
      (
        "key",
        "not-a-hash".to_string(),
        1,
        WorkspaceContentDomainError::InvalidContentHash,
      ),
      (
        "key",
        "a".repeat(SHA256_HEX_BYTES),
        MAX_STAGED_OBJECT_BYTES + 1,
        WorkspaceContentDomainError::InvalidStagedObjectSize,
      ),
    ] {
      assert_eq!(
        WorkspaceContentStagingEntry::new(operation_id, 0, resource.clone(), key, hash, size),
        Err(expected)
      );
    }
  }
}
