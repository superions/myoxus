// SPDX-License-Identifier: AGPL-3.0-or-later
//! Per-block builder coverage for the IR Block-Scope (P3).
//!
//! Each test constructs a minimal Yjs snapshot containing a `myoxus:page`
//! root with one child block of the type under test, runs `YjsIrBuilder`,
//! and asserts the produced `Block` matches the expected variant.
//!
//! These tests are the regression net for the Block-IR-Scope: if the
//! builder ever drops a flavour or stops normalising props correctly,
//! the corresponding case here flips to `Block::Unknown` or the wrong
//! variant.

use std::collections::HashMap;

use uuid::Uuid;
use yrs::{Any, Array, ArrayPrelim, Doc, Map, MapPrelim, MapRef, Text, TextPrelim, Transact, TransactionMut};

use myoxus_pdf_export::builder::{NullAssetResolver, YjsIrBuilder};
use myoxus_pdf_export::ir::block::*;
use myoxus_pdf_export::ir::inline::{InlineSpan, TextMarks};
use myoxus_pdf_export::ir::{Branding, DocumentMetadata, ExportOptions, IrDocument};

// ─── Test harness ────────────────────────────────────────────────────────────

fn metadata() -> DocumentMetadata {
  DocumentMetadata {
    doc_id: Uuid::new_v4(),
    workspace_id: Uuid::new_v4(),
    title: Some("Block Coverage".into()),
    author: None,
    created_at: None,
    updated_at: None,
    workspace_name: None,
    branding: Branding::default(),
  }
}

/// Build a minimal Yjs v1 update containing a `myoxus:page` with one child.
/// The caller mutates the child block via `populate`.
fn build_with_child<F>(child_id: &str, child_flavour: &str, populate: F) -> Vec<u8>
where
  F: FnOnce(&mut TransactionMut<'_>, &MapRef),
{
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut tx = doc.transact_mut();

  let page = blocks.insert(&mut tx, "page-1", MapPrelim::default());
  page.insert(&mut tx, "sys:flavour", "myoxus:page");
  let page_children = page.insert(&mut tx, "sys:children", ArrayPrelim::default());
  page_children.push_back(&mut tx, child_id);

  let child = blocks.insert(&mut tx, child_id, MapPrelim::default());
  child.insert(&mut tx, "sys:flavour", child_flavour);
  child.insert(&mut tx, "sys:children", ArrayPrelim::default());
  populate(&mut tx, &child);

  tx.encode_update_v1()
}

async fn build_ir(binary: &[u8]) -> IrDocument {
  YjsIrBuilder::new(NullAssetResolver)
    .build(binary, metadata(), ExportOptions::default())
    .await
    .expect("build IR")
}

fn first_child(ir: &IrDocument) -> &Block {
  match &ir.root {
    Block::Page { children, .. } => {
      assert_eq!(children.len(), 1, "expected one child block");
      &children[0]
    }
    other => panic!("expected Page root, got {other:?}"),
  }
}

fn join_text(spans: &[InlineSpan]) -> String {
  spans
    .iter()
    .map(|s| match s {
      InlineSpan::Text { text, .. } => text.clone(),
      _ => String::new(),
    })
    .collect()
}

// ─── Heading levels (h1..h6) ─────────────────────────────────────────────────

#[tokio::test]
async fn block_heading_h1_through_h6() {
  for level in ["h1", "h2", "h3", "h4", "h5", "h6"] {
    let bin = build_with_child("h", "myoxus:paragraph", |tx, c| {
      c.insert(tx, "prop:type", level);
      c.insert(tx, "prop:text", TextPrelim::new(level));
    });
    let ir = build_ir(&bin).await;
    match first_child(&ir) {
      Block::Heading {
        level: lvl, content, ..
      } => {
        let expected = match level {
          "h1" => HeadingLevel::H1,
          "h2" => HeadingLevel::H2,
          "h3" => HeadingLevel::H3,
          "h4" => HeadingLevel::H4,
          "h5" => HeadingLevel::H5,
          "h6" => HeadingLevel::H6,
          _ => unreachable!(),
        };
        assert_eq!(*lvl, expected, "heading level mismatch for {level}");
        assert_eq!(join_text(content), level);
      }
      other => panic!("{level}: expected Heading, got {other:?}"),
    }
  }
}

#[tokio::test]
async fn block_quote() {
  let bin = build_with_child("q", "myoxus:paragraph", |tx, c| {
    c.insert(tx, "prop:type", "quote");
    c.insert(tx, "prop:text", TextPrelim::new("quoted"));
  });
  let ir = build_ir(&bin).await;
  match first_child(&ir) {
    Block::Quote { content, .. } => assert_eq!(join_text(content), "quoted"),
    other => panic!("expected Quote, got {other:?}"),
  }
}

// ─── List variants ───────────────────────────────────────────────────────────

#[tokio::test]
async fn block_list_all_four_types() {
  for (yjs_type, expected) in [
    ("bulleted", ListType::Bulleted),
    ("numbered", ListType::Numbered),
    ("todo", ListType::Todo),
    ("toggle", ListType::Toggle),
  ] {
    let bin = build_with_child("li", "myoxus:list", |tx, c| {
      c.insert(tx, "prop:type", yjs_type);
      c.insert(tx, "prop:text", TextPrelim::new("item"));
    });
    let ir = build_ir(&bin).await;
    match first_child(&ir) {
      Block::List { list_type, content, .. } => {
        assert_eq!(*list_type, expected, "list type mismatch for {yjs_type}");
        assert_eq!(join_text(content), "item");
      }
      other => panic!("{yjs_type}: expected List, got {other:?}"),
    }
  }
}

#[tokio::test]
async fn block_list_todo_checked_state() {
  let bin = build_with_child("li", "myoxus:list", |tx, c| {
    c.insert(tx, "prop:type", "todo");
    c.insert(tx, "prop:checked", true);
    c.insert(tx, "prop:text", TextPrelim::new("done"));
  });
  let ir = build_ir(&bin).await;
  match first_child(&ir) {
    Block::List { checked, .. } => assert!(*checked, "todo checked must be true"),
    other => panic!("expected List, got {other:?}"),
  }
}

// ─── Code ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn block_code_with_language() {
  let bin = build_with_child("c", "myoxus:code", |tx, c| {
    c.insert(tx, "prop:language", "rust");
    c.insert(tx, "prop:text", TextPrelim::new("fn main() {}"));
  });
  let ir = build_ir(&bin).await;
  match first_child(&ir) {
    Block::Code(code) => {
      assert_eq!(code.language.as_deref(), Some("rust"));
      assert_eq!(code.code, "fn main() {}");
    }
    other => panic!("expected Code, got {other:?}"),
  }
}

