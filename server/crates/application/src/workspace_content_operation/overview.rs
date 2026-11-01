// SPDX-License-Identifier: AGPL-3.0-or-later
//! Scoped overview lineage inside the existing content-operation publication.

use myoxus_domain::workspace_content_operation::{
  WorkspaceContentErrorCode, WorkspaceContentIdMapping, WorkspaceContentOperationKind, WorkspaceContentResourceKind,
  WorkspaceContentResourceRef,
};
use myoxus_domain::workspace_overview::{FolderOverviewSettings, WorkspaceOverviewSettings};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};

/// Marks overview-aware accepted hashes in the existing preview revision. Old
/// queued plans remain distinguishable without a second acceptance ledger.
pub const OVERVIEW_PREVIEW_PREFIX: &str = "overview:";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentOverviewState {
  pub workspace_id: Uuid,
  pub revision: i64,
  pub settings: WorkspaceOverviewSettings,
}

/// Operation-local input; Move retains the same before-state in its existing
/// immutable manifest so Undo can restore only changes owned by that receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentOverviewSnapshot {
  pub source: WorkspaceContentOverviewState,
  /// Extract preflight has no target yet. Publication always supplies its row.
  pub target: Option<WorkspaceContentOverviewState>,
  pub extracted_folder_id: Option<String>,
}

pub fn has_folder_mappings(mappings: &[WorkspaceContentIdMapping]) -> bool {
  mappings
    .iter()
    .any(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Folder)
}

fn stale() -> AuthError {
  AuthError::InvalidInput(WorkspaceContentErrorCode::PreflightStale.as_str().into())
}

fn has_folder_settings(settings: &WorkspaceOverviewSettings, id: &str) -> bool {
  settings
    .folders
    .get(id)
    .is_some_and(|folder| *folder != FolderOverviewSettings::default())
}

fn remap_introduction(
  reference: &Option<WorkspaceContentResourceRef>,
  mappings: &[WorkspaceContentIdMapping],
) -> Option<WorkspaceContentResourceRef> {
  reference.as_ref().map(|reference| {
    mappings
      .iter()
      .find(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Document && mapping.source == *reference)
      .map(|mapping| mapping.target.clone())
      // An introduction is a binding, never an additional owned document.
      .unwrap_or_else(|| reference.clone())
  })
}

fn set_folder(settings: &mut WorkspaceOverviewSettings, id: &str, value: Option<FolderOverviewSettings>) {
  match value.filter(|value| *value != FolderOverviewSettings::default()) {
    Some(value) => {
      settings.folders.insert(id.into(), value);
    }
    None => {
      settings.folders.remove(id);
    }
  }
}

fn restore_owned<T: Clone + PartialEq>(result: &mut T, current: &T, before: &T, after: &T) -> AuthResult<()> {
  if before != after {
    if current != after {
      return Err(stale());
    }
    *result = before.clone();
  }
  Ok(())
}

impl WorkspaceContentOverviewSnapshot {
  /// Carry native counters inside the existing opaque accepted revision. Copy
  /// has no separate before-state receipt, so publication can fence a queue delay
  /// without introducing another persisted settings snapshot.
  pub fn accepted_revision(&self, hash: &str) -> String {
    let target = self
      .target
      .as_ref()
      .map(|state| state.revision.to_string())
      .unwrap_or_else(|| "-".into());
    format!("{OVERVIEW_PREVIEW_PREFIX}{}:{target}:{hash}", self.source.revision)
  }

  pub fn accepts_publication_revision(
    &self,
    kind: WorkspaceContentOperationKind,
    mappings: &[WorkspaceContentIdMapping],
    revision: Option<&str>,
  ) -> bool {
    let Some(revision) = revision.and_then(|revision| revision.strip_prefix(OVERVIEW_PREVIEW_PREFIX)) else {
      return self.affected_settings_empty(kind, mappings);
    };
    let parts = revision.split(':').collect::<Vec<_>>();
    if parts.len() != 3 || parts[2].len() != 64 || !parts[2].bytes().all(|byte| byte.is_ascii_hexdigit()) {
      return false;
    }
    let source_matches = parts[0].parse::<i64>().ok() == Some(self.source.revision);
    let target_matches = match self.target.as_ref() {
      Some(target) if kind == WorkspaceContentOperationKind::ExtractFolder => parts[1] == "-" && target.revision == 0,
      Some(target) => parts[1].parse::<i64>().ok() == Some(target.revision),
      None => false,
    };
    source_matches && target_matches
  }

