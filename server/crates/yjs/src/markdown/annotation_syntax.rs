// SPDX-License-Identifier: AGPL-3.0-or-later
//! Literal annotation spans protected by the existing CommonMark parser.

use pulldown_cmark::{Event, Options, Parser, Tag};
use std::ops::Range;

/// Server preparation owners use these native spans to keep literal bodies out
/// of asset/reference rewrites and unsupported-construct classification.
pub fn markdown_annotation_ranges(source: &str) -> Vec<Range<usize>> {
  let options =
    Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_MATH;
  prepare(source, options)
    .spans
    .into_iter()
    .map(|span| span.range)
    .collect()
}

pub(super) fn serialize_body(body: &str) -> Option<String> {
  // Escape every percent, including a single trailing percent which would
  // otherwise combine with the closing delimiter. Obsidian 1.13.7 desktop
  // recognizes the two independently escaped percents inside a comment.
  let source = format!("%%{}%%", body.replace('%', "\\%"));
  let options =
    Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_MATH;
  let prepared = prepare(&source, options);
  (prepared.spans.len() == 1 && prepared.spans[0].range == (0..source.len()) && prepared.spans[0].body == body)
    .then_some(source)
}

pub(super) struct AnnotationSpan {
  pub range: Range<usize>,
  pub body: String,
  pub standalone: bool,
}

pub(super) struct AnnotationSource {
  pub source: String,
  pub spans: Vec<AnnotationSpan>,
  pub unsupported: Vec<Range<usize>>,
}

impl AnnotationSource {
  pub fn contained(&self, range: &Range<usize>) -> impl Iterator<Item = &AnnotationSpan> {
    let start = self.spans.partition_point(|span| span.range.start < range.start);
    let end = self.spans.partition_point(|span| span.range.start < range.end);
    self.spans[start..end]
      .iter()
      .filter(move |span| span.range.end <= range.end)
  }

  pub fn at(&self, range: &Range<usize>) -> Option<&AnnotationSpan> {
    let index = self
      .spans
      .binary_search_by_key(&range.start, |span| span.range.start)
      .ok()?;
    self.spans.get(index).filter(|span| span.range.end == range.end)
  }
}

