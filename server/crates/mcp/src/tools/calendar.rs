// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thin MCP adapters for the existing calendar application services.
//!
//! Input timestamps must carry an RFC 3339 offset. They are converted to the
//! UTC instants used by the application layer; the adapter never invents a
//! local timezone. Recurring-event `all`/`this` scopes map directly to
//! `NativeEventService`, and external provider events remain read-only.

use chrono::{DateTime, Duration, Utc};
use myoxus_application::auth::AuthError;
use myoxus_application::calendar::{DeleteScope, NativeCreateInput, ReminderInput, UpdateScope};
use myoxus_domain::entities::{CalendarEvent, CalendarEventOrigin};
use myoxus_domain::permission::WorkspaceAction;
use myoxus_domain::repositories::{NativeEventReminderInput, NativeEventUpdate};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{
  McpAuthContext, McpCalendarServices, McpToolState, assert_workspace_permission, begin_mcp_idempotency,
  finish_or_abort_mcp_write, mcp_json_response, parse_uuid, resolve_external_document_for_mcp,
  resolve_external_document_ids_for_mcp,
};

const MAX_WINDOW_DAYS: i64 = 93;
const MAX_RESULTS: usize = 500;
const MAX_REMINDERS: usize = 20;

fn services(state: &McpToolState) -> Result<&McpCalendarServices, (i32, String)> {
  state.calendar.as_deref().ok_or_else(|| {
    (
      -32002,
      "MIX_MCP_CALENDAR_SERVICE_UNAVAILABLE: calendar services are not configured".to_string(),
    )
  })
}

pub(super) async fn list(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  let calendar = services(state)?;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let (from, to) = parse_window(params)?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::SettingsRead).await?;
  let events = calendar
    .calendar
    .list_workspace_events(workspace_id, from, to)
    .await
    .map_err(map_auth_error)?;
  ensure_bounded_result(events.len())?;
  let source_doc_ids = events
    .iter()
    .filter_map(|event| event.source_doc_id)
    .collect::<Vec<_>>();
  let source_external_ids =
    resolve_external_document_ids_for_mcp(&state.doc_service, workspace_id, &source_doc_ids).await?;
  Ok(mcp_json_response(json!({
    "workspaceId": workspace_id,
    "from": from,
    "to": to,
    "events": events.iter().map(|event| event_json(event, &source_external_ids)).collect::<Vec<_>>(),
  })))
}

pub(super) async fn check_conflicts(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let calendar = services(state)?;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let (from, to) = parse_window(params)?;
  let exclude_id = optional_uuid(params, "exclude_event_id")?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::SettingsRead).await?;
  let conflicts = calendar
    .native_events
    .check_conflicts(workspace_id, from, to, exclude_id)
    .await
    .map_err(map_auth_error)?;
  ensure_bounded_result(conflicts.len())?;
  Ok(mcp_json_response(json!({
    "workspaceId": workspace_id,
    "from": from,
    "to": to,
    "conflicts": conflicts.iter().map(|event| json!({
      "eventId": event.event_id,
      "startsAt": event.starts_at,
      "endsAt": event.ends_at,
      "title": event.title,
    })).collect::<Vec<_>>(),
  })))
}

