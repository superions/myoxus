// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only Workspace Automation projections. The existing service owns ACL,
//! inventory and run state; trigger/action content never enters these outputs.

use myoxus_application::workspace_automation::{self as application, WorkspaceAutomationServiceError};
use myoxus_domain::repositories::PageRequest;
use myoxus_domain::workspace_automation::{WorkspaceAutomation, WorkspaceAutomationRun, WorkspaceAutomationRunOrigin};
use serde_json::{Value, json};

use super::{
  McpAuthContext, McpToolState, mcp_json_response, parse_optional_i64, parse_optional_uuid, parse_uuid,
  require_mcp_scope,
};

#[tracing::instrument(skip_all)]
pub(super) async fn read(
  name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_scope(auth, "read:automations")?;
  let allowed = match name {
    "automation_list" | "automation_dead_letter_list" => &["workspace_id", "limit", "offset"][..],
    "automation_run_list" => &[
      "workspace_id",
      "automation_id",
      "include_dead_letter",
      "limit",
      "offset",
    ][..],
    "automation_run_get" => &["run_id"][..],
    _ => return Err((-32601, "Unknown automation read operation".into())),
  };
  let args = params
    .as_object()
    .ok_or_else(|| (-32602, "Expected automation arguments object".to_owned()))?;
  if args.keys().any(|key| !allowed.contains(&key.as_str()))
    || params.to_string().len() > state.document_export_max_bytes
  {
    return Err((-32602, "Unknown or oversized automation arguments".into()));
  }
  let service = state
    .workspace_automation_service
    .as_ref()
    .ok_or_else(|| (-32002, "Workspace Automation capability is unavailable".to_owned()))?;
  let output = if name == "automation_run_get" {
    json!({"run":safe_run(service.get_run(auth.user_id,parse_uuid(params,"run_id")?).await.map_err(read_error)?)})
  } else {
    let workspace = parse_uuid(params, "workspace_id")?;
    let limit = bounded_number(params, "limit", 50, 1, 200)?;
    let offset = bounded_number(params, "offset", 0, 0, i64::MAX - 200)?;
    // One lookahead item proves continuation; never expose a silently cut list.
    let page = PageRequest {
      limit: limit + 1,
      offset,
    };
    let mut items = if name == "automation_list" {
      service
        .list_automations(auth.user_id, workspace, page)
        .await
        .map_err(read_error)?
        .into_iter()
        .map(safe_automation)
        .collect::<Vec<_>>()
    } else {
      let runs = if name == "automation_dead_letter_list" {
        service
          .list_dead_letter_runs(auth.user_id, workspace, page)
          .await
          .map_err(read_error)?
      } else {
        let automation = parse_optional_uuid(params, "automation_id")?;
        if args.contains_key("automation_id") && automation.is_none() {
          return Err((-32602, "automation_id must be a UUID when supplied".into()));
        }
        let include = match params.get("include_dead_letter") {
          None => false,
          Some(Value::Bool(value)) => *value,
          _ => return Err((-32602, "include_dead_letter must be Boolean".into())),
        };
        service
          .list_runs(auth.user_id, workspace, automation, include, page)
          .await
          .map_err(read_error)?
      };
      runs.into_iter().map(safe_run).collect()
    };
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let mut output =
      json!({"offset":offset,"limit":limit,"has_more":more,"next_offset":if more{Some(offset+limit)}else{None}});
    output[if name == "automation_list" {
      "automations"
    } else {
      "runs"
    }] = json!(items);
    output
  };
  if output.to_string().len() > state.document_export_max_bytes {
    return Err((
      -32002,
      "Automation read exceeds the configured MCP response byte ceiling".into(),
    ));
  }
  Ok(mcp_json_response(output))
}

fn bounded_number(params: &Value, key: &str, default: i64, min: i64, max: i64) -> Result<i64, (i32, String)> {
  let value = parse_optional_i64(params, key)?.unwrap_or(default);
  if params.get(key).is_some_and(Value::is_null) || !(min..=max).contains(&value) {
    return Err((-32602, format!("{key} is outside its integer bounds")));
  }
  Ok(value)
}

fn read_error(error: WorkspaceAutomationServiceError) -> (i32, String) {
  match error.code {
    application::ERR_AUTOMATION_FORBIDDEN => (
      -32003,
      "MIX_AUTOMATION_FORBIDDEN: Workspace Automation read is forbidden".into(),
    ),
    application::ERR_AUTOMATION_NOT_FOUND => (-32004, "MIX_AUTOMATION_NOT_FOUND: Automation run not found".into()),
    _ => (-32002, "Workspace Automation capability is unavailable".into()),
  }
}

fn safe_automation(automation: WorkspaceAutomation) -> Value {
  json!({"id":automation.id,"workspaceId":automation.workspace_id,"name":automation.name,"status":automation.status.as_str(),
    "triggerType":automation.trigger.trigger_type.as_str(),"databaseId":automation.trigger.database_id,"fieldId":automation.trigger.field_id,
    "actionTypes":automation.actions.iter().map(|action|action.config.action_type().as_str()).collect::<Vec<_>>(),
    "createdBy":automation.created_by,"updatedBy":automation.updated_by,"createdAt":automation.created_at,"updatedAt":automation.updated_at})
}

/// Error messages may contain webhook URLs or action content. Keep known public
/// codes and a static summary; unknown persisted strings are never echoed.
fn safe_run(run: WorkspaceAutomationRun) -> Value {
  let (code, summary) = application::safe_error_projection(&run);
  let (origin, request_id) = match &run.origin {
    WorkspaceAutomationRunOrigin::Rule => ("rule", None),
    WorkspaceAutomationRunOrigin::RecurringTask { .. } => ("recurring_task", None),
    WorkspaceAutomationRunOrigin::WorkspaceSetup { request_id, .. } => ("workspace_setup", Some(*request_id)),
    WorkspaceAutomationRunOrigin::ConfirmedContextDocuments { request_id, .. } => {
      ("confirmed_request", Some(*request_id))
    }
    WorkspaceAutomationRunOrigin::TaskMaintenance { request_id, .. } => ("task_maintenance", Some(*request_id)),
    WorkspaceAutomationRunOrigin::TaskHandover { request_id, .. } => ("task_handover", Some(*request_id)),
    WorkspaceAutomationRunOrigin::DocumentReview { request_id, .. } => ("document_review", Some(*request_id)),
  };
  json!({"id":run.id,"automationId":run.automation_id,"workspaceId":run.workspace_id,"jobId":run.job_id,
    "origin":origin,"requestId":request_id,
    "triggerType":run.trigger_type.map(|kind|kind.as_str()),"status":run.status.as_str(),"attemptCount":run.attempt_count,
    "errorCode":code,"errorSummary":summary,"deadLetter":run.dead_letter,"queuedAt":run.queued_at,"startedAt":run.started_at,"finishedAt":run.finished_at})
}
