// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};

/// Native editor reference carried by one attributed text run.
///
/// The codec treats the external page key and navigation data as opaque. URL
/// ownership, authorization and title lookup remain caller responsibilities.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownDocumentReference {
  pub page_id: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub params: Option<serde_json::Value>,
}

/// Authorized presentation supplied to the pure codec for one native target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownResolvedReference {
  pub url: String,
  pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkdownDiagnosticCode {
  UnresolvedDocumentReference,
  UnsupportedDocumentReference,
  OmittedNativeMetadata,
  MissingNativeSource,
  UnsupportedNativeContent,
  MissingChildBlock,
  /// A concrete editor highlight color was projected to portable Markdown
  /// highlight presence.
  NormalizedHighlight,
  /// A sole inline annotation becomes a standalone block in portable Markdown.
  NormalizedAnnotation,
  /// The literal body cannot cross protected syntax in the admitted dialect.
  UnsupportedAnnotation,
  /// Callout syntax or a descendant cannot be represented by the native model.
  UnsupportedCallout,
  /// Formula source is retained, but its placement or delimiters are not native.
  UnsupportedMath,
  /// An unreferenced definition is preserved and exported once.
  UnreferencedFootnote,
  /// Standard Markdown retains the body but cannot carry endnote placement.
  NormalizedEndnote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarkdownDiagnostic {
  pub code: MarkdownDiagnosticCode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkdownLinkTarget<'a> {
  Url(&'a str),
  Wiki(&'a str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkdownLinkResolution {
  Ordinary,
  Reference(MarkdownDocumentReference),
  Unresolved,
  Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownImportResult {
  pub yjs_binary: Vec<u8>,
  pub diagnostics: Vec<MarkdownDiagnostic>,
  /// Counts actual emitted native formulas, never a source-text heuristic.
  pub native_math_count: usize,
  /// Actual parent-local definition containers emitted by the canonical codec.
  pub native_footnote_count: usize,
}

/// Result of extracting human-readable content from a Yjs binary snapshot.
#[derive(Debug, Clone)]
pub struct YjsExtractResult {
  /// Canonical label/target pairs observed by the same native codec walk.
  pub citations: Vec<(String, serde_json::Value)>,
  /// Document title extracted from the top-level `affine:page` block's
  /// `title` property, if present.
  pub title: Option<String>,
  /// Extracted document content as Markdown.
  pub markdown: String,
  /// Number of blocks visited during extraction.
  pub blocks_visited: u32,
  /// `true` when the extraction fell back or skipped unsupported block types.
  pub extraction_partial: bool,
  /// Safe, payload-free conversion findings for caller-owned reporting.
  pub diagnostics: Vec<MarkdownDiagnostic>,
}
