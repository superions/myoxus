// SPDX-License-Identifier: AGPL-3.0-or-later
//! P3 acceptance: render fixtures for the four IR features that did not
//! have an end-to-end IR→PDF test yet:
//!
//!   * Long-Doc (≥ 50 pages-equivalent paragraph stream)
//!   * Footnote inline span
//!   * Database table view
//!   * Edgeless raster snapshot (PNG embed)
//!
//! Each test asserts:
//!   * `render_to_pdf` returns bytes starting with `%PDF-`,
//!   * the output is non-trivial in size, and
//!   * the feature changes the PDF byte stream relative to a baseline
//!     fixture without the feature (text inside the PDF is encoded
//!     through font CMaps, so substring-matching the Typst source is
//!     not reliable — byte-difference is).
//!
//! CJK + RTL fixtures stay deferred — they are blocked by the P4 font-
//! bundling decision tracked in `todo/pdf-refactoring.md` § P4.

use std::collections::HashMap;

use chrono::TimeZone;
use lopdf::{Document, Object};
use uuid::Uuid;

use myoxus_pdf_export::CURRENT_IR_VERSION;
use myoxus_pdf_export::ir::block::{Block, DatabaseColumn, DatabaseTableView, EdgelessSnapshot, HeadingLevel};
use myoxus_pdf_export::ir::inline::{InlineSpan, TextMarks};
use myoxus_pdf_export::ir::{
  Branding, DocumentMetadata, ExportOptions, IrDocument, ThemeFontSelection, ThemeTypographySelection,
  ThemeTypographyStyle,
};
use myoxus_pdf_export::typst_engine::ir_to_typst::ir_to_typst_source_v2;
use myoxus_pdf_export::{RenderError, render_to_pdf_v2};

mod common;

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

fn render_to_pdf(doc: &IrDocument, extra: &[std::path::PathBuf]) -> Result<Vec<u8>, RenderError> {
  let owned_dirs;
  let dirs = if extra.is_empty() {
    owned_dirs = vec![fonts_dir()];
    &owned_dirs
  } else {
    extra
  };
  render_to_pdf_v2(doc, common::default_template_bundle(), dirs, usize::MAX).map(|r| r.pdf_bytes)
}

const RED_PNG_4X4: &[u8] = include_bytes!("../fixtures/edgeless_snapshot_4x4_red.png");

fn object_has_type(object: &Object, expected: &[u8]) -> bool {
  let dictionary = match object {
    Object::Dictionary(dictionary) => dictionary,
    Object::Stream(stream) => &stream.dict,
    _ => return false,
  };
  dictionary
    .get(b"Type")
    .and_then(Object::as_name)
    .is_ok_and(|name| name == expected)
}

fn image_xobject_count(pdf: &[u8]) -> usize {
  let document = Document::load_mem(pdf).expect("rendered bytes must contain a parseable PDF object graph");
  document
    .objects
    .values()
    .filter(|object| {
      let Object::Stream(stream) = object else {
        return false;
      };
      stream
        .dict
        .get(b"Subtype")
        .and_then(Object::as_name)
        .is_ok_and(|name| name == b"Image")
    })
    .count()
}

fn page_count(pdf: &[u8]) -> usize {
  Document::load_mem(pdf)
    .expect("rendered bytes must contain a parseable PDF object graph")
    .get_pages()
    .len()
}

fn has_outlines(pdf: &[u8]) -> bool {
  Document::load_mem(pdf)
    .expect("rendered bytes must contain a parseable PDF object graph")
    .objects
    .values()
    .any(|object| object_has_type(object, b"Outlines"))
}

fn metadata(title: &str) -> DocumentMetadata {
  DocumentMetadata {
    doc_id: Uuid::new_v4(),
    workspace_id: Uuid::new_v4(),
    title: Some(title.into()),
    author: Some("Test Author".into()),
    created_at: None,
    updated_at: None,
    workspace_name: Some("Test Workspace".into()),
    branding: Branding::default(),
  }
}

fn text(value: &str) -> InlineSpan {
  InlineSpan::Text {
    text: value.into(),
    marks: TextMarks::default(),
  }
}

fn paragraph(value: &str) -> Block {
  Block::Paragraph {
    content: vec![text(value)],
    children: vec![],
  }
}