#[tokio::test]
async fn block_mermaid_is_first_class_pdf_ir() {
  let bin = build_with_child("m", "myoxus:mermaid", |tx, c| {
    c.insert(tx, "prop:source", TextPrelim::new("flowchart TD\n  A --> B"));
    c.insert(tx, "prop:title", TextPrelim::new("Process"));
    c.insert(tx, "prop:caption", "Visible process caption");
  });
  let ir = build_ir(&bin).await;
  match first_child(&ir) {
    Block::Mermaid(diagram) => {
      assert_eq!(diagram.source, "flowchart TD\n  A --> B");
      assert_eq!(join_text(diagram.title.as_deref().unwrap_or_default()), "Process");
      assert_eq!(
        join_text(diagram.caption.as_deref().unwrap_or_default()),
        "Visible process caption"
      );
    }
    other => panic!("expected Mermaid, got {other:?}"),
  }
}

// ─── Divider ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn block_divider() {
  let bin = build_with_child("d", "myoxus:divider", |_tx, _c| {});
  let ir = build_ir(&bin).await;
  assert!(matches!(first_child(&ir), Block::Divider), "expected Divider");
}

// ─── Callout variants ────────────────────────────────────────────────────────

#[tokio::test]
async fn block_callout_all_four_variants() {
  for (yjs_variant, expected) in [
    ("info", CalloutVariant::Info),
    ("warning", CalloutVariant::Warning),
    ("note", CalloutVariant::Note),
    ("tip", CalloutVariant::Tip),
  ] {
    let bin = build_with_child("co", "myoxus:callout", |tx, c| {
      c.insert(tx, "prop:type", yjs_variant);
      c.insert(tx, "prop:emoji", "💡");
      c.insert(tx, "prop:text", TextPrelim::new("note body"));
    });
    let ir = build_ir(&bin).await;
    match first_child(&ir) {
      Block::Callout {
        variant,
        emoji,
        content,
        ..
      } => {
        assert_eq!(*variant, expected, "callout variant mismatch for {yjs_variant}");
        assert_eq!(emoji.as_deref(), Some("💡"));
        assert_eq!(join_text(content), "note body");
      }
      other => panic!("{yjs_variant}: expected Callout, got {other:?}"),
    }
  }
}

#[tokio::test]
async fn folded_known_aliases_and_unknown_kinds_keep_custom_titles_and_reading_content() {
  for (kind, expected) in [
    ("CAUTION", CalloutVariant::Warning),
    ("hint", CalloutVariant::Tip),
    ("Research_Review", CalloutVariant::Note),
  ] {
    let bin = build_with_child("co", "myoxus:callout", |tx, c| {
      c.insert(tx, "prop:type", kind);
      c.insert(tx, "prop:foldable", true);
      c.insert(tx, "prop:defaultOpen", false);
      c.insert(tx, "prop:title", TextPrelim::new("Current approval"));
      c.insert(tx, "prop:text", TextPrelim::new("Visible body"));
    });
    let ir = build_ir(&bin).await;
    let Block::Callout { variant, content, .. } = first_child(&ir) else {
      panic!("folded typed callout")
    };
    assert_eq!(*variant, expected);
    assert_eq!(join_text(content), "Current approval\nVisible body");
  }
  let bin = build_with_child("co", "myoxus:callout", |tx, c| {
    c.insert(tx, "prop:type", "Research_Review");
    c.insert(tx, "prop:text", TextPrelim::new("Visible body"));
  });
  let ir = build_ir(&bin).await;
  let Block::Callout { content, .. } = first_child(&ir) else {
    panic!("unknown callout")
  };
  assert_eq!(join_text(content), "Research_Review\nVisible body");
}

// ─── LaTeX block ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn block_latex() {
  let bin = build_with_child("l", "myoxus:latex", |tx, c| {
    c.insert(tx, "prop:latex", "E = mc^2");
  });
  let ir = build_ir(&bin).await;
  match first_child(&ir) {
    Block::LatexBlock { source } => assert_eq!(source, "E = mc^2"),
    other => panic!("expected LatexBlock, got {other:?}"),
  }
}

// ─── Image ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn block_image_with_blob_id() {
  for (width, height, expected_width, expected_height) in
    [(320.0, 200.0, Some(320.0), Some(200.0)), (0.0, 0.0, None, None)]
  {
    let bin = build_with_child("i", "myoxus:image", |tx, c| {
      c.insert(tx, "prop:sourceId", "blob-abc");
      c.insert(tx, "prop:width", width);
      c.insert(tx, "prop:height", height);
      c.insert(tx, "prop:caption", "A retained image caption");
    });
    let ir = build_ir(&bin).await;
    match first_child(&ir) {
      Block::Image(img) => {
        assert_eq!(img.blob.blob_id, "blob-abc");
        assert_eq!(img.width_hint, expected_width, "editor zero means natural width");
        assert_eq!(img.height_hint, expected_height, "editor zero means natural height");
        assert_eq!(
          join_text(img.caption.as_deref().unwrap_or_default()),
          "A retained image caption"
        );
        assert!(img.data.is_none(), "NullAssetResolver must not populate image data");
      }
      other => panic!("expected Image, got {other:?}"),
    }
  }
}

