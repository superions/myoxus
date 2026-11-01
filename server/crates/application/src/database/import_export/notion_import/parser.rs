// SPDX-License-Identifier: AGPL-3.0-or-later
//! Notion HTML / ZIP parser (P-DB-29).
//!
//! This module is the only piece of code that knows how to turn a Notion
//! export ZIP or a Notion HTML page into a neutral
//! [`crate::database::notion_import::NotionDocument`]. It is intentionally
//! dependency-light: `quick-xml` for the HTML walk, `zip` for the archive,
//! `url` for asset URL parsing, and the domain types.
//!
//! ## What the parser knows
//!
//! Notion's HTML export is consistent: each Notion page is a single HTML
//! file in the ZIP, and Notion databases are encoded as pages that
//! contain a `<table class="collection-content">` element where the
//! first row lists the column headers (`<th>` cells with the property
//! names and the original Notion kind encoded as `data-property-type`)
//! and the remaining rows are the data rows.
//!
//! The parser is robust against the legitimate quirks of the export:
//!
//! * The header row may contain a `<svg>` icon for each column; we
//!   ignore those and use the `<th>` text and `data-property-type`.
//! * Multi-line cells may include nested `<p>`, `<span>`,
//!   `<ul>`, `<ol>` elements; we collapse nested whitespace using a
//!   small helper.
//! * Asset references in `Files` cells are typically Notion-relative
//!   paths inside the ZIP; we capture them as-is so the snapshot
//!   adapter can decide whether to materialise them as workspace
//!   blobs.
//! * Sub-pages inside Notion databases are represented as a row
//!   pointing to the sub-page HTML; the parser follows the link
//!   metadata but does not recurse (sub-page import is reported as a
//!   `DroppedInlineDatabase` diagnostic so the user can opt in to
//!   re-importing them as a separate Database later).
//!
//! ## What the parser does NOT do
//!
//! * **No console logging.** Every diagnostic flows through
//!   [`NotionDiagnostic`]; tests assert against the diagnostic list.
//! * **No editor-runtime side-effects.** The parser does not call into
//!   any UI / Yjs / Collection code; everything is in-memory.
//! * **No `unsafe`.** The code only walks the parsed DOM and reads text
//!   nodes, never indexes into a raw buffer.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;

use quick_xml::XmlVersion;
use quick_xml::events::{BytesStart, BytesText, Event};
use quick_xml::reader::Reader;
use tracing::{debug, instrument};
use uuid::Uuid;

use super::body::{extract_page_body, extract_page_title};
use super::{
  NotionDiagnostic, NotionDiagnosticCode, NotionDiagnosticSeverity, NotionDocument, NotionParseResult, NotionProperty,
  NotionPropertyKind, NotionRichTextInline, NotionRichTextMark, NotionRow, NotionSource,
};

/// Hard cap on the size of any single HTML file we parse. The Notion
/// export rarely produces pages bigger than a few hundred KB; we cap at
/// 8 MiB to keep the parser bounded.
const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;

/// Hard cap on the cumulative uncompressed bytes we read out of a ZIP.
/// Notion exports usually sit well under 256 MiB; we cap at 512 MiB to
/// leave room for asset attachments.
const MAX_ZIP_BYTES: usize = 512 * 1024 * 1024;

/// Hard cap on the number of rows per parsed database. Mirrors the
/// `csv_max_rows` limit so a runaway Notion export cannot bypass the
/// existing CSV-import guard rails.
const MAX_ROWS_PER_DATABASE: usize = 50_000;

/// Hard cap on the size of any single asset entry materialised from the
/// ZIP. Notion file attachments are typically well under 25 MiB; we cap
/// at 64 MiB so a pathological archive cannot exhaust server memory
/// during preview / apply.
const MAX_ASSET_BYTES: usize = 64 * 1024 * 1024;

