// SPDX-License-Identifier: AGPL-3.0-or-later
//! Yjs document → IR builder.
//!
//! Parses a Yjs binary snapshot (v1 update encoding) into an [`IrDocument`].
//! Supports both the old flat-key format (`flavour`, `children`, props in
//! `props` sub-map) and the new namespaced format (`sys:flavour`,
//! `sys:children`, `prop:*` at block root level).

use std::collections::{BTreeMap, HashMap, HashSet};

use tracing::{debug, trace, warn};
use yjs::resolve_flavour;
use yrs::{Any, Array, Doc, GetString, Map, Out, Text, Transact, Update, updates::decoder::Decode};

use crate::error::IrBuildError;
use crate::ir::{
  AssetData, CURRENT_IR_VERSION, DocumentMetadata, ExportOptions, IrDocument, NativeTablePaint, NativeTablePalette,
  block::*,
  inline::{InlineSpan, TextMarks},
};

use super::AssetResolver;

/// Maximum blocks to visit before returning an error.
pub const DEFAULT_BLOCK_LIMIT: usize = 10_000;

#[cfg(test)]
mod annotation_tests {
  use super::*;
  use crate::builder::NullAssetResolver;
  use crate::ir::Branding;

  struct FootnoteAsset;
  impl super::AssetResolver for FootnoteAsset {
    async fn resolve(&mut self, id: &str) -> Result<AssetData, crate::error::AssetError> {
      assert_eq!(id, "media/pixel.svg");
      Ok(AssetData {
        mime: "image/svg+xml".into(),
        bytes: include_bytes!("../../../../../build/fixtures/markdown/obsidian-vault/media/pixel.svg").to_vec(),
        filename: Some("pixel.svg".into()),
      })
    }
  }

  #[tokio::test]
  async fn bpmn_pdf_preserves_a_titled_placeholder_without_xml_or_svg() {
    let blocks = vec![
      ("page", "myoxus:page", serde_json::json!({}), vec!["bpmn"]),
      (
        "bpmn",
        "myoxus:bpmn",
        serde_json::json!({
          "title":"Approve #panic(\"not code\")",
          "sourceHeads":{"head":"<definitions>private-process-source</definitions>"},
          "preview":"<svg onload='private-preview-code()'/>"
        }),
        vec![],
      ),
    ]
    .into_iter()
    .map(|(id, flavour, props, children)| yjs::PortableSnapshotBlock {
      id: id.into(),
      flavour: flavour.into(),
      version: None,
      props: props.as_object().unwrap().clone(),
      children: children.into_iter().map(str::to_string).collect(),
    })
    .collect::<Vec<_>>();
    let payload = yjs::snapshot_blocks_to_yjs(&blocks).unwrap();
    let metadata = DocumentMetadata {
      doc_id: uuid::Uuid::nil(),
      workspace_id: uuid::Uuid::nil(),
      title: None,
      author: None,
      created_at: None,
      updated_at: None,
      workspace_name: None,
      branding: Branding::default(),
    };
    let mut builder = YjsIrBuilder::new(NullAssetResolver);
    let ir = builder
      .build(
        &payload,
        metadata,
        ExportOptions {
          theme_fonts: crate::ir::ThemeFontSelection {
            heading: Some("Inter".into()),
            body: Some("Inter".into()),
            mono: Some("Inter".into()),
            symbol: Some("Inter".into()),
          },
          ..ExportOptions::default()
        },
      )
      .await
      .unwrap();
    let source = crate::typst_engine::ir_to_typst::ir_to_typst_source_v2(
      &ir,
      &HashMap::from([("theme.typ".into(), Vec::new()), ("preamble.typ".into(), Vec::new())]),
    )
    .unwrap()
    .source;
    assert!(source.contains("BPMN: Approve"));
    assert!(source.contains(r"\#panic"));
    for hidden in [
      "private-process-source",
      "private-preview-code",
      "<definitions>",
      "<svg",
    ] {
      assert!(!source.contains(hidden));
    }
    assert!(ir.assets.is_empty());
    assert_eq!(
      builder.diagnostics(),
      serde_json::json!([{"code":"unsupported_block","count":1}])
    );
  }

  #[tokio::test]
  async fn private_database_references_are_opaque_before_child_and_asset_resolution() {
    let workspace = uuid::Uuid::new_v4();
    let database = uuid::Uuid::new_v4();
    let row = uuid::Uuid::new_v4();
    for marker in [
      serde_json::json!({"serverRowId":row}),
      serde_json::json!({"serverReferencePresentation":"compact"}),
      serde_json::json!({"templateReference":{"key":"context.task","kind":"task","optional":true}}),
      serde_json::json!({"templateReference":{}}),
      serde_json::json!({"serverRowId":{}}),
      serde_json::json!({"serverReferencePresentation":{}}),
    ] {
      let mut props = serde_json::json!({
        "serverWorkspaceId":workspace,"serverDatabaseId":database,
        "title":"Private Task title","text":"Private Task body",
        "cells":{"value":"Private cell"}
      });
      props
        .as_object_mut()
        .unwrap()
        .extend(marker.as_object().unwrap().clone());
      let blocks = vec![
        ("page", "myoxus:page", serde_json::json!({}), vec!["note"]),
        ("note", "myoxus:note", serde_json::json!({}), vec!["task"]),
        ("task", "myoxus:database", props, vec!["secret", "asset"]),
        (
          "secret",
          "myoxus:paragraph",
          serde_json::json!({"text":"Private descendant"}),
          vec![],
        ),
        (
          "asset",
          "myoxus:image",
          serde_json::json!({"sourceId":"Private asset"}),
          vec![],
        ),
      ]
      .into_iter()
      .map(|(id, flavour, props, children)| yjs::PortableSnapshotBlock {
        id: id.into(),
        flavour: flavour.into(),
        version: None,
        props: props.as_object().unwrap().clone(),
        children: children.into_iter().map(str::to_string).collect(),
      })
      .collect::<Vec<_>>();
      for source in [blocks.as_slice(), &blocks[1..]] {
        let payload = yjs::snapshot_blocks_to_yjs(source).unwrap();
        let metadata = DocumentMetadata {
          doc_id: uuid::Uuid::nil(),
          workspace_id: uuid::Uuid::nil(),
          title: None,
          author: None,
          created_at: None,
          updated_at: None,
          workspace_name: None,
          branding: Branding::default(),
        };
        let ir = YjsIrBuilder::new(NullAssetResolver)
          .build(&payload, metadata, ExportOptions::default())
          .await
          .unwrap();
        let rendered = serde_json::to_string(&ir.root).unwrap();
        assert!(
          rendered.contains("Target unavailable"),
          "marker={marker}; page_root={}; rendered={rendered}",
          source.len() == blocks.len()
        );
        for secret in [
          "Private Task title",
          "Private Task body",
          "Private cell",
          "Private descendant",
          "Private asset",
        ] {
          assert!(!rendered.contains(secret), "{secret}");
        }
        for target in [workspace, database, row] {
          assert!(!rendered.contains(&target.to_string()));
        }
        assert!(ir.assets.is_empty());
      }
    }
  }

