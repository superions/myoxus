// SPDX-License-Identifier: AGPL-3.0-or-later
//! Converts an [`IrDocument`] to a Typst source string.
//!
//! The generated source is self-contained: all block and inline types from the
//! IR Block-Scope (P3) are covered. Images are referenced via virtual
//! `blob:<id>` paths that the [`TypstWorld`] file resolver serves from the
//! IR asset map.

use std::collections::HashMap;
use std::fmt::Write;

use crate::ir::{
  ExportOptions, IrDocument, ThemeFontSelection, ThemeTypographySelection, ThemeTypographyStyle,
  block::*,
  inline::{InlineSpan, TextMarks, inline_plain_text},
};
use crate::mermaid::{MermaidExportRenderer, MermanSvgRenderer, mermaid_svg_asset_key};

use super::world::BLOB_PATH_PREFIX;

/// Synthetic blob-id prefix for edgeless raster snapshots that the IR carries
/// inline as `EdgelessSnapshot.png_bytes`. Each occurrence of a non-empty
/// snapshot in document order receives the next index — `__edgeless_snapshot_0`,
/// `__edgeless_snapshot_1`, … — and the bytes are surfaced via
/// [`GeneratedSource::inline_assets`] so the engine can register them in the
/// virtual filesystem alongside `IrDocument.assets`.
const EDGELESS_SNAPSHOT_BLOB_PREFIX: &str = "__edgeless_snapshot_";
/// Preamble opt-in marker for templates that place their own in-content TOC.
/// When present, the generic source generator skips its fallback `#outline`
/// injection so templates such as `report` do not render duplicate contents
/// pages. Keep this as a plain comment marker rather than a Typst binding so
/// existing custom templates remain valid Typst sources.
const TEMPLATE_HANDLES_TOC_MARKER: &str = "MYOXUS_TEMPLATE_HANDLES_TOC";
/// Preamble marker for templates whose manifest default includes a cover page.
/// The API normally sends an explicit `cover_page` L3 input; this marker keeps
/// direct renderer callers and preview/stub paths aligned with bundled
/// template defaults when that override is absent.
const TEMPLATE_DEFAULT_COVER_PAGE_MARKER: &str = "MYOXUS_TEMPLATE_DEFAULT_COVER_PAGE";
/// Preamble opt-in marker for templates that compose the document title in
/// their own cover/slide layout instead of the generic flow heading. Importers
/// may also retain that title as the first H1, so the marker suppresses one
/// exact leading H1 copy while preserving its following body content.
const TEMPLATE_HANDLES_DOCUMENT_TITLE_MARKER: &str = "MYOXUS_TEMPLATE_HANDLES_DOCUMENT_TITLE";
/// Flow templates may select the typed title without taking over title layout.
/// Unmarked/custom bundles retain their rich native title; metadata and the
/// document-derived filename always continue to use the source title.
const TEMPLATE_USES_TYPED_FLOW_TITLE_MARKER: &str = "MYOXUS_TEMPLATE_USES_TYPED_FLOW_TITLE";
/// Preamble opt-in marker for templates that expose their exact page insets to
/// the shared visual fitter. Custom bundles without the marker keep their
/// existing image composition rather than receiving rewritten layout rules.
const TEMPLATE_HANDLES_DIAGRAM_FIT_MARKER: &str = "MYOXUS_TEMPLATE_HANDLES_DIAGRAM_FIT";

/// Output of the source generator: the Typst `.typ` source plus any binary
/// assets the source references that are *not* already in `IrDocument.assets`.
/// Currently used for edgeless-snapshot PNG bytes (see
/// [`EDGELESS_SNAPSHOT_BLOB_PREFIX`]). The engine merges these into the asset
/// map before constructing the world.
#[derive(Debug, Default)]
pub struct GeneratedSource {
  pub source: String,
  pub inline_assets: HashMap<String, Vec<u8>>,
}

#[derive(Default)]
struct RenderState {
  out: String,
  inline_assets: HashMap<String, Vec<u8>>,
  edgeless_snapshot_counter: usize,
  template_handles_diagram_fit: bool,
  leading_document_title: Option<String>,
  locale: String,
  inside_footnote: bool,
}