/// Parse a Notion export ZIP. The ZIP is expected to contain Notion
/// HTML pages; this function finds the database pages (those with a
/// `<table class="collection-content">`) and projects them into
/// [`NotionDocument`]s.
///
/// All HTML files that are *not* databases are still walked so we can
/// resolve page mentions; unresolved mentions surface as
/// `DroppedPageMention` diagnostics on the database they originated
/// from.
#[instrument(skip(content), fields(input_bytes = content.len()))]
pub fn parse_notion_zip(content: &[u8]) -> NotionParseResult {
  let mut diagnostics: Vec<NotionDiagnostic> = Vec::new();
  let cursor = std::io::Cursor::new(content);
  let mut archive = match zip::ZipArchive::new(cursor) {
    Ok(archive) => archive,
    Err(error) => {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::ZipParseFailed,
        NotionDiagnosticSeverity::Error,
        "$.archive",
        format!("Could not open ZIP archive: {error}"),
      ));
      return NotionParseResult {
        databases: Vec::new(),
        diagnostics,
        source: NotionSource::Zip,
        assets: BTreeMap::new(),
      };
    }
  };

  // First pass: collect every HTML entry path → (page_id, page_title).
  // We use this lookup to detect cross-page mentions and to flag
  // missing references. The page_id is derived from the Notion UUID
  // prefix in the file name (Notion exports pages with names like
  // `My Page abc123def45678901234567890abcdef.html`).
  let mut total_bytes = 0usize;
  let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
  let mut assets: BTreeMap<String, Vec<u8>> = BTreeMap::new();
  for index in 0..archive.len() {
    let Ok(mut file) = archive.by_index(index) else {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::ZipParseFailed,
        NotionDiagnosticSeverity::Warning,
        format!("$.archive.entries[{index}]"),
        "Could not read ZIP entry",
      ));
      continue;
    };
    let path = match file.name() {
      Ok(name) => name.into_owned(),
      Err(_) => {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::ZipParseFailed,
          NotionDiagnosticSeverity::Warning,
          format!("$.archive.entries[{index}]"),
          "Could not decode ZIP entry name",
        ));
        continue;
      }
    };
    // Reject directory entries and absolute / traversal paths before
    // we touch the bytes: a Notion export never carries either, and
    // accepting them would let a crafted archive overwrite workspace
    // paths during asset materialisation.
    if path.ends_with('/') || path.contains("..") || path.starts_with('/') {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::AssetRejected,
        NotionDiagnosticSeverity::Warning,
        format!("$.archive.entries[{index}]"),
        format!("Notion ZIP entry '{path}' has an unsafe path and was skipped"),
      ));
      continue;
    }
    if !is_notion_html_path(&path) {
      // Non-HTML entries are candidates for asset materialisation.
      // Read them now while we have the archive open; the total byte
      // counter keeps the cumulative memory footprint bounded.
      let mut buffer = Vec::new();
      if let Err(error) = file.read_to_end(&mut buffer) {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::AssetRejected,
          NotionDiagnosticSeverity::Warning,
          format!("$.archive.entries[{index}]"),
          format!("Could not read ZIP entry body for asset '{path}': {error}"),
        ));
        continue;
      }
      if buffer.len() > MAX_ASSET_BYTES {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::AssetRejected,
          NotionDiagnosticSeverity::Warning,
          format!("$.archive.entries[{index}]"),
          format!(
            "Notion ZIP asset '{path}' is {} bytes; skipping because it exceeds the per-asset cap of {} bytes",
            buffer.len(),
            MAX_ASSET_BYTES
          ),
        ));
        continue;
      }
      total_bytes = total_bytes.saturating_add(buffer.len());
      if total_bytes > MAX_ZIP_BYTES {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::Unsupported,
          NotionDiagnosticSeverity::Error,
          "$.archive",
          format!("ZIP exceeds {MAX_ZIP_BYTES} bytes; import aborted"),
        ));
        break;
      }
      assets.insert(path, buffer);
      continue;
    }
    let mut buffer = Vec::new();
    if let Err(error) = file.read_to_end(&mut buffer) {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::ZipParseFailed,
        NotionDiagnosticSeverity::Warning,
        format!("$.archive.entries[{index}]"),
        format!("Could not read ZIP entry body: {error}"),
      ));
      continue;
    }
    total_bytes = total_bytes.saturating_add(buffer.len());
    if total_bytes > MAX_ZIP_BYTES {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::Unsupported,
        NotionDiagnosticSeverity::Error,
        "$.archive",
        format!("ZIP exceeds {MAX_ZIP_BYTES} bytes; import aborted"),
      ));
      break;
    }
    entries.push((path, buffer));
  }

  // Build the complete page index before parsing a database. Notion allows a
  // row to link forward to a page that appears later in the ZIP, so resolving
  // while walking entries would make fidelity depend on archive ordering.
  let mut page_titles: BTreeMap<String, String> = BTreeMap::new();
  let mut page_bodies: BTreeMap<String, Vec<super::NotionPageBody>> = BTreeMap::new();
  for (path, body) in &entries {
    if body.len() > MAX_HTML_BYTES {
      continue;
    }
    let html = String::from_utf8_lossy(body);
    let page_id = derive_page_id_from_path(path);
    if let Some(title) = extract_page_title(&html) {
      page_titles.insert(page_id.clone(), title);
    }
    page_bodies
      .entry(page_id)
      .or_default()
      .push(extract_page_body(path, &html));
  }

  // Second pass: parse only the existing database representation, then attach
  // the bounded body fragment by normalized archive id. This deliberately does
  // not add another ZIP walk or a title-based fallback.
  let mut databases: Vec<NotionDocument> = Vec::new();
  for (path, body) in &entries {
    if body.len() > MAX_HTML_BYTES {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::Unsupported,
        NotionDiagnosticSeverity::Warning,
        format!("$.archive.entries[{}]", path),
        format!("Page exceeds {MAX_HTML_BYTES} bytes; skipping"),
      ));
      continue;
    }
    let html = String::from_utf8_lossy(body);
    let page_id = derive_page_id_from_path(path);
    let (page_databases, title) = parse_notion_html_page(&html, &page_id, &page_titles, &mut diagnostics);
    if !page_databases.is_empty() {
      databases.extend(page_databases);
    } else if let Some(title) = title {
      page_titles.entry(page_id).or_insert(title);
    }
  }

  for database in &mut databases {
    for (row_index, row) in database.rows.iter_mut().enumerate() {
      let path = format!("$.database[{}].rows[{row_index}].pageBody", database.database_id);
      match page_bodies.get(row.page_id.as_str()).map(Vec::as_slice) {
        Some([body]) => row.page_body = Some(body.clone()),
        Some(entries) if entries.len() > 1 => diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::PageBodyAmbiguous,
          NotionDiagnosticSeverity::Warning,
          path,
          format!(
            "{} archive entries resolve to normalized Page id '{}'; no body was attached",
            entries.len(),
            row.page_id
          ),
        )),
        _ => diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::PageBodyMissing,
          NotionDiagnosticSeverity::Info,
          path,
          format!("No archive Page body matches normalized Page id '{}'", row.page_id),
        )),
      }
    }
  }

  if databases.is_empty() {
    diagnostics.push(NotionDiagnostic::new(
      NotionDiagnosticCode::Unsupported,
      NotionDiagnosticSeverity::Error,
      "$.archive",
      "Notion archive contained no database pages",
    ));
  } else {
    for database in &databases {
      if database.rows.len() > MAX_ROWS_PER_DATABASE {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::Unsupported,
          NotionDiagnosticSeverity::Warning,
          format!("$.database[{}]", database.title),
          format!(
            "Database contains {} rows; truncated to {MAX_ROWS_PER_DATABASE}",
            database.rows.len()
          ),
        ));
      }
    }
  }

  debug!(
    databases = databases.len(),
    diagnostics = diagnostics.len(),
    assets = assets.len(),
    entries = entries.len(),
    total_bytes,
    "notion zip parse complete"
  );
  NotionParseResult {
    databases,
    diagnostics,
    source: NotionSource::Zip,
    assets,
  }
}

