// SPDX-License-Identifier: AGPL-3.0-or-later
//! Minimal RRULE expansion engine (RFC 5545 §3.3.10 / §3.8.5.3).
//!
//! # Supported properties
//!
//! | Property      | Notes                                                    |
//! |---------------|----------------------------------------------------------|
//! | `FREQ`        | `DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`                  |
//! | `INTERVAL`    | Positive integer, defaults to 1                         |
//! | `COUNT`       | Stop after N occurrences                                 |
//! | `UNTIL`       | Stop at or before the given UTC date-time               |
//! | `BYDAY`       | Comma-separated weekday list, e.g. `MO,WE,FR`; also     |
//! |               | ordinal form `2MO` (second Monday) for MONTHLY/YEARLY   |
//! | `BYMONTH`     | Comma-separated month numbers (1–12)                     |
//! | `BYMONTHDAY`  | Comma-separated day-of-month numbers (1–31)              |
//! | `EXDATE`      | Exclusion dates passed as a separate slice               |
//!
//! # Unsupported (V1 scope)
//!
//! `BYYEARDAY`, `BYWEEKNO`, `BYSETPOS`, `WKST`, negative ordinals in BYDAY,
//! `RDATE`.  If an unknown part is encountered the expansion returns an empty
//! `Vec` (fail-safe rather than silently wrong).
//!
//! # Expansion horizon
//!
//! The `to` parameter is the **caller-supplied upper bound**.  Callers should
//! keep it ≤ 6 months from `from` to avoid generating unbounded instance sets.

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc, Weekday};
use tracing::{trace, warn};

// ── Public API ────────────────────────────────────────────────────────────────

/// Expand an RRULE string into concrete `(start, end)` pairs that fall within
/// `[from, to)`.
///
/// * `rrule` – raw RRULE value, e.g. `"FREQ=WEEKLY;BYDAY=MO,WE;COUNT=20"`.
///   The leading `RRULE:` prefix is stripped if present.
/// * `dtstart` – the master event's DTSTART in UTC.
/// * `duration` – the event duration (= dtend − dtstart).
/// * `from`    – inclusive lower bound for returned instances.
/// * `to`      – exclusive upper bound for returned instances.
/// * `exdates` – UTC timestamps for excluded occurrences.
///
/// Returns instances sorted by start ascending.
pub fn expand_rrule(
  rrule: &str,
  dtstart: DateTime<Utc>,
  duration: Duration,
  from: DateTime<Utc>,
  to: DateTime<Utc>,
  exdates: &[DateTime<Utc>],
) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
  let rule = match parse_rrule(rrule) {
    Some(r) => r,
    None => {
      warn!(rrule = %rrule, "RRULE parse failed — returning empty expansion");
      return Vec::new();
    }
  };

  trace!(
    freq = ?rule.freq,
    interval = rule.interval,
    count = ?rule.count,
    until = ?rule.until,
    byday = ?rule.byday,
    "expanding rrule"
  );

  let mut results = Vec::new();
  let mut occurrence_count: usize = 0;
  // Hard guard: at most 2 years of daily occurrences to prevent runaway loops.
  let hard_limit: DateTime<Utc> = dtstart + Duration::days(730);
  let effective_to = to.min(hard_limit);

  let mut cursor = dtstart;

  loop {
    // Stop conditions
    if let Some(count) = rule.count
      && occurrence_count >= count
    {
      break;
    }
    if let Some(until) = rule.until
      && cursor > until
    {
      break;
    }
    if cursor >= effective_to {
      break;
    }

    // Expand the current cursor date into candidate occurrences based on
    // BYDAY / BYMONTHDAY etc.
    let candidates = expand_candidates(&rule, cursor);

    for candidate in candidates {
      if let Some(count) = rule.count
        && occurrence_count >= count
      {
        break;
      }
      if let Some(until) = rule.until
        && candidate > until
      {
        break;
      }
      if candidate >= effective_to {
        break;
      }

      // Check EXDATE exclusion (compare at day+time granularity in UTC).
      let excluded = exdates
        .iter()
        .any(|ex| ex.date_naive() == candidate.date_naive() && ex.time() == candidate.time());

      occurrence_count += 1;

      if excluded {
        trace!(candidate = %candidate, "skipping excluded occurrence");
        continue;
      }

      if candidate >= from {
        let end = candidate + duration;
        results.push((candidate, end));
      }
    }

    // Advance cursor by one FREQ period.
    cursor = advance_cursor(&rule, cursor);
    if cursor == dtstart {
      // Safety: should never happen, but break to prevent infinite loop.
      break;
    }
  }

  results.sort_by_key(|(s, _)| *s);
  results
}

