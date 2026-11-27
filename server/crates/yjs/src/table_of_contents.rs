// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared validation and heading-slug helpers for `myoxus:table-of-contents`.

use std::collections::HashMap;
use yrs::{Array, Doc, Map, Out, ReadTxn, Transact, Update, updates::decoder::Decode};

/// Clamp and normalize an authored TOC heading-level range into `1..=6` with `min <= max`.
pub fn normalize_level_range(min_level: Option<u8>, max_level: Option<u8>) -> (u8, u8) {
  let min = min_level.unwrap_or(1).clamp(1, 6);
  let max = max_level.unwrap_or(3).clamp(1, 6);
  if min <= max { (min, max) } else { (min, min) }
}

/// Scope prefix for a block ID: host blocks return `None`, while blocks projected
/// by `document_embed::project` share their `"{embed_id}:embed:"` prefix.
/// Host TOCs only collect host headings; embedded TOCs only collect headings
/// from their own embed projection, preventing cross-boundary leakage or loops.
pub fn embed_scope_prefix(block_id: &str) -> Option<&str> {
  block_id.find(":embed:").map(|idx| &block_id[..idx + ":embed:".len()])
}

/// Deterministic heading anchor slug matching `public_render/src/html.rs::unique_slug`.
pub fn unique_heading_slug(title: &str, counts: &mut HashMap<String, usize>) -> String {
  let mut base = String::new();
  let mut prev_dash = false;
  for ch in title.trim().chars().flat_map(char::to_lowercase) {
    if ch.is_ascii_alphanumeric() {
      base.push(ch);
      prev_dash = false;
    } else if !prev_dash && !base.is_empty() {
      base.push('-');
      prev_dash = true;
    }
  }
  while base.ends_with('-') {
    base.pop();
  }
  if base.is_empty() {
    base.push_str("section");
  }
  let count = counts.entry(base.clone()).or_insert(0);
  *count += 1;
  if *count == 1 {
    base
  } else {
    format!("{base}-{}", *count)
  }
}

fn read_level_prop(block: &yrs::MapRef, txn: &impl ReadTxn, key: &str) -> Result<Option<u8>, String> {
  let prop_key = format!("prop:{key}");
  let Some(value) = block.get(txn, &prop_key) else {
    return Ok(None);
  };
  let number = match value {
    Out::Any(yrs::Any::BigInt(n)) => Some(n),
    Out::Any(yrs::Any::Number(n)) => n
      .as_f64()
      .filter(|v| v.is_finite() && v.fract() == 0.0)
      .map(|v| v as i64),
    Out::Any(yrs::Any::Null | yrs::Any::Undefined) => return Ok(None),
    _ => return Err(format!("invalid table-of-contents {key}")),
  };
  let Some(n) = number else {
    return Err(format!("invalid table-of-contents {key}"));
  };
  if !(1..=6).contains(&n) {
    return Err(format!("table-of-contents {key} out of range (1..=6)"));
  }
  Ok(Some(n as u8))
}

