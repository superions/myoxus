// SPDX-License-Identifier: AGPL-3.0-or-later
//! Operation-owned reconciliation for Copy metadata resources.
//!
//! Tags and Databases are read through their canonical
//! services. The resulting payloads are stored only in the operation staging
//! namespace; this module has no canonical target write port.

use myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use myoxus_domain::database::DatabaseSnapshot;
use myoxus_domain::workspace_content_operation::{
  WorkspaceContentIdMapping, WorkspaceContentOperationRecord, WorkspaceContentResourceKind,
  WorkspaceContentResourceRef, WorkspaceContentStagingEntry,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};
use crate::database::{DatabaseDefinitionService, DatabaseImportExportService};
use crate::ports::{BlobStoragePort, BlobWriteRequest, PortError};
use crate::workspace_tags::WorkspaceTagService;

use super::copy::WorkspaceContentCopyCompensationPort;
use super::{WorkspaceContentCompensationIntent, WorkspaceContentStagingManifestRepository};

const SCHEMA_VERSION: u32 = 1;
pub const TAG_SCHEMA_VERSION: u32 = 2;
const CONTENT_TYPE: &str = "application/vnd.myoxus.workspace-content-reconcile+json";
const DELETE_STAGED_OBJECT: &str = "delete_staged_object";

/// One canonical resource before target reconciliation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceContentDefinition {
  pub resource: WorkspaceContentResourceRef,
  pub name: String,
  pub schema: Value,
  pub payload: Value,
}

/// Read-only source and target lookup boundary.
#[async_trait]
pub trait WorkspaceContentReconcileSourcePort: Send + Sync {
  async fn load(
    &self,
    actor_id: Uuid,
    resource: &WorkspaceContentResourceRef,
  ) -> AuthResult<Option<WorkspaceContentDefinition>>;

  async fn catalog(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    kind: WorkspaceContentResourceKind,
  ) -> AuthResult<Vec<WorkspaceContentDefinition>>;
}

/// Canonical production adapter. It deliberately exposes no mutation method.
pub struct WorkspaceContentReconcileSourceService {
  definition: Option<Arc<DatabaseDefinitionService>>,
  import_export: Option<Arc<DatabaseImportExportService>>,
  tags: Option<Arc<WorkspaceTagService>>,
}

impl WorkspaceContentReconcileSourceService {
  pub fn new(
    definition: Option<Arc<DatabaseDefinitionService>>,
    import_export: Option<Arc<DatabaseImportExportService>>,
    tags: Option<Arc<WorkspaceTagService>>,
  ) -> Self {
    Self {
      definition,
      import_export,
      tags,
    }
  }

  async fn database(
    &self,
    actor_id: Uuid,
    resource: &WorkspaceContentResourceRef,
  ) -> AuthResult<Option<WorkspaceContentDefinition>> {
    let id = parse_uuid(
      resource.resource_id(),
      WorkspaceContentErrorCode::DatabaseIdentityInvalid,
    )?;
    let service = self
      .definition
      .as_ref()
      .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?;
    let record = match service.get_database(actor_id, id).await {
      Ok(record) if record.database.workspace_id == resource.workspace_id() => record,
      Ok(_) => return Ok(None),
      Err(error) if error.code == crate::database::ERR_NOT_FOUND => return Ok(None),
      Err(error) => return Err(super::diagnostics::database_service_failure(error)),
    };
    let import_export = self
      .import_export
      .as_ref()
      .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?;
    let payload = import_export
      .export_workspace_content_snapshot(actor_id, id)
      .await
      .map_err(super::diagnostics::database_service_failure)?;
    let snapshot: DatabaseSnapshot = serde_json::from_value(payload.clone())
      .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().to_string()))?;
    if !snapshot.diagnostics.is_empty() {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().to_string(),
      ));
    }
    Ok(Some(WorkspaceContentDefinition {
      resource: resource.clone(),
      name: record.database.title,
      schema: import_export
        .workspace_content_schema(actor_id, id)
        .await
        .map_err(super::diagnostics::database_service_failure)?,
      payload,
    }))
  }

  async fn tag(
    &self,
    actor_id: Uuid,
    resource: &WorkspaceContentResourceRef,
  ) -> AuthResult<Option<WorkspaceContentDefinition>> {
    let id = parse_uuid(resource.resource_id(), WorkspaceContentErrorCode::SourceTagInvalid)?;
    let service = self
      .tags
      .as_ref()
      .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?;
    let tag = service
      .get_tag(actor_id, resource.workspace_id(), id)
      .await
      .map_err(super::diagnostics::tag_service_failure)?;
    let Some(tag) = tag else {
      return Ok(None);
    };
    let payload = serde_json::to_value(&tag)
      .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::SourceTagInvalid.as_str().to_string()))?;
    Ok(Some(WorkspaceContentDefinition {
      resource: resource.clone(),
      name: tag.name,
      schema: serde_json::json!({
        "colorRole": tag.color_role,
        "description": tag.description,
        "archived": tag.archived_at.is_some(),
      }),
      payload,
    }))
  }
}

