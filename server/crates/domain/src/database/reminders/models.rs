// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native reminder values and timezone-safe schedule semantics.
use crate::database::*;

/// Derive the established UTC trigger without changing all-day semantics:
/// date-only reminders use 09:00 in the Cell's IANA timezone, timed values
/// use their stored instant. Shared by scheduling and locked SQL revalidation.
pub fn database_row_reminder_trigger_at(
  value: &DatabaseDateTimeValue,
  offset_minutes: i64,
) -> Result<DateTime<Utc>, &'static str> {
  if offset_minutes < 0 {
    return Err("database reminder offset must be zero or greater");
  }
  let baseline = if value.all_day {
    let zone = value
      .time_zone
      .parse::<chrono_tz::Tz>()
      .map_err(|_| "database reminder timezone is invalid")?;
    database_row_reminder_all_day_baseline(value.start.with_timezone(&zone).date_naive(), zone)?
  } else {
    value.start
  };
  baseline
    .checked_sub_signed(chrono::Duration::minutes(offset_minutes))
    .ok_or("database reminder trigger is out of range")
}

pub fn database_row_reminder_all_day_baseline(
  date: NaiveDate,
  zone: chrono_tz::Tz,
) -> Result<DateTime<Utc>, &'static str> {
  use chrono::TimeZone;
  let local = date.and_time(chrono::NaiveTime::from_hms_opt(9, 0, 0).expect("09:00 is a valid wall time"));
  match zone.from_local_datetime(&local) {
    chrono::LocalResult::Single(value) => Ok(value.with_timezone(&Utc)),
    chrono::LocalResult::Ambiguous(_, _) | chrono::LocalResult::None => {
      Err("database reminder local trigger is ambiguous or nonexistent")
    }
  }
}

/// Personal reminders require a known open Task status. An absent value on a
/// valid Status field is the native unstarted state; unknown/wrong-type values
/// are unavailable rather than an inferred open Task.
pub fn database_task_status_allows_reminders(
  config: &DatabaseStatusFieldConfig,
  value: Option<&DatabaseCellValueData>,
) -> bool {
  if validate_database_status_field_config(config).is_err() {
    return false;
  }
  match value {
    None => true,
    Some(DatabaseCellValueData::Status(id)) => config.options.iter().any(|option| {
      option.id == *id
        && !matches!(
          option.group,
          DatabaseStatusGroup::Complete | DatabaseStatusGroup::Archived
        )
    }),
    _ => false,
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseRowReminderStatus {
  Scheduled,
  Claimed,
  Fired,
  Cancelled,
}

impl DatabaseRowReminderStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Scheduled => "scheduled",
      Self::Claimed => "claimed",
      Self::Fired => "fired",
      Self::Cancelled => "cancelled",
    }
  }

  pub fn from_db(value: &str) -> Result<Self, DatabaseDomainError> {
    match value {
      "scheduled" => Ok(Self::Scheduled),
      "claimed" => Ok(Self::Claimed),
      "fired" => Ok(Self::Fired),
      "cancelled" => Ok(Self::Cancelled),
      other => Err(DatabaseDomainError::Validation(format!(
        "unknown database_row_reminders.status: {other}"
      ))),
    }
  }
}

/// One authenticated user's reminder for a DateTime Cell.
///
/// Trigger and revision project the canonical shared one-shot. Native status
/// and completion facts remain with this personal source, not with queue leases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRowReminder {
  pub id: Uuid,
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub row_id: DatabaseRowId,
  pub field_id: DatabaseFieldId,
  pub user_id: UserId,
  pub offset_minutes: i64,
  pub trigger_at: DateTime<Utc>,
  pub status: DatabaseRowReminderStatus,
  pub schedule_revision: i64,
  pub fired_at: Option<DateTime<Utc>>,
  pub cancelled_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseRowReminderReschedule {
  pub reminder_id: Uuid,
  pub expected_schedule_revision: i64,
  pub trigger_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseRowReminderDispatch {
  pub reminder: DatabaseRowReminder,
  pub row_title: String,
  pub field_name: String,
  pub scheduled_for: DateTime<Utc>,
}
