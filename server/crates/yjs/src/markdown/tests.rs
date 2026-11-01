// SPDX-License-Identifier: AGPL-3.0-or-later

use super::{
  MarkdownDiagnosticCode, MarkdownDocumentReference, MarkdownResolvedReference, extract_text_from_yjs,
  extract_text_from_yjs_with_references, markdown_to_yjs, markdown_to_yjs_with_link_resolver,
  markdown_to_yjs_with_references,
};
use crate::*;
use yrs::{GetString, Text};

fn footnote_native_state(update: &[u8]) -> (Vec<(String, String, Vec<String>)>, Vec<serde_json::Value>) {
  let doc = Doc::new();
  doc
    .transact_mut()
    .apply_update(Update::decode_v1(update).unwrap())
    .unwrap();
  let txn = doc.transact();
  let blocks = txn.get_map("blocks").unwrap();
  let mut definitions = Vec::new();
  let mut markers = Vec::new();
  let mut roots = 0;
  for (id, value) in blocks.iter(&txn) {
    let yrs::Out::YMap(block) = value else {
      panic!("native block map")
    };
    let flavour = block_string(&block, &txn, "flavour").unwrap();
    roots += usize::from(flavour == "myoxus:page");
    if flavour == "myoxus:footnote-definition" {
      let children = block_children(&block, &txn);
      let child_flavours = children
        .iter()
        .map(|id| {
          let Some(yrs::Out::YMap(child)) = blocks.get(&txn, id) else {
            panic!("complete native definition child")
          };
          block_string(&child, &txn, "flavour").unwrap()
        })
        .collect();
      definitions.push((
        id.to_string(),
        block_prop_string(&block, &txn, "label").unwrap(),
        child_flavours,
      ));
    }
    for (_, value) in block.iter(&txn) {
      if let yrs::Out::YText(text) = value {
        for part in text.diff(&txn, yrs::types::text::YChange::identity) {
          if let Some(footnote) = part
            .attributes
            .as_deref()
            .and_then(|attributes| attributes.get("footnote"))
          {
            assert_eq!(part.insert.to_string(&txn), " ", "atomic native marker");
            markers.push(yjs_any_to_json(footnote));
          }
        }
      }
    }
  }
  assert_eq!(roots, 1, "one native document root; no definition documents");
  definitions.sort_by(|left, right| left.1.cmp(&right.1));
  for marker in &markers {
    if let Some(id) = marker["definitionId"].as_str() {
      assert!(marker.get("reference").is_none(), "exclusive local branch");
      let target = definitions
        .iter()
        .find(|definition| definition.0 == id)
        .expect("same-parent local block target");
      assert_eq!(
        super::import::normalize_footnote_label(marker["label"].as_str().unwrap()),
        super::import::normalize_footnote_label(&target.1)
      );
    }
  }
  (definitions, markers)
}

#[test]
fn parent_local_footnotes_share_client_fixtures_and_reject_before_returning_a_document() {
  let fixtures: serde_json::Value =
    serde_json::from_str(include_str!("../../../../../build/fixtures/contracts/footnotes.json")).unwrap();
  for fixture in fixtures.as_array().unwrap() {
    let result = markdown_to_yjs_with_link_resolver("Footnotes", fixture["source"].as_str().unwrap(), &|_| {
      super::MarkdownLinkResolution::Ordinary
    });
    if let Some(expected) = fixture["error"].as_str() {
      let error = result.unwrap_err();
      assert!(error.contains(expected), "{}: {error}", fixture["name"]);
      assert!(!error.contains("private payload should not appear"));
      continue;
    }
    let imported = result.unwrap();
    let (definitions, markers) = footnote_native_state(&imported.yjs_binary);
    let mut labels: Vec<_> = fixture["labels"]
      .as_array()
      .unwrap()
      .iter()
      .map(|label| label.as_str().unwrap())
      .collect();
    labels.sort();
    assert_eq!(
      definitions
        .iter()
        .map(|definition| definition.1.as_str())
        .collect::<Vec<_>>(),
      labels,
      "{}",
      fixture["name"]
    );
    assert_eq!(
      markers.len(),
      fixture["markers"].as_u64().unwrap() as usize,
      "{}",
      fixture["name"]
    );
    let unreferenced = |diagnostics: &[super::MarkdownDiagnostic]| {
      diagnostics
        .iter()
        .filter(|finding| finding.code == MarkdownDiagnosticCode::UnreferencedFootnote)
        .count()
    };
    assert_eq!(
      unreferenced(&imported.diagnostics),
      fixture["unreferenced"].as_u64().unwrap() as usize
    );
    let exported = extract_text_from_yjs(&imported.yjs_binary).unwrap();
    assert!(
      !exported.extraction_partial,
      "{}: {:?}",
      fixture["name"], exported.diagnostics
    );
    assert_eq!(
      unreferenced(&exported.diagnostics),
      fixture["unreferenced"].as_u64().unwrap() as usize
    );
    for label in labels {
      assert_eq!(exported.markdown.matches(&format!("[^{label}]:")).count(), 1);
    }
    let again = markdown_to_yjs_with_link_resolver("Footnotes", &exported.markdown, &|_| {
      super::MarkdownLinkResolution::Ordinary
    })
    .unwrap();
    let (again_definitions, again_markers) = footnote_native_state(&again.yjs_binary);
    assert_eq!(
      again_definitions
        .iter()
        .map(|definition| (&definition.1, &definition.2))
        .collect::<Vec<_>>(),
      definitions
        .iter()
        .map(|definition| (&definition.1, &definition.2))
        .collect::<Vec<_>>()
    );
    assert_eq!(again_markers.len(), markers.len());
    assert_eq!(
      extract_text_from_yjs(&again.yjs_binary).unwrap().markdown,
      exported.markdown,
      "{}",
      fixture["name"]
    );
  }
}

#[test]
fn endnote_export_reports_placement_loss_without_losing_rich_or_unused_bodies() {
  let source = "Body[^secret-label].\n\n[^secret-label]: **Rich body**.\n\n    Second paragraph.\n\n[^unused]: Retained unused body.\n";
  let binary = markdown_to_yjs("Endnotes", source).unwrap();
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();
  txn.apply_update(Update::decode_v1(&binary).unwrap()).unwrap();
  let definitions: Vec<_> = blocks
    .iter(&txn)
    .filter_map(|(_, value)| {
      let yrs::Out::YMap(block) = value else { return None };
      (block_string(&block, &txn, "flavour").as_deref() == Some("myoxus:footnote-definition")).then_some(block)
    })
    .collect();
  for definition in &definitions {
    definition.insert(&mut txn, "prop:placement", "endnote");
  }
  let binary = txn.encode_state_as_update_v1(&StateVector::default());
  drop(txn);
  let output = extract_text_from_yjs(&binary).unwrap();
  assert!(!output.extraction_partial);
  assert_eq!(
    output
      .diagnostics
      .iter()
      .filter(|d| d.code == MarkdownDiagnosticCode::NormalizedEndnote)
      .count(),
    2
  );
  assert!(output.markdown.contains("**Rich body**"));
  assert!(output.markdown.contains("Second paragraph."));
  assert_eq!(output.markdown.matches("[^unused]: Retained unused body.").count(), 1);
  let reimported = markdown_to_yjs("Reimport", &output.markdown).unwrap();
  assert!(
    !extract_text_from_yjs(&reimported)
      .unwrap()
      .diagnostics
      .iter()
      .any(|d| d.code == MarkdownDiagnosticCode::NormalizedEndnote)
  );
  let mut txn = doc.transact_mut();
  definitions[0].insert(&mut txn, "prop:placement", "invalid");
  let invalid = txn.encode_state_as_update_v1(&StateVector::default());
  drop(txn);
  assert!(extract_text_from_yjs(&invalid).unwrap_err().contains("placement"));
}

#[test]
fn complete_footnote_fixture_retains_normal_children_marks_alignment_and_list_order() {
  let source = include_str!("../../../../../build/fixtures/markdown/obsidian-vault/Structured footnotes.md");
  let update = markdown_to_yjs("Structured footnotes", source).unwrap();
  let (definitions, markers) = footnote_native_state(&update);
  assert_eq!(definitions.len(), 2);
  assert_eq!(markers.len(), 4);
  let research = definitions
    .iter()
    .find(|definition| definition.1 == "Research")
    .unwrap();
  assert_eq!(
    research.2,
    vec![
      "myoxus:paragraph",
      "myoxus:paragraph",
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:paragraph",
      "myoxus:code",
      "myoxus:image",
      "myoxus:table"
    ]
  );
  let local_ids = markers
    .iter()
    .filter_map(|marker| marker["definitionId"].as_str())
    .collect::<Vec<_>>();
  assert_eq!(local_ids.iter().filter(|id| **id == research.0).count(), 2);
  let doc = Doc::new();
  doc
    .transact_mut()
    .apply_update(Update::decode_v1(&update).unwrap())
    .unwrap();
  let txn = doc.transact();
  let blocks = txn.get_map("blocks").unwrap();
  let Some(yrs::Out::YMap(definition)) = blocks.get(&txn, &research.0) else {
    panic!("native definition")
  };
  let children = block_children(&definition, &txn);
  let child = |index: usize| {
    let Some(yrs::Out::YMap(block)) = blocks.get(&txn, &children[index]) else {
      panic!("normal child")
    };
    block
  };
  assert!(
    matches!(child(3).get(&txn, "prop:order"), Some(yrs::Out::Any(Any::Number(value))) if value.as_f64() == Some(3.0)),
    "client Number schema, not BigInt"
  );
  assert_eq!(block_prop_string(&child(2), &txn, "type").as_deref(), Some("h3"));
  assert_eq!(block_children(&child(3), &txn).len(), 3);
  assert_eq!(
    block_prop_string(&child(6), &txn, "sourceId").as_deref(),
    Some("media/pixel.svg")
  );
  for (index, align) in ["left", "center", "right"].iter().enumerate() {
    assert_eq!(
      child(7)
        .get(&txn, &format!("prop:columns.col-{index:04}.textAlign"))
        .unwrap()
        .to_string(&txn),
      *align
    );
  }
  let exported = extract_text_from_yjs(&update).unwrap();
  assert!(!exported.extraction_partial);
  for content in [
    "**bold**",
    "*emphasis*",
    "~~strike~~",
    "`inline code`",
    "[normal link](https://example.org/reference)",
    "Continued after the hard break.",
    "3. Ordered item",
    "- [x] Completed task",
    "- [ ] Pending task",
    "> Quoted definition text.",
    "literal[^not-a-reference]",
    "media/pixel.svg",
    "| one | two | three |",
  ] {
    assert!(
      exported.markdown.contains(content),
      "missing {content}: {}",
      exported.markdown
    );
  }
  assert!(
    exported
      .markdown
      .contains("Pending task\n\n    > Quoted definition text."),
    "Obsidian must read the quote as a sibling after the nested list: {}",
    exported.markdown
  );
  let again = markdown_to_yjs("Structured footnotes", &exported.markdown).unwrap();
  assert_eq!(extract_text_from_yjs(&again).unwrap().markdown, exported.markdown);
  for _ in 0..8 {
    assert_eq!(
      extract_text_from_yjs(&update).unwrap().markdown,
      exported.markdown,
      "Yjs unordered maps must not change canonical citation bytes"
    );
  }
}

#[test]
fn native_footnote_export_fails_closed_for_dangling_and_mutually_exclusive_targets() {
  let update = markdown_to_yjs(
    "Footnotes",
    "Read[^local] and[^other].\n\n[^local]: body\n\n[^other]: another body",
  )
  .unwrap();
  let (definitions, _) = footnote_native_state(&update);
  for case in 0..3 {
    let doc = Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&update).unwrap())
      .unwrap();
    let blocks = doc.transact().get_map("blocks").unwrap();
    if case == 1 {
      let paragraph = {
        let txn = doc.transact();
        blocks
          .iter(&txn)
          .find_map(|(_, value)| {
            let yrs::Out::YMap(block) = value else { return None };
            let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
              return None;
            };
            text.get_string(&txn).starts_with("Read").then_some(text)
          })
          .unwrap()
      };
      let length = paragraph.len(&doc.transact());
      let footnote = serde_json::json!({"label":"local","definitionId":definitions[0].0,"reference":{"type":"url","url":"https://example.org"}});
      paragraph.format(
        &mut doc.transact_mut(),
        0,
        length,
        Attrs::from([("footnote".into(), json_to_yjs_any(&footnote).unwrap())]),
      );
    } else if case == 2 {
      let Some(yrs::Out::YMap(definition)) = blocks.get(&doc.transact(), &definitions[1].0) else {
        panic!("native definition")
      };
      definition.insert(&mut doc.transact_mut(), "prop:label", definitions[0].1.as_str());
    } else {
      blocks.remove(&mut doc.transact_mut(), &definitions[0].0);
    }
    let changed = doc.transact().encode_state_as_update_v1(&StateVector::default());
    let error = extract_text_from_yjs(&changed).unwrap_err();
    assert!(
      error.contains(if case == 2 {
        "Conflicting footnote definition"
      } else {
        "Unresolved footnote definition"
      }),
      "{error}"
    );
  }
}

#[test]
fn math_uses_real_latex_models_and_shared_client_roundtrip_fixtures() {
  let fixtures: serde_json::Value = serde_json::from_str(include_str!(
    "../../../../../build/fixtures/contracts/math-interchange.json"
  ))
  .unwrap();
  for fixture in fixtures.as_array().unwrap() {
    let imported = markdown_to_yjs_with_link_resolver("Math", fixture["source"].as_str().unwrap(), &|_| {
      super::MarkdownLinkResolution::Ordinary
    })
    .unwrap();
    let doc = Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&imported.yjs_binary).unwrap())
      .unwrap();
    let txn = doc.transact();
    let mut inline = Vec::new();
    let mut display = Vec::new();
    for (_, value) in txn.get_map("blocks").unwrap().iter(&txn) {
      let yrs::Out::YMap(block) = value else { continue };
      if matches!(block.get(&txn, "sys:flavour"), Some(yrs::Out::Any(Any::String(value))) if value.as_ref() == "myoxus:latex")
      {
        assert!(matches!(
          block.get(&txn, "sys:version"),
          Some(yrs::Out::Any(Any::Number(value))) if value.as_f64() == Some(1.0)
        ));
        let Some(yrs::Out::Any(Any::String(formula))) = block.get(&txn, "prop:latex") else {
          panic!("native formula source")
        };
        display.push(formula.to_string());
      }
      for (_, value) in block.iter(&txn) {
        let yrs::Out::YText(text) = value else { continue };
        for diff in text.diff(&txn, yrs::types::text::YChange::identity) {
          if let Some(Any::String(formula)) = diff.attributes.as_deref().and_then(|attrs| attrs.get("latex")) {
            assert!(matches!(diff.insert, yrs::Out::Any(Any::String(ref value)) if value.as_ref() == " "));
            inline.push(formula.to_string());
          }
        }
      }
    }
    inline.sort();
    display.sort();
    let expected = |key: &str| {
      let mut values: Vec<_> = fixture[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
      values.sort();
      values
    };
    assert_eq!(inline, expected("inline"), "{}", fixture["name"]);
    assert_eq!(display, expected("display"), "{}", fixture["name"]);
    assert_eq!(imported.native_math_count, inline.len() + display.len());
    assert_eq!(
      imported
        .diagnostics
        .iter()
        .filter(|d| d.code == MarkdownDiagnosticCode::UnsupportedMath)
        .count(),
      fixture["unsupported"].as_u64().unwrap() as usize,
      "{}",
      fixture["name"]
    );
    let exported = extract_text_from_yjs(&imported.yjs_binary).unwrap();
    for formula in inline.iter().chain(display.iter()) {
      assert!(exported.markdown.contains(formula), "{}", fixture["name"]);
    }
    let reparsed =
      markdown_to_yjs_with_link_resolver("Math", &exported.markdown, &|_| super::MarkdownLinkResolution::Ordinary)
        .unwrap();
    assert_eq!(
      reparsed.native_math_count, imported.native_math_count,
      "{}: {}",
      fixture["name"], exported.markdown
    );
  }
}

