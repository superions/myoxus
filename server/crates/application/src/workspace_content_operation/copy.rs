// SPDX-License-Identifier: AGPL-3.0-or-later
//! Operation-owned staging for cross-workspace Copy.
//!
//! This module reads canonical source documents and their referenced blobs,
//! rewrites mapped resource identities inside the Yjs payload, and writes
//! verified bytes below an opaque operation namespace. It never creates a
//! canonical target document, blob row, organizer row, or ACL.

use myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use myoxus_domain::workspace_content_operation::{
  WorkspaceContentIdMapping, WorkspaceContentOperationKind, WorkspaceContentOperationRecord,
  WorkspaceContentOperationStatus, WorkspaceContentResourceKind, WorkspaceContentResourceRef,
  WorkspaceContentStagingEntry,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};
use crate::doc::{DocService, DocSpaceKind};
use crate::document_metadata::DocumentMetadataService;
use crate::permission::{AccessController, DocResource, PermissionService, WorkspaceResource};
use crate::ports::blob_service::BlobService;
use crate::ports::{BlobStoragePort, BlobWriteRequest, PortError};
use crate::workspace_tags::WorkspaceTagService;

use super::publication::WorkspaceContentCopyPublicationService;
use super::reconcile::WorkspaceContentReconcileExecutor;
use super::worker::WorkspaceContentSemanticExecutor;
use super::{
  WorkspaceContentCompensationIntent, WorkspaceContentOperationRepository, WorkspaceContentRedirectRepository,
  WorkspaceContentStagingManifestRepository,
};

const STAGING_PREFIX: &str = "workspace-content";
const STAGING_DOCUMENT_CONTENT_TYPE: &str = "application/vnd.myoxus.workspace-content-document+json";
const COMPENSATION_DELETE_STAGED_OBJECT: &str = "delete_staged_object";

/// Canonical document state staged without history or derived projections.
#[derive(Debug, Clone)]
pub struct WorkspaceContentCopyDocument {
  pub title: String,
  pub yjs_update: Vec<u8>,
  pub metadata: Option<serde_json::Value>,
  pub tag_ids: Vec<Uuid>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceContentStagedDocument {
  pub(crate) schema_version: u32,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub(crate) reference_plan: Option<super::WorkspaceContentNativeReferencePlan>,
  pub(crate) source_hash: String,
  #[serde(default)]
  pub(crate) source_doc_id: Option<Uuid>,
  pub(crate) target_doc_id: Uuid,
  pub(crate) title: String,
  pub(crate) yjs_update_base64: String,
  pub(crate) metadata: Option<serde_json::Value>,
  pub(crate) tag_ids: Vec<Uuid>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceContentStagedBlob {
  pub(crate) schema_version: u32,
  pub(crate) source_hash: String,
  pub(crate) content_type: String,
  pub(crate) data_base64: String,
}

/// Canonical source bytes returned without exposing storage credentials.
#[derive(Debug, Clone)]
pub struct WorkspaceContentCopyBlob {
  pub data: Bytes,
  pub content_type: String,
}

/// Read/authorization boundary for Copy staging.
///
/// Production uses the canonical document, permission, and blob services.
/// Keeping this port explicit also makes it possible to prove that staging
/// performs no target-side product write.
#[async_trait]
pub trait WorkspaceContentCopySourcePort: Send + Sync {
  async fn authorize(
    &self,
    actor_id: Uuid,
    target_workspace_id: Uuid,
    mappings: &[WorkspaceContentIdMapping],
  ) -> AuthResult<()>;
  async fn load_document(
    &self,
    actor_id: Uuid,
    source: &WorkspaceContentResourceRef,
  ) -> AuthResult<WorkspaceContentCopyDocument>;
  async fn reference_exists(&self, resource: &WorkspaceContentResourceRef) -> AuthResult<bool>;
  async fn canonical_reference(
    &self,
    resource: &WorkspaceContentResourceRef,
  ) -> AuthResult<Option<WorkspaceContentResourceRef>> {
    Ok(self.reference_exists(resource).await?.then(|| resource.clone()))
  }
  async fn load_blob(&self, source: &WorkspaceContentResourceRef) -> AuthResult<WorkspaceContentCopyBlob>;
}

/// Narrow compensation boundary used by Copy staging.
#[async_trait]
pub trait WorkspaceContentCopyCompensationPort: Send + Sync {
  async fn append_copy_compensation(&self, intent: WorkspaceContentCompensationIntent) -> AuthResult<bool>;
}

#[async_trait]
impl<T> WorkspaceContentCopyCompensationPort for T
where
  T: WorkspaceContentOperationRepository + Send + Sync + ?Sized,
{
  async fn append_copy_compensation(&self, intent: WorkspaceContentCompensationIntent) -> AuthResult<bool> {
    WorkspaceContentOperationRepository::append_compensation(self, intent).await
  }
}

/// Production Copy source backed by existing application services.
pub struct WorkspaceContentCopySourceService {
  doc: DocService,
  blobs: Arc<BlobService>,
  permission: Arc<PermissionService>,
  metadata: DocumentMetadataService,
  tags: Option<Arc<WorkspaceTagService>>,
  reference_repository: Option<Arc<dyn WorkspaceContentRedirectRepository>>,
}

impl WorkspaceContentCopySourceService {
  pub fn new(
    doc: DocService,
    blobs: Arc<BlobService>,
    permission: Arc<PermissionService>,
    metadata: DocumentMetadataService,
  ) -> Self {
    Self {
      doc,
      blobs,
      permission,
      metadata,
      tags: None,
      reference_repository: None,
    }
  }

  pub fn with_reference_repository(mut self, repository: Arc<dyn WorkspaceContentRedirectRepository>) -> Self {
    self.reference_repository = Some(repository);
    self
  }

  pub fn with_workspace_tags(mut self, tags: Arc<WorkspaceTagService>) -> Self {
    self.tags = Some(tags);
    self
  }
}

#[async_trait]
impl WorkspaceContentCopySourcePort for WorkspaceContentCopySourceService {
  async fn authorize(
    &self,
    actor_id: Uuid,
    target_workspace_id: Uuid,
    mappings: &[WorkspaceContentIdMapping],
  ) -> AuthResult<()> {
    // Copy publishes document placement in the target workspace, so CreateDoc
    // is authoritative. Collection shortcuts are references, never definitions.
    let target = WorkspaceResource {
      user_id: actor_id,
      workspace_id: target_workspace_id,
    };
    if !self.permission.can(&target, WorkspaceAction::CreateDoc).await {
      return Err(AuthError::ActionForbidden);
    }
    // Organizer placement is owned by CreateDoc, not catalog mutation.
    for mapping in mappings
      .iter()
      .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Document)
    {
      let document_key = DocumentKey::parse(mapping.source.resource_id())
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))?;
      let Some(doc_id) = self
        .doc
        .resolve_document_key(mapping.source.workspace_id(), DocSpaceKind::Workspace, &document_key)
        .await?
      else {
        return Err(AuthError::NotFound(
          WorkspaceContentErrorCode::SourceDocumentMissing.as_str().to_string(),
        ));
      };
      if !self
        .permission
        .can(
          &DocResource {
            user_id: actor_id,
            workspace_id: mapping.source.workspace_id(),
            doc_id,
          },
          DocAction::Copy,
        )
        .await
      {
        return Err(AuthError::ActionForbidden);
      }
    }
    Ok(())
  }

  async fn load_document(
    &self,
    actor_id: Uuid,
    source: &WorkspaceContentResourceRef,
  ) -> AuthResult<WorkspaceContentCopyDocument> {
    if source.kind() != WorkspaceContentResourceKind::Document {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string(),
      ));
    }
    let document_key = DocumentKey::parse(source.resource_id())
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))?;
    let Some(doc_id) = self
      .doc
      .resolve_document_key(source.workspace_id(), DocSpaceKind::Workspace, &document_key)
      .await?
    else {
      return Err(AuthError::NotFound(
        WorkspaceContentErrorCode::SourceDocumentMissing.as_str().to_string(),
      ));
    };
    let source_doc = self
      .doc
      .get_doc_metadata(doc_id)
      .await?
      .filter(|metadata| metadata.workspace_id == Some(source.workspace_id()) && metadata.deleted_at.is_none())
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::SourceDocumentMissing.as_str().to_string()))?;
    debug_assert_eq!(source_doc.id, doc_id);
    let yjs_update = self.doc.load_full_doc_consistent(source.workspace_id(), doc_id).await?;
    let metadata = Some(
      serde_json::to_value(
        self
          .metadata
          .get_projection_uncached(doc_id, source.workspace_id())
          .await
          .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?,
      )
      .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::DocumentMetadataInvalid.as_str().to_string()))?,
    );
    let tag_ids = match &self.tags {
      Some(tags) => tags
        .document_tag_ids(actor_id, source.workspace_id(), doc_id)
        .await
        .map_err(super::diagnostics::tag_service_failure)?,
      None => Vec::new(),
    };
    Ok(WorkspaceContentCopyDocument {
      title: source_doc.title,
      yjs_update,
      metadata,
      tag_ids,
    })
  }

  async fn reference_exists(&self, resource: &WorkspaceContentResourceRef) -> AuthResult<bool> {
    let Ok(key) = DocumentKey::parse(resource.resource_id()) else {
      return Ok(false);
    };
    let Some(id) = self
      .doc
      .resolve_document_key(resource.workspace_id(), DocSpaceKind::Workspace, &key)
      .await?
    else {
      return Ok(false);
    };
    Ok(
      self
        .doc
        .get_doc_metadata(id)
        .await?
        .is_some_and(|doc| doc.workspace_id == Some(resource.workspace_id()) && doc.deleted_at.is_none()),
    )
  }

  async fn canonical_reference(
    &self,
    resource: &WorkspaceContentResourceRef,
  ) -> AuthResult<Option<WorkspaceContentResourceRef>> {
    if let Some(repository) = &self.reference_repository {
      repository.canonical_reference(resource).await
    } else {
      Ok(self.reference_exists(resource).await?.then(|| resource.clone()))
    }
  }

  async fn load_blob(&self, source: &WorkspaceContentResourceRef) -> AuthResult<WorkspaceContentCopyBlob> {
    if source.kind() != WorkspaceContentResourceKind::Blob {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string(),
      ));
    }
    let metadata = self
      .blobs
      .get_blob_metadata(source.workspace_id(), source.resource_id())
      .await?
      .filter(|metadata| metadata.deleted_at.is_none())
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::SourceBlobMissing.as_str().to_string()))?;
    let response = self.blobs.get_blob(source.workspace_id(), source.resource_id()).await?;
    if response.content_length != metadata.size || response.data.len() as u64 != metadata.size {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::BlobIntegrityMismatch.as_str().to_string(),
      ));
    }
    let hash = sha256_hex(&response.data);
    if metadata
      .checksum
      .as_deref()
      .is_some_and(|checksum| is_sha256(checksum) && !checksum.eq_ignore_ascii_case(&hash))
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::BlobIntegrityMismatch.as_str().to_string(),
      ));
    }
    Ok(WorkspaceContentCopyBlob {
      data: response.data,
      content_type: response.content_type.unwrap_or(metadata.mime),
    })
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentCopyStageResult {
  pub document_count: usize,
  pub blob_count: usize,
  pub staged_bytes: u64,
}

