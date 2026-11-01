// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;
use myoxus_application::database::{DatabaseEditingService, DatabaseViewService};
mod tasks;
pub use tasks::*;

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRollupScalarValueType")]
pub struct DatabaseRollupScalarValueObjectType {
  pub kind: DatabaseFieldKindType,
  pub number: Option<f64>,
  pub text: Option<String>,
  pub currency: Option<DatabaseCurrencyCellValueObjectType>,
  pub duration: Option<DatabaseDurationCellValueObjectType>,
  pub checkbox: Option<bool>,
  pub date: Option<DatabaseDateCellValueObjectType>,
  pub text_list: Option<Vec<String>>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseRollupScalarValueInput {
  pub number: Option<f64>,
  pub text: Option<String>,
  pub currency: Option<DatabaseCurrencyCellValueInput>,
  pub duration: Option<DatabaseDurationCellValueInput>,
  pub checkbox: Option<bool>,
  pub date: Option<DatabaseDateCellValueInput>,
  pub text_list: Option<Vec<String>>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseFormulaScalarValueInput {
  pub number: Option<f64>,
  pub percent: Option<f64>,
  pub currency: Option<DatabaseCurrencyCellValueInput>,
  pub duration: Option<DatabaseDurationCellValueInput>,
  pub text: Option<String>,
  pub checkbox: Option<bool>,
  pub date: Option<DatabaseDateCellValueInput>,
  pub date_time: Option<DatabaseDateTimeCellValueInput>,
  pub user: Option<ID>,
  pub users: Option<Vec<ID>>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseFormulaScalarValueType")]
pub struct DatabaseFormulaScalarValueObjectType {
  pub kind: DatabaseFieldKindType,
  pub number: Option<f64>,
  pub percent: Option<f64>,
  pub currency: Option<DatabaseCurrencyCellValueObjectType>,
  pub duration: Option<DatabaseDurationCellValueObjectType>,
  pub text: Option<String>,
  pub checkbox: Option<bool>,
  pub date: Option<DatabaseDateCellValueObjectType>,
  pub date_time: Option<DatabaseDateTimeCellValueObjectType>,
  pub user: Option<ID>,
  pub users: Option<Vec<ID>>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseDateCellValueType")]
pub struct DatabaseDateCellValueObjectType {
  pub start: chrono::NaiveDate,
  pub end: Option<chrono::NaiveDate>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseDateCellValueInput {
  pub start: chrono::NaiveDate,
  pub end: Option<chrono::NaiveDate>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseDateTimeCellValueType")]
pub struct DatabaseDateTimeCellValueObjectType {
  pub start: DateTime<Utc>,
  pub end: Option<DateTime<Utc>>,
  pub all_day: bool,
  pub time_zone: String,
}

#[derive(InputObject, Clone)]
pub struct DatabaseDateTimeCellValueInput {
  pub start: DateTime<Utc>,
  pub end: Option<DateTime<Utc>>,
  pub all_day: Option<bool>,
  pub time_zone: String,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseFileReferenceType")]
pub struct DatabaseFileReferenceObjectType {
  pub blob_key: String,
  pub name: Option<String>,
  pub mime: Option<String>,
  pub size: Option<i64>,
  pub caption: Option<String>,
  pub cover: bool,
}

#[derive(InputObject, Clone)]
pub struct DatabaseFileReferenceInput {
  pub blob_key: String,
  pub name: Option<String>,
  pub mime: Option<String>,
  pub size: Option<i64>,
  pub caption: Option<String>,
  pub cover: Option<bool>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseFilesCellValueType")]
pub struct DatabaseFilesCellValueObjectType {
  pub files: Vec<DatabaseFileReferenceObjectType>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseFilesCellValueInput {
  pub files: Vec<DatabaseFileReferenceInput>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseDocumentLinkCellValueType")]
pub struct DatabaseDocumentLinkCellValueObjectType {
  pub doc_id: ID,
  pub workspace_id: Option<ID>,
  pub target: Option<DatabaseRowContentDocumentObjectType>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseDocumentLinkCellValueInput {
  pub doc_id: ID,
  pub workspace_id: Option<ID>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCurrencyCellValueType")]
pub struct DatabaseCurrencyCellValueObjectType {
  pub amount: f64,
  pub currency_code: String,
}

#[derive(InputObject, Clone)]
pub struct DatabaseCurrencyCellValueInput {
  pub amount: f64,
  pub currency_code: String,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseDurationCellValueType")]
pub struct DatabaseDurationCellValueObjectType {
  pub minutes: i64,
}

#[derive(InputObject, Clone)]
pub struct DatabaseDurationCellValueInput {
  pub minutes: i64,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseUniqueIdCellValueType")]
pub struct DatabaseUniqueIdCellValueObjectType {
  pub prefix: String,
  pub sequence: i64,
  pub display: String,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRichTextCellValueType")]
pub struct DatabaseRichTextCellValueObjectType {
  pub plain_text: String,
  pub document: Json<JsonValue>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseRichTextCellValueInput {
  pub document: Json<JsonValue>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCellValueDataType")]
pub struct DatabaseCellValueDataObjectType {
  pub kind: DatabaseFieldKindType,
  pub text: Option<String>,
  pub rich_text: Option<DatabaseRichTextCellValueObjectType>,
  pub number: Option<f64>,
  pub percent: Option<f64>,
  pub currency: Option<DatabaseCurrencyCellValueObjectType>,
  pub duration: Option<DatabaseDurationCellValueObjectType>,
  pub checkbox: Option<bool>,
  pub date: Option<DatabaseDateCellValueObjectType>,
  pub date_time: Option<DatabaseDateTimeCellValueObjectType>,
  pub files: Option<DatabaseFilesCellValueObjectType>,
  pub unique_id: Option<DatabaseUniqueIdCellValueObjectType>,
  pub select: Option<String>,
  pub multi_select: Option<Vec<String>>,
  pub tags: Option<Vec<ID>>,
  pub status: Option<String>,
  pub user: Option<ID>,
  pub users: Option<Vec<ID>>,
  pub document_link: Option<DatabaseDocumentLinkCellValueObjectType>,
  pub relation: Option<Vec<ID>>,
  pub relation_targets: Option<Vec<DatabaseRelationTargetObjectType>>,
  pub rollup: Option<DatabaseRollupValueObjectType>,
  pub formula: Option<DatabaseFormulaValueObjectType>,
  pub url: Option<String>,
  pub email: Option<String>,
  pub phone: Option<String>,
  pub created_time: Option<DateTime<Utc>>,
  pub created_by: Option<ID>,
  pub updated_time: Option<DateTime<Utc>>,
  pub updated_by: Option<ID>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseCellValueInput {
  pub text: Option<String>,
  pub rich_text: Option<DatabaseRichTextCellValueInput>,
  pub number: Option<f64>,
  pub percent: Option<f64>,
  pub currency: Option<DatabaseCurrencyCellValueInput>,
  pub duration: Option<DatabaseDurationCellValueInput>,
  pub checkbox: Option<bool>,
  pub date: Option<DatabaseDateCellValueInput>,
  pub date_time: Option<DatabaseDateTimeCellValueInput>,
  pub files: Option<DatabaseFilesCellValueInput>,
  pub select: Option<String>,
  pub multi_select: Option<Vec<String>>,
  pub tags: Option<Vec<ID>>,
  pub status: Option<String>,
  pub user: Option<ID>,
  pub users: Option<Vec<ID>>,
  pub document_link: Option<DatabaseDocumentLinkCellValueInput>,
  pub relation: Option<Vec<ID>>,
  pub rollup: Option<DatabaseRollupScalarValueInput>,
  pub formula: Option<DatabaseFormulaScalarValueInput>,
  pub url: Option<String>,
  pub email: Option<String>,
  pub phone: Option<String>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRowType", complex)]
pub struct DatabaseRowObjectType {
  pub id: ID,
  pub database_id: ID,
  pub content_document: Option<DatabaseRowContentDocumentObjectType>,
  pub row_kind: String,
  pub title: String,
  pub position: i32,
  pub created_by: Option<ID>,
  pub updated_by: Option<ID>,
  pub edit_revision: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseRowContentDocumentState", rename_items = "PascalCase")]
pub enum DatabaseRowContentDocumentStateType {
  Available,
  Deleted,
  Missing,
  Redacted,
}

impl From<domain::DatabaseRowContentDocumentState> for DatabaseRowContentDocumentStateType {
  fn from(value: domain::DatabaseRowContentDocumentState) -> Self {
    match value {
      domain::DatabaseRowContentDocumentState::Available => Self::Available,
      domain::DatabaseRowContentDocumentState::Deleted => Self::Deleted,
      domain::DatabaseRowContentDocumentState::Missing => Self::Missing,
      domain::DatabaseRowContentDocumentState::Redacted => Self::Redacted,
    }
  }
}

/// Permission-safe metadata for an optional Row content document or a
/// DocumentLink target. Titles are exposed only while the target is available.
#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRowContentDocument")]
pub struct DatabaseRowContentDocumentObjectType {
  /// Internal UUID retained for Database mutations and reference joins.
  pub document_id: ID,
  /// Workspace-local route key, exposed only for an available readable target.
  pub external_id: Option<ID>,
  pub workspace_id: Option<ID>,
  pub state: DatabaseRowContentDocumentStateType,
  pub title: Option<String>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCellValueType")]
pub struct DatabaseCellValueObjectType {
  pub row_id: ID,
  pub field_id: ID,
  pub field_type: DatabaseFieldKindType,
  pub value: DatabaseCellValueDataObjectType,
  pub updated_by: Option<ID>,
  pub edit_revision: i64,
  pub updated_at: DateTime<Utc>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCellRevisionType")]
pub struct DatabaseCellRevisionObjectType {
  pub row_id: ID,
  pub field_id: ID,
  pub edit_revision: i64,
  pub has_value: bool,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRowRecord")]
pub struct DatabaseRowRecordObjectType {
  pub row: DatabaseRowObjectType,
  pub cells: Vec<DatabaseCellValueObjectType>,
  pub cell_revisions: Vec<DatabaseCellRevisionObjectType>,
  pub group_keys: Vec<String>,
  pub redacted: bool,
}

// ────────────────────────────────────────────────────────────────────────────
// P-DB-26: bulk operation result types
// ────────────────────────────────────────────────────────────────────────────

/// Per-row diagnostic entry for a bulk operation. Either `success` is `true`
/// (and `errorCode` / `errorMessage` are `None`) or `success` is `false` and
/// the failure carries a structured `MIX_DATABASE_*` code.
#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseBulkRowOutcome")]
pub struct DatabaseBulkRowOutcomeObjectType {
  pub row_id: ID,
  pub success: bool,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
}

impl DatabaseBulkRowOutcomeObjectType {
  pub fn from_domain(outcome: DatabaseBulkRowOutcome) -> Self {
    Self {
      row_id: async_graphql::ID(outcome.row_id.to_string()),
      success: outcome.success,
      error_code: outcome.error_code,
      error_message: outcome.error_message,
    }
  }
}

/// Aggregate result of a bulk operation. The `succeeded` and `failed` lists
/// together cover every requested row exactly once so the client can render
/// a structured toast (e.g. "3 of 12 updated, 9 failed: cell invalid")
/// without re-deriving counts.
#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseBulkOperationResult")]
pub struct DatabaseBulkOperationResultObjectType {
  pub succeeded: Vec<ID>,
  pub failed: Vec<DatabaseBulkRowOutcomeObjectType>,
  pub total: i32,
  pub success_count: i32,
  pub failure_count: i32,
  pub transaction_committed: bool,
}

impl DatabaseBulkOperationResultObjectType {
  pub fn from_domain(result: DatabaseBulkOperationResult) -> Self {
    Self {
      succeeded: result
        .succeeded
        .iter()
        .map(|id| async_graphql::ID(id.to_string()))
        .collect(),
      failed: result
        .failed
        .into_iter()
        .map(DatabaseBulkRowOutcomeObjectType::from_domain)
        .collect(),
      total: result.total as i32,
      success_count: result.success_count as i32,
      failure_count: result.failure_count as i32,
      transaction_committed: result.transaction_committed,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRowTemplateCellValue")]
pub struct DatabaseRowTemplateCellValueObjectType {
  pub field_id: ID,
  pub field_type: DatabaseFieldKindType,
  pub value: DatabaseCellValueDataObjectType,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRowTemplate")]
pub struct DatabaseRowTemplateObjectType {
  pub edit_revision: i64,
  pub id: ID,
  pub workspace_id: ID,
  pub database_id: ID,
  pub template_id: ID,
  pub row_kind: String,
  pub name: String,
  pub description: Option<String>,
  pub position: i32,
  pub enabled: bool,
  pub is_default: bool,
  pub initial_cell_values: Vec<DatabaseRowTemplateCellValueObjectType>,
  pub created_by: Option<ID>,
  pub updated_by: Option<ID>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRowTemplateBinding")]
pub struct DatabaseRowTemplateBindingObjectType {
  pub row_template: DatabaseRowTemplateObjectType,
  pub template_available: bool,
  pub reconcile_required: bool,
  pub detached: bool,
  pub disabled: bool,
  pub archived: bool,
}

#[derive(InputObject)]
pub struct CreateDatabaseRowCellInput {
  pub field_id: ID,
  pub value: DatabaseCellValueInput,
}

#[derive(InputObject)]
pub struct CreateDatabaseRowInput {
  pub database_id: ID,
  /// Optional selected View and its opening revision; both must be supplied together.
  pub view_id: Option<ID>,
  pub expected_view_edit_revision: Option<i64>,
  pub title: Option<String>,
  pub cells: Option<Vec<CreateDatabaseRowCellInput>>,
}

#[derive(InputObject)]
pub struct CreateDatabaseRowTemplateInput {
  pub database_id: ID,
  pub template_id: ID,
  pub row_kind: Option<String>,
  pub name: String,
  pub description: Option<String>,
  pub position: Option<i32>,
  pub enabled: Option<bool>,
  pub is_default: Option<bool>,
  pub initial_cell_values: Option<Vec<CreateDatabaseRowCellInput>>,
}

#[derive(InputObject)]
pub struct UpdateDatabaseRowTemplateInput {
  pub expected_edit_revision: i64,
  pub row_template_id: ID,
  pub name: Option<String>,
  pub description: MaybeUndefined<Option<String>>,
  pub position: Option<i32>,
  pub enabled: Option<bool>,
  pub is_default: Option<bool>,
  pub initial_cell_values: Option<Vec<CreateDatabaseRowCellInput>>,
}

#[derive(InputObject)]
pub struct DeleteDatabaseRowTemplateInput {
  pub expected_edit_revision: i64,
  pub row_template_id: ID,
}

#[derive(InputObject)]
pub struct CreateDatabaseRowFromTemplateInput {
  pub body_inputs: Option<Json<BTreeMap<String, String>>>,
  pub source_revision: Option<String>,
  pub database_id: ID,
  pub row_template_id: ID,
  pub title: Option<String>,
  pub override_cell_values: Option<Vec<CreateDatabaseRowCellInput>>,
}

#[derive(InputObject)]
pub struct UpdateDatabaseRowTitleInput {
  pub database_id: ID,
  pub row_id: ID,
  pub title_field_id: ID,
  pub title: String,
  pub expected_edit_revision: Option<i64>,
  pub force: Option<bool>,
}

#[derive(InputObject)]
pub struct UpdateDatabaseRowPositionInput {
  pub database_id: ID,
  pub row_id: ID,
  pub position: i32,
  /// P-DB-29B-C optimistic-lock precondition. When supplied, the server
  /// compares the row's current edit revision against this baseline and
  /// rejects the write with `MIX_DATABASE_ROW_CONFLICT` on mismatch.
  pub expected_edit_revision: Option<i64>,
  /// P-DB-29B-C: acknowledge that the client is intentionally overwriting
  /// a stale snapshot. Forces the write to proceed even on mismatch and
  /// records the overwrite in the audit log.
  #[graphql(name = "force")]
  pub force: Option<bool>,
}

#[derive(InputObject)]
pub struct UpdateDatabaseCellValueInput {
  pub database_id: ID,
  pub row_id: ID,
  pub field_id: ID,
  pub value: DatabaseCellValueInput,
  /// P-DB-29B-C optimistic-lock precondition; see
  /// [`UpdateDatabaseRowPositionInput::expected_edit_revision`].
  pub expected_edit_revision: Option<i64>,
  /// P-DB-29B-C: force the write even when the precondition fails.
  #[graphql(name = "force")]
  pub force: Option<bool>,
}

#[derive(InputObject)]
pub struct ClearDatabaseCellValueInput {
  pub database_id: ID,
  pub row_id: ID,
  pub field_id: ID,
  /// P-DB-29B-C optimistic-lock precondition.
  pub expected_edit_revision: Option<i64>,
  /// P-DB-29B-C: force the clear even when the precondition fails.
  #[graphql(name = "force")]
  pub force: Option<bool>,
}

#[derive(InputObject)]
pub struct DeleteDatabaseRowInput {
  pub database_id: ID,
  pub row_id: ID,
  /// P-DB-29B-C optimistic-lock precondition.
  pub expected_edit_revision: Option<i64>,
  /// P-DB-29B-C: force the delete even when the precondition fails.
  #[graphql(name = "force")]
  pub force: Option<bool>,
}

// ────────────────────────────────────────────────────────────────────────────
// P-DB-26: bulk operation input types
// ────────────────────────────────────────────────────────────────────────────

/// A single `(row_id, value)` write inside a bulk cell-set mutation.
#[derive(InputObject)]
pub struct BulkSetDatabaseCellValueRowInput {
  pub row_id: ID,
  pub value: DatabaseCellValueInput,
  /// P-DB-29B-C optimistic-lock precondition for this row.
  pub expected_edit_revision: Option<i64>,
}

/// Bulk cell set — set the same cell value on many rows in one atomic
/// transaction. Up to `DATABASE_BULK_MAX_ROWS_PER_OPERATION` rows are
/// accepted per call.
#[derive(InputObject)]
pub struct BulkSetDatabaseCellValueInput {
  pub database_id: ID,
  pub field_id: ID,
  pub rows: Vec<BulkSetDatabaseCellValueRowInput>,
  /// P-DB-29B-C: force overwrites every stale snapshot. Recorded in the
  /// audit log per affected row.
  #[graphql(name = "force")]
  pub force: Option<bool>,
}

/// Bulk cell clear — clear a single cell on many rows in one transaction.
#[derive(InputObject)]
pub struct BulkClearDatabaseCellValueInput {
  pub database_id: ID,
  pub field_id: ID,
  pub row_ids: Vec<ID>,
  /// P-DB-29B-C: per-row optimistic-lock precondition. Rows missing an
  /// entry skip the precondition (no client observation on file).
  pub expected_edit_revisions: Option<Vec<BulkRowExpectedEditRevision>>,
  /// P-DB-29B-C: force every stale overwrite.
  #[graphql(name = "force")]
  pub force: Option<bool>,
}

/// Atomic row precondition for bulk row mutations.
#[derive(InputObject)]
pub struct BulkRowExpectedEditRevision {
  #[graphql(name = "rowId")]
  pub row_id: ID,
  pub expected_edit_revision: i64,
}

/// A single `(row_id, value)` write inside a bulk multi-field patch.
#[derive(InputObject)]
pub struct BulkDatabaseCellPatchInput {
  pub field_id: ID,
  /// Existing Set callers continue to supply value; Clear must omit it.
  pub value: Option<DatabaseCellValueInput>,
  #[graphql(default)]
  pub clear: bool,
  pub expected_edit_revision: Option<i64>,
}

/// A single row's worth of cell writes inside a bulk multi-field patch.
#[derive(InputObject)]
pub struct BulkDatabaseRowPatchInput {
  pub row_id: ID,
  pub cells: Vec<BulkDatabaseCellPatchInput>,
}

/// Bulk multi-field edit — apply many cell writes (possibly across many
/// rows) in one transaction. Total `(row, field)` writes are capped at
/// `DATABASE_BULK_MAX_FIELD_UPDATES_PER_OPERATION`.
#[derive(InputObject)]
pub struct BulkApplyDatabaseCellPatchesInput {
  pub database_id: ID,
  pub patches: Vec<BulkDatabaseRowPatchInput>,
  /// P-DB-29B-C: force overwrites every stale snapshot.
  #[graphql(name = "force")]
  pub force: Option<bool>,
}

/// Bulk soft-delete — many rows in one transaction.
#[derive(InputObject)]
pub struct BulkDeleteDatabaseRowsInput {
  pub database_id: ID,
  pub row_ids: Vec<ID>,
  /// P-DB-29B-C: per-row optimistic-lock precondition.
  pub expected_edit_revisions: Option<Vec<BulkRowExpectedEditRevision>>,
  /// P-DB-29B-C: force every stale overwrite.
  #[graphql(name = "force")]
  pub force: Option<bool>,
}

/// Bulk restore — restore many soft-deleted rows in one transaction.
#[derive(InputObject)]
pub struct BulkRestoreDatabaseRowsInput {
  pub database_id: ID,
  pub row_ids: Vec<ID>,
  /// P-DB-29B-C: per-row optimistic-lock precondition.
  pub expected_edit_revisions: Option<Vec<BulkRowExpectedEditRevision>>,
  /// P-DB-29B-C: force every stale overwrite.
  #[graphql(name = "force")]
  pub force: Option<bool>,
}

/// A single `(row_id, position)` write inside a bulk reorder mutation.
#[derive(InputObject)]
pub struct BulkDatabaseRowPositionInput {
  pub row_id: ID,
  pub position: i32,
}

/// Bulk position rewrite — used by Kanban DnD and list reorder.
#[derive(InputObject)]
pub struct BulkUpdateDatabaseRowPositionsInput {
  pub database_id: ID,
  pub updates: Vec<BulkDatabaseRowPositionInput>,
  /// P-DB-29B-C: per-row optimistic-lock precondition.
  pub expected_edit_revisions: Option<Vec<BulkRowExpectedEditRevision>>,
  /// P-DB-29B-C: force every stale overwrite.
  #[graphql(name = "force")]
  pub force: Option<bool>,
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseRowTemplateBodyInputs")]
pub struct DatabaseRowTemplateBodyInputsObjectType {
  pub required_inputs: Vec<String>,
  pub source_revision: Option<String>,
}

fn parse_bulk_expected_per_row(
  entries: Option<&Vec<BulkRowExpectedEditRevision>>,
) -> Result<HashMap<DatabaseRowId, i64>> {
  let mut map = HashMap::new();
  let Some(entries) = entries else {
    return Ok(map);
  };
  for entry in entries {
    let row_id = parse_uuid_id::<DatabaseRowId>(&entry.row_id, "rowId")?;
    map.insert(row_id, entry.expected_edit_revision);
  }
  Ok(map)
}

fn parse_cell_input_map(
  cells: Vec<CreateDatabaseRowCellInput>,
) -> Result<BTreeMap<Uuid, domain::DatabaseCellValueData>> {
  let mut values = BTreeMap::new();
  for cell in cells {
    let field_id = parse_uuid_id(&cell.field_id, "fieldId")?;
    if values.insert(field_id, parse_cell_value(cell.value)?).is_some() {
      return Err(database_error(
        "MIX_DATABASE_ROW_TEMPLATE_CELL_VALUE_INVALID",
        "duplicate field id in cell values",
      ));
    }
  }
  Ok(values)
}

pub(crate) fn parse_cell_value(value: DatabaseCellValueInput) -> Result<domain::DatabaseCellValueData> {
  let set_count = [
    value.text.is_some(),
    value.rich_text.is_some(),
    value.number.is_some(),
    value.percent.is_some(),
    value.currency.is_some(),
    value.duration.is_some(),
    value.checkbox.is_some(),
    value.date.is_some(),
    value.date_time.is_some(),
    value.files.is_some(),
    value.select.is_some(),
    value.multi_select.is_some(),
    value.tags.is_some(),
    value.status.is_some(),
    value.user.is_some(),
    value.users.is_some(),
    value.document_link.is_some(),
    value.relation.is_some(),
    value.rollup.is_some(),
    value.formula.is_some(),
    value.url.is_some(),
    value.email.is_some(),
    value.phone.is_some(),
  ]
  .into_iter()
  .filter(|set| *set)
  .count();
  if set_count != 1 {
    return Err(database_error(
      "MIX_DATABASE_CELL_VALUE_INVALID",
      "cell value input must set exactly one value field",
    ));
  }
  if let Some(text) = value.text {
    return Ok(domain::DatabaseCellValueData::Text(text));
  }
  if let Some(rich_text) = value.rich_text {
    return myoxus_application::database::editing::rules::rich_text_value_from_document(
      rich_text.document.0,
      &DatabaseLimits::default(),
    )
    .map(domain::DatabaseCellValueData::RichText)
    .map_err(map_database_error);
  }
  if let Some(number) = value.number {
    return Ok(domain::DatabaseCellValueData::Number(number));
  }
  if let Some(percent) = value.percent {
    return Ok(domain::DatabaseCellValueData::Percent(percent));
  }
  if let Some(currency) = value.currency {
    return Ok(domain::DatabaseCellValueData::Currency(domain::DatabaseCurrencyValue {
      amount: currency.amount,
      currency_code: currency.currency_code,
    }));
  }
  if let Some(duration) = value.duration {
    return Ok(domain::DatabaseCellValueData::Duration(domain::DatabaseDurationValue {
      minutes: duration.minutes,
    }));
  }
  if let Some(checkbox) = value.checkbox {
    return Ok(domain::DatabaseCellValueData::Checkbox(checkbox));
  }
  if let Some(date) = value.date {
    return Ok(domain::DatabaseCellValueData::Date(domain::DatabaseDateValue {
      start: date.start,
      end: date.end,
    }));
  }
  if let Some(date_time) = value.date_time {
    return Ok(domain::DatabaseCellValueData::DateTime(domain::DatabaseDateTimeValue {
      start: date_time.start,
      end: date_time.end,
      all_day: date_time.all_day.unwrap_or(false),
      time_zone: date_time.time_zone,
    }));
  }
  if let Some(files) = value.files {
    return Ok(domain::DatabaseCellValueData::Files(domain::DatabaseFilesValue {
      files: files
        .files
        .into_iter()
        .map(|file| domain::DatabaseFileReference {
          blob_key: file.blob_key,
          name: file.name,
          mime: file.mime,
          size: file.size,
          caption: file.caption,
          cover: file.cover.unwrap_or(false),
        })
        .collect(),
    }));
  }
  if let Some(select) = value.select {
    return Ok(domain::DatabaseCellValueData::Select(select));
  }
  if let Some(multi_select) = value.multi_select {
    return Ok(domain::DatabaseCellValueData::MultiSelect(multi_select));
  }
  if let Some(tags) = value.tags {
    return Ok(domain::DatabaseCellValueData::Tags(
      tags
        .into_iter()
        .map(|id| parse_uuid_id(&id, "tags"))
        .collect::<Result<Vec<Uuid>>>()?,
    ));
  }
  if let Some(status) = value.status {
    return Ok(domain::DatabaseCellValueData::Status(status));
  }
  if let Some(user) = value.user {
    return Ok(domain::DatabaseCellValueData::User(parse_uuid_id(&user, "user")?));
  }
  if let Some(users) = value.users {
    return Ok(domain::DatabaseCellValueData::Users(
      users
        .iter()
        .map(|id| parse_uuid_id(id, "users"))
        .collect::<Result<Vec<_>>>()?,
    ));
  }
  if let Some(document_link) = value.document_link {
    return Ok(domain::DatabaseCellValueData::DocumentLink(
      domain::DatabaseDocumentLinkValue {
        doc_id: parse_uuid_id(&document_link.doc_id, "documentLink.docId")?,
        workspace_id: document_link
          .workspace_id
          .as_ref()
          .map(|id| parse_uuid_id(id, "documentLink.workspaceId"))
          .transpose()?,
      },
    ));
  }
  if let Some(relation) = value.relation {
    return Ok(domain::DatabaseCellValueData::Relation(
      relation
        .iter()
        .map(|id| parse_uuid_id(id, "relation"))
        .collect::<Result<Vec<_>>>()?,
    ));
  }
  if let Some(rollup) = value.rollup {
    return Ok(domain::DatabaseCellValueData::Rollup(domain::DatabaseRollupValue {
      value: Some(parse_rollup_scalar_value(rollup)?),
      stale_state: domain::DatabaseRollupStaleState::Current,
      computed_at: None,
      failed_at: None,
      error_code: None,
      error_message: None,
    }));
  }
  if let Some(formula) = value.formula {
    return Ok(domain::DatabaseCellValueData::Formula(domain::DatabaseFormulaValue {
      value: Some(parse_formula_scalar_value(formula)?),
      stale_state: domain::DatabaseFormulaStaleState::Current,
      computed_at: None,
      failed_at: None,
      error_code: None,
      error_message: None,
    }));
  }
  if let Some(url) = value.url {
    return Ok(domain::DatabaseCellValueData::Url(url));
  }
  if let Some(email) = value.email {
    return Ok(domain::DatabaseCellValueData::Email(email));
  }
  if let Some(phone) = value.phone {
    return Ok(domain::DatabaseCellValueData::Phone(phone));
  }
  unreachable!("set_count enforces one cell value input")
}

pub(super) fn parse_rollup_scalar_value(
  value: DatabaseRollupScalarValueInput,
) -> Result<domain::DatabaseRollupScalarValue> {
  let set_count = [
    value.number.is_some(),
    value.text.is_some(),
    value.currency.is_some(),
    value.duration.is_some(),
    value.checkbox.is_some(),
    value.date.is_some(),
    value.text_list.is_some(),
  ]
  .into_iter()
  .filter(|set| *set)
  .count();
  if set_count != 1 {
    return Err(database_error(
      "MIX_DATABASE_ROLLUP_CONFIG_INVALID",
      "rollup scalar value input must set exactly one value field",
    ));
  }
  if let Some(number) = value.number {
    return Ok(domain::DatabaseRollupScalarValue::Number(number));
  }
  if let Some(text) = value.text {
    return Ok(domain::DatabaseRollupScalarValue::Text(text));
  }
  if let Some(currency) = value.currency {
    return Ok(domain::DatabaseRollupScalarValue::Currency(
      domain::DatabaseCurrencyValue {
        amount: currency.amount,
        currency_code: currency.currency_code,
      },
    ));
  }
  if let Some(duration) = value.duration {
    return Ok(domain::DatabaseRollupScalarValue::Duration(
      domain::DatabaseDurationValue {
        minutes: duration.minutes,
      },
    ));
  }
  if let Some(checkbox) = value.checkbox {
    return Ok(domain::DatabaseRollupScalarValue::Checkbox(checkbox));
  }
  if let Some(date) = value.date {
    return Ok(domain::DatabaseRollupScalarValue::Date(domain::DatabaseDateValue {
      start: date.start,
      end: date.end,
    }));
  }
  if let Some(text_list) = value.text_list {
    return Ok(domain::DatabaseRollupScalarValue::TextList(text_list));
  }
  unreachable!("set_count enforces one rollup scalar value input")
}

fn parse_formula_scalar_value(value: DatabaseFormulaScalarValueInput) -> Result<domain::DatabaseFormulaScalarValue> {
  let set_count = [
    value.number.is_some(),
    value.percent.is_some(),
    value.currency.is_some(),
    value.duration.is_some(),
    value.text.is_some(),
    value.checkbox.is_some(),
    value.date.is_some(),
    value.date_time.is_some(),
    value.user.is_some(),
    value.users.is_some(),
  ]
  .into_iter()
  .filter(|set| *set)
  .count();
  if set_count != 1 {
    return Err(database_error(
      "MIX_DATABASE_CELL_VALUE_INVALID",
      "formula scalar value input must set exactly one value field",
    ));
  }
  if let Some(number) = value.number {
    return Ok(domain::DatabaseFormulaScalarValue::Number(number));
  }
  if let Some(percent) = value.percent {
    return Ok(domain::DatabaseFormulaScalarValue::Percent(percent));
  }
  if let Some(currency) = value.currency {
    return Ok(domain::DatabaseFormulaScalarValue::Currency(
      domain::DatabaseCurrencyValue {
        amount: currency.amount,
        currency_code: currency.currency_code,
      },
    ));
  }
  if let Some(duration) = value.duration {
    return Ok(domain::DatabaseFormulaScalarValue::Duration(
      domain::DatabaseDurationValue {
        minutes: duration.minutes,
      },
    ));
  }
  if let Some(text) = value.text {
    return Ok(domain::DatabaseFormulaScalarValue::Text(text));
  }
  if let Some(checkbox) = value.checkbox {
    return Ok(domain::DatabaseFormulaScalarValue::Checkbox(checkbox));
  }
  if let Some(date) = value.date {
    return Ok(domain::DatabaseFormulaScalarValue::Date(domain::DatabaseDateValue {
      start: date.start,
      end: date.end,
    }));
  }
  if let Some(date_time) = value.date_time {
    return Ok(domain::DatabaseFormulaScalarValue::DateTime(
      domain::DatabaseDateTimeValue {
        start: date_time.start,
        end: date_time.end,
        all_day: date_time.all_day.unwrap_or(false),
        time_zone: date_time.time_zone,
      },
    ));
  }
  if let Some(user) = value.user {
    return Ok(domain::DatabaseFormulaScalarValue::User(parse_uuid_id(&user, "user")?));
  }
  if let Some(users) = value.users {
    return Ok(domain::DatabaseFormulaScalarValue::Users(
      users
        .iter()
        .map(|id| parse_uuid_id(id, "users"))
        .collect::<Result<Vec<_>>>()?,
    ));
  }
  unreachable!("set_count enforces one formula scalar value input")
}

pub(super) fn map_rollup_scalar_value(value: domain::DatabaseRollupScalarValue) -> DatabaseRollupScalarValueObjectType {
  match value {
    domain::DatabaseRollupScalarValue::Number(value) => DatabaseRollupScalarValueObjectType {
      kind: DatabaseFieldKindType::Number,
      number: Some(value),
      text: None,
      currency: None,
      duration: None,
      checkbox: None,
      date: None,
      text_list: None,
    },
    domain::DatabaseRollupScalarValue::Text(value) => DatabaseRollupScalarValueObjectType {
      kind: DatabaseFieldKindType::Text,
      number: None,
      text: Some(value),
      currency: None,
      duration: None,
      checkbox: None,
      date: None,
      text_list: None,
    },
    domain::DatabaseRollupScalarValue::Currency(value) => DatabaseRollupScalarValueObjectType {
      kind: DatabaseFieldKindType::Currency,
      number: None,
      text: None,
      currency: Some(DatabaseCurrencyCellValueObjectType {
        amount: value.amount,
        currency_code: value.currency_code,
      }),
      duration: None,
      checkbox: None,
      date: None,
      text_list: None,
    },
    domain::DatabaseRollupScalarValue::Duration(value) => DatabaseRollupScalarValueObjectType {
      kind: DatabaseFieldKindType::Duration,
      number: None,
      text: None,
      currency: None,
      duration: Some(DatabaseDurationCellValueObjectType { minutes: value.minutes }),
      checkbox: None,
      date: None,
      text_list: None,
    },
    domain::DatabaseRollupScalarValue::Checkbox(value) => DatabaseRollupScalarValueObjectType {
      kind: DatabaseFieldKindType::Checkbox,
      number: None,
      text: None,
      currency: None,
      duration: None,
      checkbox: Some(value),
      date: None,
      text_list: None,
    },
    domain::DatabaseRollupScalarValue::Date(value) => DatabaseRollupScalarValueObjectType {
      kind: DatabaseFieldKindType::Date,
      number: None,
      text: None,
      currency: None,
      duration: None,
      checkbox: None,
      date: Some(DatabaseDateCellValueObjectType {
        start: value.start,
        end: value.end,
      }),
      text_list: None,
    },
    domain::DatabaseRollupScalarValue::TextList(value) => DatabaseRollupScalarValueObjectType {
      kind: DatabaseFieldKindType::Text,
      number: None,
      text: None,
      currency: None,
      duration: None,
      checkbox: None,
      date: None,
      text_list: Some(value),
    },
  }
}

fn map_formula_scalar_value(value: domain::DatabaseFormulaScalarValue) -> DatabaseFormulaScalarValueObjectType {
  match value {
    domain::DatabaseFormulaScalarValue::Number(value) => DatabaseFormulaScalarValueObjectType {
      kind: DatabaseFieldKindType::Number,
      number: Some(value),
      percent: None,
      currency: None,
      duration: None,
      text: None,
      checkbox: None,
      date: None,
      date_time: None,
      user: None,
      users: None,
    },
    domain::DatabaseFormulaScalarValue::Percent(value) => DatabaseFormulaScalarValueObjectType {
      kind: DatabaseFieldKindType::Percent,
      number: None,
      percent: Some(value),
      currency: None,
      duration: None,
      text: None,
      checkbox: None,
      date: None,
      date_time: None,
      user: None,
      users: None,
    },
    domain::DatabaseFormulaScalarValue::Currency(value) => DatabaseFormulaScalarValueObjectType {
      kind: DatabaseFieldKindType::Currency,
      number: None,
      percent: None,
      currency: Some(DatabaseCurrencyCellValueObjectType {
        amount: value.amount,
        currency_code: value.currency_code,
      }),
      duration: None,
      text: None,
      checkbox: None,
      date: None,
      date_time: None,
      user: None,
      users: None,
    },
    domain::DatabaseFormulaScalarValue::Duration(value) => DatabaseFormulaScalarValueObjectType {
      kind: DatabaseFieldKindType::Duration,
      number: None,
      percent: None,
      currency: None,
      duration: Some(DatabaseDurationCellValueObjectType { minutes: value.minutes }),
      text: None,
      checkbox: None,
      date: None,
      date_time: None,
      user: None,
      users: None,
    },
    domain::DatabaseFormulaScalarValue::Text(value) => DatabaseFormulaScalarValueObjectType {
      kind: DatabaseFieldKindType::Text,
      number: None,
      percent: None,
      currency: None,
      duration: None,
      text: Some(value),
      checkbox: None,
      date: None,
      date_time: None,
      user: None,
      users: None,
    },
    domain::DatabaseFormulaScalarValue::Checkbox(value) => DatabaseFormulaScalarValueObjectType {
      kind: DatabaseFieldKindType::Checkbox,
      number: None,
      percent: None,
      currency: None,
      duration: None,
      text: None,
      checkbox: Some(value),
      date: None,
      date_time: None,
      user: None,
      users: None,
    },
    domain::DatabaseFormulaScalarValue::Date(value) => DatabaseFormulaScalarValueObjectType {
      kind: DatabaseFieldKindType::Date,
      number: None,
      percent: None,
      currency: None,
      duration: None,
      text: None,
      checkbox: None,
      date: Some(DatabaseDateCellValueObjectType {
        start: value.start,
        end: value.end,
      }),
      date_time: None,
      user: None,
      users: None,
    },
    domain::DatabaseFormulaScalarValue::DateTime(value) => DatabaseFormulaScalarValueObjectType {
      kind: DatabaseFieldKindType::DateTime,
      number: None,
      percent: None,
      currency: None,
      duration: None,
      text: None,
      checkbox: None,
      date: None,
      date_time: Some(DatabaseDateTimeCellValueObjectType {
        start: value.start,
        end: value.end,
        all_day: value.all_day,
        time_zone: value.time_zone,
      }),
      user: None,
      users: None,
    },
    domain::DatabaseFormulaScalarValue::User(value) => DatabaseFormulaScalarValueObjectType {
      kind: DatabaseFieldKindType::User,
      number: None,
      percent: None,
      currency: None,
      duration: None,
      text: None,
      checkbox: None,
      date: None,
      date_time: None,
      user: Some(ID::from(value.to_string())),
      users: None,
    },
    domain::DatabaseFormulaScalarValue::Users(value) => DatabaseFormulaScalarValueObjectType {
      kind: DatabaseFieldKindType::Users,
      number: None,
      percent: None,
      currency: None,
      duration: None,
      text: None,
      checkbox: None,
      date: None,
      date_time: None,
      user: None,
      users: Some(value.into_iter().map(|id| ID::from(id.to_string())).collect()),
    },
  }
}

fn map_content_document(document: domain::DatabaseRowContentDocument) -> DatabaseRowContentDocumentObjectType {
  DatabaseRowContentDocumentObjectType {
    document_id: ID::from(document.document_id.to_string()),
    external_id: document.external_id.map(ID::from),
    workspace_id: document.workspace_id.map(ID::from),
    state: document.state.into(),
    title: document.title,
  }
}

fn map_row(
  row: domain::DatabaseRow,
  content_document: Option<domain::DatabaseRowContentDocument>,
) -> DatabaseRowObjectType {
  DatabaseRowObjectType {
    id: ID::from(row.id.to_string()),
    database_id: ID::from(row.database_id.to_string()),
    content_document: content_document.map(map_content_document),
    row_kind: row.row_kind.as_str().to_string(),
    title: row.title,
    position: row.position,
    created_by: row.created_by.map(|id| ID::from(id.to_string())),
    updated_by: row.updated_by.map(|id| ID::from(id.to_string())),
    edit_revision: row.edit_revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  }
}

fn map_cell(cell: domain::DatabaseCellValue) -> DatabaseCellValueObjectType {
  DatabaseCellValueObjectType {
    row_id: ID::from(cell.row_id.to_string()),
    field_id: ID::from(cell.field_id.to_string()),
    field_type: cell.field_type.into(),
    value: map_cell_value(cell.value),
    updated_by: cell.updated_by.map(|id| ID::from(id.to_string())),
    edit_revision: cell.edit_revision,
    updated_at: cell.updated_at,
  }
}

pub(super) fn map_cell_revision(revision: domain::DatabaseCellRevision) -> DatabaseCellRevisionObjectType {
  DatabaseCellRevisionObjectType {
    row_id: ID::from(revision.row_id.to_string()),
    field_id: ID::from(revision.field_id.to_string()),
    edit_revision: revision.edit_revision,
    has_value: revision.has_value,
  }
}

fn map_row_template_cell(
  (field_id, value): (Uuid, domain::DatabaseCellValueData),
) -> DatabaseRowTemplateCellValueObjectType {
  DatabaseRowTemplateCellValueObjectType {
    field_id: ID::from(field_id.to_string()),
    field_type: cell_value_field_type(&value),
    value: map_cell_value(value),
  }
}

fn map_row_template(template: domain::DatabaseRowTemplate) -> DatabaseRowTemplateObjectType {
  DatabaseRowTemplateObjectType {
    edit_revision: template.edit_revision,
    id: ID::from(template.id.to_string()),
    workspace_id: ID::from(template.workspace_id.to_string()),
    database_id: ID::from(template.database_id.to_string()),
    template_id: ID::from(template.template_id.to_string()),
    row_kind: template.row_kind.as_str().to_string(),
    name: template.name,
    description: template.description,
    position: template.position,
    enabled: template.enabled,
    is_default: template.is_default,
    initial_cell_values: template
      .initial_cell_values
      .into_iter()
      .map(map_row_template_cell)
      .collect(),
    created_by: template.created_by.map(|id| ID::from(id.to_string())),
    updated_by: template.updated_by.map(|id| ID::from(id.to_string())),
    created_at: template.created_at,
    updated_at: template.updated_at,
  }
}

fn map_row_template_binding(binding: domain::DatabaseRowTemplateBinding) -> DatabaseRowTemplateBindingObjectType {
  DatabaseRowTemplateBindingObjectType {
    row_template: map_row_template(binding.row_template),
    template_available: binding.template_available,
    reconcile_required: binding.reconcile_required,
    detached: binding.detached,
    disabled: binding.disabled,
    archived: binding.archived,
  }
}

fn cell_value_field_type(value: &domain::DatabaseCellValueData) -> DatabaseFieldKindType {
  match value {
    domain::DatabaseCellValueData::Text(_) => DatabaseFieldKindType::Text,
    domain::DatabaseCellValueData::RichText(_) => DatabaseFieldKindType::RichText,
    domain::DatabaseCellValueData::Number(_) => DatabaseFieldKindType::Number,
    domain::DatabaseCellValueData::Percent(_) => DatabaseFieldKindType::Percent,
    domain::DatabaseCellValueData::Currency(_) => DatabaseFieldKindType::Currency,
    domain::DatabaseCellValueData::Duration(_) => DatabaseFieldKindType::Duration,
    domain::DatabaseCellValueData::Checkbox(_) => DatabaseFieldKindType::Checkbox,
    domain::DatabaseCellValueData::Date(_) => DatabaseFieldKindType::Date,
    domain::DatabaseCellValueData::DateTime(_) => DatabaseFieldKindType::DateTime,
    domain::DatabaseCellValueData::Files(_) => DatabaseFieldKindType::Files,
    domain::DatabaseCellValueData::UniqueId(_) => DatabaseFieldKindType::UniqueId,
    domain::DatabaseCellValueData::Select(_) => DatabaseFieldKindType::Select,
    domain::DatabaseCellValueData::MultiSelect(_) => DatabaseFieldKindType::MultiSelect,
    domain::DatabaseCellValueData::Tags(_) => DatabaseFieldKindType::Tags,
    domain::DatabaseCellValueData::Status(_) => DatabaseFieldKindType::Status,
    domain::DatabaseCellValueData::User(_) => DatabaseFieldKindType::User,
    domain::DatabaseCellValueData::Users(_) => DatabaseFieldKindType::Users,
    domain::DatabaseCellValueData::DocumentLink(_) => DatabaseFieldKindType::DocumentLink,
    domain::DatabaseCellValueData::Relation(_) => DatabaseFieldKindType::Relation,
    domain::DatabaseCellValueData::Rollup(_) => DatabaseFieldKindType::Rollup,
    domain::DatabaseCellValueData::Formula(_) => DatabaseFieldKindType::Formula,
    domain::DatabaseCellValueData::Url(_) => DatabaseFieldKindType::Url,
    domain::DatabaseCellValueData::Email(_) => DatabaseFieldKindType::Email,
    domain::DatabaseCellValueData::Phone(_) => DatabaseFieldKindType::Phone,
    domain::DatabaseCellValueData::CreatedTime(_) => DatabaseFieldKindType::CreatedTime,
    domain::DatabaseCellValueData::CreatedBy(_) => DatabaseFieldKindType::CreatedBy,
    domain::DatabaseCellValueData::UpdatedTime(_) => DatabaseFieldKindType::UpdatedTime,
    domain::DatabaseCellValueData::UpdatedBy(_) => DatabaseFieldKindType::UpdatedBy,
  }
}

fn empty_cell_value_object(kind: DatabaseFieldKindType) -> DatabaseCellValueDataObjectType {
  DatabaseCellValueDataObjectType {
    kind,
    text: None,
    rich_text: None,
    number: None,
    percent: None,
    currency: None,
    duration: None,
    checkbox: None,
    date: None,
    date_time: None,
    files: None,
    unique_id: None,
    select: None,
    multi_select: None,
    tags: None,
    status: None,
    user: None,
    users: None,
    document_link: None,
    relation: None,
    relation_targets: None,
    rollup: None,
    formula: None,
    url: None,
    email: None,
    phone: None,
    created_time: None,
    created_by: None,
    updated_time: None,
    updated_by: None,
  }
}

pub(super) fn map_cell_value(value: domain::DatabaseCellValueData) -> DatabaseCellValueDataObjectType {
  match value {
    domain::DatabaseCellValueData::Text(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Text);
      mapped.text = Some(value);
      mapped
    }
    domain::DatabaseCellValueData::RichText(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::RichText);
      mapped.rich_text = Some(DatabaseRichTextCellValueObjectType {
        plain_text: value.plain_text,
        document: Json(value.document),
      });
      mapped
    }
    domain::DatabaseCellValueData::Number(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Number);
      mapped.number = Some(value);
      mapped
    }
    domain::DatabaseCellValueData::Percent(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Percent);
      mapped.percent = Some(value);
      mapped
    }
    domain::DatabaseCellValueData::Currency(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Currency);
      mapped.currency = Some(DatabaseCurrencyCellValueObjectType {
        amount: value.amount,
        currency_code: value.currency_code,
      });
      mapped
    }
    domain::DatabaseCellValueData::Duration(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Duration);
      mapped.duration = Some(DatabaseDurationCellValueObjectType { minutes: value.minutes });
      mapped
    }
    domain::DatabaseCellValueData::Checkbox(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Checkbox);
      mapped.checkbox = Some(value);
      mapped
    }
    domain::DatabaseCellValueData::Date(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Date);
      mapped.date = Some(DatabaseDateCellValueObjectType {
        start: value.start,
        end: value.end,
      });
      mapped
    }
    domain::DatabaseCellValueData::DateTime(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::DateTime);
      mapped.date_time = Some(DatabaseDateTimeCellValueObjectType {
        start: value.start,
        end: value.end,
        all_day: value.all_day,
        time_zone: value.time_zone,
      });
      mapped
    }
    domain::DatabaseCellValueData::Files(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Files);
      mapped.files = Some(DatabaseFilesCellValueObjectType {
        files: value
          .files
          .into_iter()
          .map(|file| DatabaseFileReferenceObjectType {
            blob_key: file.blob_key,
            name: file.name,
            mime: file.mime,
            size: file.size,
            caption: file.caption,
            cover: file.cover,
          })
          .collect(),
      });
      mapped
    }
    domain::DatabaseCellValueData::UniqueId(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::UniqueId);
      mapped.unique_id = Some(DatabaseUniqueIdCellValueObjectType {
        prefix: value.prefix,
        sequence: value.sequence,
        display: value.display,
      });
      mapped
    }
    domain::DatabaseCellValueData::Select(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Select);
      mapped.select = Some(value);
      mapped
    }
    domain::DatabaseCellValueData::MultiSelect(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::MultiSelect);
      mapped.multi_select = Some(value);
      mapped
    }
    domain::DatabaseCellValueData::Tags(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Tags);
      mapped.tags = Some(value.into_iter().map(|id| ID::from(id.to_string())).collect());
      mapped
    }
    domain::DatabaseCellValueData::Status(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Status);
      mapped.status = Some(value);
      mapped
    }
    domain::DatabaseCellValueData::User(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::User);
      mapped.user = Some(ID::from(value.to_string()));
      mapped
    }
    domain::DatabaseCellValueData::Users(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Users);
      mapped.users = Some(value.into_iter().map(|id| ID::from(id.to_string())).collect());
      mapped
    }
    domain::DatabaseCellValueData::DocumentLink(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::DocumentLink);
      mapped.document_link = Some(DatabaseDocumentLinkCellValueObjectType {
        doc_id: ID::from(value.doc_id.to_string()),
        workspace_id: value.workspace_id.map(ID::from),
        target: None,
      });
      mapped
    }
    domain::DatabaseCellValueData::Relation(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Relation);
      mapped.relation = Some(value.into_iter().map(|id| ID::from(id.to_string())).collect());
      mapped
    }
    domain::DatabaseCellValueData::Rollup(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Rollup);
      mapped.rollup = Some(DatabaseRollupValueObjectType {
        value: value.value.map(map_rollup_scalar_value),
        stale_state: value.stale_state.into(),
        computed_at: value.computed_at,
        failed_at: value.failed_at,
        error_code: value.error_code,
        error_message: value.error_message,
      });
      mapped
    }
    domain::DatabaseCellValueData::Formula(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Formula);
      mapped.formula = Some(DatabaseFormulaValueObjectType {
        value: value.value.map(map_formula_scalar_value),
        stale_state: value.stale_state.into(),
        computed_at: value.computed_at,
        failed_at: value.failed_at,
        error_code: value.error_code,
        error_message: value.error_message,
      });
      mapped
    }
    domain::DatabaseCellValueData::Url(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Url);
      mapped.url = Some(value);
      mapped
    }
    domain::DatabaseCellValueData::Email(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Email);
      mapped.email = Some(value);
      mapped
    }
    domain::DatabaseCellValueData::Phone(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::Phone);
      mapped.phone = Some(value);
      mapped
    }
    domain::DatabaseCellValueData::CreatedTime(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::CreatedTime);
      mapped.created_time = Some(value);
      mapped
    }
    domain::DatabaseCellValueData::CreatedBy(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::CreatedBy);
      mapped.created_by = Some(ID::from(value.to_string()));
      mapped
    }
    domain::DatabaseCellValueData::UpdatedTime(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::UpdatedTime);
      mapped.updated_time = Some(value);
      mapped
    }
    domain::DatabaseCellValueData::UpdatedBy(value) => {
      let mut mapped = empty_cell_value_object(DatabaseFieldKindType::UpdatedBy);
      mapped.updated_by = Some(ID::from(value.to_string()));
      mapped
    }
  }
}

#[derive(Debug, InputObject)]
#[graphql(name = "CreateDatabaseRowContentDocumentInput")]
pub struct CreateDatabaseRowContentDocumentInput {
  pub database_id: ID,
  pub row_id: ID,
  pub expected_edit_revision: i64,
}

#[derive(Debug, InputObject)]
#[graphql(name = "AttachDatabaseRowContentDocumentInput")]
pub struct AttachDatabaseRowContentDocumentInput {
  pub database_id: ID,
  pub row_id: ID,
  pub document_id: ID,
  pub expected_edit_revision: i64,
}

#[derive(Debug, InputObject)]
#[graphql(name = "DetachDatabaseRowContentDocumentInput")]
pub struct DetachDatabaseRowContentDocumentInput {
  pub database_id: ID,
  pub row_id: ID,
  pub expected_edit_revision: i64,
}

#[derive(InputObject)]
pub struct CreateDatabaseTaskFromSourceInput {
  pub workspace_id: ID,
  pub database_id: ID,
  pub request_id: ID,
  pub source_document_id: ID,
  pub source_external_id: ID,
  pub block_id: Option<String>,
  pub selection_anchor: Option<String>,
  pub title: String,
  pub cells: Option<Vec<CreateDatabaseRowCellInput>>,
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseTaskSourceState", rename_items = "PascalCase")]
pub enum DatabaseTaskSourceStateType {
  Available,
  Unavailable,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseTaskSource")]
pub struct DatabaseTaskSourceObjectType {
  pub source_workspace_id: ID,
  pub document_id: ID,
  pub external_id: Option<ID>,
  pub block_id: Option<String>,
  pub selection_anchor: Option<String>,
  pub state: DatabaseTaskSourceStateType,
  pub title: Option<String>,
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseTaskCaptureState", rename_items = "PascalCase")]
pub enum DatabaseTaskCaptureStateType {
  Available,
  Trashed,
  Missing,
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskCaptureResult")]
pub struct DatabaseTaskCaptureResultObjectType {
  pub request_id: ID,
  pub database_id: ID,
  pub row_id: ID,
  pub edit_revision: i64,
  pub state: DatabaseTaskCaptureStateType,
  pub replayed: bool,
  pub record: Option<DatabaseRowRecordObjectType>,
  pub source: DatabaseTaskSourceObjectType,
}

fn map_task_source(
  source: domain::DatabaseTaskSource,
  projection: Option<domain::DatabaseRowContentDocument>,
) -> DatabaseTaskSourceObjectType {
  let available = projection.is_some();
  DatabaseTaskSourceObjectType {
    source_workspace_id: ID::from(source.source_workspace_id.to_string()),
    document_id: ID::from(source.document_id.to_string()),
    external_id: available.then(|| ID::from(source.external_id)),
    block_id: available.then_some(source.block_id).flatten(),
    selection_anchor: available.then_some(source.selection_anchor).flatten(),
    state: if available {
      DatabaseTaskSourceStateType::Available
    } else {
      DatabaseTaskSourceStateType::Unavailable
    },
    title: projection.and_then(|p| p.title),
  }
}

pub(crate) async fn database_row_template_body_inputs(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
  row_template_id: ID,
) -> Result<DatabaseRowTemplateBodyInputsObjectType> {
  let (state, session) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&database_id, "databaseId")?;
  let services = service(&state)?;
  let record = services
    .definition
    .get_database(session.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  if record.database.workspace_id != workspace_id {
    return Err(database_error("MIX_DATABASE_NOT_FOUND", "database not found"));
  }
  let registry = crate::graphql::template_registry::require_template_registry(&state).await?;
  let (required_inputs, source_revision) = services
    .editing
    .row_template_body_inputs(
      session.user.id,
      database_id,
      parse_uuid_id(&row_template_id, "rowTemplateId")?,
      registry,
    )
    .await
    .map_err(map_database_error)?;
  Ok(DatabaseRowTemplateBodyInputsObjectType {
    required_inputs,
    source_revision,
  })
}

pub(crate) async fn list_database_row_templates(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
) -> Result<Vec<DatabaseRowTemplateBindingObjectType>> {
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
  let template_registry = crate::graphql::template_registry::require_template_registry(&state).await?;
  let bindings = service(&state)?
    .editing
    .list_row_template_bindings(snapshot.user.id, database_id, template_registry)
    .await
    .map_err(map_database_error)?;
  Ok(bindings.into_iter().map(map_row_template_binding).collect())
}

pub(crate) async fn create_database_row(
  ctx: &Context<'_>,
  input: CreateDatabaseRowInput,
) -> Result<DatabaseRowRecordObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let creation_view = match (input.view_id, input.expected_view_edit_revision) {
    (None, None) => None,
    (Some(view_id), Some(revision)) if revision >= 1 => Some((parse_uuid_id(&view_id, "viewId")?, revision)),
    _ => {
      return Err(Error::new(
        "viewId and a positive expectedViewEditRevision must be supplied together",
      ));
    }
  };
  let database_service = service(&state)?;
  let database = database_service
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  let cells = input
    .cells
    .unwrap_or_default()
    .into_iter()
    .map(|cell| Ok((parse_uuid_id(&cell.field_id, "fieldId")?, parse_cell_value(cell.value)?)))
    .collect::<Result<Vec<_>>>()?;
  let record = database_service
    .editing
    .create_row_with_view_precondition(snapshot.user.id, database_id, input.title, cells, creation_view)
    .await
    .map_err(map_database_error)?;
  map_row_record_for_read(
    &database_service.editing,
    &database_service.views,
    snapshot.user.id,
    database.database.workspace_id,
    record,
  )
  .await
}

pub(crate) async fn create_database_row_template(
  ctx: &Context<'_>,
  input: CreateDatabaseRowTemplateInput,
) -> Result<DatabaseRowTemplateBindingObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let template_id = parse_uuid_id(&input.template_id, "templateId")?;
  let template_registry = crate::graphql::template_registry::require_template_registry(&state).await?;
  let binding = service(&state)?
    .editing
    .create_row_template(
      snapshot.user.id,
      CreateDatabaseRowTemplate {
        database_id,
        template_id,
        row_kind: input
          .row_kind
          .as_deref()
          .map(domain::DatabaseRowKind::from_str)
          .transpose()
          .map_err(|error| database_error("MIX_DATABASE_ROW_KIND_INVALID", error.to_string()))?
          .unwrap_or_default(),
        name: input.name,
        description: input.description,
        position: input.position,
        enabled: input.enabled.unwrap_or(true),
        is_default: input.is_default.unwrap_or(false),
        initial_cell_values: parse_cell_input_map(input.initial_cell_values.unwrap_or_default())?,
      },
      template_registry,
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_row_template_binding(binding))
}

pub(crate) async fn update_database_row_template(
  ctx: &Context<'_>,
  input: UpdateDatabaseRowTemplateInput,
) -> Result<DatabaseRowTemplateBindingObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let row_template_id = parse_uuid_id(&input.row_template_id, "rowTemplateId")?;
  let description = match input.description {
    MaybeUndefined::Undefined => None,
    MaybeUndefined::Null => Some(None),
    MaybeUndefined::Value(value) => Some(value),
  };
  let template_registry = crate::graphql::template_registry::require_template_registry(&state).await?;
  let binding = service(&state)?
    .editing
    .update_row_template(
      snapshot.user.id,
      row_template_id,
      UpdateDatabaseRowTemplate {
        expected_edit_revision: input.expected_edit_revision,
        name: input.name,
        description,
        position: input.position,
        enabled: input.enabled,
        is_default: input.is_default,
        initial_cell_values: input.initial_cell_values.map(parse_cell_input_map).transpose()?,
      },
      template_registry,
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_row_template_binding(binding))
}

pub(crate) async fn delete_database_row_template(
  ctx: &Context<'_>,
  input: DeleteDatabaseRowTemplateInput,
) -> Result<bool> {
  let (state, snapshot) = require_session(ctx).await?;
  let row_template_id = parse_uuid_id(&input.row_template_id, "rowTemplateId")?;
  service(&state)?
    .editing
    .delete_row_template(snapshot.user.id, row_template_id, input.expected_edit_revision)
    .await
    .map_err(map_database_error)?;
  Ok(true)
}

pub(crate) async fn create_database_row_from_template(
  ctx: &Context<'_>,
  input: CreateDatabaseRowFromTemplateInput,
) -> Result<DatabaseRowRecordObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let database_service = service(&state)?;
  let template_registry = crate::graphql::template_registry::require_template_registry(&state).await?;
  let record = database_service
    .editing
    .create_row_from_template(
      snapshot.user.id,
      domain::DatabaseRowTemplateApplyRequest {
        database_id,
        row_template_id: parse_uuid_id(&input.row_template_id, "rowTemplateId")?,
        title: input.title,
        body_inputs: input.body_inputs.map(|values| values.0).unwrap_or_default(),
        source_revision: input.source_revision,
        override_cell_values: parse_cell_input_map(input.override_cell_values.unwrap_or_default())?,
      },
      template_registry,
      state.document_template_service().as_deref(),
    )
    .await
    .map_err(map_database_error)?;
  // The use case owns template-specific authorization and its typed errors.
  // Resolve the workspace only after it succeeds so this adapter cannot
  // replace `ROW_TEMPLATE_FORBIDDEN` with a generic Database denial.
  let database = database_service
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  map_row_record_for_read(
    &database_service.editing,
    &database_service.views,
    snapshot.user.id,
    database.database.workspace_id,
    record,
  )
  .await
}

pub(crate) async fn update_database_row_title(
  ctx: &Context<'_>,
  input: UpdateDatabaseRowTitleInput,
) -> Result<DatabaseCellValueObjectType> {
  let input = UpdateDatabaseCellValueInput {
    database_id: input.database_id,
    row_id: input.row_id,
    field_id: input.title_field_id,
    value: DatabaseCellValueInput {
      text: Some(input.title),
      rich_text: None,
      number: None,
      percent: None,
      currency: None,
      duration: None,
      checkbox: None,
      date: None,
      date_time: None,
      files: None,
      select: None,
      multi_select: None,
      tags: None,
      status: None,
      user: None,
      users: None,
      document_link: None,
      relation: None,
      rollup: None,
      formula: None,
      url: None,
      email: None,
      phone: None,
    },
    expected_edit_revision: input.expected_edit_revision,
    force: input.force,
  };
  update_database_cell_value(ctx, input).await
}

pub(crate) async fn update_database_row_position(
  ctx: &Context<'_>,
  input: UpdateDatabaseRowPositionInput,
) -> Result<DatabaseRowRecordObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let row_id = parse_uuid_id(&input.row_id, "rowId")?;
  let database_service = service(&state)?;
  let database = database_service
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  let record = database_service
    .editing
    .update_row_position_with_precondition(
      snapshot.user.id,
      database_id,
      row_id,
      input.position,
      input.expected_edit_revision,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  map_row_record_for_read(
    &database_service.editing,
    &database_service.views,
    snapshot.user.id,
    database.database.workspace_id,
    record,
  )
  .await
}

pub(crate) async fn update_database_cell_value(
  ctx: &Context<'_>,
  input: UpdateDatabaseCellValueInput,
) -> Result<DatabaseCellValueObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let row_id = parse_uuid_id(&input.row_id, "rowId")?;
  let field_id = parse_uuid_id(&input.field_id, "fieldId")?;
  let database_service = service(&state)?;
  let database = database_service
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  let cell = database_service
    .editing
    .update_cell_value_with_precondition(
      snapshot.user.id,
      database_id,
      row_id,
      field_id,
      parse_cell_value(input.value)?,
      input.expected_edit_revision,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  map_cell_for_read(
    &database_service.editing,
    &database_service.views,
    snapshot.user.id,
    database.database.workspace_id,
    cell,
  )
  .await
}

pub(crate) async fn clear_database_cell_value(
  ctx: &Context<'_>,
  input: ClearDatabaseCellValueInput,
) -> Result<DatabaseCellRevisionObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let row_id = parse_uuid_id(&input.row_id, "rowId")?;
  let field_id = parse_uuid_id(&input.field_id, "fieldId")?;
  let revision = service(&state)?
    .editing
    .clear_cell_value_with_precondition(
      snapshot.user.id,
      database_id,
      row_id,
      field_id,
      input.expected_edit_revision,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_cell_revision(revision))
}

pub(crate) async fn delete_database_row(ctx: &Context<'_>, input: DeleteDatabaseRowInput) -> Result<bool> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let row_id = parse_uuid_id(&input.row_id, "rowId")?;
  service(&state)?
    .editing
    .delete_row_with_precondition(
      snapshot.user.id,
      database_id,
      row_id,
      input.expected_edit_revision,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(true)
}

// ────────────────────────────────────────────────────────────────────────────
// P-DB-26: bulk operation mutations
// ────────────────────────────────────────────────────────────────────────────

pub(crate) async fn bulk_set_database_cell_value(
  ctx: &Context<'_>,
  input: BulkSetDatabaseCellValueInput,
) -> Result<DatabaseBulkOperationResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let field_id = parse_uuid_id(&input.field_id, "fieldId")?;
  if input.rows.is_empty() {
    return Err(async_graphql::Error::new(
      "bulkSetDatabaseCellValue requires at least one row",
    ));
  }
  // The same `value` is applied to every row, so parse it once.
  let first = input
    .rows
    .first()
    .ok_or_else(|| async_graphql::Error::new("bulkSetDatabaseCellValue requires at least one row"))?;
  let parsed_value = parse_cell_value(first.value.clone())?;
  let row_ids: Vec<DatabaseRowId> = input
    .rows
    .iter()
    .map(|r| parse_uuid_id::<DatabaseRowId>(&r.row_id, "rowId"))
    .collect::<Result<Vec<_>>>()?;
  let mut expected_per_row = HashMap::new();
  for row in &input.rows {
    if let Some(expected) = row.expected_edit_revision {
      let row_id = parse_uuid_id::<DatabaseRowId>(&row.row_id, "rowId")?;
      expected_per_row.insert(row_id, expected);
    }
  }
  let result = service(&state)?
    .editing
    .bulk_set_cell_value_with_precondition(
      snapshot.user.id,
      database_id,
      &row_ids,
      field_id,
      parsed_value,
      &expected_per_row,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(DatabaseBulkOperationResultObjectType::from_domain(result))
}

pub(crate) async fn bulk_clear_database_cell_value(
  ctx: &Context<'_>,
  input: BulkClearDatabaseCellValueInput,
) -> Result<DatabaseBulkOperationResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let field_id = parse_uuid_id(&input.field_id, "fieldId")?;
  let row_ids: Vec<DatabaseRowId> = input
    .row_ids
    .iter()
    .map(|id| parse_uuid_id::<DatabaseRowId>(id, "rowId"))
    .collect::<Result<Vec<_>>>()?;
  let expected_per_row = parse_bulk_expected_per_row(input.expected_edit_revisions.as_ref())?;
  let result = service(&state)?
    .editing
    .bulk_clear_cell_value_with_precondition(
      snapshot.user.id,
      database_id,
      &row_ids,
      field_id,
      &expected_per_row,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(DatabaseBulkOperationResultObjectType::from_domain(result))
}

pub(crate) async fn bulk_apply_database_cell_patches(
  ctx: &Context<'_>,
  input: BulkApplyDatabaseCellPatchesInput,
) -> Result<DatabaseBulkOperationResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let mut patches: Vec<DatabaseBulkRowPatch> = Vec::with_capacity(input.patches.len());
  let mut expected_per_cell = HashMap::new();
  let mut targets = std::collections::HashSet::new();
  for row_patch in input.patches {
    let row_id = parse_uuid_id::<DatabaseRowId>(&row_patch.row_id, "rowId")?;
    let mut cells: Vec<DatabaseBulkCellUpdate> = Vec::with_capacity(row_patch.cells.len());
    for cell in row_patch.cells {
      let field_id = parse_uuid_id::<DatabaseFieldId>(&cell.field_id, "fieldId")?;
      if !targets.insert((row_id, field_id)) {
        return Err(Error::new("a bulk cell target may appear only once"));
      }
      if let Some(expected) = cell.expected_edit_revision {
        expected_per_cell.insert((row_id, field_id), expected);
      }
      let intent = match (cell.clear, cell.value) {
        (false, Some(value)) => DatabaseBulkCellIntent::Set(parse_cell_value(value)?),
        (true, None) if cell.expected_edit_revision.is_some() => DatabaseBulkCellIntent::Clear,
        (true, None) => return Err(Error::new("Clear requires an expected cell edit revision")),
        _ => return Err(Error::new("a cell patch requires exactly one of value or clear")),
      };
      cells.push(DatabaseBulkCellUpdate { field_id, intent });
    }
    patches.push(DatabaseBulkRowPatch { row_id, cells });
  }
  let result = service(&state)?
    .editing
    .bulk_apply_cell_patches_with_precondition(
      snapshot.user.id,
      database_id,
      &patches,
      &expected_per_cell,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(DatabaseBulkOperationResultObjectType::from_domain(result))
}

pub(crate) async fn bulk_delete_database_rows(
  ctx: &Context<'_>,
  input: BulkDeleteDatabaseRowsInput,
) -> Result<DatabaseBulkOperationResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let row_ids: Vec<DatabaseRowId> = input
    .row_ids
    .iter()
    .map(|id| parse_uuid_id::<DatabaseRowId>(id, "rowId"))
    .collect::<Result<Vec<_>>>()?;
  let expected_per_row = parse_bulk_expected_per_row(input.expected_edit_revisions.as_ref())?;
  let result = service(&state)?
    .editing
    .bulk_delete_rows_with_precondition(
      snapshot.user.id,
      database_id,
      &row_ids,
      &expected_per_row,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(DatabaseBulkOperationResultObjectType::from_domain(result))
}

pub(crate) async fn bulk_restore_database_rows(
  ctx: &Context<'_>,
  input: BulkRestoreDatabaseRowsInput,
) -> Result<DatabaseBulkOperationResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let row_ids: Vec<DatabaseRowId> = input
    .row_ids
    .iter()
    .map(|id| parse_uuid_id::<DatabaseRowId>(id, "rowId"))
    .collect::<Result<Vec<_>>>()?;
  let expected_per_row = parse_bulk_expected_per_row(input.expected_edit_revisions.as_ref())?;
  let result = service(&state)?
    .editing
    .bulk_restore_rows_with_precondition(
      snapshot.user.id,
      database_id,
      &row_ids,
      &expected_per_row,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(DatabaseBulkOperationResultObjectType::from_domain(result))
}

pub(crate) async fn bulk_update_database_row_positions(
  ctx: &Context<'_>,
  input: BulkUpdateDatabaseRowPositionsInput,
) -> Result<DatabaseBulkOperationResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let updates: Vec<DatabaseBulkPositionUpdate> = input
    .updates
    .into_iter()
    .map(|u| {
      let row_id = parse_uuid_id::<DatabaseRowId>(&u.row_id, "rowId")?;
      Ok(DatabaseBulkPositionUpdate {
        row_id,
        position: u.position,
      })
    })
    .collect::<Result<Vec<_>>>()?;
  let expected_per_row = parse_bulk_expected_per_row(input.expected_edit_revisions.as_ref())?;
  let result = service(&state)?
    .editing
    .bulk_update_row_positions_with_precondition(
      snapshot.user.id,
      database_id,
      &updates,
      &expected_per_row,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(DatabaseBulkOperationResultObjectType::from_domain(result))
}

pub(super) async fn map_row_for_read(
  editing: &DatabaseEditingService,
  actor: Uuid,
  workspace_id: WorkspaceId,
  row: domain::DatabaseRow,
) -> Result<DatabaseRowObjectType> {
  let content_document = editing
    .resolve_content_document(actor, workspace_id, row.content_document_id)
    .await
    .map_err(map_database_error)?;
  Ok(map_row(row, content_document))
}

async fn map_row_record_for_read(
  editing: &DatabaseEditingService,
  views: &DatabaseViewService,
  actor: Uuid,
  workspace_id: WorkspaceId,
  record: domain::DatabaseRowRecord,
) -> Result<DatabaseRowRecordObjectType> {
  let row = map_row_for_read(editing, actor, workspace_id, record.row).await?;
  let mut cells = Vec::with_capacity(record.cells.len());
  for cell in record.cells {
    cells.push(map_cell_for_read(editing, views, actor, workspace_id, cell).await?);
  }
  Ok(DatabaseRowRecordObjectType {
    row,
    cells,
    cell_revisions: record.cell_revisions.into_iter().map(map_cell_revision).collect(),
    group_keys: Vec::new(),
    redacted: false,
  })
}

pub(super) async fn map_cell_for_read(
  editing: &DatabaseEditingService,
  views: &DatabaseViewService,
  actor: Uuid,
  workspace_id: WorkspaceId,
  cell: domain::DatabaseCellValue,
) -> Result<DatabaseCellValueObjectType> {
  let document_link_id = match &cell.value {
    domain::DatabaseCellValueData::DocumentLink(value) => {
      Some((value.doc_id, value.workspace_id.unwrap_or(workspace_id)))
    }
    _ => None,
  };
  let relation_target_ids = match &cell.value {
    domain::DatabaseCellValueData::Relation(target_row_ids) => Some(target_row_ids.clone()),
    _ => None,
  };
  let mut mapped = map_cell(cell);
  if let Some((document_id, target_workspace_id)) = document_link_id {
    let target = editing
      .resolve_document_link(actor, target_workspace_id, document_id)
      .await
      .map_err(map_database_error)?
      .map(map_content_document);
    if let Some(document_link) = mapped.value.document_link.as_mut() {
      document_link.target = target;
    }
  }
  if let Some(target_row_ids) = relation_target_ids {
    let targets = views
      .relation_targets(actor, &target_row_ids)
      .await
      .map_err(map_database_error)?;
    let mut relation_targets = Vec::with_capacity(targets.len());
    for target in targets {
      let content_document = editing
        .resolve_content_document(actor, workspace_id, target.content_document_id)
        .await
        .map_err(map_database_error)?
        .map(map_content_document);
      relation_targets.push(DatabaseRelationTargetObjectType {
        row_id: ID::from(target.row_id.to_string()),
        content_document,
        title: target.title,
        redacted: target.redacted,
        deleted: target.deleted,
      });
    }
    mapped.value.relation_targets = Some(relation_targets);
  }
  Ok(mapped)
}

pub(crate) async fn create_database_row_content_document(
  ctx: &Context<'_>,
  input: CreateDatabaseRowContentDocumentInput,
) -> Result<DatabaseRowRecordObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let row_id = parse_uuid_id(&input.row_id, "rowId")?;
  let database_service = service(&state)?;
  let database = database_service
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  let (record, sync_updates) = database_service
    .editing
    .create_row_content_document_with_sync_updates(snapshot.user.id, database_id, row_id, input.expected_edit_revision)
    .await
    .map_err(map_database_error)?;
  let content_document_id = record
    .row
    .content_document_id
    .ok_or_else(|| Error::new("created Row content document is missing its document id"))?;
  crate::websocket::broadcast_server_workspace_doc_update(
    &state,
    database.database.workspace_id,
    content_document_id,
    &sync_updates.document,
    snapshot.user.id,
  )
  .await;
  crate::websocket::broadcast_server_workspace_doc_update(
    &state,
    database.database.workspace_id,
    database.database.workspace_id,
    &sync_updates.workspace_root,
    snapshot.user.id,
  )
  .await;
  map_row_record_for_read(
    &database_service.editing,
    &database_service.views,
    snapshot.user.id,
    database.database.workspace_id,
    record,
  )
  .await
}

pub(crate) async fn attach_database_row_content_document(
  ctx: &Context<'_>,
  input: AttachDatabaseRowContentDocumentInput,
) -> Result<DatabaseRowRecordObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let row_id = parse_uuid_id(&input.row_id, "rowId")?;
  let document_id = parse_uuid_id(&input.document_id, "documentId")?;
  let database_service = service(&state)?;
  let database = database_service
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  let record = database_service
    .editing
    .attach_row_content_document(
      snapshot.user.id,
      database_id,
      row_id,
      document_id,
      input.expected_edit_revision,
    )
    .await
    .map_err(map_database_error)?;
  map_row_record_for_read(
    &database_service.editing,
    &database_service.views,
    snapshot.user.id,
    database.database.workspace_id,
    record,
  )
  .await
}

