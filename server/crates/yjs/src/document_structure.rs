// SPDX-License-Identifier: AGPL-3.0-or-later
//! Local native structural edits; ordinary builders and codecs do not use this policy.

use super::*;
use yrs::types::AsPrelim;

pub(super) fn native_block(
  blocks: &yrs::MapRef,
  txn: &impl ReadTxn,
  id: &str,
) -> Result<yrs::MapRef, DocumentMutationError> {
  match blocks.get(txn, id) {
    Some(yrs::Out::YMap(block)) => Ok(block),
    _ => Err(DocumentMutationError::TargetNotFound),
  }
}

/// Structural replacement requires one real parent, never an arbitrary map
/// entry or a block shared by multiple parent arrays.
pub(super) fn unique_parent(
  blocks: &yrs::MapRef,
  txn: &yrs::TransactionMut<'_>,
  id: &str,
) -> Result<(yrs::MapRef, yrs::ArrayRef, u32), DocumentMutationError> {
  let mut result = None;
  for (_, value) in blocks.iter(txn) {
    let yrs::Out::YMap(parent) = value else { continue };
    let Some(children) = block_array(&parent, txn, "children") else {
      continue;
    };
    for (index, child) in children.iter(txn).enumerate() {
      if matches!(child, yrs::Out::Any(Any::String(ref child)) if child.as_ref() == id) {
        if result.is_some() {
          return Err(DocumentMutationError::InvalidBlockProperties);
        }
        result = Some((parent.clone(), children.clone(), index as u32));
      }
    }
  }
  result.ok_or(DocumentMutationError::TargetNotFound)
}

pub(super) fn flavour(block: &yrs::MapRef, txn: &impl ReadTxn) -> String {
  resolve_flavour(&block_string(block, txn, "flavour").unwrap_or_default()).to_string()
}

fn kind_target(kind: DocumentTextBlockKind) -> (&'static str, &'static str) {
  use DocumentTextBlockKind::*;
  match kind {
    Paragraph => ("myoxus:paragraph", "text"),
    Quote => ("myoxus:paragraph", "quote"),
    Heading1 => ("myoxus:paragraph", "h1"),
    Heading2 => ("myoxus:paragraph", "h2"),
    Heading3 => ("myoxus:paragraph", "h3"),
    Heading4 => ("myoxus:paragraph", "h4"),
    Heading5 => ("myoxus:paragraph", "h5"),
    Heading6 => ("myoxus:paragraph", "h6"),
    Bulleted => ("myoxus:list", "bulleted"),
    Numbered => ("myoxus:list", "numbered"),
    Todo => ("myoxus:list", "todo"),
  }
}

fn has_block_comments(block: &yrs::MapRef, txn: &impl ReadTxn) -> bool {
  block.iter(txn).any(|(key, value)| {
    (key == "prop:comments" || key.starts_with("prop:comments."))
      && match value {
        yrs::Out::Any(Any::Null | Any::Undefined) => false,
        yrs::Out::Any(Any::Map(ref values)) => !values.is_empty(),
        yrs::Out::YMap(ref values) => values.len(txn) != 0,
        _ => true,
      }
  })
}

// A cloned TextRef has new CRDT positions. Comment anchors and explicit block
// references cannot be rebound by this bounded local model replacement.
fn has_protected_anchors(blocks: &yrs::MapRef, txn: &impl ReadTxn, id: &str, block: &yrs::MapRef) -> bool {
  if has_block_comments(block, txn) {
    return true;
  }
  for (_, value) in blocks.iter(txn) {
    let yrs::Out::YMap(other) = value else { continue };
    for (_, value) in other.iter(txn) {
      let yrs::Out::YText(text) = value else { continue };
      for run in text.diff(txn, yrs::types::text::YChange::identity) {
        if run.attributes.as_ref().is_some_and(|attrs| {
          attrs.get("reference").is_some_and(|value| {
            let value = serde_json::to_value(value).unwrap_or_default();
            value
              .get("params")
              .and_then(|params| params.get("blockIds"))
              .and_then(|ids| ids.as_array())
              .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
          })
        }) {
          return true;
        }
      }
    }
  }
  false
}

