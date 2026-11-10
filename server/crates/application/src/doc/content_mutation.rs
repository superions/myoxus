// SPDX-License-Identifier: AGPL-3.0-or-later
//! Application boundary for direct semantic document mutations.
//!
//! The service validates destructive intent and delegates one atomic operation
//! to the document repository. Yjs decoding, locking, sequence assignment and
//! outbox persistence remain server-owned and are never exposed to MCP clients.

use std::sync::Arc;

use serde::Serialize;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};

use super::{DocCachePort, DocCompactionService, DocContentMutationCommit, DocStore};

pub use yjs::{
  DocumentFragment, DocumentFragmentBlock, DocumentListKind, DocumentMutation, DocumentTextFormatting,
  DocumentTextLinkChange, DocumentTextRangeUnit, DocumentTextSegment,
};

/// Reuse the canonical document/PDF hyperlink policy before mutation admission.
/// Errors are payload-free; URL normalization also fixes durable replay identity.
pub fn normalize_text_formatting(mut formatting: DocumentTextFormatting) -> AuthResult<DocumentTextFormatting> {
  if formatting.is_empty() {
    return Err(AuthError::InvalidInput("MIX_DOCUMENT_FORMATTING_EMPTY".into()));
  }
  if let Some(DocumentTextLinkChange::Set { href }) = &mut formatting.link {
    if href.len() > 4096 {
      return Err(AuthError::InvalidInput("MIX_DOCUMENT_FORMATTING_LINK_INVALID".into()));
    }
    let validated = crate::pdf_export::link_validator::validate_link(href)
      .map_err(|_| AuthError::InvalidInput("MIX_DOCUMENT_FORMATTING_LINK_INVALID".into()))?;
    if validated.href.len() > 4096 {
      return Err(AuthError::InvalidInput("MIX_DOCUMENT_FORMATTING_LINK_INVALID".into()));
    }
    *href = validated.href;
  }
  Ok(formatting)
}

/// New rich fields share the existing link policy and native span/atom limits.
/// Normalization precedes durable MCP admission and is repeated at the use case.
pub fn normalize_document_text_segments(spans: &mut [DocumentTextSegment]) -> AuthResult<()> {
  for span in spans.iter_mut() {
    if let Some(href) = &span.link {
      let formatting = normalize_text_formatting(DocumentTextFormatting {
        link: Some(DocumentTextLinkChange::Set { href: href.clone() }),
        ..Default::default()
      })?;
      if let Some(DocumentTextLinkChange::Set { href }) = formatting.link {
        span.link = Some(href);
      }
    }
  }
  yjs::document_mutation::validate_document_text_segments(spans)
    .map_err(|_| AuthError::InvalidInput("MIX_DOCUMENT_MUTATION_FRAGMENT_INVALID".into()))
}

pub fn normalize_document_mutation(mutation: &mut DocumentMutation) -> AuthResult<()> {
  match mutation {
    DocumentMutation::EditText {
      replacement_spans: Some(spans),
      ..
    }
    | DocumentMutation::EditTableCell {
      replacement_spans: Some(spans),
      ..
    } => normalize_document_text_segments(spans)?,
    DocumentMutation::FormatText { formatting, .. } => *formatting = normalize_text_formatting(formatting.clone())?,
    _ => {}
  }
  yjs::document_mutation::validate_mutation_fragment(mutation)
    .map_err(|_| AuthError::InvalidInput("MIX_DOCUMENT_MUTATION_FRAGMENT_INVALID".into()))
}

/// Normalize the shipped Markdown input boundary into the semantic fragment
/// consumed by direct mutations. The existing document is never exported to
/// Markdown and the temporary import document is never persisted.
pub fn document_fragment_from_markdown(markdown: &str) -> AuthResult<DocumentFragment> {
  let imported = crate::markdown::prepare_markdown_import("Fragment", markdown)
    .map_err(|_| AuthError::InvalidInput("MIX_DOCUMENT_MUTATION_MARKDOWN_INVALID".to_string()))?;
  document_fragment_from_yjs(&imported.yjs_binary)
}

