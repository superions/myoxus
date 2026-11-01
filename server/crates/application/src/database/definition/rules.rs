use super::*;
use crate::database::projections::formula::{FormulaAnalysis, analyze_formula};
use chrono_tz::Tz;

pub fn validate_field_config(field_type: DatabaseFieldType, config: &DatabaseFieldConfig) -> DatabaseResult<()> {
  if !config.matches_field_type(field_type) {
    return Err(DatabaseServiceError::new(
      ERR_FIELD_INVALID,
      "field config kind does not match field type",
    ));
  }
  if let DatabaseFieldConfig::DateTime(config) = config
    && let Some(time_zone) = &config.default_time_zone
  {
    validate_time_zone(time_zone)?;
  }
  if let DatabaseFieldConfig::Files(config) = config {
    validate_files_field_config(config)?;
  }
  if let DatabaseFieldConfig::UniqueId(config) = config {
    validate_unique_id_field_config(config)?;
  }
  if let DatabaseFieldConfig::RichText(config) = config
    && let Some(max_plain_text_bytes) = config.max_plain_text_bytes
    && max_plain_text_bytes == 0
  {
    return Err(DatabaseServiceError::new(
      ERR_FIELD_INVALID,
      "rich text max_plain_text_bytes must be positive",
    ));
  }
  if let DatabaseFieldConfig::Tags(config) = config
    && let Some(max_count) = config.max_count
    && max_count < 0
  {
    return Err(DatabaseServiceError::new(
      ERR_FIELD_INVALID,
      "tags max_count must be zero or greater",
    ));
  }
  let mut option_ids = BTreeSet::new();
  for option in config.select_options() {
    if option.id.trim().is_empty() || option.name.trim().is_empty() || option.color_role.trim().is_empty() {
      return Err(DatabaseServiceError::new(
        ERR_FIELD_INVALID,
        "select options require id, name and color role",
      ));
    }
    if !option_ids.insert(option.id.clone()) {
      return Err(DatabaseServiceError::new(
        ERR_FIELD_INVALID,
        "select option ids must be unique",
      ));
    }
    if option.color_role.contains('#') || option.color_role.contains("rgb") || option.color_role.contains("hsl") {
      return Err(DatabaseServiceError::new(
        ERR_FIELD_INVALID,
        "select option color roles must be product-neutral roles, not raw colors",
      ));
    }
  }
  if let DatabaseFieldConfig::Status(config) = config {
    validate_database_status_field_config(config)
      .map_err(|message| DatabaseServiceError::new(ERR_FIELD_INVALID, message))?;
  }
  if let DatabaseFieldConfig::Relation(config) = config {
    if config.target_database_id == DatabaseId::nil() {
      return Err(DatabaseServiceError::new(
        ERR_RELATION_TARGET_DATABASE_INVALID,
        "relation fields require a target database id",
      ));
    }
    if let Some(max_targets) = config.max_targets
      && max_targets <= 0
    {
      return Err(DatabaseServiceError::new(
        ERR_RELATION_LIMIT_EXCEEDED,
        "relation max_targets must be positive",
      ));
    }
  }
  if let DatabaseFieldConfig::Percent(config) = config {
    if let Some(min_value) = config.min_value
      && !min_value.is_finite()
    {
      return Err(DatabaseServiceError::new(
        ERR_PERCENT_RANGE_INVALID,
        "percent minimum must be a finite number",
      ));
    }
    if let Some(max_value) = config.max_value
      && !max_value.is_finite()
    {
      return Err(DatabaseServiceError::new(
        ERR_PERCENT_RANGE_INVALID,
        "percent maximum must be a finite number",
      ));
    }
    if let (Some(min_value), Some(max_value)) = (config.min_value, config.max_value)
      && min_value > max_value
    {
      return Err(DatabaseServiceError::new(
        ERR_PERCENT_RANGE_INVALID,
        "percent minimum cannot be greater than maximum",
      ));
    }
  }
  if let DatabaseFieldConfig::Currency(config) = config {
    if normalize_database_currency_code(&config.default_currency).as_deref() != Some(config.default_currency.as_str()) {
      return Err(DatabaseServiceError::new(
        ERR_CURRENCY_INVALID,
        "currency field default must be an uppercase ISO-4217 currency code",
      ));
    }
    if let Some(min_value) = config.min_value
      && !min_value.is_finite()
    {
      return Err(DatabaseServiceError::new(
        ERR_CURRENCY_INVALID,
        "currency minimum must be a finite number",
      ));
    }
    if let Some(max_value) = config.max_value
      && !max_value.is_finite()
    {
      return Err(DatabaseServiceError::new(
        ERR_CURRENCY_INVALID,
        "currency maximum must be a finite number",
      ));
    }
    if let (Some(min_value), Some(max_value)) = (config.min_value, config.max_value)
      && min_value > max_value
    {
      return Err(DatabaseServiceError::new(
        ERR_CURRENCY_INVALID,
        "currency minimum cannot be greater than maximum",
      ));
    }
  }
  if let DatabaseFieldConfig::Duration(config) = config {
    if let Some(min_minutes) = config.min_minutes
      && min_minutes < 0
    {
      return Err(DatabaseServiceError::new(
        ERR_DURATION_INVALID,
        "duration minimum must be zero or greater",
      ));
    }
    if let Some(max_minutes) = config.max_minutes
      && max_minutes < 0
    {
      return Err(DatabaseServiceError::new(
        ERR_DURATION_INVALID,
        "duration maximum must be zero or greater",
      ));
    }
    if let (Some(min_minutes), Some(max_minutes)) = (config.min_minutes, config.max_minutes)
      && min_minutes > max_minutes
    {
      return Err(DatabaseServiceError::new(
        ERR_DURATION_INVALID,
        "duration minimum cannot be greater than maximum",
      ));
    }
  }
  if let DatabaseFieldConfig::Users(config) = config {
    if let Some(min_count) = config.min_count
      && min_count < 0
    {
      return Err(DatabaseServiceError::new(
        ERR_CELL_INVALID,
        "users minimum selection count must be zero or greater",
      ));
    }
    if let Some(max_count) = config.max_count
      && max_count < 0
    {
      return Err(DatabaseServiceError::new(
        ERR_CELL_INVALID,
        "users maximum selection count must be zero or greater",
      ));
    }
    if let (Some(min_count), Some(max_count)) = (config.min_count, config.max_count)
      && min_count > max_count
    {
      return Err(DatabaseServiceError::new(
        ERR_CELL_INVALID,
        "users minimum selection count cannot exceed maximum",
      ));
    }
  }
  if let DatabaseFieldConfig::Rollup(config) = config
    && (config.source_relation_field_id == DatabaseFieldId::nil() || config.target_field_id == DatabaseFieldId::nil())
  {
    return Err(DatabaseServiceError::new(
      ERR_ROLLUP_CONFIG_INVALID,
      "rollup fields require source relation and target field ids",
    ));
  }
  if let DatabaseFieldConfig::Formula(config) = config
    && config.expression.trim().is_empty()
  {
    return Err(DatabaseServiceError::new(
      ERR_FORMULA_PARSE_FAILED,
      "formula fields require an expression",
    ));
  }
  Ok(())
}

