// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariant: legacy `affine:*` and canonical `myoxus:*` Yjs snapshots
//! produce **identical** IR trees.
//!
//! Regression guard for LRN-20260427-PDF-INV — after commit 4c384b1d05 the
//! Yjs save path normalises `sys:flavour` to `myoxus:*`. The PDF export
//! builder must accept both forms so old snapshots and new snapshots both
//! render correctly.

use uuid::Uuid;
use yrs::{Array, ArrayPrelim, Doc, Map, MapPrelim, TextPrelim, Transact};

use myoxus_pdf_export::builder::{NullAssetResolver, YjsIrBuilder};
use myoxus_pdf_export::ir::inline::InlineSpan;
use myoxus_pdf_export::ir::{Branding, DocumentMetadata, ExportOptions, block::Block};

fn metadata() -> DocumentMetadata {
  DocumentMetadata {
    doc_id: Uuid::new_v4(),
    workspace_id: Uuid::new_v4(),
    title: Some("Alias Test".into()),
    author: None,
    created_at: None,
    updated_at: None,
    workspace_name: None,
    branding: Branding::default(),
  }
}

/// Build a minimal Yjs v1 update containing one page block with one paragraph
/// child, using the given flavour prefix (`affine` or `myoxus`).
fn build_snapshot(prefix: &str) -> Vec<u8> {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut tx = doc.transact_mut();

  // Page block.
  let page = blocks.insert(&mut tx, "page-1", MapPrelim::default());
  page.insert(&mut tx, "sys:flavour", format!("{prefix}:page"));
  let page_children = page.insert(&mut tx, "sys:children", ArrayPrelim::default());
  page_children.push_back(&mut tx, "para-1");
  page.insert(&mut tx, "prop:title", TextPrelim::new(""));

  // Paragraph child.
  let para = blocks.insert(&mut tx, "para-1", MapPrelim::default());
  para.insert(&mut tx, "sys:flavour", format!("{prefix}:paragraph"));
  para.insert(&mut tx, "sys:children", ArrayPrelim::default());
  para.insert(&mut tx, "prop:text", TextPrelim::new("hello"));

  tx.encode_update_v1()
}

/// Invariant: `inv_pdf_export_flavour_alias` — builder produces the same
/// IR root structure (Page → Paragraph "hello") whether flavours are
/// `affine:*` or canonical `myoxus:*`.
#[tokio::test]
async fn inv_pdf_export_accepts_affine_and_myoxus_flavours() {
  let affine_bin = build_snapshot("affine");
  let myoxus_bin = build_snapshot("myoxus");

  let mut builder_a = YjsIrBuilder::new(NullAssetResolver);
  let mut builder_m = YjsIrBuilder::new(NullAssetResolver);

  let ir_affine = builder_a
    .build(&affine_bin, metadata(), ExportOptions::default())
    .await
    .expect("affine: snapshot must build");
  let ir_myoxus = builder_m
    .build(&myoxus_bin, metadata(), ExportOptions::default())
    .await
    .expect("myoxus: snapshot must build");

  for (label, ir) in [("affine", &ir_affine), ("myoxus", &ir_myoxus)] {
    let Block::Page { children, .. } = &ir.root else {
      panic!("{label}: expected Page root, got {:?}", ir.root);
    };
    assert_eq!(children.len(), 1, "{label}: page must have one child");
    let Block::Paragraph { content, .. } = &children[0] else {
      panic!("{label}: expected Paragraph, got {:?}", &children[0]);
    };
    let joined: String = content
      .iter()
      .map(|span| match span {
        InlineSpan::Text { text, .. } => text.clone(),
        _ => String::new(),
      })
      .collect();
    assert_eq!(joined, "hello", "{label}: paragraph text mismatch");
  }
}

