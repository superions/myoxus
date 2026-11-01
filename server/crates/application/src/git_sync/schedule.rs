// SPDX-License-Identifier: AGPL-3.0-or-later
//! Server-owned Git-Sync Cron schedule parsing and occurrence decisions.

use std::str::FromStr;

use chrono::{DateTime, Duration, LocalResult, TimeZone, Utc};
use chrono_tz::{OffsetComponents, Tz};
use cron::Schedule;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use myoxus_domain::git_sync::GitSyncCronMisfirePolicy;

const MINIMUM_INTERVAL: Duration = Duration::minutes(5);
const VALIDATION_OCCURRENCE_COUNT: usize = 8;
const MAX_RECORDED_DUE_OCCURRENCES: usize = 4_096;
const MAX_REVERSE_LOOKUP_OCCURRENCES: usize = 1_024;
pub const ON_TIME_GRACE: Duration = Duration::seconds(90);

#[derive(Debug, Clone)]
pub struct GitSyncCronSchedule {
  canonical_expression: String,
  timezone_name: String,
  timezone: Tz,
  schedule: Schedule,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncScheduleOccurrence {
  pub scheduled_at_utc: DateTime<Utc>,
  pub local_date_time: String,
  pub utc_offset_seconds: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitSyncScheduleDecision {
  pub run_scheduled_for: Option<DateTime<Utc>>,
  pub next_scheduled_at: DateTime<Utc>,
  pub pending_misfire_scheduled_for: Option<DateTime<Utc>>,
  pub skipped_occurrences: usize,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum GitSyncScheduleError {
  #[error("Cron expression must contain exactly five fields")]
  FieldCount,
  #[error("Cron aliases are not supported; provide a canonical five-field expression")]
  Alias,
  #[error("invalid Cron expression: {0}")]
  Expression(String),
  #[error("unknown IANA timezone: {0}")]
  Timezone(String),
  #[error("Cron schedule must not produce occurrences less than five minutes apart")]
  TooFrequent,
  #[error("Cron schedule has no future occurrence")]
  NoFutureOccurrence,
}

impl GitSyncCronSchedule {
  pub fn parse(expression: &str, timezone: &str) -> Result<Self, GitSyncScheduleError> {
    let canonical_expression = expression.split_whitespace().collect::<Vec<_>>().join(" ");
    if canonical_expression.starts_with('@') {
      return Err(GitSyncScheduleError::Alias);
    }
    if canonical_expression.split(' ').count() != 5 {
      return Err(GitSyncScheduleError::FieldCount);
    }
    let timezone_name = timezone.trim().to_string();
    let timezone = Tz::from_str(&timezone_name).map_err(|_| GitSyncScheduleError::Timezone(timezone_name.clone()))?;
    // cron 0.12 expects seconds as its first field. Product input deliberately
    // remains the conventional five-field form.
    let schedule = Schedule::from_str(&format!("0 {canonical_expression}"))
      .map_err(|error| GitSyncScheduleError::Expression(error.to_string()))?;
    let value = Self {
      canonical_expression,
      timezone_name,
      timezone,
      schedule,
    };
    let occurrences = value.occurrences_after(
      DateTime::parse_from_rfc3339("2024-01-01T00:00:00Z")
        .expect("fixed RFC3339 probe")
        .with_timezone(&Utc),
      VALIDATION_OCCURRENCE_COUNT,
    )?;
    for pair in occurrences.windows(2) {
      if pair[1].scheduled_at_utc - pair[0].scheduled_at_utc < MINIMUM_INTERVAL {
        return Err(GitSyncScheduleError::TooFrequent);
      }
    }
    Ok(value)
  }

  pub fn expression(&self) -> &str {
    &self.canonical_expression
  }

  pub fn timezone_name(&self) -> &str {
    &self.timezone_name
  }

  pub fn occurrences_after(
    &self,
    after: DateTime<Utc>,
    count: usize,
  ) -> Result<Vec<GitSyncScheduleOccurrence>, GitSyncScheduleError> {
    // Iterate the Cron expression as floating local wall time. The cron crate's
    // direct zoned iterator drops ambiguous fall-back times; explicit timezone
    // resolution is required so one local time can yield two distinct UTC
    // slots while nonexistent spring-forward times yield none.
    let local_start = after.with_timezone(&self.timezone).naive_local() - Duration::days(1);
    let floating_start = DateTime::<Utc>::from_naive_utc_and_offset(local_start, Utc);
    let mut occurrences = Vec::with_capacity(count + 1);
    let mut had_enough = false;
    for floating in self.schedule.after(&floating_start).take(100_000) {
      let local = floating.naive_utc();
      let resolved = match self.timezone.from_local_datetime(&local) {
        LocalResult::Single(value) => vec![value],
        LocalResult::Ambiguous(first, second) => vec![first, second],
        LocalResult::None => Vec::new(),
      };
      for occurrence in resolved {
        let scheduled_at_utc = occurrence.with_timezone(&Utc);
        if scheduled_at_utc > after {
          occurrences.push(GitSyncScheduleOccurrence {
            scheduled_at_utc,
            local_date_time: occurrence.format("%Y-%m-%dT%H:%M:%S").to_string(),
            utc_offset_seconds: i32::try_from(
              occurrence.offset().base_utc_offset().num_seconds() + occurrence.offset().dst_offset().num_seconds(),
            )
            .expect("IANA UTC offsets fit in i32 seconds"),
          });
        }
      }
      if had_enough {
        break;
      }
      had_enough = occurrences.len() >= count;
    }
    occurrences.sort_by_key(|value| value.scheduled_at_utc);
    occurrences.dedup_by_key(|value| value.scheduled_at_utc);
    occurrences.truncate(count);
    if occurrences.len() != count {
      return Err(GitSyncScheduleError::NoFutureOccurrence);
    }
    Ok(occurrences)
  }

  pub fn next_after(&self, after: DateTime<Utc>) -> Result<DateTime<Utc>, GitSyncScheduleError> {
    self
      .occurrences_after(after, 1)?
      .into_iter()
      .next()
      .map(|value| value.scheduled_at_utc)
      .ok_or(GitSyncScheduleError::NoFutureOccurrence)
  }

  fn latest_at_or_before(&self, at: DateTime<Utc>) -> Result<DateTime<Utc>, GitSyncScheduleError> {
    // Starting one local day ahead covers UTC-offset and fall-back ordering:
    // a wall-clock occurrence later than `at` can still represent an earlier
    // UTC instant during an offset transition.
    let local_end = at.with_timezone(&self.timezone).naive_local() + Duration::days(1);
    let floating_end = DateTime::<Utc>::from_naive_utc_and_offset(local_end, Utc);
    let mut reverse = self.schedule.after(&floating_end);
    for _ in 0..MAX_REVERSE_LOOKUP_OCCURRENCES {
      let Some(floating) = reverse.next_back() else {
        break;
      };
      let local = floating.naive_utc();
      let latest = match self.timezone.from_local_datetime(&local) {
        LocalResult::Single(value) if value.with_timezone(&Utc) <= at => Some(value.with_timezone(&Utc)),
        LocalResult::Ambiguous(first, second) => [first.with_timezone(&Utc), second.with_timezone(&Utc)]
          .into_iter()
          .filter(|value| *value <= at)
          .max(),
        LocalResult::Single(_) | LocalResult::None => None,
      };
      if let Some(latest) = latest {
        return Ok(latest);
      }
    }
    Err(GitSyncScheduleError::NoFutureOccurrence)
  }

  /// Decide one locked due profile at `now`.
  ///
  /// `unfinished_run` suppresses overlap. RunOnce retains only the most recent
  /// missed slot and admits it once the profile is idle.
  pub fn decide_due(
    &self,
    now: DateTime<Utc>,
    next_scheduled_at: DateTime<Utc>,
    pending_misfire: Option<DateTime<Utc>>,
    policy: GitSyncCronMisfirePolicy,
    unfinished_run: bool,
  ) -> Result<GitSyncScheduleDecision, GitSyncScheduleError> {
    let mut due_count = 0usize;
    let mut latest_due = None;
    let mut cursor = next_scheduled_at;
    while cursor <= now && due_count < MAX_RECORDED_DUE_OCCURRENCES {
      latest_due = Some(cursor);
      due_count += 1;
      cursor = self.next_after(cursor)?;
    }
    if cursor <= now {
      // Exact skipped-run counts are operational metadata, not schedule state.
      // Cap them while still deriving the correct newest due and next slots so
      // a long outage cannot permanently wedge a high-frequency profile.
      latest_due = Some(self.latest_at_or_before(now)?);
      cursor = self.next_after(now)?;
      due_count = MAX_RECORDED_DUE_OCCURRENCES.saturating_add(1);
    }
    let next_scheduled_at = cursor;
    let on_time = latest_due.is_some_and(|slot| now - slot <= ON_TIME_GRACE);
    let most_recent = latest_due.into_iter().chain(pending_misfire).max();

    if unfinished_run {
      return Ok(GitSyncScheduleDecision {
        run_scheduled_for: None,
        next_scheduled_at,
        pending_misfire_scheduled_for: match policy {
          GitSyncCronMisfirePolicy::Skip => None,
          GitSyncCronMisfirePolicy::RunOnce => most_recent,
        },
        skipped_occurrences: due_count,
      });
    }

    let run_scheduled_for = if on_time {
      latest_due
    } else {
      match policy {
        GitSyncCronMisfirePolicy::Skip => None,
        GitSyncCronMisfirePolicy::RunOnce => most_recent,
      }
    };
    Ok(GitSyncScheduleDecision {
      run_scheduled_for,
      next_scheduled_at,
      pending_misfire_scheduled_for: None,
      skipped_occurrences: due_count.saturating_sub(usize::from(run_scheduled_for.is_some())),
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn utc(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value).unwrap().with_timezone(&Utc)
  }

  #[test]
  fn validates_five_fields_timezone_and_minimum_interval() {
    let hourly = GitSyncCronSchedule::parse(" 0   * * * * ", "Europe/Berlin").unwrap();
    assert_eq!(hourly.expression(), "0 * * * *");
    assert_eq!(hourly.timezone_name(), "Europe/Berlin");
    assert!(matches!(
      GitSyncCronSchedule::parse("0 0 * * * *", "UTC"),
      Err(GitSyncScheduleError::FieldCount)
    ));
    assert!(matches!(
      GitSyncCronSchedule::parse("@hourly", "UTC"),
      Err(GitSyncScheduleError::Alias)
    ));
    assert!(matches!(
      GitSyncCronSchedule::parse("* * * * *", "UTC"),
      Err(GitSyncScheduleError::TooFrequent)
    ));
    assert!(matches!(
      GitSyncCronSchedule::parse("0 * * * *", "Not/AZone"),
      Err(GitSyncScheduleError::Timezone(_))
    ));
    assert!(
      GitSyncCronSchedule::parse("0 0 29 2 *", "UTC").is_ok(),
      "a sparse leap-day schedule must not be rejected by validation probing"
    );
  }

  #[test]
  fn spring_gap_is_skipped_and_fall_back_has_two_distinct_utc_slots() {
    let schedule = GitSyncCronSchedule::parse("30 2 * * *", "Europe/Berlin").unwrap();
    let spring = schedule.occurrences_after(utc("2026-03-28T23:00:00Z"), 2).unwrap();
    assert_eq!(spring[0].scheduled_at_utc, utc("2026-03-30T00:30:00Z"));
    let fall = schedule.occurrences_after(utc("2026-10-24T23:00:00Z"), 3).unwrap();
    assert_eq!(fall[0].scheduled_at_utc, utc("2026-10-25T00:30:00Z"));
    assert_eq!(fall[1].scheduled_at_utc, utc("2026-10-25T01:30:00Z"));
  }

  #[test]
  fn skip_and_run_once_misfires_are_deterministic() {
    let schedule = GitSyncCronSchedule::parse("0 * * * *", "UTC").unwrap();
    let now = utc("2026-01-01T05:10:00Z");
    let next = utc("2026-01-01T02:00:00Z");
    let skip = schedule
      .decide_due(now, next, None, GitSyncCronMisfirePolicy::Skip, false)
      .unwrap();
    assert_eq!(skip.run_scheduled_for, None);
    assert_eq!(skip.next_scheduled_at, utc("2026-01-01T06:00:00Z"));
    let once = schedule
      .decide_due(now, next, None, GitSyncCronMisfirePolicy::RunOnce, false)
      .unwrap();
    assert_eq!(once.run_scheduled_for, Some(utc("2026-01-01T05:00:00Z")));
    let overlap = schedule
      .decide_due(now, next, None, GitSyncCronMisfirePolicy::RunOnce, true)
      .unwrap();
    assert_eq!(overlap.run_scheduled_for, None);
    assert_eq!(overlap.pending_misfire_scheduled_for, Some(utc("2026-01-01T05:00:00Z")));
    let retained_newer_pending = schedule
      .decide_due(
        utc("2026-01-01T04:10:00Z"),
        utc("2026-01-01T02:00:00Z"),
        Some(utc("2026-01-01T05:00:00Z")),
        GitSyncCronMisfirePolicy::RunOnce,
        true,
      )
      .unwrap();
    assert_eq!(
      retained_newer_pending.pending_misfire_scheduled_for,
      Some(utc("2026-01-01T05:00:00Z")),
      "an older replay window must not replace a newer durable pending slot"
    );

    let frequent = GitSyncCronSchedule::parse("*/5 * * * *", "UTC").unwrap();
    let long_outage = frequent
      .decide_due(
        utc("2026-01-01T05:10:00Z"),
        utc("2024-01-01T00:00:00Z"),
        None,
        GitSyncCronMisfirePolicy::RunOnce,
        false,
      )
      .unwrap();
    assert_eq!(long_outage.run_scheduled_for, Some(utc("2026-01-01T05:10:00Z")));
    assert_eq!(long_outage.next_scheduled_at, utc("2026-01-01T05:15:00Z"));
  }
}
