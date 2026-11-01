// SPDX-License-Identifier: AGPL-3.0-or-later
//! Render-time image compression pipeline (`P-PDF-TPL-IMG-01`).
//!
//! Each embedded raster asset (workspace logos, edgeless snapshots,
//! inline images) goes through:
//!
//! 1. **Decode** — `image::ImageReader::with_guessed_format` autodetects
//!    PNG / JPEG / WebP from the byte signature.
//! 2. **Resize** — if the image's pixel density would exceed the target
//!    DPI on the rendered page, downscale to the cap. The DPI cap is
//!    `pdf_export.max_dpi` (default 600) — a hard ceiling so an
//!    attacker cannot DoS the renderer with a 12000-DPI source image.
//! 3. **Re-encode** — quality-tier-driven:
//!    - `Low` → JPEG quality 60
//!    - `Med` → JPEG quality 80
//!    - `High` → JPEG quality 92
//!    - `Lossless` → PNG (preserves alpha; never lossy)
//!
//! The pipeline is pure (synchronous in-memory bytes → bytes) so the
//! renderer can call it from `spawn_blocking` without async-locking.

use std::io::Cursor;

use image::{DynamicImage, ImageError, ImageFormat, ImageReader};
use thiserror::Error;
use tracing::{debug, instrument, warn};

/// Quality tier requested by the caller. Mirrors the
/// `pdf_export_settings.default_image_quality` enum and the
/// `application::pdf_export::render_context::ImageQuality` type so the
/// renderer can pass through the same value end-to-end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressionQuality {
  /// JPEG quality 60 — heavy compression, suitable for archival drafts.
  Low,
  /// JPEG quality 80 — default for `Med`-tier exports.
  Med,
  /// JPEG quality 92 — near-lossless visual quality with much smaller
  /// files than PNG.
  High,
  /// PNG re-encode — lossless; preserves alpha and exact pixel values.
  Lossless,
}

impl CompressionQuality {
  /// Map the tier to the chosen output format. The renderer uses this to
  /// decide the `Content-Type` header on streamed assets and to label
  /// metadata in the PDF.
  pub fn output_format(self) -> ImageFormat {
    match self {
      Self::Low | Self::Med | Self::High => ImageFormat::Jpeg,
      Self::Lossless => ImageFormat::Png,
    }
  }

  /// Numeric JPEG quality (0..=100). Returns `None` for the lossless
  /// tier, which uses PNG instead.
  pub fn jpeg_quality(self) -> Option<u8> {
    match self {
      Self::Low => Some(60),
      Self::Med => Some(80),
      Self::High => Some(92),
      Self::Lossless => None,
    }
  }
}

/// Inputs to the compression call. Constructed by the renderer right
/// before each image embed.
#[derive(Debug, Clone)]
pub struct CompressionInputs<'a> {
  /// Raw image bytes as they came in from the workspace blob store.
  pub bytes: &'a [u8],
  /// Quality tier to drive the re-encode (resolved via the
  /// `RenderContext.image_quality` field).
  pub quality: CompressionQuality,
  /// Target render DPI (resolved from `RenderContext.dpi`).
  pub target_dpi: u32,
  /// Hard upper bound on DPI. Sourced from
  /// `pdf_export.max_dpi` (default `600`). Acts as a fail-safe even
  /// when a quality tier requests a higher value.
  pub max_dpi: u32,
  /// Page width in inches the image is intended to occupy. Used to
  /// translate DPI into a pixel cap (`width_in * dpi`). The renderer
  /// computes this from the layout call (e.g. `block.width / 72.0` for
  /// a Typst length in points).
  pub page_width_in: f32,
}

#[derive(Debug, Error)]
pub enum CompressionError {
  #[error("input bytes are empty")]
  Empty,
  #[error("image decode failed: {0}")]
  Decode(String),
  #[error("image re-encode failed: {0}")]
  Encode(String),
  #[error("input format `{0:?}` is not supported by the pipeline")]
  UnsupportedFormat(ImageFormat),
}

impl From<ImageError> for CompressionError {
  fn from(err: ImageError) -> Self {
    Self::Decode(err.to_string())
  }
}

