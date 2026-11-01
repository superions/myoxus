//! Copilot (AI assistant) service: sessions, messages, contexts, streaming,
//! and workspace-level embedding state.
//!
//! [`CopilotService`] manages the full lifecycle of AI chat sessions,
//! including streaming response assembly, message editing with revision
//! history, attachment ingestion, and retrieval-augmented-generation (RAG)
//! context building.  [`InMemoryCopilotRepository`] provides a test-only
//! in-memory backend.

pub mod context_ingest;
pub mod context_prompt;
pub mod embedding;
pub mod files;
mod fork;
mod streaming;
mod turn;
pub use streaming::{CopilotStreamGuard, CopilotStreamOutcome};
pub mod prompt;
pub mod provider;
pub use fork::ForkCopilotSession;

use base64::Engine;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;
use tracing::{debug, error, info, instrument, trace, warn};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};
use myoxus_domain::entities::{
  CopilotAttachmentRef, CopilotContext, CopilotContextItem, CopilotContextItemType, CopilotJob, CopilotJobState,
  CopilotMessage, CopilotMessageRole, CopilotSession, CopilotSessionAccessScope, CopilotSessionFilter,
  CopilotSessionFork, CopilotSessionPage, CopilotToolCall, CopilotWorkspaceState,
};
use myoxus_domain::repositories::{CopilotRepository, PageRequest, RepoResult, RepositoryError};

/// High-level service for the AI copilot feature.
///
/// Wraps a [`CopilotRepository`] and provides business-logic operations such
/// as session management, streaming response assembly with idempotent chunk
/// de-duplication, message editing with revision history, and
/// retrieval-context building for RAG workflows.
#[derive(Clone)]
pub struct CopilotService {
  /// Persistence repository for all copilot data.
  repo: Arc<dyn CopilotRepository>,
  /// In-process map of currently active streaming assistant responses.
  active_streams: Arc<RwLock<HashMap<Uuid, ActiveCopilotStream>>>,
}

/// A lightweight handle returned when a streaming assistant message is
/// started.
#[derive(Debug, Clone)]
pub struct CopilotStreamHandle {
  /// Opaque ID used to route subsequent chunk appends and finalization calls.
  pub stream_id: Uuid,
  /// ID of the underlying assistant [`CopilotMessage`] being streamed into.
  pub message_id: Uuid,
}

/// A point-in-time snapshot of an active copilot stream.
#[derive(Debug, Clone)]
pub struct CopilotStreamSnapshot {
  /// Identifies this stream.
  pub stream_id: Uuid,
  /// ID of the message being assembled.
  pub message_id: Uuid,
  /// Session containing this stream.
  pub session_id: Uuid,
  /// Accumulated text of all chunks received so far.
  pub text: String,
}

#[derive(Debug, Clone)]
struct ActiveCopilotStream {
  stream_id: Uuid,
  session_id: Uuid,
  message_id: Uuid,
  message: CopilotMessage,
  chunk_ids: HashSet<String>,
}

fn parse_attachment_text_with_fallback(
  mime_type: Option<&str>,
  payload: &[u8],
) -> (Option<String>, String, Option<String>) {
  let mime = mime_type.unwrap_or("application/octet-stream").to_ascii_lowercase();
  if mime.starts_with("text/") {
    match std::str::from_utf8(payload) {
      Ok(text) => return (Some(text.to_string()), "utf8-text".to_string(), None),
      Err(err) => {
        return (
          None,
          "utf8-text".to_string(),
          Some(format!("utf8 decode failed: {err}")),
        );
      }
    }
  }
  if mime == "application/json" {
    match serde_json::from_slice::<Value>(payload) {
      Ok(value) => return (Some(value.to_string()), "json".to_string(), None),
      Err(err) => return (None, "json".to_string(), Some(format!("json decode failed: {err}"))),
    }
  }
  let preview_len = payload.len().min(64);
  let preview = base64::engine::general_purpose::STANDARD.encode(&payload[..preview_len]);
  (
    Some(preview),
    "base64-preview-fallback".to_string(),
    Some("unsupported mime type for structured parser".to_string()),
  )
}

impl CopilotService {
  /// Construct a `CopilotService` backed by the given repository.
  pub fn new(repo: Arc<dyn CopilotRepository>) -> Self {
    Self {
      repo,
      active_streams: Arc::new(RwLock::new(HashMap::new())),
    }
  }

  fn map_repo_err(err: RepositoryError) -> AuthError {
    AuthError::Storage(err.to_string())
  }

  /// Create a new copilot chat session for a user.
  ///
  /// Trims and normalises `title` and `model`, rejecting empty values.
  #[instrument(skip(self, metadata))]
  pub async fn create_session(
    &self,
    user_id: Uuid,
    workspace_id: Option<Uuid>,
    doc_id: Option<Uuid>,
    title: Option<String>,
    model: Option<String>,
    metadata: Value,
  ) -> AuthResult<CopilotSession> {
    let now = Utc::now();
    let normalized_title = title.and_then(|value| {
      let trimmed = value.trim().to_string();
      if trimmed.is_empty() { None } else { Some(trimmed) }
    });
    let normalized_model = model.and_then(|value| {
      let trimmed = value.trim().to_string();
      if trimmed.is_empty() { None } else { Some(trimmed) }
    });
    trace!(%user_id, ?workspace_id, ?doc_id, "creating copilot session");
    let session = CopilotSession {
      id: Uuid::new_v4(),
      user_id,
      workspace_id,
      doc_id,
      title: normalized_title,
      model: normalized_model,
      pinned: false,
      archived_at: None,
      deleted_at: None,
      metadata,
      created_at: now,
      updated_at: now,
    };
    let created = self
      .repo
      .create_copilot_session(&session)
      .await
      .map_err(Self::map_repo_err)?;
    info!(session_id = %created.id, %user_id, "created copilot session");
    Ok(created)
  }

  /// Bound the page, never the population to which history filters apply.
  #[instrument(skip(self))]
  pub async fn list_sessions(
    &self,
    user_id: Uuid,
    filter: &CopilotSessionFilter,
    limit: i64,
    offset: i64,
  ) -> AuthResult<CopilotSessionPage> {
    let page = PageRequest {
      limit: limit.clamp(1, 200),
      offset: offset.max(0),
    };
    let sessions = self
      .repo
      .list_copilot_sessions(user_id, filter, page)
      .await
      .map_err(Self::map_repo_err)?;
    debug!(%user_id, count = sessions.sessions.len(), "listed copilot sessions");
    Ok(sessions)
  }

  /// Archive a session (hidden from default listings but not deleted).
  #[instrument(skip(self))]
  pub async fn archive_session(&self, session_id: Uuid) -> AuthResult<()> {
    self
      .repo
      .archive_copilot_session(session_id, Utc::now())
      .await
      .map_err(Self::map_repo_err)?;
    info!(%session_id, "archived copilot session");
    Ok(())
  }

  /// Soft-delete a session.
  #[instrument(skip(self))]
  pub async fn delete_session(&self, session_id: Uuid) -> AuthResult<()> {
    self
      .repo
      .delete_copilot_session(session_id, Utc::now())
      .await
      .map_err(Self::map_repo_err)?;
    warn!(%session_id, "soft-deleted copilot session");
    Ok(())
  }

  /// Fetch a session by ID, returning an error if not found.
  #[instrument(skip(self))]
  pub async fn get_session(&self, session_id: Uuid) -> AuthResult<CopilotSession> {
    let Some(session) = self
      .repo
      .get_copilot_session(session_id)
      .await
      .map_err(Self::map_repo_err)?
    else {
      return Err(AuthError::InvalidInput("copilot session not found".to_string()));
    };
    Ok(session)
  }

  /// Update mutable fields on a session.
  ///
  /// `metadata_updates` is merged (shallow) into the existing metadata when
  /// both are JSON objects; otherwise it replaces the metadata entirely.
  #[instrument(skip(self, title, metadata_updates))]
  pub async fn update_session(
    &self,
    session_id: Uuid,
    title: Option<String>,
    pinned: Option<bool>,
    doc_id: Option<Option<Uuid>>,
    model: Option<String>,
    metadata_updates: Option<Value>,
  ) -> AuthResult<CopilotSession> {
    let mut session = self.get_session(session_id).await?;

    if let Some(title) = title {
      let normalized = title.trim().to_string();
      session.title = if normalized.is_empty() { None } else { Some(normalized) };
    }
    if let Some(pinned) = pinned {
      session.pinned = pinned;
    }
    if let Some(doc_id) = doc_id {
      session.doc_id = doc_id;
    }
    if let Some(model) = model {
      let normalized = model.trim().to_string();
      session.model = if normalized.is_empty() { None } else { Some(normalized) };
    }
    if let Some(patch) = metadata_updates {
      match (&mut session.metadata, patch) {
        (Value::Object(base), Value::Object(patch)) => {
          for (k, v) in patch {
            base.insert(k, v);
          }
        }
        (_, replacement) => session.metadata = replacement,
      }
    }

    session.updated_at = Utc::now();
    let updated = self
      .repo
      .update_copilot_session(&session)
      .await
      .map_err(Self::map_repo_err)?;
    info!(session_id = %updated.id, "updated copilot session");
    Ok(updated)
  }

