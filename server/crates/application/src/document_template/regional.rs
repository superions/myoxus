// SPDX-License-Identifier: AGPL-3.0-or-later
//! Regional text projection for server-applied templates, not a token engine.
//! Chrono retains instant/timezone and ISO calendar ownership; ICU supplies the
//! same BCP-47/CLDR presentation family as the clients' native Intl formatters.

use chrono::{DateTime, Datelike, Utc};
use icu_datetime::{
  DateTimeFormatter, DateTimeFormatterPreferences,
  fieldsets::{E, YM, YMD},
  input::Date,
};
use icu_locale::Locale;

use super::DocumentTemplateError;
use crate::auth::EffectiveUserPreferences;

fn unavailable<T>(_: T) -> DocumentTemplateError {
  DocumentTemplateError::CreationUnavailable
}

pub(super) fn is_date_value(name: &str) -> bool {
  matches!(
    name,
    "date" | "date_long" | "weekday" | "week" | "calendar.iso_week_year" | "month" | "quarter" | "year" | "iso"
  )
}

pub(super) fn application_value(
  name: &str,
  instant: DateTime<Utc>,
  preferences: &EffectiveUserPreferences,
) -> Result<String, DocumentTemplateError> {
  let zone = preferences
    .timezone
    .parse::<chrono_tz::Tz>()
    .map_err(|_| DocumentTemplateError::CreationUnavailable)?;
  let local = instant.with_timezone(&zone);
  let date = Date::try_new_iso(local.year(), local.month() as u8, local.day() as u8)
    .map_err(|_| DocumentTemplateError::CreationUnavailable)?;
  let locale = preferences
    .locale
    .parse::<Locale>()
    .map_err(|_| DocumentTemplateError::CreationUnavailable)?;
  let prefs: DateTimeFormatterPreferences = locale.into();
  Ok(match name {
    "date" => date_value(instant, preferences)?,
    "date_long" => DateTimeFormatter::try_new(prefs, YMD::long())
      .map_err(unavailable)?
      .format(&date)
      .to_string(),
    "weekday" => DateTimeFormatter::try_new(prefs, E::long())
      .map_err(unavailable)?
      .format(&date)
      .to_string(),
    "month" => DateTimeFormatter::try_new(prefs, YM::long())
      .map_err(unavailable)?
      .format(&date)
      .to_string(),
    "week" => local.iso_week().week().to_string(),
    "calendar.iso_week_year" => local.iso_week().year().to_string(),
    "quarter" => format!("Q{} {}", (local.month() - 1) / 3 + 1, local.year()),
    "year" => local.year().to_string(),
    "iso" => local.format("%Y-%m-%d").to_string(),
    _ => return Err(DocumentTemplateError::UnresolvedVariables),
  })
}

fn date_value(instant: DateTime<Utc>, preferences: &EffectiveUserPreferences) -> Result<String, DocumentTemplateError> {
  crate::regional::date_value(instant, preferences).map_err(unavailable)
}

pub(super) fn creation_value(
  name: &str,
  value: &str,
  preferences: &EffectiveUserPreferences,
) -> Result<String, DocumentTemplateError> {
  let instant = DateTime::parse_from_rfc3339(value)
    .map_err(|_| DocumentTemplateError::CreationUnavailable)?
    .with_timezone(&Utc);
  match name {
    "document.created_at.date" => date_value(instant, preferences),
    "document.created_at.time" => time_value(instant, preferences),
    "document.created_at.datetime" => Ok(format!(
      "{}, {}",
      date_value(instant, preferences)?,
      time_value(instant, preferences)?
    )),
    _ => Err(DocumentTemplateError::UnresolvedVariables),
  }
}

/// Calendar inputs already contain the chosen day and clock time. Reuse the
/// regional formatters in UTC without interpreting that answer as a zoned instant.
pub(super) fn input_value(
  kind: super::inputs::InputKind,
  value: &str,
  preferences: &EffectiveUserPreferences,
) -> Result<String, DocumentTemplateError> {
  let instant = super::inputs::calendar_value(kind, value)?.and_utc();
  let mut calendar_preferences = preferences.clone();
  calendar_preferences.timezone = "UTC".to_string();
  let date = date_value(instant, &calendar_preferences)?;
  match kind {
    super::inputs::InputKind::Date => Ok(date),
    super::inputs::InputKind::DateTime => Ok(format!("{date}, {}", time_value(instant, &calendar_preferences)?)),
    super::inputs::InputKind::Text => Err(DocumentTemplateError::InvalidVariables),
  }
}

