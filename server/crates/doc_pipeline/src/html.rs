//! HTML parser with readability-based article extraction.
//!
//! Combines three strategies to extract clean text from HTML:
//! 1. **Metadata extraction** via [`scraper`] — title, description, author,
//!    Open Graph tags, language.
//! 2. **Article extraction** via [`readability`] — isolates main content from
//!    navigation, ads, and boilerplate (best for web articles).
//! 3. **Fallback rendering** via [`html2text`] — converts general HTML to
//!    readable plain text (best for docs, READMEs, simple pages).
//!
//! The parser tries readability first; if the extracted content is too short
//! or empty, it falls back to `html2text`.

use std::collections::HashMap;

use crate::error::{PipelineError, Result};
use crate::types::{ChunkType, DocumentFormat, ParsedDocument, TextChunk};

/// Minimum character count for readability output to be considered useful.
/// Below this threshold we fall back to `html2text`.
const READABILITY_MIN_LENGTH: usize = 50;

/// Default column width for `html2text` rendering.
const HTML2TEXT_COLUMNS: usize = 80;

/// Parse an HTML document from raw bytes.
///
/// # Arguments
/// * `data` — Raw HTML bytes (UTF-8 or Latin-1; non-UTF-8 is handled via
///   lossy conversion).
/// * `source_url` — Optional URL the HTML was fetched from. Used by the
///   readability extractor for resolving relative links and scoring.
///
/// # Behaviour
/// 1. Extracts metadata (title, description, author, language) using CSS
///    selectors.
/// 2. Attempts article extraction via `readability::extractor::extract`.
/// 3. If readability yields insufficient text, falls back to `html2text`.
/// 4. Produces one metadata chunk (if metadata was found) plus one content
///    chunk.
///
/// # Errors
/// - [`PipelineError::ParseError`] if the HTML is fundamentally unprocessable.
/// - [`PipelineError::NoContent`] if no text could be extracted.
#[tracing::instrument(skip(data), fields(data_len = data.len(), source_url))]
pub fn parse_html(data: &[u8], source_url: Option<&str>) -> Result<ParsedDocument> {
  let html_str = String::from_utf8_lossy(data);

  if html_str.trim().is_empty() {
    return Err(PipelineError::NoContent);
  }

  // --- 1. Extract metadata via scraper ------------------------------------
  let metadata = extract_html_metadata(&html_str);
  let title = resolve_title(&metadata);
  tracing::debug!(title = ?title, meta_keys = ?metadata.keys().collect::<Vec<_>>(), "extracted HTML metadata");

  // --- 2. Try readability for article content -----------------------------
  let (text, extraction_method) = match extract_article(&html_str, source_url) {
    Ok(article_text) if article_text.len() >= READABILITY_MIN_LENGTH => {
      tracing::debug!(text_len = article_text.len(), "readability extraction succeeded");
      (article_text, "readability")
    }
    Ok(short) => {
      tracing::debug!(
        text_len = short.len(),
        "readability output too short, falling back to html2text"
      );
      let fallback = extract_via_html2text(data);
      if fallback.trim().len() >= short.len() {
        (fallback, "html2text")
      } else if !short.is_empty() {
        (short, "readability")
      } else {
        (fallback, "html2text")
      }
    }
    Err(e) => {
      tracing::debug!(error = %e, "readability failed, falling back to html2text");
      (extract_via_html2text(data), "html2text")
    }
  };

  let trimmed = text.trim();
  if trimmed.is_empty() {
    tracing::warn!("HTML contained no extractable text");
    return Err(PipelineError::NoContent);
  }

  // --- 3. Build chunks ----------------------------------------------------
  let mut full_text = String::new();
  let mut chunks = Vec::new();
  let mut chunk_index: usize = 0;

  // Metadata chunk (if we have any metadata beyond the title).
  let meta_display = format_metadata(&metadata);
  if !meta_display.is_empty() {
    let start = full_text.len();
    full_text.push_str(&meta_display);
    let end = full_text.len();
    chunks.push(TextChunk {
      content: meta_display,
      index: chunk_index,
      start_offset: Some(start),
      end_offset: Some(end),
      token_count: None,
      chunk_type: ChunkType::Metadata,
    });
    chunk_index += 1;
  }

  // Main content chunk.
  let start = full_text.len();
  if !full_text.is_empty() {
    full_text.push('\n');
  }
  full_text.push_str(trimmed);
  let end = full_text.len();

  chunks.push(TextChunk {
    content: trimmed.to_string(),
    index: chunk_index,
    start_offset: Some(start),
    end_offset: Some(end),
    token_count: None,
    chunk_type: ChunkType::Text,
  });

  tracing::info!(
      chunks = chunks.len(),
      text_bytes = full_text.len(),
      extraction_method,
      title = ?title,
      "HTML parsed successfully"
  );

  Ok(ParsedDocument {
    title,
    text: full_text,
    chunks,
    metadata,
    language: metadata_language(&html_str),
    format: DocumentFormat::Html,
    page_count: None,
  })
}

