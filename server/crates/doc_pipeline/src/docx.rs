//! DOCX parser using manual ZIP + XML extraction.
//!
//! DOCX files are ZIP archives containing Office Open XML. The main document
//! body lives in `word/document.xml`. This parser reads that XML, walking the
//! `<w:body>` tree to extract paragraphs (with heading detection), tables, and
//! document metadata from `docProps/core.xml`.
//!
//! Dependencies: `zip` (archive reading) + `quick-xml` (XML parsing).

use std::collections::HashMap;
use std::io::Read;

use quick_xml::Reader;
use quick_xml::XmlVersion;
use quick_xml::events::{BytesRef, BytesText, Event};

use crate::error::{PipelineError, Result};
use crate::types::{ChunkType, DocumentFormat, ParsedDocument, TextChunk};

/// Parse a DOCX document from raw bytes.
///
/// # Behaviour
/// - Opens the ZIP archive and reads `word/document.xml`.
/// - Extracts paragraphs with heading/body classification.
/// - Renders tables as pipe-separated Markdown.
/// - Reads `docProps/core.xml` for metadata (title, creator, description).
///
/// # Errors
/// - [`PipelineError::ParseError`] if the ZIP or XML is malformed.
/// - [`PipelineError::Encrypted`] if the archive is password-protected.
/// - [`PipelineError::NoContent`] if no text could be extracted.
#[tracing::instrument(skip(data), fields(data_len = data.len()))]
pub fn parse_docx(data: &[u8]) -> Result<ParsedDocument> {
  let cursor = std::io::Cursor::new(data);
  let mut archive = zip::ZipArchive::new(cursor).map_err(|e| {
    let msg = format!("{e}");
    if msg.to_lowercase().contains("password") || msg.to_lowercase().contains("encrypt") {
      tracing::error!("DOCX archive is encrypted");
      PipelineError::Encrypted
    } else {
      tracing::error!(error = %e, "failed to open DOCX ZIP archive");
      PipelineError::ParseError(format!("invalid DOCX archive: {e}"))
    }
  })?;

  // --- Extract metadata from docProps/core.xml ----------------------------
  let metadata = extract_core_metadata(&mut archive);
  let meta_title = metadata.get("title").cloned();

  // --- Read word/document.xml ---------------------------------------------
  let doc_xml = read_archive_file(&mut archive, "word/document.xml")?;
  tracing::debug!(xml_bytes = doc_xml.len(), "read word/document.xml");

  // --- Parse the XML body -------------------------------------------------
  let elements = parse_document_xml(&doc_xml)?;
  tracing::info!(elements = elements.len(), "parsed document body elements");

  // --- Build chunks -------------------------------------------------------
  let mut full_text = String::new();
  let mut chunks = Vec::new();
  let mut chunk_index: usize = 0;

  for elem in &elements {
    let trimmed = elem.text.trim();
    if trimmed.is_empty() {
      continue;
    }

    let display_text = match &elem.kind {
      ElementKind::Heading(level) => {
        let prefix = "#".repeat(*level as usize);
        format!("{prefix} {trimmed}")
      }
      _ => trimmed.to_string(),
    };

    let chunk_type = match &elem.kind {
      ElementKind::Heading(_) => ChunkType::Heading,
      ElementKind::Table => ChunkType::Table,
      ElementKind::Paragraph => ChunkType::Text,
    };

    let start_offset = full_text.len();
    if !full_text.is_empty() {
      full_text.push('\n');
    }
    full_text.push_str(&display_text);
    let end_offset = full_text.len();

    chunks.push(TextChunk {
      content: display_text,
      index: chunk_index,
      start_offset: Some(start_offset),
      end_offset: Some(end_offset),
      token_count: None,
      chunk_type,
    });
    chunk_index += 1;
  }

  if chunks.is_empty() {
    tracing::warn!("DOCX contained no extractable text");
    return Err(PipelineError::NoContent);
  }

  // Title: prefer metadata title, fall back to first heading.
  let title = meta_title.or_else(|| {
    chunks.iter().find_map(|c| {
      if matches!(c.chunk_type, ChunkType::Heading) {
        Some(c.content.trim_start_matches('#').trim().to_string())
      } else {
        None
      }
    })
  });

  tracing::info!(
      chunks = chunks.len(),
      text_bytes = full_text.len(),
      title = ?title,
      "DOCX parsed successfully"
  );

  Ok(ParsedDocument {
    title,
    text: full_text,
    chunks,
    metadata,
    language: None,
    format: DocumentFormat::Docx,
    page_count: None,
  })
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/// Classification of a document body element.
#[derive(Debug, Clone)]
enum ElementKind {
  /// Heading with 1-based level (1 = H1).
  Heading(u8),
  /// Body paragraph.
  Paragraph,
  /// Table rendered as text.
  Table,
}

/// A parsed element from the document body.
#[derive(Debug, Clone)]
struct DocElement {
  kind: ElementKind,
  text: String,
}

// ---------------------------------------------------------------------------
// ZIP helpers
// ---------------------------------------------------------------------------

/// Read a file from the ZIP archive by name.
fn read_archive_file(archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>, name: &str) -> Result<String> {
  let mut file = archive
    .by_name(name)
    .map_err(|e| PipelineError::ParseError(format!("missing {name} in DOCX archive: {e}")))?;
  let mut contents = String::new();
  file
    .read_to_string(&mut contents)
    .map_err(|e| PipelineError::ParseError(format!("failed to read {name}: {e}")))?;
  Ok(contents)
}

/// Extract metadata from `docProps/core.xml` (Dublin Core).
fn extract_core_metadata(archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>) -> HashMap<String, String> {
  let mut meta = HashMap::new();

  let xml = match read_archive_file(archive, "docProps/core.xml") {
    Ok(xml) => xml,
    Err(_) => {
      tracing::trace!("no docProps/core.xml found — skipping metadata");
      return meta;
    }
  };

  let mut reader = Reader::from_str(&xml);
  let mut current_tag: Option<String> = None;
  let mut buf = Vec::new();

  loop {
    match reader.read_event_into(&mut buf) {
      Ok(Event::Start(ref e)) => {
        let local_name = e.local_name();
        let name = String::from_utf8_lossy(local_name.as_ref()).to_string();
        // Dublin Core fields we care about.
        match name.as_str() {
          "title" | "creator" | "subject" | "description" | "language" => {
            current_tag = Some(name);
          }
          _ => {
            current_tag = None;
          }
        }
      }
      Ok(Event::Text(ref e)) => {
        if let Some(ref tag) = current_tag
          && let Some(text) = decode_xml_text(e)
        {
          meta.entry(tag.clone()).or_default().push_str(&text);
        }
      }
      Ok(Event::GeneralRef(ref reference)) => {
        if let Some(ref tag) = current_tag {
          meta
            .entry(tag.clone())
            .or_default()
            .push_str(&decode_xml_reference(reference));
        }
      }
      Ok(Event::End(_)) => {
        current_tag = None;
      }
      Ok(Event::Eof) => break,
      Err(e) => {
        tracing::warn!(error = %e, "error parsing core.xml metadata — continuing");
        break;
      }
      _ => {}
    }
    buf.clear();
  }

  for value in meta.values_mut() {
    *value = value.trim().to_owned();
  }
  meta.retain(|_, value| !value.is_empty());

  meta
}

// ---------------------------------------------------------------------------
// Document XML parser
// ---------------------------------------------------------------------------

/// Parse `word/document.xml` and return a list of document elements.
///
/// This walks the XML tree looking for:
/// - `<w:p>` — paragraphs (with heading detection via `<w:pStyle>`)
/// - `<w:tbl>` — tables
fn parse_document_xml(xml: &str) -> Result<Vec<DocElement>> {
  let mut reader = Reader::from_str(xml);
  let mut buf = Vec::new();
  let mut elements = Vec::new();

  // State machine for tracking position in the XML tree.
  let mut in_body = false;
  let mut para_depth: u32 = 0;
  let mut table_depth: u32 = 0;
  let mut in_run = false;
  let mut in_text = false;
  // Current paragraph accumulator.
  let mut para_text = String::new();
  let mut para_style: Option<String> = None;
  let mut outline_lvl: Option<u8> = None;

  // Table accumulator.
  let mut table_rows: Vec<Vec<String>> = Vec::new();
  let mut current_row: Vec<String> = Vec::new();
  let mut current_cell_text = String::new();
  let mut in_table_cell = false;

  loop {
    match reader.read_event_into(&mut buf) {
      Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
        let local = local_name(e.local_name().as_ref());
        match local.as_str() {
          "body" => {
            in_body = true;
          }
          "p" if in_body && table_depth == 0 && para_depth == 0 => {
            para_depth = 1;
            para_text.clear();
            para_style = None;
            outline_lvl = None;
          }
          "p" if in_body && table_depth > 0 => {
            // Paragraph inside a table cell — accumulate into cell.
          }
          "tbl" if in_body => {
            table_depth += 1;
            if table_depth == 1 {
              table_rows.clear();
            }
          }
          "tr" if table_depth > 0 => {
            current_row.clear();
          }
          "tc" if table_depth > 0 => {
            in_table_cell = true;
            current_cell_text.clear();
          }
          "r" if (para_depth > 0 || in_table_cell) => {
            in_run = true;
          }
          "t" if in_run => {
            in_text = true;
          }
          "pStyle" if para_depth > 0 => {
            // Extract val attribute for heading style.
            if let Some(val) = get_xml_attr(e, b"w:val").or_else(|| get_xml_attr(e, b"val")) {
              para_style = Some(val);
            }
          }
          "outlineLvl" if para_depth > 0 => {
            if let Some(val) = get_xml_attr(e, b"w:val").or_else(|| get_xml_attr(e, b"val"))
              && let Ok(n) = val.parse::<u8>()
            {
              outline_lvl = Some(n);
            }
          }
          _ => {}
        }
      }
      Ok(Event::Text(ref e)) => {
        if in_text && let Some(text) = decode_xml_text(e) {
          if in_table_cell {
            current_cell_text.push_str(&text);
          } else if para_depth > 0 {
            para_text.push_str(&text);
          }
        }
      }
      Ok(Event::GeneralRef(ref reference)) if in_text => {
        let text = decode_xml_reference(reference);
        if in_table_cell {
          current_cell_text.push_str(&text);
        } else if para_depth > 0 {
          para_text.push_str(&text);
        }
      }
      Ok(Event::End(ref e)) => {
        let local = local_name(e.local_name().as_ref());
        match local.as_str() {
          "body" => {
            in_body = false;
          }
          "p" if para_depth > 0 && table_depth == 0 => {
            // End of a top-level paragraph.
            let kind = classify_style(para_style.as_deref(), outline_lvl);
            elements.push(DocElement {
              kind,
              text: std::mem::take(&mut para_text),
            });
            para_depth = 0;
          }
          "p"
            if in_table_cell
            // End of paragraph inside table cell — add separator
            // if there's already text.
            && !current_cell_text.is_empty() && !current_cell_text.ends_with(' ') =>
          {
            current_cell_text.push(' ');
          }
          "tbl" if table_depth > 0 => {
            table_depth -= 1;
            if table_depth == 0 {
              // Emit table element.
              let rendered = render_table_rows(&table_rows);
              elements.push(DocElement {
                kind: ElementKind::Table,
                text: rendered,
              });
              table_rows.clear();
            }
          }
          "tr" if table_depth > 0 && !current_row.is_empty() => {
            table_rows.push(std::mem::take(&mut current_row));
          }
          "tc" if table_depth > 0 => {
            current_row.push(current_cell_text.trim().to_string());
            current_cell_text.clear();
            in_table_cell = false;
          }
          "r" => {
            in_run = false;
            in_text = false;
          }
          "t" => {
            in_text = false;
          }
          _ => {}
        }
      }
      Ok(Event::Eof) => break,
      Err(e) => {
        tracing::error!(error = %e, "XML parse error in document.xml");
        return Err(PipelineError::ParseError(format!("XML parse error: {e}")));
      }
      _ => {}
    }
    buf.clear();
  }

  Ok(elements)
}