pub fn validate_files_field_config(config: &DatabaseFilesFieldConfig) -> DatabaseResult<()> {
  let mut categories = BTreeSet::new();
  for category in &config.allowed_mime_categories {
    if !categories.insert(*category) {
      return Err(DatabaseServiceError::new(
        ERR_FILES_INVALID,
        "files field mime categories must be unique",
      ));
    }
  }
  if categories.contains(&DatabaseFileMimeCategory::Any) && categories.len() > 1 {
    return Err(DatabaseServiceError::new(
      ERR_FILES_INVALID,
      "files field cannot combine Any with narrower mime categories",
    ));
  }
  if matches!(config.max_item_count, Some(value) if value <= 0) {
    return Err(DatabaseServiceError::new(
      ERR_FILES_INVALID,
      "files field max item count must be greater than zero",
    ));
  }
  if matches!(config.max_item_size, Some(value) if value <= 0) {
    return Err(DatabaseServiceError::new(
      ERR_FILES_INVALID,
      "files field max item size must be greater than zero",
    ));
  }
  Ok(())
}

pub fn validate_time_zone(time_zone: &str) -> DatabaseResult<()> {
  time_zone
    .parse::<Tz>()
    .map(|_| ())
    .map_err(|_| DatabaseServiceError::new(ERR_DATE_TIME_INVALID, "invalid IANA timezone identifier"))
}

pub fn validate_title(title: &str) -> DatabaseResult<String> {
  let title = title.trim();
  if title.is_empty() {
    return Err(DatabaseServiceError::new(
      ERR_FIELD_REQUIRED,
      "database title is required",
    ));
  }
  Ok(title.to_string())
}

