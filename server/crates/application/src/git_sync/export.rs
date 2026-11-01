// SPDX-License-Identifier: AGPL-3.0-or-later
//! Markdown export: Workspace documents -> Git repository files.
//!
//! Converts Yjs documents to Markdown with frontmatter metadata
//! and writes them to the Git working tree following the workspace
//! folder hierarchy.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{instrument, trace};
use uuid::Uuid;

pub use myoxus_domain::git_sync::LEGACY_GIT_SYNC_MANIFEST_PATH as GIT_SYNC_MANIFEST_PATH;
use myoxus_domain::git_sync::{GitSyncProfile, GitSyncScopeExclusion, RepoPath};

use crate::workspace_path::{PathPlanItem, WorkspacePathPlanError, plan_workspace_paths};

pub const GIT_SYNC_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const GIT_SYNC_EXPORTER_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn is_git_sync_control_path(path: &str) -> bool {
  path.split('/').any(|segment| segment.eq_ignore_ascii_case(".myoxus"))
}

/// Derive the one private manifest address of an extracted repository subtree.
/// Ordinary deployed profiles retain their legacy address instead of deriving
/// it from their current root and moving existing repository bytes.
pub fn extracted_manifest_path(root_path: &str) -> Result<String, PathPlanError> {
  let root = normalized_root(root_path)?;
  if root.is_empty()
    || root.split('/').any(|segment| segment.is_empty() || segment == ".")
    || is_git_sync_control_path(&root.to_ascii_lowercase())
  {
    return Err(PathPlanError::InvalidRoot(
      "extracted scope needs a normalized directory root",
    ));
  }
  let path = format!("{root}/{GIT_SYNC_MANIFEST_PATH}");
  RepoPath::new(path.clone()).map_err(PathPlanError::InvalidRoot)?;
  Ok(path)
}

fn scope_root(root_path: &str) -> Result<String, PathPlanError> {
  let root = normalized_root(root_path)?;
  if !root.is_empty() && (root.split('/').any(str::is_empty) || is_git_sync_control_path(&root.to_ascii_lowercase())) {
    return Err(PathPlanError::InvalidRoot("Git-Sync root is not normalized"));
  }
  // The deployed lifecycle allows `.` segments; they name the same physical
  // namespace as the path without them and must not bypass collision checks.
  Ok(
    root
      .split('/')
      .filter(|segment| *segment != ".")
      .collect::<Vec<_>>()
      .join("/"),
  )
}

/// Fail closed on overlapping configured roots, even for disabled profiles.
/// A nested handoff can be admitted only once the scope-fence-aware writer
/// inventory is active; two profiles must not share the old manifest address.
pub fn profile_scope_conflict(
  root_path: &str,
  manifest_path: &str,
  other_root: &str,
  other_manifest: &str,
) -> Result<bool, PathPlanError> {
  let root = scope_root(root_path)?;
  let other = scope_root(other_root)?;
  for path in [manifest_path, other_manifest] {
    RepoPath::new(path.to_string()).map_err(PathPlanError::InvalidRoot)?;
  }
  // Use the same portable case-folding rule as the ordinary path planner.
  // Different configured spellings must not grant two writers one namespace.
  let root = root.to_lowercase();
  let other = other.to_lowercase();
  let manifest_path = manifest_path.to_lowercase();
  let other_manifest = other_manifest.to_lowercase();
  let prefix =
    |left: &str, right: &str| left == right || right.strip_prefix(left).is_some_and(|tail| tail.starts_with('/'));
  Ok(
    manifest_path == other_manifest
      || root.is_empty()
      || other.is_empty()
      || prefix(&root, &other)
      || prefix(&other, &root)
      || prefix(&root, &other_manifest)
      || prefix(&other, &manifest_path),
  )
}

/// A published fence belongs inside its source root, not to an adjacent
/// sibling or the root itself. Exact-path fences share this segment boundary.
pub fn is_nested_scope_path(root_path: &str, path: &RepoPath) -> Result<bool, PathPlanError> {
  let root = scope_root(root_path)?;
  if root.is_empty() {
    return Ok(true);
  }
  Ok(
    path
      .as_str()
      .strip_prefix(&root)
      .is_some_and(|tail| tail.starts_with('/')),
  )
}

/// One profile's durable exclusions, including detached subtrees whose former
/// destination profile no longer exists. Callers must use this predicate for
/// reads, allocation, writes and deletion rather than only filtering imports.
#[derive(Debug, Clone)]
pub struct GitSyncWriterScope {
  exclusions: Vec<GitSyncScopeExclusion>,
}

impl GitSyncWriterScope {
  pub fn new(exclusions: Vec<GitSyncScopeExclusion>) -> Self {
    Self { exclusions }
  }

