// SPDX-License-Identifier: AGPL-3.0-or-later
//! Regression and evidence harness for Markdown table export through the real
//! default-template PDF path.

use std::path::PathBuf;

use uuid::Uuid;

use myoxus_pdf_export::builder::{NullAssetResolver, YjsIrBuilder};
use myoxus_pdf_export::ir::block::Block;
use myoxus_pdf_export::ir::inline::InlineSpan;
use myoxus_pdf_export::ir::{Branding, DocumentMetadata, ExportOptions, ThemeFontSelection};
use myoxus_pdf_export::render_to_pdf_v2;

mod common;

const TABLE_MARKDOWN: &str = r#"# Storage Contract Table

This document exercises the active flat `myoxus:table` storage path and the
standard PDF template.

| Quarter | Status | Evidence |
| --- | --- | --- |
| Q1 | Ready | **bold cell** |
| Q2 | Review | `code cell` |
| Q3 | Done | Final plain text |
"#;

fn metadata() -> DocumentMetadata {
  DocumentMetadata {
    doc_id: Uuid::new_v4(),
    workspace_id: Uuid::new_v4(),
    title: Some("Storage Contract Table".into()),
    author: Some("Myoxus Test".into()),
    created_at: None,
    updated_at: None,
    workspace_name: Some("PDF Evidence".into()),
    branding: Branding::default(),
  }
}

fn export_options() -> ExportOptions {
  ExportOptions {
    theme_fonts: ThemeFontSelection {
      heading: Some("New Computer Modern".into()),
      body: Some("New Computer Modern".into()),
      mono: Some("New Computer Modern".into()),
      symbol: Some("New Computer Modern".into()),
    },
    ..ExportOptions::default()
  }
}

fn collect_tables<'a>(block: &'a Block, out: &mut Vec<&'a Block>) {
  match block {
    Block::Table { .. } => out.push(block),
    Block::Page { children, .. }
    | Block::Note { children }
    | Block::Paragraph { children, .. }
    | Block::Quote { children, .. }
    | Block::Heading { children, .. }
    | Block::List { children, .. }
    | Block::Callout { children, .. }
    | Block::EdgelessText { children, .. } => {
      for child in children {
        collect_tables(child, out);
      }
    }
    _ => {}
  }
}

fn joined_text(spans: &[InlineSpan]) -> String {
  spans
    .iter()
    .map(|span| match span {
      InlineSpan::Text { text, .. } => text.as_str(),
      _ => "",
    })
    .collect()
}

#[tokio::test]
async fn markdown_flat_table_renders_with_default_template_pdf() {
  let yjs = yjs::markdown_to_yjs("Storage Contract Table", TABLE_MARKDOWN).expect("markdown table converts to Yjs");
  let mut builder = YjsIrBuilder::new(NullAssetResolver);
  let ir = builder
    .build(&yjs, metadata(), export_options())
    .await
    .expect("Yjs table builds PDF IR");

  let mut tables = Vec::new();
  collect_tables(&ir.root, &mut tables);
  assert_eq!(tables.len(), 1, "Markdown source must create one PDF IR table");
  let Block::Table { rows, .. } = tables[0] else {
    unreachable!("collect_tables only stores table blocks")
  };
  assert_eq!(rows.len(), 4, "header plus three body rows must survive");
  assert_eq!(rows[0].cells.len(), 3, "table must preserve all columns");
  assert_eq!(joined_text(&rows[0].cells[0].content), "Quarter");
  assert_eq!(joined_text(&rows[1].cells[2].content), "bold cell");
  assert_eq!(joined_text(&rows[2].cells[2].content), "code cell");

  let report = render_to_pdf_v2(&ir, common::default_template_bundle(), &[], usize::MAX)
    .expect("standard default template must render Markdown table PDF");
  assert!(report.pdf_bytes.starts_with(b"%PDF-"));
  assert!(report.pdf_bytes.len() > 1024, "PDF must contain real rendered content");

  let extracted = pdf_extract::extract_text_from_mem(&report.pdf_bytes).expect("rendered PDF text must be extractable");
  for expected in [
    "Quarter",
    "Status",
    "Evidence",
    "Q1",
    "bold cell",
    "code cell",
    "Final plain text",
  ] {
    assert!(
      extracted.contains(expected),
      "rendered PDF text must contain {expected:?}, extracted:\n{extracted}"
    );
  }

  if let Ok(dir) = std::env::var("MYOXUS_PDF_EVIDENCE_DIR") {
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create PDF evidence dir");
    std::fs::write(dir.join("table-standard-template.pdf"), &report.pdf_bytes).expect("write table PDF evidence");
    std::fs::write(dir.join("table-standard-template.txt"), extracted).expect("write table PDF text evidence");
  }
}
