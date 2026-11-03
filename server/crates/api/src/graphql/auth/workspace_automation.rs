//! GraphQL contract for server-owned Workspace Automations.
//!
//! Workspace Automations are created and read through the authenticated
//! Workspace contract. The resolver layer maps GraphQL inputs into the domain
//! action/trigger envelopes and delegates permission, idempotency, audit and
//! worker handoff to `WorkspaceAutomationService`.

use std::sync::Arc;

use async_graphql::{Context, Enum, Error, ErrorExtensions, ID, InputObject, Result, SimpleObject};
use chrono::{DateTime, Utc};
use myoxus_application::workspace_automation::WorkspaceAutomationService;
use myoxus_domain::ids::{WorkspaceAutomationId, WorkspaceId};
use myoxus_domain::repositories::PageRequest;
use myoxus_domain::workspace_automation as domain;
use serde_json::Value as JsonValue;

use crate::graphql::utils::require_session;
use crate::state::ApiState;

use super::database::{DatabaseCellValueInput, parse_cell_value, parse_uuid_id};

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkspaceAutomationStatus", rename_items = "PascalCase")]
pub enum WorkspaceAutomationStatusType {
  Enabled,
  Disabled,
}

impl From<domain::WorkspaceAutomationStatus> for WorkspaceAutomationStatusType {
  fn from(value: domain::WorkspaceAutomationStatus) -> Self {
    match value {
      domain::WorkspaceAutomationStatus::Enabled => Self::Enabled,
      domain::WorkspaceAutomationStatus::Disabled => Self::Disabled,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkspaceAutomationTriggerKind", rename_items = "PascalCase")]
pub enum WorkspaceAutomationTriggerKindType {
  RowCreated,
  RowUpdated,
  RelationChanged,
  StatusSelectChanged,
}

impl From<WorkspaceAutomationTriggerKindType> for domain::WorkspaceAutomationTriggerType {
  fn from(value: WorkspaceAutomationTriggerKindType) -> Self {
    match value {
      WorkspaceAutomationTriggerKindType::RowCreated => Self::RowCreated,
      WorkspaceAutomationTriggerKindType::RowUpdated => Self::RowUpdated,
      WorkspaceAutomationTriggerKindType::RelationChanged => Self::RelationChanged,
      WorkspaceAutomationTriggerKindType::StatusSelectChanged => Self::StatusSelectChanged,
    }
  }
}

impl From<domain::WorkspaceAutomationTriggerType> for WorkspaceAutomationTriggerKindType {
  fn from(value: domain::WorkspaceAutomationTriggerType) -> Self {
    match value {
      domain::WorkspaceAutomationTriggerType::RowCreated => Self::RowCreated,
      domain::WorkspaceAutomationTriggerType::RowUpdated => Self::RowUpdated,
      domain::WorkspaceAutomationTriggerType::RelationChanged => Self::RelationChanged,
      domain::WorkspaceAutomationTriggerType::StatusSelectChanged => Self::StatusSelectChanged,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkspaceAutomationActionKind", rename_items = "PascalCase")]
pub enum WorkspaceAutomationActionKindType {
  CreateRow,
  UpdateCell,
  CreateLinkedDocument,
  NotifyWebhook,
}

impl From<domain::WorkspaceAutomationActionType> for WorkspaceAutomationActionKindType {
  fn from(value: domain::WorkspaceAutomationActionType) -> Self {
    match value {
      domain::WorkspaceAutomationActionType::CreateRow => Self::CreateRow,
      domain::WorkspaceAutomationActionType::UpdateCell => Self::UpdateCell,
      domain::WorkspaceAutomationActionType::CreateLinkedDocument => Self::CreateLinkedDocument,
      domain::WorkspaceAutomationActionType::NotifyWebhook => Self::NotifyWebhook,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkspaceAutomationRunStatus", rename_items = "PascalCase")]
pub enum WorkspaceAutomationRunStatusType {
  Queued,
  Running,
  Succeeded,
  Failed,
  DeadLetter,
  Skipped,
}

impl From<domain::WorkspaceAutomationRunStatus> for WorkspaceAutomationRunStatusType {
  fn from(value: domain::WorkspaceAutomationRunStatus) -> Self {
    match value {
      domain::WorkspaceAutomationRunStatus::Queued => Self::Queued,
      domain::WorkspaceAutomationRunStatus::Running => Self::Running,
      domain::WorkspaceAutomationRunStatus::Succeeded => Self::Succeeded,
      domain::WorkspaceAutomationRunStatus::Failed => Self::Failed,
      domain::WorkspaceAutomationRunStatus::DeadLetter => Self::DeadLetter,
      domain::WorkspaceAutomationRunStatus::Skipped => Self::Skipped,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "WorkspaceAutomationTriggerType")]
pub struct WorkspaceAutomationTriggerObjectType {
  pub trigger_type: WorkspaceAutomationTriggerKindType,
  pub database_id: ID,
  pub field_id: Option<ID>,
  pub select_option_id: Option<String>,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "WorkspaceAutomationActionType")]
pub struct WorkspaceAutomationActionObjectType {
  pub position: i32,
  pub action_type: WorkspaceAutomationActionKindType,
  pub config: JsonValue,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "WorkspaceAutomationType")]
pub struct WorkspaceAutomationObjectType {
  pub id: ID,
  pub workspace_id: ID,
  pub name: String,
  pub description: Option<String>,
  pub status: WorkspaceAutomationStatusType,
  pub trigger: WorkspaceAutomationTriggerObjectType,
  pub actions: Vec<WorkspaceAutomationActionObjectType>,
  pub created_by: Option<ID>,
  pub updated_by: Option<ID>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Product origin, without exposing accepted workflow inputs or private fingerprints.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkspaceAutomationRunOrigin", rename_items = "PascalCase")]
pub enum WorkspaceAutomationRunOriginType {
  RecurringTask,
  WorkspaceSetup,
  TaskMaintenance,
  TaskHandover,
  Rule,
  ConfirmedRequest,
  DocumentReview,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "WorkspaceAutomationRunType")]
pub struct WorkspaceAutomationRunObjectType {
  pub id: ID,
  pub automation_id: Option<ID>,
  pub origin: WorkspaceAutomationRunOriginType,
  pub request_id: Option<ID>,
  pub workspace_id: ID,
  pub trigger_type: Option<WorkspaceAutomationTriggerKindType>,
  pub trigger_event: Option<JsonValue>,
  pub idempotency_key: String,
  pub status: WorkspaceAutomationRunStatusType,
  pub attempt_count: i32,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
  pub dead_letter: bool,
  pub queued_at: DateTime<Utc>,
  pub started_at: Option<DateTime<Utc>>,
  pub finished_at: Option<DateTime<Utc>>,
}

#[derive(InputObject)]
pub struct WorkspaceAutomationTriggerInput {
  pub trigger_type: WorkspaceAutomationTriggerKindType,
  pub database_id: ID,
  pub field_id: Option<ID>,
  pub select_option_id: Option<String>,
}

#[derive(InputObject)]
pub struct WorkspaceAutomationCellInput {
  pub field_id: ID,
  pub value: DatabaseCellValueInput,
}

#[derive(InputObject)]
pub struct WorkspaceAutomationCreateRowActionInput {
  pub database_id: ID,
  pub title_template: Option<String>,
  pub cells: Option<Vec<WorkspaceAutomationCellInput>>,
}

#[derive(InputObject)]
pub struct WorkspaceAutomationUpdateCellActionInput {
  pub row_id: ID,
  pub field_id: ID,
  pub value: DatabaseCellValueInput,
}

#[derive(InputObject)]
pub struct WorkspaceAutomationCreateLinkedDocumentActionInput {
  pub title_template: String,
  pub relation_field_id: Option<ID>,
}

#[derive(InputObject)]
pub struct WorkspaceAutomationNotifyWebhookActionInput {
  pub url: String,
  pub secret_ref: Option<String>,
}

#[derive(InputObject)]
pub struct WorkspaceAutomationActionConfigInput {
  pub create_row: Option<WorkspaceAutomationCreateRowActionInput>,
  pub update_cell: Option<WorkspaceAutomationUpdateCellActionInput>,
  pub create_linked_document: Option<WorkspaceAutomationCreateLinkedDocumentActionInput>,
  pub notify_webhook: Option<WorkspaceAutomationNotifyWebhookActionInput>,
}

#[derive(InputObject)]
pub struct WorkspaceAutomationActionDefinitionInput {
  pub position: i32,
  pub config: WorkspaceAutomationActionConfigInput,
}

#[derive(InputObject)]
pub struct CreateWorkspaceAutomationInput {
  pub workspace_id: ID,
  pub name: String,
  pub description: Option<String>,
  pub trigger: WorkspaceAutomationTriggerInput,
  pub actions: Vec<WorkspaceAutomationActionDefinitionInput>,
}

#[derive(InputObject)]
pub struct DisableWorkspaceAutomationInput {
  pub automation_id: ID,
}

pub(crate) async fn list_workspace_automations(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  first: Option<i32>,
  offset: Option<i32>,
) -> Result<Vec<WorkspaceAutomationObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let automations = service(&state)?
    .list_automations(snapshot.user.id, workspace_id, page_request(first, offset))
    .await
    .map_err(map_workspace_automation_error)?;
  Ok(automations.into_iter().map(map_automation).collect())
}

pub(crate) async fn list_workspace_automation_runs(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  automation_id: Option<ID>,
  include_dead_letter: Option<bool>,
  first: Option<i32>,
  offset: Option<i32>,
) -> Result<Vec<WorkspaceAutomationRunObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let automation_id = automation_id
    .map(|id| parse_uuid_id::<WorkspaceAutomationId>(&id, "automationId"))
    .transpose()?;
  let runs = service(&state)?
    .list_runs(
      snapshot.user.id,
      workspace_id,
      automation_id,
      include_dead_letter.unwrap_or(false),
      page_request(first, offset),
    )
    .await
    .map_err(map_workspace_automation_error)?;
  Ok(runs.into_iter().map(map_run).collect())
}

pub(crate) async fn create_workspace_automation(
  ctx: &Context<'_>,
  input: CreateWorkspaceAutomationInput,
) -> Result<WorkspaceAutomationObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let automation = service(&state)?
    .create_automation(
      snapshot.user.id,
      workspace_id,
      input.name,
      input.description,
      parse_trigger(input.trigger)?,
      input
        .actions
        .into_iter()
        .map(parse_action_definition)
        .collect::<Result<Vec<_>>>()?,
    )
    .await
    .map_err(map_workspace_automation_error)?;
  Ok(map_automation(automation))
}

pub(crate) async fn disable_workspace_automation(
  ctx: &Context<'_>,
  input: DisableWorkspaceAutomationInput,
) -> Result<WorkspaceAutomationObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let automation_id = parse_uuid_id(&input.automation_id, "automationId")?;
  let automation = service(&state)?
    .disable_automation(snapshot.user.id, automation_id)
    .await
    .map_err(map_workspace_automation_error)?;
  Ok(map_automation(automation))
}

pub(super) fn service(state: &ApiState) -> Result<Arc<WorkspaceAutomationService>> {
  state.workspace_automation_service().ok_or_else(|| {
    automation_error(
      "MIX_AUTOMATION_NOT_FOUND",
      "workspace automation service is not configured",
    )
  })
}

fn page_request(first: Option<i32>, offset: Option<i32>) -> PageRequest {
  PageRequest {
    limit: first.unwrap_or(50).max(1) as i64,
    offset: offset.unwrap_or(0).max(0) as i64,
  }
}

fn parse_trigger(input: WorkspaceAutomationTriggerInput) -> Result<domain::WorkspaceAutomationTrigger> {
  Ok(domain::WorkspaceAutomationTrigger {
    trigger_type: input.trigger_type.into(),
    database_id: parse_uuid_id(&input.database_id, "databaseId")?,
    field_id: input.field_id.map(|id| parse_uuid_id(&id, "fieldId")).transpose()?,
    select_option_id: input.select_option_id,
  })
}

fn parse_action_definition(
  input: WorkspaceAutomationActionDefinitionInput,
) -> Result<domain::WorkspaceAutomationActionDefinition> {
  Ok(domain::WorkspaceAutomationActionDefinition {
    position: input.position,
    config: parse_action_config(input.config)?,
  })
}

fn parse_action_config(input: WorkspaceAutomationActionConfigInput) -> Result<domain::WorkspaceAutomationActionConfig> {
  let set_count = [
    input.create_row.is_some(),
    input.update_cell.is_some(),
    input.create_linked_document.is_some(),
    input.notify_webhook.is_some(),
  ]
  .into_iter()
  .filter(|set| *set)
  .count();
  if set_count != 1 {
    return Err(automation_error(
      "MIX_AUTOMATION_ACTION_INVALID",
      "automation action config input must set exactly one action object",
    ));
  }
  if let Some(config) = input.create_row {
    return Ok(domain::WorkspaceAutomationActionConfig::CreateRow {
      database_id: parse_uuid_id(&config.database_id, "databaseId")?,
      title_template: config.title_template,
      cells: config
        .cells
        .unwrap_or_default()
        .into_iter()
        .map(|cell| {
          Ok(domain::WorkspaceAutomationCellInput {
            field_id: parse_uuid_id(&cell.field_id, "fieldId")?,
            value: parse_cell_value(cell.value)?,
          })
        })
        .collect::<Result<Vec<_>>>()?,
    });
  }
  if let Some(config) = input.update_cell {
    return Ok(domain::WorkspaceAutomationActionConfig::UpdateCell {
      row_id: parse_uuid_id(&config.row_id, "rowId")?,
      field_id: parse_uuid_id(&config.field_id, "fieldId")?,
      value: parse_cell_value(config.value)?,
    });
  }
  if let Some(config) = input.create_linked_document {
    return Ok(domain::WorkspaceAutomationActionConfig::CreateLinkedDocument {
      title_template: config.title_template,
      source: None,
      relation_field_id: config
        .relation_field_id
        .map(|id| parse_uuid_id(&id, "relationFieldId"))
        .transpose()?,
    });
  }
  if let Some(config) = input.notify_webhook {
    return Ok(domain::WorkspaceAutomationActionConfig::NotifyWebhook {
      url: config.url,
      secret_ref: config.secret_ref,
    });
  }
  unreachable!("set_count enforces one action config input")
}

fn automation_error(code: &'static str, message: impl Into<String>) -> Error {
  Error::new(message.into()).extend_with(|_, e| {
    e.set("code", code);
    e.set("type", code);
    e.set("name", code);
  })
}

pub(super) fn map_workspace_automation_error(
  error: myoxus_application::workspace_automation::WorkspaceAutomationServiceError,
) -> Error {
  automation_error(error.code, error.message)
}

fn map_automation(automation: domain::WorkspaceAutomation) -> WorkspaceAutomationObjectType {
  WorkspaceAutomationObjectType {
    id: ID(automation.id.to_string()),
    workspace_id: ID(automation.workspace_id.to_string()),
    name: automation.name,
    description: automation.description,
    status: automation.status.into(),
    trigger: WorkspaceAutomationTriggerObjectType {
      trigger_type: automation.trigger.trigger_type.into(),
      database_id: ID(automation.trigger.database_id.to_string()),
      field_id: automation.trigger.field_id.map(|id| ID(id.to_string())),
      select_option_id: automation.trigger.select_option_id,
    },
    actions: automation.actions.into_iter().map(map_action).collect(),
    created_by: automation.created_by.map(|id| ID(id.to_string())),
    updated_by: automation.updated_by.map(|id| ID(id.to_string())),
    created_at: automation.created_at,
    updated_at: automation.updated_at,
  }
}

fn map_action(mut action: domain::WorkspaceAutomationActionDefinition) -> WorkspaceAutomationActionObjectType {
  let action_type = action.config.action_type().into();
  // Shared rule inventory is readable by other workspace members. Personal
  // source inputs belong only to the actor-bound configuration projection.
  if let domain::WorkspaceAutomationActionConfig::CreateLinkedDocument { source, .. } = &mut action.config {
    *source = None;
  }
  let config = serde_json::to_value(action.config).unwrap_or(JsonValue::Null);
  WorkspaceAutomationActionObjectType {
    position: action.position,
    action_type,
    config,
  }
}

pub(crate) fn map_run(run: domain::WorkspaceAutomationRun) -> WorkspaceAutomationRunObjectType {
  // Public status retains routing facts, never accepted Cell contents or engine input.
  let trigger_event = run.trigger_event.as_ref().map(|event| {
    serde_json::json!({
      "workspaceId":run.workspace_id,"databaseId":event.database_id,
      "rowId":event.row_id,"triggerType":event.trigger_type,
      "fieldId":event.field_id,"occurredAt":event.occurred_at,
    })
  });
  let (origin, request_id) = match &run.origin {
    domain::WorkspaceAutomationRunOrigin::RecurringTask { .. } => {
      (WorkspaceAutomationRunOriginType::RecurringTask, None)
    }
    domain::WorkspaceAutomationRunOrigin::WorkspaceSetup { request_id, .. } => (
      WorkspaceAutomationRunOriginType::WorkspaceSetup,
      Some(ID(request_id.to_string())),
    ),
    domain::WorkspaceAutomationRunOrigin::Rule => (WorkspaceAutomationRunOriginType::Rule, None),
    domain::WorkspaceAutomationRunOrigin::ConfirmedContextDocuments { request_id, .. } => (
      WorkspaceAutomationRunOriginType::ConfirmedRequest,
      Some(ID(request_id.to_string())),
    ),
    domain::WorkspaceAutomationRunOrigin::TaskMaintenance { request_id, .. } => (
      WorkspaceAutomationRunOriginType::TaskMaintenance,
      Some(ID(request_id.to_string())),
    ),
    domain::WorkspaceAutomationRunOrigin::TaskHandover { request_id, .. } => (
      WorkspaceAutomationRunOriginType::TaskHandover,
      Some(ID(request_id.to_string())),
    ),
    domain::WorkspaceAutomationRunOrigin::DocumentReview { request_id, .. } => (
      WorkspaceAutomationRunOriginType::DocumentReview,
      Some(ID(request_id.to_string())),
    ),
  };
  let (error_code, error_message) = myoxus_application::workspace_automation::safe_error_projection(&run);
  WorkspaceAutomationRunObjectType {
    id: ID(run.id.to_string()),
    automation_id: run.automation_id.map(|id| ID(id.to_string())),
    origin,
    request_id,
    workspace_id: ID(run.workspace_id.to_string()),
    trigger_type: run.trigger_type.map(Into::into),
    trigger_event,
    // Confirmed requests retain their private input fingerprint internally;
    // callers correlate them through the already public request identity.
    idempotency_key: match run.origin {
      domain::WorkspaceAutomationRunOrigin::RecurringTask { occurrence_id, .. } => occurrence_id.to_string(),
      domain::WorkspaceAutomationRunOrigin::Rule => run.idempotency_key,
      domain::WorkspaceAutomationRunOrigin::ConfirmedContextDocuments { request_id, .. }
      | domain::WorkspaceAutomationRunOrigin::WorkspaceSetup { request_id, .. }
      | domain::WorkspaceAutomationRunOrigin::TaskMaintenance { request_id, .. }
      | domain::WorkspaceAutomationRunOrigin::TaskHandover { request_id, .. }
      | domain::WorkspaceAutomationRunOrigin::DocumentReview { request_id, .. } => request_id.to_string(),
    },
    status: run.status.into(),
    attempt_count: run.attempt_count,
    error_code: error_code.map(str::to_owned),
    error_message: error_message.map(str::to_owned),
    dead_letter: run.dead_letter,
    queued_at: run.queued_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
  }
}
