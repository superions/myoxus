// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native value normalization shared by interactive editing and import owners.
use super::*;

pub fn validate_date_time_value(value: &DatabaseDateTimeValue, config: &DatabaseFieldConfig) -> DatabaseResult<()> {
  let DatabaseFieldConfig::DateTime(_) = config else {
    return Err(DatabaseServiceError::new(
      ERR_FIELD_INVALID,
      "date_time cell requires date_time field config",
    ));
  };
  crate::database::definition::rules::validate_time_zone(&value.time_zone)?;
  if let Some(end) = value.end
    && end < value.start
  {
    return Err(DatabaseServiceError::new(
      ERR_DATE_TIME_INVALID,
      "date_time range end cannot be before start",
    ));
  }
  Ok(())
}

pub fn validate_files_value_shape(value: &DatabaseFilesValue, config: &DatabaseFieldConfig) -> DatabaseResult<()> {
  let DatabaseFieldConfig::Files(config) = config else {
    return Err(DatabaseServiceError::new(
      ERR_FIELD_INVALID,
      "files cell requires files field config",
    ));
  };
  if let Some(max_count) = config.max_item_count
    && value.files.len() > max_count as usize
  {
    return Err(DatabaseServiceError::new(
      ERR_FILES_INVALID,
      "files cell exceeds the configured item count",
    ));
  }
  let mut blob_keys = BTreeSet::new();
  let mut cover_count = 0;
  for file in &value.files {
    let blob_key = file.blob_key.trim();
    if blob_key.is_empty() {
      return Err(DatabaseServiceError::new(
        ERR_FILES_INVALID,
        "files cell blob keys must not be empty",
      ));
    }
    if !blob_keys.insert(blob_key.to_string()) {
      return Err(DatabaseServiceError::new(
        ERR_FILES_INVALID,
        "files cell cannot reference the same blob twice",
      ));
    }
    if file.cover {
      cover_count += 1;
    }
    if matches!(file.name.as_deref(), Some(value) if value.trim().is_empty())
      || matches!(file.mime.as_deref(), Some(value) if value.trim().is_empty())
      || matches!(file.caption.as_deref(), Some(value) if value.trim().is_empty())
    {
      return Err(DatabaseServiceError::new(
        ERR_FILES_INVALID,
        "files cell optional metadata cannot be blank",
      ));
    }
    if matches!(file.size, Some(value) if value < 0) {
      return Err(DatabaseServiceError::new(
        ERR_FILES_INVALID,
        "files cell size must be zero or greater",
      ));
    }
  }
  if cover_count > 1 {
    return Err(DatabaseServiceError::new(
      ERR_FILES_INVALID,
      "files cell can mark at most one file as cover",
    ));
  }
  Ok(())
}

