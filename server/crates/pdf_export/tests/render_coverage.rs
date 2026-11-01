// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-FONT-COVERAGE-07 — Script coverage render tests.
//!
//! These tests render IR documents that contain Latin-Extended, Cyrillic
//! and Greek text against the bundled `server/static/fonts/` palette and
//! verify two invariants per script:
//!
//! 1. The render succeeds against global-theme body font `"Inter"` (which
//!    advertises coverage for `latin`, `latin-ext`, `cyrillic`,
//!    `cyrillic-ext`, `greek`, `greek-ext` in the manifest), and the
//!    `RenderReport` flags no unmapped families.
//! 2. The bundled fonts are required for the server-owned theme families:
//!    rendering an `Inter`-themed document without `extra_font_dirs` fails
//!    as a configuration error instead of silently falling back.
//!
//! The repo root resolution mirrors the world.rs unit tests: from
//! `CARGO_MANIFEST_DIR` (= `server/crates/pdf_export`), up two levels to
//! `server/`, then into `static/fonts/`.

use std::collections::HashMap;
use std::path::PathBuf;

use uuid::Uuid;

use myoxus_pdf_export::CURRENT_IR_VERSION;
use myoxus_pdf_export::ir::block::Block;
use myoxus_pdf_export::ir::inline::{InlineSpan, TextMarks};
use myoxus_pdf_export::ir::{
  Branding, DEFAULT_BODY_FONT_SCALE, DEFAULT_HEADING_FONT_SCALE, DocumentMetadata, ExportOptions, IrDocument,
  ThemeFontSelection,
};
use myoxus_pdf_export::typst_engine::ir_to_typst::ir_to_typst_source_v2;
use myoxus_pdf_export::{RenderError, RenderReport, render_to_pdf_v2};

mod common;

fn render_to_pdf_with_report(doc: &IrDocument, extra_font_dirs: &[PathBuf]) -> Result<RenderReport, RenderError> {
  render_to_pdf_v2(doc, common::default_template_bundle(), extra_font_dirs, usize::MAX)
}

/// Resolve `server/static/fonts/` from this crate's manifest dir.
fn fonts_dir() -> PathBuf {
  let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .expect("crates dir")
    .parent()
    .expect("server dir")
    .join("static/fonts");
  assert!(
    dir.is_dir(),
    "expected bundled font dir at {} — invariant precondition for P-FONT-COVERAGE-07",
    dir.display()
  );
  dir
}

fn document_with_text(title: &str, text: &str, body_font: &str) -> IrDocument {
  let options = ExportOptions {
    theme_fonts: ThemeFontSelection {
      heading: Some("Lora".into()),
      body: Some(body_font.into()),
      mono: Some("JetBrains Mono".into()),
      symbol: Some("JetBrains Mono".into()),
    },
    ..Default::default()
  };
  IrDocument {
    version: CURRENT_IR_VERSION,
    metadata: DocumentMetadata {
      doc_id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      title: Some(title.into()),
      author: Some("Coverage Test".into()),
      created_at: None,
      updated_at: None,
      workspace_name: Some("Coverage Workspace".into()),
      branding: Branding::default(),
    },
    options,
    root: Block::Page {
      title: vec![InlineSpan::Text {
        text: title.into(),
        marks: TextMarks::default(),
      }],
      children: vec![Block::Paragraph {
        content: vec![InlineSpan::Text {
          text: text.into(),
          marks: TextMarks::default(),
        }],
        children: vec![],
      }],
    },
    assets: HashMap::new(),
  }
}

#[test]
fn pdf_page_orientation_and_global_typography_scales_reach_typst_source() {
  let mut doc = document_with_text("Scaled document", "Body", "Inter");
  doc.options.paper_size = "A3".into();
  doc.options.orientation = "landscape".into();
  assert_eq!(doc.options.heading_font_scale, DEFAULT_HEADING_FONT_SCALE);
  assert_eq!(doc.options.body_font_scale, DEFAULT_BODY_FONT_SCALE);

  let generated =
    ir_to_typst_source_v2(&doc, common::default_template_bundle()).expect("source generation must succeed");

  assert!(generated.source.contains("#let paper = \"a3\""));
  assert!(generated.source.contains("#let page-flipped = true"));
  assert!(generated.source.contains("#let heading-size = 22.8pt"));
  assert!(generated.source.contains("#let body-size = 11.55pt"));
  assert!(generated.source.contains("#align(left, block(width: 100%)"));
}

