// SPDX-License-Identifier: AGPL-3.0-or-later
//! Identity-preserving publication for cross-workspace Move operations.
//!
//! Move deliberately has its own publication contract. Reusing Copy would
//! allocate new document identities and therefore lose the identity boundary
//! shared by history, comments, attachments and ACL rows.

use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::ids::UserId;
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use myoxus_domain::workspace_content_operation::{
  WorkspaceContentErrorCode, WorkspaceContentIdMapping, WorkspaceContentOperationKind, WorkspaceContentOperationRecord,
  WorkspaceContentOperationStatus, WorkspaceContentResourceKind, WorkspaceContentResourceRef,
  WorkspaceContentStagingEntry,
};
use serde::{Deserialize, Serialize};
use sha2::Digest;

use crate::auth::{AuthError, AuthResult};
use crate::doc::{DocService, DocSpaceKind};
use crate::organizer::{OrganizerMoveProjection, OrganizerService};
use crate::permission::{AccessController, DocResource, PermissionService, WorkspaceResource};
use crate::ports::{BlobStoragePort, BlobWriteRequest, PortError};

use super::extract::WorkspaceContentExtractContextPort;
use super::worker::WorkspaceContentSemanticExecutor;
use super::{
  WorkspaceContentOperationRepository, WorkspaceContentRecipientIntent, WorkspaceContentStagingManifestRepository,
};

#[derive(Debug, Clone)]
pub struct WorkspaceContentMovePublicationBatch {
  pub operation: WorkspaceContentOperationRecord,
  pub mappings: Vec<WorkspaceContentIdMapping>,
  pub revision_manifest: WorkspaceContentMoveRevisionManifest,
  pub organizer: Option<OrganizerMoveProjection>,
  pub recipient_intents: Vec<WorkspaceContentRecipientIntent>,
  /// Present only for Extract and bound by the hidden-target receipt.
  pub extract_source_folder_id: Option<String>,
  /// Operation-owned Blob copies used only by Extract publication.
  pub staging_entries: Vec<WorkspaceContentStagingEntry>,
}

/// Complete optimistic-concurrency input for one identity-preserving Move.
///
/// The manifest is captured in one repeatable-read transaction before
/// publication and compared again under the short serializable publication
/// transaction. Document payloads remain outside this contract. Bounded Tag
/// definitions and ordered, typed positions retain otherwise lost merge lineage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceContentMoveRevisionManifest {
  /// Exact settings before publication; old manifests retain omitted fields
  /// and their original hash. Unrelated workspace policy remains independent.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub overview: Option<super::overview::WorkspaceContentOverviewSnapshot>,
  /// Content-free contained-reference proofs; absent legacy manifests are readable.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub organizer_reference_decisions: Option<Vec<(String, super::WorkspaceContentReferenceDecision)>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub organizer_reference_revision: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub reference_plans: Option<Vec<super::WorkspaceContentNativeReferencePlan>>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub history_reference_lineage: Vec<crate::doc::history::DocHistoryReferenceLineage>,
  pub documents: Vec<WorkspaceContentMoveDocumentRevision>,
  pub blobs: Vec<WorkspaceContentMoveBlobRevision>,
  pub organizer_roots: Vec<WorkspaceContentMoveOrganizerRevision>,
  pub databases: Vec<WorkspaceContentMoveDatabaseRevision>,
  pub workspaces: Vec<WorkspaceContentMoveWorkspaceRevision>,
  /// Absent on deployed relocation manifests, which remain readable but must
  /// never be admitted to the classification-preserving publisher.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub tags: Option<WorkspaceContentMoveTagManifest>,
  /// Receipt-bound original folder slot restored by an Extract counter-operation.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub undo_extract_folder_id: Option<String>,
}