/// Validate all `myoxus:table-of-contents` blocks inside a Yjs binary snapshot.
/// Rejects children, non-string titles, out-of-range heading levels, and `minLevel > maxLevel`.
pub fn validate_snapshot(snapshot: &[u8]) -> Result<(), String> {
  if snapshot.is_empty() {
    return Ok(());
  }
  let doc = Doc::new();
  let mut txn = doc.transact_mut();
  txn
    .apply_update(Update::decode_v1(snapshot).map_err(|_| "invalid document snapshot")?)
    .map_err(|_| "invalid document snapshot")?;
  let Some(blocks) = txn.get_map("blocks") else {
    return Ok(());
  };
  for (_, value) in blocks.iter(&txn) {
    let Out::YMap(block) = value else { continue };
    let flavour = match block.get(&txn, "sys:flavour") {
      Some(Out::Any(yrs::Any::String(v))) => v.as_ref().to_string(),
      _ => continue,
    };
    if crate::resolve_flavour(&flavour) != "myoxus:table-of-contents" {
      continue;
    }
    if let Some(Out::YArray(children)) = block.get(&txn, "sys:children")
      && children.len(&txn) > 0
    {
      return Err("table-of-contents block must not contain children".into());
    }
    if let Some(title) = block.get(&txn, "prop:title") {
      match title {
        Out::Any(yrs::Any::String(_) | yrs::Any::Null | yrs::Any::Undefined) => {}
        _ => return Err("invalid table-of-contents title".into()),
      }
    }
    let min_level = read_level_prop(&block, &txn, "minLevel")?.unwrap_or(1);
    let max_level = read_level_prop(&block, &txn, "maxLevel")?.unwrap_or(3);
    if min_level > max_level {
      return Err("table-of-contents minLevel must not exceed maxLevel".into());
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::{PortableSnapshotBlock, extract_text_from_yjs, snapshot_blocks_to_yjs};

  fn block(id: &str, flavour: &str, props: serde_json::Value, children: &[&str]) -> PortableSnapshotBlock {
    PortableSnapshotBlock {
      id: id.into(),
      flavour: flavour.into(),
      version: None,
      props: props.as_object().cloned().unwrap_or_default(),
      children: children.iter().map(|c| (*c).to_string()).collect(),
    }
  }

  #[test]
  fn validate_snapshot_accepts_valid_and_rejects_malformed_toc_blocks() {
    let valid = snapshot_blocks_to_yjs(&[
      block("page", "myoxus:page", serde_json::json!({}), &["note"]),
      block("note", "myoxus:note", serde_json::json!({}), &["toc"]),
      block(
        "toc",
        "myoxus:table-of-contents",
        serde_json::json!({ "title": "On this page", "minLevel": 2, "maxLevel": 4 }),
        &[],
      ),
    ])
    .unwrap();
    assert!(validate_snapshot(&valid).is_ok());

    let inverted = snapshot_blocks_to_yjs(&[
      block("page", "myoxus:page", serde_json::json!({}), &["note"]),
      block("note", "myoxus:note", serde_json::json!({}), &["toc"]),
      block(
        "toc",
        "myoxus:table-of-contents",
        serde_json::json!({ "minLevel": 4, "maxLevel": 2 }),
        &[],
      ),
    ])
    .unwrap();
    assert!(validate_snapshot(&inverted).is_err());

    let out_of_range = snapshot_blocks_to_yjs(&[
      block("page", "myoxus:page", serde_json::json!({}), &["note"]),
      block("note", "myoxus:note", serde_json::json!({}), &["toc"]),
      block(
        "toc",
        "myoxus:table-of-contents",
        serde_json::json!({ "minLevel": 1, "maxLevel": 7 }),
        &[],
      ),
    ])
    .unwrap();
    assert!(validate_snapshot(&out_of_range).is_err());

    let with_children = snapshot_blocks_to_yjs(&[
      block("page", "myoxus:page", serde_json::json!({}), &["note"]),
      block("note", "myoxus:note", serde_json::json!({}), &["toc"]),
      block("toc", "myoxus:table-of-contents", serde_json::json!({}), &["p"]),
      block(
        "p",
        "myoxus:paragraph",
        serde_json::json!({ "text": "Illegal child" }),
        &[],
      ),
    ])
    .unwrap();
    assert!(validate_snapshot(&with_children).is_err());
  }

  #[test]
  fn markdown_export_emits_scoped_toc_links_with_duplicate_slugs() {
    let payload = snapshot_blocks_to_yjs(&[
      block("page", "myoxus:page", serde_json::json!({ "title": "Wiki" }), &["note"]),
      block(
        "note",
        "myoxus:note",
        serde_json::json!({}),
        &["toc", "h1", "callout", "h2-dup", "embed1:embed:h2-embedded"],
      ),
      block(
        "toc",
        "myoxus:table-of-contents",
        serde_json::json!({ "title": "Contents", "minLevel": 1, "maxLevel": 2 }),
        &[],
      ),
      block(
        "h1",
        "myoxus:paragraph",
        serde_json::json!({ "type": "h1", "text": "Overview" }),
        &[],
      ),
      block(
        "callout",
        "myoxus:callout",
        serde_json::json!({}),
        &["nested-h2", "nested-h3"],
      ),
      block(
        "nested-h2",
        "myoxus:paragraph",
        serde_json::json!({ "type": "h2", "text": "Overview" }),
        &[],
      ),
      block(
        "nested-h3",
        "myoxus:paragraph",
        serde_json::json!({ "type": "h3", "text": "Ignored H3" }),
        &[],
      ),
      block(
        "h2-dup",
        "myoxus:paragraph",
        serde_json::json!({ "type": "h2", "text": "Details" }),
        &[],
      ),
      block(
        "embed1:embed:h2-embedded",
        "myoxus:paragraph",
        serde_json::json!({ "type": "h2", "text": "Embedded Secret Heading" }),
        &[],
      ),
    ])
    .unwrap();
    let exported = extract_text_from_yjs(&payload).unwrap();
    assert!(exported.markdown.contains("**Contents**"));
    assert!(exported.markdown.contains("- [Overview](#overview)"));
    assert!(exported.markdown.contains("  - [Overview](#overview-2)"));
    assert!(exported.markdown.contains("  - [Details](#details)"));
    assert!(!exported.markdown.contains("Ignored H3](#"));
    assert!(!exported.markdown.contains("Embedded Secret Heading](#"));
  }
}
