// SPDX-License-Identifier: AGPL-3.0-or-later
//! Frozen native proposals use the shared workflow and signal boundary.
use super::*;
use myoxus_domain::{assistant_package::*, permission::*, workspace_automation::*};
use std::collections::BTreeMap;

fn invalid() -> WorkspaceAutomationServiceError {
  WorkspaceAutomationServiceError::new(ERR_AUTOMATION_RUN_NOT_RETRYABLE, "Task correction proposal unavailable")
}
fn database_error(error: crate::database::DatabaseServiceError) -> WorkspaceAutomationServiceError {
  if error.is_retryable_storage_failure() {
    runtime::unavailable()
  } else {
    WorkspaceAutomationServiceError::new(
      if error.code == crate::database::ERR_FORBIDDEN {
        ERR_AUTOMATION_FORBIDDEN
      } else {
        ERR_AUTOMATION_RUN_NOT_RETRYABLE
      },
      "Task correction native admission unavailable",
    )
  }
}
pub fn task_maintenance_digest(plan: &PreparedTaskMaintenance) -> WorkspaceAutomationResult<String> {
  Ok(format!(
    "{:x}",
    Sha256::digest(serde_json::to_vec(plan).map_err(|_| invalid())?)
  ))
}
pub fn compile_maintenance_definition(
  plan: &PreparedTaskMaintenance,
  policy: AutomationExecutionPolicy,
) -> WorkspaceAutomationResult<AcceptedAutomationDefinition> {
  let source = &plan.workflow;
  if source.binding_version != 1
    || source.source.format_version != 1
    || source.source.id != source.identity.id
    || source.source.version != source.identity.version
    || format!("{:x}", Sha256::digest(&source.source_bytes)) != source.identity.digest
    || policy.max_actions_per_run < 2
    || source.source.nodes.len() != 3
    || source.source.capability_versions
      != [
        (AssistantWorkflowCapability::InspectTaskContent, 1),
        (AssistantWorkflowCapability::AwaitCorrectionConfirmation, 1),
        (AssistantWorkflowCapability::Branch, 1),
        (AssistantWorkflowCapability::ApplyTaskCorrections, 1),
      ]
      .into()
  {
    return Err(invalid());
  }
  let AssistantWorkflowAction::InspectTaskContent { component: inspect } = &source.source.nodes[0].action else {
    return Err(invalid());
  };
  let AssistantWorkflowAction::AwaitCorrectionConfirmation { wait_id } = &source.source.nodes[1].action else {
    return Err(invalid());
  };
  let AssistantWorkflowAction::Branch { outcome, cases } = &source.source.nodes[2].action else {
    return Err(invalid());
  };
  if wait_id.is_empty()
    || cases.len() != 2
    || !cases.get("decline").is_some_and(Vec::is_empty)
    || !matches!(outcome,AssistantValueBinding::Result{component,value:AssistantResultValue::Outcome} if component==&source.source.nodes[1].id)
  {
    return Err(invalid());
  }
  let apply = cases
    .get("apply")
    .filter(|nodes| nodes.len() == 1)
    .ok_or_else(invalid)?;
  let AssistantWorkflowAction::ApplyTaskCorrections { component: apply } = &apply[0].action else {
    return Err(invalid());
  };
  let child = |id: &str| {
    plan
      .components
      .iter()
      .find(|component| component.id == id)
      .map(|component| &component.action)
  };
  let Some(AssistantNativeAction::InspectTaskContent { tasks }) = child(inspect) else {
    return Err(invalid());
  };
  if !matches!(tasks,AssistantValueBinding::Input{input} if matches!(plan.answers.get(input),Some(AssistantValue::TaskReferences(tasks)) if tasks==&plan.proposal.tasks))
  {
    return Err(invalid());
  }
  if !matches!(child(apply),Some(AssistantNativeAction::ApplyTaskCorrections{proposal:AssistantValueBinding::Result{component,value:AssistantResultValue::CorrectionProposal}}) if component==inspect)
  {
    return Err(invalid());
  }
  let mut definition = AcceptedAutomationDefinition {
    format_version: 1,
    runtime_schema_version: 1,
    hash: String::new(),
    policy,
    capability_versions: [
      ("inspectTaskContent".into(), 1),
      ("awaitCorrectionConfirmation".into(), 1),
      ("branch".into(), 1),
      ("applyTaskCorrections".into(), 1),
    ]
    .into(),
    actions: Vec::new(),
    workflow: Some(AcceptedNativeWorkflow {
      source: source.clone(),
      stages: Vec::new(),
      components: plan.components.clone(),
      wait_counts: BTreeMap::new(),
    }),
  };
  definition.hash = runtime::definition_hash(&definition)?;
  Ok(definition)
}
impl WorkspaceAutomationService {
  #[instrument(skip_all)]
  pub async fn prepare_task_maintenance(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: u32,
  ) -> WorkspaceAutomationResult<PreparedTaskMaintenance> {
    let native = self.context_documents.as_ref().ok_or_else(runtime::unavailable)?;
    let mut plan = native
      .packages
      .prepare_task_maintenance(
        actor,
        workspace,
        target,
        identity,
        answers,
        locale,
        client_version,
        &self.editing,
      )
      .await
      .map_err(database_error)?;
    plan.execution_available &= self.limits.enabled && self.runtime.is_some() && !plan.proposal.patches.is_empty();
    compile_maintenance_definition(&plan, self.maintenance_policy()?)?;
    Ok(plan)
  }
  fn maintenance_policy(&self) -> WorkspaceAutomationResult<AutomationExecutionPolicy> {
    Ok(AutomationExecutionPolicy {
      max_actions_per_run: u32::try_from(self.limits.max_actions_per_run).map_err(|_| invalid())?,
      max_retry_attempts: u32::try_from(self.limits.max_retry_attempts.max(1)).map_err(|_| invalid())?,
      webhook_timeout_seconds: self.limits.webhook_timeout_seconds,
    })
  }
  #[instrument(skip_all)]
  pub async fn start_task_maintenance(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    input: TaskMaintenanceStartInput,
  ) -> WorkspaceAutomationResult<TaskMaintenanceView> {
    if input.request_id.is_nil() {
      return Err(invalid());
    }
    let fingerprint = format!(
      "{:x}",
      Sha256::digest(serde_json::to_vec(&(actor, workspace, &target, &input)).map_err(|_| invalid())?)
    );
    let run = if let Some(run) = self
      .repo
      .get_task_maintenance_request(actor, workspace, input.request_id)
      .await?
    {
      if !run
        .accepted
        .as_ref()
        .and_then(|accepted| accepted.task_maintenance.as_ref())
        .is_some_and(|accepted| accepted.fingerprint == fingerprint)
      {
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_IDEMPOTENCY_CONFLICT,
          "Correction request input changed",
        ));
      }
      run
    } else {
      let plan = self
        .prepare_task_maintenance(
          actor,
          workspace,
          target,
          &input.package,
          input.answers,
          &input.locale,
          input.client_version,
        )
        .await?;
      if !plan.execution_available || task_maintenance_digest(&plan)? != input.plan_digest {
        return Err(invalid());
      }
      let definition = compile_maintenance_definition(&plan, self.maintenance_policy()?)?;
      let AssistantWorkflowAction::AwaitCorrectionConfirmation { wait_id } = &plan.workflow.source.nodes[1].action
      else {
        return Err(invalid());
      };
      let wait_id = wait_id.clone();
      self
        .repo
        .accept_task_maintenance(AcceptedAutomationRun {
          workspace_setup: None,
          run_id: Uuid::new_v4(),
          automation_id: None,
          workspace_id: workspace,
          actor_id: Some(actor),
          trigger: None,
          confirmed_request: None,
          document_review: None,
          task_handover: None,
          personal_rule: None,
          task_maintenance: Some(AcceptedTaskMaintenance {
            request_id: input.request_id,
            fingerprint,
            plan,
            wait_id,
          }),
          definition,
        })
        .await?
    };
    if matches!(
      run.status,
      WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
    ) {
      self
        .runtime
        .as_ref()
        .ok_or_else(runtime::unavailable)?
        .ensure_started(run.accepted.clone().ok_or_else(invalid)?)
        .await?;
    }
    self.maintenance_view(actor, run).await
  }
  #[instrument(skip_all)]
  pub async fn get_task_maintenance(
    &self,
    actor: UserId,
    run: Uuid,
  ) -> WorkspaceAutomationResult<Option<TaskMaintenanceView>> {
    match self.repo.get_run(run).await? {
      Some(run) => Ok(Some(self.maintenance_view(actor, run).await?)),
      None => Ok(None),
    }
  }
  #[instrument(skip_all)]
  pub async fn get_task_maintenance_request(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
  ) -> WorkspaceAutomationResult<Option<TaskMaintenanceView>> {
    match self
      .repo
      .get_task_maintenance_request(actor, workspace, request)
      .await?
    {
      Some(run) => Ok(Some(self.maintenance_view(actor, run).await?)),
      None => Ok(None),
    }
  }
  #[instrument(skip_all)]
  pub async fn retry_task_maintenance(
    &self,
    actor: UserId,
    run: Uuid,
  ) -> WorkspaceAutomationResult<TaskMaintenanceView> {
    self.retry_run(actor, run).await?;
    self.get_task_maintenance(actor, run).await?.ok_or_else(invalid)
  }
  #[instrument(skip_all)]
  pub async fn stop_task_maintenance(
    &self,
    actor: UserId,
    run: Uuid,
  ) -> WorkspaceAutomationResult<TaskMaintenanceView> {
    self.stop_run(actor, run).await?;
    self.get_task_maintenance(actor, run).await?.ok_or_else(invalid)
  }
  async fn maintenance_view(
    &self,
    actor: UserId,
    run: WorkspaceAutomationRun,
  ) -> WorkspaceAutomationResult<TaskMaintenanceView> {
    let accepted = run
      .accepted
      .as_ref()
      .and_then(|run| run.task_maintenance.as_ref())
      .ok_or_else(invalid)?;
    let plan = &accepted.plan;
    let can_control = match self.authorize_run_control(actor, &run).await {
      Ok(()) => true,
      Err(error) if error.code == ERR_AUTOMATION_FORBIDDEN => false,
      Err(error) => return Err(error),
    };
    let role = self
      .permission
      .get_effective_workspace_role(actor, run.workspace_id)
      .await
      .map_err(|_| runtime::unavailable())?;
    if !role.is_some_and(|role| role.can(WorkspaceAction::Read)) || (!can_control && actor != plan.actor_id) {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_FORBIDDEN,
        "Correction request unavailable",
      ));
    }
    let confirmation = self.repo.task_correction_confirmation(run.id).await?;
    let (available, fresh) = match self
      .editing
      .inspect_task_content(
        plan.actor_id,
        plan.workspace_id,
        plan.target.database_id,
        &plan.proposal.tasks.iter().map(|task| task.row_id).collect::<Vec<_>>(),
      )
      .await
    {
      Ok(current) => (true, current.digest == plan.proposal.digest),
      Err(error) if error.is_retryable_storage_failure() => return Err(runtime::unavailable()),
      Err(_) => (false, false),
    };
    let personal_current = match self.authorize_personal_run(&run).await {
      Ok(()) => true,
      Err(error) if matches!(error.code, ERR_AUTOMATION_FORBIDDEN | ERR_AUTOMATION_RUN_NOT_RETRYABLE) => false,
      Err(error) => return Err(error),
    };
    let active = matches!(
      run.status,
      WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
    );
    let inspected = self
      .repo
      .get_effect(run.id, "action:0", "apply")
      .await?
      .is_some_and(|effect| effect.result_json.is_some());
    let can_decline = actor == plan.actor_id
      && active
      && inspected
      && confirmation.is_none()
      && can_control
      && available
      && personal_current;
    let can_apply = can_decline && fresh && !plan.proposal.patches.is_empty();
    let can_confirm = can_apply || can_decline;
    let can_retry = can_control && self.can_retry_context_run(actor, &run).await?;
    let accepted_descriptor = self
      .context_documents
      .as_ref()
      .and_then(|native| native.packages.document_review_descriptor(&plan.package));
    let reason_code = if run.status == WorkspaceAutomationRunStatus::Succeeded {
      None
    } else if let Some(code) = safe_error_projection(&run).0 {
      Some(code.into())
    } else if active && confirmation.is_none() && (!fresh || !personal_current) {
      Some(ERR_AUTOMATION_RUN_NOT_RETRYABLE.into())
    } else {
      None
    };
    Ok(TaskMaintenanceView {
      request_id: accepted.request_id,
      run: run.clone(),
      accepted: plan.clone(),
      accepted_descriptor,
      confirmation,
      wait_id: accepted.wait_id.clone(),
      can_confirm,
      can_apply,
      can_decline,
      can_retry,
      can_stop: can_control && active,
      reason_code,
    })
  }
}

