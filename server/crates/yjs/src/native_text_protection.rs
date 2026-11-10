// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::{BTreeMap, HashSet};

use serde_json::{Value, json};
use yrs::{Any, Array, Doc, Map, MapRef, Out, ReadTxn, Text, Transact, Update, updates::decoder::Decode};

use crate::document_field::{CAPTURE_ATTRIBUTE, DocumentField, FIELD_ATTRIBUTE, FieldRun};

fn decode(snapshot: &[u8]) -> Result<Doc, String> {
  let doc = Doc::new();
  doc
    .transact_mut()
    .apply_update(Update::decode_v1(snapshot).map_err(|_| "invalid native protected content")?)
    .map_err(|_| "invalid native protected content")?;
  Ok(doc)
}

fn text_structure(text: &yrs::TextRef, txn: &impl ReadTxn) -> Result<Value, String> {
  let mut runs: Vec<(String, BTreeMap<String, Value>)> = Vec::new();
  let mut previous_capture = None;
  for chunk in text.diff(txn, |_| ()) {
    let Out::Any(Any::String(content)) = chunk.insert else {
      return Err("unsupported protected inline content".into());
    };
    let attrs = chunk.attributes.map(|attrs| *attrs).unwrap_or_default();
    let field = FieldRun::decode(&content, &attrs).map_err(str::to_owned)?;
    let mut attributes = attrs
      .iter()
      .filter(|(key, _)| key.as_ref() != FIELD_ATTRIBUTE && key.as_ref() != CAPTURE_ATTRIBUTE)
      .map(|(key, value)| {
        Ok((
          key.to_string(),
          crate::native_document_comparison::value(Out::Any(value.clone()), txn, 0)?,
        ))
      })
      .collect::<Result<BTreeMap<_, _>, String>>()?;
    let content = if let Some(field) = field {
      if field.captured && previous_capture.as_ref() == Some(&(field.descriptor.clone(), attributes.clone())) {
        continue;
      }
      previous_capture = field.captured.then_some((field.descriptor.clone(), attributes.clone()));
      let mut descriptor = serde_json::to_value(&field.descriptor).map_err(|_| "invalid protected field")?;
      if matches!(field.descriptor, DocumentField::Input { .. }) {
        descriptor
          .as_object_mut()
          .ok_or("invalid protected field")?
          .remove("value");
      }
      attributes.insert(FIELD_ATTRIBUTE.into(), descriptor);
      " ".to_string()
    } else {
      previous_capture = None;
      content.to_string()
    };
    if let Some((previous_text, previous_attrs)) = runs.last_mut()
      && *previous_attrs == attributes
      && !attributes.contains_key(FIELD_ATTRIBUTE)
    {
      previous_text.push_str(&content);
    } else {
      runs.push((content, attributes));
    }
  }
  Ok(json!(runs))
}

fn property(value: Out, txn: &impl ReadTxn) -> Result<Value, String> {
  if let Out::YText(text) = value {
    text_structure(&text, txn)
  } else {
    crate::native_document_comparison::value(value, txn, 0)
  }
}

fn reachable(blocks: &MapRef, txn: &impl ReadTxn) -> HashSet<String> {
  let mut pending: Vec<String> = blocks.iter(txn).filter_map(|(id, value)| {
    let Out::YMap(block) = value else { return None };
    matches!(block.get(txn, "sys:flavour"), Some(Out::Any(Any::String(value))) if crate::resolve_flavour(&value) == "myoxus:page")
      .then(|| id.to_string())
  }).collect();
  let mut visited = HashSet::new();
  while let Some(id) = pending.pop() {
    if !visited.insert(id.clone()) {
      continue;
    }
    let Some(Out::YMap(block)) = blocks.get(txn, &id) else {
      continue;
    };
    if let Some(Out::YArray(children)) = block.get(txn, "sys:children") {
      pending.extend(children.iter(txn).filter_map(|child| match child {
        Out::Any(Any::String(id)) => Some(id.to_string()),
        _ => None,
      }));
    }
  }
  visited
}