// ---------------------------------------------------------------------------
// Metadata extraction (scraper)
// ---------------------------------------------------------------------------

/// Structured metadata extracted from HTML `<head>`.
fn extract_html_metadata(html: &str) -> HashMap<String, String> {
  let mut meta = HashMap::new();

  let document = scraper::Html::parse_document(html);

  // <title> tag
  if let Ok(sel) = scraper::Selector::parse("title")
    && let Some(el) = document.select(&sel).next()
  {
    let title = el.text().collect::<String>();
    let title = title.trim().to_string();
    if !title.is_empty() {
      meta.insert("title".to_string(), title);
    }
  }

  // <meta name="description">
  extract_meta_attr(
    &document,
    "meta[name=\"description\"]",
    "content",
    "description",
    &mut meta,
  );

  // <meta property="og:title">
  extract_meta_attr(
    &document,
    "meta[property=\"og:title\"]",
    "content",
    "og_title",
    &mut meta,
  );

  // <meta property="og:description">
  extract_meta_attr(
    &document,
    "meta[property=\"og:description\"]",
    "content",
    "og_description",
    &mut meta,
  );

  // <meta name="author">
  extract_meta_attr(&document, "meta[name=\"author\"]", "content", "author", &mut meta);

  // <meta name="keywords">
  extract_meta_attr(&document, "meta[name=\"keywords\"]", "content", "keywords", &mut meta);

  // <html lang="...">
  if let Ok(sel) = scraper::Selector::parse("html")
    && let Some(el) = document.select(&sel).next()
    && let Some(lang) = el.value().attr("lang")
  {
    let lang = lang.trim().to_string();
    if !lang.is_empty() {
      meta.insert("language".to_string(), lang);
    }
  }

  meta
}

/// Helper: extract an attribute value from the first element matching a CSS
/// selector and insert it into the metadata map.
fn extract_meta_attr(
  document: &scraper::Html,
  css_selector: &str,
  attr_name: &str,
  meta_key: &str,
  meta: &mut HashMap<String, String>,
) {
  if let Ok(sel) = scraper::Selector::parse(css_selector)
    && let Some(el) = document.select(&sel).next()
    && let Some(val) = el.value().attr(attr_name)
  {
    let val = val.trim().to_string();
    if !val.is_empty() {
      meta.insert(meta_key.to_string(), val);
    }
  }
}

/// Determine the best title from extracted metadata.
fn resolve_title(metadata: &HashMap<String, String>) -> Option<String> {
  // Prefer og:title (usually cleaner), then <title>.
  metadata.get("og_title").or_else(|| metadata.get("title")).cloned()
}

/// Extract language from `<html lang="...">`.
fn metadata_language(html: &str) -> Option<String> {
  let document = scraper::Html::parse_document(html);
  let sel = scraper::Selector::parse("html").ok()?;
  let el = document.select(&sel).next()?;
  let lang = el.value().attr("lang")?.trim().to_string();
  if lang.is_empty() { None } else { Some(lang) }
}

// ---------------------------------------------------------------------------
// Article extraction (readability)
// ---------------------------------------------------------------------------

/// Try to extract the main article content using the readability algorithm.
///
/// Returns the plain-text version of the article, or an error if extraction
/// fails.
fn extract_article(html: &str, source_url: Option<&str>) -> std::result::Result<String, String> {
  let url_str = source_url.unwrap_or("https://example.com/document");
  let url = url::Url::parse(url_str).map_err(|e| format!("invalid URL: {e}"))?;

  let mut cursor = std::io::Cursor::new(html.as_bytes());
  let product =
    readability::extractor::extract(&mut cursor, &url).map_err(|e| format!("readability extraction failed: {e}"))?;

  // readability returns both `content` (HTML) and `text` (plain text).
  // We prefer the plain text version.
  let text = product.text.trim().to_string();
  Ok(text)
}

// ---------------------------------------------------------------------------
// Fallback rendering (html2text)
// ---------------------------------------------------------------------------

/// Convert HTML to plain text using `html2text`.
fn extract_via_html2text(data: &[u8]) -> String {
  match html2text::from_read(data, HTML2TEXT_COLUMNS) {
    Ok(text) => text,
    Err(e) => {
      tracing::warn!(error = %e, "html2text conversion failed");
      String::new()
    }
  }
}

// ---------------------------------------------------------------------------
// Metadata formatting
// ---------------------------------------------------------------------------