fn time_value(instant: DateTime<Utc>, preferences: &EffectiveUserPreferences) -> Result<String, DocumentTemplateError> {
  crate::regional::time_value(instant, preferences).map_err(unavailable)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::auth::{UserPreferenceDefaults, UserPreferences};

  fn preferences(locale: &str) -> EffectiveUserPreferences {
    UserPreferences {
      locale: Some(locale.into()),
      timezone: Some("Pacific/Kiritimati".into()),
      date_format: Some("year-month-day".into()),
      time_format: Some("24-hour".into()),
      ..Default::default()
    }
    .resolve(&UserPreferenceDefaults::default())
  }

  #[test]
  fn iso_week_and_year_share_the_effective_account_calendar_day() {
    let instant = "2021-01-04T00:30:00Z".parse::<DateTime<Utc>>().unwrap();
    for (zone, week, year) in [
      ("America/Los_Angeles", "53", "2020"),
      ("Pacific/Kiritimati", "1", "2021"),
    ] {
      let mut prefs = preferences("de-DE");
      prefs.timezone = zone.into();
      assert_eq!(application_value("week", instant, &prefs).unwrap(), week);
      assert_eq!(
        application_value("calendar.iso_week_year", instant, &prefs).unwrap(),
        year
      );
    }
  }

  #[test]
  fn regional_projection_uses_account_timezone_cldr_and_separate_creation_facts() {
    let instant = "2026-09-30T22:52:00Z".parse::<DateTime<Utc>>().unwrap();
    for (locale, long, weekday, month) in [
      ("en-US", "October 1, 2026", "Thursday", "October 2026"),
      ("de-DE", "1. Oktober 2026", "Donnerstag", "Oktober 2026"),
      ("fr-FR", "1 octobre 2026", "jeudi", "octobre 2026"),
      ("es-ES", "1 de octubre de 2026", "jueves", "octubre de 2026"),
    ] {
      let preferences = preferences(locale);
      for (name, expected) in [
        ("date", "2026-10-01"),
        ("date_long", long),
        ("weekday", weekday),
        ("month", month),
        ("week", "40"),
        ("quarter", "Q4 2026"),
        ("year", "2026"),
        ("iso", "2026-10-01"),
      ] {
        assert_eq!(
          application_value(name, instant, &preferences).unwrap(),
          expected,
          "{locale}/{name}"
        );
      }
      assert_eq!(
        creation_value("document.created_at.datetime", "2026-09-29T09:04:00Z", &preferences).unwrap(),
        "2026-09-29, 23:04",
        "creation must not use application instant"
      );
    }
    let mut prefs = preferences("en-US");
    prefs.time_format = "12-hour".into();
    let time = creation_value("document.created_at.time", "2026-09-29T09:04:00Z", &prefs).unwrap();
    assert!(time.starts_with("11:04") && time.ends_with("PM"), "{time}");
    prefs.timezone = "America/Los_Angeles".into();
    assert_eq!(application_value("date", instant, &prefs).unwrap(), "2026-09-30");
    prefs.timezone = "invented/zone".into();
    assert!(matches!(
      application_value("date", instant, &prefs),
      Err(DocumentTemplateError::CreationUnavailable)
    ));
  }

  #[test]
  fn manual_calendar_inputs_are_typed_and_do_not_shift_with_account_timezone() {
    use super::super::{DocumentTemplateVariable, inputs::InputKind, validate_template_variables};
    for zone in ["Pacific/Kiritimati", "America/Los_Angeles"] {
      let mut prefs = preferences("de-DE");
      prefs.timezone = zone.into();
      assert_eq!(
        input_value(InputKind::Date, "2026-12-31", &prefs).unwrap(),
        "2026-12-31"
      );
      assert_eq!(
        input_value(InputKind::DateTime, "2026-12-31 23:45:00", &prefs).unwrap(),
        "2026-12-31, 23:45"
      );
    }
    for (name, value) in [
      ("input.date.meeting", "2026-02-30"),
      ("input.date.meeting", "0000-01-01"),
      ("input.datetime.meeting", "2026-12-31 24:00:00"),
      ("input.datetime.meeting", "2026-12-31 23:59:60"),
      ("input.date.nested.name", "2026-12-31"),
    ] {
      let values = std::collections::HashMap::from([(name.into(), DocumentTemplateVariable::String(value.into()))]);
      assert!(validate_template_variables(&values).is_err(), "{name}/{value}");
    }
    validate_template_variables(&std::collections::HashMap::from([
      (
        "input.deadline".into(),
        DocumentTemplateVariable::String("next Thursday {{date}}".into()),
      ),
      (
        "input.date.meeting".into(),
        DocumentTemplateVariable::String("2028-02-29".into()),
      ),
      (
        "input.datetime.meeting".into(),
        DocumentTemplateVariable::String("2026-12-31 23:45:00".into()),
      ),
    ]))
    .unwrap();
  }
}
