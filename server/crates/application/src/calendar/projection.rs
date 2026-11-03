// SPDX-License-Identifier: AGPL-3.0-or-later
//! Pure Calendar window/cursor projection. Persistence and authored exception
//! writes remain in native event transactions, never the workflow engine.

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use myoxus_domain::{
  entities::{CalendarEvent, CalendarEventInstance},
  scheduling::{calendar::*, *},
};
use std::collections::BTreeSet;
use uuid::Uuid;

pub fn validate_window(from: DateTime<Utc>, to: DateTime<Utc>) -> Result<(), CalculationError> {
  if from >= to || to - from > Duration::days(366) {
    return Err(CalculationError::InvalidWindow);
  }
  Ok(())
}

/// Next original rule key strictly after `after`, independent of any view
/// cache. Delivery adapters apply native moved/cancelled exceptions separately.
/// Pause and exclusions retain COUNT identity instead of inventing a new rule.
pub fn next_original_key(
  event: &CalendarEvent,
  timing: &CalendarTiming,
  after: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, CalculationError> {
  next_original_matching(event, timing, after, &|_| true)
}

fn next_original_matching(
  event: &CalendarEvent,
  timing: &CalendarTiming,
  after: DateTime<Utc>,
  select: &dyn Fn(DateTime<Utc>) -> bool,
) -> Result<Option<DateTime<Utc>>, CalculationError> {
  if timing.blocked_reason.is_some() {
    return Err(CalculationError::UnsupportedRule);
  }
  if timing.paused_at.is_some() {
    return Err(CalculationError::InvalidWindow);
  }
  let (excluded, dates) = exclusions(&event.payload, timing.zone)?;
  if timing.ends_before.is_some_and(|end| end <= after) {
    return Ok(None);
  }
  let accept = |key: DateTime<Utc>| {
    let date = if event.all_day {
      key.date_naive()
    } else {
      key.with_timezone(&timing.zone.timezone()).date_naive()
    };
    key > after && !excluded.contains(&key) && !dates.contains(&date) && !timing.suppresses(key) && select(key)
  };
  match timing.rule.as_ref().ok_or(CalculationError::UnsupportedRule)? {
    CalendarTimingRule::Fixed { rule } => {
      let key = |slot: &Occurrence| {
        if event.all_day {
          slot.nominal.date().and_time(chrono::NaiveTime::MIN).and_utc()
        } else {
          slot.due_at
        }
      };
      let before = timing
        .ends_before
        .map(|end| {
          if event.all_day {
            end
              .checked_add_signed(Duration::days(2))
              .ok_or(CalculationError::DateOutOfRange)
          } else {
            Ok(end)
          }
        })
        .transpose()?;
      Ok(
        crate::scheduling::first_matching(rule, before, CalculationBudget::default(), &|slot| accept(key(slot)))?
          .as_ref()
          .map(key),
      )
    }
    CalendarTimingRule::ImportedCalendar {
      rrule,
      starts_at,
      all_day,
      zone,
    } => crate::scheduling::rrule::next_zoned_rrule(
      rrule,
      *starts_at,
      after
        .checked_add_signed(Duration::microseconds(1))
        .ok_or(CalculationError::DateOutOfRange)?,
      timing.ends_before,
      if *all_day { chrono_tz::UTC } else { zone.timezone() },
      CalculationBudget::default(),
      &accept,
    ),
  }
}

/// Pick the next actual reminder occurrence, not the next original key. A moved
/// exception can precede a lower-key natural slot; acknowledging it must not
/// hide that natural slot on the next call. `consumed` contains durable receipt
/// keys, and exceptions must come from authored source, never a viewed cache.
pub fn next_reminder_instance(
  event: &CalendarEvent,
  timing: &CalendarTiming,
  exceptions: &[CalendarEventInstance],
  consumed: &BTreeSet<DateTime<Utc>>,
) -> Result<Option<CalendarEventInstance>, CalculationError> {
  use std::{cell::RefCell, collections::BTreeMap};
  if event.payload["status"]
    .as_str()
    .is_some_and(|status| status.eq_ignore_ascii_case("CANCELLED"))
  {
    return Ok(None);
  }
  if exceptions.len() > CalculationBudget::default().results || consumed.len() > CalculationBudget::default().scans {
    return Err(CalculationError::ScanBudgetExceeded);
  }
  let duration = event.ends_at - event.starts_at;
  if duration < Duration::zero() || duration > Duration::days(366) {
    return Err(CalculationError::InvalidWindow);
  }
  let mut overrides = BTreeMap::new();
  for instance in exceptions {
    if instance.event_id != event.id
      || !instance.is_override && !instance.is_cancelled
      || overrides.insert(instance.instance_start, instance).is_some()
    {
      return Err(CalculationError::InvalidRule);
    }
    if let Some(payload) = &instance.override_payload {
      for field in ["starts_at", "ends_at"] {
        if let Some(value) = payload.get(field).filter(|value| !value.is_null())
          && value
            .as_str()
            .is_none_or(|value| value.parse::<DateTime<Utc>>().is_err())
        {
          return Err(CalculationError::InvalidRule);
        }
      }
    }
  }
  let (excluded, dates) = exclusions(&event.payload, timing.zone)?;
  let best = RefCell::new(None::<CalendarEventInstance>);
  let natural = std::cell::Cell::new(false);
  let last = overrides.keys().next_back().copied();
  let consider = |candidate: CalendarEventInstance| {
    let shown = occurrence_event(event, &candidate);
    if shown.ends_at < shown.starts_at {
      return Err(CalculationError::InvalidRule);
    }
    let mut best = best.borrow_mut();
    if best.as_ref().is_none_or(|current| {
      let current_start = occurrence_event(event, current).starts_at;
      (shown.starts_at, candidate.instance_start) < (current_start, current.instance_start)
    }) {
      *best = Some(candidate)
    }
    Ok(())
  };
  // Master EXDATE can substitute a detached source child, so original-rule
  // membership is checked before exclusions. All eligibility is collected in
  // one scan, including finite COUNT and ended/paused key suppression.
  let mut source = event.clone();
  source.payload = serde_json::json!({});
  let from = overrides
    .keys()
    .next()
    .copied()
    .map_or(event.starts_at, |first| first.min(event.starts_at))
    .checked_sub_signed(Duration::microseconds(1))
    .ok_or(CalculationError::DateOutOfRange)?;
  let failure = RefCell::new(None);
  next_original_matching(&source, timing, from, &|key| {
    if !consumed.contains(&key) {
      if let Some(instance) = overrides.get(&key) {
        if !instance.is_cancelled
          && instance.override_payload.as_ref().is_none_or(|payload| {
            !payload["status"]
              .as_str()
              .is_some_and(|status| status.eq_ignore_ascii_case("CANCELLED"))
          })
        {
          if let Err(error) = consider((*instance).clone()) {
            *failure.borrow_mut() = Some(error);
            return true;
          }
        }
      } else if !natural.get() {
        let date = if event.all_day {
          key.date_naive()
        } else {
          key.with_timezone(&timing.zone.timezone()).date_naive()
        };
        if !excluded.contains(&key) && !dates.contains(&date) {
          let Some(end) = key.checked_add_signed(duration) else {
            *failure.borrow_mut() = Some(CalculationError::DateOutOfRange);
            return true;
          };
          if let Err(error) = consider(CalendarEventInstance {
            id: Uuid::new_v5(&event.id, key.to_rfc3339().as_bytes()),
            event_id: event.id,
            instance_start: key,
            instance_end: end,
            is_override: false,
            is_cancelled: false,
            override_payload: None,
            created_at: Utc::now(),
          }) {
            *failure.borrow_mut() = Some(error);
            return true;
          }
          natural.set(true);
        }
      }
    }
    natural.get() && last.is_none_or(|last| key >= last)
  })?;
  if let Some(error) = failure.into_inner() {
    return Err(error);
  }
  Ok(best.into_inner())
}

/// Original keys are UTC instants for timed events, UTC date-midnights for
/// all-day events. EXDATE is applied after COUNT and never changes that key.
pub fn occurrences(
  event: &CalendarEvent,
  timing: &CalendarTiming,
  from: DateTime<Utc>,
  to: DateTime<Utc>,
) -> Result<Vec<CalendarEventInstance>, CalculationError> {
  validate_window(from, to)?;
  if timing.blocked_reason.is_some() {
    return Err(CalculationError::UnsupportedRule);
  }
  let duration = event.ends_at - event.starts_at;
  if duration < Duration::zero() || duration > Duration::days(366) {
    return Err(CalculationError::InvalidWindow);
  }
  let lower = from
    .checked_sub_signed(duration)
    .ok_or(CalculationError::DateOutOfRange)?;
  if timing.ends_before.is_some_and(|cutoff| cutoff <= lower) {
    return Ok(vec![]);
  }
  let (excluded, dates) = exclusions(&event.payload, timing.zone)?;
  let starts = match timing.rule.as_ref().ok_or(CalculationError::UnsupportedRule)? {
    CalendarTimingRule::Fixed { rule } => {
      // Resolve in the original zone so wholly nonexistent dates are skipped
      // just like preview/admission. Pad offset geometry, then map DATE labels
      // back to their stable UTC identity keys before applying the view bounds.
      let (scan_from, scan_to) = if event.all_day {
        (
          lower
            .checked_sub_signed(Duration::days(2))
            .ok_or(CalculationError::DateOutOfRange)?,
          to.checked_add_signed(Duration::days(2))
            .ok_or(CalculationError::DateOutOfRange)?,
        )
      } else {
        (lower, to)
      };
      crate::scheduling::window(rule, scan_from, scan_to, CalculationBudget::default())?
        .into_iter()
        .map(|slot| {
          if event.all_day {
            slot.nominal.date().and_time(chrono::NaiveTime::MIN).and_utc()
          } else {
            slot.due_at
          }
        })
        .filter(|key| *key >= lower && *key < to)
        .collect::<Vec<_>>()
    }
    CalendarTimingRule::ImportedCalendar {
      rrule,
      starts_at,
      all_day,
      zone,
    } => crate::scheduling::rrule::expand_zoned_rrule(
      rrule,
      *starts_at,
      duration,
      lower,
      to,
      &[],
      if *all_day { chrono_tz::UTC } else { zone.timezone() },
      CalculationBudget::default(),
    )?
    .into_iter()
    .map(|(start, _)| start)
    .collect(),
  };
  starts
    .into_iter()
    .filter(|start| {
      if timing.ends_before.is_some_and(|cutoff| *start >= cutoff) {
        return false;
      }
      !excluded.contains(start)
        && !dates.contains(&if event.all_day {
          start.date_naive()
        } else {
          start.with_timezone(&timing.zone.timezone()).date_naive()
        })
    })
    .map(|start| {
      let end = start
        .checked_add_signed(duration)
        .ok_or(CalculationError::DateOutOfRange)?;
      Ok(CalendarEventInstance {
        id: Uuid::new_v5(&event.id, start.to_rfc3339().as_bytes()),
        event_id: event.id,
        instance_start: start,
        instance_end: end,
        is_override: false,
        is_cancelled: false,
        override_payload: None,
        created_at: Utc::now(),
      })
    })
    .filter(|value| value.as_ref().map_or(true, |instance| instance.instance_end > from))
    .collect()
}

fn exclusions(
  payload: &serde_json::Value,
  zone: AdmissionZone,
) -> Result<(BTreeSet<DateTime<Utc>>, BTreeSet<NaiveDate>), CalculationError> {
  let mut instants = BTreeSet::new();
  let mut dates = BTreeSet::new();
  let mut values = Vec::new();
  let mut push = |value: &str, timezone| -> Result<(), CalculationError> {
    if values.len() >= CalculationBudget::default().results {
      return Err(CalculationError::ResultBudgetExceeded);
    }
    if value.len() > 64 {
      return Err(CalculationError::InvalidRule);
    }
    values.push((value.to_owned(), timezone));
    Ok(())
  };
  if let Some(raw) = payload["exdate"].as_str() {
    if raw.len() > CalculationBudget::default().results * 64 {
      return Err(CalculationError::ScanBudgetExceeded);
    }
    for value in raw.split(',').filter(|value| !value.is_empty()) {
      push(value, zone.timezone())?;
    }
  }
  if let Some(raw) = payload["exdates"].as_array() {
    for value in raw {
      push(value.as_str().ok_or(CalculationError::InvalidRule)?, zone.timezone())?;
    }
  }
  if let Some(lines) = payload["sourceRecurrence"].as_array() {
    if lines.len() > CalculationBudget::default().results {
      return Err(CalculationError::ResultBudgetExceeded);
    }
    let mut bytes = CalculationBudget::default().scans;
    for line in lines {
      let line = line.as_str().ok_or(CalculationError::InvalidRule)?;
      bytes = bytes
        .checked_sub(line.len())
        .ok_or(CalculationError::ScanBudgetExceeded)?;
      if line.len() > 8192 {
        return Err(CalculationError::ScanBudgetExceeded);
      }
      let Some((name, value)) = line.split_once(':') else {
        return Err(CalculationError::InvalidRule);
      };
      let mut parameters = name.split(';');
      if !parameters
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("EXDATE"))
      {
        continue;
      }
      let mut timezone = zone.timezone();
      for parameter in parameters {
        let (name, value) = parameter.split_once('=').ok_or(CalculationError::InvalidRule)?;
        if name.eq_ignore_ascii_case("TZID") {
          timezone = value
            .trim_matches('"')
            .parse()
            .map_err(|_| CalculationError::InvalidZone)?;
        } else if !(name.eq_ignore_ascii_case("VALUE")
          && (value.eq_ignore_ascii_case("DATE") || value.eq_ignore_ascii_case("DATE-TIME")))
        {
          return Err(CalculationError::UnsupportedRule);
        }
      }
      for value in value.split(',') {
        push(value, timezone)?;
      }
    }
  }
  for (value, zone) in values {
    if value.len() == 8 {
      dates.insert(NaiveDate::parse_from_str(&value, "%Y%m%d").map_err(|_| CalculationError::InvalidRule)?);
      continue;
    }
    if let Ok(instant) = DateTime::parse_from_rfc3339(&value) {
      instants.insert(instant.with_timezone(&Utc));
      continue;
    }
    let (value, utc) = value
      .strip_suffix('Z')
      .map_or((value.as_str(), false), |value| (value, true));
    let local = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").map_err(|_| CalculationError::InvalidRule)?;
    let instant = if utc {
      local.and_utc()
    } else {
      zone
        .from_local_datetime(&local)
        .earliest()
        .ok_or(CalculationError::InvalidRule)?
        .with_timezone(&Utc)
    };
    instants.insert(instant);
  }
  Ok((instants, dates))
}