  /// Append a new message to a copilot session.
  ///
  /// Injects a `sequence` counter into `token_usage` for ordering.  Rejects
  /// null content or messages on a non-existent session.
  #[instrument(skip(self, content, token_usage, tool_calls, attachment_refs))]
  pub async fn append_message(
    &self,
    session_id: Uuid,
    role: CopilotMessageRole,
    content: Value,
    token_usage: Option<Value>,
    tool_calls: Vec<CopilotToolCall>,
    attachment_refs: Vec<CopilotAttachmentRef>,
  ) -> AuthResult<CopilotMessage> {
    if content.is_null() {
      warn!(%session_id, "refusing copilot message with null content");
      return Err(AuthError::InvalidInput(
        "copilot message content must not be null".to_string(),
      ));
    }
    if self
      .repo
      .get_copilot_session(session_id)
      .await
      .map_err(Self::map_repo_err)?
      .is_none()
    {
      error!(%session_id, "append_message on unknown copilot session");
      return Err(AuthError::InvalidInput("copilot session not found".to_string()));
    }

    let message_id = Uuid::new_v4();
    let existing_messages = self
      .repo
      .list_copilot_messages(
        session_id,
        PageRequest {
          limit: 10_000,
          offset: 0,
        },
      )
      .await
      .map_err(Self::map_repo_err)?;
    let sequence = existing_messages.len() as i64 + 1;
    let token_usage = match token_usage {
      Some(Value::Object(mut usage)) => {
        usage.insert("sequence".to_string(), Value::from(sequence));
        Some(Value::Object(usage))
      }
      Some(other) => Some(other),
      None => Some(serde_json::json!({ "sequence": sequence })),
    };
    let attachment_refs = attachment_refs
      .into_iter()
      .map(|mut attachment| {
        attachment.message_id = message_id;
        attachment
      })
      .collect::<Vec<_>>();
    let message = CopilotMessage {
      id: message_id,
      session_id,
      role,
      content,
      token_usage,
      tool_calls,
      attachment_refs,
      edited_at: None,
      created_at: Utc::now(),
    };
    let saved = self
      .repo
      .append_copilot_message(&message)
      .await
      .map_err(Self::map_repo_err)?;
    info!(session_id = %saved.session_id, message_id = %saved.id, "appended copilot message");
    Ok(saved)
  }

  /// List messages in a session, paginated (max 500 per page).
  #[instrument(skip(self))]
  pub async fn list_messages(&self, session_id: Uuid, limit: i64, offset: i64) -> AuthResult<Vec<CopilotMessage>> {
    let page = PageRequest {
      limit: limit.clamp(1, 500),
      offset: offset.max(0),
    };
    let messages = self
      .repo
      .list_copilot_messages(session_id, page)
      .await
      .map_err(Self::map_repo_err)?;
    debug!(%session_id, count = messages.len(), "listed copilot messages");
    Ok(messages)
  }

  /// Edit an existing message, preserving the old version as a revision.
  ///
  /// The previous message content is appended to the revision log before the
  /// message is updated.
  #[instrument(skip(self, content))]
  pub async fn edit_message(&self, message_id: Uuid, content: Value) -> AuthResult<CopilotMessage> {
    if content.is_null() {
      return Err(AuthError::InvalidInput(
        "copilot message content must not be null".to_string(),
      ));
    }
    let Some(current) = self
      .repo
      .get_copilot_message(message_id)
      .await
      .map_err(Self::map_repo_err)?
    else {
      return Err(AuthError::InvalidInput("copilot message not found".to_string()));
    };
    self
      .repo
      .append_copilot_message_revision(message_id, &current)
      .await
      .map_err(Self::map_repo_err)?;
    let mut updated = current;
    updated.content = content;
    updated.edited_at = Some(Utc::now());
    // A deliberate edit takes ownership from active generation. Keep its
    // history, but do not leave a permanently running marker after rejecting
    // the stale stream's next write.
    if let Some(usage) = updated.token_usage.as_mut()
      && usage["streamStatus"] == "running"
      && usage.get("streamId").is_some()
    {
      usage["streamStatus"] = serde_json::json!("canceled");
    }
    let updated = self
      .repo
      .update_copilot_message(&updated)
      .await
      .map_err(Self::map_repo_err)?;
    info!(message_id = %updated.id, "edited copilot message");
    Ok(updated)
  }

  /// Return the revision history for a message (previous body versions),
  /// paginated.
  #[instrument(skip(self))]
  pub async fn list_message_revisions(
    &self,
    message_id: Uuid,
    limit: i64,
    offset: i64,
  ) -> AuthResult<Vec<CopilotMessage>> {
    self
      .repo
      .list_copilot_message_revisions(
        message_id,
        PageRequest {
          limit: limit.clamp(1, 500),
          offset: offset.max(0),
        },
      )
      .await
      .map_err(Self::map_repo_err)
  }

  /// Ingest a binary attachment payload for a message.
  ///
  /// Parses text from the payload based on MIME type (plain text, JSON, or
  /// base64 preview fallback) and stores the result together with metadata.
  #[instrument(skip(self, payload))]
  pub async fn ingest_attachment_for_message(
    &self,
    message_id: Uuid,
    blob_key: String,
    file_name: Option<String>,
    mime_type: Option<String>,
    payload: Vec<u8>,
  ) -> AuthResult<CopilotAttachmentRef> {
    let Some(_message) = self
      .repo
      .get_copilot_message(message_id)
      .await
      .map_err(Self::map_repo_err)?
    else {
      return Err(AuthError::InvalidInput("copilot message not found".to_string()));
    };
    let (parsed_text, parser, parser_error) = parse_attachment_text_with_fallback(mime_type.as_deref(), &payload);
    let metadata = serde_json::json!({
        "ingestionStatus": "parsed",
        "parser": parser,
        "parserError": parser_error,
        "textPreview": parsed_text.as_deref().map(|text| text.chars().take(256).collect::<String>()),
        "byteSize": payload.len(),
    });
    let attachment = CopilotAttachmentRef {
      id: Uuid::new_v4(),
      message_id,
      blob_key: blob_key.trim().to_string(),
      file_name,
      mime_type,
      size_bytes: Some(payload.len() as i64),
      metadata,
      created_at: Utc::now(),
    };
    let saved = self
      .repo
      .append_copilot_attachment_ref(&attachment)
      .await
      .map_err(Self::map_repo_err)?;
    info!(message_id = %saved.message_id, attachment_id = %saved.id, "ingested copilot attachment");
    Ok(saved)
  }

  /// Begin a streaming assistant response for a session.
  ///
  /// Creates an empty assistant message and registers an in-process
  /// `ActiveCopilotStream` to accumulate answer and ordered objects. Returns a
  /// [`CopilotStreamHandle`] identifying the stream.
  #[instrument(skip(self))]
  pub async fn start_message_stream(&self, session_id: Uuid) -> AuthResult<CopilotStreamHandle> {
    let stream_id = Uuid::new_v4();
    let mut streams = self.active_streams.write().await;
    let message = self
      .append_message(
        session_id,
        CopilotMessageRole::Assistant,
        serde_json::json!({ "text": "", "streamObjects": [] }),
        Some(serde_json::json!({ "streamStatus": "running", "streamId": stream_id })),
        Vec::new(),
        Vec::new(),
      )
      .await?;
    let stream = ActiveCopilotStream {
      stream_id,
      session_id,
      message_id: message.id,
      message,
      chunk_ids: HashSet::new(),
    };
    streams.insert(stream.stream_id, stream.clone());
    info!(stream_id = %stream.stream_id, message_id = %stream.message_id, "started copilot stream");
    Ok(CopilotStreamHandle {
      stream_id: stream.stream_id,
      message_id: stream.message_id,
    })
  }

  /// Append a text delta to an active stream without a chunk ID (no
  /// idempotency check).
  #[instrument(skip(self, text_delta))]
  pub async fn append_stream_chunk(&self, stream_id: Uuid, text_delta: String) -> AuthResult<CopilotMessage> {
    self.append_stream_chunk_with_id(stream_id, None, text_delta).await
  }

  /// Append a text delta with an optional idempotency `chunk_id`.
  ///
  /// If `chunk_id` was already seen for this stream, the current message is
  /// returned without modification (idempotent re-delivery).
  #[instrument(skip(self, chunk_id, text_delta))]
  pub async fn append_stream_chunk_with_id(
    &self,
    stream_id: Uuid,
    chunk_id: Option<String>,
    text_delta: String,
  ) -> AuthResult<CopilotMessage> {
    self
      .append_stream_output(stream_id, chunk_id, "text-delta", text_delta)
      .await
  }

  /// Persist a terminal outcome and release its buffer. The handle permits
  /// idempotent readback after removal; an older generation cannot overwrite it.
  #[instrument(skip(self))]
  pub async fn finalize_stream(
    &self,
    handle: &CopilotStreamHandle,
    outcome: CopilotStreamOutcome,
  ) -> AuthResult<CopilotMessage> {
    let mut streams = self.active_streams.write().await;
    if streams
      .get(&handle.stream_id)
      .is_some_and(|stream| stream.message_id != handle.message_id)
    {
      return Err(AuthError::InvalidInput("copilot stream handle mismatch".into()));
    }
    // Remove before awaiting storage: failures must not retain large buffers.
    let active = streams.remove(&handle.stream_id);
    let message = active.map(|stream| stream.message);
    self.persist_stream_outcome(handle, outcome, message).await
  }

  /// Return the current in-memory snapshot of a stream, or `None` if the
  /// stream ID is unknown.
  #[instrument(skip(self))]
  pub async fn stream_snapshot(&self, stream_id: Uuid) -> AuthResult<Option<CopilotStreamSnapshot>> {
    let guard = self.active_streams.read().await;
    let Some(stream) = guard.get(&stream_id) else {
      return Ok(None);
    };
    Ok(Some(CopilotStreamSnapshot {
      stream_id: stream.stream_id,
      message_id: stream.message_id,
      session_id: stream.session_id,
      text: stream.message.content["text"].as_str().unwrap_or_default().to_string(),
    }))
  }

  /// Create a named copilot context (a named collection of context items for
  /// RAG retrieval).
  #[instrument(skip(self, metadata))]
  pub async fn create_context(
    &self,
    user_id: Uuid,
    workspace_id: Option<Uuid>,
    name: String,
    metadata: Value,
  ) -> AuthResult<CopilotContext> {
    let normalized_name = name.trim().to_string();
    if normalized_name.is_empty() {
      return Err(AuthError::InvalidInput(
        "copilot context name must not be empty".to_string(),
      ));
    }
    let context = CopilotContext {
      id: Uuid::new_v4(),
      user_id,
      workspace_id,
      name: normalized_name,
      metadata,
      created_at: Utc::now(),
    };
    let saved = self
      .repo
      .create_copilot_context(&context)
      .await
      .map_err(Self::map_repo_err)?;
    info!(context_id = %saved.id, %user_id, "created copilot context");
    Ok(saved)
  }

  /// Retrieve one context. Authorization remains the caller's responsibility
  /// because contexts are consumed by both user-scoped and system workflows.
  pub async fn get_context(&self, context_id: Uuid) -> AuthResult<Option<CopilotContext>> {
    self
      .repo
      .get_copilot_context(context_id)
      .await
      .map_err(Self::map_repo_err)
  }