pub fn validate_cell_value(
  field: &DatabaseField,
  value: &DatabaseCellValueData,
  limits: &DatabaseLimits,
) -> DatabaseResult<()> {
  match (&field.field_type, value) {
    (DatabaseFieldType::Title, _) => Err(DatabaseServiceError::new(
      ERR_CELL_INVALID,
      "the Row title is row-owned state and cannot be stored as a cell",
    )),
    (DatabaseFieldType::Text, DatabaseCellValueData::Text(value)) => {
      if value.len() > limits.max_cell_text_bytes {
        Err(DatabaseServiceError::new(
          ERR_LIMIT_EXCEEDED,
          "text cell value exceeds max_cell_text_bytes",
        ))
      } else {
        Ok(())
      }
    }
    (DatabaseFieldType::RichText, DatabaseCellValueData::RichText(value)) => {
      let DatabaseFieldConfig::RichText(config) = &field.config else {
        return Err(DatabaseServiceError::new(
          ERR_FIELD_INVALID,
          "rich text cell requires rich text field config",
        ));
      };
      let normalized = normalize_rich_text_value(value.clone(), limits)?;
      let max_bytes = config.max_plain_text_bytes.unwrap_or(limits.max_cell_text_bytes);
      if normalized.plain_text.len() > max_bytes {
        return Err(DatabaseServiceError::new(
          ERR_LIMIT_EXCEEDED,
          "rich text plain text projection exceeds the configured limit",
        ));
      }
      Ok(())
    }
    (DatabaseFieldType::Number, DatabaseCellValueData::Number(value)) if value.is_finite() => Ok(()),
    (DatabaseFieldType::Percent, DatabaseCellValueData::Percent(value)) if value.is_finite() => {
      let DatabaseFieldConfig::Percent(config) = &field.config else {
        return Err(DatabaseServiceError::new(
          ERR_FIELD_INVALID,
          "percent cell requires percent field config",
        ));
      };
      if let Some(min_value) = config.min_value
        && *value < min_value
      {
        return Err(DatabaseServiceError::new(
          ERR_PERCENT_RANGE_INVALID,
          "percent cell value is below the configured minimum",
        ));
      }
      if let Some(max_value) = config.max_value
        && *value > max_value
      {
        return Err(DatabaseServiceError::new(
          ERR_PERCENT_RANGE_INVALID,
          "percent cell value exceeds the configured maximum",
        ));
      }
      Ok(())
    }
    (DatabaseFieldType::Currency, DatabaseCellValueData::Currency(value)) if value.amount.is_finite() => {
      let DatabaseFieldConfig::Currency(config) = &field.config else {
        return Err(DatabaseServiceError::new(
          ERR_FIELD_INVALID,
          "currency cell requires currency field config",
        ));
      };
      if normalize_database_currency_code(&value.currency_code).as_deref() != Some(value.currency_code.as_str()) {
        return Err(DatabaseServiceError::new(
          ERR_CURRENCY_INVALID,
          "currency cell requires an uppercase ISO-4217 currency code",
        ));
      }
      if !config.allow_currency_override && value.currency_code != config.default_currency {
        return Err(DatabaseServiceError::new(
          ERR_CURRENCY_INVALID,
          "currency cell currency does not match the field default",
        ));
      }
      if let Some(min_value) = config.min_value
        && value.amount < min_value
      {
        return Err(DatabaseServiceError::new(
          ERR_CURRENCY_INVALID,
          "currency amount is below the configured minimum",
        ));
      }
      if let Some(max_value) = config.max_value
        && value.amount > max_value
      {
        return Err(DatabaseServiceError::new(
          ERR_CURRENCY_INVALID,
          "currency amount exceeds the configured maximum",
        ));
      }
      Ok(())
    }
    (DatabaseFieldType::Duration, DatabaseCellValueData::Duration(value)) => {
      let DatabaseFieldConfig::Duration(config) = &field.config else {
        return Err(DatabaseServiceError::new(
          ERR_FIELD_INVALID,
          "duration cell requires duration field config",
        ));
      };
      if value.minutes < 0 {
        return Err(DatabaseServiceError::new(
          ERR_DURATION_INVALID,
          "duration minutes must be zero or greater",
        ));
      }
      if let Some(min_minutes) = config.min_minutes
        && value.minutes < min_minutes
      {
        return Err(DatabaseServiceError::new(
          ERR_DURATION_INVALID,
          "duration minutes are below the configured minimum",
        ));
      }
      if let Some(max_minutes) = config.max_minutes
        && value.minutes > max_minutes
      {
        return Err(DatabaseServiceError::new(
          ERR_DURATION_INVALID,
          "duration minutes exceed the configured maximum",
        ));
      }
      Ok(())
    }
    (DatabaseFieldType::Checkbox, DatabaseCellValueData::Checkbox(_)) => Ok(()),
    (DatabaseFieldType::Date, DatabaseCellValueData::Date(value)) => {
      if let Some(end) = value.end
        && end < value.start
      {
        return Err(DatabaseServiceError::new(
          ERR_CELL_INVALID,
          "date range end cannot be before start",
        ));
      }
      Ok(())
    }
    (DatabaseFieldType::DateTime, DatabaseCellValueData::DateTime(value)) => {
      validate_date_time_value(value, &field.config)
    }
    (DatabaseFieldType::Files, DatabaseCellValueData::Files(value)) => validate_files_value_shape(value, &field.config),
    (DatabaseFieldType::UniqueId, DatabaseCellValueData::UniqueId(_)) => Err(DatabaseServiceError::new(
      ERR_CELL_VALUE_READONLY,
      "unique id cells are server-generated and cannot be edited",
    )),
    (DatabaseFieldType::Select, DatabaseCellValueData::Select(option_id)) => {
      if field
        .config
        .select_options()
        .iter()
        .any(|option| option.id == *option_id)
      {
        Ok(())
      } else {
        Err(DatabaseServiceError::new(
          ERR_CELL_INVALID,
          "select value is not present in field options",
        ))
      }
    }
    (DatabaseFieldType::MultiSelect, DatabaseCellValueData::MultiSelect(option_ids)) => {
      let configured = field
        .config
        .select_options()
        .iter()
        .map(|option| option.id.as_str())
        .collect::<HashSet<_>>();
      let mut seen = HashSet::new();
      if option_ids
        .iter()
        .all(|id| configured.contains(id.as_str()) && seen.insert(id.as_str()))
      {
        Ok(())
      } else {
        Err(DatabaseServiceError::new(
          ERR_CELL_INVALID,
          "multi-select values must be unique option ids from the field config",
        ))
      }
    }
    (DatabaseFieldType::Tags, DatabaseCellValueData::Tags(tag_ids)) => {
      let DatabaseFieldConfig::Tags(config) = &field.config else {
        return Err(DatabaseServiceError::new(
          ERR_FIELD_INVALID,
          "tags cell requires tags field config",
        ));
      };
      let mut unique = BTreeSet::new();
      for tag_id in tag_ids {
        if !unique.insert(*tag_id) {
          return Err(DatabaseServiceError::new(
            ERR_CELL_INVALID,
            "tags cell values must not contain duplicate tags",
          ));
        }
      }
      if let Some(max_count) = config.max_count
        && tag_ids.len() as i32 > max_count
      {
        return Err(DatabaseServiceError::new(
          ERR_CELL_INVALID,
          "tags cell exceeds the configured maximum tag count",
        ));
      }
      Ok(())
    }
    (DatabaseFieldType::Status, DatabaseCellValueData::Status(option_id)) => {
      if field
        .config
        .status_options()
        .iter()
        .any(|option| option.id == *option_id)
      {
        Ok(())
      } else {
        Err(DatabaseServiceError::new(
          ERR_CELL_INVALID,
          "status value is not present in field options",
        ))
      }
    }
    (DatabaseFieldType::User, DatabaseCellValueData::User(_)) => Ok(()),
    (DatabaseFieldType::Users, DatabaseCellValueData::Users(value)) => {
      let DatabaseFieldConfig::Users(config) = &field.config else {
        return Err(DatabaseServiceError::new(
          ERR_FIELD_INVALID,
          "users cell requires users field config",
        ));
      };
      let mut unique = BTreeSet::new();
      for user_id in value {
        if !unique.insert(*user_id) {
          return Err(DatabaseServiceError::new(
            ERR_CELL_INVALID,
            "users cell values must not contain duplicate users",
          ));
        }
      }
      let count = value.len() as i32;
      if let Some(min_count) = config.min_count
        && count < min_count
      {
        return Err(DatabaseServiceError::new(
          ERR_CELL_INVALID,
          "users cell value has fewer users than configured",
        ));
      }
      if let Some(max_count) = config.max_count
        && count > max_count
      {
        return Err(DatabaseServiceError::new(
          ERR_CELL_INVALID,
          "users cell value has more users than configured",
        ));
      }
      Ok(())
    }
    (DatabaseFieldType::DocumentLink, DatabaseCellValueData::DocumentLink(_)) => Ok(()),
    (DatabaseFieldType::Relation, DatabaseCellValueData::Relation(target_row_ids)) => {
      let DatabaseFieldConfig::Relation(config) = &field.config else {
        return Err(DatabaseServiceError::new(
          ERR_RELATION_TARGET_DATABASE_INVALID,
          "relation fields require relation config",
        ));
      };
      let unique = target_row_ids.iter().copied().collect::<HashSet<_>>();
      if unique.len() != target_row_ids.len() {
        return Err(DatabaseServiceError::new(
          ERR_RELATION_TARGET_ROW_INVALID,
          "relation target rows must be unique",
        ));
      }
      if !config.allow_multiple && target_row_ids.len() > 1 {
        return Err(DatabaseServiceError::new(
          ERR_RELATION_LIMIT_EXCEEDED,
          "relation field allows only one target",
        ));
      }
      if let Some(max_targets) = config.max_targets
        && target_row_ids.len() > max_targets as usize
      {
        return Err(DatabaseServiceError::new(
          ERR_RELATION_LIMIT_EXCEEDED,
          "relation target count exceeds max_targets",
        ));
      }
      Ok(())
    }
    (DatabaseFieldType::Rollup, _) => Err(DatabaseServiceError::new(
      ERR_ROLLUP_WRITE_FORBIDDEN,
      "rollup cells are server-computed and cannot be written directly",
    )),
    (DatabaseFieldType::Formula, _) => Err(DatabaseServiceError::new(
      ERR_FORMULA_WRITE_FORBIDDEN,
      "formula cells are server-computed and cannot be written directly",
    )),
    (DatabaseFieldType::Url, DatabaseCellValueData::Url(value)) => normalize_url(value).map(|_| ()),
    (DatabaseFieldType::Email, DatabaseCellValueData::Email(value)) => normalize_email(value).map(|_| ()),
    (DatabaseFieldType::Phone, DatabaseCellValueData::Phone(value)) => normalize_phone(value).map(|_| ()),
    (
      DatabaseFieldType::CreatedTime
      | DatabaseFieldType::CreatedBy
      | DatabaseFieldType::UpdatedTime
      | DatabaseFieldType::UpdatedBy,
      _,
    ) => Err(DatabaseServiceError::new(
      ERR_CELL_VALUE_READONLY,
      "database projection cells are read-only",
    )),
    _ => Err(DatabaseServiceError::new(
      ERR_CELL_INVALID,
      "cell value type does not match field type",
    )),
  }
}

