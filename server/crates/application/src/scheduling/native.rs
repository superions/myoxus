// SPDX-License-Identifier: AGPL-3.0-or-later
//! One calculator for native preview and admission. Imported UTC rules are explicit in `rrule`.

use chrono::{
  DateTime, Datelike, Days, Duration, LocalResult, Months, NaiveDate, NaiveDateTime, SubsecRound, TimeZone, Utc,
};
use chrono_tz::{GapInfo, Tz};
use myoxus_domain::scheduling::{
  AdmissionZone, CalculationBudget, CalculationError, MonthDay, Occurrence, RecurrenceRule, RecurrenceSelector,
  RelativeInterval, RelativeUnit, ScheduleValue,
};

use super::ScanBudget;

/// Complete `[from, to)` window, or an explicit failure with no partial result.
pub fn window(
  rule: &RecurrenceRule,
  from: DateTime<Utc>,
  to: DateTime<Utc>,
  budget: CalculationBudget,
) -> Result<Vec<Occurrence>, CalculationError> {
  if from >= to {
    return Err(CalculationError::InvalidWindow);
  }
  calculate(rule, Some(from), Some(to), false, None, budget, None)
}

/// The next nominal slot strictly after `after`. `None` means a finite rule ended.
pub fn next_after(
  rule: &RecurrenceRule,
  after: DateTime<Utc>,
  budget: CalculationBudget,
) -> Result<Option<Occurrence>, CalculationError> {
  Ok(
    calculate(rule, Some(after), None, true, Some(1), budget, None)?
      .into_iter()
      .next(),
  )
}

/// At most five slots, using precisely the admission calculator and clock policy.
/// With no reference, include the rule's first slot; otherwise start strictly after it.
pub fn preview(
  rule: &RecurrenceRule,
  after: Option<DateTime<Utc>>,
  count: u8,
  budget: CalculationBudget,
) -> Result<Vec<Occurrence>, CalculationError> {
  if !(1..=5).contains(&count) {
    return Err(CalculationError::InvalidBudget);
  }
  calculate(rule, after, None, true, Some(usize::from(count)), budget, None)
}

/// Share one scan budget across excluded original Calendar keys. Repeated
/// next-after calls would rescan DTSTART for every exclusion and multiply cost.
pub(crate) fn first_matching(
  rule: &RecurrenceRule,
  before: Option<DateTime<Utc>>,
  budget: CalculationBudget,
  accept: &dyn Fn(&Occurrence) -> bool,
) -> Result<Option<Occurrence>, CalculationError> {
  Ok(
    calculate(rule, None, before, true, Some(1), budget, Some(accept))?
      .into_iter()
      .next(),
  )
}

fn calculate(
  rule: &RecurrenceRule,
  from: Option<DateTime<Utc>>,
  to: Option<DateTime<Utc>>,
  strict_from: bool,
  take: Option<usize>,
  budget: CalculationBudget,
  accept: Option<&dyn Fn(&Occurrence) -> bool>,
) -> Result<Vec<Occurrence>, CalculationError> {
  rule.validate()?;
  let mut budget = ScanBudget::new(budget)?;
  let mut results = Vec::new();
  // The extra days cover IANA UTC offsets when comparing local period boundaries
  // to the UTC window. Do not project an extreme UTC value into an overflowing local date.
  let last_date = to
    .map(|to| {
      to.date_naive()
        .checked_add_days(Days::new(2))
        .ok_or(CalculationError::DateOutOfRange)
    })
    .transpose()?;
  scan_nominals(rule, last_date, &mut budget, |nominal, budget| {
    let Some(occurrence) = fixed_occurrence(nominal, rule.zone.timezone())? else {
      return Ok(false);
    };
    if from.is_some_and(|from| occurrence.due_at < from || (strict_from && occurrence.due_at == from))
      || to.is_some_and(|to| occurrence.due_at >= to)
      || accept.is_some_and(|accept| !accept(&occurrence))
    {
      return Ok(false);
    }
    budget.push(&mut results, occurrence)?;
    Ok(take.is_some_and(|take| results.len() == take))
  })?;
  Ok(results)
}