#[async_trait]
impl WorkspaceContentReconcileSourcePort for WorkspaceContentReconcileSourceService {
  async fn load(
    &self,
    actor_id: Uuid,
    resource: &WorkspaceContentResourceRef,
  ) -> AuthResult<Option<WorkspaceContentDefinition>> {
    match resource.kind() {
      WorkspaceContentResourceKind::Database => self.database(actor_id, resource).await,
      WorkspaceContentResourceKind::Tag => self.tag(actor_id, resource).await,
      _ => Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::SelectedResourceUnsupported
          .as_str()
          .to_string(),
      )),
    }
  }

  async fn catalog(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    kind: WorkspaceContentResourceKind,
  ) -> AuthResult<Vec<WorkspaceContentDefinition>> {
    match kind {
      WorkspaceContentResourceKind::Tag => {
        let service = self
          .tags
          .as_ref()
          .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?;
        let tags = service
          .list_tags(actor_id, workspace_id, true)
          .await
          .map_err(super::diagnostics::tag_service_failure)?;
        let mut result = Vec::with_capacity(tags.len());
        for tag in tags {
          let resource = WorkspaceContentResourceRef::new(workspace_id, kind, tag.id.to_string())
            .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::SourceTagInvalid.as_str().to_string()))?;
          result.push(
            self
              .tag(actor_id, &resource)
              .await?
              .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::SourceTagInvalid.as_str().to_string()))?,
          );
        }
        Ok(result)
      }
      WorkspaceContentResourceKind::Database => {
        let service = self
          .import_export
          .as_ref()
          .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?;
        let catalog = service
          .workspace_content_target_catalog(actor_id, workspace_id)
          .await
          .map_err(super::diagnostics::database_service_failure)?;
        let mut result = Vec::new();
        for (summary, schema) in catalog {
          let resource = WorkspaceContentResourceRef::new(workspace_id, kind, summary.id.to_string())
            .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().to_string()))?;
          result.push(WorkspaceContentDefinition {
            resource,
            name: summary.title,
            schema,
            payload: Value::Null,
          });
        }
        Ok(result)
      }
      _ => Ok(Vec::new()),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceContentReconcileAction {
  Reuse,
  Create,
}

/// Versioned payload consumed by the later atomic publication transaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentReconcileEnvelope {
  pub schema_version: u32,
  pub operation_id: Uuid,
  pub source: WorkspaceContentResourceRef,
  pub target: WorkspaceContentResourceRef,
  pub action: WorkspaceContentReconcileAction,
  pub target_name: String,
  pub schema_hash: String,
  pub reference_mappings: BTreeMap<String, String>,
  /// Deterministic Field/View/Row/template/content-document identities and
  /// typed asset references carried inside a Database payload.
  pub nested_mappings: BTreeMap<String, String>,
  pub payload: Value,
  /// Retain all source definitions when classifications converge. This stays
  /// in the existing hashed staging object, not a separate catalog or ledger.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub tag_sources: Vec<WorkspaceContentDefinition>,
}

impl WorkspaceContentReconcileEnvelope {
  /// Old staging requires a fresh preview instead of silently acquiring the
  /// current name/archive policy. Historical records remain decodable.
  pub fn source_tag(&self) -> AuthResult<myoxus_domain::workspace_tags::WorkspaceTag> {
    if self.schema_version != TAG_SCHEMA_VERSION {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::SourceTagInvalid.as_str().into(),
      ));
    }
    let tag: myoxus_domain::workspace_tags::WorkspaceTag = serde_json::from_value(self.payload.clone())
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().into()))?;
    if self.source.kind() != WorkspaceContentResourceKind::Tag
      || self.target.kind() != WorkspaceContentResourceKind::Tag
      || self.source.workspace_id() != tag.workspace_id
      || self.source.resource_id() != tag.id.to_string()
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into(),
      ));
    }
    myoxus_domain::workspace_tags::WorkspaceTag::normalize_name(&tag.name)
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().into()))?;
    if !super::preflight::tag_target_is_reusable(
      &tag.name,
      tag.archived_at.is_some(),
      &self.target_name,
      tag.archived_at.is_some(),
    ) {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::SourceTagInvalid.as_str().into(),
      ));
    }
    let mut primary_present = false;
    for definition in &self.tag_sources {
      let source: myoxus_domain::workspace_tags::WorkspaceTag = serde_json::from_value(definition.payload.clone())
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().into()))?;
      if definition.resource.kind() != WorkspaceContentResourceKind::Tag
        || definition.resource.workspace_id() != self.source.workspace_id()
        || source.workspace_id != definition.resource.workspace_id()
        || definition.resource.resource_id() != source.id.to_string()
        || definition.name != source.name
        || definition.schema.get("archived").and_then(Value::as_bool) != Some(source.archived_at.is_some())
      {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::SourceTagInvalid.as_str().into(),
        ));
      }
      if !super::preflight::tag_target_is_reusable(
        &source.name,
        source.archived_at.is_some(),
        &tag.name,
        tag.archived_at.is_some(),
      ) {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::SourceTagInvalid.as_str().into(),
        ));
      }
      if definition.resource == self.source {
        if source != tag || definition_schema_hash(definition)? != self.schema_hash {
          return Err(AuthError::InvalidInput(
            WorkspaceContentErrorCode::SourceTagInvalid.as_str().into(),
          ));
        }
        primary_present = true;
      }
    }
    if !primary_present {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::StagingManifestInvalid.as_str().into(),
      ));
    }
    Ok(tag)
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentReconcileResult {
  pub staged_count: usize,
  pub reused_count: usize,
  pub created_count: usize,
}

/// Stages reconciled resources without creating canonical target rows.
pub struct WorkspaceContentReconcileExecutor {
  manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
  compensations: Arc<dyn WorkspaceContentCopyCompensationPort>,
  source: Arc<dyn WorkspaceContentReconcileSourcePort>,
  staging: Arc<dyn BlobStoragePort>,
}

impl WorkspaceContentReconcileExecutor {
  pub fn new(
    manifests: Arc<dyn WorkspaceContentStagingManifestRepository>,
    compensations: Arc<dyn WorkspaceContentCopyCompensationPort>,
    source: Arc<dyn WorkspaceContentReconcileSourcePort>,
    staging: Arc<dyn BlobStoragePort>,
  ) -> Self {
    Self {
      manifests,
      compensations,
      source,
      staging,
    }
  }