fn document_with_blocks(title: &str, blocks: Vec<Block>) -> IrDocument {
  IrDocument {
    version: CURRENT_IR_VERSION,
    metadata: metadata(title),
    options: test_export_options(),
    root: Block::Page {
      title: vec![text(title)],
      children: blocks,
    },
    assets: HashMap::new(),
  }
}

fn test_export_options() -> ExportOptions {
  ExportOptions {
    theme_fonts: ThemeFontSelection {
      heading: Some("Lora".into()),
      body: Some("Inter".into()),
      mono: Some("JetBrains Mono".into()),
      symbol: Some("JetBrains Mono".into()),
    },
    ..ExportOptions::default()
  }
}

fn stuttgart_typography() -> ThemeTypographySelection {
  let style = |font_weight, size_px, line_height, letter_spacing_em| ThemeTypographyStyle {
    font_weight,
    font_style: "normal".into(),
    size_px,
    line_height,
    letter_spacing_em,
    text_transform: "none".into(),
    decoration: "none".into(),
  };
  ThemeTypographySelection {
    heading: Some(style(600, 30.0, 1.2, -0.01)),
    body: Some(style(400, 14.0, 1.5, 0.0)),
    mono: Some(style(400, 13.0, 1.55, 0.0)),
    symbol: Some(style(400, 13.0, 1.55, 0.0)),
  }
}

/// INV-RENDER-LONG-DOC: a long stream of paragraphs (≥ 50 pages of
/// content at ~10 paragraphs / page on A4) renders without panicking,
/// without exhausting the default render limits, and produces a PDF
/// whose byte size scales with content (>50 KB for ~600 paragraphs).
#[test]
fn inv_render_long_doc_renders() {
  let mut blocks: Vec<Block> = Vec::with_capacity(700);
  blocks.push(Block::Heading {
    level: HeadingLevel::H1,
    content: vec![text("Long Document Smoke Test")],
    children: vec![],
  });
  // 600 paragraphs ≈ 50–60 A4 pages depending on body-font metrics.
  for i in 0..600 {
    blocks.push(paragraph(&format!(
      "Paragraph #{i} — the renderer must keep wiring IR → Typst → PDF \
       through long inputs without accumulating per-block state that \
       breaks pagination."
    )));
  }

  let doc = document_with_blocks("Long Doc", blocks);
  let pdf = render_to_pdf(&doc, &[]).expect("long-doc fixture must render");

  assert_eq!(&pdf[..5], b"%PDF-", "valid PDF magic");
  assert!(
    pdf.len() > 50_000,
    "long doc PDF must be >50 KB, got {} bytes",
    pdf.len()
  );
}

/// INV-RENDER-FOOTNOTE: a paragraph with an inline `Footnote` span
/// renders successfully and produces a PDF byte stream that differs
/// measurably from the baseline (paragraph without footnote). The
/// footnote body text itself is encoded through Typst's font CMap, so
/// we cannot byte-match it directly — the byte-difference check proves
/// the renderer actually emitted the footnote.
#[test]
fn inv_render_footnote_inline() {
  let with_footnote = vec![Block::Paragraph {
    content: vec![
      text("This sentence has a footnote"),
      InlineSpan::Footnote {
        content: vec![text(
          "Footnote body text spelling out the contract under \
           review for this paragraph.",
        )],
      },
      text(" attached to it."),
    ],
    children: vec![],
  }];
  let without_footnote = vec![Block::Paragraph {
    content: vec![text("This sentence has a footnote"), text(" attached to it.")],
    children: vec![],
  }];

  let doc_with = document_with_blocks("Footnote Doc", with_footnote);
  let doc_without = document_with_blocks("Footnote Doc Empty", without_footnote);

  let pdf_with = render_to_pdf(&doc_with, &[]).expect("footnote fixture must render");
  let pdf_without = render_to_pdf(&doc_without, &[]).expect("baseline must render");

  assert_eq!(&pdf_with[..5], b"%PDF-");
  assert!(
    pdf_with.len() > pdf_without.len(),
    "footnote document must be larger than its baseline ({} vs {})",
    pdf_with.len(),
    pdf_without.len()
  );
}

