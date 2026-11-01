// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;
mod tasks;
pub use tasks::*;

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseViewKind", rename_items = "PascalCase")]
pub enum DatabaseViewKindType {
  Table,
  Kanban,
  List,
  Gallery,
  Calendar,
  Timeline,
  Gantt,
  Progress,
}

impl From<domain::DatabaseViewKind> for DatabaseViewKindType {
  fn from(value: domain::DatabaseViewKind) -> Self {
    match value {
      domain::DatabaseViewKind::Table => Self::Table,
      domain::DatabaseViewKind::Kanban => Self::Kanban,
      domain::DatabaseViewKind::List => Self::List,
      domain::DatabaseViewKind::Gallery => Self::Gallery,
      domain::DatabaseViewKind::Calendar => Self::Calendar,
      domain::DatabaseViewKind::Timeline => Self::Timeline,
      domain::DatabaseViewKind::Gantt => Self::Gantt,
      domain::DatabaseViewKind::Progress => Self::Progress,
    }
  }
}

impl From<DatabaseViewKindType> for domain::DatabaseViewKind {
  fn from(value: DatabaseViewKindType) -> Self {
    match value {
      DatabaseViewKindType::Table => Self::Table,
      DatabaseViewKindType::Kanban => Self::Kanban,
      DatabaseViewKindType::List => Self::List,
      DatabaseViewKindType::Gallery => Self::Gallery,
      DatabaseViewKindType::Calendar => Self::Calendar,
      DatabaseViewKindType::Timeline => Self::Timeline,
      DatabaseViewKindType::Gantt => Self::Gantt,
      DatabaseViewKindType::Progress => Self::Progress,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseInventorySort", rename_items = "PascalCase")]
pub enum DatabaseInventorySortType {
  UpdatedDesc,
  TitleAsc,
  TitleDesc,
}

impl From<DatabaseInventorySortType> for domain::DatabaseInventorySort {
  fn from(value: DatabaseInventorySortType) -> Self {
    match value {
      DatabaseInventorySortType::UpdatedDesc => Self::UpdatedDesc,
      DatabaseInventorySortType::TitleAsc => Self::TitleAsc,
      DatabaseInventorySortType::TitleDesc => Self::TitleDesc,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRelationTargetType")]
pub struct DatabaseRelationTargetObjectType {
  pub row_id: ID,
  pub content_document: Option<DatabaseRowContentDocumentObjectType>,
  pub title: Option<String>,
  pub redacted: bool,
  pub deleted: bool,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseSortDirection", rename_items = "PascalCase")]
pub enum DatabaseSortDirectionType {
  Asc,
  Desc,
}

impl From<domain::DatabaseSortDirection> for DatabaseSortDirectionType {
  fn from(value: domain::DatabaseSortDirection) -> Self {
    match value {
      domain::DatabaseSortDirection::Asc => Self::Asc,
      domain::DatabaseSortDirection::Desc => Self::Desc,
    }
  }
}

impl From<DatabaseSortDirectionType> for domain::DatabaseSortDirection {
  fn from(value: DatabaseSortDirectionType) -> Self {
    match value {
      DatabaseSortDirectionType::Asc => Self::Asc,
      DatabaseSortDirectionType::Desc => Self::Desc,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseSortRuleType")]
pub struct DatabaseSortRuleObjectType {
  pub field_id: ID,
  pub direction: DatabaseSortDirectionType,
}

#[derive(InputObject, Clone)]
pub struct DatabaseSortRuleInput {
  pub field_id: ID,
  pub direction: DatabaseSortDirectionType,
}

#[derive(InputObject, Clone)]
pub struct DatabaseScheduleWindowInput {
  pub field_id: ID,
  pub end_field_id: Option<ID>,
  pub start: DateTime<Utc>,
  pub end: DateTime<Utc>,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseFilterOperator", rename_items = "PascalCase")]
pub enum DatabaseFilterOperatorType {
  Empty,
  NotEmpty,
  Contains,
  DoesNotContain,
  ContainsAll,
  Is,
  IsNot,
  StartsWith,
  EndsWith,
  Equals,
  NotEquals,
  Greater,
  Less,
  GreaterOrEqual,
  LessOrEqual,
  Between,
  AnyOf,
  NoneOf,
  GroupIs,
  GroupIsNot,
  GroupAnyOf,
  GroupNoneOf,
  Checked,
  Unchecked,
  ContainsUser,
  DoesNotContainUser,
  CurrentUser,
  ContainsRow,
  DoesNotContainRow,
  Before,
  After,
  On,
  Relative,
}

impl From<domain::DatabaseFilterOperator> for DatabaseFilterOperatorType {
  fn from(value: domain::DatabaseFilterOperator) -> Self {
    use domain::DatabaseFilterOperator as Operator;
    match value {
      Operator::Empty => Self::Empty,
      Operator::NotEmpty => Self::NotEmpty,
      Operator::Contains => Self::Contains,
      Operator::DoesNotContain => Self::DoesNotContain,
      Operator::ContainsAll => Self::ContainsAll,
      Operator::Is => Self::Is,
      Operator::IsNot => Self::IsNot,
      Operator::StartsWith => Self::StartsWith,
      Operator::EndsWith => Self::EndsWith,
      Operator::Equals => Self::Equals,
      Operator::NotEquals => Self::NotEquals,
      Operator::Greater => Self::Greater,
      Operator::Less => Self::Less,
      Operator::GreaterOrEqual => Self::GreaterOrEqual,
      Operator::LessOrEqual => Self::LessOrEqual,
      Operator::Between => Self::Between,
      Operator::AnyOf => Self::AnyOf,
      Operator::NoneOf => Self::NoneOf,
      Operator::GroupIs => Self::GroupIs,
      Operator::GroupIsNot => Self::GroupIsNot,
      Operator::GroupAnyOf => Self::GroupAnyOf,
      Operator::GroupNoneOf => Self::GroupNoneOf,
      Operator::Checked => Self::Checked,
      Operator::Unchecked => Self::Unchecked,
      Operator::ContainsUser => Self::ContainsUser,
      Operator::DoesNotContainUser => Self::DoesNotContainUser,
      Operator::CurrentUser => Self::CurrentUser,
      Operator::ContainsRow => Self::ContainsRow,
      Operator::DoesNotContainRow => Self::DoesNotContainRow,
      Operator::Before => Self::Before,
      Operator::After => Self::After,
      Operator::On => Self::On,
      Operator::Relative => Self::Relative,
    }
  }
}

impl From<DatabaseFilterOperatorType> for domain::DatabaseFilterOperator {
  fn from(value: DatabaseFilterOperatorType) -> Self {
    use domain::DatabaseFilterOperator as Operator;
    match value {
      DatabaseFilterOperatorType::Empty => Operator::Empty,
      DatabaseFilterOperatorType::NotEmpty => Operator::NotEmpty,
      DatabaseFilterOperatorType::Contains => Operator::Contains,
      DatabaseFilterOperatorType::DoesNotContain => Operator::DoesNotContain,
      DatabaseFilterOperatorType::ContainsAll => Operator::ContainsAll,
      DatabaseFilterOperatorType::Is => Operator::Is,
      DatabaseFilterOperatorType::IsNot => Operator::IsNot,
      DatabaseFilterOperatorType::StartsWith => Operator::StartsWith,
      DatabaseFilterOperatorType::EndsWith => Operator::EndsWith,
      DatabaseFilterOperatorType::Equals => Operator::Equals,
      DatabaseFilterOperatorType::NotEquals => Operator::NotEquals,
      DatabaseFilterOperatorType::Greater => Operator::Greater,
      DatabaseFilterOperatorType::Less => Operator::Less,
      DatabaseFilterOperatorType::GreaterOrEqual => Operator::GreaterOrEqual,
      DatabaseFilterOperatorType::LessOrEqual => Operator::LessOrEqual,
      DatabaseFilterOperatorType::Between => Operator::Between,
      DatabaseFilterOperatorType::AnyOf => Operator::AnyOf,
      DatabaseFilterOperatorType::NoneOf => Operator::NoneOf,
      DatabaseFilterOperatorType::GroupIs => Operator::GroupIs,
      DatabaseFilterOperatorType::GroupIsNot => Operator::GroupIsNot,
      DatabaseFilterOperatorType::GroupAnyOf => Operator::GroupAnyOf,
      DatabaseFilterOperatorType::GroupNoneOf => Operator::GroupNoneOf,
      DatabaseFilterOperatorType::Checked => Operator::Checked,
      DatabaseFilterOperatorType::Unchecked => Operator::Unchecked,
      DatabaseFilterOperatorType::ContainsUser => Operator::ContainsUser,
      DatabaseFilterOperatorType::DoesNotContainUser => Operator::DoesNotContainUser,
      DatabaseFilterOperatorType::CurrentUser => Operator::CurrentUser,
      DatabaseFilterOperatorType::ContainsRow => Operator::ContainsRow,
      DatabaseFilterOperatorType::DoesNotContainRow => Operator::DoesNotContainRow,
      DatabaseFilterOperatorType::Before => Operator::Before,
      DatabaseFilterOperatorType::After => Operator::After,
      DatabaseFilterOperatorType::On => Operator::On,
      DatabaseFilterOperatorType::Relative => Operator::Relative,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseRelativeDatePreset", rename_items = "PascalCase")]
pub enum DatabaseRelativeDatePresetType {
  Today,
  Yesterday,
  Tomorrow,
  Next7Days,
  Past7Days,
  CurrentWeek,
  CurrentMonth,
  CurrentYear,
  Overdue,
}

impl From<domain::DatabaseRelativeDatePreset> for DatabaseRelativeDatePresetType {
  fn from(value: domain::DatabaseRelativeDatePreset) -> Self {
    match value {
      domain::DatabaseRelativeDatePreset::Today => Self::Today,
      domain::DatabaseRelativeDatePreset::Yesterday => Self::Yesterday,
      domain::DatabaseRelativeDatePreset::Tomorrow => Self::Tomorrow,
      domain::DatabaseRelativeDatePreset::Next7Days => Self::Next7Days,
      domain::DatabaseRelativeDatePreset::Past7Days => Self::Past7Days,
      domain::DatabaseRelativeDatePreset::CurrentWeek => Self::CurrentWeek,
      domain::DatabaseRelativeDatePreset::CurrentMonth => Self::CurrentMonth,
      domain::DatabaseRelativeDatePreset::CurrentYear => Self::CurrentYear,
      domain::DatabaseRelativeDatePreset::Overdue => Self::Overdue,
    }
  }
}

impl From<DatabaseRelativeDatePresetType> for domain::DatabaseRelativeDatePreset {
  fn from(value: DatabaseRelativeDatePresetType) -> Self {
    match value {
      DatabaseRelativeDatePresetType::Today => Self::Today,
      DatabaseRelativeDatePresetType::Yesterday => Self::Yesterday,
      DatabaseRelativeDatePresetType::Tomorrow => Self::Tomorrow,
      DatabaseRelativeDatePresetType::Next7Days => Self::Next7Days,
      DatabaseRelativeDatePresetType::Past7Days => Self::Past7Days,
      DatabaseRelativeDatePresetType::CurrentWeek => Self::CurrentWeek,
      DatabaseRelativeDatePresetType::CurrentMonth => Self::CurrentMonth,
      DatabaseRelativeDatePresetType::CurrentYear => Self::CurrentYear,
      DatabaseRelativeDatePresetType::Overdue => Self::Overdue,
    }
  }
}

#[derive(InputObject, Clone)]
pub struct DatabaseNumberRangeType {
  pub start: Option<f64>,
  pub end: Option<f64>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseCurrencyRangeType {
  pub start: Option<f64>,
  pub end: Option<f64>,
  pub currency_code: String,
}

#[derive(InputObject, Clone)]
pub struct DatabaseDurationRangeType {
  pub start_minutes: Option<i64>,
  pub end_minutes: Option<i64>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseDateRangeType {
  pub start: Option<String>,
  pub end: Option<String>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseInstantRangeType {
  pub start: Option<DateTime<Utc>>,
  pub end: Option<DateTime<Utc>>,
}

#[derive(OneofObject, Clone)]
pub enum DatabaseFilterValueInput {
  None(bool),
  Text(String),
  Number(f64),
  NumberRange(DatabaseNumberRangeType),
  Currency(DatabaseCurrencyCellValueInput),
  CurrencyRange(DatabaseCurrencyRangeType),
  Duration(DatabaseDurationCellValueInput),
  DurationRange(DatabaseDurationRangeType),
  OptionId(String),
  Ids(Vec<String>),
  Date(String),
  DateRange(DatabaseDateRangeType),
  Instant(DateTime<Utc>),
  InstantRange(DatabaseInstantRangeType),
  RelativeDate(DatabaseRelativeDatePresetType),
  UserId(ID),
  UserIds(Vec<ID>),
  RelationRowId(ID),
  RelationRowIds(Vec<ID>),
  Boolean(bool),
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseFilterValueType")]
pub struct DatabaseFilterValueObjectType {
  pub kind: String,
  pub value: JsonValue,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseFilterRuleType")]
pub struct DatabaseFilterRuleObjectType {
  pub field_id: ID,
  pub operator: DatabaseFilterOperatorType,
  pub value: DatabaseFilterValueObjectType,
}

#[derive(InputObject, Clone)]
pub struct DatabaseFilterRuleInput {
  pub field_id: ID,
  pub operator: DatabaseFilterOperatorType,
  pub value: DatabaseFilterValueInput,
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseFilterConjunction", rename_items = "PascalCase")]
pub enum DatabaseFilterConjunctionType {
  And,
  Or,
}

impl From<domain::DatabaseFilterConjunction> for DatabaseFilterConjunctionType {
  fn from(value: domain::DatabaseFilterConjunction) -> Self {
    match value {
      domain::DatabaseFilterConjunction::And => Self::And,
      domain::DatabaseFilterConjunction::Or => Self::Or,
    }
  }
}

impl From<DatabaseFilterConjunctionType> for domain::DatabaseFilterConjunction {
  fn from(value: DatabaseFilterConjunctionType) -> Self {
    match value {
      DatabaseFilterConjunctionType::And => Self::And,
      DatabaseFilterConjunctionType::Or => Self::Or,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseFilterGroupType")]
pub struct DatabaseFilterGroupObjectType {
  pub conjunction: DatabaseFilterConjunctionType,
  pub rules: Vec<DatabaseFilterRuleObjectType>,
  pub groups: Vec<DatabaseFilterGroupObjectType>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseFilterGroupInput {
  pub conjunction: Option<DatabaseFilterConjunctionType>,
  pub rules: Option<Vec<DatabaseFilterRuleInput>>,
  pub groups: Option<Vec<DatabaseFilterGroupInput>>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseGroupRuleType")]
pub struct DatabaseGroupRuleObjectType {
  pub field_id: ID,
  pub descending: bool,
  pub show_empty_groups: bool,
}

#[derive(InputObject, Clone)]
pub struct DatabaseGroupRuleInput {
  pub field_id: ID,
  pub descending: Option<bool>,
  pub show_empty_groups: Option<bool>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseFieldWidthType")]
pub struct DatabaseFieldWidthObjectType {
  pub field_id: ID,
  pub width: i32,
}

#[derive(InputObject, Clone)]
pub struct DatabaseFieldWidthInput {
  pub field_id: ID,
  pub width: i32,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseTableViewConfigType")]
pub struct DatabaseTableViewConfigObjectType {
  pub title_field_id: ID,
  pub visible_field_ids: Vec<ID>,
  pub field_widths: Vec<DatabaseFieldWidthObjectType>,
  pub search_field_ids: Vec<ID>,
  pub sort: Vec<DatabaseSortRuleObjectType>,
  pub filter: Vec<DatabaseFilterRuleObjectType>,
  pub filter_tree: Option<DatabaseFilterGroupObjectType>,
  pub group: Option<DatabaseGroupRuleObjectType>,
  pub subgroup: Option<DatabaseGroupRuleObjectType>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseTableViewConfigInput {
  pub title_field_id: ID,
  pub visible_field_ids: Option<Vec<ID>>,
  pub field_widths: Option<Vec<DatabaseFieldWidthInput>>,
  pub search_field_ids: Option<Vec<ID>>,
  pub sort: Option<Vec<DatabaseSortRuleInput>>,
  pub filter: Option<Vec<DatabaseFilterRuleInput>>,
  pub filter_tree: Option<DatabaseFilterGroupInput>,
  pub group: Option<DatabaseGroupRuleInput>,
  pub subgroup: Option<DatabaseGroupRuleInput>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseKanbanViewConfigType")]
pub struct DatabaseKanbanViewConfigObjectType {
  pub title_field_id: ID,
  pub group_field_id: ID,
  pub visible_field_ids: Vec<ID>,
  pub cover_field_id: Option<ID>,
  pub card_density: DatabaseCardDensityType,
  pub sort: Vec<DatabaseSortRuleObjectType>,
  pub filter: Vec<DatabaseFilterRuleObjectType>,
  pub filter_tree: Option<DatabaseFilterGroupObjectType>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseKanbanViewConfigInput {
  pub title_field_id: ID,
  pub group_field_id: ID,
  pub visible_field_ids: Option<Vec<ID>>,
  pub cover_field_id: Option<ID>,
  pub card_density: Option<DatabaseCardDensityType>,
  pub sort: Option<Vec<DatabaseSortRuleInput>>,
  pub filter: Option<Vec<DatabaseFilterRuleInput>>,
  pub filter_tree: Option<DatabaseFilterGroupInput>,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseCardDensity", rename_items = "PascalCase")]
pub enum DatabaseCardDensityType {
  Compact,
  Default,
  Comfortable,
}

impl From<domain::DatabaseCardDensity> for DatabaseCardDensityType {
  fn from(value: domain::DatabaseCardDensity) -> Self {
    match value {
      domain::DatabaseCardDensity::Compact => Self::Compact,
      domain::DatabaseCardDensity::Default => Self::Default,
      domain::DatabaseCardDensity::Comfortable => Self::Comfortable,
    }
  }
}

impl From<DatabaseCardDensityType> for domain::DatabaseCardDensity {
  fn from(value: DatabaseCardDensityType) -> Self {
    match value {
      DatabaseCardDensityType::Compact => Self::Compact,
      DatabaseCardDensityType::Default => Self::Default,
      DatabaseCardDensityType::Comfortable => Self::Comfortable,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseListDensity", rename_items = "PascalCase")]
pub enum DatabaseListDensityType {
  Compact,
  Default,
  Comfortable,
}

impl From<domain::DatabaseListDensity> for DatabaseListDensityType {
  fn from(value: domain::DatabaseListDensity) -> Self {
    match value {
      domain::DatabaseListDensity::Compact => Self::Compact,
      domain::DatabaseListDensity::Default => Self::Default,
      domain::DatabaseListDensity::Comfortable => Self::Comfortable,
    }
  }
}

impl From<DatabaseListDensityType> for domain::DatabaseListDensity {
  fn from(value: DatabaseListDensityType) -> Self {
    match value {
      DatabaseListDensityType::Compact => Self::Compact,
      DatabaseListDensityType::Default => Self::Default,
      DatabaseListDensityType::Comfortable => Self::Comfortable,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseGalleryCardDensity", rename_items = "PascalCase")]
pub enum DatabaseGalleryCardDensityType {
  Compact,
  Default,
  Large,
}

impl From<domain::DatabaseGalleryCardDensity> for DatabaseGalleryCardDensityType {
  fn from(value: domain::DatabaseGalleryCardDensity) -> Self {
    match value {
      domain::DatabaseGalleryCardDensity::Compact => Self::Compact,
      domain::DatabaseGalleryCardDensity::Default => Self::Default,
      domain::DatabaseGalleryCardDensity::Large => Self::Large,
    }
  }
}

impl From<DatabaseGalleryCardDensityType> for domain::DatabaseGalleryCardDensity {
  fn from(value: DatabaseGalleryCardDensityType) -> Self {
    match value {
      DatabaseGalleryCardDensityType::Compact => Self::Compact,
      DatabaseGalleryCardDensityType::Default => Self::Default,
      DatabaseGalleryCardDensityType::Large => Self::Large,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseCalendarDateMode", rename_items = "PascalCase")]
pub enum DatabaseCalendarDateModeType {
  Day,
  Week,
  Month,
  Year,
}

impl From<domain::DatabaseCalendarDateMode> for DatabaseCalendarDateModeType {
  fn from(value: domain::DatabaseCalendarDateMode) -> Self {
    match value {
      domain::DatabaseCalendarDateMode::Day => Self::Day,
      domain::DatabaseCalendarDateMode::Week => Self::Week,
      domain::DatabaseCalendarDateMode::Month => Self::Month,
      domain::DatabaseCalendarDateMode::Year => Self::Year,
    }
  }
}

impl From<DatabaseCalendarDateModeType> for domain::DatabaseCalendarDateMode {
  fn from(value: DatabaseCalendarDateModeType) -> Self {
    match value {
      DatabaseCalendarDateModeType::Day => Self::Day,
      DatabaseCalendarDateModeType::Week => Self::Week,
      DatabaseCalendarDateModeType::Month => Self::Month,
      DatabaseCalendarDateModeType::Year => Self::Year,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseCalendarInitialRange", rename_items = "PascalCase")]
pub enum DatabaseCalendarInitialRangeType {
  Today,
  CurrentWeek,
  CurrentMonth,
  CurrentYear,
}

impl From<domain::DatabaseCalendarInitialRange> for DatabaseCalendarInitialRangeType {
  fn from(value: domain::DatabaseCalendarInitialRange) -> Self {
    match value {
      domain::DatabaseCalendarInitialRange::Today => Self::Today,
      domain::DatabaseCalendarInitialRange::CurrentWeek => Self::CurrentWeek,
      domain::DatabaseCalendarInitialRange::CurrentMonth => Self::CurrentMonth,
      domain::DatabaseCalendarInitialRange::CurrentYear => Self::CurrentYear,
    }
  }
}

impl From<DatabaseCalendarInitialRangeType> for domain::DatabaseCalendarInitialRange {
  fn from(value: DatabaseCalendarInitialRangeType) -> Self {
    match value {
      DatabaseCalendarInitialRangeType::Today => Self::Today,
      DatabaseCalendarInitialRangeType::CurrentWeek => Self::CurrentWeek,
      DatabaseCalendarInitialRangeType::CurrentMonth => Self::CurrentMonth,
      DatabaseCalendarInitialRangeType::CurrentYear => Self::CurrentYear,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseTimelineGroupBy", rename_items = "PascalCase")]
pub enum DatabaseTimelineGroupByType {
  None,
  Day,
  Week,
  Month,
}

impl From<domain::DatabaseTimelineGroupBy> for DatabaseTimelineGroupByType {
  fn from(value: domain::DatabaseTimelineGroupBy) -> Self {
    match value {
      domain::DatabaseTimelineGroupBy::None => Self::None,
      domain::DatabaseTimelineGroupBy::Day => Self::Day,
      domain::DatabaseTimelineGroupBy::Week => Self::Week,
      domain::DatabaseTimelineGroupBy::Month => Self::Month,
    }
  }
}

impl From<DatabaseTimelineGroupByType> for domain::DatabaseTimelineGroupBy {
  fn from(value: DatabaseTimelineGroupByType) -> Self {
    match value {
      DatabaseTimelineGroupByType::None => Self::None,
      DatabaseTimelineGroupByType::Day => Self::Day,
      DatabaseTimelineGroupByType::Week => Self::Week,
      DatabaseTimelineGroupByType::Month => Self::Month,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseTimelineOrder", rename_items = "PascalCase")]
pub enum DatabaseTimelineOrderType {
  Asc,
  Desc,
}

impl From<domain::DatabaseTimelineOrder> for DatabaseTimelineOrderType {
  fn from(value: domain::DatabaseTimelineOrder) -> Self {
    match value {
      domain::DatabaseTimelineOrder::Asc => Self::Asc,
      domain::DatabaseTimelineOrder::Desc => Self::Desc,
    }
  }
}

impl From<DatabaseTimelineOrderType> for domain::DatabaseTimelineOrder {
  fn from(value: DatabaseTimelineOrderType) -> Self {
    match value {
      DatabaseTimelineOrderType::Asc => Self::Asc,
      DatabaseTimelineOrderType::Desc => Self::Desc,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseListViewConfigType")]
pub struct DatabaseListViewConfigObjectType {
  pub title_field_id: ID,
  pub visible_field_ids: Vec<ID>,
  pub sort: Vec<DatabaseSortRuleObjectType>,
  pub filter: Vec<DatabaseFilterRuleObjectType>,
  pub filter_tree: Option<DatabaseFilterGroupObjectType>,
  pub density: DatabaseListDensityType,
  pub show_field_labels: bool,
  pub group: Option<DatabaseGroupRuleObjectType>,
  pub subgroup: Option<DatabaseGroupRuleObjectType>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseListViewConfigInput {
  pub title_field_id: ID,
  pub visible_field_ids: Option<Vec<ID>>,
  pub sort: Option<Vec<DatabaseSortRuleInput>>,
  pub filter: Option<Vec<DatabaseFilterRuleInput>>,
  pub filter_tree: Option<DatabaseFilterGroupInput>,
  pub density: Option<DatabaseListDensityType>,
  pub show_field_labels: Option<bool>,
  pub group: Option<DatabaseGroupRuleInput>,
  pub subgroup: Option<DatabaseGroupRuleInput>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseGalleryViewConfigType")]
pub struct DatabaseGalleryViewConfigObjectType {
  pub title_field_id: ID,
  pub visible_field_ids: Vec<ID>,
  pub cover_field_id: Option<ID>,
  pub sort: Vec<DatabaseSortRuleObjectType>,
  pub filter: Vec<DatabaseFilterRuleObjectType>,
  pub filter_tree: Option<DatabaseFilterGroupObjectType>,
  pub card_density: DatabaseGalleryCardDensityType,
  pub show_empty_cover: bool,
  pub group: Option<DatabaseGroupRuleObjectType>,
  pub subgroup: Option<DatabaseGroupRuleObjectType>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseGalleryViewConfigInput {
  pub title_field_id: ID,
  pub visible_field_ids: Option<Vec<ID>>,
  pub cover_field_id: Option<ID>,
  pub sort: Option<Vec<DatabaseSortRuleInput>>,
  pub filter: Option<Vec<DatabaseFilterRuleInput>>,
  pub filter_tree: Option<DatabaseFilterGroupInput>,
  pub card_density: Option<DatabaseGalleryCardDensityType>,
  pub show_empty_cover: Option<bool>,
  pub group: Option<DatabaseGroupRuleInput>,
  pub subgroup: Option<DatabaseGroupRuleInput>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseCalendarViewConfigType")]
pub struct DatabaseCalendarViewConfigObjectType {
  pub title_field_id: ID,
  pub date_field_id: ID,
  pub visible_field_ids: Vec<ID>,
  pub sort: Vec<DatabaseSortRuleObjectType>,
  pub filter: Vec<DatabaseFilterRuleObjectType>,
  pub filter_tree: Option<DatabaseFilterGroupObjectType>,
  pub date_mode: DatabaseCalendarDateModeType,
  pub initial_range: DatabaseCalendarInitialRangeType,
  pub group: Option<DatabaseGroupRuleObjectType>,
  pub subgroup: Option<DatabaseGroupRuleObjectType>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseCalendarViewConfigInput {
  pub title_field_id: ID,
  pub date_field_id: ID,
  pub visible_field_ids: Option<Vec<ID>>,
  pub sort: Option<Vec<DatabaseSortRuleInput>>,
  pub filter: Option<Vec<DatabaseFilterRuleInput>>,
  pub filter_tree: Option<DatabaseFilterGroupInput>,
  pub date_mode: Option<DatabaseCalendarDateModeType>,
  pub initial_range: Option<DatabaseCalendarInitialRangeType>,
  pub group: Option<DatabaseGroupRuleInput>,
  pub subgroup: Option<DatabaseGroupRuleInput>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseTimelineViewConfigType")]
pub struct DatabaseTimelineViewConfigObjectType {
  pub title_field_id: ID,
  pub start_field_id: ID,
  pub end_field_id: Option<ID>,
  pub visible_field_ids: Vec<ID>,
  pub sort: Vec<DatabaseSortRuleObjectType>,
  pub filter: Vec<DatabaseFilterRuleObjectType>,
  pub filter_tree: Option<DatabaseFilterGroupObjectType>,
  pub group_by: DatabaseTimelineGroupByType,
  pub order: DatabaseTimelineOrderType,
  pub zoom: DatabaseTimelineZoomType,
}

#[derive(InputObject, Clone)]
pub struct DatabaseTimelineViewConfigInput {
  pub title_field_id: ID,
  pub start_field_id: ID,
  pub end_field_id: Option<ID>,
  pub visible_field_ids: Option<Vec<ID>>,
  pub sort: Option<Vec<DatabaseSortRuleInput>>,
  pub filter: Option<Vec<DatabaseFilterRuleInput>>,
  pub filter_tree: Option<DatabaseFilterGroupInput>,
  pub group_by: Option<DatabaseTimelineGroupByType>,
  pub order: Option<DatabaseTimelineOrderType>,
  pub zoom: Option<DatabaseTimelineZoomType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseGanttViewConfigType")]
pub struct DatabaseGanttViewConfigObjectType {
  pub title_field_id: ID,
  pub start_field_id: ID,
  pub end_field_id: Option<ID>,
  pub visible_field_ids: Vec<ID>,
  pub sort: Vec<DatabaseSortRuleObjectType>,
  pub filter: Vec<DatabaseFilterRuleObjectType>,
  pub filter_tree: Option<DatabaseFilterGroupObjectType>,
  pub group: Option<DatabaseGroupRuleObjectType>,
  pub zoom: DatabaseTimelineZoomType,
  pub dependency_field_id: Option<ID>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseGanttViewConfigInput {
  pub title_field_id: ID,
  pub start_field_id: ID,
  pub end_field_id: Option<ID>,
  pub visible_field_ids: Option<Vec<ID>>,
  pub sort: Option<Vec<DatabaseSortRuleInput>>,
  pub filter: Option<Vec<DatabaseFilterRuleInput>>,
  pub filter_tree: Option<DatabaseFilterGroupInput>,
  pub group: Option<DatabaseGroupRuleInput>,
  pub zoom: Option<DatabaseTimelineZoomType>,
  pub dependency_field_id: Option<ID>,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseTimelineZoom", rename_items = "PascalCase")]
pub enum DatabaseTimelineZoomType {
  Day,
  Week,
  Month,
  Quarter,
  Year,
}

impl From<domain::DatabaseTimelineZoom> for DatabaseTimelineZoomType {
  fn from(value: domain::DatabaseTimelineZoom) -> Self {
    match value {
      domain::DatabaseTimelineZoom::Day => Self::Day,
      domain::DatabaseTimelineZoom::Week => Self::Week,
      domain::DatabaseTimelineZoom::Month => Self::Month,
      domain::DatabaseTimelineZoom::Quarter => Self::Quarter,
      domain::DatabaseTimelineZoom::Year => Self::Year,
    }
  }
}

impl From<DatabaseTimelineZoomType> for domain::DatabaseTimelineZoom {
  fn from(value: DatabaseTimelineZoomType) -> Self {
    match value {
      DatabaseTimelineZoomType::Day => Self::Day,
      DatabaseTimelineZoomType::Week => Self::Week,
      DatabaseTimelineZoomType::Month => Self::Month,
      DatabaseTimelineZoomType::Quarter => Self::Quarter,
      DatabaseTimelineZoomType::Year => Self::Year,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseProgressViewConfigType")]
pub struct DatabaseProgressViewConfigObjectType {
  pub title_field_id: ID,
  pub progress_field_id: ID,
  pub group_field_id: Option<ID>,
  pub visible_field_ids: Vec<ID>,
  pub sort: Vec<DatabaseSortRuleObjectType>,
  pub filter: Vec<DatabaseFilterRuleObjectType>,
  pub filter_tree: Option<DatabaseFilterGroupObjectType>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseProgressViewConfigInput {
  pub title_field_id: ID,
  pub progress_field_id: ID,
  pub group_field_id: Option<ID>,
  pub visible_field_ids: Option<Vec<ID>>,
  pub sort: Option<Vec<DatabaseSortRuleInput>>,
  pub filter: Option<Vec<DatabaseFilterRuleInput>>,
  pub filter_tree: Option<DatabaseFilterGroupInput>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseViewConfigType")]
pub struct DatabaseViewConfigObjectType {
  pub kind: DatabaseViewKindType,
  pub table: Option<DatabaseTableViewConfigObjectType>,
  pub kanban: Option<DatabaseKanbanViewConfigObjectType>,
  pub list: Option<DatabaseListViewConfigObjectType>,
  pub gallery: Option<DatabaseGalleryViewConfigObjectType>,
  pub calendar: Option<DatabaseCalendarViewConfigObjectType>,
  pub timeline: Option<DatabaseTimelineViewConfigObjectType>,
  pub gantt: Option<DatabaseGanttViewConfigObjectType>,
  pub progress: Option<DatabaseProgressViewConfigObjectType>,
}

#[derive(InputObject, Clone)]
pub struct DatabaseViewConfigInput {
  pub table: Option<DatabaseTableViewConfigInput>,
  pub kanban: Option<DatabaseKanbanViewConfigInput>,
  pub list: Option<DatabaseListViewConfigInput>,
  pub gallery: Option<DatabaseGalleryViewConfigInput>,
  pub calendar: Option<DatabaseCalendarViewConfigInput>,
  pub timeline: Option<DatabaseTimelineViewConfigInput>,
  pub gantt: Option<DatabaseGanttViewConfigInput>,
  pub progress: Option<DatabaseProgressViewConfigInput>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseViewType")]
pub struct DatabaseViewObjectType {
  pub id: ID,
  pub database_id: ID,
  pub name: String,
  pub view_kind: DatabaseViewKindType,
  pub icon: Option<DatabaseViewIconObjectType>,
  pub config: DatabaseViewConfigObjectType,
  pub position: i32,
  pub edit_revision: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseViewSystemIcon", rename_items = "PascalCase")]
pub enum DatabaseViewSystemIconType {
  Table,
  Board,
  List,
  Gallery,
  Calendar,
  Timeline,
  Progress,
  Database,
  Project,
}

#[derive(OneofObject, Clone)]
pub enum DatabaseViewIconInput {
  System(DatabaseViewSystemIconType),
  Emoji(String),
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseViewIconType")]
pub struct DatabaseViewIconObjectType {
  pub system: Option<DatabaseViewSystemIconType>,
  pub emoji: Option<String>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseViewUserStateType")]
pub struct DatabaseViewUserStateObjectType {
  pub view_id: ID,
  pub search_text: String,
  pub sort: Option<Vec<DatabaseSortRuleObjectType>>,
  pub filter_tree: Option<DatabaseFilterGroupObjectType>,
  pub field_width_overrides: Vec<DatabaseFieldWidthObjectType>,
  pub collapsed_group_keys: Vec<String>,
  pub edit_revision: i64,
  pub updated_at: DateTime<Utc>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseEffectiveViewStateType")]
pub struct DatabaseEffectiveViewStateObjectType {
  pub view_id: ID,
  pub saved_sort: Vec<DatabaseSortRuleObjectType>,
  pub saved_filter_tree: Option<DatabaseFilterGroupObjectType>,
  pub personal_state: Option<DatabaseViewUserStateObjectType>,
  pub effective_sort: Vec<DatabaseSortRuleObjectType>,
  pub effective_filter_tree: Option<DatabaseFilterGroupObjectType>,
  pub search_text: String,
  pub effective_field_widths: Vec<DatabaseFieldWidthObjectType>,
  pub can_edit_shared: bool,
  /// Current permission to edit live Rows, independent of shared View settings.
  pub can_edit_rows: bool,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRowsPage")]
pub struct DatabaseRowsPageObjectType {
  pub rows: Vec<DatabaseRowRecordObjectType>,
  pub total_count: i64,
  pub end_cursor: Option<String>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseRowGroupSummary")]
pub struct DatabaseRowGroupSummaryObjectType {
  pub key: String,
  pub label: String,
  pub row_count: i64,
  pub groups: Vec<DatabaseRowGroupSummaryObjectType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseProgressGroupSummary")]
pub struct DatabaseProgressGroupSummaryObjectType {
  pub key: String,
  pub label: String,
  pub total_count: i64,
  pub completed_count: i64,
  pub incomplete_count: i64,
  pub blocked_count: i64,
  pub overdue_count: i64,
  pub average_progress: Option<f64>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseProgressSummary")]
pub struct DatabaseProgressSummaryObjectType {
  pub view_id: ID,
  pub progress_field_id: ID,
  pub group_field_id: Option<ID>,
  pub total_count: i64,
  pub completed_count: i64,
  pub incomplete_count: i64,
  pub blocked_count: i64,
  pub overdue_count: i64,
  pub average_progress: Option<f64>,
  pub groups: Vec<DatabaseProgressGroupSummaryObjectType>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseSummary")]
pub struct DatabaseSummaryObjectType {
  pub id: ID,
  pub system_role: Option<DatabaseSystemRoleType>,
  pub workspace_id: ID,
  pub profile_kind: DatabaseProfileKindType,
  pub profile_structure_preset: Option<String>,
  pub title: String,
  pub description: Option<String>,
  pub deleted_at: Option<DateTime<Utc>>,
  pub edit_revision: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub row_count: i64,
  pub field_count: i64,
  pub view_count: i64,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabasePageIdentity")]
pub struct DatabasePageIdentityObjectType {
  pub id: ID,
  pub system_role: Option<DatabaseSystemRoleType>,
  pub profile_kind: DatabaseProfileKindType,
  pub title: String,
  pub description: Option<String>,
  pub deleted_at: Option<DateTime<Utc>>,
  pub edit_revision: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(InputObject)]
pub struct CreateDatabaseViewInput {
  pub database_id: ID,
  pub name: String,
  pub view_kind: DatabaseViewKindType,
  pub icon: Option<DatabaseViewIconInput>,
  pub config: DatabaseViewConfigInput,
}

#[derive(InputObject)]
pub struct UpdateDatabaseViewInput {
  pub database_id: ID,
  pub view_id: ID,
  pub name: Option<String>,
  pub view_kind: Option<DatabaseViewKindType>,
  pub icon: MaybeUndefined<DatabaseViewIconInput>,
  pub config: Option<DatabaseViewConfigInput>,
  pub expected_edit_revision: Option<i64>,
  pub force: Option<bool>,
}

#[derive(InputObject)]
pub struct UpsertDatabaseViewUserStateInput {
  pub database_id: ID,
  pub view_id: ID,
  pub search_text: Option<String>,
  pub sort: Option<Vec<DatabaseSortRuleInput>>,
  pub filter_tree: Option<DatabaseFilterGroupInput>,
  pub field_width_overrides: Option<Vec<DatabaseFieldWidthInput>>,
  pub collapsed_group_keys: Option<Vec<String>>,
  pub expected_edit_revision: i64,
}

#[derive(InputObject)]
pub struct ResetDatabaseViewUserStateInput {
  pub database_id: ID,
  pub view_id: ID,
  pub expected_edit_revision: i64,
}

#[derive(InputObject)]
pub struct SaveDatabaseViewUserStateInput {
  pub database_id: ID,
  pub view_id: ID,
  pub expected_view_edit_revision: i64,
}

#[derive(InputObject)]
pub struct DeleteDatabaseViewInput {
  pub database_id: ID,
  pub view_id: ID,
  pub replacement_view_id: Option<ID>,
  pub expected_edit_revision: Option<i64>,
  pub force: Option<bool>,
}

#[derive(InputObject)]
pub struct DatabaseViewEditRevisionInput {
  pub view_id: ID,
  pub expected_edit_revision: i64,
}

#[derive(InputObject)]
pub struct ReorderDatabaseViewsInput {
  pub database_id: ID,
  pub view_ids: Vec<ID>,
  pub expected_edit_revisions: Option<Vec<DatabaseViewEditRevisionInput>>,
  pub force: Option<bool>,
}

fn parse_schedule_window(
  window: Option<DatabaseScheduleWindowInput>,
) -> Result<Option<domain::DatabaseScheduleWindow>> {
  window
    .map(|window| {
      Ok::<_, async_graphql::Error>(domain::DatabaseScheduleWindow {
        all_day_calendar: false,
        field_id: parse_uuid_id(&window.field_id, "scheduleWindow.fieldId")?,
        end_field_id: window
          .end_field_id
          .as_ref()
          .map(|id| parse_uuid_id(id, "scheduleWindow.endFieldId"))
          .transpose()?,
        start: window.start,
        end: window.end,
      })
    })
    .transpose()
}

fn parse_view_icon(icon: DatabaseViewIconInput) -> Result<domain::DatabaseViewIcon> {
  match icon {
    DatabaseViewIconInput::System(system) => {
      let system = match system {
        DatabaseViewSystemIconType::Table => domain::DatabaseViewSystemIcon::Table,
        DatabaseViewSystemIconType::Board => domain::DatabaseViewSystemIcon::Board,
        DatabaseViewSystemIconType::List => domain::DatabaseViewSystemIcon::List,
        DatabaseViewSystemIconType::Gallery => domain::DatabaseViewSystemIcon::Gallery,
        DatabaseViewSystemIconType::Calendar => domain::DatabaseViewSystemIcon::Calendar,
        DatabaseViewSystemIconType::Timeline => domain::DatabaseViewSystemIcon::Timeline,
        DatabaseViewSystemIconType::Progress => domain::DatabaseViewSystemIcon::Progress,
        DatabaseViewSystemIconType::Database => domain::DatabaseViewSystemIcon::Database,
        DatabaseViewSystemIconType::Project => domain::DatabaseViewSystemIcon::Project,
      };
      Ok(domain::DatabaseViewIcon::System(system))
    }
    DatabaseViewIconInput::Emoji(emoji) => Ok(domain::DatabaseViewIcon::Emoji(emoji)),
  }
}

fn parse_view_config(value: DatabaseViewConfigInput) -> Result<domain::DatabaseViewConfig> {
  let set_count = usize::from(value.table.is_some())
    + usize::from(value.kanban.is_some())
    + usize::from(value.list.is_some())
    + usize::from(value.gallery.is_some())
    + usize::from(value.calendar.is_some())
    + usize::from(value.timeline.is_some())
    + usize::from(value.gantt.is_some())
    + usize::from(value.progress.is_some());
  if set_count != 1 {
    return Err(database_error(
      "MIX_DATABASE_VIEW_CONFIG_INVALID",
      "view config input must set exactly one view config",
    ));
  }
  if let Some(config) = value.table {
    return Ok(domain::DatabaseViewConfig::Table(domain::DatabaseTableViewConfig {
      title_field_id: parse_uuid_id(&config.title_field_id, "titleFieldId")?,
      visible_field_ids: parse_id_vec(config.visible_field_ids.unwrap_or_default(), "visibleFieldIds")?,
      field_widths: parse_field_widths(config.field_widths.unwrap_or_default())?,
      search_field_ids: parse_id_vec(config.search_field_ids.unwrap_or_default(), "searchFieldIds")?,
      sort: parse_sort_rules(config.sort.unwrap_or_default())?,
      filter: parse_filter_rules(config.filter.unwrap_or_default())?,
      filter_tree: parse_filter_group(config.filter_tree)?,
      group: parse_group_rule(config.group)?,
      subgroup: parse_group_rule(config.subgroup)?,
    }));
  }
  if let Some(config) = value.kanban {
    return Ok(domain::DatabaseViewConfig::Kanban(domain::DatabaseKanbanViewConfig {
      title_field_id: parse_uuid_id(&config.title_field_id, "titleFieldId")?,
      group_field_id: parse_uuid_id(&config.group_field_id, "groupFieldId")?,
      visible_field_ids: parse_id_vec(config.visible_field_ids.unwrap_or_default(), "visibleFieldIds")?,
      cover_field_id: config
        .cover_field_id
        .as_ref()
        .map(|id| parse_uuid_id(id, "coverFieldId"))
        .transpose()?,
      card_density: config.card_density.map(Into::into).unwrap_or_default(),
      sort: parse_sort_rules(config.sort.unwrap_or_default())?,
      filter: parse_filter_rules(config.filter.unwrap_or_default())?,
      filter_tree: parse_filter_group(config.filter_tree)?,
    }));
  }
  if let Some(config) = value.list {
    return Ok(domain::DatabaseViewConfig::List(domain::DatabaseListViewConfig {
      title_field_id: parse_uuid_id(&config.title_field_id, "titleFieldId")?,
      visible_field_ids: parse_id_vec(config.visible_field_ids.unwrap_or_default(), "visibleFieldIds")?,
      sort: parse_sort_rules(config.sort.unwrap_or_default())?,
      filter: parse_filter_rules(config.filter.unwrap_or_default())?,
      filter_tree: parse_filter_group(config.filter_tree)?,
      density: config.density.map(Into::into).unwrap_or_default(),
      show_field_labels: config.show_field_labels.unwrap_or(true),
      group: parse_group_rule(config.group)?,
      subgroup: parse_group_rule(config.subgroup)?,
    }));
  }
  if let Some(config) = value.gallery {
    return Ok(domain::DatabaseViewConfig::Gallery(domain::DatabaseGalleryViewConfig {
      title_field_id: parse_uuid_id(&config.title_field_id, "titleFieldId")?,
      visible_field_ids: parse_id_vec(config.visible_field_ids.unwrap_or_default(), "visibleFieldIds")?,
      cover_field_id: config
        .cover_field_id
        .as_ref()
        .map(|id| parse_uuid_id(id, "coverFieldId"))
        .transpose()?,
      sort: parse_sort_rules(config.sort.unwrap_or_default())?,
      filter: parse_filter_rules(config.filter.unwrap_or_default())?,
      filter_tree: parse_filter_group(config.filter_tree)?,
      card_density: config.card_density.map(Into::into).unwrap_or_default(),
      show_empty_cover: config.show_empty_cover.unwrap_or(true),
      group: parse_group_rule(config.group)?,
      subgroup: parse_group_rule(config.subgroup)?,
    }));
  }
  if let Some(config) = value.calendar {
    return Ok(domain::DatabaseViewConfig::Calendar(
      domain::DatabaseCalendarViewConfig {
        title_field_id: parse_uuid_id(&config.title_field_id, "titleFieldId")?,
        date_field_id: parse_uuid_id(&config.date_field_id, "dateFieldId")?,
        visible_field_ids: parse_id_vec(config.visible_field_ids.unwrap_or_default(), "visibleFieldIds")?,
        sort: parse_sort_rules(config.sort.unwrap_or_default())?,
        filter: parse_filter_rules(config.filter.unwrap_or_default())?,
        filter_tree: parse_filter_group(config.filter_tree)?,
        date_mode: config.date_mode.map(Into::into).unwrap_or_default(),
        initial_range: config.initial_range.map(Into::into).unwrap_or_default(),
        group: parse_group_rule(config.group)?,
        subgroup: parse_group_rule(config.subgroup)?,
      },
    ));
  }
  if let Some(config) = value.timeline {
    return Ok(domain::DatabaseViewConfig::Timeline(
      domain::DatabaseTimelineViewConfig {
        title_field_id: parse_uuid_id(&config.title_field_id, "titleFieldId")?,
        start_field_id: parse_uuid_id(&config.start_field_id, "startFieldId")?,
        end_field_id: config
          .end_field_id
          .as_ref()
          .map(|id| parse_uuid_id(id, "endFieldId"))
          .transpose()?,
        visible_field_ids: parse_id_vec(config.visible_field_ids.unwrap_or_default(), "visibleFieldIds")?,
        sort: parse_sort_rules(config.sort.unwrap_or_default())?,
        filter: parse_filter_rules(config.filter.unwrap_or_default())?,
        filter_tree: parse_filter_group(config.filter_tree)?,
        group_by: config.group_by.map(Into::into).unwrap_or_default(),
        order: config.order.map(Into::into).unwrap_or_default(),
        zoom: config.zoom.map(Into::into).unwrap_or_default(),
      },
    ));
  }
  if let Some(config) = value.gantt {
    return Ok(domain::DatabaseViewConfig::Gantt(domain::DatabaseGanttViewConfig {
      title_field_id: parse_uuid_id(&config.title_field_id, "titleFieldId")?,
      start_field_id: parse_uuid_id(&config.start_field_id, "startFieldId")?,
      end_field_id: config
        .end_field_id
        .as_ref()
        .map(|id| parse_uuid_id(id, "endFieldId"))
        .transpose()?,
      visible_field_ids: parse_id_vec(config.visible_field_ids.unwrap_or_default(), "visibleFieldIds")?,
      sort: parse_sort_rules(config.sort.unwrap_or_default())?,
      filter: parse_filter_rules(config.filter.unwrap_or_default())?,
      filter_tree: parse_filter_group(config.filter_tree)?,
      group: parse_group_rule(config.group)?,
      zoom: config.zoom.map(Into::into).unwrap_or_default(),
      dependency_field_id: config
        .dependency_field_id
        .as_ref()
        .map(|id| parse_uuid_id(id, "dependencyFieldId"))
        .transpose()?,
    }));
  }
  if let Some(config) = value.progress {
    return Ok(domain::DatabaseViewConfig::Progress(
      domain::DatabaseProgressViewConfig {
        title_field_id: parse_uuid_id(&config.title_field_id, "titleFieldId")?,
        progress_field_id: parse_uuid_id(&config.progress_field_id, "progressFieldId")?,
        group_field_id: config
          .group_field_id
          .as_ref()
          .map(|id| parse_uuid_id(id, "groupFieldId"))
          .transpose()?,
        visible_field_ids: parse_id_vec(config.visible_field_ids.unwrap_or_default(), "visibleFieldIds")?,
        sort: parse_sort_rules(config.sort.unwrap_or_default())?,
        filter: parse_filter_rules(config.filter.unwrap_or_default())?,
        filter_tree: parse_filter_group(config.filter_tree)?,
      },
    ));
  }
  unreachable!("set_count enforces exactly one view config input")
}

fn parse_field_widths(widths: Vec<DatabaseFieldWidthInput>) -> Result<std::collections::BTreeMap<Uuid, i32>> {
  widths
    .into_iter()
    .map(|width| Ok((parse_uuid_id(&width.field_id, "fieldWidths.fieldId")?, width.width)))
    .collect()
}

fn parse_sort_rules(rules: Vec<DatabaseSortRuleInput>) -> Result<Vec<domain::DatabaseSortRule>> {
  rules
    .into_iter()
    .map(|rule| {
      Ok(domain::DatabaseSortRule {
        field_id: parse_uuid_id(&rule.field_id, "sort.fieldId")?,
        direction: rule.direction.into(),
      })
    })
    .collect()
}

fn parse_filter_rules(rules: Vec<DatabaseFilterRuleInput>) -> Result<Vec<domain::DatabaseFilterRule>> {
  rules
    .into_iter()
    .map(|rule| {
      Ok(domain::DatabaseFilterRule {
        field_id: parse_uuid_id(&rule.field_id, "filter.fieldId")?,
        operator: rule.operator.into(),
        value: parse_filter_value(rule.value)?,
      })
    })
    .collect()
}

fn parse_filter_value(value: DatabaseFilterValueInput) -> Result<domain::DatabaseFilterValue> {
  Ok(match value {
    DatabaseFilterValueInput::None(true) => domain::DatabaseFilterValue::None,
    DatabaseFilterValueInput::None(false) => {
      return Err(database_error(
        "MIX_DATABASE_VIEW_CONFIG_INVALID",
        "the no-value filter variant must be true",
      ));
    }
    DatabaseFilterValueInput::Text(value) => domain::DatabaseFilterValue::Text(value),
    DatabaseFilterValueInput::Number(value) => domain::DatabaseFilterValue::Number(value),
    DatabaseFilterValueInput::NumberRange(value) => {
      domain::DatabaseFilterValue::NumberRange(domain::DatabaseNumberRange {
        start: value.start,
        end: value.end,
      })
    }
    DatabaseFilterValueInput::Currency(value) => domain::DatabaseFilterValue::Currency(domain::DatabaseCurrencyValue {
      amount: value.amount,
      currency_code: value.currency_code,
    }),
    DatabaseFilterValueInput::CurrencyRange(value) => {
      domain::DatabaseFilterValue::CurrencyRange(domain::DatabaseCurrencyRange {
        start: value.start,
        end: value.end,
        currency_code: value.currency_code,
      })
    }
    DatabaseFilterValueInput::Duration(value) => {
      domain::DatabaseFilterValue::Duration(domain::DatabaseDurationValue { minutes: value.minutes })
    }
    DatabaseFilterValueInput::DurationRange(value) => {
      domain::DatabaseFilterValue::DurationRange(domain::DatabaseDurationRange {
        start_minutes: value.start_minutes,
        end_minutes: value.end_minutes,
      })
    }
    DatabaseFilterValueInput::OptionId(value) => domain::DatabaseFilterValue::OptionId(value),
    DatabaseFilterValueInput::Ids(value) => domain::DatabaseFilterValue::Ids(value),
    DatabaseFilterValueInput::Date(value) => domain::DatabaseFilterValue::Date(
      NaiveDate::parse_from_str(&value, "%Y-%m-%d")
        .map_err(|_| database_error("MIX_DATABASE_VIEW_CONFIG_INVALID", "filter date must use YYYY-MM-DD"))?,
    ),
    DatabaseFilterValueInput::DateRange(value) => {
      let parse = |value: Option<String>| {
        value
          .map(|value| {
            NaiveDate::parse_from_str(&value, "%Y-%m-%d")
              .map_err(|_| database_error("MIX_DATABASE_VIEW_CONFIG_INVALID", "filter date must use YYYY-MM-DD"))
          })
          .transpose()
      };
      domain::DatabaseFilterValue::DateRange(domain::DatabaseDateRange {
        start: parse(value.start)?,
        end: parse(value.end)?,
      })
    }
    DatabaseFilterValueInput::Instant(value) => domain::DatabaseFilterValue::Instant(value),
    DatabaseFilterValueInput::InstantRange(value) => {
      domain::DatabaseFilterValue::InstantRange(domain::DatabaseInstantRange {
        start: value.start,
        end: value.end,
      })
    }
    DatabaseFilterValueInput::RelativeDate(value) => domain::DatabaseFilterValue::RelativeDate(value.into()),
    DatabaseFilterValueInput::UserId(value) => {
      domain::DatabaseFilterValue::UserId(parse_uuid_id(&value, "filter.userId")?)
    }
    DatabaseFilterValueInput::UserIds(value) => {
      domain::DatabaseFilterValue::UserIds(parse_id_vec(value, "filter.userIds")?)
    }
    DatabaseFilterValueInput::RelationRowId(value) => {
      domain::DatabaseFilterValue::RelationRowId(parse_uuid_id(&value, "filter.relationRowId")?)
    }
    DatabaseFilterValueInput::RelationRowIds(value) => {
      domain::DatabaseFilterValue::RelationRowIds(parse_id_vec(value, "filter.relationRowIds")?)
    }
    DatabaseFilterValueInput::Boolean(value) => domain::DatabaseFilterValue::Boolean(value),
  })
}

fn parse_filter_group(group: Option<DatabaseFilterGroupInput>) -> Result<Option<domain::DatabaseFilterGroup>> {
  group
    .map(|group| {
      Ok(domain::DatabaseFilterGroup {
        conjunction: group.conjunction.unwrap_or(DatabaseFilterConjunctionType::And).into(),
        rules: parse_filter_rules(group.rules.unwrap_or_default())?,
        groups: group
          .groups
          .unwrap_or_default()
          .into_iter()
          .map(|child| parse_filter_group(Some(child)).map(|group| group.expect("child group is present")))
          .collect::<Result<Vec<_>>>()?,
      })
    })
    .transpose()
}

fn parse_group_rule(rule: Option<DatabaseGroupRuleInput>) -> Result<Option<domain::DatabaseGroupRule>> {
  rule
    .map(|rule| {
      Ok(domain::DatabaseGroupRule {
        field_id: parse_uuid_id(&rule.field_id, "group.fieldId")?,
        descending: rule.descending.unwrap_or(false),
        show_empty_groups: rule.show_empty_groups.unwrap_or(false),
      })
    })
    .transpose()
}

fn map_database_summary(summary: domain::DatabaseSummary) -> DatabaseSummaryObjectType {
  DatabaseSummaryObjectType {
    id: ID::from(summary.id.to_string()),
    system_role: summary.system_role.map(Into::into),
    workspace_id: ID::from(summary.workspace_id.to_string()),
    profile_kind: summary.profile_kind.into(),
    profile_structure_preset: summary.profile_structure_preset,
    title: summary.title,
    description: summary.description,
    deleted_at: summary.deleted_at,
    edit_revision: summary.edit_revision,
    created_at: summary.created_at,
    updated_at: summary.updated_at,
    row_count: summary.row_count,
    field_count: summary.field_count,
    view_count: summary.view_count,
  }
}

fn map_database_page_identity(identity: domain::DatabasePageIdentity) -> DatabasePageIdentityObjectType {
  DatabasePageIdentityObjectType {
    id: ID::from(identity.id.to_string()),
    system_role: identity.system_role.map(Into::into),
    profile_kind: identity.profile_kind.into(),
    title: identity.title,
    description: identity.description,
    deleted_at: identity.deleted_at,
    edit_revision: identity.edit_revision,
    created_at: identity.created_at,
    updated_at: identity.updated_at,
  }
}

pub(crate) fn map_view(view: domain::DatabaseView) -> DatabaseViewObjectType {
  DatabaseViewObjectType {
    id: ID::from(view.id.to_string()),
    database_id: ID::from(view.database_id.to_string()),
    name: view.name,
    view_kind: view.view_kind.into(),
    icon: view.icon.map(map_view_icon),
    config: map_view_config(view.config),
    position: view.position,
    edit_revision: view.edit_revision,
    created_at: view.created_at,
    updated_at: view.updated_at,
  }
}

fn map_sort_rule(rule: domain::DatabaseSortRule) -> DatabaseSortRuleObjectType {
  DatabaseSortRuleObjectType {
    field_id: ID::from(rule.field_id.to_string()),
    direction: rule.direction.into(),
  }
}

fn map_filter_rule(rule: domain::DatabaseFilterRule) -> DatabaseFilterRuleObjectType {
  DatabaseFilterRuleObjectType {
    field_id: ID::from(rule.field_id.to_string()),
    operator: rule.operator.into(),
    value: map_filter_value(rule.value),
  }
}

fn map_filter_value(value: domain::DatabaseFilterValue) -> DatabaseFilterValueObjectType {
  let kind = match &value {
    domain::DatabaseFilterValue::None => "none",
    domain::DatabaseFilterValue::Text(_) => "text",
    domain::DatabaseFilterValue::Number(_) => "number",
    domain::DatabaseFilterValue::NumberRange(_) => "number_range",
    domain::DatabaseFilterValue::Currency(_) => "currency",
    domain::DatabaseFilterValue::CurrencyRange(_) => "currency_range",
    domain::DatabaseFilterValue::Duration(_) => "duration",
    domain::DatabaseFilterValue::DurationRange(_) => "duration_range",
    domain::DatabaseFilterValue::OptionId(_) => "option_id",
    domain::DatabaseFilterValue::Ids(_) => "ids",
    domain::DatabaseFilterValue::Date(_) => "date",
    domain::DatabaseFilterValue::DateRange(_) => "date_range",
    domain::DatabaseFilterValue::Instant(_) => "instant",
    domain::DatabaseFilterValue::InstantRange(_) => "instant_range",
    domain::DatabaseFilterValue::RelativeDate(_) => "relative_date",
    domain::DatabaseFilterValue::UserId(_) => "user_id",
    domain::DatabaseFilterValue::UserIds(_) => "user_ids",
    domain::DatabaseFilterValue::RelationRowId(_) => "relation_row_id",
    domain::DatabaseFilterValue::RelationRowIds(_) => "relation_row_ids",
    domain::DatabaseFilterValue::Boolean(_) => "boolean",
  };
  DatabaseFilterValueObjectType {
    kind: kind.to_string(),
    value: value.reference_json(),
  }
}

fn map_view_icon(icon: domain::DatabaseViewIcon) -> DatabaseViewIconObjectType {
  match icon {
    domain::DatabaseViewIcon::System(icon) => DatabaseViewIconObjectType {
      system: Some(match icon {
        domain::DatabaseViewSystemIcon::Table => DatabaseViewSystemIconType::Table,
        domain::DatabaseViewSystemIcon::Board => DatabaseViewSystemIconType::Board,
        domain::DatabaseViewSystemIcon::List => DatabaseViewSystemIconType::List,
        domain::DatabaseViewSystemIcon::Gallery => DatabaseViewSystemIconType::Gallery,
        domain::DatabaseViewSystemIcon::Calendar => DatabaseViewSystemIconType::Calendar,
        domain::DatabaseViewSystemIcon::Timeline => DatabaseViewSystemIconType::Timeline,
        domain::DatabaseViewSystemIcon::Progress => DatabaseViewSystemIconType::Progress,
        domain::DatabaseViewSystemIcon::Database => DatabaseViewSystemIconType::Database,
        domain::DatabaseViewSystemIcon::Project => DatabaseViewSystemIconType::Project,
      }),
      emoji: None,
    },
    domain::DatabaseViewIcon::Emoji(emoji) => DatabaseViewIconObjectType {
      system: None,
      emoji: Some(emoji),
    },
  }
}

fn map_view_user_state(state: domain::DatabaseViewUserState) -> DatabaseViewUserStateObjectType {
  DatabaseViewUserStateObjectType {
    view_id: ID::from(state.view_id.to_string()),
    search_text: state.search_text,
    sort: state.sort.map(|rules| rules.into_iter().map(map_sort_rule).collect()),
    filter_tree: state.filter_tree.map(map_filter_group),
    field_width_overrides: state.field_width_overrides.into_iter().map(map_field_width).collect(),
    collapsed_group_keys: state.collapsed_group_keys,
    edit_revision: state.edit_revision,
    updated_at: state.updated_at,
  }
}

fn map_effective_view_state(
  state: myoxus_application::database::DatabaseEffectiveViewState,
) -> DatabaseEffectiveViewStateObjectType {
  DatabaseEffectiveViewStateObjectType {
    view_id: ID::from(state.view_id.to_string()),
    saved_sort: state.saved_sort.into_iter().map(map_sort_rule).collect(),
    saved_filter_tree: state.saved_filter_tree.map(map_filter_group),
    personal_state: state.personal_state.map(map_view_user_state),
    effective_sort: state.effective_sort.into_iter().map(map_sort_rule).collect(),
    effective_filter_tree: state.effective_filter_tree.map(map_filter_group),
    search_text: state.search_text,
    effective_field_widths: state.effective_field_widths.into_iter().map(map_field_width).collect(),
    can_edit_shared: state.can_edit_shared,
    can_edit_rows: state.can_edit_rows,
  }
}

fn map_filter_group(group: domain::DatabaseFilterGroup) -> DatabaseFilterGroupObjectType {
  DatabaseFilterGroupObjectType {
    conjunction: group.conjunction.into(),
    rules: group.rules.into_iter().map(map_filter_rule).collect(),
    groups: group.groups.into_iter().map(map_filter_group).collect(),
  }
}

fn map_field_width((field_id, width): (Uuid, i32)) -> DatabaseFieldWidthObjectType {
  DatabaseFieldWidthObjectType {
    field_id: ID::from(field_id.to_string()),
    width,
  }
}

fn map_group_rule(rule: domain::DatabaseGroupRule) -> DatabaseGroupRuleObjectType {
  DatabaseGroupRuleObjectType {
    field_id: ID::from(rule.field_id.to_string()),
    descending: rule.descending,
    show_empty_groups: rule.show_empty_groups,
  }
}

fn map_row_group_summary(
  summary: myoxus_application::database::DatabaseRowGroupSummary,
) -> DatabaseRowGroupSummaryObjectType {
  DatabaseRowGroupSummaryObjectType {
    key: summary.key,
    label: summary.label,
    row_count: summary.row_count,
    groups: summary.groups.into_iter().map(map_row_group_summary).collect(),
  }
}

fn map_progress_summary(
  summary: myoxus_application::database::DatabaseProgressSummary,
) -> DatabaseProgressSummaryObjectType {
  DatabaseProgressSummaryObjectType {
    view_id: ID::from(summary.view_id.to_string()),
    progress_field_id: ID::from(summary.progress_field_id.to_string()),
    group_field_id: summary.group_field_id.map(|id| ID::from(id.to_string())),
    total_count: summary.total_count,
    completed_count: summary.completed_count,
    incomplete_count: summary.incomplete_count,
    blocked_count: summary.blocked_count,
    overdue_count: summary.overdue_count,
    average_progress: summary.average_progress,
    groups: summary
      .groups
      .into_iter()
      .map(|group| DatabaseProgressGroupSummaryObjectType {
        key: group.key,
        label: group.label,
        total_count: group.total_count,
        completed_count: group.completed_count,
        incomplete_count: group.incomplete_count,
        blocked_count: group.blocked_count,
        overdue_count: group.overdue_count,
        average_progress: group.average_progress,
      })
      .collect(),
  }
}

fn map_view_config(config: domain::DatabaseViewConfig) -> DatabaseViewConfigObjectType {
  match config {
    domain::DatabaseViewConfig::Table(config) => DatabaseViewConfigObjectType {
      kind: DatabaseViewKindType::Table,
      table: Some(DatabaseTableViewConfigObjectType {
        title_field_id: ID::from(config.title_field_id.to_string()),
        visible_field_ids: config
          .visible_field_ids
          .into_iter()
          .map(|id| ID::from(id.to_string()))
          .collect(),
        field_widths: config.field_widths.into_iter().map(map_field_width).collect(),
        search_field_ids: config
          .search_field_ids
          .into_iter()
          .map(|id| ID::from(id.to_string()))
          .collect(),
        sort: config.sort.into_iter().map(map_sort_rule).collect(),
        filter: config.filter.into_iter().map(map_filter_rule).collect(),
        filter_tree: config.filter_tree.map(map_filter_group),
        group: config.group.map(map_group_rule),
        subgroup: config.subgroup.map(map_group_rule),
      }),
      kanban: None,
      list: None,
      gallery: None,
      calendar: None,
      timeline: None,
      gantt: None,
      progress: None,
    },
    domain::DatabaseViewConfig::Kanban(config) => DatabaseViewConfigObjectType {
      kind: DatabaseViewKindType::Kanban,
      table: None,
      kanban: Some(DatabaseKanbanViewConfigObjectType {
        title_field_id: ID::from(config.title_field_id.to_string()),
        group_field_id: ID::from(config.group_field_id.to_string()),
        visible_field_ids: config
          .visible_field_ids
          .into_iter()
          .map(|id| ID::from(id.to_string()))
          .collect(),
        cover_field_id: config.cover_field_id.map(|id| ID::from(id.to_string())),
        card_density: config.card_density.into(),
        sort: config.sort.into_iter().map(map_sort_rule).collect(),
        filter: config.filter.into_iter().map(map_filter_rule).collect(),
        filter_tree: config.filter_tree.map(map_filter_group),
      }),
      list: None,
      gallery: None,
      calendar: None,
      timeline: None,
      gantt: None,
      progress: None,
    },
    domain::DatabaseViewConfig::List(config) => DatabaseViewConfigObjectType {
      kind: DatabaseViewKindType::List,
      table: None,
      kanban: None,
      list: Some(DatabaseListViewConfigObjectType {
        title_field_id: ID::from(config.title_field_id.to_string()),
        visible_field_ids: config
          .visible_field_ids
          .into_iter()
          .map(|id| ID::from(id.to_string()))
          .collect(),
        sort: config.sort.into_iter().map(map_sort_rule).collect(),
        filter: config.filter.into_iter().map(map_filter_rule).collect(),
        filter_tree: config.filter_tree.map(map_filter_group),
        density: config.density.into(),
        show_field_labels: config.show_field_labels,
        group: config.group.map(map_group_rule),
        subgroup: config.subgroup.map(map_group_rule),
      }),
      gallery: None,
      calendar: None,
      timeline: None,
      gantt: None,
      progress: None,
    },
    domain::DatabaseViewConfig::Gallery(config) => DatabaseViewConfigObjectType {
      kind: DatabaseViewKindType::Gallery,
      table: None,
      kanban: None,
      list: None,
      gallery: Some(DatabaseGalleryViewConfigObjectType {
        title_field_id: ID::from(config.title_field_id.to_string()),
        visible_field_ids: config
          .visible_field_ids
          .into_iter()
          .map(|id| ID::from(id.to_string()))
          .collect(),
        cover_field_id: config.cover_field_id.map(|id| ID::from(id.to_string())),
        sort: config.sort.into_iter().map(map_sort_rule).collect(),
        filter: config.filter.into_iter().map(map_filter_rule).collect(),
        filter_tree: config.filter_tree.map(map_filter_group),
        card_density: config.card_density.into(),
        show_empty_cover: config.show_empty_cover,
        group: config.group.map(map_group_rule),
        subgroup: config.subgroup.map(map_group_rule),
      }),
      calendar: None,
      timeline: None,
      gantt: None,
      progress: None,
    },
    domain::DatabaseViewConfig::Calendar(config) => DatabaseViewConfigObjectType {
      kind: DatabaseViewKindType::Calendar,
      table: None,
      kanban: None,
      list: None,
      gallery: None,
      calendar: Some(DatabaseCalendarViewConfigObjectType {
        title_field_id: ID::from(config.title_field_id.to_string()),
        date_field_id: ID::from(config.date_field_id.to_string()),
        visible_field_ids: config
          .visible_field_ids
          .into_iter()
          .map(|id| ID::from(id.to_string()))
          .collect(),
        sort: config.sort.into_iter().map(map_sort_rule).collect(),
        filter: config.filter.into_iter().map(map_filter_rule).collect(),
        filter_tree: config.filter_tree.map(map_filter_group),
        date_mode: config.date_mode.into(),
        initial_range: config.initial_range.into(),
        group: config.group.map(map_group_rule),
        subgroup: config.subgroup.map(map_group_rule),
      }),
      timeline: None,
      gantt: None,
      progress: None,
    },
    domain::DatabaseViewConfig::Timeline(config) => DatabaseViewConfigObjectType {
      kind: DatabaseViewKindType::Timeline,
      table: None,
      kanban: None,
      list: None,
      gallery: None,
      calendar: None,
      timeline: Some(DatabaseTimelineViewConfigObjectType {
        title_field_id: ID::from(config.title_field_id.to_string()),
        start_field_id: ID::from(config.start_field_id.to_string()),
        end_field_id: config.end_field_id.map(|id| ID::from(id.to_string())),
        visible_field_ids: config
          .visible_field_ids
          .into_iter()
          .map(|id| ID::from(id.to_string()))
          .collect(),
        sort: config.sort.into_iter().map(map_sort_rule).collect(),
        filter: config.filter.into_iter().map(map_filter_rule).collect(),
        filter_tree: config.filter_tree.map(map_filter_group),
        group_by: config.group_by.into(),
        order: config.order.into(),
        zoom: config.zoom.into(),
      }),
      gantt: None,
      progress: None,
    },
    domain::DatabaseViewConfig::Gantt(config) => DatabaseViewConfigObjectType {
      kind: DatabaseViewKindType::Gantt,
      table: None,
      kanban: None,
      list: None,
      gallery: None,
      calendar: None,
      timeline: None,
      gantt: Some(DatabaseGanttViewConfigObjectType {
        title_field_id: ID::from(config.title_field_id.to_string()),
        start_field_id: ID::from(config.start_field_id.to_string()),
        end_field_id: config.end_field_id.map(|id| ID::from(id.to_string())),
        visible_field_ids: config
          .visible_field_ids
          .into_iter()
          .map(|id| ID::from(id.to_string()))
          .collect(),
        sort: config.sort.into_iter().map(map_sort_rule).collect(),
        filter: config.filter.into_iter().map(map_filter_rule).collect(),
        filter_tree: config.filter_tree.map(map_filter_group),
        group: config.group.map(map_group_rule),
        zoom: config.zoom.into(),
        dependency_field_id: config.dependency_field_id.map(|id| ID::from(id.to_string())),
      }),
      progress: None,
    },
    domain::DatabaseViewConfig::Progress(config) => DatabaseViewConfigObjectType {
      kind: DatabaseViewKindType::Progress,
      table: None,
      kanban: None,
      list: None,
      gallery: None,
      calendar: None,
      timeline: None,
      gantt: None,
      progress: Some(DatabaseProgressViewConfigObjectType {
        title_field_id: ID::from(config.title_field_id.to_string()),
        progress_field_id: ID::from(config.progress_field_id.to_string()),
        group_field_id: config.group_field_id.map(|id| ID::from(id.to_string())),
        visible_field_ids: config
          .visible_field_ids
          .into_iter()
          .map(|id| ID::from(id.to_string()))
          .collect(),
        sort: config.sort.into_iter().map(map_sort_rule).collect(),
        filter: config.filter.into_iter().map(map_filter_rule).collect(),
        filter_tree: config.filter_tree.map(map_filter_group),
      }),
    },
  }
}

// ─── P-DB-24: Activity log ───────────────────────────────────────────────────

#[derive(Debug, SimpleObject, Clone)]
#[graphql(name = "DatabaseActivityEvent")]
pub struct DatabaseActivityEventObjectType {
  pub id: ID,
  pub workspace_id: ID,
  pub database_id: ID,
  pub row_id: Option<ID>,
  pub event_type: String,
  pub actor_user_id: Option<ID>,
  pub actor_display_name: Option<String>,
  pub payload: Json<JsonValue>,
  pub created_at: DateTime<Utc>,
}

#[derive(Debug, InputObject, Clone, Default)]
#[graphql(name = "DatabaseActivityFilterInput")]
pub struct DatabaseActivityFilterInput {
  pub database_id: Option<ID>,
  pub row_id: Option<ID>,
  pub actor_user_id: Option<ID>,
  pub event_types: Option<Vec<String>>,
  pub from: Option<DateTime<Utc>>,
  pub to: Option<DateTime<Utc>>,
}

fn map_activity_event(
  entry: myoxus_domain::database_activity::DatabaseActivityEntry,
) -> DatabaseActivityEventObjectType {
  DatabaseActivityEventObjectType {
    id: ID::from(entry.id.to_string()),
    workspace_id: ID::from(entry.workspace_id.to_string()),
    database_id: ID::from(entry.database_id.to_string()),
    row_id: entry.row_id.map(|id| ID::from(id.to_string())),
    event_type: entry.event_type.as_str().to_string(),
    actor_user_id: entry.actor_user_id.map(|id| ID::from(id.to_string())),
    actor_display_name: entry.actor_display_name,
    payload: Json(entry.payload),
    created_at: entry.created_at,
  }
}

fn parse_activity_event_types(
  raw: Option<Vec<String>>,
) -> Result<Vec<myoxus_domain::database_activity::DatabaseActivityEventType>> {
  let Some(raw) = raw else {
    return Ok(Vec::new());
  };
  raw
    .into_iter()
    .map(|value| {
      value
        .parse::<myoxus_domain::database_activity::DatabaseActivityEventType>()
        .map_err(|()| Error::new(format!("unknown database activity event type: {value}")))
    })
    .collect()
}

fn map_activity_error(error: myoxus_domain::database_activity::DatabaseActivityError) -> Error {
  Error::new(format!("database activity error: {}", error))
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseTaskRelationReason", rename_items = "PascalCase")]
pub enum DatabaseTaskRelationReasonType {
  MissingRole,
  SelfParent,
  SelfBlockedBy,
  DuplicateTargets,
  Cycle,
  WrongRowKind,
  ForeignDatabase,
  IncompatibleRoleConfiguration,
  MultipleParents,
  UnavailableTarget,
}

impl From<domain::DatabaseTaskRelationReason> for DatabaseTaskRelationReasonType {
  fn from(reason: domain::DatabaseTaskRelationReason) -> Self {
    match reason {
      domain::DatabaseTaskRelationReason::MissingRole => Self::MissingRole,
      domain::DatabaseTaskRelationReason::SelfParent => Self::SelfParent,
      domain::DatabaseTaskRelationReason::SelfBlockedBy => Self::SelfBlockedBy,
      domain::DatabaseTaskRelationReason::DuplicateTargets => Self::DuplicateTargets,
      domain::DatabaseTaskRelationReason::Cycle => Self::Cycle,
      domain::DatabaseTaskRelationReason::WrongRowKind => Self::WrongRowKind,
      domain::DatabaseTaskRelationReason::ForeignDatabase => Self::ForeignDatabase,
      domain::DatabaseTaskRelationReason::IncompatibleRoleConfiguration => Self::IncompatibleRoleConfiguration,
      domain::DatabaseTaskRelationReason::MultipleParents => Self::MultipleParents,
      domain::DatabaseTaskRelationReason::UnavailableTarget => Self::UnavailableTarget,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseTaskParent")]
pub struct DatabaseTaskParentObjectType {
  pub available: bool,
  pub field_id: Option<ID>,
  pub parent_row_ids: Vec<ID>,
  pub diagnostics: Vec<DatabaseTaskRelationReasonType>,
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskChildren")]
pub struct DatabaseTaskChildrenObjectType {
  pub available: bool,
  pub field_id: Option<ID>,
  pub diagnostics: Vec<DatabaseTaskRelationReasonType>,
  pub rows: Vec<DatabaseTaskSummaryObjectType>,
  pub total_count: i64,
  pub complete_count: i64,
  pub archived_count: i64,
  pub next_cursor: Option<String>,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseTaskBlockingState", rename_items = "PascalCase")]
pub enum DatabaseTaskBlockingStateType {
  Active,
  Inactive,
  Unavailable,
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskBlockingEntry")]
pub struct DatabaseTaskBlockingEntryObjectType {
  pub row_id: ID,
  pub state: DatabaseTaskBlockingStateType,
  pub task: Option<DatabaseTaskSummaryObjectType>,
}

pub(super) fn map_task_blocking_entry(entry: domain::DatabaseTaskBlockingEntry) -> DatabaseTaskBlockingEntryObjectType {
  DatabaseTaskBlockingEntryObjectType {
    row_id: ID::from(entry.row_id.to_string()),
    state: match entry.state {
      domain::DatabaseTaskBlockingState::Active => DatabaseTaskBlockingStateType::Active,
      domain::DatabaseTaskBlockingState::Inactive => DatabaseTaskBlockingStateType::Inactive,
      domain::DatabaseTaskBlockingState::Unavailable => DatabaseTaskBlockingStateType::Unavailable,
    },
    task: entry.task.map(map_task_summary),
  }
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskBlockedBy")]
pub struct DatabaseTaskBlockedByObjectType {
  pub available: bool,
  pub field_id: Option<ID>,
  pub diagnostics: Vec<DatabaseTaskRelationReasonType>,
  pub retained_row_ids: Vec<ID>,
  pub rows: Vec<DatabaseTaskBlockingEntryObjectType>,
  pub next_cursor: Option<String>,
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskBlocks")]
pub struct DatabaseTaskBlocksObjectType {
  pub available: bool,
  pub field_id: Option<ID>,
  pub diagnostics: Vec<DatabaseTaskRelationReasonType>,
  pub rows: Vec<DatabaseTaskBlockingEntryObjectType>,
  pub next_cursor: Option<String>,
}

#[expect(
  clippy::too_many_arguments,
  reason = "the arguments mirror the stable GraphQL query fields"
)]
pub(crate) async fn list_databases(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  first: Option<i32>,
  offset: Option<i32>,
  search: Option<String>,
  profile_kind: Option<DatabaseProfileKindType>,
  database_ids: Option<Vec<ID>>,
  sort: Option<DatabaseInventorySortType>,
) -> Result<Vec<DatabaseSummaryObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_ids = database_ids
    .map(|ids| {
      ids
        .iter()
        .map(|id| parse_uuid_id::<Uuid>(id, "databaseIds"))
        .collect::<Result<Vec<_>>>()
    })
    .transpose()?;
  let records = service(&state)?
    .views
    .list_databases(
      snapshot.user.id,
      workspace_id,
      page_request(first, offset, state.config.databases.default_rows_per_page),
      domain::DatabaseInventoryFilter {
        search,
        profile_kind: profile_kind.map(Into::into),
        database_ids,
        sort: sort.map(Into::into).unwrap_or_default(),
        lifecycle: domain::DatabaseLifecycleFilter::Active,
      },
    )
    .await
    .map_err(map_database_error)?;
  Ok(records.into_iter().map(map_database_summary).collect())
}

pub(crate) async fn list_trashed_databases(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  first: Option<i32>,
  offset: Option<i32>,
) -> Result<Vec<DatabaseSummaryObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let records = service(&state)?
    .views
    .list_databases(
      snapshot.user.id,
      workspace_id,
      page_request(first, offset, state.config.databases.default_rows_per_page),
      domain::DatabaseInventoryFilter {
        lifecycle: domain::DatabaseLifecycleFilter::Trashed,
        ..Default::default()
      },
    )
    .await
    .map_err(map_database_error)?;
  Ok(records.into_iter().map(map_database_summary).collect())
}

pub(crate) async fn list_database_page_identities(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  first: Option<i32>,
  offset: Option<i32>,
  lifecycle: domain::DatabaseLifecycleFilter,
) -> Result<Vec<DatabasePageIdentityObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let records = service(&state)?
    .views
    .list_database_page_identities(
      snapshot.user.id,
      workspace_id,
      page_request(first, offset, state.config.databases.default_rows_per_page),
      lifecycle,
    )
    .await
    .map_err(map_database_error)?;
  Ok(records.into_iter().map(map_database_page_identity).collect())
}

pub(crate) async fn get_database_summary(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
) -> Result<Option<DatabaseSummaryObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&database_id, "databaseId")?;
  match service(&state)?
    .views
    .get_database_summary(snapshot.user.id, database_id)
    .await
  {
    Ok(summary) if summary.workspace_id == workspace_id => Ok(Some(map_database_summary(summary))),
    Ok(_) => Ok(None),
    Err(error) if error.code == myoxus_application::database::ERR_NOT_FOUND => Ok(None),
    Err(error) => Err(map_database_error(error)),
  }
}

pub(crate) async fn get_database_row(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
  row_id: ID,
  include_trashed: bool,
) -> Result<Option<DatabaseRowRecordObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&database_id, "databaseId")?;
  let row_id = parse_uuid_id(&row_id, "rowId")?;
  let database = match service(&state)?
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
  {
    Ok(record) if record.database.workspace_id == workspace_id => record,
    Ok(_) => return Ok(None),
    Err(error) if error.code == myoxus_application::database::ERR_NOT_FOUND => return Ok(None),
    Err(error) => return Err(map_database_error(error)),
  };
  let Some(record) = service(&state)?
    .views
    .get_row_for_read(snapshot.user.id, database.database.id, row_id, include_trashed)
    .await
    .map_err(map_database_error)?
  else {
    return Ok(None);
  };
  let service = service(&state)?;
  let mut cells = Vec::with_capacity(record.cells.len());
  for cell in record.cells {
    cells.push(map_cell_for_read(&service.editing, &service.views, snapshot.user.id, workspace_id, cell).await?);
  }
  let row = map_row_for_read(&service.editing, snapshot.user.id, workspace_id, record.row).await?;
  Ok(Some(DatabaseRowRecordObjectType {
    row,
    cells,
    cell_revisions: record.cell_revisions.into_iter().map(map_cell_revision).collect(),
    group_keys: record.group_keys,
    redacted: record.redacted,
  }))
}

pub(crate) async fn get_database_view(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
  view_id: ID,
) -> Result<Option<DatabaseViewObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&database_id, "databaseId")?;
  let view_id: Uuid = parse_uuid_id(&view_id, "viewId")?;
  let record = match service(&state)?
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
  {
    Ok(record) if record.database.workspace_id == workspace_id => record,
    Ok(_) => return Ok(None),
    Err(error) if error.code == myoxus_application::database::ERR_NOT_FOUND => return Ok(None),
    Err(error) => return Err(map_database_error(error)),
  };
  Ok(record.views.into_iter().find(|view| view.id == view_id).map(map_view))
}

pub(crate) async fn get_database_effective_view_state(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
  view_id: ID,
) -> Result<DatabaseEffectiveViewStateObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&database_id, "databaseId")?;
  let view_id = parse_uuid_id(&view_id, "viewId")?;
  let record = service(&state)?
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  if record.database.workspace_id != workspace_id {
    return Err(database_error("MIX_DATABASE_NOT_FOUND", "database not found"));
  }
  let effective = service(&state)?
    .views
    .effective_view_state(snapshot.user.id, database_id, view_id)
    .await
    .map_err(map_database_error)?;
  Ok(map_effective_view_state(effective))
}

#[expect(
  clippy::too_many_arguments,
  reason = "the arguments mirror the stable GraphQL query fields"
)]
pub(crate) async fn list_database_rows(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
  first: Option<i32>,
  offset: Option<i32>,
  view_id: Option<ID>,
  search: Option<String>,
  sort: Option<Vec<DatabaseSortRuleInput>>,
  filter: Option<Vec<DatabaseFilterRuleInput>>,
  filter_tree: Option<DatabaseFilterGroupInput>,
  after: Option<String>,
  schedule_window: Option<DatabaseScheduleWindowInput>,
) -> Result<DatabaseRowsPageObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&database_id, "databaseId")?;
  let view_id = view_id.as_ref().map(|id| parse_uuid_id(id, "viewId")).transpose()?;
  let record = service(&state)?
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  if record.database.workspace_id != workspace_id {
    return Err(database_error("MIX_DATABASE_NOT_FOUND", "database not found"));
  }
  let cursor = match after.as_deref().map(str::trim).filter(|raw| !raw.is_empty()) {
    Some(raw) => Some(
      domain::DatabaseRowCursor::decode(raw)
        .ok_or_else(|| database_error("MIX_DATABASE_VALIDATION", "invalid pagination cursor"))?,
    ),
    None => None,
  };
  let page = service(&state)?
    .views
    .list_rows_query(
      snapshot.user.id,
      database_id,
      page_request(first, offset, state.config.databases.default_rows_per_page),
      domain::DatabaseRowsQuery {
        view_id,
        search_field_ids: Vec::new(),
        schedule_window: parse_schedule_window(schedule_window)?,
        sort: parse_sort_rules(sort.unwrap_or_default())?,
        filter: parse_filter_rules(filter.unwrap_or_default())?,
        filter_tree: parse_filter_group(filter_tree)?,
        search,
        first: first.map(|value| value as i64),
        after: cursor,
      },
    )
    .await
    .map_err(map_database_error)?;
  let service = service(&state)?;
  let mut rows = Vec::with_capacity(page.rows.len());
  for record in page.rows {
    let mut cells = Vec::with_capacity(record.cells.len());
    for cell in record.cells {
      cells.push(map_cell_for_read(&service.editing, &service.views, snapshot.user.id, workspace_id, cell).await?);
    }
    let row = map_row_for_read(&service.editing, snapshot.user.id, workspace_id, record.row).await?;
    rows.push(DatabaseRowRecordObjectType {
      row,
      cells,
      cell_revisions: record.cell_revisions.into_iter().map(map_cell_revision).collect(),
      group_keys: record.group_keys,
      redacted: record.redacted,
    });
  }
  Ok(DatabaseRowsPageObjectType {
    rows,
    total_count: page.total_count,
    end_cursor: page.end_cursor,
  })
}

pub(crate) async fn read_database_progress(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
  view_id: ID,
) -> Result<DatabaseProgressSummaryObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&database_id, "databaseId")?;
  let view_id = parse_uuid_id(&view_id, "viewId")?;
  let record = service(&state)?
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  if record.database.workspace_id != workspace_id {
    return Err(database_error("MIX_DATABASE_NOT_FOUND", "database not found"));
  }
  let summary = service(&state)?
    .views
    .progress_summary(snapshot.user.id, database_id, view_id)
    .await
    .map_err(map_database_error)?;
  Ok(map_progress_summary(summary))
}

pub(crate) async fn list_database_row_groups(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
  view_id: ID,
  search: Option<String>,
  schedule_window: Option<DatabaseScheduleWindowInput>,
  locale: Option<String>,
) -> Result<Vec<DatabaseRowGroupSummaryObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&database_id, "databaseId")?;
  let view_id = parse_uuid_id(&view_id, "viewId")?;
  let record = service(&state)?
    .definition
    .get_database(snapshot.user.id, database_id)
    .await
    .map_err(map_database_error)?;
  if record.database.workspace_id != workspace_id {
    return Err(database_error("MIX_DATABASE_NOT_FOUND", "database not found"));
  }
  let groups = service(&state)?
    .views
    .list_row_groups(
      snapshot.user.id,
      database_id,
      view_id,
      search,
      parse_schedule_window(schedule_window)?,
      locale.as_deref(),
    )
    .await
    .map_err(map_database_error)?;
  Ok(groups.into_iter().map(map_row_group_summary).collect())
}

pub(crate) async fn create_database_view(
  ctx: &Context<'_>,
  input: CreateDatabaseViewInput,
) -> Result<DatabaseViewObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let view_kind: domain::DatabaseViewKind = input.view_kind.into();
  let view = service(&state)?
    .views
    .create_view_with_icon(
      snapshot.user.id,
      database_id,
      input.name,
      view_kind,
      input.icon.map(parse_view_icon).transpose()?,
      parse_view_config(input.config)?,
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_view(view))
}

pub(crate) async fn update_database_view(
  ctx: &Context<'_>,
  input: UpdateDatabaseViewInput,
) -> Result<DatabaseViewObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let view_id = parse_uuid_id(&input.view_id, "viewId")?;
  let view_kind = input.view_kind.map(Into::into);
  let icon = match input.icon {
    MaybeUndefined::Undefined => None,
    MaybeUndefined::Null => Some(None),
    MaybeUndefined::Value(icon) => Some(Some(parse_view_icon(icon)?)),
  };
  let config = input.config.map(parse_view_config).transpose()?;
  let view = service(&state)?
    .views
    .update_view_with_icon_precondition(
      snapshot.user.id,
      database_id,
      view_id,
      input.name,
      view_kind,
      icon,
      config,
      input.expected_edit_revision,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_view(view))
}

pub(crate) async fn upsert_database_view_user_state(
  ctx: &Context<'_>,
  input: UpsertDatabaseViewUserStateInput,
) -> Result<DatabaseViewUserStateObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let view_id = parse_uuid_id(&input.view_id, "viewId")?;
  let state = service(&state)?
    .views
    .upsert_view_user_state(
      snapshot.user.id,
      database_id,
      view_id,
      input.search_text.unwrap_or_default(),
      input.sort.map(parse_sort_rules).transpose()?,
      parse_filter_group(input.filter_tree)?,
      parse_field_widths(input.field_width_overrides.unwrap_or_default())?,
      input.collapsed_group_keys.unwrap_or_default(),
      Some(input.expected_edit_revision),
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_view_user_state(state))
}

pub(crate) async fn reset_database_view_user_state(
  ctx: &Context<'_>,
  input: ResetDatabaseViewUserStateInput,
) -> Result<bool> {
  let (state, snapshot) = require_session(ctx).await?;
  service(&state)?
    .views
    .reset_view_user_state(
      snapshot.user.id,
      parse_uuid_id(&input.database_id, "databaseId")?,
      parse_uuid_id(&input.view_id, "viewId")?,
      Some(input.expected_edit_revision),
    )
    .await
    .map_err(map_database_error)?;
  Ok(true)
}

pub(crate) async fn save_database_view_user_state(
  ctx: &Context<'_>,
  input: SaveDatabaseViewUserStateInput,
) -> Result<DatabaseViewObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let view = service(&state)?
    .views
    .save_view_user_state_to_shared_view(
      snapshot.user.id,
      parse_uuid_id(&input.database_id, "databaseId")?,
      parse_uuid_id(&input.view_id, "viewId")?,
      input.expected_view_edit_revision,
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_view(view))
}

pub(crate) async fn delete_database_view(ctx: &Context<'_>, input: DeleteDatabaseViewInput) -> Result<bool> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let view_id = parse_uuid_id(&input.view_id, "viewId")?;
  let replacement_view_id = input
    .replacement_view_id
    .as_ref()
    .map(|id| parse_uuid_id(id, "replacementViewId"))
    .transpose()?;
  service(&state)?
    .views
    .delete_view_with_precondition(
      snapshot.user.id,
      database_id,
      view_id,
      replacement_view_id,
      input.expected_edit_revision,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(true)
}

pub(crate) async fn reorder_database_views(
  ctx: &Context<'_>,
  input: ReorderDatabaseViewsInput,
) -> Result<Vec<DatabaseViewObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = parse_uuid_id(&input.database_id, "databaseId")?;
  let view_ids = input
    .view_ids
    .iter()
    .map(|id| parse_uuid_id(id, "viewIds"))
    .collect::<Result<Vec<_>>>()?;
  let mut expected_edit_revisions = HashMap::new();
  for entry in input.expected_edit_revisions.unwrap_or_default() {
    expected_edit_revisions.insert(parse_uuid_id(&entry.view_id, "viewId")?, entry.expected_edit_revision);
  }
  let views = service(&state)?
    .views
    .reorder_views_with_precondition(
      snapshot.user.id,
      database_id,
      view_ids,
      &expected_edit_revisions,
      input.force.unwrap_or(false),
    )
    .await
    .map_err(map_database_error)?;
  Ok(views.into_iter().map(map_view).collect())
}

pub(crate) async fn database_activity(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  filter: Option<DatabaseActivityFilterInput>,
  skip: Option<i32>,
  take: Option<i32>,
) -> Result<Vec<DatabaseActivityEventObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let filter_input = filter.unwrap_or_default();
  let skip = skip.unwrap_or(0).max(0) as i64;
  let take = take.unwrap_or(50).clamp(1, 500) as i64;
  // Activity storage scopes every result by workspace and the optional
  // Database identifier. Authorize that workspace directly; loading a full
  // Database aggregate here would add no security boundary and would turn a
  // metadata query into an avoidable schema/view read.
  service(&state)?
    .views
    .assert_workspace_read(snapshot.user.id, workspace_id)
    .await
    .map_err(map_database_error)?;
  let filter = myoxus_domain::database_activity::DatabaseActivityFilter {
    workspace_id,
    database_id: filter_input
      .database_id
      .as_ref()
      .map(|id| parse_uuid_id::<Uuid>(id, "databaseId"))
      .transpose()?,
    row_id: filter_input
      .row_id
      .as_ref()
      .map(|id| parse_uuid_id::<Uuid>(id, "rowId"))
      .transpose()?,
    actor_user_id: filter_input
      .actor_user_id
      .as_ref()
      .map(|id| parse_uuid_id::<Uuid>(id, "actorUserId"))
      .transpose()?,
    event_types: parse_activity_event_types(filter_input.event_types)?,
    from: filter_input.from,
    to: filter_input.to,
  };
  let recorder = service(&state)?.effects.activity_recorder();
  let entries = recorder.list(filter, skip, take).await.map_err(map_activity_error)?;
  Ok(entries.into_iter().map(map_activity_event).collect())
}

pub(crate) async fn database_row_activity(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  row_id: ID,
  skip: Option<i32>,
  take: Option<i32>,
) -> Result<Vec<DatabaseActivityEventObjectType>> {
  let activity_filter = DatabaseActivityFilterInput {
    row_id: Some(row_id),
    ..Default::default()
  };
  database_activity(ctx, workspace_id, Some(activity_filter), skip, take).await
}
