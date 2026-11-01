// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canonical Yjs-to-Markdown projection.

use super::super::*;
use super::{
  MarkdownDiagnostic, MarkdownDiagnosticCode, MarkdownDocumentReference, MarkdownResolvedReference, YjsExtractResult,
};

// ─── Attributed text projection ──────────────────────────────────────────────

/// Formatting boundaries and native line breaks do not split an annotation's
/// identity. Adjacent different identities deliberately remain separate spans.
fn logical_text_diffs<T: ReadTxn>(text: &yrs::TextRef, txn: &T) -> Vec<Diff<YChange>> {
  let mut grouped: Vec<Diff<YChange>> = Vec::new();
  let mut pending: Option<(Diff<YChange>, String)> = None;
  let flush = |pending: &mut Option<(Diff<YChange>, String)>, grouped: &mut Vec<Diff<YChange>>| {
    if let Some((mut diff, body)) = pending.take() {
      diff.insert = yrs::Out::Any(Any::String(body.into()));
      grouped.push(diff);
    }
  };
  for diff in text.diff(txn, YChange::identity) {
    if let Some(id) = crate::annotation::annotation_id(diff.attributes.as_deref())
      && let yrs::Out::Any(Any::String(value)) = &diff.insert
    {
      if let Some((previous, body)) = &mut pending
        && Some(id) == crate::annotation::annotation_id(previous.attributes.as_deref())
      {
        body.push_str(value);
      } else {
        flush(&mut pending, &mut grouped);
        let body = value.to_string();
        pending = Some((diff, body));
      }
    } else {
      flush(&mut pending, &mut grouped);
      grouped.push(diff);
    }
  }
  flush(&mut pending, &mut grouped);
  grouped
}

fn annotation_findings<T: ReadTxn>(text: &yrs::TextRef, txn: &T, paragraph: bool) -> Vec<MarkdownDiagnostic> {
  let diffs = logical_text_diffs(text, txn);
  let mut annotations = 0;
  let mut ordinary = false;
  let mut findings = Vec::new();
  let mut multiline_inline = 0;
  for diff in diffs {
    if let Some(Any::String(latex)) = diff.attributes.as_deref().and_then(|attrs| attrs.get("latex"))
      && crate::annotation::annotation_id(diff.attributes.as_deref()).is_none()
      && super::import::serialize_math(latex, false).is_none()
    {
      findings.push(MarkdownDiagnostic {
        code: MarkdownDiagnosticCode::UnsupportedMath,
      });
    }
    if let yrs::Out::Any(Any::String(value)) = &diff.insert {
      if crate::annotation::annotation_id(diff.attributes.as_deref()).is_some() {
        annotations += 1;
        if super::annotation_syntax::serialize_body(value).is_none() {
          findings.push(MarkdownDiagnostic {
            code: MarkdownDiagnosticCode::UnsupportedAnnotation,
          });
        } else if value.contains('\n') {
          multiline_inline += 1;
        }
      } else if !value.trim().is_empty() {
        ordinary = true;
      }
    } else {
      ordinary = true;
    }
  }
  if paragraph && annotations == 1 && !ordinary && findings.is_empty() {
    findings.push(MarkdownDiagnostic {
      code: MarkdownDiagnosticCode::NormalizedAnnotation,
    });
  } else {
    // Obsidian 1.13.7 exposes multiline inline comments. The native writer
    // retains their full body/position, but must report this dialect limit.
    findings.extend((0..multiline_inline).map(|_| MarkdownDiagnostic {
      code: MarkdownDiagnosticCode::UnsupportedAnnotation,
    }));
  }
  findings
}

fn annotation_source_or_literal(body: &str) -> String {
  super::annotation_syntax::serialize_body(body).unwrap_or_else(|| escape_markdown_literal_text(&format!("%%{body}%%")))
}

/// Extract Markdown-formatted text from a `TextRef`, preserving bold, italic,
/// strikethrough, inline code, and link attributes.
///
/// Uses `text_ref.diff()` to iterate over attribute-annotated chunks instead of
/// the plain `get_string()` which discards all formatting.
fn extract_text_with_formatting<T: ReadTxn>(
  text_ref: &yrs::TextRef,
  txn: &T,
  escape_markdown_literals: bool,
  normalized_highlights: &mut usize,
) -> String {
  let diffs = logical_text_diffs(text_ref, txn);
  let mut formatted = String::new();

  for d in &diffs {
    // Only handle string inserts (skip embedded objects)
    let chunk_text = match &d.insert {
      yrs::Out::Any(Any::String(s)) => s.to_string(),
      _ => continue,
    };
    if chunk_text.is_empty() {
      continue;
    }

    let attrs = d.attributes.as_ref();
    if escape_markdown_literals && let Some(footnote) = attrs.and_then(|attrs| attrs.get("footnote")) {
      let footnote = yjs_any_to_json(footnote);
      if let Some(label) = footnote["label"].as_str() {
        // Adjacent identical native markers can coalesce into one Yjs diff.
        for _ in chunk_text.chars() {
          formatted.push_str(&format!("[^{}]", escape_markdown_label(label)));
        }
      }
      continue;
    }
    if escape_markdown_literals && crate::annotation::annotation_id(d.attributes.as_deref()).is_some() {
      formatted.push_str(&annotation_source_or_literal(&chunk_text));
      continue;
    }
    if escape_markdown_literals && let Some(Any::String(latex)) = attrs.and_then(|attrs| attrs.get("latex")) {
      formatted
        .push_str(&super::import::serialize_math(latex, false).unwrap_or_else(|| escape_markdown_literal_text(latex)));
      continue;
    }

    let has_bold = attrs
      .map(|a| {
        a.iter()
          .any(|(k, v)| k.as_ref() == "bold" && *v != Any::Null && *v != Any::Bool(false))
      })
      .unwrap_or(false);
    let has_italic = attrs
      .map(|a| {
        a.iter()
          .any(|(k, v)| k.as_ref() == "italic" && *v != Any::Null && *v != Any::Bool(false))
      })
      .unwrap_or(false);
    let has_strike = attrs
      .map(|a| {
        a.iter()
          .any(|(k, v)| k.as_ref() == "strike" && *v != Any::Null && *v != Any::Bool(false))
      })
      .unwrap_or(false);
    let has_code = attrs
      .map(|a| {
        a.iter()
          .any(|(k, v)| k.as_ref() == "code" && *v != Any::Null && *v != Any::Bool(false))
      })
      .unwrap_or(false);
    let has_background = attrs
      .and_then(|attributes| attributes.get("background"))
      .is_some_and(|value| *value != Any::Null && *value != Any::Bool(false));
    let is_markdown_image = attrs
      .map(|a| {
        a.iter()
          .any(|(k, v)| k.as_ref() == "markdown-image" && *v != Any::Null && *v != Any::Bool(false))
      })
      .unwrap_or(false);
    let link: Option<String> = attrs.and_then(|a| {
      a.iter().find_map(|(k, v)| {
        if k.as_ref() == "link" {
          match v {
            Any::String(s) => Some(s.to_string()),
            _ => None,
          }
        } else {
          None
        }
      })
    });

    let markdown_image = is_markdown_image.then(|| {
      let source = attrs
        .and_then(|attrs| attrs.get("markdown-image-source"))
        .and_then(yjs_any_to_string);
      let caption = attrs
        .and_then(|attrs| attrs.get("markdown-image-caption"))
        .and_then(yjs_any_to_string)
        .unwrap_or_default();
      source.map(|source| {
        format!(
          "![{}]({})",
          escape_markdown_label(&caption),
          escape_markdown_destination(&source)
        )
      })
    });

    let mut chunk = if let Some(Some(image)) = markdown_image {
      image
    } else if has_code {
      serialize_inline_code(&chunk_text)
    } else if escape_markdown_literals && !is_markdown_image {
      escape_markdown_literal_text(&chunk_text)
    } else {
      chunk_text
    };
    // CommonMark emphasis cannot open/close against padding. Keep ordinary
    // spaces outside the marks so surrounding text remains rich on re-import.
    let marked = has_bold || has_italic || has_strike || has_background;
    let (leading, trailing) = if marked && !has_code {
      let start = chunk.len() - chunk.trim_start_matches([' ', '\t']).len();
      let end = chunk.trim_end_matches([' ', '\t']).len().max(start);
      let padding = (chunk[..start].to_string(), chunk[end..].to_string());
      chunk = chunk[start..end].to_string();
      padding
    } else {
      (String::new(), String::new())
    };
    // Apply formatting in inside-out order. Markdown retains highlight
    // presence, while the editor's concrete semantic background is normalized.
    if has_bold && !chunk.is_empty() {
      chunk = format!("**{chunk}**");
    }
    if has_italic && !chunk.is_empty() {
      chunk = format!("*{chunk}*");
    }
    if has_strike && !chunk.is_empty() {
      chunk = format!("~~{chunk}~~");
    }
    if has_background && !chunk.is_empty() {
      chunk = format!("=={chunk}==");
      *normalized_highlights += 1;
    }
    chunk = format!("{leading}{chunk}{trailing}");
    if let Some(url) = link {
      chunk = format!("[{chunk}]({})", escape_markdown_destination(&url));
    }

    formatted.push_str(&chunk);
  }

  // If diff produced nothing (e.g. embedded-only text), fall back to plain get_string
  if formatted.is_empty() {
    return text_ref.get_string(txn);
  }
  formatted
}

pub(crate) fn extract_formatted_text<T: ReadTxn>(text_ref: &yrs::TextRef, txn: &T) -> String {
  extract_text_with_formatting(text_ref, txn, false, &mut 0)
}

fn extract_markdown_text_with_normalizations<T: ReadTxn>(text_ref: &yrs::TextRef, txn: &T) -> (String, usize) {
  let mut normalized_highlights = 0;
  let markdown = extract_text_with_formatting(text_ref, txn, true, &mut normalized_highlights);
  (markdown, normalized_highlights)
}