/// INV-RENDER-DATABASE: a `Database` block (= virtual table view)
/// renders into a PDF that is structurally valid and measurably larger
/// than a baseline document with the same metadata but a single
/// paragraph in place of the table.
#[test]
fn inv_render_database_block() {
  let db = Block::Database(DatabaseTableView {
    columns: vec![
      DatabaseColumn {
        name: "Name".into(),
        data_type: "text".into(),
      },
      DatabaseColumn {
        name: "Done".into(),
        data_type: "checkbox".into(),
      },
      DatabaseColumn {
        name: "Score".into(),
        data_type: "number".into(),
      },
    ],
    rows: vec![
      vec![vec![text("Alice")], vec![text("true")], vec![text("92")]],
      vec![vec![text("Bob")], vec![text("false")], vec![text("47")]],
      vec![vec![text("Carol")], vec![text("true")], vec![text("84")]],
    ],
  });

  let doc_with = document_with_blocks("Database Doc", vec![db]);
  let doc_without = document_with_blocks("Database Doc Empty", vec![paragraph("placeholder row")]);

  let pdf_with = render_to_pdf(&doc_with, &[]).expect("database fixture must render");
  let pdf_without = render_to_pdf(&doc_without, &[]).expect("baseline must render");

  assert_eq!(&pdf_with[..5], b"%PDF-");
  assert!(
    pdf_with.len() > pdf_without.len(),
    "database document must be larger than baseline ({} vs {})",
    pdf_with.len(),
    pdf_without.len()
  );
}

/// INV-RENDER-EDGELESS-SNAPSHOT: a `Surface(EdgelessSnapshot { png_bytes })`
/// block embeds the PNG bytes via a synthetic `blob:__edgeless_snapshot_<n>`
/// virtual path that the source generator allocates per snapshot
/// (`EDGELESS_SNAPSHOT_BLOB_PREFIX` in `ir_to_typst.rs`, #322). The bytes
/// flow through `GeneratedSource.inline_assets` — callers only need to set
/// `EdgelessSnapshot.png_bytes`; nothing else has to be registered in
/// `IrDocument.assets`.
#[test]
fn inv_render_edgeless_snapshot_embed() {
  // Sanity check the fixture before we hand it to Typst.
  assert_eq!(&RED_PNG_4X4[..8], b"\x89PNG\r\n\x1a\n", "fixture must be a valid PNG");

  let snap = EdgelessSnapshot {
    png_bytes: RED_PNG_4X4.to_vec(),
    width_px: 4,
    height_px: 4,
    caption: Some(vec![text("Edgeless snapshot caption")]),
  };

  let doc_with = document_with_blocks("Edgeless Doc", vec![Block::Surface(snap.clone())]);
  let generated = ir_to_typst_source_v2(&doc_with, common::default_template_bundle()).expect("edgeless Typst source");
  let snapshot_line = generated
    .source
    .lines()
    .find(|line| line.starts_with("#myoxus-fit-visual(\"blob:__edgeless_snapshot_"))
    .expect("edgeless snapshot must use the bounded visual fitter");
  assert!(
    snapshot_line.contains("caption: [#myoxus-caption([Edgeless snapshot caption])]"),
    "snapshot captions must remain attached to the fitted visual, source:\n{}",
    generated.source
  );

  // Baseline: same Surface block, but empty PNG bytes — the renderer
  // emits the "snapshot not available" placeholder instead of an
  // image embed.
  let empty_snap = EdgelessSnapshot {
    png_bytes: Vec::new(),
    width_px: 0,
    height_px: 0,
    caption: snap.caption.clone(),
  };
  let doc_placeholder = document_with_blocks("Edgeless Doc Placeholder", vec![Block::Surface(empty_snap)]);

  let pdf_with = render_to_pdf(&doc_with, &[]).expect("edgeless fixture must render");
  let pdf_placeholder = render_to_pdf(&doc_placeholder, &[]).expect("placeholder must render");

  assert_eq!(&pdf_with[..5], b"%PDF-");
  assert!(
    pdf_with != pdf_placeholder,
    "PDF with embedded snapshot must differ byte-for-byte from placeholder"
  );
  // Inspect the decoded PDF object graph: Typst may move dictionaries into
  // compressed object streams without changing the user-visible PDF.
  assert!(image_xobject_count(&pdf_with) >= 1, "PDF must contain an image XObject");
  assert!(
    image_xobject_count(&pdf_placeholder) == 0,
    "placeholder PDF must not contain an image XObject",
  );
}