pub(crate) async fn detach_database_row_content_document(
  ctx: &Context<'_>,
  input: DetachDatabaseRowContentDocumentInput,
) -> Result<DatabaseRowRecordObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let row_id = parse_uuid_id(&input.row_id, "rowId")?;
  let database_service = service(&state)?;
  let database = database_service
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  let record = database_service
    .editing
    .detach_row_content_document(snapshot.user.id, database_id, row_id, input.expected_edit_revision)
    .await
    .map_err(map_database_error)?;
  map_row_record_for_read(
    &database_service.editing,
    &database_service.views,
    snapshot.user.id,
    database.database.workspace_id,
    record,
  )
  .await
}

async fn map_capture_result(
  editing: &DatabaseEditingService,
  views: &DatabaseViewService,
  actor: Uuid,
  result: myoxus_application::database::DatabaseTaskCaptureResult,
) -> Result<DatabaseTaskCaptureResultObjectType> {
  let receipt = result.receipt;
  let projection = editing
    .capture_source_projection(actor, &receipt.source)
    .await
    .map_err(map_database_error)?;
  let state = if result.target_trashed {
    DatabaseTaskCaptureStateType::Trashed
  } else {
    match result.record.as_ref() {
      None => DatabaseTaskCaptureStateType::Missing,
      Some(r) if r.row.deleted_at.is_some() => DatabaseTaskCaptureStateType::Trashed,
      Some(_) => DatabaseTaskCaptureStateType::Available,
    }
  };
  // The receipt retains its original admission scope. Navigation follows the
  // already authorized current owner of that same Row after an explicit move.
  let current_database_id = result
    .record
    .as_ref()
    .map(|row| row.row.database_id)
    .unwrap_or(receipt.database_id);
  let record = match result.record {
    Some(r) => Some(map_row_record_for_read(editing, views, actor, receipt.workspace_id, r).await?),
    None => None,
  };
  Ok(DatabaseTaskCaptureResultObjectType {
    request_id: ID::from(receipt.request_id.to_string()),
    database_id: ID::from(current_database_id.to_string()),
    row_id: ID::from(receipt.row_id.to_string()),
    edit_revision: receipt.edit_revision,
    state,
    replayed: result.replayed,
    record,
    source: map_task_source(receipt.source, projection),
  })
}

