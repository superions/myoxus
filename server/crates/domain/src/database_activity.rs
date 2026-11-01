// SPDX-License-Identifier: AGPL-3.0-or-later
//! Domain types for the server-backed Database activity log (P-DB-24).
//!
//! Database activity events are the user-visible record of every mutation that
//! touches a row, cell, document link, assignment or status. Unlike the
//! operator-facing [`crate::audit`] log, the activity log is scoped to a
//! workspace and powers the per-row activity surface that workspace members
//! see from the Database detail view.
//!
//! Event types are stable short strings (`row.created`, `cell.changed`, …)
//! so they survive schema evolution. Full per-event metadata lives in a
//! JSONB payload that clients render through localized i18n keys.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ids::{DatabaseId, DatabaseRowId, UserId, WorkspaceId};

/// Stable, server-owned Database activity event types.
///
/// New variants must be appended, never renamed, so persisted payloads remain
/// readable. Display names live in i18n resources keyed by the
/// `com.myoxus.database.activity.*` namespace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseActivityEventType {
  /// A new row was created.
  RowCreated,
  /// A row's owned metadata (title, position, row kind) changed.
  RowUpdated,
  /// A row was deleted (soft-delete).
  RowDeleted,
  /// A cell value was set.
  CellChanged,
  /// A cell value was cleared.
  CellCleared,
  /// A row position changed (Kanban DnD, manual reorder).
  RowPositionChanged,
  /// An optional content document was attached to a Row.
  RowContentDocumentAttached,
  /// A Row's optional content document was detached without deletion.
  RowContentDocumentDetached,
  /// Row-template apply created or replaced cell defaults.
  RowTemplateApplied,
  /// Row assignees changed (Users cell write).
  RowAssignmentChanged,
  /// Row status changed (Status cell write).
  RowStatusChanged,
  /// Database was created (project/profile or generic).
  DatabaseCreated,
  /// Database was updated (metadata, profile config, structure preset).
  DatabaseUpdated,
  /// Database was deleted.
  DatabaseDeleted,
  /// CSV import completed.
  CsvImportCompleted,
  /// JSON snapshot import completed.
  JsonImportCompleted,
  /// CSV export completed.
  CsvExportCompleted,
  /// JSON snapshot export completed.
  JsonExportCompleted,
  // P-DB-26: bulk operation events. The per-row details live in the
  // payload JSONB column; the activity log keeps one summary entry per
  // bulk call so the timeline stays readable when a member edits
  // hundreds of rows in a single action.
  /// Multiple rows were updated in a single bulk operation.
  BulkRowsUpdated,
  /// Multiple rows were soft-deleted in a single bulk operation.
  BulkRowsDeleted,
  /// Multiple rows were restored in a single bulk operation.
  BulkRowsRestored,
  /// Multiple rows had their `position` rewritten in a single bulk reorder
  /// (Kanban DnD, manual list reorder).
  BulkRowPositionsChanged,
}

impl DatabaseActivityEventType {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::RowCreated => "row.created",
      Self::RowUpdated => "row.updated",
      Self::RowDeleted => "row.deleted",
      Self::CellChanged => "cell.changed",
      Self::CellCleared => "cell.cleared",
      Self::RowPositionChanged => "row.position_changed",
      Self::RowContentDocumentAttached => "row.content_document_attached",
      Self::RowContentDocumentDetached => "row.content_document_detached",
      Self::RowTemplateApplied => "row.template_applied",
      Self::RowAssignmentChanged => "row.assignment_changed",
      Self::RowStatusChanged => "row.status_changed",
      Self::DatabaseCreated => "database.created",
      Self::DatabaseUpdated => "database.updated",
      Self::DatabaseDeleted => "database.deleted",
      Self::CsvImportCompleted => "import.csv_completed",
      Self::JsonImportCompleted => "import.json_completed",
      Self::CsvExportCompleted => "export.csv_completed",
      Self::JsonExportCompleted => "export.json_completed",
      Self::BulkRowsUpdated => "bulk.rows_updated",
      Self::BulkRowsDeleted => "bulk.rows_deleted",
      Self::BulkRowsRestored => "bulk.rows_restored",
      Self::BulkRowPositionsChanged => "bulk.row_positions_changed",
    }
  }

  fn parse_db(value: &str) -> Option<Self> {
    match value {
      "row.created" => Some(Self::RowCreated),
      "row.updated" => Some(Self::RowUpdated),
      "row.deleted" => Some(Self::RowDeleted),
      "cell.changed" => Some(Self::CellChanged),
      "cell.cleared" => Some(Self::CellCleared),
      "row.position_changed" => Some(Self::RowPositionChanged),
      "row.content_document_attached" => Some(Self::RowContentDocumentAttached),
      "row.content_document_detached" => Some(Self::RowContentDocumentDetached),
      "row.template_applied" => Some(Self::RowTemplateApplied),
      "row.assignment_changed" => Some(Self::RowAssignmentChanged),
      "row.status_changed" => Some(Self::RowStatusChanged),
      "database.created" => Some(Self::DatabaseCreated),
      "database.updated" => Some(Self::DatabaseUpdated),
      "database.deleted" => Some(Self::DatabaseDeleted),
      "import.csv_completed" => Some(Self::CsvImportCompleted),
      "import.json_completed" => Some(Self::JsonImportCompleted),
      "export.csv_completed" => Some(Self::CsvExportCompleted),
      "export.json_completed" => Some(Self::JsonExportCompleted),
      "bulk.rows_updated" => Some(Self::BulkRowsUpdated),
      "bulk.rows_deleted" => Some(Self::BulkRowsDeleted),
      "bulk.rows_restored" => Some(Self::BulkRowsRestored),
      "bulk.row_positions_changed" => Some(Self::BulkRowPositionsChanged),
      _ => None,
    }
  }
}

