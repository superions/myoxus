// SPDX-License-Identifier: AGPL-3.0-or-later
//! IR serialization/deserialization round-trip tests.
//!
//! These tests verify that every block and inline type in the IR scope
//! survives a serde JSON round-trip without data loss.

use uuid::Uuid;

use myoxus_pdf_export::ir::{
  CURRENT_IR_VERSION, DocumentMetadata, ExportOptions, IrDocument,
  block::*,
  inline::{InlineSpan, TextMarks},
};

fn minimal_metadata() -> DocumentMetadata {
  use myoxus_pdf_export::ir::{Branding, DocumentMetadata};
  DocumentMetadata {
    doc_id: Uuid::new_v4(),
    workspace_id: Uuid::new_v4(),
    title: Some("Test Document".into()),
    author: Some("tester".into()),
    created_at: None,
    updated_at: None,
    workspace_name: Some("Test Workspace".into()),
    branding: Branding::default(),
  }
}

fn make_doc(root: Block) -> IrDocument {
  IrDocument {
    version: CURRENT_IR_VERSION,
    metadata: minimal_metadata(),
    options: ExportOptions::default(),
    root,
    assets: Default::default(),
  }
}

fn roundtrip(doc: &IrDocument) -> IrDocument {
  let json = serde_json::to_string(doc).expect("serialize");
  serde_json::from_str(&json).expect("deserialize")
}

fn plain(text: &str) -> InlineSpan {
  InlineSpan::Text {
    text: text.into(),
    marks: TextMarks::default(),
  }
}

fn bold(text: &str) -> InlineSpan {
  InlineSpan::Text {
    text: text.into(),
    marks: TextMarks {
      bold: Some(true),
      ..Default::default()
    },
  }
}

// ─── Container blocks ────────────────────────────────────────────────────────

#[test]
fn ir_page_roundtrip() {
  let doc = make_doc(Block::Page {
    title: vec![plain("My Page")],
    children: vec![Block::Paragraph {
      content: vec![plain("Hello")],
      children: vec![],
    }],
  });
  let out = roundtrip(&doc);
  let Block::Page { title, children } = &out.root else {
    panic!("wrong variant")
  };
  assert_eq!(title.len(), 1);
  assert_eq!(children.len(), 1);
}

#[test]
fn ir_note_roundtrip() {
  let doc = make_doc(Block::Note {
    children: vec![Block::Divider],
  });
  let out = roundtrip(&doc);
  assert!(matches!(out.root, Block::Note { .. }));
}

// ─── Text blocks ─────────────────────────────────────────────────────────────

#[test]
fn ir_heading_levels_roundtrip() {
  for level in [HeadingLevel::H1, HeadingLevel::H2, HeadingLevel::H3] {
    let doc = make_doc(Block::Heading {
      level,
      content: vec![plain("Heading")],
      children: vec![],
    });
    let out = roundtrip(&doc);
    let Block::Heading { level: got, .. } = &out.root else {
      panic!("wrong variant")
    };
    assert_eq!(*got, level);
  }
}

#[test]
fn ir_list_types_roundtrip() {
  for lt in [ListType::Bulleted, ListType::Numbered, ListType::Todo, ListType::Toggle] {
    let doc = make_doc(Block::List {
      list_type: lt,
      content: vec![plain("item")],
      checked: lt == ListType::Todo,
      children: vec![],
    });
    let out = roundtrip(&doc);
    let Block::List { list_type, .. } = &out.root else {
      panic!("wrong variant")
    };
    assert_eq!(*list_type, lt);
  }
}

#[test]
fn ir_code_block_roundtrip() {
  let doc = make_doc(Block::Code(CodeBlock {
    language: Some("rust".into()),
    code: "fn main() {}".into(),
    caption: None,
  }));
  let out = roundtrip(&doc);
  let Block::Code(cb) = &out.root else {
    panic!("wrong variant")
  };
  assert_eq!(cb.language.as_deref(), Some("rust"));
  assert_eq!(cb.code, "fn main() {}");
}

#[test]
fn ir_divider_roundtrip() {
  let doc = make_doc(Block::Divider);
  let out = roundtrip(&doc);
  assert!(matches!(out.root, Block::Divider));
}

#[test]
fn ir_callout_variants_roundtrip() {
  for variant in [
    CalloutVariant::Info,
    CalloutVariant::Warning,
    CalloutVariant::Note,
    CalloutVariant::Tip,
  ] {
    let doc = make_doc(Block::Callout {
      variant,
      emoji: Some("💡".into()),
      content: vec![plain("callout text")],
      children: vec![],
    });
    let out = roundtrip(&doc);
    let Block::Callout { variant: got, .. } = &out.root else {
      panic!("wrong variant")
    };
    assert_eq!(*got, variant);
  }
}

#[test]
fn ir_latex_block_roundtrip() {
  let doc = make_doc(Block::LatexBlock {
    source: r"E = mc^2".into(),
  });
  let out = roundtrip(&doc);
  let Block::LatexBlock { source } = &out.root else {
    panic!("wrong variant")
  };
  assert_eq!(source, r"E = mc^2");
}

