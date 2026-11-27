// SPDX-License-Identifier: AGPL-3.0-or-later
//! Completed-answer exports and native `create_file` tool output over one service.

use super::CopilotService;
use super::provider::{LlmToolDefinition, LlmToolExecutionContext};
use crate::auth::{AuthError, AuthResult};
use myoxus_domain::entities::{CopilotFileFormat, CopilotMessage, CopilotMessageRole, CopilotToolCallStatus};
use pulldown_cmark::{Event, Options, Parser, Tag};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Canonical internal tool name for model-created PDF and HTML files.
pub const CREATE_FILE_TOOL_NAME: &str = "create_file";

const MAX_TITLE_CHARS: usize = 120;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateFileToolArgs {
  pub title: String,
  pub format: CopilotFileFormat,
  pub markdown: String,
}

/// Closed native tool schema for model-created PDF and HTML files.
///
/// The model supplies only immutable document source fields; actor, session,
/// message, stream and local call identity always come from the server lease.
pub fn create_file_tool_definition() -> LlmToolDefinition {
  LlmToolDefinition {
    name: CREATE_FILE_TOOL_NAME.into(),
    description: Some(
      "Create a downloadable PDF or portable HTML file from Markdown. \
       Supports prose, headings, inline emphasis, ordered/unordered/task lists, quotes, \
       fenced code blocks with language, flat tables, and safe http/https/mailto/# links. \
       Does not support images, remote assets, raw HTML, scripts, Typst source, math, footnotes, or diagrams."
        .into(),
    ),
    input_schema: json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["title", "format", "markdown"],
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": MAX_TITLE_CHARS,
          "description": "Concise document title used for the heading metadata and server-derived filename."
        },
        "format": {
          "type": "string",
          "enum": ["pdf", "html"],
          "description": "Output file format."
        },
        "markdown": {
          "type": "string",
          "minLength": 1,
          "description": "Complete Markdown body using only the supported subset."
        }
      }
    }),
  }
}

/// Parse and validate closed `create_file` arguments before source conversion.
pub fn parse_create_file_args(raw: &Value, max_bytes: usize) -> AuthResult<CreateFileToolArgs> {
  if !raw.is_object() {
    return Err(AuthError::InvalidInput("Tool arguments must be an object".into()));
  }
  let mut args: CreateFileToolArgs = serde_json::from_value(raw.clone()).map_err(|_| {
    AuthError::InvalidInput(
      "Invalid create_file arguments: expected closed object {title, format: pdf|html, markdown}".into(),
    )
  })?;
  args.title = args.title.trim().to_owned();
  if args.title.is_empty() {
    return Err(AuthError::InvalidInput("File title must not be empty".into()));
  }
  if args.title.chars().count() > MAX_TITLE_CHARS {
    return Err(AuthError::InvalidInput(
      "File title exceeds the 120-character limit".into(),
    ));
  }
  if args.markdown.trim().is_empty() {
    return Err(AuthError::InvalidInput("File markdown must not be empty".into()));
  }
  if args.markdown.len() > max_bytes {
    return Err(AuthError::InvalidInput(
      "File markdown exceeds the export byte limit".into(),
    ));
  }
  Ok(args)
}

/// Compact metadata returned to the model and tool-result stream.
/// Never includes file bytes, private storage keys, signed URLs or Markdown body.
pub fn create_file_tool_result(file: &myoxus_domain::entities::CopilotAttachmentRef) -> AuthResult<Value> {
  let metadata = file
    .generated_file()
    .ok_or_else(|| AuthError::InvalidInput("File metadata unavailable".into()))?;
  let file_name = file
    .file_name
    .as_deref()
    .ok_or_else(|| AuthError::InvalidInput("File name unavailable".into()))?;
  let size_bytes = file
    .size_bytes
    .ok_or_else(|| AuthError::InvalidInput("File size unavailable".into()))?;
  Ok(json!({
    "fileId": file.id,
    "messageId": file.message_id,
    "fileName": file_name,
    "mimeType": metadata.format.media_type(),
    "sizeBytes": size_bytes,
    "format": metadata.format.extension(),
  }))
}

