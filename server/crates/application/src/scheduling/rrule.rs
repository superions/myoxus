// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded RRULE import expansion. Civil stepping uses the pinned source zone;
//! the UTC entry point retains UTC interpretation for source without a zone.
//!
//! Unknown/unsupported forms return a typed error, not an empty series. Callers
//! retain the original payload and must not replace a failed window with partial
//! results. COUNT is never rewritten into a resource cap; EXDATE consumes COUNT.

use chrono::{DateTime, Datelike, Duration, Months, NaiveDate, NaiveDateTime, TimeZone, Utc, Weekday};
use myoxus_domain::scheduling::{CalculationBudget, CalculationError};

use super::ScanBudget;

/// Expand a preserved RRULE value (with optional `RRULE:` prefix) in `[from, to)`.
/// The result is complete and sorted, or fails without returning a partial window.
/// Duration is elapsed UTC time; this legacy import entry point does not infer a zone.
pub fn expand_rrule(
  rrule: &str,
  dtstart: DateTime<Utc>,
  duration: Duration,
  from: DateTime<Utc>,
  to: DateTime<Utc>,
  exdates: &[DateTime<Utc>],
  budget: CalculationBudget,
) -> Result<Vec<(DateTime<Utc>, DateTime<Utc>)>, CalculationError> {
  expand_zoned_rrule(rrule, dtstart, duration, from, to, exdates, chrono_tz::UTC, budget)
}

/// Expand imported civil time without losing COUNT/UNTIL. Gaps are omitted
/// without consuming COUNT; folds select the earlier instant, like native rules.
#[allow(clippy::too_many_arguments)]
pub fn expand_zoned_rrule(
  rrule: &str,
  dtstart: DateTime<Utc>,
  duration: Duration,
  from: DateTime<Utc>,
  to: DateTime<Utc>,
  exdates: &[DateTime<Utc>],
  zone: chrono_tz::Tz,
  budget: CalculationBudget,
) -> Result<Vec<(DateTime<Utc>, DateTime<Utc>)>, CalculationError> {
  Ok(scan_rrule(rrule, dtstart, duration, from, to, exdates, zone, budget, None)?.results)
}

/// Find one original imported slot in `[from, ∞)` using the same COUNT/UNTIL,
/// gap/fold and bounded scan as Calendar projection. Exhaustion is an error,
/// never an invented finite horizon or a silently empty series.
pub fn next_zoned_rrule(
  rrule: &str,
  dtstart: DateTime<Utc>,
  from: DateTime<Utc>,
  before: Option<DateTime<Utc>>,
  zone: chrono_tz::Tz,
  budget: CalculationBudget,
  accept: &dyn Fn(DateTime<Utc>) -> bool,
) -> Result<Option<DateTime<Utc>>, CalculationError> {
  Ok(
    scan_rrule(
      rrule,
      dtstart,
      Duration::zero(),
      from,
      before.unwrap_or(DateTime::<Utc>::MAX_UTC - Duration::days(4)),
      &[],
      zone,
      budget,
      Some(accept),
    )?
    .results
    .first()
    .map(|(start, _)| *start),
  )
}

struct Expansion {
  results: Vec<(DateTime<Utc>, DateTime<Utc>)>,
  count: u64,
}

pub struct SplitRRule {
  pub head: String,
  pub tail: String,
  /// Counts original slots, including EXDATE but excluding invalid civil times.
  pub before: u64,
}

