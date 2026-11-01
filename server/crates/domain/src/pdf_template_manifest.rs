// SPDX-License-Identifier: AGPL-3.0-or-later
//! L2 manifest contract for PDF-Export V2 templates.
//!
//! [`PdfTemplateManifest`] is the Rust mirror of the JSON Schema at
//! `server/crates/pdf_export_templates/schema/pdf_template_manifest_v2.json`.
//! It is used for:
//!
//! 1. Validating template uploads (deserialise → `deny_unknown_fields` rejects
//!    anything the server doesn't understand).
//! 2. Querying capabilities before rendering without re-parsing the full JSON
//!    blob every time.
//!
//! Locale validation is intentionally kept out of `Deserialize` — call
//! [`PdfTemplateManifest::validate_locale`] after deserialisation.

use serde::{Deserialize, Deserializer, Serialize};

// ---------------------------------------------------------------------------
// Top-level manifest
// ---------------------------------------------------------------------------

/// Deserialised L2 manifest for a Myoxus PDF template bundle.
///
/// Validated against `pdf_template_manifest_v2.json` (schema version `"2.0"`).
/// Use [`serde_json::from_str`] / [`serde_json::from_value`] to deserialise.
///
/// # Round-trip example
///
/// ```rust
/// use myoxus_domain::pdf_template_manifest::PdfTemplateManifest;
///
/// fn main() {
///   // Note: r##"..."## is required because the accent-color hex contains "#".
///   let json = r##"{
///     "schema_version": "2.0",
///     "id": "default",
///     "name": "Default",
///     "description": "A basic template.",
///     "version": "1.0.0",
///     "engine": { "name": "typst", "version": "0.15.x" },
///     "provenance": {
///       "license_spdx": "AGPL-3.0-or-later",
///       "copyright_notice": "Copyright 2026 Myoxus contributors",
///       "source_url": "https://github.com/superions/myoxus",
///       "source_revision": "1.0.0"
///     },
///     "entry": "main.typ",
///     "assets": ["main.typ"],
///     "capabilities": {
///       "colorVariant":   { "kind": "enum", "values": ["mono","accent","brand"], "default": "mono" },
///       "headerStyle":    { "kind": "enum", "values": ["none","minimal","branded"], "default": "minimal" },
///       "footerStyle":    { "kind": "enum", "values": ["none","minimal","page-only","brand-and-page"], "default": "page-only" },
///       "coverPage":      { "kind": "boolean", "default": false },
///       "tocBehavior":    { "kind": "enum", "values": ["off","auto","force"], "default": "off" },
///       "pageNumbering":  { "kind": "enum", "values": ["arabic","roman","none"], "default": "arabic" },
///       "customMargins":  { "kind": "boolean", "default": false },
///       "accentColor":    { "kind": "color", "default": "#1F2937" },
///       "confidentialityLabels": {
///         "kind": "array<string>", "min_items": 0, "max_items": 8,
///         "item_pattern": "^[A-Za-z0-9 _-]{1,32}$", "default": []
///       },
///       "language": { "kind": "enum", "values": ["en","de","fr","es"], "default": "en" }
///     },
///     "inputs_schema": {
///       "type": "object",
///       "additionalProperties": false,
///       "properties": { "title": { "type": "string" } }
///     }
///   }"##;
///
///   let mft: PdfTemplateManifest = serde_json::from_str(json).unwrap();
///   assert_eq!(mft.schema_version, "2.0");
///   assert_eq!(mft.id, "default");
///
///   // Serialise back and verify schema_version and id survive the round-trip.
///   let back: serde_json::Value = serde_json::to_value(&mft).unwrap();
///   assert_eq!(back["schema_version"], "2.0");
///   assert_eq!(back["id"], "default");
/// }
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PdfTemplateManifest {
  /// Must be exactly `"2.0"`. Validated by a custom deserialiser so that older
  /// or newer manifests are rejected before further processing.
  #[serde(deserialize_with = "deserialize_schema_version_2_0")]
  pub schema_version: String,

  /// Stable kebab-case template identifier (e.g. `"myoxus-report-modern"`).
  pub id: String,

  /// Human-readable display name.
  pub name: String,

  /// Short description shown in admin UI.
  pub description: String,

  /// SemVer release of this exact bundle. This is the sole template-version
  /// authority; the database column mirrors it for indexing and audit reads.
  pub version: String,

  /// Target render engine.
  pub engine: PdfEngineSpec,

  /// Legal and source provenance covering the complete bundle.
  pub provenance: PdfTemplateProvenance,

  /// Relative path to the Typst entry file within the bundle (ends in `.typ`).
  pub entry: String,

  /// All file paths that must be embedded by the renderer.
  pub assets: Vec<String>,

  /// L2 capability matrix.
  pub capabilities: PdfCapabilities,

  /// JSON Schema (subset) for the per-render L3 inputs.
  pub inputs_schema: serde_json::Value,
}