/// Validate the supported Markdown subset and convert it into a lossless native Yjs snapshot.
fn prepare_markdown_yjs(title: &str, markdown: &str, max_bytes: usize) -> AuthResult<Vec<u8>> {
  if markdown.len() > max_bytes {
    return Err(AuthError::InvalidInput("Content exceeds the export byte limit".into()));
  }
  // The canonical codec also supports constructs outside this deliberately
  // smaller output contract. Inspect its events without inventing a parser.
  for event in Parser::new_ext(markdown, Options::all()) {
    match event {
      Event::Start(Tag::Image { .. } | Tag::HtmlBlock | Tag::FootnoteDefinition(_))
      | Event::Html(_)
      | Event::InlineHtml(_)
      | Event::InlineMath(_)
      | Event::DisplayMath(_)
      | Event::FootnoteReference(_) => {
        return Err(AuthError::InvalidInput(
          "This content contains unsupported export elements (images, raw HTML, math, or footnotes)".into(),
        ));
      }
      Event::Start(Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Fenced(language)))
        if matches!(
          language.trim().to_ascii_lowercase().as_str(),
          "mermaid" | "typst" | "bpmn"
        ) =>
      {
        return Err(AuthError::InvalidInput(
          "Diagram and Typst sources are not supported by file export".into(),
        ));
      }
      Event::Start(Tag::Link { dest_url, .. })
        if !(dest_url.starts_with('#')
          || url::Url::parse(&dest_url).is_ok_and(|u| matches!(u.scheme(), "http" | "https" | "mailto"))) =>
      {
        return Err(AuthError::InvalidInput(
          "The content contains an unsupported link".into(),
        ));
      }
      _ => {}
    }
  }
  let prepared = crate::markdown::prepare_markdown_import(title, markdown)
    .map_err(|_| AuthError::InvalidInput("The content cannot be converted without content loss".into()))?;
  if !prepared.diagnostics.is_empty() || prepared.native_math_count != 0 || prepared.native_footnote_count != 0 {
    return Err(AuthError::InvalidInput(
      "This content contains unsupported export elements".into(),
    ));
  }
  Ok(prepared.yjs_binary)
}

fn sanitize_filename(title: &str, format: CopilotFileFormat, fallback: &str) -> String {
  let sanitized = title
    .chars()
    .map(|c| {
      if c.is_alphanumeric() || c == '-' || c == ' ' {
        c
      } else {
        '_'
      }
    })
    .take(100)
    .collect::<String>();
  let stem = sanitized.trim();
  format!(
    "{}.{}",
    if stem.is_empty() { fallback } else { stem },
    format.extension()
  )
}

fn generated_file_bytes_total(message: &CopilotMessage) -> usize {
  message
    .attachment_refs
    .iter()
    .filter(|attachment| attachment.generated_file().is_some())
    .map(|attachment| attachment.size_bytes.unwrap_or(0).max(0) as usize)
    .fold(0usize, usize::saturating_add)
}

pub struct CopilotAnswerSnapshot {
  pub message: CopilotMessage,
  pub markdown: String,
  pub title: String,
  pub locale: String,
  pub source_fingerprint: String,
  pub yjs: Vec<u8>,
}

