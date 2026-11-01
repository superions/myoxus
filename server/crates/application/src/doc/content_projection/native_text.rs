// SPDX-License-Identifier: AGPL-3.0-or-later
//! Private response enrichment; public renderer serialization remains unchanged.

use myoxus_public_render::{Block, PublicDocIr, PublicList, PublicListItem, PublicListKind};
use serde::{Serialize, Serializer};
use std::collections::{BTreeMap, BTreeSet};
use yjs::native_text::NativeBlockText;

pub(super) struct PrivateBlocks<'a> {
  pub blocks: &'a [Block],
  pub native: &'a BTreeMap<String, NativeBlockText>,
}

impl Serialize for PrivateBlocks<'_> {
  fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    fn enrich(
      value: &mut serde_json::Value,
      native: &BTreeMap<String, NativeBlockText>,
    ) -> Result<(), serde_json::Error> {
      match value {
        serde_json::Value::Array(values) => {
          for value in values {
            enrich(value, native)?;
          }
        }
        serde_json::Value::Object(fields) => {
          for value in fields.values_mut() {
            enrich(value, native)?;
          }
          if let Some(text) = fields
            .get("blockId")
            .and_then(|value| value.as_str())
            .and_then(|id| native.get(id))
          {
            fields.insert("native".into(), serde_json::to_value(text)?);
          }
        }
        _ => {}
      }
      Ok(())
    }
    let mut value = serde_json::to_value(self.blocks).map_err(serde::ser::Error::custom)?;
    enrich(&mut value, self.native).map_err(serde::ser::Error::custom)?;
    value.serialize(serializer)
  }
}

