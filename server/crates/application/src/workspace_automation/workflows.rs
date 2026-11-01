// SPDX-License-Identifier: AGPL-3.0-or-later
//! Compile admitted contextual sources to the existing atomic native stages.
//! Confirmation is a one-shot user action in every assistance mode, not consent
//! to a standing automatic rule. Only Sayiir advances the accepted stage list.
use super::{runtime::*, *};
use crate::{
  auth::AuthService,
  workspace::{assistant_packages::AssistantPackageService, *},
};
use myoxus_domain::{assistant_package::*, workspace_automation::*};
use std::collections::BTreeSet;

pub fn compile_context_workflow(
  plan: &AssistantPreparedContextDocuments,
  policy: AutomationExecutionPolicy,
) -> RuntimeResult<AcceptedAutomationDefinition> {
  let source = plan.workflow.clone().ok_or_else(runtime::unavailable)?;
  if policy.max_retry_attempts == 0
    || policy.webhook_timeout_seconds == 0
    || source.binding_version != 1
    || source.source.format_version != 1
    || source.source.capability_versions.len() != 1
    || source
      .source
      .capability_versions
      .get(&AssistantWorkflowCapability::CreateContextDocument)
      != Some(&1)
    || source.source.id != source.identity.id
    || source.source.version != source.identity.version
    || format!("{:x}", Sha256::digest(&source.source_bytes)) != source.identity.digest
  {
    return Err(runtime::unavailable());
  }
  let mut seen = BTreeSet::new();
  let mut node_ids = BTreeSet::new();
  let mut stages = vec![ContextDocumentWorkflowStage::Folder];
  for node in &source.source.nodes {
    let AssistantWorkflowAction::CreateContextDocument { component } = &node.action else {
      return Err(runtime::unavailable());
    };
    if node.id.is_empty() || !node_ids.insert(&node.id) || !seen.insert(component) {
      return Err(runtime::unavailable());
    }
    if plan.documents.iter().any(|doc| &doc.source.component_id == component) {
      let created_node = format!("action:{}", stages.len());
      stages.push(ContextDocumentWorkflowStage::CreateDocument {
        component: component.clone(),
      });
      stages.push(ContextDocumentWorkflowStage::PlaceDocument {
        component: component.clone(),
        created_node,
      });
    }
  }
  if plan
    .documents
    .iter()
    .any(|doc| !seen.contains(&doc.source.component_id))
    || plan.documents.is_empty()
    || plan.documents.len() > 64
    || plan.documents.len() as u64 > u64::from(policy.max_actions_per_run)
  {
    return Err(runtime::unavailable());
  }
  stages.push(ContextDocumentWorkflowStage::Complete);
  let mut definition = AcceptedAutomationDefinition {
    format_version: 1,
    runtime_schema_version: 1,
    policy,
    hash: String::new(),
    capability_versions: [("createContextDocument".into(), 1)].into(),
    actions: Vec::new(),
    workflow: Some(AcceptedNativeWorkflow {
      source,
      stages,
      components: Vec::new(),
      wait_counts: Default::default(),
    }),
  };
  definition.hash = definition_hash(&definition)?;
  Ok(definition)
}

/// Validate the retained compiled form without resolving today's offering.
pub fn context_stage_count(definition: &AcceptedAutomationDefinition) -> RuntimeResult<usize> {
  let workflow = definition.workflow.as_ref().ok_or_else(runtime::unavailable)?;
  if !definition.actions.is_empty()
    || workflow.source.binding_version != 1
    || definition.capability_versions.len() != 1
    || definition.capability_versions.get("createContextDocument") != Some(&1)
    || workflow.source.source.format_version != 1
    || workflow.source.source.capability_versions.len() != 1
    || workflow
      .source
      .source
      .capability_versions
      .get(&AssistantWorkflowCapability::CreateContextDocument)
      != Some(&1)
    || workflow.source.source.id != workflow.source.identity.id
    || workflow.source.source.version != workflow.source.identity.version
    || format!("{:x}", Sha256::digest(&workflow.source.source_bytes)) != workflow.source.identity.digest
  {
    return Err(runtime::unavailable());
  }
  let selected = workflow
    .stages
    .iter()
    .filter_map(|stage| match stage {
      ContextDocumentWorkflowStage::CreateDocument { component } => Some(component),
      _ => None,
    })
    .collect::<BTreeSet<_>>();
  if selected.is_empty()
    || selected.len() > 64
    || selected.len() as u64 > u64::from(definition.policy.max_actions_per_run)
  {
    return Err(runtime::unavailable());
  }
  let mut expected = vec![ContextDocumentWorkflowStage::Folder];
  let mut seen = BTreeSet::new();
  let mut nodes = BTreeSet::new();
  for node in &workflow.source.source.nodes {
    let AssistantWorkflowAction::CreateContextDocument { component } = &node.action else {
      return Err(runtime::unavailable());
    };
    if node.id.is_empty() || !nodes.insert(&node.id) || !seen.insert(component) {
      return Err(runtime::unavailable());
    }
    if selected.contains(component) {
      let created_node = format!("action:{}", expected.len());
      expected.push(ContextDocumentWorkflowStage::CreateDocument {
        component: component.clone(),
      });
      expected.push(ContextDocumentWorkflowStage::PlaceDocument {
        component: component.clone(),
        created_node,
      });
    }
  }
  expected.push(ContextDocumentWorkflowStage::Complete);
  if expected != workflow.stages {
    return Err(runtime::unavailable());
  }
  Ok(expected.len())
}