/// Legacy completed messages have no stream status. An explicit non-done status
/// always wins over visible text, so a partial answer never becomes an export.
pub fn completed_answer(message: &CopilotMessage, max_bytes: usize) -> AuthResult<String> {
  if message.role != CopilotMessageRole::Assistant
    || message
      .token_usage
      .as_ref()
      .and_then(|v| v["streamStatus"].as_str())
      .is_some_and(|v| v != "done")
  {
    return Err(AuthError::InvalidInput(
      "Only completed assistant answers can be exported".into(),
    ));
  }
  let text = message
    .content
    .as_str()
    .or_else(|| message.content.get("text").and_then(Value::as_str));
  let mut result = String::new();
  if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
    if text.len() > max_bytes {
      return Err(AuthError::InvalidInput("Answer exceeds the export byte limit".into()));
    }
    result.push_str(text);
  } else if let Some(objects) = message.content.get("streamObjects").and_then(Value::as_array) {
    for object in objects.iter().filter(|v| v["type"] == "text-delta") {
      if let Some(text) = object["textDelta"].as_str() {
        if result.len().saturating_add(text.len()) > max_bytes {
          return Err(AuthError::InvalidInput("Answer exceeds the export byte limit".into()));
        }
        result.push_str(text);
      }
    }
  }
  if result.trim().is_empty() {
    return Err(AuthError::InvalidInput("The answer has no final text".into()));
  }
  Ok(result)
}

