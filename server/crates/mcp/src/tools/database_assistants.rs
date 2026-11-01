// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded package reads share the canonical preparation owner. Confirmation
//! stays on database_create with its existing authenticated idempotency guard.
use super::*;
use myoxus_domain::assistant_package::{
  AssistantPackageContext, AssistantPackageIdentity, AssistantPreparedProject, AssistantValue,
};
use std::collections::BTreeMap;

pub(super) fn service(
  state: &McpToolState,
) -> Result<&myoxus_application::workspace::assistant_packages::AssistantPackageService, (i32, String)> {
  state
    .assistant_packages
    .as_deref()
    .ok_or_else(|| (-32002, "assistant packages unavailable".into()))
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Confirmation {
  pub request_id: Uuid,
  pub admission_confirmation: Option<String>,
  pub identity: AssistantPackageIdentity,
  pub answers: BTreeMap<String, AssistantValue>,
  pub plan_digest: String,
  pub locale: Option<String>,
  pub client_version: Option<u32>,
}

pub(super) struct PreparedConfirmation {
  pub plan: AssistantPreparedProject,
  pub input: myoxus_application::workspace::ProjectStarterInput,
}

pub(super) fn starter_error(error: myoxus_application::workspace::ProjectStarterError) -> (i32, String) {
  use myoxus_application::workspace::ProjectStarterError;
  match error {
    ProjectStarterError::Database(error) => mcp_database_error(error),
    ProjectStarterError::Auth(_) => (-32004, "Project setup is not authorized or unavailable".into()),
    ProjectStarterError::Conflict => (
      -32010,
      "MIX_ASSISTANT_REQUEST_CONFLICT: Project setup input changed".into(),
    ),
    ProjectStarterError::Gone { .. } => (
      -32010,
      "MIX_ASSISTANT_RESULT_GONE: accepted Project result was deleted".into(),
    ),
  }
}
async fn reviewed_locale(state: &McpToolState, actor: Uuid, requested: Option<&str>) -> Result<String, (i32, String)> {
  if let Some(locale) = requested {
    return Ok(locale.to_string());
  }
  if let Some(users) = &state.users {
    let preferences = users
      .auth
      .get_user_preferences(actor)
      .await
      .map_err(|_| (-32002, "account locale unavailable".into()))?;
    if let Some(locale) = preferences.values.locale {
      return Ok(locale);
    }
  }
  Ok(service(state)?.default_locale().to_string())
}
pub(super) async fn canonical_confirmation(
  state: &McpToolState,
  actor: Uuid,
  workspace: Uuid,
  value: Value,
) -> Result<PreparedConfirmation, (i32, String)> {
  if value.to_string().len() > myoxus_domain::assistant_package::ASSISTANT_INPUT_MAX_BYTES {
    return Err((-32602, "assistant confirmation exceeds byte limit".into()));
  }
  let value: Confirmation =
    serde_json::from_value(value).map_err(|_| (-32602, "invalid typed assistant confirmation".into()))?;
  // A confirmed replay cannot consult a subsequently changed account default.
  let locale = value
    .locale
    .ok_or_else(|| (-32602, "confirmation requires its prepared locale".into()))?;
  let input = myoxus_application::workspace::ProjectStarterInput {
    request_id: value.request_id,
    package: value.identity,
    answers: value.answers,
    locale,
    client_version: value.client_version,
    plan_digest: value.plan_digest,
    admission_confirmation: value.admission_confirmation,
  };
  // Accepted native state precedes current offering admission. Transport replay
  // cannot substitute for this durable actor/request/result ownership check.
  if let Some(existing) = state
    .workspace_service
    .get_project_starter_for_input(actor, workspace, &input, service(state)?)
    .await
    .map_err(starter_error)?
  {
    if existing.accepted.fingerprint != input.fingerprint(workspace) {
      return Err(starter_error(
        myoxus_application::workspace::ProjectStarterError::Conflict,
      ));
    }
    return Ok(PreparedConfirmation {
      plan: existing.current_review.unwrap_or(existing.accepted.plan),
      input,
    });
  }
  let plan = service(state)?
    .prepare_project(
      actor,
      workspace,
      &input.package,
      input.answers.clone(),
      &input.locale,
      input.client_version,
    )
    .await
    .map_err(mcp_database_error)?;
  if myoxus_application::workspace::assistant_packages::plan_digest(&plan) != input.plan_digest {
    return Err((-32602, "reviewed assistant plan changed; prepare again".into()));
  }
  Ok(PreparedConfirmation { plan, input })
}
#[tracing::instrument(skip_all)]
pub(super) async fn list(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, false)?;
  super::database::schema_arguments(params, &["workspace_id"], state)?;
  let workspace = parse_uuid(params, "workspace_id")?;
  database_services(state)?
    .views
    .assert_workspace_read(auth.user_id, workspace)
    .await
    .map_err(mcp_database_error)?;
  let packages = service(state)?
    .list(AssistantPackageContext::ProjectCreation)
    .into_iter()
    .map(|p| json!({"identity":p.identity,"name":p.name,"description":p.description,"inputs":p.inputs}))
    .collect::<Vec<_>>();
  super::database::bounded_schema_response(json!({"packages":packages}), state, false)
}
#[tracing::instrument(skip_all)]
pub(super) async fn prepare(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, false)?;
  super::database::schema_arguments(
    params,
    &["workspace_id", "identity", "answers", "locale", "client_version"],
    state,
  )?;
  if params.to_string().len() > myoxus_domain::assistant_package::ASSISTANT_INPUT_MAX_BYTES {
    return Err((-32602, "assistant input exceeds byte limit".into()));
  }
  let workspace = parse_uuid(params, "workspace_id")?;
  let identity: AssistantPackageIdentity =
    serde_json::from_value(params.get("identity").cloned().unwrap_or(Value::Null))
      .map_err(|_| (-32602, "invalid assistant identity".into()))?;
  let answers: BTreeMap<String, AssistantValue> =
    serde_json::from_value(params.get("answers").cloned().unwrap_or(Value::Null))
      .map_err(|_| (-32602, "invalid typed assistant answers".into()))?;
  let locale = match params.get("locale") {
    None | Some(Value::Null) => None,
    Some(Value::String(locale)) => Some(locale.as_str()),
    Some(_) => return Err((-32602, "locale must be text".into())),
  };
  let locale = reviewed_locale(state, auth.user_id, locale).await?;
  let client_version = match params.get("client_version") {
    None | Some(Value::Null) => None,
    Some(value) => Some(
      value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| {
          (
            -32602,
            "client_version must be a positive native document consumer version".into(),
          )
        })?,
    ),
  };
  let plan = service(state)?
    .prepare_project(auth.user_id, workspace, &identity, answers, &locale, client_version)
    .await
    .map_err(mcp_database_error)?;
  let digest = myoxus_application::workspace::assistant_packages::plan_digest(&plan);
  super::database::bounded_schema_response(json!({"plan":plan,"planDigest":digest}), state, false)
}

