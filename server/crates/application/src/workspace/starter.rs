// SPDX-License-Identifier: AGPL-3.0-or-later

//! Explicit Empty allocation. Receipts retain identity across source updates and
//! target deletion; acknowledgement never replays a confirmed preference write.
use super::*;
use crate::auth::{AssistanceMode, AuthService};
use crate::workspace::assistant_packages::AssistantPackageService;
use myoxus_domain::assistant_package::{AssistantPackageIdentity, AssistantValue};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceInitialContent {
  Empty,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStarterProjectInput {
  pub package: AssistantPackageIdentity,
  pub answers: BTreeMap<String, AssistantValue>,
  pub locale: String,
  pub client_version: Option<u32>,
}

/// A selected authored composition, separate from common allocation answers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStarterSetupInput {
  pub package: AssistantPackageIdentity,
  pub answers: BTreeMap<String, AssistantValue>,
  pub locale: String,
  pub client_version: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStarterInput {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub setup: Option<WorkspaceStarterSetupInput>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub project: Option<WorkspaceStarterProjectInput>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub admission_confirmation: Option<String>,
  pub request_id: Uuid,
  pub name: String,
  pub initial_content: WorkspaceInitialContent,
  pub assistance_mode: AssistanceMode,
  pub package: AssistantPackageIdentity,
  pub answers: BTreeMap<String, AssistantValue>,
  pub plan_digest: String,
}
impl WorkspaceStarterInput {
  pub fn fingerprint(&self) -> String {
    format!(
      "{:x}",
      Sha256::digest({
        let mut original = self.clone();
        original.admission_confirmation = None;
        serde_json::to_vec(&original).expect("typed Workspace request serializes")
      })
    )
  }
}
#[derive(Debug, Clone)]
pub struct WorkspaceStarterReceipt {
  pub setup_definition: Option<myoxus_domain::workspace_automation::AcceptedAutomationDefinition>,
  pub prepared: Option<crate::workspace::assistant_packages::PreparedWorkspaceAssistant>,
  pub actor_id: UserId,
  pub request_id: Uuid,
  pub fingerprint: String,
  pub package: AssistantPackageIdentity,
  pub workspace_id: WorkspaceId,
  pub name: String,
  pub assistance_mode: AssistanceMode,
  pub assistance_saved: bool,
}
#[derive(Debug, Clone)]
pub struct WorkspaceStarterAllocation {
  pub setup: Option<assistant_packages::AcceptedWorkspaceSetup>,
  pub workspace: Workspace,
  pub receipt: WorkspaceStarterReceipt,
  pub root_ready: bool,
  pub tasks_ready: bool,
  pub tasks_database_id: Option<Uuid>,
  pub reason_code: Option<String>,
}
#[derive(Debug, Clone, Copy)]
pub enum WorkspaceCreationStatus {
  Ready,
  AssistancePending,
  Unavailable,
}
#[derive(Debug, Clone)]
pub struct WorkspaceCreationOutcome {
  pub setup: Option<assistant_packages::WorkspaceSetupOutcome>,
  pub project: Option<ProjectStarterOutcome>,
  pub allocation: WorkspaceStarterAllocation,
  pub status: WorkspaceCreationStatus,
  pub retry_required: bool,
}
#[derive(Debug, thiserror::Error)]
pub enum WorkspaceStarterError {
  #[error(transparent)]
  Project(#[from] ProjectStarterError),
  #[error(transparent)]
  Auth(#[from] AuthError),
  #[error("workspace starter request conflicts with its accepted input")]
  Conflict,
  #[error("workspace starter target is gone")]
  Gone { workspace_id: Uuid },
}
pub type WorkspaceStarterResult<T> = Result<T, WorkspaceStarterError>;

impl WorkspaceService {
  pub async fn has_accepted_starter_package(
    &self,
    actor: UserId,
    package: &AssistantPackageIdentity,
  ) -> AuthResult<bool> {
    self.store.has_accepted_starter_package(actor, package).await
  }

  #[tracing::instrument(skip_all)]
  pub async fn create_workspace_starter(
    &self,
    actor: UserId,
    input: WorkspaceStarterInput,
    packages: Option<&AssistantPackageService>,
    auth: &AuthService,
  ) -> WorkspaceStarterResult<WorkspaceCreationOutcome> {
    if input.request_id.is_nil() {
      return Err(AuthError::InvalidInput("requestId must be a non-nil UUID".into()).into());
    }
    let fingerprint = input.fingerprint();
    // Accepted receipts win before source admission. A retired/unavailable
    // package must not hide the result or reserve a replacement Workspace.
    let mut allocation = if let Some(existing) = self
      .store
      .get_workspace_starter(actor, input.request_id, Some(&fingerprint))
      .await?
    {
      existing
    } else {
      let packages = packages.ok_or_else(|| AuthError::Storage("Workspace assistant packages unavailable".into()))?;
      let prepared = packages
        .prepare_workspace_creation(
          actor,
          &input.package,
          input.answers.clone(),
          input.project.as_ref(),
          input.setup.as_ref(),
          auth,
        )
        .await
        .map_err(|_| AuthError::InvalidInput("workspace assistant confirmation is unavailable or invalid".into()))?;
      if prepared.plan_digest(actor) != input.plan_digest
        || prepared.name != workspace_name(&input.name)?.display()
        || prepared.initial_content != input.initial_content
        || prepared.assistance_mode != input.assistance_mode
      {
        return Err(AuthError::InvalidInput("workspace assistant confirmation changed".into()).into());
      }
      let root = yjs::create_initial_workspace_doc(&prepared.name);
      self
        .store
        .allocate_workspace_starter(
          WorkspaceStarterReceipt {
            setup_definition: prepared
              .setup
              .as_ref()
              .map(|plan| {
                if !plan.execution_available {
                  return Err(assistant_packages::unavailable_project_components());
                }
                self
                  .automation
                  .as_ref()
                  .ok_or_else(assistant_packages::unavailable_project_components)?
                  .prepare_workspace_setup_definition(plan)
                  .map_err(|_| assistant_packages::unavailable_project_components())
              })
              .transpose()
              .map_err(ProjectStarterError::Database)?,
            prepared: Some(prepared.clone()),
            actor_id: actor,
            request_id: input.request_id,
            fingerprint,
            package: prepared.package,
            workspace_id: Uuid::new_v4(),
            name: prepared.name,
            assistance_mode: prepared.assistance_mode,
            assistance_saved: false,
          },
          root,
        )
        .await?
    };
    if !allocation.receipt.assistance_saved {
      match auth
        .acknowledge_workspace_starter_assistance(actor, input.request_id)
        .await
      {
        Ok(()) => allocation.receipt.assistance_saved = true,
        Err(_) => {
          // The known allocation survives a failed acknowledgement. Eligibility
          // still reads confirmed Auth preferences, never this proposed mode.
          if allocation.reason_code.is_none() {
            allocation.reason_code = Some("ASSISTANCE_SAVE_PENDING".into());
          }
          tracing::warn!(workspace_id=%allocation.workspace.id, "workspace assistance acknowledgement remains pending");
        }
      }
    }
    self
      .workspace_creation_outcome(allocation, packages, true, input.admission_confirmation.as_deref())
      .await
  }

  /// Canonical actor/request readback never acknowledges preferences or starts
  /// source admission. The allocation survives missing optional capabilities.
  pub async fn get_workspace_creation(
    &self,
    actor: UserId,
    request: Uuid,
    packages: Option<&AssistantPackageService>,
    _auth: &AuthService,
  ) -> WorkspaceStarterResult<Option<WorkspaceCreationOutcome>> {
    let Some(allocation) = self.store.get_workspace_starter(actor, request, None).await? else {
      return Ok(None);
    };
    Ok(Some(
      self
        .workspace_creation_outcome(allocation, packages, false, None)
        .await?,
    ))
  }

  /// Stop only this allocation's optional setup. The native Workspace/default
  /// and already acknowledged user-editable results remain intact.
  pub async fn stop_workspace_creation(
    &self,
    actor: UserId,
    request: Uuid,
    packages: Option<&AssistantPackageService>,
  ) -> WorkspaceStarterResult<Option<WorkspaceCreationOutcome>> {
    let Some(allocation) = self.store.get_workspace_starter(actor, request, None).await? else {
      return Ok(None);
    };
    if let Some(setup) = &allocation.setup {
      self
        .automation
        .as_ref()
        .ok_or_else(|| AuthError::Storage("Workspace workflow unavailable".into()))?
        .stop_run(actor, setup.run_id)
        .await
        .map_err(workspace_workflow_error)?;
      let refreshed = self
        .store
        .get_workspace_starter(actor, request, None)
        .await?
        .ok_or(WorkspaceStarterError::Conflict)?;
      return Ok(Some(
        self
          .workspace_creation_outcome(refreshed, packages, false, None)
          .await?,
      ));
    }
    if allocation
      .receipt
      .prepared
      .as_ref()
      .is_some_and(|prepared| prepared.project.is_some())
    {
      self
        .store
        .stop_project_starter(
          actor,
          StarterOperation::CreateWorkspace,
          allocation.workspace.id,
          request,
        )
        .await?;
    }
    Ok(Some(
      self
        .workspace_creation_outcome(allocation, packages, false, None)
        .await?,
    ))
  }

  async fn workspace_creation_outcome(
    &self,
    allocation: WorkspaceStarterAllocation,
    packages: Option<&AssistantPackageService>,
    resume: bool,
    confirmation: Option<&str>,
  ) -> WorkspaceStarterResult<WorkspaceCreationOutcome> {
    let project = if allocation
      .receipt
      .prepared
      .as_ref()
      .is_some_and(|prepared| prepared.project.is_some())
    {
      let accepted = self
        .store
        .get_project_starter(
          allocation.receipt.actor_id,
          StarterOperation::CreateWorkspace,
          allocation.workspace.id,
          allocation.receipt.request_id,
          Some(&allocation.receipt.fingerprint),
        )
        .await?
        .ok_or(ProjectStarterError::Conflict)?;
      Some(if let Some(packages) = packages {
        if resume {
          self.resume_accepted_project(accepted, confirmation, packages).await?
        } else {
          self.project_starter_outcome(accepted, packages).await?
        }
      } else {
        let status = match accepted.state {
          ProjectStarterState::Stopped => ProjectStarterStatus::Stopped,
          ProjectStarterState::StopRequested => ProjectStarterStatus::StopRequested,
          _ => ProjectStarterStatus::Unavailable,
        };
        ProjectStarterOutcome {
          documents: accepted
            .ids
            .documents
            .iter()
            .map(|ids| ProjectStarterDocumentView {
              component_id: ids.component_id.clone(),
              reserved_document_id: ids.doc_id,
              created: accepted.progress.documents.contains_key(&ids.component_id),
              placed: accepted
                .progress
                .documents
                .get(&ids.component_id)
                .is_some_and(|result| result.placed),
              external_id: None,
            })
            .collect(),
          accepted,
          accepted_descriptor: None,
          current_review: None,
          database: None,
          status,
          reason_code: Some("PROJECT_CAPABILITY_UNAVAILABLE".into()),
        }
      })
    } else {
      None
    };
    let setup = if let Some(mut accepted) = allocation.setup.clone() {
      if resume
        && allocation.receipt.assistance_saved
        && allocation.root_ready
        && allocation.tasks_ready
        && accepted.state == ProjectStarterState::Accepted
      {
        if let Some(packages) = packages {
          match packages.bind_workspace_setup(&accepted).await {
            Ok(plan) if plan.execution_available => {
              accepted = self.store.bind_workspace_setup(&accepted, plan).await?;
              if let Some(automation) = &self.automation {
                automation
                  .start_context_run(accepted.run_id)
                  .await
                  .map_err(workspace_workflow_error)?;
              }
            }
            Ok(_) => {}
            Err(error)
              if matches!(
                error.code,
                "MIX_ASSISTANT_PACKAGE_INVALID" | crate::database::ERR_FORBIDDEN | crate::database::ERR_NOT_FOUND
              ) => {}
            Err(error) => return Err(ProjectStarterError::Database(error).into()),
          }
        }
      }
      Some(self.workspace_setup_outcome(accepted, packages).await?)
    } else {
      None
    };
    let status = if !allocation.root_ready || !allocation.tasks_ready {
      WorkspaceCreationStatus::Unavailable
    } else if allocation.receipt.assistance_saved {
      WorkspaceCreationStatus::Ready
    } else {
      WorkspaceCreationStatus::AssistancePending
    };
    Ok(WorkspaceCreationOutcome {
      setup: setup.clone(),
      project: project.clone(),
      // Unavailable completed results remain inspectable, but their accepted
      // key cannot recreate them. Only unfinished child receipts need recovery.
      retry_required: setup.as_ref().is_some_and(|outcome| {
        matches!(
          outcome.accepted.state,
          ProjectStarterState::Accepted | ProjectStarterState::StopRequested
        )
      }) || !matches!(status, WorkspaceCreationStatus::Ready)
        || project.as_ref().is_some_and(|outcome| {
          matches!(
            outcome.accepted.state,
            ProjectStarterState::Accepted | ProjectStarterState::StopRequested
          )
        }),
      allocation,
      status,
    })
  }
}

/// Receipt facts needed for help discovery, without creator answers or preferences.
#[derive(Debug, Clone)]
pub struct WorkspaceSetupAssistanceReceipt {
  pub package: AssistantPackageIdentity,
  pub documents: Vec<WorkspaceSetupAssistanceDocument>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceSetupAssistanceDocument {
  pub source: myoxus_domain::assistant_package::AssistantDocumentComponentSource,
  pub created: ProjectStarterDocumentResult,
}

impl WorkspaceService {
  /// Published authored help only; creator answers and allocation preferences
  /// never become a shared Workspace configuration.
  #[tracing::instrument(skip_all)]
  pub async fn workspace_setup_assistance(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    packages: &AssistantPackageService,
    auth: &AuthService,
  ) -> WorkspaceStarterResult<Option<WorkspaceSetupAssistance>> {
    let Some(receipt) = self.store.workspace_setup_package(actor, workspace).await? else {
      return Ok(None);
    };
    if auth.get_assistance(actor, Some(workspace), None).await?.mode != AssistanceMode::Guided {
      return Ok(None);
    }
    let Some(descriptor) = packages
      .workspace_setup_descriptor(&receipt.package)
      .filter(|descriptor| descriptor.presentation.guided_help.is_some())
    else {
      return Ok(None);
    };
    let document_targets = packages
      .workspace_setup_help_targets(actor, workspace, &descriptor, &receipt.documents)
      .await?;
    Ok(Some(WorkspaceSetupAssistance {
      descriptor,
      document_targets,
    }))
  }
}

fn workspace_workflow_error(
  error: crate::workspace_automation::WorkspaceAutomationServiceError,
) -> WorkspaceStarterError {
  if error.code == crate::workspace_automation::ERR_AUTOMATION_FORBIDDEN {
    AuthError::ActionForbidden.into()
  } else {
    AuthError::Storage("Workspace workflow unavailable".into()).into()
  }
}
impl WorkspaceService {
  #[tracing::instrument(skip_all)]
  pub async fn retry_workspace_creation(
    &self,
    actor: UserId,
    request: Uuid,
    packages: Option<&AssistantPackageService>,
    auth: &AuthService,
  ) -> WorkspaceStarterResult<Option<WorkspaceCreationOutcome>> {
    let Some(mut allocation) = self.store.get_workspace_starter(actor, request, None).await? else {
      return Ok(None);
    };
    if !allocation.receipt.assistance_saved {
      auth.acknowledge_workspace_starter_assistance(actor, request).await?;
      allocation.receipt.assistance_saved = true;
    }
    if let Some(setup) = &allocation.setup {
      let automation = self
        .automation
        .as_ref()
        .ok_or_else(|| AuthError::Storage("Workspace workflow unavailable".into()))?;
      let run = automation
        .context_run(setup.run_id)
        .await
        .map_err(workspace_workflow_error)?;
      if run.status == myoxus_domain::workspace_automation::WorkspaceAutomationRunStatus::Queued
        && setup.state == ProjectStarterState::Accepted
      {
        return Ok(Some(
          self
            .workspace_creation_outcome(allocation, packages, true, None)
            .await?,
        ));
      }
      if !automation
        .can_retry_context_run(actor, &run)
        .await
        .map_err(workspace_workflow_error)?
      {
        return Err(AuthError::InvalidInput("Workspace setup is not retryable".into()).into());
      }
      automation
        .retry_run(actor, run.id)
        .await
        .map_err(workspace_workflow_error)?;
    }
    Ok(Some(
      self
        .workspace_creation_outcome(allocation, packages, false, None)
        .await?,
    ))
  }
  async fn workspace_setup_outcome(
    &self,
    accepted: assistant_packages::AcceptedWorkspaceSetup,
    packages: Option<&AssistantPackageService>,
  ) -> WorkspaceStarterResult<assistant_packages::WorkspaceSetupOutcome> {
    use myoxus_domain::workspace_automation::WorkspaceAutomationRunStatus as RunStatus;
    let mut reason = None;
    let run = if let Some(automation) = &self.automation {
      match automation.context_run(accepted.run_id).await {
        Ok(run) => Some(run),
        Err(error) if error.code == crate::workspace_automation::ERR_AUTOMATION_NOT_FOUND => None,
        Err(error) => return Err(workspace_workflow_error(error)),
      }
    } else {
      None
    };
    let (components, descriptor, current_review) = if let Some(packages) = packages {
      let components = packages
        .workspace_setup_views(&accepted)
        .await
        .map_err(ProjectStarterError::Database)?;
      let descriptor = packages.workspace_setup_descriptor(&accepted.original.package);
      let review = if accepted.state == ProjectStarterState::Accepted {
        match packages.bind_workspace_setup(&accepted).await {
          Ok(plan) => Some(plan),
          Err(error)
            if matches!(
              error.code,
              "MIX_ASSISTANT_PACKAGE_INVALID" | crate::database::ERR_FORBIDDEN | crate::database::ERR_NOT_FOUND
            ) =>
          {
            reason = Some("WORKSPACE_SETUP_SOURCE_UNAVAILABLE".into());
            None
          }
          Err(error) => return Err(ProjectStarterError::Database(error).into()),
        }
      } else {
        None
      };
      (components, descriptor, review)
    } else {
      reason = Some("WORKSPACE_SETUP_CAPABILITY_UNAVAILABLE".into());
      (
        accepted
          .reservations
          .iter()
          .map(|reserved| assistant_packages::WorkspaceSetupComponentView {
            component_id: reserved.component_id.clone(),
            reserved_id: reserved.result_id,
            result: accepted.progress.results.get(&reserved.component_id).cloned(),
            document_external_id: None,
            available: false,
          })
          .collect(),
        None,
        None,
      )
    };
    let mut can_retry = false;
    let mut can_stop = false;
    if let (Some(automation), Some(run)) = (&self.automation, &run) {
      can_retry = if run.status == RunStatus::Queued && accepted.state == ProjectStarterState::Accepted {
        current_review.as_ref().is_some_and(|review| review.execution_available)
          && !components
            .iter()
            .any(|component| component.result.is_some() && !component.available)
      } else if packages.is_some() && (current_review.is_some() || accepted.state == ProjectStarterState::Complete) {
        automation
          .can_retry_context_run(accepted.actor_id, run)
          .await
          .map_err(workspace_workflow_error)?
      } else {
        false
      };
      if matches!(
        accepted.state,
        ProjectStarterState::Accepted | ProjectStarterState::StopRequested
      ) && matches!(
        run.status,
        RunStatus::Queued | RunStatus::Running | RunStatus::Failed | RunStatus::DeadLetter
      ) {
        match automation.authorize_run_stop(accepted.actor_id, run.id).await {
          Ok(_) => can_stop = true,
          Err(error) if error.code == crate::workspace_automation::ERR_AUTOMATION_FORBIDDEN => {}
          Err(error) => return Err(workspace_workflow_error(error)),
        }
      }
    }
    let status = match accepted.state {
      ProjectStarterState::Stopped => ProjectStarterStatus::Stopped,
      ProjectStarterState::StopRequested => ProjectStarterStatus::StopRequested,
      _ if components
        .iter()
        .any(|component| component.result.is_some() && !component.available) =>
      {
        reason = Some("WORKSPACE_SETUP_RESULT_UNAVAILABLE".into());
        ProjectStarterStatus::Unavailable
      }
      _ if run.as_ref().is_some_and(|run| run.status == RunStatus::Skipped) => ProjectStarterStatus::Stopped,
      ProjectStarterState::Complete
        if components
          .iter()
          .all(|component| component.result.is_some() && component.available)
          && run.as_ref().is_some_and(|run| run.status == RunStatus::Succeeded) =>
      {
        ProjectStarterStatus::Ready
      }
      _ if reason.is_some() || run.is_none() => ProjectStarterStatus::Unavailable,
      _ if run
        .as_ref()
        .is_some_and(|run| matches!(run.status, RunStatus::Failed | RunStatus::DeadLetter))
        && !can_retry =>
      {
        reason = Some("WORKSPACE_SETUP_RUN_UNAVAILABLE".into());
        ProjectStarterStatus::Unavailable
      }
      _ => ProjectStarterStatus::Pending,
    };
    Ok(assistant_packages::WorkspaceSetupOutcome {
      status,
      accepted,
      accepted_descriptor: descriptor,
      current_review,
      run,
      components,
      can_retry,
      can_stop,
      reason_code: reason,
    })
  }
}