pub fn validate_cell_clear(
  record: &DatabaseRecord,
  row_kind: DatabaseRowKind,
  field: &DatabaseField,
) -> DatabaseResult<()> {
  if field.field_type == DatabaseFieldType::Title {
    return Err(DatabaseServiceError::new(
      ERR_CELL_INVALID,
      "row titles cannot be cleared as cell values",
    ));
  }
  if is_projection_field(field.field_type) {
    return Err(DatabaseServiceError::new(
      ERR_CELL_VALUE_READONLY,
      "database projection cells are read-only",
    ));
  }
  // The Task description protects its schema binding, but its editable body
  // may be removed. Other required Cells retain their existing DELETE policy.
  let optional_task_description = row_kind == DatabaseRowKind::Task
    && record.database.profile_kind == DatabaseProfileKind::Project
    && field.database_id == record.database.id
    && record
      .project_managed_schema()
      .is_some_and(|schema| schema.readiness == myoxus_domain::database::DatabaseManagedSchemaReadiness::Ready)
    && record.field_roles.iter().any(|binding| {
      binding.database_id == record.database.id
        && binding.profile_kind == record.database.profile_kind
        && binding.field_id == field.id
        && binding.row_kind_scope.as_deref() == Some("task")
        && binding.role_key == "task.description"
        && binding.config.get("manualEdit").and_then(serde_json::Value::as_bool) != Some(false)
        && myoxus_domain::database::projects::DATABASE_PROJECT_SEMANTIC_CATALOG
          .iter()
          .any(|role| {
            role.role_key == binding.role_key
              && role.row_kind_scope == row_kind
              && role.field_type == field.field_type
              && matches!(
                role.managed_state,
                myoxus_domain::database::projects::DatabaseProjectRoleManagedState::UserEditable
              )
          })
    });
  if field.required && !optional_task_description {
    return Err(DatabaseServiceError::new(
      ERR_FIELD_REQUIRED,
      "required database field values cannot be cleared",
    ));
  }
  Ok(())
}

