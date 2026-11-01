//! LLM provider abstraction: request/response types, a provider registry with
//! circuit-breaker and retry logic, and tool-call execution support.
//!
//! [`LlmProvider`] is the core port trait; [`LlmProviderRegistry`] wraps
//! multiple providers, adds per-provider circuit-breaker state, and routes
//! completions through a configurable fallback chain.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use async_trait::async_trait;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{debug, error, info, instrument, trace, warn};

/// The role of a participant in an LLM conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LlmRole {
  /// System instructions (invisible to the end user).
  System,
  /// Human turn.
  User,
  /// Model response.
  Assistant,
  /// Tool execution result.
  Tool,
}

/// A single message in an LLM conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmMessage {
  /// Role of the author.
  pub role: LlmRole,
  /// Text-only callers retain a string; image turns carry actual typed bytes.
  pub content: LlmContent,
  /// Optional participant name (used for multi-agent scenarios).
  pub name: Option<String>,
  /// Tool call ID this message is a response to (for `Tool` role messages).
  pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LlmContent {
  Text(String),
  Parts(Vec<LlmContentPart>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LlmContentPart {
  Text {
    text: String,
  },
  /// Only server-materialized bytes, never a client URL for the provider to fetch.
  Image {
    mime_type: String,
    bytes: Vec<u8>,
  },
}

impl From<String> for LlmContent {
  fn from(text: String) -> Self {
    Self::Text(text)
  }
}

impl From<&str> for LlmContent {
  fn from(text: &str) -> Self {
    Self::Text(text.into())
  }
}

impl LlmContent {
  pub fn as_text(&self) -> Option<&str> {
    match self {
      Self::Text(text) => Some(text),
      Self::Parts(_) => None,
    }
  }

  pub fn has_images(&self) -> bool {
    matches!(self, Self::Parts(parts) if parts.iter().any(|part| matches!(part,LlmContentPart::Image{..})))
  }
}

/// Description of a tool that the model may call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmToolDefinition {
  /// Unique tool name.
  pub name: String,
  /// Human-readable description passed to the model.
  pub description: Option<String>,
  /// JSON Schema describing the expected argument object.
  pub input_schema: Value,
}

/// A tool invocation requested by the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmToolCall {
  /// Opaque identifier used to correlate the call with its result message.
  pub id: String,
  /// Name of the tool to invoke.
  pub name: String,
  /// Arguments as a JSON object matching the tool's `input_schema`.
  pub arguments: Value,
}

/// Token usage statistics returned by the provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmUsage {
  /// Tokens consumed by the prompt (input).
  pub prompt_tokens: i32,
  /// Tokens generated in the completion (output).
  pub completion_tokens: i32,
  /// Total tokens (`prompt_tokens + completion_tokens`).
  pub total_tokens: i32,
}

/// A completion request sent to an LLM provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmRequest {
  /// Model identifier (provider-specific, e.g. `"gpt-4o"`).
  pub model: String,
  /// None preserves provider defaults. Fallback must translate the same explicit
  /// intent with its own model control or reject it, never silently omit it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub reasoning: Option<myoxus_contracts::copilot::ReasoningMode>,
  /// Ordered list of conversation messages.
  pub messages: Vec<LlmMessage>,
  /// Sampling temperature (0.0–2.0); `None` defers to provider default.
  pub temperature: Option<f32>,
  /// Maximum tokens to generate; `None` defers to provider default.
  pub max_tokens: Option<i32>,
  /// Tool definitions made available to the model.
  pub tools: Vec<LlmToolDefinition>,
  /// Arbitrary provider-specific metadata (e.g. user tags).
  pub metadata: Value,
}

/// The completion response returned by an LLM provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmResponse {
  /// Model that produced the response.
  pub model: String,
  /// Concatenated text output from the model.
  pub output_text: String,
  /// Provider-exposed reasoning, separate from final answer text; never invented.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub reasoning: Option<String>,
  /// Reason the model stopped generating (e.g. `"stop"`, `"tool_calls"`).
  pub finish_reason: Option<String>,
  /// Tool calls requested by the model in this turn.
  pub tool_calls: Vec<LlmToolCall>,
  /// Token usage stats, if reported by the provider.
  pub usage: Option<LlmUsage>,
  /// Raw provider payload for caller-owned structured extraction. Never log it.
  pub raw_payload: Value,
}

/// Basic model metadata returned by a provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmModelInfo {
  /// Provider-scoped model ID.
  pub id: String,
  /// Provider name (e.g. `"openai"`).
  pub provider: String,
  /// Human-readable model name.
  pub display_name: Option<String>,
  /// Whether this model supports tool/function calling.
  pub supports_tools: bool,
}

pub use crate::ports::provider_error::ProviderError as LlmProviderError;

/// A legacy error shape used by the existing GraphQL copilot API contract.
///
/// Maps [`LlmProviderError`] variants to the string codes expected by the
/// original TypeScript frontend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LegacyCopilotError {
  /// Legacy error code string (e.g. `"NO_COPILOT_PROVIDER_AVAILABLE"`).
  pub code: String,
  /// Human-readable error description.
  pub message: String,
  /// Whether the client should retry the request.
  pub retryable: bool,
  /// Suggested retry delay in milliseconds.
  pub timeout_ms: u64,
}

