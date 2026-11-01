// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-PDF-TPL-09-08: SVG sanitization for workspace brand-logo uploads.
//!
//! Brand logos may be either PNG (passed through) or SVG. Hand-crafted SVGs
//! can carry XSS vectors — `<script>` blocks, `on*` event handlers, and
//! `xlink:href` attributes pointing at `javascript:` or `data:text/html`
//! schemes. We refuse to write user-supplied SVG to the blob store as-is.
//!
//! The sanitization strategy is **AST round-trip via [`usvg`]**: parse the
//! input into the typed `usvg::Tree` model and re-serialize via
//! [`usvg::Tree::to_string`]. usvg is a strict SVG-renderer parser — it
//! ignores anything that isn't part of the SVG presentation tree (script
//! blocks, foreignObject, custom on-* handlers, vendor extensions). The
//! re-serialized form contains only the geometry/styling that usvg knows
//! how to render, with no embedded scripts.
//!
//! Embedded image references use usvg's default data resolver for raster and
//! SVG payloads. Non-data references are explicitly disabled through
//! [`usvg::ImageHrefResolver`]:
//! `resources_dir = None` alone does not prevent usvg from reading local files.

use thiserror::Error;
use usvg::{Options, Tree, WriteOptions};

/// Output of a successful sanitization.
#[derive(Debug, Clone)]
pub struct SanitizedSvg {
  /// The cleaned SVG bytes, ready to write to the blob store. Always valid
  /// UTF-8 because [`Tree::to_string`] returns `String`.
  pub bytes: Vec<u8>,
}

/// Errors returned by [`sanitize_svg`].
#[derive(Debug, Error)]
pub enum SvgSanitizeError {
  /// The input is empty.
  #[error("svg payload is empty")]
  Empty,
  /// usvg refused to parse the input.
  #[error("svg parse failed: {0}")]
  Parse(String),
  /// Input is not valid UTF-8 or gzipped UTF-8.
  #[error("svg is not valid utf-8")]
  NotUtf8,
}

