// SPDX-License-Identifier: AGPL-3.0-or-later
//! Contextual document transport over the existing native preparation owner.
//! Neither a client target nor a prepared plan grants execution authority.
use super::*;
use myoxus_domain::assistant_package::{AssistantPreparedContextDocuments, ContextDocumentTarget};

#[derive(InputObject)]
pub struct ContextDocumentTargetInput {
  pub database_id: ID,
  pub task_id: Option<ID>,
}

impl TryFrom<ContextDocumentTargetInput> for ContextDocumentTarget {
  type Error = Error;

  fn try_from(value: ContextDocumentTargetInput) -> Result<Self> {
    Ok(Self {
      database_id: parse_uuid_id(&value.database_id, "databaseId")?,
      task_id: value.task_id.map(|id| parse_uuid_id(&id, "taskId")).transpose()?,
    })
  }
}

#[derive(SimpleObject)]
#[graphql(name = "ContextDocumentTarget")]
pub struct ContextDocumentTargetObjectType {
  pub database_id: ID,
  pub task_id: Option<ID>,
}

impl From<ContextDocumentTarget> for ContextDocumentTargetObjectType {
  fn from(value: ContextDocumentTarget) -> Self {
    Self {
      database_id: ID(value.database_id.to_string()),
      task_id: value.task_id.map(|id| ID(id.to_string())),
    }
  }
}

#[derive(InputObject)]
pub struct PrepareContextDocumentsInput {
  pub target: ContextDocumentTargetInput,
  pub identity: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub locale: String,
  pub client_version: i32,
}

#[derive(InputObject)]
pub struct ApplyContextDocumentsInput {
  pub workspace_id: ID,
  pub target: ContextDocumentTargetInput,
  pub request_id: ID,
  pub identity: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub locale: String,
  pub client_version: i32,
  pub plan_digest: String,
  pub admission_confirmation: Option<String>,
}

#[derive(InputObject)]
pub struct RetryContextDocumentsInput {
  pub workspace_id: ID,
  pub request_id: ID,
}

#[derive(InputObject)]
pub struct StopContextDocumentsInput {
  pub workspace_id: ID,
  pub request_id: ID,
}

/// Server admission facts stay native. The client confirms the digest and
/// declared answers rather than supplying an installed schema or document body.
#[derive(SimpleObject)]
#[graphql(name = "PreparedContextDocuments")]
pub struct PreparedContextDocumentsObjectType {
  pub target: ContextDocumentTargetObjectType,
  pub package: AssistantPackageIdentityObjectType,
  pub answers: Vec<AssistantNamedValueObjectType>,
  pub locale: String,
  pub client_version: i32,
  pub documents: Vec<AssistantPreparedDocumentComponentObjectType>,
  pub folder: AssistantFolderDestinationObjectType,
  pub execution_available: bool,
  pub plan_digest: String,
}

fn map_prepared_context_documents(
  value: AssistantPreparedContextDocuments,
  plan_digest: String,
) -> Result<PreparedContextDocumentsObjectType> {
  Ok(PreparedContextDocumentsObjectType {
    target: value.target.into(),
    package: value.package.into(),
    answers: value
      .answers
      .into_iter()
      .map(|(input, value)| AssistantNamedValueObjectType {
        input,
        value: value.into(),
      })
      .collect(),
    locale: value.locale,
    client_version: i32::try_from(value.client_version)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid clientVersion".into())))?,
    documents: value.documents.into_iter().map(Into::into).collect(),
    folder: value.folder.into(),
    execution_available: value.execution_available,
    plan_digest,
  })
}

#[derive(SimpleObject)]
#[graphql(name = "ContextDocumentsPreparation")]
pub struct ContextDocumentsPreparationObjectType {
  pub plan: PreparedContextDocumentsObjectType,
  pub assistance: crate::graphql::auth::EffectiveAssistanceType,
  pub context: ContextDocumentContextObjectType,
}

/// These names come from the current authorized target, never a receipt cache.
#[derive(SimpleObject)]
#[graphql(name = "ContextDocumentContext")]
pub struct ContextDocumentContextObjectType {
  pub container_title: String,
  pub task_title: Option<String>,
}

