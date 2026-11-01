// SPDX-License-Identifier: AGPL-3.0-or-later
//! Authoritative codec and mutation service for workspace organizer documents.
//!
//! Organizer folders are stored as rows in the workspace `folders` Yjs system
//! document. This module is the shared application boundary for GraphQL,
//! workers and MCP: transports provide authorization and target-existence
//! checks, while this service owns row decoding, structural validation,
//! revisions and mutations.
//!
//! Legacy link rows omit `targetWorkspaceId`; those links target the workspace
//! that owns the system document. Cross-workspace links carry the optional
//! column explicitly. Unknown row columns are never rewritten by updates.

mod order_key;
mod reindex;
mod retirement;

use std::collections::{BTreeMap, BTreeSet, HashSet};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Any, Doc, Map, MapRef, Out as YrsValue, ReadTxn, StateVector, Transact, TransactionMut, Update};

use crate::doc::{DocRevisionCheckedUpdateOutcome, DocService, DocSpaceKind, canonical_yjs_revision};
use crate::workspace_content_operation::WorkspaceContentReferenceDecision;
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::workspace_content_operation::{
  WorkspaceContentIdMapping, WorkspaceContentResourceKind, WorkspaceContentResourceRef,
};

use self::order_key::{OrderKeyError, generate_order_key_between, is_valid_order_key, validate_order_key};

pub use self::reindex::{OrganizerReindexGroup, OrganizerReindexPlan, OrganizerReindexRowChange};
pub use self::retirement::{OrganizerDocumentLinkRemoval, remove_document_links};

const FOLDER_INDEX_MAP: &str = "myoxus$mcp_folder_index";
const DELETED_FLAG: &str = "$$DELETED";
const MAX_FOLDER_NAME_CHARS: usize = 256;
/// Reuse the native folder name rule during readonly accepted-setup preflight.
pub(crate) fn validate_project_folder_name(name: &str) -> Result<(), OrganizerError> {
  validate_folder_name(name)
}

/// Storage boundary for the organizer's workspace system document.
#[async_trait]
pub trait OrganizerDocumentPort: Clone + Send + Sync + 'static {
  async fn load_organizer_document(&self, workspace_id: Uuid) -> Result<Vec<u8>, OrganizerError>;
  /// The canonical Collection catalog is in the workspace root, independently
  /// of Organizer placements. Transport authorization remains with the caller.
  async fn load_workspace_root_document(&self, _workspace_id: Uuid) -> Result<Vec<u8>, OrganizerError> {
    Err(OrganizerError::Storage)
  }
  async fn persist_organizer_update(&self, workspace_id: Uuid, update: Vec<u8>) -> Result<(), OrganizerError>;
  async fn persist_organizer_reindex(
    &self,
    _workspace_id: Uuid,
    _expected_revision: &str,
    _update: Vec<u8>,
  ) -> Result<i64, OrganizerError> {
    Err(OrganizerError::Storage)
  }
}

#[async_trait]
impl OrganizerDocumentPort for DocService {
  async fn load_workspace_root_document(&self, workspace_id: Uuid) -> Result<Vec<u8>, OrganizerError> {
    self
      .load_full_doc_consistent(workspace_id, workspace_id)
      .await
      .map_err(|_| OrganizerError::Storage)
  }
  async fn load_organizer_document(&self, workspace_id: Uuid) -> Result<Vec<u8>, OrganizerError> {
    let document_key = organizer_document_key(workspace_id)?;
    let Some(doc_id) = self
      .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &document_key)
      .await
      .map_err(|_| OrganizerError::Storage)?
    else {
      return Ok(Vec::new());
    };
    // Preflight and publication must observe one coherent snapshot/tail pair.
    // Separate reads can lose the tail when compaction deletes it between them.
    self
      .load_full_doc_consistent(workspace_id, doc_id)
      .await
      .map_err(|_| OrganizerError::Storage)
  }

  async fn persist_organizer_update(&self, workspace_id: Uuid, update: Vec<u8>) -> Result<(), OrganizerError> {
    self
      .push_external_update_raw(
        workspace_id,
        organizer_document_key(workspace_id)?,
        update,
        DocSpaceKind::Workspace,
      )
      .await
      .map(|_| ())
      .map_err(|_| OrganizerError::Storage)
  }

  async fn persist_organizer_reindex(
    &self,
    workspace_id: Uuid,
    expected_revision: &str,
    update: Vec<u8>,
  ) -> Result<i64, OrganizerError> {
    match self
      .push_revision_checked_external_update(
        workspace_id,
        organizer_document_key(workspace_id)?,
        expected_revision,
        update,
      )
      .await
      .map_err(|_| OrganizerError::Storage)?
    {
      DocRevisionCheckedUpdateOutcome::Appended { sequence } => Ok(sequence),
      DocRevisionCheckedUpdateOutcome::Stale { current_revision } => Err(OrganizerError::StaleRevision {
        expected_revision: expected_revision.to_string(),
        current_revision,
      }),
    }
  }
}

fn organizer_document_key(workspace_id: Uuid) -> Result<DocumentKey, OrganizerError> {
  DocumentKey::parse(format!("db${workspace_id}$folders")).map_err(|_| OrganizerError::InvalidDocumentKey)
}

/// Stable organizer failures suitable for transport-specific error mapping.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OrganizerError {
  #[error("organizer system document key is invalid")]
  InvalidDocumentKey,
  #[error("organizer system document could not be decoded")]
  Decode,
  #[error("organizer storage operation failed")]
  Storage,
  #[error("organizer row `{0}` is malformed")]
  MalformedRow(String),
  #[error("organizer folder `{0}` was not found")]
  FolderNotFound(String),
  #[error("organizer entry `{0}` was not found")]
  EntryNotFound(String),
  #[error("organizer parent `{0}` is missing or is not a folder")]
  BrokenParent(String),
  #[error("organizer hierarchy contains a cycle at `{0}`")]
  Cycle(String),
  #[error("organizer contains a duplicate resource link")]
  DuplicateResource,
  #[error("organizer folder name must contain 1 to 256 characters")]
  InvalidFolderName,
  #[error("organizer link type is not supported")]
  UnsupportedLinkType,
  #[error("organizer target id must be non-empty")]
  InvalidTarget,
  #[error("organizer workspace target must be a UUID and match targetWorkspaceId")]
  InvalidWorkspaceTarget,
  #[error("organizer entries cannot be placed at the root")]
  EntryAtRoot,
  #[error("organizer mutation did not change any field")]
  EmptyMutation,
  #[error("MIX_ORGANIZER_ORDER_KEY_INVALID: organizer order key is not accepted by fractional-indexing")]
  InvalidOrderKey,
  #[error("MIX_ORGANIZER_REINDEX_REQUIRED: organizer sibling group contains invalid order keys")]
  ReindexRequired,
  #[error("MIX_ORGANIZER_REINDEX_STALE: planned revision {expected_revision} no longer matches {current_revision}")]
  StaleRevision {
    expected_revision: String,
    current_revision: String,
  },
}

impl From<OrderKeyError> for OrganizerError {
  fn from(_error: OrderKeyError) -> Self {
    Self::InvalidOrderKey
  }
}

impl OrganizerError {
  /// Safe diagnostic identity, independent of potentially malformed row data.
  pub const fn diagnostic_kind(&self) -> &'static str {
    match self {
      Self::InvalidDocumentKey => "invalid_document_key",
      Self::Decode => "decode",
      Self::Storage => "storage",
      Self::MalformedRow(_) => "malformed_row",
      Self::FolderNotFound(_) => "folder_not_found",
      Self::EntryNotFound(_) => "entry_not_found",
      Self::BrokenParent(_) => "broken_parent",
      Self::Cycle(_) => "cycle",
      Self::DuplicateResource => "duplicate_resource",
      Self::InvalidFolderName => "invalid_folder_name",
      Self::UnsupportedLinkType => "unsupported_link_type",
      Self::InvalidTarget => "invalid_target",
      Self::InvalidWorkspaceTarget => "invalid_workspace_target",
      Self::EntryAtRoot => "entry_at_root",
      Self::EmptyMutation => "empty_mutation",
      Self::InvalidOrderKey => "invalid_order_key",
      Self::ReindexRequired => "reindex_required",
      Self::StaleRevision { .. } => "stale_revision",
    }
  }
}

/// Supported non-folder targets in the organizer document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OrganizerLinkType {
  Doc,
  Database,
  Collection,
  Tag,
  Workspace,
}

impl OrganizerLinkType {
  pub fn parse(value: &str) -> Result<Self, OrganizerError> {
    match value {
      "doc" => Ok(Self::Doc),
      "database" => Ok(Self::Database),
      "collection" => Ok(Self::Collection),
      "tag" => Ok(Self::Tag),
      "workspace" => Ok(Self::Workspace),
      _ => Err(OrganizerError::UnsupportedLinkType),
    }
  }

  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Doc => "doc",
      Self::Database => "database",
      Self::Collection => "collection",
      Self::Tag => "tag",
      Self::Workspace => "workspace",
    }
  }
}

fn organizer_resource_kind(link_type: OrganizerLinkType) -> Result<WorkspaceContentResourceKind, OrganizerError> {
  match link_type {
    OrganizerLinkType::Doc => Ok(WorkspaceContentResourceKind::Document),
    OrganizerLinkType::Database => Ok(WorkspaceContentResourceKind::Database),
    OrganizerLinkType::Collection => Ok(WorkspaceContentResourceKind::Collection),
    OrganizerLinkType::Tag => Ok(WorkspaceContentResourceKind::Tag),
    OrganizerLinkType::Workspace => Err(OrganizerError::UnsupportedLinkType),
  }
}

/// One decoded row from the organizer system document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerRow {
  pub id: String,
  pub parent_id: Option<String>,
  /// Folder name for folders, target id for resource links.
  pub data: String,
  #[serde(rename = "type")]
  pub row_type: String,
  pub index: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub target_workspace_id: Option<Uuid>,
}

impl OrganizerRow {
  /// Structural containers include the identity retained as an Extract's
  /// workspace root. It is not an independently movable/deletable user folder.
  pub fn is_folder(&self) -> bool {
    self.row_type == "folder" || self.is_workspace_root()
  }

  pub fn is_workspace_root(&self) -> bool {
    self.row_type == "workspace-root"
  }

  pub fn link_type(&self) -> Result<OrganizerLinkType, OrganizerError> {
    OrganizerLinkType::parse(&self.row_type)
  }

  /// A decoded content-resource address, or no valid resource identity.
  pub fn resource_reference(
    &self,
    owner_workspace_id: Uuid,
  ) -> Result<Option<WorkspaceContentResourceRef>, OrganizerError> {
    let (kind, id) = if self.is_folder() {
      (WorkspaceContentResourceKind::Folder, self.id.as_str())
    } else {
      let kind = match self.link_type()? {
        OrganizerLinkType::Doc => WorkspaceContentResourceKind::Document,
        OrganizerLinkType::Database => WorkspaceContentResourceKind::Database,
        OrganizerLinkType::Tag => WorkspaceContentResourceKind::Tag,
        OrganizerLinkType::Collection => WorkspaceContentResourceKind::Collection,
        OrganizerLinkType::Workspace => return Ok(None),
      };
      (kind, self.data.as_str())
    };
    Ok(WorkspaceContentResourceRef::new(self.effective_target_workspace_id(owner_workspace_id), kind, id).ok())
  }

  /// Resolve a legacy-local or explicit cross-workspace target.
  pub fn effective_target_workspace_id(&self, owner_workspace_id: Uuid) -> Uuid {
    self.target_workspace_id.unwrap_or(owner_workspace_id)
  }
}

/// Recursive, deterministically ordered organizer node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerSnapshotNode {
  #[serde(flatten)]
  pub row: OrganizerRow,
  pub children: Vec<OrganizerSnapshotNode>,
}

/// Validated organizer projection with a content-addressed Yjs revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerSnapshot {
  pub workspace_id: Uuid,
  pub revision: String,
  pub roots: Vec<OrganizerSnapshotNode>,
}

impl OrganizerSnapshot {
  /// Decode a transaction-local system snapshot with the canonical Organizer codec.
  pub fn from_update(workspace_id: Uuid, update: &[u8]) -> Result<Self, OrganizerError> {
    OrganizerDocument::decode(update.to_vec())?.snapshot(workspace_id)
  }

  /// Placements directly inside selected folders belong to the transfer projection.
  pub fn contained_resource_rows(&self, mappings: &[WorkspaceContentIdMapping]) -> Vec<OrganizerRow> {
    fn collect(nodes: &[OrganizerSnapshotNode], folders: &BTreeSet<&str>, rows: &mut Vec<OrganizerRow>) {
      for node in nodes {
        if !node.row.is_folder()
          && node
            .row
            .parent_id
            .as_deref()
            .is_some_and(|parent| folders.contains(parent))
        {
          rows.push(node.row.clone());
        }
        collect(&node.children, folders, rows);
      }
    }
    let folders = mappings
      .iter()
      .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Folder)
      .map(|mapping| mapping.source.resource_id())
      .collect();
    let mut rows = Vec::new();
    collect(&self.roots, &folders, &mut rows);
    rows.sort_by(|left, right| left.id.cmp(&right.id));
    rows
  }

  /// Bind only the selected placements; unrelated Organizer edits are not stale reference proofs.
  pub fn contained_reference_revision(&self, mappings: &[WorkspaceContentIdMapping]) -> String {
    let rows = self.contained_resource_rows(mappings);
    let bytes = serde_json::to_vec(&(self.workspace_id, rows)).expect("typed Organizer rows are serializable");
    hex::encode(Sha256::digest(bytes))
  }

  /// Bind an XWS Link preview to visible placement, not CRDT maintenance or
  /// client bookkeeping. The byte revision remains the reindex write fence.
  pub fn content_revision(&self) -> String {
    let content =
      serde_json::to_vec(&(self.workspace_id, &self.roots)).expect("typed organizer rows are JSON serializable");
    hex::encode(Sha256::digest(content))
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedOrganizerFolder {
  pub folder_id: String,
  pub path: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OrganizerFolderResolutionError {
  #[error("organizer folder was not found")]
  NotFound,
  #[error("organizer folder path segment `{segment}` at index {index} is ambiguous")]
  Ambiguous {
    index: usize,
    segment: String,
    candidate_ids: Vec<String>,
  },
}

/// Resolve an existing folder ID against one validated Organizer snapshot.
/// Consumers share this owner so MCP workflows cannot diverge on path meaning.
pub fn resolve_organizer_folder_id(snapshot: &OrganizerSnapshot, folder_id: &str) -> Option<ResolvedOrganizerFolder> {
  find_organizer_folder_path(&snapshot.roots, folder_id, &[])
}

/// Resolve an exact display-name path. Duplicate sibling names are an explicit
/// conflict rather than an arbitrary first match.
pub fn resolve_organizer_folder_path(
  snapshot: &OrganizerSnapshot,
  path: &[String],
) -> Result<ResolvedOrganizerFolder, OrganizerFolderResolutionError> {
  // Display paths start below Extract's structural root, matching navigation
  // and export paths rather than introducing the old folder's name again.
  let mut siblings = snapshot
    .roots
    .iter()
    .find(|node| node.row.is_workspace_root())
    .map_or(snapshot.roots.as_slice(), |root| root.children.as_slice());
  let mut folder_id = None;
  for (index, segment) in path.iter().enumerate() {
    let matches = siblings
      .iter()
      .filter(|node| node.row.is_folder() && node.row.data == *segment)
      .collect::<Vec<_>>();
    let [node] = matches.as_slice() else {
      if matches.is_empty() {
        return Err(OrganizerFolderResolutionError::NotFound);
      }
      let mut candidate_ids = matches.iter().map(|node| node.row.id.clone()).collect::<Vec<_>>();
      candidate_ids.sort_unstable();
      return Err(OrganizerFolderResolutionError::Ambiguous {
        index,
        segment: segment.clone(),
        candidate_ids,
      });
    };
    folder_id = Some(node.row.id.clone());
    siblings = &node.children;
  }
  Ok(ResolvedOrganizerFolder {
    folder_id: folder_id.ok_or(OrganizerFolderResolutionError::NotFound)?,
    path: path.to_vec(),
  })
}

fn find_organizer_folder_path(
  nodes: &[OrganizerSnapshotNode],
  folder_id: &str,
  parent: &[String],
) -> Option<ResolvedOrganizerFolder> {
  for node in nodes.iter().filter(|node| node.row.is_folder()) {
    let mut path = parent.to_vec();
    if !node.row.is_workspace_root() {
      path.push(node.row.data.clone());
    }
    if node.row.id == folder_id {
      return Some(ResolvedOrganizerFolder {
        folder_id: node.row.id.clone(),
        path,
      });
    }
    if let Some(found) = find_organizer_folder_path(&node.children, folder_id, &path) {
      return Some(found);
    }
  }
  None
}

/// Revisions and one target-relative Yjs update prepared for Copy staging.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerCopyProjection {
  pub source_reference_revision: String,
  pub source_revision: String,
  pub target_revision: String,
  pub rows: Vec<OrganizerRow>,
  #[serde(skip)]
  pub update: Vec<u8>,
}

/// Source and target deltas for one identity-preserving Move publication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerMoveProjection {
  pub source_reference_revision: String,
  pub source_revision: String,
  pub target_revision: String,
  pub source_rows: Vec<OrganizerRow>,
  pub target_rows: Vec<OrganizerRow>,
  #[serde(skip)]
  pub source_update: Vec<u8>,
  #[serde(skip)]
  pub target_update: Vec<u8>,
}