/// Map an [`LlmProviderError`] to the [`LegacyCopilotError`] shape expected
/// by the existing client contract.
pub fn map_provider_error_to_legacy(err: &LlmProviderError, default_timeout_ms: u64) -> LegacyCopilotError {
  match err {
    LlmProviderError::InvalidRequest(message) => LegacyCopilotError {
      code: "COPILOT_SESSION_INVALID_INPUT".to_string(),
      message: message.clone(),
      retryable: false,
      timeout_ms: 0,
    },
    LlmProviderError::Unavailable(message) => LegacyCopilotError {
      code: "NO_COPILOT_PROVIDER_AVAILABLE".to_string(),
      message: message.clone(),
      retryable: true,
      timeout_ms: default_timeout_ms,
    },
    LlmProviderError::RateLimited(message) => LegacyCopilotError {
      code: "COPILOT_PROVIDER_SIDE_ERROR".to_string(),
      message: message.clone(),
      retryable: true,
      timeout_ms: default_timeout_ms,
    },
    LlmProviderError::Timeout(message) => LegacyCopilotError {
      code: "COPILOT_PROVIDER_TIMEOUT".to_string(),
      message: message.clone(),
      retryable: true,
      timeout_ms: default_timeout_ms,
    },
    LlmProviderError::ContextLimit => LegacyCopilotError {
      code: "COPILOT_CONTEXT_LIMIT".into(),
      message: err.to_string(),
      retryable: false,
      timeout_ms: 0,
    },
    LlmProviderError::OutputTruncated => LegacyCopilotError {
      code: "COPILOT_OUTPUT_TRUNCATED".into(),
      message: err.to_string(),
      retryable: false,
      timeout_ms: 0,
    },
    LlmProviderError::Upstream(message) => LegacyCopilotError {
      code: "COPILOT_PROVIDER_SIDE_ERROR".to_string(),
      message: message.clone(),
      retryable: false,
      timeout_ms: default_timeout_ms,
    },
  }
}

/// Response from an embedding request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingResponse {
  /// One embedding vector per input text.
  pub embeddings: Vec<Vec<f32>>,
  /// Model that produced the embeddings.
  pub model: String,
  /// Token usage stats, if reported by the provider.
  pub usage: Option<EmbeddingUsage>,
}

/// Token usage for an embedding request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingUsage {
  /// Tokens consumed by the input texts.
  pub prompt_tokens: i32,
  /// Total tokens (usually equal to prompt_tokens for embeddings).
  pub total_tokens: i32,
}

/// Normalized completion outcome shared by streaming providers and consumers.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LlmFinishReason {
  Stop,
  Length,
  ContentFilter,
  ToolCalls,
}

impl LlmFinishReason {
  pub fn parse(reason: &str) -> Result<Self, LlmProviderError> {
    match reason.trim().to_ascii_lowercase().as_str() {
      "stop" => Ok(Self::Stop),
      "length" => Ok(Self::Length),
      "content_filter" => Ok(Self::ContentFilter),
      "tool_calls" | "function_call" => Ok(Self::ToolCalls),
      _ => Err(LlmProviderError::Upstream(
        "provider returned an unsupported finish reason".into(),
      )),
    }
  }

  /// Until chat has a tool continuation owner, non-stop outcomes cannot become
  /// successful empty replies. Transport callers map these bounded errors.
  pub fn require_complete(self) -> Result<(), LlmProviderError> {
    match self {
      Self::Stop => Ok(()),
      Self::Length => Err(LlmProviderError::OutputTruncated),
      Self::ContentFilter => Err(LlmProviderError::Upstream(
        "provider output was blocked by its content filter".into(),
      )),
      Self::ToolCalls => Err(LlmProviderError::Unavailable(
        "provider requested unavailable chat tool execution".into(),
      )),
    }
  }
}

/// Provider output preserves reasoning and final text as distinct ordered deltas.
/// Finish is emitted once after a valid provider terminal, never inferred by the
/// consumer from socket EOF.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmStreamEvent {
  Text(String),
  Reasoning(String),
  Finish(LlmFinishReason),
}

pub type LlmStreamItem = Result<LlmStreamEvent, LlmProviderError>;

/// A boxed, `Send`-safe stream of normalized provider events.
pub type LlmTokenStream = Pin<Box<dyn Stream<Item = LlmStreamItem> + Send>>;

/// Port for sending completion requests to an LLM backend.
#[async_trait]
pub trait LlmProvider: Send + Sync {
  /// Every adapter must explicitly preserve image input before it is eligible
  /// for a multimodal fallback attempt. Text-only defaults fail closed.
  fn supports_vision(&self, _model: &str) -> bool {
    false
  }
  /// A unique identifier for this provider (e.g. `"openai"`).
  fn provider_id(&self) -> &str;
  /// Return the list of models this provider supports.
  async fn list_models(&self) -> Result<Vec<LlmModelInfo>, LlmProviderError>;
  /// Send a completion request and return the response.
  async fn complete(&self, request: &LlmRequest) -> Result<LlmResponse, LlmProviderError>;

  /// Send a streaming completion request with an explicit normalized terminal.
  ///
  /// The default implementation falls back to [`complete`](Self::complete)
  /// and emits its optional reasoning, final text and completion outcome.
  async fn stream_chat(&self, request: &LlmRequest) -> Result<LlmTokenStream, LlmProviderError> {
    let response = self.complete(request).await?;
    let finish = if response.tool_calls.is_empty() {
      response
        .finish_reason
        .as_deref()
        .map(LlmFinishReason::parse)
        .transpose()?
        .unwrap_or(LlmFinishReason::Stop)
    } else {
      LlmFinishReason::ToolCalls
    };
    let mut events = Vec::new();
    if let Some(reasoning) = response.reasoning.filter(|value| !value.is_empty()) {
      events.push(Ok(LlmStreamEvent::Reasoning(reasoning)));
    }
    if !response.output_text.is_empty() {
      events.push(Ok(LlmStreamEvent::Text(response.output_text)));
    }
    events.push(Ok(LlmStreamEvent::Finish(finish)));
    Ok(Box::pin(futures_util::stream::iter(events)))
  }