pub fn confirmed_run_retryable(run: &WorkspaceAutomationRun) -> bool {
  matches!(
    run.status,
    WorkspaceAutomationRunStatus::Failed | WorkspaceAutomationRunStatus::DeadLetter
  ) && matches!(
    run.error_code.as_deref(),
    None | Some("AUTOMATION_RUNTIME_FAILED" | "MIX_AUTOMATION_RUN_FAILED" | "MIX_AUTOMATION_INPUTS_UNAVAILABLE")
  )
}

pub(super) fn context_database_error(error: crate::database::DatabaseServiceError) -> WorkspaceAutomationServiceError {
  if error.is_retryable_storage_failure() {
    runtime::unavailable()
  } else if error.code == crate::database::ERR_FORBIDDEN {
    WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "Context document permission unavailable")
  } else {
    WorkspaceAutomationServiceError::new(
      ERR_AUTOMATION_RUN_NOT_RETRYABLE,
      "Context document request is no longer applicable",
    )
  }
}
fn context_receipt_error(error: ProjectStarterError) -> WorkspaceAutomationServiceError {
  match error {
    ProjectStarterError::Auth(crate::auth::AuthError::Storage(_)) => runtime::unavailable(),
    ProjectStarterError::Auth(crate::auth::AuthError::ActionForbidden) => {
      WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "Context document permission unavailable")
    }
    ProjectStarterError::Database(error) => context_database_error(error),
    _ => WorkspaceAutomationServiceError::new(
      ERR_AUTOMATION_RUN_NOT_RETRYABLE,
      "Context document request is no longer applicable",
    ),
  }
}