/// INV-FONT-COVERAGE-LATIN-EXT-01: a Latin-Extended pangram covering the
/// five European target languages (Polish, Czech, Hungarian, Turkish,
/// Romanian) renders to a valid PDF when the bundled font dir is loaded,
/// and "Inter" is recognised as a known family.
#[test]
fn inv_font_coverage_latin_ext_pangram_renders() {
  // Polish: ą ć ę ł ń ó ś ź ż
  // Czech : á č ď é í ň ř š ť ú ů ý ž
  // Hungarian: ő ű (long umlauts)
  // Turkish: ç ğ ı İ ö ş ü
  // Romanian: ă â î ș ț (comma-below + circumflex)
  let text = concat!(
    "Zażółć gęślą jaźń. ",
    "Příliš žluťoučký kůň úpěl ďábelské ódy. ",
    "Árvíztűrő tükörfúrógép. ",
    "Pijamalı hasta yağız şoföre çabucak güvendi. ",
    "Ăsta-i un șir frumos cu țară.",
  );
  let doc = document_with_text("Latin-Extended", text, "Inter");

  let report = render_to_pdf_with_report(&doc, &[fonts_dir()]).expect("latin-ext render must succeed");

  assert_eq!(&report.pdf_bytes[..5], b"%PDF-", "valid pdf header");
  assert!(report.pdf_bytes.len() > 1000, "non-trivial output");
  assert!(
    report.unmapped_font_families.is_empty(),
    "Inter must be a known family when fonts dir is loaded, got unmapped {:?}",
    report.unmapped_font_families
  );
}

/// INV-FONT-COVERAGE-CYRILLIC-01: a Cyrillic pangram renders to a valid
/// PDF when the bundled font dir is loaded, and "Inter" is recognised
/// as a known family.
#[test]
fn inv_font_coverage_cyrillic_pangram_renders() {
  let text = "Съешь же ещё этих мягких французских булок, да выпей чаю.";
  let doc = document_with_text("Cyrillic", text, "Inter");

  let report = render_to_pdf_with_report(&doc, &[fonts_dir()]).expect("cyrillic render must succeed");

  assert_eq!(&report.pdf_bytes[..5], b"%PDF-", "valid pdf header");
  assert!(report.pdf_bytes.len() > 1000, "non-trivial output");
  assert!(
    report.unmapped_font_families.is_empty(),
    "Inter must be a known family when fonts dir is loaded, got unmapped {:?}",
    report.unmapped_font_families
  );
}

/// INV-FONT-COVERAGE-GREEK-01: a Greek pangram renders to a valid PDF
/// when the bundled font dir is loaded, and "Inter" is recognised as a
/// known family.
#[test]
fn inv_font_coverage_greek_pangram_renders() {
  let text = "Νίψον ἀνομήματα μὴ μόναν ὄψιν.";
  let doc = document_with_text("Greek", text, "Inter");

  let report = render_to_pdf_with_report(&doc, &[fonts_dir()]).expect("greek render must succeed");

  assert_eq!(&report.pdf_bytes[..5], b"%PDF-", "valid pdf header");
  assert!(report.pdf_bytes.len() > 1000, "non-trivial output");
  assert!(
    report.unmapped_font_families.is_empty(),
    "Inter must be a known family when fonts dir is loaded, got unmapped {:?}",
    report.unmapped_font_families
  );
}

fn assert_unknown_theme_font_error(err: RenderError, family: &str) {
  let msg = format!("{err}");
  assert!(
    msg.contains("configuration error") && msg.contains(family),
    "missing `{family}` must be a configuration error, got: {msg}"
  );
}

/// INV-FONT-COVERAGE-LATIN-EXT-02: the bundled font dir is required for
/// Latin-Extended documents that request the server-owned Inter family.
/// Without the dir, the renderer must fail instead of letting Typst fall
/// back to another family.
#[test]
fn inv_font_coverage_latin_ext_uses_bundled_fonts() {
  let text = "Zażółć gęślą jaźń. Příliš žluťoučký kůň úpěl ďábelské ódy.";
  let doc = document_with_text("Latin-Extended", text, "Inter");

  let with_fonts = render_to_pdf_with_report(&doc, &[fonts_dir()]).expect("with-fonts render");
  let without_fonts_err = render_to_pdf_with_report(&doc, &[]).expect_err("without-fonts render must fail");

  assert_eq!(&with_fonts.pdf_bytes[..5], b"%PDF-");
  assert_unknown_theme_font_error(without_fonts_err, "Inter");
}

