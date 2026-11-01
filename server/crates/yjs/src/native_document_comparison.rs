// SPDX-License-Identifier: AGPL-3.0-or-later

//! Read-only content comparison for the bounded released-builtin cutover.
//! CRDT clocks, generated block IDs and fractional table ordering keys differ
//! between captures. Native properties, rich-text attributes and visible order
//! must still agree; registration metadata is outside the document body.

use std::collections::{BTreeMap, HashSet};

use serde_json::{Value, json};
use yrs::types::text::YChange;
use yrs::updates::decoder::Decode;
use yrs::{Array, Doc, Map, Out, ReadTxn, Text, Transact, Update};

/// Compare the complete native block graph without modifying either snapshot.
/// Unsupported values and ambiguous graphs fail closed rather than admitting an
/// edited document as an unchanged centrally managed source.
pub fn native_documents_have_same_content(left: &[u8], right: &[u8]) -> Result<bool, String> {
  Ok(canonical_content(left)? == canonical_content(right)?)
}

fn value<T: ReadTxn>(out: Out, txn: &T, depth: usize) -> Result<Value, String> {
  if depth > 256 {
    return Err("native value nesting limit exceeded".into());
  }
  Ok(match out {
    Out::Any(any) => any_value(&any, depth)?,
    Out::YMap(map) => json!({ "native_map":
      map
        .iter(txn)
        .map(|(key, out)| Ok((key.to_string(), value(out, txn, depth + 1)?)))
        .collect::<Result<BTreeMap<String, Value>, String>>()?
    }),
    Out::YArray(array) => {
      json!({ "native_array": array.iter(txn).map(|out| value(out, txn, depth + 1)).collect::<Result<Vec<Value>, String>>()? })
    }
    Out::YText(text) => json!({ "native_text":
      text.diff(txn, YChange::identity)
        .into_iter()
        .map(|chunk| {
          let attributes: BTreeMap<_, _> = chunk
            .attributes
            .unwrap_or_default()
            .into_iter()
            .map(|(key, any)| Ok((key.to_string(), any_value(&any, depth)?)))
            .collect::<Result<_, String>>()?;
          Ok(json!({"insert": value(chunk.insert, txn, depth + 1)?, "attributes": attributes}))
        })
        .collect::<Result<Vec<Value>, String>>()?,
    }),
    _ => return Err("unsupported native content value".into()),
  })
}

