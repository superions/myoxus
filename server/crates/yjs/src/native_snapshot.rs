// SPDX-License-Identifier: AGPL-3.0-or-later
//! Lossless native content capture in the existing portable Snapshot model.

use std::collections::{BTreeMap, HashSet};

use serde_json::{Map as JsonMap, Value, json};
use tracing::instrument;
use yrs::types::text::YChange;
use yrs::updates::decoder::Decode;
use yrs::{Any, Array, Doc, Map, Out, ReadTxn, Text, Transact, Update};

use crate::{NATIVE_BOXED_MARKER, PortableSnapshotBlock, SNAPSHOT_NATIVE_MARKERS, resolve_flavour};

const MAX_DEPTH: usize = 256;
const TEXT_MARKER: &str = "$virgultum:internal:text$";
const SURFACE_TEXT_MARKER: &str = "myoxus:surface:text";
const SURFACE_MAP_MARKER: &str = "myoxus:surface:ymap";

/// Capture a complete persisted leaf without changing it or resolving template
/// variables. The caller supplies authorized canonical metadata and owns media
/// closure and archive limits. Registration and workspace metadata are excluded.
///
/// Shared text/maps/arrays and Boxed values retain the existing Snapshot markers.
/// Ordinary JSON collections become editable shared collections on import;
/// undefined ordinary object fields use the existing JSON absence semantics.
/// Values that JSON or the existing materializer cannot reconstruct are rejected;
/// this is not the lossy display-text projection used by search or Markdown.
#[instrument(skip_all)]
pub fn document_to_snapshot(document_update: &[u8], document_id: &str, title: &str) -> Result<Value, String> {
  if document_id.is_empty() || document_id.trim() != document_id {
    return Err("native snapshot requires a canonical document identity".into());
  }
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(document_update).map_err(|_| "invalid native snapshot update")?)
      .map_err(|_| "invalid native snapshot update")?;
    if txn.store().pending_update().is_some() || txn.store().pending_ds().is_some() {
      return Err("native snapshot requires a complete document update".into());
    }
  }
  let txn = doc.transact();
  for (name, _) in txn.root_refs() {
    if name == "blocks" {
      continue;
    }
    // DocsStore records creation intent on every newly authored leaf. These
    // lifecycle markers are not portable content and must not accompany a copy.
    if name == "meta"
      && let Some(meta) = txn.get_map("meta")
      && meta.iter(&txn).all(|(key, value)| {
        matches!(key, "pageCreationId" | "pageCreationIntent") && matches!(value, Out::Any(Any::String(_)))
      })
    {
      continue;
    }
    return Err("native snapshot cannot represent additional shared roots".into());
  }
  let mut captured = BTreeMap::new();
  let mut page = None;
  for (id, value) in blocks.iter(&txn) {
    let Out::YMap(block) = value else {
      return Err("native snapshot block must be a shared map".into());
    };
    let flavour = string(block.get(&txn, "sys:flavour"))?;
    if flavour == "affine:heading" {
      return Err("native snapshot cannot normalize a legacy heading losslessly".into());
    }
    let flavour = resolve_flavour(&flavour).to_string();
    if id.is_empty() || id.trim() != id || string(block.get(&txn, "sys:id"))? != id {
      return Err("native snapshot block identity is invalid".into());
    }
    if flavour == "myoxus:page" && page.replace(id.to_string()).is_some() {
      return Err("native snapshot requires exactly one page root".into());
    }
    let version = block
      .get(&txn, "sys:version")
      .map(|value| match value {
        Out::Any(Any::Number(value)) => value
          .as_f64()
          .and_then(|_| value.as_i64())
          .and_then(|value| u64::try_from(value).ok())
          .ok_or_else(|| "native snapshot block version must be an unsigned integer".to_string()),
        _ => Err("native snapshot block version must be an unsigned integer".into()),
      })
      .transpose()?;
    let Some(Out::YArray(children)) = block.get(&txn, "sys:children") else {
      return Err("native snapshot children must be a shared array".into());
    };
    let children = children
      .iter(&txn)
      .map(|child| string(Some(child)))
      .collect::<Result<_, _>>()?;
    let mut props = JsonMap::new();
    let properties: BTreeMap<_, _> = block.iter(&txn).collect();
    for (key, value) in properties {
      if matches!(key, "sys:id" | "sys:flavour" | "sys:version" | "sys:children") {
        continue;
      }
      let key = key
        .strip_prefix("prop:")
        .filter(|key| !key.is_empty())
        .ok_or("native snapshot block has an unsupported system property")?;
      if matches!(value, Out::Any(Any::Undefined)) {
        // FlatSyncController persists some unset optional defaults. JSON
        // Snapshot objects represent those as absent, just like the editor.
        continue;
      }
      if crate::snapshot_property_is_rich_text(&flavour, key) && !matches!(&value, Out::YText(_)) {
        return Err("native snapshot text property must be shared rich text".into());
      }
      let value = if crate::snapshot_property_is_opaque_reference(&flavour, key) {
        let Out::Any(value) = value else {
          return Err("native snapshot reserved reference must retain its raw representation".into());
        };
        json_value(&value, 0)?
      } else if flavour == "myoxus:surface" && key == "elements" {
        surface_elements(value, &txn)?
      } else {
        // Plain-object table fields are dotted leaves, never direct Y.Maps.
        if flavour == "myoxus:table" && matches!(&value, Out::YMap(map) if !is_boxed(map, &txn)) {
          return Err("native snapshot table contains an unrepresentable shared map".into());
        }
        native_value(value, &txn, 0)?
      };
      if flavour == "myoxus:table" {
        insert_flat_property(&mut props, key, value, 0)?;
      } else {
        props.insert(key.to_string(), value);
      }
    }
    captured.insert(
      id.to_string(),
      PortableSnapshotBlock {
        id: id.to_string(),
        flavour,
        version,
        children,
        props,
      },
    );
  }
  let page = page.ok_or("native snapshot requires exactly one page root")?;
  let mut visited = HashSet::new();
  validate_tree(&page, &captured, &mut visited, 0)?;
  if visited.len() != captured.len() {
    return Err("native snapshot has unreachable blocks".into());
  }
  Ok(json!({
    "meta": { "id": document_id, "title": title },
    "blocks": captured.into_values().collect::<Vec<_>>()
  }))
}