/// Standard DATE recurrence cannot encode an admission zone. Retain bounded
/// concrete omissions from the same candidate/clock policy, never a list of
/// normal future occurrences or a substitute UTC recurrence definition.
pub fn date_exclusions(
  rule: &RecurrenceRule,
  through: NaiveDate,
  budget: CalculationBudget,
) -> Result<Vec<DateTime<Utc>>, CalculationError> {
  rule.validate()?;
  if !matches!(rule.start, ScheduleValue::Date(_)) || rule.zone.timezone() == chrono_tz::UTC {
    return Ok(vec![]);
  }
  let mut budget = ScanBudget::new(budget)?;
  let mut excluded = Vec::new();
  scan_nominals(rule, Some(through), &mut budget, |nominal, budget| {
    if nominal.date() <= through && fixed_occurrence(nominal, rule.zone.timezone())?.is_none() {
      budget.push(
        &mut excluded,
        nominal
          .date()
          .and_hms_opt(0, 0, 0)
          .ok_or(CalculationError::DateOutOfRange)?
          .and_utc(),
      )?;
    }
    Ok(false)
  })?;
  Ok(excluded)
}

fn scan_nominals(
  rule: &RecurrenceRule,
  last_date: Option<NaiveDate>,
  budget: &mut ScanBudget,
  mut visit: impl FnMut(ScheduleValue, &mut ScanBudget) -> Result<bool, CalculationError>,
) -> Result<(), CalculationError> {
  let mut index = 0u32;
  loop {
    budget.scan()?;
    let period = period_start(rule, index)?;
    if rule.end.is_some_and(|end| period > end.date()) || last_date.is_some_and(|last| period > last) {
      break;
    }
    for date in candidates(rule, period)? {
      budget.scan()?;
      let nominal = rule.start.on_date(date);
      if nominal < rule.start || rule.end.is_some_and(|end| nominal > end) {
        continue;
      }
      if visit(nominal, budget)? {
        return Ok(());
      }
    }
    index = index.checked_add(1).ok_or(CalculationError::DateOutOfRange)?;
  }
  Ok(())
}

fn period_start(rule: &RecurrenceRule, index: u32) -> Result<NaiveDate, CalculationError> {
  let date = rule.start.date();
  let offset = u64::from(index) * u64::from(rule.interval.get());
  let result = match rule.selector {
    RecurrenceSelector::Daily => date.checked_add_days(Days::new(offset)),
    RecurrenceSelector::Weekly { .. } => date
      .checked_sub_days(Days::new(u64::from(date.weekday().num_days_from_monday())))
      .and_then(|monday| monday.checked_add_days(Days::new(offset.checked_mul(7)?))),
    RecurrenceSelector::Monthly { .. } => date
      .with_day(1)
      .and_then(|first| first.checked_add_months(Months::new(u32::try_from(offset).ok()?))),
    RecurrenceSelector::Yearly { .. } => NaiveDate::from_ymd_opt(date.year(), 1, 1)
      .and_then(|first| first.checked_add_months(Months::new(u32::try_from(offset.checked_mul(12)?).ok()?))),
  };
  result.ok_or(CalculationError::DateOutOfRange)
}

fn candidates(rule: &RecurrenceRule, period: NaiveDate) -> Result<Vec<NaiveDate>, CalculationError> {
  let mut dates = match &rule.selector {
    RecurrenceSelector::Daily => vec![period],
    RecurrenceSelector::Weekly { weekdays } => weekdays
      .iter()
      .map(|day| {
        period
          .checked_add_days(Days::new(u64::from(day.num_days_from_monday())))
          .ok_or(CalculationError::DateOutOfRange)
      })
      .collect::<Result<Vec<_>, _>>()?,
    RecurrenceSelector::Monthly { day } => {
      let day = match day {
        MonthDay::Day(day) => *day,
        MonthDay::Last => last_day(period)?,
      };
      NaiveDate::from_ymd_opt(period.year(), period.month(), day)
        .into_iter()
        .collect()
    }
    RecurrenceSelector::Yearly { month, day } => NaiveDate::from_ymd_opt(period.year(), *month, *day)
      .into_iter()
      .collect(),
  };
  dates.sort_unstable();
  dates.dedup();
  Ok(dates)
}

