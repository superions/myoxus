// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native directory inspection reuses the lossless portable capture/materializer.
use serde::{Deserialize, Serialize};
use yrs::{Doc, Map, Out, ReadTxn, StateVector, Transact, Update, updates::decoder::Decode};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definition {
  pub id: String,
  pub title: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub workspace_id: Option<String>,
  pub query: serde_json::Value,
  #[serde(default)]
  pub view: Option<String>,
  #[serde(default)]
  pub display_properties: Option<Vec<String>>,
}

pub fn inspect(snapshot: &[u8]) -> Result<Vec<Definition>, String> {
  if snapshot.is_empty() {
    return Ok(Vec::new());
  }
  let doc = Doc::new();
  let mut txn = doc.transact_mut();
  txn
    .apply_update(Update::decode_v1(snapshot).map_err(|_| "invalid directory document")?)
    .map_err(|_| "invalid directory document")?;
  let Some(blocks) = txn.get_map("blocks") else {
    return Ok(Vec::new());
  };
  let present = blocks.iter(&txn).any(|(_, value)| matches!(value, Out::YMap(map) if matches!(map.get(&txn, "sys:flavour"), Some(Out::Any(yrs::Any::String(value))) if value.as_ref() == "myoxus:document-index")));
  drop(txn);
  if !present {
    return Ok(Vec::new());
  }
  let capture = crate::native_snapshot::document_to_export_snapshot(snapshot, "directory-output", "")?;
  let blocks: Vec<crate::PortableSnapshotBlock> =
    serde_json::from_value(capture["blocks"].clone()).map_err(|_| "invalid directory capture")?;
  blocks
    .into_iter()
    .filter(|block| block.flavour == "myoxus:document-index")
    .map(|block| {
      if !block.children.is_empty() {
        return Err("directory must not contain children".into());
      }
      Ok(Definition {
        id: block.id,
        workspace_id: block
          .props
          .get("workspaceId")
          .map(|value| {
            value
              .as_str()
              .map(str::to_string)
              .ok_or("invalid directory source workspace")
          })
          .transpose()?,
        title: block
          .props
          .get("title")
          .and_then(|value| value.as_str())
          .ok_or("invalid directory title")?
          .to_string(),
        query: block.props.get("query").ok_or("missing directory query")?.clone(),
        view: block
          .props
          .get("view")
          .map(|value| serde_json::from_value(value.clone()).map_err(|_| "invalid directory view"))
          .transpose()?,
        display_properties: block
          .props
          .get("displayProperties")
          .map(|value| serde_json::from_value(value.clone()).map_err(|_| "invalid directory columns"))
          .transpose()?,
      })
    })
    .collect()
}

/// Cells are transient reading text and qualified links, never persisted query results.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Output {
  List(Vec<(String, Option<String>)>),
  Table {
    headers: Vec<String>,
    rows: Vec<Vec<(String, Option<String>)>>,
  },
}

/// Replace only in an independent output capture. Never apply these bytes to storage.
pub fn project(snapshot: &[u8], outputs: &[(Definition, Output)]) -> Result<Vec<u8>, String> {
  if outputs.is_empty() {
    return Ok(snapshot.to_vec());
  }
  if inspect(snapshot)?
    != outputs
      .iter()
      .map(|(definition, _)| definition.clone())
      .collect::<Vec<_>>()
  {
    return Err("directory output does not match source".into());
  }
  let capture = crate::native_snapshot::document_to_export_snapshot(snapshot, "directory-output", "")?;
  let mut blocks: Vec<crate::PortableSnapshotBlock> =
    serde_json::from_value(capture["blocks"].clone()).map_err(|_| "invalid directory capture")?;
  let mut tables = Vec::new();
  for (definition, output) in outputs {
    let mut texts = Vec::new();
    if !definition.title.is_empty() {
      texts.push((definition.title.clone(), None, false));
    }
    match output {
      Output::List(rows) => texts.extend(rows.iter().map(|(text, href)| (text.clone(), href.clone(), true))),
      Output::Table { .. } => texts.push((String::new(), None, false)),
    }
    let mut replacements = Vec::new();
    for (index, (text, href, list)) in texts.into_iter().enumerate() {
      let mut id = if index == 0 {
        definition.id.clone()
      } else {
        format!("{}:directory:{index}", definition.id)
      };
      if index > 0 {
        while blocks.iter().any(|block| block.id == id) {
          id.push('_');
        }
      }
      replacements.push(id.clone());
      let attrs = href.map_or_else(|| serde_json::json!({}), |href| serde_json::json!({ "link": href }));
      let block = crate::PortableSnapshotBlock { id, flavour: if list { "myoxus:list" } else { "myoxus:paragraph" }.into(), version: Some(1), props: serde_json::json!({ "type": if list { "bulleted" } else { "text" }, "text": { "$virgultum:internal:text$": true, "delta": [{ "insert": text, "attributes": attrs }] } }).as_object().unwrap().clone(), children: Vec::new() };
      if index == 0 {
        *blocks
          .iter_mut()
          .find(|block| block.id == definition.id)
          .ok_or("directory block missing")? = block;
      } else {
        blocks.push(block);
      }
    }
    if let Output::Table { headers, rows } = output {
      let mut cells = vec![
        headers
          .iter()
          .map(|text| {
            vec![crate::YjsTextSegment {
              text: text.clone(),
              bold: true,
              ..Default::default()
            }]
          })
          .collect::<Vec<_>>(),
      ];
      cells.extend(rows.iter().map(|row| {
        row
          .iter()
          .map(|(text, href)| {
            vec![crate::YjsTextSegment {
              text: text.clone(),
              link: href.clone(),
              ..Default::default()
            }]
          })
          .collect()
      }));
      tables.push((replacements.last().ok_or("report table missing")?.clone(), cells));
    }
    for block in &mut blocks {
      if let Some(index) = block.children.iter().position(|id| id == &definition.id) {
        block.children.splice(index..index + 1, replacements.clone());
      }
    }
  }
  let projected = crate::snapshot_blocks_to_yjs(&blocks)?;
  if tables.is_empty() {
    return Ok(projected);
  }
  let doc = Doc::new();
  let mut txn = doc.transact_mut();
  txn
    .apply_update(Update::decode_v1(&projected).map_err(|_| "invalid report output")?)
    .map_err(|_| "invalid report output")?;
  let blocks = txn.get_map("blocks").ok_or("report blocks missing")?;
  for (id, rows) in tables {
    // Use the existing native table codec, including its valid row/column ordering.
    let table =
      crate::create_yjs_table_block(&blocks, &mut txn, &id, &rows, &[], Some(1)).ok_or("invalid report table")?;
    // Reports use native compact tables and column proportions in every Rust output.
    table.insert(&mut txn, "prop:density", "compact");
    table.insert(&mut txn, "prop:appearance", "ruled");
    for index in 0..rows[0].len() {
      let width = if index == 0 { 240.0 } else { 120.0 };
      table.insert(&mut txn, format!("prop:columns.col-{index:04}.width").as_str(), width);
    }
  }
  Ok(txn.encode_state_as_update_v1(&StateVector::default()))
}