fn string(value: Option<Out>) -> Result<String, String> {
  match value {
    Some(Out::Any(Any::String(value))) => Ok(value.to_string()),
    _ => Err("native snapshot requires a string identity or flavour".into()),
  }
}

fn check_depth(depth: usize) -> Result<(), String> {
  if depth > MAX_DEPTH {
    return Err("native snapshot nesting limit exceeded".into());
  }
  Ok(())
}

fn validate_tree(
  id: &str,
  blocks: &BTreeMap<String, PortableSnapshotBlock>,
  visited: &mut HashSet<String>,
  depth: usize,
) -> Result<(), String> {
  check_depth(depth)?;
  if !visited.insert(id.to_string()) {
    return Err("native snapshot children are cyclic or duplicated".into());
  }
  let block = blocks.get(id).ok_or("native snapshot child is missing")?;
  for child in &block.children {
    validate_tree(child, blocks, visited, depth + 1)?;
  }
  Ok(())
}

fn insert_flat_property(
  props: &mut JsonMap<String, Value>,
  key: &str,
  value: Value,
  depth: usize,
) -> Result<(), String> {
  check_depth(depth)?;
  let (head, tail) = key
    .split_once('.')
    .map_or((key, None), |(head, tail)| (head, Some(tail)));
  if head.is_empty() {
    return Err("native snapshot table property path is invalid".into());
  }
  if let Some(tail) = tail {
    let nested = props.entry(head.to_string()).or_insert_with(|| json!({}));
    if crate::snapshot_marker(nested, &crate::SNAPSHOT_TEXT_MARKERS).is_some()
      || crate::snapshot_marker(nested, &SNAPSHOT_NATIVE_MARKERS).is_some()
    {
      return Err("native snapshot table property paths overlap".into());
    }
    let nested = nested
      .as_object_mut()
      .ok_or("native snapshot table property paths overlap")?;
    insert_flat_property(nested, tail, value, depth + 1)
  } else if props.insert(head.to_string(), value).is_some() {
    Err("native snapshot table property paths overlap".into())
  } else {
    Ok(())
  }
}

fn is_boxed<T: ReadTxn>(map: &yrs::MapRef, txn: &T) -> bool {
  matches!(map.get(txn, "type"), Some(Out::Any(Any::String(marker))) if SNAPSHOT_NATIVE_MARKERS.contains(&marker.as_ref()))
}

