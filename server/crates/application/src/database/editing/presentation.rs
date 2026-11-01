// SPDX-License-Identifier: AGPL-3.0-or-later
//! Stable machine rendering shared by export and optimistic-conflict readback.
use super::*;

pub fn machine_cell_value(value: &DatabaseCellValueData) -> String {
  match value {
    DatabaseCellValueData::Text(value)
    | DatabaseCellValueData::Select(value)
    | DatabaseCellValueData::Status(value) => value.to_string(),
    DatabaseCellValueData::RichText(value) => value.plain_text.clone(),
    DatabaseCellValueData::User(value) => value.to_string(),
    DatabaseCellValueData::Number(value) => format!("{value:.2}"),
    DatabaseCellValueData::Percent(value) => format!("{value}%"),
    DatabaseCellValueData::Currency(value) => format!("{} {}", value.amount, value.currency_code),
    DatabaseCellValueData::Duration(value) => format!("{} min", value.minutes),
    DatabaseCellValueData::Checkbox(value) => value.to_string(),
    DatabaseCellValueData::Date(value) => match value.end {
      Some(end) => format!("{}/{}", value.start, end),
      None => value.start.to_string(),
    },
    DatabaseCellValueData::DateTime(value) => match value.end {
      Some(end) => format!("{}/{}", value.start.to_rfc3339(), end.to_rfc3339()),
      None => value.start.to_rfc3339(),
    },
    DatabaseCellValueData::Files(value) => value
      .files
      .iter()
      .map(|file| file.name.as_deref().unwrap_or(file.blob_key.as_str()).to_string())
      .collect::<Vec<_>>()
      .join("; "),
    DatabaseCellValueData::UniqueId(value) => value.display.clone(),
    DatabaseCellValueData::MultiSelect(value) => value.join("; "),
    DatabaseCellValueData::Tags(value) => value.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "),
    DatabaseCellValueData::Users(value) => value.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "),
    DatabaseCellValueData::DocumentLink(value) => value.doc_id.to_string(),
    DatabaseCellValueData::Relation(value) => value.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "),
    DatabaseCellValueData::Rollup(value) => {
      let rendered = match &value.value {
        Some(DatabaseRollupScalarValue::Number(value)) => value.to_string(),
        Some(DatabaseRollupScalarValue::Text(value)) => value.clone(),
        Some(DatabaseRollupScalarValue::Currency(value)) => format!("{} {}", value.amount, value.currency_code),
        Some(DatabaseRollupScalarValue::Duration(value)) => format!("{} min", value.minutes),
        Some(DatabaseRollupScalarValue::Checkbox(value)) => value.to_string(),
        Some(DatabaseRollupScalarValue::Date(value)) => match value.end {
          Some(end) => format!("{}/{}", value.start, end),
          None => value.start.to_string(),
        },
        Some(DatabaseRollupScalarValue::TextList(value)) => value.join("; "),
        None => String::new(),
      };
      if value.stale_state == DatabaseRollupStaleState::Current {
        rendered
      } else if rendered.is_empty() {
        format!("[{}]", value.stale_state.as_str())
      } else {
        format!("{rendered} [{}]", value.stale_state.as_str())
      }
    }
    DatabaseCellValueData::Formula(value) => {
      let rendered = match &value.value {
        Some(DatabaseFormulaScalarValue::Number(value)) => value.to_string(),
        Some(DatabaseFormulaScalarValue::Percent(value)) => value.to_string(),
        Some(DatabaseFormulaScalarValue::Currency(value)) => format!("{} {}", value.amount, value.currency_code),
        Some(DatabaseFormulaScalarValue::Duration(value)) => value.minutes.to_string(),
        Some(DatabaseFormulaScalarValue::Text(value)) => value.clone(),
        Some(DatabaseFormulaScalarValue::Checkbox(value)) => value.to_string(),
        Some(DatabaseFormulaScalarValue::Date(value)) => match value.end {
          Some(end) => format!("{}/{}", value.start, end),
          None => value.start.to_string(),
        },
        Some(DatabaseFormulaScalarValue::DateTime(value)) => match value.end {
          Some(end) => format!("{}/{}", value.start.to_rfc3339(), end.to_rfc3339()),
          None => value.start.to_rfc3339(),
        },
        Some(DatabaseFormulaScalarValue::User(value)) => value.to_string(),
        Some(DatabaseFormulaScalarValue::Users(value)) => {
          value.iter().map(ToString::to_string).collect::<Vec<_>>().join("; ")
        }
        None => String::new(),
      };
      if value.stale_state == DatabaseFormulaStaleState::Current {
        rendered
      } else if rendered.is_empty() {
        format!("[{}]", value.stale_state.as_str())
      } else {
        format!("{rendered} [{}]", value.stale_state.as_str())
      }
    }
    DatabaseCellValueData::Url(value) | DatabaseCellValueData::Email(value) | DatabaseCellValueData::Phone(value) => {
      value.clone()
    }
    DatabaseCellValueData::CreatedTime(value) | DatabaseCellValueData::UpdatedTime(value) => value.to_rfc3339(),
    DatabaseCellValueData::CreatedBy(value) | DatabaseCellValueData::UpdatedBy(value) => value.to_string(),
  }
}