  /// Find the exact named context used to make session-context creation
  /// idempotent without exposing persistence details to the transport.
  pub async fn find_context(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    name: &str,
  ) -> AuthResult<Option<CopilotContext>> {
    self
      .repo
      .find_copilot_context(user_id, workspace_id, name)
      .await
      .map_err(Self::map_repo_err)
  }

  /// Add an item (e.g. a doc reference) to an existing context.
  #[instrument(skip(self, metadata))]
  pub async fn add_context_item(
    &self,
    context_id: Uuid,
    item_type: CopilotContextItemType,
    item_ref: String,
    metadata: Value,
  ) -> AuthResult<CopilotContextItem> {
    let item_ref = item_ref.trim().to_string();
    if item_ref.is_empty() {
      return Err(AuthError::InvalidInput(
        "copilot context item_ref must not be empty".to_string(),
      ));
    }
    let item = CopilotContextItem {
      id: Uuid::new_v4(),
      context_id,
      item_type,
      item_ref,
      metadata,
      created_at: Utc::now(),
    };
    self
      .repo
      .append_copilot_context_item(&item)
      .await
      .map_err(Self::map_repo_err)
  }

  /// Remove a specific item from a context by type and ref.  Returns `true` if
  /// the item was found and removed.
  #[instrument(skip(self))]
  pub async fn remove_context_item(
    &self,
    context_id: Uuid,
    item_type: CopilotContextItemType,
    item_ref: &str,
  ) -> AuthResult<bool> {
    self
      .repo
      .remove_copilot_context_item(context_id, item_type, item_ref)
      .await
      .map_err(Self::map_repo_err)
  }

  /// List the items in one context in stable creation order.
  pub async fn list_context_items(&self, context_id: Uuid) -> AuthResult<Vec<CopilotContextItem>> {
    self
      .repo
      .list_copilot_context_items(context_id, PageRequest { limit: 1000, offset: 0 })
      .await
      .map_err(Self::map_repo_err)
  }

  /// List contexts for a user, optionally scoped to a workspace, paginated.
  #[instrument(skip(self))]
  pub async fn list_contexts(
    &self,
    user_id: Uuid,
    workspace_id: Option<Uuid>,
    limit: i64,
    offset: i64,
  ) -> AuthResult<Vec<CopilotContext>> {
    self
      .repo
      .list_copilot_contexts(
        user_id,
        workspace_id,
        PageRequest {
          limit: limit.clamp(1, 200),
          offset: offset.max(0),
        },
      )
      .await
      .map_err(Self::map_repo_err)
  }

  /// Build a retrieval context JSON payload for RAG.
  ///
  /// Iterates over all of the user's context items in the workspace, scores
  /// them by query relevance, applies workspace-level doc ignore list, and
  /// returns the top-`max_items` as a structured JSON object.
  #[instrument(skip(self, query))]
  pub async fn build_retrieval_context(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    doc_id: Option<Uuid>,
    query: String,
    max_items: usize,
  ) -> AuthResult<Value> {
    let query_lc = query.to_lowercase();
    let contexts = self
      .repo
      .list_copilot_contexts(user_id, Some(workspace_id), PageRequest { limit: 200, offset: 0 })
      .await
      .map_err(Self::map_repo_err)?;
    let workspace_state = self
      .repo
      .get_copilot_workspace_state(workspace_id)
      .await
      .map_err(Self::map_repo_err)?;
    let ignored_docs = workspace_state
      .as_ref()
      .map(|state| state.ignored_doc_ids.clone())
      .unwrap_or_default();

    let mut ranked = Vec::new();
    for context in contexts {
      let items = self
        .repo
        .list_copilot_context_items(context.id, PageRequest { limit: 500, offset: 0 })
        .await
        .map_err(Self::map_repo_err)?;
      for item in items {
        if item.item_type == CopilotContextItemType::Doc
          && let Ok(doc_uuid) = Uuid::parse_str(&item.item_ref)
        {
          if ignored_docs.contains(&doc_uuid) {
            continue;
          }
          if let Some(target_doc_id) = doc_id
            && doc_uuid != target_doc_id
          {
            continue;
          }
        }
        let mut score = 0i32;
        let item_ref_lc = item.item_ref.to_lowercase();
        if query_lc.is_empty() || item_ref_lc.contains(&query_lc) {
          score += 10;
        }
        if let Some(name) = context.metadata.get("name").and_then(|value| value.as_str())
          && name.to_lowercase().contains(&query_lc)
        {
          score += 3;
        }
        ranked.push((score, context.id, item));
      }
    }

    ranked.sort_by(|left, right| {
      right
        .0
        .cmp(&left.0)
        .then_with(|| left.2.item_ref.cmp(&right.2.item_ref))
        .then_with(|| left.1.cmp(&right.1))
    });
    let items = ranked
      .into_iter()
      .take(max_items)
      .map(|(score, context_id, item)| {
        serde_json::json!({
            "contextId": context_id,
            "type": format!("{:?}", item.item_type).to_lowercase(),
            "itemRef": item.item_ref,
            "score": score,
            "metadata": item.metadata,
        })
      })
      .collect::<Vec<_>>();

    Ok(serde_json::json!({
        "workspaceId": workspace_id,
        "docId": doc_id,
        "query": query,
        "ignoredDocIds": ignored_docs,
        "items": items,
    }))
  }

  /// Apply a size window to a retrieval payload.
  ///
  /// Sorts items by score, then applies `max_items` and `max_chars` budgets,
  /// annotating the result with a `"window"` summary object.
  #[instrument(skip(self, retrieval_payload))]
  pub async fn apply_retrieval_window(
    &self,
    retrieval_payload: Value,
    max_items: usize,
    max_chars: usize,
  ) -> AuthResult<Value> {
    let mut root = retrieval_payload;
    let Some(items) = root.get_mut("items").and_then(|value| value.as_array_mut()) else {
      return Ok(root);
    };
    let (char_budget, kept_count) = {
      items.sort_by(|left, right| {
        let left_score = left.get("score").and_then(|value| value.as_i64()).unwrap_or(0);
        let right_score = right.get("score").and_then(|value| value.as_i64()).unwrap_or(0);
        let left_ref = left.get("itemRef").and_then(|value| value.as_str()).unwrap_or_default();
        let right_ref = right
          .get("itemRef")
          .and_then(|value| value.as_str())
          .unwrap_or_default();
        right_score.cmp(&left_score).then_with(|| left_ref.cmp(right_ref))
      });

      let mut kept = Vec::new();
      let mut char_budget = 0usize;
      for item in items.iter() {
        if kept.len() >= max_items {
          break;
        }
        let item_ref_len = item
          .get("itemRef")
          .and_then(|value| value.as_str())
          .map(|value| value.chars().count())
          .unwrap_or(0);
        let preview_len = item
          .get("metadata")
          .and_then(|value| value.get("textPreview"))
          .and_then(|value| value.as_str())
          .map(|value| value.chars().count())
          .unwrap_or(0);
        let item_cost = item_ref_len + preview_len;
        if max_chars > 0 && char_budget + item_cost > max_chars && !kept.is_empty() {
          break;
        }
        char_budget += item_cost;
        kept.push(item.clone());
      }

      *items = kept;
      (char_budget, items.len())
    };
    if let Some(obj) = root.as_object_mut() {
      obj.insert(
        "window".to_string(),
        serde_json::json!({
            "maxItems": max_items,
            "maxChars": max_chars,
            "usedChars": char_budget,
            "keptItems": kept_count,
        }),
      );
    }
    Ok(root)
  }

  /// Filter a retrieval payload to only include docs the caller is authorised
  /// to access, and redact well-known secret patterns from text previews.
  #[instrument(skip(self, retrieval_payload, allowed_doc_ids))]
  pub async fn enforce_retrieval_security(
    &self,
    retrieval_payload: Value,
    allowed_doc_ids: &[Uuid],
  ) -> AuthResult<Value> {
    let mut root = retrieval_payload;
    let Some(items) = root.get_mut("items").and_then(|value| value.as_array_mut()) else {
      return Ok(root);
    };
    let allowed: HashSet<String> = allowed_doc_ids.iter().map(|id| id.to_string()).collect();
    let kept_items = {
      let mut filtered = Vec::new();
      for mut item in items.clone() {
        let item_type = item.get("type").and_then(|value| value.as_str()).unwrap_or_default();
        let item_ref = item
          .get("itemRef")
          .and_then(|value| value.as_str())
          .unwrap_or_default()
          .to_string();
        if item_type == "doc" && !allowed.is_empty() && !allowed.contains(&item_ref) {
          continue;
        }
        if let Some(preview) = item
          .get("metadata")
          .and_then(|value| value.get("textPreview"))
          .and_then(|value| value.as_str())
        {
          let redacted = preview
            .replace("sk-", "[REDACTED_KEY]")
            .replace("password=", "password=[REDACTED]");
          if let Some(metadata) = item.get_mut("metadata").and_then(|value| value.as_object_mut()) {
            metadata.insert("textPreview".to_string(), Value::from(redacted));
          }
        }
        filtered.push(item);
      }
      *items = filtered;
      items.len()
    };
    if let Some(obj) = root.as_object_mut() {
      obj.insert(
        "security".to_string(),
        serde_json::json!({
            "allowedDocCount": allowed.len(),
            "keptItems": kept_items,
        }),
      );
    }
    Ok(root)
  }

