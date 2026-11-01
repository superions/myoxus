// SPDX-License-Identifier: AGPL-3.0-or-later
//! Workspace-scoped GraphQL surface for document versioning.
//!
//! History and PDF consumers share snapshot/version identity, read projections
//! and explicit commands, without bypassing document permissions.

use std::sync::Arc;

use async_graphql::{Context, Enum, ID, InputObject, MaybeUndefined, Object, Result, SimpleObject};
use chrono::{DateTime, Utc};
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use myoxus_application::auth::AuthError;
use myoxus_application::doc::DocSpaceKind;
use myoxus_application::document_version::{
  DocumentHistoryNameRequest, DocumentHistorySaveRequest, DocumentVersionCreateError, DocumentVersionCreateRequest,
  DocumentVersionCreateService, DocumentVersionHistoryPort, DocumentVersionRestoreService,
  EffectiveWorkspaceHistorySettings, GlobalEditCaptureSettings, WorkspaceHistorySettingSource,
  WorkspaceHistorySettingsService,
};
use myoxus_application::permission::AccessController;
use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::entities::{
  AutoVersionTrigger, DocumentVersion, DocumentVersionPolicy, DocumentVersioningSettings,
  WorkspaceEditCaptureSettingsPatch, WorkspaceRole,
};
use myoxus_domain::repositories::RepositoryError;

use crate::state::ApiState;

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum AutoVersionTriggerType {
  #[graphql(name = "on_publish")]
  OnPublish,
  #[graphql(name = "on_pdf_export")]
  OnPdfExport,
  #[graphql(name = "daily")]
  Daily,
}

impl From<AutoVersionTrigger> for AutoVersionTriggerType {
  fn from(value: AutoVersionTrigger) -> Self {
    match value {
      AutoVersionTrigger::OnPublish => Self::OnPublish,
      AutoVersionTrigger::OnPdfExport => Self::OnPdfExport,
      AutoVersionTrigger::Daily => Self::Daily,
    }
  }
}

