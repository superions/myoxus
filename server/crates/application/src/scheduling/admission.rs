// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded native Task preparation. SQL owns slot/Run/snapshot admission together.

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use myoxus_domain::{
  scheduling::{CalculationBudget, CalculationError, Occurrence, ScheduleRule, ScheduledPlan},
  workspace_automation::{AcceptedRecurringTask, AutomationExecutionPolicy},
};

/// The native feature resolves its own recipe and current permissions. No
/// generic trigger, arbitrary queue target or synthetic actor crosses this port.
#[async_trait]
pub trait RecurringTaskSource: Send + Sync {
  async fn prepare(&self, plan: &ScheduledPlan, slot: Occurrence) -> Result<AcceptedRecurringTask, &'static str>;
}

#[derive(Debug, Default)]
pub struct AdmissionReport {
  pub admitted: usize,
  pub blocked: usize,
  pub raced: usize,
  pub budget_exhausted: bool,
}

/// At most newest-missed plus next-future; intentional pause exclusion is
/// represented by the native owner's reanchored cursor, not an outage backlog.
pub fn task_slots(plan: &ScheduledPlan, now: DateTime<Utc>) -> Result<Vec<Occurrence>, CalculationError> {
  let Some(next) = plan.next else { return Ok(Vec::new()) };
  let Some(ScheduleRule::Fixed { rule }) = &plan.rule else {
    return Ok(vec![next]);
  };
  if next.due_at > now {
    return Ok(vec![next]);
  }
  let to = now
    .checked_add_signed(Duration::nanoseconds(1))
    .ok_or(CalculationError::DateOutOfRange)?;
  let mut slots = super::window(rule, next.due_at, to, CalculationBudget::default())?
    .into_iter()
    .next_back()
    .into_iter()
    .collect::<Vec<_>>();
  if let Some(future) = super::next_after(rule, now, CalculationBudget::default())? {
    slots.push(future);
  }
  Ok(slots)
}

pub fn task_policy() -> AutomationExecutionPolicy {
  AutomationExecutionPolicy {
    max_actions_per_run: 1,
    max_retry_attempts: 5,
    webhook_timeout_seconds: 60,
  }
}
