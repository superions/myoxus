// SPDX-License-Identifier: AGPL-3.0-or-later
//! Typst-based PDF rendering engine.
//!
//! Converts an [`IrDocument`] to PDF bytes via:
//! 1. [`ir_to_typst::ir_to_typst_source_v2`] — IR tree + V2 template bundle → Typst `.typ` source string.
//! 2. [`TypstWorld`]         — Virtual World (fonts, virtual FS, main source).
//! 3. `typst::compile`       — Typst source → internal document model.
//! 4. `typst_pdf::pdf`       — Document model → PDF bytes.
//!
//! The renderer always operates on a V2 template bundle
//! (`HashMap<String, Vec<u8>>`) — the V1 hardcoded `Template::lookup`
//! path was removed in `P-PDF-TPL-06-04-CUTOVER` (2026-04-30).

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tracing::{debug, instrument, warn};
use typst::foundations::{Bytes, Smart};
use typst_layout::PagedDocument;
use typst_pdf::{PdfStandard, PdfStandards};

use crate::error::RenderError;
use crate::ir::{IrDocument, block::AssetData, block::EdgelessSnapshotLimits};

pub mod ir_to_typst;
pub mod world;

use world::TypstWorld;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RenderComplianceProfile {
  Standard,
  Pdfa1b,
  Pdfa2b,
  Pdfa2u,
  Pdfa3b,
  Pdfua1,
}

impl RenderComplianceProfile {
  fn parse(raw: Option<&str>) -> Result<Self, RenderError> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
      // Old captures and compile previews retain standard. New export defaults
      // are resolved before capture by the Application admission owner.
      return Ok(Self::Standard);
    };
    match raw {
      "standard" => Ok(Self::Standard),
      "pdfa-1b" => Ok(Self::Pdfa1b),
      "pdfa-2b" => Ok(Self::Pdfa2b),
      "pdfa-2u" => Ok(Self::Pdfa2u),
      "pdfa-3b" => Ok(Self::Pdfa3b),
      "pdfua-1" => Ok(Self::Pdfua1),
      other => Err(RenderError::UnsupportedComplianceProfile {
        profile: other.to_string(),
      }),
    }
  }

  fn standards(self) -> Result<PdfStandards, RenderError> {
    let standards = match self {
      Self::Standard => &[PdfStandard::V_1_7][..],
      Self::Pdfa1b => &[PdfStandard::A_1b][..],
      Self::Pdfa2b => &[PdfStandard::A_2b][..],
      Self::Pdfa2u => &[PdfStandard::A_2u][..],
      Self::Pdfa3b => &[PdfStandard::A_3b][..],
      Self::Pdfua1 => &[PdfStandard::Ua_1][..],
    };
    PdfStandards::new(standards).map_err(|e| RenderError::Compilation(e.message().to_string()))
  }

  fn map_pdf_error(self, detail: String) -> RenderError {
    match self {
      Self::Pdfa1b | Self::Pdfa2b | Self::Pdfa2u | Self::Pdfa3b => RenderError::PdfaValidationFailed(detail),
      Self::Pdfua1 => RenderError::PdfuaValidationFailed(detail),
      Self::Standard => RenderError::Compilation(detail),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::RenderComplianceProfile;
  use crate::error::RenderError;

  #[test]
  fn compliance_profile_parse_defaults_to_standard() {
    assert_eq!(
      RenderComplianceProfile::parse(None).expect("missing profile should default to standard"),
      RenderComplianceProfile::Standard
    );
    assert_eq!(
      RenderComplianceProfile::parse(Some("   ")).expect("blank profile should default to standard"),
      RenderComplianceProfile::Standard
    );
  }

  #[test]
  fn compliance_profile_parse_accepts_native_typst_standards() {
    for (raw, expected) in [
      ("standard", RenderComplianceProfile::Standard),
      ("pdfa-1b", RenderComplianceProfile::Pdfa1b),
      ("pdfa-2b", RenderComplianceProfile::Pdfa2b),
      ("pdfa-2u", RenderComplianceProfile::Pdfa2u),
      ("pdfa-3b", RenderComplianceProfile::Pdfa3b),
      ("pdfua-1", RenderComplianceProfile::Pdfua1),
    ] {
      let profile = RenderComplianceProfile::parse(Some(raw)).expect("profile should parse");
      assert_eq!(profile, expected);
      profile
        .standards()
        .expect("profile should map to a typst-pdf standards set");
    }
  }

  #[test]
  fn compliance_profile_parse_rejects_pdfx_until_real_writer_exists() {
    let err = RenderComplianceProfile::parse(Some("pdfx-4"))
      .expect_err("PDF/X must stay unavailable until renderer and validator support exist");
    assert!(matches!(
      err,
      RenderError::UnsupportedComplianceProfile { profile } if profile == "pdfx-4"
    ));
  }

  #[test]
  fn compliance_profile_maps_pdf_serialization_errors_to_stable_classes() {
    assert!(matches!(
      RenderComplianceProfile::Standard.map_pdf_error("boom".into()),
      RenderError::Compilation(detail) if detail == "boom"
    ));
    assert!(matches!(
      RenderComplianceProfile::Pdfa2b.map_pdf_error("invalid output intent".into()),
      RenderError::PdfaValidationFailed(detail) if detail == "invalid output intent"
    ));
    assert!(matches!(
      RenderComplianceProfile::Pdfua1.map_pdf_error("tag tree missing".into()),
      RenderError::PdfuaValidationFailed(detail) if detail == "tag tree missing"
    ));
  }
}

/// Result of a successful PDF render plus diagnostic data the caller can
/// surface to the user (e.g. via the `pdf_export_jobs` row, GraphQL
/// resolver, or admin UI).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderReport {
  /// The compiled PDF byte stream.
  #[serde(with = "serde_bytes")]
  pub pdf_bytes: Vec<u8>,
  /// Page count of the compiled document, observed *before* PDF byte
  /// serialisation. Surfaced so the worker / sync path can emit a
  /// `pdf_export.pages_total` business metric without re-parsing the PDF.
  pub page_count: usize,
  /// Global-theme font families that were not indexed by the FontBook.
  /// Successful renders keep this empty. Unknown Theme DB font families are
  /// rejected as configuration errors before Typst can silently substitute a
  /// different family.
  pub unmapped_font_families: Vec<String>,
}