pub fn normalize_url(raw: &str) -> DatabaseResult<String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Ok(String::new());
  }
  let candidate = if trimmed.contains("://") {
    trimmed.to_string()
  } else {
    format!("https://{trimmed}")
  };
  let parsed =
    url::Url::parse(&candidate).map_err(|_| DatabaseServiceError::new(ERR_URL_INVALID, "invalid URL cell value"))?;
  if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
    return Err(DatabaseServiceError::new(
      ERR_URL_INVALID,
      "URL cells require http(s) URLs with a host",
    ));
  }
  Ok(parsed.as_str().to_string())
}

pub fn normalize_email(raw: &str) -> DatabaseResult<String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Ok(String::new());
  }
  if trimmed.chars().any(|ch| ch.is_whitespace() || ch.is_control()) || trimmed.matches('@').count() != 1 {
    return Err(DatabaseServiceError::new(ERR_EMAIL_INVALID, "invalid email cell value"));
  }
  let (local, domain) = trimmed
    .split_once('@')
    .ok_or_else(|| DatabaseServiceError::new(ERR_EMAIL_INVALID, "invalid email cell value"))?;
  if local.is_empty() || local.len() > 64 || domain.is_empty() || domain.len() > 253 {
    return Err(DatabaseServiceError::new(ERR_EMAIL_INVALID, "invalid email cell value"));
  }
  Ok(format!("{local}@{}", domain.to_ascii_lowercase()))
}

