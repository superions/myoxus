// SPDX-License-Identifier: AGPL-3.0-or-later
//! Operation-owned organizer projection for Copy publication.

use myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;
use myoxus_domain::permission::WorkspaceAction;
use myoxus_domain::workspace_content_operation::{
  WorkspaceContentOperationRecord, WorkspaceContentResourceKind, WorkspaceContentResourceRef,
  WorkspaceContentStagingEntry,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::auth::{AuthError, AuthResult};
use crate::doc::DocService;
use crate::organizer::{OrganizerLinkType, OrganizerRow, OrganizerService, OrganizerSnapshot};
use crate::permission::{AccessController, PermissionService, WorkspaceResource};
use crate::ports::{BlobStoragePort, BlobWriteRequest, PortError};

use super::copy::WorkspaceContentCopyCompensationPort;
use super::{
  WorkspaceContentCompensationIntent, WorkspaceContentRedirectRepository, WorkspaceContentReferenceDecision,
  WorkspaceContentStagingManifestRepository,
};

/// Content-free decisions for selected placements. Canonical failures propagate;
/// only a decoded malformed address or proved absence permits omission.
pub async fn prepare_organizer_reference_decisions<F, Fut>(
  source: &OrganizerSnapshot,
  mappings: &[myoxus_domain::workspace_content_operation::WorkspaceContentIdMapping],
  mut resolve: F,
) -> AuthResult<Vec<(String, WorkspaceContentReferenceDecision)>>
where
  F: FnMut(WorkspaceContentResourceRef) -> Fut,
  Fut: std::future::Future<Output = AuthResult<Option<WorkspaceContentResourceRef>>>,
{
  let mut decisions = Vec::new();
  for row in source.contained_resource_rows(mappings) {
    if row.link_type().map_err(super::diagnostics::organizer_failure)? == OrganizerLinkType::Workspace {
      continue;
    }
    let target = match row
      .resource_reference(source.workspace_id)
      .map_err(super::diagnostics::organizer_failure)?
    {
      Some(resource) => resolve(resource).await?,
      None => None,
    };
    decisions.push((
      row.id,
      match target {
        Some(target) => WorkspaceContentReferenceDecision::Keep { target },
        None => WorkspaceContentReferenceDecision::Omit,
      },
    ));
  }
  Ok(decisions)
}

const CONTENT_TYPE: &str = "application/vnd.myoxus.workspace-content-organizer+json";
const DELETE_STAGED_OBJECT: &str = "delete_staged_object";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentOrganizerEnvelope {
  pub schema_version: u32,
  pub operation_id: uuid::Uuid,
  pub source_workspace_id: uuid::Uuid,
  pub target_workspace_id: uuid::Uuid,
  pub source_revision: String,
  pub target_revision: String,
  pub rows: Vec<OrganizerRow>,
  pub update_base64: String,
}

pub struct WorkspaceContentOrganizerStageExecutor {
  manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
  compensations: Arc<dyn WorkspaceContentCopyCompensationPort>,
  organizer: OrganizerService<DocService>,
  permissions: Arc<PermissionService>,
  staging: Arc<dyn BlobStoragePort>,
  references: Arc<dyn WorkspaceContentRedirectRepository>,
}

impl WorkspaceContentOrganizerStageExecutor {
  pub fn new(
    manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
    compensations: Arc<dyn WorkspaceContentCopyCompensationPort>,
    doc: DocService,
    permissions: Arc<PermissionService>,
    staging: Arc<dyn BlobStoragePort>,
    references: Arc<dyn WorkspaceContentRedirectRepository>,
  ) -> Self {
    Self {
      manifests,
      compensations,
      organizer: OrganizerService::new(doc),
      permissions,
      staging,
      references,
    }
  }

  pub async fn stage(
    &self,
    record: &WorkspaceContentOperationRecord,
  ) -> AuthResult<Option<WorkspaceContentStagingEntry>> {
    let target_workspace_id = record
      .target_workspace_id
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().to_string()))?;
    // Copy reads the source placement and writes the target placement. Normal
    // workspace Read/CreateDoc are the two corresponding product capabilities.
    for (workspace_id, action) in [
      (record.source_workspace_id, WorkspaceAction::Read),
      (target_workspace_id, WorkspaceAction::CreateDoc),
    ] {
      if !self
        .permissions
        .can(
          &WorkspaceResource {
            user_id: record.actor_id,
            workspace_id,
          },
          action,
        )
        .await
      {
        return Err(AuthError::ActionForbidden);
      }
    }
    let mappings = self.manifests.list_mappings(record.id).await?;
    let source = self
      .organizer
      .snapshot(record.source_workspace_id)
      .await
      .map_err(super::diagnostics::organizer_failure)?;
    let decisions = prepare_organizer_reference_decisions(&source, &mappings, |resource| async move {
      self.references.canonical_reference(&resource).await
    })
    .await?;
    let projection = self
      .organizer
      .project_copy(
        record.id,
        record.source_workspace_id,
        target_workspace_id,
        &mappings,
        &decisions,
      )
      .await
      .map_err(super::diagnostics::organizer_failure)?;
    if projection.source_reference_revision != source.contained_reference_revision(&mappings) {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::MoveOrganizerReferencesChanged
          .as_str()
          .into(),
      ));
    }
    // Every admitted folder definition must survive in the actual projection, including empty leaves.
    if mappings
      .iter()
      .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Folder)
      .any(|mapping| {
        !projection
          .rows
          .iter()
          .any(|row| row.is_folder() && row.id == mapping.target.resource_id())
      })
    {
      return Err(AuthError::NotFound(
        WorkspaceContentErrorCode::SourceRootMissing.as_str().into(),
      ));
    }
    if projection.rows.is_empty() {
      return Ok(None);
    }
    let envelope = WorkspaceContentOrganizerEnvelope {
      schema_version: 1,
      operation_id: record.id,
      source_workspace_id: record.source_workspace_id,
      target_workspace_id,
      source_revision: projection.source_revision,
      target_revision: projection.target_revision,
      rows: projection.rows,
      update_base64: STANDARD.encode(projection.update),
    };
    let body = serde_json::to_vec(&envelope)
      .map(Bytes::from)
      .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))?;
    let hash = hex::encode(Sha256::digest(&body));
    let object_key = format!("workspace-content/{}/objects/{hash}", record.id);
    match self.staging.read_blob(&object_key).await {
      Ok(existing) if existing.data == body => {}
      Ok(_) => {
        self.staging.delete_blob(&object_key).await.map_err(storage)?;
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::StagingReplayConflict.as_str().to_string(),
        ));
      }
      Err(PortError::NotFound(_)) => {
        self
          .staging
          .write_blob(BlobWriteRequest {
            key: object_key.clone(),
            content_type: Some(CONTENT_TYPE.to_string()),
            body: body.clone(),
          })
          .await
          .map_err(storage)?;
        let readback = self.staging.read_blob(&object_key).await.map_err(storage)?;
        if readback.data != body {
          self.staging.delete_blob(&object_key).await.map_err(storage)?;
          return Err(AuthError::InvalidInput(
            WorkspaceContentErrorCode::StagingReplayConflict.as_str().to_string(),
          ));
        }
      }
      Err(error) => return Err(storage(error)),
    }
    let mut entries = self.manifests.list_staging_entries(record.id).await?;
    if let Some(existing) = entries
      .iter()
      .find(|entry| entry.resource.kind() == WorkspaceContentResourceKind::Folder)
    {
      if existing.content_hash() == hash && existing.object_key() == object_key {
        return Ok(Some(existing.clone()));
      }
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string(),
      ));
    }
    let sequence = entries
      .iter()
      .map(|entry| entry.sequence)
      .max()
      .unwrap_or(-1)
      .checked_add(1)
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))?;
    let resource = WorkspaceContentResourceRef::new(
      target_workspace_id,
      WorkspaceContentResourceKind::Folder,
      format!("operation-organizer-{}", record.id),
    )
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))?;
    let entry = WorkspaceContentStagingEntry::new(
      record.id,
      sequence,
      resource,
      object_key,
      hash,
      i64::try_from(body.len())
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))?,
    )
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))?;
    entries.push(entry.clone());
    entries.sort_by_key(|entry| entry.sequence);
    self
      .manifests
      .store_manifest(record.id, &record.manifest_hash, &mappings, &entries)
      .await?;
    self
      .compensations
      .append_copy_compensation(WorkspaceContentCompensationIntent {
        operation_id: record.id,
        sequence: i64::from(sequence),
        kind: DELETE_STAGED_OBJECT.to_string(),
        target: entry.resource.clone(),
      })
      .await?;
    Ok(Some(entry))
  }
}

fn storage(error: PortError) -> AuthError {
  super::diagnostics::record_port_failure(&error, "organizer_staging");
  AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string())
}