impl CopilotService {
  /// Ingress owns current session/workspace ACLs; source/status are loaded again
  /// here and compared under the repository lock when the result is published.
  #[tracing::instrument(skip_all, fields(%message_id))]
  pub async fn prepare_answer_export(
    &self,
    message_id: Uuid,
    locale: String,
    max_bytes: usize,
  ) -> AuthResult<CopilotAnswerSnapshot> {
    let message = self
      .repo
      .get_copilot_message(message_id)
      .await
      .map_err(Self::map_repo_err)?
      .ok_or(AuthError::ActionForbidden)?;
    let markdown = completed_answer(&message, max_bytes)?;
    let title = markdown
      .lines()
      .find(|l| !l.trim().is_empty())
      .unwrap_or("Answer")
      .trim_start_matches('#')
      .trim()
      .chars()
      .take(MAX_TITLE_CHARS)
      .collect::<String>();
    let yjs = prepare_markdown_yjs(&title, &markdown, max_bytes)?;
    let source_fingerprint = hex::encode(Sha256::digest(markdown.as_bytes()));
    Ok(CopilotAnswerSnapshot {
      message,
      markdown,
      title,
      locale,
      source_fingerprint,
      yjs,
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn portable_html_distinguishes_literal_code_from_active_resources() {
    assert!(super::validate_portable_html("<html><body><code>url(example.com); @import</code></body></html>").is_ok());
    assert!(super::validate_portable_html("<style>body{background:url(https://example.com/x)}</style>").is_err());
    assert!(super::validate_portable_html("<a href='javascript:alert(1)'>link</a>").is_err());
  }

  #[test]
  fn export_extracts_only_completed_final_text_across_deployed_envelopes() {
    let mut message = CopilotMessage {
      id: Uuid::new_v4(),
      session_id: Uuid::new_v4(),
      role: CopilotMessageRole::Assistant,
      content: json!("Final answer"),
      token_usage: None,
      tool_calls: vec![],
      attachment_refs: vec![],
      edited_at: None,
      created_at: chrono::Utc::now(),
    };
    for content in [
      json!("Final answer"),
      json!({"text":"Final answer", "reasoning":"private reasoning"}),
      json!({"streamObjects":[{"type":"reasoning","textDelta":"private reasoning"},{"type":"text-delta","textDelta":"Final "},{"type":"text-delta","textDelta":"answer"}]}),
    ] {
      message.content = content;
      assert_eq!(completed_answer(&message, 100).unwrap(), "Final answer");
    }
    assert!(completed_answer(&message, 3).is_err());
    for status in ["running", "failed", "canceled"] {
      message.token_usage = Some(json!({"streamStatus":status}));
      assert!(completed_answer(&message, 100).is_err());
    }
    message.token_usage = Some(json!({"streamStatus":"done"}));
    message.content = json!({"streamObjects":[{"type":"reasoning","textDelta":"not an answer"}]});
    assert!(completed_answer(&message, 100).is_err());
  }

  #[test]
  fn create_file_tool_schema_and_validation_enforce_closed_boundaries() {
    let def = create_file_tool_definition();
    assert_eq!(def.name, CREATE_FILE_TOOL_NAME);
    assert_eq!(def.input_schema["additionalProperties"], json!(false));
    assert_eq!(def.input_schema["required"], json!(["title", "format", "markdown"]));
    assert_eq!(def.input_schema["properties"]["format"]["enum"], json!(["pdf", "html"]));

    let ok = parse_create_file_args(
      &json!({"title":"Quarterly Brief","format":"pdf","markdown":"# Summary\n\nAll green."}),
      1024,
    )
    .expect("valid closed args");
    assert_eq!(ok.title, "Quarterly Brief");
    assert_eq!(ok.format, CopilotFileFormat::Pdf);

    // Extra fields, unsupported formats, empty fields, oversized input and unsupported Markdown fail closed.
    assert!(
      parse_create_file_args(
        &json!({"title":"Brief","format":"pdf","markdown":"ok","sessionId":"spoof"}),
        1024,
      )
      .is_err()
    );
    assert!(parse_create_file_args(&json!({"title":"Brief","format":"docx","markdown":"ok"}), 1024).is_err());
    assert!(parse_create_file_args(&json!({"title":"   ","format":"html","markdown":"ok"}), 1024).is_err());
    assert!(parse_create_file_args(&json!({"title":"Brief","format":"html","markdown":"toolong"}), 4).is_err());
    assert!(prepare_markdown_yjs("Brief", "![img](https://example.com/a.png)", 1024).is_err());
    assert!(prepare_markdown_yjs("Brief", "<script>alert(1)</script>", 1024).is_err());
    assert!(prepare_markdown_yjs("Brief", "```mermaid\ngraph TD\nA-->B\n```", 1024).is_err());
    assert!(prepare_markdown_yjs("Brief", "[bad](javascript:alert(1))", 1024).is_err());
  }

  #[test]
  fn append_generated_file_deduplicates_completed_tool_call_across_theme_changes() {
    use myoxus_domain::entities::{
      CopilotAttachmentRef, CopilotGeneratedFileKind, CopilotGeneratedFileMetadata, CopilotSession, CopilotToolCall,
    };
    let now = chrono::Utc::now();
    let session = CopilotSession {
      id: Uuid::new_v4(),
      user_id: Uuid::new_v4(),
      workspace_id: Some(Uuid::new_v4()),
      doc_id: None,
      title: None,
      model: None,
      pinned: false,
      archived_at: None,
      deleted_at: None,
      metadata: json!({}),
      created_at: now,
      updated_at: now,
    };
    let call_id = Uuid::new_v4();
    let msg_id = Uuid::new_v4();
    let mut message = CopilotMessage {
      id: msg_id,
      session_id: session.id,
      role: CopilotMessageRole::Assistant,
      content: json!({"text":"","streamObjects":[]}),
      token_usage: Some(json!({"streamStatus":"running","streamId":Uuid::new_v4().to_string()})),
      tool_calls: vec![CopilotToolCall {
        id: call_id,
        message_id: msg_id,
        tool_name: CREATE_FILE_TOOL_NAME.into(),
        args: json!({"title":"Brief","format":"html","markdown":"Hello"}),
        status: CopilotToolCallStatus::Running,
        result: None,
        error: None,
        started_at: Some(now),
        finished_at: None,
        created_at: now,
        updated_at: now,
      }],
      attachment_refs: vec![],
      edited_at: None,
      created_at: now,
    };
    let source = message.clone();
    let make_file = |render_fp: &str| CopilotAttachmentRef {
      id: Uuid::new_v4(),
      message_id: msg_id,
      blob_key: format!("copilot-output/ws/u/{}", Uuid::new_v4()),
      file_name: Some("Brief.html".into()),
      mime_type: Some("text/html; charset=utf-8".into()),
      size_bytes: Some(128),
      metadata: serde_json::to_value(CopilotGeneratedFileMetadata {
        kind: CopilotGeneratedFileKind::GeneratedFile,
        format: CopilotFileFormat::Html,
        source_id: call_id,
        source_fingerprint: "src-fp".into(),
        render_fingerprint: render_fp.into(),
      })
      .unwrap(),
      created_at: now,
    };
    let first = make_file("theme-v1");
    let committed = append_generated_file(&session, &session, &mut message, &source, &first).unwrap();
    assert_eq!(committed.id, first.id);
    // Retrying the same local tool call even after a theme change returns the committed winner.
    let second = make_file("theme-v2");
    let after_first = message.clone();
    let winner = append_generated_file(&session, &session, &mut message, &after_first, &second).unwrap();
    assert_eq!(winner.id, first.id);
    assert_eq!(message.attachment_refs.len(), 1);
  }
}

/// The session lock also covers deletion, retry and fork. Only structural file
/// metadata is compared; current unrelated attachments/extensions survive.
pub fn append_generated_file(
  session: &myoxus_domain::entities::CopilotSession,
  expected_session: &myoxus_domain::entities::CopilotSession,
  current: &mut CopilotMessage,
  source: &CopilotMessage,
  file: &myoxus_domain::entities::CopilotAttachmentRef,
) -> myoxus_domain::repositories::RepoResult<myoxus_domain::entities::CopilotAttachmentRef> {
  use myoxus_domain::repositories::RepositoryError;
  if session.id != expected_session.id
    || session.deleted_at.is_some()
    || session.user_id != expected_session.user_id
    || session.workspace_id != expected_session.workspace_id
    || session.doc_id != expected_session.doc_id
    || session.metadata != expected_session.metadata
    || current.id != source.id
    || current.session_id != session.id
    || current.content != source.content
    || current.edited_at != source.edited_at
    || current.token_usage != source.token_usage
  {
    return Err(RepositoryError::Conflict(
      "Answer or chat authority changed while exporting".into(),
    ));
  }
  let identity = file
    .generated_file()
    .ok_or_else(|| RepositoryError::Conflict("Invalid generated file".into()))?;
  if identity.source_id != current.id {
    // Tool-created files are owned by their stable local tool-call ID.
    // Reuse any already-committed result for that call before re-checking
    // render state so later theme or template changes cannot duplicate it.
    if let Some(winner) = current
      .attachment_refs
      .iter()
      .find(|a| a.generated_file().is_some_and(|m| m.source_id == identity.source_id))
    {
      return Ok(winner.clone());
    }
    let running_stream = current.token_usage.as_ref().and_then(|v| v["streamStatus"].as_str()) == Some("running");
    let running_call = current.tool_calls.iter().any(|call| {
      call.id == identity.source_id
        && call.tool_name == CREATE_FILE_TOOL_NAME
        && call.status == CopilotToolCallStatus::Running
    });
    if !running_stream || !running_call {
      return Err(RepositoryError::Conflict(
        "Tool call or stream is no longer active for file publication".into(),
      ));
    }
    current.attachment_refs.push(file.clone());
    return Ok(file.clone());
  }
  if let Some(winner) = current.attachment_refs.iter().find(|a| {
    a.generated_file().is_some_and(|m| {
      m.source_id == identity.source_id
        && m.format == identity.format
        && m.source_fingerprint == identity.source_fingerprint
        && m.render_fingerprint == identity.render_fingerprint
    })
  }) {
    return Ok(winner.clone());
  }
  current.attachment_refs.push(file.clone());
  Ok(file.clone())
}

pub enum CopilotFileRenderContext {
  Html { css: String, fingerprint: String },
  Pdf(crate::pdf_export::service::PdfExportRenderRequest),
}
impl CopilotFileRenderContext {
  fn fingerprint(&self) -> String {
    match self {
      Self::Html { fingerprint, .. } => fingerprint.clone(),
      Self::Pdf(request) => hex::encode(Sha256::digest(request.render_inputs.to_string())),
    }
  }
}
#[async_trait::async_trait]
pub trait CopilotFileRenderer: Send + Sync {
  async fn authorize(&self, session: &myoxus_domain::entities::CopilotSession) -> AuthResult<()>;
  async fn capture(
    &self,
    source: &CopilotAnswerSnapshot,
    workspace_id: Uuid,
    format: myoxus_domain::entities::CopilotFileFormat,
  ) -> AuthResult<CopilotFileRenderContext>;
  async fn render(&self, source: &CopilotAnswerSnapshot, context: CopilotFileRenderContext) -> AuthResult<Vec<u8>>;
}

pub struct CopilotFileService {
  pub copilot: CopilotService,
  pub storage: std::sync::Arc<dyn crate::ports::BlobStoragePort>,
  pub renderer: std::sync::Arc<dyn CopilotFileRenderer>,
  pub max_bytes: usize,
}
impl CopilotFileService {
  #[tracing::instrument(skip_all, fields(%message_id, ?format))]
  pub async fn export(
    &self,
    message_id: Uuid,
    format: myoxus_domain::entities::CopilotFileFormat,
    locale: String,
  ) -> AuthResult<myoxus_domain::entities::CopilotAttachmentRef> {
    use myoxus_domain::entities::{CopilotAttachmentRef, CopilotGeneratedFileKind, CopilotGeneratedFileMetadata};
    let source = self
      .copilot
      .prepare_answer_export(message_id, locale, self.max_bytes)
      .await?;
    let session = self.copilot.get_session(source.message.session_id).await?;
    self.renderer.authorize(&session).await?;
    let workspace_id = session.workspace_id.ok_or(AuthError::ActionForbidden)?;
    let context = self.renderer.capture(&source, workspace_id, format).await?;
    let render_fingerprint = hex::encode(Sha256::digest(format!(
      "answer-export-1:{}:{}:{}",
      context.fingerprint(),
      source.locale,
      source.message.created_at.to_rfc3339()
    )));
    if let Some(existing) = source.message.attachment_refs.iter().find(|a| {
      a.generated_file().is_some_and(|m| {
        m.source_id == source.message.id
          && m.format == format
          && m.source_fingerprint == source.source_fingerprint
          && m.render_fingerprint == render_fingerprint
      })
    }) {
      return Ok(existing.clone());
    }
    let bytes = self.renderer.render(&source, context).await?;
    if bytes.is_empty() || bytes.len() > self.max_bytes {
      return Err(AuthError::InvalidInput("Generated file exceeds export limits".into()));
    }
    self.renderer.authorize(&session).await?;
    let file_id = Uuid::new_v4();
    let key = format!("copilot-output/{workspace_id}/{}/{file_id}", session.user_id);
    let file = CopilotAttachmentRef {
      id: file_id,
      message_id,
      blob_key: key.clone(),
      file_name: Some(sanitize_filename(&source.title, format, "Answer")),
      mime_type: Some(format.media_type().into()),
      size_bytes: Some(bytes.len() as i64),
      metadata: serde_json::to_value(CopilotGeneratedFileMetadata {
        kind: CopilotGeneratedFileKind::GeneratedFile,
        format,
        source_id: source.message.id,
        source_fingerprint: source.source_fingerprint,
        render_fingerprint,
      })
      .map_err(|_| AuthError::InvalidInput("File metadata unavailable".into()))?,
      created_at: chrono::Utc::now(),
    };
    let result = async {
      self
        .storage
        .write_blob(crate::ports::BlobWriteRequest {
          key: key.clone(),
          body: bytes.into(),
          content_type: file.mime_type.clone(),
        })
        .await
        .map_err(|_| AuthError::InvalidInput("File storage failed; retry export".into()))?;
      self.renderer.authorize(&session).await?;
      self
        .copilot
        .repo
        .commit_copilot_generated_file(&session, &source.message, &file)
        .await
        .map_err(CopilotService::map_repo_err)
    }
    .await;
    if !result.as_ref().is_ok_and(|winner| winner.id == file.id) {
      // A lost commit acknowledgement may still have published our reference.
      // Delete only a confirmed unpublished object, never a retained fork's file.
      if let Ok(current) = self.copilot.get_message(message_id).await {
        if !current.attachment_refs.iter().any(|a| a.blob_key == key) {
          if self.storage.delete_blob(&key).await.is_err() {
            tracing::warn!(%file_id, "Unpublished answer export cleanup failed");
          }
        }
      }
    }
    result
  }

  /// Create and commit a model-requested PDF or HTML file under an active
  /// native `create_file` tool-call lease.
  ///
  /// Idempotency is owned by `context.local_call_id`: if that call already has
  /// a committed file on the message, it is returned before resolving current
  /// theme/template defaults or rendering again.
  #[tracing::instrument(skip_all, fields(
    session_id = %context.session_id,
    message_id = %context.message_id,
    call_id = %context.local_call_id
  ))]
  pub async fn create_for_tool_call(
    &self,
    context: LlmToolExecutionContext,
    raw_arguments: &Value,
    locale: String,
  ) -> AuthResult<myoxus_domain::entities::CopilotAttachmentRef> {
    use myoxus_domain::entities::{CopilotAttachmentRef, CopilotGeneratedFileKind, CopilotGeneratedFileMetadata};
    let message = self
      .copilot
      .repo
      .get_copilot_message(context.message_id)
      .await
      .map_err(CopilotService::map_repo_err)?
      .ok_or(AuthError::ActionForbidden)?;
    let session = self.copilot.get_session(context.session_id).await?;
    if message.session_id != session.id
      || session.user_id != context.user_id
      || session.deleted_at.is_some()
      || message.edited_at.is_some()
      || message.role != CopilotMessageRole::Assistant
    {
      return Err(AuthError::ActionForbidden);
    }
    self.renderer.authorize(&session).await?;

    // Check completed call idempotency before reading current render defaults
    // or rendering again, so later theme/template changes never duplicate output.
    if let Some(existing) = message
      .attachment_refs
      .iter()
      .find(|a| a.generated_file().is_some_and(|m| m.source_id == context.local_call_id))
    {
      return Ok(existing.clone());
    }

    let usage = message
      .token_usage
      .as_ref()
      .ok_or_else(|| AuthError::InvalidInput("Tool execution requires an active chat stream".into()))?;
    let expected_stream_id = context.stream_id.to_string();
    if usage["streamId"].as_str() != Some(expected_stream_id.as_str())
      || usage["streamStatus"].as_str() != Some("running")
    {
      return Err(AuthError::InvalidInput(
        "Chat stream is no longer active for file creation".into(),
      ));
    }
    let persisted_call = message
      .tool_calls
      .iter()
      .find(|call| {
        call.id == context.local_call_id
          && call.tool_name == CREATE_FILE_TOOL_NAME
          && call.status == CopilotToolCallStatus::Running
      })
      .ok_or_else(|| AuthError::InvalidInput("Active create_file tool call lease not found".into()))?;
    if &persisted_call.args != raw_arguments {
      return Err(AuthError::InvalidInput(
        "Tool arguments do not match the persisted call record".into(),
      ));
    }

    let args = parse_create_file_args(raw_arguments, self.max_bytes)?;
    let existing_bytes = generated_file_bytes_total(&message);
    if existing_bytes >= self.max_bytes {
      return Err(AuthError::InvalidInput(
        "Generated files in this response exceed the configured byte limit".into(),
      ));
    }
    let yjs = prepare_markdown_yjs(&args.title, &args.markdown, self.max_bytes)?;
    let source_fingerprint = hex::encode(Sha256::digest(format!(
      "tool-create-file-1\0{}\0{}\0{}",
      args.title,
      args.format.extension(),
      args.markdown
    )));
    let call_timestamp = persisted_call.created_at;
    let mut snapshot_message = message.clone();
    snapshot_message.created_at = call_timestamp;
    let source = CopilotAnswerSnapshot {
      message: snapshot_message,
      markdown: args.markdown,
      title: args.title,
      locale,
      source_fingerprint,
      yjs,
    };

    let workspace_id = session.workspace_id.ok_or(AuthError::ActionForbidden)?;
    let render_context = self.renderer.capture(&source, workspace_id, args.format).await?;
    let render_fingerprint = hex::encode(Sha256::digest(format!(
      "tool-create-file-1:{}:{}:{}",
      render_context.fingerprint(),
      source.locale,
      call_timestamp.to_rfc3339()
    )));
    let bytes = self.renderer.render(&source, render_context).await?;
    if bytes.is_empty() || bytes.len() > self.max_bytes || existing_bytes.saturating_add(bytes.len()) > self.max_bytes {
      return Err(AuthError::InvalidInput(
        "Generated file exceeds the configured export byte limit".into(),
      ));
    }
    self.renderer.authorize(&session).await?;

    let file_id = Uuid::new_v4();
    let key = format!("copilot-output/{workspace_id}/{}/{file_id}", session.user_id);
    let file = CopilotAttachmentRef {
      id: file_id,
      message_id: context.message_id,
      blob_key: key.clone(),
      file_name: Some(sanitize_filename(&source.title, args.format, "Document")),
      mime_type: Some(args.format.media_type().into()),
      size_bytes: Some(bytes.len() as i64),
      metadata: serde_json::to_value(CopilotGeneratedFileMetadata {
        kind: CopilotGeneratedFileKind::GeneratedFile,
        format: args.format,
        source_id: context.local_call_id,
        source_fingerprint: source.source_fingerprint,
        render_fingerprint,
      })
      .map_err(|_| AuthError::InvalidInput("File metadata unavailable".into()))?,
      created_at: chrono::Utc::now(),
    };

    let result = async {
      self
        .storage
        .write_blob(crate::ports::BlobWriteRequest {
          key: key.clone(),
          body: bytes.into(),
          content_type: file.mime_type.clone(),
        })
        .await
        .map_err(|_| AuthError::InvalidInput("File storage failed; retry file creation".into()))?;
      self.renderer.authorize(&session).await?;
      self
        .copilot
        .commit_stream_generated_file(context.stream_id, &session, &message, &file)
        .await
    }
    .await;

    if !result.as_ref().is_ok_and(|winner| winner.id == file.id) {
      if let Ok(current) = self.copilot.get_message(context.message_id).await {
        if !current.attachment_refs.iter().any(|a| a.blob_key == key) {
          if self.storage.delete_blob(&key).await.is_err() {
            tracing::warn!(%file_id, "Unpublished tool file cleanup failed");
          }
        }
      }
    }
    result
  }
}