pub(super) fn attr_document_reference(attrs: Option<&Attrs>) -> Option<MarkdownDocumentReference> {
  let attrs = attrs?;
  // Native code/math wins over residual rich-text reference attributes. These
  // literal spans must not disclose cached titles or request export anchors.
  if attrs
    .get("code")
    .is_some_and(|value| *value != Any::Null && *value != Any::Bool(false))
    || matches!(attrs.get("latex"), Some(Any::String(_)))
  {
    return None;
  }
  let Any::Map(reference) = attrs.get("reference")? else {
    return None;
  };
  if reference.get("type").and_then(yjs_any_to_string).as_deref() != Some("LinkedPage") {
    return None;
  }
  let page_id = reference
    .get("pageId")
    .and_then(yjs_any_to_string)
    .or_else(|| reference.get("docId").and_then(yjs_any_to_string))?;
  if page_id.is_empty() {
    return None;
  }
  Some(MarkdownDocumentReference {
    page_id,
    title: reference.get("title").and_then(yjs_any_to_string),
    description: reference.get("description").and_then(yjs_any_to_string),
    params: reference.get("params").map(yjs_any_to_json),
  })
}

fn extract_markdown_text_with_references<T: ReadTxn>(
  text_ref: &yrs::TextRef,
  txn: &T,
  resolve_reference: &dyn Fn(&MarkdownDocumentReference) -> Option<MarkdownResolvedReference>,
  resolve_image: &dyn Fn(&str) -> Option<String>,
) -> (String, usize, usize, usize, usize) {
  extract_text_with_references(text_ref, txn, resolve_reference, resolve_image, false)
}

/// Emit admitted inline HTML from native attributes, never formatted Markdown.
fn extract_html_text<T: ReadTxn>(text: &yrs::TextRef, txn: &T) -> (String, usize) {
  let mut output = String::new();
  let mut unsupported = 0;
  for diff in logical_text_diffs(text, txn) {
    let yrs::Out::Any(Any::String(value)) = &diff.insert else {
      unsupported += 1;
      continue;
    };
    let attributes = diff.attributes.as_deref();
    let active = |key| {
      attributes
        .and_then(|attrs| attrs.get(key))
        .is_some_and(|value| *value != Any::Null && *value != Any::Bool(false))
    };
    if ["latex", "annotation", "footnote", "markdown-image", "background"]
      .into_iter()
      .any(active)
    {
      unsupported += 1;
    }
    let mut chunk = super::table_html::escape(value).replace('\n', "<br>");
    for (key, tag) in [
      ("code", "code"),
      ("bold", "strong"),
      ("italic", "em"),
      ("strike", "del"),
    ] {
      if active(key) {
        chunk = format!("<{tag}>{chunk}</{tag}>");
      }
    }
    if let Some(Any::String(url)) = attributes.and_then(|attrs| attrs.get("link")) {
      if super::table_html::safe_link(url) {
        chunk = format!("<a href=\"{}\">{chunk}</a>", super::table_html::escape(url));
      } else {
        unsupported += 1;
      }
    }
    output.push_str(&chunk);
  }
  (output, unsupported)
}

fn extract_text_with_references<T: ReadTxn>(
  text_ref: &yrs::TextRef,
  txn: &T,
  resolve_reference: &dyn Fn(&MarkdownDocumentReference) -> Option<MarkdownResolvedReference>,
  resolve_image: &dyn Fn(&str) -> Option<String>,
  html: bool,
) -> (String, usize, usize, usize, usize) {
  let mut markdown = String::new();
  let mut unresolved = 0;
  let mut unsupported = 0;
  let mut normalized_highlights = 0;
  let mut missing_image_sources = 0;
  for diff in logical_text_diffs(text_ref, txn) {
    let yrs::Out::Any(Any::String(value)) = &diff.insert else {
      unsupported += 1;
      continue;
    };
    if !html && crate::annotation::annotation_id(diff.attributes.as_deref()).is_some() {
      markdown.push_str(&annotation_source_or_literal(value));
      continue;
    }
    let Some(reference) = attr_document_reference(diff.attributes.as_deref()) else {
      // Preserve all ordinary formatting through the established projector.
      let temporary = Doc::new();
      let text = temporary.get_or_insert_text("text");
      let mut attributes = *diff.attributes.clone().unwrap_or_default();
      if attributes
        .get("markdown-image")
        .is_some_and(|value| *value != Any::Null && *value != Any::Bool(false))
        && let Some(source) = attributes.get("markdown-image-source").and_then(yjs_any_to_string)
      {
        let Some(resolved) = resolve_image(&source) else {
          missing_image_sources += 1;
          continue;
        };
        attributes.insert(Arc::from("markdown-image-source"), Any::String(resolved.into()));
      }
      text.insert_with_attributes(&mut temporary.transact_mut(), 0, value.as_ref(), attributes);
      if html {
        let (formatted, skipped) = extract_html_text(&text, &temporary.transact());
        markdown.push_str(&formatted);
        unsupported += skipped;
      } else {
        let (formatted, normalized) = extract_markdown_text_with_normalizations(&text, &temporary.transact());
        markdown.push_str(&formatted);
        normalized_highlights += normalized;
      }
      continue;
    };
    let visible = reference
      .title
      .as_deref()
      .filter(|title| !title.trim().is_empty())
      .or_else(|| (!value.trim().is_empty()).then_some(value.as_ref()));
    if let Some(resolved) = resolve_reference(&reference) {
      let label = visible.unwrap_or(&resolved.title);
      if html {
        if super::table_html::safe_link(&resolved.url) {
          markdown.push_str(&format!(
            "<a href=\"{}\">{}</a>",
            super::table_html::escape(&resolved.url),
            super::table_html::escape(label)
          ));
        } else {
          markdown.push_str(&super::table_html::escape(label));
          unsupported += 1;
        }
      } else {
        markdown.push_str(&format!(
          "[{}]({})",
          escape_markdown_label(label),
          escape_markdown_destination(&resolved.url)
        ));
      }
    } else {
      let visible = visible.unwrap_or(&reference.page_id);
      markdown.push_str(&if html {
        super::table_html::escape(visible)
      } else {
        escape_markdown_literal_text(visible)
      });
      unresolved += 1;
    }
  }
  (
    markdown,
    unresolved,
    unsupported,
    normalized_highlights,
    missing_image_sources,
  )
}

/// Escape an already serialized inline cell without changing native annotation syntax.
pub fn escape_markdown_table_cell(cell: &str) -> String {
  let mut escaped = String::with_capacity(cell.len());
  let annotation_ranges = super::annotation_syntax::markdown_annotation_ranges(cell);
  let mut annotation_index = 0;
  let mut characters = cell.char_indices().peekable();
  while let Some((index, character)) = characters.next() {
    while annotation_ranges
      .get(annotation_index)
      .is_some_and(|span| span.end <= index)
    {
      annotation_index += 1;
    }
    if annotation_ranges
      .get(annotation_index)
      .is_some_and(|span| span.start <= index && index < span.end)
    {
      escaped.push(character);
      continue;
    }
    match character {
      '\\' if characters.peek().is_some_and(|(_, character)| *character == '|') => {
        escaped.push('\\');
        escaped.push(characters.next().expect("peeked table pipe").1);
      }
      '|' => escaped.push_str("\\|"),
      '\n' => {
        if escaped.ends_with("  ") {
          escaped.truncate(escaped.len() - 2);
        } else if escaped.ends_with('\\') {
          escaped.pop();
        }
        escaped.push_str("<br />");
      }
      _ => escaped.push(character),
    }
  }
  escaped.trim().to_string()
}

pub fn escape_markdown_literal_text(text: &str) -> String {
  let mut escaped = String::with_capacity(text.len());
  let highlight_delimiters = literal_highlight_delimiters(text);
  for (index, character) in text.char_indices() {
    if character == '\n' {
      // A native newline is an intentional break inside this block. Use the
      // canonical backslash spelling so repeated Markdown projections do not
      // alternate with the equivalent two-space form accepted on import.
      escaped.push_str("\\\n");
      continue;
    }
    let equals_delimiter = character == '='
      && (highlight_delimiters.contains(&index) || highlight_delimiters.contains(&index.saturating_sub(1)));
    let percent_delimiter = character == '%'
      && (text.as_bytes().get(index + 1) == Some(&b'%')
        || (index > 0 && text.as_bytes().get(index - 1) == Some(&b'%')));
    if equals_delimiter
      || percent_delimiter
      || matches!(character, '\\' | '`' | '*' | '_' | '[' | ']' | '~' | '<' | '$' | '^')
    {
      escaped.push('\\');
    }
    escaped.push(character);
  }
  escaped
}

/// Return only delimiter pairs that a later Markdown import could classify as
/// highlights. Unmatched `==` sequences (for example Base64 padding) remain
/// byte-identical because they cannot acquire highlight meaning on re-import.
fn literal_highlight_delimiters(text: &str) -> std::collections::HashSet<usize> {
  let bytes = text.as_bytes();
  let mut paired = std::collections::HashSet::new();
  let mut opening = None;
  let mut index = 0;
  while index + 1 < bytes.len() {
    if bytes[index] != b'=' || bytes[index + 1] != b'=' {
      index += 1;
      continue;
    }
    let adjacent_equals =
      index.checked_sub(1).and_then(|offset| bytes.get(offset)) == Some(&b'=') || bytes.get(index + 2) == Some(&b'=');
    if adjacent_equals {
      index += 2;
      continue;
    }
    if let Some(open) = opening {
      if index
        .checked_sub(1)
        .and_then(|offset| bytes.get(offset))
        .is_some_and(|byte| !byte.is_ascii_whitespace())
      {
        paired.insert(open);
        paired.insert(index);
        opening = None;
      }
    } else if bytes.get(index + 2).is_some_and(|byte| !byte.is_ascii_whitespace()) {
      opening = Some(index);
    }
    index += 2;
  }
  paired
}

pub fn escape_markdown_label(text: &str) -> String {
  text
    .chars()
    .fold(String::with_capacity(text.len()), |mut escaped, character| {
      if matches!(character, '\\' | '[' | ']') {
        escaped.push('\\');
      }
      escaped.push(character);
      escaped
    })
}

pub fn escape_markdown_destination(destination: &str) -> String {
  let mut escaped = String::with_capacity(destination.len());
  for character in destination.chars() {
    match character {
      ' ' => escaped.push_str("%20"),
      '\t' => escaped.push_str("%09"),
      '\n' => escaped.push_str("%0A"),
      '\r' => escaped.push_str("%0D"),
      '(' => escaped.push_str("%28"),
      ')' => escaped.push_str("%29"),
      '\\' => escaped.push_str("%5C"),
      '<' => escaped.push_str("%3C"),
      '>' => escaped.push_str("%3E"),
      _ => escaped.push(character),
    }
  }
  escaped
}