#[test]
fn whole_document_embeds_share_registered_client_fixtures_and_keep_relations() {
  let fixtures: serde_json::Value = serde_json::from_str(include_str!(
    "../../../../../build/fixtures/contracts/document-embeds.json"
  ))
  .unwrap();
  let resolver = |target: super::MarkdownLinkTarget<'_>| match target {
    super::MarkdownLinkTarget::Wiki("Target" | "Target.md" | "Target.v2") => {
      super::MarkdownLinkResolution::Reference(MarkdownDocumentReference {
        page_id: "opaque-target-key".into(),
        ..Default::default()
      })
    }
    _ => super::MarkdownLinkResolution::Unresolved,
  };
  for fixture in fixtures.as_array().unwrap() {
    if fixture["serverRejected"].as_bool() == Some(true) {
      assert_eq!(
        markdown_to_yjs_with_link_resolver("Fixture", fixture["source"].as_str().unwrap(), &resolver).unwrap_err(),
        "unsupported raw HTML in Markdown"
      );
      continue;
    }
    let imported =
      markdown_to_yjs_with_link_resolver("Fixture", fixture["source"].as_str().unwrap(), &resolver).unwrap();
    let references = extract_document_references_from_yjs(&imported.yjs_binary).unwrap();
    let embeds: Vec<_> = references
      .occurrences
      .iter()
      .filter(|reference| reference.link_kind == DocumentReferenceLinkKind::EmbedSyncedDoc)
      .collect();
    assert_eq!(
      embeds.len(),
      fixture["embeds"].as_u64().unwrap() as usize,
      "{}",
      fixture["name"]
    );
    assert_eq!(
      references.occurrences.len() - embeds.len(),
      fixture["links"].as_u64().unwrap() as usize,
      "{}",
      fixture["name"]
    );
    for (code, key) in [
      (MarkdownDiagnosticCode::UnresolvedDocumentReference, "unresolved"),
      (MarkdownDiagnosticCode::UnsupportedDocumentReference, "unsupported"),
    ] {
      assert_eq!(
        imported
          .diagnostics
          .iter()
          .filter(|finding| finding.code == code)
          .count(),
        fixture[key].as_u64().unwrap() as usize,
        "{}",
        fixture["name"]
      );
    }
    assert!(
      embeds
        .iter()
        .all(|reference| reference.raw_target_doc_id == "opaque-target-key")
    );
    let exported = extract_text_from_yjs_with_references(&imported.yjs_binary, &|_| true, &|reference| {
      (reference.page_id == "opaque-target-key").then(|| MarkdownResolvedReference {
        url: "Target.md".into(),
        title: "Current target title".into(),
      })
    })
    .unwrap();
    let again = markdown_to_yjs_with_link_resolver("Again", &exported.markdown, &resolver).unwrap();
    let again = extract_document_references_from_yjs(&again.yjs_binary).unwrap();
    assert_eq!(
      again
        .occurrences
        .iter()
        .filter(|reference| reference.link_kind == DocumentReferenceLinkKind::EmbedSyncedDoc)
        .count(),
      embeds.len(),
      "{}",
      fixture["name"]
    );
    if fixture["name"] == "rich surrounding prose" {
      assert!(exported.markdown.find("Before").unwrap() < exported.markdown.find("![[Target.md]]").unwrap());
      assert!(exported.markdown.find("![[Target.md]]").unwrap() < exported.markdown.find("after").unwrap());
      assert!(exported.markdown.contains("**Before**"));
    }
    if fixture["name"] == "whole note and normal link" {
      assert!(exported.markdown.contains("![[Target.md|Live review]]"));
    }
    if fixture["name"] == "list and quote owners" {
      assert!(exported.markdown.contains("afterwards."));
      assert!(
        embeds
          .iter()
          .all(|reference| reference.source_parent_block_id.is_some())
      );
    }
  }
}

#[test]
fn typed_callouts_share_native_semantics_with_client_fixtures() {
  let fixtures: serde_json::Value = serde_json::from_str(include_str!(
    "../../../../../build/fixtures/contracts/note-callouts.json"
  ))
  .unwrap();
  for fixture in fixtures.as_array().unwrap() {
    let source = fixture["source"].as_str().unwrap();
    let expected_native = fixture["native"].as_u64().unwrap() as usize;
    let expected_unsupported = fixture["unsupported"].as_u64().unwrap() as usize;
    assert_eq!(
      super::markdown_callout_support(source),
      (expected_native, expected_unsupported),
      "{}",
      fixture["name"]
    );
    let resolver = |target: super::MarkdownLinkTarget<'_>| match target {
      super::MarkdownLinkTarget::Wiki(target) if target.starts_with("Target") => {
        super::MarkdownLinkResolution::Reference(MarkdownDocumentReference {
          page_id: "target-key".into(),
          title: Some("Open target".into()),
          ..Default::default()
        })
      }
      super::MarkdownLinkTarget::Url("/docs/target-key") => {
        super::MarkdownLinkResolution::Reference(MarkdownDocumentReference {
          page_id: "target-key".into(),
          title: Some("Open target".into()),
          ..Default::default()
        })
      }
      _ => super::MarkdownLinkResolution::Ordinary,
    };
    let imported = markdown_to_yjs_with_link_resolver("Fixture", source, &resolver).unwrap();
    assert_eq!(
      imported
        .diagnostics
        .iter()
        .filter(|finding| finding.code == MarkdownDiagnosticCode::UnsupportedCallout)
        .count(),
      expected_unsupported
    );
    let doc = Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&imported.yjs_binary).unwrap())
      .unwrap();
    let txn = doc.transact();
    let native: Vec<_> = txn.get_map("blocks").unwrap().iter(&txn).filter_map(|(_, value)| match value {
      yrs::Out::YMap(block) if matches!(block.get(&txn, "sys:flavour"), Some(yrs::Out::Any(Any::String(value))) if value.as_ref() == "myoxus:callout") => Some(block),
      _ => None,
    }).collect();
    assert_eq!(native.len(), expected_native);
    let kind = fixture["kind"].as_str().unwrap_or("note");
    if expected_native > 0 {
      let note = native.iter().find(
      |note| matches!(note.get(&txn, "prop:type"), Some(yrs::Out::Any(Any::String(value))) if value.as_ref() == kind),
      ).expect("the native block must retain its authored kind");
      assert!(matches!(note.get(&txn, "prop:type"), Some(yrs::Out::Any(Any::String(value))) if value.as_ref() == kind));
      assert!(
        matches!(note.get(&txn, "prop:foldable"), Some(yrs::Out::Any(Any::Bool(value))) if value == fixture["foldable"].as_bool().unwrap_or(false))
      );
      assert!(
        matches!(note.get(&txn, "prop:defaultOpen"), Some(yrs::Out::Any(Any::Bool(value))) if value == fixture["defaultOpen"].as_bool().unwrap_or(true))
      );
      let Some(yrs::Out::YText(title)) = note.get(&txn, "prop:title") else {
        panic!("custom title must be Y.Text")
      };
      assert_eq!(title.get_string(&txn), fixture["title"].as_str().unwrap());
      assert!(note.get(&txn, "prop:emoji").is_none());
      if fixture["name"] == "paragraphs and lists" {
        let Some(yrs::Out::YText(body)) = note.get(&txn, "prop:text") else {
          panic!("native own body")
        };
        assert_eq!(body.get_string(&txn), "Review the changes. Second line.");
        assert!(body.diff(&txn, yrs::types::text::YChange::identity).iter().any(|diff| {
          diff
            .attributes
            .as_ref()
            .is_some_and(|attrs| attrs.get("bold") == Some(&Any::Bool(true)))
        }));
        assert_eq!(
          extract_document_references_from_yjs(&imported.yjs_binary)
            .unwrap()
            .occurrences[0]
            .raw_target_doc_id,
          "target-key"
        );
      }
      let exported = extract_text_from_yjs_with_references(&imported.yjs_binary, &|_| true, &|_| {
        Some(MarkdownResolvedReference {
          url: "/docs/target-key".into(),
          title: "Open target".into(),
        })
      })
      .unwrap();
      assert!(
        !exported.extraction_partial,
        "{}: {:?}",
        fixture["name"], exported.diagnostics
      );
      if fixture["name"] == "nested child first preserves order" {
        assert!(
          exported.markdown.find("Inner body").unwrap() < exported.markdown.find("Final outer paragraph").unwrap()
        );
      }
      let reimported = markdown_to_yjs_with_link_resolver("Fixture", &exported.markdown, &resolver).unwrap();
      assert!(reimported.diagnostics.is_empty(), "{:?}", reimported.diagnostics);
      let again = extract_text_from_yjs_with_references(&reimported.yjs_binary, &|_| true, &|_| {
        Some(MarkdownResolvedReference {
          url: "/docs/target-key".into(),
          title: "Open target".into(),
        })
      })
      .unwrap();
      assert_eq!(again.markdown, exported.markdown, "current body/title/order roundtrip");
    }
  }
}

#[test]
fn callout_export_preserves_supported_heading_and_reports_unsupported_descendants() {
  let mut builder = YjsDocumentBuilder::new("Notes");
  let callout = builder.push_callout_under("note", "Current title", false, true, None);
  builder.push_paragraph_typed_under(
    &[YjsTextSegment {
      text: "Current heading".into(),
      ..Default::default()
    }],
    Some(2),
    Some(&callout),
  );
  let snapshot = builder
    .doc
    .transact()
    .encode_state_as_update_v1(&yrs::StateVector::default());
  let exported = extract_text_from_yjs(&snapshot).expect("export current callout");
  assert!(exported.markdown.contains("> [!note] Current title"));
  assert!(exported.markdown.contains("> ## Current heading"));
  assert!(!exported.extraction_partial);
  assert!(exported.diagnostics.is_empty());
  builder.push_mermaid_under("graph LR\nCurrent-->Diagram", "", "", Some(&callout));
  let exported = extract_text_from_yjs(&builder.encode()).expect("export complete unsupported child with diagnosis");
  assert!(exported.markdown.contains("Current-->Diagram"));
  assert!(exported.extraction_partial);
  assert!(
    exported
      .diagnostics
      .iter()
      .any(|finding| finding.code == MarkdownDiagnosticCode::UnsupportedCallout)
  );
}

#[test]
fn callouts_reject_at_existing_document_recursion_limit() {
  let source = (1..=100)
    .map(|depth| format!("{}[!note] Level {depth}\n", "> ".repeat(depth)))
    .collect::<String>();
  assert!(
    markdown_to_yjs("Too deep", &source)
      .unwrap_err()
      .contains("recursion limit")
  );
  assert_eq!(super::markdown_callout_support(&source), (0, 100));
}

#[test]
fn annotation_bodies_are_literal_in_document_reference_inventory() {
  let mut builder = YjsDocumentBuilder::new("Annotations");
  let reference = |target: &str| MarkdownDocumentReference {
    page_id: target.into(),
    title: None,
    description: None,
    params: None,
  };
  builder.push_paragraph(&[
    YjsTextSegment {
      text: "hidden".into(),
      reference: Some(reference("hidden-target")),
      ..Default::default()
    },
    YjsTextSegment {
      text: " visible".into(),
      reference: Some(reference("visible-target")),
      ..Default::default()
    },
  ]);
  let sticky = builder.push_annotation_under("sticky", None);
  {
    let mut txn = builder.doc.transact_mut();
    for (id, value) in builder
      .blocks
      .iter(&txn)
      .map(|(id, value)| (id.to_string(), value))
      .collect::<Vec<_>>()
    {
      let yrs::Out::YMap(block) = value else {
        continue;
      };
      let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
        continue;
      };
      if text.get_string(&txn).starts_with("hidden") {
        text.format(
          &mut txn,
          0,
          6,
          Attrs::from([(
            "annotation".into(),
            Any::Map(std::sync::Arc::new(HashMap::from([(
              "id".into(),
              Any::String("a".into()),
            )]))),
          )]),
        );
      } else if id == sticky {
        text.format(
          &mut txn,
          0,
          6,
          Attrs::from([(
            "reference".into(),
            Any::Map(std::sync::Arc::new(HashMap::from([
              ("type".into(), Any::String("LinkedPage".into())),
              ("pageId".into(), Any::String("sticky-target".into())),
            ]))),
          )]),
        );
      }
    }
  }
  let references = extract_document_references_from_yjs(&builder.encode()).unwrap();
  assert_eq!(references.occurrences.len(), 1);
  assert_eq!(references.occurrences[0].raw_target_doc_id, "visible-target");
}

#[test]
fn annotation_interchange_preserves_current_logical_bodies_and_reports_unrepresentable_values() {
  let fixtures: serde_json::Value = serde_json::from_str(include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../build/fixtures/contracts/annotation-interchange.json"
  )))
  .unwrap();
  for fixture in fixtures.as_array().unwrap() {
    let body = fixture["body"].as_str().unwrap();
    let supported = fixture["supported"].as_bool().unwrap();
    let mut builder = YjsDocumentBuilder::new("Annotations");
    builder.push_annotation_under(body, None);
    let native = builder.encode();
    let projected = extract_text_from_yjs(&native).unwrap();
    assert_eq!(
      projected
        .diagnostics
        .iter()
        .any(|finding| finding.code == MarkdownDiagnosticCode::UnsupportedAnnotation),
      !supported,
      "{body:?}"
    );
    assert_eq!(projected.extraction_partial, !supported, "{body:?}");
    let reparsed = markdown_to_yjs("Annotations", &projected.markdown).unwrap();
    let doc = Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&reparsed).unwrap())
      .unwrap();
    let txn = doc.transact();
    let blocks = txn.get_map("blocks").unwrap();
    let bodies: Vec<_> = blocks
      .iter(&txn)
      .filter_map(|(_, value)| {
        let yrs::Out::YMap(block) = value else {
          return None;
        };
        let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
          return None;
        };
        let flavour = block.get(&txn, "sys:flavour").and_then(|value| {
          yjs_any_to_string(match &value {
            yrs::Out::Any(any) => any,
            _ => return None,
          })
        });
        (flavour.as_deref()
          == Some(if supported {
            "myoxus:annotation"
          } else {
            "myoxus:paragraph"
          }))
        .then(|| text.get_string(&txn))
      })
      .collect();
    assert_eq!(
      bodies,
      [if supported {
        body.to_string()
      } else {
        format!("%%{body}%%")
      }],
      "{body:?}"
    );
  }
}