fn any_value(any: &yrs::Any, depth: usize) -> Result<Value, String> {
  use yrs::Any;
  if depth > 256 {
    return Err("native value nesting limit exceeded".into());
  }
  Ok(match any {
    Any::Null => Value::Null,
    Any::Undefined => json!({"native_undefined": true}),
    Any::Bool(value) => Value::Bool(*value),
    Any::Number(value) => Value::Number(
      value
        .as_f64()
        .and_then(serde_json::Number::from_f64)
        .or_else(|| value.as_i64().map(Into::into))
        .ok_or("invalid native number")?,
    ),
    Any::BigInt(value) => json!({"native_bigint": value.to_string()}),
    Any::String(value) => Value::String(value.to_string()),
    Any::Buffer(value) => json!({"native_buffer": value.to_vec()}),
    Any::Array(values) => {
      json!({"native_any": values.iter().map(|value| any_value(value, depth + 1)).collect::<Result<Vec<Value>, String>>()?})
    }
    Any::Map(values) => {
      json!({"native_any": values.iter().map(|(key, value)| Ok((key.to_string(), any_value(value, depth + 1)?))).collect::<Result<BTreeMap<String, Value>, String>>()?})
    }
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use yrs::{Any, ArrayPrelim, MapPrelim, StateVector, TextPrelim};

  fn capture(prefix: &str, checked: bool, bold: bool, reversed: bool) -> Vec<u8> {
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    let page_id = format!("{prefix}-page");
    let todo_id = format!("{prefix}-todo");
    let table_id = format!("{prefix}-table");
    let page = blocks.insert(&mut txn, page_id.clone(), MapPrelim::default());
    page.insert(&mut txn, "sys:id", page_id);
    page.insert(&mut txn, "sys:flavour", "myoxus:page");
    page.insert(
      &mut txn,
      "sys:children",
      ArrayPrelim::from([todo_id.clone(), table_id.clone()]),
    );
    page.insert(&mut txn, "prop:title", TextPrelim::new("Business daily"));
    let todo = blocks.insert(&mut txn, todo_id.clone(), MapPrelim::default());
    todo.insert(&mut txn, "sys:id", todo_id);
    todo.insert(&mut txn, "sys:flavour", "myoxus:list");
    todo.insert(&mut txn, "sys:children", ArrayPrelim::default());
    todo.insert(&mut txn, "prop:checked", checked);
    let text = todo.insert(&mut txn, "prop:text", TextPrelim::new("Next step"));
    if bold {
      text.format(&mut txn, 0, 9, [("bold".into(), Any::Bool(true))].into());
    }
    let table = blocks.insert(&mut txn, table_id.clone(), MapPrelim::default());
    table.insert(&mut txn, "sys:id", table_id);
    table.insert(&mut txn, "sys:flavour", "myoxus:table");
    table.insert(&mut txn, "sys:children", ArrayPrelim::default());
    let column = format!("{prefix}-column");
    table.insert(&mut txn, format!("prop:columns.{column}.columnId"), column.clone());
    table.insert(&mut txn, format!("prop:columns.{column}.order"), format!("a0{prefix}"));
    for (index, cell) in ["Time", "08:30"].into_iter().enumerate() {
      let row = format!("{prefix}-row-{index}");
      table.insert(&mut txn, format!("prop:rows.{row}.rowId"), row.clone());
      let position = if reversed { 1 - index } else { index };
      table.insert(
        &mut txn,
        format!("prop:rows.{row}.order"),
        format!("a{position}{prefix}"),
      );
      table.insert(
        &mut txn,
        format!("prop:cells.{row}:{column}.text"),
        TextPrelim::new(cell),
      );
    }
    txn.encode_state_as_update_v1(&StateVector::default())
  }

  #[test]
  fn checkbox_formatting_and_table_order_edits_are_real_drift() {
    let baseline = capture("first", false, false, false);
    for edited in [
      capture("second", true, false, false),
      capture("second", false, true, false),
      capture("second", false, false, true),
    ] {
      assert_eq!(native_documents_have_same_content(&baseline, &edited), Ok(false));
    }
  }

  #[test]
  fn malformed_or_unreachable_content_is_not_accepted_as_unchanged() {
    let baseline = capture("first", false, false, false);
    assert!(native_documents_have_same_content(&baseline, &[255]).is_err());
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&baseline).expect("fixture"))
      .expect("fixture");
    blocks.insert(&mut txn, "orphan", MapPrelim::default());
    let orphan = txn.encode_state_as_update_v1(&StateVector::default());
    assert!(native_documents_have_same_content(&baseline, &orphan).is_err());
  }

  #[test]
  fn a_json_object_cannot_impersonate_native_rich_text() {
    let baseline = capture("first", false, false, false);
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&baseline).expect("fixture"))
      .expect("fixture");
    let Out::YMap(todo) = blocks.get(&txn, "first-todo").expect("fixture todo") else {
      panic!("fixture map")
    };
    todo.insert(
      &mut txn,
      "prop:text",
      Any::from_json(r#"{"native_text":[{"insert":"Next step","attributes":{}}]}"#).expect("fixture JSON"),
    );
    let edited = txn.encode_state_as_update_v1(&StateVector::default());
    assert_eq!(native_documents_have_same_content(&baseline, &edited), Ok(false));
  }
}

fn canonical_content(update: &[u8]) -> Result<Value, String> {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  doc
    .transact_mut()
    .apply_update(Update::decode_v1(update).map_err(|_| "invalid native content")?)
    .map_err(|_| "invalid native content")?;
  let txn = doc.transact();
  if blocks.len(&txn) > 4096 {
    return Err("native block limit exceeded".into());
  }
  let mut captured = BTreeMap::new();
  let mut roots = Vec::new();
  for (id, out) in blocks.iter(&txn) {
    let Out::YMap(map) = out else {
      return Err("invalid native block".into());
    };
    let block = Value::Object(
      map
        .iter(&txn)
        .map(|(key, out)| {
          let content = if key == "sys:flavour" {
            let Out::Any(yrs::Any::String(flavour)) = out else {
              return Err("invalid native flavour".into());
            };
            // Reuse the deployed read-only aliases, excluding headings whose
            // storage conversion has additional semantic requirements.
            Value::String(if flavour.as_ref() == "affine:heading" {
              flavour.to_string()
            } else {
              super::resolve_flavour(&flavour).to_string()
            })
          } else if key == "sys:children" {
            let Out::YArray(children) = out else {
              return Err("invalid native children".into());
            };
            Value::Array(
              children
                .iter(&txn)
                .map(|out| value(out, &txn, 0))
                .collect::<Result<_, _>>()?,
            )
          } else {
            value(out, &txn, 0)?
          };
          Ok((key.to_string(), content))
        })
        .collect::<Result<_, String>>()?,
    );
    if block.get("sys:flavour").and_then(Value::as_str) == Some("myoxus:page") {
      roots.push(id.to_string());
    }
    captured.insert(id.to_string(), block);
  }
  if roots.len() != 1 {
    return Err("native content must have one page".into());
  }
  let mut visited = HashSet::new();
  let content = block_tree(&roots[0], &captured, &mut visited, 0)?;
  if visited.len() != captured.len() {
    return Err("native content has unreachable blocks".into());
  }
  Ok(content)
}

