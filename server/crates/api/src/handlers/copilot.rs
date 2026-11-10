//! Copilot SSE streaming, blob proxy, and Unsplash photo-search handlers.
//!
//! Implements the Copilot REST surface required for API-compatibility:
//! - `GET /api/copilot/chat/{session_id}/stream-object` — SSE chat stream
//! - `GET /api/copilot/chat/{session_id}/workflow` — SSE workflow stream (basic)
//! - `GET /api/copilot/chat/{session_id}/images` — image generation (not configured)
//! - `GET /api/copilot/blobs/{key}` — proxy blob download through Copilot endpoint
//! - `GET /api/unsplash/photos` — Unsplash photo search proxy

use axum::{
  extract::{Path, Query, State},
  http::StatusCode,
  response::{IntoResponse, Json, Sse, sse::Event as SseEvent},
};
use futures_util::StreamExt;
use myoxus_application::copilot::provider::{
  LlmProviderError, LlmRequest, LlmStreamEvent, map_provider_error_to_legacy,
};
use myoxus_domain::entities::CopilotMessageRole;
use myoxus_infrastructure::copilot::embedding_store::build_context_window;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{debug, error, info, instrument, trace, warn};
use uuid::Uuid;
mod files;
pub(crate) use files::{descriptor as file_descriptor, download as download_generated_file, file_service};

use crate::state::ApiState;

/// Query parameters forwarded to the Unsplash search API.
#[derive(Debug, Deserialize)]
pub(crate) struct CopilotUnsplashQuery {
  /// Free-text search query.
  query: Option<String>,
  /// Page number (1-based).
  page: Option<u32>,
  /// Number of results per page.
  per_page: Option<u32>,
  /// Photo orientation filter (`"landscape"`, `"portrait"`, `"squarish"`).
  orientation: Option<String>,
  /// Sort order (`"relevant"` or `"latest"`).
  order_by: Option<String>,
  /// Color filter (e.g. `"black_and_white"`, `"red"`).
  color: Option<String>,
}

/// Fallback response returned when no Unsplash API key is configured.
#[derive(Debug, Serialize)]
pub(crate) struct UnsplashEmptyResponse {
  /// Total number of matching photos (always 0 for the stub).
  total: i32,
  /// Total number of result pages (always 0 for the stub).
  total_pages: i32,
  /// Empty results list.
  results: Vec<serde_json::Value>,
}

/// Query parameters for the copilot chat SSE endpoint.
///
/// The client may pass `message` (the new user prompt) and `modelId` as query
/// params.  When `message` is absent the session's existing history is replayed
/// without appending a new user turn.
#[derive(Debug, Deserialize)]
pub(crate) struct CopilotChatSseQuery {
  /// New user message to append before streaming.
  message: Option<String>,
  /// Model override (e.g. `"gpt-4o-mini"`).
  model: Option<String>,
  /// Native model ID; `model` is accepted only as the deployed ingress alias.
  #[serde(rename = "modelId")]
  model_id: Option<String>,
  reasoning: Option<bool>,
  #[serde(rename = "toolsConfig")]
  tools_config: Option<String>,
  #[serde(rename = "requestId")]
  request_id: Option<String>,
  #[serde(rename = "messageId")]
  message_id: Option<Uuid>,
  #[serde(rename = "responseId")]
  response_id: Option<Uuid>,
  #[serde(rename = "expectedStreamId")]
  expected_stream_id: Option<Uuid>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopilotRetrievalOptions {
  search_workspace: Option<bool>,
}

/// `GET /api/copilot/chat/{session_id}/{endpoint}` — Copilot SSE streaming.
///
/// Accepted `endpoint` values:
/// - `"stream-object"` / `"workflow"` — real SSE chat stream via LLM provider
/// - `"images"` — returns an SSE error (image generation not configured)
///
/// **Auth**: Session cookie (`affine_session`).
///
/// **SSE event protocol**:
/// - `event: message` / `data: {"type":"text-delta","textDelta":"..."}` — client stream object
/// - `event: done` / `data: {"type":"done"}` — stream completed
/// - `event: error` / `data: {"type":"error","code":"...","message":"..."}` — error
#[instrument(skip_all)]
pub(crate) async fn copilot_chat_sse_handler(
  State(state): State<ApiState>,
  Path((session_id_str, endpoint)): Path<(String, String)>,
  Query(params): Query<CopilotChatSseQuery>,
  headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  // ── Validate endpoint ──────────────────────────────────────────────────
  if endpoint != "stream-object" && endpoint != "workflow" && endpoint != "images" {
    return Err(StatusCode::NOT_FOUND);
  }

  let session_id = Uuid::parse_str(&session_id_str).map_err(|_| StatusCode::BAD_REQUEST)?;

  // ── Authenticate ───────────────────────────────────────────────────────
  let cookies = crate::graphql::utils::parse_cookies(&headers);
  let auth_session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME);
  let snapshot = if let Some(sid) = auth_session_id {
    state.auth().get_session_snapshot(sid).await.ok().flatten()
  } else {
    None
  };