  #[tokio::test]
  async fn local_footnotes_have_one_rich_page_entry_and_legacy_citations_stay_inline() {
    let payload = yjs::markdown_to_yjs(
      "Footnotes",
      include_str!("../../../../../build/fixtures/markdown/obsidian-vault/Structured footnotes.md"),
    )
    .unwrap();
    let metadata = DocumentMetadata {
      doc_id: uuid::Uuid::nil(),
      workspace_id: uuid::Uuid::nil(),
      title: None,
      author: None,
      created_at: None,
      updated_at: None,
      workspace_name: None,
      branding: Branding::default(),
    };
    let ir = YjsIrBuilder::new(FootnoteAsset)
      .build(&payload, metadata, ExportOptions::default())
      .await
      .unwrap();
    fn local_refs<'a>(value: &'a serde_json::Value, out: &mut Vec<&'a serde_json::Value>) {
      match value {
        serde_json::Value::Object(map) => {
          if map.get("type").and_then(|x| x.as_str()) == Some("local_footnote") {
            out.push(value);
          }
          for value in map.values() {
            local_refs(value, out);
          }
        }
        serde_json::Value::Array(values) => {
          for value in values {
            local_refs(value, out);
          }
        }
        _ => {}
      }
    }
    let value = serde_json::to_value(&ir).unwrap();
    let mut references = Vec::new();
    local_refs(&value, &mut references);
    assert_eq!(references.len(), 3);
    let research = references
      .iter()
      .find_map(|entry| {
        entry
          .get("body")
          .and_then(|body| body.as_array())
          .filter(|body| body.len() == 8)
      })
      .unwrap();
    assert_eq!(references.iter().filter(|entry| entry.get("body").is_some()).count(), 2);
    assert_eq!(research[0]["kind"], "paragraph");
    assert_eq!(research[2]["kind"], "heading");
    assert_eq!(research[3]["kind"], "list");
    assert_eq!(research[4]["kind"], "quote");
    assert_eq!(research[5]["kind"], "code");
    assert_eq!(research[6]["kind"], "image");
    assert_eq!(research[7]["kind"], "table");
    assert!(references.iter().all(|entry| entry["placement"] == "footnote"));
    assert_eq!(references.iter().filter(|entry| entry["number"] == 1).count(), 2);
    assert_eq!(ir.assets.len(), 1);
    assert_eq!(
      ir.assets.values().next().unwrap().bytes,
      include_bytes!("../../../../../build/fixtures/markdown/obsidian-vault/media/pixel.svg")
    );
    let serialized = serde_json::to_string(&ir).unwrap();
    assert!(!serialized.contains("[^Research]"));
    assert!(serialized.contains("Legacy citation"));
    assert!(
      !serde_json::to_string(&research)
        .unwrap()
        .contains("\"kind\":\"unknown\"")
    );
  }

  #[tokio::test]
  async fn shared_note_numbering_fixture_matches_pdf_first_reference_and_unused_projection() {
    use yrs::{ReadTxn, StateVector};
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
      "../../../../../build/fixtures/contracts/footnote-numbering.json"
    ))
    .unwrap();
    let binary = yjs::markdown_to_yjs("Placement", fixture["source"].as_str().unwrap()).unwrap();
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    txn.apply_update(Update::decode_v1(&binary).unwrap()).unwrap();
    let definitions: Vec<_> = blocks
      .iter(&txn)
      .filter_map(|(id, value)| {
        let Out::YMap(block) = value else { return None };
        let Some(Out::Any(Any::String(label))) = block.get(&txn, "prop:label") else {
          return None;
        };
        Some((id.to_string(), block, label.to_string()))
      })
      .collect();
    for (_, block, label) in &definitions {
      if let Some(placement) = fixture["placements"][label].as_str() {
        block.insert(&mut txn, "prop:placement", placement);
      } else {
        block.remove(&mut txn, "prop:placement");
      }
    }
    let binary = txn.encode_state_as_update_v1(&StateVector::default());
    drop(txn);
    let metadata = DocumentMetadata {
      doc_id: uuid::Uuid::nil(),
      workspace_id: uuid::Uuid::nil(),
      title: None,
      author: None,
      created_at: None,
      updated_at: None,
      workspace_name: None,
      branding: Branding::default(),
    };
    let ir = YjsIrBuilder::new(NullAssetResolver)
      .build(&binary, metadata, ExportOptions::default())
      .await
      .unwrap();
    let mut actual = HashMap::new();
    let mut root = ir.root.clone();
    walk_local_note_text(&mut root, &mut |spans, _| {
      for span in spans {
        if let InlineSpan::LocalFootnote {
          definition_id,
          placement,
          number,
          ..
        } = span
        {
          actual.insert(definition_id.clone(), (*placement, *number));
        }
      }
      Ok(())
    })
    .unwrap();
    for (id, _, label) in definitions {
      let expected = &fixture["expected"][&label];
      if let Some(number) = expected["number"].as_u64() {
        let (placement, n) = actual[&id];
        assert_eq!(n, Some(number as u32), "{label}");
        assert_eq!(serde_json::to_value(placement).unwrap(), expected["placement"]);
      } else {
        assert!(!actual.contains_key(&id));
      }
    }
    let Block::Page { children, .. } = &ir.root else {
      panic!("page")
    };
    let notes: Vec<_> = children
      .iter()
      .filter_map(|block| {
        if let Block::LocalNoteDefinition {
          placement,
          number,
          children,
          ..
        } = block
        {
          Some((*placement, *number, children.len()))
        } else {
          None
        }
      })
      .collect();
    assert_eq!(
      notes,
      vec![
        (yjs::footnote::FootnotePlacement::Endnote, Some(1), 1),
        (yjs::footnote::FootnotePlacement::Endnote, None, 1)
      ]
    );
    assert!(serde_json::to_string(&ir).unwrap().contains("Unreferenced notes"));
  }

  #[tokio::test]
  async fn local_note_invalid_content_is_rejected_before_delivery() {
    use yrs::{ReadTxn, StateVector};
    let flavour = |block: &yrs::MapRef, txn: &yrs::TransactionMut<'_>| match block.get(txn, "sys:flavour") {
      Some(Out::Any(Any::String(value))) => Some(value.to_string()),
      _ => None,
    };
    let child_ids = |block: &yrs::MapRef, txn: &yrs::TransactionMut<'_>| match block.get(txn, "sys:children") {
      Some(Out::YArray(children)) => children
        .iter(txn)
        .filter_map(|value| {
          if let Out::Any(Any::String(id)) = value {
            Some(id.to_string())
          } else {
            None
          }
        })
        .collect::<Vec<_>>(),
      _ => Vec::new(),
    };
    for (case, expected) in [
      ("placement", "placement"),
      ("nested", "nested or cyclic"),
      ("missing-target", "missing local definition target"),
      ("missing-child", "missing ordinary definition child"),
      ("unsupported", "unsupported body block"),
      ("unavailable-image", "definition image is unavailable"),
      ("parent", "parent note container"),
      ("title", "outside canonical body text"),
    ] {
      let binary = yjs::markdown_to_yjs("Guard", "Body[^note].\n\n[^note]: Complete body.").unwrap();
      let native = Doc::new();
      let blocks = native.get_or_insert_map("blocks");
      let mut txn = native.transact_mut();
      txn.apply_update(Update::decode_v1(&binary).unwrap()).unwrap();
      let all: HashMap<_, _> = blocks
        .iter(&txn)
        .filter_map(|(id, value)| {
          if let Out::YMap(block) = value {
            Some((id.to_string(), block))
          } else {
            None
          }
        })
        .collect();
      let (definition_id, definition) = all
        .iter()
        .find(|(_, block)| flavour(block, &txn).as_deref() == Some("myoxus:footnote-definition"))
        .unwrap();
      let child_id = child_ids(definition, &txn)[0].clone();
      let child = &all[&child_id];
      let target = if case == "missing-target" {
        "missing"
      } else {
        definition_id
      };
      let attrs = [(
        "footnote".into(),
        Any::Map(std::sync::Arc::new(
          [("definitionId".into(), Any::String(target.into()))].into(),
        )),
      )]
      .into();
      match case {
        "placement" => {
          definition.insert(&mut txn, "prop:placement", "invalid");
        }
        "nested" => {
          let text = child.insert(&mut txn, "prop:text", yrs::TextPrelim::default());
          text.insert_with_attributes(&mut txn, 0, " ", attrs);
        }
        "missing-target" => {
          let body = all
            .values()
            .find(|block| flavour(block, &txn).as_deref() == Some("myoxus:paragraph") && **block != *child)
            .unwrap();
          let text = body.insert(&mut txn, "prop:text", yrs::TextPrelim::default());
          text.insert_with_attributes(&mut txn, 0, " ", attrs);
        }
        "missing-child" => {
          blocks.remove(&mut txn, &child_id);
        }
        "unsupported" => {
          child.insert(&mut txn, "sys:flavour", "myoxus:attachment");
        }
        "unavailable-image" => {
          child.insert(&mut txn, "sys:flavour", "myoxus:image");
        }
        "parent" => {
          let parent = all
            .values()
            .find(|block| child_ids(block, &txn).contains(definition_id))
            .unwrap();
          parent.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
        }
        "title" => {
          let page = all
            .values()
            .find(|block| flavour(block, &txn).as_deref() == Some("myoxus:page"))
            .unwrap();
          let title = page.insert(&mut txn, "prop:title", yrs::TextPrelim::default());
          title.insert_with_attributes(&mut txn, 0, " ", attrs);
        }
        _ => unreachable!(),
      }
      let snapshot = txn.encode_state_as_update_v1(&StateVector::default());
      drop(txn);
      let metadata = DocumentMetadata {
        doc_id: uuid::Uuid::nil(),
        workspace_id: uuid::Uuid::nil(),
        title: None,
        author: None,
        created_at: None,
        updated_at: None,
        workspace_name: None,
        branding: Branding::default(),
      };
      let error = YjsIrBuilder::new(NullAssetResolver)
        .build(&snapshot, metadata, ExportOptions::default())
        .await
        .unwrap_err();
      assert!(
        matches!(&error, IrBuildError::LocalNote(reason) if reason.contains(expected)),
        "{case}: {error}"
      );
    }
  }

  #[tokio::test]
  async fn excludes_annotations_before_unknown_text_fallback() {
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    let page = blocks.insert(&mut txn, "page", yrs::MapPrelim::default());
    page.insert(&mut txn, "sys:flavour", "myoxus:page");
    let children = page.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
    for (id, flavour, body) in [
      ("before", "myoxus:paragraph", "Visible before"),
      ("annotation", "myoxus:annotation", "Private **annotation**\nSecond line"),
      ("after", "myoxus:paragraph", "Visible after"),
    ] {
      let block = blocks.insert(&mut txn, id, yrs::MapPrelim::default());
      block.insert(&mut txn, "sys:flavour", flavour);
      block.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
      let text = block.insert(&mut txn, "prop:text", yrs::TextPrelim::new(body));
      if id == "before" {
        let identity = Any::Map(std::sync::Arc::new([("id".into(), Any::String("a".into()))].into()));
        text.insert_with_attributes(
          &mut txn,
          7,
          "Hidden inline\n",
          [("annotation".into(), identity.clone())].into(),
        );
        text.insert_with_attributes(
          &mut txn,
          21,
          "second delta",
          [("annotation".into(), identity), ("bold".into(), Any::Bool(true))].into(),
        );
      }
      children.push_back(&mut txn, id);
    }
    let payload = txn.encode_update_v1();
    drop(txn);
    let metadata = DocumentMetadata {
      doc_id: uuid::Uuid::nil(),
      workspace_id: uuid::Uuid::nil(),
      title: None,
      author: None,
      created_at: None,
      updated_at: None,
      workspace_name: None,
      branding: Branding::default(),
    };
    let ir = YjsIrBuilder::new(NullAssetResolver)
      .build(&payload, metadata, ExportOptions::default())
      .await
      .expect("reading PDF IR");
    let Block::Page { children, .. } = &ir.root else {
      panic!("page root preserved")
    };
    assert_eq!(children.len(), 2);
    let rendered = format!("{ir:?}");
    let Block::Paragraph { content, .. } = &children[0] else {
      panic!("visible paragraph")
    };
    assert_eq!(crate::ir::inline::inline_plain_text(content), "Visible before");
    assert!(rendered.contains("Visible after"));
    assert!(!rendered.contains("Private **annotation**"));
    assert!(!rendered.contains("Hidden inline"));
    assert!(!rendered.contains("second delta"));
    assert!(!rendered.contains("Unknown"));
  }
}

