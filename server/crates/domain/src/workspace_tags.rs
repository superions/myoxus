//! Workspace label values, validation rules and persistence boundary.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::document_key::DocumentKey;
use crate::ids::{UserId, WorkspaceId};
use crate::repositories::{PageRequest, RepoResult, RepositoryError};

/// Approved product-neutral color roles for workspace tags.
///
/// Persistence and APIs carry these stable role names. Theme-specific colors
/// are resolved only by the Myoxus theme projection and UI Facade.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum WorkspaceTagColorRole {
  #[serde(rename = "tag.red")]
  Red,
  #[serde(rename = "tag.magenta")]
  Magenta,
  #[serde(rename = "tag.orange")]
  Orange,
  #[serde(rename = "tag.yellow")]
  Yellow,
  #[serde(rename = "tag.green")]
  Green,
  #[serde(rename = "tag.teal")]
  Teal,
  #[serde(rename = "tag.blue")]
  Blue,
  #[serde(rename = "tag.purple")]
  Purple,
  #[serde(rename = "tag.grey")]
  Grey,
}

impl WorkspaceTagColorRole {
  pub const ALL: [Self; 9] = [
    Self::Red,
    Self::Magenta,
    Self::Orange,
    Self::Yellow,
    Self::Green,
    Self::Teal,
    Self::Blue,
    Self::Purple,
    Self::Grey,
  ];

  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Red => "tag.red",
      Self::Magenta => "tag.magenta",
      Self::Orange => "tag.orange",
      Self::Yellow => "tag.yellow",
      Self::Green => "tag.green",
      Self::Teal => "tag.teal",
      Self::Blue => "tag.blue",
      Self::Purple => "tag.purple",
      Self::Grey => "tag.grey",
    }
  }
}

impl std::fmt::Display for WorkspaceTagColorRole {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str(self.as_str())
  }
}

impl std::str::FromStr for WorkspaceTagColorRole {
  type Err = WorkspaceTagValidationError;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value.trim() {
      "tag.red" | "red" | "Red" => Ok(Self::Red),
      "tag.magenta" | "magenta" | "Magenta" => Ok(Self::Magenta),
      "tag.orange" | "orange" | "Orange" => Ok(Self::Orange),
      "tag.yellow" | "yellow" | "Yellow" => Ok(Self::Yellow),
      "tag.green" | "green" | "Green" => Ok(Self::Green),
      "tag.teal" | "teal" | "Teal" => Ok(Self::Teal),
      "tag.blue" | "blue" | "Blue" => Ok(Self::Blue),
      "tag.purple" | "purple" | "Purple" => Ok(Self::Purple),
      "tag.grey" | "grey" | "Grey" | "gray" | "Gray" => Ok(Self::Grey),
      _ => Err(WorkspaceTagValidationError::InvalidColorRole),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceTagValidationError {
  InvalidName,
  InvalidSlug,
  InvalidColorRole,
}

impl std::fmt::Display for WorkspaceTagValidationError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str(match self {
      Self::InvalidName => "workspace tag name must contain between 1 and 80 characters",
      Self::InvalidSlug => "workspace tag slug is invalid",
      Self::InvalidColorRole => "workspace tag color role is invalid",
    })
  }
}

impl std::error::Error for WorkspaceTagValidationError {}

/// Canonical server-owned workspace tag record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceTag {
  pub id: uuid::Uuid,
  pub workspace_id: WorkspaceId,
  pub name: String,
  pub slug: String,
  pub color_role: WorkspaceTagColorRole,
  pub description: Option<String>,
  pub archived_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub created_by: Option<UserId>,
  pub updated_by: Option<UserId>,
}

/// One server-owned catalog row with aggregate usage totals.
///
/// The embedded tag remains the canonical metadata record. Counts are a
/// read-only navigation projection and deliberately carry no referenced
/// document or Database Row identities.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceTagCatalogEntry {
  pub tag: WorkspaceTag,
  pub document_count: i64,
  pub database_row_count: i64,
}

/// Compact result of one committed permanent workspace-Tag deletion.
///
/// Database identities are returned only so the Application owner can publish
/// post-commit invalidation hints. Usage counts and referenced content never
/// cross this persistence boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceTagDeletionResult {
  pub tag_id: uuid::Uuid,
  pub affected_database_ids: Vec<uuid::Uuid>,
}

/// Stable workspace-tag projection embedded into server search documents.
///
/// Search stores retain the structured identity for filters and diagnostics,
/// while names and slugs are also projected into full-text search input.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTagSearchProjection {
  pub id: uuid::Uuid,
  pub name: String,
  pub slug: String,
  pub color_role: WorkspaceTagColorRole,
}

/// One active Database Row that references a workspace Tag. Multiple Tags
/// fields in the same Row collapse to one usage result for navigation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTagDatabaseRowUsage {
  pub database_id: uuid::Uuid,
  pub database_title: String,
  pub row_id: uuid::Uuid,
  pub row_title: String,
  pub updated_at: DateTime<Utc>,
}