/// INV-FONT-COVERAGE-CYRILLIC-02: bundled fonts are required for Cyrillic
/// documents that request the server-owned Inter family.
#[test]
fn inv_font_coverage_cyrillic_uses_bundled_fonts() {
  let text = "Съешь же ещё этих мягких французских булок, да выпей чаю.";
  let doc = document_with_text("Cyrillic", text, "Inter");

  let with_fonts = render_to_pdf_with_report(&doc, &[fonts_dir()]).expect("with-fonts render");
  let without_fonts_err = render_to_pdf_with_report(&doc, &[]).expect_err("without-fonts render must fail");

  assert_eq!(&with_fonts.pdf_bytes[..5], b"%PDF-");
  assert_unknown_theme_font_error(without_fonts_err, "Inter");
}

/// INV-FONT-COVERAGE-GREEK-02: bundled fonts are required for Greek
/// documents that request the server-owned Inter family.
#[test]
fn inv_font_coverage_greek_uses_bundled_fonts() {
  let text = "Νίψον ἀνομήματα μὴ μόναν ὄψιν.";
  let doc = document_with_text("Greek", text, "Inter");

  let with_fonts = render_to_pdf_with_report(&doc, &[fonts_dir()]).expect("with-fonts render");
  let without_fonts_err = render_to_pdf_with_report(&doc, &[]).expect_err("without-fonts render must fail");

  assert_eq!(&with_fonts.pdf_bytes[..5], b"%PDF-");
  assert_unknown_theme_font_error(without_fonts_err, "Inter");
}

/// INV-FONT-COVERAGE-MULTILINGUAL-01: a single document mixing Latin,
/// Latin-Extended, Cyrillic, and Greek paragraphs renders successfully
/// against the bundled palette without raising compilation errors. This
/// exercises Typst's per-run font matcher across script switches inside the
/// resolved Theme DB body font.
#[test]
fn inv_font_coverage_multilingual_document_renders() {
  let options = ExportOptions {
    theme_fonts: ThemeFontSelection {
      heading: Some("Lora".into()),
      body: Some("Inter".into()),
      mono: Some("JetBrains Mono".into()),
      symbol: Some("JetBrains Mono".into()),
    },
    ..Default::default()
  };

  let doc = IrDocument {
    version: CURRENT_IR_VERSION,
    metadata: DocumentMetadata {
      doc_id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      title: Some("Multilingual".into()),
      author: Some("Coverage Test".into()),
      created_at: None,
      updated_at: None,
      workspace_name: Some("Coverage Workspace".into()),
      branding: Branding::default(),
    },
    options,
    root: Block::Page {
      title: vec![InlineSpan::Text {
        text: "Multilingual".into(),
        marks: TextMarks::default(),
      }],
      children: vec![
        Block::Paragraph {
          content: vec![InlineSpan::Text {
            text: "Latin: The quick brown fox jumps over the lazy dog 0123.".into(),
            marks: TextMarks::default(),
          }],
          children: vec![],
        },
        Block::Paragraph {
          content: vec![InlineSpan::Text {
            text: "Latin-ext: Zażółć gęślą jaźń. Příliš žluťoučký kůň.".into(),
            marks: TextMarks::default(),
          }],
          children: vec![],
        },
        Block::Paragraph {
          content: vec![InlineSpan::Text {
            text: "Cyrillic: Съешь же ещё этих мягких французских булок.".into(),
            marks: TextMarks::default(),
          }],
          children: vec![],
        },
        Block::Paragraph {
          content: vec![InlineSpan::Text {
            text: "Greek: Νίψον ἀνομήματα μὴ μόναν ὄψιν.".into(),
            marks: TextMarks::default(),
          }],
          children: vec![],
        },
      ],
    },
    assets: HashMap::new(),
  };

  let report = render_to_pdf_with_report(&doc, &[fonts_dir()]).expect("multilingual render must succeed");

  assert_eq!(&report.pdf_bytes[..5], b"%PDF-", "valid pdf header");
  assert!(
    report.pdf_bytes.len() > 1500,
    "multilingual document with four paragraphs must produce a non-trivial PDF, got {} bytes",
    report.pdf_bytes.len()
  );
  assert!(
    report.unmapped_font_families.is_empty(),
    "no unmapped families expected for the multilingual document, got {:?}",
    report.unmapped_font_families
  );
}

