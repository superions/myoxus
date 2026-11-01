// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCsvDiagnostic")]
pub struct DatabaseCsvDiagnosticObjectType {
  pub code: String,
  pub source: String,
  pub row: Option<i32>,
  pub field: Option<String>,
  pub message: String,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCsvDetectedColumn")]
pub struct DatabaseCsvDetectedColumnObjectType {
  pub index: i32,
  pub source_header: String,
  pub field_name: String,
  pub field_type: DatabaseFieldKindType,
  pub is_title: bool,
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseCsvDelimiter", rename_items = "PascalCase")]
pub enum DatabaseCsvDelimiterType {
  Auto,
  Comma,
  Semicolon,
  Tab,
  Pipe,
  Custom,
}

impl From<domain::DatabaseCsvDelimiter> for DatabaseCsvDelimiterType {
  fn from(value: domain::DatabaseCsvDelimiter) -> Self {
    match value {
      domain::DatabaseCsvDelimiter::Auto => Self::Auto,
      domain::DatabaseCsvDelimiter::Comma => Self::Comma,
      domain::DatabaseCsvDelimiter::Semicolon => Self::Semicolon,
      domain::DatabaseCsvDelimiter::Tab => Self::Tab,
      domain::DatabaseCsvDelimiter::Pipe => Self::Pipe,
      domain::DatabaseCsvDelimiter::Custom => Self::Custom,
    }
  }
}

impl From<DatabaseCsvDelimiterType> for domain::DatabaseCsvDelimiter {
  fn from(value: DatabaseCsvDelimiterType) -> Self {
    match value {
      DatabaseCsvDelimiterType::Auto => Self::Auto,
      DatabaseCsvDelimiterType::Comma => Self::Comma,
      DatabaseCsvDelimiterType::Semicolon => Self::Semicolon,
      DatabaseCsvDelimiterType::Tab => Self::Tab,
      DatabaseCsvDelimiterType::Pipe => Self::Pipe,
      DatabaseCsvDelimiterType::Custom => Self::Custom,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseCsvQuoteStrategy", rename_items = "PascalCase")]
pub enum DatabaseCsvQuoteStrategyType {
  Minimal,
  All,
}

impl From<DatabaseCsvQuoteStrategyType> for domain::DatabaseCsvQuoteStrategy {
  fn from(value: DatabaseCsvQuoteStrategyType) -> Self {
    match value {
      DatabaseCsvQuoteStrategyType::Minimal => Self::Minimal,
      DatabaseCsvQuoteStrategyType::All => Self::All,
    }
  }
}

impl From<domain::DatabaseCsvQuoteStrategy> for DatabaseCsvQuoteStrategyType {
  fn from(value: domain::DatabaseCsvQuoteStrategy) -> Self {
    match value {
      domain::DatabaseCsvQuoteStrategy::Minimal => Self::Minimal,
      domain::DatabaseCsvQuoteStrategy::All => Self::All,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseCsvLocaleMode", rename_items = "PascalCase")]
pub enum DatabaseCsvLocaleModeType {
  Machine,
  Localized,
}

impl From<DatabaseCsvLocaleModeType> for domain::DatabaseCsvLocaleMode {
  fn from(value: DatabaseCsvLocaleModeType) -> Self {
    match value {
      DatabaseCsvLocaleModeType::Machine => Self::Machine,
      DatabaseCsvLocaleModeType::Localized => Self::Localized,
    }
  }
}

impl From<domain::DatabaseCsvLocaleMode> for DatabaseCsvLocaleModeType {
  fn from(value: domain::DatabaseCsvLocaleMode) -> Self {
    match value {
      domain::DatabaseCsvLocaleMode::Machine => Self::Machine,
      domain::DatabaseCsvLocaleMode::Localized => Self::Localized,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseCsvExportTarget", rename_items = "PascalCase")]
pub enum DatabaseCsvExportTargetType {
  Database,
  View,
  SelectedRows,
}

impl From<DatabaseCsvExportTargetType> for domain::DatabaseCsvExportTarget {
  fn from(value: DatabaseCsvExportTargetType) -> Self {
    match value {
      DatabaseCsvExportTargetType::Database => Self::Database,
      DatabaseCsvExportTargetType::View => Self::View,
      DatabaseCsvExportTargetType::SelectedRows => Self::SelectedRows,
    }
  }
}

impl From<domain::DatabaseCsvExportTarget> for DatabaseCsvExportTargetType {
  fn from(value: domain::DatabaseCsvExportTarget) -> Self {
    match value {
      domain::DatabaseCsvExportTarget::Database => Self::Database,
      domain::DatabaseCsvExportTarget::View => Self::View,
      domain::DatabaseCsvExportTarget::SelectedRows => Self::SelectedRows,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCsvDialect")]
pub struct DatabaseCsvDialectObjectType {
  pub delimiter: DatabaseCsvDelimiterType,
  pub custom_delimiter: Option<String>,
  pub quote: Option<String>,
  pub escape: Option<String>,
  pub double_quote: bool,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCsvAppliedColumnMapping")]
pub struct DatabaseCsvAppliedColumnMappingObjectType {
  pub source_index: i32,
  pub import_column: bool,
  pub source_header: String,
  pub field_name: String,
  pub field_type: DatabaseFieldKindType,
  pub is_title: bool,
}

#[derive(InputObject)]
pub struct DatabaseCsvAppliedColumnMappingInput {
  pub source_index: i32,
  pub import_column: bool,
  pub source_header: String,
  pub field_name: String,
  pub field_type: DatabaseFieldKindType,
  pub is_title: bool,
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseWorkspaceTagImportAction", rename_items = "PascalCase")]
pub enum DatabaseWorkspaceTagImportActionType {
  Create,
  Reuse,
  ArchivedReference,
  Rejected,
}

impl From<domain::DatabaseWorkspaceTagImportAction> for DatabaseWorkspaceTagImportActionType {
  fn from(value: domain::DatabaseWorkspaceTagImportAction) -> Self {
    match value {
      domain::DatabaseWorkspaceTagImportAction::Create => Self::Create,
      domain::DatabaseWorkspaceTagImportAction::Reuse => Self::Reuse,
      domain::DatabaseWorkspaceTagImportAction::ArchivedReference => Self::ArchivedReference,
      domain::DatabaseWorkspaceTagImportAction::Rejected => Self::Rejected,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseWorkspaceTagImportDiagnostic")]
pub struct DatabaseWorkspaceTagImportDiagnosticObjectType {
  pub source_id: Option<ID>,
  pub target_id: Option<ID>,
  pub name: String,
  pub slug: String,
  pub source_color: Option<String>,
  pub color_role: String,
  pub action: DatabaseWorkspaceTagImportActionType,
  pub affected_rows: Vec<i32>,
  pub affected_fields: Vec<String>,
  pub message: String,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCsvPreview")]
pub struct DatabaseCsvPreviewObjectType {
  pub detected_delimiter: String,
  pub detected_dialect: DatabaseCsvDialectObjectType,
  pub applied_dialect: DatabaseCsvDialectObjectType,
  pub detected_columns: Vec<DatabaseCsvDetectedColumnObjectType>,
  pub applied_mapping: Vec<DatabaseCsvAppliedColumnMappingObjectType>,
  pub confidence: String,
  pub inferred_fields: Vec<DatabaseFieldObjectType>,
  pub row_count: i32,
  pub errors: Vec<DatabaseCsvDiagnosticObjectType>,
  pub warnings: Vec<DatabaseCsvDiagnosticObjectType>,
  pub workspace_tag_diagnostics: Vec<DatabaseWorkspaceTagImportDiagnosticObjectType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCsvImportResult")]
pub struct DatabaseCsvImportResultObjectType {
  pub database: DatabaseRecordObjectType,
  pub created_field_count: i32,
  pub created_row_count: i32,
  pub created_doc_count: i32,
  pub skipped_row_count: i32,
  pub errors: Vec<DatabaseCsvDiagnosticObjectType>,
  pub warnings: Vec<DatabaseCsvDiagnosticObjectType>,
  pub workspace_tag_diagnostics: Vec<DatabaseWorkspaceTagImportDiagnosticObjectType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCsvExport")]
pub struct DatabaseCsvExportObjectType {
  pub file_name: String,
  pub content_type: String,
  pub content: String,
  pub row_count: i32,
  pub column_count: i32,
  pub database_id: ID,
  pub view_id: Option<ID>,
  pub target: DatabaseCsvExportTargetType,
  pub include_header: bool,
  pub quote_strategy: DatabaseCsvQuoteStrategyType,
  pub locale_mode: DatabaseCsvLocaleModeType,
  pub locale: Option<String>,
  pub warnings: Vec<DatabaseCsvDiagnosticObjectType>,
  pub workspace_tag_diagnostics: Vec<DatabaseWorkspaceTagImportDiagnosticObjectType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCsvMappingTemplate")]
pub struct DatabaseCsvMappingTemplateObjectType {
  pub id: ID,
  pub workspace_id: ID,
  pub name: String,
  pub revision: i32,
  pub is_current: bool,
  pub dialect: DatabaseCsvDialectObjectType,
  pub first_row_is_header: bool,
  pub mapping: Vec<DatabaseCsvAppliedColumnMappingObjectType>,
  pub created_by: ID,
  pub created_at: chrono::DateTime<chrono::Utc>,
  pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCsvMappingTemplateSummary")]
pub struct DatabaseCsvMappingTemplateSummaryObjectType {
  pub id: ID,
  pub name: String,
  pub revision: i32,
  pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(InputObject)]
pub struct SaveDatabaseCsvMappingTemplateInput {
  pub workspace_id: ID,
  pub name: String,
  pub dialect: Option<DatabaseCsvDialectInput>,
  pub first_row_is_header: Option<bool>,
  pub mapping: Vec<DatabaseCsvAppliedColumnMappingInput>,
}

#[derive(InputObject)]
pub struct LoadDatabaseCsvMappingTemplateInput {
  pub workspace_id: ID,
  pub name: String,
}

#[derive(InputObject)]
pub struct DeleteDatabaseCsvMappingTemplateInput {
  pub workspace_id: ID,
  pub name: String,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseJsonDiagnostic")]
pub struct DatabaseJsonDiagnosticObjectType {
  pub code: String,
  pub source: String,
  pub path: Option<String>,
  pub message: String,
}

/// P-DB-28: import mode enum mirrored from
/// `domain::DatabaseJsonImportMode`. Used by every JSON import
/// endpoint and by the import wizard's mode selector.
#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(name = "DatabaseJsonImportModeType")]
pub enum DatabaseJsonImportModeType {
  Create,
  Replace,
  Merge,
}

/// P-DB-28: conflict handling when a snapshot row collides with an
/// existing target Database row on the UniqueId field.
#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(name = "DatabaseJsonConflictStrategyType")]
pub enum DatabaseJsonConflictStrategyType {
  Abort,
  Rename,
  Overwrite,
}

impl From<DatabaseJsonImportModeType> for domain::DatabaseJsonImportMode {
  fn from(value: DatabaseJsonImportModeType) -> Self {
    match value {
      DatabaseJsonImportModeType::Create => domain::DatabaseJsonImportMode::Create,
      DatabaseJsonImportModeType::Replace => domain::DatabaseJsonImportMode::Replace,
      DatabaseJsonImportModeType::Merge => domain::DatabaseJsonImportMode::Merge,
    }
  }
}

impl From<domain::DatabaseJsonImportMode> for DatabaseJsonImportModeType {
  fn from(value: domain::DatabaseJsonImportMode) -> Self {
    match value {
      domain::DatabaseJsonImportMode::Create => DatabaseJsonImportModeType::Create,
      domain::DatabaseJsonImportMode::Replace => DatabaseJsonImportModeType::Replace,
      domain::DatabaseJsonImportMode::Merge => DatabaseJsonImportModeType::Merge,
    }
  }
}

impl From<DatabaseJsonConflictStrategyType> for domain::DatabaseJsonConflictStrategy {
  fn from(value: DatabaseJsonConflictStrategyType) -> Self {
    match value {
      DatabaseJsonConflictStrategyType::Abort => domain::DatabaseJsonConflictStrategy::Abort,
      DatabaseJsonConflictStrategyType::Rename => domain::DatabaseJsonConflictStrategy::Rename,
      DatabaseJsonConflictStrategyType::Overwrite => domain::DatabaseJsonConflictStrategy::Overwrite,
    }
  }
}

impl From<domain::DatabaseJsonConflictStrategy> for DatabaseJsonConflictStrategyType {
  fn from(value: domain::DatabaseJsonConflictStrategy) -> Self {
    match value {
      domain::DatabaseJsonConflictStrategy::Abort => DatabaseJsonConflictStrategyType::Abort,
      domain::DatabaseJsonConflictStrategy::Rename => DatabaseJsonConflictStrategyType::Rename,
      domain::DatabaseJsonConflictStrategy::Overwrite => DatabaseJsonConflictStrategyType::Overwrite,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseJsonPreview")]
pub struct DatabaseJsonPreviewObjectType {
  pub schema_version: i32,
  pub schema_version_supported: bool,
  pub title: String,
  pub field_count: i32,
  pub view_count: i32,
  pub row_count: i32,
  pub template_count: i32,
  pub file_manifest_count: i32,
  pub matched_page_count: i32,
  pub content_document_count: i32,
  pub empty_page_count: i32,
  pub body_block_count: i32,
  pub rewritten_internal_link_count: i32,
  pub export_actor: Option<String>,
  pub exported_at: Option<String>,
  pub default_mode: DatabaseJsonImportModeType,
  pub default_conflict_strategy: DatabaseJsonConflictStrategyType,
  pub warnings: Vec<DatabaseJsonDiagnosticObjectType>,
  pub errors: Vec<DatabaseJsonDiagnosticObjectType>,
  pub workspace_tag_diagnostics: Vec<DatabaseWorkspaceTagImportDiagnosticObjectType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseJsonImportResult")]
pub struct DatabaseJsonImportResultObjectType {
  pub database: DatabaseRecordObjectType,
  pub mode: DatabaseJsonImportModeType,
  pub conflict_strategy: DatabaseJsonConflictStrategyType,
  pub dry_run: bool,
  pub created_field_count: i32,
  pub created_view_count: i32,
  pub created_row_count: i32,
  pub updated_row_count: i32,
  pub skipped_row_count: i32,
  pub created_template_count: i32,
  pub missing_file_count: i32,
  pub warnings: Vec<DatabaseJsonDiagnosticObjectType>,
  pub conflict_warnings: Vec<DatabaseJsonDiagnosticObjectType>,
  pub workspace_tag_diagnostics: Vec<DatabaseWorkspaceTagImportDiagnosticObjectType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseJsonExport")]
pub struct DatabaseJsonExportObjectType {
  pub file_name: String,
  pub content_type: String,
  pub content: String,
}

#[derive(InputObject)]
pub struct DatabaseCsvDialectInput {
  pub delimiter: Option<DatabaseCsvDelimiterType>,
  pub custom_delimiter: Option<String>,
  pub quote: Option<String>,
  pub escape: Option<String>,
  pub double_quote: Option<bool>,
}

#[derive(InputObject)]
pub struct DatabaseCsvColumnMappingInput {
  pub source_index: i32,
  pub import_column: Option<bool>,
  pub field_name: Option<String>,
  pub field_type: Option<DatabaseFieldKindType>,
  pub is_title: Option<bool>,
}

/// Quote strategy applied to CSV export. `MINIMAL` (default) only
/// quotes fields that contain the delimiter, the quote byte, a
/// newline, or leading/trailing whitespace. `ALL` quotes every
/// field so the consumer can rely on positional round-trips
/// regardless of cell content.
#[derive(InputObject)]
pub struct DatabaseCsvExportOptionsInput {
  pub dialect: Option<DatabaseCsvDialectInput>,
  pub include_header: Option<bool>,
  pub quote_strategy: Option<DatabaseCsvQuoteStrategyType>,
  pub locale_mode: Option<DatabaseCsvLocaleModeType>,
  pub locale: Option<String>,
  pub target: Option<DatabaseCsvExportTargetType>,
  pub view_id: Option<ID>,
  pub row_ids: Option<Vec<ID>>,
}

#[derive(InputObject)]
pub struct PreviewDatabaseCsvImportInput {
  pub workspace_id: ID,
  pub database_title: String,
  pub dialect: Option<DatabaseCsvDialectInput>,
  pub first_row_is_header: Option<bool>,
  pub mapping: Option<Vec<DatabaseCsvColumnMappingInput>>,
}

#[derive(InputObject)]
pub struct ImportDatabaseCsvInput {
  pub workspace_id: ID,
  pub database_title: String,
  pub dialect: Option<DatabaseCsvDialectInput>,
  pub first_row_is_header: Option<bool>,
  pub mapping: Option<Vec<DatabaseCsvColumnMappingInput>>,
}

#[derive(InputObject)]
pub struct ExportDatabaseCsvInput {
  pub database_id: ID,
  /// All P-DB-27 export knobs. When omitted the server falls back
  /// to a default export (whole database, view id from the first
  /// view, header row, minimal quoting, machine-readable locale).
  pub options: Option<DatabaseCsvExportOptionsInput>,
}

#[derive(InputObject)]
pub struct PreviewDatabaseJsonImportInput {
  pub workspace_id: ID,
  /// Existing managed imports preview against their actual protected definition.
  pub target_database_id: Option<ID>,
  #[graphql(default)]
  pub mode: Option<DatabaseJsonImportModeType>,
  #[graphql(default)]
  pub conflict_strategy: Option<DatabaseJsonConflictStrategyType>,
}

#[derive(InputObject)]
pub struct ImportDatabaseJsonInput {
  pub workspace_id: ID,
  #[graphql(default)]
  pub mode: Option<DatabaseJsonImportModeType>,
  #[graphql(default)]
  pub conflict_strategy: Option<DatabaseJsonConflictStrategyType>,
  /// Required for `mode=Replace` or `mode=Merge`. Must live in the
  /// same workspace.
  #[graphql(default)]
  pub target_database_id: Option<ID>,
  /// When `true`, no rows are persisted and the response is purely
  /// informational.
  #[graphql(default)]
  pub dry_run: Option<bool>,
  /// Required for `mode=Replace`. The wizard must set this to `true`
  /// to confirm the operator intentionally wants a destructive
  /// import.
  #[graphql(default)]
  pub confirm_destructive: Option<bool>,
  /// Per-snapshot-field-id mapping: either an existing target field
  /// id (UUID) or `new:<field name>` to allocate a fresh field on the
  /// target Database. Used for `mode=Merge`.
  #[graphql(default)]
  pub field_mapping: Option<Vec<DatabaseJsonImportFieldMappingInput>>,
}

#[derive(InputObject)]
pub struct DatabaseJsonImportFieldMappingInput {
  pub snapshot_field_id: String,
  /// Either an existing target field id, or `new:<field name>`.
  pub target: String,
}

#[derive(InputObject)]
pub struct ExportDatabaseJsonInput {
  pub database_id: ID,
}

#[derive(InputObject)]
pub struct LegacyDatabaseMigrationInput {
  pub workspace_id: ID,
  pub document_ids: Vec<ID>,
}

#[derive(SimpleObject)]
pub struct LegacyDatabaseMigrationReferenceObjectType {
  pub source_document_id: ID,
  pub block_id: String,
  pub target_database_id: ID,
  pub target_view_id: Option<ID>,
  pub already_migrated: bool,
}

/// Redacted persisted-document migration plan.
///
/// The API intentionally projects identities, aggregate counts and diagnostics
/// only. Legacy field, row, cell and Yjs payloads stay inside the server-owned
/// migration boundary.
#[derive(SimpleObject)]
pub struct LegacyDatabaseMigrationPlanObjectType {
  pub database_ids: Vec<ID>,
  pub block_references: Vec<LegacyDatabaseMigrationReferenceObjectType>,
  pub field_count: i64,
  pub row_count: i64,
  pub cell_count: i64,
  pub view_count: i64,
  pub diagnostics: Vec<crate::graphql::auth::WorkspaceImportDiagnosticType>,
  pub apply_allowed: bool,
}

#[derive(SimpleObject)]
pub struct LegacyDatabaseMigrationApplyObjectType {
  pub plan: LegacyDatabaseMigrationPlanObjectType,
  pub created_database_ids: Vec<ID>,
  pub migrated_block_count: i64,
}

fn parse_legacy_migration_document_ids(document_ids: Vec<ID>) -> Result<Vec<Uuid>> {
  if document_ids.is_empty() {
    return Err(database_error(
      "MIX_WORKSPACE_IMPORT_DOCUMENT_INVALID",
      "at least one document id is required for legacy Database migration",
    ));
  }
  document_ids.iter().map(|id| parse_uuid_id(id, "documentIds")).collect()
}

fn map_legacy_database_migration_plan(plan: LegacyDatabaseMigrationPlan) -> LegacyDatabaseMigrationPlanObjectType {
  LegacyDatabaseMigrationPlanObjectType {
    database_ids: plan
      .databases
      .iter()
      .map(|database| ID(database.target_id.to_string()))
      .collect(),
    block_references: plan
      .block_references
      .into_iter()
      .map(|reference| LegacyDatabaseMigrationReferenceObjectType {
        source_document_id: ID(reference.source_document_id),
        block_id: reference.block_id,
        target_database_id: ID(reference.target_database_id.to_string()),
        target_view_id: reference.target_view_id.map(|id| ID(id.to_string())),
        already_migrated: reference.already_migrated,
      })
      .collect(),
    field_count: plan.field_count as i64,
    row_count: plan.row_count as i64,
    cell_count: plan.cell_count as i64,
    view_count: plan.view_count as i64,
    diagnostics: plan
      .diagnostics
      .into_iter()
      .map(crate::graphql::auth::map_workspace_import_diagnostic)
      .collect(),
    apply_allowed: plan.apply_allowed,
  }
}

fn map_legacy_database_migration_apply(
  result: LegacyDatabaseMigrationApplyResult,
) -> LegacyDatabaseMigrationApplyObjectType {
  LegacyDatabaseMigrationApplyObjectType {
    plan: map_legacy_database_migration_plan(result.plan),
    created_database_ids: result
      .created_database_ids
      .into_iter()
      .map(|id| ID(id.to_string()))
      .collect(),
    migrated_block_count: result.migrated_block_count as i64,
  }
}

fn map_csv_diagnostic(diagnostic: domain::DatabaseCsvDiagnostic) -> DatabaseCsvDiagnosticObjectType {
  DatabaseCsvDiagnosticObjectType {
    code: diagnostic.code,
    source: diagnostic.source,
    row: diagnostic.row,
    field: diagnostic.field,
    message: diagnostic.message,
  }
}

fn map_csv_detected_column(column: domain::DatabaseCsvDetectedColumn) -> DatabaseCsvDetectedColumnObjectType {
  DatabaseCsvDetectedColumnObjectType {
    index: column.index,
    source_header: column.source_header,
    field_name: column.field_name,
    field_type: column.field_type.into(),
    is_title: column.is_title,
  }
}

fn map_csv_dialect_input(input: Option<DatabaseCsvDialectInput>) -> domain::DatabaseCsvDialect {
  let Some(input) = input else {
    return domain::DatabaseCsvDialect::default();
  };
  domain::DatabaseCsvDialect {
    delimiter: input
      .delimiter
      .map(Into::into)
      .unwrap_or(domain::DatabaseCsvDelimiter::Auto),
    custom_delimiter: input.custom_delimiter,
    quote: input.quote,
    escape: input.escape,
    double_quote: input.double_quote.unwrap_or(true),
  }
}

fn map_csv_options(
  input: Option<DatabaseCsvExportOptionsInput>,
) -> Result<domain::DatabaseCsvExportOptions, async_graphql::Error> {
  let Some(input) = input else {
    // P-DB-27: when the caller omits `options` entirely we still want
    // a usable export. Fall back to a Comma-delimited RFC 4180 export
    // with the header row, instead of rejecting the request because
    // the caller did not pick a delimiter explicitly. Auto-detect is
    // reserved for callers that opt in via `dialect.delimiter: Auto`.
    let mut options = domain::DatabaseCsvExportOptions {
      include_header: true,
      ..domain::DatabaseCsvExportOptions::default()
    };
    options.dialect.delimiter = domain::DatabaseCsvDelimiter::Comma;
    return Ok(options);
  };
  let view_id = match input.view_id {
    Some(id) => Some(parse_uuid_id(&id, "viewId")?),
    None => None,
  };
  let row_ids = match input.row_ids {
    Some(values) if !values.is_empty() => values
      .into_iter()
      .map(|id| parse_uuid_id(&id, "rowIds"))
      .collect::<Result<Vec<_>>>()?,
    _ => Vec::new(),
  };
  // Same default-comma rule when the caller passes an options object
  // but does not specify a dialect. Explicit `Auto` still routes
  // through the application-level guard.
  let dialect = match input.dialect {
    Some(dialect) => map_csv_dialect_input(Some(dialect)),
    None => domain::DatabaseCsvDialect {
      delimiter: domain::DatabaseCsvDelimiter::Comma,
      ..domain::DatabaseCsvDialect::default()
    },
  };
  Ok(domain::DatabaseCsvExportOptions {
    dialect,
    include_header: input.include_header.unwrap_or(true),
    quote_strategy: input.quote_strategy.map(Into::into).unwrap_or_default(),
    locale_mode: input.locale_mode.map(Into::into).unwrap_or_default(),
    locale: input.locale,
    target: input.target.map(Into::into).unwrap_or_default(),
    view_id,
    row_ids,
  })
}

fn map_csv_import_options(
  dialect: Option<DatabaseCsvDialectInput>,
  first_row_is_header: Option<bool>,
  mapping: Option<Vec<DatabaseCsvColumnMappingInput>>,
) -> domain::DatabaseCsvImportOptions {
  domain::DatabaseCsvImportOptions {
    dialect: map_csv_dialect_input(dialect),
    first_row_is_header,
    mapping: mapping
      .unwrap_or_default()
      .into_iter()
      .map(|item| domain::DatabaseCsvColumnMapping {
        source_index: item.source_index,
        import_column: item.import_column.unwrap_or(true),
        field_name: item.field_name,
        field_type: item.field_type.map(Into::into),
        is_title: item.is_title.unwrap_or(false),
      })
      .collect(),
  }
}

fn map_csv_dialect(dialect: domain::DatabaseCsvDialect) -> DatabaseCsvDialectObjectType {
  DatabaseCsvDialectObjectType {
    delimiter: dialect.delimiter.into(),
    custom_delimiter: dialect.custom_delimiter,
    quote: dialect.quote,
    escape: dialect.escape,
    double_quote: dialect.double_quote,
  }
}

fn map_csv_applied_column_mapping(
  column: domain::DatabaseCsvAppliedColumnMapping,
) -> DatabaseCsvAppliedColumnMappingObjectType {
  DatabaseCsvAppliedColumnMappingObjectType {
    source_index: column.source_index,
    import_column: column.import_column,
    source_header: column.source_header,
    field_name: column.field_name,
    field_type: column.field_type.into(),
    is_title: column.is_title,
  }
}

fn map_csv_preview(preview: domain::DatabaseCsvPreview) -> DatabaseCsvPreviewObjectType {
  DatabaseCsvPreviewObjectType {
    detected_delimiter: preview.detected_delimiter,
    detected_dialect: map_csv_dialect(preview.detected_dialect),
    applied_dialect: map_csv_dialect(preview.applied_dialect),
    detected_columns: preview
      .detected_columns
      .into_iter()
      .map(map_csv_detected_column)
      .collect(),
    applied_mapping: preview
      .applied_mapping
      .into_iter()
      .map(map_csv_applied_column_mapping)
      .collect(),
    confidence: preview.confidence,
    inferred_fields: preview.inferred_fields.into_iter().map(map_field).collect(),
    row_count: preview.row_count,
    errors: preview.errors.into_iter().map(map_csv_diagnostic).collect(),
    warnings: preview.warnings.into_iter().map(map_csv_diagnostic).collect(),
    workspace_tag_diagnostics: preview
      .workspace_tag_diagnostics
      .into_iter()
      .map(map_workspace_tag_import_diagnostic)
      .collect(),
  }
}

fn map_csv_import_result(result: domain::DatabaseCsvImportResult) -> DatabaseCsvImportResultObjectType {
  DatabaseCsvImportResultObjectType {
    database: map_record(result.database),
    created_field_count: result.created_field_count,
    created_row_count: result.created_row_count,
    created_doc_count: result.created_doc_count,
    skipped_row_count: result.skipped_row_count,
    errors: result.errors.into_iter().map(map_csv_diagnostic).collect(),
    warnings: result.warnings.into_iter().map(map_csv_diagnostic).collect(),
    workspace_tag_diagnostics: result
      .workspace_tag_diagnostics
      .into_iter()
      .map(map_workspace_tag_import_diagnostic)
      .collect(),
  }
}

fn map_csv_export(export: domain::DatabaseCsvExport) -> DatabaseCsvExportObjectType {
  DatabaseCsvExportObjectType {
    file_name: export.file_name,
    content_type: export.content_type,
    content: export.content,
    row_count: export.row_count,
    column_count: export.column_count,
    database_id: ID::from(export.database_id.to_string()),
    view_id: export.view_id.map(|id| ID::from(id.to_string())),
    target: export.target.into(),
    include_header: export.include_header,
    quote_strategy: export.quote_strategy.into(),
    locale_mode: export.locale_mode.into(),
    locale: export.locale,
    warnings: export.warnings.into_iter().map(map_csv_diagnostic).collect(),
    workspace_tag_diagnostics: export
      .workspace_tag_diagnostics
      .into_iter()
      .map(map_workspace_tag_import_diagnostic)
      .collect(),
  }
}

fn map_csv_mapping_template(template: domain::DatabaseCsvMappingTemplate) -> DatabaseCsvMappingTemplateObjectType {
  DatabaseCsvMappingTemplateObjectType {
    id: ID::from(template.id.to_string()),
    workspace_id: ID::from(template.workspace_id.to_string()),
    name: template.name,
    revision: template.revision,
    is_current: template.is_current,
    dialect: map_csv_dialect(template.dialect),
    first_row_is_header: template.first_row_is_header,
    mapping: template
      .mapping
      .into_iter()
      .map(map_csv_applied_column_mapping)
      .collect(),
    created_by: ID::from(template.created_by.to_string()),
    created_at: template.created_at,
    updated_at: template.updated_at,
  }
}

fn map_csv_mapping_template_summary(
  template: domain::DatabaseCsvMappingTemplateSummary,
) -> DatabaseCsvMappingTemplateSummaryObjectType {
  DatabaseCsvMappingTemplateSummaryObjectType {
    id: ID::from(template.id.to_string()),
    name: template.name,
    revision: template.revision,
    updated_at: template.updated_at,
  }
}

fn map_json_diagnostic(diagnostic: domain::DatabaseJsonDiagnostic) -> DatabaseJsonDiagnosticObjectType {
  DatabaseJsonDiagnosticObjectType {
    code: diagnostic.code,
    source: diagnostic.source,
    path: diagnostic.path,
    message: diagnostic.message,
  }
}

fn map_workspace_tag_import_diagnostic(
  diagnostic: domain::DatabaseWorkspaceTagImportDiagnostic,
) -> DatabaseWorkspaceTagImportDiagnosticObjectType {
  DatabaseWorkspaceTagImportDiagnosticObjectType {
    source_id: diagnostic.source_id.map(|id| ID::from(id.to_string())),
    target_id: diagnostic.target_id.map(|id| ID::from(id.to_string())),
    name: diagnostic.name,
    slug: diagnostic.slug,
    source_color: diagnostic.source_color,
    color_role: diagnostic.color_role,
    action: diagnostic.action.into(),
    affected_rows: diagnostic.affected_rows,
    affected_fields: diagnostic.affected_fields,
    message: diagnostic.message,
  }
}

fn map_json_preview(preview: domain::DatabaseJsonPreview) -> DatabaseJsonPreviewObjectType {
  DatabaseJsonPreviewObjectType {
    schema_version: preview.schema_version as i32,
    schema_version_supported: preview.schema_version_supported,
    title: preview.title,
    field_count: preview.field_count,
    view_count: preview.view_count,
    row_count: preview.row_count,
    template_count: preview.template_count,
    file_manifest_count: preview.file_manifest_count,
    matched_page_count: preview.matched_page_count,
    content_document_count: preview.content_document_count,
    empty_page_count: preview.empty_page_count,
    body_block_count: preview.body_block_count,
    rewritten_internal_link_count: preview.rewritten_internal_link_count,
    export_actor: preview.export_actor,
    exported_at: preview.exported_at.map(|value| value.to_rfc3339()),
    default_mode: preview.default_mode.into(),
    default_conflict_strategy: preview.default_conflict_strategy.into(),
    warnings: preview.warnings.into_iter().map(map_json_diagnostic).collect(),
    errors: preview.errors.into_iter().map(map_json_diagnostic).collect(),
    workspace_tag_diagnostics: preview
      .workspace_tag_diagnostics
      .into_iter()
      .map(map_workspace_tag_import_diagnostic)
      .collect(),
  }
}

fn map_json_import_result(result: domain::DatabaseJsonImportResult) -> DatabaseJsonImportResultObjectType {
  DatabaseJsonImportResultObjectType {
    database: map_record(result.database),
    mode: result.mode.into(),
    conflict_strategy: result.conflict_strategy.into(),
    dry_run: result.dry_run,
    created_field_count: result.created_field_count,
    created_view_count: result.created_view_count,
    created_row_count: result.created_row_count,
    updated_row_count: result.updated_row_count,
    skipped_row_count: result.skipped_row_count,
    created_template_count: result.created_template_count,
    missing_file_count: result.missing_file_count,
    warnings: result.warnings.into_iter().map(map_json_diagnostic).collect(),
    conflict_warnings: result.conflict_warnings.into_iter().map(map_json_diagnostic).collect(),
    workspace_tag_diagnostics: result
      .workspace_tag_diagnostics
      .into_iter()
      .map(map_workspace_tag_import_diagnostic)
      .collect(),
  }
}

fn map_json_export(export: domain::DatabaseJsonExport) -> DatabaseJsonExportObjectType {
  DatabaseJsonExportObjectType {
    file_name: export.filename,
    content_type: export.content_type,
    content: export.content,
  }
}

pub(crate) async fn preview_legacy_database_migration(
  ctx: &Context<'_>,
  input: LegacyDatabaseMigrationInput,
) -> Result<LegacyDatabaseMigrationPlanObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let document_ids = parse_legacy_migration_document_ids(input.document_ids)?;
  let limits = legacy_database_migration_limits(&state).await;
  let plan = service(&state)?
    .import_export
    .preview_legacy_database_migration(snapshot.user.id, workspace_id, &document_ids, limits)
    .await
    .map_err(map_database_error)?;
  Ok(map_legacy_database_migration_plan(plan))
}

pub(crate) async fn apply_legacy_database_migration(
  ctx: &Context<'_>,
  input: LegacyDatabaseMigrationInput,
) -> Result<LegacyDatabaseMigrationApplyObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let document_ids = parse_legacy_migration_document_ids(input.document_ids)?;
  let limits = legacy_database_migration_limits(&state).await;
  let result = service(&state)?
    .import_export
    .apply_legacy_database_migration(snapshot.user.id, workspace_id, &document_ids, limits)
    .await
    .map_err(map_database_error)?;
  Ok(map_legacy_database_migration_apply(result))
}

async fn legacy_database_migration_limits(state: &ApiState) -> myoxus_workspace_import::WorkspaceImportLimits {
  crate::workspace_import::ApiWorkspaceImportPolicyProvider::new(state.config.clone(), state.config_overrides.clone())
    .current_policy()
    .await
    .limits
}

pub(crate) async fn export_database_csv_query(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
  options: Option<DatabaseCsvExportOptionsInput>,
) -> Result<DatabaseCsvExportObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&database_id, "databaseId")?;
  let record = service(&state)?
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  if record.database.workspace_id != workspace_id {
    return Err(database_error("MIX_DATABASE_NOT_FOUND", "database not found"));
  }
  let options = map_csv_options(options)?;
  let export = service(&state)?
    .import_export
    .export_csv_with_options(snapshot.user.id, database_id, options)
    .await
    .map_err(map_database_error)?;
  Ok(map_csv_export(export))
}

pub(crate) async fn database_csv_mapping_templates_query(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
) -> Result<Vec<DatabaseCsvMappingTemplateSummaryObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let templates = service(&state)?
    .import_export
    .list_csv_mapping_templates(snapshot.user.id, workspace_id)
    .await
    .map_err(map_database_error)?;
  Ok(
    templates
      .into_iter()
      .map(|template| {
        map_csv_mapping_template_summary(domain::DatabaseCsvMappingTemplateSummary {
          id: template.id,
          name: template.name,
          revision: template.revision,
          updated_at: template.updated_at,
        })
      })
      .collect(),
  )
}

pub(crate) async fn export_database_json_query(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
) -> Result<DatabaseJsonExportObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&database_id, "databaseId")?;
  let record = service(&state)?
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  if record.database.workspace_id != workspace_id {
    return Err(database_error("MIX_DATABASE_NOT_FOUND", "database not found"));
  }
  let export = service(&state)?
    .import_export
    .export_json(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  Ok(map_json_export(export))
}

pub(crate) async fn preview_database_csv_import(
  ctx: &Context<'_>,
  file: Upload,
  input: PreviewDatabaseCsvImportInput,
) -> Result<DatabaseCsvPreviewObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let service = service(&state)?;
  let content = read_csv_upload(ctx, file, service.import_export.limits().csv_max_bytes)?;
  let options = map_csv_import_options(input.dialect, input.first_row_is_header, input.mapping);
  let preview = service
    .import_export
    .preview_csv_import(
      snapshot.user.id,
      workspace_id,
      input.database_title,
      content.as_slice(),
      options,
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_csv_preview(preview))
}

pub(crate) async fn import_database_csv(
  ctx: &Context<'_>,
  file: Upload,
  input: ImportDatabaseCsvInput,
) -> Result<DatabaseCsvImportResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let service = service(&state)?;
  let content = read_csv_upload(ctx, file, service.import_export.limits().csv_max_bytes)?;
  let options = map_csv_import_options(input.dialect, input.first_row_is_header, input.mapping);
  let result = service
    .import_export
    .import_csv(
      snapshot.user.id,
      workspace_id,
      input.database_title,
      content.as_slice(),
      options,
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_csv_import_result(result))
}

pub(crate) async fn preview_database_json_import(
  ctx: &Context<'_>,
  file: Upload,
  input: PreviewDatabaseJsonImportInput,
) -> Result<DatabaseJsonPreviewObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let service = service(&state)?;
  let content = read_json_upload(ctx, file, service.import_export.limits().csv_max_bytes)?;
  let options = domain::DatabaseJsonImportOptions {
    mode: input.mode.map(Into::into).unwrap_or_default(),
    conflict_strategy: input.conflict_strategy.map(Into::into).unwrap_or_default(),
    target_database_id: input
      .target_database_id
      .as_ref()
      .map(|id| parse_uuid_id(id, "targetDatabaseId"))
      .transpose()?,
    ..domain::DatabaseJsonImportOptions::default()
  };
  let preview = service
    .import_export
    .preview_json_import_with_options(snapshot.user.id, workspace_id, content.as_slice(), options)
    .await
    .map_err(map_database_error)?;
  Ok(map_json_preview(preview))
}

pub(crate) async fn import_database_json(
  ctx: &Context<'_>,
  file: Upload,
  input: ImportDatabaseJsonInput,
) -> Result<DatabaseJsonImportResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let service = service(&state)?;
  let content = read_json_upload(ctx, file, service.import_export.limits().csv_max_bytes)?;
  let mut field_mapping: BTreeMap<String, String> = BTreeMap::new();
  if let Some(mappings) = input.field_mapping {
    for entry in mappings {
      field_mapping.insert(entry.snapshot_field_id, entry.target);
    }
  }
  let target_database_id = match input.target_database_id.as_ref() {
    Some(raw) => Some(parse_uuid_id(raw, "targetDatabaseId")?),
    None => None,
  };
  let options = domain::DatabaseJsonImportOptions {
    mode: input.mode.map(Into::into).unwrap_or_default(),
    conflict_strategy: input.conflict_strategy.map(Into::into).unwrap_or_default(),
    target_workspace_id: Some(workspace_id),
    target_database_id,
    dry_run: input.dry_run.unwrap_or(false),
    field_mapping,
    confirm_destructive: input.confirm_destructive.unwrap_or(false),
  };
  let result = service
    .import_export
    .import_json_with_options(snapshot.user.id, workspace_id, content.as_slice(), options, None)
    .await
    .map_err(map_database_error)?;
  Ok(map_json_import_result(result))
}

pub(crate) async fn preview_database_notion_import(
  ctx: &Context<'_>,
  file: Upload,
  input: PreviewDatabaseJsonImportInput,
) -> Result<DatabaseJsonPreviewObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let service = service(&state)?;
  let content = read_json_upload(ctx, file, service.import_export.limits().notion_max_bytes)?;
  let preview = service
    .import_export
    .preview_notion_import(snapshot.user.id, workspace_id, content.as_slice())
    .await
    .map_err(map_database_error)?;
  Ok(map_json_preview(preview))
}

pub(crate) async fn import_database_notion(
  ctx: &Context<'_>,
  file: Upload,
  input: ImportDatabaseJsonInput,
) -> Result<DatabaseJsonImportResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let service = service(&state)?;
  let content = read_json_upload(ctx, file, service.import_export.limits().notion_max_bytes)?;
  let mut field_mapping: BTreeMap<String, String> = BTreeMap::new();
  if let Some(mappings) = input.field_mapping {
    for entry in mappings {
      field_mapping.insert(entry.snapshot_field_id, entry.target);
    }
  }
  let target_database_id = match input.target_database_id.as_ref() {
    Some(raw) => Some(parse_uuid_id(raw, "targetDatabaseId")?),
    None => None,
  };
  let options = domain::DatabaseJsonImportOptions {
    mode: input.mode.map(Into::into).unwrap_or_default(),
    conflict_strategy: input.conflict_strategy.map(Into::into).unwrap_or_default(),
    target_workspace_id: Some(workspace_id),
    target_database_id,
    dry_run: input.dry_run.unwrap_or(false),
    field_mapping,
    confirm_destructive: input.confirm_destructive.unwrap_or(false),
  };
  let result = service
    .import_export
    .import_notion(snapshot.user.id, workspace_id, content.as_slice(), options)
    .await
    .map_err(map_database_error)?;
  Ok(map_json_import_result(result))
}

pub(crate) async fn export_database_csv(
  ctx: &Context<'_>,
  input: ExportDatabaseCsvInput,
) -> Result<DatabaseCsvExportObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let options = map_csv_options(input.options)?;
  let export = service(&state)?
    .import_export
    .export_csv_with_options(snapshot.user.id, database_id, options)
    .await
    .map_err(map_database_error)?;
  Ok(map_csv_export(export))
}

// ─────────────────────────────────────────────────────────────────────
// P-DB-27: CSV mapping template server actions (save / list / load /
// delete). Each resolver delegates to the corresponding service
// method which guards the workspace and translates repository errors
// into GraphQL errors with a stable error code prefix.
// ─────────────────────────────────────────────────────────────────────

pub(crate) async fn save_database_csv_mapping_template(
  ctx: &Context<'_>,
  input: SaveDatabaseCsvMappingTemplateInput,
) -> Result<DatabaseCsvMappingTemplateObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let dialect = map_csv_dialect_input(input.dialect);
  let mapping = input
    .mapping
    .into_iter()
    .map(|entry| domain::DatabaseCsvAppliedColumnMapping {
      source_index: entry.source_index,
      import_column: entry.import_column,
      source_header: entry.source_header,
      field_name: entry.field_name,
      field_type: entry.field_type.into(),
      is_title: entry.is_title,
    })
    .collect();
  let template = service(&state)?
    .import_export
    .save_csv_mapping_template(
      snapshot.user.id,
      workspace_id,
      input.name,
      dialect,
      input.first_row_is_header.unwrap_or(true),
      mapping,
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_csv_mapping_template(template))
}

pub(crate) async fn load_database_csv_mapping_template(
  ctx: &Context<'_>,
  input: LoadDatabaseCsvMappingTemplateInput,
) -> Result<Option<DatabaseCsvMappingTemplateObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let template = service(&state)?
    .import_export
    .load_csv_mapping_template(snapshot.user.id, workspace_id, &input.name)
    .await
    .map_err(map_database_error)?;
  Ok(template.map(map_csv_mapping_template))
}

pub(crate) async fn delete_database_csv_mapping_template(
  ctx: &Context<'_>,
  input: DeleteDatabaseCsvMappingTemplateInput,
) -> Result<bool> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let removed = service(&state)?
    .import_export
    .delete_csv_mapping_template(snapshot.user.id, workspace_id, &input.name)
    .await
    .map_err(map_database_error)?;
  Ok(removed)
}

pub(crate) async fn export_database_json(
  ctx: &Context<'_>,
  input: ExportDatabaseJsonInput,
) -> Result<DatabaseJsonExportObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let export = service(&state)?
    .import_export
    .export_json(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  Ok(map_json_export(export))
}
