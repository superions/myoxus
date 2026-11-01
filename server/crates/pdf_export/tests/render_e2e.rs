// SPDX-License-Identifier: AGPL-3.0-or-later
//! End-to-end render tests: IR → Typst source → PDF bytes.
//!
//! These tests exercise the full pipeline against the embedded `default`
//! template + the fonts shipped by `typst-assets`. They guard the
//! contract that any well-formed IR can be turned into a valid PDF byte
//! stream without panicking, with no extra font directories.

use std::collections::HashMap;

use uuid::Uuid;

use myoxus_pdf_export::CURRENT_IR_VERSION;
use myoxus_pdf_export::ir::block::{AssetData, Block, CodeBlock, HeadingLevel, ListType};
use myoxus_pdf_export::ir::inline::{InlineSpan, TextMarks};
use myoxus_pdf_export::ir::{Branding, DocumentMetadata, ExportOptions, IrDocument, ThemeFontSelection};
use myoxus_pdf_export::{RenderError, RenderReport, render_to_pdf_v2};

mod common;

fn render(doc: &IrDocument) -> Result<Vec<u8>, RenderError> {
  render_to_pdf_v2(doc, common::default_template_bundle(), &[], usize::MAX).map(|r| r.pdf_bytes)
}

fn render_with_report(doc: &IrDocument, extra_font_dirs: &[std::path::PathBuf]) -> Result<RenderReport, RenderError> {
  render_to_pdf_v2(doc, common::default_template_bundle(), extra_font_dirs, usize::MAX)
}

fn metadata(title: &str, branding: Branding) -> DocumentMetadata {
  DocumentMetadata {
    doc_id: Uuid::new_v4(),
    workspace_id: Uuid::new_v4(),
    title: Some(title.into()),
    author: Some("Test Author".into()),
    created_at: None,
    updated_at: None,
    workspace_name: Some("Test Workspace".into()),
    branding,
  }
}

fn paragraph(text: &str) -> Block {
  Block::Paragraph {
    content: vec![InlineSpan::Text {
      text: text.into(),
      marks: TextMarks::default(),
    }],
    children: vec![],
  }
}

fn document_with_blocks(title: &str, branding: Branding, blocks: Vec<Block>) -> IrDocument {
  IrDocument {
    version: CURRENT_IR_VERSION,
    metadata: metadata(title, branding),
    options: test_export_options(),
    root: Block::Page {
      title: vec![InlineSpan::Text {
        text: title.into(),
        marks: TextMarks::default(),
      }],
      children: blocks,
    },
    assets: HashMap::new(),
  }
}

