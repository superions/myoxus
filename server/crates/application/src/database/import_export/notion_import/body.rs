// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded Notion Page-body extraction and Yjs projection.
//!
//! Database/property parsing intentionally remains in the existing streaming
//! parser. This private adapter owns only the matched Page subtree required by
//! P-DB-38C, so Notion HTML does not become a second application-wide import
//! representation.

use std::collections::{BTreeMap, BTreeSet};

use scraper::{ElementRef, Html, Selector};
use yjs::{YjsDocumentBuilder, YjsTextSegment};

use super::{
  NotionDiagnostic, NotionDiagnosticCode, NotionDiagnosticSeverity, NotionPageBody, parser::derive_page_id_from_path,
};
use crate::database::import_export::content::{snapshot_asset_uri, snapshot_document_uri};

#[derive(Debug)]
pub(super) struct PageBodyConversion {
  pub update: Vec<u8>,
  pub block_count: usize,
  pub rewritten_internal_links: usize,
  pub asset_keys: Vec<String>,
  pub diagnostics: Vec<NotionDiagnostic>,
}

pub(super) struct PageBodyContext<'a> {
  pub document_keys_by_page_id: &'a BTreeMap<String, String>,
  pub assets: &'a BTreeMap<String, Vec<u8>>,
}

pub(super) fn extract_page_title(html: &str) -> Option<String> {
  let document = Html::parse_document(html);
  let selector = Selector::parse("title").expect("static title selector");
  document
    .select(&selector)
    .next()
    .map(|title| title.text().collect::<String>().trim().to_string())
    .filter(|title| !title.is_empty())
}

/// Retain only the editable Page subtree needed after Row/Page association.
///
/// Notion's database table and page-property header are source metadata already
/// handled by the streaming parser. Removing them here prevents duplicated
/// table chrome from becoming editable document content.
pub(super) fn extract_page_body(entry_path: &str, html: &str) -> NotionPageBody {
  let mut document = Html::parse_document(html);
  let database_selector = Selector::parse("table.collection-content").expect("static Database selector");
  let inline_database_count = document.select(&database_selector).count();
  let remove = Selector::parse(
    "script, style, table.collection-content, .page-properties, .properties, .collection-header, .page-header-icon, .page-cover, h1.page-title",
  )
  .expect("static Notion chrome selector");
  let node_ids = document.select(&remove).map(|element| element.id()).collect::<Vec<_>>();
  for node_id in node_ids {
    if let Some(mut node) = document.tree.get_mut(node_id) {
      node.detach();
    }
  }
  let body_selector = Selector::parse("body").expect("static body selector");
  let mut html_fragment = document
    .select(&body_selector)
    .next()
    .map(|body| body.inner_html())
    .unwrap_or_default();
  for _ in 0..inline_database_count {
    html_fragment.push_str("<div data-myoxus-notion-unsupported=\"inline-database\">Inline Database omitted</div>");
  }
  NotionPageBody {
    entry_path: entry_path.to_string(),
    html_fragment,
  }
}

/// Convert a bounded Page fragment directly into canonical editor blocks.
///
/// The converter is intentionally private to the Notion adapter. It does not
/// expose HTML as a general server import format and never projects through
/// Markdown or plaintext.
pub(super) fn convert_page_body(
  title: &str,
  body: &NotionPageBody,
  context: PageBodyContext<'_>,
) -> PageBodyConversion {
  let fragment = Html::parse_fragment(&body.html_fragment);
  let mut state = ConversionState {
    builder: YjsDocumentBuilder::new(title),
    context,
    entry_path: body.entry_path.clone(),
    rewritten_internal_links: 0,
    asset_keys: BTreeSet::new(),
    diagnostics: Vec::new(),
  };
  let root = fragment.root_element();
  emit_container(root, &mut state);
  let block_count = state.builder.block_count();
  PageBodyConversion {
    update: state.builder.encode(),
    block_count,
    rewritten_internal_links: state.rewritten_internal_links,
    asset_keys: state.asset_keys.into_iter().collect(),
    diagnostics: state.diagnostics,
  }
}

struct ConversionState<'a> {
  builder: YjsDocumentBuilder,
  context: PageBodyContext<'a>,
  entry_path: String,
  rewritten_internal_links: usize,
  asset_keys: BTreeSet<String>,
  diagnostics: Vec<NotionDiagnostic>,
}

#[derive(Clone, Default)]
struct InlineStyle {
  bold: bool,
  italic: bool,
  strike: bool,
  code: bool,
  link: Option<String>,
}

