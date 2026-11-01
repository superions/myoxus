// SPDX-License-Identifier: AGPL-3.0-or-later
//! P8 acceptance: edgeless raster snapshots must fit inside
//! [`EdgelessSnapshotLimits`] before the renderer is asked to embed
//! them. The limits are part of the client/server contract — clients
//! resize before upload, the server is the safety net that rejects
//! anything that still exceeds the envelope so a single runaway canvas
//! cannot blow up the renderer or the blob store.
//!
//! The contract under test:
//!   * Empty placeholders (zero bytes, zero dimensions) always pass.
//!   * Width or height beyond `MAX_CANVAS_DIMENSION_PX` is rejected.
//!   * `width * height` beyond `MAX_CANVAS_TOTAL_PIXELS` is rejected.
//!   * PNG byte length beyond `MAX_SNAPSHOT_SIZE_BYTES` is rejected.
//!   * Validation runs at the start of the render pipeline so an
//!     oversized snapshot returns `RenderError::SnapshotLimitExceeded`
//!     before Typst is invoked.

use std::collections::HashMap;

use uuid::Uuid;

use myoxus_pdf_export::ir::block::{Block, EdgelessSnapshot, EdgelessSnapshotLimits, SnapshotLimitViolation};
use myoxus_pdf_export::ir::{Branding, DocumentMetadata, ExportOptions, IrDocument, ThemeFontSelection};
use myoxus_pdf_export::{CURRENT_IR_VERSION, RenderError, render_to_pdf_v2};

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

fn render(doc: &IrDocument) -> Result<Vec<u8>, RenderError> {
  render_to_pdf_v2(doc, common::default_template_bundle(), &[fonts_dir()], usize::MAX).map(|r| r.pdf_bytes)
}

const VALID_PNG_HEADER: &[u8] = b"\x89PNG\r\n\x1a\n";

fn snap(width: u32, height: u32, bytes: Vec<u8>) -> EdgelessSnapshot {
  EdgelessSnapshot {
    png_bytes: bytes,
    width_px: width,
    height_px: height,
    caption: None,
  }
}

