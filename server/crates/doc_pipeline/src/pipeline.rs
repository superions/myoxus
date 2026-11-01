//! High-level document parser that composes format detection, parsing, and
//! optional text splitting into a single entry point.
//!
//! [`DefaultDocumentParser`] is the main integration point for callers who want
//! to go from raw bytes to a fully chunked [`ParsedDocument`] in one call.

use std::collections::HashMap;

use crate::error::{PipelineError, Result};
use crate::router;
use crate::types::{DocumentFormat, ParsedDocument};

/// Configuration for [`DefaultDocumentParser`].
#[derive(Debug, Clone, Default)]
pub struct ParserConfig {
  /// When the `splitting` feature is enabled, this controls chunk sizes and
  /// tokenizer model.  Ignored when the feature is off.
  #[cfg(feature = "splitting")]
  pub split_config: crate::splitter::SplitConfig,
}

/// All-in-one document parser that detects format, extracts text, and splits
/// into token-bounded chunks.
///
/// # Usage
///
/// ```rust,ignore
/// use myoxus_doc_pipeline::{DefaultDocumentParser, pipeline::ParserConfig};
///
/// let parser = DefaultDocumentParser::new(ParserConfig::default());
/// let doc = parser.parse(raw_bytes, "application/pdf", "report.pdf")?;
/// for chunk in &doc.chunks {
///     println!("[{}] {}", chunk.index, &chunk.content[..40.min(chunk.content.len())]);
/// }
/// ```
pub struct DefaultDocumentParser {
  #[allow(dead_code)] // read only when `splitting` feature is on
  config: ParserConfig,
}

impl DefaultDocumentParser {
  /// Create a new parser with the given configuration.
  pub fn new(config: ParserConfig) -> Self {
    Self { config }
  }

  /// Parse a document from raw bytes.
  ///
  /// 1. Detects the format from MIME type and filename.
  /// 2. Dispatches to the appropriate format-specific parser.
  /// 3. If the `splitting` feature is enabled and the document has unsplit
  ///    full text, splits it into token-bounded chunks.
  pub fn parse(&self, data: &[u8], mime_type: &str, filename: &str) -> Result<ParsedDocument> {
    // Step 1: Detect format — prefer explicit MIME, fall back to filename /
    // magic bytes.
    let format = detect_format_from_mime(mime_type).unwrap_or_else(|| router::detect_format(data, Some(filename)));

    tracing::info!(
        format = %format,
        filename = %filename,
        mime_type = %mime_type,
        data_len = data.len(),
        "DefaultDocumentParser: parsing document"
    );

    // Step 2: Dispatch to format parser.
    #[allow(unused_mut)] // mutated only when `splitting` is on
    let mut doc = match &format {
      #[cfg(feature = "pdf")]
      DocumentFormat::Pdf => crate::pdf::parse_pdf(data)?,

      #[cfg(not(feature = "pdf"))]
      DocumentFormat::Pdf => {
        return Err(PipelineError::UnsupportedFormat(
          "PDF support requires the 'pdf' feature".into(),
        ));
      }

      #[cfg(feature = "docx")]
      DocumentFormat::Docx => crate::docx::parse_docx(data)?,

      #[cfg(not(feature = "docx"))]
      DocumentFormat::Docx => {
        return Err(PipelineError::UnsupportedFormat(
          "DOCX support requires the 'docx' feature".into(),
        ));
      }

      #[cfg(feature = "html")]
      DocumentFormat::Html => crate::html::parse_html(data, None)?,

      #[cfg(not(feature = "html"))]
      DocumentFormat::Html => {
        return Err(PipelineError::UnsupportedFormat(
          "HTML support requires the 'html' feature".into(),
        ));
      }

      #[cfg(feature = "code")]
      DocumentFormat::SourceCode(_lang) => parse_source_code(data, filename)?,

      #[cfg(not(feature = "code"))]
      DocumentFormat::SourceCode(_) => {
        return Err(PipelineError::UnsupportedFormat(
          "source code parser requires the 'code' feature".into(),
        ));
      }

      DocumentFormat::Markdown => parse_markdown(data, filename)?,

      DocumentFormat::PlainText | DocumentFormat::Unknown => parse_plain_text(data, filename)?,
    };

    // Step 3: Split full text into token-bounded chunks if not already
    // chunked by the format parser.
    #[cfg(feature = "splitting")]
    {
      // If the parser produced a single giant chunk (or no chunks at all)
      // and we have full text, re-chunk using the splitter.
      let needs_splitting = doc.chunks.is_empty() || (doc.chunks.len() == 1 && !doc.text.is_empty());

      if needs_splitting && !doc.text.is_empty() {
        let chunks = if doc.format == DocumentFormat::Markdown {
          crate::splitter::split_markdown(&doc.text, &self.config.split_config)
        } else {
          crate::splitter::split_text(&doc.text, &self.config.split_config)
        };
        if !chunks.is_empty() {
          doc.chunks = chunks;
        }
      }
    }

    tracing::debug!(
        chunks = doc.chunks.len(),
        text_len = doc.text.len(),
        format = %doc.format,
        "DefaultDocumentParser: parsing complete"
    );

    Ok(doc)
  }
}