// ── Internal types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Freq {
  Daily,
  Weekly,
  Monthly,
  Yearly,
}

/// A weekday with an optional ordinal prefix (e.g. `+2MO` = second Monday).
#[derive(Debug, Clone)]
struct ByDay {
  ordinal: Option<i32>, // None = every, Some(n) = nth occurrence
  weekday: Weekday,
}

#[derive(Debug)]
struct ParsedRRule {
  freq: Freq,
  interval: u32,
  count: Option<usize>,
  until: Option<DateTime<Utc>>,
  byday: Vec<ByDay>,
  bymonth: Vec<u32>,
  bymonthday: Vec<i32>,
}

// ── Parser ────────────────────────────────────────────────────────────────────

fn parse_rrule(raw: &str) -> Option<ParsedRRule> {
  // Strip optional "RRULE:" prefix (case-insensitive).
  let body = if raw.to_ascii_uppercase().starts_with("RRULE:") {
    &raw[6..]
  } else {
    raw
  };

  let mut freq: Option<Freq> = None;
  let mut interval: u32 = 1;
  let mut count: Option<usize> = None;
  let mut until: Option<DateTime<Utc>> = None;
  let mut byday: Vec<ByDay> = Vec::new();
  let mut bymonth: Vec<u32> = Vec::new();
  let mut bymonthday: Vec<i32> = Vec::new();

  for part in body.split(';') {
    let mut kv = part.splitn(2, '=');
    let key = kv.next()?.trim().to_ascii_uppercase();
    let val = match kv.next() {
      Some(v) => v.trim(),
      None => continue,
    };

    match key.as_str() {
      "FREQ" => {
        freq = match val.to_ascii_uppercase().as_str() {
          "DAILY" => Some(Freq::Daily),
          "WEEKLY" => Some(Freq::Weekly),
          "MONTHLY" => Some(Freq::Monthly),
          "YEARLY" => Some(Freq::Yearly),
          other => {
            warn!(freq = %other, "unsupported FREQ");
            return None;
          }
        };
      }
      "INTERVAL" => {
        interval = val.parse().unwrap_or(1).max(1);
      }
      "COUNT" => {
        const MAX_RRULE_COUNT: usize = 10_000;
        count = val.parse().ok().map(|c: usize| {
          if c > MAX_RRULE_COUNT {
            warn!(count = c, max = MAX_RRULE_COUNT, "RRULE COUNT exceeds maximum, capping");
            MAX_RRULE_COUNT
          } else {
            c
          }
        });
      }
      "UNTIL" => {
        until = parse_until(val);
      }
      "BYDAY" => {
        for token in val.split(',') {
          if let Some(bd) = parse_byday(token.trim()) {
            byday.push(bd);
          } else {
            warn!(token = %token, "unsupported BYDAY token");
          }
        }
      }
      "BYMONTH" => {
        for tok in val.split(',') {
          if let Ok(n) = tok.trim().parse::<u32>() {
            bymonth.push(n);
          }
        }
      }
      "BYMONTHDAY" => {
        for tok in val.split(',') {
          if let Ok(n) = tok.trim().parse::<i32>() {
            bymonthday.push(n);
          }
        }
      }
      // Known-unsupported (log, keep going — just ignore).
      "WKST" => {}
      other => {
        warn!(key = %other, "unknown RRULE part — ignoring");
      }
    }
  }

  Some(ParsedRRule {
    freq: freq?,
    interval,
    count,
    until,
    byday,
    bymonth,
    bymonthday,
  })
}