fn emit_container(container: ElementRef<'_>, state: &mut ConversionState<'_>) {
  for child in container.children() {
    let Some(element) = ElementRef::wrap(child) else {
      if let Some(text) = child.value().as_text() {
        let text = normalized_text(text);
        if !text.is_empty() {
          state.builder.push_paragraph(&[YjsTextSegment::plain(text)]);
        }
      }
      continue;
    };
    emit_block(element, state, 0);
  }
}

fn emit_block(element: ElementRef<'_>, state: &mut ConversionState<'_>, list_depth: usize) {
  let tag = element.value().name();
  if element.attr("data-myoxus-notion-unsupported") == Some("inline-database") {
    state.diagnostics.push(NotionDiagnostic::new(
      NotionDiagnosticCode::DroppedInlineDatabase,
      NotionDiagnosticSeverity::Warning,
      format!("$.pageBody[{}]", state.entry_path),
      "Inline Notion Database content is outside the bounded Page-body import",
    ));
    state
      .builder
      .push_paragraph(&[YjsTextSegment::plain("Inline Database omitted")]);
    return;
  }
  if has_class(element, "synced-block") {
    state.diagnostics.push(NotionDiagnostic::new(
      NotionDiagnosticCode::DroppedSyncedBlock,
      NotionDiagnosticSeverity::Warning,
      format!("$.pageBody[{}]", state.entry_path),
      "Synced-block source data was unavailable; visible fallback text was preserved",
    ));
  }
  match tag {
    "p" => push_text_block(element, state, TextBlockKind::Paragraph),
    "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
      let level = tag.trim_start_matches('h').parse::<u8>().unwrap_or(1);
      push_text_block(element, state, TextBlockKind::Heading(level));
    }
    "blockquote" => push_text_block(element, state, TextBlockKind::Quote),
    "ul" => emit_list(element, state, false, list_depth),
    "ol" => emit_list(element, state, true, list_depth),
    "pre" => {
      let code = element
        .select(&Selector::parse("code").expect("static code selector"))
        .next();
      let source = code.unwrap_or(element);
      let language = source
        .attr("class")
        .and_then(|class| class.split_whitespace().find_map(|part| part.strip_prefix("language-")))
        .unwrap_or_default();
      state.builder.push_code(language, &source.text().collect::<String>());
    }
    "hr" => state.builder.push_divider(),
    "table" => emit_table(element, state),
    "img" => emit_image(element, state),
    "figure" => emit_figure(element, state),
    "a" => emit_standalone_link(element, state),
    "iframe" | "object" | "embed" => unsupported_placeholder(element, state),
    "div" | "section" | "main" | "article" | "body" | "html" => {
      if has_class(element, "callout") {
        push_text_block(element, state, TextBlockKind::Quote);
      } else {
        emit_container(element, state);
      }
    }
    "script" | "style" | "head" => {}
    _ => {
      if is_inline_tag(tag) {
        push_text_block(element, state, TextBlockKind::Paragraph);
      } else {
        emit_container(element, state);
      }
    }
  }
}

enum TextBlockKind {
  Paragraph,
  Heading(u8),
  Quote,
}

fn push_text_block(element: ElementRef<'_>, state: &mut ConversionState<'_>, kind: TextBlockKind) {
  let segments = collect_inline(element, InlineStyle::default(), state);
  if segments.iter().all(|segment| segment.text.trim().is_empty()) {
    return;
  }
  match kind {
    TextBlockKind::Paragraph => state.builder.push_paragraph(&segments),
    TextBlockKind::Heading(level) => state.builder.push_heading(level, &segments),
    TextBlockKind::Quote => state.builder.push_quote(&segments),
  }
}

fn collect_inline(
  element: ElementRef<'_>,
  inherited: InlineStyle,
  state: &mut ConversionState<'_>,
) -> Vec<YjsTextSegment> {
  let mut output = Vec::new();
  for child in element.children() {
    if let Some(text) = child.value().as_text() {
      let text = normalized_text(text);
      if !text.is_empty() {
        output.push(segment(text, &inherited));
      }
      continue;
    }
    let Some(child_element) = ElementRef::wrap(child) else {
      continue;
    };
    let tag = child_element.value().name();
    if matches!(tag, "ul" | "ol" | "table" | "figure") {
      continue;
    }
    if tag == "br" {
      output.push(segment("\n".to_string(), &inherited));
      continue;
    }
    if tag == "img" {
      let alt = child_element.attr("alt").unwrap_or("image").trim();
      output.push(segment(alt.to_string(), &inherited));
      continue;
    }
    let mut style = inherited.clone();
    match tag {
      "strong" | "b" => style.bold = true,
      "em" | "i" => style.italic = true,
      "s" | "del" | "strike" => style.strike = true,
      "code" => style.code = true,
      "a" => style.link = child_element.attr("href").and_then(|href| resolve_link(href, state)),
      _ => {}
    }
    output.extend(collect_inline(child_element, style, state));
  }
  coalesce_segments(output)
}

