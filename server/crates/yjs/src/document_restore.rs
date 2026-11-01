// SPDX-License-Identifier: AGPL-3.0-or-later
//! Restore visible shared-type content as fresh operations, never by replaying
//! the old update (whose operations the current document already knows).

use std::collections::BTreeMap;

use thiserror::Error;
use yrs::types::{AsPrelim, Delta};
use yrs::updates::decoder::Decode;
use yrs::{Array, In, Map, ReadTxn, Text, Transact, Update, WriteTxn};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DocumentRestoreError {
  #[error("snapshot is not a complete valid Yjs document")]
  InvalidSnapshot,
  #[error("snapshot contains a shared type that cannot be restored losslessly")]
  UnsupportedType,
  #[error("snapshot and current document disagree on a root shared type")]
  RootTypeConflict,
}

/// Produce a Yjs-v1 delta against `current`, preserving logical IDs, rich-text
/// attributes, binary values and nested shared collections from `snapshot`.
/// Neither input is modified. Unsupported data fails before a delta is returned.
pub fn restore_document_snapshot(current: &[u8], snapshot: &[u8]) -> Result<Vec<u8>, DocumentRestoreError> {
  let target = load(snapshot)?;
  let doc = load(current)?;
  let desired = roots(&target)?;
  let existing = roots(&doc)?;
  for (name, value) in &desired {
    if let Some(previous) = existing.get(name)
      && std::mem::discriminant(previous) != std::mem::discriminant(value)
    {
      return Err(DocumentRestoreError::RootTypeConflict);
    }
  }

  let before = doc.transact().state_vector();
  let mut txn = doc.transact_mut();
  // Root identities cannot be deleted in Yjs. Clear only absent roots; preserve
  // existing shared collections so bound editor models observe restored values
  // instead of retaining detached maps/text with the same logical block ID.
  for (name, value) in &existing {
    if desired.contains_key(name) {
      continue;
    }
    match value {
      In::Map(_) => txn.get_or_insert_map(name.as_str()).clear(&mut txn),
      In::Array(_) => {
        let array = txn.get_or_insert_array(name.as_str());
        let len = array.len(&txn);
        array.remove_range(&mut txn, 0, len);
      }
      In::Text(_) => {
        let text = txn.get_or_insert_text(name.as_str());
        let len = text.len(&txn);
        text.remove_range(&mut txn, 0, len);
      }
      _ => return Err(DocumentRestoreError::UnsupportedType),
    }
  }
  for (name, value) in desired {
    match value {
      In::Map(values) => {
        let map = txn.get_or_insert_map(name);
        restore_map(&mut txn, &map, &values);
      }
      In::Array(values) => {
        let array = txn.get_or_insert_array(name);
        let len = array.len(&txn);
        array.remove_range(&mut txn, 0, len);
        for value in values.iter() {
          array.push_back(&mut txn, value.clone());
        }
      }
      In::Text(delta) => {
        let text = txn.get_or_insert_text(name);
        let len = text.len(&txn);
        text.remove_range(&mut txn, 0, len);
        text.apply_delta(&mut txn, delta.iter().cloned());
      }
      _ => return Err(DocumentRestoreError::UnsupportedType),
    }
  }
  Ok(txn.encode_diff_v1(&before))
}

fn restore_map(txn: &mut yrs::TransactionMut<'_>, map: &yrs::MapRef, values: &yrs::MapPrelim) {
  let removed: Vec<_> = map
    .keys(txn)
    .filter(|key| !values.contains_key(*key))
    .map(str::to_owned)
    .collect();
  for key in removed {
    map.remove(txn, &key);
  }
  for (key, value) in values.iter() {
    match (map.get(txn, key), value) {
      (Some(yrs::Out::YMap(map)), In::Map(values)) => restore_map(txn, &map, values),
      (Some(yrs::Out::YText(text)), In::Text(delta)) => {
        let len = text.len(txn);
        text.remove_range(txn, 0, len);
        text.apply_delta(txn, delta.iter().cloned());
      }
      (Some(yrs::Out::YArray(array)), In::Array(values)) => {
        let len = array.len(txn);
        array.remove_range(txn, 0, len);
        for value in values.iter() {
          array.push_back(txn, value.clone());
        }
      }
      (Some(yrs::Out::Any(previous)), In::Any(value)) if previous == *value => {}
      _ => {
        map.insert(txn, key.clone(), value.clone());
      }
    }
  }
}

fn load(bytes: &[u8]) -> Result<yrs::Doc, DocumentRestoreError> {
  let doc = yrs::Doc::new();
  if bytes.is_empty() {
    return Ok(doc);
  }
  let update = Update::decode_v1(bytes).map_err(|_| DocumentRestoreError::InvalidSnapshot)?;
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(update)
      .map_err(|_| DocumentRestoreError::InvalidSnapshot)?;
    if txn.store().pending_update().is_some() || txn.store().pending_ds().is_some() {
      return Err(DocumentRestoreError::InvalidSnapshot);
    }
  }
  Ok(doc)
}

fn roots(doc: &yrs::Doc) -> Result<BTreeMap<String, In>, DocumentRestoreError> {
  let txn = doc.transact();
  txn
    .root_refs()
    .map(|(name, value)| {
      let value = value.as_prelim(&txn);
      validate(&value)?;
      if !matches!(value, In::Map(_) | In::Array(_) | In::Text(_)) {
        return Err(DocumentRestoreError::UnsupportedType);
      }
      Ok((name.to_string(), value))
    })
    .collect()
}