impl From<myoxus_application::workspace::assistant_packages::ContextDocumentContext>
  for ContextDocumentContextObjectType
{
  fn from(value: myoxus_application::workspace::assistant_packages::ContextDocumentContext) -> Self {
    Self {
      container_title: value.container_title,
      task_title: value.task_title,
    }
  }
}

/// Current authorized links are distinct from retained reserved identities.
/// Readback never resumes creation or republishes a stored document snapshot.
#[derive(SimpleObject)]
#[graphql(name = "ContextDocuments")]
pub struct ContextDocumentsObjectType {
  pub run: Option<crate::graphql::auth::workspace_automation::WorkspaceAutomationRunObjectType>,
  pub can_retry: bool,
  pub can_stop: bool,
  pub request_id: ID,
  pub status: ProjectSetupStatusType,
  pub accepted_plan: PreparedContextDocumentsObjectType,
  pub accepted_descriptor: Option<AssistantPackageObjectType>,
  pub current_review: Option<PreparedContextDocumentsObjectType>,
  pub reason_code: Option<String>,
  pub folder_id: String,
  pub placement_complete: bool,
  pub documents: Vec<ProjectSetupDocumentObjectType>,
  pub assistance: crate::graphql::auth::EffectiveAssistanceType,
}

fn prepared_context_plan(value: AssistantPreparedContextDocuments) -> Result<PreparedContextDocumentsObjectType> {
  let digest = myoxus_application::workspace::assistant_packages::context_documents_digest(&value);
  map_prepared_context_documents(value, digest)
}

fn map_context_documents(
  value: myoxus_application::workspace::ContextDocumentStarterOutcome,
) -> Result<ContextDocumentsObjectType> {
  use myoxus_application::workspace::ProjectStarterStatus;
  Ok(ContextDocumentsObjectType {
    run: value.run.map(crate::graphql::auth::workspace_automation::map_run),
    can_retry: value.can_retry,
    can_stop: value.can_stop,
    request_id: ID(value.accepted.request_id.to_string()),
    status: match value.status {
      ProjectStarterStatus::Ready => ProjectSetupStatusType::Ready,
      ProjectStarterStatus::Pending => ProjectSetupStatusType::Pending,
      ProjectStarterStatus::Stopped => ProjectSetupStatusType::Stopped,
      ProjectStarterStatus::StopRequested => ProjectSetupStatusType::StopRequested,
      ProjectStarterStatus::ReReviewRequired => ProjectSetupStatusType::ReReviewRequired,
      ProjectStarterStatus::Unavailable => ProjectSetupStatusType::Unavailable,
    },
    accepted_plan: prepared_context_plan(value.accepted.plan)?,
    accepted_descriptor: value.accepted_descriptor.map(Into::into),
    current_review: value.current_review.map(prepared_context_plan).transpose()?,
    reason_code: value.reason_code,
    folder_id: value.accepted.ids.folder_id,
    placement_complete: value.accepted.progress.placement_complete,
    documents: value
      .documents
      .into_iter()
      .map(|document| ProjectSetupDocumentObjectType {
        component_id: document.component_id,
        reserved_document_id: ID(document.reserved_document_id.to_string()),
        external_id: document.external_id,
        created: document.created,
        placed: document.placed,
      })
      .collect(),
    assistance: value.assistance.into(),
  })
}

fn context_client_version(value: i32) -> Result<u32> {
  u32::try_from(value)
    .ok()
    .filter(|value| *value > 0)
    .ok_or_else(|| map_gql_error(AuthError::InvalidInput("invalid clientVersion".into())))
}