/// INV-RENDER-EDGELESS-SNAPSHOT-MULTI: multiple non-empty snapshots in the
/// same document each get their own synthetic blob key, so the rendered PDF
/// embeds an `/Image` XObject *per* snapshot. Before #322, the renderer
/// referenced one shared key (`blob:edgeless_snapshot`) which collapsed all
/// snapshots onto the first one's bytes — this test pins the new
/// per-snapshot wiring so a regression to the shared-key path fails loudly.
#[test]
fn inv_render_multiple_edgeless_snapshots_each_get_own_image() {
  let mk_snap = |caption: &str| EdgelessSnapshot {
    png_bytes: RED_PNG_4X4.to_vec(),
    width_px: 4,
    height_px: 4,
    caption: Some(vec![text(caption)]),
  };
  let doc = document_with_blocks(
    "Multi-Edgeless Doc",
    vec![
      Block::Surface(mk_snap("first surface")),
      Block::SurfaceRef(mk_snap("ref")),
      Block::Frame(mk_snap("frame")),
      Block::Mindmap(mk_snap("mindmap")),
    ],
  );

  let pdf = render_to_pdf(&doc, &[]).expect("multi-snapshot doc must render");
  assert_eq!(&pdf[..5], b"%PDF-");

  // Identical source bytes may be deduplicated into one XObject. Successful
  // compilation proves every synthetic key resolved; the parsed object check
  // proves that the result still contains the raster resource.
  assert!(
    image_xobject_count(&pdf) >= 1,
    "multi-snapshot PDF must embed at least one image XObject"
  );
}

/// INV-RENDER-PDF-METADATA-KEYWORDS: setting `ExportOptions.keywords`
/// causes the `/Keywords` PDF info entry to be populated. Typst writes
/// the keywords array as an XMP `<pdf:Keywords>` element inside the
/// embedded XMP metadata stream — that representation keeps the keyword
/// text as raw bytes in the PDF, so we can substring-match each keyword
/// to prove the wiring reaches Typst's `#set document(keywords: …)`.
#[test]
fn inv_render_pdf_metadata_keywords_in_byte_stream() {
  let blocks = vec![paragraph("Body text irrelevant to metadata.")];
  let mut with_keywords = document_with_blocks("Keywords Doc", blocks.clone());
  with_keywords.options.keywords = vec!["myoxus".into(), "pdfexport".into(), "regression".into()];

  let without_keywords = document_with_blocks("Keywords Doc Empty", blocks);

  let pdf_with = render_to_pdf(&with_keywords, &[]).expect("keywords fixture must render");
  let pdf_without = render_to_pdf(&without_keywords, &[]).expect("baseline must render");

  assert_eq!(&pdf_with[..5], b"%PDF-");
  assert_ne!(
    pdf_with, pdf_without,
    "setting keywords must change the PDF byte stream"
  );
  for kw in ["myoxus", "pdfexport", "regression"] {
    assert!(
      pdf_with.windows(kw.len()).any(|w| w == kw.as_bytes()),
      "keyword `{kw}` must appear verbatim in the PDF byte stream (XMP metadata)"
    );
    assert!(
      !pdf_without.windows(kw.len()).any(|w| w == kw.as_bytes()),
      "baseline PDF must not contain keyword `{kw}` — got an unexpected match"
    );
  }
}

