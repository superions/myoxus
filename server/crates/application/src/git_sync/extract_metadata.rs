// SPDX-License-Identifier: AGPL-3.0-or-later
//! Scoped Extract metadata preparation from recorded Git bytes, never live edits.

use std::collections::{BTreeMap, BTreeSet};

use uuid::Uuid;

use super::export::{ExportFrontmatter, GitSyncManifest, split_markdown_file};
use crate::markdown::{MarkdownBatchReferenceInventory, content_hash};
use crate::workspace_content_operation::WorkspaceContentGitSyncPlan;

pub struct ExtractMetadataChanges {
  pub writes: BTreeMap<String, Vec<u8>>,
  /// Only these paths remain exact recovery proofs when the source later syncs.
  pub target_paths: BTreeSet<String>,
}

/// Detached authored files are never candidates. Only unchanged, positively
/// owned generated outputs may be removed by a later permitted outbound sync.
pub fn disconnect_cleanup_paths(
  plan: &WorkspaceContentGitSyncPlan,
  source_workspace: Uuid,
  files: &BTreeMap<String, Vec<u8>>,
) -> Result<Vec<String>, String> {
  use sha2::{Digest, Sha256};
  let recorded: GitSyncManifest =
    serde_json::from_value(plan.manifest_inventory.clone().ok_or_else(invalid)?).map_err(|_| invalid())?;
  recorded
    .validate_overviews(
      source_workspace,
      recorded.documents.iter().map(|document| document.repo_path.as_str()),
    )
    .map_err(|_| invalid())?;
  let prefix = format!("{}/", plan.target_root).to_lowercase();
  let mut paths = Vec::new();
  for output in recorded.overview_outputs() {
    let folded = output.repo_path.to_lowercase();
    let delegated = plan.delegated_descendants.iter().any(|fence| {
      let root = fence.repo_path.to_lowercase();
      folded == root || (fence.is_directory && folded.starts_with(&format!("{root}/")))
    });
    if !folded.starts_with(&prefix)
      || delegated
      || super::export::is_git_sync_control_path(&folded)
      || plan.files.iter().any(|file| file.repo_path == output.repo_path)
    {
      continue;
    }
    let Some(bytes) = files.get(&output.repo_path) else {
      continue;
    };
    if plan.observed_hashes.get(&output.repo_path) == Some(&output.content_hash)
      && hex::encode(Sha256::digest(bytes)) == output.content_hash
    {
      paths.push(output.repo_path.clone());
    }
  }
  paths.sort();
  paths.dedup();
  Ok(paths)
}

fn invalid() -> String {
  "Git-Sync Extract metadata ownership or bytes changed".into()
}