// ─── Attachment ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn block_attachment() {
  let bin = build_with_child("att", "myoxus:attachment", |tx, c| {
    c.insert(tx, "prop:sourceId", "blob-att");
    c.insert(tx, "prop:name", "report.pdf");
    c.insert(tx, "prop:size", 4096.0_f64);
    c.insert(tx, "prop:type", "application/pdf");
  });
  let ir = build_ir(&bin).await;
  match first_child(&ir) {
    Block::Attachment {
      blob,
      name,
      size_bytes,
      mime,
    } => {
      assert_eq!(blob.blob_id, "blob-att");
      assert_eq!(name.as_deref(), Some("report.pdf"));
      assert_eq!(*size_bytes, Some(4096));
      assert_eq!(mime.as_deref(), Some("application/pdf"));
    }
    other => panic!("expected Attachment, got {other:?}"),
  }
}

// ─── Bookmark ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn block_bookmark() {
  let bin = build_with_child("bk", "myoxus:bookmark", |tx, c| {
    c.insert(tx, "prop:url", "https://example.com");
    c.insert(tx, "prop:title", "Example");
    c.insert(tx, "prop:description", "An example domain.");
  });
  let ir = build_ir(&bin).await;
  match first_child(&ir) {
    Block::Bookmark(card) => {
      assert_eq!(card.url, "https://example.com");
      assert_eq!(card.title.as_deref(), Some("Example"));
      assert_eq!(card.embed_kind, "bookmark");
    }
    other => panic!("expected Bookmark, got {other:?}"),
  }
}

// ─── Embed kinds ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn block_embed_kinds() {
  for kind in [
    "youtube",
    "github",
    "figma",
    "loom",
    "linked-doc",
    "synced-doc",
    "iframe",
    "html",
  ] {
    let flavour = format!("myoxus:embed-{kind}");
    let bin = build_with_child("em", &flavour, |tx, c| {
      c.insert(tx, "prop:url", format!("https://{kind}.test"));
      c.insert(tx, "prop:title", kind);
    });
    let ir = build_ir(&bin).await;
    match first_child(&ir) {
      Block::Embed(card) => {
        assert_eq!(card.embed_kind, kind, "embed_kind mismatch");
        assert_eq!(card.url, format!("https://{kind}.test"));
      }
      other => panic!("{kind}: expected Embed, got {other:?}"),
    }
  }
}

// ─── AI Chat ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn block_ai_chat_keeps_unknown_when_messages_missing() {
  // The builder's ai-chat path expects a structured messages array;
  // with no messages set, we should still get an AiChat with empty messages
  // (not Unknown).
  let bin = build_with_child("ai", "myoxus:ai-chat", |_tx, _c| {});
  let ir = build_ir(&bin).await;
  match first_child(&ir) {
    Block::AiChat { messages } => {
      assert!(messages.is_empty(), "no messages in fixture");
    }
    other => panic!("expected AiChat (empty), got {other:?}"),
  }
}

// ─── Edgeless surfaces ───────────────────────────────────────────────────────

#[tokio::test]
async fn structural_page_surface_without_snapshot_props_is_silent() {
  // Page-mode documents carry a structural `myoxus:surface` sibling even
  // when the user never exported an edgeless canvas. That structural block
  // must not render a `[Canvas snapshot not available]` placeholder into
  // every regular page PDF.
  let bin = build_with_child("s", "myoxus:surface", |_tx, _c| {});
  let ir = build_ir(&bin).await;
  assert!(
    matches!(
      first_child(&ir),
      Block::Unknown {
        flavour,
        text_fallback: Some(fallback)
      } if flavour == "myoxus:surface" && fallback.is_empty()
    ),
    "empty structural surface must be silent, got {:?}",
    first_child(&ir)
  );
}

#[tokio::test]
async fn embedded_surface_variants_produce_placeholder_snapshots() {
  // Explicit embedded canvas-like blocks still surface a placeholder when
  // snapshot props are missing: unlike the page's structural surface, these
  // blocks represent user-authored visual content.
  for (flavour, matcher) in [
    ("myoxus:surface-ref", "SurfaceRef" as &str),
    ("myoxus:frame", "Frame"),
    ("affine:mindmap", "Mindmap"), // mindmap has no canonical alias yet
  ] {
    let bin = build_with_child("s", flavour, |_tx, _c| {});
    let ir = build_ir(&bin).await;
    let snap = match first_child(&ir) {
      Block::Surface(s) | Block::SurfaceRef(s) | Block::Frame(s) | Block::Mindmap(s) => s,
      other => panic!("{flavour}: unexpected variant {other:?}"),
    };
    assert!(
      snap.is_empty_placeholder(),
      "{flavour}: expected empty placeholder when no export-snapshot props set, got {snap:?}"
    );
    let got = match first_child(&ir) {
      Block::Surface(_) => "Surface",
      Block::SurfaceRef(_) => "SurfaceRef",
      Block::Frame(_) => "Frame",
      Block::Mindmap(_) => "Mindmap",
      _ => unreachable!(),
    };
    assert_eq!(got, matcher, "{flavour}: surface variant mismatch");
  }
}

/// In-memory AssetResolver fixture used to exercise the edgeless-snapshot
/// blob-resolution path without standing up an opendal store. Maps blob_id
/// → bytes; missing keys raise `AssetError::BlobNotFound` (same shape as
/// `NullAssetResolver`).
struct StaticResolver(std::collections::HashMap<String, Vec<u8>>);

impl myoxus_pdf_export::builder::AssetResolver for StaticResolver {
  async fn resolve(&mut self, blob_id: &str) -> Result<AssetData, myoxus_pdf_export::error::AssetError> {
    self
      .0
      .get(blob_id)
      .map(|bytes| AssetData {
        mime: "image/png".into(),
        bytes: bytes.clone(),
        filename: None,
      })
      .ok_or_else(|| myoxus_pdf_export::error::AssetError::BlobNotFound {
        id: blob_id.to_string(),
      })
  }
}

