// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native Row records, Cell revisions and reusable content-template values.
use crate::database::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseRow {
  pub id: DatabaseRowId,
  pub database_id: DatabaseId,
  /// Optional free-form page body. The physical SQL column remains `doc_id`;
  /// Row identity, title and typed Cells stay authoritative without it.
  pub content_document_id: Option<DocId>,
  #[serde(default)]
  pub row_kind: DatabaseRowKind,
  pub title: String,
  pub position: i32,
  pub created_by: Option<UserId>,
  pub updated_by: Option<UserId>,
  /// Monotonic optimistic-concurrency token for row-owned state.
  pub edit_revision: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseCellValue {
  pub row_id: DatabaseRowId,
  pub field_id: DatabaseFieldId,
  pub field_type: DatabaseFieldType,
  pub value: DatabaseCellValueData,
  pub updated_by: Option<UserId>,
  /// Monotonic optimistic-concurrency token for this cell value.
  pub edit_revision: i64,
  pub updated_at: DateTime<Utc>,
}

/// IDs-only committed Task intent. Recipients are an event-time union; every
/// delivery still requires the current original scope, lifecycle and role Cells.
#[derive(Debug, Clone)]
pub struct DatabaseCellWriteOutcome {
  pub cell: DatabaseCellValue,
  pub change: DatabaseCommittedCellChange,
}

#[derive(Debug, Clone)]
pub struct DatabaseCellClearOutcome {
  pub revision: DatabaseCellRevision,
  pub change: DatabaseCommittedCellChange,
}

/// Revision state for a cell slot, including a cleared-value tombstone.
///
/// A missing entry means the cell has never existed and therefore has revision
/// `0`. A present entry may have `has_value == false` after a clear operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCellRevision {
  pub row_id: DatabaseRowId,
  pub field_id: DatabaseFieldId,
  pub edit_revision: i64,
  pub has_value: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRowTemplate {
  /// Native mutable-content revision; portable older snapshots start at baseline1.
  #[serde(default = "initial_row_template_edit_revision")]
  pub edit_revision: i64,
  /// An operation-cloned body belongs to this Database binding, independently
  /// of the shared registry blueprint/its one-per-workspace central instance.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub content_document_id: Option<DocId>,
  pub id: Uuid,
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub template_id: TemplateCatalogEntryId,
  pub row_kind: DatabaseRowKind,
  pub name: String,
  pub description: Option<String>,
  pub position: i32,
  pub enabled: bool,
  pub is_default: bool,
  pub initial_cell_values: BTreeMap<DatabaseFieldId, DatabaseCellValueData>,
  pub created_by: Option<UserId>,
  pub updated_by: Option<UserId>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

fn initial_row_template_edit_revision() -> i64 {
  1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRowTemplateBinding {
  pub row_template: DatabaseRowTemplate,
  pub template_available: bool,
  pub reconcile_required: bool,
  pub detached: bool,
  pub disabled: bool,
  pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRowTemplateApplyRequest {
  pub database_id: DatabaseId,
  pub row_template_id: Uuid,
  pub title: Option<String>,
  pub override_cell_values: BTreeMap<DatabaseFieldId, DatabaseCellValueData>,
  /// Literal manual body values; Row Cells and the Row title are separate.
  #[serde(default)]
  pub body_inputs: BTreeMap<String, String>,
  /// Captured source identity from the optional interactive preflight.
  #[serde(default)]
  pub source_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseRowRecord {
  pub row: DatabaseRow,
  pub cells: Vec<DatabaseCellValue>,
  #[serde(default)]
  pub cell_revisions: Vec<DatabaseCellRevision>,
}

/// Semantic row kind for server-owned Database rows.
///
/// Generic Databases use `Record`. Project Databases can mix `Task`, `Phase`
/// and `Milestone` rows in the same table; role mappings and relation fields
/// define how those row kinds relate.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseRowKind {
  #[default]
  Record,
  Task,
  Phase,
  Milestone,
}

impl DatabaseRowKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Record => "record",
      Self::Task => "task",
      Self::Phase => "phase",
      Self::Milestone => "milestone",
    }
  }
}

impl FromStr for DatabaseRowKind {
  type Err = DatabaseDomainError;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "record" => Ok(Self::Record),
      "task" => Ok(Self::Task),
      "phase" => Ok(Self::Phase),
      "milestone" => Ok(Self::Milestone),
      _ => Err(DatabaseDomainError::InvalidRowKind(value.to_string())),
    }
  }
}
