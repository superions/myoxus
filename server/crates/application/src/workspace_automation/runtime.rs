// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native workflow admission and execution boundaries; engine types stay in Infrastructure.
use super::{ERR_AUTOMATION_RUN_FAILED, WorkspaceAutomationResult, WorkspaceAutomationServiceError};
use async_trait::async_trait;
use myoxus_domain::{ids::WorkspaceAutomationRunId, workspace_automation::*};
use serde::{Deserialize, Serialize};

pub use myoxus_domain::workspace_automation::{
  AcceptedAutomationDefinition, AcceptedAutomationRun, AutomationExecutionClaim,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationEffectInvocation {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub setup: Option<WorkspaceSetupWorkflowEnvelope>,
  pub run_id: WorkspaceAutomationRunId,
  pub node_key: String,
  pub effect_key: String,
  pub input_fingerprint: String,
  pub claim: AutomationExecutionClaim,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub context: Option<ContextWorkflowEnvelope>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub signal: Option<WorkflowSignalEnvelope>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationEffectResult {
  pub action_id: uuid::Uuid,
  pub result: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationRuntimeStatus {
  pub run_id: WorkspaceAutomationRunId,
  pub status: WorkspaceAutomationRunStatus,
  pub reason_code: Option<String>,
}
pub type RuntimeResult<T> = Result<T, WorkspaceAutomationServiceError>;

#[async_trait]
pub trait WorkspaceAutomationRuntime: Send + Sync {
  async fn signal(&self, signal: WorkflowSignalEnvelope) -> RuntimeResult<WorkflowSignalDelivery>;
  async fn wait_status(&self, key: WorkflowWaitKey) -> RuntimeResult<WorkflowWaitStatus>;

  async fn register_definition(&self, definition: AcceptedAutomationDefinition) -> RuntimeResult<()>;
  /// Idempotent admission of the already persisted native identity. Redis is
  /// only a wake-up; accepted queued runs must also recover after restart.
  async fn ensure_started(&self, run: AcceptedAutomationRun) -> RuntimeResult<()>;
  async fn status(&self, run_id: WorkspaceAutomationRunId) -> RuntimeResult<AutomationRuntimeStatus>;
  async fn retry(&self, run_id: WorkspaceAutomationRunId) -> RuntimeResult<()>;
  async fn cancel(&self, run_id: WorkspaceAutomationRunId) -> RuntimeResult<()>;
}
#[async_trait]
pub trait WorkspaceAutomationNativeExecutor: Send + Sync {
  /// Persist only a genuine runtime status transition; native audit follows
  /// the successful compare-and-set, never an engine polling observation.
  async fn synchronize_status(&self, status: AutomationRuntimeStatus) -> RuntimeResult<()>;
  async fn execute(&self, invocation: AutomationEffectInvocation) -> WorkspaceAutomationResult<AutomationEffectResult>;
}
pub fn unavailable() -> WorkspaceAutomationServiceError {
  WorkspaceAutomationServiceError::new(ERR_AUTOMATION_RUN_FAILED, "workflow runtime unavailable")
}

/// Hash the native action configuration, not only engine node names. Bodies and
/// credentials must never be included in spans or public runtime projections.
pub fn freeze_definition(
  mut actions: Vec<WorkspaceAutomationActionDefinition>,
  policy: AutomationExecutionPolicy,
) -> RuntimeResult<AcceptedAutomationDefinition> {
  use sha2::{Digest, Sha256};
  if actions.is_empty()
    || actions.len() > policy.max_actions_per_run as usize
    || policy.max_retry_attempts == 0
    || policy.webhook_timeout_seconds == 0
    || actions.iter().enumerate().any(|(i, a)| a.position != i as i32)
  {
    return Err(WorkspaceAutomationServiceError::new(
      super::ERR_AUTOMATION_ACTION_INVALID,
      "invalid ordered native action list",
    ));
  }
  // Existing rule storage owns signing material. The runtime receives only its
  // digest and fails closed if that source is later changed or removed.
  for action in &mut actions {
    if let WorkspaceAutomationActionConfig::NotifyWebhook {
      secret_ref: Some(secret),
      ..
    } = &mut action.config
    {
      *secret = format!("sha256:{:x}", Sha256::digest(secret.as_bytes()));
    }
  }
  let capability_versions = actions
    .iter()
    .map(|a| (a.config.action_type().as_str().to_string(), 1))
    .collect::<std::collections::BTreeMap<_, _>>();
  let mut definition = AcceptedAutomationDefinition {
    format_version: 1,
    runtime_schema_version: 1,
    policy,
    hash: String::new(),
    capability_versions,
    actions,
    workflow: None,
  };
  definition.hash = definition_hash(&definition)?;
  Ok(definition)
}
/// Rule definitions keep their original tuple hash. The optional workflow
/// branch has a distinct identity and never rewrites accepted Rule envelopes.
pub fn definition_hash(definition: &AcceptedAutomationDefinition) -> RuntimeResult<String> {
  use sha2::{Digest, Sha256};
  if let Some(workflow) = &definition.workflow {
    if !definition.actions.is_empty() {
      return Ok(format!(
        "{:x}",
        Sha256::digest(
          serde_json::to_vec(&(
            "source-backed-personal-rule",
            definition.format_version,
            definition.runtime_schema_version,
            &definition.policy,
            &definition.capability_versions,
            workflow,
            &definition.actions
          ))
          .map_err(|_| unavailable())?
        )
      ));
    }
    return Ok(format!(
      "{:x}",
      Sha256::digest(
        serde_json::to_vec(&(
          "confirmed-context-documents",
          definition.format_version,
          definition.runtime_schema_version,
          &definition.policy,
          &definition.capability_versions,
          workflow,
        ))
        .map_err(|_| unavailable())?
      )
    ));
  }

  Ok(format!(
    "{:x}",
    Sha256::digest(
      serde_json::to_vec(&(
        definition.format_version,
        definition.runtime_schema_version,
        &definition.policy,
        &definition.capability_versions,
        &definition.actions
      ))
      .map_err(|_| unavailable())?
    )
  ))
}
pub fn effect_input_fingerprint(
  run: &AcceptedAutomationRun,
  node_key: &str,
  effect_key: &str,
) -> RuntimeResult<String> {
  use sha2::{Digest, Sha256};
  if effect_key != "apply" {
    return Err(unavailable());
  }
  let position = node_key
    .strip_prefix("action:")
    .and_then(|value| value.parse::<i32>().ok())
    .ok_or_else(unavailable)?;
  if node_key != format!("action:{position}") || position < 0 {
    return Err(unavailable());
  }
  let exists = match &run.definition.workflow {
    Some(workflow) if run.workspace_setup.is_some() => {
      super::setup::workspace_setup_stage_count(&run.definition).is_ok()
        && workflow.stages.get(position as usize).is_some()
    }
    Some(workflow) if !workflow.components.is_empty() => {
      if run.task_maintenance.is_some() {
        super::maintenance::maintenance_effect_kind(&run.definition, node_key).is_ok()
      } else if run.personal_rule.is_some() && !run.definition.actions.is_empty() {
        run.definition.actions.iter().any(|action| action.position == position)
      } else if run.task_handover.is_some() {
        super::handover::handover_effect_component(&run.definition, node_key).is_ok()
      } else {
        super::review::review_effect_component(&run.definition, node_key).is_ok()
      }
    }
    Some(workflow) => workflow.stages.get(position as usize).is_some(),
    None => run.definition.actions.iter().any(|action| action.position == position),
  };
  if !exists {
    return Err(unavailable());
  }
  Ok(format!(
    "{:x}",
    Sha256::digest(serde_json::to_vec(&(run, node_key, effect_key)).map_err(|_| unavailable())?)
  ))
}
