// SPDX-License-Identifier: AGPL-3.0-or-later
//! Verified publication boundary for a staged cross-workspace Copy.
//!
//! Object storage is read and validated before the SQL transaction starts.
//! The infrastructure port receives one immutable, fully decoded batch and
//! must either publish every canonical row plus outbox intent or publish none.

use myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode;
use std::sync::Arc;

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;
use myoxus_domain::workspace_content_operation::{
  WorkspaceContentIdMapping, WorkspaceContentOperationKind, WorkspaceContentOperationRecord,
  WorkspaceContentOperationStatus, WorkspaceContentResourceKind, WorkspaceContentResourceRef,
  WorkspaceContentStagingEntry,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};
use crate::database::{
  DatabaseImportExportService, WorkspaceContentDatabaseIdentityPlan, WorkspaceContentDatabasePublicationBundle,
};
use crate::doc::DocService;
use crate::organizer::OrganizerService;
use crate::ports::{BlobStoragePort, PortError};

use super::copy::{WorkspaceContentStagedBlob, WorkspaceContentStagedDocument};
use super::organizer_stage::{WorkspaceContentOrganizerEnvelope, WorkspaceContentOrganizerStageExecutor};
use super::reconcile::{
  WorkspaceContentReconcileAction, WorkspaceContentReconcileEnvelope, WorkspaceContentReconcileSourcePort,
  definition_schema_hash,
};
use super::{WorkspaceContentOperationRepository, WorkspaceContentStagingManifestRepository};

/// One decoded canonical object in a Copy publication.
#[derive(Debug, Clone)]
pub enum WorkspaceContentPublicationObject {
  Document {
    resource: WorkspaceContentResourceRef,
    internal_doc_id: Uuid,
    title: String,
    yjs_update: Vec<u8>,
    metadata: serde_json::Value,
    tag_ids: Vec<Uuid>,
  },
  Blob {
    resource: WorkspaceContentResourceRef,
    bytes: Bytes,
    content_type: String,
  },
  Reconciled {
    resource: WorkspaceContentResourceRef,
    envelope: WorkspaceContentReconcileEnvelope,
  },
  Database {
    resource: WorkspaceContentResourceRef,
    envelope: WorkspaceContentReconcileEnvelope,
    bundle: Box<WorkspaceContentDatabasePublicationBundle>,
  },
  Organizer {
    envelope: WorkspaceContentOrganizerEnvelope,
    update: Vec<u8>,
  },
}

#[async_trait]
pub trait WorkspaceContentOrganizerRevisionPort: Send + Sync {
  async fn revision(&self, workspace_id: Uuid) -> AuthResult<String>;
}

pub struct WorkspaceContentOrganizerRevisionService {
  organizer: OrganizerService<DocService>,
}

impl WorkspaceContentOrganizerRevisionService {
  pub fn new(doc: DocService) -> Self {
    Self {
      organizer: OrganizerService::new(doc),
    }
  }
}

#[async_trait]
impl WorkspaceContentOrganizerRevisionPort for WorkspaceContentOrganizerRevisionService {
  async fn revision(&self, workspace_id: Uuid) -> AuthResult<String> {
    self
      .organizer
      .snapshot(workspace_id)
      .await
      .map(|snapshot| snapshot.revision)
      .map_err(super::diagnostics::organizer_failure)
  }
}

/// Immutable input for the singular PostgreSQL publication transaction.
#[derive(Debug, Clone)]
pub struct WorkspaceContentCopyPublicationBatch {
  pub operation: WorkspaceContentOperationRecord,
  pub mappings: Vec<WorkspaceContentIdMapping>,
  pub staging_entries: Vec<WorkspaceContentStagingEntry>,
  pub objects: Vec<WorkspaceContentPublicationObject>,
}

/// Atomic canonical write boundary.
#[async_trait]
pub trait WorkspaceContentCopyPublicationPort: Send + Sync {
  /// Publish every object, canonical ACL row and outbox intent exactly once.
  ///
  /// Implementations must lock the operation and all reuse targets and
  /// terminalize the operation in the same PostgreSQL transaction.
  async fn publish_copy(
    &self,
    batch: WorkspaceContentCopyPublicationBatch,
    diagnostic_instance_id: &str,
  ) -> super::diagnostics::WorkspaceContentExecutionResult<WorkspaceContentOperationRecord>;
}