fn map_context_documents_error(error: myoxus_application::workspace::ProjectStarterError) -> Error {
  use myoxus_application::workspace::ProjectStarterError;
  match error {
    ProjectStarterError::Auth(error) => map_gql_error(error),
    ProjectStarterError::Database(error) => map_database_error(error),
    ProjectStarterError::Conflict => Error::new("Document preparation conflicts with its accepted input")
      .extend_with(|_, extensions| extensions.set("code", "MIX_ASSISTANT_REQUEST_CONFLICT")),
    ProjectStarterError::Gone { database_id } => {
      Error::new("Document preparation target is unavailable").extend_with(|_, extensions| {
        extensions.set("code", "MIX_ASSISTANT_RESULT_GONE");
        extensions.set("databaseId", database_id.to_string());
      })
    }
  }
}

pub(crate) async fn prepare_context_documents(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  input: PrepareContextDocumentsInput,
) -> Result<ContextDocumentsPreparationObjectType> {
  let (state, session) = require_session(ctx).await?;
  let prepared = package_service(&state)?
    .prepare_context_documents(
      session.user.id,
      workspace_id,
      input.target.try_into()?,
      &input.identity.into(),
      package_answers(input.answers.0)?,
      &input.locale,
      context_client_version(input.client_version)?,
      state.auth(),
    )
    .await
    .map_err(map_database_error)?;
  Ok(ContextDocumentsPreparationObjectType {
    plan: map_prepared_context_documents(prepared.plan, prepared.plan_digest)?,
    assistance: prepared.assistance.into(),
    context: prepared.context.into(),
  })
}

pub(crate) async fn apply_context_documents(
  ctx: &Context<'_>,
  input: ApplyContextDocumentsInput,
) -> Result<ContextDocumentsObjectType> {
  let (state, session) = require_session(ctx).await?;
  let packages = package_service(&state)?;
  let outcome = state
    .workspace()
    .create_context_documents(
      session.user.id,
      parse_uuid_id(&input.workspace_id, "workspaceId")?,
      input.target.try_into()?,
      myoxus_application::workspace::ContextDocumentStarterInput {
        request_id: parse_uuid_id(&input.request_id, "requestId")?,
        package: input.identity.into(),
        answers: package_answers(input.answers.0)?,
        locale: input.locale,
        client_version: context_client_version(input.client_version)?,
        plan_digest: input.plan_digest,
        admission_confirmation: input.admission_confirmation,
      },
      &packages,
      state.auth(),
    )
    .await
    .map_err(map_context_documents_error)?;
  map_context_documents(outcome)
}

pub(crate) async fn context_documents(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  request_id: ID,
) -> Result<Option<ContextDocumentsObjectType>> {
  let (state, session) = require_session(ctx).await?;
  let packages = package_service(&state)?;
  state
    .workspace()
    .get_context_documents(
      session.user.id,
      workspace_id,
      parse_uuid_id(&request_id, "requestId")?,
      &packages,
      state.auth(),
    )
    .await
    .map_err(map_context_documents_error)?
    .map(map_context_documents)
    .transpose()
}

pub(crate) async fn stop_context_documents(
  ctx: &Context<'_>,
  input: StopContextDocumentsInput,
) -> Result<ContextDocumentsObjectType> {
  let (state, session) = require_session(ctx).await?;
  let packages = package_service(&state)?;
  let outcome = state
    .workspace()
    .stop_context_documents(
      session.user.id,
      parse_uuid_id(&input.workspace_id, "workspaceId")?,
      parse_uuid_id(&input.request_id, "requestId")?,
      &packages,
      state.auth(),
    )
    .await
    .map_err(map_context_documents_error)?;
  map_context_documents(outcome)
}

/// Retry is a native request command; clients cannot submit engine state or new inputs.
pub(crate) async fn retry_context_documents(
  ctx: &Context<'_>,
  input: RetryContextDocumentsInput,
) -> Result<ContextDocumentsObjectType> {
  let (state, session) = require_session(ctx).await?;
  let packages = package_service(&state)?;
  let outcome = state
    .workspace()
    .retry_context_documents(
      session.user.id,
      parse_uuid_id(&input.workspace_id, "workspaceId")?,
      parse_uuid_id(&input.request_id, "requestId")?,
      &packages,
      state.auth(),
    )
    .await
    .map_err(map_context_documents_error)?;
  map_context_documents(outcome)
}