/// Resolve extra font directories from the given server static path.
///
/// Looks for `{base}/fonts/` as the font directory.
pub fn font_dirs_from_static(static_path: &std::path::Path) -> Vec<PathBuf> {
  let fonts_dir = static_path.join("fonts");
  if fonts_dir.is_dir() { vec![fonts_dir] } else { vec![] }
}

// ─── V2 entry points (`P-PDF-TPL-13-01`) ─────────────────────────────────────

/// Render an `IrDocument` to PDF bytes using a V2 template **bundle**
/// (`HashMap<String, Vec<u8>>`).
///
/// The bundle must contain `theme.typ` + `preamble.typ` (both UTF-8).
/// Bundle-local imports and data reads resolve from the same in-memory map.
/// The manifest entry is not executed; theme/preamble composition owns layout.
///
/// Edgeless-snapshot limits default to [`EdgelessSnapshotLimits::DEFAULT`].
/// Callers that need config-driven overrides (P-PDF-TPL-IMG-01-03)
/// should use [`render_to_pdf_v2_with_snapshot_limits`].
#[instrument(skip_all, fields(doc_id = %doc.metadata.doc_id, max_pages = max_pages, files = template_files.len()))]
pub fn render_to_pdf_v2(
  doc: &IrDocument,
  template_files: &HashMap<String, Vec<u8>>,
  extra_font_dirs: &[PathBuf],
  max_pages: usize,
) -> Result<RenderReport, RenderError> {
  render_to_pdf_v2_with_snapshot_limits(
    doc,
    template_files,
    extra_font_dirs,
    max_pages,
    EdgelessSnapshotLimits::DEFAULT,
  )
}

