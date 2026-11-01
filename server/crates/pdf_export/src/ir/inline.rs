// SPDX-License-Identifier: AGPL-3.0-or-later
use serde::{Deserialize, Serialize};

/// Text formatting marks that can be applied to inline spans.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TextMarks {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub bold: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub italic: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub underline: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub strike: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub code: Option<bool>,
  /// Foreground color as CSS hex string (e.g. "#ff5500")
  #[serde(skip_serializing_if = "Option::is_none")]
  pub color: Option<String>,
  /// Background highlight color as CSS hex string
  #[serde(skip_serializing_if = "Option::is_none")]
  pub background: Option<String>,
  /// Link target URL or doc-id (prefixed with "doc:")
  #[serde(skip_serializing_if = "Option::is_none")]
  pub link: Option<String>,
}

impl TextMarks {
  pub fn is_empty(&self) -> bool {
    self.bold.is_none()
      && self.italic.is_none()
      && self.underline.is_none()
      && self.strike.is_none()
      && self.code.is_none()
      && self.color.is_none()
      && self.background.is_none()
      && self.link.is_none()
  }
}

/// An inline span within a rich-text block.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InlineSpan {
  /// Plain or formatted text.
  Text {
    text: String,
    #[serde(default, skip_serializing_if = "TextMarks::is_empty")]
    marks: TextMarks,
  },

  /// Inline LaTeX math expression.
  /// Rendered as Typst `$expr$`.
  Latex { source: String },

  /// Inline reference to another document.
  Reference {
    doc_id: String,
    /// Display title (may be empty — resolved at render time if available).
    title: Option<String>,
  },

  /// User mention (@user).
  Mention {
    user_id: String,
    display_name: Option<String>,
  },

  /// Footnote marker. The footnote body is inline content.
  Footnote { content: Vec<InlineSpan> },

  /// Resolved parent-local note in this export snapshot. Only the first page
  /// footnote reference owns ordinary blocks; repeats reuse its Typst label.
  LocalFootnote {
    definition_id: String,
    placement: yjs::footnote::FootnotePlacement,
    number: Option<u32>,
    reference_index: usize,
    references: usize,
    locale: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<Vec<super::block::Block>>,
  },
}

impl InlineSpan {
  /// Returns true if this is an empty text span (zero-length string).
  pub fn is_empty_text(&self) -> bool {
    matches!(self, InlineSpan::Text { text, .. } if text.is_empty())
  }
}

/// Unformatted document text for metadata; never Typst-escaped markup.
pub(crate) fn inline_plain_text(spans: &[InlineSpan]) -> String {
  spans
    .iter()
    .map(|span| match span {
      InlineSpan::Text { text, .. } => text.clone(),
      InlineSpan::Latex { source } => source.clone(),
      InlineSpan::Reference { title, doc_id } => title.as_ref().unwrap_or(doc_id).clone(),
      InlineSpan::Mention { display_name, user_id } => display_name.as_ref().unwrap_or(user_id).clone(),
      InlineSpan::Footnote { content } => inline_plain_text(content),
      InlineSpan::LocalFootnote { number, .. } => number.map_or_else(|| "[?]".into(), |n| format!("[{n}]")),
    })
    .collect()
}
