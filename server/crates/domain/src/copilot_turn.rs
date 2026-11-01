// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
//! Last-turn claims. Adapters apply these transitions to a locked session snapshot.

use crate::entities::{CopilotMessage, CopilotMessageRole, CopilotSession};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use uuid::Uuid;

const SYSTEM_PARAMS: [&str; 10] = [
  "sequence",
  "streamId",
  "streamStatus",
  "requestId",
  "requestDeadline",
  "responseTo",
  "expectedStreamId",
  "generationModel",
  "generationReasoning",
  "inputRequestId",
];

/// Trusted ingress identity and a server-generated lease, never message params.
#[derive(Clone)]
pub struct CopilotTurnRequest {
  pub user_id: Uuid,
  pub session_id: Uuid,
  pub workspace_id: Option<Uuid>,
  pub doc_id: Option<Uuid>,
  pub request_id: String,
  pub user_message_id: Uuid,
  pub assistant_message_id: Option<Uuid>,
  pub expected_stream_id: Option<Uuid>,
  pub model: String,
  pub reasoning: Option<bool>,
  pub stream_id: Uuid,
  pub response_id: Uuid,
  pub now: DateTime<Utc>,
  pub deadline: DateTime<Utc>,
}

pub struct CopilotTurnClaim {
  pub message: CopilotMessage,
  /// The provider consumes the same locked last-user snapshot that was claimed.
  pub history: Vec<CopilotMessage>,
  /// Only the acquiring caller may invoke the provider. Others read back state.
  pub acquired: bool,
}

pub struct PreparedCopilotTurn {
  pub claim: CopilotTurnClaim,
  pub write: bool,
  pub revision: Option<CopilotMessage>,
}

pub fn valid_request_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 128 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// A deliberate edit based on an older snapshot may change content, but must
/// not roll back a concurrently acquired response anchor or generation lease.
pub fn preserve_turn_metadata(message: &mut CopilotMessage, current: &CopilotMessage) {
  let Some(current_params) = current.token_usage.as_ref().and_then(Value::as_object) else {
    return;
  };
  if !SYSTEM_PARAMS.iter().any(|key| current_params.contains_key(*key)) {
    return;
  }
  let mut params = message
    .token_usage
    .as_ref()
    .and_then(Value::as_object)
    .cloned()
    .unwrap_or_default();
  for key in SYSTEM_PARAMS {
    if let Some(value) = current_params.get(key) {
      params.insert(key.into(), value.clone());
    }
  }
  // A deliberate edit takes ownership from the current generation, even when
  // its content was prepared against an older stream snapshot.
  if message.edited_at.is_some()
    && message.edited_at != current.edited_at
    && current
      .token_usage
      .as_ref()
      .is_some_and(|usage| usage["streamStatus"] == "running" && usage.get("streamId").is_some())
  {
    params.insert("streamStatus".into(), json!("canceled"));
  }
  message.token_usage = Some(Value::Object(params));
}

/// Remove reserved bookkeeping at the untrusted message-params boundary.
pub fn user_params(params: Option<Value>) -> Value {
  let mut params = params.and_then(|value| value.as_object().cloned()).unwrap_or_default();
  for key in SYSTEM_PARAMS {
    params.remove(key);
  }
  Value::Object(params)
}

/// Duplicate message submissions must carry the same user payload, not merely
/// reuse the same key. Generated IDs, timestamps and sequence are not payload.
pub fn same_submission(left: &CopilotMessage, right: &CopilotMessage) -> bool {
  left.content == right.content
    && user_params(left.token_usage.clone()) == user_params(right.token_usage.clone())
    && left
      .attachment_refs
      .iter()
      .map(|a| (&a.blob_key, &a.file_name, &a.mime_type, a.size_bytes, &a.metadata))
      .eq(
        right
          .attachment_refs
          .iter()
          .map(|a| (&a.blob_key, &a.file_name, &a.mime_type, a.size_bytes, &a.metadata)),
      )
}