fn last_day(date: NaiveDate) -> Result<u32, CalculationError> {
  // Starting at the 28th also works in chrono's final representable month.
  for day in (28..=31).rev() {
    if date.with_day(day).is_some() {
      return Ok(day);
    }
  }
  Err(CalculationError::DateOutOfRange)
}

fn earlier(local: NaiveDateTime, zone: Tz) -> Option<DateTime<Utc>> {
  match zone.from_local_datetime(&local) {
    LocalResult::Single(value) => Some(value.with_timezone(&Utc)),
    LocalResult::Ambiguous(first, second) => Some(first.min(second).with_timezone(&Utc)),
    LocalResult::None => None,
  }
}

pub(crate) fn fixed_occurrence(nominal: ScheduleValue, zone: Tz) -> Result<Option<Occurrence>, CalculationError> {
  let local = nominal.local_datetime();
  let due_at = match earlier(local, zone) {
    Some(instant) => Some(instant),
    None if matches!(nominal, ScheduleValue::Date(_)) => {
      // A date does not prescribe midnight. Use the first valid instant of that
      // date; only a whole missing civil date is skipped (e.g. Pacific/Apia).
      GapInfo::new(&local, &zone)
        .and_then(|gap| gap.end)
        .filter(|end| end.date_naive() == nominal.date())
        .map(|end| end.with_timezone(&Utc))
    }
    None => None,
  };
  Ok(due_at.map(|due_at| Occurrence {
    nominal,
    due_at: due_at.trunc_subsecs(6),
  }))
}