/// Sanitize an SVG payload for safe storage and serving.
///
/// Round-trips through usvg's SVG parser, which silently strips:
///
/// - `<script>` blocks (not part of the renderer's tree model)
/// - `on*` event handler attributes (not in the SVG style/presentation grammar)
/// - `<foreignObject>` HTML-content (treated as opaque, dropped on output)
/// - custom XML namespaces
///
/// Embedded image data remains supported. Non-data image references are
/// dropped without resolving local files or external URLs.
pub fn sanitize_svg(input: &[u8]) -> Result<SanitizedSvg, SvgSanitizeError> {
  if input.is_empty() {
    return Err(SvgSanitizeError::Empty);
  }

  let opt = Options {
    image_href_resolver: usvg::ImageHrefResolver {
      resolve_string: Box::new(|_, _| None),
      ..usvg::ImageHrefResolver::default()
    },
    ..Options::default()
  };
  let tree = Tree::from_data(input, &opt).map_err(|e| match e {
    usvg::Error::NotAnUtf8Str => SvgSanitizeError::NotUtf8,
    other => SvgSanitizeError::Parse(other.to_string()),
  })?;

  let serialized = tree.to_string(&WriteOptions::default());
  Ok(SanitizedSvg {
    bytes: serialized.into_bytes(),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  const PLAIN_SVG: &[u8] =
    br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>"#;

  const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQtwr6DwAC0gGrM85SdAAAAABJRU5ErkJggg==";

  #[test]
  fn blocks_existing_absolute_and_relative_image_files() {
    use base64::Engine as _;
    let directory = tempfile::Builder::new()
      .prefix("svg-sanitizer-")
      .tempdir_in(".")
      .unwrap();
    let path = directory.path().join("private.png");
    std::fs::write(&path, base64::engine::general_purpose::STANDARD.decode(PNG).unwrap()).unwrap();
    for href in [path.canonicalize().unwrap(), path.clone()] {
      for attribute in ["href", "xlink:href"] {
        let svg = format!(
          r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image {attribute}="{}" width="10" height="10"/></svg>"#,
          href.display()
        );
        let unrestricted = Tree::from_data(svg.as_bytes(), &Options::default()).unwrap();
        assert!(
          unrestricted.to_string(&WriteOptions::default()).contains(PNG),
          "fixture must exercise a readable local image"
        );
        let output = sanitize_svg(svg.as_bytes()).unwrap();
        let output = std::str::from_utf8(&output.bytes).unwrap();
        assert!(!output.contains("<image"), "local image must not be embedded: {output}");
        assert!(!output.contains(PNG));
      }
    }
  }

  #[test]
  fn preserves_embedded_image_data() {
    let svg = format!(
      r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="data:image/png;base64,{PNG}" width="10" height="10"/></svg>"#
    );
    let output = sanitize_svg(svg.as_bytes()).unwrap();
    let output = std::str::from_utf8(&output.bytes).unwrap();
    assert!(output.contains("<image"));
    assert!(output.contains(PNG), "embedded bytes must survive the round-trip");
  }

  #[test]
  fn rejects_empty_input() {
    assert!(matches!(sanitize_svg(b""), Err(SvgSanitizeError::Empty)));
  }

  /// Sanitization must round-trip a benign SVG to a still-benign SVG that
  /// preserves at least one rendering primitive. usvg normalises
  /// `<rect>` / `<circle>` / `<line>` into `<path>` elements during the
  /// AST round-trip — that's by-design (usvg's tree model only carries
  /// the renderer-relevant geometry, not the original element zoo) and
  /// must NOT count as data loss for the sanitization contract. We
  /// therefore accept any of the three primitives the input might map
  /// to, which keeps the test stable across usvg upgrades that tighten
  /// or loosen the path-conversion threshold.
  ///
  /// Mirrors the assertion in `pdf_brand_admin_test::inv_gql08_upload_logo_sanitizes_svg`
  /// so a future usvg version that changes one would surface in both.
  #[test]
  fn round_trips_safe_svg() {
    let out = sanitize_svg(PLAIN_SVG).expect("sanitize plain SVG");
    let s = std::str::from_utf8(&out.bytes).unwrap();
    assert!(s.contains("<svg"), "must produce an svg root: {s}");
    assert!(
      s.contains("<path") || s.contains("<rect") || s.contains("<circle"),
      "must preserve at least one rendering primitive (path/rect/circle) \
       after the usvg AST round-trip: {s}"
    );
  }

  #[test]
  fn strips_script_block() {
    let dirty = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
      <script>alert('xss')</script>
      <rect width="10" height="10"/>
    </svg>"#;
    let out = sanitize_svg(dirty).expect("sanitize must succeed");
    let s = std::str::from_utf8(&out.bytes).unwrap();
    assert!(!s.contains("script"), "script element must be stripped: {s}");
    assert!(!s.contains("alert"), "script body must be stripped: {s}");
  }

  #[test]
  fn strips_event_handlers() {
    let dirty = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
      <rect width="10" height="10" onload="alert(1)" onclick="javascript:alert(1)"/>
    </svg>"#;
    let out = sanitize_svg(dirty).expect("sanitize must succeed");
    let s = std::str::from_utf8(&out.bytes).unwrap();
    assert!(!s.contains("onload"), "onload must be stripped: {s}");
    assert!(!s.contains("onclick"), "onclick must be stripped: {s}");
    assert!(!s.contains("alert"), "handler body must be stripped: {s}");
  }

  #[test]
  fn strips_javascript_xlink_href() {
    let dirty =
      br#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">
      <a xlink:href="javascript:alert(1)"><rect width="10" height="10"/></a>
    </svg>"#;
    let out = sanitize_svg(dirty).expect("sanitize must succeed");
    let s = std::str::from_utf8(&out.bytes).unwrap();
    assert!(!s.contains("javascript:"), "javascript scheme must be dropped: {s}");
    assert!(!s.contains("alert"), "handler body must be stripped: {s}");
  }

  #[test]
  fn strips_foreign_object_html() {
    let dirty = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
      <foreignObject width="10" height="10">
        <body xmlns="http://www.w3.org/1999/xhtml"><script>alert('inside')</script></body>
      </foreignObject>
    </svg>"#;
    let out = sanitize_svg(dirty).expect("sanitize must succeed");
    let s = std::str::from_utf8(&out.bytes).unwrap();
    assert!(!s.contains("script"), "embedded script must be stripped: {s}");
    assert!(!s.contains("alert"), "embedded handler body must be stripped: {s}");
  }

  #[test]
  fn rejects_garbage() {
    let res = sanitize_svg(b"not-svg-at-all");
    assert!(res.is_err(), "garbage must not parse");
  }
}