impl RenderState {
  fn next_edgeless_snapshot_key(&mut self) -> String {
    let key = format!("{EDGELESS_SNAPSHOT_BLOB_PREFIX}{}", self.edgeless_snapshot_counter);
    self.edgeless_snapshot_counter += 1;
    key
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────

/// Errors specific to the V2 source generator. Distinct from the broader
/// [`crate::error::RenderError`] because the generator runs **before** the
/// Typst pipeline and its failures are about template-shape, not Typst
/// compilation.
#[derive(Debug, thiserror::Error)]
pub enum SourceV2Error {
  /// A template bundle is missing a required file (`theme.typ` /
  /// `preamble.typ`). The V2 manifest's `assets` array is the authority
  /// on which files _must_ be present; this guard catches inconsistencies
  /// between manifest and bundle that the validator already saw.
  #[error("template bundle is missing required file `{0}`")]
  MissingFile(&'static str),

  /// A template file is not valid UTF-8. Typst sources must be text;
  /// embedding binary blobs as `theme.typ` is a hard error.
  #[error("template file `{0}` is not valid UTF-8: {1}")]
  InvalidUtf8(&'static str, String),

  /// The API must resolve all four PDF font roles from the effective Theme DB
  /// profile before the renderer runs. The renderer does not append local
  /// fallback chains, because that would create a second font-selection truth.
  #[error("missing effective PDF theme font role `{0}`")]
  MissingThemeFontRole(&'static str),

  #[error("invalid effective PDF typography `{0}.{1}`")]
  InvalidThemeTypographyRole(&'static str, &'static str),
}

/// Convert an `IrDocument` to source + inline assets using a V2 template
/// **bundle** (`HashMap<String, Vec<u8>>`).
///
/// The bundle must contain `theme.typ` + `preamble.typ`. Other files are
/// resolved by the compiler world when the composed source imports modules
/// or reads data; this generator does not execute `manifest.entry`.
///
/// This is the only source-generation path: V1's `Template::lookup` +
/// `include_str!` realisation was removed in `P-PDF-TPL-06-04-CUTOVER`
/// (2026-04-30), so there is no parallel code path to keep in sync.
pub fn ir_to_typst_source_v2(
  doc: &IrDocument,
  template_files: &HashMap<String, Vec<u8>>,
) -> Result<GeneratedSource, SourceV2Error> {
  let theme_bytes = template_files
    .get("theme.typ")
    .ok_or(SourceV2Error::MissingFile("theme.typ"))?;
  let preamble_bytes = template_files
    .get("preamble.typ")
    .ok_or(SourceV2Error::MissingFile("preamble.typ"))?;
  let theme = std::str::from_utf8(theme_bytes).map_err(|e| SourceV2Error::InvalidUtf8("theme.typ", e.to_string()))?;
  let preamble =
    std::str::from_utf8(preamble_bytes).map_err(|e| SourceV2Error::InvalidUtf8("preamble.typ", e.to_string()))?;

  let mut state = RenderState {
    out: String::with_capacity(8192),
    template_handles_diagram_fit: preamble.contains(TEMPLATE_HANDLES_DIAGRAM_FIT_MARKER),
    locale: doc.options.locale.clone(),
    ..Default::default()
  };

  write_dynamic_bindings(&mut state.out, doc, preamble)?;
  state.out.push_str(theme);
  state.out.push('\n');
  state.out.push_str(preamble);
  state.out.push('\n');

  if let Block::Page { title, children } = &doc.root {
    let typed_title = template_var_string(&doc.options.template_vars, "title");
    let use_typed_title = preamble.contains(TEMPLATE_USES_TYPED_FLOW_TITLE_MARKER) && !typed_title.is_empty();
    if (!title.is_empty() || use_typed_title) && !template_handles_document_title(preamble) {
      let title_text = if use_typed_title {
        format!("#myoxus-heading-string(\"{}\")", escape_str(&typed_title))
      } else {
        render_inline_heading(title)
      };
      let _ = writeln!(
        state.out,
        "#align(left, block(width: 100%)[#set text(font: heading-font, size: heading-size, weight: heading-font-weight, style: heading-font-style, tracking: heading-tracking)\n#set par(leading: heading-leading, justify: false)\n{title_text}])"
      );
      let _ = writeln!(state.out);
    }
    if doc.options.toc_behavior != "off" && !template_handles_toc(preamble) {
      let _ = writeln!(state.out, "#outline(title: [Contents], indent: auto)");
      let _ = writeln!(state.out);
      let _ = writeln!(state.out, "#pagebreak()");
      let _ = writeln!(state.out);
    }
    state.leading_document_title = template_handles_document_title(preamble)
      .then(|| inline_plain_text(title).trim().to_owned())
      .filter(|title| !title.is_empty());
    for child in children {
      write_block(&mut state, child, 0);
    }
  } else {
    write_block(&mut state, &doc.root, 0);
  }

  Ok(GeneratedSource {
    source: state.out,
    inline_assets: state.inline_assets,
  })
}

// ─── Dynamic bindings (consumed by preamble.typ) ─────────────────────────────

fn required_font_family(role: &'static str, family: Option<&str>) -> Result<String, SourceV2Error> {
  let Some(family) = family.map(str::trim).filter(|value| !value.is_empty()) else {
    return Err(SourceV2Error::MissingThemeFontRole(role));
  };
  Ok(format!("\"{}\"", escape_str(family)))
}

fn document_pdf_filename(title: &str) -> String {
  let stem = title
    .trim()
    .chars()
    .map(|character| match character {
      '/' | '\\' | '?' | '%' | '*' | ':' | '|' | '"' | '<' | '>' => '-',
      character if character.is_control() => '-',
      character => character,
    })
    .collect::<String>();
  let stem = stem.trim_matches([' ', '.']);
  format!("{}.pdf", if stem.is_empty() { "export" } else { stem })
}

fn fallback_typography_style(font_weight: u16, size_px: f64, line_height: f64) -> ThemeTypographyStyle {
  ThemeTypographyStyle {
    font_weight,
    font_style: "normal".into(),
    size_px,
    line_height,
    letter_spacing_em: 0.0,
    text_transform: "none".into(),
    decoration: "none".into(),
  }
}

fn typst_number(value: f64) -> String {
  let value = if value == -0.0 { 0.0 } else { value };
  let formatted = format!("{value:.4}");
  formatted.trim_end_matches('0').trim_end_matches('.').to_owned()
}

fn write_typography_role_bindings(
  out: &mut String,
  role: &'static str,
  style: &ThemeTypographyStyle,
  scale: f64,
) -> Result<(), SourceV2Error> {
  if !(1..=1000).contains(&style.font_weight) {
    return Err(SourceV2Error::InvalidThemeTypographyRole(role, "font_weight"));
  }
  if !matches!(style.font_style.as_str(), "normal" | "italic" | "oblique") {
    return Err(SourceV2Error::InvalidThemeTypographyRole(role, "font_style"));
  }
  if !matches!(
    style.text_transform.as_str(),
    "none" | "uppercase" | "lowercase" | "capitalize"
  ) {
    return Err(SourceV2Error::InvalidThemeTypographyRole(role, "text_transform"));
  }
  if !matches!(style.decoration.as_str(), "none" | "underline" | "line-through") {
    return Err(SourceV2Error::InvalidThemeTypographyRole(role, "decoration"));
  }
  for (field, value, min, max) in [
    ("size_px", style.size_px, 6.0, 200.0),
    ("line_height", style.line_height, 0.5, 4.0),
    ("letter_spacing_em", style.letter_spacing_em, -0.5, 1.0),
  ] {
    if !value.is_finite() || !(min..=max).contains(&value) {
      return Err(SourceV2Error::InvalidThemeTypographyRole(role, field));
    }
  }
  if !scale.is_finite() || !(0.5..=1.5).contains(&scale) {
    return Err(SourceV2Error::InvalidThemeTypographyRole(role, "font_scale"));
  }
  let size_pt = style.size_px * 0.75 * scale;
  let leading_em = style.line_height - 1.0;
  // Typst accepts numeric weights in the CSS-compatible 100..900 range. The
  // theme model intentionally accepts the wider CSS Fonts 4 1..1000 range;
  // materialise the boundary exactly as Typst itself does instead of rejecting
  // an otherwise valid server theme.
  let _ = writeln!(out, "#let {role}-font-weight = {}", style.font_weight.clamp(100, 900));
  let _ = writeln!(out, "#let {role}-font-style = \"{}\"", style.font_style);
  let _ = writeln!(out, "#let {role}-text-transform = \"{}\"", style.text_transform);
  let _ = writeln!(out, "#let {role}-decoration = \"{}\"", style.decoration);
  let _ = writeln!(out, "#let {role}-size = {}pt", typst_number(size_pt));
  let _ = writeln!(out, "#let {role}-leading = {}em", typst_number(leading_em));
  let _ = writeln!(
    out,
    "#let {role}-tracking = {}em",
    typst_number(style.letter_spacing_em)
  );
  Ok(())
}

fn write_text_style_helpers(out: &mut String) {
  out.push_str(
    r#"#let myoxus-capitalize-string(value) = value.replace(
  regex("(^|[^\\p{L}\\p{N}])(\\p{L})"),
  found => found.captures.at(0) + upper(found.captures.at(1)),
)
#let myoxus-transform-string(value, transform) = if transform == "uppercase" {
  upper(value)
} else if transform == "lowercase" {
  lower(value)
} else if transform == "capitalize" {
  myoxus-capitalize-string(value)
} else {
  value
}
#let myoxus-decorate-text(content, decoration) = if decoration == "underline" {
  underline(content)
} else if decoration == "line-through" {
  strike(content)
} else {
  content
}
#let myoxus-style-string(value, transform, decoration) = myoxus-decorate-text(
  myoxus-transform-string(value, transform),
  decoration,
)
#let myoxus-body-string(value) = myoxus-style-string(value, body-text-transform, body-decoration)
#let myoxus-heading-string(value) = myoxus-style-string(value, heading-text-transform, heading-decoration)
"#,
  );
}

fn write_theme_typography_bindings(
  out: &mut String,
  typography: &ThemeTypographySelection,
  heading_font_scale: f64,
  body_font_scale: f64,
) -> Result<(), SourceV2Error> {
  let heading = typography
    .heading
    .clone()
    .unwrap_or_else(|| fallback_typography_style(700, 32.0, 1.2));
  let body = typography
    .body
    .clone()
    .unwrap_or_else(|| fallback_typography_style(400, 14.6667, 1.65));
  let mono = typography
    .mono
    .clone()
    .unwrap_or_else(|| fallback_typography_style(400, 13.0, 1.55));
  let symbol = typography
    .symbol
    .clone()
    .unwrap_or_else(|| fallback_typography_style(400, 13.0, 1.55));
  write_typography_role_bindings(out, "heading", &heading, heading_font_scale)?;
  write_typography_role_bindings(out, "body", &body, body_font_scale)?;
  write_typography_role_bindings(out, "mono", &mono, body_font_scale)?;
  write_typography_role_bindings(out, "symbol", &symbol, body_font_scale)?;
  write_text_style_helpers(out);
  Ok(())
}

/// Emit product-neutral document roles derived from the already resolved
/// palette and typography. Bundled templates consume these roles, while older
/// uploaded bundles can ignore the additive bindings and keep their own style.
fn write_document_style_bindings(out: &mut String) {
  out.push_str(
    r#"#let secondary-text-fill = color.mix((rgb(text-color), 68%), (rgb(bg-color), 32%))
#let neutral-surface-fill = color.mix((rgb(bg-color), 92%), (rgb(rule-color), 8%))
#let strong-neutral-surface-fill = color.mix((rgb(bg-color), 84%), (rgb(rule-color), 16%))
#let structural-stroke = rgb(rule-color)
#let secondary-body-size = body-size * 0.772727
#let compact-body-size = body-size * 0.727273
#let body-meta-size = body-size * 0.909091
#let cover-title-size = heading-size * 1.083333
#let cover-subtitle-size = body-size * 1.272727
#let toc-heading-size = heading-size * 0.75
#let secondary-leading = body-leading * 0.772727
#let body-paragraph-spacing = 1.2em
#let body-list-spacing = 0.35em
#let body-caption-spacing = 0.36em
#let myoxus-caption(content) = text(size: secondary-body-size, fill: secondary-text-fill, content)
"#,
  );
}

fn write_dynamic_bindings(out: &mut String, doc: &IrDocument, preamble: &str) -> Result<(), SourceV2Error> {
  let ExportOptions {
    template_id: _,
    locale,
    paper_size,
    orientation,
    heading_font_scale,
    body_font_scale,
    toc_behavior,
    footer_style,
    page_numbering,
    color_variant,
    cover_page,
    confidentiality_label,
    theme_fonts,
    theme_typography,
    native_table_palette: _,
    color_profile,
    image_quality,
    ligatures_enabled,
    compliance_profile: _,
    doc_version_label,
    keywords,
    template_vars,
  } = &doc.options;

  let paper = match paper_size.as_str() {
    "Letter" => "us-letter",
    "A3" => "a3",
    "A5" => "a5",
    "16:9" => "presentation-16-9",
    _ => "a4",
  };
  let page_flipped = orientation == "landscape";
  let (portrait_width, portrait_height) = match paper_size.as_str() {
    "Letter" => ("215.9mm", "279.4mm"),
    "A3" => ("297.0mm", "420.0mm"),
    "A5" => ("148.0mm", "210.0mm"),
    "16:9" => ("540pt", "960pt"),
    _ => ("210.0mm", "297.0mm"),
  };
  let (page_width, page_height) = if page_flipped {
    (portrait_height, portrait_width)
  } else {
    (portrait_width, portrait_height)
  };
  let title = doc.metadata.title.as_deref().unwrap_or("");
  let author = doc.metadata.author.as_deref().unwrap_or("");
  let branding = &doc.metadata.branding;
  let workspace = doc
    .metadata
    .workspace_name
    .as_deref()
    .or(branding.organization_name.as_deref())
    .unwrap_or("");
  let organization_name = branding.organization_name.as_deref().unwrap_or(workspace);
  let primary_color = branding
    .primary
    .as_deref()
    .or(branding.accent.as_deref())
    .unwrap_or("#1a1a1a");
  let accent = branding
    .accent
    .as_deref()
    .or(branding.primary.as_deref())
    .unwrap_or("#1a1a1a");
  let rule_color = branding
    .rule
    .as_deref()
    .or(branding.accent.as_deref())
    .unwrap_or("#d0d0d0");
  let text_color = branding.text_primary.as_deref().unwrap_or("#333333");
  let bg_color = branding.background.as_deref().unwrap_or("#ffffff");
  let code_background_color = branding.code_background.as_deref().unwrap_or("#f1f3f5");
  let footer_text = branding.footer_text.as_deref().unwrap_or("");
  let legal_text = branding.legal_text.as_deref().unwrap_or("");
  let logo_large_path = branding.logo_large_path.as_deref().unwrap_or("");
  let logo_small_path = branding.logo_small_path.as_deref().unwrap_or("");
  let color_profile = color_profile.as_deref().unwrap_or("sRGB");
  let image_quality = image_quality.as_deref().unwrap_or("high");
  let ligatures = if *ligatures_enabled { "true" } else { "false" };
  let cover_page_enabled = cover_page.unwrap_or_else(|| template_defaults_cover_page(preamble));
  let confidentiality_label = confidentiality_label.as_deref().unwrap_or("");
  let filename = document_pdf_filename(title);

  let _ = writeln!(out, "#let doc-title = \"{}\"", escape_str(title));
  let _ = writeln!(out, "#let doc-filename = \"{}\"", escape_str(&filename));
  let _ = writeln!(out, "#let doc-author = \"{}\"", escape_str(author));
  let _ = writeln!(out, "#let workspace-name = \"{}\"", escape_str(workspace));
  let _ = writeln!(
    out,
    "#let brand-organization-name = \"{}\"",
    escape_str(organization_name)
  );
  let _ = writeln!(out, "#let brand-footer-text = \"{}\"", escape_str(footer_text));
  let _ = writeln!(out, "#let brand-legal-text = \"{}\"", escape_str(legal_text));
  let _ = writeln!(out, "#let brand-logo-large = \"{}\"", escape_str(logo_large_path));
  let _ = writeln!(out, "#let brand-logo-small = \"{}\"", escape_str(logo_small_path));
  let _ = writeln!(
    out,
    "#let doc-version = \"{}\"",
    escape_str(doc_version_label.as_deref().unwrap_or(""))
  );
  let _ = writeln!(out, "#let paper = \"{paper}\"");
  let _ = writeln!(out, "#let page-flipped = {page_flipped}");
  let _ = writeln!(out, "#let myoxus-page-width = {page_width}");
  let _ = writeln!(out, "#let myoxus-page-height = {page_height}");
  let _ = writeln!(out, "#let primary-color = \"{}\"", escape_str(primary_color));
  let _ = writeln!(out, "#let accent = \"{}\"", escape_str(accent));
  let _ = writeln!(out, "#let accent-color = \"{}\"", escape_str(accent));
  let _ = writeln!(out, "#let rule-color = \"{}\"", escape_str(rule_color));
  let _ = writeln!(out, "#let text-color = \"{}\"", escape_str(text_color));
  let _ = writeln!(out, "#let bg-color = \"{}\"", escape_str(bg_color));
  let _ = writeln!(
    out,
    "#let code-background-color = \"{}\"",
    escape_str(code_background_color)
  );
  // Typst's text language is an ISO 639 code; retain the complete locale on
  // the IR for localized content, but omit its BCP 47 region/script here.
  let language = locale.split(['-', '_']).next().unwrap_or(locale);
  let _ = writeln!(out, "#let lang = \"{}\"", escape_str(language));
  let _ = writeln!(out, "#let toc-behavior = \"{}\"", escape_str(toc_behavior));
  let _ = writeln!(out, "#let cover-page-enabled = {cover_page_enabled}");
  let _ = writeln!(
    out,
    "#let footer-style = \"{}\"",
    escape_str(footer_style.as_deref().unwrap_or(""))
  );
  let _ = writeln!(
    out,
    "#let page-numbering = \"{}\"",
    escape_str(page_numbering.as_deref().unwrap_or(""))
  );
  let _ = writeln!(
    out,
    "#let color-variant = \"{}\"",
    escape_str(color_variant.as_deref().unwrap_or(""))
  );

  out.push_str(r##"// Variants alter the effective document palette without introducing fixed colors.
#let primary-color = if color-variant == "mono" { luma(rgb(primary-color)).to-hex() } else if color-variant == "accent" { luma(rgb(text-color)).to-hex() } else { primary-color }
#let accent = if color-variant == "mono" { luma(rgb(accent)).to-hex() } else { accent }
#let text-color = if color-variant in ("mono", "accent") { luma(rgb(text-color)).to-hex() } else { text-color }
#let bg-color = if color-variant in ("mono", "accent") { luma(rgb(bg-color)).to-hex() } else { bg-color }
#let rule-color = if color-variant in ("mono", "accent") { luma(rgb(rule-color)).to-hex() } else { rule-color }
#let code-background-color = if color-variant in ("mono", "accent") { luma(rgb(code-background-color)).to-hex() } else { code-background-color }
#let native-table-color(value) = if color-variant in ("mono", "accent") { luma(rgb(value)) } else { rgb(value) }
"##);

  let _ = writeln!(
    out,
    "#let confidentiality-label = \"{}\"",
    escape_str(confidentiality_label)
  );
  let _ = writeln!(out, "#let color-profile = \"{}\"", escape_str(color_profile));
  let _ = writeln!(out, "#let image-quality = \"{}\"", escape_str(image_quality));
  let _ = writeln!(out, "#let ligatures-enabled = {ligatures}");
  write_template_var_bindings(out, template_vars);

  // PDF /Keywords metadata. Empty vector → empty Typst array; preamble
  // forwards the binding to `#set document(keywords: …)` unconditionally,
  // and Typst treats an empty array as "no keywords entry".
  let keyword_entries: Vec<String> = keywords.iter().map(|k| format!("\"{}\"", escape_str(k))).collect();
  let _ = if keyword_entries.is_empty() {
    writeln!(out, "#let doc-keywords = ()")
  } else if keyword_entries.len() == 1 {
    // Typst parses `("foo")` as the parenthesised string `"foo"`, not an
    // array — a trailing comma is required to keep the singleton typed
    // as an array.
    writeln!(out, "#let doc-keywords = ({},)", keyword_entries[0])
  } else {
    writeln!(out, "#let doc-keywords = ({})", keyword_entries.join(", "))
  };

  // PDF /CreationDate metadata. Sourced from `metadata.created_at` (UTC).
  // Emitted as `none` when missing so the preamble can branch.
  if let Some(dt) = doc.metadata.created_at {
    let _ = writeln!(
      out,
      "#let doc-date = datetime(year: {}, month: {}, day: {})",
      dt.format("%Y"),
      dt.format("%-m"),
      dt.format("%-d")
    );
  } else {
    let _ = writeln!(out, "#let doc-date = none");
  }

  let ThemeFontSelection {
    heading,
    body,
    mono,
    symbol,
  } = theme_fonts;
  let _ = writeln!(
    out,
    "#let heading-font = {}",
    required_font_family("heading", heading.as_deref())?
  );
  let _ = writeln!(
    out,
    "#let body-font = {}",
    required_font_family("body", body.as_deref())?
  );
  let _ = writeln!(
    out,
    "#let mono-font = {}",
    required_font_family("mono", mono.as_deref())?
  );
  let _ = writeln!(
    out,
    "#let symbol-font = {}",
    required_font_family("symbol", symbol.as_deref())?
  );
  write_theme_typography_bindings(out, theme_typography, *heading_font_scale, *body_font_scale)?;
  write_document_style_bindings(out);
  out.push_str(
    r#"#let myoxus-diagram-fitter(horizontal-inset, vertical-inset, enlarge-wide: false) = (
  path,
  requested-width: none,
  caption: none,
  alt: "",
) => context {
  let natural-image = if requested-width == none {
    image(path, alt: alt)
  } else {
    image(path, width: requested-width, alt: alt)
  }
  let natural = measure(natural-image)
  let caption-reserve = if caption == none { 0pt } else { measure(caption).height + 6pt }
  let max-width = myoxus-page-width - horizontal-inset
  let max-height = myoxus-page-height - vertical-inset - caption-reserve
  let factor = if enlarge-wide and natural.width / natural.height >= 2 {
    calc.min(max-width.pt() / natural.width.pt(), max-height.pt() / natural.height.pt())
  } else {
    calc.min(1, max-width.pt() / natural.width.pt(), max-height.pt() / natural.height.pt())
  }
  let fitted = image(
    path,
    width: natural.width * factor,
    height: natural.height * factor,
    fit: "contain",
    alt: alt,
  )
  block(breakable: false, width: 100%)[
    #align(center, if caption == none { fitted } else { figure(fitted, caption: caption) })
  ]
}
"#,
  );
  let _ = writeln!(
    out,
    "#let pdf-check(checked) = box(width: 1.2em, height: 0.9em, inset: 0pt, stroke: 0.7pt + rgb(accent), radius: 1pt, if checked {{ text(font: symbol-font, size: 0.48em, weight: symbol-font-weight, style: symbol-font-style, tracking: symbol-tracking, fill: rgb(text-color), \"OK\") }} else {{ [] }})"
  );
  let _ = writeln!(out);
  Ok(())
}

fn write_template_var_bindings(out: &mut String, vars: &HashMap<String, serde_json::Value>) {
  const STRING_KEYS: &[(&str, &str)] = &[
    ("title", "template-title"),
    ("subtitle", "template-subtitle"),
    ("executive_summary", "template-executive-summary"),
    ("report_date", "template-report-date"),
    ("author", "template-author"),
    ("confidentiality_label", "template-confidentiality-label"),
    ("recipient_name", "template-recipient-name"),
    ("subject_line", "template-subject-line"),
    ("salutation", "template-salutation"),
    ("closing", "template-closing"),
    ("sender_name", "template-sender-name"),
    ("letter_date", "template-letter-date"),
  ];

  for (json_key, typst_name) in STRING_KEYS {
    let value = template_var_string(vars, json_key);
    let _ = writeln!(out, "#let {typst_name} = \"{}\"", escape_str(&value));
  }

  let address_lines = template_var_string_array(vars, "recipient_address");
  if address_lines.is_empty() {
    let _ = writeln!(out, "#let template-recipient-address = ()");
  } else {
    let entries = address_lines
      .iter()
      .map(|line| format!("\"{}\"", escape_str(line)))
      .collect::<Vec<_>>();
    if entries.len() == 1 {
      let _ = writeln!(out, "#let template-recipient-address = ({},)", entries[0]);
    } else {
      let _ = writeln!(out, "#let template-recipient-address = ({})", entries.join(", "));
    }
  }
}

fn template_var_string(vars: &HashMap<String, serde_json::Value>, key: &str) -> String {
  match vars.get(key) {
    Some(serde_json::Value::String(value)) => value.trim().to_owned(),
    Some(serde_json::Value::Number(value)) => value.to_string(),
    Some(serde_json::Value::Bool(value)) => value.to_string(),
    _ => String::new(),
  }
}

fn template_var_string_array(vars: &HashMap<String, serde_json::Value>, key: &str) -> Vec<String> {
  match vars.get(key) {
    Some(serde_json::Value::Array(values)) => values
      .iter()
      .filter_map(|value| value.as_str())
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .map(str::to_owned)
      .collect(),
    Some(serde_json::Value::String(value)) => value
      .lines()
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .map(str::to_owned)
      .collect(),
    _ => Vec::new(),
  }
}

fn template_handles_toc(preamble: &str) -> bool {
  preamble.contains(TEMPLATE_HANDLES_TOC_MARKER)
}

fn template_defaults_cover_page(preamble: &str) -> bool {
  preamble.contains(TEMPLATE_DEFAULT_COVER_PAGE_MARKER)
}

fn template_handles_document_title(preamble: &str) -> bool {
  preamble.contains(TEMPLATE_HANDLES_DOCUMENT_TITLE_MARKER)
}

// ─── Block renderer ──────────────────────────────────────────────────────────

fn write_block(state: &mut RenderState, block: &Block, depth: usize) {
  if let Block::Heading {
    level: HeadingLevel::H1,
    content,
    children,
  } = block
  {
    let repeats_document_title = state
      .leading_document_title
      .as_deref()
      .is_some_and(|title| inline_plain_text(content).trim() == title);
    state.leading_document_title = None;
    if repeats_document_title {
      for child in children {
        write_block(state, child, depth + 1);
      }
      return;
    }
  } else {
    let transparent_before_title = match block {
      Block::Page { .. } | Block::Note { .. } | Block::EdgelessText { .. } => true,
      Block::Paragraph { content, .. } => content.is_empty(),
      _ => false,
    };
    if !transparent_before_title {
      state.leading_document_title = None;
    }
  }

  match block {
    Block::Page { children, .. } => {
      for child in children {
        write_block(state, child, depth);
      }
    }

    Block::LocalNoteDefinition {
      definition_id,
      placement,
      number,
      references,
      children,
    } => {
      let label = local_note_label(definition_id);
      let name = local_note_name(*placement, *number, &state.locale);
      let returns: String = (1..=*references)
        .map(|index| format!(" #link(<{label}-ref-{index}>)[↩]"))
        .collect();
      let _ = writeln!(
        state.out,
        "#block(sticky: true)[#text(weight: \"bold\")[{}]{returns}]<{label}>\n",
        escape_content(&name)
      );
      for child in children {
        write_block(state, child, depth);
      }
      let _ = writeln!(state.out);
    }

    Block::Note { children } | Block::EdgelessText { children, .. } => {
      for child in children {
        write_block(state, child, depth);
      }
    }

    Block::Paragraph { content, children } => {
      if content.is_empty() {
        let _ = writeln!(state.out);
      } else {
        let _ = writeln!(state.out, "{}", render_inline(content));
        let _ = writeln!(state.out);
      }
      for child in children {
        write_block(state, child, depth + 1);
      }
    }

    Block::Quote { content, children } => {
      let inner = render_inline(content);
      let _ = writeln!(
        state.out,
        "#block(inset: (left: 0.75em), stroke: (left: 2pt + blockquote-stroke))[{inner}]"
      );
      let _ = writeln!(state.out);
      for child in children {
        write_block(state, child, depth + 1);
      }
    }

    Block::Heading {
      level,
      content,
      children,
    } => {
      let prefix = "=".repeat(*level as usize);
      let text = render_inline_heading(content);
      let _ = writeln!(state.out, "{prefix} {text}");
      let _ = writeln!(state.out);
      for child in children {
        write_block(state, child, depth + 1);
      }
    }

    Block::List {
      list_type,
      content,
      checked,
      children,
    } => {
      write_list_item(state, *list_type, *checked, content, children, depth);
    }

    Block::Code(code) => {
      let lang = code.language.as_deref().unwrap_or("");
      let fenced_code = code.code.replace("```", "\\`\\`\\`");
      let _ = writeln!(state.out, "```{lang}");
      let _ = writeln!(state.out, "{fenced_code}");
      let _ = writeln!(state.out, "```");
      let _ = writeln!(state.out);
    }

    Block::Mermaid(diagram) => {
      write_mermaid_diagram(state, diagram);
    }

    Block::Divider => {
      let _ = writeln!(state.out, "#line(length: 100%)");
      let _ = writeln!(state.out);
    }

    Block::Callout {
      variant,
      emoji: _,
      content,
      children,
    } => {
      let (fill_token, stroke_token) = callout_tokens(*variant);
      // Callouts may carry arbitrary emoji/glyphicons. Typst's
      // PDF font set is intentionally bounded, so render a semantic ASCII
      // badge instead of leaking unsupported emoji into the PDF.
      let icon = callout_default_label(*variant, &state.locale);
      let inner = render_inline(content);
      // The border's decorative accent can be nearly white in grayscale.
      // Keep the semantic label readable with the document text foreground.
      let _ = writeln!(
        state.out,
        "#block(fill: rgb({fill_token}), stroke: (left: 3pt + rgb({stroke_token})), inset: 0.75em, radius: 4pt, width: 100%, breakable: true)[#text(font: symbol-font, weight: \"bold\")[{icon}] {inner}"
      );
      let _ = writeln!(state.out);
      for child in children {
        write_block(state, child, depth + 1);
      }
      // Children belong to the same semantic box, including nested callouts;
      // keeping it breakable lets long bodies continue onto the next page.
      let _ = writeln!(state.out, "]\n");
    }

    Block::LatexBlock { source } => {
      let _ = writeln!(state.out, "$ {source} $");
      let _ = writeln!(state.out);
    }

    Block::Image(img_ref) => {
      let blob_id = &img_ref.blob.blob_id;
      if blob_id.is_empty() {
        return;
      }
      let path = format!("{BLOB_PATH_PREFIX}{blob_id}");
      // The authored caption also owns the image alternative in every fitting path.
      let alt = img_ref
        .caption
        .as_ref()
        .map(|caption| inline_plain_text(caption))
        .filter(|caption| !caption.trim().is_empty())
        .unwrap_or_else(|| "Document image".into());
      let alt = escape_str(alt.trim());
      let width_spec = img_ref
        .width_hint
        .map(|w| format!(", width: {:.1}pt", w))
        .unwrap_or_default();
      if state.inside_footnote {
        // Page-fit helpers and floating figures use page geometry. Ordinary
        // footnote images instead stay inside their current column/entry.
        let _ = writeln!(
          state.out,
          "#layout(size => {{ let natural = measure(image(\"{path}\"{width_spec})); let factor = calc.min(1, size.width.pt() / natural.width.pt(), size.height.pt() / natural.height.pt()); image(\"{path}\", width: natural.width * factor, height: natural.height * factor, fit: \"contain\", alt: \"{alt}\") }})"
        );
        if let Some(caption) = &img_ref.caption {
          let _ = writeln!(state.out, "#myoxus-caption([{}])", render_inline_plain(caption));
        }
      } else if state.template_handles_diagram_fit {
        let requested_width = img_ref
          .width_hint
          .map(|width| format!(", requested-width: {width:.1}pt"))
          .unwrap_or_default();
        let caption = img_ref
          .caption
          .as_ref()
          .map(|cap| format!(", caption: [#myoxus-caption([{}])]", render_inline_plain(cap)))
          .unwrap_or_default();
        let _ = writeln!(
          state.out,
          "#myoxus-fit-visual(\"{path}\"{requested_width}{caption}, alt: \"{alt}\")"
        );
      } else if let Some(cap) = &img_ref.caption {
        let cap_text = render_inline_plain(cap);
        let _ = writeln!(
          state.out,
          "#figure(image(\"{path}\"{width_spec}, alt: \"{alt}\"), caption: [#myoxus-caption([{cap_text}])])"
        );
      } else {
        let _ = writeln!(state.out, "#image(\"{path}\"{width_spec}, alt: \"{alt}\")");
      }
      let _ = writeln!(state.out);
    }

    Block::Attachment {
      name, size_bytes, mime, ..
    } => {
      let name = name.as_deref().unwrap_or("Attachment");
      let size = size_bytes.map(|s| format!(" ({})", human_size(s))).unwrap_or_default();
      let mime = mime.as_deref().unwrap_or("");
      let _ = writeln!(
        state.out,
        "#block(stroke: 1pt + attachment-stroke, inset: 6pt, radius: 4pt)[*Attachment:* *{}*{} `{}`]",
        escape_content(name),
        size,
        escape_content(mime)
      );
      let _ = writeln!(state.out);
    }

    Block::Bookmark(card) | Block::Embed(card) => {
      write_embed_card(&mut state.out, card);
    }

    Block::Table {
      rows,
      caption,
      column_widths,
      header_rows,
      appearance,
      density,
    } => {
      write_table(
        &mut state.out,
        rows,
        caption.as_deref(),
        *header_rows,
        *appearance,
        *density,
        column_widths.as_deref(),
      );
    }

    Block::Database(db) => {
      // Render database as a simple table using column names as headers.
      let header_cells: Vec<TableCell> = db
        .columns
        .iter()
        .map(|col| TableCell {
          content: vec![InlineSpan::Text {
            text: col.name.clone(),
            marks: TextMarks {
              bold: Some(true),
              ..Default::default()
            },
          }],
          is_header: true,
          col_span: 1,
          row_span: 1,
          align: None,
          fill: None,
          foreground: None,
        })
        .collect();
      let header_row = TableRow { cells: header_cells };

      let data_rows: Vec<TableRow> = db
        .rows
        .iter()
        .map(|row_cells| TableRow {
          cells: row_cells
            .iter()
            .map(|rt| TableCell {
              content: rt.clone(),
              is_header: false,
              col_span: 1,
              row_span: 1,
              align: None,
              fill: None,
              foreground: None,
            })
            .collect(),
        })
        .collect();

      let mut all_rows = vec![header_row];
      all_rows.extend(data_rows);
      write_table(&mut state.out, &all_rows, None, Some(1), None, None, None);
    }

    Block::Surface(snap) | Block::SurfaceRef(snap) | Block::Frame(snap) | Block::Mindmap(snap) => {
      write_edgeless_snapshot(state, snap);
    }

    Block::AiChat { messages } => {
      let _ = writeln!(
        state.out,
        "#block(fill: aichat-fill, inset: 8pt, radius: 4pt, width: 100%)["
      );
      let _ = writeln!(state.out, "  *AI Chat Transcript*");
      let _ = writeln!(state.out);
      for msg in messages {
        let label = if msg.role == "assistant" { "AI" } else { "User" };
        let content = render_inline(&msg.content);
        let _ = writeln!(state.out, "  *{label}:* {content}");
        let _ = writeln!(state.out);
      }
      let _ = writeln!(state.out, "]");
      let _ = writeln!(state.out);
    }

    Block::Unknown { flavour, text_fallback } => {
      if let Some(content) = text_fallback {
        if !content.is_empty() {
          let text = render_inline_plain(content);
          let _ = writeln!(
            state.out,
            "#text(fill: unknown-block-fill)[_{}_]",
            escape_content(&text)
          );
          let _ = writeln!(state.out);
        }
      } else {
        let _ = writeln!(
          state.out,
          "#text(fill: unknown-block-fill)[_[{}: unsupported block]_]",
          escape_content(flavour)
        );
        let _ = writeln!(state.out);
      }
    }
  }
}

fn write_list_item(
  state: &mut RenderState,
  list_type: ListType,
  checked: bool,
  content: &[InlineSpan],
  children: &[Block],
  depth: usize,
) {
  let indent = "  ".repeat(depth);
  let text = render_inline(content);
  match list_type {
    ListType::Bulleted => {
      let _ = writeln!(state.out, "{indent}- {text}");
    }
    ListType::Numbered => {
      let _ = writeln!(state.out, "{indent}+ {text}");
    }
    ListType::Todo => {
      let mark = if checked { "true" } else { "false" };
      let _ = writeln!(state.out, "{indent}- #pdf-check({mark}) {text}");
    }
    ListType::Toggle => {
      // Toggle: render as a disclosure block in Typst (details not native, use block).
      let _ = writeln!(state.out, "{indent}- {text}");
    }
  }
  for child in children {
    write_block(state, child, depth + 1);
  }
}

fn write_table(
  out: &mut String,
  rows: &[TableRow],
  caption: Option<&[InlineSpan]>,
  header_rows: Option<usize>,
  appearance: Option<TableAppearance>,
  density: Option<TableDensity>,
  column_widths: Option<&[f64]>,
) {
  if rows.is_empty() {
    return;
  }
  let col_count = rows.iter().map(|r| r.cells.len()).max().unwrap_or(1);

  // Rule and inset geometry belong to the PDF renderer. Source only selects a
  // semantic appearance/density; theme-owned `rule-color` remains authoritative.
  let stroke = match appearance.unwrap_or(TableAppearance::Grid) {
    TableAppearance::Grid => "0.35pt + rgb(rule-color)",
    TableAppearance::Ruled => "(x: none, y: 0.35pt + rgb(rule-color))",
    TableAppearance::Plain => "none",
  };
  let inset = match density.unwrap_or(TableDensity::Normal) {
    TableDensity::Normal => "(x: 0.7em, y: 0.45em)",
    TableDensity::Compact => "(x: 0.45em, y: 0.27em)",
  };
  // Native pixels express the authored proportions; fractional tracks fit the page body.
  let columns = column_widths
    .filter(|widths| widths.len() == col_count && widths.iter().all(|w| w.is_finite() && *w > 0.0))
    .map(|widths| {
      let largest = widths.iter().copied().fold(0.0, f64::max);
      let tracks = widths
        .iter()
        .map(|width| format!("{}fr", width / largest))
        .collect::<Vec<_>>()
        .join(", ");
      format!("({tracks},)")
    })
    .unwrap_or_else(|| col_count.to_string());
  // Template paragraph justification must not stretch native table labels.
  // Scope the rule to this object so surrounding document prose is unchanged.
  let _ = write!(
    out,
    "#block[\n#set par(justify: false)\n#table(columns: {columns}, stroke: {stroke}, inset: {inset}, "
  );

  // Missing legacy metadata retains the historical first-row treatment.
  let header_rows = header_rows.unwrap_or(1).min(rows.len());
  let _ = writeln!(
    out,
    "fill: (col, row) => if row < {header_rows} {{ table-header-fill }} else {{ none }},"
  );

  if header_rows > 0 {
    let _ = writeln!(out, "  table.header(");
    for row in &rows[..header_rows] {
      write_table_row_cells(out, row, col_count);
    }
    let _ = writeln!(out, "  ),");
  }

  for row in &rows[header_rows..] {
    write_table_row_cells(out, row, col_count);
  }
  let _ = writeln!(out, ")\n]");

  if let Some(cap) = caption {
    let cap_text = render_inline_plain(cap);
    let _ = writeln!(
      out,
      "#v(body-caption-spacing)#align(center, text(size: secondary-body-size, fill: table-caption-fill)[{cap_text}])"
    );
  }
  let _ = writeln!(out);
}

fn write_table_row_cells(out: &mut String, row: &TableRow, col_count: usize) {
  for cell in &row.cells {
    let align = match cell.align.as_deref() {
      Some("center") => Some("center"),
      Some("right") => Some("right"),
      _ => None,
    };
    let mut content = render_inline(&cell.content);
    if let Some(foreground) = &cell.foreground {
      content = format!(
        "#text(fill: native-table-color(\"{}\"))[{content}]",
        escape_str(foreground)
      );
    }
    if align.is_some() || cell.fill.is_some() {
      let _ = write!(out, "  table.cell(");
      if let Some(align) = align {
        let _ = write!(out, "align: {align}");
      }
      if let Some(fill) = &cell.fill {
        if align.is_some() {
          let _ = write!(out, ", ");
        }
        let _ = write!(out, "fill: native-table-color(\"{}\")", escape_str(fill));
      }
      let _ = write!(out, ")[{content}], ");
    } else {
      let _ = write!(out, "  [{content}], ");
    }
  }
  // Pad missing cells.
  for _ in row.cells.len()..col_count {
    let _ = write!(out, "  [], ");
  }
  let _ = writeln!(out);
}

fn write_mermaid_diagram(state: &mut RenderState, diagram: &MermaidDiagram) {
  let title = diagram
    .title
    .as_deref()
    .map(render_inline_plain)
    .filter(|text| !text.is_empty());
  let caption = diagram
    .caption
    .as_deref()
    .map(render_inline_plain)
    .filter(|text| !text.is_empty());
  let figure_caption = match (title.as_deref(), caption.as_deref()) {
    (Some(title), Some(caption)) => Some(format!("{title}: {caption}")),
    (Some(title), None) => Some(title.to_string()),
    (None, Some(caption)) => Some(caption.to_string()),
    (None, None) => None,
  };

  let key = mermaid_svg_asset_key(&diagram.source);
  let diagram_id = key.trim_end_matches(".svg");
  match MermanSvgRenderer.render_svg(&diagram.source, diagram_id) {
    Ok(svg) => {
      state.inline_assets.insert(key.clone(), svg.into_bytes());
      let path = format!("{BLOB_PATH_PREFIX}{key}");
      let alt = figure_caption.as_deref().unwrap_or("Mermaid diagram");
      if state.template_handles_diagram_fit {
        let caption = figure_caption
          .as_ref()
          .map(|caption| format!(", caption: [#myoxus-caption([{}])]", escape_content(caption)))
          .unwrap_or_default();
        let _ = writeln!(
          state.out,
          "#myoxus-fit-visual(\"{path}\"{caption}, alt: \"{}\")",
          escape_str(alt)
        );
      } else if let Some(caption) = figure_caption.as_ref() {
        let image = format!("image(\"{path}\", alt: \"{}\")", escape_str(alt));
        let _ = writeln!(
          state.out,
          "#figure(align(center, {image}), caption: [#myoxus-caption([{}])])",
          escape_content(&caption)
        );
      } else {
        let image = format!("image(\"{path}\", alt: \"{}\")", escape_str(alt));
        let _ = writeln!(state.out, "#align(center, {image})");
      }
    }
    Err(error) => {
      let label = title.as_deref().unwrap_or("Mermaid diagram");
      let _ = writeln!(
        state.out,
        "#block(stroke: 1pt + attachment-stroke, inset: 8pt, radius: 4pt, width: 100%)[*{}*\\ Mermaid diagram could not be rendered: {}]",
        escape_content(label),
        escape_content(&error.to_string())
      );
    }
  }
  let _ = writeln!(state.out);
}

fn write_embed_card(out: &mut String, card: &EmbedCard) {
  let title = card.title.as_deref().unwrap_or(card.url.as_str());
  let desc = card.description.as_deref().unwrap_or("");
  // A citation may use its URL as its visible title. Keep // and other
  // markup tokens inside string literals without changing link identity.
  let _ = writeln!(
    out,
    "#block(stroke: 1pt + embed-card-stroke, inset: 8pt, radius: 4pt, width: 100%)[#link(\"{}\")[*#myoxus-body-string(\"{}\")*]{}#myoxus-body-string(\"{}\")]",
    escape_str(&card.url),
    escape_str(title),
    if !desc.is_empty() { "\\ " } else { "" },
    escape_str(desc)
  );
  let _ = writeln!(out);
}

fn write_edgeless_snapshot(state: &mut RenderState, snap: &EdgelessSnapshot) {
  if snap.png_bytes.is_empty() {
    // No snapshot data — print a placeholder.
    let _ = writeln!(
      state.out,
      "#block(fill: snapshot-placeholder-fill, inset: 12pt, radius: 4pt, width: 100%)[_[Canvas snapshot not available]_]"
    );
  } else {
    // Allocate a unique synthetic blob key for this snapshot, register the
    // raw PNG bytes against it in `inline_assets`, and reference it via the
    // shared `blob:<id>` virtual path. The engine merges `inline_assets`
    // into the asset map before constructing `TypstWorld`, so the source
    // line below resolves to the bytes via the same file resolver that
    // serves `Block::Image` blobs (#322).
    let key = state.next_edgeless_snapshot_key();
    state.inline_assets.insert(key.clone(), snap.png_bytes.clone());
    let path = format!("{BLOB_PATH_PREFIX}{key}");
    if state.template_handles_diagram_fit {
      let caption = snap
        .caption
        .as_ref()
        .map(|caption| format!(", caption: [#myoxus-caption([{}])]", render_inline_plain(caption)))
        .unwrap_or_default();
      let _ = writeln!(
        state.out,
        "#myoxus-fit-visual(\"{path}\"{caption}, alt: \"Edgeless canvas snapshot\")"
      );
    } else {
      let _ = writeln!(state.out, "#image(\"{path}\", width: 100%)");
    }
  }
  let _ = writeln!(state.out);
}

// ─── Inline renderer ─────────────────────────────────────────────────────────

/// Render inline spans as Typst markup (with formatting).
pub fn render_inline(spans: &[InlineSpan]) -> String {
  spans.iter().map(render_span).collect()
}

/// Render inline spans as plain text (for headings, captions).
pub fn render_inline_plain(spans: &[InlineSpan]) -> String {
  spans
    .iter()
    .map(|s| match s {
      InlineSpan::Text { text, .. } => escape_content(text),
      InlineSpan::Latex { source } => format!("${source}$"),
      InlineSpan::Reference { title, .. } => title.as_deref().unwrap_or("ref").to_string(),
      InlineSpan::Mention { display_name, .. } => {
        format!("@{}", display_name.as_deref().unwrap_or("user"))
      }
      InlineSpan::Footnote { content } => render_inline_plain(content),
      InlineSpan::LocalFootnote { .. } => render_span(s),
    })
    .collect()
}

fn render_inline_heading(spans: &[InlineSpan]) -> String {
  spans
    .iter()
    .map(|span| match span {
      InlineSpan::Text { text, .. } => format!("#myoxus-heading-string(\"{}\")", escape_str(text)),
      InlineSpan::Latex { source } => format!("${source}$"),
      InlineSpan::Reference { title, doc_id } => {
        format!(
          "#myoxus-heading-string(\"{}\")",
          escape_str(title.as_deref().unwrap_or(doc_id))
        )
      }
      InlineSpan::Mention { display_name, user_id } => format!(
        "#myoxus-heading-string(\"@{}\")",
        escape_str(display_name.as_deref().unwrap_or(user_id))
      ),
      InlineSpan::Footnote { content } => render_inline_heading(content),
      InlineSpan::LocalFootnote { .. } => render_span(span),
    })
    .collect()
}

fn render_span(span: &InlineSpan) -> String {
  match span {
    InlineSpan::Text { text, marks } => render_text_with_marks(text, marks),
    InlineSpan::Latex { source } => format!("${source}$"),
    InlineSpan::Reference { doc_id, title } => {
      let label = title.as_deref().unwrap_or(doc_id.as_str());
      format!("#link(\"{doc_id}\")[#myoxus-body-string(\"{}\")]", escape_str(label))
    }
    InlineSpan::Mention { display_name, user_id } => {
      let name = display_name.as_deref().unwrap_or(user_id.as_str());
      format!("*#myoxus-body-string(\"@{}\")*", escape_str(name))
    }
    InlineSpan::Footnote { content } => {
      let inner = render_inline(content);
      format!("#footnote[{inner}]")
    }
    InlineSpan::LocalFootnote {
      definition_id,
      placement,
      number,
      reference_index,
      references,
      locale,
      body,
    } => {
      let label = local_note_label(definition_id);
      let origin = format!("{label}-ref-{reference_index}");
      if *placement == yjs::footnote::FootnotePlacement::Endnote {
        return format!(
          "#super(link(<{label}>)[{}])#metadata(none)<{origin}>",
          number.map_or_else(|| "?".into(), |n| n.to_string())
        );
      }
      if let Some(blocks) = body {
        let mut state = RenderState {
          inside_footnote: true,
          locale: locale.clone(),
          ..Default::default()
        };
        for block in blocks {
          write_block(&mut state, block, 0);
        }
        let returns: String = (1..=*references)
          .map(|index| format!("#link(<{label}-ref-{index}>)[↩] "))
          .collect();
        format!("#footnote[{}\n{returns}]<{label}>#metadata(none)<{origin}>", state.out)
      } else {
        format!("#footnote(<{label}>)#metadata(none)<{origin}>")
      }
    }
  }
}

/// Native IDs are opaque; hex encoding gives collision-free safe Typst labels.
fn local_note_label(id: &str) -> String {
  let encoded: String = id.bytes().map(|byte| format!("{byte:02x}")).collect();
  format!("myoxus-note-{encoded}")
}

fn local_note_name(placement: yjs::footnote::FootnotePlacement, number: Option<u32>, locale: &str) -> String {
  let (foot, end, unused) = match locale.split(['-', '_']).next().unwrap_or("en") {
    "de" => ("Fußnote", "Endnote", "ohne Referenz"),
    "fr" => ("Note de bas de page", "Note de fin", "sans référence"),
    "es" => ("Nota al pie", "Nota final", "sin referencia"),
    _ => ("Footnote", "Endnote", "no reference"),
  };
  let kind = if placement == yjs::footnote::FootnotePlacement::Endnote {
    end
  } else {
    foot
  };
  number.map_or_else(|| format!("{kind} — {unused}"), |n| format!("{kind} {n}"))
}

fn render_text_with_marks(text: &str, marks: &TextMarks) -> String {
  let mut s = if marks.code == Some(true) {
    format!("#raw(\"{}\", block: false)", escape_str(text))
  } else {
    format!("#myoxus-body-string(\"{}\")", escape_str(text))
  };

  // Apply marks from innermost to outermost so nesting is correct.
  if let Some(color) = &marks.color {
    s = format!("#text(fill: rgb(\"{color}\"))[{s}]");
  }
  if let Some(bg) = &marks.background {
    s = format!("#highlight(fill: rgb(\"{bg}\"))[{s}]");
  }
  if marks.strike == Some(true) {
    s = format!("#strike[{s}]");
  }
  if marks.underline == Some(true) {
    s = format!("#underline[{s}]");
  }
  if marks.italic == Some(true) {
    s = format!("_{s}_");
  }
  if marks.bold == Some(true) {
    s = format!("*{s}*");
  }
  if let Some(href) = &marks.link {
    s = format!("#link(\"{}\")[{s}]", escape_str(href));
  }
  s
}

// ─── Escape helpers ──────────────────────────────────────────────────────────

/// Escape a string for use inside a Typst string literal (`"..."` context).
fn escape_str(s: &str) -> String {
  s.replace('\\', "\\\\")
    .replace('"', "\\\"")
    .replace('\n', "\\n")
    .replace('\r', "\\r")
}

/// Escape text for use in Typst content/markup mode.
/// Typst special characters: `*`, `_`, `#`, `@`, `$`, `` ` ``, `~`, `<`, `>`, `\`, `[`, `]`.
fn escape_content(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  for ch in s.chars() {
    match ch {
      '\\' => out.push_str("\\\\"),
      '*' => out.push_str("\\*"),
      '_' => out.push_str("\\_"),
      '#' => out.push_str("\\#"),
      '@' => out.push_str("\\@"),
      '$' => out.push_str("\\$"),
      '`' => out.push_str("\\`"),
      '~' => out.push_str("\\~"),
      '<' => out.push_str("\\<"),
      '[' => out.push_str("\\["),
      ']' => out.push_str("\\]"),
      c => out.push(c),
    }
  }
  out
}

// ─── Callout colors ──────────────────────────────────────────────────────────

/// Map a callout variant to the (fill, stroke) **Typst-side** identifiers
/// defined in `templates/default/theme.typ`. Emitting identifiers (rather
/// than inlining hex literals) makes the theme file the single source of
/// truth for callout colors.
fn callout_tokens(variant: CalloutVariant) -> (&'static str, &'static str) {
  match variant {
    CalloutVariant::Info => ("callout-info-fill", "callout-info-stroke"),
    CalloutVariant::Warning => ("callout-warn-fill", "callout-warn-stroke"),
    CalloutVariant::Note => ("callout-note-fill", "callout-note-stroke"),
    CalloutVariant::Tip => ("callout-tip-fill", "callout-tip-stroke"),
  }
}

fn callout_default_label(variant: CalloutVariant, locale: &str) -> &'static str {
  match variant {
    CalloutVariant::Info => "Info",
    CalloutVariant::Warning => "Warn",
    CalloutVariant::Note => match locale.split('-').next().unwrap_or("en") {
      "de" => "Hinweis",
      "es" => "Nota",
      _ => "Note",
    },
    CalloutVariant::Tip => "Tip",
  }
}

