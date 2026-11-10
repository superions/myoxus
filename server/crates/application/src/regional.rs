// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared regional projection of actual instants. Floating input callers first
//! admit their calendar/clock value and explicitly select UTC presentation.

use chrono::{DateTime, Datelike, Timelike, Utc};
use icu_datetime::{
  DateTimeFormatter, DateTimeFormatterPreferences, NoCalendarFormatter,
  fieldsets::{T, YMD},
  input::{Date, Time},
  options::Alignment,
  preferences::HourCycle,
};
use icu_decimal::{DecimalFormatter, options::GroupingStrategy};
use icu_locale::Locale;

use crate::auth::EffectiveUserPreferences;

#[derive(Debug)]
pub(crate) struct RegionalFormatError;

fn unavailable<T>(_: T) -> RegionalFormatError {
  RegionalFormatError
}

pub(crate) fn date_value(
  instant: DateTime<Utc>,
  preferences: &EffectiveUserPreferences,
) -> Result<String, RegionalFormatError> {
  let zone = preferences.timezone.parse::<chrono_tz::Tz>().map_err(unavailable)?;
  let local = instant.with_timezone(&zone);
  let date = Date::try_new_iso(local.year(), local.month() as u8, local.day() as u8).map_err(unavailable)?;
  let locale = preferences.locale.parse::<Locale>().map_err(unavailable)?;
  let formatter = DateTimeFormatter::try_new((&locale).into(), YMD::medium()).map_err(unavailable)?;
  if preferences.date_format == "locale" {
    return Ok(formatter.format(&date).to_string());
  }
  // Keep explicit layouts on the locale's calendar and digits, like Core's Intl
  // owner, rather than silently forcing Latin digits and a Gregorian calendar.
  let calendar_date = date.to_calendar(formatter.calendar());
  let decimal = DecimalFormatter::try_new(locale.into(), GroupingStrategy::Never.into()).map_err(unavailable)?;
  let number = |value: i32, width| {
    let mut value = fixed_decimal::Decimal::from(value);
    value.pad_start(width);
    decimal.format(&value).to_string()
  };
  let day = number(calendar_date.day_of_month().0 as i32, 2);
  let month = number(calendar_date.month().ordinal as i32, 2);
  let year = number(calendar_date.year().extended_year(), 4);
  Ok(match preferences.date_format.as_str() {
    "day-month-year" => format!("{day}.{month}.{year}"),
    "month-day-year" => format!("{month}/{day}/{year}"),
    "year-month-day" => format!("{year}-{month}-{day}"),
    _ => return Err(RegionalFormatError),
  })
}

pub(crate) fn time_value(
  instant: DateTime<Utc>,
  preferences: &EffectiveUserPreferences,
) -> Result<String, RegionalFormatError> {
  let zone = preferences.timezone.parse::<chrono_tz::Tz>().map_err(unavailable)?;
  let local = instant.with_timezone(&zone);
  let locale = preferences.locale.parse::<Locale>().map_err(unavailable)?;
  let mut prefs: DateTimeFormatterPreferences = locale.into();
  prefs.hour_cycle = match preferences.time_format.as_str() {
    "locale" => prefs.hour_cycle,
    "12-hour" => Some(HourCycle::H12),
    "24-hour" => Some(HourCycle::H23),
    _ => return Err(RegionalFormatError),
  };
  let time = Time::try_new(local.hour() as u8, local.minute() as u8, 0, 0).map_err(unavailable)?;
  Ok(
    NoCalendarFormatter::try_new(prefs, T::hm().with_alignment(Alignment::Column))
      .map_err(unavailable)?
      .format(&time)
      .to_string(),
  )
}