fn test_export_options() -> ExportOptions {
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

/// Invariant: a minimal IR document renders to a non-empty PDF byte
/// stream that starts with the `%PDF-` magic header.
#[test]
fn inv_minimal_ir_renders_to_pdf_header() {
  let doc = document_with_blocks("Hello", Branding::default(), vec![paragraph("Hello, Myoxus.")]);

  let pdf = render(&doc).expect("minimal ir must render");

  assert!(
    pdf.len() > 100,
    "pdf must contain real content, got {} bytes",
    pdf.len()
  );
  assert_eq!(
    &pdf[..5],
    b"%PDF-",
    "pdf must start with %PDF- header, got {:?}",
    &pdf[..pdf.len().min(8)]
  );
}

/// Invariant: branding overrides flow from IR → preamble bindings →
/// rendered PDF without breaking compilation. Different accent/bg
/// values yield distinct PDF outputs (theme tokens are load-bearing).
#[test]
fn inv_branding_overrides_change_pdf_output() {
  let plain = document_with_blocks(
    "Plain",
    Branding::default(),
    vec![Block::Heading {
      level: HeadingLevel::H1,
      content: vec![InlineSpan::Text {
        text: "Branded Heading".into(),
        marks: TextMarks::default(),
      }],
      children: vec![],
    }],
  );
  let branded = document_with_blocks(
    "Branded",
    Branding {
      primary: Some("#ff5722".into()),
      accent: Some("#ff5722".into()),
      text_primary: Some("#222222".into()),
      background: Some("#fafafa".into()),
      ..Branding::default()
    },
    vec![Block::Heading {
      level: HeadingLevel::H1,
      content: vec![InlineSpan::Text {
        text: "Branded Heading".into(),
        marks: TextMarks::default(),
      }],
      children: vec![],
    }],
  );

  let plain_pdf = render(&plain).expect("plain branding renders");
  let branded_pdf = render(&branded).expect("custom branding renders");

  assert_eq!(&plain_pdf[..5], b"%PDF-");
  assert_eq!(&branded_pdf[..5], b"%PDF-");
  assert_ne!(
    plain_pdf, branded_pdf,
    "branding overrides must influence the rendered PDF (page background \
     & accent are visible)"
  );
}

/// Invariant: document-branding logo paths materialized by the worker as
/// virtual `blob:*` assets are consumable by Typst templates. This catches the
/// hotpath gap where render inputs contain a logo but the template receives an
/// unreadable storage key instead of a resolved virtual asset.
#[test]
fn inv_document_brand_logo_blob_path_renders() {
  const LOGO_SVG: &[u8] =
    br##"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="24"><rect width="64" height="24" fill="#1e5a8a"/><circle cx="14" cy="12" r="8" fill="#ffffff"/></svg>"##;
  let mut doc = document_with_blocks(
    "Logo",
    Branding {
      organization_name: Some("Logo Org".into()),
      logo_small_path: Some("blob:brand-logo-small".into()),
      footer_text: Some("Footer".into()),
      primary: Some("#1e5a8a".into()),
      accent: Some("#2f6f4e".into()),
      ..Branding::default()
    },
    vec![paragraph("Logo render smoke.")],
  );
  doc.assets.insert(
    "brand-logo-small".into(),
    AssetData {
      mime: "image/svg+xml".into(),
      bytes: LOGO_SVG.to_vec(),
      filename: Some("brand-logo-small.svg".into()),
    },
  );

  let pdf = render(&doc).expect("document brand logo blob path must render");
  assert_eq!(&pdf[..5], b"%PDF-");
  assert!(pdf.len() > 1000, "logo document must render a non-trivial PDF");
}

/// Invariant: a richer document mixing block kinds (heading, paragraph,
/// list, code, callout, divider) renders without compilation errors.
#[test]
fn inv_mixed_block_document_renders() {
  let doc = document_with_blocks(
    "Mixed",
    Branding::default(),
    vec![
      Block::Heading {
        level: HeadingLevel::H1,
        content: vec![InlineSpan::Text {
          text: "Section".into(),
          marks: TextMarks::default(),
        }],
        children: vec![],
      },
      paragraph("Some prose body text. The renderer wires the IR through the embedded default template."),
      Block::List {
        list_type: ListType::Bulleted,
        content: vec![InlineSpan::Text {
          text: "First item".into(),
          marks: TextMarks::default(),
        }],
        checked: false,
        children: vec![],
      },
      Block::List {
        list_type: ListType::Bulleted,
        content: vec![InlineSpan::Text {
          text: "Second item".into(),
          marks: TextMarks::default(),
        }],
        checked: false,
        children: vec![],
      },
      Block::Divider,
      Block::Code(CodeBlock {
        language: Some("rust".into()),
        code: "fn main() {\n    println!(\"hi\");\n}".into(),
        caption: None,
      }),
      Block::Callout {
        variant: myoxus_pdf_export::ir::block::CalloutVariant::Info,
        emoji: None,
        content: vec![InlineSpan::Text {
          text: "Heads up.".into(),
          marks: TextMarks::default(),
        }],
        children: vec![
          Block::List {
            list_type: ListType::Bulleted,
            content: vec![InlineSpan::Text {
              text: "Callout bullet".into(),
              marks: TextMarks::default(),
            }],
            checked: false,
            children: vec![],
          },
          Block::List {
            list_type: ListType::Numbered,
            content: vec![InlineSpan::Text {
              text: "Callout number".into(),
              marks: TextMarks::default(),
            }],
            checked: false,
            children: vec![],
          },
          Block::List {
            list_type: ListType::Todo,
            content: vec![InlineSpan::Text {
              text: "Callout task".into(),
              marks: TextMarks::default(),
            }],
            checked: true,
            children: vec![],
          },
        ],
      },
    ],
  );

  let pdf = render(&doc).expect("mixed-block document renders");
  assert_eq!(&pdf[..5], b"%PDF-");
  assert!(pdf.len() > 1000, "mixed document must produce a non-trivial PDF");
}

/// INV-THEME-FONT-BODY-UNKNOWN: when the server-owned theme projection names a
/// body family that isn't loaded into the FontBook, render fails as a
/// configuration error before Typst can silently substitute another family.
#[test]
fn inv_theme_body_font_unknown_family_is_configuration_error() {
  let mut doc = document_with_blocks("UnknownFont", Branding::default(), vec![paragraph("hi")]);
  doc.options.theme_fonts.body = Some("DefinitelyNotARealFontXYZ".into());

  let err = render_with_report(&doc, &[]).expect_err("unknown theme font must fail");
  let msg = format!("{err}");

  assert!(
    msg.contains("configuration error") && msg.contains("body") && msg.contains("DefinitelyNotARealFontXYZ"),
    "unknown body family must be reported as configuration error, got: {msg}"
  );
}

/// INV-THEME-FONT-BODY-KNOWN: when the body role names a known typst-assets
/// family ("New Computer Modern" is bundled), the report's unmapped list is
/// empty.
#[test]
fn inv_theme_body_font_known_family_is_silent() {
  let mut doc = document_with_blocks("KnownFont", Branding::default(), vec![paragraph("hi")]);
  doc.options.theme_fonts.body = Some("New Computer Modern".into());

  let report = render_with_report(&doc, &[]).expect("render with bundled font must succeed");

  assert_eq!(&report.pdf_bytes[..5], b"%PDF-");
  assert!(
    report.unmapped_font_families.is_empty(),
    "bundled family must not be flagged unmapped, got {:?}",
    report.unmapped_font_families
  );
}

/// INV-THEME-FONT-NONE: the renderer requires all effective Theme DB PDF font
/// roles. It must not invent a local fallback chain when the API failed to
/// resolve the global/workspace profile.
#[test]
fn inv_theme_font_none_is_configuration_error() {
  let mut doc = document_with_blocks("NoCustomFont", Branding::default(), vec![paragraph("hi")]);
  doc.options.theme_fonts = ThemeFontSelection::default();
  assert!(doc.options.theme_fonts.body.is_none(), "precondition");

  let err = render_with_report(&doc, &[]).expect_err("missing Theme DB font role must fail before Typst render");

  assert!(
    format!("{err:?}").contains("configuration error: missing effective PDF theme font role"),
    "unexpected error: {err:?}"
  );
}

/// INV-THEME-FONT-ROLE-REQUIRED: every PDF role is mandatory. A partial
/// `theme_fonts` payload must fail instead of being patched locally with a
/// renderer-owned fallback family.
#[test]
fn inv_theme_font_each_missing_role_is_configuration_error() {
  for role in ["heading", "body", "mono", "symbol"] {
    let mut doc = document_with_blocks("PartialThemeFonts", Branding::default(), vec![paragraph("hi")]);
    match role {
      "heading" => doc.options.theme_fonts.heading = None,
      "body" => doc.options.theme_fonts.body = None,
      "mono" => doc.options.theme_fonts.mono = None,
      "symbol" => doc.options.theme_fonts.symbol = None,
      _ => unreachable!(),
    }

    let err = match render_with_report(&doc, &[]) {
      Ok(_) => panic!("missing `{role}` role must fail before Typst render"),
      Err(err) => err,
    };
    let msg = format!("{err}");
    assert!(
      msg.contains("configuration error") && msg.contains(&format!("`{role}`")),
      "missing `{role}` role must be reported as configuration error, got: {msg}"
    );
  }
}

/// INV-THEME-FONT-UNKNOWN: role-based global-theme fonts are rejected per
/// requested role before Typst render.
#[test]
fn inv_theme_font_roles_unknown_families_are_configuration_error() {
  let mut doc = document_with_blocks("UnknownThemeFonts", Branding::default(), vec![paragraph("hi")]);
  doc.options.theme_fonts.heading = Some("DefinitelyNotARealThemeFont".into());
  doc.options.theme_fonts.body = Some("DefinitelyNotARealThemeFont".into());
  doc.options.theme_fonts.mono = Some("AlsoNotARealThemeFont".into());

  let err = render_with_report(&doc, &[]).expect_err("unknown theme fonts must fail");
  let msg = format!("{err}");

  assert!(
    msg.contains("configuration error")
      && msg.contains("heading")
      && msg.contains("body")
      && msg.contains("mono")
      && msg.contains("DefinitelyNotARealThemeFont")
      && msg.contains("AlsoNotARealThemeFont"),
    "unknown theme font families must be reported by role, got: {msg}"
  );
}

// ---------------------------------------------------------------------------
// Performance smoke (P3 §6 "Performance-Review mit grobem Timing fuer
// 1/20/100 Seiten"). Builds three documents whose paragraph counts are
// calibrated so a default-template render produces ~1, ~20, and ~100 pages,
// and asserts that each render completes within a generous wall-time bound.
//
// This is a *smoke* check — the upper bounds are loose on purpose so it
// flags catastrophic regressions (e.g. quadratic blowup, missed font cache,
// 30s renders) without going red on a slow CI box. Released timings are
// logged to stdout so the trend is visible in test output.
//
// Assumes default page format (~30 paragraphs/page with default body font).
// Bounds are scaled per page-class so a misjudged paragraph→page ratio
// (e.g. 18 vs 20 pages) does not flip the test.
// ---------------------------------------------------------------------------

#[test]
fn pdf_perf_smoke_1_20_100_pages() {
  fn build(paragraphs: usize) -> IrDocument {
    let blocks = (0..paragraphs)
      .map(|i| paragraph(&format!("Paragraph {i} — quick brown fox jumps over the lazy dog.")))
      .collect();
    document_with_blocks("PerfSmoke", Branding::default(), blocks)
  }

  // Calibrated against default template page-fill (~30 paragraphs / page).
  let cases: &[(usize, &str, std::time::Duration)] = &[
    (5, "1-page", std::time::Duration::from_secs(20)),
    (600, "20-page", std::time::Duration::from_secs(60)),
    (3000, "100-page", std::time::Duration::from_secs(180)),
  ];

  for &(paragraphs, label, budget) in cases {
    let doc = build(paragraphs);
    let started = std::time::Instant::now();
    let pdf = render(&doc).unwrap_or_else(|err| panic!("perf-smoke {label} render must succeed: {err:?}"));
    let elapsed = started.elapsed();
    eprintln!(
      "pdf_perf_smoke {label}: paragraphs={paragraphs} pdf_bytes={} elapsed={:?} budget={:?}",
      pdf.len(),
      elapsed,
      budget
    );
    assert!(
      elapsed < budget,
      "pdf_perf_smoke {label}: render exceeded budget — elapsed {elapsed:?} vs budget {budget:?} \
       (paragraphs={paragraphs}, pdf_bytes={}). This flags a catastrophic regression; tune the \
       budget only if the median jumped persistently after a deliberate change.",
      pdf.len()
    );
    assert_eq!(
      &pdf[..5],
      b"%PDF-",
      "perf-smoke {label}: render must produce a valid PDF"
    );
  }
}

/// Invariant: rendering the same `IrDocument` twice yields byte-identical
/// PDF output. The `ident` field of `typst_pdf::PdfOptions` is pinned to
/// `metadata.doc_id` so the PDF /ID is stable; fonts are loaded in sorted
/// order; the IR → Typst-source pass is deterministic; krilla's emitter
/// is itself deterministic for fixed inputs. If this test ever flakes,
/// something has reintroduced wall-clock time, RNG, or HashMap iteration
/// into the render pipeline. See the comment in
/// `pdf_export::typst_engine::render_to_pdf_v2_with_snapshot_limits`.
#[test]
fn inv_render_is_byte_deterministic() {
  // Pin both UUIDs so the only difference between the two render calls is
  // wall-clock time / RNG / iteration order — anything that surfaces here
  // is a real determinism break, not a `Uuid::new_v4()` artefact.
  let make = || {
    let mut doc = document_with_blocks(
      "Determinism",
      Branding::default(),
      vec![
        paragraph("First paragraph."),
        paragraph("Second paragraph with more content."),
      ],
    );
    doc.metadata.doc_id = Uuid::from_bytes([0x11; 16]);
    doc.metadata.workspace_id = Uuid::from_bytes([0x22; 16]);
    doc
  };
  let pdf_a = render(&make()).expect("first render must succeed");
  let pdf_b = render(&make()).expect("second render must succeed");

  assert_eq!(pdf_a.len(), pdf_b.len(), "pdf byte length must match between renders");
  assert_eq!(
    pdf_a, pdf_b,
    "identical IR must produce byte-identical PDF (regression in determinism contract)"
  );
}

/// Invariant: distinct `metadata.doc_id` values produce distinct PDF
/// outputs even when every other IR field is identical. Locks the
/// `ident → /ID` plumbing so a future refactor that drops the explicit
/// `Smart::Custom` would be caught — without this guard, both PDFs would
/// fall back to the title+author hash and compare equal.
#[test]
fn inv_distinct_doc_ids_produce_distinct_pdfs() {
  let mut doc_a = document_with_blocks("Same Title", Branding::default(), vec![paragraph("Body.")]);
  let mut doc_b = document_with_blocks("Same Title", Branding::default(), vec![paragraph("Body.")]);
  // Pin two distinct, deterministic doc_ids so the assertion can't pass by
  // accident from random UUIDs that already differ — we want to prove the
  // doc_id is the *only* difference and still flows into the PDF bytes.
  doc_a.metadata.doc_id = Uuid::from_bytes([0xAA; 16]);
  doc_b.metadata.doc_id = Uuid::from_bytes([0xBB; 16]);

  let pdf_a = render(&doc_a).expect("doc_a renders");
  let pdf_b = render(&doc_b).expect("doc_b renders");

  assert_ne!(
    pdf_a, pdf_b,
    "different doc_ids must propagate to distinct PDF /ID bytes"
  );
}