pub fn normalize_phone(raw: &str) -> DatabaseResult<String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Ok(String::new());
  }
  if trimmed.len() < 3
    || trimmed.len() > 64
    || !trimmed
      .chars()
      .all(|ch| ch.is_ascii_digit() || matches!(ch, ' ' | '+' | '(' | ')' | '.' | '-' | '/'))
  {
    return Err(DatabaseServiceError::new(ERR_PHONE_INVALID, "invalid phone cell value"));
  }
  if trimmed.chars().filter(|ch| ch.is_ascii_digit()).count() < 3 {
    return Err(DatabaseServiceError::new(
      ERR_PHONE_INVALID,
      "phone cell values require at least three digits",
    ));
  }
  Ok(trimmed.to_string())
}

pub fn normalize_rich_text_link(raw: &str, limits: &DatabaseLimits) -> DatabaseResult<String> {
  let href = raw.trim();
  if href.is_empty() || href.len() > limits.max_rich_text_link_bytes {
    return Err(DatabaseServiceError::new(
      ERR_RICH_TEXT_INVALID,
      "rich text link is empty or exceeds max_rich_text_link_bytes",
    ));
  }
  let parsed =
    url::Url::parse(href).map_err(|_| DatabaseServiceError::new(ERR_RICH_TEXT_INVALID, "rich text link is invalid"))?;
  if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
    return Err(DatabaseServiceError::new(
      ERR_RICH_TEXT_INVALID,
      "rich text link scheme is not allowed",
    ));
  }
  if parsed.scheme() == "mailto" && parsed.path().trim().is_empty() {
    return Err(DatabaseServiceError::new(
      ERR_RICH_TEXT_INVALID,
      "rich text mailto link requires a recipient",
    ));
  }
  Ok(parsed.to_string())
}

