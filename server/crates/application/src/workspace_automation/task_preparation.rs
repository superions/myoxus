// SPDX-License-Identifier: AGPL-3.0-or-later
//! Explicit personal configuration remains an ordinary native automation rule.
use super::*;
use myoxus_domain::{assistant_package::*, permission::*, workspace_automation::*};
use std::collections::BTreeMap;
fn invalid() -> WorkspaceAutomationServiceError {
  WorkspaceAutomationServiceError::new(
    ERR_AUTOMATION_RUN_NOT_RETRYABLE,
    "Personal task preparation unavailable",
  )
}
pub fn task_preparation_digest(plan: &PreparedTaskPreparation) -> WorkspaceAutomationResult<String> {
  Ok(format!(
    "{:x}",
    Sha256::digest(serde_json::to_vec(plan).map_err(|_| invalid())?)
  ))
}
impl WorkspaceAutomationService {
  #[instrument(skip_all)]
  pub async fn prepare_task_preparation(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: u32,
  ) -> WorkspaceAutomationResult<PreparedTaskPreparation> {
    let native = self.context_documents.as_ref().ok_or_else(runtime::unavailable)?;
    let assistance = native
      .auth
      .get_assistance(actor, Some(workspace), Some(target.database_id))
      .await
      .map_err(|_| runtime::unavailable())?;
    let role = self
      .permission
      .get_effective_workspace_role(actor, workspace)
      .await
      .map_err(|_| runtime::unavailable())?;
    if !role.is_some_and(|role| role.can(WorkspaceAction::CreateDoc)) {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_FORBIDDEN,
        "Personal preparation permission unavailable",
      ));
    }
    let mut plan = native
      .packages
      .prepare_task_preparation(actor, workspace, target, identity, answers, locale, client_version)
      .await
      .map_err(|error| {
        if error.is_retryable_storage_failure() {
          runtime::unavailable()
        } else {
          invalid()
        }
      })?;
    plan.execution_available &=
      self.limits.enabled && self.runtime.is_some() && assistance.mode == crate::auth::AssistanceMode::Automatic;
    Ok(plan)
  }
  #[instrument(skip_all)]
  pub async fn configure_task_preparation(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    input: TaskPreparationConfigurationInput,
  ) -> WorkspaceAutomationResult<WorkspaceAutomation> {
    if input.rule_id.is_some() != input.expected_execution_revision.is_some() {
      return Err(invalid());
    }
    if !input.enabled {
      let existing = self
        .get_task_preparation(actor, workspace, target.database_id)
        .await?
        .ok_or_else(invalid)?;
      if input.rule_id != Some(existing.id) || input.expected_execution_revision != Some(existing.execution_revision) {
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_IDEMPOTENCY_CONFLICT,
          "Personal preparation configuration changed",
        ));
      }
      let mut rule = existing;
      rule.status = WorkspaceAutomationStatus::Disabled;
      rule.updated_by = Some(actor);
      return self
        .repo
        .configure_personal_automation(rule, input.expected_execution_revision)
        .await
        .map_err(Into::into);
    }
    let plan = self
      .prepare_task_preparation(
        actor,
        workspace,
        target,
        &input.package,
        input.answers,
        &input.locale,
        input.client_version,
      )
      .await?;
    if !plan.execution_available || task_preparation_digest(&plan)? != input.plan_digest {
      return Err(invalid());
    }
    let now = Utc::now();
    let rule = WorkspaceAutomation {
      id: input.rule_id.unwrap_or_else(Uuid::new_v4),
      workspace_id: workspace,
      name: plan.package.id.clone(),
      description: None,
      status: WorkspaceAutomationStatus::Enabled,
      trigger: WorkspaceAutomationTrigger {
        trigger_type: WorkspaceAutomationTriggerType::RowCreated,
        database_id: plan.target.database_id,
        field_id: None,
        select_option_id: None,
      },
      actions: vec![WorkspaceAutomationActionDefinition {
        position: 0,
        config: WorkspaceAutomationActionConfig::CreateLinkedDocument {
          title_template: "{{rowId}}".into(),
          relation_field_id: None,
          source: Some(plan.source),
        },
      }],
      personal_config: Some(PersonalAutomationConfig {
        plan_digest: input.plan_digest,
        actor_id: actor,
        database_id: plan.target.database_id,
        confirmed_mode: ConfirmedAutomaticMode::Automatic,
        package: plan.package,
        workflow: plan.workflow,
        answers: plan.answers,
        locale: plan.locale,
        client_version: plan.client_version,
      }),
      execution_revision: 1,
      created_by: Some(actor),
      updated_by: Some(actor),
      created_at: now,
      updated_at: now,
    };
    self
      .repo
      .configure_personal_automation(rule, input.expected_execution_revision)
      .await
      .map_err(Into::into)
  }
  #[instrument(skip_all)]
  pub async fn get_task_preparation(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    database: DatabaseId,
  ) -> WorkspaceAutomationResult<Option<WorkspaceAutomation>> {
    let role = self
      .permission
      .get_effective_workspace_role(actor, workspace)
      .await
      .map_err(|_| runtime::unavailable())?;
    if !role.is_some_and(|role| role.can(WorkspaceAction::Read)) {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_FORBIDDEN,
        "Personal configuration unavailable",
      ));
    }
    self
      .repo
      .get_personal_automation(actor, workspace, database, WorkspaceAutomationTriggerType::RowCreated)
      .await
      .map_err(Into::into)
  }
}
impl WorkspaceAutomationService {
  #[instrument(skip_all)]
  pub async fn prepare_task_maintenance_rule(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: u32,
  ) -> WorkspaceAutomationResult<PreparedTaskMaintenance> {
    let mut plan = self
      .prepare_task_maintenance(actor, workspace, target, identity, answers, locale, client_version)
      .await?;
    if plan.workflow.source.trigger != Some(AssistantWorkflowTrigger::TaskChanged) {
      return Err(invalid());
    }
    let native = self.context_documents.as_ref().ok_or_else(runtime::unavailable)?;
    let mode = native
      .auth
      .get_assistance(actor, Some(workspace), Some(plan.target.database_id))
      .await
      .map_err(|_| runtime::unavailable())?;
    plan.execution_available = native.packages.context_workflows_enabled()
      && self.limits.enabled
      && self.runtime.is_some()
      && mode.mode == crate::auth::AssistanceMode::Automatic;
    Ok(plan)
  }
  #[instrument(skip_all)]
  pub async fn configure_task_maintenance(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    input: TaskPreparationConfigurationInput,
  ) -> WorkspaceAutomationResult<WorkspaceAutomation> {
    if input.rule_id.is_some() != input.expected_execution_revision.is_some() {
      return Err(invalid());
    }
    if !input.enabled {
      let mut rule = self
        .get_task_maintenance_rule(actor, workspace, target.database_id)
        .await?
        .ok_or_else(invalid)?;
      if input.rule_id != Some(rule.id) || input.expected_execution_revision != Some(rule.execution_revision) {
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_IDEMPOTENCY_CONFLICT,
          "Personal maintenance configuration changed",
        ));
      }
      rule.status = WorkspaceAutomationStatus::Disabled;
      rule.updated_by = Some(actor);
      return self
        .repo
        .configure_personal_automation(rule, input.expected_execution_revision)
        .await
        .map_err(Into::into);
    }
    let plan = self
      .prepare_task_maintenance_rule(
        actor,
        workspace,
        target,
        &input.package,
        input.answers,
        &input.locale,
        input.client_version,
      )
      .await?;
    if !plan.execution_available || super::maintenance::task_maintenance_digest(&plan)? != input.plan_digest {
      return Err(invalid());
    }
    let now = Utc::now();
    self
      .repo
      .configure_personal_automation(
        WorkspaceAutomation {
          id: input.rule_id.unwrap_or_else(Uuid::new_v4),
          workspace_id: workspace,
          name: plan.package.id.clone(),
          description: None,
          status: WorkspaceAutomationStatus::Enabled,
          trigger: WorkspaceAutomationTrigger {
            trigger_type: WorkspaceAutomationTriggerType::RowUpdated,
            database_id: plan.target.database_id,
            field_id: None,
            select_option_id: None,
          },
          actions: Vec::new(),
          personal_config: Some(PersonalAutomationConfig {
            plan_digest: input.plan_digest,
            actor_id: actor,
            database_id: plan.target.database_id,
            confirmed_mode: ConfirmedAutomaticMode::Automatic,
            package: plan.package,
            workflow: plan.workflow,
            answers: plan.answers,
            locale: plan.locale,
            client_version: plan.client_version,
          }),
          execution_revision: 1,
          created_by: Some(actor),
          updated_by: Some(actor),
          created_at: now,
          updated_at: now,
        },
        input.expected_execution_revision,
      )
      .await
      .map_err(Into::into)
  }
  #[instrument(skip_all)]
  pub async fn get_task_maintenance_rule(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    database: DatabaseId,
  ) -> WorkspaceAutomationResult<Option<WorkspaceAutomation>> {
    self.assert_workspace_read(actor, workspace).await?;
    self
      .repo
      .get_personal_automation(actor, workspace, database, WorkspaceAutomationTriggerType::RowUpdated)
      .await
      .map_err(Into::into)
  }
}
impl WorkspaceAutomationService {
  pub(crate) async fn prepare_personal_event(
    &self,
    rule: &WorkspaceAutomation,
    event: &WorkspaceAutomationTriggerEvent,
    run_id: Uuid,
    policy: AutomationExecutionPolicy,
  ) -> WorkspaceAutomationResult<
    Option<(
      AcceptedAutomationDefinition,
      Option<AcceptedTaskMaintenance>,
      AcceptedPersonalAutomation,
    )>,
  > {
    let config = rule.personal_config.as_ref().ok_or_else(invalid)?;
    if rule.status != WorkspaceAutomationStatus::Enabled
      || event.actor_user_id != Some(config.actor_id)
      || event.workspace_id != rule.workspace_id
      || event.database_id != config.database_id
    {
      return Ok(None);
    }
    let native = self.context_documents.as_ref().ok_or_else(runtime::unavailable)?;
    let mode = native
      .auth
      .get_assistance(config.actor_id, Some(rule.workspace_id), Some(config.database_id))
      .await
      .map_err(|_| runtime::unavailable())?;
    if mode.mode != crate::auth::AssistanceMode::Automatic {
      return Ok(None);
    }
    let components = match native.packages.personal_configuration_components(config) {
      Ok(components) => components,
      Err(_) => return Ok(None),
    };
    let row = self.database_row_repo.get_row(event.row_id).await?;
    let Some(row) = row.filter(|row| {
      row.row.database_id == config.database_id
        && row.row.deleted_at.is_none()
        && row.row.row_kind == myoxus_domain::database::DatabaseRowKind::Task
    }) else {
      return Ok(None);
    };
    let (_, installation, _) = native
      .packages
      .context_document_context(
        config.actor_id,
        rule.workspace_id,
        &ContextDocumentTarget {
          database_id: config.database_id,
          task_id: None,
        },
      )
      .await
      .map_err(|error| {
        if error.is_retryable_storage_failure() {
          runtime::unavailable()
        } else {
          invalid()
        }
      })?;
    let proof = AcceptedPersonalAutomation {
      actor_id: config.actor_id,
      database_id: config.database_id,
      execution_revision: rule.execution_revision,
      config: config.clone(),
      installation,
    };
    match config.workflow.source.trigger {
      Some(AssistantWorkflowTrigger::TaskCreated)
        if event.trigger_type == WorkspaceAutomationTriggerType::RowCreated =>
      {
        if row.row.content_document_id.is_some() {
          return Ok(None);
        }
        let mut definition = freeze_definition(rule.actions.clone(), policy)?;
        if definition.actions.len() != 1
          || !matches!(
            &definition.actions[0].config,
            WorkspaceAutomationActionConfig::CreateLinkedDocument {
              source: Some(_),
              relation_field_id: None,
              ..
            }
          )
        {
          return Err(invalid());
        }
        let WorkspaceAutomationActionConfig::CreateLinkedDocument {
          source: Some(source), ..
        } = &definition.actions[0].config
        else {
          return Err(invalid());
        };
        if !native
          .packages
          .personal_document_source_admitted(config, &source.source)
        {
          return Ok(None);
        }
        definition.capability_versions = [("createLinkedDocument".into(), 1)].into();
        definition.workflow = Some(AcceptedNativeWorkflow {
          source: config.workflow.clone(),
          components,
          stages: Vec::new(),
          wait_counts: BTreeMap::new(),
        });
        definition.hash = runtime::definition_hash(&definition)?;
        Ok(Some((definition, None, proof)))
      }
      Some(AssistantWorkflowTrigger::TaskChanged)
        if event.trigger_type == WorkspaceAutomationTriggerType::RowUpdated =>
      {
        let selected = config
          .answers
          .values()
          .find_map(|value| match value {
            AssistantValue::TaskReferences(tasks) => Some(tasks),
            _ => None,
          })
          .ok_or_else(invalid)?;
        if !selected
          .iter()
          .any(|task| task.database_id == event.database_id && task.row_id == event.row_id)
        {
          return Ok(None);
        }
        let plan = self
          .prepare_task_maintenance(
            config.actor_id,
            rule.workspace_id,
            ContextDocumentTarget {
              database_id: config.database_id,
              task_id: None,
            },
            &config.package,
            config.answers.clone(),
            &config.locale,
            config.client_version,
          )
          .await?;
        if plan.proposal.patches.is_empty() {
          return Ok(None);
        }
        let definition = super::maintenance::compile_maintenance_definition(&plan, policy)?;
        let AssistantWorkflowAction::AwaitCorrectionConfirmation { wait_id } = &plan.workflow.source.nodes[1].action
        else {
          return Err(invalid());
        };
        let wait_id = wait_id.clone();
        let fingerprint = format!(
          "{:x}",
          Sha256::digest(
            serde_json::to_vec(&(rule.id, rule.execution_revision, event, &plan.proposal)).map_err(|_| invalid())?
          )
        );
        Ok(Some((
          definition,
          Some(AcceptedTaskMaintenance {
            request_id: run_id,
            fingerprint,
            plan,
            wait_id,
          }),
          proof,
        )))
      }
      _ => Ok(None),
    }
  }
}
impl WorkspaceAutomationService {
  pub(crate) async fn authorize_personal_run(&self, run: &WorkspaceAutomationRun) -> WorkspaceAutomationResult<()> {
    let accepted = run.accepted.as_ref().ok_or_else(invalid)?;
    let Some(proof) = &accepted.personal_rule else {
      return Ok(());
    };
    let rule = self
      .repo
      .get_automation(run.automation_id.ok_or_else(invalid)?)
      .await?
      .ok_or_else(invalid)?;
    if rule.workspace_id != run.workspace_id
      || rule.status != WorkspaceAutomationStatus::Enabled
      || rule.execution_revision != proof.execution_revision
      || serde_json::to_value(&rule.personal_config).map_err(|_| invalid())?
        != serde_json::to_value(Some(&proof.config)).map_err(|_| invalid())?
    {
      return Err(invalid());
    }
    let native = self.context_documents.as_ref().ok_or_else(runtime::unavailable)?;
    let mode = native
      .auth
      .get_assistance(proof.actor_id, Some(run.workspace_id), Some(proof.database_id))
      .await
      .map_err(|error| match error {
        crate::auth::AuthError::Storage(_) => runtime::unavailable(),
        _ => invalid(),
      })?;
    if mode.mode != crate::auth::AssistanceMode::Automatic {
      return Err(invalid());
    }
    for action in &accepted.definition.actions {
      if let WorkspaceAutomationActionConfig::CreateLinkedDocument {
        source: Some(source), ..
      } = &action.config
      {
        let committed = self
          .repo
          .get_effect(run.id, &format!("action:{}", action.position), "apply")
          .await?
          .is_some_and(|effect| effect.result_json.is_some());
        if !committed {
          let (_, registry) = native
            .packages
            .automation_document_services()
            .ok_or_else(runtime::unavailable)?;
          registry
            .capture_accepted_document_revision(
              &source.source,
              source.source_revision_id,
              &source.source_revision_digest,
              &source.source_content_digest,
              &source.locale,
              proof.config.client_version,
            )
            .await
            .map_err(|error| match error {
              crate::auth::AuthError::Storage(_) => runtime::unavailable(),
              _ => invalid(),
            })?;
        }
      }
    }
    Ok(())
  }
}