  /// Update the embedding model version for a workspace.
  ///
  /// Returns the saved [`CopilotWorkspaceState`] together with a boolean
  /// indicating whether the model or revision changed (i.e. a re-index is
  /// needed).
  #[instrument(skip(self))]
  pub async fn upsert_embedding_version(
    &self,
    workspace_id: Uuid,
    model_id: String,
    revision: String,
  ) -> AuthResult<(CopilotWorkspaceState, bool)> {
    let normalized_model = model_id.trim().to_string();
    let normalized_revision = revision.trim().to_string();
    if normalized_model.is_empty() || normalized_revision.is_empty() {
      return Err(AuthError::InvalidInput(
        "embedding model_id/revision must not be empty".to_string(),
      ));
    }

    let now = Utc::now();
    let current = self
      .repo
      .get_copilot_workspace_state(workspace_id)
      .await
      .map_err(Self::map_repo_err)?;
    let (ignored_doc_ids, mut metadata) = match current {
      Some(state) => (state.ignored_doc_ids, state.metadata),
      None => (Vec::new(), serde_json::json!({})),
    };

    let previous_model = metadata
      .get("embedding")
      .and_then(|value| value.get("modelId"))
      .and_then(|value| value.as_str())
      .map(ToString::to_string);
    let previous_revision = metadata
      .get("embedding")
      .and_then(|value| value.get("revision"))
      .and_then(|value| value.as_str())
      .map(ToString::to_string);
    let needs_reindex = previous_model.as_deref() != Some(normalized_model.as_str())
      || previous_revision.as_deref() != Some(normalized_revision.as_str());

    let embedding_meta = serde_json::json!({
        "modelId": normalized_model,
        "revision": normalized_revision,
        "lastChangedAt": now,
        "needsReindex": needs_reindex,
        "previousModelId": previous_model,
        "previousRevision": previous_revision,
    });
    match &mut metadata {
      Value::Object(root) => {
        root.insert("embedding".to_string(), embedding_meta);
      }
      _ => metadata = serde_json::json!({ "embedding": embedding_meta }),
    }

    let state = CopilotWorkspaceState {
      workspace_id,
      last_embedding_at: if needs_reindex { None } else { Some(now) },
      ignored_doc_ids,
      metadata,
      updated_at: now,
    };
    let saved = self
      .repo
      .upsert_copilot_workspace_state(&state)
      .await
      .map_err(Self::map_repo_err)?;
    Ok((saved, needs_reindex))
  }

  /// Queue an `embedding_reindex` copilot job if the workspace state
  /// indicates a re-index is needed.  Returns `None` if the index is
  /// already current.
  #[instrument(skip(self))]
  pub async fn queue_reindex_for_embedding_if_needed(
    &self,
    workspace_id: Uuid,
    user_id: Option<Uuid>,
  ) -> AuthResult<Option<CopilotJob>> {
    let Some(state) = self
      .repo
      .get_copilot_workspace_state(workspace_id)
      .await
      .map_err(Self::map_repo_err)?
    else {
      return Ok(None);
    };
    let needs_reindex = state
      .metadata
      .get("embedding")
      .and_then(|value| value.get("needsReindex"))
      .and_then(|value| value.as_bool())
      .unwrap_or(false);
    if !needs_reindex {
      return Ok(None);
    }
    let job = self
      .create_job(
        "embedding_reindex".to_string(),
        Some(workspace_id),
        user_id,
        serde_json::json!({
            "workspaceId": workspace_id,
            "modelId": state.metadata.get("embedding").and_then(|v| v.get("modelId")),
            "revision": state.metadata.get("embedding").and_then(|v| v.get("revision"))
        }),
      )
      .await?;
    Ok(Some(job))
  }

  /// Upsert the workspace-level copilot state (ignored doc IDs + metadata).
  #[instrument(skip(self))]
  pub async fn upsert_workspace_state(
    &self,
    workspace_id: Uuid,
    ignored_doc_ids: Vec<Uuid>,
    metadata: Value,
  ) -> AuthResult<CopilotWorkspaceState> {
    let previous = self
      .repo
      .get_copilot_workspace_state(workspace_id)
      .await
      .map_err(Self::map_repo_err)?;
    let state = CopilotWorkspaceState {
      workspace_id,
      last_embedding_at: previous.and_then(|state| state.last_embedding_at),
      ignored_doc_ids,
      metadata,
      updated_at: Utc::now(),
    };
    let saved = self
      .repo
      .upsert_copilot_workspace_state(&state)
      .await
      .map_err(Self::map_repo_err)?;
    info!(workspace_id = %saved.workspace_id, "upserted copilot workspace state");
    Ok(saved)
  }

  /// Read the workspace-level Copilot configuration through its owner.
  pub async fn get_workspace_state(&self, workspace_id: Uuid) -> AuthResult<Option<CopilotWorkspaceState>> {
    self
      .repo
      .get_copilot_workspace_state(workspace_id)
      .await
      .map_err(Self::map_repo_err)
  }

  /// Create a copilot background job (e.g. `"embedding_reindex"`).
  #[instrument(skip(self, payload))]
  pub async fn create_job(
    &self,
    job_type: String,
    workspace_id: Option<Uuid>,
    user_id: Option<Uuid>,
    payload: Value,
  ) -> AuthResult<CopilotJob> {
    let normalized_job_type = job_type.trim().to_string();
    if normalized_job_type.is_empty() {
      return Err(AuthError::InvalidInput(
        "copilot job_type must not be empty".to_string(),
      ));
    }
    let job = CopilotJob {
      id: Uuid::new_v4(),
      job_type: normalized_job_type,
      state: CopilotJobState::Pending,
      workspace_id,
      user_id,
      payload,
      error_message: None,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    };
    let saved = self.repo.create_copilot_job(&job).await.map_err(Self::map_repo_err)?;
    info!(job_id = %saved.id, job_type = %saved.job_type, "created copilot job");
    Ok(saved)
  }

  /// Retrieve one job so transport adapters can apply their exact ownership
  /// and job-type contract without querying persistence directly.
  pub async fn get_job(&self, job_id: Uuid) -> AuthResult<Option<CopilotJob>> {
    self.repo.get_copilot_job(job_id).await.map_err(Self::map_repo_err)
  }

  /// Persist execution results in the existing job payload before completion.
  pub async fn update_job_payload(&self, job_id: Uuid, payload: serde_json::Value) -> AuthResult<CopilotJob> {
    self
      .repo
      .update_copilot_job_payload(job_id, payload)
      .await
      .map_err(Self::map_repo_err)
  }

  /// Transition one job through the repository's typed state contract.
  pub async fn update_job_state(
    &self,
    job_id: Uuid,
    state: CopilotJobState,
    error_message: Option<String>,
  ) -> AuthResult<CopilotJob> {
    self
      .repo
      .update_copilot_job_state(job_id, state, error_message, Utc::now())
      .await
      .map_err(Self::map_repo_err)
  }

  /// List jobs through the canonical bounded repository query.
  pub async fn list_jobs(
    &self,
    workspace_id: Option<Uuid>,
    user_id: Option<Uuid>,
    state: Option<CopilotJobState>,
    limit: i64,
    offset: i64,
  ) -> AuthResult<Vec<CopilotJob>> {
    self
      .repo
      .list_copilot_jobs(
        workspace_id,
        user_id,
        state,
        PageRequest {
          limit: limit.clamp(1, 200),
          offset: offset.max(0),
        },
      )
      .await
      .map_err(Self::map_repo_err)
  }

  /// Count active sessions for the operational dashboard projection.
  pub async fn count_active_sessions(&self) -> AuthResult<i64> {
    self
      .repo
      .count_active_copilot_sessions()
      .await
      .map_err(Self::map_repo_err)
  }

  pub async fn purge_deleted_sessions_before(&self, cutoff: DateTime<Utc>) -> AuthResult<u64> {
    self
      .repo
      .purge_deleted_copilot_sessions_before(cutoff)
      .await
      .map_err(Self::map_repo_err)
  }

  pub async fn clear_session_document(&self, doc_id: Uuid) -> AuthResult<u64> {
    self
      .repo
      .clear_copilot_session_document(doc_id)
      .await
      .map_err(Self::map_repo_err)
  }

  pub async fn purge_empty_sessions_before(&self, cutoff: DateTime<Utc>) -> AuthResult<u64> {
    self
      .repo
      .purge_empty_copilot_sessions_before(cutoff)
      .await
      .map_err(Self::map_repo_err)
  }

  pub async fn list_untitled_session_ids(&self, limit: i64) -> AuthResult<Vec<Uuid>> {
    self
      .repo
      .list_untitled_copilot_session_ids(limit.clamp(1, 500))
      .await
      .map_err(Self::map_repo_err)
  }

  pub async fn active_attachment_blob_keys(&self) -> AuthResult<Vec<String>> {
    self
      .repo
      .list_active_copilot_attachment_blob_keys()
      .await
      .map_err(Self::map_repo_err)
  }

  pub async fn orphaned_attachment_blob_keys(&self) -> AuthResult<Vec<String>> {
    self
      .repo
      .list_orphaned_copilot_attachment_blob_keys()
      .await
      .map_err(Self::map_repo_err)
  }
}

/// In-memory [`CopilotRepository`] for use in tests.
///
/// All state is held in `RwLock`-guarded hash maps and is lost when the
/// instance is dropped.
#[derive(Default)]
pub struct InMemoryCopilotRepository {
  /// Copilot sessions keyed by session ID.
  sessions: RwLock<HashMap<Uuid, CopilotSession>>,
  /// Messages keyed by session ID (each session holds an ordered vec).
  messages: RwLock<HashMap<Uuid, Vec<CopilotMessage>>>,
  /// Revision history keyed by message ID.
  message_revisions: RwLock<HashMap<Uuid, Vec<CopilotMessage>>>,
  /// Contexts keyed by context ID.
  contexts: RwLock<HashMap<Uuid, CopilotContext>>,
  /// Context items keyed by context ID.
  context_items: RwLock<HashMap<Uuid, Vec<CopilotContextItem>>>,
  /// Workspace-level copilot state keyed by workspace ID.
  workspace_state: RwLock<HashMap<Uuid, CopilotWorkspaceState>>,
  /// Background jobs keyed by job ID.
  jobs: RwLock<HashMap<Uuid, CopilotJob>>,
}