pub fn prepare_turn_claim(
  session: &CopilotSession,
  messages: &[CopilotMessage],
  request: &CopilotTurnRequest,
) -> Result<PreparedCopilotTurn, &'static str> {
  if session.id != request.session_id || session.user_id != request.user_id || session.deleted_at.is_some() {
    return Err("copilot session is unavailable");
  }
  if session.workspace_id != request.workspace_id || session.doc_id != request.doc_id {
    return Err("copilot session scope changed");
  }
  if !valid_request_id(&request.request_id) || request.deadline <= request.now {
    return Err("invalid copilot request lease");
  }
  let user = messages
    .iter()
    .rev()
    .find(|m| m.role == CopilotMessageRole::User)
    .filter(|m| m.id == request.user_message_id)
    .ok_or("copilot user target is not the last turn")?;
  let last = messages.last().ok_or("copilot turn is empty")?;
  let response = if last.id == user.id {
    None
  } else {
    Some(
      Some(last)
        .filter(|m| m.role == CopilotMessageRole::Assistant)
        .ok_or("copilot response target is not the last turn")?,
    )
  };
  if request
    .assistant_message_id
    .is_some_and(|id| response.is_none_or(|m| m.id != id))
  {
    return Err("copilot assistant target is stale");
  }
  if messages.iter().any(|message| {
    message
      .token_usage
      .as_ref()
      .is_some_and(|usage| usage["requestId"] == request.request_id)
      && response.is_none_or(|response| response.id != message.id)
  }) {
    return Err("copilot request id belongs to a different response anchor");
  }
  if messages.iter().any(|message| {
    message.role == CopilotMessageRole::Assistant
      && message
        .token_usage
        .as_ref()
        .is_some_and(|usage| usage["responseTo"] == json!(user.id))
      && response.is_none_or(|response| response.id != message.id)
  }) {
    return Err("copilot user turn already has a different response anchor");
  }
  if let Some(response) = response {
    let usage = response.token_usage.as_ref().cloned().unwrap_or_else(|| json!({}));
    if usage.get("responseTo").is_some_and(|value| value != &json!(user.id)) {
      return Err("copilot response anchor does not match");
    }
    if usage["requestId"] == request.request_id {
      if usage["expectedStreamId"] != json!(request.expected_stream_id)
        || usage["generationModel"] != request.model
        || usage["generationReasoning"] != json!(request.reasoning)
      {
        return Err("copilot request id was reused with different generation options");
      }
      let mut message = response.clone();
      let expired = usage["streamStatus"] == "running"
        && usage["requestDeadline"]
          .as_str()
          .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
          .is_some_and(|deadline| deadline <= request.now);
      if expired {
        message.token_usage.as_mut().expect("claim metadata")["streamStatus"] = json!("failed");
      }
      return Ok(PreparedCopilotTurn {
        claim: CopilotTurnClaim {
          message,
          history: Vec::new(),
          acquired: false,
        },
        write: expired,
        revision: None,
      });
    }
    if request.assistant_message_id != Some(response.id) {
      return Err("an existing response requires an explicit regeneration target");
    }
    let stream = usage["streamId"].as_str().and_then(|value| Uuid::parse_str(value).ok());
    if request.expected_stream_id != stream {
      return Err("copilot generation target is stale");
    }
  } else if request.assistant_message_id.is_some() || request.expected_stream_id.is_some() {
    return Err("copilot response target is unavailable");
  }
  if messages.iter().any(|message| {
    message.token_usage.as_ref().is_some_and(|usage| {
      usage["streamStatus"] == "running"
        && usage["requestDeadline"]
          .as_str()
          .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
          .is_none_or(|deadline| deadline > request.now)
    })
  }) {
    return Err("copilot generation is already in progress");
  }
  let revision = response
    .filter(|m| {
      m.content.as_str().is_some_and(|value| !value.is_empty())
        || m
          .content
          .get("text")
          .and_then(Value::as_str)
          .is_some_and(|v| !v.is_empty())
        || m
          .content
          .get("streamObjects")
          .and_then(Value::as_array)
          .is_some_and(|v| !v.is_empty())
    })
    .cloned();
  let sequence = response
    .and_then(|m| m.token_usage.as_ref())
    .and_then(|v| v["sequence"].as_i64())
    .unwrap_or_else(|| {
      messages
        .iter()
        .filter_map(|m| m.token_usage.as_ref()?.get("sequence")?.as_i64())
        .max()
        .unwrap_or(messages.len() as i64)
        + 1
    });
  let message = CopilotMessage {
    id: response.map_or(request.response_id, |m| m.id),
    session_id: session.id,
    role: CopilotMessageRole::Assistant,
    content: json!({"text":"","streamObjects":[]}),
    token_usage: Some(
      json!({"sequence":sequence,"responseTo":user.id,"requestId":request.request_id,
      "streamId":request.stream_id,"streamStatus":"running","requestDeadline":request.deadline,
      "expectedStreamId":request.expected_stream_id,"generationModel":request.model,"generationReasoning":request.reasoning}),
    ),
    tool_calls: Vec::new(),
    attachment_refs: Vec::new(),
    edited_at: None,
    created_at: response.map_or(request.now, |m| m.created_at),
  };
  let end = messages
    .iter()
    .position(|m| m.id == user.id)
    .expect("last user in snapshot")
    + 1;
  Ok(PreparedCopilotTurn {
    claim: CopilotTurnClaim {
      message,
      history: messages[..end].to_vec(),
      acquired: true,
    },
    write: true,
    revision,
  })
}