  /// Compute embeddings for a batch of text inputs.
  ///
  /// Returns one vector per input text.  The default implementation returns
  /// [`LlmProviderError::Unavailable`] — providers that support embeddings
  /// must override this method.
  async fn embed(&self, _texts: &[String], _model: &str) -> Result<EmbeddingResponse, LlmProviderError> {
    Err(LlmProviderError::Unavailable(
      "embedding not supported by this provider".to_string(),
    ))
  }

  /// Query and document encoders may differ even for the same model/dimension.
  /// Providers without a task-specific protocol retain their existing behavior.
  async fn embed_for_purpose(
    &self,
    texts: &[String],
    model: &str,
    _purpose: EmbeddingPurpose,
  ) -> Result<EmbeddingResponse, LlmProviderError> {
    self.embed(texts, model).await
  }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddingPurpose {
  Document,
  Query,
}

/// Port for executing tool calls produced by an LLM.
#[async_trait]
pub trait LlmToolExecutor: Send + Sync {
  /// Execute a named tool with the given arguments.  Returns a JSON value
  /// result or an error message string.
  async fn execute(&self, tool_name: &str, arguments: &Value) -> Result<Value, String>;
}

/// Normalise a legacy-shaped tool call JSON object (using `toolCallId` /
/// `toolName` / `args` field names) to an [`LlmToolCall`].
pub fn normalize_legacy_tool_call(raw: &Value) -> Result<LlmToolCall, LlmProviderError> {
  let id = raw
    .get("id")
    .and_then(|value| value.as_str())
    .or_else(|| raw.get("toolCallId").and_then(|value| value.as_str()))
    .ok_or_else(|| LlmProviderError::InvalidRequest("tool call id missing".to_string()))?;
  let name = raw
    .get("name")
    .and_then(|value| value.as_str())
    .or_else(|| raw.get("toolName").and_then(|value| value.as_str()))
    .ok_or_else(|| LlmProviderError::InvalidRequest("tool call name missing".to_string()))?;

  let arguments = raw
    .get("arguments")
    .cloned()
    .or_else(|| raw.get("args").cloned())
    .unwrap_or_else(|| serde_json::json!({}));
  Ok(LlmToolCall {
    id: id.to_string(),
    name: name.to_string(),
    arguments,
  })
}

/// Execute a batch of tool calls via `executor` and return one `Tool`-role
/// message per call.  Errors are serialised as JSON `{"error": "..."}` so
/// the model can observe them.
#[instrument(skip(executor, tool_calls))]
pub async fn execute_tool_calls(executor: &dyn LlmToolExecutor, tool_calls: &[LlmToolCall]) -> Vec<LlmMessage> {
  let mut outputs = Vec::with_capacity(tool_calls.len());
  for call in tool_calls {
    match executor.execute(&call.name, &call.arguments).await {
      Ok(result) => {
        outputs.push(LlmMessage {
          role: LlmRole::Tool,
          content: result.to_string().into(),
          name: Some(call.name.clone()),
          tool_call_id: Some(call.id.clone()),
        });
      }
      Err(err) => {
        outputs.push(LlmMessage {
          role: LlmRole::Tool,
          content: serde_json::json!({ "error": err }).to_string().into(),
          name: Some(call.name.clone()),
          tool_call_id: Some(call.id.clone()),
        });
      }
    }
  }
  outputs
}

/// A registry of named LLM providers with per-provider circuit-breaker state.
///
/// Providers are registered by ID.  `complete_with_fallback` routes a request
/// through the primary provider then through the fallback chain in order,
/// skipping providers whose circuit is open.  Consecutive failures above the
/// breaker threshold open the circuit for `breaker_cooldown`.
#[derive(Default, Clone)]
pub struct LlmProviderRegistry {
  /// Registered providers keyed by their `provider_id`.
  providers: HashMap<String, Arc<dyn LlmProvider>>,
  /// Per-provider circuit-breaker state.
  circuit: Arc<RwLock<HashMap<String, CircuitState>>>,
}

/// Per-provider circuit-breaker state.
#[derive(Debug, Clone, Default)]
struct CircuitState {
  /// Number of consecutive failures since the last success.
  consecutive_failures: u32,
  /// If set, the circuit is open and no calls should be sent until this
  /// instant.
  open_until: Option<Instant>,
}

impl LlmProviderRegistry {
  /// Create an empty registry.
  pub fn new() -> Self {
    Self::default()
  }

  /// Register a provider.  An existing registration for the same ID is
  /// replaced.
  pub fn register(&mut self, provider: Arc<dyn LlmProvider>) {
    self.providers.insert(provider.provider_id().to_string(), provider);
  }

  /// Return the IDs of all registered providers, sorted alphabetically.
  pub fn provider_ids(&self) -> Vec<String> {
    let mut ids = self.providers.keys().cloned().collect::<Vec<_>>();
    ids.sort();
    ids
  }

