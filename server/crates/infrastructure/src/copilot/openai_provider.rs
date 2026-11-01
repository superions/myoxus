//! OpenAI-compatible LLM provider implementation.
//!
//! Connects to the OpenAI chat completions API (or any API-compatible endpoint
//! such as Azure OpenAI, local vLLM, Ollama's OpenAI-compat layer, etc.).
//! Implements [`LlmProvider`] from the application layer.

use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use myoxus_application::copilot::provider::{
  EmbeddingPurpose, EmbeddingResponse, EmbeddingUsage, LlmFinishReason, LlmMessage, LlmModelInfo, LlmProvider,
  LlmProviderError, LlmRequest, LlmResponse, LlmRole, LlmStreamEvent, LlmTokenStream, LlmToolCall, LlmToolDefinition,
  LlmUsage,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{error, info, instrument, trace, warn};

/// An [`LlmProvider`] backed by the OpenAI chat completions API.
///
/// Supports any endpoint that speaks the OpenAI `/v1/chat/completions` protocol.
pub struct OpenAiProvider {
  /// Pre-configured HTTP client with timeout.
  client: Client,
  /// Bearer token for the `Authorization` header.
  api_key: String,
  /// Base URL (e.g. `https://api.openai.com/v1`). No trailing slash.
  endpoint: String,
  /// Model to use when the request does not specify one.
  default_model: String,
  /// Unique ID for this provider instance (e.g. `"openai"` or `"local"`).
  id: String,
  /// Static list of supported models from config (used by `list_models`).
  configured_models: Vec<String>,
  model_options: myoxus_contracts::copilot::CopilotModelOptionsMap,
  embedding_dimensions: Option<u32>,
  embedding_task_type: bool,
}

impl OpenAiProvider {
  fn reasoning_request(
    &self,
    model: &str,
    mode: Option<myoxus_contracts::copilot::ReasoningMode>,
  ) -> Result<ReasoningRequest, LlmProviderError> {
    use myoxus_contracts::copilot::{ReasoningControl, ReasoningMode};
    let Some(mode) = mode else {
      return Ok(ReasoningRequest::default());
    };
    let control = self
      .model_options
      .get(model)
      .and_then(|options| options.reasoning_control.as_ref())
      .ok_or_else(|| {
        LlmProviderError::InvalidRequest("Reasoning override is not supported for the selected model".into())
      })?;
    control
      .validate()
      .map_err(|error| LlmProviderError::InvalidRequest(error.into()))?;
    Ok(match control {
      ReasoningControl::EnableThinking => ReasoningRequest {
        chat_template_kwargs: Some(ChatTemplateOptions {
          enable_thinking: matches!(mode, ReasoningMode::Enabled),
        }),
        ..Default::default()
      },
      ReasoningControl::ReasoningEffort { on, off } => ReasoningRequest {
        reasoning_effort: Some(if matches!(mode, ReasoningMode::Enabled) {
          *on
        } else {
          *off
        }),
        ..Default::default()
      },
    })
  }

  /// Create a new `OpenAiProvider`.
  ///
  /// # Arguments
  /// * `id` - Provider registry ID (e.g. `"openai"`, `"local"`).
  /// * `api_key` - API key for Bearer auth.
  /// * `endpoint` - Base URL (e.g. `https://api.openai.com/v1`).
  /// * `default_model` - Fallback model when request.model is empty.
  /// * `models` - Statically configured model list for `list_models`.
  /// * `model_options` - Validated literal-ID controls used only for explicit overrides.
  /// * `timeout` - HTTP request timeout.
  pub fn new(
    id: String,
    api_key: String,
    endpoint: String,
    default_model: String,
    models: Vec<String>,
    model_options: myoxus_contracts::copilot::CopilotModelOptionsMap,
    timeout: Duration,
    additional_ca: Option<&crate::tls::ValidatedCaBundle>,
  ) -> Result<Self, LlmProviderError> {
    let client = crate::tls::build_http_client(Client::builder().timeout(timeout), additional_ca)
      .map_err(|e| LlmProviderError::Unavailable(format!("failed to build HTTP client: {e}")))?;

    let endpoint = endpoint.trim_end_matches('/').to_string();

    info!(
        provider_id = %id,
        endpoint = %endpoint,
        default_model = %default_model,
        model_count = models.len(),
        timeout_secs = timeout.as_secs(),
        "openai provider initialized"
    );

    Ok(Self {
      client,
      api_key,
      endpoint,
      default_model,
      id,
      configured_models: models,
      model_options,
      embedding_dimensions: None,
      embedding_task_type: false,
    })
  }

  pub fn with_embedding_dimensions(mut self, dimensions: u32) -> Self {
    self.embedding_dimensions = Some(dimensions);
    self
  }

  /// Opt into the endpoint's document/query task_type extension, not chat options.
  pub fn with_embedding_task_type(mut self, enabled: bool) -> Self {
    self.embedding_task_type = enabled;
    self
  }
}

// ---------------------------------------------------------------------------
// OpenAI API request/response types (private)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
  #[serde(flatten)]
  reasoning: ReasoningRequest,
  model: String,
  messages: Vec<ChatMessage>,
  #[serde(skip_serializing_if = "Option::is_none")]
  temperature: Option<f32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  max_tokens: Option<i32>,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  tools: Vec<ChatTool>,
}

