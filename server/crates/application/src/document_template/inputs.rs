// SPDX-License-Identifier: AGPL-3.0-or-later
//! Admission of literal manual answers. The declared namespace is the type;
//! temporal answers are local calendar/clock values, not inferred instants.

use chrono::NaiveDateTime;

use super::DocumentTemplateError;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum InputKind {
  Text,
  Date,
  DateTime,
}

pub(super) fn kind(key: &str) -> Option<InputKind> {
  if key.len() > super::MAX_TEMPLATE_VARIABLE_NAME_BYTES {
    return None;
  }
  let name = key.strip_prefix("input.")?;
  let (kind, name) = match name.split_once('.') {
    Some((prefix, name)) if prefix.eq_ignore_ascii_case("date") => (InputKind::Date, name),
    Some((prefix, name)) if prefix.eq_ignore_ascii_case("datetime") => (InputKind::DateTime, name),
    Some(_) => return None,
    None => (InputKind::Text, name),
  };
  let mut chars = name.chars();
  (chars.next().is_some_and(|first| first.is_ascii_alphabetic())
    && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-')))
  .then_some(kind)
}

pub(super) fn calendar_value(kind: InputKind, value: &str) -> Result<NaiveDateTime, DocumentTemplateError> {
  let kind = match kind {
    InputKind::Text => yjs::document_field::InputKind::Text,
    InputKind::Date => yjs::document_field::InputKind::Date,
    InputKind::DateTime => yjs::document_field::InputKind::Datetime,
  };
  crate::document_fields::calendar_value(kind, value).map_err(|_| DocumentTemplateError::InvalidVariables)
}