/// Idempotent Copy staging executor.
pub struct WorkspaceContentCopyExecutor {
  manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
  compensations: Arc<dyn WorkspaceContentCopyCompensationPort>,
  source: Arc<dyn WorkspaceContentCopySourcePort>,
  staging: Arc<dyn BlobStoragePort>,
  reconciler: Option<Arc<WorkspaceContentReconcileExecutor>>,
  publication: Option<(Arc<WorkspaceContentCopyPublicationService>, String)>,
}

impl WorkspaceContentCopyExecutor {
  pub fn new(
    manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
    compensations: Arc<dyn WorkspaceContentCopyCompensationPort>,
    source: Arc<dyn WorkspaceContentCopySourcePort>,
    staging: Arc<dyn BlobStoragePort>,
  ) -> Self {
    Self {
      manifests,
      compensations,
      source,
      staging,
      reconciler: None,
      publication: None,
    }
  }

  /// Attach the canonical metadata/Database reconciliation stage.
  pub fn with_reconciler(mut self, reconciler: Arc<WorkspaceContentReconcileExecutor>) -> Self {
    self.reconciler = Some(reconciler);
    self
  }

  /// Attach the singular canonical publication boundary.
  pub fn with_publication(
    mut self,
    publication: Arc<WorkspaceContentCopyPublicationService>,
    diagnostic_instance_id: impl Into<String>,
  ) -> Self {
    self.publication = Some((publication, diagnostic_instance_id.into()));
    self
  }

  /// Stage every mapped document and referenced blob without touching the
  /// target workspace's canonical product tables.
  pub async fn stage(&self, record: &WorkspaceContentOperationRecord) -> AuthResult<WorkspaceContentCopyStageResult> {
    self
      .stage_with_diagnostics(record)
      .await
      .map_err(|error| error.into_source())
  }