#[cfg(test)]
mod callout_tests {
  use super::*;

  #[test]
  fn note_badge_uses_export_locale_without_hiding_its_body() {
    for (locale, label) in [("en", "Note"), ("de-DE", "Hinweis"), ("fr", "Note"), ("es", "Nota")] {
      let mut state = RenderState {
        locale: locale.into(),
        ..Default::default()
      };
      let block = Block::Callout {
        variant: CalloutVariant::Note,
        emoji: None,
        content: vec![InlineSpan::Text {
          text: "Visible note body".into(),
          marks: Default::default(),
        }],
        children: Vec::new(),
      };
      write_block(&mut state, &block, 0);
      assert!(state.out.contains(&format!("[{label}]")), "{locale}");
      assert!(
        state
          .out
          .contains(&format!("#text(font: symbol-font, weight: \"bold\")[{label}]"))
      );
      assert!(state.out.contains("Visible note body"));
    }
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

fn human_size(bytes: u64) -> String {
  const KB: u64 = 1024;
  const MB: u64 = KB * 1024;
  const GB: u64 = MB * 1024;
  if bytes >= GB {
    format!("{:.1} GB", bytes as f64 / GB as f64)
  } else if bytes >= MB {
    format!("{:.1} MB", bytes as f64 / MB as f64)
  } else if bytes >= KB {
    format!("{:.0} KB", bytes as f64 / KB as f64)
  } else {
    format!("{bytes} B")
  }
}