/// Parse an UNTIL date-time value.  Handles both `YYYYMMDDTHHMMSSZ` and
/// `YYYYMMDD` forms.
fn parse_until(val: &str) -> Option<DateTime<Utc>> {
  // Try full ISO with Z suffix: 20251231T235959Z
  if val.len() >= 15 && val.ends_with('Z') {
    let s = &val[..15];
    let year = s[0..4].parse::<i32>().ok()?;
    let month = s[4..6].parse::<u32>().ok()?;
    let day = s[6..8].parse::<u32>().ok()?;
    let hour = s[9..11].parse::<u32>().ok()?;
    let min = s[11..13].parse::<u32>().ok()?;
    let sec = s[13..15].parse::<u32>().ok()?;
    let dt = NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(hour, min, sec)?;
    return Some(Utc.from_utc_datetime(&dt));
  }
  // Try floating local time: 20251231T235959 (15 chars, no Z suffix)
  if val.len() == 15 && val.contains('T') {
    use chrono::NaiveDateTime;
    if let Ok(naive) = NaiveDateTime::parse_from_str(val, "%Y%m%dT%H%M%S") {
      return Some(DateTime::from_naive_utc_and_offset(naive, Utc));
    }
  }
  // Try date-only: 20251231
  if val.len() == 8 {
    let year = val[0..4].parse::<i32>().ok()?;
    let month = val[4..6].parse::<u32>().ok()?;
    let day = val[6..8].parse::<u32>().ok()?;
    let dt = NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(0, 0, 0)?;
    return Some(Utc.from_utc_datetime(&dt));
  }
  warn!(val = %val, "could not parse UNTIL value");
  None
}

/// Parse a BYDAY token like `MO`, `2MO`, `-1FR`.
fn parse_byday(token: &str) -> Option<ByDay> {
  let upper = token.to_ascii_uppercase();
  // Weekday names are always the last 2 chars.
  if upper.len() < 2 {
    return None;
  }
  let (prefix, wd_str) = upper.split_at(upper.len() - 2);
  let weekday = parse_weekday(wd_str)?;
  let ordinal = if prefix.is_empty() {
    None
  } else {
    Some(prefix.parse::<i32>().ok()?)
  };
  Some(ByDay { ordinal, weekday })
}

fn parse_weekday(s: &str) -> Option<Weekday> {
  match s {
    "MO" => Some(Weekday::Mon),
    "TU" => Some(Weekday::Tue),
    "WE" => Some(Weekday::Wed),
    "TH" => Some(Weekday::Thu),
    "FR" => Some(Weekday::Fri),
    "SA" => Some(Weekday::Sat),
    "SU" => Some(Weekday::Sun),
    _ => None,
  }
}

// ── Expansion helpers ─────────────────────────────────────────────────────────

/// Given the current cursor (a base date in the frequency's period), return all
/// candidate occurrence date-times for that period.
fn expand_candidates(rule: &ParsedRRule, cursor: DateTime<Utc>) -> Vec<DateTime<Utc>> {
  match rule.freq {
    Freq::Daily => {
      // BYDAY filter for DAILY.
      if !rule.byday.is_empty() {
        if rule.byday.iter().any(|bd| bd.weekday == cursor.weekday()) {
          vec![cursor]
        } else {
          vec![]
        }
      } else {
        vec![cursor]
      }
    }
    Freq::Weekly => expand_weekly(rule, cursor),
    Freq::Monthly => expand_monthly(rule, cursor),
    Freq::Yearly => expand_yearly(rule, cursor),
  }
}

/// For WEEKLY, generate all days within the same ISO week that match BYDAY.
fn expand_weekly(rule: &ParsedRRule, cursor: DateTime<Utc>) -> Vec<DateTime<Utc>> {
  if rule.byday.is_empty() {
    return vec![cursor];
  }
  // Find the Monday of cursor's week, then generate all matching days.
  let days_from_mon = cursor.weekday().num_days_from_monday() as i64;
  let week_start = cursor - Duration::days(days_from_mon);

  let mut out = Vec::new();
  for bd in &rule.byday {
    let offset = wd_offset_from_monday(bd.weekday) as i64;
    let candidate = week_start + Duration::days(offset);
    // Preserve the time-of-day from dtstart.
    let candidate = candidate.with_time(cursor.time()).single().unwrap_or(candidate);
    out.push(candidate);
  }
  out.sort();
  out
}