#[test]
fn annotation_writer_groups_yjs_deltas_and_keeps_adjacent_identities_and_ordinary_text() {
  let mut builder = YjsDocumentBuilder::new("Annotations");
  builder.push_paragraph(&[
    YjsTextSegment {
      text: "Before ".into(),
      bold: true,
      ..Default::default()
    },
    YjsTextSegment {
      text: "first\n".into(),
      annotation: Some("a".into()),
      ..Default::default()
    },
    YjsTextSegment {
      text: "second %% ✓".into(),
      annotation: Some("a".into()),
      bold: true,
      ..Default::default()
    },
    YjsTextSegment {
      text: "neighbor".into(),
      annotation: Some("b".into()),
      ..Default::default()
    },
    YjsTextSegment {
      text: " after 80% literal %%pair%%".into(),
      ..Default::default()
    },
  ]);
  builder.push_paragraph(&[YjsTextSegment {
    text: "alone".into(),
    annotation: Some("c".into()),
    ..Default::default()
  }]);
  {
    let mut txn = builder.doc.transact_mut();
    let text = builder
      .blocks
      .iter(&txn)
      .find_map(|(_, value)| {
        let yrs::Out::YMap(block) = value else {
          return None;
        };
        let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
          return None;
        };
        text.get_string(&txn).starts_with("Before ").then_some(text)
      })
      .unwrap();
    text.format(&mut txn, 13, 6, Attrs::from([("bold".into(), Any::Bool(true))]));
    // Literal annotation identity wins over stale formatting attributes from
    // an overlapping editor selection, including an unrepresentable formula.
    text.format(
      &mut txn,
      7,
      6,
      Attrs::from([("latex".into(), Any::String("$stale$".into()))]),
    );
    assert!(
      text
        .diff(&txn, yrs::types::text::YChange::identity)
        .iter()
        .filter(|diff| crate::annotation::annotation_id(diff.attributes.as_deref()) == Some("a"))
        .count()
        > 1
    );
  }
  let projected = extract_text_from_yjs(&builder.encode()).unwrap();
  assert!(
    !projected
      .diagnostics
      .iter()
      .any(|finding| finding.code == MarkdownDiagnosticCode::UnsupportedMath)
  );
  assert!(
    projected
      .markdown
      .starts_with("**Before** %%first\nsecond \\%\\% ✓%%%%neighbor%% after 80% literal \\%\\%pair\\%\\%"),
    "{}",
    projected.markdown
  );
  assert!(projected.diagnostics.contains(&super::MarkdownDiagnostic {
    code: MarkdownDiagnosticCode::NormalizedAnnotation
  }));
  assert!(projected.diagnostics.contains(&super::MarkdownDiagnostic {
    code: MarkdownDiagnosticCode::UnsupportedAnnotation
  }));
  let reimported = markdown_to_yjs("Annotations", &projected.markdown).unwrap();
  let reparsed = extract_text_from_yjs(&reimported).unwrap();
  assert_eq!(reparsed.markdown, projected.markdown);
  assert!(
    !reparsed
      .diagnostics
      .iter()
      .any(|finding| finding.code == MarkdownDiagnosticCode::NormalizedAnnotation)
  );
}

#[test]
fn annotation_import_materializes_native_blocks_and_inline_yjs_text() {
  let update = markdown_to_yjs(
    "Annotations",
    "Before %%**literal** [[Note]] ✓\n\nsecond%% after\n\n%%%%\n\n%%block\nbody%%\n\n  %%padded%%  \n\n`%%code%%`",
  )
  .unwrap();
  let doc = Doc::new();
  doc
    .transact_mut()
    .apply_update(Update::decode_v1(&update).unwrap())
    .unwrap();
  let txn = doc.transact();
  let blocks = txn.get_map("blocks").unwrap();
  let mut bodies = Vec::new();
  let mut inline = Vec::new();
  let mut visible = Vec::new();
  for (_, value) in blocks.iter(&txn) {
    let yrs::Out::YMap(block) = value else {
      continue;
    };
    let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
      continue;
    };
    if matches!(block.get(&txn, "sys:flavour"), Some(yrs::Out::Any(Any::String(value))) if resolve_flavour(&value) == "myoxus:annotation")
    {
      bodies.push(text.get_string(&txn));
    } else {
      for diff in text.diff(&txn, yrs::types::text::YChange::identity) {
        let yrs::Out::Any(Any::String(value)) = diff.insert else {
          continue;
        };
        if crate::annotation::annotation_id(diff.attributes.as_deref()).is_some() {
          assert_eq!(
            diff.attributes.as_ref().unwrap().len(),
            1,
            "literal bodies have no executable Markdown marks"
          );
          inline.push(value.to_string());
        } else {
          visible.push(value.to_string());
        }
      }
    }
  }
  bodies.sort();
  assert_eq!(bodies, ["", "block\nbody", "padded"]);
  assert_eq!(inline, ["**literal** [[Note]] ✓\n\nsecond"]);
  let visible = visible.join("");
  assert!(visible.contains("Before "));
  assert!(visible.contains(" after"));
  assert!(visible.contains("%%code%%"));
}

fn insert_page_with_note(txn: &mut yrs::TransactionMut<'_>, blocks: &yrs::MapRef, child_ids: &[&str]) {
  let page = blocks.insert(txn, "page", yrs::MapPrelim::default());
  page.insert(txn, "sys:flavour", "myoxus:page");
  page.insert(txn, "prop:title", yrs::TextPrelim::new("Fixture"));
  let page_children = page.insert(txn, "sys:children", yrs::ArrayPrelim::default());
  page_children.push_back(txn, "note");

  let note = blocks.insert(txn, "note", yrs::MapPrelim::default());
  note.insert(txn, "sys:flavour", "myoxus:note");
  let note_children = note.insert(txn, "sys:children", yrs::ArrayPrelim::default());
  for child_id in child_ids {
    note_children.push_back(txn, *child_id);
  }
}

fn native_list_fidelity_update() -> Vec<u8> {
  let doc = Doc::with_client_id(1);
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();
  insert_page_with_note(
    &mut txn,
    &blocks,
    &[
      "bullet-absent",
      "bullet-true",
      "numbered-absent",
      "numbered-true",
      "todo-open",
      "todo-done",
    ],
  );
  for (id, list_type, text, checked) in [
    ("bullet-absent", "bulleted", "Bullet absent", None),
    ("bullet-false", "bulleted", "Bullet false", Some(false)),
    ("bullet-true", "bulleted", "Bullet true", Some(true)),
    ("numbered-absent", "numbered", "Numbered absent", None),
    ("numbered-false", "numbered", "Numbered false", Some(false)),
    ("numbered-true", "numbered", "Numbered true", Some(true)),
    ("todo-open", "todo", "Open", Some(false)),
    ("todo-nested", "todo", "Nested done", Some(true)),
    ("todo-done", "todo", "Done", Some(true)),
  ] {
    let list = blocks.insert(&mut txn, id, yrs::MapPrelim::default());
    list.insert(&mut txn, "sys:flavour", "myoxus:list");
    let children = list.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
    match id {
      "bullet-absent" => {
        children.push_back(&mut txn, "bullet-false");
      }
      "numbered-absent" => {
        children.push_back(&mut txn, "numbered-false");
      }
      "todo-open" => {
        children.push_back(&mut txn, "todo-nested");
      }
      _ => {}
    }
    list.insert(&mut txn, "prop:type", list_type);
    list.insert(&mut txn, "prop:text", yrs::TextPrelim::new(text));
    if let Some(checked) = checked {
      list.insert(&mut txn, "prop:checked", checked);
    }
  }
  txn.encode_state_as_update_v1(&StateVector::default())
}

const COMPLEX_MARKDOWN_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../../../build/fixtures/seed-documents/complex/03-operations-runbook-fixture.md"
));
const LINE_BREAK_ROUNDTRIP_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../../../build/fixtures/markdown/roundtrip-line-breaks.md"
));
/// YJS-RV-02c: extract_text_from_yjs must not panic on empty/malformed input.
#[test]
fn inv_yjs_rv02_extract_empty_doc_no_panic() {
  // Empty update
  let result = extract_text_from_yjs(&[0, 0]);
  assert!(result.is_ok());
}
/// YJS-RV-03b: Multiple extractions of the same payload produce identical Markdown.
#[test]
fn inv_yjs_rv03_extract_deterministic() {
  // Use a simple text doc — the extract function parses blocks from the binary
  let doc = Doc::new();
  let text = doc.get_or_insert_text("content");
  let update = {
    let mut tx = doc.transact_mut();
    text.insert(&mut tx, 0, "Deterministic content test");
    tx.encode_update_v1()
  };

  let r1 = extract_text_from_yjs(&update).unwrap();
  let r2 = extract_text_from_yjs(&update).unwrap();
  assert_eq!(r1.markdown, r2.markdown, "extraction must be deterministic");
  assert_eq!(r1.title, r2.title, "title must be deterministic");
}
#[test]
fn markdown_export_uses_list_type_instead_of_shared_checked_property() {
  use base64::Engine as _;
  let update = native_list_fidelity_update();
  let checked_in = base64::engine::general_purpose::STANDARD
    .decode(
      include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../build/fixtures/seed-documents/complex/native-yjs-list-fidelity.b64"
      ))
      .trim(),
    )
    .expect("decode checked-in native Yjs fixture");
  assert_eq!(update, checked_in, "checked-in fixture must remain natively generated");

  let markdown = extract_text_from_yjs(&update)
    .expect("export client-shaped list blocks")
    .markdown;

  assert_eq!(
    markdown.trim(),
    concat!(
      "- Bullet absent\n",
      "  - Bullet false\n",
      "- Bullet true\n",
      "1. Numbered absent\n",
      "   1. Numbered false\n",
      "1. Numbered true\n",
      "- [ ] Open\n",
      "  - [x] Nested done\n",
      "- [x] Done",
    )
  );
}

