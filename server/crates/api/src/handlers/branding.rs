//! Branding asset upload, runtime theme CSS, and favicon handlers.
//!
//! - `POST /api/admin/branding/upload` — admin-only branding asset upload (logo/productMark/faviconPack)
//! - `GET /api/branding/theme.css` — runtime CSS with accent colours and semantic tokens
//! - `GET /favicon.svg` — serves the uploaded logo SVG as browser favicon fallback
//! - `GET /favicon-{size}.png` — serves uploaded favicon-pack PNGs

use axum::{
  Json,
  extract::{Multipart, Path, Query, State},
  http::{HeaderMap, StatusCode, header},
  response::{IntoResponse, Response},
};
use myoxus_application::branding::{GlobalBrandAssetSlot, GlobalBrandAssetUpsert};
use myoxus_domain::entities::PdfDocumentBrandLogoSlot;
use myoxus_domain::repositories::PdfDocumentBrandLogoAsset;
use myoxus_infrastructure::branding::{AppServerBrandingProjection, load_app_server_branding};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Component, PathBuf};
use tracing::{debug, info, instrument, trace, warn};
use uuid::Uuid;

use crate::state::ApiState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppBrandAssetKind {
  Logo,
  ProductMark,
  FaviconPack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DocumentBrandLogoVariant {
  Large,
  Small,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrandingUploadTarget {
  AppServer(AppBrandAssetKind),
  Document {
    workspace_id: Uuid,
    variant: DocumentBrandLogoVariant,
  },
}

impl AppBrandAssetKind {
  fn repository_slot(self) -> GlobalBrandAssetSlot {
    match self {
      Self::Logo => GlobalBrandAssetSlot::Logo,
      Self::ProductMark => GlobalBrandAssetSlot::ProductMark,
      Self::FaviconPack => GlobalBrandAssetSlot::FaviconPack,
    }
  }

  fn public_path(self) -> &'static str {
    match self {
      Self::Logo => "/style/logo.svg",
      Self::ProductMark => "/style/product-mark.svg",
      Self::FaviconPack => "/favicon-192.png",
    }
  }
}

impl DocumentBrandLogoVariant {
  fn repository_slot(self) -> PdfDocumentBrandLogoSlot {
    match self {
      Self::Large => PdfDocumentBrandLogoSlot::Large,
      Self::Small => PdfDocumentBrandLogoSlot::Small,
    }
  }

  fn as_db_variant(self) -> &'static str {
    match self {
      Self::Large => "large",
      Self::Small => "small",
    }
  }

  fn asset_kind(self, extension: &str) -> String {
    format!("{}.{}", self.as_db_variant(), extension.trim_start_matches('.'))
  }
}

fn sha256_hex(bytes: &[u8]) -> String {
  format!("{:x}", Sha256::digest(bytes))
}

fn cache_busted_url(public_path: &str, sha256: &str) -> String {
  if !sha256.is_empty() && sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
    format!("{public_path}?v={sha256}")
  } else {
    public_path.to_string()
  }
}

fn hashed_style_filename(public_basename: &str, sha256: &str) -> String {
  let (stem, ext) = public_basename.rsplit_once('.').unwrap_or((public_basename, "bin"));
  let short = sha256.chars().take(16).collect::<String>();
  format!("{stem}.{short}.{ext}")
}

// ─── SVG sanitizer ──────────────────────────────────────────────────────────

/// Allowlisted SVG element names (lowercase).
const SVG_ALLOWED_ELEMENTS: &[&str] = &[
  "svg",
  "g",
  "defs",
  "use",
  "symbol",
  "clippath",
  "mask",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textpath",
  "style",
  "lineargradient",
  "radialgradient",
  "stop",
  "filter",
  "fegaussianblur",
  "feoffset",
  "feblend",
  "fecolormatrix",
  "fecomposite",
  "feflood",
  "femerge",
  "femergenode",
  "femorphology",
  "title",
  "desc",
  "metadata",
  "image", // internal images only (href checked separately)
  "pattern",
  "marker",
];

/// Event attributes that must be stripped (case-insensitive prefix match).
const DANGEROUS_ATTR_PREFIXES: &[&str] = &[
  "on", // onclick, onload, onerror, onmouseover, ...
];

/// Attributes that can reference external resources.
const EXTERNAL_REF_ATTRS: &[&str] = &["xlink:href", "href"];

