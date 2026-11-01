// SPDX-License-Identifier: AGPL-3.0-or-later
//! Explicit contextual document creation uses the existing starter ledger and ACKs.
use super::*;
use crate::auth::{AuthService, EffectiveAssistance};
use crate::workspace::assistant_packages::AssistantPackageService;
use myoxus_domain::assistant_package::*;
use myoxus_domain::database::DatabaseManagedSchemaInstallation;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct PreparedContextDocuments {
  pub plan: AssistantPreparedContextDocuments,
  pub assistance: EffectiveAssistance,
  pub plan_digest: String,
  pub context: assistant_packages::ContextDocumentContext,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextDocumentStarterInput {
  pub request_id: Uuid,
  pub package: AssistantPackageIdentity,
  pub answers: BTreeMap<String, AssistantValue>,
  pub locale: String,
  pub client_version: u32,
  pub plan_digest: String,
  pub admission_confirmation: Option<String>,
}
impl ContextDocumentStarterInput {
  pub fn fingerprint(&self, workspace: WorkspaceId, target: &ContextDocumentTarget) -> String {
    format!(
      "{:x}",
      Sha256::digest(
        serde_json::to_vec(&(
          workspace,
          target,
          &self.package,
          &self.answers,
          &self.locale,
          self.client_version
        ))
        .expect("typed document request")
      )
    )
  }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextDocumentStarterIds {
  pub documents: Vec<ProjectStarterDocumentIds>,
  pub folder_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextDocumentAdmission {
  pub installation: DatabaseManagedSchemaInstallation,
  pub effects_digest: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedContextDocuments {
  pub run_id: Option<Uuid>,
  pub actor_id: UserId,
  pub workspace_id: WorkspaceId,
  pub request_id: Uuid,
  pub fingerprint: String,
  pub plan: AssistantPreparedContextDocuments,
  pub ids: ContextDocumentStarterIds,
  pub admission: ContextDocumentAdmission,
  pub state: ProjectStarterState,
  pub progress: ProjectStarterProgress,
}
#[derive(Debug, Clone)]
pub struct ContextDocumentStarterOutcome {
  pub run: Option<myoxus_domain::workspace_automation::WorkspaceAutomationRun>,
  pub can_retry: bool,
  pub can_stop: bool,
  pub accepted: AcceptedContextDocuments,
  pub accepted_descriptor: Option<AssistantPackageDescriptor>,
  pub current_review: Option<AssistantPreparedContextDocuments>,
  pub documents: Vec<ProjectStarterDocumentView>,
  pub status: ProjectStarterStatus,
  pub reason_code: Option<String>,
  pub assistance: EffectiveAssistance,
}
pub type ContextDocumentStarterResult<T> = ProjectStarterResult<T>;

/// These closed native authorities acknowledge documents on the same starter ledger.
#[derive(Debug, Clone)]
pub enum StarterDocumentAdmission {
  WorkspaceSetup,
  ProjectSetup {
    installation: DatabaseManagedSchemaInstallation,
  },
  TaskContainer {
    target: ContextDocumentTarget,
    installation: DatabaseManagedSchemaInstallation,
  },
}
#[derive(Debug, Clone)]
pub enum StarterDocumentOrigin {
  WorkspaceSetup {
    links: BTreeMap<String, StarterNativeLink>,
  },
  Project {
    database_id: Uuid,
    entry_id: Option<String>,
  },
  TaskContainer(ContextDocumentTarget),
}
#[derive(Debug, Clone)]
pub struct StarterNativeLink {
  pub entry_id: String,
  pub target: myoxus_domain::workspace_automation::WorkspaceSetupResult,
}
/// Transaction-local projection of the same persisted receipt. It is neither
/// another acceptance record nor authority supplied by an external caller.
#[derive(Debug, Clone)]
pub struct StarterDocumentReceipt {
  pub operation: StarterOperation,
  pub actor_id: UserId,
  pub workspace_id: WorkspaceId,
  pub request_id: Uuid,
  pub fingerprint: String,
  pub origin: StarterDocumentOrigin,
  pub folder: Option<AssistantFolderDestination>,
  pub documents: Vec<AssistantPreparedDocumentComponent>,
  pub people: Vec<UserId>,
  pub client_version: Option<u32>,
  pub ids: Vec<ProjectStarterDocumentIds>,
  pub folder_id: Option<String>,
  pub state: ProjectStarterState,
  pub progress: ProjectStarterProgress,
}
impl AcceptedProjectStarter {
  pub fn document_receipt(&self) -> StarterDocumentReceipt {
    StarterDocumentReceipt {
      operation: self.operation,
      actor_id: self.actor_id,
      workspace_id: self.workspace_id,
      request_id: self.request_id,
      fingerprint: self.fingerprint.clone(),
      origin: StarterDocumentOrigin::Project {
        database_id: self.ids.database_id,
        entry_id: self.ids.project_entry_id.clone(),
      },
      folder: self.plan.folder.clone(),
      documents: self.plan.documents.clone(),
      people: self.plan.setup.people.clone(),
      client_version: self.plan.client_version,
      ids: self.ids.documents.clone(),
      folder_id: self.ids.folder_id.clone(),
      state: self.state,
      progress: self.progress.clone(),
    }
  }
}
impl AcceptedContextDocuments {
  pub fn document_receipt(&self) -> StarterDocumentReceipt {
    StarterDocumentReceipt {
      operation: StarterOperation::PrepareDocuments,
      actor_id: self.actor_id,
      workspace_id: self.workspace_id,
      request_id: self.request_id,
      fingerprint: self.fingerprint.clone(),
      origin: StarterDocumentOrigin::TaskContainer(self.plan.target.clone()),
      folder: Some(self.plan.folder.clone()),
      documents: self.plan.documents.clone(),
      people: self
        .plan
        .answers
        .values()
        .filter_map(|value| {
          if let AssistantValue::Members(ids) = value {
            Some(ids.as_slice())
          } else {
            None
          }
        })
        .flatten()
        .copied()
        .collect(),
      client_version: Some(self.plan.client_version),
      ids: self.ids.documents.clone(),
      folder_id: Some(self.ids.folder_id.clone()),
      state: self.state,
      progress: self.progress.clone(),
    }
  }
}

impl WorkspaceService {
  #[tracing::instrument(skip_all)]
  pub async fn get_context_documents(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
    packages: &AssistantPackageService,
    auth: &AuthService,
  ) -> ContextDocumentStarterResult<Option<ContextDocumentStarterOutcome>> {
    let Some(accepted) = self
      .store
      .get_context_documents(actor, workspace, request, None)
      .await?
    else {
      return Ok(None);
    };
    Ok(Some(self.context_documents_outcome(accepted, packages, auth).await?))
  }
  #[tracing::instrument(skip_all)]
  pub async fn stop_context_documents(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
    packages: &AssistantPackageService,
    auth: &AuthService,
  ) -> ContextDocumentStarterResult<ContextDocumentStarterOutcome> {
    let existing = self
      .store
      .get_context_documents(actor, workspace, request, None)
      .await?
      .ok_or(ProjectStarterError::Conflict)?;
    if let Some(run_id) = existing.run_id {
      self
        .automation
        .as_ref()
        .ok_or_else(|| AuthError::Storage("context workflow unavailable".into()))?
        .stop_run(actor, run_id)
        .await
        .map_err(|_| AuthError::Storage("context workflow stop unavailable".into()))?;
      return self
        .get_context_documents(actor, workspace, request, packages, auth)
        .await?
        .ok_or(ProjectStarterError::Conflict);
    }
    let accepted = self.store.stop_context_documents(actor, workspace, request).await?;
    self.context_documents_outcome(accepted, packages, auth).await
  }
  #[tracing::instrument(skip_all)]
  pub async fn retry_context_documents(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
    packages: &AssistantPackageService,
    auth: &AuthService,
  ) -> ContextDocumentStarterResult<ContextDocumentStarterOutcome> {
    let accepted = self
      .store
      .get_context_documents(actor, workspace, request, None)
      .await?
      .ok_or(ProjectStarterError::Conflict)?;
    let outcome = self.context_documents_outcome(accepted, packages, auth).await?;
    if !outcome.can_retry {
      return Err(ProjectStarterError::Conflict);
    }
    let run = outcome.run.as_ref().ok_or(ProjectStarterError::Conflict)?;
    self
      .automation
      .as_ref()
      .ok_or_else(|| AuthError::Storage("context workflow unavailable".into()))?
      .retry_run(actor, run.id)
      .await
      .map_err(|_| AuthError::Storage("context workflow retry unavailable".into()))?;
    self
      .get_context_documents(actor, workspace, request, packages, auth)
      .await?
      .ok_or(ProjectStarterError::Conflict)
  }
  #[tracing::instrument(skip_all)]
  pub async fn create_context_documents(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    input: ContextDocumentStarterInput,
    packages: &AssistantPackageService,
    auth: &AuthService,
  ) -> ContextDocumentStarterResult<ContextDocumentStarterOutcome> {
    if input.request_id.is_nil() || input.client_version == 0 {
      return Err(
        AuthError::InvalidInput("native action requires a request identity and client version".into()).into(),
      );
    }
    let fingerprint = input.fingerprint(workspace, &target);
    let mut accepted = match self
      .store
      .get_context_documents(actor, workspace, input.request_id, Some(&fingerprint))
      .await?
    {
      Some(accepted) => accepted,
      None => {
        let prepared = packages
          .prepare_context_documents(
            actor,
            workspace,
            target,
            &input.package,
            input.answers.clone(),
            &input.locale,
            input.client_version,
            auth,
          )
          .await?;
        if prepared.plan_digest != input.plan_digest {
          return Err(ProjectStarterError::Conflict);
        }
        let admission = assistant_packages::context_documents_admission(&prepared.plan);
        let definition = self
          .automation
          .as_ref()
          .ok_or_else(|| AuthError::Storage("context workflow unavailable".into()))?
          .prepare_context_definition(&prepared.plan)
          .map_err(|_| AuthError::Storage("context workflow unavailable".into()))?;
        self
          .store
          .accept_context_documents(
            actor,
            workspace,
            input.request_id,
            &fingerprint,
            prepared.plan,
            admission,
            definition,
          )
          .await?
      }
    };
    if accepted.state != ProjectStarterState::Accepted {
      return self.context_documents_outcome(accepted, packages, auth).await;
    }
    let review = match packages.prepare_accepted_context_documents(&accepted).await {
      Ok(review) => review,
      Err(error) if error.is_retryable_storage_failure() => return Err(error.into()),
      Err(_) => return self.context_documents_outcome(accepted, packages, auth).await,
    };
    let admission = assistant_packages::context_documents_admission(&review);
    if admission.effects_digest != accepted.admission.effects_digest
      && (accepted.run_id.is_some()
        || input.admission_confirmation.as_deref()
          != Some(assistant_packages::context_documents_digest(&review).as_str()))
    {
      return self.context_documents_outcome(accepted, packages, auth).await;
    }
    accepted = self.store.review_context_documents(&accepted, admission).await?;
    let run_id = accepted
      .run_id
      .ok_or_else(|| AuthError::InvalidInput("accepted workflow implementation unavailable".into()))?;
    let automation = self
      .automation
      .as_ref()
      .ok_or_else(|| AuthError::Storage("context workflow unavailable".into()))?;
    automation
      .start_context_run(run_id)
      .await
      .map_err(|_| AuthError::Storage("context workflow admission unavailable".into()))?;
    self.context_documents_outcome(accepted, packages, auth).await
  }
  async fn context_documents_outcome(
    &self,
    accepted: AcceptedContextDocuments,
    packages: &AssistantPackageService,
    auth: &AuthService,
  ) -> ContextDocumentStarterResult<ContextDocumentStarterOutcome> {
    let current = packages
      .context_document_context(accepted.actor_id, accepted.workspace_id, &accepted.plan.target)
      .await;
    let ordinary = current.as_ref().map(|(_, _, ordinary)| *ordinary).unwrap_or(false);
    let assistance = packages
      .context_assistance(
        accepted.actor_id,
        accepted.workspace_id,
        &accepted.plan.target,
        ordinary,
        auth,
      )
      .await?;
    let documents = packages.context_document_views(&accepted).await?;
    if let Err(error) = &current {
      if error.is_retryable_storage_failure() {
        return Err(error.clone().into());
      }
    }
    let current_review = if accepted.state == ProjectStarterState::Accepted && current.is_ok() {
      match packages.prepare_accepted_context_documents(&accepted).await {
        Ok(review) => Some(review),
        Err(error) if error.is_retryable_storage_failure() => return Err(error.into()),
        Err(_) => None,
      }
    } else {
      None
    };
    let run = match (accepted.run_id, self.automation.as_ref()) {
      (Some(run_id), Some(automation)) => match automation.context_run(run_id).await {
        Ok(run) => Some(run),
        Err(error) if error.code == crate::workspace_automation::ERR_AUTOMATION_NOT_FOUND => None,
        Err(_) => return Err(AuthError::Storage("context workflow readback unavailable".into()).into()),
      },
      _ => None,
    };
    let status = match accepted.state {
      ProjectStarterState::Stopped => ProjectStarterStatus::Stopped,
      ProjectStarterState::StopRequested => ProjectStarterStatus::StopRequested,
      ProjectStarterState::Complete if documents.iter().all(|doc| doc.external_id.is_some()) => {
        ProjectStarterStatus::Ready
      }
      ProjectStarterState::Complete => ProjectStarterStatus::Unavailable,
      ProjectStarterState::Accepted if run.is_none() => ProjectStarterStatus::Unavailable,
      ProjectStarterState::Accepted => match &current_review {
        None => ProjectStarterStatus::Unavailable,
        Some(review)
          if assistant_packages::context_documents_admission(review).effects_digest
            != accepted.admission.effects_digest =>
        {
          ProjectStarterStatus::ReReviewRequired
        }
        Some(_) => ProjectStarterStatus::Pending,
      },
    };
    let reason_code = match status {
      ProjectStarterStatus::Unavailable => Some("CONTEXT_DOCUMENT_UNAVAILABLE".into()),
      ProjectStarterStatus::ReReviewRequired => Some("CONTEXT_DOCUMENT_REVIEW_CHANGED".into()),
      ProjectStarterStatus::StopRequested => Some("DOCUMENT_STOP_REQUESTED".into()),
      _ => None,
    };
    let can_control = match (run.as_ref(), self.automation.as_ref()) {
      (Some(run), Some(automation)) => match automation.authorize_run_stop(accepted.actor_id, run.id).await {
        Ok(_) => true,
        Err(error) if error.code == crate::workspace_automation::ERR_AUTOMATION_FORBIDDEN => false,
        Err(_) => return Err(AuthError::Storage("context workflow authority unavailable".into()).into()),
      },
      _ => false,
    };
    let can_stop = accepted.state == ProjectStarterState::Accepted
      && can_control
      && run.as_ref().is_some_and(|run| {
        matches!(
          run.status,
          myoxus_domain::workspace_automation::WorkspaceAutomationRunStatus::Queued
            | myoxus_domain::workspace_automation::WorkspaceAutomationRunStatus::Running
            | myoxus_domain::workspace_automation::WorkspaceAutomationRunStatus::Failed
            | myoxus_domain::workspace_automation::WorkspaceAutomationRunStatus::DeadLetter
        )
      });
    let can_retry = match (run.as_ref(), self.automation.as_ref()) {
      (Some(run), Some(automation)) => automation
        .can_retry_context_run(accepted.actor_id, run)
        .await
        .map_err(|_| AuthError::Storage("context workflow retry authority unavailable".into()))?,
      _ => false,
    };
    let accepted_descriptor = packages.context_descriptor(&accepted);
    Ok(ContextDocumentStarterOutcome {
      run,
      can_retry,
      can_stop,
      accepted,
      accepted_descriptor,
      current_review,
      documents,
      status,
      reason_code,
      assistance,
    })
  }
}