/// Offset from the accepted Complete/Skip reference in the pinned admission zone.
/// Days/weeks preserve wall time; months clamp. A clock gap advances by its width,
/// unlike fixed recurrence, which skips that wall-time slot.
pub fn relative_after(
  reference: ScheduleValue,
  interval: RelativeInterval,
  zone: AdmissionZone,
) -> Result<Occurrence, CalculationError> {
  let amount = u64::from(interval.amount.get());
  let date = match interval.unit {
    RelativeUnit::Days => reference.date().checked_add_days(Days::new(amount)),
    RelativeUnit::Weeks => reference.date().checked_add_days(Days::new(amount * 7)),
    RelativeUnit::Months => reference.date().checked_add_months(Months::new(interval.amount.get())),
  }
  .ok_or(CalculationError::DateOutOfRange)?;
  let mut nominal = reference.on_date(date);
  let local = nominal.local_datetime();
  let timezone = zone.timezone();
  let due_at = if let Some(instant) = earlier(local, timezone) {
    instant
  } else {
    let gap = GapInfo::new(&local, &timezone).ok_or(CalculationError::DateOutOfRange)?;
    let (begin, _) = gap.begin.ok_or(CalculationError::DateOutOfRange)?;
    let end = gap.end.ok_or(CalculationError::DateOutOfRange)?;
    let width: Duration = end.naive_local() - begin;
    let shifted = local
      .checked_add_signed(width)
      .ok_or(CalculationError::DateOutOfRange)?;
    nominal = match reference {
      ScheduleValue::Date(_) => ScheduleValue::Date(shifted.date()),
      ScheduleValue::LocalDateTime(_) => ScheduleValue::LocalDateTime(shifted),
    };
    earlier(shifted, timezone).ok_or(CalculationError::DateOutOfRange)?
  };
  Ok(Occurrence {
    nominal,
    due_at: due_at.trunc_subsecs(6),
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::num::NonZeroU32;

  fn date(value: &str) -> ScheduleValue {
    ScheduleValue::Date(value.parse().unwrap())
  }

  fn local(value: &str) -> ScheduleValue {
    ScheduleValue::LocalDateTime(value.parse().unwrap())
  }

  fn utc(value: &str) -> DateTime<Utc> {
    value.parse().unwrap()
  }

  fn rule(start: ScheduleValue, selector: RecurrenceSelector) -> RecurrenceRule {
    RecurrenceRule {
      selector,
      interval: NonZeroU32::new(1).unwrap(),
      start,
      end: None,
      zone: AdmissionZone::try_from("Europe/Berlin".to_owned()).unwrap(),
    }
  }

  #[test]
  fn fixed_month_days_skip_while_last_day_and_relative_months_clamp() {
    let mut rule = rule(
      date("2025-01-31"),
      RecurrenceSelector::Monthly { day: MonthDay::Day(31) },
    );
    let dates = |rule: &RecurrenceRule| {
      preview(rule, None, 3, CalculationBudget::default())
        .unwrap()
        .into_iter()
        .map(|slot| slot.nominal)
        .collect::<Vec<_>>()
    };
    assert_eq!(
      dates(&rule),
      vec![date("2025-01-31"), date("2025-03-31"), date("2025-05-31")]
    );
    rule.selector = RecurrenceSelector::Monthly { day: MonthDay::Last };
    assert_eq!(
      dates(&rule),
      vec![date("2025-01-31"), date("2025-02-28"), date("2025-03-31")]
    );
    rule.end = Some(date("2025-02-28"));
    assert_eq!(
      dates(&rule),
      vec![date("2025-01-31"), date("2025-02-28")],
      "end is inclusive and remains a date"
    );
    let offset = RelativeInterval {
      amount: NonZeroU32::new(1).unwrap(),
      unit: RelativeUnit::Months,
    };
    assert_eq!(
      relative_after(date("2025-01-31"), offset, rule.zone).unwrap().nominal,
      date("2025-02-28")
    );
    rule.start = date("2024-02-29");
    rule.end = Some(date("2028-02-29"));
    rule.selector = RecurrenceSelector::Yearly { month: 2, day: 29 };
    assert_eq!(dates(&rule), vec![date("2024-02-29"), date("2028-02-29")]);
  }

  #[test]
  fn fixed_gaps_are_skipped_and_repeated_wall_times_have_one_earlier_slot() {
    let mut rule = rule(local("2026-03-28T02:30:00"), RecurrenceSelector::Daily);
    let spring = preview(&rule, None, 3, CalculationBudget::default()).unwrap();
    assert_eq!(
      spring.iter().map(|slot| slot.due_at).collect::<Vec<_>>(),
      vec![
        utc("2026-03-28T01:30:00Z"),
        utc("2026-03-30T00:30:00Z"),
        utc("2026-03-31T00:30:00Z"),
      ]
    );
    rule.start = local("2026-10-24T02:30:00");
    let fall = preview(&rule, None, 3, CalculationBudget::default()).unwrap();
    assert_eq!(fall[1].due_at, utc("2026-10-25T00:30:00Z"));
    assert_eq!(
      next_after(&rule, fall[1].due_at, CalculationBudget::default()).unwrap(),
      Some(fall[2])
    );
    assert_eq!(
      window(
        &rule,
        fall[0].due_at,
        utc("2026-10-27T00:00:00Z"),
        CalculationBudget::default()
      )
      .unwrap(),
      fall
    );
    rule.start = date("2011-12-29");
    rule.zone = AdmissionZone::try_from("Pacific/Apia".to_owned()).unwrap();
    let dates = preview(&rule, None, 2, CalculationBudget::default()).unwrap();
    assert_eq!(
      dates.iter().map(|slot| slot.nominal).collect::<Vec<_>>(),
      vec![date("2011-12-29"), date("2011-12-31")]
    );
  }

  #[test]
  fn relative_offsets_preserve_local_days_and_advance_by_the_clock_gap() {
    let zone = AdmissionZone::try_from("Europe/Berlin".to_owned()).unwrap();
    let mut offset = RelativeInterval {
      amount: NonZeroU32::new(1).unwrap(),
      unit: RelativeUnit::Days,
    };
    let gap = relative_after(local("2026-03-28T02:30:00"), offset, zone).unwrap();
    assert_eq!(gap.nominal, local("2026-03-29T03:30:00"));
    assert_eq!(gap.due_at, utc("2026-03-29T01:30:00Z"));
    let day = relative_after(local("2026-03-28T12:00:00"), offset, zone).unwrap();
    assert_eq!(day.nominal, local("2026-03-29T12:00:00"));
    assert_eq!(day.due_at - utc("2026-03-28T11:00:00Z"), Duration::hours(23));
    offset.unit = RelativeUnit::Weeks;
    let week = relative_after(local("2026-03-28T12:00:00"), offset, zone).unwrap();
    assert_eq!(week.nominal, local("2026-04-04T12:00:00"));
    assert_eq!(week.due_at - utc("2026-03-28T11:00:00Z"), Duration::hours(167));
  }
}