pub(crate) async fn create_database_task_from_source(
  ctx: &Context<'_>,
  input: CreateDatabaseTaskFromSourceInput,
) -> Result<DatabaseTaskCaptureResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let services = service(&state)?;
  let cells = input
    .cells
    .unwrap_or_default()
    .into_iter()
    .map(|cell| Ok((parse_uuid_id(&cell.field_id, "fieldId")?, parse_cell_value(cell.value)?)))
    .collect::<Result<Vec<_>>>()?;
  let result = services
    .editing
    .create_task_from_source(
      snapshot.user.id,
      myoxus_application::database::DatabaseTaskCaptureInput {
        workspace_id: parse_uuid_id(&input.workspace_id, "workspaceId")?,
        database_id: parse_uuid_id(&input.database_id, "databaseId")?,
        request_id: parse_uuid_id(&input.request_id, "requestId")?,
        source_document_id: parse_uuid_id(&input.source_document_id, "sourceDocumentId")?,
        source_external_id: input.source_external_id.to_string(),
        block_id: input.block_id,
        selection_anchor: input.selection_anchor,
        title: input.title,
        cells,
      },
    )
    .await
    .map_err(map_database_error)?;
  map_capture_result(&services.editing, &services.views, snapshot.user.id, result).await
}

pub(crate) async fn get_database_task_capture_receipt(
  ctx: &Context<'_>,
  workspace: Uuid,
  request: ID,
) -> Result<Option<DatabaseTaskCaptureResultObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let services = service(&state)?;
  match services
    .editing
    .task_capture_receipt(snapshot.user.id, workspace, parse_uuid_id(&request, "requestId")?)
    .await
    .map_err(map_database_error)?
  {
    Some(result) => Ok(Some(
      map_capture_result(&services.editing, &services.views, snapshot.user.id, result).await?,
    )),
    None => Ok(None),
  }
}