/// Invariant: when a `myoxus:surface*` block carries the three
/// `prop:exportSnapshot*` props (blob id + width + height) and the resolver
/// returns bytes for the blob, the builder fills `EdgelessSnapshot` with
/// the resolved PNG bytes and the captured dimensions. Locks the
/// server-side leg of the #322 contract.
#[tokio::test]
async fn block_surface_with_export_snapshot_props_fills_snapshot() {
  // Tiny but valid PNG header + minimal payload. The renderer is not
  // invoked here; we only check the builder's prop → IR mapping.
  let png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef];
  let mut resolver_map = std::collections::HashMap::new();
  resolver_map.insert("blob-deadbeef".to_string(), png.clone());
  let resolver = StaticResolver(resolver_map);

  let bin = build_with_child("s", "myoxus:surface-ref", |tx, child| {
    child.insert(tx, "prop:exportSnapshotBlobId", "blob-deadbeef");
    child.insert(tx, "prop:exportSnapshotWidth", 1920_i64);
    child.insert(tx, "prop:exportSnapshotHeight", 1080_i64);
  });

  let ir = YjsIrBuilder::new(resolver)
    .build(&bin, metadata(), ExportOptions::default())
    .await
    .expect("build IR");

  let Block::SurfaceRef(snap) = first_child(&ir) else {
    panic!("expected SurfaceRef variant");
  };
  assert_eq!(snap.png_bytes, png, "snapshot bytes must come from the resolver");
  assert_eq!(snap.width_px, 1920);
  assert_eq!(snap.height_px, 1080);
  assert!(
    !snap.is_empty_placeholder(),
    "filled snapshot must not be a placeholder"
  );
  assert!(
    ir.assets.contains_key("blob-deadbeef"),
    "resolved snapshot bytes must also land in IrDocument.assets for dedup"
  );
}

/// Invariant: if the resolver fails to fetch the snapshot blob (e.g. blob
/// was deleted, storage error), the builder degrades to the empty
/// placeholder rather than aborting the whole IR build. The renderer
/// surfaces the placeholder text — the user-visible failure mode is one
/// missing canvas, not a failed export.
#[tokio::test]
async fn block_surface_with_unresolvable_snapshot_blob_falls_back_to_placeholder() {
  let resolver = StaticResolver(std::collections::HashMap::new()); // empty → BlobNotFound

  let bin = build_with_child("s", "myoxus:frame", |tx, child| {
    child.insert(tx, "prop:exportSnapshotBlobId", "missing-blob");
    child.insert(tx, "prop:exportSnapshotWidth", 800_i64);
    child.insert(tx, "prop:exportSnapshotHeight", 600_i64);
  });

  let ir = YjsIrBuilder::new(resolver)
    .build(&bin, metadata(), ExportOptions::default())
    .await
    .expect("build IR");

  let Block::Frame(snap) = first_child(&ir) else {
    panic!("expected Frame variant");
  };
  assert!(
    snap.is_empty_placeholder(),
    "unresolvable blob must degrade to placeholder, got {snap:?}"
  );
}

/// Invariant: a partial export-snapshot prop set (blob id present but
/// dimensions missing, or vice versa) does NOT trigger a resolver call —
/// the builder treats the block as unequipped and emits the empty
/// placeholder. Guards against the renderer trying to embed an image with
/// width/height = 0 which would produce a degenerate Typst page break.
#[tokio::test]
async fn block_surface_with_partial_export_snapshot_props_falls_back_to_placeholder() {
  // Only blob id, no dimensions.
  let mut resolver_map = std::collections::HashMap::new();
  resolver_map.insert("blob-x".to_string(), vec![0x89, b'P', b'N', b'G']);
  let resolver = StaticResolver(resolver_map);

  let bin = build_with_child("s", "myoxus:surface-ref", |tx, child| {
    child.insert(tx, "prop:exportSnapshotBlobId", "blob-x");
    // intentionally omit width + height
  });

  let ir = YjsIrBuilder::new(resolver)
    .build(&bin, metadata(), ExportOptions::default())
    .await
    .expect("build IR");

  let Block::SurfaceRef(snap) = first_child(&ir) else {
    panic!("expected SurfaceRef variant");
  };
  assert!(
    snap.is_empty_placeholder(),
    "partial props must degrade to placeholder, got {snap:?}"
  );
  // No resolver call means no asset entry either.
  assert!(
    !ir.assets.contains_key("blob-x"),
    "partial props must skip resolver — no asset entry expected"
  );
}

// ─── Unknown fallback ────────────────────────────────────────────────────────

#[tokio::test]
async fn block_unknown_preserves_flavour_string() {
  let bin = build_with_child("u", "vendor:never-heard", |_tx, _c| {});
  let ir = build_ir(&bin).await;
  match first_child(&ir) {
    Block::Unknown { flavour, .. } => assert_eq!(flavour, "vendor:never-heard"),
    other => panic!("expected Unknown, got {other:?}"),
  }
}

// ─── Inline marks ────────────────────────────────────────────────────────────

#[tokio::test]
async fn inline_marks_bold_italic_link_survive_round_trip() {
  use std::sync::Arc;
  use yrs::types::Attrs;

  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let bin = {
    let mut tx = doc.transact_mut();

    let page = blocks.insert(&mut tx, "page-1", MapPrelim::default());
    page.insert(&mut tx, "sys:flavour", "myoxus:page");
    let pc = page.insert(&mut tx, "sys:children", ArrayPrelim::default());
    pc.push_back(&mut tx, "p");

    let para = blocks.insert(&mut tx, "p", MapPrelim::default());
    para.insert(&mut tx, "sys:flavour", "myoxus:paragraph");
    para.insert(&mut tx, "sys:children", ArrayPrelim::default());
    let text_ref = para.insert(&mut tx, "prop:text", TextPrelim::new("Hello bold here"));
    let bold = Attrs::from([(Arc::from("bold"), Any::Bool(true))]);
    text_ref.format(&mut tx, 6, 4, bold);
    let link = Attrs::from([(Arc::from("link"), Any::String("https://example.org".into()))]);
    text_ref.format(&mut tx, 11, 4, link);

    tx.encode_update_v1()
  };

  let ir = build_ir(&bin).await;
  let Block::Paragraph { content, .. } = first_child(&ir) else {
    panic!("expected Paragraph");
  };

  let bold_seen = content.iter().any(|s| {
    matches!(
      s,
      InlineSpan::Text {
        marks: TextMarks { bold: Some(true), .. },
        ..
      }
    )
  });
  let link_seen = content.iter().any(|s| {
    matches!(
      s,
      InlineSpan::Text {
        marks: TextMarks { link: Some(_), .. },
        ..
      }
    )
  });
  assert!(bold_seen, "expected at least one bold span: {content:?}");
  assert!(link_seen, "expected at least one link span: {content:?}");
}

