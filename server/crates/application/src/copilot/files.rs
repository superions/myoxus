// SPDX-License-Identifier: AGPL-3.0-or-later
//! Completed-answer exports: immutable Markdown plus the existing native codec.

use super::CopilotService;
use crate::auth::{AuthError, AuthResult};
use myoxus_domain::entities::{CopilotMessage, CopilotMessageRole};
use pulldown_cmark::{Event, Options, Parser, Tag};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

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
    // The canonical codec also supports constructs outside this deliberately
    // smaller output contract. Inspect its events without inventing a parser.
    for event in Parser::new_ext(&markdown, Options::all()) {
      match event {
        Event::Start(Tag::Image { .. } | Tag::HtmlBlock | Tag::FootnoteDefinition(_))
        | Event::Html(_)
        | Event::InlineHtml(_)
        | Event::InlineMath(_)
        | Event::DisplayMath(_)
        | Event::FootnoteReference(_) => {
          return Err(AuthError::InvalidInput(
            "This answer contains unsupported export content".into(),
          ));
        }
        Event::Start(Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Fenced(language)))
          if matches!(
            language.trim().to_ascii_lowercase().as_str(),
            "mermaid" | "typst" | "bpmn"
          ) =>
        {
          return Err(AuthError::InvalidInput(
            "Diagram and Typst sources are not supported by answer export".into(),
          ));
        }
        Event::Start(Tag::Link { dest_url, .. })
          if !(dest_url.starts_with('#')
            || url::Url::parse(&dest_url).is_ok_and(|u| matches!(u.scheme(), "http" | "https" | "mailto"))) =>
        {
          return Err(AuthError::InvalidInput(
            "The answer contains an unsupported link".into(),
          ));
        }
        _ => {}
      }
    }
    let title = markdown
      .lines()
      .find(|l| !l.trim().is_empty())
      .unwrap_or("Answer")
      .trim_start_matches('#')
      .trim()
      .chars()
      .take(120)
      .collect::<String>();
    let prepared = crate::markdown::prepare_markdown_import(&title, &markdown)
      .map_err(|_| AuthError::InvalidInput("The answer cannot be converted without content loss".into()))?;
    if !prepared.diagnostics.is_empty() || prepared.native_math_count != 0 || prepared.native_footnote_count != 0 {
      return Err(AuthError::InvalidInput(
        "The answer contains unsupported export content".into(),
      ));
    }
    let source_fingerprint = hex::encode(Sha256::digest(markdown.as_bytes()));
    Ok(CopilotAnswerSnapshot {
      message,
      markdown,
      title,
      locale,
      source_fingerprint,
      yjs: prepared.yjs_binary,
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
  if let Some(winner) = current.attachment_refs.iter().find(|a| {
    a.generated_file().is_some_and(|m| {
      m.format == identity.format
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
        m.format == format
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
    let filename = source
      .title
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
    let file = CopilotAttachmentRef {
      id: file_id,
      message_id,
      blob_key: key.clone(),
      file_name: Some(format!(
        "{}.{}",
        if filename.trim().is_empty() {
          "Answer"
        } else {
          filename.trim()
        },
        format.extension()
      )),
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
