// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::database::{
  DatabaseBulkRowOutcome, DatabaseField, DatabaseFieldType, DatabaseRecord, DatabaseWorkspaceTagImportDiagnostic,
};
use crate::ids::{DatabaseCsvMappingTemplateId, DatabaseId, DatabaseRowId, DatabaseViewId, UserId, WorkspaceId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// RFC-4180 CSV diagnostic emitted by both preview and apply paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCsvDiagnostic {
  pub code: String,
  pub source: String,
  pub row: Option<i32>,
  pub field: Option<String>,
  pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCsvDetectedColumn {
  pub index: i32,
  pub source_header: String,
  pub field_name: String,
  pub field_type: DatabaseFieldType,
  pub is_title: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseCsvDelimiter {
  Auto,
  Comma,
  Semicolon,
  Tab,
  Pipe,
  Custom,
}

impl DatabaseCsvDelimiter {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Auto => "auto",
      Self::Comma => "comma",
      Self::Semicolon => "semicolon",
      Self::Tab => "tab",
      Self::Pipe => "pipe",
      Self::Custom => "custom",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCsvDialect {
  pub delimiter: DatabaseCsvDelimiter,
  pub custom_delimiter: Option<String>,
  pub quote: Option<String>,
  pub escape: Option<String>,
  pub double_quote: bool,
}

impl Default for DatabaseCsvDialect {
  fn default() -> Self {
    Self {
      delimiter: DatabaseCsvDelimiter::Auto,
      custom_delimiter: None,
      quote: None,
      escape: None,
      double_quote: true,
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCsvColumnMapping {
  pub source_index: i32,
  pub import_column: bool,
  pub field_name: Option<String>,
  pub field_type: Option<DatabaseFieldType>,
  pub is_title: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCsvAppliedColumnMapping {
  pub source_index: i32,
  pub import_column: bool,
  pub source_header: String,
  pub field_name: String,
  pub field_type: DatabaseFieldType,
  pub is_title: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCsvImportOptions {
  #[serde(default)]
  pub dialect: DatabaseCsvDialect,
  pub first_row_is_header: Option<bool>,
  #[serde(default)]
  pub mapping: Vec<DatabaseCsvColumnMapping>,
}

/// Quote strategy applied to CSV export. `Minimal` only quotes fields
/// that need quoting (containing the delimiter, quote, or newline);
/// `All` quotes every field so the consumer can rely on positional
/// round-trips regardless of cell content.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseCsvQuoteStrategy {
  #[default]
  Minimal,
  All,
}

impl DatabaseCsvQuoteStrategy {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Minimal => "minimal",
      Self::All => "all",
    }
  }
}

/// Locale mode applied to CSV export. `Machine` writes stable,
/// machine-readable values (RFC 3339 datetimes, ISO 4217 currency
/// amounts, ISO 8601 durations) — the default that any consumer can
/// parse. `Localized` writes user-facing strings in the requested
/// `locale` (e.g. `2026-07-08` for de-DE, `42 €` for de-DE currency).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseCsvLocaleMode {
  #[default]
  Machine,
  Localized,
}

impl DatabaseCsvLocaleMode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Machine => "machine",
      Self::Localized => "localized",
    }
  }
}

/// What slice of the database the export covers. `Database` is the
/// canonical whole-Database export. `View` uses the supplied
/// `view_id`'s visible field set. `SelectedRows` only emits the rows
/// explicitly listed in `row_ids` — preserving the visible field set
/// of the supplied `view_id` (or all fields if `view_id` is null).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseCsvExportTarget {
  #[default]
  Database,
  View,
  SelectedRows,
}

impl DatabaseCsvExportTarget {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Database => "database",
      Self::View => "view",
      Self::SelectedRows => "selected_rows",
    }
  }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCsvExportOptions {
  #[serde(default)]
  pub dialect: DatabaseCsvDialect,
  /// When false, the export skips the header row. P-DB-27 export
  /// contract: default true for human-readable exports, false for
  /// machine-only round-trips.
  #[serde(default = "default_csv_header_row")]
  pub include_header: bool,
  #[serde(default)]
  pub quote_strategy: DatabaseCsvQuoteStrategy,
  #[serde(default)]
  pub locale_mode: DatabaseCsvLocaleMode,
  /// BCP-47 locale used when `locale_mode == Localized`. Stored
  /// alongside the export options so the server can pick the
  /// correct formatter without an extra round-trip.
  #[serde(default)]
  pub locale: Option<String>,
  /// What slice of the database to export.
  #[serde(default)]
  pub target: DatabaseCsvExportTarget,
  /// Required when `target == View` or `SelectedRows`.
  #[serde(default)]
  pub view_id: Option<DatabaseViewId>,
  /// Required when `target == SelectedRows`.
  #[serde(default)]
  pub row_ids: Vec<DatabaseRowId>,
}