  async fn stage_with_diagnostics(
    &self,
    record: &WorkspaceContentOperationRecord,
  ) -> super::diagnostics::WorkspaceContentExecutionResult<WorkspaceContentCopyStageResult> {
    if record.kind != WorkspaceContentOperationKind::Copy || record.status != WorkspaceContentOperationStatus::Running {
      return Err(
        AuthError::InvalidInput(WorkspaceContentErrorCode::PublicationStateInvalid.as_str().to_string()).into(),
      );
    }
    let target_workspace_id = record
      .target_workspace_id
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().to_string()))?;
    let mut mappings = self.manifests.list_mappings(record.id).await?;
    super::reject_collection_mappings(&mappings)?;
    mappings.sort_by(|left, right| left.source.cmp(&right.source));
    if mappings.is_empty()
      || mappings.iter().any(|mapping| {
        mapping.source.workspace_id() != record.source_workspace_id
          || mapping.target.workspace_id() != target_workspace_id
      })
    {
      return Err(AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()).into());
    }
    super::preflight::validate_private_materialization_mappings(
      record.id,
      record.kind,
      target_workspace_id,
      &mappings,
    )?;
    // Eligibility is the admitted definition/ownership set, not the number of document payloads.
    if !mappings.iter().any(|mapping| {
      matches!(
        mapping.source.kind(),
        WorkspaceContentResourceKind::Document
          | WorkspaceContentResourceKind::Database
          | WorkspaceContentResourceKind::Folder
          | WorkspaceContentResourceKind::Tag
      )
    }) {
      return Err(
        AuthError::InvalidInput(WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str().into()).into(),
      );
    }
    self
      .source
      .authorize(record.actor_id, target_workspace_id, &mappings)
      .await?;

    let existing_entries = self.manifests.list_staging_entries(record.id).await?;
    let existing_by_resource = existing_entries
      .iter()
      .map(|entry| (&entry.resource, entry))
      .collect::<BTreeMap<_, _>>();
    for entry in &existing_entries {
      if entry.resource.kind() == WorkspaceContentResourceKind::Document {
        let existing = match self.staging.read_blob(entry.object_key()).await {
          Ok(existing) => existing,
          Err(PortError::NotFound(_)) => continue,
          Err(error) => return Err(port_storage(error).into()),
        };
        if let Err(error) = verify_staged_bytes(&existing.data, entry.content_hash(), entry.size_bytes as usize) {
          if entry
            .object_key()
            .starts_with(&format!("{STAGING_PREFIX}/{}/", record.id))
          {
            self
              .staging
              .delete_blob(entry.object_key())
              .await
              .map_err(port_storage)?;
          }
          return Err(error.into());
        }
        let staged: WorkspaceContentStagedDocument = serde_json::from_slice(&existing.data)
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().into()))?;
        if staged.schema_version != 3 {
          return Err(
            AuthError::InvalidInput(
              WorkspaceContentErrorCode::NativeReferenceVersionUnsupported
                .as_str()
                .into(),
            )
            .into(),
          );
        }
        if staged.reference_plan.is_none() {
          return Err(
            AuthError::InvalidInput(WorkspaceContentErrorCode::NativeReferencePlanMissing.as_str().into()).into(),
          );
        }
      }
    }
    let mut staged = Vec::new();
    let mut newly_written_keys = BTreeSet::new();
    let mut document_count = 0;
    let mut blob_count = 0;
    let mut staged_bytes = 0_u64;

    for mapping in mappings
      .iter()
      .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Document)
    {
      let source = match super::diagnostics::in_phase(
        record,
        "source_read",
        self.source.load_document(record.actor_id, &mapping.source),
      )
      .await
      {
        Ok(source) => source,
        Err(error) => {
          self.cleanup_staged(record, &newly_written_keys).await;
          return Err(error.into());
        }
      };
      let source_hash = copy_document_source_hash(&source)?;
      let reference_plan = super::diagnostics::in_phase(
        record,
        "typed_plan",
        prepare_native_reference_plan(self.source.as_ref(), &mapping.source, &source.yjs_update, &mappings),
      )
      .await?;
      let rewritten = apply_native_reference_plan(
        &source.yjs_update,
        &reference_plan,
        copy_rewrite_client_id(record.id, &mapping.target),
      )?;
      let target_doc_id = Uuid::new_v5(
        &record.id,
        format!(
          "document:{}:{}",
          mapping.target.workspace_id(),
          mapping.target.resource_id()
        )
        .as_bytes(),
      );
      let source_doc_id = source
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("doc_id"))
        .and_then(serde_json::Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok());
      let mut metadata = source.metadata;
      if let Some(metadata) = metadata.as_mut()
        && let Some(object) = metadata.as_object_mut()
      {
        object.insert(
          "doc_id".to_string(),
          serde_json::Value::String(target_doc_id.to_string()),
        );
        object.insert(
          "workspace_id".to_string(),
          serde_json::Value::String(mapping.target.workspace_id().to_string()),
        );
      }
      let staged_document = WorkspaceContentStagedDocument {
        schema_version: 3,
        reference_plan: Some(reference_plan),
        source_hash,
        source_doc_id,
        target_doc_id,
        title: source.title,
        yjs_update_base64: STANDARD.encode(rewritten.full_state),
        metadata,
        tag_ids: source.tag_ids,
      };
      let staged_document = serde_json::to_vec(&staged_document)
        .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().to_string()))?;
      let (entry, newly_written) = match super::diagnostics::in_phase(
        record,
        "blob_materialization",
        self.stage_bytes(
          record.id,
          i32::try_from(staged.len()).map_err(|_| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string())
          })?,
          mapping.target.clone(),
          existing_by_resource.get(&mapping.target).copied(),
          Bytes::from(staged_document),
          Some(STAGING_DOCUMENT_CONTENT_TYPE.to_string()),
        ),
      )
      .await
      {
        Ok(entry) => entry,
        Err(error) => {
          self.cleanup_staged(record, &newly_written_keys).await;
          return Err(error.into());
        }
      };
      if newly_written {
        newly_written_keys.insert(entry.object_key().to_string());
      }
      staged_bytes = staged_bytes
        .checked_add(entry.size_bytes as u64)
        .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::BlobSizeLimit.as_str().to_string()))?;
      document_count += 1;
      staged.push(entry);
    }

    for mapping in mappings
      .iter()
      .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Blob)
    {
      let blob = match super::diagnostics::in_phase(record, "source_read", self.source.load_blob(&mapping.source)).await
      {
        Ok(blob) => blob,
        Err(error) => {
          self.cleanup_staged(record, &newly_written_keys).await;
          return Err(error.into());
        }
      };
      let source_hash = copy_blob_source_hash(&blob);
      let staged_blob = WorkspaceContentStagedBlob {
        schema_version: 2,
        source_hash,
        content_type: blob.content_type,
        data_base64: STANDARD.encode(blob.data),
      };
      let staged_blob = serde_json::to_vec(&staged_blob)
        .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))?;
      let (entry, newly_written) = match super::diagnostics::in_phase(
        record,
        "blob_materialization",
        self.stage_bytes(
          record.id,
          i32::try_from(staged.len()).map_err(|_| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string())
          })?,
          mapping.target.clone(),
          existing_by_resource.get(&mapping.target).copied(),
          Bytes::from(staged_blob),
          Some("application/vnd.myoxus.workspace-content-blob+json".to_string()),
        ),
      )
      .await
      {
        Ok(entry) => entry,
        Err(error) => {
          self.cleanup_staged(record, &newly_written_keys).await;
          return Err(error.into());
        }
      };
      if newly_written {
        newly_written_keys.insert(entry.object_key().to_string());
      }
      staged_bytes = staged_bytes
        .checked_add(entry.size_bytes as u64)
        .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::BlobSizeLimit.as_str().to_string()))?;
      blob_count += 1;
      staged.push(entry);
    }

    let existing = self.manifests.list_staging_entries(record.id).await?;
    let combined = merge_staging_entries(&staged, &existing)?;
    if let Err(error) = self
      .manifests
      .store_manifest(record.id, &record.manifest_hash, &mappings, &combined)
      .await
    {
      self.cleanup_staged(record, &newly_written_keys).await;
      return Err(error.into());
    }
    Ok(WorkspaceContentCopyStageResult {
      document_count,
      blob_count,
      staged_bytes,
    })
  }

  #[tracing::instrument(skip_all, fields(operation_id = %operation_id, phase = "blob_materialization"))]
  async fn stage_bytes(
    &self,
    operation_id: Uuid,
    sequence: i32,
    resource: WorkspaceContentResourceRef,
    prior: Option<&WorkspaceContentStagingEntry>,
    body: Bytes,
    content_type: Option<String>,
  ) -> AuthResult<(WorkspaceContentStagingEntry, bool)> {
    self
      .compensations
      .append_copy_compensation(WorkspaceContentCompensationIntent {
        operation_id,
        sequence: i64::from(sequence),
        kind: COMPENSATION_DELETE_STAGED_OBJECT.into(),
        target: resource.clone(),
      })
      .await?;
    let hash = sha256_hex(&body);
    let size_bytes = i64::try_from(body.len())
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().into()))?;
    // Different resources can have identical bytes. The manifest sequence
    // owns their separate rows; retain an already durable key on replay.
    let object_key = prior
      .filter(|entry| {
        entry.sequence == sequence
          && entry.resource == resource
          && entry.content_hash().eq_ignore_ascii_case(&hash)
          && entry.size_bytes == size_bytes
      })
      .map(|entry| entry.object_key().to_string())
      .unwrap_or_else(|| format!("{STAGING_PREFIX}/{operation_id}/objects/{sequence}/{hash}"));
    let newly_written = match self.staging.read_blob(&object_key).await {
      Ok(existing) => {
        if let Err(error) = verify_staged_bytes(&existing.data, &hash, body.len()) {
          // The key belongs exclusively to this operation and expected digest.
          // Removing corrupt residue lets a later durable replay recover.
          if let Err(cleanup_error) = self.staging.delete_blob(&object_key).await {
            super::diagnostics::record_port_failure(&cleanup_error, "compensation");
          }
          return Err(error);
        }
        false
      }
      Err(PortError::NotFound(_)) => {
        if let Err(error) = self
          .staging
          .write_blob(BlobWriteRequest {
            key: object_key.clone(),
            content_type,
            body: body.clone(),
          })
          .await
        {
          // Some backends can expose a partial object after an interrupted
          // write. The deterministic operation key makes immediate cleanup
          // safe; log cleanup separately without replacing the write failure.
          if let Err(cleanup_error) = self.staging.delete_blob(&object_key).await {
            super::diagnostics::record_port_failure(&cleanup_error, "compensation");
          }
          return Err(port_storage(error));
        }
        let stored = match self.staging.read_blob(&object_key).await {
          Ok(stored) => stored,
          Err(error) => {
            if let Err(cleanup_error) = self.staging.delete_blob(&object_key).await {
              super::diagnostics::record_port_failure(&cleanup_error, "compensation");
            }
            return Err(port_storage(error));
          }
        };
        if let Err(error) = verify_staged_bytes(&stored.data, &hash, body.len()) {
          if let Err(cleanup_error) = self.staging.delete_blob(&object_key).await {
            super::diagnostics::record_port_failure(&cleanup_error, "compensation");
          }
          return Err(error);
        }
        true
      }
      Err(error) => return Err(port_storage(error)),
    };
    let entry = WorkspaceContentStagingEntry::new(operation_id, sequence, resource, object_key, hash, size_bytes)
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))?;
    Ok((entry, newly_written))
  }

  async fn cleanup_staged(&self, record: &WorkspaceContentOperationRecord, keys: &BTreeSet<String>) {
    for key in keys {
      // Cleanup is secondary. Never replace the originating typed failure or
      // misclassify a failed deletion as materialization of a new object.
      let _ = super::diagnostics::in_phase(record, "compensation", async {
        self.staging.delete_blob(key).await.map_err(|error| {
          super::diagnostics::record_port_failure(&error, "compensation");
          AuthError::Storage(WorkspaceContentErrorCode::BlobCompensationFailed.as_str().into())
        })
      })
      .await;
    }
  }
}