  let Some(snapshot) = snapshot else {
    return Ok(make_sse_error_response(
      "UNAUTHORIZED",
      "Authentication required for copilot stream",
    ));
  };
  let user_id = snapshot.user.id;
  trace!(%user_id, %session_id, %endpoint, "copilot SSE stream requested");

  // ── Images endpoint: not configured ────────────────────────────────────
  if endpoint == "images" {
    return Ok(make_sse_error_response(
      "IMAGE_GENERATION_NOT_CONFIGURED",
      "Image generation is not configured on this server",
    ));
  }

  // ── Load copilot session ───────────────────────────────────────────────
  let copilot = state.copilot();
  let session = match copilot.get_session(session_id).await {
    Ok(s) => s,
    Err(e) => {
      warn!(%session_id, error = %e, "copilot session not found for SSE stream");
      return Ok(make_sse_error_response(
        "COPILOT_SESSION_NOT_FOUND",
        &format!("Copilot session not found: {e}"),
      ));
    }
  };

  // Ownership alone is insufficient after deletion, a workspace policy change
  // or a revoked document grant. Deny before reading history or invoking a provider.
  if crate::graphql::auth::assert_copilot_session_access(&state, user_id, &session, "copilot.stream")
    .await
    .is_err()
  {
    warn!(%session_id, %user_id, "copilot stream access denied");
    return Ok(make_sse_error_response(
      "COPILOT_ACCESS_DENIED",
      "Copilot session is unavailable or access is denied",
    ));
  }

  if let (Some(model_id), Some(alias)) = (&params.model_id, &params.model)
    && model_id != alias
  {
    return Ok(make_sse_error_response(
      "COPILOT_SESSION_INVALID_INPUT",
      "Conflicting modelId and model selections",
    ));
  }
  let available_models = state.config.copilot.chat_models();
  let selected = params
    .model_id
    .as_deref()
    .or(params.model.as_deref())
    .or(session.model.as_deref());
  let model = match selected.or_else(|| available_models.first().map(String::as_str)) {
    Some(model) if available_models.iter().any(|id| id == model) => model.to_string(),
    Some(_) => {
      return Ok(make_sse_error_response(
        "COPILOT_SESSION_INVALID_INPUT",
        "The selected model is unavailable. Choose a configured model and try again.",
      ));
    }
    None => {
      return Ok(make_sse_error_response(
        "NO_COPILOT_PROVIDER_AVAILABLE",
        "No enabled chat model is configured",
      ));
    }
  };
  let providers = state
    .config
    .copilot
    .chat_providers()
    .into_iter()
    .filter(|(_, provider)| provider.models.contains(&model))
    .filter(|(_, provider)| {
      params.reasoning.is_none()
        || provider
          .model_options
          .get(&model)
          .is_some_and(|options| options.reasoning_control.is_some())
    })
    .map(|(id, _)| id.to_string())
    .collect::<Vec<_>>();
  let Some(default_provider) = providers.first().cloned() else {
    return Ok(make_sse_error_response(
      "COPILOT_SESSION_INVALID_INPUT",
      "Reasoning override is not supported for the selected model",
    ));
  };
  let fallback_chain = providers[1..].to_vec();

  // ── Append the new user message (if provided) ─────────────────────────
  let retrieval = match params
    .tools_config
    .as_deref()
    .map(serde_json::from_str::<CopilotRetrievalOptions>)
    .transpose()
  {
    Ok(options) => options.unwrap_or_default(),
    Err(_) => {
      return Ok(make_sse_error_response(
        "COPILOT_SESSION_INVALID_INPUT",
        "Invalid workspace search options",
      ));
    }
  };
  if params.request_id.is_some() && params.message.is_some() {
    return Ok(make_sse_error_response(
      "COPILOT_SESSION_INVALID_INPUT",
      "A correlated request must submit its message before generation",
    ));
  }
  if let Some(user_message) = &params.message {
    let trimmed = user_message.trim();
    if !trimmed.is_empty() {
      if let Err(e) = copilot
        .append_message(
          session_id,
          CopilotMessageRole::User,
          json!({ "text": trimmed }),
          None,
          Vec::new(),
          Vec::new(),
        )
        .await
      {
        error!(%session_id, error = %e, "failed to append user message");
        return Ok(make_sse_error_response(
          "COPILOT_SESSION_INVALID_INPUT",
          &format!("Failed to append user message: {e}"),
        ));
      }
      state.metrics().record(
        myoxus_application::metrics::MetricsCategory::Ai,
        "chat_message",
        &[("endpoint", endpoint.as_str())],
      );
    }
  }

  // ── Load message history ───────────────────────────────────────────────
  let mut messages = match copilot.generation_messages(session_id).await {
    Ok(m) => m,
    Err(e) => {
      error!(%session_id, error = %e, "failed to load copilot message history");
      return Ok(make_sse_error_response(
        "COPILOT_PROVIDER_SIDE_ERROR",
        &format!("Failed to load message history: {e}"),
      ));
    }
  };