fn default_csv_header_row() -> bool {
  true
}

impl DatabaseCsvExportOptions {
  pub fn row_count_hint(&self) -> Option<usize> {
    if self.target == DatabaseCsvExportTarget::SelectedRows {
      Some(self.row_ids.len())
    } else {
      None
    }
  }
}

/// One saved mapping template per workspace. Templates are scoped to
/// a workspace, immutable per revision, and the table enforces that
/// exactly one row per `(workspace_id, name)` is current.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCsvMappingTemplate {
  pub id: DatabaseCsvMappingTemplateId,
  pub workspace_id: WorkspaceId,
  pub name: String,
  pub revision: i32,
  pub is_current: bool,
  pub dialect: DatabaseCsvDialect,
  pub first_row_is_header: bool,
  pub mapping: Vec<DatabaseCsvAppliedColumnMapping>,
  pub created_by: UserId,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCsvMappingTemplateSummary {
  pub id: DatabaseCsvMappingTemplateId,
  pub name: String,
  pub revision: i32,
  pub updated_at: DateTime<Utc>,
}

/// Input payload for saving a CSV mapping template. The repository
/// assigns the server-side `id`, `revision`, `is_current`, and the
/// audit timestamps.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewDatabaseCsvMappingTemplate {
  pub workspace_id: WorkspaceId,
  pub name: String,
  pub dialect: DatabaseCsvDialect,
  pub first_row_is_header: bool,
  pub mapping: Vec<DatabaseCsvAppliedColumnMapping>,
  pub created_by: UserId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCsvPreview {
  pub detected_delimiter: String,
  pub detected_dialect: DatabaseCsvDialect,
  pub applied_dialect: DatabaseCsvDialect,
  pub detected_columns: Vec<DatabaseCsvDetectedColumn>,
  pub applied_mapping: Vec<DatabaseCsvAppliedColumnMapping>,
  pub confidence: String,
  pub inferred_fields: Vec<DatabaseField>,
  pub row_count: i32,
  pub errors: Vec<DatabaseCsvDiagnostic>,
  pub warnings: Vec<DatabaseCsvDiagnostic>,
  #[serde(default)]
  pub workspace_tag_diagnostics: Vec<DatabaseWorkspaceTagImportDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCsvImportResult {
  pub database: DatabaseRecord,
  pub created_field_count: i32,
  pub created_row_count: i32,
  pub created_doc_count: i32,
  pub skipped_row_count: i32,
  /// P-DB-26: per-row diagnostic stream. Each entry carries the stable
  /// `MIX_DATABASE_*` error code so the wizard can render a structured
  /// per-row failure panel even when earlier rows committed successfully.
  /// Empty when every accepted row succeeded.
  pub failed_rows: Vec<DatabaseBulkRowOutcome>,
  pub errors: Vec<DatabaseCsvDiagnostic>,
  pub warnings: Vec<DatabaseCsvDiagnostic>,
  #[serde(default)]
  pub workspace_tag_diagnostics: Vec<DatabaseWorkspaceTagImportDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCsvExport {
  pub file_name: String,
  pub content_type: String,
  pub content: String,
  pub row_count: i32,
  pub column_count: i32,
  pub database_id: DatabaseId,
  pub view_id: Option<DatabaseViewId>,
  /// The export slice that was used to produce this file. Echoed
  /// back so the client can render a one-line summary without
  /// re-deriving it from input state.
  pub target: DatabaseCsvExportTarget,
  pub include_header: bool,
  pub quote_strategy: DatabaseCsvQuoteStrategy,
  pub locale_mode: DatabaseCsvLocaleMode,
  pub locale: Option<String>,
  /// Diagnostics raised by the export itself (e.g. unknown row id
  /// in a `SelectedRows` request). P-DB-27 keeps the export
  /// authoritative and the wizard surfaces the warnings instead
  /// of silently dropping rows.
  pub warnings: Vec<DatabaseCsvDiagnostic>,
  #[serde(default)]
  pub workspace_tag_diagnostics: Vec<DatabaseWorkspaceTagImportDiagnostic>,
}

/// Maximum number of rows a single CSV export with
/// `target=SelectedRows` may select. Stays aligned with the bulk
/// operation cap so the export and the bulk delete / update paths
/// share a common safety budget.
pub const DATABASE_CSV_EXPORT_MAX_ROWS_PER_REQUEST: usize = 500;
