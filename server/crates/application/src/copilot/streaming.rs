// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

use super::{CopilotService, CopilotStreamHandle};
use crate::auth::{AuthError, AuthResult};
use myoxus_domain::entities::CopilotMessage;
use serde_json::json;
use tracing::{instrument, warn};
use uuid::Uuid;

/// Terminal outcome persisted in the existing message metadata. Only Completed
/// can authorize successful SSE done; cancellation never implies completion.
#[derive(Debug, Clone, Copy)]
pub enum CopilotStreamOutcome {
  Completed,
  Failed,
  Canceled,
}

impl CopilotStreamOutcome {
  fn status(self) -> &'static str {
    match self {
      Self::Completed => "done",
      Self::Failed => "failed",
      Self::Canceled => "canceled",
    }
  }
}

/// Owns disconnect cleanup even when a response body is never polled. Drop
/// schedules only bounded storage finalization, never continued generation.
pub struct CopilotStreamGuard {
  service: CopilotService,
  handle: Option<CopilotStreamHandle>,
  outcome: CopilotStreamOutcome,
}

impl CopilotStreamGuard {
  pub fn stream_id(&self) -> Uuid {
    self.handle.as_ref().expect("unfinalized stream guard").stream_id
  }
  pub fn new(service: CopilotService, handle: CopilotStreamHandle) -> Self {
    Self {
      service,
      handle: Some(handle),
      outcome: CopilotStreamOutcome::Canceled,
    }
  }
  pub async fn finish(&mut self, outcome: CopilotStreamOutcome) -> AuthResult<CopilotMessage> {
    // If storage fails, Drop retries the intended outcome rather than turning
    // a provider failure into cancellation just because the body then closes.
    self.outcome = outcome;
    let handle = self
      .handle
      .as_ref()
      .ok_or_else(|| AuthError::InvalidInput("stream guard already finalized".into()))?;
    let result = self.service.finalize_stream(handle, outcome).await;
    if result.is_ok() {
      self.handle = None;
    } else {
      // The caller will report a storage failure, so a later successful cleanup
      // must not turn that failed request into a completed generation.
      self.outcome = CopilotStreamOutcome::Failed;
    }
    if let Ok(message) = &result
      && message
        .token_usage
        .as_ref()
        .and_then(|usage| usage["streamStatus"].as_str())
        != Some(outcome.status())
    {
      return Err(AuthError::InvalidInput(
        "copilot stream already ended with a different outcome".into(),
      ));
    }
    result
  }
}

impl Drop for CopilotStreamGuard {
  fn drop(&mut self) {
    if let Some(handle) = self.handle.take() {
      let service = self.service.clone();
      let outcome = self.outcome;
      tokio::spawn(async move {
        match tokio::time::timeout(
          std::time::Duration::from_secs(30),
          service.finalize_stream(&handle, outcome),
        )
        .await
        {
          Ok(Ok(_)) => {}
          _ => warn!(stream_id = %handle.stream_id, "copilot disconnect finalization failed"),
        }
      });
    }
  }
}

impl CopilotService {
  #[instrument(skip_all)]
  pub async fn append_stream_reasoning(&self, stream_id: Uuid, text: String) -> AuthResult<CopilotMessage> {
    self.append_stream_output(stream_id, None, "reasoning", text).await
  }

  pub(super) async fn append_stream_output(
    &self,
    stream_id: Uuid,
    chunk_id: Option<String>,
    kind: &str,
    text: String,
  ) -> AuthResult<CopilotMessage> {
    // Serialize append/finalize through persistence, not just buffer mutation.
    // Releasing this lock before storage would permit an older write after done.
    let mut streams = self.active_streams.write().await;
    let stream = streams
      .get_mut(&stream_id)
      .ok_or_else(|| AuthError::InvalidInput("copilot stream not active".into()))?;
    let duplicate = chunk_id.as_ref().is_some_and(|id| stream.chunk_ids.contains(id));
    if !duplicate
      && kind == "text-delta"
      && let Some(serde_json::Value::String(answer)) = stream.message.content.get_mut("text")
    {
      answer.push_str(&text);
    }
    if !duplicate {
      let objects = stream.message.content["streamObjects"]
        .as_array_mut()
        .expect("server-created stream envelope");
      if let Some(last) = objects.last_mut().filter(|last| last["type"] == kind) {
        if let serde_json::Value::String(value) = &mut last["textDelta"] {
          value.push_str(&text);
        }
      } else {
        objects.push(json!({"type":kind,"textDelta":text}));
      }
    }
    // Retry storage for duplicate IDs too: a prior delivery may have mutated
    // the buffer but failed its write. Do not acknowledge an unpersisted value.
    if let Some(id) = chunk_id {
      stream.chunk_ids.insert(id);
    }
    if !self
      .repo
      .update_copilot_stream(&stream.message, stream_id)
      .await
      .map_err(Self::map_repo_err)?
    {
      return Err(AuthError::InvalidInput(
        "copilot generation was edited or superseded".into(),
      ));
    }
    Ok(stream.message.clone())
  }

  pub(super) async fn persist_stream_outcome(
    &self,
    handle: &CopilotStreamHandle,
    outcome: CopilotStreamOutcome,
    buffered: Option<CopilotMessage>,
  ) -> AuthResult<CopilotMessage> {
    let current = self
      .repo
      .get_copilot_message(handle.message_id)
      .await
      .map_err(Self::map_repo_err)?
      .ok_or_else(|| AuthError::InvalidInput("copilot message not found".into()))?;
    let usage = current
      .token_usage
      .as_ref()
      .ok_or_else(|| AuthError::InvalidInput("message has no generation".into()))?;
    if usage["streamId"] != handle.stream_id.to_string() {
      return Err(AuthError::InvalidInput("copilot generation superseded".into()));
    }
    if matches!(usage["streamStatus"].as_str(), Some("done" | "failed" | "canceled")) {
      return Ok(current);
    }
    let mut message = buffered.unwrap_or_else(|| current.clone());
    if message.id != handle.message_id || current.edited_at.is_some() || message.edited_at != current.edited_at {
      return Err(AuthError::InvalidInput("copilot generation was edited".into()));
    }
    message.token_usage.as_mut().expect("stream metadata")["streamStatus"] = json!(outcome.status());
    if self
      .repo
      .update_copilot_stream(&message, handle.stream_id)
      .await
      .map_err(Self::map_repo_err)?
    {
      return Ok(message);
    }
    let latest = self
      .repo
      .get_copilot_message(handle.message_id)
      .await
      .map_err(Self::map_repo_err)?
      .ok_or_else(|| AuthError::InvalidInput("copilot message not found".into()))?;
    if latest.token_usage.as_ref().is_some_and(|usage| {
      usage["streamId"] == handle.stream_id.to_string()
        && matches!(usage["streamStatus"].as_str(), Some("done" | "failed" | "canceled"))
    }) {
      return Ok(latest);
    }
    Err(AuthError::InvalidInput(
      "copilot generation was edited or superseded".into(),
    ))
  }
}