/// Export: YText with bold/italic attributes produces correct markdown.
#[test]
fn test_export_bold_italic() {
  use std::sync::Arc;

  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  let update = {
    let mut txn = doc.transact_mut();

    // Create a page block with a paragraph containing formatted text
    let page = blocks_map.insert(&mut txn, "page1", yrs::MapPrelim::default());
    page.insert(&mut txn, "flavour", "affine:page");
    let page_children = page.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    page_children.push_back(&mut txn, "para1");
    page.insert(&mut txn, "text", yrs::TextPrelim::new("Test"));

    let para = blocks_map.insert(&mut txn, "para1", yrs::MapPrelim::default());
    para.insert(&mut txn, "flavour", "affine:paragraph");
    para.insert(&mut txn, "children", yrs::ArrayPrelim::default());

    // Create text with attributes: "Hello " (plain) + "bold" (bold) + " and " (plain) + "italic" (italic)
    // Insert all text first, then apply formatting to ranges (yrs semantics)
    let text_ref = para.insert(&mut txn, "text", yrs::TextPrelim::new("Hello bold and italic"));
    let bold_attrs = Attrs::from([(Arc::from("bold"), yrs::Any::Bool(true))]);
    text_ref.format(&mut txn, 6, 4, bold_attrs); // "bold" at offset 6, len 4
    let italic_attrs = Attrs::from([(Arc::from("italic"), yrs::Any::Bool(true))]);
    text_ref.format(&mut txn, 15, 6, italic_attrs); // "italic" at offset 15, len 6

    txn.encode_update_v1()
  };

  let result = extract_text_from_yjs(&update).unwrap();
  assert!(result.markdown.contains("Hello "), "should contain plain text");
  assert!(
    result.markdown.contains("**bold**"),
    "should contain bold markdown: got '{}'",
    result.markdown
  );
  assert!(
    result.markdown.contains("*italic*"),
    "should contain italic markdown: got '{}'",
    result.markdown
  );
}
/// Export: YText with link attribute produces correct markdown.
#[test]
fn test_export_link() {
  use std::sync::Arc;

  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  let update = {
    let mut txn = doc.transact_mut();

    let page = blocks_map.insert(&mut txn, "page1", yrs::MapPrelim::default());
    page.insert(&mut txn, "flavour", "affine:page");
    let page_children = page.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    page_children.push_back(&mut txn, "para1");
    page.insert(&mut txn, "text", yrs::TextPrelim::new("Test"));

    let para = blocks_map.insert(&mut txn, "para1", yrs::MapPrelim::default());
    para.insert(&mut txn, "flavour", "affine:paragraph");
    para.insert(&mut txn, "children", yrs::ArrayPrelim::default());

    let text_ref = para.insert(&mut txn, "text", yrs::TextPrelim::new("Click here"));
    let link_attrs = Attrs::from([(Arc::from("link"), yrs::Any::String("https://example.com".into()))]);
    text_ref.format(&mut txn, 6, 4, link_attrs); // "here" at offset 6, len 4

    txn.encode_update_v1()
  };

  let result = extract_text_from_yjs(&update).unwrap();
  assert!(
    result.markdown.contains("[here](https://example.com)"),
    "should contain link: got '{}'",
    result.markdown
  );
}
/// Export: YText with inline code attribute produces backtick-wrapped markdown.
#[test]
fn test_export_inline_code() {
  use std::sync::Arc;

  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  let update = {
    let mut txn = doc.transact_mut();

    let page = blocks_map.insert(&mut txn, "page1", yrs::MapPrelim::default());
    page.insert(&mut txn, "flavour", "affine:page");
    let page_children = page.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    page_children.push_back(&mut txn, "para1");
    page.insert(&mut txn, "text", yrs::TextPrelim::new("Test"));

    let para = blocks_map.insert(&mut txn, "para1", yrs::MapPrelim::default());
    para.insert(&mut txn, "flavour", "affine:paragraph");
    para.insert(&mut txn, "children", yrs::ArrayPrelim::default());

    let text_ref = para.insert(&mut txn, "text", yrs::TextPrelim::new("Use println! function"));
    let code_attrs = Attrs::from([(Arc::from("code"), yrs::Any::Bool(true))]);
    text_ref.format(&mut txn, 4, 8, code_attrs); // "println!" at offset 4, len 8

    txn.encode_update_v1()
  };

  let result = extract_text_from_yjs(&update).unwrap();
  assert!(
    result.markdown.contains("`println!`"),
    "should contain code: got '{}'",
    result.markdown
  );
}
/// Import: bold and italic markdown creates YText with correct attributes.
#[test]
fn test_import_bold_italic() {
  use yrs::types::text::YChange;

  let md = "**bold** and *italic* text";
  let update = markdown_to_yjs("Test", md).unwrap();

  // Decode and find the paragraph block's text
  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&update).unwrap())
      .expect("apply yjs update");
  }

  let txn = doc.transact();
  // Find paragraph block
  let mut found_bold = false;
  let mut found_italic = false;
  for (_key, value) in blocks_map.iter(&txn) {
    if let yrs::Out::YMap(block) = value
      && let Some(yrs::Out::Any(yrs::Any::String(f))) = block.get(&txn, "sys:flavour")
      && f.as_ref() == "myoxus:paragraph"
      && let Some(yrs::Out::YText(text_ref)) = block.get(&txn, "prop:text")
    {
      let diffs: Vec<Diff<YChange>> = text_ref.diff(&txn, YChange::identity);
      for d in &diffs {
        if let yrs::Out::Any(yrs::Any::String(s)) = &d.insert
          && s.as_ref() == "bold"
          && let Some(attrs) = d.attributes.as_ref()
        {
          found_bold = attrs
            .iter()
            .any(|(k, v)| k.as_ref() == "bold" && *v == yrs::Any::Bool(true));
        }
        if let yrs::Out::Any(yrs::Any::String(s)) = &d.insert
          && s.as_ref() == "italic"
          && let Some(attrs) = d.attributes.as_ref()
        {
          found_italic = attrs
            .iter()
            .any(|(k, v)| k.as_ref() == "italic" && *v == yrs::Any::Bool(true));
        }
      }
    }
  }
  assert!(found_bold, "imported YText must have bold attribute on 'bold' segment");
  assert!(
    found_italic,
    "imported YText must have italic attribute on 'italic' segment"
  );
}
/// Import: bold/italic formatting with multi-byte Unicode characters.
///
/// This guards against the Yjs formatting length bug where UTF-8 byte offsets
/// were mixed with character counts.
#[test]
fn test_import_bold_italic_with_unicode_bytes() {
  let md = "# Dokument mit Unicode-Formatierung\n\n**Mächtige** *Typografie* — mit `Rust`-Text.";
  let update = markdown_to_yjs("Unicode Markdown", md).unwrap();

  let data = extract_text_from_yjs(&update).expect("roundtrip markdown extraction should work");
  assert!(
    data.markdown.contains("Mächtige"),
    "extracted markdown should keep unicode content"
  );
  assert!(
    data.markdown.contains("Typografie"),
    "extracted markdown should keep unicode content"
  );
  assert!(
    data.markdown.contains("`Rust`"),
    "inline code marker should be preserved"
  );
}
/// Import: inline code markdown creates YText with code attribute.
#[test]
fn test_import_inline_code() {
  use yrs::types::text::YChange;

  let md = "Use `println!` function";
  let update = markdown_to_yjs("Test", md).unwrap();

  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&update).unwrap())
      .expect("apply yjs update");
  }

  let txn = doc.transact();
  let mut found_code = false;
  for (_key, value) in blocks_map.iter(&txn) {
    if let yrs::Out::YMap(block) = value
      && let Some(yrs::Out::Any(yrs::Any::String(f))) = block.get(&txn, "sys:flavour")
      && f.as_ref() == "myoxus:paragraph"
      && let Some(yrs::Out::YText(text_ref)) = block.get(&txn, "prop:text")
    {
      let diffs: Vec<Diff<YChange>> = text_ref.diff(&txn, YChange::identity);
      for d in &diffs {
        if let yrs::Out::Any(yrs::Any::String(s)) = &d.insert
          && s.as_ref() == "println!"
          && let Some(attrs) = d.attributes.as_ref()
        {
          found_code = attrs
            .iter()
            .any(|(k, v)| k.as_ref() == "code" && *v == yrs::Any::Bool(true));
        }
      }
    }
  }
  assert!(
    found_code,
    "imported YText must have code attribute on 'println!' segment"
  );
}
#[test]
fn test_markdown_import_emits_canonical_block_keys() {
  let md = "# Title\n\nParagraph";
  let update = markdown_to_yjs("Title", md).unwrap();

  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&update).unwrap())
      .expect("apply yjs update");
  }

  let txn = doc.transact();
  for (key, value) in blocks_map.iter(&txn) {
    let block = match value {
      yrs::Out::YMap(block) => block,
      other => panic!("expected block map for key {key:?}, got {other:?}"),
    };

    match block.get(&txn, "sys:id") {
      Some(yrs::Out::Any(yrs::Any::String(id_value))) => {
        assert_eq!(id_value.to_string(), key.to_string(), "sys:id must match map key",);
      }
      other => panic!("missing sys:id on block {key:?}: {other:?}"),
    }

    assert!(
      matches!(block.get(&txn, "sys:flavour"), Some(yrs::Out::Any(yrs::Any::String(_)))),
      "missing sys:flavour on block {key:?}"
    );
    assert!(
      matches!(block.get(&txn, "sys:children"), Some(yrs::Out::YArray(_))),
      "missing sys:children on block {key:?}"
    );
    assert!(
      block.get(&txn, "flavour").is_none(),
      "legacy flavour key must not be emitted for block {key:?}"
    );
    assert!(
      block.get(&txn, "children").is_none(),
      "legacy children key must not be emitted for block {key:?}"
    );
  }
}
/// Roundtrip: import markdown with formatting, export back, verify output.
#[test]
fn test_roundtrip_formatting() {
  let md = "**bold** and *italic* text";
  let update = markdown_to_yjs("Roundtrip", md).unwrap();

  let result = extract_text_from_yjs(&update).unwrap();
  assert!(
    result.markdown.contains("**bold**"),
    "roundtrip must preserve bold: got '{}'",
    result.markdown
  );
  assert!(
    result.markdown.contains("*italic*"),
    "roundtrip must preserve italic: got '{}'",
    result.markdown
  );
  assert!(
    result.markdown.contains(" and "),
    "roundtrip must preserve plain text between formatting"
  );
  assert!(
    result.markdown.contains(" text"),
    "roundtrip must preserve trailing plain text"
  );
}

#[test]
fn obs08_highlights_roundtrip_as_native_background_without_reclassifying_literals_or_code() {
  use yrs::types::text::YChange;

  let markdown = concat!(
    "Plain ==marked== and ==**bold**==. Escaped \\==literal== and unmatched ==open.\n\n",
    "- ==list item==\n\n",
    "| Value |\n| --- |\n| ==table cell== |\n\n",
    "Asset data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==\n\n",
    "`==inline code==`\n\n",
    "```text\n==fenced code==\n```\n",
  );
  let update = markdown_to_yjs("Highlights", markdown).expect("import highlighted Markdown");

  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&update).expect("decode highlight update"))
      .expect("apply highlight update");
  }
  let txn = doc.transact();
  let mut highlighted = Vec::new();
  for (_, value) in blocks.iter(&txn) {
    let yrs::Out::YMap(block) = value else { continue };
    for (_, value) in block.iter(&txn) {
      let yrs::Out::YText(text) = value else { continue };
      for diff in text.diff(&txn, YChange::identity) {
        let yrs::Out::Any(yrs::Any::String(value)) = diff.insert else {
          continue;
        };
        if diff
          .attributes
          .as_ref()
          .and_then(|attributes| attributes.get("background"))
          == Some(&yrs::Any::String("var(--myoxus-text-highlight-yellow)".into()))
        {
          highlighted.push(value.to_string());
        }
      }
    }
  }
  assert!(highlighted.iter().any(|value| value == "marked"));
  assert!(highlighted.iter().any(|value| value == "bold"));
  assert!(highlighted.iter().any(|value| value == "list item"));
  assert!(highlighted.iter().any(|value| value == "table cell"));
  assert!(
    !highlighted
      .iter()
      .any(|value| value.contains("code") || value.contains("literal"))
  );

  let exported = extract_text_from_yjs(&update).expect("export highlighted Markdown");
  assert!(exported.markdown.contains("==marked=="));
  assert!(exported.markdown.contains("==**bold**=="));
  assert!(exported.markdown.contains("`==inline code==`"));
  assert!(exported.markdown.contains("==fenced code=="));
  assert!(exported.markdown.contains("\\=\\=literal\\=\\="));
  assert!(exported.markdown.contains("unmatched ==open"));
  assert!(
    exported
      .markdown
      .contains("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="),
    "unmatched Base64 padding must remain byte-identical"
  );
  assert!(
    exported
      .diagnostics
      .iter()
      .any(|diagnostic| diagnostic.code == MarkdownDiagnosticCode::NormalizedHighlight)
  );

  let reimported = markdown_to_yjs("Highlights", &exported.markdown).expect("re-import highlighted Markdown");
  let reexported = extract_text_from_yjs(&reimported).expect("re-export highlighted Markdown");
  assert_eq!(reexported.markdown, exported.markdown);
}

#[test]
fn obs08_editor_background_color_normalizes_to_markdown_highlight_presence() {
  let mut builder = YjsDocumentBuilder::new("Colored highlight");
  builder.push_paragraph(&[YjsTextSegment {
    text: "colored".to_string(),
    background: Some("var(--myoxus-text-highlight-blue)".to_string()),
    ..YjsTextSegment::default()
  }]);

  let exported = extract_text_from_yjs(&builder.encode()).expect("export colored highlight");
  assert_eq!(exported.markdown.trim(), "==colored==");
  assert_eq!(
    exported
      .diagnostics
      .iter()
      .filter(|diagnostic| diagnostic.code == MarkdownDiagnosticCode::NormalizedHighlight)
      .count(),
    1
  );
  assert!(
    !exported.extraction_partial,
    "normalization remains a complete projection"
  );
}
/// Roundtrip: strikethrough and links survive import→export.
#[test]
fn test_roundtrip_strike_and_link() {
  let md = "~~deleted~~ and [click](https://example.com)";
  let update = markdown_to_yjs("Test", md).unwrap();
  let result = extract_text_from_yjs(&update).unwrap();

  assert!(
    result.markdown.contains("~~deleted~~"),
    "roundtrip must preserve strikethrough: got '{}'",
    result.markdown
  );
  assert!(
    result.markdown.contains("[click](https://example.com)"),
    "roundtrip must preserve link: got '{}'",
    result.markdown
  );
}
/// Roundtrip: inline code survives import→export.
#[test]
fn test_roundtrip_inline_code() {
  let md = "Use `cargo test` command";
  let update = markdown_to_yjs("Test", md).unwrap();
  let result = extract_text_from_yjs(&update).unwrap();

  assert!(
    result.markdown.contains("`cargo test`"),
    "roundtrip must preserve inline code: got '{}'",
    result.markdown
  );
}
/// Import: blockquote content uses the native paragraph type.
#[test]
fn test_import_blockquote() {
  let md = "> This is a quote";
  let update = markdown_to_yjs("Test", md).unwrap();

  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&update).unwrap())
      .expect("apply yjs update");
  }

  let txn = doc.transact();
  let mut found_quote = false;
  for (_key, value) in blocks_map.iter(&txn) {
    if let yrs::Out::YMap(block) = value
      && let Some(yrs::Out::Any(yrs::Any::String(f))) = block.get(&txn, "sys:flavour")
      && f.as_ref() == "myoxus:paragraph"
      && let Some(yrs::Out::Any(yrs::Any::String(kind))) = block.get(&txn, "prop:type")
      && kind.as_ref() == "quote"
      && let Some(yrs::Out::YText(text_ref)) = block.get(&txn, "prop:text")
    {
      let text = text_ref.get_string(&txn);
      if text == "This is a quote" {
        found_quote = true;
      }
    }
  }
  assert!(found_quote, "blockquote content should be a native quote paragraph");
}

#[test]
fn safe_writer_preserves_literal_text_code_links_images_and_code_bytes() {
  let mut builder = YjsDocumentBuilder::new("Plain * # title");
  for literal in ["# heading", "> quote", "- item", "1. item", "---", r"\*literal"] {
    builder.push_paragraph(&[YjsTextSegment::plain(literal)]);
  }
  builder.push_paragraph(&[
    YjsTextSegment {
      text: "a`b".to_string(),
      code: true,
      ..YjsTextSegment::default()
    },
    YjsTextSegment::plain(" and "),
    YjsTextSegment {
      text: "label [x]\\".to_string(),
      link: Some("https://example.test/a (b)\\c%20d".to_string()),
      ..YjsTextSegment::default()
    },
  ]);
  builder.push_paragraph(&[YjsTextSegment {
    text: "legacy inline image syntax".to_string(),
    image_source: Some("data:image/png;base64,a b(c)".to_string()),
    image_caption: Some("caption [x]\\".to_string()),
    ..YjsTextSegment::default()
  }]);
  let code = "alpha  \n``` embedded\nomega\n\n";
  builder.push_code("text", code);
  let update = builder.encode();

  let exported = extract_text_from_yjs(&update).expect("export native literals");
  assert_eq!(exported.title.as_deref(), Some("Plain * # title"));
  for literal in [
    r"\# heading",
    r"\> quote",
    r"\- item",
    r"1\. item",
    r"\---",
    r"\\\*literal",
  ] {
    assert!(
      exported.markdown.lines().any(|line| line == literal),
      "missing {literal:?}"
    );
  }
  assert!(exported.markdown.contains("``a`b``"));
  assert!(
    exported
      .markdown
      .contains("[label \\[x\\]\\\\](https://example.test/a%20%28b%29%5Cc%20d)")
  );
  assert!(
    exported
      .markdown
      .contains("![caption \\[x\\]\\\\](data:image/png;base64,a%20b%28c%29)")
  );
  assert!(
    exported
      .markdown
      .contains("````text\nalpha  \n``` embedded\nomega\n\n\n````"),
    "{}",
    exported.markdown
  );

  let reimported = markdown_to_yjs("Plain * # title", &exported.markdown).expect("reimport safe Markdown");
  let second = extract_text_from_yjs(&reimported).expect("re-export safe Markdown");
  assert_eq!(second.markdown, exported.markdown);

  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&reimported).expect("decode reimport"))
      .expect("apply reimport");
  }
  let txn = doc.transact();
  let imported_code = blocks.iter(&txn).find_map(|(_, value)| {
    let yrs::Out::YMap(block) = value else { return None };
    let is_code = matches!(
      block.get(&txn, "sys:flavour"),
      Some(yrs::Out::Any(yrs::Any::String(ref flavour))) if flavour.as_ref() == "myoxus:code"
    );
    is_code
      .then(|| block.get(&txn, "prop:text"))
      .flatten()
      .and_then(|value| match value {
        yrs::Out::YText(text) => Some(text.get_string(&txn)),
        _ => None,
      })
  });
  assert_eq!(imported_code.as_deref(), Some(code));
}

#[test]
fn bpmn_exports_only_a_safe_titled_placeholder_with_loss_diagnostics() {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let update = {
    let mut txn = doc.transact_mut();
    insert_page_with_note(&mut txn, &blocks, &["bpmn", "untitled"]);
    for (id, title) in [("bpmn", "Approve <script>alert(1)</script>"), ("untitled", "")] {
      let block = blocks.insert(&mut txn, id, yrs::MapPrelim::default());
      block.insert(&mut txn, "sys:flavour", "myoxus:bpmn");
      block.insert(&mut txn, "prop:title", yrs::TextPrelim::new(title));
      let heads = block.insert(&mut txn, "prop:sourceHeads", yrs::MapPrelim::default());
      heads.insert(&mut txn, "head", "<definitions>private-process-source</definitions>");
      block.insert(&mut txn, "prop:preview", "<svg onload='private-preview-code()'/>");
    }
    txn.encode_state_as_update_v1(&StateVector::default())
  };
  let exported = extract_text_from_yjs(&update).unwrap();
  assert!(
    exported
      .markdown
      .contains(r"> BPMN: Approve \<script>alert(1)\</script>")
  );
  assert!(exported.markdown.contains("> BPMN: BPMN Diagram"));
  for hidden in ["private-process-source", "private-preview-code", "<svg"] {
    assert!(!exported.markdown.contains(hidden));
  }
  assert!(exported.extraction_partial);
  assert_eq!(
    exported
      .diagnostics
      .iter()
      .filter(|d| d.code == MarkdownDiagnosticCode::UnsupportedNativeContent)
      .count(),
    2
  );
}