pub fn validate_unique_id_field_config(config: &DatabaseUniqueIdFieldConfig) -> DatabaseResult<()> {
  if config.start_number <= 0 {
    return Err(DatabaseServiceError::new(
      ERR_FIELD_INVALID,
      "unique id start number must be greater than zero",
    ));
  }
  if !(0..=32).contains(&config.padding) {
    return Err(DatabaseServiceError::new(
      ERR_FIELD_INVALID,
      "unique id padding must be between 0 and 32",
    ));
  }
  if config.prefix.chars().count() > 32 {
    return Err(DatabaseServiceError::new(
      ERR_FIELD_INVALID,
      "unique id prefix must not exceed 32 characters",
    ));
  }
  if !config
    .prefix
    .chars()
    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
  {
    return Err(DatabaseServiceError::new(
      ERR_FIELD_INVALID,
      "unique id prefix may only contain ASCII letters, numbers, hyphen or underscore",
    ));
  }
  Ok(())
}

pub fn validate_formula_field_config(
  fields: &[DatabaseField],
  current_field_id: Option<DatabaseFieldId>,
  config: &mut DatabaseFieldConfig,
) -> DatabaseResult<Option<FormulaAnalysis>> {
  let DatabaseFieldConfig::Formula(config) = config else {
    return Ok(None);
  };
  let available_fields = fields
    .iter()
    .filter(|field| Some(field.id) != current_field_id)
    .cloned()
    .collect::<Vec<_>>();
  let analysis = analyze_formula(&config.expression, config.result_type, &available_fields)?;
  config.dependency_field_ids = analysis.dependency_field_ids.clone();
  Ok(Some(analysis))
}

pub fn structural_view_axis_reference(field_id: DatabaseFieldId, views: &[DatabaseView]) -> Option<&DatabaseView> {
  views.iter().find(|view| match &view.config {
    DatabaseViewConfig::Kanban(config) => config.group_field_id == field_id,
    DatabaseViewConfig::Calendar(config) => config.date_field_id == field_id,
    DatabaseViewConfig::Timeline(config) => config.start_field_id == field_id || config.end_field_id == Some(field_id),
    DatabaseViewConfig::Gantt(config) => {
      config.start_field_id == field_id
        || config.end_field_id == Some(field_id)
        || config.dependency_field_id == Some(field_id)
        || config.group.as_ref().is_some_and(|group| group.field_id == field_id)
    }
    DatabaseViewConfig::Gallery(config) => config.cover_field_id == Some(field_id),
    DatabaseViewConfig::Progress(config) => {
      config.progress_field_id == field_id || config.group_field_id == Some(field_id)
    }
    DatabaseViewConfig::Table(_) | DatabaseViewConfig::List(_) => false,
  })
}

pub fn title_field(fields: &[DatabaseField]) -> DatabaseResult<&DatabaseField> {
  let title_fields = fields
    .iter()
    .filter(|field| field.field_type == DatabaseFieldType::Title)
    .collect::<Vec<_>>();
  if title_fields.len() != 1 {
    return Err(DatabaseServiceError::new(
      ERR_FIELD_INVALID,
      "exactly one title field is required",
    ));
  }
  Ok(title_fields[0])
}

pub fn aggregate_accepts_target(aggregate: DatabaseRollupAggregate, field_type: DatabaseFieldType) -> bool {
  match aggregate {
    DatabaseRollupAggregate::Count => true,
    DatabaseRollupAggregate::CountValues => field_type != DatabaseFieldType::Title,
    DatabaseRollupAggregate::Sum
    | DatabaseRollupAggregate::Average
    | DatabaseRollupAggregate::Min
    | DatabaseRollupAggregate::Max => {
      matches!(
        field_type,
        DatabaseFieldType::Number
          | DatabaseFieldType::Percent
          | DatabaseFieldType::Currency
          | DatabaseFieldType::Duration
      )
    }
    DatabaseRollupAggregate::Earliest | DatabaseRollupAggregate::Latest => {
      matches!(
        field_type,
        DatabaseFieldType::Date
          | DatabaseFieldType::DateTime
          | DatabaseFieldType::CreatedTime
          | DatabaseFieldType::UpdatedTime
      )
    }
    DatabaseRollupAggregate::CheckedPercent | DatabaseRollupAggregate::UncheckedPercent => {
      field_type == DatabaseFieldType::Checkbox
    }
    DatabaseRollupAggregate::UniqueValues => !matches!(
      field_type,
      DatabaseFieldType::Files
        | DatabaseFieldType::Relation
        | DatabaseFieldType::Rollup
        | DatabaseFieldType::Formula
        | DatabaseFieldType::DocumentLink
    ),
  }
}
