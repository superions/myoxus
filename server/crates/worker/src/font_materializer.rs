// SPDX-License-Identifier: AGPL-3.0-or-later
//! Approved-font materialization for the PDF render pipeline.
//!
//! Mikropaket: `P-PDF-TPL-FONT-01-06`.
//!
//! [`materialize_approved_fonts`] selects approved uploaded PDF-capable assets
//! and writes them into a temporary directory. Bundled font assets are
//! intentionally not materialized here: the renderer loads them from
//! `server/static/fonts`, while this function is the add-on path for operator
//! uploads. New uploads should land in the server-owned `font_families` /
//! `font_assets` catalog; the existing PDF font-upload table remains accepted
//! only for uploaded add-ons (`uploaded_by IS NOT NULL`), never for bundled
//! system fonts. The returned [`tempfile::TempDir`] guard owns the directory's
//! lifetime — the caller MUST keep the binding alive until the renderer has
//! finished reading the files. Dropping the guard wipes the directory.
//!
//! The function is best-effort: a failed read on a single font is logged
//! and skipped so a stale or orphaned blob_key cannot block an entire
//! render. Pending and rejected fonts are filtered by the font repository and
//! never reach disk.
//!
//! When the caller passes `None` for the font reader (typical in unit
//! tests / in-memory setups), this function returns `None` immediately
//! without querying the catalog.
//!
//! Design rationale: TypstWorld currently consumes filesystem directories
//! for its FontBook, so writing approved fonts to a tempdir is the smallest
//! change that keeps the pdf_export crate decoupled from Postgres /
//! opendal. A future cleanup could push raw byte slices through TypstWorld
//! directly to avoid the disk hop.

use std::path::Path;
use std::sync::Arc;

use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tracing::{debug, info, warn};

use crate::pdf_export_handler::PdfFontReader;

#[derive(Debug, Clone)]
struct PinnedThemeFontAsset {
  role: String,
  family: String,
  asset_key: String,
  sha256: String,
  format: String,
}

fn hex_sha256(bytes: &[u8]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(bytes);
  format!("{:x}", hasher.finalize())
}

fn asset_string<'a>(asset: &'a serde_json::Value, snake: &str, camel: &str) -> Option<&'a str> {
  asset
    .get(snake)
    .or_else(|| asset.get(camel))
    .and_then(|value| value.as_str())
    .map(str::trim)
    .filter(|value| !value.is_empty())
}

fn parse_pinned_theme_font_assets(render_inputs: &serde_json::Value) -> Result<Vec<PinnedThemeFontAsset>, String> {
  let assets = render_inputs
    .get("theme_font_assets")
    .and_then(|value| value.as_object())
    .ok_or_else(|| "render_inputs.theme_font_assets is missing".to_string())?;
  if assets.is_empty() {
    return Err("render_inputs.theme_font_assets is empty".to_string());
  }

  const REQUIRED_ROLES: [&str; 4] = ["heading", "body", "mono", "symbol"];
  for role in REQUIRED_ROLES {
    if !assets.contains_key(role) {
      return Err(format!("render_inputs.theme_font_assets.{role} is missing"));
    }
  }
  for role in assets.keys() {
    if !REQUIRED_ROLES.contains(&role.as_str()) {
      return Err(format!(
        "render_inputs.theme_font_assets.{role} is not a supported PDF font role"
      ));
    }
  }

  let mut out = Vec::with_capacity(assets.len());
  for (role, asset) in assets {
    let asset_key = asset_string(asset, "asset_key", "assetKey")
      .ok_or_else(|| format!("theme_font_assets.{role}.assetKey is missing"))?;
    let sha256 =
      asset_string(asset, "sha256", "sha256").ok_or_else(|| format!("theme_font_assets.{role}.sha256 is missing"))?;
    let format =
      asset_string(asset, "format", "format").ok_or_else(|| format!("theme_font_assets.{role}.format is missing"))?;
    let format = format.to_ascii_lowercase();
    if extension_for_pdf_hotpath_format(&format).is_none() {
      return Err(format!(
        "theme_font_assets.{role}.format `{format}` is not supported for PDF export; expected ttf, otf, or variable_ttf"
      ));
    }
    let family = asset_string(asset, "family", "family").unwrap_or("unknown");
    out.push(PinnedThemeFontAsset {
      role: role.clone(),
      family: family.to_owned(),
      asset_key: asset_key.to_owned(),
      sha256: sha256.to_ascii_lowercase(),
      format,
    });
  }
  out.sort_by(|a, b| a.role.cmp(&b.role));
  Ok(out)
}

