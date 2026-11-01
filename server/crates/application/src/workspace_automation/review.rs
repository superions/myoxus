// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native document-review commands. Runtime continuation never grants review
//! authority or interprets document revisions, assignments, or decision reasons.
use super::*;
use myoxus_domain::{assistant_package::*, database::*, permission::*, workspace_automation::*};
use std::collections::BTreeMap;

pub fn document_review_digest(plan: &PreparedDocumentReview) -> WorkspaceAutomationResult<String> {
  Ok(format!(
    "{:x}",
    Sha256::digest(serde_json::to_vec(plan).map_err(|_| runtime::unavailable())?)
  ))
}
fn invalid() -> WorkspaceAutomationServiceError {
  WorkspaceAutomationServiceError::new(ERR_AUTOMATION_ACTION_INVALID, "Document review input unavailable")
}
impl WorkspaceAutomationService {
  #[instrument(skip_all)]
  pub async fn prepare_document_review(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: u32,
  ) -> WorkspaceAutomationResult<PreparedDocumentReview> {
    let native = self.context_documents.as_ref().ok_or_else(runtime::unavailable)?;
    let mut plan = native
      .packages
      .prepare_document_review(
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
      .map_err(review_database_error)?;
    plan.execution_available &= self.limits.enabled && self.runtime.is_some();
    compile_review_definition(&plan, self.review_policy()?)?;
    Ok(plan)
  }
  fn review_policy(&self) -> WorkspaceAutomationResult<AutomationExecutionPolicy> {
    Ok(AutomationExecutionPolicy {
      max_actions_per_run: u32::try_from(self.limits.max_actions_per_run).map_err(|_| invalid())?,
      max_retry_attempts: u32::try_from(self.limits.max_retry_attempts.max(1)).map_err(|_| invalid())?,
      webhook_timeout_seconds: self.limits.webhook_timeout_seconds,
    })
  }
  #[instrument(skip_all)]
  pub async fn start_document_review(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    input: DocumentReviewStartInput,
  ) -> WorkspaceAutomationResult<DocumentReviewView> {
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
    // Receipt first: a retired package, lost reply, or deleted result cannot
    // reinterpret an accepted request or allocate another Task.
    let run = if let Some(run) = self
      .repo
      .get_document_review_request(actor, workspace, input.request_id)
      .await?
    {
      let accepted = run
        .accepted
        .as_ref()
        .and_then(|run| run.document_review.as_ref())
        .ok_or_else(runtime::unavailable)?;
      if accepted.fingerprint != fingerprint {
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_IDEMPOTENCY_CONFLICT,
          "Review request input changed",
        ));
      }
      run
    } else {
      let plan = self
        .prepare_document_review(
          actor,
          workspace,
          target,
          &input.package,
          input.answers,
          &input.locale,
          input.client_version,
        )
        .await?;
      if !plan.execution_available || document_review_digest(&plan)? != input.plan_digest {
        return Err(invalid());
      }
      let definition = compile_review_definition(&plan, self.review_policy()?)?;
      let wait_id = review_wait(&definition)?.0.to_string();
      let accepted = AcceptedAutomationRun {
        workspace_setup: None,
        run_id: Uuid::new_v4(),
        automation_id: None,
        workspace_id: workspace,
        actor_id: Some(actor),
        trigger: None,
        confirmed_request: None,
        document_review: Some(AcceptedDocumentReview {
          request_id: input.request_id,
          fingerprint,
          plan,
          review_task_id: Uuid::new_v4(),
          follow_up_task_id: Uuid::new_v4(),
          wait_id,
        }),
        task_handover: None,
        task_maintenance: None,
        personal_rule: None,
        definition,
      };
      self.repo.accept_document_review(accepted).await?
    };
    if matches!(
      run.status,
      WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
    ) {
      let accepted = run.accepted.clone().ok_or_else(runtime::unavailable)?;
      let runtime = self.runtime.as_ref().ok_or_else(runtime::unavailable)?;
      runtime.register_definition(accepted.definition.clone()).await?;
      runtime.ensure_started(accepted).await?;
    }
    self.review_view(actor, run).await
  }
  #[instrument(skip_all)]
  pub async fn get_document_review(
    &self,
    actor: UserId,
    run: Uuid,
  ) -> WorkspaceAutomationResult<Option<DocumentReviewView>> {
    match self.repo.get_run(run).await? {
      Some(run)
        if run
          .accepted
          .as_ref()
          .is_some_and(|accepted| accepted.document_review.is_some()) =>
      {
        Ok(Some(self.review_view(actor, run).await?))
      }
      _ => Ok(None),
    }
  }
  #[instrument(skip_all)]
  pub async fn get_document_review_request(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
  ) -> WorkspaceAutomationResult<Option<DocumentReviewView>> {
    match self.repo.get_document_review_request(actor, workspace, request).await? {
      Some(run) => Ok(Some(self.review_view(actor, run).await?)),
      None => Ok(None),
    }
  }
  #[instrument(skip_all)]
  pub async fn get_document_review_for_task(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    database: DatabaseId,
    row: Uuid,
  ) -> WorkspaceAutomationResult<Option<DocumentReviewView>> {
    match self.repo.get_document_review_for_task(workspace, database, row).await? {
      Some(run) => Ok(Some(self.review_view(actor, run).await?)),
      None => Ok(None),
    }
  }
  #[instrument(skip_all)]
  pub async fn decide_document_review(
    &self,
    actor: UserId,
    input: DocumentReviewDecisionInput,
  ) -> WorkspaceAutomationResult<DocumentReviewView> {
    let run = self.repo.get_run(input.run_id).await?.ok_or_else(invalid)?;
    let view = self.review_view(actor, run).await?;
    if let Some(receipt) = self.repo.document_review_decision(view.run.id).await? {
      if receipt.actor_id == actor
        && receipt.request_id == input.request_id
        && receipt.wait_id == input.wait_id
        && receipt.source_revision == input.expected_document_revision
        && receipt.expected_task_edit_revision == input.expected_task_edit_revision
        && receipt.expected_status_edit_revision == input.expected_status_edit_revision
        && serde_json::to_value(&receipt.decision).map_err(|_| invalid())?
          == serde_json::to_value(&input.decision).map_err(|_| invalid())?
      {
        return Ok(view);
      }
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_IDEMPOTENCY_CONFLICT,
        "Review decision input changed",
      ));
    }
    if !view.can_approve
      || view.wait_id != input.wait_id
      || input.expected_document_revision != view.accepted.source_revision
    {
      return Err(invalid());
    }
    if matches!(&input.decision,DocumentReviewDecision::RequestChanges{reason} if reason.trim().is_empty() || reason.len()>65536)
    {
      return Err(invalid());
    }
    self
      .editing
      .decide_document_review(actor, input, view.accepted.destination_database_id, view.review_task_id)
      .await
      .map_err(review_database_error)?;
    self
      .get_document_review(actor, view.run.id)
      .await?
      .ok_or_else(runtime::unavailable)
  }
  #[instrument(skip_all)]
  pub async fn deliver_workflow_signal(&self, signal: WorkflowSignalEnvelope) -> WorkspaceAutomationResult<()> {
    self.repo.validate_workflow_signal(&signal).await?;
    self
      .runtime
      .as_ref()
      .ok_or_else(runtime::unavailable)?
      .signal(signal)
      .await?;
    Ok(())
  }
  pub(crate) async fn authorize_document_review_retry(
    &self,
    actor: UserId,
    run: &WorkspaceAutomationRun,
  ) -> WorkspaceAutomationResult<()> {
    let view = self.review_view(actor, run.clone()).await?;
    if !view.can_retry {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_RUN_NOT_RETRYABLE,
        "Review requires a fresh explicit request",
      ));
    }
    Ok(())
  }
  async fn review_view(
    &self,
    actor: UserId,
    run: WorkspaceAutomationRun,
  ) -> WorkspaceAutomationResult<DocumentReviewView> {
    let accepted = run
      .accepted
      .as_ref()
      .and_then(|run| run.document_review.as_ref())
      .ok_or_else(runtime::unavailable)?;
    let plan = &accepted.plan;
    let role = self
      .permission
      .get_effective_workspace_role(actor, run.workspace_id)
      .await
      .map_err(|_| runtime::unavailable())?;
    if !role.is_some_and(|role| role.can(WorkspaceAction::Read)) {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_FORBIDDEN,
        "Review unavailable",
      ));
    }
    let reviewer = actor == plan.reviewer_id;
    let manager = role.is_some_and(|role| role >= myoxus_domain::entities::WorkspaceRole::Manager);
    if actor != plan.actor_id && !reviewer && !manager {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_FORBIDDEN,
        "Review unavailable",
      ));
    }
    let native = self.context_documents.as_ref().ok_or_else(runtime::unavailable)?;
    let record = self
      .database_schema_repo
      .get_database(plan.destination_database_id)
      .await?;
    let task = self.database_row_repo.get_row(accepted.review_task_id).await?;
    let followup = self.database_row_repo.get_row(accepted.follow_up_task_id).await?;
    let ready = record.as_ref().is_some_and(|record| {
      record.database.workspace_id == run.workspace_id
        && record.database.deleted_at.is_none()
        && record
          .managed_schema
          .as_ref()
          .is_some_and(|managed| managed.readiness == DatabaseManagedSchemaReadiness::Ready)
    });
    let task = task.filter(|task| {
      ready
        && task.row.database_id == plan.destination_database_id
        && task.row.row_kind == DatabaseRowKind::Task
        && task.row.deleted_at.is_none()
    });
    let status_field = record.as_ref().and_then(|record| {
      record
        .field_roles
        .iter()
        .find(|role| role.role_key == "task.status")
        .map(|role| role.field_id)
    });
    let assignees = record.as_ref().and_then(|record| {
      record
        .field_roles
        .iter()
        .find(|role| role.role_key == "task.assignees")
        .map(|role| role.field_id)
    });
    let incomplete = task.as_ref().is_some_and(|task| {
      let status = task.cells.iter().find(|cell| Some(cell.field_id) == status_field);
      let config = record
        .as_ref()
        .and_then(|record| record.fields.iter().find(|field| Some(field.id) == status_field));
      match (status.map(|cell| &cell.value), config.map(|field| &field.config)) {
        (Some(DatabaseCellValueData::Status(id)), Some(DatabaseFieldConfig::Status(config))) => {
          config.options.iter().any(|option| {
            option.id == *id
              && !matches!(
                option.group,
                DatabaseStatusGroup::Complete | DatabaseStatusGroup::Archived
              )
          })
        }
        (None, Some(DatabaseFieldConfig::Status(_))) => true,
        _ => false,
      }
    });
    let assigned = task
      .as_ref()
      .and_then(|task| task.cells.iter().find(|cell| Some(cell.field_id) == assignees))
      .is_some_and(|cell| matches!(&cell.value,DatabaseCellValueData::Users(ids) if ids==&vec![plan.reviewer_id]));
    let doc = self
      .doc_service
      .get_doc_metadata(plan.source_document_id)
      .await
      .map_err(|_| runtime::unavailable())?;
    let source_available = doc.is_some_and(|doc| {
      doc.workspace_id == Some(run.workspace_id)
        && doc.deleted_at.is_none()
        && !doc.blocked
        && doc.external_id == plan.source_external_id
    }) && self
      .permission
      .get_effective_doc_role(actor, run.workspace_id, plan.source_document_id)
      .await
      .map_err(|_| runtime::unavailable())?
      .can(DocAction::Read);
    let current_source_revision = if source_available {
      Some(
        crate::doc::canonical_yjs_revision(
          &self
            .doc_service
            .load_full_doc_consistent(run.workspace_id, plan.source_document_id)
            .await
            .map_err(|_| runtime::unavailable())?,
        )
        .map_err(|_| runtime::unavailable())?,
      )
    } else {
      None
    };
    let task_acknowledged = self
      .repo
      .get_effect(run.id, "action:0", "apply")
      .await?
      .is_some_and(|effect| effect.result_json.is_some());
    let decision = self.repo.document_review_decision(run.id).await?;
    let can_decide = reviewer
      && assigned
      && incomplete
      && source_available
      && current_source_revision.as_deref() == Some(plan.source_revision.as_str())
      && role.is_some_and(|role| role.can(WorkspaceAction::CreateDoc))
      && plan.deadline_at > Utc::now()
      && decision.is_none()
      && run.error_code.as_deref() != Some(ERR_AUTOMATION_RUN_NOT_RETRYABLE)
      && matches!(
        run.status,
        WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
      );
    Ok(DocumentReviewView {
      wait_id: accepted.wait_id.clone(),
      expected_task_edit_revision: task.as_ref().map(|task| task.row.edit_revision),
      expected_status_edit_revision: task.as_ref().map(|task| {
        task
          .cell_revisions
          .iter()
          .find(|cell| Some(cell.field_id) == status_field)
          .map_or(0, |cell| cell.edit_revision)
      }),
      source_available,
      current_source_revision: current_source_revision.clone(),
      can_retry: self.limits.enabled
        && workflows::confirmed_run_retryable(&run)
        && source_available
        && current_source_revision.as_deref() == Some(plan.source_revision.as_str())
        && (decision.is_some() || ((!task_acknowledged || (assigned && incomplete)) && plan.deadline_at > Utc::now()))
        && (actor == plan.actor_id || manager),
      accepted_descriptor: native.packages.document_review_descriptor(&plan.package),
      accepted: plan.clone(),
      review_task_id: accepted.review_task_id,
      follow_up_task_id: accepted.follow_up_task_id,
      review_task_available: task.is_some(),
      follow_up_task_available: followup.is_some_and(|task| {
        ready
          && task.row.database_id == plan.destination_database_id
          && task.row.row_kind == DatabaseRowKind::Task
          && task.row.deleted_at.is_none()
      }),
      decision: decision.as_ref().map(|receipt| receipt.decision.clone()),
      can_approve: can_decide,
      can_request_changes: can_decide,
      can_stop: (actor == plan.actor_id || manager)
        && matches!(
          run.status,
          WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
        ),
      reason_code: if !source_available {
        Some("DOCUMENT_REVIEW_SOURCE_UNAVAILABLE".into())
      } else if !ready || (task_acknowledged && task.is_none()) {
        Some("DOCUMENT_REVIEW_TASK_UNAVAILABLE".into())
      } else if task_acknowledged && decision.is_none() && !assigned {
        Some("DOCUMENT_REVIEW_TASK_REASSIGNED".into())
      } else if task_acknowledged && decision.is_none() && !incomplete {
        Some("DOCUMENT_REVIEW_TASK_COMPLETED_OUTSIDE_DECISION".into())
      } else if decision.is_none() && plan.deadline_at <= Utc::now() {
        Some("DOCUMENT_REVIEW_EXPIRED".into())
      } else if current_source_revision.as_deref() != Some(plan.source_revision.as_str()) {
        Some("DOCUMENT_REVIEW_SOURCE_CHANGED".into())
      } else {
        run.error_code.clone()
      },
      run,
    })
  }
}
fn review_database_error(error: crate::database::DatabaseServiceError) -> WorkspaceAutomationServiceError {
  if error.is_retryable_storage_failure() {
    runtime::unavailable()
  } else {
    WorkspaceAutomationServiceError::new(
      if error.code == crate::database::ERR_FORBIDDEN {
        ERR_AUTOMATION_FORBIDDEN
      } else {
        ERR_AUTOMATION_RUN_NOT_RETRYABLE
      },
      "Review native admission unavailable",
    )
  }
}

