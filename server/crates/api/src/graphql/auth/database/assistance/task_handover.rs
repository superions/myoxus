// SPDX-License-Identifier: AGPL-3.0-or-later
//! Confirm native prerequisite handovers; Task events and accepted native facts
//! advance their waits. Clients cannot inject signals or choose result identities.
use super::*;
use myoxus_domain::workspace_automation as automation;

#[derive(InputObject)]
pub struct PrepareTaskHandoverInput {
  pub target: ContextDocumentTargetInput,
  pub identity: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub locale: String,
  pub client_version: i32,
}

#[derive(InputObject)]
pub struct StartTaskHandoverInput {
  pub workspace_id: ID,
  pub target: ContextDocumentTargetInput,
  pub request_id: ID,
  pub identity: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub locale: String,
  pub client_version: i32,
  pub plan_digest: String,
}

#[derive(InputObject)]
pub struct TaskHandoverRunInput {
  pub run_id: ID,
}

#[derive(SimpleObject)]
#[graphql(name = "PreparedTaskHandover")]
pub struct PreparedTaskHandoverObjectType {
  pub target: ContextDocumentTargetObjectType,
  pub package: AssistantPackageIdentityObjectType,
  pub answers: Vec<AssistantNamedValueObjectType>,
  pub locale: String,
  pub client_version: i32,
  pub source_document_id: ID,
  pub source_external_id: String,
  pub prerequisites: Vec<AssistantTaskReferenceObjectType>,
  pub responsible_id: ID,
  pub destination_database_id: ID,
  pub title: String,
  pub deadline_at: DateTime<Utc>,
  pub deadline_time_zone: String,
  pub execution_available: bool,
  pub plan_digest: String,
}

#[derive(SimpleObject)]
#[graphql(name = "TaskHandoverPrerequisite")]
pub struct TaskHandoverPrerequisiteObjectType {
  pub reference: AssistantTaskReferenceObjectType,
  pub available: bool,
  pub title: Option<String>,
  pub complete: bool,
}

#[derive(SimpleObject)]
#[graphql(name = "TaskHandover")]
pub struct TaskHandoverObjectType {
  pub run: crate::graphql::auth::workspace_automation::WorkspaceAutomationRunObjectType,
  pub accepted_plan: PreparedTaskHandoverObjectType,
  pub accepted_descriptor: Option<AssistantPackageObjectType>,
  pub result_task_id: ID,
  pub result_task: Option<AssistantTaskReferenceObjectType>,
  pub result_available: bool,
  pub source_available: bool,
  pub prerequisites: Vec<TaskHandoverPrerequisiteObjectType>,
  pub can_retry: bool,
  pub can_stop: bool,
  pub reason_code: Option<String>,
}

fn map_prepared_task_handover(value: automation::PreparedTaskHandover) -> Result<PreparedTaskHandoverObjectType> {
  let plan_digest = myoxus_application::workspace_automation::handover::task_handover_digest(&value)
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  Ok(PreparedTaskHandoverObjectType {
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
    source_document_id: ID(value.source_document_id.to_string()),
    source_external_id: value.source_external_id,
    prerequisites: value.prerequisites.into_iter().map(Into::into).collect(),
    responsible_id: ID(value.responsible_id.to_string()),
    destination_database_id: ID(value.destination_database_id.to_string()),
    title: value.title,
    deadline_at: value.deadline_at,
    deadline_time_zone: value.deadline_time_zone,
    execution_available: value.execution_available,
    plan_digest,
  })
}

fn map_task_handover(value: automation::TaskHandoverView) -> Result<TaskHandoverObjectType> {
  Ok(TaskHandoverObjectType {
    run: crate::graphql::auth::workspace_automation::map_run(value.run),
    accepted_plan: map_prepared_task_handover(value.accepted)?,
    accepted_descriptor: value.accepted_descriptor.map(Into::into),
    result_task_id: ID(value.result_task_id.to_string()),
    result_task: value.result_task.map(Into::into),
    result_available: value.result_available,
    source_available: value.source_available,
    prerequisites: value
      .prerequisites
      .into_iter()
      .map(|item| TaskHandoverPrerequisiteObjectType {
        reference: item.reference.into(),
        available: item.available,
        title: item.title,
        complete: item.complete,
      })
      .collect(),
    can_retry: value.can_retry,
    can_stop: value.can_stop,
    reason_code: value.reason_code,
  })
}

