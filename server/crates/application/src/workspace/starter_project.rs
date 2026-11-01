// SPDX-License-Identifier: AGPL-3.0-or-later
//! One accepted Project action on the existing starter receipt owner.
use super::*;
use crate::database::DatabaseServiceError;
use crate::workspace::assistant_packages::{AssistantPackageService, plan_digest};
use myoxus_domain::assistant_package::{AssistantPackageIdentity, AssistantPreparedProject, AssistantValue};
use myoxus_domain::database::{DatabaseRecord, DatabaseTemplateSelection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// One physical ledger key; Workspace-composed effects never create a child
/// application row or derive another request identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StarterOperation {
  CreateWorkspace,
  CreateProject,
  PrepareDocuments,
}
impl StarterOperation {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::CreateWorkspace => "create_workspace",
      Self::CreateProject => "create_project",
      Self::PrepareDocuments => "prepare_documents",
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectStarterInput {
  pub request_id: Uuid,
  pub package: AssistantPackageIdentity,
  pub answers: BTreeMap<String, AssistantValue>,
  pub locale: String,
  pub client_version: Option<u32>,
  pub plan_digest: String,
  pub admission_confirmation: Option<String>,
}
impl ProjectStarterInput {
  pub fn fingerprint(&self, workspace: WorkspaceId) -> String {
    format!(
      "{:x}",
      Sha256::digest(
        serde_json::to_vec(&(
          workspace,
          &self.package,
          &self.answers,
          &self.locale,
          self.client_version
        ))
        .expect("typed Project input")
      )
    )
  }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectStarterIds {
  pub database_id: Uuid,
  pub scaffold_rows: BTreeMap<String, Uuid>,
  #[serde(default)]
  pub documents: Vec<ProjectStarterDocumentIds>,
  #[serde(default)]
  pub folder_id: Option<String>,
  #[serde(default)]
  pub project_entry_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectStarterDocumentIds {
  pub component_id: String,
  pub doc_id: Uuid,
  pub entry_id: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectStarterProgress {
  #[serde(default)]
  pub folder_ready: bool,
  pub project_created: bool,
  pub documents: BTreeMap<String, ProjectStarterDocumentResult>,
  pub placement_complete: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectStarterDocumentResult {
  #[serde(default)]
  pub placed: bool,
  pub doc_id: Uuid,
  pub external_id: String,
  pub document_revision: i64,
  pub root_revision: i64,
}
/// Native lifecycle acknowledgement, constructed from a server-loaded receipt.
#[derive(Debug, Clone)]
pub struct ProjectDocumentAck {
  pub automation_effect: Option<myoxus_domain::workspace_automation::AutomationEffectFence>,
  pub operation: StarterOperation,
  pub actor_id: UserId,
  pub workspace_id: WorkspaceId,
  pub request_id: Uuid,
  pub fingerprint: String,
  pub component_id: String,
  pub admission: StarterDocumentAdmission,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectPlacementStage {
  NativeLink { component_id: String },
  CompleteDocuments,
  Folder,
  Document { component_id: String },
  Project,
}
#[derive(Debug, Clone)]
pub struct ProjectPlacementAck {
  pub automation_effect: Option<myoxus_domain::workspace_automation::AutomationEffectFence>,
  pub operation: StarterOperation,
  pub stage: ProjectPlacementStage,
  pub actor_id: UserId,
  pub workspace_id: WorkspaceId,
  pub request_id: Uuid,
  pub fingerprint: String,
  pub organizer_revision: String,
  pub admission: StarterDocumentAdmission,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectStarterAdmission {
  pub template_id: String,
  pub version: String,
  pub digest: String,
  pub variant: DatabaseTemplateSelection,
  pub effects_digest: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStarterState {
  Accepted,
  Complete,
  StopRequested,
  Stopped,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedProjectStarter {
  pub operation: StarterOperation,
  pub actor_id: UserId,
  pub workspace_id: WorkspaceId,
  pub request_id: Uuid,
  pub fingerprint: String,
  pub plan: AssistantPreparedProject,
  pub ids: ProjectStarterIds,
  pub state: ProjectStarterState,
  pub admission: ProjectStarterAdmission,
  pub progress: ProjectStarterProgress,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectStarterStatus {
  Ready,
  Pending,
  Stopped,
  StopRequested,
  ReReviewRequired,
  Unavailable,
}
#[derive(Debug, Clone)]
pub struct ProjectStarterDocumentView {
  pub component_id: String,
  pub reserved_document_id: Uuid,
  pub external_id: Option<String>,
  pub created: bool,
  pub placed: bool,
}
#[derive(Debug, Clone)]
pub struct ProjectStarterOutcome {
  pub accepted_descriptor: Option<myoxus_domain::assistant_package::AssistantPackageDescriptor>,
  pub documents: Vec<ProjectStarterDocumentView>,
  pub accepted: AcceptedProjectStarter,
  pub current_review: Option<AssistantPreparedProject>,
  pub database: Option<DatabaseRecord>,
  pub status: ProjectStarterStatus,
  pub reason_code: Option<String>,
}
#[derive(Debug, thiserror::Error)]
pub enum ProjectStarterError {
  #[error(transparent)]
  Auth(#[from] AuthError),
  #[error(transparent)]
  Database(#[from] DatabaseServiceError),
  #[error("Project request conflicts with accepted input or ownership")]
  Conflict,
  #[error("accepted Project result is gone")]
  Gone { database_id: Uuid },
}
pub type ProjectStarterResult<T> = Result<T, ProjectStarterError>;

impl WorkspaceService {
  /// Readback does not require the client to reconstruct a request fingerprint.
  /// Native persistence rechecks actor ownership and current Workspace Read.
  pub async fn get_project_starter(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
    packages: &AssistantPackageService,
  ) -> ProjectStarterResult<Option<ProjectStarterOutcome>> {
    let Some(accepted) = self
      .store
      .get_project_starter(actor, StarterOperation::CreateProject, workspace, request, None)
      .await?
    else {
      return Ok(None);
    };
    Ok(Some(self.project_starter_outcome(accepted, packages).await?))
  }
  /// Confirmation replay compares original input before resolving any result.
  pub async fn get_project_starter_for_input(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    input: &ProjectStarterInput,
    packages: &AssistantPackageService,
  ) -> ProjectStarterResult<Option<ProjectStarterOutcome>> {
    let fingerprint = input.fingerprint(workspace);
    let Some(accepted) = self
      .store
      .get_project_starter(
        actor,
        StarterOperation::CreateProject,
        workspace,
        input.request_id,
        Some(&fingerprint),
      )
      .await?
    else {
      return Ok(None);
    };
    Ok(Some(self.project_starter_outcome(accepted, packages).await?))
  }
  pub async fn stop_project_starter(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
    packages: &AssistantPackageService,
  ) -> ProjectStarterResult<ProjectStarterOutcome> {
    let accepted = self
      .store
      .stop_project_starter(actor, StarterOperation::CreateProject, workspace, request)
      .await?;
    self.project_starter_outcome(accepted, packages).await
  }
  pub(super) async fn project_starter_outcome(
    &self,
    accepted: AcceptedProjectStarter,
    packages: &AssistantPackageService,
  ) -> ProjectStarterResult<ProjectStarterOutcome> {
    let database = if accepted.progress.project_created || accepted.state == ProjectStarterState::Complete {
      match packages.read_project_result(&accepted).await {
        Ok(record) => Some(record),
        Err(error) if accepted.operation == StarterOperation::CreateWorkspace && child_result_unavailable(&error) => {
          None
        }
        Err(error) => return Err(error),
      }
    } else {
      None
    };
    // A completed identity stays visible even if its package was retired or
    // removed. Fresh source admission must never hide an accepted native result.
    let current_review = if (accepted.progress.project_created && database.is_none())
      || accepted.state == ProjectStarterState::Complete
      || accepted.state == ProjectStarterState::Stopped
    {
      None
    } else {
      match packages.prepare_accepted_project(&accepted).await {
        Ok(review) => Some(review),
        Err(error) if error.code == "MIX_ASSISTANT_PACKAGE_INVALID" || error.code == crate::database::ERR_FORBIDDEN => {
          None
        }
        Err(error) => return Err(error.into()),
      }
    };
    let documents = packages.project_document_views(&accepted).await?;
    let status = match accepted.state {
      ProjectStarterState::Complete => {
        if database.as_ref().is_some_and(|record| {
          record.database.deleted_at.is_none()
            && record
              .managed_schema
              .as_ref()
              .is_some_and(|schema| schema.readiness == myoxus_domain::database::DatabaseManagedSchemaReadiness::Ready)
        }) {
          ProjectStarterStatus::Ready
        } else {
          ProjectStarterStatus::Unavailable
        }
      }
      ProjectStarterState::StopRequested => ProjectStarterStatus::StopRequested,
      ProjectStarterState::Stopped => ProjectStarterStatus::Stopped,
      ProjectStarterState::Accepted => match &current_review {
        None => ProjectStarterStatus::Unavailable,
        Some(review) if packages.project_admission(review)?.effects_digest != accepted.admission.effects_digest => {
          ProjectStarterStatus::ReReviewRequired
        }
        Some(_) => ProjectStarterStatus::Pending,
      },
    };
    let status = if matches!(
      status,
      ProjectStarterStatus::Ready | ProjectStarterStatus::Pending | ProjectStarterStatus::ReReviewRequired
    ) && (database.as_ref().is_some_and(|record| {
      record.database.deleted_at.is_some()
        || !record
          .managed_schema
          .as_ref()
          .is_some_and(|schema| schema.readiness == myoxus_domain::database::DatabaseManagedSchemaReadiness::Ready)
    }) || current_review
      .as_ref()
      .is_some_and(|review| !review.execution_available))
    {
      ProjectStarterStatus::Unavailable
    } else {
      status
    };
    let status = if matches!(
      status,
      ProjectStarterStatus::Ready | ProjectStarterStatus::Pending | ProjectStarterStatus::ReReviewRequired
    ) && documents
      .iter()
      .any(|document| document.created && document.external_id.is_none())
    {
      ProjectStarterStatus::Unavailable
    } else {
      status
    };
    let status = if accepted.progress.project_created
      && database.is_none()
      && !matches!(
        status,
        ProjectStarterStatus::Stopped | ProjectStarterStatus::StopRequested
      ) {
      ProjectStarterStatus::Unavailable
    } else {
      status
    };
    let reason_code = match status {
      ProjectStarterStatus::Unavailable => Some(
        database
          .as_ref()
          .and_then(|record| {
            if record.database.deleted_at.is_some() {
              Some("PROJECT_RESULT_TRASHED".into())
            } else {
              record
                .managed_schema
                .as_ref()
                .and_then(|schema| schema.reason_code.clone())
            }
          })
          .unwrap_or_else(|| {
            if accepted.progress.project_created && database.is_none() {
              "PROJECT_RESULT_UNAVAILABLE".into()
            } else {
              "PROJECT_SOURCE_UNAVAILABLE".into()
            }
          }),
      ),
      ProjectStarterStatus::ReReviewRequired => Some("PROJECT_REVIEW_CHANGED".into()),
      ProjectStarterStatus::StopRequested => Some("PROJECT_STOP_REQUESTED".into()),
      _ => None,
    };
    let accepted_descriptor = packages.accepted_project_descriptor(&accepted);
    Ok(ProjectStarterOutcome {
      accepted_descriptor,
      documents,
      accepted,
      current_review,
      database,
      status,
      reason_code,
    })
  }
  #[tracing::instrument(skip_all)]
  pub async fn create_project_starter(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    input: ProjectStarterInput,
    packages: &AssistantPackageService,
  ) -> ProjectStarterResult<ProjectStarterOutcome> {
    if input.request_id.is_nil() {
      return Err(AuthError::InvalidInput("requestId must be non-nil".into()).into());
    }
    let fingerprint = input.fingerprint(workspace);
    let existing = self
      .store
      .get_project_starter(
        actor,
        StarterOperation::CreateProject,
        workspace,
        input.request_id,
        Some(&fingerprint),
      )
      .await?;
    let accepted = match existing {
      Some(accepted) => accepted,
      None => {
        let plan = packages
          .prepare_project(
            actor,
            workspace,
            &input.package,
            input.answers.clone(),
            &input.locale,
            input.client_version,
          )
          .await?;
        if !plan.execution_available {
          return Err(ProjectStarterError::Database(
            crate::workspace::assistant_packages::unavailable_project_components(),
          ));
        }
        if plan_digest(&plan) != input.plan_digest {
          return Err(ProjectStarterError::Conflict);
        }
        let admission = packages.project_admission(&plan)?;
        self
          .store
          .accept_project_starter(actor, workspace, input.request_id, &fingerprint, plan, admission)
          .await?
      }
    };
    self
      .resume_accepted_project(accepted, input.admission_confirmation.as_deref(), packages)
      .await
  }

  pub(super) async fn resume_accepted_project(
    &self,
    accepted: AcceptedProjectStarter,
    admission_confirmation: Option<&str>,
    packages: &AssistantPackageService,
  ) -> ProjectStarterResult<ProjectStarterOutcome> {
    let actor = accepted.actor_id;
    let workspace = accepted.workspace_id;
    let request = accepted.request_id;
    let fingerprint = accepted.fingerprint.clone();
    let operation = accepted.operation;
    if accepted.state != ProjectStarterState::Accepted {
      return self.project_starter_outcome(accepted, packages).await;
    }
    if operation == StarterOperation::CreateWorkspace && accepted.progress.project_created {
      if let Err(error) = packages.read_project_result(&accepted).await {
        if child_result_unavailable(&error) {
          return self.project_starter_outcome(accepted, packages).await;
        }
        return Err(error);
      }
    }

    let review = match packages.prepare_accepted_project(&accepted).await {
      Ok(review) => review,
      Err(error) if error.code == "MIX_ASSISTANT_PACKAGE_INVALID" => {
        return self.project_starter_outcome(accepted, packages).await;
      }
      Err(error) => return Err(error.into()),
    };
    if !review.execution_available {
      let documents = packages.project_document_views(&accepted).await?;
      let accepted_descriptor = packages.accepted_project_descriptor(&accepted);
      let database = if accepted.progress.project_created {
        match packages.read_project_result(&accepted).await {
          Ok(record) => Some(record),
          Err(error) if accepted.operation == StarterOperation::CreateWorkspace && child_result_unavailable(&error) => {
            None
          }
          Err(error) => return Err(error),
        }
      } else {
        None
      };
      return Ok(ProjectStarterOutcome {
        accepted_descriptor,
        documents,
        accepted,
        current_review: Some(review),
        database,
        status: ProjectStarterStatus::Unavailable,
        reason_code: Some("PROJECT_COMPONENT_UNAVAILABLE".into()),
      });
    }
    let admission = packages.project_admission(&review)?;
    if admission.effects_digest != accepted.admission.effects_digest
      && admission_confirmation != Some(plan_digest(&review).as_str())
    {
      let documents = packages.project_document_views(&accepted).await?;
      let accepted_descriptor = packages.accepted_project_descriptor(&accepted);
      let database = if accepted.progress.project_created {
        match packages.read_project_result(&accepted).await {
          Ok(record) => Some(record),
          Err(error) if accepted.operation == StarterOperation::CreateWorkspace && child_result_unavailable(&error) => {
            None
          }
          Err(error) => return Err(error),
        }
      } else {
        None
      };
      return Ok(ProjectStarterOutcome {
        accepted_descriptor,
        documents,
        accepted,
        current_review: Some(review),
        database,
        status: ProjectStarterStatus::ReReviewRequired,
        reason_code: Some("PROJECT_REVIEW_CHANGED".into()),
      });
    }
    let state = packages.materialize_accepted_project(&accepted, &review).await?;
    let (mut accepted, _) = self
      .store
      .publish_project_starter(
        actor,
        operation,
        workspace,
        request,
        &fingerprint,
        admission,
        review.clone(),
        state,
      )
      .await?;
    // Persist the actual destination before interpreting any document copy.
    if accepted.state == ProjectStarterState::Accepted
      && accepted.plan.folder.is_some()
      && !accepted.progress.folder_ready
    {
      let result = packages
        .place_project_stage(&accepted, ProjectPlacementStage::Folder)
        .await;
      let winner = self
        .store
        .get_project_starter(actor, operation, workspace, request, Some(&fingerprint))
        .await?
        .ok_or(ProjectStarterError::Conflict)?;
      if let Err(error) = result {
        if !winner.progress.folder_ready && winner.state == ProjectStarterState::Accepted {
          return Err(error);
        }
      }
      accepted = winner;
    }
    for ids in accepted.ids.documents.clone() {
      if accepted.state != ProjectStarterState::Accepted {
        break;
      }
      if !accepted.progress.documents.contains_key(&ids.component_id) {
        let result = packages.create_project_document(&accepted, &ids.component_id).await;
        let winner = self
          .store
          .get_project_starter(actor, operation, workspace, request, Some(&fingerprint))
          .await?
          .ok_or(ProjectStarterError::Conflict)?;
        if let Err(error) = result {
          if !winner.progress.documents.contains_key(&ids.component_id) && winner.state == ProjectStarterState::Accepted
          {
            return Err(error);
          }
        }
        accepted = winner;
      }
      if accepted.state == ProjectStarterState::Accepted
        && accepted
          .progress
          .documents
          .get(&ids.component_id)
          .is_some_and(|result| !result.placed)
      {
        let result = packages
          .place_project_stage(
            &accepted,
            ProjectPlacementStage::Document {
              component_id: ids.component_id.clone(),
            },
          )
          .await;
        let winner = self
          .store
          .get_project_starter(actor, operation, workspace, request, Some(&fingerprint))
          .await?
          .ok_or(ProjectStarterError::Conflict)?;
        if let Err(error) = result {
          if winner
            .progress
            .documents
            .get(&ids.component_id)
            .is_some_and(|result| !result.placed)
            && winner.state == ProjectStarterState::Accepted
          {
            return Err(error);
          }
        }
        accepted = winner;
      }
    }
    if accepted.state == ProjectStarterState::Accepted && !accepted.progress.placement_complete {
      let result = packages
        .place_project_stage(&accepted, ProjectPlacementStage::Project)
        .await;
      let winner = self
        .store
        .get_project_starter(actor, operation, workspace, request, Some(&fingerprint))
        .await?
        .ok_or(ProjectStarterError::Conflict)?;
      if let Err(error) = result {
        if !winner.progress.placement_complete && winner.state == ProjectStarterState::Accepted {
          return Err(error);
        }
      }
      accepted = winner;
    }
    self.project_starter_outcome(accepted, packages).await
  }
}

fn child_result_unavailable(error: &ProjectStarterError) -> bool {
  matches!(error, ProjectStarterError::Gone { .. } | ProjectStarterError::Conflict)
    || matches!(error,ProjectStarterError::Database(error) if error.code==crate::database::ERR_FORBIDDEN)
}