  let selected_context = match myoxus_application::copilot::context_prompt::CopilotSelectedContext::from_params(
    messages
      .iter()
      .rev()
      .find(|message| message.role == CopilotMessageRole::User)
      .and_then(|message| message.token_usage.as_ref()),
  ) {
    Ok(context) => context,
    Err(_) => {
      return Ok(make_sse_error_response(
        "COPILOT_SESSION_INVALID_INPUT",
        "Invalid selected context",
      ));
    }
  };
  // Validate explicit references before any embedding or generation request.
  // Ignore client docContent/title; the application materializes current content.
  let mut explicit_docs = Vec::new();
  let mut prompt_docs = Vec::new();
  // A document-sidebar question without a deliberate selection refers to the
  // open document. Materialize it directly, without narrowing workspace search.
  let include_current_doc = !selected_context.has_selection()
    && selected_context.docs.as_ref().is_none_or(|docs| docs.is_empty());
  {
    let refs = selected_context
      .docs
      .iter()
      .flatten()
      .map(|doc| doc.doc_id.as_str())
      .chain(selected_context.current_doc_id.as_deref());
    for doc_ref in refs {
      let Some(workspace_id) = session.workspace_id else {
        return Ok(make_sse_error_response(
          "COPILOT_ACCESS_DENIED",
          "Document context unavailable",
        ));
      };
      let id = match crate::graphql::utils::resolve_doc_id(&state, workspace_id, doc_ref).await {
        Ok(id) => id,
        Err(_) => {
          return Ok(make_sse_error_response(
            "COPILOT_ACCESS_DENIED",
            "Document context unavailable",
          ));
        }
      };
      if crate::graphql::auth::assert_copilot_doc_access(&state, user_id, workspace_id, id)
        .await
        .is_err()
      {
        return Ok(make_sse_error_response(
          "COPILOT_ACCESS_DENIED",
          "Document context unavailable",
        ));
      }
      if selected_context.docs.iter().flatten().any(|doc| doc.doc_id == doc_ref) && !explicit_docs.contains(&id) {
        explicit_docs.push(id);
      }
      if (explicit_docs.contains(&id)
        || (include_current_doc && selected_context.current_doc_id.as_deref() == Some(doc_ref)))
        && !prompt_docs.contains(&id)
      {
        prompt_docs.push(id);
      }
    }
  }

  let preparation_timeout_ms = if prompt_docs.is_empty()
    && !selected_context.has_selection()
    && selected_context.files.as_ref().is_none_or(|files| files.is_empty())
    && messages.iter().all(|message| message.attachment_refs.is_empty())
  {
    0
  } else {
    state.config.copilot.request_timeout_ms.max(1)
  };
  let mut claimed_guard = None;
  if let Some(request_id) = &params.request_id {
    let Some(user_message_id) = params.message_id else {
      return Ok(make_sse_error_response(
        "COPILOT_SESSION_INVALID_INPUT",
        "A correlated request requires its user message target",
      ));
    };
    let now = chrono::Utc::now();
    // Preparation and retrieval have independent bounds. Reserve them in
    // addition to every provider attempt, never instead of provider time.
    let claim_timeout_ms = providers
      .iter()
      .filter_map(|id| state.config.copilot.providers.get(id))
      .fold(3000u64.saturating_add(preparation_timeout_ms), |total, provider| {
        total.saturating_add(provider.timeout_ms)
      });
    let deadline = now
      .checked_add_signed(chrono::Duration::milliseconds(
        claim_timeout_ms.clamp(1, i64::MAX as u64) as i64,
      ))
      .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    let request = myoxus_domain::copilot_turn::CopilotTurnRequest {
      user_id,
      session_id,
      workspace_id: session.workspace_id,
      doc_id: session.doc_id,
      request_id: request_id.clone(),
      user_message_id,
      assistant_message_id: params.response_id,
      expected_stream_id: params.expected_stream_id,
      model: model.clone(),
      reasoning: params.reasoning,
      stream_id: Uuid::new_v4(),
      response_id: Uuid::new_v4(),
      now,
      deadline,
    };
    match copilot.claim_message_stream(&request).await {
      Ok((claim, Some(handle))) => {
        messages = claim.history;
        claimed_guard = Some(myoxus_application::copilot::CopilotStreamGuard::new(
          copilot.as_ref().clone(),
          handle,
        ));
      }
      Ok((claim, None)) => return Ok(replay_copilot_response(copilot.clone(), claim.message)),
      Err(
        myoxus_application::auth::AuthError::InvalidInput(_) | myoxus_application::auth::AuthError::ActionForbidden,
      ) => {
        return Ok(make_sse_error_response(
          "COPILOT_SESSION_INVALID_INPUT",
          "The chat turn or generation changed; reload the conversation before retrying",
        ));
      }
      Err(error) => {
        warn!(%session_id,error=%error,"copilot turn claim failed");
        return Ok(make_sse_error_response(
          "COPILOT_PROVIDER_SIDE_ERROR",
          "The response claim could not be saved",
        ));
      }
    }
  } else if params.response_id.is_some() || params.expected_stream_id.is_some() {
    return Ok(make_sse_error_response(
      "COPILOT_SESSION_INVALID_INPUT",
      "A regeneration target requires request correlation",
    ));
  }

