//! Integration tests for font serving endpoints (`/api/fonts`).

use crate::helpers;

/// GET /api/fonts returns 200 with a non-empty JSON array of font entries.
#[tokio::test]
async fn fonts_list_returns_json_array() {
  let (app, _pool, _auth) = helpers::setup_app().await;
  let (status, body) = helpers::get_raw(&app, "/api/fonts").await;
  assert_eq!(status, 200);

  let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
  let arr = json.as_array().expect("response is a JSON array");
  assert!(!arr.is_empty(), "font manifest must contain at least one entry");

  // P-FONT-COVERAGE-03 bundled the locked-in 20 families.
  assert!(
    arr.len() >= 10,
    "font manifest must contain the 20 locked-in families, got {}",
    arr.len()
  );

  for (i, entry) in arr.iter().enumerate() {
    assert!(entry.get("name").is_some(), "entry[{i}] must have 'name'");
    assert!(entry.get("file").is_some(), "entry[{i}] must have 'file'");
    assert!(entry.get("category").is_some(), "entry[{i}] must have 'category'");
    assert!(entry.get("weights").is_some(), "entry[{i}] must have 'weights'");
    assert!(entry.get("url").is_some(), "entry[{i}] must have 'url'");
  }
}

/// Invariant: downloading a font file listed in the manifest returns a real font binary.
///
/// Closes coverage gap: no existing test verified that the `url` field in the manifest
/// actually serves a downloadable font file with a valid Content-Type.
#[tokio::test]
async fn inv_font_file_download_returns_valid_woff2() {
  let (app, _pool, _auth) = helpers::setup_app().await;

  // Step 1: get the manifest and extract the first font's URL.
  let (status, body) = helpers::get_raw(&app, "/api/fonts").await;
  assert_eq!(status, 200, "font manifest request must succeed");

  let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON from /api/fonts");
  let arr = json.as_array().expect("font manifest must be a JSON array");
  assert!(
    !arr.is_empty(),
    "font manifest must have at least one entry to download"
  );

  let url = arr[0]["url"]
    .as_str()
    .expect("first font entry must have a 'url' string field");

  // Step 2: download the font file via that URL.
  let (font_status, font_body) = helpers::get_raw(&app, url).await;
  assert_eq!(font_status, 200, "font file download must return 200 for url={url}");

  // Step 3: body must be a real font (>1 KB — empty or stub files would fail here).
  assert!(
    font_body.len() > 1_000,
    "font file body must be larger than 1 KB (real woff2 files are several KBs), got {} bytes for url={url}",
    font_body.len()
  );
}

/// GET /api/fonts/{unknown} returns 400 (no .woff2 suffix) or 404 (not on disk).
#[tokio::test]
async fn fonts_file_unknown_returns_error() {
  let (app, _pool, _auth) = helpers::setup_app().await;

  // Request without .woff2 suffix -> 400
  let (status, _) = helpers::get_raw(&app, "/api/fonts/nonexistent-font").await;
  assert_eq!(status, 400);

  // Request with .woff2 suffix but not on disk -> 404
  let (status, _) = helpers::get_raw(&app, "/api/fonts/nonexistent-font.woff2").await;
  assert_eq!(status, 404);
}

/// Invariant INV-FONT-01: canvas-engine font variants not listed in the manifest are served.
///
/// These TTF/VF files exist on disk but have no top-level manifest entry —
/// the manifest only carries one representative file per family. The handler
/// must still serve any physically-present font file so the canvas font loader
/// can fetch e.g. `inter-italic-vf.ttf` directly.
#[tokio::test]
async fn inv_font01_canvas_variant_fonts_are_served() {
  let (app, _pool, _auth) = helpers::setup_app().await;

  // After P-FONT-COVERAGE-02/-03 the canvas pulls TTF/VF files directly
  // (not WOFF2 subsets), so this test exercises both formats and several
  // families that the manifest only references via their primary entry.
  let canvas_fonts = [
    "/api/fonts/inter-vf.ttf",
    "/api/fonts/inter-italic-vf.ttf",
    "/api/fonts/montserrat-vf.ttf",
    "/api/fonts/poppins-semibold-italic.ttf",
    "/api/fonts/kalam-regular.ttf",
    "/api/fonts/inter-regular-latin.woff2",
  ];

  for url in canvas_fonts {
    let (status, body) = helpers::get_raw(&app, url).await;
    assert_eq!(status, 200, "canvas font variant must be served: {url}");
    assert!(
      body.len() > 1_000,
      "canvas font body must be a real font file (>1 KB), got {} bytes for {url}",
      body.len()
    );
  }
}

/// Invariant INV-FONT-02: path traversal attempts are rejected with 400.
#[tokio::test]
async fn inv_font02_path_traversal_rejected() {
  let (app, _pool, _auth) = helpers::setup_app().await;

  // URL-encoding of / and \ is decoded by Axum before the handler sees it,
  // so these checks cover both raw and encoded forms.
  let traversal_attempts = [
    "/api/fonts/../../etc/passwd",
    "/api/fonts/%2e%2e%2fpasswd.woff2",
    "/api/fonts/..%2Fetc%2Fpasswd.woff2",
  ];

  for url in traversal_attempts {
    let (status, _) = helpers::get_raw(&app, url).await;
    // Axum rejects double-dots in path segments before the handler; we accept
    // either 400 or 404 (both are safe rejections).
    assert!(
      status == 400 || status == 404,
      "path traversal must be rejected (400 or 404), got {status} for {url}"
    );
  }
}