// ─── Inline marks: full set ─────────────────────────────────────────────────

#[tokio::test]
async fn inline_marks_full_set_round_trip() {
  // Verify that every TextMarks field round-trips through the Yjs delta:
  // underline, strikethrough, code, color, background — in addition to
  // bold/italic/link covered by the prior test. Each mark is applied to
  // a non-overlapping range so we can isolate its presence in the result.
  use std::sync::Arc;
  use yrs::types::Attrs;

  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let bin = {
    let mut tx = doc.transact_mut();
    let page = blocks.insert(&mut tx, "page-1", MapPrelim::default());
    page.insert(&mut tx, "sys:flavour", "myoxus:page");
    let pc = page.insert(&mut tx, "sys:children", ArrayPrelim::default());
    pc.push_back(&mut tx, "p");

    let para = blocks.insert(&mut tx, "p", MapPrelim::default());
    para.insert(&mut tx, "sys:flavour", "myoxus:paragraph");
    para.insert(&mut tx, "sys:children", ArrayPrelim::default());

    // 5 chars per mark, separated by spaces:
    //   "uuuuu sssss ccccc kkkkk hhhhh"
    //    0..5  6..11 12..17 18..23 24..29
    let text = para.insert(&mut tx, "prop:text", TextPrelim::new("uuuuu sssss ccccc kkkkk hhhhh"));
    text.format(&mut tx, 0, 5, Attrs::from([(Arc::from("underline"), Any::Bool(true))]));
    text.format(
      &mut tx,
      6,
      5,
      Attrs::from([(Arc::from("strikethrough"), Any::Bool(true))]),
    );
    text.format(&mut tx, 12, 5, Attrs::from([(Arc::from("code"), Any::Bool(true))]));
    text.format(
      &mut tx,
      18,
      5,
      Attrs::from([(Arc::from("color"), Any::String(Arc::from("#ff5500")))]),
    );
    text.format(
      &mut tx,
      24,
      5,
      Attrs::from([(Arc::from("background"), Any::String(Arc::from("#ffff00")))]),
    );
    tx.encode_update_v1()
  };

  let ir = build_ir(&bin).await;
  let Block::Paragraph { content, .. } = first_child(&ir) else {
    panic!("expected Paragraph");
  };

  let mut saw_underline = false;
  let mut saw_strike = false;
  let mut saw_code = false;
  let mut saw_color = false;
  let mut saw_bg = false;
  for span in content {
    if let InlineSpan::Text { marks, .. } = span {
      if marks.underline == Some(true) {
        saw_underline = true;
      }
      if marks.strike == Some(true) {
        saw_strike = true;
      }
      if marks.code == Some(true) {
        saw_code = true;
      }
      if marks.color.as_deref() == Some("#ff5500") {
        saw_color = true;
      }
      if marks.background.as_deref() == Some("#ffff00") {
        saw_bg = true;
      }
    }
  }
  assert!(saw_underline, "underline mark missing in {content:?}");
  assert!(saw_strike, "strikethrough mark missing in {content:?}");
  assert!(saw_code, "code mark missing in {content:?}");
  assert!(saw_color, "color mark missing in {content:?}");
  assert!(saw_bg, "background mark missing in {content:?}");
}

// ─── Inline embeds: latex / reference / mention / footnote ──────────────────

/// Build a paragraph whose `prop:text` carries a single trigger character
/// (`REFERENCE_NODE = " "`) formatted with the embed payload `attrs`. This
/// matches the editor encoding for inline reference/mention/footnote/latex.
fn paragraph_with_embed_attrs(attrs: yrs::types::Attrs) -> Vec<u8> {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut tx = doc.transact_mut();

  let page = blocks.insert(&mut tx, "page-1", MapPrelim::default());
  page.insert(&mut tx, "sys:flavour", "myoxus:page");
  let pc = page.insert(&mut tx, "sys:children", ArrayPrelim::default());
  pc.push_back(&mut tx, "p");

  let para = blocks.insert(&mut tx, "p", MapPrelim::default());
  para.insert(&mut tx, "sys:flavour", "myoxus:paragraph");
  para.insert(&mut tx, "sys:children", ArrayPrelim::default());

  // REFERENCE_NODE is a single space character; format the whole string.
  let text = para.insert(&mut tx, "prop:text", TextPrelim::new(" "));
  text.format(&mut tx, 0, 1, attrs);

  tx.encode_update_v1()
}

#[tokio::test]
async fn inline_latex_via_attr_string() {
  use std::sync::Arc;
  use yrs::types::Attrs;

  let attrs = Attrs::from([(Arc::from("latex"), Any::String(Arc::from("E = mc^2")))]);
  let bin = paragraph_with_embed_attrs(attrs);
  let ir = build_ir(&bin).await;
  let Block::Paragraph { content, .. } = first_child(&ir) else {
    panic!("expected Paragraph");
  };
  let has_latex = content
    .iter()
    .any(|s| matches!(s, InlineSpan::Latex { source } if source == "E = mc^2"));
  assert!(has_latex, "expected InlineSpan::Latex in {content:?}");
}

#[tokio::test]
async fn inline_reference_via_attr_payload() {
  use std::sync::Arc;
  use yrs::types::Attrs;

  let mut payload: HashMap<String, Any> = HashMap::new();
  payload.insert("type".into(), Any::String(Arc::from("LinkedPage")));
  payload.insert("pageId".into(), Any::String(Arc::from("doc-uuid-123")));
  payload.insert("title".into(), Any::String(Arc::from("Linked Page")));
  let attrs = Attrs::from([(Arc::from("reference"), Any::Map(Arc::new(payload)))]);

  let bin = paragraph_with_embed_attrs(attrs);
  let ir = build_ir(&bin).await;
  let Block::Paragraph { content, .. } = first_child(&ir) else {
    panic!("expected Paragraph");
  };
  let matched = content.iter().any(|s| {
    matches!(
      s,
      InlineSpan::Reference { doc_id, title }
        if doc_id == "doc-uuid-123" && title.as_deref() == Some("Linked Page")
    )
  });
  assert!(matched, "expected InlineSpan::Reference in {content:?}");
}