fn native_value<T: ReadTxn>(value: Out, txn: &T, depth: usize) -> Result<Value, String> {
  check_depth(depth)?;
  match value {
    Out::YText(text) => text_value(&text, txn, TEXT_MARKER, depth + 1),
    Out::YArray(array) => array
      .iter(txn)
      .map(|value| native_value(value, txn, depth + 1))
      .collect::<Result<Vec<_>, _>>()
      .map(Value::Array),
    Out::YMap(map) if is_boxed(&map, txn) => {
      if map.len(txn) != 2 {
        return Err("native snapshot Boxed value has unsupported fields".into());
      }
      let Some(Out::Any(value)) = map.get(txn, "value") else {
        return Err("native snapshot cannot represent this Boxed shared value".into());
      };
      Ok(json!({ NATIVE_BOXED_MARKER: true, "value": json_value(&value, depth + 1)? }))
    }
    Out::YMap(map) => {
      let object = object_value(&map, txn, depth + 1)?;
      if crate::snapshot_marker(&object, &crate::SNAPSHOT_TEXT_MARKERS).is_some()
        || crate::snapshot_marker(&object, &SNAPSHOT_NATIVE_MARKERS).is_some()
      {
        return Err("native snapshot shared object collides with a reserved marker".into());
      }
      Ok(object)
    }
    Out::Any(value) => ordinary_json_value(&value, depth),
    _ => Err("native snapshot contains an unsupported shared value".into()),
  }
}

fn object_value<T: ReadTxn>(map: &yrs::MapRef, txn: &T, depth: usize) -> Result<Value, String> {
  check_depth(depth)?;
  let values = map
    .iter(txn)
    .filter(|(_, value)| !matches!(value, Out::Any(Any::Undefined)))
    .map(|(key, value)| Ok((key.to_string(), native_value(value, txn, depth + 1)?)))
    .collect::<Result<BTreeMap<_, _>, String>>()?;
  Ok(Value::Object(values.into_iter().collect()))
}

fn ordinary_json_value(value: &Any, depth: usize) -> Result<Value, String> {
  check_depth(depth)?;
  let value = match value {
    Any::Map(values) => Value::Object(
      values
        .iter()
        .filter(|(_, value)| !matches!(value, Any::Undefined))
        .map(|(key, value)| Ok((key.to_string(), ordinary_json_value(value, depth + 1)?)))
        .collect::<Result<BTreeMap<_, _>, String>>()?
        .into_iter()
        .collect(),
    ),
    Any::Array(values) => Value::Array(
      values
        .iter()
        .map(|value| ordinary_json_value(value, depth + 1))
        .collect::<Result<_, _>>()?,
    ),
    _ => json_value(value, depth)?,
  };
  if crate::snapshot_marker(&value, &crate::SNAPSHOT_TEXT_MARKERS).is_some()
    || crate::snapshot_marker(&value, &SNAPSHOT_NATIVE_MARKERS).is_some()
  {
    return Err("native snapshot JSON object collides with a reserved marker".into());
  }
  Ok(value)
}

fn text_value<T: ReadTxn>(text: &yrs::TextRef, txn: &T, marker: &str, depth: usize) -> Result<Value, String> {
  check_depth(depth)?;
  let delta = text
    .diff(txn, YChange::identity)
    .into_iter()
    .map(|chunk| {
      let Out::Any(Any::String(insert)) = chunk.insert else {
        return Err("native snapshot rich text contains an unsupported embedded value".to_string());
      };
      let attributes = chunk
        .attributes
        .unwrap_or_default()
        .iter()
        .map(|(key, value)| Ok((key.to_string(), json_value(value, depth + 1)?)))
        .collect::<Result<BTreeMap<_, _>, String>>()?;
      let mut operation = JsonMap::new();
      operation.insert("insert".into(), Value::String(insert.to_string()));
      if !attributes.is_empty() {
        operation.insert("attributes".into(), Value::Object(attributes.into_iter().collect()));
      }
      Ok(Value::Object(operation))
    })
    .collect::<Result<Vec<_>, _>>()?;
  Ok(json!({ marker: true, "delta": delta }))
}

fn json_value(value: &Any, depth: usize) -> Result<Value, String> {
  check_depth(depth)?;
  Ok(match value {
    Any::Null => Value::Null,
    Any::Bool(value) => Value::Bool(*value),
    Any::String(value) => Value::String(value.to_string()),
    Any::Number(value) => Value::Number(
      value
        .as_f64()
        .and_then(serde_json::Number::from_f64)
        .ok_or("native snapshot numeric value cannot be represented losslessly")?,
    ),
    Any::Array(values) => Value::Array(
      values
        .iter()
        .map(|value| json_value(value, depth + 1))
        .collect::<Result<_, _>>()?,
    ),
    Any::Map(values) => Value::Object(
      values
        .iter()
        .map(|(key, value)| Ok((key.to_string(), json_value(value, depth + 1)?)))
        .collect::<Result<BTreeMap<_, _>, String>>()?
        .into_iter()
        .collect(),
    ),
    Any::Undefined | Any::BigInt(_) | Any::Buffer(_) => {
      return Err("native snapshot contains a value outside the JSON data model".into());
    }
  })
}