/// Builds an [`IrDocument`] from a raw Yjs v1 binary snapshot.
pub struct YjsIrBuilder<R: AssetResolver> {
  asset_resolver: R,
  block_limit: usize,
  diagnostics: BTreeMap<&'static str, u64>,
}

impl<R: AssetResolver> YjsIrBuilder<R> {
  pub fn new(asset_resolver: R) -> Self {
    Self {
      asset_resolver,
      block_limit: DEFAULT_BLOCK_LIMIT,
      diagnostics: BTreeMap::new(),
    }
  }

  pub fn with_block_limit(mut self, limit: usize) -> Self {
    self.block_limit = limit;
    self
  }

  /// Bounded aggregate of omissions observed during the most recent build.
  /// It contains no document text, asset paths or claims about unvisited content.
  pub fn diagnostics(&self) -> serde_json::Value {
    serde_json::Value::Array(
      self
        .diagnostics
        .iter()
        .map(|(code, count)| serde_json::json!({"code": code, "count": count}))
        .collect(),
    )
  }

  /// Build an IR document from a Yjs binary snapshot.
  pub async fn build(
    &mut self,
    binary: &[u8],
    mut metadata: DocumentMetadata,
    options: ExportOptions,
  ) -> Result<IrDocument, IrBuildError> {
    self.diagnostics.clear();
    // Application materializes current fields before reaching this format-only
    // builder. An unresolved atom must fail, not disappear as a native space.
    if yjs::document_field::content::inspect(binary)
      .map_err(|_| IrBuildError::YjsDecode("invalid native document field".into()))?
      .iter()
      .any(|field| !field.run.captured)
    {
      return Err(IrBuildError::YjsDecode(
        "native document field output unavailable".into(),
      ));
    }
    let doc = Doc::new();
    let blocks_map = doc.get_or_insert_map("blocks");

    {
      let mut txn = doc.transact_mut();
      let update = Update::decode_v1(binary).map_err(|e| IrBuildError::YjsDecode(e.to_string()))?;
      txn
        .apply_update(update)
        .map_err(|e| IrBuildError::YjsDecode(e.to_string()))?;
    }

    let txn = doc.transact();
    let mut ctx = BuildContext {
      txn: &txn,
      blocks_map: &blocks_map,
      asset_resolver: &mut self.asset_resolver,
      diagnostics: &mut self.diagnostics,
      block_limit: self.block_limit,
      blocks_visited: 0,
      assets: HashMap::new(),
      local_definitions: Vec::new(),
      definition_ids: HashSet::new(),
      inside_definition: false,
      table_palette: options.native_table_palette.as_ref(),
      table_canvas: metadata.branding.background.clone(),
    };

    // Find the root myoxus:page block.
    let mut root = ctx.build_root_block().await?;
    bind_local_notes(&mut root, &mut ctx.local_definitions, &options.locale)?;
    // Use the same revision as the body, including historical exports. Explicit
    // caller metadata remains authoritative when supplied.
    if metadata.title.is_none()
      && let Block::Page { title, .. } = &root
    {
      let title = crate::ir::inline::inline_plain_text(title);
      if !title.trim().is_empty() {
        metadata.title = Some(title);
      }
    }

    let assets = ctx.assets;
    Ok(IrDocument {
      version: CURRENT_IR_VERSION,
      metadata,
      options,
      root,
      assets,
    })
  }
}

// ─── Build context ───────────────────────────────────────────────────────────

struct BuildContext<'a, R: AssetResolver> {
  txn: &'a yrs::Transaction<'a>,
  blocks_map: &'a yrs::MapRef,
  asset_resolver: &'a mut R,
  diagnostics: &'a mut BTreeMap<&'static str, u64>,
  block_limit: usize,
  blocks_visited: usize,
  assets: HashMap<String, AssetData>,
  local_definitions: Vec<LocalDefinition>,
  definition_ids: HashSet<String>,
  inside_definition: bool,
  table_palette: Option<&'a NativeTablePalette>,
  table_canvas: Option<String>,
}

struct LocalDefinition {
  id: String,
  placement: yjs::footnote::FootnotePlacement,
  children: Option<Vec<Block>>,
}

/// Visit only text actually emitted in the canonical body; headings flatten
/// legacy citations, while local markers still use the same labelled entry.
fn walk_local_note_text(
  block: &mut Block,
  inspect: &mut impl FnMut(&mut [InlineSpan], bool) -> Result<(), IrBuildError>,
) -> Result<(), IrBuildError> {
  let legacy_emits = !matches!(block, Block::Heading { .. });
  match block {
    Block::Page { title, children } => {
      reject_non_body_note(title)?;
      for child in children {
        walk_local_note_text(child, inspect)?;
      }
    }
    Block::Note { children } | Block::EdgelessText { children, .. } => {
      for child in children {
        walk_local_note_text(child, inspect)?;
      }
    }
    Block::Paragraph { content, children }
    | Block::Quote { content, children }
    | Block::List { content, children, .. }
    | Block::Callout { content, children, .. }
    | Block::Heading { content, children, .. } => {
      inspect(content, legacy_emits)?;
      for child in children {
        walk_local_note_text(child, inspect)?;
      }
    }
    Block::Table { rows, caption, .. } => {
      reject_non_body_note(caption.as_deref().unwrap_or_default())?;
      for row in rows {
        for cell in &mut row.cells {
          inspect(&mut cell.content, true)?;
        }
      }
    }
    Block::Code(code) => reject_non_body_note(code.caption.as_deref().unwrap_or_default())?,
    Block::Image(image) => reject_non_body_note(image.caption.as_deref().unwrap_or_default())?,
    Block::Mermaid(diagram) => {
      reject_non_body_note(diagram.title.as_deref().unwrap_or_default())?;
      reject_non_body_note(diagram.caption.as_deref().unwrap_or_default())?;
    }
    Block::Database(table) => {
      for cell in table.rows.iter().flatten() {
        reject_non_body_note(cell)?;
      }
    }
    Block::AiChat { messages } => {
      for message in messages {
        reject_non_body_note(&message.content)?;
      }
    }
    Block::Unknown { text_fallback, .. } => reject_non_body_note(text_fallback.as_deref().unwrap_or_default())?,
    Block::Surface(snapshot) | Block::SurfaceRef(snapshot) | Block::Frame(snapshot) | Block::Mindmap(snapshot) => {
      reject_non_body_note(snapshot.caption.as_deref().unwrap_or_default())?;
    }
    _ => {}
  }
  Ok(())
}

// These channels do not participate in the editor's canonical body counter.
// Reject local markers there before rendering rather than emit unbound labels.
fn reject_non_body_note(spans: &[InlineSpan]) -> Result<(), IrBuildError> {
  if spans
    .iter()
    .any(|span| matches!(span, InlineSpan::LocalFootnote { .. }))
  {
    return Err(IrBuildError::LocalNote(
      "local reference outside canonical body text".into(),
    ));
  }
  Ok(())
}

fn validate_local_body(blocks: &[Block]) -> Result<(), IrBuildError> {
  for block in blocks {
    match block {
      Block::Note { children }
      | Block::Paragraph { children, .. }
      | Block::Quote { children, .. }
      | Block::Heading { children, .. }
      | Block::List { children, .. }
      | Block::Callout { children, .. } => validate_local_body(children)?,
      Block::Image(image) if image.blob.blob_id.is_empty() || image.data.is_none() => {
        return Err(IrBuildError::LocalNote("definition image is unavailable".into()));
      }
      Block::Code(_) | Block::Image(_) | Block::Table { .. } | Block::Divider | Block::LatexBlock { .. } => {}
      _ => {
        return Err(IrBuildError::LocalNote(format!(
          "unsupported body block: {}",
          block.flavour_name()
        )));
      }
    }
    let nested = |spans: &[InlineSpan]| {
      spans
        .iter()
        .any(|span| matches!(span, InlineSpan::LocalFootnote { .. } | InlineSpan::Footnote { .. }))
    };
    let invalid = match block {
      Block::Paragraph { content, .. }
      | Block::Quote { content, .. }
      | Block::Heading { content, .. }
      | Block::List { content, .. }
      | Block::Callout { content, .. } => nested(content),
      Block::Table { rows, caption, .. } => {
        rows.iter().flat_map(|row| &row.cells).any(|cell| nested(&cell.content))
          || caption.as_deref().is_some_and(nested)
      }
      Block::Image(image) => image.caption.as_deref().is_some_and(nested),
      Block::Code(code) => code.caption.as_deref().is_some_and(nested),
      _ => false,
    };
    if invalid {
      return Err(IrBuildError::LocalNote(
        "nested or cyclic note reference in definition body".into(),
      ));
    }
  }
  Ok(())
}