/// Keep byte offsets stable while making literal bodies opaque to Markdown.
/// Code/HTML boundaries come from the same parser used by the owning importer.
pub(super) fn prepare(source: &str, options: Options) -> AnnotationSource {
  let mut result = AnnotationSource {
    source: source.into(),
    spans: Vec::new(),
    unsupported: Vec::new(),
  };
  if !source.contains("%%") {
    return result;
  }
  let mut protected = Vec::new();
  let mut paragraphs = Vec::new();
  let mut tight_items = Vec::new();
  let mut html_code: Vec<(String, usize)> = Vec::new();
  // Math is opaque only before an annotation opens. A separate native-parser
  // range list keeps code inside literal annotation bodies protected as before.
  let math_ranges: Vec<_> = if options.contains(Options::ENABLE_MATH) && source.contains('$') {
    Parser::new_ext(source, options)
      .into_offset_iter()
      .filter_map(|(event, range)| matches!(event, Event::InlineMath(_) | Event::DisplayMath(_)).then_some(range))
      .collect()
  } else {
    Vec::new()
  };
  for (event, range) in Parser::new_ext(source, options & !Options::ENABLE_MATH).into_offset_iter() {
    if matches!(event, Event::Start(Tag::CodeBlock(_)) | Event::Code(_)) {
      protected.push((range, false));
    } else if matches!(event, Event::Html(_) | Event::InlineHtml(_)) {
      protected.push((range.clone(), true));
      if let Event::InlineHtml(tag) = event {
        // CommonMark already tokenized the tag. Only its native code/pre scope
        // matters here; ordinary tags inside an opened annotation remain literal.
        let closing = tag.starts_with("</");
        let value = tag.trim_start_matches('<').trim_start_matches('/');
        let name = value
          .split(|character: char| character.is_ascii_whitespace() || matches!(character, '>' | '/'))
          .next()
          .unwrap_or("")
          .to_ascii_lowercase();
        if matches!(name.as_str(), "code" | "pre") {
          if closing {
            if let Some(index) = html_code.iter().rposition(|(open, _)| open == &name) {
              protected.push((html_code[index].1..range.end, false));
              html_code.truncate(index);
            }
          } else {
            html_code.push((name, range.start));
          }
        }
      }
    } else if matches!(event, Event::Start(Tag::Paragraph)) {
      paragraphs.push(range);
    } else if matches!(event, Event::Start(Tag::Item)) {
      // Tight lists omit paragraph events. The parser-owned item still gives
      // its structural marker; it is not part of a continued literal body.
      let item = &source[range.clone()];
      if let Some(marker_end) = item.find(|character: char| character.is_ascii_whitespace()) {
        let whitespace = item[marker_end..]
          .bytes()
          .take_while(|byte| matches!(byte, b' ' | b'\t'))
          .count();
        tight_items.push(range.start + marker_end + whitespace..range.end);
      }
    }
  }
  protected.extend(html_code.into_iter().map(|(_, start)| (start..source.len(), false)));
  protected.sort_by(|(a, _), (b, _)| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
  let bytes = source.as_bytes();
  let mut masked = bytes.to_vec();
  let mut index = 0;
  let mut boundary = 0;
  let mut math_boundary = 0;
  let mut opening = None;
  let mut blocked = false;
  while index + 1 < bytes.len() {
    while math_ranges.get(math_boundary).is_some_and(|range| range.end <= index) {
      math_boundary += 1;
    }
    if opening.is_none()
      && let Some(range) = math_ranges.get(math_boundary).filter(|range| range.start <= index)
    {
      index = range.end;
      continue;
    }
    while protected.get(boundary).is_some_and(|(range, _)| range.end <= index) {
      boundary += 1;
    }
    if let Some((range, _)) = protected
      .get(boundary)
      .filter(|(range, html)| range.start <= index && (!html || opening.is_none()))
    {
      if opening.is_some() {
        blocked = true;
      }
      index = range.end;
      continue;
    }
    if bytes[index..].starts_with(b"%%")
      && bytes[..index].iter().rev().take_while(|byte| **byte == b'\\').count() % 2 == 0
    {
      if let Some(start) = opening.take() {
        if !blocked {
          let raw = &source[start + 2..index];
          let mut literal = raw.to_string();
          if let Some(paragraph) = paragraphs
            .get(
              paragraphs
                .partition_point(|paragraph| paragraph.start <= start)
                .saturating_sub(1),
            )
            .filter(|paragraph| paragraph.start <= start && start < paragraph.end)
            .or_else(|| {
              tight_items
                .get(
                  tight_items
                    .partition_point(|item| item.start <= start)
                    .saturating_sub(1),
                )
                .filter(|item| item.start <= start && start < item.end)
            })
          {
            let line = source[..paragraph.start].rfind('\n').map_or(0, |position| position + 1);
            let prefix = &source[line..paragraph.start];
            let trimmed = prefix.trim_end();
            let marker = trimmed.rsplit(' ').next().unwrap_or("");
            let numbered = marker
              .strip_suffix('.')
              .or_else(|| marker.strip_suffix(')'))
              .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()));
            let continuation = if matches!(marker, "-" | "+" | "*") || numbered {
              let start = trimmed.len() - marker.len();
              format!("{}{}", &prefix[..start], " ".repeat(prefix.len() - start))
            } else {
              prefix.to_string()
            };
            if !continuation.is_empty() {
              literal = raw
                .split('\n')
                .enumerate()
                .map(|(line, value)| {
                  if line > 0 {
                    value.strip_prefix(&continuation).unwrap_or(value)
                  } else {
                    value
                  }
                })
                .collect::<Vec<_>>()
                .join("\n");
            }
          }
          let body = literal.replace("\\%", "%").replace("\r\n", "\n").replace('\r', "\n");
          masked[start + 2..index].fill(b'x');
          result.spans.push(AnnotationSpan {
            range: start..index + 2,
            body,
            standalone: false,
          });
        } else {
          result.unsupported.push(start..index + 2);
        }
      } else {
        opening = Some(index);
        blocked = false;
      }
      index += 2;
    } else {
      index += 1;
    }
  }
  // Every replaced byte belongs to a complete UTF-8 span; outside bytes are unchanged.
  result.source = String::from_utf8(masked).expect("annotation masking preserves UTF-8");
  for (event, paragraph) in Parser::new_ext(&result.source, options).into_offset_iter() {
    let paragraph = if matches!(event, Event::Start(Tag::Paragraph)) {
      Some(paragraph)
    } else if matches!(event, Event::Start(Tag::Item)) {
      tight_items
        .get(tight_items.partition_point(|item| item.start < paragraph.start))
        .filter(|item| item.end == paragraph.end)
        .cloned()
    } else {
      None
    };
    if let Some(paragraph) = paragraph {
      let start = result.spans.partition_point(|span| span.range.start < paragraph.start);
      let end = result.spans.partition_point(|span| span.range.start < paragraph.end);
      for span in &mut result.spans[start..end] {
        if paragraph.start <= span.range.start
          && span.range.end <= paragraph.end
          && result.source[paragraph.start..span.range.start].trim().is_empty()
          && result.source[span.range.end..paragraph.end].trim().is_empty()
        {
          span.standalone = true;
        }
      }
    }
  }
  result
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn uses_the_same_annotation_contract_as_the_client() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
      "../../../../../build/fixtures/contracts/annotation-syntax.json"
    ))
    .unwrap();
    for fixture in fixtures.as_array().unwrap() {
      let prepared = prepare(
        fixture["markdown"].as_str().unwrap(),
        Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_STRIKETHROUGH,
      );
      let actual: Vec<_> = prepared
        .spans
        .iter()
        .filter(|span| span.standalone || !span.body.is_empty())
        .map(|span| serde_json::json!({ "body": span.body, "standalone": span.standalone }))
        .collect();
      assert_eq!(serde_json::json!(actual), fixture["annotations"], "{}", fixture["name"]);
    }
  }
}