fn emit_list(element: ElementRef<'_>, state: &mut ConversionState<'_>, ordered: bool, depth: usize) {
  for child in element.children().filter_map(ElementRef::wrap) {
    if child.value().name() != "li" {
      continue;
    }
    let checked = todo_state(child);
    let segments = collect_inline(child, InlineStyle::default(), state);
    if segments.iter().any(|segment| !segment.text.trim().is_empty()) {
      state.builder.push_list_item(&segments, ordered, depth, checked);
    }
    for nested in child.children().filter_map(ElementRef::wrap) {
      match nested.value().name() {
        "ul" => emit_list(nested, state, false, depth + 1),
        "ol" => emit_list(nested, state, true, depth + 1),
        _ => {}
      }
    }
  }
}

fn todo_state(element: ElementRef<'_>) -> Option<bool> {
  let checkbox = Selector::parse("input[type=checkbox]").expect("static checkbox selector");
  element
    .select(&checkbox)
    .next()
    .map(|input| input.attr("checked").is_some() || input.attr("data-checked") == Some("true"))
    .or_else(|| {
      has_class(element, "to-do").then(|| element.attr("data-checked") == Some("true") || has_class(element, "checked"))
    })
}

fn emit_table(element: ElementRef<'_>, state: &mut ConversionState<'_>) {
  let row_selector = Selector::parse("tr").expect("static row selector");
  let cell_selector = Selector::parse("th, td").expect("static cell selector");
  let rows = element
    .select(&row_selector)
    .map(|row| {
      row
        .select(&cell_selector)
        .map(|cell| collect_inline(cell, InlineStyle::default(), state))
        .collect::<Vec<_>>()
    })
    .filter(|row| !row.is_empty())
    .collect::<Vec<_>>();
  state.builder.push_table(&rows);
}

fn emit_figure(element: ElementRef<'_>, state: &mut ConversionState<'_>) {
  let image_selector = Selector::parse("img").expect("static image selector");
  if let Some(image) = element.select(&image_selector).next() {
    emit_image(image, state);
    return;
  }
  let link_selector = Selector::parse("a[href]").expect("static link selector");
  if let Some(link) = element.select(&link_selector).next() {
    emit_standalone_link(link, state);
    return;
  }
  push_text_block(element, state, TextBlockKind::Paragraph);
}

fn emit_image(element: ElementRef<'_>, state: &mut ConversionState<'_>) {
  let Some(source) = element.attr("src") else {
    unsupported_placeholder(element, state);
    return;
  };
  let caption = element.attr("alt").unwrap_or_default();
  match resolve_asset(source, state) {
    Some(asset_key) => state.builder.push_image(&snapshot_asset_uri(&asset_key), caption),
    None => missing_asset_placeholder(source, caption, state),
  }
}

fn emit_standalone_link(element: ElementRef<'_>, state: &mut ConversionState<'_>) {
  let Some(href) = element.attr("href") else {
    push_text_block(element, state, TextBlockKind::Paragraph);
    return;
  };
  let title = normalized_text(&element.text().collect::<String>());
  if let Some(asset_key) = resolve_asset(href, state) {
    let mime = mime_guess::from_path(&asset_key).first_or_octet_stream().to_string();
    let name = asset_key.rsplit('/').next().unwrap_or("attachment");
    let size = state.context.assets.get(&asset_key).map_or(0, |bytes| bytes.len()) as i64;
    state
      .builder
      .push_file(&snapshot_asset_uri(&asset_key), name, &mime, size);
  } else if is_external_link(href) {
    state.builder.push_bookmark(href, &title);
  } else {
    let segments = collect_inline(element, InlineStyle::default(), state);
    if !segments.is_empty() {
      state.builder.push_paragraph(&segments);
    }
  }
}

fn resolve_link(href: &str, state: &mut ConversionState<'_>) -> Option<String> {
  if is_external_link(href) || href.starts_with('#') {
    return Some(href.to_string());
  }
  let path = decoded_path(href)?;
  let lowered = path.to_ascii_lowercase();
  if lowered.ends_with(".html") || lowered.ends_with(".htm") {
    let page_id = derive_page_id_from_path(&path);
    if let Some(document_key) = state.context.document_keys_by_page_id.get(&page_id) {
      state.rewritten_internal_links += 1;
      return Some(snapshot_document_uri(document_key));
    }
    state.diagnostics.push(NotionDiagnostic::new(
      NotionDiagnosticCode::DroppedPageMention,
      NotionDiagnosticSeverity::Warning,
      format!("$.pageBody[{}].links", state.entry_path),
      format!("Internal Notion Page link '{href}' is not part of the import"),
    ));
    return None;
  }
  Some(href.to_string())
}

