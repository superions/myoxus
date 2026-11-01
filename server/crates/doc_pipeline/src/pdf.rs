//! PDF parser backed by [`pdf_extract`].
//!
//! Extracts text page by page and produces a [`ParsedDocument`] with one
//! [`TextChunk`] per page. Uses the proven `pdf-extract` crate (MIT licensed,
//! Rust 1.85-compatible).

use std::collections::HashMap;

use crate::error::{PipelineError, Result};
use crate::types::{ChunkType, DocumentFormat, ParsedDocument, TextChunk};

/// Parse a PDF document from raw bytes.
///
/// # Behaviour
/// - Extracts text from every page via `pdf_extract::extract_text_from_mem_by_pages`.
/// - Returns one [`TextChunk`] per page (type [`ChunkType::Text`]).
/// - Empty pages are skipped.
///
/// # Errors
/// - [`PipelineError::Encrypted`] if the document is password-protected.
/// - [`PipelineError::ParseError`] if the PDF is malformed.
/// - [`PipelineError::NoContent`] if no text could be extracted from any page.
#[tracing::instrument(skip(data), fields(data_len = data.len()))]
pub fn parse_pdf(data: &[u8]) -> Result<ParsedDocument> {
  if data.is_empty() {
    return Err(PipelineError::ParseError("empty PDF data".into()));
  }

  // Try page-by-page extraction first.
  let pages = pdf_extract::extract_text_from_mem_by_pages(data).map_err(|e| {
    let msg = format!("{e}");
    if msg.to_lowercase().contains("encrypt") || msg.to_lowercase().contains("password") {
      tracing::error!("PDF is encrypted");
      PipelineError::Encrypted
    } else {
      tracing::error!(error = %e, "failed to parse PDF");
      PipelineError::ParseError(format!("failed to parse PDF: {e}"))
    }
  })?;

  let page_count = pages.len();
  tracing::info!(page_count, "opened PDF document");

  // --- Build chunks per page -----------------------------------------------
  let mut full_text = String::new();
  let mut chunks = Vec::new();
  let mut chunk_index: usize = 0;

  for (page_idx, page_text) in pages.iter().enumerate() {
    let trimmed = page_text.trim();
    if trimmed.is_empty() {
      tracing::trace!(page = page_idx, "skipping empty page");
      continue;
    }

    let start_offset = full_text.len();
    if !full_text.is_empty() {
      full_text.push('\n');
    }
    full_text.push_str(trimmed);
    let end_offset = full_text.len();

    chunks.push(TextChunk {
      content: trimmed.to_string(),
      index: chunk_index,
      start_offset: Some(start_offset),
      end_offset: Some(end_offset),
      token_count: None,
      chunk_type: ChunkType::Text,
    });
    chunk_index += 1;
  }

  if chunks.is_empty() {
    tracing::warn!("PDF contained no extractable text");
    return Err(PipelineError::NoContent);
  }

  tracing::info!(
    pages = page_count,
    chunks = chunks.len(),
    text_bytes = full_text.len(),
    "PDF parsed successfully"
  );

  Ok(ParsedDocument {
    title: None,
    text: full_text,
    chunks,
    metadata: HashMap::new(),
    language: None,
    format: DocumentFormat::Pdf,
    page_count: Some(page_count),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Build a minimal valid PDF in memory using lopdf.
  ///
  /// Creates a single-page PDF with the text "Hello World" rendered via a
  /// Type1 Helvetica font. lopdf handles correct xref generation.
  fn minimal_pdf() -> Vec<u8> {
    use lopdf::dictionary;
    use lopdf::{Document, Object, Stream};

    let mut doc = Document::with_version("1.4");

    // Font object: Type1 Helvetica.
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });

    // Content stream: draw "Hello World" at (100, 700).
    let content = b"BT /F1 12 Tf 100 700 Td (Hello World) Tj ET";
    let content_stream = Stream::new(dictionary! {}, content.to_vec());
    let content_id = doc.add_object(content_stream);

    // Resources dictionary.
    let resources = dictionary! {
        "Font" => dictionary! {
            "F1" => font_id,
        },
    };
    let resources_id = doc.add_object(resources);

    // Page object.
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Contents" => content_id,
        "Resources" => resources_id,
    });

    // Pages object.
    let pages_id = doc.add_object(dictionary! {
        "Type" => "Pages",
        "Kids" => vec![page_id.into()],
        "Count" => 1,
    });

    // Set parent on the page.
    if let Ok(page) = doc.get_object_mut(page_id)
      && let Object::Dictionary(dict) = page
    {
      dict.set("Parent", pages_id);
    }

    // Catalog.
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });

    doc.trailer.set("Root", catalog_id);

    let mut buf = Vec::new();
    doc.save_to(&mut buf).expect("lopdf save_to");
    buf
  }

  #[test]
  fn parse_minimal_pdf_extracts_text() {
    let data = minimal_pdf();
    let doc = parse_pdf(&data).unwrap();

    assert_eq!(doc.format, DocumentFormat::Pdf);
    assert_eq!(doc.page_count, Some(1));
    assert!(!doc.chunks.is_empty(), "should have at least one chunk");
    assert!(
      doc.text.contains("Hello"),
      "extracted text should contain 'Hello', got: {:?}",
      doc.text
    );
  }

  #[test]
  fn parse_empty_bytes_returns_error() {
    let result = parse_pdf(b"");
    assert!(result.is_err());
  }

  #[test]
  fn parse_garbage_bytes_returns_error() {
    let result = parse_pdf(b"this is definitely not a PDF");
    assert!(result.is_err());
  }

  #[test]
  fn parse_pdf_magic_but_invalid_returns_error() {
    let result = parse_pdf(b"%PDF-1.4 but then garbage");
    assert!(result.is_err());
  }
}
