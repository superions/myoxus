// SPDX-License-Identifier: AGPL-3.0-or-later

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::ids::{UserId, WorkspaceId, WorkspaceImportId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceImportStatus {
  Staged,
  Previewed,
  Queued,
  Running,
  Succeeded,
  Failed,
  Cancelled,
  CleanupRequired,
  Expired,
}

impl WorkspaceImportStatus {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Staged => "staged",
      Self::Previewed => "previewed",
      Self::Queued => "queued",
      Self::Running => "running",
      Self::Succeeded => "succeeded",
      Self::Failed => "failed",
      Self::Cancelled => "cancelled",
      Self::CleanupRequired => "cleanup_required",
      Self::Expired => "expired",
    }
  }

  /// Return whether the durable import state machine permits `next`.
  ///
  /// Queue retries deliberately keep a running import in `Running`; they do
  /// not create a second logical transition or a second product-write plan.
  pub const fn can_transition_to(self, next: Self) -> bool {
    matches!(
      (self, next),
      (Self::Staged, Self::Queued | Self::Cancelled | Self::Expired)
        | (Self::Queued, Self::Running | Self::Cancelled | Self::Failed)
        | (
          Self::Running,
          Self::Previewed | Self::Succeeded | Self::Failed | Self::Cancelled | Self::CleanupRequired
        )
        | (Self::Previewed, Self::Queued | Self::Cancelled | Self::Expired)
        | (Self::Succeeded, Self::Expired)
        | (Self::Failed, Self::Queued | Self::Expired)
        | (Self::Cancelled, Self::Expired)
        | (Self::CleanupRequired, Self::Queued)
    )
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceImportOperation {
  Preview,
  Apply,
  Cleanup,
}

impl WorkspaceImportOperation {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Preview => "preview",
      Self::Apply => "apply",
      Self::Cleanup => "cleanup",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceImportProgressStage {
  Validation,
  DocumentDecode,
  AssetPlanning,
  DatabasePlanning,
  TargetCreation,
  DocumentMaterialization,
  DatabaseMaterialization,
  ReferenceRewrite,
  FinalValidation,
  Publication,
  Compensation,
}

impl WorkspaceImportProgressStage {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Validation => "validation",
      Self::DocumentDecode => "document_decode",
      Self::AssetPlanning => "asset_planning",
      Self::DatabasePlanning => "database_planning",
      Self::TargetCreation => "target_creation",
      Self::DocumentMaterialization => "document_materialization",
      Self::DatabaseMaterialization => "database_materialization",
      Self::ReferenceRewrite => "reference_rewrite",
      Self::FinalValidation => "final_validation",
      Self::Publication => "publication",
      Self::Compensation => "compensation",
    }
  }

  /// Stable ordering used by durable progress updates. A retry may advance
  /// within a stage, but it must never publish an earlier stage to clients.
  pub const fn rank(self) -> i16 {
    match self {
      Self::Validation => 1,
      Self::DocumentDecode => 2,
      Self::AssetPlanning => 3,
      Self::DatabasePlanning => 4,
      Self::TargetCreation => 5,
      Self::DocumentMaterialization => 6,
      Self::DatabaseMaterialization => 7,
      Self::ReferenceRewrite => 8,
      Self::FinalValidation => 9,
      Self::Publication => 10,
      Self::Compensation => 11,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceImportMappingKind {
  Workspace,
  Document,
  Database,
  View,
  Field,
  Row,
  Asset,
}

impl WorkspaceImportMappingKind {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Workspace => "workspace",
      Self::Document => "document",
      Self::Database => "database",
      Self::View => "view",
      Self::Field => "field",
      Self::Row => "row",
      Self::Asset => "asset",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceImportCompensationKind {
  Workspace,
  Document,
  Database,
  Asset,
}

impl WorkspaceImportCompensationKind {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Workspace => "workspace",
      Self::Document => "document",
      Self::Database => "database",
      Self::Asset => "asset",
    }
  }
}

/// Durable staging identity. Source bytes remain in the account-owned staging
/// namespace; neither this record nor a Redis envelope carries raw content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportRecord {
  pub id: WorkspaceImportId,
  pub actor_id: UserId,
  pub status: WorkspaceImportStatus,
  /// Explicit source kind selected before upload. `auto` preserves legacy
  /// content detection; structurally overlapping ZIP formats use a named kind.
  pub selected_format: String,
  pub staging_object_key: String,
  pub source_hash: String,
  pub source_size_bytes: i64,
  pub config_fingerprint: String,
  pub preview: Option<Value>,
  pub target_workspace_id: Option<WorkspaceId>,
  pub queued_operation: Option<WorkspaceImportOperation>,
  pub progress_stage: Option<WorkspaceImportProgressStage>,
  pub progress_current: i64,
  pub progress_total: i64,
  pub cancel_requested: bool,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportPart {
  pub import_id: WorkspaceImportId,
  pub part_number: i32,
  pub object_key: String,
  pub size_bytes: i64,
  pub content_hash: String,
  pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportIdMapping {
  pub import_id: WorkspaceImportId,
  pub kind: WorkspaceImportMappingKind,
  pub source_id: String,
  pub target_id: Uuid,
  pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportCompensation {
  pub id: i64,
  pub import_id: WorkspaceImportId,
  pub sequence: i64,
  pub kind: WorkspaceImportCompensationKind,
  pub target_id: String,
  pub completed_at: Option<DateTime<Utc>>,
  pub last_error: Option<String>,
  pub created_at: DateTime<Utc>,
}
