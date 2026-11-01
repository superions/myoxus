//! Format detection and dispatch to the correct parser.
//!
//! The router inspects MIME type (via magic bytes) and filename extension to
//! determine the [`DocumentFormat`], then delegates to the appropriate parser
//! module.

use crate::error::{PipelineError, Result};
use crate::types::{DocumentFormat, ParsedDocument};

/// Detect document format from raw bytes and an optional filename.
///
/// Detection strategy (in order):
/// 1. Magic-byte sniffing via the `infer` crate.
/// 2. Filename extension via `mime_guess`.
/// 3. Fallback to [`DocumentFormat::Unknown`].
pub fn detect_format(data: &[u8], filename: Option<&str>) -> DocumentFormat {
  // 1. Magic-byte detection
  if let Some(kind) = infer::get(data) {
    match kind.mime_type() {
      "application/pdf" => return DocumentFormat::Pdf,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => {
        return DocumentFormat::Docx;
      }
      "text/html" => return DocumentFormat::Html,
      _ => {}
    }
  }

  // 2. Extension-based detection
  if let Some(name) = filename
    && let Some(ext) = std::path::Path::new(name).extension().and_then(|e| e.to_str())
  {
    return match ext.to_lowercase().as_str() {
      "pdf" => DocumentFormat::Pdf,
      "docx" => DocumentFormat::Docx,
      "html" | "htm" => DocumentFormat::Html,
      "md" | "markdown" => DocumentFormat::Markdown,
      "txt" => DocumentFormat::PlainText,
      // Source code extensions
      "rs" => DocumentFormat::SourceCode("rust".into()),
      "js" | "mjs" | "cjs" => DocumentFormat::SourceCode("javascript".into()),
      "ts" | "mts" | "cts" => DocumentFormat::SourceCode("typescript".into()),
      "tsx" => DocumentFormat::SourceCode("tsx".into()),
      "jsx" => DocumentFormat::SourceCode("jsx".into()),
      "py" | "pyi" => DocumentFormat::SourceCode("python".into()),
      "go" => DocumentFormat::SourceCode("go".into()),
      "c" | "h" => DocumentFormat::SourceCode("c".into()),
      "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" => DocumentFormat::SourceCode("cpp".into()),
      "java" => DocumentFormat::SourceCode("java".into()),
      "json" => DocumentFormat::PlainText,
      "yaml" | "yml" => DocumentFormat::PlainText,
      "toml" => DocumentFormat::PlainText,
      "xml" => DocumentFormat::PlainText,
      _ => DocumentFormat::Unknown,
    };
  }

  // 3. Check if it looks like valid UTF-8 text
  if std::str::from_utf8(data).is_ok() {
    return DocumentFormat::PlainText;
  }

  DocumentFormat::Unknown
}

/// Parse a document by detecting its format and dispatching to the appropriate
/// parser.
///
/// # Arguments
/// * `data` — raw document bytes
/// * `filename` — optional original filename (used for format detection and
///   metadata)
pub fn parse(data: &[u8], filename: Option<&str>) -> Result<ParsedDocument> {
  let format = detect_format(data, filename);
  tracing::info!(format = %format, filename = ?filename, "routing document to parser");

  match &format {
    #[cfg(feature = "pdf")]
    DocumentFormat::Pdf => crate::pdf::parse_pdf(data),

    #[cfg(not(feature = "pdf"))]
    DocumentFormat::Pdf => Err(PipelineError::UnsupportedFormat(
      "PDF support requires the 'pdf' feature".into(),
    )),

    #[cfg(feature = "code")]
    DocumentFormat::SourceCode(_) => crate::code::parse_source_code(data, filename.unwrap_or("unknown")),

    #[cfg(not(feature = "code"))]
    DocumentFormat::SourceCode(_) => Err(PipelineError::UnsupportedFormat(
      "source code support requires the 'code' feature".into(),
    )),

    #[cfg(feature = "docx")]
    DocumentFormat::Docx => crate::docx::parse_docx(data),

    #[cfg(not(feature = "docx"))]
    DocumentFormat::Docx => Err(PipelineError::UnsupportedFormat(
      "DOCX support requires the 'docx' feature".into(),
    )),

    #[cfg(feature = "html")]
    DocumentFormat::Html => crate::html::parse_html(data, None),

    #[cfg(not(feature = "html"))]
    DocumentFormat::Html => Err(PipelineError::UnsupportedFormat(
      "HTML support requires the 'html' feature".into(),
    )),

    DocumentFormat::PlainText | DocumentFormat::Markdown | DocumentFormat::Unknown => {
      parse_plain_text(data, filename, format)
    }
  }
}

/// Fallback parser: treats the input as plain UTF-8 text and produces a single
/// chunk.
fn parse_plain_text(data: &[u8], filename: Option<&str>, format: DocumentFormat) -> Result<ParsedDocument> {
  let text = std::str::from_utf8(data).map_err(|e| PipelineError::ParseError(format!("invalid UTF-8: {e}")))?;

  if text.trim().is_empty() {
    return Err(PipelineError::NoContent);
  }

  let chunk = crate::types::TextChunk {
    content: text.to_string(),
    index: 0,
    start_offset: Some(0),
    end_offset: Some(text.len()),
    token_count: None,
    chunk_type: crate::types::ChunkType::Text,
  };

  Ok(ParsedDocument {
    title: filename.map(String::from),
    text: text.to_string(),
    chunks: vec![chunk],
    metadata: std::collections::HashMap::new(),
    language: None,
    format,
    page_count: None,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn detect_pdf_by_magic_bytes() {
    // PDF magic bytes: %PDF-
    let data = b"%PDF-1.4 fake content";
    assert_eq!(detect_format(data, None), DocumentFormat::Pdf);
  }

  #[test]
  fn detect_pdf_by_extension() {
    let data = b"not actually pdf bytes";
    assert_eq!(detect_format(data, Some("report.pdf")), DocumentFormat::Pdf);
  }

  #[test]
  fn detect_rust_by_extension() {
    let data = b"fn main() {}";
    assert_eq!(
      detect_format(data, Some("main.rs")),
      DocumentFormat::SourceCode("rust".into())
    );
  }

  #[test]
  fn detect_markdown_by_extension() {
    let data = b"# Hello";
    assert_eq!(detect_format(data, Some("README.md")), DocumentFormat::Markdown);
  }

  #[test]
  fn fallback_utf8_to_plain_text() {
    let data = b"just some text without a filename";
    assert_eq!(detect_format(data, None), DocumentFormat::PlainText);
  }

  #[test]
  fn fallback_binary_to_unknown() {
    let data: &[u8] = &[0xFF, 0xFE, 0x00, 0x01, 0x80, 0x90, 0xA0];
    assert_eq!(detect_format(data, None), DocumentFormat::Unknown);
  }

  #[test]
  fn parse_plain_text_produces_single_chunk() {
    let data = b"Hello, world!";
    let doc = parse(data, Some("hello.txt")).unwrap();
    assert_eq!(doc.format, DocumentFormat::PlainText);
    assert_eq!(doc.chunks.len(), 1);
    assert_eq!(doc.chunks[0].content, "Hello, world!");
    assert_eq!(doc.title, Some("hello.txt".into()));
  }

  #[test]
  fn parse_empty_text_returns_no_content() {
    let data = b"   ";
    let result = parse(data, Some("empty.txt"));
    assert!(matches!(result, Err(PipelineError::NoContent)));
  }
}
