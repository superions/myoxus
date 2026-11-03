// SPDX-License-Identifier: AGPL-3.0-or-later
//! Preserve the old registered scheduler's no-backlog policy: compute the next
//! future Cron instant, or an interval from this admission/startup instant.
use chrono::{DateTime, Duration, Utc};
use myoxus_domain::scheduling::{CalculationError, registered::WorkerTiming};
use std::str::FromStr;

pub fn next_after(timing: &WorkerTiming, now: DateTime<Utc>) -> Result<DateTime<Utc>, CalculationError> {
  match timing {
    WorkerTiming::UtcCron { expression } => {
      if expression.split_whitespace().count() != 6 {
        return Err(CalculationError::InvalidRule);
      }
      cron::Schedule::from_str(expression)
        .map_err(|_| CalculationError::InvalidRule)?
        .after(&now)
        .next()
        .ok_or(CalculationError::DateOutOfRange)
    }
    WorkerTiming::Interval { every_ms } => {
      if *every_ms == 0 {
        return Err(CalculationError::InvalidRule);
      }
      let millis = i64::try_from(*every_ms).map_err(|_| CalculationError::InvalidRule)?;
      now
        .checked_add_signed(Duration::milliseconds(millis))
        .ok_or(CalculationError::DateOutOfRange)
    }
  }
}