fn bind_local_notes(root: &mut Block, definitions: &mut [LocalDefinition], locale: &str) -> Result<(), IrBuildError> {
  use yjs::footnote::FootnotePlacement::{Endnote, Footnote};
  let ids: HashMap<String, usize> = definitions.iter().enumerate().map(|(i, d)| (d.id.clone(), i)).collect();
  let mut numbers: HashMap<String, (u32, usize)> = HashMap::new();
  let mut order = Vec::new();
  let (mut footnotes, mut endnotes) = (0u32, 0u32);
  walk_local_note_text(root, &mut |spans, legacy_emits| {
    for span in spans {
      match span {
        InlineSpan::Footnote { .. } if legacy_emits => {
          footnotes += 1;
        }
        InlineSpan::LocalFootnote {
          definition_id,
          placement,
          number,
          reference_index,
          locale: body_locale,
          body,
          ..
        } => {
          let index = ids
            .get(definition_id)
            .copied()
            .ok_or_else(|| IrBuildError::LocalNote("missing local definition target".into()))?;
          let definition = &mut definitions[index];
          *placement = definition.placement;
          *body_locale = locale.into();
          let first = !numbers.contains_key(definition_id);
          let entry = numbers.entry(definition_id.clone()).or_insert_with(|| {
            let counter = if *placement == Endnote {
              &mut endnotes
            } else {
              &mut footnotes
            };
            *counter += 1;
            order.push(index);
            (*counter, 0)
          });
          entry.1 += 1;
          *number = Some(entry.0);
          *reference_index = entry.1;
          if first && *placement == Footnote {
            *body = definition.children.take();
          }
        }
        _ => {}
      }
    }
    Ok(())
  })?;
  walk_local_note_text(root, &mut |spans, _| {
    for span in spans {
      if let InlineSpan::LocalFootnote {
        definition_id,
        references,
        ..
      } = span
      {
        *references = numbers[definition_id].1;
      }
    }
    Ok(())
  })?;
  let Block::Page { children, .. } = root else {
    return Err(IrBuildError::LocalNote("local notes require a page root".into()));
  };
  for index in order {
    let definition = &mut definitions[index];
    if definition.placement == Endnote {
      let (number, references) = numbers[&definition.id];
      children.push(Block::LocalNoteDefinition {
        definition_id: definition.id.clone(),
        placement: Endnote,
        number: Some(number),
        references,
        children: definition.children.take().unwrap_or_default(),
      });
    }
  }
  let unused: Vec<_> = definitions
    .iter_mut()
    .filter(|definition| !numbers.contains_key(&definition.id))
    .collect();
  if !unused.is_empty() {
    let title = match locale.split(['-', '_']).next().unwrap_or("en") {
      "de" => "Noten ohne Referenz",
      "fr" => "Notes sans référence",
      "es" => "Notas sin referencia",
      _ => "Unreferenced notes",
    };
    children.push(Block::Heading {
      level: HeadingLevel::H2,
      content: vec![InlineSpan::Text {
        text: title.into(),
        marks: Default::default(),
      }],
      children: Vec::new(),
    });
    for definition in unused {
      children.push(Block::LocalNoteDefinition {
        definition_id: definition.id.clone(),
        placement: definition.placement,
        number: None,
        references: 0,
        children: definition.children.take().unwrap_or_default(),
      });
    }
  }
  Ok(())
}

impl<'a, R: AssetResolver> BuildContext<'a, R> {
  /// Find the `myoxus:page` root and build the block tree from it.
  ///
  /// Accepts both legacy `affine:*` and canonical `myoxus:*` flavours via
  /// [`resolve_flavour`] so old snapshots (pre-commit 4c384b1d05) and new
  /// canonical snapshots both render correctly.
  async fn build_root_block(&mut self) -> Result<Block, IrBuildError> {
    // Collect all block IDs → block maps.
    let opaque_descendants = yjs::opaque_database_reference_descendants(self.blocks_map, self.txn);
    let mut all_blocks: HashMap<String, yrs::MapRef> = HashMap::new();
    let mut page_id: Option<String> = None;

    for (block_id, val) in self.blocks_map.iter(self.txn) {
      if let Out::YMap(bmap) = val {
        let flavour = get_flavour(&bmap, self.txn);
        // Exclude authoring-only content before fallback text/asset extraction.
        // The source snapshot is unchanged; Markdown export retains annotations.
        if flavour.as_deref() == Some("myoxus:annotation") {
          continue;
        }
        if flavour.as_deref().map(resolve_flavour) == Some("myoxus:page") {
          page_id = Some(block_id.to_string());
        }
        if !opaque_descendants.contains(block_id) {
          all_blocks.insert(block_id.to_string(), bmap);
        }
      }
    }

    let page_id = match page_id {
      Some(id) => id,
      None => {
        // No myoxus:page found — build a synthetic page from all blocks.
        warn!("No myoxus:page block found; building synthetic root");
        return self.build_synthetic_root(&all_blocks).await;
      }
    };

    let bmap = all_blocks
      .get(&page_id)
      .ok_or_else(|| IrBuildError::MissingField {
        block_id: page_id.clone(),
        field: "blocks_map_entry",
      })?
      .clone();

    self.build_block(&bmap, &all_blocks).await
  }

  async fn build_synthetic_root(&mut self, all_blocks: &HashMap<String, yrs::MapRef>) -> Result<Block, IrBuildError> {
    let mut children = Vec::new();
    for bmap in all_blocks.values() {
      if get_flavour(bmap, self.txn).as_deref() == Some("myoxus:footnote-definition") {
        return Err(IrBuildError::LocalNote(
          "definition requires a native page and parent note".into(),
        ));
      }
      let block = self.build_block(bmap, all_blocks).await?;
      if !matches!(block, Block::Unknown { .. }) {
        children.push(block);
      }
    }
    Ok(Block::Page {
      title: vec![InlineSpan::Text {
        text: String::new(),
        marks: TextMarks::default(),
      }],
      children,
    })
  }

  fn build_block<'b>(
    &'b mut self,
    bmap: &'b yrs::MapRef,
    all_blocks: &'b HashMap<String, yrs::MapRef>,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Block, IrBuildError>> + 'b>> {
    Box::pin(async move { self.build_block_inner(bmap, all_blocks).await })
  }