fn validate_rich_text_node(
  node: &mut CanonicalRichTextNode,
  depth: usize,
  parent: Option<&'static str>,
  node_count: &mut usize,
  limits: &DatabaseLimits,
) -> DatabaseResult<()> {
  if depth > limits.max_rich_text_depth {
    return Err(DatabaseServiceError::new(
      ERR_RICH_TEXT_INVALID,
      "rich text document exceeds max_rich_text_depth",
    ));
  }
  *node_count += 1;
  if *node_count > limits.max_rich_text_nodes {
    return Err(DatabaseServiceError::new(
      ERR_RICH_TEXT_INVALID,
      "rich text document exceeds max_rich_text_nodes",
    ));
  }

  match node {
    CanonicalRichTextNode::Doc { content } => {
      if parent.is_some()
        || content
          .iter()
          .any(|child| !matches!(child, CanonicalRichTextNode::Paragraph { .. }))
      {
        return Err(DatabaseServiceError::new(
          ERR_RICH_TEXT_INVALID,
          "rich text doc may contain only paragraphs",
        ));
      }
      for child in content {
        validate_rich_text_node(child, depth + 1, Some("doc"), node_count, limits)?;
      }
    }
    CanonicalRichTextNode::Paragraph { content } => {
      if parent != Some("doc")
        || content.iter().any(|child| {
          !matches!(
            child,
            CanonicalRichTextNode::Text { .. } | CanonicalRichTextNode::HardBreak
          )
        })
      {
        return Err(DatabaseServiceError::new(
          ERR_RICH_TEXT_INVALID,
          "rich text paragraph may contain only text and hard breaks",
        ));
      }
      for child in content {
        validate_rich_text_node(child, depth + 1, Some("paragraph"), node_count, limits)?;
      }
    }
    CanonicalRichTextNode::HardBreak => {
      if parent != Some("paragraph") {
        return Err(DatabaseServiceError::new(
          ERR_RICH_TEXT_INVALID,
          "rich text hard break must be inside a paragraph",
        ));
      }
    }
    CanonicalRichTextNode::Text { marks, .. } => {
      if parent != Some("paragraph") {
        return Err(DatabaseServiceError::new(
          ERR_RICH_TEXT_INVALID,
          "rich text node must be inside a paragraph",
        ));
      }
      let mut mark_names = HashSet::new();
      for mark in marks {
        let name = match mark {
          CanonicalRichTextMark::Bold => "bold",
          CanonicalRichTextMark::Italic => "italic",
          CanonicalRichTextMark::Code => "code",
          CanonicalRichTextMark::Strike => "strike",
          CanonicalRichTextMark::Link { attrs } => {
            attrs.href = normalize_rich_text_link(&attrs.href, limits)?;
            "link"
          }
        };
        if !mark_names.insert(name) {
          return Err(DatabaseServiceError::new(
            ERR_RICH_TEXT_INVALID,
            "rich text node contains a duplicate mark",
          ));
        }
      }
    }
  }
  Ok(())
}

fn rich_text_plain_text(node: &CanonicalRichTextNode) -> String {
  match node {
    CanonicalRichTextNode::Doc { content } => content.iter().map(rich_text_plain_text).collect::<Vec<_>>().join("\n"),
    CanonicalRichTextNode::Paragraph { content } => content.iter().map(rich_text_plain_text).collect(),
    CanonicalRichTextNode::HardBreak => "\n".to_string(),
    CanonicalRichTextNode::Text { text, .. } => text.clone(),
  }
}

pub fn rich_text_value_from_document(
  document: serde_json::Value,
  limits: &DatabaseLimits,
) -> DatabaseResult<DatabaseRichTextValue> {
  let input_bytes = serde_json::to_vec(&document)
    .map_err(|_| DatabaseServiceError::new(ERR_RICH_TEXT_INVALID, "rich text document is invalid JSON"))?;
  if input_bytes.len() > limits.max_rich_text_document_bytes {
    return Err(DatabaseServiceError::new(
      ERR_LIMIT_EXCEEDED,
      "rich text document exceeds max_rich_text_document_bytes",
    ));
  }
  let mut canonical: CanonicalRichTextNode = serde_json::from_value(document)
    .map_err(|_| DatabaseServiceError::new(ERR_RICH_TEXT_INVALID, "rich text document schema is invalid"))?;
  if !matches!(canonical, CanonicalRichTextNode::Doc { .. }) {
    return Err(DatabaseServiceError::new(
      ERR_RICH_TEXT_INVALID,
      "rich text document root must be doc",
    ));
  }
  let mut node_count = 0;
  validate_rich_text_node(&mut canonical, 0, None, &mut node_count, limits)?;
  let plain_text = rich_text_plain_text(&canonical);
  if plain_text.len() > limits.max_cell_text_bytes {
    return Err(DatabaseServiceError::new(
      ERR_LIMIT_EXCEEDED,
      "rich text plain text projection exceeds max_cell_text_bytes",
    ));
  }
  let document = serde_json::to_value(canonical)
    .map_err(|_| DatabaseServiceError::new(ERR_RICH_TEXT_INVALID, "rich text normalization failed"))?;
  Ok(DatabaseRichTextValue { plain_text, document })
}

