// SPDX-License-Identifier: AGPL-3.0-or-later

//! Materialized, font-free icon pairs shared by PDF and Word exports.
//! Geometry, raster fallbacks and ink bounds belong to the icon authoring build.

use std::sync::LazyLock;

use base64::Engine as _;
use serde_json::Value;

pub struct DocumentIcon {
  pub svg: &'static str,
  png: &'static str,
  /// Visible raster bounds in the generated 96 × 96 asset, right/bottom exclusive.
  pub ink_bounds: [f32; 4],
}

impl DocumentIcon {
  /// Decode the stored fallback; this never renders or recolours geometry.
  pub fn png_bytes(&self) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
      .decode(self.png)
      .expect("generated document icon PNG")
  }
}

/// Resolve a central icon name or a standard callout symbol. Unknown authored
/// choices stay explicit so each adapter can report its normalized fallback.
pub fn document_icon(name: &str, white: bool) -> Option<DocumentIcon> {
  let icon = icon_value(name)?;
  let asset = &icon[if white { "white" } else { "black" }];
  let bounds = asset["inkBounds"].as_array().expect("generated icon bounds");
  Some(DocumentIcon {
    svg: asset["svg"].as_str().expect("generated icon SVG"),
    png: asset["png"].as_str().expect("generated icon PNG"),
    ink_bounds: std::array::from_fn(|i| bounds[i].as_f64().expect("generated icon bound") as f32),
  })
}

fn icon_catalog() -> &'static Value {
  static ICONS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../static/icons/document-icons.json"))
      .expect("generated document icon catalog")
  });
  &ICONS
}

/// Select a prebuilt SVG in the editor's finite light content palette. No export
/// path generates or recolours geometry; absent/unknown roles keep neutral ink.
pub fn document_icon_svg(name: &str, reference: Option<&str>) -> Option<&'static str> {
  let icon = icon_value(name)?;
  reference
    .and_then(|reference| icon["colors"].get(reference))
    .and_then(Value::as_str)
    .or_else(|| icon["black"]["svg"].as_str())
}

/// Select an already generated colour pair for Office readers that use either
/// the SVG association or its PNG fallback. Geometry and ink bounds are shared.
pub fn document_icon_colored(name: &str, reference: Option<&str>, white: bool) -> Option<DocumentIcon> {
  let mut asset = document_icon(name, white)?;
  if let Some(reference) = reference {
    let icon = icon_value(name)?;
    if let (Some(svg), Some(png)) = (
      icon["colors"][reference].as_str(),
      icon["colorPngs"][reference]["png"].as_str(),
    ) {
      asset.svg = svg;
      asset.png = png;
    }
  }
  Some(asset)
}

fn icon_value(name: &str) -> Option<&'static Value> {
  let icons = icon_catalog();
  let name = match name {
    "⚠️" | "⚠" => "AlertTriangleIcon",
    "⛔" => "BanIcon",
    "💡" => "LightPanelIcon",
    "✅" => "CheckCircleIcon",
    "❓" => "HelpIcon",
    "ℹ️" | "ℹ" => "InformationIcon",
    "💬" => "QuoteIcon",
    other => other,
  };
  icons["icons"]
    .get(name)
    .or_else(|| icons["icons"].get(format!("{name}Icon")))
}