pub fn review_wait(definition: &AcceptedAutomationDefinition) -> WorkspaceAutomationResult<(&str, &str)> {
  let source = &definition.workflow.as_ref().ok_or_else(invalid)?.source.source;
  let mut waits = super::workflows::native_workflow_nodes(source)
    .into_iter()
    .filter_map(|node| match &node.action {
      AssistantWorkflowAction::AwaitSignal { wait_id, .. } => Some((wait_id.as_str(), node.id.as_str())),
      _ => None,
    });
  let wait = waits.next().ok_or_else(invalid)?;
  if waits.next().is_some() {
    return Err(invalid());
  }
  Ok(wait)
}
pub fn compile_review_definition(
  plan: &PreparedDocumentReview,
  policy: AutomationExecutionPolicy,
) -> WorkspaceAutomationResult<AcceptedAutomationDefinition> {
  let source = &plan.workflow;
  if source.binding_version != 1
    || source.source.format_version != 1
    || source.identity.id != source.source.id
    || source.identity.version != source.source.version
    || format!("{:x}", Sha256::digest(&source.source_bytes)) != source.identity.digest
  {
    return Err(invalid());
  }
  let nodes = super::workflows::native_workflow_nodes(&source.source);
  if nodes.len() > 64 || nodes.is_empty() {
    return Err(invalid());
  }
  let mut ids = std::collections::BTreeSet::new();
  let mut tasks = std::collections::BTreeSet::new();
  let mut waits = 0;
  let mut branches = 0;
  for node in &nodes {
    if node.id.is_empty() || !ids.insert(&node.id) {
      return Err(invalid());
    }
    match &node.action {
      AssistantWorkflowAction::CreateTaskFromDocument { component } => {
        if !tasks.insert(component)
          || !plan.components.iter().any(|native| {
            native.id == *component && matches!(&native.action, AssistantNativeAction::CreateTaskFromDocument { .. })
          })
        {
          return Err(invalid());
        }
      }
      AssistantWorkflowAction::AwaitSignal { wait_id, deadline } => {
        waits += 1;
        if wait_id.is_empty()
          || !matches!(deadline,AssistantValueBinding::Input{input} if matches!(plan.answers.get(input),Some(AssistantValue::DateTime(value)) if value.start==plan.deadline_at && value.end.is_none() && !value.all_day))
        {
          return Err(invalid());
        }
      }
      AssistantWorkflowAction::Branch { outcome, cases } => {
        branches += 1;
        if cases.len() != 2
          || !cases.contains_key("approve")
          || !cases.contains_key("requestChanges")
          || !matches!(outcome,AssistantValueBinding::Result{component,value:AssistantResultValue::Outcome} if nodes.iter().any(|wait|wait.id==*component && matches!(&wait.action,AssistantWorkflowAction::AwaitSignal{..})))
        {
          return Err(invalid());
        }
      }
      _ => return Err(invalid()),
    }
  }
  if waits != 1
    || branches != 1
    || tasks.len() != 3
    || super::workflows::maximum_workflow_effects(&source.source.nodes) > policy.max_actions_per_run as usize
    || source.source.capability_versions.len() != 3
    || [
      AssistantWorkflowCapability::CreateTaskFromDocument,
      AssistantWorkflowCapability::AwaitSignal,
      AssistantWorkflowCapability::Branch,
    ]
    .iter()
    .any(|capability| source.source.capability_versions.get(capability) != Some(&1))
  {
    return Err(invalid());
  }
  // This consumer admits one review Task, its wait and the two exclusive
  // follow-up choices. Generic workflow validation remains business-neutral.
  let top = &source.source.nodes;
  if top.len() != 3
    || !matches!(&top[0].action, AssistantWorkflowAction::CreateTaskFromDocument { .. })
    || !matches!(&top[1].action, AssistantWorkflowAction::AwaitSignal { .. })
    || !matches!(&top[2].action,AssistantWorkflowAction::Branch{cases,..} if cases.values().all(|nodes|nodes.len()==1 && matches!(&nodes[0].action,AssistantWorkflowAction::CreateTaskFromDocument{..})))
  {
    return Err(invalid());
  }
  let primary = plan
    .components
    .iter()
    .filter_map(|component| match &component.action {
      AssistantNativeAction::RequestDocumentReview { inputs } => Some(inputs),
      _ => None,
    })
    .collect::<Vec<_>>();
  if primary.len() != 1 {
    return Err(invalid());
  }
  let source_binding = primary[0]
    .get(&AssistantInputTarget::SourceDocument)
    .ok_or_else(invalid)?;
  let reviewer_binding = primary[0].get(&AssistantInputTarget::Reviewer).ok_or_else(invalid)?;
  let deadline_binding = primary[0].get(&AssistantInputTarget::Deadline).ok_or_else(invalid)?;
  let same = |left: &AssistantValueBinding, right: &AssistantValueBinding| {
    serde_json::to_value(left).ok() == serde_json::to_value(right).ok()
  };
  for node in &nodes {
    let AssistantWorkflowAction::CreateTaskFromDocument { component } = &node.action else {
      continue;
    };
    let native = plan
      .components
      .iter()
      .find(|native| native.id == *component)
      .ok_or_else(invalid)?;
    let AssistantNativeAction::CreateTaskFromDocument { inputs } = &native.action else {
      return Err(invalid());
    };
    if !inputs
      .get(&AssistantInputTarget::SourceDocument)
      .is_some_and(|binding| same(binding, source_binding))
    {
      return Err(invalid());
    }
    let branch = if node.id == top[0].id {
      None
    } else {
      match &top[2].action {
        AssistantWorkflowAction::Branch { cases, .. } => cases
          .iter()
          .find(|(_, nodes)| nodes[0].id == node.id)
          .map(|(key, _)| key.as_str()),
        _ => None,
      }
    };
    match branch {
      None
        if inputs
          .get(&AssistantInputTarget::Assignees)
          .is_some_and(|binding| same(binding, reviewer_binding))
          && inputs
            .get(&AssistantInputTarget::Due)
            .is_some_and(|binding| same(binding, deadline_binding)) => {}
      Some("approve")
        if matches!(
          inputs.get(&AssistantInputTarget::Assignees),
          Some(AssistantValueBinding::Context {
            value: AssistantContextValue::Requester
          })
        ) => {}
      Some("requestChanges")
        if matches!(
          inputs.get(&AssistantInputTarget::Assignees),
          Some(AssistantValueBinding::Context {
            value: AssistantContextValue::Requester
          })
        ) && matches!(inputs.get(&AssistantInputTarget::Description),Some(AssistantValueBinding::Result{component,value:AssistantResultValue::Reason}) if component==&top[1].id) =>
        {}
      _ => return Err(invalid()),
    }
  }
  let mut definition = AcceptedAutomationDefinition {
    format_version: 1,
    runtime_schema_version: 1,
    policy,
    hash: String::new(),
    capability_versions: [
      ("createTaskFromDocument".into(), 1),
      ("awaitSignal".into(), 1),
      ("branch".into(), 1),
    ]
    .into(),
    actions: Vec::new(),
    workflow: Some(AcceptedNativeWorkflow {
      source: source.clone(),
      components: plan.components.clone(),
      stages: Vec::new(),
      wait_counts: Default::default(),
    }),
  };
  definition.hash = runtime::definition_hash(&definition)?;
  Ok(definition)
}