#[ComplexObject]
impl DatabaseRowObjectType {
  /// Outgoing IDs remain the source Cell's identities, even when unresolved.
  async fn task_blocked_by(
    &self,
    ctx: &Context<'_>,
    first: Option<i32>,
    after: Option<String>,
  ) -> Result<DatabaseTaskBlockedByObjectType> {
    let (state, snapshot) = require_session(ctx).await?;
    let page = service(&state)?
      .views
      .task_blocking(
        snapshot.user.id,
        parse_uuid_id(&self.database_id, "databaseId")?,
        parse_uuid_id(&self.id, "rowId")?,
        false,
        first.map(i64::from),
        after,
      )
      .await
      .map_err(map_database_error)?;
    Ok(DatabaseTaskBlockedByObjectType {
      available: page.available,
      field_id: page.field_id.map(|id| ID::from(id.to_string())),
      diagnostics: page.diagnostics.into_iter().map(Into::into).collect(),
      retained_row_ids: page
        .retained_row_ids
        .into_iter()
        .map(|id| ID::from(id.to_string()))
        .collect(),
      rows: page.rows.into_iter().map(map_task_blocking_entry).collect(),
      next_cursor: page.next_cursor,
    })
  }

  /// The inverse is derived from canonical Cells; state describes this source
  /// prerequisite's activity, while each Task summary describes its dependent.
  async fn task_blocks(
    &self,
    ctx: &Context<'_>,
    first: Option<i32>,
    after: Option<String>,
  ) -> Result<DatabaseTaskBlocksObjectType> {
    let (state, snapshot) = require_session(ctx).await?;
    let page = service(&state)?
      .views
      .task_blocking(
        snapshot.user.id,
        parse_uuid_id(&self.database_id, "databaseId")?,
        parse_uuid_id(&self.id, "rowId")?,
        true,
        first.map(i64::from),
        after,
      )
      .await
      .map_err(map_database_error)?;
    Ok(DatabaseTaskBlocksObjectType {
      available: page.available,
      field_id: page.field_id.map(|id| ID::from(id.to_string())),
      diagnostics: page.diagnostics.into_iter().map(Into::into).collect(),
      rows: page.rows.into_iter().map(map_task_blocking_entry).collect(),
      next_cursor: page.next_cursor,
    })
  }