#[tokio::test]
async fn inline_reference_via_legacy_doc_link() {
  // Pre-embed snapshots stored a doc reference as link="doc:<id>" on the
  // text. Keep that backwards-compatible path covered.
  use std::sync::Arc;
  use yrs::types::Attrs;

  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let bin = {
    let mut tx = doc.transact_mut();
    let page = blocks.insert(&mut tx, "page-1", MapPrelim::default());
    page.insert(&mut tx, "sys:flavour", "myoxus:page");
    let pc = page.insert(&mut tx, "sys:children", ArrayPrelim::default());
    pc.push_back(&mut tx, "p");

    let para = blocks.insert(&mut tx, "p", MapPrelim::default());
    para.insert(&mut tx, "sys:flavour", "myoxus:paragraph");
    para.insert(&mut tx, "sys:children", ArrayPrelim::default());
    let text = para.insert(&mut tx, "prop:text", TextPrelim::new("see other"));
    text.format(
      &mut tx,
      4,
      5,
      Attrs::from([(Arc::from("link"), Any::String(Arc::from("doc:legacy-uuid")))]),
    );
    tx.encode_update_v1()
  };

  let ir = build_ir(&bin).await;
  let Block::Paragraph { content, .. } = first_child(&ir) else {
    panic!("expected Paragraph");
  };
  let matched = content.iter().any(|s| {
    matches!(
      s,
      InlineSpan::Reference { doc_id, .. } if doc_id == "legacy-uuid"
    )
  });
  assert!(matched, "expected legacy doc-link Reference in {content:?}");
}

#[tokio::test]
async fn inline_mention_via_attr_payload() {
  use std::sync::Arc;
  use yrs::types::Attrs;

  let mut payload: HashMap<String, Any> = HashMap::new();
  payload.insert("member".into(), Any::String(Arc::from("user-42")));
  payload.insert("displayName".into(), Any::String(Arc::from("Alice")));
  let attrs = Attrs::from([(Arc::from("mention"), Any::Map(Arc::new(payload)))]);

  let bin = paragraph_with_embed_attrs(attrs);
  let ir = build_ir(&bin).await;
  let Block::Paragraph { content, .. } = first_child(&ir) else {
    panic!("expected Paragraph");
  };
  let matched = content.iter().any(|s| {
    matches!(
      s,
      InlineSpan::Mention { user_id, display_name }
        if user_id == "user-42" && display_name.as_deref() == Some("Alice")
    )
  });
  assert!(matched, "expected InlineSpan::Mention in {content:?}");
}

#[tokio::test]
async fn inline_footnote_via_attr_payload() {
  use std::sync::Arc;
  use yrs::types::Attrs;

  let mut footnote: HashMap<String, Any> = HashMap::new();
  footnote.insert("label".into(), Any::String(Arc::from("1")));
  // Inner reference object is preserved at the source-of-truth side but
  // we only surface the label as content for now (the renderer can decide
  // how to format the footnote body in a later pass).
  let mut reference: HashMap<String, Any> = HashMap::new();
  reference.insert("type".into(), Any::String(Arc::from("URL")));
  reference.insert("url".into(), Any::String(Arc::from("https://example.org")));
  footnote.insert("reference".into(), Any::Map(Arc::new(reference)));

  let attrs = Attrs::from([(Arc::from("footnote"), Any::Map(Arc::new(footnote)))]);
  let bin = paragraph_with_embed_attrs(attrs);
  let ir = build_ir(&bin).await;
  let Block::Paragraph { content, .. } = first_child(&ir) else {
    panic!("expected Paragraph");
  };
  let matched = content.iter().any(|s| {
    matches!(
      s,
      InlineSpan::Footnote { content: c }
        if c.iter().any(|inner| matches!(inner, InlineSpan::Text { text, .. } if text == "1"))
    )
  });
  assert!(matched, "expected InlineSpan::Footnote with label '1' in {content:?}");
}

// ─── Table block ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn block_table_with_header_and_cells() {
  // A myoxus:table has rows as direct children (separate blocks in the
  // blocks map). Each row's children are cell blocks. Header rows are
  // marked via prop:type = "tableHeaderRow".
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let bin = {
    let mut tx = doc.transact_mut();

    // page → table
    let page = blocks.insert(&mut tx, "page-1", MapPrelim::default());
    page.insert(&mut tx, "sys:flavour", "myoxus:page");
    let pc = page.insert(&mut tx, "sys:children", ArrayPrelim::default());
    pc.push_back(&mut tx, "tbl");

    // table → [header-row, body-row]
    let table = blocks.insert(&mut tx, "tbl", MapPrelim::default());
    table.insert(&mut tx, "sys:flavour", "myoxus:table");
    let table_children = table.insert(&mut tx, "sys:children", ArrayPrelim::default());
    table_children.push_back(&mut tx, "row-h");
    table_children.push_back(&mut tx, "row-b");

    // Header row → [hc1, hc2]
    let header = blocks.insert(&mut tx, "row-h", MapPrelim::default());
    header.insert(&mut tx, "sys:flavour", "myoxus:table-row");
    header.insert(&mut tx, "prop:type", "tableHeaderRow");
    let hc = header.insert(&mut tx, "sys:children", ArrayPrelim::default());
    hc.push_back(&mut tx, "hc1");
    hc.push_back(&mut tx, "hc2");

    // Body row → [bc1, bc2]
    let body = blocks.insert(&mut tx, "row-b", MapPrelim::default());
    body.insert(&mut tx, "sys:flavour", "myoxus:table-row");
    let bc = body.insert(&mut tx, "sys:children", ArrayPrelim::default());
    bc.push_back(&mut tx, "bc1");
    bc.push_back(&mut tx, "bc2");

    for (id, text) in [("hc1", "Name"), ("hc2", "Score"), ("bc1", "Alice"), ("bc2", "42")] {
      let cell = blocks.insert(&mut tx, id, MapPrelim::default());
      cell.insert(&mut tx, "sys:flavour", "myoxus:table-cell");
      cell.insert(&mut tx, "sys:children", ArrayPrelim::default());
      cell.insert(&mut tx, "prop:text", TextPrelim::new(text));
    }

    tx.encode_update_v1()
  };

  let ir = build_ir(&bin).await;
  let Block::Table { rows, header_rows, .. } = first_child(&ir) else {
    panic!("expected Table");
  };
  assert_eq!(*header_rows, None);
  assert_eq!(rows.len(), 2, "expected 2 rows");
  assert_eq!(rows[0].cells.len(), 2, "header row should have 2 cells");
  assert!(rows[0].cells[0].is_header, "first row marked as header");
  assert_eq!(join_text(&rows[0].cells[0].content), "Name");
  assert_eq!(join_text(&rows[0].cells[1].content), "Score");
  assert!(!rows[1].cells[0].is_header, "second row is body");
  assert_eq!(join_text(&rows[1].cells[0].content), "Alice");
  assert_eq!(join_text(&rows[1].cells[1].content), "42");
}