  /// Reject malformed paths rather than treating them as outside every fence.
  pub fn excludes(&self, path: &str) -> Result<bool, PathPlanError> {
    let path = RepoPath::new(path.to_string()).map_err(PathPlanError::InvalidRoot)?;
    let folded = path.as_str().to_lowercase();
    Ok(self.exclusions.iter().any(|exclusion| {
      if exclusion.excludes(&path) {
        return true;
      }
      let prefix = exclusion.repo_path.as_str().to_lowercase();
      folded == prefix
        || (exclusion.is_directory
          && folded
            .strip_prefix(&prefix)
            .is_some_and(|suffix| suffix.starts_with('/')))
    }))
  }

  pub fn exclusions(&self) -> &[GitSyncScopeExclusion] {
    &self.exclusions
  }

  /// One explicit parent-to-child edge, not permission for an arbitrary
  /// profile to claim a path inside a detached or broader exclusion.
  pub fn delegates_to(&self, parent: &GitSyncProfile, child: &GitSyncProfile) -> Result<bool, PathPlanError> {
    let parent_root = scope_root(&parent.root_path)?.to_lowercase();
    let child_root = scope_root(&child.root_path)?.to_lowercase();
    if child_root.is_empty()
      || child_root == parent_root
      || (!parent_root.is_empty() && !child_root.starts_with(&format!("{parent_root}/")))
      || parent.manifest_path.eq_ignore_ascii_case(&child.manifest_path)
    {
      return Ok(false);
    }
    Ok(self.exclusions.iter().any(|fence| {
      fence.is_directory
        && fence.destination_profile_id == Some(child.id)
        && fence.repo_path.as_str().to_lowercase() == child_root
    }))
  }

  /// Release delegated entries from the source's old manifest inventory
  /// without treating their still-present repository files as deletions.
  pub fn owned_manifest(&self, manifest: &GitSyncManifest) -> Result<GitSyncManifest, PathPlanError> {
    let mut owned = manifest.clone();
    let mut documents = Vec::with_capacity(owned.documents.len());
    for document in owned.documents {
      if !self.excludes(&document.repo_path)? {
        documents.push(document);
      }
    }
    owned.documents = documents;
    for folder in &mut owned.folders {
      if let Some(output) = &folder.overview {
        if self.excludes(&output.repo_path)? {
          folder.overview = None;
        }
      }
    }
    if let Some(output) = &owned.overview {
      if self.excludes(&output.repo_path)? {
        owned.overview = None;
      }
    }
    Ok(owned)
  }

  /// A child may share a branch only when its entire root is delegated by its
  /// parent, with a distinct manifest. A detached fence never grants another
  /// configured profile ownership of the vacated subtree.
  pub fn conflicts_with(
    &self,
    profile: &GitSyncProfile,
    other: &GitSyncProfile,
    other_scope: &Self,
  ) -> Result<bool, PathPlanError> {
    if !profile_scope_conflict(
      &profile.root_path,
      &profile.manifest_path,
      &other.root_path,
      &other.manifest_path,
    )? {
      return Ok(false);
    }
    if profile.manifest_path.eq_ignore_ascii_case(&other.manifest_path) {
      return Ok(true);
    }
    Ok(!self.delegates_to(profile, other)? && !other_scope.delegates_to(other, profile)?)
  }
}

/// Frontmatter metadata written to each exported Markdown file.
#[derive(Debug, Clone)]
pub struct ExportFrontmatter {
  pub sync_id: Uuid,
  pub doc_id: Uuid,
  pub workspace_id: Uuid,
  pub title: String,
}

impl ExportFrontmatter {
  /// Serialize to YAML frontmatter block.
  ///
  /// Double-quotes in the title are escaped with backslash.
  /// The title is always wrapped in double-quotes for safety.
  #[instrument(skip(self), fields(doc_id = %self.doc_id))]
  pub fn to_yaml(&self) -> String {
    format!(
      "---\nsync_id: {}\ndoc_id: {}\nworkspace_id: {}\ntitle: \"{}\"\n---\n",
      self.sync_id,
      self.doc_id,
      self.workspace_id,
      self.title.replace('"', "\\\"")
    )
  }

  /// Parse from YAML frontmatter block (the text between `---` delimiters).
  ///
  /// Returns `None` if any required field (`sync_id`, `doc_id`, `workspace_id`,
  /// `title`) is missing or if UUIDs fail to parse.
  #[instrument(skip(yaml))]
  pub fn from_yaml(yaml: &str) -> Option<Self> {
    let mut sync_id = None;
    let mut doc_id = None;
    let mut workspace_id = None;
    let mut title = None;

    for line in yaml.lines() {
      let line = line.trim();
      if line == "---" {
        continue;
      }
      if let Some((key, value)) = line.split_once(':') {
        let key = key.trim();
        let value = value.trim();
        // Strip outer double-quotes if present, then unescape inner escaped quotes.
        let value = if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
          &value[1..value.len() - 1]
        } else {
          value
        };
        let value_unescaped = value.replace("\\\"", "\"");
        match key {
          "sync_id" => sync_id = Uuid::parse_str(&value_unescaped).ok(),
          "doc_id" => doc_id = Uuid::parse_str(&value_unescaped).ok(),
          "workspace_id" => workspace_id = Uuid::parse_str(&value_unescaped).ok(),
          "title" => title = Some(value_unescaped),
          _ => {}
        }
      }
    }