  pub async fn reconcile(
    &self,
    record: &WorkspaceContentOperationRecord,
  ) -> AuthResult<WorkspaceContentReconcileResult> {
    let target_workspace_id = record
      .target_workspace_id
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().to_string()))?;
    let mut mappings = self.manifests.list_mappings(record.id).await?;
    mappings.sort_by(|left, right| left.source.cmp(&right.source));
    super::reject_collection_mappings(&mappings)?;
    let mut selected = mappings
      .iter()
      .filter(|mapping| is_reconciled(mapping.source.kind()))
      .cloned()
      .collect::<Vec<_>>();
    if selected.is_empty() {
      return Ok(WorkspaceContentReconcileResult {
        staged_count: 0,
        reused_count: 0,
        created_count: 0,
      });
    }
    let reference_mappings = mappings
      .iter()
      .map(|mapping| (qualified(&mapping.source), qualified(&mapping.target)))
      .collect::<BTreeMap<_, _>>();
    let mut source_definitions = BTreeMap::new();
    for mapping in &selected {
      source_definitions.insert(
        mapping.source.clone(),
        self
          .source
          .load(record.actor_id, &mapping.source)
          .await?
          .ok_or_else(|| {
            let code = if mapping.source.kind() == WorkspaceContentResourceKind::Tag {
              WorkspaceContentErrorCode::SourceTagMissing
            } else {
              WorkspaceContentErrorCode::SourceDatabaseMissing
            };
            AuthError::NotFound(code.as_str().into())
          })?,
      );
    }
    selected.sort_by_key(|mapping| {
      (
        source_definitions[&mapping.source]
          .schema
          .get("archived")
          .and_then(Value::as_bool)
          .unwrap_or(false),
        mapping.source.clone(),
      )
    });
    let nested_mappings = build_nested_mappings(record.id, &mappings, &source_definitions)?;
    let mut catalogs = BTreeMap::new();
    for kind in [
      WorkspaceContentResourceKind::Database,
      WorkspaceContentResourceKind::Tag,
    ] {
      if selected.iter().any(|mapping| mapping.source.kind() == kind) {
        catalogs.insert(
          kind,
          self.source.catalog(record.actor_id, target_workspace_id, kind).await?,
        );
      }
    }

    let existing = self.manifests.list_staging_entries(record.id).await?;
    let mut entries = existing.clone();
    let mut new_keys = BTreeSet::new();
    let mut sequence = existing
      .iter()
      .map(|entry| entry.sequence)
      .max()
      .unwrap_or(-1)
      .checked_add(1)
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))?;
    let mut reused_count = 0;
    let mut created_count = 0;
    let mut plans = Vec::with_capacity(selected.len());
    let mut staged_targets = BTreeSet::new();
    for mapping in &selected {
      // Merged Tags create one envelope; every source was still read above,
      // and the complete source-to-target map remains in the durable manifest.
      if !staged_targets.insert(mapping.target.clone()) {
        continue;
      }
      let source = source_definitions
        .get(&mapping.source)
        .expect("selected source definition was loaded");
      let catalog = catalogs
        .get(&mapping.target.kind())
        .expect("reconciled resource has target catalog");
      let mapped_target = self.source.load(record.actor_id, &mapping.target).await?;
      let schema_hash = definition_schema_hash(source)?;
      let (action, target_name) = if let Some(target) = mapped_target {
        let reusable = if mapping.source.kind() == WorkspaceContentResourceKind::Tag {
          super::preflight::tag_target_is_reusable(
            &source.name,
            source.schema.get("archived").and_then(Value::as_bool).unwrap_or(false),
            &target.name,
            target.schema.get("archived").and_then(Value::as_bool).unwrap_or(false),
          )
        } else {
          normalize_name(&target.name) == normalize_name(&source.name)
            && definition_schema_hash(&target)? == schema_hash
        };
        if !reusable {
          return Err(AuthError::InvalidInput(
            WorkspaceContentErrorCode::TargetDefinitionChanged.as_str().to_string(),
          ));
        }
        reused_count += 1;
        (WorkspaceContentReconcileAction::Reuse, target.name)
      } else {
        created_count += 1;
        (
          WorkspaceContentReconcileAction::Create,
          if mapping.source.kind() == WorkspaceContentResourceKind::Tag {
            myoxus_domain::workspace_tags::WorkspaceTag::normalize_name(&source.name)
              .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().into()))?
          } else {
            available_name(&source.name, &schema_hash, catalog)?
          },
        )
      };
      let envelope = WorkspaceContentReconcileEnvelope {
        schema_version: if mapping.source.kind() == WorkspaceContentResourceKind::Tag {
          TAG_SCHEMA_VERSION
        } else {
          SCHEMA_VERSION
        },
        operation_id: record.id,
        source: mapping.source.clone(),
        target: mapping.target.clone(),
        action,
        target_name,
        schema_hash,
        reference_mappings: reference_mappings.clone(),
        nested_mappings: nested_mappings.clone(),
        payload: source.payload.clone(),
        tag_sources: if mapping.source.kind() == WorkspaceContentResourceKind::Tag {
          selected
            .iter()
            .filter(|selected| selected.target == mapping.target)
            .map(|selected| source_definitions[&selected.source].clone())
            .collect()
        } else {
          Vec::new()
        },
      };
      if mapping.source.kind() == WorkspaceContentResourceKind::Tag {
        envelope.source_tag()?;
      }
      let body = canonical_json_bytes(&envelope)?;
      plans.push((mapping.target.clone(), body));
    }

    for (target, body) in plans {
      if let Some(entry) = existing.iter().find(|entry| entry.resource == target) {
        if let Err(error) = self.verify_existing(entry, &body).await {
          self.cleanup(record, &new_keys).await;
          return Err(error);
        }
        continue;
      }
      let (entry, wrote) = match self.stage(record.id, sequence, target, Bytes::from(body)).await {
        Ok(staged) => staged,
        Err(error) => {
          self.cleanup(record, &new_keys).await;
          return Err(error);
        }
      };
      sequence = sequence.checked_add(1).ok_or_else(|| {
        AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string())
      })?;
      if wrote {
        new_keys.insert(entry.object_key().to_string());
      }
      entries.push(entry);
    }
    entries.sort_by_key(|entry| entry.sequence);
    if let Err(error) = self
      .manifests
      .store_manifest(record.id, &record.manifest_hash, &mappings, &entries)
      .await
    {
      self.cleanup(record, &new_keys).await;
      return Err(error);
    }
    for entry in entries.iter().filter(|entry| is_reconciled(entry.resource.kind())) {
      if let Err(error) = self
        .compensations
        .append_copy_compensation(WorkspaceContentCompensationIntent {
          operation_id: record.id,
          sequence: i64::from(entry.sequence),
          kind: DELETE_STAGED_OBJECT.to_string(),
          target: entry.resource.clone(),
        })
        .await
      {
        self.cleanup(record, &new_keys).await;
        return Err(error);
      }
    }
    Ok(WorkspaceContentReconcileResult {
      staged_count: entries.len() - existing.len(),
      reused_count,
      created_count,
    })
  }

  async fn stage(
    &self,
    operation_id: Uuid,
    sequence: i32,
    resource: WorkspaceContentResourceRef,
    body: Bytes,
  ) -> AuthResult<(WorkspaceContentStagingEntry, bool)> {
    let hash = sha256_hex(&body);
    let key = format!("workspace-content/{operation_id}/objects/{hash}");
    let wrote = match self.staging.read_blob(&key).await {
      Ok(stored) => {
        if let Err(error) = verify(&stored.data, &hash, body.len()) {
          if let Err(cleanup_error) = self.staging.delete_blob(&key).await {
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
            key: key.clone(),
            content_type: Some(CONTENT_TYPE.to_string()),
            body: body.clone(),
          })
          .await
        {
          if let Err(cleanup_error) = self.staging.delete_blob(&key).await {
            super::diagnostics::record_port_failure(&cleanup_error, "compensation");
          }
          return Err(port_storage(error));
        }
        let stored = match self.staging.read_blob(&key).await {
          Ok(stored) => stored,
          Err(error) => {
            if let Err(cleanup_error) = self.staging.delete_blob(&key).await {
              super::diagnostics::record_port_failure(&cleanup_error, "compensation");
            }
            return Err(port_storage(error));
          }
        };
        if let Err(error) = verify(&stored.data, &hash, body.len()) {
          if let Err(cleanup_error) = self.staging.delete_blob(&key).await {
            super::diagnostics::record_port_failure(&cleanup_error, "compensation");
          }
          return Err(error);
        }
        true
      }
      Err(error) => return Err(port_storage(error)),
    };
    let entry = WorkspaceContentStagingEntry::new(
      operation_id,
      sequence,
      resource,
      key,
      hash,
      i64::try_from(body.len())
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::BlobSizeLimit.as_str().to_string()))?,
    )
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))?;
    Ok((entry, wrote))
  }

  async fn verify_existing(&self, entry: &WorkspaceContentStagingEntry, body: &[u8]) -> AuthResult<()> {
    let stored = self.staging.read_blob(entry.object_key()).await.map_err(port_storage)?;
    verify(&stored.data, entry.content_hash(), entry.size_bytes as usize)?;
    if entry.resource.kind() == WorkspaceContentResourceKind::Tag {
      let envelope: WorkspaceContentReconcileEnvelope = serde_json::from_slice(&stored.data)
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().into()))?;
      envelope.source_tag()?;
    }
    let hash = sha256_hex(body);
    if entry.content_hash() != hash || entry.size_bytes != body.len() as i64 {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::StagingReplayConflict.as_str().to_string(),
      ));
    }
    verify(&stored.data, &hash, body.len())
  }

  async fn cleanup(&self, record: &WorkspaceContentOperationRecord, keys: &BTreeSet<String>) {
    for key in keys {
      if let Err(error) = self.staging.delete_blob(key).await {
        super::diagnostics::record_port_failure(&error, "compensation");
        super::diagnostics::record_failure(
          record,
          "compensation",
          &AuthError::Storage(WorkspaceContentErrorCode::BlobCompensationFailed.as_str().into()),
        );
      }
    }
  }
}

