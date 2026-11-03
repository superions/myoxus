// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canonical Calendar timing; native exceptions retain their existing owner.

use chrono::{DateTime, SubsecRound, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{AdmissionZone, RecurrenceRule, ScheduleLifecycle};

/// Check the locked native source, not a potentially stale application read.
pub fn validate_native_rule(
  rule: &RecurrenceRule,
  start: DateTime<Utc>,
  all_day: bool,
) -> Result<(), super::CalculationError> {
  rule.validate()?;
  let expected = if all_day {
    super::ScheduleValue::Date(start.date_naive())
  } else {
    super::ScheduleValue::LocalDateTime(
      start
        .with_timezone(&rule.zone.timezone())
        .naive_local()
        .trunc_subsecs(6),
    )
  };
  if rule.start != expected {
    return Err(super::CalculationError::InvalidRule);
  }
  Ok(())
}

/// Match PostgreSQL event/occurrence precision before comparing a civil DTSTART
/// with its persisted event. Sub-microsecond transport bits cannot retime it.
pub fn canonical_rule(mut rule: RecurrenceRule) -> RecurrenceRule {
  let civil = |value| match value {
    super::ScheduleValue::Date(date) => super::ScheduleValue::Date(date),
    super::ScheduleValue::LocalDateTime(local) => super::ScheduleValue::LocalDateTime(local.trunc_subsecs(6)),
  };
  rule.start = civil(rule.start);
  rule.end = rule.end.map(civil);
  rule
}

/// Preserve the pinned selector/end while a native source changes its start or
/// date kind. This is not a replacement rule supplied by a client.
pub fn rule_with_start(rule: &RecurrenceRule, start: DateTime<Utc>, all_day: bool) -> RecurrenceRule {
  let mut next = rule.clone();
  next.start = if all_day {
    super::ScheduleValue::Date(start.date_naive())
  } else {
    super::ScheduleValue::LocalDateTime(start.with_timezone(&rule.zone.timezone()).naive_local())
  };
  if std::mem::discriminant(&next.start) != std::mem::discriminant(&rule.start) {
    next.end = rule.end.map(|end| next.start.on_date(end.date()));
  }
  canonical_rule(next)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CalendarTimingRule {
  Fixed {
    rule: RecurrenceRule,
  },
  /// Provider source, never a second native editing model. Preserve COUNT,
  /// UNTIL and unsupported forms verbatim; validation is a bounded calculation.
  ImportedCalendar {
    rrule: String,
    starts_at: DateTime<Utc>,
    all_day: bool,
    zone: AdmissionZone,
  },
}

impl CalendarTimingRule {
  pub fn zone(&self) -> AdmissionZone {
    match self {
      Self::Fixed { rule } => rule.zone,
      Self::ImportedCalendar { zone, .. } => *zone,
    }
  }
}

#[derive(Debug, Clone)]
pub struct CalendarTiming {
  pub id: Uuid,
  pub zone: AdmissionZone,
  pub revision: i64,
  pub lifecycle: ScheduleLifecycle,
  pub paused_at: Option<DateTime<Utc>>,
  pub pauses: Vec<CalendarPauseInterval>,
  /// Exclusive original-slot cutoff; the valid base definition remains retained.
  pub ends_before: Option<DateTime<Utc>>,
  pub rule: Option<CalendarTimingRule>,
  /// A malformed/oversized imported source remains on its native event and
  /// cannot silently become an empty or editable native series.
  pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CalendarPauseInterval {
  pub starts_at: DateTime<Utc>,
  pub ends_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CalendarTimingChange {
  Pause,
  Resume,
  End,
}

impl CalendarTiming {
  /// Translate an action instant to the first not-yet-started original date
  /// key. Date identities stay UTC midnights, but their day belongs to the pin.
  /// Subtracting one microsecond keeps an exact first-valid boundary inclusive.
  pub fn pause_key_bound(&self, instant: DateTime<Utc>) -> DateTime<Utc> {
    let all_day = match &self.rule {
      Some(CalendarTimingRule::Fixed { rule }) => matches!(rule.start, super::ScheduleValue::Date(_)),
      Some(CalendarTimingRule::ImportedCalendar { all_day, .. }) => *all_day,
      None => false,
    };
    if !all_day {
      return instant;
    }
    instant
      .checked_sub_signed(chrono::Duration::microseconds(1))
      .unwrap_or(instant)
      .with_timezone(&self.zone.timezone())
      .date_naive()
      .succ_opt()
      .map(|date| date.and_time(chrono::NaiveTime::MIN).and_utc())
      .unwrap_or(DateTime::<Utc>::MAX_UTC)
  }

  pub fn pause_key_window(&self, pause: CalendarPauseInterval) -> (DateTime<Utc>, DateTime<Utc>) {
    (
      self.pause_key_bound(pause.starts_at),
      self.pause_key_bound(pause.ends_at),
    )
  }

  /// Original keys, not override display times, decide intentional suppression.
  pub fn suppresses(&self, key: DateTime<Utc>) -> bool {
    self.ends_before.is_some_and(|end| key >= end)
      || self.paused_at.is_some_and(|start| key >= self.pause_key_bound(start))
      || self.pauses.iter().any(|pause| {
        let (start, end) = self.pause_key_window(*pause);
        key >= start && key < end
      })
  }

  pub fn effective_cutoff(&self) -> Option<DateTime<Utc>> {
    self
      .ends_before
      .into_iter()
      .chain(self.paused_at.map(|start| self.pause_key_bound(start)))
      .min()
  }
}

/// Disposable server projection carried with export/mail snapshots. The rule
/// and pause intervals in SQL remain authoritative; this is never an input API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarExportProjection {
  pub rrule: Option<String>,
  pub excluded_slots: Vec<DateTime<Utc>>,
  pub suppressed: bool,
}

/// Apply a trusted snapshot projection as ordinary RFC properties. Consumers
/// must still emit RRULE/EXDATE/STATUS; the private metadata is not a substitute.
pub fn export_payload(payload: &serde_json::Value, all_day: bool) -> serde_json::Value {
  let mut projected = payload.clone();
  let Some(projection) = payload
    .get("_myoxusCalendarTiming")
    .and_then(|value| serde_json::from_value::<CalendarExportProjection>(value.clone()).ok())
  else {
    return projected;
  };
  if let Some(rule) = projection.rrule {
    projected["rrule"] = serde_json::json!(rule);
  }
  let mut dates = payload["exdates"].as_array().cloned().unwrap_or_default();
  let mut tokens = payload["exdate"]
    .as_str()
    .unwrap_or_default()
    .split(',')
    .filter(|value| !value.is_empty())
    .map(str::to_owned)
    .collect::<std::collections::BTreeSet<_>>();
  for slot in projection.excluded_slots {
    let value = serde_json::json!(slot.to_rfc3339());
    if !dates.contains(&value) {
      dates.push(value);
    }
    tokens.insert(
      slot
        .format(if all_day { "%Y%m%d" } else { "%Y%m%dT%H%M%SZ" })
        .to_string(),
    );
  }
  if !dates.is_empty() {
    projected["exdates"] = serde_json::json!(dates);
  }
  if !tokens.is_empty() {
    projected["exdate"] = serde_json::json!(tokens.into_iter().collect::<Vec<_>>().join(","));
  }
  if projection.suppressed {
    projected["status"] = serde_json::json!("CANCELLED");
  }
  projected
}

/// Shared standard recurrence properties for ICS and provider writeback. Keep
/// original parameterized exclusions/dates; append native UTC/date exclusions.
pub fn recurrence_lines(payload: &serde_json::Value, all_day: bool) -> Vec<String> {
  let payload = export_payload(payload, all_day);
  let mut lines = Vec::new();
  // Unsupported content-line sets are a joined source sentinel, not one RRULE
  // value. Emit the original structured properties with normal CRLF framing.
  let source_rule = payload["rrule"]
    .as_str()
    .is_some_and(|rule| rule.chars().any(char::is_control));
  if let Some(rule) = payload["rrule"].as_str().filter(|_| !source_rule) {
    let rule = if rule
      .get(..6)
      .is_some_and(|prefix| prefix.eq_ignore_ascii_case("RRULE:"))
    {
      &rule[6..]
    } else {
      rule
    };
    lines.push(format!("RRULE:{rule}"));
  }
  let source = payload["sourceRecurrence"]
    .as_array()
    .into_iter()
    .flatten()
    .filter_map(|line| line.as_str())
    .filter(|line| {
      line.split([';', ':']).next().is_some_and(|name| {
        name.eq_ignore_ascii_case("EXDATE")
          || name.eq_ignore_ascii_case("RDATE")
          || name.eq_ignore_ascii_case("EXRULE")
          || (source_rule && name.eq_ignore_ascii_case("RRULE"))
      })
    })
    .filter(|line| !line.chars().any(char::is_control))
    .collect::<Vec<_>>();
  let has_exdates = source.iter().any(|line| {
    line
      .split([';', ':'])
      .next()
      .is_some_and(|name| name.eq_ignore_ascii_case("EXDATE"))
  });
  lines.extend(source.into_iter().map(str::to_owned));
  if !has_exdates && let Some(exdate) = payload["exdate"].as_str().filter(|value| !value.is_empty()) {
    lines.push(format!("EXDATE{}:{exdate}", if all_day { ";VALUE=DATE" } else { "" }));
  }
  if let Some(dates) = payload["exdates"].as_array() {
    let values = dates
      .iter()
      .filter_map(|value| value.as_str())
      .filter_map(|value| DateTime::parse_from_rfc3339(value).ok())
      .map(|time| {
        time
          .with_timezone(&Utc)
          .format(if all_day { "%Y%m%d" } else { "%Y%m%dT%H%M%SZ" })
          .to_string()
      })
      .collect::<std::collections::BTreeSet<_>>();
    if !values.is_empty() {
      lines.push(format!(
        "EXDATE{}:{}",
        if all_day { ";VALUE=DATE" } else { "" },
        values.into_iter().collect::<Vec<_>>().join(",")
      ));
    }
  }
  lines.sort();
  lines.dedup();
  lines
}

#[derive(Debug, Clone)]
pub struct ConfirmedCalendarRecurrence {
  pub rule: RecurrenceRule,
  pub actor_id: Uuid,
}

/// Native ICS import retains provider semantics without pretending that an
/// imported rule was authored through the native selector form.
#[derive(Debug, Clone)]
pub struct ImportedCalendarSource {
  pub uid: String,
  pub rrule: Option<String>,
  pub original_timezone: Option<String>,
  pub recurrence_id: Option<String>,
  pub lines: Vec<String>,
  pub status: Option<String>,
}
