// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Application service for Workspace Automations.
//!
//! The service owns trigger matching, idempotent run creation, queue handoff and
//! durable audit evidence. It deliberately stays outside
//! the Database mutation services: write paths emit typed events, and this
//! service decides whether and how automations react.

pub mod handover;
pub mod maintenance;
mod native_actions;
pub mod review;
pub mod runtime;
pub mod setup;
pub mod task_preparation;
pub mod webhook;
pub mod workflows;
use myoxus_domain::workspace_automation::{AcceptedAutomationRun, AutomationExecutionPolicy};
use runtime::{WorkspaceAutomationRuntime, freeze_definition};

use std::sync::Arc;
use std::time::Instant;

use chrono::Utc;
use myoxus_domain::audit::{AuditActor, AuditCategory, AuditEvent, AuditTarget};
use myoxus_domain::ids::{DatabaseId, UserId, WorkspaceAutomationId, WorkspaceAutomationRunId, WorkspaceId};
use myoxus_domain::repositories::{PageRequest, RepositoryError, WorkspaceAutomationRepository};
use myoxus_domain::workspace_automation::{
  WorkspaceAutomation, WorkspaceAutomationActionConfig, WorkspaceAutomationActionDefinition, WorkspaceAutomationRun,
  WorkspaceAutomationRunStatus, WorkspaceAutomationStatus, WorkspaceAutomationTrigger, WorkspaceAutomationTriggerEvent,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use tracing::{debug, instrument, warn};
use uuid::Uuid;

use crate::audit::AuditRecorder;
use crate::doc::DocService;
use crate::permission::{AccessController, PermissionService, WorkspaceResource};
use crate::worker::WorkQueuePort;
use webhook::{WorkspaceAutomationWebhookPayload, WorkspaceAutomationWebhookPort, WorkspaceAutomationWebhookRequest};

pub const WORKSPACE_AUTOMATION_QUEUE: &str = "workspace-automation";
pub const JOB_EVALUATE_TRIGGER: &str = "workspaceAutomation.evaluateTrigger";

pub const ERR_AUTOMATION_NOT_FOUND: &str = "MIX_AUTOMATION_NOT_FOUND";
pub const ERR_AUTOMATION_FORBIDDEN: &str = "MIX_AUTOMATION_FORBIDDEN";
pub const ERR_AUTOMATION_TRIGGER_INVALID: &str = "MIX_AUTOMATION_TRIGGER_INVALID";
pub const ERR_AUTOMATION_ACTION_INVALID: &str = "MIX_AUTOMATION_ACTION_INVALID";
pub const ERR_AUTOMATION_RATE_LIMITED: &str = "MIX_AUTOMATION_RATE_LIMITED";
pub const ERR_AUTOMATION_IDEMPOTENCY_CONFLICT: &str = "MIX_AUTOMATION_IDEMPOTENCY_CONFLICT";
pub const ERR_AUTOMATION_WEBHOOK_FAILED: &str = "MIX_AUTOMATION_WEBHOOK_FAILED";
pub const ERR_AUTOMATION_RUN_FAILED: &str = "MIX_AUTOMATION_RUN_FAILED";
pub const ERR_AUTOMATION_RUN_NOT_RETRYABLE: &str = "MIX_AUTOMATION_RUN_NOT_RETRYABLE";

pub type WorkspaceAutomationResult<T> = Result<T, WorkspaceAutomationServiceError>;

#[derive(Debug, Clone)]
pub struct WorkspaceAutomationLimits {
  pub enabled: bool,
  pub max_actions_per_run: usize,
  pub max_runs_per_minute: i64,
  pub webhook_timeout_seconds: u64,
  pub max_retry_attempts: i32,
}

impl Default for WorkspaceAutomationLimits {
  fn default() -> Self {
    Self {
      enabled: true,
      max_actions_per_run: 25,
      max_runs_per_minute: 300,
      webhook_timeout_seconds: 10,
      max_retry_attempts: 5,
    }
  }
}

#[derive(Debug, Clone)]
pub struct WorkspaceAutomationServiceError {
  pub code: &'static str,
  pub message: String,
}

impl WorkspaceAutomationServiceError {
  pub fn new(code: &'static str, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
    }
  }
}

impl std::fmt::Display for WorkspaceAutomationServiceError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}: {}", self.code, self.message)
  }
}

impl std::error::Error for WorkspaceAutomationServiceError {}

impl From<RepositoryError> for WorkspaceAutomationServiceError {
  fn from(value: RepositoryError) -> Self {
    match value {
      RepositoryError::NotFound(_) => Self::new(ERR_AUTOMATION_NOT_FOUND, value.to_string()),
      RepositoryError::Conflict(_) => Self::new(ERR_AUTOMATION_IDEMPOTENCY_CONFLICT, value.to_string()),
      RepositoryError::Validation(_) => Self::new(ERR_AUTOMATION_ACTION_INVALID, value.to_string()),
      RepositoryError::Storage(_) => Self::new(ERR_AUTOMATION_RUN_FAILED, value.to_string()),
    }
  }
}

#[derive(Debug, Clone, Default)]
pub struct WorkspaceAutomationTriggerOutcome {
  pub matched_count: i64,
  pub created_count: i64,
  pub duplicate_count: i64,
  pub enqueued_count: i64,
}

#[derive(Debug, Clone)]
pub struct WorkspaceAutomationRetryOutcome {
  pub run: WorkspaceAutomationRun,
  pub job_id: Option<String>,
}

