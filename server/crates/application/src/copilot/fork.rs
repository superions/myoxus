// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
//! Transactional chat-history copying; transport authorization stays at ingress.

use super::CopilotService;
use crate::auth::{AuthError, AuthResult};
use chrono::Utc;
use myoxus_domain::{
  entities::{CopilotMessageRole, CopilotSession, CopilotSessionFork, CopilotToolCallStatus},
  repositories::{PageRequest, RepositoryError},
};
use serde_json::{Value, json};
use std::collections::HashMap;
use tracing::instrument;
use uuid::Uuid;

/// Trusted ingress identities and current blob-read authority, never client params.
pub struct ForkCopilotSession {
  pub user_id: Uuid,
  pub workspace_id: Uuid,
  pub source_session_id: Uuid,
  pub doc_id: Uuid,
  /// Inclusive cutoff. None copies the entire committed history.
  pub latest_message_id: Option<Uuid>,
  pub can_read_attachments: bool,
}

impl CopilotService {
  /// Copy a committed message prefix with fresh local identities and lineage.
  /// Active generation and a foreign cutoff are errors, never an empty fallback.
  #[instrument(skip_all, fields(source_session_id = %request.source_session_id, workspace_id = %request.workspace_id))]
  pub async fn fork_session(&self, request: ForkCopilotSession) -> AuthResult<CopilotSession> {
    // Keep local stream registration serialized with preflight and commit. The
    // persisted snapshot check also protects against another process's writes.
    let streams = self.active_streams.read().await;
    if streams
      .values()
      .any(|stream| stream.session_id == request.source_session_id)
    {
      return Err(AuthError::InvalidInput(
        "cannot copy a chat during active generation".into(),
      ));
    }
    let source = self.get_session(request.source_session_id).await?;
    if source.user_id != request.user_id
      || source.workspace_id != Some(request.workspace_id)
      || source.deleted_at.is_some()
    {
      return Err(AuthError::ActionForbidden);
    }
    // This private server operation needs the full source, not the public
    // history page's 500-message limit. The repository rechecks it under lock.
    let source_messages = self
      .repo
      .list_copilot_messages(
        source.id,
        PageRequest {
          limit: i64::MAX,
          offset: 0,
        },
      )
      .await
      .map_err(Self::map_repo_err)?;
    if source_messages.iter().any(|message| {
      message
        .token_usage
        .as_ref()
        .and_then(|usage| usage.get("streamStatus"))
        .and_then(Value::as_str)
        == Some("running")
        || message.tool_calls.iter().any(|call| {
          matches!(
            call.status,
            CopilotToolCallStatus::Queued | CopilotToolCallStatus::Running
          )
        })
    }) {
      return Err(AuthError::InvalidInput(
        "cannot copy a chat during active generation".into(),
      ));
    }
    let end = match request.latest_message_id {
      Some(id) => source_messages
        .iter()
        .position(|message| message.id == id)
        .map(|index| index + 1)
        .ok_or_else(|| AuthError::InvalidInput("chat copy cutoff does not belong to the source session".into()))?,
      None => source_messages.len(),
    };
    if !request.can_read_attachments
      && source_messages[..end]
        .iter()
        .any(|message| !message.attachment_refs.is_empty())
    {
      return Err(AuthError::ActionForbidden);
    }
    let mut metadata = match &source.metadata {
      Value::Object(metadata) => metadata.clone(),
      Value::Null => Default::default(),
      _ => {
        return Err(AuthError::InvalidInput(
          "chat session metadata must be an object".into(),
        ));
      }
    };
    metadata.insert("parentSessionId".into(), json!(source.id));
    let now = Utc::now();
    let session = CopilotSession {
      id: Uuid::new_v4(),
      user_id: request.user_id,
      workspace_id: Some(request.workspace_id),
      doc_id: Some(request.doc_id),
      title: source.title.clone(),
      model: source.model.clone(),
      pinned: false,
      archived_at: None,
      deleted_at: None,
      metadata: Value::Object(metadata),
      created_at: now,
      updated_at: now,
    };
    let mut tool_ids = HashMap::<String, Uuid>::new();
    let mut messages = source_messages[..end].to_vec();
    // Preserve original timestamps and arbitrary deployed params. Ordered fresh
    // IDs keep the repository's final tie-breaker stable without rewriting them.
    let mut message_ids = (0..messages.len()).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
    message_ids.sort_unstable();
    let remapped_messages = messages
      .iter()
      .zip(&message_ids)
      .map(|(message, id)| (message.id, *id))
      .collect::<HashMap<_, _>>();
    for (index, message) in messages.iter_mut().enumerate() {
      message.id = message_ids[index];
      message.session_id = session.id;
      if let Some(usage) = message.token_usage.as_mut().and_then(Value::as_object_mut) {
        if let Some(anchor) = usage.get("responseTo") {
          let mapped = anchor
            .as_str()
            .and_then(|value| Uuid::parse_str(value).ok())
            .and_then(|id| remapped_messages.get(&id))
            .ok_or_else(|| AuthError::InvalidInput("chat response anchor is outside the copied history".into()))?;
          usage.insert("responseTo".into(), json!(mapped));
        }
        // Terminal output/status may be copied, live request identity never is.
        for key in [
          "inputRequestId",
          "requestId",
          "requestDeadline",
          "expectedStreamId",
          "streamId",
        ] {
          usage.remove(key);
        }
      }
      for call in &mut message.tool_calls {
        call.id = *tool_ids.entry(call.id.to_string()).or_insert_with(Uuid::new_v4);
        call.message_id = message.id;
      }
      // Rewrite only structural correlation fields, never arbitrary tool args,
      // result payloads, document links or provider/user text.
      if let Some(objects) = message.content.get_mut("streamObjects").and_then(Value::as_array_mut) {
        for object in objects {
          if matches!(
            object.get("type").and_then(Value::as_str),
            Some("tool-call" | "tool-result")
          ) {
            remap_tool_id(object, "toolCallId", &mut tool_ids);
          }
        }
      }
      if message.role == CopilotMessageRole::Tool {
        remap_tool_id(&mut message.content, "toolCallId", &mut tool_ids);
      }
      // Generated files share immutable bytes across copies. Only the owning
      // attachment/message IDs change; original source/render fingerprints stay.
      for attachment in &mut message.attachment_refs {
        attachment.id = Uuid::new_v4();
        attachment.message_id = message.id;
      }
    }
    let fork = CopilotSessionFork {
      source,
      source_messages,
      session,
      messages,
    };
    self
      .repo
      .commit_copilot_session_fork(&fork)
      .await
      .map_err(|error| match error {
        RepositoryError::Conflict(_) => {
          AuthError::InvalidInput("chat changed while copying; retry the operation".into())
        }
        other => Self::map_repo_err(other),
      })
  }
}

fn remap_tool_id(object: &mut Value, key: &str, ids: &mut HashMap<String, Uuid>) {
  if let Some(id) = object.get_mut(key) {
    if let Some(original) = id.as_str() {
      *id = json!(*ids.entry(original.to_owned()).or_insert_with(Uuid::new_v4));
    }
  }
}
