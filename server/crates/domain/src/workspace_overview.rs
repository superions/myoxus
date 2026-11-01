// SPDX-License-Identifier: AGPL-3.0-or-later

//! Presentation bindings for the existing workspace and Organizer folders.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::workspace_content_operation::{WorkspaceContentResourceKind, WorkspaceContentResourceRef};

pub const OVERVIEW_PROPERTY_KEYS: [&str; 11] = [
  "title",
  "documentType",
  "status",
  "classification",
  "version",
  "tags",
  "createdBy",
  "createdAt",
  "updatedAt",
  "reviewDueAt",
  "validUntil",
];

/// Configuration only: membership, ordering and ancestry remain Organizer data.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceOverviewSettings {
  pub introduction: Option<WorkspaceContentResourceRef>,
  /// `None` admits all root branches; `Some([])` hides root folder navigation.
  pub folder_ids: Option<Vec<String>>,
  pub register_presentation: Option<OverviewRegisterPresentation>,
  pub folders: BTreeMap<String, FolderOverviewSettings>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderOverviewSettings {
  pub introduction: Option<WorkspaceContentResourceRef>,
  /// Absence inherits the workspace's presentation.
  pub register_presentation: Option<OverviewRegisterPresentation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverviewRegisterPresentation {
  pub display_properties: Vec<String>,
  pub order_by: OverviewOrderBy,
}

impl Default for OverviewRegisterPresentation {
  fn default() -> Self {
    Self {
      display_properties: [
        "title",
        "documentType",
        "status",
        "version",
        "createdBy",
        "createdAt",
        "tags",
        "updatedAt",
      ]
      .into_iter()
      .map(|key| format!("system:{key}"))
      .collect(),
      order_by: OverviewOrderBy {
        property_type: "system".into(),
        key: "updatedAt".into(),
        desc: true,
      },
    }
  }
}

/// The existing Explorer `OrderByParams` wire shape, restricted to system keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverviewOrderBy {
  #[serde(rename = "type")]
  pub property_type: String,
  pub key: String,
  #[serde(default)]
  pub desc: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum OverviewSettingsScope {
  #[default]
  Workspace,
  Folder(String),
}

/// One scoped settings write. Outer `None` leaves a value untouched; inner
/// `None` explicitly clears it. Transports must preserve that distinction.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkspaceOverviewSettingsPatch {
  pub expected_revision: i64,
  pub scope: OverviewSettingsScope,
  pub introduction: Option<Option<WorkspaceContentResourceRef>>,
  pub folder_ids: Option<Option<Vec<String>>>,
  pub register_presentation: Option<Option<OverviewRegisterPresentation>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OverviewSettingsError {
  #[error("workspace overview settings changed")]
  RevisionConflict { current_revision: i64 },
  #[error("invalid workspace overview settings: {0}")]
  InvalidInput(&'static str),
}

impl WorkspaceOverviewSettingsPatch {
  /// Validate only this patch, so an unavailable old binding cannot block an
  /// unrelated scope's update. Source existence/access are checked by Application.
  pub fn validate(&self, workspace_id: Uuid) -> Result<(), OverviewSettingsError> {
    if self.expected_revision < 0 {
      return Err(OverviewSettingsError::InvalidInput("negative revision"));
    }
    if let OverviewSettingsScope::Folder(id) = &self.scope {
      validate_folder_id(workspace_id, id)?;
      if self.folder_ids.is_some() {
        return Err(OverviewSettingsError::InvalidInput(
          "folder selection belongs to the workspace",
        ));
      }
    }
    if let Some(Some(reference)) = &self.introduction {
      if reference.workspace_id() != workspace_id || reference.kind() != WorkspaceContentResourceKind::Document {
        return Err(OverviewSettingsError::InvalidInput(
          "introduction must be a local document",
        ));
      }
      WorkspaceContentResourceRef::new(workspace_id, reference.kind(), reference.resource_id())
        .map_err(|_| OverviewSettingsError::InvalidInput("invalid introduction identity"))?;
    }
    if let Some(Some(ids)) = &self.folder_ids {
      for id in ids {
        validate_folder_id(workspace_id, id)?;
      }
    }
    if let Some(Some(presentation)) = &self.register_presentation {
      let mut seen = BTreeSet::new();
      for key in &presentation.display_properties {
        if !key
          .strip_prefix("system:")
          .is_some_and(|key| OVERVIEW_PROPERTY_KEYS.contains(&key))
          || !seen.insert(key.as_str())
        {
          return Err(OverviewSettingsError::InvalidInput("unsupported or duplicate column"));
        }
      }
      if !seen.contains("system:title") {
        return Err(OverviewSettingsError::InvalidInput("title column is required"));
      }
      if presentation.order_by.property_type != "system"
        || !OVERVIEW_PROPERTY_KEYS.contains(&presentation.order_by.key.as_str())
      {
        return Err(OverviewSettingsError::InvalidInput("unsupported sort"));
      }
    }
    Ok(())
  }

  /// A deleted folder's obsolete configuration may still be cleared.
  pub fn clears_folder_scope(&self) -> bool {
    matches!(self.scope, OverviewSettingsScope::Folder(_))
      && self.introduction == Some(None)
      && self.register_presentation == Some(None)
      && self.folder_ids.is_none()
  }

  /// Apply while the caller holds its persistence write fence. The single
  /// workspace revision also protects writes to different folder scopes.
  pub fn apply(
    &self,
    workspace_id: Uuid,
    current: &WorkspaceOverviewSettings,
    current_revision: i64,
  ) -> Result<(WorkspaceOverviewSettings, i64), OverviewSettingsError> {
    self.validate(workspace_id)?;
    if self.expected_revision != current_revision {
      return Err(OverviewSettingsError::RevisionConflict { current_revision });
    }
    let revision = current_revision
      .checked_add(1)
      .ok_or(OverviewSettingsError::InvalidInput("revision exhausted"))?;
    let mut settings = current.clone();
    match &self.scope {
      OverviewSettingsScope::Workspace => {
        if let Some(value) = &self.introduction {
          settings.introduction = value.clone();
        }
        if let Some(value) = &self.folder_ids {
          settings.folder_ids = value.clone().map(|ids| {
            let mut seen = BTreeSet::new();
            ids.into_iter().filter(|id| seen.insert(id.clone())).collect()
          });
        }
        if let Some(value) = &self.register_presentation {
          settings.register_presentation = value.clone();
        }
      }
      OverviewSettingsScope::Folder(id) => {
        let folder = settings.folders.entry(id.clone()).or_default();
        if let Some(value) = &self.introduction {
          folder.introduction = value.clone();
        }
        if let Some(value) = &self.register_presentation {
          folder.register_presentation = value.clone();
        }
        if *folder == FolderOverviewSettings::default() {
          settings.folders.remove(id);
        }
      }
    }
    Ok((settings, revision))
  }
}

fn validate_folder_id(workspace_id: Uuid, id: &str) -> Result<(), OverviewSettingsError> {
  WorkspaceContentResourceRef::new(workspace_id, WorkspaceContentResourceKind::Folder, id)
    .map(|_| ())
    .map_err(|_| OverviewSettingsError::InvalidInput("invalid folder identity"))
}
