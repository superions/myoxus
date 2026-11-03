//! Native Database composition and shared access, limits, errors and effects.
//!
//! The themed services own ACL, validation, formats and Row/document coupling.
//! Browser Web and editor embeds
//! may cache GraphQL responses, but they must not persist schema, rows or cell
//! values as a parallel truth.

pub mod activity;
pub mod definition;
pub mod projections;
pub use projections::{DatabaseFormulaRecomputeOutcome, DatabaseProjectionService, DatabaseRollupRecomputeOutcome};
pub mod import_export;
pub use import_export::{DatabaseImportExportService, notion_import};

pub use definition::{DatabaseDefinitionService, DatabaseStarterTemplateCatalog, DatabaseStarterTemplateSource};
mod access;
pub mod editing;
pub mod reminders;
pub mod views;
pub use editing::capture::{DatabaseTaskCaptureInput, DatabaseTaskCaptureResult};
pub use reminders::DatabaseReminderService;

pub use import_export::{
  LegacyDatabaseBlockReferencePlan, LegacyDatabaseDocumentSource, LegacyDatabaseFieldPlan,
  LegacyDatabaseMigrationApplyResult, LegacyDatabaseMigrationPlan, LegacyDatabasePlan, LegacyDatabaseRowPlan,
  LegacyDatabaseViewPlan, plan_fresh_workspace_legacy_database_migration, plan_legacy_database_migration,
};
pub use import_export::{WorkspaceContentDatabaseIdentityPlan, WorkspaceContentDatabasePublicationBundle};

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use chrono::Datelike;
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use moka::future::Cache;
use myoxus_domain::database::*;
use myoxus_domain::database::{
  DatabaseDefinitionRepository, DatabaseEditingRepository, DatabaseImportExportRepository,
  DatabaseProjectionRepository, DatabaseViewRepository,
};
use myoxus_domain::entities::WorkspaceRole;
use myoxus_domain::ids::*;
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use myoxus_domain::repositories::{PageRequest, RepositoryError};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{debug, error, info, instrument, warn};
use uuid::Uuid;

use self::activity::DatabaseActivityRecorder;
use crate::audit::{AuditActor, AuditCategory, AuditEvent, AuditRecorder, AuditTarget};
use crate::doc::{DocCachePort, DocService};
use crate::notification::NotificationService;
use crate::permission::{AccessController, DocResource, PermissionService, WorkspaceResource};
use crate::ports::blob::BlobStatus;
use crate::ports::blob_service::BlobService;
use crate::ports::database_change::DatabaseChangeNotificationPort;
use crate::workspace::WorkspaceStore;
use crate::workspace_tags::WorkspaceTagService;
use myoxus_domain::database_activity::DatabaseActivityEventType;
use myoxus_domain::database_change::{DatabaseChangeEvent, DatabaseChangeKind, DatabaseChangeTarget};

pub const ERR_NOT_FOUND: &str = "MIX_DATABASE_NOT_FOUND";
pub const ERR_FORBIDDEN: &str = "MIX_DATABASE_FORBIDDEN";
pub const ERR_FIELD_INVALID: &str = "MIX_DATABASE_FIELD_INVALID";
pub const ERR_PROJECT_STATUS_IN_USE: &str = "MIX_DATABASE_PROJECT_STATUS_IN_USE";
pub const ERR_FIELD_REQUIRED: &str = "MIX_DATABASE_FIELD_REQUIRED";
pub const ERR_ROW_INVALID: &str = "MIX_DATABASE_ROW_INVALID";
pub const ERR_DATABASE_CONFLICT: &str = "MIX_DATABASE_CONFLICT";
pub const ERR_QUERY_INVALID: &str = "MIX_DATABASE_QUERY_INVALID";
pub const ERR_TASK_RELATION_INVALID: &str = "MIX_DATABASE_TASK_RELATION_INVALID";
pub const ERR_PROJECT_HIERARCHY_INVALID: &str = "MIX_DATABASE_PROJECT_HIERARCHY_INVALID";

type ResolvedRowsQuery = (
  Vec<DatabaseSortRule>,
  Vec<DatabaseFilterRule>,
  Option<DatabaseFilterGroup>,
  Option<String>,
);

/// P-DB-26: map a [`RepositoryError`] emitted by a bulk repository call into
/// the corresponding `MIX_DATABASE_*` code used by the bulk GraphQL response.
///
/// The mapping keeps UI localization simple: clients only ever have to reason
/// about the standard error codes, not infrastructure error variants.
fn database_bulk_error_code_for(err: &RepositoryError) -> String {
  match err {
    RepositoryError::NotFound(_) => ERR_NOT_FOUND.to_string(),
    RepositoryError::Conflict(_) => ERR_DATABASE_CONFLICT.to_string(),
    RepositoryError::Validation(message) if DatabaseTaskRelationReason::from_validation_message(message).is_some() => {
      ERR_TASK_RELATION_INVALID.to_string()
    }
    RepositoryError::Validation(message) if message.starts_with("database project hierarchy invalid") => {
      ERR_PROJECT_HIERARCHY_INVALID.to_string()
    }
    RepositoryError::Validation(message) if message.starts_with("database role-managed field is read-only") => {
      ERR_CELL_VALUE_READONLY.to_string()
    }
    RepositoryError::Validation(_) => ERR_CELL_INVALID.to_string(),
    RepositoryError::Storage(_) => ERR_STORAGE.to_string(),
  }
}
pub const ERR_CELL_INVALID: &str = "MIX_DATABASE_CELL_VALUE_INVALID";
pub const ERR_VIEW_INVALID: &str = "MIX_DATABASE_VIEW_INVALID";
pub const ERR_LIMIT_EXCEEDED: &str = "MIX_DATABASE_LIMIT_EXCEEDED";
pub const ERR_STORAGE: &str = "MIX_DATABASE_STORAGE";
pub const ERR_CSV_INVALID: &str = "MIX_DATABASE_CSV_INVALID";
pub const ERR_CSV_TOO_LARGE: &str = "MIX_DATABASE_CSV_TOO_LARGE";
pub const ERR_CSV_COLUMN_LIMIT: &str = "MIX_DATABASE_CSV_COLUMN_LIMIT";
pub const ERR_CSV_ROW_LIMIT: &str = "MIX_DATABASE_CSV_ROW_LIMIT";

fn clone_database_repository_error(error: &RepositoryError) -> RepositoryError {
  match error {
    RepositoryError::NotFound(entity) => RepositoryError::NotFound(entity),
    RepositoryError::Conflict(message) => RepositoryError::Conflict(message),
    RepositoryError::Validation(message) => RepositoryError::Validation(message.clone()),
    RepositoryError::Storage(message) => RepositoryError::Storage(message.clone()),
  }
}
pub const ERR_CSV_LIMIT_EXCEEDED: &str = "MIX_DATABASE_CSV_LIMIT_EXCEEDED";
pub const ERR_JSON_INVALID: &str = "MIX_DATABASE_JSON_INVALID";
pub const ERR_JSON_UNSUPPORTED_VERSION: &str = "MIX_DATABASE_JSON_UNSUPPORTED_VERSION";
pub const ERR_JSON_MISSING_FILE: &str = "MIX_DATABASE_JSON_MISSING_FILE";
pub const ERR_JSON_CONFLICT: &str = "MIX_DATABASE_JSON_CONFLICT";
pub const ERR_JSON_DESTRUCTIVE_NOT_CONFIRMED: &str = "MIX_DATABASE_JSON_DESTRUCTIVE_NOT_CONFIRMED";
pub const ERR_JSON_TARGET_REQUIRED: &str = "MIX_DATABASE_JSON_TARGET_REQUIRED";
pub const ERR_JSON_FIELD_MAPPING_INVALID: &str = "MIX_DATABASE_JSON_FIELD_MAPPING_INVALID";
pub const ERR_VIEW_KIND_INVALID: &str = "MIX_DATABASE_VIEW_KIND_INVALID";

// ─── P-DB-29B-C stale-write conflict codes ─────────────────────────────────────
//
// Each precondition check raises one of these error codes when the
// caller-supplied `expected_edit_revision` no longer matches the current
// entity revision. The client uses the stable code
// name to drive its conflict-resolution modal; the latest-state summary
// is exposed on the returned `DatabaseServiceError` so the caller can
// refresh the UI without an extra round-trip.
pub const ERR_CELL_CONFLICT: &str = "MIX_DATABASE_CELL_CONFLICT";
pub const ERR_ROW_CONFLICT: &str = "MIX_DATABASE_ROW_CONFLICT";
pub const ERR_FIELD_CONFLICT: &str = "MIX_DATABASE_FIELD_CONFLICT";
pub const ERR_VIEW_CONFLICT: &str = "MIX_DATABASE_VIEW_CONFLICT";
pub const ERR_VIEW_REQUIRED: &str = "MIX_DATABASE_VIEW_REQUIRED";
pub const ERR_BULK_CONFLICT: &str = "MIX_DATABASE_BULK_CONFLICT";
pub const ERR_VIEW_DATE_FIELD_REQUIRED: &str = "MIX_DATABASE_VIEW_DATE_FIELD_REQUIRED";
pub const ERR_VIEW_COVER_FIELD_INVALID: &str = "MIX_DATABASE_VIEW_COVER_FIELD_INVALID";
pub const ERR_VIEW_CONFIG_INVALID: &str = "MIX_DATABASE_VIEW_CONFIG_INVALID";
pub const ERR_RELATION_TARGET_DATABASE_INVALID: &str = "MIX_DATABASE_RELATION_TARGET_DATABASE_INVALID";
pub const ERR_RELATION_TARGET_ROW_INVALID: &str = "MIX_DATABASE_RELATION_TARGET_ROW_INVALID";
pub const ERR_RELATION_TARGET_FORBIDDEN: &str = "MIX_DATABASE_RELATION_TARGET_FORBIDDEN";
pub const ERR_RELATION_RECIPROCAL_INVALID: &str = "MIX_DATABASE_RELATION_RECIPROCAL_INVALID";
pub const ERR_RELATION_LIMIT_EXCEEDED: &str = "MIX_DATABASE_RELATION_LIMIT_EXCEEDED";
pub const ERR_ROLLUP_CONFIG_INVALID: &str = "MIX_DATABASE_ROLLUP_CONFIG_INVALID";
pub const ERR_ROLLUP_SOURCE_RELATION_INVALID: &str = "MIX_DATABASE_ROLLUP_SOURCE_RELATION_INVALID";
pub const ERR_ROLLUP_TARGET_FIELD_INVALID: &str = "MIX_DATABASE_ROLLUP_TARGET_FIELD_INVALID";
pub const ERR_ROLLUP_AGGREGATE_INVALID: &str = "MIX_DATABASE_ROLLUP_AGGREGATE_INVALID";
pub const ERR_ROLLUP_WRITE_FORBIDDEN: &str = "MIX_DATABASE_ROLLUP_WRITE_FORBIDDEN";
pub const ERR_ROLLUP_RECOMPUTE_FAILED: &str = "MIX_DATABASE_ROLLUP_RECOMPUTE_FAILED";
pub const ERR_FORMULA_PARSE_FAILED: &str = "MIX_DATABASE_FORMULA_PARSE_FAILED";
pub const ERR_FORMULA_TYPE_INVALID: &str = "MIX_DATABASE_FORMULA_TYPE_INVALID";
pub const ERR_FORMULA_DEPENDENCY_INVALID: &str = "MIX_DATABASE_FORMULA_DEPENDENCY_INVALID";
pub const ERR_FORMULA_EVAL_LIMIT_EXCEEDED: &str = "MIX_DATABASE_FORMULA_EVAL_LIMIT_EXCEEDED";
pub const ERR_FORMULA_WRITE_FORBIDDEN: &str = "MIX_DATABASE_FORMULA_WRITE_FORBIDDEN";
pub const ERR_FORMULA_RECOMPUTE_FAILED: &str = "MIX_DATABASE_FORMULA_RECOMPUTE_FAILED";
pub const ERR_ROW_TEMPLATE_NOT_FOUND: &str = "MIX_DATABASE_ROW_TEMPLATE_NOT_FOUND";
pub const ERR_ROW_TEMPLATE_FORBIDDEN: &str = "MIX_DATABASE_ROW_TEMPLATE_FORBIDDEN";
pub const ERR_ROW_TEMPLATE_TEMPLATE_INVALID: &str = "MIX_DATABASE_ROW_TEMPLATE_TEMPLATE_INVALID";
pub const ERR_ROW_TEMPLATE_RECONCILE_REQUIRED: &str = "MIX_DATABASE_ROW_TEMPLATE_RECONCILE_REQUIRED";
pub const ERR_ROW_TEMPLATE_CELL_VALUE_INVALID: &str = "MIX_DATABASE_ROW_TEMPLATE_CELL_VALUE_INVALID";
pub const ERR_ROW_TEMPLATE_APPLY_FAILED: &str = "MIX_DATABASE_ROW_TEMPLATE_APPLY_FAILED";
pub const ERR_TEMPLATE_INVALID: &str = "MIX_DATABASE_TEMPLATE_INVALID";
pub const ERR_URL_INVALID: &str = "MIX_DATABASE_URL_INVALID";
pub const ERR_EMAIL_INVALID: &str = "MIX_DATABASE_EMAIL_INVALID";
pub const ERR_PHONE_INVALID: &str = "MIX_DATABASE_PHONE_INVALID";
pub const ERR_CELL_VALUE_READONLY: &str = "MIX_DATABASE_CELL_VALUE_READONLY";
pub const ERR_PERCENT_RANGE_INVALID: &str = "MIX_DATABASE_PERCENT_RANGE_INVALID";
pub const ERR_CURRENCY_INVALID: &str = "MIX_DATABASE_CURRENCY_INVALID";
pub const ERR_DURATION_INVALID: &str = "MIX_DATABASE_DURATION_INVALID";
pub const ERR_DATE_TIME_INVALID: &str = "MIX_DATABASE_DATE_TIME_INVALID";
pub const ERR_REMINDER_DISABLED: &str = "MIX_DATABASE_REMINDER_DISABLED";
pub const ERR_REMINDER_INVALID: &str = "MIX_DATABASE_REMINDER_INVALID";
pub const ERR_REMINDER_LIMIT: &str = "MIX_DATABASE_REMINDER_LIMIT";
pub const ERR_REMINDER_PAST: &str = "MIX_DATABASE_REMINDER_PAST";
pub const ERR_REMINDER_NOT_FOUND: &str = "MIX_DATABASE_REMINDER_NOT_FOUND";
pub const ERR_FILES_INVALID: &str = "MIX_DATABASE_FILES_INVALID";
pub const ERR_RICH_TEXT_INVALID: &str = "MIX_DATABASE_RICH_TEXT_INVALID";
// P-DB-29: Notion-specific error codes. These are surfaced in
// `previewDatabaseNotionImport` / `importDatabaseNotion` results so the
// Web UI can label Notion import diagnostics distinctly from CSV/JSON
// import diagnostics.
pub const ERR_NOTION_ZIP_INVALID: &str = "MIX_DATABASE_NOTION_ZIP_PARSE_FAILED";
pub const ERR_NOTION_HTML_INVALID: &str = "MIX_DATABASE_NOTION_HTML_INVALID";
pub const ERR_NOTION_NO_DATABASES: &str = "MIX_DATABASE_NOTION_NO_DATABASES";
pub const ERR_NOTION_TOO_LARGE: &str = "MIX_DATABASE_NOTION_TOO_LARGE";
pub const ERR_NOTION_BODY_APPLY_FAILED: &str = "MIX_DATABASE_NOTION_BODY_APPLY_FAILED";
pub const DATABASE_QUEUE: &str = "database";
pub const JOB_RECOMPUTE_ROLLUPS: &str = "database.recomputeRollups";
pub const JOB_RECOMPUTE_FORMULAS: &str = "database.recomputeFormulas";
pub const JOB_RECOMPUTE_STALE_PROJECTIONS: &str = "database.recomputeStaleProjections";
/// P-DB-25: refresh the FTS row for a single database row. Issued after
/// every mutating operation so the search index stays within the 10
/// second freshness target without re-scanning the whole database.
pub const JOB_INDEX_ROW: &str = "database.indexRow";
/// P-DB-25: refresh every FTS row for a single database. Issued when
/// a database is created, when the schema changes, or when an operator
/// triggers a manual reindex from the UI.
pub const JOB_REINDEX_SEARCH: &str = "database.reindexSearch";
/// P-DB-25: bulk CSV import job used when `count > sync_threshold`.
pub const JOB_BULK_IMPORT: &str = "database.bulkImport";
/// P-DB-25: bulk CSV/JSON export job used when `count > sync_threshold`.
pub const JOB_BULK_EXPORT: &str = "database.bulkExport";

#[derive(Debug, Clone)]
pub struct DatabaseLimits {
  pub max_fields_per_database: usize,
  pub max_views_per_database: usize,
  /// P-DB-25: default page size for cursor-paginated row queries. The
  /// Web client requests this when the caller does not pin a value; the
  /// hard cap is `max_rows_per_page`.
  pub default_rows_per_page: i64,
  /// P-DB-25: hard cap for cursor-paginated row queries. Defaults to
  /// 500 rows per page so the Table view stays usable for the documented
  /// 10,000-row interactive target.
  pub max_rows_per_page: i64,
  pub max_cell_text_bytes: usize,
  pub max_rich_text_document_bytes: usize,
  pub max_rich_text_depth: usize,
  pub max_rich_text_nodes: usize,
  pub max_rich_text_link_bytes: usize,
  pub csv_max_bytes: usize,
  pub csv_max_rows: usize,
  pub csv_max_columns: usize,
  pub csv_sample_rows_for_type_inference: usize,
  /// P-DB-29: hard cap on the cumulative bytes we will read out of a
  /// Notion export ZIP. The neutral parser enforces the same ceiling
  /// internally; this value is the public limit surfaced to the API.
  pub notion_max_bytes: usize,
  pub max_reminders_per_user_per_cell: usize,
  pub max_reminder_offset_minutes: i64,
}

