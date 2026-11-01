// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native Database roots, field definitions and typed configuration.
use crate::database::*;

/// Stable server-owned field kind set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseFieldType {
  Title,
  Text,
  RichText,
  Number,
  Percent,
  Currency,
  Duration,
  Checkbox,
  Date,
  DateTime,
  Files,
  UniqueId,
  Select,
  MultiSelect,
  Tags,
  Status,
  User,
  Users,
  DocumentLink,
  Relation,
  Rollup,
  Formula,
  Url,
  Email,
  Phone,
  CreatedTime,
  CreatedBy,
  UpdatedTime,
  UpdatedBy,
}

impl DatabaseFieldType {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Title => "title",
      Self::Text => "text",
      Self::RichText => "rich_text",
      Self::Number => "number",
      Self::Percent => "percent",
      Self::Currency => "currency",
      Self::Duration => "duration",
      Self::Checkbox => "checkbox",
      Self::Date => "date",
      Self::DateTime => "date_time",
      Self::Files => "files",
      Self::UniqueId => "unique_id",
      Self::Select => "select",
      Self::MultiSelect => "multi_select",
      Self::Tags => "tags",
      Self::Status => "status",
      Self::User => "user",
      Self::Users => "users",
      Self::DocumentLink => "document_link",
      Self::Relation => "relation",
      Self::Rollup => "rollup",
      Self::Formula => "formula",
      Self::Url => "url",
      Self::Email => "email",
      Self::Phone => "phone",
      Self::CreatedTime => "created_time",
      Self::CreatedBy => "created_by",
      Self::UpdatedTime => "updated_time",
      Self::UpdatedBy => "updated_by",
    }
  }

  /// Whether saved-view ordering has a stable typed comparison for this field.
  /// Collection-like, relation, file and derived values deliberately
  /// stay out until their product ordering semantics are explicitly defined.
  pub fn supports_saved_sort(self) -> bool {
    matches!(
      self,
      Self::Title
        | Self::Text
        | Self::RichText
        | Self::Number
        | Self::Percent
        | Self::Currency
        | Self::Duration
        | Self::Checkbox
        | Self::Date
        | Self::DateTime
        | Self::UniqueId
        | Self::Select
        | Self::Status
        | Self::User
        | Self::Users
        | Self::Url
        | Self::Email
        | Self::Phone
        | Self::CreatedTime
        | Self::UpdatedTime
    )
  }

  /// Whether the authoritative row-query planner can project this field into
  /// Table search. File payloads have no stable searchable text representation;
  /// every other field uses its typed server projection.
  pub fn supports_server_search(self) -> bool {
    !matches!(self, Self::Files)
  }
}

impl FromStr for DatabaseFieldType {
  type Err = DatabaseDomainError;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "title" => Ok(Self::Title),
      "text" => Ok(Self::Text),
      "rich_text" => Ok(Self::RichText),
      "number" => Ok(Self::Number),
      "percent" => Ok(Self::Percent),
      "currency" => Ok(Self::Currency),
      "duration" => Ok(Self::Duration),
      "checkbox" => Ok(Self::Checkbox),
      "date" => Ok(Self::Date),
      "date_time" => Ok(Self::DateTime),
      "files" => Ok(Self::Files),
      "unique_id" => Ok(Self::UniqueId),
      "select" => Ok(Self::Select),
      "multi_select" => Ok(Self::MultiSelect),
      "tags" => Ok(Self::Tags),
      "status" => Ok(Self::Status),
      "user" => Ok(Self::User),
      "users" => Ok(Self::Users),
      "document_link" => Ok(Self::DocumentLink),
      "relation" => Ok(Self::Relation),
      "rollup" => Ok(Self::Rollup),
      "formula" => Ok(Self::Formula),
      "url" => Ok(Self::Url),
      "email" => Ok(Self::Email),
      "phone" => Ok(Self::Phone),
      "created_time" => Ok(Self::CreatedTime),
      "created_by" => Ok(Self::CreatedBy),
      "updated_time" => Ok(Self::UpdatedTime),
      "updated_by" => Ok(Self::UpdatedBy),
      _ => Err(DatabaseDomainError::InvalidFieldType(value.to_string())),
    }
  }
}

