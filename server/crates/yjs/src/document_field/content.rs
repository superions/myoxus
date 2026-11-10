// SPDX-License-Identifier: AGPL-3.0-or-later
//! Field traversal of caller-captured native content, never raw sync admission.

use std::collections::{HashMap, HashSet};
use yrs::{Any, Doc, Map, Out, ReadTxn, Text, Transact, types::Attrs, updates::decoder::Decode};

use super::{CAPTURE_ATTRIBUTE, DocumentField, FIELD_ATTRIBUTE, FieldRun};

pub use super::fingerprint::fingerprint_input;

/// One identity map belongs to one copied subtree/row. Frozen formatting runs
/// collapse to one live occurrence; ordinary copied fields retain their answers.
pub(crate) fn remap_chunks(
  chunks: &[(String, Attrs)],
  identities: &mut HashMap<String, String>,
) -> Result<Vec<(String, Attrs)>, &'static str> {
  let mut result = Vec::with_capacity(chunks.len());
  let mut previous: Option<DocumentField> = None;
  for (text, attrs) in chunks {
    let Some(run) = FieldRun::decode(text, attrs)? else {
      previous = None;
      result.push((text.clone(), attrs.clone()));
      continue;
    };
    if run.captured && previous.as_ref() == Some(&run.descriptor) {
      continue;
    }
    let id = identities
      .entry(run.descriptor.id().to_owned())
      .or_insert_with(|| uuid::Uuid::new_v4().to_string());
    let copied = run.with_descriptor(run.descriptor.clone_occurrence(id.clone())?)?;
    previous = run.captured.then_some(run.descriptor);
    let copied = if copied.captured { copied.reactivate() } else { copied };
    result.push((copied.text, copied.attributes));
  }
  Ok(result)
}

pub(crate) fn remap_copied_text(
  text: &yrs::TextRef,
  txn: &mut yrs::TransactionMut<'_>,
  identities: &mut HashMap<String, String>,
) -> Result<(), &'static str> {
  let mut offset = 0;
  let mut changes: Vec<(u32, u32, FieldRun)> = Vec::new();
  let mut previous: Option<DocumentField> = None;
  for chunk in text.diff(txn, |_| ()) {
    let Out::Any(Any::String(value)) = chunk.insert else {
      previous = None;
      offset += 1;
      continue;
    };
    let attrs = chunk.attributes.map(|attrs| *attrs).unwrap_or_default();
    if let Some(run) = FieldRun::decode(&value, &attrs)? {
      if run.captured && previous.as_ref() == Some(&run.descriptor) {
        changes.last_mut().ok_or("native copied field missing")?.1 += value.len() as u32;
        offset += value.len() as u32;
        continue;
      }
      let id = identities
        .entry(run.descriptor.id().to_owned())
        .or_insert_with(|| uuid::Uuid::new_v4().to_string());
      let copied = run.with_descriptor(run.descriptor.clone_occurrence(id.clone())?)?;
      previous = run.captured.then_some(run.descriptor);
      changes.push((offset, value.len() as u32, copied));
    } else {
      previous = None;
    }
    offset += value.len() as u32;
  }
  // Work backwards so collapsing a frozen multi-run occurrence cannot shift
  // the coordinates of another copied field in this detached text.
  for (offset, length, copied) in changes.into_iter().rev() {
    if copied.captured {
      let live = copied.reactivate();
      text.remove_range(txn, offset, length);
      text.insert_with_attributes(txn, offset, &live.text, live.attributes);
    } else {
      text.format(
        txn,
        offset,
        length,
        Attrs::from([(FIELD_ATTRIBUTE.into(), copied.attributes[FIELD_ATTRIBUTE].clone())]),
      );
    }
  }
  Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub struct FieldOccurrence {
  pub block_id: String,
  pub property: String,
  /// Yrs byte coordinates. Editor commands use UTF-16 independently.
  pub start: u32,
  pub length: u32,
  pub run: FieldRun,
}