/// Parse a single Notion HTML page. Returns:
/// * a vec of databases extracted from the page (zero or more
///   `<table class="collection-content">` tables);
/// * the page title if one was found.
///
/// This split keeps the call site straight-line and avoids
/// double-borrowing the diagnostic buffer.
fn parse_notion_html_page(
  html: &str,
  page_id: &str,
  page_titles: &BTreeMap<String, String>,
  diagnostics: &mut Vec<NotionDiagnostic>,
) -> (Vec<NotionDocument>, Option<String>) {
  let mut reader = Reader::from_str(html);
  // Whitespace-only nodes between inline marks carry real word boundaries in
  // Notion cells. Structural whitespace is ignored by `handle_text` unless a
  // data cell is open, while scalar coercion continues to trim at its boundary.
  reader.config_mut().trim_text(false);
  let mut buf = Vec::new();

  // Track the current element depth, the open tag's class hint, and
  // an output stack of partial text fragments. We deliberately use a
  // tiny state machine rather than a full DOM tree to keep the parser
  // allocation-light.
  let mut path_stack: Vec<String> = Vec::new();
  let mut class_stack: Vec<Option<String>> = Vec::new();
  let mut text_stack: Vec<String> = Vec::new();
  let mut page_title: Option<String> = None;

  // Database detection: a stack of pending databases. A page can hold
  // multiple `<table class="collection-content">` tables (Notion
  // exports pack related databases into the same HTML file), so we
  // finalise the current one when its closing `</table>` arrives.
  let mut pending_databases: Vec<PendingDatabase> = Vec::new();
  let mut finalised_databases: Vec<NotionDocument> = Vec::new();

  loop {
    match reader.read_event_into(&mut buf) {
      Err(error) => {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::HtmlParseFailed,
          NotionDiagnosticSeverity::Error,
          format!("$.html[{page_id}]"),
          format!("HTML parse error at byte {}: {error}", reader.buffer_position()),
        ));
        break;
      }
      Ok(Event::Eof) => break,
      Ok(Event::Start(start)) => {
        let tag = String::from_utf8_lossy(start.name().as_ref()).to_string();
        let class = read_class_attribute(&start);
        path_stack.push(tag.clone());
        class_stack.push(class.clone());
        text_stack.push(String::new());
        // Opening a new collection table pushes a fresh PendingDatabase
        // onto the stack. Nested tables inside a cell would be unusual
        // for Notion exports; we treat them as if they did not exist
        // (they will be visible as inner HTML but no row data is
        // captured for them).
        if tag == "table" && class.as_deref() == Some("collection-content") {
          // Finalise any database we were still holding; another table
          // follows and the previous one was implicitly complete.
          if let Some(pending) = pending_databases.pop()
            && let Some(finalised) = pending.into_document(diagnostics)
          {
            finalised_databases.push(finalised);
          }
          let mut new_pending = PendingDatabase::new(page_id.to_string());
          // Propagate the page-level <title> text (set when the
          // closing </title> tag was processed) into the next
          // database. This makes the export round-trip preserve the
          // original database title when the Notion export bundle
          // wrote `<head><title>My Tasks</title></head>` before the
          // first `<table>` element.
          if let Some(ref t) = page_title
            && new_pending.title.is_empty()
          {
            new_pending.title = t.clone();
          }
          pending_databases.push(new_pending);
        }
        let active_index = if pending_databases.is_empty() {
          None
        } else {
          Some(pending_databases.len() - 1)
        };
        if let Some(index) = active_index {
          let pending = pending_databases.get_mut(index).expect("active database");
          pending.handle_open(&tag, class.as_deref(), &start, &path_stack);
        }
      }
      Ok(Event::End(_)) => {
        let tag = path_stack.pop().unwrap_or_default();
        let class = class_stack.pop().unwrap_or_default();
        let text = text_stack.pop().unwrap_or_default();
        let closing_table =
          tag == "table" && class.as_deref() == Some("collection-content") && !pending_databases.is_empty();
        if let Some(index) = if pending_databases.is_empty() {
          None
        } else {
          Some(pending_databases.len() - 1)
        } {
          let pending = pending_databases.get_mut(index).expect("active database");
          pending.handle_close(&tag, class.as_deref(), &text, &path_stack, page_titles, diagnostics);
        }
        if closing_table
          && let Some(pending) = pending_databases.pop()
          && let Some(finalised) = pending.into_document(diagnostics)
        {
          finalised_databases.push(finalised);
        }
        if tag == "title" && page_title.is_none() {
          let trimmed = text.trim();
          if !trimmed.is_empty() {
            page_title = Some(trimmed.to_string());
            let _ = page_id;
            // P-DB-29 export round-trip: when a `<title>` tag appears
            // before the first database table is opened, propagate
            // it into the active (or next) PendingDatabase so the
            // NotionDocument carries the page title. The export
            // adapter writes `<title>` so re-imports preserve the
            // original database title.
            if let Some(pending) = pending_databases.last_mut()
              && pending.title.is_empty()
            {
              pending.title = trimmed.to_string();
            }
          }
        }
      }
      Ok(Event::Empty(start)) => {
        let tag = String::from_utf8_lossy(start.name().as_ref()).to_string();
        let class = read_class_attribute(&start);
        // An Empty event represents <foo ... /> with no content. The
        // only one we care about for database detection is the table
        // marker itself.
        if tag == "table" && class.as_deref() == Some("collection-content") {
          if let Some(pending) = pending_databases.pop()
            && let Some(finalised) = pending.into_document(diagnostics)
          {
            finalised_databases.push(finalised);
          }
          let mut new_pending = PendingDatabase::new(page_id.to_string());
          if let Some(ref t) = page_title
            && new_pending.title.is_empty()
          {
            new_pending.title = t.clone();
          }
          pending_databases.push(new_pending);
        }
        let start_bytes = start;
        let path_snapshot = path_stack.clone();
        // Forward the open/close to the currently-active database so
        // properties like <th ... data-property-name="..." /> are
        // registered as the header column even though they have no
        // text content.
        if let Some(index) = if pending_databases.is_empty() {
          None
        } else {
          Some(pending_databases.len() - 1)
        } {
          let pending = pending_databases.get_mut(index).expect("active database");
          pending.handle_open(&tag, class.as_deref(), &start_bytes, &path_snapshot);
          pending.handle_close(&tag, class.as_deref(), "", &path_snapshot, page_titles, diagnostics);
        }
      }
      Ok(Event::Text(text)) => {
        let chunk = decode_text(&text);
        // Every open ancestor owns the text below it. Keeping the aggregate on
        // each stack frame preserves readable text when Notion wraps content in
        // inline markup instead of leaving it directly under the table cell.
        for aggregate in &mut text_stack {
          aggregate.push_str(&chunk);
        }
        if let Some(pending) = pending_databases.last_mut() {
          pending.handle_text(&chunk);
        }
      }
      Ok(Event::CData(text)) => {
        let chunk = String::from_utf8_lossy(text.as_ref()).to_string();
        for aggregate in &mut text_stack {
          aggregate.push_str(&chunk);
        }
        if let Some(pending) = pending_databases.last_mut() {
          pending.handle_text(&chunk);
        }
      }
      Ok(Event::GeneralRef(reference)) => {
        // quick-xml 0.41 surfaces references as their own bounded event.
        // Resolve character and predefined XML entities explicitly; preserve
        // unknown HTML entities literally instead of expanding declarations.
        let decoded = reference.decode().map(|value| value.into_owned()).unwrap_or_default();
        let chunk = reference
          .resolve_char_ref()
          .ok()
          .flatten()
          .map(|value| value.to_string())
          .or_else(|| quick_xml::escape::resolve_predefined_entity(&decoded).map(str::to_owned))
          .or_else(|| (decoded == "nbsp").then(|| "\u{00a0}".to_owned()))
          .unwrap_or_else(|| format!("&{decoded};"));
        for aggregate in &mut text_stack {
          aggregate.push_str(&chunk);
        }
        if let Some(pending) = pending_databases.last_mut() {
          pending.handle_text(&chunk);
        }
      }
      Ok(Event::Decl(_)) | Ok(Event::Comment(_)) | Ok(Event::PI(_)) | Ok(Event::DocType(_)) => {}
    }
    buf.clear();
  }

  // Any database still open (no closing `</table>` before EOF, or the
  // document itself is malformed) gets one final pass.
  for pending in pending_databases.into_iter() {
    if let Some(finalised) = pending.into_document(diagnostics) {
      finalised_databases.push(finalised);
    }
  }

  // If the page produced no databases and the buffer does not look
  // like an HTML document at all, surface an HtmlParseFailed
  // diagnostic. Quick-xml is lenient — bare punctuation like
  // `"<<<>>>"` parses without complaint — so we have to recognise
  // obvious non-HTML payloads ourselves. This keeps the
  // `[Validation] zip contained invalid HTML` UX honest.
  if finalised_databases.is_empty() && page_title.is_none() {
    let html_lower = html.to_ascii_lowercase();
    let looks_like_html = html_lower.contains("<html")
      || html_lower.contains("<body")
      || html_lower.contains("<table")
      || html_lower.contains("<!doctype");
    if !looks_like_html {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::HtmlParseFailed,
        NotionDiagnosticSeverity::Error,
        format!("$.html[{page_id}]"),
        "Entry does not contain a Notion database table; expected an HTML export page",
      ));
    }
  }

  (finalised_databases, page_title)
}