// ─── Media blocks ────────────────────────────────────────────────────────────

#[test]
fn ir_image_ref_roundtrip() {
  let doc = make_doc(Block::Image(ImageRef {
    blob: BlobRef {
      blob_id: "abc123".into(),
      mime_hint: Some("image/png".into()),
    },
    caption: Some(vec![plain("fig 1")]),
    width_hint: Some(300.0),
    height_hint: None,
    data: None,
  }));
  let out = roundtrip(&doc);
  let Block::Image(img) = &out.root else {
    panic!("wrong variant")
  };
  assert_eq!(img.blob.blob_id, "abc123");
  assert_eq!(img.width_hint, Some(300.0));
}

#[test]
fn ir_attachment_roundtrip() {
  let doc = make_doc(Block::Attachment {
    blob: BlobRef {
      blob_id: "xyz".into(),
      mime_hint: None,
    },
    name: Some("report.pdf".into()),
    size_bytes: Some(1024 * 512),
    mime: Some("application/pdf".into()),
  });
  let out = roundtrip(&doc);
  let Block::Attachment { name, .. } = &out.root else {
    panic!("wrong variant")
  };
  assert_eq!(name.as_deref(), Some("report.pdf"));
}

#[test]
fn ir_bookmark_roundtrip() {
  let doc = make_doc(Block::Bookmark(EmbedCard {
    url: "https://example.com".into(),
    title: Some("Example".into()),
    description: None,
    favicon: None,
    embed_kind: "bookmark".into(),
  }));
  let out = roundtrip(&doc);
  let Block::Bookmark(card) = &out.root else {
    panic!("wrong variant")
  };
  assert_eq!(card.url, "https://example.com");
  assert_eq!(card.embed_kind, "bookmark");
}

#[test]
fn ir_embed_card_roundtrip() {
  for kind in ["loom", "figma", "youtube", "github", "linked-doc"] {
    let doc = make_doc(Block::Embed(EmbedCard {
      url: "https://example.com/embed".into(),
      title: None,
      description: None,
      favicon: None,
      embed_kind: kind.into(),
    }));
    let out = roundtrip(&doc);
    let Block::Embed(card) = &out.root else {
      panic!("wrong variant")
    };
    assert_eq!(card.embed_kind, kind);
  }
}

// ─── Database / Table ────────────────────────────────────────────────────────

#[test]
fn ir_table_roundtrip() {
  let doc = make_doc(Block::Table {
    rows: vec![
      TableRow {
        cells: vec![
          TableCell {
            content: vec![bold("Col A")],
            is_header: true,
            col_span: 1,
            row_span: 1,
            align: None,
            fill: None,
            foreground: None,
          },
          TableCell {
            content: vec![bold("Col B")],
            is_header: true,
            col_span: 1,
            row_span: 1,
            align: None,
            fill: None,
            foreground: None,
          },
        ],
      },
      TableRow {
        cells: vec![
          TableCell {
            content: vec![plain("val1")],
            is_header: false,
            col_span: 1,
            row_span: 1,
            align: Some("center".into()),
            fill: None,
            foreground: None,
          },
          TableCell {
            content: vec![plain("val2")],
            is_header: false,
            col_span: 1,
            row_span: 1,
            align: None,
            fill: None,
            foreground: None,
          },
        ],
      },
    ],
    caption: Some(vec![plain("Table 1")]),
    column_widths: None,
    header_rows: Some(1),
    appearance: None,
    density: None,
  });
  let out = roundtrip(&doc);
  let Block::Table {
    rows,
    caption,
    header_rows,
    ..
  } = &out.root
  else {
    panic!("wrong variant")
  };
  assert_eq!(rows.len(), 2);
  assert_eq!(rows[0].cells.len(), 2);
  assert!(caption.is_some());
  assert_eq!(*header_rows, Some(1));
}

#[test]
fn ir_database_roundtrip() {
  let doc = make_doc(Block::Database(DatabaseTableView {
    columns: vec![
      DatabaseColumn {
        name: "Name".into(),
        data_type: "text".into(),
      },
      DatabaseColumn {
        name: "Done".into(),
        data_type: "checkbox".into(),
      },
    ],
    rows: vec![vec![vec![plain("Alice")], vec![plain("true")]]],
  }));
  let out = roundtrip(&doc);
  let Block::Database(db) = &out.root else {
    panic!("wrong variant")
  };
  assert_eq!(db.columns.len(), 2);
  assert_eq!(db.rows.len(), 1);
}

// ─── Edgeless ────────────────────────────────────────────────────────────────

