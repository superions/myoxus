// SPDX-License-Identifier: AGPL-3.0-or-later
//! Validation of native saved and personal View query semantics.
use super::*;

pub fn validate_view_config(
  view_kind: DatabaseViewKind,
  config: &DatabaseViewConfig,
  fields: &[DatabaseField],
  max_fields_per_database: usize,
) -> DatabaseResult<()> {
  if !config.matches_view_kind(view_kind) {
    return Err(DatabaseServiceError::new(
      ERR_VIEW_KIND_INVALID,
      "view config kind does not match view kind",
    ));
  }
  let field_map = fields.iter().map(|field| (field.id, field)).collect::<HashMap<_, _>>();
  let validate_title_field = |id: DatabaseFieldId| -> DatabaseResult<()> {
    if field_map.contains_key(&id) {
      Ok(())
    } else {
      Err(DatabaseServiceError::new(
        ERR_VIEW_CONFIG_INVALID,
        "title field is unknown",
      ))
    }
  };
  let validate_field_ids = |ids: &[DatabaseFieldId]| -> DatabaseResult<()> {
    if ids.len() > fields.len() || ids.len() > max_fields_per_database {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_CONFIG_INVALID,
        "view references too many visible fields",
      ));
    }
    let mut seen = HashSet::new();
    for id in ids {
      if !field_map.contains_key(id) || !seen.insert(*id) {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_CONFIG_INVALID,
          "view references an unknown or duplicate field id",
        ));
      }
    }
    Ok(())
  };
  let validate_referenced_field_ids = |ids: Vec<DatabaseFieldId>| -> DatabaseResult<()> {
    for id in ids {
      if !field_map.contains_key(&id) {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_CONFIG_INVALID,
          "view references an unknown field id",
        ));
      }
    }
    Ok(())
  };
  let validate_filter_group = |group: &DatabaseFilterGroup| -> DatabaseResult<()> {
    fn validate_group(
      group: &DatabaseFilterGroup,
      field_map: &HashMap<DatabaseFieldId, &DatabaseField>,
      depth: usize,
    ) -> DatabaseResult<()> {
      if depth > 4 {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_CONFIG_INVALID,
          "view filter tree is too deeply nested",
        ));
      }
      if group.rules.is_empty() && group.groups.is_empty() {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_CONFIG_INVALID,
          "view filter tree contains an empty group",
        ));
      }
      for rule in &group.rules {
        let Some(field) = field_map.get(&rule.field_id) else {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_CONFIG_INVALID,
            "view filter references an unknown field id",
          ));
        };
        validate_filter_rule(field, rule)?;
      }
      for child in &group.groups {
        validate_group(child, field_map, depth + 1)?;
      }
      Ok(())
    }
    validate_group(group, &field_map, 0)
  };
  let validate_sort_and_filter = |sort: &[DatabaseSortRule],
                                  filter: &[DatabaseFilterRule],
                                  filter_tree: Option<&DatabaseFilterGroup>|
   -> DatabaseResult<()> {
    validate_referenced_field_ids(sort.iter().map(|rule| rule.field_id).collect())?;
    if sort.iter().any(|rule| {
      field_map
        .get(&rule.field_id)
        .is_none_or(|field| !field.field_type.supports_saved_sort())
    }) {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_CONFIG_INVALID,
        "view sort references a field without typed ordering semantics",
      ));
    }
    for rule in filter {
      let Some(field) = field_map.get(&rule.field_id) else {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_CONFIG_INVALID,
          "view references an unknown field id",
        ));
      };
      validate_filter_rule(field, rule)?;
    }
    if let Some(filter_tree) = filter_tree {
      validate_filter_group(filter_tree)?;
    }
    Ok(())
  };
  let validate_date_field = |id: DatabaseFieldId| -> DatabaseResult<()> {
    let Some(field) = field_map.get(&id) else {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_DATE_FIELD_REQUIRED,
        "calendar and timeline views require a date field",
      ));
    };
    if !matches!(
      field.field_type,
      DatabaseFieldType::Date
        | DatabaseFieldType::DateTime
        | DatabaseFieldType::CreatedTime
        | DatabaseFieldType::UpdatedTime
    ) {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_DATE_FIELD_REQUIRED,
        "calendar and timeline views require a date or time projection field",
      ));
    }
    Ok(())
  };
  let validate_group_rule = |rule: &DatabaseGroupRule| -> DatabaseResult<()> {
    let Some(field) = field_map.get(&rule.field_id) else {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_CONFIG_INVALID,
        "view group references an unknown field id",
      ));
    };
    if !matches!(
      field.field_type,
      DatabaseFieldType::Select
        | DatabaseFieldType::Status
        | DatabaseFieldType::MultiSelect
        | DatabaseFieldType::Tags
        | DatabaseFieldType::User
        | DatabaseFieldType::Users
        | DatabaseFieldType::Date
        | DatabaseFieldType::DateTime
        | DatabaseFieldType::CreatedTime
        | DatabaseFieldType::UpdatedTime
        | DatabaseFieldType::Checkbox
    ) {
      return Err(DatabaseServiceError::new(
        ERR_VIEW_CONFIG_INVALID,
        "view group field type is not groupable",
      ));
    }
    Ok(())
  };
  let validate_group_rules =
    |group: &Option<DatabaseGroupRule>, subgroup: &Option<DatabaseGroupRule>| -> DatabaseResult<()> {
      if let Some(subgroup) = subgroup {
        if group.is_none() {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_CONFIG_INVALID,
            "view subgroup requires a primary group",
          ));
        }
        validate_group_rule(subgroup)?;
      }
      if let Some(group) = group {
        validate_group_rule(group)?;
        if subgroup
          .as_ref()
          .is_some_and(|subgroup| subgroup.field_id == group.field_id)
        {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_CONFIG_INVALID,
            "view group and subgroup cannot reference the same field",
          ));
        }
      }
      Ok(())
    };
  match config {
    DatabaseViewConfig::Table(config) => {
      validate_title_field(config.title_field_id)?;
      validate_field_ids(&config.visible_field_ids)?;
      validate_referenced_field_ids(config.field_widths.keys().copied().collect())?;
      validate_referenced_field_ids(config.search_field_ids.clone())?;
      for field_id in &config.search_field_ids {
        let field = field_map[field_id];
        if !field.field_type.supports_server_search() {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_CONFIG_INVALID,
            "table search fields must be server-searchable",
          ));
        }
      }
      validate_sort_and_filter(&config.sort, &config.filter, config.filter_tree.as_ref())?;
      validate_group_rules(&config.group, &config.subgroup)?;
      for width in config.field_widths.values() {
        if *width <= 0 {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_CONFIG_INVALID,
            "field widths cannot be negative",
          ));
        }
      }
    }
    DatabaseViewConfig::Kanban(config) => {
      validate_title_field(config.title_field_id)?;
      let Some(group_field) = field_map.get(&config.group_field_id) else {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_CONFIG_INVALID,
          "group field is unknown",
        ));
      };
      if !matches!(
        group_field.field_type,
        DatabaseFieldType::Select | DatabaseFieldType::Status
      ) {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_CONFIG_INVALID,
          "kanban groupFieldId must point to a select or status field",
        ));
      }
      validate_field_ids(&config.visible_field_ids)?;
      if config.cover_field_id.is_some_and(|field_id| {
        field_map
          .get(&field_id)
          .is_none_or(|field| field.field_type != DatabaseFieldType::Files)
      }) {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_COVER_FIELD_INVALID,
          "kanban coverFieldId must reference a Files field",
        ));
      }
      validate_sort_and_filter(&config.sort, &config.filter, config.filter_tree.as_ref())?;
    }
    DatabaseViewConfig::List(config) => {
      validate_title_field(config.title_field_id)?;
      validate_field_ids(&config.visible_field_ids)?;
      validate_sort_and_filter(&config.sort, &config.filter, config.filter_tree.as_ref())?;
      validate_group_rules(&config.group, &config.subgroup)?;
    }
    DatabaseViewConfig::Gallery(config) => {
      validate_title_field(config.title_field_id)?;
      if config.cover_field_id.is_some_and(|field_id| {
        field_map
          .get(&field_id)
          .is_none_or(|field| field.field_type != DatabaseFieldType::Files)
      }) {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_COVER_FIELD_INVALID,
          "gallery coverFieldId must reference a Files field",
        ));
      }
      validate_field_ids(&config.visible_field_ids)?;
      validate_sort_and_filter(&config.sort, &config.filter, config.filter_tree.as_ref())?;
      validate_group_rules(&config.group, &config.subgroup)?;
    }
    DatabaseViewConfig::Calendar(config) => {
      validate_title_field(config.title_field_id)?;
      validate_date_field(config.date_field_id)?;
      validate_field_ids(&config.visible_field_ids)?;
      validate_sort_and_filter(&config.sort, &config.filter, config.filter_tree.as_ref())?;
      validate_group_rules(&config.group, &config.subgroup)?;
    }
    DatabaseViewConfig::Timeline(config) => {
      validate_title_field(config.title_field_id)?;
      validate_date_field(config.start_field_id)?;
      if let Some(end_field_id) = config.end_field_id {
        validate_date_field(end_field_id)?;
        if end_field_id == config.start_field_id {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_CONFIG_INVALID,
            "timeline start and end fields must differ",
          ));
        }
      }
      validate_field_ids(&config.visible_field_ids)?;
      validate_sort_and_filter(&config.sort, &config.filter, config.filter_tree.as_ref())?;
    }
    DatabaseViewConfig::Gantt(config) => {
      validate_title_field(config.title_field_id)?;
      validate_date_field(config.start_field_id)?;
      if let Some(end_field_id) = config.end_field_id {
        validate_date_field(end_field_id)?;
        if end_field_id == config.start_field_id {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_CONFIG_INVALID,
            "gantt start and end fields must differ",
          ));
        }
      }
      if let Some(dependency_field_id) = config.dependency_field_id {
        let Some(field) = field_map.get(&dependency_field_id) else {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_CONFIG_INVALID,
            "gantt dependencyFieldId references an unknown field",
          ));
        };
        let DatabaseFieldConfig::Relation(relation) = &field.config else {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_CONFIG_INVALID,
            "gantt dependencyFieldId must point to a relation field",
          ));
        };
        if relation.target_database_id != field.database_id {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_CONFIG_INVALID,
            "gantt dependencyFieldId must target the same database",
          ));
        }
      }
      validate_field_ids(&config.visible_field_ids)?;
      validate_sort_and_filter(&config.sort, &config.filter, config.filter_tree.as_ref())?;
      validate_group_rules(&config.group, &None)?;
    }
    DatabaseViewConfig::Progress(config) => {
      validate_title_field(config.title_field_id)?;
      let Some(progress_field) = field_map.get(&config.progress_field_id) else {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_CONFIG_INVALID,
          "progress view requires a progress field",
        ));
      };
      if progress_field.field_type != DatabaseFieldType::Percent {
        return Err(DatabaseServiceError::new(
          ERR_VIEW_CONFIG_INVALID,
          "progress view progressFieldId must point to a percent field",
        ));
      }
      if let Some(group_field_id) = config.group_field_id {
        validate_referenced_field_ids(vec![group_field_id])?;
        let group_field = field_map[&group_field_id];
        if !matches!(
          group_field.field_type,
          DatabaseFieldType::Select
            | DatabaseFieldType::Status
            | DatabaseFieldType::MultiSelect
            | DatabaseFieldType::Tags
            | DatabaseFieldType::User
            | DatabaseFieldType::Users
            | DatabaseFieldType::Relation
            | DatabaseFieldType::Date
            | DatabaseFieldType::DateTime
            | DatabaseFieldType::Checkbox
        ) {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_CONFIG_INVALID,
            "progress groupFieldId must point to a groupable field",
          ));
        }
      }
      validate_field_ids(&config.visible_field_ids)?;
      validate_sort_and_filter(&config.sort, &config.filter, config.filter_tree.as_ref())?;
    }
  }
  Ok(())
}

