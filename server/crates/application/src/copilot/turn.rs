// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
use super::{ActiveCopilotStream, CopilotService, CopilotStreamHandle};
use crate::auth::{AuthError, AuthResult};
use chrono::Utc;
use myoxus_domain::{
  copilot_turn::{CopilotTurnClaim, CopilotTurnRequest, user_params, valid_request_id},
  entities::{CopilotAttachmentRef, CopilotMessage, CopilotMessageRole},
  repositories::{PageRequest, RepositoryError},
};
use serde_json::{Value, json};
use std::collections::HashSet;
use tracing::instrument;
use uuid::Uuid;

impl CopilotService {
  fn map_turn_error(error: RepositoryError) -> AuthError {
    match error {
      RepositoryError::Conflict(message) => AuthError::InvalidInput(message.into()),
      RepositoryError::NotFound(_) => AuthError::ActionForbidden,
      error => Self::map_repo_err(error),
    }
  }
  #[instrument(skip_all)]
  pub async fn get_message(&self, id: Uuid) -> AuthResult<CopilotMessage> {
    self
      .repo
      .get_copilot_message(id)
      .await
      .map_err(Self::map_repo_err)?
      .ok_or_else(|| AuthError::InvalidInput("copilot message unavailable".into()))
  }
  #[instrument(skip_all)]
  pub async fn submit_user_message(
    &self,
    user_id: Uuid,
    session_id: Uuid,
    content: Value,
    params: Option<Value>,
    mut attachments: Vec<CopilotAttachmentRef>,
    request_id: Option<String>,
  ) -> AuthResult<CopilotMessage> {
    if request_id.as_ref().is_some_and(|id| !valid_request_id(id)) {
      return Err(AuthError::InvalidInput("invalid copilot request id".into()));
    }
    if content.is_null() || (request_id.is_some() && params.as_ref().is_some_and(|v| !v.is_object() && !v.is_null())) {
      return Err(AuthError::InvalidInput("invalid correlated copilot input".into()));
    }
    let id = Uuid::new_v4();
    for attachment in &mut attachments {
      attachment.message_id = id;
    }
    // Uncorrelated deployed ingress also accepted opaque non-object params.
    // They cannot contain reserved keys and must not be silently discarded.
    let mut usage = match params {
      Some(value) if !value.is_object() && !value.is_null() => value,
      params => user_params(params),
    };
    if let Some(request_id) = request_id {
      usage["inputRequestId"] = json!(request_id);
    }
    let message = CopilotMessage {
      id,
      session_id,
      role: CopilotMessageRole::User,
      content,
      token_usage: Some(usage),
      tool_calls: Vec::new(),
      attachment_refs: attachments,
      edited_at: None,
      created_at: Utc::now(),
    };
    self
      .repo
      .submit_copilot_message(user_id, &message)
      .await
      .map_err(Self::map_turn_error)
  }

  /// The database claim is authoritative across processes; the existing local
  /// stream map only buffers output for the one acquiring request.
  #[instrument(skip_all)]
  pub async fn claim_message_stream(
    &self,
    request: &CopilotTurnRequest,
  ) -> AuthResult<(CopilotTurnClaim, Option<CopilotStreamHandle>)> {
    let mut streams = self.active_streams.write().await;
    let claim = self
      .repo
      .claim_copilot_turn(request)
      .await
      .map_err(Self::map_turn_error)?;
    if !claim.acquired {
      return Ok((claim, None));
    }
    streams.retain(|_, stream| stream.message_id != claim.message.id);
    let handle = CopilotStreamHandle {
      stream_id: request.stream_id,
      message_id: claim.message.id,
    };
    streams.insert(
      request.stream_id,
      ActiveCopilotStream {
        stream_id: request.stream_id,
        session_id: request.session_id,
        message_id: claim.message.id,
        message: claim.message.clone(),
        chunk_ids: HashSet::new(),
      },
    );
    Ok((claim, Some(handle)))
  }

  /// Generation needs the actual last turn, never the oldest public history page.
  #[instrument(skip_all)]
  pub async fn generation_messages(&self, session_id: Uuid) -> AuthResult<Vec<CopilotMessage>> {
    self
      .repo
      .list_copilot_messages(
        session_id,
        PageRequest {
          limit: i64::MAX,
          offset: 0,
        },
      )
      .await
      .map_err(Self::map_repo_err)
  }
}