/// Check cancellation of an already persisted delivery key without expanding a
/// view. Detached replacement eligibility remains the native adapter's decision.
pub fn original_key_is_excluded(
  event: &CalendarEvent,
  zone: AdmissionZone,
  key: DateTime<Utc>,
) -> Result<bool, CalculationError> {
  let (instants, dates) = exclusions(&event.payload, zone)?;
  Ok(
    instants.contains(&key)
      || dates.contains(&if event.all_day {
        key.date_naive()
      } else {
        key.with_timezone(&zone.timezone()).date_naive()
      }),
  )
}

pub fn source_excluded(event: &CalendarEvent) -> Result<bool, CalculationError> {
  if event.payload.get("exdate").is_none()
    && event.payload.get("exdates").is_none()
    && event.payload.get("sourceRecurrence").is_none()
  {
    return Ok(false);
  }
  let zone = AdmissionZone::try_from(event.payload["originalTimezone"].as_str().unwrap_or("UTC").to_owned())?;
  let (instants, dates) = exclusions(&event.payload, zone)?;
  Ok(
    instants.contains(&event.starts_at)
      || dates.contains(&if event.all_day {
        event.starts_at.date_naive()
      } else {
        event.starts_at.with_timezone(&zone.timezone()).date_naive()
      }),
  )
}