#[derive(Clone)]
pub struct WorkspaceAutomationService {
  repo: Arc<dyn WorkspaceAutomationRepository>,
  runtime: Option<Arc<dyn WorkspaceAutomationRuntime>>,
  editing: Arc<crate::database::DatabaseEditingService>,
  context_documents: Option<Arc<workflows::ContextDocumentActions>>,
  database_schema_repo: Arc<dyn myoxus_domain::database::DatabaseDefinitionRepository>,
  database_row_repo: Arc<dyn myoxus_domain::database::DatabaseEditingRepository>,
  doc_service: DocService,
  permission: Arc<PermissionService>,
  audit: AuditRecorder,
  queue: Option<Arc<dyn WorkQueuePort>>,
  webhook: Option<Arc<dyn WorkspaceAutomationWebhookPort>>,
  limits: WorkspaceAutomationLimits,
}

impl WorkspaceAutomationService {
  #[allow(clippy::too_many_arguments)]
  pub fn new(
    repo: Arc<dyn WorkspaceAutomationRepository>,
    database_schema_repo: Arc<dyn myoxus_domain::database::DatabaseDefinitionRepository>,
    database_row_repo: Arc<dyn myoxus_domain::database::DatabaseEditingRepository>,
    doc_service: DocService,
    permission: Arc<PermissionService>,
    audit: AuditRecorder,
    queue: Option<Arc<dyn WorkQueuePort>>,
    webhook: Option<Arc<dyn WorkspaceAutomationWebhookPort>>,
    limits: WorkspaceAutomationLimits,
    editing: Arc<crate::database::DatabaseEditingService>,
  ) -> Self {
    Self {
      repo,
      runtime: None,
      editing,
      context_documents: None,
      database_schema_repo,
      database_row_repo,
      doc_service,
      permission,
      audit,
      queue,
      webhook,
      limits,
    }
  }