fn handover_client_version(value: i32) -> Result<u32> {
  u32::try_from(value)
    .ok()
    .filter(|value| *value > 0)
    .ok_or_else(|| map_gql_error(AuthError::InvalidInput("invalid clientVersion".into())))
}

pub(crate) async fn prepare_task_handover(
  ctx: &Context<'_>,
  workspace: WorkspaceId,
  input: PrepareTaskHandoverInput,
) -> Result<PreparedTaskHandoverObjectType> {
  let (state, session) = require_session(ctx).await?;
  let plan = crate::graphql::auth::workspace_automation::service(&state)?
    .prepare_task_handover(
      session.user.id,
      workspace,
      input.target.try_into()?,
      &input.identity.into(),
      package_answers(input.answers.0)?,
      &input.locale,
      handover_client_version(input.client_version)?,
    )
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_prepared_task_handover(plan)
}

pub(crate) async fn start_task_handover(
  ctx: &Context<'_>,
  input: StartTaskHandoverInput,
) -> Result<TaskHandoverObjectType> {
  let (state, session) = require_session(ctx).await?;
  let view = crate::graphql::auth::workspace_automation::service(&state)?
    .start_task_handover(
      session.user.id,
      parse_uuid_id(&input.workspace_id, "workspaceId")?,
      input.target.try_into()?,
      automation::TaskHandoverStartInput {
        request_id: parse_uuid_id(&input.request_id, "requestId")?,
        package: input.identity.into(),
        answers: package_answers(input.answers.0)?,
        locale: input.locale,
        client_version: handover_client_version(input.client_version)?,
        plan_digest: input.plan_digest,
      },
    )
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_task_handover(view)
}

pub(crate) async fn task_handover(
  ctx: &Context<'_>,
  workspace: WorkspaceId,
  run_id: ID,
) -> Result<Option<TaskHandoverObjectType>> {
  let (state, session) = require_session(ctx).await?;
  let view = crate::graphql::auth::workspace_automation::service(&state)?
    .get_task_handover(session.user.id, parse_uuid_id(&run_id, "runId")?)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  match view {
    Some(view) if view.run.workspace_id == workspace => map_task_handover(view).map(Some),
    _ => Ok(None),
  }
}

pub(crate) async fn task_handover_request(
  ctx: &Context<'_>,
  workspace: WorkspaceId,
  request_id: ID,
) -> Result<Option<TaskHandoverObjectType>> {
  let (state, session) = require_session(ctx).await?;
  crate::graphql::auth::workspace_automation::service(&state)?
    .get_task_handover_request(session.user.id, workspace, parse_uuid_id(&request_id, "requestId")?)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?
    .map(map_task_handover)
    .transpose()
}

pub(crate) async fn retry_task_handover(
  ctx: &Context<'_>,
  input: TaskHandoverRunInput,
) -> Result<TaskHandoverObjectType> {
  let (state, session) = require_session(ctx).await?;
  let view = crate::graphql::auth::workspace_automation::service(&state)?
    .retry_task_handover(session.user.id, parse_uuid_id(&input.run_id, "runId")?)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_task_handover(view)
}

pub(crate) async fn stop_task_handover(
  ctx: &Context<'_>,
  input: TaskHandoverRunInput,
) -> Result<TaskHandoverObjectType> {
  let (state, session) = require_session(ctx).await?;
  let view = crate::graphql::auth::workspace_automation::service(&state)?
    .stop_task_handover(session.user.id, parse_uuid_id(&input.run_id, "runId")?)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_task_handover(view)
}