fn extension_for_pdf_hotpath_format(format: &str) -> Option<&'static str> {
  match format {
    "variable_ttf" | "ttf" => Some("ttf"),
    "otf" => Some("otf"),
    _ => None,
  }
}

fn ensure_pdf_sfnt_bytes(context: &str, bytes: &[u8]) -> Result<(), String> {
  let magic = bytes
    .get(..4)
    .ok_or_else(|| format!("{context} is too short to contain a PDF font magic number"))?;

  match magic {
    [0x00, 0x01, 0x00, 0x00] | b"true" | b"OTTO" => Ok(()),
    b"ttcf" => Err(format!(
      "{context} is a TrueType collection; PDF export requires a single TTF/OTF font"
    )),
    b"wOFF" => Err(format!(
      "{context} is a WOFF browser font; PDF export requires TTF/OTF/VF bytes"
    )),
    b"wOF2" => Err(format!(
      "{context} is a WOFF2 browser font; PDF export requires TTF/OTF/VF bytes"
    )),
    other => {
      let printable: String = other
        .iter()
        .map(|byte| {
          if byte.is_ascii_graphic() {
            (*byte as char).to_string()
          } else {
            format!("\\x{byte:02X}")
          }
        })
        .collect();
      Err(format!(
        "{context} has unsupported PDF font magic `{printable}`; expected TTF/OTF/VF bytes"
      ))
    }
  }
}

fn is_static_font_asset_key(asset_key: &str) -> bool {
  !asset_key.contains('/') && !asset_key.contains('\\') && asset_key != "." && asset_key != ".."
}

/// Validate and materialize the exact theme font asset snapshot stored in
/// `render_inputs.theme_font_assets`.
///
/// This path is fail-hard by design: `theme_font_assets` is part of the
/// compliance/idempotency contract, so an async job must render with exactly
/// the asset keys and hashes captured at enqueue time, or fail before Typst is
/// invoked. Bundled assets are verified in `static_path`; uploaded assets are
/// copied from blob storage into a tempdir owned by the returned guard.
pub async fn materialize_pinned_theme_font_assets(
  static_path: &Path,
  reader: Option<&Arc<dyn PdfFontReader>>,
  render_inputs: &serde_json::Value,
) -> Result<Option<TempDir>, String> {
  let pinned = parse_pinned_theme_font_assets(render_inputs)?;
  let dir = TempDir::new().map_err(|err| format!("create pinned theme font tempdir: {err}"))?;
  let mut uploaded_written = 0usize;
  let mut static_verified = 0usize;

  for asset in pinned {
    if is_static_font_asset_key(&asset.asset_key) {
      let static_file = static_path.join(&asset.asset_key);
      if static_file.is_file() {
        let bytes = tokio::fs::read(&static_file)
          .await
          .map_err(|err| format!("read bundled theme font `{}`: {err}", static_file.display()))?;
        let actual = hex_sha256(&bytes);
        if actual != asset.sha256 {
          return Err(format!(
            "bundled theme font hash mismatch for role `{}` family `{}` asset `{}`: expected {}, got {}",
            asset.role, asset.family, asset.asset_key, asset.sha256, actual
          ));
        }
        ensure_pdf_sfnt_bytes(
          &format!(
            "bundled theme font for role `{}` family `{}` asset `{}`",
            asset.role, asset.family, asset.asset_key
          ),
          &bytes,
        )?;
        static_verified += 1;
        continue;
      }
    }

    let Some(reader) = reader else {
      return Err(format!(
        "theme font asset `{}` for role `{}` is not bundled and no font reader is configured",
        asset.asset_key, asset.role
      ));
    };
    let bytes = reader.read_font(&asset.asset_key).await.map_err(|err| {
      format!(
        "read uploaded theme font `{}` for role `{}`: {err}",
        asset.asset_key, asset.role
      )
    })?;
    let actual = hex_sha256(&bytes);
    if actual != asset.sha256 {
      return Err(format!(
        "uploaded theme font hash mismatch for role `{}` family `{}` asset `{}`: expected {}, got {}",
        asset.role, asset.family, asset.asset_key, asset.sha256, actual
      ));
    }
    ensure_pdf_sfnt_bytes(
      &format!(
        "uploaded theme font for role `{}` family `{}` asset `{}`",
        asset.role, asset.family, asset.asset_key
      ),
      &bytes,
    )?;
    let filename = format!(
      "{}.{}",
      asset.sha256,
      extension_for_pdf_hotpath_format(&asset.format).ok_or_else(|| format!(
        "theme_font_assets.{}.format `{}` is not supported",
        asset.role, asset.format
      ))?
    );
    let target = dir.path().join(filename);
    tokio::fs::write(&target, &bytes)
      .await
      .map_err(|err| format!("write pinned theme font `{}`: {err}", target.display()))?;
    uploaded_written += 1;
  }

  info!(
    static_verified,
    uploaded_written, "pinned theme font assets validated for pdf render"
  );

  if uploaded_written == 0 { Ok(None) } else { Ok(Some(dir)) }
}