/// Payload-free normalization findings. Paths address the input projection,
/// never a referenced document or an inaccessible target's metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFragmentDiagnostic {
  pub code: String,
  pub source_path: String,
  pub source_kind: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFragmentDiagnostics {
  pub diagnostics: Vec<DocumentFragmentDiagnostic>,
  pub diagnostic_count: usize,
}

impl DocumentFragmentDiagnostics {
  pub const MAX_DIAGNOSTICS: usize = 100;

  pub fn record(&mut self, code: &str, source_path: &str, source_kind: &str) {
    self.diagnostic_count += 1;
    if self.diagnostics.len() < Self::MAX_DIAGNOSTICS {
      self.diagnostics.push(DocumentFragmentDiagnostic {
        code: code.into(),
        source_path: source_path.into(),
        source_kind: source_kind.into(),
      });
    }
  }

  /// Parser findings and later native-to-fragment loss share one bounded
  /// result. Strict callers reject on the total, including truncated findings.
  pub fn record_markdown(&mut self, findings: &[yjs::MarkdownDiagnostic]) {
    for finding in findings {
      self.record(&format!("markdown_{:?}", finding.code), "content_markdown", "markdown");
    }
  }
}

/// Project a snapshot using the existing owner, retaining actual normalization
/// loss. Native definition identities remain fragment-local until insertion;
/// typed citation payloads and authored callout properties stay attached.
pub fn document_fragment_from_yjs_with_diagnostics(
  yjs_binary: &[u8],
) -> AuthResult<(DocumentFragment, DocumentFragmentDiagnostics)> {
  crate::document_fields::validate_snapshot(yjs_binary)?;
  if !yjs::document_field::content::inspect(yjs_binary)
    .map_err(|_| AuthError::InvalidInput("MIX_DOCUMENT_FIELD_INVALID".into()))?
    .is_empty()
  {
    // This existing fragment schema cannot express native fields. Native copy
    // owners preserve them; a lossy reading-IR conversion must not erase them.
    return Err(AuthError::InvalidInput(
      "MIX_DOCUMENT_MUTATION_UNSUPPORTED_NATIVE_FIELDS".into(),
    ));
  }
  let ir = myoxus_public_render::document_from_yjs(Uuid::nil(), Uuid::nil(), "Fragment", "Private", yjs_binary)
    .map_err(|_| AuthError::InvalidInput("MIX_DOCUMENT_MUTATION_MARKDOWN_INVALID".to_string()))?;
  let mut findings = DocumentFragmentDiagnostics::default();
  for (index, block) in ir.document.blocks.iter().enumerate() {
    collect_fragment_diagnostics(block, &format!("blocks/{index}"), &ir.native_citations, &mut findings);
  }
  for finding in &ir.diagnostics {
    // Unsupported blocks already have a concrete omission finding. Retain
    // every remaining projection flag. Supported private citation cards do
    // not make an otherwise complete fragment lossy.
    if finding.code != "unsupported_block" && !(finding.code == "partial_yjs_extraction" && !ir.mutation_partial) {
      findings.record(&finding.code, "projection", "native_projection");
    }
  }
  Ok((
    DocumentFragment {
      schema_version: yjs::DOCUMENT_FRAGMENT_SCHEMA.to_string(),
      blocks: ir
        .document
        .blocks
        .iter()
        .flat_map(|block| fragment_blocks_from_ir(block, &ir.native_citations))
        .collect(),
    },
    findings,
  ))
}

/// Existing callers retain their fragment-only contract. MCP authoring consumes
/// the diagnostic variant to make normalization loss explicit before writes.
pub fn document_fragment_from_yjs(yjs_binary: &[u8]) -> AuthResult<DocumentFragment> {
  document_fragment_from_yjs_with_diagnostics(yjs_binary).map(|(fragment, _)| fragment)
}

