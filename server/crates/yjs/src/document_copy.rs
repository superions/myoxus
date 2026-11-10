// SPDX-License-Identifier: AGPL-3.0-or-later
//! Same-document copies of bounded native text/callout structure.

use super::*;

fn supported(flavour: &str) -> bool {
  matches!(
    flavour,
    "myoxus:paragraph"
      | "myoxus:list"
      | "myoxus:callout"
      | "myoxus:code"
      | "myoxus:mermaid"
      | "myoxus:latex"
      | "myoxus:annotation"
      | "myoxus:divider"
      | "myoxus:image"
      | "myoxus:bookmark"
  )
}

fn check_text_anchors(value: yrs::Out, txn: &impl ReadTxn, depth: usize) -> Result<(), DocumentMutationError> {
  if depth > MAX_FRAGMENT_DEPTH {
    return Err(DocumentMutationError::InvalidBlockProperties);
  }
  match value {
    yrs::Out::YText(text) => {
      for chunk in text.diff(txn, |_| ()) {
        let Some(attrs) = chunk.attributes.as_deref() else {
          continue;
        };
        let source = match &chunk.insert {
          yrs::Out::Any(Any::String(value)) => value.as_ref(),
          _ => "",
        };
        crate::document_field::FieldRun::decode(source, attrs)
          .map_err(|_| DocumentMutationError::InvalidBlockProperties)?;
      }
      if text.diff(txn, |_| ()).iter().any(|run| {
        run
          .attributes
          .as_ref()
          .is_some_and(|attrs| attrs.keys().any(|key| key.starts_with("comment-")))
      }) {
        return Err(DocumentMutationError::InvalidBlockProperties);
      }
    }
    yrs::Out::YMap(map) => {
      for (_, value) in map.iter(txn) {
        check_text_anchors(value, txn, depth + 1)?;
      }
    }
    yrs::Out::YArray(array) => {
      for value in array.iter(txn) {
        check_text_anchors(value, txn, depth + 1)?;
      }
    }
    _ => {}
  }
  Ok(())
}

fn remap_copied_inlines(
  value: yrs::Out,
  txn: &mut yrs::TransactionMut<'_>,
  identities: &mut HashMap<String, String>,
  fields: &mut HashMap<String, String>,
) -> Result<(), DocumentMutationError> {
  match value {
    yrs::Out::YText(text) => {
      crate::annotation::remap_copied_text(&text, txn, identities);
      crate::document_field::content::remap_copied_text(&text, txn, fields)
        .map_err(|_| DocumentMutationError::InvalidBlockProperties)?;
    }
    yrs::Out::YMap(map) => {
      let values = map.iter(txn).map(|(_, value)| value).collect::<Vec<_>>();
      for value in values {
        remap_copied_inlines(value, txn, identities, fields)?;
      }
    }
    yrs::Out::YArray(array) => {
      let values = array.iter(txn).collect::<Vec<_>>();
      for value in values {
        remap_copied_inlines(value, txn, identities, fields)?;
      }
    }
    _ => {}
  }
  Ok(())
}