  async fn build_block_inner(
    &mut self,
    bmap: &yrs::MapRef,
    all_blocks: &HashMap<String, yrs::MapRef>,
  ) -> Result<Block, IrBuildError> {
    self.blocks_visited += 1;
    if self.blocks_visited > self.block_limit {
      return Err(IrBuildError::BlockLimitExceeded {
        count: self.blocks_visited,
        max: self.block_limit,
      });
    }

    let raw_flavour = get_flavour(bmap, self.txn).unwrap_or_default();
    // Normalize legacy `affine:*` to canonical `myoxus:*` (LRN-20260427-PDF-INV).
    let flavour = resolve_flavour(&raw_flavour).to_string();
    let para_type = get_prop_string(bmap, self.txn, "type"); // heading level or list type
    trace!(flavour = %flavour, raw = %raw_flavour, "building block");

    // Private references are opaque; their cached children have no document grant.
    if flavour == "myoxus:database" && yjs::has_opaque_database_reference(bmap, self.txn) {
      return Ok(Block::Paragraph {
        content: vec![InlineSpan::Text {
          text: "Target unavailable".into(),
          marks: TextMarks::default(),
        }],
        children: Vec::new(),
      });
    }

    // Build children recursively.
    let children_ids = get_children_ids(bmap, self.txn);
    if flavour != "myoxus:note"
      && children_ids.iter().any(|id| {
        all_blocks
          .get(id)
          .and_then(|child| get_flavour(child, self.txn))
          .is_some_and(|flavour| resolve_flavour(&flavour) == "myoxus:footnote-definition")
      })
    {
      return Err(IrBuildError::LocalNote(
        "definition requires its parent note container".into(),
      ));
    }
    if self.inside_definition || flavour == "myoxus:footnote-definition" {
      for id in &children_ids {
        if !all_blocks.contains_key(id) {
          let authoring_only = matches!(self.blocks_map.get(self.txn,id),Some(Out::YMap(block)) if get_flavour(&block,self.txn).as_deref() == Some("myoxus:annotation"));
          if !authoring_only {
            return Err(IrBuildError::LocalNote("missing ordinary definition child".into()));
          }
        }
      }
    }

    match flavour.as_str() {
      "myoxus:page" => {
        let title_text = get_text_content(bmap, self.txn, "title");
        let mut children = Vec::new();
        for child_id in &children_ids {
          if let Some(child_map) = all_blocks.get(child_id) {
            children.push(self.build_block(child_map, all_blocks).await?);
          }
        }
        Ok(Block::Page {
          title: title_text,
          children,
        })
      }

      "myoxus:note" => {
        let mut children = Vec::new();
        for child_id in &children_ids {
          if let Some(child_map) = all_blocks.get(child_id) {
            children.push(self.build_block(child_map, all_blocks).await?);
          }
        }
        Ok(Block::Note { children })
      }

      "myoxus:footnote-definition" => {
        if self.inside_definition {
          return Err(IrBuildError::LocalNote("nested definition".into()));
        }
        let id = get_any_string(bmap, self.txn, "sys:id").ok_or_else(|| IrBuildError::MissingField {
          block_id: "footnote_definition".into(),
          field: "sys:id",
        })?;
        if id.is_empty() || !self.definition_ids.insert(id.clone()) {
          return Err(IrBuildError::LocalNote("repeated definition container".into()));
        }
        let placement =
          yjs::footnote::read_placement(bmap, self.txn).map_err(|reason| IrBuildError::LocalNote(reason.into()))?;
        self.inside_definition = true;
        let mut children = Vec::new();
        for child_id in &children_ids {
          if let Some(child_map) = all_blocks.get(child_id) {
            children.push(self.build_block(child_map, all_blocks).await?);
          }
        }
        self.inside_definition = false;
        validate_local_body(&children)?;
        self.local_definitions.push(LocalDefinition {
          id,
          placement,
          children: Some(children),
        });
        Ok(Block::Note { children: Vec::new() })
      }

      "myoxus:edgeless-text" => {
        let content = get_text_content(bmap, self.txn, "text");
        let mut children = Vec::new();
        for child_id in &children_ids {
          if let Some(child_map) = all_blocks.get(child_id) {
            children.push(self.build_block(child_map, all_blocks).await?);
          }
        }
        Ok(Block::EdgelessText { content, children })
      }

      "myoxus:paragraph" => {
        let content = get_text_content(bmap, self.txn, "text");
        let mut children = Vec::new();
        for child_id in &children_ids {
          if let Some(child_map) = all_blocks.get(child_id) {
            children.push(self.build_block(child_map, all_blocks).await?);
          }
        }
        match para_type.as_deref() {
          Some("h1") => Ok(Block::Heading {
            level: HeadingLevel::H1,
            content,
            children,
          }),
          Some("h2") => Ok(Block::Heading {
            level: HeadingLevel::H2,
            content,
            children,
          }),
          Some("h3") => Ok(Block::Heading {
            level: HeadingLevel::H3,
            content,
            children,
          }),
          Some("h4") => Ok(Block::Heading {
            level: HeadingLevel::H4,
            content,
            children,
          }),
          Some("h5") => Ok(Block::Heading {
            level: HeadingLevel::H5,
            content,
            children,
          }),
          Some("h6") => Ok(Block::Heading {
            level: HeadingLevel::H6,
            content,
            children,
          }),
          Some("quote") => Ok(Block::Quote { content, children }),
          _ => Ok(Block::Paragraph { content, children }),
        }
      }

      "myoxus:list" => {
        let content = get_text_content(bmap, self.txn, "text");
        let checked = get_prop_bool(bmap, self.txn, "checked").unwrap_or(false);
        let list_type = match para_type.as_deref() {
          Some("numbered") => ListType::Numbered,
          Some("todo") => ListType::Todo,
          Some("toggle") => ListType::Toggle,
          _ => ListType::Bulleted,
        };
        let mut children = Vec::new();
        for child_id in &children_ids {
          if let Some(child_map) = all_blocks.get(child_id) {
            children.push(self.build_block(child_map, all_blocks).await?);
          }
        }
        Ok(Block::List {
          list_type,
          content,
          checked,
          children,
        })
      }

      "myoxus:code" => {
        let code = get_text_plain(bmap, self.txn, "text");
        let language = get_prop_string(bmap, self.txn, "language");
        let caption = None;
        Ok(Block::Code(CodeBlock {
          language,
          code,
          caption,
        }))
      }

      "myoxus:bpmn" => {
        // Keep PDF's loss diagnostic and escaped Unknown renderer. Only the
        // authored title crosses this boundary, never source heads or SVG.
        *self.diagnostics.entry("unsupported_block").or_default() += 1;
        let title = get_text_plain(bmap, self.txn, "title");
        let title = title.trim();
        Ok(Block::Unknown {
          flavour: flavour.clone(),
          text_fallback: Some(vec![InlineSpan::Text {
            text: format!("BPMN: {}", if title.is_empty() { "BPMN Diagram" } else { title }),
            marks: TextMarks::default(),
          }]),
        })
      }
      "myoxus:mermaid" => {
        let source = get_text_plain(bmap, self.txn, "source");
        let title = {
          let title = get_text_content(bmap, self.txn, "title");
          if title.is_empty() { None } else { Some(title) }
        };
        let caption = get_prop_string(bmap, self.txn, "caption").map(|text| {
          vec![InlineSpan::Text {
            text,
            marks: TextMarks::default(),
          }]
        });
        Ok(Block::Mermaid(MermaidDiagram { source, title, caption }))
      }

      "myoxus:divider" => Ok(Block::Divider),

      "myoxus:callout" => {
        let mut content = get_text_content(bmap, self.txn, "text");
        let emoji = get_prop_string(bmap, self.txn, "emoji");
        let variant_str = get_prop_string(bmap, self.txn, "type");
        if let Some(kind) = variant_str.as_deref().filter(|kind| !kind.is_empty()) {
          let mut title = get_text_plain(bmap, self.txn, "title");
          if title.is_empty()
            && !matches!(
              kind.to_ascii_lowercase().as_str(),
              "note"
                | "info"
                | "todo"
                | "abstract"
                | "summary"
                | "tldr"
                | "warning"
                | "caution"
                | "attention"
                | "danger"
                | "error"
                | "failure"
                | "fail"
                | "missing"
                | "bug"
                | "question"
                | "help"
                | "faq"
                | "tip"
                | "hint"
                | "important"
                | "success"
                | "check"
                | "done"
            )
          {
            title = kind.to_string();
          }
          if !title.is_empty() {
            content.insert(
              0,
              InlineSpan::Text {
                text: format!("{title}\n"),
                marks: TextMarks {
                  bold: Some(true),
                  ..Default::default()
                },
              },
            );
          }
        }
        let variant = match variant_str.as_deref().map(str::to_ascii_lowercase).as_deref() {
          Some(
            "warning" | "caution" | "attention" | "danger" | "error" | "failure" | "fail" | "missing" | "bug"
            | "question" | "help" | "faq",
          ) => CalloutVariant::Warning,
          Some("tip" | "hint" | "important" | "success" | "check" | "done") => CalloutVariant::Tip,
          Some("" | "info" | "todo" | "abstract" | "summary" | "tldr") | None => CalloutVariant::Info,
          _ => CalloutVariant::Note,
        };
        let mut children = Vec::new();
        for child_id in &children_ids {
          if let Some(child_map) = all_blocks.get(child_id) {
            children.push(self.build_block(child_map, all_blocks).await?);
          }
        }
        Ok(Block::Callout {
          variant,
          emoji,
          content,
          children,
        })
      }

      "myoxus:latex" => {
        let source = get_prop_string(bmap, self.txn, "latex")
          .or_else(|| get_prop_string(bmap, self.txn, "math"))
          .unwrap_or_default();
        Ok(Block::LatexBlock { source })
      }

      "myoxus:image" => {
        let blob_id = get_prop_string(bmap, self.txn, "sourceId")
          .or_else(|| get_prop_string(bmap, self.txn, "source_id"))
          .unwrap_or_default();
        let caption = get_prop_string(bmap, self.txn, "caption")
          .filter(|caption| !caption.trim().is_empty())
          .map(|text| {
            vec![InlineSpan::Text {
              text,
              marks: TextMarks::default(),
            }]
          });
        // The editor uses zero for natural image dimensions, not a zero-sized image.
        let width_hint = get_prop_f64(bmap, self.txn, "width").filter(|v| v.is_finite() && *v > 0.0);
        let height_hint = get_prop_f64(bmap, self.txn, "height").filter(|v| v.is_finite() && *v > 0.0);
        let blob = BlobRef {
          blob_id: blob_id.clone(),
          mime_hint: None,
        };
        let data = if !blob_id.is_empty() {
          self.resolve_image(&blob_id).await
        } else {
          *self.diagnostics.entry("missing_asset").or_default() += 1;
          None
        };
        Ok(Block::Image(ImageRef {
          blob,
          caption,
          width_hint,
          height_hint,
          data,
        }))
      }

      "myoxus:attachment" => {
        let blob_id = get_prop_string(bmap, self.txn, "sourceId")
          .or_else(|| get_prop_string(bmap, self.txn, "source_id"))
          .unwrap_or_default();
        let name = get_prop_string(bmap, self.txn, "name");
        let size_bytes = get_prop_u64(bmap, self.txn, "size");
        let mime = get_prop_string(bmap, self.txn, "type").or_else(|| get_prop_string(bmap, self.txn, "mime"));
        Ok(Block::Attachment {
          blob: BlobRef {
            blob_id,
            mime_hint: mime.clone(),
          },
          name,
          size_bytes,
          mime,
        })
      }

      "myoxus:bookmark" => {
        let url = get_prop_string(bmap, self.txn, "url").unwrap_or_default();
        let title = get_prop_string(bmap, self.txn, "title");
        let description = get_prop_string(bmap, self.txn, "description");
        Ok(Block::Bookmark(EmbedCard {
          url,
          title,
          description,
          favicon: None,
          embed_kind: "bookmark".into(),
        }))
      }

      f if f.starts_with("myoxus:embed-") || f.starts_with("affine:embed-") => {
        let kind = f
          .strip_prefix("myoxus:embed-")
          .or_else(|| f.strip_prefix("affine:embed-"))
          .unwrap_or("other")
          .to_string();
        let url = get_prop_string(bmap, self.txn, "url")
          .or_else(|| get_prop_string(bmap, self.txn, "embedUrl"))
          .unwrap_or_default();
        let title = get_prop_string(bmap, self.txn, "title");
        let description = get_prop_string(bmap, self.txn, "description");
        Ok(Block::Embed(EmbedCard {
          url,
          title,
          description,
          favicon: None,
          embed_kind: kind,
        }))
      }

      "myoxus:table" => {
        let (mut rows, column_widths) = self.build_table_rows(bmap, all_blocks).await?;
        let header_rows = get_prop_header_rows(bmap, self.txn).map(|count| count.min(rows.len()));
        if let Some(header_rows) = header_rows {
          for (row_index, row) in rows.iter_mut().enumerate() {
            for cell in &mut row.cells {
              cell.is_header = row_index < header_rows;
            }
          }
        }
        Ok(Block::Table {
          rows,
          caption: None,
          column_widths,
          header_rows,
          appearance: get_prop_string(bmap, self.txn, "appearance").and_then(|value| match value.as_str() {
            "grid" => Some(TableAppearance::Grid),
            "ruled" => Some(TableAppearance::Ruled),
            "plain" => Some(TableAppearance::Plain),
            _ => None,
          }),
          density: get_prop_string(bmap, self.txn, "density").and_then(|value| match value.as_str() {
            "normal" => Some(TableDensity::Normal),
            "compact" => Some(TableDensity::Compact),
            _ => None,
          }),
        })
      }

      "myoxus:database" => {
        let table = self.build_database(bmap, all_blocks).await;
        Ok(Block::Database(table))
      }

      "myoxus:surface" | "myoxus:surface-ref" | "myoxus:frame" | "myoxus:mindmap" | "affine:mindmap" => {
        // Edgeless raster snapshot contract (#322): the editor renders the
        // surface to a PNG via `_toCanvas()`, uploads it as a workspace
        // blob, and writes three props onto the surface block:
        //   prop:exportSnapshotBlobId   — uploaded blob id
        //   prop:exportSnapshotWidth    — captured canvas width in px
        //   prop:exportSnapshotHeight   — captured canvas height in px
        // When all three are present we resolve the blob via the asset
        // resolver and embed the PNG bytes in the IR. Anything missing →
        // empty placeholder, which the renderer turns into a "snapshot not
        // available" block. The editor side of this contract is a
        // virgultum task (capture + upload + prop write).
        let snapshot = self.build_edgeless_snapshot(bmap).await;
        // An empty structural surface is normal in page mode; other canvas
        // objects actually emit a placeholder and must report that omission.
        if snapshot.is_empty_placeholder() && flavour != "myoxus:surface" {
          *self.diagnostics.entry("missing_canvas_snapshot").or_default() += 1;
        }
        match flavour.as_str() {
          // The page editor keeps a structural surface block next to normal
          // note/page content. Without captured snapshot props that block is
          // not user-authored canvas content and must not leak a placeholder
          // into every page export.
          "myoxus:surface" if snapshot.is_empty_placeholder() => Ok(Block::Unknown {
            flavour: "myoxus:surface".to_string(),
            text_fallback: Some(Vec::new()),
          }),
          "myoxus:surface-ref" => Ok(Block::SurfaceRef(snapshot)),
          "myoxus:frame" => Ok(Block::Frame(snapshot)),
          "myoxus:mindmap" | "affine:mindmap" => Ok(Block::Mindmap(snapshot)),
          _ => Ok(Block::Surface(snapshot)),
        }
      }

      "myoxus:ai-chat" | "affine:ai-chat" => {
        let messages = self.build_ai_chat_messages(bmap, all_blocks).await;
        Ok(Block::AiChat { messages })
      }

      other => {
        *self.diagnostics.entry("unsupported_block").or_default() += 1;
        debug!(flavour = other, "unknown block flavour — using fallback");
        let text_fallback = Some(get_text_content(bmap, self.txn, "text"));
        Ok(Block::Unknown {
          flavour: other.to_string(),
          text_fallback,
        })
      }
    }
  }