fn resolve_asset(source: &str, state: &mut ConversionState<'_>) -> Option<String> {
  if is_external_link(source) || source.starts_with("data:") || source.starts_with('#') {
    return None;
  }
  let source_path = decoded_path(source)?;
  let resolved = resolve_relative_path(&state.entry_path, &source_path);
  let key = if state.context.assets.contains_key(&resolved) {
    Some(resolved)
  } else {
    state
      .context
      .assets
      .keys()
      .find(|candidate| candidate.ends_with(&source_path))
      .cloned()
  }?;
  state.asset_keys.insert(key.clone());
  Some(key)
}

fn missing_asset_placeholder(source: &str, caption: &str, state: &mut ConversionState<'_>) {
  state.diagnostics.push(NotionDiagnostic::new(
    NotionDiagnosticCode::AssetMissing,
    NotionDiagnosticSeverity::Warning,
    format!("$.pageBody[{}].assets", state.entry_path),
    format!("Page-body asset '{source}' is not present in the Notion archive"),
  ));
  let label = if caption.trim().is_empty() { source } else { caption };
  state
    .builder
    .push_paragraph(&[YjsTextSegment::plain(format!("Missing attachment: {label}"))]);
}

fn unsupported_placeholder(element: ElementRef<'_>, state: &mut ConversionState<'_>) {
  let tag = element.value().name();
  state.diagnostics.push(NotionDiagnostic::new(
    NotionDiagnosticCode::PageBodyUnsupported,
    NotionDiagnosticSeverity::Warning,
    format!("$.pageBody[{}]", state.entry_path),
    format!("Unsupported Notion Page-body element <{tag}> was preserved as readable text"),
  ));
  let text = normalized_text(&element.text().collect::<String>());
  state
    .builder
    .push_paragraph(&[YjsTextSegment::plain(if text.is_empty() {
      format!("Unsupported embedded content: {tag}")
    } else {
      text
    })]);
}

fn segment(text: String, style: &InlineStyle) -> YjsTextSegment {
  let mut segment = YjsTextSegment::plain(text);
  segment.bold = style.bold;
  segment.italic = style.italic;
  segment.strike = style.strike;
  segment.code = style.code;
  segment.link = style.link.clone();
  segment
}

fn coalesce_segments(segments: Vec<YjsTextSegment>) -> Vec<YjsTextSegment> {
  let mut output: Vec<YjsTextSegment> = Vec::new();
  for segment in segments {
    if let Some(previous) = output.last_mut()
      && previous.bold == segment.bold
      && previous.italic == segment.italic
      && previous.strike == segment.strike
      && previous.code == segment.code
      && previous.link == segment.link
    {
      previous.text.push_str(&segment.text);
    } else {
      output.push(segment);
    }
  }
  output
}

fn normalized_text(text: &str) -> String {
  let leading = text.chars().next().is_some_and(char::is_whitespace);
  let trailing = text.chars().next_back().is_some_and(char::is_whitespace);
  let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
  if normalized.is_empty() {
    return if leading || trailing { " " } else { Default::default() }.to_string();
  }
  format!(
    "{}{}{}",
    if leading { " " } else { "" },
    normalized,
    if trailing { " " } else { "" }
  )
}

fn has_class(element: ElementRef<'_>, expected: &str) -> bool {
  element
    .attr("class")
    .is_some_and(|classes| classes.split_whitespace().any(|class| class == expected))
}

fn is_inline_tag(tag: &str) -> bool {
  matches!(
    tag,
    "span" | "strong" | "b" | "em" | "i" | "s" | "del" | "strike" | "code" | "mark" | "small"
  )
}

fn is_external_link(value: &str) -> bool {
  let lowered = value.to_ascii_lowercase();
  lowered.starts_with("http://") || lowered.starts_with("https://") || lowered.starts_with("mailto:")
}

fn decoded_path(value: &str) -> Option<String> {
  let path = value.split(['?', '#']).next().unwrap_or_default();
  urlencoding::decode(path).ok().map(|decoded| decoded.into_owned())
}