pub fn maintenance_effect_kind(
  definition: &AcceptedAutomationDefinition,
  node_key: &str,
) -> WorkspaceAutomationResult<bool> {
  let workflow = definition.workflow.as_ref().ok_or_else(invalid)?;
  let index = node_key
    .strip_prefix("action:")
    .and_then(|index| index.parse::<usize>().ok())
    .filter(|index| node_key == format!("action:{index}"))
    .ok_or_else(invalid)?;
  let nodes = super::workflows::native_workflow_nodes(&workflow.source.source);
  match nodes.get(index).map(|node| &node.action) {
    Some(AssistantWorkflowAction::InspectTaskContent { .. }) => Ok(false),
    Some(AssistantWorkflowAction::ApplyTaskCorrections { .. }) => Ok(true),
    _ => Err(invalid()),
  }
}

pub(crate) async fn execute_maintenance_task(
  repo: &Arc<dyn WorkspaceAutomationRepository>,
  editing: &crate::database::DatabaseEditingService,
  invocation: runtime::AutomationEffectInvocation,
  run: &WorkspaceAutomationRun,
) -> WorkspaceAutomationResult<runtime::AutomationEffectResult> {
  let accepted = run.accepted.as_ref().ok_or_else(invalid)?;
  let maintenance = accepted.task_maintenance.as_ref().ok_or_else(invalid)?;
  let apply = maintenance_effect_kind(&accepted.definition, &invocation.node_key)?;
  let proposal = &maintenance.plan.proposal;
  // Native read authority is current even when the effect result is retained.
  editing
    .inspect_task_content(
      proposal.actor_id,
      proposal.workspace_id,
      proposal.database_id,
      &proposal.tasks.iter().map(|task| task.row_id).collect::<Vec<_>>(),
    )
    .await
    .map_err(database_error)?;
  let effect = repo
    .reserve_effect(
      run.id,
      &invocation.node_key,
      &invocation.effect_key,
      &invocation.input_fingerprint,
      invocation.claim,
      None,
    )
    .await?;
  if effect.input_fingerprint != invocation.input_fingerprint {
    return Err(invalid());
  }
  if let Some(result) = effect.result_json {
    return Ok(runtime::AutomationEffectResult {
      action_id: effect.action_id,
      result,
    });
  }
  let fence = AutomationEffectFence {
    run_id: run.id,
    action_id: effect.action_id,
    claim: invocation.claim,
  };
  let result = if apply {
    editing
      .apply_task_corrections(proposal.actor_id, proposal, fence)
      .await
      .map_err(database_error)?;
    serde_json::json!({"proposalDigest":proposal.digest,"applied":true})
  } else {
    repo.commit_task_inspection(fence).await?
  };
  Ok(runtime::AutomationEffectResult {
    action_id: effect.action_id,
    result,
  })
}
impl WorkspaceAutomationService {
  pub(crate) async fn authorize_task_maintenance_retry(
    &self,
    actor: UserId,
    run: &WorkspaceAutomationRun,
  ) -> WorkspaceAutomationResult<()> {
    if !super::workflows::confirmed_run_retryable(run) {
      return Err(invalid());
    }
    self.authorize_run_control(actor, run).await?;
    self.authorize_personal_run(run).await?;
    let accepted = run.accepted.as_ref().ok_or_else(invalid)?;
    let maintenance = accepted.task_maintenance.as_ref().ok_or_else(invalid)?;
    let confirmation = self.repo.task_correction_confirmation(run.id).await?;
    if confirmation
      .as_ref()
      .is_some_and(|receipt| receipt.outcome == TaskCorrectionOutcome::Decline)
    {
      return Ok(());
    }
    let nodes = super::workflows::native_workflow_nodes(&maintenance.plan.workflow.source);
    let apply_key = nodes
      .iter()
      .position(|node| matches!(node.action, AssistantWorkflowAction::ApplyTaskCorrections { .. }))
      .ok_or_else(invalid)?;
    let committed = self
      .repo
      .get_effect(run.id, &format!("action:{apply_key}"), "apply")
      .await?
      .is_some_and(|effect| effect.result_json.is_some());
    let proposal = &maintenance.plan.proposal;
    let current = self
      .editing
      .inspect_task_content(
        proposal.actor_id,
        proposal.workspace_id,
        proposal.database_id,
        &proposal.tasks.iter().map(|task| task.row_id).collect::<Vec<_>>(),
      )
      .await
      .map_err(database_error)?;
    if !committed && current.digest != proposal.digest {
      return Err(invalid());
    }
    Ok(())
  }
}
