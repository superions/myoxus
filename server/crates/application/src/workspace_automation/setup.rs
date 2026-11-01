// SPDX-License-Identifier: AGPL-3.0-or-later
//! Workspace setup lowers admitted native components to the shared Sayiir stages.
use super::{runtime::*, *};
use myoxus_domain::{assistant_package::*, workspace_automation::*};
use std::collections::BTreeSet;

pub fn compile_workspace_setup(
  plan: &AssistantPreparedWorkspaceSetup,
  policy: AutomationExecutionPolicy,
) -> RuntimeResult<AcceptedAutomationDefinition> {
  let source = &plan.workflow;
  if source.binding_version != 1
    || source.source.format_version != 1
    || source.source.trigger.is_some()
    || source.source.id != source.identity.id
    || source.source.version != source.identity.version
    || format!("{:x}", Sha256::digest(&source.source_bytes)) != source.identity.digest
    || plan.components.is_empty()
    || plan.components.len() > policy.max_actions_per_run as usize
  {
    return Err(unavailable());
  }
  let mut seen = BTreeSet::new();
  let mut produced = BTreeSet::new();
  let mut stages = Vec::new();
  if plan.folder.is_some() {
    stages.push(ContextDocumentWorkflowStage::Folder);
  }
  for node in &source.source.nodes {
    let (component, capability) = match &node.action {
      AssistantWorkflowAction::CreateDatabaseFromDefinition { component } => {
        (component, AssistantWorkflowCapability::CreateDatabaseFromDefinition)
      }
      AssistantWorkflowAction::CreateWorkingDocument { component } => {
        (component, AssistantWorkflowCapability::CreateWorkingDocument)
      }
      AssistantWorkflowAction::PlaceNativeLink { component } => {
        (component, AssistantWorkflowCapability::PlaceNativeLink)
      }
      _ => return Err(unavailable()),
    };
    if !seen.insert(component.clone()) || source.source.capability_versions.get(&capability) != Some(&1) {
      return Err(unavailable());
    }
    let Some(native) = plan.components.iter().find(|native| native.id == *component) else {
      continue;
    };
    let stage = match (&node.action, &native.action) {
      (
        AssistantWorkflowAction::CreateDatabaseFromDefinition { .. },
        AssistantNativeAction::CreateDatabaseFromDefinition { .. },
      ) => {
        if !plan
          .definitions
          .iter()
          .any(|definition| definition.component_id == *component)
        {
          return Err(unavailable());
        }
        produced.insert(component.clone());
        ContextDocumentWorkflowStage::CreateDatabaseFromDefinition {
          component: component.clone(),
        }
      }
      (AssistantWorkflowAction::CreateWorkingDocument { .. }, AssistantNativeAction::CreateWorkingDocument { .. }) => {
        if !plan
          .document_metadata
          .iter()
          .any(|document| document.source.component_id == *component)
        {
          return Err(unavailable());
        }
        produced.insert(component.clone());
        ContextDocumentWorkflowStage::CreateWorkingDocument {
          component: component.clone(),
        }
      }
      (
        AssistantWorkflowAction::PlaceNativeLink { .. },
        AssistantNativeAction::PlaceNativeLink {
          target: AssistantValueBinding::Result { component: prior, .. },
          ..
        },
      ) if produced.contains(prior) => ContextDocumentWorkflowStage::PlaceNativeLink {
        component: component.clone(),
      },
      _ => return Err(unavailable()),
    };
    stages.push(stage);
  }
  if plan.components.iter().any(|component| !seen.contains(&component.id)) || stages.len() + 1 > 64 {
    return Err(unavailable());
  }
  stages.push(ContextDocumentWorkflowStage::Complete);
  let mut definition = AcceptedAutomationDefinition {
    format_version: 1,
    runtime_schema_version: 1,
    policy,
    hash: String::new(),
    capability_versions: [("workspaceSetup".into(), 1)].into(),
    actions: Vec::new(),
    workflow: Some(AcceptedNativeWorkflow {
      source: source.clone(),
      stages,
      components: plan.components.clone(),
      wait_counts: Default::default(),
    }),
  };
  definition.hash = definition_hash(&definition)?;
  Ok(definition)
}

/// Retained validation checks the frozen source and selected components; it
/// never replaces an accepted graph with today's catalog offering.
pub fn workspace_setup_stage_count(definition: &AcceptedAutomationDefinition) -> RuntimeResult<usize> {
  let workflow = definition.workflow.as_ref().ok_or_else(unavailable)?;
  if definition.capability_versions.get("workspaceSetup") != Some(&1)
    || definition.capability_versions.len() != 1
    || !definition.actions.is_empty()
    || workflow.stages.is_empty()
    || workflow.stages.len() > 64
    || workflow.components.len() > definition.policy.max_actions_per_run as usize
    || definition_hash(definition)? != definition.hash
    || workflow.source.binding_version != 1
    || format!("{:x}", Sha256::digest(&workflow.source.source_bytes)) != workflow.source.identity.digest
    || workflow.stages.last() != Some(&ContextDocumentWorkflowStage::Complete)
  {
    return Err(unavailable());
  }
  Ok(workflow.stages.len())
}