/// Verifies operation-owned staging before entering the SQL commit boundary.
pub struct WorkspaceContentCopyPublicationService {
  operations: Arc<dyn WorkspaceContentOperationRepository>,
  manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
  reconcile_source: Arc<dyn WorkspaceContentReconcileSourcePort>,
  staging: Arc<dyn BlobStoragePort>,
  publisher: Arc<dyn WorkspaceContentCopyPublicationPort>,
  organizer_stage: Option<Arc<WorkspaceContentOrganizerStageExecutor>>,
  organizer_revisions: Option<Arc<dyn WorkspaceContentOrganizerRevisionPort>>,
  databases: Option<Arc<DatabaseImportExportService>>,
}

impl WorkspaceContentCopyPublicationService {
  pub fn new(
    operations: Arc<dyn WorkspaceContentOperationRepository>,
    manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
    reconcile_source: Arc<dyn WorkspaceContentReconcileSourcePort>,
    staging: Arc<dyn BlobStoragePort>,
    publisher: Arc<dyn WorkspaceContentCopyPublicationPort>,
  ) -> Self {
    Self {
      operations,
      manifests,
      reconcile_source,
      staging,
      publisher,
      organizer_stage: None,
      organizer_revisions: None,
      databases: None,
    }
  }

  pub fn with_databases(mut self, databases: Arc<DatabaseImportExportService>) -> Self {
    self.databases = Some(databases);
    self
  }

  pub fn with_organizer(
    mut self,
    stage: Arc<WorkspaceContentOrganizerStageExecutor>,
    revisions: Arc<dyn WorkspaceContentOrganizerRevisionPort>,
  ) -> Self {
    self.organizer_stage = Some(stage);
    self.organizer_revisions = Some(revisions);
    self
  }

  pub async fn publish(
    &self,
    record: &WorkspaceContentOperationRecord,
    diagnostic_instance_id: &str,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    self
      .publish_with_diagnostics(record, diagnostic_instance_id)
      .await
      .map_err(|error| error.into_source())
  }