#[test]
fn native_mermaid_exports_source_and_reports_nonportable_metadata() {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let source = "graph TD  \n  A --> B\n``` embedded\n\n";
  let update = {
    let mut txn = doc.transact_mut();
    insert_page_with_note(&mut txn, &blocks, &["diagram", "missing"]);
    let diagram = blocks.insert(&mut txn, "diagram", yrs::MapPrelim::default());
    diagram.insert(&mut txn, "sys:flavour", "myoxus:mermaid");
    diagram.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
    diagram.insert(&mut txn, "prop:source", yrs::TextPrelim::new(source));
    diagram.insert(&mut txn, "prop:title", yrs::TextPrelim::new("Authored title"));
    diagram.insert(&mut txn, "prop:caption", "Authored caption");
    let missing = blocks.insert(&mut txn, "missing", yrs::MapPrelim::default());
    missing.insert(&mut txn, "sys:flavour", "myoxus:mermaid");
    missing.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
    txn.encode_state_as_update_v1(&StateVector::default())
  };

  let exported = extract_text_from_yjs(&update).expect("export native Mermaid");
  assert!(
    exported
      .markdown
      .contains("````mermaid\ngraph TD  \n  A --> B\n``` embedded\n\n\n````")
  );
  assert!(exported.extraction_partial);
  assert_eq!(
    exported
      .diagnostics
      .iter()
      .map(|diagnostic| diagnostic.code)
      .collect::<Vec<_>>(),
    vec![
      MarkdownDiagnosticCode::OmittedNativeMetadata,
      MarkdownDiagnosticCode::MissingNativeSource,
    ]
  );

  let reimported = markdown_to_yjs("Mermaid", &exported.markdown).expect("reimport Mermaid fence");
  let reexported = extract_text_from_yjs(&reimported).expect("re-export Mermaid code block");
  assert_eq!(reexported.markdown, exported.markdown);
}

#[test]
fn obs10_mermaid_fences_import_as_native_source_without_interpreting_diagrams_or_metadata() {
  let source = concat!(
    "---\n",
    "title: Imported topology\n",
    "---\n",
    "not-a-supported-mermaid-diagram  \n",
    "  raw --> source",
  );
  let markdown = format!(
    "```mermaid\n{source}\n```\n\n```rust\nfn ordinary() {{}}\n```\n\n- nested\n\n  ```mermaid\n  flowchart TD\n    A --> B\n  ```\n"
  );
  let update = markdown_to_yjs("Native Mermaid", &markdown).expect("import Mermaid fences");

  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&update).expect("decode Mermaid update"))
      .expect("apply Mermaid update");
  }
  let txn = doc.transact();
  let mut mermaid_sources = Vec::new();
  let mut ordinary_code = Vec::new();
  let mut surface_count = 0;
  for (_, value) in blocks.iter(&txn) {
    let yrs::Out::YMap(block) = value else { continue };
    let flavour = block.get(&txn, "sys:flavour").and_then(|value| match value {
      yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
      _ => None,
    });
    match flavour.as_deref() {
      Some("myoxus:mermaid") => {
        let source = block
          .get(&txn, "prop:source")
          .and_then(|value| match value {
            yrs::Out::YText(text) => Some(text.get_string(&txn)),
            _ => None,
          })
          .expect("native Mermaid source");
        let title = block
          .get(&txn, "prop:title")
          .and_then(|value| match value {
            yrs::Out::YText(text) => Some(text.get_string(&txn)),
            _ => None,
          })
          .expect("native Mermaid title text");
        assert!(
          title.is_empty(),
          "source-owned title must not become native-only metadata"
        );
        assert!(block.get(&txn, "prop:caption").is_none());
        mermaid_sources.push(source);
      }
      Some("myoxus:code") => {
        let language = block.get(&txn, "prop:language").and_then(|value| match value {
          yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
          _ => None,
        });
        ordinary_code.push(language.unwrap_or_default());
      }
      Some("myoxus:surface") => {
        let elements = block.get(&txn, "prop:elements").expect("surface elements");
        assert!(matches!(elements, yrs::Out::YMap(_)));
        surface_count += 1;
      }
      _ => {}
    }
  }
  mermaid_sources.sort();
  assert_eq!(mermaid_sources.len(), 2);
  assert!(mermaid_sources.iter().any(|candidate| candidate == source));
  assert!(
    mermaid_sources
      .iter()
      .any(|candidate| candidate == "flowchart TD\n  A --> B")
  );
  assert_eq!(ordinary_code, vec!["rust"]);
  assert_eq!(surface_count, 1, "native Mermaid needs the canonical page surface");

  let exported = extract_text_from_yjs(&update).expect("export native Mermaid fences");
  assert!(exported.markdown.contains(source));
  assert!(exported.markdown.contains("```rust\nfn ordinary() {}\n```"));
  assert!(!exported.extraction_partial);
  assert!(exported.diagnostics.is_empty());
  let reimported = markdown_to_yjs("Native Mermaid", &exported.markdown).expect("re-import native Mermaid fences");
  let reexported = extract_text_from_yjs(&reimported).expect("re-export native Mermaid fences");
  assert_eq!(reexported.markdown, exported.markdown);
}

#[test]
fn projection_reports_unknown_content_and_missing_children_even_with_empty_output() {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let update = {
    let mut txn = doc.transact_mut();
    insert_page_with_note(&mut txn, &blocks, &["unknown", "missing"]);
    let unknown = blocks.insert(&mut txn, "unknown", yrs::MapPrelim::default());
    unknown.insert(&mut txn, "sys:flavour", "myoxus:not-portable");
    unknown.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
    txn.encode_state_as_update_v1(&StateVector::default())
  };

  let exported = extract_text_from_yjs(&update).expect("project incomplete tree");
  assert!(exported.markdown.is_empty());
  assert!(exported.extraction_partial);
  assert_eq!(
    exported
      .diagnostics
      .iter()
      .map(|diagnostic| diagnostic.code)
      .collect::<Vec<_>>(),
    vec![
      MarkdownDiagnosticCode::UnsupportedNativeContent,
      MarkdownDiagnosticCode::MissingChildBlock,
    ]
  );
}