  let (selected_prompt, image_content) = if preparation_timeout_ms == 0 {
    (None, std::collections::HashMap::new())
  } else {
    // Replay returns above without reprojecting changed source content. Only
    // the acquiring caller prepares a bounded prompt before opening generation.
    let budget = std::time::Duration::from_millis(preparation_timeout_ms);
    let started = tokio::time::Instant::now();
    let prepared = tokio::time::timeout(budget, async {
      let prompt = selected_context
        .materialize_prompt(
          myoxus_application::copilot::context_prompt::SelectedContextSources {
            docs: state.doc(),
            blobs: state.blob(),
            copilot: &copilot,
            permissions: &state.permission_service(),
            session: &session,
          },
          &prompt_docs,
          state.config.mcp.document_export_max_bytes,
        )
        .await?;
      let effective = state.effective_config().await;
      let fallback = myoxus_infrastructure::mime_policy_config::MimePolicyFallback {
        allowlist: &effective.base.git_sync.mime_allowlist_admin,
        blocklist: &effective.base.git_sync.mime_blocklist_admin,
        validation_mode: &effective.base.git_sync.mime_validation_mode,
      };
      let policy = myoxus_infrastructure::mime_policy_config::resolve_mime_policy_config(
        &effective.overrides.overrides,
        &fallback,
      );
      let images = myoxus_application::copilot::context_prompt::materialize_message_images(
        &messages,
        &session,
        state.blob(),
        &state.permission_service(),
        effective.base.storage.max_upload_bytes(),
        &policy,
      )
      .await?;
      Ok::<_, myoxus_application::auth::AuthError>((prompt, images))
    })
    .await;
    match prepared {
      Ok(Ok(prompt)) if started.elapsed() <= budget => prompt,
      outcome => {
        // Explicit preparation failure is not a user disconnect/Stop. Preserve
        // its failed outcome before returning a terminal error frame.
        if let Some(mut guard) = claimed_guard.take()
          && guard
            .finish(myoxus_application::copilot::CopilotStreamOutcome::Failed)
            .await
            .is_err()
        {
          warn!(%session_id, "could not save failed context preparation");
          return Ok(make_sse_error_response(
            "COPILOT_PROVIDER_SIDE_ERROR",
            "The failed response outcome could not be saved",
          ));
        }
        return Ok(if matches!(outcome, Ok(Err(_))) {
          make_sse_error_response(
            "COPILOT_SESSION_INVALID_INPUT",
            "Selected context is unavailable or exceeds the configured output limit",
          )
        } else {
          make_sse_error_response("COPILOT_PROVIDER_TIMEOUT", "Selected context preparation timed out")
        });
      }
    }
  };