impl PdfTemplateManifest {
  /// Validate that `capabilities.language.default` is not a banned locale.
  ///
  /// Banned locales are those outside the Europe + Americas scope (project
  /// rule `feedback_locale_scope_europe_americas.md`): `zh`, `ja`, `ko`,
  /// `ar`, `he`, `th`, `vi`.
  ///
  /// This validation is **intentionally not enforced inside `Deserialize`** so
  /// that callers can decide when to apply it (e.g. not during migration
  /// of legacy data).
  ///
  /// Returns `Err` with a static description if the default language is banned.
  pub fn validate_locale(&self) -> Result<(), &'static str> {
    const BANNED: &[&str] = &["zh", "ja", "ko", "ar", "he", "th", "vi"];
    if BANNED.contains(&self.capabilities.language.default.as_str()) {
      return Err("locale is outside the permitted Europe+Americas scope");
    }
    Ok(())
  }

  /// Validate the package metadata invariants that serde cannot express.
  pub fn validate_package_metadata(&self) -> Result<(), &'static str> {
    if !is_semver_triplet(&self.version) {
      return Err("template version must be a stable SemVer triplet (for example 1.2.0)");
    }
    if self.name.trim().is_empty() || self.name.chars().count() > 80 {
      return Err("template name must contain 1..=80 characters");
    }
    if self.description.chars().count() > 500 {
      return Err("template description must contain at most 500 characters");
    }
    if self.provenance.license_spdx.trim().is_empty() {
      return Err("provenance.license_spdx must not be empty");
    }
    if self.provenance.copyright_notice.trim().is_empty() {
      return Err("provenance.copyright_notice must not be empty");
    }
    if !is_https_url(&self.provenance.source_url) {
      return Err("provenance.source_url must be an absolute HTTPS URL");
    }
    if self.provenance.source_revision.trim().is_empty() {
      return Err("provenance.source_revision must not be empty");
    }
    Ok(())
  }

  /// Enforce that the declared Typst engine is compatible with the renderer
  /// embedded in the running server. Accepted declarations are the exact
  /// version or a patch wildcard for the same major/minor line.
  pub fn validate_engine_compatibility(&self, renderer_version: &str) -> Result<(), &'static str> {
    if self.engine.name != "typst" {
      return Err("engine.name must be typst");
    }
    let Some((renderer_major, renderer_minor, renderer_patch)) = parse_version_triplet(renderer_version) else {
      return Err("server Typst renderer version is invalid");
    };
    let declared = self.engine.version.as_str();
    if let Some(prefix) = declared.strip_suffix(".x") {
      return (prefix == format!("{renderer_major}.{renderer_minor}"))
        .then_some(())
        .ok_or("template targets an incompatible Typst major/minor version");
    }
    let Some((major, minor, patch)) = parse_version_triplet(declared) else {
      return Err("engine.version must be an exact version or patch wildcard");
    };
    (major == renderer_major && minor == renderer_minor && patch == renderer_patch)
      .then_some(())
      .ok_or("template targets an incompatible Typst version")
  }
}

// ---------------------------------------------------------------------------
// Engine spec
// ---------------------------------------------------------------------------

/// Legal and source provenance for a complete template bundle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PdfTemplateProvenance {
  /// SPDX license expression covering the bundle.
  pub license_spdx: String,
  /// Human-readable copyright statement.
  pub copyright_notice: String,
  /// HTTPS location from which the source can be obtained.
  pub source_url: String,
  /// Immutable upstream revision or the template release identifier.
  pub source_revision: String,
  /// Optional attribution or redistribution notice.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub notice: Option<String>,
}

/// Target render engine declared by the template manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PdfEngineSpec {
  /// Engine identifier — currently always `"typst"`.
  pub name: String,
  /// Required engine version (concrete semver or patch-wildcard, e.g. `"0.15.x"`).
  pub version: String,
}

// ---------------------------------------------------------------------------
// Capability matrix
// ---------------------------------------------------------------------------