/// Validate the complete master source before declaring it projectable. An
/// otherwise supported RRULE plus RDATE is a different, unsupported set.
pub fn validate_imported_source(
  raw: &str,
  payload: &serde_json::Value,
  zone: AdmissionZone,
) -> Result<(), CalculationError> {
  crate::scheduling::rrule::validate_imported_rrule(raw)?;
  if let Some(lines) = payload.get("sourceRecurrence").filter(|value| !value.is_null()) {
    let lines = lines.as_array().ok_or(CalculationError::UnsupportedRule)?;
    if lines.len() > CalculationBudget::default().results {
      return Err(CalculationError::ScanBudgetExceeded);
    }
    let mut rules = 0;
    let mut bytes = CalculationBudget::default().scans;
    for line in lines {
      let line = line.as_str().ok_or(CalculationError::UnsupportedRule)?;
      bytes = bytes
        .checked_sub(line.len())
        .ok_or(CalculationError::ScanBudgetExceeded)?;
      let (name, value) = line.split_once(':').ok_or(CalculationError::UnsupportedRule)?;
      if name.eq_ignore_ascii_case("RRULE") {
        rules += 1;
        let rule = if raw.get(..6).is_some_and(|prefix| prefix.eq_ignore_ascii_case("RRULE:")) {
          &raw[6..]
        } else {
          raw
        };
        if rules > 1 || !value.eq_ignore_ascii_case(rule) {
          return Err(CalculationError::UnsupportedRule);
        }
      } else if !name
        .split(';')
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("EXDATE"))
      {
        return Err(CalculationError::UnsupportedRule);
      }
    }
  }
  exclusions(payload, zone)?;
  Ok(())
}

