// SPDX-License-Identifier: AGPL-3.0-or-later
//! Product-oriented MCP folder workflows composed from existing application owners.

use std::collections::HashMap;
use std::future::Future;

use myoxus_application::organizer::{
  CreateOrganizerFolder, CreateOrganizerLink, OrganizerFolderResolutionError, OrganizerLinkType, OrganizerRow,
  OrganizerSnapshot, OrganizerSnapshotNode, UpdateOrganizerLink, resolve_organizer_folder_id,
  resolve_organizer_folder_path,
};
use myoxus_domain::permission::WorkspaceAction;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::McpAuthContext;

use super::{
  McpToolState, assert_workspace_permission, begin_mcp_idempotency, check_workspace_membership,
  finish_or_abort_mcp_write, map_organizer_error, map_workspace_content_link_error, mcp_json_response,
  organizer_service, resolve_external_document_for_mcp, workspace_content_link_service,
};

const DEFAULT_MAX_DEPTH: u8 = 32;
const MAX_MAX_DEPTH: u8 = 32;
const REVISION_CONFLICT: &str = "MIX_MCP_FOLDER_TREE_REVISION_CONFLICT: organizer changed while building folder tree";
const PATH_AMBIGUOUS: &str = "MIX_MCP_FOLDER_PATH_AMBIGUOUS";
const PATH_NOT_FOUND: &str = "MIX_MCP_FOLDER_PATH_NOT_FOUND";
const ENTRY_DUPLICATE: &str = "MIX_MCP_FOLDER_ENTRY_DUPLICATE";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FolderTreeRequest {
  workspace_id: Uuid,
  max_depth: Option<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FolderPathEnsureRequest {
  workspace_id: Uuid,
  path: Vec<String>,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FolderEntryPlaceRequest {
  workspace_id: Uuid,
  folder_id: Option<String>,
  folder_path: Option<Vec<String>>,
  external_id: String,
  #[serde(rename = "idempotency_key")]
  _idempotency_key: String,
}

#[derive(Debug)]
pub(super) struct ResolvedPath {
  pub folder_id: String,
  pub path: Vec<String>,
}

#[derive(Debug)]
struct PathPrefix {
  parent_id: Option<String>,
  missing_from: usize,
}

pub(super) async fn tree(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  let request: FolderTreeRequest = serde_json::from_value(params.clone())
    .map_err(|error| (-32602, format!("Invalid folder_tree arguments: {error}")))?;
  let max_depth = request.max_depth.unwrap_or(DEFAULT_MAX_DEPTH);
  if !(1..=MAX_MAX_DEPTH).contains(&max_depth) {
    return Err((-32602, format!("max_depth must be between 1 and {MAX_MAX_DEPTH}")));
  }

  check_workspace_membership(&state.workspace_service, auth.user_id, request.workspace_id).await?;
  // The tree is workspace navigation. Check normal Read before loading even a
  // revision; link targets are then filtered through their own ACLs below.
  assert_workspace_permission(state, auth.user_id, request.workspace_id, WorkspaceAction::Read).await?;
  let organizer = organizer_service(state);
  let links = workspace_content_link_service(state);
  let (snapshot, visible_links) = load_coherent_pair(|| async {
    let snapshot = organizer
      .snapshot(request.workspace_id)
      .await
      .map_err(map_organizer_error)?;
    let visible_links = links
      .visible_links(auth.user_id, request.workspace_id)
      .await
      .map_err(map_workspace_content_link_error)?;
    Ok((snapshot, visible_links))
  })
  .await?;

  Ok(project_tree(snapshot, visible_links, max_depth))
}

pub(super) async fn ensure_path(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let request: FolderPathEnsureRequest = serde_json::from_value(params.clone())
    .map_err(|error| (-32602, format!("Invalid folder_path_ensure arguments: {error}")))?;
  validate_path(&request.path)?;
  check_workspace_membership(&state.workspace_service, auth.user_id, request.workspace_id).await?;
  // Ensuring a path mutates document placement in this workspace. CreateDoc is
  // the normal editor capability for that structure; Organizer-specific
  // administration is intentionally not part of the public Folder contract.
  assert_workspace_permission(state, auth.user_id, request.workspace_id, WorkspaceAction::CreateDoc).await?;

  let guard = match begin_mcp_idempotency("folder_path_ensure", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = async {
    let organizer = organizer_service(state);
    let snapshot = organizer
      .snapshot(request.workspace_id)
      .await
      .map_err(map_organizer_error)?;
    let prefix = resolve_path_prefix(&snapshot.roots, &request.path)?;
    let mut parent_id = prefix.parent_id;
    let mut created = Vec::new();
    for name in request.path.iter().skip(prefix.missing_from) {
      let folder = organizer
        .create_folder(
          request.workspace_id,
          CreateOrganizerFolder {
            id: Uuid::new_v4().to_string(),
            parent_id: parent_id.clone(),
            name: name.clone(),
            index: None,
          },
        )
        .await
        .map_err(map_organizer_error)?;
      parent_id = Some(folder.id.clone());
      created.push(json!({ "id": folder.id, "name": folder.data }));
    }
    let folder_id = parent_id.ok_or_else(|| (-32602, "folder path must not be empty".to_string()))?;
    Ok(mcp_json_response(json!({
      "workspaceId": request.workspace_id,
      "folderId": folder_id,
      "path": request.path,
      "createdSegments": created,
    })))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn place_entry(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let request: FolderEntryPlaceRequest = serde_json::from_value(params.clone())
    .map_err(|error| (-32602, format!("Invalid folder_entry_place arguments: {error}")))?;
  validate_destination_selector(request.folder_id.as_deref(), request.folder_path.as_deref())?;
  check_workspace_membership(&state.workspace_service, auth.user_id, request.workspace_id).await?;
  // Placement changes only the containing workspace. The linked document is
  // authorized separately through its normal read ACL before the row changes.
  assert_workspace_permission(state, auth.user_id, request.workspace_id, WorkspaceAction::CreateDoc).await?;

  let guard = match begin_mcp_idempotency("folder_entry_place", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = async {
    let destination = resolve_existing_destination(
      state,
      request.workspace_id,
      request.folder_id.as_deref(),
      request.folder_path.as_deref(),
    )
    .await?;
    let resolved_document =
      resolve_external_document_for_mcp(&state.doc_service, request.workspace_id, &request.external_id).await?;
    let links = workspace_content_link_service(state);
    let (_, visible_links) = links
      .visible_links(auth.user_id, request.workspace_id)
      .await
      .map_err(map_workspace_content_link_error)?;
    let mut matching = visible_links
      .into_iter()
      .filter(|row| {
        row.row_type == OrganizerLinkType::Doc.as_str()
          && row.effective_target_workspace_id(request.workspace_id) == request.workspace_id
          && row.data == resolved_document.external_id
      })
      .collect::<Vec<_>>();
    matching.sort_by(|left, right| left.id.cmp(&right.id));
    if matching.len() > 1 {
      let candidates = matching.iter().map(|row| row.id.as_str()).collect::<Vec<_>>().join(",");
      return Err((
        -32009,
        format!("{ENTRY_DUPLICATE}: document has multiple organizer entries; candidate entry ids: {candidates}"),
      ));
    }

    let (entry, outcome) = match matching.pop() {
      None => {
        let entry = links
          .create(
            auth.user_id,
            request.workspace_id,
            CreateOrganizerLink {
              id: Uuid::new_v4().to_string(),
              parent_id: destination.folder_id.clone(),
              link_type: OrganizerLinkType::Doc,
              target_id: resolved_document.external_id.clone(),
              target_workspace_id: None,
              index: None,
            },
          )
          .await
          .map_err(map_workspace_content_link_error)?;
        (entry, "created")
      }
      Some(entry) if entry.parent_id.as_deref() == Some(destination.folder_id.as_str()) => (entry, "already_placed"),
      Some(entry) => {
        let entry_id = entry.id.clone();
        let entry = links
          .update(
            auth.user_id,
            request.workspace_id,
            &entry_id,
            UpdateOrganizerLink {
              parent_id: Some(destination.folder_id.clone()),
              ..UpdateOrganizerLink::default()
            },
          )
          .await
          .map_err(map_workspace_content_link_error)?;
        (entry, "moved")
      }
    };

    Ok(mcp_json_response(json!({
      "workspaceId": request.workspace_id,
      "externalId": resolved_document.external_id,
      "folderId": destination.folder_id,
      "folderPath": destination.path,
      "entryId": entry.id,
      "outcome": outcome,
    })))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

fn validate_path(path: &[String]) -> Result<(), (i32, String)> {
  if path.is_empty() {
    return Err((-32602, "folder path must contain at least one segment".to_string()));
  }
  for segment in path {
    let count = segment.chars().count();
    if segment.trim().is_empty() || count > 256 {
      return Err((
        -32602,
        "folder path segments must contain 1 to 256 characters".to_string(),
      ));
    }
  }
  Ok(())
}

pub(super) fn validate_destination_selector(
  folder_id: Option<&str>,
  folder_path: Option<&[String]>,
) -> Result<(), (i32, String)> {
  match (folder_id, folder_path) {
    (Some(id), None) if !id.trim().is_empty() => Ok(()),
    (None, Some(path)) => validate_path(path),
    (Some(_), Some(_)) => Err((
      -32602,
      "exactly one of folder_id or folder_path is required".to_string(),
    )),
    _ => Err((
      -32602,
      "exactly one of folder_id or folder_path is required".to_string(),
    )),
  }
}

pub(super) async fn resolve_existing_destination(
  state: &McpToolState,
  workspace_id: Uuid,
  folder_id: Option<&str>,
  folder_path: Option<&[String]>,
) -> Result<ResolvedPath, (i32, String)> {
  let snapshot = organizer_service(state)
    .snapshot(workspace_id)
    .await
    .map_err(map_organizer_error)?;
  resolve_destination(&snapshot, folder_id, folder_path)
}

fn resolve_path_prefix(nodes: &[OrganizerSnapshotNode], path: &[String]) -> Result<PathPrefix, (i32, String)> {
  let mut siblings = nodes;
  let mut parent_id = None;
  for (index, segment) in path.iter().enumerate() {
    let matches = siblings
      .iter()
      .filter(|node| node.row.is_folder() && node.row.data == *segment)
      .collect::<Vec<_>>();
    match matches.as_slice() {
      [] => {
        return Ok(PathPrefix {
          parent_id,
          missing_from: index,
        });
      }
      [node] => {
        parent_id = Some(node.row.id.clone());
        siblings = &node.children;
      }
      _ => {
        let mut candidate_ids = matches.iter().map(|node| node.row.id.as_str()).collect::<Vec<_>>();
        candidate_ids.sort_unstable();
        return Err((
          -32009,
          format!(
            "{PATH_AMBIGUOUS}: segment {index} `{segment}` has candidate folder ids: {}",
            candidate_ids.join(",")
          ),
        ));
      }
    }
  }
  Ok(PathPrefix {
    parent_id,
    missing_from: path.len(),
  })
}

fn resolve_destination(
  snapshot: &OrganizerSnapshot,
  folder_id: Option<&str>,
  folder_path: Option<&[String]>,
) -> Result<ResolvedPath, (i32, String)> {
  if let Some(folder_id) = folder_id {
    return resolve_organizer_folder_id(snapshot, folder_id)
      .map(|folder| ResolvedPath {
        folder_id: folder.folder_id,
        path: folder.path,
      })
      .ok_or_else(|| {
        (
          -32004,
          format!("{PATH_NOT_FOUND}: folder id `{folder_id}` does not exist"),
        )
      });
  }
  let path = folder_path.expect("destination selector was validated");
  resolve_organizer_folder_path(snapshot, path)
    .map(|folder| ResolvedPath {
      folder_id: folder.folder_id,
      path: folder.path,
    })
    .map_err(|error| match error {
      OrganizerFolderResolutionError::NotFound => {
        (-32004, format!("{PATH_NOT_FOUND}: exact folder path does not exist"))
      }
      OrganizerFolderResolutionError::Ambiguous {
        index,
        segment,
        candidate_ids,
      } => (
        -32009,
        format!(
          "{PATH_AMBIGUOUS}: segment {index} `{segment}` has candidate folder ids: {}",
          candidate_ids.join(",")
        ),
      ),
    })
}

async fn load_coherent_pair<L, F>(mut load_pair: L) -> Result<(OrganizerSnapshot, Vec<OrganizerRow>), (i32, String)>
where
  L: FnMut() -> F,
  F: Future<Output = Result<(OrganizerSnapshot, (String, Vec<OrganizerRow>)), (i32, String)>>,
{
  for _ in 0..2 {
    let (snapshot, (link_revision, visible_links)) = load_pair().await?;
    if snapshot.revision == link_revision {
      return Ok((snapshot, visible_links));
    }
  }
  Err((-32010, REVISION_CONFLICT.to_string()))
}

fn project_tree(snapshot: OrganizerSnapshot, visible_links: Vec<OrganizerRow>, max_depth: u8) -> Value {
  let mut entries_by_parent = HashMap::<String, Vec<OrganizerRow>>::new();
  for row in visible_links {
    if let Some(parent_id) = &row.parent_id {
      entries_by_parent.entry(parent_id.clone()).or_default().push(row);
    }
  }

  let folders = snapshot
    .roots
    .iter()
    .filter(|node| node.row.is_folder())
    .map(|node| project_folder(node, &[], 1, max_depth, &mut entries_by_parent))
    .collect::<Vec<_>>();

  json!({
    "workspaceId": snapshot.workspace_id,
    "revision": snapshot.revision,
    "maxDepth": max_depth,
    "folders": folders,
  })
}

fn project_folder(
  node: &OrganizerSnapshotNode,
  parent_path: &[String],
  depth: u8,
  max_depth: u8,
  entries_by_parent: &mut HashMap<String, Vec<OrganizerRow>>,
) -> Value {
  let mut path = parent_path.to_vec();
  path.push(node.row.data.clone());
  let entries = entries_by_parent
    .remove(&node.row.id)
    .unwrap_or_default()
    .into_iter()
    .map(project_entry)
    .collect::<Vec<_>>();
  let children = if depth < max_depth {
    node
      .children
      .iter()
      .filter(|child| child.row.is_folder())
      .map(|child| project_folder(child, &path, depth + 1, max_depth, entries_by_parent))
      .collect::<Vec<_>>()
  } else {
    Vec::new()
  };

  json!({
    "id": node.row.id,
    "name": node.row.data,
    "path": path,
    "index": node.row.index,
    "entries": entries,
    "children": children,
  })
}

fn project_entry(row: OrganizerRow) -> Value {
  if row.row_type == "doc" {
    json!({
      "id": row.id,
      "targetType": row.row_type,
      "externalId": row.data,
      "targetWorkspaceId": row.target_workspace_id,
      "index": row.index,
    })
  } else {
    json!({
      "id": row.id,
      "targetType": row.row_type,
      "targetId": row.data,
      "targetWorkspaceId": row.target_workspace_id,
      "index": row.index,
    })
  }
}

pub(super) fn summary(tool_name: &str, value: &Value) -> String {
  match tool_name {
    "folder_path_ensure" => {
      let created = value["createdSegments"].as_array().map_or(0, Vec::len);
      format!("Folder path resolved; {created} segment(s) created.")
    }
    "folder_entry_place" => {
      let outcome = value["outcome"].as_str().unwrap_or("completed");
      format!("Document placement {outcome}.")
    }
    _ => tree_summary(value),
  }
}

fn tree_summary(value: &Value) -> String {
  fn counts(folders: &[Value]) -> (usize, usize) {
    folders.iter().fold((0, 0), |(folder_count, entry_count), folder| {
      let entries = folder["entries"].as_array().map_or(0, Vec::len);
      let (child_folders, child_entries) = folder["children"]
        .as_array()
        .map_or((0, 0), |children| counts(children));
      (folder_count + 1 + child_folders, entry_count + entries + child_entries)
    })
  }

  let (folders, entries) = value["folders"].as_array().map_or((0, 0), |roots| counts(roots));
  let folder_label = if folders == 1 { "folder" } else { "folders" };
  let entry_label = if entries == 1 { "entry" } else { "entries" };
  format!("Folder tree contains {folders} {folder_label} and {entries} visible {entry_label}.")
}

#[cfg(test)]
mod tests {
  use std::collections::VecDeque;

  use super::*;

  fn snapshot(revision: &str) -> OrganizerSnapshot {
    OrganizerSnapshot {
      workspace_id: Uuid::nil(),
      revision: revision.to_string(),
      roots: Vec::new(),
    }
  }

  #[tokio::test]
  async fn coherent_pair_retries_once_and_accepts_the_new_revision() {
    let mut pairs = VecDeque::from([
      Ok((snapshot("a"), ("b".to_string(), Vec::new()))),
      Ok((snapshot("c"), ("c".to_string(), Vec::new()))),
    ]);

    let (snapshot, _) = load_coherent_pair(|| std::future::ready(pairs.pop_front().expect("pair")))
      .await
      .expect("second pair is coherent");

    assert_eq!(snapshot.revision, "c");
    assert!(pairs.is_empty());
  }

  #[tokio::test]
  async fn coherent_pair_fails_retryably_after_two_revision_mismatches() {
    let mut pairs = VecDeque::from([
      Ok((snapshot("a"), ("b".to_string(), Vec::new()))),
      Ok((snapshot("c"), ("d".to_string(), Vec::new()))),
    ]);

    let error = load_coherent_pair(|| std::future::ready(pairs.pop_front().expect("pair")))
      .await
      .expect_err("two mismatches must conflict");

    assert_eq!(error, (-32010, REVISION_CONFLICT.to_string()));
    assert!(pairs.is_empty());
  }
}
