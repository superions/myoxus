// SPDX-License-Identifier: AGPL-3.0-or-later
//! Accepted prerequisite completion is native authority; Sayiir advances its waits.
use super::*;
use myoxus_domain::{assistant_package::*, database::*, permission::*, workspace_automation::*};
use std::collections::BTreeMap;

fn invalid() -> WorkspaceAutomationServiceError {
  WorkspaceAutomationServiceError::new(ERR_AUTOMATION_RUN_NOT_RETRYABLE, "Task handover unavailable")
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
      "Task handover native admission unavailable",
    )
  }
}
pub fn task_handover_digest(plan: &PreparedTaskHandover) -> WorkspaceAutomationResult<String> {
  Ok(format!(
    "{:x}",
    Sha256::digest(serde_json::to_vec(plan).map_err(|_| runtime::unavailable())?)
  ))
}
pub fn handover_wait_id(definition: &AcceptedAutomationDefinition, index: usize) -> WorkspaceAutomationResult<String> {
  let workflow = definition.workflow.as_ref().ok_or_else(invalid)?;
  let Some(AssistantWorkflowNode {
    action: AssistantWorkflowAction::AwaitTaskSet { wait_id, .. },
    ..
  }) = workflow.source.source.nodes.first()
  else {
    return Err(invalid());
  };
  if index >= *workflow.wait_counts.get(wait_id).ok_or_else(invalid)? as usize {
    return Err(invalid());
  }
  Ok(format!("{wait_id}:{index}"))
}
pub fn handover_effect_component(
  definition: &AcceptedAutomationDefinition,
  node_key: &str,
) -> WorkspaceAutomationResult<String> {
  if node_key != "action:1" {
    return Err(invalid());
  }
  let workflow = definition.workflow.as_ref().ok_or_else(invalid)?;
  match workflow.source.source.nodes.get(1).map(|node| &node.action) {
    Some(AssistantWorkflowAction::CreateTaskFromDocument { component }) => Ok(component.clone()),
    _ => Err(invalid()),
  }
}
pub fn compile_handover_definition(
  plan: &PreparedTaskHandover,
  policy: AutomationExecutionPolicy,
) -> WorkspaceAutomationResult<AcceptedAutomationDefinition> {
  let source = &plan.workflow;
  if plan.prerequisites.is_empty()
    || plan.prerequisites.len() + source.source.nodes.len().saturating_sub(1) > 64
    || policy.max_actions_per_run < 1
    || policy.max_retry_attempts == 0
    || source.binding_version != 1
    || source.source.format_version != 1
    || source.source.id != source.identity.id
    || source.source.version != source.identity.version
    || format!("{:x}", Sha256::digest(&source.source_bytes)) != source.identity.digest
    || source.source.nodes.len() != 2
    || source.source.capability_versions
      != [
        (AssistantWorkflowCapability::AwaitTaskSet, 1),
        (AssistantWorkflowCapability::CreateTaskFromDocument, 1),
      ]
      .into()
  {
    return Err(invalid());
  }
  let AssistantWorkflowAction::AwaitTaskSet {
    wait_id,
    tasks,
    deadline,
  } = &source.source.nodes[0].action
  else {
    return Err(invalid());
  };
  let AssistantValueBinding::Input { input } = tasks else {
    return Err(invalid());
  };
  if !matches!(plan.answers.get(input),Some(AssistantValue::TaskReferences(values)) if values==&plan.prerequisites)
    || !matches!(deadline,AssistantValueBinding::Input{input} if matches!(plan.answers.get(input),Some(AssistantValue::DateTime(value)) if value.start==plan.deadline_at && value.end.is_none() && !value.all_day && value.time_zone==plan.deadline_time_zone))
  {
    return Err(invalid());
  }
  let primary = plan
    .components
    .iter()
    .filter_map(|component| match &component.action {
      AssistantNativeAction::TaskHandover { inputs } => Some(inputs),
      _ => None,
    })
    .collect::<Vec<_>>();
  if primary.len() != 1 || plan.components.len() != 2 {
    return Err(invalid());
  }
  let AssistantWorkflowAction::CreateTaskFromDocument { component } = &source.source.nodes[1].action else {
    return Err(invalid());
  };
  let Some(AssistantComponent {
    action: AssistantNativeAction::CreateTaskFromDocument { inputs },
    ..
  }) = plan.components.iter().find(|child| child.id == *component)
  else {
    return Err(invalid());
  };
  for target in [
    AssistantInputTarget::SourceDocument,
    AssistantInputTarget::Assignees,
    AssistantInputTarget::Destination,
    AssistantInputTarget::Title,
  ] {
    if inputs.get(&target).is_none()
      || serde_json::to_value(inputs.get(&target)).map_err(|_| invalid())?
        != serde_json::to_value(primary[0].get(&target)).map_err(|_| invalid())?
    {
      return Err(invalid());
    }
  }
  if inputs.len() != 4 {
    return Err(invalid());
  }
  let mut definition = AcceptedAutomationDefinition {
    format_version: 1,
    runtime_schema_version: 1,
    hash: String::new(),
    policy,
    capability_versions: [("awaitTaskSet".into(), 1), ("createTaskFromDocument".into(), 1)].into(),
    actions: Vec::new(),
    workflow: Some(AcceptedNativeWorkflow {
      source: source.clone(),
      stages: Vec::new(),
      components: plan.components.clone(),
      wait_counts: [(wait_id.clone(), plan.prerequisites.len() as u32)].into(),
    }),
  };
  definition.hash = runtime::definition_hash(&definition)?;
  Ok(definition)
}
impl WorkspaceAutomationService {
  #[instrument(skip_all)]
  pub async fn prepare_task_handover(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: u32,
  ) -> WorkspaceAutomationResult<PreparedTaskHandover> {
    let native = self.context_documents.as_ref().ok_or_else(runtime::unavailable)?;
    let mut plan = native
      .packages
      .prepare_task_handover(
        actor,
        workspace,
        target,
        identity,
        answers,
        locale,
        client_version,
        &self.doc_service,
        &self.permission,
      )
      .await
      .map_err(database_error)?;
    plan.execution_available &= self.limits.enabled && self.runtime.is_some();
    compile_handover_definition(&plan, self.handover_policy()?)?;
    Ok(plan)
  }
  fn handover_policy(&self) -> WorkspaceAutomationResult<AutomationExecutionPolicy> {
    Ok(AutomationExecutionPolicy {
      max_actions_per_run: u32::try_from(self.limits.max_actions_per_run).map_err(|_| invalid())?,
      max_retry_attempts: u32::try_from(self.limits.max_retry_attempts.max(1)).map_err(|_| invalid())?,
      webhook_timeout_seconds: self.limits.webhook_timeout_seconds,
    })
  }
  #[instrument(skip_all)]
  pub async fn start_task_handover(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    input: TaskHandoverStartInput,
  ) -> WorkspaceAutomationResult<TaskHandoverView> {
    let fingerprint = format!(
      "{:x}",
      Sha256::digest(
        serde_json::to_vec(&(
          actor,
          workspace,
          &target,
          &input.package,
          &input.answers,
          &input.locale,
          input.client_version
        ))
        .map_err(|_| invalid())?
      )
    );
    let run = if let Some(run) = self
      .repo
      .get_task_handover_request(actor, workspace, input.request_id)
      .await?
    {
      if run
        .accepted
        .as_ref()
        .and_then(|run| run.task_handover.as_ref())
        .is_none_or(|facts| facts.fingerprint != fingerprint)
      {
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_IDEMPOTENCY_CONFLICT,
          "Task handover request input changed",
        ));
      }
      run
    } else {
      let plan = self
        .prepare_task_handover(
          actor,
          workspace,
          target,
          &input.package,
          input.answers,
          &input.locale,
          input.client_version,
        )
        .await?;
      if !plan.execution_available || task_handover_digest(&plan)? != input.plan_digest {
        return Err(invalid());
      }
      let definition = compile_handover_definition(&plan, self.handover_policy()?)?;
      self
        .repo
        .accept_task_handover(AcceptedAutomationRun {
          recurring_task: None,
          workspace_setup: None,
          run_id: Uuid::new_v4(),
          automation_id: None,
          workspace_id: workspace,
          actor_id: Some(actor),
          trigger: None,
          confirmed_request: None,
          document_review: None,
          task_maintenance: None,
          personal_rule: None,
          task_handover: Some(AcceptedTaskHandover {
            request_id: input.request_id,
            fingerprint,
            plan,
            result_task_id: Uuid::new_v4(),
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
        .ensure_started(run.accepted.clone().ok_or_else(runtime::unavailable)?)
        .await?;
    }
    self.handover_view(actor, run).await
  }
  #[instrument(skip_all)]
  pub async fn get_task_handover(
    &self,
    actor: UserId,
    run: Uuid,
  ) -> WorkspaceAutomationResult<Option<TaskHandoverView>> {
    match self.repo.get_run(run).await? {
      Some(run) => Ok(Some(self.handover_view(actor, run).await?)),
      None => Ok(None),
    }
  }
  #[instrument(skip_all)]
  pub async fn get_task_handover_request(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
  ) -> WorkspaceAutomationResult<Option<TaskHandoverView>> {
    match self.repo.get_task_handover_request(actor, workspace, request).await? {
      Some(run) => Ok(Some(self.handover_view(actor, run).await?)),
      None => Ok(None),
    }
  }
  #[instrument(skip_all)]
  pub async fn retry_task_handover(&self, actor: UserId, run: Uuid) -> WorkspaceAutomationResult<TaskHandoverView> {
    self.retry_run(actor, run).await?;
    self.get_task_handover(actor, run).await?.ok_or_else(invalid)
  }
  #[instrument(skip_all)]
  pub async fn stop_task_handover(&self, actor: UserId, run: Uuid) -> WorkspaceAutomationResult<TaskHandoverView> {
    self.stop_run(actor, run).await?;
    self.get_task_handover(actor, run).await?.ok_or_else(invalid)
  }
  pub(crate) async fn authorize_task_handover_retry(
    &self,
    actor: UserId,
    run: &WorkspaceAutomationRun,
  ) -> WorkspaceAutomationResult<()> {
    if !self.handover_view(actor, run.clone()).await?.can_retry {
      return Err(invalid());
    }
    Ok(())
  }
  async fn handover_view(
    &self,
    actor: UserId,
    run: WorkspaceAutomationRun,
  ) -> WorkspaceAutomationResult<TaskHandoverView> {
    let accepted = run
      .accepted
      .as_ref()
      .and_then(|run| run.task_handover.as_ref())
      .ok_or_else(invalid)?;
    let plan = &accepted.plan;
    let role = self
      .permission
      .get_effective_workspace_role(actor, run.workspace_id)
      .await
      .map_err(|_| runtime::unavailable())?;
    if !role.is_some_and(|role| role.can(WorkspaceAction::Read)) {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_FORBIDDEN,
        "Task handover unavailable",
      ));
    }
    let manager = role.is_some_and(|role| role >= myoxus_domain::entities::WorkspaceRole::Manager);
    if actor != plan.actor_id && !manager {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_FORBIDDEN,
        "Task handover unavailable",
      ));
    }
    let state = self.repo.task_handover_state(run.id).await?;
    state.validate(plan).map_err(|_| runtime::unavailable())?;
    let mut prerequisites = Vec::new();
    let mut all_available = true;
    for reference in &plan.prerequisites {
      let database = self.database_schema_repo.get_database(reference.database_id).await?;
      let row = self.database_row_repo.get_row(reference.row_id).await?;
      let available = database.as_ref().is_some_and(|database| {
        database.database.workspace_id == run.workspace_id
          && database.database.deleted_at.is_none()
          && database
            .managed_schema
            .as_ref()
            .is_some_and(|schema| schema.readiness == DatabaseManagedSchemaReadiness::Ready)
      }) && row.as_ref().is_some_and(|row| {
        row.row.database_id == reference.database_id
          && row.row.row_kind == DatabaseRowKind::Task
          && row.row.deleted_at.is_none()
      });
      all_available &= available;
      let complete = available
        && task_complete(
          database.as_ref().ok_or_else(invalid)?,
          row.as_ref().ok_or_else(invalid)?,
        );
      prerequisites.push(TaskHandoverPrerequisiteView {
        reference: reference.clone(),
        available,
        title: if available {
          row.as_ref().map(|row| row.row.title.clone())
        } else {
          None
        },
        complete,
      });
    }
    let doc = self
      .doc_service
      .get_doc_metadata(plan.source_document_id)
      .await
      .map_err(|_| runtime::unavailable())?;
    let source_available = doc.is_some_and(|doc| {
      doc.workspace_id == Some(run.workspace_id)
        && doc.external_id == plan.source_external_id
        && doc.deleted_at.is_none()
        && !doc.blocked
    }) && self
      .permission
      .get_effective_doc_role(actor, run.workspace_id, plan.source_document_id)
      .await
      .map_err(|_| runtime::unavailable())?
      .can(DocAction::Read);
    let destination = self
      .database_schema_repo
      .get_database(plan.destination_database_id)
      .await?;
    let destination_available = destination.is_some_and(|record| {
      record.database.workspace_id == run.workspace_id
        && record.database.deleted_at.is_none()
        && record
          .managed_schema
          .as_ref()
          .is_some_and(|schema| schema.readiness == DatabaseManagedSchemaReadiness::Ready)
    });
    let initiator_role = self
      .permission
      .get_effective_workspace_role(plan.actor_id, run.workspace_id)
      .await
      .map_err(|_| runtime::unavailable())?;
    let initiator_doc_role = self
      .permission
      .get_effective_doc_role(plan.actor_id, run.workspace_id, plan.source_document_id)
      .await
      .map_err(|_| runtime::unavailable())?;
    let initiator_can_write = initiator_role.is_some_and(|role| role.can(WorkspaceAction::CreateDoc))
      && initiator_doc_role.can(DocAction::Copy);
    let can_control = match self.authorize_run_control(actor, &run).await {
      Ok(()) => true,
      Err(error) if error.code == ERR_AUTOMATION_FORBIDDEN => false,
      Err(error) => return Err(error),
    };
    let responsible_available = self
      .context_documents
      .as_ref()
      .ok_or_else(runtime::unavailable)?
      .store
      .has_accepted_member(run.workspace_id, plan.responsible_id)
      .await
      .map_err(|_| runtime::unavailable())?;
    let result_acknowledged = self
      .repo
      .get_effect(run.id, "action:1", "apply")
      .await?
      .is_some_and(|effect| effect.result_json.is_some());
    let row = self.database_row_repo.get_row(accepted.result_task_id).await?;
    let result_task = if let Some(row) =
      row.filter(|row| result_acknowledged && row.row.row_kind == DatabaseRowKind::Task && row.row.deleted_at.is_none())
    {
      self
        .database_schema_repo
        .get_database(row.row.database_id)
        .await?
        .filter(|database| {
          database.database.workspace_id == run.workspace_id
            && database.database.deleted_at.is_none()
            && database
              .managed_schema
              .as_ref()
              .is_some_and(|schema| schema.readiness == DatabaseManagedSchemaReadiness::Ready)
        })
        .map(|_| AssistantTaskReference {
          database_id: row.row.database_id,
          row_id: row.row.id,
        })
    } else {
      None
    };
    let result_available = result_task.is_some();
    let can_retry = self.limits.enabled
      && can_control
      && initiator_can_write
      && responsible_available
      && (result_acknowledged || destination_available)
      && (!result_acknowledged || result_available)
      && prerequisites
        .iter()
        .all(|task| !state.completions.contains_key(&task.reference.row_id) || task.complete)
      && workflows::confirmed_run_retryable(&run)
      && state.invalid_reason.is_none()
      && state.expired_at.is_none()
      && source_available
      && all_available
      && (state.completions.len() == plan.prerequisites.len() || Utc::now() < plan.deadline_at);
    Ok(TaskHandoverView {
      run: run.clone(),
      accepted: plan.clone(),
      accepted_descriptor: self
        .context_documents
        .as_ref()
        .and_then(|native| native.packages.document_review_descriptor(&plan.package)),
      result_task_id: accepted.result_task_id,
      result_available,
      result_task,
      source_available,
      prerequisites,
      can_retry,
      can_stop: can_control
        && matches!(
          run.status,
          WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
        ),
      reason_code: state
        .invalid_reason
        .or_else(|| state.expired_at.map(|_| "TASK_HANDOVER_EXPIRED".into()))
        .or_else(|| (!all_available).then(|| "TASK_HANDOVER_PREREQUISITE_UNAVAILABLE".into()))
        .or_else(|| (!source_available).then(|| "TASK_HANDOVER_SOURCE_UNAVAILABLE".into()))
        .or_else(|| (!initiator_can_write).then(|| "TASK_HANDOVER_AUTHORITY_UNAVAILABLE".into()))
        .or_else(|| (!destination_available && !result_acknowledged).then(|| "TASK_HANDOVER_TARGET_UNAVAILABLE".into()))
        .or_else(|| {
          (!responsible_available && !result_acknowledged).then(|| "TASK_HANDOVER_RESPONSIBLE_UNAVAILABLE".into())
        })
        .or_else(|| (result_acknowledged && !result_available).then(|| "TASK_HANDOVER_RESULT_UNAVAILABLE".into()))
        .or(run.error_code.clone()),
    })
  }
}
fn task_complete(database: &DatabaseRecord, row: &DatabaseRowRecord) -> bool {
  let Some(field) = database
    .field_roles
    .iter()
    .find(|role| role.role_key == "task.status")
    .and_then(|role| database.fields.iter().find(|field| field.id == role.field_id))
  else {
    return false;
  };
  let DatabaseFieldConfig::Status(config) = &field.config else {
    return false;
  };
  row.cells.iter().any(|cell|cell.field_id==field.id && matches!(&cell.value,DatabaseCellValueData::Status(id) if config.options.iter().any(|option|option.id==*id&&option.group==DatabaseStatusGroup::Complete)))
}