#[async_trait]
impl CopilotRepository for InMemoryCopilotRepository {
  async fn commit_copilot_generated_file(
    &self,
    expected_session: &CopilotSession,
    source: &CopilotMessage,
    file: &CopilotAttachmentRef,
  ) -> RepoResult<CopilotAttachmentRef> {
    let sessions = self.sessions.read().await;
    let session = sessions
      .get(&source.session_id)
      .ok_or(RepositoryError::NotFound("copilot_session"))?;
    let mut guard = self.messages.write().await;
    let message = guard
      .get_mut(&source.session_id)
      .and_then(|messages| messages.iter_mut().find(|m| m.id == source.id))
      .ok_or(RepositoryError::NotFound("copilot_message"))?;
    files::append_generated_file(session, expected_session, message, source, file)
  }
  async fn claim_copilot_turn(
    &self,
    request: &myoxus_domain::copilot_turn::CopilotTurnRequest,
  ) -> RepoResult<myoxus_domain::copilot_turn::CopilotTurnClaim> {
    let mut sessions = self.sessions.write().await;
    let session = sessions
      .get_mut(&request.session_id)
      .ok_or(RepositoryError::NotFound("copilot_session"))?;
    let mut all = self.messages.write().await;
    let messages = all.entry(session.id).or_default();
    sort_messages(messages);
    let prepared =
      myoxus_domain::copilot_turn::prepare_turn_claim(session, messages, request).map_err(RepositoryError::Conflict)?;
    if prepared.write {
      if let Some(revision) = prepared.revision {
        self
          .message_revisions
          .write()
          .await
          .entry(revision.id)
          .or_default()
          .push(revision);
      }
      if let Some(old) = messages.iter_mut().find(|m| m.id == prepared.claim.message.id) {
        *old = prepared.claim.message.clone();
      } else {
        messages.push(prepared.claim.message.clone());
      }
      session.updated_at = request.now;
    }
    Ok(prepared.claim)
  }

  async fn submit_copilot_message(&self, user_id: Uuid, message: &CopilotMessage) -> RepoResult<CopilotMessage> {
    let mut sessions = self.sessions.write().await;
    let session = sessions
      .get_mut(&message.session_id)
      .filter(|s| s.user_id == user_id && s.deleted_at.is_none())
      .ok_or(RepositoryError::NotFound("copilot_session"))?;
    let mut all = self.messages.write().await;
    let messages = all.entry(session.id).or_default();
    if let Some(key) = message.token_usage.as_ref().and_then(|v| v.get("inputRequestId")) {
      if let Some(existing) = messages.iter().find(|m| {
        m.role == CopilotMessageRole::User
          && m
            .token_usage
            .as_ref()
            .is_some_and(|v| v.get("inputRequestId") == Some(key))
      }) {
        if !myoxus_domain::copilot_turn::same_submission(existing, message) {
          return Err(RepositoryError::Conflict(
            "copilot request id reused for different input",
          ));
        }
        return Ok(existing.clone());
      }
    }
    let mut message = message.clone();
    if let Some(Value::Object(usage)) = message.token_usage.as_mut() {
      usage.insert("sequence".into(), serde_json::json!(messages.len() + 1));
    }
    messages.push(message.clone());
    session.updated_at = message.created_at;
    Ok(message)
  }
  async fn commit_copilot_session_fork(&self, fork: &CopilotSessionFork) -> RepoResult<CopilotSession> {
    let mut sessions = self.sessions.write().await;
    let mut messages = self.messages.write().await;
    let source = sessions
      .get(&fork.source.id)
      .ok_or(RepositoryError::NotFound("copilot_session"))?;
    let mut current = messages.get(&source.id).cloned().unwrap_or_default();
    sort_messages(&mut current);
    if source != &fork.source || current != fork.source_messages {
      return Err(RepositoryError::Conflict("copilot fork source changed"));
    }
    if sessions.contains_key(&fork.session.id) || messages.contains_key(&fork.session.id) {
      return Err(RepositoryError::Conflict("copilot fork target exists"));
    }
    sessions.insert(fork.session.id, fork.session.clone());
    messages.insert(fork.session.id, fork.messages.clone());
    Ok(fork.session.clone())
  }

  async fn create_copilot_session(&self, session: &CopilotSession) -> RepoResult<CopilotSession> {
    self.sessions.write().await.insert(session.id, session.clone());
    Ok(session.clone())
  }

  async fn get_copilot_session(&self, session_id: Uuid) -> RepoResult<Option<CopilotSession>> {
    Ok(self.sessions.read().await.get(&session_id).cloned())
  }

  async fn list_copilot_sessions(
    &self,
    user_id: Uuid,
    filter: &CopilotSessionFilter,
    page: PageRequest,
  ) -> RepoResult<CopilotSessionPage> {
    let mut values = self
      .sessions
      .read()
      .await
      .values()
      .filter(|session| session.user_id == user_id)
      .filter(|session| filter.matches(session))
      .cloned()
      .collect::<Vec<_>>();
    values.sort_by_key(|session| (session.updated_at, session.id));
    if !filter.ascending {
      values.reverse();
    }
    let total_count = values.len() as i64;
    let access_scopes = values
      .iter()
      .map(|session| CopilotSessionAccessScope {
        workspace_id: session.workspace_id,
        doc_id: session.doc_id,
      })
      .collect::<HashSet<_>>()
      .into_iter()
      .collect();
    let start = page.offset.max(0) as usize;
    let end = (start + page.limit.max(0) as usize).min(values.len());
    let sessions = if start >= values.len() {
      Vec::new()
    } else {
      values[start..end].to_vec()
    };
    Ok(CopilotSessionPage {
      sessions,
      total_count,
      access_scopes,
    })
  }

  async fn update_copilot_session(&self, session: &CopilotSession) -> RepoResult<CopilotSession> {
    self.sessions.write().await.insert(session.id, session.clone());
    Ok(session.clone())
  }

  async fn archive_copilot_session(&self, session_id: Uuid, archived_at: DateTime<Utc>) -> RepoResult<()> {
    let mut guard = self.sessions.write().await;
    let session = guard
      .get_mut(&session_id)
      .ok_or(RepositoryError::NotFound("copilot_session"))?;
    session.archived_at = Some(archived_at);
    session.updated_at = archived_at;
    Ok(())
  }

  async fn delete_copilot_session(&self, session_id: Uuid, deleted_at: DateTime<Utc>) -> RepoResult<()> {
    let mut guard = self.sessions.write().await;
    let session = guard
      .get_mut(&session_id)
      .ok_or(RepositoryError::NotFound("copilot_session"))?;
    session.deleted_at = Some(deleted_at);
    session.updated_at = deleted_at;
    Ok(())
  }

  async fn append_copilot_message(&self, message: &CopilotMessage) -> RepoResult<CopilotMessage> {
    let sessions = self.sessions.read().await;
    if !sessions.contains_key(&message.session_id) {
      return Err(RepositoryError::NotFound("copilot_session"));
    }
    self
      .messages
      .write()
      .await
      .entry(message.session_id)
      .or_default()
      .push(message.clone());
    Ok(message.clone())
  }

  async fn get_copilot_message(&self, message_id: Uuid) -> RepoResult<Option<CopilotMessage>> {
    let guard = self.messages.read().await;
    for messages in guard.values() {
      if let Some(message) = messages.iter().find(|value| value.id == message_id) {
        return Ok(Some(message.clone()));
      }
    }
    Ok(None)
  }

  async fn update_copilot_message(&self, message: &CopilotMessage) -> RepoResult<CopilotMessage> {
    let mut guard = self.messages.write().await;
    for messages in guard.values_mut() {
      if let Some(current) = messages.iter_mut().find(|value| value.id == message.id) {
        let mut message = message.clone();
        myoxus_domain::copilot_turn::preserve_turn_metadata(&mut message, current);
        *current = message.clone();
        return Ok(message);
      }
    }
    Err(RepositoryError::NotFound("copilot_message"))
  }

  async fn update_copilot_stream(&self, message: &CopilotMessage, stream_id: Uuid) -> RepoResult<bool> {
    let mut guard = self.messages.write().await;
    let current = guard
      .values_mut()
      .flat_map(|messages| messages.iter_mut())
      .find(|value| value.id == message.id);
    let Some(current) = current else {
      return Ok(false);
    };
    let matches = current
      .token_usage
      .as_ref()
      .is_some_and(|usage| usage["streamId"] == stream_id.to_string() && usage["streamStatus"] == "running")
      && current.edited_at == message.edited_at;
    if matches {
      *current = message.clone();
    }
    Ok(matches)
  }

  async fn append_copilot_message_revision(&self, message_id: Uuid, revision: &CopilotMessage) -> RepoResult<()> {
    self
      .message_revisions
      .write()
      .await
      .entry(message_id)
      .or_default()
      .push(revision.clone());
    Ok(())
  }

  async fn list_copilot_message_revisions(
    &self,
    message_id: Uuid,
    page: PageRequest,
  ) -> RepoResult<Vec<CopilotMessage>> {
    let mut values = self
      .message_revisions
      .read()
      .await
      .get(&message_id)
      .cloned()
      .unwrap_or_default();
    values.sort_by_key(|message| message.created_at);
    let start = page.offset.max(0) as usize;
    let end = (start + page.limit.max(0) as usize).min(values.len());
    if start >= values.len() {
      return Ok(Vec::new());
    }
    Ok(values[start..end].to_vec())
  }

  async fn list_copilot_messages(&self, session_id: Uuid, page: PageRequest) -> RepoResult<Vec<CopilotMessage>> {
    let mut values = self.messages.read().await.get(&session_id).cloned().unwrap_or_default();
    sort_messages(&mut values);
    let start = page.offset.max(0) as usize;
    let end = (start + page.limit.max(0) as usize).min(values.len());
    if start >= values.len() {
      return Ok(Vec::new());
    }
    Ok(values[start..end].to_vec())
  }

  async fn append_copilot_tool_call(&self, tool_call: &CopilotToolCall) -> RepoResult<CopilotToolCall> {
    let mut guard = self.messages.write().await;
    for messages in guard.values_mut() {
      if let Some(message) = messages.iter_mut().find(|msg| msg.id == tool_call.message_id) {
        message.tool_calls.push(tool_call.clone());
        return Ok(tool_call.clone());
      }
    }
    Err(RepositoryError::NotFound("copilot_message"))
  }

  async fn append_copilot_attachment_ref(
    &self,
    attachment_ref: &CopilotAttachmentRef,
  ) -> RepoResult<CopilotAttachmentRef> {
    let mut guard = self.messages.write().await;
    for messages in guard.values_mut() {
      if let Some(message) = messages.iter_mut().find(|msg| msg.id == attachment_ref.message_id) {
        message.attachment_refs.push(attachment_ref.clone());
        return Ok(attachment_ref.clone());
      }
    }
    Err(RepositoryError::NotFound("copilot_message"))
  }

  async fn create_copilot_context(&self, context: &CopilotContext) -> RepoResult<CopilotContext> {
    self.contexts.write().await.insert(context.id, context.clone());
    Ok(context.clone())
  }