pub(super) async fn create(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let calendar = services(state)?;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::CreateDoc).await?;
  let source_doc_id = match optional_string(params, "source_external_id")? {
    Some(external_id) => Some(
      resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id)
        .await?
        .internal_id,
    ),
    None => None,
  };
  let input = NativeCreateInput {
    title: optional_string(params, "title")?,
    description_delta: optional_json(params, "description_delta")?,
    starts_at: parse_timestamp(params, "starts_at")?,
    ends_at: parse_timestamp(params, "ends_at")?,
    all_day: optional_bool(params, "all_day")?.unwrap_or(false),
    all_members: optional_bool(params, "all_members")?.unwrap_or(false),
    tag_id: optional_uuid(params, "tag_id")?,
    source_doc_id,
    source_anchor: None,
    reminders: parse_create_reminders(params)?,
  };
  ensure_valid_range(input.starts_at, input.ends_at)?;
  let guard = match begin_mcp_idempotency("calendar_event_create", params, auth, state).await? {
    Ok(guard) => guard,
    Err(replay) => return Ok(replay),
  };
  let result = async {
    let event = calendar
      .native_events
      .create(workspace_id, auth.user_id, input)
      .await
      .map_err(map_auth_error)?;
    let source_doc_ids = event.source_doc_id.into_iter().collect::<Vec<_>>();
    let source_external_ids =
      resolve_external_document_ids_for_mcp(&state.doc_service, workspace_id, &source_doc_ids).await?;
    Ok(mcp_json_response(event_json(&event, &source_external_ids)))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn update(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let calendar = services(state)?;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let event_id = parse_uuid(params, "event_id")?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::CreateDoc).await?;
  let scope = parse_update_scope(params)?;
  let source_doc_id = if !params
    .as_object()
    .is_some_and(|object| object.contains_key("source_external_id"))
  {
    None
  } else {
    match optional_string(params, "source_external_id")? {
      Some(external_id) => Some(Some(
        resolve_external_document_for_mcp(&state.doc_service, workspace_id, &external_id)
          .await?
          .internal_id,
      )),
      None => Some(None),
    }
  };
  let update = NativeEventUpdate {
    title: optional_string_patch(params, "title")?,
    description_delta: optional_json_patch(params, "description_delta")?,
    starts_at: optional_timestamp(params, "starts_at")?,
    ends_at: optional_timestamp(params, "ends_at")?,
    all_day: optional_bool(params, "all_day")?,
    all_members: optional_bool(params, "all_members")?,
    tag_id: optional_uuid_patch(params, "tag_id")?,
    source_doc_id,
    source_anchor: None,
    reminders: parse_update_reminders(params)?,
  };
  ensure_update_present(&update)?;
  let guard = match begin_mcp_idempotency("calendar_event_update", params, auth, state).await? {
    Ok(guard) => guard,
    Err(replay) => return Ok(replay),
  };
  let result = async {
    assert_native_event(calendar, event_id, workspace_id).await?;
    let event = calendar
      .native_events
      .update(event_id, workspace_id, auth.user_id, scope, update)
      .await
      .map_err(map_auth_error)?;
    let source_doc_ids = event.source_doc_id.into_iter().collect::<Vec<_>>();
    let source_external_ids =
      resolve_external_document_ids_for_mcp(&state.doc_service, workspace_id, &source_doc_ids).await?;
    Ok(mcp_json_response(event_json(&event, &source_external_ids)))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn delete(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let calendar = services(state)?;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let event_id = parse_uuid(params, "event_id")?;
  assert_workspace_permission(state, auth.user_id, workspace_id, WorkspaceAction::CreateDoc).await?;
  let scope = parse_delete_scope(params)?;
  let guard = match begin_mcp_idempotency("calendar_event_delete", params, auth, state).await? {
    Ok(guard) => guard,
    Err(replay) => return Ok(replay),
  };
  let result = async {
    assert_native_event(calendar, event_id, workspace_id).await?;
    calendar
      .native_events
      .delete(event_id, workspace_id, auth.user_id, scope)
      .await
      .map_err(map_auth_error)?;
    Ok(mcp_json_response(json!({ "deleted": true, "id": event_id })))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

async fn assert_native_event(
  services: &McpCalendarServices,
  event_id: Uuid,
  workspace_id: Uuid,
) -> Result<(), (i32, String)> {
  let event = services
    .calendar
    .get_event(event_id)
    .await
    .map_err(map_auth_error)?
    .ok_or_else(|| (-32004, "CALENDAR_EVENT_NOT_FOUND: calendar event not found".to_string()))?;
  if event.workspace_id != Some(workspace_id) {
    return Err((-32004, "CALENDAR_EVENT_NOT_FOUND: calendar event not found".to_string()));
  }
  if event.origin != CalendarEventOrigin::Native {
    return Err((
      -32003,
      "CALENDAR_EVENT_READ_ONLY: external calendar events cannot be changed through MCP".to_string(),
    ));
  }
  Ok(())
}

fn parse_window(params: &Value) -> Result<(DateTime<Utc>, DateTime<Utc>), (i32, String)> {
  let from = parse_timestamp(params, "from")?;
  let to = parse_timestamp(params, "to")?;
  ensure_valid_range(from, to)?;
  if to - from > Duration::days(MAX_WINDOW_DAYS) {
    return Err((
      -32602,
      format!("calendar window must not exceed {MAX_WINDOW_DAYS} days"),
    ));
  }
  Ok((from, to))
}

fn ensure_valid_range(from: DateTime<Utc>, to: DateTime<Utc>) -> Result<(), (i32, String)> {
  if to < from {
    return Err((
      -32602,
      "calendar end timestamp must not precede start timestamp".to_string(),
    ));
  }
  Ok(())
}

fn ensure_bounded_result(count: usize) -> Result<(), (i32, String)> {
  if count > MAX_RESULTS {
    return Err((
      -32009,
      format!("RESULT_TOO_LARGE: {count} events match; request a smaller time window"),
    ));
  }
  Ok(())
}

fn parse_timestamp(params: &Value, key: &str) -> Result<DateTime<Utc>, (i32, String)> {
  let value = params
    .get(key)
    .and_then(Value::as_str)
    .ok_or_else(|| (-32602, format!("Missing required RFC 3339 timestamp: {key}")))?;
  DateTime::parse_from_rfc3339(value)
    .map(|timestamp| timestamp.with_timezone(&Utc))
    .map_err(|_| (-32602, format!("{key} must be an RFC 3339 timestamp with an offset")))
}

fn optional_timestamp(params: &Value, key: &str) -> Result<Option<DateTime<Utc>>, (i32, String)> {
  if params.get(key).is_none() {
    return Ok(None);
  }
  parse_timestamp(params, key).map(Some)
}

fn optional_uuid(params: &Value, key: &str) -> Result<Option<Uuid>, (i32, String)> {
  match params.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::String(value)) => Uuid::parse_str(value)
      .map(Some)
      .map_err(|_| (-32602, format!("{key} must be a valid UUID or null"))),
    Some(_) => Err((-32602, format!("{key} must be a UUID string or null"))),
  }
}

fn optional_uuid_patch(params: &Value, key: &str) -> Result<Option<Option<Uuid>>, (i32, String)> {
  if !params.as_object().is_some_and(|object| object.contains_key(key)) {
    return Ok(None);
  }
  optional_uuid(params, key).map(Some)
}

fn optional_string(params: &Value, key: &str) -> Result<Option<String>, (i32, String)> {
  match params.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::String(value)) if value.len() <= 1024 => Ok(Some(value.clone())),
    Some(Value::String(_)) => Err((-32602, format!("{key} must not exceed 1024 characters"))),
    Some(_) => Err((-32602, format!("{key} must be a string or null"))),
  }
}