/// Cloned native collaborators contain no WorkspaceService or runtime backref.
#[derive(Clone)]
pub struct ContextDocumentActions {
  pub store: Arc<dyn WorkspaceStore>,
  pub packages: Arc<AssistantPackageService>,
  pub auth: Arc<AuthService>,
}
impl ContextDocumentActions {
  pub async fn authorize_retry(
    &self,
    repo: &Arc<dyn WorkspaceAutomationRepository>,
    run: &WorkspaceAutomationRun,
  ) -> RuntimeResult<()> {
    let accepted = run.accepted.as_ref().ok_or_else(runtime::unavailable)?;
    let origin = accepted.confirmed_request.as_ref().ok_or_else(runtime::unavailable)?;
    let actor = accepted.actor_id.ok_or_else(runtime::unavailable)?;
    let receipt = self
      .store
      .get_context_documents(actor, run.workspace_id, origin.request_id, Some(&origin.fingerprint))
      .await
      .map_err(context_receipt_error)?
      .ok_or_else(runtime::unavailable)?;
    if !confirmed_run_retryable(run) || receipt.run_id != Some(run.id) || receipt.plan.target != origin.target {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_RUN_NOT_RETRYABLE,
        "Context request no longer applicable",
      ));
    }
    // An acknowledged working copy must remain readable before any remaining
    // stage can resume; uncreated components have no result to authorize yet.
    let views = self
      .packages
      .context_document_views(&receipt)
      .await
      .map_err(context_database_error)?;
    if views.iter().any(|view| view.created && view.external_id.is_none()) {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_RUN_NOT_RETRYABLE,
        "Context results no longer available",
      ));
    }
    if receipt.state == ProjectStarterState::Complete {
      // Recover engine acknowledgement only: every native stage must already
      // have its exact immutable result, and every working copy remains readable.
      if !receipt.progress.folder_ready
        || !receipt.progress.placement_complete
        || views.len() != receipt.ids.documents.len()
        || views
          .iter()
          .any(|view| !view.created || !view.placed || view.external_id.is_none())
      {
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_RUN_NOT_RETRYABLE,
          "Context results no longer available",
        ));
      }
      let count = context_stage_count(&accepted.definition)?;
      let workflow = accepted.definition.workflow.as_ref().ok_or_else(runtime::unavailable)?;
      for (position, stage) in workflow.stages.iter().enumerate().take(count) {
        let node = format!("action:{position}");
        let effect = repo
          .get_effect(run.id, &node, "apply")
          .await?
          .ok_or_else(runtime::unavailable)?;
        let expected = match stage {
          ContextDocumentWorkflowStage::Folder => ContextWorkflowResult::Folder {
            folder_id: receipt.ids.folder_id.clone(),
          },
          ContextDocumentWorkflowStage::CreateDocument { component }
          | ContextDocumentWorkflowStage::PlaceDocument { component, .. } => {
            let ids = receipt
              .ids
              .documents
              .iter()
              .find(|ids| &ids.component_id == component)
              .ok_or_else(runtime::unavailable)?;
            if matches!(stage, ContextDocumentWorkflowStage::CreateDocument { .. }) {
              ContextWorkflowResult::Created {
                component: component.clone(),
                doc_id: ids.doc_id,
              }
            } else {
              ContextWorkflowResult::Placed {
                component: component.clone(),
                doc_id: ids.doc_id,
              }
            }
          }
          ContextDocumentWorkflowStage::Complete => ContextWorkflowResult::Complete,
          _ => return Err(runtime::unavailable()),
        };
        if effect.status != WorkspaceAutomationActionStatus::Succeeded
          || effect.input_fingerprint != effect_input_fingerprint(accepted, &node, "apply")?
          || effect.result_json != Some(serde_json::to_value(expected).map_err(|_| runtime::unavailable())?)
        {
          return Err(runtime::unavailable());
        }
      }
    } else if receipt.state == ProjectStarterState::Accepted {
      let review = self
        .packages
        .prepare_accepted_context_documents(&receipt)
        .await
        .map_err(context_database_error)?;
      if !review.execution_available
        || crate::workspace::assistant_packages::context_documents_admission(&review).effects_digest
          != receipt.admission.effects_digest
      {
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_RUN_NOT_RETRYABLE,
          "Context effects require a fresh request",
        ));
      }
    } else {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_RUN_NOT_RETRYABLE,
        "Context request is terminal",
      ));
    }
    let (_, _, ordinary) = self
      .packages
      .context_document_context(actor, run.workspace_id, &origin.target)
      .await
      .map_err(context_database_error)?;
    self
      .packages
      .context_assistance(actor, run.workspace_id, &origin.target, ordinary, &self.auth)
      .await
      .map_err(context_database_error)?;
    Ok(())
  }
  #[tracing::instrument(skip_all)]
  pub async fn execute(
    &self,
    repo: &Arc<dyn WorkspaceAutomationRepository>,
    invocation: AutomationEffectInvocation,
    run: &WorkspaceAutomationRun,
    accepted: &AcceptedAutomationRun,
  ) -> RuntimeResult<AutomationEffectResult> {
    let origin = accepted.confirmed_request.as_ref().ok_or_else(runtime::unavailable)?;
    let actor = accepted.actor_id.ok_or_else(runtime::unavailable)?;
    let receipt = self
      .store
      .get_context_documents(actor, run.workspace_id, origin.request_id, Some(&origin.fingerprint))
      .await
      .map_err(context_receipt_error)?
      .ok_or_else(runtime::unavailable)?;
    if receipt.run_id != Some(run.id) || receipt.plan.target != origin.target {
      return Err(runtime::unavailable());
    }
    let position = invocation
      .node_key
      .strip_prefix("action:")
      .and_then(|value| value.parse::<usize>().ok())
      .filter(|index| invocation.node_key == format!("action:{index}"))
      .ok_or_else(runtime::unavailable)?;
    let stage = accepted
      .definition
      .workflow
      .as_ref()
      .and_then(|workflow| workflow.stages.get(position))
      .ok_or_else(runtime::unavailable)?
      .clone();
    let envelope = invocation
      .context
      .as_ref()
      .filter(|envelope| {
        envelope.format_version == 1
          && envelope.request_id == origin.request_id
          && envelope.fingerprint == origin.fingerprint
          && envelope.target == origin.target
      })
      .ok_or_else(runtime::unavailable)?;
    if let ContextDocumentWorkflowStage::PlaceDocument {
      component,
      created_node,
    } = &stage
    {
      let Some(ContextWorkflowResult::Created {
        component: prior_component,
        doc_id,
      }) = envelope.results.get(created_node)
      else {
        return Err(runtime::unavailable());
      };
      if prior_component != component
        || !receipt
          .ids
          .documents
          .iter()
          .any(|ids| &ids.component_id == component && ids.doc_id == *doc_id)
        || !receipt
          .progress
          .documents
          .get(component)
          .is_some_and(|created| created.doc_id == *doc_id)
      {
        return Err(runtime::unavailable());
      }
    }
    if let Some(effect) = repo
      .get_effect(run.id, &invocation.node_key, &invocation.effect_key)
      .await?
    {
      if effect.input_fingerprint != invocation.input_fingerprint {
        return Err(runtime::unavailable());
      }
      if let Some(result) = effect.result_json {
        // Readback is current-authorized; completed native data is never rebuilt.
        self
          .packages
          .context_document_views(&receipt)
          .await
          .map_err(context_database_error)?;
        return Ok(AutomationEffectResult {
          action_id: effect.action_id,
          result,
        });
      }
    }
    if receipt.state != ProjectStarterState::Accepted {
      return Err(runtime::unavailable());
    }
    let review = self
      .packages
      .prepare_accepted_context_documents(&receipt)
      .await
      .map_err(context_database_error)?;
    let admission = crate::workspace::assistant_packages::context_documents_admission(&review);
    if admission.effects_digest != receipt.admission.effects_digest {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_RUN_NOT_RETRYABLE,
        "Context document effects require a fresh request",
      ));
    }
    let (_, _, ordinary) = self
      .packages
      .context_document_context(actor, run.workspace_id, &origin.target)
      .await
      .map_err(context_database_error)?;
    self
      .packages
      .context_assistance(actor, run.workspace_id, &origin.target, ordinary, &self.auth)
      .await
      .map_err(context_database_error)?;
    let receipt = self
      .store
      .review_context_documents(&receipt, admission)
      .await
      .map_err(context_receipt_error)?;
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
    let fence = AutomationEffectFence {
      run_id: run.id,
      action_id: effect.action_id,
      claim: invocation.claim,
    };
    let write_result = match stage {
      ContextDocumentWorkflowStage::CreateDatabaseFromDefinition { .. }
      | ContextDocumentWorkflowStage::CreateWorkingDocument { .. }
      | ContextDocumentWorkflowStage::PlaceNativeLink { .. } => return Err(runtime::unavailable()),
      ContextDocumentWorkflowStage::CreateDocument { component } => {
        self
          .packages
          .create_context_document(&receipt, &component, Some(fence))
          .await
      }
      ContextDocumentWorkflowStage::Folder => {
        self
          .packages
          .place_context_stage(&receipt, ProjectPlacementStage::Folder, Some(fence))
          .await
      }
      ContextDocumentWorkflowStage::PlaceDocument { component, .. } => {
        self
          .packages
          .place_context_stage(
            &receipt,
            ProjectPlacementStage::Document {
              component_id: component,
            },
            Some(fence),
          )
          .await
      }
      ContextDocumentWorkflowStage::Complete => {
        self
          .packages
          .place_context_stage(&receipt, ProjectPlacementStage::CompleteDocuments, Some(fence))
          .await
      }
    };
    let result = repo
      .get_effect(run.id, &invocation.node_key, &invocation.effect_key)
      .await?
      .and_then(|effect| effect.result_json);
    let result = match result {
      Some(result) => result,
      None => {
        write_result.map_err(context_database_error)?;
        return Err(runtime::unavailable());
      }
    };
    Ok(AutomationEffectResult {
      action_id: effect.action_id,
      result,
    })
  }
}