/// Recovery reads the actor's existing native request; it never prepares a new
/// offering or lets API-key transport replay allocate replacement results.
#[tracing::instrument(skip_all)]
pub(super) async fn request_status(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
  stop: bool,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, stop)?;
  super::database::schema_arguments(params, &["workspace_id", "request_id"], state)?;
  let workspace = parse_uuid(params, "workspace_id")?;
  let request = parse_uuid(params, "request_id")?;
  let result = if stop {
    Some(
      state
        .workspace_service
        .stop_project_starter(auth.user_id, workspace, request, service(state)?)
        .await
        .map_err(starter_error)?,
    )
  } else {
    state
      .workspace_service
      .get_project_starter(auth.user_id, workspace, request, service(state)?)
      .await
      .map_err(starter_error)?
  };
  let setup = result.map(|outcome| {
    use myoxus_application::workspace::ProjectStarterStatus;
    let status = match outcome.status {
      ProjectStarterStatus::Ready => "ready",
      ProjectStarterStatus::Pending => "pending",
      ProjectStarterStatus::StopRequested => "stopRequested",
      ProjectStarterStatus::Stopped => "stopped",
      ProjectStarterStatus::ReReviewRequired => "reReviewRequired",
      ProjectStarterStatus::Unavailable => "unavailable",
    };
    let documents = outcome
      .documents
      .into_iter()
      .map(|document| {
        json!({
          "componentId":document.component_id,"reservedDocumentId":document.reserved_document_id,
          "externalId":document.external_id,"created":document.created,"placed":document.placed,
        })
      })
      .collect::<Vec<_>>();
    json!({"requestId":outcome.accepted.request_id,"status":status,"documents":documents,
      "folderId":outcome.accepted.ids.folder_id,"placementComplete":outcome.accepted.progress.placement_complete,
      "reservedDatabaseId":outcome.accepted.ids.database_id,"acceptedPlan":outcome.accepted.plan,
      "currentReview":outcome.current_review,"database":outcome.database,"reasonCode":outcome.reason_code})
  });
  super::database::bounded_schema_response(json!({"setup":setup}), state, stop)
}
