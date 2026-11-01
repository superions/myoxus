// SPDX-License-Identifier: AGPL-3.0-or-later
//! V2 PDF render contracts for validated template bundles.
//!
//! These tests inspect compiled PDF content, metadata, typography and page
//! behavior, including local bundle imports and long-document customization.

use std::collections::HashMap;
use std::sync::OnceLock;

use uuid::Uuid;

use myoxus_pdf_export::ir::block::{
  AssetData, BlobRef, Block, CalloutVariant, CodeBlock, HeadingLevel, ImageRef, ListType, MermaidDiagram,
  TableAppearance, TableCell, TableDensity, TableRow,
};
use myoxus_pdf_export::ir::inline::{InlineSpan, TextMarks};
use myoxus_pdf_export::ir::{
  Branding, DEFAULT_BODY_FONT_SCALE, DEFAULT_HEADING_FONT_SCALE, DocumentMetadata, ExportOptions, IrDocument,
  ThemeFontSelection, ThemeTypographySelection, ThemeTypographyStyle,
};
use myoxus_pdf_export::render_to_pdf_v2;
use myoxus_pdf_export::typst_engine::ir_to_typst::ir_to_typst_source_v2;

mod common;

/// Tests share the same default-template bundle so the cargo test
/// runner doesn't re-read the files on every test.
static BUNDLE: OnceLock<HashMap<String, Vec<u8>>> = OnceLock::new();

fn bundle() -> &'static HashMap<String, Vec<u8>> {
  BUNDLE.get_or_init(|| {
    // Load the bundled V2 default template files. Path is relative to
    // the pdf_export crate root (`server/crates/pdf_export/`).
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let base = manifest_dir.join("../../templates/pdf/default");
    let read = |name: &str| std::fs::read(base.join(name)).unwrap_or_else(|e| panic!("read {name}: {e}"));
    let mut m = HashMap::new();
    m.insert("main.typ".into(), read("main.typ"));
    m.insert("preamble.typ".into(), read("preamble.typ"));
    m.insert("theme.typ".into(), read("theme.typ"));
    m.insert("i18n/en.json".into(), read("i18n/en.json"));
    m.insert("i18n/de.json".into(), read("i18n/de.json"));
    m
  })
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