fn serialize_inline_code(text: &str) -> String {
  let longest_run = text
    .split(|character| character != '`')
    .map(str::len)
    .max()
    .unwrap_or(0);
  let delimiter = "`".repeat(longest_run.saturating_add(1).max(1));
  let all_spaces = !text.is_empty() && text.chars().all(|character| character == ' ');
  let needs_padding =
    !all_spaces && (text.starts_with('`') || text.starts_with(' ') || text.ends_with('`') || text.ends_with(' '));
  if needs_padding {
    format!("{delimiter} {text} {delimiter}")
  } else {
    format!("{delimiter}{text}{delimiter}")
  }
}

fn protect_block_start(text: &str) -> String {
  let first_line = text.lines().next().unwrap_or(text);
  let ordered_marker = first_line.split_once('.').is_some_and(|(number, rest)| {
    !number.is_empty() && number.chars().all(|character| character.is_ascii_digit()) && rest.starts_with(' ')
  });
  if ordered_marker {
    let dot = text.find('.').expect("ordered marker dot");
    let mut protected = String::with_capacity(text.len() + 1);
    protected.push_str(&text[..dot]);
    protected.push_str("\\.");
    protected.push_str(&text[dot + 1..]);
    return protected;
  }
  let needs_escape =
    first_line.starts_with("# ") || first_line.starts_with("> ") || first_line.starts_with("- ") || first_line == "---";
  if !needs_escape {
    return text.to_string();
  }
  let mut protected = String::with_capacity(text.len() + 1);
  protected.push('\\');
  protected.push_str(text);
  protected
}

fn safe_fence(source: &str) -> String {
  let longest_run = source
    .split(|character| character != '`')
    .map(str::len)
    .max()
    .unwrap_or(0);
  "`".repeat(longest_run.saturating_add(1).max(3))
}

/// Extract human-readable Markdown from a canonical or partially compatible
/// Yjs document.
///
/// The canonical block tree determines semantic order. Documents without that
/// tree use the deterministic root-text fallback and report a partial result.
#[instrument(skip(data))]
pub fn extract_text_from_yjs(data: &[u8]) -> Result<YjsExtractResult, String> {
  extract_text_from_yjs_with_image_filter(data, &|_| true)
}

/// Extract Markdown while omitting native image blocks rejected by a caller
/// policy. The predicate receives only the stored image source and must remain
/// pure; persistence and transport policy stay outside this codec.
#[instrument(skip(data, image_allowed))]
pub fn extract_text_from_yjs_with_image_filter(
  data: &[u8],
  image_allowed: &dyn Fn(&str) -> bool,
) -> Result<YjsExtractResult, String> {
  extract_text_from_yjs_with_references(data, image_allowed, &|_| None)
}

/// Extract Markdown with an operation-local, caller-authorized reference map.
#[instrument(skip(data, image_allowed, resolve_reference))]
pub fn extract_text_from_yjs_with_references(
  data: &[u8],
  image_allowed: &dyn Fn(&str) -> bool,
  resolve_reference: &dyn Fn(&MarkdownDocumentReference) -> Option<MarkdownResolvedReference>,
) -> Result<YjsExtractResult, String> {
  extract_text_from_yjs_with_references_and_images(data, image_allowed, resolve_reference, &|source| {
    Some(source.to_string())
  })
}