fn collect_fragment_diagnostics(
  block: &myoxus_public_render::Block,
  path: &str,
  citations: &std::collections::BTreeMap<String, (String, serde_json::Value)>,
  findings: &mut DocumentFragmentDiagnostics,
) {
  use myoxus_public_render::Block;
  if citations.contains_key(block.block_id()) {
    return;
  }
  match block {
    Block::UnsupportedBlock { .. } => findings.record("omitted_unsupported_block", path, "unsupported_block"),
    Block::TablePlaceholder { .. } => findings.record("omitted_table_placeholder", path, "table_placeholder"),
    Block::Callout { children, .. } | Block::FootnoteDefinition { children, .. } => {
      for (index, child) in children.iter().enumerate() {
        collect_fragment_diagnostics(child, &format!("{path}/children/{index}"), citations, findings);
      }
    }
    Block::List { list, .. } => {
      for (item_index, item) in list.items.iter().enumerate() {
        for (index, child) in item.children.iter().enumerate() {
          collect_fragment_diagnostics(
            child,
            &format!("{path}/items/{item_index}/children/{index}"),
            citations,
            findings,
          );
        }
      }
    }
    _ => {}
  }
}

fn fragment_blocks_from_ir(
  block: &myoxus_public_render::Block,
  citations: &std::collections::BTreeMap<String, (String, serde_json::Value)>,
) -> Vec<DocumentFragmentBlock> {
  use myoxus_public_render::{Block, PublicListKind};
  if let Some((label, reference)) = citations.get(block.block_id()) {
    return vec![DocumentFragmentBlock::CitationDefinition {
      label: label.clone(),
      reference: reference.clone(),
    }];
  }
  let text = |parts: &[myoxus_public_render::InlineText]| {
    parts
      .iter()
      .map(|part| DocumentTextSegment {
        text: part
          .native_footnote
          .as_ref()
          .map(|(_, placeholder)| placeholder.clone())
          .unwrap_or_else(|| {
            part
              .latex
              .as_ref()
              .map(|(_, placeholder, _)| placeholder.clone())
              .unwrap_or_else(|| part.text.clone())
          }),
        bold: part.bold,
        italic: part.italic,
        strike: part.strike,
        // Reading renders formulas as code; only the retained native mark may
        // become an actual code attribute when copying the native atom.
        code: part
          .latex
          .as_ref()
          .map_or(part.code, |(_, _, attrs)| attrs["code"].as_bool().unwrap_or(false)),
        latex: part.latex.as_ref().map(|(source, _, _)| source.clone()),
        // A plain formula needs no extra provenance: keep its shipped semantic
        // payload/replay identity unchanged. Additional native attributes do.
        native_latex_attributes: part
          .latex
          .as_ref()
          .and_then(|(_, _, attrs)| attrs.as_object().filter(|attrs| attrs.len() > 1).map(|_| attrs.clone())),
        link: part.link.clone(),
        reference: part.reference.clone(),
        footnote: part.native_footnote.as_ref().map(|(payload, _)| payload.clone()),
        ..Default::default()
      })
      .collect()
  };
  match block {
    Block::Paragraph { text: value, .. } => vec![DocumentFragmentBlock::Paragraph {
      properties: None,
      text: text(value),
    }],
    Block::Heading { level, text: value, .. } => vec![DocumentFragmentBlock::Heading {
      properties: None,
      level: *level,
      text: text(value),
    }],
    Block::List { list, .. } => list
      .items
      .iter()
      .map(|item| DocumentFragmentBlock::ListItem {
        properties: None,
        list_kind: match list.kind {
          PublicListKind::Bulleted => DocumentListKind::Bulleted,
          PublicListKind::Numbered => DocumentListKind::Numbered,
          PublicListKind::Todo => DocumentListKind::Todo,
        },
        text: text(&item.text),
        checked: item.todo_checked.unwrap_or(false),
        children: item
          .children
          .iter()
          .flat_map(|child| fragment_blocks_from_ir(child, citations))
          .collect(),
      })
      .collect(),
    Block::Quote { text: value, .. } => vec![DocumentFragmentBlock::Quote {
      properties: None,
      text: text(value),
    }],
    Block::Callout {
      native_callout,
      text: value,
      children,
      ..
    } => vec![DocumentFragmentBlock::Callout {
      properties: None,
      text: text(value),
      callout_type: native_callout.kind.clone(),
      title: native_callout.title.clone(),
      foldable: native_callout.foldable,
      default_open: native_callout.default_open,
      children: children
        .iter()
        .flat_map(|child| fragment_blocks_from_ir(child, citations))
        .collect(),
    }],
    Block::FootnoteDefinition {
      block_id,
      label,
      placement,
      children,
      ..
    } => vec![DocumentFragmentBlock::FootnoteDefinition {
      definition_id: block_id.clone(),
      label: label.clone(),
      placement: *placement,
      children: children
        .iter()
        .flat_map(|child| fragment_blocks_from_ir(child, citations))
        .collect(),
    }],
    Block::Code {
      native_latex,
      language,
      text: value,
      ..
    } => vec![DocumentFragmentBlock::Code {
      properties: None,
      native_latex: *native_latex,
      language: language.clone().unwrap_or_default(),
      text: value.clone(),
    }],
    Block::Mermaid {
      source, title, caption, ..
    } => vec![DocumentFragmentBlock::Mermaid {
      source: source.clone(),
      title: title.clone(),
      caption: caption.clone(),
    }],
    Block::Divider { .. } => vec![DocumentFragmentBlock::Divider],
    Block::Image { asset, .. } => vec![DocumentFragmentBlock::Image {
      source: asset.source.clone(),
      alt: asset.alt.clone(),
    }],
    Block::BookmarkCard { url, title, .. } => vec![DocumentFragmentBlock::Bookmark {
      url: url.clone(),
      title: title.clone(),
    }],
    Block::Table { rows, header_rows, .. } => vec![DocumentFragmentBlock::Table {
      properties: None,
      header_rows: *header_rows,
      rows: rows
        .iter()
        .map(|row| row.iter().map(|cell| text(cell)).collect())
        .collect(),
    }],
    Block::TablePlaceholder { .. } | Block::UnsupportedBlock { .. } => Vec::new(),
  }
}