#[async_trait]
impl WorkspaceContentSemanticExecutor for WorkspaceContentCopyExecutor {
  async fn execute(
    &self,
    record: WorkspaceContentOperationRecord,
  ) -> super::diagnostics::WorkspaceContentExecutionResult<WorkspaceContentOperationRecord> {
    self.stage_with_diagnostics(&record).await?;
    if let Some(reconciler) = &self.reconciler {
      super::diagnostics::in_phase(&record, "catalog_reconciliation", reconciler.reconcile(&record)).await?;
    }
    let (publication, diagnostic_instance_id) = self
      .publication
      .as_ref()
      .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?;
    publication
      .publish_with_diagnostics(&record, diagnostic_instance_id)
      .await
  }
}

/// Resolve typed occurrences only. Valid outgoing addresses remain source-
/// qualified; neither opaque literals nor native/editor identities are keys.
/// Existence is an internal canonical check, not permission to disclose metadata.
pub(crate) async fn prepare_native_reference_plan(
  source_port: &dyn WorkspaceContentCopySourcePort,
  source: &WorkspaceContentResourceRef,
  snapshot: &[u8],
  mappings: &[WorkspaceContentIdMapping],
) -> AuthResult<super::WorkspaceContentNativeReferencePlan> {
  prepare_native_reference_plan_with_resolver(source, snapshot, mappings, false, |resource| async move {
    source_port.canonical_reference(&resource).await
  })
  .await
}