  // A configured text-only route must fail before generation; the provider
  // registry independently enforces this for every fallback adapter.
  if !image_content.is_empty()
    && !providers.iter().any(|id| {
      state
        .config
        .copilot
        .providers
        .get(id)
        .and_then(|provider| provider.model_options.get(&model))
        .is_some_and(|options| options.supports_vision)
    })
  {
    if let Some(mut guard) = claimed_guard.take() {
      guard
        .finish(myoxus_application::copilot::CopilotStreamOutcome::Failed)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    return Ok(make_sse_error_response(
      "COPILOT_SESSION_INVALID_INPUT",
      "The selected model does not support image input",
    ));
  }

  // ── P101-RAG-01: Retrieve relevant document chunks for workspace context ──
  // The independent embedding transport/index may be unavailable without
  // blocking text or explicit context. Expose that outcome as metadata, not a
  // successful empty search or text injected into the model's final answer.
  let mut retrieval_available = None;
  let rag_context_block: Option<String> = 'rag: {
    if retrieval.search_workspace == Some(false) {
      break 'rag None;
    }
    retrieval_available = Some(false);
    let Some(workspace_id) = session.workspace_id else {
      debug!(%session_id, "RAG skipped: session has no workspace context");
      break 'rag None;
    };
    let Some(embedding_repo) = state.copilot_embedding_repo() else {
      debug!(%session_id, "RAG skipped: no embedding repo available");
      break 'rag None;
    };
    match embedding_repo
      .workspace_index_status(
        workspace_id,
        &state.config.copilot.embedding.model,
        state.config.copilot.embedding.dimensions,
      )
      .await
    {
      Ok(index) if index.embedded > 0 => {}
      _ => break 'rag None,
    }
    // Extract the last user message text as the query.
    let query_text = messages
      .iter()
      .rev()
      .find(|m| m.role == CopilotMessageRole::User)
      .and_then(|m| {
        m.content
          .get("text")
          .and_then(|v| v.as_str())
          .or_else(|| m.content.as_str())
          .map(|s| s.to_string())
      });
    let Some(query_text) = query_text else {
      debug!(%session_id, "RAG skipped: no user message found in history");
      break 'rag None;
    };
    // Embed the query with a 3-second timeout so a slow embedding API does not
    // delay the chat response.
    let embedding_model = state.config.copilot.embedding.model.clone();
    let embed_result = tokio::time::timeout(
      std::time::Duration::from_secs(3),
      state.embed_copilot_query(&query_text),
    )
    .await;
    let query_vector = match embed_result {
      Ok(Ok(vector)) => vector,
      Ok(Err(e)) => {
        debug!(%session_id, error = %e, "RAG skipped: embedding provider error");
        break 'rag None;
      }
      Err(_) => {
        debug!(%session_id, "RAG skipped: embedding call timed out");
        break 'rag None;
      }
    };
    // Retrieve similar chunks (top-5) and respect a 2000-token budget.
    let search_result = embedding_repo
      .similarity_search(workspace_id, &query_vector, 5, &embedding_model, &explicit_docs)
      .await;
    match search_result {
      Ok(matches) if !matches.is_empty() => {
        retrieval_available = Some(true);
        let ignored = match copilot.get_workspace_state(workspace_id).await {
          Ok(state) => state.map(|state| state.ignored_doc_ids).unwrap_or_default(),
          Err(_) => {
            return Ok(make_sse_error_response(
              "COPILOT_PROVIDER_SIDE_ERROR",
              "Workspace search policy unavailable",
            ));
          }
        };
        let mut allowed = Vec::with_capacity(matches.len());
        for candidate in matches {
          if candidate.embedding.workspace_id != workspace_id
            || candidate.embedding.source_type != myoxus_domain::entities::CopilotEmbeddingSourceType::Doc
          {
            continue;
          }
          // Productive index sources carry internal document UUIDs, not client
          // keys. Resolving them as external keys drops documents whose IDs differ.
          let id = match Uuid::parse_str(&candidate.embedding.source_id) {
            Ok(id) => id,
            Err(_) => continue,
          };
          if ignored.contains(&id) || (!explicit_docs.is_empty() && !explicit_docs.contains(&id)) {
            continue;
          }
          match crate::graphql::auth::can_read_copilot_doc(&state, user_id, workspace_id, id).await {
            Ok(true) => allowed.push(candidate),
            Ok(false) => {}
            Err(_) => {
              return Ok(make_sse_error_response(
                "COPILOT_PROVIDER_SIDE_ERROR",
                "Workspace search authorization unavailable",
              ));
            }
          }
        }
        let window = build_context_window(&allowed, 2000);
        if window.is_empty() {
          break 'rag None;
        }
        debug!(
          %session_id,
          %workspace_id,
          retrieved = allowed.len(),
          in_window = window.len(),
          "RAG: context chunks retrieved"
        );
        let mut block = String::from("Relevant workspace context (use this to inform your response):\n\n");
        for m in &window {
          block.push_str(&m.embedding.chunk_text);
          block.push_str("\n\n---\n\n");
        }
        Some(block)
      }
      Ok(_) => {
        retrieval_available = Some(true);
        debug!(%session_id, %workspace_id, "RAG: no matching chunks found");
        None
      }
      Err(e) => {
        debug!(%session_id, %workspace_id, error = %e, "RAG: similarity search failed, proceeding without context");
        None
      }
    }
  };

  // ── Build LlmRequest ──────────────────────────────────────────────────

  let llm_messages = myoxus_application::copilot::context_prompt::assemble_chat_messages(
    &messages,
    selected_prompt,
    rag_context_block.as_deref(),
    image_content,
  );

  let llm_request = LlmRequest {
    reasoning: params.reasoning.map(Into::into),
    model: model.clone(),
    messages: llm_messages,
    temperature: Some(0.7),
    max_tokens: None,
    // Configuration alone is not a tool continuation loop. Native chat must not
    // advertise Exa/MCP execution until the application owns that capability.
    tools: Vec::new(),
    metadata: json!({}),
  };

  // ── Start a message stream handle for persistence ──────────────────────
  let stream_guard = if let Some(guard) = claimed_guard {
    guard
  } else {
    let stream_handle = match copilot.start_message_stream(session_id).await {
      Ok(h) => h,
      Err(e) => {
        error!(%session_id, error = %e, "failed to start copilot message stream");
        return Ok(make_sse_error_response(
          "COPILOT_PROVIDER_SIDE_ERROR",
          &format!("Failed to start message stream: {e}"),
        ));
      }
    };
    myoxus_application::copilot::CopilotStreamGuard::new(copilot.as_ref().clone(), stream_handle)
  };