  /// Native collaborators are cloned into callbacks, with no WorkspaceService
  /// or runtime backreference and no second acceptance owner.
  pub fn with_context_documents(
    mut self,
    store: Arc<dyn crate::workspace::WorkspaceStore>,
    packages: Arc<crate::workspace::assistant_packages::AssistantPackageService>,
    auth: Arc<crate::auth::AuthService>,
  ) -> Self {
    self.context_documents = Some(Arc::new(workflows::ContextDocumentActions { store, packages, auth }));
    self
  }
  pub(crate) fn prepare_workspace_setup_definition(
    &self,
    plan: &myoxus_domain::assistant_package::AssistantPreparedWorkspaceSetup,
  ) -> WorkspaceAutomationResult<myoxus_domain::workspace_automation::AcceptedAutomationDefinition> {
    if !self.limits.enabled || self.runtime.is_none() || self.context_documents.is_none() || !plan.execution_available {
      return Err(runtime::unavailable());
    }
    setup::compile_workspace_setup(
      plan,
      AutomationExecutionPolicy {
        max_actions_per_run: u32::try_from(self.limits.max_actions_per_run).map_err(|_| runtime::unavailable())?,
        max_retry_attempts: u32::try_from(self.limits.max_retry_attempts.max(1)).map_err(|_| runtime::unavailable())?,
        webhook_timeout_seconds: self.limits.webhook_timeout_seconds,
      },
    )
  }
  pub(crate) fn prepare_context_definition(
    &self,
    plan: &myoxus_domain::assistant_package::AssistantPreparedContextDocuments,
  ) -> WorkspaceAutomationResult<myoxus_domain::workspace_automation::AcceptedAutomationDefinition> {
    if !self.limits.enabled || self.runtime.is_none() || self.context_documents.is_none() {
      return Err(runtime::unavailable());
    }
    workflows::compile_context_workflow(
      plan,
      AutomationExecutionPolicy {
        max_actions_per_run: u32::try_from(self.limits.max_actions_per_run).map_err(|_| runtime::unavailable())?,
        max_retry_attempts: u32::try_from(self.limits.max_retry_attempts.max(1)).map_err(|_| runtime::unavailable())?,
        webhook_timeout_seconds: self.limits.webhook_timeout_seconds,
      },
    )
  }
  pub(crate) async fn context_run(&self, run_id: Uuid) -> WorkspaceAutomationResult<WorkspaceAutomationRun> {
    self
      .repo
      .get_run(run_id)
      .await?
      .ok_or_else(|| WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "automation run unavailable"))
  }
  pub(crate) async fn start_context_run(&self, run_id: Uuid) -> WorkspaceAutomationResult<()> {
    let run = self.context_run(run_id).await?;
    if !matches!(
      run.origin,
      myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::ConfirmedContextDocuments { .. }
        | myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::WorkspaceSetup { .. }
    ) {
      return Err(runtime::unavailable());
    }
    if !matches!(
      run.status,
      WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
    ) {
      return Ok(());
    }
    let accepted = run.accepted.ok_or_else(runtime::unavailable)?;
    let runtime = self.runtime.as_ref().ok_or_else(runtime::unavailable)?;
    runtime.register_definition(accepted.definition.clone()).await?;
    runtime.ensure_started(accepted).await
  }
  pub fn with_queue(mut self, queue: Option<Arc<dyn WorkQueuePort>>) -> Self {
    self.queue = queue;
    self
  }
  #[instrument(skip_all, fields(run_id=%run_id))]
  pub async fn authorize_run_stop(
    &self,
    actor: UserId,
    run_id: WorkspaceAutomationRunId,
  ) -> WorkspaceAutomationResult<WorkspaceAutomationRun> {
    let run = self.repo.get_run(run_id).await?.ok_or_else(runtime::unavailable)?;
    self.authorize_run_control(actor, &run).await?;
    Ok(run)
  }
  async fn authorize_run_control(&self, actor: UserId, run: &WorkspaceAutomationRun) -> WorkspaceAutomationResult<()> {
    if (matches!(
      run.origin,
      myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::ConfirmedContextDocuments { .. }
        | myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::WorkspaceSetup { .. }
        | myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::DocumentReview { .. }
        | myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::TaskHandover { .. }
        | myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::TaskMaintenance { .. }
    ) && run.accepted.as_ref().and_then(|accepted| accepted.actor_id) == Some(actor))
      || run
        .accepted
        .as_ref()
        .and_then(|accepted| accepted.personal_rule.as_ref())
        .is_some_and(|proof| proof.actor_id == actor)
    {
      let role = self
        .permission
        .get_effective_workspace_role(actor, run.workspace_id)
        .await
        .map_err(|error| match error {
          crate::auth::AuthError::ActionForbidden => {
            WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "automation permission unavailable")
          }
          _ => runtime::unavailable(),
        })?;
      if role.is_some_and(|role| role.can(myoxus_domain::permission::WorkspaceAction::CreateDoc)) {
        Ok(())
      } else {
        Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_FORBIDDEN,
          "automation permission unavailable",
        ))
      }
    } else {
      self.assert_workspace_manager(actor, run.workspace_id).await
    }
  }
  #[instrument(skip_all, fields(run_id=%run_id))]
  pub async fn stop_run(
    &self,
    actor: UserId,
    run_id: WorkspaceAutomationRunId,
  ) -> WorkspaceAutomationResult<WorkspaceAutomationRun> {
    self.authorize_run_stop(actor, run_id).await?;
    let (stopped, changed) = self.repo.stop_runtime_run(actor, run_id).await?;
    if changed {
      audit_run_finished(&self.audit, &stopped, Some(actor)).await;
    }
    if stopped.status == WorkspaceAutomationRunStatus::Skipped {
      // Native Stop has already fenced the generation and receipt atomically.
      // A lost engine signal does not resurrect its native write authority.
      if self
        .runtime
        .as_ref()
        .ok_or_else(runtime::unavailable)?
        .cancel(run_id)
        .await
        .is_err()
      {
        warn!(%run_id,"stopped automation runtime signal unavailable");
      }
    }
    Ok(stopped)
  }

  pub fn with_runtime(mut self, runtime: Arc<dyn WorkspaceAutomationRuntime>) -> Self {
    self.runtime = Some(runtime);
    self
  }
  pub fn native_executor(&self) -> Arc<dyn runtime::WorkspaceAutomationNativeExecutor> {
    Arc::new(native_actions::WorkspaceAutomationNativeActions::new(
      self.repo.clone(),
      self.database_schema_repo.clone(),
      self.database_row_repo.clone(),
      self.doc_service.clone(),
      self.permission.clone(),
      self.webhook.clone(),
      self.editing.clone(),
      self.audit.clone(),
      self.context_documents.clone(),
    ))
  }

  pub fn limits(&self) -> &WorkspaceAutomationLimits {
    &self.limits
  }

  async fn assert_workspace_manager(&self, actor: UserId, workspace_id: WorkspaceId) -> WorkspaceAutomationResult<()> {
    let role = self
      .permission
      .get_effective_workspace_role(actor, workspace_id)
      .await
      .map_err(|error| match error {
        crate::auth::AuthError::ActionForbidden => {
          WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "automation permission unavailable")
        }
        _ => runtime::unavailable(),
      })?
      .unwrap_or(myoxus_domain::entities::WorkspaceRole::External);
    if role >= myoxus_domain::entities::WorkspaceRole::Manager {
      Ok(())
    } else {
      Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_FORBIDDEN,
        "workspace automation mutation requires workspace manager permissions",
      ))
    }
  }

  async fn assert_workspace_read(&self, actor: UserId, workspace_id: WorkspaceId) -> WorkspaceAutomationResult<()> {
    self
      .permission
      .assert(
        &WorkspaceResource {
          user_id: actor,
          workspace_id,
        },
        myoxus_domain::permission::WorkspaceAction::Read,
      )
      .await
      .map_err(|_| {
        WorkspaceAutomationServiceError::new(ERR_AUTOMATION_FORBIDDEN, "workspace automation read forbidden")
      })
  }

  fn validate_trigger(trigger: &WorkspaceAutomationTrigger) -> WorkspaceAutomationResult<()> {
    if trigger.database_id == DatabaseId::nil() {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_TRIGGER_INVALID,
        "automation trigger requires a database id",
      ));
    }
    Ok(())
  }

  fn validate_actions(
    actions: &[WorkspaceAutomationActionDefinition],
    limits: &WorkspaceAutomationLimits,
  ) -> WorkspaceAutomationResult<()> {
    if actions.is_empty() {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_ACTION_INVALID,
        "automation requires at least one action",
      ));
    }
    if actions.len() > limits.max_actions_per_run {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_ACTION_INVALID,
        "automation action count exceeds configured limit",
      ));
    }
    for (index, action) in actions.iter().enumerate() {
      if action.position < 0 || action.position as usize != index {
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_ACTION_INVALID,
          "automation actions must be ordered with contiguous positions",
        ));
      }
    }
    Ok(())
  }

  async fn validate_action_targets(
    &self,
    workspace_id: WorkspaceId,
    actions: &[WorkspaceAutomationActionDefinition],
  ) -> WorkspaceAutomationResult<()> {
    for action in actions {
      match &action.config {
        WorkspaceAutomationActionConfig::CreateRow { database_id, cells, .. } => {
          let record = self
            .database_schema_repo
            .get_database(*database_id)
            .await?
            .ok_or_else(|| {
              WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "target database not found")
            })?;
          if record.database.workspace_id != workspace_id {
            return Err(WorkspaceAutomationServiceError::new(
              ERR_AUTOMATION_ACTION_INVALID,
              "automation create-row action target database must belong to the automation workspace",
            ));
          }
          for cell in cells {
            if !record.fields.iter().any(|field| field.id == cell.field_id) {
              return Err(WorkspaceAutomationServiceError::new(
                ERR_AUTOMATION_ACTION_INVALID,
                "automation create-row action references an unknown target field",
              ));
            }
          }
        }
        WorkspaceAutomationActionConfig::UpdateCell { row_id, field_id, .. } => {
          let row = self
            .database_row_repo
            .get_row(*row_id)
            .await?
            .ok_or_else(|| WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "target row not found"))?;
          let record = self
            .database_schema_repo
            .get_database(row.row.database_id)
            .await?
            .ok_or_else(|| {
              WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "target database not found")
            })?;
          if record.database.workspace_id != workspace_id {
            return Err(WorkspaceAutomationServiceError::new(
              ERR_AUTOMATION_ACTION_INVALID,
              "automation update-cell action target row must belong to the automation workspace",
            ));
          }
          if !record.fields.iter().any(|field| field.id == *field_id) {
            return Err(WorkspaceAutomationServiceError::new(
              ERR_AUTOMATION_ACTION_INVALID,
              "automation update-cell action references an unknown target field",
            ));
          }
        }
        WorkspaceAutomationActionConfig::CreateLinkedDocument {
          relation_field_id,
          source,
          ..
        } => {
          if source.is_some() {
            return Err(WorkspaceAutomationServiceError::new(
              ERR_AUTOMATION_ACTION_INVALID,
              "source-backed actions require explicit personal configuration",
            ));
          }
          if relation_field_id.is_some() {
            return Err(WorkspaceAutomationServiceError::new(
              ERR_AUTOMATION_ACTION_INVALID,
              "create linked document relation linking is not available without an explicit database relation target",
            ));
          }
        }
        WorkspaceAutomationActionConfig::NotifyWebhook { .. } => {}
      }
    }
    Ok(())
  }

  #[instrument(skip_all, fields(workspace_id = %workspace_id))]
  pub async fn create_automation(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    name: String,
    description: Option<String>,
    trigger: WorkspaceAutomationTrigger,
    actions: Vec<WorkspaceAutomationActionDefinition>,
  ) -> WorkspaceAutomationResult<WorkspaceAutomation> {
    if !self.limits.enabled {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_FORBIDDEN,
        "workspace automations are disabled",
      ));
    }
    self.assert_workspace_manager(actor, workspace_id).await?;
    let name = name.trim();
    if name.is_empty() {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_ACTION_INVALID,
        "automation name is required",
      ));
    }
    Self::validate_trigger(&trigger)?;
    Self::validate_actions(&actions, &self.limits)?;
    self.validate_action_targets(workspace_id, &actions).await?;
    let now = Utc::now();
    let automation = self
      .repo
      .create_automation(WorkspaceAutomation {
        id: Uuid::new_v4(),
        workspace_id,
        name: name.to_string(),
        description,
        status: WorkspaceAutomationStatus::Enabled,
        trigger,
        actions,
        personal_config: None,
        execution_revision: 1,
        created_by: Some(actor),
        updated_by: Some(actor),
        created_at: now,
        updated_at: now,
      })
      .await?;
    self
      .audit
      .record(AuditEvent::mutation(
        "workspace_automation.create",
        AuditCategory::WorkspaceAutomation,
        Some(AuditTarget::entity(
          "workspace_automation",
          automation.id,
          Some(automation.name.clone()),
        )),
        AuditActor::user(actor, None),
        None,
        Some(json!({ "workspace_id": workspace_id, "status": automation.status.as_str() })),
      ))
      .await;
    Ok(automation)
  }

  pub async fn list_automations(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    page: PageRequest,
  ) -> WorkspaceAutomationResult<Vec<WorkspaceAutomation>> {
    self.assert_workspace_read(actor, workspace_id).await?;
    self.repo.list_automations(workspace_id, page).await.map_err(Into::into)
  }

  pub async fn list_runs(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    automation_id: Option<WorkspaceAutomationId>,
    include_dead_letter: bool,
    page: PageRequest,
  ) -> WorkspaceAutomationResult<Vec<WorkspaceAutomationRun>> {
    self.assert_workspace_read(actor, workspace_id).await?;
    self
      .repo
      .list_runs(workspace_id, automation_id, include_dead_letter, page)
      .await
      .map_err(Into::into)
  }

  pub async fn get_run(
    &self,
    actor: UserId,
    run_id: WorkspaceAutomationRunId,
  ) -> WorkspaceAutomationResult<WorkspaceAutomationRun> {
    let run = self
      .repo
      .get_run(run_id)
      .await?
      .ok_or_else(|| WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "automation run not found"))?;
    self.assert_workspace_read(actor, run.workspace_id).await?;
    Ok(run)
  }

  pub async fn list_dead_letter_runs(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    page: PageRequest,
  ) -> WorkspaceAutomationResult<Vec<WorkspaceAutomationRun>> {
    self.assert_workspace_read(actor, workspace_id).await?;
    self
      .repo
      .list_dead_letter_runs(Some(workspace_id), page)
      .await
      .map_err(Into::into)
  }

  pub async fn disable_automation(
    &self,
    actor: UserId,
    automation_id: WorkspaceAutomationId,
  ) -> WorkspaceAutomationResult<WorkspaceAutomation> {
    let automation = self
      .repo
      .get_automation(automation_id)
      .await?
      .ok_or_else(|| WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "automation not found"))?;
    self.assert_workspace_manager(actor, automation.workspace_id).await?;
    if automation.personal_config.is_some() {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_FORBIDDEN,
        "personal configuration requires its owner's revisioned command",
      ));
    }
    let disabled = self.repo.disable_automation(automation_id, Some(actor)).await?;
    self
      .audit
      .record(AuditEvent::mutation(
        "workspace_automation.disable",
        AuditCategory::WorkspaceAutomation,
        Some(AuditTarget::entity(
          "workspace_automation",
          disabled.id,
          Some(disabled.name.clone()),
        )),
        AuditActor::user(actor, None),
        Some(json!({ "status": automation.status.as_str() })),
        Some(json!({ "status": disabled.status.as_str() })),
      ))
      .await;
    Ok(disabled)
  }

  /// An unknown authority or storage result must not be presented as a terminal
  /// inability to retry the same accepted request.
  pub(crate) async fn can_retry_context_run(
    &self,
    actor: UserId,
    run: &WorkspaceAutomationRun,
  ) -> WorkspaceAutomationResult<bool> {
    if !self.limits.enabled || !workflows::confirmed_run_retryable(run) {
      return Ok(false);
    }
    if run
      .accepted
      .as_ref()
      .is_some_and(|accepted| accepted.workspace_setup.is_some())
    {
      let authorized = match self.authorize_run_control(actor, run).await {
        Ok(()) => {
          self
            .context_documents
            .as_ref()
            .ok_or_else(runtime::unavailable)?
            .authorize_workspace_setup_retry(&self.repo, run)
            .await
        }
        Err(error) => Err(error),
      };
      return match authorized {
        Ok(()) => Ok(true),
        Err(error) if matches!(error.code, ERR_AUTOMATION_FORBIDDEN | ERR_AUTOMATION_RUN_NOT_RETRYABLE) => Ok(false),
        Err(error) => Err(error),
      };
    }
    if run
      .accepted
      .as_ref()
      .is_some_and(|accepted| accepted.task_maintenance.is_some())
    {
      return match self.authorize_task_maintenance_retry(actor, run).await {
        Ok(()) => Ok(true),
        Err(error) if matches!(error.code, ERR_AUTOMATION_FORBIDDEN | ERR_AUTOMATION_RUN_NOT_RETRYABLE) => Ok(false),
        Err(error) => Err(error),
      };
    }
    let authorization = match self.authorize_run_control(actor, run).await {
      Ok(()) => match &self.context_documents {
        Some(actions) => actions.authorize_retry(&self.repo, run).await,
        None => return Err(runtime::unavailable()),
      },
      Err(error) => Err(error),
    };
    match authorization {
      Ok(()) => Ok(true),
      Err(error) if matches!(error.code, ERR_AUTOMATION_FORBIDDEN | ERR_AUTOMATION_RUN_NOT_RETRYABLE) => Ok(false),
      Err(error) => Err(error),
    }
  }

  #[instrument(skip_all, fields(run_id = %run_id))]
  pub async fn retry_run(
    &self,
    actor: UserId,
    run_id: WorkspaceAutomationRunId,
  ) -> WorkspaceAutomationResult<WorkspaceAutomationRetryOutcome> {
    let previous = self
      .repo
      .get_run(run_id)
      .await?
      .ok_or_else(|| WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "automation run not found"))?;
    self.authorize_run_control(actor, &previous).await?;
    if !self.limits.enabled {
      return Err(runtime::unavailable());
    }
    if matches!(
      previous.origin,
      myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::ConfirmedContextDocuments { .. }
        | myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::WorkspaceSetup { .. }
    ) {
      if !workflows::confirmed_run_retryable(&previous) {
        return Err(WorkspaceAutomationServiceError::new(
          ERR_AUTOMATION_RUN_NOT_RETRYABLE,
          "Context request requires a fresh explicit intent",
        ));
      }
      let actions = self.context_documents.as_ref().ok_or_else(runtime::unavailable)?;
      if previous
        .accepted
        .as_ref()
        .is_some_and(|accepted| accepted.workspace_setup.is_some())
      {
        actions.authorize_workspace_setup_retry(&self.repo, &previous).await?;
      } else {
        actions.authorize_retry(&self.repo, &previous).await?;
      }
    }
    if previous
      .accepted
      .as_ref()
      .is_some_and(|accepted| accepted.document_review.is_some())
    {
      self.authorize_document_review_retry(actor, &previous).await?;
    }
    if previous
      .accepted
      .as_ref()
      .is_some_and(|accepted| accepted.task_handover.is_some())
    {
      self.authorize_task_handover_retry(actor, &previous).await?;
    }
    if previous.accepted.as_ref().is_some_and(|accepted| {
      accepted.personal_rule.is_some()
        && accepted.task_maintenance.is_none()
        && accepted.definition.actions.iter().any(|action| {
          matches!(
            &action.config,
            WorkspaceAutomationActionConfig::CreateLinkedDocument { source: Some(_), .. }
          )
        })
    }) {
      self.authorize_task_preparation_retry(actor, &previous).await?;
    } else {
      self.authorize_personal_run(&previous).await?;
    }
    if previous
      .accepted
      .as_ref()
      .is_some_and(|accepted| accepted.task_maintenance.is_some())
    {
      self.authorize_task_maintenance_retry(actor, &previous).await?;
    }
    if !matches!(
      previous.status,
      WorkspaceAutomationRunStatus::Failed | WorkspaceAutomationRunStatus::DeadLetter
    ) {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_RUN_NOT_RETRYABLE,
        "only failed or dead-lettered automation runs can be retried",
      ));
    }
    if previous.accepted.is_none() {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_RUN_NOT_RETRYABLE,
        "Accepted automation inputs are unavailable",
      ));
    }
    let runtime = self.runtime.as_ref().ok_or_else(runtime::unavailable)?;
    runtime.retry(run_id).await?;
    // Runtime admission is durable independently of an optional Redis wake.
    // A failed wake cannot roll an already accepted retry back.
    let job_id = if self.queue.is_some() {
      match self.enqueue_run_required(run_id).await {
        Ok(job_id) => Some(job_id),
        Err(_) => {
          warn!(%run_id,"accepted automation retry wake unavailable");
          None
        }
      }
    } else {
      None
    };
    let reset = self.repo.get_run(run_id).await?.ok_or_else(runtime::unavailable)?;
    self
      .audit
      .record(AuditEvent::mutation(
        "workspace_automation.run.retry",
        AuditCategory::WorkspaceAutomation,
        Some(AuditTarget::entity("workspace_automation_run", reset.id, None)),
        AuditActor::user(actor, None),
        Some(json!({
          "status": previous.status.as_str(),
          "dead_letter": previous.dead_letter,
          "attempt_count": previous.attempt_count,
          "error_code": previous.error_code,
        })),
        Some(json!({
          "status": reset.status.as_str(),
          "dead_letter": reset.dead_letter,
          "attempt_count": reset.attempt_count,
          "job_id": job_id,
        })),
      ))
      .await;
    Ok(WorkspaceAutomationRetryOutcome { run: reset, job_id })
  }

  /// Revalidate the object-level permission required to replay a previously
  /// completed retry command without performing the retry again.
  pub async fn authorize_run_retry(
    &self,
    actor: UserId,
    run_id: WorkspaceAutomationRunId,
  ) -> WorkspaceAutomationResult<()> {
    let run = self
      .repo
      .get_run(run_id)
      .await?
      .ok_or_else(|| WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "automation run not found"))?;
    self.authorize_run_control(actor, &run).await
  }

  #[instrument(skip_all, fields(workspace_id = %event.workspace_id, database_id = %event.database_id, row_id = %event.row_id))]
  pub async fn enqueue_database_event(
    &self,
    event: WorkspaceAutomationTriggerEvent,
  ) -> WorkspaceAutomationResult<WorkspaceAutomationTriggerOutcome> {
    if !self.limits.enabled {
      return Ok(Default::default());
    }
    let runtime = self.runtime.as_ref().ok_or_else(runtime::unavailable)?;
    let started_at = Instant::now();
    let automations = self.repo.list_matching_automations(&event, 100).await?;
    let mut outcome = WorkspaceAutomationTriggerOutcome {
      matched_count: automations.len() as i64,
      ..Default::default()
    };
    for automation in automations {
      let idempotency_key = Self::idempotency_key(&automation, &event)?;
      // An accepted event is resumed before inspecting mutable current content.
      if let Some(existing) = self
        .repo
        .get_rule_run(automation.workspace_id, automation.id, &idempotency_key)
        .await?
      {
        outcome.duplicate_count += 1;
        if matches!(
          existing.status,
          WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
        ) {
          let accepted = existing.accepted.ok_or_else(runtime::unavailable)?;
          runtime.register_definition(accepted.definition.clone()).await?;
          runtime.ensure_started(accepted).await?;
        }
        continue;
      }
      let policy = AutomationExecutionPolicy {
        max_actions_per_run: u32::try_from(self.limits.max_actions_per_run).map_err(|_| runtime::unavailable())?,
        max_retry_attempts: u32::try_from(self.limits.max_retry_attempts.max(1)).map_err(|_| runtime::unavailable())?,
        webhook_timeout_seconds: self.limits.webhook_timeout_seconds,
      };
      let run_id = Uuid::new_v4();
      let (definition, task_maintenance, personal_rule) = if automation.personal_config.is_some() {
        let Some((definition, maintenance, proof)) =
          self.prepare_personal_event(&automation, &event, run_id, policy).await?
        else {
          continue;
        };
        (definition, maintenance, Some(proof))
      } else {
        (freeze_definition(automation.actions.clone(), policy)?, None, None)
      };
      let accepted = AcceptedAutomationRun {
        workspace_setup: None,
        run_id,
        automation_id: Some(automation.id),
        workspace_id: automation.workspace_id,
        actor_id: event.actor_user_id,
        trigger: Some(event.clone()),
        confirmed_request: None,
        document_review: None,
        task_handover: None,
        task_maintenance,
        personal_rule,
        definition,
      };

      let recent_runs = self
        .repo
        .count_recent_runs(automation.workspace_id, Utc::now() - chrono::Duration::minutes(1))
        .await?;
      if recent_runs >= self.limits.max_runs_per_minute {
        warn!(
          workspace_id = %automation.workspace_id,
          automation_id = %automation.id,
          recent_runs,
          max_runs_per_minute = self.limits.max_runs_per_minute,
          "workspace automation run skipped by rate limit"
        );
        let now = Utc::now();
        let run = WorkspaceAutomationRun {
          id: run_id,
          job_id: None,
          origin: myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::Rule,
          automation_id: Some(automation.id),
          workspace_id: automation.workspace_id,
          trigger_type: Some(event.trigger_type),
          trigger_event: Some(event.clone()),
          accepted: Some(accepted.clone()),
          execution_generation: 0,
          idempotency_key,
          status: WorkspaceAutomationRunStatus::Failed,
          attempt_count: 0,
          error_code: Some(ERR_AUTOMATION_RATE_LIMITED.to_string()),
          error_message: Some("workspace automation rate limit exceeded".to_string()),
          dead_letter: false,
          queued_at: now,
          started_at: None,
          finished_at: Some(now),
        };
        let (run, created) = self.repo.create_run_if_absent(run).await?;
        if created {
          outcome.created_count += 1;
          audit_run_finished(&self.audit, &run, None).await;
        } else {
          outcome.duplicate_count += 1;
        }
        continue;
      }
      let run = WorkspaceAutomationRun {
        id: run_id,
        job_id: None,
        origin: myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::Rule,
        automation_id: Some(automation.id),
        workspace_id: automation.workspace_id,
        trigger_type: Some(event.trigger_type),
        trigger_event: Some(event.clone()),
        accepted: Some(accepted.clone()),
        execution_generation: 0,
        idempotency_key,
        status: WorkspaceAutomationRunStatus::Queued,
        attempt_count: 0,
        error_code: None,
        error_message: None,
        dead_letter: false,
        queued_at: Utc::now(),
        started_at: None,
        finished_at: None,
      };
      let (run, created) = self.repo.create_run_if_absent(run).await?;
      if matches!(
        run.status,
        WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
      ) {
        let accepted = run.accepted.clone().ok_or_else(runtime::unavailable)?;
        runtime.register_definition(accepted.definition.clone()).await?;
        runtime.ensure_started(accepted).await?;
      }
      if created {
        outcome.created_count += 1;
        match self.enqueue_run(run.id).await {
          Ok(true) => outcome.enqueued_count += 1,
          Ok(false) => {}
          Err(_) => warn!(run_id=%run.id,"accepted automation run wake unavailable"),
        }
      } else {
        outcome.duplicate_count += 1;
      }
    }
    debug!(
      matched_count = outcome.matched_count,
      created_count = outcome.created_count,
      duplicate_count = outcome.duplicate_count,
      enqueued_count = outcome.enqueued_count,
      duration_ms = started_at.elapsed().as_millis() as u64,
      "workspace automation trigger event processed"
    );
    Ok(outcome)
  }

  async fn enqueue_run(&self, run_id: WorkspaceAutomationRunId) -> WorkspaceAutomationResult<bool> {
    if self.queue.is_none() {
      warn!(%run_id, "workspace automation run persisted without queue adapter");
      return Ok(false);
    }
    self.enqueue_run_required(run_id).await?;
    Ok(true)
  }

  async fn enqueue_run_required(&self, run_id: WorkspaceAutomationRunId) -> WorkspaceAutomationResult<String> {
    let Some(queue) = &self.queue else {
      return Err(WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_RUN_FAILED,
        "workspace automation queue adapter is not configured",
      ));
    };
    let job_id = queue
      .add_job(
        WORKSPACE_AUTOMATION_QUEUE,
        JOB_EVALUATE_TRIGGER,
        json!({"run_id":run_id}),
        Some(self.limits.max_retry_attempts.max(1) as u32),
        None,
      )
      .await
      .map_err(|error| WorkspaceAutomationServiceError::new(ERR_AUTOMATION_RUN_FAILED, error.to_string()))?;
    // The queue has accepted the job. Metadata failure must not turn that
    // success into an enqueue failure and restore an already-retried run.
    if self.repo.record_run_job(run_id, &job_id).await.is_err() {
      warn!(%run_id,"workspace automation job identity could not be retained");
    }
    Ok(job_id)
  }

  fn idempotency_key(
    automation: &WorkspaceAutomation,
    event: &WorkspaceAutomationTriggerEvent,
  ) -> WorkspaceAutomationResult<String> {
    let bytes = serde_json::to_vec(&(automation.id, event)).map_err(|error| {
      WorkspaceAutomationServiceError::new(
        ERR_AUTOMATION_IDEMPOTENCY_CONFLICT,
        format!("failed to build automation idempotency key: {error}"),
      )
    })?;
    let digest = Sha256::digest(bytes);
    Ok(format!("{digest:x}"))
  }

  #[instrument(skip_all, fields(run_id = %run_id))]
  /// Re-admit a persisted native Run to the runtime; this never executes an
  /// action loop and cannot reconstruct unavailable accepted inputs from a mutable rule.
  pub async fn process_run(
    &self,
    run_id: WorkspaceAutomationRunId,
  ) -> WorkspaceAutomationResult<WorkspaceAutomationRun> {
    let run = self
      .repo
      .get_run(run_id)
      .await?
      .ok_or_else(|| WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "automation run unavailable"))?;
    let Some(accepted) = run.accepted.clone() else {
      if matches!(
        run.status,
        WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
      ) {
        if let Some(changed) = self
          .repo
          .synchronize_runtime_status(
            run.id,
            WorkspaceAutomationRunStatus::Failed,
            Some("MIX_AUTOMATION_INPUTS_UNAVAILABLE".into()),
          )
          .await?
        {
          audit_run_finished(&self.audit, &changed, None).await;
          return Ok(changed);
        }
        return self.repo.get_run(run.id).await?.ok_or_else(runtime::unavailable);
      }
      return Ok(run);
    };
    if !matches!(
      run.status,
      WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
    ) {
      return Ok(run);
    }
    let runtime = self.runtime.as_ref().ok_or_else(runtime::unavailable)?;
    runtime.register_definition(accepted.definition.clone()).await?;
    runtime.ensure_started(accepted).await?;
    self
      .repo
      .get_run(run_id)
      .await?
      .ok_or_else(|| WorkspaceAutomationServiceError::new(ERR_AUTOMATION_NOT_FOUND, "automation run unavailable"))
  }
}