/// Readback of one personal preparation Run. The document is exposed only
/// after its atomic native ACK and current Task/Doc authorization checks.
#[derive(Debug, Clone)]
pub struct TaskPreparationRunView {
  pub run: WorkspaceAutomationRun,
  pub target: AssistantTaskReference,
  pub document_id: Option<Uuid>,
  pub document_external_id: Option<String>,
  pub can_retry: bool,
  pub can_stop: bool,
}

fn task_preparation_run_trigger(
  run: &WorkspaceAutomationRun,
) -> WorkspaceAutomationResult<&WorkspaceAutomationTriggerEvent> {
  let accepted = run.accepted.as_ref().ok_or_else(invalid)?;
  let proof = accepted.personal_rule.as_ref().ok_or_else(invalid)?;
  let trigger = accepted.trigger.as_ref().ok_or_else(invalid)?;
  if !matches!(run.origin, WorkspaceAutomationRunOrigin::Rule)
    || accepted.run_id != run.id
    || accepted.workspace_id != run.workspace_id
    || accepted.automation_id != run.automation_id
    || accepted.actor_id != Some(proof.actor_id)
    || proof.config.actor_id != proof.actor_id
    || proof.config.database_id != trigger.database_id
    || proof.database_id != trigger.database_id
    || trigger.workspace_id != run.workspace_id
    || trigger.actor_user_id != Some(proof.actor_id)
    || trigger.trigger_type != WorkspaceAutomationTriggerType::RowCreated
    || proof.config.workflow.source.trigger != Some(AssistantWorkflowTrigger::TaskCreated)
    || accepted.task_maintenance.is_some()
    || accepted.document_review.is_some()
    || accepted.task_handover.is_some()
    || accepted.confirmed_request.is_some()
    || accepted.definition.actions.len() != 1
    || accepted.definition.actions[0].position != 0
    || !matches!(
      &accepted.definition.actions[0].config,
      WorkspaceAutomationActionConfig::CreateLinkedDocument {
        source: Some(_),
        relation_field_id: None,
        ..
      }
    )
  {
    return Err(invalid());
  }
  Ok(trigger)
}