pub const MOVE_TAG_MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceContentMoveTagManifest {
  pub version: u32,
  pub definitions: Vec<myoxus_domain::workspace_tags::WorkspaceTag>,
  /// New target records, including replacements for permanently deleted
  /// original IDs during Undo. Existing destination metadata is never staged
  /// as an overwrite. Final timestamps and a free slug are assigned in SQL.
  pub materializations: Vec<myoxus_domain::workspace_tags::WorkspaceTag>,
  pub positions: Vec<WorkspaceContentMoveTagLineage>,
}

/// A position belongs to an immutable SQL identity, never a display name or
/// arbitrary JSON string. Filter offsets additionally bind the exact container
/// and typed rule context before Undo may restore collapsed source identities.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceContentMoveTagPosition {
  Document {
    doc_id: uuid::Uuid,
  },
  Cell {
    database_id: uuid::Uuid,
    row_id: uuid::Uuid,
    field_id: uuid::Uuid,
  },
  Template {
    database_id: uuid::Uuid,
    template_id: uuid::Uuid,
    field_id: uuid::Uuid,
  },
  Filter {
    database_id: uuid::Uuid,
    view_id: uuid::Uuid,
    path: String,
  },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceContentMoveTagLineage {
  pub position: WorkspaceContentMoveTagPosition,
  pub source_ids: Vec<uuid::Uuid>,
  pub target_ids: Vec<uuid::Uuid>,
  /// Filter-only hash of the published container; empty for stable SQL cells.
  pub container_hash: String,
  /// Filter-only semantic rule/ancestor context for unique unchanged rules
  /// when another rule was edited. Duplicate contexts require the container hash.
  pub context_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceContentMoveBlobRevision {
  pub resource: WorkspaceContentResourceRef,
  pub metadata_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceContentMoveDocumentRevision {
  pub resource: WorkspaceContentResourceRef,
  pub doc_id: uuid::Uuid,
  pub content_sequence: i64,
  pub content_hash: String,
  /// Exact snapshot/tail bytes bind reference offsets even if equivalent Yjs
  /// materializations serialize legacy Any-map properties in a different order.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub reference_source_sha256: Option<String>,
  pub metadata_revision: i64,
  pub metadata_hash: String,
  pub acl_hash: String,
  /// Expected rows in every workspace-qualified ownership update.
  pub ownership_row_counts: std::collections::BTreeMap<String, u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceContentMoveOrganizerRevision {
  pub workspace_id: uuid::Uuid,
  pub content_sequence: i64,
  pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceContentMoveDatabaseRevision {
  pub resource: WorkspaceContentResourceRef,
  pub parent_edit_revision: i64,
  /// Hash of every deterministically ordered core and workspace-qualified
  /// Database child row, including operational side tables moved with it.
  pub child_revision_hash: String,
  pub ownership_row_counts: std::collections::BTreeMap<String, u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceContentMoveWorkspaceRevision {
  pub workspace_id: uuid::Uuid,
  pub owner_principal_type: String,
  pub owner_principal_id: Option<uuid::Uuid>,
  pub policy_hash: String,
  pub membership_hash: String,
}

#[async_trait]
pub trait WorkspaceContentMoveRevisionManifestPort: Send + Sync {
  /// Capture and persist the immutable publication manifest exactly once.
  async fn prepare_move_revision_manifest(
    &self,
    operation: &WorkspaceContentOperationRecord,
    mappings: &[WorkspaceContentIdMapping],
  ) -> AuthResult<WorkspaceContentMoveRevisionManifest>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentRecipientSnapshot {
  pub revision: String,
  pub source_workspace_name: String,
  pub recipient_ids: Vec<UserId>,
}

#[async_trait]
pub trait WorkspaceContentRecipientSnapshotPort: Send + Sync {
  /// Snapshot accepted source members plus the actor before ownership changes.
  async fn recipient_snapshot(
    &self,
    source_workspace_id: uuid::Uuid,
    actor_id: UserId,
  ) -> AuthResult<WorkspaceContentRecipientSnapshot>;
}

#[async_trait]
pub trait WorkspaceContentMovePublicationPort: Send + Sync {
  /// Preserve every mapped canonical identity and terminalize atomically.
  async fn publish_move(
    &self,
    batch: WorkspaceContentMovePublicationBatch,
    diagnostic_instance_id: &str,
  ) -> super::diagnostics::WorkspaceContentExecutionResult<WorkspaceContentOperationRecord>;
}

pub struct WorkspaceContentMovePublicationService {
  operations: Arc<dyn WorkspaceContentOperationRepository>,
  manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
  permission: Arc<PermissionService>,
  recipient_source: Arc<dyn WorkspaceContentRecipientSnapshotPort>,
  revision_manifests: Arc<dyn WorkspaceContentMoveRevisionManifestPort>,
  doc: DocService,
  publisher: Arc<dyn WorkspaceContentMovePublicationPort>,
  diagnostic_instance_id: String,
  extract_context: Option<Arc<dyn WorkspaceContentExtractContextPort>>,
  extract_storage: Option<Arc<dyn BlobStoragePort>>,
}

impl WorkspaceContentMovePublicationService {
  #[expect(
    clippy::too_many_arguments,
    reason = "the constructor exposes mandatory publication capabilities explicitly"
  )]
  pub fn new(
    operations: Arc<dyn WorkspaceContentOperationRepository>,
    manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
    permission: Arc<PermissionService>,
    recipient_source: Arc<dyn WorkspaceContentRecipientSnapshotPort>,
    revision_manifests: Arc<dyn WorkspaceContentMoveRevisionManifestPort>,
    doc: DocService,
    publisher: Arc<dyn WorkspaceContentMovePublicationPort>,
    diagnostic_instance_id: String,
  ) -> Self {
    Self {
      operations,
      manifests,
      permission,
      recipient_source,
      revision_manifests,
      doc,
      publisher,
      diagnostic_instance_id,
      extract_context: None,
      extract_storage: None,
    }
  }

  pub fn with_extract(
    mut self,
    context: Arc<dyn WorkspaceContentExtractContextPort>,
    storage: Arc<dyn BlobStoragePort>,
  ) -> Self {
    self.extract_context = Some(context);
    self.extract_storage = Some(storage);
    self
  }

  async fn authorize(
    &self,
    operation: &WorkspaceContentOperationRecord,
    mappings: &[WorkspaceContentIdMapping],
  ) -> AuthResult<()> {
    if operation.kind == WorkspaceContentOperationKind::ExtractFolder {
      // Execute already authorized this durable operation. Validate its
      // private receipt, not the actor's possibly changed live permissions.
      self
        .extract_context
        .as_ref()
        .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?
        .extract_target_owner(operation)
        .await?
        .ok_or(AuthError::ActionForbidden)?;
      return Ok(());
    }
    // Control admitted this durable Move. Later actor rights cannot revoke
    // that decision; the worker still verifies persisted operation identities.
    if operation.kind != WorkspaceContentOperationKind::Move || mappings.is_empty() {
      return Err(AuthError::ActionForbidden);
    }
    Ok(())
  }

  async fn project_organizer(
    &self,
    operation: &WorkspaceContentOperationRecord,
    mappings: &[WorkspaceContentIdMapping],
    revision_manifest: &WorkspaceContentMoveRevisionManifest,
  ) -> AuthResult<Option<OrganizerMoveProjection>> {
    let target_workspace_id = operation
      .target_workspace_id
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().to_string()))?;
    let decisions = revision_manifest
      .organizer_reference_decisions
      .as_deref()
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::NativeReferencePlanMissing.as_str().into()))?;
    let organizer = OrganizerService::new(self.doc.clone());
    let projection = if operation.kind == WorkspaceContentOperationKind::ExtractFolder {
      let source_folder_id = self
        .extract_context
        .as_ref()
        .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?
        .extract_source_folder_id(operation.id)
        .await?;
      organizer
        .project_extract(
          operation.source_workspace_id,
          target_workspace_id,
          &source_folder_id,
          mappings,
          decisions,
        )
        .await
    } else if let Some(folder_id) = revision_manifest.undo_extract_folder_id.as_deref() {
      organizer
        .project_undo_extract(
          operation.source_workspace_id,
          target_workspace_id,
          folder_id,
          mappings,
          decisions,
        )
        .await
    } else {
      organizer
        .project_move(operation.source_workspace_id, target_workspace_id, mappings, decisions)
        .await
    }
    .map_err(super::diagnostics::organizer_failure)?;
    if revision_manifest.organizer_reference_revision.as_deref() != Some(projection.source_reference_revision.as_str())
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::MoveOrganizerReferencesChanged
          .as_str()
          .into(),
      ));
    }
    Ok((!projection.source_rows.is_empty() || !projection.target_rows.is_empty()).then_some(projection))
  }

  async fn recipient_intents(
    &self,
    operation: &WorkspaceContentOperationRecord,
    mappings: &[WorkspaceContentIdMapping],
  ) -> AuthResult<Vec<WorkspaceContentRecipientIntent>> {
    let snapshot = if operation.kind == WorkspaceContentOperationKind::ExtractFolder {
      self
        .extract_context
        .as_ref()
        .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?
        .extract_recipient_snapshot(operation)
        .await?
    } else {
      self
        .recipient_source
        .recipient_snapshot(operation.source_workspace_id, operation.actor_id)
        .await?
    };
    if snapshot.recipient_ids.is_empty() || !snapshot.recipient_ids.contains(&operation.actor_id) {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::RecipientsEmpty.as_str().to_string(),
      ));
    }
    let mut intents = Vec::with_capacity(snapshot.recipient_ids.len());
    for recipient_id in snapshot.recipient_ids {
      let workspace = WorkspaceResource {
        user_id: recipient_id,
        workspace_id: operation.source_workspace_id,
      };
      let mut visible_resource_kinds = BTreeSet::new();
      let mut resource_count = 0_i32;
      for mapping in mappings {
        let visible = match mapping.source.kind() {
          WorkspaceContentResourceKind::Collection => {
            return Err(AuthError::InvalidInput(
              WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str().into(),
            ));
          }
          WorkspaceContentResourceKind::Document => {
            let key = DocumentKey::parse(mapping.source.resource_id()).map_err(|_| {
              AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string())
            })?;
            let Some(doc_id) = self
              .doc
              .resolve_document_key(operation.source_workspace_id, DocSpaceKind::Workspace, &key)
              .await?
            else {
              return Err(AuthError::NotFound(
                WorkspaceContentErrorCode::SourceDocumentMissing.as_str().to_string(),
              ));
            };
            self
              .permission
              .can(
                &DocResource {
                  user_id: recipient_id,
                  workspace_id: operation.source_workspace_id,
                  doc_id,
                },
                DocAction::Read,
              )
              .await
          }
          // Source Blob catalogs remain; target materialization is not departed content.
          WorkspaceContentResourceKind::Blob => continue,
          WorkspaceContentResourceKind::Folder => self.permission.can(&workspace, WorkspaceAction::Read).await,
          WorkspaceContentResourceKind::Database | WorkspaceContentResourceKind::Tag => {
            self.permission.can(&workspace, WorkspaceAction::Read).await
          }
        };
        if visible {
          resource_count = resource_count.checked_add(1).ok_or_else(|| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::ResourceCountInvalid.as_str().to_string())
          })?;
          visible_resource_kinds.insert(mapping.source.kind());
        }
      }
      intents.push(WorkspaceContentRecipientIntent {
        operation_id: operation.id,
        recipient_id,
        event_kind: "workspace_content_moved".to_string(),
        source_workspace_id: operation.source_workspace_id,
        source_workspace_name: snapshot.source_workspace_name.clone(),
        actor_id: operation.actor_id,
        resource_count,
        visible_resource_kinds: visible_resource_kinds.into_iter().collect(),
        recipient_snapshot_revision: snapshot.revision.clone(),
      });
    }
    Ok(intents)
  }

  async fn stage_extract_blobs(
    &self,
    operation: &WorkspaceContentOperationRecord,
    mappings: &[WorkspaceContentIdMapping],
  ) -> AuthResult<Vec<WorkspaceContentStagingEntry>> {
    if operation.kind != WorkspaceContentOperationKind::ExtractFolder {
      return Ok(Vec::new());
    }
    let blob_mappings = mappings
      .iter()
      .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Blob)
      .collect::<Vec<_>>();
    if blob_mappings.is_empty() {
      return Ok(Vec::new());
    }
    let storage = self
      .extract_storage
      .as_ref()
      .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?;
    let existing = self.manifests.list_staging_entries(operation.id).await?;
    if !existing.is_empty() {
      if existing.len() != blob_mappings.len() {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string(),
        ));
      }
      for (entry, mapping) in existing.iter().zip(blob_mappings.iter()) {
        match storage.read_blob(entry.object_key()).await {
          Ok(payload)
            if entry.size_bytes == i64::try_from(payload.data.len()).unwrap_or(-1)
              && entry
                .content_hash()
                .eq_ignore_ascii_case(&hex::encode(sha2::Sha256::digest(&payload.data))) => {}
          Ok(_) => {
            return Err(AuthError::InvalidInput(
              WorkspaceContentErrorCode::BlobIntegrityMismatch.as_str().to_string(),
            ));
          }
          Err(PortError::NotFound(_)) => {
            let source = storage
              .read_blob(&format!(
                "{}/{}",
                operation.source_workspace_id,
                mapping.source.resource_id()
              ))
              .await
              .map_err(extract_storage)?;
            if entry.size_bytes != i64::try_from(source.data.len()).unwrap_or(-1)
              || !entry
                .content_hash()
                .eq_ignore_ascii_case(&hex::encode(sha2::Sha256::digest(&source.data)))
            {
              return Err(AuthError::InvalidInput(
                WorkspaceContentErrorCode::BlobIntegrityMismatch.as_str().to_string(),
              ));
            }
            storage
              .write_blob(BlobWriteRequest {
                key: entry.object_key().to_string(),
                content_type: source.content_type,
                body: source.data,
              })
              .await
              .map_err(extract_storage)?;
          }
          Err(error) => return Err(extract_storage(error)),
        }
      }
      return Ok(existing);
    }
    let mut entries = Vec::with_capacity(blob_mappings.len());
    let mut payloads = Vec::with_capacity(blob_mappings.len());
    for (sequence, mapping) in blob_mappings.into_iter().enumerate() {
      let source_key = format!("{}/{}", operation.source_workspace_id, mapping.source.resource_id());
      let source = storage.read_blob(&source_key).await.map_err(extract_storage)?;
      let content_hash = hex::encode(sha2::Sha256::digest(&source.data));
      // Equal bytes do not merge independently mapped Blob identities.
      let object_key = format!(
        "workspace-content/{}/extract-blobs/{sequence}/{content_hash}",
        operation.id
      );
      entries.push(
        WorkspaceContentStagingEntry::new(
          operation.id,
          i32::try_from(sequence).map_err(|_| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string())
          })?,
          mapping.target.clone(),
          object_key,
          content_hash,
          i64::try_from(source.data.len())
            .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::BlobSizeLimit.as_str().to_string()))?,
        )
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))?,
      );
      payloads.push((source.content_type, source.data));
    }
    self
      .manifests
      .store_manifest(operation.id, &operation.manifest_hash, mappings, &entries)
      .await?;
    for (entry, (content_type, body)) in entries.iter().zip(payloads) {
      storage
        .write_blob(BlobWriteRequest {
          key: entry.object_key().to_string(),
          content_type,
          body,
        })
        .await
        .map_err(extract_storage)?;
    }
    Ok(entries)
  }
}