/// V2 render entry point with configurable Edgeless-snapshot limits
/// (`P-PDF-TPL-IMG-01-03`).
///
/// The api crate builds these from the `pdf_export.edgeless_snapshot.*`
/// config block and threads them down so workspace operators can tune
/// the cap without recompiling.
#[instrument(
  skip_all,
  fields(
    doc_id = %doc.metadata.doc_id,
    max_pages = max_pages,
    files = template_files.len(),
    snapshot_max_dim = snapshot_limits.max_canvas_dimension_px,
    snapshot_max_pixels = snapshot_limits.max_canvas_total_pixels,
    snapshot_max_bytes = snapshot_limits.max_snapshot_size_bytes,
  )
)]
pub fn render_to_pdf_v2_with_snapshot_limits(
  doc: &IrDocument,
  template_files: &HashMap<String, Vec<u8>>,
  extra_font_dirs: &[PathBuf],
  max_pages: usize,
  snapshot_limits: EdgelessSnapshotLimits,
) -> Result<RenderReport, RenderError> {
  let mut snapshot_violation: Option<String> = None;
  doc.root.for_each_snapshot(&mut |snap| {
    if snapshot_violation.is_some() {
      return;
    }
    if let Err(v) = snap.validate(&snapshot_limits) {
      snapshot_violation = Some(v.to_string());
    }
  });
  if let Some(reason) = snapshot_violation {
    warn!(reason = %reason, "rejecting render: edgeless snapshot exceeds limits");
    return Err(RenderError::SnapshotLimitExceeded(reason));
  }

  debug!("generating typst V2 source from IR");
  let generated = ir_to_typst::ir_to_typst_source_v2(doc, template_files).map_err(|e| match e {
    ir_to_typst::SourceV2Error::MissingThemeFontRole(_)
    | ir_to_typst::SourceV2Error::InvalidThemeTypographyRole(_, _) => {
      RenderError::Compilation(format!("configuration error: {e}"))
    }
    e => RenderError::Compilation(format!("V2 source generation failed: {e}")),
  })?;

  let mut blobs: HashMap<String, Bytes> = doc
    .assets
    .iter()
    .map(|(id, asset)| (id.clone(), Bytes::new(asset.bytes.clone())))
    .collect();
  for (key, bytes) in generated.inline_assets {
    blobs.insert(key, Bytes::new(bytes));
  }

  let world = TypstWorld::new(generated.source, blobs, extra_font_dirs)
    .with_bundle_files(template_files)
    .map_err(|e| RenderError::Compilation(format!("invalid template bundle: {e}")))?;

  let requested_roles = [
    ("heading", doc.options.theme_fonts.heading.as_deref()),
    ("body", doc.options.theme_fonts.body.as_deref()),
    ("mono", doc.options.theme_fonts.mono.as_deref()),
    ("symbol", doc.options.theme_fonts.symbol.as_deref()),
  ];
  let mut missing_font_families: Vec<String> = Vec::new();
  for (role, family) in requested_roles {
    let Some(trimmed) = family.map(str::trim).filter(|s| !s.is_empty()) else {
      continue;
    };
    if !world.has_family(trimmed) {
      missing_font_families.push(format!("`{role}` = `{trimmed}`"));
    }
  }
  if !missing_font_families.is_empty() {
    return Err(RenderError::Compilation(format!(
      "configuration error: unknown PDF theme font family/families: {}",
      missing_font_families.join(", ")
    )));
  }

  let compiled = typst::compile::<PagedDocument>(&world);
  for w in &compiled.warnings {
    warn!(message = %w.message, "typst warning (V2)");
  }
  let document = compiled.output.map_err(|diagnostics| {
    let messages: Vec<String> = diagnostics.iter().map(|d| d.message.as_str().to_owned()).collect();
    RenderError::Compilation(messages.join("; "))
  })?;

  let page_count = document.pages().len();
  if page_count > max_pages {
    return Err(RenderError::PageLimit {
      count: page_count,
      max: max_pages,
    });
  }

  // Pin the PDF document identifier to the IR's `doc_id`. Without this the
  // typst-pdf default (`Smart::Auto`) hashes title+author — fragile if either
  // changes (PDF /ID would shift on rename) and non-unique across documents
  // that happen to share both fields. Setting `ident` to the stable workspace
  // doc-UUID makes the rendered PDF deterministic for a given (IR, fonts,
  // template) tuple — see `inv_render_is_byte_deterministic` in
  // `tests/render_e2e.rs`.
  let ident = doc.metadata.doc_id.to_string();
  let compliance = RenderComplianceProfile::parse(doc.options.compliance_profile.as_deref())?;
  let standards = compliance.standards()?;
  let pdf_options = typst_pdf::PdfOptions {
    ident: Smart::Custom(ident),
    standards,
    tagged: true,
    ..Default::default()
  };
  let pdf_bytes = typst_pdf::pdf(&document, &pdf_options).map_err(|diagnostics| {
    let messages: Vec<String> = diagnostics.iter().map(|d| d.message.as_str().to_owned()).collect();
    compliance.map_pdf_error(messages.join("; "))
  })?;

  debug!(
    size_bytes = pdf_bytes.len(),
    pages = page_count,
    unmapped = 0,
    "V2 pdf render complete"
  );
  Ok(RenderReport {
    pdf_bytes,
    page_count,
    unmapped_font_families: Vec::new(),
  })
}

pub fn asset_to_bytes(asset: &AssetData) -> Bytes {
  Bytes::new(asset.bytes.clone())
}