/// One validated organizer mutation prepared for atomic XWS Link publication.
///
/// An empty update denotes an exact idempotent replay of the operation-owned
/// row. The durable publication boundary still records and terminalizes that
/// replay, but must not append a duplicate Yjs update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerLinkProjection {
  pub revision: String,
  pub row: OrganizerRow,
  #[serde(skip)]
  pub update: Vec<u8>,
}

/// One native Organizer delta for a receipt's reserved folder and entries.
#[derive(Debug, Clone)]
pub struct ProjectStarterPlacementProjection {
  pub revision: String,
  pub update: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct CreateOrganizerFolder {
  pub id: String,
  pub parent_id: Option<String>,
  pub name: String,
  pub index: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateOrganizerFolder {
  pub name: Option<String>,
  /// `None` means no parent update; `Some(None)` moves the folder to root.
  pub parent_id: Option<Option<String>>,
  pub index: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CreateOrganizerLink {
  pub id: String,
  pub parent_id: String,
  pub link_type: OrganizerLinkType,
  pub target_id: String,
  pub target_workspace_id: Option<Uuid>,
  pub index: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateOrganizerLink {
  pub parent_id: Option<String>,
  pub link_type: Option<OrganizerLinkType>,
  pub target_id: Option<String>,
  /// `None` means no update; `Some(None)` restores legacy/local semantics.
  pub target_workspace_id: Option<Option<Uuid>>,
  pub index: Option<String>,
}

/// Shared organizer service. It is deliberately independent of API transports.
#[derive(Clone)]
pub struct OrganizerService<P> {
  port: P,
}

impl<P: OrganizerDocumentPort> OrganizerService<P> {
  pub fn new(port: P) -> Self {
    Self { port }
  }

  pub async fn snapshot(&self, workspace_id: Uuid) -> Result<OrganizerSnapshot, OrganizerError> {
    let document = self.load_document(workspace_id).await?;
    document.snapshot(workspace_id)
  }

  /// Build a deterministic index-only repair plan without persistence.
  pub async fn plan_reindex(&self, workspace_id: Uuid) -> Result<OrganizerReindexPlan, OrganizerError> {
    let document = self.load_document(workspace_id).await?;
    document.validate(workspace_id)?;
    reindex::plan(workspace_id, &document)
  }

  /// Apply one previously built plan against its exact locked revision.
  pub async fn apply_reindex(&self, plan: &OrganizerReindexPlan) -> Result<Option<i64>, OrganizerError> {
    if plan.is_empty() {
      return Ok(None);
    }
    self
      .port
      .persist_organizer_reindex(plan.workspace_id, &plan.revision, plan.delta.clone())
      .await
      .map(Some)
  }

  /// Build one deterministic, target-relative organizer update for Copy.
  ///
  /// Top-level folders attach to the destination's structural root. Resource
  /// links are copied only when their containing folder is part of the mapping,
  /// so a direct document selection
  /// never invents an implicit destination folder. The returned revisions are
  /// rechecked immediately before publication.
  pub async fn project_copy(
    &self,
    operation_id: Uuid,
    source_workspace_id: Uuid,
    target_workspace_id: Uuid,
    mappings: &[WorkspaceContentIdMapping],
    reference_decisions: &[(String, WorkspaceContentReferenceDecision)],
  ) -> Result<OrganizerCopyProjection, OrganizerError> {
    if mappings.iter().any(|mapping| {
      mapping.source.kind() == WorkspaceContentResourceKind::Collection
        || mapping.target.kind() == WorkspaceContentResourceKind::Collection
    }) {
      return Err(OrganizerError::UnsupportedLinkType);
    }
    let source = self.load_document(source_workspace_id).await?;
    source.validate(source_workspace_id)?;
    let mut target = self.load_document(target_workspace_id).await?;
    target.validate(target_workspace_id)?;
    let source_snapshot = source.snapshot(source_workspace_id)?;
    let source_reference_revision = source_snapshot.contained_reference_revision(mappings);
    let source_revision = source_snapshot.revision;
    let target_revision = target.snapshot(target_workspace_id)?.revision;
    let mapped = mappings
      .iter()
      .map(|mapping| {
        (
          (mapping.source.kind(), mapping.source.resource_id().to_string()),
          mapping.target.clone(),
        )
      })
      .collect::<BTreeMap<_, _>>();
    let mapped_folders = mappings
      .iter()
      .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Folder)
      .map(|mapping| (mapping.source.resource_id(), mapping.target.resource_id()))
      .collect::<BTreeMap<_, _>>();
    let mut rows = Vec::new();
    let local_collections = if source.rows.iter().any(|row| {
      row.row_type == OrganizerLinkType::Collection.as_str()
        && row.effective_target_workspace_id(source_workspace_id) == source_workspace_id
        && row
          .parent_id
          .as_deref()
          .is_some_and(|parent| mapped_folders.contains_key(parent))
    }) {
      self.collection_ids(source_workspace_id).await?
    } else {
      BTreeSet::new()
    };
    for source_row in &source.rows {
      if source_row.is_folder() {
        let Some(target_id) = mapped_folders.get(source_row.id.as_str()) else {
          continue;
        };
        if source_row.is_workspace_root() {
          return Err(OrganizerError::InvalidTarget);
        }
        rows.push(OrganizerRow {
          id: (*target_id).to_string(),
          parent_id: source_row
            .parent_id
            .as_deref()
            .and_then(|parent| mapped_folders.get(parent))
            .map(|parent| (*parent).to_string()),
          data: source_row.data.clone(),
          row_type: source_row.row_type.clone(),
          index: source_row.index.clone(),
          target_workspace_id: None,
        });
        continue;
      }
      let Some(parent_id) = source_row
        .parent_id
        .as_deref()
        .and_then(|parent| mapped_folders.get(parent))
      else {
        continue;
      };
      let link_type = source_row.link_type()?;
      if reference_decisions
        .iter()
        .any(|(id, decision)| id == &source_row.id && matches!(decision, WorkspaceContentReferenceDecision::Omit))
      {
        continue;
      }
      let source_target_workspace = source_row.effective_target_workspace_id(source_workspace_id);
      if link_type == OrganizerLinkType::Collection {
        if source_target_workspace == source_workspace_id && !local_collections.contains(&source_row.data) {
          continue;
        }
        rows.push(OrganizerRow {
          id: Uuid::new_v5(&operation_id, format!("organizer-row:{}", source_row.id).as_bytes()).to_string(),
          parent_id: Some((*parent_id).to_string()),
          target_workspace_id: Some(source_target_workspace),
          ..source_row.clone()
        });
        continue;
      }
      let mut transferred = source_row.clone();
      transferred.parent_id = Some((*parent_id).to_string());
      if link_type != OrganizerLinkType::Workspace {
        project_reference_row(
          &mut transferred,
          source_workspace_id,
          target_workspace_id,
          &mapped,
          reference_decisions,
        )?;
      }
      transferred.id = Uuid::new_v5(&operation_id, format!("organizer-row:{}", source_row.id).as_bytes()).to_string();
      rows.push(transferred);
    }
    rows.sort_by(|left, right| left.index.cmp(&right.index).then_with(|| left.id.cmp(&right.id)));
    target.retain_unique_tag_links(&mut rows, target_workspace_id);
    target.attach_to_workspace_root(&mut rows);
    target.validate_inserted_rows(&rows)?;
    for row in &rows {
      if target.rows.iter().any(|current| current.id == row.id && current != row) {
        return Err(OrganizerError::DuplicateResource);
      }
      if !row.is_folder() {
        target.assert_unique_link(row, Some(&row.id), target_workspace_id)?;
      }
    }
    let update = target.write_rows(&rows, target_workspace_id)?;
    Ok(OrganizerCopyProjection {
      source_reference_revision,
      source_revision,
      target_revision,
      rows,
      update,
    })
  }

  /// Build both organizer mutations required by an identity-preserving Move.
  ///
  /// Rows contained by moved folders transfer to the target. References that
  /// remain in the source are retained as explicit cross-workspace links, so
  /// moving a document never silently removes an independently placed link.
  pub async fn project_move(
    &self,
    source_workspace_id: Uuid,
    target_workspace_id: Uuid,
    mappings: &[WorkspaceContentIdMapping],
    reference_decisions: &[(String, WorkspaceContentReferenceDecision)],
  ) -> Result<OrganizerMoveProjection, OrganizerError> {
    self
      .project_transfer(
        source_workspace_id,
        target_workspace_id,
        mappings,
        reference_decisions,
        None,
        None,
      )
      .await
  }

  /// Build the same identity-preserving transfer projection as Move while
  /// replacing the selected source folder in place with a Workspace link.
  pub async fn project_extract(
    &self,
    source_workspace_id: Uuid,
    target_workspace_id: Uuid,
    source_folder_id: &str,
    mappings: &[WorkspaceContentIdMapping],
    reference_decisions: &[(String, WorkspaceContentReferenceDecision)],
  ) -> Result<OrganizerMoveProjection, OrganizerError> {
    if source_folder_id.is_empty() || source_folder_id.chars().any(char::is_control) {
      return Err(OrganizerError::FolderNotFound(source_folder_id.to_string()));
    }
    self
      .project_transfer(
        source_workspace_id,
        target_workspace_id,
        mappings,
        reference_decisions,
        Some(source_folder_id),
        None,
      )
      .await
  }

  /// Restore only the original Extract slot authenticated by its publication
  /// receipt. A removed slot is vacant; a retargeted or foreign row is protected.
  pub async fn project_undo_extract(
    &self,
    source_workspace_id: Uuid,
    target_workspace_id: Uuid,
    folder_id: &str,
    mappings: &[WorkspaceContentIdMapping],
    reference_decisions: &[(String, WorkspaceContentReferenceDecision)],
  ) -> Result<OrganizerMoveProjection, OrganizerError> {
    self
      .project_transfer(
        source_workspace_id,
        target_workspace_id,
        mappings,
        reference_decisions,
        None,
        Some(folder_id),
      )
      .await
  }

  async fn project_transfer(
    &self,
    source_workspace_id: Uuid,
    target_workspace_id: Uuid,
    mappings: &[WorkspaceContentIdMapping],
    reference_decisions: &[(String, WorkspaceContentReferenceDecision)],
    extract_source_folder_id: Option<&str>,
    undo_extract_folder_id: Option<&str>,
  ) -> Result<OrganizerMoveProjection, OrganizerError> {
    if mappings.iter().any(|mapping| {
      mapping.source.kind() == WorkspaceContentResourceKind::Collection
        || mapping.target.kind() == WorkspaceContentResourceKind::Collection
    }) {
      return Err(OrganizerError::UnsupportedLinkType);
    }
    let mut source = self.load_document(source_workspace_id).await?;
    source.validate(source_workspace_id)?;
    let mut target = self.load_document(target_workspace_id).await?;
    target.validate(target_workspace_id)?;
    let source_snapshot = source.snapshot(source_workspace_id)?;
    let source_reference_revision = source_snapshot.contained_reference_revision(mappings);
    let source_revision = source_snapshot.revision;
    let target_revision = target.snapshot(target_workspace_id)?.revision;
    let undo_placeholder = if let Some(folder_id) = undo_extract_folder_id {
      if !mappings.iter().any(|mapping| {
        mapping.target.kind() == WorkspaceContentResourceKind::Folder && mapping.target.resource_id() == folder_id
      }) {
        return Err(OrganizerError::InvalidTarget);
      }
      let row = target.rows.iter().find(|row| row.id == folder_id);
      if row.is_some_and(|row| {
        row.row_type != OrganizerLinkType::Workspace.as_str()
          || row.data != source_workspace_id.to_string()
          || row.effective_target_workspace_id(target_workspace_id) != source_workspace_id
      }) {
        return Err(OrganizerError::DuplicateResource);
      }
      row.cloned()
    } else {
      None
    };
    let mapped = mappings
      .iter()
      .map(|mapping| {
        (
          (mapping.source.kind(), mapping.source.resource_id().to_string()),
          mapping.target.clone(),
        )
      })
      .collect::<BTreeMap<_, _>>();
    let mapped_folders = mappings
      .iter()
      .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Folder)
      .map(|mapping| {
        (
          mapping.source.resource_id().to_string(),
          mapping.target.resource_id().to_string(),
        )
      })
      .collect::<BTreeMap<_, _>>();

    let moved_folder_ids = mapped_folders.keys().cloned().collect::<BTreeSet<_>>();
    let local_collections = if source.rows.iter().any(|row| {
      row.row_type == OrganizerLinkType::Collection.as_str()
        && row.effective_target_workspace_id(source_workspace_id) == source_workspace_id
        && row
          .parent_id
          .as_ref()
          .is_some_and(|parent| moved_folder_ids.contains(parent))
    }) {
      self.collection_ids(source_workspace_id).await?
    } else {
      BTreeSet::new()
    };
    let mut target_rows = Vec::new();
    let mut source_rows = Vec::new();
    let mut removed_ids = Vec::new();

    for row in source.rows.clone() {
      if row.is_folder() && moved_folder_ids.contains(&row.id) {
        if row.is_workspace_root() && undo_extract_folder_id.is_none() {
          return Err(OrganizerError::InvalidTarget);
        }
        let target_id = mapped_folders.get(&row.id).ok_or(OrganizerError::InvalidTarget)?;
        target_rows.push(OrganizerRow {
          id: target_id.clone(),
          parent_id: row.parent_id.as_ref().and_then(|id| mapped_folders.get(id)).cloned(),
          data: row.data.clone(),
          row_type: if extract_source_folder_id == Some(row.id.as_str()) {
            "workspace-root".into()
          } else if row.is_workspace_root() && undo_extract_folder_id.is_some() {
            "folder".into()
          } else {
            row.row_type.clone()
          },
          index: row.index.clone(),
          target_workspace_id: None,
        });
        if extract_source_folder_id == Some(row.id.as_str()) {
          source_rows.push(OrganizerRow {
            id: row.id,
            parent_id: row.parent_id,
            data: target_workspace_id.to_string(),
            row_type: OrganizerLinkType::Workspace.as_str().to_string(),
            index: row.index,
            target_workspace_id: Some(target_workspace_id),
          });
        } else {
          removed_ids.push(row.id);
        }
        continue;
      }
      if !row.is_folder() {
        let parent_is_moved = row
          .parent_id
          .as_deref()
          .is_some_and(|parent| moved_folder_ids.contains(parent));
        let link_type = row.link_type()?;
        let source_target_workspace = row.effective_target_workspace_id(source_workspace_id);

        if parent_is_moved {
          if reference_decisions
            .iter()
            .any(|(id, decision)| id == &row.id && matches!(decision, WorkspaceContentReferenceDecision::Omit))
          {
            removed_ids.push(row.id);
            continue;
          }
          let parent_id = row
            .parent_id
            .as_deref()
            .and_then(|parent| mapped_folders.get(parent))
            .cloned()
            .ok_or(OrganizerError::InvalidTarget)?;
          let mut transferred = row.clone();
          transferred.parent_id = Some(parent_id);
          if link_type == OrganizerLinkType::Collection {
            // Never adopt a lateral catalog. Only a proved missing local
            // definition is omitted; foreign existence stays unknown here.
            if source_target_workspace == source_workspace_id && !local_collections.contains(&row.data) {
              removed_ids.push(row.id);
              continue;
            }
            transferred.target_workspace_id = Some(source_target_workspace);
          } else if link_type != OrganizerLinkType::Workspace {
            project_reference_row(
              &mut transferred,
              source_workspace_id,
              target_workspace_id,
              &mapped,
              reference_decisions,
            )?;
          }
          target_rows.push(transferred);
          removed_ids.push(row.id);
          continue;
        }

        // A placement outside the selected tree changes only when its local
        // resource moves. Cross-workspace and Workspace links remain exactly
        // where they are. Tags remain in the source catalog, so their outside
        // placements also remain local rather than becoming relocation links.
        if source_target_workspace == source_workspace_id
          && !matches!(link_type, OrganizerLinkType::Workspace | OrganizerLinkType::Tag)
        {
          let kind = organizer_resource_kind(link_type)?;
          if let Some(mapped_target) = mapped.get(&(kind, row.data.clone())) {
            source_rows.push(OrganizerRow {
              data: mapped_target.resource_id().to_string(),
              target_workspace_id: Some(target_workspace_id),
              ..row
            });
          }
        }
      }
    }
    target_rows.sort_by(|left, right| left.index.cmp(&right.index).then_with(|| left.id.cmp(&right.id)));
    target.retain_unique_tag_links(&mut target_rows, target_workspace_id);
    target.attach_to_workspace_root(&mut target_rows);
    target.assign_append_indices(&mut target_rows)?;
    if let Some(placeholder) = &undo_placeholder {
      let restored = target_rows
        .iter_mut()
        .find(|row| row.is_folder() && row.id == placeholder.id)
        .ok_or(OrganizerError::InvalidTarget)?;
      restored.parent_id = placeholder.parent_id.clone();
      restored.index = placeholder.index.clone();
    }
    for row in &target_rows {
      if target
        .rows
        .iter()
        .any(|current| current.id == row.id && current != row && undo_placeholder.as_ref() != Some(current))
      {
        return Err(OrganizerError::DuplicateResource);
      }
      if !row.is_folder() {
        target.assert_unique_link(row, Some(&row.id), target_workspace_id)?;
      }
    }
    let source_update = source.replace_and_delete_rows(&source_rows, &removed_ids, source_workspace_id)?;
    let target_update = target.write_rows(&target_rows, target_workspace_id)?;
    Ok(OrganizerMoveProjection {
      source_reference_revision,
      source_revision,
      target_revision,
      source_rows,
      target_rows,
      source_update,
      target_update,
    })
  }

  async fn collection_ids(&self, workspace_id: Uuid) -> Result<BTreeSet<String>, OrganizerError> {
    let root = self.port.load_workspace_root_document(workspace_id).await?;
    let catalog = yjs::extract_workspace_collections(&root).map_err(|_| OrganizerError::Decode)?;
    Ok(
      catalog
        .into_iter()
        .filter_map(|value| value.get("id").and_then(serde_json::Value::as_str).map(str::to_string))
        .collect(),
    )
  }

  pub async fn create_folder(
    &self,
    workspace_id: Uuid,
    request: CreateOrganizerFolder,
  ) -> Result<OrganizerRow, OrganizerError> {
    validate_folder_name(&request.name)?;
    let mut document = self.load_document(workspace_id).await?;
    document.validate(workspace_id)?;
    if document.rows.iter().any(|row| row.id == request.id) {
      return Err(OrganizerError::DuplicateResource);
    }
    let parent_id = request.parent_id.or_else(|| document.workspace_root_id());
    if let Some(parent_id) = &parent_id {
      document.assert_folder(parent_id)?;
    }
    let index = document.resolve_placement_index(parent_id.as_deref(), None, request.index.as_deref())?;
    let row = OrganizerRow {
      id: request.id,
      parent_id,
      data: request.name,
      row_type: "folder".to_string(),
      index,
      target_workspace_id: None,
    };
    let update = document.write_row(&row, true)?;
    self.port.persist_organizer_update(workspace_id, update).await?;
    Ok(row)
  }

  pub async fn update_folder(
    &self,
    workspace_id: Uuid,
    folder_id: &str,
    patch: UpdateOrganizerFolder,
  ) -> Result<OrganizerRow, OrganizerError> {
    if patch.name.is_none() && patch.parent_id.is_none() && patch.index.is_none() {
      return Err(OrganizerError::EmptyMutation);
    }
    if let Some(name) = &patch.name {
      validate_folder_name(name)?;
    }
    let mut document = self.load_document(workspace_id).await?;
    document.validate(workspace_id)?;
    let current = document
      .rows
      .iter()
      .find(|row| row.id == folder_id && row.is_folder())
      .cloned()
      .ok_or_else(|| OrganizerError::FolderNotFound(folder_id.to_string()))?;
    if current.is_workspace_root() {
      return Err(OrganizerError::InvalidTarget);
    }
    let next_parent = patch
      .parent_id
      .clone()
      .map(|parent| parent.or_else(|| document.workspace_root_id()))
      .unwrap_or_else(|| current.parent_id.clone());
    if let Some(parent_id) = &next_parent {
      document.assert_folder(parent_id)?;
      if parent_id == folder_id || document.is_ancestor(parent_id, folder_id)? {
        return Err(OrganizerError::Cycle(folder_id.to_string()));
      }
    }
    let parent_changed = next_parent != current.parent_id;
    let index_update = if parent_changed || patch.index.is_some() {
      Some(document.resolve_placement_index(next_parent.as_deref(), Some(folder_id), patch.index.as_deref())?)
    } else {
      None
    };
    let updated = OrganizerRow {
      data: patch.name.clone().unwrap_or_else(|| current.data.clone()),
      parent_id: next_parent,
      index: index_update.clone().unwrap_or_else(|| current.index.clone()),
      ..current
    };
    let row = document.doc.get_or_insert_map(folder_id);
    let update = document.mutate(|txn| {
      if let Some(name) = patch.name {
        row.insert(txn, "data", name);
      }
      if patch.parent_id.is_some() {
        insert_optional_string(&row, txn, "parentId", updated.parent_id.clone());
      }
      if let Some(index) = index_update {
        row.insert(txn, "index", index);
      }
    });
    self.port.persist_organizer_update(workspace_id, update).await?;
    Ok(updated)
  }

  pub async fn delete_folder(&self, workspace_id: Uuid, folder_id: &str) -> Result<Vec<String>, OrganizerError> {
    let mut document = self.load_document(workspace_id).await?;
    document.validate(workspace_id)?;
    if !document.rows.iter().any(|row| row.id == folder_id && row.is_folder()) {
      return Err(OrganizerError::FolderNotFound(folder_id.to_string()));
    }
    if document
      .rows
      .iter()
      .any(|row| row.id == folder_id && row.is_workspace_root())
    {
      return Err(OrganizerError::InvalidTarget);
    }
    let deleted_ids = document.subtree_ids(folder_id)?;
    let update = document.delete_rows(&deleted_ids);
    self.port.persist_organizer_update(workspace_id, update).await?;
    Ok(deleted_ids)
  }

  pub async fn create_link(
    &self,
    workspace_id: Uuid,
    request: CreateOrganizerLink,
  ) -> Result<OrganizerRow, OrganizerError> {
    validate_link_target(request.link_type, &request.target_id, request.target_workspace_id)?;
    let mut document = self.load_document(workspace_id).await?;
    document.validate(workspace_id)?;
    document.assert_folder(&request.parent_id)?;
    if document.rows.iter().any(|row| row.id == request.id) {
      return Err(OrganizerError::DuplicateResource);
    }
    let index = document.resolve_placement_index(Some(&request.parent_id), None, request.index.as_deref())?;
    let row = OrganizerRow {
      id: request.id,
      parent_id: Some(request.parent_id),
      data: request.target_id,
      row_type: request.link_type.as_str().to_string(),
      index,
      target_workspace_id: request.target_workspace_id,
    };
    document.assert_unique_link(&row, None, workspace_id)?;
    let update = document.write_row(&row, true)?;
    self.port.persist_organizer_update(workspace_id, update).await?;
    Ok(row)
  }

  /// Prepare an operation-owned link without writing product state.
  ///
  /// XWS publication uses this projection to commit the organizer update,
  /// publication outbox, terminal operation status, and lease release in one
  /// PostgreSQL transaction. Ordinary organizer mutations continue to use the
  /// direct persistence methods above.
  pub async fn project_operation_link(
    &self,
    workspace_id: Uuid,
    request: CreateOrganizerLink,
  ) -> Result<OrganizerLinkProjection, OrganizerError> {
    validate_link_target(request.link_type, &request.target_id, request.target_workspace_id)?;
    if let Some(index) = request.index.as_deref() {
      validate_order_key(index).map_err(|_| OrganizerError::InvalidOrderKey)?;
    }
    let mut document = self.load_document(workspace_id).await?;
    document.validate(workspace_id)?;
    let revision = document.snapshot(workspace_id)?.content_revision();
    if let Some(current) = document.rows.iter().find(|current| current.id == request.id) {
      let index_matches = request.index.as_ref().is_none_or(|index| current.index == *index);
      let semantics_match = current.parent_id.as_deref() == Some(request.parent_id.as_str())
        && current.data == request.target_id
        && current.row_type == request.link_type.as_str()
        && current.target_workspace_id == request.target_workspace_id;
      return if index_matches && semantics_match {
        Ok(OrganizerLinkProjection {
          revision,
          row: current.clone(),
          update: Vec::new(),
        })
      } else {
        Err(OrganizerError::DuplicateResource)
      };
    }
    let index = document.resolve_placement_index(Some(&request.parent_id), None, request.index.as_deref())?;
    let row = OrganizerRow {
      id: request.id,
      parent_id: Some(request.parent_id),
      data: request.target_id,
      row_type: request.link_type.as_str().to_string(),
      index,
      target_workspace_id: request.target_workspace_id,
    };
    document.assert_folder(row.parent_id.as_deref().expect("link parent is present"))?;
    document.assert_unique_link(&row, None, workspace_id)?;
    let update = document.write_row(&row, true)?;
    Ok(OrganizerLinkProjection { revision, row, update })
  }

  /// Project a single accepted placement batch without touching document bodies.
  /// Reserved IDs must still be absent: atomic ACK means an unacknowledged
  /// preexisting row is not ours to adopt, even if its visible fields match.
  pub async fn project_starter_placement(
    &self,
    accepted: &crate::workspace::AcceptedProjectStarter,
    stage: &crate::workspace::ProjectPlacementStage,
  ) -> Result<ProjectStarterPlacementProjection, OrganizerError> {
    self
      .document_starter_placement(&accepted.document_receipt(), stage)
      .await
  }
  pub async fn document_starter_placement(
    &self,
    accepted: &crate::workspace::StarterDocumentReceipt,
    stage: &crate::workspace::ProjectPlacementStage,
  ) -> Result<ProjectStarterPlacementProjection, OrganizerError> {
    use myoxus_domain::assistant_package::AssistantFolderDestination;
    let workspace = accepted.workspace_id;
    let mut document = self.load_document(workspace).await?;
    document.validate(workspace)?;
    let revision = document.snapshot(workspace)?.content_revision();
    let before = document.doc.transact().state_vector();
    let folder_id = accepted.folder_id.as_ref().ok_or(OrganizerError::InvalidTarget)?;
    match accepted.folder.as_ref().ok_or(OrganizerError::InvalidTarget)? {
      AssistantFolderDestination::Existing { id } => {
        if id != folder_id {
          return Err(OrganizerError::InvalidTarget);
        }
        document.assert_folder(id)?;
      }
      AssistantFolderDestination::New { .. } if *stage != crate::workspace::ProjectPlacementStage::Folder => {
        document.assert_folder(folder_id)?;
      }
      AssistantFolderDestination::New { name, parent } => {
        validate_folder_name(name)?;
        if document.rows.iter().any(|row| row.id == *folder_id) {
          return Err(OrganizerError::DuplicateResource);
        }
        let parent_id = parent.clone().or_else(|| document.workspace_root_id());
        if let Some(parent) = &parent_id {
          document.assert_folder(parent)?;
        }
        let index = document.resolve_placement_index(parent_id.as_deref(), None, None)?;
        document.write_rows(
          &[OrganizerRow {
            id: folder_id.clone(),
            parent_id,
            data: name.clone(),
            row_type: "folder".into(),
            index,
            target_workspace_id: None,
          }],
          workspace,
        )?;
      }
    }
    let mut links = Vec::new();
    match stage {
      crate::workspace::ProjectPlacementStage::Folder => {}
      crate::workspace::ProjectPlacementStage::NativeLink { component_id } => {
        links.push(starter_setup_link(accepted, component_id)?);
      }
      crate::workspace::ProjectPlacementStage::CompleteDocuments => {}
      crate::workspace::ProjectPlacementStage::Project => {
        let crate::workspace::StarterDocumentOrigin::Project { database_id, entry_id } = &accepted.origin else {
          return Err(OrganizerError::InvalidTarget);
        };
        links.push((
          entry_id.clone().ok_or(OrganizerError::InvalidTarget)?,
          OrganizerLinkType::Database,
          database_id.to_string(),
        ));
      }
      crate::workspace::ProjectPlacementStage::Document { component_id } => {
        let ids = accepted
          .ids
          .iter()
          .find(|ids| ids.component_id == *component_id)
          .ok_or(OrganizerError::InvalidTarget)?;
        let created = accepted
          .progress
          .documents
          .get(component_id)
          .ok_or(OrganizerError::InvalidTarget)?;
        if created.doc_id != ids.doc_id {
          return Err(OrganizerError::InvalidTarget);
        }
        links.push((
          ids.entry_id.clone(),
          OrganizerLinkType::Doc,
          created.external_id.clone(),
        ));
      }
    }
    for (id, kind, target) in links {
      validate_link_target(kind, &target, None)?;
      if document.rows.iter().any(|row| row.id == id) {
        return Err(OrganizerError::DuplicateResource);
      }
      let row = OrganizerRow {
        id,
        parent_id: Some(folder_id.clone()),
        data: target,
        row_type: kind.as_str().into(),
        index: document.resolve_placement_index(Some(folder_id), None, None)?,
        target_workspace_id: None,
      };
      document.assert_unique_link(&row, None, workspace)?;
      document.write_rows(&[row], workspace)?;
    }
    let update = document.doc.transact().encode_state_as_update_v1(&before);
    Ok(ProjectStarterPlacementProjection { revision, update })
  }

  pub async fn update_link(
    &self,
    workspace_id: Uuid,
    entry_id: &str,
    patch: UpdateOrganizerLink,
  ) -> Result<OrganizerRow, OrganizerError> {
    if patch.parent_id.is_none()
      && patch.link_type.is_none()
      && patch.target_id.is_none()
      && patch.target_workspace_id.is_none()
      && patch.index.is_none()
    {
      return Err(OrganizerError::EmptyMutation);
    }
    let mut document = self.load_document(workspace_id).await?;
    document.validate(workspace_id)?;
    let current = document
      .rows
      .iter()
      .find(|row| row.id == entry_id && !row.is_folder())
      .cloned()
      .ok_or_else(|| OrganizerError::EntryNotFound(entry_id.to_string()))?;
    let parent_id = patch
      .parent_id
      .clone()
      .or_else(|| current.parent_id.clone())
      .ok_or(OrganizerError::EntryAtRoot)?;
    document.assert_folder(&parent_id)?;
    let link_type = patch.link_type.unwrap_or(current.link_type()?);
    let target_id = patch.target_id.clone().unwrap_or_else(|| current.data.clone());
    let target_workspace_id = patch.target_workspace_id.unwrap_or(current.target_workspace_id);
    validate_link_target(link_type, &target_id, target_workspace_id)?;
    let parent_changed = current.parent_id.as_deref() != Some(parent_id.as_str());
    let index_update = if parent_changed || patch.index.is_some() {
      Some(document.resolve_placement_index(Some(&parent_id), Some(entry_id), patch.index.as_deref())?)
    } else {
      None
    };
    let updated = OrganizerRow {
      id: current.id,
      parent_id: Some(parent_id),
      data: target_id,
      row_type: link_type.as_str().to_string(),
      index: index_update.clone().unwrap_or(current.index),
      target_workspace_id,
    };
    document.assert_unique_link(&updated, Some(entry_id), workspace_id)?;
    let row = document.doc.get_or_insert_map(entry_id);
    let update = document.mutate(|txn| {
      if let Some(parent_id) = patch.parent_id {
        row.insert(txn, "parentId", parent_id);
      }
      if let Some(link_type) = patch.link_type {
        row.insert(txn, "type", link_type.as_str());
      }
      if let Some(target_id) = patch.target_id {
        row.insert(txn, "data", target_id);
      }
      if let Some(target_workspace_id) = patch.target_workspace_id {
        insert_optional_uuid(&row, txn, "targetWorkspaceId", target_workspace_id);
      }
      if let Some(index) = index_update {
        row.insert(txn, "index", index);
      }
    });
    self.port.persist_organizer_update(workspace_id, update).await?;
    Ok(updated)
  }

  pub async fn delete_link(&self, workspace_id: Uuid, entry_id: &str) -> Result<(), OrganizerError> {
    let mut document = self.load_document(workspace_id).await?;
    document.validate(workspace_id)?;
    if !document.rows.iter().any(|row| row.id == entry_id && !row.is_folder()) {
      return Err(OrganizerError::EntryNotFound(entry_id.to_string()));
    }
    let update = document.delete_rows(&[entry_id.to_string()]);
    self.port.persist_organizer_update(workspace_id, update).await
  }

  async fn load_document(&self, workspace_id: Uuid) -> Result<OrganizerDocument, OrganizerError> {
    OrganizerDocument::decode(self.port.load_organizer_document(workspace_id).await?)
  }
}

struct OrganizerDocument {
  doc: Doc,
  rows: Vec<OrganizerRow>,
  revision: String,
  source: Vec<u8>,
}

impl OrganizerDocument {
  fn decode(payload: Vec<u8>) -> Result<Self, OrganizerError> {
    let revision = canonical_yjs_revision(&payload).map_err(|_| OrganizerError::Decode)?;
    let doc = Doc::new();
    if !payload.is_empty() {
      let update = Update::decode_v1(&payload).map_err(|_| OrganizerError::Decode)?;
      doc
        .transact_mut()
        .apply_update(update)
        .map_err(|_| OrganizerError::Decode)?;
    }
    let rows = decode_rows(&doc)?;
    Ok(Self {
      doc,
      rows,
      revision,
      source: payload,
    })
  }

  fn validate(&self, workspace_id: Uuid) -> Result<(), OrganizerError> {
    let workspace_roots = self
      .rows
      .iter()
      .filter(|row| row.is_workspace_root())
      .collect::<Vec<_>>();
    if workspace_roots.len() > 1 || workspace_roots.iter().any(|row| row.parent_id.is_some()) {
      return Err(OrganizerError::DuplicateResource);
    }
    let ids = self.rows.iter().map(|row| row.id.as_str()).collect::<HashSet<_>>();
    if ids.len() != self.rows.len() {
      return Err(OrganizerError::DuplicateResource);
    }
    let mut links = BTreeSet::new();
    for row in &self.rows {
      if let Some(parent_id) = &row.parent_id {
        self.assert_folder(parent_id)?;
      } else if !row.is_folder() && row.link_type()? != OrganizerLinkType::Workspace {
        return Err(OrganizerError::EntryAtRoot);
      }
      if !row.is_folder() {
        let link_type = row.link_type()?;
        // Broken persisted resource targets are readable. Workspace-link
        // structure and all newly authored placements remain strict.
        if link_type == OrganizerLinkType::Workspace {
          validate_link_target(link_type, &row.data, row.target_workspace_id)?;
        }
        if !links.insert((
          link_type,
          row.effective_target_workspace_id(workspace_id),
          row.data.as_str(),
        )) {
          return Err(OrganizerError::DuplicateResource);
        }
      }
    }
    for row in self.rows.iter().filter(|row| row.is_folder()) {
      self.ancestor_chain(&row.id)?;
    }
    Ok(())
  }

  fn resolve_placement_index(
    &self,
    parent_id: Option<&str>,
    ignored_id: Option<&str>,
    explicit_index: Option<&str>,
  ) -> Result<String, OrganizerError> {
    if let Some(index) = explicit_index {
      validate_order_key(index).map_err(|_| OrganizerError::InvalidOrderKey)?;
    }
    let siblings = self
      .rows
      .iter()
      .filter(|row| row.parent_id.as_deref() == parent_id && Some(row.id.as_str()) != ignored_id)
      .collect::<Vec<_>>();
    if siblings.iter().any(|row| !is_valid_order_key(&row.index)) {
      return Err(OrganizerError::ReindexRequired);
    }
    if let Some(index) = explicit_index {
      return Ok(index.to_string());
    }
    let lower = siblings.iter().map(|row| row.index.as_str()).max();
    generate_order_key_between(lower, None).map_err(OrganizerError::from)
  }

  fn validate_inserted_rows(&self, rows: &[OrganizerRow]) -> Result<(), OrganizerError> {
    let parents = rows.iter().map(|row| row.parent_id.as_deref()).collect::<BTreeSet<_>>();
    if rows.iter().any(|row| !is_valid_order_key(&row.index))
      || self
        .rows
        .iter()
        .any(|row| parents.contains(&row.parent_id.as_deref()) && !is_valid_order_key(&row.index))
    {
      return Err(OrganizerError::ReindexRequired);
    }
    Ok(())
  }

  fn assign_append_indices(&self, rows: &mut [OrganizerRow]) -> Result<(), OrganizerError> {
    let mut groups = BTreeMap::<Option<String>, Vec<usize>>::new();
    for (position, row) in rows.iter().enumerate() {
      groups.entry(row.parent_id.clone()).or_default().push(position);
    }
    for (parent_id, mut positions) in groups {
      let existing = self
        .rows
        .iter()
        .filter(|row| row.parent_id == parent_id)
        .collect::<Vec<_>>();
      if existing.iter().any(|row| !is_valid_order_key(&row.index)) {
        return Err(OrganizerError::ReindexRequired);
      }
      positions.sort_by(|left, right| {
        rows[*left]
          .index
          .cmp(&rows[*right].index)
          .then_with(|| rows[*left].id.cmp(&rows[*right].id))
      });
      let mut lower = existing.iter().map(|row| row.index.clone()).max();
      for position in positions {
        let index = generate_order_key_between(lower.as_deref(), None)?;
        rows[position].index = index.clone();
        lower = Some(index);
      }
    }
    Ok(())
  }

  /// New top-level placements belong to the destination's structural root,
  /// whether they come from Copy, Move or normal folder creation.
  fn workspace_root_id(&self) -> Option<String> {
    self
      .rows
      .iter()
      .find(|row| row.is_workspace_root())
      .map(|row| row.id.clone())
  }

  fn attach_to_workspace_root(&self, rows: &mut [OrganizerRow]) {
    if let Some(root_id) = self.workspace_root_id() {
      for row in rows
        .iter_mut()
        .filter(|row| row.parent_id.is_none() && !row.is_workspace_root())
      {
        row.parent_id = Some(root_id.clone());
      }
    }
  }

  fn snapshot(&self, workspace_id: Uuid) -> Result<OrganizerSnapshot, OrganizerError> {
    self.validate(workspace_id)?;
    let mut children = BTreeMap::<Option<&str>, Vec<&OrganizerRow>>::new();
    for row in &self.rows {
      children.entry(row.parent_id.as_deref()).or_default().push(row);
    }
    for rows in children.values_mut() {
      rows.sort_by(|left, right| left.index.cmp(&right.index).then_with(|| left.id.cmp(&right.id)));
    }
    let roots = build_snapshot_nodes(None, &children);
    Ok(OrganizerSnapshot {
      workspace_id,
      revision: self.revision.clone(),
      roots,
    })
  }

  fn assert_folder(&self, folder_id: &str) -> Result<(), OrganizerError> {
    if self.rows.iter().any(|row| row.id == folder_id && row.is_folder()) {
      Ok(())
    } else {
      Err(OrganizerError::BrokenParent(folder_id.to_string()))
    }
  }

  fn ancestor_chain(&self, folder_id: &str) -> Result<Vec<String>, OrganizerError> {
    let mut chain = Vec::new();
    let mut current = Some(folder_id);
    let mut seen = HashSet::new();
    while let Some(id) = current {
      if !seen.insert(id) {
        return Err(OrganizerError::Cycle(id.to_string()));
      }
      chain.push(id.to_string());
      let row = self
        .rows
        .iter()
        .find(|row| row.id == id)
        .ok_or_else(|| OrganizerError::BrokenParent(id.to_string()))?;
      current = row.parent_id.as_deref();
    }
    Ok(chain)
  }

  fn is_ancestor(&self, child_id: &str, possible_ancestor: &str) -> Result<bool, OrganizerError> {
    Ok(
      self
        .ancestor_chain(child_id)?
        .iter()
        .skip(1)
        .any(|id| id == possible_ancestor),
    )
  }

  fn subtree_ids(&self, folder_id: &str) -> Result<Vec<String>, OrganizerError> {
    self.ancestor_chain(folder_id)?;
    let mut result = Vec::new();
    let mut stack = vec![folder_id.to_string()];
    while let Some(id) = stack.pop() {
      if result.contains(&id) {
        return Err(OrganizerError::Cycle(id));
      }
      result.push(id.clone());
      let mut child_ids = self
        .rows
        .iter()
        .filter(|row| row.parent_id.as_deref() == Some(id.as_str()))
        .map(|row| row.id.clone())
        .collect::<Vec<_>>();
      child_ids.sort();
      child_ids.reverse();
      stack.extend(child_ids);
    }
    Ok(result)
  }

  fn assert_unique_link(
    &self,
    candidate: &OrganizerRow,
    ignored_id: Option<&str>,
    workspace_id: Uuid,
  ) -> Result<(), OrganizerError> {
    let candidate_type = candidate.link_type()?;
    let candidate_workspace = candidate.effective_target_workspace_id(workspace_id);
    if self.rows.iter().any(|row| {
      !row.is_folder()
        && Some(row.id.as_str()) != ignored_id
        && row.link_type().ok() == Some(candidate_type)
        && row.effective_target_workspace_id(workspace_id) == candidate_workspace
        && row.data == candidate.data
    }) {
      Err(OrganizerError::DuplicateResource)
    } else {
      Ok(())
    }
  }

  /// Tag reconciliation can merge several source IDs. Preserve the existing
  /// canonical placement, otherwise the first stable incoming placement, just
  /// as document classifications deduplicate their mapped Tag IDs.
  fn retain_unique_tag_links(&self, rows: &mut Vec<OrganizerRow>, workspace_id: Uuid) {
    let mut targets = self
      .rows
      .iter()
      .filter(|row| row.row_type == OrganizerLinkType::Tag.as_str())
      .map(|row| (row.effective_target_workspace_id(workspace_id), row.data.clone()))
      .collect::<BTreeSet<_>>();
    rows.retain(|row| {
      row.row_type != OrganizerLinkType::Tag.as_str()
        || targets.insert((row.effective_target_workspace_id(workspace_id), row.data.clone()))
        || self.rows.iter().any(|existing| existing == row)
    });
  }

  fn write_row(&mut self, record: &OrganizerRow, maintain_index: bool) -> Result<Vec<u8>, OrganizerError> {
    let index_map = self.doc.get_or_insert_map(FOLDER_INDEX_MAP);
    let row = self.doc.get_or_insert_map(record.id.as_str());
    Ok(self.mutate(|txn| {
      row.insert(txn, "id", record.id.clone());
      insert_optional_string(&row, txn, "parentId", record.parent_id.clone());
      row.insert(txn, "data", record.data.clone());
      row.insert(txn, "type", record.row_type.clone());
      row.insert(txn, "index", record.index.clone());
      insert_optional_uuid(&row, txn, "targetWorkspaceId", record.target_workspace_id);
      if maintain_index {
        index_map.insert(txn, DELETED_FLAG, true);
        index_map.insert(txn, record.id.clone(), true);
      }
    }))
  }

  fn write_rows(&mut self, records: &[OrganizerRow], workspace_id: Uuid) -> Result<Vec<u8>, OrganizerError> {
    for record in records.iter().filter(|record| !record.is_folder()) {
      validate_link_target(record.link_type()?, &record.data, record.target_workspace_id)?;
    }
    let before = self.doc.transact().state_vector();
    let index_map = self.doc.get_or_insert_map(FOLDER_INDEX_MAP);
    let rows = records
      .iter()
      .map(|record| (record, self.doc.get_or_insert_map(record.id.as_str())))
      .collect::<Vec<_>>();
    {
      let mut txn = self.doc.transact_mut();
      for (record, row) in &rows {
        row.remove(&mut txn, DELETED_FLAG);
        row.insert(&mut txn, "id", record.id.clone());
        insert_optional_string(row, &mut txn, "parentId", record.parent_id.clone());
        row.insert(&mut txn, "data", record.data.clone());
        row.insert(&mut txn, "type", record.row_type.clone());
        row.insert(&mut txn, "index", record.index.clone());
        insert_optional_uuid(row, &mut txn, "targetWorkspaceId", record.target_workspace_id);
        index_map.insert(&mut txn, DELETED_FLAG, true);
        index_map.insert(&mut txn, record.id.clone(), true);
      }
    }
    // Yjs writes replace maps by row identity; keep the validation projection
    // consistent when the caller admitted an existing Extract placeholder.
    self
      .rows
      .retain(|row| !records.iter().any(|record| record.id == row.id));
    self.rows.extend(records.iter().cloned());
    self.validate(workspace_id)?;
    Ok(self.doc.transact().encode_state_as_update_v1(&before))
  }

  fn delete_rows(&mut self, row_ids: &[String]) -> Vec<u8> {
    let index_map = self.doc.get_or_insert_map(FOLDER_INDEX_MAP);
    let rows = row_ids
      .iter()
      .map(|id| (id, self.doc.get_or_insert_map(id.as_str())))
      .collect::<Vec<_>>();
    self.mutate(|txn| {
      index_map.insert(txn, DELETED_FLAG, true);
      for (id, row) in &rows {
        tombstone_organizer_row(row, txn, id);
        index_map.remove(txn, id.as_str());
      }
    })
  }

  fn replace_and_delete_rows(
    &mut self,
    replacements: &[OrganizerRow],
    row_ids: &[String],
    workspace_id: Uuid,
  ) -> Result<Vec<u8>, OrganizerError> {
    let before = self.doc.transact().state_vector();
    let index_map = self.doc.get_or_insert_map(FOLDER_INDEX_MAP);
    let replacement_rows = replacements
      .iter()
      .map(|record| (record, self.doc.get_or_insert_map(record.id.as_str())))
      .collect::<Vec<_>>();
    let deleted_rows = row_ids
      .iter()
      .map(|id| (id, self.doc.get_or_insert_map(id.as_str())))
      .collect::<Vec<_>>();
    {
      let mut txn = self.doc.transact_mut();
      for (record, row) in replacement_rows {
        row.insert(&mut txn, "id", record.id.clone());
        insert_optional_string(&row, &mut txn, "parentId", record.parent_id.clone());
        row.insert(&mut txn, "data", record.data.clone());
        row.insert(&mut txn, "type", record.row_type.clone());
        row.insert(&mut txn, "index", record.index.clone());
        insert_optional_uuid(&row, &mut txn, "targetWorkspaceId", record.target_workspace_id);
      }
      for (id, row) in deleted_rows {
        tombstone_organizer_row(&row, &mut txn, id);
        index_map.remove(&mut txn, id.as_str());
      }
    }
    self.rows.retain(|row| !row_ids.contains(&row.id));
    for replacement in replacements {
      if let Some(row) = self.rows.iter_mut().find(|row| row.id == replacement.id) {
        *row = replacement.clone();
      }
    }
    self.validate(workspace_id)?;
    Ok(self.doc.transact().encode_state_as_update_v1(&before))
  }

  fn mutate<F>(&mut self, mutate: F) -> Vec<u8>
  where
    F: FnOnce(&mut TransactionMut),
  {
    let mut txn = self.doc.transact_mut();
    mutate(&mut txn);
    // Full-state updates include newly created root maps in yrs 0.17 and remain
    // idempotent when appended to the collaborative document update stream.
    txn.encode_state_as_update_v1(&StateVector::default())
  }
}

fn decode_rows(doc: &Doc) -> Result<Vec<OrganizerRow>, OrganizerError> {
  let ids = {
    let index = doc.get_or_insert_map(FOLDER_INDEX_MAP);
    let txn = doc.transact();
    let mut ids = index
      .iter(&txn)
      .filter_map(|(id, value)| match value {
        YrsValue::Any(Any::Bool(true)) if id != DELETED_FLAG => Some(id.to_string()),
        _ => None,
      })
      .collect::<Vec<_>>();
    if ids.is_empty() {
      ids.extend(txn.root_refs().filter_map(|(id, value)| {
        if id == FOLDER_INDEX_MAP {
          return None;
        }
        value.cast::<MapRef>().ok().map(|_| id.to_string())
      }));
    }
    ids.sort();
    ids.dedup();
    ids
  };
  let row_maps = ids
    .iter()
    .map(|id| (id, doc.get_or_insert_map(id.as_str())))
    .collect::<Vec<_>>();
  let txn = doc.transact();
  let mut rows = Vec::new();
  for (root_id, map) in row_maps {
    if matches!(map.get(&txn, DELETED_FLAG), Some(YrsValue::Any(Any::Bool(true)))) {
      continue;
    }
    let id = map_optional_string(&map, &txn, "id")
      .map_err(|_| OrganizerError::MalformedRow(root_id.clone()))?
      .unwrap_or_else(|| root_id.clone());
    let row_type = map_optional_string(&map, &txn, "type")
      .map_err(|_| OrganizerError::MalformedRow(id.clone()))?
      .ok_or_else(|| OrganizerError::MalformedRow(id.clone()))?;
    let data = map_optional_string(&map, &txn, "data")
      .map_err(|_| OrganizerError::MalformedRow(id.clone()))?
      .ok_or_else(|| OrganizerError::MalformedRow(id.clone()))?;
    let target_workspace_id = match map_optional_string(&map, &txn, "targetWorkspaceId")
      .map_err(|_| OrganizerError::MalformedRow(id.clone()))?
    {
      Some(value) => Some(Uuid::parse_str(&value).map_err(|_| OrganizerError::MalformedRow(id.clone()))?),
      None => None,
    };
    rows.push(OrganizerRow {
      id,
      parent_id: map_optional_string(&map, &txn, "parentId")
        .map_err(|_| OrganizerError::MalformedRow(root_id.clone()))?,
      data,
      row_type,
      index: map_optional_string(&map, &txn, "index")
        .map_err(|_| OrganizerError::MalformedRow(root_id.clone()))?
        .unwrap_or_default(),
      target_workspace_id,
    });
  }
  Ok(rows)
}

fn map_optional_string<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> Result<Option<String>, ()> {
  match map.get(txn, key) {
    Some(YrsValue::Any(Any::String(value))) => Ok(Some(value.to_string())),
    Some(YrsValue::Any(Any::Null | Any::Undefined)) | None => Ok(None),
    _ => Err(()),
  }
}

fn insert_optional_string(map: &MapRef, txn: &mut TransactionMut, key: &str, value: Option<String>) {
  if let Some(value) = value {
    map.insert(txn, key, value);
  } else {
    map.insert(txn, key, Any::Null);
  }
}

fn tombstone_organizer_row(row: &MapRef, txn: &mut TransactionMut, id: &str) {
  // Browser ORM observers key rows by `id`, including tombstones. Both normal
  // deletion and Move must retain it to withdraw subscribed source rows.
  row.insert(txn, "id", id);
  for field in ["parentId", "data", "type", "index", "targetWorkspaceId"] {
    row.remove(txn, field);
  }
  row.insert(txn, DELETED_FLAG, true);
}

fn insert_optional_uuid(map: &MapRef, txn: &mut TransactionMut, key: &str, value: Option<Uuid>) {
  if let Some(value) = value {
    map.insert(txn, key, value.to_string());
  } else {
    map.remove(txn, key);
  }
}

/// Recheck the acknowledged destination against the currently locked native
/// Organizer. Renames are user edits; deletion or a type change is unavailable.
pub fn verify_project_starter_destination(
  payload: &[u8],
  accepted: &crate::workspace::AcceptedProjectStarter,
) -> Result<(), OrganizerError> {
  verify_document_starter_destination(payload, &accepted.document_receipt())
}
pub fn verify_document_starter_destination(
  payload: &[u8],
  accepted: &crate::workspace::StarterDocumentReceipt,
) -> Result<(), OrganizerError> {
  let document = OrganizerDocument::decode(payload.to_vec())?;
  document.validate(accepted.workspace_id)?;
  document.assert_folder(accepted.folder_id.as_ref().ok_or(OrganizerError::InvalidTarget)?)
}

/// Check the canonical postwrite projection before acknowledging placement.
pub fn verify_project_starter_placement(
  payload: &[u8],
  accepted: &crate::workspace::AcceptedProjectStarter,
  stage: &crate::workspace::ProjectPlacementStage,
) -> Result<(), OrganizerError> {
  verify_document_starter_placement(payload, &accepted.document_receipt(), stage)
}
fn starter_setup_link(
  accepted: &crate::workspace::StarterDocumentReceipt,
  component: &str,
) -> Result<(String, OrganizerLinkType, String), OrganizerError> {
  let crate::workspace::StarterDocumentOrigin::WorkspaceSetup { links } = &accepted.origin else {
    return Err(OrganizerError::InvalidTarget);
  };
  let link = links.get(component).ok_or(OrganizerError::InvalidTarget)?;
  let (kind, target) = match &link.target {
    myoxus_domain::workspace_automation::WorkspaceSetupResult::Database { database_id } => {
      (OrganizerLinkType::Database, database_id.to_string())
    }
    myoxus_domain::workspace_automation::WorkspaceSetupResult::Document { document_id } => {
      let document = accepted
        .progress
        .documents
        .values()
        .find(|document| document.doc_id == *document_id)
        .ok_or(OrganizerError::InvalidTarget)?;
      (OrganizerLinkType::Doc, document.external_id.clone())
    }
    _ => return Err(OrganizerError::InvalidTarget),
  };
  Ok((link.entry_id.clone(), kind, target))
}

pub fn verify_document_starter_placement(
  payload: &[u8],
  accepted: &crate::workspace::StarterDocumentReceipt,
  stage: &crate::workspace::ProjectPlacementStage,
) -> Result<(), OrganizerError> {
  let document = OrganizerDocument::decode(payload.to_vec())?;
  document.validate(accepted.workspace_id)?;
  let folder = accepted.folder_id.as_ref().ok_or(OrganizerError::InvalidTarget)?;
  document.assert_folder(folder)?;
  if let (
    crate::workspace::ProjectPlacementStage::Folder,
    Some(myoxus_domain::assistant_package::AssistantFolderDestination::New { name, parent }),
  ) = (stage, &accepted.folder)
  {
    let expected_parent = parent.clone().or_else(|| document.workspace_root_id());
    if !document
      .rows
      .iter()
      .any(|row| row.id == *folder && row.row_type == "folder" && row.data == *name && row.parent_id == expected_parent)
    {
      return Err(OrganizerError::InvalidTarget);
    }
  }
  let mut expected = Vec::new();
  match stage {
    crate::workspace::ProjectPlacementStage::Folder => {}
    crate::workspace::ProjectPlacementStage::NativeLink { component_id } => {
      let (entry, kind, target) = starter_setup_link(accepted, component_id)?;
      let kind = match kind {
        OrganizerLinkType::Database => "database",
        OrganizerLinkType::Doc => "doc",
        _ => return Err(OrganizerError::InvalidTarget),
      };
      // Setup entry identity is owned by the accepted native reservation.
      if !document.rows.iter().any(|row| {
        row.id == entry
          && row.row_type == kind
          && row.data == target
          && row.parent_id.as_ref() == Some(folder)
          && row.effective_target_workspace_id(accepted.workspace_id) == accepted.workspace_id
      }) {
        return Err(OrganizerError::InvalidTarget);
      }
    }
    crate::workspace::ProjectPlacementStage::CompleteDocuments => {
      for ids in &accepted.ids {
        let created = accepted
          .progress
          .documents
          .get(&ids.component_id)
          .ok_or(OrganizerError::InvalidTarget)?;
        expected.push((ids.entry_id.as_str(), "doc", created.external_id.clone()));
      }
    }
    crate::workspace::ProjectPlacementStage::Project => {
      let crate::workspace::StarterDocumentOrigin::Project { database_id, entry_id } = &accepted.origin else {
        return Err(OrganizerError::InvalidTarget);
      };
      expected.push((
        entry_id.as_deref().ok_or(OrganizerError::InvalidTarget)?,
        "database",
        database_id.to_string(),
      ));
      for ids in &accepted.ids {
        let created = accepted
          .progress
          .documents
          .get(&ids.component_id)
          .ok_or(OrganizerError::InvalidTarget)?;
        expected.push((ids.entry_id.as_str(), "doc", created.external_id.clone()));
      }
    }
    crate::workspace::ProjectPlacementStage::Document { component_id } => {
      let ids = accepted
        .ids
        .iter()
        .find(|ids| ids.component_id == *component_id)
        .ok_or(OrganizerError::InvalidTarget)?;
      let created = accepted
        .progress
        .documents
        .get(component_id)
        .ok_or(OrganizerError::InvalidTarget)?;
      expected.push((ids.entry_id.as_str(), "doc", created.external_id.clone()));
    }
  }
  for (id, kind, target) in expected {
    if !document.rows.iter().any(|row| {
      row.id == id
        && row.row_type == kind
        && row.data == target
        && row.parent_id.as_ref() == Some(folder)
        && row.effective_target_workspace_id(accepted.workspace_id) == accepted.workspace_id
    }) {
      return Err(OrganizerError::InvalidTarget);
    }
  }
  Ok(())
}

fn validate_folder_name(name: &str) -> Result<(), OrganizerError> {
  let length = name.chars().count();
  if length == 0 || length > MAX_FOLDER_NAME_CHARS {
    Err(OrganizerError::InvalidFolderName)
  } else {
    Ok(())
  }
}

/// Decisions bind the source revision and row ID. Unknown foreign existence
/// preserves qualification; live local ownership still requires its admitted map.
fn project_reference_row(
  row: &mut OrganizerRow,
  source_workspace_id: Uuid,
  target_workspace_id: Uuid,
  mappings: &BTreeMap<(WorkspaceContentResourceKind, String), WorkspaceContentResourceRef>,
  decisions: &[(String, WorkspaceContentReferenceDecision)],
) -> Result<(), OrganizerError> {
  let kind = organizer_resource_kind(row.link_type()?)?;
  let canonical = decisions
    .iter()
    .find(|(id, _)| id == &row.id)
    .and_then(|(_, decision)| match decision {
      WorkspaceContentReferenceDecision::Keep { target } | WorkspaceContentReferenceDecision::Remap { target } => {
        Some(target)
      }
      _ => None,
    });
  let scope = canonical.map_or_else(
    || row.effective_target_workspace_id(source_workspace_id),
    |target| target.workspace_id(),
  );
  let id = canonical.map_or(row.data.as_str(), |target| target.resource_id());
  if scope == source_workspace_id {
    let mapped = mappings
      .get(&(kind, id.to_string()))
      .ok_or(OrganizerError::InvalidTarget)?;
    row.data = mapped.resource_id().to_string();
    row.target_workspace_id = (mapped.workspace_id() != target_workspace_id).then_some(mapped.workspace_id());
  } else {
    row.data = id.to_string();
    row.target_workspace_id = Some(scope);
  }
  Ok(())
}

fn validate_link_target(
  link_type: OrganizerLinkType,
  target_id: &str,
  target_workspace_id: Option<Uuid>,
) -> Result<(), OrganizerError> {
  if target_id.trim().is_empty() {
    return Err(OrganizerError::InvalidTarget);
  }
  if link_type == OrganizerLinkType::Workspace {
    let target = Uuid::parse_str(target_id).map_err(|_| OrganizerError::InvalidWorkspaceTarget)?;
    if target_workspace_id != Some(target) {
      return Err(OrganizerError::InvalidWorkspaceTarget);
    }
  }
  Ok(())
}

fn build_snapshot_nodes(
  parent_id: Option<&str>,
  children: &BTreeMap<Option<&str>, Vec<&OrganizerRow>>,
) -> Vec<OrganizerSnapshotNode> {
  children
    .get(&parent_id)
    .into_iter()
    .flatten()
    .map(|row| OrganizerSnapshotNode {
      row: (*row).clone(),
      children: if row.is_folder() {
        build_snapshot_nodes(Some(row.id.as_str()), children)
      } else {
        Vec::new()
      },
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_domain::workspace_content_operation::WorkspaceContentResourceRef;
  use std::collections::HashMap;
  use std::sync::{Arc, Mutex};

  #[derive(Clone, Default)]
  struct MemoryPort {
    payload: Arc<Mutex<Vec<u8>>>,
  }

  #[async_trait]
  impl OrganizerDocumentPort for MemoryPort {
    async fn load_organizer_document(&self, _workspace_id: Uuid) -> Result<Vec<u8>, OrganizerError> {
      Ok(self.payload.lock().expect("payload lock").clone())
    }

    async fn persist_organizer_update(&self, _workspace_id: Uuid, update: Vec<u8>) -> Result<(), OrganizerError> {
      *self.payload.lock().expect("payload lock") = update;
      Ok(())
    }
  }

  fn folder(id: &str, parent_id: Option<&str>, index: &str) -> CreateOrganizerFolder {
    CreateOrganizerFolder {
      id: id.to_string(),
      parent_id: parent_id.map(ToOwned::to_owned),
      name: id.to_string(),
      index: Some(index.to_string()),
    }
  }

  #[derive(Clone, Default)]
  struct WorkspaceMemoryPort {
    payloads: Arc<Mutex<HashMap<Uuid, Vec<u8>>>>,
    roots: Arc<Mutex<HashMap<Uuid, Vec<u8>>>>,
  }

  #[async_trait]
  impl OrganizerDocumentPort for WorkspaceMemoryPort {
    async fn load_workspace_root_document(&self, workspace_id: Uuid) -> Result<Vec<u8>, OrganizerError> {
      self
        .roots
        .lock()
        .expect("root lock")
        .get(&workspace_id)
        .cloned()
        .ok_or(OrganizerError::Storage)
    }
    async fn load_organizer_document(&self, workspace_id: Uuid) -> Result<Vec<u8>, OrganizerError> {
      Ok(
        self
          .payloads
          .lock()
          .expect("payload lock")
          .get(&workspace_id)
          .cloned()
          .unwrap_or_default(),
      )
    }

    async fn persist_organizer_update(&self, workspace_id: Uuid, update: Vec<u8>) -> Result<(), OrganizerError> {
      let mut payloads = self.payloads.lock().expect("payload lock");
      let current = payloads.remove(&workspace_id).unwrap_or_default();
      let merged = yjs::merge_updates(vec![current, update]).map_err(|_| OrganizerError::Storage)?;
      payloads.insert(workspace_id, merged);
      Ok(())
    }
  }

  #[tokio::test]
  async fn uuid_default_organizer_control_preserves_explicit_order_and_non_order_mutations() {
    let workspace_id = Uuid::new_v4();
    let document_id = Uuid::new_v4();
    let port = MemoryPort::default();
    let service = OrganizerService::new(port);

    service
      .create_folder(workspace_id, folder("root", None, "a0"))
      .await
      .expect("create explicitly ordered root");
    service
      .create_link(
        workspace_id,
        CreateOrganizerLink {
          id: "document-link".to_string(),
          parent_id: "root".to_string(),
          link_type: OrganizerLinkType::Doc,
          target_id: document_id.to_string(),
          target_workspace_id: None,
          index: Some("a0".to_string()),
        },
      )
      .await
      .expect("create explicitly ordered document link");

    let renamed = service
      .update_folder(
        workspace_id,
        "root",
        UpdateOrganizerFolder {
          name: Some("Renamed root".to_string()),
          ..Default::default()
        },
      )
      .await
      .expect("rename folder without authoring order");
    assert_eq!(renamed.index, "a0");

    let retargeted = service
      .update_link(
        workspace_id,
        "document-link",
        UpdateOrganizerLink {
          target_id: Some(Uuid::new_v4().to_string()),
          ..Default::default()
        },
      )
      .await
      .expect("retarget link without authoring order");
    assert_eq!(retargeted.index, "a0");
    service
      .delete_link(workspace_id, "document-link")
      .await
      .expect("delete link without reading order as a bound");
    assert_eq!(service.delete_folder(workspace_id, "root").await.unwrap(), ["root"]);
  }

  #[tokio::test]
  async fn legacy_and_cross_workspace_rows_roundtrip_without_unknown_field_loss() {
    let workspace_id = Uuid::new_v4();
    let target_workspace_id = Uuid::new_v4();
    let port = MemoryPort::default();
    let service = OrganizerService::new(port.clone());
    service
      .create_folder(workspace_id, folder("root", None, "a0"))
      .await
      .expect("create root");
    service
      .create_link(
        workspace_id,
        CreateOrganizerLink {
          id: "local".to_string(),
          parent_id: "root".to_string(),
          link_type: OrganizerLinkType::Doc,
          target_id: "doc-local".to_string(),
          target_workspace_id: None,
          index: Some("a0".to_string()),
        },
      )
      .await
      .expect("create legacy-local link");
    service
      .create_link(
        workspace_id,
        CreateOrganizerLink {
          id: "remote".to_string(),
          parent_id: "root".to_string(),
          link_type: OrganizerLinkType::Database,
          target_id: "database-remote".to_string(),
          target_workspace_id: Some(target_workspace_id),
          index: Some("a1".to_string()),
        },
      )
      .await
      .expect("create cross-workspace link");
    service
      .create_link(
        workspace_id,
        CreateOrganizerLink {
          id: "explicit-local".to_string(),
          parent_id: "root".to_string(),
          link_type: OrganizerLinkType::Tag,
          target_id: "tag-local".to_string(),
          target_workspace_id: Some(workspace_id),
          index: Some("a2".to_string()),
        },
      )
      .await
      .expect("accept explicit owner workspace");

    let payload = port.payload.lock().expect("payload lock").clone();
    let mut doc = OrganizerDocument::decode(payload).expect("decode rows");
    let remote = doc.rows.iter().find(|row| row.id == "remote").expect("remote row");
    assert_eq!(remote.target_workspace_id, Some(target_workspace_id));
    let local = doc.rows.iter().find(|row| row.id == "local").expect("local row");
    assert_eq!(local.target_workspace_id, None);
    let explicit_local = doc
      .rows
      .iter()
      .find(|row| row.id == "explicit-local")
      .expect("explicit local row");
    assert_eq!(explicit_local.target_workspace_id, Some(workspace_id));

    let remote_map = doc.doc.get_or_insert_map("remote");
    let with_unknown = doc.mutate(|txn| {
      remote_map.insert(txn, "futureColumn", "preserve-me");
    });
    *port.payload.lock().expect("payload lock") = with_unknown;
    service
      .update_link(
        workspace_id,
        "remote",
        UpdateOrganizerLink {
          index: Some("a2".to_string()),
          ..Default::default()
        },
      )
      .await
      .expect("update known field");
    let mut decoded =
      OrganizerDocument::decode(port.payload.lock().expect("payload lock").clone()).expect("decode update");
    let map = decoded.doc.get_or_insert_map("remote");
    assert_eq!(
      map_optional_string(&map, &decoded.doc.transact(), "futureColumn")
        .expect("known string field")
        .as_deref(),
      Some("preserve-me")
    );
    let malformed = decoded.mutate(|txn| {
      map.insert(txn, "targetWorkspaceId", 17_i64);
    });
    assert!(matches!(
      OrganizerDocument::decode(malformed),
      Err(OrganizerError::MalformedRow(id)) if id == "remote"
    ));
  }

  #[tokio::test]
  async fn recursive_snapshot_is_stable_and_rejects_structural_corruption() {
    let workspace_id = Uuid::new_v4();
    let port = MemoryPort::default();
    let service = OrganizerService::new(port.clone());
    service
      .create_folder(workspace_id, folder("root", None, "a1"))
      .await
      .expect("create root");
    service
      .create_folder(workspace_id, folder("child", Some("root"), "a0"))
      .await
      .expect("create child");
    service
      .create_link(
        workspace_id,
        CreateOrganizerLink {
          id: "doc".to_string(),
          parent_id: "child".to_string(),
          link_type: OrganizerLinkType::Doc,
          target_id: "doc-1".to_string(),
          target_workspace_id: None,
          index: Some("a0".to_string()),
        },
      )
      .await
      .expect("create link");
    let first = service.snapshot(workspace_id).await.expect("snapshot");
    let second = service.snapshot(workspace_id).await.expect("snapshot replay");
    assert_eq!(first, second);
    assert_eq!(first.roots[0].children[0].children[0].row.id, "doc");

    let mut document = OrganizerDocument::decode(port.payload.lock().expect("payload lock").clone()).expect("decode");
    let root = document.doc.get_or_insert_map("root");
    let corrupt = document.mutate(|txn| {
      root.insert(txn, "parentId", "child");
    });
    *port.payload.lock().expect("payload lock") = corrupt;
    assert!(matches!(
      service.snapshot(workspace_id).await,
      Err(OrganizerError::Cycle(_))
    ));
  }

  #[tokio::test]
  async fn mutations_reject_duplicates_broken_parents_and_descendant_moves() {
    let workspace_id = Uuid::new_v4();
    let port = MemoryPort::default();
    let service = OrganizerService::new(port);
    service
      .create_folder(workspace_id, folder("root", None, "a0"))
      .await
      .expect("create root");
    service
      .create_folder(workspace_id, folder("child", Some("root"), "a0"))
      .await
      .expect("create child");
    assert!(matches!(
      service
        .update_folder(
          workspace_id,
          "root",
          UpdateOrganizerFolder {
            parent_id: Some(Some("child".to_string())),
            ..Default::default()
          },
        )
        .await,
      Err(OrganizerError::Cycle(_))
    ));
    assert!(matches!(
      service
        .create_link(
          workspace_id,
          CreateOrganizerLink {
            id: "broken".to_string(),
            parent_id: "missing".to_string(),
            link_type: OrganizerLinkType::Tag,
            target_id: "tag-1".to_string(),
            target_workspace_id: None,
            index: Some("a0".to_string()),
          },
        )
        .await,
      Err(OrganizerError::BrokenParent(_))
    ));
    service
      .create_link(
        workspace_id,
        CreateOrganizerLink {
          id: "tag-a".to_string(),
          parent_id: "root".to_string(),
          link_type: OrganizerLinkType::Tag,
          target_id: "tag-1".to_string(),
          target_workspace_id: None,
          index: Some("a0".to_string()),
        },
      )
      .await
      .expect("create tag");
    assert_eq!(
      service
        .create_link(
          workspace_id,
          CreateOrganizerLink {
            id: "tag-b".to_string(),
            parent_id: "child".to_string(),
            link_type: OrganizerLinkType::Tag,
            target_id: "tag-1".to_string(),
            target_workspace_id: None,
            index: Some("a1".to_string()),
          },
        )
        .await,
      Err(OrganizerError::DuplicateResource)
    );
  }

  #[tokio::test]
  async fn operation_link_projection_is_pure_and_rejects_conflicting_reuse() {
    let workspace_id = Uuid::new_v4();
    let target_workspace_id = Uuid::new_v4();
    let port = MemoryPort::default();
    let service = OrganizerService::new(port.clone());
    service
      .create_folder(workspace_id, folder("root", None, "a0"))
      .await
      .expect("create root");
    let request = CreateOrganizerLink {
      id: "operation-link".to_string(),
      parent_id: "root".to_string(),
      link_type: OrganizerLinkType::Doc,
      target_id: Uuid::new_v4().to_string(),
      target_workspace_id: Some(target_workspace_id),
      index: Some("a1".to_string()),
    };

    let projection = service
      .project_operation_link(workspace_id, request.clone())
      .await
      .expect("project operation link");
    assert!(!projection.update.is_empty());
    assert_eq!(projection.row.id, request.id);
    assert_eq!(service.snapshot(workspace_id).await.unwrap().roots[0].children.len(), 0);

    port
      .persist_organizer_update(workspace_id, projection.update)
      .await
      .unwrap();
    let replay = service
      .project_operation_link(workspace_id, request.clone())
      .await
      .expect("project exact replay");
    assert!(replay.update.is_empty());
    assert_eq!(replay.row.id, request.id);

    assert_eq!(
      service
        .project_operation_link(
          workspace_id,
          CreateOrganizerLink {
            target_id: Uuid::new_v4().to_string(),
            ..request
          },
        )
        .await
        .expect_err("entry identity cannot be reused for another target"),
      OrganizerError::DuplicateResource
    );
  }

  #[tokio::test]
  async fn extracted_root_keeps_identity_and_accepts_normal_copy_and_move_placements() {
    let source = Uuid::new_v4();
    let target = Uuid::new_v4();
    let port = WorkspaceMemoryPort::default();
    let service = OrganizerService::new(port.clone());
    for request in [
      folder("root", None, "a0"),
      folder("child", Some("root"), "a0"),
      folder("incoming", None, "a1"),
    ] {
      service.create_folder(source, request).await.unwrap();
    }
    let mapping = |id: &str, target_id: &str| {
      WorkspaceContentIdMapping::new(
        WorkspaceContentResourceRef::new(source, WorkspaceContentResourceKind::Folder, id).unwrap(),
        WorkspaceContentResourceRef::new(target, WorkspaceContentResourceKind::Folder, target_id).unwrap(),
      )
      .unwrap()
    };
    let extract = service
      .project_extract(
        source,
        target,
        "root",
        &[mapping("root", "root"), mapping("child", "child")],
        &[],
      )
      .await
      .unwrap();
    port
      .persist_organizer_update(source, extract.source_update)
      .await
      .unwrap();
    port
      .persist_organizer_update(target, extract.target_update)
      .await
      .unwrap();
    let snapshot = service.snapshot(target).await.unwrap();
    assert_eq!(snapshot.roots.len(), 1);
    assert!(snapshot.roots[0].row.is_workspace_root());
    assert_eq!(snapshot.roots[0].row.id, "root");
    assert_eq!(snapshot.roots[0].children[0].row.id, "child");
    assert_eq!(
      resolve_organizer_folder_id(&snapshot, "root").unwrap().path,
      Vec::<String>::new()
    );
    assert_eq!(resolve_organizer_folder_id(&snapshot, "child").unwrap().path, ["child"]);
    assert_eq!(
      resolve_organizer_folder_path(&snapshot, &["child".into()])
        .unwrap()
        .folder_id,
      "child"
    );
    let created = service
      .create_folder(target, folder("created", None, "a1"))
      .await
      .unwrap();
    assert_eq!(created.parent_id.as_deref(), Some("root"));
    for parent in [Some("created".into()), None] {
      let updated = service
        .update_folder(
          target,
          "child",
          UpdateOrganizerFolder {
            parent_id: Some(parent),
            ..Default::default()
          },
        )
        .await
        .unwrap();
      assert_eq!(updated.id, "child");
    }
    let snapshot = service.snapshot(target).await.unwrap();
    assert_eq!(
      snapshot.roots[0]
        .children
        .iter()
        .filter(|node| node.row.id == "child")
        .count(),
      1
    );
    let copy = service
      .project_copy(Uuid::new_v4(), source, target, &[mapping("incoming", "copied")], &[])
      .await
      .unwrap();
    assert_eq!(copy.rows[0].parent_id.as_deref(), Some("root"));
    port.persist_organizer_update(target, copy.update).await.unwrap();
    let moved = service
      .project_move(source, target, &[mapping("incoming", "incoming")], &[])
      .await
      .unwrap();
    assert_eq!(moved.target_rows[0].parent_id.as_deref(), Some("root"));
    port
      .persist_organizer_update(target, moved.target_update)
      .await
      .unwrap();
    assert_eq!(service.snapshot(target).await.unwrap().roots[0].children.len(), 4);
    assert_eq!(
      service.delete_folder(target, "root").await.unwrap_err(),
      OrganizerError::InvalidTarget
    );
  }

  #[tokio::test]
  async fn copy_projection_preserves_the_selected_tree_and_rewrites_resource_links() {
    let source_workspace_id = Uuid::new_v4();
    let target_workspace_id = Uuid::new_v4();
    let operation_id = Uuid::new_v4();
    let source_doc_id = "source-doc";
    let target_doc_id = "target-doc";
    let port = WorkspaceMemoryPort::default();
    let service = OrganizerService::new(port.clone());
    service
      .create_folder(source_workspace_id, folder("root", None, "a0"))
      .await
      .unwrap();
    service
      .create_folder(source_workspace_id, folder("child", Some("root"), "a1"))
      .await
      .unwrap();
    service
      .create_link(
        source_workspace_id,
        CreateOrganizerLink {
          id: "source-link".to_string(),
          parent_id: "child".to_string(),
          link_type: OrganizerLinkType::Doc,
          target_id: source_doc_id.to_string(),
          target_workspace_id: None,
          index: Some("a2".to_string()),
        },
      )
      .await
      .unwrap();
    let mapping = |kind, source: &str, target: &str| {
      WorkspaceContentIdMapping::new(
        WorkspaceContentResourceRef::new(source_workspace_id, kind, source).unwrap(),
        WorkspaceContentResourceRef::new(target_workspace_id, kind, target).unwrap(),
      )
      .unwrap()
    };
    let source_tags = [Uuid::new_v4(), Uuid::new_v4()];
    let target_tag = Uuid::new_v4();
    for (position, tag) in source_tags.iter().enumerate() {
      service
        .create_link(
          source_workspace_id,
          CreateOrganizerLink {
            id: format!("tag-placement-{position}"),
            parent_id: "child".into(),
            link_type: OrganizerLinkType::Tag,
            target_id: tag.to_string(),
            target_workspace_id: None,
            index: Some(format!("a{}", position + 3)),
          },
        )
        .await
        .unwrap();
    }
    let mut mappings = vec![
      mapping(WorkspaceContentResourceKind::Folder, "root", "target-root"),
      mapping(WorkspaceContentResourceKind::Folder, "child", "target-child"),
      mapping(WorkspaceContentResourceKind::Document, source_doc_id, target_doc_id),
    ];
    mappings.extend(source_tags.iter().map(|tag| {
      mapping(
        WorkspaceContentResourceKind::Tag,
        &tag.to_string(),
        &target_tag.to_string(),
      )
    }));
    let projection = service
      .project_copy(operation_id, source_workspace_id, target_workspace_id, &mappings, &[])
      .await
      .expect("project selected organizer subtree");
    assert_eq!(projection.rows.len(), 4);
    for rows in [
      projection.rows.clone(),
      service
        .project_move(source_workspace_id, target_workspace_id, &mappings, &[])
        .await
        .unwrap()
        .target_rows,
      service
        .project_extract(source_workspace_id, target_workspace_id, "root", &mappings, &[])
        .await
        .unwrap()
        .target_rows,
    ] {
      let tags = rows.iter().filter(|row| row.row_type == "tag").collect::<Vec<_>>();
      assert_eq!(
        tags.len(),
        1,
        "many-to-one Tag reconciliation respects canonical Organizer uniqueness"
      );
      assert_eq!(tags[0].data, target_tag.to_string());
    }
    assert_eq!(
      projection
        .rows
        .iter()
        .find(|row| row.id == "target-child")
        .and_then(|row| row.parent_id.as_deref()),
      Some("target-root")
    );
    let target_link = projection
      .rows
      .iter()
      .find(|row| row.row_type == "doc")
      .expect("projected resource link");
    assert_eq!(target_link.data, target_doc_id);
    assert_eq!(target_link.parent_id.as_deref(), Some("target-child"));
    assert_eq!(target_link.target_workspace_id, None);
    port
      .persist_organizer_update(target_workspace_id, projection.update)
      .await
      .unwrap();
    assert_eq!(
      service.snapshot(target_workspace_id).await.unwrap().roots[0].row.id,
      "target-root"
    );
  }

  #[tokio::test]
  async fn collection_shortcuts_are_catalog_checked_lateral_references_in_all_transfer_projections() {
    let source = Uuid::new_v4();
    let target = Uuid::new_v4();
    let foreign = Uuid::new_v4();
    let port = WorkspaceMemoryPort::default();
    let service = OrganizerService::new(port.clone());
    let root = Doc::new();
    let setting = root.get_or_insert_map("setting");
    let catalog = Any::Array(
      vec![Any::Map(Arc::new(HashMap::from([
        ("id".to_string(), Any::from("local")),
        (
          "rules".to_string(),
          Any::Map(Arc::new(HashMap::from([(
            "future".to_string(),
            Any::from("preserved"),
          )]))),
        ),
      ])))]
      .into(),
    );
    setting.insert(&mut root.transact_mut(), "collections", catalog);
    let root_bytes = root.transact().encode_state_as_update_v1(&StateVector::default());
    port.roots.lock().unwrap().insert(source, root_bytes.clone());
    service.create_folder(source, folder("root", None, "a0")).await.unwrap();
    for (id, data, workspace, index) in [
      ("local-placement", "local", None, "a0"),
      ("missing-placement", "missing", None, "a1"),
      ("foreign-placement", "unknown-in-foreign", Some(foreign), "a2"),
    ] {
      service
        .create_link(
          source,
          CreateOrganizerLink {
            id: id.into(),
            parent_id: "root".into(),
            link_type: OrganizerLinkType::Collection,
            target_id: data.into(),
            target_workspace_id: workspace,
            index: Some(index.into()),
          },
        )
        .await
        .unwrap();
    }
    let mappings = [WorkspaceContentIdMapping::new(
      WorkspaceContentResourceRef::new(source, WorkspaceContentResourceKind::Folder, "root").unwrap(),
      WorkspaceContentResourceRef::new(target, WorkspaceContentResourceKind::Folder, "target-root").unwrap(),
    )
    .unwrap()];
    let before = service.snapshot(source).await.unwrap();
    let copy = service
      .project_copy(Uuid::new_v4(), source, target, &mappings, &[])
      .await
      .unwrap();
    let moved = service.project_move(source, target, &mappings, &[]).await.unwrap();
    let extracted = service
      .project_extract(source, target, "root", &mappings, &[])
      .await
      .unwrap();
    for rows in [&copy.rows, &moved.target_rows, &extracted.target_rows] {
      assert_eq!(rows.len(), 3, "folder plus valid local and unproven foreign references");
      assert!(
        rows
          .iter()
          .any(|row| row.data == "local" && row.target_workspace_id == Some(source))
      );
      assert!(
        rows
          .iter()
          .any(|row| row.data == "unknown-in-foreign" && row.target_workspace_id == Some(foreign))
      );
      assert!(!rows.iter().any(|row| row.data == "missing"));
    }
    assert_eq!(
      service.snapshot(source).await.unwrap(),
      before,
      "projections do not write the source"
    );
    assert_eq!(
      port.roots.lock().unwrap().get(&source),
      Some(&root_bytes),
      "catalog and unknown rules are untouched"
    );
    port.roots.lock().unwrap().remove(&source);
    assert_eq!(
      service
        .project_copy(Uuid::new_v4(), source, target, &mappings, &[])
        .await
        .unwrap_err(),
      OrganizerError::Storage,
      "unknown catalog state is never treated as proof of absence"
    );
    let ownership = WorkspaceContentIdMapping::new(
      WorkspaceContentResourceRef::new(source, WorkspaceContentResourceKind::Collection, "local").unwrap(),
      WorkspaceContentResourceRef::new(target, WorkspaceContentResourceKind::Collection, "other").unwrap(),
    )
    .unwrap();
    assert_eq!(
      service
        .project_move(source, target, &[ownership], &[])
        .await
        .unwrap_err(),
      OrganizerError::UnsupportedLinkType
    );
  }

  #[tokio::test]
  async fn move_projection_transfers_selected_tree_and_preserves_external_source_links() {
    let source_workspace_id = Uuid::new_v4();
    let target_workspace_id = Uuid::new_v4();
    let port = WorkspaceMemoryPort::default();
    let service = OrganizerService::new(port.clone());
    service
      .create_folder(source_workspace_id, folder("moved", None, "a0"))
      .await
      .unwrap();
    service
      .create_folder(source_workspace_id, folder("retained", None, "a1"))
      .await
      .unwrap();
    for (id, parent, target, index) in [
      ("moved-link", "moved", "doc-a", "a0"),
      ("retained-link", "retained", "doc-b", "a1"),
    ] {
      service
        .create_link(
          source_workspace_id,
          CreateOrganizerLink {
            id: id.to_string(),
            parent_id: parent.to_string(),
            link_type: OrganizerLinkType::Doc,
            target_id: target.to_string(),
            target_workspace_id: None,
            index: Some(index.to_string()),
          },
        )
        .await
        .unwrap();
    }
    let source_tag = Uuid::new_v4();
    service
      .create_link(
        source_workspace_id,
        CreateOrganizerLink {
          id: "retained-tag".into(),
          parent_id: "retained".into(),
          link_type: OrganizerLinkType::Tag,
          target_id: source_tag.to_string(),
          target_workspace_id: None,
          index: Some("a2".into()),
        },
      )
      .await
      .unwrap();
    let tag_mapping = WorkspaceContentIdMapping::new(
      WorkspaceContentResourceRef::new(
        source_workspace_id,
        WorkspaceContentResourceKind::Tag,
        source_tag.to_string(),
      )
      .unwrap(),
      WorkspaceContentResourceRef::new(
        target_workspace_id,
        WorkspaceContentResourceKind::Tag,
        Uuid::new_v4().to_string(),
      )
      .unwrap(),
    )
    .unwrap();
    let mapping = |kind, id: &str| {
      WorkspaceContentIdMapping::new(
        WorkspaceContentResourceRef::new(source_workspace_id, kind, id).unwrap(),
        WorkspaceContentResourceRef::new(target_workspace_id, kind, id).unwrap(),
      )
      .unwrap()
    };
    let projection = service
      .project_move(
        source_workspace_id,
        target_workspace_id,
        &[
          mapping(WorkspaceContentResourceKind::Folder, "moved"),
          mapping(WorkspaceContentResourceKind::Document, "doc-a"),
          mapping(WorkspaceContentResourceKind::Document, "doc-b"),
          tag_mapping,
        ],
        &[],
      )
      .await
      .expect("project move");

    assert_eq!(
      projection
        .target_rows
        .iter()
        .map(|row| row.id.as_str())
        .collect::<Vec<_>>(),
      vec!["moved", "moved-link"]
    );
    let retained = projection
      .source_rows
      .iter()
      .find(|row| row.id == "retained-link")
      .expect("outside source link remains");
    assert_eq!(retained.data, "doc-b");
    assert_eq!(retained.target_workspace_id, Some(target_workspace_id));
    assert!(!projection.source_update.is_empty());
    assert!(!projection.target_update.is_empty());
    assert!(!projection.source_rows.iter().any(|row| row.id == "retained-tag"));
    port
      .persist_organizer_update(source_workspace_id, projection.source_update)
      .await
      .unwrap();
    let after = service.snapshot(source_workspace_id).await.unwrap();
    let deleted_source = service.load_document(source_workspace_id).await.unwrap();
    let deleted_folder = deleted_source.doc.get_or_insert_map("moved");
    let txn = deleted_source.doc.transact();
    assert_eq!(
      map_optional_string(&deleted_folder, &txn, "id").unwrap().as_deref(),
      Some("moved")
    );
    assert!(matches!(
      deleted_folder.get(&txn, DELETED_FLAG),
      Some(YrsValue::Any(Any::Bool(true)))
    ));
    let tag = after
      .roots
      .iter()
      .find(|node| node.row.id == "retained")
      .unwrap()
      .children
      .iter()
      .find(|node| node.row.id == "retained-tag")
      .unwrap();
    assert_eq!(tag.row.data, source_tag.to_string());
    assert_eq!(
      tag.row.target_workspace_id, None,
      "the retained source catalog is still local"
    );
  }

  #[tokio::test]
  async fn transfer_preserves_unrelated_links_and_moves_links_inside_the_selected_tree() {
    for extract in [false, true] {
      let source_workspace_id = Uuid::new_v4();
      let target_workspace_id = Uuid::new_v4();
      let remote_workspace_id = Uuid::new_v4();
      let linked_workspace_id = Uuid::new_v4();
      let unrelated_workspace_id = Uuid::new_v4();
      let port = WorkspaceMemoryPort::default();
      let service = OrganizerService::new(port.clone());
      service
        .create_folder(source_workspace_id, folder("moved", None, "a0"))
        .await
        .unwrap();
      service
        .create_folder(source_workspace_id, folder("retained", None, "a1"))
        .await
        .unwrap();
      for request in [
        CreateOrganizerLink {
          id: "remote-document".to_string(),
          parent_id: "moved".to_string(),
          link_type: OrganizerLinkType::Doc,
          target_id: "remote-doc".to_string(),
          target_workspace_id: Some(remote_workspace_id),
          index: Some("a0".to_string()),
        },
        CreateOrganizerLink {
          id: "nested-workspace".to_string(),
          parent_id: "moved".to_string(),
          link_type: OrganizerLinkType::Workspace,
          target_id: linked_workspace_id.to_string(),
          target_workspace_id: Some(linked_workspace_id),
          index: Some("a1".to_string()),
        },
        CreateOrganizerLink {
          id: "unrelated-workspace".to_string(),
          parent_id: "retained".to_string(),
          link_type: OrganizerLinkType::Workspace,
          target_id: unrelated_workspace_id.to_string(),
          target_workspace_id: Some(unrelated_workspace_id),
          index: Some("a0".to_string()),
        },
      ] {
        service.create_link(source_workspace_id, request).await.unwrap();
      }
      let folder_mapping = WorkspaceContentIdMapping::new(
        WorkspaceContentResourceRef::new(source_workspace_id, WorkspaceContentResourceKind::Folder, "moved").unwrap(),
        WorkspaceContentResourceRef::new(target_workspace_id, WorkspaceContentResourceKind::Folder, "moved").unwrap(),
      )
      .unwrap();

      let projection = if extract {
        service
          .project_extract(
            source_workspace_id,
            target_workspace_id,
            "moved",
            &[folder_mapping.clone()],
            &[],
          )
          .await
          .expect("project Extract with retained links")
      } else {
        service
          .project_move(source_workspace_id, target_workspace_id, &[folder_mapping.clone()], &[])
          .await
          .expect("project Move with retained links")
      };

      let remote = projection
        .target_rows
        .iter()
        .find(|row| row.id == "remote-document")
        .expect("cross-workspace document link is transferred");
      assert_eq!(remote.parent_id.as_deref(), Some("moved"));
      assert_eq!(remote.data, "remote-doc");
      assert_eq!(remote.target_workspace_id, Some(remote_workspace_id));
      let workspace = projection
        .target_rows
        .iter()
        .find(|row| row.id == "nested-workspace")
        .expect("Workspace link is transferred");
      assert_eq!(workspace.parent_id.as_deref(), Some("moved"));
      assert_eq!(workspace.target_workspace_id, Some(linked_workspace_id));

      port
        .persist_organizer_update(source_workspace_id, projection.source_update)
        .await
        .unwrap();
      port
        .persist_organizer_update(target_workspace_id, projection.target_update)
        .await
        .unwrap();
      let source = service.snapshot(source_workspace_id).await.unwrap();
      let retained = source
        .roots
        .iter()
        .find(|node| node.row.id == "retained")
        .expect("unselected folder remains");
      assert!(retained.children.iter().any(|node| {
        node.row.id == "unrelated-workspace" && node.row.target_workspace_id == Some(unrelated_workspace_id)
      }));
      assert_eq!(
        source.roots.iter().any(|node| node.row.id == "moved"),
        extract,
        "Extract replaces the selected folder while Move removes it"
      );
      let target = service.snapshot(target_workspace_id).await.unwrap();
      assert_eq!(target.roots[0].children.len(), 2);
      assert_eq!(target.roots[0].row.is_workspace_root(), extract);
      if extract {
        let reverse =
          WorkspaceContentIdMapping::new(folder_mapping.target.clone(), folder_mapping.source.clone()).unwrap();
        let placeholder = source.roots.iter().find(|node| node.row.id == "moved").unwrap();
        let undo = service
          .project_undo_extract(target_workspace_id, source_workspace_id, "moved", &[reverse], &[])
          .await
          .expect("replace the authenticated Extract placeholder without a duplicate row");
        let restored = undo.target_rows.iter().find(|row| row.id == "moved").unwrap();
        assert_eq!(restored.parent_id, placeholder.row.parent_id);
        assert_eq!(restored.index, placeholder.row.index);
        assert_eq!(restored.row_type, "folder");
        port
          .persist_organizer_update(target_workspace_id, undo.source_update)
          .await
          .unwrap();
        port
          .persist_organizer_update(source_workspace_id, undo.target_update)
          .await
          .unwrap();
        let restored = service.snapshot(source_workspace_id).await.unwrap();
        let folder = restored.roots.iter().find(|node| node.row.id == "moved").unwrap();
        assert!(folder.row.is_folder());
        assert_eq!(folder.children.len(), 2);
        assert_eq!(restored.roots.len(), 2);
      }
    }
  }

  #[tokio::test]
  async fn generated_order_keys_cover_append_reparent_and_legacy_invalid_groups() {
    let workspace_id = Uuid::new_v4();
    let port = MemoryPort::default();
    let service = OrganizerService::new(port.clone());

    for id in ["source", "destination", "legacy"] {
      service
        .create_folder(
          workspace_id,
          CreateOrganizerFolder {
            id: id.to_string(),
            parent_id: None,
            name: id.to_string(),
            index: None,
          },
        )
        .await
        .expect("owner-generated folder index");
    }
    let destination_link = service
      .create_link(
        workspace_id,
        CreateOrganizerLink {
          id: "destination-link".to_string(),
          parent_id: "destination".to_string(),
          link_type: OrganizerLinkType::Doc,
          target_id: Uuid::new_v4().to_string(),
          target_workspace_id: None,
          index: None,
        },
      )
      .await
      .expect("owner-generated destination index");
    let source_link = service
      .create_link(
        workspace_id,
        CreateOrganizerLink {
          id: "source-link".to_string(),
          parent_id: "source".to_string(),
          link_type: OrganizerLinkType::Doc,
          target_id: Uuid::new_v4().to_string(),
          target_workspace_id: None,
          index: None,
        },
      )
      .await
      .expect("owner-generated source index");
    assert!(is_valid_order_key(&source_link.index));
    let moved = service
      .update_link(
        workspace_id,
        "source-link",
        UpdateOrganizerLink {
          parent_id: Some("destination".to_string()),
          ..Default::default()
        },
      )
      .await
      .expect("reparent generates destination append key");
    assert!(is_valid_order_key(&moved.index));
    assert!(destination_link.index < moved.index);

    let before_invalid = port.payload.lock().expect("payload lock").clone();
    assert_eq!(
      service
        .create_folder(
          workspace_id,
          CreateOrganizerFolder {
            id: "invalid-explicit".to_string(),
            parent_id: None,
            name: "invalid".to_string(),
            index: Some("0000".to_string()),
          },
        )
        .await,
      Err(OrganizerError::InvalidOrderKey)
    );
    assert_eq!(*port.payload.lock().expect("payload lock"), before_invalid);

    let mut document = OrganizerDocument::decode(before_invalid).expect("decode fixture");
    let legacy = document.doc.get_or_insert_map("legacy");
    document.mutate(|txn| {
      legacy.insert(txn, "index", "0000");
    });
    *port.payload.lock().expect("payload lock") = document
      .doc
      .transact()
      .encode_state_as_update_v1(&StateVector::default());

    let renamed = service
      .update_folder(
        workspace_id,
        "legacy",
        UpdateOrganizerFolder {
          name: Some("legacy renamed".to_string()),
          ..Default::default()
        },
      )
      .await
      .expect("non-order rename remains available");
    assert_eq!(renamed.index, "0000");
    let before_reindex_required = port.payload.lock().expect("payload lock").clone();
    assert_eq!(
      service
        .create_folder(
          workspace_id,
          CreateOrganizerFolder {
            id: "blocked-append".to_string(),
            parent_id: None,
            name: "blocked".to_string(),
            index: None,
          },
        )
        .await,
      Err(OrganizerError::ReindexRequired)
    );
    assert_eq!(*port.payload.lock().expect("payload lock"), before_reindex_required);
    service
      .delete_folder(workspace_id, "legacy")
      .await
      .expect("legacy-invalid row remains deletable");
  }
  #[tokio::test]
  async fn overview_projects_native_folders_without_losing_unplaced_or_disclosing_private_branches() {
    use crate::workspace_overview::{OverviewDocument, compose_git_workspace_overview, compose_workspace_overview};
    use myoxus_domain::workspace_overview::{FolderOverviewSettings, WorkspaceOverviewSettings};
    let workspace_id = Uuid::new_v4();
    let foreign_workspace = Uuid::new_v4();
    let port = MemoryPort::default();
    let organizer = OrganizerService::new(port.clone());
    for (id, parent, index) in [
      ("ancestor", None, "a0"),
      ("chapter", Some("ancestor"), "a0"),
      ("private-only", Some("ancestor"), "a1"),
      ("intro-only", None, "a1"),
      ("empty", None, "a2"),
    ] {
      organizer
        .create_folder(workspace_id, folder(id, parent, index))
        .await
        .unwrap();
    }
    for (id, parent, link_type, target, target_workspace) in [
      ("placed", "chapter", OrganizerLinkType::Doc, "shared key", None),
      (
        "foreign",
        "chapter",
        OrganizerLinkType::Doc,
        "shared key",
        Some(foreign_workspace),
      ),
      ("private", "private-only", OrganizerLinkType::Doc, "private doc", None),
      (
        "collection",
        "empty",
        OrganizerLinkType::Collection,
        "must-not-be-a-chapter",
        None,
      ),
      (
        "database",
        "empty",
        OrganizerLinkType::Database,
        "must-not-be-a-document",
        None,
      ),
    ] {
      organizer
        .create_link(
          workspace_id,
          CreateOrganizerLink {
            id: id.into(),
            parent_id: parent.into(),
            link_type,
            target_id: target.into(),
            target_workspace_id: target_workspace,
            index: None,
          },
        )
        .await
        .unwrap();
    }
    fn reference(workspace: Uuid, key: &str) -> WorkspaceContentResourceRef {
      WorkspaceContentResourceRef::new(workspace, WorkspaceContentResourceKind::Document, key).unwrap()
    }
    let fact = |workspace, key: &str| OverviewDocument {
      reference: reference(workspace, key),
      doc_id: Uuid::new_v4(),
      title: key.into(),
      updated_at: chrono::Utc::now(),
      public_mode: Some("Page".into()),
      is_page: true,
      can_edit: false,
      register: None,
    };
    let published = vec![
      fact(workspace_id, "shared key"),
      fact(foreign_workspace, "shared key"),
      fact(workspace_id, "unplaced"),
      fact(workspace_id, "introduction"),
    ];
    let mut settings = WorkspaceOverviewSettings::default();
    settings.folders.insert(
      "intro-only".into(),
      FolderOverviewSettings {
        introduction: Some(reference(workspace_id, "introduction")),
        ..Default::default()
      },
    );
    let snapshot = organizer.snapshot(workspace_id).await.unwrap();
    let public = compose_workspace_overview(&snapshot, &settings, published.clone(), true).unwrap();
    assert_eq!(
      public
        .root
        .children
        .iter()
        .map(|folder| folder.id.as_str())
        .collect::<Vec<_>>(),
      ["ancestor", "intro-only"]
    );
    assert_eq!(
      public.root.documents.len(),
      3,
      "root retains the complete local index, including unplaced pages"
    );
    assert!(
      public
        .root
        .documents
        .iter()
        .any(|doc| doc.reference.resource_id() == "unplaced")
    );
    let chapter = public.page(&snapshot, Some("chapter")).unwrap();
    assert_eq!(
      chapter
        .breadcrumbs
        .iter()
        .map(|folder| folder.id.as_str())
        .collect::<Vec<_>>(),
      ["ancestor", "chapter"]
    );
    assert_eq!(
      chapter.documents.len(),
      2,
      "qualified same-key references remain distinct"
    );
    assert!(
      public.page(&snapshot, Some("ancestor")).unwrap().documents.is_empty(),
      "parent registers do not absorb child documents"
    );
    assert!(public.page(&snapshot, Some("private-only")).is_err());
    assert!(
      public.page(&snapshot, Some("empty")).is_err(),
      "Collection/Database links do not qualify a chapter"
    );
    assert!(
      public
        .page(&snapshot, Some("intro-only"))
        .unwrap()
        .introduction
        .is_some()
    );

    // One native capture owns ordering for every format adapter. Canonical IDs
    // and timestamps sort before paging; display labels never become sort keys.
    let epoch = chrono::DateTime::parse_from_rfc3339("2024-01-02T03:04:05Z")
      .unwrap()
      .with_timezone(&chrono::Utc);
    let mut sortable = published.clone();
    for document in &mut sortable {
      let rank = match document.reference.resource_id() {
        "shared key" => 1,
        "unplaced" => 2,
        _ => 3,
      };
      document.updated_at = epoch;
      document.register = Some(crate::workspace_overview::OverviewRegisterFacts {
        labels: Default::default(),
        metadata: myoxus_domain::entities::DocumentMetadataIndexRow {
          doc_id: document.doc_id,
          external_id: document.reference.resource_id().into(),
          created_by: Some(Uuid::from_u128(rank)),
          updated_by: None,
          journal_date: None,
          is_template: false,
          template_state: None,
          template_origin: None,
          template_category: None,
          template_tags: None,
          primary_mode: None,
          page_width: None,
          edgeless_color_theme: None,
          integration_type: None,
          status_id: None,
          document_type_id: None,
          current_version_id: None,
          dirty_since_current_version: false,
          review_due_at: None,
          valid_until: None,
          classification_id: None,
        },
        created_at: epoch + chrono::Duration::seconds(if rank == 1 { 1 } else { 2 }),
        created_by_name: Some(
          match rank {
            1 => "ZZZ",
            2 => "AAA",
            _ => "MMM",
          }
          .into(),
        ),
        tag_ids: if rank == 1 {
          vec![Uuid::from_u128(3), Uuid::from_u128(1)]
        } else {
          vec![Uuid::from_u128(if rank == 2 { 4 } else { 2 })]
        },
        tags: Vec::new(),
        can_publish: false,
      });
    }
    let mut sorted_settings = settings.clone();
    for (key, desc, expected) in [
      ("updatedAt", true, ["introduction", "shared key", "unplaced"]),
      ("title", false, ["introduction", "shared key", "unplaced"]),
      ("createdBy", false, ["shared key", "unplaced", "introduction"]),
      ("createdAt", true, ["introduction", "unplaced", "shared key"]),
      ("tags", false, ["shared key", "introduction", "unplaced"]),
    ] {
      sorted_settings.register_presentation = Some(myoxus_domain::workspace_overview::OverviewRegisterPresentation {
        display_properties: vec!["system:title".into()],
        order_by: myoxus_domain::workspace_overview::OverviewOrderBy {
          property_type: "system".into(),
          key: key.into(),
          desc,
        },
      });
      let sorted = compose_workspace_overview(&snapshot, &sorted_settings, sortable.clone(), false).unwrap();
      assert_eq!(
        sorted
          .root
          .documents
          .iter()
          .map(|document| document.reference.resource_id())
          .collect::<Vec<_>>(),
        expected,
        "canonical {key} order"
      );
      let direct = &sorted.page(&snapshot, Some("chapter")).unwrap().documents;
      assert!(
        direct.windows(2).all(|pair| pair[0].reference < pair[1].reference),
        "qualified ties stay ascending for {key}"
      );
      assert_eq!(
        direct[0].register.as_ref().unwrap().tag_ids,
        vec![Uuid::from_u128(3), Uuid::from_u128(1)],
        "sorting must preserve Tag assignment order"
      );
    }

    let mut internal_facts = published.clone();
    let mut private_fact = fact(workspace_id, "private doc");
    private_fact.public_mode = None;
    internal_facts.push(private_fact);
    settings.folder_ids = Some(vec!["chapter".into()]);
    let git = compose_git_workspace_overview(&snapshot, &settings, internal_facts.clone(), &[]).unwrap();
    assert!(
      git
        .root
        .documents
        .iter()
        .any(|document| document.reference.resource_id() == "private doc")
    );
    assert!(git.page(&snapshot, Some("empty")).is_ok());
    let internal = compose_workspace_overview(&snapshot, &settings, internal_facts, false).unwrap();
    assert_eq!(internal.root.children[0].id, "ancestor");
    assert!(
      internal.page(&snapshot, Some("empty")).is_ok(),
      "root selection never removes internally readable folders"
    );
    let selected_public = compose_workspace_overview(&snapshot, &settings, published.clone(), true).unwrap();
    assert_eq!(selected_public.root.children.len(), 1);
    assert!(selected_public.page(&snapshot, Some("intro-only")).is_err());
    settings.folder_ids = Some(Vec::new());
    let hidden_navigation = compose_workspace_overview(&snapshot, &settings, published.clone(), true).unwrap();
    assert!(hidden_navigation.root.children.is_empty());
    assert_eq!(hidden_navigation.root.documents.len(), public.root.documents.len());

    settings.folder_ids = None;
    let revoked = compose_workspace_overview(
      &snapshot,
      &settings,
      published
        .into_iter()
        .filter(|doc| doc.reference.resource_id() == "unplaced")
        .collect(),
      true,
    )
    .unwrap();
    assert!(
      revoked.root.children.is_empty(),
      "last-public-document revocation removes its ancestors"
    );
    assert!(
      revoked.folders.is_empty(),
      "private names are absent from the result, not merely hidden by an adapter"
    );

    organizer.delete_folder(workspace_id, "intro-only").await.unwrap();
    organizer.delete_folder(workspace_id, "empty").await.unwrap();
    let mut retained = OrganizerDocument::decode(port.payload.lock().unwrap().clone()).unwrap();
    let root = retained.doc.get_or_insert_map("ancestor");
    let update = retained.mutate(|txn| {
      root.insert(txn, "type", "workspace-root");
    });
    let retained_snapshot = OrganizerSnapshot::from_update(workspace_id, &update).unwrap();
    let overview = compose_workspace_overview(&retained_snapshot, &settings, Vec::new(), false).unwrap();
    assert!(
      overview
        .page(&retained_snapshot, Some("ancestor"))
        .unwrap()
        .folder
        .is_none()
    );
    assert!(
      !overview
        .folders
        .iter()
        .any(|page| page.folder.as_ref().is_some_and(|folder| folder.id == "ancestor"))
    );
  }
}
