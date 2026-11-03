// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared recurrence calculation, independent of provider I/O and persistence.

pub mod admission;
pub mod cron;
pub mod git;
mod native;
pub mod registered;
pub mod rrule;

pub use native::{date_exclusions, next_after, preview, relative_after, window};
pub(crate) use native::{first_matching, fixed_occurrence};

use myoxus_domain::scheduling::{CalculationBudget, CalculationError};

struct ScanBudget {
  remaining: usize,
  results: usize,
}

impl ScanBudget {
  fn new(budget: CalculationBudget) -> Result<Self, CalculationError> {
    budget.validate()?;
    Ok(Self {
      remaining: budget.scans,
      results: budget.results,
    })
  }

  fn scan(&mut self) -> Result<(), CalculationError> {
    self.remaining = self
      .remaining
      .checked_sub(1)
      .ok_or(CalculationError::ScanBudgetExceeded)?;
    Ok(())
  }

  fn push<T>(&self, results: &mut Vec<T>, value: T) -> Result<(), CalculationError> {
    if results.len() >= self.results {
      return Err(CalculationError::ResultBudgetExceeded);
    }
    results.push(value);
    Ok(())
  }
}