fn setup_error(error: crate::workspace::WorkspaceStarterError) -> WorkspaceAutomationServiceError {
  match error {
    crate::workspace::WorkspaceStarterError::Auth(crate::auth::AuthError::Storage(_)) => unavailable(),
    crate::workspace::WorkspaceStarterError::Auth(crate::auth::AuthError::ActionForbidden) => {
      WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "Workspace setup permission unavailable")
    }
    crate::workspace::WorkspaceStarterError::Project(crate::workspace::ProjectStarterError::Database(error)) => {
      super::workflows::context_database_error(error)
    }
    _ => WorkspaceAutomationServiceError::new(ERR_AUTOMATION_RUN_NOT_RETRYABLE, "Workspace setup no longer applicable"),
  }
}
fn setup_document_error(error: crate::document_template::DocumentTemplateError) -> WorkspaceAutomationServiceError {
  match error {
    crate::document_template::DocumentTemplateError::Repository(
      myoxus_domain::repositories::RepositoryError::Storage(_),
    ) => unavailable(),
    crate::document_template::DocumentTemplateError::Forbidden => {
      WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "Workspace document permission unavailable")
    }
    _ => WorkspaceAutomationServiceError::new(
      ERR_AUTOMATION_RUN_NOT_RETRYABLE,
      "Workspace document source or destination unavailable",
    ),
  }
}
impl super::workflows::ContextDocumentActions {
  async fn workspace_setup_receipt(
    &self,
    run: &WorkspaceAutomationRun,
  ) -> RuntimeResult<crate::workspace::assistant_packages::AcceptedWorkspaceSetup> {
    let accepted = run.accepted.as_ref().ok_or_else(unavailable)?;
    let origin = accepted.workspace_setup.as_ref().ok_or_else(unavailable)?;
    let allocation = self
      .store
      .get_workspace_starter(
        accepted.actor_id.ok_or_else(unavailable)?,
        origin.request_id,
        Some(&origin.fingerprint),
      )
      .await
      .map_err(setup_error)?
      .ok_or_else(unavailable)?;
    if allocation.workspace.id != run.workspace_id
      || !allocation.receipt.assistance_saved
      || !allocation.root_ready
      || !allocation.tasks_ready
    {
      return Err(unavailable());
    }
    allocation
      .setup
      .filter(|receipt| receipt.run_id == run.id)
      .ok_or_else(unavailable)
  }
  pub(crate) async fn authorize_workspace_setup_retry(
    &self,
    repo: &Arc<dyn WorkspaceAutomationRepository>,
    run: &WorkspaceAutomationRun,
  ) -> RuntimeResult<()> {
    if !super::workflows::confirmed_run_retryable(run) {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_RUN_NOT_RETRYABLE,
        "Workspace setup is not retryable",
      ));
    }
    let receipt = self.workspace_setup_receipt(run).await?;
    let views = self
      .packages
      .workspace_setup_views(&receipt)
      .await
      .map_err(super::workflows::context_database_error)?;
    if views.iter().any(|view| view.result.is_some() && !view.available) {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_RUN_NOT_RETRYABLE,
        "Workspace setup result unavailable",
      ));
    }
    let accepted = run.accepted.as_ref().ok_or_else(unavailable)?;
    if receipt.state == crate::workspace::ProjectStarterState::Complete {
      if views.iter().any(|view| view.result.is_none() || !view.available) {
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_RUN_NOT_RETRYABLE,
          "Workspace setup result unavailable",
        ));
      }
      let count = workspace_setup_stage_count(&accepted.definition)?;
      for position in 0..count {
        let node = format!("action:{position}");
        let effect = repo.get_effect(run.id, &node, "apply").await?.ok_or_else(unavailable)?;
        if effect.result_json.is_none()
          || effect.input_fingerprint != effect_input_fingerprint(accepted, &node, "apply")?
        {
          return Err(unavailable());
        }
      }
      return Ok(());
    }
    if receipt.state != crate::workspace::ProjectStarterState::Accepted {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_RUN_NOT_RETRYABLE,
        "Workspace setup is stopped",
      ));
    }
    let plan = self
      .packages
      .bind_workspace_setup(&receipt)
      .await
      .map_err(super::workflows::context_database_error)?;
    if !plan.execution_available {
      return Err(unavailable());
    }
    Ok(())
  }
  pub(crate) async fn execute_workspace_setup(
    &self,
    repo: &Arc<dyn WorkspaceAutomationRepository>,
    invocation: AutomationEffectInvocation,
    run: &WorkspaceAutomationRun,
    accepted: &AcceptedAutomationRun,
  ) -> RuntimeResult<AutomationEffectResult> {
    let mut receipt = self.workspace_setup_receipt(run).await?;
    let origin = accepted.workspace_setup.as_ref().ok_or_else(unavailable)?;
    let envelope = invocation
      .setup
      .as_ref()
      .filter(|envelope| {
        envelope.format_version == 1
          && envelope.request_id == origin.request_id
          && envelope.fingerprint == origin.fingerprint
      })
      .ok_or_else(unavailable)?;
    let position = invocation
      .node_key
      .strip_prefix("action:")
      .and_then(|value| value.parse::<usize>().ok())
      .filter(|position| invocation.node_key == format!("action:{position}"))
      .ok_or_else(unavailable)?;
    workspace_setup_stage_count(&accepted.definition)?;
    let stages = &accepted.definition.workflow.as_ref().ok_or_else(unavailable)?.stages;
    let stage = stages.get(position).ok_or_else(unavailable)?.clone();
    let views = self
      .packages
      .workspace_setup_views(&receipt)
      .await
      .map_err(super::workflows::context_database_error)?;
    if views.iter().any(|view| view.result.is_some() && !view.available) {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_RUN_NOT_RETRYABLE,
        "Workspace setup result unavailable",
      ));
    }
    if let ContextDocumentWorkflowStage::PlaceNativeLink { component } = &stage {
      let target = receipt
        .original
        .components
        .iter()
        .find_map(|native| match &native.action {
          AssistantNativeAction::PlaceNativeLink {
            target: AssistantValueBinding::Result { component: target, .. },
            ..
          } if native.id == *component => Some(target),
          _ => None,
        })
        .ok_or_else(unavailable)?;
      let producer=stages.iter().take(position).position(|stage|matches!(stage,ContextDocumentWorkflowStage::CreateWorkingDocument{component}|ContextDocumentWorkflowStage::CreateDatabaseFromDefinition{component} if component==target)).ok_or_else(unavailable)?;
      let node = format!("action:{producer}");
      let prior = envelope.results.get(&node).ok_or_else(unavailable)?;
      let WorkspaceSetupStageResult::Component { component_id, result } = prior else {
        return Err(unavailable());
      };
      if component_id != target
        || receipt
          .progress
          .results
          .get(target)
          .is_none_or(|expected| serde_json::to_value(expected).ok() != serde_json::to_value(result).ok())
      {
        return Err(unavailable());
      }
      let effect = repo.get_effect(run.id, &node, "apply").await?.ok_or_else(unavailable)?;
      if effect.result_json != Some(serde_json::to_value(prior).map_err(|_| unavailable())?) {
        return Err(unavailable());
      }
    }
    if let Some(effect) = repo
      .get_effect(run.id, &invocation.node_key, &invocation.effect_key)
      .await?
    {
      if effect.input_fingerprint != invocation.input_fingerprint {
        return Err(unavailable());
      }
      if let Some(result) = effect.result_json {
        return Ok(AutomationEffectResult {
          action_id: effect.action_id,
          result,
        });
      }
    }
    if receipt.state != crate::workspace::ProjectStarterState::Accepted {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_RUN_NOT_RETRYABLE,
        "Workspace setup no longer active",
      ));
    }
    let plan = self
      .packages
      .bind_workspace_setup(&receipt)
      .await
      .map_err(super::workflows::context_database_error)?;
    if !plan.execution_available {
      return Err(unavailable());
    }
    receipt = self
      .store
      .bind_workspace_setup(&receipt, plan)
      .await
      .map_err(setup_error)?;
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
    let write = match stage {
      ContextDocumentWorkflowStage::Folder => self
        .packages
        .place_workspace_setup(&receipt, crate::workspace::ProjectPlacementStage::Folder, fence)
        .await
        .map_err(setup_document_error),
      ContextDocumentWorkflowStage::CreateWorkingDocument { component } => self
        .packages
        .create_workspace_setup_document(&receipt, &component, fence)
        .await
        .map_err(setup_document_error),
      ContextDocumentWorkflowStage::CreateDatabaseFromDefinition { component } => {
        let state = self
          .packages
          .materialize_workspace_setup_database(&receipt, &component)
          .await
          .map_err(super::workflows::context_database_error)?;
        self
          .store
          .publish_workspace_setup_database(&receipt, &component, state, fence)
          .await
          .map_err(setup_error)
      }
      ContextDocumentWorkflowStage::PlaceNativeLink { component } => self
        .packages
        .place_workspace_setup(
          &receipt,
          crate::workspace::ProjectPlacementStage::NativeLink {
            component_id: component,
          },
          fence,
        )
        .await
        .map_err(setup_document_error),
      ContextDocumentWorkflowStage::Complete => self
        .store
        .finish_workspace_setup(&receipt, fence)
        .await
        .map_err(setup_error),
      _ => return Err(unavailable()),
    };
    if let Some(result) = repo
      .get_effect(run.id, &invocation.node_key, &invocation.effect_key)
      .await?
      .and_then(|effect| effect.result_json)
    {
      return Ok(AutomationEffectResult {
        action_id: effect.action_id,
        result,
      });
    }
    write?;
    Err(unavailable())
  }
}
