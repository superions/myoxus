// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canonical Markdown-to-Yjs import.

use super::super::*;

const MARKDOWN_HIGHLIGHT_BACKGROUND: &str = "var(--myoxus-text-highlight-yellow)";

fn display_formula(value: &str) -> &str {
  // The parser includes the delimiter lines' boundary newlines; they are not
  // part of the native formula (remark-math uses the same body representation).
  let value = value.strip_prefix('\n').unwrap_or(value);
  value.strip_suffix('\n').unwrap_or(value)
}

/// Validate formula delimiters through the same parser before emitting native
/// Markdown. A formula containing a closing delimiter stays complete literal
/// source with a finding, rather than creating adjacent accidental content.
pub(super) fn serialize_math(formula: &str, display: bool) -> Option<String> {
  use pulldown_cmark::{Event, Options, Parser};
  let source = if display {
    format!("$$\n{formula}\n$$")
  } else {
    format!("${formula}$")
  };
  let mut events =
    Parser::new_ext(&source, Options::ENABLE_MATH).filter(|event| !matches!(event, Event::Start(_) | Event::End(_)));
  let valid = match events.next()? {
    Event::InlineMath(value) => !display && !formula.contains('\n') && value.as_ref() == formula,
    Event::DisplayMath(value) => display && display_formula(value.as_ref()) == formula,
    _ => false,
  };
  (valid && events.next().is_none()).then_some(source)
}

pub(crate) fn normalize_footnote_label(label: &str) -> String {
  label
    .split(['\t', '\n', '\r', ' '])
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase()
    .to_uppercase()
    .to_lowercase()
}

/// Newly authored labels are admitted through the existing Markdown parser,
/// matching the editor's parser-based check: the label must round-trip as both
/// a footnote definition and a reference, and normalize to non-empty.
/// Normalization alone is not syntax validation.
pub(crate) fn valid_footnote_label(label: &str) -> bool {
  if normalize_footnote_label(label).is_empty() {
    return false;
  }
  let source = format!("[^{label}]: body\n\nreference[^{label}]");
  let mut definition = 0;
  let mut reference = 0;
  for event in pulldown_cmark::Parser::new_ext(&source, pulldown_cmark::Options::ENABLE_FOOTNOTES) {
    match event {
      pulldown_cmark::Event::Start(pulldown_cmark::Tag::FootnoteDefinition(value)) if value.as_ref() == label => {
        definition += 1;
      }
      pulldown_cmark::Event::FootnoteReference(value) if value.as_ref() == label => reference += 1,
      _ => {}
    }
  }
  definition == 1 && reference == 1
}