pub fn normalize_rich_text_value(
  value: DatabaseRichTextValue,
  limits: &DatabaseLimits,
) -> DatabaseResult<DatabaseRichTextValue> {
  let normalized = rich_text_value_from_document(value.document, limits)?;
  if value.plain_text != normalized.plain_text {
    return Err(DatabaseServiceError::new(
      ERR_RICH_TEXT_INVALID,
      "rich text plain text projection does not match document",
    ));
  }
  Ok(normalized)
}

pub fn normalize_editable_cell_value(
  field_type: DatabaseFieldType,
  value: DatabaseCellValueData,
  limits: &DatabaseLimits,
) -> DatabaseResult<Option<DatabaseCellValueData>> {
  match (field_type, value) {
    (DatabaseFieldType::Url, DatabaseCellValueData::Url(value)) => {
      let normalized = normalize_url(&value)?;
      Ok((!normalized.is_empty()).then_some(DatabaseCellValueData::Url(normalized)))
    }
    (DatabaseFieldType::Email, DatabaseCellValueData::Email(value)) => {
      let normalized = normalize_email(&value)?;
      Ok((!normalized.is_empty()).then_some(DatabaseCellValueData::Email(normalized)))
    }
    (DatabaseFieldType::Phone, DatabaseCellValueData::Phone(value)) => {
      let normalized = normalize_phone(&value)?;
      Ok((!normalized.is_empty()).then_some(DatabaseCellValueData::Phone(normalized)))
    }
    (DatabaseFieldType::Files, DatabaseCellValueData::Files(value)) => {
      Ok((!value.files.is_empty()).then_some(DatabaseCellValueData::Files(value)))
    }
    (DatabaseFieldType::RichText, DatabaseCellValueData::RichText(value)) => {
      let normalized = normalize_rich_text_value(value, limits)?;
      Ok((!normalized.plain_text.is_empty()).then_some(DatabaseCellValueData::RichText(normalized)))
    }
    // Title values live on the Row record, not in the Cells table. The
    // Notion import pipeline (and any other
    // snapshot producer) may emit a Text-typed placeholder cell for
    // alignment with the `fields` vector; the JSON import path
    // filters it out here so `validate_cell_value` never sees it.
    (DatabaseFieldType::Title, _) => Ok(None),
    (_, value) => Ok(Some(value)),
  }
}

pub fn empty_editable_cell_value(field_type: DatabaseFieldType) -> DatabaseResult<DatabaseCellValueData> {
  match field_type {
    DatabaseFieldType::Text => Ok(DatabaseCellValueData::Text(String::new())),
    DatabaseFieldType::Url => Ok(DatabaseCellValueData::Url(String::new())),
    DatabaseFieldType::Email => Ok(DatabaseCellValueData::Email(String::new())),
    DatabaseFieldType::Phone => Ok(DatabaseCellValueData::Phone(String::new())),
    DatabaseFieldType::Number => Ok(DatabaseCellValueData::Number(0.0)),
    DatabaseFieldType::Percent => Ok(DatabaseCellValueData::Percent(0.0)),
    DatabaseFieldType::Currency => Ok(DatabaseCellValueData::Currency(DatabaseCurrencyValue {
      amount: 0.0,
      currency_code: default_database_currency_code(),
    })),
    DatabaseFieldType::Duration => Ok(DatabaseCellValueData::Duration(DatabaseDurationValue { minutes: 0 })),
    DatabaseFieldType::Checkbox => Ok(DatabaseCellValueData::Checkbox(false)),
    DatabaseFieldType::Date => Ok(DatabaseCellValueData::Date(DatabaseDateValue {
      start: Utc::now().date_naive(),
      end: None,
    })),
    DatabaseFieldType::DateTime => Ok(DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
      start: Utc::now(),
      end: None,
      all_day: false,
      time_zone: "UTC".to_string(),
    })),
    DatabaseFieldType::Select => Ok(DatabaseCellValueData::Select(String::new())),
    DatabaseFieldType::MultiSelect => Ok(DatabaseCellValueData::MultiSelect(Vec::new())),
    DatabaseFieldType::Status => {
      let config = default_database_status_field_config();
      Ok(DatabaseCellValueData::Status(config.default_option_id))
    }
    DatabaseFieldType::User => Ok(DatabaseCellValueData::User(Uuid::nil())),
    DatabaseFieldType::Users => Ok(DatabaseCellValueData::Users(Vec::new())),
    DatabaseFieldType::DocumentLink => Err(DatabaseServiceError::new(
      ERR_CELL_INVALID,
      "document link cells have no sentinel empty value; clear the cell instead",
    )),
    DatabaseFieldType::Files => Ok(DatabaseCellValueData::Files(DatabaseFilesValue::default())),
    DatabaseFieldType::UniqueId => Err(DatabaseServiceError::new(
      ERR_CELL_VALUE_READONLY,
      "unique id cells are server-generated and have no client-provided empty value",
    )),
    DatabaseFieldType::Relation => Ok(DatabaseCellValueData::Relation(Vec::new())),
    _ => Err(DatabaseServiceError::new(
      ERR_CELL_VALUE_READONLY,
      "database projection cells are read-only",
    )),
  }
}