/// Reverse only receipt-owned metadata. Current SQL document edits are not
/// export input: immutable original Git bytes are admitted by current hashes.
pub fn prepare_undo(
  plan: &WorkspaceContentGitSyncPlan,
  source_workspace: Uuid,
  folder_id: &str,
  current: &GitSyncManifest,
  files: &BTreeMap<String, Vec<u8>>,
  original_files: &BTreeMap<String, Vec<u8>>,
) -> Result<(ExtractMetadataChanges, Vec<String>), String> {
  use crate::workspace_content_operation::WorkspaceContentGitSyncChoice;
  let undo = plan.undo.as_ref().ok_or_else(invalid)?;
  let recorded: GitSyncManifest =
    serde_json::from_value(plan.manifest_inventory.clone().ok_or_else(invalid)?).map_err(|_| invalid())?;
  recorded
    .validate_overviews(source_workspace, std::iter::empty())
    .map_err(|_| invalid())?;
  current
    .validate_overviews(source_workspace, std::iter::empty())
    .map_err(|_| invalid())?;
  for (path, expected) in &undo.expected_hashes {
    let observed = files.get(path).map(|bytes| {
      use sha2::{Digest, Sha256};
      hex::encode(Sha256::digest(bytes))
    });
    if &observed != expected {
      return Err(invalid());
    }
  }
  let delegated = |path: &str| {
    plan.delegated_descendants.iter().any(|fence| {
      path == fence.repo_path || (fence.is_directory && path.starts_with(&format!("{}/", fence.repo_path)))
    })
  };
  let selected = recorded
    .folders
    .iter()
    .filter(|folder| {
      folder.organizer_path.iter().any(|id| id == folder_id)
        && folder
          .overview
          .as_ref()
          .is_none_or(|output| !delegated(&output.repo_path))
    })
    .cloned()
    .collect::<Vec<_>>();
  let documents = recorded
    .documents
    .iter()
    .filter(|document| plan.documents.iter().any(|binding| binding.doc_id == document.doc_id))
    .cloned()
    .collect::<Vec<_>>();
  if documents.len() != plan.documents.len()
    || current.documents.iter().any(|existing| {
      documents
        .iter()
        .any(|document| existing.doc_id == document.doc_id || existing.repo_path == document.repo_path)
    })
    || current.folders.iter().any(|existing| {
      selected
        .iter()
        .any(|folder| existing.organizer_id == folder.organizer_id)
    })
  {
    return Err(invalid());
  }
  let root = selected
    .iter()
    .find(|folder| folder.organizer_id == folder_id)
    .ok_or_else(invalid)?;
  let root_output = root.overview.as_ref().ok_or_else(invalid)?;
  let mut source = current.clone();
  source.documents.extend(documents);
  source.folders.extend(selected.iter().cloned());
  let mut writes = BTreeMap::new();
  let mut target_paths = BTreeSet::new();
  for document in &plan.documents {
    let bytes = original(plan, original_files, &document.repo_path)?;
    writes.insert(document.repo_path.clone(), bytes.to_vec());
    target_paths.insert(document.repo_path.clone());
  }
  for output in selected.iter().filter_map(|folder| folder.overview.as_ref()) {
    let bytes = original(plan, original_files, &output.repo_path)?;
    writes.insert(output.repo_path.clone(), bytes.to_vec());
    target_paths.insert(output.repo_path.clone());
  }
  let parent = match &root.parent_organizer_id {
    Some(parent) => source
      .folders
      .iter_mut()
      .find(|folder| folder.organizer_id == *parent)
      .and_then(|folder| folder.overview.as_mut()),
    None => source.overview.as_mut(),
  }
  .ok_or_else(invalid)?;
  let bytes = files.get(&parent.repo_path).ok_or_else(invalid)?;
  let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
  if content_hash(text) != parent.content_hash || !super::overview::is_git_overview_marked(text) {
    return Err(invalid());
  }
  let entry = format!(
    "- {}\n",
    link(&root.name, &relative(&parent.repo_path, &root_output.repo_path)?)
  );
  let documents_start = text.rfind("\n## Documents\n").ok_or_else(invalid)?;
  let changed = if let Some(start) = text[..documents_start].rfind("\n## Folders\n") {
    if text[start..documents_start]
      .lines()
      .any(|line| line == entry.trim_end())
    {
      text.to_owned()
    } else {
      format!(
        "{}\n{}\n{}",
        text[..documents_start].trim_end_matches('\n'),
        entry.trim_end(),
        &text[documents_start..]
      )
    }
  } else {
    format!(
      "{}\n\n## Folders\n\n{}\n{}",
      text[..documents_start].trim_end_matches('\n'),
      entry.trim_end(),
      &text[documents_start..]
    )
  };
  parent.content_hash = content_hash(&changed);
  if changed != text {
    writes.insert(parent.repo_path.clone(), changed.into_bytes());
  }
  source
    .validate_overviews(source_workspace, std::iter::empty())
    .map_err(|_| invalid())?;
  writes.insert(
    plan.source_manifest.clone(),
    source.to_json().map_err(|_| invalid())?.into_bytes(),
  );
  let deletions = if plan.choice == WorkspaceContentGitSyncChoice::Move {
    vec![plan.target_manifest.clone()]
  } else {
    Vec::new()
  };
  Ok((ExtractMetadataChanges { writes, target_paths }, deletions))
}

fn relative(from: &str, to: &str) -> Result<String, String> {
  MarkdownBatchReferenceInventory::new("https://myoxus.invalid", std::iter::empty())
    .map_err(|_| invalid())?
    .for_source(from)
    .map_err(|_| invalid())?
    .resolve_export_asset_path(to)
    .ok_or_else(invalid)
}

fn link(name: &str, path: &str) -> String {
  format!(
    "[{}]({})",
    yjs::markdown::escape_markdown_label(name),
    yjs::markdown::escape_markdown_destination(path)
  )
}