    let result = Self {
      sync_id: sync_id?,
      doc_id: doc_id?,
      workspace_id: workspace_id?,
      title: title?,
    };
    trace!(sync_id = %result.sync_id, doc_id = %result.doc_id, "parsed frontmatter");
    Some(result)
  }
}

/// Generate a filesystem-safe slug from a document title.
///
/// Unicode alphanumeric characters are preserved. Non-alphanumeric characters
/// (except `-` and `_`) are replaced with `-`. Leading/trailing hyphens are
/// stripped. Returns `"untitled"` for empty or all-special-char titles.
pub fn title_to_slug(title: &str) -> String {
  let slug: String = title
    .chars()
    .map(|character| {
      if character.is_alphanumeric() || character == '-' || character == '_' {
        character
      } else {
        '-'
      }
    })
    .collect();
  let slug = slug.trim_matches('-').to_lowercase();
  if slug.is_empty() { "untitled".to_string() } else { slug }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathPlanDocument {
  pub doc_id: Uuid,
  pub title: String,
  pub folder_names: Vec<String>,
  pub existing_repo_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedDocumentPath {
  pub doc_id: Uuid,
  pub repo_path: RepoPath,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PathPlanError {
  #[error("invalid Git-Sync root path: {0}")]
  InvalidRoot(&'static str),
  #[error("planned repository path is invalid for document {doc_id}: {reason}")]
  InvalidDocumentPath { doc_id: Uuid, reason: &'static str },
  #[error("repository path `{repo_path}` is already owned by {owner}")]
  PathAlreadyOwned { repo_path: String, owner: String },
}

pub(super) fn normalized_root(root_path: &str) -> Result<String, PathPlanError> {
  let root = root_path.trim().trim_matches('/');
  if root.is_empty() {
    return Ok(String::new());
  }
  RepoPath::new(root.to_string()).map_err(PathPlanError::InvalidRoot)?;
  Ok(root.to_string())
}

/// Keep native Markdown assets inside the same managed root as documents.
pub fn asset_repo_path(root_path: &str, key: &str, mime: &str) -> Result<String, PathPlanError> {
  let root = normalized_root(root_path)?;
  let asset = crate::workspace_export::portable_markdown_asset_path(key, mime);
  Ok(if root.is_empty() {
    asset
  } else {
    format!("{root}/{asset}")
  })
}

fn candidate_path(root: &str, folder_names: &[String], title: &str) -> String {
  let mut segments = Vec::with_capacity(folder_names.len() + 1);
  if !root.is_empty() {
    segments.push(root.to_string());
  }
  segments.extend(folder_names.iter().map(|name| title_to_slug(name)));
  segments.push(format!("{}.md", title_to_slug(title)));
  segments.join("/")
}

/// Plan every outbound document path as one deterministic batch.
///
/// Existing ownership is used only to retain the unsuffixed path when a
/// collision appears. Every other collision suffix derives from document
/// identity; query order and incidental filesystem contents never participate.
pub fn plan_document_paths(
  root_path: &str,
  documents: &[PathPlanDocument],
  occupied_paths: &BTreeMap<String, String>,
) -> Result<Vec<PlannedDocumentPath>, PathPlanError> {
  let root = normalized_root(root_path)?;
  let items = documents
    .iter()
    .map(|document| PathPlanItem {
      id: document.doc_id,
      preferred_path: candidate_path(&root, &document.folder_names, &document.title),
      existing_path: document.existing_repo_path.clone(),
    })
    .collect::<Vec<_>>();
  plan_workspace_paths(&items, occupied_paths, false)?
    .into_iter()
    .map(|planned| {
      let repo_path = RepoPath::new(planned.path).map_err(|reason| PathPlanError::InvalidDocumentPath {
        doc_id: planned.id,
        reason,
      })?;
      Ok(PlannedDocumentPath {
        doc_id: planned.id,
        repo_path,
      })
    })
    .collect()
}

impl From<WorkspacePathPlanError> for PathPlanError {
  fn from(error: WorkspacePathPlanError) -> Self {
    match error {
      WorkspacePathPlanError::InvalidPath { id, .. } => PathPlanError::InvalidDocumentPath {
        doc_id: id,
        reason: "invalid relative path",
      },
      WorkspacePathPlanError::PathAlreadyOwned { path, owner } => {
        PathPlanError::PathAlreadyOwned { repo_path: path, owner }
      }
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncManifestFolder {
  pub organizer_id: String,
  pub parent_organizer_id: Option<String>,
  pub name: String,
  pub organizer_path: Vec<String>,
  pub path: Vec<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub overview: Option<GitSyncManifestOverview>,
}

/// Derived output owned by the enclosing workspace/folder, never a document
/// identity or binding. Hashes describe emitted bytes, not access authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitSyncManifestOverview {
  pub repo_path: String,
  pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncManifestDocument {
  pub doc_id: Uuid,
  pub organizer_entry_id: Option<String>,
  pub organizer_folder_ids: Vec<String>,
  pub repo_path: String,
  pub title: String,
  pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncManifest {
  pub schema_version: u32,
  pub exporter_version: String,
  pub workspace_id: Uuid,
  pub organizer_revision: String,
  pub folders: Vec<GitSyncManifestFolder>,
  pub documents: Vec<GitSyncManifestDocument>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub overview: Option<GitSyncManifestOverview>,
}

impl GitSyncManifest {
  pub fn new(
    workspace_id: Uuid,
    organizer_revision: String,
    mut folders: Vec<GitSyncManifestFolder>,
    mut documents: Vec<GitSyncManifestDocument>,
  ) -> Self {
    folders.sort_by(|left, right| left.organizer_id.cmp(&right.organizer_id));
    documents.sort_by_key(|document| document.doc_id);
    Self {
      schema_version: GIT_SYNC_MANIFEST_SCHEMA_VERSION,
      exporter_version: GIT_SYNC_EXPORTER_VERSION.to_string(),
      workspace_id,
      organizer_revision,
      folders,
      documents,
      overview: None,
    }
  }

  pub fn to_json(&self) -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(self).map(|json| format!("{json}\n"))
  }

  /// The manifest is the sole inventory of generated pages across all adapters.
  pub fn overview_outputs(&self) -> impl Iterator<Item = &GitSyncManifestOverview> {
    self
      .overview
      .iter()
      .chain(self.folders.iter().filter_map(|folder| folder.overview.as_ref()))
  }

  /// Validate derived ownership before any mutation. Previous manifests retain
  /// deleted-folder outputs for bounded cleanup; current tree membership is not
  /// reconstructed here. Ordinary content always wins over a derived path.
  pub fn validate_overviews<'a>(
    &self,
    workspace_id: Uuid,
    ordinary_paths: impl IntoIterator<Item = &'a str>,
  ) -> Result<(), String> {
    if self.schema_version != GIT_SYNC_MANIFEST_SCHEMA_VERSION || self.workspace_id != workspace_id {
      return Err("overview manifest schema/workspace does not match its owner".into());
    }
    if self.overview.is_none() && self.folders.iter().all(|folder| folder.overview.is_none()) {
      return Ok(());
    }
    let mut occupied = self
      .documents
      .iter()
      .map(|doc| doc.repo_path.to_lowercase())
      .chain(ordinary_paths.into_iter().map(str::to_lowercase))
      .collect::<Vec<_>>();
    let mut folders = std::collections::BTreeSet::new();
    for folder in &self.folders {
      if folder.organizer_id.is_empty()
        || !folders.insert(folder.organizer_id.as_str())
        || (folder.overview.is_some() && folder.organizer_path.last() != Some(&folder.organizer_id))
      {
        return Err("overview folder identity is missing or ambiguous".into());
      }
    }
    for folder in self.folders.iter().filter(|folder| folder.overview.is_some()) {
      if folder.path.len() != folder.organizer_path.len()
        || folder.parent_organizer_id.as_ref() != folder.organizer_path.iter().rev().nth(1)
        || folder
          .parent_organizer_id
          .as_ref()
          .is_some_and(|parent| !folders.contains(parent.as_str()))
      {
        return Err("overview folder ancestry does not match its manifest owner".into());
      }
    }
    for output in self.overview_outputs() {
      RepoPath::new(output.repo_path.clone()).map_err(|reason| format!("invalid overview path: {reason}"))?;
      if is_git_sync_control_path(&output.repo_path.to_ascii_lowercase())
        || !output.repo_path.to_ascii_lowercase().ends_with(".md")
      {
        return Err("overview path must be an ordinary Markdown output path".into());
      }
      if output.content_hash.len() != 64 || !output.content_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("overview output hash must be SHA-256".into());
      }
      let key = output.repo_path.to_lowercase();
      if occupied
        .iter()
        .any(|path| path == &key || path.starts_with(&format!("{key}/")) || key.starts_with(&format!("{path}/")))
      {
        return Err(format!(
          "overview path `{}` conflicts with another output owner",
          output.repo_path
        ));
      }
      occupied.push(key);
    }
    Ok(())
  }
}

pub fn paths_by_document(paths: &[PlannedDocumentPath]) -> HashMap<Uuid, String> {
  paths
    .iter()
    .map(|path| (path.doc_id, path.repo_path.as_str().to_string()))
    .collect()
}

/// Compose a complete Markdown file: frontmatter + content.
///
/// `ExportFrontmatter::to_yaml` already ends with the closing delimiter and a
/// newline. Adding another separator newline would become user content after
/// `split_markdown_file` and make an export look modified on the next sync run.
pub fn compose_markdown_file(frontmatter: &ExportFrontmatter, content: &str) -> String {
  format!("{}{}", frontmatter.to_yaml(), content)
}

/// Split a Markdown file into frontmatter and content.
///
/// Returns `(Some(frontmatter_body), content)` if the file starts with `---\n`,
/// or `(None, full_content)` if there is no frontmatter.
///
/// Also handles the edge case where the file ends with `\n---` (no trailing
/// newline after the closing delimiter).
pub fn split_markdown_file(file_content: &str) -> (Option<String>, String) {
  if !file_content.starts_with("---\n") {
    return (None, file_content.to_string());
  }
  // Try `\n---\n` first (standard case with content after frontmatter)
  if let Some(end) = file_content[4..].find("\n---\n") {
    let frontmatter = file_content[4..4 + end].to_string();
    let content = file_content[4 + end + 5..].to_string();
    return (Some(frontmatter), content);
  }
  // Try `\n---` at the very end of file (no trailing newline)
  if file_content[4..].ends_with("\n---") {
    let end = file_content.len() - 4; // exclude trailing "\n---"
    let frontmatter = file_content[4..end].to_string();
    return (Some(frontmatter), String::new());
  }
  (None, file_content.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn extracted_manifest_address_is_nested_without_changing_legacy_profiles() {
    let child = extracted_manifest_path("content/projects/manual/").unwrap();
    assert_eq!(child, "content/projects/manual/.myoxus/git-sync-manifest.json");
    assert_ne!(child, GIT_SYNC_MANIFEST_PATH);
    assert!(is_git_sync_control_path(&child));
    assert!(is_git_sync_control_path("content/projects/manual/.MYOXUS/other.json"));
    assert!(extracted_manifest_path("content/../projects").is_err());
    assert!(extracted_manifest_path("content/.myoxus/generated").is_err());
  }

  #[test]
  fn ambiguous_scope_detection_is_segment_aware_and_includes_manifest() {
    let legacy = GIT_SYNC_MANIFEST_PATH;
    let child = extracted_manifest_path("content/projects/manual/").unwrap();
    assert!(profile_scope_conflict("content/", legacy, "content/projects/manual/", &child).unwrap());
    assert!(profile_scope_conflict("content/", legacy, "assets/", legacy).unwrap());
    assert!(profile_scope_conflict("Content/", legacy, "content/projects/manual/", &child).unwrap());
    assert!(profile_scope_conflict(".", legacy, "content/projects/manual/", &child).unwrap());
    assert!(profile_scope_conflict("content/./", legacy, "content/projects/manual/", &child).unwrap());
    assert!(
      !profile_scope_conflict(
        "content/projects/manual/",
        &child,
        "content/projects/manual-old/",
        legacy
      )
      .unwrap()
    );
    assert!(is_nested_scope_path("content/", &RepoPath::new("content/projects/manual").unwrap()).unwrap());
    assert!(!is_nested_scope_path("content/", &RepoPath::new("content-other/manual").unwrap()).unwrap());
  }

  // ── Frontmatter serialization/parsing roundtrip ──────────────────────

  #[test]
  fn frontmatter_roundtrip() {
    let fm = ExportFrontmatter {
      sync_id: Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap(),
      doc_id: Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap(),
      workspace_id: Uuid::parse_str("33333333-3333-3333-3333-333333333333").unwrap(),
      title: "My Document".to_string(),
    };
    let yaml = fm.to_yaml();
    let parsed = ExportFrontmatter::from_yaml(&yaml).expect("should parse");
    assert_eq!(parsed.sync_id, fm.sync_id);
    assert_eq!(parsed.doc_id, fm.doc_id);
    assert_eq!(parsed.workspace_id, fm.workspace_id);
    assert_eq!(parsed.title, fm.title);
  }

  #[test]
  fn frontmatter_with_quotes_in_title() {
    let fm = ExportFrontmatter {
      sync_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      title: r#"She said "hello""#.to_string(),
    };
    let yaml = fm.to_yaml();
    assert!(yaml.contains(r#"\"hello\""#), "quotes should be escaped");
    let parsed = ExportFrontmatter::from_yaml(&yaml).expect("should parse");
    assert_eq!(parsed.title, fm.title, "title with quotes must roundtrip exactly");
  }

  #[test]
  fn frontmatter_missing_field_returns_none() {
    let yaml = "sync_id: 11111111-1111-1111-1111-111111111111\ntitle: Test\n";
    assert!(
      ExportFrontmatter::from_yaml(yaml).is_none(),
      "missing doc_id and workspace_id should return None"
    );
  }

  #[test]
  fn frontmatter_invalid_uuid_returns_none() {
    let yaml = "sync_id: not-a-uuid\ndoc_id: 22222222-2222-2222-2222-222222222222\nworkspace_id: 33333333-3333-3333-3333-333333333333\ntitle: Test\n";
    assert!(
      ExportFrontmatter::from_yaml(yaml).is_none(),
      "invalid UUID should return None"
    );
  }

  // ── Slug generation ─────────────────────────────────────────────────

  #[test]
  fn slug_basic() {
    assert_eq!(title_to_slug("Hello World"), "hello-world");
  }

  #[test]
  fn slug_special_chars() {
    assert_eq!(title_to_slug("My Doc (2024)!"), "my-doc--2024");
  }

  #[test]
  fn slug_empty() {
    assert_eq!(title_to_slug(""), "untitled");
  }

  #[test]
  fn slug_only_special_chars() {
    assert_eq!(title_to_slug("!!!"), "untitled");
  }

  #[test]
  fn slug_unicode() {
    // Unicode letters are alphanumeric and should be preserved
    let slug = title_to_slug("Projektplan Ubersicht");
    assert_eq!(slug, "projektplan-ubersicht");
  }

  #[test]
  fn slug_preserves_hyphens_and_underscores() {
    assert_eq!(title_to_slug("my-doc_v2"), "my-doc_v2");
  }

  #[test]
  fn slug_leading_trailing_special() {
    assert_eq!(title_to_slug("---hello---"), "hello");
  }

  #[test]
  fn path_plan_is_hierarchical_and_order_independent() {
    let first_id = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
    let second_id = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
    let documents = vec![
      PathPlanDocument {
        doc_id: second_id,
        title: "Runbook".into(),
        folder_names: vec!["One".into(), "Two".into(), "Three".into(), "Four".into(), "Five".into()],
        existing_repo_path: None,
      },
      PathPlanDocument {
        doc_id: first_id,
        title: "Runbook".into(),
        folder_names: vec!["One".into(), "Two".into(), "Three".into(), "Four".into(), "Five".into()],
        existing_repo_path: None,
      },
    ];
    let first = plan_document_paths("content/", &documents, &BTreeMap::new()).unwrap();
    let mut reversed = documents;
    reversed.reverse();
    let second = plan_document_paths("content", &reversed, &BTreeMap::new()).unwrap();
    assert_eq!(first, second);
    assert_eq!(
      first[0].repo_path.as_str(),
      "content/one/two/three/four/five/runbook--111111111111.md"
    );
    assert_eq!(
      first[1].repo_path.as_str(),
      "content/one/two/three/four/five/runbook--222222222222.md"
    );
  }

  #[test]
  fn path_plan_retains_established_collision_owner() {
    let established_id = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
    let newcomer_id = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
    let paths = plan_document_paths(
      "content",
      &[
        PathPlanDocument {
          doc_id: newcomer_id,
          title: "Same".into(),
          folder_names: vec![],
          existing_repo_path: None,
        },
        PathPlanDocument {
          doc_id: established_id,
          title: "Same".into(),
          folder_names: vec![],
          existing_repo_path: Some("content/same.md".into()),
        },
      ],
      &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(paths[0].repo_path.as_str(), "content/same--111111111111.md");
    assert_eq!(paths[1].repo_path.as_str(), "content/same.md");
  }

  #[test]
  fn path_plan_rejects_traversal_and_avoids_cross_kind_collision() {
    let doc_id = Uuid::nil();
    assert!(matches!(
      plan_document_paths("../content", &[], &BTreeMap::new()),
      Err(PathPlanError::InvalidRoot(_))
    ));
    let occupied = BTreeMap::from([("content/test.md".to_string(), "file:fixture".to_string())]);
    let paths = plan_document_paths(
      "content",
      &[PathPlanDocument {
        doc_id,
        title: "Test".into(),
        folder_names: vec![],
        existing_repo_path: None,
      }],
      &occupied,
    )
    .unwrap();
    assert_eq!(paths[0].repo_path.as_str(), "content/test--000000000000.md");
    use super::super::{overview::plan_git_overview_paths, projection::OrganizerProjection};
    let workspace = Uuid::new_v4();
    let folder = |id: &str, name: &str| GitSyncManifestFolder {
      organizer_id: id.into(),
      parent_organizer_id: None,
      name: name.into(),
      organizer_path: vec![id.into()],
      path: vec![name.into()],
      overview: None,
    };
    let projection = OrganizerProjection {
      revision: "capture".into(),
      folders: vec![folder("first", "Same"), folder("second", "Same")],
      documents: Default::default(),
    };
    let mut previous = GitSyncManifest::new(workspace, "old".into(), vec![folder("deleted", "Old")], vec![]);
    previous.overview = Some(GitSyncManifestOverview {
      repo_path: "content/README.md".into(),
      content_hash: "0".repeat(64),
    });
    previous.folders[0].overview = Some(GitSyncManifestOverview {
      repo_path: "content/old/README.md".into(),
      content_hash: "1".repeat(64),
    });
    let documents = HashMap::from([(doc_id, "content/README.md".to_string())]);
    let observed = std::collections::BTreeSet::from([
      "content/README.md".to_string(),
      "content/readme.MD".to_string(),
      "content/old/README.md".to_string(),
    ]);
    let plan = plan_git_overview_paths(
      workspace,
      "content",
      &projection,
      &documents,
      &BTreeMap::new(),
      &observed,
      Some(&previous),
    )
    .unwrap();
    assert_eq!(
      plan.documents[&doc_id].as_str(),
      "content/README.md",
      "ordinary content keeps its final path"
    );
    assert_ne!(plan.workspace.as_str().to_lowercase(), "content/readme.md");
    assert_ne!(
      plan.folders["first"], plan.folders["second"],
      "shared directories need distinct overview filenames"
    );
    assert_eq!(
      plan.retired.iter().map(|path| path.as_str()).collect::<Vec<_>>(),
      ["content/README.md", "content/old/README.md"]
    );
    let mut retained = GitSyncManifest::new(workspace, "capture".into(), projection.folders.clone(), vec![]);
    retained.overview = Some(GitSyncManifestOverview {
      repo_path: plan.workspace.as_str().into(),
      content_hash: "0".repeat(64),
    });
    for folder in &mut retained.folders {
      folder.overview = Some(GitSyncManifestOverview {
        repo_path: plan.folders[&folder.organizer_id].as_str().into(),
        content_hash: "1".repeat(64),
      });
    }
    let emitted = plan
      .folders
      .values()
      .chain(std::iter::once(&plan.workspace))
      .map(|path| path.as_str().to_string())
      .collect();
    let unchanged = plan_git_overview_paths(
      workspace,
      "content",
      &projection,
      &HashMap::new(),
      &BTreeMap::new(),
      &emitted,
      Some(&retained),
    )
    .unwrap();
    assert_eq!(
      unchanged.workspace, plan.workspace,
      "a verified suffix remains stable even when README becomes free"
    );
    assert_eq!(unchanged.folders, plan.folders);
    assert!(unchanged.retired.is_empty());
    assert!(
      plan_git_overview_paths(
        workspace,
        "content",
        &projection,
        &HashMap::new(),
        &BTreeMap::new(),
        &std::collections::BTreeSet::from(["content".into()]),
        None
      )
      .is_err(),
      "an ordinary file cannot become a parent directory"
    );
    let directory_slot = plan_git_overview_paths(
      workspace,
      "content",
      &projection,
      &HashMap::new(),
      &BTreeMap::new(),
      &std::collections::BTreeSet::from(["content/README.md/image.png".into()]),
      None,
    )
    .unwrap();
    assert_ne!(
      directory_slot.workspace.as_str(),
      "content/README.md",
      "a user directory is occupied too"
    );
  }

  // ── Markdown file composition/splitting ─────────────────────────────

  #[test]
  fn compose_and_split_roundtrip() {
    let fm = ExportFrontmatter {
      sync_id: Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap(),
      doc_id: Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap(),
      workspace_id: Uuid::parse_str("33333333-3333-3333-3333-333333333333").unwrap(),
      title: "Test".to_string(),
    };
    let content = "Hello world\n\nSecond paragraph\n";
    let composed = compose_markdown_file(&fm, content);

    let (frontmatter, body) = split_markdown_file(&composed);
    assert!(frontmatter.is_some(), "should extract frontmatter");
    let parsed = ExportFrontmatter::from_yaml(&frontmatter.unwrap()).unwrap();
    assert_eq!(parsed.sync_id, fm.sync_id);
    assert_eq!(parsed.doc_id, fm.doc_id);

    assert_eq!(body, content, "body must roundtrip without synthetic leading newline");
  }

  #[test]
  fn split_no_frontmatter() {
    let content = "Just plain text\n";
    let (fm, body) = split_markdown_file(content);
    assert!(fm.is_none());
    assert_eq!(body, content);
  }

  #[test]
  fn split_unclosed_frontmatter() {
    let content = "---\nsync_id: abc\nno closing delimiter\n";
    let (fm, body) = split_markdown_file(content);
    assert!(fm.is_none(), "unclosed frontmatter should return None");
    assert_eq!(body, content);
  }

  #[test]
  fn split_empty_content_after_frontmatter() {
    let content = "---\nkey: value\n---\n";
    let (fm, body) = split_markdown_file(content);
    assert!(fm.is_some());
    assert!(body.is_empty(), "body should be empty, got: {body:?}");
  }

  // ── P21-15e: Multi-cycle regression — roundtrip preservation ────────

  #[test]
  fn roundtrip_export_import_preserves_content() {
    let fm = ExportFrontmatter {
      sync_id: Uuid::parse_str("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").unwrap(),
      doc_id: Uuid::parse_str("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb").unwrap(),
      workspace_id: Uuid::parse_str("cccccccc-cccc-cccc-cccc-cccccccccccc").unwrap(),
      title: "Regression Test Doc".to_string(),
    };
    let content = "# Heading\n\nParagraph one.\n\n- item a\n- item b\n";

    // Export: compose file
    let file = compose_markdown_file(&fm, content);

    // Import: split back
    let (yaml_opt, body) = split_markdown_file(&file);
    assert!(yaml_opt.is_some(), "frontmatter must survive roundtrip");

    let parsed = ExportFrontmatter::from_yaml(&yaml_opt.unwrap()).expect("frontmatter must parse after roundtrip");

    // All identity fields preserved
    assert_eq!(parsed.sync_id, fm.sync_id);
    assert_eq!(parsed.doc_id, fm.doc_id);
    assert_eq!(parsed.workspace_id, fm.workspace_id);
    assert_eq!(parsed.title, fm.title);

    assert_eq!(body, content, "content body must be byte-stable after split");
  }

  #[test]
  fn manifest_roundtrip_preserves_schema_one_and_rejects_ambiguous_overview_owners() {
    let workspace = Uuid::new_v4();
    let manifest = GitSyncManifest::new(
      workspace,
      "revision".into(),
      vec![GitSyncManifestFolder {
        organizer_id: "folder".into(),
        parent_organizer_id: None,
        name: "Folder".into(),
        organizer_path: vec!["folder".into()],
        path: vec!["Folder".into()],
        overview: None,
      }],
      vec![GitSyncManifestDocument {
        doc_id: Uuid::new_v4(),
        organizer_entry_id: None,
        organizer_folder_ids: vec![],
        repo_path: "content/doc.md".into(),
        title: "Private admitted document".into(),
        content_hash: "body-hash".into(),
      }],
    );
    let original = manifest.to_json().unwrap();
    let mut parsed: GitSyncManifest = serde_json::from_str(&original).unwrap();
    assert_eq!(parsed.to_json().unwrap(), original);
    assert!(!original.contains("\"overview\""));
    parsed.overview = Some(GitSyncManifestOverview {
      repo_path: "content/README.md".into(),
      content_hash: "0".repeat(64),
    });
    parsed.folders[0].overview = Some(GitSyncManifestOverview {
      repo_path: "content/folder/README.md".into(),
      content_hash: "1".repeat(64),
    });
    parsed.validate_overviews(workspace, ["content/image.png"]).unwrap();
    assert_eq!(
      serde_json::from_str::<GitSyncManifest>(&parsed.to_json().unwrap()).unwrap(),
      parsed
    );
    assert!(parsed.validate_overviews(workspace, ["CONTENT/readme.MD"]).is_err());
    parsed.overview.as_mut().unwrap().repo_path = "content/doc.md".into();
    assert!(parsed.validate_overviews(workspace, std::iter::empty()).is_err());
    parsed.overview.as_mut().unwrap().repo_path = "../README.md".into();
    assert!(parsed.validate_overviews(workspace, std::iter::empty()).is_err());
    assert!(
      serde_json::from_value::<GitSyncManifestOverview>(serde_json::json!({
        "repoPath": "README.md", "contentHash": "0".repeat(64), "docId": Uuid::new_v4(),
      }))
      .is_err(),
      "derived descriptors cannot acquire a fabricated document identity"
    );
  }

  // ── P21-audit: title with colons survives roundtrip ──────────────────

  #[test]
  fn frontmatter_title_with_colons() {
    let fm = ExportFrontmatter {
      sync_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      title: "Meeting: Q1 Review: Action Items".to_string(),
    };
    let yaml = fm.to_yaml();
    let parsed = ExportFrontmatter::from_yaml(&yaml).expect("should parse title with colons");
    assert_eq!(parsed.title, fm.title, "colons in title must roundtrip");
  }

  #[test]
  fn frontmatter_title_with_backslash() {
    let fm = ExportFrontmatter {
      sync_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      title: r#"C:\Users\docs"#.to_string(),
    };
    let yaml = fm.to_yaml();
    let parsed = ExportFrontmatter::from_yaml(&yaml).expect("should parse title with backslash");
    assert_eq!(parsed.title, fm.title, "backslash in title must roundtrip");
  }
}