  // ── Build SSE response stream ─────────────────────────────────────────
  let copilot_for_stream = copilot.clone();
  let stream_id = stream_guard.stream_id();
  let session_id_for_stream = session_id;
  // Construct outside the generator so an unpolled/dropped body also owns cleanup.
  let registry = state.llm_provider_registry().clone();
  let request_timeout_ms = state.config.copilot.request_timeout_ms;

  let sse_stream = async_stream::stream! {
    let mut guard = stream_guard;
    // Flush headers/body before provider prefill. KeepAlive can now run while
    // opening the upstream stream; dropping this body cancels that wait too.
    yield Ok::<_, std::convert::Infallible>(SseEvent::default().comment("connected"));
    if let Some(available) = retrieval_available {
      yield Ok(SseEvent::default().event("retrieval-status").data(json!({"available":available}).to_string()));
    }
    let (provider_id, token_stream) = match registry.stream_with_fallback(&llm_request, &default_provider, &fallback_chain).await {
      Ok(result) => result,
      Err(mut error) => {
        if let Err(storage_error) = guard.finish(myoxus_application::copilot::CopilotStreamOutcome::Failed).await {
          warn!(%stream_id, error = %storage_error, "failed to persist provider startup failure");
          error = LlmProviderError::Upstream("Failed to save the response outcome".into());
        }
        let legacy = map_provider_error_to_legacy(&error, request_timeout_ms);
        yield Ok(SseEvent::default().event("error").data(json!({"type":"error","code":legacy.code,"message":legacy.message}).to_string()));
        return;
      }
    };
    info!(%session_id, %provider_id, %model, "copilot SSE stream started");
    let mut chunk_count: u64 = 0;
    let mut failure = None;

    futures_util::pin_mut!(token_stream);

    loop {
      tokio::select! {
        biased;

        maybe_item = token_stream.next() => {
          let item = match maybe_item {
            Some(Ok(LlmStreamEvent::Finish(reason))) => match reason.require_complete() {
              Ok(()) => break,
              Err(error) => Err(error),
            },
            Some(item) => item,
            None => Err(LlmProviderError::Upstream("provider stream ended without a completion event".into())),
          };
          match item {
            Ok(LlmStreamEvent::Text(token)) => {
              chunk_count += 1;

              // Persist before publication; never acknowledge output that failed storage.
              if let Err(e) = copilot_for_stream
                .append_stream_chunk(stream_id, token.clone())
                .await
              {
                warn!(%stream_id, error = %e, "failed to persist stream chunk");
                failure = Some(LlmProviderError::Upstream("Failed to save generated output".into()));
                break;
              }

              // The chat renderer parses StreamObjectSchema inside the SSE
              // message event. Other object shapes become literal chat text.
              let event_data = json!({
                "type": "text-delta",
                "textDelta": token,
              });
              let event: Result<SseEvent, std::convert::Infallible> = Ok(SseEvent::default()
                .event("message")
                .data(event_data.to_string()));
              yield event;
            }
            Ok(LlmStreamEvent::Reasoning(text)) => {
              if let Err(e) = copilot_for_stream.append_stream_reasoning(stream_id, text.clone()).await {
                warn!(%stream_id, error = %e, "failed to persist reasoning");
                failure = Some(LlmProviderError::Upstream("Failed to save generated output".into()));
                break;
              }
              let event: Result<SseEvent, std::convert::Infallible> = Ok(SseEvent::default()
                .event("message")
                .data(json!({"type":"reasoning","textDelta":text}).to_string()));
              yield event;
            }
            Ok(LlmStreamEvent::Finish(_)) => unreachable!("finish events are handled above"),
            Err(e) => {
              failure = Some(e);
              break;
            }
          }
        }
      }
    }

    // ── Finalize ───────────────────────────────────────────────────────
    let outcome = if failure.is_some() { myoxus_application::copilot::CopilotStreamOutcome::Failed }
      else { myoxus_application::copilot::CopilotStreamOutcome::Completed };
    if let Err(e) = guard.finish(outcome).await {
      warn!(
        %stream_id,
        error = %e,
        "failed to finalize copilot stream"
      );
      failure = Some(LlmProviderError::Upstream("Failed to save the response outcome".into()));
    }

    debug!(
      session_id = %session_id_for_stream,
      %stream_id,
      chunk_count,
      succeeded = failure.is_none(),
      "copilot SSE stream terminated"
    );

    if let Some(error) = failure {
      let legacy = map_provider_error_to_legacy(&error, request_timeout_ms);
      let event: Result<SseEvent, std::convert::Infallible> = Ok(SseEvent::default().event("error")
        .data(json!({"type":"error","code":legacy.code,"message":legacy.message}).to_string()));
      yield event;
      return;
    }
    let done_data = json!({ "type": "done" });
    let event: Result<SseEvent, std::convert::Infallible> = Ok(SseEvent::default()
      .event("done")
      .data(done_data.to_string()));
    yield event;
  };

