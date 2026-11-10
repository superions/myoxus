// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native View definitions, state and actor-safe read models.
use crate::database::*;

/// Saved view variants available for server-backed Databases.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewKind {
  Table,
  Kanban,
  List,
  Gallery,
  Calendar,
  Timeline,
  Gantt,
  Progress,
}

impl DatabaseViewKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Table => "table",
      Self::Kanban => "kanban",
      Self::List => "list",
      Self::Gallery => "gallery",
      Self::Calendar => "calendar",
      Self::Timeline => "timeline",
      Self::Gantt => "gantt",
      Self::Progress => "progress",
    }
  }
}

impl FromStr for DatabaseViewKind {
  type Err = DatabaseDomainError;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "table" => Ok(Self::Table),
      "kanban" => Ok(Self::Kanban),
      "list" => Ok(Self::List),
      "gallery" => Ok(Self::Gallery),
      "calendar" => Ok(Self::Calendar),
      "timeline" => Ok(Self::Timeline),
      "gantt" => Ok(Self::Gantt),
      "progress" => Ok(Self::Progress),
      _ => Err(DatabaseDomainError::InvalidViewKind(value.to_string())),
    }
  }
}

/// Stable sort choices for the workspace Database inventory.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum DatabaseInventorySort {
  /// Most recently changed Databases first.
  #[default]
  UpdatedDesc,
  TitleAsc,
  TitleDesc,
}

/// Lifecycle slice for a workspace Database inventory.
///
/// Normal product reads are active-only. Trashed records are exposed solely
/// through the explicit trash workflow, while `Any` is reserved for lifecycle
/// operations that must resolve a record before restoring or purging it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum DatabaseLifecycleFilter {
  #[default]
  Active,
  Trashed,
  Any,
}