fn optional_string_patch(params: &Value, key: &str) -> Result<Option<Option<String>>, (i32, String)> {
  if !params.as_object().is_some_and(|object| object.contains_key(key)) {
    return Ok(None);
  }
  optional_string(params, key).map(Some)
}

fn optional_json(params: &Value, key: &str) -> Result<Option<Value>, (i32, String)> {
  match params.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(value @ (Value::Object(_) | Value::Array(_))) => Ok(Some(value.clone())),
    Some(_) => Err((-32602, format!("{key} must be an object, array or null"))),
  }
}

fn optional_json_patch(params: &Value, key: &str) -> Result<Option<Option<Value>>, (i32, String)> {
  if !params.as_object().is_some_and(|object| object.contains_key(key)) {
    return Ok(None);
  }
  optional_json(params, key).map(Some)
}

fn optional_bool(params: &Value, key: &str) -> Result<Option<bool>, (i32, String)> {
  match params.get(key) {
    None => Ok(None),
    Some(Value::Bool(value)) => Ok(Some(*value)),
    Some(_) => Err((-32602, format!("{key} must be a boolean"))),
  }
}

fn parse_create_reminders(params: &Value) -> Result<Vec<ReminderInput>, (i32, String)> {
  parse_reminders(params)?
    .unwrap_or_default()
    .into_iter()
    .map(|value| {
      Ok(ReminderInput {
        minutes_before: value.minutes_before,
        channel: value.channel,
      })
    })
    .collect()
}

fn parse_update_reminders(params: &Value) -> Result<Option<Vec<NativeEventReminderInput>>, (i32, String)> {
  parse_reminders(params)
}