fn block_tree(
  id: &str,
  blocks: &BTreeMap<String, Value>,
  visited: &mut HashSet<String>,
  depth: usize,
) -> Result<Value, String> {
  if depth > 256 {
    return Err("native block nesting limit exceeded".into());
  }
  if !visited.insert(id.to_string()) {
    return Err("native content has duplicate or cyclic children".into());
  }
  let mut block = blocks
    .get(id)
    .and_then(Value::as_object)
    .cloned()
    .ok_or("native child is missing")?;
  if block
    .remove("sys:id")
    .and_then(|value| value.as_str().map(str::to_string))
    .as_deref()
    != Some(id)
  {
    return Err("native block identity mismatch".into());
  }
  let children = block.remove("sys:children").ok_or("native children are missing")?;
  let children = children.as_array().ok_or("invalid native children")?;
  let nested = children
    .iter()
    .map(|child| {
      block_tree(
        child.as_str().ok_or("invalid native child")?,
        blocks,
        visited,
        depth + 1,
      )
    })
    .collect::<Result<Vec<_>, String>>()?;
  if block.get("sys:flavour").and_then(Value::as_str) == Some("myoxus:table") {
    canonical_table(&mut block)?;
  }
  block.insert("sys:children".into(), Value::Array(nested));
  Ok(Value::Object(block))
}

fn canonical_table(block: &mut serde_json::Map<String, Value>) -> Result<(), String> {
  let mut identities = BTreeMap::new();
  for (collection, identity_key) in [("rows", "rowId"), ("columns", "columnId")] {
    let prefix = format!("prop:{collection}.");
    let mut ordered = Vec::new();
    for (key, content) in block.iter() {
      if let Some(id) = key.strip_prefix(&prefix).and_then(|key| key.strip_suffix(".order")) {
        let order = content.as_str().ok_or("invalid native table order")?;
        if block
          .get(&format!("{prefix}{id}.{identity_key}"))
          .and_then(Value::as_str)
          != Some(id)
        {
          return Err("native table identity mismatch".into());
        }
        ordered.push((order.to_string(), id.to_string()));
      }
    }
    ordered.sort();
    if ordered.windows(2).any(|pair| pair[0].0 == pair[1].0) {
      return Err("ambiguous native table order".into());
    }
    for (index, (_, id)) in ordered.into_iter().enumerate() {
      if identities.insert(id, format!("{collection}-{index}")).is_some() {
        return Err("ambiguous native table identity".into());
      }
    }
  }
  let original = std::mem::take(block);
  for (key, mut content) in original {
    let mut parts: Vec<String> = key.split(['.', ':']).map(str::to_string).collect();
    if key.starts_with("prop:rows.") || key.starts_with("prop:columns.") || key.starts_with("prop:cells.") {
      for part in &mut parts[2..] {
        if let Some(canonical) = identities.get(part) {
          *part = canonical.clone();
        }
      }
      if key.ends_with(".rowId") || key.ends_with(".columnId") || key.ends_with(".order") {
        let canonical = parts.get(2).ok_or("invalid native table key")?;
        content = Value::String(canonical.clone());
      }
      // Colons belong only to the cell's row:column identity, all other
      // property boundaries use dots in the native table storage contract.
      let canonical = if parts.get(1).map(String::as_str) == Some("cells") {
        if parts.len() != 5 {
          return Err("invalid native cell key".into());
        }
        format!("prop:cells.{}:{}.{}", parts[2], parts[3], parts[4])
      } else {
        format!("prop:{}.{}", parts[1], parts[2..].join("."))
      };
      if block.insert(canonical, content).is_some() {
        return Err("duplicate canonical native table property".into());
      }
    } else {
      block.insert(key, content);
    }
  }
  Ok(())
}