#[allow(clippy::too_many_arguments)]
fn scan_rrule(
  rrule: &str,
  dtstart: DateTime<Utc>,
  duration: Duration,
  from: DateTime<Utc>,
  to: DateTime<Utc>,
  exdates: &[DateTime<Utc>],
  zone: chrono_tz::Tz,
  budget: CalculationBudget,
  first_accept: Option<&dyn Fn(DateTime<Utc>) -> bool>,
) -> Result<Expansion, CalculationError> {
  if from >= to || duration < Duration::zero() {
    return Err(CalculationError::InvalidWindow);
  }
  let mut budget = ScanBudget::new(budget)?;
  // Bound parsing and exclusion lookup as well as period iteration. A failure
  // never changes the preserved source COUNT or marks the series exhausted.
  if exdates.len() > budget.remaining {
    return Err(CalculationError::ScanBudgetExceeded);
  }
  budget.remaining -= exdates.len();
  let exdates: std::collections::BTreeSet<_> = exdates.iter().copied().collect();
  let rule = parse_rrule(rrule)?;
  let mut results = Vec::new();
  let mut occurrence_count = 0u64;
  let anchor = dtstart.with_timezone(&zone).naive_local().and_utc();
  let mut cursor = anchor;
  // A civil period can straddle the UTC window boundary. The padding is only
  // for scanning; returned instances still satisfy the exact requested bounds.
  let scan_to = to
    .with_timezone(&zone)
    .naive_local()
    .and_utc()
    .checked_add_signed(Duration::days(2))
    .ok_or(CalculationError::DateOutOfRange)?;
  loop {
    let floor = period_floor(&rule, cursor)?;
    if rule.count.is_some_and(|count| occurrence_count >= count) || floor >= scan_to {
      break;
    }
    budget.scan()?;
    for civil in expand_candidates(&rule, cursor, anchor)? {
      budget.scan()?;
      let Some(candidate) = zone
        .from_local_datetime(&civil.naive_utc())
        .earliest()
        .map(|value| value.with_timezone(&Utc))
      else {
        continue;
      };
      if candidate < dtstart {
        continue;
      }
      if rule.count.is_some_and(|count| occurrence_count >= count)
        || rule.until.as_ref().is_some_and(|until| match until {
          Until::Utc(until) => candidate > *until,
          Until::Civil(until) => civil > *until,
          Until::Date(until) => civil.date_naive() > *until,
        })
        || candidate >= to
      {
        return Ok(Expansion {
          results,
          count: occurrence_count,
        });
      }
      occurrence_count += 1;
      if candidate >= from
        && candidate < to
        && !exdates.contains(&candidate)
        && first_accept.is_none_or(|accept| accept(candidate))
      {
        let end = candidate
          .checked_add_signed(duration)
          .ok_or(CalculationError::DateOutOfRange)?;
        budget.push(&mut results, (candidate, end))?;
        if first_accept.is_some() {
          return Ok(Expansion {
            results,
            count: occurrence_count,
          });
        }
      }
    }
    if rule.count.is_some_and(|count| occurrence_count >= count) {
      break;
    }
    cursor = advance_cursor(&rule, cursor)?;
  }
  results.sort_unstable_by_key(|(start, _)| *start);
  Ok(Expansion {
    results,
    count: occurrence_count,
  })
}

/// Split at a real original slot. Counting ignores EXDATE (which consumes COUNT)
/// but not invalid civil dates/gaps. Historical counting stores no full backlog.
pub fn split_imported_rrule(
  raw: &str,
  dtstart: DateTime<Utc>,
  at: DateTime<Utc>,
  all_day: bool,
  zone: chrono_tz::Tz,
) -> Result<SplitRRule, CalculationError> {
  let rule = parse_rrule(raw)?;
  let after = at
    .checked_add_signed(Duration::microseconds(1))
    .ok_or(CalculationError::DateOutOfRange)?;
  let slot = expand_zoned_rrule(
    raw,
    dtstart,
    Duration::zero(),
    at,
    after,
    &[],
    zone,
    CalculationBudget::default(),
  )?;
  if !slot.iter().any(|(start, _)| *start == at) {
    return Err(CalculationError::InvalidRule);
  }
  let before = scan_rrule(
    raw,
    dtstart,
    Duration::zero(),
    at.checked_sub_signed(Duration::microseconds(1))
      .ok_or(CalculationError::DateOutOfRange)?,
    at,
    &[],
    zone,
    CalculationBudget::default(),
    None,
  )?
  .count;
  let raw = raw.trim();
  let body = if raw.get(..6).is_some_and(|prefix| prefix.eq_ignore_ascii_case("RRULE:")) {
    &raw[6..]
  } else {
    raw
  };
  let without = |keys: &[&str]| {
    body
      .split(';')
      .filter(|part| {
        !part
          .split_once('=')
          .is_some_and(|(key, _)| keys.iter().any(|excluded| key.eq_ignore_ascii_case(excluded)))
      })
      .collect::<Vec<_>>()
      .join(";")
  };
  let cutoff = at
    .checked_sub_signed(Duration::microseconds(1))
    .ok_or(CalculationError::DateOutOfRange)?;
  let head = if rule.count.is_some() && before > 0 {
    format!("{};COUNT={before}", without(&["COUNT"]))
  } else {
    format!(
      "{};UNTIL={}",
      without(&["COUNT", "UNTIL"]),
      if all_day {
        cutoff.format("%Y%m%d").to_string()
      } else {
        cutoff.format("%Y%m%dT%H%M%SZ").to_string()
      }
    )
  };
  let tail = if let Some(count) = rule.count {
    format!(
      "{};COUNT={}",
      without(&["COUNT"]),
      count
        .checked_sub(before)
        .filter(|count| *count > 0)
        .ok_or(CalculationError::InvalidRule)?
    )
  } else {
    body.to_owned()
  };
  Ok(SplitRRule { head, tail, before })
}