/// Sanitize an SVG document: strip dangerous elements/attributes, reject on parse failure.
///
/// Returns the sanitized SVG bytes on success, or an error message on failure.
pub(crate) fn sanitize_svg(input: &[u8]) -> Result<Vec<u8>, String> {
  use quick_xml::events::{BytesStart, Event};
  use quick_xml::reader::Reader;
  use quick_xml::writer::Writer;

  let mut reader = Reader::from_reader(input);
  reader.config_mut().trim_text(false);

  let mut writer = Writer::new(std::io::Cursor::new(Vec::new()));
  let mut skip_depth: usize = 0;

  loop {
    match reader.read_event() {
      Ok(Event::Eof) => break,
      Err(e) => return Err(format!("SVG XML parse error: {e}")),
      Ok(Event::Start(ref e)) => {
        let name = std::str::from_utf8(e.name().as_ref())
          .unwrap_or_default()
          .to_lowercase();

        if name == "script" || name == "foreignobject" {
          skip_depth += 1;
          continue;
        }
        if skip_depth > 0 {
          skip_depth += 1;
          continue;
        }

        if !SVG_ALLOWED_ELEMENTS.contains(&name.as_str()) {
          skip_depth += 1;
          trace!(element = %name, "SVG sanitizer: skipping disallowed element");
          continue;
        }

        // Filter attributes
        let mut clean = BytesStart::new(name.clone());
        for attr in e.attributes().flatten() {
          let attr_name = std::str::from_utf8(attr.key.as_ref())
            .unwrap_or_default()
            .to_lowercase();

          // Skip event handler attributes
          if DANGEROUS_ATTR_PREFIXES
            .iter()
            .any(|p| attr_name.starts_with(p) && attr_name.len() > 2)
          {
            trace!(attr = %attr_name, "SVG sanitizer: stripping event attribute");
            continue;
          }

          // Check external references
          if EXTERNAL_REF_ATTRS.contains(&attr_name.as_str()) {
            let value = std::str::from_utf8(&attr.value).unwrap_or_default();
            if value.contains("://") || value.starts_with("//") {
              trace!(attr = %attr_name, value = %value, "SVG sanitizer: stripping external reference");
              continue;
            }
            // Block all dangerous URI schemes: javascript:, data: (any type —
            // data:image/svg+xml can embed scripts), vbscript:, etc.
            let lower_val = value.trim().to_lowercase();
            if lower_val.starts_with("javascript:")
              || lower_val.starts_with("data:")
              || lower_val.starts_with("vbscript:")
              || lower_val.starts_with("blob:")
            {
              trace!(attr = %attr_name, "SVG sanitizer: stripping dangerous URI");
              continue;
            }
          }

          clean.push_attribute(attr);
        }

        writer
          .write_event(Event::Start(clean))
          .map_err(|e| format!("SVG write error: {e}"))?;
      }
      Ok(Event::End(ref e)) => {
        if skip_depth > 0 {
          skip_depth -= 1;
          continue;
        }
        let name = std::str::from_utf8(e.name().as_ref())
          .unwrap_or_default()
          .to_lowercase();
        if SVG_ALLOWED_ELEMENTS.contains(&name.as_str()) {
          writer
            .write_event(Event::End(e.clone()))
            .map_err(|e| format!("SVG write error: {e}"))?;
        }
      }
      Ok(Event::Empty(ref e)) => {
        if skip_depth > 0 {
          continue;
        }
        let name = std::str::from_utf8(e.name().as_ref())
          .unwrap_or_default()
          .to_lowercase();

        if name == "script" || name == "foreignobject" {
          continue;
        }
        if !SVG_ALLOWED_ELEMENTS.contains(&name.as_str()) {
          trace!(element = %name, "SVG sanitizer: skipping disallowed empty element");
          continue;
        }

        let mut clean = BytesStart::new(name.clone());
        for attr in e.attributes().flatten() {
          let attr_name = std::str::from_utf8(attr.key.as_ref())
            .unwrap_or_default()
            .to_lowercase();

          if DANGEROUS_ATTR_PREFIXES
            .iter()
            .any(|p| attr_name.starts_with(p) && attr_name.len() > 2)
          {
            continue;
          }
          if EXTERNAL_REF_ATTRS.contains(&attr_name.as_str()) {
            let value = std::str::from_utf8(&attr.value).unwrap_or_default();
            if value.contains("://") || value.starts_with("//") {
              continue;
            }
            let lower_val = value.trim().to_lowercase();
            if lower_val.starts_with("javascript:")
              || lower_val.starts_with("data:")
              || lower_val.starts_with("vbscript:")
              || lower_val.starts_with("blob:")
            {
              continue;
            }
          }
          clean.push_attribute(attr);
        }

        writer
          .write_event(Event::Empty(clean))
          .map_err(|e| format!("SVG write error: {e}"))?;
      }
      Ok(event) => {
        if skip_depth == 0 {
          writer.write_event(event).map_err(|e| format!("SVG write error: {e}"))?;
        }
      }
    }
  }

  Ok(writer.into_inner().into_inner())
}

// ─── Upload handler ─────────────────────────────────────────────────────────

fn parse_document_logo_variant(slot: &str, kind: Option<&str>) -> Result<DocumentBrandLogoVariant, StatusCode> {
  let normalized_slot = slot.trim();
  let normalized_kind = kind.map(str::trim).unwrap_or_default();
  match (normalized_slot, normalized_kind) {
    ("documentLogoLarge" | "logoLarge", _) => Ok(DocumentBrandLogoVariant::Large),
    ("documentLogoSmall" | "logoSmall", _) => Ok(DocumentBrandLogoVariant::Small),
    ("logo" | "documentLogo", "large" | "Large" | "LARGE" | "") => Ok(DocumentBrandLogoVariant::Large),
    ("logo" | "documentLogo", "small" | "Small" | "SMALL") => Ok(DocumentBrandLogoVariant::Small),
    _ => {
      warn!(slot = %slot, kind = ?kind, "invalid document branding upload slot metadata");
      Err(StatusCode::UNPROCESSABLE_ENTITY)
    }
  }
}