/// Native body owners admitted for fields, shared with bounded read extraction.
pub fn supports_position(flavour: &str, property: &str) -> bool {
  matches!(
    (flavour, property),
    (
      "myoxus:paragraph" | "myoxus:list" | "myoxus:callout" | "myoxus:footnote-definition",
      "prop:text" | "text"
    ) | ("myoxus:callout", "prop:title" | "title")
  ) || (flavour == "myoxus:table"
    && property
      .strip_prefix("prop:cells.")
      .and_then(|key| key.strip_suffix(".text"))
      .is_some_and(|key| {
        key
          .split_once(':')
          .is_some_and(|(row, column)| !row.is_empty() && !column.is_empty())
      }))
}

/// Retain field-free unknown/native properties. A descriptor does not authorize
/// adding fields to document titles, code or opaque property payloads.
pub fn inspect_in_tx(blocks: &yrs::MapRef, txn: &impl ReadTxn) -> Result<Vec<FieldOccurrence>, &'static str> {
  let mut result = Vec::new();
  let mut seen = HashSet::new();
  for (id, value) in blocks.iter(txn) {
    let Out::YMap(block) = value else { continue };
    let flavour = match block.get(txn, "sys:flavour").or_else(|| block.get(txn, "flavour")) {
      Some(Out::Any(Any::String(value))) => crate::resolve_flavour(&value).to_string(),
      _ => String::new(),
    };
    for (property, value) in block.iter(txn) {
      let Out::YText(text) = value else { continue };
      let mut start = 0;
      let mut previous: Option<DocumentField> = None;
      for chunk in text.diff(txn, |_| ()) {
        let length = match &chunk.insert {
          Out::Any(Any::String(value)) => value.len() as u32,
          _ => 1,
        };
        let run = match chunk.attributes.as_deref() {
          Some(attributes)
            if attributes.contains_key(FIELD_ATTRIBUTE) || attributes.contains_key(CAPTURE_ATTRIBUTE) =>
          {
            let Out::Any(Any::String(value)) = &chunk.insert else {
              return Err("native field requires attributed text");
            };
            FieldRun::decode(value, attributes)?
          }
          _ => None,
        };
        if let Some(run) = run {
          if !supports_position(&flavour, property) {
            return Err("unsupported native field position");
          }
          // A captured occurrence can span adjacent differently marked runs.
          let continuation = run.captured && previous.as_ref() == Some(&run.descriptor);
          if !continuation && !seen.insert(run.descriptor.id().to_string()) {
            return Err("duplicate native field identity");
          }
          previous = run.captured.then(|| run.descriptor.clone());
          result.push(FieldOccurrence {
            block_id: id.into(),
            property: property.into(),
            start,
            length,
            run,
          });
        } else {
          previous = None;
        }
        start += length;
      }
    }
  }
  Ok(result)
}

fn decode(snapshot: &[u8]) -> Result<(Doc, yrs::MapRef), &'static str> {
  let doc = Doc::with_options(yrs::Options {
    offset_kind: yrs::OffsetKind::Bytes,
    ..Default::default()
  });
  doc
    .transact_mut()
    .apply_update(yrs::Update::decode_v1(snapshot).map_err(|_| "invalid native field snapshot")?)
    .map_err(|_| "invalid native field snapshot")?;
  let blocks = doc.get_or_insert_map("blocks");
  Ok((doc, blocks))
}

pub fn inspect(snapshot: &[u8]) -> Result<Vec<FieldOccurrence>, &'static str> {
  let (doc, blocks) = decode(snapshot)?;
  inspect_in_tx(&blocks, &doc.transact())
}

pub struct FieldContentUpdate {
  pub state: Vec<u8>,
  /// None preserves exact original bytes, including all field-free documents.
  pub delta: Option<Vec<u8>>,
}

