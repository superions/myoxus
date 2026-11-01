// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Y-Doc block parser using `yrs` (MIT).
//!
//! Parses Myoxus/Virgultum Y-Doc binary data and extracts block information for indexing.
//! This is a clean-room reimplementation that produces output compatible with
//! the previous document parser while normalizing legacy `affine:*` flavours at
//! the read boundary.

use std::collections::{HashMap, HashSet};

use serde_json::{Map as JsonMap, Value as JsonValue};
use yrs::types::ToJson;
use yrs::updates::decoder::Decode;
use yrs::{Any, Array, Doc, GetString, Map, MapRef, ReadTxn, Text, Transact, Update};

use crate::types::{BlockInfo, CrawlResult, ParseError};

/// Maximum summary length in characters.
const SUMMARY_LIMIT: usize = 1000;

/// Default title when no page block title is found.
const DEFAULT_PAGE_TITLE: &str = "Untitled";

/// Bookmark-like flavours that produce blocks with no special content extraction.
const BOOKMARK_FLAVOURS: &[&str] = &[
  "myoxus:bookmark",
  "myoxus:embed-youtube",
  "myoxus:embed-iframe",
  "myoxus:embed-figma",
  "myoxus:embed-github",
  "myoxus:embed-loom",
];

/// Parse a Y-Doc binary and extract block information for indexing.
///
/// This function is API-compatible with `affine_common::doc_parser::parse_doc_from_binary`.
///
/// # Arguments
/// * `data` - The Y-Doc binary (v1 encoded update).
/// * `doc_id` - The document ID (used as the Y-Doc GUID).
///
/// # Returns
/// A `CrawlResult` containing all extracted blocks, title, and summary.
///
/// # Errors
/// - `ParseError::InvalidBinary` if the binary cannot be decoded.
/// - `ParseError::ParserError` if the document structure is invalid.
pub fn parse_doc_from_binary(data: Vec<u8>, _doc_id: String) -> Result<CrawlResult, ParseError> {
  if data.is_empty() || data == [0, 0] {
    return Err(ParseError::InvalidBinary);
  }

  let doc = Doc::new();
  // Pre-register root-level types before applying updates (yrs requirement).
  let blocks_map = doc.get_or_insert_map("blocks");
  let _meta_map = doc.get_or_insert_map("meta");
  {
    let mut tx = doc.transact_mut();
    let update = Update::decode_v1(&data).map_err(|_| ParseError::InvalidBinary)?;
    tx.apply_update(update)
      .map_err(|e| ParseError::ParserError(e.to_string()))?;
  }

  let txn = doc.transact_mut();

  let block_count = blocks_map.len(&txn);
  if block_count == 0 {
    return Err(ParseError::ParserError("blocks map is empty".into()));
  }

  // Phase 1: Build block pool and parent lookup from the blocks YMap.
  let mut block_pool: HashMap<String, BlockData> = HashMap::new();
  let mut parent_lookup: HashMap<String, String> = HashMap::new();

  for (key, value) in blocks_map.iter(&txn) {
    if let yrs::Out::YMap(block_map) = value {
      let block_id = get_sys_string(&block_map, &txn, "id").unwrap_or_else(|| key.to_string());
      let flavour = normalize_flavour(&get_sys_string(&block_map, &txn, "flavour").unwrap_or_default()).to_string();
      let children_ids = get_children(&block_map, &txn);

      // Register parent relationships
      for child_id in &children_ids {
        parent_lookup.insert(child_id.clone(), block_id.clone());
      }

      block_pool.insert(
        block_id.clone(),
        BlockData {
          map_ref: block_map,
          flavour,
          children_ids,
        },
      );
    }
  }

  // Find root block (active myoxus:page, with legacy affine:page normalized at read time).
  let root_block_id = block_pool
    .iter()
    .find(|(_, b)| b.flavour == "myoxus:page")
    .map(|(id, _)| id.clone())
    .ok_or_else(|| ParseError::ParserError("root block not found".into()))?;

  // Phase 2: Walk the tree in BFS order (matching original walker behaviour).
  let mut blocks: Vec<BlockInfo> = Vec::with_capacity(block_pool.len());
  let mut doc_title = String::new();
  let mut summary = SummaryBuilder::new(SUMMARY_LIMIT as isize);

  // Stack-based walker: (parent_block_id, block_id)
  let mut queue: Vec<(Option<String>, String)> = vec![(None, root_block_id.clone())];
  let mut visited: HashSet<String> = HashSet::new();
  visited.insert(root_block_id.clone());

  while let Some((parent_block_id, block_id)) = queue.pop() {
    let Some(block_data) = block_pool.get(&block_id) else {
      continue;
    };

    let flavour = &block_data.flavour;
    let parent_block = parent_block_id.as_ref().and_then(|pid| block_pool.get(pid));
    let parent_flavour = parent_block.map(|b| &b.flavour);

    // Find nearest note block for displayMode/noteBlockId
    let note_block_id = find_nearest_note(&block_id, &parent_lookup, &block_pool);
    let display_mode = note_block_id
      .as_ref()
      .and_then(|nid| block_pool.get(nid))
      .map(|nb| get_prop_string(&nb.map_ref, &txn, "displayMode"))
      .flatten()
      .map(|mode| if mode == "both" { "page".to_string() } else { mode })
      .unwrap_or_else(|| "edgeless".to_string());

    // Enqueue children (in reverse order so first child is processed first via pop)
    let mut child_ids_rev: Vec<String> = block_data.children_ids.clone();
    child_ids_rev.reverse();
    for child_id in child_ids_rev {
      if visited.insert(child_id.clone()) {
        queue.push((Some(block_id.clone()), child_id));
      }
    }

    let build_block = |database_name: Option<&String>| {
      BlockInfo::base(
        &block_id,
        flavour,
        parent_flavour.map(|s| s),
        parent_block_id.as_ref(),
        compose_additional(&display_mode, note_block_id.as_ref(), database_name),
      )
    };

    // myoxus:page — extract title
    if flavour == "myoxus:page" {
      let title = get_text_string(&block_data.map_ref, &txn, "prop:title")
        .or_else(|| get_text_string(&block_data.map_ref, &txn, "title"))
        .unwrap_or_default();
      doc_title = title.clone();
      let mut info = build_block(None);
      info.content = Some(vec![title]);
      blocks.push(info);
      continue;
    }

    // Text-bearing blocks — extract text content + refs.
    if matches!(flavour.as_str(), "myoxus:paragraph" | "myoxus:list" | "myoxus:code") {
      let text_content = get_text_string(&block_data.map_ref, &txn, "prop:text")
        .or_else(|| get_text_string(&block_data.map_ref, &txn, "text"));

      if let Some(content) = text_content {
        let database_name =
          if flavour == "myoxus:paragraph" && parent_flavour.map(|f| f.as_str()) == Some("myoxus:database") {
            parent_block.and_then(|pb| get_text_string(&pb.map_ref, &txn, "prop:title"))
          } else {
            None
          };

        let refs = extract_inline_references(&block_data.map_ref, &txn);

        let mut info = build_block(database_name.as_ref());
        info.content = Some(vec![content.clone()]);
        if !refs.is_empty() {
          info.ref_doc_id = Some(refs.iter().map(|r| r.doc_id.clone()).collect());
          info.ref_info = Some(refs.into_iter().map(|r| r.payload).collect());
        }
        blocks.push(info);
        summary.push_text(&content, content.len());
      }
      continue;
    }

    // Linked/synced docs — extract doc references.
    if matches!(flavour.as_str(), "myoxus:embed-linked-doc" | "myoxus:embed-synced-doc") {
      if let Some(page_id) = get_prop_string(&block_data.map_ref, &txn, "pageId") {
        let mut info = build_block(None);
        let payload = build_embed_ref_payload(&block_data.map_ref, &txn, &page_id);
        info.ref_doc_id = Some(vec![page_id]);
        if let Some(payload) = payload {
          info.ref_info = Some(vec![payload]);
        }
        blocks.push(info);
      }
      continue;
    }

    // Attachments — extract blob info.
    if flavour == "myoxus:attachment" {
      if let Some(blob_id) = get_prop_string(&block_data.map_ref, &txn, "sourceId") {
        let mut info = build_block(None);
        let name = get_prop_string(&block_data.map_ref, &txn, "name").unwrap_or_default();
        info.blob = Some(vec![blob_id]);
        info.content = Some(vec![name]);
        blocks.push(info);
      }
      continue;
    }

    // Images — extract blob info.
    if flavour == "myoxus:image" {
      let source_id = get_prop_string(&block_data.map_ref, &txn, "sourceId").unwrap_or_default();
      if !source_id.is_empty() {
        let mut info = build_block(None);
        let caption = get_prop_string(&block_data.map_ref, &txn, "caption")
          .or_else(|| get_text_string(&block_data.map_ref, &txn, "prop:caption"))
          .unwrap_or_default();
        info.blob = Some(vec![source_id]);
        info.content = Some(vec![caption]);
        blocks.push(info);
      }
      continue;
    }

    // Surfaces — extract element texts.
    if flavour == "myoxus:surface" {
      let texts = gather_surface_texts(&block_data.map_ref, &txn);
      let mut info = build_block(None);
      info.content = Some(texts);
      blocks.push(info);
      continue;
    }

    // Databases — extract database texts and cell references.
    if flavour == "myoxus:database" {
      let (texts, database_name) = gather_database_texts(&block_data.map_ref, &txn);
      let mut info = BlockInfo::base(
        &block_id,
        flavour,
        parent_flavour.map(|s| s),
        parent_block_id.as_ref(),
        compose_additional(&display_mode, note_block_id.as_ref(), database_name.as_ref()),
      );
      info.content = Some(texts);
      let refs = collect_database_cell_references(&block_data.map_ref, &txn);
      if !refs.is_empty() {
        info.ref_doc_id = Some(refs.iter().map(|r| r.doc_id.clone()).collect());
        info.ref_info = Some(refs.into_iter().map(|r| r.payload).collect());
      }
      blocks.push(info);
      continue;
    }

    // LaTeX — extract latex content.
    if flavour == "myoxus:latex" {
      if let Some(content) = get_prop_string(&block_data.map_ref, &txn, "latex") {
        let mut info = build_block(None);
        info.content = Some(vec![content]);
        blocks.push(info);
      }
      continue;
    }

    // Tables — extract active flat-data cell texts.
    if flavour == "myoxus:table" {
      let contents = table_cell_texts(&block_data.map_ref, &txn);
      let mut info = build_block(None);
      info.content = Some(contents);
      blocks.push(info);
      continue;
    }

    // Bookmark-like flavours — emit block with no special content
    if BOOKMARK_FLAVOURS.contains(&flavour.as_str()) {
      blocks.push(build_block(None));
    }
  }

  if doc_title.is_empty() {
    doc_title = DEFAULT_PAGE_TITLE.into();
  }

  Ok(CrawlResult {
    blocks,
    title: doc_title,
    summary: summary.into_string(),
  })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Parsed block data held during tree walk.
struct BlockData {
  map_ref: MapRef,
  flavour: String,
  children_ids: Vec<String>,
}

/// Helper to accumulate summary text up to a limit.
struct SummaryBuilder {
  summary: String,
  remaining: Option<isize>,
}

impl SummaryBuilder {
  fn new(limit: isize) -> Self {
    let remaining = if limit < 0 { None } else { Some(limit) };
    Self {
      summary: String::new(),
      remaining,
    }
  }

  fn push_text(&mut self, text: &str, len: usize) {
    match self.remaining {
      None => self.summary.push_str(text),
      Some(remaining) if remaining > 0 => {
        self.summary.push_str(text);
        self.remaining = Some(remaining - len as isize);
      }
      _ => {}
    }
  }

  fn into_string(self) -> String {
    self.summary
  }
}

/// Inline reference extracted from text delta attributes.
struct InlineRef {
  doc_id: String,
  payload: String,
}

/// Normalize legacy storage flavours at the parser boundary. New index output
/// should reflect the active Myoxus/Virgultum storage contract.
fn normalize_flavour(flavour: &str) -> &str {
  match flavour {
    "affine:page" => "myoxus:page",
    "affine:note" => "myoxus:note",
    "affine:paragraph" => "myoxus:paragraph",
    "affine:list" => "myoxus:list",
    "affine:code" => "myoxus:code",
    "affine:embed-linked-doc" => "myoxus:embed-linked-doc",
    "affine:embed-synced-doc" => "myoxus:embed-synced-doc",
    "affine:attachment" => "myoxus:attachment",
    "affine:image" => "myoxus:image",
    "affine:surface" => "myoxus:surface",
    "affine:database" => "myoxus:database",
    "affine:latex" => "myoxus:latex",
    "affine:table" => "myoxus:table",
    "affine:bookmark" => "myoxus:bookmark",
    "affine:embed-youtube" => "myoxus:embed-youtube",
    "affine:embed-iframe" => "myoxus:embed-iframe",
    "affine:embed-figma" => "myoxus:embed-figma",
    "affine:embed-github" => "myoxus:embed-github",
    "affine:embed-loom" => "myoxus:embed-loom",
    other => other,
  }
}

/// Read a system property string from a block map.
/// Tries `sys:{key}` first.
fn get_sys_string<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> Option<String> {
  let prefixed = format!("sys:{key}");
  map
    .get(txn, &prefixed)
    .or_else(|| map.get(txn, key))
    .and_then(|v| match v {
      yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
      _ => None,
    })
}

/// Read a property string from a block map.
/// Tries `prop:{key}` first, then falls back to `props` sub-map.
fn get_prop_string<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> Option<String> {
  let prefixed = format!("prop:{key}");
  if let Some(yrs::Out::Any(Any::String(s))) = map.get(txn, &prefixed) {
    return Some(s.to_string());
  }
  // Fall back to "props" sub-map (old format)
  if let Some(yrs::Out::YMap(props)) = map.get(txn, "props") {
    if let Some(yrs::Out::Any(Any::String(s))) = props.get(txn, key) {
      return Some(s.to_string());
    }
  }
  None
}

/// Extract text content as a String from a Y.Text field in a block map.
/// Tries `prop:{key_suffix}` first, then `{key_suffix}`.
fn get_text_string<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> Option<String> {
  map.get(txn, key).and_then(|v| match v {
    yrs::Out::YText(t) => Some(t.get_string(txn)),
    yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
    _ => None,
  })
}

/// Get children IDs from a block map's `sys:children` or `children` array.
fn get_children<T: ReadTxn>(map: &MapRef, txn: &T) -> Vec<String> {
  map
    .get(txn, "sys:children")
    .or_else(|| map.get(txn, "children"))
    .and_then(|v| {
      if let yrs::Out::YArray(arr) = v {
        Some(
          arr
            .iter(txn)
            .filter_map(|item| match item {
              yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
              _ => None,
            })
            .collect(),
        )
      } else {
        None
      }
    })
    .unwrap_or_default()
}

/// Find the nearest ancestor block with flavour "myoxus:note".
fn find_nearest_note(
  block_id: &str,
  parent_lookup: &HashMap<String, String>,
  block_pool: &HashMap<String, BlockData>,
) -> Option<String> {
  let mut cursor = Some(block_id.to_string());
  while let Some(node) = cursor {
    if let Some(block) = block_pool.get(&node) {
      if block.flavour == "myoxus:note" {
        return Some(node);
      }
    }
    cursor = parent_lookup.get(&node).cloned();
  }
  None
}

/// Compose the `additional` JSON payload.
fn compose_additional(
  display_mode: &str,
  note_block_id: Option<&String>,
  database_name: Option<&String>,
) -> Option<String> {
  let mut payload = JsonMap::new();
  // If database_name is present, it goes first in the serialized JSON
  // (serde_json::Map preserves insertion order).
  if let Some(name) = database_name {
    payload.insert("databaseName".into(), JsonValue::String(name.clone()));
  }
  payload.insert("displayMode".into(), JsonValue::String(display_mode.to_string()));
  if let Some(note_id) = note_block_id {
    payload.insert("noteBlockId".into(), JsonValue::String(note_id.clone()));
  }
  Some(JsonValue::Object(payload).to_string())
}

/// Extract inline references from the `prop:text` Y.Text delta attributes.
fn extract_inline_references<T: ReadTxn>(map: &MapRef, txn: &T) -> Vec<InlineRef> {
  let text_ref = map.get(txn, "prop:text").or_else(|| map.get(txn, "text"));
  let text_ref = match text_ref {
    Some(yrs::Out::YText(t)) => t,
    _ => return Vec::new(),
  };

  let diff = text_ref.diff(txn, yrs::types::text::YChange::identity);
  let mut refs = Vec::new();
  let mut seen: HashSet<(String, String)> = HashSet::new();

  for chunk in &diff {
    let Some(attrs) = &chunk.attributes else {
      continue;
    };
    let Some(ref_any) = attrs.get("reference") else {
      continue;
    };

    if let Some((page_id, payload)) = parse_reference_any(ref_any) {
      let key = (page_id.clone(), payload.clone());
      if seen.insert(key) {
        refs.push(InlineRef {
          doc_id: page_id,
          payload,
        });
      }
    }
  }

  refs
}

/// Parse a reference attribute value (Any::Map with "pageId" key).
fn parse_reference_any(value: &Any) -> Option<(String, String)> {
  let map = match value {
    Any::Map(m) => m,
    _ => return None,
  };

  let page_id = match map.get("pageId") {
    Some(Any::String(s)) => s.to_string(),
    _ => return None,
  };

  // Build reference payload JSON
  let mut payload = JsonMap::new();
  payload.insert("docId".into(), JsonValue::String(page_id.clone()));

  // Extract params if present
  if let Some(Any::Map(params)) = map.get("params") {
    for (key, val) in params.iter() {
      if let Some(json_val) = any_to_json(val) {
        payload.insert(key.clone(), json_val);
      }
    }
  }

  let payload_str = JsonValue::Object(payload).to_string();
  Some((page_id, payload_str))
}

/// Convert a yrs::Any to serde_json::Value.
fn any_to_json(any: &Any) -> Option<JsonValue> {
  match any {
    Any::Null | Any::Undefined => Some(JsonValue::Null),
    Any::Bool(b) => Some(JsonValue::Bool(*b)),
    Any::Number(n) => n
      .as_f64()
      .and_then(serde_json::Number::from_f64)
      .or_else(|| n.as_i64().map(Into::into))
      .map(JsonValue::Number),
    Any::BigInt(n) => Some(JsonValue::Number((*n).into())),
    Any::String(s) => Some(JsonValue::String(s.to_string())),
    Any::Array(arr) => {
      let items: Vec<JsonValue> = arr.iter().filter_map(|v| any_to_json(v)).collect();
      Some(JsonValue::Array(items))
    }
    Any::Map(map) => {
      let mut obj = JsonMap::new();
      for (k, v) in map.iter() {
        if let Some(jv) = any_to_json(v) {
          obj.insert(k.clone(), jv);
        }
      }
      Some(JsonValue::Object(obj))
    }
    Any::Buffer(_) => None,
  }
}

/// Build an embed reference payload for linked/synced doc blocks.
fn build_embed_ref_payload<T: ReadTxn>(map: &MapRef, txn: &T, page_id: &str) -> Option<String> {
  let params_value = map.get(txn, "prop:params");
  let params_json = params_value.and_then(|v| value_to_json(&v, txn));

  let mut payload = JsonMap::new();
  payload.insert("docId".into(), JsonValue::String(page_id.to_string()));
  if let Some(JsonValue::Object(params)) = params_json {
    for (key, value) in params.into_iter() {
      payload.insert(key, value);
    }
  }
  Some(JsonValue::Object(payload).to_string())
}

/// Convert a yrs::Value to serde_json::Value.
fn value_to_json<T: ReadTxn>(value: &yrs::Out, txn: &T) -> Option<JsonValue> {
  match value {
    yrs::Out::Any(any) => any_to_json(any),
    yrs::Out::YText(t) => Some(JsonValue::String(t.get_string(txn))),
    yrs::Out::YMap(m) => {
      let json = m.to_json(txn);
      any_to_json(&json)
    }
    yrs::Out::YArray(a) => {
      let json = a.to_json(txn);
      any_to_json(&json)
    }
    _ => None,
  }
}

/// Gather text from surface block's `prop:elements`.
fn gather_surface_texts<T: ReadTxn>(map: &MapRef, txn: &T) -> Vec<String> {
  let mut texts = Vec::new();

  let elements = match map.get(txn, "prop:elements") {
    Some(yrs::Out::YMap(m)) => m,
    _ => return texts,
  };

  let type_str = elements.get(txn, "type").and_then(|v| match v {
    yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
    _ => None,
  });
  // Match the TypeScript reader's accepted boxed-value formats without changing
  // the canonical marker written into persisted documents.
  if !matches!(
    type_str.as_deref(),
    Some("$blocksuite:internal:native$" | "$virgultum:internal:native$")
  ) {
    return texts;
  }

  let value_map = match elements.get(txn, "value") {
    Some(yrs::Out::YMap(m)) => m,
    _ => return texts,
  };

  for (_key, value) in value_map.iter(txn) {
    if let yrs::Out::YMap(element) = value {
      if let Some(yrs::Out::YText(text)) = element.get(txn, "text") {
        texts.push(text.get_string(txn));
      }
    }
  }

  texts.sort();
  texts
}

/// Gather texts from a database block (title + column names + option values).
fn gather_database_texts<T: ReadTxn>(map: &MapRef, txn: &T) -> (Vec<String>, Option<String>) {
  let mut texts = Vec::new();
  let database_title = get_text_string(map, txn, "prop:title");
  if let Some(title) = &database_title {
    texts.push(title.clone());
  }

  if let Some(columns) = parse_database_columns(map, txn) {
    for column in &columns {
      if let Some(name) = &column.name {
        texts.push(name.clone());
      }
      for option in &column.options {
        if let Some(value) = &option.value {
          texts.push(value.clone());
        }
      }
    }
  }

  (texts, database_title)
}

/// Collect inline references from database cells.
fn collect_database_cell_references<T: ReadTxn>(map: &MapRef, txn: &T) -> Vec<InlineRef> {
  let cells_map = match map.get(txn, "prop:cells") {
    Some(yrs::Out::YMap(m)) => m,
    _ => return Vec::new(),
  };

  let mut refs = Vec::new();
  let mut seen: HashSet<(String, String)> = HashSet::new();

  for (_row_key, row_value) in cells_map.iter(txn) {
    let row_map = match row_value {
      yrs::Out::YMap(m) => m,
      _ => continue,
    };
    for (_cell_key, cell_value) in row_map.iter(txn) {
      let cell_map = match cell_value {
        yrs::Out::YMap(m) => m,
        _ => continue,
      };
      let Some(value) = cell_map.get(txn, "value") else {
        continue;
      };
      // Extract references from the cell value (which may be a Y.Text with delta attrs)
      let cell_refs = extract_refs_from_value(&value, txn);
      for r in cell_refs {
        let key = (r.doc_id.clone(), r.payload.clone());
        if seen.insert(key) {
          refs.push(r);
        }
      }
    }
  }

  refs
}

/// Extract inline references from a value that might be Y.Text with reference attributes.
fn extract_refs_from_value<T: ReadTxn>(value: &yrs::Out, txn: &T) -> Vec<InlineRef> {
  match value {
    yrs::Out::YText(text_ref) => {
      let diff = text_ref.diff(txn, yrs::types::text::YChange::identity);
      let mut refs = Vec::new();
      let mut seen: HashSet<(String, String)> = HashSet::new();

      for chunk in &diff {
        let Some(attrs) = &chunk.attributes else {
          continue;
        };
        let Some(ref_any) = attrs.get("reference") else {
          continue;
        };
        if let Some((page_id, payload)) = parse_reference_any(ref_any) {
          let key = (page_id.clone(), payload.clone());
          if seen.insert(key) {
            refs.push(InlineRef {
              doc_id: page_id,
              payload,
            });
          }
        }
      }
      refs
    }
    // If it's an Any value, try to parse as delta ops
    yrs::Out::Any(any) => extract_refs_from_any_delta(any),
    _ => Vec::new(),
  }
}

/// Try to extract references from Any-encoded delta operations.
fn extract_refs_from_any_delta(value: &Any) -> Vec<InlineRef> {
  let ops = match value {
    Any::Array(arr) => arr,
    _ => return Vec::new(),
  };

  let mut refs = Vec::new();
  let mut seen: HashSet<(String, String)> = HashSet::new();

  for op in ops.iter() {
    let Any::Map(op_map) = op else {
      continue;
    };
    let Some(Any::Map(attrs)) = op_map.get("attributes") else {
      continue;
    };
    let Some(ref_any) = attrs.get("reference") else {
      continue;
    };
    if let Some((page_id, payload)) = parse_reference_any(ref_any) {
      let key = (page_id.clone(), payload.clone());
      if seen.insert(key) {
        refs.push(InlineRef {
          doc_id: page_id,
          payload,
        });
      }
    }
  }

  refs
}

/// Extract cell texts from a table block.
fn table_cell_texts<T: ReadTxn>(map: &MapRef, txn: &T) -> Vec<String> {
  #[derive(Default)]
  struct OrderedEntry {
    id: String,
    order: String,
  }

  fn split_flat_key<'k>(key: &'k str, prefix: &str) -> Option<(&'k str, &'k str)> {
    let rest = key.strip_prefix(prefix)?;
    rest.rsplit_once('.')
  }

  fn out_to_string<T: ReadTxn>(value: &yrs::Out, txn: &T) -> Option<String> {
    match value {
      yrs::Out::YText(t) => Some(t.get_string(txn)),
      yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
      yrs::Out::Any(Any::Number(n)) => Some(n.to_string()),
      yrs::Out::Any(Any::BigInt(n)) => Some(n.to_string()),
      _ => None,
    }
  }

  let mut rows: HashMap<String, OrderedEntry> = HashMap::new();
  let mut columns: HashMap<String, OrderedEntry> = HashMap::new();
  let mut cells: HashMap<String, String> = HashMap::new();

  for (key, value) in map.iter(txn) {
    let key_str = key.to_string();
    if let Some((row_id, field)) = split_flat_key(&key_str, "prop:rows.") {
      let entry = rows.entry(row_id.to_string()).or_insert_with(|| OrderedEntry {
        id: row_id.to_string(),
        order: String::new(),
      });
      match field {
        "rowId" => {
          if let Some(value) = out_to_string(&value, txn) {
            entry.id = value;
          }
        }
        "order" => {
          if let Some(value) = out_to_string(&value, txn) {
            entry.order = value;
          }
        }
        _ => {}
      }
    } else if let Some((column_id, field)) = split_flat_key(&key_str, "prop:columns.") {
      let entry = columns.entry(column_id.to_string()).or_insert_with(|| OrderedEntry {
        id: column_id.to_string(),
        order: String::new(),
      });
      match field {
        "columnId" => {
          if let Some(value) = out_to_string(&value, txn) {
            entry.id = value;
          }
        }
        "order" => {
          if let Some(value) = out_to_string(&value, txn) {
            entry.order = value;
          }
        }
        _ => {}
      }
    } else if let Some(cell_key) = key_str
      .strip_prefix("prop:cells.")
      .and_then(|rest| rest.strip_suffix(".text"))
      && let Some(text) = out_to_string(&value, txn)
    {
      cells.insert(cell_key.to_string(), text);
    }
  }

  if rows.is_empty() || columns.is_empty() {
    return cells.into_values().filter(|text| !text.is_empty()).collect();
  }

  let mut rows: Vec<_> = rows.into_values().collect();
  let mut columns: Vec<_> = columns.into_values().collect();
  rows.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
  columns.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));

  let mut contents = Vec::new();
  for row in rows {
    for column in &columns {
      if let Some(text) = cells.get(&format!("{}:{}", row.id, column.id))
        && !text.is_empty()
      {
        contents.push(text.clone());
      }
    }
  }
  contents
}

