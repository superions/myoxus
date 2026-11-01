// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;
mod managed;
pub use managed::*;

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseFieldKind", rename_items = "PascalCase")]
pub enum DatabaseFieldKindType {
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

impl From<domain::DatabaseFieldType> for DatabaseFieldKindType {
  fn from(value: domain::DatabaseFieldType) -> Self {
    match value {
      domain::DatabaseFieldType::Title => Self::Title,
      domain::DatabaseFieldType::Text => Self::Text,
      domain::DatabaseFieldType::RichText => Self::RichText,
      domain::DatabaseFieldType::Number => Self::Number,
      domain::DatabaseFieldType::Percent => Self::Percent,
      domain::DatabaseFieldType::Currency => Self::Currency,
      domain::DatabaseFieldType::Duration => Self::Duration,
      domain::DatabaseFieldType::Checkbox => Self::Checkbox,
      domain::DatabaseFieldType::Date => Self::Date,
      domain::DatabaseFieldType::DateTime => Self::DateTime,
      domain::DatabaseFieldType::Files => Self::Files,
      domain::DatabaseFieldType::UniqueId => Self::UniqueId,
      domain::DatabaseFieldType::Select => Self::Select,
      domain::DatabaseFieldType::MultiSelect => Self::MultiSelect,
      domain::DatabaseFieldType::Tags => Self::Tags,
      domain::DatabaseFieldType::Status => Self::Status,
      domain::DatabaseFieldType::User => Self::User,
      domain::DatabaseFieldType::Users => Self::Users,
      domain::DatabaseFieldType::DocumentLink => Self::DocumentLink,
      domain::DatabaseFieldType::Relation => Self::Relation,
      domain::DatabaseFieldType::Rollup => Self::Rollup,
      domain::DatabaseFieldType::Formula => Self::Formula,
      domain::DatabaseFieldType::Url => Self::Url,
      domain::DatabaseFieldType::Email => Self::Email,
      domain::DatabaseFieldType::Phone => Self::Phone,
      domain::DatabaseFieldType::CreatedTime => Self::CreatedTime,
      domain::DatabaseFieldType::CreatedBy => Self::CreatedBy,
      domain::DatabaseFieldType::UpdatedTime => Self::UpdatedTime,
      domain::DatabaseFieldType::UpdatedBy => Self::UpdatedBy,
    }
  }
}

impl From<DatabaseFieldKindType> for domain::DatabaseFieldType {
  fn from(value: DatabaseFieldKindType) -> Self {
    match value {
      DatabaseFieldKindType::Title => Self::Title,
      DatabaseFieldKindType::Text => Self::Text,
      DatabaseFieldKindType::RichText => Self::RichText,
      DatabaseFieldKindType::Number => Self::Number,
      DatabaseFieldKindType::Percent => Self::Percent,
      DatabaseFieldKindType::Currency => Self::Currency,
      DatabaseFieldKindType::Duration => Self::Duration,
      DatabaseFieldKindType::Checkbox => Self::Checkbox,
      DatabaseFieldKindType::Date => Self::Date,
      DatabaseFieldKindType::DateTime => Self::DateTime,
      DatabaseFieldKindType::Files => Self::Files,
      DatabaseFieldKindType::UniqueId => Self::UniqueId,
      DatabaseFieldKindType::Select => Self::Select,
      DatabaseFieldKindType::MultiSelect => Self::MultiSelect,
      DatabaseFieldKindType::Tags => Self::Tags,
      DatabaseFieldKindType::Status => Self::Status,
      DatabaseFieldKindType::User => Self::User,
      DatabaseFieldKindType::Users => Self::Users,
      DatabaseFieldKindType::DocumentLink => Self::DocumentLink,
      DatabaseFieldKindType::Relation => Self::Relation,
      DatabaseFieldKindType::Rollup => Self::Rollup,
      DatabaseFieldKindType::Formula => Self::Formula,
      DatabaseFieldKindType::Url => Self::Url,
      DatabaseFieldKindType::Email => Self::Email,
      DatabaseFieldKindType::Phone => Self::Phone,
      DatabaseFieldKindType::CreatedTime => Self::CreatedTime,
      DatabaseFieldKindType::CreatedBy => Self::CreatedBy,
      DatabaseFieldKindType::UpdatedTime => Self::UpdatedTime,
      DatabaseFieldKindType::UpdatedBy => Self::UpdatedBy,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseFormulaResultType", rename_items = "PascalCase")]
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

impl From<domain::DatabaseFormulaResultType> for DatabaseFormulaResultType {
  fn from(value: domain::DatabaseFormulaResultType) -> Self {
    match value {
      domain::DatabaseFormulaResultType::Text => Self::Text,
      domain::DatabaseFormulaResultType::Number => Self::Number,
      domain::DatabaseFormulaResultType::Percent => Self::Percent,
      domain::DatabaseFormulaResultType::Currency => Self::Currency,
      domain::DatabaseFormulaResultType::Duration => Self::Duration,
      domain::DatabaseFormulaResultType::Checkbox => Self::Checkbox,
      domain::DatabaseFormulaResultType::Date => Self::Date,
      domain::DatabaseFormulaResultType::DateTime => Self::DateTime,
      domain::DatabaseFormulaResultType::User => Self::User,
      domain::DatabaseFormulaResultType::Users => Self::Users,
    }
  }
}

impl From<DatabaseFormulaResultType> for domain::DatabaseFormulaResultType {
  fn from(value: DatabaseFormulaResultType) -> Self {
    match value {
      DatabaseFormulaResultType::Text => Self::Text,
      DatabaseFormulaResultType::Number => Self::Number,
      DatabaseFormulaResultType::Percent => Self::Percent,
      DatabaseFormulaResultType::Currency => Self::Currency,
      DatabaseFormulaResultType::Duration => Self::Duration,
      DatabaseFormulaResultType::Checkbox => Self::Checkbox,
      DatabaseFormulaResultType::Date => Self::Date,
      DatabaseFormulaResultType::DateTime => Self::DateTime,
      DatabaseFormulaResultType::User => Self::User,
      DatabaseFormulaResultType::Users => Self::Users,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseRollupAggregate", rename_items = "PascalCase")]
pub enum DatabaseRollupAggregateType {
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

impl From<domain::DatabaseRollupAggregate> for DatabaseRollupAggregateType {
  fn from(value: domain::DatabaseRollupAggregate) -> Self {
    match value {
      domain::DatabaseRollupAggregate::Count => Self::Count,
      domain::DatabaseRollupAggregate::CountValues => Self::CountValues,
      domain::DatabaseRollupAggregate::Sum => Self::Sum,
      domain::DatabaseRollupAggregate::Average => Self::Average,
      domain::DatabaseRollupAggregate::Min => Self::Min,
      domain::DatabaseRollupAggregate::Max => Self::Max,
      domain::DatabaseRollupAggregate::Earliest => Self::Earliest,
      domain::DatabaseRollupAggregate::Latest => Self::Latest,
      domain::DatabaseRollupAggregate::CheckedPercent => Self::CheckedPercent,
      domain::DatabaseRollupAggregate::UncheckedPercent => Self::UncheckedPercent,
      domain::DatabaseRollupAggregate::UniqueValues => Self::UniqueValues,
    }
  }
}

impl From<DatabaseRollupAggregateType> for domain::DatabaseRollupAggregate {
  fn from(value: DatabaseRollupAggregateType) -> Self {
    match value {
      DatabaseRollupAggregateType::Count => Self::Count,
      DatabaseRollupAggregateType::CountValues => Self::CountValues,
      DatabaseRollupAggregateType::Sum => Self::Sum,
      DatabaseRollupAggregateType::Average => Self::Average,
      DatabaseRollupAggregateType::Min => Self::Min,
      DatabaseRollupAggregateType::Max => Self::Max,
      DatabaseRollupAggregateType::Earliest => Self::Earliest,
      DatabaseRollupAggregateType::Latest => Self::Latest,
      DatabaseRollupAggregateType::CheckedPercent => Self::CheckedPercent,
      DatabaseRollupAggregateType::UncheckedPercent => Self::UncheckedPercent,
      DatabaseRollupAggregateType::UniqueValues => Self::UniqueValues,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseRollupStalePolicy", rename_items = "PascalCase")]
pub enum DatabaseRollupStalePolicyType {
  Async,
}

impl From<domain::DatabaseRollupStalePolicy> for DatabaseRollupStalePolicyType {
  fn from(value: domain::DatabaseRollupStalePolicy) -> Self {
    match value {
      domain::DatabaseRollupStalePolicy::Async => Self::Async,
    }
  }
}

impl From<DatabaseRollupStalePolicyType> for domain::DatabaseRollupStalePolicy {
  fn from(value: DatabaseRollupStalePolicyType) -> Self {
    match value {
      DatabaseRollupStalePolicyType::Async => Self::Async,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseFormulaStalePolicy", rename_items = "PascalCase")]
pub enum DatabaseFormulaStalePolicyType {
  Async,
}

impl From<domain::DatabaseFormulaStalePolicy> for DatabaseFormulaStalePolicyType {
  fn from(value: domain::DatabaseFormulaStalePolicy) -> Self {
    match value {
      domain::DatabaseFormulaStalePolicy::Async => Self::Async,
    }
  }
}

impl From<DatabaseFormulaStalePolicyType> for domain::DatabaseFormulaStalePolicy {
  fn from(value: DatabaseFormulaStalePolicyType) -> Self {
    match value {
      DatabaseFormulaStalePolicyType::Async => Self::Async,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseProfileKind", rename_items = "PascalCase")]
pub enum DatabaseProfileKindType {
  Generic,
  Project,
}

impl From<domain::DatabaseProfileKind> for DatabaseProfileKindType {
  fn from(value: domain::DatabaseProfileKind) -> Self {
    match value {
      domain::DatabaseProfileKind::Generic => Self::Generic,
      domain::DatabaseProfileKind::Project => Self::Project,
    }
  }
}

impl From<DatabaseProfileKindType> for domain::DatabaseProfileKind {
  fn from(value: DatabaseProfileKindType) -> Self {
    match value {
      DatabaseProfileKindType::Generic => Self::Generic,
      DatabaseProfileKindType::Project => Self::Project,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "InitialDatabaseViewKind", rename_items = "PascalCase")]
pub enum InitialDatabaseViewKindType {
  Table,
  Kanban,
}

impl From<InitialDatabaseViewKindType> for InitialDatabaseViewKind {
  fn from(value: InitialDatabaseViewKindType) -> Self {
    match value {
      InitialDatabaseViewKindType::Table => Self::Table,
      InitialDatabaseViewKindType::Kanban => Self::Kanban,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseStarterTemplateCategory", rename_items = "PascalCase")]
pub enum DatabaseStarterTemplateCategoryType {
  Database,
  Project,
}

impl From<DatabaseStarterTemplateCategory> for DatabaseStarterTemplateCategoryType {
  fn from(value: DatabaseStarterTemplateCategory) -> Self {
    match value {
      DatabaseStarterTemplateCategory::Database => Self::Database,
      DatabaseStarterTemplateCategory::Project => Self::Project,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseSelectOptionType")]
pub struct DatabaseSelectOptionObjectType {
  pub id: String,
  pub name: String,
  pub position: i32,
  pub color_role: String,
}

#[derive(InputObject, Clone)]
pub struct DatabaseSelectOptionInput {
  pub id: String,
  pub name: String,
  pub position: i32,
  pub color_role: String,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseStatusGroup", rename_items = "PascalCase")]
pub enum DatabaseStatusGroupType {
  NotStarted,
  Active,
  Complete,
  Archived,
}

impl From<domain::DatabaseStatusGroup> for DatabaseStatusGroupType {
  fn from(value: domain::DatabaseStatusGroup) -> Self {
    match value {
      domain::DatabaseStatusGroup::NotStarted => Self::NotStarted,
      domain::DatabaseStatusGroup::Active => Self::Active,
      domain::DatabaseStatusGroup::Complete => Self::Complete,
      domain::DatabaseStatusGroup::Archived => Self::Archived,
    }
  }
}

impl From<DatabaseStatusGroupType> for domain::DatabaseStatusGroup {
  fn from(value: DatabaseStatusGroupType) -> Self {
    match value {
      DatabaseStatusGroupType::NotStarted => Self::NotStarted,
      DatabaseStatusGroupType::Active => Self::Active,
      DatabaseStatusGroupType::Complete => Self::Complete,
      DatabaseStatusGroupType::Archived => Self::Archived,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseStatusOptionType")]
pub struct DatabaseStatusOptionObjectType {
  pub id: String,
  pub name: String,
  pub position: i32,
  pub color_role: String,
  pub group: DatabaseStatusGroupType,
}

#[derive(InputObject, Clone)]
pub struct DatabaseStatusOptionInput {
  pub id: String,
  pub name: String,
  pub position: i32,
  pub color_role: String,
  pub group: DatabaseStatusGroupType,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseTextFieldConfigType")]
pub struct DatabaseTextFieldConfigObjectType {
  pub multiline: bool,
}

#[derive(InputObject, Clone)]
pub struct DatabaseTextFieldConfigInput {
  pub multiline: Option<bool>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseNumberFieldConfigType")]
pub struct DatabaseNumberFieldConfigObjectType {
  pub format: Option<String>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseNumberFieldConfigInput {
  pub format: Option<String>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabasePercentFieldConfigType")]
pub struct DatabasePercentFieldConfigObjectType {
  pub min_value: Option<f64>,
  pub max_value: Option<f64>,
}

#[derive(InputObject, Clone)]
pub struct DatabasePercentFieldConfigInput {
  pub min_value: Option<f64>,
  pub max_value: Option<f64>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCurrencyFieldConfigType")]
pub struct DatabaseCurrencyFieldConfigObjectType {
  pub default_currency: String,
  pub allow_currency_override: bool,
  pub min_value: Option<f64>,
  pub max_value: Option<f64>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseCurrencyFieldConfigInput {
  pub default_currency: Option<String>,
  pub allow_currency_override: Option<bool>,
  pub min_value: Option<f64>,
  pub max_value: Option<f64>,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseDurationDisplayUnit", rename_items = "PascalCase")]
pub enum DatabaseDurationDisplayUnitType {
  Minutes,
  Hours,
  Days,
}

impl From<domain::DatabaseDurationDisplayUnit> for DatabaseDurationDisplayUnitType {
  fn from(value: domain::DatabaseDurationDisplayUnit) -> Self {
    match value {
      domain::DatabaseDurationDisplayUnit::Minutes => Self::Minutes,
      domain::DatabaseDurationDisplayUnit::Hours => Self::Hours,
      domain::DatabaseDurationDisplayUnit::Days => Self::Days,
    }
  }
}

impl From<DatabaseDurationDisplayUnitType> for domain::DatabaseDurationDisplayUnit {
  fn from(value: DatabaseDurationDisplayUnitType) -> Self {
    match value {
      DatabaseDurationDisplayUnitType::Minutes => Self::Minutes,
      DatabaseDurationDisplayUnitType::Hours => Self::Hours,
      DatabaseDurationDisplayUnitType::Days => Self::Days,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseDurationFieldConfigType")]
pub struct DatabaseDurationFieldConfigObjectType {
  pub display_unit: DatabaseDurationDisplayUnitType,
  pub min_minutes: Option<i64>,
  pub max_minutes: Option<i64>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseDurationFieldConfigInput {
  pub display_unit: Option<DatabaseDurationDisplayUnitType>,
  pub min_minutes: Option<i64>,
  pub max_minutes: Option<i64>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseUsersFieldConfigType")]
pub struct DatabaseUsersFieldConfigObjectType {
  pub min_count: Option<i32>,
  pub max_count: Option<i32>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseUsersFieldConfigInput {
  pub min_count: Option<i32>,
  pub max_count: Option<i32>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseDateFieldConfigType")]
pub struct DatabaseDateFieldConfigObjectType {
  pub include_time: bool,
}

#[derive(InputObject, Clone)]
pub struct DatabaseDateFieldConfigInput {
  pub include_time: Option<bool>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseDateTimeFieldConfigType")]
pub struct DatabaseDateTimeFieldConfigObjectType {
  pub default_time_zone: Option<String>,
  pub allow_reminders: bool,
}

#[derive(InputObject, Clone)]
pub struct DatabaseDateTimeFieldConfigInput {
  pub default_time_zone: Option<String>,
  pub allow_reminders: Option<bool>,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseFileMimeCategory", rename_items = "PascalCase")]
pub enum DatabaseFileMimeCategoryType {
  Any,
  Image,
  Video,
  Audio,
  Pdf,
  Document,
  Archive,
}

impl From<domain::DatabaseFileMimeCategory> for DatabaseFileMimeCategoryType {
  fn from(value: domain::DatabaseFileMimeCategory) -> Self {
    match value {
      domain::DatabaseFileMimeCategory::Any => Self::Any,
      domain::DatabaseFileMimeCategory::Image => Self::Image,
      domain::DatabaseFileMimeCategory::Video => Self::Video,
      domain::DatabaseFileMimeCategory::Audio => Self::Audio,
      domain::DatabaseFileMimeCategory::Pdf => Self::Pdf,
      domain::DatabaseFileMimeCategory::Document => Self::Document,
      domain::DatabaseFileMimeCategory::Archive => Self::Archive,
    }
  }
}

impl From<DatabaseFileMimeCategoryType> for domain::DatabaseFileMimeCategory {
  fn from(value: DatabaseFileMimeCategoryType) -> Self {
    match value {
      DatabaseFileMimeCategoryType::Any => Self::Any,
      DatabaseFileMimeCategoryType::Image => Self::Image,
      DatabaseFileMimeCategoryType::Video => Self::Video,
      DatabaseFileMimeCategoryType::Audio => Self::Audio,
      DatabaseFileMimeCategoryType::Pdf => Self::Pdf,
      DatabaseFileMimeCategoryType::Document => Self::Document,
      DatabaseFileMimeCategoryType::Archive => Self::Archive,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseFilesPreviewPolicy", rename_items = "PascalCase")]
pub enum DatabaseFilesPreviewPolicyType {
  Auto,
  Disabled,
}

impl From<domain::DatabaseFilesPreviewPolicy> for DatabaseFilesPreviewPolicyType {
  fn from(value: domain::DatabaseFilesPreviewPolicy) -> Self {
    match value {
      domain::DatabaseFilesPreviewPolicy::Auto => Self::Auto,
      domain::DatabaseFilesPreviewPolicy::Disabled => Self::Disabled,
    }
  }
}

impl From<DatabaseFilesPreviewPolicyType> for domain::DatabaseFilesPreviewPolicy {
  fn from(value: DatabaseFilesPreviewPolicyType) -> Self {
    match value {
      DatabaseFilesPreviewPolicyType::Auto => Self::Auto,
      DatabaseFilesPreviewPolicyType::Disabled => Self::Disabled,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseFilesFieldConfigType")]
pub struct DatabaseFilesFieldConfigObjectType {
  pub allowed_mime_categories: Vec<DatabaseFileMimeCategoryType>,
  pub max_item_count: Option<i32>,
  pub max_item_size: Option<i64>,
  pub preview_policy: DatabaseFilesPreviewPolicyType,
}

#[derive(InputObject, Clone)]
pub struct DatabaseFilesFieldConfigInput {
  pub allowed_mime_categories: Option<Vec<DatabaseFileMimeCategoryType>>,
  pub max_item_count: Option<i32>,
  pub max_item_size: Option<i64>,
  pub preview_policy: Option<DatabaseFilesPreviewPolicyType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseUniqueIdFieldConfigType")]
pub struct DatabaseUniqueIdFieldConfigObjectType {
  pub prefix: String,
  pub start_number: i64,
  pub padding: i32,
}

#[derive(InputObject, Clone)]
pub struct DatabaseUniqueIdFieldConfigInput {
  pub prefix: Option<String>,
  pub start_number: Option<i64>,
  pub padding: Option<i32>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseSelectFieldConfigType")]
pub struct DatabaseSelectFieldConfigObjectType {
  pub options: Vec<DatabaseSelectOptionObjectType>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseSelectFieldConfigInput {
  pub options: Vec<DatabaseSelectOptionInput>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseStatusFieldConfigType")]
pub struct DatabaseStatusFieldConfigObjectType {
  pub options: Vec<DatabaseStatusOptionObjectType>,
  pub default_option_id: String,
}

#[derive(InputObject, Clone)]
pub struct DatabaseStatusFieldConfigInput {
  pub options: Vec<DatabaseStatusOptionInput>,
  pub default_option_id: Option<String>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRelationFieldConfigType")]
pub struct DatabaseRelationFieldConfigObjectType {
  pub target_database_id: ID,
  pub allow_multiple: bool,
  pub reciprocal_field_id: Option<ID>,
  pub max_targets: Option<i32>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseRelationFieldConfigInput {
  pub target_database_id: ID,
  pub allow_multiple: Option<bool>,
  pub reciprocal_field_id: Option<ID>,
  pub max_targets: Option<i32>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRollupFieldConfigType")]
pub struct DatabaseRollupFieldConfigObjectType {
  pub source_relation_field_id: ID,
  pub target_field_id: ID,
  pub aggregate: DatabaseRollupAggregateType,
  pub empty_value: Option<DatabaseRollupScalarValueObjectType>,
  pub stale_policy: DatabaseRollupStalePolicyType,
}

#[derive(InputObject, Clone)]
pub struct DatabaseRollupFieldConfigInput {
  pub source_relation_field_id: ID,
  pub target_field_id: ID,
  pub aggregate: DatabaseRollupAggregateType,
  pub empty_value: Option<DatabaseRollupScalarValueInput>,
  pub stale_policy: Option<DatabaseRollupStalePolicyType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseFormulaFieldConfigType")]
pub struct DatabaseFormulaFieldConfigObjectType {
  pub expression: String,
  pub result_type: DatabaseFormulaResultType,
  pub dependency_field_ids: Vec<ID>,
  pub stale_policy: DatabaseFormulaStalePolicyType,
  pub format: Option<String>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseFormulaFieldConfigInput {
  pub expression: String,
  pub result_type: DatabaseFormulaResultType,
  pub dependency_field_ids: Option<Vec<ID>>,
  pub stale_policy: Option<DatabaseFormulaStalePolicyType>,
  pub format: Option<String>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRichTextFieldConfigType")]
pub struct DatabaseRichTextFieldConfigObjectType {
  pub max_plain_text_bytes: Option<i32>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseRichTextFieldConfigInput {
  pub max_plain_text_bytes: Option<i32>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseTagsFieldConfigType")]
pub struct DatabaseTagsFieldConfigObjectType {
  pub max_count: Option<i32>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseTagsFieldConfigInput {
  pub max_count: Option<i32>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseFieldConfigType")]
pub struct DatabaseFieldConfigObjectType {
  pub kind: DatabaseFieldKindType,
  pub text: Option<DatabaseTextFieldConfigObjectType>,
  pub rich_text: Option<DatabaseRichTextFieldConfigObjectType>,
  pub number: Option<DatabaseNumberFieldConfigObjectType>,
  pub percent: Option<DatabasePercentFieldConfigObjectType>,
  pub currency: Option<DatabaseCurrencyFieldConfigObjectType>,
  pub duration: Option<DatabaseDurationFieldConfigObjectType>,
  pub users: Option<DatabaseUsersFieldConfigObjectType>,
  pub date: Option<DatabaseDateFieldConfigObjectType>,
  pub date_time: Option<DatabaseDateTimeFieldConfigObjectType>,
  pub files: Option<DatabaseFilesFieldConfigObjectType>,
  pub unique_id: Option<DatabaseUniqueIdFieldConfigObjectType>,
  pub select: Option<DatabaseSelectFieldConfigObjectType>,
  pub multi_select: Option<DatabaseSelectFieldConfigObjectType>,
  pub tags: Option<DatabaseTagsFieldConfigObjectType>,
  pub status: Option<DatabaseStatusFieldConfigObjectType>,
  pub relation: Option<DatabaseRelationFieldConfigObjectType>,
  pub rollup: Option<DatabaseRollupFieldConfigObjectType>,
  pub formula: Option<DatabaseFormulaFieldConfigObjectType>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseFieldConfigInput {
  pub text: Option<DatabaseTextFieldConfigInput>,
  pub rich_text: Option<DatabaseRichTextFieldConfigInput>,
  pub number: Option<DatabaseNumberFieldConfigInput>,
  pub percent: Option<DatabasePercentFieldConfigInput>,
  pub currency: Option<DatabaseCurrencyFieldConfigInput>,
  pub duration: Option<DatabaseDurationFieldConfigInput>,
  pub users: Option<DatabaseUsersFieldConfigInput>,
  pub date: Option<DatabaseDateFieldConfigInput>,
  pub date_time: Option<DatabaseDateTimeFieldConfigInput>,
  pub files: Option<DatabaseFilesFieldConfigInput>,
  pub unique_id: Option<DatabaseUniqueIdFieldConfigInput>,
  pub select: Option<DatabaseSelectFieldConfigInput>,
  pub multi_select: Option<DatabaseSelectFieldConfigInput>,
  pub tags: Option<DatabaseTagsFieldConfigInput>,
  pub status: Option<DatabaseStatusFieldConfigInput>,
  pub relation: Option<DatabaseRelationFieldConfigInput>,
  pub rollup: Option<DatabaseRollupFieldConfigInput>,
  pub formula: Option<DatabaseFormulaFieldConfigInput>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseType")]
pub struct DatabaseObjectType {
  pub id: ID,
  pub workspace_id: ID,
  pub profile_kind: DatabaseProfileKindType,
  pub profile_structure_preset: Option<String>,
  pub profile_config: Json<JsonValue>,
  pub system_role: Option<DatabaseSystemRoleType>,
  pub title: String,
  pub description: Option<String>,
  pub created_by: Option<ID>,
  pub updated_by: Option<ID>,
  pub deleted_at: Option<DateTime<Utc>>,
  pub deleted_by: Option<ID>,
  pub edit_revision: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseFieldRole")]
pub struct DatabaseFieldRoleObjectType {
  pub database_id: ID,
  pub profile_kind: DatabaseProfileKindType,
  pub role_key: String,
  pub row_kind_scope: Option<String>,
  pub field_id: ID,
  pub required: bool,
  pub config: Json<JsonValue>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseViewRole")]
pub struct DatabaseViewRoleObjectType {
  pub database_id: ID,
  pub profile_kind: DatabaseProfileKindType,
  pub role_key: String,
  pub view_id: ID,
  pub required: bool,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseFieldType")]
pub struct DatabaseFieldObjectType {
  pub id: ID,
  pub database_id: ID,
  pub name: String,
  pub field_type: DatabaseFieldKindType,
  pub config: DatabaseFieldConfigObjectType,
  pub position: i32,
  pub required: bool,
  pub edit_revision: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRecord")]
pub struct DatabaseRecordObjectType {
  /// Creation-only navigation hint, selected by the confirmed native plan.
  pub initial_view_id: Option<ID>,
  pub database: DatabaseObjectType,
  pub fields: Vec<DatabaseFieldObjectType>,
  pub views: Vec<DatabaseViewObjectType>,
  pub field_roles: Vec<DatabaseFieldRoleObjectType>,
  pub view_roles: Vec<DatabaseViewRoleObjectType>,
  pub row_count: i64,
  pub managed_schema: Option<DatabaseManagedSchemaObjectType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseStarterTemplate")]
pub struct DatabaseStarterTemplateObjectType {
  pub id: String,
  pub version: String,
  pub digest: String,
  pub default_variant: DatabaseTemplateSelectionObjectType,
  pub selections: Vec<DatabaseTemplateVariantSelectionObjectType>,
  pub name: String,
  pub name_key: String,
  pub description: String,
  pub description_key: String,
  pub category: DatabaseStarterTemplateCategoryType,
  pub profile_kind: DatabaseProfileKindType,
  pub default_view_kinds: Vec<DatabaseViewKindType>,
  pub sample_row_count: i32,
  pub import_mappings: Vec<DatabaseStarterTemplateImportMappingObjectType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseTemplateSelection")]
pub struct DatabaseTemplateSelectionObjectType {
  pub priority: ProjectOptionPresetType,
  pub complexity: ProjectOptionPresetType,
  pub structure: ProjectStructurePresetType,
}
impl From<domain::DatabaseTemplateSelection> for DatabaseTemplateSelectionObjectType {
  fn from(v: domain::DatabaseTemplateSelection) -> Self {
    Self {
      priority: v.priority.into(),
      complexity: v.complexity.into(),
      structure: v.structure.into(),
    }
  }
}
#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseTemplateVariantSelection")]
pub struct DatabaseTemplateVariantSelectionObjectType {
  pub input: DatabaseTemplateSelectionObjectType,
  pub variant: DatabaseTemplateSelectionObjectType,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseStarterTemplateImportMapping")]
pub struct DatabaseStarterTemplateImportMappingObjectType {
  pub key: String,
  pub name_key: String,
  pub column_mappings: Vec<DatabaseStarterTemplateImportColumnObjectType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseStarterTemplateImportColumn")]
pub struct DatabaseStarterTemplateImportColumnObjectType {
  pub source_header: String,
  pub field_key: String,
  pub required: bool,
}

#[derive(InputObject)]
pub struct CreateDatabaseInput {
  pub workspace_id: ID,
  pub title: String,
  pub description: Option<String>,
  pub initial_view_kind: Option<InitialDatabaseViewKindType>,
}

#[derive(InputObject)]
pub struct CreateDatabaseFromTemplateInput {
  pub assistant_confirmation: Option<ProjectAssistantConfirmationInput>,
  pub workspace_id: ID,
  pub template_id: String,
  pub title: String,
  pub description: Option<String>,
  pub include_sample_rows: Option<bool>,
  pub priority_preset: Option<ProjectOptionPresetType>,
  pub complexity_preset: Option<ProjectOptionPresetType>,
  pub structure_preset: Option<ProjectStructurePresetType>,
}

#[derive(InputObject)]
pub struct UpdateDatabaseInput {
  pub database_id: ID,
  pub title: Option<String>,
  pub description: MaybeUndefined<Option<String>>,
  pub expected_edit_revision: Option<i64>,
  pub force: Option<bool>,
}

#[derive(InputObject)]
pub struct DatabaseLifecycleInput {
  pub database_id: ID,
  pub expected_edit_revision: Option<i64>,
  pub force: Option<bool>,
}

#[derive(InputObject)]
pub struct CreateDatabaseFieldInput {
  pub database_id: ID,
  pub name: String,
  pub field_type: DatabaseFieldKindType,
  pub config: Option<DatabaseFieldConfigInput>,
  pub required: Option<bool>,
}

#[derive(InputObject)]
pub struct UpdateDatabaseFieldInput {
  pub database_id: ID,
  pub field_id: ID,
  pub name: Option<String>,
  pub config: Option<DatabaseFieldConfigInput>,
  pub required: Option<bool>,
  pub expected_edit_revision: Option<i64>,
  pub force: Option<bool>,
}

#[derive(InputObject)]
pub struct DeleteDatabaseFieldInput {
  pub database_id: ID,
  pub field_id: ID,
  pub expected_edit_revision: Option<i64>,
  pub force: Option<bool>,
}

#[derive(InputObject)]
pub struct DatabaseFieldEditRevisionInput {
  pub field_id: ID,
  pub expected_edit_revision: i64,
}

#[derive(InputObject)]
pub struct ReorderDatabaseFieldsInput {
  pub database_id: ID,
  pub field_ids: Vec<ID>,
  pub expected_edit_revisions: Option<Vec<DatabaseFieldEditRevisionInput>>,
  pub force: Option<bool>,
}

fn parse_field_config(
  field_type: domain::DatabaseFieldType,
  config: Option<DatabaseFieldConfigInput>,
) -> Result<domain::DatabaseFieldConfig> {
  match config {
    Some(value) => parse_field_config_without_kind(value),
    None => Ok(domain::DatabaseFieldConfig::empty_for(field_type)),
  }
}

fn parse_field_config_without_kind(value: DatabaseFieldConfigInput) -> Result<domain::DatabaseFieldConfig> {
  let set_count = [
    value.text.is_some(),
    value.rich_text.is_some(),
    value.number.is_some(),
    value.percent.is_some(),
    value.currency.is_some(),
    value.duration.is_some(),
    value.users.is_some(),
    value.date.is_some(),
    value.date_time.is_some(),
    value.files.is_some(),
    value.unique_id.is_some(),
    value.select.is_some(),
    value.multi_select.is_some(),
    value.tags.is_some(),
    value.status.is_some(),
    value.relation.is_some(),
    value.rollup.is_some(),
    value.formula.is_some(),
  ]
  .into_iter()
  .filter(|set| *set)
  .count();
  if set_count != 1 {
    return Err(database_error(
      "MIX_DATABASE_FIELD_INVALID",
      "field config input must set exactly one config object",
    ));
  }
  if let Some(config) = value.text {
    return Ok(domain::DatabaseFieldConfig::Text(domain::DatabaseTextFieldConfig {
      multiline: config.multiline.unwrap_or(false),
    }));
  }
  if let Some(config) = value.rich_text {
    return Ok(domain::DatabaseFieldConfig::RichText(
      domain::DatabaseRichTextFieldConfig {
        max_plain_text_bytes: config.max_plain_text_bytes.map(|value| value.max(0) as usize),
      },
    ));
  }
  if let Some(config) = value.number {
    return Ok(domain::DatabaseFieldConfig::Number(domain::DatabaseNumberFieldConfig {
      format: config.format.and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
      }),
    }));
  }
  if let Some(config) = value.percent {
    return Ok(domain::DatabaseFieldConfig::Percent(
      domain::DatabasePercentFieldConfig {
        min_value: config.min_value,
        max_value: config.max_value,
      },
    ));
  }
  if let Some(config) = value.currency {
    let default_currency = match config.default_currency {
      Some(value) => domain::normalize_database_currency_code(&value).ok_or_else(|| {
        database_error(
          "MIX_DATABASE_CURRENCY_INVALID",
          "currency field default must be a valid ISO-4217 currency code",
        )
      })?,
      None => domain::default_database_currency_code(),
    };
    return Ok(domain::DatabaseFieldConfig::Currency(
      domain::DatabaseCurrencyFieldConfig {
        default_currency,
        allow_currency_override: config.allow_currency_override.unwrap_or(false),
        min_value: config.min_value,
        max_value: config.max_value,
      },
    ));
  }
  if let Some(config) = value.duration {
    return Ok(domain::DatabaseFieldConfig::Duration(
      domain::DatabaseDurationFieldConfig {
        display_unit: config.display_unit.map(Into::into).unwrap_or_default(),
        min_minutes: config.min_minutes,
        max_minutes: config.max_minutes,
      },
    ));
  }
  if let Some(config) = value.users {
    return Ok(domain::DatabaseFieldConfig::Users(domain::DatabaseUsersFieldConfig {
      min_count: config.min_count,
      max_count: config.max_count,
    }));
  }
  if let Some(config) = value.date {
    return Ok(domain::DatabaseFieldConfig::Date(domain::DatabaseDateFieldConfig {
      include_time: config.include_time.unwrap_or(false),
    }));
  }
  if let Some(config) = value.date_time {
    return Ok(domain::DatabaseFieldConfig::DateTime(
      domain::DatabaseDateTimeFieldConfig {
        default_time_zone: config.default_time_zone,
        allow_reminders: config.allow_reminders.unwrap_or(false),
      },
    ));
  }
  if let Some(config) = value.files {
    return Ok(domain::DatabaseFieldConfig::Files(domain::DatabaseFilesFieldConfig {
      allowed_mime_categories: config
        .allowed_mime_categories
        .unwrap_or_else(|| vec![DatabaseFileMimeCategoryType::Any])
        .into_iter()
        .map(Into::into)
        .collect(),
      max_item_count: config.max_item_count,
      max_item_size: config.max_item_size,
      preview_policy: config
        .preview_policy
        .unwrap_or(DatabaseFilesPreviewPolicyType::Auto)
        .into(),
    }));
  }
  if let Some(config) = value.unique_id {
    let defaults = domain::DatabaseUniqueIdFieldConfig::default();
    return Ok(domain::DatabaseFieldConfig::UniqueId(
      domain::DatabaseUniqueIdFieldConfig {
        prefix: config.prefix.unwrap_or(defaults.prefix),
        start_number: config.start_number.unwrap_or(defaults.start_number),
        padding: config.padding.unwrap_or(defaults.padding),
      },
    ));
  }
  if let Some(config) = value.select {
    return Ok(domain::DatabaseFieldConfig::Select(domain::DatabaseSelectFieldConfig {
      options: config.options.into_iter().map(map_select_option_input).collect(),
    }));
  }
  if let Some(config) = value.multi_select {
    return Ok(domain::DatabaseFieldConfig::MultiSelect(
      domain::DatabaseSelectFieldConfig {
        options: config.options.into_iter().map(map_select_option_input).collect(),
      },
    ));
  }
  if let Some(config) = value.tags {
    return Ok(domain::DatabaseFieldConfig::Tags(domain::DatabaseTagsFieldConfig {
      max_count: config.max_count,
    }));
  }
  if let Some(config) = value.status {
    let default_config = domain::default_database_status_field_config();
    return Ok(domain::DatabaseFieldConfig::Status(domain::DatabaseStatusFieldConfig {
      default_option_id: config.default_option_id.unwrap_or(default_config.default_option_id),
      options: config.options.into_iter().map(map_status_option_input).collect(),
    }));
  }
  if let Some(config) = value.relation {
    return Ok(domain::DatabaseFieldConfig::Relation(
      domain::DatabaseRelationFieldConfig {
        target_database_id: parse_uuid_id(&config.target_database_id, "targetDatabaseId")?,
        allow_multiple: config.allow_multiple.unwrap_or(true),
        reciprocal_field_id: config
          .reciprocal_field_id
          .map(|id| parse_uuid_id(&id, "reciprocalFieldId"))
          .transpose()?,
        max_targets: config.max_targets,
      },
    ));
  }
  if let Some(config) = value.rollup {
    return Ok(domain::DatabaseFieldConfig::Rollup(domain::DatabaseRollupFieldConfig {
      source_relation_field_id: parse_uuid_id(&config.source_relation_field_id, "sourceRelationFieldId")?,
      target_field_id: parse_uuid_id(&config.target_field_id, "targetFieldId")?,
      aggregate: config.aggregate.into(),
      empty_value: config.empty_value.map(parse_rollup_scalar_value).transpose()?,
      stale_policy: config
        .stale_policy
        .unwrap_or(DatabaseRollupStalePolicyType::Async)
        .into(),
    }));
  }
  if let Some(config) = value.formula {
    return Ok(domain::DatabaseFieldConfig::Formula(
      domain::DatabaseFormulaFieldConfig {
        expression: config.expression,
        result_type: config.result_type.into(),
        dependency_field_ids: config
          .dependency_field_ids
          .unwrap_or_default()
          .iter()
          .map(|id| parse_uuid_id(id, "dependencyFieldIds"))
          .collect::<Result<Vec<_>>>()?,
        stale_policy: config
          .stale_policy
          .unwrap_or(DatabaseFormulaStalePolicyType::Async)
          .into(),
        format: config.format.and_then(|value| {
          let trimmed = value.trim().to_string();
          (!trimmed.is_empty()).then_some(trimmed)
        }),
      },
    ));
  }
  unreachable!("set_count enforces one field config input")
}

fn map_select_option_input(input: DatabaseSelectOptionInput) -> domain::DatabaseSelectOption {
  domain::DatabaseSelectOption {
    id: input.id,
    name: input.name,
    position: input.position,
    color_role: input.color_role,
  }
}

pub(super) fn map_record(record: domain::DatabaseRecord) -> DatabaseRecordObjectType {
  DatabaseRecordObjectType {
    initial_view_id: None,
    database: map_database(record.database),
    fields: record.fields.into_iter().map(map_field).collect(),
    views: record.views.into_iter().map(map_view).collect(),
    field_roles: record.field_roles.into_iter().map(map_field_role).collect(),
    view_roles: record.view_roles.into_iter().map(map_view_role).collect(),
    row_count: record.row_count,
    managed_schema: record.managed_schema.map(map_managed_schema),
  }
}

fn map_starter_template(
  template: myoxus_application::database::definition::templates::DatabaseStarterTemplateSummary,
) -> DatabaseStarterTemplateObjectType {
  DatabaseStarterTemplateObjectType {
    id: template.id,
    version: template.version,
    digest: template.digest,
    default_variant: template.default_variant.into(),
    selections: template
      .selections
      .into_iter()
      .map(|v| DatabaseTemplateVariantSelectionObjectType {
        input: v.input.into(),
        variant: v.variant.into(),
      })
      .collect(),
    name: template.name,
    name_key: template.name_key,
    description: template.description,
    description_key: template.description_key,
    category: template.category.into(),
    profile_kind: template.profile_kind.into(),
    default_view_kinds: template.default_view_kinds.into_iter().map(Into::into).collect(),
    sample_row_count: template.sample_row_count.try_into().unwrap_or(i32::MAX),
    import_mappings: template
      .import_mappings
      .into_iter()
      .map(map_starter_import_mapping)
      .collect(),
  }
}

fn map_starter_import_mapping(
  mapping: domain::DatabaseStarterTemplateImportMappingManifest,
) -> DatabaseStarterTemplateImportMappingObjectType {
  DatabaseStarterTemplateImportMappingObjectType {
    key: mapping.key,
    name_key: mapping.name_key,
    column_mappings: mapping
      .column_mappings
      .into_iter()
      .map(|column| DatabaseStarterTemplateImportColumnObjectType {
        source_header: column.source_header,
        field_key: column.field_key,
        required: column.required,
      })
      .collect(),
  }
}

fn map_database(database: domain::Database) -> DatabaseObjectType {
  DatabaseObjectType {
    id: ID::from(database.id.to_string()),
    workspace_id: ID::from(database.workspace_id.to_string()),
    profile_kind: database.profile_kind.into(),
    profile_structure_preset: database.profile_structure_preset,
    profile_config: Json(database.profile_config),
    system_role: database.system_role.map(Into::into),
    title: database.title,
    description: database.description,
    created_by: database.created_by.map(|id| ID::from(id.to_string())),
    updated_by: database.updated_by.map(|id| ID::from(id.to_string())),
    deleted_at: database.deleted_at,
    deleted_by: database.deleted_by.map(|id| ID::from(id.to_string())),
    edit_revision: database.edit_revision,
    created_at: database.created_at,
    updated_at: database.updated_at,
  }
}

fn map_field_role(role: domain::DatabaseFieldRole) -> DatabaseFieldRoleObjectType {
  DatabaseFieldRoleObjectType {
    database_id: ID::from(role.database_id.to_string()),
    profile_kind: role.profile_kind.into(),
    role_key: role.role_key,
    row_kind_scope: role.row_kind_scope,
    field_id: ID::from(role.field_id.to_string()),
    required: role.required,
    config: Json(role.config),
    created_at: role.created_at,
    updated_at: role.updated_at,
  }
}

fn map_view_role(role: domain::DatabaseViewRole) -> DatabaseViewRoleObjectType {
  DatabaseViewRoleObjectType {
    database_id: ID::from(role.database_id.to_string()),
    profile_kind: role.profile_kind.into(),
    role_key: role.role_key,
    view_id: ID::from(role.view_id.to_string()),
    required: role.required,
    created_at: role.created_at,
    updated_at: role.updated_at,
  }
}

pub(super) fn map_field(field: domain::DatabaseField) -> DatabaseFieldObjectType {
  DatabaseFieldObjectType {
    id: ID::from(field.id.to_string()),
    database_id: ID::from(field.database_id.to_string()),
    name: field.name,
    field_type: field.field_type.into(),
    config: map_field_config(field.config),
    position: field.position,
    required: field.required,
    edit_revision: field.edit_revision,
    created_at: field.created_at,
    updated_at: field.updated_at,
  }
}

pub(super) fn map_select_option(option: domain::DatabaseSelectOption) -> DatabaseSelectOptionObjectType {
  DatabaseSelectOptionObjectType {
    id: option.id,
    name: option.name,
    position: option.position,
    color_role: option.color_role,
  }
}

fn map_status_option_input(input: DatabaseStatusOptionInput) -> domain::DatabaseStatusOption {
  domain::DatabaseStatusOption {
    id: input.id,
    name: input.name,
    position: input.position,
    color_role: input.color_role,
    group: input.group.into(),
  }
}

pub(super) fn map_status_option(option: domain::DatabaseStatusOption) -> DatabaseStatusOptionObjectType {
  DatabaseStatusOptionObjectType {
    id: option.id,
    name: option.name,
    position: option.position,
    color_role: option.color_role,
    group: option.group.into(),
  }
}

fn empty_field_config_object(kind: DatabaseFieldKindType) -> DatabaseFieldConfigObjectType {
  DatabaseFieldConfigObjectType {
    kind,
    text: None,
    rich_text: None,
    number: None,
    percent: None,
    currency: None,
    duration: None,
    users: None,
    date: None,
    date_time: None,
    files: None,
    unique_id: None,
    select: None,
    multi_select: None,
    tags: None,
    status: None,
    relation: None,
    rollup: None,
    formula: None,
  }
}

pub(super) fn map_field_config(config: domain::DatabaseFieldConfig) -> DatabaseFieldConfigObjectType {
  match config {
    domain::DatabaseFieldConfig::Title => empty_field_config_object(DatabaseFieldKindType::Title),
    domain::DatabaseFieldConfig::Text(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Text);
      mapped.text = Some(DatabaseTextFieldConfigObjectType {
        multiline: config.multiline,
      });
      mapped
    }
    domain::DatabaseFieldConfig::RichText(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::RichText);
      mapped.rich_text = Some(DatabaseRichTextFieldConfigObjectType {
        max_plain_text_bytes: config.max_plain_text_bytes.map(|value| value as i32),
      });
      mapped
    }
    domain::DatabaseFieldConfig::Number(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Number);
      mapped.number = Some(DatabaseNumberFieldConfigObjectType { format: config.format });
      mapped
    }
    domain::DatabaseFieldConfig::Percent(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Percent);
      mapped.percent = Some(DatabasePercentFieldConfigObjectType {
        min_value: config.min_value,
        max_value: config.max_value,
      });
      mapped
    }
    domain::DatabaseFieldConfig::Currency(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Currency);
      mapped.currency = Some(DatabaseCurrencyFieldConfigObjectType {
        default_currency: config.default_currency,
        allow_currency_override: config.allow_currency_override,
        min_value: config.min_value,
        max_value: config.max_value,
      });
      mapped
    }
    domain::DatabaseFieldConfig::Duration(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Duration);
      mapped.duration = Some(DatabaseDurationFieldConfigObjectType {
        display_unit: config.display_unit.into(),
        min_minutes: config.min_minutes,
        max_minutes: config.max_minutes,
      });
      mapped
    }
    domain::DatabaseFieldConfig::Checkbox => empty_field_config_object(DatabaseFieldKindType::Checkbox),
    domain::DatabaseFieldConfig::Date(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Date);
      mapped.date = Some(DatabaseDateFieldConfigObjectType {
        include_time: config.include_time,
      });
      mapped
    }
    domain::DatabaseFieldConfig::DateTime(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::DateTime);
      mapped.date_time = Some(DatabaseDateTimeFieldConfigObjectType {
        default_time_zone: config.default_time_zone,
        allow_reminders: config.allow_reminders,
      });
      mapped
    }
    domain::DatabaseFieldConfig::Files(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Files);
      mapped.files = Some(DatabaseFilesFieldConfigObjectType {
        allowed_mime_categories: config.allowed_mime_categories.into_iter().map(Into::into).collect(),
        max_item_count: config.max_item_count,
        max_item_size: config.max_item_size,
        preview_policy: config.preview_policy.into(),
      });
      mapped
    }
    domain::DatabaseFieldConfig::UniqueId(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::UniqueId);
      mapped.unique_id = Some(DatabaseUniqueIdFieldConfigObjectType {
        prefix: config.prefix,
        start_number: config.start_number,
        padding: config.padding,
      });
      mapped
    }
    domain::DatabaseFieldConfig::Select(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Select);
      mapped.select = Some(DatabaseSelectFieldConfigObjectType {
        options: config.options.into_iter().map(map_select_option).collect(),
      });
      mapped
    }
    domain::DatabaseFieldConfig::MultiSelect(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::MultiSelect);
      mapped.multi_select = Some(DatabaseSelectFieldConfigObjectType {
        options: config.options.into_iter().map(map_select_option).collect(),
      });
      mapped
    }
    domain::DatabaseFieldConfig::Tags(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Tags);
      mapped.tags = Some(DatabaseTagsFieldConfigObjectType {
        max_count: config.max_count,
      });
      mapped
    }
    domain::DatabaseFieldConfig::Status(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Status);
      mapped.status = Some(DatabaseStatusFieldConfigObjectType {
        options: config.options.into_iter().map(map_status_option).collect(),
        default_option_id: config.default_option_id,
      });
      mapped
    }
    domain::DatabaseFieldConfig::User => empty_field_config_object(DatabaseFieldKindType::User),
    domain::DatabaseFieldConfig::Users(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Users);
      mapped.users = Some(DatabaseUsersFieldConfigObjectType {
        min_count: config.min_count,
        max_count: config.max_count,
      });
      mapped
    }
    domain::DatabaseFieldConfig::Relation(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Relation);
      mapped.relation = Some(DatabaseRelationFieldConfigObjectType {
        target_database_id: ID::from(config.target_database_id.to_string()),
        allow_multiple: config.allow_multiple,
        reciprocal_field_id: config.reciprocal_field_id.map(|id| ID::from(id.to_string())),
        max_targets: config.max_targets,
      });
      mapped
    }
    domain::DatabaseFieldConfig::Rollup(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Rollup);
      mapped.rollup = Some(DatabaseRollupFieldConfigObjectType {
        source_relation_field_id: ID::from(config.source_relation_field_id.to_string()),
        target_field_id: ID::from(config.target_field_id.to_string()),
        aggregate: config.aggregate.into(),
        empty_value: config.empty_value.map(map_rollup_scalar_value),
        stale_policy: config.stale_policy.into(),
      });
      mapped
    }
    domain::DatabaseFieldConfig::Formula(config) => {
      let mut mapped = empty_field_config_object(DatabaseFieldKindType::Formula);
      mapped.formula = Some(DatabaseFormulaFieldConfigObjectType {
        expression: config.expression,
        result_type: config.result_type.into(),
        dependency_field_ids: config
          .dependency_field_ids
          .into_iter()
          .map(|id| ID::from(id.to_string()))
          .collect(),
        stale_policy: config.stale_policy.into(),
        format: config.format,
      });
      mapped
    }
    domain::DatabaseFieldConfig::Url => empty_field_config_object(DatabaseFieldKindType::Url),
    domain::DatabaseFieldConfig::Email => empty_field_config_object(DatabaseFieldKindType::Email),
    domain::DatabaseFieldConfig::Phone => empty_field_config_object(DatabaseFieldKindType::Phone),
    domain::DatabaseFieldConfig::DocumentLink => empty_field_config_object(DatabaseFieldKindType::DocumentLink),
    domain::DatabaseFieldConfig::CreatedTime => empty_field_config_object(DatabaseFieldKindType::CreatedTime),
    domain::DatabaseFieldConfig::CreatedBy => empty_field_config_object(DatabaseFieldKindType::CreatedBy),
    domain::DatabaseFieldConfig::UpdatedTime => empty_field_config_object(DatabaseFieldKindType::UpdatedTime),
    domain::DatabaseFieldConfig::UpdatedBy => empty_field_config_object(DatabaseFieldKindType::UpdatedBy),
  }
}

pub(crate) async fn list_database_starter_templates(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
) -> Result<Vec<DatabaseStarterTemplateObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  service(&state)?
    .views
    .assert_workspace_read(snapshot.user.id, workspace_id)
    .await
    .map_err(map_database_error)?;
  Ok(
    service(&state)?
      .definition
      .list_starter_templates()
      .into_iter()
      .map(map_starter_template)
      .collect(),
  )
}

pub(crate) async fn get_database(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
) -> Result<Option<DatabaseRecordObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&database_id, "databaseId")?;
  match service(&state)?
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
  {
    Ok(record) if record.database.workspace_id == workspace_id => Ok(Some(map_record(record))),
    Ok(_) => Ok(None),
    Err(error) if error.code == myoxus_application::database::ERR_NOT_FOUND => Ok(None),
    Err(error) => Err(map_database_error(error)),
  }
}

pub(crate) async fn create_database(ctx: &Context<'_>, input: CreateDatabaseInput) -> Result<DatabaseRecordObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let record = service(&state)?
    .definition
    .create_database(
      snapshot.user.id,
      workspace_id,
      input.title,
      input.description,
      input
        .initial_view_kind
        .unwrap_or(InitialDatabaseViewKindType::Table)
        .into(),
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_record(record))
}

pub(crate) async fn create_database_from_template(
  ctx: &Context<'_>,
  mut input: CreateDatabaseFromTemplateInput,
) -> Result<DatabaseRecordObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  if let Some(confirmation) = input.assistant_confirmation.take() {
    return apply_project_confirmation(&state, snapshot.user.id, workspace_id, confirmation, &input).await;
  }
  let default_currency = state.config.i18n.default_currency.clone();
  let services = service(&state)?;
  // Resolve file defaults only after the native creation admission. The write
  // owner reauthorizes again; catalog lookup must not replace ACL/title errors.
  services
    .definition
    .validate_database_creation(snapshot.user.id, workspace_id, &input.title)
    .await
    .map_err(map_database_error)?;
  let defaults = services
    .definition
    .starter_template_catalog()
    .default_selection(&input.template_id)
    .copied()
    .ok_or_else(|| {
      Error::new("database starter template not found")
        .extend_with(|_, e| e.set("code", myoxus_application::database::ERR_NOT_FOUND))
    })?;
  let record = service(&state)?
    .definition
    .create_database_from_template(
      snapshot.user.id,
      CreateDatabaseFromTemplate {
        workspace_id,
        template_id: input.template_id,
        title: input.title,
        description: input.description,
        include_sample_rows: input.include_sample_rows.unwrap_or(false),
        priority_preset: input.priority_preset.map(Into::into).unwrap_or(defaults.priority),
        complexity_preset: input.complexity_preset.map(Into::into).unwrap_or(defaults.complexity),
        structure_preset: input.structure_preset.map(Into::into).unwrap_or(defaults.structure),
        default_currency,
      },
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_record(record))
}

pub(crate) async fn update_database(ctx: &Context<'_>, input: UpdateDatabaseInput) -> Result<DatabaseRecordObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let description = match input.description {
    MaybeUndefined::Undefined => None,
    MaybeUndefined::Null => Some(None),
    MaybeUndefined::Value(value) => Some(value),
  };
  let record = service(&state)?
    .definition
    .update_database_with_precondition(
      snapshot.user.id,
      database_id,
      input.title,
      description,
      input.expected_edit_revision,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_record(record))
}

pub(crate) async fn trash_database(
  ctx: &Context<'_>,
  input: DatabaseLifecycleInput,
) -> Result<DatabaseRecordObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let record = service(&state)?
    .definition
    .trash_database_with_precondition(
      snapshot.user.id,
      database_id,
      input.expected_edit_revision,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_record(record))
}

pub(crate) async fn restore_database(
  ctx: &Context<'_>,
  input: DatabaseLifecycleInput,
) -> Result<DatabaseRecordObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let record = service(&state)?
    .definition
    .restore_database_with_precondition(
      snapshot.user.id,
      parse_uuid_id(&input.database_id, "databaseId")?,
      input.expected_edit_revision,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_record(record))
}

pub(crate) async fn delete_database_permanently(ctx: &Context<'_>, input: DatabaseLifecycleInput) -> Result<bool> {
  let (state, snapshot) = require_session(ctx).await?;
  service(&state)?
    .definition
    .delete_database_permanently_with_precondition(
      snapshot.user.id,
      parse_uuid_id(&input.database_id, "databaseId")?,
      input.expected_edit_revision,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(true)
}

pub(crate) async fn create_database_field(
  ctx: &Context<'_>,
  input: CreateDatabaseFieldInput,
) -> Result<DatabaseFieldObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let field_type: domain::DatabaseFieldType = input.field_type.into();
  let config = parse_field_config(field_type, input.config)?;
  let field = service(&state)?
    .definition
    .create_field(
      snapshot.user.id,
      database_id,
      input.name,
      field_type,
      config,
      input.required.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_field(field))
}

pub(crate) async fn update_database_field(
  ctx: &Context<'_>,
  input: UpdateDatabaseFieldInput,
) -> Result<DatabaseFieldObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let field_id = parse_uuid_id(&input.field_id, "fieldId")?;
  let config = input.config.map(parse_field_config_without_kind).transpose()?;
  let field = service(&state)?
    .definition
    .update_field_with_precondition(
      snapshot.user.id,
      database_id,
      field_id,
      input.name,
      config,
      input.required,
      input.expected_edit_revision,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_field(field))
}

pub(crate) async fn delete_database_field(ctx: &Context<'_>, input: DeleteDatabaseFieldInput) -> Result<bool> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let field_id = parse_uuid_id(&input.field_id, "fieldId")?;
  service(&state)?
    .definition
    .delete_field_with_precondition(
      snapshot.user.id,
      database_id,
      field_id,
      input.expected_edit_revision,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(true)
}

pub(crate) async fn reorder_database_fields(
  ctx: &Context<'_>,
  input: ReorderDatabaseFieldsInput,
) -> Result<Vec<DatabaseFieldObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let field_ids = input
    .field_ids
    .iter()
    .map(|id| parse_uuid_id(id, "fieldIds"))
    .collect::<Result<Vec<_>>>()?;
  let mut expected_edit_revisions = HashMap::new();
  for entry in input.expected_edit_revisions.unwrap_or_default() {
    expected_edit_revisions.insert(parse_uuid_id(&entry.field_id, "fieldId")?, entry.expected_edit_revision);
  }
  let fields = service(&state)?
    .definition
    .reorder_fields_with_precondition(
      snapshot.user.id,
      database_id,
      field_ids,
      &expected_edit_revisions,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(fields.into_iter().map(map_field).collect())
}