/// Product-neutral color role for select option chips/cards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSelectOption {
  pub id: String,
  pub name: String,
  pub position: i32,
  pub color_role: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTextFieldConfig {
  #[serde(default)]
  pub multiline: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRichTextFieldConfig {
  pub max_plain_text_bytes: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseNumberFieldConfig {
  pub format: Option<String>,
}

/// Percent values are stored in percent points, not fractions.
///
/// A stored value of `42.5` means `42.5%`. Field-level ranges are optional for
/// generic Databases; product roles such as Project progress set `0..100`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DatabasePercentFieldConfig {
  pub min_value: Option<f64>,
  pub max_value: Option<f64>,
}

/// Money values are stored as decimal amounts plus ISO-4217 currency codes.
///
/// Formatting is deliberately kept out of storage. The field default records
/// the server/Admin-owned currency that import, template and editor paths use
/// when a user supplies an amount without a currency code.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCurrencyFieldConfig {
  pub default_currency: String,
  #[serde(default)]
  pub allow_currency_override: bool,
  pub min_value: Option<f64>,
  pub max_value: Option<f64>,
}

impl Default for DatabaseCurrencyFieldConfig {
  fn default() -> Self {
    Self {
      default_currency: default_database_currency_code(),
      allow_currency_override: false,
      min_value: None,
      max_value: None,
    }
  }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseDurationDisplayUnit {
  #[default]
  Minutes,
  Hours,
  Days,
}

/// Duration values are stored as canonical integer minutes.
///
/// `display_unit` is a presentation hint for editors/imports only; storage,
/// sorting, filtering and rollups never depend on the chosen display unit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDurationFieldConfig {
  #[serde(default)]
  pub display_unit: DatabaseDurationDisplayUnit,
  pub min_minutes: Option<i64>,
  pub max_minutes: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseUsersFieldConfig {
  pub min_count: Option<i32>,
  pub max_count: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTagsFieldConfig {
  pub max_count: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDateFieldConfig {
  #[serde(default)]
  pub include_time: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDateTimeFieldConfig {
  pub default_time_zone: Option<String>,
  #[serde(default)]
  pub allow_reminders: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseFileMimeCategory {
  Any,
  Image,
  Video,
  Audio,
  Pdf,
  Document,
  Archive,
}

impl DatabaseFileMimeCategory {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Any => "any",
      Self::Image => "image",
      Self::Video => "video",
      Self::Audio => "audio",
      Self::Pdf => "pdf",
      Self::Document => "document",
      Self::Archive => "archive",
    }
  }

  pub fn matches_mime(self, mime: &str) -> bool {
    let mime = mime.trim().to_ascii_lowercase();
    match self {
      Self::Any => true,
      Self::Image => mime.starts_with("image/"),
      Self::Video => mime.starts_with("video/"),
      Self::Audio => mime.starts_with("audio/"),
      Self::Pdf => mime == "application/pdf",
      Self::Document => matches!(
        mime.as_str(),
        "text/plain"
          | "text/markdown"
          | "text/csv"
          | "application/json"
          | "application/msword"
          | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          | "application/vnd.ms-excel"
          | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          | "application/vnd.ms-powerpoint"
          | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      ),
      Self::Archive => matches!(
        mime.as_str(),
        "application/zip" | "application/gzip" | "application/x-tar" | "application/x-7z-compressed"
      ),
    }
  }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseFilesPreviewPolicy {
  #[default]
  Auto,
  Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFilesFieldConfig {
  #[serde(default)]
  pub allowed_mime_categories: Vec<DatabaseFileMimeCategory>,
  pub max_item_count: Option<i32>,
  pub max_item_size: Option<i64>,
  #[serde(default)]
  pub preview_policy: DatabaseFilesPreviewPolicy,
}

impl Default for DatabaseFilesFieldConfig {
  fn default() -> Self {
    Self {
      allowed_mime_categories: vec![DatabaseFileMimeCategory::Any],
      max_item_count: None,
      max_item_size: None,
      preview_policy: DatabaseFilesPreviewPolicy::Auto,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseUniqueIdFieldConfig {
  #[serde(default)]
  pub prefix: String,
  #[serde(default = "default_database_unique_id_start_number")]
  pub start_number: i64,
  #[serde(default = "default_database_unique_id_padding")]
  pub padding: i32,
}

impl Default for DatabaseUniqueIdFieldConfig {
  fn default() -> Self {
    Self {
      prefix: String::new(),
      start_number: default_database_unique_id_start_number(),
      padding: default_database_unique_id_padding(),
    }
  }
}

pub fn default_database_unique_id_start_number() -> i64 {
  1
}

pub fn default_database_unique_id_padding() -> i32 {
  3
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSelectFieldConfig {
  #[serde(default)]
  pub options: Vec<DatabaseSelectOption>,
}

/// Semantic lifecycle group for Status fields.
///
/// Status groups are intentionally separate from option labels. Project and
/// workflow behavior must key off this stable group value, not localized names
/// such as "Done" or "In progress".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseStatusGroup {
  NotStarted,
  Active,
  Complete,
  Archived,
}

impl DatabaseStatusGroup {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::NotStarted => "notStarted",
      Self::Active => "active",
      Self::Complete => "complete",
      Self::Archived => "archived",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStatusOption {
  pub id: String,
  pub name: String,
  pub position: i32,
  pub color_role: String,
  pub group: DatabaseStatusGroup,
}

/// Field config for first-class Status properties.
///
/// This deliberately does not reuse Select config: Status options carry a
/// lifecycle group and a default option so Kanban grouping, completion policy
/// and import/export can depend on stable semantics instead of field names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStatusFieldConfig {
  #[serde(default)]
  pub options: Vec<DatabaseStatusOption>,
  pub default_option_id: String,
}

/// Native Status structure shared by API validation and transactional writers.
pub fn validate_database_status_field_config(config: &DatabaseStatusFieldConfig) -> Result<(), String> {
  let mut ids = BTreeSet::new();
  let mut groups = BTreeSet::new();
  for option in &config.options {
    if option.id.trim().is_empty() || option.name.trim().is_empty() || option.color_role.trim().is_empty() {
      return Err("status options require id, name and color role".into());
    }
    if !ids.insert(option.id.clone()) {
      return Err("status option ids must be unique".into());
    }
    if option.color_role.contains('#') || option.color_role.contains("rgb") || option.color_role.contains("hsl") {
      return Err("status option color roles must be product-neutral roles, not raw colors".into());
    }
    groups.insert(option.group.as_str());
  }
  if ![
    DatabaseStatusGroup::NotStarted,
    DatabaseStatusGroup::Active,
    DatabaseStatusGroup::Complete,
  ]
  .iter()
  .all(|group| groups.contains(group.as_str()))
  {
    return Err("status fields require notStarted, active and complete groups".into());
  }
  if !ids.contains(&config.default_option_id) {
    return Err("status default option must exist in field options".into());
  }
  Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRelationFieldConfig {
  pub target_database_id: DatabaseId,
  #[serde(default)]
  pub allow_multiple: bool,
  pub reciprocal_field_id: Option<DatabaseFieldId>,
  pub max_targets: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseRollupAggregate {
  Count,
  CountValues,
  Sum,
  Average,
  Min,
  Max,
  Earliest,
  Latest,
  CheckedPercent,
  UncheckedPercent,
  UniqueValues,
}

impl DatabaseRollupAggregate {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Count => "count",
      Self::CountValues => "count_values",
      Self::Sum => "sum",
      Self::Average => "average",
      Self::Min => "min",
      Self::Max => "max",
      Self::Earliest => "earliest",
      Self::Latest => "latest",
      Self::CheckedPercent => "checked_percent",
      Self::UncheckedPercent => "unchecked_percent",
      Self::UniqueValues => "unique_values",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseRollupStalePolicy {
  Async,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRollupFieldConfig {
  pub source_relation_field_id: DatabaseFieldId,
  pub target_field_id: DatabaseFieldId,
  pub aggregate: DatabaseRollupAggregate,
  pub empty_value: Option<DatabaseRollupScalarValue>,
  pub stale_policy: DatabaseRollupStalePolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseFormulaResultType {
  Text,
  Number,
  Percent,
  Currency,
  Duration,
  Checkbox,
  Date,
  DateTime,
  User,
  Users,
}

impl DatabaseFormulaResultType {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Text => "text",
      Self::Number => "number",
      Self::Percent => "percent",
      Self::Currency => "currency",
      Self::Duration => "duration",
      Self::Checkbox => "checkbox",
      Self::Date => "date",
      Self::DateTime => "date_time",
      Self::User => "user",
      Self::Users => "users",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseFormulaStalePolicy {
  Async,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFormulaFieldConfig {
  pub expression: String,
  pub result_type: DatabaseFormulaResultType,
  #[serde(default)]
  pub dependency_field_ids: Vec<DatabaseFieldId>,
  pub stale_policy: DatabaseFormulaStalePolicy,
  pub format: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseFieldConfig {
  Title,
  Text(DatabaseTextFieldConfig),
  RichText(DatabaseRichTextFieldConfig),
  Number(DatabaseNumberFieldConfig),
  Percent(DatabasePercentFieldConfig),
  Currency(DatabaseCurrencyFieldConfig),
  Duration(DatabaseDurationFieldConfig),
  Checkbox,
  Date(DatabaseDateFieldConfig),
  DateTime(DatabaseDateTimeFieldConfig),
  Files(DatabaseFilesFieldConfig),
  UniqueId(DatabaseUniqueIdFieldConfig),
  Select(DatabaseSelectFieldConfig),
  MultiSelect(DatabaseSelectFieldConfig),
  Tags(DatabaseTagsFieldConfig),
  Status(DatabaseStatusFieldConfig),
  User,
  Users(DatabaseUsersFieldConfig),
  DocumentLink,
  Relation(DatabaseRelationFieldConfig),
  Rollup(DatabaseRollupFieldConfig),
  Formula(DatabaseFormulaFieldConfig),
  Url,
  Email,
  Phone,
  CreatedTime,
  CreatedBy,
  UpdatedTime,
  UpdatedBy,
}

impl DatabaseFieldConfig {
  pub fn empty_for(field_type: DatabaseFieldType) -> Self {
    match field_type {
      DatabaseFieldType::Title => Self::Title,
      DatabaseFieldType::Text => Self::Text(Default::default()),
      DatabaseFieldType::RichText => Self::RichText(Default::default()),
      DatabaseFieldType::Number => Self::Number(Default::default()),
      DatabaseFieldType::Percent => Self::Percent(Default::default()),
      DatabaseFieldType::Currency => Self::Currency(Default::default()),
      DatabaseFieldType::Duration => Self::Duration(Default::default()),
      DatabaseFieldType::Checkbox => Self::Checkbox,
      DatabaseFieldType::Date => Self::Date(Default::default()),
      DatabaseFieldType::DateTime => Self::DateTime(Default::default()),
      DatabaseFieldType::Files => Self::Files(Default::default()),
      DatabaseFieldType::UniqueId => Self::UniqueId(Default::default()),
      DatabaseFieldType::Select => Self::Select(Default::default()),
      DatabaseFieldType::MultiSelect => Self::MultiSelect(Default::default()),
      DatabaseFieldType::Tags => Self::Tags(Default::default()),
      DatabaseFieldType::Status => Self::Status(default_database_status_field_config()),
      DatabaseFieldType::User => Self::User,
      DatabaseFieldType::Users => Self::Users(Default::default()),
      DatabaseFieldType::DocumentLink => Self::DocumentLink,
      DatabaseFieldType::Relation => Self::Relation(DatabaseRelationFieldConfig {
        target_database_id: DatabaseId::nil(),
        allow_multiple: true,
        reciprocal_field_id: None,
        max_targets: None,
      }),
      DatabaseFieldType::Rollup => Self::Rollup(DatabaseRollupFieldConfig {
        source_relation_field_id: DatabaseFieldId::nil(),
        target_field_id: DatabaseFieldId::nil(),
        aggregate: DatabaseRollupAggregate::Count,
        empty_value: None,
        stale_policy: DatabaseRollupStalePolicy::Async,
      }),
      DatabaseFieldType::Formula => Self::Formula(DatabaseFormulaFieldConfig {
        expression: String::new(),
        result_type: DatabaseFormulaResultType::Text,
        dependency_field_ids: Vec::new(),
        stale_policy: DatabaseFormulaStalePolicy::Async,
        format: None,
      }),
      DatabaseFieldType::Url => Self::Url,
      DatabaseFieldType::Email => Self::Email,
      DatabaseFieldType::Phone => Self::Phone,
      DatabaseFieldType::CreatedTime => Self::CreatedTime,
      DatabaseFieldType::CreatedBy => Self::CreatedBy,
      DatabaseFieldType::UpdatedTime => Self::UpdatedTime,
      DatabaseFieldType::UpdatedBy => Self::UpdatedBy,
    }
  }

  pub fn matches_field_type(&self, field_type: DatabaseFieldType) -> bool {
    matches!(
      (self, field_type),
      (Self::Title, DatabaseFieldType::Title)
        | (Self::Text(_), DatabaseFieldType::Text)
        | (Self::RichText(_), DatabaseFieldType::RichText)
        | (Self::Number(_), DatabaseFieldType::Number)
        | (Self::Percent(_), DatabaseFieldType::Percent)
        | (Self::Currency(_), DatabaseFieldType::Currency)
        | (Self::Duration(_), DatabaseFieldType::Duration)
        | (Self::Checkbox, DatabaseFieldType::Checkbox)
        | (Self::Date(_), DatabaseFieldType::Date)
        | (Self::DateTime(_), DatabaseFieldType::DateTime)
        | (Self::Files(_), DatabaseFieldType::Files)
        | (Self::UniqueId(_), DatabaseFieldType::UniqueId)
        | (Self::Select(_), DatabaseFieldType::Select)
        | (Self::MultiSelect(_), DatabaseFieldType::MultiSelect)
        | (Self::Tags(_), DatabaseFieldType::Tags)
        | (Self::Status(_), DatabaseFieldType::Status)
        | (Self::User, DatabaseFieldType::User)
        | (Self::Users(_), DatabaseFieldType::Users)
        | (Self::DocumentLink, DatabaseFieldType::DocumentLink)
        | (Self::Relation(_), DatabaseFieldType::Relation)
        | (Self::Rollup(_), DatabaseFieldType::Rollup)
        | (Self::Formula(_), DatabaseFieldType::Formula)
        | (Self::Url, DatabaseFieldType::Url)
        | (Self::Email, DatabaseFieldType::Email)
        | (Self::Phone, DatabaseFieldType::Phone)
        | (Self::CreatedTime, DatabaseFieldType::CreatedTime)
        | (Self::CreatedBy, DatabaseFieldType::CreatedBy)
        | (Self::UpdatedTime, DatabaseFieldType::UpdatedTime)
        | (Self::UpdatedBy, DatabaseFieldType::UpdatedBy)
    )
  }

  pub fn select_options(&self) -> &[DatabaseSelectOption] {
    match self {
      Self::Select(config) | Self::MultiSelect(config) => &config.options,
      _ => &[],
    }
  }

  pub fn status_options(&self) -> &[DatabaseStatusOption] {
    match self {
      Self::Status(config) => &config.options,
      _ => &[],
    }
  }
}

pub fn default_database_status_field_config() -> DatabaseStatusFieldConfig {
  DatabaseStatusFieldConfig {
    default_option_id: "status.todo".to_string(),
    options: vec![
      DatabaseStatusOption {
        id: "status.todo".to_string(),
        name: "Todo".to_string(),
        position: 0,
        color_role: "database.status.todo".to_string(),
        group: DatabaseStatusGroup::NotStarted,
      },
      DatabaseStatusOption {
        id: "status.in_progress".to_string(),
        name: "In progress".to_string(),
        position: 1,
        color_role: "database.status.inProgress".to_string(),
        group: DatabaseStatusGroup::Active,
      },
      DatabaseStatusOption {
        id: "status.done".to_string(),
        name: "Done".to_string(),
        position: 2,
        color_role: "database.status.done".to_string(),
        group: DatabaseStatusGroup::Complete,
      },
    ],
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Database {
  #[serde(default)]
  pub system_role: Option<DatabaseSystemRole>,
  #[serde(default)]
  pub managed_installation: Option<DatabaseManagedSchemaInstallation>,
  pub id: DatabaseId,
  pub workspace_id: WorkspaceId,
  #[serde(default)]
  pub profile_kind: DatabaseProfileKind,
  #[serde(default)]
  pub profile_structure_preset: Option<String>,
  #[serde(default)]
  pub profile_config: Value,
  pub title: String,
  pub description: Option<String>,
  pub created_by: Option<UserId>,
  pub updated_by: Option<UserId>,
  pub deleted_at: Option<DateTime<Utc>>,
  pub deleted_by: Option<UserId>,
  /// Monotonic optimistic-concurrency token for Database metadata edits.
  pub edit_revision: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseField {
  pub id: DatabaseFieldId,
  pub database_id: DatabaseId,
  pub name: String,
  pub field_type: DatabaseFieldType,
  pub config: DatabaseFieldConfig,
  pub position: i32,
  pub required: bool,
  /// Monotonic optimistic-concurrency token for this field.
  pub edit_revision: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Optimistic-concurrency precondition for one independently mutable entity.
///
/// `None` is reserved for trusted server-owned creation/import paths. Normal
/// interactive edits provide the revision captured when editing began. Force
/// bypasses only the revision predicate; the successful write still advances
/// the revision exactly once. Interactive edits also carry the workspace that
/// authorized the mutation so persistence can reject an ownership change that
/// commits between authorization and the write transaction.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DatabaseEditPrecondition {
  pub expected_edit_revision: Option<i64>,
  pub expected_workspace_id: Option<WorkspaceId>,
  /// Authoritative declared Database for batches whose first Row may be foreign.
  pub expected_database_id: Option<DatabaseId>,
  /// Optional creation intent: the selected View must retain this revision.
  pub creation_view: Option<(DatabaseViewId, i64)>,
  /// Exact mutable Row-template captured before Row/optional body preparation.
  /// Force never bypasses this creation-source fence.
  pub creation_template: Option<(Uuid, i64)>,
  pub automation_effect: Option<crate::workspace_automation::AutomationEffectFence>,
  pub force: bool,
}

impl DatabaseEditPrecondition {
  pub const fn new(expected_edit_revision: Option<i64>, force: bool) -> Self {
    Self {
      expected_edit_revision,
      expected_workspace_id: None,
      expected_database_id: None,
      creation_view: None,
      creation_template: None,
      automation_effect: None,
      force,
    }
  }

  /// Bind a declared batch owner independently of supplied Row IDs. This is
  /// an identity constraint; Force never bypasses it or workspace authorization.
  pub const fn in_database(mut self, database_id: DatabaseId) -> Self {
    self.expected_database_id = Some(database_id);
    self
  }

  pub const fn for_creation_view(mut self, view: Option<(DatabaseViewId, i64)>) -> Self {
    self.creation_view = view;
    self
  }

  pub const fn for_automation_effect(mut self, fence: crate::workspace_automation::AutomationEffectFence) -> Self {
    self.automation_effect = Some(fence);
    self
  }

  pub const fn for_creation_template(mut self, template: Option<(Uuid, i64)>) -> Self {
    self.creation_template = template;
    self
  }

  /// Bind an interactive mutation to the workspace used for authorization.
  ///
  /// This is an optimistic ownership precondition, not a transfer lock. A
  /// trusted server-owned import may omit it, while product mutations must
  /// bind it after resolving the Database from the authoritative repository.
  pub const fn in_workspace(mut self, workspace_id: WorkspaceId) -> Self {
    self.expected_workspace_id = Some(workspace_id);
    self
  }
}

pub fn default_database_currency_code() -> String {
  "EUR".to_string()
}

pub fn normalize_database_currency_code(value: &str) -> Option<String> {
  let code = value.trim().to_ascii_uppercase();
  is_valid_database_currency_code(&code).then_some(code)
}

/// Validates the active ISO-4217 money currency codes accepted by Databases.
///
/// This intentionally rejects arbitrary three-letter tokens such as `ZZZ`;
/// formatting and display still happen in clients using the stored code.
pub fn is_valid_database_currency_code(value: &str) -> bool {
  matches!(
    value,
    "AED"
      | "AFN"
      | "ALL"
      | "AMD"
      | "ANG"
      | "AOA"
      | "ARS"
      | "AUD"
      | "AWG"
      | "AZN"
      | "BAM"
      | "BBD"
      | "BDT"
      | "BGN"
      | "BHD"
      | "BIF"
      | "BMD"
      | "BND"
      | "BOB"
      | "BRL"
      | "BSD"
      | "BTN"
      | "BWP"
      | "BYN"
      | "BZD"
      | "CAD"
      | "CDF"
      | "CHF"
      | "CLP"
      | "CNY"
      | "COP"
      | "CRC"
      | "CUP"
      | "CVE"
      | "CZK"
      | "DJF"
      | "DKK"
      | "DOP"
      | "DZD"
      | "EGP"
      | "ERN"
      | "ETB"
      | "EUR"
      | "FJD"
      | "FKP"
      | "GBP"
      | "GEL"
      | "GHS"
      | "GIP"
      | "GMD"
      | "GNF"
      | "GTQ"
      | "GYD"
      | "HKD"
      | "HNL"
      | "HTG"
      | "HUF"
      | "IDR"
      | "ILS"
      | "INR"
      | "IQD"
      | "IRR"
      | "ISK"
      | "JMD"
      | "JOD"
      | "JPY"
      | "KES"
      | "KGS"
      | "KHR"
      | "KMF"
      | "KRW"
      | "KWD"
      | "KYD"
      | "KZT"
      | "LAK"
      | "LBP"
      | "LKR"
      | "LRD"
      | "LSL"
      | "LYD"
      | "MAD"
      | "MDL"
      | "MGA"
      | "MKD"
      | "MMK"
      | "MNT"
      | "MOP"
      | "MRU"
      | "MUR"
      | "MVR"
      | "MWK"
      | "MXN"
      | "MYR"
      | "MZN"
      | "NAD"
      | "NGN"
      | "NIO"
      | "NOK"
      | "NPR"
      | "NZD"
      | "OMR"
      | "PAB"
      | "PEN"
      | "PGK"
      | "PHP"
      | "PKR"
      | "PLN"
      | "PYG"
      | "QAR"
      | "RON"
      | "RSD"
      | "RUB"
      | "RWF"
      | "SAR"
      | "SBD"
      | "SCR"
      | "SDG"
      | "SEK"
      | "SGD"
      | "SHP"
      | "SLE"
      | "SOS"
      | "SRD"
      | "SSP"
      | "STN"
      | "SYP"
      | "SZL"
      | "THB"
      | "TJS"
      | "TMT"
      | "TND"
      | "TOP"
      | "TRY"
      | "TTD"
      | "TWD"
      | "TZS"
      | "UAH"
      | "UGX"
      | "USD"
      | "UYU"
      | "UZS"
      | "VES"
      | "VND"
      | "VUV"
      | "WST"
      | "XAF"
      | "XCD"
      | "XOF"
      | "XPF"
      | "YER"
      | "ZAR"
      | "ZMW"
      | "ZWL"
  )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFieldRole {
  pub database_id: DatabaseId,
  pub profile_kind: DatabaseProfileKind,
  pub role_key: String,
  pub row_kind_scope: Option<String>,
  pub field_id: DatabaseFieldId,
  pub required: bool,
  pub config: Value,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseRecord {
  #[serde(default)]
  pub managed_schema: Option<DatabaseManagedSchema>,
  pub database: Database,
  pub fields: Vec<DatabaseField>,
  pub views: Vec<DatabaseView>,
  #[serde(default)]
  pub field_roles: Vec<DatabaseFieldRole>,
  #[serde(default)]
  pub view_roles: Vec<DatabaseViewRole>,
  pub row_count: i64,
}