/// Only a complete text-only single paragraph can be deployed citation metadata.
fn citation_definition(
  events: &[(pulldown_cmark::Event<'_>, std::ops::Range<usize>)],
  label: &str,
) -> Result<Option<serde_json::Value>, String> {
  use pulldown_cmark::{Event, Tag, TagEnd};
  if !matches!(events.first(), Some((Event::Start(Tag::Paragraph), _)))
    || !matches!(events.last(), Some((Event::End(TagEnd::Paragraph), _)))
  {
    return Ok(None);
  }
  let mut text = String::new();
  for (event, _) in &events[1..events.len() - 1] {
    if let Event::Text(value) = event {
      text.push_str(value);
    } else if matches!(event, Event::SoftBreak) {
      text.push('\n');
    } else {
      return Ok(None);
    }
  }
  let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else {
    let kind_prefix = text
      .trim_start()
      .strip_prefix('{')
      .and_then(|text| text.split_once("\"type\"").map(|(_, suffix)| suffix))
      .map(str::trim_start)
      .and_then(|text| text.strip_prefix(':'))
      .map(str::trim_start);
    if kind_prefix.is_some_and(|prefix| {
      ["\"doc\"", "\"attachment\"", "\"url\""]
        .iter()
        .any(|kind| prefix.starts_with(kind))
    }) {
      return Err(format!("Invalid citation definition: {label}"));
    }
    return Ok(None);
  };
  let Some(kind) = value.get("type") else {
    return Ok(None);
  };
  if !matches!(kind.as_str(), Some("doc" | "attachment" | "url"))
    && !["docId", "blobId", "url"].iter().any(|key| value.get(key).is_some())
  {
    return Ok(None);
  }
  value = canonical_citation_reference(&value, label)?;
  for key in ["url", "favicon"] {
    if let Some(source) = value[key].as_str()
      && !source.contains(':')
      && source.contains('%')
    {
      let bytes = source.as_bytes();
      let mut decoded = Vec::new();
      let mut index = 0;
      while index < bytes.len() {
        if bytes[index] == b'%' {
          let hex = bytes
            .get(index + 1..index + 3)
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            .ok_or_else(|| format!("Invalid citation URL encoding: {label}"))?;
          decoded.push(hex);
          index += 3;
        } else {
          decoded.push(bytes[index]);
          index += 1;
        }
      }
      value[key] = serde_json::Value::String(
        String::from_utf8(decoded).map_err(|_| format!("Invalid citation URL encoding: {label}"))?,
      );
    }
  }
  Ok(Some(value))
}

pub(super) fn validate_citation_reference(value: &serde_json::Value, label: &str) -> Result<(), String> {
  let (target, fields): (&str, &[&str]) = match value.get("type").and_then(|kind| kind.as_str()) {
    Some("doc") => ("docId", &["type", "docId", "workspaceId", "title", "description"]),
    Some("attachment") => (
      "blobId",
      &[
        "type",
        "blobId",
        "workspaceId",
        "fileName",
        "fileType",
        "title",
        "description",
      ],
    ),
    Some("url") => ("url", &["type", "url", "favicon", "title", "description"]),
    _ => return Err(format!("Invalid citation definition: {label}")),
  };
  if value
    .get(target)
    .and_then(|target| target.as_str())
    .is_none_or(|target| target.trim().is_empty())
  {
    return Err(format!("Missing citation target: {label}"));
  }
  // Validate before canonicalization can discard unknown or incompatible input.
  if value.as_object().is_none_or(|object| {
    object
      .iter()
      .any(|(key, value)| !fields.contains(&key.as_str()) || !value.is_string())
  }) {
    return Err(format!("Invalid citation definition: {label}"));
  }
  Ok(())
}

/// Match the deployed client schema's field projection and stable writer order.
/// Yjs maps have no iteration order; serializing them directly changes Git
/// baselines even when the document's citation content has not changed.
pub(crate) fn canonical_citation_reference(
  value: &serde_json::Value,
  label: &str,
) -> Result<serde_json::Value, String> {
  validate_citation_reference(value, label)?;
  let mut fields = serde_json::Map::new();
  for key in [
    "type",
    "docId",
    "workspaceId",
    "blobId",
    "fileName",
    "fileType",
    "url",
    "favicon",
    "title",
    "description",
  ] {
    if let Some(value) = value.get(key) {
      fields.insert(key.to_string(), value.clone());
    }
  }
  Ok(serde_json::Value::Object(fields))
}

struct CalloutHeader {
  range: std::ops::Range<usize>,
  header_end: usize,
  title: String,
  kind: String,
  foldable: bool,
  default_open: bool,
  supported: bool,
}

fn callout_headers(
  source: &str,
  events: &[(pulldown_cmark::Event<'_>, std::ops::Range<usize>)],
  annotations: &super::annotation_syntax::AnnotationSource,
) -> Vec<CalloutHeader> {
  use pulldown_cmark::{Event, Tag, TagEnd};
  let mut found: Vec<CalloutHeader> = Vec::new();
  let mut active: Vec<Option<usize>> = Vec::new();
  let mut container_depth = 2;
  for (event, range) in events {
    match event {
      Event::Start(Tag::BlockQuote(_) | Tag::Item | Tag::FootnoteDefinition(_)) => container_depth += 1,
      Event::End(TagEnd::BlockQuote(_) | TagEnd::Item | TagEnd::FootnoteDefinition) => container_depth -= 1,
      _ => {}
    }
    if container_depth > super::MAX_BLOCK_DEPTH {
      for index in active.iter().flatten() {
        found[*index].supported = false;
      }
    }
    match event {
      Event::Start(Tag::BlockQuote(_)) => {
        let line = source[range.clone()].lines().next().unwrap_or_default();
        let header = line.trim_start().strip_prefix('>').unwrap_or("").trim_start();
        if let Some(rest) = header.strip_prefix("[!")
          && let Some((kind, suffix)) = rest.split_once(']')
        {
          let supported = kind.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && kind
              .bytes()
              .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
          active.push(Some(found.len()));
          found.push(CalloutHeader {
            range: range.clone(),
            header_end: source[range.clone()]
              .find('\n')
              .map(|offset| range.start + offset + 1)
              .unwrap_or(range.end),
            title: suffix.strip_prefix(['+', '-']).unwrap_or(suffix).trim().to_string(),
            kind: kind.to_string(),
            foldable: suffix.starts_with(['+', '-']),
            default_open: !suffix.starts_with('-'),
            supported: supported && container_depth <= super::MAX_BLOCK_DEPTH,
          });
        } else {
          active.push(None);
        }
      }
      Event::End(TagEnd::BlockQuote(_)) => {
        active.pop();
      }
      Event::Start(Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Fenced(code)))
        if code.eq_ignore_ascii_case("mermaid") =>
      {
        for index in active.iter().flatten() {
          found[*index].supported = false;
        }
      }
      Event::Start(Tag::Table(_) | Tag::HtmlBlock | Tag::Image { .. })
      | Event::Rule
      | Event::DisplayMath(_)
      | Event::Html(_)
      | Event::InlineHtml(_) => {
        for index in active.iter().flatten() {
          found[*index].supported = false;
        }
      }
      Event::Text(text)
        if text.contains("![[") && source[range.clone()] == **text && annotations.at(range).is_none() =>
      {
        for index in active.iter().flatten() {
          if range.start >= found[*index].header_end {
            found[*index].supported = false;
          }
        }
      }
      _ => {}
    }
  }
  found
}

/// The Vault inventory reuses codec-owned recognition, including rejected kinds.
pub fn markdown_callout_support(source: &str) -> (usize, usize) {
  let options = pulldown_cmark::Options::ENABLE_STRIKETHROUGH
    | pulldown_cmark::Options::ENABLE_TABLES
    | pulldown_cmark::Options::ENABLE_TASKLISTS
    | pulldown_cmark::Options::ENABLE_MATH
    | pulldown_cmark::Options::ENABLE_FOOTNOTES;
  let annotations = super::annotation_syntax::prepare(source, options);
  let events: Vec<_> = pulldown_cmark::Parser::new_ext(&annotations.source, options)
    .into_offset_iter()
    .collect();
  let found = callout_headers(source, &events, &annotations);
  (
    found.iter().filter(|note| note.supported).count(),
    found.iter().filter(|note| !note.supported).count(),
  )
}

fn standalone_annotation_body<'a>(
  segments: &'a [YjsTextSegment],
  source: &super::annotation_syntax::AnnotationSource,
  range: &std::ops::Range<usize>,
) -> Option<&'a str> {
  let mut annotations = segments.iter().filter(|segment| segment.annotation.is_some());
  let annotation = annotations.next()?;
  if annotations.next().is_some()
    || segments.iter().any(|segment| {
      segment.annotation.is_none()
        && (!segment.text.trim().is_empty()
          || segment.reference.is_some()
          || segment.footnote.is_some()
          || segment.image_source.is_some())
    })
  {
    return None;
  }
  source
    .contained(range)
    .any(|span| span.standalone)
    .then_some(annotation.text.as_str())
}

/// Finds paired Obsidian highlight delimiters only in parser-owned text
/// events. Code events never enter this scan, and an unmatched delimiter is
/// deliberately left literal.
fn paired_highlight_delimiters(
  events: &[(pulldown_cmark::Event<'_>, std::ops::Range<usize>)],
  source: &str,
) -> std::collections::HashSet<usize> {
  use pulldown_cmark::{Event, TagEnd};

  let mut paired = std::collections::HashSet::new();
  let mut opening = None;
  for (event, range) in events {
    if let Event::Text(displayed) = event {
      let raw = &source[range.clone()];
      // Offset-to-visible-text mapping is exact for ordinary text. Escaped or
      // entity-decoded text stays literal unless delimiters occur in separate
      // parser events around it.
      if raw == displayed.as_ref() {
        let bytes = raw.as_bytes();
        let mut index = 0;
        while index + 1 < bytes.len() {
          if bytes[index] != b'=' || bytes[index + 1] != b'=' {
            index += 1;
            continue;
          }
          let global = range.start + index;
          let escaped = source[..global].bytes().rev().take_while(|byte| *byte == b'\\').count() % 2 == 1;
          let adjacent_equals = global.checked_sub(1).and_then(|offset| source.as_bytes().get(offset)) == Some(&b'=')
            || source.as_bytes().get(global + 2) == Some(&b'=');
          if escaped || adjacent_equals {
            index += 2;
            continue;
          }
          let previous = global
            .checked_sub(1)
            .and_then(|offset| source.as_bytes().get(offset))
            .copied();
          let next = source.as_bytes().get(global + 2).copied();
          if let Some(open) = opening {
            if previous.is_some_and(|byte| !byte.is_ascii_whitespace()) {
              paired.insert(open);
              paired.insert(global);
              opening = None;
            }
          } else if next.is_some_and(|byte| !byte.is_ascii_whitespace()) {
            opening = Some(global);
          }
          index += 2;
        }
      }
    }
    if matches!(
      event,
      Event::End(TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::TableCell | TagEnd::Item | TagEnd::CodeBlock)
    ) {
      opening = None;
    }
  }
  paired
}

fn highlighted_text_parts(
  source: &str,
  displayed: &str,
  range: &std::ops::Range<usize>,
  paired: &std::collections::HashSet<usize>,
  highlighted: &mut bool,
) -> Vec<(String, bool)> {
  let raw = &source[range.clone()];
  if raw != displayed || !paired.iter().any(|offset| range.contains(offset)) {
    return vec![(displayed.to_string(), *highlighted)];
  }
  let mut parts = Vec::new();
  let mut start = 0;
  let mut index = 0;
  while index + 1 < raw.len() {
    let global = range.start + index;
    if paired.contains(&global) {
      if start < index {
        parts.push((raw[start..index].to_string(), *highlighted));
      }
      *highlighted = !*highlighted;
      index += 2;
      start = index;
    } else {
      index += 1;
    }
  }
  if start < raw.len() {
    parts.push((raw[start..].to_string(), *highlighted));
  }
  parts
}

/// Convert Markdown to a minimal Virgultum-compatible Yjs binary document.
///
/// Generates a document with `affine:page` as root, containing `affine:note`
/// as a container, and individual blocks for paragraphs, headings, code,
/// lists, dividers, and blockquotes. Inline formatting (bold, italic,
/// strikethrough, code, links) is preserved as YText attributes.
///
/// **Limitations**: Rich content (whiteboards, databases, embeds) cannot be
/// generated from Markdown. Standalone Markdown images are generated as native
/// `myoxus:image` blocks; inline/table images stay as Markdown text so mixed
/// content is preserved instead of being split into surprising blocks.
#[instrument(skip(markdown))]
pub fn markdown_to_yjs(title: &str, markdown: &str) -> Result<Vec<u8>, String> {
  markdown_to_yjs_with_references(title, markdown, &|_| None)
}

impl YjsDocumentBuilder {
  /// Source anchors are provenance, not native IDs, and travel with the block.
  fn set_markdown_anchor(&mut self, id: &str, anchor: &str) {
    let mut txn = self.doc.transact_mut();
    if let Some(yrs::Out::YMap(block)) = self.blocks.get(&txn, id) {
      block.insert(&mut txn, "prop:markdownAnchor", anchor);
    }
  }
}

/// Convert Markdown and replace caller-authorized document URLs with native
/// editor references. Resolution is bounded to this conversion operation.
#[instrument(skip(markdown, resolve_reference))]
pub fn markdown_to_yjs_with_references(
  title: &str,
  markdown: &str,
  resolve_reference: &dyn Fn(&str) -> Option<super::MarkdownDocumentReference>,
) -> Result<Vec<u8>, String> {
  markdown_to_yjs_with_link_resolver(title, markdown, &|target| match target {
    super::MarkdownLinkTarget::Url(url) => resolve_reference(url)
      .map(super::MarkdownLinkResolution::Reference)
      .unwrap_or(super::MarkdownLinkResolution::Ordinary),
    super::MarkdownLinkTarget::Wiki(target) if target.contains('#') => super::MarkdownLinkResolution::Unsupported,
    super::MarkdownLinkTarget::Wiki(_) => super::MarkdownLinkResolution::Unresolved,
  })
  .map(|result| result.yjs_binary)
}

/// Convert Markdown with one resolver for ordinary document URLs and wiki
/// targets. Syntax recognition stays in the codec; workspace policy stays in
/// the caller-supplied resolution result.
#[instrument(skip(markdown, title, resolve_link))]
pub fn markdown_to_yjs_with_link_resolver(
  title: &str,
  markdown: &str,
  resolve_link: &dyn Fn(super::MarkdownLinkTarget<'_>) -> super::MarkdownLinkResolution,
) -> Result<super::MarkdownImportResult, String> {
  import_with_reserved_blocks(title, markdown, resolve_link, None)
}

/// Reuse an operation-reserved body-block namespace in preflight and final import.
/// References retain real native IDs, never source offsets. Root containers are
/// still created normally: portable document references use the external doc key.
#[instrument(skip_all, fields(markdown_bytes = markdown.len()))]
pub fn markdown_to_yjs_with_reserved_blocks(
  title: &str,
  markdown: &str,
  import_id: uuid::Uuid,
  resolve_link: &dyn Fn(super::MarkdownLinkTarget<'_>) -> super::MarkdownLinkResolution,
) -> Result<super::MarkdownImportResult, String> {
  import_with_reserved_blocks(title, markdown, resolve_link, Some(import_id))
}

fn import_with_reserved_blocks(
  title: &str,
  markdown: &str,
  resolve_link: &dyn Fn(super::MarkdownLinkTarget<'_>) -> super::MarkdownLinkResolution,
  import_id: Option<uuid::Uuid>,
) -> Result<super::MarkdownImportResult, String> {
  use std::borrow::Cow;

  use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
  type TextSegment = YjsTextSegment;

  #[derive(Clone)]
  struct ImageCapture {
    dest_url: String,
    title_text: String,
    alt_text: String,
  }

  struct ListContext {
    ordered: bool,
    next_order: u64,
  }

  struct ItemContext {
    block_id: Option<String>,
    checked: Option<bool>,
    paragraph_count: usize,
  }

  struct QuoteContext {
    item_depth: usize,
    parent_id: Option<String>,
    last_quote_id: Option<String>,
    callout_id: Option<String>,
    has_own_body: bool,
    header_end: Option<usize>,
  }

  fn quote_parent(quotes: &[QuoteContext]) -> Option<String> {
    quotes.last().and_then(|quote| {
      quote
        .callout_id
        .clone()
        .or_else(|| quote.last_quote_id.clone())
        .or_else(|| quote.parent_id.clone())
    })
  }

  fn ensure_item(
    index: usize,
    builder: &mut YjsDocumentBuilder,
    lists: &mut [ListContext],
    items: &mut [ItemContext],
    quotes: &[QuoteContext],
  ) -> String {
    if let Some(id) = items[index].block_id.clone() {
      return id;
    }
    let parent = if index > 0 && !quotes.last().is_some_and(|quote| quote.item_depth == index) {
      Some(ensure_item(index - 1, builder, lists, items, quotes))
    } else {
      quote_parent(quotes)
    };
    let list = &mut lists[index];
    let order = list.ordered.then_some(list.next_order);
    if list.ordered {
      list.next_order += 1;
    }
    let id = builder.push_list_item_under(&[], list.ordered, order, items[index].checked, parent.as_deref());
    items[index].block_id = Some(id.clone());
    id
  }

  fn content_parent(
    builder: &mut YjsDocumentBuilder,
    lists: &mut [ListContext],
    items: &mut [ItemContext],
    quotes: &[QuoteContext],
  ) -> Option<String> {
    if quotes.last().is_some_and(|quote| quote.item_depth == items.len()) || items.is_empty() {
      quote_parent(quotes)
    } else {
      Some(ensure_item(items.len() - 1, builder, lists, items, quotes))
    }
  }

  fn push_segment(
    segments: &mut Vec<TextSegment>,
    text: String,
    bold: bool,
    italic: bool,
    strike: bool,
    code: bool,
    highlighted: bool,
    link: Option<String>,
    reference: Option<super::MarkdownDocumentReference>,
  ) {
    // Virgultum document references are atomic inline nodes. Their visible
    // label belongs to the reference payload; inserting the label as Y.Text
    // would make the client instantiate one broken reference per character.
    let text = if reference.is_some() { " ".to_string() } else { text };
    segments.push(TextSegment {
      text,
      bold,
      italic,
      strike,
      code,
      background: highlighted.then(|| MARKDOWN_HIGHLIGHT_BACKGROUND.to_string()),
      link,
      reference,
      annotation: None,
      latex: None,
      footnote: None,
      image_source: None,
      image_caption: None,
      ..Default::default()
    });
  }

  // An embed splits a paragraph into ordered native blocks. Use the same
  // paragraph owner for both fragments so list and quote nesting cannot drift.
  fn emit_paragraph(
    segments: &[TextSegment],
    builder: &mut YjsDocumentBuilder,
    lists: &mut [ListContext],
    items: &mut [ItemContext],
    quotes: &mut [QuoteContext],
    source_anchor: Option<&str>,
  ) {
    let mut anchored_segments = Cow::Borrowed(segments);
    let anchor = source_anchor.and_then(|anchor| take_source_anchor(anchored_segments.to_mut(), Some(anchor)));
    let segments = anchored_segments.as_ref();
    if !segments
      .iter()
      .any(|s| !s.text.trim().is_empty() || s.reference.is_some() || s.latex.is_some() || s.footnote.is_some())
      && anchor.is_none()
    {
      return;
    }
    let id = if quotes.is_empty()
      && lists.is_empty()
      && let Some((caption, source_id)) = parse_standalone_image_segment(segments)
    {
      builder.push_image(&source_id, &caption);
      None
    } else if let Some(quote) = quotes.last_mut().filter(|quote| quote.item_depth == items.len()) {
      if let Some(container_id) = quote.callout_id.as_ref().or(quote.last_quote_id.as_ref()) {
        if !quote.has_own_body {
          builder.set_container_body(container_id, segments);
          quote.has_own_body = true;
          Some(container_id.clone())
        } else {
          Some(builder.push_paragraph_under(segments, Some(container_id)))
        }
      } else {
        None
      }
    } else if !items.is_empty() {
      let index = items.len() - 1;
      let id = if items[index].paragraph_count == 0 && items[index].block_id.is_none() {
        let parent = if index > 0 && !quotes.last().is_some_and(|quote| quote.item_depth == index) {
          Some(ensure_item(index - 1, builder, lists, items, quotes))
        } else {
          quote_parent(quotes)
        };
        let list = &mut lists[index];
        let order = list.ordered.then_some(list.next_order);
        if list.ordered {
          list.next_order += 1;
        }
        let id = builder.push_list_item_under(segments, list.ordered, order, items[index].checked, parent.as_deref());
        items[index].block_id = Some(id.clone());
        id
      } else {
        let parent = ensure_item(index, builder, lists, items, quotes);
        builder.push_paragraph_under(segments, Some(&parent))
      };
      items[index].paragraph_count += 1;
      Some(id)
    } else {
      Some(builder.push_paragraph_under(segments, None))
    };
    if let (Some(id), Some(anchor)) = (id, anchor) {
      builder.set_markdown_anchor(&id, anchor);
    }
  }

  fn take_source_anchor<'a>(segments: &mut Vec<TextSegment>, anchor: Option<&'a str>) -> Option<&'a str> {
    let anchor = anchor?;
    let segment_count = segments.len();
    let segment = segments.last_mut()?;
    if segment.bold
      || segment.italic
      || segment.strike
      || segment.code
      || segment.background.is_some()
      || segment.link.is_some()
      || segment.reference.is_some()
      || segment.annotation.is_some()
      || segment.latex.is_some()
      || segment.footnote.is_some()
      || segment.image_source.is_some()
    {
      return None;
    }
    let prefix = segment.text.trim_end().strip_suffix(&format!("^{anchor}"))?;
    if !prefix.is_empty() && !prefix.ends_with(char::is_whitespace) {
      return None;
    }
    // A standalone marker must never manufacture an empty target block.
    if prefix.trim().is_empty() && segment_count == 1 {
      return None;
    }
    segment.text = prefix.trim_end().to_string();
    while segments
      .last()
      .is_some_and(|segment| segment.text.is_empty() && plain_anchor_segment(segment))
    {
      segments.pop();
    }
    if let Some(segment) = segments.last_mut().filter(|segment| plain_anchor_segment(segment)) {
      segment.text = segment.text.trim_end_matches([' ', '\t', '\n', '\r']).to_string();
    }
    Some(anchor)
  }

  fn plain_anchor_segment(segment: &TextSegment) -> bool {
    !segment.bold
      && !segment.italic
      && !segment.strike
      && !segment.code
      && segment.background.is_none()
      && segment.link.is_none()
      && segment.reference.is_none()
      && segment.annotation.is_none()
      && segment.latex.is_none()
      && segment.footnote.is_none()
      && segment.image_source.is_none()
  }

  fn parse_standalone_image_segment(segments: &[TextSegment]) -> Option<(String, String)> {
    if segments.len() != 1 {
      return None;
    }
    let segment = &segments[0];
    if segment.bold
      || segment.italic
      || segment.strike
      || segment.code
      || segment.background.is_some()
      || segment.link.is_some()
    {
      return None;
    }
    let source = segment.image_source.as_ref()?;
    if source.trim().is_empty() {
      return None;
    }
    Some((segment.image_caption.clone().unwrap_or_default(), source.clone()))
  }

  let mut builder = YjsDocumentBuilder::new(title);
  if let Some(import_id) = import_id {
    builder.import_id = import_id.simple().to_string();
  }

  // CommonMark treats CR, LF and CRLF as equivalent line endings, but the
  // parser version used here does not recognize a lone CR as a block boundary.
  // Replacing only lone CR bytes preserves source offsets and leaves CRLF and
  // serialized output untouched; the parser then applies one line-ending
  // model consistently to prose and code.
  let parser_markdown = if markdown
    .as_bytes()
    .windows(2)
    .any(|pair| pair[0] == b'\r' && pair[1] != b'\n')
    || markdown.as_bytes().last() == Some(&b'\r')
  {
    let mut normalized = String::with_capacity(markdown.len());
    let mut characters = markdown.chars().peekable();
    while let Some(character) = characters.next() {
      if character == '\r' && characters.peek() != Some(&'\n') {
        normalized.push('\n');
      } else {
        normalized.push(character);
      }
    }
    Cow::Owned(normalized)
  } else {
    Cow::Borrowed(markdown)
  };

  // Parse Markdown and create blocks
  let options = Options::ENABLE_STRIKETHROUGH
    | Options::ENABLE_TABLES
    | Options::ENABLE_TASKLISTS
    | Options::ENABLE_MATH
    | Options::ENABLE_FOOTNOTES;
  let annotation_source = super::annotation_syntax::prepare(parser_markdown.as_ref(), options);
  let parser_markdown = Cow::Borrowed(annotation_source.source.as_str());
  let parser = Parser::new_ext(parser_markdown.as_ref(), options);

  // State machine — segments track inline formatting instead of plain string
  let mut segments: Vec<TextSegment> = Vec::new();
  let mut in_code_block = false;
  let mut code_block_text = String::new();
  let mut code_lang = String::new();
  let mut heading_level: u32 = 0;
  let mut pending_source_anchor: Option<String> = None;
  let mut lists: Vec<ListContext> = Vec::new();
  let mut items: Vec<ItemContext> = Vec::new();
  let mut quotes: Vec<QuoteContext> = Vec::new();

  // Table import state. Active Virgultum tables are `isFlatData` blocks, so
  // Markdown tables are written as one `myoxus:table` with flat row/column/cell
  // props, not as paragraph rows.
  let mut in_table = false;
  let mut html_table: Option<String> = None;
  let mut table_rows: Vec<Vec<Vec<TextSegment>>> = Vec::new();
  let mut table_alignments: Vec<Option<String>> = Vec::new();
  let mut current_row_cells: Vec<Vec<TextSegment>> = Vec::new();
  let mut current_cell_segments: Vec<TextSegment> = Vec::new();

  // Inline formatting state
  let mut bold_active = false;
  let mut italic_active = false;
  let mut strike_active = false;
  let mut highlight_active = false;
  let mut link_url: Option<String> = None;
  let mut link_reference: Option<super::MarkdownDocumentReference> = None;
  let mut image_capture: Option<ImageCapture> = None;
  let mut native_math_count = 0;
  let mut diagnostics: Vec<_> = annotation_source
    .unsupported
    .iter()
    .map(|_| super::MarkdownDiagnostic {
      code: super::MarkdownDiagnosticCode::UnsupportedAnnotation,
    })
    .collect();

  let mut events: Vec<(Event, std::ops::Range<usize>)> = Vec::new();
  for (event, range) in parser.into_offset_iter() {
    if let Event::Text(text) = &event {
      let contained: Vec<_> = annotation_source
        .contained(&range)
        .filter(|span| span.standalone || !span.body.is_empty())
        .collect();
      if !contained.is_empty() && text.as_ref() == &parser_markdown[range.clone()] {
        let mut start = range.start;
        for span in contained {
          if start < span.range.start {
            events.push((
              Event::Text(parser_markdown[start..span.range.start].into()),
              start..span.range.start,
            ));
          }
          events.push((
            Event::Text(parser_markdown[span.range.clone()].into()),
            span.range.clone(),
          ));
          start = span.range.end;
        }
        if start < range.end {
          events.push((Event::Text(parser_markdown[start..range.end].into()), start..range.end));
        }
        continue;
      }
    }
    if let Event::Text(text) = &event
      && let Some((Event::Text(previous), previous_range)) = events.last_mut()
      && previous_range.end == range.start
      && annotation_source.at(previous_range).is_none()
    {
      let mut combined = previous.to_string();
      combined.push_str(text);
      *previous = combined.into();
      previous_range.end = range.end;
      continue;
    }
    events.push((event, range));
  }
  // Definition admission precedes block/asset writes. The same event stream
  // feeds ordinary child writers; no body is flattened or reparsed as a string.
  let mut definitions: Vec<(String, String, Option<serde_json::Value>, Option<String>)> = Vec::new();
  let mut definition_start = None;
  for (index, (event, _)) in events.iter().enumerate() {
    match event {
      Event::Start(Tag::FootnoteDefinition(label)) => {
        if definition_start.is_some() {
          return Err(format!("Nested footnote definition: {label}"));
        }
        definition_start = Some((index, label.to_string()));
      }
      Event::FootnoteReference(label) if definition_start.is_some() => {
        return Err(format!("Nested footnote reference: {label}"));
      }
      Event::End(TagEnd::FootnoteDefinition) => {
        let (start, label) = definition_start.take().ok_or("Invalid footnote definition")?;
        let key = normalize_footnote_label(&label);
        if definitions.iter().any(|(existing, _, _, _)| existing == &key) {
          return Err(format!("Conflicting footnote definition: {label}"));
        }
        let citation = citation_definition(&events[start + 1..index], &label)?;
        definitions.push((key, label, citation, None));
      }
      _ => {}
    }
  }
  // GFM leaves undefined markers literal. The parser's existing old-footnote
  // mode identifies dangling markers; it is used only for admission, never to
  // interpret definition bodies or change the GFM grammar.
  for (event, range) in
    Parser::new_ext(parser_markdown.as_ref(), options | Options::ENABLE_OLD_FOOTNOTES).into_offset_iter()
  {
    if let Event::FootnoteReference(label) = event {
      let key = normalize_footnote_label(&label);
      if !definitions.iter().any(|(existing, _, _, _)| existing == &key)
        && events
          .iter()
          .any(|(event, span)| matches!(event, Event::Text(_)) && span.start <= range.start && span.end >= range.end)
      {
        return Err(format!("Missing footnote definition: {label}"));
      }
    }
  }
  let mut used_definitions = std::collections::HashSet::new();
  for (event, _) in &events {
    if let Event::FootnoteReference(label) = event {
      let key = normalize_footnote_label(label);
      if !definitions.iter().any(|(existing, _, _, _)| existing == &key) {
        return Err(format!("Missing footnote definition: {label}"));
      }
      used_definitions.insert(key);
    }
  }
  for (key, label, citation, id) in &mut definitions {
    if citation.is_none() {
      *id = Some(builder.reserve_footnote_definition(label));
    }
    if !used_definitions.contains(key) {
      diagnostics.push(super::MarkdownDiagnostic {
        code: super::MarkdownDiagnosticCode::UnreferencedFootnote,
      });
    }
  }
  let mut active_definition: Option<usize> = None;
  let mut definition_outer_context = None;
  let paired_highlights = paired_highlight_delimiters(&events, parser_markdown.as_ref());
  let mut container_depth = 2; // Persisted page and note containers.
  for (event, _) in &events {
    match event {
      Event::Start(Tag::BlockQuote(_) | Tag::Item | Tag::FootnoteDefinition(_)) => {
        container_depth += 1;
        if container_depth > super::MAX_BLOCK_DEPTH {
          return Err("Markdown block nesting exceeds the document recursion limit".to_string());
        }
      }
      Event::End(TagEnd::BlockQuote(_) | TagEnd::Item | TagEnd::FootnoteDefinition) => container_depth -= 1,
      _ => {}
    }
  }
  let callouts = callout_headers(markdown, &events, &annotation_source);
  let native_callouts: std::collections::HashMap<_, _> = callouts
    .iter()
    .filter(|note| note.supported)
    .map(|note| (note.range.start, note))
    .collect();
  diagnostics.extend(
    callouts
      .iter()
      .filter(|note| !note.supported)
      .map(|_| super::MarkdownDiagnostic {
        code: super::MarkdownDiagnosticCode::UnsupportedCallout,
      }),
  );

  for (event, source_range) in &events {
    if let Some(source) = &mut html_table {
      match event {
        Event::Html(value) => {
          source.push_str(value);
          continue;
        }
        Event::End(TagEnd::HtmlBlock) => {
          let table = super::table_html::decode(source, resolve_link)?;
          let parent = content_parent(&mut builder, &mut lists, &mut items, &quotes);
          if let Some(quote) = quotes.last_mut() {
            quote.has_own_body = true;
          }
          builder.push_table_under(
            &table.rows,
            &table.alignments,
            parent.as_deref(),
            Some(table.header_rows),
          );
          diagnostics.extend(table.diagnostics);
          html_table = None;
          continue;
        }
        _ => return Err("unsupported raw HTML in Markdown".into()),
      }
    }
    if matches!(event, Event::Start(Tag::HtmlBlock)) {
      emit_paragraph(
        &segments,
        &mut builder,
        &mut lists,
        &mut items,
        &mut quotes,
        pending_source_anchor.as_deref(),
      );
      pending_source_anchor = None;
      segments.clear();
      html_table = Some(String::new());
      continue;
    }
    if let Event::Start(Tag::FootnoteDefinition(label)) = event {
      let index = definitions
        .iter()
        .position(|(key, _, _, _)| key == &normalize_footnote_label(label))
        .ok_or("Missing footnote definition")?;
      active_definition = Some(index);
      // A definition is parent content, not a child of its source quote/list.
      definition_outer_context = Some((
        std::mem::take(&mut lists),
        std::mem::take(&mut items),
        std::mem::take(&mut quotes),
      ));
      builder.content_parent = definitions[index].3.clone();
      continue;
    }
    if matches!(event, Event::End(TagEnd::FootnoteDefinition)) {
      active_definition = None;
      if let Some((outer_lists, outer_items, outer_quotes)) = definition_outer_context.take() {
        lists = outer_lists;
        items = outer_items;
        quotes = outer_quotes;
      }
      builder.content_parent = None;
      continue;
    }
    if active_definition.is_some_and(|index| definitions[index].2.is_some()) {
      continue;
    }

    if quotes
      .last()
      .and_then(|quote| quote.header_end)
      .is_some_and(|header_end| source_range.end <= header_end)
      && !matches!(
        event,
        Event::Start(Tag::BlockQuote(_) | Tag::Paragraph) | Event::End(TagEnd::BlockQuote(_) | TagEnd::Paragraph)
      )
    {
      continue;
    }
    if matches!(event, Event::Text(_))
      && let Some(span) = annotation_source
        .at(source_range)
        .filter(|span| span.standalone || !span.body.is_empty())
    {
      let target = if in_table {
        &mut current_cell_segments
      } else {
        &mut segments
      };
      target.push(TextSegment {
        text: span.body.clone(),
        annotation: Some(uuid::Uuid::new_v4().to_string()),
        ..Default::default()
      });
      pending_source_anchor = None;
      continue;
    }
    match event {
      Event::Start(Tag::Heading { level, .. }) => {
        pending_source_anchor = None;
        heading_level = match level {
          HeadingLevel::H1 => 1,
          HeadingLevel::H2 => 2,
          HeadingLevel::H3 => 3,
          HeadingLevel::H4 => 4,
          HeadingLevel::H5 => 5,
          HeadingLevel::H6 => 6,
        };
        segments.clear();
      }
      Event::End(TagEnd::Heading(_)) => {
        let parent = content_parent(&mut builder, &mut lists, &mut items, &quotes);
        if let Some(quote) = quotes.last_mut() {
          quote.has_own_body = true;
        }
        let anchor = take_source_anchor(&mut segments, pending_source_anchor.as_deref());
        let id = builder.push_paragraph_typed_under(&segments, Some(heading_level as u8), parent.as_deref());
        if let Some(anchor) = anchor {
          builder.set_markdown_anchor(&id, anchor);
        }
        pending_source_anchor = None;
        segments.clear();
        heading_level = 0;
      }
      Event::Start(Tag::Paragraph) => {
        pending_source_anchor = None;
        segments.clear();
      }
      Event::End(TagEnd::Paragraph) => {
        if let Some(body) = standalone_annotation_body(&segments, &annotation_source, source_range) {
          let parent = content_parent(&mut builder, &mut lists, &mut items, &quotes);
          if let Some(quote) = quotes.last_mut() {
            quote.has_own_body = true;
          }
          builder.push_annotation_under(body, parent.as_deref());
          segments.clear();
          continue;
        }
        emit_paragraph(
          &segments,
          &mut builder,
          &mut lists,
          &mut items,
          &mut quotes,
          pending_source_anchor.as_deref(),
        );
        pending_source_anchor = None;
        segments.clear();
      }
      Event::Start(Tag::BlockQuote(_)) => {
        // Tight lists omit Paragraph events. Materialize their pending text
        // before selecting the quote owner; otherwise ensure_item creates an
        // empty list block and the inner paragraph discards the outer text.
        emit_paragraph(
          &segments,
          &mut builder,
          &mut lists,
          &mut items,
          &mut quotes,
          pending_source_anchor.as_deref(),
        );
        pending_source_anchor = None;
        segments.clear();
        let parent_id = content_parent(&mut builder, &mut lists, &mut items, &quotes);
        if let Some(quote) = quotes.last_mut() {
          quote.has_own_body = true;
        }
        let callout_id = native_callouts.get(&source_range.start).map(|note| {
          builder.push_callout_under(
            &note.kind,
            &note.title,
            note.foldable,
            note.default_open,
            parent_id.as_deref(),
          )
        });
        // A quote containing a code block or nested callout first still owns
        // an explicit native quote boundary, matching the client adapter.
        let quote_id = callout_id
          .is_none()
          .then(|| builder.push_quote_under(&[], parent_id.as_deref()));
        quotes.push(QuoteContext {
          // Quotes may be children of list items. Only lists opened inside
          // this quote own its inner list paragraphs instead of quote bodies.
          item_depth: items.len(),
          header_end: native_callouts.get(&source_range.start).map(|note| note.header_end),
          has_own_body: false,
          callout_id,
          parent_id,
          last_quote_id: quote_id,
        });
      }
      Event::End(TagEnd::BlockQuote(_)) => {
        quotes.pop();
      }
      Event::Start(Tag::CodeBlock(kind)) => {
        if let Some(quote) = quotes.last_mut() {
          quote.has_own_body = true;
        }
        if !items.is_empty() {
          let index = items.len() - 1;
          let has_pending = segments
            .iter()
            .any(|segment| !segment.text.trim().is_empty() || segment.reference.is_some() || segment.latex.is_some());
          if items[index].block_id.is_none() && has_pending {
            emit_paragraph(
              &segments,
              &mut builder,
              &mut lists,
              &mut items,
              &mut quotes,
              pending_source_anchor.as_deref(),
            );
            pending_source_anchor = None;
            segments.clear();
          }
        }
        in_code_block = true;
        code_lang = match kind {
          pulldown_cmark::CodeBlockKind::Fenced(lang) => lang.to_string(),
          pulldown_cmark::CodeBlockKind::Indented => String::new(),
        };
        code_block_text.clear();
      }
      Event::End(TagEnd::CodeBlock) => {
        let parent = content_parent(&mut builder, &mut lists, &mut items, &quotes);
        let source = code_block_text.strip_suffix('\n').unwrap_or(&code_block_text);
        if code_lang.eq_ignore_ascii_case("mermaid") {
          // Markdown carries the source, including Mermaid-native title
          // syntax. Separate editor title/caption values stay empty so import
          // never invents non-portable metadata or executes the diagram.
          builder.push_mermaid_under(source, "", "", parent.as_deref());
        } else {
          builder.push_code_under(&code_lang, source, parent.as_deref());
        }
        in_code_block = false;
        code_lang.clear();
        code_block_text.clear();
      }
      Event::Start(Tag::List(start)) => {
        if let Some(quote) = quotes.last_mut().filter(|quote| quote.item_depth == items.len()) {
          quote.has_own_body = true;
        }
        if !items.is_empty() {
          let index = items.len() - 1;
          let has_pending = segments
            .iter()
            .any(|segment| !segment.text.trim().is_empty() || segment.reference.is_some() || segment.latex.is_some());
          if items[index].block_id.is_none() && has_pending {
            // Tight lists omit Paragraph events. Flush their own body through
            // the same owner before a child container consumes the segments.
            emit_paragraph(
              &segments,
              &mut builder,
              &mut lists,
              &mut items,
              &mut quotes,
              pending_source_anchor.as_deref(),
            );
            pending_source_anchor = None;
            segments.clear();
          } else {
            ensure_item(index, &mut builder, &mut lists, &mut items, &quotes);
          }
        }
        lists.push(ListContext {
          ordered: start.is_some(),
          next_order: start.unwrap_or(1),
        });
      }
      Event::End(TagEnd::List(_)) => {
        lists.pop();
      }
      Event::Start(Tag::Item) => {
        segments.clear();
        items.push(ItemContext {
          block_id: None,
          checked: None,
          paragraph_count: 0,
        });
      }
      Event::TaskListMarker(checked) => {
        if let Some(item) = items.last_mut() {
          item.checked = Some(*checked);
        }
      }
      Event::End(TagEnd::Item) => {
        if !items.is_empty()
          && let Some(body) = standalone_annotation_body(&segments, &annotation_source, source_range)
        {
          let parent = ensure_item(items.len() - 1, &mut builder, &mut lists, &mut items, &quotes);
          builder.push_annotation_under(body, Some(&parent));
          segments.clear();
        }
        if !items.is_empty() {
          let index = items.len() - 1;
          emit_paragraph(
            &segments,
            &mut builder,
            &mut lists,
            &mut items,
            &mut quotes,
            pending_source_anchor.as_deref(),
          );
          pending_source_anchor = None;
          ensure_item(index, &mut builder, &mut lists, &mut items, &quotes);
        }
        items.pop();
        segments.clear();
      }
      // Inline formatting events
      Event::Start(Tag::Strong) => bold_active = true,
      Event::End(TagEnd::Strong) => bold_active = false,
      Event::Start(Tag::Emphasis) => italic_active = true,
      Event::End(TagEnd::Emphasis) => italic_active = false,
      Event::Start(Tag::Strikethrough) => strike_active = true,
      Event::End(TagEnd::Strikethrough) => strike_active = false,
      Event::Start(Tag::Link { dest_url, .. }) => {
        let destination = dest_url.to_string();
        match resolve_link(super::MarkdownLinkTarget::Url(&destination)) {
          super::MarkdownLinkResolution::Reference(reference) => link_reference = Some(reference),
          super::MarkdownLinkResolution::Ordinary => link_url = Some(destination),
          super::MarkdownLinkResolution::Unresolved => {
            diagnostics.push(super::MarkdownDiagnostic {
              code: super::MarkdownDiagnosticCode::UnresolvedDocumentReference,
            });
            link_url = Some(destination);
          }
          super::MarkdownLinkResolution::Unsupported => {
            diagnostics.push(super::MarkdownDiagnostic {
              code: super::MarkdownDiagnosticCode::UnsupportedDocumentReference,
            });
            link_url = Some(destination);
          }
        }
      }
      Event::End(TagEnd::Link) => {
        link_url = None;
        link_reference = None;
      }
      Event::Start(Tag::Image { dest_url, title, .. }) => {
        image_capture = Some(ImageCapture {
          dest_url: dest_url.to_string(),
          title_text: title.to_string(),
          alt_text: String::new(),
        });
      }
      Event::End(TagEnd::Image) => {
        if let Some(captured) = image_capture.take()
          && !captured.dest_url.is_empty()
        {
          let caption = if captured.alt_text.is_empty() {
            captured.title_text
          } else {
            captured.alt_text
          };
          let target = if in_table {
            &mut current_cell_segments
          } else {
            &mut segments
          };
          push_segment(
            target,
            format!("![{}]({})", caption, captured.dest_url),
            false,
            false,
            false,
            false,
            false,
            None,
            None,
          );
          if let Some(segment) = target.last_mut() {
            segment.image_source = Some(captured.dest_url);
            segment.image_caption = Some(caption);
          }
        }
      }
      // ─── Table events ─────────────────────────────────────────────
      Event::Start(Tag::Table(alignments)) => {
        in_table = true;
        table_rows.clear();
        table_alignments = alignments
          .iter()
          .map(|alignment| match alignment {
            pulldown_cmark::Alignment::None => None,
            pulldown_cmark::Alignment::Left => Some("left".to_string()),
            pulldown_cmark::Alignment::Center => Some("center".to_string()),
            pulldown_cmark::Alignment::Right => Some("right".to_string()),
          })
          .collect();
      }
      Event::Start(Tag::TableHead) | Event::Start(Tag::TableRow) => {
        current_row_cells.clear();
      }
      Event::Start(Tag::TableCell) => {
        current_cell_segments.clear();
      }
      Event::End(TagEnd::TableCell) => {
        current_row_cells.push(current_cell_segments.clone());
        current_cell_segments.clear();
      }
      Event::End(TagEnd::TableHead) | Event::End(TagEnd::TableRow) => {
        if !current_row_cells.is_empty() {
          table_rows.push(current_row_cells.clone());
        }
        current_row_cells.clear();
      }
      Event::End(TagEnd::Table) => {
        if let Some(quote) = quotes.last_mut() {
          quote.has_own_body = true;
        }
        if !table_rows.is_empty() {
          let parent = if !items.is_empty() {
            let index = items.len() - 1;
            Some(ensure_item(index, &mut builder, &mut lists, &mut items, &quotes))
          } else {
            quote_parent(&quotes)
          };
          builder.push_table_under(&table_rows, &table_alignments, parent.as_deref(), Some(1));
        }
        table_rows.clear();
        table_alignments.clear();
        in_table = false;
      }
      Event::Rule => {
        builder.push_divider();
      }
      Event::Text(text) => {
        pending_source_anchor = if !in_code_block
          && !in_table
          && image_capture.is_none()
          && source_range
            .start
            .checked_sub(1)
            .and_then(|index| parser_markdown.as_bytes().get(index))
            != Some(&b'\\')
        {
          super::targets::trailing_source_anchor(&parser_markdown[source_range.clone()]).map(str::to_string)
        } else {
          None
        };
        if in_code_block {
          code_block_text.push_str(text);
        } else if let Some(captured) = &mut image_capture {
          captured.alt_text.push_str(text);
        } else if link_url.is_none()
          && link_reference.is_none()
          && let Some(parts) = parse_wiki_text(
            &parser_markdown[source_range.clone()],
            text,
            source_range
              .start
              .checked_sub(1)
              .and_then(|index| markdown.as_bytes().get(index))
              .copied(),
            resolve_link,
            &mut diagnostics,
          )
        {
          for part in parts {
            let target = if in_table {
              &mut current_cell_segments
            } else {
              &mut segments
            };
            match part {
              WikiInline::Text(text) => push_segment(
                target,
                text,
                bold_active,
                italic_active,
                strike_active,
                false,
                highlight_active,
                None,
                None,
              ),
              WikiInline::Reference {
                label,
                alias,
                mut reference,
              } => {
                reference.title = alias;
                push_segment(
                  target,
                  label,
                  bold_active,
                  italic_active,
                  strike_active,
                  false,
                  highlight_active,
                  None,
                  Some(reference),
                );
              }
              WikiInline::Embed { source, reference } => {
                if in_table || heading_level != 0 {
                  diagnostics.push(super::MarkdownDiagnostic {
                    code: super::MarkdownDiagnosticCode::UnsupportedDocumentReference,
                  });
                  push_segment(
                    target,
                    source,
                    bold_active,
                    italic_active,
                    strike_active,
                    false,
                    highlight_active,
                    None,
                    None,
                  );
                  continue;
                }
                emit_paragraph(&segments, &mut builder, &mut lists, &mut items, &mut quotes, None);
                pending_source_anchor = None;
                segments.clear();
                let parent = if let Some(quote) = quotes.last_mut().filter(|quote| quote.item_depth == items.len()) {
                  if quote.last_quote_id.is_none() {
                    quote.last_quote_id = Some(builder.push_quote_under(&[], quote.parent_id.as_deref()));
                  }
                  quote.last_quote_id.clone()
                } else if !items.is_empty() {
                  let index = items.len() - 1;
                  let id = ensure_item(index, &mut builder, &mut lists, &mut items, &quotes);
                  items[index].paragraph_count = items[index].paragraph_count.max(1);
                  Some(id)
                } else {
                  None
                };
                builder.push_synced_doc_under(&reference, parent.as_deref());
              }
            }
          }
        } else if in_table {
          let mut reference = link_reference.clone();
          if let Some(reference) = &mut reference {
            reference.title = Some(text.to_string());
          }
          for (part, highlighted) in highlighted_text_parts(
            parser_markdown.as_ref(),
            text,
            source_range,
            &paired_highlights,
            &mut highlight_active,
          ) {
            push_segment(
              &mut current_cell_segments,
              part,
              bold_active,
              italic_active,
              strike_active,
              false,
              highlighted,
              link_url.clone(),
              reference.clone(),
            );
          }
        } else {
          let mut reference = link_reference.clone();
          if let Some(reference) = &mut reference {
            reference.title = Some(text.to_string());
          }
          for (part, highlighted) in highlighted_text_parts(
            parser_markdown.as_ref(),
            text,
            source_range,
            &paired_highlights,
            &mut highlight_active,
          ) {
            push_segment(
              &mut segments,
              part,
              bold_active,
              italic_active,
              strike_active,
              false,
              highlighted,
              link_url.clone(),
              reference.clone(),
            );
          }
        }
      }
      Event::SoftBreak => {
        pending_source_anchor = None;
        if in_code_block {
          code_block_text.push('\n');
        } else if let Some(captured) = &mut image_capture {
          captured.alt_text.push(' ');
        } else if in_table {
          push_segment(
            &mut current_cell_segments,
            " ".to_string(),
            false,
            false,
            false,
            false,
            highlight_active,
            None,
            None,
          );
        } else {
          push_segment(
            &mut segments,
            " ".to_string(),
            false,
            false,
            false,
            false,
            highlight_active,
            None,
            None,
          );
        }
      }
      Event::HardBreak => {
        pending_source_anchor = None;
        let target = if in_table {
          &mut current_cell_segments
        } else {
          &mut segments
        };
        push_segment(
          target,
          "\n".to_string(),
          bold_active,
          italic_active,
          strike_active,
          false,
          highlight_active,
          link_url.clone(),
          link_reference.clone(),
        );
      }
      Event::InlineHtml(html) if in_table && matches!(html.trim().to_ascii_lowercase().as_str(), "<br>" | "<br />") => {
        push_segment(
          &mut current_cell_segments,
          "\n".to_string(),
          bold_active,
          italic_active,
          strike_active,
          false,
          highlight_active,
          link_url.clone(),
          link_reference.clone(),
        );
      }
      Event::Start(Tag::HtmlBlock) | Event::End(TagEnd::HtmlBlock) | Event::Html(_) | Event::InlineHtml(_) => {
        return Err("unsupported raw HTML in Markdown".to_string());
      }
      Event::Start(
        Tag::DefinitionList
        | Tag::DefinitionListTitle
        | Tag::DefinitionListDefinition
        | Tag::Superscript
        | Tag::Subscript
        | Tag::MetadataBlock(_),
      )
      | Event::End(
        TagEnd::DefinitionList
        | TagEnd::DefinitionListTitle
        | TagEnd::DefinitionListDefinition
        | TagEnd::Superscript
        | TagEnd::Subscript
        | TagEnd::MetadataBlock(_),
      ) => {
        return Err("unsupported Markdown construct".to_string());
      }
      Event::Start(Tag::FootnoteDefinition(_)) | Event::End(TagEnd::FootnoteDefinition) => {
        unreachable!("handled definition boundary")
      }
      Event::FootnoteReference(label) => {
        let definition = definitions
          .iter()
          .find(|(key, _, _, _)| key == &normalize_footnote_label(label))
          .ok_or("Missing footnote definition")?;
        let footnote = if let Some(id) = &definition.3 {
          serde_json::json!({"label": definition.1, "definitionId": id})
        } else {
          serde_json::json!({"label": definition.1, "reference": definition.2})
        };
        let target = if in_table {
          &mut current_cell_segments
        } else {
          &mut segments
        };
        target.push(TextSegment {
          text: " ".to_string(),
          footnote: Some(footnote),
          ..Default::default()
        });
      }
      Event::InlineMath(formula) => {
        let target = if in_table {
          &mut current_cell_segments
        } else {
          &mut segments
        };
        // A closing dollar followed by a digit is currency, not a math boundary.
        if markdown
          .as_bytes()
          .get(source_range.end)
          .is_some_and(u8::is_ascii_digit)
          || image_capture.is_some()
          || link_url.is_some()
          || link_reference.is_some()
          || formula.contains('\n')
        {
          if image_capture.is_some() || link_url.is_some() || link_reference.is_some() || formula.contains('\n') {
            diagnostics.push(super::MarkdownDiagnostic {
              code: super::MarkdownDiagnosticCode::UnsupportedMath,
            });
          }
          if let Some(captured) = &mut image_capture {
            captured.alt_text.push_str(&markdown[source_range.clone()]);
          } else {
            push_segment(
              target,
              markdown[source_range.clone()].into(),
              bold_active,
              italic_active,
              strike_active,
              false,
              highlight_active,
              link_url.clone(),
              link_reference.clone(),
            );
          }
        } else {
          native_math_count += 1;
          target.push(TextSegment {
            text: " ".to_string(),
            latex: Some(formula.to_string()),
            ..Default::default()
          });
        }
      }
      Event::DisplayMath(formula) => {
        let suffix = markdown[source_range.end..].split('\n').next().unwrap_or_default();
        if in_table
          || heading_level != 0
          || !segments.is_empty()
          || !suffix.trim().is_empty()
          || image_capture.is_some()
          || link_url.is_some()
          || link_reference.is_some()
          || quotes.last().is_some_and(|quote| quote.callout_id.is_some())
        {
          diagnostics.push(super::MarkdownDiagnostic {
            code: super::MarkdownDiagnosticCode::UnsupportedMath,
          });
          let target = if in_table {
            &mut current_cell_segments
          } else {
            &mut segments
          };
          if let Some(captured) = &mut image_capture {
            captured.alt_text.push_str(&markdown[source_range.clone()]);
          } else {
            push_segment(
              target,
              markdown[source_range.clone()].into(),
              bold_active,
              italic_active,
              strike_active,
              false,
              highlight_active,
              link_url.clone(),
              link_reference.clone(),
            );
          }
        } else {
          let parent = if let Some(quote) = quotes.last_mut().filter(|quote| quote.item_depth == items.len()) {
            if quote.last_quote_id.is_none() {
              quote.last_quote_id = Some(builder.push_quote_under(&[], quote.parent_id.as_deref()));
            }
            quote.last_quote_id.clone()
          } else if !items.is_empty() {
            Some(ensure_item(
              items.len() - 1,
              &mut builder,
              &mut lists,
              &mut items,
              &quotes,
            ))
          } else {
            quote_parent(&quotes)
          };
          if let Some(quote) = quotes.last_mut() {
            quote.has_own_body = true;
          }
          builder.push_latex_under(display_formula(formula), parent.as_deref());
          native_math_count += 1;
        }
      }
      Event::Code(code) => {
        pending_source_anchor = None;
        if let Some(captured) = &mut image_capture {
          captured.alt_text.push_str(code);
          continue;
        }
        // Inline code — stored with `code` attribute
        let target = if in_table {
          &mut current_cell_segments
        } else {
          &mut segments
        };
        push_segment(
          target,
          code.to_string(),
          bold_active,
          italic_active,
          strike_active,
          true,
          highlight_active,
          link_url.clone(),
          link_reference.clone(),
        );
      }
    }
  }

  let sources_heading = {
    let txn = builder.doc.transact();
    builder.note_children.iter(&txn).last().and_then(|value| match value {
      yrs::Out::Any(Any::String(id)) => match builder.blocks.get(&txn, &id) {
        Some(yrs::Out::YMap(block))
          if matches!(block.get(&txn, "prop:type"), Some(yrs::Out::Any(Any::String(kind))) if kind.as_ref() == "h6")
            && matches!(block.get(&txn, "prop:text"), Some(yrs::Out::YText(text)) if text.get_string(&txn) == "Sources") => Some(id.to_string()),
        _ => None,
      },
      _ => None,
    })
  };
  let has_citations = definitions.iter().any(|(_, _, citation, _)| citation.is_some());
  if has_citations && sources_heading.is_some() {
    let mut txn = builder.doc.transact_mut();
    let last_index = builder.note_children.len(&txn) - 1;
    builder.note_children.remove(&mut txn, last_index);
  }
  for (_, _, _, id) in &definitions {
    if let Some(id) = id {
      let empty = {
        let txn = builder.doc.transact();
        matches!(builder.blocks.get(&txn, id), Some(yrs::Out::YMap(block)) if matches!(block.get(&txn, "sys:children"), Some(yrs::Out::YArray(children)) if children.len(&txn) == 0))
      };
      if empty {
        builder.push_paragraph_under(&[], Some(id));
      }
      builder
        .note_children
        .push_back(&mut builder.doc.transact_mut(), id.as_str());
    }
  }
  if has_citations {
    let heading_id = if let Some(id) = sources_heading {
      builder
        .note_children
        .push_back(&mut builder.doc.transact_mut(), id.as_str());
      id
    } else {
      builder.push_paragraph_typed_under(&[TextSegment::plain("Sources")], Some(6), None)
    };
    {
      let mut txn = builder.doc.transact_mut();
      if let Some(yrs::Out::YMap(heading)) = builder.blocks.get(&txn, &heading_id) {
        heading.insert(&mut txn, "prop:collapsed", true);
      }
    }
    for (_, label, citation, _) in &definitions {
      let Some(reference) = citation else {
        continue;
      };
      let id = builder.next_id();
      let mut txn = builder.doc.transact_mut();
      super::write_native_citation_definition(&builder.blocks, &mut txn, &id, label, reference);
      builder.note_children.push_back(&mut txn, id.as_str());
      drop(txn);
      builder.block_count += 1;
    }
  }
  if html_table.is_some() {
    return Err("unsupported raw HTML in Markdown".into());
  }
  let block_count = builder.block_count();
  let result = builder.encode();
  debug!(
    title,
    blocks = block_count,
    result_size = result.len(),
    "markdown_to_yjs complete"
  );

  Ok(super::MarkdownImportResult {
    yjs_binary: result,
    diagnostics,
    native_math_count,
    native_footnote_count: definitions.iter().filter(|definition| definition.3.is_some()).count(),
  })
}

enum WikiInline {
  Text(String),
  Embed {
    source: String,
    reference: super::MarkdownDocumentReference,
  },
  Reference {
    label: String,
    alias: Option<String>,
    reference: super::MarkdownDocumentReference,
  },
}

fn parse_wiki_text(
  source: &str,
  displayed: &str,
  source_prefix: Option<u8>,
  resolve_link: &dyn Fn(super::MarkdownLinkTarget<'_>) -> super::MarkdownLinkResolution,
  diagnostics: &mut Vec<super::MarkdownDiagnostic>,
) -> Option<Vec<WikiInline>> {
  // pulldown-cmark removes backslash escapes and decodes entities. Requiring
  // the raw slice to match prevents escaped brackets from becoming syntax.
  if source != displayed || source_prefix == Some(b'\\') || !source.contains("[[") {
    return None;
  }
  let mut parts = Vec::new();
  let mut cursor = 0usize;
  while let Some(relative_start) = source[cursor..].find("[[") {
    let start = cursor + relative_start;
    let embedded = (start == 0 && source_prefix == Some(b'!')) || (start > 0 && source.as_bytes()[start - 1] == b'!');
    let syntax_start = if embedded && start > 0 { start - 1 } else { start };
    if syntax_start > cursor {
      parts.push(WikiInline::Text(source[cursor..syntax_start].to_string()));
    }
    let Some(relative_end) = source[start + 2..].find("]]") else {
      let target = source[start + 2..].trim();
      if !target.is_empty() {
        diagnostics.push(super::MarkdownDiagnostic {
          code: super::MarkdownDiagnosticCode::UnresolvedDocumentReference,
        });
      }
      parts.push(WikiInline::Text(source[syntax_start..].to_string()));
      cursor = source.len();
      break;
    };
    let end = start + 2 + relative_end;
    let token_end = end + 2;
    let body = &source[start + 2..end];
    let (target, alias) = body
      .split_once('|')
      .map_or((body, None), |(target, alias)| (target, Some(alias)));
    let target = target.trim();
    let alias = alias.map(str::trim).filter(|alias| !alias.is_empty());
    if target.is_empty() {
      parts.push(WikiInline::Text(source[syntax_start..token_end].to_string()));
    } else if embedded && target.contains('#') {
      diagnostics.push(super::MarkdownDiagnostic {
        code: super::MarkdownDiagnosticCode::UnsupportedDocumentReference,
      });
      parts.push(WikiInline::Text(source[syntax_start..token_end].to_string()));
    } else {
      let link_target = if target.starts_with("https://") || target.starts_with("http://") {
        super::MarkdownLinkTarget::Url(target)
      } else {
        super::MarkdownLinkTarget::Wiki(target)
      };
      match resolve_link(link_target) {
        super::MarkdownLinkResolution::Reference(mut reference) => {
          let alias = alias.map(str::to_string);
          if embedded {
            if reference.params.as_ref().is_some_and(|params| {
              ["blockIds", "elementIds"].iter().any(|key| {
                params
                  .get(key)
                  .and_then(serde_json::Value::as_array)
                  .is_some_and(|ids| !ids.is_empty())
              })
            }) {
              diagnostics.push(super::MarkdownDiagnostic {
                code: super::MarkdownDiagnosticCode::UnsupportedDocumentReference,
              });
              parts.push(WikiInline::Text(source[syntax_start..token_end].to_string()));
              cursor = token_end;
              continue;
            }
            reference.title = alias;
            parts.push(WikiInline::Embed {
              source: source[syntax_start..token_end].to_string(),
              reference,
            });
          } else {
            parts.push(WikiInline::Reference {
              label: alias.clone().unwrap_or_else(|| " ".to_string()),
              alias,
              reference,
            });
          }
        }
        super::MarkdownLinkResolution::Ordinary | super::MarkdownLinkResolution::Unresolved => {
          diagnostics.push(super::MarkdownDiagnostic {
            code: super::MarkdownDiagnosticCode::UnresolvedDocumentReference,
          });
          parts.push(WikiInline::Text(source[syntax_start..token_end].to_string()));
        }
        super::MarkdownLinkResolution::Unsupported => {
          diagnostics.push(super::MarkdownDiagnostic {
            code: super::MarkdownDiagnosticCode::UnsupportedDocumentReference,
          });
          parts.push(WikiInline::Text(source[syntax_start..token_end].to_string()));
        }
      }
    }
    cursor = token_end;
  }
  if cursor < source.len() {
    parts.push(WikiInline::Text(source[cursor..].to_string()));
  }
  Some(parts)
}
