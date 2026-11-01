// SPDX-License-Identifier: AGPL-3.0-or-later
//! Safe server-side Mermaid rendering shared by public HTML and PDF export.

mod c4;

use std::borrow::Cow;

use sha2::{Digest, Sha256};
use thiserror::Error;

const MAX_MERMAID_SOURCE_BYTES: usize = 256 * 1024;
const MERMAID_RENDER_CONTRACT_KEY: &str = "merman-readable-svg-v2";

#[derive(Debug, Error)]
pub enum MermaidRenderError {
  #[error("Mermaid source is empty")]
  Empty,
  #[error("Mermaid source is too large: {bytes} bytes exceeds {max} bytes")]
  SourceTooLarge { bytes: usize, max: usize },
  #[error("Mermaid parser/renderer failed: {0}")]
  Renderer(String),
  #[error("Mermaid renderer returned no diagram")]
  Unsupported,
  #[error("Mermaid SVG failed validation: {0}")]
  InvalidSvg(&'static str),
}

pub trait MermaidExportRenderer {
  fn render_svg(&self, source: &str, diagram_id: &str) -> Result<String, MermaidRenderError>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct MermanSvgRenderer;

/// Resolved server roles for the preview-only Merman site configuration.
/// Diagram directives in the source retain their own presentation priority.
pub struct MermaidPreviewTheme<'a> {
  pub font_family: &'a str,
  pub background: &'a str,
  pub text_color: &'a str,
  pub primary_color: &'a str,
  pub primary_border_color: &'a str,
  pub line_color: &'a str,
}

impl MermaidExportRenderer for MermanSvgRenderer {
  fn render_svg(&self, source: &str, diagram_id: &str) -> Result<String, MermaidRenderError> {
    self.render_svg_with_renderer(source, diagram_id, merman::render::HeadlessRenderer::default())
  }
}

impl MermanSvgRenderer {
  /// Render a Page preview with explicit server-owned font and palette roles;
  /// the ordinary public/export renderer keeps its independent site defaults.
  pub fn render_svg_with_preview_theme(
    &self,
    source: &str,
    diagram_id: &str,
    theme: MermaidPreviewTheme<'_>,
  ) -> Result<String, MermaidRenderError> {
    let mut config = merman::MermaidConfig::default();
    config.set_value("theme", serde_json::Value::String("base".to_string()));
    let family = serde_json::Value::String(theme.font_family.to_string());
    config.set_value("fontFamily", family.clone());
    config.set_value("themeVariables.fontFamily", family);
    for (key, color) in [
      ("background", theme.background),
      ("textColor", theme.text_color),
      ("primaryColor", theme.primary_color),
      ("primaryBorderColor", theme.primary_border_color),
      ("lineColor", theme.line_color),
    ] {
      config.set_value(
        &format!("themeVariables.{key}"),
        serde_json::Value::String(color.to_string()),
      );
    }
    self.render_svg_with_renderer(
      source,
      diagram_id,
      merman::render::HeadlessRenderer::default().with_site_config(config),
    )
  }

  fn render_svg_with_renderer(
    &self,
    source: &str,
    diagram_id: &str,
    renderer: merman::render::HeadlessRenderer,
  ) -> Result<String, MermaidRenderError> {
    let source = source.trim();
    if source.is_empty() {
      return Err(MermaidRenderError::Empty);
    }
    let bytes = source.len();
    if bytes > MAX_MERMAID_SOURCE_BYTES {
      return Err(MermaidRenderError::SourceTooLarge {
        bytes,
        max: MAX_MERMAID_SOURCE_BYTES,
      });
    }

    let source = normalize_merman_compatibility(source);
    let renderer = renderer.with_vendored_text_measurer().with_diagram_id(diagram_id);
    let svg = if c4::is_c4(&source) {
      c4::render(&source, &renderer)?
    } else {
      renderer
        .render_svg_readable_sync(&source)
        .map_err(|error| MermaidRenderError::Renderer(error.to_string()))?
        .ok_or(MermaidRenderError::Unsupported)?
    };

    validate_svg(&svg)?;
    Ok(svg)
  }
}

/// Normalize Mermaid forms accepted by the browser renderer but not yet by
/// Merman's radar parser. The persisted source remains unchanged.
fn normalize_merman_compatibility(source: &str) -> Cow<'_, str> {
  let requires_normalization = source.lines().any(|line| {
    let line = line.trim();
    line == "accDescr {"
      || (line.contains(',')
        && ["showLegend ", "ticks ", "max ", "min ", "graticule "]
          .iter()
          .any(|prefix| line.starts_with(prefix)))
  });
  if !requires_normalization {
    return Cow::Borrowed(source);
  }