impl WorkspaceAutomationService {
  #[instrument(skip_all, fields(run_id = %run_id))]
  pub async fn get_task_preparation_run(
    &self,
    actor: UserId,
    run_id: Uuid,
  ) -> WorkspaceAutomationResult<Option<TaskPreparationRunView>> {
    let Some(run) = self.repo.get_run(run_id).await? else {
      return Ok(None);
    };
    self.task_preparation_run_view(actor, run).await.map(Some)
  }

  #[instrument(skip_all, fields(run_id = %run_id))]
  pub async fn retry_task_preparation_run(
    &self,
    actor: UserId,
    run_id: Uuid,
  ) -> WorkspaceAutomationResult<TaskPreparationRunView> {
    let run = self.repo.get_run(run_id).await?.ok_or_else(invalid)?;
    task_preparation_run_trigger(&run)?;
    self.retry_run(actor, run_id).await?;
    self.get_task_preparation_run(actor, run_id).await?.ok_or_else(invalid)
  }

  #[instrument(skip_all, fields(run_id = %run_id))]
  pub async fn stop_task_preparation_run(
    &self,
    actor: UserId,
    run_id: Uuid,
  ) -> WorkspaceAutomationResult<TaskPreparationRunView> {
    let run = self.repo.get_run(run_id).await?.ok_or_else(invalid)?;
    task_preparation_run_trigger(&run)?;
    self.stop_run(actor, run_id).await?;
    self.get_task_preparation_run(actor, run_id).await?.ok_or_else(invalid)
  }