  pub(crate) async fn publish_with_diagnostics(
    &self,
    record: &WorkspaceContentOperationRecord,
    diagnostic_instance_id: &str,
  ) -> super::diagnostics::WorkspaceContentExecutionResult<WorkspaceContentOperationRecord> {
    let current = self
      .operations
      .get(record.id)
      .await?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
    if current != *record
      || current.kind != WorkspaceContentOperationKind::Copy
      || current.status != WorkspaceContentOperationStatus::Running
    {
      return Err(
        AuthError::InvalidInput(WorkspaceContentErrorCode::PublicationStateInvalid.as_str().to_string()).into(),
      );
    }
    let target_workspace_id = current
      .target_workspace_id
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().to_string()))?;
    let mut mappings = self.manifests.list_mappings(current.id).await?;
    super::reject_collection_mappings(&mappings)?;
    mappings.sort_by(|left, right| left.source.cmp(&right.source));
    // Staging already checked source Copy and target write authority before
    // reading source bytes. Publishing verified immutable staging does not
    // need to repeat those same permission decisions.
    if let Some(stage) = &self.organizer_stage {
      super::diagnostics::in_phase(&current, "organizer_projection", stage.stage(&current)).await?;
    }

    let mut staging_entries = self.manifests.list_staging_entries(current.id).await?;
    staging_entries.sort_by_key(|entry| entry.sequence);
    if staging_entries.is_empty() {
      return Err(
        AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()).into(),
      );
    }
    let mut staged_objects = Vec::with_capacity(staging_entries.len());
    for entry in &staging_entries {
      let stored = self.staging.read_blob(entry.object_key()).await.map_err(storage)?;
      verify(&stored.data, entry.content_hash(), entry.size_bytes)?;
      staged_objects.push((entry.clone(), stored.data));
    }
    let mut target_document_ids = std::collections::BTreeMap::new();
    let mut source_document_ids = std::collections::HashMap::new();
    for (entry, data) in &staged_objects {
      if entry.resource.kind() != WorkspaceContentResourceKind::Document {
        continue;
      }
      let staged: WorkspaceContentStagedDocument = serde_json::from_slice(data).map_err(|_| {
        AuthError::InvalidInput(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().to_string())
      })?;
      let plan = staged.reference_plan.as_ref().ok_or_else(|| {
        AuthError::InvalidInput(WorkspaceContentErrorCode::NativeReferencePlanMissing.as_str().into())
      })?;
      plan.validate()?;
      if staged.schema_version != 3 {
        return Err(
          AuthError::InvalidInput(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().to_string()).into(),
        );
      }
      if let Some(source_id) = staged.source_doc_id {
        source_document_ids.insert(source_id, staged.target_doc_id);
      }
      target_document_ids.insert(entry.resource.resource_id().to_string(), staged.target_doc_id);
    }
    // Only reconcile-admitted nested Row identities can move the whole tuple.
    let mut row_reference_mappings = Vec::new();
    for (entry, data) in &staged_objects {
      if entry.resource.kind() != WorkspaceContentResourceKind::Database {
        continue;
      }
      let envelope: WorkspaceContentReconcileEnvelope = serde_json::from_slice(data)
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().into()))?;
      if envelope.action != WorkspaceContentReconcileAction::Create {
        continue;
      }
      let source_database = Uuid::parse_str(envelope.source.resource_id())
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().into()))?;
      let target_database = Uuid::parse_str(envelope.target.resource_id())
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().into()))?;
      if let Some(rows) = envelope
        .payload
        .pointer("/workspaceContentIdentityManifest/rows")
        .and_then(serde_json::Value::as_object)
      {
        for source in rows.values().filter_map(serde_json::Value::as_str) {
          let key = format!(
            "{}:database:{source_database}:rows:{source}",
            envelope.source.workspace_id()
          );
          let Some(target) = envelope.nested_mappings.get(&key) else {
            continue;
          };
          row_reference_mappings.push((
            yjs::DatabaseRowReference {
              workspace_id: envelope.source.workspace_id(),
              database_id: source_database,
              row_id: Uuid::parse_str(source).map_err(|_| {
                AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().into())
              })?,
            },
            yjs::DatabaseRowReference {
              workspace_id: envelope.target.workspace_id(),
              database_id: target_database,
              row_id: Uuid::parse_str(target).map_err(|_| {
                AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().into())
              })?,
            },
          ));
        }
      }
    }
    let mut objects = Vec::with_capacity(staged_objects.len());
    for (entry, data) in staged_objects {
      let resource = entry.resource;
      match resource.kind() {
        WorkspaceContentResourceKind::Document => {
          let staged: WorkspaceContentStagedDocument = serde_json::from_slice(&data).map_err(|_| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().to_string())
          })?;
          if staged.schema_version != 3 || staged.reference_plan.is_none() {
            return Err(
              AuthError::InvalidInput(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().to_string()).into(),
            );
          }
          let yjs_update = STANDARD
            .decode(staged.yjs_update_base64)
            .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::EncodingFailed.as_str().to_string()))?;
          let yjs_update = yjs::rewrite_database_row_references(
            &yjs_update,
            &row_reference_mappings,
            ((super::copy::copy_rewrite_client_id(current.id, &resource) + 1) & ((1_u64 << 53) - 1)).max(1),
          )
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().into()))?
          .full_state;
          yjs::collect_yjs_resource_values(&yjs_update).map_err(|_| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().to_string())
          })?;
          let metadata = staged.metadata.ok_or_else(|| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().to_string())
          })?;
          let tag_ids = map_tag_ids(&staged.tag_ids, &mappings)?;
          let target_key = resource.resource_id().to_string();
          let target_doc_id = staged.target_doc_id;
          objects.push(WorkspaceContentPublicationObject::Document {
            resource,
            internal_doc_id: target_doc_id,
            title: staged.title,
            yjs_update,
            metadata,
            tag_ids,
          });
          target_document_ids.insert(target_key, target_doc_id);
        }
        WorkspaceContentResourceKind::Blob => {
          let staged: WorkspaceContentStagedBlob = serde_json::from_slice(&data).map_err(|_| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string())
          })?;
          if staged.schema_version != 2 || staged.content_type.trim().is_empty() {
            return Err(
              AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()).into(),
            );
          }
          let bytes = STANDARD
            .decode(staged.data_base64)
            .map(Bytes::from)
            .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::EncodingFailed.as_str().to_string()))?;
          objects.push(WorkspaceContentPublicationObject::Blob {
            resource,
            bytes,
            content_type: staged.content_type,
          });
        }
        WorkspaceContentResourceKind::Collection => {
          return Err(
            AuthError::InvalidInput(WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str().into()).into(),
          );
        }
        WorkspaceContentResourceKind::Database | WorkspaceContentResourceKind::Tag => {
          let envelope: WorkspaceContentReconcileEnvelope = serde_json::from_slice(&data).map_err(|_| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string())
          })?;
          if envelope.operation_id != current.id || envelope.target != resource {
            return Err(
              AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()).into(),
            );
          }
          if resource.kind() == WorkspaceContentResourceKind::Tag {
            envelope.source_tag()?;
          }
          if envelope.action == WorkspaceContentReconcileAction::Reuse {
            let live = self
              .reconcile_source
              .load(current.actor_id, &resource)
              .await?
              .ok_or_else(|| {
                AuthError::InvalidInput(WorkspaceContentErrorCode::TargetDefinitionMissing.as_str().to_string())
              })?;
            let reusable = if resource.kind() == WorkspaceContentResourceKind::Tag {
              let source = envelope.source_tag()?;
              super::preflight::tag_target_is_reusable(
                &source.name,
                source.archived_at.is_some(),
                &live.name,
                live
                  .schema
                  .get("archived")
                  .and_then(serde_json::Value::as_bool)
                  .unwrap_or(false),
              )
            } else {
              definition_schema_hash(&live)? == envelope.schema_hash
            };
            if !reusable {
              return Err(
                AuthError::InvalidInput(WorkspaceContentErrorCode::TargetDefinitionChanged.as_str().to_string()).into(),
              );
            }
          }
          if resource.kind() == WorkspaceContentResourceKind::Database
            && envelope.action == WorkspaceContentReconcileAction::Create
          {
            let databases = self
              .databases
              .as_ref()
              .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?;
            let identity = database_identity_plan(&envelope, &mappings, &target_document_ids, &source_document_ids)?;
            let workspace_tag_ids = database_tag_identities(&mappings)?;
            let bundle = databases
              .prepare_workspace_content_publication(
                current.actor_id,
                target_workspace_id,
                &envelope.payload,
                &identity,
                &workspace_tag_ids,
              )
              .map_err(super::diagnostics::database_service_failure)?;
            objects.push(WorkspaceContentPublicationObject::Database {
              resource,
              envelope,
              bundle: Box::new(bundle),
            });
          } else {
            objects.push(WorkspaceContentPublicationObject::Reconciled { resource, envelope });
          }
        }
        WorkspaceContentResourceKind::Folder => {
          let envelope: WorkspaceContentOrganizerEnvelope = serde_json::from_slice(&data)
            .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::OrganizerDecode.as_str().to_string()))?;
          if envelope.schema_version != 1
            || envelope.operation_id != current.id
            || envelope.source_workspace_id != current.source_workspace_id
            || envelope.target_workspace_id != target_workspace_id
          {
            return Err(
              AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()).into(),
            );
          }
          let revisions = self
            .organizer_revisions
            .as_ref()
            .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?;
          if revisions.revision(target_workspace_id).await? != envelope.target_revision {
            return Err(
              AuthError::InvalidInput(WorkspaceContentErrorCode::OrganizerRevisionStale.as_str().to_string()).into(),
            );
          }
          let update = STANDARD
            .decode(&envelope.update_base64)
            .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::EncodingFailed.as_str().to_string()))?;
          objects.push(WorkspaceContentPublicationObject::Organizer { envelope, update });
        }
      }
    }
    self
      .publisher
      .publish_copy(
        WorkspaceContentCopyPublicationBatch {
          operation: current,
          mappings,
          staging_entries,
          objects,
        },
        diagnostic_instance_id,
      )
      .await
  }
}