/// Reactivate a validated historical capture in a detached native copy. One
/// occurrence may span several differently formatted frozen runs; collapse its
/// complete span to one live atom with the first run's surrounding marks.
/// The caller owns historical admission and must reject uncaptured fields.
pub fn reactivate_capture(snapshot: &[u8]) -> Result<FieldContentUpdate, &'static str> {
  let (doc, blocks) = decode(snapshot)?;
  let mut fields: Vec<FieldOccurrence> = Vec::new();
  for occurrence in inspect_in_tx(&blocks, &doc.transact())? {
    if !occurrence.run.captured {
      return Err("native historical field is not captured");
    }
    if let Some(previous) = fields.last_mut()
      && previous.block_id == occurrence.block_id
      && previous.property == occurrence.property
      && previous.start + previous.length == occurrence.start
      && previous.run.descriptor == occurrence.run.descriptor
    {
      previous.length += occurrence.length;
      continue;
    }
    fields.push(occurrence);
  }
  if fields.is_empty() {
    return Ok(FieldContentUpdate {
      state: snapshot.into(),
      delta: None,
    });
  }
  let mut txn = doc.transact_mut();
  let before = txn.state_vector();
  for occurrence in fields.into_iter().rev() {
    let Some(Out::YMap(block)) = blocks.get(&txn, &occurrence.block_id) else {
      return Err("native field owner missing");
    };
    let Some(Out::YText(text)) = block.get(&txn, &occurrence.property) else {
      return Err("native field text missing");
    };
    let live = occurrence.run.reactivate();
    text.remove_range(&mut txn, occurrence.start, occurrence.length);
    text.insert_with_attributes(&mut txn, occurrence.start, &live.text, live.attributes);
  }
  inspect_in_tx(&blocks, &txn)?;
  drop(txn);
  let txn = doc.transact();
  Ok(FieldContentUpdate {
    state: txn.encode_state_as_update_v1(&Default::default()),
    delta: Some(txn.encode_diff_v1(&before)),
  })
}

/// Materialize a complete native source as a new editable document. This is an
/// explicit copy/import boundary, not a synchronization or archival transform.
/// Every occurrence receives an independent ID; captured runs become live.
pub fn copy_for_editable_document(snapshot: &[u8]) -> Result<FieldContentUpdate, &'static str> {
  let (doc, blocks) = decode(snapshot)?;
  let owners = inspect_in_tx(&blocks, &doc.transact())?
    .into_iter()
    .map(|field| (field.block_id, field.property))
    .collect::<std::collections::BTreeSet<_>>();
  if owners.is_empty() {
    return Ok(FieldContentUpdate {
      state: snapshot.into(),
      delta: None,
    });
  }
  let mut txn = doc.transact_mut();
  let before = txn.state_vector();
  let mut identities = HashMap::new();
  for (block_id, property) in owners {
    let Some(Out::YMap(block)) = blocks.get(&txn, &block_id) else {
      return Err("native field owner missing");
    };
    let Some(Out::YText(text)) = block.get(&txn, &property) else {
      return Err("native field text missing");
    };
    remap_copied_text(&text, &mut txn, &mut identities)?;
  }
  inspect_in_tx(&blocks, &txn)?;
  drop(txn);
  let txn = doc.transact();
  Ok(FieldContentUpdate {
    state: txn.encode_state_as_update_v1(&Default::default()),
    delta: Some(txn.encode_diff_v1(&before)),
  })
}