fn read_class_attribute(start: &BytesStart) -> Option<String> {
  for attribute in start.attributes().flatten() {
    if attribute.key.as_ref() == b"class" {
      return attribute
        .normalized_value(XmlVersion::Implicit1_0)
        .ok()
        .map(|cow| cow.into_owned());
    }
  }
  None
}

fn decode_text(text: &BytesText) -> String {
  text.html_content().map(|cow| cow.into_owned()).unwrap_or_default()
}

fn is_notion_html_path(path: &str) -> bool {
  let lowered = path.to_ascii_lowercase();
  lowered.ends_with(".html") || lowered.ends_with(".htm")
}

pub(super) fn derive_page_id_from_path(path: &str) -> String {
  // Notion export: `Title abc123def45678901234567890abcdef.html`.
  // We strip the directory prefix + `.html` suffix and keep the
  // space-separated token that matches a 32-character hex tail.
  let trimmed = path.trim_end_matches('/');
  let leaf = trimmed.rsplit('/').next().unwrap_or(trimmed);
  let without_ext = leaf
    .strip_suffix(".html")
    .or_else(|| leaf.strip_suffix(".htm"))
    .unwrap_or(leaf);
  // Prefer the 32-hex trailing token if present.
  for token in without_ext.split_whitespace().rev() {
    if token.len() == 32 && token.chars().all(|c| c.is_ascii_hexdigit()) {
      return token.to_ascii_lowercase();
    }
  }
  // Fallback: derive a stable id from the full slug.
  let slug = without_ext
    .chars()
    .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
    .collect::<String>();
  if slug.is_empty() {
    Uuid::new_v4().to_string()
  } else {
    slug
  }
}

// ─────────────────────────────────────────────────────────────────────
// PendingDatabase: state machine for the in-progress parse of a single
// Notion database table.
// ─────────────────────────────────────────────────────────────────────

struct PendingDatabase {
  database_id: String,
  title: String,
  description: Option<String>,
  properties: Vec<NotionProperty>,
  rows: Vec<NotionRow>,
  /// Current row being assembled.
  current_row: Option<PendingRow>,
  /// Current cell being assembled; its column index into `properties`.
  current_cell_index: Option<usize>,
  /// Number of `<tr>` we are currently nested in (to detect header row).
  row_depth: usize,
  /// True once the header row has been parsed; subsequent rows are data.
  header_parsed: bool,
  /// Class stack accumulated so we can detect nested patterns.
  path_stack: Vec<String>,
  active_rich_text_marks: Vec<NotionRichTextMark>,
}

#[derive(Debug, Default)]
struct PendingRow {
  page_id: String,
  page_id_candidates: BTreeSet<String>,
  title: String,
  icon: Option<String>,
  cover_url: Option<String>,
  cells: Vec<NotionProperty>,
}

impl PendingDatabase {
  fn new(database_id: String) -> Self {
    Self {
      database_id,
      title: String::new(),
      description: None,
      properties: Vec::new(),
      rows: Vec::new(),
      current_row: None,
      current_cell_index: None,
      row_depth: 0,
      header_parsed: false,
      path_stack: Vec::new(),
      active_rich_text_marks: Vec::new(),
    }
  }