impl Default for DatabaseLimits {
  fn default() -> Self {
    Self {
      max_fields_per_database: 100,
      max_views_per_database: 25,
      default_rows_per_page: 100,
      max_rows_per_page: 500,
      max_cell_text_bytes: 16_384,
      max_rich_text_document_bytes: 65_536,
      max_rich_text_depth: 8,
      max_rich_text_nodes: 2_048,
      max_rich_text_link_bytes: 2_048,
      csv_max_bytes: 5_242_880,
      csv_max_rows: 10_000,
      csv_max_columns: 100,
      csv_sample_rows_for_type_inference: 100,
      // P-DB-29: 64 MiB matches the parser-internal cap (8 MiB per
      // HTML page × a realistic 8 pages per archive) while staying
      // safely below the standard request size limit.
      notion_max_bytes: 67_108_864,
      max_reminders_per_user_per_cell: 5,
      max_reminder_offset_minutes: 525_600,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitialDatabaseViewKind {
  Table,
  Kanban,
}

impl From<InitialDatabaseViewKind> for DatabaseViewKind {
  fn from(kind: InitialDatabaseViewKind) -> Self {
    match kind {
      InitialDatabaseViewKind::Table => DatabaseViewKind::Table,
      InitialDatabaseViewKind::Kanban => DatabaseViewKind::Kanban,
    }
  }
}

pub use myoxus_domain::database::DatabaseProjectOptionPreset;

#[derive(Debug, Clone)]
pub struct CreateDatabaseProject {
  pub workspace_id: WorkspaceId,
  pub title: String,
  pub description: Option<String>,
  pub priority_preset: DatabaseProjectOptionPreset,
  pub complexity_preset: DatabaseProjectOptionPreset,
  pub structure_preset: DatabaseProjectStructurePreset,
  pub default_currency: String,
}

#[derive(Debug, Clone)]
pub struct CreateDatabaseFromTemplate {
  pub workspace_id: WorkspaceId,
  pub template_id: String,
  pub title: String,
  pub description: Option<String>,
  pub include_sample_rows: bool,
  pub priority_preset: DatabaseProjectOptionPreset,
  pub complexity_preset: DatabaseProjectOptionPreset,
  pub structure_preset: DatabaseProjectStructurePreset,
  pub default_currency: String,
}

#[derive(Debug, Clone)]
pub struct DatabaseRowsPage {
  pub rows: Vec<DatabaseRowRead>,
  pub total_count: i64,
  pub end_cursor: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DatabaseEffectiveViewState {
  pub view_id: DatabaseViewId,
  pub saved_sort: Vec<DatabaseSortRule>,
  pub saved_filter_tree: Option<DatabaseFilterGroup>,
  pub personal_state: Option<DatabaseViewUserState>,
  pub effective_sort: Vec<DatabaseSortRule>,
  pub effective_filter_tree: Option<DatabaseFilterGroup>,
  pub search_text: String,
  pub effective_field_widths: BTreeMap<DatabaseFieldId, i32>,
  pub can_edit_shared: bool,
  /// Permission to mutate live Rows; shared View configuration is separate.
  pub can_edit_rows: bool,
}

#[derive(Debug, Clone)]
/// Server-owned grouped row count for one saved view axis.
///
/// The Web client must treat this as a read projection over the authoritative
/// view query, not as a local grouping cache. Nested `groups` represent the
/// optional saved subgroup axis.
pub struct DatabaseRowGroupSummary {
  pub key: String,
  pub label: String,
  pub row_count: i64,
  pub groups: Vec<DatabaseRowGroupSummary>,
}

#[derive(Debug, Clone)]
struct DatabaseRowGroupBucket {
  label: String,
  /// Stable ordering metadata kept internal so GraphQL only exposes the public
  /// group identity and counts.
  order: i64,
}

#[derive(Debug, Clone)]
pub struct DatabaseRowRead {
  pub row: DatabaseRow,
  pub cells: Vec<DatabaseCellValue>,
  pub cell_revisions: Vec<DatabaseCellRevision>,
  /// Membership is resolved for the requested saved View, never persisted.
  pub group_keys: Vec<String>,
  pub redacted: bool,
}

#[derive(Debug, Clone)]
pub struct DatabaseProgressGroupSummary {
  pub key: String,
  pub label: String,
  pub total_count: i64,
  pub completed_count: i64,
  pub incomplete_count: i64,
  pub blocked_count: i64,
  pub overdue_count: i64,
  pub average_progress: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct DatabaseProgressSummary {
  pub view_id: DatabaseViewId,
  pub progress_field_id: DatabaseFieldId,
  pub group_field_id: Option<DatabaseFieldId>,
  pub total_count: i64,
  pub completed_count: i64,
  pub incomplete_count: i64,
  pub blocked_count: i64,
  pub overdue_count: i64,
  pub average_progress: Option<f64>,
  pub groups: Vec<DatabaseProgressGroupSummary>,
}

#[derive(Debug, Clone)]
pub struct DatabaseRelationTargetRead {
  pub row_id: DatabaseRowId,
  pub content_document_id: Option<DocId>,
  pub title: Option<String>,
  pub redacted: bool,
  pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg(test)]
enum DatabaseRowComparableValue {
  Empty,
  Text(String),
  Number(f64),
  Bool(bool),
  DateTime(DateTime<Utc>),
  TextList(Vec<String>),
}

#[derive(Debug, Clone, Error)]
#[error("{code}: {message}")]
pub struct DatabaseServiceError {
  pub code: &'static str,
  pub message: String,
  /// P-DB-29B-C: when the error is a stale-write conflict, this carries
  /// the latest-state summary so the client can render a conflict modal
  /// without a follow-up query. `None` for non-conflict errors.
  pub latest_state: Option<serde_json::Value>,
  pub task_relation_reason: Option<DatabaseTaskRelationReason>,
  pub select_update: Option<DatabaseSelectUpdateError>,
  // Internal snapshot diagnostic context; public mutation errors keep the
  // existing Task relation code/reason regardless of the role owner.
  task_relation_role: Option<&'static str>,
  /// Internal typed marker for repository revision conflicts. This is not
  /// exposed over GraphQL; the public API receives the family-specific stable
  /// error code produced by the enrichment wrappers below.
  edit_conflict: Option<DatabaseEditConflictKind>,
  /// Internal failure category retained for worker retry policy. Public API
  /// errors continue to expose only `code`, `message`, and conflict state.
  failure_kind: DatabaseServiceFailureKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DatabaseEditConflictKind {
  Database,
  Row,
  Field,
  View,
  Cell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DatabaseServiceFailureKind {
  Domain,
  RepositoryStorage,
}

impl DatabaseServiceError {
  pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
      latest_state: None,
      task_relation_reason: None,
      select_update: None,
      task_relation_role: None,
      edit_conflict: None,
      failure_kind: DatabaseServiceFailureKind::Domain,
    }
  }

  fn repository_storage(code: &'static str, message: impl Into<String>) -> Self {
    let mut error = Self::new(code, message);
    error.failure_kind = DatabaseServiceFailureKind::RepositoryStorage;
    error
  }

  /// Whether a repository storage operation failed after the request passed
  /// domain validation. Database workers use this typed marker for retry
  /// policy; callers must not infer it from public messages.
  pub fn is_retryable_storage_failure(&self) -> bool {
    self.failure_kind == DatabaseServiceFailureKind::RepositoryStorage
  }

  /// P-DB-29B-C: attach the latest state snapshot to a stale-write conflict.
  /// Stable `code` is preserved so GraphQL clients can match the error code
  /// directly.
  fn with_latest_state(mut self, latest_state: serde_json::Value) -> Self {
    self.latest_state = Some(latest_state);
    self
  }

  fn is_edit_conflict(&self, kind: DatabaseEditConflictKind) -> bool {
    self.edit_conflict == Some(kind)
  }
}

impl From<DatabaseTaskRelationReason> for DatabaseServiceError {
  fn from(reason: DatabaseTaskRelationReason) -> Self {
    let mut error = Self::new(ERR_TASK_RELATION_INVALID, "Task relation is invalid");
    error.task_relation_reason = Some(reason);
    error
  }
}

impl From<RepositoryError> for DatabaseServiceError {
  fn from(error: RepositoryError) -> Self {
    match error {
      RepositoryError::NotFound(_) => Self::new(ERR_NOT_FOUND, "database resource not found"),
      RepositoryError::Conflict("database task capture replay") => {
        Self::new("MIX_DATABASE_TASK_CAPTURE_REPLAY", "capture receipt already exists")
      }
      RepositoryError::Conflict(message) => {
        if matches!(
          message,
          "database reminder schedule revision"
            | "task recurrence series revision"
            | "managed schema revision"
            | "managed schema source fence"
            | "managed schema structure fence"
            | "managed transition edge fence"
            | "database row template edit revision"
        ) {
          return Self::new(ERR_DATABASE_CONFLICT, message);
        }
        let edit_conflict = match message {
          "database edit revision" => Some(DatabaseEditConflictKind::Database),
          "database row edit revision" => Some(DatabaseEditConflictKind::Row),
          "database field edit revision" => Some(DatabaseEditConflictKind::Field),
          "database view edit revision" => Some(DatabaseEditConflictKind::View),
          "database cell edit revision" => Some(DatabaseEditConflictKind::Cell),
          _ => None,
        };
        let code = if edit_conflict.is_some() {
          ERR_DATABASE_CONFLICT
        } else {
          ERR_FIELD_INVALID
        };
        let mut error = Self::new(code, message);
        error.edit_conflict = edit_conflict;
        error
      }
      RepositoryError::Validation(message)
        if DatabaseSelectUpdateError::from_validation_message(&message).is_some() =>
      {
        let diagnostic =
          DatabaseSelectUpdateError::from_validation_message(&message).expect("closed Select diagnostic");
        let mut error = Self::new("MIX_DATABASE_MANAGED_UPDATE_VALUE_INVALID", diagnostic.to_string());
        error.select_update = Some(diagnostic);
        error
      }
      RepositoryError::Validation(message)
        if DatabaseTaskRelationReason::from_validation_message(&message).is_some() =>
      {
        let reason = DatabaseTaskRelationReason::from_validation_message(&message).expect("closed relation reason");
        let mut error = Self::new(ERR_TASK_RELATION_INVALID, "Task relation is invalid");
        error.task_relation_reason = Some(reason);
        error
      }
      RepositoryError::Validation(message) if message == "database reminder Task is not open" => {
        Self::new(ERR_REMINDER_INVALID, message)
      }
      RepositoryError::Validation(message) if message.starts_with("database project hierarchy invalid") => {
        Self::new(ERR_PROJECT_HIERARCHY_INVALID, message)
      }
      RepositoryError::Validation(message) if message.starts_with("database role-managed field is read-only") => {
        Self::new(ERR_CELL_VALUE_READONLY, message)
      }
      RepositoryError::Validation(message) if message.starts_with("database project task status is in use") => {
        Self::new(ERR_PROJECT_STATUS_IN_USE, message)
      }
      RepositoryError::Validation(message) if message.starts_with("database project task status value invalid") => {
        Self::new(ERR_CELL_INVALID, message)
      }
      RepositoryError::Validation(message) => Self::new(ERR_FIELD_INVALID, message),
      RepositoryError::Storage(message) => Self::repository_storage(ERR_STORAGE, format!("storage failure: {message}")),
    }
  }
}

pub type DatabaseResult<T> = Result<T, DatabaseServiceError>;

/// Deployed best-effort Generic assignment notification capability.
#[async_trait::async_trait]
pub trait DatabaseNotificationPort: Send + Sync {
  async fn notify_assignment(
    &self,
    recipient_id: UserId,
    idempotency_key: String,
    payload: serde_json::Value,
  ) -> Result<(), String>;
}

#[async_trait::async_trait]
impl DatabaseNotificationPort for NotificationService {
  async fn notify_assignment(
    &self,
    recipient_id: UserId,
    idempotency_key: String,
    payload: serde_json::Value,
  ) -> Result<(), String> {
    self
      .create_notification(
        recipient_id,
        "database.row.assigned".to_string(),
        Some("info".to_string()),
        Some(idempotency_key),
        payload,
      )
      .await
      .map(|_| ())
      .map_err(|error| error.to_string())
  }
}

#[derive(Debug, Default)]
pub struct DisabledDatabaseNotifications;

#[async_trait::async_trait]
impl DatabaseNotificationPort for DisabledDatabaseNotifications {
  async fn notify_assignment(
    &self,
    _recipient_id: UserId,
    _idempotency_key: String,
    _payload: serde_json::Value,
  ) -> Result<(), String> {
    Ok(())
  }
}

/// Immutable post-commit collaborators shared by mutating Database owners.
/// Every runtime selects concrete or disabled adapters at construction time;
/// no mutation can observe a partially wired service.
#[derive(Clone)]
pub struct DatabaseMutationEffects {
  activity: DatabaseActivityRecorder,
  audit: Arc<AuditRecorder>,
  notifications: Arc<dyn DatabaseNotificationPort>,
  change_notifications: Arc<dyn DatabaseChangeNotificationPort>,
}

impl DatabaseMutationEffects {
  pub fn new(
    activity: DatabaseActivityRecorder,
    audit: Arc<AuditRecorder>,
    notifications: Arc<dyn DatabaseNotificationPort>,
    change_notifications: Arc<dyn DatabaseChangeNotificationPort>,
  ) -> Self {
    Self {
      activity,
      audit,
      notifications,
      change_notifications,
    }
  }

  pub fn disabled() -> Self {
    Self::new(
      DatabaseActivityRecorder::noop(),
      Arc::new(AuditRecorder::noop()),
      Arc::new(DisabledDatabaseNotifications),
      Arc::new(crate::ports::database_change::NullDatabaseChangeNotification),
    )
  }

  pub fn with_change_notifications(mut self, port: Arc<dyn DatabaseChangeNotificationPort>) -> Self {
    self.change_notifications = port;
    self
  }

  pub fn activity_recorder(&self) -> DatabaseActivityRecorder {
    self.activity.clone()
  }

  pub async fn publish_database_change(&self, event: DatabaseChangeEvent) {
    if let Err(error) = self.change_notifications.publish_tasks_changed(&event).await {
      warn!(workspace_id = %event.workspace_id, database_id = %event.database_id,
        error = %error, "failed to broadcast workspace Task invalidation");
    }
    if let Err(error) = self.change_notifications.publish_change(&event).await {
      warn!(
        workspace_id = %event.workspace_id,
        database_id = %event.database_id,
        kind = ?event.kind,
        error = %error,
        "failed to broadcast database change event"
      );
    }
  }

  pub async fn emit_change(
    &self,
    workspace_id: WorkspaceId,
    database_id: DatabaseId,
    kind: DatabaseChangeKind,
    actor_user_id: UserId,
    target: DatabaseChangeTarget,
  ) {
    self
      .publish_database_change(DatabaseChangeEvent {
        workspace_id,
        database_id,
        kind,
        actor_user_id: Some(actor_user_id),
        event_id: Uuid::new_v4(),
        committed_at: Utc::now(),
        target,
      })
      .await;
  }

  pub async fn record_activity(
    &self,
    workspace_id: WorkspaceId,
    database_id: DatabaseId,
    row_id: Option<DatabaseRowId>,
    event_type: DatabaseActivityEventType,
    actor: UserId,
    payload: serde_json::Value,
  ) {
    let mut event = myoxus_domain::database_activity::DatabaseActivityEvent::new(workspace_id, database_id, event_type)
      .with_actor(actor)
      .with_payload(payload);
    if let Some(row_id) = row_id {
      event = event.with_row(row_id);
    }
    self.activity.record(event).await;
  }

  pub async fn record_audit(
    &self,
    event_key: &'static str,
    category: AuditCategory,
    target: Option<AuditTarget>,
    actor: UserId,
    old_value: Option<serde_json::Value>,
    new_value: Option<serde_json::Value>,
  ) {
    let event = AuditEvent::mutation(
      event_key,
      category,
      target,
      AuditActor::user(actor, None),
      old_value,
      new_value,
    )
    .with_metadata(serde_json::json!({ "source": "database-service" }));
    self.audit.record(event).await;
  }

  #[allow(clippy::too_many_arguments)]
  pub async fn notify_assignee(
    &self,
    recipient_id: UserId,
    workspace_id: WorkspaceId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    row_title: &str,
    field_id: DatabaseFieldId,
    field_name: &str,
  ) {
    let idempotency_key = format!("database.row.assigned:{row_id}:{recipient_id}:{field_id}");
    let payload = serde_json::json!({
      "workspaceId": workspace_id,
      "databaseId": database_id,
      "rowId": row_id,
      "rowTitle": row_title,
      "fieldId": field_id,
      "fieldName": field_name,
    });
    if let Err(error) = self
      .notifications
      .notify_assignment(recipient_id, idempotency_key, payload)
      .await
    {
      warn!(
        %error,
        %workspace_id,
        %database_id,
        %row_id,
        recipient = %recipient_id,
        "database assignee notification dispatch failed"
      );
    }
  }
}

/// Explicit availability for optional Database integrations.
///
/// Unlike a late `Option` slot, this value is selected before service
/// construction and cannot change underneath an in-flight operation.
#[derive(Clone)]
pub enum DatabaseCapability<T> {
  Enabled(T),
  Disabled,
}

impl<T> DatabaseCapability<T> {
  fn as_ref(&self) -> Option<&T> {
    match self {
      Self::Enabled(value) => Some(value),
      Self::Disabled => None,
    }
  }
}

#[derive(Clone)]
pub struct DatabaseServiceDependencies {
  effects: DatabaseMutationEffects,
  blob_service: DatabaseCapability<Arc<BlobService>>,
  template_registry: DatabaseCapability<crate::template_registry::TemplateRegistryService>,
  job_queue: DatabaseCapability<Arc<dyn DatabaseJobEnqueuer>>,
  workspace_tags: DatabaseCapability<Arc<WorkspaceTagService>>,
  page_inventory_cache: DatabaseCapability<Arc<dyn DocCachePort>>,
}

impl DatabaseServiceDependencies {
  pub fn disabled() -> Self {
    Self {
      effects: DatabaseMutationEffects::disabled(),
      blob_service: DatabaseCapability::Disabled,
      template_registry: DatabaseCapability::Disabled,
      job_queue: DatabaseCapability::Disabled,
      workspace_tags: DatabaseCapability::Disabled,
      page_inventory_cache: DatabaseCapability::Disabled,
    }
  }

  pub fn with_effects(mut self, effects: DatabaseMutationEffects) -> Self {
    self.effects = effects;
    self
  }

  pub fn with_blob_service(mut self, service: Arc<BlobService>) -> Self {
    self.blob_service = DatabaseCapability::Enabled(service);
    self
  }

  pub fn with_template_registry(mut self, service: crate::template_registry::TemplateRegistryService) -> Self {
    self.template_registry = DatabaseCapability::Enabled(service);
    self
  }

  pub fn with_job_queue(mut self, queue: Arc<dyn DatabaseJobEnqueuer>) -> Self {
    self.job_queue = DatabaseCapability::Enabled(queue);
    self
  }

  pub fn with_workspace_tags(mut self, service: Arc<WorkspaceTagService>) -> Self {
    self.workspace_tags = DatabaseCapability::Enabled(service);
    self
  }

  pub fn with_page_inventory_cache(mut self, cache: Arc<dyn DocCachePort>) -> Self {
    self.page_inventory_cache = DatabaseCapability::Enabled(cache);
    self
  }
}

pub use editing::DatabaseEditingService;

pub use views::DatabaseViewService;

/// Passive composition-root grouping for the six Database capability owners.
/// It contains no forwarding methods or business logic.
#[derive(Clone)]
pub struct DatabaseServices {
  pub definition: Arc<DatabaseDefinitionService>,
  pub editing: Arc<DatabaseEditingService>,
  pub reminders: Arc<DatabaseReminderService>,
  pub views: Arc<DatabaseViewService>,
  pub import_export: Arc<DatabaseImportExportService>,
  pub projection: Arc<DatabaseProjectionService>,
  pub effects: DatabaseMutationEffects,
}

/// P-DB-25: port for enqueueing background jobs onto the `database` queue
/// without forcing the application crate to depend on the worker crate.
/// The API process implements this trait by delegating to `RedisQueue`.
#[async_trait::async_trait]
pub trait DatabaseJobEnqueuer: Send + Sync {
  async fn enqueue(
    &self,
    queue: &str,
    job_name: &str,
    data: serde_json::Value,
    delay_ms: i64,
  ) -> Result<String, String>;
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRowReminderDispatchEnvelope {
  pub reminder_id: Uuid,
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub row_id: DatabaseRowId,
  pub field_id: DatabaseFieldId,
  pub schedule_revision: i64,
  pub trigger_at: DateTime<Utc>,
  pub user_id: UserId,
}

impl DatabaseServices {
  pub fn new<R>(
    repo: Arc<R>,
    doc_service: DocService,
    permission: Arc<PermissionService>,
    limits: DatabaseLimits,
    workspace_store: Arc<dyn WorkspaceStore>,
    starter_templates: Arc<DatabaseStarterTemplateCatalog>,
    dependencies: DatabaseServiceDependencies,
  ) -> Self
  where
    R: DatabaseDefinitionRepository
      + DatabaseEditingRepository
      + DatabaseReminderRepository
      + DatabaseViewRepository
      + DatabaseImportExportRepository
      + DatabaseProjectionRepository
      + 'static,
  {
    let schema_repo: Arc<dyn DatabaseDefinitionRepository> = repo.clone();
    let row_repo: Arc<dyn DatabaseEditingRepository> = repo.clone();
    let view_query_repo: Arc<dyn DatabaseViewRepository> = repo.clone();
    let import_export_repo: Arc<dyn DatabaseImportExportRepository> = repo.clone();
    let reminder_repo: Arc<dyn DatabaseReminderRepository> = repo.clone();
    let projection_repo: Arc<dyn DatabaseProjectionRepository> = repo;
    let mut projection = DatabaseProjectionService::new(
      schema_repo.clone(),
      row_repo.clone(),
      view_query_repo.clone(),
      projection_repo.clone(),
      limits.clone(),
    );
    projection.job_queue = dependencies.job_queue.clone();
    projection.workspace_tags = dependencies.workspace_tags.clone();
    let projection = Arc::new(projection);
    let definition = Arc::new(DatabaseDefinitionService::new(
      schema_repo.clone(),
      projection_repo.clone(),
      permission.clone(),
      limits.clone(),
      dependencies.effects.clone(),
      starter_templates.clone(),
      projection.clone(),
    ));
    let reminders = Arc::new(DatabaseReminderService {
      schema_repo: schema_repo.clone(),
      row_repo: row_repo.clone(),
      reminder_repo,
      permission: permission.clone(),
      limits: limits.clone(),
      effects: dependencies.effects.clone(),
    });
    let rows = Arc::new(DatabaseEditingService {
      reminders: reminders.clone(),
      schema_repo: schema_repo.clone(),
      row_repo: row_repo.clone(),
      doc_service: doc_service.clone(),
      workspace_store: workspace_store.clone(),
      permission: permission.clone(),
      limits: limits.clone(),
      effects: dependencies.effects.clone(),
      blob_service: dependencies.blob_service.clone(),
      workspace_tags: dependencies.workspace_tags.clone(),
      projection: projection.clone(),
    });
    let views = Arc::new(DatabaseViewService {
      schema_repo: schema_repo.clone(),
      row_repo: row_repo.clone(),
      view_query_repo: view_query_repo.clone(),
      workspace_store: workspace_store.clone(),
      permission: permission.clone(),
      limits: limits.clone(),
      effects: dependencies.effects.clone(),
      workspace_tags: dependencies.workspace_tags.clone(),
      page_inventory_cache: dependencies.page_inventory_cache.clone(),
      page_inventory_loads: Cache::builder().max_capacity(1_000).build(),
    });
    let import_export = Arc::new(DatabaseImportExportService {
      starter_templates,
      schema_repo,
      row_repo,
      view_query_repo,
      import_export_repo,
      doc_service,
      workspace_store,
      permission,
      limits,
      blob_service: dependencies.blob_service.clone(),
      template_registry: dependencies.template_registry.clone(),
      job_queue: dependencies.job_queue.clone(),
      workspace_tags: dependencies.workspace_tags.clone(),
      rows: rows.clone(),
      views: views.clone(),
      projection: projection.clone(),
    });
    Self {
      definition,
      editing: rows,
      reminders,
      views,
      import_export,
      projection,
      effects: dependencies.effects,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn test_field(database_id: DatabaseId, field_type: DatabaseFieldType, name: &str, position: i32) -> DatabaseField {
    DatabaseField {
      id: Uuid::new_v4(),
      database_id,
      name: name.to_string(),
      field_type,
      config: DatabaseFieldConfig::empty_for(field_type),
      position,
      required: field_type == DatabaseFieldType::Title,
      edit_revision: 1,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    }
  }

  fn test_row_read(
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    title: &str,
    cells: Vec<DatabaseCellValue>,
  ) -> DatabaseRowRead {
    let now = Utc::now();
    DatabaseRowRead {
      row: DatabaseRow {
        id: row_id,
        database_id,
        content_document_id: None,
        row_kind: DatabaseRowKind::Record,
        title: title.to_string(),
        position: 0,
        created_by: None,
        updated_by: None,
        edit_revision: 1,
        created_at: now,
        updated_at: now,
        deleted_at: None,
      },
      cells,
      cell_revisions: Vec::new(),
      group_keys: Vec::new(),
      redacted: false,
    }
  }

  fn test_cell(row_id: DatabaseRowId, field: &DatabaseField, value: DatabaseCellValueData) -> DatabaseCellValue {
    DatabaseCellValue {
      row_id,
      field_id: field.id,
      field_type: field.field_type,
      value,
      updated_by: None,
      edit_revision: 1,
      updated_at: Utc::now(),
    }
  }

  fn test_database_record(fields: Vec<DatabaseField>, views: Vec<DatabaseView>) -> DatabaseRecord {
    let now = Utc::now();
    let database_id = fields
      .first()
      .map(|field| field.database_id)
      .unwrap_or_else(Uuid::new_v4);
    DatabaseRecord {
      managed_schema: None,

      database: Database {
        system_role: None,
        managed_installation: None,

        id: database_id,
        workspace_id: Uuid::new_v4(),
        profile_kind: DatabaseProfileKind::Generic,
        profile_structure_preset: None,
        profile_config: serde_json::json!({}),
        title: "Test database".to_string(),
        description: None,
        created_by: None,
        updated_by: None,
        deleted_at: None,
        deleted_by: None,
        edit_revision: 1,
        created_at: now,
        updated_at: now,
      },
      fields,
      views,
      field_roles: Vec::new(),
      view_roles: Vec::new(),
      row_count: 0,
    }
  }

  #[test]
  fn conflict_codes_are_stable_strings() {
    assert_eq!(ERR_CELL_CONFLICT, "MIX_DATABASE_CELL_CONFLICT");
    assert_eq!(ERR_ROW_CONFLICT, "MIX_DATABASE_ROW_CONFLICT");
    assert_eq!(ERR_FIELD_CONFLICT, "MIX_DATABASE_FIELD_CONFLICT");
    assert_eq!(ERR_VIEW_CONFLICT, "MIX_DATABASE_VIEW_CONFLICT");
    assert_eq!(ERR_BULK_CONFLICT, "MIX_DATABASE_BULK_CONFLICT");
  }

  #[test]
  fn rejects_title_cell_values() {
    let field = DatabaseField {
      id: Uuid::new_v4(),
      database_id: Uuid::new_v4(),
      name: "Title".to_string(),
      field_type: DatabaseFieldType::Title,
      config: DatabaseFieldConfig::Title,
      position: 0,
      required: true,
      edit_revision: 1,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    };

    let err = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Text("Nope".to_string()),
      &DatabaseLimits::default(),
    )
    .expect_err("title cell values must be rejected");
    assert_eq!(err.code, ERR_CELL_INVALID);
  }

  #[test]
  fn required_cell_clear_contract_rejects_single_and_bulk_mutation_entry_points() {
    let database_id = Uuid::new_v4();
    let mut required = test_field(database_id, DatabaseFieldType::Text, "Required note", 1);
    required.required = true;
    let record = test_database_record(vec![required.clone()], Vec::new());

    let error = crate::database::editing::rules::validate_cell_clear(&record, DatabaseRowKind::Record, &required)
      .expect_err("required field values must not be clearable");
    assert_eq!(error.code, ERR_FIELD_REQUIRED);

    required.required = false;
    crate::database::editing::rules::validate_cell_clear(&record, DatabaseRowKind::Record, &required)
      .expect("optional field values remain clearable");

    let title = test_field(database_id, DatabaseFieldType::Title, "Title", 0);
    let title_error = crate::database::editing::rules::validate_cell_clear(&record, DatabaseRowKind::Record, &title)
      .expect_err("row titles remain row-owned and non-clearable");
    assert_eq!(title_error.code, ERR_CELL_INVALID);
  }

  #[test]
  fn p9i_normalizes_editable_property_cells_and_rejects_invalid_values() {
    assert_eq!(
      crate::database::editing::rules::normalize_url(" example.test/path ").expect("url"),
      "https://example.test/path"
    );
    assert_eq!(
      crate::database::editing::rules::normalize_url("http://example.test/").expect("url"),
      "http://example.test/"
    );
    assert_eq!(
      crate::database::editing::rules::normalize_email(" Owner@Example.TEST ").expect("email"),
      "Owner@example.test"
    );
    assert_eq!(
      crate::database::editing::rules::normalize_email("root@localhost").expect("local domain email"),
      "root@localhost"
    );
    assert_eq!(
      crate::database::editing::rules::normalize_phone(" +49 (30) 123-456 ").expect("phone"),
      "+49 (30) 123-456"
    );
    assert!(
      crate::database::editing::rules::normalize_editable_cell_value(
        DatabaseFieldType::Url,
        DatabaseCellValueData::Url("   ".to_string()),
        &DatabaseLimits::default(),
      )
      .expect("empty url clears")
      .is_none()
    );

    let invalid_url = crate::database::editing::rules::normalize_url("ftp://example.test")
      .expect_err("non-http URL schemes are invalid");
    assert_eq!(invalid_url.code, ERR_URL_INVALID);
    let invalid_email =
      crate::database::editing::rules::normalize_email("owner @example.test").expect_err("email whitespace is invalid");
    assert_eq!(invalid_email.code, ERR_EMAIL_INVALID);
    let invalid_phone = crate::database::editing::rules::normalize_phone("ab")
      .expect_err("phone requires enough digits and valid characters");
    assert_eq!(invalid_phone.code, ERR_PHONE_INVALID);
  }

  #[test]
  fn p9i_projection_fields_are_read_only_cell_values() {
    let database_id = Uuid::new_v4();
    let field = test_field(database_id, DatabaseFieldType::CreatedTime, "Created", 1);
    let err = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::CreatedTime(Utc::now()),
      &DatabaseLimits::default(),
    )
    .expect_err("projection fields cannot be written as cells");
    assert_eq!(err.code, ERR_CELL_VALUE_READONLY);

    let err = crate::database::editing::rules::empty_editable_cell_value(DatabaseFieldType::UpdatedBy)
      .expect_err("projection fields cannot be cleared through editable cell paths");
    assert_eq!(err.code, ERR_CELL_VALUE_READONLY);
  }

  #[test]
  fn percent_field_config_and_cells_validate_finite_range() {
    let database_id = Uuid::new_v4();
    let mut field = test_field(database_id, DatabaseFieldType::Percent, "Progress", 1);
    field.config = DatabaseFieldConfig::Percent(DatabasePercentFieldConfig {
      min_value: Some(0.0),
      max_value: Some(100.0),
    });

    crate::database::definition::rules::validate_field_config(field.field_type, &field.config)
      .expect("valid percent range");
    crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Percent(42.5),
      &DatabaseLimits::default(),
    )
    .expect("valid percent cell");

    let too_large = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Percent(101.0),
      &DatabaseLimits::default(),
    )
    .expect_err("progress percent must respect max range");
    assert_eq!(too_large.code, ERR_PERCENT_RANGE_INVALID);

    let not_finite = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Percent(f64::NAN),
      &DatabaseLimits::default(),
    )
    .expect_err("percent cells must be finite");
    assert_eq!(not_finite.code, ERR_CELL_INVALID);

    let invalid_config = DatabaseFieldConfig::Percent(DatabasePercentFieldConfig {
      min_value: Some(100.0),
      max_value: Some(0.0),
    });
    let invalid_range =
      crate::database::definition::rules::validate_field_config(DatabaseFieldType::Percent, &invalid_config)
        .expect_err("percent ranges cannot be inverted");
    assert_eq!(invalid_range.code, ERR_PERCENT_RANGE_INVALID);
  }

  #[test]
  fn percent_values_are_numeric_for_rollups_and_csv_units() {
    let targets = vec![
      rollup_target(Some(DatabaseCellValueData::Percent(25.0))),
      rollup_target(Some(DatabaseCellValueData::Percent(75.0))),
    ];
    let average =
      DatabaseProjectionService::compute_rollup_value(&rollup_config(DatabaseRollupAggregate::Average, None), &targets)
        .expect("percent average rollup");
    assert_eq!(average, Some(DatabaseRollupScalarValue::Number(50.0)));

    assert_eq!(
      DatabaseImportExportService::parse_csv_percent_value("42%").expect("percent suffix"),
      42.0
    );
    assert_eq!(
      DatabaseImportExportService::parse_csv_percent_value("0.42").expect("percent points"),
      0.42
    );
    assert_eq!(
      DatabaseImportExportService::csv_value_to_string(
        &DatabaseCellValueData::Percent(42.0),
        DatabaseFieldType::Percent,
        DatabaseCsvLocaleMode::Machine,
        None,
      ),
      "42%"
    );
  }

  #[test]
  fn currency_field_config_and_cells_validate_iso_currency_and_range() {
    let database_id = Uuid::new_v4();
    let mut field = test_field(database_id, DatabaseFieldType::Currency, "Cost", 1);
    field.config = DatabaseFieldConfig::Currency(DatabaseCurrencyFieldConfig {
      default_currency: "EUR".to_string(),
      allow_currency_override: false,
      min_value: Some(0.0),
      max_value: Some(1_000.0),
    });

    crate::database::definition::rules::validate_field_config(field.field_type, &field.config)
      .expect("valid currency field config");
    crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Currency(DatabaseCurrencyValue {
        amount: 42.5,
        currency_code: "EUR".to_string(),
      }),
      &DatabaseLimits::default(),
    )
    .expect("valid currency cell");

    let wrong_currency = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Currency(DatabaseCurrencyValue {
        amount: 42.5,
        currency_code: "USD".to_string(),
      }),
      &DatabaseLimits::default(),
    )
    .expect_err("field without override must reject different currencies");
    assert_eq!(wrong_currency.code, ERR_CURRENCY_INVALID);

    let invalid_config = DatabaseFieldConfig::Currency(DatabaseCurrencyFieldConfig {
      default_currency: "ZZZ".to_string(),
      allow_currency_override: false,
      min_value: None,
      max_value: None,
    });
    let err = crate::database::definition::rules::validate_field_config(DatabaseFieldType::Currency, &invalid_config)
      .expect_err("invalid ISO code must be rejected");
    assert_eq!(err.code, ERR_CURRENCY_INVALID);
  }

  #[test]
  fn currency_rollups_preserve_currency_and_reject_mixed_currency() {
    let eur_targets = vec![
      rollup_target(Some(DatabaseCellValueData::Currency(DatabaseCurrencyValue {
        amount: 25.0,
        currency_code: "EUR".to_string(),
      }))),
      rollup_target(Some(DatabaseCellValueData::Currency(DatabaseCurrencyValue {
        amount: 75.0,
        currency_code: "EUR".to_string(),
      }))),
    ];
    let value =
      DatabaseProjectionService::compute_rollup_value(&rollup_config(DatabaseRollupAggregate::Sum, None), &eur_targets)
        .expect("currency sum rollup");
    assert_eq!(
      value,
      Some(DatabaseRollupScalarValue::Currency(DatabaseCurrencyValue {
        amount: 100.0,
        currency_code: "EUR".to_string(),
      }))
    );

    let mixed_targets = vec![
      rollup_target(Some(DatabaseCellValueData::Currency(DatabaseCurrencyValue {
        amount: 25.0,
        currency_code: "EUR".to_string(),
      }))),
      rollup_target(Some(DatabaseCellValueData::Currency(DatabaseCurrencyValue {
        amount: 75.0,
        currency_code: "USD".to_string(),
      }))),
    ];
    let err = DatabaseProjectionService::compute_rollup_value(
      &rollup_config(DatabaseRollupAggregate::Sum, None),
      &mixed_targets,
    )
    .expect_err("mixed currency rollup must not silently compute");
    assert_eq!(err.code, ERR_ROLLUP_RECOMPUTE_FAILED);

    let parsed = DatabaseImportExportService::parse_csv_currency_value("123.45 GBP", "EUR").expect("currency suffix");
    assert_eq!(
      parsed,
      DatabaseCurrencyValue {
        amount: 123.45,
        currency_code: "GBP".to_string(),
      }
    );
    assert_eq!(
      DatabaseImportExportService::csv_value_to_string(
        &DatabaseCellValueData::Currency(DatabaseCurrencyValue {
          amount: 42.0,
          currency_code: "EUR".to_string(),
        }),
        DatabaseFieldType::Currency,
        DatabaseCsvLocaleMode::Machine,
        None,
      ),
      "42 EUR"
    );
  }

  #[test]
  fn duration_field_config_and_cells_validate_canonical_minutes() {
    let database_id = Uuid::new_v4();
    let mut field = test_field(database_id, DatabaseFieldType::Duration, "Effort", 1);
    field.config = DatabaseFieldConfig::Duration(DatabaseDurationFieldConfig {
      display_unit: DatabaseDurationDisplayUnit::Hours,
      min_minutes: Some(30),
      max_minutes: Some(8 * 60),
    });

    crate::database::definition::rules::validate_field_config(field.field_type, &field.config)
      .expect("valid duration field config");
    crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Duration(DatabaseDurationValue { minutes: 90 }),
      &DatabaseLimits::default(),
    )
    .expect("valid duration cell");

    let too_small = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Duration(DatabaseDurationValue { minutes: 15 }),
      &DatabaseLimits::default(),
    )
    .expect_err("duration cells must respect min range");
    assert_eq!(too_small.code, ERR_DURATION_INVALID);