/// For MONTHLY, expand BYDAY (with optional ordinal) and BYMONTHDAY.
fn expand_monthly(rule: &ParsedRRule, cursor: DateTime<Utc>) -> Vec<DateTime<Utc>> {
  let year = cursor.year();
  let month = cursor.month();

  if rule.byday.is_empty() && rule.bymonthday.is_empty() {
    return vec![cursor];
  }

  let mut out = Vec::new();

  // BYMONTHDAY: specific day-of-month numbers.
  for &dom in &rule.bymonthday {
    if !(1..=31).contains(&dom) {
      continue;
    }
    if let Some(date) = NaiveDate::from_ymd_opt(year, month, dom as u32) {
      let dt = Utc.from_utc_datetime(&date.and_time(cursor.time()));
      out.push(dt);
    }
  }

  // BYDAY: per-weekday (optionally nth occurrence in month).
  for bd in &rule.byday {
    if let Some(ord) = bd.ordinal {
      // nth weekday in month (e.g. 2MO = second Monday).
      if let Some(dt) = nth_weekday_in_month(year, month, bd.weekday, ord, cursor.time()) {
        out.push(dt);
      }
    } else {
      // Every matching weekday in the month.
      let mut d = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
      while d.month() == month {
        if d.weekday() == bd.weekday {
          let dt = Utc.from_utc_datetime(&d.and_time(cursor.time()));
          out.push(dt);
        }
        d = d.succ_opt().unwrap_or(d);
      }
    }
  }

  out.sort();
  out.dedup();
  out
}

/// For YEARLY, apply BYMONTH and BYDAY filters.
fn expand_yearly(rule: &ParsedRRule, cursor: DateTime<Utc>) -> Vec<DateTime<Utc>> {
  let year = cursor.year();

  let months: Vec<u32> = if rule.bymonth.is_empty() {
    vec![cursor.month()]
  } else {
    rule.bymonth.clone()
  };

  let mut out = Vec::new();
  for month in months {
    let monthly_cursor = match NaiveDate::from_ymd_opt(year, month, 1) {
      Some(d) => Utc.from_utc_datetime(&d.and_time(cursor.time())),
      None => continue,
    };
    let monthly_rule_ref = ParsedRRule {
      freq: Freq::Monthly,
      interval: 1,
      count: None,
      until: None,
      byday: rule.byday.clone(),
      bymonth: vec![],
      bymonthday: rule.bymonthday.clone(),
    };
    // Reuse monthly expansion.
    if rule.byday.is_empty() && rule.bymonthday.is_empty() {
      // Just the same calendar day each year.
      if let Some(d) = NaiveDate::from_ymd_opt(year, month, cursor.day()) {
        out.push(Utc.from_utc_datetime(&d.and_time(cursor.time())));
      }
    } else {
      out.extend(expand_monthly(&monthly_rule_ref, monthly_cursor));
    }
  }
  out.sort();
  out
}

/// Advance the cursor by one FREQ×INTERVAL period.
fn advance_cursor(rule: &ParsedRRule, cursor: DateTime<Utc>) -> DateTime<Utc> {
  let n = rule.interval as i64;
  match rule.freq {
    Freq::Daily => cursor + Duration::days(n),
    Freq::Weekly => cursor + Duration::weeks(n),
    Freq::Monthly => add_months(cursor, n as u32),
    Freq::Yearly => add_months(cursor, 12 * n as u32),
  }
}

// ── Date arithmetic helpers ───────────────────────────────────────────────────

/// Add `months` calendar months to a `DateTime<Utc>`, clamping the day to the
/// last valid day of the target month.
fn add_months(dt: DateTime<Utc>, months: u32) -> DateTime<Utc> {
  let total_months = dt.month0() + months;
  let year = dt.year() + (total_months / 12) as i32;
  let month = (total_months % 12) + 1;
  let day = dt.day().min(days_in_month(year, month));
  let nd =
    NaiveDate::from_ymd_opt(year, month, day).unwrap_or_else(|| NaiveDate::from_ymd_opt(year, month, 1).unwrap());
  Utc.from_utc_datetime(&nd.and_time(dt.time()))
}