  fn handle_open(&mut self, tag: &str, class: Option<&str>, start: &BytesStart, path_stack: &[String]) {
    self.path_stack.push(tag.to_string());
    if tag == "tr" {
      self.row_depth += 1;
      // After the header row has been parsed, opening a new <tr>
      // starts a fresh data row.
      if self.header_parsed && self.row_depth == 1 && self.current_row.is_none() {
        self.current_row = Some(PendingRow::default());
        self.current_cell_index = None;
      }
      return;
    }
    if tag == "td" || tag == "th" {
      if !self.header_parsed {
        // Header row: extract column metadata.
        let name = column_display_name(start);
        let kind = read_property_type(start);
        let property = NotionProperty {
          name,
          kind,
          raw_text: None,
          rich_text: Vec::new(),
          rich_text_lossy: false,
          select_options: Vec::new(),
          date_start: None,
          date_end: None,
          number: None,
          checkbox: None,
          relation_targets: Vec::new(),
          rollup_aggregate: None,
          file_paths: Vec::new(),
          url: None,
          email: None,
          phone: None,
          people: Vec::new(),
          tags: Vec::new(),
        };
        self.properties.push(property);
        // Header rows: align with self.properties which is what the
        // closing </th> handler indexes against.
        self.current_cell_index = Some(self.properties.len() - 1);
      } else if self.current_row.is_some() {
        // Data row: bump the column index for each new <td> so that
        // the close handler stores the text into the right slot.
        let column_index = self.current_cell_index.map(|value| value + 1).unwrap_or(0);
        self.current_cell_index = Some(column_index);
        if let Some(row) = self.current_row.as_mut() {
          while row.cells.len() <= column_index {
            row
              .cells
              .push(blank_property_for_index(self.properties.len(), row.cells.len()));
          }
        }
      }
    }
    if tag == "a"
      && let (Some(row), Some(column_index)) = (self.current_row.as_mut(), self.current_cell_index)
      && self
        .properties
        .get(column_index)
        .is_some_and(|property| property.kind == NotionPropertyKind::Title)
      && let Some(page_id) = notion_archive_page_id(start)
    {
      row.page_id_candidates.insert(page_id);
    }
    if self.current_rich_text_property().is_some() {
      if tag == "br" {
        if let Some(property) = self.current_rich_text_property() {
          property.rich_text.push(NotionRichTextInline::HardBreak);
        }
      } else if let Some(mark) = notion_rich_text_mark(tag, start) {
        self.active_rich_text_marks.push(mark);
      } else if (notion_rich_text_unsupported_format_tag(tag) || (tag == "a" && notion_link_href(start).is_some()))
        && let Some(property) = self.current_rich_text_property()
      {
        property.rich_text_lossy = true;
      }
    }
    let _ = class;
    let _ = path_stack;
  }

  fn current_rich_text_property(&mut self) -> Option<&mut NotionProperty> {
    let index = self.current_cell_index?;
    let property = self.current_row.as_mut()?.cells.get_mut(index)?;
    (property.kind == NotionPropertyKind::RichText).then_some(property)
  }

  fn handle_text(&mut self, text: &str) {
    if text.is_empty() || !self.path_stack.iter().any(|tag| tag == "td") {
      return;
    }
    let marks = self.active_rich_text_marks.clone();
    let Some(property) = self.current_rich_text_property() else {
      return;
    };
    if let Some(NotionRichTextInline::Text {
      text: previous,
      marks: previous_marks,
    }) = property.rich_text.last_mut()
      && *previous_marks == marks
    {
      previous.push_str(text);
      return;
    }
    property.rich_text.push(NotionRichTextInline::Text {
      text: text.to_string(),
      marks,
    });
  }

  fn handle_close(
    &mut self,
    tag: &str,
    class: Option<&str>,
    text: &str,
    path_stack: &[String],
    page_titles: &BTreeMap<String, String>,
    diagnostics: &mut Vec<NotionDiagnostic>,
  ) {
    self.path_stack.pop();
    if notion_rich_text_mark_tag(tag) {
      self
        .active_rich_text_marks
        .iter()
        .rposition(|mark| notion_rich_text_mark_matches_tag(mark, tag))
        .map(|index| self.active_rich_text_marks.remove(index));
    }
    if tag == "tr" {
      self.row_depth = self.row_depth.saturating_sub(1);
      if self.row_depth == 0 {
        if !self.header_parsed {
          self.header_parsed = true;
        } else if let Some(row) = self.current_row.take() {
          self.rows.push(PendingRow::into_row(
            row,
            &self.database_id,
            self.rows.len(),
            diagnostics,
          ));
        }
        // Reset the per-row column index so the next <tr>'s first
        // <td> is column 0.
        self.current_cell_index = None;
        self.active_rich_text_marks.clear();
      }
      return;
    }
    if tag == "td" {
      if !self.header_parsed {
        // Header row's column kind may have been updated via
        // `data-property-type`; nothing else to do here.
      } else if let Some(row) = self.current_row.as_mut() {
        let column_index = self.current_cell_index.unwrap_or(0);
        if column_index < self.properties.len() {
          // Stamp the property kind from the header column so the
          // value-applier knows how to coerce the cell text.
          let kind = self.properties[column_index].kind;
          let target = &mut row.cells[column_index];
          if target.kind != kind {
            target.kind = kind;
          }
          target.raw_text = Some(text.to_string());
          apply_cell_value(target, text, path_stack, page_titles, diagnostics);
        }
      }
      self.active_rich_text_marks.clear();
      return;
    }
    if tag == "th" {
      if let Some(property) = self.properties.last_mut() {
        let trimmed = text.trim();
        if !trimmed.is_empty() && property.name.is_empty() {
          property.name = trimmed.to_string();
        }
      }
      return;
    }
    let _ = class;
  }

  fn into_document(mut self, diagnostics: &mut Vec<NotionDiagnostic>) -> Option<NotionDocument> {
    if !self.header_parsed {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::HtmlInvalid,
        NotionDiagnosticSeverity::Warning,
        format!("$.database[{}]", self.database_id),
        "Notion table had no header row; cannot determine columns",
      ));
      return None;
    }
    if self.properties.is_empty() {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::HtmlInvalid,
        NotionDiagnosticSeverity::Warning,
        format!("$.database[{}]", self.database_id),
        "Notion table had no columns",
      ));
      return None;
    }
    // Ensure exactly one Title column (Notion guarantees this).
    let title_count = self
      .properties
      .iter()
      .filter(|p| p.kind == NotionPropertyKind::Title)
      .count();
    if title_count == 0 {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::PropertyDowngraded,
        NotionDiagnosticSeverity::Warning,
        format!("$.database[{}]", self.database_id),
        "Notion database had no title column; first column promoted to title",
      ));
      if let Some(first) = self.properties.first_mut() {
        first.kind = NotionPropertyKind::Title;
      }
    } else if title_count > 1 {
      // Downgrade all but the first Title column to RichText so the
      // snapshot adapter does not have to pick.
      let mut first_seen = false;
      for property in self.properties.iter_mut() {
        if property.kind == NotionPropertyKind::Title {
          if first_seen {
            property.kind = NotionPropertyKind::RichText;
          } else {
            first_seen = true;
          }
        }
      }
    }
    Some(NotionDocument {
      database_id: self.database_id,
      title: if self.title.is_empty() {
        "Untitled Notion database".to_string()
      } else {
        self.title
      },
      description: self.description,
      properties: self.properties,
      rows: self.rows,
    })
  }
}