#[tokio::test]
async fn block_table_reads_flat_virgultum_table_props() {
  // Real table blocks are `isFlatData`: rows, columns and cell texts are
  // stored as flattened `prop:rows.<id>.*`, `prop:columns.<id>.*` and
  // `prop:cells.<row>:<column>.text` keys, not as child row/cell blocks.
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let bin = {
    let mut tx = doc.transact_mut();

    let page = blocks.insert(&mut tx, "page-1", MapPrelim::default());
    page.insert(&mut tx, "sys:flavour", "myoxus:page");
    let pc = page.insert(&mut tx, "sys:children", ArrayPrelim::default());
    pc.push_back(&mut tx, "tbl");

    let table = blocks.insert(&mut tx, "tbl", MapPrelim::default());
    table.insert(&mut tx, "sys:flavour", "myoxus:table");
    table.insert(&mut tx, "sys:children", ArrayPrelim::default());
    table.insert(&mut tx, "prop:headerRows", 2.0);
    table.insert(&mut tx, "prop:appearance", "ruled");
    table.insert(&mut tx, "prop:density", "compact");

    table.insert(&mut tx, "prop:rows.r2.rowId", "r2");
    table.insert(&mut tx, "prop:rows.r2.order", "b");
    table.insert(&mut tx, "prop:rows.r1.rowId", "r1");
    table.insert(&mut tx, "prop:rows.r1.order", "a");
    table.insert(&mut tx, "prop:columns.c2.columnId", "c2");
    table.insert(&mut tx, "prop:columns.c2.order", "b");
    table.insert(&mut tx, "prop:columns.c2.textAlign", "right");
    table.insert(&mut tx, "prop:columns.c3.columnId", "c3");
    table.insert(&mut tx, "prop:columns.c3.order", "c");
    table.insert(&mut tx, "prop:columns.c3.textAlign", "center");
    table.insert(&mut tx, "prop:columns.c1.columnId", "c1");
    table.insert(&mut tx, "prop:columns.c1.order", "a");
    table.insert(&mut tx, "prop:columns.c1.textAlign", "left");
    table.insert(&mut tx, "prop:columns.c1.width", 240.0);
    table.insert(&mut tx, "prop:columns.c2.width", 120.0);
    table.insert(&mut tx, "prop:columns.c3.width", 60.0);
    table.insert(&mut tx, "prop:cells.r1:c1.text", TextPrelim::new("Name"));
    table.insert(&mut tx, "prop:cells.r1:c2.text", TextPrelim::new("Score #1"));
    table.insert(&mut tx, "prop:cells.r2:c1.text", TextPrelim::new("Marta Müller"));
    table.insert(&mut tx, "prop:cells.r2:c2.text", TextPrelim::new("42 €"));
    table.insert(&mut tx, "prop:cells.r1:c3.text", TextPrelim::new("State"));
    table.insert(&mut tx, "prop:cells.r2:c3.text", TextPrelim::new("Reviewed"));
    table.insert(
      &mut tx,
      "prop:rows.r1.backgroundColor",
      "--myoxus-sem-status-error-paper",
    );
    table.insert(&mut tx, "prop:columns.c2.backgroundColor", "var(--myoxus-tag-blue)");
    table.insert(
      &mut tx,
      "prop:cells.r1:c2.backgroundColor",
      "--myoxus-sem-status-success-paper",
    );
    table.insert(&mut tx, "prop:cells.r2:c3.backgroundColor", "#123456ff");

    tx.encode_update_v1()
  };

  let legacy = build_ir(&bin).await;
  let Block::Table { rows, .. } = first_child(&legacy) else {
    panic!("expected legacy table")
  };
  assert!(
    rows
      .iter()
      .flat_map(|r| &r.cells)
      .all(|c| c.fill.is_none() && c.foreground.is_none())
  );
  let options = ExportOptions {
    native_table_palette: Some(
      [
        ("--myoxus-sem-status-error-paper", "#f4c7c7"),
        ("--myoxus-sem-status-success-paper", "#c7e5d2"),
        ("--myoxus-tag-blue", "#e1eeff"),
      ]
      .into_iter()
      .map(|(key, fill)| {
        (
          key.to_string(),
          myoxus_pdf_export::ir::NativeTablePaint {
            fill: fill.into(),
            foreground: "#000000".into(),
          },
        )
      })
      .collect(),
    ),
    ..ExportOptions::default()
  };
  let ir = YjsIrBuilder::new(NullAssetResolver)
    .build(&bin, metadata(), options.clone())
    .await
    .expect("painted table IR");
  let Block::Table {
    rows,
    header_rows,
    appearance,
    density,
    column_widths,
    ..
  } = first_child(&ir)
  else {
    panic!("expected Table");
  };
  assert_eq!(*header_rows, Some(2));
  assert_eq!(*appearance, Some(TableAppearance::Ruled));
  assert_eq!(*density, Some(TableDensity::Compact));
  assert_eq!(column_widths.as_deref(), Some([240.0, 120.0, 60.0].as_slice()));
  assert_eq!(rows.len(), 2, "flat table must keep both rows");
  assert_eq!(rows[0].cells.len(), 3, "flat table must keep every column");
  assert_eq!(join_text(&rows[0].cells[0].content), "Name");
  assert_eq!(join_text(&rows[0].cells[1].content), "Score #1");
  assert_eq!(join_text(&rows[1].cells[0].content), "Marta Müller");
  assert_eq!(join_text(&rows[1].cells[1].content), "42 €");
  assert_eq!(join_text(&rows[1].cells[2].content), "Reviewed");
  for row in rows {
    assert_eq!(
      row.cells.iter().map(|cell| cell.align.as_deref()).collect::<Vec<_>>(),
      vec![Some("left"), Some("right"), Some("center")],
      "column alignment must follow sorted column identity for every row"
    );
  }
  assert!(rows[0].cells.iter().all(|cell| cell.is_header));
  assert!(rows[1].cells.iter().all(|cell| cell.is_header));
  assert_eq!(
    rows[0].cells.iter().map(|c| c.fill.as_deref()).collect::<Vec<_>>(),
    vec![Some("#f4c7c7"), Some("#c7e5d2"), Some("#f4c7c7")]
  );
  assert_eq!(
    rows[1].cells.iter().map(|c| c.fill.as_deref()).collect::<Vec<_>>(),
    vec![None, Some("#e1eeff"), Some("#123456")]
  );
  assert_eq!(rows[1].cells[2].foreground.as_deref(), Some("#ffffff"));

  {
    let mut tx = doc.transact_mut();
    let yrs::Out::YMap(table) = blocks.get(&tx, "tbl").unwrap() else {
      panic!("table map")
    };
    table.insert(&mut tx, "prop:cells.r1:c2.backgroundColor", "var(--unknown-fill)");
  }
  let invalid = yrs::ReadTxn::encode_state_as_update_v1(&doc.transact(), &yrs::StateVector::default());
  assert!(matches!(
    YjsIrBuilder::new(NullAssetResolver)
      .build(&invalid, metadata(), options.clone())
      .await,
    Err(myoxus_pdf_export::error::IrBuildError::InvalidTablePaint)
  ));
  {
    let mut tx = doc.transact_mut();
    let yrs::Out::YMap(table) = blocks.get(&tx, "tbl").unwrap() else {
      panic!("table map")
    };
    table.remove(&mut tx, "prop:cells.r1:c2.backgroundColor");
    table.insert(&mut tx, "prop:columns.c3.width", -1.0);
    table.remove(&mut tx, "prop:columns.c2.width");
  }
  let normalized = yrs::ReadTxn::encode_state_as_update_v1(&doc.transact(), &yrs::StateVector::default());
  let normalized = YjsIrBuilder::new(NullAssetResolver)
    .build(&normalized, metadata(), options)
    .await
    .expect("normalized native widths");
  let Block::Table { column_widths, .. } = first_child(&normalized) else {
    panic!("table")
  };
  assert_eq!(column_widths.as_deref(), Some([240.0, 120.0, 120.0].as_slice()));
}