  async fn get_copilot_context(&self, context_id: Uuid) -> RepoResult<Option<CopilotContext>> {
    Ok(self.contexts.read().await.get(&context_id).cloned())
  }

  async fn find_copilot_context(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
    name: &str,
  ) -> RepoResult<Option<CopilotContext>> {
    Ok(
      self
        .contexts
        .read()
        .await
        .values()
        .find(|context| {
          context.user_id == user_id && context.workspace_id == Some(workspace_id) && context.name == name
        })
        .cloned(),
    )
  }

  async fn list_copilot_contexts(
    &self,
    user_id: Uuid,
    workspace_id: Option<Uuid>,
    page: PageRequest,
  ) -> RepoResult<Vec<CopilotContext>> {
    let mut values = self
      .contexts
      .read()
      .await
      .values()
      .filter(|context| context.user_id == user_id)
      .filter(|context| workspace_id.is_none() || context.workspace_id == workspace_id)
      .cloned()
      .collect::<Vec<_>>();
    values.sort_by_key(|context| context.created_at);
    values.reverse();
    let start = page.offset.max(0) as usize;
    let end = (start + page.limit.max(0) as usize).min(values.len());
    if start >= values.len() {
      return Ok(Vec::new());
    }
    Ok(values[start..end].to_vec())
  }

  async fn append_copilot_context_item(&self, item: &CopilotContextItem) -> RepoResult<CopilotContextItem> {
    self
      .context_items
      .write()
      .await
      .entry(item.context_id)
      .or_default()
      .push(item.clone());
    Ok(item.clone())
  }

  async fn list_copilot_context_items(
    &self,
    context_id: Uuid,
    page: PageRequest,
  ) -> RepoResult<Vec<CopilotContextItem>> {
    let mut values = self
      .context_items
      .read()
      .await
      .get(&context_id)
      .cloned()
      .unwrap_or_default();
    values.sort_by_key(|item| item.created_at);
    let start = page.offset.max(0) as usize;
    let end = (start + page.limit.max(0) as usize).min(values.len());
    if start >= values.len() {
      return Ok(Vec::new());
    }
    Ok(values[start..end].to_vec())
  }

  async fn get_copilot_context_item(&self, item_id: Uuid) -> RepoResult<Option<CopilotContextItem>> {
    Ok(
      self
        .context_items
        .read()
        .await
        .values()
        .flatten()
        .find(|item| item.id == item_id)
        .cloned(),
    )
  }

  async fn compare_context_item_metadata(
    &self,
    item_id: Uuid,
    expected: &Value,
    replacement: &Value,
  ) -> RepoResult<bool> {
    let mut guard = self.context_items.write().await;
    if let Some(item) = guard
      .values_mut()
      .flatten()
      .find(|item| item.id == item_id && item.metadata == *expected)
    {
      item.metadata = replacement.clone();
      return Ok(true);
    }
    Ok(false)
  }

  async fn due_context_ingestions(&self, now_ms: i64, limit: i64) -> RepoResult<Vec<CopilotContextItem>> {
    let guard = self.context_items.read().await;
    let mut items = guard
      .values()
      .flatten()
      .filter(|item| {
        matches!(item.metadata["ingestStatus"].as_str(), Some("queued" | "running"))
          && item.metadata["leaseUntil"].as_i64().unwrap_or(0) <= now_ms
      })
      .cloned()
      .collect::<Vec<_>>();
    items.sort_by_key(|item| item.created_at);
    items.truncate(limit.clamp(1, 100) as usize);
    Ok(items)
  }

  async fn remove_copilot_context_item(
    &self,
    context_id: Uuid,
    item_type: CopilotContextItemType,
    item_ref: &str,
  ) -> RepoResult<bool> {
    let mut guard = self.context_items.write().await;
    let Some(items) = guard.get_mut(&context_id) else {
      return Ok(false);
    };
    let before = items.len();
    items.retain(|item| !(item.item_type == item_type && item.item_ref == item_ref));
    Ok(items.len() != before)
  }

  async fn upsert_copilot_workspace_state(&self, state: &CopilotWorkspaceState) -> RepoResult<CopilotWorkspaceState> {
    self
      .workspace_state
      .write()
      .await
      .insert(state.workspace_id, state.clone());
    Ok(state.clone())
  }

  async fn get_copilot_workspace_state(&self, workspace_id: Uuid) -> RepoResult<Option<CopilotWorkspaceState>> {
    Ok(self.workspace_state.read().await.get(&workspace_id).cloned())
  }

  async fn create_copilot_job(&self, job: &CopilotJob) -> RepoResult<CopilotJob> {
    self.jobs.write().await.insert(job.id, job.clone());
    Ok(job.clone())
  }

  async fn get_copilot_job(&self, job_id: Uuid) -> RepoResult<Option<CopilotJob>> {
    Ok(self.jobs.read().await.get(&job_id).cloned())
  }

  async fn update_copilot_job_payload(&self, job_id: Uuid, payload: serde_json::Value) -> RepoResult<CopilotJob> {
    let mut guard = self.jobs.write().await;
    let job = guard.get_mut(&job_id).ok_or(RepositoryError::NotFound("copilot_job"))?;
    job.payload = payload;
    Ok(job.clone())
  }