impl PendingRow {
  fn into_row(mut self, database_id: &str, row_index: usize, diagnostics: &mut Vec<NotionDiagnostic>) -> NotionRow {
    self.page_id = match self.page_id_candidates.len() {
      1 => self.page_id_candidates.pop_first().unwrap_or_default(),
      0 => self.page_id,
      count => {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::PageBodyAmbiguous,
          NotionDiagnosticSeverity::Warning,
          format!("$.database[{database_id}].rows[{row_index}].pageId"),
          format!("Title cell contains {count} different archive Page links; no body was attached"),
        ));
        String::new()
      }
    };
    let title = if self.title.trim().is_empty() {
      // Fallback title: the first cell text or the page id prefix.
      self
        .cells
        .iter()
        .find_map(|cell| cell.raw_text.clone().filter(|t| !t.trim().is_empty()))
        .unwrap_or_else(|| {
          // We avoid importing the id into the title field; instead we
          // use a slug from the page_id so the row is still meaningful.
          self.page_id.chars().take(12).collect::<String>()
        })
    } else {
      self.title
    };
    NotionRow {
      page_id: self.page_id,
      title,
      icon: self.icon,
      cover_url: self.cover_url,
      page_body: None,
      properties: self.cells,
    }
  }
}

fn notion_archive_page_id(start: &BytesStart) -> Option<String> {
  let href = notion_link_href(start)?;
  let lowered = href.to_ascii_lowercase();
  if lowered.starts_with("http://")
    || lowered.starts_with("https://")
    || lowered.starts_with("mailto:")
    || lowered.starts_with('#')
  {
    return None;
  }
  let path = href.split(['?', '#']).next().unwrap_or_default();
  if !is_notion_html_path(path) {
    return None;
  }
  let decoded = urlencoding::decode(path).ok()?;
  Some(derive_page_id_from_path(&decoded))
}

fn blank_property_for_index(_total: usize, index: usize) -> NotionProperty {
  NotionProperty {
    name: format!("Column {index}"),
    kind: if index == 0 {
      NotionPropertyKind::Title
    } else {
      NotionPropertyKind::RichText
    },
    raw_text: None,
    rich_text: Vec::new(),
    rich_text_lossy: false,
    select_options: Vec::new(),
    date_start: None,
    date_end: None,
    number: None,
    checkbox: None,
    relation_targets: Vec::new(),
    rollup_aggregate: None,
    file_paths: Vec::new(),
    url: None,
    email: None,
    phone: None,
    people: Vec::new(),
    tags: Vec::new(),
  }
  .with_kind(if index == 0 {
    NotionPropertyKind::Title
  } else {
    NotionPropertyKind::RichText
  })
}

fn notion_rich_text_mark(tag: &str, start: &BytesStart) -> Option<NotionRichTextMark> {
  match tag {
    "strong" | "b" => Some(NotionRichTextMark::Bold),
    "em" | "i" => Some(NotionRichTextMark::Italic),
    "s" | "del" | "strike" => Some(NotionRichTextMark::Strike),
    "code" => Some(NotionRichTextMark::Code),
    "a" => notion_link_href(start)
      .filter(|href| notion_link_is_supported(href))
      .map(|href| NotionRichTextMark::Link { href }),
    _ => None,
  }
}

fn notion_link_href(start: &BytesStart) -> Option<String> {
  start
    .attributes()
    .flatten()
    .find(|attribute| attribute.key.as_ref() == b"href")
    .and_then(|attribute| attribute.normalized_value(XmlVersion::Implicit1_0).ok())
    .map(|href| href.into_owned())
}

fn notion_link_is_supported(href: &str) -> bool {
  let href = href.to_ascii_lowercase();
  href.starts_with("https://") || href.starts_with("http://") || href.starts_with("mailto:")
}

fn notion_rich_text_unsupported_format_tag(tag: &str) -> bool {
  matches!(tag, "u" | "mark" | "sub" | "sup")
}

fn notion_rich_text_mark_tag(tag: &str) -> bool {
  matches!(tag, "strong" | "b" | "em" | "i" | "s" | "del" | "strike" | "code" | "a")
}

fn notion_rich_text_mark_matches_tag(mark: &NotionRichTextMark, tag: &str) -> bool {
  matches!(
    (mark, tag),
    (NotionRichTextMark::Bold, "strong" | "b")
      | (NotionRichTextMark::Italic, "em" | "i")
      | (NotionRichTextMark::Strike, "s" | "del" | "strike")
      | (NotionRichTextMark::Code, "code")
      | (NotionRichTextMark::Link { .. }, "a")
  )
}

fn column_display_name(start: &BytesStart) -> String {
  for attribute in start.attributes().flatten() {
    if attribute.key.as_ref() == b"data-property-name" {
      return attribute
        .normalized_value(XmlVersion::Implicit1_0)
        .ok()
        .map(|cow| cow.into_owned())
        .unwrap_or_default();
    }
  }
  String::new()
}

fn read_property_type(start: &BytesStart) -> NotionPropertyKind {
  for attribute in start.attributes().flatten() {
    if attribute.key.as_ref() == b"data-property-type"
      && let Ok(decoded) = attribute.normalized_value(XmlVersion::Implicit1_0)
    {
      return notion_kind_from_str(&decoded);
    }
  }
  NotionPropertyKind::RichText
}

