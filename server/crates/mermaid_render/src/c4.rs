// SPDX-License-Identifier: AGPL-3.0-or-later

use merman::render::{HeadlessRenderer, foreign_object_label_fallback_svg_text, layout_parsed};
use serde_json::Value;

use crate::MermaidRenderError;

fn header_end(source: &str) -> Option<usize> {
  let mut end = 0;
  let mut frontmatter = false;
  let mut directive = false;
  for (index, raw) in source.split_inclusive('\n').enumerate() {
    end += raw.len();
    let line = raw.trim();
    if line == "---" && (index == 0 || frontmatter) {
      frontmatter = !frontmatter;
      continue;
    }
    if frontmatter || line.is_empty() {
      continue;
    }
    if directive {
      if line.contains("}%%") {
        directive = false;
      }
      continue;
    }
    if line.starts_with("%%{") {
      directive = !line.contains("}%%");
      continue;
    }
    if line.starts_with("%%") {
      continue;
    }
    return matches!(
      line.split_whitespace().next(),
      Some("C4Context" | "C4Container" | "C4Component" | "C4Dynamic" | "C4Deployment")
    )
    .then_some(end);
  }
  None
}

pub(crate) fn is_c4(source: &str) -> bool {
  header_end(source).is_some()
}

/// Merman intentionally reproduces the native accTitle→title defect. Remove only
/// those metadata statements from this render input, then project their actual
/// fields through the public parsed model. Persisted Source is never modified.
fn metadata_projection(source: &str) -> Result<(String, Option<String>, Option<String>), MermaidRenderError> {
  let header_end = header_end(source).ok_or(MermaidRenderError::Unsupported)?;
  let mut offset = 0;
  let mut projected = String::with_capacity(source.len());
  let mut title = None;
  let mut acc_title = None;
  let mut quoted = false;
  let mut parentheses = 0usize;
  let mut description = false;
  let mut pending_metadata = None;
  for raw in source.split_inclusive('\n') {
    offset += raw.len();
    let line = raw.trim();
    if offset <= header_end {
      projected.push_str(raw);
      continue;
    }
    if description {
      projected.push_str(raw);
      if line.contains('}') {
        description = false;
      }
      continue;
    }
    if !quoted && parentheses == 0 {
      if let Some(is_title) = pending_metadata {
        if !line.is_empty() {
          if is_title {
            title = Some(line.to_owned());
          } else {
            acc_title = Some(line.to_owned());
          }
          pending_metadata = None;
        }
        projected.push('\n');
        continue;
      }
      if let Some(rest) = line
        .strip_prefix("title")
        .filter(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace))
      {
        if rest.trim().is_empty() {
          pending_metadata = Some(true);
        } else {
          title = Some(rest.trim().to_owned());
        }
        projected.push('\n');
        continue;
      }
      if let Some(value) = line
        .strip_prefix("accTitle")
        .and_then(|rest| rest.trim_start().strip_prefix(':'))
      {
        if value.trim().is_empty() {
          pending_metadata = Some(false);
        } else {
          acc_title = Some(value.trim().to_owned());
        }
        projected.push('\n');
        continue;
      }
      if line
        .strip_prefix("accDescr")
        .is_some_and(|rest| rest.trim_start().starts_with('{'))
      {
        description = !line.contains('}');
        projected.push_str(raw);
        continue;
      }
      if line.starts_with("%%") {
        projected.push_str(raw);
        continue;
      }
    }
    // Metadata-looking text inside quoted content belongs to that content.
    let mut characters = raw.chars().peekable();
    while let Some(character) = characters.next() {
      if !quoted && character == '%' && characters.peek() == Some(&'%') {
        break;
      }
      if character == '"' {
        quoted = !quoted;
      } else if !quoted && character == '(' {
        parentheses += 1;
      } else if !quoted && character == ')' {
        parentheses = parentheses.saturating_sub(1);
      }
    }
    projected.push_str(raw);
  }
  if pending_metadata.is_some() {
    return Err(MermaidRenderError::Renderer("C4 metadata requires a value".to_owned()));
  }
  Ok((projected, title, acc_title))
}

pub(crate) fn render(source: &str, renderer: &HeadlessRenderer) -> Result<String, MermaidRenderError> {
  let (render_source, title, acc_title) = metadata_projection(source)?;
  let mut parsed = renderer
    .parse_diagram_sync(&render_source)
    .map_err(|error| MermaidRenderError::Renderer(error.to_string()))?
    .ok_or(MermaidRenderError::Unsupported)?;
  let title = title
    .filter(|value| !value.is_empty())
    .or_else(|| parsed.meta.title.clone());
  parsed.model["title"] = title.map_or(Value::Null, Value::String);
  parsed.model["accTitle"] = acc_title
    .filter(|value| !value.is_empty())
    .map_or(Value::Null, Value::String);
  let layout =
    layout_parsed(&parsed, &renderer.layout).map_err(|error| MermaidRenderError::Renderer(error.to_string()))?;
  let svg = renderer
    .render_layouted_svg_sync(&layout)
    .map_err(|error| MermaidRenderError::Renderer(error.to_string()))?;
  Ok(foreign_object_label_fallback_svg_text(&svg))
}