/// Replace COUNT with a temporary UNTIL only while the finite source still has
/// remaining slots. A late pause must not resurrect an already exhausted COUNT.
pub fn limit_export_rrule(
  raw: &str,
  start: DateTime<Utc>,
  cutoff: Option<DateTime<Utc>>,
  all_day: bool,
  zone: chrono_tz::Tz,
) -> Result<String, CalculationError> {
  let Some(cutoff) = cutoff else {
    return Ok(raw.to_owned());
  };
  let rule = parse_rrule(raw)?;
  let until = cutoff
    .checked_sub_signed(Duration::microseconds(1))
    .ok_or(CalculationError::DateOutOfRange)?;
  if rule.until.as_ref().is_some_and(|end| match end {
    Until::Utc(end) => *end <= until,
    Until::Civil(end) => *end <= until.with_timezone(&zone).naive_local().and_utc(),
    Until::Date(end) => *end <= until.date_naive(),
  }) {
    return Ok(raw.to_owned());
  }
  if let Some(count) = rule.count {
    let before = scan_rrule(
      raw,
      start,
      Duration::zero(),
      until,
      cutoff,
      &[],
      zone,
      CalculationBudget::default(),
      None,
    )?
    .count;
    if before >= count {
      return Ok(raw.to_owned());
    }
  }
  let body = raw
    .strip_prefix("RRULE:")
    .unwrap_or(raw)
    .split(';')
    .filter(|part| {
      !part
        .split_once('=')
        .is_some_and(|(key, _)| key.eq_ignore_ascii_case("COUNT") || key.eq_ignore_ascii_case("UNTIL"))
    })
    .collect::<Vec<_>>()
    .join(";");
  Ok(format!(
    "{body};UNTIL={}",
    until.format(if all_day { "%Y%m%d" } else { "%Y%m%dT%H%M%SZ" })
  ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Freq {
  Daily,
  Weekly,
  Monthly,
  Yearly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ByDay {
  ordinal: Option<i32>,
  weekday: Weekday,
}

struct ParsedRRule {
  freq: Freq,
  interval: u32,
  count: Option<u64>,
  until: Option<Until>,
  byday: Vec<ByDay>,
  bymonth: Vec<u32>,
  bymonthday: Vec<i32>,
}

enum Until {
  Utc(DateTime<Utc>),
  Civil(DateTime<Utc>),
  Date(NaiveDate),
}

fn parse_rrule(raw: &str) -> Result<ParsedRRule, CalculationError> {
  // iCalendar identifiers/date tokens are ASCII. Check before any byte slicing;
  // malformed provider input must not panic or enter diagnostic messages.
  if raw.len() > 8_192 {
    return Err(CalculationError::ScanBudgetExceeded);
  }
  if !raw.is_ascii() {
    return Err(CalculationError::InvalidRule);
  }
  let raw = raw.trim();
  let body = if raw.get(..6).is_some_and(|prefix| prefix.eq_ignore_ascii_case("RRULE:")) {
    &raw[6..]
  } else {
    raw
  };
  let mut freq = None;
  let mut interval = 1;
  let mut count = None;
  let mut until = None;
  let mut byday = Vec::new();
  let mut bymonth = Vec::new();
  let mut bymonthday = Vec::new();
  let mut seen = std::collections::BTreeSet::new();
  for part in body.split(';') {
    let (key, val) = part.split_once('=').ok_or(CalculationError::InvalidRule)?;
    let key = key.trim().to_ascii_uppercase();
    let val = val.trim();
    if !seen.insert(key.clone()) || val.is_empty() {
      return Err(CalculationError::InvalidRule);
    }
    match key.as_str() {
      "FREQ" => {
        freq = Some(match val.to_ascii_uppercase().as_str() {
          "DAILY" => Freq::Daily,
          "WEEKLY" => Freq::Weekly,
          "MONTHLY" => Freq::Monthly,
          "YEARLY" => Freq::Yearly,
          _ => return Err(CalculationError::UnsupportedRule),
        });
      }
      "INTERVAL" => {
        interval = val.parse().map_err(|_| CalculationError::InvalidRule)?;
        if interval == 0 {
          return Err(CalculationError::InvalidRule);
        }
      }
      "COUNT" => {
        let value: u64 = val.parse().map_err(|_| CalculationError::InvalidRule)?;
        if value == 0 {
          return Err(CalculationError::InvalidRule);
        }
        count = Some(value);
      }
      "UNTIL" => until = Some(parse_until(val).ok_or(CalculationError::InvalidRule)?),
      "BYDAY" => {
        for token in val.split(',') {
          byday.push(parse_byday(token.trim()).ok_or(CalculationError::UnsupportedRule)?);
        }
      }
      "BYMONTH" => {
        for token in val.split(',') {
          let month = token.trim().parse().map_err(|_| CalculationError::InvalidRule)?;
          if !(1..=12).contains(&month) {
            return Err(CalculationError::InvalidRule);
          }
          bymonth.push(month);
        }
      }
      "BYMONTHDAY" => {
        for token in val.split(',') {
          let day: i32 = token.trim().parse().map_err(|_| CalculationError::InvalidRule)?;
          if day == 0 || !(-31..=31).contains(&day) {
            return Err(CalculationError::InvalidRule);
          }
          bymonthday.push(day);
        }
      }
      "WKST" if val.eq_ignore_ascii_case("MO") => {}
      _ => return Err(CalculationError::UnsupportedRule),
    }
  }
  let freq = freq.ok_or(CalculationError::InvalidRule)?;
  if count.is_some() && until.is_some() {
    return Err(CalculationError::InvalidRule);
  }
  // Do not pretend to implement imported intersections/filters that the legacy
  // expander ignored or treated as unions. Preserve those forms as unsupported.
  if (!bymonth.is_empty() && freq != Freq::Yearly)
    || (!bymonthday.is_empty() && matches!(freq, Freq::Daily | Freq::Weekly))
    || (!byday.is_empty() && !bymonthday.is_empty())
    || (byday.iter().any(|day| day.ordinal.is_some()) && matches!(freq, Freq::Daily | Freq::Weekly))
  {
    return Err(CalculationError::UnsupportedRule);
  }
  bymonth.sort_unstable();
  bymonth.dedup();
  bymonthday.sort_unstable();
  bymonthday.dedup();
  byday.sort_unstable_by_key(|day| (day.weekday.num_days_from_monday(), day.ordinal));
  byday.dedup();
  Ok(ParsedRRule {
    freq,
    interval,
    count,
    until,
    byday,
    bymonth,
    bymonthday,
  })
}

/// Bounded source validation without expanding or consuming a Calendar slot.
pub fn validate_imported_rrule(raw: &str) -> Result<(), CalculationError> {
  parse_rrule(raw).map(|_| ())
}

/// Standard RRULE projection of a confirmed native rule. Civil DTSTART/TZID is
/// carried by the event; this string is never independently edited or parsed
/// back over its canonical definition by a native writer.
pub fn project_native_rrule(rule: &myoxus_domain::scheduling::RecurrenceRule) -> Result<String, CalculationError> {
  use myoxus_domain::scheduling::{MonthDay, RecurrenceSelector, ScheduleValue};
  rule.validate()?;
  let selector = match &rule.selector {
    RecurrenceSelector::Daily => "FREQ=DAILY".to_owned(),
    RecurrenceSelector::Weekly { weekdays } => format!(
      "FREQ=WEEKLY;BYDAY={}",
      weekdays
        .iter()
        .map(|day| match day {
          Weekday::Mon => "MO",
          Weekday::Tue => "TU",
          Weekday::Wed => "WE",
          Weekday::Thu => "TH",
          Weekday::Fri => "FR",
          Weekday::Sat => "SA",
          Weekday::Sun => "SU",
        })
        .collect::<Vec<_>>()
        .join(",")
    ),
    RecurrenceSelector::Monthly { day } => format!(
      "FREQ=MONTHLY;BYMONTHDAY={}",
      match day {
        MonthDay::Day(day) => day.to_string(),
        MonthDay::Last => "-1".to_owned(),
      }
    ),
    RecurrenceSelector::Yearly { month, day } => format!("FREQ=YEARLY;BYMONTH={month};BYMONTHDAY={day}"),
  };
  let mut result = format!("{selector};INTERVAL={}", rule.interval);
  if let Some(end) = rule.end {
    let until = match end {
      ScheduleValue::Date(date) => date.format("%Y%m%d").to_string(),
      ScheduleValue::LocalDateTime(local) => {
        let zone = rule.zone.timezone();
        // No real occurrence exists inside a gap: the inclusive cutoff is the
        // last real second before it, not an invented local timestamp/offset.
        let instant = zone
          .from_local_datetime(&local)
          .earliest()
          .map(|value| value.with_timezone(&Utc))
          .or_else(|| {
            chrono_tz::GapInfo::new(&local, &zone)
              .and_then(|gap| gap.end)
              .map(|end| end.with_timezone(&Utc) - Duration::seconds(1))
          })
          .ok_or(CalculationError::DateOutOfRange)?;
        instant.format("%Y%m%dT%H%M%SZ").to_string()
      }
    };
    result.push_str(";UNTIL=");
    result.push_str(&until);
  }
  Ok(result)
}

/// Calendar's finite source boundary may precede DTSTART (an empty split head).
/// Keep that separate from the validated authored rule and emit standard UNTIL.
pub fn project_calendar_rrule(
  rule: &myoxus_domain::scheduling::RecurrenceRule,
  ends_before: Option<DateTime<Utc>>,
) -> Result<String, CalculationError> {
  let raw = project_native_rrule(rule)?;
  let Some(cutoff) = ends_before else { return Ok(raw) };
  let cutoff = cutoff
    .checked_sub_signed(Duration::microseconds(1))
    .ok_or(CalculationError::DateOutOfRange)?;
  if parse_rrule(&raw)?.until.is_some_and(|end| match end {
    Until::Date(date) => date <= cutoff.date_naive(),
    Until::Utc(instant) => instant <= cutoff,
    Until::Civil(_) => false,
  }) {
    return Ok(raw);
  }
  let until = if matches!(rule.start, myoxus_domain::scheduling::ScheduleValue::Date(_)) {
    cutoff.format("%Y%m%d").to_string()
  } else {
    cutoff.format("%Y%m%dT%H%M%SZ").to_string()
  };
  Ok(format!(
    "{};UNTIL={until}",
    raw
      .split(';')
      .filter(|part| !part.starts_with("UNTIL="))
      .collect::<Vec<_>>()
      .join(";")
  ))
}

fn parse_until(value: &str) -> Option<Until> {
  if value.len() == 8 {
    return NaiveDate::parse_from_str(value, "%Y%m%d").ok().map(Until::Date);
  }
  let utc = value.ends_with('Z');
  let value = value.strip_suffix('Z').unwrap_or(value);
  if value.len() != 15 {
    return None;
  }
  NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok().map(|date| {
    if utc {
      Until::Utc(date.and_utc())
    } else {
      Until::Civil(date.and_utc())
    }
  })
}

fn parse_byday(token: &str) -> Option<ByDay> {
  if token.len() < 2 {
    return None;
  }
  let (prefix, weekday) = token.split_at(token.len() - 2);
  let weekday = match weekday.to_ascii_uppercase().as_str() {
    "MO" => Weekday::Mon,
    "TU" => Weekday::Tue,
    "WE" => Weekday::Wed,
    "TH" => Weekday::Thu,
    "FR" => Weekday::Fri,
    "SA" => Weekday::Sat,
    "SU" => Weekday::Sun,
    _ => return None,
  };
  let ordinal = if prefix.is_empty() {
    None
  } else {
    let ordinal: i32 = prefix.parse().ok()?;
    if ordinal == 0 || !(-5..=5).contains(&ordinal) {
      return None;
    }
    Some(ordinal)
  };
  Some(ByDay { ordinal, weekday })
}

fn period_floor(rule: &ParsedRRule, cursor: DateTime<Utc>) -> Result<DateTime<Utc>, CalculationError> {
  match rule.freq {
    Freq::Daily => Ok(cursor),
    Freq::Weekly => cursor
      .checked_sub_signed(Duration::days(i64::from(cursor.weekday().num_days_from_monday())))
      .ok_or(CalculationError::DateOutOfRange),
    Freq::Monthly => cursor.with_day(1).ok_or(CalculationError::DateOutOfRange),
    Freq::Yearly => cursor
      .with_day(1)
      .and_then(|date| date.with_month(1))
      .ok_or(CalculationError::DateOutOfRange),
  }
}

fn expand_candidates(
  rule: &ParsedRRule,
  cursor: DateTime<Utc>,
  anchor: DateTime<Utc>,
) -> Result<Vec<DateTime<Utc>>, CalculationError> {
  let mut candidates = match rule.freq {
    Freq::Daily => {
      if rule.byday.is_empty() || rule.byday.iter().any(|day| day.weekday == cursor.weekday()) {
        vec![cursor]
      } else {
        Vec::new()
      }
    }
    Freq::Weekly => {
      if rule.byday.is_empty() {
        vec![cursor]
      } else {
        let monday = period_floor(rule, cursor)?;
        rule
          .byday
          .iter()
          .map(|day| {
            monday
              .checked_add_signed(Duration::days(i64::from(day.weekday.num_days_from_monday())))
              .ok_or(CalculationError::DateOutOfRange)
          })
          .collect::<Result<Vec<_>, _>>()?
      }
    }
    Freq::Monthly => expand_monthly(rule, cursor, anchor.day()),
    Freq::Yearly => {
      let months = if rule.bymonth.is_empty() {
        vec![anchor.month()]
      } else {
        rule.bymonth.clone()
      };
      let mut results = Vec::new();
      for month in months {
        if rule.byday.is_empty() && rule.bymonthday.is_empty() {
          if let Some(date) = NaiveDate::from_ymd_opt(cursor.year(), month, anchor.day()) {
            results.push(Utc.from_utc_datetime(&date.and_time(cursor.time())));
          }
        } else if let Some(date) = NaiveDate::from_ymd_opt(cursor.year(), month, 1) {
          results.extend(expand_monthly(
            rule,
            Utc.from_utc_datetime(&date.and_time(cursor.time())),
            anchor.day(),
          ));
        }
      }
      results
    }
  };
  candidates.sort_unstable();
  candidates.dedup();
  Ok(candidates)
}

fn expand_monthly(rule: &ParsedRRule, cursor: DateTime<Utc>, anchor_day: u32) -> Vec<DateTime<Utc>> {
  if rule.byday.is_empty() && rule.bymonthday.is_empty() {
    return cursor.with_day(anchor_day).into_iter().collect();
  }
  let mut results = Vec::new();
  for day in &rule.bymonthday {
    let day = if *day > 0 {
      *day as u32
    } else {
      let last = (28..=31)
        .rev()
        .find(|day| cursor.date_naive().with_day(*day).is_some())
        .unwrap();
      (last as i32 + day + 1).max(0) as u32
    };
    if let Some(date) = cursor.date_naive().with_day(day) {
      results.push(Utc.from_utc_datetime(&date.and_time(cursor.time())));
    }
  }
  for byday in &rule.byday {
    let matches: Vec<_> = (1..=31)
      .filter_map(|day| cursor.date_naive().with_day(day))
      .filter(|date| date.weekday() == byday.weekday)
      .collect();
    if let Some(ordinal) = byday.ordinal {
      let index = if ordinal > 0 {
        Some((ordinal - 1) as usize)
      } else {
        matches.len().checked_sub((-ordinal) as usize)
      };
      if let Some(date) = index.and_then(|index| matches.get(index)) {
        results.push(Utc.from_utc_datetime(&date.and_time(cursor.time())));
      }
    } else {
      results.extend(
        matches
          .into_iter()
          .map(|date| Utc.from_utc_datetime(&date.and_time(cursor.time()))),
      );
    }
  }
  results
}

fn advance_cursor(rule: &ParsedRRule, cursor: DateTime<Utc>) -> Result<DateTime<Utc>, CalculationError> {
  let interval = i64::from(rule.interval);
  let next = match rule.freq {
    Freq::Daily => cursor.checked_add_signed(Duration::days(interval)),
    Freq::Weekly => cursor.checked_add_signed(Duration::weeks(interval)),
    Freq::Monthly => cursor
      .with_day(1)
      .and_then(|cursor| cursor.checked_add_months(Months::new(rule.interval))),
    Freq::Yearly => rule.interval.checked_mul(12).and_then(|months| {
      cursor
        .with_day(1)
        .and_then(|date| date.with_month(1))
        .and_then(|cursor| cursor.checked_add_months(Months::new(months)))
    }),
  };
  next.ok_or(CalculationError::DateOutOfRange)
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::Timelike;

  fn dt(year: i32, month: u32, day: u32, hour: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(year, month, day, hour, 0, 0).unwrap()
  }

  #[test]
  fn rrule_weekly_expansion() {
    let start = dt(2025, 1, 6, 9);
    let instances = expand_rrule(
      "FREQ=WEEKLY;COUNT=10",
      start,
      Duration::hours(1),
      start,
      start + Duration::weeks(20),
      &[],
      CalculationBudget::default(),
    )
    .unwrap();
    assert_eq!(instances.len(), 10);
    for pair in instances.windows(2) {
      assert_eq!(pair[1].0 - pair[0].0, Duration::weeks(1));
    }
  }

  #[test]
  fn rrule_monthly_byday() {
    let start = dt(2025, 1, 13, 10);
    let instances = expand_rrule(
      "FREQ=MONTHLY;BYDAY=2MO;COUNT=3",
      start,
      Duration::hours(1),
      start,
      start + Duration::days(120),
      &[],
      CalculationBudget::default(),
    )
    .unwrap();
    assert_eq!(
      instances.iter().map(|pair| pair.0).collect::<Vec<_>>(),
      vec![dt(2025, 1, 13, 10), dt(2025, 2, 10, 10), dt(2025, 3, 10, 10)]
    );
  }

  #[test]
  fn rrule_exdate_excluded() {
    let start = dt(2025, 6, 2, 9);
    let excluded = dt(2025, 6, 9, 9);
    let instances = expand_rrule(
      "FREQ=WEEKLY;COUNT=4",
      start,
      Duration::hours(1),
      start,
      start + Duration::weeks(5),
      &[excluded],
      CalculationBudget::default(),
    )
    .unwrap();
    assert_eq!(
      instances.len(),
      3,
      "EXDATE consumes COUNT but does not create an instance"
    );
    assert!(!instances.iter().any(|pair| pair.0 == excluded));
  }

  #[test]
  fn rrule_until_boundary() {
    let start = dt(2025, 3, 1, 8);
    let instances = expand_rrule(
      "FREQ=DAILY;UNTIL=20250310T080000Z",
      start,
      Duration::hours(1),
      start,
      start + Duration::days(30),
      &[],
      CalculationBudget::default(),
    )
    .unwrap();
    assert_eq!(instances.len(), 10);
    assert_eq!(instances.last().unwrap().0, dt(2025, 3, 10, 8), "UNTIL is inclusive");
  }

  #[test]
  fn rrule_count_limits_expansion() {
    let start = dt(2025, 1, 1, 9);
    let instances = expand_rrule(
      "FREQ=DAILY;COUNT=1200",
      start,
      Duration::hours(1),
      start + Duration::days(1095),
      start + Duration::days(1300),
      &[],
      CalculationBudget::default(),
    )
    .unwrap();
    assert_eq!(
      instances.len(),
      105,
      "continuing COUNT must survive windows beyond two years"
    );
    assert_eq!(instances.last().unwrap().0, start + Duration::days(1199));
    assert_eq!(
      (
        next_zoned_rrule(
          "FREQ=DAILY;COUNT=1200",
          start,
          start + Duration::days(1095),
          None,
          chrono_tz::UTC,
          CalculationBudget::default(),
          &|_| true
        )
        .unwrap(),
        next_zoned_rrule(
          "FREQ=DAILY;COUNT=1200",
          start,
          start + Duration::days(1200),
          None,
          chrono_tz::UTC,
          CalculationBudget::default(),
          &|_| true
        )
        .unwrap(),
      ),
      (instances.first().map(|(start, _)| *start), None),
      "next delivery has no two-year horizon and still respects exhausted COUNT"
    );
    assert_eq!(
      limit_export_rrule(
        "FREQ=DAILY;COUNT=1200",
        start,
        Some(start + Duration::days(1400)),
        false,
        chrono_tz::UTC
      )
      .unwrap(),
      "FREQ=DAILY;COUNT=1200",
      "a late pause must not replace an exhausted COUNT with a later UNTIL"
    );
  }

  #[test]
  fn rrule_budgets_do_not_shorten_count_or_hide_unsupported_imports() {
    let start = dt(2025, 1, 1, 9);
    let instances = expand_rrule(
      "FREQ=DAILY;COUNT=100000",
      start,
      Duration::hours(1),
      start + Duration::days(10000),
      start + Duration::days(10002),
      &[],
      CalculationBudget::default(),
    )
    .unwrap();
    assert_eq!(
      instances.len(),
      2,
      "the old 10,000 COUNT cap must not truncate the source rule"
    );
    let result = expand_rrule(
      "FREQ=DAILY;COUNT=100000",
      start,
      Duration::hours(1),
      start,
      start + Duration::days(10002),
      &[],
      CalculationBudget::default(),
    );
    assert_eq!(result, Err(CalculationError::ResultBudgetExceeded));
    assert_eq!(
      expand_rrule(
        "FREQ=DAILY",
        start,
        Duration::hours(1),
        start,
        start + Duration::days(10),
        &[],
        CalculationBudget { scans: 2, results: 10 }
      ),
      Err(CalculationError::ScanBudgetExceeded)
    );
    assert_eq!(
      expand_rrule(
        "FREQ=MONTHLY;BYSETPOS=1",
        start,
        Duration::hours(1),
        start,
        start + Duration::days(10),
        &[],
        CalculationBudget::default()
      ),
      Err(CalculationError::UnsupportedRule)
    );
    assert_eq!(
      expand_rrule(
        "FREQ=DAILY;UNTIL=20240101",
        start,
        Duration::hours(1),
        start,
        start + Duration::days(10),
        &[],
        CalculationBudget::default()
      )
      .unwrap(),
      vec![]
    );
  }

  #[test]
  fn rrule_until_floating_time() {
    let start = dt(2026, 1, 1, 9);
    let instances = expand_rrule(
      "FREQ=DAILY;UNTIL=20261231T235959",
      start,
      Duration::hours(1),
      start,
      dt(2027, 6, 1, 0),
      &[],
      CalculationBudget::default(),
    )
    .unwrap();
    assert_eq!(instances.len(), 365);
    assert_eq!(instances.last().unwrap().0, dt(2026, 12, 31, 9));
  }

  #[test]
  fn rrule_timezone_aware() {
    let start = Utc.with_ymd_and_hms(2031, 3, 23, 8, 0, 0).unwrap();
    let instances = expand_zoned_rrule(
      "FREQ=WEEKLY;COUNT=3",
      start,
      Duration::hours(2),
      start,
      start + Duration::weeks(4),
      &[],
      chrono_tz::Europe::Berlin,
      CalculationBudget::default(),
    )
    .unwrap();
    assert_eq!(instances.len(), 3);
    assert_eq!(
      instances.iter().map(|(start, _)| start.hour()).collect::<Vec<_>>(),
      vec![8, 7, 7]
    );
    for (start, end) in instances {
      assert_eq!(
        (start.with_timezone(&chrono_tz::Europe::Berlin).hour(), start.minute()),
        (9, 0)
      );
      assert_eq!(end - start, Duration::hours(2));
    }
  }
}
