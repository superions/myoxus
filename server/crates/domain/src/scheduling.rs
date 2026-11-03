// SPDX-License-Identifier: AGPL-3.0-or-later
//! Calendar-valued timing definitions. Admission instants never replace nominal Due values.

use std::num::NonZeroU32;

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc, Weekday};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod calendar;
pub mod registered;

/// Missed-slot admission policy. RunOnce retains only the newest missed UTC
/// instant while its native execution owner is busy; Skip does not retain it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CronMisfirePolicy {
  Skip,
  RunOnce,
}

/// Wake only the already accepted native Git Run. The slot generation binds
/// this handoff to its receipt; native Run lifecycle still owns execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitScheduleDispatch {
  pub schedule_id: uuid::Uuid,
  pub generation: i64,
  pub run_id: uuid::Uuid,
}

/// Identifier-only delivery for an already admitted native rotation attempt.
/// No credential payload crosses the shared clock or queue boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitRotationDispatch {
  pub schedule_id: uuid::Uuid,
  pub generation: i64,
  pub profile_id: uuid::Uuid,
  pub attempt_id: uuid::Uuid,
}

impl std::fmt::Display for CronMisfirePolicy {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Skip => f.write_str("Skip"),
      Self::RunOnce => f.write_str("RunOnce"),
    }
  }
}

/// Pinned when a plan is confirmed, independently of later regional preferences.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AdmissionZone(Tz);

impl AdmissionZone {
  pub fn timezone(self) -> Tz {
    self.0
  }
}

impl TryFrom<String> for AdmissionZone {
  type Error = CalculationError;

  fn try_from(value: String) -> Result<Self, Self::Error> {
    value.parse().map(Self).map_err(|_| CalculationError::InvalidZone)
  }
}