  /// Complete a request using the primary provider with one retry, falling
  /// back through `fallback_chain` if the primary fails.
  ///
  /// Returns `(provider_id, response)` so the caller knows which provider
  /// served the request.
  #[instrument(skip(self, request))]
  pub async fn complete_with_fallback(
    &self,
    request: &LlmRequest,
    primary_provider: &str,
    fallback_chain: &[String],
  ) -> Result<(String, LlmResponse), LlmProviderError> {
    self
      .complete_with_resilience(request, primary_provider, fallback_chain, 1, 3, Duration::from_secs(10))
      .await
  }

  /// Complete a request with full resilience controls.
  ///
  /// - `max_retries_per_provider`: additional attempts on the same provider
  ///   before moving to the next.
  /// - `breaker_threshold`: consecutive failures before the circuit opens.
  /// - `breaker_cooldown`: how long the circuit stays open.
  ///
  /// Returns `(provider_id, response)` on success, or the last error if all
  /// providers and retries are exhausted.
  #[instrument(skip(self, request))]
  pub async fn complete_with_resilience(
    &self,
    request: &LlmRequest,
    primary_provider: &str,
    fallback_chain: &[String],
    max_retries_per_provider: u8,
    breaker_threshold: u32,
    breaker_cooldown: Duration,
  ) -> Result<(String, LlmResponse), LlmProviderError> {
    let mut order = Vec::with_capacity(1 + fallback_chain.len());
    order.push(primary_provider.to_string());
    for provider in fallback_chain {
      if provider != primary_provider {
        order.push(provider.clone());
      }
    }

    trace!(model = %request.model, providers = ?order, "llm completion requested");
    let mut last_err: Option<LlmProviderError> = None;

    for provider_id in order {
      let Some(provider) = self.providers.get(&provider_id) else {
        warn!(provider = %provider_id, "configured llm provider not registered");
        continue;
      };
      if request.messages.iter().any(|message| message.content.has_images())
        && !provider.supports_vision(&request.model)
      {
        last_err = Some(LlmProviderError::InvalidRequest(
          "selected model does not support image input".into(),
        ));
        continue;
      }
      let is_open = {
        let guard = self.circuit.read().await;
        guard
          .get(&provider_id)
          .and_then(|state| state.open_until)
          .map(|until| until > Instant::now())
          .unwrap_or(false)
      };
      if is_open {
        warn!(provider = %provider_id, "provider circuit is open, skipping");
        continue;
      }
      debug!(provider = %provider_id, model = %request.model, "trying llm provider");
      let mut attempts = 0u8;
      loop {
        attempts = attempts.saturating_add(1);
        match provider.complete(request).await {
          Ok(response) => {
            {
              let mut guard = self.circuit.write().await;
              if let Some(state) = guard.get_mut(&provider_id) {
                state.consecutive_failures = 0;
                state.open_until = None;
              }
            }
            info!(provider = %provider_id, model = %request.model, attempts, "llm completion succeeded");
            return Ok((provider_id, response));
          }
          Err(err) => {
            let mut circuit = self.circuit.write().await;
            let entry = circuit.entry(provider_id.clone()).or_default();
            entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);
            if entry.consecutive_failures >= breaker_threshold {
              entry.open_until = Some(Instant::now() + breaker_cooldown);
              warn!(provider = %provider_id, cooldown_secs = breaker_cooldown.as_secs(), "opening provider circuit");
            }
            warn!(
                provider = %provider_id,
                model = %request.model,
                attempts,
                "llm provider attempt failed"
            );
            last_err = Some(err);
            if attempts > max_retries_per_provider {
              break;
            }
          }
        }
      }
    }

    let error = last_err
      .unwrap_or_else(|| LlmProviderError::Unavailable("no registered provider available for completion".to_string()));
    error!(model = %request.model, "all llm providers failed");
    Err(error)
  }

  /// Start a streaming completion using the primary provider, falling back
  /// through the chain if the primary fails to start.
  ///
  /// Returns `(provider_id, token_stream)` on success.  Only the stream
  /// *initiation* is subject to fallback — once tokens start flowing, errors
  /// within the stream are surfaced as `Err` items in the stream itself.
  #[instrument(skip(self, request))]
  pub async fn stream_with_fallback(
    &self,
    request: &LlmRequest,
    primary_provider: &str,
    fallback_chain: &[String],
  ) -> Result<(String, LlmTokenStream), LlmProviderError> {
    let mut order = Vec::with_capacity(1 + fallback_chain.len());
    order.push(primary_provider.to_string());
    for provider in fallback_chain {
      if provider != primary_provider {
        order.push(provider.clone());
      }
    }

    trace!(model = %request.model, providers = ?order, "llm streaming requested");
    let mut last_err: Option<LlmProviderError> = None;

    for provider_id in order {
      let Some(provider) = self.providers.get(&provider_id) else {
        warn!(provider = %provider_id, "configured llm provider not registered");
        continue;
      };
      if request.messages.iter().any(|message| message.content.has_images())
        && !provider.supports_vision(&request.model)
      {
        last_err = Some(LlmProviderError::InvalidRequest(
          "selected model does not support image input".into(),
        ));
        continue;
      }
      let is_open = {
        let guard = self.circuit.read().await;
        guard
          .get(&provider_id)
          .and_then(|state| state.open_until)
          .map(|until| until > Instant::now())
          .unwrap_or(false)
      };
      if is_open {
        warn!(provider = %provider_id, "provider circuit is open, skipping");
        continue;
      }

      debug!(provider = %provider_id, model = %request.model, "trying llm provider for streaming");
      match provider.stream_chat(request).await {
        Ok(stream) => {
          info!(provider = %provider_id, model = %request.model, "llm streaming started");
          return Ok((provider_id, stream));
        }
        Err(err) => {
          warn!(
              provider = %provider_id,
              model = %request.model,
              error = %err,
              "llm provider stream start failed"
          );
          last_err = Some(err);
        }
      }
    }

    let error = last_err
      .unwrap_or_else(|| LlmProviderError::Unavailable("no registered provider available for streaming".to_string()));
    error!(model = %request.model, error = %error, "all llm providers failed for streaming");
    Err(error)
  }