/// Shared typed planner; the owning repository supplies canonical existence
/// without turning failed reads or denied metadata into an absent target.
pub async fn prepare_native_reference_plan_with_resolver<F, Fut>(
  source: &WorkspaceContentResourceRef,
  snapshot: &[u8],
  mappings: &[WorkspaceContentIdMapping],
  immutable_history: bool,
  mut resolve: F,
) -> AuthResult<super::WorkspaceContentNativeReferencePlan>
where
  F: FnMut(WorkspaceContentResourceRef) -> Fut,
  Fut: std::future::Future<Output = AuthResult<Option<WorkspaceContentResourceRef>>>,
{
  use super::{WorkspaceContentReferenceDecision as Decision, WorkspaceContentReferenceOccurrence};
  let documents = yjs::extract_document_references_from_yjs(snapshot)
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().into()))?;
  let assets = yjs::extract_portable_asset_references(snapshot)
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().into()))?;
  let mut occurrences = Vec::new();
  let raw = documents
    .occurrences
    .into_iter()
    .map(|item| {
      (
        WorkspaceContentResourceKind::Document,
        item.raw_target_doc_id,
        item.target_workspace_id,
        item.position,
      )
    })
    .chain(assets.into_iter().map(|item| {
      (
        WorkspaceContentResourceKind::Blob,
        item.raw_source_key,
        item.workspace_id,
        item.position,
      )
    }));
  let mut resolved: BTreeMap<WorkspaceContentResourceRef, Option<WorkspaceContentResourceRef>> = BTreeMap::new();
  for (kind, id, scope, position) in raw {
    let workspace_id = scope
      .as_deref()
      .map(Uuid::parse_str)
      .transpose()
      .ok()
      .map(|scope| scope.unwrap_or(source.workspace_id()));
    let canonical_id = if kind == WorkspaceContentResourceKind::Blob {
      id.trim().trim_start_matches('/')
    } else {
      id.as_str()
    };
    let resource =
      workspace_id.and_then(|workspace| WorkspaceContentResourceRef::new(workspace, kind, canonical_id).ok());
    let decision = match resource.as_ref() {
      Some(resource) => match mappings.iter().find(|mapping| &mapping.source == resource) {
        Some(mapping) => Decision::Remap {
          target: mapping.target.clone(),
        },
        None if kind == WorkspaceContentResourceKind::Blob => Decision::Keep {
          target: resource.clone(),
        },
        None => {
          let target = match resolved.get(resource) {
            Some(target) => target.clone(),
            None => {
              let target = resolve(resource.clone()).await?;
              resolved.insert(resource.clone(), target.clone());
              target
            }
          };
          match target {
            Some(target) => match mappings.iter().find(|mapping| mapping.source == target) {
              Some(mapping) => Decision::Remap {
                target: mapping.target.clone(),
              },
              None => Decision::Keep { target },
            },
            None => Decision::Omit,
          }
        }
      },
      None if kind == WorkspaceContentResourceKind::Document || immutable_history => Decision::Omit,
      None => {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::OwnedBlobMappingMissing.as_str().into(),
        ));
      }
    };
    occurrences.push(WorkspaceContentReferenceOccurrence {
      position,
      expected_id: id,
      expected_workspace_id: scope,
      resource,
      decision,
    });
  }
  let plan = super::WorkspaceContentNativeReferencePlan {
    version: super::NATIVE_REFERENCE_PLAN_VERSION,
    source: source.clone(),
    snapshot_sha256: sha256_hex(snapshot),
    occurrences,
  };
  plan.validate()?;
  Ok(plan)
}

/// Canonical addresses requiring an existence proof. Invalid native values
/// remain in the occurrence inventory so the typed writer can omit them.
pub fn native_document_reference_targets(
  source: &WorkspaceContentResourceRef,
  snapshot: &[u8],
) -> AuthResult<Vec<WorkspaceContentResourceRef>> {
  let inventory = yjs::extract_document_references_from_yjs(snapshot)
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().into()))?;
  let mut targets = BTreeSet::new();
  for occurrence in inventory.occurrences {
    let scope = occurrence
      .target_workspace_id
      .as_deref()
      .map(Uuid::parse_str)
      .transpose();
    if let Ok(scope) = scope
      && let Ok(target) = WorkspaceContentResourceRef::new(
        scope.unwrap_or(source.workspace_id()),
        WorkspaceContentResourceKind::Document,
        occurrence.raw_target_doc_id,
      )
    {
      targets.insert(target);
    }
  }
  Ok(targets.into_iter().collect())
}

pub fn apply_native_reference_plan(
  snapshot: &[u8],
  plan: &super::WorkspaceContentNativeReferencePlan,
  client_id: u64,
) -> AuthResult<yjs::NativeReferenceRewriteResult> {
  plan.validate()?;
  if sha256_hex(snapshot) != plan.snapshot_sha256 {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::NativeReferenceSnapshotChanged
        .as_str()
        .into(),
    ));
  }
  if plan.occurrences.is_empty() {
    return Ok(yjs::NativeReferenceRewriteResult {
      full_state: snapshot.to_vec(),
      incremental_update: Vec::new(),
    });
  }
  let rewrites = plan
    .occurrences
    .iter()
    .map(|item| yjs::NativeReferenceRewrite {
      position: item.position.clone(),
      expected_id: item.expected_id.clone(),
      expected_workspace_id: item.expected_workspace_id.clone(),
      replacement: match &item.decision {
        super::WorkspaceContentReferenceDecision::Keep { target }
        | super::WorkspaceContentReferenceDecision::Remap { target } => Some(yjs::NativeReferenceReplacement {
          id: target.resource_id().into(),
          workspace_id: Some(target.workspace_id().to_string()),
        }),
        super::WorkspaceContentReferenceDecision::Unavailable => Some(yjs::NativeReferenceReplacement {
          id: item.expected_id.clone(),
          // The existing explicit-invalid qualification guard makes this
          // unavailable; absence would silently choose the current workspace.
          workspace_id: Some(String::new()),
        }),
        super::WorkspaceContentReferenceDecision::Omit => None,
      },
    })
    .collect::<Vec<_>>();
  yjs::rewrite_native_references(snapshot, &rewrites, client_id)
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().into()))
}

fn merge_staging_entries(
  current: &[WorkspaceContentStagingEntry],
  existing: &[WorkspaceContentStagingEntry],
) -> AuthResult<Vec<WorkspaceContentStagingEntry>> {
  let current_by_resource = current
    .iter()
    .map(|entry| (entry.resource.clone(), entry))
    .collect::<BTreeMap<_, _>>();
  for entry in existing {
    if let Some(expected) = current_by_resource.get(&entry.resource)
      && *expected != entry
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::StagingReplayConflict.as_str().to_string(),
      ));
    }
  }
  let mut combined = current.to_vec();
  combined.extend(
    existing
      .iter()
      .filter(|entry| !current_by_resource.contains_key(&entry.resource))
      .cloned(),
  );
  combined.sort_by_key(|entry| entry.sequence);
  if combined
    .windows(2)
    .any(|window| window[0].sequence == window[1].sequence)
  {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string(),
    ));
  }
  Ok(combined)
}

fn verify_staged_bytes(data: &[u8], expected_hash: &str, expected_size: usize) -> AuthResult<()> {
  crate::ports::blob_service::verify_operation_blob_bytes(data, expected_hash, expected_size as u64)
}

fn sha256_hex(data: &[u8]) -> String {
  hex::encode(Sha256::digest(data))
}