impl From<AdmissionZone> for String {
  fn from(value: AdmissionZone) -> Self {
    value.0.name().to_owned()
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ScheduleValue {
  Date(NaiveDate),
  LocalDateTime(NaiveDateTime),
}

impl ScheduleValue {
  pub fn date(self) -> NaiveDate {
    match self {
      Self::Date(date) => date,
      Self::LocalDateTime(value) => value.date(),
    }
  }

  pub fn on_date(self, date: NaiveDate) -> Self {
    match self {
      Self::Date(_) => Self::Date(date),
      Self::LocalDateTime(value) => Self::LocalDateTime(date.and_time(value.time())),
    }
  }

  pub fn local_datetime(self) -> NaiveDateTime {
    match self {
      Self::Date(date) => date.and_time(chrono::NaiveTime::MIN),
      Self::LocalDateTime(value) => value,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "day", rename_all = "snake_case")]
pub enum MonthDay {
  Day(u32),
  Last,
}

/// Only native authorable selectors. Imported RRULE forms stay read/preserve-only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "frequency", rename_all = "snake_case")]
pub enum RecurrenceSelector {
  Daily,
  Weekly { weekdays: Vec<Weekday> },
  Monthly { day: MonthDay },
  Yearly { month: u32, day: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecurrenceRule {
  pub selector: RecurrenceSelector,
  pub interval: NonZeroU32,
  pub start: ScheduleValue,
  /// Inclusive and of the same kind as `start`.
  pub end: Option<ScheduleValue>,
  pub zone: AdmissionZone,
}

impl RecurrenceRule {
  pub fn validate(&self) -> Result<(), CalculationError> {
    if let Some(end) = self.end
      && (std::mem::discriminant(&end) != std::mem::discriminant(&self.start) || end < self.start)
    {
      return Err(CalculationError::InvalidRule);
    }
    let valid = match &self.selector {
      RecurrenceSelector::Daily => true,
      RecurrenceSelector::Weekly { weekdays } => !weekdays.is_empty() && weekdays.len() <= 7,
      RecurrenceSelector::Monthly {
        day: MonthDay::Day(day),
      } => (1..=31).contains(day),
      RecurrenceSelector::Monthly { day: MonthDay::Last } => true,
      // A leap year admits February 29, but never an impossible month/day.
      RecurrenceSelector::Yearly { month, day } => NaiveDate::from_ymd_opt(2000, *month, *day).is_some(),
    };
    if valid {
      Ok(())
    } else {
      Err(CalculationError::InvalidRule)
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelativeUnit {
  Days,
  Weeks,
  Months,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelativeInterval {
  pub amount: NonZeroU32,
  pub unit: RelativeUnit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Occurrence {
  /// Stable nominal slot identity; never derived from admission/retry time.
  pub nominal: ScheduleValue,
  /// Technical admission instant at PostgreSQL microsecond precision, in the
  /// plan's pinned zone. Nominal date/wall-time identity above remains unchanged.
  pub due_at: DateTime<Utc>,
}

/// Per-call limits, not recurrence limits. Exceeding either returns an error,
/// never a successful partial window or an artificial end to COUNT.
#[derive(Debug, Clone, Copy)]
pub struct CalculationBudget {
  pub scans: usize,
  pub results: usize,
}

impl Default for CalculationBudget {
  fn default() -> Self {
    Self {
      scans: 100_000,
      results: 10_000,
    }
  }
}

impl CalculationBudget {
  pub fn validate(self) -> Result<(), CalculationError> {
    let maximum = Self::default();
    if self.scans == 0 || self.scans > maximum.scans || self.results == 0 || self.results > maximum.results {
      return Err(CalculationError::InvalidBudget);
    }
    Ok(())
  }
}

/// Safe to report without retaining the raw imported rule or document payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum CalculationError {
  #[error("invalid recurrence rule")]
  InvalidRule,
  #[error("unsupported imported recurrence rule")]
  UnsupportedRule,
  #[error("invalid IANA admission zone")]
  InvalidZone,
  #[error("invalid calculation window")]
  InvalidWindow,
  #[error("invalid calculation budget")]
  InvalidBudget,
  #[error("recurrence scan budget exhausted")]
  ScanBudgetExceeded,
  #[error("recurrence result budget exhausted")]
  ResultBudgetExceeded,
  #[error("recurrence exceeds the supported calendar range")]
  DateOutOfRange,
}

/// Closed native destinations only. Recipe data belongs to the Task series,
/// not to a second authoring model on the timing definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScheduleTarget {
  RegisteredJob {
    job: registered::RegisteredJob,
  },
  RecurringTask {
    series_id: uuid::Uuid,
  },
  /// Projection-only: view windows never admit an execution or workflow Run.
  CalendarMaster {
    event_id: uuid::Uuid,
  },
  /// Native recipient effects remain Calendar-owned. This references a reminder
  /// definition and its current source, never a copied editable Calendar rule.
  CalendarReminder {
    definition_id: uuid::Uuid,
    event_id: uuid::Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_fingerprint: Option<String>,
  },
  /// A personal native DateTime reminder; target/ACL/Task validation and the
  /// notification envelope remain with the Database capability.
  DatabaseReminder {
    reminder_id: uuid::Uuid,
  },
  /// Native Git owns its rule/settings, Run admission and receiver validation.
  /// Shared timing retains the next/pending UTC slots rather than a local fold.
  GitCron {
    profile_id: uuid::Uuid,
  },
  /// Native Run activity reanchors the inactivity interval, irrespective of
  /// trigger source or terminal outcome. Queue retries are not new admissions.
  GitPolling {
    profile_id: uuid::Uuid,
  },
  GitRotation {
    credential_id: uuid::Uuid,
    source_fingerprint: String,
  },
  /// Standing consent belongs to this document identity, never copied metadata.
  DocumentReview {
    document_id: uuid::Uuid,
    enabled: bool,
    confirmed_by: uuid::Uuid,
    package: crate::assistant_package::AssistantPackageIdentity,
    locale: String,
    /// Derived input, refreshed only with the canonical metadata transaction.
    effective_deadline: Option<DateTime<Utc>>,
  },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleLifecycle {
  Active,
  Paused,
  Ended,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScheduleRule {
  Fixed {
    rule: RecurrenceRule,
  },
  /// Date kind is pinned from the adopted Due; a Task without Due uses the
  /// completion's local timestamp. Regional changes never retime this rule.
  AfterCompletion {
    interval: RelativeInterval,
    date_only: bool,
  },
}

impl ScheduleRule {
  pub fn validate(&self, zone: AdmissionZone) -> Result<(), CalculationError> {
    match self {
      Self::Fixed { rule } => {
        rule.validate()?;
        if rule.zone != zone {
          return Err(CalculationError::InvalidZone);
        }
      }
      Self::AfterCompletion { .. } => {}
    }
    Ok(())
  }
}

#[derive(Debug, Clone)]
pub struct ScheduledPlan {
  pub id: uuid::Uuid,
  pub zone: AdmissionZone,
  pub workspace_id: uuid::Uuid,
  pub actor_id: Option<uuid::Uuid>,
  pub target: ScheduleTarget,
  /// None is a native one-shot intent; recurring modes retain their rule even
  /// when they have no pending admission cursor.
  pub rule: Option<ScheduleRule>,
  pub lifecycle: ScheduleLifecycle,
  pub generation: i64,
  pub revision: i64,
  pub next: Option<Occurrence>,
  /// Relative identity is the advancing member, never its possibly repeated Due.
  pub next_cause_member_id: Option<uuid::Uuid>,
  /// May precede nominal Due for one-next lookahead. Never becomes slot identity.
  pub next_admission_at: Option<DateTime<Utc>>,
  pub blocked_reason: Option<String>,
}

pub fn occurrence_id(schedule: uuid::Uuid, nominal: ScheduleValue) -> uuid::Uuid {
  let identity = match nominal {
    ScheduleValue::Date(date) => format!("date:{date}"),
    ScheduleValue::LocalDateTime(value) => format!("local:{value}"),
  };
  uuid::Uuid::new_v5(&schedule, identity.as_bytes())
}

pub fn document_review_schedule_id(document: uuid::Uuid) -> uuid::Uuid {
  uuid::Uuid::new_v5(&document, b"document-validity-review")
}

/// Metadata cycles identify absolute source instants, not ambiguous civil labels.
pub fn document_review_occurrence_id(document: uuid::Uuid, deadline: DateTime<Utc>) -> uuid::Uuid {
  occurrence_id(
    document_review_schedule_id(document),
    ScheduleValue::LocalDateTime(deadline.naive_utc()),
  )
}

pub fn task_occurrence_id(schedule: uuid::Uuid, nominal: ScheduleValue, cause: Option<uuid::Uuid>) -> uuid::Uuid {
  cause.map_or_else(
    || occurrence_id(schedule, nominal),
    |member| uuid::Uuid::new_v5(&schedule, format!("after-completion:{member}").as_bytes()),
  )
}

/// Operator-confirmed generations may replace unstarted dispatches, never the
/// slot/Task identity or a committed member. Ordinary retries keep this Run ID.
pub fn task_run_id(occurrence: uuid::Uuid, generation: i64) -> uuid::Uuid {
  if generation == 1 {
    uuid::Uuid::new_v5(&occurrence, b"run")
  } else {
    uuid::Uuid::new_v5(&occurrence, format!("run:{generation}").as_bytes())
  }
}
