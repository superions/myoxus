// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native correction confirmation authorizes one frozen proposal. Clients cannot
//! inject workflow signals, change accepted patches or choose result identities.
use super::*;
use myoxus_domain::workspace_automation as automation;

#[derive(InputObject)]
pub struct PrepareTaskMaintenanceInput {
  pub target: ContextDocumentTargetInput,
  pub identity: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub locale: String,
  pub client_version: i32,
}

#[derive(InputObject)]
pub struct StartTaskMaintenanceInput {
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
pub struct TaskMaintenanceRunInput {
  pub run_id: ID,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "TaskContentFindingKind", rename_items = "PascalCase")]
pub enum TaskContentFindingKindType {
  RequiredValueMissing,
  DueBeforeStart,
  ReferenceUnavailable,
  AssignmentSuggestion,
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "TaskCorrectionOutcome", rename_items = "PascalCase")]
pub enum TaskCorrectionOutcomeType {
  Apply,
  Decline,
}
#[derive(InputObject)]
pub struct ConfirmTaskCorrectionsInput {
  pub run_id: ID,
  pub request_id: ID,
  pub wait_id: String,
  pub proposal_digest: String,
  pub outcome: TaskCorrectionOutcomeType,
}
#[derive(SimpleObject)]
#[graphql(name = "TaskContentFinding")]
pub struct TaskContentFindingObjectType {
  pub task: AssistantTaskReferenceObjectType,
  pub field_id: ID,
  pub kind: TaskContentFindingKindType,
}
#[derive(SimpleObject)]
#[graphql(name = "TaskCorrectionPatch")]
pub struct TaskCorrectionPatchObjectType {
  pub row_id: ID,
  pub field_id: ID,
  pub old_value: Option<DatabaseCellValueDataObjectType>,
  pub value: Option<DatabaseCellValueDataObjectType>,
  pub clear: bool,
  pub expected_edit_revision: i64,
}
#[derive(SimpleObject)]
#[graphql(name = "TaskCorrectionRowPrecondition")]
pub struct TaskCorrectionRowPreconditionObjectType {
  pub row_id: ID,
  pub expected_edit_revision: i64,
}
#[derive(SimpleObject)]
#[graphql(name = "TaskCorrectionProposal")]
pub struct TaskCorrectionProposalObjectType {
  pub actor_id: ID,
  pub workspace_id: ID,
  pub database_id: ID,
  pub digest: String,
  pub tasks: Vec<AssistantTaskReferenceObjectType>,
  pub findings: Vec<TaskContentFindingObjectType>,
  pub patches: Vec<TaskCorrectionPatchObjectType>,
  pub row_preconditions: Vec<TaskCorrectionRowPreconditionObjectType>,
}
#[derive(SimpleObject)]
#[graphql(name = "PreparedTaskMaintenance")]
pub struct PreparedTaskMaintenanceObjectType {
  pub actor_id: ID,
  pub workspace_id: ID,
  pub target: ContextDocumentTargetObjectType,
  pub package: AssistantPackageIdentityObjectType,
  pub answers: Vec<AssistantNamedValueObjectType>,
  pub locale: String,
  pub client_version: i32,
  pub proposal: TaskCorrectionProposalObjectType,
  pub execution_available: bool,
  pub plan_digest: String,
}
#[derive(SimpleObject)]
#[graphql(name = "TaskCorrectionConfirmation")]
pub struct TaskCorrectionConfirmationObjectType {
  pub request_id: ID,
  pub wait_id: String,
  pub proposal_digest: String,
  pub outcome: TaskCorrectionOutcomeType,
  pub accepted_at: DateTime<Utc>,
}
#[derive(SimpleObject)]
#[graphql(name = "TaskMaintenance")]
pub struct TaskMaintenanceObjectType {
  pub request_id: ID,
  pub run: crate::graphql::auth::workspace_automation::WorkspaceAutomationRunObjectType,
  pub accepted_plan: PreparedTaskMaintenanceObjectType,
  pub accepted_descriptor: Option<AssistantPackageObjectType>,
  pub confirmation: Option<TaskCorrectionConfirmationObjectType>,
  pub wait_id: String,
  pub can_confirm: bool,
  pub can_apply: bool,
  pub can_decline: bool,
  pub can_retry: bool,
  pub can_stop: bool,
  pub reason_code: Option<String>,
}
pub(in crate::graphql::auth::database) fn map_prepared_task_maintenance(
  value: automation::PreparedTaskMaintenance,
) -> Result<PreparedTaskMaintenanceObjectType> {
  let plan_digest = myoxus_application::workspace_automation::maintenance::task_maintenance_digest(&value)
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  let proposal = value.proposal;
  Ok(PreparedTaskMaintenanceObjectType {
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
    client_version: i32::try_from(value.client_version)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid clientVersion".into())))?,
    execution_available: value.execution_available,
    plan_digest,
    proposal: TaskCorrectionProposalObjectType {
      actor_id: ID(proposal.actor_id.to_string()),
      workspace_id: ID(proposal.workspace_id.to_string()),
      database_id: ID(proposal.database_id.to_string()),
      digest: proposal.digest,
      tasks: proposal.tasks.into_iter().map(Into::into).collect(),
      findings: proposal
        .findings
        .into_iter()
        .map(|f| TaskContentFindingObjectType {
          task: f.task.into(),
          field_id: ID(f.field_id.to_string()),
          kind: match f.kind {
            automation::TaskContentFindingKind::RequiredValueMissing => {
              TaskContentFindingKindType::RequiredValueMissing
            }
            automation::TaskContentFindingKind::DueBeforeStart => TaskContentFindingKindType::DueBeforeStart,
            automation::TaskContentFindingKind::ReferenceUnavailable => {
              TaskContentFindingKindType::ReferenceUnavailable
            }
            automation::TaskContentFindingKind::AssignmentSuggestion => {
              TaskContentFindingKindType::AssignmentSuggestion
            }
          },
        })
        .collect(),
      patches: proposal
        .patches
        .into_iter()
        .map(|p| {
          let (value, clear) = match p.intent {
            DatabaseBulkCellIntent::Set(value) => (Some(map_cell_value(value)), false),
            DatabaseBulkCellIntent::Clear => (None, true),
          };
          TaskCorrectionPatchObjectType {
            row_id: ID(p.row_id.to_string()),
            field_id: ID(p.field_id.to_string()),
            old_value: p.old_value.map(map_cell_value),
            value,
            clear,
            expected_edit_revision: p.expected_edit_revision,
          }
        })
        .collect(),
      row_preconditions: proposal
        .row_preconditions
        .into_iter()
        .map(|r| TaskCorrectionRowPreconditionObjectType {
          row_id: ID(r.row_id.to_string()),
          expected_edit_revision: r.expected_edit_revision,
        })
        .collect(),
    },
  })
}
fn map_task_maintenance(value: automation::TaskMaintenanceView) -> Result<TaskMaintenanceObjectType> {
  Ok(TaskMaintenanceObjectType {
    request_id: ID(value.request_id.to_string()),
    run: crate::graphql::auth::workspace_automation::map_run(value.run),
    accepted_plan: map_prepared_task_maintenance(value.accepted)?,
    accepted_descriptor: value.accepted_descriptor.map(Into::into),
    confirmation: value.confirmation.map(|c| TaskCorrectionConfirmationObjectType {
      request_id: ID(c.request_id.to_string()),
      wait_id: c.wait_id,
      proposal_digest: c.proposal_digest,
      outcome: match c.outcome {
        automation::TaskCorrectionOutcome::Apply => TaskCorrectionOutcomeType::Apply,
        automation::TaskCorrectionOutcome::Decline => TaskCorrectionOutcomeType::Decline,
      },
      accepted_at: c.accepted_at,
    }),
    wait_id: value.wait_id,
    can_confirm: value.can_confirm,
    can_apply: value.can_apply,
    can_decline: value.can_decline,
    can_retry: value.can_retry,
    can_stop: value.can_stop,
    reason_code: value.reason_code,
  })
}
fn maintenance_client_version(value: i32) -> Result<u32> {
  u32::try_from(value)
    .ok()
    .filter(|value| *value > 0)
    .ok_or_else(|| map_gql_error(AuthError::InvalidInput("invalid clientVersion".into())))
}

