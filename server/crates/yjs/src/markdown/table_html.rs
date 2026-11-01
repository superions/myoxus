// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded semantic HTML tables carried by Markdown, not general HTML import.

use super::{MarkdownDiagnostic, MarkdownDiagnosticCode, MarkdownLinkResolution, MarkdownLinkTarget};
use crate::YjsTextSegment;
use scraper::{ElementRef, Html, Node};

// Matches the default document export envelope; callers retain their own limits.
const MAX_TABLE_HTML_BYTES: usize = 8 * 1024 * 1024;
const INVALID: &str = "unsupported raw HTML in Markdown";

pub(super) struct HtmlTable {
  pub rows: Vec<Vec<Vec<YjsTextSegment>>>,
  pub alignments: Vec<Option<String>>,
  pub header_rows: usize,
  pub diagnostics: Vec<MarkdownDiagnostic>,
}

pub(super) fn escape(value: &str) -> String {
  value
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
    .replace('\'', "&#39;")
}

pub(super) fn safe_link(value: &str) -> bool {
  let value = value.trim();
  if value.is_empty() || value.chars().any(char::is_control) || value.contains('\\') {
    return false;
  }
  let first = value.split(['/', '?', '#']).next().unwrap_or_default();
  match first.split_once(':') {
    Some((scheme, _)) => matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https" | "mailto"),
    None => true,
  }
}

