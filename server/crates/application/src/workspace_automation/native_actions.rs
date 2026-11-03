// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native actions validate authority before entering guarded transactional writers.
use super::runtime::*;
use super::*;
use crate::permission::DocResource;
use async_trait::async_trait;
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use myoxus_domain::{database::DatabaseFieldType, workspace_automation::*};

#[derive(Clone)]
pub struct WorkspaceAutomationNativeActions {
  repo: Arc<dyn WorkspaceAutomationRepository>,
  database_schema_repo: Arc<dyn myoxus_domain::database::DatabaseDefinitionRepository>,
  database_row_repo: Arc<dyn myoxus_domain::database::DatabaseEditingRepository>,
  doc_service: DocService,
  permission: Arc<PermissionService>,
  webhook: Option<Arc<dyn WorkspaceAutomationWebhookPort>>,
  editing: Arc<crate::database::DatabaseEditingService>,
  audit: AuditRecorder,
  context_documents: Option<Arc<super::workflows::ContextDocumentActions>>,
}
impl WorkspaceAutomationNativeActions {
  #[allow(clippy::too_many_arguments)]
  pub fn new(
    repo: Arc<dyn WorkspaceAutomationRepository>,
    schema: Arc<dyn myoxus_domain::database::DatabaseDefinitionRepository>,
    rows: Arc<dyn myoxus_domain::database::DatabaseEditingRepository>,
    docs: DocService,
    permission: Arc<PermissionService>,
    webhook: Option<Arc<dyn WorkspaceAutomationWebhookPort>>,
    editing: Arc<crate::database::DatabaseEditingService>,
    audit: AuditRecorder,
    context_documents: Option<Arc<super::workflows::ContextDocumentActions>>,
  ) -> Self {
    Self {
      repo,
      database_schema_repo: schema,
      database_row_repo: rows,
      doc_service: docs,
      permission,
      webhook,
      editing,
      audit,
      context_documents,
    }
  }
  async fn assert_actor(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    action: WorkspaceAction,
  ) -> WorkspaceAutomationResult<()> {
    self
      .permission
      .assert(
        &WorkspaceResource {
          user_id: actor,
          workspace_id: workspace,
        },
        action,
      )
      .await
      .map_err(|_| {
        WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "automation target permission denied")
      })
  }
}
struct NativeExecution<'a> {
  actions: &'a WorkspaceAutomationNativeActions,
  receipt: WorkspaceAutomationEffectReceipt,
  fence: AutomationEffectFence,
  accepted: AcceptedAutomationRun,
}
impl std::ops::Deref for NativeExecution<'_> {
  type Target = WorkspaceAutomationNativeActions;
  fn deref(&self) -> &Self::Target {
    self.actions
  }
}
impl NativeExecution<'_> {
  async fn execute_notify_webhook(
    &self,
    run: &WorkspaceAutomationRun,
    action_id: myoxus_domain::ids::WorkspaceAutomationActionId,
    config: &WorkspaceAutomationActionConfig,
  ) -> WorkspaceAutomationResult<serde_json::Value> {
    let WorkspaceAutomationActionConfig::NotifyWebhook { url, secret_ref } = config else {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_ACTION_INVALID,
        "notify webhook action config kind mismatch",
      ));
    };
    let Some(webhook) = &self.webhook else {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_WEBHOOK_FAILED,
        "workspace automation webhook client is not configured",
      ));
    };
    let trigger = run.trigger_event.as_ref().ok_or_else(unavailable)?;
    let event_json = serde_json::to_value(trigger).map_err(|_| {
      WorkspaceAutomationServiceError::new(ERR_AUTOMATION_RUN_FAILED, "automation webhook event encoding failed")
    })?;
    let payload = WorkspaceAutomationWebhookPayload {
      workspace_id: run.workspace_id.to_string(),
      automation_id: run.automation_id.ok_or_else(unavailable)?.to_string(),
      run_id: run.id.to_string(),
      action_id: action_id.to_string(),
      trigger_type: run.trigger_type.ok_or_else(unavailable)?.as_str().to_string(),
      event: event_json,
    };
    let secret_ref = if let Some(expected) = secret_ref {
      let rule = self
        .repo
        .get_automation(run.automation_id.ok_or_else(unavailable)?)
        .await?
        .ok_or_else(|| {
          WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "webhook signing source unavailable")
        })?;
      let actual = rule
        .actions
        .iter()
        .find(|action| action.position == self.receipt.position)
        .and_then(|action| match &action.config {
          WorkspaceAutomationActionConfig::NotifyWebhook { secret_ref, .. } => secret_ref.clone(),
          _ => None,
        })
        .ok_or_else(|| {
          WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "webhook signing source unavailable")
        })?;
      if format!("sha256:{:x}", Sha256::digest(actual.as_bytes())) != *expected {
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_FORBIDDEN,
          "webhook signing source changed",
        ));
      }
      Some(actual)
    } else {
      None
    };
    let request = WorkspaceAutomationWebhookRequest::new(
      url.clone(),
      payload,
      secret_ref,
      self.accepted.definition.policy.webhook_timeout_seconds,
    )
    .map_err(|_| {
      WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_WEBHOOK_FAILED,
        "automation webhook request preparation failed",
      )
    })?;
    // A concurrent success wins here. Only one admitted HTTP attempt follows;
    // an unknown external response can still require at-least-once redelivery.
    if let Some(result) = self.repo.authorize_webhook_dispatch(self.fence).await? {
      return Ok(result);
    }
    let delivered = match webhook.deliver(request).await {
      Ok(response) if (200..300).contains(&response.status) => response,
      result => {
        let status = match result {
          Ok(response) => Some(response.status),
          Err(error) => error.status,
        };
        // Never retain transport errors: they can contain URLs or private data.
        let summary = match status {
          Some(status) => format!("Automation webhook returned HTTP {status}"),
          None => "Automation webhook transport failed".to_string(),
        };
        self
          .repo
          .record_webhook_failure(self.fence, status.map(i32::from), summary.clone())
          .await?;
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_WEBHOOK_FAILED,
          summary,
        ));
      }
    };
    let result = json!({"delivery_id":action_id,"status":delivered.status});
    self.repo.finish_webhook_effect(self.fence, result.clone()).await?;
    Ok(result)
  }

  async fn execute_create_row(
    &self,
    run: &WorkspaceAutomationRun,
    config: &WorkspaceAutomationActionConfig,
  ) -> WorkspaceAutomationResult<serde_json::Value> {
    let WorkspaceAutomationActionConfig::CreateRow {
      database_id,
      title_template,
      cells,
    } = config
    else {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_ACTION_INVALID,
        "create row action config kind mismatch",
      ));
    };
    let actor = run
      .trigger_event
      .as_ref()
      .and_then(|event| event.actor_user_id)
      .ok_or_else(|| {
        WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_FORBIDDEN,
          "create row automation action requires a user actor",
        )
      })?;
    let title = render_title_template(title_template.as_deref().unwrap_or("Automated row"), run)?;
    let row = self
      .editing
      .create_automation_row(
        actor,
        *database_id,
        run.workspace_id,
        self.receipt.reserved_id,
        title,
        cells.iter().map(|cell| (cell.field_id, cell.value.clone())).collect(),
        self.fence,
      )
      .await
      .map_err(|error| WorkspaceAutomationServiceError::new(error.code, error.message))?;
    Ok(json!({
      "row_id": row.row.id,
      "content_document_id": row.row.content_document_id,
      "database_id": row.row.database_id,
    }))
  }

  async fn execute_update_cell(
    &self,
    run: &WorkspaceAutomationRun,
    config: &WorkspaceAutomationActionConfig,
  ) -> WorkspaceAutomationResult<serde_json::Value> {
    let WorkspaceAutomationActionConfig::UpdateCell {
      row_id,
      field_id,
      value,
    } = config
    else {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_ACTION_INVALID,
        "update cell action config kind mismatch",
      ));
    };
    let actor = run
      .trigger_event
      .as_ref()
      .and_then(|event| event.actor_user_id)
      .ok_or_else(|| {
        WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_FORBIDDEN,
          "update cell automation action requires a user actor",
        )
      })?;
    let row =
      self.database_row_repo.get_row(*row_id).await?.ok_or_else(|| {
        WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "automation target unavailable")
      })?;
    let expected = self.receipt.expected_edit_revision.ok_or_else(unavailable)?;
    let updated = self
      .editing
      .update_automation_cell(
        actor,
        run.workspace_id,
        row.row.database_id,
        *row_id,
        *field_id,
        value.clone(),
        expected,
        self.fence,
      )
      .await
      .map_err(|error| WorkspaceAutomationServiceError::new(error.code, error.message))?;
    Ok(json!({ "row_id": updated.row_id, "field_id": updated.field_id }))
  }

  async fn execute_create_linked_document(
    &self,
    run: &WorkspaceAutomationRun,
    config: &WorkspaceAutomationActionConfig,
  ) -> WorkspaceAutomationResult<serde_json::Value> {
    let WorkspaceAutomationActionConfig::CreateLinkedDocument {
      title_template,
      relation_field_id,
      source,
    } = config
    else {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_ACTION_INVALID,
        "create linked document action config kind mismatch",
      ));
    };
    if let Some(setup) = source {
      let proof = self.accepted.personal_rule.as_ref().ok_or_else(unavailable)?;
      let actor = self.accepted.actor_id.ok_or_else(unavailable)?;
      let trigger = self.accepted.trigger.as_ref().ok_or_else(unavailable)?;
      let row = self
        .database_row_repo
        .get_row(trigger.row_id)
        .await?
        .filter(|row| {
          row.row.database_id == trigger.database_id
            && row.row.deleted_at.is_none()
            && row.row.row_kind == myoxus_domain::database::DatabaseRowKind::Task
        })
        .ok_or_else(|| {
          WorkspaceAutomationServiceError::new(ERR_AUTOMATION_RUN_NOT_RETRYABLE, "Task content owner unavailable")
        })?;
      let native = self.context_documents.as_ref().ok_or_else(unavailable)?;
      let (documents, registry) = native.packages.automation_document_services().ok_or_else(unavailable)?;
      let doc = documents
        .create_automation_row_body(
          registry,
          actor,
          run.workspace_id,
          setup,
          crate::doc::AutomationRowContentTarget {
            database_id: trigger.database_id,
            row_id: trigger.row_id,
            expected_edit_revision: self.receipt.expected_edit_revision.ok_or_else(unavailable)?,
          },
          row.row.title,
          self.receipt.reserved_id,
          self.fence,
          proof.config.client_version,
        )
        .await
        .map_err(|error| match error {
          crate::document_template::DocumentTemplateError::Repository(RepositoryError::Storage(_)) => unavailable(),
          crate::document_template::DocumentTemplateError::Forbidden => {
            WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "Task content permission unavailable")
          }
          _ => {
            WorkspaceAutomationServiceError::new(ERR_AUTOMATION_RUN_NOT_RETRYABLE, "Task content source unavailable")
          }
        })?;
      return Ok(json!({"doc_id":doc.id,"workspace_id":doc.workspace_id}));
    }
    if relation_field_id.is_some() {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_ACTION_INVALID,
        "relation linking for created documents requires a relation action",
      ));
    }
    let actor = run
      .trigger_event
      .as_ref()
      .and_then(|event| event.actor_user_id)
      .ok_or_else(|| {
        WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_FORBIDDEN,
          "create linked document automation action requires a user actor",
        )
      })?;
    let title = render_title_template(title_template, run)?;
    let doc = self
      .doc_service
      .create_automation_page(
        run.workspace_id,
        actor,
        self.receipt.reserved_id,
        title,
        None,
        self.fence,
      )
      .await
      .map_err(|error| WorkspaceAutomationServiceError::new(ERR_AUTOMATION_RUN_FAILED, error.to_string()))?;
    Ok(json!({ "doc_id": doc.id, "workspace_id": doc.workspace_id }))
  }
}
fn render_title_template(template: &str, run: &WorkspaceAutomationRun) -> WorkspaceAutomationResult<String> {
  let trigger = run.trigger_event.as_ref().ok_or_else(unavailable)?;
  let rendered = template
    .replace("{{rowId}}", &trigger.row_id.to_string())
    .replace("{{databaseId}}", &trigger.database_id.to_string())
    .replace("{{automationRunId}}", &run.id.to_string());
  let trimmed = rendered.trim();
  if trimmed.is_empty() {
    Ok("Automated document".to_string())
  } else {
    Ok(trimmed.to_string())
  }
}

