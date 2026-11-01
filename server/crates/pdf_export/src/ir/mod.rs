// SPDX-License-Identifier: AGPL-3.0-or-later
//! Intermediate Representation (IR) for PDF export.
//!
//! The IR is a versioned, serialisable document tree that decouples
//! the Yjs→IR builder from the Typst renderer. Version bumps are
//! handled via the [`migration`] module.

pub mod block;
pub mod inline;
pub mod migration;

pub use block::*;
pub use inline::*;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Current schema version. Increment when making breaking IR changes.
pub const CURRENT_IR_VERSION: u32 = 1;

/// Top-level export document. Carries metadata, the block tree, and options.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IrDocument {
  /// Schema version — checked by the renderer and migrated if needed.
  pub version: u32,
  pub metadata: DocumentMetadata,
  pub options: ExportOptions,
  /// Root block (typically `Block::Page`).
  pub root: Block,
  /// Flat list of resolved binary assets referenced from the block tree.
  /// Keyed by `BlobRef.blob_id`.
  pub assets: std::collections::HashMap<String, AssetData>,
}

/// Document metadata written to PDF metadata fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentMetadata {
  pub doc_id: Uuid,
  pub workspace_id: Uuid,
  pub title: Option<String>,
  pub author: Option<String>,
  pub created_at: Option<DateTime<Utc>>,
  pub updated_at: Option<DateTime<Utc>>,
  /// Human-readable organisation/workspace label used by templates when they
  /// need a short header/footer identity.
  pub workspace_name: Option<String>,
  /// Effective document branding resolved by the API before dispatch.
  pub branding: Branding,
}

/// Document-visible brand data forwarded to Typst templates.
///
/// This is deliberately not app/server branding: it contains only information
/// allowed to appear inside exported documents. All colors are CSS hex strings
/// (for example `"#1971c2"`). Logo blobs are private object-store keys; the
/// worker materializes them into virtual `blob:*` paths before rendering.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Branding {
  pub organization_name: Option<String>,
  pub footer_text: Option<String>,
  pub legal_text: Option<String>,
  pub logo_large_blob: Option<String>,
  pub logo_large_sha256: Option<String>,
  pub logo_small_blob: Option<String>,
  pub logo_small_sha256: Option<String>,
  pub logo_large_path: Option<String>,
  pub logo_small_path: Option<String>,
  pub color_policy: Option<String>,
  pub color_palette_key: Option<String>,
  pub primary: Option<String>,
  pub accent: Option<String>,
  pub rule: Option<String>,
  pub text_primary: Option<String>,
  pub background: Option<String>,
  /// Dedicated code surface from the effective server-owned theme. It remains
  /// separate from the document/page background so templates do not derive a
  /// second, renderer-local code color.
  pub code_background: Option<String>,
}

/// Effective global-theme font roles materialised for Typst.
///
/// The web/admin runtime uses WOFF2 for browser delivery, while Typst needs
/// SFNT fonts (TTF/OTF/VF). This structure is the renderer-facing projection
/// of `typography_styles.pdf_role` from the effective server-owned branding
/// profile onto the bundled server font palette. It is intentionally role-based
/// instead of template-specific: templates consume `heading/body/mono/symbol`,
/// not a UI- or PDF-specific theme namespace.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThemeFontSelection {
  #[serde(default)]
  pub heading: Option<String>,
  #[serde(default)]
  pub body: Option<String>,
  #[serde(default)]
  pub mono: Option<String>,
  #[serde(default)]
  pub symbol: Option<String>,
}

/// Printable typography metrics for one effective theme role.
///
/// Font families and their pinned assets remain in [`ThemeFontSelection`];
/// this value carries the remaining server-owned typography contract into
/// Typst. CSS pixel sizes are converted to points only when source bindings are
/// generated (`1px = 0.75pt`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ThemeTypographyStyle {
  pub font_weight: u16,
  pub font_style: String,
  pub size_px: f64,
  pub line_height: f64,
  pub letter_spacing_em: f64,
  /// Display-only case mapping. Missing persisted fields retain neutral styling.
  #[serde(default = "neutral_text_style")]
  pub text_transform: String,
  /// Display-only decorative line. Missing persisted fields retain neutral styling.
  #[serde(default = "neutral_text_style")]
  pub decoration: String,
}

fn neutral_text_style() -> String {
  "none".into()
}

/// Effective `pdf_role` typography styles from the selected server theme.
///
/// Optional roles are a bounded compatibility path for already queued export
/// jobs created before this projection existed. New API dispatches populate all
/// four roles and fail with a configuration error when a theme role is missing
/// or incomplete.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ThemeTypographySelection {
  #[serde(default)]
  pub heading: Option<ThemeTypographyStyle>,
  #[serde(default)]
  pub body: Option<ThemeTypographyStyle>,
  #[serde(default)]
  pub mono: Option<ThemeTypographyStyle>,
  #[serde(default)]
  pub symbol: Option<ThemeTypographyStyle>,
}

/// Calibrates the common 30 px PDF heading role to 21.375 pt before the
/// template applies its semantic heading-level multipliers.
pub const DEFAULT_HEADING_FONT_SCALE: f64 = 0.95;

/// Calibrates the common 14 px PDF body role to 11.025 pt after the standard
/// CSS absolute-length conversion (1 px = 0.75 pt).
pub const DEFAULT_BODY_FONT_SCALE: f64 = 1.05;

/// Concrete native-cell paint captured from the server theme at dispatch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeTablePaint {
  pub fill: String,
  pub foreground: String,
}

