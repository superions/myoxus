// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Public types for the doc-indexer crate.

use serde::{Deserialize, Serialize};

/// Information about a single block extracted from a Y-Doc.
///
/// Each block in a document corresponds to one `BlockInfo` entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockInfo {
  /// The unique identifier of this block within the document.
  pub block_id: String,
  /// The block's flavour (e.g. `"affine:page"`, `"affine:paragraph"`).
  pub flavour: String,
  /// Text content segments extracted from the block (e.g. from `prop:text`).
  pub content: Option<Vec<String>>,
  /// Blob references (e.g. image source IDs, attachment source IDs).
  pub blob: Option<Vec<String>>,
  /// Referenced document IDs (e.g. from inline references or linked docs).
  pub ref_doc_id: Option<Vec<String>>,
  /// Reference metadata as JSON strings (e.g. reference payloads).
  pub ref_info: Option<Vec<String>>,
  /// The flavour of this block's parent block.
  pub parent_flavour: Option<String>,
  /// The block ID of this block's parent block.
  pub parent_block_id: Option<String>,
  /// JSON string containing additional metadata (displayMode, noteBlockId, databaseName).
  pub additional: Option<String>,
}

impl BlockInfo {
  /// Create a `BlockInfo` with only the base fields populated.
  /// Content-specific fields (`content`, `blob`, `ref_doc_id`, `ref_info`) are set to `None`.
  pub(crate) fn base(
    block_id: &str,
    flavour: &str,
    parent_flavour: Option<&String>,
    parent_block_id: Option<&String>,
    additional: Option<String>,
  ) -> Self {
    Self {
      block_id: block_id.to_string(),
      flavour: flavour.to_string(),
      content: None,
      blob: None,
      ref_doc_id: None,
      ref_info: None,
      parent_flavour: parent_flavour.cloned(),
      parent_block_id: parent_block_id.cloned(),
      additional,
    }
  }
}

/// The result of crawling/parsing a Y-Doc binary.
///
/// Contains all extracted blocks, the document title, and a text summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrawlResult {
  /// All blocks extracted from the document, in tree-walk order.
  pub blocks: Vec<BlockInfo>,
  /// The document title (from the `affine:page` block's `prop:title`).
  pub title: String,
  /// A text summary generated from the first ~1000 chars of text content.
  pub summary: String,
}

/// Errors that can occur during Y-Doc parsing.
#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
pub enum ParseError {
  /// The requested document was not found.
  #[error("doc_not_found")]
  DocNotFound,
  /// The binary data could not be decoded as a valid Y-Doc update.
  #[error("invalid_binary")]
  InvalidBinary,
  /// An error occurred during parsing.
  #[error("parser_error: {0}")]
  ParserError(String),
}