  async fn update_copilot_job_state(
    &self,
    job_id: Uuid,
    state: CopilotJobState,
    error_message: Option<String>,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<CopilotJob> {
    let mut guard = self.jobs.write().await;
    let job = guard.get_mut(&job_id).ok_or(RepositoryError::NotFound("copilot_job"))?;
    job.state = state;
    job.error_message = error_message;
    job.updated_at = updated_at;
    Ok(job.clone())
  }

  async fn list_copilot_jobs(
    &self,
    workspace_id: Option<Uuid>,
    user_id: Option<Uuid>,
    state: Option<CopilotJobState>,
    page: PageRequest,
  ) -> RepoResult<Vec<CopilotJob>> {
    let mut values = self
      .jobs
      .read()
      .await
      .values()
      .filter(|job| workspace_id.is_none() || workspace_id == job.workspace_id)
      .filter(|job| user_id.is_none() || user_id == job.user_id)
      .filter(|job| state.is_none() || Some(job.state.clone()) == state)
      .cloned()
      .collect::<Vec<_>>();
    values.sort_by_key(|job| job.updated_at);
    values.reverse();
    let start = page.offset.max(0) as usize;
    let end = (start + page.limit.max(0) as usize).min(values.len());
    if start >= values.len() {
      return Ok(Vec::new());
    }
    Ok(values[start..end].to_vec())
  }

  async fn count_active_copilot_sessions(&self) -> RepoResult<i64> {
    Ok(
      self
        .sessions
        .read()
        .await
        .values()
        .filter(|session| session.deleted_at.is_none())
        .count() as i64,
    )
  }

  async fn purge_deleted_copilot_sessions_before(&self, cutoff: DateTime<Utc>) -> RepoResult<u64> {
    let mut sessions = self.sessions.write().await;
    let before = sessions.len();
    sessions.retain(|_, session| session.deleted_at.is_none_or(|deleted_at| deleted_at >= cutoff));
    Ok((before - sessions.len()) as u64)
  }

  async fn clear_copilot_session_document(&self, doc_id: Uuid) -> RepoResult<u64> {
    let mut sessions = self.sessions.write().await;
    let mut updated = 0;
    for session in sessions.values_mut() {
      if session.doc_id == Some(doc_id) {
        session.doc_id = None;
        updated += 1;
      }
    }
    Ok(updated)
  }

  async fn purge_empty_copilot_sessions_before(&self, cutoff: DateTime<Utc>) -> RepoResult<u64> {
    let messages = self.messages.read().await;
    let mut sessions = self.sessions.write().await;
    let before = sessions.len();
    sessions.retain(|id, session| session.created_at >= cutoff || messages.contains_key(id));
    Ok((before - sessions.len()) as u64)
  }

  async fn list_untitled_copilot_session_ids(&self, limit: i64) -> RepoResult<Vec<Uuid>> {
    let messages = self.messages.read().await;
    Ok(
      self
        .sessions
        .read()
        .await
        .values()
        .filter(|session| session.deleted_at.is_none())
        .filter(|session| session.title.as_deref().is_none_or(str::is_empty))
        .filter(|session| messages.contains_key(&session.id))
        .take(limit.max(0) as usize)
        .map(|session| session.id)
        .collect(),
    )
  }

  async fn list_active_copilot_attachment_blob_keys(&self) -> RepoResult<Vec<String>> {
    Ok(Vec::new())
  }

  async fn list_orphaned_copilot_attachment_blob_keys(&self) -> RepoResult<Vec<String>> {
    Ok(Vec::new())
  }
}

fn sort_messages(messages: &mut [CopilotMessage]) {
  messages.sort_by_key(|message| {
    (
      message.created_at,
      message
        .token_usage
        .as_ref()
        .and_then(|usage| usage.get("sequence"))
        .and_then(Value::as_i64)
        .unwrap_or(i64::MAX),
      message.id,
    )
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn copilot_service_creates_session_and_appends_messages() {
    let service = CopilotService::new(Arc::new(InMemoryCopilotRepository::default()));
    let user_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let session = service
      .create_session(
        user_id,
        Some(workspace_id),
        None,
        Some("  Planning  ".to_string()),
        Some("gpt-4.1".to_string()),
        serde_json::json!({"origin":"test"}),
      )
      .await
      .expect("create session");
    assert_eq!(session.title.as_deref(), Some("Planning"));

    let message = service
      .append_message(
        session.id,
        CopilotMessageRole::User,
        serde_json::json!({"text":"hello"}),
        None,
        Vec::new(),
        Vec::new(),
      )
      .await
      .expect("append message");
    assert_eq!(message.session_id, session.id);

    let listed = service.list_messages(session.id, 20, 0).await.expect("list messages");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, message.id);
  }

  #[tokio::test]
  async fn copilot_service_rejects_invalid_inputs() {
    let service = CopilotService::new(Arc::new(InMemoryCopilotRepository::default()));
    let user_id = Uuid::new_v4();
    let session = service
      .create_session(user_id, None, None, None, None, serde_json::json!({}))
      .await
      .expect("create session");

    let bad_message = service
      .append_message(
        session.id,
        CopilotMessageRole::User,
        Value::Null,
        None,
        Vec::new(),
        Vec::new(),
      )
      .await;
    assert!(bad_message.is_err());

    let bad_context = service
      .create_context(user_id, None, "   ".to_string(), serde_json::json!({}))
      .await;
    assert!(bad_context.is_err());
  }

  #[tokio::test]
  async fn copilot_service_handles_archive_delete_context_and_job_flows() {
    let repo = Arc::new(InMemoryCopilotRepository::default());
    let service = CopilotService::new(repo.clone());
    let user_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();

    let active = service
      .create_session(
        user_id,
        Some(workspace_id),
        None,
        Some("active".to_string()),
        None,
        serde_json::json!({}),
      )
      .await
      .expect("create active session");
    let archived = service
      .create_session(
        user_id,
        Some(workspace_id),
        None,
        Some("archived".to_string()),
        None,
        serde_json::json!({}),
      )
      .await
      .expect("create archived session");
    let deleted = service
      .create_session(
        user_id,
        Some(workspace_id),
        None,
        Some("deleted".to_string()),
        None,
        serde_json::json!({}),
      )
      .await
      .expect("create deleted session");

    service.archive_session(archived.id).await.expect("archive session");
    service.delete_session(deleted.id).await.expect("delete session");

    let visible_default = service
      .list_sessions(
        user_id,
        &CopilotSessionFilter {
          workspace_id: Some(workspace_id),
          ..Default::default()
        },
        20,
        0,
      )
      .await
      .expect("list visible default");
    assert_eq!(visible_default.sessions.len(), 1);
    assert_eq!(visible_default.sessions[0].id, active.id);

    let visible_with_archived = service
      .list_sessions(
        user_id,
        &CopilotSessionFilter {
          workspace_id: Some(workspace_id),
          include_archived: true,
          ..Default::default()
        },
        20,
        0,
      )
      .await
      .expect("list with archived");
    assert_eq!(visible_with_archived.sessions.len(), 2);
    assert!(visible_with_archived.sessions.iter().any(|s| s.id == active.id));
    assert!(visible_with_archived.sessions.iter().any(|s| s.id == archived.id));

    let updated = service
      .update_session(
        active.id,
        Some("renamed".to_string()),
        Some(true),
        Some(Some(Uuid::new_v4())),
        Some("gpt-4.1-mini".to_string()),
        Some(serde_json::json!({"promptName":"write"})),
      )
      .await
      .expect("update session");
    assert_eq!(updated.title.as_deref(), Some("renamed"));
    assert!(updated.pinned);
    assert_eq!(
      updated.metadata.get("promptName").and_then(|v| v.as_str()),
      Some("write")
    );

    let context = service
      .create_context(
        user_id,
        Some(workspace_id),
        "ctx".to_string(),
        serde_json::json!({"x":1}),
      )
      .await
      .expect("create context");
    let item = service
      .add_context_item(
        context.id,
        CopilotContextItemType::Doc,
        "doc-1".to_string(),
        serde_json::json!({}),
      )
      .await
      .expect("add context item");
    let removed = repo
      .remove_copilot_context_item(context.id, CopilotContextItemType::Doc, "doc-1")
      .await
      .expect("remove context item");
    assert!(removed);
    assert_eq!(item.context_id, context.id);

    let created_job = service
      .create_job(
        "embedding".to_string(),
        Some(workspace_id),
        Some(user_id),
        serde_json::json!({"docId":"d1"}),
      )
      .await
      .expect("create job");
    let updated_job = repo
      .update_copilot_job_state(created_job.id, CopilotJobState::Finished, None, Utc::now())
      .await
      .expect("update job state");
    assert_eq!(updated_job.state, CopilotJobState::Finished);
  }

  #[tokio::test]
  async fn copilot_service_tracks_message_sequence_and_edit_revisions() {
    let service = CopilotService::new(Arc::new(InMemoryCopilotRepository::default()));
    let user_id = Uuid::new_v4();
    let session = service
      .create_session(user_id, None, None, None, None, serde_json::json!({}))
      .await
      .expect("create session");

    let first = service
      .append_message(
        session.id,
        CopilotMessageRole::User,
        serde_json::json!({"text":"one"}),
        None,
        Vec::new(),
        Vec::new(),
      )
      .await
      .expect("append first");
    let second = service
      .append_message(
        session.id,
        CopilotMessageRole::Assistant,
        serde_json::json!({"text":"two"}),
        Some(serde_json::json!({"total_tokens": 7})),
        Vec::new(),
        Vec::new(),
      )
      .await
      .expect("append second");

    assert_eq!(
      first
        .token_usage
        .as_ref()
        .and_then(|value| value.get("sequence"))
        .and_then(|value| value.as_i64()),
      Some(1)
    );
    assert_eq!(
      second
        .token_usage
        .as_ref()
        .and_then(|value| value.get("sequence"))
        .and_then(|value| value.as_i64()),
      Some(2)
    );
    assert_eq!(
      second
        .token_usage
        .as_ref()
        .and_then(|value| value.get("total_tokens"))
        .and_then(|value| value.as_i64()),
      Some(7)
    );

    let edited = service
      .edit_message(second.id, serde_json::json!({"text":"two-edited"}))
      .await
      .expect("edit message");
    assert!(edited.edited_at.is_some());
    assert_eq!(
      edited.content.get("text").and_then(|value| value.as_str()),
      Some("two-edited")
    );

    let revisions = service
      .list_message_revisions(second.id, 10, 0)
      .await
      .expect("list revisions");
    assert_eq!(revisions.len(), 1);
    assert_eq!(
      revisions[0].content.get("text").and_then(|value| value.as_str()),
      Some("two")
    );
  }

  #[tokio::test]
  async fn copilot_streaming_persists_partial_and_finalized_assistant_message() {
    let service = CopilotService::new(Arc::new(InMemoryCopilotRepository::default()));
    let user_id = Uuid::new_v4();
    let session = service
      .create_session(user_id, None, None, None, None, serde_json::json!({}))
      .await
      .expect("create session");

    let handle = service.start_message_stream(session.id).await.expect("start stream");
    service
      .append_stream_reasoning(handle.stream_id, "Thinking".into())
      .await
      .unwrap();
    service
      .append_stream_chunk(handle.stream_id, "Hel".to_string())
      .await
      .expect("append chunk 1");
    let updated = service
      .append_stream_chunk(handle.stream_id, "lo".to_string())
      .await
      .expect("append chunk 2");
    assert_eq!(
      updated.content.get("text").and_then(|value| value.as_str()),
      Some("Hello")
    );

    let finalized = service
      .finalize_stream(&handle, CopilotStreamOutcome::Completed)
      .await
      .expect("finalize stream");
    assert_eq!(
      finalized
        .token_usage
        .as_ref()
        .and_then(|value| value.get("streamStatus"))
        .and_then(|value| value.as_str()),
      Some("done")
    );
    assert_eq!(
      finalized.content["streamObjects"],
      serde_json::json!([
        {"type":"reasoning","textDelta":"Thinking"}, {"type":"text-delta","textDelta":"Hello"}
      ])
    );
    assert!(
      service
        .list_message_revisions(handle.message_id, 10, 0)
        .await
        .unwrap()
        .is_empty(),
      "stream writes are not deliberate edits"
    );
    assert!(service.stream_snapshot(handle.stream_id).await.unwrap().is_none());
    assert_eq!(
      service
        .finalize_stream(&handle, CopilotStreamOutcome::Canceled)
        .await
        .unwrap(),
      finalized,
      "terminal finalization is idempotent after buffer removal"
    );
  }

  #[tokio::test]
  async fn copilot_active_snapshot_and_chunk_retry_are_idempotent() {
    let service = CopilotService::new(Arc::new(InMemoryCopilotRepository::default()));
    let user_id = Uuid::new_v4();
    let session = service
      .create_session(user_id, None, None, None, None, serde_json::json!({}))
      .await
      .expect("create session");

    let handle = service.start_message_stream(session.id).await.expect("start stream");
    service
      .append_stream_chunk_with_id(handle.stream_id, Some("chunk-1".to_string()), "Hi ".to_string())
      .await
      .expect("append first");
    service
      .append_stream_chunk_with_id(handle.stream_id, Some("chunk-1".to_string()), "Hi ".to_string())
      .await
      .expect("append duplicate ignored");
    service
      .append_stream_chunk_with_id(handle.stream_id, Some("chunk-2".to_string()), "there".to_string())
      .await
      .expect("append second");

    let snapshot = service
      .stream_snapshot(handle.stream_id)
      .await
      .expect("stream snapshot")
      .expect("stream exists");
    assert_eq!(snapshot.text, "Hi there");
    service
      .finalize_stream(&handle, CopilotStreamOutcome::Failed)
      .await
      .unwrap();
    assert!(service.stream_snapshot(handle.stream_id).await.unwrap().is_none());
    assert!(
      service
        .append_stream_chunk(handle.stream_id, "late".into())
        .await
        .is_err()
    );
    let failed = service
      .list_messages(session.id, 10, 0)
      .await
      .unwrap()
      .into_iter()
      .find(|message| message.id == handle.message_id)
      .unwrap();
    assert_eq!(failed.content["text"], "Hi there");
    assert_eq!(failed.token_usage.as_ref().unwrap()["streamStatus"], "failed");
  }

  #[tokio::test]
  async fn copilot_stream_finalization_cannot_replace_edits_or_a_new_generation() {
    let repo = Arc::new(InMemoryCopilotRepository::default());
    let service = CopilotService::new(repo.clone());
    let user_id = Uuid::new_v4();
    let session = service
      .create_session(user_id, None, None, None, None, serde_json::json!({}))
      .await
      .unwrap();
    let user = service
      .append_message(
        session.id,
        CopilotMessageRole::User,
        serde_json::json!({"text":"prompt"}),
        None,
        Vec::new(),
        Vec::new(),
      )
      .await
      .unwrap();
    let handle = service.start_message_stream(session.id).await.unwrap();
    service
      .append_stream_chunk(handle.stream_id, "partial".into())
      .await
      .unwrap();
    let edited = service
      .edit_message(handle.message_id, serde_json::json!({"text":"manual edit"}))
      .await
      .unwrap();
    let terminal = service
      .finalize_stream(&handle, CopilotStreamOutcome::Completed)
      .await
      .unwrap();
    assert_eq!(terminal.token_usage.as_ref().unwrap()["streamStatus"], "canceled");
    assert!(service.stream_snapshot(handle.stream_id).await.unwrap().is_none());
    assert_eq!(
      repo.get_copilot_message(handle.message_id).await.unwrap().unwrap(),
      edited
    );
    let now = Utc::now();
    let request = myoxus_domain::copilot_turn::CopilotTurnRequest {
      user_id,
      session_id: session.id,
      workspace_id: None,
      doc_id: None,
      request_id: "explicit-new-generation".into(),
      user_message_id: user.id,
      assistant_message_id: Some(edited.id),
      expected_stream_id: Some(handle.stream_id),
      model: "fixture".into(),
      reasoning: None,
      stream_id: Uuid::new_v4(),
      response_id: Uuid::new_v4(),
      now,
      deadline: now + chrono::Duration::seconds(60),
    };
    let (claim, new_handle) = service.claim_message_stream(&request).await.unwrap();
    assert!(claim.acquired);
    let new_handle = new_handle.unwrap();
    let newer = service
      .append_stream_chunk(new_handle.stream_id, "new generation".into())
      .await
      .unwrap();
    assert!(
      service
        .finalize_stream(&handle, CopilotStreamOutcome::Canceled)
        .await
        .is_err()
    );
    assert_eq!(
      repo.get_copilot_message(handle.message_id).await.unwrap().unwrap(),
      newer
    );
  }

  #[tokio::test]
  async fn copilot_retrieval_context_respects_workspace_doc_scope_and_ignore_list() {
    let service = CopilotService::new(Arc::new(InMemoryCopilotRepository::default()));
    let user_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let doc_kept = Uuid::new_v4();
    let doc_ignored = Uuid::new_v4();

    let context = service
      .create_context(
        user_id,
        Some(workspace_id),
        "ctx".to_string(),
        serde_json::json!({"name":"main"}),
      )
      .await
      .expect("create context");
    service
      .add_context_item(
        context.id,
        CopilotContextItemType::Doc,
        doc_kept.to_string(),
        serde_json::json!({}),
      )
      .await
      .expect("add kept doc");
    service
      .add_context_item(
        context.id,
        CopilotContextItemType::Doc,
        doc_ignored.to_string(),
        serde_json::json!({}),
      )
      .await
      .expect("add ignored doc");
    service
      .upsert_workspace_state(workspace_id, vec![doc_ignored], serde_json::json!({}))
      .await
      .expect("upsert state");

    let retrieval = service
      .build_retrieval_context(user_id, workspace_id, Some(doc_kept), "irrelevant".to_string(), 10)
      .await
      .expect("build retrieval context");
    let items = retrieval["items"].as_array().expect("items array");
    let expected_ref = doc_kept.to_string();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["itemRef"].as_str(), Some(expected_ref.as_str()));
  }

  #[tokio::test]
  async fn copilot_embedding_version_schema_marks_reindex_and_queues_job() {
    let service = CopilotService::new(Arc::new(InMemoryCopilotRepository::default()));
    let workspace_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();

    let (_state1, reindex1) = service
      .upsert_embedding_version(workspace_id, "text-embed-3-large".to_string(), "r1".to_string())
      .await
      .expect("upsert embedding version first");
    assert!(reindex1);
    let queued1 = service
      .queue_reindex_for_embedding_if_needed(workspace_id, Some(user_id))
      .await
      .expect("queue first");
    assert!(queued1.is_some());

    let (_state2, reindex2) = service
      .upsert_embedding_version(workspace_id, "text-embed-3-large".to_string(), "r1".to_string())
      .await
      .expect("upsert embedding version same");
    assert!(!reindex2);
    let queued2 = service
      .queue_reindex_for_embedding_if_needed(workspace_id, Some(user_id))
      .await
      .expect("queue second");
    assert!(queued2.is_none());

    let (state3, reindex3) = service
      .upsert_embedding_version(workspace_id, "text-embed-3-large".to_string(), "r2".to_string())
      .await
      .expect("upsert embedding version changed");
    assert!(reindex3);
    assert_eq!(
      state3
        .metadata
        .get("embedding")
        .and_then(|value| value.get("previousRevision"))
        .and_then(|value| value.as_str()),
      Some("r1")
    );
  }

  #[tokio::test]
  async fn copilot_attachment_ingestion_uses_parser_fallback_and_records_metadata() {
    let service = CopilotService::new(Arc::new(InMemoryCopilotRepository::default()));
    let user_id = Uuid::new_v4();
    let session = service
      .create_session(user_id, None, None, None, None, serde_json::json!({}))
      .await
      .expect("create session");
    let message = service
      .append_message(
        session.id,
        CopilotMessageRole::User,
        serde_json::json!({"text":"upload"}),
        None,
        Vec::new(),
        Vec::new(),
      )
      .await
      .expect("append message");

    let text_attachment = service
      .ingest_attachment_for_message(
        message.id,
        "blob/text".to_string(),
        Some("note.txt".to_string()),
        Some("text/plain".to_string()),
        b"hello world".to_vec(),
      )
      .await
      .expect("ingest text");
    assert_eq!(
      text_attachment.metadata.get("parser").and_then(|value| value.as_str()),
      Some("utf8-text")
    );
    assert_eq!(
      text_attachment
        .metadata
        .get("parserError")
        .and_then(|value| value.as_str()),
      None
    );

    let bin_attachment = service
      .ingest_attachment_for_message(
        message.id,
        "blob/bin".to_string(),
        Some("blob.bin".to_string()),
        Some("application/octet-stream".to_string()),
        vec![0, 1, 2, 3, 4],
      )
      .await
      .expect("ingest binary");
    assert_eq!(
      bin_attachment.metadata.get("parser").and_then(|value| value.as_str()),
      Some("base64-preview-fallback")
    );
    assert_eq!(
      bin_attachment
        .metadata
        .get("parserError")
        .and_then(|value| value.as_str()),
      Some("unsupported mime type for structured parser")
    );
  }

  #[tokio::test]
  async fn copilot_retrieval_windowing_applies_score_order_and_char_budget() {
    let service = CopilotService::new(Arc::new(InMemoryCopilotRepository::default()));
    let payload = serde_json::json!({
        "items": [
            {"itemRef":"doc-a", "score": 2, "metadata":{"textPreview":"aaaa"}},
            {"itemRef":"doc-b", "score": 9, "metadata":{"textPreview":"bbbbbbbb"}},
            {"itemRef":"doc-c", "score": 5, "metadata":{"textPreview":"cccccc"}}
        ]
    });
    let windowed = service
      .apply_retrieval_window(payload, 2, 24)
      .await
      .expect("window retrieval");
    let items = windowed["items"].as_array().expect("items array");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["itemRef"].as_str(), Some("doc-b"));
    assert_eq!(items[1]["itemRef"].as_str(), Some("doc-c"));
    assert_eq!(windowed["window"]["keptItems"].as_i64(), Some(2));
  }