pub(crate) fn copy_document_source_hash(document: &WorkspaceContentCopyDocument) -> AuthResult<String> {
  let metadata = serde_json::to_vec(&document.metadata)
    .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::DocumentMetadataInvalid.as_str().to_string()))?;
  let mut tag_ids = document.tag_ids.clone();
  tag_ids.sort_unstable();
  let mut digest = Sha256::new();
  hash_part(&mut digest, document.title.as_bytes());
  hash_part(&mut digest, &document.yjs_update);
  hash_part(&mut digest, &metadata);
  for tag_id in tag_ids {
    hash_part(&mut digest, tag_id.as_bytes());
  }
  Ok(hex::encode(digest.finalize()))
}

pub(crate) fn copy_blob_source_hash(blob: &WorkspaceContentCopyBlob) -> String {
  let mut digest = Sha256::new();
  hash_part(&mut digest, blob.content_type.as_bytes());
  hash_part(&mut digest, &blob.data);
  hex::encode(digest.finalize())
}

fn hash_part(digest: &mut Sha256, value: &[u8]) {
  digest.update((value.len() as u64).to_be_bytes());
  digest.update(value);
}

pub fn copy_rewrite_client_id(operation_id: Uuid, target: &WorkspaceContentResourceRef) -> u64 {
  let mut digest = Sha256::new();
  digest.update(operation_id.as_bytes());
  digest.update(target.workspace_id().as_bytes());
  digest.update(target.kind().as_str().as_bytes());
  digest.update(target.resource_id().as_bytes());
  let digest = digest.finalize();
  let candidate = u64::from_be_bytes(digest[..8].try_into().expect("SHA-256 prefix")) & ((1_u64 << 53) - 1);
  candidate.max(1)
}

fn is_sha256(value: &str) -> bool {
  value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn port_storage(error: PortError) -> AuthError {
  super::diagnostics::record_port_failure(&error, "blob_materialization");
  match error {
    PortError::InvalidInput(_) => {
      AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().into())
    }
    PortError::NotFound(_) => AuthError::NotFound(WorkspaceContentErrorCode::BlobStagingEntryMissing.as_str().into()),
    PortError::Conflict(_) => AuthError::InvalidInput(WorkspaceContentErrorCode::StagingReplayConflict.as_str().into()),
    PortError::Transport(_) => AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().into()),
  }
}

#[cfg(test)]
mod tests {
  use std::sync::Mutex;
  use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

  use chrono::Utc;

  use super::*;
  use crate::ports::{
    BlobPathWriteRequest, BlobReadResponse, MultipartCompleteRequest, MultipartCreateRequest, MultipartCreateResponse,
    MultipartPartUrlRequest, MultipartPartUrlResponse,
  };

  #[derive(Default)]
  struct ManifestRepository {
    mappings: Mutex<Vec<WorkspaceContentIdMapping>>,
    entries: Mutex<Vec<WorkspaceContentStagingEntry>>,
  }

  #[async_trait]
  impl WorkspaceContentStagingManifestRepository for ManifestRepository {
    async fn store_manifest(
      &self,
      _operation_id: Uuid,
      _manifest_hash: &str,
      mappings: &[WorkspaceContentIdMapping],
      entries: &[WorkspaceContentStagingEntry],
    ) -> AuthResult<()> {
      {
        let stored = self.mappings.lock().unwrap();
        if !stored.is_empty() && stored.as_slice() != mappings {
          return Err(AuthError::InvalidInput("mapping replay changed".to_string()));
        }
      }
      *self.mappings.lock().unwrap() = mappings.to_vec();
      *self.entries.lock().unwrap() = entries.to_vec();
      Ok(())
    }

    async fn list_mappings(&self, _operation_id: Uuid) -> AuthResult<Vec<WorkspaceContentIdMapping>> {
      Ok(self.mappings.lock().unwrap().clone())
    }

    async fn list_staging_entries(&self, _operation_id: Uuid) -> AuthResult<Vec<WorkspaceContentStagingEntry>> {
      Ok(self.entries.lock().unwrap().clone())
    }
  }

  #[derive(Default)]
  struct CompensationRepository {
    intents: Mutex<Vec<WorkspaceContentCompensationIntent>>,
  }

  #[async_trait]
  impl WorkspaceContentCopyCompensationPort for CompensationRepository {
    async fn append_copy_compensation(&self, intent: WorkspaceContentCompensationIntent) -> AuthResult<bool> {
      let mut intents = self.intents.lock().unwrap();
      if intents.contains(&intent) {
        return Ok(false);
      }
      if intents.iter().any(|existing| existing.sequence == intent.sequence) {
        return Err(AuthError::InvalidInput("compensation conflict".to_string()));
      }
      intents.push(intent);
      Ok(true)
    }
  }

  #[derive(Default)]
  struct Source {
    documents: Mutex<BTreeMap<WorkspaceContentResourceRef, Vec<u8>>>,
    blobs: Mutex<BTreeMap<WorkspaceContentResourceRef, WorkspaceContentCopyBlob>>,
    authorizations: AtomicUsize,
  }

  #[async_trait]
  impl WorkspaceContentCopySourcePort for Source {
    async fn authorize(
      &self,
      _actor_id: Uuid,
      _target_workspace_id: Uuid,
      _mappings: &[WorkspaceContentIdMapping],
    ) -> AuthResult<()> {
      self.authorizations.fetch_add(1, Ordering::SeqCst);
      Ok(())
    }

    async fn load_document(
      &self,
      _actor_id: Uuid,
      source: &WorkspaceContentResourceRef,
    ) -> AuthResult<WorkspaceContentCopyDocument> {
      self
        .documents
        .lock()
        .unwrap()
        .get(source)
        .cloned()
        .map(|yjs_update| WorkspaceContentCopyDocument {
          title: "Copied document".to_string(),
          yjs_update,
          metadata: Some(serde_json::json!({
            "doc_id": source.resource_id(),
            "workspace_id": source.workspace_id(),
            "fields": [{"key": "language", "value": "de"}]
          })),
          tag_ids: Vec::new(),
        })
        .ok_or_else(|| AuthError::NotFound("document".to_string()))
    }

    async fn reference_exists(&self, resource: &WorkspaceContentResourceRef) -> AuthResult<bool> {
      Ok(self.documents.lock().unwrap().contains_key(resource))
    }

    async fn load_blob(&self, source: &WorkspaceContentResourceRef) -> AuthResult<WorkspaceContentCopyBlob> {
      self
        .blobs
        .lock()
        .unwrap()
        .get(source)
        .cloned()
        .ok_or_else(|| AuthError::NotFound("blob".to_string()))
    }
  }

  #[derive(Default)]
  struct Storage {
    objects: Mutex<BTreeMap<String, (Bytes, Option<String>)>>,
    writes: AtomicUsize,
    corrupt_writes: AtomicBool,
    interrupt_writes: AtomicBool,
  }