fn validate_text_ancestry(
  blocks: &yrs::MapRef,
  txn: &yrs::TransactionMut<'_>,
  id: &str,
  parent: &yrs::MapRef,
) -> Result<(), DocumentMutationError> {
  // Do not replace an orphan/cyclic native unit. Parent lookup must reach a
  // canonical content root without revisiting a block or accepting shared edges.
  let mut ancestor = parent.clone();
  let mut ancestry = HashSet::from([id.to_string()]);
  loop {
    let ancestor_id = block_string(&ancestor, txn, "id").ok_or(DocumentMutationError::InvalidBlockProperties)?;
    if !ancestry.insert(ancestor_id.clone()) || ancestry.len() > MAX_FRAGMENT_DEPTH + 3 {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    if flavour(&ancestor, txn) == "myoxus:note" {
      let (_, root, _) = unique_parent(blocks, txn, &ancestor_id)?;
      if !blocks.iter(txn).any(|(_, value)| matches!(value, yrs::Out::YMap(ref page) if flavour(page, txn) == "myoxus:page" && block_array(page, txn, "children").as_ref() == Some(&root))) {
        return Err(DocumentMutationError::InvalidBlockProperties);
      }
      break;
    }
    ancestor = unique_parent(blocks, txn, &ancestor_id)?.0;
  }
  Ok(())
}

fn validate_subtree(
  blocks: &yrs::MapRef,
  txn: &yrs::TransactionMut<'_>,
  id: &str,
) -> Result<Vec<(String, usize)>, DocumentMutationError> {
  // Count incoming edges once. Checking each descendant by scanning the full
  // document would make a local replacement quadratic under the write lock.
  let mut parent_counts = HashMap::<String, usize>::new();
  for (_, value) in blocks.iter(txn) {
    let yrs::Out::YMap(parent) = value else { continue };
    if let Some(children) = block_array(&parent, txn, "children") {
      for child in array_string_values(&children, txn) {
        *parent_counts.entry(child).or_default() += 1;
      }
    }
  }
  let mut pending = vec![(id.to_string(), 0)];
  let mut ordered = Vec::new();
  let mut visited = HashSet::new();
  while let Some((current, depth)) = pending.pop() {
    if !visited.insert(current.clone()) || visited.len() > MAX_FRAGMENT_BLOCKS {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    if parent_counts.get(&current) != Some(&1) {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    ordered.push((current.clone(), depth));
    let current = native_block(blocks, txn, &current)?;
    if let Some(children) = block_array(&current, txn, "children") {
      pending.extend(
        array_string_values(&children, txn)
          .into_iter()
          .rev()
          .map(|id| (id, depth + 1)),
      );
    }
  }
  Ok(ordered)
}

pub(super) fn convert_text_block(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  id: &str,
  kind: DocumentTextBlockKind,
  inserted: &mut Vec<String>,
  removed: &mut Vec<String>,
) -> Result<(), DocumentMutationError> {
  let block = native_block(blocks, txn, id)?;
  let source = flavour(&block, txn);
  if !matches!(source.as_str(), "myoxus:paragraph" | "myoxus:list") {
    return Err(DocumentMutationError::InvalidBlockProperties);
  }
  let (target, block_type) = kind_target(kind);
  let (parent, children, index) = unique_parent(blocks, txn, id)?;
  if !native_parent_allows(&flavour(&parent, txn), target) {
    return Err(DocumentMutationError::InvalidBlockProperties);
  }
  validate_text_ancestry(blocks, txn, id, &parent)?;
  if source == target {
    // Existing property ownership validates/updates headings and list kinds.
    if target == "myoxus:list" {
      let list_kind = match kind {
        DocumentTextBlockKind::Todo => DocumentListKind::Todo,
        DocumentTextBlockKind::Numbered => DocumentListKind::Numbered,
        _ => DocumentListKind::Bulleted,
      };
      update_block_properties(
        blocks,
        txn,
        id,
        &DocumentBlockProperties {
          list_kind: Some(list_kind),
          ..Default::default()
        },
      )?;
      return Ok(());
    }
    if block_type != "text" {
      block.remove(txn, "prop:presentation");
    }
    if let Some(level) = block_type.strip_prefix('h').and_then(|level| level.parse::<u8>().ok()) {
      update_block_properties(
        blocks,
        txn,
        id,
        &DocumentBlockProperties {
          heading_level: Some(level),
          ..Default::default()
        },
      )?;
      return Ok(());
    }
    block.insert(txn, "prop:type", block_type);
    return Ok(());
  }
  if has_protected_anchors(blocks, txn, id, &block) {
    return Err(DocumentMutationError::InvalidBlockProperties);
  }
  let Some(yrs::Out::YText(_)) = block.get(txn, "prop:text") else {
    return Err(DocumentMutationError::InvalidBlockProperties);
  };
  // Both paragraph and list accept ordinary nested content. Unsupported native
  // extensions are rejected rather than transferring a child into invalid parentage.
  if let Some(descendants) = block_array(&block, txn, "children") {
    for child in array_string_values(&descendants, txn) {
      let child = native_block(blocks, txn, &child)?;
      if target == "myoxus:list" && flavour(&child, txn) == "myoxus:table" {
        return Err(DocumentMutationError::InvalidBlockProperties);
      }
      if !matches!(
        flavour(&child, txn).as_str(),
        "myoxus:paragraph"
          | "myoxus:list"
          | "myoxus:callout"
          | "myoxus:code"
          | "myoxus:table"
          | "myoxus:image"
          | "myoxus:bookmark"
          | "myoxus:divider"
          | "myoxus:latex"
          | "myoxus:mermaid"
          | "myoxus:attachment"
          | "myoxus:surface-ref"
          | "myoxus:event"
          | "myoxus:annotation"
          | "myoxus:bpmn"
      ) {
        return Err(DocumentMutationError::InvalidBlockProperties);
      }
    }
  }
  validate_subtree(blocks, txn, id)?;
  let new_id = Uuid::new_v4().to_string();
  let copy = block.as_prelim(txn);
  let replacement = blocks.insert(txn, new_id.as_str(), copy);
  replacement.insert(txn, "sys:id", new_id.as_str());
  replacement.insert(txn, "sys:flavour", target);
  replacement.insert(txn, "prop:type", block_type);
  // Preserve shared metadata/repeat and attributed content; remove only fields
  // with no meaning in the new flavour. Defaults belong to the new model.
  replacement.remove(txn, "prop:presentation");
  if target == "myoxus:list" {
    replacement.insert(txn, "prop:checked", false);
    replacement.insert(txn, "prop:order", Any::Null);
  } else {
    replacement.remove(txn, "prop:checked");
    replacement.remove(txn, "prop:order");
  }
  children.remove(txn, index);
  children.insert(txn, index, new_id.as_str());
  blocks.remove(txn, id);
  inserted.push(new_id);
  removed.push(id.to_string());
  Ok(())
}

/// Splits use the editor's nonempty-list placement and numbering rules. Only
/// type and attributed text belong to the new unit; repeat/presentation stay left.
pub(super) fn split_text_block(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  id: &str,
  position: u32,
  unit: Option<DocumentTextRangeUnit>,
  inserted: &mut Vec<String>,
  updated: &mut Vec<String>,
) -> Result<(), DocumentMutationError> {
  let block = native_block(blocks, txn, id)?;
  let kind = flavour(&block, txn);
  let (parent, siblings, index) = unique_parent(blocks, txn, id)?;
  if !matches!(kind.as_str(), "myoxus:paragraph" | "myoxus:list")
    || !native_parent_allows(&flavour(&parent, txn), &kind)
    || has_protected_anchors(blocks, txn, id, &block)
  {
    return Err(DocumentMutationError::InvalidBlockProperties);
  }
  validate_text_ancestry(blocks, txn, id, &parent)?;
  validate_subtree(blocks, txn, id)?;
  let Some(yrs::Out::YText(text)) = block.get(txn, "prop:text") else {
    return Err(DocumentMutationError::InvalidBlockProperties);
  };
  let (position, _) = resolve_text_range(&text, txn, position, position, unit, None)?;
  validate_split_boundary(&text, txn, position)?;
  let is_list = kind == "myoxus:list";
  if is_list && text.len(txn) == 0 {
    return Err(DocumentMutationError::InvalidBlockProperties);
  }
  let children = block_array(&block, txn, "children").ok_or(DocumentMutationError::InvalidBlockProperties)?;
  let has_children = children.len(txn) > 0;
  let collapsed = matches!(block.get(txn, "prop:collapsed"), Some(yrs::Out::Any(Any::Bool(true))));
  let expanded = has_children && (!is_list || !collapsed);
  let as_child = expanded && position > 0;
  let block_type =
    block_string(&block, txn, "type").unwrap_or_else(|| if is_list { "bulleted" } else { "text" }.into());
  let numbered = is_list && block_type == "numbered";
  let old_order = if is_list { native_order(&block, txn)? } else { None };
  let id_right = Uuid::new_v4().to_string();
  let (right, right_children) = create_yjs_block(blocks, txn, &id_right, &kind);
  right.insert(txn, "prop:type", block_type);
  let copied = text.as_prelim(txn);
  let right_text = right.insert(txn, "prop:text", copied);
  right_text.remove_range(txn, 0, position);
  text.remove_range(txn, position, text.len(txn) - position);
  if is_list {
    right.insert(txn, "prop:checked", false);
    right.insert(txn, "prop:collapsed", false);
    right.insert(txn, "prop:order", Any::Null);
  }
  if as_child {
    children.insert(txn, 0, id_right.as_str());
    if numbered {
      renumber(blocks, txn, &children, 0, 1.0, updated)?;
    }
  } else {
    siblings.insert(txn, index + 1, id_right.as_str());
    if expanded {
      let child_ids = array_string_values(&children, txn);
      children.remove_range(txn, 0, children.len(txn));
      insert_ids(&right_children, txn, 0, &child_ids);
    }
    if numbered {
      if expanded {
        if let Some(order) = old_order {
          renumber(blocks, txn, &siblings, index + 1, order + 1.0, updated)?;
        }
      } else {
        // The previous sibling is the retained left block, exactly as in
        // correctNumberedListsOrderToPrev. Legacy null/zero starts at one.
        let order = old_order.filter(|order| *order != 0.0).unwrap_or(1.0);
        if old_order != Some(order) {
          block.insert(txn, "prop:order", order);
        }
        renumber(blocks, txn, &siblings, index + 1, order + 1.0, updated)?;
      }
    }
  }
  inserted.push(id_right);
  Ok(())
}

fn native_order(block: &yrs::MapRef, txn: &impl ReadTxn) -> Result<Option<f64>, DocumentMutationError> {
  match block.get(txn, "prop:order") {
    None | Some(yrs::Out::Any(Any::Null | Any::Undefined)) => Ok(None),
    Some(yrs::Out::Any(Any::Number(value))) => value
      .as_f64()
      .filter(|value| value.is_finite())
      .map(Some)
      .ok_or(DocumentMutationError::InvalidBlockProperties),
    _ => Err(DocumentMutationError::InvalidBlockProperties),
  }
}

fn renumber(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  siblings: &yrs::ArrayRef,
  start: u32,
  mut order: f64,
  updated: &mut Vec<String>,
) -> Result<(), DocumentMutationError> {
  for id in array_string_values(siblings, txn).into_iter().skip(start as usize) {
    let block = native_block(blocks, txn, &id)?;
    if flavour(&block, txn) != "myoxus:list" || block_string(&block, txn, "type").as_deref() != Some("numbered") {
      break;
    }
    block.insert(txn, "prop:order", order);
    updated.push(id);
    order += 1.0;
  }
  Ok(())
}

/// An annotation's body is one editor atom even when formatting divides it
/// into multiple Yjs runs. Canonical single-space semantic atoms remain separate.
fn validate_split_boundary(
  text: &yrs::TextRef,
  txn: &impl ReadTxn,
  position: u32,
) -> Result<(), DocumentMutationError> {
  let mut offset = 0;
  let mut left_annotation = None;
  let mut right_annotation = None;
  for run in text.diff(txn, yrs::types::text::YChange::identity) {
    let length = match &run.insert {
      yrs::Out::Any(Any::String(value)) => value.len() as u32,
      _ => 1,
    };
    let annotation = crate::annotation::annotation_id(run.attributes.as_deref()).map(str::to_string);
    if offset < position && position <= offset + length {
      left_annotation = annotation.clone();
    }
    if offset <= position && position < offset + length {
      right_annotation = annotation;
    }
    if offset < position
      && position < offset + length
      && run.attributes.as_ref().is_some_and(|attrs| {
        attrs.contains_key("annotation")
          || ["latex", "reference", "footnote", "mention"]
            .iter()
            .any(|key| attrs.contains_key(*key))
            && !matches!(&run.insert, yrs::Out::Any(Any::String(value)) if value.chars().all(|c| c == ' '))
      })
    {
      return Err(DocumentMutationError::InvalidTextRange);
    }
    offset += length;
  }
  if left_annotation.is_some() && left_annotation == right_annotation {
    return Err(DocumentMutationError::InvalidTextRange);
  }
  Ok(())
}

/// Native content/container relationships used by structural editing only.
/// Match both sides of the current Virgultum/Core model relationship; this is
/// not a schema registry or a policy for ordinary creation/import writers.
/// Leaf maps having a sys:children array do not make them content containers.
pub(super) fn native_parent_allows(parent: &str, child: &str) -> bool {
  let text = matches!(child, "myoxus:paragraph" | "myoxus:list");
  let ordinary = text || matches!(child, "myoxus:callout" | "myoxus:code" | "myoxus:annotation");
  let media = matches!(child, "myoxus:image" | "myoxus:bookmark" | "myoxus:attachment");
  let diagram = matches!(child, "myoxus:mermaid" | "myoxus:latex");
  let embed = child.starts_with("myoxus:embed-");
  match parent {
    "myoxus:page" => matches!(child, "myoxus:note" | "myoxus:surface"),
    "myoxus:note" => {
      ordinary
        || media
        || diagram
        || embed
        || matches!(
          child,
          "myoxus:table"
            | "myoxus:divider"
            | "myoxus:surface-ref"
            | "myoxus:event"
            | "myoxus:bpmn"
            | "myoxus:footnote-definition"
            | "myoxus:database"
            | "myoxus:data-view"
        )
    }
    "myoxus:paragraph" | "myoxus:list" => {
      ordinary
        || media
        || diagram
        || embed
        || matches!(
          child,
          "myoxus:divider" | "myoxus:surface-ref" | "myoxus:event" | "myoxus:bpmn"
        )
        || parent == "myoxus:paragraph" && child == "myoxus:table"
    }
    "myoxus:callout" => ordinary,
    "myoxus:footnote-definition" => {
      ordinary || diagram || matches!(child, "myoxus:table" | "myoxus:image" | "myoxus:divider")
    }
    "myoxus:edgeless-text" => {
      text || media || matches!(child, "myoxus:code" | "myoxus:latex") || embed && child != "myoxus:embed-synced-doc"
    }
    "myoxus:surface" => media || embed || matches!(child, "myoxus:frame" | "myoxus:edgeless-text" | "myoxus:mermaid"),
    "myoxus:attachment" => child == "myoxus:transcription",
    "myoxus:transcription" => child == "myoxus:callout",
    _ => false,
  }
}

pub(super) fn require_parent(
  parent: &yrs::MapRef,
  txn: &impl ReadTxn,
  child: &str,
) -> Result<(), DocumentMutationError> {
  if !native_parent_allows(&flavour(parent, txn), child)
    || parent
      .get(txn, "prop:repeat")
      .is_some_and(|value| !matches!(value, yrs::Out::Any(Any::Null | Any::Undefined)))
  {
    return Err(DocumentMutationError::InvalidBlockProperties);
  }
  Ok(())
}

pub(super) fn fragment_flavour(block: &DocumentFragmentBlock) -> &'static str {
  match block {
    DocumentFragmentBlock::Paragraph { .. }
    | DocumentFragmentBlock::Heading { .. }
    | DocumentFragmentBlock::Quote { .. } => "myoxus:paragraph",
    DocumentFragmentBlock::ListItem { .. } => "myoxus:list",
    DocumentFragmentBlock::Callout { .. } => "myoxus:callout",
    DocumentFragmentBlock::Code { native_latex: true, .. } => "myoxus:latex",
    DocumentFragmentBlock::Code { .. } => "myoxus:code",
    DocumentFragmentBlock::Annotation { .. } => "myoxus:annotation",
    DocumentFragmentBlock::Latex { .. } => "myoxus:latex",
    DocumentFragmentBlock::Mermaid { .. } => "myoxus:mermaid",
    DocumentFragmentBlock::Table { .. } => "myoxus:table",
    DocumentFragmentBlock::Image { .. } => "myoxus:image",
    // Native citation cards use bookmark/linked-doc/attachment, all admitted
    // by the same current content parents; no citation definition is cloned.
    DocumentFragmentBlock::Bookmark { .. } | DocumentFragmentBlock::CitationDefinition { .. } => "myoxus:bookmark",
    DocumentFragmentBlock::FootnoteDefinition { .. } => "myoxus:footnote-definition",
    DocumentFragmentBlock::Divider => "myoxus:divider",
  }
}

pub(super) fn require_fragment_parent(
  parent: &yrs::MapRef,
  txn: &impl ReadTxn,
  fragment: &DocumentFragment,
) -> Result<(), DocumentMutationError> {
  fn children(block: &DocumentFragmentBlock) -> Result<(), DocumentMutationError> {
    let nested = match block {
      DocumentFragmentBlock::ListItem { children, .. }
      | DocumentFragmentBlock::Callout { children, .. }
      | DocumentFragmentBlock::FootnoteDefinition { children, .. } => children,
      _ => return Ok(()),
    };
    for child in nested {
      if !native_parent_allows(fragment_flavour(block), fragment_flavour(child)) {
        return Err(DocumentMutationError::InvalidBlockProperties);
      }
      children(child)?;
    }
    Ok(())
  }
  // This is an explicit existing-document insert, not ordinary creation/import
  // admission. Check every new edge without tightening the shared builders.
  for block in &fragment.blocks {
    require_parent(parent, txn, fragment_flavour(block))?;
    children(block)?;
  }
  Ok(())
}

#[path = "document_copy.rs"]
mod copying;
pub(super) use copying::duplicate_text_subtree;

/// Join only the following compatible sibling. Keep the destination TextRef;
/// source children are lifted to its parent at the retired source's position,
/// matching the editor's explicit bringChildrenTo behavior.
pub(super) fn join_text_blocks(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  id: &str,
  source_id: &str,
  removed: &mut Vec<String>,
) -> Result<(), DocumentMutationError> {
  use yrs::types::{Delta, ToJson};
  let destination = native_block(blocks, txn, id)?;
  let source = native_block(blocks, txn, source_id)?;
  let kind = flavour(&destination, txn);
  let (parent, siblings, index) = unique_parent(blocks, txn, id)?;
  let (_, source_siblings, source_index) = unique_parent(blocks, txn, source_id)?;
  if !matches!(kind.as_str(), "myoxus:paragraph" | "myoxus:list")
    || flavour(&source, txn) != kind
    || siblings != source_siblings
    || source_index != index + 1
    || !native_parent_allows(&flavour(&parent, txn), &kind)
    || has_protected_anchors(blocks, txn, source_id, &source)
  {
    return Err(DocumentMutationError::InvalidBlockProperties);
  }
  let block_type = |block: &yrs::MapRef| {
    block_string(block, txn, "type").unwrap_or_else(|| if kind == "myoxus:list" { "bulleted" } else { "text" }.into())
  };
  if block_type(&destination) != block_type(&source)
    || kind == "myoxus:list"
      && block_type(&source) == "todo"
      && destination
        .get(txn, "prop:checked")
        .is_some_and(|v| v == yrs::Out::Any(Any::Bool(true)))
        != source
          .get(txn, "prop:checked")
          .is_some_and(|v| v == yrs::Out::Any(Any::Bool(true)))
  {
    return Err(DocumentMutationError::InvalidBlockProperties);
  }
  validate_text_ancestry(blocks, txn, id, &parent)?;
  validate_subtree(blocks, txn, id)?;
  validate_subtree(blocks, txn, source_id)?;
  // Never silently retire a prototype, imported anchor or incompatible custom
  // metadata. Native default list UI state does not represent authored content.
  for (key, value) in source.iter(txn) {
    if matches!(
      key,
      "sys:id" | "sys:flavour" | "sys:children" | "prop:text" | "prop:type" | "prop:comments"
    ) {
      continue;
    }
    // These four fields describe the retired model's editor lifecycle, not
    // transferable document content. Keep the destination's own provenance.
    if matches!(
      key,
      "prop:order" | "prop:meta:createdAt" | "prop:meta:createdBy" | "prop:meta:updatedAt" | "prop:meta:updatedBy"
    ) {
      continue;
    }
    if matches!(key, "prop:checked" | "prop:collapsed") && matches!(value, yrs::Out::Any(Any::Bool(false))) {
      continue;
    }
    if matches!(value, yrs::Out::Any(Any::Null | Any::Undefined)) {
      continue;
    }
    if matches!(key, "prop:repeat" | "prop:markdownAnchor")
      || destination
        .get(txn, key)
        .is_none_or(|other| other.to_json(txn) != value.to_json(txn))
    {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
  }
  let (Some(yrs::Out::YText(left)), Some(yrs::Out::YText(right))) =
    (destination.get(txn, "prop:text"), source.get(txn, "prop:text"))
  else {
    return Err(DocumentMutationError::InvalidBlockProperties);
  };
  let children = block_array(&source, txn, "children").ok_or(DocumentMutationError::InvalidBlockProperties)?;
  let child_ids = array_string_values(&children, txn);
  for child_id in &child_ids {
    let child = native_block(blocks, txn, child_id)?;
    if !native_parent_allows(&flavour(&parent, txn), &flavour(&child, txn)) {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
  }
  let copied = right.as_prelim(txn);
  let mut delta = vec![Delta::Retain(left.len(txn), None)];
  delta.extend(copied.iter().cloned());
  left.apply_delta(txn, delta);
  siblings.remove(txn, source_index);
  insert_ids(&siblings, txn, source_index, &child_ids);
  blocks.remove(txn, source_id);
  removed.push(source_id.to_string());
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cross_flavour_rejects_protected_comments_and_invalid_parentage() {
    let original = crate::markdown_to_yjs("Protected", "text").unwrap();
    let doc = yrs::Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&original).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    let root = find_content_root(&blocks, &txn).unwrap();
    let id = array_string_values(&root, &txn)[0].clone();
    let block = native_block(&blocks, &txn, &id).unwrap();
    block.insert(&mut txn, "prop:comments.thread", true);
    let state = txn.encode_state_as_update_v1(&Default::default());
    drop(txn);
    assert_eq!(
      apply_document_mutation(
        &state,
        &DocumentMutation::ConvertBlock {
          block_id: id.clone(),
          block_kind: DocumentTextBlockKind::Todo
        }
      )
      .unwrap_err(),
      DocumentMutationError::InvalidBlockProperties
    );
    assert!(
      apply_document_mutation(
        &state,
        &DocumentMutation::ConvertBlock {
          block_id: id,
          block_kind: DocumentTextBlockKind::Heading1
        }
      )
      .is_ok()
    );
    let mut txn = doc.transact_mut();
    let id = array_string_values(&root, &txn)[0].clone();
    block.remove(&mut txn, "prop:comments.thread");
    block.insert(&mut txn, "prop:comments", Any::Map(Default::default()));
    let state = txn.encode_state_as_update_v1(&Default::default());
    assert!(
      apply_document_mutation(
        &state,
        &DocumentMutation::ConvertBlock {
          block_id: id.clone(),
          block_kind: DocumentTextBlockKind::Todo
        }
      )
      .is_ok()
    );
    let (leaf, leaf_children) = create_yjs_block(&blocks, &mut txn, "leaf", "myoxus:code");
    leaf.insert(&mut txn, "prop:text", yrs::TextPrelim::new("code"));
    root.remove(&mut txn, 0);
    root.push_back(&mut txn, "leaf");
    leaf_children.push_back(&mut txn, id.as_str());
    let state = txn.encode_state_as_update_v1(&Default::default());
    drop(txn);
    assert_eq!(
      apply_document_mutation(
        &state,
        &DocumentMutation::ConvertBlock {
          block_id: id,
          block_kind: DocumentTextBlockKind::Todo
        }
      )
      .unwrap_err(),
      DocumentMutationError::InvalidBlockProperties
    );
    assert_eq!(
      apply_document_mutation(
        &state,
        &DocumentMutation::ConvertBlock {
          block_id: "missing".into(),
          block_kind: DocumentTextBlockKind::Todo
        }
      )
      .unwrap_err(),
      DocumentMutationError::TargetNotFound
    );
  }
  #[test]
  fn paragraph_with_native_table_cannot_be_converted_to_list() {
    let original = crate::markdown_to_yjs("Parent", "Parent\n\n| H |\n| --- |\n| Cell |").unwrap();
    let doc = yrs::Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&original).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    let root = find_content_root(&blocks, &txn).unwrap();
    let ids = array_string_values(&root, &txn);
    let parent = native_block(&blocks, &txn, &ids[0]).unwrap();
    let children = block_array(&parent, &txn, "children").unwrap();
    root.remove(&mut txn, 1);
    children.push_back(&mut txn, ids[1].as_str());
    let state = txn.encode_state_as_update_v1(&Default::default());
    drop(txn);
    assert_eq!(
      apply_document_mutation(
        &state,
        &DocumentMutation::ConvertBlock {
          block_id: ids[0].clone(),
          block_kind: DocumentTextBlockKind::Todo
        }
      )
      .unwrap_err(),
      DocumentMutationError::InvalidBlockProperties
    );
    assert!(
      apply_document_mutation(
        &state,
        &DocumentMutation::ConvertBlock {
          block_id: ids[0].clone(),
          block_kind: DocumentTextBlockKind::Heading3
        }
      )
      .is_ok()
    );
  }

  #[test]
  fn cross_flavour_rejects_block_id_anchors_but_same_flavour_keeps_them_valid() {
    let original = crate::markdown_to_yjs("Anchors", "Target").unwrap();
    let doc = yrs::Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&original).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    let id = array_string_values(&find_content_root(&blocks, &txn).unwrap(), &txn)[0].clone();
    let block = native_block(&blocks, &txn, &id).unwrap();
    let yrs::Out::YText(text) = block.get(&txn, "prop:text").unwrap() else {
      panic!("text")
    };
    let reference = Any::from_json(
      &serde_json::json!({"type":"LinkedPage","pageId":"this-document","params":{"blockIds":[id]}}).to_string(),
    )
    .unwrap();
    text.insert_with_attributes(&mut txn, 0, " ", Attrs::from([(Arc::from("reference"), reference)]));
    let state = txn.encode_state_as_update_v1(&Default::default());
    drop(txn);
    assert_eq!(
      apply_document_mutation(
        &state,
        &DocumentMutation::ConvertBlock {
          block_id: id.clone(),
          block_kind: DocumentTextBlockKind::Todo
        }
      )
      .unwrap_err(),
      DocumentMutationError::InvalidBlockProperties
    );
    let changed = apply_document_mutation(
      &state,
      &DocumentMutation::ConvertBlock {
        block_id: id,
        block_kind: DocumentTextBlockKind::Heading2,
      },
    )
    .unwrap();
    assert!(changed.inserted_block_ids.is_empty());
    assert!(changed.removed_block_ids.is_empty());
  }

  #[test]
  fn conversion_rejects_shared_native_descendants() {
    let original = crate::markdown_to_yjs("Parents", "First\n\nSecond\n\nChild").unwrap();
    let doc = yrs::Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&original).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    let root = find_content_root(&blocks, &txn).unwrap();
    let ids = array_string_values(&root, &txn);
    for id in &ids[..2] {
      let parent = native_block(&blocks, &txn, id).unwrap();
      block_array(&parent, &txn, "children")
        .unwrap()
        .push_back(&mut txn, ids[2].as_str());
    }
    root.remove(&mut txn, 2);
    let state = txn.encode_state_as_update_v1(&Default::default());
    drop(txn);
    assert_eq!(
      apply_document_mutation(
        &state,
        &DocumentMutation::ConvertBlock {
          block_id: ids[0].clone(),
          block_kind: DocumentTextBlockKind::Todo
        }
      )
      .unwrap_err(),
      DocumentMutationError::InvalidBlockProperties
    );
  }
}