  /// Compute embeddings using the primary provider with fallback through the
  /// chain if the primary fails.
  ///
  /// Returns `(provider_id, EmbeddingResponse)` on success.
  #[instrument(skip(self, texts))]
  pub async fn embed_with_fallback(
    &self,
    texts: &[String],
    model: &str,
    primary_provider: &str,
    fallback_chain: &[String],
  ) -> Result<(String, EmbeddingResponse), LlmProviderError> {
    let mut order = Vec::with_capacity(1 + fallback_chain.len());
    order.push(primary_provider.to_string());
    for provider in fallback_chain {
      if provider != primary_provider {
        order.push(provider.clone());
      }
    }

    trace!(%model, input_count = texts.len(), providers = ?order, "embedding requested");
    let mut last_err: Option<LlmProviderError> = None;

    for provider_id in order {
      let Some(provider) = self.providers.get(&provider_id) else {
        warn!(provider = %provider_id, "configured llm provider not registered");
        continue;
      };

      let is_open = {
        let guard = self.circuit.read().await;
        guard
          .get(&provider_id)
          .and_then(|state| state.open_until)
          .map(|until| until > Instant::now())
          .unwrap_or(false)
      };
      if is_open {
        warn!(provider = %provider_id, "provider circuit is open, skipping for embedding");
        continue;
      }

      debug!(provider = %provider_id, %model, input_count = texts.len(), "trying llm provider for embedding");
      match provider.embed(texts, model).await {
        Ok(response) => {
          {
            let mut guard = self.circuit.write().await;
            if let Some(state) = guard.get_mut(&provider_id) {
              state.consecutive_failures = 0;
              state.open_until = None;
            }
          }
          info!(
            provider = %provider_id,
            %model,
            vector_count = response.embeddings.len(),
            "embedding succeeded"
          );
          return Ok((provider_id, response));
        }
        Err(err) => {
          {
            let mut guard = self.circuit.write().await;
            let entry = guard.entry(provider_id.clone()).or_default();
            entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);
            if entry.consecutive_failures >= 3 {
              let cooldown = Duration::from_secs(10);
              entry.open_until = Some(Instant::now() + cooldown);
              warn!(
                provider = %provider_id,
                cooldown_secs = cooldown.as_secs(),
                "opening provider circuit after embedding failure"
              );
            }
          }
          warn!(
            provider = %provider_id,
            %model,
            error = %err,
            "llm provider embedding attempt failed"
          );
          last_err = Some(err);
        }
      }
    }

    let error = last_err
      .unwrap_or_else(|| LlmProviderError::Unavailable("no registered provider available for embedding".to_string()));
    error!(%model, error = %error, "all llm providers failed for embedding");
    Err(error)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use futures_util::StreamExt;
  use std::collections::HashMap;
  use std::sync::atomic::{AtomicUsize, Ordering};
  use std::sync::{Mutex, RwLock};

  struct StaticProvider {
    id: String,
    fail: bool,
    calls: AtomicUsize,
  }

  #[async_trait]
  impl LlmProvider for StaticProvider {
    fn provider_id(&self) -> &str {
      &self.id
    }

    async fn list_models(&self) -> Result<Vec<LlmModelInfo>, LlmProviderError> {
      Ok(vec![LlmModelInfo {
        id: "test-model".to_string(),
        provider: self.id.clone(),
        display_name: Some("Test".to_string()),
        supports_tools: true,
      }])
    }

    async fn complete(&self, request: &LlmRequest) -> Result<LlmResponse, LlmProviderError> {
      self.calls.fetch_add(1, Ordering::SeqCst);
      if self.fail {
        return Err(LlmProviderError::Unavailable(format!("{} down", self.id)));
      }
      Ok(LlmResponse {
        model: request.model.clone(),
        output_text: "ok".to_string(),
        reasoning: Some("provider reasoning".into()),
        finish_reason: Some("stop".to_string()),
        tool_calls: Vec::new(),
        usage: Some(LlmUsage {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        }),
        raw_payload: serde_json::json!({"provider": self.id}),
      })
    }
  }

  fn request() -> LlmRequest {
    LlmRequest {
      reasoning: None,
      model: "test-model".to_string(),
      messages: vec![LlmMessage {
        role: LlmRole::User,
        content: "hello".into(),
        name: None,
        tool_call_id: None,
      }],
      temperature: Some(0.2),
      max_tokens: Some(200),
      tools: Vec::new(),
      metadata: serde_json::json!({}),
    }
  }