/// Server-side filters for one authorized Database inventory page.
///
/// Favorite IDs are supplied by the established per-user favorite store, but
/// workspace ownership and every returned record remain repository-enforced.
#[derive(Debug, Clone, Default)]
pub struct DatabaseInventoryFilter {
  pub search: Option<String>,
  pub profile_kind: Option<DatabaseProfileKind>,
  pub database_ids: Option<Vec<DatabaseId>>,
  pub sort: DatabaseInventorySort,
  pub lifecycle: DatabaseLifecycleFilter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseSortDirection {
  #[default]
  Asc,
  Desc,
}

impl DatabaseSortDirection {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Asc => "asc",
      Self::Desc => "desc",
    }
  }

  pub fn is_descending(self) -> bool {
    self == Self::Desc
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSortRule {
  pub field_id: DatabaseFieldId,
  pub direction: DatabaseSortDirection,
}

/// Exhaustive operator set shared by persistence, GraphQL and SQL planning.
/// Unknown values fail deserialization; persisted aliases are canonicalized.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseFilterOperator {
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

impl DatabaseFilterOperator {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Empty => "empty",
      Self::NotEmpty => "not_empty",
      Self::Contains => "contains",
      Self::DoesNotContain => "does_not_contain",
      Self::ContainsAll => "contains_all",
      Self::Is => "is",
      Self::IsNot => "is_not",
      Self::StartsWith => "starts_with",
      Self::EndsWith => "ends_with",
      Self::Equals => "equals",
      Self::NotEquals => "not_equals",
      Self::Greater => "greater",
      Self::Less => "less",
      Self::GreaterOrEqual => "greater_or_equal",
      Self::LessOrEqual => "less_or_equal",
      Self::Between => "between",
      Self::AnyOf => "any_of",
      Self::NoneOf => "none_of",
      Self::GroupIs => "group_is",
      Self::GroupIsNot => "group_is_not",
      Self::GroupAnyOf => "group_any_of",
      Self::GroupNoneOf => "group_none_of",
      Self::Checked => "checked",
      Self::Unchecked => "unchecked",
      Self::ContainsUser => "contains_user",
      Self::DoesNotContainUser => "does_not_contain_user",
      Self::CurrentUser => "current_user",
      Self::ContainsRow => "contains_row",
      Self::DoesNotContainRow => "does_not_contain_row",
      Self::Before => "before",
      Self::After => "after",
      Self::On => "on",
      Self::Relative => "relative",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseRelativeDatePreset {
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseNumberRange {
  pub start: Option<f64>,
  pub end: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCurrencyRange {
  pub start: Option<f64>,
  pub end: Option<f64>,
  pub currency_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDurationRange {
  pub start_minutes: Option<i64>,
  pub end_minutes: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDateRange {
  pub start: Option<NaiveDate>,
  pub end: Option<NaiveDate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInstantRange {
  pub start: Option<DateTime<Utc>>,
  pub end: Option<DateTime<Utc>>,
}

/// Typed filter operand persisted in saved views and portable snapshots.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum DatabaseFilterValue {
  None,
  Text(String),
  Number(f64),
  NumberRange(DatabaseNumberRange),
  Currency(DatabaseCurrencyValue),
  CurrencyRange(DatabaseCurrencyRange),
  Duration(DatabaseDurationValue),
  DurationRange(DatabaseDurationRange),
  OptionId(String),
  Ids(Vec<String>),
  Date(NaiveDate),
  DateRange(DatabaseDateRange),
  Instant(DateTime<Utc>),
  InstantRange(DatabaseInstantRange),
  RelativeDate(DatabaseRelativeDatePreset),
  UserId(UserId),
  UserIds(Vec<UserId>),
  RelationRowId(DatabaseRowId),
  RelationRowIds(Vec<DatabaseRowId>),
  Boolean(bool),
}

impl DatabaseFilterValue {
  /// JSON-shaped projection used only by semantic reference evaluators and
  /// diagnostics. Persistence and API boundaries serialize the tagged enum.
  pub fn reference_json(&self) -> Value {
    match self {
      Self::None => Value::Null,
      Self::Text(value) | Self::OptionId(value) => Value::String(value.clone()),
      Self::Number(value) => serde_json::json!(value),
      Self::NumberRange(value) => serde_json::json!({ "start": value.start, "end": value.end }),
      Self::Currency(value) => serde_json::json!({ "amount": value.amount, "currencyCode": value.currency_code }),
      Self::CurrencyRange(value) => serde_json::json!({
        "start": value.start,
        "end": value.end,
        "currencyCode": value.currency_code,
      }),
      Self::Duration(value) => serde_json::json!({ "minutes": value.minutes }),
      Self::DurationRange(value) => serde_json::json!({
        "start": value.start_minutes,
        "end": value.end_minutes,
      }),
      Self::Ids(values) => serde_json::json!(values),
      Self::Date(value) => Value::String(value.to_string()),
      Self::DateRange(value) => serde_json::json!({ "start": value.start, "end": value.end }),
      Self::Instant(value) => Value::String(value.to_rfc3339()),
      Self::InstantRange(value) => serde_json::json!({ "start": value.start, "end": value.end }),
      Self::RelativeDate(value) => serde_json::json!({ "preset": value }),
      Self::UserId(value) => Value::String(value.to_string()),
      Self::UserIds(values) => serde_json::json!(values),
      Self::RelationRowId(value) => Value::String(value.to_string()),
      Self::RelationRowIds(values) => serde_json::json!(values),
      Self::Boolean(value) => Value::Bool(*value),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFilterRule {
  pub field_id: DatabaseFieldId,
  pub operator: DatabaseFilterOperator,
  pub value: DatabaseFilterValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseFilterConjunction {
  #[default]
  And,
  Or,
}

impl DatabaseFilterConjunction {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::And => "and",
      Self::Or => "or",
    }
  }
}

/// Saved-view filter tree shared by all server-backed view kinds.
///
/// `rules` are leaf predicates and `groups` are nested children. Flat `filter`
/// arrays remain a concise AND shorthand; both forms use typed leaves.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFilterGroup {
  #[serde(default)]
  pub conjunction: DatabaseFilterConjunction,
  #[serde(default)]
  pub rules: Vec<DatabaseFilterRule>,
  #[serde(default)]
  pub groups: Vec<DatabaseFilterGroup>,
}

impl DatabaseFilterGroup {
  pub fn is_empty(&self) -> bool {
    self.rules.is_empty() && self.groups.iter().all(Self::is_empty)
  }
}

/// Shared grouping axis for saved view configs.
///
/// This is intentionally a persisted view contract, not transient UI state.
/// Web/Electron may expand/collapse groups locally, but the fields that define
/// groups and whether empty groups are visible are shared with the view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseGroupRule {
  pub field_id: DatabaseFieldId,
  #[serde(default)]
  pub descending: bool,
  #[serde(default)]
  pub show_empty_groups: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTableViewConfig {
  pub title_field_id: DatabaseFieldId,
  #[serde(default)]
  pub visible_field_ids: Vec<DatabaseFieldId>,
  #[serde(default)]
  pub field_widths: BTreeMap<DatabaseFieldId, i32>,
  #[serde(default)]
  pub search_field_ids: Vec<DatabaseFieldId>,
  #[serde(default)]
  pub sort: Vec<DatabaseSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseFilterGroup>,
  #[serde(default)]
  pub group: Option<DatabaseGroupRule>,
  #[serde(default)]
  pub subgroup: Option<DatabaseGroupRule>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseKanbanViewConfig {
  pub title_field_id: DatabaseFieldId,
  pub group_field_id: DatabaseFieldId,
  #[serde(default)]
  pub visible_field_ids: Vec<DatabaseFieldId>,
  pub cover_field_id: Option<DatabaseFieldId>,
  #[serde(default)]
  pub card_density: DatabaseCardDensity,
  #[serde(default)]
  pub sort: Vec<DatabaseSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseFilterGroup>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseCardDensity {
  Compact,
  #[default]
  Default,
  Comfortable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseListDensity {
  Compact,
  #[default]
  Default,
  Comfortable,
}

impl DatabaseListDensity {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Compact => "compact",
      Self::Default => "default",
      Self::Comfortable => "comfortable",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseGalleryCardDensity {
  Compact,
  #[default]
  Default,
  Large,
}

impl DatabaseGalleryCardDensity {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Compact => "compact",
      Self::Default => "default",
      Self::Large => "large",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseCalendarDateMode {
  Day,
  Week,
  #[default]
  Month,
  Year,
}

impl DatabaseCalendarDateMode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Day => "day",
      Self::Week => "week",
      Self::Month => "month",
      Self::Year => "year",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseCalendarInitialRange {
  Today,
  CurrentWeek,
  #[default]
  CurrentMonth,
  CurrentYear,
}

impl DatabaseCalendarInitialRange {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Today => "today",
      Self::CurrentWeek => "current_week",
      Self::CurrentMonth => "current_month",
      Self::CurrentYear => "current_year",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseTimelineGroupBy {
  None,
  Day,
  Week,
  #[default]
  Month,
}

impl DatabaseTimelineGroupBy {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::None => "none",
      Self::Day => "day",
      Self::Week => "week",
      Self::Month => "month",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseTimelineOrder {
  #[default]
  Asc,
  Desc,
}

impl DatabaseTimelineOrder {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Asc => "asc",
      Self::Desc => "desc",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseTimelineZoom {
  Day,
  Week,
  #[default]
  Month,
  Quarter,
  Year,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseListViewConfig {
  pub title_field_id: DatabaseFieldId,
  #[serde(default)]
  pub visible_field_ids: Vec<DatabaseFieldId>,
  #[serde(default)]
  pub sort: Vec<DatabaseSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseFilterGroup>,
  #[serde(default)]
  pub density: DatabaseListDensity,
  #[serde(default = "default_show_field_labels")]
  pub show_field_labels: bool,
  #[serde(default)]
  pub group: Option<DatabaseGroupRule>,
  #[serde(default)]
  pub subgroup: Option<DatabaseGroupRule>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseGalleryViewConfig {
  pub title_field_id: DatabaseFieldId,
  #[serde(default)]
  pub visible_field_ids: Vec<DatabaseFieldId>,
  pub cover_field_id: Option<DatabaseFieldId>,
  #[serde(default)]
  pub sort: Vec<DatabaseSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseFilterGroup>,
  #[serde(default)]
  pub card_density: DatabaseGalleryCardDensity,
  #[serde(default = "default_show_empty_cover")]
  pub show_empty_cover: bool,
  #[serde(default)]
  pub group: Option<DatabaseGroupRule>,
  #[serde(default)]
  pub subgroup: Option<DatabaseGroupRule>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCalendarViewConfig {
  pub title_field_id: DatabaseFieldId,
  pub date_field_id: DatabaseFieldId,
  #[serde(default)]
  pub visible_field_ids: Vec<DatabaseFieldId>,
  #[serde(default)]
  pub sort: Vec<DatabaseSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseFilterGroup>,
  #[serde(default)]
  pub date_mode: DatabaseCalendarDateMode,
  #[serde(default)]
  pub initial_range: DatabaseCalendarInitialRange,
  #[serde(default)]
  pub group: Option<DatabaseGroupRule>,
  #[serde(default)]
  pub subgroup: Option<DatabaseGroupRule>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTimelineViewConfig {
  pub title_field_id: DatabaseFieldId,
  pub start_field_id: DatabaseFieldId,
  pub end_field_id: Option<DatabaseFieldId>,
  #[serde(default)]
  pub visible_field_ids: Vec<DatabaseFieldId>,
  #[serde(default)]
  pub sort: Vec<DatabaseSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseFilterGroup>,
  #[serde(default)]
  pub group_by: DatabaseTimelineGroupBy,
  #[serde(default)]
  pub order: DatabaseTimelineOrder,
  #[serde(default)]
  pub zoom: DatabaseTimelineZoom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseGanttViewConfig {
  pub title_field_id: DatabaseFieldId,
  pub start_field_id: DatabaseFieldId,
  pub end_field_id: Option<DatabaseFieldId>,
  #[serde(default)]
  pub visible_field_ids: Vec<DatabaseFieldId>,
  #[serde(default)]
  pub sort: Vec<DatabaseSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseFilterGroup>,
  #[serde(default)]
  pub group: Option<DatabaseGroupRule>,
  #[serde(default)]
  pub zoom: DatabaseTimelineZoom,
  pub dependency_field_id: Option<DatabaseFieldId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseProgressViewConfig {
  pub title_field_id: DatabaseFieldId,
  pub progress_field_id: DatabaseFieldId,
  pub group_field_id: Option<DatabaseFieldId>,
  #[serde(default)]
  pub visible_field_ids: Vec<DatabaseFieldId>,
  #[serde(default)]
  pub sort: Vec<DatabaseSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseFilterGroup>,
}

pub(in crate::database) fn default_show_field_labels() -> bool {
  true
}

pub(in crate::database) fn default_show_empty_cover() -> bool {
  true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseViewConfig {
  Table(DatabaseTableViewConfig),
  Kanban(DatabaseKanbanViewConfig),
  List(DatabaseListViewConfig),
  Gallery(DatabaseGalleryViewConfig),
  Calendar(DatabaseCalendarViewConfig),
  Timeline(DatabaseTimelineViewConfig),
  Gantt(DatabaseGanttViewConfig),
  Progress(DatabaseProgressViewConfig),
}

impl DatabaseViewConfig {
  pub fn matches_view_kind(&self, kind: DatabaseViewKind) -> bool {
    matches!(
      (self, kind),
      (Self::Table(_), DatabaseViewKind::Table)
        | (Self::Kanban(_), DatabaseViewKind::Kanban)
        | (Self::List(_), DatabaseViewKind::List)
        | (Self::Gallery(_), DatabaseViewKind::Gallery)
        | (Self::Calendar(_), DatabaseViewKind::Calendar)
        | (Self::Timeline(_), DatabaseViewKind::Timeline)
        | (Self::Gantt(_), DatabaseViewKind::Gantt)
        | (Self::Progress(_), DatabaseViewKind::Progress)
    )
  }

  pub fn sort_rules(&self) -> &[DatabaseSortRule] {
    match self {
      Self::Table(config) => &config.sort,
      Self::Kanban(config) => &config.sort,
      Self::List(config) => &config.sort,
      Self::Gallery(config) => &config.sort,
      Self::Calendar(config) => &config.sort,
      Self::Timeline(config) => &config.sort,
      Self::Gantt(config) => &config.sort,
      Self::Progress(config) => &config.sort,
    }
  }

  pub fn filter_rules(&self) -> &[DatabaseFilterRule] {
    match self {
      Self::Table(config) => &config.filter,
      Self::Kanban(config) => &config.filter,
      Self::List(config) => &config.filter,
      Self::Gallery(config) => &config.filter,
      Self::Calendar(config) => &config.filter,
      Self::Timeline(config) => &config.filter,
      Self::Gantt(config) => &config.filter,
      Self::Progress(config) => &config.filter,
    }
  }

  pub fn filter_tree(&self) -> Option<&DatabaseFilterGroup> {
    match self {
      Self::Table(config) => config.filter_tree.as_ref(),
      Self::Kanban(config) => config.filter_tree.as_ref(),
      Self::List(config) => config.filter_tree.as_ref(),
      Self::Gallery(config) => config.filter_tree.as_ref(),
      Self::Calendar(config) => config.filter_tree.as_ref(),
      Self::Timeline(config) => config.filter_tree.as_ref(),
      Self::Gantt(config) => config.filter_tree.as_ref(),
      Self::Progress(config) => config.filter_tree.as_ref(),
    }
  }

  /// Return the one effective saved filter tree used by personal-state
  /// projection. Flat saved rules and a nested tree are both conjunctive in
  /// the query contract, so this conversion preserves their exact semantics
  /// without exposing two competing editable filter representations.
  pub fn effective_filter_tree(&self) -> Option<DatabaseFilterGroup> {
    let rules = self.filter_rules().to_vec();
    let tree = self.filter_tree().filter(|group| !group.is_empty()).cloned();
    match (rules.is_empty(), tree) {
      (true, None) => None,
      (true, Some(tree)) => Some(tree),
      (false, None) => Some(DatabaseFilterGroup {
        conjunction: DatabaseFilterConjunction::And,
        rules,
        groups: Vec::new(),
      }),
      (false, Some(tree)) => Some(DatabaseFilterGroup {
        conjunction: DatabaseFilterConjunction::And,
        rules,
        groups: vec![tree],
      }),
    }
  }

  pub fn replace_query_state(&mut self, sort: Vec<DatabaseSortRule>, filter_tree: Option<DatabaseFilterGroup>) {
    match self {
      Self::Table(config) => {
        config.sort = sort;
        config.filter.clear();
        config.filter_tree = filter_tree;
      }
      Self::Kanban(config) => {
        config.sort = sort;
        config.filter.clear();
        config.filter_tree = filter_tree;
      }
      Self::List(config) => {
        config.sort = sort;
        config.filter.clear();
        config.filter_tree = filter_tree;
      }
      Self::Gallery(config) => {
        config.sort = sort;
        config.filter.clear();
        config.filter_tree = filter_tree;
      }
      Self::Calendar(config) => {
        config.sort = sort;
        config.filter.clear();
        config.filter_tree = filter_tree;
      }
      Self::Timeline(config) => {
        config.sort = sort;
        config.filter.clear();
        config.filter_tree = filter_tree;
      }
      Self::Gantt(config) => {
        config.sort = sort;
        config.filter.clear();
        config.filter_tree = filter_tree;
      }
      Self::Progress(config) => {
        config.sort = sort;
        config.filter.clear();
        config.filter_tree = filter_tree;
      }
    }
  }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRowsQuery {
  pub view_id: Option<DatabaseViewId>,
  #[serde(default)]
  pub sort: Vec<DatabaseSortRule>,
  #[serde(default)]
  pub filter: Vec<DatabaseFilterRule>,
  #[serde(default)]
  pub filter_tree: Option<DatabaseFilterGroup>,
  pub search: Option<String>,
  /// Server-resolved searchable field scope for the selected saved View.
  /// GraphQL clients provide `view_id`; the application fills this list after
  /// validating the shared view config.
  #[serde(default)]
  pub search_field_ids: Vec<DatabaseFieldId>,
  /// Optional visible Calendar/Timeline/Gantt window. It composes with the same
  /// effective-view filters, search, sorting and cursor pagination.
  #[serde(default)]
  pub schedule_window: Option<DatabaseScheduleWindow>,
  /// Cursor pagination (P-DB-25). `first` clamps at 500; `after` is an
  /// opaque base64 cursor that resolves to `(position, id)`.
  #[serde(default)]
  pub first: Option<i64>,
  #[serde(default)]
  pub after: Option<DatabaseRowCursor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseScheduleWindow {
  pub field_id: DatabaseFieldId,
  #[serde(default)]
  pub end_field_id: Option<DatabaseFieldId>,
  pub start: DateTime<Utc>,
  pub end: DateTime<Utc>,
  /// Server-resolved all-day calendar projection for the selected View. This
  /// read policy is neither a public input nor a persisted configuration field.
  #[serde(skip)]
  pub all_day_calendar: bool,
}

/// Cursor for stable, offset-free row pagination (P-DB-25).
///
/// `(position, id)` is the canonical ordering key used by both the SQL
/// backend and the in-memory fallback. The wire form is base64(JSON) so the
/// client cannot accidentally construct a cursor pointing outside its
/// workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseRowCursor {
  pub position: i32,
  pub id: DatabaseRowId,
}

impl DatabaseRowCursor {
  /// Encode the cursor as `position|id`. The format is intentionally
  /// human-readable for debug logs; clients must not depend on it as
  /// stable across major versions.
  pub fn encode(&self) -> String {
    format!("{}|{}", self.position, self.id)
  }

  pub fn decode(raw: &str) -> Option<Self> {
    let (pos, id) = raw.split_once('|')?;
    let position: i32 = pos.parse().ok()?;
    let id = id.parse::<DatabaseRowId>().ok()?;
    Some(Self { position, id })
  }
}

/// Filter for database row search (P-DB-25).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseSearchFilter {
  pub workspace_id: WorkspaceId,
  pub database_id: Option<DatabaseId>,
  pub query: String,
  #[serde(default)]
  pub first: Option<i64>,
  /// Offset in ranked source order, independent of the unused cursor field.
  #[serde(default)]
  pub offset: Option<i64>,
  #[serde(default)]
  pub after: Option<DatabaseRowCursor>,
}

/// Single hit returned by database search (P-DB-25).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseSearchHit {
  pub row_id: DatabaseRowId,
  pub database_id: DatabaseId,
  pub title: String,
  pub snippet: Option<String>,
  /// True when the canonical Row currently has an associated content
  /// document. No document title or body is copied into Row search.
  pub has_content_document: bool,
  pub updated_at: DateTime<Utc>,
}

/// Compact, non-persisted read model for Database discovery and inventories.
///
/// The summary is assembled from the canonical Database tables. It excludes
/// schema, view configuration, roles and Cells so identity-only consumers
/// cannot accidentally turn a list into full aggregate loading.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSummary {
  pub system_role: Option<DatabaseSystemRole>,
  pub id: DatabaseId,
  pub workspace_id: WorkspaceId,
  pub profile_kind: DatabaseProfileKind,
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

/// Count-free Database identity used by mixed workspace page inventories.
///
/// This projection deliberately contains only fields needed to render and
/// operate a Database as a page. Consumers that display aggregate counts use
/// [`DatabaseSummary`] instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabasePageIdentity {
  #[serde(default)]
  pub system_role: Option<DatabaseSystemRole>,
  pub id: DatabaseId,
  pub profile_kind: DatabaseProfileKind,
  pub title: String,
  pub description: Option<String>,
  pub deleted_at: Option<DateTime<Utc>>,
  pub edit_revision: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// One lightweight Database inventory page read at a durable revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabasePageIdentitySnapshot {
  pub revision: i64,
  pub rows: Vec<DatabasePageIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseView {
  pub id: DatabaseViewId,
  pub database_id: DatabaseId,
  pub name: String,
  pub view_kind: DatabaseViewKind,
  pub icon: Option<DatabaseViewIcon>,
  pub config: DatabaseViewConfig,
  pub position: i32,
  /// Monotonic optimistic-concurrency token for this saved view.
  pub edit_revision: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewSystemIcon {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum DatabaseViewIcon {
  System(DatabaseViewSystemIcon),
  Emoji(String),
}

impl DatabaseViewIcon {
  pub fn validate(&self) -> Result<(), DatabaseDomainError> {
    if let Self::Emoji(value) = self
      && (value.trim().is_empty() || value.graphemes(true).count() != 1)
    {
      return Err(DatabaseDomainError::Validation(
        "database view emoji must contain exactly one Unicode grapheme".to_string(),
      ));
    }
    Ok(())
  }
}

/// Actor-owned exploratory overrides for one shared saved view.
///
/// Focus, selection, open overlays, Side Peek and scroll position are
/// intentionally absent because they are interaction state, not preferences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseViewUserState {
  pub view_id: DatabaseViewId,
  pub user_id: UserId,
  pub search_text: String,
  pub sort: Option<Vec<DatabaseSortRule>>,
  pub filter_tree: Option<DatabaseFilterGroup>,
  pub field_width_overrides: BTreeMap<DatabaseFieldId, i32>,
  pub collapsed_group_keys: Vec<String>,
  pub edit_revision: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFilteredRowsPage {
  pub rows: Vec<DatabaseRowRecord>,
  pub total_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRowGroupCount {
  pub key: String,
  pub subgroup_key: Option<String>,
  pub row_count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseProgressAggregateCount {
  pub group_key: Option<String>,
  pub group_label: Option<String>,
  pub total_count: i64,
  pub completed_count: i64,
  pub blocked_count: i64,
  pub overdue_count: i64,
  pub progress_value_count: i64,
  pub average_progress: Option<f64>,
}

/// Server-owned inputs for one Progress aggregation.
///
/// Keeping the semantic Project roles in this contract prevents repository
/// implementations from rediscovering fields by display name and keeps every
/// aggregate on the same ACL-filtered row-query plan.
#[derive(Debug, Clone)]
pub struct DatabaseProgressAggregateSpec {
  pub progress_field_id: DatabaseFieldId,
  pub status_field_id: Option<DatabaseFieldId>,
  pub complete_status_option_ids: Vec<String>,
  pub group_field_id: Option<DatabaseFieldId>,
  pub blocked_by_field_id: Option<DatabaseFieldId>,
  pub due_field: Option<(DatabaseFieldId, DatabaseFieldType)>,
  pub row_kind: Option<DatabaseRowKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseViewRole {
  pub database_id: DatabaseId,
  pub profile_kind: DatabaseProfileKind,
  pub role_key: String,
  pub view_id: DatabaseViewId,
  pub required: bool,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

impl DatabaseViewRole {
  pub fn project_role_key(view_kind: DatabaseViewKind) -> String {
    format!("project.{}", view_kind.as_str())
  }

  pub fn expected_kind_for_role_key(role_key: &str) -> Option<DatabaseViewKind> {
    role_key
      .strip_prefix("project.")
      .and_then(|value| DatabaseViewKind::from_str(value).ok())
  }

  pub fn expected_view_kind(&self) -> Option<DatabaseViewKind> {
    Self::expected_kind_for_role_key(&self.role_key)
  }
}