pub(crate) async fn prepare_task_maintenance(
  ctx: &Context<'_>,
  workspace: WorkspaceId,
  input: PrepareTaskMaintenanceInput,
) -> Result<PreparedTaskMaintenanceObjectType> {
  let (state, session) = require_session(ctx).await?;
  let plan = crate::graphql::auth::workspace_automation::service(&state)?
    .prepare_task_maintenance(
      session.user.id,
      workspace,
      input.target.try_into()?,
      &input.identity.into(),
      package_answers(input.answers.0)?,
      &input.locale,
      maintenance_client_version(input.client_version)?,
    )
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_prepared_task_maintenance(plan)
}

pub(crate) async fn start_task_maintenance(
  ctx: &Context<'_>,
  input: StartTaskMaintenanceInput,
) -> Result<TaskMaintenanceObjectType> {
  let (state, session) = require_session(ctx).await?;
  let view = crate::graphql::auth::workspace_automation::service(&state)?
    .start_task_maintenance(
      session.user.id,
      parse_uuid_id(&input.workspace_id, "workspaceId")?,
      input.target.try_into()?,
      automation::TaskMaintenanceStartInput {
        request_id: parse_uuid_id(&input.request_id, "requestId")?,
        package: input.identity.into(),
        answers: package_answers(input.answers.0)?,
        locale: input.locale,
        client_version: maintenance_client_version(input.client_version)?,
        plan_digest: input.plan_digest,
      },
    )
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_task_maintenance(view)
}