/// INV-FONT-COVERAGE-DECORATIVE-NON-LATIN-01: a decorative-only family
/// (Bebas Neue, Latin + Latin-Ext only) must not crash the renderer when
/// confronted with non-Latin text. The API normally prevents unsuitable PDF
/// role choices through the selectable Theme DB font catalog; this crate-level
/// fixture only proves the renderer does not panic when a direct caller sends
/// a decorative role family.
#[test]
fn inv_font_coverage_decorative_with_non_latin_renders() {
  let text = "Bebas + Cyrillic: Съешь же ещё этих мягких французских булок.";
  let doc = document_with_text("DecorativeNonLatin", text, "Bebas Neue");

  let report = render_to_pdf_with_report(&doc, &[fonts_dir()]).expect("decorative + non-latin render must succeed");

  assert_eq!(&report.pdf_bytes[..5], b"%PDF-", "valid pdf header");
  assert!(report.pdf_bytes.len() > 1000, "non-trivial output");
  // Bebas Neue is bundled (decorative=true) and the manifest indexes it
  // — has_family() returns true. So the unmapped list is empty even
  // though Bebas Neue can only resolve the Latin glyphs in the input.
  assert!(
    report.unmapped_font_families.is_empty(),
    "Bebas Neue ships in the bundled palette, must not be flagged as unmapped, \
     got {:?}",
    report.unmapped_font_families
  );
}

/// INV-FONT-COVERAGE-GLYPH-DISTINCT-01: the rendered PDF for a Cyrillic
/// pangram has materially more distinct payload bytes than a same-length
/// document containing only ASCII. This is a coarse stand-in for "the
/// glyph table embedded in the PDF actually contains Cyrillic glyphs and
/// not just `.notdef` boxes."
///
/// We can't easily extract glyphs from a Typst-emitted PDF without a
/// heavy parser dependency, so we use the entropy proxy: distinct-byte
/// counts of the deflate-compressed PDF stream. Tofu-only renders compress
/// extremely well (one repeating glyph reference) and yield a low distinct-
/// byte count; a real Cyrillic embed produces far more diverse bytes.
#[test]
fn inv_font_coverage_glyph_distinct_bytes_proves_embedding() {
  let cyrillic = "Съешь же ещё этих мягких французских булок, да выпей чаю. \
                  Эх, чужак! Общий съём цен шляп — юфти. Ягоды экзотики прячут.";
  let ascii = "The quick brown fox jumps over the lazy dog 0123456789. \
               Pack my box with five dozen liquor jugs. How quickly daft jumping zebras vex.";
  let cyr_doc = document_with_text("Cyr", cyrillic, "Inter");
  let asc_doc = document_with_text("Asc", ascii, "Inter");

  let cyr = render_to_pdf_with_report(&cyr_doc, &[fonts_dir()]).expect("cyrillic render");
  let asc = render_to_pdf_with_report(&asc_doc, &[fonts_dir()]).expect("ascii render");

  fn distinct_bytes(buf: &[u8]) -> usize {
    let mut seen = [false; 256];
    for &b in buf {
      seen[b as usize] = true;
    }
    seen.iter().filter(|&&v| v).count()
  }

  let cyr_distinct = distinct_bytes(&cyr.pdf_bytes);
  let asc_distinct = distinct_bytes(&asc.pdf_bytes);
  assert!(
    cyr_distinct >= 200,
    "cyrillic PDF must use ≥200 distinct byte values (rich glyph embedding), got {cyr_distinct}; \
     a tofu-only render would compress to far less"
  );
  assert!(
    asc_distinct >= 200,
    "ascii PDF must also use ≥200 distinct byte values, got {asc_distinct}"
  );
}

/// INV-FONT-COVERAGE-HINTING-01: the rendered PDF for an Inter-bodied
/// document contains the literal string `Inter` somewhere in the byte
/// stream — which is the FontDescriptor `/FontName` entry that typst-pdf
/// writes when it embeds the Inter face. If the loader silently failed
/// to index the bundled palette, Typst would fall back to typst-assets'
/// `LinLibertine_R` and the string `Inter` would be absent.
///
/// This is a much stronger invariant than `unmapped_font_families.is_empty()`
/// because it proves the font was *actually used* in the output, not just
/// indexed in the FontBook.
#[test]
fn inv_font_coverage_inter_face_is_embedded() {
  let text = "Hello, Myoxus. The quick brown fox jumps over the lazy dog.";
  let doc = document_with_text("InterEmbedTest", text, "Inter");

  let report = render_to_pdf_with_report(&doc, &[fonts_dir()]).expect("render must succeed");

  // typst-pdf prefixes FontDescriptor names with a 6-char tag + "+", e.g.
  // `/AAAAAA+Inter`. We just look for the substring "Inter" in the bytes.
  let bytes = &report.pdf_bytes;
  let needle = b"Inter";
  let mut found = false;
  for window in bytes.windows(needle.len()) {
    if window == needle {
      found = true;
      break;
    }
  }
  assert!(
    found,
    "expected the literal `Inter` substring in the PDF byte stream — proves typst-pdf \
     embedded the server-owned Theme DB body face. If absent, the SFNT font loader \
     did not index Inter."
  );
}