fn extract_storage(error: PortError) -> AuthError {
  super::diagnostics::record_port_failure(&error, "blob_staging");
  match error {
    PortError::NotFound(_) => AuthError::NotFound(WorkspaceContentErrorCode::SourceBlobMissing.as_str().to_string()),
    _ => AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()),
  }
}

#[cfg(test)]
mod diagnostic_tests {
  use super::*;

  #[test]
  fn extract_storage_preserves_categories_without_port_payloads() {
    for error in [
      PortError::Transport("secret-token-and-document-content".into()),
      PortError::Conflict("secret-token-and-document-content".into()),
      PortError::InvalidInput("secret-token-and-document-content".into()),
    ] {
      let mapped = extract_storage(error);
      assert!(matches!(mapped, AuthError::Storage(_)));
      assert!(!mapped.to_string().contains("secret-token-and-document-content"));
    }
    assert!(matches!(
      extract_storage(PortError::NotFound("secret-token-and-document-content".into())),
      AuthError::NotFound(_)
    ));
  }
}

#[async_trait]
impl WorkspaceContentSemanticExecutor for WorkspaceContentMovePublicationService {
  async fn execute(
    &self,
    record: WorkspaceContentOperationRecord,
  ) -> super::diagnostics::WorkspaceContentExecutionResult<WorkspaceContentOperationRecord> {
    let current = self
      .operations
      .get(record.id)
      .await?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
    if current != record
      || !matches!(
        current.kind,
        WorkspaceContentOperationKind::Move | WorkspaceContentOperationKind::ExtractFolder
      )
      || current.status != WorkspaceContentOperationStatus::Running
    {
      return Err(
        AuthError::InvalidInput(WorkspaceContentErrorCode::PublicationStateInvalid.as_str().to_string()).into(),
      );
    }
    let mut mappings = self.manifests.list_mappings(record.id).await?;
    super::reject_collection_mappings(&mappings)?;
    super::reject_tag_relocation_mappings(&mappings)?;
    mappings.sort_by(|left, right| left.source.cmp(&right.source));
    if mappings.is_empty()
      || mappings.iter().any(|mapping| {
        mapping.source.workspace_id() != record.source_workspace_id
          || Some(mapping.target.workspace_id()) != record.target_workspace_id
      })
    {
      return Err(AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()).into());
    }
    self.authorize(&record, &mappings).await.map_err(|error| {
      super::diagnostics::record_failure(&record, "authorization", &error);
      super::diagnostics::WorkspaceContentExecutionError::at_phase(error, "authorization")
    })?;
    let revision_manifest = super::diagnostics::in_phase(
      &record,
      "revision_manifest",
      self
        .revision_manifests
        .prepare_move_revision_manifest(&record, &mappings),
    )
    .await?;
    if let Some(plans) = &revision_manifest.reference_plans {
      for plan in plans {
        plan
          .validate()
          .map_err(|error| super::diagnostics::WorkspaceContentExecutionError::at_phase(error, "revision_manifest"))?;
      }
    }
    for lineage in &revision_manifest.history_reference_lineage {
      lineage
        .plan
        .validate()
        .map_err(|error| super::diagnostics::WorkspaceContentExecutionError::at_phase(error, "revision_manifest"))?;
    }
    let organizer = super::diagnostics::in_phase(
      &record,
      "organizer_projection",
      self.project_organizer(&record, &mappings, &revision_manifest),
    )
    .await?;
    let recipient_intents = super::diagnostics::in_phase(
      &record,
      "recipient_snapshot",
      self.recipient_intents(&record, &mappings),
    )
    .await?;
    let extract_source_folder_id = if record.kind == WorkspaceContentOperationKind::ExtractFolder {
      Some(
        self
          .extract_context
          .as_ref()
          .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?
          .extract_source_folder_id(record.id)
          .await?,
      )
    } else {
      None
    };
    let staging_entries =
      super::diagnostics::in_phase(&record, "blob_staging", self.stage_extract_blobs(&record, &mappings)).await?;
    self
      .publisher
      .publish_move(
        WorkspaceContentMovePublicationBatch {
          operation: record,
          mappings,
          revision_manifest,
          organizer,
          recipient_intents,
          extract_source_folder_id,
          staging_entries,
        },
        &self.diagnostic_instance_id,
      )
      .await
  }
}