pub fn validate_filter_rule(field: &DatabaseField, rule: &DatabaseFilterRule) -> DatabaseResult<()> {
  use DatabaseFilterOperator as Operator;
  use DatabaseFilterValue as Value;

  let valid = match field.field_type {
    DatabaseFieldType::Title
    | DatabaseFieldType::Text
    | DatabaseFieldType::RichText
    | DatabaseFieldType::Url
    | DatabaseFieldType::Email
    | DatabaseFieldType::Phone => {
      matches!(
        (&rule.operator, &rule.value),
        (Operator::Empty | Operator::NotEmpty, Value::None)
      ) || matches!(
        (&rule.operator, &rule.value),
        (
        Operator::Contains
          | Operator::DoesNotContain
          | Operator::Is
          | Operator::IsNot
          | Operator::StartsWith
          | Operator::EndsWith,
        Value::Text(value)
        ) if !value.trim().is_empty()
      )
    }
    DatabaseFieldType::Number | DatabaseFieldType::Percent | DatabaseFieldType::UniqueId => {
      typed_numeric_filter_is_valid(&rule.operator, &rule.value)
    }
    DatabaseFieldType::Currency => {
      matches!(
        (&rule.operator, &rule.value),
        (Operator::Empty | Operator::NotEmpty, Value::None)
      ) || matches!(
        (&rule.operator, &rule.value),
        (
        Operator::Equals
          | Operator::NotEquals
          | Operator::Greater
          | Operator::Less
          | Operator::GreaterOrEqual
          | Operator::LessOrEqual,
        Value::Currency(value)
        ) if value.amount.is_finite()
          && normalize_database_currency_code(&value.currency_code).as_deref() == Some(value.currency_code.as_str())
      ) || matches!(
        (&rule.operator, &rule.value),
        (Operator::Between, Value::CurrencyRange(value))
          if finite_range(value.start, value.end)
            && normalize_database_currency_code(&value.currency_code).as_deref() == Some(value.currency_code.as_str())
      )
    }
    DatabaseFieldType::Duration => {
      matches!(
        (&rule.operator, &rule.value),
        (Operator::Empty | Operator::NotEmpty, Value::None)
      ) || matches!(
        (&rule.operator, &rule.value),
        (
        Operator::Equals
          | Operator::NotEquals
          | Operator::Greater
          | Operator::Less
          | Operator::GreaterOrEqual
          | Operator::LessOrEqual,
          Value::Duration(value)
        ) if value.minutes >= 0
      ) || matches!(
        (&rule.operator, &rule.value),
        (Operator::Between, Value::DurationRange(value))
          if (value.start_minutes.is_some() || value.end_minutes.is_some())
            && value.start_minutes.is_none_or(|value| value >= 0)
            && value.end_minutes.is_none_or(|value| value >= 0)
            && value.start_minutes.zip(value.end_minutes).is_none_or(|(start, end)| start <= end)
      )
    }
    DatabaseFieldType::Select => typed_option_filter_is_valid(&rule.operator, &rule.value, false),
    DatabaseFieldType::Status => typed_option_filter_is_valid(&rule.operator, &rule.value, true),
    DatabaseFieldType::MultiSelect | DatabaseFieldType::Tags => {
      matches!(
        (&rule.operator, &rule.value),
        (Operator::Empty | Operator::NotEmpty, Value::None)
      ) || matches!(
        (&rule.operator, &rule.value),
        (Operator::Contains | Operator::DoesNotContain, Value::OptionId(value)) if !value.is_empty()
      ) || matches!(
        (&rule.operator, &rule.value),
        (Operator::ContainsAll, Value::Ids(values)) if !values.is_empty()
      )
    }
    DatabaseFieldType::Date => typed_date_filter_is_valid(&rule.operator, &rule.value, false),
    DatabaseFieldType::DateTime | DatabaseFieldType::CreatedTime | DatabaseFieldType::UpdatedTime => {
      typed_date_filter_is_valid(&rule.operator, &rule.value, true)
    }
    DatabaseFieldType::User | DatabaseFieldType::Users => matches!(
      (&rule.operator, &rule.value),
      (
        Operator::Empty | Operator::NotEmpty | Operator::CurrentUser,
        Value::None
      ) | (Operator::ContainsUser | Operator::DoesNotContainUser, Value::UserId(_))
    ),
    DatabaseFieldType::Checkbox => matches!(
      (&rule.operator, &rule.value),
      (Operator::Checked | Operator::Unchecked, Value::None)
    ),
    DatabaseFieldType::Relation => matches!(
      (&rule.operator, &rule.value),
      (Operator::Empty | Operator::NotEmpty, Value::None)
        | (
          Operator::ContainsRow | Operator::DoesNotContainRow,
          Value::RelationRowId(_)
        )
    ),
    DatabaseFieldType::Files
    | DatabaseFieldType::DocumentLink
    | DatabaseFieldType::Rollup
    | DatabaseFieldType::Formula
    | DatabaseFieldType::CreatedBy
    | DatabaseFieldType::UpdatedBy => false,
  };
  if valid {
    Ok(())
  } else {
    Err(DatabaseServiceError::new(
      ERR_VIEW_CONFIG_INVALID,
      "filter operator, value and field type are incompatible",
    ))
  }
}