pub fn validate_portable_html(output: &str) -> AuthResult<()> {
  let html = scraper::Html::parse_document(output);
  let all = scraper::Selector::parse("*").expect("static selector");
  for element in html.select(&all) {
    if element.value().name() == "form" {
      return Err(AuthError::InvalidInput("Portable HTML contains a form".into()));
    }
    for (name, value) in element.value().attrs() {
      if name.starts_with("on") || matches!(name, "src" | "srcset" | "http-equiv") {
        return Err(AuthError::InvalidInput(
          "Portable HTML contains active or external assets".into(),
        ));
      }
      if name.ends_with("href")
        && !value.starts_with('#')
        && !url::Url::parse(value).is_ok_and(|u| matches!(u.scheme(), "http" | "https" | "mailto"))
      {
        return Err(AuthError::InvalidInput("Portable HTML contains an unsafe link".into()));
      }
    }
    let css = if element.value().name() == "style" {
      element.text().collect::<String>()
    } else {
      element.value().attr("style").unwrap_or("").to_owned()
    };
    let css = css.to_ascii_lowercase();
    if css.contains("@import")
      || css.split("url(").skip(1).any(|value| {
        !value
          .trim_start_matches([' ', '\'', '"'])
          .starts_with("data:font/woff2;base64,")
      })
    {
      return Err(AuthError::InvalidInput(
        "Portable HTML contains a linked resource".into(),
      ));
    }
  }
  Ok(())
}