async fn audit_run_finished(audit: &AuditRecorder, run: &WorkspaceAutomationRun, actor_override: Option<UserId>) {
  let event_key = match run.status {
    WorkspaceAutomationRunStatus::Succeeded => "workspace_automation.run.succeeded",
    WorkspaceAutomationRunStatus::DeadLetter => "workspace_automation.run.dead_letter",
    WorkspaceAutomationRunStatus::Failed => "workspace_automation.run.failed",
    WorkspaceAutomationRunStatus::Skipped => "workspace_automation.run.skipped",
    WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running => return,
  };
  audit
    .record(AuditEvent::mutation(
      event_key,
      AuditCategory::WorkspaceAutomation,
      Some(AuditTarget::entity("workspace_automation_run", run.id, None)),
      actor_override
        .or_else(|| run.trigger_event.as_ref().and_then(|event| event.actor_user_id))
        .or_else(|| run.accepted.as_ref().and_then(|accepted| accepted.actor_id))
        .map(|actor| AuditActor::user(actor, None))
        .unwrap_or_else(AuditActor::system),
      None,
      Some(json!({
        "automation_id": run.automation_id,
        "workspace_id": run.workspace_id,
        "status": run.status.as_str(),
        "dead_letter": run.dead_letter,
        "error_code": run.error_code,
      })),
    ))
    .await;
}