// ─── Database block ──────────────────────────────────────────────────────────

#[tokio::test]
async fn block_database_with_columns_and_rows() {
  // myoxus:database stores columns as a JSON string under prop:columns.
  // Each child row block has prop:<column_name> values that the builder
  // pulls into the row cells in column order.
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let bin = {
    let mut tx = doc.transact_mut();

    let page = blocks.insert(&mut tx, "page-1", MapPrelim::default());
    page.insert(&mut tx, "sys:flavour", "myoxus:page");
    let pc = page.insert(&mut tx, "sys:children", ArrayPrelim::default());
    pc.push_back(&mut tx, "db");

    let db = blocks.insert(&mut tx, "db", MapPrelim::default());
    db.insert(&mut tx, "sys:flavour", "myoxus:database");
    db.insert(
      &mut tx,
      "prop:columns",
      r#"[{"name":"title","type":"text"},{"name":"status","type":"select"}]"#,
    );
    let db_children = db.insert(&mut tx, "sys:children", ArrayPrelim::default());
    db_children.push_back(&mut tx, "r1");
    db_children.push_back(&mut tx, "r2");

    let r1 = blocks.insert(&mut tx, "r1", MapPrelim::default());
    r1.insert(&mut tx, "sys:flavour", "myoxus:database-row");
    r1.insert(&mut tx, "sys:children", ArrayPrelim::default());
    r1.insert(&mut tx, "prop:title", "Onboard new hire");
    r1.insert(&mut tx, "prop:status", "Done");

    let r2 = blocks.insert(&mut tx, "r2", MapPrelim::default());
    r2.insert(&mut tx, "sys:flavour", "myoxus:database-row");
    r2.insert(&mut tx, "sys:children", ArrayPrelim::default());
    r2.insert(&mut tx, "prop:title", "Q3 retro");
    r2.insert(&mut tx, "prop:status", "In progress");

    tx.encode_update_v1()
  };

  let ir = build_ir(&bin).await;
  let Block::Database(table) = first_child(&ir) else {
    panic!("expected Database");
  };
  assert_eq!(table.columns.len(), 2);
  assert_eq!(table.columns[0].name, "title");
  assert_eq!(table.columns[0].data_type, "text");
  assert_eq!(table.columns[1].name, "status");
  assert_eq!(table.columns[1].data_type, "select");
  assert_eq!(table.rows.len(), 2);
  assert_eq!(join_text(&table.rows[0][0]), "Onboard new hire");
  assert_eq!(join_text(&table.rows[0][1]), "Done");
  assert_eq!(join_text(&table.rows[1][0]), "Q3 retro");
  assert_eq!(join_text(&table.rows[1][1]), "In progress");
}