/// Invariant: `Block::flavour_name()` reports the canonical `myoxus:*`
/// form for every variant — never the legacy `affine:*` form. The IR is
/// always normalized; if a logger or admin probe surfaces an `affine:*`
/// string from this method it would be a regression of the rebrand
/// contract (see `feedback_eliminate_affine_everywhere.md`).
#[test]
fn inv_flavour_name_is_canonical_myoxus_form() {
  use myoxus_pdf_export::ir::block::{
    AiChatMessage, BlobRef, Block, CalloutVariant, CodeBlock, DatabaseTableView, EdgelessSnapshot, EmbedCard,
    HeadingLevel, ImageRef, ListType, MermaidDiagram, TableRow,
  };

  let cases: Vec<(Block, &str)> = vec![
    (
      Block::Page {
        title: vec![],
        children: vec![],
      },
      "myoxus:page",
    ),
    (Block::Note { children: vec![] }, "myoxus:note"),
    (
      Block::EdgelessText {
        content: vec![],
        children: vec![],
      },
      "myoxus:edgeless-text",
    ),
    (
      Block::Paragraph {
        content: vec![],
        children: vec![],
      },
      "myoxus:paragraph/text",
    ),
    (
      Block::Quote {
        content: vec![],
        children: vec![],
      },
      "myoxus:paragraph/quote",
    ),
    (
      Block::Heading {
        level: HeadingLevel::H2,
        content: vec![],
        children: vec![],
      },
      "myoxus:paragraph/heading",
    ),
    (
      Block::List {
        list_type: ListType::Bulleted,
        content: vec![],
        checked: false,
        children: vec![],
      },
      "myoxus:list",
    ),
    (
      Block::Code(CodeBlock {
        language: None,
        code: String::new(),
        caption: None,
      }),
      "myoxus:code",
    ),
    (
      Block::Mermaid(MermaidDiagram {
        source: String::new(),
        title: None,
        caption: None,
      }),
      "myoxus:mermaid",
    ),
    (Block::Divider, "myoxus:divider"),
    (
      Block::Callout {
        variant: CalloutVariant::Info,
        emoji: None,
        content: vec![],
        children: vec![],
      },
      "myoxus:callout",
    ),
    (Block::LatexBlock { source: String::new() }, "myoxus:latex"),
    (
      Block::Image(ImageRef {
        blob: BlobRef {
          blob_id: String::new(),
          mime_hint: None,
        },
        caption: None,
        width_hint: None,
        height_hint: None,
        data: None,
      }),
      "myoxus:image",
    ),
    (
      Block::Attachment {
        blob: BlobRef {
          blob_id: String::new(),
          mime_hint: None,
        },
        name: None,
        size_bytes: None,
        mime: None,
      },
      "myoxus:attachment",
    ),
    (
      Block::Bookmark(EmbedCard {
        url: String::new(),
        title: None,
        description: None,
        favicon: None,
        embed_kind: String::new(),
      }),
      "myoxus:bookmark",
    ),
    (
      Block::Embed(EmbedCard {
        url: String::new(),
        title: None,
        description: None,
        favicon: None,
        embed_kind: String::new(),
      }),
      "myoxus:embed",
    ),
    (
      Block::Table {
        rows: Vec::<TableRow>::new(),
        caption: None,
        column_widths: None,
        header_rows: None,
        appearance: None,
        density: None,
      },
      "myoxus:table",
    ),
    (
      Block::Database(DatabaseTableView {
        columns: vec![],
        rows: vec![],
      }),
      "myoxus:database",
    ),
    (
      Block::Surface(EdgelessSnapshot {
        png_bytes: vec![],
        width_px: 0,
        height_px: 0,
        caption: None,
      }),
      "myoxus:surface",
    ),
    (
      Block::SurfaceRef(EdgelessSnapshot {
        png_bytes: vec![],
        width_px: 0,
        height_px: 0,
        caption: None,
      }),
      "myoxus:surface-ref",
    ),
    (
      Block::Frame(EdgelessSnapshot {
        png_bytes: vec![],
        width_px: 0,
        height_px: 0,
        caption: None,
      }),
      "myoxus:frame",
    ),
    (
      Block::Mindmap(EdgelessSnapshot {
        png_bytes: vec![],
        width_px: 0,
        height_px: 0,
        caption: None,
      }),
      "myoxus:mindmap",
    ),
    (
      Block::AiChat {
        messages: Vec::<AiChatMessage>::new(),
      },
      "myoxus:ai-chat",
    ),
  ];

  for (block, expected) in &cases {
    let got = block.flavour_name();
    assert_eq!(got, *expected, "variant {block:?} must report {expected}, got {got}");
    assert!(!got.starts_with("affine:"), "{got} leaked the legacy affine:* prefix");
  }

  // Unknown preserves the raw flavour as-stored — that's the only variant
  // where the original string is preserved (forward-compat).
  let unknown = Block::Unknown {
    flavour: "third-party:custom-block".to_string(),
    text_fallback: None,
  };
  assert_eq!(unknown.flavour_name(), "third-party:custom-block");
}