pub(crate) async fn task_maintenance(
  ctx: &Context<'_>,
  workspace: WorkspaceId,
  run_id: ID,
) -> Result<Option<TaskMaintenanceObjectType>> {
  let (state, session) = require_session(ctx).await?;
  let view = crate::graphql::auth::workspace_automation::service(&state)?
    .get_task_maintenance(session.user.id, parse_uuid_id(&run_id, "runId")?)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  match view {
    Some(view) if view.run.workspace_id == workspace => map_task_maintenance(view).map(Some),
    _ => Ok(None),
  }
}

pub(crate) async fn task_maintenance_request(
  ctx: &Context<'_>,
  workspace: WorkspaceId,
  request_id: ID,
) -> Result<Option<TaskMaintenanceObjectType>> {
  let (state, session) = require_session(ctx).await?;
  crate::graphql::auth::workspace_automation::service(&state)?
    .get_task_maintenance_request(session.user.id, workspace, parse_uuid_id(&request_id, "requestId")?)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?
    .map(map_task_maintenance)
    .transpose()
}

pub(crate) async fn retry_task_maintenance(
  ctx: &Context<'_>,
  input: TaskMaintenanceRunInput,
) -> Result<TaskMaintenanceObjectType> {
  let (state, session) = require_session(ctx).await?;
  let view = crate::graphql::auth::workspace_automation::service(&state)?
    .retry_task_maintenance(session.user.id, parse_uuid_id(&input.run_id, "runId")?)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_task_maintenance(view)
}

pub(crate) async fn stop_task_maintenance(
  ctx: &Context<'_>,
  input: TaskMaintenanceRunInput,
) -> Result<TaskMaintenanceObjectType> {
  let (state, session) = require_session(ctx).await?;
  let view = crate::graphql::auth::workspace_automation::service(&state)?
    .stop_task_maintenance(session.user.id, parse_uuid_id(&input.run_id, "runId")?)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_task_maintenance(view)
}

/// Confirmation and signal intent commit together in the existing Database writer.
/// A read failure after that commit is recovered by the same request identity.
pub(crate) async fn confirm_task_corrections(
  ctx: &Context<'_>,
  input: ConfirmTaskCorrectionsInput,
) -> Result<TaskMaintenanceObjectType> {
  let (state, session) = require_session(ctx).await?;
  let run_id = parse_uuid_id(&input.run_id, "runId")?;
  service(&state)?
    .editing
    .confirm_task_corrections(
      session.user.id,
      automation::TaskCorrectionConfirmationInput {
        run_id,
        request_id: parse_uuid_id(&input.request_id, "requestId")?,
        wait_id: input.wait_id,
        proposal_digest: input.proposal_digest,
        outcome: match input.outcome {
          TaskCorrectionOutcomeType::Apply => automation::TaskCorrectionOutcome::Apply,
          TaskCorrectionOutcomeType::Decline => automation::TaskCorrectionOutcome::Decline,
        },
      },
    )
    .await
    .map_err(map_database_error)?;
  let view = crate::graphql::auth::workspace_automation::service(&state)?
    .get_task_maintenance(session.user.id, run_id)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?
    .ok_or_else(|| database_error("MIX_DATABASE_ROW_NOT_FOUND", "correction workflow unavailable"))?;
  map_task_maintenance(view)
}