fn database_identity_plan(
  envelope: &WorkspaceContentReconcileEnvelope,
  mappings: &[myoxus_domain::workspace_content_operation::WorkspaceContentIdMapping],
  _target_document_ids: &std::collections::BTreeMap<String, Uuid>,
  source_document_ids: &std::collections::HashMap<Uuid, Uuid>,
) -> AuthResult<WorkspaceContentDatabaseIdentityPlan> {
  let database_id = Uuid::parse_str(envelope.target.resource_id())
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().to_string()))?;
  let manifest = envelope
    .payload
    .get("workspaceContentIdentityManifest")
    .and_then(serde_json::Value::as_object)
    .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))?;
  let identities = |family: &str| -> AuthResult<std::collections::HashMap<String, Uuid>> {
    let source = manifest
      .get(family)
      .and_then(serde_json::Value::as_object)
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().into()))?;
    source
      .iter()
      .map(|(portable, source_id)| {
        let source_id = source_id
          .as_str()
          .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().into()))?;
        let suffix = format!(":{family}:{source_id}");
        let target = envelope
          .nested_mappings
          .iter()
          .find(|(key, _)| key.ends_with(&suffix))
          .map(|(_, value)| value)
          .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into()))?;
        Ok((
          portable.clone(),
          Uuid::parse_str(target)
            .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().into()))?,
        ))
      })
      .collect()
  };
  let document_identities = |family: &str| -> AuthResult<std::collections::HashMap<String, Uuid>> {
    let mut document_ids = std::collections::HashMap::new();
    let Some(documents) = manifest.get(family).and_then(serde_json::Value::as_object) else {
      return Ok(document_ids);
    };
    for (portable, source_id) in documents {
      let source_id = source_id.as_str().ok_or_else(|| {
        AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().to_string())
      })?;
      let source_id = Uuid::parse_str(source_id)
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().into()))?;
      let target_id = source_document_ids
        .get(&source_id)
        .copied()
        .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().into()))?;
      document_ids.insert(portable.clone(), target_id);
    }
    Ok(document_ids)
  };
  let mut content_document_ids = document_identities("rowContentDocuments")?;
  content_document_ids.extend(document_identities("templateContentDocuments")?);
  let row_template_ids = manifest
    .get("rowTemplates")
    .and_then(serde_json::Value::as_array)
    .into_iter()
    .flatten()
    .enumerate()
    .map(|(index, source)| {
      let source = source.as_str().ok_or_else(|| {
        AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().to_string())
      })?;
      let suffix = format!(":rowTemplates:{source}");
      let target = envelope
        .nested_mappings
        .iter()
        .find(|(key, _)| key.ends_with(&suffix))
        .map(|(_, value)| value)
        .ok_or_else(|| {
          AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().to_string())
        })?;
      let portable = envelope
        .payload
        .pointer(&format!("/database/rowTemplates/{index}/id"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
          AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().to_string())
        })?;
      Ok((
        portable.to_string(),
        Uuid::parse_str(target).map_err(|_| {
          AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().to_string())
        })?,
      ))
    })
    .collect::<AuthResult<std::collections::HashMap<_, _>>>()?;
  let nested_ids = envelope
    .nested_mappings
    .iter()
    .filter_map(|(key, value)| {
      let (prefix, id) = key.rsplit_once(':')?;
      let family = prefix.rsplit_once(':')?.1;
      Some((
        (family.to_string(), Uuid::parse_str(id).ok()?),
        Uuid::parse_str(value).ok()?,
      ))
    })
    .collect();
  Ok(WorkspaceContentDatabaseIdentityPlan {
    source_workspace_id: envelope.source.workspace_id(),
    database_ids: mappings
      .iter()
      .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Database)
      .map(|mapping| {
        Ok((
          Uuid::parse_str(mapping.source.resource_id())
            .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().into()))?,
          Uuid::parse_str(mapping.target.resource_id())
            .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().into()))?,
        ))
      })
      .collect::<AuthResult<_>>()?,
    nested_ids,
    document_external_ids: source_document_ids
      .iter()
      .filter_map(|(source, target)| {
        _target_document_ids
          .iter()
          .find(|(_, id)| *id == target)
          .and_then(|(key, _)| {
            mappings
              .iter()
              .find(|mapping| {
                mapping.source.kind() == WorkspaceContentResourceKind::Document && mapping.target.resource_id() == key
              })
              .map(|mapping| (*source, (mapping.source.resource_id().to_string(), key.clone())))
          })
      })
      .collect(),
    document_ids: source_document_ids.clone(),
    blob_keys: mappings
      .iter()
      .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Blob)
      .map(|mapping| (mapping.source.resource_id().into(), mapping.target.resource_id().into()))
      .collect(),
    database_id,
    fallback_view_id: Uuid::new_v5(
      &envelope.operation_id,
      format!("database-fallback-view:{database_id}").as_bytes(),
    ),
    field_ids: identities("fields")?,
    view_ids: identities("views")?,
    row_ids: identities("rows")?,
    row_template_ids,
    content_document_ids,
  })
}