  async fn resolve_image(&mut self, blob_id: &str) -> Option<AssetData> {
    match self.asset_resolver.resolve(blob_id).await {
      Ok(data) => {
        self.assets.insert(blob_id.to_string(), data.clone());
        Some(data)
      }
      Err(e) => {
        *self.diagnostics.entry("missing_asset").or_default() += 1;
        warn!(blob_id, error = %e, "failed to resolve image blob");
        None
      }
    }
  }

  /// Read the edgeless export-snapshot props off a surface/surface-ref/frame/
  /// mindmap block and produce an [`EdgelessSnapshot`]. Falls back to the
  /// empty placeholder when any of the three contract props is missing or
  /// the blob fails to resolve. Width/height come straight from the editor's
  /// captured-canvas dimensions; the renderer does not re-decode the PNG to
  /// recover them.
  async fn build_edgeless_snapshot(&mut self, bmap: &yrs::MapRef) -> EdgelessSnapshot {
    let blob_id = get_prop_string(bmap, self.txn, "exportSnapshotBlobId").unwrap_or_default();
    let width_px = get_prop_u64(bmap, self.txn, "exportSnapshotWidth").unwrap_or(0) as u32;
    let height_px = get_prop_u64(bmap, self.txn, "exportSnapshotHeight").unwrap_or(0) as u32;

    if blob_id.is_empty() || width_px == 0 || height_px == 0 {
      return EdgelessSnapshot {
        png_bytes: Vec::new(),
        width_px: 0,
        height_px: 0,
        caption: None,
      };
    }

    match self.asset_resolver.resolve(&blob_id).await {
      Ok(asset) => {
        // Cache the bytes inside the IR's asset map so re-renders or
        // multi-pass walks don't re-fetch the same blob. The renderer
        // (typst_engine) reads `EdgelessSnapshot.png_bytes` directly, so
        // the assets entry is informational/dedup-friendly here, not load-
        // bearing for the render pipeline.
        self.assets.insert(blob_id.clone(), asset.clone());
        EdgelessSnapshot {
          png_bytes: asset.bytes,
          width_px,
          height_px,
          caption: None,
        }
      }
      Err(e) => {
        warn!(
          blob_id,
          width_px,
          height_px,
          error = %e,
          "failed to resolve edgeless snapshot blob — falling back to placeholder"
        );
        EdgelessSnapshot {
          png_bytes: Vec::new(),
          width_px: 0,
          height_px: 0,
          caption: None,
        }
      }
    }
  }

  async fn build_table_rows(
    &mut self,
    bmap: &yrs::MapRef,
    all_blocks: &HashMap<String, yrs::MapRef>,
  ) -> Result<(Vec<TableRow>, Option<Vec<f64>>), IrBuildError> {
    let (flat_rows, widths) = self.build_flat_table_rows(bmap)?;
    if !flat_rows.is_empty() {
      return Ok((flat_rows, widths));
    }

    // Simple table: rows stored in children order, cells in their children order.
    let row_ids = get_children_ids(bmap, self.txn);
    let mut rows = Vec::new();
    for row_id in &row_ids {
      let Some(row_map) = all_blocks.get(row_id) else {
        continue;
      };
      let cell_ids = get_children_ids(row_map, self.txn);
      let is_header = get_prop_string(row_map, self.txn, "type").as_deref() == Some("tableHeaderRow");
      let mut cells = Vec::new();
      for cell_id in &cell_ids {
        let Some(cell_map) = all_blocks.get(cell_id) else {
          continue;
        };
        let content = get_text_content(cell_map, self.txn, "text");
        cells.push(TableCell {
          content,
          is_header,
          col_span: 1,
          row_span: 1,
          align: get_prop_string(cell_map, self.txn, "align"),
          fill: None,
          foreground: None,
        });
      }
      rows.push(TableRow { cells });
    }
    Ok((rows, None))
  }

  fn build_flat_table_rows(&self, bmap: &yrs::MapRef) -> Result<(Vec<TableRow>, Option<Vec<f64>>), IrBuildError> {
    #[derive(Default)]
    struct OrderedEntry {
      id: String,
      order: String,
      width: Option<f64>,
      has_width: bool,
    }

    fn split_flat_key<'k>(key: &'k str, prefix: &str) -> Option<(&'k str, &'k str)> {
      let rest = key.strip_prefix(prefix)?;
      rest.rsplit_once('.')
    }

    let mut rows: HashMap<String, OrderedEntry> = HashMap::new();
    let mut columns: HashMap<String, OrderedEntry> = HashMap::new();

    for (key, val) in bmap.iter(self.txn) {
      if let Some((row_id, field)) = split_flat_key(key, "prop:rows.") {
        let entry = rows.entry(row_id.to_string()).or_insert_with(|| OrderedEntry {
          id: row_id.to_string(),
          order: String::new(),
          ..Default::default()
        });
        match field {
          "rowId" => {
            if let Some(value) = value_to_string(&val) {
              entry.id = value;
            }
          }
          "order" => {
            if let Some(value) = value_to_string(&val) {
              entry.order = value;
            }
          }
          _ => {}
        }
      } else if let Some((column_id, field)) = split_flat_key(key, "prop:columns.") {
        let entry = columns.entry(column_id.to_string()).or_insert_with(|| OrderedEntry {
          id: column_id.to_string(),
          order: String::new(),
          ..Default::default()
        });
        match field {
          "columnId" => {
            if let Some(value) = value_to_string(&val) {
              entry.id = value;
            }
          }
          "width" => {
            entry.has_width = true;
            entry.width = match val {
              Out::Any(Any::Number(width)) => width.as_f64().filter(|width| width.is_finite() && *width > 0.0),
              _ => None,
            };
          }
          "order" => {
            if let Some(value) = value_to_string(&val) {
              entry.order = value;
            }
          }
          _ => {}
        }
      }
    }

    if rows.is_empty() || columns.is_empty() {
      return Ok((Vec::new(), None));
    }

    let mut rows: Vec<_> = rows.into_values().collect();
    let mut columns: Vec<_> = columns.into_values().collect();
    rows.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    columns.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    // Match native DefaultColumnWidth=120 only when at least one width is authored.
    let widths = columns
      .iter()
      .any(|column| column.has_width)
      .then(|| columns.iter().map(|column| column.width.unwrap_or(120.0)).collect());