#[test]
fn container_import_preserves_native_tree_order_numbers_and_breaks() {
  let markdown = concat!(
    "7. first  \n",
    r#"   hard break

   continuation

   - nested

   > quoted

   ```text
   code child
   ```

   | cell |
   | --- |
   | one<br />two |

8. second
9. third
10. tenth
"#,
    "\n- [ ]  \n",
    r#"
> outer
>
> > inner
"#,
  );
  let update = markdown_to_yjs("Containers", markdown).expect("import structured containers");
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&update).expect("decode update"))
      .expect("apply update");
  }
  let txn = doc.transact();

  let mut note_children = Vec::new();
  let mut first_list_id = None;
  let mut first_list_children = Vec::new();
  let mut numbered_orders = Vec::new();
  let mut saw_empty_task = false;
  let mut saw_multiline_cell = false;
  let mut saw_nested_quote = false;
  for (id, value) in blocks.iter(&txn) {
    let yrs::Out::YMap(block) = value else { continue };
    let flavour = block
      .get(&txn, "sys:flavour")
      .and_then(|value| match value {
        yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
        _ => None,
      })
      .unwrap_or_default();
    let children = block
      .get(&txn, "sys:children")
      .and_then(|value| match value {
        yrs::Out::YArray(children) => Some(
          children
            .iter(&txn)
            .filter_map(|value| match value {
              yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
              _ => None,
            })
            .collect::<Vec<_>>(),
        ),
        _ => None,
      })
      .unwrap_or_default();
    if flavour == "myoxus:note" {
      note_children = children.clone();
    }
    let kind = block.get(&txn, "prop:type").and_then(|value| match value {
      yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
      _ => None,
    });
    if flavour == "myoxus:list" && kind.as_deref() == Some("numbered") {
      let order = block.get(&txn, "prop:order").and_then(|value| match value {
        yrs::Out::Any(yrs::Any::BigInt(value)) => Some(value),
        yrs::Out::Any(yrs::Any::Number(value)) => value.as_f64().map(|value| value as i64),
        _ => None,
      });
      numbered_orders.push(order);
      if order == Some(7) {
        first_list_id = Some(id.to_string());
        first_list_children = children.clone();
        let text = block
          .get(&txn, "prop:text")
          .and_then(|value| match value {
            yrs::Out::YText(text) => Some(text.get_string(&txn)),
            _ => None,
          })
          .unwrap_or_default();
        assert_eq!(text, "first\nhard break");
      }
    }
    if flavour == "myoxus:list" && kind.as_deref() == Some("todo") {
      let text = block
        .get(&txn, "prop:text")
        .and_then(|value| match value {
          yrs::Out::YText(text) => Some(text.get_string(&txn)),
          _ => None,
        })
        .unwrap_or_default();
      saw_empty_task |= text.is_empty();
    }
    saw_multiline_cell |= block.iter(&txn).any(|(key, value)| {
      key.starts_with("prop:cells.")
        && matches!(value, yrs::Out::YText(ref text) if text.get_string(&txn) == "one\ntwo")
    });
    saw_nested_quote |= kind.as_deref() == Some("quote") && !children.is_empty();
  }

  let first_list_id = first_list_id.expect("numbered list starting at seven");
  assert!(note_children.contains(&first_list_id));
  numbered_orders.sort();
  assert_eq!(numbered_orders, vec![Some(7), Some(8), Some(9), Some(10)]);
  assert_eq!(
    first_list_children.len(),
    5,
    "continuation, nested list, quote, code, table stay ordered children"
  );
  let child_contracts = first_list_children
    .iter()
    .map(|child_id| {
      let child = blocks
        .get(&txn, child_id)
        .and_then(|value| match value {
          yrs::Out::YMap(block) => Some(block),
          _ => None,
        })
        .expect("list child block");
      let flavour = child
        .get(&txn, "sys:flavour")
        .and_then(|value| match value {
          yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
          _ => None,
        })
        .expect("child flavour");
      let kind = child.get(&txn, "prop:type").and_then(|value| match value {
        yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
        _ => None,
      });
      (flavour, kind)
    })
    .collect::<Vec<_>>();
  assert_eq!(
    child_contracts,
    vec![
      ("myoxus:paragraph".to_string(), None),
      ("myoxus:list".to_string(), Some("bulleted".to_string())),
      ("myoxus:paragraph".to_string(), Some("quote".to_string())),
      ("myoxus:code".to_string(), None),
      ("myoxus:table".to_string(), None),
    ]
  );
  assert!(saw_empty_task);
  assert!(saw_multiline_cell);
  assert!(saw_nested_quote);

  let exported = extract_text_from_yjs(&update).expect("export structured containers");
  assert!(exported.markdown.contains("7. first\\\n   hard break"));
  assert!(exported.markdown.contains("10. tenth"));
  assert!(
    exported.markdown.contains("> outer\n>\n> > inner"),
    "{}",
    exported.markdown
  );
  assert!(exported.markdown.contains("one<br />two"));
}
/// Step 2: Roundtrip — import comprehensive fixture, export, verify all elements.
#[test]
fn test_comprehensive_roundtrip() {
  let update = markdown_to_yjs("Operations Runbook Fixture", COMPLEX_MARKDOWN_FIXTURE).unwrap();
  let result = extract_text_from_yjs(&update).unwrap();
  let md = &result.markdown;

  // Title
  assert_eq!(
    result.title.as_deref(),
    Some("Operations Runbook Fixture"),
    "title must come from the import contract, got: {:?}",
    result.title
  );

  // Inline formatting
  assert!(md.contains("**bold evidence**"), "must contain bold text, got:\n{md}");
  assert!(md.contains("*italic context*"), "must contain italic text, got:\n{md}");
  assert!(
    md.contains("~~obsolete guidance~~"),
    "must contain struck text, got:\n{md}"
  );
  assert!(
    md.contains("[runbook link](https://example.test/runbook)"),
    "must contain link, got:\n{md}"
  );
  assert!(md.contains("`literal_code()`"), "must contain inline code, got:\n{md}");

  // Headings
  assert!(
    md.contains("## Scope"),
    "must contain the second-level heading, got:\n{md}"
  );
  assert!(
    md.contains("### Incident Overview"),
    "must contain the third-level heading, got:\n{md}"
  );

  // Lists
  assert!(
    md.contains("- Remove accidental local CSS"),
    "must contain a normal bullet, got:\n{md}"
  );
  assert!(
    md.contains("1. Create a narrow patch"),
    "must contain an ordered item, got:\n{md}"
  );

  // Native quote paragraph
  assert!(md.contains("> "), "must contain blockquote marker '> ', got:\n{md}");
  assert!(
    md.contains("Keep the incident channel factual"),
    "must contain blockquote text, got:\n{md}"
  );

  // Code block
  assert!(md.contains("```bash"), "must contain the shell fence, got:\n{md}");
  assert!(md.contains("```mermaid"), "must contain the Mermaid fence, got:\n{md}");
  assert!(md.contains("| :--- | :---: | ---: | --- |"));
  assert!(md.contains("| Plain |  | **bold** and `code` |"));
  assert!(md.contains("data:image/svg+xml"));
  assert!(md.contains("data:image/png;base64"));
}
/// Step 3a: Empty markdown roundtrip.
#[test]
fn test_empty_markdown_roundtrip() {
  let update = markdown_to_yjs("", "").unwrap();
  let result = extract_text_from_yjs(&update).unwrap();
  // Empty content should produce empty or whitespace-only markdown
  assert!(
    result.markdown.trim().is_empty(),
    "empty markdown roundtrip should produce empty output, got: '{}'",
    result.markdown
  );
}
/// Step 3b: Unicode roundtrip.
#[test]
fn test_unicode_roundtrip() {
  let md = "# Überschrift\n\nText mit Ä, ö, ü, ß und 中文";
  let update = markdown_to_yjs("Überschrift", md).unwrap();
  let result = extract_text_from_yjs(&update).unwrap();

  assert!(
    result.markdown.contains("Überschrift"),
    "must contain Überschrift, got:\n{}",
    result.markdown
  );
  assert!(
    result.markdown.contains("Ä"),
    "must contain Ä, got:\n{}",
    result.markdown
  );
  assert!(
    result.markdown.contains("ö"),
    "must contain ö, got:\n{}",
    result.markdown
  );
  assert!(
    result.markdown.contains("ü"),
    "must contain ü, got:\n{}",
    result.markdown
  );
  assert!(
    result.markdown.contains("ß"),
    "must contain ß, got:\n{}",
    result.markdown
  );
  assert!(
    result.markdown.contains("中文"),
    "must contain 中文, got:\n{}",
    result.markdown
  );
}
/// Step 3c: Large document roundtrip.
#[test]
fn test_large_doc_roundtrip() {
  let mut large_md = String::new();
  for i in 0..1000 {
    large_md.push_str(&format!("Line {} with some content for testing.\n\n", i));
  }
  let update = markdown_to_yjs("Large Doc", &large_md).unwrap();
  let result = extract_text_from_yjs(&update).unwrap();

  // Verify reasonable content preservation — at least 50% of lines should survive
  let output_lines: Vec<&str> = result.markdown.lines().filter(|l| !l.is_empty()).collect();
  assert!(
    output_lines.len() >= 500,
    "large doc should preserve most lines: got {} non-empty lines from 1000 input paragraphs",
    output_lines.len()
  );

  // Verify specific content present
  assert!(result.markdown.contains("Line 0"), "must contain first line");
  assert!(result.markdown.contains("Line 999"), "must contain last line");
  assert!(result.markdown.contains("Line 500"), "must contain middle line");
}
/// Step 4a: Import preserves all heading levels h1-h6 as canonical
/// paragraph blocks. Virgultum no longer has an active `myoxus:heading`
/// block schema, so the importer must not emit that legacy flavour.
#[test]
fn test_import_preserves_heading_levels() {
  let md = "# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6";
  let update = markdown_to_yjs("H1", md).unwrap();

  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&update).unwrap())
      .expect("apply yjs update");
  }

  let txn = doc.transact();
  let mut heading_levels: Vec<String> = Vec::new();
  let mut legacy_heading_count = 0;

  for (_key, value) in blocks_map.iter(&txn) {
    if let yrs::Out::YMap(block) = value
      && let Some(yrs::Out::Any(yrs::Any::String(f))) = block.get(&txn, "sys:flavour")
    {
      if f.as_ref() == "myoxus:heading" {
        legacy_heading_count += 1;
        continue;
      }
      if f.as_ref() == "myoxus:paragraph"
        && let Some(yrs::Out::Any(yrs::Any::String(t))) = block.get(&txn, "prop:type")
        && t.as_ref().starts_with("h")
      {
        heading_levels.push(t.to_string());
      }
    }
  }

  heading_levels.sort();
  assert_eq!(
    legacy_heading_count, 0,
    "markdown import must not emit legacy myoxus:heading blocks"
  );
  assert_eq!(
    heading_levels,
    vec!["h1", "h2", "h3", "h4", "h5", "h6"],
    "all 6 heading levels must be present, got: {:?}",
    heading_levels
  );
}
/// Step 4b: Import mixed bullet/numbered lists.
#[test]
fn test_import_mixed_lists() {
  let md = "- Bullet A\n- Bullet B\n\n1. Number 1\n2. Number 2\n\n- Bullet C";
  let update = markdown_to_yjs("Lists", md).unwrap();

  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&update).unwrap())
      .expect("apply yjs update");
  }

  let txn = doc.transact();
  let mut bulleted_count = 0;
  let mut numbered_count = 0;
  let mut unchecked_non_todo_count = 0;

  for (_key, value) in blocks_map.iter(&txn) {
    if let yrs::Out::YMap(block) = value
      && let Some(yrs::Out::Any(yrs::Any::String(f))) = block.get(&txn, "sys:flavour")
      && f.as_ref() == "myoxus:list"
      && let Some(yrs::Out::Any(yrs::Any::String(t))) = block.get(&txn, "prop:type")
    {
      match t.as_ref() {
        "bulleted" => {
          bulleted_count += 1;
          unchecked_non_todo_count += usize::from(matches!(
            block.get(&txn, "prop:checked"),
            Some(yrs::Out::Any(yrs::Any::Bool(false)))
          ));
        }
        "numbered" => {
          numbered_count += 1;
          unchecked_non_todo_count += usize::from(matches!(
            block.get(&txn, "prop:checked"),
            Some(yrs::Out::Any(yrs::Any::Bool(false)))
          ));
        }
        _ => {}
      }
    }
  }

  assert_eq!(bulleted_count, 3, "should have 3 bulleted items, got {bulleted_count}");
  assert_eq!(numbered_count, 2, "should have 2 numbered items, got {numbered_count}");
  assert_eq!(
    unchecked_non_todo_count, 5,
    "server imports must persist the same checked=false default as client list blocks"
  );
}
/// Step 5a: Export adjacent formatting — `**bold***italic*` (no space between).
#[test]
fn test_export_adjacent_formatting() {
  let md = "**bold***italic*";
  let update = markdown_to_yjs("Test", md).unwrap();
  let result = extract_text_from_yjs(&update).unwrap();

  assert!(
    result.markdown.contains("**bold**"),
    "must contain **bold**, got:\n{}",
    result.markdown
  );
  assert!(
    result.markdown.contains("*italic*"),
    "must contain *italic*, got:\n{}",
    result.markdown
  );
}
/// Step 5b: Export nested formatting — `***bold-italic***` (both at once).
#[test]
fn test_export_nested_formatting() {
  let md = "***bold-italic***";
  let update = markdown_to_yjs("Test", md).unwrap();
  let result = extract_text_from_yjs(&update).unwrap();

  // The text "bold-italic" should have both bold and italic markers
  // The exact wrapping order may vary (**..** outside *..* or vice versa)
  assert!(
    result.markdown.contains("bold-italic"),
    "must contain the text 'bold-italic', got:\n{}",
    result.markdown
  );
  // Check that both formatting markers are present around the text
  let has_bold = result.markdown.contains("**");
  let has_italic = result.markdown.contains("*");
  assert!(has_bold, "must contain bold markers **, got:\n{}", result.markdown);
  assert!(has_italic, "must contain italic markers *, got:\n{}", result.markdown);
}
/// Import: GFM table writes the active Virgultum flat-data table shape.
#[test]
fn test_import_table_as_flat_myoxus_table() {
  let md = "| **Name** | Score |\n|------|------|\n| Ada | `42` |\n| Bob |  |\n";
  let update = markdown_to_yjs("Test", md).unwrap();
  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&update).unwrap())
      .expect("apply yjs update");
  }

  let txn = doc.transact();
  let mut table_count = 0;
  let mut table_row_count = 0;
  let mut table_column_count = 0;
  let mut table_cell_count = 0;
  let mut paragraph_pipe_rows = 0;

  for (_key, value) in blocks_map.iter(&txn) {
    let yrs::Out::YMap(block) = value else {
      continue;
    };
    let flavour = match block.get(&txn, "sys:flavour") {
      Some(yrs::Out::Any(yrs::Any::String(value))) => value.to_string(),
      _ => continue,
    };

    assert!(
      !flavour.starts_with("affine:"),
      "markdown import must not emit legacy affine:* flavours, got {flavour}"
    );

    if flavour == "myoxus:paragraph"
      && let Some(yrs::Out::YText(text_ref)) = block.get(&txn, "prop:text")
    {
      let text = text_ref.get_string(&txn);
      if text.contains('|') {
        paragraph_pipe_rows += 1;
      }
    }

    if flavour == "myoxus:table" {
      table_count += 1;
      for (axis, prefix, count) in [("rows", "row", 3), ("columns", "col", 2)] {
        for index in 0..count {
          let key = format!("prop:{axis}.{prefix}-{index:04}.order");
          let order = block.get(&txn, &key).expect("table axis order").to_string(&txn);
          assert_eq!(
            order,
            format!("a0{index:08}1"),
            "table orders must support editor insertion"
          );
        }
      }
      for (key, value) in block.iter(&txn) {
        if key.starts_with("prop:rows.") && key.ends_with(".rowId") {
          table_row_count += 1;
        }
        if key.starts_with("prop:columns.") && key.ends_with(".columnId") {
          table_column_count += 1;
        }
        if key.starts_with("prop:cells.") && key.ends_with(".text") {
          table_cell_count += 1;
          assert!(
            matches!(value, yrs::Out::YText(_)),
            "table cell {key} must be stored as Y.Text, got {value:?}"
          );
        }
      }

      let header = block
        .get(&txn, "prop:cells.row-0000:col-0000.text")
        .and_then(|value| match value {
          yrs::Out::YText(text_ref) => Some(extract_formatted_text(&text_ref, &txn)),
          _ => None,
        })
        .expect("header cell must exist");
      let score = block
        .get(&txn, "prop:cells.row-0001:col-0001.text")
        .and_then(|value| match value {
          yrs::Out::YText(text_ref) => Some(extract_formatted_text(&text_ref, &txn)),
          _ => None,
        })
        .expect("formatted score cell must exist");
      let empty_cell = block
        .get(&txn, "prop:cells.row-0002:col-0001.text")
        .and_then(|value| match value {
          yrs::Out::YText(text_ref) => Some(text_ref.get_string(&txn)),
          _ => None,
        })
        .expect("ragged/empty cell must exist");

      assert_eq!(header, "**Name**", "table cell formatting must survive");
      assert_eq!(score, "`42`", "inline code in table cell must survive");
      assert_eq!(empty_cell, "", "empty table cells must be stored explicitly");
    }
  }

  assert_eq!(table_count, 1, "expected exactly one myoxus:table block");
  assert_eq!(table_row_count, 3, "header plus two body rows must be stored");
  assert_eq!(table_column_count, 2, "two columns must be stored");
  assert_eq!(table_cell_count, 6, "all row/column intersections must be stored");
  assert_eq!(
    paragraph_pipe_rows, 0,
    "markdown import must not emit table rows as pipe-separated paragraph text"
  );

  let result = extract_text_from_yjs(&update).unwrap();
  assert!(
    result.markdown.contains("| **Name** | Score |"),
    "flat table must extract as a Markdown table, got:\n{}",
    result.markdown
  );
  assert!(
    result.markdown.contains("| Ada | `42` |"),
    "table body row must extract from flat table cells, got:\n{}",
    result.markdown
  );
}
#[test]
fn test_table_column_alignment_semantic_roundtrip() {
  let markdown = concat!(
    "| **Left** | Center | Right | Legacy |\n",
    "| :--- | :---: | ---: | --- |\n",
    "| [link](https://example.com) |  | `code` | literal \\| pipe |\n",
  );
  let update = markdown_to_yjs("Aligned table", markdown).expect("import aligned table");

  let assert_persisted_alignment = |update: &[u8]| {
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    {
      let mut txn = doc.transact_mut();
      txn
        .apply_update(Update::decode_v1(update).expect("decode table update"))
        .expect("apply table update");
    }
    let txn = doc.transact();
    let table = blocks
      .iter(&txn)
      .find_map(|(_, value)| match value {
        yrs::Out::YMap(block)
          if matches!(
            block.get(&txn, "sys:flavour"),
            Some(yrs::Out::Any(yrs::Any::String(value))) if value.as_ref() == "myoxus:table"
          ) =>
        {
          Some(block)
        }
        _ => None,
      })
      .expect("flat table block");

    for (column, expected) in [
      ("col-0000", Some("left")),
      ("col-0001", Some("center")),
      ("col-0002", Some("right")),
      ("col-0003", None),
    ] {
      let actual = table
        .get(&txn, &format!("prop:columns.{column}.textAlign"))
        .and_then(|value| match value {
          yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
          _ => None,
        });
      assert_eq!(actual.as_deref(), expected, "alignment for {column}");
    }
  };

  assert_persisted_alignment(&update);
  let exported = extract_text_from_yjs(&update).expect("export aligned table").markdown;
  assert!(
    exported.contains("| :--- | :---: | ---: | --- |"),
    "export must preserve every separator alignment, got:\n{exported}"
  );
  assert!(
    exported.contains("| [link](https://example.com) |  | `code` | literal \\| pipe |"),
    "empty and rich cells must keep their semantics, got:\n{exported}"
  );

  let reimported = markdown_to_yjs("Aligned table", &exported).expect("reimport exported table");
  assert_persisted_alignment(&reimported);
}
/// Import: table with single column still writes a flat table, not paragraphs.
#[test]
fn test_import_single_column_table() {
  let md = "| Item |\n|------|\n| one  |\n| two  |";
  let update = markdown_to_yjs("Test", md).unwrap();
  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    txn
      .apply_update(Update::decode_v1(&update).unwrap())
      .expect("apply yjs update");
  }

  let txn = doc.transact();
  let mut table_count = 0;
  let mut cell_count = 0;
  for (_key, value) in blocks_map.iter(&txn) {
    if let yrs::Out::YMap(block) = value
      && let Some(yrs::Out::Any(yrs::Any::String(flavour))) = block.get(&txn, "sys:flavour")
      && flavour.as_ref() == "myoxus:table"
    {
      table_count += 1;
      cell_count += block
        .iter(&txn)
        .filter(|(key, value)| {
          key.starts_with("prop:cells.") && key.ends_with(".text") && matches!(value, yrs::Out::YText(_))
        })
        .count();
    }
  }
  assert_eq!(table_count, 1, "single-column table must create one myoxus:table");
  assert_eq!(cell_count, 3, "single-column table must store all three cells");

  let result = extract_text_from_yjs(&update).unwrap();
  assert!(
    result.markdown.contains("| Item |") && result.markdown.contains("| one |") && result.markdown.contains("| two |"),
    "single-column table must extract as Markdown table, got:\n{}",
    result.markdown
  );
}
/// P49-B-07: Nested lists roundtrip — import nested markdown lists, export
/// back, verify indentation is preserved.
#[test]
fn test_nested_list_roundtrip() {
  let md = "- Item 1\n  - Nested A\n  - Nested B\n- Item 2\n";
  let update = markdown_to_yjs("Nested", md).unwrap();
  let result = extract_text_from_yjs(&update).unwrap();

  assert_eq!(
    result.markdown.trim(),
    "- Item 1\n  - Nested A\n  - Nested B\n- Item 2",
    "nested list indentation must survive the Markdown/Yjs roundtrip"
  );
}
/// P49-C-05: Empty doc with affine:page but no content blocks → empty markdown.
#[test]
fn test_empty_doc_export() {
  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  let update = {
    let mut txn = doc.transact_mut();

    let page = blocks_map.insert(&mut txn, "page1", yrs::MapPrelim::default());
    page.insert(&mut txn, "flavour", "affine:page");
    page.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    page.insert(&mut txn, "text", yrs::TextPrelim::new("Empty Page"));

    txn.encode_update_v1()
  };

  let result = extract_text_from_yjs(&update).unwrap();
  assert!(
    result.markdown.trim().is_empty(),
    "doc with page but no content blocks must produce empty markdown, got: '{}'",
    result.markdown
  );
  assert_eq!(result.title.as_deref(), Some("Empty Page"));
}
/// P49-C-05: Doc with paragraph containing only whitespace → empty/whitespace markdown.
#[test]
fn test_whitespace_only_export() {
  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  let update = {
    let mut txn = doc.transact_mut();

    let page = blocks_map.insert(&mut txn, "page1", yrs::MapPrelim::default());
    page.insert(&mut txn, "flavour", "affine:page");
    let page_children = page.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    page_children.push_back(&mut txn, "para1");
    page.insert(&mut txn, "text", yrs::TextPrelim::new("Test"));

    let para = blocks_map.insert(&mut txn, "para1", yrs::MapPrelim::default());
    para.insert(&mut txn, "flavour", "affine:paragraph");
    para.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    para.insert(&mut txn, "text", yrs::TextPrelim::new("   \n  \n  "));

    txn.encode_update_v1()
  };

  let result = extract_text_from_yjs(&update).unwrap();
  assert!(
    result.markdown.trim().is_empty(),
    "whitespace-only paragraph should produce empty/whitespace markdown, got: '{}'",
    result.markdown
  );
}
/// P49-C-05: Doc with only affine:image block → produces `![](url)` markdown.
#[test]
fn test_image_only_export() {
  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  let update = {
    let mut txn = doc.transact_mut();

    let page = blocks_map.insert(&mut txn, "page1", yrs::MapPrelim::default());
    page.insert(&mut txn, "flavour", "affine:page");
    let page_children = page.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    page_children.push_back(&mut txn, "img1");
    page.insert(&mut txn, "text", yrs::TextPrelim::new("Image Doc"));

    let img = blocks_map.insert(&mut txn, "img1", yrs::MapPrelim::default());
    img.insert(&mut txn, "flavour", "affine:image");
    img.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    let props = img.insert(&mut txn, "props", yrs::MapPrelim::default());
    props.insert(&mut txn, "sourceId", "https://example.com/image.png");

    txn.encode_update_v1()
  };

  let result = extract_text_from_yjs(&update).unwrap();
  assert!(
    result.markdown.contains("![](https://example.com/image.png)"),
    "image-only doc must produce ![](url) markdown, got: '{}'",
    result.markdown
  );
}
#[test]
fn markdown_import_creates_native_image_block_for_standalone_image() {
  let update = markdown_to_yjs("Image Import", "![Diagram](markdown-import/doc/image.svg)").unwrap();
  let result = extract_text_from_yjs(&update).unwrap();

  assert!(
    result.markdown.contains("![Diagram](markdown-import/doc/image.svg)"),
    "standalone image must roundtrip through native image extraction, got:\n{}",
    result.markdown
  );

  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let update = yrs::Update::decode_v1(&update).expect("valid yjs update");
  doc.transact_mut().apply_update(update).expect("apply yjs update");
  let txn = doc.transact();
  let direct_string = |block: &yrs::MapRef, key: &str| -> Option<String> {
    block.get(&txn, key).and_then(|value| match value {
      yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
      _ => None,
    })
  };
  let image_count = blocks
    .iter(&txn)
    .filter(|(_, value)| {
      let yrs::Out::YMap(block) = value else {
        return false;
      };
      direct_string(block, "sys:flavour").as_deref() == Some("myoxus:image")
        && direct_string(block, "prop:sourceId").as_deref() == Some("markdown-import/doc/image.svg")
        && direct_string(block, "prop:caption").as_deref() == Some("Diagram")
    })
    .count();
  assert_eq!(
    image_count, 1,
    "standalone Markdown image must become one native image block"
  );
}
#[test]
fn markdown_import_keeps_inline_image_inside_paragraph_text() {
  let update = markdown_to_yjs("Inline Image", "Before ![Icon](markdown-import/doc/icon.svg) after.").unwrap();
  let result = extract_text_from_yjs(&update).unwrap();

  assert!(
    result
      .markdown
      .contains("Before ![Icon](markdown-import/doc/icon.svg) after."),
    "inline image should remain part of paragraph text, got:\n{}",
    result.markdown
  );
}

