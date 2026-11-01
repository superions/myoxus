// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::database::DatabaseDomainError;
use crate::ids::{DatabaseId, DatabaseImportJobId, UserId, WorkspaceId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// P-DB-26: lifecycle of a `database.bulkImport` or `database.bulkExport`
/// job. The native record is authoritative even when Redis handoff or a
/// committed result response is lost. Terminal success and cancellation are
/// preserved by conditional writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseImportJobStatus {
  /// Accepted native job awaiting delivery or an explicit handoff retry.
  Queued,
  /// Worker has dispatched the job and is applying rows / cells.
  Running,
  /// Apply finished and the import summary is in `result_json`.
  Succeeded,
  /// Native execution failed; the failed record remains available for inspection.
  Failed,
  /// Cancellation won before atomic import apply; no partial imported data remains.
  Cancelled,
}

impl DatabaseImportJobStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Queued => "queued",
      Self::Running => "running",
      Self::Succeeded => "succeeded",
      Self::Failed => "failed",
      Self::Cancelled => "cancelled",
    }
  }

  pub fn from_db(value: &str) -> Result<Self, DatabaseDomainError> {
    match value {
      "queued" => Ok(Self::Queued),
      "running" => Ok(Self::Running),
      "succeeded" => Ok(Self::Succeeded),
      "failed" => Ok(Self::Failed),
      "cancelled" => Ok(Self::Cancelled),
      other => Err(DatabaseDomainError::Validation(format!(
        "unknown database_import_jobs.status: {other}"
      ))),
    }
  }

  /// Live states block a parallel retry under the partial UNIQUE index.
  pub fn is_live(self) -> bool {
    matches!(self, Self::Queued | Self::Running | Self::Succeeded)
  }

  /// Terminal states the operator can retry against the same idempotency key.
  pub fn is_retryable(self) -> bool {
    matches!(self, Self::Failed | Self::Cancelled)
  }
}

/// P-DB-26: which background job kind this row tracks. The `kind` column is
/// stored as TEXT to allow adding more granular kinds (e.g. `csv`, `json`,
/// `notion`) without a migration, but the value space today is fixed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseImportJobKind {
  BulkImport,
  BulkExport,
}

impl DatabaseImportJobKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::BulkImport => "bulk_import",
      Self::BulkExport => "bulk_export",
    }
  }

  pub fn from_db(value: &str) -> Result<Self, DatabaseDomainError> {
    match value {
      "bulk_import" => Ok(Self::BulkImport),
      "bulk_export" => Ok(Self::BulkExport),
      other => Err(DatabaseDomainError::Validation(format!(
        "unknown database_import_jobs.kind: {other}"
      ))),
    }
  }
}

/// P-DB-26: durable record for one `database.bulkImport` / `database.bulkExport`
/// job. The record is the source of truth for idempotency, retry, cancellation
/// and compensation; the Redis job body is just an envelope pointing here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseImportJobRecord {
  pub id: DatabaseImportJobId,
  pub workspace_id: WorkspaceId,
  pub database_id: Option<DatabaseId>,
  pub actor_id: Option<UserId>,
  pub kind: DatabaseImportJobKind,
  pub idempotency_key: String,
  pub status: DatabaseImportJobStatus,
  pub attempt_count: i32,
  pub cancellation_requested_at: Option<DateTime<Utc>>,
  pub cancelled_at: Option<DateTime<Utc>>,
  pub started_at: Option<DateTime<Utc>>,
  pub finished_at: Option<DateTime<Utc>>,
  pub last_error_code: Option<String>,
  pub last_error_message: Option<String>,
  pub payload_summary: Value,
  pub result: Option<Value>,
  pub created_at: DateTime<Utc>,
}