/// Format metadata key-value pairs as a human-readable text block.
fn format_metadata(metadata: &HashMap<String, String>) -> String {
  // Only include metadata that adds information beyond the title.
  let display_keys = ["author", "description", "keywords", "language"];
  let mut lines = Vec::new();
  for key in &display_keys {
    if let Some(val) = metadata.get(*key) {
      lines.push(format!("{key}: {val}"));
    }
  }
  lines.join("\n")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parse_simple_html_page() {
    let html = br#"<!DOCTYPE html>
<html lang="en">
<head>
    <title>Test Page</title>
    <meta name="description" content="A test document">
    <meta name="author" content="Alice">
</head>
<body>
    <h1>Welcome</h1>
    <p>This is a simple test page with some content for extraction.</p>
    <p>It has multiple paragraphs to ensure adequate length for readability.</p>
    <p>The content should be extracted cleanly without navigation elements.</p>
</body>
</html>"#;

    let doc = parse_html(html, None).unwrap();
    assert_eq!(doc.format, DocumentFormat::Html);
    assert!(doc.title.is_some(), "should extract a title");

    // The title should be either "Test Page" or extracted from content.
    let title = doc.title.unwrap();
    assert!(
      title.contains("Test Page"),
      "title should contain 'Test Page', got: {title:?}"
    );

    // Should have extracted text content.
    assert!(doc.text.contains("simple test page"));
    assert!(!doc.chunks.is_empty());

    // Metadata should include author.
    assert_eq!(doc.metadata.get("author").map(String::as_str), Some("Alice"));
    assert_eq!(
      doc.metadata.get("description").map(String::as_str),
      Some("A test document")
    );
  }

  #[test]
  fn parse_html_without_head() {
    let html = b"<p>Just a paragraph with no head element at all.</p>";
    let doc = parse_html(html, None).unwrap();
    assert!(doc.text.contains("Just a paragraph"));
    assert_eq!(doc.title, None);
  }

  #[test]
  fn parse_html_plain_text() {
    let html = b"Hello world, no HTML tags here at all but enough text.";
    let doc = parse_html(html, None).unwrap();
    assert!(doc.text.contains("Hello world"));
  }

  #[test]
  fn parse_empty_html_returns_no_content() {
    let result = parse_html(b"", None);
    assert!(
      matches!(result, Err(PipelineError::NoContent)),
      "expected NoContent for empty HTML, got: {result:?}"
    );
  }

  #[test]
  fn parse_whitespace_only_returns_no_content() {
    let result = parse_html(b"   \n  \t  ", None);
    assert!(matches!(result, Err(PipelineError::NoContent)));
  }

  #[test]
  fn parse_html_with_article_and_nav() {
    let html = br#"<!DOCTYPE html>
<html>
<head><title>Blog Post</title></head>
<body>
    <nav>
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
    </nav>
    <article>
        <h1>Important Article</h1>
        <p>This is the main content of the article that should be extracted
        by the readability algorithm. It needs to be reasonably long so that
        the readability heuristics consider it substantial content rather
        than boilerplate navigation text.</p>
        <p>Second paragraph with more substantial content about the topic
        at hand. The readability algorithm uses content density to determine
        what the main article text is.</p>
        <p>Third paragraph ensuring sufficient content density for the
        readability scoring algorithm to identify this as the article body.</p>
    </article>
    <footer>
        <p>Copyright 2025</p>
        <a href="/privacy">Privacy</a>
    </footer>
</body>
</html>"#;

    let doc = parse_html(html, Some("https://example.com/blog/post")).unwrap();

    // Should have extracted article content.
    assert!(
      doc.text.contains("Important Article") || doc.text.contains("main content"),
      "should extract article body, got: {:?}",
      &doc.text[..doc.text.len().min(200)]
    );
  }

  #[test]
  fn parse_html_metadata_extraction() {
    let html = br#"<!DOCTYPE html>
<html lang="de">
<head>
    <title>Deutsche Seite</title>
    <meta name="description" content="Eine Testseite">
    <meta property="og:title" content="OG Title">
    <meta name="keywords" content="test, example">
</head>
<body>
    <p>Inhalt der Seite mit ausreichend Text fuer die Extraktion.</p>
</body>
</html>"#;

    let doc = parse_html(html, None).unwrap();

    // og:title should be preferred over <title>.
    assert_eq!(doc.title, Some("OG Title".to_string()));

    // Language detection.
    assert_eq!(doc.language, Some("de".to_string()));

    // Metadata map.
    assert_eq!(
      doc.metadata.get("description").map(String::as_str),
      Some("Eine Testseite")
    );
    assert_eq!(doc.metadata.get("og_title").map(String::as_str), Some("OG Title"));
    assert_eq!(doc.metadata.get("keywords").map(String::as_str), Some("test, example"));
    assert_eq!(doc.metadata.get("language").map(String::as_str), Some("de"));
  }

  #[test]
  fn parse_html_with_source_url() {
    let html = br#"<html><body>
        <p>Content with enough text to pass the readability minimum threshold for extraction purposes.</p>
        </body></html>"#;
    let doc = parse_html(html, Some("https://example.com/page")).unwrap();
    assert!(!doc.text.is_empty());
  }

  #[test]
  fn extract_meta_helper() {
    let html = r#"<html><head><meta name="test" content="value123"></head><body></body></html>"#;
    let document = scraper::Html::parse_document(html);
    let mut meta = HashMap::new();
    extract_meta_attr(&document, "meta[name=\"test\"]", "content", "test_key", &mut meta);
    assert_eq!(meta.get("test_key").map(String::as_str), Some("value123"));
  }
}
