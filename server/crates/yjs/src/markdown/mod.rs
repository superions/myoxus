// SPDX-License-Identifier: AGPL-3.0-or-later
//! Pure conversion between Markdown and canonical Virgultum Yjs documents.

mod annotation_syntax;
mod export;
mod import;
mod table_html;
mod targets;
mod types;

// Shared by import and export: a document that imports successfully must not
// immediately exceed the writer's existing recursion limit.
const MAX_BLOCK_DEPTH: usize = 100;

pub use annotation_syntax::markdown_annotation_ranges;
pub use import::markdown_callout_support;
pub use targets::{
  MarkdownNativeTarget, MarkdownTargetError, markdown_native_targets, markdown_native_targets_with_references,
  resolve_markdown_target, valid_markdown_anchor, with_markdown_export_anchors,
};

pub(crate) use export::extract_formatted_text;
pub use export::{
  escape_markdown_destination, escape_markdown_label, escape_markdown_literal_text, escape_markdown_table_cell,
  extract_text_from_yjs, extract_text_from_yjs_with_image_filter, extract_text_from_yjs_with_references,
  extract_text_from_yjs_with_references_and_images,
};
pub use import::{
  markdown_to_yjs, markdown_to_yjs_with_link_resolver, markdown_to_yjs_with_references,
  markdown_to_yjs_with_reserved_blocks,
};
pub use types::{
  MarkdownDiagnostic, MarkdownDiagnosticCode, MarkdownDocumentReference, MarkdownImportResult, MarkdownLinkResolution,
  MarkdownLinkTarget, MarkdownResolvedReference, YjsExtractResult,
};

#[cfg(test)]
mod tests;

/// Raw block HTML had no historical Markdown import receipt. Inline GFM cell
/// breaks and fenced/literal HTML retain their existing replay classification.
pub fn markdown_contains_html_blocks(source: &str) -> bool {
  use pulldown_cmark::{Event, Options, Parser, Tag};
  Parser::new_ext(source, Options::ENABLE_TABLES)
    .any(|event| matches!(event, Event::Start(Tag::HtmlBlock) | Event::Html(_)))
}

// Native source cards and inline citations share the deployed codec comparison.
pub(crate) use import::{canonical_citation_reference, normalize_footnote_label, valid_footnote_label};

/// Read the typed definition retained by an existing native citation source card.
pub fn native_citation_definition<T: yrs::ReadTxn>(
  block: &yrs::MapRef,
  txn: &T,
) -> Option<(String, serde_json::Value)> {
  use yrs::Map;
  let property = |key: &str| {
    block
      .get(txn, &format!("prop:{key}"))
      .or_else(|| block.get(txn, key))
      .and_then(|value| match value {
        yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
        yrs::Out::YText(value) => Some(yrs::GetString::get_string(&value, txn)),
        _ => None,
      })
  };
  if property("style").as_deref() != Some("citation") {
    return None;
  }
  let label = property("footnoteIdentifier")?;
  let flavour = block.get(txn, "sys:flavour").or_else(|| block.get(txn, "flavour"))?;
  let yrs::Out::Any(yrs::Any::String(flavour)) = flavour else {
    return None;
  };
  let kind = match crate::resolve_flavour(&flavour) {
    "myoxus:bookmark" => "url",
    "myoxus:embed-linked-doc" => "doc",
    "myoxus:attachment" => "attachment",
    _ => return None,
  };
  let mut reference = serde_json::Map::new();
  reference.insert("type".into(), kind.into());
  for (field, prop) in [
    ("url", "url"),
    ("docId", "pageId"),
    ("workspaceId", "workspaceId"),
    ("blobId", "sourceId"),
    ("fileName", "name"),
    ("fileType", "type"),
    ("title", "title"),
    ("description", "description"),
    ("favicon", "icon"),
  ] {
    if let Some(value) = property(prop) {
      reference.insert(field.into(), value.into());
    }
  }
  Some((label, reference.into()))
}

pub(crate) fn write_native_citation_definition(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  id: &str,
  label: &str,
  reference: &serde_json::Value,
) {
  use yrs::Map;
  let flavour = match reference["type"].as_str() {
    Some("url") => "myoxus:bookmark",
    Some("doc") => "myoxus:embed-linked-doc",
    _ => "myoxus:attachment",
  };
  let (block, _) = crate::create_yjs_block(blocks, txn, id, flavour);
  block.insert(txn, "prop:style", "citation");
  block.insert(txn, "prop:footnoteIdentifier", label);
  for (field, prop) in [
    ("url", "url"),
    ("docId", "pageId"),
    ("workspaceId", "workspaceId"),
    ("blobId", "sourceId"),
    ("fileName", "name"),
    ("fileType", "type"),
    ("title", "title"),
    ("description", "description"),
    ("favicon", "icon"),
  ] {
    if let Some(value) = reference[field].as_str() {
      block.insert(txn, format!("prop:{prop}"), value);
    }
  }
}