  let mut normalized = String::with_capacity(source.len());
  let mut lines = source.lines();
  while let Some(line) = lines.next() {
    let trimmed = line.trim();
    if trimmed.contains(',')
      && ["showLegend ", "ticks ", "max ", "min ", "graticule "]
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
    {
      let indent = &line[..line.len() - line.trim_start().len()];
      for option in trimmed.split(',').map(str::trim) {
        normalized.push_str(indent);
        normalized.push_str(option);
        normalized.push('\n');
      }
      continue;
    }
    if line.trim() != "accDescr {" {
      normalized.push_str(line);
      normalized.push('\n');
      continue;
    }

    let indent = &line[..line.len() - line.trim_start().len()];
    let mut description = Vec::new();
    for description_line in lines.by_ref() {
      if description_line.trim() == "}" {
        break;
      }
      let text = description_line.trim();
      if !text.is_empty() {
        description.push(text);
      }
    }
    normalized.push_str(indent);
    normalized.push_str("accDescr: ");
    normalized.push_str(&description.join(" "));
    normalized.push('\n');
  }
  if !source.ends_with('\n') {
    normalized.pop();
  }
  Cow::Owned(normalized)
}

pub fn mermaid_svg_asset_key(source: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(MERMAID_RENDER_CONTRACT_KEY.as_bytes());
  // Public HTML prefixes Source with its block ID to keep SVG IDs distinct.
  let diagram_source = source.split_once('\0').map_or(source, |(_, source)| source);
  if c4::is_c4(diagram_source.trim()) {
    hasher.update(b"\0c4-native-projection-v1");
  }
  hasher.update(b"\0");
  hasher.update(source.as_bytes());
  let digest = hasher.finalize();
  format!("__mermaid_{}.svg", hex::encode(&digest[..12]))
}

fn is_svg_attr_boundary(byte: u8) -> bool {
  byte.is_ascii_whitespace() || byte == b'<' || byte == b'/'
}

fn contains_event_handler_attribute(lower: &str) -> bool {
  let bytes = lower.as_bytes();
  let mut i = 0;
  while i + 3 < bytes.len() {
    if is_svg_attr_boundary(bytes[i]) && bytes[i + 1] == b'o' && bytes[i + 2] == b'n' {
      let mut j = i + 3;
      while j < bytes.len() && bytes[j].is_ascii_alphanumeric() {
        j += 1;
      }
      while j < bytes.len() && bytes[j].is_ascii_whitespace() {
        j += 1;
      }
      if j < bytes.len() && bytes[j] == b'=' {
        return true;
      }
    }
    i += 1;
  }
  false
}

fn contains_active_href(lower: &str) -> bool {
  for attr in ["href", "xlink:href"] {
    let mut offset = 0;
    while let Some(relative) = lower[offset..].find(attr) {
      let start = offset + relative;
      let before = lower.as_bytes().get(start.wrapping_sub(1)).copied();
      let after = lower.as_bytes().get(start + attr.len()).copied();
      if before.is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || after.is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
      {
        offset = start + attr.len();
        continue;
      }

      let mut value_start = start + attr.len();
      while lower.as_bytes().get(value_start).is_some_and(u8::is_ascii_whitespace) {
        value_start += 1;
      }
      if lower.as_bytes().get(value_start) != Some(&b'=') {
        offset = start + attr.len();
        continue;
      }
      value_start += 1;
      while lower.as_bytes().get(value_start).is_some_and(u8::is_ascii_whitespace) {
        value_start += 1;
      }
      if matches!(lower.as_bytes().get(value_start), Some(b'"' | b'\'')) {
        value_start += 1;
      }
      let value = &lower[value_start..];
      if value.starts_with("http:")
        || value.starts_with("https:")
        || value.starts_with("javascript:")
        || value.starts_with("//")
      {
        return true;
      }
      offset = start + attr.len();
    }
  }
  false
}