/// Reading-only native copy. The result is ordinary display text, not editable
/// field content or an update to persist. Adjacent marked parts of one captured
/// occurrence are replaced once; surrounding text/marks remain untouched.
pub fn project_text(
  snapshot: &[u8],
  mut present: impl FnMut(&DocumentField) -> Result<String, &'static str>,
) -> Result<Vec<u8>, &'static str> {
  let (doc, blocks) = decode(snapshot)?;
  let mut fields: Vec<FieldOccurrence> = Vec::new();
  for occurrence in inspect_in_tx(&blocks, &doc.transact())? {
    if let Some(previous) = fields.last_mut()
      && previous.run.captured
      && occurrence.run.captured
      && previous.block_id == occurrence.block_id
      && previous.property == occurrence.property
      && previous.start + previous.length == occurrence.start
      && previous.run.descriptor == occurrence.run.descriptor
    {
      previous.length += occurrence.length;
      continue;
    }
    fields.push(occurrence);
  }
  if fields.is_empty() {
    return Ok(snapshot.to_vec());
  }
  let values = fields
    .into_iter()
    .map(|occurrence| {
      let text = present(&occurrence.run.descriptor)?;
      if text.is_empty() {
        return Err("native field output requires readable text");
      }
      Ok((occurrence, text))
    })
    .collect::<Result<Vec<_>, _>>()?;
  let mut txn = doc.transact_mut();
  for (occurrence, text) in values.into_iter().rev() {
    let Some(Out::YMap(block)) = blocks.get(&txn, &occurrence.block_id) else {
      return Err("native output owner missing");
    };
    let Some(Out::YText(owner)) = block.get(&txn, &occurrence.property) else {
      return Err("native output text missing");
    };
    let mut attributes = occurrence.run.attributes;
    attributes.remove(FIELD_ATTRIBUTE);
    attributes.remove(CAPTURE_ATTRIBUTE);
    owner.remove_range(&mut txn, occurrence.start, occurrence.length);
    owner.insert_with_attributes(&mut txn, occurrence.start, &text, attributes);
  }
  drop(txn);
  Ok(doc.transact().encode_state_as_update_v1(&Default::default()))
}

/// A field-specific transformation in an independent content copy. All proposed
/// runs are admitted before this copy is changed. Explicit write owners compose
/// its delta with their operation; synchronization never calls this helper.
#[tracing::instrument(skip_all)]
pub fn map(
  snapshot: &[u8],
  mut transform: impl FnMut(&FieldRun) -> Result<FieldRun, &'static str>,
) -> Result<FieldContentUpdate, &'static str> {
  let (doc, blocks) = decode(snapshot)?;
  let changes = {
    let txn = doc.transact();
    let mut changes = Vec::new();
    for occurrence in inspect_in_tx(&blocks, &txn)? {
      let next = transform(&occurrence.run)?;
      FieldRun::decode(&next.text, &next.attributes)?.ok_or("native field descriptor missing")?;
      if occurrence.run != next {
        changes.push((occurrence, next));
      }
    }
    changes
  };
  if changes.is_empty() {
    return Ok(FieldContentUpdate {
      state: snapshot.into(),
      delta: None,
    });
  }
  let mut txn = doc.transact_mut();
  let before = txn.state_vector();
  // Runs of each text owner are inspected in increasing native order.
  for (occurrence, next) in changes.into_iter().rev() {
    let Some(Out::YMap(block)) = blocks.get(&txn, &occurrence.block_id) else {
      return Err("native field owner missing");
    };
    let Some(Out::YText(text)) = block.get(&txn, &occurrence.property) else {
      return Err("native field text missing");
    };
    if occurrence.run.text == next.text {
      let mut attributes = Attrs::new();
      for (key, value) in &next.attributes {
        if occurrence.run.attributes.get(key) != Some(value) {
          attributes.insert(key.clone(), value.clone());
        }
      }
      for key in occurrence.run.attributes.keys() {
        if !next.attributes.contains_key(key) {
          attributes.insert(key.clone(), Any::Null);
        }
      }
      text.format(&mut txn, occurrence.start, occurrence.length, attributes);
    } else {
      text.remove_range(&mut txn, occurrence.start, occurrence.length);
      text.insert_with_attributes(&mut txn, occurrence.start, &next.text, next.attributes);
    }
  }
  inspect_in_tx(&blocks, &txn)?;
  // Match the committed copy used by persistence/hash readers, including Yrs'
  // transaction-final formatting cleanup. The delta still targets the capture.
  drop(txn);
  let txn = doc.transact();
  Ok(FieldContentUpdate {
    state: txn.encode_state_as_update_v1(&Default::default()),
    delta: Some(txn.encode_diff_v1(&before)),
  })
}