fn original<'a>(
  plan: &WorkspaceContentGitSyncPlan,
  files: &'a BTreeMap<String, Vec<u8>>,
  path: &str,
) -> Result<&'a [u8], String> {
  use sha2::{Digest, Sha256};
  let bytes = files.get(path).ok_or_else(invalid)?;
  if plan.observed_hashes.get(path) != Some(&hex::encode(Sha256::digest(bytes))) {
    return Err(invalid());
  }
  Ok(bytes)
}

/// Use parser ranges so literal code and text resembling a URL cannot become
/// collateral replacements. Reference definitions retain their labels/titles.
fn rewrite_assets(plan: &WorkspaceContentGitSyncPlan, path: &str, body: &str) -> Result<String, String> {
  use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
  let mappings = plan
    .shared_files
    .iter()
    .map(|file| {
      Ok((
        relative(path, &file.source.repo_path)?,
        relative(path, &file.target_repo_path)?,
      ))
    })
    .collect::<Result<BTreeMap<_, _>, String>>()?;
  if mappings.is_empty() {
    return Ok(body.into());
  }
  let mut edits = Vec::new();
  let parser = Parser::new_ext(body, Options::all());
  for (_, definition) in parser.reference_definitions().iter() {
    let Some(target) = mappings.get(definition.dest.as_ref()) else {
      continue;
    };
    let snippet = &body[definition.span.clone()];
    let after = snippet.find("]:").ok_or_else(invalid)? + 2;
    let tail = &snippet[after..];
    let start = after + tail.len() - tail.trim_start().len() + usize::from(tail.trim_start().starts_with('<'));
    if !snippet[start..].starts_with(definition.dest.as_ref()) {
      return Err(invalid());
    }
    edits.push((
      definition.span.start + start,
      definition.span.start + start + definition.dest.len(),
      target.clone(),
    ));
  }
  for (event, range) in parser.into_offset_iter() {
    let (kind, destination) = match event {
      Event::Start(Tag::Image {
        link_type, dest_url, ..
      })
      | Event::Start(Tag::Link {
        link_type, dest_url, ..
      }) => (link_type, dest_url),
      _ => continue,
    };
    let Some(target) = mappings.get(destination.as_ref()) else {
      continue;
    };
    if kind != LinkType::Inline {
      continue;
    }
    let snippet = &body[range.clone()];
    let start = snippet.rfind("](").ok_or_else(invalid)? + 2;
    let tail = &snippet[start..];
    let whitespace = tail.len() - tail.trim_start().len();
    let start = start + whitespace + usize::from(tail.trim_start().starts_with('<'));
    if !snippet[start..].starts_with(destination.as_ref()) {
      return Err(invalid());
    }
    edits.push((
      range.start + start,
      range.start + start + destination.len(),
      target.clone(),
    ));
  }
  let mut result = body.to_owned();
  edits.sort_by_key(|(start, _, _)| *start);
  edits.dedup();
  if edits.windows(2).any(|pair| pair[0].1 > pair[1].0) {
    return Err(invalid());
  }
  for (start, end, target) in edits.into_iter().rev() {
    result.replace_range(start..end, &target);
  }
  Ok(result)
}

