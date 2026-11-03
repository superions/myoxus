// SPDX-License-Identifier: AGPL-3.0-or-later
//! One private native creation stage; it is never offered as a Rule action.

use super::{runtime::*, *};
use myoxus_domain::workspace_automation::*;

pub const CAPABILITY: &str = "recurringTask";

/// Date-only Due is projected as the existing native all-day Cell format,
/// independently of the pinned-zone technical admission instant.
pub fn due_value(
  slot: myoxus_domain::scheduling::Occurrence,
  zone: myoxus_domain::scheduling::AdmissionZone,
) -> myoxus_domain::database::DatabaseDateTimeValue {
  use myoxus_domain::scheduling::ScheduleValue;
  let (start, all_day) = match slot.nominal {
    ScheduleValue::Date(date) => (date.and_time(chrono::NaiveTime::MIN).and_utc(), true),
    ScheduleValue::LocalDateTime(_) => (slot.due_at, false),
  };
  myoxus_domain::database::DatabaseDateTimeValue {
    start,
    end: None,
    all_day,
    time_zone: String::from(zone),
  }
}

pub fn definition() -> RuntimeResult<AcceptedAutomationDefinition> {
  definition_with_policy(crate::scheduling::admission::task_policy())
}

fn definition_with_policy(policy: AutomationExecutionPolicy) -> RuntimeResult<AcceptedAutomationDefinition> {
  // One constant internal stage, not an authorable Rule action. Task/slot data
  // lives only in accepted input, avoiding one permanently cached definition per Due.
  let mut definition = AcceptedAutomationDefinition {
    format_version: 1,
    runtime_schema_version: 1,
    policy,
    hash: String::new(),
    capability_versions: [(CAPABILITY.to_owned(), 1)].into(),
    actions: Vec::new(),
    workflow: None,
  };
  definition.hash = definition_hash(&definition)?;
  Ok(definition)
}

pub fn validate(run: &AcceptedAutomationRun) -> RuntimeResult<&AcceptedRecurringTask> {
  let task = run.recurring_task.as_ref().ok_or_else(unavailable)?;
  if run.automation_id.is_some()
    || run.trigger.is_some()
    || run.actor_id.is_none()
    || run.workspace_setup.is_some()
    || run.confirmed_request.is_some()
    || run.document_review.is_some()
    || run.task_handover.is_some()
    || run.task_maintenance.is_some()
    || run.personal_rule.is_some()
    || task.generation < 1
    || task.title.trim().is_empty()
    || task.occurrence_id
      != myoxus_domain::scheduling::task_occurrence_id(task.schedule_id, task.slot.nominal, task.cause_member_id)
    || run.definition.policy.max_actions_per_run != 1
    || definition_with_policy(run.definition.policy.clone())?.hash != run.definition.hash
  {
    return Err(unavailable());
  }
  Ok(task)
}

pub async fn execute(
  repo: &Arc<dyn WorkspaceAutomationRepository>,
  editing: &crate::database::DatabaseEditingService,
  invocation: AutomationEffectInvocation,
  run: &WorkspaceAutomationRun,
) -> WorkspaceAutomationResult<AutomationEffectResult> {
  let accepted = run.accepted.as_ref().ok_or_else(unavailable)?;
  let task = validate(accepted)?;
  if invocation.node_key != "action:0" || invocation.effect_key != "apply" {
    return Err(unavailable());
  }
  let receipt = repo
    .reserve_effect(
      run.id,
      &invocation.node_key,
      &invocation.effect_key,
      &invocation.input_fingerprint,
      invocation.claim,
      None,
    )
    .await?;
  if receipt.reserved_id != task.row_id {
    return Err(unavailable());
  }
  // A committed ACK wins even if its Task was subsequently deleted. Never
  // turn a missing acknowledged result into permission to create it again.
  if let Some(result) = receipt.result_json {
    return Ok(AutomationEffectResult {
      action_id: receipt.action_id,
      result,
    });
  }
  editing
    .create_automation_row(
      accepted.actor_id.ok_or_else(unavailable)?,
      task.database_id,
      run.workspace_id,
      task.row_id,
      task.title.clone(),
      task
        .cells
        .iter()
        .map(|cell| (cell.field_id, cell.value.clone()))
        .collect(),
      AutomationEffectFence {
        run_id: run.id,
        action_id: receipt.action_id,
        claim: invocation.claim,
      },
    )
    .await
    .map_err(|error| WorkspaceAutomationServiceError::new(error.code, error.message))?;
  let result = repo
    .get_effect(run.id, "action:0", "apply")
    .await?
    .and_then(|receipt| receipt.result_json)
    .ok_or_else(unavailable)?;
  Ok(AutomationEffectResult {
    action_id: receipt.action_id,
    result,
  })
}
