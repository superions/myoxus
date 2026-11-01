//! Core types for the document parsing pipeline.

use std::collections::HashMap;
use std::fmt;

/// Result of parsing a document through the pipeline.
#[derive(Debug, Clone)]
pub struct ParsedDocument {
  /// Document title extracted from metadata or content.
  pub title: Option<String>,
  /// Full extracted plain text of the document.
  pub text: String,
  /// Structured chunks for indexing and embedding.
  pub chunks: Vec<TextChunk>,
  /// Arbitrary key-value metadata (author, creation date, etc.).
  pub metadata: HashMap<String, String>,
  /// Primary language of the content (e.g. `"en"`, `"rust"`).
  pub language: Option<String>,
  /// Detected document format.
  pub format: DocumentFormat,
  /// Number of pages (for paginated formats like PDF).
  pub page_count: Option<usize>,
}

/// A contiguous slice of a document's content, enriched with structural
/// metadata. Suitable for embedding pipelines and search indexing.
#[derive(Debug, Clone)]
pub struct TextChunk {
  /// The actual text content of this chunk.
  pub content: String,
  /// 0-based position of this chunk within the document's chunk sequence.
  pub index: usize,
  /// Byte offset where this chunk starts in the full text.
  pub start_offset: Option<usize>,
  /// Byte offset where this chunk ends in the full text.
  pub end_offset: Option<usize>,
  /// Approximate token count (populated when a tokenizer feature is enabled).
  pub token_count: Option<usize>,
  /// What kind of content this chunk represents.
  pub chunk_type: ChunkType,
}

/// The kind of content a [`TextChunk`] represents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChunkType {
  /// Running body text.
  Text,
  /// A heading or section title.
  Heading,
  /// A source code block or extracted code construct.
  Code,
  /// A table (rendered as text).
  Table,
  /// Document-level metadata rendered as text.
  Metadata,
}

/// Known document formats that the pipeline can handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentFormat {
  /// PDF document.
  Pdf,
  /// Microsoft Word / OpenOffice DOCX.
  Docx,
  /// HTML page.
  Html,
  /// Source code file; the `String` carries the language identifier
  /// (e.g. `"rust"`, `"python"`).
  SourceCode(String),
  /// Unformatted plain text.
  PlainText,
  /// Markdown.
  Markdown,
  /// Format could not be determined.
  Unknown,
}

impl fmt::Display for DocumentFormat {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Pdf => write!(f, "pdf"),
      Self::Docx => write!(f, "docx"),
      Self::Html => write!(f, "html"),
      Self::SourceCode(lang) => write!(f, "code:{lang}"),
      Self::PlainText => write!(f, "plaintext"),
      Self::Markdown => write!(f, "markdown"),
      Self::Unknown => write!(f, "unknown"),
    }
  }
}