fn notion_kind_from_str(value: &str) -> NotionPropertyKind {
  match value {
    "title" => NotionPropertyKind::Title,
    "rich_text" => NotionPropertyKind::RichText,
    "number" => NotionPropertyKind::Number,
    "checkbox" => NotionPropertyKind::Checkbox,
    "select" => NotionPropertyKind::Select,
    "multi_select" => NotionPropertyKind::MultiSelect,
    "status" => NotionPropertyKind::Status,
    "date" => NotionPropertyKind::Date,
    "date_time" | "datetime" => NotionPropertyKind::DateTime,
    "url" => NotionPropertyKind::Url,
    "email" => NotionPropertyKind::Email,
    "phone_number" => NotionPropertyKind::Phone,
    "people" => NotionPropertyKind::People,
    "files" | "files_v2" => NotionPropertyKind::Files,
    "relation" => NotionPropertyKind::Relation,
    "rollup" => NotionPropertyKind::Rollup,
    "formula" => NotionPropertyKind::Formula,
    "verification" => NotionPropertyKind::Verification,
    "created_time" => NotionPropertyKind::CreatedTime,
    "created_by" => NotionPropertyKind::CreatedBy,
    "last_edited_time" => NotionPropertyKind::LastEditedTime,
    "last_edited_by" => NotionPropertyKind::LastEditedBy,
    _ => NotionPropertyKind::RichText,
  }
}

/// Apply a cell text fragment to the current property. This is the
/// single place where the parser picks up select / multi-select / date /
/// number / checkbox / relation signals from Notion HTML.
fn apply_cell_value(
  target: &mut NotionProperty,
  text: &str,
  _path_stack: &[String],
  page_titles: &BTreeMap<String, String>,
  diagnostics: &mut Vec<NotionDiagnostic>,
) {
  let trimmed = text.trim();
  if trimmed.is_empty() {
    return;
  }
  match target.kind {
    NotionPropertyKind::Number if target.number.is_none() => {
      target.number = trimmed.parse::<f64>().ok();
    }
    NotionPropertyKind::Checkbox if target.checkbox.is_none() => {
      target.checkbox = Some(matches!(trimmed, "true" | "Yes" | "1" | "checked"));
    }
    NotionPropertyKind::Select | NotionPropertyKind::Status
      if !target.select_options.iter().any(|opt| opt == trimmed) =>
    {
      target.select_options.push(trimmed.to_string());
    }
    NotionPropertyKind::MultiSelect => {
      for chunk in trimmed.split(',') {
        let part = chunk.trim();
        if part.is_empty() {
          continue;
        }
        if !target.select_options.iter().any(|opt| opt == part) {
          target.select_options.push(part.to_string());
        }
      }
    }
    NotionPropertyKind::Date | NotionPropertyKind::DateTime => {
      if target.date_start.is_none() {
        target.date_start = Some(trimmed.to_string());
      } else if target.date_end.is_none() && trimmed != target.date_start.as_deref().unwrap_or("") {
        target.date_end = Some(trimmed.to_string());
      }
    }
    NotionPropertyKind::Url if target.url.is_none() => {
      target.url = Some(trimmed.to_string());
    }
    NotionPropertyKind::Email if target.email.is_none() => {
      target.email = Some(trimmed.to_string());
    }
    NotionPropertyKind::Phone if target.phone.is_none() => {
      target.phone = Some(trimmed.to_string());
    }
    NotionPropertyKind::People => {
      for chunk in trimmed.split(',') {
        let part = chunk.trim();
        if part.is_empty() {
          continue;
        }
        if !target.people.iter().any(|p| p == part) {
          target.people.push(part.to_string());
        }
      }
    }
    NotionPropertyKind::Files => {
      // Notion often packs multiple comma-separated file paths into a
      // single cell; split so each path becomes its own file reference
      // downstream.
      for chunk in trimmed.split(',') {
        let part = chunk.trim();
        if part.is_empty() {
          continue;
        }
        if !target.file_paths.iter().any(|p| p == part) {
          target.file_paths.push(part.to_string());
        }
      }
    }
    NotionPropertyKind::Relation => {
      let page_id = trimmed.to_ascii_lowercase();
      target.relation_targets.push(page_id.clone());
      if !page_titles.contains_key(&page_id) {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::DroppedPageMention,
          NotionDiagnosticSeverity::Warning,
          format!("$.database.rows[{}].relation", target.name),
          format!("Relation target page '{page_id}' is not part of the import"),
        ));
      }
    }
    NotionPropertyKind::Rollup if target.rollup_aggregate.is_none() => {
      target.rollup_aggregate = Some(trimmed.to_string());
    }
    NotionPropertyKind::Verification
    | NotionPropertyKind::CreatedTime
    | NotionPropertyKind::CreatedBy
    | NotionPropertyKind::LastEditedTime
    | NotionPropertyKind::LastEditedBy => {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::DroppedVerificationStatus,
        NotionDiagnosticSeverity::Info,
        format!("$.database.rows[{}].{}", target.name, tag_of_kind(target.kind)),
        format!(
          "Notion '{}' property is informational and was not imported",
          tag_of_kind(target.kind)
        ),
      ));
    }
    _ => {}
  }
}

fn tag_of_kind(kind: NotionPropertyKind) -> &'static str {
  match kind {
    NotionPropertyKind::Verification => "verification",
    NotionPropertyKind::CreatedTime => "created_time",
    NotionPropertyKind::CreatedBy => "created_by",
    NotionPropertyKind::LastEditedTime => "last_edited_time",
    NotionPropertyKind::LastEditedBy => "last_edited_by",
    _ => "unknown",
  }
}