/// Preflight an explicit materialized server content operation. Compare only
/// existing fixed owners: layout and independent input values remain mutable.
/// This does not authorize or inspect raw synchronization updates.
pub fn preserves_fixed_text(current: &[u8], proposed: &[u8]) -> Result<bool, String> {
  let before = decode(current)?;
  let old_blocks = before.get_or_insert_map("blocks");
  let old_txn = before.transact();
  let fixed = markers(&old_blocks, &old_txn)?
    .into_iter()
    .filter(|(_, _, source)| !source)
    .collect::<Vec<_>>();
  if fixed.is_empty() {
    return Ok(true);
  }
  let after = decode(proposed)?;
  let new_blocks = after.get_or_insert_map("blocks");
  let new_txn = after.transact();
  let reachable = reachable(&new_blocks, &new_txn);
  for (block, marker, _) in fixed {
    let Some(Out::Any(Any::String(id))) = block.get(&old_txn, "sys:id") else {
      return Err("protected owner has no identity".into());
    };
    let Some(Out::YMap(next)) = new_blocks.get(&new_txn, &id) else {
      return Ok(false);
    };
    if !reachable.contains(id.as_ref())
      || next.get(&new_txn, "sys:id") != block.get(&old_txn, "sys:id")
      || next.get(&new_txn, &marker) != block.get(&old_txn, &marker)
      || next.get(&new_txn, "sys:flavour") != block.get(&old_txn, "sys:flavour")
    {
      return Ok(false);
    }
    if marker == "prop:textProtection" {
      let keys: HashSet<_> = block
        .keys(&old_txn)
        .chain(next.keys(&new_txn))
        .filter(|key| {
          key.starts_with("prop:")
            && !key.starts_with("prop:meta:")
            && *key != "prop:comments"
            && *key != "prop:checked"
            && *key != "prop:collapsed"
            && *key != "prop:order"
        })
        .collect();
      for key in keys {
        let old = block
          .get(&old_txn, key)
          .map(|value| property(value, &old_txn))
          .transpose()?;
        let new = next
          .get(&new_txn, key)
          .map(|value| property(value, &new_txn))
          .transpose()?;
        if old != new {
          return Ok(false);
        }
      }
    } else {
      let cell = marker
        .strip_prefix("prop:cells.")
        .and_then(|key| key.strip_suffix(".textProtection"))
        .ok_or("invalid protected cell")?;
      let prefix = format!("prop:cells.{cell}.");
      let keys: HashSet<_> = block
        .keys(&old_txn)
        .chain(next.keys(&new_txn))
        .filter(|key| key.starts_with(&prefix))
        .collect();
      for key in keys {
        let old = block
          .get(&old_txn, key)
          .map(|value| property(value, &old_txn))
          .transpose()?;
        let new = next
          .get(&new_txn, key)
          .map(|value| property(value, &new_txn))
          .transpose()?;
        if old != new {
          return Ok(false);
        }
      }
      let (row, column) = cell.split_once(':').ok_or("invalid protected cell")?;
      for key in [
        format!("prop:rows.{row}.rowId"),
        format!("prop:columns.{column}.columnId"),
      ] {
        if block.get(&old_txn, &key) != next.get(&new_txn, &key) || next.get(&new_txn, &key).is_none() {
          return Ok(false);
        }
      }
      for key in [
        format!("prop:rows.{row}.backgroundColor"),
        format!("prop:columns.{column}.backgroundColor"),
        format!("prop:columns.{column}.textAlign"),
      ] {
        if block.get(&old_txn, &key) != next.get(&new_txn, &key) {
          return Ok(false);
        }
      }
    }
  }
  Ok(true)
}

/// Inspect only native text owners; absence never introduces a persisted default.
fn markers<T: ReadTxn>(blocks: &MapRef, txn: &T) -> Result<Vec<(MapRef, String, bool)>, String> {
  let mut markers = Vec::new();
  for (_, value) in blocks.iter(txn) {
    let Out::YMap(block) = value else { continue };
    let Some(Out::Any(Any::String(flavour))) = block.get(txn, "sys:flavour") else {
      continue;
    };
    let flavour = crate::resolve_flavour(&flavour);
    for (key, value) in block.iter(txn) {
      let text_key = if key == "prop:textProtection" {
        if !matches!(flavour, "myoxus:paragraph" | "myoxus:list" | "myoxus:callout") {
          return Err("invalid native text protection owner".into());
        }
        "prop:text".to_owned()
      } else if flavour == "myoxus:table" && key.starts_with("prop:cells.") && key.ends_with(".textProtection") {
        format!("{}.text", key.trim_end_matches(".textProtection"))
      } else {
        continue;
      };
      if !matches!(block.get(txn, &text_key), Some(Out::YText(_))) {
        return Err("native text protection requires a text owner".into());
      }
      let source = match value {
        Out::Any(Any::String(value)) if value.as_ref() == "source" => true,
        Out::Any(Any::String(value)) if value.as_ref() == "fixed" => false,
        _ => return Err("invalid native text protection".into()),
      };
      markers.push((block.clone(), key.to_owned(), source));
    }
  }
  Ok(markers)
}

pub(crate) fn validate<T: ReadTxn>(blocks: &MapRef, txn: &T) -> Result<(), String> {
  markers(blocks, txn).map(|_| ())
}

