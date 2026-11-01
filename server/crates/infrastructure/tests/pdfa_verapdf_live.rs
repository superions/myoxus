// SPDX-License-Identifier: AGPL-3.0-or-later
//! Optional live integration gate for the shared PDF/A/PDF/UA validator.
//!
//! This test is intentionally environment-gated because veraPDF is optional
//! infrastructure. When `VERAPDF_URL` is set it renders every admitted PDF/A/PDF/UA
//! profile and rejects transport errors, wrong profile identity or negative reports.

use std::collections::HashMap;
use std::time::Duration;

use chrono::Utc;
use myoxus_infrastructure::pdf_export::ReqwestVerapdfClient;
use myoxus_pdf_export::ir::block::{Block, HeadingLevel, ImageRef, TableCell, TableRow};
use myoxus_pdf_export::ir::inline::{InlineSpan, TextMarks};
use myoxus_pdf_export::ir::{
  AssetData, BlobRef, Branding, DocumentMetadata, ExportOptions, IrDocument, ThemeFontSelection,
};
use myoxus_pdf_export::render_to_pdf_v2;
use myoxus_pdf_export::render_v2::pdfa::{PdfaProfile, VerapdfClient, VerapdfProfile};
use uuid::Uuid;

#[tokio::test]
async fn inv_pdfa01_rendered_pdfa1b_passes_live_verapdf_when_configured() {
  let Some(base_url) = std::env::var("VERAPDF_URL")
    .ok()
    .filter(|value| !value.trim().is_empty())
  else {
    eprintln!("skipping live veraPDF check; set VERAPDF_URL=http://localhost:8080 to enable");
    return;
  };

  let client = ReqwestVerapdfClient::new(base_url, Duration::from_secs(30), None).expect("construct veraPDF client");
  let bundle = default_template_bundle();
  let fonts = fonts_dir();
  for (requested, profile) in [
    ("pdfa-1b", PdfaProfile::Pdfa1b.into()),
    ("pdfa-2b", PdfaProfile::Pdfa2b.into()),
    ("pdfa-2u", PdfaProfile::Pdfa2u.into()),
    ("pdfa-3b", PdfaProfile::Pdfa3b.into()),
    ("pdfua-1", VerapdfProfile::Pdfua1),
  ] {
    let mut doc = simple_document("Live archival profile validation");
    doc.options.compliance_profile = Some(requested.into());
    let rendered =
      render_to_pdf_v2(&doc, &bundle, std::slice::from_ref(&fonts), usize::MAX).expect("native archival render");
    let report = client
      .validate(&rendered.pdf_bytes, profile)
      .await
      .expect("configured validator transport");
    assert!(report.failures.is_empty(), "positive report has no failures");
    assert!(
      report.passed,
      "{requested} must pass its requested live veraPDF profile: {:?}",
      report.failures
    );
  }
  let mut invalid = simple_document("Tagged standard is not PDF/UA");
  invalid.options.compliance_profile = Some("standard".into());
  let rendered =
    render_to_pdf_v2(&invalid, &bundle, std::slice::from_ref(&fonts), usize::MAX).expect("native standard counterpart");
  let report = client
    .validate(&rendered.pdf_bytes, VerapdfProfile::Pdfua1)
    .await
    .expect("actual UA validation of invalid counterpart");
  assert!(!report.passed, "tagging alone does not establish UA");
  assert!(!report.failures.is_empty());
}

fn simple_document(title: &str) -> IrDocument {
  let render_date = Utc::now();
  let image=AssetData{mime:"image/svg+xml".into(),bytes:br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="blue"/></svg>"#.to_vec(),filename:Some("ua-square.svg".into())};
  IrDocument {
    version: myoxus_pdf_export::CURRENT_IR_VERSION,
    metadata: DocumentMetadata {
      doc_id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      title: Some(title.to_owned()),
      author: Some("Myoxus PDF Export".into()),
      created_at: Some(render_date),
      updated_at: Some(render_date),
      workspace_name: Some("PDF/A live validation".into()),
      branding: Branding::default(),
    },
    options: ExportOptions {
      theme_fonts: ThemeFontSelection {
        heading: Some("New Computer Modern".into()),
        body: Some("New Computer Modern".into()),
        mono: Some("New Computer Modern".into()),
        symbol: Some("New Computer Modern".into()),
      },
      ..ExportOptions::default()
    },
    assets: HashMap::from([("ua-square".into(), image.clone())]),
    root: Block::Page {
      title: vec![text(title)],
      children: vec![
        Block::Image(ImageRef {
          blob: BlobRef {
            blob_id: "ua-square".into(),
            mime_hint: Some("image/svg+xml".into()),
          },
          caption: Some(vec![text("Blue square for the accessibility validation sample")]),
          width_hint: Some(24.0),
          height_hint: None,
          data: Some(image),
        }),
        Block::Table {
          rows: vec![
            TableRow {
              cells: vec![TableCell {
                content: vec![text("Metric")],
                is_header: true,
                col_span: 1,
                row_span: 1,
                align: None,
                fill: None,
                foreground: None,
              }],
            },
            TableRow {
              cells: vec![TableCell {
                content: vec![text("42")],
                is_header: false,
                col_span: 1,
                row_span: 1,
                align: None,
                fill: None,
                foreground: None,
              }],
            },
          ],
          caption: None,
          column_widths: None,
          header_rows: Some(1),
          appearance: None,
          density: None,
        },
        Block::Paragraph {
          content: vec![InlineSpan::Text {
            text: "Myoxus reference".into(),
            marks: TextMarks {
              link: Some("https://github.com/superions/myoxus".into()),
              ..TextMarks::default()
            },
          }],
          children: vec![],
        },
        Block::Heading {
          level: HeadingLevel::H1,
          content: vec![text("Compliance validation")],
          children: vec![],
        },
        Block::Paragraph {
          content: vec![text(
            "This document is rendered through the production Myoxus PDF export template and validated by the optional veraPDF service.",
          )],
          children: vec![],
        },
      ],
    },
  }
}

fn text(value: &str) -> InlineSpan {
  InlineSpan::Text {
    text: value.to_owned(),
    marks: TextMarks::default(),
  }
}

fn default_template_bundle() -> HashMap<String, Vec<u8>> {
  let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
  let base = manifest_dir.join("../../templates/pdf/default");
  let read =
    |name: &str| std::fs::read(base.join(name)).unwrap_or_else(|e| panic!("read template fixture {name}: {e}"));
  let mut bundle = HashMap::new();
  bundle.insert("main.typ".into(), read("main.typ"));
  bundle.insert("preamble.typ".into(), read("preamble.typ"));
  bundle.insert("theme.typ".into(), read("theme.typ"));
  bundle.insert("i18n/en.json".into(), read("i18n/en.json"));
  bundle.insert("i18n/de.json".into(), read("i18n/de.json"));
  bundle
}

fn fonts_dir() -> std::path::PathBuf {
  let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .expect("crates dir")
    .parent()
    .expect("server dir")
    .join("static/fonts");
  assert!(dir.is_dir(), "expected bundled font dir at {}", dir.display());
  dir
}