fn elements(element: ElementRef<'_>) -> Result<Vec<ElementRef<'_>>, String> {
  let mut result = Vec::new();
  for child in element.children() {
    if let Some(element) = ElementRef::wrap(child) {
      result.push(element);
    } else if !matches!(child.value(), Node::Text(text) if text.trim().is_empty()) {
      return Err(INVALID.into());
    }
  }
  Ok(result)
}

fn alignment(cell: ElementRef<'_>) -> Result<Option<String>, String> {
  let mut result = None;
  for (key, value) in cell.value().attrs() {
    if key != "style" {
      return Err(INVALID.into());
    }
    for declaration in value.split(';').filter(|value| !value.trim().is_empty()) {
      let Some((property, value)) = declaration.split_once(':') else {
        return Err(INVALID.into());
      };
      let value = value.trim().to_ascii_lowercase();
      if !property.trim().eq_ignore_ascii_case("text-align")
        || !matches!(value.as_str(), "left" | "center" | "right")
        || result.is_some()
      {
        return Err(INVALID.into());
      }
      result = Some(value);
    }
  }
  Ok(result)
}

fn inline(
  element: ElementRef<'_>,
  marks: &YjsTextSegment,
  depth: usize,
  output: &mut Vec<YjsTextSegment>,
) -> Result<(), String> {
  if depth > super::MAX_BLOCK_DEPTH {
    return Err(INVALID.into());
  }
  for child in element.children() {
    if let Node::Text(text) = child.value() {
      if !text.is_empty() {
        let mut segment = marks.clone();
        segment.text = text.to_string();
        output.push(segment);
      }
      continue;
    }
    let Some(child) = ElementRef::wrap(child) else {
      return Err(INVALID.into());
    };
    let mut marks = marks.clone();
    let tag = child.value().name();
    if tag != "a" && child.value().attrs().next().is_some() {
      return Err(INVALID.into());
    }
    match tag {
      "strong" | "b" => marks.bold = true,
      "em" | "i" => marks.italic = true,
      "del" | "s" => marks.strike = true,
      "code" => marks.code = true,
      "br" => {
        if child.children().next().is_some() {
          return Err(INVALID.into());
        }
        marks.text = "\n".into();
        output.push(marks);
        continue;
      }
      "a" => {
        if marks.link.is_some() || child.value().attrs().any(|(key, _)| key != "href") {
          return Err(INVALID.into());
        }
        let href = child.value().attr("href").ok_or(INVALID)?;
        if !safe_link(href) {
          return Err(INVALID.into());
        }
        marks.link = Some(href.to_string());
      }
      _ => return Err(INVALID.into()),
    }
    inline(child, &marks, depth + 1, output)?;
  }
  Ok(())
}

/// Validate the complete structure before creating any native table. HTML5
/// recovery must not hide an active sibling, nested table, span or style.
pub(super) fn decode(
  source: &str,
  resolve_link: &dyn Fn(MarkdownLinkTarget<'_>) -> MarkdownLinkResolution,
) -> Result<HtmlTable, String> {
  if source.len() > MAX_TABLE_HTML_BYTES {
    return Err(INVALID.into());
  }
  let trimmed = source.trim().to_ascii_lowercase();
  if !trimmed.starts_with("<table") || !trimmed.ends_with("</table>") {
    return Err(INVALID.into());
  }
  let parsed = Html::parse_fragment(source);
  if !parsed.errors.is_empty() {
    return Err(INVALID.into());
  }
  let roots = elements(parsed.root_element())?;
  if roots.len() != 1 || roots[0].value().name() != "table" || roots[0].value().attrs().next().is_some() {
    return Err(INVALID.into());
  }
  let sections = elements(roots[0])?;
  let has_head = sections.iter().any(|section| section.value().name() == "thead");
  let mut raw_rows = Vec::new();
  let mut header_rows = 0;
  let mut body_seen = false;
  for section in sections {
    if section.value().attrs().next().is_some() {
      return Err(INVALID.into());
    }
    let tag = section.value().name();
    match tag {
      "thead" => {
        if body_seen {
          return Err(INVALID.into());
        }
        let rows = elements(section)?;
        header_rows += rows.len();
        raw_rows.extend(rows);
      }
      "tbody" => {
        body_seen = true;
        raw_rows.extend(elements(section)?);
      }
      "tr" => {
        body_seen = true;
        raw_rows.push(section);
      }
      _ => return Err(INVALID.into()),
    }
  }
  if raw_rows.is_empty() {
    return Err(INVALID.into());
  }
  let mut rows = Vec::new();
  let mut alignments = Vec::new();
  let mut body_cells_seen = false;
  for row in raw_rows {
    if row.value().name() != "tr" || row.value().attrs().next().is_some() {
      return Err(INVALID.into());
    }
    let cells = elements(row)?;
    if cells.is_empty() {
      return Err(INVALID.into());
    }
    let all_headers = cells.iter().all(|cell| cell.value().name() == "th");
    if !has_head && !body_cells_seen && all_headers {
      header_rows += 1;
    } else if !all_headers {
      body_cells_seen = true;
    }
    if rows.is_empty() {
      alignments.resize(cells.len(), None);
    }
    if cells.len() != alignments.len() {
      return Err(INVALID.into());
    }
    let mut values = Vec::new();
    for (column, cell) in cells.into_iter().enumerate() {
      if !matches!(cell.value().name(), "td" | "th") {
        return Err(INVALID.into());
      }
      if let Some(value) = alignment(cell)? {
        if alignments[column].as_ref().is_some_and(|previous| previous != &value) {
          return Err(INVALID.into());
        }
        alignments[column] = Some(value);
      }
      let mut segments = Vec::new();
      inline(cell, &YjsTextSegment::default(), 0, &mut segments)?;
      values.push(segments);
    }
    rows.push(values);
  }
  // Use the caller's existing authorization/normalization result only after
  // the entire table was admitted; no HTML-specific reference authority exists.
  let mut diagnostics = Vec::new();
  for segment in rows.iter_mut().flatten().flatten() {
    if let Some(href) = segment.link.clone() {
      match resolve_link(MarkdownLinkTarget::Url(&href)) {
        MarkdownLinkResolution::Reference(reference) => {
          segment.link = None;
          segment.reference = Some(reference);
        }
        MarkdownLinkResolution::Ordinary => {}
        MarkdownLinkResolution::Unresolved => diagnostics.push(MarkdownDiagnostic {
          code: MarkdownDiagnosticCode::UnresolvedDocumentReference,
        }),
        MarkdownLinkResolution::Unsupported => diagnostics.push(MarkdownDiagnostic {
          code: MarkdownDiagnosticCode::UnsupportedDocumentReference,
        }),
      }
    }
  }
  Ok(HtmlTable {
    rows,
    alignments,
    header_rows,
    diagnostics,
  })
}