    let invalid_config = DatabaseFieldConfig::Duration(DatabaseDurationFieldConfig {
      display_unit: DatabaseDurationDisplayUnit::Minutes,
      min_minutes: Some(60),
      max_minutes: Some(30),
    });
    let err = crate::database::definition::rules::validate_field_config(DatabaseFieldType::Duration, &invalid_config)
      .expect_err("duration ranges cannot be inverted");
    assert_eq!(err.code, ERR_DURATION_INVALID);
  }

  #[test]
  fn duration_rollups_preserve_duration_and_reject_mixed_numeric_kinds() {
    let targets = vec![
      rollup_target(Some(DatabaseCellValueData::Duration(DatabaseDurationValue {
        minutes: 30,
      }))),
      rollup_target(Some(DatabaseCellValueData::Duration(DatabaseDurationValue {
        minutes: 90,
      }))),
    ];
    let sum =
      DatabaseProjectionService::compute_rollup_value(&rollup_config(DatabaseRollupAggregate::Sum, None), &targets)
        .expect("duration sum rollup");
    assert_eq!(
      sum,
      Some(DatabaseRollupScalarValue::Duration(DatabaseDurationValue {
        minutes: 120
      }))
    );

    let average =
      DatabaseProjectionService::compute_rollup_value(&rollup_config(DatabaseRollupAggregate::Average, None), &targets)
        .expect("duration average rollup");
    assert_eq!(
      average,
      Some(DatabaseRollupScalarValue::Duration(DatabaseDurationValue {
        minutes: 60
      }))
    );

    let mixed_targets = vec![
      rollup_target(Some(DatabaseCellValueData::Duration(DatabaseDurationValue {
        minutes: 30,
      }))),
      rollup_target(Some(DatabaseCellValueData::Number(2.0))),
    ];
    let err = DatabaseProjectionService::compute_rollup_value(
      &rollup_config(DatabaseRollupAggregate::Sum, None),
      &mixed_targets,
    )
    .expect_err("duration rollups must not silently mix numeric kinds");
    assert_eq!(err.code, ERR_ROLLUP_RECOMPUTE_FAILED);
  }

  #[test]
  fn duration_csv_values_roundtrip_with_common_units() {
    assert_eq!(
      DatabaseImportExportService::parse_csv_duration_value("90 min").expect("minute suffix"),
      DatabaseDurationValue { minutes: 90 }
    );
    assert_eq!(
      DatabaseImportExportService::parse_csv_duration_value("2h").expect("hour suffix"),
      DatabaseDurationValue { minutes: 120 }
    );
    assert_eq!(
      DatabaseImportExportService::parse_csv_duration_value("1.5 days").expect("day suffix"),
      DatabaseDurationValue { minutes: 2160 }
    );
    assert_eq!(
      DatabaseImportExportService::csv_value_to_string(
        &DatabaseCellValueData::Duration(DatabaseDurationValue { minutes: 45 }),
        DatabaseFieldType::Duration,
        DatabaseCsvLocaleMode::Machine,
        None,
      ),
      "45 min"
    );
  }

  #[test]
  fn users_field_config_and_cells_enforce_count_and_uniqueness() {
    let database_id = Uuid::new_v4();
    let mut field = test_field(database_id, DatabaseFieldType::Users, "Assignees", 1);
    field.config = DatabaseFieldConfig::Users(DatabaseUsersFieldConfig {
      min_count: Some(1),
      max_count: Some(2),
    });
    let alice = Uuid::new_v4();
    let bobby = Uuid::new_v4();

    crate::database::definition::rules::validate_field_config(field.field_type, &field.config)
      .expect("valid users field config");
    crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Users(vec![alice, bobby]),
      &DatabaseLimits::default(),
    )
    .expect("valid ordered unique users cell");

    let duplicate = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Users(vec![alice, alice]),
      &DatabaseLimits::default(),
    )
    .expect_err("duplicate user ids must be rejected");
    assert_eq!(duplicate.code, ERR_CELL_INVALID);

    let empty = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Users(Vec::new()),
      &DatabaseLimits::default(),
    )
    .expect_err("empty users cell violates min_count");
    assert_eq!(empty.code, ERR_CELL_INVALID);

    let too_many = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Users(vec![alice, bobby, Uuid::new_v4()]),
      &DatabaseLimits::default(),
    )
    .expect_err("users cell violates max_count");
    assert_eq!(too_many.code, ERR_CELL_INVALID);

    let invalid_config = DatabaseFieldConfig::Users(DatabaseUsersFieldConfig {
      min_count: Some(3),
      max_count: Some(2),
    });
    let err = crate::database::definition::rules::validate_field_config(DatabaseFieldType::Users, &invalid_config)
      .expect_err("users count range cannot be inverted");
    assert_eq!(err.code, ERR_CELL_INVALID);
  }

  #[test]
  fn status_field_config_requires_semantic_groups_and_valid_default() {
    let database_id = Uuid::new_v4();
    let mut field = test_field(database_id, DatabaseFieldType::Status, "Status", 1);
    field.config = DatabaseFieldConfig::Status(default_database_status_field_config());

    crate::database::definition::rules::validate_field_config(field.field_type, &field.config)
      .expect("valid status field config");
    crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Status("status.in_progress".to_string()),
      &DatabaseLimits::default(),
    )
    .expect("valid status cell");

    let missing_option = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Status("status.unknown".to_string()),
      &DatabaseLimits::default(),
    )
    .expect_err("status cell must reference a configured status option");
    assert_eq!(missing_option.code, ERR_CELL_INVALID);

    let mut missing_group = default_database_status_field_config();
    missing_group
      .options
      .retain(|option| option.group != DatabaseStatusGroup::Complete);
    let missing_group = crate::database::definition::rules::validate_field_config(
      DatabaseFieldType::Status,
      &DatabaseFieldConfig::Status(missing_group),
    )
    .expect_err("status fields must keep the required lifecycle groups");
    assert_eq!(missing_group.code, ERR_FIELD_INVALID);

    let mut invalid_default = default_database_status_field_config();
    invalid_default.default_option_id = "status.missing".to_string();
    let invalid_default = crate::database::definition::rules::validate_field_config(
      DatabaseFieldType::Status,
      &DatabaseFieldConfig::Status(invalid_default),
    )
    .expect_err("status default option must be configured");
    assert_eq!(invalid_default.code, ERR_FIELD_INVALID);

    let mut used_ids = BTreeSet::new();
    assert_eq!(
      DatabaseImportExportService::csv_status_option_id("In progress", &mut used_ids),
      "status.csv.in_progress"
    );
    assert_eq!(
      DatabaseImportExportService::csv_status_option_id("In-progress", &mut used_ids),
      "status.csv.in_progress_2",
      "CSV-derived Status ids must be stable and collision-safe instead of reusing labels"
    );
  }

  #[test]
  fn unique_id_field_config_is_validated_and_cells_are_server_generated_only() {
    let database_id = Uuid::new_v4();
    let mut field = test_field(database_id, DatabaseFieldType::UniqueId, "Public ID", 1);
    field.config = DatabaseFieldConfig::UniqueId(DatabaseUniqueIdFieldConfig {
      prefix: "TASK-".to_string(),
      start_number: 7,
      padding: 3,
    });

    crate::database::definition::rules::validate_field_config(field.field_type, &field.config)
      .expect("valid UniqueId config");
    assert_eq!(format_database_unique_id("TASK-", 7, 3), "TASK-007");

    let manual = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::UniqueId(DatabaseUniqueIdValue {
        prefix: "TASK-".to_string(),
        sequence: 7,
        display: "TASK-007".to_string(),
      }),
      &DatabaseLimits::default(),
    )
    .expect_err("UniqueId cells are generated by the repository, not by clients");
    assert_eq!(manual.code, ERR_CELL_VALUE_READONLY);

    let invalid_start = crate::database::definition::rules::validate_field_config(
      DatabaseFieldType::UniqueId,
      &DatabaseFieldConfig::UniqueId(DatabaseUniqueIdFieldConfig {
        prefix: "TASK-".to_string(),
        start_number: 0,
        padding: 3,
      }),
    )
    .expect_err("UniqueId start number must be positive");
    assert_eq!(invalid_start.code, ERR_FIELD_INVALID);

    let invalid_prefix = crate::database::definition::rules::validate_field_config(
      DatabaseFieldType::UniqueId,
      &DatabaseFieldConfig::UniqueId(DatabaseUniqueIdFieldConfig {
        prefix: "Task ".to_string(),
        start_number: 1,
        padding: 3,
      }),
    )
    .expect_err("UniqueId prefixes must stay stable and URL-safe");
    assert_eq!(invalid_prefix.code, ERR_FIELD_INVALID);
  }

  #[test]
  fn date_time_field_config_and_cells_validate_time_zone_and_range() {
    let database_id = Uuid::new_v4();
    let mut field = test_field(database_id, DatabaseFieldType::DateTime, "Starts at", 1);
    field.config = DatabaseFieldConfig::DateTime(DatabaseDateTimeFieldConfig {
      default_time_zone: Some("Europe/Berlin".to_string()),
      allow_reminders: true,
    });
    let start = DateTime::parse_from_rfc3339("2026-07-06T09:00:00Z")
      .expect("valid start")
      .with_timezone(&Utc);
    let end = DateTime::parse_from_rfc3339("2026-07-06T10:00:00Z")
      .expect("valid end")
      .with_timezone(&Utc);

    crate::database::definition::rules::validate_field_config(field.field_type, &field.config)
      .expect("valid DateTime config");
    crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
        start,
        end: Some(end),
        all_day: false,
        time_zone: "Europe/Berlin".to_string(),
      }),
      &DatabaseLimits::default(),
    )
    .expect("valid DateTime cell");

    let invalid_zone = crate::database::definition::rules::validate_field_config(
      DatabaseFieldType::DateTime,
      &DatabaseFieldConfig::DateTime(DatabaseDateTimeFieldConfig {
        default_time_zone: Some("Mars/Olympus".to_string()),
        allow_reminders: false,
      }),
    )
    .expect_err("invalid IANA zone must be rejected");
    assert_eq!(invalid_zone.code, ERR_DATE_TIME_INVALID);

    let inverted = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
        start: end,
        end: Some(start),
        all_day: false,
        time_zone: "Europe/Berlin".to_string(),
      }),
      &DatabaseLimits::default(),
    )
    .expect_err("DateTime ranges cannot end before they start");
    assert_eq!(inverted.code, ERR_DATE_TIME_INVALID);
  }

  #[test]
  fn database_row_reminder_trigger_preserves_timed_and_all_day_semantics() {
    let at = |value: &str| DateTime::parse_from_rfc3339(value).unwrap().with_timezone(&Utc);
    let timed = DatabaseDateTimeValue {
      start: at("2026-07-06T09:00:00Z"),
      end: None,
      all_day: false,
      time_zone: "Europe/Berlin".to_string(),
    };
    assert_eq!(
      DatabaseReminderService::database_row_reminder_trigger_at(&timed, 15).unwrap(),
      at("2026-07-06T08:45:00Z")
    );

    let all_day = DatabaseDateTimeValue {
      start: at("2026-07-06T00:00:00Z"),
      end: None,
      all_day: true,
      time_zone: "Europe/Berlin".to_string(),
    };
    assert_eq!(
      DatabaseReminderService::database_row_reminder_trigger_at(&all_day, 60).unwrap(),
      at("2026-07-06T06:00:00Z"),
      "all-day offset is based on 09:00 Europe/Berlin, not UTC midnight"
    );

    let invalid = DatabaseReminderService::database_row_reminder_trigger_at(&timed, -1).unwrap_err();
    assert_eq!(invalid.code, ERR_REMINDER_INVALID);

    let skipped_date = database_row_reminder_all_day_baseline(
      NaiveDate::from_ymd_opt(2011, 12, 30).unwrap(),
      "Pacific/Apia".parse().unwrap(),
    )
    .expect_err("an all-day reminder must reject a skipped local calendar date");
    assert_eq!(
      skipped_date,
      "database reminder local trigger is ambiguous or nonexistent"
    );
  }

  #[test]
  fn files_field_config_and_cells_validate_blob_reference_shape() {
    let database_id = Uuid::new_v4();
    let mut field = test_field(database_id, DatabaseFieldType::Files, "Attachments", 1);
    field.config = DatabaseFieldConfig::Files(DatabaseFilesFieldConfig {
      allowed_mime_categories: vec![DatabaseFileMimeCategory::Image],
      max_item_count: Some(2),
      max_item_size: Some(1024),
      preview_policy: DatabaseFilesPreviewPolicy::Auto,
    });

    crate::database::definition::rules::validate_field_config(field.field_type, &field.config)
      .expect("valid Files config");
    crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Files(DatabaseFilesValue {
        files: vec![
          DatabaseFileReference {
            blob_key: "blob-a".to_string(),
            name: Some("cover.png".to_string()),
            mime: Some("image/png".to_string()),
            size: Some(512),
            caption: Some("Cover".to_string()),
            cover: true,
          },
          DatabaseFileReference {
            blob_key: "blob-b".to_string(),
            name: None,
            mime: None,
            size: None,
            caption: None,
            cover: false,
          },
        ],
      }),
      &DatabaseLimits::default(),
    )
    .expect("valid Files cell shape");

    let duplicate_blob = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Files(DatabaseFilesValue {
        files: vec![
          DatabaseFileReference {
            blob_key: "blob-a".to_string(),
            name: None,
            mime: None,
            size: None,
            caption: None,
            cover: false,
          },
          DatabaseFileReference {
            blob_key: "blob-a".to_string(),
            name: None,
            mime: None,
            size: None,
            caption: None,
            cover: false,
          },
        ],
      }),
      &DatabaseLimits::default(),
    )
    .expect_err("Files cells must not duplicate blob references");
    assert_eq!(duplicate_blob.code, ERR_FILES_INVALID);

    let too_many = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Files(DatabaseFilesValue {
        files: vec![
          DatabaseFileReference {
            blob_key: "blob-a".to_string(),
            name: None,
            mime: None,
            size: None,
            caption: None,
            cover: false,
          },
          DatabaseFileReference {
            blob_key: "blob-b".to_string(),
            name: None,
            mime: None,
            size: None,
            caption: None,
            cover: false,
          },
          DatabaseFileReference {
            blob_key: "blob-c".to_string(),
            name: None,
            mime: None,
            size: None,
            caption: None,
            cover: false,
          },
        ],
      }),
      &DatabaseLimits::default(),
    )
    .expect_err("Files cells must honor max_item_count before storage lookup");
    assert_eq!(too_many.code, ERR_FILES_INVALID);

    let invalid_config = crate::database::definition::rules::validate_field_config(
      DatabaseFieldType::Files,
      &DatabaseFieldConfig::Files(DatabaseFilesFieldConfig {
        allowed_mime_categories: vec![DatabaseFileMimeCategory::Any, DatabaseFileMimeCategory::Image],
        max_item_count: Some(0),
        max_item_size: Some(1024),
        preview_policy: DatabaseFilesPreviewPolicy::Auto,
      }),
    )
    .expect_err("Files config cannot mix Any with narrower categories");
    assert_eq!(invalid_config.code, ERR_FILES_INVALID);
  }

  #[test]
  fn rich_text_normalizes_supported_marks_links_and_projection() {
    let database_id = Uuid::new_v4();
    let mut field = test_field(database_id, DatabaseFieldType::RichText, "Description", 1);
    field.config = DatabaseFieldConfig::RichText(DatabaseRichTextFieldConfig {
      max_plain_text_bytes: Some(64),
    });

    crate::database::definition::rules::validate_field_config(field.field_type, &field.config)
      .expect("valid RichText config");
    let value = crate::database::editing::rules::rich_text_value_from_document(
      serde_json::json!({
        "type": "doc",
        "content": [{
          "type": "paragraph",
          "content": [
            { "type": "text", "text": "Bold", "marks": [{ "type": "bold" }] },
            { "type": "hardBreak" },
            { "type": "text", "text": "linked", "marks": [
              { "type": "italic" },
              { "type": "strike" },
              { "type": "code" },
              { "type": "link", "attrs": { "href": "https://example.test" } }
            ] }
          ]
        }]
      }),
      &DatabaseLimits::default(),
    )
    .expect("supported canonical RichText document");
    assert_eq!(value.plain_text, "Bold\nlinked");
    assert_eq!(
      value.document["content"][0]["content"][2]["marks"][3]["attrs"]["href"],
      "https://example.test/"
    );
    crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::RichText(value),
      &DatabaseLimits::default(),
    )
    .expect("normalized RichText value validates");
  }

  #[test]
  fn rich_text_rejects_projection_drift_unknown_schema_and_unsafe_links() {
    let limits = DatabaseLimits::default();
    let document = serde_json::json!({
      "type": "doc",
      "content": [{
        "type": "paragraph",
        "content": [{ "type": "text", "text": "safe" }]
      }]
    });
    let mismatch = crate::database::editing::rules::normalize_rich_text_value(
      DatabaseRichTextValue {
        plain_text: "different".to_string(),
        document: document.clone(),
      },
      &limits,
    )
    .expect_err("client and snapshot projections are never authoritative");
    assert_eq!(mismatch.code, ERR_RICH_TEXT_INVALID);

    for invalid in [
      serde_json::json!({
        "type": "doc",
        "content": [{ "type": "heading", "content": [] }]
      }),
      serde_json::json!({
        "type": "doc",
        "content": [{
          "type": "paragraph",
          "content": [{
            "type": "text",
            "text": "unsafe",
            "marks": [{ "type": "link", "attrs": { "href": "javascript:alert(1)" } }]
          }]
        }]
      }),
      serde_json::json!({
        "type": "doc",
        "content": [{
          "type": "paragraph",
          "content": [{ "type": "text", "text": "unknown", "attrs": { "html": "<b>" } }]
        }]
      }),
      serde_json::json!({
        "type": "doc",
        "content": [{
          "type": "paragraph",
          "content": [{ "type": "text", "text": "unknown", "marks": [{ "type": "underline" }] }]
        }]
      }),
    ] {
      let invalid = crate::database::editing::rules::rich_text_value_from_document(invalid, &limits)
        .expect_err("unsupported RichText schema must fail");
      assert_eq!(invalid.code, ERR_RICH_TEXT_INVALID);
    }

    let mut bounded = limits.clone();
    bounded.max_rich_text_nodes = 2;
    let too_many = crate::database::editing::rules::rich_text_value_from_document(document, &bounded)
      .expect_err("node limit is enforced");
    assert_eq!(too_many.code, ERR_RICH_TEXT_INVALID);
  }

  #[test]
  fn rich_text_enforces_all_bounds_and_clears_an_empty_document() {
    let document = serde_json::json!({
      "type": "doc",
      "content": [{
        "type": "paragraph",
        "content": [{ "type": "text", "text": "bounded" }]
      }]
    });

    let depth_limits = DatabaseLimits {
      max_rich_text_depth: 1,
      ..Default::default()
    };
    assert_eq!(
      crate::database::editing::rules::rich_text_value_from_document(document.clone(), &depth_limits)
        .expect_err("text depth must be bounded")
        .code,
      ERR_RICH_TEXT_INVALID
    );

    let byte_limits = DatabaseLimits {
      max_rich_text_document_bytes: 16,
      ..Default::default()
    };
    assert_eq!(
      crate::database::editing::rules::rich_text_value_from_document(document.clone(), &byte_limits)
        .expect_err("document bytes must be bounded")
        .code,
      ERR_LIMIT_EXCEEDED
    );

    let link_limits = DatabaseLimits {
      max_rich_text_link_bytes: 12,
      ..Default::default()
    };
    assert_eq!(
      crate::database::editing::rules::rich_text_value_from_document(
        serde_json::json!({
          "type": "doc",
          "content": [{
            "type": "paragraph",
            "content": [{
              "type": "text",
              "text": "link",
              "marks": [{ "type": "link", "attrs": { "href": "https://example.test/long" } }]
            }]
          }]
        }),
        &link_limits,
      )
      .expect_err("link bytes must be bounded")
      .code,
      ERR_RICH_TEXT_INVALID
    );

    let mut field = test_field(Uuid::new_v4(), DatabaseFieldType::RichText, "Description", 1);
    field.config = DatabaseFieldConfig::RichText(DatabaseRichTextFieldConfig {
      max_plain_text_bytes: Some(4),
    });
    let value = crate::database::editing::rules::rich_text_value_from_document(document, &DatabaseLimits::default())
      .expect("canonical bounded document");
    assert_eq!(
      crate::database::editing::rules::validate_cell_value(
        &field,
        &DatabaseCellValueData::RichText(value),
        &DatabaseLimits::default(),
      )
      .expect_err("field plain-text bytes must be bounded")
      .code,
      ERR_LIMIT_EXCEEDED
    );

    let empty = crate::database::editing::rules::rich_text_value_from_document(
      serde_json::json!({ "type": "doc" }),
      &DatabaseLimits::default(),
    )
    .expect("empty document is canonical");
    assert!(empty.plain_text.is_empty());
    assert!(
      crate::database::editing::rules::normalize_editable_cell_value(
        DatabaseFieldType::RichText,
        DatabaseCellValueData::RichText(empty),
        &DatabaseLimits::default(),
      )
      .expect("empty RichText normalizes")
      .is_none()
    );
  }

  #[test]
  fn tags_field_cells_validate_unique_workspace_tag_references() {
    let database_id = Uuid::new_v4();
    let mut field = test_field(database_id, DatabaseFieldType::Tags, "Tags", 1);
    field.config = DatabaseFieldConfig::Tags(DatabaseTagsFieldConfig { max_count: Some(2) });
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();

    crate::database::definition::rules::validate_field_config(field.field_type, &field.config)
      .expect("valid Tags config");
    crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Tags(vec![first, second]),
      &DatabaseLimits::default(),
    )
    .expect("distinct workspace tag ids are valid at the field contract layer");

    let duplicate = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Tags(vec![first, first]),
      &DatabaseLimits::default(),
    )
    .expect_err("tag references must stay unique");
    assert_eq!(duplicate.code, ERR_CELL_INVALID);

    let too_many = crate::database::editing::rules::validate_cell_value(
      &field,
      &DatabaseCellValueData::Tags(vec![first, second, Uuid::new_v4()]),
      &DatabaseLimits::default(),
    )
    .expect_err("tag references must honor max_count");
    assert_eq!(too_many.code, ERR_CELL_INVALID);
  }

  #[test]
  fn progress_view_requires_percent_progress_field() {
    let database_id = Uuid::new_v4();
    let title = test_field(database_id, DatabaseFieldType::Title, "Title", 0);
    let mut progress = test_field(database_id, DatabaseFieldType::Percent, "Progress", 1);
    progress.config = DatabaseFieldConfig::Percent(DatabasePercentFieldConfig {
      min_value: Some(0.0),
      max_value: Some(100.0),
    });
    let status = test_field(database_id, DatabaseFieldType::Status, "Status", 2);
    let notes = test_field(database_id, DatabaseFieldType::Text, "Notes", 3);
    let fields = vec![title.clone(), progress.clone(), status.clone(), notes.clone()];
    let max_fields = DatabaseLimits::default().max_fields_per_database;

    let config = DatabaseViewConfig::Progress(DatabaseProgressViewConfig {
      title_field_id: title.id,
      progress_field_id: progress.id,
      group_field_id: Some(status.id),
      visible_field_ids: vec![title.id, progress.id, status.id],
      sort: vec![DatabaseSortRule {
        field_id: progress.id,
        direction: DatabaseSortDirection::Desc,
      }],
      filter: Vec::new(),
      filter_tree: None,
    });
    crate::database::views::rules::validate_view_config(DatabaseViewKind::Progress, &config, &fields, max_fields)
      .expect("progress views require an explicit percent progress axis");

    let invalid = DatabaseViewConfig::Progress(DatabaseProgressViewConfig {
      title_field_id: title.id,
      progress_field_id: notes.id,
      group_field_id: None,
      visible_field_ids: vec![title.id, notes.id],
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
    });
    let err =
      crate::database::views::rules::validate_view_config(DatabaseViewKind::Progress, &invalid, &fields, max_fields)
        .expect_err("progressFieldId must reference a Percent field");
    assert_eq!(err.code, ERR_VIEW_CONFIG_INVALID);
  }

  #[test]
  fn progress_groups_use_server_select_labels_and_option_order() {
    let database_id = Uuid::new_v4();
    let mut status = test_field(database_id, DatabaseFieldType::Select, "Status", 1);
    status.config = DatabaseFieldConfig::Select(DatabaseSelectFieldConfig {
      options: vec![
        DatabaseSelectOption {
          id: "todo".to_string(),
          name: "To do".to_string(),
          position: 0,
          color_role: "blue".to_string(),
        },
        DatabaseSelectOption {
          id: "done".to_string(),
          name: "Done".to_string(),
          position: 1,
          color_role: "green".to_string(),
        },
      ],
    });
    let progress = test_field(database_id, DatabaseFieldType::Percent, "Progress", 2);
    let todo_row_id = Uuid::new_v4();
    let draft_row_id = Uuid::new_v4();
    let done_row_id = Uuid::new_v4();
    let rows = vec![
      test_row_read(
        database_id,
        done_row_id,
        "Done task",
        vec![
          test_cell(done_row_id, &status, DatabaseCellValueData::Select("done".to_string())),
          test_cell(done_row_id, &progress, DatabaseCellValueData::Percent(100.0)),
        ],
      ),
      test_row_read(
        database_id,
        todo_row_id,
        "Todo task",
        vec![
          test_cell(todo_row_id, &status, DatabaseCellValueData::Select("todo".to_string())),
          test_cell(todo_row_id, &progress, DatabaseCellValueData::Percent(20.0)),
        ],
      ),
      test_row_read(
        database_id,
        draft_row_id,
        "Draft task",
        vec![test_cell(
          draft_row_id,
          &status,
          DatabaseCellValueData::Select("todo".to_string()),
        )],
      ),
    ];

    let groups = DatabaseViewService::progress_groups_for_rows(
      &rows,
      &[status.clone(), progress.clone()],
      progress.id,
      Some(status.id),
      None,
    );

    assert_eq!(
      groups
        .iter()
        .map(|group| (group.key.as_str(), group.label.as_str(), group.average_progress))
        .collect::<Vec<_>>(),
      vec![("todo", "To do", Some(10.0)), ("done", "Done", Some(100.0))]
    );
  }

  #[test]
  fn duration_view_filters_validate_canonical_minutes() {
    let database_id = Uuid::new_v4();
    let title = test_field(database_id, DatabaseFieldType::Title, "Title", 0);
    let mut effort = test_field(database_id, DatabaseFieldType::Duration, "Effort", 1);
    effort.config = DatabaseFieldConfig::Duration(DatabaseDurationFieldConfig {
      display_unit: DatabaseDurationDisplayUnit::Hours,
      min_minutes: Some(0),
      max_minutes: Some(8 * 60),
    });
    let fields = vec![title.clone(), effort.clone()];
    let max_fields = DatabaseLimits::default().max_fields_per_database;

    let valid = DatabaseViewConfig::Table(DatabaseTableViewConfig {
      title_field_id: title.id,
      visible_field_ids: vec![title.id, effort.id],
      field_widths: BTreeMap::new(),
      search_field_ids: vec![title.id, effort.id],
      sort: vec![DatabaseSortRule {
        field_id: effort.id,
        direction: DatabaseSortDirection::Desc,
      }],
      filter: vec![
        DatabaseFilterRule {
          field_id: effort.id,
          operator: DatabaseFilterOperator::GreaterOrEqual,
          value: DatabaseFilterValue::Duration(DatabaseDurationValue { minutes: 60 }),
        },
        DatabaseFilterRule {
          field_id: effort.id,
          operator: DatabaseFilterOperator::Between,
          value: DatabaseFilterValue::DurationRange(DatabaseDurationRange {
            start_minutes: Some(60),
            end_minutes: Some(240),
          }),
        },
      ],
      filter_tree: None,
      group: None,
      subgroup: None,
    });
    crate::database::views::rules::validate_view_config(DatabaseViewKind::Table, &valid, &fields, max_fields)
      .expect("duration sort/filter contract must validate canonical minutes");

    let invalid_negative = DatabaseViewConfig::Table(DatabaseTableViewConfig {
      title_field_id: title.id,
      visible_field_ids: vec![title.id, effort.id],
      field_widths: BTreeMap::new(),
      search_field_ids: vec![title.id, effort.id],
      sort: Vec::new(),
      filter: vec![DatabaseFilterRule {
        field_id: effort.id,
        operator: DatabaseFilterOperator::Less,
        value: DatabaseFilterValue::Duration(DatabaseDurationValue { minutes: -1 }),
      }],
      filter_tree: None,
      group: None,
      subgroup: None,
    });
    let err = crate::database::views::rules::validate_view_config(
      DatabaseViewKind::Table,
      &invalid_negative,
      &fields,
      max_fields,
    )
    .expect_err("duration filters reject negative minutes");
    assert_eq!(err.code, ERR_VIEW_CONFIG_INVALID);

    let invalid_between = DatabaseViewConfig::Table(DatabaseTableViewConfig {
      title_field_id: title.id,
      visible_field_ids: vec![title.id, effort.id],
      field_widths: BTreeMap::new(),
      search_field_ids: vec![title.id, effort.id],
      sort: Vec::new(),
      filter: vec![DatabaseFilterRule {
        field_id: effort.id,
        operator: DatabaseFilterOperator::Between,
        value: DatabaseFilterValue::DurationRange(DatabaseDurationRange {
          start_minutes: Some(240),
          end_minutes: Some(60),
        }),
      }],
      filter_tree: None,
      group: None,
      subgroup: None,
    });
    let err = crate::database::views::rules::validate_view_config(
      DatabaseViewKind::Table,
      &invalid_between,
      &fields,
      max_fields,
    )
    .expect_err("duration between filters reject inverted bounds");
    assert_eq!(err.code, ERR_VIEW_CONFIG_INVALID);
  }

  #[test]
  fn timeline_row_ranges_use_effective_row_image_and_reject_inverted_explicit_end() {
    let database_id = Uuid::new_v4();
    let title = test_field(database_id, DatabaseFieldType::Title, "Title", 0);
    let start = test_field(database_id, DatabaseFieldType::DateTime, "Start", 1);
    let end = test_field(database_id, DatabaseFieldType::DateTime, "End", 2);
    let now = Utc::now();
    let view = DatabaseView {
      id: Uuid::new_v4(),
      database_id,
      name: "Timeline".to_string(),
      view_kind: DatabaseViewKind::Timeline,
      icon: None,
      config: DatabaseViewConfig::Timeline(DatabaseTimelineViewConfig {
        title_field_id: title.id,
        start_field_id: start.id,
        end_field_id: Some(end.id),
        visible_field_ids: vec![title.id, start.id, end.id],
        sort: Vec::new(),
        filter: Vec::new(),
        filter_tree: None,
        group_by: DatabaseTimelineGroupBy::Month,
        order: DatabaseTimelineOrder::Asc,
        zoom: DatabaseTimelineZoom::Month,
      }),
      position: 0,
      edit_revision: 1,
      created_at: now,
      updated_at: now,
    };
    let mut record = test_database_record(vec![title.clone(), start.clone(), end.clone()], vec![view]);
    let row_id = Uuid::new_v4();
    let at = |value: &str| DateTime::parse_from_rfc3339(value).unwrap().with_timezone(&Utc);
    let cells = vec![
      test_cell(
        row_id,
        &start,
        DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
          start: at("2026-07-11T10:00:00Z"),
          end: Some(at("2026-07-11T12:00:00Z")),
          all_day: false,
          time_zone: "UTC".to_string(),
        }),
      ),
      test_cell(
        row_id,
        &end,
        DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
          start: at("2026-07-11T09:00:00Z"),
          end: None,
          all_day: false,
          time_zone: "UTC".to_string(),
        }),
      ),
    ];

    let error = crate::database::editing::rules::validate_timeline_row_ranges(
      &record,
      &cells,
      now,
      now,
      &HashMap::new(),
      true,
      DatabaseRowKind::Task,
    )
    .expect_err("an explicit Timeline end before start must be rejected");
    assert_eq!(error.code, ERR_VIEW_CONFIG_INVALID);

    crate::database::editing::rules::validate_timeline_row_ranges(
      &record,
      &cells,
      now,
      now,
      &HashMap::from([(
        end.id,
        Some(DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
          start: at("2026-07-11T11:00:00Z"),
          end: None,
          all_day: false,
          time_zone: "UTC".to_string(),
        })),
      )]),
      false,
      DatabaseRowKind::Task,
    )
    .expect("the in-flight row image must allow a corrected Timeline end");

    record.database.profile_kind = DatabaseProfileKind::Project;
    record.field_roles = [("task.startDate", start.id), ("task.dueDate", end.id)]
      .into_iter()
      .map(|(key, field_id)| DatabaseFieldRole {
        database_id,
        profile_kind: DatabaseProfileKind::Project,
        role_key: key.to_string(),
        row_kind_scope: Some("task".to_string()),
        field_id,
        required: false,
        config: serde_json::json!({}),
        created_at: now,
        updated_at: now,
      })
      .collect();
    crate::database::editing::rules::validate_timeline_row_ranges(
      &record,
      &cells,
      now,
      now,
      &HashMap::from([(title.id, Some(DatabaseCellValueData::Text("Legacy repair".to_string())))]),
      false,
      DatabaseRowKind::Task,
    )
    .expect("a configured Task Timeline must not block unrelated legacy edits");
    let task_views = record.views.clone();
    record.views.clear();
    let error = crate::database::editing::rules::validate_timeline_row_ranges(
      &record,
      &cells,
      now,
      now,
      &HashMap::new(),
      true,
      DatabaseRowKind::Task,
    )
    .expect_err("Project creation validates semantic dates without any saved View");
    assert_eq!(error.code, ERR_CELL_INVALID);
    crate::database::editing::rules::validate_timeline_row_ranges(
      &record,
      &cells,
      now,
      now,
      &HashMap::from([(end.id, None)]),
      false,
      DatabaseRowKind::Task,
    )
    .expect("clearing due explicitly repairs the pair");
    let error = crate::database::editing::rules::validate_timeline_row_ranges(
      &record,
      &cells,
      now,
      now,
      &HashMap::from([(end.id, Some(cells[1].value.clone()))]),
      false,
      DatabaseRowKind::Task,
    )
    .expect_err("an explicit still-invalid date edit is rejected without a Timeline");
    assert_eq!(error.code, ERR_CELL_INVALID);
    record.views = task_views;
    let calendar_cells = vec![
      test_cell(
        row_id,
        &start,
        DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
          start: at("2026-10-25T04:00:00Z"),
          end: None,
          all_day: true,
          time_zone: "America/New_York".to_string(),
        }),
      ),
      test_cell(
        row_id,
        &end,
        DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
          start: at("2026-10-24T22:00:00Z"),
          end: None,
          all_day: true,
          time_zone: "Europe/Berlin".to_string(),
        }),
      ),
    ];
    crate::database::editing::rules::validate_timeline_row_ranges(
      &record,
      &calendar_cells,
      now,
      now,
      &HashMap::new(),
      true,
      DatabaseRowKind::Task,
    )
    .expect("equal local calendar dates remain equal across zones and configured Timeline");
    record.views.clear();
    crate::database::editing::rules::validate_timeline_row_ranges(
      &record,
      &calendar_cells,
      now,
      now,
      &HashMap::new(),
      true,
      DatabaseRowKind::Task,
    )
    .expect("all-day semantic result is independent of saved Views");
  }

  #[test]
  fn gantt_view_config_validates_temporal_group_and_same_database_dependency_axes() {
    let database_id = Uuid::new_v4();
    let title = test_field(database_id, DatabaseFieldType::Title, "Title", 0);
    let starts = test_field(database_id, DatabaseFieldType::CreatedTime, "Created", 1);
    let ends = test_field(database_id, DatabaseFieldType::UpdatedTime, "Updated", 2);
    let group = test_field(database_id, DatabaseFieldType::Status, "Status", 3);
    let mut dependency = test_field(database_id, DatabaseFieldType::Relation, "Blocked by", 4);
    dependency.config = DatabaseFieldConfig::Relation(DatabaseRelationFieldConfig {
      target_database_id: database_id,
      allow_multiple: true,
      reciprocal_field_id: None,
      max_targets: None,
    });
    let fields = vec![
      title.clone(),
      starts.clone(),
      ends.clone(),
      group.clone(),
      dependency.clone(),
    ];
    let config = DatabaseViewConfig::Gantt(DatabaseGanttViewConfig {
      title_field_id: title.id,
      start_field_id: starts.id,
      end_field_id: Some(ends.id),
      visible_field_ids: fields.iter().map(|field| field.id).collect(),
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      group: Some(DatabaseGroupRule {
        field_id: group.id,
        descending: false,
        show_empty_groups: true,
      }),
      zoom: DatabaseTimelineZoom::Week,
      dependency_field_id: Some(dependency.id),
    });
    crate::database::views::rules::validate_view_config(DatabaseViewKind::Gantt, &config, &fields, 50)
      .expect("Gantt config must accept existing temporal projections and same-database relations");

    let mut external_dependency = dependency;
    external_dependency.config = DatabaseFieldConfig::Relation(DatabaseRelationFieldConfig {
      target_database_id: Uuid::new_v4(),
      allow_multiple: true,
      reciprocal_field_id: None,
      max_targets: None,
    });
    let invalid_fields = vec![title, starts, ends, group, external_dependency];
    let error =
      crate::database::views::rules::validate_view_config(DatabaseViewKind::Gantt, &config, &invalid_fields, 50)
        .expect_err("Gantt dependencies must never target another database");
    assert_eq!(error.code, ERR_VIEW_CONFIG_INVALID);
  }

  #[test]
  fn gantt_row_ranges_share_the_authoritative_temporal_invariant() {
    let database_id = Uuid::new_v4();
    let title = test_field(database_id, DatabaseFieldType::Title, "Title", 0);
    let start = test_field(database_id, DatabaseFieldType::DateTime, "Start", 1);
    let end = test_field(database_id, DatabaseFieldType::DateTime, "End", 2);
    let now = Utc::now();
    let view = DatabaseView {
      id: Uuid::new_v4(),
      database_id,
      name: "Gantt".to_string(),
      view_kind: DatabaseViewKind::Gantt,
      icon: None,
      config: DatabaseViewConfig::Gantt(DatabaseGanttViewConfig {
        title_field_id: title.id,
        start_field_id: start.id,
        end_field_id: Some(end.id),
        visible_field_ids: vec![title.id, start.id, end.id],
        sort: Vec::new(),
        filter: Vec::new(),
        filter_tree: None,
        group: None,
        zoom: DatabaseTimelineZoom::Month,
        dependency_field_id: None,
      }),
      position: 0,
      edit_revision: 1,
      created_at: now,
      updated_at: now,
    };
    let record = test_database_record(vec![title, start.clone(), end.clone()], vec![view]);
    let row_id = Uuid::new_v4();
    let at = |value: &str| DateTime::parse_from_rfc3339(value).unwrap().with_timezone(&Utc);
    let cells = vec![
      test_cell(
        row_id,
        &start,
        DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
          start: at("2026-07-11T10:00:00Z"),
          end: None,
          all_day: false,
          time_zone: "UTC".to_string(),
        }),
      ),
      test_cell(
        row_id,
        &end,
        DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
          start: at("2026-07-11T09:00:00Z"),
          end: None,
          all_day: false,
          time_zone: "UTC".to_string(),
        }),
      ),
    ];
    let error = crate::database::editing::rules::validate_timeline_row_ranges(
      &record,
      &cells,
      now,
      now,
      &HashMap::new(),
      true,
      DatabaseRowKind::Task,
    )
    .expect_err("Gantt end before start must be rejected server-side");
    assert_eq!(error.code, ERR_VIEW_CONFIG_INVALID);
    assert!(error.message.contains("gantt"));
  }

  #[test]
  fn unique_id_view_filters_validate_numeric_sequences() {
    let database_id = Uuid::new_v4();
    let title = test_field(database_id, DatabaseFieldType::Title, "Title", 0);
    let mut public_id = test_field(database_id, DatabaseFieldType::UniqueId, "Public ID", 1);
    public_id.config = DatabaseFieldConfig::UniqueId(DatabaseUniqueIdFieldConfig {
      prefix: "TASK-".to_string(),
      start_number: 1,
      padding: 3,
    });
    let fields = vec![title.clone(), public_id.clone()];
    let max_fields = DatabaseLimits::default().max_fields_per_database;

    let valid = DatabaseViewConfig::Table(DatabaseTableViewConfig {
      title_field_id: title.id,
      visible_field_ids: vec![title.id, public_id.id],
      field_widths: BTreeMap::new(),
      search_field_ids: vec![title.id, public_id.id],
      sort: vec![DatabaseSortRule {
        field_id: public_id.id,
        direction: DatabaseSortDirection::Asc,
      }],
      filter: vec![
        DatabaseFilterRule {
          field_id: public_id.id,
          operator: DatabaseFilterOperator::GreaterOrEqual,
          value: DatabaseFilterValue::Number(7.0),
        },
        DatabaseFilterRule {
          field_id: public_id.id,
          operator: DatabaseFilterOperator::Between,
          value: DatabaseFilterValue::NumberRange(DatabaseNumberRange {
            start: Some(7.0),
            end: Some(16.0),
          }),
        },
      ],
      filter_tree: None,
      group: None,
      subgroup: None,
    });
    crate::database::views::rules::validate_view_config(DatabaseViewKind::Table, &valid, &fields, max_fields)
      .expect("UniqueId filters use numeric sequences, not display strings");

    let display_string = DatabaseViewConfig::Table(DatabaseTableViewConfig {
      title_field_id: title.id,
      visible_field_ids: vec![title.id, public_id.id],
      field_widths: BTreeMap::new(),
      search_field_ids: vec![title.id, public_id.id],
      sort: Vec::new(),
      filter: vec![DatabaseFilterRule {
        field_id: public_id.id,
        operator: DatabaseFilterOperator::Equals,
        value: DatabaseFilterValue::Text("TASK-007".to_string()),
      }],
      filter_tree: None,
      group: None,
      subgroup: None,
    });
    let err = crate::database::views::rules::validate_view_config(
      DatabaseViewKind::Table,
      &display_string,
      &fields,
      max_fields,
    )
    .expect_err("UniqueId filters must not persist display-string comparisons");
    assert_eq!(err.code, ERR_VIEW_CONFIG_INVALID);

    let inverted = DatabaseViewConfig::Table(DatabaseTableViewConfig {
      title_field_id: title.id,
      visible_field_ids: vec![title.id, public_id.id],
      field_widths: BTreeMap::new(),
      search_field_ids: vec![title.id, public_id.id],
      sort: Vec::new(),
      filter: vec![DatabaseFilterRule {
        field_id: public_id.id,
        operator: DatabaseFilterOperator::Between,
        value: DatabaseFilterValue::NumberRange(DatabaseNumberRange {
          start: Some(16.0),
          end: Some(7.0),
        }),
      }],
      filter_tree: None,
      group: None,
      subgroup: None,
    });
    let err =
      crate::database::views::rules::validate_view_config(DatabaseViewKind::Table, &inverted, &fields, max_fields)
        .expect_err("UniqueId between filters reject inverted sequence bounds");
    assert_eq!(err.code, ERR_VIEW_CONFIG_INVALID);
  }

  #[test]
  fn saved_view_filters_validate_type_specific_operator_matrix() {
    let database_id = Uuid::new_v4();
    let title = test_field(database_id, DatabaseFieldType::Title, "Title", 0);
    let number = test_field(database_id, DatabaseFieldType::Number, "Score", 1);
    let percent = test_field(database_id, DatabaseFieldType::Percent, "Progress", 2);
    let currency = test_field(database_id, DatabaseFieldType::Currency, "Budget", 3);
    let select = test_field(database_id, DatabaseFieldType::Select, "Priority", 4);
    let status = test_field(database_id, DatabaseFieldType::Status, "Status", 5);
    let multi = test_field(database_id, DatabaseFieldType::MultiSelect, "Labels", 6);
    let date = test_field(database_id, DatabaseFieldType::Date, "Due", 7);
    let date_time = test_field(database_id, DatabaseFieldType::DateTime, "Starts", 8);
    let user = test_field(database_id, DatabaseFieldType::User, "Owner", 9);
    let users = test_field(database_id, DatabaseFieldType::Users, "Assignees", 10);
    let checkbox = test_field(database_id, DatabaseFieldType::Checkbox, "Done", 11);
    let relation = test_field(database_id, DatabaseFieldType::Relation, "Related", 12);
    let fields = vec![
      title.clone(),
      number.clone(),
      percent.clone(),
      currency.clone(),
      select.clone(),
      status.clone(),
      multi.clone(),
      date.clone(),
      date_time.clone(),
      user.clone(),
      users.clone(),
      checkbox.clone(),
      relation.clone(),
    ];
    let max_fields = DatabaseLimits::default().max_fields_per_database;
    let user_id = Uuid::new_v4();
    let row_id = Uuid::new_v4();
    let valid = DatabaseViewConfig::Table(DatabaseTableViewConfig {
      title_field_id: title.id,
      visible_field_ids: vec![title.id],
      field_widths: BTreeMap::new(),
      search_field_ids: vec![title.id],
      sort: vec![DatabaseSortRule {
        field_id: number.id,
        direction: DatabaseSortDirection::Desc,
      }],
      filter: vec![
        DatabaseFilterRule {
          field_id: title.id,
          operator: DatabaseFilterOperator::Contains,
          value: DatabaseFilterValue::Text("alpha".to_string()),
        },
        DatabaseFilterRule {
          field_id: percent.id,
          operator: DatabaseFilterOperator::Between,
          value: DatabaseFilterValue::NumberRange(DatabaseNumberRange {
            start: Some(0.25),
            end: Some(0.75),
          }),
        },
        DatabaseFilterRule {
          field_id: currency.id,
          operator: DatabaseFilterOperator::GreaterOrEqual,
          value: DatabaseFilterValue::Currency(DatabaseCurrencyValue {
            amount: 1000.0,
            currency_code: "EUR".to_string(),
          }),
        },
        DatabaseFilterRule {
          field_id: select.id,
          operator: DatabaseFilterOperator::AnyOf,
          value: DatabaseFilterValue::Ids(vec!["high".to_string(), "medium".to_string()]),
        },
        DatabaseFilterRule {
          field_id: status.id,
          operator: DatabaseFilterOperator::GroupIs,
          value: DatabaseFilterValue::OptionId("complete".to_string()),
        },
        DatabaseFilterRule {
          field_id: multi.id,
          operator: DatabaseFilterOperator::ContainsAll,
          value: DatabaseFilterValue::Ids(vec!["backend".to_string(), "api".to_string()]),
        },
        DatabaseFilterRule {
          field_id: date.id,
          operator: DatabaseFilterOperator::Between,
          value: DatabaseFilterValue::DateRange(DatabaseDateRange {
            start: Some(NaiveDate::from_ymd_opt(2026, 7, 1).unwrap()),
            end: Some(NaiveDate::from_ymd_opt(2026, 7, 31).unwrap()),
          }),
        },
        DatabaseFilterRule {
          field_id: date_time.id,
          operator: DatabaseFilterOperator::Relative,
          value: DatabaseFilterValue::RelativeDate(DatabaseRelativeDatePreset::Next7Days),
        },
        DatabaseFilterRule {
          field_id: user.id,
          operator: DatabaseFilterOperator::ContainsUser,
          value: DatabaseFilterValue::UserId(user_id),
        },
        DatabaseFilterRule {
          field_id: users.id,
          operator: DatabaseFilterOperator::CurrentUser,
          value: DatabaseFilterValue::None,
        },
        DatabaseFilterRule {
          field_id: checkbox.id,
          operator: DatabaseFilterOperator::Checked,
          value: DatabaseFilterValue::None,
        },
        DatabaseFilterRule {
          field_id: relation.id,
          operator: DatabaseFilterOperator::ContainsRow,
          value: DatabaseFilterValue::RelationRowId(row_id),
        },
      ],
      filter_tree: None,
      group: Some(DatabaseGroupRule {
        field_id: status.id,
        descending: false,
        show_empty_groups: true,
      }),
      subgroup: Some(DatabaseGroupRule {
        field_id: users.id,
        descending: false,
        show_empty_groups: false,
      }),
    });
    crate::database::views::rules::validate_view_config(DatabaseViewKind::Table, &valid, &fields, max_fields)
      .expect("P-DB-22 saved filter operator matrix must accept supported field/operator pairs");

    for (field_id, operator, value, reason) in [
      (
        title.id,
        DatabaseFilterOperator::Greater,
        DatabaseFilterValue::Number(5.0),
        "text fields must not accept numeric comparison operators",
      ),
      (
        number.id,
        DatabaseFilterOperator::Contains,
        DatabaseFilterValue::Text("5".to_string()),
        "numeric fields must not accept text operators",
      ),
      (
        currency.id,
        DatabaseFilterOperator::Equals,
        DatabaseFilterValue::Currency(DatabaseCurrencyValue {
          amount: 5.0,
          currency_code: "NOPE".to_string(),
        }),
        "currency filters must validate ISO currency codes",
      ),
      (
        select.id,
        DatabaseFilterOperator::GroupIs,
        DatabaseFilterValue::OptionId("complete".to_string()),
        "plain Select fields must not accept Status group operators",
      ),
      (
        checkbox.id,
        DatabaseFilterOperator::Equals,
        DatabaseFilterValue::Boolean(true),
        "Checkbox filters use checked/unchecked instead of boolean equality wrappers",
      ),
      (
        relation.id,
        DatabaseFilterOperator::ContainsRow,
        DatabaseFilterValue::Text("not-a-uuid".to_string()),
        "Relation filters must store row ids as UUID strings",
      ),
    ] {
      let invalid = DatabaseViewConfig::Table(DatabaseTableViewConfig {
        title_field_id: title.id,
        visible_field_ids: vec![title.id],
        field_widths: BTreeMap::new(),
        search_field_ids: vec![title.id],
        sort: Vec::new(),
        filter: vec![DatabaseFilterRule {
          field_id,
          operator,
          value,
        }],
        filter_tree: None,
        group: None,
        subgroup: None,
      });
      let err =
        crate::database::views::rules::validate_view_config(DatabaseViewKind::Table, &invalid, &fields, max_fields)
          .expect_err(reason);
      assert_eq!(err.code, ERR_VIEW_CONFIG_INVALID, "{reason}");
    }
  }

  #[test]
  fn typed_filter_contract_accepts_every_documented_field_operator_value_pair() {
    use DatabaseFilterOperator as Op;

    let text = [
      Op::Contains,
      Op::DoesNotContain,
      Op::Is,
      Op::IsNot,
      Op::StartsWith,
      Op::EndsWith,
      Op::Empty,
      Op::NotEmpty,
    ];
    let numeric = [
      Op::Equals,
      Op::NotEquals,
      Op::Greater,
      Op::Less,
      Op::GreaterOrEqual,
      Op::LessOrEqual,
      Op::Between,
      Op::Empty,
      Op::NotEmpty,
    ];
    let option = [Op::Is, Op::IsNot, Op::AnyOf, Op::NoneOf, Op::Empty, Op::NotEmpty];
    let status = [
      Op::Is,
      Op::IsNot,
      Op::AnyOf,
      Op::NoneOf,
      Op::GroupIs,
      Op::GroupIsNot,
      Op::GroupAnyOf,
      Op::GroupNoneOf,
      Op::Empty,
      Op::NotEmpty,
    ];
    let multiple = [
      Op::Contains,
      Op::DoesNotContain,
      Op::ContainsAll,
      Op::Empty,
      Op::NotEmpty,
    ];
    let date = [
      Op::Before,
      Op::After,
      Op::On,
      Op::Between,
      Op::Relative,
      Op::Empty,
      Op::NotEmpty,
    ];
    let user = [
      Op::ContainsUser,
      Op::DoesNotContainUser,
      Op::CurrentUser,
      Op::Empty,
      Op::NotEmpty,
    ];
    let relation = [Op::ContainsRow, Op::DoesNotContainRow, Op::Empty, Op::NotEmpty];
    let cases: Vec<(DatabaseFieldType, Vec<Op>)> = vec![
      (DatabaseFieldType::Title, text.to_vec()),
      (DatabaseFieldType::Text, text.to_vec()),
      (DatabaseFieldType::RichText, text.to_vec()),
      (DatabaseFieldType::Url, text.to_vec()),
      (DatabaseFieldType::Email, text.to_vec()),
      (DatabaseFieldType::Phone, text.to_vec()),
      (DatabaseFieldType::Number, numeric.to_vec()),
      (DatabaseFieldType::Percent, numeric.to_vec()),
      (DatabaseFieldType::UniqueId, numeric.to_vec()),
      (DatabaseFieldType::Currency, numeric.to_vec()),
      (DatabaseFieldType::Duration, numeric.to_vec()),
      (DatabaseFieldType::Select, option.to_vec()),
      (DatabaseFieldType::Status, status.to_vec()),
      (DatabaseFieldType::MultiSelect, multiple.to_vec()),
      (DatabaseFieldType::Tags, multiple.to_vec()),
      (DatabaseFieldType::Date, date.to_vec()),
      (DatabaseFieldType::DateTime, date.to_vec()),
      (DatabaseFieldType::CreatedTime, date.to_vec()),
      (DatabaseFieldType::UpdatedTime, date.to_vec()),
      (DatabaseFieldType::User, user.to_vec()),
      (DatabaseFieldType::Users, user.to_vec()),
      (DatabaseFieldType::Checkbox, vec![Op::Checked, Op::Unchecked]),
      (DatabaseFieldType::Relation, relation.to_vec()),
    ];
    let database_id = Uuid::new_v4();
    let instant = Utc::now();
    let date_value = instant.date_naive();
    let referenced_id = Uuid::new_v4();

    for (position, (field_type, operators)) in cases.into_iter().enumerate() {
      let field = test_field(database_id, field_type, field_type.as_str(), position as i32);
      for operator in operators {
        let value = match operator {
          Op::Empty | Op::NotEmpty | Op::Checked | Op::Unchecked | Op::CurrentUser => DatabaseFilterValue::None,
          Op::Between => match field_type {
            DatabaseFieldType::Currency => DatabaseFilterValue::CurrencyRange(DatabaseCurrencyRange {
              start: Some(10.0),
              end: Some(20.0),
              currency_code: "EUR".to_string(),
            }),
            DatabaseFieldType::Duration => DatabaseFilterValue::DurationRange(DatabaseDurationRange {
              start_minutes: Some(10),
              end_minutes: Some(20),
            }),
            DatabaseFieldType::Date => DatabaseFilterValue::DateRange(DatabaseDateRange {
              start: Some(date_value),
              end: Some(date_value),
            }),
            DatabaseFieldType::DateTime | DatabaseFieldType::CreatedTime | DatabaseFieldType::UpdatedTime => {
              DatabaseFilterValue::InstantRange(DatabaseInstantRange {
                start: Some(instant),
                end: Some(instant),
              })
            }
            _ => DatabaseFilterValue::NumberRange(DatabaseNumberRange {
              start: Some(10.0),
              end: Some(20.0),
            }),
          },
          Op::Equals | Op::NotEquals | Op::Greater | Op::Less | Op::GreaterOrEqual | Op::LessOrEqual => {
            match field_type {
              DatabaseFieldType::Currency => DatabaseFilterValue::Currency(DatabaseCurrencyValue {
                amount: 12.0,
                currency_code: "EUR".to_string(),
              }),
              DatabaseFieldType::Duration => DatabaseFilterValue::Duration(DatabaseDurationValue { minutes: 12 }),
              _ => DatabaseFilterValue::Number(12.0),
            }
          }
          Op::Is | Op::IsNot | Op::GroupIs | Op::GroupIsNot => {
            if matches!(field_type, DatabaseFieldType::Select | DatabaseFieldType::Status) {
              DatabaseFilterValue::OptionId("option-id".to_string())
            } else {
              DatabaseFilterValue::Text("value".to_string())
            }
          }
          Op::AnyOf | Op::NoneOf | Op::GroupAnyOf | Op::GroupNoneOf | Op::ContainsAll => {
            DatabaseFilterValue::Ids(vec!["option-a".to_string(), "option-b".to_string()])
          }
          Op::Contains | Op::DoesNotContain => {
            if matches!(field_type, DatabaseFieldType::MultiSelect | DatabaseFieldType::Tags) {
              DatabaseFilterValue::OptionId("option-id".to_string())
            } else {
              DatabaseFilterValue::Text("value".to_string())
            }
          }
          Op::StartsWith | Op::EndsWith => DatabaseFilterValue::Text("value".to_string()),
          Op::Before | Op::After | Op::On => {
            if field_type == DatabaseFieldType::Date {
              DatabaseFilterValue::Date(date_value)
            } else {
              DatabaseFilterValue::Instant(instant)
            }
          }
          Op::Relative => DatabaseFilterValue::RelativeDate(DatabaseRelativeDatePreset::CurrentWeek),
          Op::ContainsUser | Op::DoesNotContainUser => DatabaseFilterValue::UserId(referenced_id),
          Op::ContainsRow | Op::DoesNotContainRow => DatabaseFilterValue::RelationRowId(referenced_id),
        };
        let rule = DatabaseFilterRule {
          field_id: field.id,
          operator,
          value,
        };
        crate::database::views::rules::validate_filter_rule(&field, &rule).unwrap_or_else(|error| {
          panic!(
            "documented {field_type:?}/{operator:?} pair must validate, got {}: {}",
            error.code, error.message
          )
        });
      }
    }
  }

  #[test]
  fn saved_view_filter_execution_covers_flat_operator_families() {
    let database_id = Uuid::new_v4();
    let actor = Uuid::new_v4();
    let relation_target = Uuid::new_v4();
    let row_id = Uuid::new_v4();
    let title = test_field(database_id, DatabaseFieldType::Title, "Title", 0);
    let score = test_field(database_id, DatabaseFieldType::Number, "Score", 1);
    let budget = test_field(database_id, DatabaseFieldType::Currency, "Budget", 2);
    let effort = test_field(database_id, DatabaseFieldType::Duration, "Effort", 3);
    let priority = test_field(database_id, DatabaseFieldType::Select, "Priority", 4);
    let status = test_field(database_id, DatabaseFieldType::Status, "Status", 5);
    let labels = test_field(database_id, DatabaseFieldType::MultiSelect, "Labels", 6);
    let due = test_field(database_id, DatabaseFieldType::Date, "Due", 7);
    let starts = test_field(database_id, DatabaseFieldType::DateTime, "Starts", 8);
    let owner = test_field(database_id, DatabaseFieldType::User, "Owner", 9);
    let assignees = test_field(database_id, DatabaseFieldType::Users, "Assignees", 10);
    let done = test_field(database_id, DatabaseFieldType::Checkbox, "Done", 11);
    let related = test_field(database_id, DatabaseFieldType::Relation, "Related", 12);
    let future_start = Utc::now() + Duration::days(3);
    let today = Utc::now().date_naive();
    let row = test_row_read(
      database_id,
      row_id,
      "Ship Alpha milestone",
      vec![
        test_cell(row_id, &score, DatabaseCellValueData::Number(42.0)),
        test_cell(
          row_id,
          &budget,
          DatabaseCellValueData::Currency(DatabaseCurrencyValue {
            amount: 1500.0,
            currency_code: "EUR".to_string(),
          }),
        ),
        test_cell(
          row_id,
          &effort,
          DatabaseCellValueData::Duration(DatabaseDurationValue { minutes: 180 }),
        ),
        test_cell(row_id, &priority, DatabaseCellValueData::Select("high".to_string())),
        test_cell(
          row_id,
          &status,
          DatabaseCellValueData::Status("status.done".to_string()),
        ),
        test_cell(
          row_id,
          &labels,
          DatabaseCellValueData::MultiSelect(vec!["backend".to_string(), "api".to_string()]),
        ),
        test_cell(
          row_id,
          &due,
          DatabaseCellValueData::Date(DatabaseDateValue {
            start: today,
            end: None,
          }),
        ),
        test_cell(
          row_id,
          &starts,
          DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
            start: future_start,
            end: None,
            all_day: false,
            time_zone: "UTC".to_string(),
          }),
        ),
        test_cell(row_id, &owner, DatabaseCellValueData::User(actor)),
        test_cell(row_id, &assignees, DatabaseCellValueData::Users(vec![actor])),
        test_cell(row_id, &done, DatabaseCellValueData::Checkbox(true)),
        test_cell(row_id, &related, DatabaseCellValueData::Relation(vec![relation_target])),
      ],
    );
    let fields = vec![
      title.clone(),
      score.clone(),
      budget.clone(),
      effort.clone(),
      priority.clone(),
      status.clone(),
      labels.clone(),
      due.clone(),
      starts.clone(),
      owner.clone(),
      assignees.clone(),
      done.clone(),
      related.clone(),
    ];
    let fields_by_id = fields.iter().map(|field| (field.id, field)).collect::<HashMap<_, _>>();

    for (field, operator, value, reason) in [
      (
        &title,
        DatabaseFilterOperator::Contains,
        DatabaseFilterValue::Text("alpha".to_string()),
        "text contains",
      ),
      (
        &title,
        DatabaseFilterOperator::StartsWith,
        DatabaseFilterValue::Text("ship".to_string()),
        "text starts_with",
      ),
      (
        &score,
        DatabaseFilterOperator::Between,
        DatabaseFilterValue::NumberRange(DatabaseNumberRange {
          start: Some(40.0),
          end: Some(45.0),
        }),
        "number between",
      ),
      (
        &budget,
        DatabaseFilterOperator::GreaterOrEqual,
        DatabaseFilterValue::Currency(DatabaseCurrencyValue {
          amount: 1000.0,
          currency_code: "EUR".to_string(),
        }),
        "currency amount compare",
      ),
      (
        &effort,
        DatabaseFilterOperator::LessOrEqual,
        DatabaseFilterValue::Duration(DatabaseDurationValue { minutes: 240 }),
        "duration minute compare",
      ),
      (
        &priority,
        DatabaseFilterOperator::AnyOf,
        DatabaseFilterValue::Ids(vec!["low".to_string(), "high".to_string()]),
        "select any_of",
      ),
      (
        &status,
        DatabaseFilterOperator::GroupIs,
        DatabaseFilterValue::OptionId("complete".to_string()),
        "status group_is uses semantic group config",
      ),
      (
        &status,
        DatabaseFilterOperator::GroupAnyOf,
        DatabaseFilterValue::Ids(vec!["active".to_string(), "complete".to_string()]),
        "status group_any_of uses semantic group config",
      ),
      (
        &labels,
        DatabaseFilterOperator::ContainsAll,
        DatabaseFilterValue::Ids(vec!["backend".to_string(), "api".to_string()]),
        "multi-select contains_all",
      ),
      (
        &due,
        DatabaseFilterOperator::Between,
        DatabaseFilterValue::DateRange(DatabaseDateRange {
          start: Some(today - Duration::days(1)),
          end: Some(today + Duration::days(1)),
        }),
        "date between",
      ),
      (
        &starts,
        DatabaseFilterOperator::Relative,
        DatabaseFilterValue::RelativeDate(DatabaseRelativeDatePreset::Next7Days),
        "date-time relative preset",
      ),
      (
        &owner,
        DatabaseFilterOperator::ContainsUser,
        DatabaseFilterValue::UserId(actor),
        "single user identity",
      ),
      (
        &assignees,
        DatabaseFilterOperator::CurrentUser,
        DatabaseFilterValue::None,
        "multi-user current user",
      ),
      (
        &done,
        DatabaseFilterOperator::Checked,
        DatabaseFilterValue::None,
        "checkbox checked",
      ),
      (
        &related,
        DatabaseFilterOperator::ContainsRow,
        DatabaseFilterValue::RelationRowId(relation_target),
        "relation target id",
      ),
    ] {
      assert!(
        DatabaseViewService::row_matches_filter(
          &row,
          &fields_by_id,
          actor,
          &DatabaseFilterRule {
            field_id: field.id,
            operator,
            value,
          },
        ),
        "{reason} filter must match the representative row"
      );
    }

    for (field, operator, value, reason) in [
      (
        &status,
        DatabaseFilterOperator::GroupIsNot,
        DatabaseFilterValue::OptionId("complete".to_string()),
        "status negative group",
      ),
      (
        &starts,
        DatabaseFilterOperator::Relative,
        DatabaseFilterValue::RelativeDate(DatabaseRelativeDatePreset::Overdue),
        "relative overdue",
      ),
      (
        &assignees,
        DatabaseFilterOperator::ContainsUser,
        DatabaseFilterValue::UserId(Uuid::new_v4()),
        "wrong user",
      ),
      (
        &related,
        DatabaseFilterOperator::DoesNotContainRow,
        DatabaseFilterValue::RelationRowId(relation_target),
        "relation negative contains",
      ),
    ] {
      assert!(
        !DatabaseViewService::row_matches_filter(
          &row,
          &fields_by_id,
          actor,
          &DatabaseFilterRule {
            field_id: field.id,
            operator,
            value,
          },
        ),
        "{reason} filter must not match the representative row"
      );
    }
  }

  #[test]
  fn kanban_view_requires_select_group_field() {
    let title = DatabaseField {
      id: Uuid::new_v4(),
      database_id: Uuid::new_v4(),
      name: "Title".to_string(),
      field_type: DatabaseFieldType::Title,
      config: DatabaseFieldConfig::Title,
      position: 0,
      required: true,
      edit_revision: 1,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    };
    let text = DatabaseField {
      id: Uuid::new_v4(),
      database_id: title.database_id,
      name: "Notes".to_string(),
      field_type: DatabaseFieldType::Text,
      config: DatabaseFieldConfig::Text(Default::default()),
      position: 1,
      required: false,
      edit_revision: 1,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    };
    let config = DatabaseViewConfig::Kanban(DatabaseKanbanViewConfig {
      title_field_id: title.id,
      group_field_id: text.id,
      visible_field_ids: vec![title.id, text.id],
      cover_field_id: None,
      card_density: DatabaseCardDensity::Default,
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
    });
    let err = crate::database::views::rules::validate_view_config(
      DatabaseViewKind::Kanban,
      &config,
      &[title, text],
      DatabaseLimits::default().max_fields_per_database,
    )
    .expect_err("kanban group field must be a select or status field");
    assert_eq!(err.code, ERR_VIEW_CONFIG_INVALID);
  }

  #[test]
  fn structural_view_axis_fields_are_protected() {
    let database_id = Uuid::new_v4();
    let title = test_field(database_id, DatabaseFieldType::Title, "Title", 0);
    let status = test_field(database_id, DatabaseFieldType::Select, "Workflow", 1);
    let due = test_field(database_id, DatabaseFieldType::Date, "Due", 2);
    let notes = test_field(database_id, DatabaseFieldType::Text, "Notes", 3);
    let now = Utc::now();
    let views = vec![
      DatabaseView {
        id: Uuid::new_v4(),
        database_id,
        name: "Kanban".to_string(),
        view_kind: DatabaseViewKind::Kanban,
        icon: None,
        config: DatabaseViewConfig::Kanban(DatabaseKanbanViewConfig {
          title_field_id: title.id,
          group_field_id: status.id,
          visible_field_ids: vec![title.id, status.id, notes.id],
          cover_field_id: None,
          card_density: DatabaseCardDensity::Default,
          sort: Vec::new(),
          filter: Vec::new(),
          filter_tree: None,
        }),
        position: 0,
        edit_revision: 1,
        created_at: now,
        updated_at: now,
      },
      DatabaseView {
        id: Uuid::new_v4(),
        database_id,
        name: "Calendar".to_string(),
        view_kind: DatabaseViewKind::Calendar,
        icon: None,
        config: DatabaseViewConfig::Calendar(DatabaseCalendarViewConfig {
          title_field_id: title.id,
          date_field_id: due.id,
          visible_field_ids: vec![title.id, due.id, notes.id],
          sort: Vec::new(),
          filter: Vec::new(),
          filter_tree: None,
          date_mode: DatabaseCalendarDateMode::Month,
          initial_range: DatabaseCalendarInitialRange::CurrentMonth,
          group: None,
          subgroup: None,
        }),
        position: 1,
        edit_revision: 1,
        created_at: now,
        updated_at: now,
      },
    ];

    assert_eq!(
      crate::database::definition::rules::structural_view_axis_reference(status.id, &views).map(|view| view.view_kind),
      Some(DatabaseViewKind::Kanban)
    );
    assert_eq!(
      crate::database::definition::rules::structural_view_axis_reference(due.id, &views).map(|view| view.view_kind),
      Some(DatabaseViewKind::Calendar)
    );
    assert!(
      crate::database::definition::rules::structural_view_axis_reference(notes.id, &views).is_none(),
      "non-axis visible fields must remain deletable"
    );
  }

  #[test]
  fn p9g_extended_views_validate_field_ids_defaults_and_special_errors() {
    let database_id = Uuid::new_v4();
    let title = test_field(database_id, DatabaseFieldType::Title, "Title", 0);
    let date = test_field(database_id, DatabaseFieldType::Date, "Due", 1);
    let text = test_field(database_id, DatabaseFieldType::Text, "Notes", 2);
    let created_time = test_field(database_id, DatabaseFieldType::CreatedTime, "Created", 3);
    let updated_time = test_field(database_id, DatabaseFieldType::UpdatedTime, "Updated", 4);
    let files = test_field(database_id, DatabaseFieldType::Files, "Attachments", 5);
    let fields = vec![
      title.clone(),
      date.clone(),
      text.clone(),
      created_time.clone(),
      updated_time.clone(),
      files.clone(),
    ];
    let max_fields = DatabaseLimits::default().max_fields_per_database;

    let list = DatabaseViewConfig::List(DatabaseListViewConfig {
      title_field_id: title.id,
      visible_field_ids: vec![title.id, text.id],
      sort: vec![DatabaseSortRule {
        field_id: text.id,
        direction: DatabaseSortDirection::Asc,
      }],
      filter: vec![DatabaseFilterRule {
        field_id: text.id,
        operator: DatabaseFilterOperator::Contains,
        value: DatabaseFilterValue::Text("ready".to_string()),
      }],
      filter_tree: None,
      density: DatabaseListDensity::Default,
      show_field_labels: true,
      group: Some(DatabaseGroupRule {
        field_id: date.id,
        descending: false,
        show_empty_groups: true,
      }),
      subgroup: Some(DatabaseGroupRule {
        field_id: created_time.id,
        descending: true,
        show_empty_groups: false,
      }),
    });
    crate::database::views::rules::validate_view_config(DatabaseViewKind::List, &list, &fields, max_fields)
      .expect("list view config must validate");

    let gallery = DatabaseViewConfig::Gallery(DatabaseGalleryViewConfig {
      title_field_id: title.id,
      visible_field_ids: vec![title.id, text.id],
      cover_field_id: None,
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      card_density: DatabaseGalleryCardDensity::Default,
      show_empty_cover: true,
      group: None,
      subgroup: None,
    });
    crate::database::views::rules::validate_view_config(DatabaseViewKind::Gallery, &gallery, &fields, max_fields)
      .expect("gallery without cover field must validate in P9G");

    let gallery_with_cover = DatabaseViewConfig::Gallery(DatabaseGalleryViewConfig {
      title_field_id: title.id,
      visible_field_ids: vec![title.id, files.id],
      cover_field_id: Some(files.id),
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      card_density: DatabaseGalleryCardDensity::Default,
      show_empty_cover: true,
      group: None,
      subgroup: None,
    });
    crate::database::views::rules::validate_view_config(
      DatabaseViewKind::Gallery,
      &gallery_with_cover,
      &fields,
      max_fields,
    )
    .expect("gallery cover field must accept a Files field");

    let calendar = DatabaseViewConfig::Calendar(DatabaseCalendarViewConfig {
      title_field_id: title.id,
      date_field_id: date.id,
      visible_field_ids: vec![title.id, date.id],
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      date_mode: DatabaseCalendarDateMode::Month,
      initial_range: DatabaseCalendarInitialRange::CurrentMonth,
      group: None,
      subgroup: None,
    });
    crate::database::views::rules::validate_view_config(DatabaseViewKind::Calendar, &calendar, &fields, max_fields)
      .expect("calendar view config must validate with a date field");

    let timeline = DatabaseViewConfig::Timeline(DatabaseTimelineViewConfig {
      title_field_id: title.id,
      start_field_id: date.id,
      end_field_id: None,
      zoom: DatabaseTimelineZoom::Month,
      visible_field_ids: vec![title.id, date.id, text.id],
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      group_by: DatabaseTimelineGroupBy::Month,
      order: DatabaseTimelineOrder::Asc,
    });
    crate::database::views::rules::validate_view_config(DatabaseViewKind::Timeline, &timeline, &fields, max_fields)
      .expect("timeline view config must validate with a date field");

    let metadata_calendar = DatabaseViewConfig::Calendar(DatabaseCalendarViewConfig {
      title_field_id: title.id,
      date_field_id: created_time.id,
      visible_field_ids: vec![title.id, created_time.id],
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      date_mode: DatabaseCalendarDateMode::Month,
      initial_range: DatabaseCalendarInitialRange::CurrentMonth,
      group: None,
      subgroup: None,
    });
    crate::database::views::rules::validate_view_config(
      DatabaseViewKind::Calendar,
      &metadata_calendar,
      &fields,
      max_fields,
    )
    .expect("P9I created_time projections must be valid calendar date sources");

    let metadata_timeline = DatabaseViewConfig::Timeline(DatabaseTimelineViewConfig {
      title_field_id: title.id,
      start_field_id: updated_time.id,
      end_field_id: None,
      zoom: DatabaseTimelineZoom::Month,
      visible_field_ids: vec![title.id, updated_time.id],
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      group_by: DatabaseTimelineGroupBy::Month,
      order: DatabaseTimelineOrder::Asc,
    });
    crate::database::views::rules::validate_view_config(
      DatabaseViewKind::Timeline,
      &metadata_timeline,
      &fields,
      max_fields,
    )
    .expect("P9I updated_time projections must be valid timeline date sources");

    let duplicate_visible = DatabaseViewConfig::List(DatabaseListViewConfig {
      title_field_id: title.id,
      visible_field_ids: vec![text.id, text.id],
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      density: DatabaseListDensity::Compact,
      show_field_labels: false,
      group: None,
      subgroup: None,
    });
    let err = crate::database::views::rules::validate_view_config(
      DatabaseViewKind::List,
      &duplicate_visible,
      &fields,
      max_fields,
    )
    .expect_err("duplicate visible fields must be rejected");
    assert_eq!(err.code, ERR_VIEW_CONFIG_INVALID);

    let invalid_calendar = DatabaseViewConfig::Calendar(DatabaseCalendarViewConfig {
      title_field_id: title.id,
      date_field_id: text.id,
      visible_field_ids: vec![title.id, text.id],
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      date_mode: DatabaseCalendarDateMode::Month,
      initial_range: DatabaseCalendarInitialRange::CurrentMonth,
      group: None,
      subgroup: None,
    });
    let err = crate::database::views::rules::validate_view_config(
      DatabaseViewKind::Calendar,
      &invalid_calendar,
      &fields,
      max_fields,
    )
    .expect_err("calendar dateFieldId must point to a date field");
    assert_eq!(err.code, ERR_VIEW_DATE_FIELD_REQUIRED);

    let invalid_gallery = DatabaseViewConfig::Gallery(DatabaseGalleryViewConfig {
      title_field_id: title.id,
      visible_field_ids: vec![title.id],
      cover_field_id: Some(text.id),
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      card_density: DatabaseGalleryCardDensity::Large,
      show_empty_cover: true,
      group: None,
      subgroup: None,
    });
    let err = crate::database::views::rules::validate_view_config(
      DatabaseViewKind::Gallery,
      &invalid_gallery,
      &fields,
      max_fields,
    )
    .expect_err("gallery cover field must reject non-Files fields");
    assert_eq!(err.code, ERR_VIEW_COVER_FIELD_INVALID);

    let err =
      crate::database::views::rules::validate_view_config(DatabaseViewKind::Table, &timeline, &fields, max_fields)
        .expect_err("view kind/config mismatch must be specific");
    assert_eq!(err.code, ERR_VIEW_KIND_INVALID);
  }

  #[test]
  fn select_options_reject_raw_colors() {
    let config = DatabaseFieldConfig::Select(DatabaseSelectFieldConfig {
      options: vec![DatabaseSelectOption {
        id: "one".to_string(),
        name: "One".to_string(),
        position: 0,
        color_role: "#ff0000".to_string(),
      }],
    });
    let err = crate::database::definition::rules::validate_field_config(DatabaseFieldType::Select, &config)
      .expect_err("raw colors must not be valid product config");
    assert_eq!(err.code, ERR_FIELD_INVALID);
  }

  fn rollup_config(
    aggregate: DatabaseRollupAggregate,
    empty_value: Option<DatabaseRollupScalarValue>,
  ) -> DatabaseRollupFieldConfig {
    DatabaseRollupFieldConfig {
      source_relation_field_id: Uuid::new_v4(),
      target_field_id: Uuid::new_v4(),
      aggregate,
      empty_value,
      stale_policy: DatabaseRollupStalePolicy::Async,
    }
  }

  fn rollup_target(value: Option<DatabaseCellValueData>) -> DatabaseRollupTargetValue {
    DatabaseRollupTargetValue {
      target_row_id: Uuid::new_v4(),
      value,
    }
  }

  #[test]
  fn rollup_aggregates_count_and_count_values() {
    let targets = vec![
      rollup_target(Some(DatabaseCellValueData::Text("A".to_string()))),
      rollup_target(None),
      rollup_target(Some(DatabaseCellValueData::Text("B".to_string()))),
    ];
    let count =
      DatabaseProjectionService::compute_rollup_value(&rollup_config(DatabaseRollupAggregate::Count, None), &targets)
        .expect("count rollup");
    assert_eq!(count, Some(DatabaseRollupScalarValue::Number(3.0)));

    let count_values = DatabaseProjectionService::compute_rollup_value(
      &rollup_config(DatabaseRollupAggregate::CountValues, None),
      &targets,
    )
    .expect("count_values rollup");
    assert_eq!(count_values, Some(DatabaseRollupScalarValue::Number(2.0)));

    let unique = DatabaseProjectionService::compute_rollup_value(
      &rollup_config(DatabaseRollupAggregate::UniqueValues, None),
      &targets,
    )
    .expect("unique values rollup");
    assert_eq!(
      unique,
      Some(DatabaseRollupScalarValue::TextList(vec![
        "A".to_string(),
        "B".to_string()
      ]))
    );
  }

  #[test]
  fn rollup_number_aggregates_use_empty_value_when_no_numbers_exist() {
    let targets = vec![rollup_target(None)];
    let empty = Some(DatabaseRollupScalarValue::Number(-1.0));
    let value = DatabaseProjectionService::compute_rollup_value(
      &rollup_config(DatabaseRollupAggregate::Average, empty.clone()),
      &targets,
    )
    .expect("average rollup");
    assert_eq!(value, empty);
  }

  #[test]
  fn rollup_number_aggregates_compute_expected_values() {
    let targets = vec![
      rollup_target(Some(DatabaseCellValueData::Number(2.0))),
      rollup_target(Some(DatabaseCellValueData::Number(4.0))),
      rollup_target(Some(DatabaseCellValueData::Number(9.0))),
    ];
    for (aggregate, expected) in [
      (DatabaseRollupAggregate::Sum, 15.0),
      (DatabaseRollupAggregate::Average, 5.0),
      (DatabaseRollupAggregate::Min, 2.0),
      (DatabaseRollupAggregate::Max, 9.0),
    ] {
      let value =
        DatabaseProjectionService::compute_rollup_value(&rollup_config(aggregate, None), &targets).expect("rollup");
      assert_eq!(value, Some(DatabaseRollupScalarValue::Number(expected)));
    }
  }

  #[test]
  fn rollup_date_and_checkbox_aggregates_compute_expected_values() {
    let date_targets = vec![
      rollup_target(Some(DatabaseCellValueData::Date(DatabaseDateValue {
        start: NaiveDate::from_ymd_opt(2026, 7, 3).unwrap(),
        end: None,
      }))),
      rollup_target(Some(DatabaseCellValueData::Date(DatabaseDateValue {
        start: NaiveDate::from_ymd_opt(2026, 7, 1).unwrap(),
        end: Some(NaiveDate::from_ymd_opt(2026, 7, 5).unwrap()),
      }))),
    ];
    let earliest = DatabaseProjectionService::compute_rollup_value(
      &rollup_config(DatabaseRollupAggregate::Earliest, None),
      &date_targets,
    )
    .expect("earliest rollup");
    assert_eq!(
      earliest,
      Some(DatabaseRollupScalarValue::Date(DatabaseDateValue {
        start: NaiveDate::from_ymd_opt(2026, 7, 1).unwrap(),
        end: None,
      }))
    );
    let latest = DatabaseProjectionService::compute_rollup_value(
      &rollup_config(DatabaseRollupAggregate::Latest, None),
      &date_targets,
    )
    .expect("latest rollup");
    assert_eq!(
      latest,
      Some(DatabaseRollupScalarValue::Date(DatabaseDateValue {
        start: NaiveDate::from_ymd_opt(2026, 7, 5).unwrap(),
        end: None,
      }))
    );

    let checkbox_targets = vec![
      rollup_target(Some(DatabaseCellValueData::Checkbox(true))),
      rollup_target(Some(DatabaseCellValueData::Checkbox(false))),
      rollup_target(Some(DatabaseCellValueData::Checkbox(true))),
    ];
    let checked = DatabaseProjectionService::compute_rollup_value(
      &rollup_config(DatabaseRollupAggregate::CheckedPercent, None),
      &checkbox_targets,
    )
    .expect("checked_percent rollup");
    assert_rollup_number_close(checked, 200.0 / 3.0);
    let unchecked = DatabaseProjectionService::compute_rollup_value(
      &rollup_config(DatabaseRollupAggregate::UncheckedPercent, None),
      &checkbox_targets,
    )
    .expect("unchecked_percent rollup");
    assert_rollup_number_close(unchecked, 100.0 / 3.0);
  }

  fn assert_rollup_number_close(value: Option<DatabaseRollupScalarValue>, expected: f64) {
    let Some(DatabaseRollupScalarValue::Number(actual)) = value else {
      panic!("expected numeric rollup value");
    };
    assert!(
      (actual - expected).abs() < 0.000_001,
      "expected {expected}, got {actual}"
    );
  }

  #[test]
  fn rollup_aggregate_type_mismatch_fails_instead_of_silently_skipping() {
    let targets = vec![rollup_target(Some(DatabaseCellValueData::Text(
      "not a number".to_string(),
    )))];
    let err =
      DatabaseProjectionService::compute_rollup_value(&rollup_config(DatabaseRollupAggregate::Sum, None), &targets)
        .expect_err("number rollup must reject non-number data");
    assert_eq!(err.code, ERR_ROLLUP_RECOMPUTE_FAILED);
  }
}

fn workspace_lookup_error(error: crate::auth::AuthError) -> DatabaseServiceError {
  DatabaseServiceError::repository_storage(ERR_STORAGE, error.to_string())
}