/// Resolve only a real native Task-effect node and its source-authored branch.
/// Both callbacks and transaction fences consume this same closed projection.
pub fn review_effect_component(
  definition: &AcceptedAutomationDefinition,
  node_key: &str,
) -> WorkspaceAutomationResult<(String, Option<String>)> {
  let workflow = definition.workflow.as_ref().ok_or_else(invalid)?;
  let index = node_key
    .strip_prefix("action:")
    .and_then(|id| id.parse::<usize>().ok())
    .filter(|id| node_key == format!("action:{id}"))
    .ok_or_else(invalid)?;
  let node = super::workflows::native_workflow_nodes(&workflow.source.source)
    .get(index)
    .copied()
    .ok_or_else(invalid)?;
  let AssistantWorkflowAction::CreateTaskFromDocument { component } = &node.action else {
    return Err(invalid());
  };
  fn branch(nodes: &[AssistantWorkflowNode], id: &str, current: Option<&str>) -> Option<String> {
    for node in nodes {
      if node.id == id {
        return current.map(str::to_owned);
      }
      if let AssistantWorkflowAction::Branch { cases, .. } = &node.action {
        for (key, nodes) in cases {
          if let Some(value) = branch(nodes, id, Some(key)) {
            return Some(value);
          }
        }
      }
    }
    None
  }
  Ok((component.clone(), branch(&workflow.source.source.nodes, &node.id, None)))
}