pub fn native_workflow_nodes(source: &AssistantWorkflowSource) -> Vec<&AssistantWorkflowNode> {
  fn visit<'a>(nodes: &'a [AssistantWorkflowNode], out: &mut Vec<&'a AssistantWorkflowNode>) {
    for node in nodes {
      out.push(node);
      if let AssistantWorkflowAction::Branch { cases, .. } = &node.action {
        for nodes in cases.values() {
          visit(nodes, out);
        }
      }
    }
  }
  let mut out = Vec::new();
  visit(&source.nodes, &mut out);
  out
}

/// Count maximum native effects on one reachable branch, excluding technical
/// waits/branches. Exclusive outcomes do not consume each other's action budget.
pub fn maximum_workflow_effects(nodes: &[AssistantWorkflowNode]) -> usize {
  nodes
    .iter()
    .map(|node| match &node.action {
      AssistantWorkflowAction::CreateDatabaseFromDefinition { .. }
      | AssistantWorkflowAction::CreateWorkingDocument { .. }
      | AssistantWorkflowAction::PlaceNativeLink { .. }
      | AssistantWorkflowAction::CreateContextDocument { .. }
      | AssistantWorkflowAction::CreateTaskFromDocument { .. }
      | AssistantWorkflowAction::InspectTaskContent { .. }
      | AssistantWorkflowAction::ApplyTaskCorrections { .. }
      | AssistantWorkflowAction::CreateLinkedDocument { .. } => 1,
      AssistantWorkflowAction::AwaitSignal { .. }
      | AssistantWorkflowAction::AwaitTaskSet { .. }
      | AssistantWorkflowAction::AwaitCorrectionConfirmation { .. } => 0,
      AssistantWorkflowAction::Branch { cases, .. } => cases
        .values()
        .map(|nodes| maximum_workflow_effects(nodes))
        .max()
        .unwrap_or(0),
    })
    .sum()
}