  #[async_trait]
  impl BlobStoragePort for Storage {
    async fn write_blob(&self, req: BlobWriteRequest) -> crate::ports::PortResult<()> {
      self.writes.fetch_add(1, Ordering::SeqCst);
      let body = if self.corrupt_writes.load(Ordering::SeqCst) {
        Bytes::from_static(b"corrupt")
      } else {
        req.body
      };
      self.objects.lock().unwrap().insert(req.key, (body, req.content_type));
      if self.interrupt_writes.load(Ordering::SeqCst) {
        return Err(PortError::Transport("interrupted write".to_string()));
      }
      Ok(())
    }

    async fn write_blob_from_path(&self, _req: BlobPathWriteRequest) -> crate::ports::PortResult<()> {
      unreachable!()
    }

    async fn read_blob(&self, key: &str) -> crate::ports::PortResult<BlobReadResponse> {
      self
        .objects
        .lock()
        .unwrap()
        .get(key)
        .cloned()
        .map(|(data, content_type)| BlobReadResponse {
          key: key.to_string(),
          content_type,
          content_length: data.len() as u64,
          data,
          last_modified: None,
        })
        .ok_or_else(|| PortError::NotFound("object".to_string()))
    }

    async fn delete_blob(&self, key: &str) -> crate::ports::PortResult<()> {
      self.objects.lock().unwrap().remove(key);
      Ok(())
    }

    async fn put_avatar(&self, _key: &str, _data: Bytes, _content_type: &str) -> crate::ports::PortResult<String> {
      unreachable!()
    }

    async fn get_avatar(&self, _key: &str) -> crate::ports::PortResult<BlobReadResponse> {
      unreachable!()
    }

    async fn delete_avatar(&self, _key: &str) -> crate::ports::PortResult<()> {
      unreachable!()
    }

    async fn create_multipart_upload(
      &self,
      _req: MultipartCreateRequest,
    ) -> crate::ports::PortResult<MultipartCreateResponse> {
      unreachable!()
    }

    async fn create_multipart_part_url(
      &self,
      _req: MultipartPartUrlRequest,
    ) -> crate::ports::PortResult<MultipartPartUrlResponse> {
      unreachable!()
    }

    async fn complete_multipart_upload(&self, _req: MultipartCompleteRequest) -> crate::ports::PortResult<()> {
      unreachable!()
    }

    async fn abort_multipart_upload(&self, _upload_id: Uuid) -> crate::ports::PortResult<()> {
      unreachable!()
    }
  }

  fn resource(
    workspace_id: Uuid,
    kind: WorkspaceContentResourceKind,
    resource_id: &str,
  ) -> WorkspaceContentResourceRef {
    WorkspaceContentResourceRef::new(workspace_id, kind, resource_id).unwrap()
  }

  fn fixture() -> (
    WorkspaceContentOperationRecord,
    Arc<ManifestRepository>,
    Arc<CompensationRepository>,
    Arc<Source>,
    Arc<Storage>,
    WorkspaceContentResourceRef,
  ) {
    let operation_id = Uuid::new_v4();
    let source_workspace_id = Uuid::new_v4();
    let target_workspace_id = Uuid::new_v4();
    let source_document = resource(source_workspace_id, WorkspaceContentResourceKind::Document, "asset.png");
    let target_document = resource(
      target_workspace_id,
      WorkspaceContentResourceKind::Document,
      &super::super::preflight::operation_private_resource_key(operation_id, target_workspace_id, &source_document, 1),
    );
    let source_blob = resource(source_workspace_id, WorkspaceContentResourceKind::Blob, "asset.png");
    let target_blob = resource(
      target_workspace_id,
      WorkspaceContentResourceKind::Blob,
      &super::super::preflight::operation_private_resource_key(operation_id, target_workspace_id, &source_blob, 1),
    );
    let mappings = vec![
      WorkspaceContentIdMapping::new(source_document.clone(), target_document).unwrap(),
      WorkspaceContentIdMapping::new(source_blob.clone(), target_blob.clone()).unwrap(),
    ];
    let manifests = Arc::new(ManifestRepository {
      mappings: Mutex::new(mappings),
      entries: Mutex::new(Vec::new()),
    });
    let source = Arc::new(Source::default());
    use yrs::{Map, ReadTxn, Transact};
    let native = yrs::Doc::new();
    let blocks = native.get_or_insert_map("blocks");
    let snapshot = {
      let mut tx = native.transact_mut();
      tx.apply_update(
        yrs::updates::decoder::Decode::decode_v1(
          &crate::markdown::markdown_to_yjs("Source", "![Diagram](asset.png)").unwrap(),
        )
        .unwrap(),
      )
      .unwrap();
      let reference = blocks.insert(&mut tx, "asset.png", yrs::MapPrelim::default());
      reference.insert(&mut tx, "sys:id", "asset.png");
      reference.insert(&mut tx, "sys:flavour", "myoxus:embed-linked-doc");
      reference.insert(&mut tx, "prop:pageId", "asset.png");
      reference.insert(&mut tx, "prop:caption", "asset.png");
      tx.encode_state_as_update_v1(&yrs::StateVector::default())
    };
    source.documents.lock().unwrap().insert(source_document, snapshot);
    source.blobs.lock().unwrap().insert(
      source_blob,
      WorkspaceContentCopyBlob {
        data: Bytes::from_static(b"verified-image"),
        content_type: "image/png".to_string(),
      },
    );
    let now = Utc::now();
    (
      WorkspaceContentOperationRecord {
        id: operation_id,
        idempotency_id: Uuid::new_v4(),
        actor_id: Uuid::new_v4(),
        kind: WorkspaceContentOperationKind::Copy,
        source_workspace_id,
        target_workspace_id: Some(target_workspace_id),
        status: WorkspaceContentOperationStatus::Running,
        preview_revision: Some("revision".to_string()),
        manifest_hash: "a".repeat(64),
        error: None,
        diagnostic_instance_id: Some("copy-worker".to_string()),
        created_at: now,
        updated_at: now,
      },
      manifests,
      Arc::new(CompensationRepository::default()),
      source,
      Arc::new(Storage::default()),
      target_blob,
    )
  }