pub(crate) async fn execute_review_task(
  repo: &Arc<dyn WorkspaceAutomationRepository>,
  editing: &crate::database::DatabaseEditingService,
  schema: &Arc<dyn DatabaseDefinitionRepository>,
  invocation: runtime::AutomationEffectInvocation,
  run: &WorkspaceAutomationRun,
) -> WorkspaceAutomationResult<runtime::AutomationEffectResult> {
  let accepted = run.accepted.as_ref().ok_or_else(runtime::unavailable)?;
  let review = accepted.document_review.as_ref().ok_or_else(runtime::unavailable)?;
  let (component, branch) = review_effect_component(&accepted.definition, &invocation.node_key)?;
  let decision = repo.document_review_decision(run.id).await?;
  if let Some(branch) = branch.as_deref() {
    let receipt = decision.as_ref().ok_or_else(invalid)?;
    let outcome = match receipt.decision {
      DocumentReviewDecision::Approve => "approve",
      DocumentReviewDecision::RequestChanges { .. } => "requestChanges",
    };
    let signal = invocation.signal.as_ref().ok_or_else(invalid)?;
    if branch != outcome
      || signal.event_id != receipt.event_id
      || signal.key.run_id != run.id
      || signal.key.wait_id != review.wait_id
    {
      return Err(invalid());
    }
  }
  let definition = schema
    .get_database(review.plan.destination_database_id)
    .await?
    .filter(|record| {
      record.database.workspace_id == run.workspace_id
        && record.database.deleted_at.is_none()
        && record
          .managed_schema
          .as_ref()
          .is_some_and(|managed| managed.readiness == DatabaseManagedSchemaReadiness::Ready)
    })
    .ok_or_else(invalid)?;
  if let Some(effect) = repo
    .get_effect(run.id, &invocation.node_key, &invocation.effect_key)
    .await?
  {
    if effect.input_fingerprint != invocation.input_fingerprint {
      return Err(invalid());
    }
    if let Some(result) = effect.result_json {
      let row = editing
        .task_capture_receipt(review.plan.actor_id, run.workspace_id, effect.action_id)
        .await
        .map_err(review_database_error)?
        .ok_or_else(invalid)?;
      if row.record.is_none() || row.target_trashed {
        return Err(invalid());
      }
      return Ok(runtime::AutomationEffectResult {
        action_id: effect.action_id,
        result,
      });
    }
  }
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
  let component = review
    .plan
    .components
    .iter()
    .find(|native| native.id == component)
    .ok_or_else(invalid)?;
  let AssistantNativeAction::CreateTaskFromDocument { inputs } = &component.action else {
    return Err(invalid());
  };
  let bound = |binding: &AssistantValueBinding| -> WorkspaceAutomationResult<AssistantValue> {
    match binding {
      AssistantValueBinding::Input { input } => review.plan.answers.get(input).cloned().ok_or_else(invalid),
      AssistantValueBinding::Context {
        value: AssistantContextValue::Requester,
      } => Ok(AssistantValue::Members(vec![review.plan.actor_id])),
      AssistantValueBinding::LocalizedText { value } => Ok(AssistantValue::Text(
        match review.plan.locale.as_str() {
          "de" => &value.de,
          "fr" => &value.fr,
          "es" => &value.es,
          _ => &value.en,
        }
        .clone(),
      )),
      AssistantValueBinding::Result {
        value: AssistantResultValue::Reason,
        ..
      } => match decision.as_ref().map(|receipt| &receipt.decision) {
        Some(DocumentReviewDecision::RequestChanges { reason }) => Ok(AssistantValue::Text(reason.clone())),
        _ => Err(invalid()),
      },
      _ => Err(invalid()),
    }
  };
  let mut title = None;
  let mut cells = Vec::new();
  for (target, binding) in inputs {
    let value = bound(binding)?;
    match (target, value) {
      (AssistantInputTarget::SourceDocument, AssistantValue::Document(id)) if id == review.plan.source_document_id => {}
      (AssistantInputTarget::Destination, AssistantValue::DatabaseDestination(id))
        if id == review.plan.destination_database_id => {}
      (AssistantInputTarget::Title, AssistantValue::Text(value)) => title = Some(value),
      (AssistantInputTarget::Assignees, AssistantValue::Members(ids)) => {
        let field = definition
          .field_roles
          .iter()
          .find(|role| role.role_key == "task.assignees")
          .ok_or_else(invalid)?
          .field_id;
        cells.push((field, DatabaseCellValueData::Users(ids)));
      }
      (AssistantInputTarget::Due, AssistantValue::DateTime(value)) => {
        let field = definition
          .field_roles
          .iter()
          .find(|role| role.role_key == "task.dueDate")
          .ok_or_else(invalid)?
          .field_id;
        cells.push((field, DatabaseCellValueData::DateTime(value)));
      }
      (AssistantInputTarget::Description, AssistantValue::Text(value)) => {
        let role = definition
          .field_roles
          .iter()
          .find(|role| role.role_key == "task.description")
          .ok_or_else(invalid)?;
        let field = definition
          .fields
          .iter()
          .find(|field| field.id == role.field_id)
          .ok_or_else(invalid)?;
        let value = crate::database::editing::task_description_value(field, value).map_err(review_database_error)?;
        cells.push((field.id, value));
      }
      _ => return Err(invalid()),
    }
  }
  editing
    .create_task_from_source_with_effect(
      review.plan.actor_id,
      crate::database::DatabaseTaskCaptureInput {
        workspace_id: run.workspace_id,
        database_id: review.plan.destination_database_id,
        request_id: effect.action_id,
        source_document_id: review.plan.source_document_id,
        source_external_id: review.plan.source_external_id.clone(),
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
    .map_err(review_database_error)?;
  let receipt = repo
    .get_effect(run.id, &invocation.node_key, &invocation.effect_key)
    .await?
    .ok_or_else(runtime::unavailable)?;
  Ok(runtime::AutomationEffectResult {
    action_id: receipt.action_id,
    result: receipt.result_json.ok_or_else(runtime::unavailable)?,
  })
}