    let rows = rows
      .into_iter()
      .map(|row| {
        let cells = columns
          .iter()
          .map(|column| {
            let text_key = format!("prop:cells.{}:{}.text", row.id, column.id);
            let content = get_text_content_at_key(bmap, self.txn, &text_key);
            // Flat tables persist alignment on the column, not on individual cells.
            let align_key = format!("prop:columns.{}.textAlign", column.id);
            let align = bmap
              .get(self.txn, &align_key)
              .and_then(|value| value_to_string(&value))
              .filter(|value| matches!(value.as_str(), "left" | "center" | "right"));
            // Match the native renderer: cell overrides column, which overrides row.
            let paint = self.resolve_table_paint(bmap, &row.id, &column.id)?;
            Ok(TableCell {
              content,
              is_header: false,
              col_span: 1,
              row_span: 1,
              align,
              fill: paint.as_ref().map(|paint| paint.fill.clone()),
              foreground: paint.map(|paint| paint.foreground),
            })
          })
          .collect::<Result<Vec<_>, IrBuildError>>()?;
        Ok(TableRow { cells })
      })
      .collect::<Result<Vec<_>, IrBuildError>>()?;
    Ok((rows, widths))
  }

  fn resolve_table_paint(
    &self,
    bmap: &yrs::MapRef,
    row: &str,
    column: &str,
  ) -> Result<Option<NativeTablePaint>, IrBuildError> {
    // Jobs dispatched before palette capture retain their original colourless projection.
    let Some(palette) = self.table_palette else {
      return Ok(None);
    };
    let value = [
      format!("prop:cells.{row}:{column}.backgroundColor"),
      format!("prop:columns.{column}.backgroundColor"),
      format!("prop:rows.{row}.backgroundColor"),
    ]
    .into_iter()
    .find_map(|key| {
      bmap
        .get(self.txn, &key)
        .filter(|value| !matches!(value, Out::Any(Any::Null | Any::Undefined)))
    });
    let Some(value) = value else { return Ok(None) };
    let Out::Any(Any::String(value)) = value else {
      return Err(IrBuildError::InvalidTablePaint);
    };
    let source = value.trim();
    let reference = source
      .strip_prefix("var(")
      .and_then(|v| v.strip_suffix(')'))
      .map(str::trim)
      .unwrap_or(source);
    let opaque_hex = |value: &str| {
      value.len() == 7 && value.starts_with('#') && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    };
    if let Some(paint) = palette.get(reference) {
      if opaque_hex(&paint.fill) && opaque_hex(&paint.foreground) {
        return Ok(Some(paint.clone()));
      }
      return Err(IrBuildError::InvalidTablePaint);
    }
    // HTML import has already normalized admitted RGB(A) declarations into hex.
    // Parse concrete native hex with Typst's existing parser; no CSS is evaluated.
    if !source.starts_with('#') {
      return Err(IrBuildError::InvalidTablePaint);
    }
    let color = source
      .parse::<typst::visualize::Color>()
      .map_err(|_| IrBuildError::InvalidTablePaint)?;
    let [mut r, mut g, mut b, a] = color.to_vec4();
    if a < 1.0 {
      let canvas = self
        .table_canvas
        .as_deref()
        .filter(|v| opaque_hex(v))
        .ok_or(IrBuildError::InvalidTablePaint)?;
      let canvas = canvas
        .parse::<typst::visualize::Color>()
        .map_err(|_| IrBuildError::InvalidTablePaint)?
        .to_vec4();
      r = r * a + canvas[0] * (1.0 - a);
      g = g * a + canvas[1] * (1.0 - a);
      b = b * a + canvas[2] * (1.0 - a);
    }
    let fill = format!(
      "#{:02x}{:02x}{:02x}",
      (r * 255.0).round() as u8,
      (g * 255.0).round() as u8,
      (b * 255.0).round() as u8
    );
    let foreground = myoxus_domain::color::adaptive_foreground(&fill).to_owned();
    Ok(Some(NativeTablePaint { fill, foreground }))
  }

  async fn build_database(
    &mut self,
    bmap: &yrs::MapRef,
    all_blocks: &HashMap<String, yrs::MapRef>,
  ) -> DatabaseTableView {
    // Extract columns from `prop:columns` / `columns` JSON array if present.
    let columns_json = get_prop_json(bmap, self.txn, "columns").or_else(|| get_prop_json(bmap, self.txn, "schema"));

    let columns: Vec<DatabaseColumn> = columns_json
      .and_then(|v| serde_json::from_value::<Vec<serde_json::Value>>(v).ok())
      .unwrap_or_default()
      .into_iter()
      .map(|col| DatabaseColumn {
        name: col.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        data_type: col.get("type").and_then(|v| v.as_str()).unwrap_or("text").to_string(),
      })
      .collect();

    // Rows = children of the database block, each being a database row.
    let row_ids = get_children_ids(bmap, self.txn);
    let mut rows = Vec::new();
    for row_id in &row_ids {
      let Some(row_map) = all_blocks.get(row_id) else {
        continue;
      };
      let cells: Vec<RichText> = columns
        .iter()
        .map(|col| {
          let text = get_prop_string(row_map, self.txn, &col.name).unwrap_or_default();
          vec![InlineSpan::Text {
            text,
            marks: TextMarks::default(),
          }]
        })
        .collect();
      rows.push(cells);
    }

    DatabaseTableView { columns, rows }
  }

  async fn build_ai_chat_messages(
    &mut self,
    bmap: &yrs::MapRef,
    _all_blocks: &HashMap<String, yrs::MapRef>,
  ) -> Vec<AiChatMessage> {
    // AI chat messages are stored as JSON in `prop:messages`.
    let messages_json = get_prop_json(bmap, self.txn, "messages");
    let Some(json) = messages_json else { return Vec::new() };
    let Ok(msgs) = serde_json::from_value::<Vec<serde_json::Value>>(json) else {
      return Vec::new();
    };
    msgs
      .into_iter()
      .map(|msg| {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user").to_string();
        let text = msg.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
        AiChatMessage {
          role,
          content: vec![InlineSpan::Text {
            text,
            marks: TextMarks::default(),
          }],
        }
      })
      .collect()
  }
}

// ─── Yjs field accessors ─────────────────────────────────────────────────────

/// Returns the block flavour, trying `sys:flavour` first then `flavour`.
fn get_flavour(bmap: &yrs::MapRef, txn: &yrs::Transaction<'_>) -> Option<String> {
  get_any_string(bmap, txn, "sys:flavour").or_else(|| get_any_string(bmap, txn, "flavour"))
}

/// Returns the list of children block IDs, trying `sys:children` then `children`.
fn get_children_ids(bmap: &yrs::MapRef, txn: &yrs::Transaction<'_>) -> Vec<String> {
  let try_key = |key: &str| -> Option<Vec<String>> {
    match bmap.get(txn, key) {
      Some(Out::YArray(arr)) => {
        let ids: Vec<String> = arr
          .iter(txn)
          .filter_map(|v| match v {
            Out::Any(Any::String(s)) => Some(s.to_string()),
            _ => None,
          })
          .collect();
        Some(ids)
      }
      Some(Out::Any(Any::Array(arr))) => {
        let ids: Vec<String> = arr
          .iter()
          .filter_map(|v| match v {
            Any::String(s) => Some(s.to_string()),
            _ => None,
          })
          .collect();
        Some(ids)
      }
      _ => None,
    }
  };
  try_key("sys:children")
    .or_else(|| try_key("children"))
    .unwrap_or_default()
}

/// Returns a text prop value, trying `prop:{key}` then via `props` sub-map.
fn get_prop_string(bmap: &yrs::MapRef, txn: &yrs::Transaction<'_>, key: &str) -> Option<String> {
  let prefixed = format!("prop:{key}");
  get_any_string(bmap, txn, &prefixed).or_else(|| {
    // Try via "props" sub-map.
    bmap.get(txn, "props").and_then(|v| match v {
      Out::YMap(props) => get_any_string(&props, txn, key),
      _ => None,
    })
  })
}

fn get_prop_bool(bmap: &yrs::MapRef, txn: &yrs::Transaction<'_>, key: &str) -> Option<bool> {
  let prefixed = format!("prop:{key}");
  bmap
    .get(txn, &prefixed)
    .or_else(|| {
      bmap.get(txn, "props").and_then(|v| match v {
        Out::YMap(props) => props.get(txn, key),
        _ => None,
      })
    })
    .and_then(|v| match v {
      Out::Any(Any::Bool(b)) => Some(b),
      Out::Any(Any::String(s)) => match s.as_ref() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
      },
      _ => None,
    })
}

fn get_prop_f64(bmap: &yrs::MapRef, txn: &yrs::Transaction<'_>, key: &str) -> Option<f64> {
  let prefixed = format!("prop:{key}");
  bmap
    .get(txn, &prefixed)
    .or_else(|| {
      bmap.get(txn, "props").and_then(|v| match v {
        Out::YMap(props) => props.get(txn, key),
        _ => None,
      })
    })
    .and_then(|v| match v {
      Out::Any(Any::Number(n)) => n.as_f64(),
      Out::Any(Any::BigInt(i)) => Some(i as f64),
      _ => None,
    })
}

fn get_prop_u64(bmap: &yrs::MapRef, txn: &yrs::Transaction<'_>, key: &str) -> Option<u64> {
  get_prop_f64(bmap, txn, key).map(|n| n as u64)
}

