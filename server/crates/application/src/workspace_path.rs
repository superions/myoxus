// SPDX-License-Identifier: AGPL-3.0-or-later
//! Deterministic, side-effect-free path allocation for workspace projections.

use std::collections::{BTreeMap, BTreeSet};

use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathPlanItem {
  pub id: Uuid,
  pub preferred_path: String,
  pub existing_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedPath {
  pub id: Uuid,
  pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum WorkspacePathPlanError {
  #[error("planned path `{path}` is invalid for {id}")]
  InvalidPath { id: Uuid, path: String },
  #[error("planned path `{path}` is already owned by {owner}")]
  PathAlreadyOwned { path: String, owner: String },
}

/// Allocate a complete batch before any file is serialized.
///
/// `case_fold` is enabled for portable archives because common Obsidian hosts
/// use case-insensitive filesystems. Git Sync keeps its established
/// case-sensitive behavior by passing `false`.
pub fn plan_workspace_paths(
  items: &[PathPlanItem],
  occupied_paths: &BTreeMap<String, String>,
  case_fold: bool,
) -> Result<Vec<PlannedPath>, WorkspacePathPlanError> {
  let mut groups: BTreeMap<String, Vec<&PathPlanItem>> = BTreeMap::new();
  for item in items {
    if !is_safe_relative_path(&item.preferred_path) {
      return Err(WorkspacePathPlanError::InvalidPath {
        id: item.id,
        path: item.preferred_path.clone(),
      });
    }
    groups
      .entry(path_key(&item.preferred_path, case_fold))
      .or_default()
      .push(item);
  }

  let occupied = occupied_paths
    .iter()
    .map(|(path, owner)| (path_key(path, case_fold), (path.as_str(), owner.as_str())))
    .collect::<BTreeMap<_, _>>();
  let mut claimed = BTreeSet::new();
  let mut planned = Vec::with_capacity(items.len());
  for (_, mut group) in groups {
    group.sort_by_key(|item| item.id);
    let base_path = group[0].preferred_path.clone();
    let base_key = path_key(&base_path, case_fold);
    let retained_owner = group
      .iter()
      .find(|item| {
        item
          .existing_path
          .as_ref()
          .is_some_and(|path| path_key(path, case_fold) == base_key)
      })
      .map(|item| item.id);
    let group_len = group.len();

    for item in group {
      let use_base = retained_owner == Some(item.id)
        || (retained_owner.is_none()
          && group_len == 1
          && !claimed.contains(&base_key)
          && !occupied.contains_key(&base_key));
      let path = if use_base {
        item.preferred_path.clone()
      } else {
        suffixed_path(&item.preferred_path, item.id)
      };
      if !is_safe_relative_path(&path) {
        return Err(WorkspacePathPlanError::InvalidPath { id: item.id, path });
      }
      let key = path_key(&path, case_fold);
      if let Some((occupied_path, owner)) = occupied.get(&key)
        && !item
          .existing_path
          .as_ref()
          .is_some_and(|existing| path_key(existing, case_fold) == key)
      {
        return Err(WorkspacePathPlanError::PathAlreadyOwned {
          path: (*occupied_path).to_string(),
          owner: (*owner).to_string(),
        });
      }
      if !claimed.insert(key) {
        return Err(WorkspacePathPlanError::PathAlreadyOwned {
          path,
          owner: "another item in the outbound plan".to_string(),
        });
      }
      planned.push(PlannedPath { id: item.id, path });
    }
  }
  planned.sort_by_key(|item| item.id);
  Ok(planned)
}

pub fn is_safe_relative_path(path: &str) -> bool {
  !path.is_empty()
    && !path.starts_with(['/', '\\'])
    && !path.contains('\\')
    && !path.chars().any(char::is_control)
    && path
      .split('/')
      .all(|component| !component.is_empty() && component != "." && component != "..")
    && !path.as_bytes().get(1).is_some_and(|byte| *byte == b':')
}

fn path_key(path: &str, case_fold: bool) -> String {
  if case_fold {
    path.to_lowercase()
  } else {
    path.to_string()
  }
}

fn suffixed_path(path: &str, id: Uuid) -> String {
  let suffix = &id.simple().to_string()[..12];
  let (parent, name) = path
    .rsplit_once('/')
    .map_or(("", path), |(parent, name)| (parent, name));
  let (stem, extension) = name
    .rsplit_once('.')
    .map_or((name, ""), |(stem, extension)| (stem, extension));
  let filename = if extension.is_empty() {
    format!("{stem}--{suffix}")
  } else {
    format!("{stem}--{suffix}.{extension}")
  };
  if parent.is_empty() {
    filename
  } else {
    format!("{parent}/{filename}")
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn portable_plan_prevents_case_folded_cross_kind_collisions() {
    let first = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
    let second = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
    let plan = plan_workspace_paths(
      &[
        PathPlanItem {
          id: second,
          preferred_path: "Notes/Shared.md".into(),
          existing_path: None,
        },
        PathPlanItem {
          id: first,
          preferred_path: "notes/shared.MD".into(),
          existing_path: None,
        },
      ],
      &BTreeMap::new(),
      true,
    )
    .unwrap();
    assert_eq!(plan[0].path, "notes/shared--111111111111.MD");
    assert_eq!(plan[1].path, "Notes/Shared--222222222222.md");
  }

  #[test]
  fn rejects_archive_traversal() {
    assert!(!is_safe_relative_path("../outside.md"));
    assert!(!is_safe_relative_path("C:/outside.md"));
    assert!(!is_safe_relative_path("nested//file.md"));
  }
}