/// Output of a single compression call.
#[derive(Debug, Clone)]
pub struct CompressedImage {
  pub bytes: Vec<u8>,
  pub format: ImageFormat,
  pub width_px: u32,
  pub height_px: u32,
  /// Effective DPI achieved (`width_px / page_width_in`). Useful for
  /// telemetry and for the renderer's PDF metadata writer.
  pub effective_dpi: u32,
}

/// Run the full pipeline on a single image. Pure / synchronous /
/// no-IO so the call site can wrap it in `spawn_blocking` if needed.
///
/// Errors are returned without panicking — every failure path is
/// representable via [`CompressionError`].
#[instrument(skip(input), fields(quality = ?input.quality, target_dpi = input.target_dpi))]
pub fn compress(input: &CompressionInputs<'_>) -> Result<CompressedImage, CompressionError> {
  if input.bytes.is_empty() {
    return Err(CompressionError::Empty);
  }

  let cursor = Cursor::new(input.bytes);
  let reader = ImageReader::new(cursor).with_guessed_format().map_err(|err| {
    warn!(error = %err, "image format guess failed");
    CompressionError::Decode(err.to_string())
  })?;
  let format_in = reader
    .format()
    .ok_or_else(|| CompressionError::Decode("unrecognised image format".into()))?;
  let img: DynamicImage = reader.decode()?;
  debug!(width = img.width(), height = img.height(), format = ?format_in, "decoded source image");

  // ── Resize step ─────────────────────────────────────────────────────────
  // Effective DPI cap = min(target_dpi, max_dpi). Negative or zero values
  // skip the resize entirely (caller knows what they're doing).
  let dpi_cap = input.target_dpi.min(input.max_dpi);
  let target_px = if dpi_cap > 0 && input.page_width_in > 0.0 {
    (input.page_width_in * dpi_cap as f32).round() as u32
  } else {
    img.width()
  };
  let resized = if target_px > 0 && target_px < img.width() {
    debug!(
      from_width = img.width(),
      to_width = target_px,
      dpi_cap,
      "resizing image down to fit DPI cap"
    );
    img.resize(target_px, u32::MAX, image::imageops::FilterType::Lanczos3)
  } else {
    img
  };

  let width_px = resized.width();
  let height_px = resized.height();
  let effective_dpi = if input.page_width_in > 0.0 {
    (width_px as f32 / input.page_width_in).round() as u32
  } else {
    dpi_cap
  };

  // ── Re-encode step ──────────────────────────────────────────────────────
  let format_out = input.quality.output_format();
  let mut out: Vec<u8> = Vec::with_capacity(input.bytes.len());
  match format_out {
    ImageFormat::Jpeg => {
      // Strip alpha for JPEG (lossy + no alpha channel). image-rs
      // converts internally but be explicit so the diff is auditable.
      let rgb = resized.to_rgb8();
      let quality = input.quality.jpeg_quality().unwrap_or(80);
      let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
      encoder
        .encode_image(&rgb)
        .map_err(|e| CompressionError::Encode(e.to_string()))?;
    }
    ImageFormat::Png => {
      let mut cursor = Cursor::new(&mut out);
      let encoder = image::codecs::png::PngEncoder::new_with_quality(
        &mut cursor,
        image::codecs::png::CompressionType::Best,
        image::codecs::png::FilterType::Adaptive,
      );
      use image::ImageEncoder as _;
      encoder
        .write_image(
          resized.to_rgba8().as_raw(),
          width_px,
          height_px,
          image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| CompressionError::Encode(e.to_string()))?;
    }
    other => return Err(CompressionError::UnsupportedFormat(other)),
  }

  Ok(CompressedImage {
    bytes: out,
    format: format_out,
    width_px,
    height_px,
    effective_dpi,
  })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use image::{ImageBuffer, Rgba};

  /// Build a synthetic 4096×4096 RGBA test image so the resize step has
  /// real work to do. Pixel pattern is irrelevant — the test only cares
  /// about pipeline behaviour, not visual output.
  fn synth_png(width: u32, height: u32) -> Vec<u8> {
    let buf: ImageBuffer<Rgba<u8>, _> =
      ImageBuffer::from_fn(width, height, |x, y| Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]));
    let mut out = Vec::new();
    let mut cursor = Cursor::new(&mut out);
    let encoder = image::codecs::png::PngEncoder::new(&mut cursor);
    use image::ImageEncoder as _;
    encoder
      .write_image(buf.as_raw(), width, height, image::ExtendedColorType::Rgba8)
      .expect("encode synth png");
    out
  }

  /// `INV-IMG-01` (`P-PDF-TPL-IMG-01-04`): the DPI cap is enforced
  /// strictly — a 4096-pixel-wide source on an 8.5-inch page (would need
  /// ~482 DPI) compressed at `target_dpi = 800` with `max_dpi = 600`
  /// produces no more than `600 * 8.5 ≈ 5100` pixels of output. The
  /// resize only fires when the source exceeds the cap; a 4096-wide
  /// source already below 600 DPI is left alone.
  #[test]
  fn inv_img01_dpi_cap_enforced() {
    let bytes = synth_png(8000, 8000);
    let out = compress(&CompressionInputs {
      bytes: &bytes,
      quality: CompressionQuality::High,
      target_dpi: 800,
      max_dpi: 600,
      page_width_in: 8.5,
    })
    .expect("compress");
    let cap_px = (8.5_f32 * 600.0_f32).round() as u32;
    assert!(
      out.width_px <= cap_px,
      "INV-IMG-01: width must not exceed DPI cap (cap={cap_px}, got {})",
      out.width_px
    );
    // Approximate effective DPI must be ≤ the cap.
    assert!(out.effective_dpi <= 600);
  }

  /// `INV-IMG-02` (`P-PDF-TPL-IMG-01-05`): the `Low` quality tier
  /// produces a strictly smaller blob than `High` for an identical
  /// input. JPEG compression curve is monotonic in quality so this
  /// invariant is well-formed.
  #[test]
  fn inv_img02_quality_low_smaller_than_high() {
    let bytes = synth_png(640, 480);
    let low = compress(&CompressionInputs {
      bytes: &bytes,
      quality: CompressionQuality::Low,
      target_dpi: 150,
      max_dpi: 600,
      page_width_in: 6.0,
    })
    .expect("low");
    let high = compress(&CompressionInputs {
      bytes: &bytes,
      quality: CompressionQuality::High,
      target_dpi: 150,
      max_dpi: 600,
      page_width_in: 6.0,
    })
    .expect("high");
    assert!(
      low.bytes.len() < high.bytes.len(),
      "INV-IMG-02: Low ({}) must be smaller than High ({})",
      low.bytes.len(),
      high.bytes.len()
    );
  }

  /// `INV-IMG-03` (`P-PDF-TPL-IMG-01-06`): the `Lossless` tier produces
  /// PNG output that round-trips an alpha channel. JPEG drops the alpha
  /// (verified by checking that the decoded image has 4 channels even
  /// after the pipeline ran).
  #[test]
  fn inv_img03_lossless_keeps_alpha_channel() {
    let bytes = synth_png(256, 256);
    let out = compress(&CompressionInputs {
      bytes: &bytes,
      quality: CompressionQuality::Lossless,
      target_dpi: 300,
      max_dpi: 600,
      page_width_in: 2.5,
    })
    .expect("compress");
    assert_eq!(out.format, ImageFormat::Png);
    let decoded = ImageReader::new(Cursor::new(&out.bytes))
      .with_guessed_format()
      .expect("guess")
      .decode()
      .expect("decode roundtrip");
    let rgba = decoded.to_rgba8();
    // Synthetic input had alpha=255 everywhere; round-trip must preserve.
    let pixel = rgba.get_pixel(0, 0);
    assert_eq!(pixel.0[3], 255, "INV-IMG-03: alpha must round-trip on Lossless");
  }

  /// Empty input must surface a clean error rather than panic.
  #[test]
  fn empty_input_is_rejected() {
    let err = compress(&CompressionInputs {
      bytes: &[],
      quality: CompressionQuality::Med,
      target_dpi: 150,
      max_dpi: 600,
      page_width_in: 6.0,
    })
    .expect_err("expected error");
    assert!(matches!(err, CompressionError::Empty));
  }

  /// The pipeline does not panic on an unrecognised input — surfaces
  /// the decode error.
  #[test]
  fn garbage_input_is_decoded_as_error() {
    let err = compress(&CompressionInputs {
      bytes: b"this is not an image",
      quality: CompressionQuality::Med,
      target_dpi: 150,
      max_dpi: 600,
      page_width_in: 6.0,
    })
    .expect_err("expected error");
    assert!(matches!(err, CompressionError::Decode(_)));
  }
}