  #[tokio::test]
  async fn provider_registry_uses_fallback_when_primary_fails() {
    let primary = Arc::new(StaticProvider {
      id: "openai".to_string(),
      fail: true,
      calls: AtomicUsize::new(0),
    });
    let fallback = Arc::new(StaticProvider {
      id: "local".to_string(),
      fail: false,
      calls: AtomicUsize::new(0),
    });

    let mut registry = LlmProviderRegistry::new();
    registry.register(primary.clone());
    registry.register(fallback.clone());

    let (provider_id, response) = registry
      .complete_with_fallback(&request(), "openai", &["local".to_string()])
      .await
      .expect("completion should succeed on fallback");
    assert_eq!(provider_id, "local");
    assert_eq!(response.output_text, "ok");
    assert_eq!(primary.calls.load(Ordering::SeqCst), 2);
    assert_eq!(fallback.calls.load(Ordering::SeqCst), 1);
    let (_, stream) = registry.stream_with_fallback(&request(), "local", &[]).await.unwrap();
    assert_eq!(
      stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .unwrap(),
      vec![
        LlmStreamEvent::Reasoning("provider reasoning".into()),
        LlmStreamEvent::Text("ok".into()),
        LlmStreamEvent::Finish(LlmFinishReason::Stop),
      ]
    );
    let mut image_request = request();
    image_request.messages[0].content = LlmContent::Parts(vec![LlmContentPart::Image {
      mime_type: "image/png".into(),
      bytes: vec![1, 2, 3],
    }]);
    let counts = (
      primary.calls.load(Ordering::SeqCst),
      fallback.calls.load(Ordering::SeqCst),
    );
    assert!(matches!(
      registry
        .complete_with_fallback(&image_request, "openai", &["local".into()])
        .await,
      Err(LlmProviderError::InvalidRequest(_))
    ));
    assert!(matches!(
      registry
        .stream_with_fallback(&image_request, "openai", &["local".into()])
        .await,
      Err(LlmProviderError::InvalidRequest(_))
    ));
    assert_eq!(
      (
        primary.calls.load(Ordering::SeqCst),
        fallback.calls.load(Ordering::SeqCst)
      ),
      counts,
      "fallback must not send an image turn to text-only adapters"
    );
  }

  #[tokio::test]
  async fn provider_registry_returns_error_when_all_providers_fail() {
    let a = Arc::new(StaticProvider {
      id: "openai".to_string(),
      fail: true,
      calls: AtomicUsize::new(0),
    });
    let b = Arc::new(StaticProvider {
      id: "custom".to_string(),
      fail: true,
      calls: AtomicUsize::new(0),
    });
    let mut registry = LlmProviderRegistry::new();
    registry.register(a);
    registry.register(b);

    let result = registry
      .complete_with_fallback(&request(), "openai", &["custom".to_string()])
      .await;
    assert!(result.is_err());
  }

  struct StaticToolExecutor {
    outputs: RwLock<HashMap<String, Value>>,
  }

  #[async_trait]
  impl LlmToolExecutor for StaticToolExecutor {
    async fn execute(&self, tool_name: &str, _arguments: &Value) -> Result<Value, String> {
      self
        .outputs
        .read()
        .expect("tool outputs lock poisoned")
        .get(tool_name)
        .cloned()
        .ok_or_else(|| format!("tool not found: {tool_name}"))
    }
  }

  #[test]
  fn normalize_legacy_tool_call_accepts_legacy_shape() {
    let raw = serde_json::json!({
        "toolCallId": "call-1",
        "toolName": "search_docs",
        "args": {"q":"test"}
    });
    let call = normalize_legacy_tool_call(&raw).expect("normalize");
    assert_eq!(call.id, "call-1");
    assert_eq!(call.name, "search_docs");
    assert_eq!(call.arguments["q"].as_str(), Some("test"));
  }