/// Materialize all approved-license fonts to a fresh temp directory.
///
/// Returns:
/// - `None` when no font reader is wired (caller skips the step entirely)
/// - `None` when the DB query fails — the failure is logged at warn level
///   so a row-level outage cannot crash an in-flight render
/// - `Some(dir)` when at least one approved font was placed into the dir.
///   The dir may be empty if every approved font's blob read failed; the
///   renderer treats an empty extra dir as a no-op.
pub async fn materialize_approved_fonts(
  repository: &Arc<dyn myoxus_domain::repositories::PdfFontRepository>,
  reader: Option<&Arc<dyn PdfFontReader>>,
) -> Option<TempDir> {
  let reader = reader?;

  let assets = match repository.list_approved_render_assets().await {
    Ok(assets) => assets,
    Err(err) => {
      warn!(
        error = %err,
        "approved font catalog query failed — render proceeds with bundled fonts only"
      );
      return None;
    }
  };

  if assets.is_empty() {
    debug!("no approved uploaded PDF fonts in font catalog; render uses bundled fonts only");
    return None;
  }

  let dir = match TempDir::new() {
    Ok(d) => d,
    Err(err) => {
      warn!(
        error = %err,
        "failed to create temp dir for approved fonts — render proceeds with bundled fonts only"
      );
      return None;
    }
  };

  let mut written = 0usize;
  let mut failed = 0usize;
  for asset in &assets {
    let blob_key = &asset.blob_key;
    let sha256 = &asset.sha256;
    let family = &asset.family;
    let style = &asset.style;
    let format = &asset.format;
    let Some(extension) = extension_for_pdf_hotpath_format(format) else {
      warn!(
        blob_key = %blob_key,
        family = %family,
        style = %style,
        format = %format,
        "approved font has unsupported PDF font format — skipping"
      );
      failed += 1;
      continue;
    };
    let filename = format!("{}.{}", sha256, extension);
    let target = dir.path().join(&filename);

    match reader.read_font(blob_key).await {
      Ok(bytes) => {
        if let Err(err) = ensure_pdf_sfnt_bytes(&format!("approved font `{blob_key}`"), &bytes) {
          warn!(
            blob_key = %blob_key,
            family = %family,
            style = %style,
            format = %format,
            error = %err,
            "approved font bytes are not PDF-capable — skipping"
          );
          failed += 1;
          continue;
        }
        if let Err(err) = tokio::fs::write(&target, &bytes).await {
          warn!(
            blob_key = %blob_key,
            family = %family,
            style = %style,
            error = %err,
            "failed to write approved font to temp dir — skipping",
          );
          failed += 1;
          continue;
        }
        debug!(
          blob_key = %blob_key,
          family = %family,
          style = %style,
          bytes = bytes.len(),
          "approved font materialized"
        );
        written += 1;
      }
      Err(err) => {
        warn!(
          blob_key = %blob_key,
          family = %family,
          style = %style,
          error = %err,
          "failed to read approved font blob — skipping"
        );
        failed += 1;
      }
    }
  }

  info!(
    approved_count = assets.len(),
    written, failed, "approved fonts materialized for render"
  );

  Some(dir)
}

#[cfg(test)]
mod tests {
  use super::*;
  use async_trait::async_trait;
  use serde_json::json;

  struct StubFontReader {
    payload: Vec<u8>,
  }

  #[async_trait]
  impl PdfFontReader for StubFontReader {
    async fn read_font(&self, _blob_key: &str) -> Result<Vec<u8>, String> {
      Ok(self.payload.clone())
    }
  }

  fn sfnt_fixture_bytes() -> Vec<u8> {
    let mut bytes = vec![0x00, 0x01, 0x00, 0x00];
    bytes.extend_from_slice(b"synthetic-sfnt-test-payload");
    bytes
  }

  fn theme_assets(asset_key: &str, sha256: &str) -> serde_json::Value {
    theme_assets_with_format(asset_key, sha256, "ttf")
  }