fn surface_elements<T: ReadTxn>(value: Out, txn: &T) -> Result<Value, String> {
  let Out::YMap(boxed) = value else {
    return Err("native snapshot surface elements must be Boxed".into());
  };
  if !is_boxed(&boxed, txn) || boxed.len(txn) != 2 {
    return Err("native snapshot surface elements must be Boxed".into());
  }
  let Some(Out::YMap(elements)) = boxed.get(txn, "value") else {
    return Err("native snapshot surface elements must contain a shared map".into());
  };
  let mut output = BTreeMap::new();
  for (id, element) in elements.iter(txn) {
    let Out::YMap(element) = element else {
      return Err("native snapshot surface element must be a shared map".into());
    };
    let mut properties = BTreeMap::new();
    for (key, value) in element.iter(txn) {
      if matches!(value, Out::Any(Any::Undefined)) {
        continue;
      }
      let value = match value {
        Out::YText(text) => text_value(&text, txn, SURFACE_TEXT_MARKER, 0)?,
        Out::YMap(map) => {
          let mut values = BTreeMap::new();
          for (key, value) in map.iter(txn) {
            if matches!(value, Out::Any(Any::Undefined)) {
              continue;
            }
            let Out::Any(value) = value else {
              return Err("native snapshot surface map contains an unsupported shared value".into());
            };
            values.insert(key.to_string(), json_value(&value, 0)?);
          }
          json!({ SURFACE_MAP_MARKER: true, "json": values })
        }
        Out::Any(value) => {
          let value = json_value(&value, 0)?;
          if crate::snapshot_marker(&value, &crate::SNAPSHOT_SURFACE_TEXT_MARKERS).is_some()
            || crate::snapshot_marker(&value, &crate::SNAPSHOT_SURFACE_MAP_MARKERS).is_some()
          {
            return Err("native snapshot surface value collides with a reserved marker".into());
          }
          value
        }
        _ => return Err("native snapshot surface property has an unsupported shared value".into()),
      };
      properties.insert(key.to_string(), value);
    }
    output.insert(id.to_string(), properties);
  }
  serde_json::to_value(output).map_err(|_| "native snapshot surface cannot be serialized".into())
}

#[cfg(test)]
mod tests {
  use super::*;
  use yrs::{StateVector, TextPrelim};

  #[test]
  fn rejects_values_that_the_existing_snapshot_decoder_cannot_reconstruct() {
    let source = crate::markdown_to_yjs("Source", "Native text").unwrap();
    assert!(document_to_snapshot(&[255], "source", "Source").is_err());
    for value in [
      Any::BigInt(42),
      Any::Buffer(vec![1, 2, 3].into()),
      Any::from(f64::NAN),
      Any::from(f64::INFINITY),
      Any::Array(vec![Any::Undefined].into()),
    ] {
      let doc = Doc::new();
      let blocks = doc.get_or_insert_map("blocks");
      let mut txn = doc.transact_mut();
      txn.apply_update(Update::decode_v1(&source).unwrap()).unwrap();
      let block = blocks
        .iter(&txn)
        .find_map(|(_, value)| match value {
          Out::YMap(map) => Some(map),
          _ => None,
        })
        .unwrap();
      block.insert(&mut txn, "prop:unsupported", value);
      let update = txn.encode_state_as_update_v1(&StateVector::default());
      assert!(
        document_to_snapshot(&update, "source", "Source").is_err(),
        "unrepresentable property must fail before output"
      );
    }
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    txn.apply_update(Update::decode_v1(&source).unwrap()).unwrap();
    let block = blocks
      .iter(&txn)
      .find_map(|(_, value)| match value {
        Out::YMap(map) => Some(map),
        _ => None,
      })
      .unwrap();
    let text = block.insert(&mut txn, "prop:embedded", TextPrelim::new(""));
    text.insert_embed(&mut txn, 0, Any::Bool(true));
    let update = txn.encode_state_as_update_v1(&StateVector::default());
    assert!(
      document_to_snapshot(&update, "source", "Source").is_err(),
      "rich-text embeds cannot silently disappear"
    );
  }
}