/// L2 capability matrix for a PDF template.
///
/// Each field corresponds to a capability declaration in the manifest JSON.
/// The JSON objects use a `kind`-tagged structure (e.g. `{"kind":"enum",
/// "values":[...],"default":"mono"}`); the Rust types capture that structure
/// faithfully so that round-trips are lossless.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfCapabilities {
  /// Optional per-template paper-size allow-list. Its absence preserves the
  /// renderer's established A-series/Letter choices for deployed bundles.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub paper_size: Option<CapabilityEnumPaperSize>,
  pub color_variant: CapabilityEnumColorVariant,
  pub header_style: CapabilityEnumHeaderStyle,
  pub footer_style: CapabilityEnumFooterStyle,
  pub cover_page: CapabilityBoolean,
  pub toc_behavior: CapabilityEnumTocBehavior,
  pub page_numbering: CapabilityEnumPageNumbering,
  pub custom_margins: CapabilityBoolean,
  pub accent_color: CapabilityColor,
  pub confidentiality_labels: CapabilityArrayString,
  pub language: CapabilityEnumLanguage,
}

/// Enum capability for renderer paper sizes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityEnumPaperSize {
  pub kind: String,
  pub values: Vec<PdfPaperSize>,
  pub default: PdfPaperSize,
}

// ---------------------------------------------------------------------------
// Individual capability types
// ---------------------------------------------------------------------------

/// Boolean capability switch (e.g. `coverPage`, `customMargins`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityBoolean {
  /// Always `"boolean"`.
  pub kind: String,
  pub default: bool,
}

/// Hex-color capability (e.g. `accentColor`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityColor {
  /// Always `"color"`.
  pub kind: String,
  /// Default hex color string in `#RRGGBB` form.
  pub default: String,
}

/// Array-of-strings capability (e.g. `confidentialityLabels`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityArrayString {
  /// Always `"array<string>"`.
  pub kind: String,
  pub min_items: u32,
  pub max_items: u32,
  pub item_pattern: String,
  pub default: Vec<String>,
}

/// Enum capability for `colorVariant` (values: `mono | accent | brand`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityEnumColorVariant {
  pub kind: String,
  pub values: Vec<PdfColorVariant>,
  pub default: PdfColorVariant,
}

/// Enum capability for `headerStyle` (values: `none | minimal | branded`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityEnumHeaderStyle {
  pub kind: String,
  pub values: Vec<PdfHeaderStyle>,
  pub default: PdfHeaderStyle,
}

/// Enum capability for `footerStyle` (values: `none | minimal | page-only | brand-and-page`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityEnumFooterStyle {
  pub kind: String,
  pub values: Vec<PdfFooterStyle>,
  pub default: PdfFooterStyle,
}

/// Enum capability for `tocBehavior` (values: `off | auto | force`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityEnumTocBehavior {
  pub kind: String,
  pub values: Vec<PdfTocBehavior>,
  pub default: PdfTocBehavior,
}

/// Enum capability for `pageNumbering` (values: `arabic | roman | none`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityEnumPageNumbering {
  pub kind: String,
  pub values: Vec<PdfPageNumbering>,
  pub default: PdfPageNumbering,
}

/// Enum capability for `language`.
///
/// Values are BCP-47 locale codes restricted to Europe + Americas scope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityEnumLanguage {
  pub kind: String,
  pub values: Vec<String>,
  pub default: String,
}

// ---------------------------------------------------------------------------
// Value enums
// ---------------------------------------------------------------------------

/// Physical page format accepted by the V2 renderer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PdfPaperSize {
  A4,
  Letter,
  A3,
  A5,
  #[serde(rename = "16:9")]
  Widescreen16By9,
}

impl PdfPaperSize {
  pub const fn as_str(&self) -> &'static str {
    match self {
      Self::A4 => "A4",
      Self::Letter => "Letter",
      Self::A3 => "A3",
      Self::A5 => "A5",
      Self::Widescreen16By9 => "16:9",
    }
  }
}

/// Color treatment variant.
///
/// `mono` = grayscale, `accent` = monochrome + accent highlights,
/// `brand` = full brand palette.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfColorVariant {
  Mono,
  Accent,
  Brand,
}

impl PdfColorVariant {
  pub const fn as_str(&self) -> &'static str {
    match self {
      Self::Mono => "mono",
      Self::Accent => "accent",
      Self::Brand => "brand",
    }
  }
}

/// Page header layout.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfHeaderStyle {
  None,
  Minimal,
  Branded,
}

/// Page footer layout.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfFooterStyle {
  None,
  Minimal,
  PageOnly,
  BrandAndPage,
}