impl std::str::FromStr for DatabaseActivityEventType {
  type Err = ();

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    Self::parse_db(value).ok_or(())
  }
}

impl std::fmt::Display for DatabaseActivityEventType {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(self.as_str())
  }
}

/// A database activity event ready for persistence.
#[derive(Debug, Clone)]
pub struct DatabaseActivityEvent {
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub row_id: Option<DatabaseRowId>,
  pub event_type: DatabaseActivityEventType,
  pub actor_user_id: Option<UserId>,
  pub payload: serde_json::Value,
}

impl DatabaseActivityEvent {
  pub fn new(workspace_id: WorkspaceId, database_id: DatabaseId, event_type: DatabaseActivityEventType) -> Self {
    Self {
      workspace_id,
      database_id,
      row_id: None,
      event_type,
      actor_user_id: None,
      payload: serde_json::Value::Object(Default::default()),
    }
  }

  pub fn with_row(mut self, row_id: DatabaseRowId) -> Self {
    self.row_id = Some(row_id);
    self
  }

  pub fn with_actor(mut self, actor_user_id: UserId) -> Self {
    self.actor_user_id = Some(actor_user_id);
    self
  }

  pub fn with_payload(mut self, payload: serde_json::Value) -> Self {
    self.payload = payload;
    self
  }
}

/// Filter for listing database activity events.
#[derive(Debug, Clone, Default)]
pub struct DatabaseActivityFilter {
  pub workspace_id: WorkspaceId,
  pub database_id: Option<DatabaseId>,
  pub row_id: Option<DatabaseRowId>,
  pub actor_user_id: Option<UserId>,
  pub event_types: Vec<DatabaseActivityEventType>,
  pub from: Option<DateTime<Utc>>,
  pub to: Option<DateTime<Utc>>,
}

/// A persisted database activity event (read-back).
#[derive(Debug, Clone)]
pub struct DatabaseActivityEntry {
  pub id: Uuid,
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub row_id: Option<DatabaseRowId>,
  pub event_type: DatabaseActivityEventType,
  pub actor_user_id: Option<UserId>,
  /// Current display name of the actor, resolved by the read store. The
  /// immutable actor ID remains authoritative; this projection is UI-only.
  pub actor_display_name: Option<String>,
  pub payload: serde_json::Value,
  pub created_at: DateTime<Utc>,
}

#[derive(Debug)]
pub enum DatabaseActivityError {
  Storage(String),
}

impl std::fmt::Display for DatabaseActivityError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Storage(msg) => write!(f, "database activity storage error: {msg}"),
    }
  }
}

impl std::error::Error for DatabaseActivityError {}

/// Persistence port for the database activity log.
#[async_trait]
pub trait DatabaseActivityStore: Send + Sync {
  /// Persist a single activity event. Implementations may batch or coalesce;
  /// callers must treat this as best-effort.
  async fn record(&self, event: DatabaseActivityEvent) -> Result<(), DatabaseActivityError>;

  /// List activity entries matching `filter`, ordered newest-first.
  async fn list(
    &self,
    filter: DatabaseActivityFilter,
    skip: i64,
    take: i64,
  ) -> Result<Vec<DatabaseActivityEntry>, DatabaseActivityError>;

  /// Count matching activity entries (for pagination).
  async fn count(&self, filter: DatabaseActivityFilter) -> Result<i64, DatabaseActivityError>;
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn event_type_roundtrips_through_string() {
    for variant in [
      DatabaseActivityEventType::RowCreated,
      DatabaseActivityEventType::CellChanged,
      DatabaseActivityEventType::RowAssignmentChanged,
      DatabaseActivityEventType::JsonImportCompleted,
    ] {
      let raw = variant.as_str();
      let parsed: DatabaseActivityEventType = raw.parse().expect("parse event type");
      assert_eq!(parsed, variant);
    }
  }

  #[test]
  fn event_type_rejects_unknown_value() {
    let err = "totally.bogus".parse::<DatabaseActivityEventType>();
    assert!(err.is_err());
  }

  #[test]
  fn event_builder_attaches_row_actor_and_payload() {
    let event = DatabaseActivityEvent::new(
      Uuid::new_v4(),
      Uuid::new_v4(),
      DatabaseActivityEventType::RowContentDocumentAttached,
    )
    .with_row(Uuid::new_v4())
    .with_actor(Uuid::new_v4())
    .with_payload(serde_json::json!({"documentId": "doc-1"}));
    assert_eq!(event.event_type, DatabaseActivityEventType::RowContentDocumentAttached);
    assert!(event.row_id.is_some());
    assert!(event.actor_user_id.is_some());
    assert_eq!(event.payload["documentId"], "doc-1");
  }
}