/// Extract Markdown while resolving native blocks and attributed inline image
/// sources against one final outbound asset plan. A missing mapping omits the
/// image instead of emitting a dangling local path or internal blob key.
#[instrument(skip(data, image_allowed, resolve_reference, resolve_image))]
pub fn extract_text_from_yjs_with_references_and_images(
  data: &[u8],
  image_allowed: &dyn Fn(&str) -> bool,
  resolve_reference: &dyn Fn(&MarkdownDocumentReference) -> Option<MarkdownResolvedReference>,
  resolve_image: &dyn Fn(&str) -> Option<String>,
) -> Result<YjsExtractResult, String> {
  if data.is_empty() {
    return Ok(YjsExtractResult {
      citations: Vec::new(),
      title: None,
      markdown: String::new(),
      blocks_visited: 0,
      extraction_partial: false,
      diagnostics: Vec::new(),
    });
  }

  let doc = Doc::new();
  // Pre-register root-level types BEFORE applying updates or opening read transactions.
  // yrs requires mutable access for `get_or_insert_map` — doing it after transact() panics.
  // Pre-register all root-level types BEFORE applying the update.
  // yrs panics if get_or_insert_* is called while a transaction is open.
  let blocks_map = doc.get_or_insert_map("blocks");
  let _meta_map = doc.get_or_insert_map("meta");
  let text_refs: Vec<(&str, yrs::TextRef)> = ["content", "text", "body", "title"]
    .iter()
    .map(|key| (*key, doc.get_or_insert_text(*key)))
    .collect();
  {
    let mut tx = doc.transact_mut();
    let u = Update::decode_v1(data).map_err(|e| e.to_string())?;
    tx.apply_update(u).map_err(|e| e.to_string())?;
  }

  let txn = doc.transact();
  let block_count = blocks_map.len(&txn);

  if block_count == 0 {
    // Fall back: collect all Y.Text values from pre-registered refs
    let mut parts: Vec<String> = Vec::new();
    let mut unresolved_references = 0usize;
    let mut unsupported_native_content = 0usize;
    let mut normalized_highlights = 0usize;
    let mut missing_native_sources = 0usize;
    let mut annotation_diagnostics = Vec::new();
    for (_key, text_ref) in &text_refs {
      if text_ref.diff(&txn, YChange::identity).iter().any(|diff| {
        diff
          .attributes
          .as_deref()
          .is_some_and(|attrs| attrs.contains_key("footnote"))
      }) {
        return Err("Footnotes require a reachable parent block tree".into());
      }
      annotation_diagnostics.extend(annotation_findings(text_ref, &txn, false));
      let (s, unresolved, unsupported, normalized, missing_sources) =
        extract_markdown_text_with_references(text_ref, &txn, resolve_reference, resolve_image);
      unresolved_references += unresolved;
      unsupported_native_content += unsupported;
      normalized_highlights += normalized;
      missing_native_sources += missing_sources;
      if !s.is_empty() {
        parts.push(s);
      }
    }
    return Ok(YjsExtractResult {
      citations: Vec::new(),
      title: None,
      markdown: parts.join("\n\n"),
      blocks_visited: 0,
      extraction_partial: true,
      diagnostics: (0..unresolved_references)
        .map(|_| MarkdownDiagnostic {
          code: MarkdownDiagnosticCode::UnresolvedDocumentReference,
        })
        .chain((0..unsupported_native_content).map(|_| MarkdownDiagnostic {
          code: MarkdownDiagnosticCode::UnsupportedNativeContent,
        }))
        .chain((0..missing_native_sources).map(|_| MarkdownDiagnostic {
          code: MarkdownDiagnosticCode::MissingNativeSource,
        }))
        .chain((0..normalized_highlights).map(|_| MarkdownDiagnostic {
          code: MarkdownDiagnosticCode::NormalizedHighlight,
        }))
        .chain(annotation_diagnostics)
        .collect(),
    });
  }

  // Walk blocks map — each value is a YMap with "flavour", "props", "children"
  let mut lines: Vec<String> = Vec::new();
  let mut title: Option<String> = None;
  let mut blocks_visited = 0u32;
  let mut partial = false;

  // Collect all block IDs and their data.
  // Virgultum uses two naming conventions depending on version:
  //   Old/server-generated: "flavour", "children", "text", props in "props" sub-map
  //   New/client-generated: "sys:flavour", "sys:children", "prop:text", props flat with "prop:" prefix
  // We support both formats by trying the prefixed variant first, falling back to the unprefixed.
  let mut block_data: std::collections::HashMap<String, BlockInfo> = std::collections::HashMap::new();

  // Helper: read a string from a block map, trying "sys:{key}" first then "{key}"
  fn get_block_string(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, key: &str) -> Option<String> {
    let prefixed = format!("sys:{key}");
    block_map
      .get(txn, &prefixed)
      .or_else(|| block_map.get(txn, key))
      .and_then(|v| match v {
        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
        _ => None,
      })
  }

  // Helper: read a string property, trying "prop:{key}" first then via "props" sub-map
  fn get_prop_string(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, key: &str) -> Option<String> {
    // Try flat "prop:{key}" first (new format)
    let prefixed = format!("prop:{key}");
    if let Some(value) = block_map.get(txn, &prefixed) {
      match value {
        yrs::Out::Any(yrs::Any::String(s)) => return Some(s.to_string()),
        yrs::Out::YText(text_ref) => return Some(extract_formatted_text(&text_ref, txn)),
        _ => {}
      }
    }
    // Fall back to "props" sub-map (old format)
    if let Some(yrs::Out::YMap(props)) = block_map.get(txn, "props")
      && let Some(value) = props.get(txn, key)
    {
      match value {
        yrs::Out::Any(yrs::Any::String(s)) => return Some(s.to_string()),
        yrs::Out::YText(text_ref) => return Some(extract_formatted_text(&text_ref, txn)),
        _ => {}
      }
    }
    None
  }

  // Helper: read a numeric property
  fn get_prop_number(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, key: &str) -> Option<u32> {
    let prefixed = format!("prop:{key}");
    let val = block_map.get(txn, &prefixed).or_else(|| {
      block_map.get(txn, "props").and_then(|v| {
        if let yrs::Out::YMap(props) = v {
          props.get(txn, key)
        } else {
          None
        }
      })
    });
    match val {
      Some(yrs::Out::Any(yrs::Any::BigInt(n))) => Some(n as u32),
      Some(yrs::Out::Any(yrs::Any::Number(n))) => n.as_f64().map(|n| n as u32),
      _ => None,
    }
  }

  // Helper: read a boolean property
  fn get_prop_bool(block_map: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, key: &str) -> Option<bool> {
    let prefixed = format!("prop:{key}");
    let val = block_map.get(txn, &prefixed).or_else(|| {
      block_map.get(txn, "props").and_then(|v| {
        if let yrs::Out::YMap(props) = v {
          props.get(txn, key)
        } else {
          None
        }
      })
    });
    match val {
      Some(yrs::Out::Any(yrs::Any::Bool(b))) => Some(b),
      _ => None,
    }
  }

  #[derive(Debug, Default)]
  struct OrderedTableEntry {
    id: String,
    order: String,
    text_align: Option<String>,
  }

  fn split_flat_key<'k>(key: &'k str, prefix: &str) -> Option<(&'k str, &'k str)> {
    let rest = key.strip_prefix(prefix)?;
    rest.rsplit_once('.')
  }

  fn table_value_to_string(
    value: &yrs::Out,
    txn: &yrs::TransactionMut<'_>,
    resolve_reference: &dyn Fn(&MarkdownDocumentReference) -> Option<MarkdownResolvedReference>,
    resolve_image: &dyn Fn(&str) -> Option<String>,
    unresolved: &mut usize,
    unsupported: &mut usize,
    normalized_highlights: &mut usize,
    missing_image_sources: &mut usize,
    html: bool,
  ) -> Option<String> {
    match value {
      yrs::Out::Any(yrs::Any::String(s)) => Some(if html {
        super::table_html::escape(s).replace('\n', "<br>")
      } else {
        s.to_string()
      }),
      yrs::Out::Any(yrs::Any::Number(n)) => Some(n.to_string()),
      yrs::Out::Any(yrs::Any::BigInt(n)) => Some(n.to_string()),
      yrs::Out::YText(text) => {
        let (markdown, count, skipped, normalized, missing_sources) =
          extract_text_with_references(text, txn, resolve_reference, resolve_image, html);
        *unresolved += count;
        *unsupported += skipped;
        *normalized_highlights += normalized;
        *missing_image_sources += missing_sources;
        Some(markdown)
      }
      _ => None,
    }
  }

  fn extract_flat_table(
    block_map: &yrs::MapRef,
    txn: &yrs::TransactionMut<'_>,
    resolve_reference: &dyn Fn(&MarkdownDocumentReference) -> Option<MarkdownResolvedReference>,
    resolve_image: &dyn Fn(&str) -> Option<String>,
    unresolved: &mut usize,
    unsupported: &mut usize,
    normalized_highlights: &mut usize,
    missing_image_sources: &mut usize,
    html: bool,
  ) -> (Vec<Vec<String>>, Vec<Option<String>>) {
    let mut rows: std::collections::HashMap<String, OrderedTableEntry> = std::collections::HashMap::new();
    let mut columns: std::collections::HashMap<String, OrderedTableEntry> = std::collections::HashMap::new();
    let mut cells: std::collections::HashMap<String, yrs::Out> = std::collections::HashMap::new();

    for (key, value) in block_map.iter(txn) {
      if let Some((row_id, field)) = split_flat_key(key, "prop:rows.") {
        let entry = rows.entry(row_id.to_string()).or_insert_with(|| OrderedTableEntry {
          id: row_id.to_string(),
          order: String::new(),
          text_align: None,
        });
        match field {
          "rowId" => {
            if let Some(value) = table_value_to_string(
              &value,
              txn,
              resolve_reference,
              resolve_image,
              unresolved,
              unsupported,
              normalized_highlights,
              missing_image_sources,
              false,
            ) {
              entry.id = value;
            }
          }
          "order" => {
            if let Some(value) = table_value_to_string(
              &value,
              txn,
              resolve_reference,
              resolve_image,
              unresolved,
              unsupported,
              normalized_highlights,
              missing_image_sources,
              false,
            ) {
              entry.order = value;
            }
          }
          _ => {}
        }
      } else if let Some((column_id, field)) = split_flat_key(key, "prop:columns.") {
        let entry = columns
          .entry(column_id.to_string())
          .or_insert_with(|| OrderedTableEntry {
            id: column_id.to_string(),
            order: String::new(),
            text_align: None,
          });
        match field {
          "columnId" => {
            if let Some(value) = table_value_to_string(
              &value,
              txn,
              resolve_reference,
              resolve_image,
              unresolved,
              unsupported,
              normalized_highlights,
              missing_image_sources,
              false,
            ) {
              entry.id = value;
            }
          }
          "order" => {
            if let Some(value) = table_value_to_string(
              &value,
              txn,
              resolve_reference,
              resolve_image,
              unresolved,
              unsupported,
              normalized_highlights,
              missing_image_sources,
              false,
            ) {
              entry.order = value;
            }
          }
          "textAlign" => {
            entry.text_align = table_value_to_string(
              &value,
              txn,
              resolve_reference,
              resolve_image,
              unresolved,
              unsupported,
              normalized_highlights,
              missing_image_sources,
              false,
            )
            .filter(|value| matches!(value.as_str(), "left" | "center" | "right"));
          }
          _ => {}
        }
      } else if let Some(cell_key) = key
        .strip_prefix("prop:cells.")
        .and_then(|rest| rest.strip_suffix(".text"))
      {
        cells.insert(cell_key.to_string(), value);
      }
    }

    if rows.is_empty() || columns.is_empty() {
      return (Vec::new(), Vec::new());
    }

    let mut rows: Vec<_> = rows.into_values().collect();
    let mut columns: Vec<_> = columns.into_values().collect();
    rows.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    columns.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));

    let alignments = columns.iter().map(|column| column.text_align.clone()).collect();
    let rows = rows
      .iter()
      .map(|row| {
        columns
          .iter()
          .map(|column| {
            cells
              .get(&format!("{}:{}", row.id, column.id))
              .and_then(|value| {
                table_value_to_string(
                  value,
                  txn,
                  resolve_reference,
                  resolve_image,
                  unresolved,
                  unsupported,
                  normalized_highlights,
                  missing_image_sources,
                  html,
                )
              })
              .unwrap_or_default()
          })
          .collect()
      })
      .collect();
    (rows, alignments)
  }

  // We need a mutable transaction for the helper functions (yrs API quirk)
  drop(txn);
  let txn = doc.transact_mut();
  let opaque_descendants = crate::opaque_database_reference_descendants(&blocks_map, &txn);
  let root_id = blocks_map.iter(&txn).find_map(|(id, value)| match value {
    yrs::Out::YMap(block)
      if get_block_string(&block, &txn, "flavour").is_some_and(|kind| resolve_flavour(&kind) == "myoxus:page") =>
    {
      Some(id.to_string())
    }
    _ => None,
  });
  // Resolve rich content only in the tree the writer will emit. Deleted blocks
  // can remain in the Yjs map; observing them would disclose stale references
  // and allocate export anchors for content absent from the Markdown output.
  // Rootless snapshots retain the existing diagnosed best-effort fallback.
  let reachable = root_id.as_ref().map(|root| {
    let mut visited = std::collections::HashSet::new();
    let mut pending = vec![(root.clone(), 0usize)];
    while let Some((id, depth)) = pending.pop() {
      if depth > super::MAX_BLOCK_DEPTH || !visited.insert(id.clone()) {
        continue;
      }
      let Some(yrs::Out::YMap(block)) = blocks_map.get(&txn, &id) else {
        continue;
      };
      if crate::has_opaque_database_reference(&block, &txn)
        && get_block_string(&block, &txn, "flavour").is_some_and(|kind| resolve_flavour(&kind) == "myoxus:database")
      {
        continue;
      }
      if let Some(yrs::Out::YArray(children)) = block.get(&txn, "sys:children").or_else(|| block.get(&txn, "children"))
      {
        let children = children
          .iter(&txn)
          .filter_map(|value| match value {
            yrs::Out::Any(yrs::Any::String(id)) => Some((id.to_string(), depth + 1)),
            _ => None,
          })
          .collect::<Vec<_>>();
        pending.extend(children.into_iter().rev());
      }
    }
    visited
  });
  let mut unresolved_references = 0usize;
  let mut normalized_highlights = 0usize;
  let mut omitted_native_metadata = 0usize;
  let mut missing_native_sources = 0usize;
  let mut unsupported_native_content = 0usize;
  let mut missing_child_blocks = 0usize;
  let mut annotation_diagnostics = Vec::new();

  let mut footnotes = Vec::<serde_json::Value>::new();
  let mut normalized_endnotes = 0;
  fn collect_footnotes<T: ReadTxn>(
    value: yrs::Out,
    txn: &T,
    found: &mut Vec<serde_json::Value>,
    depth: usize,
  ) -> Result<(), String> {
    if depth > super::MAX_BLOCK_DEPTH {
      return Err("Footnote property nesting exceeds document recursion limit".into());
    }
    match value {
      yrs::Out::YText(text) => {
        for diff in text.diff(txn, YChange::identity) {
          if let Some(value) = diff.attributes.as_deref().and_then(|attrs| attrs.get("footnote")) {
            found.push(yjs_any_to_json(value));
          }
        }
      }
      yrs::Out::YMap(map) => {
        for (_, child) in map.iter(txn) {
          collect_footnotes(child, txn, found, depth + 1)?;
        }
      }
      yrs::Out::YArray(array) => {
        for child in array.iter(txn) {
          collect_footnotes(child, txn, found, depth + 1)?;
        }
      }
      _ => {}
    }
    Ok(())
  }
  for (id, value) in blocks_map.iter(&txn) {
    // This prepass also feeds citation footers, before ordinary block rendering.
    if opaque_descendants.contains(id)
      || matches!(&value, yrs::Out::YMap(block)
      if get_block_string(block, &txn, "flavour").is_some_and(|kind| resolve_flavour(&kind) == "myoxus:database")
        && crate::has_opaque_database_reference(block, &txn))
    {
      continue;
    }
    if reachable.as_ref().is_none_or(|ids| ids.contains(id)) {
      collect_footnotes(value, &txn, &mut footnotes, 0)?;
    }
  }
  let mut callout_diagnostics = Vec::new();

  // The retained hierarchical table reader uses ordinary child blocks as cells.
  // Select their syntax before attribution projection as well, so a legacy
  // headerless cell never escapes already formatted Markdown into HTML.
  let mut html_table_cells = std::collections::HashSet::new();
  for (_, value) in blocks_map.iter(&txn) {
    let yrs::Out::YMap(table) = value else { continue };
    if get_block_string(&table, &txn, "flavour").is_none_or(|kind| resolve_flavour(&kind) != "myoxus:table")
      || get_prop_number(&table, &txn, "headerRows") == Some(1)
      || table.iter(&txn).any(|(key, _)| key.starts_with("prop:rows."))
    {
      continue;
    }
    for row in block_children(&table, &txn) {
      html_table_cells.insert(row.clone());
      if let Some(yrs::Out::YMap(row)) = blocks_map.get(&txn, &row) {
        html_table_cells.extend(block_children(&row, &txn));
      }
    }
  }

  for (key, value) in blocks_map.iter(&txn) {
    if opaque_descendants.contains(key) {
      continue;
    }
    if reachable.as_ref().is_some_and(|ids| !ids.contains(key)) {
      continue;
    }
    if let yrs::Out::YMap(block_map) = value {
      let flavour = get_block_string(&block_map, &txn, "flavour").unwrap_or_default();
      let canonical_flavour = resolve_flavour(flavour.as_str()).to_string();
      if canonical_flavour == "myoxus:database" && crate::has_opaque_database_reference(&block_map, &txn) {
        block_data.insert(
          key.to_string(),
          BlockInfo {
            flavour,
            database_row_reference: true,
            ..Default::default()
          },
        );
        continue;
      }

      if canonical_flavour == "myoxus:table" {
        for (key, value) in block_map.iter(&txn) {
          if key.starts_with("prop:cells.")
            && key.ends_with(".text")
            && let yrs::Out::YText(text) = value
          {
            annotation_diagnostics.extend(annotation_findings(&text, &txn, false));
          }
        }
      }

      let children_key_prefixed = "sys:children";
      let children_ids: Vec<String> = block_map
        .get(&txn, children_key_prefixed)
        .or_else(|| block_map.get(&txn, "children"))
        .and_then(|v| {
          if let yrs::Out::YArray(arr) = v {
            Some(
              arr
                .iter(&txn)
                .filter_map(|item| match item {
                  yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                  _ => None,
                })
                .collect(),
            )
          } else {
            None
          }
        })
        .unwrap_or_default();

      // Code blocks are Markdown containers, not Markdown inline content: their
      // punctuation must remain byte-for-byte text instead of being escaped.
      let mut text_content = block_map
        .get(&txn, "prop:text")
        .or_else(|| block_map.get(&txn, "text"))
        .or_else(|| block_map.get(&txn, "prop:title"))
        .and_then(|v| {
          if let yrs::Out::YText(t) = v {
            if !html_table_cells.contains(key)
              && (canonical_flavour == "myoxus:code"
                || canonical_flavour == "myoxus:page"
                || canonical_flavour == "myoxus:annotation")
            {
              if canonical_flavour == "myoxus:annotation"
                && super::annotation_syntax::serialize_body(&t.get_string(&txn)).is_none()
              {
                annotation_diagnostics.push(MarkdownDiagnostic {
                  code: MarkdownDiagnosticCode::UnsupportedAnnotation,
                });
              }
              Some(t.get_string(&txn))
            } else {
              annotation_diagnostics.extend(annotation_findings(
                &t,
                &txn,
                canonical_flavour == "myoxus:paragraph"
                  && get_prop_string(&block_map, &txn, "type")
                    .as_deref()
                    .is_none_or(|kind| kind == "text"),
              ));
              let plain_text = t.get_string(&txn);
              let has_semantic_attributes = t.diff(&txn, YChange::identity).iter().any(|diff| {
                diff
                  .attributes
                  .as_ref()
                  .is_some_and(|attributes| !attributes.is_empty())
              });
              // Empty paragraphs stay empty, but an attributed placeholder
              // can carry a document reference whose visible label is resolved
              // below and must therefore still use the formatted projector.
              if plain_text.trim().is_empty() && !has_semantic_attributes {
                return Some(if html_table_cells.contains(key) {
                  super::table_html::escape(&plain_text).replace('\n', "<br>")
                } else {
                  plain_text
                });
              }
              let (markdown, count, skipped, normalized, missing_sources) = extract_text_with_references(
                &t,
                &txn,
                resolve_reference,
                resolve_image,
                html_table_cells.contains(key),
              );
              unresolved_references += count;
              unsupported_native_content += skipped;
              normalized_highlights += normalized;
              missing_native_sources += missing_sources;
              Some(markdown)
            }
          } else {
            None
          }
        })
        .unwrap_or_default();

      if let Some(anchor) = get_prop_string(&block_map, &txn, "markdownAnchor") {
        if super::targets::valid_markdown_anchor(&anchor)
          && !text_content.trim().is_empty()
          && matches!(
            canonical_flavour.as_str(),
            "myoxus:paragraph" | "myoxus:list" | "myoxus:callout"
          )
        {
          text_content.push_str(&format!(" ^{anchor}"));
        } else {
          unsupported_native_content += 1;
        }
      }

      let level = get_prop_number(&block_map, &txn, "level").unwrap_or(1);
      let language = get_prop_string(&block_map, &txn, "language").unwrap_or_default();
      let list_type = get_prop_string(&block_map, &txn, "type").unwrap_or_else(|| "bulleted".to_string());

      // Bookmark properties
      let url = get_prop_string(&block_map, &txn, "url").unwrap_or_default();
      let bookmark_title = get_prop_string(&block_map, &txn, "title").unwrap_or_default();

      // Image properties: prefer sourceId, fall back to url
      let image_source = get_prop_string(&block_map, &txn, "sourceId")
        .or_else(|| get_prop_string(&block_map, &txn, "url"))
        .unwrap_or_default();
      let image_caption = get_prop_string(&block_map, &txn, "caption").unwrap_or_default();

      // Latex property
      let latex = get_prop_string(&block_map, &txn, "latex").unwrap_or_default();
      if canonical_flavour == "myoxus:latex"
        && !latex.is_empty()
        && super::import::serialize_math(&latex, true).is_none()
      {
        annotation_diagnostics.push(MarkdownDiagnostic {
          code: MarkdownDiagnosticCode::UnsupportedMath,
        });
      }
      let mermaid_source = get_prop_string(&block_map, &txn, "source").unwrap_or_default();
      let diagram_title = get_prop_string(&block_map, &txn, "title").unwrap_or_default();
      let mermaid_caption = get_prop_string(&block_map, &txn, "caption").unwrap_or_default();

      // Task list checked state
      let checked = get_prop_bool(&block_map, &txn, "checked");
      let order = get_prop_number(&block_map, &txn, "order");
      let level = level.clamp(1, 6);
      let list_type = if flavour == "affine:heading" && !list_type.starts_with('h') {
        format!("h{level}")
      } else {
        list_type
      };
      let table_header_rows = get_prop_number(&block_map, &txn, "headerRows").map(|count| count as usize);
      let (table_rows, table_alignments) = if canonical_flavour == "myoxus:table" {
        extract_flat_table(
          &block_map,
          &txn,
          resolve_reference,
          resolve_image,
          &mut unresolved_references,
          &mut unsupported_native_content,
          &mut normalized_highlights,
          &mut missing_native_sources,
          table_header_rows != Some(1),
        )
      } else {
        (Vec::new(), Vec::new())
      };

      let callout_title = (canonical_flavour == "myoxus:callout"
        && get_prop_string(&block_map, &txn, "type").is_some_and(|kind| !kind.is_empty()))
      .then(|| match block_map.get(&txn, "prop:title") {
        Some(yrs::Out::YText(title)) => title.get_string(&txn),
        _ => get_prop_string(&block_map, &txn, "title").unwrap_or_default(),
      });
      if callout_title.as_ref().is_some_and(|title| title.contains(['\r', '\n'])) {
        callout_diagnostics.push(MarkdownDiagnostic {
          code: MarkdownDiagnosticCode::UnsupportedCallout,
        });
      }
      let embed_source = (canonical_flavour == "myoxus:embed-synced-doc").then(|| {
        let reference = MarkdownDocumentReference {
          page_id: get_prop_string(&block_map, &txn, "pageId").unwrap_or_default(),
          title: get_prop_string(&block_map, &txn, "title"),
          description: get_prop_string(&block_map, &txn, "description"),
          params: block_prop_json(&block_map, &txn, "params"),
        };
        let resolved = resolve_reference(&reference);
        if resolved.is_none() || reference.page_id.is_empty() {
          unresolved_references += 1;
        }
        let target = resolved.map_or(reference.page_id, |target| target.url);
        let target = target
          .replace('|', "%7C")
          .replace('[', "%5B")
          .replace(']', "%5D")
          .replace('\r', "%0D")
          .replace('\n', "%0A");
        let title = reference.title.unwrap_or_default();
        if title.contains(['\r', '\n', '|'])
          || title.contains("]]")
          || reference.params.as_ref().is_some_and(|params| {
            ["blockIds", "elementIds"].iter().any(|key| {
              params
                .get(key)
                .and_then(serde_json::Value::as_array)
                .is_some_and(|ids| !ids.is_empty())
            })
          })
        {
          callout_diagnostics.push(MarkdownDiagnostic {
            code: MarkdownDiagnosticCode::UnsupportedDocumentReference,
          });
        }
        format!(
          "![[{target}{}]]",
          if title.is_empty() {
            String::new()
          } else {
            format!("|{title}")
          }
        )
      });
      let citation_definition = super::native_citation_definition(&block_map, &txn);
      if canonical_flavour == "myoxus:footnote-definition" {
        if crate::footnote::read_placement(&block_map, &txn)? == crate::footnote::FootnotePlacement::Endnote {
          normalized_endnotes += 1;
        }
      }
      block_data.insert(
        key.to_string(),
        BlockInfo {
          database_row_reference: crate::has_opaque_database_reference(&block_map, &txn),
          footnote_label: get_prop_string(&block_map, &txn, "label"),
          citation: citation_definition.is_some(),
          citation_definition,
          flavour,
          text_content,
          children_ids,
          language,
          list_type,
          url,
          bookmark_title,
          image_source,
          image_caption,
          latex,
          mermaid_source,
          diagram_title,
          mermaid_caption,
          checked,
          order,
          table_rows,
          table_alignments,
          table_header_rows,
          callout_title,
          callout_foldable: get_prop_bool(&block_map, &txn, "foldable").unwrap_or(false),
          callout_default_open: get_prop_bool(&block_map, &txn, "defaultOpen").unwrap_or(true),
          embed_source,
        },
      );
    }
  }

  let mut definition_labels = std::collections::HashMap::new();
  let mut used_labels = std::collections::HashMap::<String, String>::new();
  let mut citation_definitions = std::collections::BTreeMap::new();
  for (id, block) in &block_data {
    if resolve_flavour(&block.flavour) != "myoxus:footnote-definition" {
      continue;
    }
    let label = block.footnote_label.as_deref().unwrap_or_default();
    let normalized = super::import::normalize_footnote_label(label);
    if normalized.is_empty() || used_labels.insert(normalized.clone(), id.clone()).is_some() {
      return Err(format!("Conflicting footnote definition: {label}"));
    }
    definition_labels.insert(id.as_str(), normalized);
  }
  let mut parents = std::collections::HashMap::<&str, Vec<&str>>::new();
  for (parent_id, block) in &block_data {
    for child in &block.children_ids {
      parents.entry(child).or_default().push(parent_id);
    }
  }
  for id in definition_labels.keys() {
    if !parents
      .get(id)
      .is_some_and(|parents| parents.len() == 1 && resolve_flavour(&block_data[parents[0]].flavour) == "myoxus:note")
    {
      return Err(format!(
        "Invalid footnote definition parent: {}",
        block_data[*id].footnote_label.as_deref().unwrap_or_default()
      ));
    }
  }
  let mut referenced_definitions = std::collections::HashSet::new();
  for footnote in &footnotes {
    let label = footnote["label"]
      .as_str()
      .filter(|label| !super::import::normalize_footnote_label(label).is_empty())
      .ok_or("Invalid native footnote label")?;
    let normalized = super::import::normalize_footnote_label(label);
    match (footnote.get("definitionId"), footnote.get("reference")) {
      (Some(serde_json::Value::String(id)), None) if definition_labels.get(id.as_str()) == Some(&normalized) => {
        referenced_definitions.insert(id.to_string());
      }
      (None, Some(reference)) => {
        let reference = super::import::canonical_citation_reference(reference, label)?;
        if used_labels.contains_key(&normalized) {
          return Err(format!("Conflicting footnote definition: {label}"));
        }
        if let Some((_, existing)) = citation_definitions.insert(normalized, (label.to_string(), reference.clone()))
          && existing != reference
        {
          return Err(format!("Conflicting citation definition: {label}"));
        }
      }
      _ => return Err(format!("Unresolved footnote definition: {label}")),
    }
  }
  let cited_labels = citation_definitions
    .keys()
    .cloned()
    .collect::<std::collections::HashSet<_>>();
  // Referenced inline metadata is authoritative; Sources cards retain uncited definitions.
  for block in block_data.values() {
    if let Some((label, reference)) = &block.citation_definition {
      let normalized = super::import::normalize_footnote_label(label);
      if cited_labels.contains(&normalized) {
        continue;
      }
      let reference = super::import::canonical_citation_reference(reference, label)?;
      if normalized.is_empty() || used_labels.contains_key(&normalized) {
        return Err(format!("Conflicting footnote definition: {label}"));
      }
      if let Some((_, existing)) = citation_definitions.insert(normalized, (label.clone(), reference.clone()))
        && existing != reference
      {
        return Err(format!("Conflicting citation definition: {label}"));
      }
    }
  }
  for id in definition_labels.keys() {
    let mut pending = block_data[*id].children_ids.clone();
    let mut seen = std::collections::HashSet::new();
    while let Some(child_id) = pending.pop() {
      if !seen.insert(child_id.clone()) || parents.get(child_id.as_str()).is_none_or(|parents| parents.len() != 1) {
        return Err("Invalid footnote child tree".into());
      }
      let child = block_data.get(&child_id).ok_or("Missing footnote child block")?;
      if !matches!(
        resolve_flavour(&child.flavour),
        "myoxus:paragraph"
          | "myoxus:list"
          | "myoxus:code"
          | "myoxus:table"
          | "myoxus:image"
          | "myoxus:mermaid"
          | "myoxus:latex"
          | "myoxus:callout"
          | "myoxus:annotation"
          | "myoxus:divider"
      ) {
        return Err(format!("Unsupported footnote definition child: {}", child.flavour));
      }
      pending.extend(child.children_ids.clone());
      if let Some(value) = blocks_map.get(&txn, &child_id) {
        let mut nested = Vec::new();
        collect_footnotes(value, &txn, &mut nested, 0)?;
        if !nested.is_empty() {
          return Err(format!(
            "Nested footnote reference: {}",
            block_data[*id].footnote_label.as_deref().unwrap_or_default()
          ));
        }
      }
    }
  }
  let unreferenced_definitions = definition_labels
    .keys()
    .filter(|id| !referenced_definitions.contains(**id))
    .count()
    + citation_definitions
      .keys()
      .filter(|label| !cited_labels.contains(*label))
      .count();
  // Find root block (affine:page or block without parent)
  // Walk the tree depth-first to preserve document order
  struct RenderContext<'a> {
    block_data: &'a std::collections::HashMap<String, BlockInfo>,
    lines: &'a mut Vec<String>,
    title: &'a mut Option<String>,
    blocks_visited: &'a mut u32,
    partial: &'a mut bool,
    visited: &'a mut std::collections::HashSet<String>,
    image_allowed: &'a dyn Fn(&str) -> bool,
    resolve_image: &'a dyn Fn(&str) -> Option<String>,
    omitted_native_metadata: &'a mut usize,
    missing_native_sources: &'a mut usize,
    unsupported_native_content: &'a mut usize,
    missing_child_blocks: &'a mut usize,
    local_citations: &'a mut Vec<(String, serde_json::Value)>,
  }

  fn push_html_table(
    lines: &mut Vec<String>,
    rows: &[Vec<String>],
    alignments: &[Option<String>],
    header_rows: usize,
    prefix: &str,
  ) {
    let header_rows = header_rows.min(rows.len());
    let mut html = String::from("<table>");
    if header_rows > 0 {
      html.push_str("<thead>");
    }
    for (index, row) in rows.iter().enumerate() {
      if index == header_rows {
        if header_rows > 0 {
          html.push_str("</thead>");
        }
        html.push_str("<tbody>");
      }
      html.push_str("<tr>");
      let tag = if index < header_rows { "th" } else { "td" };
      for (column, cell) in row.iter().enumerate() {
        let alignment = alignments
          .get(column)
          .and_then(Option::as_deref)
          .filter(|value| matches!(*value, "left" | "center" | "right"));
        let style = alignment
          .map(|value| format!(" style=\"text-align: {value}\""))
          .unwrap_or_default();
        html.push_str(&format!("<{tag}{style}>{cell}</{tag}>"));
      }
      html.push_str("</tr>");
    }
    html.push_str(if header_rows == rows.len() {
      "</thead>"
    } else {
      "</tbody>"
    });
    html.push_str("</table>");
    // One complete HTML block: blank lines would terminate it in CommonMark.
    lines.push(format!("{prefix}{html}"));
    lines.push(String::new());
  }

  fn push_markdown_table(lines: &mut Vec<String>, rows: &[Vec<String>], alignments: &[Option<String>], prefix: &str) {
    if rows.is_empty() {
      return;
    }

    let col_count = rows.iter().map(|row| row.len()).max().unwrap_or(0);
    if col_count == 0 {
      return;
    }

    for (index, row) in rows.iter().enumerate() {
      let mut cells: Vec<String> = row.iter().map(|cell| escape_markdown_table_cell(cell)).collect();
      cells.resize(col_count, String::new());
      lines.push(format!("{prefix}| {} |", cells.join(" | ")));
      if index == 0 {
        let separator: Vec<&str> = (0..col_count)
          .map(|column| match alignments.get(column).and_then(Option::as_deref) {
            Some("left") => ":---",
            Some("center") => ":---:",
            Some("right") => "---:",
            _ => "---",
          })
          .collect();
        lines.push(format!("{prefix}| {} |", separator.join(" | ")));
      }
    }
    lines.push(String::new());
  }

  fn render_block(id: &str, depth: usize, prefix: &str, ctx: &mut RenderContext<'_>) {
    // YJS-RV-02: Prevent stack overflow from cyclic/deeply nested blocks.
    if depth > super::MAX_BLOCK_DEPTH || !ctx.visited.insert(id.to_string()) {
      *ctx.partial = true;
      return;
    }
    let Some(block) = ctx.block_data.get(id) else {
      *ctx.partial = true;
      *ctx.missing_child_blocks += 1;
      return;
    };
    *ctx.blocks_visited += 1;

    if block.citation {
      return;
    }
    match resolve_flavour(block.flavour.as_str()) {
      "myoxus:footnote-definition" => {
        let start = ctx.lines.len();
        for (index, child) in block.children_ids.iter().enumerate() {
          render_block(child, depth + 1, "", ctx);
          let child_is_list = ctx
            .block_data
            .get(child)
            .is_some_and(|child| resolve_flavour(&child.flavour) == "myoxus:list");
          let next_is_list = block
            .children_ids
            .get(index + 1)
            .and_then(|id| ctx.block_data.get(id))
            .is_some_and(|child| resolve_flavour(&child.flavour) == "myoxus:list");
          // Obsidian requires a blank boundary before the next ordinary body
          // block, otherwise a quote can become part of the last nested item.
          if child_is_list
            && index + 1 < block.children_ids.len()
            && !next_is_list
            && ctx.lines.last().is_some_and(|line| !line.is_empty())
          {
            ctx.lines.push(String::new());
          }
        }
        let body = ctx.lines.drain(start..).collect::<Vec<_>>();
        // One unambiguous link inside a local definition is a source convention;
        // ordinary document links are never promoted to citation facts.
        let definition_body = body.join("\n");
        let links = pulldown_cmark::Parser::new(&definition_body)
          .filter_map(|event| {
            if let pulldown_cmark::Event::Start(pulldown_cmark::Tag::Link { dest_url, .. }) = event {
              Some(dest_url.to_string())
            } else {
              None
            }
          })
          .collect::<Vec<_>>();
        if links.len() == 1 {
          ctx.local_citations.push((
            block.footnote_label.clone().unwrap_or_default(),
            serde_json::json!({"type":"url", "url":links[0]}),
          ));
        }

        ctx.lines.push(format!(
          "{prefix}[^{}]: {}",
          escape_markdown_label(block.footnote_label.as_deref().unwrap_or_default()),
          body.first().map(String::as_str).unwrap_or_default()
        ));
        for line in body.iter().skip(1) {
          ctx.lines.push(if line.is_empty() {
            String::new()
          } else {
            format!("{prefix}    {line}")
          });
        }
        ctx.lines.push(String::new());
        return;
      }
      "myoxus:page" => {
        // page block: title is in text_content
        if !block.text_content.is_empty() {
          *ctx.title = Some(block.text_content.clone());
        }
      }
      "myoxus:paragraph" => {
        // New Virgultum format: headings are paragraphs with prop:type = "h1".."h6"
        if block.list_type.starts_with("h") {
          let heading_level = block.list_type[1..].parse::<u32>().unwrap_or(1).min(6);
          let marker = "#".repeat(heading_level as usize);
          if !block.text_content.is_empty() {
            // Use first heading as title if none set yet
            if ctx.title.is_none() && heading_level == 1 {
              *ctx.title = Some(block.text_content.clone());
            }
            ctx.lines.push(format!("{prefix}{marker} {}", block.text_content));
            ctx.lines.push(String::new());
          }
        } else if block.list_type == "quote" {
          for line in protect_block_start(&block.text_content).split('\n') {
            ctx.lines.push(format!("{prefix}> {line}"));
          }
          ctx.lines.push(format!("{prefix}>").trim_end().to_string());
        } else if !block.text_content.is_empty() {
          for line in protect_block_start(&block.text_content).split('\n') {
            ctx.lines.push(format!("{prefix}{line}"));
          }
          ctx.lines.push(String::new());
        }
      }
      "myoxus:callout" => {
        let marker = match &block.callout_title {
          Some(title) => format!(
            "[!{}]{}{}",
            block.list_type,
            if block.callout_foldable {
              if block.callout_default_open { "+" } else { "-" }
            } else {
              ""
            },
            if title.is_empty() {
              String::new()
            } else {
              format!(" {title}")
            }
          ),
          None => "[!]".to_string(),
        };
        for line in marker.lines() {
          ctx.lines.push(format!("{prefix}> {line}"));
        }
        if !block.text_content.is_empty() {
          ctx.lines.push(format!("{prefix}>"));
          for line in block.text_content.lines() {
            ctx.lines.push(format!("{prefix}> {line}"));
          }
        }
        ctx.lines.push(format!("{prefix}>"));
      }
      "myoxus:code" => {
        let fence = safe_fence(&block.text_content);
        ctx.lines.push(format!("{prefix}{fence}{}", block.language));
        for line in block.text_content.split('\n') {
          ctx.lines.push(format!("{prefix}{line}"));
        }
        ctx.lines.push(format!("{prefix}{fence}"));
        ctx.lines.push(String::new());
      }
      "myoxus:embed-synced-doc" => {
        ctx
          .lines
          .push(format!("{prefix}{}", block.embed_source.as_deref().unwrap_or_default()));
        ctx.lines.push(String::new());
      }
      "myoxus:annotation" => {
        if super::annotation_syntax::serialize_body(&block.text_content).is_none() {
          *ctx.partial = true;
        }
        for line in annotation_source_or_literal(&block.text_content).split('\n') {
          ctx.lines.push(format!("{prefix}{line}"));
        }
        ctx.lines.push(String::new());
      }
      "myoxus:list" => {
        // Every persisted list owns `checked`; only the list type gives that
        // value task-list semantics.
        let marker = match block.list_type.as_str() {
          "todo" if block.checked.unwrap_or(false) => "- [x]".to_string(),
          "todo" => "- [ ]".to_string(),
          "numbered" => format!("{}.", block.order.unwrap_or(1)),
          _ => "-".to_string(),
        };
        let protected_content = protect_block_start(&block.text_content);
        let mut content_lines = protected_content.split('\n');
        ctx
          .lines
          .push(format!("{prefix}{marker} {}", content_lines.next().unwrap_or_default()));
        // A task marker belongs to the list item's paragraph, not to the
        // CommonMark list marker. Children and continuation lines therefore
        // start at the two-column content indent of `- `, just like bullets.
        let content_indent = if block.list_type == "numbered" {
          marker.chars().count() + 1
        } else {
          2
        };
        let continuation_prefix = format!("{prefix}{}", " ".repeat(content_indent));
        for line in content_lines {
          ctx.lines.push(format!("{continuation_prefix}{line}"));
        }
      }
      "myoxus:bookmark" => {
        if !block.url.is_empty() {
          let link_title = if block.bookmark_title.is_empty() {
            block.url.clone()
          } else {
            block.bookmark_title.clone()
          };
          ctx.lines.push(format!(
            "{prefix}[{}]({})",
            escape_markdown_label(&link_title),
            escape_markdown_destination(&block.url)
          ));
          ctx.lines.push(String::new());
        }
      }
      "myoxus:image" => {
        if !block.image_source.is_empty() && (ctx.image_allowed)(&block.image_source) {
          let Some(image_source) = (ctx.resolve_image)(&block.image_source) else {
            *ctx.partial = true;
            *ctx.missing_native_sources += 1;
            return;
          };
          let caption = if block.image_caption.is_empty() {
            String::new()
          } else {
            block.image_caption.clone()
          };
          ctx.lines.push(format!(
            "{prefix}![{}]({})",
            escape_markdown_label(&caption),
            escape_markdown_destination(&image_source)
          ));
          ctx.lines.push(String::new());
        }
      }
      "myoxus:latex" => {
        if !block.latex.is_empty() {
          if ctx.lines.last().is_some_and(|line| !line.is_empty()) {
            ctx.lines.push(String::new());
          }
          let source = super::import::serialize_math(&block.latex, true).unwrap_or_else(|| {
            let fence = safe_fence(&block.latex);
            format!("{fence}latex\n{}\n{fence}", block.latex)
          });
          ctx
            .lines
            .extend(source.split('\n').map(|line| format!("{prefix}{line}")));
          ctx.lines.push(String::new());
        }
      }
      "myoxus:bpmn" => {
        // XML heads and stored SVG are private source/derived artifacts. Generic
        // text/search consumers get only the authored title and explicit loss.
        let title = block.diagram_title.trim();
        let title = if title.is_empty() { "BPMN Diagram" } else { title };
        ctx
          .lines
          .push(format!("{prefix}> BPMN: {}", escape_markdown_literal_text(title)));
        ctx.lines.push(String::new());
        *ctx.partial = true;
        *ctx.unsupported_native_content += 1;
      }
      "myoxus:mermaid" => {
        if block.mermaid_source.is_empty() {
          *ctx.partial = true;
          *ctx.missing_native_sources += 1;
        } else {
          let fence = safe_fence(&block.mermaid_source);
          ctx.lines.push(format!("{prefix}{fence}mermaid"));
          for line in block.mermaid_source.split('\n') {
            ctx.lines.push(format!("{prefix}{line}"));
          }
          ctx.lines.push(format!("{prefix}{fence}"));
          ctx.lines.push(String::new());
        }
        if !block.diagram_title.is_empty() || !block.mermaid_caption.is_empty() {
          *ctx.partial = true;
          *ctx.omitted_native_metadata += 1;
        }
      }
      "myoxus:divider" => {
        ctx.lines.push(format!("{prefix}---"));
        ctx.lines.push(String::new());
      }
      // A document export has no independent Task grant. Never trust cached titles.
      "myoxus:database" if block.database_row_reference => {
        ctx.lines.push(format!("{prefix}Target unavailable"));
        ctx.lines.push(String::new());
        return;
      }
      "myoxus:table" | "myoxus:database" => {
        if !block.table_rows.is_empty() {
          if block.table_header_rows == Some(1) {
            push_markdown_table(ctx.lines, &block.table_rows, &block.table_alignments, prefix);
          } else {
            push_html_table(
              ctx.lines,
              &block.table_rows,
              &block.table_alignments,
              block.table_header_rows.unwrap_or(0),
              prefix,
            );
          }
        } else if !block.text_content.is_empty() {
          ctx.lines.push(format!("{prefix}{}", block.text_content));
          ctx.lines.push(String::new());
        } else if !block.children_ids.is_empty() {
          // Legacy/fixture fallback: older tests may model tables as
          // table -> row -> cell blocks. Active Virgultum tables are flat-data
          // blocks and should be handled by `block.table_rows` above.
          let mut table_rows: Vec<Vec<String>> = Vec::new();
          for row_id in &block.children_ids {
            if let Some(row_block) = ctx.block_data.get(row_id.as_str()) {
              if row_block.children_ids.is_empty() {
                // Row has no cell children — use its own text
                if !row_block.text_content.is_empty() {
                  table_rows.push(vec![row_block.text_content.clone()]);
                }
              } else {
                let mut cells: Vec<String> = Vec::new();
                for cell_id in &row_block.children_ids {
                  if let Some(cell_block) = ctx.block_data.get(cell_id.as_str()) {
                    cells.push(
                      if cell_block.text_content.is_empty() && block.table_header_rows == Some(1) {
                        " ".to_string()
                      } else {
                        cell_block.text_content.clone()
                      },
                    );
                  }
                }
                if !cells.is_empty() {
                  table_rows.push(cells);
                }
              }
            }
          }
          if table_rows.is_empty() {
            ctx.lines.push("<!-- table not exportable -->".to_string());
            ctx.lines.push(String::new());
            *ctx.partial = true;
          } else {
            // Rows/cells have been consumed as table data. Do not render the
            // same rich content again as ordinary Markdown children.
            if resolve_flavour(&block.flavour) == "myoxus:table" {
              for row_id in &block.children_ids {
                if ctx.visited.insert(row_id.clone()) {
                  *ctx.blocks_visited += 1;
                } else {
                  *ctx.partial = true;
                }
                if let Some(row) = ctx.block_data.get(row_id) {
                  for cell_id in &row.children_ids {
                    if ctx.visited.insert(cell_id.clone()) {
                      *ctx.blocks_visited += 1;
                    } else {
                      *ctx.partial = true;
                    }
                    if ctx
                      .block_data
                      .get(cell_id)
                      .is_some_and(|cell| !cell.children_ids.is_empty())
                    {
                      *ctx.partial = true;
                      *ctx.unsupported_native_content += 1;
                    }
                  }
                }
              }
              if block.table_header_rows != Some(1) {
                push_html_table(
                  ctx.lines,
                  &table_rows,
                  &[],
                  block.table_header_rows.unwrap_or(0),
                  prefix,
                );
              } else {
                push_markdown_table(ctx.lines, &table_rows, &[], prefix);
              }
              return;
            }
            push_markdown_table(ctx.lines, &table_rows, &[], prefix);
          }
        } else {
          ctx.lines.push("<!-- table not exportable -->".to_string());
          ctx.lines.push(String::new());
          *ctx.partial = true;
        }
      }
      "myoxus:embed-youtube" => {
        // P49-B-10: YouTube embed export — render as markdown link
        if !block.url.is_empty() {
          ctx.lines.push(format!("{prefix}[YouTube]({})", block.url));
          ctx.lines.push(String::new());
        }
      }
      "myoxus:surface" | "myoxus:note" => {
        // structural blocks — skip content, descend into children
      }
      _ => {
        // Unknown flavour — skip but mark partial
        *ctx.partial = true;
        *ctx.unsupported_native_content += 1;
      }
    }

    // Recurse into children
    let child_prefix = match resolve_flavour(block.flavour.as_str()) {
      "myoxus:list" => {
        let marker = match block.list_type.as_str() {
          "todo" if block.checked.unwrap_or(false) => "- [x]".to_string(),
          "todo" => "- [ ]".to_string(),
          "numbered" => format!("{}.", block.order.unwrap_or(1)),
          _ => "-".to_string(),
        };
        let content_indent = if block.list_type == "numbered" {
          marker.chars().count() + 1
        } else {
          2
        };
        format!("{prefix}{}", " ".repeat(content_indent))
      }
      "myoxus:paragraph" if block.list_type == "quote" => format!("{prefix}> "),
      "myoxus:callout" => format!("{prefix}> "),
      _ => prefix.to_string(),
    };
    let container_children_start = ctx.lines.len();
    let mut ordered_children = block.children_ids.iter().collect::<Vec<_>>();
    if resolve_flavour(&block.flavour) == "myoxus:note" {
      ordered_children.sort_by_key(|id| {
        ctx
          .block_data
          .get(*id)
          .is_some_and(|child| resolve_flavour(&child.flavour) == "myoxus:footnote-definition")
      });
    }
    for (index, child_id) in ordered_children.into_iter().enumerate() {
      if resolve_flavour(&block.flavour) == "myoxus:callout"
        && ctx.block_data.get(child_id).is_some_and(|child| {
          !matches!(
            resolve_flavour(&child.flavour),
            "myoxus:paragraph" | "myoxus:list" | "myoxus:callout" | "myoxus:code" | "myoxus:annotation"
          )
        })
      {
        *ctx.partial = true;
        *ctx.unsupported_native_content += 1;
      }
      render_block(child_id, depth + 1, &child_prefix, ctx);
      let child_is_list = ctx
        .block_data
        .get(child_id)
        .is_some_and(|child| resolve_flavour(child.flavour.as_str()) == "myoxus:list");
      let next_is_list = block
        .children_ids
        .get(index + 1)
        .and_then(|next_id| ctx.block_data.get(next_id))
        .is_some_and(|child| resolve_flavour(child.flavour.as_str()) == "myoxus:list");
      if child_is_list
        && index + 1 < block.children_ids.len()
        && !next_is_list
        && ctx.lines.last().is_some_and(|line| !line.is_empty())
      {
        ctx.lines.push(String::new());
      }
    }
    if resolve_flavour(&block.flavour) == "myoxus:callout"
      || (resolve_flavour(&block.flavour) == "myoxus:paragraph" && block.list_type == "quote")
    {
      // Blank child separators must stay inside the enclosing quote; an
      // unprefixed blank line otherwise splits its remaining children.
      for line in &mut ctx.lines[container_children_start..] {
        if line.is_empty() {
          *line = format!("{prefix}>");
        }
      }
      if resolve_flavour(&block.flavour) == "myoxus:callout" || !block.children_ids.is_empty() {
        ctx.lines.push(String::new());
      }
    }
  }

  let mut visited = std::collections::HashSet::new();
  let mut local_citations = Vec::new();
  let mut render_ctx = RenderContext {
    block_data: &block_data,
    lines: &mut lines,
    title: &mut title,
    blocks_visited: &mut blocks_visited,
    partial: &mut partial,
    visited: &mut visited,
    image_allowed,
    resolve_image,
    omitted_native_metadata: &mut omitted_native_metadata,
    missing_native_sources: &mut missing_native_sources,
    unsupported_native_content: &mut unsupported_native_content,
    missing_child_blocks: &mut missing_child_blocks,
    local_citations: &mut local_citations,
  };
  if let Some(root) = root_id {
    render_block(&root, 0, "", &mut render_ctx);
  } else {
    // YJS-RV-03c – Fallback block ordering.
    //
    // This branch is taken when no `affine:page` root block was found in
    // the document (e.g. partially synced docs, non-standard Virgultum
    // schemas, or manually crafted Yjs snapshots).
    //
    // Ordering guarantee: blocks are rendered in **lexicographic order of
    // their block IDs** (the string keys in the `blocks` YMap). This is
    // deterministic across runs — identical document state always produces
    // identical Markdown output — but the order is *not* semantically
    // meaningful because block IDs are opaque identifiers, not positional.
    //
    // The `partial` flag is set after this loop so callers know the output
    // came from the best-effort fallback path.
    let mut sorted_ids: Vec<&String> = block_data.keys().collect();
    sorted_ids.sort();
    for id in sorted_ids {
      render_block(id, 0, "", &mut render_ctx);
    }
    *render_ctx.partial = true;
  }

  let citations = citation_definitions.values().cloned().chain(local_citations).collect();
  for (_, (label, mut reference)) in citation_definitions {
    // Match the deployed client writer's encodeURIComponent escaping exactly.
    for key in ["url", "favicon"] {
      if let Some(source) = reference[key].as_str() {
        let mut encoded = String::new();
        for byte in source.bytes() {
          if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
          } else {
            use std::fmt::Write;
            write!(&mut encoded, "%{byte:02X}").expect("writing to a string cannot fail");
          }
        }
        reference[key] = encoded.into();
      }
    }
    let body = serde_json::to_string(&reference).map_err(|_| format!("Invalid citation definition: {label}"))?;
    lines.push(format!("[^{}]: {body}", escape_markdown_label(&label)));
    lines.push(String::new());
  }
  // Remove trailing empty lines
  while lines.last().map(|l: &String| l.is_empty()).unwrap_or(false) {
    lines.pop();
  }

  let markdown = lines.join("\n");
  if block_data
    .values()
    .any(|block| resolve_flavour(&block.flavour) == "myoxus:callout")
  {
    // Reuse import's admission policy for the emitted syntax, including
    // unsupported descendants inside lists; do not maintain a second subset.
    let (_, unsupported) = super::markdown_callout_support(&markdown);
    callout_diagnostics.extend((0..unsupported).map(|_| MarkdownDiagnostic {
      code: MarkdownDiagnosticCode::UnsupportedCallout,
    }));
  }
  debug!(
    blocks_visited,
    partial,
    markdown_len = markdown.len(),
    "yjs text extraction complete"
  );

  Ok(YjsExtractResult {
    citations,
    title,
    markdown,
    blocks_visited,
    extraction_partial: partial
      || unresolved_references > 0
      || omitted_native_metadata > 0
      || missing_native_sources > 0
      || unsupported_native_content > 0
      || missing_child_blocks > 0
      || !callout_diagnostics.is_empty()
      || annotation_diagnostics.iter().any(|finding| {
        matches!(
          finding.code,
          MarkdownDiagnosticCode::UnsupportedAnnotation | MarkdownDiagnosticCode::UnsupportedMath
        )
      }),
    diagnostics: (0..unresolved_references)
      .map(|_| MarkdownDiagnostic {
        code: MarkdownDiagnosticCode::UnresolvedDocumentReference,
      })
      .chain((0..omitted_native_metadata).map(|_| MarkdownDiagnostic {
        code: MarkdownDiagnosticCode::OmittedNativeMetadata,
      }))
      .chain((0..missing_native_sources).map(|_| MarkdownDiagnostic {
        code: MarkdownDiagnosticCode::MissingNativeSource,
      }))
      .chain((0..unsupported_native_content).map(|_| MarkdownDiagnostic {
        code: MarkdownDiagnosticCode::UnsupportedNativeContent,
      }))
      .chain((0..missing_child_blocks).map(|_| MarkdownDiagnostic {
        code: MarkdownDiagnosticCode::MissingChildBlock,
      }))
      .chain((0..normalized_highlights).map(|_| MarkdownDiagnostic {
        code: MarkdownDiagnosticCode::NormalizedHighlight,
      }))
      .chain((0..unreferenced_definitions).map(|_| MarkdownDiagnostic {
        code: MarkdownDiagnosticCode::UnreferencedFootnote,
      }))
      .chain((0..normalized_endnotes).map(|_| MarkdownDiagnostic {
        code: MarkdownDiagnosticCode::NormalizedEndnote,
      }))
      .chain(annotation_diagnostics)
      .chain(callout_diagnostics)
      .collect(),
  })
}