fn database_tag_identities(
  mappings: &[WorkspaceContentIdMapping],
) -> AuthResult<std::collections::HashMap<Uuid, Uuid>> {
  mappings
    .iter()
    .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Tag)
    .map(|mapping| {
      let source = Uuid::parse_str(mapping.source.resource_id())
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().to_string()))?;
      let target = Uuid::parse_str(mapping.target.resource_id())
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().to_string()))?;
      Ok((source, target))
    })
    .collect()
}

fn map_tag_ids(source_tag_ids: &[Uuid], mappings: &[WorkspaceContentIdMapping]) -> AuthResult<Vec<Uuid>> {
  let mut target_tag_ids = Vec::with_capacity(source_tag_ids.len());
  for source_tag_id in source_tag_ids {
    let source_id = source_tag_id.to_string();
    let target = mappings
      .iter()
      .find(|mapping| {
        mapping.source.kind() == WorkspaceContentResourceKind::Tag
          && mapping.source.resource_id() == source_id
          && mapping.target.kind() == WorkspaceContentResourceKind::Tag
      })
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))?;
    target_tag_ids.push(
      Uuid::parse_str(target.target.resource_id())
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().to_string()))?,
    );
  }
  let mut seen = std::collections::HashSet::new();
  target_tag_ids.retain(|id| seen.insert(*id));
  Ok(target_tag_ids)
}