/// Merge only departed membership into the source's current valid inventory.
/// Authored paths and Markdown bodies stay fixed; generated overview bytes may
/// change only with positive manifest ownership and matching recorded hashes.
pub fn prepare(
  plan: &WorkspaceContentGitSyncPlan,
  source_workspace: Uuid,
  target_workspace: Uuid,
  folder_id: &str,
  target_name: &str,
  current_source: &GitSyncManifest,
  files: &BTreeMap<String, Vec<u8>>,
) -> Result<ExtractMetadataChanges, String> {
  let recorded: GitSyncManifest =
    serde_json::from_value(plan.manifest_inventory.clone().ok_or_else(invalid)?).map_err(|_| invalid())?;
  recorded
    .validate_overviews(source_workspace, std::iter::empty())
    .map_err(|_| invalid())?;
  current_source
    .validate_overviews(source_workspace, std::iter::empty())
    .map_err(|_| invalid())?;
  let root = recorded
    .folders
    .iter()
    .find(|folder| folder.organizer_id == folder_id)
    .ok_or_else(invalid)?;
  let root_output = root.overview.as_ref().ok_or_else(invalid)?;
  let prefix = format!("{}/", plan.target_root);
  let delegated = |path: &str| {
    plan.delegated_descendants.iter().any(|fence| {
      path == fence.repo_path || (fence.is_directory && path.starts_with(&format!("{}/", fence.repo_path)))
    })
  };
  let selected = recorded
    .folders
    .iter()
    .filter(|folder| {
      folder.organizer_path.iter().any(|id| id == folder_id)
        && folder
          .overview
          .as_ref()
          .is_some_and(|output| output.repo_path.starts_with(&prefix) && !delegated(&output.repo_path))
    })
    .collect::<Vec<_>>();
  let mut target = recorded.clone();
  target.workspace_id = target_workspace;
  target.overview = Some(root_output.clone());
  target.folders = selected
    .iter()
    .filter(|folder| folder.organizer_id != folder_id)
    .map(|folder| {
      let mut folder = (*folder).clone();
      let cut = folder
        .organizer_path
        .iter()
        .position(|id| id == folder_id)
        .ok_or_else(invalid)?
        + 1;
      folder.organizer_path = folder.organizer_path[cut..].to_vec();
      folder.path = folder.path.get(cut..).ok_or_else(invalid)?.to_vec();
      if folder.parent_organizer_id.as_deref() == Some(folder_id) {
        folder.parent_organizer_id = None;
      }
      Ok(folder)
    })
    .collect::<Result<_, String>>()?;
  target.documents = recorded
    .documents
    .iter()
    .filter(|document| plan.documents.iter().any(|binding| binding.doc_id == document.doc_id))
    .map(|document| {
      let mut document = document.clone();
      document.organizer_folder_ids = document
        .organizer_folder_ids
        .iter()
        .skip_while(|id| id.as_str() != folder_id)
        .skip(1)
        .cloned()
        .collect();
      document
    })
    .collect();
  if target.documents.len() != plan.documents.len() {
    return Err(invalid());
  }
  let mut source = current_source.clone();
  if source.documents.iter().any(|document| {
    plan
      .documents
      .iter()
      .any(|binding| binding.doc_id == document.doc_id && binding.repo_path != document.repo_path)
  }) {
    return Err(invalid());
  }
  source
    .documents
    .retain(|document| !plan.documents.iter().any(|binding| binding.doc_id == document.doc_id));
  source
    .folders
    .retain(|folder| !folder.organizer_path.iter().any(|id| id == folder_id));
  let mut writes = BTreeMap::new();
  let mut target_paths = BTreeSet::new();
  for shared in &plan.shared_files {
    if files.contains_key(&shared.target_repo_path) {
      return Err(invalid());
    }
    writes.insert(
      shared.target_repo_path.clone(),
      original(plan, files, &shared.source.repo_path)?.to_vec(),
    );
    target_paths.insert(shared.target_repo_path.clone());
  }
  for binding in &plan.documents {
    let bytes = original(plan, files, &binding.repo_path)?;
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let (header, body) = split_markdown_file(text);
    let header = header.ok_or_else(invalid)?;
    let identity = ExportFrontmatter::from_yaml(&header).ok_or_else(invalid)?;
    if identity.workspace_id != source_workspace
      || identity.doc_id != binding.doc_id
      || identity.sync_id != binding.sync_id
      || ["workspace_id:", "doc_id:", "sync_id:"]
        .iter()
        .any(|key| header.lines().filter(|line| line.trim_start().starts_with(key)).count() != 1)
    {
      return Err(invalid());
    }
    let header = header
      .lines()
      .map(|line| {
        if line.trim_start().starts_with("workspace_id:") {
          format!("workspace_id: {target_workspace}")
        } else {
          line.to_owned()
        }
      })
      .collect::<Vec<_>>()
      .join("\n");
    let body = rewrite_assets(plan, &binding.repo_path, &body)?;
    target
      .documents
      .iter_mut()
      .find(|document| document.doc_id == binding.doc_id)
      .ok_or_else(invalid)?
      .content_hash = content_hash(&body);
    writes.insert(
      binding.repo_path.clone(),
      format!("---\n{header}\n---\n{body}").into_bytes(),
    );
    target_paths.insert(binding.repo_path.clone());
  }
  for binding in &plan.files {
    original(plan, files, &binding.repo_path)?;
    target_paths.insert(binding.repo_path.clone());
  }
  // Retain the generated introduction/table from the accepted Git capture;
  // only the root heading and structural breadcrumb belong to this handoff.
  for folder in &selected {
    let output = folder.overview.as_ref().ok_or_else(invalid)?;
    let bytes = original(plan, files, &output.repo_path)?;
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let parts = text.splitn(4, "\n\n").collect::<Vec<_>>();
    if parts.len() != 4 || !super::overview::is_git_overview_marked(text) {
      return Err(invalid());
    }
    let mut breadcrumbs = vec![link(target_name, &relative(&output.repo_path, &root_output.repo_path)?)];
    for ancestor_id in folder
      .organizer_path
      .iter()
      .skip_while(|id| id.as_str() != folder_id)
      .skip(1)
    {
      let ancestor = recorded
        .folders
        .iter()
        .find(|folder| folder.organizer_id == *ancestor_id)
        .ok_or_else(invalid)?;
      let ancestor_output = ancestor.overview.as_ref().ok_or_else(invalid)?;
      breadcrumbs.push(link(
        &ancestor.name,
        &relative(&output.repo_path, &ancestor_output.repo_path)?,
      ));
    }
    let heading = if folder.organizer_id == folder_id {
      format!("# {}", yjs::markdown::escape_markdown_literal_text(target_name))
    } else {
      parts[1].to_owned()
    };
    let rendered = format!(
      "{}\n\n{}\n\n{}\n\n{}",
      parts[0],
      heading,
      breadcrumbs.join(" / "),
      parts[3]
    );
    let rendered = rewrite_assets(plan, &output.repo_path, &rendered)?;
    let hash = content_hash(&rendered);
    if folder.organizer_id == folder_id {
      target.overview.as_mut().ok_or_else(invalid)?.content_hash = hash;
    } else {
      target
        .folders
        .iter_mut()
        .find(|entry| entry.organizer_id == folder.organizer_id)
        .and_then(|folder| folder.overview.as_mut())
        .ok_or_else(invalid)?
        .content_hash = hash;
    }
    writes.insert(output.repo_path.clone(), rendered.into_bytes());
    target_paths.insert(output.repo_path.clone());
  }
  // Source sync may have refreshed its overviews already. Its current manifest,
  // not the old receipt hash, owns those sibling bytes.
  let affected_parent = current_source
    .folders
    .iter()
    .find(|folder| folder.organizer_id == folder_id)
    .and_then(|folder| match &folder.parent_organizer_id {
      Some(parent) => current_source
        .folders
        .iter()
        .find(|folder| folder.organizer_id == *parent)
        .and_then(|folder| folder.overview.as_ref()),
      None => current_source.overview.as_ref(),
    })
    .map(|output| output.repo_path.clone());
  for output in source
    .overview
    .iter_mut()
    .chain(source.folders.iter_mut().filter_map(|folder| folder.overview.as_mut()))
  {
    let bytes = files.get(&output.repo_path).ok_or_else(invalid)?;
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    if content_hash(text) != output.content_hash || !super::overview::is_git_overview_marked(text) {
      return Err(invalid());
    }
    if affected_parent.as_deref() != Some(output.repo_path.as_str()) {
      continue;
    }
    let departing_link = format!("]({})", relative(&output.repo_path, &root_output.repo_path)?);
    let start = text.rfind("\n## Folders\n").ok_or_else(invalid)?;
    let end = start + text[start..].find("\n## Documents\n").ok_or_else(invalid)?;
    let mut section = text[start..end]
      .split_inclusive('\n')
      .filter(|line| !(line.starts_with("- [") && line.trim_end_matches('\n').ends_with(&departing_link)))
      .collect::<String>();
    if !section.lines().any(|line| line.starts_with("- [")) {
      section.clear();
    }
    let changed = format!("{}{}{}", &text[..start], section, &text[end..]);
    if changed != *text {
      output.content_hash = content_hash(&changed);
      writes.insert(output.repo_path.clone(), changed.into_bytes());
    }
  }
  writes.insert(
    plan.source_manifest.clone(),
    source.to_json().map_err(|_| invalid())?.into_bytes(),
  );
  writes.insert(
    plan.target_manifest.clone(),
    target.to_json().map_err(|_| invalid())?.into_bytes(),
  );
  target_paths.insert(plan.target_manifest.clone());
  Ok(ExtractMetadataChanges { writes, target_paths })
}