/// An unruled source may still be a recurrence set (RDATE/legacy EXRULE). Never
/// clear its canonical blocked definition and pretend that only DTSTART exists.
pub fn unsupported_unruled_source(payload: &serde_json::Value, zone: AdmissionZone) -> bool {
  if exclusions(payload, zone).is_err() {
    return true;
  }
  match payload.get("sourceRecurrence").filter(|value| !value.is_null()) {
    None => false,
    Some(value) => value.as_array().is_none_or(|lines| {
      lines.iter().any(|line| {
        !line.as_str().is_some_and(|line| {
          line
            .split([';', ':'])
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case("EXDATE"))
        })
      })
    }),
  }
}

/// Resolve imported RECURRENCE-ID parameters through the same bounded date/zone
/// parser as EXDATE. Its displayed DTSTART is never the occurrence identity.
pub fn imported_original_key(
  raw: &str,
  lines: &[String],
  zone: AdmissionZone,
) -> Result<DateTime<Utc>, CalculationError> {
  if lines.len() > CalculationBudget::default().results {
    return Err(CalculationError::ScanBudgetExceeded);
  }
  let mut ids = lines.iter().filter(|line| {
    line
      .split([';', ':'])
      .next()
      .is_some_and(|name| name.eq_ignore_ascii_case("RECURRENCE-ID"))
  });
  let payload = if let Some(line) = ids.next() {
    if ids.next().is_some() || line.len() > 8192 {
      return Err(CalculationError::UnsupportedRule);
    }
    let (name, value) = line.split_once(':').ok_or(CalculationError::InvalidRule)?;
    if value != raw {
      return Err(CalculationError::InvalidRule);
    }
    serde_json::json!({"sourceRecurrence":[format!("EXDATE{}:{value}",&name["RECURRENCE-ID".len()..])]})
  } else {
    serde_json::json!({"exdate":raw})
  };
  let (times, dates) = exclusions(&payload, zone)?;
  if times.len() + dates.len() != 1 {
    return Err(CalculationError::InvalidRule);
  }
  times
    .into_iter()
    .chain(
      dates
        .into_iter()
        .map(|date| date.and_time(chrono::NaiveTime::MIN).and_utc()),
    )
    .next()
    .ok_or(CalculationError::InvalidRule)
}