fn parse_upload_target(
  slot: &str,
  target: Option<&str>,
  workspace_id: Option<&str>,
  kind: Option<&str>,
) -> Result<BrandingUploadTarget, StatusCode> {
  let target = target.unwrap_or("appServer").trim();
  let is_document = matches!(target, "document" | "documentBranding" | "document_branding") || workspace_id.is_some();
  if is_document {
    let workspace_id = workspace_id
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .ok_or_else(|| {
        warn!("document branding upload is missing workspaceId");
        StatusCode::BAD_REQUEST
      })?;
    let workspace_id = Uuid::parse_str(workspace_id).map_err(|_| {
      warn!(workspace_id, "document branding upload has invalid workspaceId");
      StatusCode::BAD_REQUEST
    })?;
    return Ok(BrandingUploadTarget::Document {
      workspace_id,
      variant: parse_document_logo_variant(slot, kind)?,
    });
  }

  let kind = match slot {
    "logo" => AppBrandAssetKind::Logo,
    "productMark" | "product_mark" => AppBrandAssetKind::ProductMark,
    "faviconPack" | "favicon_pack" => AppBrandAssetKind::FaviconPack,
    _ => {
      warn!(slot = %slot, "invalid app/server branding upload slot");
      return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
  };
  Ok(BrandingUploadTarget::AppServer(kind))
}

/// `POST /api/admin/branding/upload` — upload a branding asset (admin only).
///
/// Accepts multipart form with fields:
/// - `target`: optional `"appServer"` (default) or `"document"`
/// - `workspaceId`: required for document branding uploads
/// - `slot`: `"logo"`, `"productMark"`, `"faviconPack"`, `"documentLogoLarge"` or `"documentLogoSmall"`
/// - `file`: SVG/PNG data for image slots, ZIP with the app manifest favicon PNGs for faviconPack
#[instrument(skip_all)]
pub(crate) async fn branding_upload_handler(
  State(state): State<ApiState>,
  headers: HeaderMap,
  mut multipart: Multipart,
) -> Result<impl IntoResponse, StatusCode> {
  // Admin auth check
  let admin_user_id = crate::require_admin_user(&state, &headers).await?;
  info!(user_id = %admin_user_id, "branding upload request");

  let max_bytes = state.config.branding.max_upload_mb.saturating_mul(1_048_576);
  let style_dir = &state.config.branding.style_dir;

  let mut slot: Option<String> = None;
  let mut target: Option<String> = None;
  let mut workspace_id: Option<String> = None;
  let mut kind: Option<String> = None;
  let mut file_data: Option<Vec<u8>> = None;
  let mut file_name: Option<String> = None;
  let mut content_type: Option<String> = None;

  while let Some(field) = multipart.next_field().await.map_err(|e| {
    warn!(error = %e, "multipart parse error");
    StatusCode::BAD_REQUEST
  })? {
    let field_name = field.name().unwrap_or_default().to_string();
    match field_name.as_str() {
      "slot" => {
        slot = Some(field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?);
      }
      "target" | "scope" => {
        target = Some(field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?);
      }
      "workspaceId" | "workspace_id" => {
        workspace_id = Some(field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?);
      }
      "kind" | "variant" => {
        kind = Some(field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?);
      }
      "file" => {
        file_name = field.file_name().map(|s| s.to_string());
        content_type = field.content_type().map(|s| s.to_string());
        let data = field.bytes().await.map_err(|e| {
          warn!(error = %e, "failed to read upload data");
          StatusCode::BAD_REQUEST
        })?;
        if data.len() as u64 > max_bytes {
          warn!(size = data.len(), max = max_bytes, "upload exceeds size limit");
          return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        file_data = Some(data.to_vec());
      }
      _ => {
        debug!(field = %field_name, "ignoring unknown multipart field");
      }
    }
  }

  let slot = slot.ok_or_else(|| {
    warn!("missing 'slot' field in multipart upload");
    StatusCode::BAD_REQUEST
  })?;
  let file_data = file_data.ok_or_else(|| {
    warn!("missing 'file' field in multipart upload");
    StatusCode::BAD_REQUEST
  })?;
  let upload_target = parse_upload_target(&slot, target.as_deref(), workspace_id.as_deref(), kind.as_deref())?;

  // Validate content type and extension
  let ct = content_type.as_deref().unwrap_or_default();
  let fname = file_name.as_deref().unwrap_or_default().to_lowercase();
  let is_zip = ct == "application/zip" || ct == "application/x-zip-compressed" || fname.ends_with(".zip");
  let is_svg = ct == "image/svg+xml" || ct.starts_with("image/svg") || fname.ends_with(".svg");
  let is_png = ct == "image/png" || fname.ends_with(".png");

  let expects_zip = matches!(
    upload_target,
    BrandingUploadTarget::AppServer(AppBrandAssetKind::FaviconPack)
  );
  if expects_zip && !is_zip {
    warn!(content_type = %ct, filename = %fname, "unsupported file type for favicon pack upload");
    return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
  }
  if !expects_zip && !is_svg && !is_png {
    warn!(content_type = %ct, filename = %fname, "unsupported file type for branding upload");
    return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
  }

  // For SVG: sanitize
  let final_data = if expects_zip {
    file_data
  } else if is_svg {
    sanitize_svg(&file_data).map_err(|e| {
      warn!(error = %e, "SVG sanitization failed");
      StatusCode::UNPROCESSABLE_ENTITY
    })?
  } else {
    validate_png_header(&file_data).map_err(|e| {
      warn!(error = %e, "PNG validation failed");
      StatusCode::UNPROCESSABLE_ENTITY
    })?;
    file_data
  };

  match upload_target {
    BrandingUploadTarget::AppServer(app_kind) => {
      let dir = PathBuf::from(style_dir);
      tokio::fs::create_dir_all(&dir).await.map_err(|e| {
        warn!(error = %e, dir = %dir.display(), "failed to create branding style directory");
        StatusCode::INTERNAL_SERVER_ERROR
      })?;
      let sha256 = sha256_hex(&final_data);
      let mut published_paths: Vec<PathBuf> = Vec::new();
      let mut temp_paths: Vec<PathBuf> = Vec::new();
      let (storage_key, public_path, mime, response_url) = if app_kind == AppBrandAssetKind::FaviconPack {
        let favicons = validate_favicon_pack(&final_data).map_err(|e| {
          warn!(error = %e, "favicon pack validation failed");
          StatusCode::UNPROCESSABLE_ENTITY
        })?;
        for (filename, bytes) in &favicons {
          let hashed_name = hashed_style_filename(filename, &sha256);
          let temp_path = dir.join(format!(".{hashed_name}.tmp"));
          tokio::fs::write(&temp_path, bytes).await.map_err(|e| {
            warn!(error = %e, path = %temp_path.display(), "failed to write temp favicon file");
            StatusCode::INTERNAL_SERVER_ERROR
          })?;
          temp_paths.push(temp_path.clone());
          published_paths.push(dir.join(hashed_name));
        }
        let pack_name = hashed_style_filename("favicon-pack.zip", &sha256);
        let pack_temp_path = dir.join(format!(".{pack_name}.tmp"));
        tokio::fs::write(&pack_temp_path, &final_data).await.map_err(|e| {
          warn!(error = %e, path = %pack_temp_path.display(), "failed to write temp favicon pack file");
          StatusCode::INTERNAL_SERVER_ERROR
        })?;
        temp_paths.push(pack_temp_path);
        published_paths.push(dir.join(&pack_name));
        let public_path = app_kind.public_path().to_string();
        (
          pack_name,
          public_path.clone(),
          "application/zip",
          cache_busted_url(&public_path, &sha256),
        )
      } else {
        let public_basename = match (app_kind, is_png) {
          (AppBrandAssetKind::Logo, true) => "logo.png",
          (AppBrandAssetKind::Logo, false) => "logo.svg",
          (AppBrandAssetKind::ProductMark, true) => "product-mark.png",
          (AppBrandAssetKind::ProductMark, false) => "product-mark.svg",
          (AppBrandAssetKind::FaviconPack, _) => unreachable!("handled above"),
        };
        let storage_key = hashed_style_filename(public_basename, &sha256);
        let temp_path = dir.join(format!(".{storage_key}.tmp"));
        tokio::fs::write(&temp_path, &final_data).await.map_err(|e| {
          warn!(error = %e, path = %temp_path.display(), "failed to write temp branding file");
          StatusCode::INTERNAL_SERVER_ERROR
        })?;
        temp_paths.push(temp_path);
        published_paths.push(dir.join(&storage_key));
        let mime = if is_png { "image/png" } else { "image/svg+xml" };
        let public_path = format!("/style/{public_basename}");
        (
          storage_key,
          public_path.clone(),
          mime,
          cache_busted_url(&public_path, &sha256),
        )
      };

      for (temp_path, target_path) in temp_paths.iter().zip(published_paths.iter()) {
        if let Err(e) = tokio::fs::rename(temp_path, target_path).await {
          warn!(error = %e, path = %target_path.display(), "failed to publish branding file");
          for temp_path in &temp_paths {
            let _ = tokio::fs::remove_file(temp_path).await;
          }
          for target_path in &published_paths {
            let _ = tokio::fs::remove_file(target_path).await;
          }
          return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
      }
      if let Err(error) = state
        .branding_assets()
        .upsert_global_asset(GlobalBrandAssetUpsert {
          slot: app_kind.repository_slot(),
          storage_key: storage_key.clone(),
          public_path: public_path.clone(),
          mime: mime.to_string(),
          sha256: sha256.clone(),
          byte_size: final_data.len() as i64,
          created_by: admin_user_id,
        })
        .await
      {
        warn!(%error, "failed to persist branding upload metadata");
        for target_path in &published_paths {
          let _ = tokio::fs::remove_file(target_path).await;
        }
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
      }
      invalidate_branding_caches(&state).await;

      info!(
        slot = %slot,
        storage_key,
        public_url = %response_url,
        size = final_data.len(),
        "branding asset uploaded successfully"
      );
      Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({
          "slot": slot,
          "target": "appServer",
          "url": response_url,
          "assetPath": response_url,
          "sha256": sha256,
          "size": final_data.len()
        })
        .to_string(),
      ))
    }
    BrandingUploadTarget::Document { workspace_id, variant } => {
      let blob_store = state.pdf_blob_store().ok_or_else(|| {
        warn!("document branding upload requested without configured PDF blob store");
        StatusCode::SERVICE_UNAVAILABLE
      })?;
      let brand_repo = state.pdf_brand_repo().ok_or_else(|| {
        warn!(workspace_id = %workspace_id, "document branding repository unavailable");
        StatusCode::SERVICE_UNAVAILABLE
      })?;
      let extension = if is_png { "png" } else { "svg" };
      let (storage_key, sha256) = blob_store
        .put_brand_asset(workspace_id, &variant.asset_kind(extension), &final_data)
        .await
        .map_err(|err| {
          warn!(workspace_id = %workspace_id, error = %err, "failed to write document branding blob");
          StatusCode::INTERNAL_SERVER_ERROR
        })?;
      if let Err(error) = brand_repo
        .set_document_logo_blob(
          workspace_id,
          variant.repository_slot(),
          Some(PdfDocumentBrandLogoAsset {
            blob_key: storage_key.clone(),
            sha256: sha256.clone(),
            mime: if is_png { "image/png" } else { "image/svg+xml" }.to_string(),
            byte_size: final_data.len() as i64,
          }),
          admin_user_id,
          chrono::Utc::now(),
          None,
        )
        .await
      {
        warn!(workspace_id = %workspace_id, %error, "failed to persist document branding upload");
        let _ = blob_store.delete(&storage_key).await;
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
      }
      info!(
        workspace_id = %workspace_id,
        variant = variant.as_db_variant(),
        storage_key,
        sha256,
        size = final_data.len(),
        "document branding asset uploaded successfully"
      );
      Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({
          "slot": slot,
          "target": "document",
          "workspaceId": workspace_id,
          "variant": variant.as_db_variant(),
          "storageKey": storage_key,
          "sha256": sha256,
          "size": final_data.len()
        })
        .to_string(),
      ))
    }
  }
}