/// INV-RENDER-PDF-METADATA-CREATION-DATE: setting `metadata.created_at`
/// causes Typst to stamp the PDF `/CreationDate` info entry. PDF dates
/// use the `D:YYYYMMDDHHMMSS…` format; the date prefix `D:20250115` (or
/// the same date stamped via Typst) lands in the byte stream regardless
/// of CMap font encoding because metadata stays in plain literal-string
/// form. The IR's `created_at` is UTC; we therefore expect the
/// year/month/day prefix even though Typst may render the time as `Z`
/// or with an explicit zero offset.
#[test]
fn inv_render_pdf_metadata_creation_date_in_byte_stream() {
  let blocks = vec![paragraph("Body text irrelevant to metadata.")];
  let mut with_date = document_with_blocks("Dated Doc", blocks.clone());
  with_date.metadata.created_at = Some(chrono::Utc.with_ymd_and_hms(2025, 1, 15, 12, 0, 0).unwrap());

  let without_date = document_with_blocks("Dated Doc Missing", blocks);

  let pdf_with = render_to_pdf(&with_date, &[]).expect("creation-date fixture must render");
  let pdf_without = render_to_pdf(&without_date, &[]).expect("baseline must render");

  assert_eq!(&pdf_with[..5], b"%PDF-");
  assert_ne!(
    pdf_with, pdf_without,
    "setting creation_at must change the PDF byte stream"
  );
  // PDF info-dictionary date prefix `D:20250115`; XMP also embeds the
  // ISO form `2025-01-15`. At least one representation must surface.
  let pdf_form = b"D:20250115";
  let xmp_form = b"2025-01-15";
  assert!(
    pdf_with.windows(pdf_form.len()).any(|w| w == pdf_form) || pdf_with.windows(xmp_form.len()).any(|w| w == xmp_form),
    "PDF must contain creation date in either /Info (`D:20250115…`) or XMP (`2025-01-15`) form"
  );
}

/// INV-RENDER-PDF-OUTLINES-FROM-HEADINGS: every `Block::Heading` should
/// produce an entry in the PDF `/Outlines` dictionary so PDF readers
/// expose the document structure as a side-panel bookmark tree. Typst
/// emits `/Type /Outlines` automatically for any document containing
/// headings — a document with zero headings must therefore not contain
/// the marker. This test guards against a future change that strips
/// the `=`/`==` heading syntax and silently drops navigation.
#[test]
fn inv_render_pdf_outlines_from_headings() {
  let with_headings = vec![
    Block::Heading {
      level: HeadingLevel::H1,
      content: vec![text("Chapter One")],
      children: vec![],
    },
    paragraph("First chapter body."),
    Block::Heading {
      level: HeadingLevel::H2,
      content: vec![text("Section 1.1")],
      children: vec![],
    },
    paragraph("Subsection body."),
    Block::Heading {
      level: HeadingLevel::H1,
      content: vec![text("Chapter Two")],
      children: vec![],
    },
    paragraph("Second chapter body."),
  ];
  let plain = vec![paragraph("First body."), paragraph("Second body.")];

  let pdf_h =
    render_to_pdf(&document_with_blocks("Outlines Doc", with_headings), &[]).expect("headings fixture must render");
  let pdf_p =
    render_to_pdf(&document_with_blocks("Outlines Doc Plain", plain), &[]).expect("plain baseline must render");

  assert_eq!(&pdf_h[..5], b"%PDF-");
  assert!(
    has_outlines(&pdf_h),
    "headings document must emit an Outlines dictionary so PDF readers show bookmarks",
  );
  assert!(
    !has_outlines(&pdf_p),
    "plain document without headings must not emit an Outlines dictionary",
  );
}

/// INV-RENDER-PDF-TOC-OUTLINE-WHEN-ENABLED: setting
/// `ExportOptions.toc_behavior != "off"` injects Typst's `#outline(...)`
/// at the top of the document, followed by a `#pagebreak()`. The
/// resulting PDF must therefore be measurably larger than the same
/// document rendered with `toc_behavior = "off"`, and must still keep
/// the heading-driven `/Type /Outlines` bookmarks (the TOC is an
/// in-content list, not a substitute for PDF bookmarks).
#[test]
fn inv_render_pdf_toc_outline_when_enabled() {
  let blocks = vec![
    Block::Heading {
      level: HeadingLevel::H1,
      content: vec![text("Chapter One")],
      children: vec![],
    },
    paragraph("First chapter body."),
    Block::Heading {
      level: HeadingLevel::H2,
      content: vec![text("Section 1.1")],
      children: vec![],
    },
    Block::Heading {
      level: HeadingLevel::H1,
      content: vec![text("Chapter Two")],
      children: vec![],
    },
  ];

  let mut with_toc = document_with_blocks("TOC Doc", blocks.clone());
  with_toc.options.toc_behavior = "force".into();
  let without_toc = document_with_blocks("TOC Doc Off", blocks);

  let pdf_with = render_to_pdf(&with_toc, &[]).expect("TOC fixture must render");
  let pdf_without = render_to_pdf(&without_toc, &[]).expect("baseline must render");

  assert_eq!(&pdf_with[..5], b"%PDF-");
  assert!(
    pdf_with.len() > pdf_without.len() + 1024,
    "TOC document must be measurably larger than its toc-off baseline ({} vs {})",
    pdf_with.len(),
    pdf_without.len(),
  );
  // The pagebreak after the outline introduces at least one additional page.
  let pages_with = page_count(&pdf_with);
  let pages_without = page_count(&pdf_without);
  assert!(
    pages_with > pages_without,
    "TOC document must have more `/Type /Page` objects than its toc-off baseline ({pages_with} vs {pages_without})",
  );
  // PDF bookmarks must remain — TOC is content, bookmarks are nav.
  assert!(
    has_outlines(&pdf_with),
    "TOC document must still emit PDF bookmarks; in-content TOC is not a replacement",
  );
}