/// Keys are admitted native CSS references; values are validated #RRGGBB paint.
pub type NativeTablePalette = std::collections::BTreeMap<String, NativeTablePaint>;

/// Options that control rendering behaviour.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportOptions {
  /// Template ID to use. "default" is the built-in theme-aware template.
  pub template_id: String,
  /// BCP-47 locale tag for hyphenation and locale-sensitive formatting.
  /// Defaults to "en".
  pub locale: String,
  /// Paper size: "A4" | "Letter" | "A3" | "A5" | "16:9".
  pub paper_size: String,
  /// Page orientation: "portrait" | "landscape".
  #[serde(default = "default_orientation")]
  pub orientation: String,
  /// Global scale applied to heading typography after px→pt conversion.
  #[serde(default = "default_heading_font_scale")]
  pub heading_font_scale: f64,
  /// Global scale applied to body, mono and symbol typography.
  #[serde(default = "default_body_font_scale")]
  pub body_font_scale: f64,
  /// Table-of-contents behavior: "off" | "auto" | "force".
  pub toc_behavior: String,
  #[serde(default)]
  /// Footer layout from the selected template capability; absence keeps its default.
  pub footer_style: Option<String>,
  #[serde(default)]
  /// Page-number format independent of the selected footer layout.
  pub page_numbering: Option<String>,
  #[serde(default)]
  /// Color treatment applied to the effective document palette.
  pub color_variant: Option<String>,
  /// Optional cover-page override from the selected V2 template capability.
  ///
  /// `None` means "use the template's default". The GraphQL/API layer records
  /// the raw L3 render input, while this renderer-facing field exists so Typst
  /// templates do not have to parse arbitrary JSON to make layout decisions.
  #[serde(default)]
  pub cover_page: Option<bool>,
  /// Optional confidentiality label selected through the V2 template
  /// capability. Empty/`None` means no visible classification marker.
  #[serde(default)]
  pub confidentiality_label: Option<String>,
  /// Effective global-theme font roles. The API resolver fills this from the
  /// effective branding profile's `typography_styles.pdf_role` entries after
  /// mapping browser font names to bundled TTF/OTF/VF family names. Unknown or
  /// unbundled names are rejected before reaching the renderer on the GraphQL
  /// path; render-time diagnostics still report any direct crate caller role
  /// that does not resolve in the active FontBook.
  #[serde(default)]
  pub theme_fonts: ThemeFontSelection,
  /// Effective non-family typography metrics for the same theme roles.
  #[serde(default)]
  pub theme_typography: ThemeTypographySelection,
  /// Dispatch-time content paint, separate from document branding. Absence
  /// preserves rendering for jobs queued before native table paint was captured.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub native_table_palette: Option<NativeTablePalette>,
  /// Effective ICC color-profile family (`sRGB`, `CMYK_FOGRA39`,
  /// `CMYK_SWOP`). The renderer receives the resolved value from
  /// `pdf_export_settings`; it does not invent another fallback chain.
  #[serde(default)]
  pub color_profile: Option<String>,
  /// Effective image-quality tier (`low`, `med`, `high`, `lossless`) after
  /// applying PDF export settings and per-render overrides.
  #[serde(default)]
  pub image_quality: Option<String>,
  /// Whether text ligatures are enabled for Typst text shaping.
  #[serde(default = "default_ligatures_enabled")]
  pub ligatures_enabled: bool,
  /// Optional standards profile for the final PDF writer.
  ///
  /// `None`/`standard` keeps the normal PDF 1.7 path. Compliance values are
  /// validated by the API before dispatch and mapped to `typst-pdf` native
  /// `PdfStandards` in the renderer; the field is persisted in render inputs
  /// so audit/idempotency can distinguish normal and standards-constrained
  /// exports.
  #[serde(default)]
  pub compliance_profile: Option<String>,
  /// Human-readable document-version label resolved by the export API.
  ///
  /// `None` means "current document state". When set, templates can display
  /// it through the generated `doc-version` Typst binding.
  #[serde(default)]
  pub doc_version_label: Option<String>,
  /// Optional keyword list written into the PDF's `/Keywords` metadata
  /// field via Typst's `#set document(keywords: …)`. Empty vector means
  /// no keywords entry is written.
  #[serde(default)]
  pub keywords: Vec<String>,
  /// Additional per-template variables (template-defined keys).
  #[serde(default)]
  pub template_vars: std::collections::HashMap<String, serde_json::Value>,
}

fn default_ligatures_enabled() -> bool {
  true
}

fn default_orientation() -> String {
  "portrait".into()
}

fn default_heading_font_scale() -> f64 {
  DEFAULT_HEADING_FONT_SCALE
}

fn default_body_font_scale() -> f64 {
  DEFAULT_BODY_FONT_SCALE
}

impl Default for ExportOptions {
  fn default() -> Self {
    Self {
      template_id: "default".into(),
      locale: "en".into(),
      paper_size: "A4".into(),
      orientation: default_orientation(),
      heading_font_scale: default_heading_font_scale(),
      body_font_scale: default_body_font_scale(),
      toc_behavior: "off".into(),
      footer_style: None,
      page_numbering: None,
      color_variant: None,
      cover_page: None,
      confidentiality_label: None,
      theme_fonts: ThemeFontSelection::default(),
      theme_typography: ThemeTypographySelection::default(),
      native_table_palette: None,
      color_profile: None,
      image_quality: None,
      ligatures_enabled: default_ligatures_enabled(),
      compliance_profile: None,
      doc_version_label: None,
      keywords: Vec::new(),
      template_vars: Default::default(),
    }
  }
}
