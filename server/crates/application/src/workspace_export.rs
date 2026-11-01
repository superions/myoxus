// SPDX-License-Identifier: AGPL-3.0-or-later
//! Server-owned workspace interchange exports.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Cursor, Read, Write};
use std::sync::Arc;

use async_trait::async_trait;
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::entities::{DocumentMetadataFieldValue, DocumentMetadataProjection, DocumentMetadataSource};
use myoxus_domain::permission::WorkspaceAction;
use myoxus_domain::workspace_tags::{WorkspaceTagDocumentAssignment, WorkspaceTagRepository};
use myoxus_workspace_import::{ArchiveError, ArchiveLimits, inspect_zip_bytes};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};
use crate::doc::DocService;
use crate::document_metadata::{DocumentMetadataProjectionMode, DocumentMetadataService};
use crate::git_sync::projection;
use crate::markdown::{
  AuthorizedMarkdownBatchDocument, AuthorizedMarkdownDocument, MarkdownBatchReferenceInventory,
  MarkdownProjectionPolicy, project_document_in_batch_with_images,
};
use crate::organizer::OrganizerService;
use crate::permission::{AccessController, PermissionService, WorkspaceResource};
use crate::ports::blob_service::BlobService;
use crate::workspace::WorkspaceStore;
use crate::workspace_path::{PathPlanItem, WorkspacePathPlanError, is_safe_relative_path, plan_workspace_paths};

const MAX_EXPORT_DOCUMENTS: i64 = 10_000;
const MAX_EXPORT_BLOBS: i64 = 10_000;
const MAX_EXPORT_UNCOMPRESSED_BYTES: usize = 512 * 1024 * 1024;
const MAX_RECOVERY_COMPRESSION_RATIO: u64 = 1_000;
const MAX_RECOVERY_PATH_BYTES: usize = 1_024;
const RECOVERY_ARCHIVE_PATH: &str = ".myoxus-recovery/sources.zip";
const LOSS_REPORT_PATH: &str = "myoxus-export-report.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceExportProvenance {
  pub kind: String,
  pub source_path: String,
  pub target_id: String,
}