#[async_trait]
impl WorkspaceAutomationNativeExecutor for WorkspaceAutomationNativeActions {
  #[tracing::instrument(skip_all)]
  async fn synchronize_status(&self, status: AutomationRuntimeStatus) -> RuntimeResult<()> {
    if let Some(run) = self
      .repo
      .synchronize_runtime_status(status.run_id, status.status, status.reason_code)
      .await?
    {
      audit_run_finished(&self.audit, &run, None).await;
    }
    Ok(())
  }
  #[tracing::instrument(skip_all)]
  async fn execute(&self, invocation: AutomationEffectInvocation) -> WorkspaceAutomationResult<AutomationEffectResult> {
    let run_id = invocation.run_id;
    let claim = invocation.claim;
    let outcome: WorkspaceAutomationResult<AutomationEffectResult> = async {
      let run =
        self.repo.get_run(invocation.run_id).await?.ok_or_else(|| {
          WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "automation run unavailable")
        })?;
      let accepted = run.accepted.clone().ok_or_else(|| {
        WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_RUN_NOT_RETRYABLE,
          "accepted automation inputs are unavailable",
        )
      })?;
      if accepted.run_id != run.id
        || accepted.automation_id != run.automation_id
        || accepted.workspace_id != run.workspace_id
        || accepted
          .trigger
          .as_ref()
          .is_some_and(|trigger| accepted.actor_id != trigger.actor_user_id)
        || accepted.definition.format_version != 1
        || accepted.definition.runtime_schema_version != 1
        || definition_hash(&accepted.definition)? != accepted.definition.hash
        || effect_input_fingerprint(&accepted, &invocation.node_key, &invocation.effect_key)?
          != invocation.input_fingerprint
      {
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_IDEMPOTENCY_CONFLICT,
          "accepted automation input mismatch",
        ));
      }
      if accepted.recurring_task.is_some() {
        return super::recurring_task::execute(&self.repo, &self.editing, invocation, &run).await;
      }
      if accepted.workspace_setup.is_some()
        || accepted.confirmed_request.is_some()
        || accepted.document_review.is_some()
        || accepted.task_handover.is_some()
        || accepted.task_maintenance.is_some()
      {
        let claim = invocation.claim;
        let result = if accepted.workspace_setup.is_some() {
          self
            .context_documents
            .as_ref()
            .ok_or_else(unavailable)?
            .execute_workspace_setup(&self.repo, invocation, &run, &accepted)
            .await
        } else if accepted.task_maintenance.is_some() {
          super::maintenance::execute_maintenance_task(&self.repo, &self.editing, invocation, &run).await
        } else if accepted.task_handover.is_some() {
          super::handover::execute_handover_task(
            &self.repo,
            &self.editing,
            &self.database_schema_repo,
            invocation,
            &run,
          )
          .await
        } else if accepted.document_review.is_some() {
          super::review::execute_review_task(&self.repo, &self.editing, &self.database_schema_repo, invocation, &run)
            .await
        } else {
          self
            .context_documents
            .as_ref()
            .ok_or_else(unavailable)?
            .execute(&self.repo, invocation, &run, &accepted)
            .await
        };
        if let Err(error) = &result {
          let reason = match error.code {
            ERR_AUTOMATION_FORBIDDEN => Some(ContextWorkflowFailure::Permission),
            ERR_AUTOMATION_ACTION_INVALID if accepted.document_review.is_some() || accepted.task_handover.is_some() => {
              Some(ContextWorkflowFailure::Stale)
            }
            ERR_AUTOMATION_RUN_NOT_RETRYABLE | ERR_AUTOMATION_IDEMPOTENCY_CONFLICT => {
              Some(ContextWorkflowFailure::Stale)
            }
            _ => None,
          };
          if let Some(reason) = reason {
            if let Some(changed) = self.repo.fail_confirmed_run(run.id, claim, reason).await? {
              audit_run_finished(&self.audit, &changed, None).await;
            }
          }
        }
        return result;
      }
      let trigger = accepted.trigger.as_ref().ok_or_else(unavailable)?;
      let position = invocation
        .node_key
        .strip_prefix("action:")
        .and_then(|value| value.parse::<i32>().ok())
        .ok_or_else(unavailable)?;
      let action = accepted
        .definition
        .actions
        .iter()
        .find(|action| action.position == position)
        .ok_or_else(unavailable)?
        .clone();
      let rule = self
        .repo
        .get_automation(run.automation_id.ok_or_else(unavailable)?)
        .await?
        .ok_or_else(|| WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "automation unavailable"))?;
      let actor = accepted.actor_id.ok_or_else(|| {
        WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "automation actor unavailable")
      })?;
      self
        .assert_actor(actor, run.workspace_id, WorkspaceAction::Read)
        .await?;
      if let Some(receipt) = self
        .repo
        .get_effect(run.id, &invocation.node_key, &invocation.effect_key)
        .await?
      {
        if receipt.input_fingerprint != invocation.input_fingerprint {
          return Err(WorkspaceAutomationServiceError::new(
            ERR_AUTOMATION_IDEMPOTENCY_CONFLICT,
            "native effect input mismatch",
          ));
        }
        if let Some(result) = receipt.result_json {
          match action.config {
            WorkspaceAutomationActionConfig::CreateLinkedDocument { .. } => {
              let doc = self
                .doc_service
                .get_metadata(receipt.reserved_id)
                .await
                .map_err(|_| unavailable())?
                .filter(|doc| {
                  doc.workspace_id == Some(run.workspace_id)
                    && doc.deleted_at.is_none()
                    && !doc.blocked
                    && !doc.is_workspace_root
                })
                .ok_or_else(|| {
                  WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "automation document unavailable")
                })?;
              self
                .permission
                .assert(
                  &DocResource {
                    user_id: actor,
                    workspace_id: run.workspace_id,
                    doc_id: doc.id,
                  },
                  DocAction::Read,
                )
                .await
                .map_err(|_| {
                  WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "automation result forbidden")
                })?;
            }
            WorkspaceAutomationActionConfig::CreateRow { .. } | WorkspaceAutomationActionConfig::UpdateCell { .. } => {
              let row_id = match &action.config {
                WorkspaceAutomationActionConfig::UpdateCell { row_id, .. } => *row_id,
                _ => receipt.reserved_id,
              };
              let row = self
                .database_row_repo
                .get_row(row_id)
                .await?
                .filter(|row| row.row.deleted_at.is_none())
                .ok_or_else(|| {
                  WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "automation row unavailable")
                })?;
              let db = self
                .database_schema_repo
                .get_database(row.row.database_id)
                .await?
                .filter(|db| db.database.workspace_id == run.workspace_id && db.database.deleted_at.is_none())
                .ok_or_else(|| {
                  WorkspaceAutomationServiceError::new(
                    ERR_AUTOMATION_NOT_FOUND,
                    "automation result moved or unavailable",
                  )
                })?;
              self
                .assert_actor(actor, db.database.workspace_id, WorkspaceAction::Read)
                .await?;
            }
            WorkspaceAutomationActionConfig::NotifyWebhook { .. } => {}
          }
          return Ok(AutomationEffectResult {
            action_id: receipt.action_id,
            result,
          });
        }
      }
      if rule.status != WorkspaceAutomationStatus::Enabled || rule.workspace_id != run.workspace_id {
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_FORBIDDEN,
          "automation is disabled",
        ));
      }
      self
        .assert_actor(actor, run.workspace_id, WorkspaceAction::CreateDoc)
        .await?;
      let source = self
        .database_row_repo
        .get_row(trigger.row_id)
        .await?
        .filter(|row| row.row.database_id == trigger.database_id && row.row.deleted_at.is_none())
        .ok_or_else(|| {
          WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "automation source moved or unavailable")
        })?;
      let source_database = self
        .database_schema_repo
        .get_database(source.row.database_id)
        .await?
        .filter(|db| db.database.workspace_id == run.workspace_id && db.database.deleted_at.is_none())
        .ok_or_else(|| {
          WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "automation source unavailable")
        })?;
      let _ = source_database;
      let expected_revision = match &action.config {
        WorkspaceAutomationActionConfig::CreateLinkedDocument { source: Some(_), .. } => Some(source.row.edit_revision),
        WorkspaceAutomationActionConfig::UpdateCell { row_id, field_id, .. } => {
          let row = self.database_row_repo.get_row(*row_id).await?.ok_or_else(|| {
            WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "automation target unavailable")
          })?;
          let record = self
            .database_schema_repo
            .get_database(row.row.database_id)
            .await?
            .ok_or_else(unavailable)?;
          Some(
            if record
              .fields
              .iter()
              .any(|field| field.id == *field_id && field.field_type == DatabaseFieldType::Title)
            {
              row.row.edit_revision
            } else {
              row
                .cell_revisions
                .iter()
                .find(|slot| slot.field_id == *field_id)
                .map(|slot| slot.edit_revision)
                .unwrap_or(0)
            },
          )
        }
        _ => None,
      };
      let receipt = self
        .repo
        .reserve_effect(
          run.id,
          &invocation.node_key,
          &invocation.effect_key,
          &invocation.input_fingerprint,
          invocation.claim,
          expected_revision,
        )
        .await?;
      let fence = AutomationEffectFence {
        run_id: run.id,
        action_id: receipt.action_id,
        claim: invocation.claim,
      };
      let execution = NativeExecution {
        actions: self,
        receipt,
        fence,
        accepted,
      };
      let result = match &action.config {
        WorkspaceAutomationActionConfig::CreateRow { .. } => execution.execute_create_row(&run, &action.config).await?,
        WorkspaceAutomationActionConfig::UpdateCell { .. } => {
          execution.execute_update_cell(&run, &action.config).await?
        }
        WorkspaceAutomationActionConfig::CreateLinkedDocument { .. } => {
          execution.execute_create_linked_document(&run, &action.config).await?
        }
        WorkspaceAutomationActionConfig::NotifyWebhook { .. } => {
          execution
            .execute_notify_webhook(&run, execution.receipt.action_id, &action.config)
            .await?
        }
      };
      // A concurrent native writer may have returned its canonical existing Row;
      // only the retained atomic ACK is authoritative for the engine checkpoint.
      let committed = self
        .repo
        .get_effect(run.id, &invocation.node_key, &invocation.effect_key)
        .await?
        .and_then(|receipt| receipt.result_json)
        .ok_or_else(|| {
          WorkspaceAutomationServiceError::new(ERR_AUTOMATION_RUN_FAILED, "native effect acknowledgement unavailable")
        })?;
      let _ = result;
      Ok(AutomationEffectResult {
        action_id: execution.receipt.action_id,
        result: committed,
      })
    }
    .await;
    if let Err(error) = &outcome {
      let reason = match error.code {
        ERR_AUTOMATION_FORBIDDEN => Some(ContextWorkflowFailure::Permission),
        ERR_AUTOMATION_ACTION_INVALID
        | ERR_AUTOMATION_RUN_NOT_RETRYABLE
        | ERR_AUTOMATION_IDEMPOTENCY_CONFLICT
        | ERR_AUTOMATION_NOT_FOUND => Some(ContextWorkflowFailure::Stale),
        _ => None,
      };
      if let Some(reason) = reason {
        if self
          .repo
          .get_run(run_id)
          .await?
          .and_then(|run| run.accepted)
          .is_some_and(|accepted| accepted.personal_rule.is_some() && accepted.task_maintenance.is_none())
        {
          if let Some(changed) = self.repo.fail_confirmed_run(run_id, claim, reason).await? {
            audit_run_finished(&self.audit, &changed, None).await;
          }
        }
      }
    }
    outcome
  }
}