#[test]
fn ir_edgeless_snapshots_roundtrip() {
  let snap = EdgelessSnapshot {
    png_bytes: vec![0x89, 0x50, 0x4e, 0x47], // PNG magic bytes
    width_px: 800,
    height_px: 600,
    caption: None,
  };
  for variant in ["surface", "surface_ref", "frame", "mindmap"] {
    let root = match variant {
      "surface" => Block::Surface(snap.clone()),
      "surface_ref" => Block::SurfaceRef(snap.clone()),
      "frame" => Block::Frame(snap.clone()),
      _ => Block::Mindmap(snap.clone()),
    };
    let doc = make_doc(root);
    let out = roundtrip(&doc);
    match &out.root {
      Block::Surface(s) | Block::SurfaceRef(s) | Block::Frame(s) | Block::Mindmap(s) => {
        assert_eq!(s.width_px, 800);
        assert_eq!(s.png_bytes.len(), 4);
      }
      _ => panic!("wrong variant for {variant}"),
    }
  }
}

// ─── AI Chat ─────────────────────────────────────────────────────────────────

#[test]
fn ir_ai_chat_roundtrip() {
  let doc = make_doc(Block::AiChat {
    messages: vec![
      AiChatMessage {
        role: "user".into(),
        content: vec![plain("Hello!")],
      },
      AiChatMessage {
        role: "assistant".into(),
        content: vec![plain("Hi there.")],
      },
    ],
  });
  let out = roundtrip(&doc);
  let Block::AiChat { messages } = &out.root else {
    panic!("wrong variant")
  };
  assert_eq!(messages.len(), 2);
  assert_eq!(messages[0].role, "user");
}

// ─── Unknown fallback ────────────────────────────────────────────────────────

#[test]
fn ir_unknown_block_roundtrip() {
  let doc = make_doc(Block::Unknown {
    flavour: "custom:my-block".into(),
    text_fallback: Some(vec![plain("fallback text")]),
  });
  let out = roundtrip(&doc);
  let Block::Unknown { flavour, text_fallback } = &out.root else {
    panic!("wrong variant")
  };
  assert_eq!(flavour, "custom:my-block");
  assert!(text_fallback.is_some());
}

// ─── Inline spans ─────────────────────────────────────────────────────────────

#[test]
fn ir_inline_spans_roundtrip() {
  let spans = vec![
    plain("plain text"),
    bold("bold"),
    InlineSpan::Text {
      text: "styled".into(),
      marks: TextMarks {
        italic: Some(true),
        underline: Some(true),
        strike: Some(true),
        code: Some(true),
        color: Some("#ff0000".into()),
        background: Some("#00ff00".into()),
        link: Some("https://example.com".into()),
        ..Default::default()
      },
    },
    InlineSpan::Latex {
      source: r"\alpha".into(),
    },
    InlineSpan::Reference {
      doc_id: "doc-123".into(),
      title: Some("My Doc".into()),
    },
    InlineSpan::Mention {
      user_id: "usr-456".into(),
      display_name: Some("Alice".into()),
    },
    InlineSpan::Footnote {
      content: vec![plain("footnote body")],
    },
  ];
  let doc = make_doc(Block::Paragraph {
    content: spans,
    children: vec![],
  });
  let out = roundtrip(&doc);
  let Block::Paragraph { content, .. } = &out.root else {
    panic!("wrong variant")
  };
  assert_eq!(content.len(), 7);

  // Check specific span types survived.
  assert!(matches!(&content[3], InlineSpan::Latex { source } if source == r"\alpha"));
  assert!(matches!(&content[4], InlineSpan::Reference { doc_id, .. } if doc_id == "doc-123"));
  assert!(matches!(&content[5], InlineSpan::Mention { user_id, .. } if user_id == "usr-456"));
  assert!(matches!(&content[6], InlineSpan::Footnote { .. }));
}

// ─── IR version and migration ─────────────────────────────────────────────────

#[test]
fn ir_version_is_current() {
  let doc = make_doc(Block::Divider);
  let json = serde_json::to_value(&doc).unwrap();
  assert_eq!(json["version"].as_u64().unwrap(), CURRENT_IR_VERSION as u64);
}

#[test]
fn ir_migration_noop_for_current_version() {
  use myoxus_pdf_export::ir::migration::migrate_to_current;
  let doc = make_doc(Block::Divider);
  let mut json = serde_json::to_value(&doc).unwrap();
  migrate_to_current(&mut json).expect("migration should succeed for current version");
  assert_eq!(json["version"].as_u64().unwrap(), CURRENT_IR_VERSION as u64);
}

#[test]
fn ir_migration_rejects_future_version() {
  use myoxus_pdf_export::ir::migration::migrate_to_current;
  let mut json = serde_json::json!({ "version": 9999 });
  let err = migrate_to_current(&mut json).unwrap_err();
  assert!(matches!(
    err,
    myoxus_pdf_export::IrBuildError::UnsupportedVersion { .. }
  ));
}

// ─── Block count ─────────────────────────────────────────────────────────────

#[test]
fn ir_count_all_blocks() {
  let root = Block::Page {
    title: vec![],
    children: vec![Block::Note {
      children: vec![
        Block::Paragraph {
          content: vec![],
          children: vec![],
        },
        Block::Divider,
      ],
    }],
  };
  // Page(1) + Note(1) + Paragraph(1) + Divider(1) = 4
  assert_eq!(root.count_all(), 4);
}