fn build_nested_mappings(
  operation_id: Uuid,
  mappings: &[WorkspaceContentIdMapping],
  sources: &BTreeMap<WorkspaceContentResourceRef, WorkspaceContentDefinition>,
) -> AuthResult<BTreeMap<String, String>> {
  let direct = mappings
    .iter()
    .map(|mapping| {
      (
        (mapping.source.kind(), mapping.source.resource_id().to_string()),
        mapping.target.resource_id().to_string(),
      )
    })
    .collect::<BTreeMap<_, _>>();
  let mut nested = BTreeMap::new();
  let mut database_rows = BTreeMap::<String, BTreeSet<String>>::new();
  let mut relation_targets = BTreeMap::<String, String>::new();

  for (resource, definition) in sources {
    match resource.kind() {
      WorkspaceContentResourceKind::Database => {
        let target_database = direct
          .get(&(
            WorkspaceContentResourceKind::Database,
            resource.resource_id().to_string(),
          ))
          .ok_or_else(|| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().to_string())
          })?;
        let manifest = definition
          .payload
          .get("workspaceContentIdentityManifest")
          .and_then(Value::as_object)
          .ok_or_else(|| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string())
          })?;
        for family in ["fields", "views", "rows", "rowContentDocuments"] {
          let values = manifest.get(family).and_then(Value::as_object).ok_or_else(|| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().into())
          })?;
          for source_id in values.values().filter_map(Value::as_str) {
            nested.insert(
              format!("{}:{family}:{source_id}", qualified(resource)),
              deterministic_nested_id(operation_id, target_database, family, source_id),
            );
            if family == "rows" {
              database_rows
                .entry(resource.resource_id().to_string())
                .or_default()
                .insert(source_id.to_string());
            }
          }
        }
        for source_id in manifest
          .get("rowTemplates")
          .and_then(Value::as_array)
          .into_iter()
          .flatten()
          .filter_map(Value::as_str)
        {
          nested.insert(
            format!("{}:rowTemplates:{source_id}", qualified(resource)),
            deterministic_nested_id(operation_id, target_database, "rowTemplates", source_id),
          );
        }
        for source_blob in manifest
          .get("assets")
          .and_then(Value::as_object)
          .into_iter()
          .flat_map(|assets| assets.values())
          .filter_map(Value::as_str)
        {
          let target_blob = direct
            .get(&(WorkspaceContentResourceKind::Blob, source_blob.to_string()))
            .ok_or_else(|| {
              AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().to_string())
            })?;
          nested.insert(
            format!("{}:assets:{source_blob}", qualified(resource)),
            target_blob.clone(),
          );
        }
        for relation in manifest
          .get("relationFields")
          .and_then(Value::as_array)
          .into_iter()
          .flatten()
        {
          let field_id = required_string(relation, "fieldId", WorkspaceContentErrorCode::DatabaseSnapshotInvalid)?;
          let target_database_id = required_string(
            relation,
            "targetDatabaseId",
            WorkspaceContentErrorCode::DatabaseIdentityInvalid,
          )?;
          if !direct.contains_key(&(WorkspaceContentResourceKind::Database, target_database_id.clone())) {
            return Err(AuthError::InvalidInput(
              WorkspaceContentErrorCode::RelationTargetOutsideSelection
                .as_str()
                .to_string(),
            ));
          }
          relation_targets.insert(field_id, target_database_id);
        }
        for tag in definition
          .payload
          .get("workspaceTagsManifest")
          .and_then(Value::as_array)
          .into_iter()
          .flatten()
        {
          let tag_id = required_string(tag, "id", WorkspaceContentErrorCode::SourceTagInvalid)?;
          if !direct.contains_key(&(WorkspaceContentResourceKind::Tag, tag_id)) {
            return Err(AuthError::InvalidInput(
              WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().to_string(),
            ));
          }
        }
      }
      WorkspaceContentResourceKind::Tag => {}
      _ => unreachable!("source definitions contain only reconciled resource kinds"),
    }
  }

  for (resource, definition) in sources {
    if resource.kind() != WorkspaceContentResourceKind::Database {
      continue;
    }
    let manifest = definition
      .payload
      .get("workspaceContentIdentityManifest")
      .and_then(Value::as_object)
      .expect("validated Database identity manifest");
    for relation in manifest
      .get("relationCells")
      .and_then(Value::as_array)
      .into_iter()
      .flatten()
    {
      let field_id = required_string(relation, "fieldId", WorkspaceContentErrorCode::DatabaseSnapshotInvalid)?;
      let target_database_id = relation_targets
        .get(&field_id)
        .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))?;
      let target_database = direct
        .get(&(WorkspaceContentResourceKind::Database, target_database_id.clone()))
        .expect("relation target mapping validated");
      for target_row_id in relation
        .get("targetRowIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
      {
        if !database_rows
          .get(target_database_id)
          .is_some_and(|rows| rows.contains(target_row_id))
        {
          return Err(AuthError::InvalidInput(
            WorkspaceContentErrorCode::RelationRowMissing.as_str().to_string(),
          ));
        }
        nested.insert(
          format!("database:{target_database_id}:rows:{target_row_id}"),
          deterministic_nested_id(operation_id, target_database, "rows", target_row_id),
        );
      }
    }
  }
  Ok(nested)
}