  pub(crate) async fn authorize_task_preparation_retry(
    &self,
    actor: UserId,
    run: &WorkspaceAutomationRun,
  ) -> WorkspaceAutomationResult<()> {
    if !self.task_preparation_run_view(actor, run.clone()).await?.can_retry {
      return Err(invalid());
    }
    Ok(())
  }

  async fn task_preparation_run_view(
    &self,
    actor: UserId,
    run: WorkspaceAutomationRun,
  ) -> WorkspaceAutomationResult<TaskPreparationRunView> {
    let trigger = task_preparation_run_trigger(&run)?;
    let accepted = run.accepted.as_ref().ok_or_else(invalid)?;
    let proof = accepted.personal_rule.as_ref().ok_or_else(invalid)?;
    self.assert_workspace_read(actor, run.workspace_id).await?;
    let can_control = match self.authorize_run_control(actor, &run).await {
      Ok(()) => true,
      Err(error) if error.code == ERR_AUTOMATION_FORBIDDEN => false,
      Err(error) => return Err(error),
    };
    if actor != proof.actor_id && !can_control {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_FORBIDDEN,
        "Personal preparation Run unavailable",
      ));
    }
    let mut target = AssistantTaskReference {
      database_id: trigger.database_id,
      row_id: trigger.row_id,
    };
    let row = self.database_row_repo.get_row(trigger.row_id).await?;
    let row = row
      .filter(|row| row.row.deleted_at.is_none() && row.row.row_kind == myoxus_domain::database::DatabaseRowKind::Task);
    let mut target_available = false;
    if let Some(row) = &row {
      let database = self.database_schema_repo.get_database(row.row.database_id).await?;
      target_available = database.is_some_and(|database| {
        database.database.workspace_id == run.workspace_id
          && database.database.deleted_at.is_none()
          && database
            .managed_schema
            .as_ref()
            .is_some_and(|schema| schema.readiness == myoxus_domain::database::DatabaseManagedSchemaReadiness::Ready)
      });
      if target_available {
        target.database_id = row.row.database_id;
      }
    }
    let effect = self.repo.get_effect(run.id, "action:0", "apply").await?;
    let mut committed = false;
    let mut document_id = None;
    let mut document_external_id = None;
    if let Some(effect) = &effect {
      if effect.input_fingerprint != runtime::effect_input_fingerprint(accepted, "action:0", "apply")? {
        return Err(invalid());
      }
      if let Some(result) = &effect.result_json {
        if effect.status != WorkspaceAutomationActionStatus::Succeeded
          || result
            .get("doc_id")
            .and_then(serde_json::Value::as_str)
            .and_then(|id| Uuid::parse_str(id).ok())
            != Some(effect.reserved_id)
          || result
            .get("workspace_id")
            .and_then(serde_json::Value::as_str)
            .and_then(|id| Uuid::parse_str(id).ok())
            != Some(run.workspace_id)
        {
          return Err(invalid());
        }
        committed = true;
        if target_available
          && row
            .as_ref()
            .is_some_and(|row| row.row.content_document_id == Some(effect.reserved_id))
        {
          let doc = self
            .doc_service
            .get_metadata(effect.reserved_id)
            .await
            .map_err(|_| runtime::unavailable())?;
          if let Some(doc) = doc.filter(|doc| {
            doc.workspace_id == Some(run.workspace_id)
              && doc.deleted_at.is_none()
              && !doc.blocked
              && !doc.is_workspace_root
          }) {
            match self
              .permission
              .assert(
                &crate::permission::DocResource {
                  user_id: actor,
                  workspace_id: run.workspace_id,
                  doc_id: effect.reserved_id,
                },
                DocAction::Read,
              )
              .await
            {
              Ok(()) => {
                document_id = Some(effect.reserved_id);
                document_external_id = Some(doc.external_id);
              }
              Err(crate::auth::AuthError::Storage(_)) => return Err(runtime::unavailable()),
              Err(_) => {}
            }
          }
        }
      }
    }
    let mut can_retry = self.limits.enabled
      && self.runtime.is_some()
      && self
        .context_documents
        .as_ref()
        .is_some_and(|native| native.packages.context_workflows_enabled())
      && can_control
      && workflows::confirmed_run_retryable(&run)
      && target_available
      && if committed {
        document_id.is_some()
      } else {
        target.database_id == trigger.database_id
          && row.as_ref().is_some_and(|row| row.row.content_document_id.is_none())
          && effect.as_ref().is_none_or(|effect| {
            effect.status == WorkspaceAutomationActionStatus::Running
              && effect.expected_edit_revision == row.as_ref().map(|row| row.row.edit_revision)
          })
      };
    if can_retry {
      let initiator = self
        .permission
        .get_effective_workspace_role(proof.actor_id, run.workspace_id)
        .await
        .map_err(|_| runtime::unavailable())?;
      can_retry = initiator.is_some_and(|role| role.can(WorkspaceAction::CreateDoc));
      if can_retry {
        can_retry = match self.authorize_personal_run(&run).await {
          Ok(()) => true,
          Err(error)
            if matches!(
              error.code,
              ERR_AUTOMATION_FORBIDDEN | ERR_AUTOMATION_RUN_NOT_RETRYABLE | ERR_AUTOMATION_NOT_FOUND
            ) =>
          {
            false
          }
          Err(error) => return Err(error),
        };
      }
    }
    let can_stop = can_control
      && matches!(
        run.status,
        WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
      );
    Ok(TaskPreparationRunView {
      run,
      target,
      document_id,
      document_external_id,
      can_retry,
      can_stop,
    })
  }
}
