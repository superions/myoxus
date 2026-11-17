// SPDX-License-Identifier: AGPL-3.0-or-later
//! Output-only materialization of the existing selected document reference.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::PortableSnapshotBlock;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
  pub id: String,
  pub page_id: String,
  pub workspace_id: Option<String>,
  pub params: Value,
}

fn capture(snapshot: &[u8]) -> Result<Vec<PortableSnapshotBlock>, String> {
  let capture = crate::native_snapshot::document_to_export_snapshot(snapshot, "embed-output", "")?;
  serde_json::from_value(capture["blocks"].clone()).map_err(|_| "invalid embed capture".into())
}

pub fn inspect(snapshot: &[u8]) -> Result<Vec<Definition>, String> {
  if snapshot.is_empty() {
    return Ok(Vec::new());
  }
  if !crate::extract_document_references_from_yjs(snapshot)?
    .occurrences
    .iter()
    .any(|reference| {
      reference.link_kind == crate::DocumentReferenceLinkKind::EmbedSyncedDoc
        && crate::markdown::markdown_block_selection(Some(&reference.params_json)) != Ok(None)
    })
  {
    return Ok(Vec::new());
  }
  capture(snapshot)?
    .into_iter()
    .filter(|block| block.flavour == "myoxus:embed-synced-doc")
    .filter_map(|block| {
      let params = block.props.get("params")?;
      if crate::markdown::markdown_block_selection(Some(params)) == Ok(None) {
        return None;
      }
      Some(Ok(Definition {
        id: block.id,
        page_id: block
          .props
          .get("pageId")
          .and_then(Value::as_str)
          .unwrap_or_default()
          .into(),
        workspace_id: block
          .props
          .get("workspaceId")
          .map(|value| value.as_str().unwrap_or_default().to_string()),
        params: params.clone(),
      }))
    })
    .collect()
}

/// Strip document scaffolding only after the canonical range selector ran.
pub fn body(snapshot: &[u8]) -> Result<Vec<PortableSnapshotBlock>, String> {
  let blocks = capture(snapshot)?;
  let map = blocks
    .iter()
    .map(|block| (block.id.as_str(), block))
    .collect::<std::collections::BTreeMap<_, _>>();
  let root = blocks
    .iter()
    .find(|block| block.flavour == "myoxus:page")
    .ok_or("missing embed root")?;
  fn append(
    id: &str,
    map: &std::collections::BTreeMap<&str, &PortableSnapshotBlock>,
    output: &mut Vec<PortableSnapshotBlock>,
  ) {
    let block = map[id];
    if matches!(block.flavour.as_str(), "myoxus:page" | "myoxus:note") {
      for child in &block.children {
        append(child, map, output);
      }
    } else {
      output.push(block.clone());
      for child in &block.children {
        append(child, map, output);
      }
    }
  }
  let mut output = Vec::new();
  append(&root.id, &map, &mut output);
  Ok(output)
}

/// An unavailable body remains the native unsupported block, so downstream
/// renderers emit their existing diagnosed placeholder. Never widen a selection.
pub fn project(
  snapshot: &[u8],
  outputs: &[(Definition, Option<Vec<PortableSnapshotBlock>>)],
) -> Result<Vec<u8>, String> {
  if outputs.is_empty() {
    return Ok(snapshot.to_vec());
  }
  if inspect(snapshot)?
    != outputs
      .iter()
      .map(|(definition, _)| definition.clone())
      .collect::<Vec<_>>()
  {
    return Err("embed output does not match source".into());
  }
  let mut blocks = capture(snapshot)?;
  for (definition, body) in outputs {
    let Some(body) = body else {
      continue;
    };
    let mut names = std::collections::BTreeMap::new();
    for block in body {
      let mut id = format!("{}:embed:{}", definition.id, block.id);
      while blocks.iter().any(|block| block.id == id) || names.values().any(|value| value == &id) {
        id.push('_');
      }
      names.insert(block.id.clone(), id);
    }
    let children = body
      .iter()
      .flat_map(|block| &block.children)
      .collect::<std::collections::BTreeSet<_>>();
    let roots = body
      .iter()
      .filter(|block| !children.contains(&block.id))
      .map(|block| names[&block.id].clone())
      .collect::<Vec<_>>();
    for block in &mut blocks {
      if let Some(index) = block.children.iter().position(|id| id == &definition.id) {
        block.children.splice(index..index + 1, roots.clone());
      }
    }
    blocks.retain(|block| block.id != definition.id);
    for block in body {
      let mut block = block.clone();
      block.id = names[&block.id].clone();
      block.children = block
        .children
        .iter()
        .map(|id| names.get(id).cloned().ok_or("missing embedded child"))
        .collect::<Result<_, _>>()?;
      blocks.push(block);
    }
  }
  crate::snapshot_blocks_to_yjs(&blocks)
}