  Ok(
    Sse::new(sse_stream)
      .keep_alive(
        axum::response::sse::KeepAlive::new()
          .interval(std::time::Duration::from_secs(15))
          .text("keepalive"),
      )
      .into_response(),
  )
}

/// Build an SSE error response as a one-shot body (no streaming needed).
///
/// Returns a complete `text/event-stream` response with a single `error` event.
fn replay_copilot_response(
  copilot: std::sync::Arc<myoxus_application::copilot::CopilotService>,
  mut message: myoxus_domain::entities::CopilotMessage,
) -> axum::response::Response {
  let stream_id = message
    .token_usage
    .as_ref()
    .and_then(|v| v["streamId"].as_str())
    .and_then(|v| Uuid::parse_str(v).ok());
  let deadline = message
    .token_usage
    .as_ref()
    .and_then(|v| v["requestDeadline"].as_str())
    .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok());
  let stream = async_stream::stream! {
    yield Ok::<_,std::convert::Infallible>(SseEvent::default().comment("connected"));
    // A replay owns only its readback, never another caller's generation guard.
    loop {
      let usage=message.token_usage.as_ref();
      if usage.and_then(|v|v["streamId"].as_str()).and_then(|v|Uuid::parse_str(v).ok())!=stream_id {
        yield Ok(SseEvent::default().event("error").data(json!({"code":"COPILOT_SESSION_INVALID_INPUT","message":"This generation was replaced; reload the conversation"}).to_string()));return;
      }
      if usage.is_none_or(|v|v["streamStatus"]!="running") {break;}
      if deadline.is_none_or(|deadline|deadline<=chrono::Utc::now()) {
        if let Some(stream_id)=stream_id {
          let handle=myoxus_application::copilot::CopilotStreamHandle {stream_id,message_id:message.id};
          if copilot.finalize_stream(&handle,myoxus_application::copilot::CopilotStreamOutcome::Failed).await.is_err() {
            warn!(%stream_id,"could not finalize expired copilot replay");
            yield Ok(SseEvent::default().event("error").data(json!({"code":"COPILOT_PROVIDER_SIDE_ERROR","message":"The expired response outcome could not be saved"}).to_string()));return;
          }
        }
        yield Ok(SseEvent::default().event("error").data(json!({"code":"COPILOT_PROVIDER_TIMEOUT","message":"The existing generation's request deadline expired"}).to_string()));return;
      }
      tokio::time::sleep(std::time::Duration::from_millis(250)).await;
      match copilot.get_message(message.id).await {
        Ok(current)=>message=current,
        Err(_)=>{yield Ok(SseEvent::default().event("error").data(json!({"code":"COPILOT_PROVIDER_SIDE_ERROR","message":"The existing response is unavailable"}).to_string()));return;}
      }
    }
    if let Some(objects)=message.content["streamObjects"].as_array() {
      for object in objects {yield Ok(SseEvent::default().event("message").data(object.to_string()));}
    }
    if message.token_usage.as_ref().is_some_and(|v|v["streamStatus"]=="done") {
      yield Ok(SseEvent::default().event("done").data(json!({"type":"done"}).to_string()));
    }else{
      yield Ok(SseEvent::default().event("error").data(json!({"code":"COPILOT_PROVIDER_SIDE_ERROR","message":"The existing generation did not complete; start an explicit retry"}).to_string()));
    }
  };
  Sse::new(stream)
    .keep_alive(axum::response::sse::KeepAlive::new().interval(std::time::Duration::from_secs(15)))
    .into_response()
}

fn make_sse_error_response(code: &str, message: &str) -> axum::response::Response {
  let payload = json!({
    "type": "error",
    "code": code,
    "message": message,
  });
  let body = format!("event: error\ndata: {}\n\n", payload);

  (
    [
      (axum::http::header::CONTENT_TYPE, "text/event-stream"),
      (axum::http::header::CACHE_CONTROL, "no-cache"),
      (axum::http::header::CONNECTION, "keep-alive"),
    ],
    body,
  )
    .into_response()
}