  #[tokio::test]
  async fn copilot_security_filter_enforces_doc_allowlist_and_redacts_secrets() {
    let service = CopilotService::new(Arc::new(InMemoryCopilotRepository::default()));
    let allowed_doc = Uuid::new_v4();
    let denied_doc = Uuid::new_v4();
    let payload = serde_json::json!({
        "items": [
            {"type":"doc", "itemRef": allowed_doc, "metadata":{"textPreview":"api key sk-abc password=123"}},
            {"type":"doc", "itemRef": denied_doc, "metadata":{"textPreview":"public"}},
            {"type":"file", "itemRef":"file-1", "metadata":{"textPreview":"password=xyz"}}
        ]
    });
    let secured = service
      .enforce_retrieval_security(payload, &[allowed_doc])
      .await
      .expect("secure payload");
    let items = secured["items"].as_array().expect("items");
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|item| item["itemRef"] != denied_doc.to_string()));
    let preview = items[0]["metadata"]["textPreview"]
      .as_str()
      .unwrap_or_default()
      .to_string()
      + items[1]["metadata"]["textPreview"].as_str().unwrap_or_default();
    assert!(preview.contains("[REDACTED_KEY]"));
    assert!(preview.contains("password=[REDACTED]"));
  }

  #[tokio::test]
  async fn copilot_retrieval_order_is_deterministic_for_equal_scores() {
    let service = CopilotService::new(Arc::new(InMemoryCopilotRepository::default()));
    let user_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();

    let context = service
      .create_context(
        user_id,
        Some(workspace_id),
        "regression".to_string(),
        serde_json::json!({"name":"equal-scores"}),
      )
      .await
      .expect("create context");

    for doc in ["doc-zeta", "doc-alpha", "doc-beta"] {
      service
        .add_context_item(
          context.id,
          CopilotContextItemType::Doc,
          doc.to_string(),
          serde_json::json!({"textPreview":"preview"}),
        )
        .await
        .expect("add context item");
    }

    let first = service
      .build_retrieval_context(user_id, workspace_id, None, "unrelated".to_string(), 10)
      .await
      .expect("build retrieval first");
    let second = service
      .build_retrieval_context(user_id, workspace_id, None, "unrelated".to_string(), 10)
      .await
      .expect("build retrieval second");

    let first_refs = first["items"]
      .as_array()
      .expect("first items")
      .iter()
      .map(|value| value["itemRef"].as_str().unwrap_or_default().to_string())
      .collect::<Vec<_>>();
    let second_refs = second["items"]
      .as_array()
      .expect("second items")
      .iter()
      .map(|value| value["itemRef"].as_str().unwrap_or_default().to_string())
      .collect::<Vec<_>>();
    assert_eq!(first_refs, second_refs);
    assert_eq!(
      first_refs,
      vec!["doc-alpha".to_string(), "doc-beta".to_string(), "doc-zeta".to_string()]
    );

    let windowed = service
      .apply_retrieval_window(first, 2, 0)
      .await
      .expect("apply retrieval window");
    let windowed_refs = windowed["items"]
      .as_array()
      .expect("windowed items")
      .iter()
      .map(|value| value["itemRef"].as_str().unwrap_or_default().to_string())
      .collect::<Vec<_>>();
    assert_eq!(windowed_refs, vec!["doc-alpha".to_string(), "doc-beta".to_string()]);
  }
}