#[derive(Debug, Default, Serialize)]
struct ReasoningRequest {
  #[serde(skip_serializing_if = "Option::is_none")]
  chat_template_kwargs: Option<ChatTemplateOptions>,
  #[serde(skip_serializing_if = "Option::is_none")]
  reasoning_effort: Option<myoxus_contracts::copilot::ReasoningEffort>,
}

#[derive(Debug, Serialize)]
struct ChatTemplateOptions {
  enable_thinking: bool,
}

#[derive(Debug, Serialize)]
struct ChatMessage {
  role: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  content: Option<ChatContent>,
  #[serde(skip_serializing_if = "Option::is_none")]
  name: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  tool_call_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  tool_calls: Option<Vec<ChatToolCallRequest>>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum ChatContent {
  Text(String),
  Parts(Vec<ChatContentPart>),
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ChatContentPart {
  Text { text: String },
  ImageUrl { image_url: ChatImageUrl },
}

#[derive(Debug, Serialize)]
struct ChatImageUrl {
  url: String,
}

#[derive(Debug, Serialize)]
struct ChatTool {
  #[serde(rename = "type")]
  tool_type: String,
  function: ChatToolFunction,
}

#[derive(Debug, Serialize)]
struct ChatToolFunction {
  name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  description: Option<String>,
  parameters: Value,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatToolCallRequest {
  id: String,
  #[serde(rename = "type")]
  call_type: String,
  function: ChatToolCallFunction,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatToolCallFunction {
  name: String,
  arguments: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
  model: Option<String>,
  choices: Vec<ChatChoice>,
  usage: Option<ChatUsage>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
  message: ChatResponseMessage,
  finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatResponseMessage {
  #[allow(dead_code)]
  role: Option<String>,
  content: Option<String>,
  reasoning: Option<String>,
  reasoning_content: Option<String>,
  tool_calls: Option<Vec<ChatToolCallRequest>>,
}

#[derive(Debug, Deserialize)]
struct ChatUsage {
  prompt_tokens: i32,
  completion_tokens: i32,
  total_tokens: i32,
}

// ---------------------------------------------------------------------------
// OpenAI Embedding API request/response types (private)
// ---------------------------------------------------------------------------

/// Maximum number of texts per embedding API call.
const EMBEDDING_BATCH_LIMIT: usize = 100;

#[derive(Debug, Serialize)]
struct EmbeddingRequest {
  model: String,
  input: Vec<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  dimensions: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  task_type: Option<EmbeddingPurpose>,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbeddingResponse {
  data: Vec<OpenAiEmbeddingEntry>,
  model: Option<String>,
  usage: Option<OpenAiEmbeddingUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbeddingEntry {
  embedding: Vec<f32>,
  index: usize,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbeddingUsage {
  prompt_tokens: i32,
  total_tokens: i32,
}

// ---------------------------------------------------------------------------
// SSE streaming types (for `stream: true` responses)
// ---------------------------------------------------------------------------

/// A request body for streaming chat completions (`"stream": true`).
#[derive(Debug, Serialize)]
struct ChatCompletionStreamRequest {
  #[serde(flatten)]
  reasoning: ReasoningRequest,
  model: String,
  messages: Vec<ChatMessage>,
  #[serde(skip_serializing_if = "Option::is_none")]
  temperature: Option<f32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  max_tokens: Option<i32>,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  tools: Vec<ChatTool>,
  stream: bool,
}

/// A single chunk from the OpenAI streaming response.
#[derive(Debug, Deserialize)]
struct ChatStreamChunk {
  choices: Vec<StreamChoice>,
}

/// A choice within a streaming chunk.
#[derive(Debug, Deserialize)]
struct StreamChoice {
  delta: StreamDelta,
  finish_reason: Option<String>,
}

/// The incremental delta content within a streaming choice.
#[derive(Debug, Deserialize)]
struct StreamDelta {
  content: Option<String>,
  reasoning: Option<String>,
  reasoning_content: Option<String>,
  tool_calls: Option<Vec<StreamToolCallDelta>>,
}

/// Tool call delta in streaming mode (for future use).
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct StreamToolCallDelta {
  index: Option<u32>,
  id: Option<String>,
  function: Option<StreamToolCallFunctionDelta>,
}

/// Function call delta in streaming mode (for future use).
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct StreamToolCallFunctionDelta {
  name: Option<String>,
  arguments: Option<String>,
}

/// Frame bytes before decoding text: a transport chunk may end inside UTF-8,
/// a CRLF pair, a JSON escape or an SSE event. No provider payload enters errors.
#[derive(Default)]
struct OpenAiSseFrames {
  line: Vec<u8>,
  data: Vec<u8>,
  after_cr: bool,
  first_line: bool,
}

impl OpenAiSseFrames {
  fn new() -> Self {
    Self {
      first_line: true,
      ..Self::default()
    }
  }

  fn push(&mut self, byte: u8) -> Result<Option<Vec<u8>>, LlmProviderError> {
    if self.after_cr {
      self.after_cr = false;
      if byte == b'\n' {
        return Ok(None);
      }
    }
    if byte != b'\r' && byte != b'\n' {
      // This bounds one malformed/unclosed wire event, not the total answer.
      if self.line.len() + self.data.len() >= 1024 * 1024 {
        return Err(LlmProviderError::Upstream(
          "provider stream frame exceeds the wire limit".into(),
        ));
      }
      self.line.push(byte);
      return Ok(None);
    }
    self.after_cr = byte == b'\r';
    let mut line = std::mem::take(&mut self.line);
    if self.first_line {
      self.first_line = false;
      if line.starts_with(&[0xef, 0xbb, 0xbf]) {
        line.drain(..3);
      }
    }
    if line.is_empty() {
      if self.data.is_empty() {
        return Ok(None);
      }
      self.data.pop(); // SSE joins data fields with one newline, excluding the last.
      return Ok(Some(std::mem::take(&mut self.data)));
    }
    let (field, value) = match line.iter().position(|byte| *byte == b':') {
      Some(index) => (&line[..index], &line[index + 1..]),
      None => (&line[..], &[][..]),
    };
    if field == b"data" {
      self.data.extend_from_slice(value.strip_prefix(b" ").unwrap_or(value));
      self.data.push(b'\n');
    }
    // Comments and event/id/retry fields are wire metadata, not answer content.
    Ok(None)
  }
}

/// The same decoder is used by HTTP streaming and its byte-boundary regression
/// coverage. Only an explicit wire terminal completes this provider stream.
fn decode_openai_stream<S>(byte_stream: S) -> LlmTokenStream
where
  S: Stream<Item = Result<Bytes, LlmProviderError>> + Send + 'static,
{
  Box::pin(async_stream::stream! {
    let mut frames = OpenAiSseFrames::new();
    let mut finish_reason = LlmFinishReason::Stop;
    let mut requested_tools = false;
    futures_util::pin_mut!(byte_stream);
    while let Some(chunk) = byte_stream.next().await {
      let bytes = match chunk {
        Ok(bytes) => bytes,
        Err(error) => {
          yield Err(error);
          return;
        }
      };
      for byte in bytes {
        let frame = match frames.push(byte) {
          Ok(Some(frame)) => frame,
          Ok(None) => continue,
          Err(error) => { yield Err(error); return; }
        };
        let data = match std::str::from_utf8(&frame) {
          Ok(data) => data,
          Err(_) => {
            yield Err(LlmProviderError::Upstream("provider stream frame contains invalid UTF-8".into()));
            return;
          }
        };
        if data.trim() == "[DONE]" {
          yield Ok(LlmStreamEvent::Finish(if requested_tools { LlmFinishReason::ToolCalls } else { finish_reason }));
          return;
        }
        let chunk = match serde_json::from_str::<ChatStreamChunk>(data) {
          Ok(chunk) => chunk,
          Err(_) => {
            yield Err(LlmProviderError::Upstream("provider stream frame contains malformed JSON".into()));
            return;
          }
        };
        for choice in chunk.choices {
          requested_tools |= choice.delta.tool_calls.as_ref().is_some_and(|calls| !calls.is_empty());
          // Prefer the nonempty current field when both aliases are present; appending
          // both would duplicate reasoning from compatibility-shaped providers.
          if let Some(reasoning) = choice.delta.reasoning.filter(|value| !value.is_empty()).or(choice.delta.reasoning_content)
            && !reasoning.is_empty() {
            yield Ok(LlmStreamEvent::Reasoning(reasoning));
          }
          if let Some(content) = choice.delta.content && !content.is_empty() {
            yield Ok(LlmStreamEvent::Text(content));
          }
          if let Some(reason) = choice.finish_reason {
            match LlmFinishReason::parse(&reason) {
              Ok(reason) => finish_reason = reason,
              Err(error) => { yield Err(error); return; }
            }
          }
        }
      }
    }
    yield Err(LlmProviderError::Upstream("provider stream ended before its terminal marker".into()));
  })
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/// Inspect only a bounded error envelope for known context-window failures.
/// Provider text is classification input, never public diagnostic copy.
async fn provider_context_limit(mut response: reqwest::Response) -> Result<bool, LlmProviderError> {
  let mut body = Vec::new();
  loop {
    match response.chunk().await {
      Ok(Some(chunk)) if body.len() + chunk.len() <= 16 * 1024 => body.extend_from_slice(&chunk),
      Ok(Some(_)) => return Ok(false),
      Ok(None) => break,
      Err(error) if error.is_timeout() => {
        return Err(LlmProviderError::Timeout("provider response deadline exceeded".into()));
      }
      Err(_) => return Ok(false),
    }
  }
  let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
    return Ok(false);
  };
  let error = &payload["error"];
  let code = error["code"].as_str().unwrap_or_default();
  let message = error["message"].as_str().unwrap_or_default().to_ascii_lowercase();
  Ok(
    matches!(code, "context_length_exceeded" | "context_window_exceeded")
      || message.contains("maximum context length")
      || (message.contains("context window") && message.contains("exceed")),
  )
}

fn role_to_string(role: &LlmRole) -> String {
  match role {
    LlmRole::System => "system".to_string(),
    LlmRole::User => "user".to_string(),
    LlmRole::Assistant => "assistant".to_string(),
    LlmRole::Tool => "tool".to_string(),
  }
}

fn map_messages(messages: &[LlmMessage]) -> Vec<ChatMessage> {
  messages
    .iter()
    .map(|m| ChatMessage {
      role: role_to_string(&m.role),
      content: if m.content.as_text() == Some("") && m.role == LlmRole::Assistant {
        // Assistant messages with empty content may carry tool_calls only.
        None
      } else {
        use base64::Engine;
        use myoxus_application::copilot::provider::{LlmContent, LlmContentPart};
        Some(match &m.content {
          LlmContent::Text(text) => ChatContent::Text(text.clone()),
          LlmContent::Parts(parts) => ChatContent::Parts(
            parts
              .iter()
              .map(|part| match part {
                LlmContentPart::Text { text } => ChatContentPart::Text { text: text.clone() },
                LlmContentPart::Image { mime_type, bytes } => ChatContentPart::ImageUrl {
                  image_url: ChatImageUrl {
                    url: format!(
                      "data:{mime_type};base64,{}",
                      base64::engine::general_purpose::STANDARD.encode(bytes)
                    ),
                  },
                },
              })
              .collect(),
          ),
        })
      },
      name: m.name.clone(),
      tool_call_id: m.tool_call_id.clone(),
      tool_calls: None,
    })
    .collect()
}

fn map_tools(tools: &[LlmToolDefinition]) -> Vec<ChatTool> {
  tools
    .iter()
    .map(|t| ChatTool {
      tool_type: "function".to_string(),
      function: ChatToolFunction {
        name: t.name.clone(),
        description: t.description.clone(),
        parameters: t.input_schema.clone(),
      },
    })
    .collect()
}

fn map_tool_calls_response(tool_calls: &[ChatToolCallRequest]) -> Vec<LlmToolCall> {
  tool_calls
    .iter()
    .map(|tc| {
      let arguments: Value =
        serde_json::from_str(&tc.function.arguments).unwrap_or_else(|_| Value::String(tc.function.arguments.clone()));
      LlmToolCall {
        id: tc.id.clone(),
        name: tc.function.name.clone(),
        arguments,
      }
    })
    .collect()
}

// ---------------------------------------------------------------------------
// LlmProvider implementation
// ---------------------------------------------------------------------------

#[async_trait]
impl LlmProvider for OpenAiProvider {
  fn supports_vision(&self, model: &str) -> bool {
    self
      .model_options
      .get(model)
      .is_some_and(|options| options.supports_vision)
  }
  fn provider_id(&self) -> &str {
    &self.id
  }

  #[instrument(skip(self))]
  async fn list_models(&self) -> Result<Vec<LlmModelInfo>, LlmProviderError> {
    // Return the statically configured model list. Calling the live
    // /v1/models endpoint is unreliable for filtering chat-capable models
    // and unnecessary when the operator has already declared the models.
    trace!(provider = %self.id, count = self.configured_models.len(), "listing configured models");
    Ok(
      self
        .configured_models
        .iter()
        .map(|id| LlmModelInfo {
          id: id.clone(),
          provider: self.id.clone(),
          display_name: Some(id.clone()),
          supports_tools: true,
        })
        .collect(),
    )
  }

  #[instrument(skip(self, request), fields(provider = %self.id, model = %request.model))]
  async fn complete(&self, request: &LlmRequest) -> Result<LlmResponse, LlmProviderError> {
    let model = if request.model.is_empty() {
      self.default_model.clone()
    } else {
      request.model.clone()
    };
    if request.messages.iter().any(|message| message.content.has_images()) && !self.supports_vision(&model) {
      return Err(LlmProviderError::InvalidRequest(
        "selected model does not support image input".into(),
      ));
    }

    let start = std::time::Instant::now();

    let body = ChatCompletionRequest {
      reasoning: self.reasoning_request(&model, request.reasoning)?,
      model: model.clone(),
      messages: map_messages(&request.messages),
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      tools: map_tools(&request.tools),
    };

    let url = format!("{}/chat/completions", self.endpoint);
    trace!(
        %url,
        %model,
        message_count = request.messages.len(),
        tool_count = request.tools.len(),
        "sending chat completion request"
    );

    let http_response = crate::http_retry::retry_reqwest("openai::complete", 3, || {
      self
        .client
        .post(&url)
        .header("Authorization", format!("Bearer {}", self.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
    })
    .await
    .map_err(|e| {
      if e.is_timeout() {
        warn!(provider = %self.id, %model, error = %e, "openai request timed out");
        LlmProviderError::Timeout(format!("request timed out: {e}"))
      } else if e.is_connect() {
        error!(provider = %self.id, %model, error = %e, "openai connection failed");
        LlmProviderError::Unavailable(format!("connection failed: {e}"))
      } else {
        error!(provider = %self.id, %model, error = %e, "openai request failed");
        LlmProviderError::Unavailable(format!("request failed: {e}"))
      }
    })?;

    let status = http_response.status();
    let status_code = status.as_u16();

    if !status.is_success() {
      // Generative providers can echo input in error bodies. The completion
      // boundary must not retain transcript/chat text in errors or logging.
      let error_msg = format!("HTTP {status_code}");

      return match status_code {
        401 => {
          error!(provider = %self.id, "openai authentication failed (401)");
          Err(LlmProviderError::Unavailable(format!(
            "authentication failed: {error_msg}"
          )))
        }
        429 => {
          warn!(provider = %self.id, %model, "openai rate limited (429)");
          Err(LlmProviderError::RateLimited(format!("rate limited: {error_msg}")))
        }
        400 => {
          warn!(provider = %self.id, %model, "openai bad request (400): {}", error_msg);
          Err(LlmProviderError::InvalidRequest(error_msg))
        }
        404 => {
          warn!(provider = %self.id, %model, "openai model not found (404)");
          Err(LlmProviderError::InvalidRequest(format!(
            "model not found: {error_msg}"
          )))
        }
        500..=599 => {
          error!(provider = %self.id, %model, status_code, "openai server error");
          Err(LlmProviderError::Upstream(format!(
            "server error ({status_code}): {error_msg}"
          )))
        }
        _ => {
          error!(provider = %self.id, %model, status_code, "openai unexpected status");
          Err(LlmProviderError::Upstream(format!(
            "unexpected status {status_code}: {error_msg}"
          )))
        }
      };
    }

    let raw_text = http_response.text().await.map_err(|e| {
      error!(provider = %self.id, %model, error = %e, "failed to read openai response body");
      LlmProviderError::Upstream(format!("failed to read response body: {e}"))
    })?;

    // Parse JSON once; reuse the Value for both typed deserialization and the
    // raw_payload field on LlmResponse (avoids double-parsing the same string).
    let raw_payload: Value = serde_json::from_str(&raw_text).unwrap_or(Value::Null);

    let completion: ChatCompletionResponse = serde_json::from_value(raw_payload.clone()).map_err(|_| {
      error!(
          provider = %self.id,
          %model,
          "failed to parse openai response"
      );
      LlmProviderError::Upstream("failed to parse completion response".into())
    })?;

    let choice = completion.choices.first().ok_or_else(|| {
      warn!(provider = %self.id, %model, "openai response had no choices");
      LlmProviderError::Upstream("response contained no choices".to_string())
    })?;

    let output_text = choice.message.content.clone().unwrap_or_default();
    let finish_reason = choice.finish_reason.clone();
    let tool_calls = choice
      .message
      .tool_calls
      .as_ref()
      .map(|tc| map_tool_calls_response(tc))
      .unwrap_or_default();

    let usage = completion.usage.map(|u| LlmUsage {
      prompt_tokens: u.prompt_tokens,
      completion_tokens: u.completion_tokens,
      total_tokens: u.total_tokens,
    });

    let response_model = completion.model.unwrap_or_else(|| model.clone());

    let total_tokens = usage.as_ref().map(|u| u.total_tokens).unwrap_or(0);
    info!(
        provider = %self.id,
        model = %response_model,
        finish_reason = ?finish_reason,
        tool_call_count = tool_calls.len(),
        prompt_tokens = usage.as_ref().map(|u| u.prompt_tokens).unwrap_or(0),
        completion_tokens = usage.as_ref().map(|u| u.completion_tokens).unwrap_or(0),
        "openai completion received"
    );
    tracing::info!(
        provider = %self.id,
        model = %response_model,
        latency_ms = %start.elapsed().as_millis(),
        total_tokens = total_tokens,
        "LLM request completed"
    );

    Ok(LlmResponse {
      model: response_model,
      output_text,
      reasoning: choice
        .message
        .reasoning
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| {
          choice
            .message
            .reasoning_content
            .clone()
            .filter(|value| !value.is_empty())
        }),
      finish_reason,
      tool_calls,
      usage,
      raw_payload,
    })
  }

  #[instrument(skip(self, request), fields(provider = %self.id, model = %request.model))]
  async fn stream_chat(&self, request: &LlmRequest) -> Result<LlmTokenStream, LlmProviderError> {
    let model = if request.model.is_empty() {
      self.default_model.clone()
    } else {
      request.model.clone()
    };
    if request.messages.iter().any(|message| message.content.has_images()) && !self.supports_vision(&model) {
      return Err(LlmProviderError::InvalidRequest(
        "selected model does not support image input".into(),
      ));
    }

    let start = std::time::Instant::now();

    let body = ChatCompletionStreamRequest {
      reasoning: self.reasoning_request(&model, request.reasoning)?,
      model: model.clone(),
      messages: map_messages(&request.messages),
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      tools: map_tools(&request.tools),
      stream: true,
    };

    let url = format!("{}/chat/completions", self.endpoint);
    trace!(
        %url,
        %model,
        message_count = request.messages.len(),
        "sending streaming chat completion request"
    );

    // One attempt per provider keeps its configured deadline authoritative;
    // the registry owns fallback. Retrying here would restart that deadline.
    let http_response = self
      .client
      .post(&url)
      .header("Authorization", format!("Bearer {}", self.api_key))
      .header("Content-Type", "application/json")
      .json(&body)
      .send()
      .await
      .map_err(|e| {
        if e.is_timeout() {
          warn!(provider = %self.id, %model, "openai stream request timed out");
          LlmProviderError::Timeout("provider response deadline exceeded".into())
        } else if e.is_connect() {
          error!(provider = %self.id, %model, "openai stream connection failed");
          LlmProviderError::Unavailable("provider stream connection failed".into())
        } else {
          error!(provider = %self.id, %model, "openai stream request failed");
          LlmProviderError::Unavailable("provider stream request failed".into())
        }
      })?;

    let status = http_response.status();
    let status_code = status.as_u16();

    if !status.is_success() {
      if status_code == 400 && provider_context_limit(http_response).await? {
        return Err(LlmProviderError::ContextLimit);
      }
      // A provider may echo the private prompt in its error message. Only
      // bounded classification above may inspect it; never forward that body.
      let error_msg = format!("HTTP {status_code}");

      return match status_code {
        401 => {
          error!(provider = %self.id, "openai stream authentication failed (401)");
          Err(LlmProviderError::Unavailable(format!(
            "stream authentication failed: {error_msg}"
          )))
        }
        429 => {
          warn!(provider = %self.id, %model, "openai stream rate limited (429)");
          Err(LlmProviderError::RateLimited(format!(
            "stream rate limited: {error_msg}"
          )))
        }
        400 => {
          warn!(provider = %self.id, %model, "openai stream bad request (400): {}", error_msg);
          Err(LlmProviderError::InvalidRequest(error_msg))
        }
        500..=599 => {
          error!(provider = %self.id, %model, status_code, "openai stream server error");
          Err(LlmProviderError::Upstream(format!(
            "stream server error ({status_code}): {error_msg}"
          )))
        }
        _ => {
          error!(provider = %self.id, %model, status_code, "openai stream unexpected status");
          Err(LlmProviderError::Upstream(format!(
            "stream unexpected status {status_code}: {error_msg}"
          )))
        }
      };
    }

    info!(provider = %self.id, %model, latency_ms = %start.elapsed().as_millis(), "openai streaming response headers received");

    Ok(decode_openai_stream(http_response.bytes_stream().map(|chunk| {
      chunk.map_err(|error| {
        if error.is_timeout() {
          LlmProviderError::Timeout("provider response deadline exceeded".into())
        } else {
          LlmProviderError::Upstream("provider stream transport failed".into())
        }
      })
    })))
  }

  #[instrument(skip(self, texts), fields(provider = %self.id, %model, input_count = texts.len()))]
  async fn embed(&self, texts: &[String], model: &str) -> Result<EmbeddingResponse, LlmProviderError> {
    self.embed_for_purpose(texts, model, EmbeddingPurpose::Document).await
  }

  #[instrument(skip(self, texts), fields(provider = %self.id, %model, input_count = texts.len()))]
  async fn embed_for_purpose(
    &self,
    texts: &[String],
    model: &str,
    purpose: EmbeddingPurpose,
  ) -> Result<EmbeddingResponse, LlmProviderError> {
    let start = std::time::Instant::now();
    let input_count = texts.len();

    if texts.is_empty() {
      return Ok(EmbeddingResponse {
        embeddings: Vec::new(),
        model: model.to_string(),
        usage: None,
      });
    }

    let effective_model = if model.is_empty() { &self.default_model } else { model };

    let url = format!("{}/embeddings", self.endpoint);
    let mut all_embeddings = Vec::with_capacity(texts.len());
    let mut total_prompt_tokens = 0i32;
    let mut total_total_tokens = 0i32;
    let mut response_model = effective_model.to_string();

    // Process in batches of EMBEDDING_BATCH_LIMIT to respect API limits.
    for batch_start in (0..texts.len()).step_by(EMBEDDING_BATCH_LIMIT) {
      let batch_end = (batch_start + EMBEDDING_BATCH_LIMIT).min(texts.len());
      let batch: Vec<String> = texts[batch_start..batch_end].to_vec();

      let body = EmbeddingRequest {
        model: effective_model.to_string(),
        input: batch.clone(),
        dimensions: self.embedding_dimensions,
        task_type: self.embedding_task_type.then_some(purpose),
      };

      trace!(
        %url,
        model = %effective_model,
        batch_size = batch.len(),
        batch_start,
        "sending embedding request"
      );

      // Index jobs own retries; query embedding has its own caller deadline.
      // Do not multiply that budget or let an error expose provider payloads.
      let mut http_response = self
        .client
        .post(&url)
        .header("Authorization", format!("Bearer {}", self.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
          if e.is_timeout() {
            LlmProviderError::Timeout("embedding request timed out".into())
          } else if e.is_connect() {
            LlmProviderError::Unavailable("embedding connection failed".into())
          } else {
            LlmProviderError::Unavailable("embedding request failed".into())
          }
        })?;

      let status = http_response.status();
      let status_code = status.as_u16();

      if !status.is_success() {
        return match status_code {
          401 => {
            error!(provider = %self.id, "embedding authentication failed (401)");
            Err(LlmProviderError::Unavailable("embedding authentication failed".into()))
          }
          429 => {
            warn!(provider = %self.id, model = %effective_model, "embedding rate limited (429)");
            Err(LlmProviderError::RateLimited("embedding rate limited".into()))
          }
          400 => Err(LlmProviderError::InvalidRequest(
            "embedding request was rejected".into(),
          )),
          500..=599 => {
            error!(provider = %self.id, model = %effective_model, status_code, "embedding server error");
            Err(LlmProviderError::Upstream(format!(
              "embedding server error ({status_code})"
            )))
          }
          _ => {
            error!(provider = %self.id, model = %effective_model, status_code, "embedding unexpected status");
            Err(LlmProviderError::Upstream(format!(
              "embedding unexpected status {status_code}"
            )))
          }
        };
      }

      let mut encoded = Vec::new();
      while let Some(chunk) = http_response.chunk().await.map_err(|error| {
        if error.is_timeout() {
          LlmProviderError::Timeout("embedding response timed out".into())
        } else {
          LlmProviderError::Upstream("embedding response could not be read".into())
        }
      })? {
        if encoded.len().saturating_add(chunk.len()) > 16 * 1024 * 1024 {
          return Err(LlmProviderError::Upstream(
            "embedding response exceeds its technical bound".into(),
          ));
        }
        encoded.extend_from_slice(&chunk);
      }
      let embedding_response: OpenAiEmbeddingResponse = serde_json::from_slice(&encoded)
        .map_err(|_| LlmProviderError::Upstream("invalid embedding response".into()))?;

      if embedding_response.data.len() != batch.len() {
        return Err(LlmProviderError::Upstream(format!(
          "embedding API returned {} vectors for {} inputs",
          embedding_response.data.len(),
          batch.len()
        )));
      }

      // Sort by index to ensure correct ordering.
      let mut entries = embedding_response.data;
      entries.sort_by_key(|e| e.index);

      for (index, entry) in entries.into_iter().enumerate() {
        if entry.index != index || entry.embedding.is_empty() || entry.embedding.iter().any(|value| !value.is_finite())
        {
          return Err(LlmProviderError::Upstream(
            "embedding API returned empty vector".to_string(),
          ));
        }
        all_embeddings.push(entry.embedding);
      }

      if let Some(u) = embedding_response.usage {
        total_prompt_tokens += u.prompt_tokens;
        total_total_tokens += u.total_tokens;
      }
      if let Some(m) = embedding_response.model {
        response_model = m;
      }
    }

    info!(
      provider = %self.id,
      model = %response_model,
      vector_count = all_embeddings.len(),
      prompt_tokens = total_prompt_tokens,
      "embedding completed"
    );
    tracing::info!(
      provider = %self.id,
      model = %response_model,
      latency_ms = %start.elapsed().as_millis(),
      input_count = input_count,
      "LLM request completed"
    );

    Ok(EmbeddingResponse {
      embeddings: all_embeddings,
      model: response_model,
      usage: Some(EmbeddingUsage {
        prompt_tokens: total_prompt_tokens,
        total_tokens: total_total_tokens,
      }),
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn stream_frames_preserve_utf8_and_json_at_every_transport_boundary_and_stop_at_done() {
    let wire = concat!(
      "\u{feff}: keepalive\r\nevent: message\r\n",
      "data: {\"choices\":[{\"delta\":{\"reasoning\":\"Denke 🦔\",\"reasoning_content\":\"must not duplicate\"},\"finish_reason\":null}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"Grüße 🦔\\n\\\"z\\\"\"},\"finish_reason\":null}]}\r\n\r\n",
      "data:{\"choices\":[\n",
      "data: {\"delta\":{\"content\":\"!\",\"reasoning\":\"\",\"reasoning_content\":\"legacy reasoning\"},\"finish_reason\":\"STOP\"}]}\n\n",
      "data: [DONE]\r\r",
      "data: invalid-after-terminal\n\n",
    )
    .as_bytes();
    let expected = vec![
      LlmStreamEvent::Reasoning("Denke 🦔".into()),
      LlmStreamEvent::Text("Grüße 🦔\n\"z\"".into()),
      LlmStreamEvent::Reasoning("legacy reasoning".into()),
      LlmStreamEvent::Text("!".into()),
      LlmStreamEvent::Finish(LlmFinishReason::Stop),
    ];
    for split in 0..=wire.len() {
      let parts = [
        Bytes::copy_from_slice(&wire[..split]),
        Bytes::copy_from_slice(&wire[split..]),
      ];
      let output = decode_openai_stream(futures_util::stream::iter(parts.map(Ok::<_, LlmProviderError>)))
        .collect::<Vec<_>>()
        .await;
      let text = output
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .expect("valid SSE at any byte split");
      assert_eq!(text, expected, "transport split {split}");
    }
    let bytes = wire
      .iter()
      .map(|byte| Ok::<_, LlmProviderError>(Bytes::copy_from_slice(&[*byte])))
      .collect::<Vec<_>>();
    let output = decode_openai_stream(futures_util::stream::iter(bytes))
      .collect::<Vec<_>>()
      .await;
    assert_eq!(output.into_iter().collect::<Result<Vec<_>, _>>().unwrap(), expected);
  }

  #[tokio::test]
  async fn stream_frames_fail_closed_without_losing_the_committed_prefix_or_exposing_bad_payloads() {
    let prefix = b"data: {\"choices\":[{\"delta\":{\"content\":\"prefix\"},\"finish_reason\":null}]}\n\n";
    for suffix in [
      &b""[..],
      &b"data: {\"choices\":"[..],
      &b"data: private-invalid-json\n\n"[..],
      &b"data: \xff\n\n"[..],
      &b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n"[..],
      &b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"content_filter\"}]}\n\n"[..],
      &b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n"[..],
      &b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"unknown-private-reason\"}]}\n\n"[..],
    ] {
      let bytes = Bytes::from([&prefix[..], suffix].concat());
      let output = decode_openai_stream(futures_util::stream::iter([Ok::<_, LlmProviderError>(bytes)]))
        .collect::<Vec<_>>()
        .await;
      assert_eq!(output.len(), 2);
      assert_eq!(output[0].as_ref().unwrap(), &LlmStreamEvent::Text("prefix".into()));
      let error = output[1]
        .as_ref()
        .expect_err("malformed, unfinished or unsupported output is not success")
        .to_string();
      assert!(
        !error.contains("private"),
        "wire payload must not be rendered in the error"
      );
    }
    for (reason, expected) in [
      ("length", LlmFinishReason::Length),
      ("content_filter", LlmFinishReason::ContentFilter),
      ("function_call", LlmFinishReason::ToolCalls),
    ] {
      let wire =
        format!("data: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"{reason}\"}}]}}\n\ndata: [DONE]\n\n");
      let output = decode_openai_stream(futures_util::stream::iter([Ok::<_, LlmProviderError>(Bytes::from(
        wire,
      ))]))
      .collect::<Vec<_>>()
      .await;
      assert_eq!(
        output.into_iter().collect::<Result<Vec<_>, _>>().unwrap(),
        vec![LlmStreamEvent::Finish(expected)]
      );
      assert!(
        expected.require_complete().is_err(),
        "a normalized non-success finish must remain distinguishable"
      );
    }
  }

  #[test]
  fn role_mapping_is_correct() {
    assert_eq!(role_to_string(&LlmRole::System), "system");
    assert_eq!(role_to_string(&LlmRole::User), "user");
    assert_eq!(role_to_string(&LlmRole::Assistant), "assistant");
    assert_eq!(role_to_string(&LlmRole::Tool), "tool");
  }

  #[test]
  fn map_messages_preserves_order_and_fields() {
    let msgs = vec![
      LlmMessage {
        role: LlmRole::System,
        content: "You are helpful".into(),
        name: None,
        tool_call_id: None,
      },
      LlmMessage {
        role: LlmRole::User,
        content: myoxus_application::copilot::provider::LlmContent::Parts(vec![
          myoxus_application::copilot::provider::LlmContentPart::Text { text: "Hello".into() },
          myoxus_application::copilot::provider::LlmContentPart::Image {
            mime_type: "image/png".into(),
            bytes: vec![1, 2, 3],
          },
        ]),
        name: Some("alice".to_string()),
        tool_call_id: None,
      },
      LlmMessage {
        role: LlmRole::Tool,
        content: r#"{"result":42}"#.into(),
        name: Some("calculator".to_string()),
        tool_call_id: Some("call-1".to_string()),
      },
    ];
    let mapped = map_messages(&msgs);
    assert_eq!(mapped.len(), 3);
    assert_eq!(mapped[0].role, "system");
    assert_eq!(serde_json::to_value(&mapped[0]).unwrap()["content"], "You are helpful");
    assert_eq!(
      serde_json::to_value(&mapped[1]).unwrap()["content"],
      serde_json::json!([
        {"type":"text","text":"Hello"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,AQID"}},
      ])
    );
    assert_eq!(mapped[1].name.as_deref(), Some("alice"));
    assert_eq!(mapped[2].tool_call_id.as_deref(), Some("call-1"));
  }

  #[test]
  fn map_tools_produces_function_type() {
    let tools = vec![LlmToolDefinition {
      name: "search".to_string(),
      description: Some("Search docs".to_string()),
      input_schema: serde_json::json!({"type": "object", "properties": {"q": {"type": "string"}}}),
    }];
    let mapped = map_tools(&tools);
    assert_eq!(mapped.len(), 1);
    assert_eq!(mapped[0].tool_type, "function");
    assert_eq!(mapped[0].function.name, "search");
  }

  #[test]
  fn tool_call_response_parsing() {
    let tc = vec![ChatToolCallRequest {
      id: "call-abc".to_string(),
      call_type: "function".to_string(),
      function: ChatToolCallFunction {
        name: "get_weather".to_string(),
        arguments: r#"{"location":"Berlin"}"#.to_string(),
      },
    }];
    let mapped = map_tool_calls_response(&tc);
    assert_eq!(mapped.len(), 1);
    assert_eq!(mapped[0].id, "call-abc");
    assert_eq!(mapped[0].name, "get_weather");
    assert_eq!(mapped[0].arguments["location"], "Berlin");
  }

  // ── Embedding request/response serialization tests ──────────────────────

  #[test]
  fn embedding_request_serializes_correctly() {
    let request = EmbeddingRequest {
      model: "text-embedding-3-small".to_string(),
      input: vec!["hello world".to_string(), "test input".to_string()],
      dimensions: None,
      task_type: None,
    };
    let json = serde_json::to_value(&request).expect("serialize");
    assert_eq!(json["model"], "text-embedding-3-small");
    let input = json["input"].as_array().expect("input should be array");
    assert_eq!(input.len(), 2);
    assert_eq!(input[0], "hello world");
    assert_eq!(input[1], "test input");
  }

  #[test]
  fn embedding_response_deserializes_correctly() {
    let json = r#"{
      "object": "list",
      "data": [
        {"object": "embedding", "embedding": [0.1, 0.2, 0.3], "index": 0},
        {"object": "embedding", "embedding": [0.4, 0.5, 0.6], "index": 1}
      ],
      "model": "text-embedding-3-small",
      "usage": {"prompt_tokens": 8, "total_tokens": 8}
    }"#;
    let response: OpenAiEmbeddingResponse = serde_json::from_str(json).expect("deserialize");
    assert_eq!(response.data.len(), 2);
    assert_eq!(response.data[0].embedding, vec![0.1, 0.2, 0.3]);
    assert_eq!(response.data[0].index, 0);
    assert_eq!(response.data[1].embedding, vec![0.4, 0.5, 0.6]);
    assert_eq!(response.data[1].index, 1);
    assert_eq!(response.model.as_deref(), Some("text-embedding-3-small"));
    let usage = response.usage.expect("usage should be present");
    assert_eq!(usage.prompt_tokens, 8);
    assert_eq!(usage.total_tokens, 8);
  }

  #[test]
  fn embedding_response_deserializes_without_optional_fields() {
    let json = r#"{
      "data": [
        {"embedding": [0.1], "index": 0}
      ]
    }"#;
    let response: OpenAiEmbeddingResponse = serde_json::from_str(json).expect("deserialize");
    assert_eq!(response.data.len(), 1);
    assert!(response.model.is_none());
    assert!(response.usage.is_none());
  }

  #[test]
  fn embedding_batch_limit_is_100() {
    assert_eq!(EMBEDDING_BATCH_LIMIT, 100);
  }
}