fn validate(value: &In) -> Result<(), DocumentRestoreError> {
  match value {
    In::Any(_) => Ok(()),
    In::Map(values) => values.values().try_for_each(validate),
    In::Array(values) => values.iter().try_for_each(validate),
    In::Text(delta) => delta.iter().try_for_each(|item| match item {
      Delta::Inserted(value, _) => validate(value),
      _ => Err(DocumentRestoreError::UnsupportedType),
    }),
    // Native prelim cloning of subdocuments/weak links does not produce an
    // independent historical value. XML needs its own proven fidelity contract.
    _ => Err(DocumentRestoreError::UnsupportedType),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use yrs::{Any, ArrayPrelim, Doc, MapPrelim, StateVector, TextPrelim};

  fn snapshot(doc: &Doc) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(&StateVector::default())
  }

  #[test]
  fn restore_is_a_fresh_mergeable_delta_with_lossless_native_content() {
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    {
      let mut tx = doc.transact_mut();
      let page = blocks.insert(&mut tx, "page-id", MapPrelim::default());
      page.insert(&mut tx, "sys:children", ArrayPrelim::from(["text-id", "canvas-id"]));
      let text_block = blocks.insert(&mut tx, "text-id", MapPrelim::default());
      let text = text_block.insert(&mut tx, "prop:text", TextPrelim::new("State A"));
      text.format(&mut tx, 0, 5, [("bold".into(), Any::Bool(true))].into());
      text_block.insert(&mut tx, "prop:sourceId", "retained-blob-id");
      text_block.insert(&mut tx, "binary", Any::Buffer(vec![0, 255, 42].into()));
      let canvas = blocks.insert(&mut tx, "canvas-id", MapPrelim::default());
      canvas.insert(
        &mut tx,
        "prop:elements",
        MapPrelim::from([(
          "shape-id",
          In::Map(MapPrelim::from([("xywh", In::from("[1,2,30,40]"))])),
        )]),
      );
    }
    let a = snapshot(&doc);
    {
      let mut tx = doc.transact_mut();
      blocks.remove(&mut tx, "text-id");
      blocks.insert(&mut tx, "new-id", "State B");
    }
    let b = snapshot(&doc);
    let original_sequence = doc.transact().state_vector();
    // Replaying A was the old implementation: it must demonstrably keep B.
    doc.transact_mut().apply_update(Update::decode_v1(&a).unwrap()).unwrap();
    assert_eq!(roots(&doc).unwrap(), roots(&load(&b).unwrap()).unwrap());

    let delta = restore_document_snapshot(&b, &a).unwrap();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&delta).unwrap())
      .unwrap();
    assert_eq!(
      roots(&load(&snapshot(&doc)).unwrap()).unwrap(),
      roots(&load(&a).unwrap()).unwrap()
    );
    for (client, clock) in original_sequence.iter() {
      assert!(
        doc.transact().state_vector().get(client) >= *clock,
        "history must not reset the update chain"
      );
    }
    let recovery_delta = restore_document_snapshot(&snapshot(&doc), &b).unwrap();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&recovery_delta).unwrap())
      .unwrap();
    assert_eq!(
      roots(&load(&snapshot(&doc)).unwrap()).unwrap(),
      roots(&load(&b).unwrap()).unwrap()
    );
  }

  #[test]
  fn existing_editor_bindings_observe_restored_text_and_maps() {
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let paragraph = blocks.insert(&mut doc.transact_mut(), "paragraph", MapPrelim::default());
    let text = paragraph.insert(&mut doc.transact_mut(), "prop:text", TextPrelim::new("A"));
    let a = snapshot(&doc);
    text.insert(&mut doc.transact_mut(), 1, "B");
    let delta = restore_document_snapshot(&snapshot(&doc), &a).unwrap();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&delta).unwrap())
      .unwrap();
    assert_eq!(
      paragraph,
      blocks
        .get(&doc.transact(), "paragraph")
        .unwrap()
        .cast::<yrs::MapRef>()
        .unwrap()
    );
    assert_eq!(
      text,
      paragraph
        .get(&doc.transact(), "prop:text")
        .unwrap()
        .cast::<yrs::TextRef>()
        .unwrap()
    );
    assert_eq!(yrs::GetString::get_string(&text, &doc.transact()), "A");
  }

  #[test]
  fn rejects_corrupt_incomplete_and_unsupported_snapshots() {
    let empty = snapshot(&Doc::new());
    assert_eq!(
      restore_document_snapshot(&empty, &[255]),
      Err(DocumentRestoreError::InvalidSnapshot)
    );
    let doc = Doc::new();
    let text = doc.get_or_insert_text("content");
    text.insert(&mut doc.transact_mut(), 0, "A");
    let before = doc.transact().state_vector();
    text.insert(&mut doc.transact_mut(), 1, "B");
    let incomplete = doc.transact().encode_state_as_update_v1(&before);
    assert_eq!(
      restore_document_snapshot(&empty, &incomplete),
      Err(DocumentRestoreError::InvalidSnapshot)
    );
    let nested = Doc::new();
    nested
      .get_or_insert_map("blocks")
      .insert(&mut nested.transact_mut(), "subdoc", Doc::new());
    assert_eq!(
      restore_document_snapshot(&empty, &snapshot(&nested)),
      Err(DocumentRestoreError::UnsupportedType)
    );
  }
}