#[test]
fn markdown_import_rejects_raw_html_without_echoing_source() {
  for markdown in [
    "<section>unsafe</section>",
    "Valid prose before <span data-secret=\"credential\">unsafe</span> after.",
    "![data](data:image/png;base64,AAAA)\n\n<div>unsafe</div>",
  ] {
    let error = markdown_to_yjs("Rejected HTML", markdown).expect_err("raw HTML must fail closed");
    assert_eq!(error, "unsupported raw HTML in Markdown");
    assert!(!error.contains("credential"));
    assert!(!error.contains("AAAA"));
  }
}

#[test]
fn markdown_import_keeps_only_the_narrow_html_compatibility_bridge() {
  let table = "| Value |\n| --- |\n| first<br />second |\n| third<br>fourth |";
  let update = markdown_to_yjs("Table breaks", table).expect("table break bridge remains supported");
  let exported = extract_text_from_yjs(&update).expect("project table breaks").markdown;
  assert!(exported.contains("first<br />second"), "{exported}");
  assert!(exported.contains("third<br />fourth"), "{exported}");

  let escaped = markdown_to_yjs("Literal HTML", r"\<span>literal\</span>").expect("escaped HTML stays text");
  let escaped = extract_text_from_yjs(&escaped).expect("project escaped HTML").markdown;
  assert!(escaped.contains("\\<span>literal\\</span>"), "{escaped}");
  markdown_to_yjs("Literal HTML roundtrip", &escaped).expect("exported literal HTML remains inert text");

  let fenced =
    markdown_to_yjs("HTML code", "```html\n<div>code only</div>\n```").expect("HTML inside a code fence is inert code");
  let fenced = extract_text_from_yjs(&fenced).expect("project fenced HTML").markdown;
  assert!(fenced.contains("<div>code only</div>"), "{fenced}");
}
/// P51-D-07: Markdown → Yjs → Markdown → Yjs → Markdown must stabilise by 2nd roundtrip.
#[test]
fn test_bidirectional_roundtrip_stability() {
  let md = "# Title\n\n**Bold** and *italic*\n\n- List item\n";

  // First roundtrip: markdown → yjs → markdown
  let update1 = markdown_to_yjs("Title", md).unwrap();
  let result1 = extract_text_from_yjs(&update1).unwrap();

  // Second roundtrip: exported markdown → yjs → markdown
  let update2 = markdown_to_yjs("Title", &result1.markdown).unwrap();
  let result2 = extract_text_from_yjs(&update2).unwrap();

  assert_eq!(
    result1.markdown, result2.markdown,
    "roundtrip must be stable after 2nd pass:\n--- pass 1 ---\n{}\n--- pass 2 ---\n{}",
    result1.markdown, result2.markdown
  );
}

#[test]
fn line_break_semantics_and_writer_output_stabilize_after_first_projection() {
  let expected = concat!(
    "Soft alpha soft beta & literal\n\n",
    "Backslash **bold**\\\n**after** [link](https://example.test/a_%28b%29)\n\n",
    "Two-space *italic*\\\n*after*\n\n",
    "> Quote soft wrap\\\n> hard\n>\n",
    "7. Ordered soft wrap\\\n   hard\n",
    "   - nested soft wrap\\\n     hard\n\n",
    "| Value |\n| --- |\n| alpha<br />beta |\n\n",
    "```text\ncode line  \ncode backslash\\\nblank\n\n```"
  );

  for source in [
    LINE_BREAK_ROUNDTRIP_FIXTURE.to_string(),
    LINE_BREAK_ROUNDTRIP_FIXTURE.replace('\n', "\r\n"),
    LINE_BREAK_ROUNDTRIP_FIXTURE.replace('\n', "\r"),
  ] {
    let imported = markdown_to_yjs("Breaks", &source).expect("import line-ending variant");
    let projected = extract_text_from_yjs(&imported).expect("project line-ending variant");
    assert_eq!(projected.markdown, expected);
  }

  let mut markdown = LINE_BREAK_ROUNDTRIP_FIXTURE.to_string();
  for pass in 0..3 {
    let imported = markdown_to_yjs("Breaks", &markdown).expect("import repeated pass");
    let projected = extract_text_from_yjs(&imported).expect("export repeated pass");
    assert_eq!(projected.markdown, expected, "projection drift on pass {pass}");
    markdown = projected.markdown;
  }
}