fn parse_reminders(params: &Value) -> Result<Option<Vec<NativeEventReminderInput>>, (i32, String)> {
  let Some(value) = params.get("reminders") else {
    return Ok(None);
  };
  if value.is_null() {
    return Ok(Some(Vec::new()));
  }
  let values = value
    .as_array()
    .ok_or_else(|| (-32602, "reminders must be an array or null".to_string()))?;
  if values.len() > MAX_REMINDERS {
    return Err((
      -32602,
      format!("reminders must contain at most {MAX_REMINDERS} entries"),
    ));
  }
  values
    .iter()
    .map(|value| {
      let object = value
        .as_object()
        .ok_or_else(|| (-32602, "each reminder must be an object".to_string()))?;
      if object
        .keys()
        .any(|key| !matches!(key.as_str(), "minutes_before" | "channel"))
      {
        return Err((
          -32602,
          "reminder objects may only contain minutes_before and channel".to_string(),
        ));
      }
      let minutes_before = object
        .get("minutes_before")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0 && *value <= i32::MAX as i64)
        .ok_or_else(|| {
          (
            -32602,
            "reminder minutes_before must be a non-negative integer".to_string(),
          )
        })? as i32;
      let channel = object.get("channel").and_then(Value::as_str).unwrap_or("in_app");
      if !matches!(channel, "in_app" | "email" | "push") {
        return Err((-32602, "reminder channel must be in_app, email or push".to_string()));
      }
      Ok(NativeEventReminderInput {
        minutes_before,
        channel: channel.to_string(),
      })
    })
    .collect::<Result<Vec<_>, _>>()
    .map(Some)
}

fn parse_update_scope(params: &Value) -> Result<UpdateScope, (i32, String)> {
  match params.get("scope").and_then(Value::as_str).unwrap_or("all") {
    "all" => Ok(UpdateScope::All),
    "this" => Ok(UpdateScope::This {
      instance_start: parse_timestamp(params, "instance_start")?,
    }),
    _ => Err((-32602, "scope must be all or this".to_string())),
  }
}

fn parse_delete_scope(params: &Value) -> Result<DeleteScope, (i32, String)> {
  match params.get("scope").and_then(Value::as_str).unwrap_or("all") {
    "all" => Ok(DeleteScope::All),
    "this" => Ok(DeleteScope::This {
      instance_start: parse_timestamp(params, "instance_start")?,
    }),
    _ => Err((-32602, "scope must be all or this".to_string())),
  }
}

fn ensure_update_present(update: &NativeEventUpdate) -> Result<(), (i32, String)> {
  if update.title.is_none()
    && update.description_delta.is_none()
    && update.starts_at.is_none()
    && update.ends_at.is_none()
    && update.all_day.is_none()
    && update.all_members.is_none()
    && update.tag_id.is_none()
    && update.source_doc_id.is_none()
    && update.reminders.is_none()
  {
    return Err((
      -32602,
      "calendar update must contain at least one mutable field".to_string(),
    ));
  }
  Ok(())
}

fn event_json(event: &CalendarEvent, source_external_ids: &std::collections::HashMap<Uuid, String>) -> Value {
  json!({
    "id": event.id,
    "origin": event.origin,
    "workspaceId": event.workspace_id,
    "startsAt": event.starts_at,
    "endsAt": event.ends_at,
    "title": event.title,
    "description": event.description,
    "location": event.location,
    "allDay": event.all_day,
    "allMembers": event.all_members,
    "tagId": event.tag_id,
    "sourceExternalId": event.source_doc_id.and_then(|doc_id| source_external_ids.get(&doc_id)),
    "recurrenceParentId": event.recurrence_parent_id,
    "updatedAt": event.updated_at,
  })
}

fn map_auth_error(error: AuthError) -> (i32, String) {
  match error {
    AuthError::NotFound(_) => (-32004, "CALENDAR_EVENT_NOT_FOUND: calendar event not found".to_string()),
    AuthError::ActionForbidden => (
      -32003,
      "CALENDAR_PERMISSION_DENIED: calendar action is not allowed".to_string(),
    ),
    AuthError::InvalidInput(message) => (-32602, message),
    AuthError::Storage(_) => (
      -32002,
      "MIX_MCP_CALENDAR_SERVICE_FAILED: calendar operation failed".to_string(),
    ),
    _ => (
      -32002,
      "MIX_MCP_CALENDAR_SERVICE_FAILED: calendar operation failed".to_string(),
    ),
  }
}