/// Native child keys retain their original UTC/date identity across a split.
pub fn original_key(raw: &str) -> Result<DateTime<Utc>, CalculationError> {
  if let Ok(value) = DateTime::parse_from_rfc3339(raw) {
    return Ok(value.with_timezone(&Utc));
  }
  if raw.len() == 8 {
    return NaiveDate::parse_from_str(raw, "%Y%m%d")
      .map(|date| date.and_time(chrono::NaiveTime::MIN).and_utc())
      .map_err(|_| CalculationError::InvalidRule);
  }
  NaiveDateTime::parse_from_str(raw, "%Y%m%dT%H%M%SZ")
    .map(|date| date.and_utc())
    .map_err(|_| CalculationError::InvalidRule)
}

/// Build standard export properties from the retained base rule. Only elapsed
/// closed pause slots are enumerated; an open pause uses one fixed cutoff.
pub fn export_projection(
  event_start: DateTime<Utc>,
  all_day: bool,
  timing: &CalendarTiming,
) -> Result<CalendarExportProjection, CalculationError> {
  let zone = if all_day {
    chrono_tz::UTC
  } else {
    timing.zone.timezone()
  };
  let (base, start) = match timing.rule.as_ref().ok_or(CalculationError::UnsupportedRule)? {
    CalendarTimingRule::Fixed { rule } => (
      crate::scheduling::rrule::project_native_rrule(rule)?,
      if all_day {
        rule.start.local_datetime().and_utc()
      } else {
        crate::scheduling::fixed_occurrence(rule.start, zone)?
          .ok_or(CalculationError::InvalidRule)?
          .due_at
      },
    ),
    CalendarTimingRule::ImportedCalendar { rrule, starts_at, .. } => (rrule.clone(), *starts_at),
  };
  let rrule = crate::scheduling::rrule::limit_export_rrule(&base, start, timing.effective_cutoff(), all_day, zone)?;
  let mut slots = BTreeSet::new();
  if all_day && let Some(CalendarTimingRule::Fixed { rule }) = &timing.rule {
    let through = rule.end.map(|end| end.date()).unwrap_or_else(|| {
      Utc::now()
        .with_timezone(&rule.zone.timezone())
        .date_naive()
        .max(rule.start.date())
    });
    slots.extend(crate::scheduling::date_exclusions(
      rule,
      through,
      CalculationBudget::default(),
    )?);
  }
  let scans = CalculationBudget::default().scans / timing.pauses.len().max(1);
  for pause in &timing.pauses {
    let (from, to) = timing.pause_key_window(*pause);
    if from >= to {
      continue;
    }
    for (slot, _) in crate::scheduling::rrule::expand_zoned_rrule(
      &base,
      start,
      Duration::zero(),
      from,
      to,
      &[],
      zone,
      CalculationBudget {
        scans,
        results: CalculationBudget::default().results,
      },
    )? {
      slots.insert(slot);
      if slots.len() > CalculationBudget::default().results {
        return Err(CalculationError::ResultBudgetExceeded);
      }
    }
  }
  // RFC DTSTART remains in the recurrence set even when UNTIL precedes it.
  if timing.suppresses(event_start) {
    slots.insert(event_start);
  }
  Ok(CalendarExportProjection {
    rrule: Some(rrule),
    excluded_slots: slots.into_iter().collect(),
    suppressed: false,
  })
}