#[cfg(test)]
mod split_join_tests {
  use super::*;

  fn decode(state: &[u8]) -> (yrs::Doc, yrs::MapRef) {
    let doc = yrs::Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(state).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    (doc, blocks)
  }

  #[test]
  fn join_retains_destination_textref_lifts_children_and_does_not_leak_marks() {
    let state = crate::markdown_to_yjs("Join", "**é😀**\n\ntail\n\nchild\n\nneighbor").unwrap();
    let (doc, blocks) = decode(&state);
    let mut txn = doc.transact_mut();
    let root = find_content_root(&blocks, &txn).unwrap();
    let ids = array_string_values(&root, &txn);
    let destination = native_block(&blocks, &txn, &ids[0]).unwrap();
    let source = native_block(&blocks, &txn, &ids[1]).unwrap();
    let text_ref = destination.get(&txn, "prop:text").unwrap();
    for (key, left, right) in [
      ("prop:meta:createdAt", Any::from(100.0), Any::from(200.0)),
      ("prop:meta:updatedAt", Any::from(150.0), Any::from(250.0)),
      (
        "prop:meta:createdBy",
        Any::String("first".into()),
        Any::String("second".into()),
      ),
      (
        "prop:meta:updatedBy",
        Any::String("first".into()),
        Any::String("second".into()),
      ),
    ] {
      destination.insert(&mut txn, key, left);
      source.insert(&mut txn, key, right);
    }
    root.remove(&mut txn, 2);
    block_array(&source, &txn, "children")
      .unwrap()
      .push_back(&mut txn, ids[2].as_str());
    let state = txn.encode_state_as_update_v1(&Default::default());
    drop(txn);
    let output = apply_document_mutation(
      &state,
      &DocumentMutation::JoinBlocks {
        block_id: ids[0].clone(),
        source_block_id: ids[1].clone(),
      },
    )
    .unwrap();
    assert_eq!(output.removed_block_ids, vec![ids[1].clone()]);
    assert!(output.inserted_block_ids.is_empty());
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&output.delta).unwrap())
      .unwrap();
    let txn = doc.transact_mut();
    assert_eq!(
      array_string_values(&root, &txn),
      vec![ids[0].clone(), ids[2].clone(), ids[3].clone()]
    );
    assert_eq!(destination.get(&txn, "prop:text"), Some(text_ref.clone()));
    assert_eq!(
      destination.get(&txn, "prop:meta:createdAt"),
      Some(yrs::Out::Any(Any::from(100.0)))
    );
    assert_eq!(
      destination.get(&txn, "prop:meta:updatedBy"),
      Some(yrs::Out::Any(Any::String("first".into())))
    );
    let yrs::Out::YText(text) = text_ref else { panic!() };
    assert_eq!(text.get_string(&txn), "é😀tail");
    let diff = text.diff(&txn, |_| ());
    assert_eq!(diff.len(), 2);
    assert!(
      diff[1]
        .attributes
        .as_ref()
        .is_none_or(|attrs| !attrs.contains_key("bold"))
    );
    assert!(blocks.get(&txn, &ids[1]).is_none());
  }

  #[test]
  fn split_rejects_partial_annotations_encoding_boundaries_and_protected_anchors() {
    let state = crate::markdown_to_yjs("Atoms", "é😀 tail").unwrap();
    let (doc, blocks) = decode(&state);
    let mut txn = doc.transact_mut();
    let id = array_string_values(&find_content_root(&blocks, &txn).unwrap(), &txn)[0].clone();
    let block = native_block(&blocks, &txn, &id).unwrap();
    let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
      panic!()
    };
    text.format(
      &mut txn,
      6,
      5,
      Attrs::from([("annotation".into(), Any::from_json(r#"{"id":"atom"}"#).unwrap())]),
    );
    text.format(&mut txn, 7, 2, Attrs::from([("italic".into(), Any::Bool(true))]));
    let state = txn.encode_state_as_update_v1(&Default::default());
    drop(txn);
    for position in [1, 3, 7, 8, 9, 10] {
      assert_eq!(
        apply_document_mutation(
          &state,
          &DocumentMutation::SplitBlock {
            block_id: id.clone(),
            position,
            range_unit: None
          }
        )
        .unwrap_err(),
        DocumentMutationError::InvalidTextRange
      );
    }
    assert!(
      apply_document_mutation(
        &state,
        &DocumentMutation::SplitBlock {
          block_id: id.clone(),
          position: 3,
          range_unit: Some(DocumentTextRangeUnit::Utf16CodeUnits)
        }
      )
      .is_ok()
    );
    let mut txn = doc.transact_mut();
    block.insert(
      &mut txn,
      "prop:comments",
      Any::from_json(r#"{"thread":"protected"}"#).unwrap(),
    );
    let state = txn.encode_state_as_update_v1(&Default::default());
    drop(txn);
    assert!(
      apply_document_mutation(
        &state,
        &DocumentMutation::SplitBlock {
          block_id: id,
          position: 0,
          range_unit: None
        }
      )
      .is_err()
    );
  }

  #[test]
  fn join_rejects_metadata_loss_nonadjacency_and_incompatible_kinds() {
    let state = crate::markdown_to_yjs("Protected", "first\n\nsecond\n\nthird").unwrap();
    let (doc, blocks) = decode(&state);
    let mut txn = doc.transact_mut();
    let ids = array_string_values(&find_content_root(&blocks, &txn).unwrap(), &txn);
    let source = native_block(&blocks, &txn, &ids[1]).unwrap();
    for (key, value) in [
      (
        "prop:repeat",
        Any::from_json(r#"{"source":"workspace.members"}"#).unwrap(),
      ),
      ("prop:markdownAnchor", Any::String("anchor".into())),
      ("prop:comments", Any::from_json(r#"{"thread":"x"}"#).unwrap()),
      ("prop:type", Any::String("h2".into())),
    ] {
      let previous = source.get(&txn, key);
      source.insert(&mut txn, key, value);
      let state = txn.encode_state_as_update_v1(&Default::default());
      assert!(
        apply_document_mutation(
          &state,
          &DocumentMutation::JoinBlocks {
            block_id: ids[0].clone(),
            source_block_id: ids[1].clone()
          }
        )
        .is_err()
      );
      source.remove(&mut txn, key);
      if let Some(yrs::Out::Any(value)) = previous {
        source.insert(&mut txn, key, value);
      }
    }
    let state = txn.encode_state_as_update_v1(&Default::default());
    drop(txn);
    assert!(
      apply_document_mutation(
        &state,
        &DocumentMutation::JoinBlocks {
          block_id: ids[0].clone(),
          source_block_id: ids[2].clone()
        }
      )
      .is_err()
    );
  }
}