  fn theme_assets_with_format(asset_key: &str, sha256: &str, format: &str) -> serde_json::Value {
    json!({
      "theme_font_assets": {
        "heading": { "family": "Inter", "familySlug": "inter", "assetKey": asset_key, "sha256": sha256, "format": format },
        "body": { "family": "Inter", "familySlug": "inter", "assetKey": asset_key, "sha256": sha256, "format": format },
        "mono": { "family": "JetBrains Mono", "familySlug": "jetbrains-mono", "assetKey": asset_key, "sha256": sha256, "format": format },
        "symbol": { "family": "JetBrains Mono", "familySlug": "jetbrains-mono", "assetKey": asset_key, "sha256": sha256, "format": format }
      }
    })
  }

  #[tokio::test]
  async fn inv_theme_font_assets_verify_static_asset_hashes() {
    let static_dir = TempDir::new().expect("static dir");
    let bytes = sfnt_fixture_bytes();
    let sha256 = hex_sha256(&bytes);
    tokio::fs::write(static_dir.path().join("inter-test.ttf"), &bytes)
      .await
      .expect("write static font");

    let dir = materialize_pinned_theme_font_assets(static_dir.path(), None, &theme_assets("inter-test.ttf", &sha256))
      .await
      .expect("static assets verify");

    assert!(
      dir.is_none(),
      "bundled static assets are verified in-place and must not create upload tempdirs"
    );
  }

  #[tokio::test]
  async fn inv_theme_font_assets_fail_on_missing_required_role() {
    let static_dir = TempDir::new().expect("static dir");
    let mut inputs = theme_assets("inter-test.ttf", &"0".repeat(64));
    inputs["theme_font_assets"]
      .as_object_mut()
      .expect("assets object")
      .remove("symbol");

    let err = materialize_pinned_theme_font_assets(static_dir.path(), None, &inputs)
      .await
      .expect_err("missing symbol role must fail");

    assert!(
      err.contains("theme_font_assets.symbol is missing"),
      "unexpected error: {err}"
    );
  }

  #[tokio::test]
  async fn inv_theme_font_assets_fail_on_hash_mismatch() {
    let static_dir = TempDir::new().expect("static dir");
    tokio::fs::write(static_dir.path().join("inter-test.ttf"), sfnt_fixture_bytes())
      .await
      .expect("write static font");

    let err = materialize_pinned_theme_font_assets(
      static_dir.path(),
      None,
      &theme_assets("inter-test.ttf", &"0".repeat(64)),
    )
    .await
    .expect_err("hash mismatch must fail");

    assert!(err.contains("hash mismatch"), "unexpected error: {err}");
  }

  #[tokio::test]
  async fn inv_theme_font_assets_fail_closed_on_woff2_format() {
    let static_dir = TempDir::new().expect("static dir");
    let bytes = b"actual-woff2-like-payload";
    let sha256 = hex_sha256(bytes);
    tokio::fs::write(static_dir.path().join("inter-test.woff2"), bytes)
      .await
      .expect("write static font");

    let err = materialize_pinned_theme_font_assets(
      static_dir.path(),
      None,
      &theme_assets_with_format("inter-test.woff2", &sha256, "woff2"),
    )
    .await
    .expect_err("WOFF2 theme font assets must fail before materialization");

    assert!(
      err.contains("format `woff2` is not supported for PDF export"),
      "unexpected error: {err}"
    );
  }

  #[tokio::test]
  async fn inv_theme_font_assets_reject_mislabeled_static_woff2_bytes() {
    let static_dir = TempDir::new().expect("static dir");
    let bytes = b"wOF2mislabeled-browser-font";
    let sha256 = hex_sha256(bytes);
    tokio::fs::write(static_dir.path().join("inter-test.ttf"), bytes)
      .await
      .expect("write mislabeled static font");

    let err = materialize_pinned_theme_font_assets(static_dir.path(), None, &theme_assets("inter-test.ttf", &sha256))
      .await
      .expect_err("WOFF2 bytes must be rejected even when metadata says ttf");

    assert!(
      err.contains("WOFF2 browser font"),
      "unexpected error for mislabeled static WOFF2 bytes: {err}"
    );
  }

  #[tokio::test]
  async fn inv_theme_font_assets_reject_mislabeled_uploaded_woff_bytes() {
    let static_dir = TempDir::new().expect("static dir");
    let bytes = b"wOFFmislabeled-browser-font";
    let sha256 = hex_sha256(bytes);
    let reader: Arc<dyn PdfFontReader> = Arc::new(StubFontReader {
      payload: bytes.to_vec(),
    });

    let err = materialize_pinned_theme_font_assets(
      static_dir.path(),
      Some(&reader),
      &theme_assets("uploaded/inter-test.ttf", &sha256),
    )
    .await
    .expect_err("WOFF bytes must be rejected even when metadata says ttf");

    assert!(
      err.contains("WOFF browser font"),
      "unexpected error for mislabeled uploaded WOFF bytes: {err}"
    );
  }
}