#[derive(Clone)]
pub struct DocumentContentMutationService {
  store: Arc<dyn DocStore>,
  compaction: Arc<DocCompactionService>,
  cache: Option<Arc<dyn DocCachePort>>,
}

impl DocumentContentMutationService {
  pub fn new(store: Arc<dyn DocStore>, compaction: Arc<DocCompactionService>) -> Self {
    Self {
      store,
      compaction,
      cache: None,
    }
  }

  pub fn with_doc_cache(mut self, cache: Arc<dyn DocCachePort>) -> Self {
    self.cache = Some(cache);
    self
  }

  /// Apply one operation to the latest locked document state.
  ///
  /// `replace_all` is the only operation that requires explicit destructive
  /// confirmation. Its recovery snapshot is captured in the same transaction
  /// before the new delta is appended.
  #[instrument(skip(self, mutation), fields(%workspace_id, %doc_id, operation = mutation.name()))]
  pub async fn mutate(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_user_id: Option<Uuid>,
    mut mutation: DocumentMutation,
    confirm_replace_all: bool,
    expected_sequence: Option<i64>,
  ) -> AuthResult<DocContentMutationCommit> {
    normalize_document_mutation(&mut mutation)?;
    let destructive = matches!(mutation, DocumentMutation::ReplaceAll { .. });
    if destructive && !confirm_replace_all {
      return Err(AuthError::InvalidInput(
        "MIX_DOCUMENT_REPLACE_ALL_CONFIRMATION_REQUIRED".to_string(),
      ));
    }
    let operation = mutation.name();
    let committed = self
      .store
      .mutate_content(
        workspace_id,
        doc_id,
        actor_user_id,
        mutation,
        destructive,
        expected_sequence,
      )
      .await?;
    if let Some(cache) = &self.cache {
      cache.invalidate_snapshot(workspace_id, doc_id).await;
      cache.invalidate_metadata(doc_id).await;
      cache.invalidate_timestamps(workspace_id).await;
    }
    if let Err(error) = self.compaction.maybe_compact(workspace_id, doc_id).await {
      warn!(
        %workspace_id,
        %doc_id,
        operation,
        error = %error,
        "post-mutation document compaction failed; the next write will retry"
      );
    }
    info!(
      %workspace_id,
      %doc_id,
      operation,
      sequence = committed.sequence,
      inserted_blocks = committed.inserted_block_ids.len(),
      removed_blocks = committed.removed_block_ids.len(),
      recovery_history = committed.recovery_history_id.is_some(),
      "semantic document mutation committed"
    );
    Ok(committed)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn native_formula_projection_preserves_coalesced_formatting() {
    for code in [false, true] {
      let mut builder = yjs::YjsDocumentBuilder::new("Native formula");
      let mut atom = yjs::YjsTextSegment::plain(" ");
      atom.latex = Some("x^2".into());
      atom.bold = true;
      atom.italic = true;
      atom.strike = true;
      atom.code = code;
      atom.underline = true;
      atom.color = Some("var(--myoxus-text-highlight-foreground-red)".into());
      atom.background = Some("var(--myoxus-text-highlight-blue)".into());
      atom.label_tone = Some("accent".into());
      atom.link = Some("https://example.test/formula".into());
      builder.push_paragraph(&[
        yjs::YjsTextSegment::plain("before"),
        atom.clone(),
        atom,
        yjs::YjsTextSegment::plain("after"),
      ]);
      let original = builder.encode();
      let fragment = document_fragment_from_yjs(&original).unwrap();
      let DocumentFragmentBlock::Paragraph { text, .. } = &fragment.blocks[0] else {
        panic!("paragraph")
      };
      let atom = text.iter().find(|span| span.latex.is_some()).unwrap();
      assert_eq!(atom.text, "  ");
      assert!(atom.bold && atom.italic && atom.strike);
      assert_eq!(atom.code, code, "reading-only code must not rewrite the native mark");
      let attrs = atom.native_latex_attributes.as_ref().unwrap();
      assert_eq!(attrs["underline"], true);
      assert_eq!(attrs["color"], "var(--myoxus-text-highlight-foreground-red)");
      assert_eq!(attrs["background"], "var(--myoxus-text-highlight-blue)");
      assert_eq!(attrs["labelTone"], "accent");
      assert_eq!(attrs["link"], "https://example.test/formula");
      let copied = yjs::apply_document_mutation(
        &yjs::YjsDocumentBuilder::new("Copy").encode(),
        &DocumentMutation::ReplaceAll {
          fragment: fragment.clone(),
        },
      )
      .unwrap();
      assert_eq!(document_fragment_from_yjs(&copied.state).unwrap(), fragment);
    }
  }

  #[test]
  fn targeted_formatting_uses_canonical_link_validation_and_redacted_failures() {
    let set = |href: &str| DocumentTextFormatting {
      link: Some(DocumentTextLinkChange::Set { href: href.into() }),
      ..Default::default()
    };
    assert_eq!(
      normalize_text_formatting(set(" HTTPS://example.test ")).unwrap().link,
      Some(DocumentTextLinkChange::Set {
        href: "https://example.test/".into()
      })
    );
    for href in [
      "javascript:privatePayload",
      "data:text/html,privatePayload",
      "http://127.0.0.1/privatePayload",
      "http://host.internal/privatePayload",
      "not a url privatePayload",
    ] {
      let error = normalize_text_formatting(set(href)).unwrap_err().to_string();
      assert!(error.contains("MIX_DOCUMENT_FORMATTING_LINK_INVALID"));
      assert!(!error.contains("privatePayload"));
    }
    assert!(
      normalize_text_formatting(set(&format!("https://example.test/{}", "é".repeat(1000)))).is_err(),
      "normalized href must retain its native byte bound"
    );
    assert!(normalize_text_formatting(DocumentTextFormatting::default()).is_err());
    assert!(
      normalize_text_formatting(DocumentTextFormatting {
        bold: Some(false),
        link: Some(DocumentTextLinkChange::Remove {}),
        ..Default::default()
      })
      .is_ok()
    );
  }
}