#[async_trait]
pub trait WorkspaceExportProvenancePort: Send + Sync {
  async fn latest_obsidian_provenance(&self, workspace_id: Uuid) -> AuthResult<Vec<WorkspaceExportProvenance>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultExportEntryReport {
  pub path: String,
  pub sha256: String,
  pub size_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultExportDocumentFinding {
  pub document_id: Uuid,
  pub path: String,
  pub diagnostic_codes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianVaultExportReport {
  pub format: String,
  pub workspace_id: Uuid,
  pub workspace_wide_atomic_snapshot: bool,
  pub documents: Vec<VaultExportEntryReport>,
  pub assets: Vec<VaultExportEntryReport>,
  pub empty_folders: Vec<String>,
  pub recovery_archive: Option<VaultExportEntryReport>,
  pub recovery_sources: Vec<VaultExportEntryReport>,
  pub partial_documents: Vec<VaultExportDocumentFinding>,
  pub consistency_note: String,
  pub backup_warning: String,
}

#[derive(Debug, Clone)]
pub struct ObsidianVaultExportArtifact {
  pub filename: String,
  pub bytes: Vec<u8>,
  pub report: ObsidianVaultExportReport,
}

#[derive(Debug, Error)]
pub enum WorkspaceExportError {
  #[error(transparent)]
  Authorization(#[from] AuthError),
  #[error("workspace not found")]
  WorkspaceNotFound,
  #[error("workspace export exceeds the supported document or blob inventory limit")]
  InventoryLimit,
  #[error("required export content is missing: {0}")]
  MissingContent(String),
  #[error("workspace path planning failed: {0}")]
  Path(#[from] WorkspacePathPlanError),
  #[error("document projection failed")]
  Projection,
  #[error("archive creation failed")]
  Archive,
  #[error("workspace export exceeds the {MAX_EXPORT_UNCOMPRESSED_BYTES}-byte uncompressed limit")]
  OutputLimit,
}

#[derive(Clone)]
pub struct ObsidianVaultExportService {
  permissions: Arc<PermissionService>,
  workspaces: Arc<dyn WorkspaceStore>,
  documents: DocService,
  metadata: Arc<DocumentMetadataService>,
  tags: Arc<dyn WorkspaceTagRepository>,
  blobs: Arc<BlobService>,
  provenance: Arc<dyn WorkspaceExportProvenancePort>,
}

impl ObsidianVaultExportService {
  pub fn new(
    permissions: Arc<PermissionService>,
    workspaces: Arc<dyn WorkspaceStore>,
    documents: DocService,
    metadata: Arc<DocumentMetadataService>,
    tags: Arc<dyn WorkspaceTagRepository>,
    blobs: Arc<BlobService>,
    provenance: Arc<dyn WorkspaceExportProvenancePort>,
  ) -> Self {
    Self {
      permissions,
      workspaces,
      documents,
      metadata,
      tags,
      blobs,
      provenance,
    }
  }

  /// Capture each document and blob once, then serialize only from that
  /// operation-local snapshot. Authorization is checked both before capture
  /// and immediately before the bytes are released.
  #[tracing::instrument(skip(self), fields(%actor_id, %workspace_id))]
  pub async fn export(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
  ) -> Result<ObsidianVaultExportArtifact, WorkspaceExportError> {
    self.assert_export(actor_id, workspace_id).await?;
    let workspace = self
      .workspaces
      .get_workspace(workspace_id)
      .await?
      .ok_or(WorkspaceExportError::WorkspaceNotFound)?;
    let documents = self
      .documents
      .list_content_docs_in_workspace(workspace_id, MAX_EXPORT_DOCUMENTS + 1)
      .await?;
    if documents.len() as i64 > MAX_EXPORT_DOCUMENTS {
      return Err(WorkspaceExportError::InventoryLimit);
    }
    let documents = documents
      .into_iter()
      .filter(|document| !document.is_workspace_root && !document.external_id.starts_with("db$"))
      .collect::<Vec<_>>();
    self
      .assert_documents_readable(actor_id, workspace_id, &documents)
      .await?;
    let organizer = OrganizerService::new(self.documents.clone())
      .snapshot(workspace_id)
      .await
      .map_err(|_| WorkspaceExportError::MissingContent("Organizer snapshot".into()))?;
    let blobs = self
      .blobs
      .list_workspace_blobs(workspace_id, MAX_EXPORT_BLOBS + 1, 0, false)
      .await?;
    if blobs.len() as i64 > MAX_EXPORT_BLOBS {
      return Err(WorkspaceExportError::InventoryLimit);
    }
    assert_blob_inventory_limit(&blobs)?;
    let document_keys = documents
      .iter()
      .map(|document| DocumentKey::parse(&document.external_id))
      .collect::<Result<Vec<_>, _>>()
      .map_err(|_| WorkspaceExportError::Projection)?;
    let (tag_catalog, tag_assignments) = self
      .tags
      .export_tags(workspace_id, &document_keys, MAX_EXPORT_UNCOMPRESSED_BYTES as u64)
      .await
      .map_err(|_| WorkspaceExportError::MissingContent("document tags".into()))?;
    let tags_by_document = current_tags_by_document(&document_keys, tag_catalog, tag_assignments)?;
    let provenance = self.provenance.latest_obsidian_provenance(workspace_id).await?;
    let source_by_target = provenance
      .into_iter()
      .filter(|entry| entry.kind == "asset")
      .map(|entry| (entry.target_id, entry.source_path))
      .collect::<HashMap<_, _>>();

    let document_ids_by_external_key = documents
      .iter()
      .map(|document| (document.external_id.clone(), document.id))
      .collect();
    let organizer_projection = projection::project_organizer(&organizer, &document_ids_by_external_key);
    let mut captured = Vec::with_capacity(documents.len());
    let mut referenced_blob_keys = BTreeSet::new();
    for document in documents {
      let payload = self.documents.load_full_doc(workspace_id, document.id).await?;
      if payload.is_empty() {
        return Err(WorkspaceExportError::MissingContent(format!(
          "document {}",
          document.id
        )));
      }
      for reference in yjs::extract_portable_asset_references(&payload).map_err(|_| WorkspaceExportError::Projection)? {
        referenced_blob_keys.insert(reference.source_key);
      }
      let placement = organizer_projection
        .documents
        .get(&document.id)
        .cloned()
        .unwrap_or_default();
      let preferred_path = preferred_document_path(
        &document.meta,
        &document.title,
        placement
          .organizer_entry_id
          .is_some()
          .then_some(placement.folder_names.as_slice()),
      );
      let metadata = self
        .metadata
        .get_projection(document.id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
        .await
        .map_err(|_| WorkspaceExportError::MissingContent(format!("document metadata {}", document.id)))?;
      let canonical_tags = tags_by_document.get(&document.external_id).cloned().unwrap_or_default();
      let (canonical_properties, canonical_property_keys) = canonical_metadata_properties(&metadata);
      captured.push(CapturedDocument {
        id: document.id,
        external_id: document.external_id,
        title: document.title,
        meta: document.meta,
        canonical_properties,
        canonical_property_keys,
        canonical_tags,
        payload,
        preferred_path,
      });
    }

    let blob_metadata = blobs
      .into_iter()
      .map(|blob| (blob.key.clone(), blob))
      .collect::<BTreeMap<_, _>>();
    for key in &referenced_blob_keys {
      if !blob_metadata.contains_key(key) {
        return Err(WorkspaceExportError::MissingContent(format!("blob {key}")));
      }
    }

    let mut path_items = captured
      .iter()
      .map(|document| PathPlanItem {
        id: document.id,
        preferred_path: safe_markdown_path(&document.preferred_path, document.id),
        existing_path: None,
      })
      .collect::<Vec<_>>();
    for key in &referenced_blob_keys {
      let metadata = blob_metadata.get(key).expect("referenced blob inventory was checked");
      let preferred = source_by_target
        .get(key)
        .filter(|path| is_safe_relative_path(path) && !path.eq_ignore_ascii_case(LOSS_REPORT_PATH))
        .cloned()
        .unwrap_or_else(|| portable_markdown_asset_path(key, &metadata.mime));
      path_items.push(PathPlanItem {
        id: metadata.blob_id,
        preferred_path: preferred,
        existing_path: None,
      });
    }
    let planned = plan_workspace_paths(&path_items, &BTreeMap::new(), true)?;
    let paths = planned
      .into_iter()
      .map(|path| (path.id, path.path))
      .collect::<HashMap<_, _>>();
    let asset_paths = referenced_blob_keys
      .iter()
      .map(|key| {
        let metadata = blob_metadata.get(key).expect("referenced blob inventory was checked");
        (key.clone(), paths[&metadata.blob_id].clone())
      })
      .collect::<HashMap<_, _>>();

    let authorized = captured
      .iter()
      .map(|document| AuthorizedMarkdownDocument {
        external_id: document.external_id.clone(),
        title: document.title.clone(),
      })
      .collect::<Vec<_>>();
    let batch = captured
      .iter()
      .map(|document| AuthorizedMarkdownBatchDocument {
        external_id: document.external_id.clone(),
        title: document.title.clone(),
        path: paths[&document.id].clone(),
      })
      .collect::<Vec<_>>();
    let references = MarkdownBatchReferenceInventory::new_with_authorized(
      &format!("https://workspace.invalid/workspace/{workspace_id}"),
      authorized,
      batch,
    )
    .and_then(|references| {
      references.prepare_export_snapshots(
        captured
          .iter()
          .map(|document| (document.external_id.clone(), document.payload.clone()))
          .collect(),
      )
    })
    .map_err(|_| WorkspaceExportError::Projection)?;

    let mut entries = BTreeMap::<String, Vec<u8>>::new();
    let mut document_reports = Vec::with_capacity(captured.len());
    let mut partial_documents = Vec::new();
    for document in &captured {
      let path = paths[&document.id].clone();
      let lookup = references
        .references
        .for_source(&path)
        .map_err(|_| WorkspaceExportError::Projection)?;
      let projection = project_document_in_batch_with_images(
        &references.snapshots[&document.external_id],
        &document.title,
        MarkdownProjectionPolicy::default(),
        &lookup,
        &|source| {
          asset_paths
            .get(source)
            .and_then(|target| lookup.resolve_export_asset_path(target))
        },
      )
      .map_err(|_| WorkspaceExportError::Projection)?;
      let contents = compose_obsidian_markdown(
        &document.meta,
        &document.canonical_properties,
        &document.canonical_property_keys,
        &document.canonical_tags,
        &projection.markdown,
      )?;
      document_reports.push(entry_report(&path, &contents));
      if projection.partial || !projection.diagnostics.is_empty() {
        partial_documents.push(VaultExportDocumentFinding {
          document_id: document.id,
          path: path.clone(),
          diagnostic_codes: projection
            .diagnostics
            .iter()
            .map(|diagnostic| format!("{:?}", diagnostic.code))
            .collect(),
        });
      }
      insert_entry(&mut entries, path, contents)?;
    }

    let mut asset_reports = Vec::new();
    let mut blob_bytes = BTreeMap::new();
    for (key, metadata) in &blob_metadata {
      let bytes = self.blobs.get_blob(workspace_id, key).await?.data.to_vec();
      if bytes.len() != metadata.size as usize {
        return Err(WorkspaceExportError::MissingContent(format!("blob {key} size")));
      }
      blob_bytes.insert(key.clone(), bytes);
    }
    for key in &referenced_blob_keys {
      let metadata = &blob_metadata[key];
      let path = paths[&metadata.blob_id].clone();
      let bytes = blob_bytes[key].clone();
      asset_reports.push(entry_report(&path, &bytes));
      insert_entry(&mut entries, path, bytes)?;
    }

    let recovery_budget = remaining_export_bytes(&entries)?;
    let recovery = build_recovery_archive(
      &blob_metadata,
      &blob_bytes,
      &referenced_blob_keys,
      &source_by_target,
      recovery_budget,
    )?;
    let recovery_report = recovery
      .as_ref()
      .map(|archive| entry_report(RECOVERY_ARCHIVE_PATH, &archive.bytes));
    let recovery_sources = recovery
      .as_ref()
      .map(|archive| archive.entries.clone())
      .unwrap_or_default();
    if let Some(archive) = recovery {
      insert_entry(&mut entries, RECOVERY_ARCHIVE_PATH.to_string(), archive.bytes)?;
    }
    let empty_folders = empty_folder_paths(workspace_id, &organizer_projection.folders, entries.keys())?;
    let report = ObsidianVaultExportReport {
      format: "obsidian-vault".to_string(),
      workspace_id,
      workspace_wide_atomic_snapshot: false,
      documents: document_reports,
      assets: asset_reports,
      empty_folders: empty_folders.clone(),
      recovery_archive: recovery_report,
      recovery_sources,
      partial_documents,
      consistency_note: "Each document is captured once from its current snapshot plus tail; concurrent edits across different documents are not one atomic workspace snapshot.".to_string(),
      backup_warning: "This ZIP is document interchange, not a Myoxus backup; memberships, permissions, audit history, comments and server configuration are excluded.".to_string(),
    };
    let report_bytes = serde_json::to_vec_pretty(&report).map_err(|_| WorkspaceExportError::Archive)?;
    insert_entry(&mut entries, LOSS_REPORT_PATH.to_string(), report_bytes)?;
    let bytes = write_zip(&entries, &empty_folders)?;
    self.assert_export(actor_id, workspace_id).await?;
    self
      .assert_documents_readable_from_ids(
        actor_id,
        workspace_id,
        &captured.iter().map(|document| document.id).collect::<Vec<_>>(),
      )
      .await?;
    Ok(ObsidianVaultExportArtifact {
      filename: format!("{}.obsidian.zip", portable_segment(&workspace.name)),
      bytes,
      report,
    })
  }

  async fn assert_export(&self, actor_id: Uuid, workspace_id: Uuid) -> Result<(), WorkspaceExportError> {
    self
      .permissions
      .assert(
        &WorkspaceResource {
          user_id: actor_id,
          workspace_id,
        },
        WorkspaceAction::BlobsList,
      )
      .await?;
    Ok(())
  }

  async fn assert_documents_readable(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    documents: &[myoxus_domain::entities::Doc],
  ) -> Result<(), WorkspaceExportError> {
    self
      .assert_documents_readable_from_ids(
        actor_id,
        workspace_id,
        &documents.iter().map(|document| document.id).collect::<Vec<_>>(),
      )
      .await
  }

  async fn assert_documents_readable_from_ids(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    document_ids: &[Uuid],
  ) -> Result<(), WorkspaceExportError> {
    let readable = self
      .permissions
      .readable_doc_ids(actor_id, workspace_id, document_ids)
      .await?;
    if readable.len() != document_ids.len() {
      return Err(WorkspaceExportError::Authorization(AuthError::ActionForbidden));
    }
    Ok(())
  }
}

struct CapturedDocument {
  id: Uuid,
  external_id: String,
  title: String,
  meta: serde_json::Value,
  canonical_properties: BTreeMap<String, serde_json::Value>,
  canonical_property_keys: BTreeSet<String>,
  canonical_tags: Vec<String>,
  payload: Vec<u8>,
  preferred_path: String,
}

fn document_source_path(meta: &serde_json::Value) -> Option<String> {
  let path = meta.pointer("/obsidian/sourcePath")?.as_str()?.trim();
  (is_safe_relative_path(path) && path.to_ascii_lowercase().ends_with(".md")).then(|| path.to_string())
}

fn preferred_document_path(meta: &serde_json::Value, title: &str, current_folders: Option<&[String]>) -> String {
  let source_path = document_source_path(meta);
  let filename = source_path
    .as_deref()
    .and_then(|path| path.rsplit('/').next())
    .map(str::to_string)
    .unwrap_or_else(|| format!("{}.md", portable_segment(title)));
  match current_folders {
    Some(folders) => {
      let mut segments = folders.iter().map(|name| portable_segment(name)).collect::<Vec<_>>();
      segments.push(filename);
      segments.join("/")
    }
    None => source_path.unwrap_or(filename),
  }
}

fn safe_markdown_path(path: &str, id: Uuid) -> String {
  if is_safe_relative_path(path) && path.to_ascii_lowercase().ends_with(".md") {
    path.to_string()
  } else {
    format!("untitled-{}.md", &id.simple().to_string()[..12])
  }
}

fn portable_segment(value: &str) -> String {
  let value = value
    .trim()
    .chars()
    .map(|character| {
      if matches!(character, '/' | '\\') || character.is_control() {
        '-'
      } else {
        character
      }
    })
    .collect::<String>();
  let value = value.trim_matches([' ', '.']);
  if value.is_empty() || matches!(value, "." | "..") {
    "Untitled".to_string()
  } else {
    value.to_string()
  }
}

/// Shared portable asset filename for Markdown directory/vault deliveries.
/// The source key remains opaque; path separators never escape the asset root.
pub fn portable_markdown_asset_path(key: &str, mime: &str) -> String {
  let extension = mime_guess::get_mime_extensions_str(mime)
    .and_then(|extensions| extensions.first().copied())
    .unwrap_or("bin");
  format!("assets/{}.{}", portable_segment(key), extension)
}

fn assert_blob_inventory_limit(blobs: &[crate::ports::blob::BlobMetadata]) -> Result<(), WorkspaceExportError> {
  let total = blobs.iter().try_fold(0_u64, |total, blob| {
    total.checked_add(blob.size).ok_or(WorkspaceExportError::OutputLimit)
  })?;
  if total > MAX_EXPORT_UNCOMPRESSED_BYTES as u64 {
    return Err(WorkspaceExportError::OutputLimit);
  }
  Ok(())
}

fn remaining_export_bytes(entries: &BTreeMap<String, Vec<u8>>) -> Result<usize, WorkspaceExportError> {
  let used = entries.values().try_fold(0_usize, |total, bytes| {
    total.checked_add(bytes.len()).ok_or(WorkspaceExportError::OutputLimit)
  })?;
  MAX_EXPORT_UNCOMPRESSED_BYTES
    .checked_sub(used)
    .ok_or(WorkspaceExportError::OutputLimit)
}

/// Resolve current SQL tag assignments before YAML projection. Imported
/// frontmatter is only provenance: an empty current assignment must therefore
/// remove stale `tags`, not revive it from the original vault metadata.
fn current_tags_by_document(
  document_keys: &[DocumentKey],
  catalog: Vec<myoxus_domain::workspace_tags::WorkspaceTag>,
  assignments: Vec<WorkspaceTagDocumentAssignment>,
) -> Result<HashMap<String, Vec<String>>, WorkspaceExportError> {
  if assignments.len() != document_keys.len() {
    return Err(WorkspaceExportError::MissingContent("document tags".into()));
  }
  let names = catalog
    .into_iter()
    .map(|tag| (tag.id, tag.name))
    .collect::<HashMap<_, _>>();
  let expected = document_keys.iter().map(DocumentKey::as_str).collect::<BTreeSet<_>>();
  let mut result = HashMap::with_capacity(assignments.len());
  for assignment in assignments {
    if !expected.contains(assignment.external_id.as_str()) || result.contains_key(&assignment.external_id) {
      return Err(WorkspaceExportError::MissingContent("document tags".into()));
    }
    let tags = assignment
      .tag_ids
      .into_iter()
      .map(|id| {
        names
          .get(&id)
          .cloned()
          .ok_or_else(|| WorkspaceExportError::MissingContent("document tag".into()))
      })
      .collect::<Result<Vec<_>, _>>()?;
    result.insert(assignment.external_id, tags);
  }
  Ok(result)
}

fn canonical_metadata_properties(
  projection: &DocumentMetadataProjection,
) -> (BTreeMap<String, serde_json::Value>, BTreeSet<String>) {
  let document_fields = projection
    .fields
    .iter()
    .filter(|field| field.source == DocumentMetadataSource::Document)
    .filter(|field| canonical_metadata_key(&field.key));
  let mut values = BTreeMap::new();
  let mut keys = BTreeSet::new();
  for field in document_fields {
    keys.insert(field.key.clone());
    if let Some(value) = canonical_metadata_property(field) {
      values.insert(field.key.clone(), value);
    }
  }
  (values, keys)
}

fn canonical_metadata_key(key: &str) -> bool {
  matches!(
    key,
    "status"
      | "documentType"
      | "classification"
      | "retentionPolicy"
      | "language"
      | "documentNumber"
      | "reviewDueAt"
      | "validFrom"
      | "validUntil"
  )
}

fn canonical_metadata_property(field: &DocumentMetadataFieldValue) -> Option<serde_json::Value> {
  match field.key.as_str() {
    "status" | "documentType" | "classification" | "retentionPolicy" | "language" => field
      .reference
      .as_ref()
      .map(|reference| serde_json::Value::String(reference.key.clone())),
    "documentNumber" => field
      .text_value
      .as_ref()
      .filter(|value| !value.is_empty())
      .cloned()
      .map(serde_json::Value::String),
    "reviewDueAt" | "validFrom" | "validUntil" => field
      .timestamp_value
      .map(|value| serde_json::Value::String(value.to_rfc3339())),
    _ => None,
  }
}

fn compose_obsidian_markdown(
  meta: &serde_json::Value,
  canonical_properties: &BTreeMap<String, serde_json::Value>,
  canonical_property_keys: &BTreeSet<String>,
  canonical_tags: &[String],
  markdown: &str,
) -> Result<Vec<u8>, WorkspaceExportError> {
  let mut properties = meta
    .get("properties")
    .and_then(serde_json::Value::as_object)
    .or_else(|| {
      meta
        .pointer("/obsidian/properties")
        .and_then(serde_json::Value::as_object)
    })
    .cloned()
    .unwrap_or_default();
  // Only fields currently owned by document metadata supersede import
  // provenance. Inherited or fallback fields were never accepted from the
  // vault, so they must not erase an otherwise unknown source property.
  for key in canonical_property_keys {
    properties.remove(key);
  }
  properties.remove("tags");
  for (key, value) in canonical_properties {
    properties.insert(key.clone(), value.clone());
  }
  if !canonical_tags.is_empty() {
    properties.insert("tags".to_string(), serde_json::json!(canonical_tags));
  }
  if let Some(aliases) = meta.get("aliases").or_else(|| meta.pointer("/obsidian/aliases")) {
    if aliases.as_array().is_some_and(|aliases| !aliases.is_empty()) {
      properties.insert("aliases".to_string(), aliases.clone());
    } else if meta.get("aliases").is_some() {
      properties.remove("aliases");
    }
  }
  let mut output = Vec::new();
  if !properties.is_empty() {
    output.extend_from_slice(b"---\n");
    let yaml = yaml_serde::to_string(&properties).map_err(|_| WorkspaceExportError::Projection)?;
    output.extend_from_slice(yaml.as_bytes());
    output.extend_from_slice(b"---\n\n");
  }
  output.extend_from_slice(markdown.as_bytes());
  Ok(output)
}

fn build_recovery_archive(
  metadata: &BTreeMap<String, crate::ports::blob::BlobMetadata>,
  bytes: &BTreeMap<String, Vec<u8>>,
  active: &BTreeSet<String>,
  source_by_target: &HashMap<String, String>,
  max_expanded_bytes: usize,
) -> Result<Option<RecoveryArchive>, WorkspaceExportError> {
  let mut recovery = BTreeMap::new();
  for (key, blob) in metadata {
    if active.contains(key) {
      continue;
    }
    let source = source_by_target
      .get(key)
      .cloned()
      .unwrap_or_else(|| format!("unlinked/{key}"));
    if source.eq_ignore_ascii_case(LOSS_REPORT_PATH) {
      continue;
    }
    if source.eq_ignore_ascii_case(RECOVERY_ARCHIVE_PATH) {
      merge_recovery_archive(blob.blob_id, &bytes[key], &mut recovery, max_expanded_bytes)?;
      continue;
    }
    let path = if is_safe_relative_path(&source) {
      source
    } else {
      format!("unlinked/{}", portable_segment(key))
    };
    insert_recovery_source(&mut recovery, blob.blob_id, path, bytes[key].clone())?;
    ensure_recovery_limit(&recovery, max_expanded_bytes)?;
  }
  if recovery.is_empty() {
    Ok(None)
  } else {
    let entries = recovery.iter().map(|(path, bytes)| entry_report(path, bytes)).collect();
    Ok(Some(RecoveryArchive {
      bytes: write_zip(&recovery, &[])?,
      entries,
    }))
  }
}

fn ensure_recovery_limit(
  output: &BTreeMap<String, Vec<u8>>,
  max_expanded_bytes: usize,
) -> Result<(), WorkspaceExportError> {
  let used = output.values().try_fold(0_usize, |total, bytes| {
    total.checked_add(bytes.len()).ok_or(WorkspaceExportError::OutputLimit)
  })?;
  (used <= max_expanded_bytes)
    .then_some(())
    .ok_or(WorkspaceExportError::OutputLimit)
}

struct RecoveryArchive {
  bytes: Vec<u8>,
  entries: Vec<VaultExportEntryReport>,
}

fn insert_recovery_source(
  output: &mut BTreeMap<String, Vec<u8>>,
  id: Uuid,
  preferred_path: String,
  bytes: Vec<u8>,
) -> Result<(), WorkspaceExportError> {
  let occupied = output
    .keys()
    .map(|path| (path.clone(), "another recovery source".to_string()))
    .collect();
  let plan = plan_workspace_paths(
    &[PathPlanItem {
      id,
      preferred_path,
      existing_path: None,
    }],
    &occupied,
    true,
  )?;
  output.insert(plan[0].path.clone(), bytes);
  Ok(())
}

fn merge_recovery_archive(
  archive_id: Uuid,
  bytes: &[u8],
  output: &mut BTreeMap<String, Vec<u8>>,
  max_expanded_bytes: usize,
) -> Result<(), WorkspaceExportError> {
  let used = output.values().map(Vec::len).sum::<usize>();
  let remaining = max_expanded_bytes
    .checked_sub(used)
    .ok_or(WorkspaceExportError::OutputLimit)?;
  let index = inspect_zip_bytes(
    bytes,
    ArchiveLimits {
      max_entries: MAX_EXPORT_BLOBS as usize,
      max_entry_bytes: remaining as u64,
      max_expanded_bytes: remaining as u64,
      max_compression_ratio: MAX_RECOVERY_COMPRESSION_RATIO,
      max_path_bytes: MAX_RECOVERY_PATH_BYTES,
    },
  )
  .map_err(|error| match error {
    ArchiveError::Limit(_) => WorkspaceExportError::OutputLimit,
    _ => WorkspaceExportError::Archive,
  })?;
  let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| WorkspaceExportError::Archive)?;
  for index in 0..archive.len() {
    let mut entry = archive.by_index(index).map_err(|_| WorkspaceExportError::Archive)?;
    if entry.is_dir() {
      continue;
    }
    let path = entry.name().map_err(|_| WorkspaceExportError::Archive)?.into_owned();
    if !is_safe_relative_path(&path) {
      continue;
    }
    let expected_size = entry.size();
    let mut body = Vec::new();
    (&mut entry)
      .take(expected_size.saturating_add(1))
      .read_to_end(&mut body)
      .map_err(|_| WorkspaceExportError::Archive)?;
    if body.len() as u64 != expected_size {
      return Err(WorkspaceExportError::Archive);
    }
    let entry_id = Uuid::new_v5(&archive_id, path.as_bytes());
    insert_recovery_source(output, entry_id, path, body)?;
  }
  ensure_recovery_limit(output, max_expanded_bytes)?;
  debug_assert_eq!(
    index.expanded_bytes as usize,
    output.values().map(Vec::len).sum::<usize>().saturating_sub(used)
  );
  Ok(())
}

fn empty_folder_paths<'a>(
  workspace_id: Uuid,
  folders: &[crate::git_sync::export::GitSyncManifestFolder],
  entry_paths: impl Iterator<Item = &'a String>,
) -> Result<Vec<String>, WorkspaceExportError> {
  let entries = entry_paths.map(|path| path.to_lowercase()).collect::<Vec<_>>();
  let candidates = folders
    .iter()
    .filter_map(|folder| {
      let path = folder
        .path
        .iter()
        .map(|segment| portable_segment(segment))
        .collect::<Vec<_>>()
        .join("/");
      if !is_safe_relative_path(&path) {
        return None;
      }
      let prefix = format!("{}/", path.to_lowercase());
      (!entries.iter().any(|entry| entry.starts_with(&prefix))).then(|| PathPlanItem {
        id: Uuid::new_v5(
          &workspace_id,
          format!("organizer-folder:{}", folder.organizer_id).as_bytes(),
        ),
        preferred_path: path,
        existing_path: None,
      })
    })
    .collect::<Vec<_>>();
  let occupied = entries
    .into_iter()
    .map(|path| (path, "archive file".to_string()))
    .collect();
  let mut paths = plan_workspace_paths(&candidates, &occupied, true)?
    .into_iter()
    .map(|planned| planned.path)
    .collect::<Vec<_>>();
  paths.sort_by_key(|path| path.to_lowercase());
  Ok(paths)
}

fn insert_entry(
  entries: &mut BTreeMap<String, Vec<u8>>,
  path: String,
  bytes: Vec<u8>,
) -> Result<(), WorkspaceExportError> {
  let total = entries
    .values()
    .map(Vec::len)
    .sum::<usize>()
    .saturating_add(bytes.len());
  if total > MAX_EXPORT_UNCOMPRESSED_BYTES {
    return Err(WorkspaceExportError::OutputLimit);
  }
  if entries.keys().any(|existing| existing.eq_ignore_ascii_case(&path)) {
    return Err(WorkspaceExportError::Path(WorkspacePathPlanError::PathAlreadyOwned {
      path,
      owner: "another archive entry".to_string(),
    }));
  }
  entries.insert(path, bytes);
  Ok(())
}

fn entry_report(path: &str, bytes: &[u8]) -> VaultExportEntryReport {
  VaultExportEntryReport {
    path: path.to_string(),
    sha256: format!("{:x}", Sha256::digest(bytes)),
    size_bytes: bytes.len(),
  }
}

fn write_zip(entries: &BTreeMap<String, Vec<u8>>, empty_folders: &[String]) -> Result<Vec<u8>, WorkspaceExportError> {
  let cursor = Cursor::new(Vec::new());
  let mut writer = zip::ZipWriter::new(cursor);
  let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
  for folder in empty_folders {
    writer
      .add_directory(format!("{}/", folder.trim_end_matches('/')), options)
      .map_err(|_| WorkspaceExportError::Archive)?;
  }
  for (path, bytes) in entries {
    writer
      .start_file(path.as_str(), options)
      .map_err(|_| WorkspaceExportError::Archive)?;
    writer.write_all(bytes).map_err(|_| WorkspaceExportError::Archive)?;
  }
  Ok(writer.finish().map_err(|_| WorkspaceExportError::Archive)?.into_inner())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::markdown::{MarkdownBatchReferenceInventory, prepare_markdown_batch_import};
  use crate::ports::blob::{BlobMetadata, BlobStatus};

  #[test]
  fn canonical_properties_and_alias_clear_override_import_provenance() {
    let meta = serde_json::json!({
      "obsidian": {
        "properties": {"status": "active", "count": 2, "aliases": ["Old"]},
        "aliases": ["Old"]
      },
      "properties": {"status": "done", "ratio": 1.5},
      "aliases": []
    });
    let canonical = BTreeMap::from([("status".to_string(), serde_json::json!("reviewed"))]);
    let canonical_keys = BTreeSet::from(["status".to_string()]);
    let file = String::from_utf8(
      compose_obsidian_markdown(&meta, &canonical, &canonical_keys, &["current-tag".into()], "Body\n").unwrap(),
    )
    .unwrap();
    let yaml = file.strip_prefix("---\n").unwrap().split_once("---\n\n").unwrap().0;
    let properties: serde_json::Value = yaml_serde::from_str(yaml).unwrap();
    assert_eq!(
      properties,
      serde_json::json!({"status": "reviewed", "ratio": 1.5, "tags": ["current-tag"]})
    );
    assert!(file.ends_with("Body\n"));
  }

  #[test]
  fn unowned_source_property_survives_without_a_canonical_value() {
    let meta = serde_json::json!({"obsidian": {"properties": {"status": "active"}}});
    let file =
      String::from_utf8(compose_obsidian_markdown(&meta, &BTreeMap::new(), &BTreeSet::new(), &[], "Body\n").unwrap())
        .unwrap();
    let yaml = file.strip_prefix("---\n").unwrap().split_once("---\n\n").unwrap().0;
    let properties: serde_json::Value = yaml_serde::from_str(yaml).unwrap();
    assert_eq!(properties, serde_json::json!({"status": "active"}));
  }

  #[test]
  fn current_organizer_folder_moves_an_imported_original_filename() {
    let meta = serde_json::json!({"obsidian": {"sourcePath": "Old/Shared.md"}});
    assert_eq!(
      preferred_document_path(&meta, "Renamed title", Some(&["Current".into(), "Nested".into()])),
      "Current/Nested/Shared.md"
    );
    assert_eq!(preferred_document_path(&meta, "Renamed title", None), "Old/Shared.md");
  }

  #[test]
  fn final_batch_paths_rewrite_document_links_and_native_images() {
    let original = [
      AuthorizedMarkdownBatchDocument {
        external_id: "source".into(),
        title: "Source".into(),
        path: "Projects/Source.md".into(),
      },
      AuthorizedMarkdownBatchDocument {
        external_id: "target".into(),
        title: "Target".into(),
        path: "People/Target.md".into(),
      },
    ];
    let import_lookup = MarkdownBatchReferenceInventory::new("https://myoxus.test/workspace/ws", original)
      .unwrap()
      .for_vault_source("Projects/Source.md")
      .unwrap();
    let imported = prepare_markdown_batch_import(
      "Source",
      "[[People/Target|Alias]]\n\n![pixel](media/pixel.svg)\n\nInline ![pixel](media/pixel.svg)",
      &import_lookup,
    )
    .unwrap();
    let imported = yjs::rewrite_snapshot_resource_uris(
      &imported.yjs_binary,
      &HashMap::from([("media/pixel.svg".to_string(), "live-blob-key".to_string())]),
    )
    .unwrap();
    let final_inventory = MarkdownBatchReferenceInventory::new(
      "https://myoxus.test/workspace/ws",
      [
        AuthorizedMarkdownBatchDocument {
          external_id: "source".into(),
          title: "Source".into(),
          path: "Moved/Source.md".into(),
        },
        AuthorizedMarkdownBatchDocument {
          external_id: "target".into(),
          title: "Target".into(),
          path: "People/Target.md".into(),
        },
      ],
    )
    .unwrap();
    let lookup = final_inventory.for_source("Moved/Source.md").unwrap();
    let projected = project_document_in_batch_with_images(
      &imported,
      "Source",
      MarkdownProjectionPolicy::default(),
      &lookup,
      &|source| {
        (source == "live-blob-key")
          .then(|| lookup.resolve_export_asset_path("Assets/pixel.svg"))
          .flatten()
      },
    )
    .unwrap();
    assert!(projected.markdown.contains("[Alias](../People/Target.md)"));
    assert_eq!(projected.markdown.matches("![pixel](../Assets/pixel.svg)").count(), 2);
  }

  #[test]
  fn existing_recovery_archive_is_merged_without_recursive_wrapping() {
    let existing = write_zip(
      &BTreeMap::from([("Unicode/Original.md".into(), b"source".to_vec())]),
      &[],
    )
    .unwrap();
    let existing_id = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
    let other_id = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
    let metadata = BTreeMap::from([
      ("existing".into(), blob(existing_id, "existing", existing.len())),
      ("other".into(), blob(other_id, "other", 4)),
    ]);
    let bytes = BTreeMap::from([("existing".into(), existing), ("other".into(), b"data".to_vec())]);
    let sources = HashMap::from([
      ("existing".into(), RECOVERY_ARCHIVE_PATH.into()),
      ("other".into(), "Unsupported.canvas".into()),
    ]);
    let archive = build_recovery_archive(
      &metadata,
      &bytes,
      &BTreeSet::new(),
      &sources,
      MAX_EXPORT_UNCOMPRESSED_BYTES,
    )
    .unwrap()
    .unwrap();
    assert_eq!(archive.entries.len(), 2);
    assert_eq!(archive.entries[0].path, "Unicode/Original.md");
    assert_eq!(archive.entries[0].sha256, format!("{:x}", Sha256::digest(b"source")));
    let mut zip = zip::ZipArchive::new(Cursor::new(archive.bytes)).unwrap();
    let names = (0..zip.len())
      .map(|index| zip.by_index(index).unwrap().name().unwrap().into_owned())
      .collect::<Vec<_>>();
    assert_eq!(names, ["Unicode/Original.md", "Unsupported.canvas"]);
    assert!(!names.iter().any(|name| name.contains("sources.zip")));
  }

  #[test]
  fn nested_recovery_archive_respects_the_remaining_export_budget() {
    let existing = write_zip(&BTreeMap::from([("source.md".into(), b"source".to_vec())]), &[]).unwrap();
    let existing_id = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
    let metadata = BTreeMap::from([("existing".into(), blob(existing_id, "existing", existing.len()))]);
    let bytes = BTreeMap::from([("existing".into(), existing)]);
    let sources = HashMap::from([("existing".into(), RECOVERY_ARCHIVE_PATH.into())]);

    assert!(matches!(
      build_recovery_archive(&metadata, &bytes, &BTreeSet::new(), &sources, 5),
      Err(WorkspaceExportError::OutputLimit)
    ));
  }

  #[test]
  fn recovery_and_empty_folder_collisions_are_renamed_instead_of_dropped() {
    let first_id = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
    let second_id = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
    let metadata = BTreeMap::from([
      ("first".into(), blob(first_id, "first", 3)),
      ("second".into(), blob(second_id, "second", 3)),
    ]);
    let bytes = BTreeMap::from([("first".into(), b"one".to_vec()), ("second".into(), b"two".to_vec())]);
    let sources = HashMap::from([
      ("first".into(), "Unsupported.canvas".into()),
      ("second".into(), "unsupported.CANVAS".into()),
    ]);
    let archive = build_recovery_archive(
      &metadata,
      &bytes,
      &BTreeSet::new(),
      &sources,
      MAX_EXPORT_UNCOMPRESSED_BYTES,
    )
    .unwrap()
    .unwrap();
    assert_eq!(archive.entries.len(), 2);
    assert_ne!(
      archive.entries[0].path.to_lowercase(),
      archive.entries[1].path.to_lowercase()
    );

    let workspace_id = Uuid::parse_str("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").unwrap();
    let folders = vec![
      crate::git_sync::export::GitSyncManifestFolder {
        organizer_id: "first".into(),
        parent_organizer_id: None,
        name: "Empty".into(),
        organizer_path: vec!["Empty".into()],
        path: vec!["Empty".into()],
        overview: None,
      },
      crate::git_sync::export::GitSyncManifestFolder {
        organizer_id: "second".into(),
        parent_organizer_id: None,
        name: "empty".into(),
        organizer_path: vec!["empty".into()],
        path: vec!["empty".into()],
        overview: None,
      },
    ];
    let entries = BTreeMap::from([("EMPTY".to_string(), Vec::<u8>::new())]);
    let planned = empty_folder_paths(workspace_id, &folders, entries.keys()).unwrap();
    assert_eq!(planned.len(), 2);
    assert!(planned.iter().all(|path| path.contains("--")));
    assert_ne!(planned[0].to_lowercase(), planned[1].to_lowercase());
  }

  fn blob(id: Uuid, key: &str, size: usize) -> BlobMetadata {
    BlobMetadata {
      blob_id: id,
      workspace_id: Uuid::nil(),
      key: key.into(),
      size: size as u64,
      mime: "application/octet-stream".into(),
      checksum: None,
      status: BlobStatus::Completed,
      upload_id: None,
      created_at: chrono::Utc::now(),
      updated_at: chrono::Utc::now(),
      deleted_at: None,
    }
  }
}