  #[tokio::test]
  async fn copy_stages_rewritten_documents_and_blobs_idempotently() {
    let (record, manifests, compensations, source, storage, target_blob) = fixture();
    let second_blob = resource(
      record.source_workspace_id,
      WorkspaceContentResourceKind::Blob,
      "same-bytes.png",
    );
    let second_target = resource(
      record.target_workspace_id.unwrap(),
      WorkspaceContentResourceKind::Blob,
      &super::super::preflight::operation_private_resource_key(
        record.id,
        record.target_workspace_id.unwrap(),
        &second_blob,
        1,
      ),
    );
    let bytes = source.blobs.lock().unwrap().values().next().unwrap().clone();
    source.blobs.lock().unwrap().insert(second_blob.clone(), bytes);
    manifests
      .mappings
      .lock()
      .unwrap()
      .push(WorkspaceContentIdMapping::new(second_blob, second_target).unwrap());
    let first_executor = WorkspaceContentCopyExecutor::new(
      manifests.clone(),
      compensations.clone(),
      source.clone(),
      storage.clone(),
    );

    let first = first_executor.stage(&record).await.unwrap();
    let second_node_executor = WorkspaceContentCopyExecutor::new(
      manifests.clone(),
      compensations.clone(),
      source.clone(),
      storage.clone(),
    );
    let replay = second_node_executor.stage(&record).await.unwrap();

    assert_eq!(first, replay);
    assert_eq!(first.document_count, 1);
    assert_eq!(first.blob_count, 2);
    assert_eq!(storage.writes.load(Ordering::SeqCst), 3);
    assert_eq!(source.authorizations.load(Ordering::SeqCst), 2);
    assert_eq!(compensations.intents.lock().unwrap().len(), 3);
    let entries = manifests.entries.lock().unwrap().clone();
    assert_eq!(entries.len(), 3);
    let blobs = entries
      .iter()
      .filter(|entry| entry.resource.kind() == WorkspaceContentResourceKind::Blob)
      .collect::<Vec<_>>();
    assert_eq!(blobs[0].content_hash(), blobs[1].content_hash());
    assert_ne!(
      blobs[0].object_key(),
      blobs[1].object_key(),
      "equal bytes retain separate staging identities"
    );
    let document = entries
      .iter()
      .find(|entry| entry.resource.kind() == WorkspaceContentResourceKind::Document)
      .unwrap();
    let staged_document = storage.read_blob(document.object_key()).await.unwrap();
    let staged_document: WorkspaceContentStagedDocument = serde_json::from_slice(&staged_document.data).unwrap();
    assert_eq!(staged_document.schema_version, 3);
    assert_eq!(staged_document.source_hash.len(), 64);
    let staged_yjs = STANDARD.decode(staged_document.yjs_update_base64).unwrap();
    let native_documents = yjs::extract_document_references_from_yjs(&staged_yjs).unwrap();
    let target_document = manifests
      .mappings
      .lock()
      .unwrap()
      .iter()
      .find(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Document)
      .unwrap()
      .target
      .clone();
    assert_eq!(native_documents.occurrences.len(), 1);
    assert_eq!(
      native_documents.occurrences[0].raw_target_doc_id,
      target_document.resource_id()
    );
    assert_eq!(
      native_documents.occurrences[0].target_workspace_id.as_deref(),
      Some(target_document.workspace_id().to_string().as_str())
    );
    let assets = yjs::extract_portable_asset_references(&staged_yjs).unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].source_key, target_blob.resource_id());
    assert_ne!(
      target_document.resource_id(),
      target_blob.resource_id(),
      "equal source literals keep distinct resource namespaces"
    );
    use yrs::{Map, Transact};
    let native = yrs::Doc::new();
    let blocks = native.get_or_insert_map("blocks");
    native
      .transact_mut()
      .apply_update(yrs::updates::decoder::Decode::decode_v1(&staged_yjs).unwrap())
      .unwrap();
    let tx = native.transact();
    let yrs::Out::YMap(reference) = blocks.get(&tx, "asset.png").unwrap() else {
      panic!("native block preserved")
    };
    assert!(
      matches!(reference.get(&tx, "sys:id"), Some(yrs::Out::Any(yrs::Any::String(id))) if id.as_ref() == "asset.png")
    );
    assert!(
      matches!(reference.get(&tx, "prop:caption"), Some(yrs::Out::Any(yrs::Any::String(id))) if id.as_ref() == "asset.png")
    );
    let target_doc_id = staged_document.target_doc_id.to_string();
    assert_eq!(
      staged_document
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("doc_id"))
        .and_then(serde_json::Value::as_str),
      Some(target_doc_id.as_str())
    );
    let blob = entries
      .iter()
      .find(|entry| entry.resource.kind() == WorkspaceContentResourceKind::Blob)
      .unwrap();
    let staged_blob = storage.read_blob(blob.object_key()).await.unwrap();
    let staged_blob: WorkspaceContentStagedBlob = serde_json::from_slice(&staged_blob.data).unwrap();
    assert_eq!(staged_blob.content_type, "image/png");
    assert_eq!(STANDARD.decode(staged_blob.data_base64).unwrap(), b"verified-image");
    let source_values =
      yjs::collect_yjs_resource_values(source.documents.lock().unwrap().values().next().unwrap()).unwrap();
    assert!(source_values.contains("asset.png"), "Copy must not mutate source state");
  }

  #[tokio::test]
  async fn copy_removes_corrupt_partial_staging_without_persisting_a_manifest() {
    let (record, manifests, compensations, source, storage, _) = fixture();
    storage.corrupt_writes.store(true, Ordering::SeqCst);
    let executor = WorkspaceContentCopyExecutor::new(manifests.clone(), compensations.clone(), source, storage.clone());

    assert!(matches!(
      executor.stage(&record).await,
      Err(AuthError::InvalidInput(message)) if message == WorkspaceContentErrorCode::StagingReplayConflict.as_str()
    ));
    assert!(storage.objects.lock().unwrap().is_empty());
    assert!(manifests.entries.lock().unwrap().is_empty());
    assert_eq!(
      compensations.intents.lock().unwrap().len(),
      1,
      "intent precedes external I/O"
    );

    let (record, manifests, compensations, source, storage, _) = fixture();
    storage.interrupt_writes.store(true, Ordering::SeqCst);
    let executor = WorkspaceContentCopyExecutor::new(manifests.clone(), compensations.clone(), source, storage.clone());
    assert!(matches!(executor.stage(&record).await, Err(AuthError::Storage(_))));
    assert!(storage.objects.lock().unwrap().is_empty());
    assert!(manifests.entries.lock().unwrap().is_empty());
    assert_eq!(
      compensations.intents.lock().unwrap().len(),
      1,
      "intent precedes external I/O"
    );
  }

  #[tokio::test]
  async fn copy_removes_corrupt_replay_residue_and_recovers_on_the_next_delivery() {
    let (record, manifests, compensations, source, storage, _) = fixture();
    let executor = WorkspaceContentCopyExecutor::new(
      manifests.clone(),
      compensations.clone(),
      source.clone(),
      storage.clone(),
    );
    executor.stage(&record).await.unwrap();
    let corrupt_key = manifests.entries.lock().unwrap()[0].object_key().to_string();
    storage.objects.lock().unwrap().get_mut(&corrupt_key).unwrap().0 = Bytes::from_static(b"corrupt");

    assert!(matches!(
      executor.stage(&record).await,
      Err(AuthError::InvalidInput(message)) if message == WorkspaceContentErrorCode::StagingReplayConflict.as_str()
    ));
    assert!(!storage.objects.lock().unwrap().contains_key(&corrupt_key));

    let recovered = executor.stage(&record).await.unwrap();
    assert_eq!(recovered.document_count, 1);
    assert_eq!(recovered.blob_count, 1);
    assert!(storage.objects.lock().unwrap().contains_key(&corrupt_key));
  }
}