impl From<&WorkspaceTag> for WorkspaceTagSearchProjection {
  fn from(tag: &WorkspaceTag) -> Self {
    Self {
      id: tag.id,
      name: tag.name.clone(),
      slug: tag.slug.clone(),
      color_role: tag.color_role,
    }
  }
}

impl WorkspaceTag {
  /// Normalize display whitespace while preserving user-visible Unicode.
  pub fn normalize_name(value: &str) -> Result<String, WorkspaceTagValidationError> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let length = normalized.chars().count();
    if !(1..=80).contains(&length) {
      return Err(WorkspaceTagValidationError::InvalidName);
    }
    Ok(normalized)
  }

  /// Derive a deterministic, URL-safe Unicode slug base from a tag name.
  pub fn slug_base(name: &str) -> Result<String, WorkspaceTagValidationError> {
    let name = Self::normalize_name(name)?;
    let mut slug = String::new();
    let mut pending_separator = false;
    for character in name.chars().flat_map(char::to_lowercase) {
      if character.is_alphanumeric() {
        if pending_separator && !slug.is_empty() {
          slug.push('-');
        }
        slug.push(character);
        pending_separator = false;
      } else if !slug.is_empty() {
        pending_separator = true;
      }
    }
    if slug.is_empty() {
      return Err(WorkspaceTagValidationError::InvalidSlug);
    }
    Ok(slug)
  }
}

/// Maximum number of documents in one interactive assignment read.
pub const WORKSPACE_TAG_DOCUMENT_BATCH_LIMIT: usize = 200;

/// A resolved active document and its ordered canonical assignment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceTagDocumentAssignment {
  pub doc_id: uuid::Uuid,
  pub external_id: String,
  pub tag_ids: Vec<uuid::Uuid>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceTagDocumentUsage {
  pub doc_id: uuid::Uuid,
  pub external_id: String,
  pub title: String,
}

