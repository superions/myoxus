// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native typed Cell values and document-content read state.
use crate::database::*;

pub fn format_database_unique_id(prefix: &str, sequence: i64, padding: i32) -> String {
  let safe_padding = padding.clamp(0, 32) as usize;
  let number = if safe_padding > 0 {
    format!("{sequence:0safe_padding$}")
  } else {
    sequence.to_string()
  };
  format!("{prefix}{number}")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseUniqueIdValue {
  pub prefix: String,
  pub sequence: i64,
  pub display: String,
}

/// A date cell stores either one day or an inclusive range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDateValue {
  pub start: NaiveDate,
  pub end: Option<NaiveDate>,
}

/// Timed or all-day date range with an explicit IANA timezone identifier.
///
/// `start` and `end` are stored as UTC instants. `time_zone` preserves the
/// user's intended local display context so Calendar/Timeline views do not need
/// route-local timezone guesses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDateTimeValue {
  pub start: DateTime<Utc>,
  pub end: Option<DateTime<Utc>>,
  #[serde(default)]
  pub all_day: bool,
  pub time_zone: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFileReference {
  pub blob_key: String,
  pub name: Option<String>,
  pub mime: Option<String>,
  pub size: Option<i64>,
  pub caption: Option<String>,
  #[serde(default)]
  pub cover: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFilesValue {
  #[serde(default)]
  pub files: Vec<DatabaseFileReference>,
}

/// Optional row-to-document reference stored as a normal Database cell value.
///
/// This lateral link is distinct from a Row content-document association. It
/// stores only the SQL document UUID and optional target workspace; availability, deletion and
/// permission-redaction state are derived by the application layer on reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDocumentLinkValue {
  pub doc_id: DocId,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub workspace_id: Option<WorkspaceId>,
}

/// Permission-safe state of an optional Row content document.
///
/// This projection deliberately separates the Row-owned identity and title
/// from an associated workspace document. A null association is represented by
/// `None`; `Missing` is reserved for a stored id that no longer resolves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseRowContentDocumentState {
  Available,
  Deleted,
  Missing,
  Redacted,
}

/// Actor-aware read projection for Row content and DocumentLink targets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRowContentDocument {
  /// Server-internal surrogate used by Database foreign keys and mutations.
  pub document_id: DocId,
  /// Workspace-local client key used by editor routes. It is withheld unless
  /// the target is readable and available.
  pub external_id: Option<String>,
  /// Present only for a readable available target; Row ownership is unchanged.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub workspace_id: Option<WorkspaceId>,
  pub state: DatabaseRowContentDocumentState,
  /// Present only for [`DatabaseRowContentDocumentState::Available`].
  pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRichTextValue {
  pub plain_text: String,
  #[serde(default)]
  pub document: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCurrencyValue {
  pub amount: f64,
  pub currency_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDurationValue {
  pub minutes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum DatabaseRollupScalarValue {
  Number(f64),
  Text(String),
  Currency(DatabaseCurrencyValue),
  Duration(DatabaseDurationValue),
  Checkbox(bool),
  Date(DatabaseDateValue),
  TextList(Vec<String>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseRollupStaleState {
  Current,
  Stale,
  Queued,
  Failed,
  RecomputePending,
}

impl DatabaseRollupStaleState {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Current => "current",
      Self::Stale => "stale",
      Self::Queued => "queued",
      Self::Failed => "failed",
      Self::RecomputePending => "recompute_pending",
    }
  }
}

impl FromStr for DatabaseRollupStaleState {
  type Err = DatabaseDomainError;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "current" => Ok(Self::Current),
      "stale" => Ok(Self::Stale),
      "queued" => Ok(Self::Queued),
      "failed" => Ok(Self::Failed),
      "recompute_pending" => Ok(Self::RecomputePending),
      _ => Err(DatabaseDomainError::InvalidRollupStaleState(value.to_string())),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRollupValue {
  pub value: Option<DatabaseRollupScalarValue>,
  pub stale_state: DatabaseRollupStaleState,
  pub computed_at: Option<DateTime<Utc>>,
  pub failed_at: Option<DateTime<Utc>>,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum DatabaseFormulaScalarValue {
  Number(f64),
  Percent(f64),
  Currency(DatabaseCurrencyValue),
  Duration(DatabaseDurationValue),
  Text(String),
  Checkbox(bool),
  Date(DatabaseDateValue),
  DateTime(DatabaseDateTimeValue),
  User(UserId),
  Users(Vec<UserId>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseFormulaStaleState {
  Current,
  Stale,
  Queued,
  Failed,
  RecomputePending,
}

impl DatabaseFormulaStaleState {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Current => "current",
      Self::Stale => "stale",
      Self::Queued => "queued",
      Self::Failed => "failed",
      Self::RecomputePending => "recompute_pending",
    }
  }
}

impl FromStr for DatabaseFormulaStaleState {
  type Err = DatabaseDomainError;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "current" => Ok(Self::Current),
      "stale" => Ok(Self::Stale),
      "queued" => Ok(Self::Queued),
      "failed" => Ok(Self::Failed),
      "recompute_pending" => Ok(Self::RecomputePending),
      _ => Err(DatabaseDomainError::InvalidFormulaStaleState(value.to_string())),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFormulaValue {
  pub value: Option<DatabaseFormulaScalarValue>,
  pub stale_state: DatabaseFormulaStaleState,
  pub computed_at: Option<DateTime<Utc>>,
  pub failed_at: Option<DateTime<Utc>>,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum DatabaseCellValueData {
  Text(String),
  RichText(DatabaseRichTextValue),
  Number(f64),
  Percent(f64),
  Currency(DatabaseCurrencyValue),
  Duration(DatabaseDurationValue),
  Checkbox(bool),
  Date(DatabaseDateValue),
  DateTime(DatabaseDateTimeValue),
  Files(DatabaseFilesValue),
  UniqueId(DatabaseUniqueIdValue),
  Select(String),
  MultiSelect(Vec<String>),
  Tags(Vec<Uuid>),
  Status(String),
  User(UserId),
  Users(Vec<UserId>),
  DocumentLink(DatabaseDocumentLinkValue),
  Relation(Vec<DatabaseRowId>),
  Rollup(DatabaseRollupValue),
  Formula(DatabaseFormulaValue),
  Url(String),
  Email(String),
  Phone(String),
  CreatedTime(DateTime<Utc>),
  CreatedBy(UserId),
  UpdatedTime(DateTime<Utc>),
  UpdatedBy(UserId),
}