/// Native text units remain edit targets when the reading renderer omits their body.
pub(super) fn restore_native_text_targets(ir: &mut PublicDocIr) {
  fn ordered(id: &str, ir: &PublicDocIr, seen: &mut BTreeSet<String>, output: &mut Vec<String>, depth: usize) {
    if depth > 64 || !seen.insert(id.into()) {
      return;
    }
    output.push(id.into());
    // Opaque siblings still occupy native order. Keep the existing container
    // traversal boundary; ranking a divider must not expose an embed's subtree.
    if !ir.native_text.contains_key(id) {
      return;
    }
    if let Some(children) = ir.native_children.get(id) {
      for child in children {
        ordered(child, ir, seen, output, depth + 1);
      }
    }
  }
  fn ids(blocks: &[Block], output: &mut BTreeSet<String>) {
    for block in blocks {
      output.insert(block.block_id().into());
      match block {
        Block::Callout { children, .. } | Block::FootnoteDefinition { children, .. } => ids(children, output),
        Block::List { list, .. } => {
          for item in &list.items {
            output.insert(item.block_id.clone());
            ids(&item.children, output);
          }
        }
        _ => {}
      }
    }
  }
  fn insert(blocks: &mut Vec<Block>, block: Block, ranks: &BTreeMap<String, usize>) {
    let rank = ranks.get(block.block_id()).copied().unwrap_or(usize::MAX);
    // Reading IR can group lists across an omitted native unit. Restore its
    // actual position between the items, never after the whole grouped list.
    let split = blocks.iter_mut().enumerate().find_map(|(index, candidate)| {
      let Block::List { list, .. } = candidate else {
        return None;
      };
      let at = list
        .items
        .iter()
        .position(|item| ranks.get(&item.block_id).copied().unwrap_or(usize::MAX) > rank)?;
      (at > 0).then(|| {
        (
          index,
          PublicList {
            kind: list.kind,
            items: list.items.split_off(at),
          },
        )
      })
    });
    if let Some((index, suffix)) = split {
      let suffix_id = suffix.items[0].block_id.clone();
      blocks.insert(index + 1, block);
      blocks.insert(
        index + 2,
        Block::List {
          block_id: suffix_id,
          list: suffix,
        },
      );
      return;
    }
    let at = blocks
      .iter()
      .position(|next| ranks.get(next.block_id()).copied().unwrap_or(usize::MAX) > rank)
      .unwrap_or(blocks.len());
    blocks.insert(at, block);
  }
  fn under(blocks: &mut [Block], parent: &str, block: &Block, ranks: &BTreeMap<String, usize>) -> bool {
    for candidate in blocks {
      match candidate {
        Block::Callout { block_id, children, .. } | Block::FootnoteDefinition { block_id, children, .. } => {
          if block_id == parent {
            insert(children, block.clone(), ranks);
            return true;
          }
          if under(children, parent, block, ranks) {
            return true;
          }
        }
        Block::List { list, .. } => {
          for item in &mut list.items {
            if item.block_id == parent {
              insert(&mut item.children, block.clone(), ranks);
              return true;
            }
            if under(&mut item.children, parent, block, ranks) {
              return true;
            }
          }
        }
        _ => {}
      }
    }
    false
  }
  let mut order = Vec::new();
  let mut visited = BTreeSet::new();
  for (id, block) in &ir.native_text {
    if block.kind == "myoxus:page" {
      ordered(id, ir, &mut visited, &mut order, 0);
    }
  }
  let ranks: BTreeMap<_, _> = order.iter().enumerate().map(|(rank, id)| (id.clone(), rank)).collect();
  let mut present = BTreeSet::new();
  ids(&ir.document.blocks, &mut present);
  let parents: BTreeMap<_, _> = ir
    .native_children
    .iter()
    .flat_map(|(parent, children)| children.iter().map(move |child| (child.clone(), parent.clone())))
    .collect();
  for id in order {
    if present.contains(&id) {
      continue;
    }
    let Some(native) = ir.native_text.get(&id).filter(|native| {
      matches!(
        native.kind.as_str(),
        "myoxus:paragraph" | "myoxus:list" | "myoxus:annotation" | "myoxus:latex"
      )
    }) else {
      continue;
    };
    let kind = if native.kind == "myoxus:annotation" {
      "text"
    } else {
      native
        .properties
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("text")
    };
    let block = if native.kind == "myoxus:list" {
      let list_kind = match kind {
        "numbered" => PublicListKind::Numbered,
        "todo" => PublicListKind::Todo,
        _ => PublicListKind::Bulleted,
      };
      Block::List {
        block_id: id.clone(),
        list: PublicList {
          kind: list_kind,
          items: vec![PublicListItem {
            block_id: id.clone(),
            text: Vec::new(),
            children: Vec::new(),
            todo_checked: (list_kind == PublicListKind::Todo).then(|| {
              native
                .properties
                .get("checked")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            }),
          }],
        },
      }
    } else if let Some(level) = kind
      .strip_prefix('h')
      .and_then(|level| level.parse::<u8>().ok())
      .filter(|level| (1..=6).contains(level))
    {
      Block::Heading {
        block_id: id.clone(),
        level,
        text: Vec::new(),
      }
    } else if kind == "quote" {
      Block::Quote {
        block_id: id.clone(),
        text: Vec::new(),
      }
    } else if native.kind == "myoxus:latex" {
      // An empty formula block is omitted by the read renderer; restore it as
      // an editable target so its source can be authored or cleared.
      Block::Code {
        native_latex: true,
        block_id: id.clone(),
        language: None,
        text: native
          .properties
          .get("latex")
          .and_then(|value| value.as_str())
          .unwrap_or("")
          .to_string(),
      }
    } else {
      Block::Paragraph {
        block_id: id.clone(),
        text: Vec::new(),
      }
    };
    if ir.document.blocks.len() == 1 && ir.document.blocks[0].block_id() == "empty" {
      ir.document.blocks.clear();
    }
    let mut parent = parents.get(&id);
    let mut seen = BTreeSet::new();
    let mut placed = false;
    while let Some(id) = parent {
      if !seen.insert(id) {
        break;
      }
      if under(&mut ir.document.blocks, id, &block, &ranks) {
        placed = true;
        break;
      }
      parent = parents.get(id);
    }
    if !placed {
      insert(&mut ir.document.blocks, block, &ranks);
    }
  }
}