fn document(blocks: Vec<Block>) -> IrDocument {
  IrDocument {
    version: CURRENT_IR_VERSION,
    metadata: DocumentMetadata {
      doc_id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      title: Some("Snapshot Limits Doc".into()),
      author: None,
      created_at: None,
      updated_at: None,
      workspace_name: None,
      branding: Branding::default(),
    },
    options: test_export_options(),
    root: Block::Page {
      title: vec![],
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

#[test]
fn inv_snapshot_limits_default_constants_match_spec() {
  // The values are part of the client/server contract; flagging any
  // accidental drift here is the entire point of this test.
  assert_eq!(EdgelessSnapshotLimits::MAX_CANVAS_DIMENSION_PX, 8192);
  assert_eq!(EdgelessSnapshotLimits::MAX_CANVAS_TOTAL_PIXELS, 4096 * 4096);
  assert_eq!(EdgelessSnapshotLimits::MAX_SNAPSHOT_SIZE_BYTES, 32 * 1024 * 1024);

  let d = EdgelessSnapshotLimits::DEFAULT;
  assert_eq!(d.max_canvas_dimension_px, 8192);
  assert_eq!(d.max_canvas_total_pixels, 4096 * 4096);
  assert_eq!(d.max_snapshot_size_bytes, 32 * 1024 * 1024);
}

#[test]
fn inv_snapshot_empty_placeholder_passes_validation() {
  let s = snap(0, 0, Vec::new());
  assert!(s.is_empty_placeholder());
  s.validate(&EdgelessSnapshotLimits::DEFAULT)
    .expect("placeholder must validate");
}

#[test]
fn inv_snapshot_width_dimension_rejected() {
  let s = snap(8193, 100, VALID_PNG_HEADER.to_vec());
  let err = s
    .validate(&EdgelessSnapshotLimits::DEFAULT)
    .expect_err("width above limit must reject");
  assert!(
    matches!(
      err,
      SnapshotLimitViolation::DimensionExceeded {
        axis: "width",
        value: 8193,
        max: 8192
      }
    ),
    "got {err:?}"
  );
}

#[test]
fn inv_snapshot_height_dimension_rejected() {
  let s = snap(100, 8193, VALID_PNG_HEADER.to_vec());
  let err = s
    .validate(&EdgelessSnapshotLimits::DEFAULT)
    .expect_err("height above limit must reject");
  assert!(
    matches!(
      err,
      SnapshotLimitViolation::DimensionExceeded {
        axis: "height",
        value: 8193,
        max: 8192
      }
    ),
    "got {err:?}"
  );
}

#[test]
fn inv_snapshot_total_pixels_rejected_inside_dimension_envelope() {
  // Both axes ≤ 8192 yet total > 4096*4096 = 16,777,216.
  // 5000 * 5000 = 25,000,000.
  let s = snap(5000, 5000, VALID_PNG_HEADER.to_vec());
  let err = s
    .validate(&EdgelessSnapshotLimits::DEFAULT)
    .expect_err("total pixels above limit must reject");
  assert!(
    matches!(
      err,
      SnapshotLimitViolation::TotalPixelsExceeded {
        value: 25_000_000,
        max: 16_777_216
      }
    ),
    "got {err:?}"
  );
}

#[test]
fn inv_snapshot_size_rejected() {
  // Inside dim + total-pixel limits but bytes >32 MiB.
  let bytes = vec![0u8; EdgelessSnapshotLimits::MAX_SNAPSHOT_SIZE_BYTES + 1];
  let s = snap(100, 100, bytes);
  let err = s
    .validate(&EdgelessSnapshotLimits::DEFAULT)
    .expect_err("oversized PNG must reject");
  assert!(
    matches!(
      err,
      SnapshotLimitViolation::SizeExceeded {
        bytes,
        max,
      } if bytes == EdgelessSnapshotLimits::MAX_SNAPSHOT_SIZE_BYTES + 1
        && max == EdgelessSnapshotLimits::MAX_SNAPSHOT_SIZE_BYTES
    ),
    "got {err:?}"
  );
}

#[test]
fn inv_snapshot_violation_display_is_human_readable() {
  let v = SnapshotLimitViolation::DimensionExceeded {
    axis: "width",
    value: 8193,
    max: 8192,
  };
  assert_eq!(v.to_string(), "width 8193px exceeds max 8192px");

  let v = SnapshotLimitViolation::TotalPixelsExceeded {
    value: 25_000_000,
    max: 16_777_216,
  };
  assert_eq!(v.to_string(), "25000000 total pixels exceeds max 16777216");

  let v = SnapshotLimitViolation::SizeExceeded { bytes: 100, max: 32 };
  assert_eq!(v.to_string(), "100B encoded PNG exceeds max 32B");
}

#[test]
fn inv_render_rejects_oversized_snapshot_before_compilation() {
  // 5000×5000 trips the total-pixel limit; the renderer must short-circuit
  // before constructing the Typst world. Bogus PNG bytes are intentional —
  // we want to prove the validator runs *before* Typst tries to decode.
  let oversized = snap(5000, 5000, b"not actually a png".to_vec());
  let doc = document(vec![Block::Surface(oversized)]);
  let err = render(&doc).expect_err("oversized snapshot must reject");
  match err {
    RenderError::SnapshotLimitExceeded(reason) => {
      assert!(
        reason.contains("total pixels exceeds max"),
        "expected total-pixel reason, got {reason}"
      );
    }
    other => panic!("expected SnapshotLimitExceeded, got {other:?}"),
  }
}

#[test]
fn inv_render_walks_nested_snapshots() {
  // A snapshot buried inside a Note container must still be caught.
  let oversized = snap(8193, 100, VALID_PNG_HEADER.to_vec());
  let nested = Block::Note {
    children: vec![Block::Frame(oversized)],
  };
  let doc = document(vec![nested]);
  let err = render(&doc).expect_err("nested oversized snapshot must reject");
  match err {
    RenderError::SnapshotLimitExceeded(reason) => {
      assert!(
        reason.contains("width 8193px"),
        "expected width-axis reason, got {reason}"
      );
    }
    other => panic!("expected SnapshotLimitExceeded, got {other:?}"),
  }
}

#[test]
fn inv_render_accepts_placeholder_snapshots() {
  // Zero-byte placeholder (current builder output) must keep flowing
  // through the render path so the placeholder UI path survives.
  let placeholder = snap(0, 0, Vec::new());
  let doc = document(vec![
    Block::Surface(placeholder.clone()),
    Block::SurfaceRef(placeholder.clone()),
    Block::Frame(placeholder.clone()),
    Block::Mindmap(placeholder),
  ]);
  let pdf = render(&doc).expect("placeholder snapshots must still render");
  assert_eq!(&pdf[..5], b"%PDF-");
}