// ---------------------------------------------------------------------------
// Database column parsing helpers
// ---------------------------------------------------------------------------

struct DatabaseColumn {
  name: Option<String>,
  options: Vec<DatabaseOption>,
}

struct DatabaseOption {
  value: Option<String>,
}

fn parse_database_columns<T: ReadTxn>(map: &MapRef, txn: &T) -> Option<Vec<DatabaseColumn>> {
  let columns_value = map.get(txn, "prop:columns")?;
  let columns_arr = match columns_value {
    yrs::Out::YArray(arr) => arr,
    _ => return None,
  };

  let mut parsed = Vec::new();
  for item in columns_arr.iter(txn) {
    if let yrs::Out::YMap(col_map) = item {
      let name = col_map.get(txn, "name").and_then(|v| match v {
        yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
        yrs::Out::YText(t) => Some(t.get_string(txn)),
        _ => None,
      });
      let options = parse_database_column_options(&col_map, txn);
      parsed.push(DatabaseColumn { name, options });
    }
  }
  Some(parsed)
}

fn parse_database_column_options<T: ReadTxn>(col_map: &MapRef, txn: &T) -> Vec<DatabaseOption> {
  let data = match col_map.get(txn, "data") {
    Some(yrs::Out::YMap(m)) => m,
    _ => return Vec::new(),
  };
  let options = match data.get(txn, "options") {
    Some(yrs::Out::YArray(arr)) => arr,
    _ => return Vec::new(),
  };

  let mut parsed = Vec::new();
  for item in options.iter(txn) {
    if let yrs::Out::YMap(opt_map) = item {
      let value = opt_map.get(txn, "value").and_then(|v| match v {
        yrs::Out::Any(Any::String(s)) => Some(s.to_string()),
        yrs::Out::YText(t) => Some(t.get_string(txn)),
        _ => None,
      });
      parsed.push(DatabaseOption { value });
    }
  }
  parsed
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn surface_search_text_accepts_both_boxed_markers() {
    for marker in [
      "$blocksuite:internal:native$",
      "$virgultum:internal:native$",
      "$unknown:internal:native$",
    ] {
      let doc = Doc::new();
      let blocks = doc.get_or_insert_map("blocks");
      {
        let mut txn = doc.transact_mut();
        let page = blocks.insert(&mut txn, "page", yrs::MapPrelim::default());
        page.insert(&mut txn, "sys:id", "page");
        page.insert(&mut txn, "sys:flavour", "myoxus:page");
        let children = page.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
        children.push_back(&mut txn, "surface");
        let surface = blocks.insert(&mut txn, "surface", yrs::MapPrelim::default());
        surface.insert(&mut txn, "sys:id", "surface");
        surface.insert(&mut txn, "sys:flavour", "myoxus:surface");
        let boxed = surface.insert(&mut txn, "prop:elements", yrs::MapPrelim::default());
        boxed.insert(&mut txn, "type", marker);
        let elements = boxed.insert(&mut txn, "value", yrs::MapPrelim::default());
        for (id, text) in [("first", "Zürich"), ("second", "Canvas text")] {
          let element = elements.insert(&mut txn, id, yrs::MapPrelim::default());
          element.insert(&mut txn, "text", yrs::TextPrelim::new(text));
        }
      }
      let update = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
      let result = parse_doc_from_binary(update, "canvas-doc".into()).expect("valid canvas document");
      let surface = result
        .blocks
        .iter()
        .find(|block| block.block_id == "surface")
        .expect("surface block");
      let expected = if marker == "$unknown:internal:native$" {
        vec![]
      } else {
        vec!["Canvas text".to_string(), "Zürich".to_string()]
      };
      assert_eq!(surface.content, Some(expected), "boxed marker: {marker}");
    }
  }

  #[test]
  fn parse_synthetic_fixture() {
    let doc_id = "dYpV7PPhk8amRkY5IAcVO".to_string();
    let result = parse_doc_from_binary(synthetic_doc_update(), doc_id).expect("should parse synthetic ydoc");

    assert_eq!(result.title, "Parser Fixture");
    assert_eq!(result.summary, "A neutral parser fixture.");
    assert_eq!(result.blocks.len(), 2);

    let page = result
      .blocks
      .iter()
      .find(|block| block.block_id == "page")
      .expect("page block should be present");
    assert_eq!(page.flavour, "myoxus:page");
    assert_eq!(page.content, Some(vec!["Parser Fixture".to_string()]));

    let paragraph = result
      .blocks
      .iter()
      .find(|block| block.block_id == "paragraph")
      .expect("paragraph block should be present");
    assert_eq!(paragraph.flavour, "myoxus:paragraph");
    assert_eq!(paragraph.parent_flavour, Some("myoxus:note".to_string()));
    assert_eq!(paragraph.parent_block_id, Some("note".to_string()));
    assert_eq!(paragraph.content, Some(vec!["A neutral parser fixture.".to_string()]));
    assert_eq!(
      paragraph.additional,
      Some(r#"{"displayMode":"page","noteBlockId":"note"}"#.to_string())
    );
  }

  #[test]
  fn parse_canonical_flat_table_cells() {
    let result =
      parse_doc_from_binary(canonical_table_doc_update(), "table-doc".into()).expect("should parse table doc");

    let table = result
      .blocks
      .iter()
      .find(|block| block.block_id == "table")
      .expect("table block should be present");
    assert_eq!(table.flavour, "myoxus:table");
    assert_eq!(table.parent_flavour, Some("myoxus:note".to_string()));
    assert_eq!(
      table.content,
      Some(vec![
        "Name".to_string(),
        "Score".to_string(),
        "Ada".to_string(),
        "42".to_string()
      ])
    );
  }

  fn canonical_table_doc_update() -> Vec<u8> {
    let doc = Doc::new();
    let blocks_map = doc.get_or_insert_map("blocks");
    let _meta_map = doc.get_or_insert_map("meta");

    {
      let mut txn = doc.transact_mut();

      let page = blocks_map.insert(&mut txn, "page", yrs::MapPrelim::default());
      page.insert(&mut txn, "sys:id", "page");
      page.insert(&mut txn, "sys:flavour", "myoxus:page");
      page.insert(&mut txn, "prop:title", yrs::TextPrelim::new("Canonical Table Fixture"));
      let page_children = page.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
      page_children.push_back(&mut txn, "note");

      let note = blocks_map.insert(&mut txn, "note", yrs::MapPrelim::default());
      note.insert(&mut txn, "sys:id", "note");
      note.insert(&mut txn, "sys:flavour", "myoxus:note");
      note.insert(&mut txn, "prop:displayMode", "page");
      let note_children = note.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
      note_children.push_back(&mut txn, "table");

      let table = blocks_map.insert(&mut txn, "table", yrs::MapPrelim::default());
      table.insert(&mut txn, "sys:id", "table");
      table.insert(&mut txn, "sys:flavour", "myoxus:table");
      table.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
      table.insert(&mut txn, "prop:rows.row-0000.rowId", "row-0000");
      table.insert(&mut txn, "prop:rows.row-0000.order", "00000000");
      table.insert(&mut txn, "prop:rows.row-0001.rowId", "row-0001");
      table.insert(&mut txn, "prop:rows.row-0001.order", "00000001");
      table.insert(&mut txn, "prop:columns.col-0000.columnId", "col-0000");
      table.insert(&mut txn, "prop:columns.col-0000.order", "00000000");
      table.insert(&mut txn, "prop:columns.col-0001.columnId", "col-0001");
      table.insert(&mut txn, "prop:columns.col-0001.order", "00000001");
      table.insert(
        &mut txn,
        "prop:cells.row-0000:col-0000.text",
        yrs::TextPrelim::new("Name"),
      );
      table.insert(
        &mut txn,
        "prop:cells.row-0000:col-0001.text",
        yrs::TextPrelim::new("Score"),
      );
      table.insert(
        &mut txn,
        "prop:cells.row-0001:col-0000.text",
        yrs::TextPrelim::new("Ada"),
      );
      table.insert(
        &mut txn,
        "prop:cells.row-0001:col-0001.text",
        yrs::TextPrelim::new("42"),
      );
    }

    doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
  }

  fn synthetic_doc_update() -> Vec<u8> {
    let doc = Doc::new();
    let blocks_map = doc.get_or_insert_map("blocks");
    let _meta_map = doc.get_or_insert_map("meta");

    {
      let mut txn = doc.transact_mut();

      let page = blocks_map.insert(&mut txn, "page", yrs::MapPrelim::default());
      page.insert(&mut txn, "id", "page");
      page.insert(&mut txn, "flavour", "affine:page");
      page.insert(&mut txn, "title", yrs::TextPrelim::new("Parser Fixture"));
      let page_children = page.insert(&mut txn, "children", yrs::ArrayPrelim::default());
      page_children.push_back(&mut txn, "note");

      let note = blocks_map.insert(&mut txn, "note", yrs::MapPrelim::default());
      note.insert(&mut txn, "id", "note");
      note.insert(&mut txn, "flavour", "affine:note");
      note.insert(&mut txn, "prop:displayMode", "page");
      let note_children = note.insert(&mut txn, "children", yrs::ArrayPrelim::default());
      note_children.push_back(&mut txn, "paragraph");

      let paragraph = blocks_map.insert(&mut txn, "paragraph", yrs::MapPrelim::default());
      paragraph.insert(&mut txn, "id", "paragraph");
      paragraph.insert(&mut txn, "flavour", "affine:paragraph");
      paragraph.insert(&mut txn, "text", yrs::TextPrelim::new("A neutral parser fixture."));
      paragraph.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    }

    doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
  }

  #[test]
  fn empty_binary_returns_error() {
    let result = parse_doc_from_binary(Vec::new(), "test".into());
    assert!(matches!(result, Err(ParseError::InvalidBinary)));
  }

  #[test]
  fn two_byte_empty_returns_error() {
    let result = parse_doc_from_binary(vec![0, 0], "test".into());
    assert!(matches!(result, Err(ParseError::InvalidBinary)));
  }

  #[test]
  fn garbage_binary_returns_error() {
    let result = parse_doc_from_binary(vec![0xFF, 0xFE, 0xFD], "test".into());
    assert!(matches!(result, Err(ParseError::InvalidBinary)));
  }

  #[test]
  fn title_defaults_to_untitled() {
    // Create a minimal legacy doc with an affine:page block that has an empty title.
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    {
      let mut txn = doc.transact_mut();
      let empty: [(&str, &str); 0] = [];
      let page = blocks.insert(&mut txn, "page1", yrs::MapPrelim::from(empty));
      page.insert(&mut txn, "sys:id", "page1");
      page.insert(&mut txn, "sys:flavour", "affine:page");
      page.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
    }

    let update = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());

    let result = parse_doc_from_binary(update, "test-doc".into()).unwrap();
    assert_eq!(result.title, "Untitled");
  }
}