fn resolve_relative_path(entry_path: &str, relative: &str) -> String {
  let base = entry_path.rsplit_once('/').map_or("", |(directory, _)| directory);
  let joined = if relative.starts_with('/') || base.is_empty() {
    relative.trim_start_matches('/').to_string()
  } else {
    format!("{base}/{relative}")
  };
  let mut parts = Vec::new();
  for part in joined.split('/') {
    match part {
      "" | "." => {}
      ".." => {
        parts.pop();
      }
      value => parts.push(value),
    }
  }
  parts.join("/")
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_public_render::{Block, document_from_yjs};

  #[test]
  fn extraction_removes_database_chrome_and_executable_nodes() {
    let body = extract_page_body(
      "Tasks/task abcdef0123456789abcdef0123456789.html",
      r#"<!doctype html><html><head><title>Task</title><style>.x{}</style></head>
      <body><div class="page-properties">Status: Done</div><p>Editable <strong>body</strong></p>
      <table class="collection-content"><tr><td>duplicate row</td></tr></table><script>alert(1)</script></body></html>"#,
    );

    assert_eq!(body.entry_path, "Tasks/task abcdef0123456789abcdef0123456789.html");
    assert!(body.html_fragment.contains("Editable <strong>body</strong>"));
    assert!(!body.html_fragment.contains("Status: Done"));
    assert!(!body.html_fragment.contains("duplicate row"));
    assert!(!body.html_fragment.contains("alert(1)"));
  }

  #[test]
  fn converter_preserves_supported_blocks_links_nesting_and_assets() {
    let body = NotionPageBody {
      entry_path: "Pages/Task abcdef0123456789abcdef0123456789.html".to_string(),
      html_fragment: r#"
        <p>Plain <strong>bold</strong> <em>italic</em> <code>inline</code>
          <a href="Target 11111111111111111111111111111111.html">target</a>
          <a href="https://example.com">external</a></p>
        <h2>Heading</h2>
        <ul><li>Parent<ul><li>Child</li></ul></li><li class="to-do" data-checked="true">Done</li></ul>
        <blockquote>Quoted</blockquote><div class="callout">Called out</div>
        <pre><code class="language-rust">fn main() {}</code></pre><hr />
        <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
        <img src="../assets/image.png" alt="Diagram" />
        <a href="../assets/brief.pdf">Brief</a>
        <a href="https://example.org/resource">Resource</a>
        <iframe src="https://unsupported.example"></iframe>
      "#
      .to_string(),
    };
    let page_keys = BTreeMap::from([(
      "11111111111111111111111111111111".to_string(),
      "target-document".to_string(),
    )]);
    let assets = BTreeMap::from([
      ("assets/image.png".to_string(), vec![1, 2, 3]),
      ("assets/brief.pdf".to_string(), vec![4, 5]),
    ]);

    let converted = convert_page_body(
      "Task",
      &body,
      PageBodyContext {
        document_keys_by_page_id: &page_keys,
        assets: &assets,
      },
    );
    assert_eq!(converted.rewritten_internal_links, 1);
    assert_eq!(
      converted.asset_keys,
      vec!["assets/brief.pdf".to_string(), "assets/image.png".to_string()]
    );
    assert!(converted.block_count >= 12);
    assert!(
      converted
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == NotionDiagnosticCode::PageBodyUnsupported.as_str())
    );

    let projected = document_from_yjs(uuid::Uuid::nil(), uuid::Uuid::nil(), "Task", "test", &converted.update)
      .expect("generated update projects through the canonical public IR");
    assert!(
      projected
        .document
        .blocks
        .iter()
        .any(|block| matches!(block, Block::Heading { level: 2, .. }))
    );
    assert!(
      projected
        .document
        .blocks
        .iter()
        .any(|block| matches!(block, Block::List { .. }))
    );
    assert!(
      projected
        .document
        .blocks
        .iter()
        .any(|block| matches!(block, Block::Quote { .. }))
    );
    assert!(
      projected
        .document
        .blocks
        .iter()
        .any(|block| matches!(block, Block::Code { .. }))
    );
    assert!(
      projected
        .document
        .blocks
        .iter()
        .any(|block| matches!(block, Block::Divider { .. }))
    );
    assert!(
      projected
        .document
        .blocks
        .iter()
        .any(|block| matches!(block, Block::Table { .. }))
    );
    assert!(
      projected
        .document
        .blocks
        .iter()
        .any(|block| matches!(block, Block::Image { .. }))
    );
    assert!(
      projected
        .document
        .blocks
        .iter()
        .filter(|block| matches!(block, Block::BookmarkCard { .. }))
        .count()
        >= 2
    );
  }
}