  /// The bounded legacy path checks only transferred scopes and Extract's
  /// effective default. Unrelated root/folder configuration does not block it.
  pub fn affected_settings_empty(
    &self,
    kind: WorkspaceContentOperationKind,
    mappings: &[WorkspaceContentIdMapping],
  ) -> bool {
    !mappings
      .iter()
      .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Folder)
      .any(|mapping| {
        has_folder_settings(&self.source.settings, mapping.source.resource_id())
          || self
            .target
            .as_ref()
            .is_some_and(|target| has_folder_settings(&target.settings, mapping.target.resource_id()))
      })
      && !(kind == WorkspaceContentOperationKind::ExtractFolder && self.source.settings.register_presentation.is_some())
  }

  /// Preserve existing root settings for Copy/Move. Only Extract's selected
  /// folder becomes the new root, with its effective presentation made explicit.
  pub fn project(
    &self,
    kind: WorkspaceContentOperationKind,
    mappings: &[WorkspaceContentIdMapping],
  ) -> AuthResult<(WorkspaceOverviewSettings, WorkspaceOverviewSettings)> {
    let target = self.target.as_ref().ok_or_else(stale)?;
    if !matches!(
      kind,
      WorkspaceContentOperationKind::Copy
        | WorkspaceContentOperationKind::Move
        | WorkspaceContentOperationKind::ExtractFolder
    ) || (kind == WorkspaceContentOperationKind::ExtractFolder) != self.extracted_folder_id.is_some()
    {
      return Err(stale());
    }
    if kind == WorkspaceContentOperationKind::ExtractFolder
      && !mappings.iter().any(|mapping| {
        mapping.source.kind() == WorkspaceContentResourceKind::Folder
          && Some(mapping.source.resource_id()) == self.extracted_folder_id.as_deref()
      })
    {
      return Err(stale());
    }
    let mut source_settings = self.source.settings.clone();
    let mut target_settings = target.settings.clone();
    for mapping in mappings
      .iter()
      .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Folder)
    {
      if mapping.source.workspace_id() != self.source.workspace_id
        || mapping.target.workspace_id() != target.workspace_id
      {
        return Err(stale());
      }
      let source_id = mapping.source.resource_id();
      let target_id = mapping.target.resource_id();
      let original = self.source.settings.folders.get(source_id).cloned();
      if kind == WorkspaceContentOperationKind::ExtractFolder && self.extracted_folder_id.as_deref() == Some(source_id)
      {
        let original = original.unwrap_or_default();
        target_settings.introduction = remap_introduction(&original.introduction, mappings);
        target_settings.register_presentation = original
          .register_presentation
          .or_else(|| self.source.settings.register_presentation.clone());
        target_settings.folder_ids = None;
        target_settings.folders.remove(target_id);
      } else {
        let mapped = original.map(|original| FolderOverviewSettings {
          introduction: remap_introduction(&original.introduction, mappings),
          register_presentation: original.register_presentation,
        });
        // A stale setting on a reused destination identity is still user data.
        // Never silently replace it when materializing a new folder there.
        if has_folder_settings(&target.settings, target_id) && target.settings.folders.get(target_id) != mapped.as_ref()
        {
          return Err(stale());
        }
        set_folder(&mut target_settings, target_id, mapped);
      }
      if kind != WorkspaceContentOperationKind::Copy {
        source_settings.folders.remove(source_id);
      }
    }
    Ok((source_settings, target_settings))
  }

  /// The origin's exact before/after scopes own restoration, not whole workspace
  /// snapshots or old counters. Edited owned scopes conflict; other scopes survive.
  pub fn restore(
    &self,
    kind: WorkspaceContentOperationKind,
    mappings: &[WorkspaceContentIdMapping],
    counter_mappings: &[WorkspaceContentIdMapping],
    current_source: &WorkspaceContentOverviewState,
    current_target: &WorkspaceContentOverviewState,
  ) -> AuthResult<(WorkspaceOverviewSettings, WorkspaceOverviewSettings)> {
    let target = self.target.as_ref().ok_or_else(stale)?;
    if current_source.workspace_id != self.source.workspace_id || current_target.workspace_id != target.workspace_id {
      return Err(stale());
    }
    if !matches!(
      kind,
      WorkspaceContentOperationKind::Move | WorkspaceContentOperationKind::ExtractFolder
    ) {
      return Err(stale());
    }
    let (after_source, after_target) = self.project(kind, mappings)?;
    // Current settings of newly added descendant identities follow the native
    // counter-Move too; only original receipt-owned changes are restored below.
    let counter = Self {
      source: current_target.clone(),
      target: Some(current_source.clone()),
      extracted_folder_id: None,
    };
    let (mut target_settings, mut source_settings) =
      counter.project(WorkspaceContentOperationKind::Move, counter_mappings)?;
    for mapping in mappings
      .iter()
      .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Folder)
    {
      for (settings, current, before, after, id) in [
        (
          &mut source_settings,
          &current_source.settings,
          &self.source.settings,
          &after_source,
          mapping.source.resource_id(),
        ),
        (
          &mut target_settings,
          &current_target.settings,
          &target.settings,
          &after_target,
          mapping.target.resource_id(),
        ),
      ] {
        let mut value = settings.folders.get(id).cloned();
        restore_owned(
          &mut value,
          &current.folders.get(id).cloned(),
          &before.folders.get(id).cloned(),
          &after.folders.get(id).cloned(),
        )?;
        set_folder(settings, id, value);
      }
    }
    for (settings, current, before, after) in [
      (
        &mut source_settings,
        &current_source.settings,
        &self.source.settings,
        &after_source,
      ),
      (
        &mut target_settings,
        &current_target.settings,
        &target.settings,
        &after_target,
      ),
    ] {
      restore_owned(
        &mut settings.introduction,
        &current.introduction,
        &before.introduction,
        &after.introduction,
      )?;
      restore_owned(
        &mut settings.register_presentation,
        &current.register_presentation,
        &before.register_presentation,
        &after.register_presentation,
      )?;
      restore_owned(
        &mut settings.folder_ids,
        &current.folder_ids,
        &before.folder_ids,
        &after.folder_ids,
      )?;
    }
    Ok((source_settings, target_settings))
  }
}