pub(crate) async fn execute_handover_task(
  repo: &Arc<dyn WorkspaceAutomationRepository>,
  editing: &crate::database::DatabaseEditingService,
  schema: &Arc<dyn DatabaseDefinitionRepository>,
  invocation: runtime::AutomationEffectInvocation,
  run: &WorkspaceAutomationRun,
) -> WorkspaceAutomationResult<runtime::AutomationEffectResult> {
  let accepted = run.accepted.as_ref().ok_or_else(invalid)?;
  let handover = accepted.task_handover.as_ref().ok_or_else(invalid)?;
  let component = handover_effect_component(&accepted.definition, &invocation.node_key)?;
  if let Some(effect) = repo
    .get_effect(run.id, &invocation.node_key, &invocation.effect_key)
    .await?
  {
    if effect.input_fingerprint != invocation.input_fingerprint {
      return Err(invalid());
    }
    if let Some(result) = effect.result_json {
      let copy = editing
        .task_capture_receipt(handover.plan.actor_id, run.workspace_id, effect.action_id)
        .await
        .map_err(database_error)?
        .ok_or_else(invalid)?;
      if copy.record.is_none() || copy.target_trashed {
        return Err(invalid());
      }
      return Ok(runtime::AutomationEffectResult {
        action_id: effect.action_id,
        result,
      });
    }
  }
  let record = schema
    .get_database(handover.plan.destination_database_id)
    .await?
    .filter(|record| {
      record.database.workspace_id == run.workspace_id
        && record.database.deleted_at.is_none()
        && record
          .managed_schema
          .as_ref()
          .is_some_and(|schema| schema.readiness == DatabaseManagedSchemaReadiness::Ready)
    })
    .ok_or_else(invalid)?;
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
  let Some(AssistantComponent {
    action: AssistantNativeAction::CreateTaskFromDocument { inputs },
    ..
  }) = handover.plan.components.iter().find(|child| child.id == component)
  else {
    return Err(invalid());
  };
  let mut title = None;
  let mut cells = Vec::new();
  for (target, binding) in inputs {
    let AssistantValueBinding::Input { input } = binding else {
      return Err(invalid());
    };
    match (target, handover.plan.answers.get(input)) {
      (AssistantInputTarget::Title, Some(AssistantValue::Text(value))) => title = Some(value.clone()),
      (AssistantInputTarget::SourceDocument, Some(AssistantValue::Document(id)))
        if *id == handover.plan.source_document_id => {}
      (AssistantInputTarget::Destination, Some(AssistantValue::DatabaseDestination(id)))
        if *id == handover.plan.destination_database_id => {}
      (AssistantInputTarget::Assignees, Some(AssistantValue::Members(ids)))
        if ids == &vec![handover.plan.responsible_id] =>
      {
        let field = record
          .field_roles
          .iter()
          .find(|role| role.role_key == "task.assignees")
          .ok_or_else(invalid)?
          .field_id;
        cells.push((field, DatabaseCellValueData::Users(ids.clone())));
      }
      _ => return Err(invalid()),
    }
  }
  editing
    .create_task_from_source_with_effect(
      handover.plan.actor_id,
      crate::database::DatabaseTaskCaptureInput {
        workspace_id: run.workspace_id,
        database_id: handover.plan.destination_database_id,
        request_id: effect.action_id,
        source_document_id: handover.plan.source_document_id,
        source_external_id: handover.plan.source_external_id.clone(),
        block_id: None,
        selection_anchor: None,
        title: title.ok_or_else(invalid)?,
        cells,
      },
      effect.reserved_id,
      AutomationEffectFence {
        run_id: run.id,
        action_id: effect.action_id,
        claim: invocation.claim,
      },
    )
    .await
    .map_err(database_error)?;
  let effect = repo
    .get_effect(run.id, &invocation.node_key, &invocation.effect_key)
    .await?
    .ok_or_else(runtime::unavailable)?;
  Ok(runtime::AutomationEffectResult {
    action_id: effect.action_id,
    result: effect.result_json.ok_or_else(runtime::unavailable)?,
  })
}