/// An authored split normalizes existing exception properties to the same
/// original keys, then partitions them; it never enumerates new future dates.
pub(super) fn split_exclusions(
  event: &CalendarEvent,
  at: DateTime<Utc>,
  zone: AdmissionZone,
  head: &mut serde_json::Value,
  tail: &mut serde_json::Value,
) -> Result<(), CalculationError> {
  let (instants, dates) = exclusions(&event.payload, zone)?;
  let day = if event.all_day {
    at.date_naive()
  } else {
    at.with_timezone(&zone.timezone()).date_naive()
  };
  for (target, future) in [(head, false), (tail, true)] {
    let instants = instants
      .iter()
      .copied()
      .filter(|value| (*value >= at) == future)
      .collect::<Vec<_>>();
    let dates = dates
      .iter()
      .copied()
      .filter(|value| (*value >= day) == future)
      .collect::<Vec<_>>();
    let date_tokens = dates
      .iter()
      .map(|date| date.format("%Y%m%d").to_string())
      .collect::<Vec<_>>();
    let time_tokens = instants
      .iter()
      .map(|time| time.format("%Y%m%dT%H%M%SZ").to_string())
      .collect::<Vec<_>>();
    target["exdate"] = serde_json::json!(
      date_tokens
        .iter()
        .chain(time_tokens.iter())
        .cloned()
        .collect::<Vec<_>>()
        .join(",")
    );
    target["exdates"] = serde_json::json!(instants.iter().map(DateTime::to_rfc3339).collect::<Vec<_>>());
    if let Some(source) = event.payload["sourceRecurrence"].as_array() {
      let mut lines = source
        .iter()
        .filter_map(|line| line.as_str())
        .filter(|line| {
          !line
            .split([';', ':'])
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case("EXDATE") || name.eq_ignore_ascii_case("RRULE"))
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
      if let Some(rule) = target["rrule"].as_str() {
        lines.push(format!("RRULE:{rule}"));
      }
      if !date_tokens.is_empty() {
        lines.push(format!("EXDATE;VALUE=DATE:{}", date_tokens.join(",")));
      }
      if !time_tokens.is_empty() {
        lines.push(format!("EXDATE:{}", time_tokens.join(",")));
      }
      target["sourceRecurrence"] = serde_json::json!(lines);
    }
  }
  Ok(())
}

/// DTSTART belongs to the standard recurrence set even for an empty head.
/// Exclude only these concrete birth keys, never an enumerated future backlog.
pub(super) fn exclude_birth_keys(payload: &mut serde_json::Value, keys: &[DateTime<Utc>], all_day: bool) {
  let mut tokens = payload["exdate"]
    .as_str()
    .unwrap_or_default()
    .split(',')
    .filter(|value| !value.is_empty())
    .map(str::to_owned)
    .collect::<BTreeSet<_>>();
  let mut instants = payload["exdates"].as_array().cloned().unwrap_or_default();
  for key in keys {
    let token = key
      .format(if all_day { "%Y%m%d" } else { "%Y%m%dT%H%M%SZ" })
      .to_string();
    tokens.insert(token.clone());
    let value = serde_json::json!(key.to_rfc3339());
    if !instants.contains(&value) {
      instants.push(value);
    }
    if let Some(lines) = payload["sourceRecurrence"].as_array_mut() {
      let line = serde_json::json!(format!(
        "{}:{token}",
        if all_day { "EXDATE;VALUE=DATE" } else { "EXDATE" }
      ));
      if !lines.contains(&line) {
        lines.push(line);
      }
    }
  }
  payload["exdate"] = serde_json::json!(tokens.into_iter().collect::<Vec<_>>().join(","));
  payload["exdates"] = serde_json::json!(instants);
}

/// The wire event keeps its native/master ID; recurrenceId carries the original
/// slot even when an override changes the displayed start/end.
pub fn occurrence_event(master: &CalendarEvent, instance: &CalendarEventInstance) -> CalendarEvent {
  let mut event = master.clone();
  event.starts_at = instance.instance_start;
  event.ends_at = instance.instance_end;
  event.payload["recurrenceId"] = serde_json::json!(instance.instance_start.to_rfc3339());
  if let Some(payload) = &instance.override_payload {
    if let Some(title) = payload["title"].as_str() {
      event.title = Some(title.to_owned());
    }
    for key in [
      "description",
      "location",
      "status",
      "allDay",
      "sourceRecurrence",
      "originalTimezone",
    ] {
      if let Some(value) = payload.get(key) {
        event.payload[key] = value.clone();
      }
    }
    if let Some(value) = payload["allDay"].as_bool() {
      event.all_day = value;
    }
    if let Some(start) = payload["starts_at"].as_str().and_then(|value| value.parse().ok()) {
      event.starts_at = start;
    }
    if let Some(end) = payload["ends_at"].as_str().and_then(|value| value.parse().ok()) {
      event.ends_at = end;
    }
  }
  event
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_domain::{
    entities::CalendarEventOrigin,
    scheduling::{MonthDay, RecurrenceRule, RecurrenceSelector, ScheduleLifecycle, ScheduleValue},
  };

  #[test]
  fn native_date_keys_and_standard_exclusions_match_preview_across_a_whole_day_gap() {
    let start: DateTime<Utc> = "2011-11-30T00:00:00Z".parse().unwrap();
    let rule = RecurrenceRule {
      selector: RecurrenceSelector::Monthly { day: MonthDay::Day(30) },
      interval: std::num::NonZeroU32::new(1).unwrap(),
      start: ScheduleValue::Date(start.date_naive()),
      end: Some(ScheduleValue::Date("2012-01-30".parse().unwrap())),
      zone: AdmissionZone::try_from("Pacific/Apia".to_owned()).unwrap(),
    };
    let timing = CalendarTiming {
      id: Uuid::new_v4(),
      zone: rule.zone,
      revision: 1,
      lifecycle: ScheduleLifecycle::Active,
      paused_at: None,
      pauses: vec![],
      ends_before: None,
      rule: Some(CalendarTimingRule::Fixed { rule: rule.clone() }),
      blocked_reason: None,
    };
    let event = CalendarEvent {
      id: Uuid::new_v4(),
      origin: CalendarEventOrigin::Native,
      account_id: None,
      workspace_id: None,
      remote_event_id: None,
      starts_at: start,
      ends_at: start + Duration::days(1),
      title: None,
      description: None,
      description_delta: None,
      location: None,
      source_doc_id: None,
      all_day: true,
      all_members: false,
      tag_id: None,
      recurrence_parent_id: None,
      participants: vec![],
      reminders: vec![],
      payload: serde_json::json!({"allDay":true}),
      updated_at: Utc::now(),
      etag: None,
      remote_href: None,
    };
    let from = "2011-11-29T00:00:00Z".parse().unwrap();
    let to = "2012-02-01T00:00:00Z".parse().unwrap();
    let preview = crate::scheduling::preview(&rule, None, 5, CalculationBudget::default())
      .unwrap()
      .into_iter()
      .map(|slot| slot.nominal.date().and_hms_opt(0, 0, 0).unwrap().and_utc())
      .collect::<Vec<_>>();
    assert_eq!(preview, vec![start, "2012-01-30T00:00:00Z".parse().unwrap()]);
    let projected = occurrences(&event, &timing, from, to).unwrap();
    assert_eq!(
      projected.iter().map(|slot| slot.instance_start).collect::<Vec<_>>(),
      preview,
      "a UTC clone must not resurrect a civil date skipped by the shared clock"
    );
    assert!(
      projected
        .iter()
        .all(|slot| slot.instance_end - slot.instance_start == Duration::days(1)),
      "UTC DATE identity and authored day duration stay stable across the offset jump"
    );
    let export = export_projection(start, true, &timing).unwrap();
    let standard = crate::scheduling::rrule::expand_rrule(
      export.rrule.as_deref().unwrap(),
      start,
      Duration::days(1),
      from,
      to,
      &export.excluded_slots,
      CalculationBudget::default(),
    )
    .unwrap();
    assert_eq!(
      standard.iter().map(|slot| slot.0).collect::<Vec<_>>(),
      preview,
      "standard DATE properties must express the concrete omission, not depend on private admission metadata"
    );
    let mut moved = projected[1].clone();
    moved.is_override = true;
    moved.override_payload = Some(serde_json::json!({"starts_at":from,"ends_at":start}));
    assert_eq!(
      (
        next_reminder_instance(&event, &timing, &[moved.clone()], &BTreeSet::new())
          .unwrap()
          .map(|instance| instance.instance_start),
        next_reminder_instance(
          &event,
          &timing,
          &[moved.clone()],
          &BTreeSet::from([moved.instance_start])
        )
        .unwrap()
        .map(|instance| instance.instance_start),
      ),
      (Some(moved.instance_start), Some(start)),
      "a moved later DATE slot is delivered first without consuming an earlier natural slot"
    );
  }
}