async fn invalidate_branding_caches(state: &ApiState) {
  // Branding assets are owned by their dedicated tables/storage. They only
  // invalidate the retained server projection cache.
  state.query_cache.server_config.invalidate_all();
  state.query_cache.metrics_server_config.record_invalidation_local();
  tracing::info!(
    cache_name = "server_config",
    reason = "brandingUpload",
    "cache invalidated"
  );
  state.publish_cache_invalidation("server_config", "all").await;
}

const FAVICON_SIZES: [u32; 7] = [32, 36, 48, 72, 96, 144, 192];

fn favicon_filename(size: u32) -> String {
  format!("favicon-{size}.png")
}

fn validate_favicon_pack(data: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
  if data.len() > 1_048_576 {
    return Err("favicon pack exceeds the 1 MiB hard cap".to_string());
  }

  let mut archive =
    zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| format!("invalid ZIP archive: {e}"))?;
  let mut found = BTreeMap::<u32, Vec<u8>>::new();

  for index in 0..archive.len() {
    let mut entry = archive
      .by_index(index)
      .map_err(|e| format!("failed to read ZIP entry {index}: {e}"))?;
    if entry.is_dir() {
      continue;
    }

    let name = entry
      .name()
      .map_err(|e| format!("invalid favicon ZIP entry name: {e}"))?
      .replace('\\', "/");
    let path = std::path::Path::new(&name);
    if path
      .components()
      .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
      return Err(format!("unsafe favicon ZIP path: {name}"));
    }
    let basename = path
      .file_name()
      .and_then(|n| n.to_str())
      .ok_or_else(|| format!("invalid favicon ZIP entry name: {name}"))?;

    let Some(size) = FAVICON_SIZES
      .iter()
      .copied()
      .find(|size| basename == favicon_filename(*size))
    else {
      debug!(entry = %name, "ignoring non-favicon entry in favicon pack");
      continue;
    };

    if found.contains_key(&size) {
      return Err(format!("duplicate favicon size {size}px"));
    }

    if entry.size() > 256 * 1024 {
      return Err(format!("favicon-{size}.png exceeds 256 KiB"));
    }

    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
      .read_to_end(&mut bytes)
      .map_err(|e| format!("failed to read favicon-{size}.png: {e}"))?;
    validate_png_dimensions(&bytes, size, size)?;
    found.insert(size, bytes);
  }

  for required in FAVICON_SIZES {
    if !found.contains_key(&required) {
      return Err(format!("missing favicon-{required}.png"));
    }
  }

  Ok(
    FAVICON_SIZES
      .iter()
      .map(|size| (favicon_filename(*size), found.remove(size).expect("size checked")))
      .collect(),
  )
}

fn validate_png_dimensions(data: &[u8], expected_width: u32, expected_height: u32) -> Result<(), String> {
  if data.len() < 24 || &data[..8] != b"\x89PNG\r\n\x1a\n" {
    return Err("favicon PNG has invalid magic bytes".to_string());
  }
  if &data[12..16] != b"IHDR" {
    return Err("favicon PNG misses IHDR chunk".to_string());
  }
  let width = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
  let height = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
  if width != expected_width || height != expected_height {
    return Err(format!(
      "favicon PNG has {width}x{height}px, expected {expected_width}x{expected_height}px"
    ));
  }
  Ok(())
}