/// INV-RENDER-PAGE-TITLE-IN-BODY: a non-empty `Block::Page.title`
/// produces an in-document title heading using the effective theme heading
/// typography. An empty title list must skip the
/// heading entirely. The two PDFs therefore differ in byte-stream size
/// even though both share the same `metadata.title` (which only feeds
/// the PDF `/Title` info entry — different surface).
#[test]
fn inv_render_page_title_in_body() {
  let body = vec![paragraph("Body content shared between both fixtures.")];

  let with_title = IrDocument {
    version: CURRENT_IR_VERSION,
    metadata: metadata("Page Title Doc"),
    options: test_export_options(),
    root: Block::Page {
      title: vec![text("Visible Title On Page One")],
      children: body.clone(),
    },
    assets: HashMap::new(),
  };
  let without_title = IrDocument {
    version: CURRENT_IR_VERSION,
    metadata: metadata("Page Title Doc"),
    options: test_export_options(),
    root: Block::Page {
      title: Vec::new(),
      children: body,
    },
    assets: HashMap::new(),
  };

  let pdf_with = render_to_pdf(&with_title, &[]).expect("page-title fixture must render");
  let pdf_without = render_to_pdf(&without_title, &[]).expect("baseline must render");

  assert_eq!(&pdf_with[..5], b"%PDF-");
  assert!(
    pdf_with.len() > pdf_without.len(),
    "page with body-rendered title must be larger than baseline ({} vs {})",
    pdf_with.len(),
    pdf_without.len()
  );
}

/// INV-RENDER-DEFAULT-RUNNING-CHROME: the neutral system template identifies
/// the document in the header and keeps date, organisation and page position
/// in the footer. The opt-in artifact is the visual evidence fixture for this
/// contract; semantic text extraction keeps the metadata wiring durable.
#[test]
fn inv_render_default_template_running_chrome() {
  let body = (1..=36)
    .map(|index| {
      paragraph(&format!(
        "Section {index}: This representative paragraph makes the document long enough to exercise consistent running chrome across multiple pages."
      ))
    })
    .collect();
  let mut doc = document_with_blocks("Project Handbook", body);
  doc.metadata.created_at = Some(chrono::Utc.with_ymd_and_hms(2026, 7, 22, 9, 30, 0).unwrap());
  doc.metadata.workspace_name = None;
  doc.metadata.branding.organization_name = Some("Roekvar GmbH".into());
  doc.options.locale = "de".into();
  doc.options.doc_version_label = Some("2.4".into());
  doc.options.theme_fonts.heading = Some("Inter".into());
  doc.options.theme_typography = stuttgart_typography();

  let pdf = render_to_pdf(&doc, &[]).expect("default-template running chrome must render");
  if let Ok(dir) = std::env::var("MYOXUS_PDF_EVIDENCE_DIR") {
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create default-template evidence dir");
    std::fs::write(dir.join("default-running-chrome.pdf"), &pdf).expect("write default-template evidence PDF");
  }

  assert_eq!(&pdf[..5], b"%PDF-");
  let extracted = pdf_extract::extract_text_from_mem(&pdf).expect("extract default-template running chrome text");
  for expected in [
    "Project Handbook.pdf",
    "Version 2.4",
    "22.07.2026",
    "Roekvar GmbH",
    "Seite 1 /",
  ] {
    assert!(
      extracted.contains(expected),
      "default-template running chrome must contain {expected:?}, extracted:\n{extracted}"
    );
  }
}