impl From<AutoVersionTriggerType> for AutoVersionTrigger {
  fn from(value: AutoVersionTriggerType) -> Self {
    match value {
      AutoVersionTriggerType::OnPublish => Self::OnPublish,
      AutoVersionTriggerType::OnPdfExport => Self::OnPdfExport,
      AutoVersionTriggerType::Daily => Self::Daily,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentVersionType {
  pub id: ID,
  pub doc_id: ID,
  pub workspace_id: ID,
  pub doc_history_id: ID,
  pub version_no: Option<i64>,
  pub label: String,
  pub description: Option<String>,
  pub event: String,
  pub kind: String,
  pub created_by: ID,
  pub created_at: DateTime<Utc>,
  pub is_pinned: bool,
  pub is_protected: bool,
  pub policy_id: Option<ID>,
  pub policy_snapshot: serde_json::Value,
  pub content_hash: Option<String>,
  pub metadata: serde_json::Value,
  pub updated_by: Option<ID>,
  pub updated_at: Option<DateTime<Utc>>,
}

impl From<DocumentVersion> for DocumentVersionType {
  fn from(value: DocumentVersion) -> Self {
    Self {
      id: ID(value.id.to_string()),
      doc_id: ID(value.doc_id.to_string()),
      workspace_id: ID(value.workspace_id.to_string()),
      doc_history_id: ID(value.doc_history_id.to_string()),
      version_no: value.version_no,
      label: value.label,
      description: value.description,
      event: value.event.as_str().to_string(),
      kind: value.kind.as_str().to_string(),
      created_by: ID(value.created_by.to_string()),
      created_at: value.created_at,
      is_pinned: value.is_pinned,
      is_protected: value.is_protected,
      policy_id: value.policy_id.map(|id| ID(id.to_string())),
      policy_snapshot: value.policy_snapshot,
      content_hash: value.content_hash,
      metadata: value.metadata,
      updated_by: value.updated_by.map(|id| ID(id.to_string())),
      updated_at: value.updated_at,
    }
  }
}

#[derive(SimpleObject)]
pub struct DocumentHistoryCaptureType {
  pub history_id: ID,
  pub version: Option<DocumentVersionType>,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentVersionPolicyType {
  pub id: ID,
  pub scope: String,
  pub workspace_id: Option<ID>,
  pub name: String,
  pub is_default: bool,
  pub enabled_by_default: bool,
  pub scheme_preset: String,
  pub custom_pattern: Option<String>,
  pub timezone_mode: String,
  pub auto_version_on: Vec<AutoVersionTriggerType>,
  pub retention_count: i32,
  pub pin_manual_versions: bool,
  pub pin_publish_versions: bool,
  pub published_versions_protected: bool,
  pub export_versions_protected: bool,
  pub metadata_schema: serde_json::Value,
  pub created_by: Option<ID>,
  pub created_at: DateTime<Utc>,
  pub updated_by: Option<ID>,
  pub updated_at: DateTime<Utc>,
}

impl From<DocumentVersionPolicy> for DocumentVersionPolicyType {
  fn from(value: DocumentVersionPolicy) -> Self {
    Self {
      id: ID(value.id.to_string()),
      scope: value.scope,
      workspace_id: value.workspace_id.map(|id| ID(id.to_string())),
      name: value.name,
      is_default: value.is_default,
      enabled_by_default: value.enabled_by_default,
      scheme_preset: value.scheme_preset,
      custom_pattern: value.custom_pattern,
      timezone_mode: value.timezone_mode,
      auto_version_on: value.auto_version_on.into_iter().map(Into::into).collect(),
      retention_count: value.retention_count,
      pin_manual_versions: value.pin_manual_versions,
      pin_publish_versions: value.pin_publish_versions,
      published_versions_protected: value.published_versions_protected,
      export_versions_protected: value.export_versions_protected,
      metadata_schema: value.metadata_schema,
      created_by: value.created_by.map(|id| ID(id.to_string())),
      created_at: value.created_at,
      updated_by: value.updated_by.map(|id| ID(id.to_string())),
      updated_at: value.updated_at,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentVersioningSettingsType {
  pub doc_id: ID,
  pub enabled: bool,
  pub retention_count: i32,
  pub auto_version_on: Vec<AutoVersionTriggerType>,
}

impl From<DocumentVersioningSettings> for DocumentVersioningSettingsType {
  fn from(value: DocumentVersioningSettings) -> Self {
    Self {
      doc_id: ID(value.doc_id.to_string()),
      enabled: value.enabled,
      retention_count: value.retention_count,
      auto_version_on: value.auto_version_on.into_iter().map(Into::into).collect(),
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum WorkspaceHistorySettingSourceType {
  #[graphql(name = "workspace")]
  Workspace,
  #[graphql(name = "server")]
  Server,
}

impl From<WorkspaceHistorySettingSource> for WorkspaceHistorySettingSourceType {
  fn from(value: WorkspaceHistorySettingSource) -> Self {
    match value {
      WorkspaceHistorySettingSource::Workspace => Self::Workspace,
      WorkspaceHistorySettingSource::Server => Self::Server,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct WorkspaceHistorySettingsType {
  pub workspace_id: ID,
  pub named_versioning_enabled: Option<bool>,
  pub auto_version_on: Option<Vec<AutoVersionTriggerType>>,
  pub retention_count: Option<i32>,
  pub edit_capture_enabled: Option<bool>,
  pub edit_capture_interval_ms: Option<i64>,
  pub effective_named_versioning_enabled: bool,
  pub effective_auto_version_on: Vec<AutoVersionTriggerType>,
  pub effective_retention_count: i32,
  pub effective_edit_capture_enabled: bool,
  pub effective_edit_capture_interval_ms: i64,
  pub enabled_source: WorkspaceHistorySettingSourceType,
  pub interval_source: WorkspaceHistorySettingSourceType,
  pub legacy_interval_normalized: bool,
  pub runtime_available: bool,
  pub last_edit_capture_at: Option<DateTime<Utc>>,
  pub revision: String,
  pub updated_at: Option<DateTime<Utc>>,
}

impl From<EffectiveWorkspaceHistorySettings> for WorkspaceHistorySettingsType {
  fn from(value: EffectiveWorkspaceHistorySettings) -> Self {
    Self {
      workspace_id: ID(value.workspace_id.to_string()),
      named_versioning_enabled: value.named_versioning_enabled,
      auto_version_on: value
        .auto_version_on
        .map(|values| values.into_iter().map(Into::into).collect()),
      retention_count: value.retention_count,
      edit_capture_enabled: value.edit_capture_enabled,
      edit_capture_interval_ms: value.edit_capture_interval_ms,
      effective_named_versioning_enabled: value.effective_named_versioning_enabled,
      effective_auto_version_on: value.effective_auto_version_on.into_iter().map(Into::into).collect(),
      effective_retention_count: value.effective_retention_count,
      effective_edit_capture_enabled: value.effective_edit_capture_enabled,
      effective_edit_capture_interval_ms: value.effective_edit_capture_interval_ms,
      enabled_source: value.enabled_source.into(),
      interval_source: value.interval_source.into(),
      legacy_interval_normalized: value.legacy_interval_normalized,
      runtime_available: value.runtime_available,
      last_edit_capture_at: value.last_edit_capture_at,
      revision: value.revision,
      updated_at: value.updated_at,
    }
  }
}

#[derive(InputObject, Clone, Debug)]
pub struct UpdateWorkspaceHistorySettingsInput {
  pub named_versioning_enabled: MaybeUndefined<bool>,
  pub auto_version_on: MaybeUndefined<Vec<AutoVersionTriggerType>>,
  pub retention_count: MaybeUndefined<i32>,
  pub edit_capture_enabled: MaybeUndefined<bool>,
  pub edit_capture_interval_ms: MaybeUndefined<i64>,
  pub expected_revision: String,
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum DocumentVersionBlockDiffKindType {
  #[graphql(name = "added")]
  Added,
  #[graphql(name = "removed")]
  Removed,
  #[graphql(name = "modified")]
  Modified,
}

impl From<myoxus_application::document_version::DocumentVersionBlockDiffKind> for DocumentVersionBlockDiffKindType {
  fn from(value: myoxus_application::document_version::DocumentVersionBlockDiffKind) -> Self {
    match value {
      myoxus_application::document_version::DocumentVersionBlockDiffKind::Added => Self::Added,
      myoxus_application::document_version::DocumentVersionBlockDiffKind::Removed => Self::Removed,
      myoxus_application::document_version::DocumentVersionBlockDiffKind::Modified => Self::Modified,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentVersionStateVectorDiffType {
  pub from_state_vector_sha256: String,
  pub to_state_vector_sha256: String,
  pub changed: bool,
}

impl From<myoxus_application::document_version::DocumentVersionStateVectorDiff> for DocumentVersionStateVectorDiffType {
  fn from(value: myoxus_application::document_version::DocumentVersionStateVectorDiff) -> Self {
    Self {
      from_state_vector_sha256: value.from_state_vector_sha256,
      to_state_vector_sha256: value.to_state_vector_sha256,
      changed: value.changed,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentVersionBlockDiffType {
  pub block_id: String,
  pub kind: DocumentVersionBlockDiffKindType,
  pub from_flavour: Option<String>,
  pub to_flavour: Option<String>,
  pub from_text: Option<String>,
  pub to_text: Option<String>,
  pub from_children: Vec<String>,
  pub to_children: Vec<String>,
}

impl From<myoxus_application::document_version::DocumentVersionBlockDiff> for DocumentVersionBlockDiffType {
  fn from(value: myoxus_application::document_version::DocumentVersionBlockDiff) -> Self {
    Self {
      block_id: value.block_id,
      kind: value.kind.into(),
      from_flavour: value.from_flavour,
      to_flavour: value.to_flavour,
      from_text: value.from_text,
      to_text: value.to_text,
      from_children: value.from_children,
      to_children: value.to_children,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(rename_items = "snake_case")]
pub enum DocumentTextRunKindType {
  Unchanged,
  Added,
  Removed,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentTextRunType {
  pub kind: DocumentTextRunKindType,
  pub text: String,
}
impl From<myoxus_application::document_version::diff::DocumentTextRun> for DocumentTextRunType {
  fn from(value: myoxus_application::document_version::diff::DocumentTextRun) -> Self {
    use myoxus_application::document_version::diff::DocumentTextRunKind;
    Self {
      kind: match value.kind {
        DocumentTextRunKind::Unchanged => DocumentTextRunKindType::Unchanged,
        DocumentTextRunKind::Added => DocumentTextRunKindType::Added,
        DocumentTextRunKind::Removed => DocumentTextRunKindType::Removed,
      },
      text: value.text,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(rename_items = "snake_case")]
pub enum DocumentComparisonBlockKindType {
  Unchanged,
  Added,
  Removed,
  Modified,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentComparisonBlockType {
  pub block_id: String,
  pub kind: DocumentComparisonBlockKindType,
  pub flavour: String,
  pub runs: Vec<DocumentTextRunType>,
  /// False for a deletion without an unambiguous native parent/sibling anchor.
  pub placement_known: bool,
}
impl From<myoxus_application::document_version::diff::DocumentComparisonBlock> for DocumentComparisonBlockType {
  fn from(value: myoxus_application::document_version::diff::DocumentComparisonBlock) -> Self {
    use myoxus_application::document_version::diff::DocumentComparisonBlockKind;
    Self {
      block_id: value.block_id,
      kind: match value.kind {
        DocumentComparisonBlockKind::Unchanged => DocumentComparisonBlockKindType::Unchanged,
        DocumentComparisonBlockKind::Added => DocumentComparisonBlockKindType::Added,
        DocumentComparisonBlockKind::Removed => DocumentComparisonBlockKindType::Removed,
        DocumentComparisonBlockKind::Modified => DocumentComparisonBlockKindType::Modified,
      },
      flavour: value.flavour,
      runs: value.runs.into_iter().map(Into::into).collect(),
      placement_known: value.placement_known,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(rename_items = "snake_case")]
pub enum DocumentComparisonNoticeKindType {
  PresentationNotCompared,
  UnsupportedContent,
  PartialExtraction,
  IncompleteStructure,
  StructureChanged,
  AmbiguousRemovalAnchor,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentComparisonNoticeType {
  pub kind: DocumentComparisonNoticeKindType,
  pub block_id: Option<String>,
}
impl From<myoxus_application::document_version::diff::DocumentComparisonNotice> for DocumentComparisonNoticeType {
  fn from(value: myoxus_application::document_version::diff::DocumentComparisonNotice) -> Self {
    use myoxus_application::document_version::diff::DocumentComparisonNoticeKind;
    Self {
      block_id: value.block_id,
      kind: match value.kind {
        DocumentComparisonNoticeKind::PresentationNotCompared => {
          DocumentComparisonNoticeKindType::PresentationNotCompared
        }
        DocumentComparisonNoticeKind::UnsupportedContent => DocumentComparisonNoticeKindType::UnsupportedContent,
        DocumentComparisonNoticeKind::PartialExtraction => DocumentComparisonNoticeKindType::PartialExtraction,
        DocumentComparisonNoticeKind::IncompleteStructure => DocumentComparisonNoticeKindType::IncompleteStructure,
        DocumentComparisonNoticeKind::StructureChanged => DocumentComparisonNoticeKindType::StructureChanged,
        DocumentComparisonNoticeKind::AmbiguousRemovalAnchor => {
          DocumentComparisonNoticeKindType::AmbiguousRemovalAnchor
        }
      },
    }
  }
}

/// A fixed selected-history/current-persisted reading projection; no capture.
#[derive(SimpleObject, Clone)]
pub struct DocumentHistoryDiffType {
  pub snapshot_id: ID,
  pub current_revision: ID,
  /// Time the consistent server read opened, not the document modification time.
  pub read_at: DateTime<Utc>,
  pub comparison_blocks: Vec<DocumentComparisonBlockType>,
  pub notices: Vec<DocumentComparisonNoticeType>,
  pub extraction_partial: bool,
}
impl From<myoxus_application::doc::history::DocHistoryComparison> for DocumentHistoryDiffType {
  fn from(value: myoxus_application::doc::history::DocHistoryComparison) -> Self {
    Self {
      snapshot_id: ID(value.history_id.to_string()),
      current_revision: ID(value.current_revision.to_string()),
      read_at: value.read_at,
      comparison_blocks: value.diff.comparison_blocks.into_iter().map(Into::into).collect(),
      notices: value.diff.notices.into_iter().map(Into::into).collect(),
      extraction_partial: value.diff.extraction_partial,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentVersionTextDiffType {
  pub block_id: String,
  pub from_text: String,
  pub to_text: String,
  pub removed_lines: Vec<String>,
  pub added_lines: Vec<String>,
  pub removed_words: Vec<String>,
  pub added_words: Vec<String>,
  pub runs: Vec<DocumentTextRunType>,
}

impl From<myoxus_application::document_version::DocumentVersionTextDiff> for DocumentVersionTextDiffType {
  fn from(value: myoxus_application::document_version::DocumentVersionTextDiff) -> Self {
    Self {
      block_id: value.block_id,
      from_text: value.from_text,
      to_text: value.to_text,
      removed_lines: value.removed_lines,
      added_lines: value.added_lines,
      removed_words: value.removed_words,
      added_words: value.added_words,
      runs: value.runs.into_iter().map(Into::into).collect(),
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentVersionDiffType {
  pub state_vector: DocumentVersionStateVectorDiffType,
  pub block_diffs: Vec<DocumentVersionBlockDiffType>,
  pub text_diffs: Vec<DocumentVersionTextDiffType>,
  pub from_block_count: i32,
  pub to_block_count: i32,
  pub extraction_partial: bool,
  pub comparison_blocks: Vec<DocumentComparisonBlockType>,
  pub notices: Vec<DocumentComparisonNoticeType>,
}

impl From<myoxus_application::document_version::DocumentVersionDiff> for DocumentVersionDiffType {
  fn from(value: myoxus_application::document_version::DocumentVersionDiff) -> Self {
    Self {
      state_vector: value.state_vector.into(),
      block_diffs: value.block_diffs.into_iter().map(Into::into).collect(),
      text_diffs: value.text_diffs.into_iter().map(Into::into).collect(),
      from_block_count: value.from_block_count,
      to_block_count: value.to_block_count,
      extraction_partial: value.extraction_partial,
      comparison_blocks: value.comparison_blocks.into_iter().map(Into::into).collect(),
      notices: value.notices.into_iter().map(Into::into).collect(),
    }
  }
}

fn require_version_repo(state: &ApiState) -> Result<Arc<dyn myoxus_domain::repositories::DocumentVersionRepository>> {
  state
    .document_version_repo()
    .ok_or_else(|| async_graphql::Error::new("document version repository is not configured on this server"))
}

fn require_settings_repo(
  state: &ApiState,
) -> Result<Arc<dyn myoxus_domain::repositories::DocumentVersioningSettingsRepository>> {
  state
    .document_version_settings_repo()
    .ok_or_else(|| async_graphql::Error::new("document version settings repository is not configured on this server"))
}

async fn global_workspace_history_settings(state: &ApiState) -> GlobalEditCaptureSettings {
  let effective = state.effective_config().await;
  let mut auto_version_on = Vec::new();
  if effective
    .bool("document_versioning.default_auto_version_on_pdf_export")
    .unwrap_or(true)
  {
    auto_version_on.push(AutoVersionTrigger::OnPdfExport);
  }
  GlobalEditCaptureSettings {
    named_versioning_enabled: effective.bool("document_versioning.default_enabled").unwrap_or(true),
    auto_version_on,
    retention_count: effective
      .value("document_versioning.default_retention_count")
      .and_then(|value| value.as_i64())
      .and_then(|value| i32::try_from(value).ok())
      .filter(|value| (1..=50).contains(value))
      .unwrap_or(10),
    enabled: effective.bool("doc.history.enabled").unwrap_or(true),
    interval_ms: effective
      .value("doc.history.interval")
      .and_then(|value| value.as_i64())
      .unwrap_or(myoxus_application::document_version::DEFAULT_EDIT_CAPTURE_INTERVAL_MS),
  }
}

async fn require_workspace_action(
  ctx: &Context<'_>,
  workspace_id: Uuid,
  action: myoxus_domain::permission::WorkspaceAction,
) -> Result<(Arc<ApiState>, Uuid)> {
  let state = ctx
    .data::<Arc<ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
  state
    .permission_service()
    .assert(
      &myoxus_application::permission::WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id,
      },
      action,
    )
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  Ok((state.clone(), snapshot.user.id))
}

fn maybe_patch<T>(value: MaybeUndefined<T>) -> Option<Option<T>> {
  match value {
    MaybeUndefined::Undefined => None,
    MaybeUndefined::Null => Some(None),
    MaybeUndefined::Value(value) => Some(Some(value)),
  }
}

fn validation_error(message: impl Into<String>, field: &'static str) -> async_graphql::Error {
  let mut err = async_graphql::Error::new(message.into());
  err.extensions = Some({
    let mut ext = async_graphql::ErrorExtensionValues::default();
    ext.set("class", "ValidationError");
    ext.set("field", field);
    ext
  });
  err
}

fn repo_error(error: RepositoryError) -> async_graphql::Error {
  let class = match error {
    RepositoryError::Conflict(_) => "Conflict",
    RepositoryError::NotFound(_) => "NotFound",
    RepositoryError::Validation(_) => "ValidationError",
    RepositoryError::Storage(_) => "StorageError",
  };
  let mut err = async_graphql::Error::new(error.to_string());
  err.extensions = Some({
    let mut ext = async_graphql::ErrorExtensionValues::default();
    ext.set("class", class);
    ext
  });
  err
}

fn create_error(error: DocumentVersionCreateError) -> async_graphql::Error {
  match error {
    DocumentVersionCreateError::Label(error) => validation_error(error.to_string(), "label"),
    DocumentVersionCreateError::InvalidInput(message) => validation_error(message, "input"),
    DocumentVersionCreateError::History(error) => match error {
      myoxus_application::doc::history::HistoryCaptureError::Repository(error) => repo_error(error),
      myoxus_application::doc::history::HistoryCaptureError::Label(error) => {
        validation_error(error.to_string(), "label")
      }
      myoxus_application::doc::history::HistoryCaptureError::Document(error) => {
        async_graphql::Error::new(error.to_string())
      }
      myoxus_application::doc::history::HistoryCaptureError::StaleEntry => {
        repo_error(RepositoryError::NotFound("document history"))
      }
      myoxus_application::doc::history::HistoryCaptureError::IdempotencyConflict => {
        repo_error(RepositoryError::Conflict("history capture request key already used"))
      }
      myoxus_application::doc::history::HistoryCaptureError::ReferenceConflict => {
        repo_error(RepositoryError::Conflict("document history references changed"))
      }
    },
  }
}

fn document_version_history_port(state: &ApiState) -> Result<Arc<dyn DocumentVersionHistoryPort>> {
  Ok(Arc::new(state.doc().clone()))
}

fn sanitize_label(label: String) -> Result<String> {
  let trimmed = label.trim();
  if trimmed.is_empty() {
    return Err(validation_error("document version label must not be empty", "label"));
  }
  if trimmed.len() > 160 {
    return Err(validation_error(
      "document version label must be at most 160 bytes",
      "label",
    ));
  }
  Ok(trimmed.to_string())
}

pub(super) fn parse_history_revision(value: Option<String>) -> Result<Option<i64>> {
  value
    .map(|value| {
      value
        .parse::<i64>()
        .ok()
        .filter(|v| *v >= 0)
        .ok_or_else(|| validation_error("invalid document history revision", "expectedRevision"))
    })
    .transpose()
}

fn sanitize_description(description: Option<String>) -> Option<String> {
  description.and_then(|value| {
    let trimmed = value.trim();
    if trimmed.is_empty() {
      None
    } else {
      Some(trimmed.chars().take(2048).collect::<String>())
    }
  })
}

fn version_audit_value(version: &DocumentVersion) -> serde_json::Value {
  serde_json::json!({
    "id": version.id.to_string(),
    "docId": version.doc_id.to_string(),
    "workspaceId": version.workspace_id.to_string(),
    "docHistoryId": version.doc_history_id,
    "label": version.label,
    "description": version.description,
    "createdBy": version.created_by.to_string(),
    "createdAt": version.created_at.to_rfc3339(),
    "isPinned": version.is_pinned,
  })
}

fn settings_audit_value(settings: &DocumentVersioningSettings, workspace_id: Uuid) -> serde_json::Value {
  serde_json::json!({
    "docId": settings.doc_id.to_string(),
    "workspaceId": workspace_id.to_string(),
    "enabled": settings.enabled,
    "retentionCount": settings.retention_count,
    "autoVersionOn": settings.auto_version_on.iter().map(AutoVersionTrigger::as_str).collect::<Vec<_>>(),
  })
}

async fn record_document_version_audit(
  ctx: &Context<'_>,
  state: &Arc<ApiState>,
  event_key: &'static str,
  target: AuditTarget,
  old_value: Option<serde_json::Value>,
  new_value: Option<serde_json::Value>,
) {
  let actor = crate::graphql::admin::resolve_audit_actor(ctx).await;
  state
    .audit_recorder()
    .record(AuditEvent::mutation(
      event_key,
      AuditCategory::DocumentVersion,
      Some(target),
      actor,
      old_value,
      new_value,
    ))
    .await;
}

async fn authorize_document_for_user(
  state: &ApiState,
  user_id: Uuid,
  doc_id: Uuid,
  action: myoxus_domain::permission::DocAction,
) -> Result<Uuid> {
  let metadata = state
    .doc()
    .get_metadata(doc_id)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?
    .ok_or_else(|| async_graphql::Error::new("document not found"))?;
  let workspace_id = metadata
    .workspace_id
    .ok_or_else(|| async_graphql::Error::new("document not found"))?;
  let external_key = DocumentKey::parse(metadata.external_id)
    .map_err(|error| async_graphql::Error::new(format!("invalid document key: {error}")))?;
  crate::document_access::authorize_workspace_document(
    state,
    user_id,
    workspace_id,
    DocSpaceKind::Workspace,
    &external_key,
    action,
  )
  .await
  .map_err(crate::graphql::utils::map_gql_error)?;
  Ok(workspace_id)
}

async fn require_doc_read(ctx: &Context<'_>, doc_id: Uuid) -> Result<(Arc<ApiState>, Uuid, Uuid)> {
  let state = ctx
    .data::<Arc<ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
  let workspace_id = authorize_document_for_user(
    state,
    snapshot.user.id,
    doc_id,
    myoxus_domain::permission::DocAction::Read,
  )
  .await?;

  Ok((state.clone(), snapshot.user.id, workspace_id))
}

async fn require_doc_action(
  ctx: &Context<'_>,
  doc_id: Uuid,
  action: myoxus_domain::permission::DocAction,
) -> Result<(Arc<ApiState>, Uuid, Uuid)> {
  let state = ctx
    .data::<Arc<ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
  let workspace_id = authorize_document_for_user(state, snapshot.user.id, doc_id, action).await?;

  Ok((state.clone(), snapshot.user.id, workspace_id))
}

async fn require_version_action(
  ctx: &Context<'_>,
  version_id: Uuid,
  action: myoxus_domain::permission::DocAction,
) -> Result<(Arc<ApiState>, Uuid, DocumentVersion)> {
  let state = ctx
    .data::<Arc<ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
  let repo = require_version_repo(state)?;
  let version = repo
    .get(version_id)
    .await
    .map_err(repo_error)?
    .ok_or_else(|| async_graphql::Error::new("document version not found"))?;

  authorize_document_for_user(state, snapshot.user.id, version.doc_id, action).await?;

  Ok((state.clone(), snapshot.user.id, version))
}

async fn require_version_metadata_update(
  ctx: &Context<'_>,
  version_id: Uuid,
) -> Result<(Arc<ApiState>, Uuid, DocumentVersion)> {
  let state = ctx
    .data::<Arc<ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
  let repo = require_version_repo(state)?;
  let version = repo
    .get(version_id)
    .await
    .map_err(repo_error)?
    .ok_or_else(|| async_graphql::Error::new("document version not found"))?;

  authorize_document_for_user(
    state,
    snapshot.user.id,
    version.doc_id,
    myoxus_domain::permission::DocAction::Read,
  )
  .await?;

  let workspace_role = state
    .permission_service()
    .get_effective_workspace_role(snapshot.user.id, version.workspace_id)
    .await
    .ok()
    .flatten();
  let is_workspace_admin = matches!(workspace_role, Some(WorkspaceRole::Admin | WorkspaceRole::Owner));
  if version.created_by != snapshot.user.id && !is_workspace_admin {
    return Err(crate::graphql::utils::map_gql_error(AuthError::ActionForbidden));
  }

  Ok((state.clone(), snapshot.user.id, version))
}

pub struct DocumentVersionQueryRoot;

#[Object]
impl DocumentVersionQueryRoot {
  /// Decimal string avoids JavaScript integer rounding of an append sequence.
  pub async fn document_history_revision(&self, ctx: &Context<'_>, workspace_id: ID, doc_id: ID) -> Result<String> {
    let state = ctx.data::<Arc<ApiState>>()?;
    let workspace_id =
      Uuid::parse_str(workspace_id.as_str()).map_err(|_| validation_error("invalid workspace id", "workspaceId"))?;
    let doc_id = crate::graphql::utils::resolve_doc_id(state, workspace_id, doc_id.as_str()).await?;
    require_doc_action(ctx, doc_id, myoxus_domain::permission::DocAction::Read).await?;
    state
      .doc()
      .history
      .revision(workspace_id, doc_id)
      .await
      .map(|value| value.to_string())
      .map_err(crate::graphql::utils::map_gql_error)
  }
  /// List versioning policies that a workspace can select.
  ///
  /// The admin root exposes the full policy inventory for governance. This
  /// workspace-scoped query intentionally returns only global policies and
  /// policies bound to the requested workspace, after checking workspace read
  /// permission. Workspace settings can therefore render labels instead of
  /// treating `versionPolicyId` as an opaque UUID without depending on admin
  /// APIs.
  #[instrument(skip(self, ctx), level = "debug")]
  pub async fn document_version_policies(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Vec<DocumentVersionPolicyType>> {
    let workspace_uuid =
      Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let state = ctx
      .data::<Arc<ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        myoxus_domain::permission::WorkspaceAction::Read,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;

    let repo = require_version_repo(state)?;
    let policies = repo
      .list_policies()
      .await
      .map_err(repo_error)?
      .into_iter()
      .filter(|policy| policy.scope == "global" || policy.workspace_id == Some(workspace_uuid))
      .collect::<Vec<_>>();
    debug!(
      workspace_id = %workspace_uuid,
      user_id = %snapshot.user.id,
      count = policies.len(),
      "document version policies listed for workspace"
    );
    Ok(policies.into_iter().map(Into::into).collect())
  }

  /// List named versions for a document. The caller must have workspace Read
  /// permission on the document's workspace; rows from other workspaces never
  /// leak through this resolver.
  #[instrument(skip(self, ctx), level = "debug")]
  pub async fn document_versions(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
  ) -> Result<Vec<DocumentVersionType>> {
    let workspace_uuid =
      Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let state = ctx
      .data::<Arc<ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(state, workspace_uuid, doc_id.as_str()).await?;
    let (state, user_id, workspace_id) = require_doc_read(ctx, doc_uuid).await?;
    let repo = require_version_repo(&state)?;
    let versions = repo
      .list_for_doc(doc_uuid)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;

    debug!(
      doc_id = %doc_uuid,
      workspace_id = %workspace_id,
      user_id = %user_id,
      count = versions.len(),
      "document versions listed"
    );
    Ok(versions.into_iter().map(Into::into).collect())
  }

  /// Fetch one named version by id. Authorization is checked against the
  /// version's workspace before the row is returned.
  #[instrument(skip(self, ctx), level = "debug")]
  pub async fn document_version(&self, ctx: &Context<'_>, id: ID) -> Result<Option<DocumentVersionType>> {
    let version_uuid = Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new("invalid version id"))?;
    let state = ctx
      .data::<Arc<ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
    let repo = require_version_repo(state)?;
    let Some(version) = repo
      .get(version_uuid)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?
    else {
      return Ok(None);
    };

    authorize_document_for_user(
      state,
      snapshot.user.id,
      version.doc_id,
      myoxus_domain::permission::DocAction::Read,
    )
    .await?;

    debug!(
      version_id = %version_uuid,
      doc_id = %version.doc_id,
      workspace_id = %version.workspace_id,
      user_id = %snapshot.user.id,
      "document version fetched"
    );
    Ok(Some(version.into()))
  }

  /// Return per-document versioning settings. Missing rows are represented by
  /// repository defaults (`enabled=false`, `retentionCount=10`,
  /// `autoVersionOn=[]`) without writing to the database.
  #[instrument(skip(self, ctx), level = "debug")]
  pub async fn document_versioning_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
  ) -> Result<DocumentVersioningSettingsType> {
    let workspace_uuid =
      Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let state = ctx
      .data::<Arc<ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(state, workspace_uuid, doc_id.as_str()).await?;
    let (state, user_id, workspace_id) = require_doc_read(ctx, doc_uuid).await?;
    let repo = require_settings_repo(&state)?;
    let settings = repo
      .get(doc_uuid)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;

    debug!(
      doc_id = %doc_uuid,
      workspace_id = %workspace_id,
      user_id = %user_id,
      enabled = settings.enabled,
      triggers = ?settings.auto_version_on,
      "document versioning settings fetched"
    );
    Ok(settings.into())
  }

  /// Return the effective workspace history policy. Reads never materialize a
  /// settings row and require ordinary workspace Read permission.
  #[instrument(skip(self, ctx), level = "debug")]
  pub async fn workspace_history_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<WorkspaceHistorySettingsType> {
    let workspace_id =
      Uuid::parse_str(workspace_id.as_str()).map_err(|_| validation_error("invalid workspace id", "workspaceId"))?;
    let (state, user_id) =
      require_workspace_action(ctx, workspace_id, myoxus_domain::permission::WorkspaceAction::Read).await?;
    let service = WorkspaceHistorySettingsService::new(require_settings_repo(&state)?);
    let settings = service
      .get(workspace_id, global_workspace_history_settings(&state).await)
      .await
      .map_err(repo_error)?
      .ok_or_else(|| async_graphql::Error::new("workspace not found"))?;
    debug!(%workspace_id, %user_id, "workspace history settings loaded");
    Ok(settings.into())
  }

  /// Compute a read-only diff between two named versions of the same document.
  /// Both ids must point to the same workspace/document; the caller needs
  /// document Read permission before any snapshot content is returned.
  #[instrument(skip(self, ctx), level = "debug")]
  pub async fn document_version_diff(
    &self,
    ctx: &Context<'_>,
    from_id: ID,
    to_id: ID,
  ) -> Result<DocumentVersionDiffType> {
    let from_uuid =
      Uuid::parse_str(from_id.as_str()).map_err(|_| async_graphql::Error::new("invalid from version id"))?;
    let to_uuid = Uuid::parse_str(to_id.as_str()).map_err(|_| async_graphql::Error::new("invalid to version id"))?;
    let state = ctx
      .data::<Arc<ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let user = super::ensure_authenticated_snapshot(ctx, state).await?.user;
    let repo = require_version_repo(state)?;

    let Some(from_version) = repo.get(from_uuid).await.map_err(repo_error)? else {
      return Err(async_graphql::Error::new("from document version not found"));
    };
    let Some(to_version) = repo.get(to_uuid).await.map_err(repo_error)? else {
      return Err(async_graphql::Error::new("to document version not found"));
    };
    if from_version.workspace_id != to_version.workspace_id || from_version.doc_id != to_version.doc_id {
      return Err(validation_error(
        "document version diff requires two versions from the same document",
        "to_id",
      ));
    }

    authorize_document_for_user(
      state,
      user.id,
      from_version.doc_id,
      myoxus_domain::permission::DocAction::Read,
    )
    .await?;

    let Some((from_version, from_snapshot)) = repo.snapshot_for_version(from_uuid).await.map_err(repo_error)? else {
      return Err(async_graphql::Error::new("from document version not found"));
    };
    let Some((to_version, to_snapshot)) = repo.snapshot_for_version(to_uuid).await.map_err(repo_error)? else {
      return Err(async_graphql::Error::new("to document version not found"));
    };
    if from_version.workspace_id != to_version.workspace_id || from_version.doc_id != to_version.doc_id {
      return Err(validation_error(
        "document version diff requires two versions from the same document",
        "to_id",
      ));
    }

    let diff = myoxus_application::document_version::diff_snapshots(&from_snapshot, &to_snapshot)
      .map_err(|err| async_graphql::Error::new(err.to_string()))?;

    debug!(
      from_version_id = %from_uuid,
      to_version_id = %to_uuid,
      doc_id = %from_version.doc_id,
      workspace_id = %from_version.workspace_id,
      user_id = %user.id,
      block_diffs = diff.block_diffs.len(),
      text_diffs = diff.text_diffs.len(),
      "document version diff fetched"
    );
    Ok(diff.into())
  }
}

pub struct DocumentVersionMutationRoot;

#[Object]
impl DocumentVersionMutationRoot {
  /// Save the current acknowledged document state, optionally attaching an
  /// explicit name. The request key makes lost-response retries replay-safe.
  #[instrument(skip(self, ctx), level = "info")]
  pub async fn capture_document_history(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    request_key: ID,
    name: Option<String>,
    description: Option<String>,
  ) -> Result<DocumentHistoryCaptureType> {
    let workspace_uuid =
      Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let request_key =
      Uuid::parse_str(request_key.as_str()).map_err(|_| validation_error("invalid request key", "requestKey"))?;
    let state = ctx
      .data::<Arc<ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, doc_id.as_str()).await?;
    let (state, actor_id, workspace_id) =
      require_doc_action(ctx, doc_uuid, myoxus_domain::permission::DocAction::Update).await?;
    let service =
      DocumentVersionCreateService::new(document_version_history_port(&state)?, require_version_repo(&state)?);
    let saved = service
      .save_current(DocumentHistorySaveRequest {
        doc_id: doc_uuid,
        workspace_id,
        actor_id,
        request_key,
        name,
        description,
      })
      .await
      .map_err(create_error)?;
    if !saved.replayed {
      let (target, value) = match &saved.version {
        Some(version) => (
          AuditTarget::entity("document_version", version.id, Some(version.label.clone())),
          version_audit_value(version),
        ),
        None => (
          AuditTarget::entity("document", doc_uuid, None),
          serde_json::json!({"docId": doc_uuid, "workspaceId": workspace_id, "historyId": saved.history_id}),
        ),
      };
      record_document_version_audit(ctx, &state, "document_history.capture", target, None, Some(value)).await;
    }
    Ok(DocumentHistoryCaptureType {
      history_id: ID(saved.history_id.to_string()),
      version: saved.version.map(Into::into),
    })
  }

  /// Attach an explicit name to one existing immutable history state without
  /// recapturing current content or moving the document's version head.
  #[instrument(skip(self, ctx), level = "info")]
  pub async fn name_document_history_state(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    history_id: ID,
    expected_version_ids: Vec<ID>,
    name: String,
    description: Option<String>,
  ) -> Result<DocumentVersionType> {
    let workspace_uuid =
      Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let history_id = history_id
      .as_str()
      .parse::<i64>()
      .map_err(|_| validation_error("invalid history id", "historyId"))?;
    let expected_version_ids = expected_version_ids
      .into_iter()
      .map(|id| Uuid::parse_str(id.as_str()).map_err(|_| validation_error("invalid version id", "expectedVersionIds")))
      .collect::<Result<Vec<_>>>()?;
    let state = ctx
      .data::<Arc<ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, doc_id.as_str()).await?;
    let (state, actor_id, workspace_id) =
      require_doc_action(ctx, doc_uuid, myoxus_domain::permission::DocAction::Update).await?;
    let service =
      DocumentVersionCreateService::new(document_version_history_port(&state)?, require_version_repo(&state)?);
    let named = service
      .name_history(DocumentHistoryNameRequest {
        doc_id: doc_uuid,
        workspace_id,
        history_id,
        expected_version_ids,
        actor_id,
        name,
        description,
      })
      .await
      .map_err(create_error)?;
    if !named.replayed {
      record_document_version_audit(
        ctx,
        &state,
        "document_history.name",
        AuditTarget::entity("document_version", named.version.id, Some(named.version.label.clone())),
        None,
        Some(version_audit_value(&named.version)),
      )
      .await;
    }
    Ok(named.version.into())
  }

  /// Create a named document version by capturing the current merged Yjs state
  /// into `doc_histories` and adding a user-visible label row.
  #[instrument(skip(self, ctx), level = "info")]
  pub async fn create_document_version(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    label: String,
    description: Option<String>,
  ) -> Result<DocumentVersionType> {
    let workspace_uuid =
      Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let state = ctx
      .data::<Arc<ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(state, workspace_uuid, doc_id.as_str()).await?;
    let (state, actor_id, workspace_id) =
      require_doc_action(ctx, doc_uuid, myoxus_domain::permission::DocAction::Update).await?;
    let repo = require_version_repo(&state)?;
    let create_service = DocumentVersionCreateService::new(document_version_history_port(&state)?, repo);
    let version = create_service
      .create(DocumentVersionCreateRequest::manual(
        doc_uuid,
        workspace_id,
        actor_id,
        Some(label),
        description,
      ))
      .await
      .map_err(create_error)?;
    record_document_version_audit(
      ctx,
      &state,
      "document_version.create",
      AuditTarget::entity("document_version", version.id, Some(version.label.clone())),
      None,
      Some(version_audit_value(&version)),
    )
    .await;
    Ok(version.into())
  }

  /// Pin a named version so retention GC cannot prune it.
  #[instrument(skip(self, ctx), level = "info")]
  pub async fn pin_document_version(&self, ctx: &Context<'_>, id: ID) -> Result<DocumentVersionType> {
    let version_id = Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new("invalid version id"))?;
    let (state, actor_id, mut version) =
      require_version_action(ctx, version_id, myoxus_domain::permission::DocAction::Update).await?;
    let repo = require_version_repo(&state)?;
    repo.pin(version_id).await.map_err(repo_error)?;
    version.is_pinned = true;
    info!(
      version_id = %version_id,
      doc_id = %version.doc_id,
      workspace_id = %version.workspace_id,
      actor_id = %actor_id,
      "document version pinned"
    );
    let mut old = version.clone();
    old.is_pinned = false;
    record_document_version_audit(
      ctx,
      &state,
      "document_version.pin",
      AuditTarget::entity("document_version", version.id, Some(version.label.clone())),
      Some(version_audit_value(&old)),
      Some(version_audit_value(&version)),
    )
    .await;
    Ok(version.into())
  }

  /// Remove a named version's pinned flag.
  #[instrument(skip(self, ctx), level = "info")]
  pub async fn unpin_document_version(&self, ctx: &Context<'_>, id: ID) -> Result<DocumentVersionType> {
    let version_id = Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new("invalid version id"))?;
    let (state, actor_id, mut version) =
      require_version_action(ctx, version_id, myoxus_domain::permission::DocAction::Update).await?;
    let repo = require_version_repo(&state)?;
    repo.unpin(version_id).await.map_err(repo_error)?;
    version.is_pinned = false;
    info!(
      version_id = %version_id,
      doc_id = %version.doc_id,
      workspace_id = %version.workspace_id,
      actor_id = %actor_id,
      "document version unpinned"
    );
    let mut old = version.clone();
    old.is_pinned = true;
    record_document_version_audit(
      ctx,
      &state,
      "document_version.unpin",
      AuditTarget::entity("document_version", version.id, Some(version.label.clone())),
      Some(version_audit_value(&old)),
      Some(version_audit_value(&version)),
    )
    .await;
    Ok(version.into())
  }

  /// Update a version's mutable label/description metadata. The snapshot link,
  /// creator, timestamp and pin state stay immutable; only the creator or a
  /// workspace admin/owner may change the user-facing metadata.
  #[instrument(skip(self, ctx), level = "info")]
  pub async fn update_document_version(
    &self,
    ctx: &Context<'_>,
    id: ID,
    label: String,
    description: Option<String>,
  ) -> Result<DocumentVersionType> {
    let version_id = Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new("invalid version id"))?;
    let label = sanitize_label(label)?;
    let description = sanitize_description(description);
    let (state, actor_id, old_version) = require_version_metadata_update(ctx, version_id).await?;
    let repo = require_version_repo(&state)?;

    repo
      .update_metadata(version_id, &label, description.as_deref())
      .await
      .map_err(repo_error)?;
    let Some(mut updated) = repo.get(version_id).await.map_err(repo_error)? else {
      return Err(async_graphql::Error::new("document version not found after update"));
    };
    // The repository reload is authoritative; this assignment only keeps the
    // audit target stable if a database trigger ever normalizes labels.
    updated.id = old_version.id;

    info!(
      version_id = %version_id,
      doc_id = %updated.doc_id,
      workspace_id = %updated.workspace_id,
      actor_id = %actor_id,
      "document version metadata updated"
    );
    record_document_version_audit(
      ctx,
      &state,
      "document_version.update",
      AuditTarget::entity("document_version", updated.id, Some(updated.label.clone())),
      Some(version_audit_value(&old_version)),
      Some(version_audit_value(&updated)),
    )
    .await;
    Ok(updated.into())
  }

  /// Delete a non-pinned named version. The underlying `doc_histories` snapshot
  /// is intentionally retained; it belongs to the append-only history chain.
  #[instrument(skip(self, ctx), level = "info")]
  pub async fn delete_document_version(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    let version_id = Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new("invalid version id"))?;
    let (state, actor_id, version) =
      require_version_action(ctx, version_id, myoxus_domain::permission::DocAction::Update).await?;
    let repo = require_version_repo(&state)?;
    repo.delete(version_id).await.map_err(repo_error)?;
    info!(
      version_id = %version_id,
      doc_id = %version.doc_id,
      workspace_id = %version.workspace_id,
      actor_id = %actor_id,
      "document version deleted"
    );
    record_document_version_audit(
      ctx,
      &state,
      "document_version.delete",
      AuditTarget::entity("document_version", version.id, Some(version.label.clone())),
      Some(version_audit_value(&version)),
      None,
    )
    .await;
    Ok(true)
  }

  /// Restore a named version by applying its DocHistory snapshot as a new doc
  /// update, then capturing that new current state as another named version.
  #[instrument(skip(self, ctx), level = "warn")]
  pub async fn restore_document_version(
    &self,
    ctx: &Context<'_>,
    id: ID,
    expected_revision: Option<String>,
  ) -> Result<DocumentVersionType> {
    let version_id = Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new("invalid version id"))?;
    let (state, actor_id, source) =
      require_version_action(ctx, version_id, myoxus_domain::permission::DocAction::Restore).await?;
    let repo = require_version_repo(&state)?;

    let restore_service = DocumentVersionRestoreService::new(document_version_history_port(&state)?, repo);
    let restored = restore_service
      .restore_at_revision(
        &source,
        crate::graphql::admin::resolve_audit_actor(ctx).await,
        None,
        parse_history_revision(expected_revision)?,
      )
      .await
      .map_err(|err| async_graphql::Error::new(err.to_string()))?;
    warn!(
      source_version_id = %version_id,
      new_version_id = %restored.id,
      doc_id = %restored.doc_id,
      workspace_id = %restored.workspace_id,
      actor_id = %actor_id,
      history_id = restored.doc_history_id,
      "document version restored as new snapshot"
    );
    Ok(restored.into())
  }

  /// Update per-document auto-versioning settings. Omitted fields keep their
  /// previous value; reading defaults still never inserts rows.
  #[instrument(skip(self, ctx), level = "info")]
  pub async fn update_document_versioning_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    auto_version_on: Option<Vec<AutoVersionTriggerType>>,
    retention_count: Option<i32>,
    enabled: Option<bool>,
  ) -> Result<DocumentVersioningSettingsType> {
    let workspace_uuid =
      Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let state = ctx
      .data::<Arc<ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(state, workspace_uuid, doc_id.as_str()).await?;
    if let Some(n) = retention_count
      && !(1..=50).contains(&n)
    {
      return Err(validation_error(
        "retention_count must be between 1 and 50",
        "retention_count",
      ));
    }

    let (state, actor_id, workspace_id) =
      require_doc_action(ctx, doc_uuid, myoxus_domain::permission::DocAction::Update).await?;
    let repo = require_settings_repo(&state)?;
    let old_settings = repo.get(doc_uuid).await.map_err(repo_error)?;

    if let Some(triggers) = auto_version_on.as_ref() {
      let domain_triggers: Vec<AutoVersionTrigger> = triggers.iter().copied().map(Into::into).collect();
      repo
        .set_triggers(doc_uuid, &domain_triggers)
        .await
        .map_err(repo_error)?;
    }
    if let Some(n) = retention_count {
      repo.set_retention_count(doc_uuid, n).await.map_err(repo_error)?;
    }
    if let Some(flag) = enabled {
      repo.set_enabled(doc_uuid, flag).await.map_err(repo_error)?;
    }

    let settings = repo.get(doc_uuid).await.map_err(repo_error)?;
    info!(
      doc_id = %doc_uuid,
      workspace_id = %workspace_id,
      actor_id = %actor_id,
      enabled = settings.enabled,
      retention_count = settings.retention_count,
      triggers = ?settings.auto_version_on,
      "document versioning settings updated"
    );
    record_document_version_audit(
      ctx,
      &state,
      "document_version.settings.update",
      AuditTarget {
        target_type: "document_versioning_settings".to_string(),
        target_id: doc_uuid.to_string(),
        target_label: Some(doc_uuid.to_string()),
      },
      Some(settings_audit_value(&old_settings, workspace_id)),
      Some(settings_audit_value(&settings, workspace_id)),
    )
    .await;
    Ok(settings.into())
  }

  /// Patch workspace history policy under one serialized settings lock.
  #[instrument(skip(self, ctx, input), level = "info")]
  pub async fn update_workspace_history_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    input: UpdateWorkspaceHistorySettingsInput,
  ) -> Result<WorkspaceHistorySettingsType> {
    let workspace_id =
      Uuid::parse_str(workspace_id.as_str()).map_err(|_| validation_error("invalid workspace id", "workspaceId"))?;
    let (state, actor_id) = require_workspace_action(
      ctx,
      workspace_id,
      myoxus_domain::permission::WorkspaceAction::SettingsUpdate,
    )
    .await?;
    let global = global_workspace_history_settings(&state).await;
    let service = WorkspaceHistorySettingsService::new(require_settings_repo(&state)?);
    let before = service
      .get(workspace_id, global.clone())
      .await
      .map_err(repo_error)?
      .ok_or_else(|| async_graphql::Error::new("workspace not found"))?;
    let patch = WorkspaceEditCaptureSettingsPatch {
      enabled: maybe_patch(input.named_versioning_enabled),
      auto_version_on: maybe_patch(input.auto_version_on)
        .map(|value| value.map(|triggers| triggers.into_iter().map(Into::into).collect())),
      retention_count: maybe_patch(input.retention_count),
      edit_capture_enabled: maybe_patch(input.edit_capture_enabled),
      edit_capture_interval_ms: maybe_patch(input.edit_capture_interval_ms),
    };
    if patch.enabled.is_none()
      && patch.auto_version_on.is_none()
      && patch.retention_count.is_none()
      && patch.edit_capture_enabled.is_none()
      && patch.edit_capture_interval_ms.is_none()
    {
      return Err(validation_error("at least one settings field is required", "input"));
    }
    let settings = service
      .update(workspace_id, patch, &input.expected_revision, actor_id, global)
      .await
      .map_err(repo_error)?
      .ok_or_else(|| async_graphql::Error::new("workspace not found"))?;
    state
      .audit_recorder()
      .record(AuditEvent::mutation(
        "document_history.workspace_settings.update",
        AuditCategory::Config,
        Some(AuditTarget::entity("workspace", workspace_id, None)),
        crate::graphql::admin::resolve_audit_actor(ctx).await,
        Some(workspace_history_audit_value(&before)),
        Some(workspace_history_audit_value(&settings)),
      ))
      .await;
    info!(%workspace_id, %actor_id, "workspace history settings updated");
    Ok(settings.into())
  }
}

fn workspace_history_audit_value(settings: &EffectiveWorkspaceHistorySettings) -> serde_json::Value {
  serde_json::json!({
    "namedVersioningEnabled": settings.named_versioning_enabled,
    "autoVersionOn": settings.auto_version_on.as_ref().map(|values| values.iter().map(AutoVersionTrigger::as_str).collect::<Vec<_>>()),
    "retentionCount": settings.retention_count,
    "editCaptureEnabled": settings.edit_capture_enabled,
    "editCaptureIntervalMs": settings.edit_capture_interval_ms,
  })
}
