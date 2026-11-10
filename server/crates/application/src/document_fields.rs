// SPDX-License-Identifier: AGPL-3.0-or-later
//! Admission and presentation of native fields. Pure functions own value rules;
//! the explicit context resolver batches authorized facts for one operation.
//! Neither validation nor rendering synchronizes or mutates a document.

use std::collections::HashSet;

use chrono::{Datelike, NaiveDate, NaiveDateTime, Timelike};
use thiserror::Error;
use yjs::document_field::{DocumentField, InputDefinition, InputKind, InputValue};

use crate::auth::EffectiveUserPreferences;

pub mod context;
#[cfg(test)]
mod context_tests;
pub mod output;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum DocumentFieldError {
  #[error("invalid native document field")]
  InvalidField,
  #[error("document field formatting unavailable")]
  FormattingUnavailable,
  #[error("document field context unavailable")]
  ContextUnavailable,
}

/// Floating calendar/clock data, never a timestamp in the account's timezone.
pub fn calendar_value(kind: InputKind, value: &str) -> Result<NaiveDateTime, DocumentFieldError> {
  let invalid = || DocumentFieldError::InvalidField;
  let parsed = match kind {
    InputKind::Date if value.len() == 10 => NaiveDate::parse_from_str(value, "%Y-%m-%d")
      .map_err(|_| invalid())?
      .and_hms_opt(0, 0, 0)
      .ok_or_else(invalid)?,
    InputKind::Datetime if value.len() == 19 => {
      NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").map_err(|_| invalid())?
    }
    _ => return Err(invalid()),
  };
  let format = if kind == InputKind::Date {
    "%Y-%m-%d"
  } else {
    "%Y-%m-%d %H:%M:%S"
  };
  if parsed.year() < 1 || parsed.nanosecond() != 0 || parsed.format(format).to_string() != value {
    return Err(invalid());
  }
  Ok(parsed)
}

fn canonical_value(definition: &InputDefinition, value: &InputValue) -> Result<InputValue, DocumentFieldError> {
  let invalid = DocumentFieldError::InvalidField;
  match (definition.kind, value) {
    (InputKind::Text, InputValue::Scalar(_)) | (_, InputValue::Scalar(None)) => Ok(value.clone()),
    (kind @ (InputKind::Date | InputKind::Datetime), InputValue::Scalar(Some(value))) => {
      calendar_value(kind, value)?;
      Ok(InputValue::Scalar(Some(value.clone())))
    }
    (InputKind::SingleSelect, InputValue::Scalar(Some(id))) => {
      if !definition
        .options
        .as_ref()
        .is_some_and(|options| options.iter().any(|option| option.id == *id))
      {
        return Err(invalid);
      }
      Ok(value.clone())
    }
    (InputKind::MultiSelect, InputValue::Multiple(ids)) => {
      let options = definition.options.as_ref().ok_or(invalid)?;
      let selected: HashSet<_> = ids.iter().map(String::as_str).collect();
      if selected.iter().any(|id| !options.iter().any(|option| option.id == *id)) {
        return Err(invalid);
      }
      Ok(InputValue::Multiple(
        options
          .iter()
          .filter(|option| selected.contains(option.id.as_str()))
          .map(|option| option.id.clone())
          .collect(),
      ))
    }
    _ => Err(invalid),
  }
}

/// Admit unfinished answers and literal defaults without applying a template.
/// Returned multiple selections are deduplicated in authored option order; the
/// source definition and caller's value remain untouched. Defaults are validated,
/// not copied into an unanswered occurrence or rediscovered from another source.
pub fn validate(field: &DocumentField) -> Result<DocumentField, DocumentFieldError> {
  field.validate_shape().map_err(|_| DocumentFieldError::InvalidField)?;
  let mut canonical = field.clone();
  if let DocumentField::Input { definition, value, .. } = &mut canonical {
    if let Some(options) = &definition.options {
      let mut ids = HashSet::new();
      if options.iter().any(|option| !ids.insert(&option.id)) {
        return Err(DocumentFieldError::InvalidField);
      }
    }
    let default = definition
      .default
      .as_ref()
      .map(|value| canonical_value(definition, value))
      .transpose()?;
    *value = canonical_value(definition, value)?;
    definition.default = default;
  }
  Ok(canonical)
}

