// SPDX-License-Identifier: AGPL-3.0-or-later
//! Typed GraphQL projections for account-scoped workspace imports.

use async_graphql::{Enum, ID, InputObject, Json, SimpleObject};
use chrono::{DateTime, Utc};
use myoxus_application::workspace_import::{
  WorkspaceImportObjectCounts, WorkspaceImportPreview, WorkspaceImportTargetPlan,
};
use myoxus_domain::workspace_import::WorkspaceImportRecord;
use myoxus_workspace_import::WorkspaceImportDiagnostic;

#[derive(Enum, Clone, Copy, Debug, PartialEq, Eq)]
#[graphql(rename_items = "PascalCase")]
pub enum WorkspaceImportSourceFormatInput {
  ObsidianZip,
}

impl From<WorkspaceImportSourceFormatInput> for myoxus_workspace_import::WorkspaceImportFormat {
  fn from(value: WorkspaceImportSourceFormatInput) -> Self {
    match value {
      WorkspaceImportSourceFormatInput::ObsidianZip => Self::ObsidianZip,
    }
  }
}

#[derive(InputObject, Clone)]
pub struct WorkspaceImportPartManifestInput {
  pub part_number: i32,
  pub size_bytes: i64,
  pub content_hash: String,
}

#[derive(SimpleObject, Clone)]
pub struct WorkspaceImportPartUploadType {
  pub part_number: i32,
  pub size_bytes: i64,
  pub content_hash: String,
  pub upload_url: String,
}

#[derive(SimpleObject, Clone)]
pub struct WorkspaceImportUploadType {
  pub workspace_import_id: ID,
  pub part_size_bytes: i64,
  pub expires_at: DateTime<Utc>,
  pub parts: Vec<WorkspaceImportPartUploadType>,
}

#[derive(SimpleObject, Clone)]
pub struct WorkspaceImportCountsType {
  pub documents: i64,
  pub assets: i64,
  pub databases: i64,
  pub fields: i64,
  pub rows: i64,
  pub cells: i64,
  pub views: i64,
}

#[derive(SimpleObject, Clone)]
pub struct WorkspaceImportTargetPlanType {
  pub workspace_id: ID,
  pub document_ids: Vec<ID>,
  pub asset_ids: Vec<ID>,
  pub database_ids: Vec<ID>,
  pub tag_ids: Vec<ID>,
  pub vault: Option<Json<myoxus_application::workspace_import::ObsidianVaultPlan>>,
}

#[derive(SimpleObject, Clone)]
pub struct WorkspaceImportDiagnosticType {
  pub code: String,
  pub severity: String,
  pub message: String,
  pub context: Option<Json<serde_json::Value>>,
}

#[derive(SimpleObject, Clone)]
pub struct WorkspaceImportPreviewType {
  pub detected_format: String,
  pub source_root: String,
  pub proposed_workspace_title: String,
  pub counts: WorkspaceImportCountsType,
  pub omitted_counts: Json<myoxus_workspace_import::DecodedOmittedObjectCounts>,
  pub target_plan: WorkspaceImportTargetPlanType,
  pub diagnostics: Vec<WorkspaceImportDiagnosticType>,
  pub source_hash: String,
  pub config_fingerprint: String,
  pub plan_fingerprint: String,
  pub apply_allowed: bool,
}

#[derive(SimpleObject, Clone)]
pub struct WorkspaceImportType {
  pub id: ID,
  pub status: String,
  pub queued_operation: Option<String>,
  pub progress_stage: Option<String>,
  pub progress_current: i64,
  pub progress_total: i64,
  pub cancel_requested: bool,
  pub preview: Option<WorkspaceImportPreviewType>,
  pub target_workspace_id: Option<ID>,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub expires_at: DateTime<Utc>,
}

