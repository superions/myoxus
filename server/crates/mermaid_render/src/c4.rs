// SPDX-License-Identifier: AGPL-3.0-or-later

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
/// `accTitle` statements from this render input so `title` stays distinct, then
/// inject the accessible `<title>` element into the rendered SVG root.
/// Persisted Source is never modified.
pub(crate) fn strip_acc_title(source: &str) -> Result<(String, Option<String>), MermaidRenderError> {
  let header_end = header_end(source).ok_or(MermaidRenderError::Unsupported)?;
  let mut offset = 0;
  let mut projected = String::with_capacity(source.len());
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
            projected.push_str("title ");
            projected.push_str(line);
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
          projected.push('\n');
        } else {
          projected.push_str(raw);
        }
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
  Ok((projected, acc_title))
}

fn escape_xml(input: &str) -> String {
  let mut escaped = String::with_capacity(input.len());
  for ch in input.chars() {
    match ch {
      '&' => escaped.push_str("&amp;"),
      '<' => escaped.push_str("&lt;"),
      '>' => escaped.push_str("&gt;"),
      '"' => escaped.push_str("&quot;"),
      '\'' => escaped.push_str("&apos;"),
      other => escaped.push(other),
    }
  }
  escaped
}

fn extract_svg_id<'a>(open_tag: &'a str) -> Option<&'a str> {
  let bytes = open_tag.as_bytes();
  let mut idx = 0;
  while idx + 4 < bytes.len() {
    if bytes[idx].is_ascii_whitespace()
      && bytes[idx + 1] == b'i'
      && bytes[idx + 2] == b'd'
      && bytes[idx + 3] == b'='
      && bytes[idx + 4] == b'"'
    {
      let start = idx + 5;
      if let Some(rel_end) = open_tag[start..].find('"') {
        return Some(&open_tag[start..start + rel_end]);
      }
    }
    idx += 1;
  }
  None
}

pub(crate) fn inject_accessible_title(svg: String, fallback_id: &str, acc_title: &str) -> String {
  let acc_title = acc_title.trim();
  if acc_title.is_empty() {
    return svg;
  }
  let Some(svg_start) = svg.find("<svg") else {
    return svg;
  };
  let Some(rel_close) = svg[svg_start..].find('>') else {
    return svg;
  };
  let close_idx = svg_start + rel_close;
  let open_tag = &svg[svg_start..close_idx];
  let diagram_id = extract_svg_id(open_tag).unwrap_or(fallback_id);
  let title_id = format!("chart-title-{diagram_id}");
  let title_el = format!(
    r#"<title id="{}">{}</title>"#,
    escape_xml(&title_id),
    escape_xml(acc_title)
  );

  let mut out = String::with_capacity(svg.len() + title_el.len() + title_id.len() + 24);
  if open_tag.contains("aria-labelledby=") {
    out.push_str(&svg[..=close_idx]);
  } else {
    out.push_str(&svg[..close_idx]);
    out.push_str(r#" aria-labelledby=""#);
    out.push_str(&escape_xml(&title_id));
    out.push_str(r#"">"#);
  }
  out.push_str(&title_el);
  out.push_str(&svg[close_idx + 1..]);
  out
}