impl From<DocumentFieldError> for crate::auth::AuthError {
  fn from(error: DocumentFieldError) -> Self {
    match error {
      DocumentFieldError::InvalidField => Self::InvalidInput("MIX_DOCUMENT_FIELD_INVALID".into()),
      DocumentFieldError::FormattingUnavailable => Self::Storage("document field formatting unavailable".into()),
      DocumentFieldError::ContextUnavailable => Self::Storage("document field context unavailable".into()),
    }
  }
}

/// Explicit captured-content preparation only. Archival text and descriptors
/// remain frozen; live values/defaults become canonical without filling them.
pub fn normalize_snapshot(
  snapshot: &[u8],
) -> Result<yjs::document_field::content::FieldContentUpdate, DocumentFieldError> {
  yjs::document_field::content::map(snapshot, |run| {
    let field = validate(&run.descriptor).map_err(|_| "invalid native document field")?;
    if run.captured {
      Ok(run.clone())
    } else {
      run.with_descriptor(field)
    }
  })
  .map_err(|_| DocumentFieldError::InvalidField)
}

/// Read-side validation is non-mutating. It cannot turn malformed native data
/// into apparently current text or use a capture marker as metadata authority.
pub fn validate_snapshot(snapshot: &[u8]) -> Result<(), DocumentFieldError> {
  for occurrence in yjs::document_field::content::inspect(snapshot).map_err(|_| DocumentFieldError::InvalidField)? {
    validate(&occurrence.run.descriptor)?;
  }
  Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputPresentation {
  /// None is unset, not an error or an instruction to fill a default.
  /// Output/editor consumers supply their localized unset presentation.
  pub text: Option<String>,
  pub complete: bool,
}

pub fn present_input(
  field: &DocumentField,
  preferences: &EffectiveUserPreferences,
) -> Result<InputPresentation, DocumentFieldError> {
  let DocumentField::Input { definition, value, .. } = validate(field)? else {
    return Err(DocumentFieldError::InvalidField);
  };
  let text = match value {
    InputValue::Scalar(None) => None,
    InputValue::Multiple(ids) if ids.is_empty() => None,
    InputValue::Scalar(Some(value)) => Some(match definition.kind {
      InputKind::Text => value,
      kind @ (InputKind::Date | InputKind::Datetime) => {
        let instant = calendar_value(kind, &value)?.and_utc();
        let mut calendar_preferences = preferences.clone();
        calendar_preferences.timezone = "UTC".into();
        let date = crate::regional::date_value(instant, &calendar_preferences)
          .map_err(|_| DocumentFieldError::FormattingUnavailable)?;
        if kind == InputKind::Date {
          date
        } else {
          let time = crate::regional::time_value(instant, &calendar_preferences)
            .map_err(|_| DocumentFieldError::FormattingUnavailable)?;
          format!("{date}, {time}")
        }
      }
      InputKind::SingleSelect => definition
        .options
        .as_ref()
        .and_then(|options| options.iter().find(|option| option.id == value))
        .ok_or(DocumentFieldError::InvalidField)?
        .label
        .clone(),
      InputKind::MultiSelect => return Err(DocumentFieldError::InvalidField),
    }),
    InputValue::Multiple(ids) => Some(
      definition
        .options
        .as_ref()
        .ok_or(DocumentFieldError::InvalidField)?
        .iter()
        .filter(|option| ids.contains(&option.id))
        .map(|option| option.label.as_str())
        .collect::<Vec<_>>()
        .join(", "),
    ),
  };
  let complete = !definition.required || text.as_ref().is_some_and(|value| !value.is_empty());
  Ok(InputPresentation { text, complete })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::auth::{UserPreferenceDefaults, UserPreferences};

  fn field(index: usize) -> DocumentField {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
      "../../../../build/fixtures/contracts/document-fields.json"
    ))
    .unwrap();
    serde_json::from_value(fixtures["valid"][index].clone()).unwrap()
  }

  fn preferences(zone: &str) -> EffectiveUserPreferences {
    UserPreferences {
      locale: Some("de-DE".into()),
      timezone: Some(zone.into()),
      date_format: Some("year-month-day".into()),
      time_format: Some("24-hour".into()),
      ..Default::default()
    }
    .resolve(&UserPreferenceDefaults::default())
  }

  #[test]
  fn native_answers_are_literal_unfinished_or_canonical_option_ids_without_default_filling() {
    let prefs = preferences("America/Los_Angeles");
    let mut text = field(0);
    assert_eq!(
      present_input(&text, &prefs).unwrap(),
      InputPresentation {
        text: None,
        complete: false
      }
    );
    let DocumentField::Input { value, .. } = &mut text else {
      panic!("input")
    };
    *value = InputValue::Scalar(Some("  {{date}}  ".into()));
    assert_eq!(
      present_input(&text, &prefs).unwrap().text.as_deref(),
      Some("  {{date}}  ")
    );

    let mut multiple = field(4);
    let DocumentField::Input { value, definition, .. } = &mut multiple else {
      panic!("input")
    };
    *value = InputValue::Multiple(vec!["a".into(), "r".into(), "a".into()]);
    definition.default = Some(value.clone());
    let original = multiple.clone();
    let canonical = validate(&multiple).unwrap();
    let DocumentField::Input { value, definition, .. } = &canonical else {
      panic!("input")
    };
    assert_eq!(value, &InputValue::Multiple(vec!["r".into(), "a".into()]));
    assert_eq!(definition.default.as_ref(), Some(value));
    assert_eq!(present_input(&canonical, &prefs).unwrap().text.as_deref(), Some("R, A"));
    assert_eq!(multiple, original);
    let DocumentField::Input { value, .. } = &mut multiple else {
      panic!("input")
    };
    *value = InputValue::Multiple(vec![]);
    assert_eq!(
      present_input(&multiple, &prefs).unwrap(),
      InputPresentation {
        text: None,
        complete: false
      }
    );

    let mut selection = field(3);
    let DocumentField::Input { value, .. } = &mut selection else {
      panic!("input")
    };
    *value = InputValue::Scalar(Some("decision".into()));
    assert_eq!(
      present_input(&selection, &prefs).unwrap().text.as_deref(),
      Some("Beschluss")
    );
  }

  #[test]
  fn native_admission_rejects_invalid_defaults_dates_and_options_and_keeps_floating_clocks() {
    for index in [1, 2] {
      let mut temporal = field(index);
      let DocumentField::Input { definition, .. } = &mut temporal else {
        panic!("input")
      };
      let invalid = InputValue::Scalar(Some(
        if index == 1 {
          "2026-02-30"
        } else {
          "2026-12-31 23:59:60"
        }
        .into(),
      ));
      definition.default = Some(invalid.clone());
      assert!(validate(&temporal).is_err());
      let DocumentField::Input { definition, value, .. } = &mut temporal else {
        panic!("input")
      };
      definition.default = None;
      *value = invalid;
      assert!(validate(&temporal).is_err());
    }
    let mut selection = field(3);
    let DocumentField::Input { definition, .. } = &mut selection else {
      panic!("input")
    };
    definition.default = Some(InputValue::Scalar(Some("unknown".into())));
    assert!(validate(&selection).is_err());
    let DocumentField::Input { definition, .. } = &mut selection else {
      panic!("input")
    };
    definition.default = None;
    let duplicate = definition.options.as_ref().unwrap()[0].clone();
    definition.options.as_mut().unwrap().push(duplicate);
    assert!(validate(&selection).is_err());
    for zone in ["Pacific/Kiritimati", "America/Los_Angeles"] {
      let shown = present_input(&field(2), &preferences(zone)).unwrap();
      assert_eq!(shown.text.as_deref(), Some("2026-11-05, 13:45"));
    }
  }

  #[test]
  fn captured_content_normalizes_only_live_values_and_preserves_literal_and_archival_text() {
    use yrs::{GetString, Map, ReadTxn, Text, Transact, updates::decoder::Decode};
    let mut selection = field(4);
    let DocumentField::Input { value, .. } = &mut selection else {
      panic!("input")
    };
    *value = InputValue::Multiple(vec!["a".into(), "r".into(), "a".into()]);
    let attributes = yrs::types::Attrs::from([
      (
        "documentField".into(),
        yrs::Any::from_json(&serde_json::to_string(&selection).unwrap()).unwrap(),
      ),
      ("bold".into(), yrs::Any::Bool(true)),
    ]);
    let run = yjs::document_field::FieldRun::decode(" ", &attributes)
      .unwrap()
      .unwrap();
    let frozen = run
      .with_descriptor(selection.clone_occurrence("frozen".into()).unwrap())
      .unwrap()
      .freeze("Captured A, R 😀".into())
      .unwrap();
    let doc = yrs::Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let snapshot = {
      let mut tx = doc.transact_mut();
      let block = blocks.insert(&mut tx, "p", yrs::MapPrelim::default());
      block.insert(&mut tx, "sys:flavour", "myoxus:paragraph");
      let text = block.insert(&mut tx, "prop:text", yrs::TextPrelim::new("é😀 {{literal}} "));
      let end = text.len(&tx);
      text.insert_with_attributes(&mut tx, end, " ", attributes);
      text.insert_with_attributes(&mut tx, end + 1, &frozen.text, frozen.attributes.clone());
      tx.encode_state_as_update_v1(&Default::default())
    };
    let normalized = normalize_snapshot(&snapshot).unwrap();
    let delta = normalized
      .delta
      .expect("noncanonical live selection must produce a native delta");
    let merged = yjs::merge_updates(vec![snapshot, delta]).unwrap();
    assert_eq!(
      crate::doc::canonical_yjs_revision(&merged).unwrap(),
      crate::doc::canonical_yjs_revision(&normalized.state).unwrap(),
      "the acknowledged delta and prepared state must identify the same revision"
    );
    let occurrences = yjs::document_field::content::inspect(&merged).unwrap();
    let readback = yrs::Doc::new();
    readback
      .transact_mut()
      .apply_update(yrs::Update::decode_v1(&merged).unwrap())
      .unwrap();
    let txn = readback.transact();
    let yrs::Out::YMap(block) = txn.get_map("blocks").unwrap().get(&txn, "p").unwrap() else {
      panic!("paragraph")
    };
    let yrs::Out::YText(text) = block.get(&txn, "prop:text").unwrap() else {
      panic!("text")
    };
    assert_eq!(text.get_string(&txn), "é😀 {{literal}}  Captured A, R 😀");
    assert_eq!(occurrences.len(), 2);
    assert_eq!(occurrences[0].run.descriptor, validate(&selection).unwrap());
    assert_eq!(occurrences[0].run.attributes.get("bold"), Some(&yrs::Any::Bool(true)));
    assert_eq!(
      occurrences[1].run, frozen,
      "archival text and canonical restoration data stay immutable"
    );
    let unchanged = normalize_snapshot(&normalized.state).unwrap();
    assert!(
      unchanged.delta.is_none(),
      "canonical input must not generate refresh writes"
    );
    assert_eq!(unchanged.state, normalized.state);
    assert!(
      matches!(
        crate::doc::document_fragment_from_yjs(&normalized.state),
        Err(crate::auth::AuthError::InvalidInput(code)) if code == "MIX_DOCUMENT_MUTATION_UNSUPPORTED_NATIVE_FIELDS"
      ),
      "the reading-IR fragment bridge must not silently erase native fields"
    );
    let mut ordinary = yjs::YjsDocumentBuilder::new("Ordinary");
    ordinary.push_paragraph(&[yjs::YjsTextSegment::plain("é😀 {{literal}}")]);
    let ordinary = ordinary.encode();
    let unchanged = normalize_snapshot(&ordinary).unwrap();
    assert!(unchanged.delta.is_none());
    assert_eq!(unchanged.state, ordinary);
  }
}