/// Parse a single HTML buffer (not wrapped in a ZIP). Useful for
/// test fixtures and for importing one Notion page at a time.
#[instrument(skip(content), fields(input_bytes = content.len()))]
pub fn parse_notion_html(content: &[u8]) -> NotionParseResult {
  if content.len() > MAX_HTML_BYTES {
    let diagnostics = vec![NotionDiagnostic::new(
      NotionDiagnosticCode::Unsupported,
      NotionDiagnosticSeverity::Error,
      "$.html",
      format!("HTML exceeds {MAX_HTML_BYTES} bytes; import aborted"),
    )];
    return NotionParseResult {
      databases: Vec::new(),
      diagnostics,
      source: NotionSource::Html,
      assets: BTreeMap::new(),
    };
  }
  let html = String::from_utf8_lossy(content);
  let page_id = derive_page_id_from_path("inline.html");
  let mut diagnostics: Vec<NotionDiagnostic> = Vec::new();
  let page_titles: BTreeMap<String, String> = BTreeMap::new();
  let (databases, _title) = parse_notion_html_page(&html, &page_id, &page_titles, &mut diagnostics);
  if databases.is_empty() {
    diagnostics.push(NotionDiagnostic::new(
      NotionDiagnosticCode::Unsupported,
      NotionDiagnosticSeverity::Error,
      "$.html",
      "Notion HTML did not contain a database table",
    ));
  }
  debug!(
    databases = databases.len(),
    diagnostics = diagnostics.len(),
    "notion html parse complete"
  );
  NotionParseResult {
    databases,
    diagnostics,
    source: NotionSource::Html,
    assets: BTreeMap::new(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn zip_entries(entries: &[(&str, &str)]) -> Vec<u8> {
    use std::io::Write;

    let mut bytes = Vec::new();
    {
      let cursor = std::io::Cursor::new(&mut bytes);
      let mut archive = zip::ZipWriter::new(cursor);
      let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
      for (path, content) in entries {
        archive.start_file(*path, options).expect("start entry");
        archive.write_all(content.as_bytes()).expect("write entry");
      }
      archive.finish().expect("finish archive");
    }
    bytes
  }

  #[test]
  fn derive_page_id_picks_trailing_hex() {
    let id = derive_page_id_from_path("My Tasks abc123def45678901234567890abcdef.html");
    assert_eq!(id, "abc123def45678901234567890abcdef");
  }

  #[test]
  fn derive_page_id_falls_back_to_slug() {
    let id = derive_page_id_from_path("Folder/My Tasks.html");
    assert_eq!(id, "My_Tasks");
  }

  #[test]
  fn notion_kind_round_trip() {
    assert_eq!(notion_kind_from_str("title"), NotionPropertyKind::Title);
    assert_eq!(notion_kind_from_str("multi_select"), NotionPropertyKind::MultiSelect);
    assert_eq!(notion_kind_from_str("nonsense"), NotionPropertyKind::RichText);
  }

  #[test]
  fn zip_row_body_matches_archive_link_id_independent_of_entry_order() {
    let page_id = "11111111111111111111111111111111";
    let database = format!(
      r#"<html><head><title>Tasks</title></head><body><table class="collection-content">
      <thead><tr><th data-property-name="Name" data-property-type="title">Name</th></tr></thead>
      <tbody><tr><td><a href="Task%20{page_id}.html">Task</a></td></tr></tbody></table></body></html>"#
    );
    let page =
      "<html><head><title>Task</title></head><body><h1 class=\"page-title\">Task</h1><p>Body</p></body></html>";
    let page_path = format!("Task {page_id}.html");
    let archive = zip_entries(&[
      (page_path.as_str(), page),
      ("Tasks aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.html", &database),
    ]);

    let parsed = parse_notion_zip(&archive);
    let row = &parsed.databases[0].rows[0];
    assert_eq!(row.page_id, page_id);
    assert_eq!(
      row.page_body.as_ref().map(|body| body.html_fragment.as_str()),
      Some("<p>Body</p>")
    );
    assert!(!parsed.diagnostics.iter().any(|diagnostic| {
      matches!(
        diagnostic.code.as_str(),
        "MIX_DATABASE_NOTION_PAGE_BODY_MISSING" | "MIX_DATABASE_NOTION_PAGE_BODY_AMBIGUOUS"
      )
    }));
  }

  #[test]
  fn duplicate_normalized_page_ids_are_ambiguous_and_never_title_matched() {
    let page_id = "22222222222222222222222222222222";
    let database = format!(
      r#"<html><head><title>Tasks</title></head><body><table class="collection-content">
      <thead><tr><th data-property-name="Name" data-property-type="title">Name</th></tr></thead>
      <tbody><tr><td><a href="Task%20{page_id}.html">Task</a></td></tr></tbody></table></body></html>"#
    );
    let first_page_path = format!("Folder A/Task {page_id}.html");
    let second_page_path = format!("Folder B/Task {page_id}.html");
    let archive = zip_entries(&[
      ("Tasks aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.html", &database),
      (first_page_path.as_str(), "<html><body><p>A</p></body></html>"),
      (second_page_path.as_str(), "<html><body><p>B</p></body></html>"),
    ]);

    let parsed = parse_notion_zip(&archive);
    assert!(parsed.databases[0].rows[0].page_body.is_none());
    assert!(
      parsed
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == NotionDiagnosticCode::PageBodyAmbiguous.as_str())
    );
  }

  #[test]
  fn parse_single_database_table() {
    let html = r#"
      <html>
        <head><title>My Tasks</title></head>
        <body>
          <table class="collection-content">
            <thead>
              <tr>
                <th data-property-name="Name" data-property-type="title">Name</th>
                <th data-property-name="Done" data-property-type="checkbox">Done</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Write spec</td>
                <td>true</td>
              </tr>
              <tr>
                <td>Send for review</td>
                <td>false</td>
              </tr>
            </tbody>
          </table>
        </body>
      </html>
    "#;
    let result = parse_notion_html(html.as_bytes());
    assert_eq!(result.source, NotionSource::Html);
    assert_eq!(result.databases.len(), 1);
    let db = &result.databases[0];
    // <title>My Tasks</title> is propagated into the next PendingDatabase
    // so Notion→Myoxus→Notion round-trip preserves the page title.
    assert_eq!(db.title, "My Tasks");
    assert_eq!(db.properties.len(), 2);
    assert_eq!(db.properties[0].kind, NotionPropertyKind::Title);
    assert_eq!(db.properties[1].kind, NotionPropertyKind::Checkbox);
    assert_eq!(db.rows.len(), 2);
    assert_eq!(db.rows[0].title, "Write spec");
    assert_eq!(db.rows[0].properties[0].raw_text.as_deref(), Some("Write spec"));
    assert_eq!(db.rows[0].properties[1].checkbox, Some(true));
    assert_eq!(db.rows[1].properties[1].checkbox, Some(false));
  }

  #[test]
  fn parse_html_without_table_emits_diagnostic() {
    let html = "<html><body><p>Not a database</p></body></html>";
    let result = parse_notion_html(html.as_bytes());
    assert!(result.databases.is_empty());
    assert!(
      result
        .diagnostics
        .iter()
        .any(|d| d.code == NotionDiagnosticCode::Unsupported.as_str())
    );
  }
}
