// SPDX-License-Identifier: AGPL-3.0-or-later
//! Personal opt-in projects the existing native rule; delivery never enables it.
use super::*;
use myoxus_domain::workspace_automation as automation;

#[derive(InputObject)]
pub struct PrepareTaskPreparationInput {
  pub target: ContextDocumentTargetInput,
  pub identity: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub locale: String,
  pub client_version: i32,
}
#[derive(InputObject)]
pub struct ConfigureTaskPreparationInput {
  pub workspace_id: ID,
  pub target: ContextDocumentTargetInput,
  pub rule_id: Option<ID>,
  pub expected_execution_revision: Option<i64>,
  pub identity: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub locale: String,
  pub client_version: i32,
  pub plan_digest: String,
  pub enabled: bool,
}
#[derive(SimpleObject)]
#[graphql(name = "TaskPreparationVariable")]
pub struct TaskPreparationVariableObjectType {
  pub name: String,
  pub value: String,
}
#[derive(SimpleObject)]
#[graphql(name = "TaskPreparationSource")]
pub struct TaskPreparationSourceObjectType {
  pub source: AssistantDocumentComponentSourceObjectType,
  pub source_revision_id: ID,
  pub source_revision_digest: String,
  pub source_content_digest: String,
  pub locale: String,
  pub title: String,
  pub variables: Vec<TaskPreparationVariableObjectType>,
}
impl From<automation::AutomationDocumentSourceSetup> for TaskPreparationSourceObjectType {
  fn from(value: automation::AutomationDocumentSourceSetup) -> Self {
    Self {
      source: value.source.into(),
      source_revision_id: ID(value.source_revision_id.to_string()),
      source_revision_digest: value.source_revision_digest,
      source_content_digest: value.source_content_digest,
      locale: value.locale,
      title: value.title,
      variables: value
        .variables
        .into_iter()
        .map(|(name, value)| TaskPreparationVariableObjectType { name, value })
        .collect(),
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "PreparedTaskPreparation")]
pub struct PreparedTaskPreparationObjectType {
  pub actor_id: ID,
  pub workspace_id: ID,
  pub target: ContextDocumentTargetObjectType,
  pub package: AssistantPackageIdentityObjectType,
  pub answers: Vec<AssistantNamedValueObjectType>,
  pub locale: String,
  pub client_version: i32,
  pub source: TaskPreparationSourceObjectType,
  pub execution_available: bool,
  pub plan_digest: String,
}
#[derive(SimpleObject)]
#[graphql(name = "TaskPreparationConfiguration")]
pub struct TaskPreparationConfigurationObjectType {
  pub id: ID,
  pub actor_id: ID,
  pub workspace_id: ID,
  pub database_id: ID,
  pub execution_revision: i64,
  pub plan_digest: String,
  pub status: crate::graphql::auth::workspace_automation::WorkspaceAutomationStatusType,
  pub package: AssistantPackageIdentityObjectType,
  pub answers: Vec<AssistantNamedValueObjectType>,
  pub locale: String,
  pub client_version: i32,
  pub source: Option<TaskPreparationSourceObjectType>,
}

#[derive(SimpleObject)]
#[graphql(name = "TaskPreparationRun")]
pub struct TaskPreparationRunObjectType {
  pub run: crate::graphql::auth::workspace_automation::WorkspaceAutomationRunObjectType,
  pub target: AssistantTaskReferenceObjectType,
  pub document_id: Option<ID>,
  pub document_external_id: Option<String>,
  pub can_retry: bool,
  pub can_stop: bool,
}

fn map_preparation_run(
  view: myoxus_application::workspace_automation::task_preparation::TaskPreparationRunView,
) -> TaskPreparationRunObjectType {
  TaskPreparationRunObjectType {
    run: crate::graphql::auth::workspace_automation::map_run(view.run),
    target: view.target.into(),
    document_id: view.document_id.map(|id| ID(id.to_string())),
    document_external_id: view.document_external_id,
    can_retry: view.can_retry,
    can_stop: view.can_stop,
  }
}

pub(crate) async fn task_preparation_run(
  ctx: &Context<'_>,
  workspace: WorkspaceId,
  run_id: ID,
) -> Result<Option<TaskPreparationRunObjectType>> {
  let (state, session) = require_session(ctx).await?;
  let view = crate::graphql::auth::workspace_automation::service(&state)?
    .get_task_preparation_run(session.user.id, parse_uuid_id(&run_id, "runId")?)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  Ok(
    view
      .filter(|view| view.run.workspace_id == workspace)
      .map(map_preparation_run),
  )
}

pub(crate) async fn retry_task_preparation_run(ctx: &Context<'_>, run_id: ID) -> Result<TaskPreparationRunObjectType> {
  let (state, session) = require_session(ctx).await?;
  crate::graphql::auth::workspace_automation::service(&state)?
    .retry_task_preparation_run(session.user.id, parse_uuid_id(&run_id, "runId")?)
    .await
    .map(map_preparation_run)
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)
}