#[derive(Debug, Default)]
struct BlockInfo {
  database_row_reference: bool,
  footnote_label: Option<String>,
  citation: bool,
  citation_definition: Option<(String, serde_json::Value)>,
  embed_source: Option<String>,
  callout_title: Option<String>,
  callout_foldable: bool,
  callout_default_open: bool,
  flavour: String,
  text_content: String,
  children_ids: Vec<String>,
  language: String,
  list_type: String,
  /// For bookmark blocks: the URL
  url: String,
  /// For bookmark blocks: the bookmark title
  bookmark_title: String,
  /// For image blocks: sourceId or url
  image_source: String,
  /// For image blocks: caption
  image_caption: String,
  /// For latex blocks: the formula
  latex: String,
  /// Native Mermaid source, stored as rich text by the editor.
  mermaid_source: String,
  /// Authored diagram title; BPMN uses only this safe text, never XML or SVG.
  diagram_title: String,
  mermaid_caption: String,
  /// For list blocks: whether the task is checked (None = not a task)
  checked: Option<bool>,
  /// Explicit ordinal for numbered list items.
  order: Option<u32>,
  /// Active Virgultum flat-data table rows, already sorted by row/column order.
  table_rows: Vec<Vec<String>>,
  /// Optional per-column GFM alignment in the same sorted column order.
  table_alignments: Vec<Option<String>>,
  /// Absence designates no Markdown header; HTML/PDF legacy fallback is separate.
  table_header_rows: Option<usize>,
}