#[test]
fn native_breaks_and_client_writer_handoff_keep_semantics_and_stabilize() {
  let mut builder = YjsDocumentBuilder::new("Native breaks");
  builder.push_paragraph(&[YjsTextSegment {
    text: "native\nbreak".to_string(),
    bold: true,
    ..YjsTextSegment::default()
  }]);
  builder.push_code("text", "code line  \ncode backslash\\\nblank\n");
  let native = extract_text_from_yjs(&builder.encode()).expect("export native break document");
  assert_eq!(
    native.markdown,
    "**native\\\nbreak**\n\n```text\ncode line  \ncode backslash\\\nblank\n\n```"
  );
  let reimported = markdown_to_yjs("Native breaks", &native.markdown).expect("reimport native breaks");
  assert_eq!(
    extract_text_from_yjs(&reimported)
      .expect("re-export native breaks")
      .markdown,
    native.markdown
  );

  // The client writer keeps a final newline and may choose different URL
  // spelling. Server import still preserves the same break semantics and its
  // own output must stabilize after receiving that representation.
  let client_handoff =
    "Soft alpha soft beta & literal\n\nBackslash **bold**\\\n**after** [link](https://example.test/a_\\(b\\))\n";
  let first = extract_text_from_yjs(&markdown_to_yjs("Client handoff", client_handoff).expect("import client output"))
    .expect("project client output")
    .markdown;
  let second = extract_text_from_yjs(&markdown_to_yjs("Client handoff", &first).expect("reimport server output"))
    .expect("re-project server output")
    .markdown;
  assert_eq!(first, second);
  assert_eq!(
    first,
    "Soft alpha soft beta & literal\n\nBackslash **bold**\\\n**after** [link](https://example.test/a_%28b%29)"
  );
}
/// P49-B-10: YouTube embed block exports as markdown link.
#[test]
fn test_youtube_embed_export() {
  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  let update = {
    let mut txn = doc.transact_mut();

    let page = blocks_map.insert(&mut txn, "page1", yrs::MapPrelim::default());
    page.insert(&mut txn, "flavour", "affine:page");
    let page_children = page.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    page_children.push_back(&mut txn, "yt1");
    page.insert(&mut txn, "text", yrs::TextPrelim::new("Test"));

    let yt = blocks_map.insert(&mut txn, "yt1", yrs::MapPrelim::default());
    yt.insert(&mut txn, "flavour", "affine:embed-youtube");
    yt.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    let props = yt.insert(&mut txn, "props", yrs::MapPrelim::default());
    props.insert(&mut txn, "url", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    txn.encode_update_v1()
  };

  let result = extract_text_from_yjs(&update).unwrap();
  assert!(
    result
      .markdown
      .contains("[YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)"),
    "must contain YouTube markdown link, got:\n{}",
    result.markdown
  );
}
/// Legacy affine:heading remains readable even though new writes use
/// myoxus:paragraph with prop:type h1..h6.
#[test]
fn legacy_affine_heading_extracts_as_markdown_heading() {
  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  let update = {
    let mut txn = doc.transact_mut();

    let page = blocks_map.insert(&mut txn, "page1", yrs::MapPrelim::default());
    page.insert(&mut txn, "flavour", "affine:page");
    let children = page.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    children.push_back(&mut txn, "heading1");
    page.insert(&mut txn, "text", yrs::TextPrelim::new("Legacy Heading Doc"));

    let heading = blocks_map.insert(&mut txn, "heading1", yrs::MapPrelim::default());
    heading.insert(&mut txn, "flavour", "affine:heading");
    heading.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    heading.insert(&mut txn, "text", yrs::TextPrelim::new("Legacy H2"));
    let props = heading.insert(&mut txn, "props", yrs::MapPrelim::default());
    props.insert(&mut txn, "level", 2);

    txn.encode_update_v1()
  };

  let result = extract_text_from_yjs(&update).unwrap();
  assert!(
    result.markdown.contains("## Legacy H2"),
    "legacy affine:heading must still extract as heading markdown, got:\n{}",
    result.markdown
  );
}
/// extract_text_from_yjs handles a legacy affine:* document transparently.
#[test]
fn flavour_alias_text_extraction_legacy_doc() {
  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  let update = {
    let mut txn = doc.transact_mut();

    let page = blocks_map.insert(&mut txn, "page1", yrs::MapPrelim::default());
    // Use legacy affine:page / affine:paragraph flavours
    page.insert(&mut txn, "flavour", "affine:page");
    let children = page.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    children.push_back(&mut txn, "note1");
    page.insert(&mut txn, "text", yrs::TextPrelim::new("Legacy Doc Title"));

    let note = blocks_map.insert(&mut txn, "note1", yrs::MapPrelim::default());
    note.insert(&mut txn, "flavour", "affine:note");
    let note_children = note.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    note_children.push_back(&mut txn, "para1");

    let para = blocks_map.insert(&mut txn, "para1", yrs::MapPrelim::default());
    para.insert(&mut txn, "flavour", "affine:paragraph");
    para.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    para.insert(&mut txn, "text", yrs::TextPrelim::new("legacy paragraph body"));

    txn.encode_update_v1()
  };

  let result = extract_text_from_yjs(&update).unwrap();
  assert_eq!(
    result.title.as_deref(),
    Some("Legacy Doc Title"),
    "title extraction must work for legacy affine:page"
  );
  assert!(
    result.markdown.contains("legacy paragraph body"),
    "body extraction must work for legacy affine:paragraph: got '{}'",
    result.markdown
  );
}
/// extract_text_from_yjs handles a canonical myoxus:* document.
#[test]
fn flavour_alias_text_extraction_canonical_doc() {
  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  let update = {
    let mut txn = doc.transact_mut();

    let page = blocks_map.insert(&mut txn, "page1", yrs::MapPrelim::default());
    // Use canonical myoxus:* flavours
    page.insert(&mut txn, "flavour", "myoxus:page");
    let children = page.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    children.push_back(&mut txn, "note1");
    page.insert(&mut txn, "text", yrs::TextPrelim::new("Canonical Doc Title"));

    let note = blocks_map.insert(&mut txn, "note1", yrs::MapPrelim::default());
    note.insert(&mut txn, "flavour", "myoxus:note");
    let note_children = note.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    note_children.push_back(&mut txn, "para1");

    let para = blocks_map.insert(&mut txn, "para1", yrs::MapPrelim::default());
    para.insert(&mut txn, "flavour", "myoxus:paragraph");
    para.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    para.insert(&mut txn, "text", yrs::TextPrelim::new("canonical paragraph body"));

    txn.encode_update_v1()
  };

  let result = extract_text_from_yjs(&update).unwrap();
  assert_eq!(
    result.title.as_deref(),
    Some("Canonical Doc Title"),
    "title extraction must work for canonical myoxus:page"
  );
  assert!(
    result.markdown.contains("canonical paragraph body"),
    "body extraction must work for canonical myoxus:paragraph: got '{}'",
    result.markdown
  );
}

#[test]
fn semantic_projection_stabilizes_after_export_and_reimport() {
  let first = markdown_to_yjs("Operations Runbook Fixture", COMPLEX_MARKDOWN_FIXTURE)
    .expect("import shared complex Markdown fixture");
  let first_projection = extract_text_from_yjs(&first).expect("export imported document");
  let second =
    markdown_to_yjs("Operations Runbook Fixture", &first_projection.markdown).expect("reimport canonical Markdown");
  let second_projection = extract_text_from_yjs(&second).expect("export reimported document");

  assert_eq!(first_projection.title, second_projection.title);
  assert_eq!(first_projection.markdown, second_projection.markdown);
  assert!(!first_projection.markdown.is_empty());
}

#[test]
fn native_document_reference_roundtrip_preserves_identity_alias_and_navigation() {
  let reference = MarkdownDocumentReference {
    page_id: "external-target-key".to_string(),
    title: Some("Runbook alias".to_string()),
    description: None,
    params: Some(serde_json::json!({"mode":"page","blockIds":["block-7"]})),
  };
  let mut builder = YjsDocumentBuilder::new("Source");
  builder.push_paragraph(&[YjsTextSegment {
    text: " ".to_string(),
    reference: Some(reference.clone()),
    ..YjsTextSegment::default()
  }]);
  let update = builder.encode();

  let projected = extract_text_from_yjs_with_references(&update, &|_| true, &|candidate| {
    assert_eq!(candidate, &reference);
    Some(MarkdownResolvedReference {
      url: "https://myoxus.test/workspace/ws/external-target-key?mode=page&blockIds=block-7".to_string(),
      title: "Renamed target".to_string(),
    })
  })
  .expect("project reference");
  assert_eq!(
    projected.markdown,
    "[Runbook alias](https://myoxus.test/workspace/ws/external-target-key?mode=page&blockIds=block-7)"
  );
  assert!(!projected.extraction_partial);
  assert!(projected.diagnostics.is_empty());

  let reimported = markdown_to_yjs_with_references("Source", &projected.markdown, &|url| {
    url
      .contains("/workspace/ws/external-target-key")
      .then_some(reference.clone())
  })
  .expect("reimport authorized URL");
  let occurrences = extract_document_references_from_yjs(&reimported).expect("extract references");
  assert_eq!(occurrences.occurrences.len(), 1);
  assert_eq!(occurrences.occurrences[0].raw_target_doc_id, "external-target-key");
  assert!(occurrences.occurrences[0].markdown_preview.is_empty());
  assert_eq!(occurrences.occurrences[0].params_json["title"], "Runbook alias");
}

#[test]
fn unresolved_native_reference_stays_visible_and_reports_partial_projection() {
  let mut builder = YjsDocumentBuilder::new("Source");
  builder.push_paragraph(&[YjsTextSegment {
    text: " ".to_string(),
    reference: Some(MarkdownDocumentReference {
      page_id: "missing-key".to_string(),
      title: Some("Visible alias".to_string()),
      ..MarkdownDocumentReference::default()
    }),
    ..YjsTextSegment::default()
  }]);

  let projected = extract_text_from_yjs(&builder.encode()).expect("project unresolved reference");
  assert_eq!(projected.markdown, "Visible alias");
  assert!(projected.extraction_partial);
  assert_eq!(projected.diagnostics.len(), 1);
  assert_eq!(
    projected.diagnostics[0].code,
    MarkdownDiagnosticCode::UnresolvedDocumentReference
  );
}

#[test]
fn wikilinks_resolve_aliases_without_rewriting_code_or_escapes() {
  let imported = markdown_to_yjs_with_link_resolver(
    "Source",
    "Before [[Target|Visible alias]] after.\n\n`[[Target]]`\n\n\\[[Target]]\n\n[[Missing]]\n\n![[Embed]]\n",
    &|target| match target {
      super::MarkdownLinkTarget::Wiki("Target") => {
        super::MarkdownLinkResolution::Reference(MarkdownDocumentReference {
          page_id: "target-key".to_string(),
          title: Some("Target".to_string()),
          ..MarkdownDocumentReference::default()
        })
      }
      super::MarkdownLinkTarget::Wiki("Embed") => super::MarkdownLinkResolution::Unsupported,
      super::MarkdownLinkTarget::Wiki(_) => super::MarkdownLinkResolution::Unresolved,
      super::MarkdownLinkTarget::Url(_) => super::MarkdownLinkResolution::Ordinary,
    },
  )
  .expect("import wikilinks");

  let references = extract_document_references_from_yjs(&imported.yjs_binary).expect("extract reference");
  assert_eq!(references.occurrences.len(), 1);
  assert_eq!(references.occurrences[0].raw_target_doc_id, "target-key");
  assert!(references.occurrences[0].markdown_preview.is_empty());
  assert_eq!(references.occurrences[0].params_json["title"], "Visible alias");
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  doc
    .transact_mut()
    .apply_update(Update::decode_v1(&imported.yjs_binary).expect("decode reference document"))
    .expect("apply reference document");
  let txn = doc.transact();
  let reference_text = blocks
    .iter(&txn)
    .filter_map(|(_, value)| match value {
      yrs::Out::YMap(block) => Some(block),
      _ => None,
    })
    .flat_map(|block| block.iter(&txn).map(|(_, value)| value).collect::<Vec<_>>())
    .filter_map(|value| match value {
      yrs::Out::YText(text) => Some(text),
      _ => None,
    })
    .flat_map(|text| text.diff(&txn, yrs::types::text::YChange::identity))
    .filter(|diff| {
      diff
        .attributes
        .as_ref()
        .is_some_and(|attrs| attrs.contains_key("reference"))
    })
    .filter_map(|diff| match diff.insert {
      yrs::Out::Any(yrs::Any::String(text)) => Some(text.to_string()),
      _ => None,
    })
    .collect::<Vec<_>>();
  assert_eq!(reference_text, [" "], "one reference must be one atomic placeholder");
  assert_eq!(imported.diagnostics.len(), 2);
  assert_eq!(
    imported
      .diagnostics
      .iter()
      .map(|diagnostic| diagnostic.code)
      .collect::<Vec<_>>(),
    vec![
      MarkdownDiagnosticCode::UnresolvedDocumentReference,
      MarkdownDiagnosticCode::UnsupportedDocumentReference,
    ]
  );

  let projected = extract_text_from_yjs(&imported.yjs_binary).expect("project literals");
  assert!(projected.markdown.contains("`[[Target]]`"));
  assert!(projected.markdown.contains("\\[\\[Target\\]\\]"));
  assert!(projected.markdown.contains("\\[\\[Missing\\]\\]"));
  assert!(projected.markdown.contains("!\\[\\[Embed\\]\\]"));
}

#[test]
fn aliasless_wikilinks_follow_the_current_authorized_title() {
  let imported = markdown_to_yjs_with_link_resolver("Source", "[[Target]]", &|target| match target {
    super::MarkdownLinkTarget::Wiki("Target") => super::MarkdownLinkResolution::Reference(MarkdownDocumentReference {
      page_id: "target-key".to_string(),
      title: Some("resolver title is not an alias".to_string()),
      ..MarkdownDocumentReference::default()
    }),
    _ => super::MarkdownLinkResolution::Ordinary,
  })
  .expect("import aliasless wikilink");

  let projected = extract_text_from_yjs_with_references(&imported.yjs_binary, &|_| true, &|reference| {
    assert_eq!(reference.page_id, "target-key");
    assert_eq!(reference.title, None);
    Some(MarkdownResolvedReference {
      url: "https://myoxus.test/workspace/ws/target-key".to_string(),
      title: "Renamed target".to_string(),
    })
  })
  .expect("project aliasless reference after rename");

  assert_eq!(
    projected.markdown,
    "[Renamed target](https://myoxus.test/workspace/ws/target-key)"
  );
}

#[test]
fn native_table_headers_and_basic_cell_attributes_roundtrip_through_markdown() {
  let source = "Before\n\n| **Label** | Empty | Right |\n| :--- | :---: | ---: |\n| *Body* |  | ~~strike~~ [link](https://example.test/a?x=1&y=2) |\n| literal \\<tag> & \"quote\" | first<br>second | `code` |\n\nAfter";
  let imported = markdown_to_yjs("Tables", source).unwrap();
  let snapshot = |state: &[u8]| {
    let doc = Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(state).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let txn = doc.transact();
    let table = blocks
      .iter(&txn)
      .find_map(|(_, value)| match value {
        yrs::Out::YMap(table) if block_string(&table, &txn, "flavour").as_deref() == Some("myoxus:table") => {
          Some(table)
        }
        _ => None,
      })
      .unwrap();
    let mut cells = std::collections::BTreeMap::new();
    let mut columns = std::collections::BTreeMap::new();
    for (key, value) in table.iter(&txn) {
      if let yrs::Out::YText(text) = value {
        cells.insert(
          key.to_owned(),
          text
            .diff(&txn, |_| ())
            .into_iter()
            .map(|diff| (diff.insert.to_string(&txn), diff.attributes))
            .collect::<Vec<_>>(),
        );
      } else if key.starts_with("prop:columns.") {
        columns.insert(key.to_owned(), value.to_string(&txn));
      }
    }
    (
      table.get(&txn, "prop:headerRows").map(|value| value.to_string(&txn)),
      cells,
      columns,
    )
  };
  for count in [None, Some(0), Some(1), Some(2), Some(3)] {
    let doc = Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&imported).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    let table = blocks
      .iter(&txn)
      .find_map(|(_, value)| match value {
        yrs::Out::YMap(table) if block_string(&table, &txn, "flavour").as_deref() == Some("myoxus:table") => {
          Some(table)
        }
        _ => None,
      })
      .unwrap();
    if let Some(count) = count {
      table.insert(&mut txn, "prop:headerRows", count as f64);
    } else {
      table.remove(&mut txn, "prop:headerRows");
    }
    let state = txn.encode_diff_v1(&yrs::StateVector::default());
    drop(txn);
    let original = snapshot(&state);
    let exported = extract_text_from_yjs(&state).unwrap();
    assert!(!exported.extraction_partial && exported.diagnostics.is_empty());
    assert_eq!(snapshot(&state), original, "export cannot mutate a native absent value");
    if count == Some(1) {
      assert!(exported.markdown.contains("| :--- | :---: | ---: |"));
    } else {
      let parsed = scraper::Html::parse_fragment(&exported.markdown);
      let selector = |value| scraper::Selector::parse(value).unwrap();
      assert_eq!(parsed.select(&selector("thead tr")).count(), count.unwrap_or(0));
      assert_eq!(parsed.select(&selector("tbody tr")).count(), 3 - count.unwrap_or(0));
      assert!(exported.markdown.contains("<strong>Label</strong>"));
      assert!(!exported.markdown.contains("**Label**"));
    }
    let reimported = markdown_to_yjs("Tables", &exported.markdown).unwrap();
    let actual = snapshot(&reimported);
    assert_eq!(actual.0, Some(count.unwrap_or(0).to_string()));
    assert_eq!(actual.1, original.1);
    assert_eq!(actual.2, original.2);
    assert_eq!(
      extract_text_from_yjs(&reimported).unwrap().markdown,
      exported.markdown,
      "second projection stabilizes"
    );
  }
}

#[test]
fn html_table_blocks_keep_parent_order_and_reject_unadmitted_content() {
  let table =
    "<table><tbody><tr><td><strong>A</strong><br>B</td><td></td></tr><tr><td>C</td><td>D</td></tr></tbody></table>";
  for source in [
    format!("Before\n\n{table}\n\nAfter"),
    format!("- Before\n\n  {table}\n\n  After"),
    format!("> Before\n>\n> {table}\n>\n> After"),
  ] {
    let imported = markdown_to_yjs("Containers", &source).unwrap();
    let first = extract_text_from_yjs(&imported).unwrap();
    assert!(!first.extraction_partial && first.diagnostics.is_empty());
    let second = extract_text_from_yjs(&markdown_to_yjs("Containers", &first.markdown).unwrap()).unwrap();
    assert_eq!(first.markdown, second.markdown);
    assert!(first.markdown.find("Before").unwrap() < first.markdown.find("<table>").unwrap());
    assert!(first.markdown.find("</table>").unwrap() < first.markdown.find("After").unwrap());
  }
  for unsafe_source in [
    "<script>private</script>".into(),
    table.replace("<td>", "<td onclick=\"private()\">"),
    table.replace("<td>", "<td colspan=\"2\">"),
    table.replace("<td>", "<td style=\"color:red\">"),
    table.replace("<strong>A</strong>", "<a href=\"javascript:private()\">A</a>"),
    table.replace("<strong>A</strong>", "<span>A</span>"),
    table.replace(
      "<strong>A</strong>",
      "<table><tbody><tr><td>A</td></tr></tbody></table>",
    ),
    table.trim_end_matches("</table>").into(),
    format!("{table}<script>private</script>"),
    table.replace("<td>D</td>", ""),
    table.replace("<strong>A</strong>", "<img src=\"private\">"),
    table.replace("<td>", "<td style=\"text-align:right;position:absolute\">"),
  ] {
    let error = markdown_to_yjs("Unsafe", &unsafe_source).unwrap_err();
    assert_eq!(error, "unsupported raw HTML in Markdown");
    assert!(!error.contains("private"));
  }
  let source = "<table><thead><tr><td>A</td></tr></thead><tbody><tr><td>B</td></tr></tbody></table>";
  let imported = markdown_to_yjs("Section", source).unwrap();
  assert!(extract_text_from_yjs(&imported).unwrap().markdown.contains("| A |"));
}

#[test]
fn legacy_hierarchical_headerless_cells_use_native_attributes_and_literal_escaping() {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();
  let page = blocks.insert(&mut txn, "page", yrs::MapPrelim::default());
  page.insert(&mut txn, "sys:flavour", "affine:page");
  page.insert(&mut txn, "sys:children", yrs::ArrayPrelim::from(["note"]));
  let note = blocks.insert(&mut txn, "note", yrs::MapPrelim::default());
  note.insert(&mut txn, "sys:flavour", "affine:note");
  note.insert(&mut txn, "sys:children", yrs::ArrayPrelim::from(["table"]));
  let table = blocks.insert(&mut txn, "table", yrs::MapPrelim::default());
  table.insert(&mut txn, "sys:flavour", "affine:table");
  table.insert(&mut txn, "sys:children", yrs::ArrayPrelim::from(["row"]));
  let row = blocks.insert(&mut txn, "row", yrs::MapPrelim::default());
  row.insert(&mut txn, "sys:flavour", "affine:paragraph");
  row.insert(&mut txn, "sys:children", yrs::ArrayPrelim::from(["cell"]));
  let cell = blocks.insert(&mut txn, "cell", yrs::MapPrelim::default());
  cell.insert(&mut txn, "sys:flavour", "affine:paragraph");
  let text = cell.insert(&mut txn, "prop:text", yrs::TextPrelim::default());
  text.insert_with_attributes(
    &mut txn,
    0,
    "<literal>\nbody",
    Attrs::from([(std::sync::Arc::from("bold"), yrs::Any::Bool(true))]),
  );
  let original = txn.encode_diff_v1(&yrs::StateVector::default());
  drop(txn);
  let exported = extract_text_from_yjs(&original).unwrap();
  assert!(!exported.extraction_partial && exported.diagnostics.is_empty());
  assert!(
    exported
      .markdown
      .contains("<table><tbody><tr><td><strong>&lt;literal&gt;<br>body</strong></td></tr></tbody></table>")
  );
  let imported = markdown_to_yjs("Legacy", &exported.markdown).unwrap();
  assert_eq!(
    extract_text_from_yjs(&imported).unwrap().markdown.trim(),
    exported.markdown.trim()
  );
}