fn doc(title: &str) -> IrDocument {
  IrDocument {
    version: myoxus_pdf_export::CURRENT_IR_VERSION,
    metadata: DocumentMetadata {
      doc_id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      title: Some(title.to_owned()),
      author: None,
      created_at: None,
      updated_at: None,
      workspace_name: None,
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
    assets: HashMap::new(),
    root: Block::Page {
      title: vec![],
      children: vec![],
    },
  }
}

fn typography_style(font_weight: u16, size_px: f64, line_height: f64, letter_spacing_em: f64) -> ThemeTypographyStyle {
  ThemeTypographyStyle {
    font_weight,
    font_style: "normal".into(),
    size_px,
    line_height,
    letter_spacing_em,
    text_transform: "none".into(),
    decoration: "none".into(),
  }
}

#[test]
fn mermaid_block_emits_first_class_typst_source() {
  let mut doc = doc("Mermaid Source");
  doc.root = Block::Page {
    title: vec![text("Mermaid Source")],
    children: vec![Block::Mermaid(MermaidDiagram {
      source: "flowchart TD\n  A --> B".into(),
      title: Some(vec![text("Process")]),
      caption: Some(vec![text("Visible process caption")]),
    })],
  };

  let generated = ir_to_typst_source_v2(&doc, bundle()).expect("source generation");
  assert!(
    generated.source.contains("#myoxus-fit-visual(\"blob:__mermaid_"),
    "Mermaid must use the bounded visual fitter, source:\n{}",
    generated.source
  );
  let mermaid_figure = generated
    .source
    .lines()
    .find(|line| line.starts_with("#myoxus-fit-visual(\"blob:__mermaid_"))
    .expect("Mermaid figure");
  assert!(
    !mermaid_figure.contains("width: 100%"),
    "small diagrams must retain their natural size instead of being enlarged to page width, source:\n{}",
    generated.source
  );
  assert!(
    generated
      .source
      .contains("calc.min(1, max-width.pt() / natural.width.pt(), max-height.pt() / natural.height.pt())"),
    "the fitter must contain visuals on both axes without enlarging small diagrams, source:\n{}",
    generated.source
  );
  assert!(
    generated.source.contains("block(breakable: false, width: 100%)"),
    "a diagram must move as one unit instead of splitting across pages, source:\n{}",
    generated.source
  );
  assert!(
    generated
      .source
      .contains("caption: [#myoxus-caption([Process: Visible process caption])]"),
    "Mermaid title and caption must remain visible, source:\n{}",
    generated.source
  );
  let svg = generated
    .inline_assets
    .iter()
    .find(|(key, _)| key.starts_with("__mermaid_") && key.ends_with(".svg"))
    .map(|(_, bytes)| String::from_utf8(bytes.clone()).expect("svg utf8"))
    .expect("Mermaid SVG inline asset");
  assert!(svg.contains("<svg"), "svg asset must be SVG: {svg}");
  assert!(
    svg.contains("A") || svg.contains("B"),
    "diagram labels must remain readable: {svg}"
  );
  assert!(
    !generated.source.contains("unsupported block"),
    "Mermaid must not fall through to Unknown, source:\n{}",
    generated.source
  );
}

#[test]
fn mermaid_block_renders_svg_asset_into_pdf() {
  let mut mermaid_doc = doc("Mermaid PDF");
  mermaid_doc.root = Block::Page {
    title: vec![text("Mermaid PDF")],
    children: vec![Block::Mermaid(MermaidDiagram {
      source: "flowchart TD\n  A[Start] --> B[Done]".into(),
      title: Some(vec![text("Process")]),
      caption: Some(vec![text("Visible process caption")]),
    })],
  };

  let report = render_to_pdf_v2(&mermaid_doc, bundle(), &[], usize::MAX).expect("Mermaid PDF render");
  assert!(report.pdf_bytes.starts_with(b"%PDF-"));
  assert!(report.pdf_bytes.len() > 1024);
  let extracted = pdf_extract::extract_text_from_mem(&report.pdf_bytes).expect("extract text");
  assert!(
    extracted.contains("Process") && extracted.contains("Visible process caption"),
    "caption text must survive PDF render, extracted:\n{extracted}"
  );

  // Keep artifact generation opt-in so normal test runs stay hermetic while
  // release/stable reviews can inspect the exact PDF and Typst source.
  if let Ok(dir) = std::env::var("MYOXUS_PDF_EXPORT_ARTIFACT_DIR") {
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create PDF artifact dir");
    std::fs::write(dir.join("mermaid-diagram-review.pdf"), &report.pdf_bytes).expect("write Mermaid review PDF");
    let generated = ir_to_typst_source_v2(&mermaid_doc, bundle()).expect("Mermaid review Typst source");
    std::fs::write(dir.join("mermaid-diagram-review.typ"), &generated.source)
      .expect("write Mermaid review Typst source");
    if let Some((_, svg)) = generated
      .inline_assets
      .iter()
      .find(|(key, _)| key.starts_with("__mermaid_") && key.ends_with(".svg"))
    {
      std::fs::write(dir.join("mermaid-diagram-review.svg"), svg).expect("write Mermaid review SVG");
    }
  }
}

fn text(value: &str) -> InlineSpan {
  InlineSpan::Text {
    text: value.to_owned(),
    marks: TextMarks::default(),
  }
}

fn paragraph(value: &str) -> Block {
  Block::Paragraph {
    content: vec![text(value)],
    children: vec![],
  }
}

#[test]
fn nested_callout_boxes_compile_and_keep_all_text_across_pages() {
  let mut document = doc("Nested callouts");
  let mut children = vec![Block::Callout {
    variant: CalloutVariant::Tip,
    emoji: None,
    content: vec![text("Nested recovery instruction")],
    children: vec![paragraph("Inner retained body")],
  }];
  children.extend((0..80).map(|index| paragraph(&format!("Retained outer instruction {index}"))));
  document.root = Block::Page {
    title: Vec::new(),
    children: vec![
      Block::Callout {
        variant: CalloutVariant::Warning,
        emoji: None,
        content: vec![text("Outer deployment approval")],
        children,
      },
      paragraph("Outside the callout"),
    ],
  };
  let generated = ir_to_typst_source_v2(&document, bundle()).expect("nested callout source");
  assert!(generated.source.contains("breakable: true"));
  let outer_body = myoxus_pdf_export::typst_engine::ir_to_typst::render_inline(&[text("Outer deployment approval")]);
  assert!(!generated.source.contains(&format!("{outer_body}]")));
  let rendered = render_to_pdf_v2(&document, bundle(), &[fonts_dir()], usize::MAX)
    .expect("nested callouts must compile across page boundaries");
  let pages = common::pdf_page_text(&rendered.pdf_bytes);
  assert!(pages.len() > 1, "long callout must continue across pages");
  let all_text = pages.join("\n");
  for expected in [
    "Outer deployment approval",
    "Nested recovery instruction",
    "Inner retained body",
    "Outside the callout",
  ] {
    assert!(all_text.contains(expected), "missing callout text: {expected}");
  }
  for index in 0..80 {
    assert!(all_text.contains(&format!("Retained outer instruction {index}")));
  }
}

fn table_cell(value: &str, is_header: bool, align: Option<&str>) -> TableCell {
  TableCell {
    content: vec![text(value)],
    is_header,
    col_span: 1,
    row_span: 1,
    align: align.map(str::to_owned),
    fill: None,
    foreground: None,
  }
}

fn pdf_rgb_paints(bytes: &[u8]) -> Vec<[f32; 3]> {
  let pdf = lopdf::Document::load_mem(bytes).expect("PDF paint inspection");
  pdf
    .get_pages()
    .values()
    .flat_map(|page| {
      let content = pdf.get_page_content(*page).expect("page content stream");
      lopdf::content::Content::decode(&content)
        .expect("PDF drawing operations")
        .operations
    })
    .filter_map(|operation| {
      if !matches!(operation.operator.as_str(), "rg" | "RG" | "sc" | "SC" | "scn" | "SCN")
        || operation.operands.len() != 3
      {
        return None;
      }
      Some(std::array::from_fn(|i| {
        operation.operands[i].as_float().expect("RGB channel")
      }))
    })
    .collect()
}

fn pdf_stroked_paths(bytes: &[u8]) -> usize {
  let pdf = lopdf::Document::load_mem(bytes).expect("PDF path inspection");
  pdf
    .get_pages()
    .values()
    .flat_map(|page| {
      let content = pdf.get_page_content(*page).expect("page content stream");
      lopdf::content::Content::decode(&content)
        .expect("PDF drawing operations")
        .operations
    })
    .filter(|operation| matches!(operation.operator.as_str(), "S" | "s"))
    .count()
}

#[test]
fn table_typst_distinguishes_legacy_and_explicit_header_rows() {
  for (header_rows, expected) in [(None, 1), (Some(0), 0), (Some(1), 1), (Some(2), 2)] {
    let mut document = doc("Header rows");
    document.root = Block::Table {
      rows: vec![
        TableRow {
          cells: vec![table_cell("First", false, None)],
        },
        TableRow {
          cells: vec![table_cell("Second", false, None)],
        },
      ],
      caption: None,
      header_rows,
      column_widths: None,
      appearance: None,
      density: None,
    };
    let source = ir_to_typst_source_v2(&document, bundle()).expect("Typst source");
    assert!(
      source
        .source
        .contains(&format!("fill: (col, row) => if row < {expected}")),
      "headerRows={header_rows:?} must style exactly {expected} leading rows",
    );
    assert_eq!(
      source.source.contains("table.header("),
      expected > 0,
      "semantic header rows must use Typst's repeatable table header",
    );
  }
}

#[test]
fn table_appearance_and_density_map_to_valid_typst_geometry() {
  for (appearance, density, expected_stroke, expected_inset) in [
    (
      TableAppearance::Grid,
      TableDensity::Normal,
      "stroke: 0.35pt + rgb(rule-color)",
      "inset: (x: 0.7em, y: 0.45em)",
    ),
    (
      TableAppearance::Grid,
      TableDensity::Compact,
      "stroke: 0.35pt + rgb(rule-color)",
      "inset: (x: 0.45em, y: 0.27em)",
    ),
    (
      TableAppearance::Ruled,
      TableDensity::Normal,
      "stroke: (x: none, y: 0.35pt + rgb(rule-color))",
      "inset: (x: 0.7em, y: 0.45em)",
    ),
    (
      TableAppearance::Ruled,
      TableDensity::Compact,
      "stroke: (x: none, y: 0.35pt + rgb(rule-color))",
      "inset: (x: 0.45em, y: 0.27em)",
    ),
    (
      TableAppearance::Plain,
      TableDensity::Normal,
      "stroke: none",
      "inset: (x: 0.7em, y: 0.45em)",
    ),
    (
      TableAppearance::Plain,
      TableDensity::Compact,
      "stroke: none",
      "inset: (x: 0.45em, y: 0.27em)",
    ),
  ] {
    let mut document = doc("Table presentation");
    document.root = Block::Table {
      rows: vec![TableRow {
        cells: vec![table_cell("Cell", false, None)],
      }],
      caption: None,
      column_widths: None,
      header_rows: Some(0),
      appearance: Some(appearance),
      density: Some(density),
    };
    let source = ir_to_typst_source_v2(&document, bundle()).expect("Typst source");
    assert!(source.source.contains(expected_stroke));
    assert!(source.source.contains(expected_inset));
    let rendered = render_to_pdf_v2(&document, bundle(), &[], usize::MAX).expect("table PDF");
    assert!(rendered.pdf_bytes.starts_with(b"%PDF-"));
  }
}

#[test]
fn native_table_paint_survives_color_and_monochrome_rendering() {
  let mut document = doc("Native risk classes");
  let mut green = table_cell("Low risk with retained label", false, Some("center"));
  green.fill = Some("#c7e5d2".into());
  green.foreground = Some("#000000".into());
  document.root = Block::Table {
    rows: vec![TableRow {
      cells: vec![
        green,
        table_cell("Medium", false, None),
        table_cell("High", false, Some("right")),
      ],
    }],
    caption: None,
    column_widths: Some(vec![240.0, 120.0, 60.0]),
    header_rows: Some(0),
    appearance: Some(TableAppearance::Ruled),
    density: Some(TableDensity::Compact),
  };
  let source = ir_to_typst_source_v2(&document, bundle()).expect("paint source");
  assert!(source.source.contains("#block[\n#set par(justify: false)\n#table("));
  assert!(source.source.contains("#table(columns: (1fr, 0.5fr, 0.25fr,)"));
  assert!(
    source
      .source
      .contains("table.cell(align: center, fill: native-table-color(\"#c7e5d2\"))")
  );
  for variant in ["full", "mono"] {
    document.options.color_variant = Some(variant.into());
    let rendered = render_to_pdf_v2(&document, bundle(), &[], usize::MAX).expect("painted native PDF");
    let paints = pdf_rgb_paints(&rendered.pdf_bytes);
    let green_present = paints.iter().any(|color| {
      color
        .iter()
        .zip([199.0 / 255.0, 229.0 / 255.0, 210.0 / 255.0])
        .all(|(a, b)| (a - b).abs() < 0.001)
    });
    assert_eq!(
      green_present,
      variant == "full",
      "explicit monochrome must not retain green cell paint"
    );
    let extracted = common::pdf_page_text(&rendered.pdf_bytes).join("\n");
    assert!(extracted.contains("Low risk with retained label"));
  }
}

#[test]
fn inv_w01_v2_render_produces_pdf_for_default_bundle() {
  let report = render_to_pdf_v2(&doc("V2 Render Smoke"), bundle(), &[], usize::MAX).expect("V2 render must succeed");
  assert!(
    report.pdf_bytes.starts_with(b"%PDF-"),
    "INV-PDF-W01-V2: V2 render must produce PDF magic header (got {} bytes prefix `{:?}`)",
    report.pdf_bytes.len(),
    &report.pdf_bytes[..report.pdf_bytes.len().min(8)]
  );
  assert!(
    report.page_count >= 1,
    "INV-PDF-W01-V2: rendered PDF must have ≥ 1 page"
  );
  assert!(
    report.unmapped_font_families.is_empty(),
    "INV-PDF-W01-V2: resolved Theme DB body font must be present"
  );
}

#[test]
fn inv_a4_orientation_and_global_font_scales_render_real_pdfs() {
  let mut portrait = doc("A4 portrait");
  portrait.options.paper_size = "A4".into();
  portrait.options.orientation = "portrait".into();
  portrait.options.heading_font_scale = DEFAULT_HEADING_FONT_SCALE;
  portrait.options.body_font_scale = DEFAULT_BODY_FONT_SCALE;

  let mut landscape = doc("A4 landscape");
  landscape.options.paper_size = "A4".into();
  landscape.options.orientation = "landscape".into();
  landscape.options.heading_font_scale = DEFAULT_HEADING_FONT_SCALE;
  landscape.options.body_font_scale = DEFAULT_BODY_FONT_SCALE;

  let portrait_report = render_to_pdf_v2(&portrait, bundle(), &[], usize::MAX).expect("portrait A4 render");
  let landscape_report = render_to_pdf_v2(&landscape, bundle(), &[], usize::MAX).expect("landscape A4 render");
  assert!(portrait_report.pdf_bytes.starts_with(b"%PDF-"));
  assert!(landscape_report.pdf_bytes.starts_with(b"%PDF-"));
  assert_ne!(
    portrait_report.pdf_bytes, landscape_report.pdf_bytes,
    "orientation must materially change the rendered PDF"
  );

  let page_dimensions = |bytes: &[u8]| {
    let pdf = lopdf::Document::load_mem(bytes).expect("parse orientation PDF");
    pdf
      .get_pages()
      .values()
      .map(|page_id| {
        let page = pdf
          .get_object(*page_id)
          .and_then(lopdf::Object::as_dict)
          .expect("page dictionary");
        let media_box = page
          .get(b"MediaBox")
          .and_then(lopdf::Object::as_array)
          .expect("page MediaBox");
        let coordinate = |index: usize| media_box[index].as_float().expect("MediaBox coordinate");
        (coordinate(2) - coordinate(0), coordinate(3) - coordinate(1))
      })
      .collect::<Vec<_>>()
  };
  let portrait_dimensions = page_dimensions(&portrait_report.pdf_bytes);
  let landscape_dimensions = page_dimensions(&landscape_report.pdf_bytes);
  assert!(
    portrait_dimensions
      .iter()
      .all(|(width, height)| (*width - 595.28).abs() < 0.1 && (*height - 841.89).abs() < 0.1),
    "every portrait page must keep A4 portrait geometry: {portrait_dimensions:?}"
  );
  assert!(
    landscape_dimensions
      .iter()
      .all(|(width, height)| (*width - 841.89).abs() < 0.1 && (*height - 595.28).abs() < 0.1),
    "every landscape page must swap the A4 dimensions: {landscape_dimensions:?}"
  );

  if let Ok(dir) = std::env::var("MYOXUS_PDF_EXPORT_ARTIFACT_DIR") {
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create PDF artifact dir");
    std::fs::write(dir.join("a4-portrait.pdf"), portrait_report.pdf_bytes).expect("write portrait PDF");
    std::fs::write(dir.join("a4-landscape.pdf"), landscape_report.pdf_bytes).expect("write landscape PDF");
  }
}

#[test]
fn presentation_clean_maps_heading_boundaries_and_preserves_content() {
  let mut presentation = doc("Presentation Contract");
  presentation.options.template_id = "presentation-clean".into();
  presentation.options.cover_page = Some(true);
  presentation.options.toc_behavior = "off".into();
  presentation.root = Block::Page {
    title: vec![text("Presentation Contract")],
    children: vec![
      Block::Note {
        children: vec![
          Block::Heading {
            level: HeadingLevel::H1,
            content: vec![text("Presentation Contract")],
            children: vec![],
          },
          paragraph("Introductory content before the first slide boundary."),
        ],
      },
      Block::Heading {
        level: HeadingLevel::H1,
        content: vec![text("Section One")],
        children: vec![],
      },
      paragraph("Section body remains visible."),
      Block::Heading {
        level: HeadingLevel::H2,
        content: vec![text("First bounded slide")],
        children: vec![],
      },
      paragraph("First slide body."),
      Block::Heading {
        level: HeadingLevel::H2,
        content: vec![text("Second bounded slide")],
        children: vec![],
      },
      paragraph("Second slide body."),
      Block::Heading {
        level: HeadingLevel::H2,
        content: vec![text("Third bounded slide")],
        children: vec![],
      },
      paragraph("Third slide body."),
      Block::Heading {
        level: HeadingLevel::H2,
        content: vec![text("Fourth bounded slide")],
        children: vec![],
      },
      paragraph("Final presentation marker."),
    ],
  };

  let generated = ir_to_typst_source_v2(&presentation, common::presentation_clean_template_bundle())
    .expect("presentation source generation");
  assert!(generated.source.contains("#show: myoxus-presentation"));
  assert!(
    !generated.source.contains("\n= Presentation Contract\n"),
    "a leading imported H1 that repeats the page title must not create a duplicate section slide"
  );
  assert!(
    !generated
      .source
      .contains("#align(left, block(width: 100%)[#set text(font: heading-font"),
    "presentation templates must own the document title instead of receiving the flow title twice"
  );
  for expected in [
    "Introductory content before the first slide boundary.",
    "Section body remains visible.",
    "First bounded slide",
    "Final presentation marker.",
  ] {
    assert!(
      generated.source.contains(expected),
      "presentation source must retain `{expected}`"
    );
  }
  let rendered = render_to_pdf_v2(
    &presentation,
    common::presentation_clean_template_bundle(),
    &[fonts_dir()],
    usize::MAX,
  )
  .expect("Clean presentation render");
  assert_eq!(rendered.page_count, 7, "cover, intro, section and four H2 slides");
  if let Ok(dir) = std::env::var("MYOXUS_PDF_EXPORT_ARTIFACT_DIR") {
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create PDF artifact dir");
    std::fs::write(dir.join("presentation-clean.pdf"), &rendered.pdf_bytes).expect("write Clean presentation PDF");
  }
  let text = pdf_extract::extract_text_from_mem(&rendered.pdf_bytes).expect("presentation PDF text");
  // `pdf_extract` cannot decode every subset font Touying produces, so keep
  // final-PDF assertions on stable title/section runs and use source retention
  // plus the exact page boundaries above for the remaining content.
  for expected in ["Presentation Contract", "Section One", "Section body remains visible."] {
    assert!(text.contains(expected), "presentation must retain `{expected}`: {text}");
  }
}

#[test]
fn presentation_clean_honors_exact_widescreen_orientation() {
  let dimensions = |orientation: &str| {
    let mut presentation = doc("Widescreen Contract");
    presentation.options.paper_size = "16:9".into();
    presentation.options.orientation = orientation.into();
    presentation.options.cover_page = Some(false);
    presentation.root = Block::Page {
      title: vec![text("Widescreen Contract")],
      children: vec![paragraph("Widescreen geometry remains visible.")],
    };
    let report = render_to_pdf_v2(
      &presentation,
      common::presentation_clean_template_bundle(),
      &[fonts_dir()],
      usize::MAX,
    )
    .expect("widescreen presentation render");
    let pdf = lopdf::Document::load_mem(&report.pdf_bytes).expect("parse widescreen PDF");
    let page_id = *pdf.get_pages().values().next().expect("rendered page");
    let page = pdf
      .get_object(page_id)
      .and_then(lopdf::Object::as_dict)
      .expect("page dictionary");
    let media_box = page
      .get(b"MediaBox")
      .and_then(lopdf::Object::as_array)
      .expect("page MediaBox");
    let coordinate = |index: usize| media_box[index].as_float().expect("MediaBox coordinate");
    (coordinate(2) - coordinate(0), coordinate(3) - coordinate(1))
  };

  let landscape = dimensions("landscape");
  let portrait = dimensions("portrait");
  assert!((landscape.0 - 960.0).abs() < 0.1 && (landscape.1 - 540.0).abs() < 0.1);
  assert!((portrait.0 - 540.0).abs() < 0.1 && (portrait.1 - 960.0).abs() < 0.1);
}

#[test]
fn presentation_titles_and_page_numbers_honor_export_settings() {
  let mut presentation = doc("Presentation settings");
  presentation.options.paper_size = "16:9".into();
  presentation.options.orientation = "landscape".into();
  presentation.options.cover_page = Some(false);
  presentation.options.toc_behavior = "off".into();
  presentation.root = Block::Page {
    title: vec![],
    children: vec![
      Block::Heading {
        level: HeadingLevel::H2,
        content: vec![text("Alpha")],
        children: vec![],
      },
      paragraph("Body marker"),
    ],
  };
  for (slug, bundle) in [
    ("presentation-clean", common::presentation_clean_template_bundle()),
    ("presentation-focus", common::presentation_focus_template_bundle()),
    (
      "presentation-navigator",
      common::presentation_navigator_template_bundle(),
    ),
  ] {
    presentation.options.template_id = slug.into();
    presentation.options.heading_font_scale = DEFAULT_HEADING_FONT_SCALE;
    let mut normal_title_size = None;
    for (footer, numbering, scale) in [
      ("page-only", "arabic", 1.0),
      ("none", "arabic", 1.0),
      ("page-only", "none", 1.0),
      ("page-only", "none", 1.5),
    ] {
      presentation.options.footer_style = Some(footer.into());
      presentation.options.page_numbering = Some(numbering.into());
      presentation.options.heading_font_scale = DEFAULT_HEADING_FONT_SCALE * scale;
      let rendered = render_to_pdf_v2(&presentation, bundle, &[fonts_dir()], usize::MAX)
        .unwrap_or_else(|error| panic!("{slug} settings render: {error}"));
      assert_eq!(rendered.page_count, 1, "{slug}: short title must fit");
      let text = pdf_extract::extract_text_from_mem(&rendered.pdf_bytes).expect("presentation text");
      assert!(
        text.contains("Alpha") && text.contains("Body marker"),
        "{slug}: content retained"
      );
      let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
      assert_eq!(
        compact.contains("1/1"),
        footer != "none" && numbering != "none",
        "{slug}: footer={footer}, numbering={numbering}"
      );
      if numbering == "none" {
        let pdf = lopdf::Document::load_mem(&rendered.pdf_bytes).expect("presentation PDF");
        let page = *pdf.get_pages().values().next().expect("slide");
        let content = pdf.get_page_content(page).expect("slide content");
        let operations = lopdf::content::Content::decode(&content).expect("slide operations");
        // With one short title and smaller body text, the largest text size is
        // the title. Inspect the compiled PDF rather than emitted Typst bindings.
        let title_size = operations
          .operations
          .iter()
          .filter(|op| op.operator == "Tf")
          .map(|op| op.operands[1].as_float().expect("font size"))
          .reduce(f32::max)
          .expect("rendered text sizes");
        if scale == 1.0 {
          normal_title_size = Some(title_size);
        } else {
          let normal = normal_title_size.expect("baseline title size");
          assert!(
            (title_size - 1.5 * normal).abs() < 0.1,
            "{slug}: heading scale must increase title size by 50% ({normal} -> {title_size})"
          );
        }
      }
    }
  }
}

#[test]
fn presentation_clean_keeps_headingless_content_on_one_slide() {
  let mut presentation = doc("Headingless presentation");
  presentation.options.template_id = "presentation-clean".into();
  presentation.options.cover_page = Some(false);
  presentation.root = Block::Page {
    title: vec![text("Headingless presentation")],
    children: vec![paragraph("Headingless content remains visible on its own slide.")],
  };

  let generated = ir_to_typst_source_v2(&presentation, common::presentation_clean_template_bundle())
    .expect("headingless presentation source");
  assert!(generated.source.contains("Headingless content remains visible"));
  let rendered = render_to_pdf_v2(
    &presentation,
    common::presentation_clean_template_bundle(),
    &[fonts_dir()],
    usize::MAX,
  )
  .expect("headingless Clean presentation render");
  assert_eq!(
    rendered.page_count, 1,
    "headingless content must form one content slide"
  );
}

#[test]
fn presentation_clean_labels_overflow_continuations_without_dropping_tail_content() {
  let mut children = vec![Block::Heading {
    level: HeadingLevel::H2,
    content: vec![text("Dense bounded slide")],
    children: vec![],
  }];
  children.extend((1..=36).map(|index| {
    paragraph(&format!(
      "Dense presentation line {index:02} remains in source order across continuation pages."
    ))
  }));
  children.push(paragraph("FINAL OVERFLOW MARKER"));

  let mut presentation = doc("Overflow presentation");
  presentation.options.template_id = "presentation-clean".into();
  presentation.options.cover_page = Some(false);
  presentation.root = Block::Page {
    title: vec![text("Overflow presentation")],
    children,
  };

  let generated = ir_to_typst_source_v2(&presentation, common::presentation_clean_template_bundle())
    .expect("overflow presentation source");
  assert!(generated.source.contains("Dense presentation line 01"));
  assert!(generated.source.contains("FINAL OVERFLOW MARKER"));
  let rendered = render_to_pdf_v2(
    &presentation,
    common::presentation_clean_template_bundle(),
    &[fonts_dir()],
    usize::MAX,
  )
  .expect("overflow Clean presentation render");
  assert_eq!(
    rendered.page_count, 5,
    "dense content must continue without clipping or shrinking"
  );
  if let Ok(dir) = std::env::var("MYOXUS_PDF_EXPORT_ARTIFACT_DIR") {
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create PDF artifact dir");
    std::fs::write(dir.join("presentation-clean-overflow.pdf"), &rendered.pdf_bytes)
      .expect("write overflow presentation PDF");
  }
  let bundle = common::presentation_clean_template_bundle();
  let adapter = bundle
    .get("vendor/myoxus/presentation-adapter.typ")
    .expect("shared presentation adapter");
  let adapter = std::str::from_utf8(adapter).expect("shared presentation adapter must be UTF-8");
  assert!(
    adapter.contains("heading-page < current-page") && adapter.contains("continuation-label"),
    "continuation pages must be labelled by the shared adapter"
  );
}

#[test]
fn missing_theme_typ_is_surfaced_as_error() {
  let mut broken = bundle().clone();
  broken.remove("theme.typ");
  let err = render_to_pdf_v2(&doc("missing"), &broken, &[], usize::MAX).expect_err("must err");
  let msg = format!("{err}");
  assert!(
    msg.contains("theme.typ"),
    "missing theme.typ must surface in the error: {msg}"
  );
}

#[test]
fn invalid_utf8_theme_is_surfaced_as_error() {
  let mut broken = bundle().clone();
  // Insert binary bytes — not valid UTF-8.
  broken.insert("theme.typ".into(), vec![0xFFu8, 0xFE, 0x00, 0x01]);
  let err = render_to_pdf_v2(&doc("bad utf8"), &broken, &[], usize::MAX).expect_err("must err");
  let msg = format!("{err}");
  assert!(msg.contains("theme.typ"), "invalid UTF-8 must mention theme.typ: {msg}");
}

#[test]
fn inv_v2_rendered_pdf_keeps_table_special_chars_and_no_structural_canvas_placeholder() {
  let mut doc = doc("Content Regression");
  let mut png = std::io::Cursor::new(Vec::new());
  image::RgbImage::from_pixel(24, 24, image::Rgb([20, 90, 150]))
    .write_to(&mut png, image::ImageFormat::Png)
    .unwrap();
  doc.assets.insert(
    "semantic-image".into(),
    AssetData {
      mime: "image/png".into(),
      bytes: png.into_inner(),
      filename: None,
    },
  );
  doc.root = Block::Page {
    title: vec![],
    children: vec![
      Block::Paragraph {
        content: vec![text("Sonderzeichen: äöü ÄÖÜ ß € # [] * _")],
        children: vec![],
      },
      Block::Table {
        rows: vec![
          TableRow {
            cells: vec![
              TableCell {
                content: vec![text("Name")],
                is_header: false,
                col_span: 1,
                row_span: 1,
                align: None,
                fill: None,
                foreground: None,
              },
              TableCell {
                content: vec![text("Score #1")],
                is_header: false,
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
                content: vec![text("Marta Müller")],
                is_header: false,
                col_span: 1,
                row_span: 1,
                align: None,
                fill: None,
                foreground: None,
              },
              TableCell {
                content: vec![text("42 €")],
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
        caption: None,
        column_widths: None,
        header_rows: None,
        appearance: None,
        density: None,
      },
      Block::Image(ImageRef {
        blob: BlobRef {
          blob_id: "semantic-image".into(),
          mime_hint: Some("image/png".into()),
        },
        caption: Some(vec![text("Blue [square] #1")]),
        width_hint: Some(24.0),
        height_hint: None,
        data: None,
      }),
      Block::Paragraph {
        content: vec![InlineSpan::Text {
          text: "Myoxus link".into(),
          marks: TextMarks {
            link: Some("https://github.com/superions/myoxus".into()),
            ..TextMarks::default()
          },
        }],
        children: vec![],
      },
      Block::Unknown {
        flavour: "myoxus:surface".to_owned(),
        text_fallback: Some(Vec::new()),
      },
    ],
  };

  let generated = ir_to_typst_source_v2(&doc, bundle()).expect("source generation");
  assert!(
    generated.source.contains("#table(columns: 2"),
    "table block must emit a Typst table, source:\n{}",
    generated.source
  );
  assert!(
    generated.source.contains("Marta Müller"),
    "unicode table text must survive"
  );
  assert!(generated.source.contains("42 €"), "currency symbol must survive");
  assert!(
    generated.source.contains("myoxus-body-string(\"Score #1\")"),
    "Typst-special table text must remain inside the escaped string helper, source:\n{}",
    generated.source
  );
  assert!(
    !generated.source.contains("Canvas snapshot not available"),
    "regular page exports must not include the edgeless placeholder"
  );

  doc.metadata.created_at = Some(
    chrono::DateTime::parse_from_rfc3339("2026-10-14T00:00:00Z")
      .unwrap()
      .with_timezone(&chrono::Utc),
  );
  for profile in ["standard", "pdfa-2u", "pdfua-1"] {
    doc.options.compliance_profile = Some(profile.into());
    let report = render_to_pdf_v2(&doc, bundle(), &[], usize::MAX).expect("content regression PDF must render");
    let pdf_text = common::pdf_page_text(&report.pdf_bytes).join("\n");
    common::pdf_selected_fonts(&report.pdf_bytes);
    let structure = common::pdf_structure_elements(&report.pdf_bytes);
    for role in ["Table", "TH", "TD", "Figure", "Link"] {
      assert!(
        structure.iter().any(|(actual, _)| actual == role),
        "actual structure preserves {role}"
      );
    }
    assert!(
      structure
        .iter()
        .any(|(role, alt)| role == "Figure" && alt.as_deref() == Some("Blue [square] #1")),
      "authored image alternative survives native PDF structure"
    );
    if profile == "pdfua-1" {
      let pdf = lopdf::Document::load_mem(&report.pdf_bytes).unwrap();
      let xmp = pdf
        .get_object(pdf.catalog().unwrap().get(b"Metadata").unwrap().as_reference().unwrap())
        .unwrap()
        .as_stream()
        .unwrap()
        .get_plain_content()
        .unwrap();
      assert!(
        String::from_utf8(xmp)
          .unwrap()
          .contains("<pdfuaid:part>1</pdfuaid:part>")
      );
    }

    if profile == "pdfa-2u" {
      let pdf = lopdf::Document::load_mem(&report.pdf_bytes).unwrap();
      let catalog = pdf.catalog().unwrap();
      let xmp = pdf
        .get_object(catalog.get(b"Metadata").unwrap().as_reference().unwrap())
        .unwrap()
        .as_stream()
        .unwrap()
        .get_plain_content()
        .unwrap();
      let xmp = String::from_utf8(xmp).unwrap();
      assert!(xmp.contains("<pdfaid:part>2</pdfaid:part>"));
      assert!(xmp.contains("<pdfaid:conformance>U</pdfaid:conformance>"));
    }
    assert!(
      pdf_text.contains("Sonderzeichen: äöü ÄÖÜ ß €"),
      "rendered PDF must preserve user-visible special characters, extracted:\n{pdf_text}"
    );
    for expected in ["Name", "Score #1", "Marta Müller", "42 €"] {
      assert!(
        pdf_text.contains(expected),
        "rendered PDF must preserve table cell `{expected}`, extracted:\n{pdf_text}"
      );
    }
    assert!(
      !pdf_text.contains("Canvas snapshot not available"),
      "regular page PDF must not expose the edgeless placeholder, extracted:\n{pdf_text}"
    );
  }
}

#[test]
fn inv_v2_report_template_renders_complex_10_page_pdf_with_toc_and_tables() {
  let write_review = |name: &str, bytes: &[u8]| {
    if let Ok(dir) = std::env::var("MYOXUS_PDF_EXPORT_ARTIFACT_DIR") {
      std::fs::create_dir_all(&dir).expect("create existing fixture artifact directory");
      std::fs::write(std::path::Path::new(&dir).join(name), bytes).expect("write existing fixture review PDF");
    }
  };
  let mut doc = doc("Komplexer PDF Export Review");
  doc.options.template_id = "report".into();
  doc.options.locale = "de".into();
  doc.options.toc_behavior = "force".into();
  doc.options.cover_page = Some(true);
  doc.options.confidentiality_label = Some("Confidential".into());
  doc
    .options
    .template_vars
    .insert("title".into(), serde_json::json!("Q2 Platform Review"));
  doc.options.template_vars.insert(
    "subtitle".into(),
    serde_json::json!("Operational readiness and export quality"),
  );
  doc.options.template_vars.insert(
    "executive_summary".into(),
    serde_json::json!(
      "Diese Executive Summary stammt aus typed_inputs und muss vor dem eigentlichen Dokumentkoerper sichtbar sein."
    ),
  );
  doc
    .options
    .template_vars
    .insert("report_date".into(), serde_json::json!("2026-06-12"));
  doc
    .options
    .template_vars
    .insert("author".into(), serde_json::json!("Template Input QA"));
  doc.options.theme_fonts = ThemeFontSelection {
    heading: Some("Lora".into()),
    body: Some("Inter".into()),
    mono: Some("JetBrains Mono".into()),
    symbol: Some("JetBrains Mono".into()),
  };
  doc.metadata.author = Some("PDF Export QA".into());
  doc.metadata.workspace_name = Some("Myoxus Review Workspace".into());
  doc.metadata.branding.footer_text = Some("Myoxus PDF Export Review".into());

  let image = image::RgbImage::from_fn(400, 112, |x, y| {
    let panel = (12..=108).contains(&x) || (152..=248).contains(&x) || (292..=388).contains(&x);
    if panel && (20..=92).contains(&y) {
      image::Rgb([15, 118, 110])
    } else if (54..=58).contains(&y) && (108..=292).contains(&x) {
      image::Rgb([23, 63, 58])
    } else {
      image::Rgb([245, 250, 249])
    }
  });
  let mut image_bytes = std::io::Cursor::new(Vec::new());
  image.write_to(&mut image_bytes, image::ImageFormat::Png).unwrap();
  doc.assets.insert(
    "long-review-figure".into(),
    AssetData {
      mime: "image/png".into(),
      bytes: image_bytes.into_inner(),
      filename: Some("source-export-review.png".into()),
    },
  );

  let mut children = vec![
    Block::Paragraph {
      content: vec![
        text("Inline code remains literal: "),
        InlineSpan::Text {
          text: "doc_marker[index]".into(),
          marks: TextMarks {
            code: Some(true),
            ..TextMarks::default()
          },
        },
        text(" within its paragraph."),
      ],
      children: vec![],
    },
    paragraph("Table header reference: Metrik."),
    paragraph(
      "Dieser Testbericht prueft einen langen, strukturierten Export mit Inhaltsverzeichnis, Tabellen, \
       Sonderzeichen und wiederholten Abschnitten. Er ist bewusst umfangreich genug, um echte Umbrueche \
       ueber mindestens zehn Seiten zu erzwingen.",
    ),
    Block::Heading {
      level: HeadingLevel::H1,
      content: vec![text("Management Summary")],
      children: vec![],
    },
    paragraph(
      "Die Zusammenfassung enthaelt Umlaute wie äöü ÄÖÜ, das Euro-Zeichen € und Typst-Sonderzeichen \
       wie # [] * _, damit Text-Encoding und Escaping im finalen PDF belegbar bleiben.",
    ),
  ];

  for section in 1..=12 {
    children.push(Block::Heading {
      level: HeadingLevel::H1,
      content: vec![text(&format!("Kapitel {section}: Analysebereich"))],
      children: vec![],
    });
    children.push(Block::Heading {
      level: HeadingLevel::H2,
      content: vec![text(&format!("Kapitel {section}.1 Messwerte und Bewertung"))],
      children: vec![],
    });
    children.push(Block::Table {
      rows: vec![
        TableRow {
          cells: vec![
            table_cell("Metrik", true, None),
            table_cell("Ist", true, Some("right")),
            table_cell("Ziel", true, Some("right")),
            table_cell("Status", true, Some("center")),
          ],
        },
        TableRow {
          cells: vec![
            table_cell(&format!("Durchsatz #{section}"), false, None),
            table_cell(&format!("{} €", section * 137), false, Some("right")),
            table_cell(&format!("{} €", section * 140), false, Some("right")),
            table_cell("OK", false, Some("center")),
          ],
        },
        TableRow {
          cells: vec![
            table_cell("Qualitaetsindex äöü", false, None),
            table_cell(&format!("{}%", 90 + section % 9), false, Some("right")),
            table_cell("95%", false, Some("right")),
            table_cell("Review", false, Some("center")),
          ],
        },
      ],
      caption: Some(vec![text(&format!("Tabelle {section}: belastbare Kennzahlen"))]),
      column_widths: None,
      header_rows: Some(1),
      appearance: None,
      density: None,
    });
    for paragraph_index in 1..=6 {
      children.push(paragraph(&format!(
        "Kapitel {section}, Absatz {paragraph_index}: Dieser Fliesstext ist absichtlich laenger und beschreibt \
         einen realistischen Review-Kontext mit stabilen Begriffen wie Renderpipeline, Inhaltsverzeichnis, \
         Tabellenlayout, Seitenumbruch und PDF-Text-Extraktion. Die Wiederholung sorgt fuer ein Dokument, \
         das nicht nur eine Rauchprobe ist, sondern den Seitenumbruch und die typografische Stabilitaet \
         ueber viele Seiten prueft."
      )));
    }
    if section == 4 {
      children.push(Block::Image(ImageRef {
        blob: BlobRef {
          blob_id: "long-review-figure".into(),
          mime_hint: Some("image/png".into()),
        },
        caption: Some(vec![text("Figure review: source, export snapshot and reviewed PDF.")]),
        width_hint: Some(400.0),
        height_hint: None,
        data: None,
      }));
    }
    if section == 8 {
      children.push(Block::List {
        list_type: ListType::Numbered,
        content: vec![text("Inspect every page before acceptance.")],
        checked: false,
        children: vec![Block::List {
          list_type: ListType::Bulleted,
          content: vec![text("Retain captions and link destinations.")],
          checked: false,
          children: vec![],
        }],
      });
      children.push(Block::Code(CodeBlock {
        language: Some("rust".into()),
        code: "fn review_document(title: &str, pages: usize) -> String {\n    assert!(pages > 0);\n    format!(\"{title}: {pages} reviewed pages\")\n}".into(),
        caption: None,
      }));
      children.push(Block::Paragraph {
        content: vec![InlineSpan::Text {
          text: "Myoxus project reference".into(),
          marks: TextMarks {
            link: Some("https://github.com/superions/myoxus".into()),
            ..TextMarks::default()
          },
        }],
        children: vec![],
      });
    }
  }

  let source_paragraphs: Vec<String> = children
    .iter()
    .filter_map(|block| match block {
      Block::Paragraph { content, .. } => Some(
        content
          .iter()
          .map(|span| match span {
            InlineSpan::Text { text, .. } => text.as_str(),
            _ => panic!("text-only source paragraph fixture"),
          })
          .collect(),
      ),
      _ => None,
    })
    .collect();
  let assert_long_output = |bytes: &[u8], label: &str, body_family: &str| {
    let pages = common::pdf_page_text(bytes);
    let complete = pages.join("\n");
    let runs = common::pdf_text_runs(bytes);
    let body_size = runs
      .iter()
      .find(|run| run.text.contains("Dieser Fliesstext"))
      .expect("source body text")
      .size;
    // Running chrome can interrupt a paragraph at a page boundary. Inspect the
    // actual body operators; keep literal inline hyphens and omit only Typst's
    // separate discretionary hyphen run. Inline code belongs to the same source.
    let normalized = runs
      .iter()
      .filter(|run| {
        (run.font.split('+').last().unwrap().starts_with(body_family) && (run.size - body_size).abs() < 0.001)
          || run.text.contains("doc_marker[index]")
      })
      .filter(|run| run.text != "-")
      .map(|run| run.text.as_str())
      .collect::<String>()
      .split_whitespace()
      .collect::<String>();
    for paragraph in &source_paragraphs {
      assert!(
        normalized.contains(&paragraph.split_whitespace().collect::<String>()),
        "{label} loses complete source paragraph: {paragraph}; output: {complete}"
      );
    }
    for section in 1..=12 {
      for marker in [
        format!("Kapitel {section}: Analysebereich"),
        format!("Tabelle {section}: belastbare Kennzahlen"),
        format!("Durchsatz #{section}"),
      ] {
        assert!(complete.contains(&marker), "{label} loses {marker}");
      }
    }
    for (marker, family) in [
      ("Analysebereich", "Lora"),
      ("Dieser Fliesstext", body_family),
      ("review_document", "JetBrainsMono"),
    ] {
      assert!(
        runs
          .iter()
          .any(|run| run.text.contains(marker) && run.font.split('+').last().unwrap().starts_with(family)),
        "{label} must select {family} for {marker}"
      );
    }
    pages
  };
  doc.root = Block::Page {
    title: vec![text("Komplexer PDF Export Review")],
    children,
  };

  let generated = ir_to_typst_source_v2(&doc, common::report_template_bundle()).expect("report source generation");
  assert!(
    generated.source.contains("#let toc-behavior = \"force\""),
    "TOC capability must be projected into Typst source:\n{}",
    generated.source
  );
  assert!(
    generated.source.contains("#let heading-font = \"Lora\"")
      && generated.source.contains("#let body-font = \"Inter\"")
      && generated.source.contains("font: body-font,")
      && generated.source.contains("font: heading-font,")
      && generated.source.contains("weight: body-font-weight,")
      && generated.source.contains("size: heading-size * scale,"),
    "report template must receive and use distinct heading/body typography roles:\n{}",
    generated.source
  );
  assert!(
    generated.source.contains("#let cover-page-enabled = true"),
    "cover-page capability must be projected into Typst source:\n{}",
    generated.source
  );
  assert!(
    generated
      .source
      .contains("#let confidentiality-label = \"Confidential\""),
    "confidentiality label must be projected into Typst source:\n{}",
    generated.source
  );
  for expected in [
    "#let template-title = \"Q2 Platform Review\"",
    "#let template-subtitle = \"Operational readiness and export quality\"",
    "#let template-report-date = \"2026-06-12\"",
    "#let template-author = \"Template Input QA\"",
  ] {
    assert!(
      generated.source.contains(expected),
      "report typed input binding `{expected}` must be projected into Typst source:\n{}",
      generated.source
    );
  }
  assert!(
    !generated.source.contains("#outline(title: [Contents]"),
    "report template owns the TOC; the generic renderer must not add a second Contents outline:\n{}",
    generated.source
  );

  let report = render_to_pdf_v2(&doc, common::report_template_bundle(), &[fonts_dir()], usize::MAX)
    .expect("complex report PDF must render");
  assert!(report.pdf_bytes.starts_with(b"%PDF-"));
  assert!(
    report.unmapped_font_families.is_empty(),
    "report typography roles must resolve through the real bundled font directory, got {:?}",
    report.unmapped_font_families
  );
  assert!(
    report.page_count >= 10,
    "complex report must exercise a real long-document layout, got {} pages",
    report.page_count
  );
  write_review("complex-report-10-page-review.pdf", &report.pdf_bytes);
  let report_pages = assert_long_output(&report.pdf_bytes, "report", "Inter");
  assert!(
    report_pages[0].contains("Q2 Platform Review") && !report_pages[0].contains("Kapitel 1:"),
    "cover break keeps body on later pages"
  );
  assert!(
    report_pages[1].contains("Inhaltsverzeichnis") && !report_pages[1].contains("Kapitel 1, Absatz 1"),
    "TOC break keeps body on later pages"
  );
  let pdf_text = report_pages.join("\n");
  for expected in [
    "Inhaltsverzeichnis",
    "Management Summary",
    "Kapitel 12: Analysebereich",
    "Tabelle 12: belastbare Kennzahlen",
    "Durchsatz #12",
    "Qualitaetsindex äöü",
    "Confidential",
    "Q2 Platform Review",
    "Operational readiness and export quality",
    "Diese Executive Summary stammt aus typed_inputs",
    "Template Input QA",
    "2026-06-12",
    "Myoxus PDF Export Review",
  ] {
    assert!(
      pdf_text.contains(expected),
      "complex report PDF text must contain `{expected}`, extracted:\n{pdf_text}"
    );
  }
  assert!(
    !pdf_text.contains("Canvas snapshot not available"),
    "long report PDF must not expose edgeless placeholders, extracted:\n{pdf_text}"
  );

  // Reuse the long source so customization is tested against pagination and
  // actual PDF output, rather than only the generated Typst bindings.
  doc.options.template_id = "myoxus-doc".into();
  doc.options.locale = "en".into();
  // Merriweather is an existing server theme font with real smcp glyphs.
  // Inter has no smcp feature; its correctly selected regular glyphs remain valid.
  doc.options.theme_fonts.body = Some("Merriweather".into());
  doc.options.footer_style = Some("brand-and-page".into());
  doc.options.page_numbering = Some("arabic".into());
  doc.options.color_variant = Some("brand".into());
  doc.metadata.branding.primary = Some("#0f766e".into());
  doc.metadata.branding.accent = Some("#7c3aed".into());
  let documentation = render_to_pdf_v2(
    &doc,
    common::documentation_template_bundle(),
    &[fonts_dir()],
    usize::MAX,
  )
  .expect("documentation with explicit inputs");
  write_review("complex-documentation-brand.pdf", &documentation.pdf_bytes);
  let pages = assert_long_output(&documentation.pdf_bytes, "documentation", "Merriweather");
  let runs = common::pdf_text_runs(&documentation.pdf_bytes);
  let header = runs
    .iter()
    .find(|run| run.text == "Metrik")
    .expect("searchable table header");
  let reference = runs
    .iter()
    .find(|run| run.text.contains("Table header reference: Metrik."))
    .expect("ordinary body reference");
  assert_eq!(header.font, reference.font, "header retains selected body family");
  assert!(header.font.contains("Merriweather"));
  let start = reference.text.chars().position(|ch| ch == 'M').unwrap();
  assert_ne!(
    header.glyphs,
    &reference.glyphs[start..start + "Metrik".len()],
    "small caps must select alternate glyphs while retaining searchable source text"
  );
  let brand_paints = pdf_rgb_paints(&documentation.pdf_bytes);
  assert!(
    brand_paints
      .iter()
      .any(|[r, g, b]| (r - g).abs() > 0.001 || (g - b).abs() > 0.001),
    "full document palette must retain chromatic colors in the rendered PDF"
  );
  assert!(pages.len() >= 10, "documentation retains the long source");
  for expected in [
    "Q2 Platform Review",
    "Operational readiness and export quality",
    "Template Input QA",
    "2026-06-12",
  ] {
    assert!(
      pages[0].contains(expected),
      "cover must display {expected}: {}",
      pages[0]
    );
  }
  assert_eq!(
    pages.iter().filter(|page| page.contains("Contents")).count(),
    1,
    "one TOC"
  );
  assert!(
    pages.last().unwrap().contains("Myoxus PDF Export Review"),
    "document footer"
  );
  assert!(
    pages.last().unwrap().contains(&format!("Page {}", pages.len())),
    "Arabic page number"
  );
  assert!(
    pages
      .join("\n")
      .split_whitespace()
      .collect::<Vec<_>>()
      .join(" ")
      .contains("Kapitel 12, Absatz 6"),
    "last source paragraph survives"
  );
  assert!(
    pages.join("\n").contains("doc_marker[index]"),
    "inline code must not acquire markup escapes"
  );
  let pdf = lopdf::Document::load_mem(&documentation.pdf_bytes).expect("documentation PDF");
  for marker in [
    "Figure review: source, export snapshot and reviewed PDF.",
    "Inspect every page before acceptance.",
    "Retain captions and link destinations.",
    "fn review_document(title: &str, pages: usize) -> String",
    "assert!(pages > 0);",
    "Myoxus project reference",
  ] {
    assert!(pages.join("\n").contains(marker), "long documentation loses {marker}");
  }
  assert!(
    pdf.objects.values().any(|object| {
      object.as_stream().is_ok_and(|stream| {
        stream
          .dict
          .get(b"Subtype")
          .and_then(lopdf::Object::as_name)
          .is_ok_and(|name| name == b"Image")
          && stream
            .dict
            .get(b"Width")
            .and_then(lopdf::Object::as_i64)
            .is_ok_and(|width| width == 400)
      })
    }),
    "the captioned source image must be embedded in the PDF"
  );
  assert!(
    pdf.objects.values().any(|object| {
      object.as_dict().is_ok_and(|dict| {
        dict.get(b"A").and_then(lopdf::Object::as_dict).is_ok_and(|action| {
          action.get(b"URI").is_ok_and(|uri| {
            lopdf::decode_text_string(uri).is_ok_and(|url| url == "https://github.com/superions/myoxus")
          })
        })
      })
    }),
    "the visible link must retain its actual PDF destination"
  );
  let info = pdf
    .get_dictionary(pdf.trailer.get(b"Info").unwrap().as_reference().unwrap())
    .unwrap();
  for (key, expected) in [
    (b"Title".as_slice(), "Q2 Platform Review"),
    (b"Author".as_slice(), "Template Input QA"),
  ] {
    assert_eq!(lopdf::decode_text_string(info.get(key).unwrap()).unwrap(), expected);
  }

  doc.options.cover_page = Some(false);
  doc.options.toc_behavior = "off".into();
  doc.options.footer_style = Some("none".into());
  doc.options.page_numbering = Some("none".into());
  doc.options.color_variant = Some("mono".into());
  doc.options.template_vars.clear();
  let plain = render_to_pdf_v2(
    &doc,
    common::documentation_template_bundle(),
    &[fonts_dir()],
    usize::MAX,
  )
  .expect("documentation without cover, TOC or footer");
  write_review("complex-documentation-plain.pdf", &plain.pdf_bytes);
  let plain_pages = assert_long_output(&plain.pdf_bytes, "plain documentation", "Merriweather");
  let mono_paints = pdf_rgb_paints(&plain.pdf_bytes);
  assert!(!mono_paints.is_empty(), "inspect actual monochrome drawing colors");
  assert!(
    mono_paints
      .iter()
      .all(|[r, g, b]| (r - g).abs() < 0.001 && (g - b).abs() < 0.001),
    "monochrome must remove chromatic colors from template text and decoration: {mono_paints:?}"
  );
  let plain_text = plain_pages.join("\n");
  assert!(plain_pages.len() < pages.len(), "disabled chrome must remove its pages");
  for absent in ["Contents", "Myoxus PDF Export Review", "Template Input QA", "Page 3"] {
    assert!(!plain_text.contains(absent), "disabled output must omit {absent}");
  }
  assert!(
    plain_text
      .split_whitespace()
      .collect::<Vec<_>>()
      .join(" ")
      .contains("Kapitel 12, Absatz 6"),
    "no content lost with chrome off"
  );
  let pdf = lopdf::Document::load_mem(&plain.pdf_bytes).expect("metadata-default PDF");
  let info = pdf
    .get_dictionary(pdf.trailer.get(b"Info").unwrap().as_reference().unwrap())
    .unwrap();
  assert_eq!(
    lopdf::decode_text_string(info.get(b"Title").unwrap()).unwrap(),
    "Komplexer PDF Export Review"
  );
  assert_eq!(
    lopdf::decode_text_string(info.get(b"Author").unwrap()).unwrap(),
    "PDF Export QA"
  );

  doc.options.footer_style = Some("page-only".into());
  doc.options.page_numbering = Some("roman".into());
  let numbered = render_to_pdf_v2(
    &doc,
    common::documentation_template_bundle(),
    &[fonts_dir()],
    usize::MAX,
  )
  .expect("Roman page-only footer");
  write_review("complex-documentation-numbered.pdf", &numbered.pdf_bytes);
  let numbered_pages = assert_long_output(&numbered.pdf_bytes, "numbered documentation", "Merriweather");
  assert!(numbered_pages[0].contains("Page i"), "Roman numbering reaches the PDF");
  assert!(
    !numbered_pages.join("\n").contains("Myoxus PDF Export Review"),
    "page-only omits identity"
  );

  if let Ok(dir) = std::env::var("MYOXUS_PDF_EXPORT_ARTIFACT_DIR") {
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create PDF artifact dir");
    std::fs::write(dir.join("complex-report-10-page-review.typ"), generated.source).expect("write review Typst source");
  }
}

#[test]
fn inv_v2_letter_template_renders_typed_inputs_around_body() {
  let mut doc = doc("Brief an die Muster GmbH");
  doc.options.template_id = "letter".into();
  doc.options.locale = "de".into();
  doc.options.paper_size = "A4".into();
  doc
    .options
    .template_vars
    .insert("recipient_name".into(), serde_json::json!("Muster GmbH"));
  doc.options.template_vars.insert(
    "recipient_address".into(),
    serde_json::json!(["Frau Erika Beispiel", "Hauptstrasse 42", "12345 Berlin"]),
  );
  doc
    .options
    .template_vars
    .insert("subject_line".into(), serde_json::json!("Betreff: PDF Export Freigabe"));
  doc
    .options
    .template_vars
    .insert("salutation".into(), serde_json::json!("Sehr geehrte Frau Beispiel,"));
  doc
    .options
    .template_vars
    .insert("closing".into(), serde_json::json!("Mit freundlichen Grüßen"));
  doc
    .options
    .template_vars
    .insert("sender_name".into(), serde_json::json!("Myoxus QA"));
  doc
    .options
    .template_vars
    .insert("letter_date".into(), serde_json::json!("2026-06-12"));
  doc.metadata.workspace_name = Some("Myoxus Office".into());
  doc.metadata.branding.footer_text = Some("Myoxus Korrespondenz".into());
  doc.root = Block::Page {
    title: vec![],
    children: vec![paragraph(
      "Der Dokumentkoerper bleibt Renderer-generiert und wird durch das Letter-Template korrekt eingerahmt.",
    )],
  };

  let generated = ir_to_typst_source_v2(&doc, common::letter_template_bundle()).expect("letter source generation");
  for expected in [
    "#let template-recipient-name = \"Muster GmbH\"",
    "#let template-subject-line = \"Betreff: PDF Export Freigabe\"",
    "#let template-letter-date = \"2026-06-12\"",
    "#show: letter-body",
  ] {
    assert!(
      generated.source.contains(expected),
      "letter typed input/source marker `{expected}` must be present:\n{}",
      generated.source
    );
  }
  assert!(
    generated
      .source
      .contains("#let template-recipient-address = (\"Frau Erika Beispiel\", \"Hauptstrasse 42\", \"12345 Berlin\")"),
    "letter address array must be projected into Typst source:\n{}",
    generated.source
  );

  let report = render_to_pdf_v2(&doc, common::letter_template_bundle(), &[fonts_dir()], usize::MAX)
    .expect("letter typed-input PDF must render");
  assert!(report.pdf_bytes.starts_with(b"%PDF-"));
  let pdf_text = pdf_extract::extract_text_from_mem(&report.pdf_bytes).expect("letter PDF text extraction");
  for expected in [
    "Muster GmbH",
    "Frau Erika Beispiel",
    "Hauptstrasse 42",
    "12345 Berlin",
    "2026-06-12",
    "Betreff: PDF Export Freigabe",
    "Sehr geehrte Frau Beispiel",
    "Der Dokumentkoerper bleibt Renderer-generiert",
    "Mit freundlichen Grüßen",
    "Myoxus QA",
  ] {
    assert!(
      pdf_text.contains(expected),
      "letter typed input `{expected}` must be visible in rendered PDF, extracted:\n{pdf_text}"
    );
  }

  doc.options.orientation = "landscape".into();
  let landscape_source =
    ir_to_typst_source_v2(&doc, common::letter_template_bundle()).expect("landscape letter source generation");
  assert!(
    landscape_source.source.contains("#let page-flipped = true"),
    "letter orientation must reach the page composition"
  );
  assert!(
    landscape_source
      .source
      .contains("background: if page-flipped { none } else { place(top + left"),
    "landscape letters must suppress portrait-only DIN folding and punch marks"
  );
  let landscape = render_to_pdf_v2(&doc, common::letter_template_bundle(), &[fonts_dir()], usize::MAX)
    .expect("landscape letter PDF must render");
  let landscape_text =
    pdf_extract::extract_text_from_mem(&landscape.pdf_bytes).expect("landscape letter text extraction");
  for expected in [
    "Muster GmbH",
    "Betreff: PDF Export Freigabe",
    "Der Dokumentkoerper bleibt Renderer-generiert",
  ] {
    assert!(
      landscape_text.contains(expected),
      "landscape letter must retain `{expected}`, extracted:\n{landscape_text}"
    );
  }
  assert_ne!(
    report.pdf_bytes, landscape.pdf_bytes,
    "letter orientation must change the rendered PDF"
  );

  if let Ok(dir) = std::env::var("MYOXUS_PDF_EXPORT_ARTIFACT_DIR") {
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create PDF artifact dir");
    std::fs::write(dir.join("letter-typed-input-review.pdf"), &report.pdf_bytes).expect("write letter review PDF");
    std::fs::write(dir.join("letter-typed-input-review.typ"), generated.source)
      .expect("write letter review Typst source");
    std::fs::write(dir.join("letter-landscape-review.pdf"), &landscape.pdf_bytes)
      .expect("write landscape letter review PDF");
    std::fs::write(dir.join("letter-landscape-review.typ"), landscape_source.source)
      .expect("write landscape letter review Typst source");
  }
}

#[test]
fn inv_v2_source_uses_global_theme_font_roles_and_safe_symbols() {
  let mut doc = doc("Theme Font Roles");
  doc.metadata.branding.code_background = Some("#e4e4e7".to_owned());
  doc.options.theme_fonts = ThemeFontSelection {
    heading: Some("Lora".to_owned()),
    body: Some("Inter".to_owned()),
    mono: Some("JetBrains Mono".to_owned()),
    symbol: Some("Inter".to_owned()),
  };
  doc.options.theme_typography = ThemeTypographySelection {
    heading: Some(typography_style(600, 32.0, 1.2, -0.005)),
    body: Some(typography_style(400, 14.0, 1.55, 0.0)),
    mono: Some(typography_style(400, 13.0, 1.55, 0.0)),
    symbol: Some(typography_style(400, 13.0, 1.55, 0.0)),
  };
  doc.root = Block::Page {
    title: vec![text("Theme Font Roles")],
    children: vec![
      Block::List {
        list_type: ListType::Todo,
        content: vec![text("Checked task")],
        checked: true,
        children: vec![],
      },
      Block::Callout {
        variant: CalloutVariant::Warning,
        emoji: Some("✅".to_owned()),
        content: vec![text("No raw emoji should leak into Typst source.")],
        children: vec![],
      },
      Block::Attachment {
        blob: BlobRef {
          blob_id: "blob-1".to_owned(),
          mime_hint: Some("text/plain".to_owned()),
        },
        name: Some("readme.txt".to_owned()),
        size_bytes: Some(12),
        mime: Some("text/plain".to_owned()),
      },
      Block::Code(CodeBlock {
        language: Some("rust".to_owned()),
        code: "fn theme_surface() -> bool { true }".to_owned(),
        caption: None,
      }),
    ],
  };

  let generated = ir_to_typst_source_v2(&doc, bundle()).expect("source generation");
  assert!(generated.source.contains("#let heading-font = \"Lora\""));
  assert!(generated.source.contains("#let body-font = \"Inter\""));
  assert!(generated.source.contains("#let mono-font = \"JetBrains Mono\""));
  assert!(generated.source.contains("#let symbol-font = \"Inter\""));
  for expected in [
    "#let heading-font-weight = 600",
    "#let heading-size = 22.8pt",
    "#let heading-leading = 0.2em",
    "#let heading-tracking = -0.005em",
    "#let body-font-weight = 400",
    "#let body-size = 11.025pt",
    "#let body-leading = 0.55em",
  ] {
    assert!(
      generated.source.contains(expected),
      "missing theme typography binding `{expected}`:\n{}",
      generated.source
    );
  }
  assert!(generated.source.contains("font: heading-font"));
  assert!(generated.source.contains("#show raw"));
  assert!(generated.source.contains("#let code-background-color = \"#e4e4e7\""));
  assert!(generated.source.contains("fill: rgb(code-background-color)"));
  assert!(generated.source.contains("#pdf-check(true)"));
  assert!(
    generated.source.contains("\"OK\""),
    "todo checkbox helper must use a guaranteed ASCII marker:\n{}",
    generated.source
  );
  assert!(
    !generated.source.contains('✅')
      && !generated.source.contains('📎')
      && !generated.source.contains('✓')
      && !generated.source.contains('☑')
      && !generated.source.contains('☐'),
    "source must avoid unsupported emoji/icon glyphs:\n{}",
    generated.source
  );

  let report = render_to_pdf_v2(&doc, bundle(), &[fonts_dir()], usize::MAX).expect("theme-font source must render");
  assert!(report.pdf_bytes.starts_with(b"%PDF-"));
  if let Ok(dir) = std::env::var("MYOXUS_PDF_EXPORT_ARTIFACT_DIR") {
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create theme-code evidence dir");
    std::fs::write(dir.join("theme-code-background-review.pdf"), &report.pdf_bytes)
      .expect("write theme-code evidence PDF");
    std::fs::write(dir.join("theme-code-background-review.typ"), &generated.source)
      .expect("write theme-code evidence Typst source");
  }
  let pdf_text =
    pdf_extract::extract_text_from_mem(&report.pdf_bytes).expect("safe-symbol PDF text must be extractable");
  for expected in ["OK", "Checked task", "Warn", "Attachment:", "readme.txt"] {
    assert!(
      pdf_text.contains(expected),
      "rendered PDF must expose safe ASCII replacement `{expected}`, extracted:\n{pdf_text}"
    );
  }
  for forbidden in ['✅', '📎', '✓', '☑', '☐'] {
    assert!(
      !pdf_text.contains(forbidden),
      "rendered PDF text must not leak unsupported glyph/icon `{forbidden}`, extracted:\n{pdf_text}"
    );
  }
}

#[test]
fn inv_v2_theme_display_style_changes_visible_text_without_mutating_code_links_or_metadata() {
  let mut styled = doc("Original mixed title");
  let mut heading = typography_style(600, 32.0, 1.2, -0.005);
  heading.text_transform = "uppercase".into();
  heading.decoration = "underline".into();
  let mut body = typography_style(400, 14.0, 1.55, 0.0);
  body.text_transform = "capitalize".into();
  body.decoration = "line-through".into();
  styled.options.theme_typography = ThemeTypographySelection {
    heading: Some(heading),
    body: Some(body),
    mono: Some(typography_style(400, 13.0, 1.55, 0.0)),
    symbol: Some(typography_style(400, 13.0, 1.55, 0.0)),
  };
  styled.root = Block::Page {
    title: vec![],
    children: vec![
      Block::Heading {
        level: HeadingLevel::H1,
        content: vec![text("mixed heading")],
        children: vec![],
      },
      Block::Paragraph {
        content: vec![InlineSpan::Text {
          text: "mixed body link".into(),
          marks: TextMarks {
            link: Some("https://example.com/theme-proof".into()),
            ..Default::default()
          },
        }],
        children: vec![],
      },
      Block::Code(CodeBlock {
        language: Some("rust".into()),
        code: "let MixedCode = \"Keep exact\";".into(),
        caption: None,
      }),
    ],
  };

  let mut neutral = styled.clone();
  for role in [
    &mut neutral.options.theme_typography.heading,
    &mut neutral.options.theme_typography.body,
  ] {
    let role = role.as_mut().expect("theme role");
    role.text_transform = "none".into();
    role.decoration = "none".into();
  }

  let styled_pdf = render_to_pdf_v2(&styled, bundle(), &[fonts_dir()], usize::MAX).expect("styled PDF");
  let neutral_pdf = render_to_pdf_v2(&neutral, bundle(), &[fonts_dir()], usize::MAX).expect("neutral PDF");
  let styled_text = pdf_extract::extract_text_from_mem(&styled_pdf.pdf_bytes).expect("styled PDF text");
  let compact_text: String = styled_text
    .chars()
    .filter(|character| !character.is_whitespace())
    .collect();
  assert!(
    styled_text.contains("MIXED HEADING"),
    "heading transform missing: {styled_text}"
  );
  assert!(
    compact_text.contains("MixedBodyLink"),
    "body transform missing: {styled_text}"
  );
  assert!(
    compact_text.contains("letMixedCode=\"Keepexact\";"),
    "code text changed: {styled_text}"
  );
  assert!(
    pdf_stroked_paths(&styled_pdf.pdf_bytes) > pdf_stroked_paths(&neutral_pdf.pdf_bytes),
    "underline and line-through must add visible PDF strokes"
  );

  let pdf = lopdf::Document::load_mem(&styled_pdf.pdf_bytes).expect("styled PDF structure");
  assert!(
    pdf.objects.values().any(|object| {
      object.as_dict().is_ok_and(|dict| {
        dict.get(b"A").and_then(lopdf::Object::as_dict).is_ok_and(|action| {
          action
            .get(b"URI")
            .is_ok_and(|uri| lopdf::decode_text_string(uri).is_ok_and(|url| url == "https://example.com/theme-proof"))
        })
      })
    }),
    "theme styling must preserve the PDF link target"
  );
  let info = pdf
    .get_dictionary(
      pdf
        .trailer
        .get(b"Info")
        .expect("Info")
        .as_reference()
        .expect("Info reference"),
    )
    .expect("Info dictionary");
  assert_eq!(
    lopdf::decode_text_string(info.get(b"Title").expect("Title")).expect("Title text"),
    "Original mixed title",
    "display styling must not change PDF metadata"
  );
}

/// INV-THEME-FONT-NO-LOCAL-FALLBACKS: the source generator must emit exactly
/// the Theme DB role families it receives. It must not append a local renderer
/// chain such as Inter/Roboto/Poppins/etc. behind the API-resolved role.
#[test]
fn inv_v2_source_does_not_append_local_font_fallbacks() {
  let mut doc = doc("No Local Font Fallbacks");
  doc.options.theme_fonts = ThemeFontSelection {
    heading: Some("Acme Heading".to_owned()),
    body: Some("Acme Body".to_owned()),
    mono: Some("Acme Mono".to_owned()),
    symbol: Some("Acme Symbol".to_owned()),
  };

  let generated = ir_to_typst_source_v2(&doc, bundle()).expect("source generation");
  for expected in [
    "#let heading-font = \"Acme Heading\"",
    "#let body-font = \"Acme Body\"",
    "#let mono-font = \"Acme Mono\"",
    "#let symbol-font = \"Acme Symbol\"",
  ] {
    assert!(
      generated.source.contains(expected),
      "missing exact role binding `{expected}` in source:\n{}",
      generated.source
    );
  }
  for forbidden in [
    "Poppins",
    "Montserrat",
    "Roboto",
    "Open Sans",
    "Source Sans 3",
    "Fira Code",
    "IBM Plex Mono",
    "Source Code Pro",
  ] {
    assert!(
      !generated.source.contains(forbidden),
      "renderer must not append fallback family `{forbidden}`:\n{}",
      generated.source
    );
  }
  assert!(
    !generated.source.contains("#let body-font = ("),
    "font roles must be emitted as required families, not fallback tuples:\n{}",
    generated.source
  );
}

#[test]
fn local_modules_and_nested_data_reach_export_without_main_identity_collision() {
  let rendered = render_to_pdf_v2(&doc("Local modules"), &common::local_import_bundle(), &[], usize::MAX)
    .expect("nested local imports must render");
  let text = pdf_extract::extract_text_from_mem(&rendered.pdf_bytes).expect("selectable export text");
  assert!(
    text.contains("BUNDLE LOCAL IMPORT VERIFIED"),
    "nested JSON content missing: {text}"
  );
  assert!(
    text.contains("Local modules"),
    "generated document was replaced: {text}"
  );
}

#[test]
fn inaccessible_bundle_sources_fail_export() {
  for (name, files) in common::invalid_local_import_bundles() {
    let result = render_to_pdf_v2(&doc("Invalid modules"), &files, &[], usize::MAX);
    assert!(result.is_err(), "{name} must be rejected");
  }
}

#[tokio::test]
async fn parent_local_note_placements_compile_with_shared_numbers_and_complete_bodies() {
  use yrs::{Doc, Map, Out, ReadTxn, StateVector, Transact, Update, updates::decoder::Decode};
  let fixture: serde_json::Value = serde_json::from_str(include_str!(
    "../../../../build/fixtures/contracts/footnote-numbering.json"
  ))
  .unwrap();
  let binary = yjs::markdown_to_yjs("Placement", fixture["source"].as_str().unwrap()).unwrap();
  let native = Doc::new();
  let blocks = native.get_or_insert_map("blocks");
  let mut txn = native.transact_mut();
  txn.apply_update(Update::decode_v1(&binary).unwrap()).unwrap();
  let definitions: Vec<_> = blocks
    .iter(&txn)
    .filter_map(|(_, value)| {
      let Out::YMap(block) = value else { return None };
      let Some(Out::Any(yrs::Any::String(label))) = block.get(&txn, "prop:label") else {
        return None;
      };
      Some((block, label.to_string()))
    })
    .collect();
  for (block, label) in definitions {
    if let Some(placement) = fixture["placements"][&label].as_str() {
      block.insert(&mut txn, "prop:placement", placement);
    } else {
      block.remove(&mut txn, "prop:placement");
    }
  }
  let binary = txn.encode_state_as_update_v1(&StateVector::default());
  drop(txn);
  let base = doc("Placement");
  let ir = myoxus_pdf_export::YjsIrBuilder::new(myoxus_pdf_export::NullAssetResolver)
    .build(&binary, base.metadata, base.options)
    .await
    .unwrap();
  let source = ir_to_typst_source_v2(&ir, bundle()).unwrap().source;
  // Three local entries and the two deployed citation occurrences use the
  // same Typst counter; the repeated local marker reuses a label.
  assert_eq!(source.matches("#footnote[").count(), 5);
  assert_eq!(source.matches("#footnote(<").count(), 1);
  assert_eq!(source.matches("Endnote 1").count(), 1);
  assert_eq!(source.matches("Foot body.").count(), 1);
  assert!(source.contains("sticky: true"));
  assert!(!source.contains("[^Research]"));
  let rendered =
    render_to_pdf_v2(&ir, bundle(), &[fonts_dir()], usize::MAX).unwrap_or_else(|error| panic!("{error}\n{source}"));
  let text = common::pdf_page_text(&rendered.pdf_bytes).join("\n");
  for body in [
    "End body.",
    "Foot body.",
    "Later body.",
    "Table body.",
    "Retained body.",
    "https://example.org",
  ] {
    assert_eq!(text.matches(body).count(), 1, "{body}: {text}");
  }
  assert!(text.contains("Endnote 1"), "{text}");
  assert!(text.contains("Unreferenced notes"), "{text}");
  assert!(text.contains("Endnote — no reference"), "{text}");
  assert!(!text.contains("[^Research]"), "{text}");
}

#[tokio::test]
async fn parent_local_notes_continue_across_pages_and_keep_cross_page_repeat_identity() {
  use yrs::{Doc, Map, Out, ReadTxn, StateVector, Transact, Update, updates::decoder::Decode};
  struct Diagram;
  impl myoxus_pdf_export::AssetResolver for Diagram {
    async fn resolve(&mut self, id: &str) -> Result<AssetData, myoxus_pdf_export::error::AssetError> {
      use base64::Engine;
      let bytes = include_bytes!("../../../../build/fixtures/markdown/structured-footnotes-pagination.svg");
      let expected = format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
      );
      assert_eq!(id, expected);
      Ok(AssetData {
        mime: "image/svg+xml".into(),
        bytes: include_bytes!("../../../../build/fixtures/markdown/structured-footnotes-pagination.svg").to_vec(),
        filename: Some("structured-footnotes-pagination.svg".into()),
      })
    }
  }
  let binary = yjs::markdown_to_yjs(
    "Multi-page local notes",
    include_str!("../../../../build/fixtures/markdown/structured-footnotes-pagination.md"),
  )
  .unwrap();
  let native = Doc::new();
  let blocks = native.get_or_insert_map("blocks");
  let mut txn = native.transact_mut();
  txn.apply_update(Update::decode_v1(&binary).unwrap()).unwrap();
  let definitions: Vec<_> = blocks
    .iter(&txn)
    .filter_map(|(_, value)| {
      let Out::YMap(block) = value else { return None };
      let Some(Out::Any(yrs::Any::String(label))) = block.get(&txn, "prop:label") else {
        return None;
      };
      Some((block, label.to_string()))
    })
    .collect();
  assert_eq!(definitions.len(), 8);
  for (block, label) in definitions {
    block.insert(
      &mut txn,
      "prop:placement",
      if ["EndA", "EndB", "Unused"].contains(&label.as_str()) {
        "endnote"
      } else {
        "footnote"
      },
    );
  }
  let snapshot = txn.encode_state_as_update_v1(&StateVector::default());
  drop(txn);
  let base = doc("Multi-page local notes");
  let ir = myoxus_pdf_export::YjsIrBuilder::new(Diagram)
    .build(&snapshot, base.metadata, base.options)
    .await
    .unwrap();
  assert_eq!(ir.assets.len(), 1);
  assert_eq!(
    ir.assets.values().next().unwrap().bytes,
    include_bytes!("../../../../build/fixtures/markdown/structured-footnotes-pagination.svg")
  );
  let source = ir_to_typst_source_v2(&ir, bundle()).unwrap().source;
  assert_eq!(
    source.matches("#footnote[").count(),
    6,
    "five local entries plus the legacy citation"
  );
  assert_eq!(
    source.matches("#footnote(<").count(),
    1,
    "one repeat shares a labelled entry"
  );
  let rendered = render_to_pdf_v2(&ir, bundle(), &[fonts_dir()], usize::MAX).unwrap();
  // Styled PDF text runs can add spacing around marks. Normalize whitespace
  // within each page while retaining page boundaries and complete content.
  let pages: Vec<_> = common::pdf_page_text(&rendered.pdf_bytes)
    .into_iter()
    .map(|page| page.split_whitespace().collect::<Vec<_>>().join(" "))
    .collect();
  assert!(pages.len() >= 3, "actual rendered page count: {}", pages.len());
  let page_of = |text: &str| {
    pages
      .iter()
      .position(|page| page.contains(text))
      .unwrap_or_else(|| panic!("missing {text}: {pages:?}"))
  };
  let all = pages.join("\n");
  for body in [
    "EARLY FOOTNOTE BODY",
    "SHARED FOOTNOTE BODY",
    "LATE FOOTNOTE BODY",
    "TABLE FOOTNOTE BODY",
    "ENDNOTE ALPHA BODY",
    "ENDNOTE BETA BODY",
    "UNUSED NOTE BODY",
  ] {
    assert_eq!(all.matches(body).count(), 1, "one complete body for {body}: {pages:?}");
  }
  assert_eq!(page_of("EARLY ORIGIN"), page_of("EARLY FOOTNOTE BODY"));
  assert_eq!(page_of("SHARED ORIGIN"), page_of("SHARED FOOTNOTE BODY"));
  assert!(
    page_of("LATE ORIGIN") > page_of("SHARED ORIGIN"),
    "repeat must be on a different actual page"
  );
  assert_eq!(page_of("LATE ORIGIN"), page_of("LATE FOOTNOTE BODY"));
  assert_eq!(page_of("TABLE ORIGIN"), page_of("TABLE FOOTNOTE BODY"));
  assert_eq!(page_of("LONG ORIGIN"), page_of("LONG NOTE SEGMENT 01"));
  assert!(
    page_of("LONG NOTE SEGMENT 32") > page_of("LONG NOTE SEGMENT 01"),
    "complete long footnote must continue across actual pages"
  );
  for n in 1..=32 {
    assert_eq!(
      all.matches(&format!("LONG NOTE SEGMENT {n:02}")).count(),
      1,
      "complete unique continuation segment {n}"
    );
  }
  for n in 1..=33 {
    assert_eq!(
      all.matches(&format!("MAIN SEGMENT {n:02}")).count(),
      1,
      "complete unique main body segment {n}"
    );
  }
  assert!(all.find("ENDNOTE ALPHA BODY").unwrap() > all.find("END OF MAIN BODY CHECKPOINT").unwrap());
  assert!(all.find("ENDNOTE BETA BODY").unwrap() > all.find("ENDNOTE ALPHA BODY").unwrap());
  for preserved in [
    "rich endnote paragraph",
    "quoted endnote paragraph",
    "endnoteIdentity",
    "Complete table",
    "Second normal endnote list item",
    "Endnote 1",
    "Endnote 2",
    "Endnote — no reference",
  ] {
    assert!(all.contains(preserved), "missing rich retained content: {preserved}");
  }
}