impl PdfFooterStyle {
  pub const fn as_str(&self) -> &'static str {
    match self {
      Self::None => "none",
      Self::Minimal => "minimal",
      Self::PageOnly => "page-only",
      Self::BrandAndPage => "brand-and-page",
    }
  }
}

/// Table-of-contents generation behaviour.
///
/// `off` = never, `auto` = only when >= 2 headings present, `force` = always.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfTocBehavior {
  Off,
  Auto,
  Force,
}

impl PdfTocBehavior {
  pub const fn as_str(&self) -> &'static str {
    match self {
      Self::Off => "off",
      Self::Auto => "auto",
      Self::Force => "force",
    }
  }
}

/// Page-number style.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfPageNumbering {
  Arabic,
  Roman,
  None,
}

impl PdfPageNumbering {
  pub const fn as_str(&self) -> &'static str {
    match self {
      Self::Arabic => "arabic",
      Self::Roman => "roman",
      Self::None => "none",
    }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// Custom `schema_version` deserialiser: accepts exactly `"2.0"`, rejects
/// everything else with a descriptive error.
fn deserialize_schema_version_2_0<'de, D>(d: D) -> Result<String, D::Error>
where
  D: Deserializer<'de>,
{
  let s = String::deserialize(d)?;
  if s == "2.0" {
    Ok(s)
  } else {
    Err(serde::de::Error::custom(format!(
      "unsupported manifest schema_version {:?}: only \"2.0\" is accepted",
      s
    )))
  }
}

fn parse_version_triplet(value: &str) -> Option<(u64, u64, u64)> {
  let mut parts = value.split('.');
  let parsed = (
    parts.next()?.parse().ok()?,
    parts.next()?.parse().ok()?,
    parts.next()?.parse().ok()?,
  );
  parts.next().is_none().then_some(parsed)
}

fn is_semver_triplet(value: &str) -> bool {
  parse_version_triplet(value).is_some()
}

fn is_https_url(value: &str) -> bool {
  value
    .strip_prefix("https://")
    .is_some_and(|rest| !rest.is_empty() && !rest.chars().any(char::is_whitespace))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn manifest() -> PdfTemplateManifest {
    serde_json::from_value(serde_json::json!({
      "schema_version": "2.0",
      "id": "example",
      "name": "Example",
      "description": "Example template",
      "version": "1.2.0",
      "engine": { "name": "typst", "version": "0.15.x" },
      "provenance": {
        "license_spdx": "AGPL-3.0-or-later",
        "copyright_notice": "Copyright 2026 Myoxus contributors",
        "source_url": "https://example.test/templates/example",
        "source_revision": "1.2.0"
      },
      "entry": "main.typ",
      "assets": ["main.typ"],
      "capabilities": {
        "colorVariant": { "kind": "enum", "values": ["mono", "accent", "brand"], "default": "mono" },
        "headerStyle": { "kind": "enum", "values": ["none", "minimal", "branded"], "default": "minimal" },
        "footerStyle": { "kind": "enum", "values": ["none", "minimal", "page-only", "brand-and-page"], "default": "page-only" },
        "coverPage": { "kind": "boolean", "default": false },
        "tocBehavior": { "kind": "enum", "values": ["off", "auto", "force"], "default": "off" },
        "pageNumbering": { "kind": "enum", "values": ["arabic", "roman", "none"], "default": "arabic" },
        "customMargins": { "kind": "boolean", "default": false },
        "accentColor": { "kind": "color", "default": "#1F2937" },
        "confidentialityLabels": {
          "kind": "array<string>",
          "min_items": 0,
          "max_items": 8,
          "item_pattern": "^[A-Za-z0-9 _-]{1,32}$",
          "default": []
        },
        "language": { "kind": "enum", "values": ["en", "de"], "default": "en" }
      },
      "inputs_schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      }
    }))
    .expect("valid manifest fixture")
  }

  #[test]
  fn package_metadata_and_renderer_contract_are_total() {
    let manifest = manifest();
    assert_eq!(manifest.validate_package_metadata(), Ok(()));
    assert_eq!(manifest.validate_engine_compatibility("0.15.1"), Ok(()));
  }

  #[test]
  fn incompatible_typst_minor_is_rejected() {
    let mut manifest = manifest();
    manifest.engine.version = "0.13.x".to_owned();
    assert!(manifest.validate_engine_compatibility("0.15.1").is_err());
  }

  #[test]
  fn provenance_requires_https_source() {
    let mut manifest = manifest();
    manifest.provenance.source_url = "http://example.test/template".to_owned();
    assert!(manifest.validate_package_metadata().is_err());
  }
}
