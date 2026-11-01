//! Font serving endpoints for selfhost branding.
//!
//! Serves bundled Google Fonts from `static/fonts/` and provides a
//! discovery endpoint so the admin UI can populate font dropdowns.
//!
//! Each font entry in the discovery response includes a `versionHash`
//! (8-char SHA-256 prefix from the DB-backed asset row) that clients embed in
//! request URLs (`/api/fonts/inter-regular-latin.woff2?v={hash}`) to bust
//! browser caches whenever a font file is updated.

use std::path::PathBuf;

use axum::{
  extract::{Path as AxumPath, State},
  http::{StatusCode, header},
  response::IntoResponse,
};
use serde::Serialize;
use tracing::{debug, instrument, warn};

use crate::state::ApiState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontEntry {
  pub name: String,
  /// Representative web-delivery file. PDF-capable TTF/OTF assets remain in
  /// the same DB family and are consumed by the renderer, not the browser.
  pub file: String,
  pub category: String,
  pub decorative: bool,
  pub weights: Vec<u16>,
  /// Canonical Google-Fonts subset labels covered by the bundled WOFF2s.
  #[serde(default)]
  pub coverage: Vec<String>,
  /// Content-based URL with `?v={hash}` for cache-busting.
  pub url: String,
  /// First 8 hex chars of the SHA-256 recorded for the representative asset.
  pub version_hash: String,
}

pub(crate) fn bundled_fonts_dir() -> PathBuf {
  let relative = PathBuf::from("static/fonts");
  if relative.is_dir() {
    return relative;
  }
  let manifest_relative = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .and_then(|path| path.parent())
    .map(|server_root| server_root.join("static/fonts"));
  match manifest_relative {
    Some(path) if path.is_dir() => path,
    _ => relative,
  }
}

/// `GET /api/fonts` — list all available fonts from the bundled manifest.
#[instrument(skip_all)]
pub(crate) async fn fonts_list_handler(State(state): State<ApiState>) -> impl IntoResponse {
  let Some(pool) = state.metrics_pool() else {
    warn!("font manifest requested before database pool was attached to ApiState");
    return (StatusCode::SERVICE_UNAVAILABLE, "font catalog is not available").into_response();
  };

  let families = match myoxus_infrastructure::branding::list_font_families(&pool, true).await {
    Ok(families) => families,
    Err(err) => {
      warn!(error = %err, "failed to load font catalog from database");
      return (StatusCode::INTERNAL_SERVER_ERROR, "font catalog query failed").into_response();
    }
  };

  let fonts: Vec<FontEntry> = families
    .into_iter()
    .filter_map(|family| {
      let web_asset = family
        .assets
        .iter()
        .filter(|asset| asset.usage == "web" && asset.format == "woff2")
        .min_by_key(|asset| (asset.style != "normal", asset.weight_default, asset.asset_key.as_str()))?;

      let mut weights: Vec<u16> = family
        .assets
        .iter()
        .filter(|asset| asset.usage == "web" || asset.usage == "pdf")
        .flat_map(|asset| [asset.weight_min, asset.weight_default, asset.weight_max])
        .filter_map(|weight| u16::try_from(weight).ok())
        .collect();
      weights.sort_unstable();
      weights.dedup();

      let mut coverage: Vec<String> = family
        .assets
        .iter()
        .flat_map(|asset| asset.subset_tags.iter().cloned())
        .collect();
      coverage.sort();
      coverage.dedup();

      let file = web_asset.asset_key.clone();
      let version_hash = web_asset.sha256.chars().take(8).collect::<String>();
      let url = if version_hash.is_empty() {
        format!("/api/fonts/{}", file)
      } else {
        format!("/api/fonts/{}?v={}", file, version_hash)
      };
      Some(FontEntry {
        url,
        name: family.display_name,
        file,
        decorative: matches!(family.generic_class.as_str(), "display" | "handwriting" | "symbol"),
        category: family.generic_class,
        weights,
        coverage,
        version_hash,
      })
    })
    .collect();

  debug!(count = fonts.len(), "serving font manifest");
  (StatusCode::OK, axum::Json(fonts)).into_response()
}

/// `GET /api/fonts/:filename` — serve a bundled font file with long cache headers.
///
/// Serves `.woff2`, `.ttf`, and `.otf` files under `static/fonts/`. The manifest
/// is used only for the discovery endpoint; this handler accepts any
/// physically-present font file so canvas-engine variant fonts (e.g.
/// `inter-vf.ttf`, `inter-italic-vf.ttf`) are served without a manifest entry.
///
/// The optional `?v=` query parameter is intentionally ignored — it exists only
/// for client-side cache-busting and does not affect which file is served.
///
/// Security: path traversal is prevented by rejecting any filename that
/// contains `/`, `\`, or `..`, and by only accepting font-file extensions.
#[instrument(skip_all)]
pub(crate) async fn fonts_file_handler(AxumPath(filename): AxumPath<String>) -> Result<impl IntoResponse, StatusCode> {
  if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
    return Err(StatusCode::BAD_REQUEST);
  }
  let lower = filename.to_ascii_lowercase();
  let content_type = if lower.ends_with(".woff2") {
    "font/woff2"
  } else if lower.ends_with(".ttf") {
    "font/ttf"
  } else if lower.ends_with(".otf") {
    "font/otf"
  } else {
    return Err(StatusCode::BAD_REQUEST);
  };

  let font_dir = bundled_fonts_dir();
  let font_path = font_dir.join(&filename);
  let data = tokio::fs::read(&font_path).await.map_err(|e| {
    warn!(filename = %filename, path = %font_path.display(), error = %e, "font file not found on disk");
    StatusCode::NOT_FOUND
  })?;

  debug!(filename = %filename, size = data.len(), "serving font file");
  Ok((
    [
      (header::CONTENT_TYPE, content_type),
      (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
    ],
    data,
  ))
}