  #[tokio::test]
  async fn execute_tool_calls_maps_results_and_errors() {
    let executor = StaticToolExecutor {
      outputs: RwLock::new(HashMap::from([("sum".to_string(), serde_json::json!({"value": 3}))])),
    };
    let calls = vec![
      LlmToolCall {
        id: "a".to_string(),
        name: "sum".to_string(),
        arguments: serde_json::json!({"values":[1,2]}),
      },
      LlmToolCall {
        id: "b".to_string(),
        name: "unknown".to_string(),
        arguments: serde_json::json!({}),
      },
    ];
    let messages = execute_tool_calls(&executor, &calls).await;
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].tool_call_id.as_deref(), Some("a"));
    assert!(messages[0].content.as_text().unwrap().contains("\"value\":3"));
    assert_eq!(messages[1].tool_call_id.as_deref(), Some("b"));
    assert!(messages[1].content.as_text().unwrap().contains("tool not found"));
  }

  struct FlakyProvider {
    id: String,
    fail_count: Mutex<usize>,
    calls: AtomicUsize,
  }

  #[async_trait]
  impl LlmProvider for FlakyProvider {
    fn provider_id(&self) -> &str {
      &self.id
    }

    async fn list_models(&self) -> Result<Vec<LlmModelInfo>, LlmProviderError> {
      Ok(Vec::new())
    }

    async fn complete(&self, request: &LlmRequest) -> Result<LlmResponse, LlmProviderError> {
      self.calls.fetch_add(1, Ordering::SeqCst);
      let mut guard = self.fail_count.lock().expect("flaky provider lock poisoned");
      if *guard > 0 {
        *guard -= 1;
        return Err(LlmProviderError::Unavailable("temporary".to_string()));
      }
      Ok(LlmResponse {
        model: request.model.clone(),
        output_text: "ok".to_string(),
        reasoning: None,
        finish_reason: Some("stop".to_string()),
        tool_calls: Vec::new(),
        usage: None,
        raw_payload: serde_json::json!({}),
      })
    }
  }

  #[tokio::test]
  async fn provider_registry_retries_before_fallback() {
    let primary = Arc::new(FlakyProvider {
      id: "openai".to_string(),
      fail_count: Mutex::new(1),
      calls: AtomicUsize::new(0),
    });
    let fallback = Arc::new(StaticProvider {
      id: "local".to_string(),
      fail: false,
      calls: AtomicUsize::new(0),
    });
    let mut registry = LlmProviderRegistry::new();
    registry.register(primary.clone());
    registry.register(fallback.clone());

    let (provider, response) = registry
      .complete_with_resilience(
        &request(),
        "openai",
        &["local".to_string()],
        2,
        3,
        Duration::from_secs(1),
      )
      .await
      .expect("retry should recover on primary");
    assert_eq!(provider, "openai");
    assert_eq!(response.output_text, "ok");
    assert_eq!(primary.calls.load(Ordering::SeqCst), 2);
    assert_eq!(fallback.calls.load(Ordering::SeqCst), 0);
  }

  #[tokio::test]
  async fn provider_registry_opens_circuit_and_skips_primary_temporarily() {
    let primary = Arc::new(StaticProvider {
      id: "openai".to_string(),
      fail: true,
      calls: AtomicUsize::new(0),
    });
    let fallback = Arc::new(StaticProvider {
      id: "local".to_string(),
      fail: false,
      calls: AtomicUsize::new(0),
    });
    let mut registry = LlmProviderRegistry::new();
    registry.register(primary.clone());
    registry.register(fallback);

    let _ = registry
      .complete_with_resilience(
        &request(),
        "openai",
        &["local".to_string()],
        0,
        1,
        Duration::from_secs(30),
      )
      .await
      .expect("fallback should succeed");
    let calls_after_first = primary.calls.load(Ordering::SeqCst);

    let _ = registry
      .complete_with_resilience(
        &request(),
        "openai",
        &["local".to_string()],
        0,
        1,
        Duration::from_secs(30),
      )
      .await
      .expect("fallback should still succeed");
    assert_eq!(primary.calls.load(Ordering::SeqCst), calls_after_first);
  }

  #[tokio::test]
  async fn provider_registry_recovers_primary_after_circuit_cooldown() {
    let primary = Arc::new(FlakyProvider {
      id: "openai".to_string(),
      fail_count: Mutex::new(1),
      calls: AtomicUsize::new(0),
    });
    let fallback = Arc::new(StaticProvider {
      id: "local".to_string(),
      fail: false,
      calls: AtomicUsize::new(0),
    });
    let mut registry = LlmProviderRegistry::new();
    registry.register(primary.clone());
    registry.register(fallback.clone());

    let _ = registry
      .complete_with_resilience(
        &request(),
        "openai",
        &["local".to_string()],
        0,
        1,
        Duration::from_millis(50),
      )
      .await
      .expect("fallback should succeed while primary fails");
    let calls_after_failure = primary.calls.load(Ordering::SeqCst);

    let _ = registry
      .complete_with_resilience(
        &request(),
        "openai",
        &["local".to_string()],
        0,
        1,
        Duration::from_millis(50),
      )
      .await
      .expect("fallback should succeed while circuit is open");
    assert_eq!(
      primary.calls.load(Ordering::SeqCst),
      calls_after_failure,
      "primary should be skipped while circuit cooldown is active"
    );

    std::thread::sleep(Duration::from_millis(75));

    let (provider, response) = registry
      .complete_with_resilience(
        &request(),
        "openai",
        &["local".to_string()],
        0,
        1,
        Duration::from_millis(50),
      )
      .await
      .expect("primary should recover after cooldown");
    assert_eq!(provider, "openai");
    assert_eq!(response.output_text, "ok");
    assert!(
      primary.calls.load(Ordering::SeqCst) > calls_after_failure,
      "primary should be retried after cooldown"
    );
  }

  #[tokio::test]
  async fn provider_registry_reports_unavailable_when_failover_chain_is_exhausted() {
    let primary = Arc::new(StaticProvider {
      id: "openai".to_string(),
      fail: true,
      calls: AtomicUsize::new(0),
    });
    let fallback = Arc::new(StaticProvider {
      id: "local".to_string(),
      fail: true,
      calls: AtomicUsize::new(0),
    });
    let mut registry = LlmProviderRegistry::new();
    registry.register(primary.clone());
    registry.register(fallback.clone());

    let err = registry
      .complete_with_resilience(
        &request(),
        "openai",
        &["local".to_string()],
        1,
        2,
        Duration::from_secs(1),
      )
      .await
      .expect_err("all failing providers should return unavailable");
    assert!(matches!(err, LlmProviderError::Unavailable(_)));
    assert_eq!(primary.calls.load(Ordering::SeqCst), 2);
    assert_eq!(fallback.calls.load(Ordering::SeqCst), 2);
  }

  #[test]
  fn legacy_error_mapping_matches_expected_codes() {
    let invalid = map_provider_error_to_legacy(&LlmProviderError::InvalidRequest("bad input".to_string()), 30_000);
    assert_eq!(invalid.code, "COPILOT_SESSION_INVALID_INPUT");
    assert!(!invalid.retryable);
    assert_eq!(invalid.timeout_ms, 0);

    let timeout = map_provider_error_to_legacy(&LlmProviderError::Timeout("deadline exceeded".to_string()), 45_000);
    assert_eq!(timeout.code, "COPILOT_PROVIDER_TIMEOUT");
    assert!(timeout.retryable);
    assert_eq!(timeout.timeout_ms, 45_000);
  }

  // ── Embedding tests ─────────────────────────────────────────────────────

  #[tokio::test]
  async fn default_embed_returns_unavailable() {
    let provider = StaticProvider {
      id: "test".to_string(),
      fail: false,
      calls: AtomicUsize::new(0),
    };
    let result = provider.embed(&["hello".to_string()], "text-embedding-3-small").await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(matches!(err, LlmProviderError::Unavailable(_)));
  }

  /// A test provider that supports embeddings.
  struct EmbeddingProvider {
    id: String,
    fail: bool,
    embed_calls: AtomicUsize,
  }

  #[async_trait]
  impl LlmProvider for EmbeddingProvider {
    fn provider_id(&self) -> &str {
      &self.id
    }

    async fn list_models(&self) -> Result<Vec<LlmModelInfo>, LlmProviderError> {
      Ok(Vec::new())
    }

    async fn complete(&self, _request: &LlmRequest) -> Result<LlmResponse, LlmProviderError> {
      Err(LlmProviderError::Unavailable("not a chat provider".to_string()))
    }

    async fn embed(&self, texts: &[String], model: &str) -> Result<EmbeddingResponse, LlmProviderError> {
      self.embed_calls.fetch_add(1, Ordering::SeqCst);
      if self.fail {
        return Err(LlmProviderError::Unavailable(format!("{} down", self.id)));
      }
      let embeddings = texts.iter().map(|_| vec![0.1, 0.2, 0.3]).collect();
      Ok(EmbeddingResponse {
        embeddings,
        model: model.to_string(),
        usage: Some(EmbeddingUsage {
          prompt_tokens: texts.len() as i32 * 5,
          total_tokens: texts.len() as i32 * 5,
        }),
      })
    }
  }

  #[tokio::test]
  async fn embed_with_fallback_uses_primary_when_healthy() {
    let primary = Arc::new(EmbeddingProvider {
      id: "openai".to_string(),
      fail: false,
      embed_calls: AtomicUsize::new(0),
    });
    let fallback = Arc::new(EmbeddingProvider {
      id: "local".to_string(),
      fail: false,
      embed_calls: AtomicUsize::new(0),
    });
    let mut registry = LlmProviderRegistry::new();
    registry.register(primary.clone());
    registry.register(fallback.clone());

    let texts = vec!["hello".to_string(), "world".to_string()];
    let (provider_id, response) = registry
      .embed_with_fallback(&texts, "text-embedding-3-small", "openai", &["local".to_string()])
      .await
      .expect("embedding should succeed");
    assert_eq!(provider_id, "openai");
    assert_eq!(response.embeddings.len(), 2);
    assert_eq!(primary.embed_calls.load(Ordering::SeqCst), 1);
    assert_eq!(fallback.embed_calls.load(Ordering::SeqCst), 0);
  }

  #[tokio::test]
  async fn embed_with_fallback_falls_back_when_primary_fails() {
    let primary = Arc::new(EmbeddingProvider {
      id: "openai".to_string(),
      fail: true,
      embed_calls: AtomicUsize::new(0),
    });
    let fallback = Arc::new(EmbeddingProvider {
      id: "local".to_string(),
      fail: false,
      embed_calls: AtomicUsize::new(0),
    });
    let mut registry = LlmProviderRegistry::new();
    registry.register(primary.clone());
    registry.register(fallback.clone());

    let texts = vec!["test".to_string()];
    let (provider_id, response) = registry
      .embed_with_fallback(&texts, "model", "openai", &["local".to_string()])
      .await
      .expect("embedding should succeed on fallback");
    assert_eq!(provider_id, "local");
    assert_eq!(response.embeddings.len(), 1);
    assert_eq!(primary.embed_calls.load(Ordering::SeqCst), 1);
    assert_eq!(fallback.embed_calls.load(Ordering::SeqCst), 1);
  }

  #[tokio::test]
  async fn embed_with_fallback_returns_error_when_all_fail() {
    let primary = Arc::new(EmbeddingProvider {
      id: "openai".to_string(),
      fail: true,
      embed_calls: AtomicUsize::new(0),
    });
    let fallback = Arc::new(EmbeddingProvider {
      id: "local".to_string(),
      fail: true,
      embed_calls: AtomicUsize::new(0),
    });
    let mut registry = LlmProviderRegistry::new();
    registry.register(primary);
    registry.register(fallback);

    let texts = vec!["test".to_string()];
    let result = registry
      .embed_with_fallback(&texts, "model", "openai", &["local".to_string()])
      .await;
    assert!(result.is_err());
  }

  #[test]
  fn embedding_response_round_trips_through_serde() {
    let response = EmbeddingResponse {
      embeddings: vec![vec![0.1, 0.2], vec![0.3, 0.4]],
      model: "text-embedding-3-small".to_string(),
      usage: Some(EmbeddingUsage {
        prompt_tokens: 10,
        total_tokens: 10,
      }),
    };
    let json = serde_json::to_string(&response).expect("serialize");
    let parsed: EmbeddingResponse = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(parsed.embeddings.len(), 2);
    assert_eq!(parsed.model, "text-embedding-3-small");
    assert_eq!(parsed.usage.unwrap().prompt_tokens, 10);
  }
}