/// `GET /api/copilot/blob/{user_id}/{workspace_id}/{key}` — serve a private Copilot blob.
///
/// Constructs the storage key as `{user_id}/{workspace_id}/{key}` and reads
/// the blob from the configured object storage backend.
/// Only the current owner with workspace blob-read authority may download.
/// Private output is never retained in shared caches; public shares use their
/// separate delivery route.
#[instrument(skip_all)]
pub(crate) async fn copilot_blob_handler(
  State(state): State<ApiState>,
  Path((user_id, workspace_id, key)): Path<(String, String, String)>,
  headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let parsed_user = Uuid::parse_str(&user_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let parsed_workspace = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let normalized_key = myoxus_application::ports::blob::BlobKey::parse(&key).map_err(|_| StatusCode::BAD_REQUEST)?;
  let cookies = crate::graphql::utils::parse_cookies(&headers);
  let session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
    .ok_or(StatusCode::UNAUTHORIZED)?;
  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .ok_or(StatusCode::UNAUTHORIZED)?;
  if snapshot.user.id != parsed_user {
    return Err(StatusCode::FORBIDDEN);
  }
  use myoxus_application::permission::AccessController;
  state
    .permission_service()
    .assert(
      &myoxus_application::permission::WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: parsed_workspace,
      },
      myoxus_domain::permission::WorkspaceAction::BlobsRead,
    )
    .await
    .map_err(|_| StatusCode::FORBIDDEN)?;

  let storage_key = format!("{parsed_user}/{parsed_workspace}/{}", normalized_key.as_str());
  let blob = state
    .storage()
    .read_blob(&storage_key)
    .await
    .map_err(|_| StatusCode::NOT_FOUND)?;
  let content_type = blob
    .content_type
    .clone()
    .unwrap_or_else(|| "application/octet-stream".to_string());
  let mut response = blob.data.to_vec().into_response();
  response.headers_mut().insert(
    axum::http::header::CONTENT_TYPE,
    content_type.parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  let filename = normalized_key
    .as_str()
    .rsplit('/')
    .next()
    .unwrap_or("download")
    .replace(['"', '\r', '\n'], "_");
  crate::handlers::blob::secure_download_headers(response.headers_mut(), &content_type, &filename)?;
  response.headers_mut().insert(
    axum::http::header::CACHE_CONTROL,
    "private, no-store"
      .parse()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  response
    .headers_mut()
    .insert(axum::http::header::VARY, axum::http::HeaderValue::from_static("Cookie"));
  Ok(response)
}

/// `GET /api/unsplash/photos` — proxy photo search to the Unsplash API.
///
/// Forwards the query parameters to `https://api.unsplash.com/search/photos`
/// using the configured Unsplash client ID.  Passes through `X-RateLimit-*`
/// headers so the frontend can display rate-limit state.
///
/// When no Unsplash API key is configured, returns an empty result set
/// immediately without making a network request.
#[instrument(skip_all)]
pub(crate) async fn copilot_unsplash_photos_handler(
  State(state): State<ApiState>,
  Query(params): Query<CopilotUnsplashQuery>,
) -> Result<axum::response::Response, StatusCode> {
  let Some(key) = state.config.copilot.unsplash.key.as_deref() else {
    return Ok(
      (
        StatusCode::OK,
        Json(UnsplashEmptyResponse {
          total: 0,
          total_pages: 0,
          results: Vec::new(),
        }),
      )
        .into_response(),
    );
  };

  let mut url =
    reqwest::Url::parse("https://api.unsplash.com/search/photos").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  {
    let mut q = url.query_pairs_mut();
    if let Some(value) = params.query.as_deref() {
      q.append_pair("query", value);
    }
    if let Some(value) = params.page {
      q.append_pair("page", &value.to_string());
    }
    if let Some(value) = params.per_page {
      q.append_pair("per_page", &value.to_string());
    }
    if let Some(value) = params.orientation.as_deref() {
      q.append_pair("orientation", value);
    }
    if let Some(value) = params.order_by.as_deref() {
      q.append_pair("order_by", value);
    }
    if let Some(value) = params.color.as_deref() {
      q.append_pair("color", value);
    }
  }

  // P84-D-01: Use the shared HTTP client from ApiState instead of creating
  // a new reqwest::Client per request.  The shared client's default timeout
  // is configured at startup; per-request timeout is set via the request.
  let timeout = std::time::Duration::from_secs(state.config.http.proxy_timeout_seconds);
  let response = state
    .http_client()
    .get(url)
    .timeout(timeout)
    .header(reqwest::header::AUTHORIZATION, format!("Client-ID {key}"))
    .send()
    .await
    .map_err(|_| StatusCode::BAD_GATEWAY)?;
  let status = StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
  let content_type = response
    .headers()
    .get(reqwest::header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .unwrap_or("application/json")
    .to_string();
  let limit = response
    .headers()
    .get("x-ratelimit-limit")
    .and_then(|v| v.to_str().ok())
    .map(|v| v.to_string());
  let remaining = response
    .headers()
    .get("x-ratelimit-remaining")
    .and_then(|v| v.to_str().ok())
    .map(|v| v.to_string());
  let body = response.bytes().await.map_err(|_| StatusCode::BAD_GATEWAY)?;

  let mut out = axum::response::Response::new(axum::body::Body::from(body.to_vec()));
  *out.status_mut() = status;
  out.headers_mut().insert(
    axum::http::header::CONTENT_TYPE,
    content_type.parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  if let Some(limit) = limit {
    out.headers_mut().insert(
      "x-ratelimit-limit",
      limit.parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
  }
  if let Some(remaining) = remaining {
    out.headers_mut().insert(
      "x-ratelimit-remaining",
      remaining.parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
  }
  Ok(out)
}