/// Called only on the independent instantiation document, before repeat cloning.
/// Source copies and historical snapshots must retain their existing modes.
pub(crate) fn freeze(doc: &Doc, blocks: &MapRef) -> Result<(), String> {
  let mut txn = doc.transact_mut();
  let markers = markers(blocks, &txn)?;
  for (block, key, source) in markers {
    if source {
      block.insert(&mut txn, key, "fixed");
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use serde_json::json;

  fn protected_document(literal: &str, label: &str, answer: &str, mode: &str, attached: bool) -> Vec<u8> {
    let source = json!([
      {"id":"page","flavour":"myoxus:page","children":["note"]},
      {"id":"note","flavour":"myoxus:note","children":if attached { vec!["text"] } else { vec![] }},
      {"id":"text","flavour":"myoxus:paragraph","props":{
        "textProtection":mode,
        "text":{"$virgultum:internal:text$":true,"delta":[
          {"insert":literal,"attributes":{"bold":true}},
          {"insert":" ","attributes":{"documentField":{
            "type":"input","id":"answer","definition":{"kind":"text","label":label,"required":false},"value":answer
          }}}
        ]}
      }}
    ]);
    crate::snapshot_blocks_to_yjs(&serde_json::from_value::<Vec<crate::PortableSnapshotBlock>>(source).unwrap())
      .unwrap()
  }

  #[test]
  fn explicit_content_operations_preserve_fixed_structure_but_allow_answers() {
    let current = protected_document("Definition", "Answer", "Before", "fixed", true);
    let answer = protected_document("Definition", "Answer", "After {{literal}}", "fixed", true);
    assert_eq!(super::preserves_fixed_text(&current, &answer), Ok(true));
    let captured = crate::document_field::content::map(&answer, |run| run.freeze("Rendered answer".into())).unwrap();
    assert_eq!(super::preserves_fixed_text(&current, &captured.state), Ok(true));
    for proposed in [
      protected_document("Rewritten", "Answer", "Before", "fixed", true),
      protected_document("Definition", "Changed definition", "Before", "fixed", true),
      protected_document("Definition", "Answer", "Before", "source", true),
      protected_document("Definition", "Answer", "Before", "fixed", false),
    ] {
      assert_eq!(super::preserves_fixed_text(&current, &proposed), Ok(false));
    }
    let ordinary = protected_document("Free", "Answer", "Before", "source", true);
    assert_eq!(super::preserves_fixed_text(&ordinary, &answer), Ok(true));
  }

  #[test]
  fn fixed_cells_keep_their_owner_and_allow_table_geometry() {
    let source = json!([
      {"id":"page","flavour":"myoxus:page","children":["note"]},
      {"id":"note","flavour":"myoxus:note","children":["table"]},
      {"id":"table","flavour":"myoxus:table","props":{
        "rows":{"r":{"rowId":"r","order":"a0"}},
        "columns":{"c":{"columnId":"c","order":"a0","width":200}},
        "cells":{"r:c":{"text":{"$virgultum:internal:text$":true,"delta":[{"insert":"Definition"}]},"textProtection":"fixed"}}
      }}
    ]);
    let snapshot = |source: serde_json::Value| {
      crate::snapshot_blocks_to_yjs(&serde_json::from_value::<Vec<crate::PortableSnapshotBlock>>(source).unwrap())
        .unwrap()
    };
    let current = snapshot(source.clone());
    let mut geometry = source.clone();
    geometry[2]["props"]["columns"]["c"]["width"] = json!(350);
    geometry[2]["props"]["rows"]["r"]["order"] = json!("b0");
    assert_eq!(super::preserves_fixed_text(&current, &snapshot(geometry)), Ok(true));
    for property in ["cells", "rows", "columns"] {
      let mut removed = source.clone();
      removed[2]["props"][property] = json!({});
      assert_eq!(super::preserves_fixed_text(&current, &snapshot(removed)), Ok(false));
    }
  }

  #[test]
  fn snapshot_import_rejects_unknown_owner_modes_instead_of_unlocking_text() {
    for source in [
      json!([{"id":"text","flavour":"myoxus:paragraph","props":{
        "text":"Definition","textProtection":"future-mode"
      }}]),
      json!([{"id":"table","flavour":"myoxus:table","props":{
        "rows":{"r":{"rowId":"r","order":"a0"}},
        "columns":{"c":{"columnId":"c","order":"a0"}},
        "cells":{"r:c":{"text":{"$virgultum:internal:text$":true,"delta":[{"insert":"Definition"}]},"textProtection":"future-mode"}}
      }}]),
    ] {
      let source: Vec<crate::PortableSnapshotBlock> = serde_json::from_value(source).unwrap();
      assert!(crate::snapshot_blocks_to_yjs(&source).is_err());
    }
  }
}
