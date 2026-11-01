// SPDX-License-Identifier: AGPL-3.0-or-later
//! Derived overview paths over the actual final Git output inventory.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use myoxus_domain::git_sync::RepoPath;
use thiserror::Error;
use uuid::Uuid;

use crate::workspace_path::{PathPlanItem, WorkspacePathPlanError, plan_workspace_paths};

use super::{
  export::{GitSyncManifest, PathPlanError, is_git_sync_control_path, normalized_root, title_to_slug},
  projection::OrganizerProjection,
};

/// One operation's complete destination map; no document or sync identities are
/// allocated for overviews. Apply `retired` before ordinary and derived writes,
/// including when ordinary content takes a previously generated path.
#[derive(Debug, Clone)]
pub struct GitOverviewPathPlan {
  pub documents: HashMap<Uuid, RepoPath>,
  pub workspace: RepoPath,
  pub folders: BTreeMap<String, RepoPath>,
  pub retired: Vec<RepoPath>,
}

#[derive(Debug, Error)]
pub enum GitOverviewPathError {
  #[error(transparent)]
  Root(#[from] PathPlanError),
  #[error(transparent)]
  Allocation(#[from] WorkspacePathPlanError),
  #[error("invalid overview output inventory: {0}")]
  Inventory(String),
}

/// UUIDv5 is only the existing allocator's stable key, never a document identity.
pub fn overview_allocation_id(workspace: Uuid, folder: Option<&str>) -> Uuid {
  let key = folder.map_or_else(
    || "overview:workspace".to_string(),
    |id| format!("overview:folder:{id}"),
  );
  Uuid::new_v5(&workspace, key.as_bytes())
}

fn checked(path: &str) -> Result<RepoPath, GitOverviewPathError> {
  let value = RepoPath::new(path.to_string()).map_err(|reason| GitOverviewPathError::Inventory(reason.into()))?;
  if is_git_sync_control_path(&path.to_ascii_lowercase()) {
    return Err(GitOverviewPathError::Inventory(
      "output enters Git-Sync control metadata".into(),
    ));
  }
  Ok(value)
}

fn directory(path: &str) -> &str {
  path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn overlaps(left: &str, right: &str) -> bool {
  left == right
    || left.strip_prefix(right).is_some_and(|tail| tail.starts_with('/'))
    || right.strip_prefix(left).is_some_and(|tail| tail.starts_with('/'))
}

/// Plan after ordinary content. `documents` are effective materialized/retained
/// paths, not future desired paths of deferred or conflicted items. The caller
/// supplies the already projected Organizer capture and validated previous
/// manifest under its existing mirror/profile ownership. `observed_files` lists
/// regular worktree files, including unrelated/untracked content, not directories.
/// This pure planner does not read, create, delete or reserve repository files.
pub fn plan_git_overview_paths(
  workspace_id: Uuid,
  root_path: &str,
  organizer: &OrganizerProjection,
  documents: &HashMap<Uuid, String>,
  file_owners: &BTreeMap<String, String>,
  observed_files: &BTreeSet<String>,
  previous: Option<&GitSyncManifest>,
) -> Result<GitOverviewPathPlan, GitOverviewPathError> {
  let root = normalized_root(root_path)?;
  if let Some(previous) = previous {
    // Validate historical ownership against that capture, not the new content
    // plan: a new ordinary owner is allowed to displace an old derived output.
    previous
      .validate_overviews(workspace_id, std::iter::empty())
      .map_err(GitOverviewPathError::Inventory)?;
  }
  let old_outputs = previous
    .into_iter()
    .flat_map(|manifest| {
      manifest
        .overview
        .iter()
        .chain(manifest.folders.iter().filter_map(|folder| folder.overview.as_ref()))
    })
    .map(|output| output.repo_path.as_str())
    .collect::<BTreeSet<_>>();
  let mut occupied = BTreeMap::new();
  let mut planned_documents = HashMap::new();
  for (id, path) in documents {
    let path = checked(path)?;
    if occupied
      .insert(path.as_str().to_string(), format!("document:{id}"))
      .is_some()
    {
      return Err(GitOverviewPathError::Inventory(
        "multiple documents share a final path".into(),
      ));
    }
    planned_documents.insert(*id, path);
  }
  for (path, owner) in file_owners {
    checked(path)?;
    if occupied.insert(path.clone(), owner.clone()).is_some() {
      return Err(GitOverviewPathError::Inventory(
        "a file and document share a final path".into(),
      ));
    }
  }
  for path in observed_files {
    if is_git_sync_control_path(path) {
      continue;
    }
    checked(path)?;
    // Only the exact recorded output is released. A case variant is another
    // observed user file and must still occupy the portable allocation slot.
    if !old_outputs.contains(path.as_str()) {
      occupied.entry(path.clone()).or_insert_with(|| "observed file".into());
    }
  }
  let regular_paths = occupied.keys().map(|path| path.to_lowercase()).collect::<Vec<_>>();
  // A directory is occupied too: README.md/image.png cannot be replaced by a
  // README file. Conversely, a file in an ancestor directory is fatal below.
  for path in &regular_paths {
    let mut parent = directory(path);
    while !parent.is_empty() {
      occupied
        .entry(parent.to_string())
        .or_insert_with(|| "existing directory".into());
      parent = directory(parent);
    }
  }
  let mut sources = vec![(
    None,
    root.clone(),
    previous.and_then(|manifest| manifest.overview.as_ref()),
  )];
  let mut identities = BTreeSet::new();
  for folder in &organizer.folders {
    if folder.organizer_id.is_empty() || !identities.insert(folder.organizer_id.as_str()) {
      return Err(GitOverviewPathError::Inventory(
        "ambiguous current Organizer folder".into(),
      ));
    }
    let mut parts = Vec::new();
    if !root.is_empty() {
      parts.push(root.clone());
    }
    parts.extend(folder.path.iter().map(|name| title_to_slug(name)));
    let old = previous
      .and_then(|manifest| {
        manifest
          .folders
          .iter()
          .find(|old| old.organizer_id == folder.organizer_id)
      })
      .and_then(|folder| folder.overview.as_ref());
    sources.push((Some(folder.organizer_id.as_str()), parts.join("/"), old));
  }
  let mut items = Vec::with_capacity(sources.len());
  let mut source_by_key = HashMap::new();
  for (folder, parent, old) in sources {
    let preferred = if parent.is_empty() {
      "README.md".into()
    } else {
      format!("{parent}/README.md")
    };
    checked(&preferred)?;
    let preferred_key = preferred.to_lowercase();
    if regular_paths.iter().any(|path| {
      preferred_key
        .strip_prefix(path.as_str())
        .is_some_and(|tail| tail.starts_with('/'))
    }) {
      return Err(GitOverviewPathError::Inventory(format!(
        "overview directory is an existing file: {parent}"
      )));
    }
    let retained = old.filter(|old| {
      let key = old.repo_path.to_lowercase();
      directory(&old.repo_path) == parent && !regular_paths.iter().any(|path| overlaps(&key, path))
    });
    let id = overview_allocation_id(workspace_id, folder);
    source_by_key.insert(id, folder.map(str::to_string));
    items.push(PathPlanItem {
      id,
      preferred_path: retained.map_or(preferred, |old| old.repo_path.clone()),
      existing_path: retained.map(|old| old.repo_path.clone()),
    });
  }
  let allocated = plan_workspace_paths(&items, &occupied, true)?;
  let mut workspace = None;
  let mut folders = BTreeMap::new();
  let mut outputs = BTreeSet::new();
  for item in allocated {
    let path = checked(&item.path)?;
    outputs.insert(item.path);
    match source_by_key
      .remove(&item.id)
      .expect("allocation preserves its source key")
    {
      Some(id) => {
        folders.insert(id, path);
      }
      None => workspace = Some(path),
    }
  }
  let retired = old_outputs
    .into_iter()
    .filter(|path| !outputs.contains(*path) && observed_files.contains(*path))
    .map(checked)
    .collect::<Result<Vec<_>, _>>()?;
  Ok(GitOverviewPathPlan {
    documents: planned_documents,
    workspace: workspace.expect("workspace allocation is mandatory"),
    folders,
    retired,
  })
}

/// Recognize the generated header only for diagnostics. It never grants file
/// ownership, including when copied underneath document frontmatter.
pub fn is_git_overview_marked(content: &str) -> bool {
  super::export::split_markdown_file(content)
    .1
    .trim_start()
    .starts_with("<!-- myoxus:workspace-overview")
}

/// Classify before ordinary document/file identity discovery. Missing or edited
/// owned outputs remain read-only projections; a real document/file owner or
/// copied unknown marker must fail rather than being hidden by an ignore rule.
/// `files` is the captured observed inventory, not a commit delta.
pub fn classify_git_overview_paths<'a>(
  workspace_id: Uuid,
  manifest: Option<&GitSyncManifest>,
  ordinary_paths: impl IntoIterator<Item = &'a str>,
  files: impl IntoIterator<Item = (&'a str, &'a [u8])>,
) -> Result<BTreeSet<String>, String> {
  let owned = manifest
    .into_iter()
    .flat_map(|manifest| {
      manifest
        .overview
        .iter()
        .chain(manifest.folders.iter().filter_map(|folder| folder.overview.as_ref()))
    })
    .map(|output| output.repo_path.clone())
    .collect::<BTreeSet<_>>();
  let files = files.into_iter().collect::<Vec<_>>();
  if let Some(manifest) = manifest {
    manifest.validate_overviews(
      workspace_id,
      ordinary_paths.into_iter().chain(
        files
          .iter()
          .filter(|(path, _)| !owned.contains(*path))
          .map(|(path, _)| *path),
      ),
    )?;
  }
  for (path, bytes) in files {
    let Ok(content) = std::str::from_utf8(bytes) else {
      continue;
    };
    if owned.contains(path) {
      let (frontmatter, _) = super::export::split_markdown_file(content);
      if frontmatter
        .as_deref()
        .and_then(super::export::ExportFrontmatter::from_yaml)
        .is_some()
      {
        return Err(format!(
          "derived overview `{path}` contains ordinary document ownership; resolve the collision before sync"
        ));
      }
    } else if is_git_overview_marked(content) {
      return Err(format!(
        "unknown read-only overview `{path}` has no manifest owner; classify or remove it before sync"
      ));
    }
  }
  Ok(owned)
}

/// Recovery checks exact captured bytes, unlike normal inbound classification
/// which intentionally tolerates edits/deletions until an authorized regeneration.
pub fn verify_git_overview_bytes(bytes: &[u8], expected_hash: &str) -> Result<(), String> {
  let content = std::str::from_utf8(bytes).map_err(|_| "overview is not UTF-8")?;
  if !is_git_overview_marked(content) || super::export::split_markdown_file(content).0.is_some() {
    return Err("overview is missing its read-only header or has document frontmatter".into());
  }
  if !crate::markdown::content_hash(content).eq_ignore_ascii_case(expected_hash) {
    return Err("overview content hash does not match its captured manifest".into());
  }
  Ok(())
}

/// Shared final-byte publication for server, trusted export and bootstrap. Only
/// manifest documents are register targets; the admitted introduction may remain
/// outside that set. Callers capture native snapshots before any output writes.
#[allow(clippy::too_many_arguments)]
pub fn render_git_overview_batch(
  workspace_title: &str,
  overview: &crate::workspace_overview::WorkspaceOverview,
  paths: &GitOverviewPathPlan,
  inventory: &crate::markdown::MarkdownBatchReferenceInventory,
  snapshots: &HashMap<String, Vec<u8>>,
  asset_path: &dyn Fn(&str) -> Option<String>,
  manifest: &mut GitSyncManifest,
) -> Result<BTreeMap<String, Vec<u8>>, String> {
  let emitted = manifest.documents.iter().map(|doc| doc.doc_id).collect::<BTreeSet<_>>();
  let mut writes = BTreeMap::new();
  for original in std::iter::once(&overview.root).chain(&overview.folders) {
    let mut page = original.clone();
    page.documents.retain(|doc| emitted.contains(&doc.doc_id));
    let intro = page
      .introduction
      .as_ref()
      .and_then(|doc| snapshots.get(doc.reference.resource_id()))
      .map(Vec::as_slice);
    let rendered = crate::workspace_overview::markdown::render_git_overview(
      workspace_title,
      &page,
      paths,
      inventory,
      intro,
      asset_path,
    )
    .map_err(|error| error.to_string())?;
    if !rendered.diagnostics.is_empty() {
      tracing::warn!(workspace_id = %manifest.workspace_id, diagnostics = ?rendered.diagnostics,
        "Git overview introduction conversion findings");
    }
    let path = page.folder.as_ref().map_or_else(
      || Ok(&paths.workspace),
      |folder| paths.folders.get(&folder.id).ok_or("missing folder output"),
    )?;
    let output = super::export::GitSyncManifestOverview {
      repo_path: path.as_str().into(),
      content_hash: rendered.content_hash,
    };
    if let Some(folder) = &page.folder {
      manifest
        .folders
        .iter_mut()
        .find(|entry| entry.organizer_id == folder.id)
        .ok_or("missing folder manifest owner")?
        .overview = Some(output);
    } else {
      manifest.overview = Some(output);
    }
    writes.insert(path.as_str().into(), rendered.markdown.into_bytes());
  }
  Ok(writes)
}

/// Directory export and authoritative bootstrap both reserve unrelated existing
/// files. Ordinary ownership comes from native frontmatter, derived ownership
/// solely from the validated manifest; a filename grants neither authority.
pub fn occupy_git_export_files(
  workspace_id: Uuid,
  document_ids: &BTreeSet<Uuid>,
  occupied: &mut BTreeMap<String, String>,
  observed: &BTreeMap<String, Vec<u8>>,
  previous: Option<&GitSyncManifest>,
) -> Result<(), String> {
  let derived = classify_git_overview_paths(
    workspace_id,
    previous,
    occupied.keys().map(String::as_str),
    observed.iter().map(|(path, bytes)| (path.as_str(), bytes.as_slice())),
  )?;
  for (path, bytes) in observed {
    if is_git_sync_control_path(path) || derived.contains(path) || occupied.contains_key(path) {
      continue;
    }
    let owned = std::str::from_utf8(bytes)
      .ok()
      .and_then(|text| {
        let (yaml, _) = super::export::split_markdown_file(text);
        yaml.and_then(|yaml| super::export::ExportFrontmatter::from_yaml(&yaml))
      })
      .is_some_and(|header| header.workspace_id == workspace_id && document_ids.contains(&header.doc_id));
    if !owned {
      occupied.insert(path.clone(), "existing output".into());
    }
  }
  Ok(())
}