pub(crate) async fn stop_task_preparation_run(ctx: &Context<'_>, run_id: ID) -> Result<TaskPreparationRunObjectType> {
  let (state, session) = require_session(ctx).await?;
  crate::graphql::auth::workspace_automation::service(&state)?
    .stop_task_preparation_run(session.user.id, parse_uuid_id(&run_id, "runId")?)
    .await
    .map(map_preparation_run)
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)
}
fn version(value: i32) -> Result<u32> {
  u32::try_from(value)
    .ok()
    .filter(|v| *v > 0)
    .ok_or_else(|| map_gql_error(AuthError::InvalidInput("invalid clientVersion".into())))
}
fn output_version(value: u32) -> Result<i32> {
  i32::try_from(value).map_err(|_| map_gql_error(AuthError::InvalidInput("invalid clientVersion".into())))
}
fn map_prepared(value: automation::PreparedTaskPreparation) -> Result<PreparedTaskPreparationObjectType> {
  let digest = myoxus_application::workspace_automation::task_preparation::task_preparation_digest(&value)
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  Ok(PreparedTaskPreparationObjectType {
    actor_id: ID(value.actor_id.to_string()),
    workspace_id: ID(value.workspace_id.to_string()),
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
    client_version: output_version(value.client_version)?,
    source: value.source.into(),
    execution_available: value.execution_available,
    plan_digest: digest,
  })
}
pub(in crate::graphql::auth::database) fn map_configuration(
  value: automation::WorkspaceAutomation,
) -> Result<TaskPreparationConfigurationObjectType> {
  let personal = value
    .personal_config
    .ok_or_else(|| database_error("MIX_AUTOMATION_INPUTS_UNAVAILABLE", "Personal preparation unavailable"))?;
  let source = value.actions.into_iter().find_map(|action| match action.config {
    automation::WorkspaceAutomationActionConfig::CreateLinkedDocument { source, .. } => source,
    _ => None,
  });
  Ok(TaskPreparationConfigurationObjectType {
    id: ID(value.id.to_string()),
    actor_id: ID(personal.actor_id.to_string()),
    workspace_id: ID(value.workspace_id.to_string()),
    database_id: ID(personal.database_id.to_string()),
    execution_revision: value.execution_revision,
    plan_digest: personal.plan_digest,
    status: value.status.into(),
    package: personal.package.into(),
    answers: personal
      .answers
      .into_iter()
      .map(|(input, value)| AssistantNamedValueObjectType {
        input,
        value: value.into(),
      })
      .collect(),
    locale: personal.locale,
    client_version: output_version(personal.client_version)?,
    source: source.map(Into::into),
  })
}
pub(crate) async fn prepare_task_preparation(
  ctx: &Context<'_>,
  workspace: WorkspaceId,
  input: PrepareTaskPreparationInput,
) -> Result<PreparedTaskPreparationObjectType> {
  let (state, session) = require_session(ctx).await?;
  let prepared = crate::graphql::auth::workspace_automation::service(&state)?
    .prepare_task_preparation(
      session.user.id,
      workspace,
      input.target.try_into()?,
      &input.identity.into(),
      package_answers(input.answers.0)?,
      &input.locale,
      version(input.client_version)?,
    )
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_prepared(prepared)
}
pub(crate) async fn task_preparation(
  ctx: &Context<'_>,
  workspace: WorkspaceId,
  database_id: ID,
) -> Result<Option<TaskPreparationConfigurationObjectType>> {
  let (state, session) = require_session(ctx).await?;
  crate::graphql::auth::workspace_automation::service(&state)?
    .get_task_preparation(session.user.id, workspace, parse_uuid_id(&database_id, "databaseId")?)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?
    .map(map_configuration)
    .transpose()
}
pub(crate) async fn configure_task_preparation(
  ctx: &Context<'_>,
  input: ConfigureTaskPreparationInput,
) -> Result<TaskPreparationConfigurationObjectType> {
  let (state, session) = require_session(ctx).await?;
  let rule = crate::graphql::auth::workspace_automation::service(&state)?
    .configure_task_preparation(
      session.user.id,
      parse_uuid_id(&input.workspace_id, "workspaceId")?,
      input.target.try_into()?,
      automation::TaskPreparationConfigurationInput {
        rule_id: input.rule_id.map(|id| parse_uuid_id(&id, "ruleId")).transpose()?,
        expected_execution_revision: input.expected_execution_revision,
        package: input.identity.into(),
        answers: package_answers(input.answers.0)?,
        locale: input.locale,
        client_version: version(input.client_version)?,
        plan_digest: input.plan_digest,
        enabled: input.enabled,
      },
    )
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_configuration(rule)
}