/// Assignment validation errors remain distinct from catalog slug conflicts.
#[derive(Debug, thiserror::Error)]
pub enum WorkspaceTagAssignmentError {
  #[error("workspace tag references must be unique and belong to the workspace")]
  InvalidReferences,
  #[error("archived workspace tags cannot be added to new values")]
  ArchivedReference,
  #[error(transparent)]
  Repository(#[from] RepositoryError),
}

/// Validates complete replacement while retaining already assigned archived tags.
/// `tags` must contain the workspace-scoped records for exactly the requested IDs.
pub fn validate_tag_reference_update(
  previous_ids: &[uuid::Uuid],
  next_ids: &[uuid::Uuid],
  tags: &[WorkspaceTag],
) -> Result<(), WorkspaceTagAssignmentError> {
  let requested = next_ids.iter().copied().collect::<std::collections::HashSet<_>>();
  if requested.len() != next_ids.len()
    || tags.len() != next_ids.len()
    || tags.iter().map(|tag| tag.id).collect::<std::collections::HashSet<_>>() != requested
  {
    return Err(WorkspaceTagAssignmentError::InvalidReferences);
  }
  if tags
    .iter()
    .any(|tag| tag.archived_at.is_some() && !previous_ids.contains(&tag.id))
  {
    return Err(WorkspaceTagAssignmentError::ArchivedReference);
  }
  Ok(())
}

/// Persistence boundary for the server-authoritative workspace tag catalog.
///
/// Document assignment methods are part of the same repository because the
/// legacy bootstrap must commit its catalog resolution and assignments atomically.
/// Until the coordinated client cutover, bootstrap still accepts Yjs-derived
/// assignments and replaces SQL state; it is not a read-only projection.
#[async_trait]
pub trait WorkspaceTagRepository: Send + Sync {
  /// One SQL snapshot for an explicitly bounded portable export. Includes the
  /// complete catalog and requested non-root documents, including trashed docs.
  /// Oversized serialized results fail before crossing the persistence boundary.
  async fn export_tags(
    &self,
    workspace_id: WorkspaceId,
    keys: &[DocumentKey],
    max_bytes: u64,
  ) -> RepoResult<(Vec<WorkspaceTag>, Vec<WorkspaceTagDocumentAssignment>)>;
  /// Persist one explicitly validated portable transfer atomically. Existing
  /// identities are reused without overwriting current canonical metadata.
  async fn import_tags(
    &self,
    workspace_id: WorkspaceId,
    actor: UserId,
    tags: &[WorkspaceTag],
    assignments: &[(uuid::Uuid, Vec<uuid::Uuid>)],
  ) -> RepoResult<Vec<WorkspaceTag>>;
  async fn create_tag(&self, tag: &WorkspaceTag) -> RepoResult<WorkspaceTag>;
  async fn update_tag_name(
    &self,
    workspace_id: WorkspaceId,
    tag_id: uuid::Uuid,
    name: &str,
    slug: &str,
    actor: UserId,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<WorkspaceTag>;
  async fn update_tag_color(
    &self,
    workspace_id: WorkspaceId,
    tag_id: uuid::Uuid,
    color_role: WorkspaceTagColorRole,
    actor: UserId,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<WorkspaceTag>;
  async fn update_tag_description(
    &self,
    workspace_id: WorkspaceId,
    tag_id: uuid::Uuid,
    description: Option<&str>,
    actor: UserId,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<WorkspaceTag>;
  async fn archive_tag(
    &self,
    workspace_id: WorkspaceId,
    tag_id: uuid::Uuid,
    actor: UserId,
    archived_at: DateTime<Utc>,
  ) -> RepoResult<WorkspaceTag>;
  async fn restore_tag(
    &self,
    workspace_id: WorkspaceId,
    tag_id: uuid::Uuid,
    slug: &str,
    actor: UserId,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<WorkspaceTag>;
  /// Permanently remove an archived Tag and every authoritative or
  /// compatibility reference in one transaction.
  ///
  /// `None` means the row was absent or no longer archived while the
  /// transaction held its lock. The Application owner resolves that state to
  /// the stable public lifecycle error after re-reading the catalog.
  async fn delete_archived_tag(
    &self,
    workspace_id: WorkspaceId,
    tag_id: uuid::Uuid,
    actor: UserId,
  ) -> RepoResult<Option<WorkspaceTagDeletionResult>>;
  async fn get_tag(&self, workspace_id: WorkspaceId, tag_id: uuid::Uuid) -> RepoResult<Option<WorkspaceTag>>;
  async fn get_tag_by_slug(&self, workspace_id: WorkspaceId, slug: &str) -> RepoResult<Option<WorkspaceTag>>;
  async fn list_tags(&self, workspace_id: WorkspaceId, include_archived: bool) -> RepoResult<Vec<WorkspaceTag>>;
  async fn list_tag_catalog(
    &self,
    workspace_id: WorkspaceId,
    include_archived: bool,
  ) -> RepoResult<Vec<WorkspaceTagCatalogEntry>>;
  async fn list_tags_page(
    &self,
    workspace_id: WorkspaceId,
    include_archived: bool,
    page: PageRequest,
  ) -> RepoResult<Vec<WorkspaceTag>>;
  async fn list_tags_by_ids(&self, workspace_id: WorkspaceId, tag_ids: &[uuid::Uuid]) -> RepoResult<Vec<WorkspaceTag>>;
  /// Resolve external keys only inside this workspace; absent documents are omitted.
  async fn list_document_assignments(
    &self,
    workspace_id: WorkspaceId,
    keys: &[DocumentKey],
  ) -> RepoResult<Vec<WorkspaceTagDocumentAssignment>>;
  /// Candidate pagination precedes application-layer bulk ACL filtering.
  async fn list_document_tag_usages(
    &self,
    workspace_id: WorkspaceId,
    tag_id: uuid::Uuid,
    page: PageRequest,
  ) -> RepoResult<Vec<WorkspaceTagDocumentUsage>>;
  async fn list_document_tag_ids(&self, workspace_id: WorkspaceId, doc_id: uuid::Uuid) -> RepoResult<Vec<uuid::Uuid>>;
  async fn list_database_row_tag_usages(
    &self,
    workspace_id: WorkspaceId,
    tag_id: uuid::Uuid,
    page: PageRequest,
  ) -> RepoResult<Vec<WorkspaceTagDatabaseRowUsage>>;
  async fn replace_document_tag_ids(
    &self,
    workspace_id: WorkspaceId,
    doc_id: uuid::Uuid,
    tag_ids: &[uuid::Uuid],
    actor: UserId,
  ) -> Result<Vec<WorkspaceTag>, WorkspaceTagAssignmentError>;
  /// Copy a confirmed source assignment in the same workspace, retaining
  /// archived references. A changed source rejects the complete replacement.
  async fn copy_document_tag_ids(
    &self,
    workspace_id: WorkspaceId,
    source_doc_id: uuid::Uuid,
    target_doc_id: uuid::Uuid,
    expected_ids: &[uuid::Uuid],
    actor: UserId,
  ) -> RepoResult<Vec<WorkspaceTag>>;
  /// Refresh only the search projections identified by `scope`.
  ///
  /// Catalog refreshes include both current canonical references and old
  /// projected references so deletion and rename can remove stale terms.
  /// Search is derived state; tag mutations remain authoritative even if a
  /// refresh must be retried.
  async fn refresh_search_projections(
    &self,
    workspace_id: WorkspaceId,
    scope: WorkspaceTagSearchRefreshScope,
  ) -> RepoResult<()>;
}

/// Explicit boundary for rebuilding derived Tag search payloads.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceTagSearchRefreshScope {
  /// One document whose assignment was replaced.
  Document(uuid::Uuid),
  /// Every existing projection that currently or previously references a Tag.
  CatalogTag(uuid::Uuid),
  /// Deliberate bulk reconciliation or import of the complete Workspace.
  Workspace,
}