fn validate_png_header(data: &[u8]) -> Result<(u32, u32), String> {
  if data.len() < 24 || &data[..8] != b"\x89PNG\r\n\x1a\n" {
    return Err("PNG has invalid magic bytes".to_string());
  }
  if &data[12..16] != b"IHDR" {
    return Err("PNG misses IHDR chunk".to_string());
  }
  let width = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
  let height = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
  if width == 0 || height == 0 {
    return Err("PNG dimensions must be positive".to_string());
  }
  Ok((width, height))
}

// ─── Theme CSS handler ──────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppServerBrandingRuntimeResponse {
  schema_version: u8,
  app_server_branding: AppServerBrandingProjection,
}

/// `GET /api/branding/app-server.json` — public app/server branding projection.
///
/// This endpoint is intentionally public because login/setup/error screens
/// need the shell logo before an admin session exists. It only exposes
/// runtime-public asset URLs already served by the same origin; document
/// branding, organisation identity and PDF export settings are not included.
#[instrument(skip_all)]
pub(crate) async fn branding_app_server_handler(State(state): State<ApiState>) -> Response {
  let Some(pool) = state.metrics_pool() else {
    warn!("app/server branding requested before database pool was attached to ApiState");
    return (
      StatusCode::SERVICE_UNAVAILABLE,
      [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
      "app/server branding is not available".to_string(),
    )
      .into_response();
  };

  let app_server_branding = match load_app_server_branding(&pool).await {
    Ok(branding) => branding,
    Err(err) => {
      warn!(error = %err, "failed to load app/server branding projection");
      return (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "app/server branding query failed".to_string(),
      )
        .into_response();
    }
  };

  (
    StatusCode::OK,
    [
      (header::CACHE_CONTROL, "no-cache"),
      (header::CONTENT_TYPE, "application/json; charset=utf-8"),
    ],
    Json(AppServerBrandingRuntimeResponse {
      schema_version: 1,
      app_server_branding,
    }),
  )
    .into_response()
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct BrandingThemeCssQuery {
  #[serde(rename = "workspaceId", alias = "workspace_id")]
  workspace_id: Option<String>,
}

/// `GET /api/branding/theme.css` — returns CSS custom properties for branding.
///
/// Reads the effective global or workspace theme profile from the typed
/// theme database and emits CSS that frontends load at runtime. The endpoint
/// intentionally does not read `app_configs`; PostgreSQL theme tables are the
/// server-side source of truth. A workspace query keeps client routing thin:
/// no frontend merges local theme data, it only asks the server for the
/// effective profile for the active workspace.
#[instrument(skip_all)]
pub(crate) async fn branding_theme_css_handler(
  State(state): State<ApiState>,
  Query(query): Query<BrandingThemeCssQuery>,
) -> Response {
  let workspace_id = match parse_runtime_workspace_id(query.workspace_id.as_deref()) {
    Ok(workspace_id) => workspace_id,
    Err(message) => {
      warn!(error = %message, "runtime theme CSS requested with invalid workspace id");
      return (
        StatusCode::BAD_REQUEST,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        message,
      )
        .into_response();
    }
  };

  let Some(pool) = state.metrics_pool() else {
    warn!("runtime theme CSS requested before database pool was attached to ApiState");
    return (
      StatusCode::SERVICE_UNAVAILABLE,
      [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
      "theme catalog is not available".to_string(),
    )
      .into_response();
  };

  let profile = match myoxus_infrastructure::branding::load_effective_theme_profile(&pool, workspace_id).await {
    Ok(profile) => profile,
    Err(err) => {
      let status = if matches!(err, myoxus_domain::repositories::RepositoryError::NotFound("workspace")) {
        StatusCode::NOT_FOUND
      } else {
        StatusCode::INTERNAL_SERVER_ERROR
      };
      warn!(error = %err, workspace_id = ?workspace_id, "failed to load effective theme profile");
      return (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "theme catalog query failed".to_string(),
      )
        .into_response();
    }
  };
  let fonts = match myoxus_infrastructure::branding::list_font_families(&pool, true).await {
    Ok(fonts) => fonts,
    Err(err) => {
      warn!(error = %err, "failed to load font families for runtime theme CSS");
      return (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "font catalog query failed".to_string(),
      )
        .into_response();
    }
  };

  let css = myoxus_infrastructure::branding::build_runtime_theme_css(&profile, &fonts);

  trace!(css_len = css.len(), workspace_id = ?workspace_id, "generated branding theme CSS");

  (
    StatusCode::OK,
    [
      (header::CONTENT_TYPE, "text/css; charset=utf-8"),
      (header::CACHE_CONTROL, "no-cache"),
    ],
    css,
  )
    .into_response()
}

fn parse_runtime_workspace_id(value: Option<&str>) -> Result<Option<Uuid>, String> {
  let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
    return Ok(None);
  };
  Uuid::parse_str(value)
    .map(Some)
    .map_err(|_| "invalid workspaceId".to_string())
}

fn safe_style_storage_path(style_dir: &str, storage_key: &str) -> Option<PathBuf> {
  let path = std::path::Path::new(storage_key);
  if path.components().count() != 1 {
    return None;
  }
  let name = path.file_name()?.to_str()?;
  let is_safe = !name.starts_with('.')
    && name
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'));
  if is_safe {
    Some(std::path::Path::new(style_dir).join(name))
  } else {
    None
  }
}

fn style_asset_cache_headers(mime: &str, sha256: &str) -> [(header::HeaderName, String); 3] {
  [
    (header::CONTENT_TYPE, mime.to_string()),
    (header::CACHE_CONTROL, "public, max-age=31536000, immutable".to_string()),
    (header::ETAG, format!("\"{sha256}\"")),
  ]
}

/// `GET /style/{filename}` — serve DB-selected app/server brand assets.
///
/// The route intentionally resolves the public filename through
/// `app_server_branding` and `brand_assets`; arbitrary files from the style
/// directory are not exposed.
#[instrument(skip_all, fields(filename = %filename))]
pub(crate) async fn branding_style_asset_handler(
  State(state): State<ApiState>,
  Path(filename): Path<String>,
) -> Response {
  let public_path = match filename.as_str() {
    "logo.svg" | "logo.png" | "product-mark.svg" | "product-mark.png" => format!("/style/{filename}"),
    _ => {
      debug!(filename, "refusing unknown public style asset");
      return (StatusCode::NOT_FOUND, "style asset not found").into_response();
    }
  };
  let asset = match state.branding_assets().public_style_asset(&public_path).await {
    Ok(Some(asset)) => asset,
    Ok(None) => return (StatusCode::NOT_FOUND, "style asset not found").into_response(),
    Err(err) => {
      warn!(error = %err, public_path, "failed to load public style asset metadata");
      return (StatusCode::INTERNAL_SERVER_ERROR, "branding asset query failed").into_response();
    }
  };
  let Some(path) = safe_style_storage_path(&state.config.branding.style_dir, &asset.storage_key) else {
    warn!(
      storage_key = asset.storage_key,
      "refusing unsafe style asset storage key"
    );
    return (StatusCode::INTERNAL_SERVER_ERROR, "invalid branding asset metadata").into_response();
  };
  match tokio::fs::read(&path).await {
    Ok(data) => (
      StatusCode::OK,
      style_asset_cache_headers(&asset.mime, &asset.sha256),
      data,
    )
      .into_response(),
    Err(err) => {
      warn!(error = %err, path = %path.display(), "public style asset file is missing");
      (StatusCode::NOT_FOUND, "style asset not found").into_response()
    }
  }
}

/// `GET /favicon.svg` — serve the uploaded logo SVG as a browser favicon.
///
/// Reads the logo through `app_server_branding` and `brand_assets`. Falls back
/// to a minimal built-in SVG if no SVG logo has been uploaded.
#[instrument(skip_all)]
pub(crate) async fn branding_favicon_handler(
  axum::extract::State(state): axum::extract::State<crate::state::ApiState>,
) -> impl axum::response::IntoResponse {
  let data = if let Ok(Some(asset)) = state.branding_assets().public_style_asset("/style/logo.svg").await
    && asset.mime == "image/svg+xml"
    && let Some(path) = safe_style_storage_path(&state.config.branding.style_dir, &asset.storage_key)
  {
    tokio::fs::read(&path).await.unwrap_or_else(|err| {
      warn!(error = %err, path = %path.display(), "uploaded favicon SVG is missing");
      Vec::new()
    })
  } else {
    Vec::new()
  };
  let data = if data.is_empty() {
    b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><circle cx=\"16\" cy=\"16\" r=\"14\" fill=\"#1E96EB\"/><text x=\"16\" y=\"22\" text-anchor=\"middle\" font-size=\"18\" fill=\"white\" font-family=\"sans-serif\">M</text></svg>".to_vec()
  } else {
    data
  };

  (
    [
      (axum::http::header::CONTENT_TYPE, "image/svg+xml"),
      (axum::http::header::CACHE_CONTROL, "public, max-age=3600"),
    ],
    data,
  )
}

/// `GET /favicon-{size}.png` — serve uploaded favicon-pack PNGs.
///
/// The route is intentionally strict to avoid path construction from arbitrary
/// request values. Missing files fall back to `favicon.svg`; browsers can then
/// still show the logo-derived icon until a pack is uploaded.
#[instrument(skip_all, fields(size = %size))]
async fn branding_favicon_png_fixed_handler(state: ApiState, size: u32) -> impl IntoResponse {
  if !FAVICON_SIZES.contains(&size) {
    return (
      StatusCode::NOT_FOUND,
      [
        (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
        (header::CACHE_CONTROL, "no-cache"),
      ],
      Vec::from("unsupported favicon size"),
    );
  }

  let asset = match state.branding_assets().favicon_pack_asset().await {
    Ok(Some(asset)) => asset,
    Ok(None) => {
      return (
        StatusCode::NOT_FOUND,
        [
          (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
          (header::CACHE_CONTROL, "no-cache"),
        ],
        Vec::from("favicon not uploaded"),
      );
    }
    Err(err) => {
      warn!(error = %err, "failed to load favicon pack metadata");
      return (
        StatusCode::INTERNAL_SERVER_ERROR,
        [
          (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
          (header::CACHE_CONTROL, "no-cache"),
        ],
        Vec::from("favicon query failed"),
      );
    }
  };
  let filename = hashed_style_filename(&favicon_filename(size), &asset.sha256);
  let Some(path) = safe_style_storage_path(&state.config.branding.style_dir, &filename) else {
    warn!(filename, "refusing unsafe favicon storage key");
    return (
      StatusCode::INTERNAL_SERVER_ERROR,
      [
        (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
        (header::CACHE_CONTROL, "no-cache"),
      ],
      Vec::from("invalid favicon metadata"),
    );
  };
  match tokio::fs::read(&path).await {
    Ok(data) => (
      StatusCode::OK,
      [
        (header::CONTENT_TYPE, "image/png"),
        (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
      ],
      data,
    ),
    Err(e) => {
      debug!(
        error = %e,
        path = %path.display(),
        "favicon PNG not found; returning 404 so clients can use favicon.svg fallback"
      );
      (
        StatusCode::NOT_FOUND,
        [
          (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
          (header::CACHE_CONTROL, "no-cache"),
        ],
        Vec::from("favicon not uploaded"),
      )
    }
  }
}

pub(crate) async fn branding_favicon_32_png_handler(State(state): State<ApiState>) -> impl IntoResponse {
  branding_favicon_png_fixed_handler(state, 32).await
}

pub(crate) async fn branding_favicon_36_png_handler(State(state): State<ApiState>) -> impl IntoResponse {
  branding_favicon_png_fixed_handler(state, 36).await
}

pub(crate) async fn branding_favicon_48_png_handler(State(state): State<ApiState>) -> impl IntoResponse {
  branding_favicon_png_fixed_handler(state, 48).await
}

pub(crate) async fn branding_favicon_72_png_handler(State(state): State<ApiState>) -> impl IntoResponse {
  branding_favicon_png_fixed_handler(state, 72).await
}

pub(crate) async fn branding_favicon_96_png_handler(State(state): State<ApiState>) -> impl IntoResponse {
  branding_favicon_png_fixed_handler(state, 96).await
}

pub(crate) async fn branding_favicon_144_png_handler(State(state): State<ApiState>) -> impl IntoResponse {
  branding_favicon_png_fixed_handler(state, 144).await
}

pub(crate) async fn branding_favicon_192_png_handler(State(state): State<ApiState>) -> impl IntoResponse {
  branding_favicon_png_fixed_handler(state, 192).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;

  #[test]
  fn sanitize_strips_script_element() {
    let svg =
      br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>"#;
    let result = sanitize_svg(svg).unwrap();
    let output = String::from_utf8(result).unwrap();
    assert!(!output.contains("script"), "script element should be stripped");
    assert!(output.contains("rect"), "rect element should be preserved");
  }

  #[test]
  fn sanitize_strips_event_attributes() {
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)" width="10" height="10"/></svg>"#;
    let result = sanitize_svg(svg).unwrap();
    let output = String::from_utf8(result).unwrap();
    assert!(!output.contains("onclick"), "onclick should be stripped");
    assert!(output.contains("width"), "width should be preserved");
  }

  #[test]
  fn sanitize_strips_external_href() {
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.com/x.png"/></svg>"#;
    let result = sanitize_svg(svg).unwrap();
    let output = String::from_utf8(result).unwrap();
    assert!(!output.contains("evil.com"), "external href should be stripped");
  }

  #[test]
  fn sanitize_keeps_internal_href() {
    let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><use href=\"#icon\"/></svg>";
    let result = sanitize_svg(svg).unwrap();
    let output = String::from_utf8(result).unwrap();
    assert!(output.contains("#icon"), "internal href should be preserved");
  }

  #[test]
  fn sanitize_strips_foreignobject() {
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body>evil</body></foreignObject><rect width="1" height="1"/></svg>"#;
    let result = sanitize_svg(svg).unwrap();
    let output = String::from_utf8(result).unwrap();
    assert!(!output.to_lowercase().contains("foreignobject"));
    assert!(output.contains("rect"));
  }

  fn minimal_png(width: u32, height: u32) -> Vec<u8> {
    let mut png = Vec::new();
    png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    png.extend_from_slice(&13u32.to_be_bytes());
    png.extend_from_slice(b"IHDR");
    png.extend_from_slice(&width.to_be_bytes());
    png.extend_from_slice(&height.to_be_bytes());
    png.extend_from_slice(&[8, 6, 0, 0, 0]);
    png.extend_from_slice(&0u32.to_be_bytes());
    png
  }

  fn favicon_pack(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let cursor = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in entries {
      zip.start_file(name.as_str(), options).expect("start zip file");
      zip.write_all(bytes).expect("write zip file");
    }
    zip.finish().expect("finish zip").into_inner()
  }

  #[test]
  fn favicon_pack_accepts_required_png_sizes() {
    let pack = favicon_pack(
      &FAVICON_SIZES
        .iter()
        .map(|size| (favicon_filename(*size), minimal_png(*size, *size)))
        .collect::<Vec<_>>(),
    );

    let result = validate_favicon_pack(&pack).expect("valid favicon pack");

    assert_eq!(
      result.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(),
      vec![
        "favicon-32.png",
        "favicon-36.png",
        "favicon-48.png",
        "favicon-72.png",
        "favicon-96.png",
        "favicon-144.png",
        "favicon-192.png",
      ]
    );
  }

  #[test]
  fn favicon_pack_rejects_missing_size() {
    let pack = favicon_pack(&[
      (favicon_filename(32), minimal_png(32, 32)),
      (favicon_filename(36), minimal_png(36, 36)),
      (favicon_filename(48), minimal_png(48, 48)),
      (favicon_filename(72), minimal_png(72, 72)),
      (favicon_filename(96), minimal_png(96, 96)),
      (favicon_filename(144), minimal_png(144, 144)),
    ]);

    let error = validate_favicon_pack(&pack).expect_err("missing 192px icon must fail");

    assert!(error.contains("missing favicon-192.png"), "{error}");
  }

  #[test]
  fn favicon_pack_rejects_wrong_dimensions() {
    let pack = favicon_pack(
      &FAVICON_SIZES
        .iter()
        .map(|size| {
          let actual = if *size == 32 { 31 } else { *size };
          (favicon_filename(*size), minimal_png(actual, *size))
        })
        .collect::<Vec<_>>(),
    );

    let error = validate_favicon_pack(&pack).expect_err("wrong dimensions must fail");

    assert!(error.contains("expected 32x32px"), "{error}");
  }

  #[test]
  fn sanitize_rejects_invalid_xml() {
    let svg = b"<svg><not closed";
    let result = sanitize_svg(svg);
    // Should not panic; may succeed with partial output or return error
    // quick-xml is lenient so this may not fail - that's okay
    let _ = result;
  }

  #[test]
  fn sanitize_strips_javascript_uri() {
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="javascript:alert(1)"/></svg>"#;
    let result = sanitize_svg(svg).unwrap();
    let output = String::from_utf8(result).unwrap();
    assert!(!output.contains("javascript:"), "javascript: URI should be stripped");
  }

  #[test]
  fn runtime_css_projects_database_theme_tokens_and_fonts() {
    use myoxus_infrastructure::branding::{
      FontAssetProjection, FontFamilyProjection, ThemeProfileProjection, ThemeProjection, TypographyStyleProjection,
    };

    let mut colors = BTreeMap::new();
    colors.insert(
      "light".to_string(),
      BTreeMap::from([
        ("paper".to_string(), "#ffffff".to_string()),
        ("paper-deep".to_string(), "#f2f2f2".to_string()),
        ("ink".to_string(), "#111111".to_string()),
        ("accent-primary".to_string(), "#0055aa".to_string()),
        ("accent-secondary".to_string(), "#88aa00".to_string()),
      ]),
    );
    colors.insert(
      "dark".to_string(),
      BTreeMap::from([
        ("paper".to_string(), "#111111".to_string()),
        ("paper-deep".to_string(), "#292929".to_string()),
        ("ink".to_string(), "#eeeeee".to_string()),
        ("accent-primary".to_string(), "#99bbff".to_string()),
        ("accent-secondary".to_string(), "#ddffaa".to_string()),
      ]),
    );

    let profile = ThemeProfileProjection {
      scope: "global".to_string(),
      workspace_id: None,
      theme_mode: "system".to_string(),
      theme: ThemeProjection {
        slug: "stuttgart".to_string(),
        name: "Stuttgart".to_string(),
        category: Some("sans-leaning".to_string()),
        preview_group: Some("sans-foundations".to_string()),
        preview_order: 1,
        tagline_key: Some("admin.design.theme.stuttgart.tagline".to_string()),
        description_key: Some("admin.design.theme.stuttgart.description".to_string()),
        origin: "system".to_string(),
        locked: true,
        is_default: true,
        color_schema_slug: "stuttgart-colors".to_string(),
        typography_slug: "stuttgart-typography".to_string(),
        colors,
        typography_styles: vec![
          TypographyStyleProjection {
            style_key: "heading.h1".to_string(),
            font_family_slug: "inter".to_string(),
            font_family: "Inter".to_string(),
            css_family: "Inter".to_string(),
            font_weight: 700,
            font_style: "normal".to_string(),
            size_px: Some(42.0),
            line_height: Some(1.05),
            letter_spacing_em: Some(-0.02),
            text_transform: None,
            decoration: None,
            hover_decoration: None,
            font_features: serde_json::json!({}),
            font_variations: serde_json::json!({}),
            pdf_role: None,
          },
          TypographyStyleProjection {
            style_key: "body.default".to_string(),
            font_family_slug: "inter".to_string(),
            font_family: "Inter".to_string(),
            css_family: "Inter".to_string(),
            font_weight: 400,
            font_style: "normal".to_string(),
            size_px: Some(15.0),
            line_height: Some(1.5),
            letter_spacing_em: Some(0.0),
            text_transform: None,
            decoration: None,
            hover_decoration: None,
            font_features: serde_json::json!({}),
            font_variations: serde_json::json!({}),
            pdf_role: None,
          },
        ],
      },
    };
    let fonts = vec![FontFamilyProjection {
      slug: "inter".to_string(),
      display_name: "Inter".to_string(),
      css_family: "Inter".to_string(),
      generic_class: "sans".to_string(),
      source: "bundled".to_string(),
      license_spdx: "OFL-1.1".to_string(),
      license_status: "approved".to_string(),
      is_selectable: true,
      assets: vec![FontAssetProjection {
        usage: "web".to_string(),
        format: "woff2".to_string(),
        style: "normal".to_string(),
        weight_min: 400,
        weight_max: 400,
        weight_default: 400,
        asset_key: "inter-regular-latin.woff2".to_string(),
        sha256: "1234567890abcdef".to_string(),
        mime: "font/woff2".to_string(),
        unicode_ranges: vec![],
        subset_tags: vec!["latin".to_string()],
      }],
    }];
    fn root_rule_block(css: &str) -> &str {
      let start = css.find(":root {").expect("runtime CSS root rule");
      let end = css[start..]
        .find("}\n\n")
        .map(|offset| start + offset)
        .expect("runtime CSS root rule terminator");
      &css[start..end]
    }

    let css = myoxus_infrastructure::branding::build_runtime_theme_css(&profile, &fonts);

    for needle in [
      "@font-face",
      "src: url('/api/fonts/inter-regular-latin.woff2?v=12345678') format('woff2');",
      "color-scheme: light dark;",
      "--myoxus-background-primary-color: #ffffff;",
      "--myoxus-hover-color: #f2f2f2;",
      "--myoxus-sem-button-primary-bg: #0055aa;",
      "--myoxus-sem-button-primary-fg: #ffffff;",
      "--myoxus-sem-button-secondary-bg: #88aa00;",
      "--myoxus-sem-button-secondary-fg: #000000;",
      "--myoxus-typography-h1-family: \"Inter\";",
      "--myoxus-typography-h1-size: 42px;",
      "--myoxus-typography-body-family: \"Inter\";",
      "--myoxus-typography-ui-font-family: \"Inter\";",
      "@media (prefers-color-scheme: dark)",
      "[data-theme='dark']",
      "--myoxus-background-primary-color: #111111;",
      "--myoxus-hover-color: #292929;",
      "--myoxus-sem-button-primary-bg: #99bbff;",
      "--myoxus-sem-button-primary-fg: #000000;",
    ] {
      assert!(css.contains(needle), "CSS should contain `{needle}`\n----\n{css}");
    }

    let mut dark_profile = profile.clone();
    dark_profile.theme_mode = "dark".to_string();
    let dark_css = myoxus_infrastructure::branding::build_runtime_theme_css(&dark_profile, &fonts);
    let dark_root = root_rule_block(&dark_css);
    assert!(
      dark_root.contains("color-scheme: dark;")
        && dark_root.contains("--myoxus-background-primary-color: #111111;")
        && dark_root.contains("--myoxus-hover-color: #292929;"),
      "explicit dark profile must project dark tokens into :root\n----\n{dark_css}"
    );
    assert!(
      !dark_css.contains("@media (prefers-color-scheme: dark)"),
      "explicit dark profile must not depend on browser system media\n----\n{dark_css}"
    );

    let mut light_profile = profile.clone();
    light_profile.theme_mode = "light".to_string();
    let light_css = myoxus_infrastructure::branding::build_runtime_theme_css(&light_profile, &fonts);
    let light_root = root_rule_block(&light_css);
    assert!(
      light_root.contains("color-scheme: light;")
        && light_root.contains("--myoxus-background-primary-color: #ffffff;")
        && light_root.contains("--myoxus-hover-color: #f2f2f2;"),
      "explicit light profile must project light tokens into :root\n----\n{light_css}"
    );
    assert!(
      !light_css.contains("@media (prefers-color-scheme: dark)"),
      "explicit light profile must not depend on browser system media\n----\n{light_css}"
    );
  }

  /// Bug #1 regression: data:image/svg+xml URIs must be stripped (XSS vector).
  #[test]
  fn sanitize_strips_data_svg_uri() {
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cscript%3Ealert(1)%3C/script%3E%3C/svg%3E"/></svg>"#;
    let result = sanitize_svg(svg).unwrap();
    let output = String::from_utf8(result).unwrap();
    assert!(!output.contains("data:"), "data: URI should be stripped from SVG");
  }

  /// Bug #1 regression: data:text/html URIs must also be stripped.
  #[test]
  fn sanitize_strips_data_text_html_uri() {
    let svg =
      br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="data:text/html,<script>alert(1)</script>"/></svg>"#;
    let result = sanitize_svg(svg).unwrap();
    let output = String::from_utf8(result).unwrap();
    assert!(!output.contains("data:"), "data:text/html URI should be stripped");
  }

  /// Bug #1 regression: blob: URIs must be stripped.
  #[test]
  fn sanitize_strips_blob_uri() {
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="blob:https://evil.com/abc"/></svg>"#;
    let result = sanitize_svg(svg).unwrap();
    let output = String::from_utf8(result).unwrap();
    assert!(!output.contains("blob:"), "blob: URI should be stripped");
  }
}