pub fn is_projection_field(field_type: DatabaseFieldType) -> bool {
  matches!(
    field_type,
    DatabaseFieldType::CreatedTime
      | DatabaseFieldType::CreatedBy
      | DatabaseFieldType::UpdatedTime
      | DatabaseFieldType::UpdatedBy
  )
}

pub fn clean_title(title: Option<String>) -> String {
  title
    .and_then(|title| {
      let trimmed = title.trim().to_string();
      (!trimmed.is_empty()).then_some(trimmed)
    })
    .unwrap_or_else(|| "Untitled".to_string())
}

#[expect(
  clippy::too_many_arguments,
  reason = "validation needs the canonical Row image and explicit creation/kind intent"
)]
pub fn validate_timeline_row_ranges(
  record: &DatabaseRecord,
  cells: &[DatabaseCellValue],
  created_at: DateTime<Utc>,
  updated_at: DateTime<Utc>,
  changes: &HashMap<DatabaseFieldId, Option<DatabaseCellValueData>>,
  creating: bool,
  row_kind: DatabaseRowKind,
) -> DatabaseResult<()> {
  if record.database.profile_kind == DatabaseProfileKind::Project && row_kind == DatabaseRowKind::Task {
    let role_field = |key: &str| {
      record
        .field_roles
        .iter()
        .find(|role| role.role_key == key && role.row_kind_scope.as_deref() == Some("task"))
        .map(|role| role.field_id)
    };
    return validate_project_task_temporal_ranges(
      &record.fields,
      &record.views,
      role_field("task.startDate"),
      role_field("task.dueDate"),
      cells,
      created_at,
      updated_at,
      changes,
      creating,
    )
    .map_err(|message| DatabaseServiceError::new(ERR_CELL_INVALID, message));
  }
  validate_database_temporal_ranges(&record.fields, &record.views, cells, created_at, updated_at, changes)
    .map_err(|message| DatabaseServiceError::new(ERR_VIEW_CONFIG_INVALID, message))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum CanonicalRichTextNode {
  #[serde(rename = "doc")]
  Doc {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    content: Vec<CanonicalRichTextNode>,
  },
  #[serde(rename = "paragraph")]
  Paragraph {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    content: Vec<CanonicalRichTextNode>,
  },
  #[serde(rename = "hardBreak")]
  HardBreak,
  #[serde(rename = "text")]
  Text {
    text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    marks: Vec<CanonicalRichTextMark>,
  },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum CanonicalRichTextMark {
  #[serde(rename = "bold")]
  Bold,
  #[serde(rename = "italic")]
  Italic,
  #[serde(rename = "code")]
  Code,
  #[serde(rename = "strike")]
  Strike,
  #[serde(rename = "link")]
  Link { attrs: CanonicalRichTextLinkAttrs },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CanonicalRichTextLinkAttrs {
  href: String,
}