// ---------------------------------------------------------------------------
// MIME → DocumentFormat mapping
// ---------------------------------------------------------------------------

/// Try to determine format from the explicit MIME type string.
fn detect_format_from_mime(mime: &str) -> Option<DocumentFormat> {
  match mime {
    "application/pdf" => Some(DocumentFormat::Pdf),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some(DocumentFormat::Docx),
    "text/html" | "application/xhtml+xml" => Some(DocumentFormat::Html),
    "text/markdown" | "text/x-markdown" => Some(DocumentFormat::Markdown),
    "text/plain" => Some(DocumentFormat::PlainText),
    _ if mime.starts_with("text/x-") => {
      // e.g. text/x-rust, text/x-python
      let lang = mime.strip_prefix("text/x-").unwrap_or("unknown");
      Some(DocumentFormat::SourceCode(lang.to_owned()))
    }
    _ => None,
  }
}

// ---------------------------------------------------------------------------
// Simple format parsers (plain text, markdown, source code wrapper)
// ---------------------------------------------------------------------------

/// Parse UTF-8 plain text into a [`ParsedDocument`].
fn parse_plain_text(data: &[u8], filename: &str) -> Result<ParsedDocument> {
  let text = std::str::from_utf8(data).map_err(|e| PipelineError::ParseError(format!("invalid UTF-8: {e}")))?;

  if text.trim().is_empty() {
    return Err(PipelineError::NoContent);
  }

  Ok(ParsedDocument {
    title: Some(filename.to_owned()),
    text: text.to_owned(),
    chunks: vec![],
    metadata: HashMap::new(),
    language: None,
    format: DocumentFormat::PlainText,
    page_count: None,
  })
}

/// Parse a Markdown file: extract title from first `# ` heading, keep full
/// text. Chunking is deferred to the splitting step.
fn parse_markdown(data: &[u8], filename: &str) -> Result<ParsedDocument> {
  let text = std::str::from_utf8(data).map_err(|e| PipelineError::ParseError(format!("invalid UTF-8: {e}")))?;

  if text.trim().is_empty() {
    return Err(PipelineError::NoContent);
  }

  let title = text
    .lines()
    .find(|l| l.starts_with("# "))
    .map(|l| l[2..].trim().to_owned())
    .or_else(|| Some(filename.to_owned()));

  Ok(ParsedDocument {
    title,
    text: text.to_owned(),
    chunks: vec![],
    metadata: HashMap::new(),
    language: None,
    format: DocumentFormat::Markdown,
    page_count: None,
  })
}