fn verify(data: &[u8], expected_hash: &str, expected_size: i64) -> AuthResult<()> {
  if expected_size < 0 || data.len() as i64 != expected_size || sha256_hex(data) != expected_hash {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::StagingReplayConflict.as_str().to_string(),
    ));
  }
  Ok(())
}

fn sha256_hex(data: &[u8]) -> String {
  hex::encode(Sha256::digest(data))
}

fn storage(error: PortError) -> AuthError {
  super::diagnostics::record_port_failure(&error, "publication_staging_read");
  match error {
    PortError::NotFound(_) => {
      AuthError::NotFound(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string())
    }
    _ => AuthError::Storage(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()),
  }
}

#[cfg(test)]
mod label_tests {
  use super::*;

  #[test]
  fn copy_maps_labels_in_source_assignment_order() {
    let source_workspace = Uuid::from_u128(10);
    let target_workspace = Uuid::from_u128(20);
    let source = [Uuid::from_u128(1), Uuid::from_u128(2)];
    let target = [Uuid::from_u128(4), Uuid::from_u128(3)];
    let mappings = source
      .iter()
      .zip(target)
      .map(|(source, target)| {
        WorkspaceContentIdMapping::new(
          WorkspaceContentResourceRef::new(source_workspace, WorkspaceContentResourceKind::Tag, source.to_string())
            .unwrap(),
          WorkspaceContentResourceRef::new(target_workspace, WorkspaceContentResourceKind::Tag, target.to_string())
            .unwrap(),
        )
        .unwrap()
      })
      .collect::<Vec<_>>();
    assert_eq!(map_tag_ids(&source, &mappings).unwrap(), target);
  }
}