/// Get the local part of a possibly namespace-prefixed XML name.
fn local_name(raw: &[u8]) -> String {
  let s = String::from_utf8_lossy(raw);
  // quick-xml already strips namespace prefix for local_name(), but
  // just in case, handle "w:p" → "p".
  if let Some(pos) = s.find(':') {
    s[pos + 1..].to_string()
  } else {
    s.to_string()
  }
}

/// Extract an attribute value from an XML start/empty element.
fn get_xml_attr(event: &quick_xml::events::BytesStart<'_>, attr_name: &[u8]) -> Option<String> {
  for attr in event.attributes().flatten() {
    if attr.key.as_ref() == attr_name || attr.key.local_name().as_ref() == attr_name {
      return attr
        .normalized_value(XmlVersion::Implicit1_0)
        .ok()
        .map(|value| value.into_owned());
    }
  }
  None
}

fn decode_xml_text(text: &BytesText<'_>) -> Option<String> {
  text
    .xml_content(XmlVersion::Implicit1_0)
    .ok()
    .map(|value| value.into_owned())
}

fn decode_xml_reference(reference: &BytesRef<'_>) -> String {
  let name = reference.decode().map(|value| value.into_owned()).unwrap_or_default();
  reference
    .resolve_char_ref()
    .ok()
    .flatten()
    .map(|value| value.to_string())
    .or_else(|| quick_xml::escape::resolve_predefined_entity(&name).map(str::to_owned))
    .unwrap_or_else(|| format!("&{name};"))
}

