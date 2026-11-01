// SPDX-License-Identifier: AGPL-3.0-or-later
//! Effective workspace policy for document history and automatic capture.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use myoxus_domain::entities::{
  DocumentEditCaptureRuntimeStatus, WorkspaceDocumentVersioningSettings, WorkspaceEditCaptureSettingsPatch,
};
use myoxus_domain::repositories::{DocumentVersioningSettingsRepository, RepoResult, RepositoryError};
use uuid::Uuid;

pub const MIN_EDIT_CAPTURE_INTERVAL_MS: i64 = 15 * 60 * 1000;
pub const DEFAULT_EDIT_CAPTURE_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
pub const MAX_EDIT_CAPTURE_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalEditCaptureSettings {
  pub named_versioning_enabled: bool,
  pub auto_version_on: Vec<myoxus_domain::entities::AutoVersionTrigger>,
  pub retention_count: i32,
  pub enabled: bool,
  pub interval_ms: i64,
}

impl Default for GlobalEditCaptureSettings {
  fn default() -> Self {
    Self {
      named_versioning_enabled: true,
      auto_version_on: vec![myoxus_domain::entities::AutoVersionTrigger::OnPdfExport],
      retention_count: 10,
      enabled: true,
      interval_ms: DEFAULT_EDIT_CAPTURE_INTERVAL_MS,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceHistorySettingSource {
  Workspace,
  Server,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveWorkspaceHistorySettings {
  pub workspace_id: Uuid,
  pub edit_capture_enabled: Option<bool>,
  pub edit_capture_interval_ms: Option<i64>,
  pub named_versioning_enabled: Option<bool>,
  pub auto_version_on: Option<Vec<myoxus_domain::entities::AutoVersionTrigger>>,
  pub retention_count: Option<i32>,
  pub effective_named_versioning_enabled: bool,
  pub effective_auto_version_on: Vec<myoxus_domain::entities::AutoVersionTrigger>,
  pub effective_retention_count: i32,
  pub effective_edit_capture_enabled: bool,
  pub effective_edit_capture_interval_ms: i64,
  pub enabled_source: WorkspaceHistorySettingSource,
  pub interval_source: WorkspaceHistorySettingSource,
  pub legacy_interval_normalized: bool,
  pub runtime_available: bool,
  pub last_edit_capture_at: Option<DateTime<Utc>>,
  pub revision: String,
  pub updated_at: Option<DateTime<Utc>>,
}

pub struct WorkspaceHistorySettingsService {
  repository: Arc<dyn DocumentVersioningSettingsRepository>,
}

impl WorkspaceHistorySettingsService {
  pub fn new(repository: Arc<dyn DocumentVersioningSettingsRepository>) -> Self {
    Self { repository }
  }

  pub async fn get(
    &self,
    workspace_id: Uuid,
    global: GlobalEditCaptureSettings,
  ) -> RepoResult<Option<EffectiveWorkspaceHistorySettings>> {
    let runtime = self.repository.edit_capture_runtime_status(workspace_id).await?;
    let row = self.repository.get_workspace_override(workspace_id).await?;
    row
      .map(|row| resolve_effective_workspace_history_settings(row, global, runtime))
      .transpose()
  }

  pub async fn update(
    &self,
    workspace_id: Uuid,
    patch: WorkspaceEditCaptureSettingsPatch,
    expected_revision: &str,
    actor_id: Uuid,
    global: GlobalEditCaptureSettings,
  ) -> RepoResult<Option<EffectiveWorkspaceHistorySettings>> {
    if let Some(Some(interval_ms)) = patch.edit_capture_interval_ms
      && !(MIN_EDIT_CAPTURE_INTERVAL_MS..=MAX_EDIT_CAPTURE_INTERVAL_MS).contains(&interval_ms)
    {
      return Err(RepositoryError::Validation(format!(
        "edit capture interval must be between {MIN_EDIT_CAPTURE_INTERVAL_MS} and {MAX_EDIT_CAPTURE_INTERVAL_MS} milliseconds"
      )));
    }
    if let Some(Some(retention_count)) = patch.retention_count
      && !(1..=50).contains(&retention_count)
    {
      return Err(RepositoryError::Validation(
        "retention count must be between 1 and 50".to_string(),
      ));
    }
    let row = self
      .repository
      .patch_workspace_edit_capture(workspace_id, patch, expected_revision, actor_id)
      .await?;
    let runtime = self.repository.edit_capture_runtime_status(workspace_id).await?;
    row
      .map(|row| resolve_effective_workspace_history_settings(row, global, runtime))
      .transpose()
  }
}

pub fn normalize_legacy_edit_capture_interval(interval_ms: i64) -> RepoResult<(i64, bool)> {
  if interval_ms <= 0 || interval_ms > MAX_EDIT_CAPTURE_INTERVAL_MS {
    return Err(RepositoryError::Validation(format!(
      "edit capture interval must be positive and at most {MAX_EDIT_CAPTURE_INTERVAL_MS} milliseconds"
    )));
  }
  Ok((
    interval_ms.max(MIN_EDIT_CAPTURE_INTERVAL_MS),
    interval_ms < MIN_EDIT_CAPTURE_INTERVAL_MS,
  ))
}

pub fn resolve_effective_workspace_history_settings(
  row: WorkspaceDocumentVersioningSettings,
  global: GlobalEditCaptureSettings,
  runtime: DocumentEditCaptureRuntimeStatus,
) -> RepoResult<EffectiveWorkspaceHistorySettings> {
  let raw_interval = row.edit_capture_interval_ms.unwrap_or(global.interval_ms);
  let (effective_interval, legacy_interval_normalized) = normalize_legacy_edit_capture_interval(raw_interval)?;
  Ok(EffectiveWorkspaceHistorySettings {
    workspace_id: row.workspace_id,
    edit_capture_enabled: row.edit_capture_enabled,
    edit_capture_interval_ms: row.edit_capture_interval_ms,
    named_versioning_enabled: row.enabled,
    auto_version_on: row.auto_version_on.clone(),
    retention_count: row.retention_count,
    effective_named_versioning_enabled: row.enabled.unwrap_or(global.named_versioning_enabled),
    effective_auto_version_on: row
      .auto_version_on
      .clone()
      .unwrap_or_else(|| global.auto_version_on.clone()),
    effective_retention_count: row.retention_count.unwrap_or(global.retention_count),
    effective_edit_capture_enabled: row.edit_capture_enabled.unwrap_or(global.enabled),
    effective_edit_capture_interval_ms: effective_interval,
    enabled_source: if row.edit_capture_enabled.is_some() {
      WorkspaceHistorySettingSource::Workspace
    } else {
      WorkspaceHistorySettingSource::Server
    },
    interval_source: if row.edit_capture_interval_ms.is_some() {
      WorkspaceHistorySettingSource::Workspace
    } else {
      WorkspaceHistorySettingSource::Server
    },
    legacy_interval_normalized,
    runtime_available: runtime.available,
    last_edit_capture_at: runtime.last_success_at,
    revision: row.edit_capture_revision(),
    updated_at: row.updated_at,
  })
}