fn validate_svg(svg: &str) -> Result<(), MermaidRenderError> {
  let trimmed = svg.trim_start();
  if !trimmed.starts_with("<svg") && !trimmed.starts_with("<?xml") {
    return Err(MermaidRenderError::InvalidSvg("missing svg root"));
  }
  let lower = svg.to_ascii_lowercase();
  if lower.contains("<script") {
    return Err(MermaidRenderError::InvalidSvg("script element"));
  }
  if contains_event_handler_attribute(&lower) {
    return Err(MermaidRenderError::InvalidSvg("event handler attribute"));
  }
  if contains_active_href(&lower) {
    return Err(MermaidRenderError::InvalidSvg("external href"));
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn c4_public_svg_separates_accessibility_and_diagram_title_and_renders_technology() {
    let source = "C4Container\n%% retained comment\ntitle\n  Diagram title\naccTitle:\n  Accessible title\nBoundary(team, \"Team\") {\nContainer(api, \"API\", \"Rust\")\n}\nUpdateElementStyle(api, $techn=\"Old\")\nUpdateElementStyle(api, $techn=\"Updated\")\nPerson(user, \"User\")\nRel(user, api, \"Uses\")";
    let svg = MermanSvgRenderer
      .render_svg(source, "c4-accessibility")
      .expect("C4 SVG");
    assert!(svg.contains("Diagram title"));
    assert!(svg.contains("<title") && svg.contains("Accessible title"));
    for text in ["Updated", "Team", "API", "User", "Uses"] {
      assert!(svg.contains(text), "missing {text}");
    }
    assert!(!svg.contains("NaN"));
    assert!(svg.contains("marker"));
  }

  #[test]
  fn renders_readable_svg_and_rejects_invalid_or_active_content() {
    let svg = MermanSvgRenderer
      .render_svg("flowchart TD\n  A[Start] --> B[Done]", "mermaid-test")
      .expect("svg");
    assert!(svg.contains("<svg"));
    assert!(svg.contains("Start"));
    assert!(svg.contains("Done"));

    for svg in [
      r#"<svg><script>alert(1)</script></svg>"#,
      r#"<svg><g onclick='alert(1)'></g></svg>"#,
      r#"<svg><g onload = "alert(1)"></g></svg>"#,
      r#"<svg><a href='https://example.test/x'>x</a></svg>"#,
      r#"<svg><a href = javascript:alert(1)>x</a></svg>"#,
      r#"<svg><a xlink:href="//example.test/x">x</a></svg>"#,
    ] {
      assert!(matches!(validate_svg(svg), Err(MermaidRenderError::InvalidSvg(_))));
    }

    assert!(matches!(
      MermanSvgRenderer.render_svg("flowchart TD\n  A[", "broken"),
      Err(MermaidRenderError::Renderer(_))
    ));
  }

  #[test]
  fn stable_asset_key_includes_renderer_contract() {
    let key = mermaid_svg_asset_key("flowchart TD\n  A --> B");
    assert!(key.starts_with("__mermaid_"));
    assert!(key.ends_with(".svg"));
    assert_eq!(key, mermaid_svg_asset_key("flowchart TD\n  A --> B"));
    assert_ne!(key, mermaid_svg_asset_key("flowchart TD\n  A --> C"));

    // Existing Public HTML keys contain the block identity before the Source.
    let public_c4 = "block-id\0C4Context\nPerson(user, \"User\")";
    let mut old = Sha256::new();
    old.update(MERMAID_RENDER_CONTRACT_KEY.as_bytes());
    old.update(b"\0");
    old.update(public_c4.as_bytes());
    let old_key = format!("__mermaid_{}.svg", hex::encode(&old.finalize()[..12]));
    assert_ne!(mermaid_svg_asset_key(public_c4), old_key);
  }

  #[test]
  fn explicit_preview_theme_is_used_during_layout_and_svg_generation() {
    let svg = MermanSvgRenderer
      .render_svg_with_preview_theme(
        "flowchart TD\n  A[Start] --> B[Done]",
        "font-test",
        MermaidPreviewTheme {
          font_family: "Inter",
          background: "#ffffff",
          text_color: "#202124",
          primary_color: "#f3f4f6",
          primary_border_color: "#d5d7da",
          line_color: "#5f6368",
        },
      )
      .expect("font-bound SVG");
    assert!(svg.contains("font-family:Inter") || svg.contains("font-family=\"Inter\""));
    assert!(
      svg.contains("#f3f4f6"),
      "the resolved surface color reaches the diagram"
    );
    let source_color = MermanSvgRenderer
      .render_svg_with_preview_theme(
        "%%{init: {\"themeVariables\": {\"primaryColor\": \"#123456\"}}}%%\nflowchart TD\n A[Source] --> B[Color]",
        "source-colors",
        MermaidPreviewTheme {
          font_family: "Inter",
          background: "#ffffff",
          text_color: "#202124",
          primary_color: "#f3f4f6",
          primary_border_color: "#d5d7da",
          line_color: "#5f6368",
        },
      )
      .expect("source-theme SVG");
    assert!(
      source_color.contains("#123456"),
      "explicit source colors override site defaults"
    );
  }

  #[test]
  fn radar_block_accessibility_description_survives_server_rendering() {
    let source = r#"%%{init: {"radar":{"useMaxWidth":true,"width":600,"height":600,"marginTop":50,"marginRight":50,"marginBottom":50,"marginLeft":50,"axisScaleFactor":1,"axisLabelFactor":1.05,"curveTension":0.17}}}%%
radar-beta:
  %% Diagram source comment
  title Radar readiness
  accTitle: Radar delivery readiness
  accDescr {
    Product and delivery profiles across six readiness axes.
  }
  axis Speed["Platform"]
  axis Quality["Platform"], Cost["Long-term delivery cost"], Coverage, Security, Reliability
  axis Maintainability["Maintainability"]
  curve Product["Product profile"] {4, 3, 2, 5, 4, 3, 2.5}
  curve Delivery["Delivery profile"] {3, 4, 4, 2, 5, 4, 3.5}
  curve Operations["Operations profile"] {4.5, 4, 5, 1, 2, 3, 4}
  showLegend true, ticks 8, max 6, min 0, graticule polygon"#;
    let svg = MermanSvgRenderer
      .render_svg(source, "radar-accessibility")
      .expect("radar accessibility syntax must render");
    assert!(svg.contains("Radar delivery readiness"));
    assert!(svg.contains("Product and delivery profiles across six readiness axes."));
    assert!(svg.contains("Product profile"));
  }
}
