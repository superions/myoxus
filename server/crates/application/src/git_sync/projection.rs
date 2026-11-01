// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canonical document projection for change detection.
//!
//! Computes deterministic hashes of document content and structure
//! to detect changes without comparing full binaries.  Content hashes
//! use the Markdown canonical form (not the Yjs binary) because Yjs
//! block IDs are not stable across re-encoding.

use std::collections::HashMap;

use sha2::{Digest, Sha256};
use tracing::instrument;
use uuid::Uuid;

use crate::organizer::{OrganizerLinkType, OrganizerSnapshot, OrganizerSnapshotNode};

use super::export::GitSyncManifestFolder;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocumentOrganizerPlacement {
  pub organizer_entry_id: Option<String>,
  pub folder_ids: Vec<String>,
  pub folder_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrganizerProjection {
  pub revision: String,
  pub folders: Vec<GitSyncManifestFolder>,
  pub documents: HashMap<Uuid, DocumentOrganizerPlacement>,
}

/// Flatten the validated Organizer snapshot into Git-Sync placements.
///
/// Only local document links participate. Other organizer resource kinds and
/// cross-workspace links remain Organizer data but cannot place a Markdown
/// document owned by this workspace.
pub fn project_organizer(
  snapshot: &OrganizerSnapshot,
  document_ids_by_external_key: &HashMap<String, Uuid>,
) -> OrganizerProjection {
  let mut projection = OrganizerProjection {
    revision: snapshot.revision.clone(),
    folders: Vec::new(),
    documents: HashMap::new(),
  };
  for root in &snapshot.roots {
    project_node(
      snapshot.workspace_id,
      root,
      &[],
      &[],
      document_ids_by_external_key,
      &mut projection,
    );
  }
  projection
}

fn project_node(
  workspace_id: Uuid,
  node: &OrganizerSnapshotNode,
  folder_ids: &[String],
  folder_names: &[String],
  document_ids_by_external_key: &HashMap<String, Uuid>,
  projection: &mut OrganizerProjection,
) {
  if node.row.is_workspace_root() {
    // Extract's retained container is the workspace root, not a repository
    // directory. Its children keep their own identities and root-relative paths.
    for child in &node.children {
      project_node(
        workspace_id,
        child,
        folder_ids,
        folder_names,
        document_ids_by_external_key,
        projection,
      );
    }
    return;
  }
  if node.row.is_folder() {
    let mut child_ids = folder_ids.to_vec();
    child_ids.push(node.row.id.clone());
    let mut child_names = folder_names.to_vec();
    child_names.push(node.row.data.clone());
    projection.folders.push(GitSyncManifestFolder {
      organizer_id: node.row.id.clone(),
      parent_organizer_id: folder_ids.last().cloned(),
      name: node.row.data.clone(),
      organizer_path: child_ids.clone(),
      path: child_names.clone(),
      overview: None,
    });
    for child in &node.children {
      project_node(
        workspace_id,
        child,
        &child_ids,
        &child_names,
        document_ids_by_external_key,
        projection,
      );
    }
    return;
  }

  if node.row.link_type() != Ok(OrganizerLinkType::Doc)
    || node.row.effective_target_workspace_id(workspace_id) != workspace_id
  {
    return;
  }
  let Some(&doc_id) = document_ids_by_external_key.get(&node.row.data) else {
    return;
  };
  projection.documents.insert(
    doc_id,
    DocumentOrganizerPlacement {
      organizer_entry_id: Some(node.row.id.clone()),
      folder_ids: folder_ids.to_vec(),
      folder_names: folder_names.to_vec(),
    },
  );
}

/// Hash of the document's structural position in the workspace.
/// Includes parent path and title -- changes when doc is renamed or moved.
#[instrument]
pub fn structure_hash(repo_path: &str, title: &str) -> String {
  let mut hasher = Sha256::new();
  // Length-prefix the path to prevent ambiguity between path/title boundaries
  // e.g. path="a|" title="b" vs path="a" title="|b"
  let path_len = repo_path.len() as u64;
  hasher.update(path_len.to_le_bytes());
  hasher.update(repo_path.as_bytes());
  hasher.update(title.as_bytes());
  format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::organizer::{OrganizerRow, OrganizerSnapshotNode};

  #[test]
  fn structure_hash_deterministic() {
    let h1 = structure_hash("content/docs/test.md", "Test Doc");
    let h2 = structure_hash("content/docs/test.md", "Test Doc");
    assert_eq!(h1, h2);
  }

  #[test]
  fn structure_hash_changes_on_path_change() {
    let h1 = structure_hash("content/a/test.md", "Test");
    let h2 = structure_hash("content/b/test.md", "Test");
    assert_ne!(h1, h2);
  }

  #[test]
  fn structure_hash_changes_on_title_change() {
    let h1 = structure_hash("content/test.md", "Title A");
    let h2 = structure_hash("content/test.md", "Title B");
    assert_ne!(h1, h2);
  }

  #[test]
  fn structure_hash_separator_prevents_collision() {
    // "a|" + "b" vs "a" + "|b" must produce different hashes
    let h1 = structure_hash("a|", "b");
    let h2 = structure_hash("a", "|b");
    assert_ne!(h1, h2, "separator must prevent path/title collision");
  }

  #[test]
  fn organizer_projection_preserves_five_levels_empty_folders_and_stable_ids() {
    fn folder(
      id: &str,
      parent: Option<&str>,
      name: &str,
      children: Vec<OrganizerSnapshotNode>,
    ) -> OrganizerSnapshotNode {
      OrganizerSnapshotNode {
        row: OrganizerRow {
          id: id.into(),
          parent_id: parent.map(str::to_string),
          data: name.into(),
          row_type: "folder".into(),
          index: id.into(),
          target_workspace_id: None,
        },
        children,
      }
    }
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let link = OrganizerSnapshotNode {
      row: OrganizerRow {
        id: "entry-doc".into(),
        parent_id: Some("folder-5".into()),
        data: doc_id.to_string(),
        row_type: "doc".into(),
        index: "a".into(),
        target_workspace_id: Some(workspace_id),
      },
      children: vec![],
    };
    let snapshot = OrganizerSnapshot {
      workspace_id,
      revision: "revision-fixture".into(),
      roots: vec![
        folder(
          "folder-1",
          None,
          "One",
          vec![folder(
            "folder-2",
            Some("folder-1"),
            "Two",
            vec![folder(
              "folder-3",
              Some("folder-2"),
              "Three",
              vec![folder(
                "folder-4",
                Some("folder-3"),
                "Four",
                vec![folder("folder-5", Some("folder-4"), "Five", vec![link])],
              )],
            )],
          )],
        ),
        folder("empty-folder", None, "Empty", vec![]),
      ],
    };

    let projected = project_organizer(&snapshot, &HashMap::from([(doc_id.to_string(), doc_id)]));
    let placement = projected.documents.get(&doc_id).expect("document placement");
    assert_eq!(
      placement.folder_ids,
      ["folder-1", "folder-2", "folder-3", "folder-4", "folder-5"]
    );
    assert_eq!(placement.folder_names, ["One", "Two", "Three", "Four", "Five"]);
    assert_eq!(placement.organizer_entry_id.as_deref(), Some("entry-doc"));
    assert!(
      projected
        .folders
        .iter()
        .any(|folder| folder.organizer_id == "empty-folder"),
      "empty folders must remain manifest-visible"
    );
    let mut extracted = snapshot;
    let mut structural_root = folder("retained-root", None, "Extracted source", extracted.roots);
    structural_root.row.row_type = "workspace-root".into();
    for child in &mut structural_root.children {
      child.row.parent_id = Some("retained-root".into());
    }
    extracted.roots = vec![structural_root];
    let projected = project_organizer(&extracted, &HashMap::from([(doc_id.to_string(), doc_id)]));
    assert_eq!(
      projected.documents[&doc_id].folder_names,
      ["One", "Two", "Three", "Four", "Five"]
    );
    assert_eq!(projected.folders.len(), 6);
    let paths = super::super::export::paths_by_document(
      &super::super::export::plan_document_paths(
        "content",
        &[super::super::export::PathPlanDocument {
          doc_id,
          title: "Runbook".into(),
          folder_names: projected.documents[&doc_id].folder_names.clone(),
          existing_repo_path: None,
        }],
        &Default::default(),
      )
      .unwrap(),
    );
    let overview = super::super::overview::plan_git_overview_paths(
      workspace_id,
      "content",
      &projected,
      &paths,
      &Default::default(),
      &Default::default(),
      None,
    )
    .unwrap();
    assert_eq!(overview.workspace.as_str(), "content/README.md");
    assert_eq!(overview.folders.len(), 6);
    assert_eq!(overview.folders["empty-folder"].as_str(), "content/empty/README.md");
    assert_eq!(
      overview.folders["folder-5"].as_str(),
      "content/one/two/three/four/five/README.md"
    );
    assert_eq!(overview.documents[&doc_id].as_str(), paths[&doc_id]);
    assert_eq!(projected.folders[0].parent_organizer_id, None);
    assert!(
      !projected
        .folders
        .iter()
        .any(|folder| folder.organizer_id == "retained-root")
    );
  }

  #[test]
  fn organizer_projection_resolves_only_exact_external_keys() {
    let workspace_id = Uuid::new_v4();
    let nano_doc_id = Uuid::new_v4();
    let collision_doc_id = Uuid::new_v4();
    let uuid_shape_owner_doc_id = Uuid::new_v4();
    let uuid_shaped_external_key = uuid_shape_owner_doc_id.to_string();
    let link = |id: &str, target: &str| OrganizerSnapshotNode {
      row: OrganizerRow {
        id: id.into(),
        parent_id: None,
        data: target.into(),
        row_type: "doc".into(),
        index: id.into(),
        target_workspace_id: Some(workspace_id),
      },
      children: vec![],
    };
    let snapshot = OrganizerSnapshot {
      workspace_id,
      revision: "external-key-fixture".into(),
      roots: vec![
        link("entry-nano", "NanoPlacementKey8kR"),
        link("entry-missing", "MissingPlacementKey8kR"),
        link("entry-collision", &uuid_shaped_external_key),
      ],
    };
    let projected = project_organizer(
      &snapshot,
      &HashMap::from([
        ("NanoPlacementKey8kR".to_string(), nano_doc_id),
        (uuid_shaped_external_key, collision_doc_id),
      ]),
    );

    assert_eq!(
      projected
        .documents
        .get(&nano_doc_id)
        .and_then(|placement| placement.organizer_entry_id.as_deref()),
      Some("entry-nano")
    );
    assert_eq!(
      projected
        .documents
        .get(&collision_doc_id)
        .and_then(|placement| placement.organizer_entry_id.as_deref()),
      Some("entry-collision"),
      "a UUID-shaped external key must bind only through the supplied identity map"
    );
    assert!(
      !projected.documents.contains_key(&uuid_shape_owner_doc_id),
      "UUID shape must not bind the row whose internal UUID matches the external key"
    );
    assert_eq!(
      projected.documents.len(),
      2,
      "an unavailable Organizer target must stay unbound"
    );
  }
}