/// Preserve the difference between a missing legacy property and explicit
/// zero. Malformed explicit input is normalized to zero at this boundary.
fn get_prop_header_rows(bmap: &yrs::MapRef, txn: &yrs::Transaction<'_>) -> Option<usize> {
  let prefixed = "prop:headerRows";
  bmap
    .get(txn, prefixed)
    .or_else(|| {
      bmap.get(txn, "props").and_then(|value| match value {
        Out::YMap(props) => props.get(txn, "headerRows"),
        _ => None,
      })
    })
    .map(|value| match value {
      Out::Any(Any::BigInt(value)) => usize::try_from(value).unwrap_or(0),
      Out::Any(Any::Number(value)) => value
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.trunc() as usize)
        .unwrap_or(0),
      _ => 0,
    })
}

fn get_prop_json(bmap: &yrs::MapRef, txn: &yrs::Transaction<'_>, key: &str) -> Option<serde_json::Value> {
  let prefixed = format!("prop:{key}");
  bmap
    .get(txn, &prefixed)
    .or_else(|| bmap.get(txn, key))
    .and_then(|v| match v {
      Out::Any(Any::String(s)) => serde_json::from_str(&s).ok(),
      Out::Any(any) => {
        // Convert yrs::Any to serde_json::Value
        let json_str = format!("{:?}", any); // rough fallback
        drop(json_str);
        None
      }
      _ => None,
    })
}

fn get_any_string(bmap: &yrs::MapRef, txn: &yrs::Transaction<'_>, key: &str) -> Option<String> {
  bmap.get(txn, key).and_then(|v| match v {
    Out::Any(Any::String(s)) => Some(s.to_string()),
    _ => None,
  })
}

fn value_to_string(value: &Out) -> Option<String> {
  match value {
    Out::Any(Any::String(s)) => Some(s.to_string()),
    Out::Any(Any::Number(n)) => Some(n.to_string()),
    Out::Any(Any::BigInt(i)) => Some(i.to_string()),
    _ => None,
  }
}

// ─── Y.Text → RichText (Delta) ───────────────────────────────────────────────

/// Read a Y.Text as rich text (InlineSpan vec), trying `prop:{key}` first then `{key}`.
fn get_text_content(bmap: &yrs::MapRef, txn: &yrs::Transaction<'_>, key: &str) -> Vec<InlineSpan> {
  let prefixed = format!("prop:{key}");
  let text_ref = bmap.get(txn, &prefixed).or_else(|| bmap.get(txn, key));
  match text_ref {
    Some(Out::YText(text)) => parse_ytext_delta(&text, txn),
    _ => Vec::new(),
  }
}

fn get_text_content_at_key(bmap: &yrs::MapRef, txn: &yrs::Transaction<'_>, key: &str) -> Vec<InlineSpan> {
  match bmap.get(txn, key) {
    Some(Out::YText(text)) => parse_ytext_delta(&text, txn),
    _ => Vec::new(),
  }
}

/// Read a Y.Text as plain string (no delta marks), for code blocks.
fn get_text_plain(bmap: &yrs::MapRef, txn: &yrs::Transaction<'_>, key: &str) -> String {
  let prefixed = format!("prop:{key}");
  let text_ref = bmap.get(txn, &prefixed).or_else(|| bmap.get(txn, key));
  match text_ref {
    Some(Out::YText(text)) => text.get_string(txn),
    _ => String::new(),
  }
}

/// Parse a Y.Text delta into a Vec<InlineSpan>.
///
/// Each chunk has a string insert and an optional attribute map. Embed
/// inlines (reference, mention, footnote, inline-latex) use a single trigger
/// character (`REFERENCE_NODE = " "`)
/// carrying the embed payload in attributes — the parser detects those
/// payloads first and produces the matching [`InlineSpan`] embed variant
/// before falling back to a plain [`InlineSpan::Text`] span with marks.
fn parse_ytext_delta(text: &yrs::TextRef, txn: &yrs::Transaction<'_>) -> Vec<InlineSpan> {
  let diff = text.diff(txn, yrs::types::text::YChange::identity);
  diff
    .into_iter()
    .filter(|chunk| yjs::annotation::annotation_id(chunk.attributes.as_deref()).is_none())
    .flat_map(|chunk| match chunk.insert {
      yrs::Out::Any(Any::String(s)) => {
        let local = chunk.attributes.as_deref().and_then(|attrs| attrs.get("footnote"))
          .is_some_and(|value| matches!(value, Any::Map(map) if map.contains_key("definitionId") && !map.contains_key("reference")));
        let count = if local { s.chars().count() } else { 1 };
        std::iter::repeat_n(span_from_chunk(s.to_string(), chunk.attributes.as_deref()), count).collect::<Vec<_>>()
      },
      _ => Vec::new(),
    })
    .collect()
}

/// Convert one delta chunk (text + attrs) into an [`InlineSpan`].
///
/// Attribute precedence (matches Virgultum's inline-spec match order in
/// `editor/inlines/{latex,reference,mention,footnote}/src/inline-spec.ts`):
///   1. `latex` (string)        → `InlineSpan::Latex`
///   2. `reference` (object)    → `InlineSpan::Reference`
///   3. `mention` (object)      → `InlineSpan::Mention`
///   4. `footnote` (object)     → `InlineSpan::Footnote`
///   5. `link: "doc:<id>"`      → `InlineSpan::Reference` (legacy compat)
///   6. plain text + text marks → `InlineSpan::Text`
fn span_from_chunk(text: String, attrs: Option<&yrs::types::Attrs>) -> InlineSpan {
  if let Some(attrs) = attrs
    && let Some(span) = embed_span_from_attrs(attrs)
  {
    return span;
  }
  let marks = parse_attrs(attrs);
  build_inline_span(text, marks)
}

/// Try to extract an embed [`InlineSpan`] (latex/reference/mention/footnote)
/// from delta attributes. Returns `None` if no embed payload is present.
fn embed_span_from_attrs(attrs: &yrs::types::Attrs) -> Option<InlineSpan> {
  if let Some(Any::String(s)) = attrs.get("latex")
    && !s.is_empty()
  {
    return Some(InlineSpan::Latex { source: s.to_string() });
  }

  if let Some(Any::Map(map)) = attrs.get("reference") {
    let doc_id = map
      .get("pageId")
      .and_then(any_to_string)
      .or_else(|| map.get("docId").and_then(any_to_string))
      .unwrap_or_default();
    if !doc_id.is_empty() {
      let title = map.get("title").and_then(any_to_string);
      return Some(InlineSpan::Reference { doc_id, title });
    }
  }

  if let Some(Any::Map(map)) = attrs.get("mention") {
    let member = map.get("member").and_then(any_to_string).unwrap_or_default();
    if !member.is_empty() {
      let display_name = map.get("displayName").and_then(any_to_string);
      return Some(InlineSpan::Mention {
        user_id: member,
        display_name,
      });
    }
  }

  if let Some(Any::Map(map)) = attrs.get("footnote") {
    let label = map.get("label").and_then(any_to_string).unwrap_or_default();
    if map.contains_key("definitionId") {
      // A malformed/mixed local target must fail binding, never become a
      // legacy citation or a plain label that conceals an invalid reference.
      let definition_id = if map.contains_key("reference") {
        String::new()
      } else {
        map.get("definitionId").and_then(any_to_string).unwrap_or_default()
      };
      return Some(InlineSpan::LocalFootnote {
        definition_id,
        placement: yjs::footnote::FootnotePlacement::Footnote,
        number: None,
        reference_index: 0,
        references: 0,
        locale: String::new(),
        body: None,
      });
    }
    let content = if label.is_empty() {
      Vec::new()
    } else {
      vec![InlineSpan::Text {
        text: label,
        marks: TextMarks::default(),
      }]
    };
    return Some(InlineSpan::Footnote { content });
  }

  None
}

fn build_inline_span(text: String, marks: TextMarks) -> InlineSpan {
  // Legacy compatibility: pre-embed snapshots encoded a doc reference as
  // `link: "doc:<id>"` instead of a structured `reference` attr. Keep the
  // hack working so old snapshots still resolve to a Reference span.
  if let Some(href) = &marks.link
    && href.starts_with("doc:")
  {
    let doc_id = href.strip_prefix("doc:").unwrap_or("").to_string();
    return InlineSpan::Reference {
      doc_id,
      title: Some(text),
    };
  }
  InlineSpan::Text { text, marks }
}

fn parse_attrs(attrs: Option<&yrs::types::Attrs>) -> TextMarks {
  let Some(attrs) = attrs else {
    return TextMarks::default();
  };
  let mut marks = TextMarks::default();
  for (key, val) in attrs.iter() {
    match key.as_ref() {
      "bold" => marks.bold = to_bool(val),
      "italic" => marks.italic = to_bool(val),
      "underline" => marks.underline = to_bool(val),
      "strike" | "strikethrough" => marks.strike = to_bool(val),
      "code" | "inline-code" => marks.code = to_bool(val),
      "color" => marks.color = to_str(val),
      "background" | "highlight" => marks.background = to_str(val),
      "link" => marks.link = to_str(val),
      _ => {}
    }
  }
  marks
}

fn any_to_string(val: &Any) -> Option<String> {
  match val {
    Any::String(s) if !s.is_empty() => Some(s.to_string()),
    _ => None,
  }
}

fn to_bool(val: &Any) -> Option<bool> {
  match val {
    Any::Bool(b) => Some(*b),
    Any::String(s) => match s.as_ref() {
      "true" => Some(true),
      "false" | "" => Some(false),
      _ => None,
    },
    _ => None,
  }
}

fn to_str(val: &Any) -> Option<String> {
  match val {
    Any::String(s) if !s.is_empty() => Some(s.to_string()),
    _ => None,
  }
}