/// Original units and references stay in place. Only new block/annotation/field
/// identities and copied child links are rebound; local footnotes keep their
/// existing external definition target. Managed GFX/table copies are excluded.
pub(crate) fn duplicate_text_subtree(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  id: &str,
  inserted: &mut Vec<String>,
) -> Result<(), DocumentMutationError> {
  let root = native_block(blocks, txn, id)?;
  let root_kind = flavour(&root, txn);
  if !matches!(
    root_kind.as_str(),
    "myoxus:paragraph" | "myoxus:list" | "myoxus:callout"
  ) {
    return Err(DocumentMutationError::InvalidBlockProperties);
  }
  let (parent, siblings, index) = unique_parent(blocks, txn, id)?;
  require_parent(&parent, txn, &root_kind)?;
  validate_text_ancestry(blocks, txn, id, &parent)?;
  let ordered = validate_subtree(blocks, txn, id)?;
  // Finish every admission check before allocating any new native unit.
  for (id, depth) in &ordered {
    let block = native_block(blocks, txn, id)?;
    let kind = flavour(&block, txn);
    if *depth > MAX_FRAGMENT_DEPTH || !supported(&kind) || has_block_comments(&block, txn) {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    for property in ["prop:markdownAnchor", "prop:footnoteIdentifier"] {
      if block.get(txn, property).is_some_and(|value| {
        !matches!(value, yrs::Out::Any(Any::Null | Any::Undefined))
          && !matches!(value,yrs::Out::Any(Any::String(ref value)) if value.is_empty())
      }) {
        return Err(DocumentMutationError::InvalidBlockProperties);
      }
    }
    let children = block_array(&block, txn, "children").ok_or(DocumentMutationError::InvalidBlockProperties)?;
    for value in children.iter(txn) {
      let yrs::Out::Any(Any::String(child_id)) = value else {
        return Err(DocumentMutationError::InvalidBlockProperties);
      };
      let child = native_block(blocks, txn, &child_id)?;
      if !native_parent_allows(&kind, &flavour(&child, txn)) {
        return Err(DocumentMutationError::InvalidBlockProperties);
      }
    }
    crate::native_template_repeat::validate_copied_repeat(&block, txn, &kind, children.len(txn) > 0)
      .map_err(|_| DocumentMutationError::InvalidBlockProperties)?;
    check_text_anchors(yrs::Out::YMap(block), txn, 0)?;
  }
  let ids = ordered
    .iter()
    .map(|(id, _)| (id.clone(), Uuid::new_v4().to_string()))
    .collect::<HashMap<_, _>>();
  let mut annotations = HashMap::new();
  let mut fields = HashMap::new();
  for (id, _) in ordered {
    let original = native_block(blocks, txn, &id)?;
    let new_id = &ids[&id];
    let copy = original.as_prelim(txn);
    let copied = blocks.insert(txn, new_id.as_str(), copy);
    copied.insert(txn, "sys:id", new_id.as_str());
    copied.insert(txn, "sys:flavour", flavour(&original, txn));
    let children = block_array(&copied, txn, "children").ok_or(DocumentMutationError::InvalidBlockProperties)?;
    let rewritten = array_string_values(&children, txn)
      .into_iter()
      .map(|child| ids[&child].clone())
      .collect::<Vec<_>>();
    children.remove_range(txn, 0, children.len(txn));
    insert_ids(&children, txn, 0, &rewritten);
    remap_copied_inlines(yrs::Out::YMap(copied), txn, &mut annotations, &mut fields)?;
    inserted.push(new_id.clone());
  }
  siblings.insert(txn, index + 1, ids[id].as_str());
  Ok(())
}

#[cfg(test)]
mod tests {
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
  fn text(block: &yrs::MapRef, txn: &impl ReadTxn) -> yrs::TextRef {
    let Some(yrs::Out::YText(text)) = block.get(txn, "prop:text") else {
      panic!("native text")
    };
    text
  }
  fn duplicate(state: &[u8], id: &str) -> Result<DocumentMutationOutput, DocumentMutationError> {
    apply_document_mutation(state, &DocumentMutation::DuplicateBlock { block_id: id.into() })
  }

  #[test]
  fn native_copy_keeps_filled_values_marks_and_independent_field_identities() {
    let state = crate::markdown_to_yjs("Copy", "Source\n\nNeighbor").unwrap();
    let (doc, blocks) = decode(&state);
    let (source_id, state) = {
      let mut txn = doc.transact_mut();
      let source_id = array_string_values(&find_content_root(&blocks, &txn).unwrap(), &txn)[0].clone();
      let source = native_block(&blocks, &txn, &source_id).unwrap();
      let text = text(&source, &txn);
      let end = text.len(&txn);
      text.insert_with_attributes(&mut txn, end, " ", Attrs::from([
        ("bold".into(), Any::Bool(true)),
        ("documentField".into(), Any::from_json(r#"{"type":"input","id":"original-field","definition":{"kind":"text","label":"Answer","required":true,"default":"Default"},"value":"Filled {{literal}}"}"#).unwrap()),
      ]));
      (source_id, txn.encode_state_as_update_v1(&Default::default()))
    };
    let copied = duplicate(&state, &source_id).unwrap();
    let fields = crate::document_field::content::inspect(&copied.state).unwrap();
    assert_eq!(fields.len(), 2);
    assert_ne!(fields[0].run.descriptor.id(), fields[1].run.descriptor.id());
    assert!(fields.iter().any(|field| field.run.descriptor.id() == "original-field"));
    for field in fields {
      let crate::document_field::DocumentField::Input { value, .. } = field.run.descriptor else {
        panic!("input")
      };
      assert_eq!(
        value,
        crate::document_field::InputValue::Scalar(Some("Filled {{literal}}".into()))
      );
      assert_eq!(field.run.attributes.get("bold"), Some(&Any::Bool(true)));
    }
  }

  #[test]
  fn duplicate_rejects_protected_or_unsupported_content_without_dropping_it() {
    let state = crate::markdown_to_yjs("Protected copy", "Source\n\nNeighbor").unwrap();
    for property in [
      "prop:comments",
      "prop:markdownAnchor",
      "prop:footnoteIdentifier",
      "prop:repeat",
    ] {
      let (doc, blocks) = decode(&state);
      let mut txn = doc.transact_mut();
      let ids = array_string_values(&find_content_root(&blocks, &txn).unwrap(), &txn);
      let root = native_block(&blocks, &txn, &ids[0]).unwrap();
      let value = match property {
        "prop:comments" => Any::from_json(r#"{"thread":true}"#).unwrap(),
        "prop:repeat" => Any::from_json(r#"{"source":"unsupported","alias":"member"}"#).unwrap(),
        _ => Any::String("protected".into()),
      };
      root.insert(&mut txn, property, value);
      let state = txn.encode_state_as_update_v1(&Default::default());
      drop(txn);
      assert_eq!(
        duplicate(&state, &ids[0]).unwrap_err(),
        DocumentMutationError::InvalidBlockProperties
      );
    }
    for corrupt in ["comment", "child", "shared", "table", "code-parent"] {
      let (doc, blocks) = decode(&state);
      let mut txn = doc.transact_mut();
      let parent = find_content_root(&blocks, &txn).unwrap();
      let ids = array_string_values(&parent, &txn);
      let root = native_block(&blocks, &txn, &ids[0]).unwrap();
      let children = block_array(&root, &txn, "children").unwrap();
      match corrupt {
        "comment" => text(&root, &txn).format(
          &mut txn,
          0,
          1,
          Attrs::from([("comment-thread".into(), Any::Bool(true))]),
        ),
        "child" => {
          children.push_back(&mut txn, 42.0);
        }
        "shared" => {
          children.push_back(&mut txn, ids[1].as_str());
        }
        "table" => {
          let (table, _) = create_yjs_block(&blocks, &mut txn, "table", "myoxus:table");
          let _ = table;
          children.push_back(&mut txn, "table");
        }
        "code-parent" => {
          let code = create_yjs_text_block(&blocks, &mut txn, "code", "myoxus:code", &[]);
          parent.remove(&mut txn, 0);
          parent.push_back(&mut txn, "code");
          block_array(&code, &txn, "children")
            .unwrap()
            .push_back(&mut txn, ids[0].as_str());
        }
        _ => unreachable!(),
      }
      let state = txn.encode_state_as_update_v1(&Default::default());
      drop(txn);
      assert!(duplicate(&state, &ids[0]).is_err(), "{corrupt}");
    }
  }

  #[test]
  fn duplication_bounds_depth_and_total_native_units() {
    for deep in [false, true] {
      let state = crate::markdown_to_yjs("Bounded", "Root").unwrap();
      let (doc, blocks) = decode(&state);
      let mut txn = doc.transact_mut();
      let root = array_string_values(&find_content_root(&blocks, &txn).unwrap(), &txn)[0].clone();
      let mut parent = native_block(&blocks, &txn, &root).unwrap();
      for index in 0..if deep {
        MAX_FRAGMENT_DEPTH + 1
      } else {
        MAX_FRAGMENT_BLOCKS
      } {
        let id = format!("bounded-{index}");
        let node = create_yjs_text_block(&blocks, &mut txn, &id, "myoxus:paragraph", &[]);
        block_array(&parent, &txn, "children")
          .unwrap()
          .push_back(&mut txn, id.as_str());
        if deep {
          parent = node;
        }
      }
      let state = txn.encode_state_as_update_v1(&Default::default());
      drop(txn);
      assert!(duplicate(&state, &root).is_err());
    }
  }

  #[test]
  fn native_parent_rules_keep_existing_moves_and_reject_leaf_targets_and_cycles() {
    let state = crate::markdown_to_yjs(
      "Moves",
      "First\n\nSecond\n\n- List\n\n```text\nCode\n```\n\n| H |\n|---|\n| V |",
    )
    .unwrap();
    let (doc, blocks) = decode(&state);
    let txn = doc.transact_mut();
    let root = find_content_root(&blocks, &txn).unwrap();
    let ids = array_string_values(&root, &txn);
    assert_eq!(ids.len(), 5);
    let state = txn.encode_state_as_update_v1(&Default::default());
    drop(txn);
    let nested = apply_document_mutation(
      &state,
      &DocumentMutation::MoveBlock {
        block_id: ids[1].clone(),
        parent_block_id: Some(ids[0].clone()),
        after_block_id: None,
      },
    )
    .unwrap();
    assert!(nested.inserted_block_ids.is_empty() && nested.removed_block_ids.is_empty());
    assert_eq!(
      apply_document_mutation(
        &nested.state,
        &DocumentMutation::MoveBlock {
          block_id: ids[0].clone(),
          parent_block_id: Some(ids[1].clone()),
          after_block_id: None
        }
      )
      .unwrap_err(),
      DocumentMutationError::MoveCycle
    );
    let restored = apply_document_mutation(
      &nested.state,
      &DocumentMutation::MoveBlock {
        block_id: ids[1].clone(),
        parent_block_id: None,
        after_block_id: Some(ids[0].clone()),
      },
    )
    .unwrap();
    let (peer, maps) = decode(&restored.state);
    let txn = peer.transact_mut();
    assert_eq!(array_string_values(&find_content_root(&maps, &txn).unwrap(), &txn), ids);
    drop(txn);
    for (source, parent) in [(0, 3), (0, 4), (4, 2)] {
      assert!(
        apply_document_mutation(
          &state,
          &DocumentMutation::MoveBlock {
            block_id: ids[source].clone(),
            parent_block_id: Some(ids[parent].clone()),
            after_block_id: None
          }
        )
        .is_err()
      );
    }
    let (repeat_doc, repeat_blocks) = decode(&state);
    let mut repeat_txn = repeat_doc.transact_mut();
    let repeated = native_block(&repeat_blocks, &repeat_txn, &ids[0]).unwrap();
    repeated.insert(
      &mut repeat_txn,
      "prop:repeat",
      Any::from_json(r#"{"source":"workspace.members","alias":"member"}"#).unwrap(),
    );
    let repeat_state = repeat_txn.encode_state_as_update_v1(&Default::default());
    drop(repeat_txn);
    assert!(
      apply_document_mutation(
        &repeat_state,
        &DocumentMutation::MoveBlock {
          block_id: ids[1].clone(),
          parent_block_id: Some(ids[0].clone()),
          after_block_id: None
        }
      )
      .is_err()
    );
    let valid = apply_document_mutation(
      &state,
      &DocumentMutation::MoveBlock {
        block_id: ids[3].clone(),
        parent_block_id: Some(ids[2].clone()),
        after_block_id: None,
      },
    )
    .unwrap();
    assert!(valid.removed_block_ids.is_empty());
    assert!(
      apply_document_mutation(
        &state,
        &DocumentMutation::MoveBlock {
          block_id: ids[0].clone(),
          parent_block_id: Some(ids[2].clone()),
          after_block_id: Some(ids[1].clone())
        }
      )
      .is_err()
    );
  }

  #[test]
  fn transcription_parent_intersection_protects_conversion_split_and_copy() {
    let state = crate::markdown_to_yjs("Parents", "Paragraph").unwrap();
    let (doc, blocks) = decode(&state);
    let mut txn = doc.transact_mut();
    let note = find_content_root(&blocks, &txn).unwrap();
    let id = array_string_values(&note, &txn)[0].clone();
    note.remove(&mut txn, 0);
    let (_, attachment) = create_yjs_block(&blocks, &mut txn, "attachment", "myoxus:attachment");
    note.push_back(&mut txn, "attachment");
    let (_, transcription) = create_yjs_block(&blocks, &mut txn, "transcription", "myoxus:transcription");
    attachment.push_back(&mut txn, "transcription");
    transcription.push_back(&mut txn, id.as_str());
    let callout = create_yjs_text_block(&blocks, &mut txn, "callout", "myoxus:callout", &[]);
    let _ = callout;
    transcription.push_back(&mut txn, "callout");
    let state = txn.encode_state_as_update_v1(&Default::default());
    drop(txn);
    for mutation in [
      DocumentMutation::ConvertBlock {
        block_id: id.clone(),
        block_kind: DocumentTextBlockKind::Heading2,
      },
      DocumentMutation::SplitBlock {
        block_id: id.clone(),
        position: 0,
        range_unit: None,
      },
      DocumentMutation::DuplicateBlock { block_id: id },
    ] {
      assert_eq!(
        apply_document_mutation(&state, &mutation).unwrap_err(),
        DocumentMutationError::InvalidBlockProperties
      );
    }
    assert!(duplicate(&state, "callout").is_ok());
    assert!(native_parent_allows("myoxus:attachment", "myoxus:transcription"));
    assert!(!native_parent_allows("myoxus:callout", "myoxus:event"));
    assert!(!native_parent_allows("myoxus:edgeless-text", "myoxus:callout"));
  }

  #[test]
  fn fragment_parent_checks_preserve_native_creation_defaults_and_reject_incompatible_edges() {
    for (parent, child, allowed) in [
      (
        "myoxus:list",
        DocumentFragmentBlock::Table {
          properties: None,
          rows: vec![vec![vec![]]],
          header_rows: None,
        },
        false,
      ),
      (
        "myoxus:callout",
        DocumentFragmentBlock::Code {
          properties: None,
          native_latex: true,
          language: "latex".into(),
          text: "x".into(),
        },
        false,
      ),
      (
        "myoxus:footnote-definition",
        DocumentFragmentBlock::Paragraph {
          properties: None,
          text: vec![],
        },
        true,
      ),
    ] {
      assert_eq!(native_parent_allows(parent, fragment_flavour(&child)), allowed);
    }
    let state = crate::markdown_to_yjs("Insert", "Parent\n\n- Anchor").unwrap();
    let (doc, blocks) = decode(&state);
    let mut txn = doc.transact_mut();
    let root = find_content_root(&blocks, &txn).unwrap();
    let ids = array_string_values(&root, &txn);
    let paragraph = native_block(&blocks, &txn, &ids[0]).unwrap();
    root.remove(&mut txn, 1);
    block_array(&paragraph, &txn, "children")
      .unwrap()
      .push_back(&mut txn, ids[1].as_str());
    let state = txn.encode_state_as_update_v1(&Default::default());
    drop(txn);
    let fragment = DocumentFragment {
      schema_version: DOCUMENT_FRAGMENT_SCHEMA.into(),
      blocks: vec![DocumentFragmentBlock::Table {
        properties: None,
        rows: vec![vec![vec![DocumentTextSegment {
          text: "Cell".into(),
          ..Default::default()
        }]]],
        header_rows: None,
      }],
    };
    let nested = DocumentFragment {
      schema_version: DOCUMENT_FRAGMENT_SCHEMA.into(),
      blocks: vec![DocumentFragmentBlock::ListItem {
        properties: None,
        list_kind: DocumentListKind::Bulleted,
        text: vec![],
        checked: false,
        children: fragment.blocks.clone(),
      }],
    };
    assert!(
      validate_mutation_fragment(&DocumentMutation::AppendBlocks {
        fragment: nested.clone()
      })
      .is_ok()
    );
    assert_eq!(
      apply_document_mutation(
        &state,
        &DocumentMutation::InsertAfterBlock {
          block_id: ids[1].clone(),
          fragment: nested,
        }
      )
      .unwrap_err(),
      DocumentMutationError::InvalidBlockProperties
    );
    let inserted = apply_document_mutation(
      &state,
      &DocumentMutation::InsertAfterBlock {
        block_id: ids[1].clone(),
        fragment,
      },
    )
    .unwrap();
    let (peer, maps) = decode(&inserted.state);
    let txn = peer.transact_mut();
    let table = native_block(&maps, &txn, &inserted.inserted_block_ids[0]).unwrap();
    assert_eq!(flavour(&table, &txn), "myoxus:table");
    assert!(table.get(&txn, "prop:headerRows").is_none());
    assert_eq!(
      unique_parent(&maps, &txn, &inserted.inserted_block_ids[0]).unwrap().0,
      native_block(&maps, &txn, &ids[0]).unwrap()
    );
  }
}