pub(crate) async fn prepare_task_maintenance_rule(
  ctx: &Context<'_>,
  workspace: WorkspaceId,
  input: PrepareTaskMaintenanceInput,
) -> Result<PreparedTaskMaintenanceObjectType> {
  let (state, session) = require_session(ctx).await?;
  let prepared = crate::graphql::auth::workspace_automation::service(&state)?
    .prepare_task_maintenance_rule(
      session.user.id,
      workspace,
      input.target.try_into()?,
      &input.identity.into(),
      package_answers(input.answers.0)?,
      &input.locale,
      version(input.client_version)?,
    )
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  super::task_maintenance::map_prepared_task_maintenance(prepared)
}
pub(crate) async fn task_maintenance_rule(
  ctx: &Context<'_>,
  workspace: WorkspaceId,
  database_id: ID,
) -> Result<Option<TaskPreparationConfigurationObjectType>> {
  let (state, session) = require_session(ctx).await?;
  crate::graphql::auth::workspace_automation::service(&state)?
    .get_task_maintenance_rule(session.user.id, workspace, parse_uuid_id(&database_id, "databaseId")?)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?
    .map(map_configuration)
    .transpose()
}
pub(crate) async fn configure_task_maintenance(
  ctx: &Context<'_>,
  input: ConfigureTaskPreparationInput,
) -> Result<TaskPreparationConfigurationObjectType> {
  let (state, session) = require_session(ctx).await?;
  let rule = crate::graphql::auth::workspace_automation::service(&state)?
    .configure_task_maintenance(
      session.user.id,
      parse_uuid_id(&input.workspace_id, "workspaceId")?,
      input.target.try_into()?,
      automation::TaskPreparationConfigurationInput {
        rule_id: input.rule_id.map(|id| parse_uuid_id(&id, "ruleId")).transpose()?,
        expected_execution_revision: input.expected_execution_revision,
        package: input.identity.into(),
        answers: package_answers(input.answers.0)?,
        locale: input.locale,
        client_version: version(input.client_version)?,
        plan_digest: input.plan_digest,
        enabled: input.enabled,
      },
    )
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_configuration(rule)
}