fn deterministic_nested_id(operation_id: Uuid, target_database_id: &str, family: &str, source_id: &str) -> String {
  Uuid::new_v5(
    &operation_id,
    format!("{target_database_id}:{family}:{source_id}").as_bytes(),
  )
  .to_string()
}

fn available_name(
  source_name: &str,
  source_schema_hash: &str,
  catalog: &[WorkspaceContentDefinition],
) -> AuthResult<String> {
  let clean = source_name.split_whitespace().collect::<Vec<_>>().join(" ");
  let normalized = normalize_name(&clean);
  let names = catalog
    .iter()
    .map(|definition| normalize_name(&definition.name))
    .collect::<BTreeSet<_>>();
  if !names.contains(&normalized) {
    return Ok(clean);
  }
  if catalog.iter().any(|definition| {
    normalize_name(&definition.name) == normalized
      && definition_schema_hash(definition).ok().as_deref() == Some(source_schema_hash)
  }) {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string(),
    ));
  }
  for suffix in 2..=10_000 {
    let candidate = format!("{clean} ({suffix})");
    if !names.contains(&normalize_name(&candidate)) {
      return Ok(candidate);
    }
  }
  Err(AuthError::InvalidInput(
    WorkspaceContentErrorCode::TargetDefinitionChanged.as_str().to_string(),
  ))
}

fn canonical_hash(value: &Value) -> AuthResult<String> {
  canonical_json_bytes(value).map(|bytes| sha256_hex(&bytes))
}

fn canonical_json_bytes<T: Serialize>(value: &T) -> AuthResult<Vec<u8>> {
  let value = serde_json::to_value(value)
    .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::EncodingFailed.as_str().to_string()))?;
  serde_json::to_vec(&canonicalize_json(value))
    .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::EncodingFailed.as_str().to_string()))
}

fn canonicalize_json(value: Value) -> Value {
  match value {
    Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_json).collect()),
    Value::Object(values) => Value::Object(
      values
        .into_iter()
        .map(|(key, value)| (key, canonicalize_json(value)))
        .collect::<BTreeMap<_, _>>()
        .into_iter()
        .collect(),
    ),
    value => value,
  }
}

pub(crate) fn definition_schema_hash(definition: &WorkspaceContentDefinition) -> AuthResult<String> {
  let mut schema = definition.schema.clone();
  if definition.resource.kind() == WorkspaceContentResourceKind::Database {
    normalize_external_database_ids(&mut schema);
  }
  canonical_hash(&schema)
}

fn normalize_external_database_ids(value: &mut Value) {
  match value {
    Value::Array(values) => {
      for value in values {
        normalize_external_database_ids(value);
      }
    }
    Value::Object(values) => {
      for (key, value) in values {
        if key == "targetDatabaseId" && value.as_str().is_some_and(|id| id != "database_0") {
          *value = Value::String("external_database".to_string());
        } else {
          normalize_external_database_ids(value);
        }
      }
    }
    _ => {}
  }
}