/// Parse source code via the `code` module (tree-sitter).  Falls back to
/// plain-text if tree-sitter cannot handle the language.
#[cfg(feature = "code")]
fn parse_source_code(data: &[u8], filename: &str) -> Result<ParsedDocument> {
  let text = std::str::from_utf8(data).map_err(|e| PipelineError::ParseError(format!("invalid UTF-8: {e}")))?;

  if text.trim().is_empty() {
    return Err(PipelineError::NoContent);
  }

  let ext = std::path::Path::new(filename)
    .extension()
    .and_then(|e| e.to_str())
    .unwrap_or("");
  let lang = ext.to_lowercase();

  // The code module's parse function returns a Vec<TextChunk> (the old-style
  // chunks with label/start_line/end_line).  We adapt them to the new
  // types::TextChunk format here.
  //
  // NOTE: If the code module is not yet adapted to the new types, we fall
  // back to treating source code as plain text and let the splitter handle
  // it.
  Ok(ParsedDocument {
    title: Some(filename.to_owned()),
    text: text.to_owned(),
    chunks: vec![],
    metadata: {
      let mut m = HashMap::new();
      m.insert("language".to_owned(), lang);
      m
    },
    language: Some(ext.to_owned()),
    format: DocumentFormat::SourceCode(ext.to_owned()),
    page_count: None,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;

  fn parser() -> DefaultDocumentParser {
    DefaultDocumentParser::new(ParserConfig::default())
  }

  #[test]
  fn plain_text_roundtrip() {
    let data = b"Hello, world! This is a test document.";
    let doc = parser().parse(data, "text/plain", "hello.txt").unwrap();

    assert_eq!(doc.format, DocumentFormat::PlainText);
    assert_eq!(doc.title, Some("hello.txt".into()));
    assert!(!doc.text.is_empty());
  }

  #[test]
  fn markdown_extracts_title() {
    let md = b"# My Document\n\nSome content here.\n";
    let doc = parser().parse(md, "text/markdown", "readme.md").unwrap();

    assert_eq!(doc.format, DocumentFormat::Markdown);
    assert_eq!(doc.title, Some("My Document".into()));
  }

  #[test]
  fn empty_document_returns_no_content() {
    let result = parser().parse(b"   ", "text/plain", "empty.txt");
    assert!(matches!(result, Err(PipelineError::NoContent)));
  }

  #[test]
  fn unknown_mime_falls_back_to_filename() {
    let data = b"fn main() { println!(\"hello\"); }";
    let result = parser().parse(data, "application/octet-stream", "main.rs");

    // Router detects .rs → SourceCode. If the `code` feature is enabled,
    // we get a ParsedDocument; if not, we get UnsupportedFormat — both are
    // correct behaviour.
    match result {
      Ok(doc) => {
        assert!(
          matches!(doc.format, DocumentFormat::SourceCode(_)),
          "expected SourceCode format, got {}",
          doc.format
        );
      }
      Err(PipelineError::UnsupportedFormat(_)) => {
        // Expected when `code` feature is off.
      }
      Err(e) => panic!("unexpected error: {e}"),
    }
  }

  #[test]
  fn mime_detection_pdf() {
    let fmt = detect_format_from_mime("application/pdf");
    assert_eq!(fmt, Some(DocumentFormat::Pdf));
  }

  #[test]
  fn mime_detection_unknown() {
    let fmt = detect_format_from_mime("application/octet-stream");
    assert_eq!(fmt, None);
  }

  #[test]
  fn mime_detection_source_code() {
    let fmt = detect_format_from_mime("text/x-rust");
    assert_eq!(fmt, Some(DocumentFormat::SourceCode("rust".into())));
  }

  #[cfg(feature = "splitting")]
  #[test]
  fn splitting_produces_chunks_for_long_text() {
    let sentence = "The quick brown fox jumps over the lazy dog. ";
    let long_text: String = sentence.repeat(200);

    let config = ParserConfig {
      split_config: crate::splitter::SplitConfig {
        max_chunk_tokens: 100,
        overlap_tokens: 10,
        model: crate::splitter::TokenizerModel::Cl100kBase,
      },
    };
    let p = DefaultDocumentParser::new(config);
    let doc = p.parse(long_text.as_bytes(), "text/plain", "long.txt").unwrap();

    assert!(
      doc.chunks.len() > 1,
      "long text should be split into multiple chunks, got {}",
      doc.chunks.len()
    );
    for chunk in &doc.chunks {
      assert!(
        chunk.token_count.unwrap() <= 100,
        "chunk {} exceeds max token count: {}",
        chunk.index,
        chunk.token_count.unwrap()
      );
    }
  }

  #[cfg(feature = "splitting")]
  #[test]
  fn markdown_splitting_uses_markdown_splitter() {
    let md = "\
# Introduction

This is the introduction paragraph with enough words to require splitting when the token limit is small.

## Methods

Description of the methods used in this study, including statistical analysis and data collection procedures.

## Results

The results show significant improvements across all measured metrics in the experimental condition.
";
    let config = ParserConfig {
      split_config: crate::splitter::SplitConfig {
        max_chunk_tokens: 30,
        overlap_tokens: 0,
        model: crate::splitter::TokenizerModel::Cl100kBase,
      },
    };
    let p = DefaultDocumentParser::new(config);
    let doc = p.parse(md.as_bytes(), "text/markdown", "paper.md").unwrap();

    assert_eq!(doc.format, DocumentFormat::Markdown);
    assert!(doc.chunks.len() > 1, "markdown should be split into multiple chunks");
    // At least one chunk should be detected as a heading chunk.
    let has_heading = doc
      .chunks
      .iter()
      .any(|c| c.chunk_type == crate::types::ChunkType::Heading);
    assert!(
      has_heading,
      "markdown splitting should produce at least one Heading chunk"
    );
  }

  #[cfg(feature = "splitting")]
  #[test]
  fn short_text_single_chunk_after_splitting() {
    let data = b"Short text.";
    let doc = parser().parse(data, "text/plain", "short.txt").unwrap();

    assert_eq!(doc.chunks.len(), 1);
    assert_eq!(doc.chunks[0].content.trim(), "Short text.");
  }
}