  /// Explicit detail projection; ordinary Row fragments incur no child reads.
  async fn task_children(
    &self,
    ctx: &Context<'_>,
    first: Option<i32>,
    after: Option<String>,
  ) -> Result<DatabaseTaskChildrenObjectType> {
    let (state, snapshot) = require_session(ctx).await?;
    let page = service(&state)?
      .views
      .task_children(
        snapshot.user.id,
        parse_uuid_id(&self.database_id, "databaseId")?,
        parse_uuid_id(&self.id, "rowId")?,
        first.map(i64::from),
        after,
      )
      .await
      .map_err(map_database_error)?;
    Ok(DatabaseTaskChildrenObjectType {
      available: page.available,
      field_id: page.field_id.map(|id| ID::from(id.to_string())),
      diagnostics: page.diagnostics.into_iter().map(Into::into).collect(),
      rows: page.rows.into_iter().map(map_task_summary).collect(),
      total_count: page.total_count,
      complete_count: page.complete_count,
      archived_count: page.archived_count,
      next_cursor: page.next_cursor,
    })
  }

  /// Explicitly selected diagnostics never load target titles or repair Cells.
  async fn task_parent(&self, ctx: &Context<'_>) -> Result<DatabaseTaskParentObjectType> {
    let (state, snapshot) = require_session(ctx).await?;
    let projection = service(&state)?
      .views
      .task_parent(
        snapshot.user.id,
        parse_uuid_id(&self.database_id, "databaseId")?,
        parse_uuid_id(&self.id, "rowId")?,
      )
      .await
      .map_err(map_database_error)?;
    Ok(DatabaseTaskParentObjectType {
      available: projection.available,
      field_id: projection.field_id.map(|id| ID::from(id.to_string())),
      parent_row_ids: projection
        .parent_row_ids
        .into_iter()
        .map(|id| ID::from(id.to_string()))
        .collect(),
      diagnostics: projection.diagnostics.into_iter().map(Into::into).collect(),
    })
  }
  /// Resolve only when selected; paged Row lists must not load full Database
  /// schemas and origin metadata merely because capture exists.
  async fn source(&self, ctx: &Context<'_>) -> Result<Option<DatabaseTaskSourceObjectType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let services = service(&state)?;
    let database = services
      .definition
      .get_database(snapshot.user.id, parse_uuid_id(&self.database_id, "databaseId")?)
      .await
      .map_err(map_database_error)?;
    let source = services
      .editing
      .task_source(
        snapshot.user.id,
        database.database.workspace_id,
        parse_uuid_id(&self.id, "rowId")?,
      )
      .await
      .map_err(map_database_error)?;
    Ok(source.map(|(source, projection)| map_task_source(source, projection)))
  }
}