/// Classify a paragraph as heading or body text based on its style name
/// and/or outline level.
fn classify_style(style: Option<&str>, outline_lvl: Option<u8>) -> ElementKind {
  // Explicit outline level takes precedence.
  if let Some(lvl) = outline_lvl {
    return ElementKind::Heading(lvl.saturating_add(1).min(9));
  }

  // Style name patterns.
  if let Some(name) = style
    && let Some(level) = parse_heading_level(name)
  {
    return ElementKind::Heading(level);
  }

  ElementKind::Paragraph
}

/// Try to parse a heading level from a style name like "Heading1", "heading 2",
/// "Title" (treated as H1).
fn parse_heading_level(style_name: &str) -> Option<u8> {
  let lower = style_name.to_lowercase();

  // "Title" style = H1
  if lower == "title" {
    return Some(1);
  }

  // "Subtitle" = H2
  if lower == "subtitle" {
    return Some(2);
  }

  let stripped = lower.strip_prefix("heading")?;
  let stripped = stripped.trim();
  stripped.parse::<u8>().ok().filter(|&n| (1..=9).contains(&n))
}

/// Render parsed table rows as a pipe-separated Markdown table.
fn render_table_rows(rows: &[Vec<String>]) -> String {
  if rows.is_empty() {
    return String::new();
  }

  let mut output = String::new();
  for (i, row) in rows.iter().enumerate() {
    output.push_str("| ");
    output.push_str(&row.join(" | "));
    output.push_str(" |\n");

    // Separator after first row (header).
    if i == 0 {
      output.push('|');
      for _ in row {
        output.push_str(" --- |");
      }
      output.push('\n');
    }
  }
  output
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;

  /// Create a minimal valid DOCX archive in memory.
  ///
  /// DOCX = ZIP containing at minimum:
  /// - `[Content_Types].xml`
  /// - `_rels/.rels`
  /// - `word/document.xml`
  fn make_docx(document_xml: &str) -> Vec<u8> {
    use std::io::Write;
    let buf = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(buf);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // [Content_Types].xml
    zip.start_file("[Content_Types].xml", options).unwrap();
    zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#).unwrap();

    // _rels/.rels
    zip.start_file("_rels/.rels", options).unwrap();
    zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#).unwrap();

    // word/document.xml
    zip.start_file("word/document.xml", options).unwrap();
    zip.write_all(document_xml.as_bytes()).unwrap();

    zip.finish().unwrap().into_inner()
  }

  /// Create a DOCX with metadata in docProps/core.xml.
  fn make_docx_with_metadata(document_xml: &str, core_xml: &str) -> Vec<u8> {
    use std::io::Write;
    let buf = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(buf);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("[Content_Types].xml", options).unwrap();
    zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#).unwrap();

    zip.start_file("_rels/.rels", options).unwrap();
    zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#).unwrap();

    zip.start_file("word/document.xml", options).unwrap();
    zip.write_all(document_xml.as_bytes()).unwrap();

    zip.start_file("docProps/core.xml", options).unwrap();
    zip.write_all(core_xml.as_bytes()).unwrap();

    zip.finish().unwrap().into_inner()
  }

  fn simple_para(text: &str) -> String {
    format!(r#"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"#)
  }

  fn heading_para(text: &str, level: u8) -> String {
    format!(r#"<w:p><w:pPr><w:pStyle w:val="Heading{level}"/></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>"#)
  }

  fn wrap_body(content: &str) -> String {
    format!(
      r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    {content}
  </w:body>
</w:document>"#
    )
  }

  #[test]
  fn parse_empty_docx_returns_no_content() {
    let xml = wrap_body("");
    let data = make_docx(&xml);
    let result = parse_docx(&data);
    assert!(
      matches!(result, Err(PipelineError::NoContent)),
      "expected NoContent for empty DOCX, got: {result:?}"
    );
  }

  #[test]
  fn parse_single_paragraph() {
    let xml = wrap_body(&simple_para("Hello from DOCX"));
    let data = make_docx(&xml);
    let doc = parse_docx(&data).unwrap();

    assert_eq!(doc.format, DocumentFormat::Docx);
    assert!(!doc.chunks.is_empty());
    assert!(doc.text.contains("Hello from DOCX"));
    assert_eq!(doc.chunks[0].chunk_type, ChunkType::Text);
  }

  #[test]
  fn parse_heading_and_paragraph() {
    let content = format!("{}{}", heading_para("My Title", 1), simple_para("Body text here."));
    let xml = wrap_body(&content);
    let data = make_docx(&xml);
    let doc = parse_docx(&data).unwrap();

    assert_eq!(doc.chunks.len(), 2);
    assert_eq!(doc.chunks[0].chunk_type, ChunkType::Heading);
    assert!(doc.chunks[0].content.contains("My Title"));
    assert_eq!(doc.chunks[1].chunk_type, ChunkType::Text);
    assert!(doc.chunks[1].content.contains("Body text here."));

    // Title extracted from first heading.
    assert_eq!(doc.title, Some("My Title".to_string()));
  }

  #[test]
  fn parse_multiple_heading_levels() {
    let content = format!(
      "{}{}{}",
      heading_para("Chapter", 1),
      heading_para("Section", 2),
      heading_para("Subsection", 3),
    );
    let xml = wrap_body(&content);
    let data = make_docx(&xml);
    let doc = parse_docx(&data).unwrap();

    assert_eq!(doc.chunks.len(), 3);
    // All should be headings.
    for chunk in &doc.chunks {
      assert_eq!(chunk.chunk_type, ChunkType::Heading);
    }
    assert!(doc.chunks[0].content.contains("# Chapter"));
    assert!(doc.chunks[1].content.contains("## Section"));
    assert!(doc.chunks[2].content.contains("### Subsection"));
  }

  #[test]
  fn parse_table() {
    let table_xml = r#"<w:tbl>
            <w:tr>
                <w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc>
            </w:tr>
            <w:tr>
                <w:tc><w:p><w:r><w:t>Alice</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc>
            </w:tr>
        </w:tbl>"#;
    let xml = wrap_body(table_xml);
    let data = make_docx(&xml);
    let doc = parse_docx(&data).unwrap();

    let table_chunks: Vec<_> = doc.chunks.iter().filter(|c| c.chunk_type == ChunkType::Table).collect();
    assert!(!table_chunks.is_empty(), "should have at least one table chunk");
    assert!(table_chunks[0].content.contains("Name"));
    assert!(table_chunks[0].content.contains("Alice"));
    assert!(table_chunks[0].content.contains("|"));
  }

  #[test]
  fn parse_with_metadata() {
    let doc_xml = wrap_body(&simple_para("Research &amp; development &#x26; operations &unknown;"));
    let core_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Document &amp; Notes</dc:title>
  <dc:creator>Test &#65;uthor</dc:creator>
  <dc:description>A test document</dc:description>
</cp:coreProperties>"#;
    let data = make_docx_with_metadata(&doc_xml, core_xml);
    let doc = parse_docx(&data).unwrap();

    // Metadata title should be preferred.
    assert_eq!(doc.title, Some("Document & Notes".to_string()));
    assert_eq!(doc.metadata.get("creator").map(String::as_str), Some("Test Author"));
    assert!(
      doc.text.contains("Research & development & operations &unknown;"),
      "predefined and numeric entities must decode while unknown entities remain visible"
    );
  }

  #[test]
  fn parse_garbage_bytes_returns_error() {
    let result = parse_docx(b"this is not a DOCX file");
    assert!(result.is_err());
  }

  #[test]
  fn heading_level_parsing() {
    assert_eq!(parse_heading_level("Heading1"), Some(1));
    assert_eq!(parse_heading_level("Heading 2"), Some(2));
    assert_eq!(parse_heading_level("heading3"), Some(3));
    assert_eq!(parse_heading_level("Title"), Some(1));
    assert_eq!(parse_heading_level("Subtitle"), Some(2));
    assert_eq!(parse_heading_level("Normal"), None);
    assert_eq!(parse_heading_level("Heading0"), None);
    assert_eq!(parse_heading_level("Heading10"), None);
  }
}