pub fn map_workspace_import(record: WorkspaceImportRecord) -> Result<WorkspaceImportType, serde_json::Error> {
  let preview = record
    .preview
    .map(serde_json::from_value::<WorkspaceImportPreview>)
    .transpose()?
    .map(map_preview);
  Ok(WorkspaceImportType {
    id: ID(record.id.to_string()),
    status: record.status.as_str().to_string(),
    queued_operation: record.queued_operation.map(|operation| operation.as_str().to_string()),
    progress_stage: record.progress_stage.map(|stage| stage.as_str().to_string()),
    progress_current: record.progress_current,
    progress_total: record.progress_total,
    cancel_requested: record.cancel_requested,
    preview,
    target_workspace_id: record.target_workspace_id.map(|id| ID(id.to_string())),
    error_code: record.error_code,
    error_message: record.error_message,
    created_at: record.created_at,
    updated_at: record.updated_at,
    expires_at: record.expires_at,
  })
}

fn map_preview(preview: WorkspaceImportPreview) -> WorkspaceImportPreviewType {
  WorkspaceImportPreviewType {
    detected_format: format_name(preview.detected_format).to_string(),
    source_root: preview.source_root,
    proposed_workspace_title: preview.proposed_workspace_title,
    counts: map_counts(preview.counts),
    omitted_counts: Json(preview.omitted_counts),
    target_plan: map_target_plan(preview.target_plan),
    diagnostics: preview
      .diagnostics
      .into_iter()
      .map(map_workspace_import_diagnostic)
      .collect(),
    source_hash: preview.source_hash,
    config_fingerprint: preview.config_fingerprint,
    plan_fingerprint: preview.plan_fingerprint,
    apply_allowed: preview.apply_allowed,
  }
}

fn map_counts(counts: WorkspaceImportObjectCounts) -> WorkspaceImportCountsType {
  WorkspaceImportCountsType {
    documents: counts.documents as i64,
    assets: counts.assets as i64,
    databases: counts.databases as i64,
    fields: counts.fields as i64,
    rows: counts.rows as i64,
    cells: counts.cells as i64,
    views: counts.views as i64,
  }
}

fn map_target_plan(plan: WorkspaceImportTargetPlan) -> WorkspaceImportTargetPlanType {
  WorkspaceImportTargetPlanType {
    workspace_id: ID(plan.workspace_id.to_string()),
    document_ids: plan.document_ids.into_iter().map(|id| ID(id.to_string())).collect(),
    asset_ids: plan.asset_ids.into_iter().map(|id| ID(id.to_string())).collect(),
    database_ids: plan.database_ids.into_iter().map(|id| ID(id.to_string())).collect(),
    tag_ids: plan.tag_ids.into_iter().map(|id| ID(id.to_string())).collect(),
    vault: plan.vault.map(Json),
  }
}

pub(crate) fn map_workspace_import_diagnostic(diagnostic: WorkspaceImportDiagnostic) -> WorkspaceImportDiagnosticType {
  WorkspaceImportDiagnosticType {
    code: diagnostic.code.as_str().to_string(),
    severity: match diagnostic.severity {
      myoxus_workspace_import::WorkspaceImportDiagnosticSeverity::Blocking => "blocking",
      myoxus_workspace_import::WorkspaceImportDiagnosticSeverity::Informational => "informational",
    }
    .to_string(),
    message: diagnostic.message,
    context: diagnostic
      .context
      .and_then(|context| serde_json::to_value(context).ok())
      .map(Json),
  }
}

fn format_name(format: myoxus_workspace_import::WorkspaceImportFormat) -> &'static str {
  match format {
    myoxus_workspace_import::WorkspaceImportFormat::SqliteV1 => "sqlite_v1",
    myoxus_workspace_import::WorkspaceImportFormat::SqliteDocStorage => "sqlite_doc_storage",
    myoxus_workspace_import::WorkspaceImportFormat::SnapshotZip => "snapshot_zip",
    myoxus_workspace_import::WorkspaceImportFormat::ObsidianZip => "obsidian_zip",
  }
}