/// Public projections expose stable categories, never raw repository or task inputs.
pub fn safe_error_projection(run: &WorkspaceAutomationRun) -> (Option<&'static str>, Option<&'static str>) {
  match run.error_code.as_deref() {
    None
      if run.error_message.is_some()
        || matches!(
          run.status,
          WorkspaceAutomationRunStatus::Failed | WorkspaceAutomationRunStatus::DeadLetter
        ) =>
    {
      (Some(ERR_AUTOMATION_RUN_FAILED), Some("Automation execution failed"))
    }
    None => (None, None),
    Some(ERR_AUTOMATION_FORBIDDEN) => (
      Some(ERR_AUTOMATION_FORBIDDEN),
      Some("Automation permission unavailable"),
    ),
    Some(ERR_AUTOMATION_NOT_FOUND) => (Some(ERR_AUTOMATION_NOT_FOUND), Some("Automation target unavailable")),
    Some(ERR_AUTOMATION_IDEMPOTENCY_CONFLICT) => (
      Some(ERR_AUTOMATION_IDEMPOTENCY_CONFLICT),
      Some("Automation input or execution conflict"),
    ),
    Some(ERR_AUTOMATION_ACTION_INVALID) => (
      Some(ERR_AUTOMATION_ACTION_INVALID),
      Some("Automation action is no longer valid"),
    ),
    Some(ERR_AUTOMATION_WEBHOOK_FAILED) => (Some(ERR_AUTOMATION_WEBHOOK_FAILED), Some("Automation webhook failed")),
    Some(ERR_AUTOMATION_TRIGGER_INVALID) => (
      Some(ERR_AUTOMATION_TRIGGER_INVALID),
      Some("Automation trigger is invalid"),
    ),
    Some(ERR_AUTOMATION_RUN_NOT_RETRYABLE) => (
      Some(ERR_AUTOMATION_RUN_NOT_RETRYABLE),
      Some("Automation run cannot be retried"),
    ),
    Some(ERR_AUTOMATION_RATE_LIMITED) => (
      Some(ERR_AUTOMATION_RATE_LIMITED),
      Some("Automation rate limit exceeded"),
    ),
    Some("MIX_AUTOMATION_INPUTS_UNAVAILABLE") => (
      Some("MIX_AUTOMATION_INPUTS_UNAVAILABLE"),
      Some("Accepted automation inputs are unavailable"),
    ),
    Some(_) => (Some(ERR_AUTOMATION_RUN_FAILED), Some("Automation execution failed")),
  }
}
