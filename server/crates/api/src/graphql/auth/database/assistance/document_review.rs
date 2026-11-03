// SPDX-License-Identifier: AGPL-3.0-or-later
//! Document-review commands project native authority and receipt state. Clients
//! cannot supply workflow signals, granted access or replacement result IDs.
use super::*;
use myoxus_domain::workspace_automation as automation;

#[derive(InputObject)]
pub struct PrepareDocumentReviewInput {
  pub target: ContextDocumentTargetInput,
  pub identity: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub locale: String,
  pub client_version: i32,
}

#[derive(InputObject)]
pub struct StartDocumentReviewInput {
  pub workspace_id: ID,
  pub target: ContextDocumentTargetInput,
  pub request_id: ID,
  pub identity: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub locale: String,
  pub client_version: i32,
  pub plan_digest: String,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DocumentReviewDecisionKind", rename_items = "PascalCase")]
pub enum DocumentReviewDecisionKindType {
  Approve,
  RequestChanges,
}

#[derive(InputObject)]
pub struct DecideDocumentReviewInput {
  pub run_id: ID,
  pub wait_id: String,
  pub request_id: ID,
  pub expected_document_revision: String,
  pub expected_task_edit_revision: i64,
  pub expected_status_edit_revision: i64,
  pub decision: DocumentReviewDecisionKindType,
  pub reason: Option<String>,
}

#[derive(InputObject)]
pub struct DocumentReviewRunInput {
  pub run_id: ID,
}

#[derive(SimpleObject)]
#[graphql(name = "PreparedDocumentReview")]
pub struct PreparedDocumentReviewObjectType {
  pub target: ContextDocumentTargetObjectType,
  pub package: AssistantPackageIdentityObjectType,
  pub answers: Vec<AssistantNamedValueObjectType>,
  pub locale: String,
  pub client_version: i32,
  pub source_document_id: ID,
  pub source_external_id: String,
  pub source_revision: String,
  pub reviewer_id: ID,
  pub destination_database_id: ID,
  pub title: String,
  pub deadline_at: DateTime<Utc>,
  pub deadline_time_zone: String,
  pub source_metadata_deadline: Option<chrono::DateTime<chrono::Utc>>,
  pub execution_available: bool,
  pub plan_digest: String,
}

#[derive(SimpleObject)]
#[graphql(name = "DocumentReview")]
pub struct DocumentReviewObjectType {
  pub run: crate::graphql::auth::workspace_automation::WorkspaceAutomationRunObjectType,
  pub accepted_plan: PreparedDocumentReviewObjectType,
  pub accepted_descriptor: Option<AssistantPackageObjectType>,
  pub wait_id: String,
  pub expected_task_edit_revision: Option<i64>,
  pub expected_status_edit_revision: Option<i64>,
  pub source_available: bool,
  pub current_source_revision: Option<String>,
  pub review_task_id: ID,
  pub follow_up_task_id: ID,
  pub review_task_available: bool,
  pub follow_up_task_available: bool,
  pub decision: Option<DocumentReviewDecisionKindType>,
  pub reason: Option<String>,
  pub can_approve: bool,
  pub can_request_changes: bool,
  pub can_retry: bool,
  pub can_stop: bool,
  pub reason_code: Option<String>,
}

fn map_prepared_document_review(
  value: automation::PreparedDocumentReview,
  plan_digest: String,
) -> Result<PreparedDocumentReviewObjectType> {
  Ok(PreparedDocumentReviewObjectType {
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
    source_revision: value.source_revision,
    reviewer_id: ID(value.reviewer_id.to_string()),
    destination_database_id: ID(value.destination_database_id.to_string()),
    title: value.title,
    deadline_at: value.deadline_at,
    deadline_time_zone: value.deadline_time_zone,
    source_metadata_deadline: value.source_metadata_deadline,
    execution_available: value.execution_available,
    plan_digest,
  })
}

fn map_document_review(value: automation::DocumentReviewView) -> Result<DocumentReviewObjectType> {
  let plan_digest = myoxus_application::workspace_automation::review::document_review_digest(&value.accepted)
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  let (decision, reason) = match value.decision {
    None => (None, None),
    Some(automation::DocumentReviewDecision::Approve) => (Some(DocumentReviewDecisionKindType::Approve), None),
    Some(automation::DocumentReviewDecision::RequestChanges { reason }) => {
      (Some(DocumentReviewDecisionKindType::RequestChanges), Some(reason))
    }
  };
  Ok(DocumentReviewObjectType {
    run: crate::graphql::auth::workspace_automation::map_run(value.run),
    accepted_plan: map_prepared_document_review(value.accepted, plan_digest)?,
    accepted_descriptor: value.accepted_descriptor.map(Into::into),
    wait_id: value.wait_id,
    expected_task_edit_revision: value.expected_task_edit_revision,
    expected_status_edit_revision: value.expected_status_edit_revision,
    source_available: value.source_available,
    current_source_revision: value.current_source_revision,
    review_task_id: ID(value.review_task_id.to_string()),
    follow_up_task_id: ID(value.follow_up_task_id.to_string()),
    review_task_available: value.review_task_available,
    follow_up_task_available: value.follow_up_task_available,
    decision,
    reason,
    can_approve: value.can_approve,
    can_request_changes: value.can_request_changes,
    can_retry: value.can_retry,
    can_stop: value.can_stop,
    reason_code: value.reason_code,
  })
}

fn review_client_version(value: i32) -> Result<u32> {
  u32::try_from(value)
    .ok()
    .filter(|value| *value > 0)
    .ok_or_else(|| map_gql_error(AuthError::InvalidInput("invalid clientVersion".into())))
}

pub(crate) async fn prepare_document_review(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  input: PrepareDocumentReviewInput,
) -> Result<PreparedDocumentReviewObjectType> {
  let (state, session) = require_session(ctx).await?;
  let plan = crate::graphql::auth::workspace_automation::service(&state)?
    .prepare_document_review(
      session.user.id,
      workspace_id,
      input.target.try_into()?,
      &input.identity.into(),
      package_answers(input.answers.0)?,
      &input.locale,
      review_client_version(input.client_version)?,
    )
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  let digest = myoxus_application::workspace_automation::review::document_review_digest(&plan)
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_prepared_document_review(plan, digest)
}

pub(crate) async fn start_document_review(
  ctx: &Context<'_>,
  input: StartDocumentReviewInput,
) -> Result<DocumentReviewObjectType> {
  let (state, session) = require_session(ctx).await?;
  let view = crate::graphql::auth::workspace_automation::service(&state)?
    .start_document_review(
      session.user.id,
      parse_uuid_id(&input.workspace_id, "workspaceId")?,
      input.target.try_into()?,
      automation::DocumentReviewStartInput {
        request_id: parse_uuid_id(&input.request_id, "requestId")?,
        package: input.identity.into(),
        answers: package_answers(input.answers.0)?,
        locale: input.locale,
        client_version: review_client_version(input.client_version)?,
        plan_digest: input.plan_digest,
      },
    )
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_document_review(view)
}

pub(crate) async fn document_review(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  run_id: ID,
) -> Result<Option<DocumentReviewObjectType>> {
  let (state, session) = require_session(ctx).await?;
  let view = crate::graphql::auth::workspace_automation::service(&state)?
    .get_document_review(session.user.id, parse_uuid_id(&run_id, "runId")?)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  match view {
    Some(view) if view.run.workspace_id == workspace_id => map_document_review(view).map(Some),
    _ => Ok(None),
  }
}

pub(crate) async fn document_review_request(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  request_id: ID,
) -> Result<Option<DocumentReviewObjectType>> {
  let (state, session) = require_session(ctx).await?;
  crate::graphql::auth::workspace_automation::service(&state)?
    .get_document_review_request(session.user.id, workspace_id, parse_uuid_id(&request_id, "requestId")?)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?
    .map(map_document_review)
    .transpose()
}

pub(crate) async fn document_review_for_task(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  database_id: ID,
  row_id: ID,
) -> Result<Option<DocumentReviewObjectType>> {
  let (state, session) = require_session(ctx).await?;
  crate::graphql::auth::workspace_automation::service(&state)?
    .get_document_review_for_task(
      session.user.id,
      workspace_id,
      parse_uuid_id(&database_id, "databaseId")?,
      parse_uuid_id(&row_id, "rowId")?,
    )
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?
    .map(map_document_review)
    .transpose()
}

pub(crate) async fn decide_document_review(
  ctx: &Context<'_>,
  input: DecideDocumentReviewInput,
) -> Result<DocumentReviewObjectType> {
  let (state, session) = require_session(ctx).await?;
  let decision = match (input.decision, input.reason) {
    (DocumentReviewDecisionKindType::Approve, None) => automation::DocumentReviewDecision::Approve,
    (DocumentReviewDecisionKindType::RequestChanges, Some(reason)) => {
      automation::DocumentReviewDecision::RequestChanges { reason }
    }
    _ => {
      return Err(map_gql_error(AuthError::InvalidInput(
        "decision reason does not match its kind".into(),
      )));
    }
  };
  let view = crate::graphql::auth::workspace_automation::service(&state)?
    .decide_document_review(
      session.user.id,
      automation::DocumentReviewDecisionInput {
        run_id: parse_uuid_id(&input.run_id, "runId")?,
        wait_id: input.wait_id,
        request_id: parse_uuid_id(&input.request_id, "requestId")?,
        expected_document_revision: input.expected_document_revision,
        expected_task_edit_revision: input.expected_task_edit_revision,
        expected_status_edit_revision: input.expected_status_edit_revision,
        decision,
      },
    )
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  map_document_review(view)
}

pub(crate) async fn stop_document_review(
  ctx: &Context<'_>,
  input: DocumentReviewRunInput,
) -> Result<DocumentReviewObjectType> {
  let (state, session) = require_session(ctx).await?;
  let service = crate::graphql::auth::workspace_automation::service(&state)?;
  let run_id = parse_uuid_id(&input.run_id, "runId")?;
  // Verify the product origin before invoking the shared native run control.
  service
    .get_document_review(session.user.id, run_id)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?
    .ok_or_else(|| Error::new("Document review unavailable"))?;
  service
    .stop_run(session.user.id, run_id)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  service
    .get_document_review(session.user.id, run_id)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?
    .ok_or_else(|| Error::new("Document review unavailable"))
    .and_then(map_document_review)
}

pub(crate) async fn retry_document_review(
  ctx: &Context<'_>,
  input: DocumentReviewRunInput,
) -> Result<DocumentReviewObjectType> {
  let (state, session) = require_session(ctx).await?;
  let service = crate::graphql::auth::workspace_automation::service(&state)?;
  let run_id = parse_uuid_id(&input.run_id, "runId")?;
  service
    .get_document_review(session.user.id, run_id)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?
    .ok_or_else(|| Error::new("Document review unavailable"))?;
  service
    .retry_run(session.user.id, run_id)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?;
  service
    .get_document_review(session.user.id, run_id)
    .await
    .map_err(crate::graphql::auth::workspace_automation::map_workspace_automation_error)?
    .ok_or_else(|| Error::new("Document review unavailable"))
    .and_then(map_document_review)
}