pub fn finite_range(start: Option<f64>, end: Option<f64>) -> bool {
  (start.is_some() || end.is_some())
    && start.is_none_or(f64::is_finite)
    && end.is_none_or(f64::is_finite)
    && start.zip(end).is_none_or(|(start, end)| start <= end)
}

pub fn typed_numeric_filter_is_valid(operator: &DatabaseFilterOperator, value: &DatabaseFilterValue) -> bool {
  use DatabaseFilterOperator as Operator;
  use DatabaseFilterValue as Value;
  matches!((operator, value), (Operator::Empty | Operator::NotEmpty, Value::None))
    || matches!(
      (operator, value),
      (
        Operator::Equals
          | Operator::NotEquals
          | Operator::Greater
          | Operator::Less
          | Operator::GreaterOrEqual
          | Operator::LessOrEqual,
        Value::Number(number)
      ) if number.is_finite()
    )
    || matches!((operator, value), (Operator::Between, Value::NumberRange(range)) if finite_range(range.start, range.end))
}

pub fn typed_option_filter_is_valid(
  operator: &DatabaseFilterOperator,
  value: &DatabaseFilterValue,
  status_groups: bool,
) -> bool {
  use DatabaseFilterOperator as Operator;
  use DatabaseFilterValue as Value;
  matches!((operator, value), (Operator::Empty | Operator::NotEmpty, Value::None))
    || matches!((operator, value), (Operator::Is | Operator::IsNot, Value::OptionId(id)) if !id.is_empty())
    || matches!((operator, value), (Operator::AnyOf | Operator::NoneOf, Value::Ids(ids)) if !ids.is_empty())
    || status_groups
      && (matches!((operator, value), (Operator::GroupIs | Operator::GroupIsNot, Value::OptionId(id)) if !id.is_empty())
        || matches!((operator, value), (Operator::GroupAnyOf | Operator::GroupNoneOf, Value::Ids(ids)) if !ids.is_empty()))
}

pub fn typed_date_filter_is_valid(
  operator: &DatabaseFilterOperator,
  value: &DatabaseFilterValue,
  instant: bool,
) -> bool {
  use DatabaseFilterOperator as Operator;
  use DatabaseFilterValue as Value;
  matches!((operator, value), (Operator::Empty | Operator::NotEmpty, Value::None))
    || if instant {
      matches!(
        (operator, value),
        (Operator::Before | Operator::After | Operator::On, Value::Instant(_))
      ) || matches!((operator, value), (Operator::Between, Value::InstantRange(range)) if range.start.is_some() || range.end.is_some())
    } else {
      matches!(
        (operator, value),
        (Operator::Before | Operator::After | Operator::On, Value::Date(_))
      ) || matches!((operator, value), (Operator::Between, Value::DateRange(range)) if range.start.is_some() || range.end.is_some())
    }
    || matches!((operator, value), (Operator::Relative, Value::RelativeDate(_)))
}

pub fn clamp_page(limits: &DatabaseLimits, page: PageRequest) -> PageRequest {
  PageRequest {
    limit: page.limit.clamp(1, limits.max_rows_per_page),
    offset: page.offset.max(0),
  }
}