fn normalize_name(value: &str) -> String {
  value.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn is_reconciled(kind: WorkspaceContentResourceKind) -> bool {
  matches!(
    kind,
    WorkspaceContentResourceKind::Database | WorkspaceContentResourceKind::Tag
  )
}

fn qualified(resource: &WorkspaceContentResourceRef) -> String {
  format!(
    "{}:{}:{}",
    resource.workspace_id(),
    resource.kind().as_str(),
    resource.resource_id()
  )
}

fn required_string(value: &Value, key: &str, cause: WorkspaceContentErrorCode) -> AuthResult<String> {
  value
    .get(key)
    .and_then(Value::as_str)
    .filter(|value| !value.trim().is_empty())
    .map(str::to_string)
    .ok_or_else(|| AuthError::InvalidInput(cause.as_str().into()))
}

fn parse_uuid(value: &str, cause: WorkspaceContentErrorCode) -> AuthResult<Uuid> {
  Uuid::parse_str(value).map_err(|_| AuthError::InvalidInput(cause.as_str().into()))
}

fn verify(data: &[u8], hash: &str, size: usize) -> AuthResult<()> {
  if data.len() != size || sha256_hex(data) != hash {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::StagingReplayConflict.as_str().to_string(),
    ));
  }
  Ok(())
}

fn sha256_hex(data: &[u8]) -> String {
  hex::encode(Sha256::digest(data))
}