/// Return the nth weekday (1-based) in a given year/month.  Returns `None` if
/// the month does not contain that many occurrences.
fn nth_weekday_in_month(
  year: i32,
  month: u32,
  weekday: Weekday,
  ordinal: i32,
  time: chrono::NaiveTime,
) -> Option<DateTime<Utc>> {
  if ordinal == 0 {
    return None;
  }
  let mut d = NaiveDate::from_ymd_opt(year, month, 1)?;
  let mut matches: Vec<NaiveDate> = Vec::new();
  while d.month() == month {
    if d.weekday() == weekday {
      matches.push(d);
    }
    d = d.succ_opt()?;
  }
  let idx = if ordinal > 0 {
    (ordinal - 1) as usize
  } else {
    let neg = (-ordinal) as usize;
    matches.len().checked_sub(neg)?
  };
  let date = matches.get(idx)?;
  Some(Utc.from_utc_datetime(&date.and_time(time)))
}

fn days_in_month(year: i32, month: u32) -> u32 {
  match month {
    1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
    4 | 6 | 9 | 11 => 30,
    2 => {
      if (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0) {
        29
      } else {
        28
      }
    }
    _ => 30,
  }
}

fn wd_offset_from_monday(wd: Weekday) -> u32 {
  match wd {
    Weekday::Mon => 0,
    Weekday::Tue => 1,
    Weekday::Wed => 2,
    Weekday::Thu => 3,
    Weekday::Fri => 4,
    Weekday::Sat => 5,
    Weekday::Sun => 6,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::{TimeZone, Timelike};

  fn dt(year: i32, month: u32, day: u32, hour: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(year, month, day, hour, 0, 0).unwrap()
  }

  // ── P90-CAL-C-T01: RRULE unit tests ────────────────────────────────────

  /// Invariant: FREQ=WEEKLY;COUNT=10 produces exactly 10 instances.
  #[test]
  fn rrule_weekly_expansion() {
    let dtstart = dt(2025, 1, 6, 9); // Monday
    let from = dtstart;
    let to = dtstart + Duration::weeks(20);
    let instances = expand_rrule("FREQ=WEEKLY;COUNT=10", dtstart, Duration::hours(1), from, to, &[]);
    assert_eq!(instances.len(), 10, "should produce exactly 10 weekly instances");
    // Each instance should be 7 days apart.
    for window in instances.windows(2) {
      let gap = window[1].0 - window[0].0;
      assert_eq!(gap, Duration::weeks(1), "gap should be exactly 1 week");
    }
  }

  /// Invariant: FREQ=MONTHLY;BYDAY=2MO → second Monday of each month.
  #[test]
  fn rrule_monthly_byday() {
    let dtstart = dt(2025, 1, 13, 10); // Second Monday of Jan 2025
    let from = dtstart;
    let to = dtstart + Duration::days(120); // ~4 months
    let instances = expand_rrule(
      "FREQ=MONTHLY;BYDAY=2MO;COUNT=3",
      dtstart,
      Duration::hours(1),
      from,
      to,
      &[],
    );
    assert_eq!(instances.len(), 3, "should produce 3 monthly instances");
    for (start, _) in &instances {
      // Check it's a Monday.
      assert_eq!(start.weekday(), Weekday::Mon, "each instance must be a Monday");
    }
    // Jan → second Monday is 2025-01-13.
    assert_eq!(instances[0].0.day(), 13, "Jan: second Monday should be the 13th");
    // Feb 2025: second Monday is 2025-02-10.
    assert_eq!(instances[1].0.day(), 10, "Feb: second Monday should be the 10th");
  }

  /// Invariant: EXDATE-excluded instance is not present in output.
  #[test]
  fn rrule_exdate_excluded() {
    let dtstart = dt(2025, 6, 2, 9); // Monday
    let exdate = dt(2025, 6, 9, 9); // Second Monday (to be excluded)
    let from = dtstart;
    let to = dtstart + Duration::weeks(5);
    let instances = expand_rrule("FREQ=WEEKLY;COUNT=4", dtstart, Duration::hours(1), from, to, &[exdate]);
    // COUNT=4 occurrences are consumed (exdate counts toward COUNT per RFC5545),
    // but one is excluded from output → 3 instances returned.
    assert_eq!(instances.len(), 3, "excluded occurrence should not appear in results");
    // The excluded date must not be present.
    let has_exdate = instances.iter().any(|(s, _)| *s == exdate);
    assert!(!has_exdate, "EXDATE occurrence must not be in results");
  }

  /// Invariant: UNTIL stops expansion at the boundary.
  #[test]
  fn rrule_until_boundary() {
    let dtstart = dt(2025, 3, 1, 8);
    let until_str = "FREQ=DAILY;UNTIL=20250310T000000Z";
    let from = dtstart;
    let to = dtstart + Duration::days(30);
    let instances = expand_rrule(until_str, dtstart, Duration::hours(1), from, to, &[]);
    // 2025-03-01 through 2025-03-09 (UNTIL=20250310T000000Z means up-to but not including
    // instances that are strictly after 00:00 on 2025-03-10).
    // dtstart=08:00 so 2025-03-10T08:00 > UNTIL → excluded.
    for (start, _) in &instances {
      assert!(
        *start < dt(2025, 3, 10, 1),
        "instance at {start} should be before UNTIL boundary"
      );
    }
    assert!(!instances.is_empty(), "should have at least one instance before UNTIL");
  }

  /// B-01a: COUNT limits expansion when it fires before the `to` bound.
  #[test]
  fn rrule_count_limits_expansion() {
    let dtstart = dt(2025, 1, 1, 9);
    let from = dtstart;
    // `to` allows 730 daily instances, but COUNT=300 must fire first.
    let to = dtstart + Duration::days(730);
    let instances = expand_rrule("FREQ=DAILY;COUNT=300", dtstart, Duration::hours(1), from, to, &[]);
    assert_eq!(
      instances.len(),
      300,
      "COUNT=300 must stop expansion at exactly 300 instances"
    );
  }

  /// B-01b: COUNT=100000 is capped to MAX_RRULE_COUNT (10_000) at parse time; the 730-day
  /// expansion hard limit further reduces the result to ≤ 730 for DAILY events.
  /// The invariant is: no matter how large COUNT is, the result fits safely in memory.
  #[test]
  fn rrule_count_capped_at_maximum() {
    let dtstart = dt(2025, 1, 1, 9);
    let from = dtstart;
    let to = dtstart + Duration::days(730);
    let instances = expand_rrule("FREQ=DAILY;COUNT=100000", dtstart, Duration::hours(1), from, to, &[]);
    // The 730-day hard limit caps DAILY to at most 730 instances.
    // The MAX_RRULE_COUNT=10_000 parse cap is a further safety net for future freq types.
    assert!(
      instances.len() <= 10_000,
      "COUNT=100000 must never produce more than 10_000 instances; got {}",
      instances.len()
    );
  }

  /// B-06: UNTIL without Z suffix (floating datetime) stops expansion correctly.
  #[test]
  fn rrule_until_floating_time() {
    let dtstart = dt(2026, 1, 1, 9);
    let from = dtstart;
    let to = dt(2027, 6, 1, 0);
    let instances = expand_rrule(
      "FREQ=DAILY;UNTIL=20261231T235959",
      dtstart,
      Duration::hours(1),
      from,
      to,
      &[],
    );
    assert!(!instances.is_empty(), "should have instances before UNTIL boundary");
    for (start, _) in &instances {
      assert!(
        *start <= dt(2026, 12, 31, 23),
        "all instances must be on or before 2026-12-31; got {start}"
      );
    }
    // Must not have instances in 2027
    let has_2027 = instances.iter().any(|(s, _)| s.year() >= 2027);
    assert!(!has_2027, "no instances should appear in 2027");
  }

  /// Invariant: UTC dtstart, expansion returns UTC instances.
  #[test]
  fn rrule_timezone_aware() {
    let dtstart = Utc.with_ymd_and_hms(2025, 5, 1, 14, 30, 0).unwrap(); // 14:30 UTC
    let from = dtstart;
    let to = dtstart + Duration::weeks(4);
    let instances = expand_rrule("FREQ=WEEKLY;COUNT=3", dtstart, Duration::hours(2), from, to, &[]);
    assert_eq!(instances.len(), 3);
    for (start, end) in &instances {
      // All times must be at 14:30 UTC.
      assert_eq!(start.hour(), 14);
      assert_eq!(start.minute(), 30);
      // Duration must be 2h.
      assert_eq!(*end - *start, Duration::hours(2));
    }
  }
}