fn port_storage(error: PortError) -> AuthError {
  super::diagnostics::record_port_failure(&error, "catalog_reconciliation");
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
  use std::sync::atomic::{AtomicUsize, Ordering};

  use chrono::Utc;
  use myoxus_domain::workspace_content_operation::{
    WorkspaceContentIdMapping, WorkspaceContentOperationKind, WorkspaceContentOperationStatus,
  };

  use super::*;
  use crate::ports::{
    BlobReadResponse, MultipartCompleteRequest, MultipartCreateRequest, MultipartCreateResponse,
    MultipartPartUrlRequest, MultipartPartUrlResponse, PortResult,
  };

  #[derive(Default)]
  struct Repository {
    mappings: Mutex<Vec<WorkspaceContentIdMapping>>,
    entries: Mutex<Vec<WorkspaceContentStagingEntry>>,
    compensations: Mutex<Vec<WorkspaceContentCompensationIntent>>,
  }

  #[async_trait]
  impl WorkspaceContentStagingManifestRepository for Repository {
    async fn store_manifest(
      &self,
      _operation_id: Uuid,
      _manifest_hash: &str,
      mappings: &[WorkspaceContentIdMapping],
      entries: &[WorkspaceContentStagingEntry],
    ) -> AuthResult<()> {
      let durable = self.entries.lock().unwrap();
      for entry in durable.iter() {
        if !entries.contains(entry) {
          return Err(AuthError::InvalidInput("staging prefix omitted".to_string()));
        }
      }
      drop(durable);
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

  #[async_trait]
  impl WorkspaceContentCopyCompensationPort for Repository {
    async fn append_copy_compensation(&self, intent: WorkspaceContentCompensationIntent) -> AuthResult<bool> {
      let mut intents = self.compensations.lock().unwrap();
      if intents.contains(&intent) {
        return Ok(false);
      }
      intents.push(intent);
      Ok(true)
    }
  }

  #[derive(Default)]
  struct Source {
    definitions: Mutex<BTreeMap<WorkspaceContentResourceRef, WorkspaceContentDefinition>>,
  }

  #[async_trait]
  impl WorkspaceContentReconcileSourcePort for Source {
    async fn load(
      &self,
      _actor_id: Uuid,
      resource: &WorkspaceContentResourceRef,
    ) -> AuthResult<Option<WorkspaceContentDefinition>> {
      Ok(self.definitions.lock().unwrap().get(resource).cloned())
    }

    async fn catalog(
      &self,
      _actor_id: Uuid,
      workspace_id: Uuid,
      kind: WorkspaceContentResourceKind,
    ) -> AuthResult<Vec<WorkspaceContentDefinition>> {
      Ok(
        self
          .definitions
          .lock()
          .unwrap()
          .values()
          .filter(|definition| definition.resource.workspace_id() == workspace_id && definition.resource.kind() == kind)
          .cloned()
          .collect(),
      )
    }
  }

  #[derive(Default)]
  struct Storage {
    objects: Mutex<BTreeMap<String, Bytes>>,
    writes: AtomicUsize,
  }

  #[async_trait]
  impl BlobStoragePort for Storage {
    async fn write_blob(&self, request: BlobWriteRequest) -> PortResult<()> {
      self.writes.fetch_add(1, Ordering::SeqCst);
      self.objects.lock().unwrap().insert(request.key, request.body);
      Ok(())
    }

    async fn read_blob(&self, key: &str) -> PortResult<BlobReadResponse> {
      self
        .objects
        .lock()
        .unwrap()
        .get(key)
        .cloned()
        .map(|data| BlobReadResponse {
          key: key.to_string(),
          content_type: Some(CONTENT_TYPE.to_string()),
          content_length: data.len() as u64,
          data,
          last_modified: None,
        })
        .ok_or_else(|| PortError::NotFound("object".to_string()))
    }

    async fn delete_blob(&self, key: &str) -> PortResult<()> {
      self.objects.lock().unwrap().remove(key);
      Ok(())
    }

    async fn put_avatar(&self, _key: &str, _data: Bytes, _content_type: &str) -> PortResult<String> {
      unreachable!()
    }

    async fn get_avatar(&self, _key: &str) -> PortResult<BlobReadResponse> {
      unreachable!()
    }

    async fn delete_avatar(&self, _key: &str) -> PortResult<()> {
      unreachable!()
    }

    async fn create_multipart_upload(&self, _request: MultipartCreateRequest) -> PortResult<MultipartCreateResponse> {
      unreachable!()
    }

    async fn create_multipart_part_url(
      &self,
      _request: MultipartPartUrlRequest,
    ) -> PortResult<MultipartPartUrlResponse> {
      unreachable!()
    }

    async fn complete_multipart_upload(&self, _request: MultipartCompleteRequest) -> PortResult<()> {
      unreachable!()
    }

    async fn abort_multipart_upload(&self, _upload_id: Uuid) -> PortResult<()> {
      unreachable!()
    }
  }

  fn resource(
    workspace_id: Uuid,
    kind: WorkspaceContentResourceKind,
    id: impl Into<String>,
  ) -> WorkspaceContentResourceRef {
    WorkspaceContentResourceRef::new(workspace_id, kind, id).unwrap()
  }

  fn definition(
    resource: WorkspaceContentResourceRef,
    name: &str,
    mut schema: Value,
    mut payload: Value,
  ) -> WorkspaceContentDefinition {
    if resource.kind() == WorkspaceContentResourceKind::Tag {
      let archived = schema.get("archived").and_then(Value::as_bool).unwrap_or(false);
      schema["archived"] = Value::Bool(archived);
      let now = Utc::now();
      let mut canonical = serde_json::json!({
        "id": resource.resource_id(), "workspace_id": resource.workspace_id(),
        "name": name, "slug": myoxus_domain::workspace_tags::WorkspaceTag::slug_base(name).unwrap(),
        "color_role": schema.get("colorRole").and_then(Value::as_str).unwrap_or("tag.blue"),
        "description": null, "archived_at": archived.then_some(now),
        "created_at": now, "updated_at": now, "created_by": null, "updated_by": null,
      });
      canonical
        .as_object_mut()
        .unwrap()
        .extend(payload.as_object().unwrap().clone());
      payload = canonical;
    }
    WorkspaceContentDefinition {
      resource,
      name: name.into(),
      schema,
      payload,
    }
  }

  fn fixture() -> (
    WorkspaceContentOperationRecord,
    Arc<Repository>,
    Arc<Source>,
    Arc<Storage>,
    Vec<WorkspaceContentIdMapping>,
  ) {
    let source_workspace = Uuid::new_v4();
    let target_workspace = Uuid::new_v4();
    let operation = WorkspaceContentOperationRecord {
      id: Uuid::new_v4(),
      idempotency_id: Uuid::new_v4(),
      actor_id: Uuid::new_v4(),
      kind: WorkspaceContentOperationKind::Copy,
      source_workspace_id: source_workspace,
      target_workspace_id: Some(target_workspace),
      status: WorkspaceContentOperationStatus::Running,
      preview_revision: Some("preview".to_string()),
      manifest_hash: "a".repeat(64),
      error: None,
      diagnostic_instance_id: None,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    };
    let mappings = [
      (
        WorkspaceContentResourceKind::Database,
        Uuid::new_v4().to_string(),
        Uuid::new_v4().to_string(),
      ),
      (
        WorkspaceContentResourceKind::Tag,
        Uuid::new_v4().to_string(),
        Uuid::new_v4().to_string(),
      ),
      (
        WorkspaceContentResourceKind::Document,
        "document-source".to_string(),
        "document-target".to_string(),
      ),
      (
        WorkspaceContentResourceKind::Blob,
        "blob-source".to_string(),
        "blob-target".to_string(),
      ),
    ]
    .into_iter()
    .map(|(kind, source, target)| {
      WorkspaceContentIdMapping::new(
        resource(source_workspace, kind, source),
        resource(target_workspace, kind, target),
      )
      .unwrap()
    })
    .collect::<Vec<_>>();
    let repository = Arc::new(Repository {
      mappings: Mutex::new(mappings.clone()),
      ..Repository::default()
    });
    (
      operation,
      repository,
      Arc::new(Source::default()),
      Arc::new(Storage::default()),
      mappings,
    )
  }

  fn decode(storage: &Storage) -> Vec<WorkspaceContentReconcileEnvelope> {
    storage
      .objects
      .lock()
      .unwrap()
      .values()
      .map(|bytes| serde_json::from_slice(bytes).unwrap())
      .collect()
  }

  #[test]
  fn canonical_json_ignores_object_insertion_order() {
    let left = serde_json::json!({
      "z": [{"beta": 2, "alpha": 1}],
      "a": {"second": true, "first": false}
    });
    let right: Value =
      serde_json::from_str(r#"{"a":{"first":false,"second":true},"z":[{"alpha":1,"beta":2}]}"#).unwrap();

    assert_eq!(
      canonical_json_bytes(&left).unwrap(),
      canonical_json_bytes(&right).unwrap()
    );
    assert_eq!(canonical_hash(&left).unwrap(), canonical_hash(&right).unwrap());
  }

  #[tokio::test]
  async fn reconcile_stages_every_resource_losslessly_and_replays_without_writes() {
    let (operation, repository, source, storage, mappings) = fixture();
    let source_database_id = mappings
      .iter()
      .find(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Database)
      .unwrap()
      .source
      .resource_id()
      .to_string();
    let source_blob_id = mappings
      .iter()
      .find(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Blob)
      .unwrap()
      .source
      .resource_id()
      .to_string();
    let relation_field_id = Uuid::new_v4().to_string();
    let relation_row_id = Uuid::new_v4().to_string();
    {
      let mut definitions = source.definitions.lock().unwrap();
      for mapping in &mappings {
        if !is_reconciled(mapping.source.kind()) {
          continue;
        }
        let (name, schema, payload) = match mapping.source.kind() {
          WorkspaceContentResourceKind::Database => (
            "Projects",
            serde_json::json!({"fields": ["status"], "relations": ["inside"]}),
            serde_json::json!({
              "unknownFutureField": {"retained": true},
              "rows": [{"id": "row-1"}],
              "workspaceContentIdentityManifest": {
                "fields": {"field_0": relation_field_id},
                "views": {},
                "rows": {"row_0": relation_row_id},
                "rowContentDocuments": {},
                "rowTemplates": [],
                "assets": {"asset_0": source_blob_id},
                "relationFields": [{
                  "fieldId": relation_field_id,
                  "targetDatabaseId": source_database_id
                }],
                "relationCells": [{
                  "rowId": relation_row_id,
                  "fieldId": relation_field_id,
                  "targetRowIds": [relation_row_id]
                }]
              }
            }),
          ),
          WorkspaceContentResourceKind::Tag => (
            "Release Ready",
            serde_json::json!({"colorRole": "tag.green"}),
            serde_json::json!({"id": mapping.source.resource_id(), "future": "preserved"}),
          ),
          _ => unreachable!("non-reconciled mappings were filtered"),
        };
        definitions.insert(
          mapping.source.clone(),
          definition(mapping.source.clone(), name, schema.clone(), payload),
        );
        if mapping.source.kind() == WorkspaceContentResourceKind::Tag {
          let conflicting_tag = resource(
            operation.target_workspace_id.unwrap(),
            WorkspaceContentResourceKind::Tag,
            Uuid::new_v4().to_string(),
          );
          definitions.insert(
            conflicting_tag.clone(),
            definition(
              conflicting_tag,
              "Release Ready",
              serde_json::json!({"colorRole": "tag.red"}),
              serde_json::json!({}),
            ),
          );
        }
      }
    }
    let executor =
      WorkspaceContentReconcileExecutor::new(repository.clone(), repository.clone(), source, storage.clone());
    let first = executor.reconcile(&operation).await.unwrap();
    let replay = executor.reconcile(&operation).await.unwrap();

    assert_eq!(first.staged_count, 2);
    assert_eq!(first.created_count, 2);
    assert_eq!(replay.staged_count, 0);
    assert_eq!(storage.writes.load(Ordering::SeqCst), 2);
    let envelopes = decode(&storage);
    assert!(envelopes.iter().all(|envelope| envelope.reference_mappings.len() == 4));
    assert!(envelopes.iter().all(|envelope| envelope.nested_mappings.len() >= 4));
    assert!(envelopes.iter().any(|envelope| envelope.target_name == "Release Ready"));
    assert!(
      envelopes
        .iter()
        .any(|envelope| envelope.payload.pointer("/unknownFutureField/retained") == Some(&Value::Bool(true)))
    );
  }

  #[tokio::test]
  async fn reconcile_merges_same_name_tags_and_preserves_target_metadata() {
    let (operation, repository, source, storage, mappings) = fixture();
    let mapping = mappings
      .iter()
      .find(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Tag)
      .unwrap()
      .clone();
    *repository.mappings.lock().unwrap() = vec![mapping.clone()];
    let schema = serde_json::json!({"colorRole": "tag.green", "archived": false});
    source.definitions.lock().unwrap().extend([
      (
        mapping.source.clone(),
        definition(
          mapping.source,
          "Ready",
          schema.clone(),
          serde_json::json!({"source": true}),
        ),
      ),
      (
        mapping.target.clone(),
        definition(
          mapping.target.clone(),
          " ready ",
          serde_json::json!({"colorRole": "tag.red"}),
          serde_json::json!({"target": true}),
        ),
      ),
    ]);
    let historical = resource(
      operation.source_workspace_id,
      WorkspaceContentResourceKind::Tag,
      Uuid::new_v4().to_string(),
    );
    repository
      .mappings
      .lock()
      .unwrap()
      .push(WorkspaceContentIdMapping::new(historical.clone(), mapping.target.clone()).unwrap());
    source.definitions.lock().unwrap().insert(
      historical.clone(),
      definition(
        historical,
        "READY",
        serde_json::json!({"colorRole":"tag.blue", "archived":true}),
        serde_json::json!({}),
      ),
    );
    let before = source.definitions.lock().unwrap().clone();
    let executor =
      WorkspaceContentReconcileExecutor::new(repository.clone(), repository.clone(), source.clone(), storage.clone());

    let result = executor.reconcile(&operation).await.unwrap();
    assert_eq!(result.reused_count, 1);
    let envelopes = decode(&storage);
    assert_eq!(envelopes.len(), 1, "converging classifications stage once");
    assert_eq!(envelopes[0].action, WorkspaceContentReconcileAction::Reuse);
    assert_eq!(envelopes[0].tag_sources.len(), 2);
    assert_eq!(envelopes[0].target_name, " ready ");
    assert!(envelopes[0].source_tag().is_ok());
    executor.reconcile(&operation).await.unwrap();
    assert_eq!(storage.writes.load(Ordering::SeqCst), 1, "replay adds no object");
    assert_eq!(
      *source.definitions.lock().unwrap(),
      before,
      "source and target catalogs are read-only"
    );
  }

  #[tokio::test]
  async fn reconcile_rejects_an_archived_target_for_an_active_source_without_partial_staging() {
    let (operation, repository, source, storage, mappings) = fixture();
    let mapping = mappings
      .iter()
      .find(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Tag)
      .unwrap()
      .clone();
    *repository.mappings.lock().unwrap() = vec![mapping.clone()];
    source.definitions.lock().unwrap().extend([
      (
        mapping.source.clone(),
        definition(
          mapping.source,
          "Ready",
          serde_json::json!({"colorRole": "tag.green"}),
          serde_json::json!({}),
        ),
      ),
      (
        mapping.target.clone(),
        definition(
          mapping.target,
          "Ready",
          serde_json::json!({"colorRole": "tag.red", "archived": true}),
          serde_json::json!({}),
        ),
      ),
    ]);
    let executor =
      WorkspaceContentReconcileExecutor::new(repository.clone(), repository.clone(), source, storage.clone());

    assert!(matches!(
      executor.reconcile(&operation).await,
      Err(AuthError::InvalidInput(message)) if message == WorkspaceContentErrorCode::TargetDefinitionChanged.as_str()
    ));
    assert!(repository.entries.lock().unwrap().is_empty());
    assert!(storage.objects.lock().unwrap().is_empty());
  }
}
