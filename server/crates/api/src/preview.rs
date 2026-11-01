// SPDX-License-Identifier: AGPL-3.0-or-later
//! Request-scoped admission, resource preparation and caching for Page previews.

use std::{
  collections::BTreeSet,
  sync::Arc,
  time::{Duration, Instant},
};

use moka::future::Cache;
use myoxus_application::doc::{
  DocPreviewSourceIdentity, DocumentPreviewSourceService, PreviewSourceError, PreviewSourceRequest, asset_revision,
};
use myoxus_public_render::{
  PreparedPreviewContext, PreviewFont, PreviewOutput, PreviewOutputFormat, PreviewPolicy, PreviewProjectionLimits,
  PreviewTheme, render_page_preview_pair,
};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::{config::PreviewConfig, state::ApiState};

// Invalidate prior artifacts when the renderer stack or resource policy changes.
pub const PREVIEW_RENDERER_VERSION: &str = "myoxus-page-preview-v9";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CachedPreviewFormat {
  Svg,
  Png,
}

#[derive(Debug, Clone, Copy)]
pub enum PreviewColorScheme {
  Light,
  Dark,
}

impl From<CachedPreviewFormat> for PreviewOutputFormat {
  fn from(value: CachedPreviewFormat) -> Self {
    match value {
      CachedPreviewFormat::Svg => Self::Svg,
      CachedPreviewFormat::Png => Self::Png,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PreviewCacheKey {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub revision: i64,
  pub metadata_revision: i64,
  pub title: String,
  pub public_mode: String,
  pub theme_revision: String,
  pub policy_revision: String,
  pub format: CachedPreviewFormat,
}

#[derive(Debug, Clone)]
pub struct CachedPreview {
  pub output: PreviewOutput,
  /// Includes absent/incomplete images so upload completion invalidates warm output.
  pub asset_revisions: Vec<(String, Option<String>)>,
  /// Representation digest is computed once, alongside the encoded artifact.
  pub etag: String,
  pub empty: bool,
}

#[derive(Clone)]
pub struct PreviewRuntime {
  pub output: Cache<PreviewCacheKey, Arc<CachedPreview>>,
  failures: Cache<PreviewCacheKey, PreviewOperationError>,
  prepared_fonts: Cache<String, Arc<PreparedContextEntry>>,
  request_admission: Arc<Semaphore>,
  global_render_admission: Arc<Semaphore>,
  actor_render_admission: Cache<Uuid, Arc<Semaphore>>,
  max_active_renders_per_actor: usize,
}

impl PreviewRuntime {
  pub fn new(config: &PreviewConfig) -> Self {
    let output_entries = config.output_cache_max_entries;
    let minimum_output_weight = config.output_cache_max_bytes.div_ceil(output_entries.max(1));
    let output = Cache::builder()
      .max_capacity(config.output_cache_max_bytes)
      .weigher(move |key: &PreviewCacheKey, value: &Arc<CachedPreview>| {
        let identity_bytes = key
          .title
          .len()
          .saturating_add(key.public_mode.len())
          .saturating_add(key.theme_revision.len())
          .saturating_add(key.policy_revision.len())
          .saturating_add(
            value
              .asset_revisions
              .iter()
              .map(|(source, revision)| source.len().saturating_add(revision.as_ref().map_or(0, String::len)))
              .sum(),
          );
        let weight = (value.output.bytes.len() as u64)
          .saturating_add(identity_bytes as u64)
          .saturating_add(value.etag.len() as u64)
          .max(minimum_output_weight);
        u32::try_from(weight).unwrap_or(u32::MAX)
      })
      .time_to_live(Duration::from_secs(config.output_cache_ttl_seconds))
      .build();
    let minimum_font_weight = config
      .prepared_font_cache_max_bytes
      .div_ceil(config.prepared_font_cache_max_entries.max(1));
    let prepared_fonts = Cache::builder()
      .max_capacity(config.prepared_font_cache_max_bytes)
      .weigher(move |_key: &String, value: &Arc<PreparedContextEntry>| {
        u32::try_from(value.weight_bytes.max(minimum_font_weight)).unwrap_or(u32::MAX)
      })
      .time_to_live(Duration::from_secs(config.prepared_font_cache_ttl_seconds))
      .build();
    let failures = Cache::builder()
      .max_capacity(output_entries.max(1))
      .time_to_live(Duration::from_secs(config.failure_expiry_seconds))
      .build();
    Self {
      output,
      failures,
      prepared_fonts,
      request_admission: Arc::new(Semaphore::new(config.max_in_flight_requests)),
      global_render_admission: Arc::new(Semaphore::new(config.max_active_global_renders)),
      actor_render_admission: Cache::builder()
        .max_capacity(output_entries.max(1))
        .time_to_idle(Duration::from_secs(config.output_cache_ttl_seconds))
        .build(),
      max_active_renders_per_actor: config.max_active_renders_per_actor,
    }
  }

  pub fn try_admit_request(&self) -> Result<tokio::sync::OwnedSemaphorePermit, PreviewOperationError> {
    self
      .request_admission
      .clone()
      .try_acquire_owned()
      .map_err(|_| PreviewOperationError::Busy)
  }

  async fn render_permits(
    &self,
    actor_id: Uuid,
  ) -> Result<(tokio::sync::OwnedSemaphorePermit, tokio::sync::OwnedSemaphorePermit), PreviewOperationError> {
    let global = self
      .global_render_admission
      .clone()
      .try_acquire_owned()
      .map_err(|_| PreviewOperationError::Busy)?;
    let actor = self
      .actor_render_admission
      .get_with(actor_id, async {
        Arc::new(Semaphore::new(self.max_active_renders_per_actor))
      })
      .await
      .try_acquire_owned()
      .map_err(|_| PreviewOperationError::Busy)?;
    Ok((global, actor))
  }

  async fn prepared_context(
    &self,
    state: &ApiState,
    resources: ThemeDefinition,
    policy: &PreviewPolicy,
  ) -> Result<(String, Arc<PreparedPreviewContext>), PreviewOperationError> {
    let revision = resources.revision.clone();
    let cache_key = format!("{}:{}", revision, policy.max_font_bytes);
    let blob_store = state.pdf_blob_store();
    let max_font_bytes = policy.max_font_bytes;
    let context = self
      .prepared_fonts
      .try_get_with(cache_key, async move {
        let mut fonts = Vec::new();
        let mut weight_bytes = 0u64;
        for asset in resources.font_assets {
          let bytes = load_font_bytes(blob_store.as_ref(), &asset).await?;
          weight_bytes = weight_bytes.saturating_add(bytes.len() as u64);
          if weight_bytes > max_font_bytes as u64 {
            return Err(PreviewOperationError::Limit);
          }
          fonts.push(PreviewFont { bytes });
        }
        PreparedPreviewContext::prepare(resources.revision, resources.theme, fonts, policy)
          .map(|context| Arc::new(PreparedContextEntry { context, weight_bytes }))
          .map_err(|error| PreviewOperationError::Unavailable(error.to_string()))
      })
      .await
      .map_err(|error| (*error).clone())?;
    Ok((revision, Arc::new(context.context.clone())))
  }

  pub async fn render(
    &self,
    actor_id: Uuid,
    state: ApiState,
    workspace_id: Uuid,
    doc_id: Uuid,
    identity: DocPreviewSourceIdentity,
    config: PreviewConfig,
    format: CachedPreviewFormat,
    color_scheme: Option<PreviewColorScheme>,
  ) -> Result<(Arc<CachedPreview>, bool, PreviewCacheKey), PreviewOperationError> {
    let policy = preview_policy(&config);
    let theme = resolve_theme_definition(&state, workspace_id, color_scheme).await?;
    let key = PreviewCacheKey {
      workspace_id,
      doc_id,
      revision: identity.revision,
      metadata_revision: identity.metadata_revision,
      title: identity.title.clone(),
      public_mode: identity.public_mode.clone(),
      theme_revision: theme.revision.clone(),
      policy_revision: preview_policy_revision(&config),
      format,
    };
    let runtime = self.clone();
    let loader_key = key.clone();
    let render_state = state.clone();
    if let Some(failure) = self.failures.get(&key).await {
      return Err(failure);
    }
    if let Some(result) = self.output.get(&key).await {
      self.validate_cached_assets(&state, workspace_id, &key, &result).await?;
      return Ok((result, true, key));
    }
    let result = self
      .output
      .entry(key.clone())
      .or_try_insert_with(async move {
        let operation_started = Instant::now();
        let (global_permit, actor_permit) = runtime.render_permits(actor_id).await?;
        let admitted_at = Instant::now();
        let (_theme_revision, context) = runtime.prepared_context(&render_state, theme, &policy).await?;
        let prepared_at = Instant::now();
        let service = DocumentPreviewSourceService::new(render_state.doc().load.clone(), render_state.blob_service());
        let source = service
          .prepare(PreviewSourceRequest {
            workspace_id: loader_key.workspace_id,
            doc_id: loader_key.doc_id,
            identity: identity.clone(),
            limits: policy.projection,
            max_media_bytes: policy.max_media_bytes,
            max_svg_input_bytes: policy.max_svg_input_bytes,
          })
          .await
          .map_err(PreviewOperationError::from)?;
        let source_prepared_at = Instant::now();
        let asset_revisions = myoxus_public_render::resolve_asset_candidates(&source.ir)
          .into_iter()
          .map(|candidate| {
            let revision = source
              .assets
              .iter()
              .find(|asset| asset.source == candidate.blob_key)
              .map(|asset| asset.revision.clone());
            (candidate.blob_key, revision)
          })
          .collect();
        let empty = source.empty;
        let include_png = format == CachedPreviewFormat::Png;
        let mut render = tokio::task::spawn_blocking(move || {
          let _permits = (global_permit, actor_permit);
          render_page_preview_pair(&source.ir, &source.assets, &context, &policy, include_png)
        });
        let pair = match tokio::time::timeout(Duration::from_millis(config.render_timeout_ms), &mut render).await {
          Ok(result) => result,
          Err(_) => {
            // `spawn_blocking` cannot be cancelled once running. Keep this
            // cache key and its permits occupied until CPU work really ends,
            // preventing a timed-out request from spawning replacement work.
            let _ = render.await;
            return Err(PreviewOperationError::Timeout);
          }
        }
        .map_err(|_| PreviewOperationError::Unavailable("preview render worker failed".to_string()))?
        .map_err(|error| PreviewOperationError::from_render(&error))?;
        let output = match format {
          CachedPreviewFormat::Svg => pair.svg,
          CachedPreviewFormat::Png => pair.png.ok_or(PreviewOperationError::Limit)?,
        };
        tracing::debug!(
          %workspace_id,
          %doc_id,
          ?format,
          admission_wait_ms = admitted_at.duration_since(operation_started).as_millis() as u64,
          resource_prepare_ms = prepared_at.duration_since(admitted_at).as_millis() as u64,
          source_prepare_ms = source_prepared_at.duration_since(prepared_at).as_millis() as u64,
          render_ms = source_prepared_at.elapsed().as_millis() as u64,
          output_bytes = output.bytes.len(),
          "generated private document preview"
        );
        // Transport compression may change encoded bytes; GET revalidation
        // compares the underlying representation across content codings.
        let etag = format!("W/\"{}\"", hex::encode(Sha256::digest(&output.bytes)));
        Ok(Arc::new(CachedPreview {
          etag,
          output,
          asset_revisions,
          empty,
        }))
      })
      .await;
    let (result, cache_hit) = match result {
      Ok(entry) => {
        let cache_hit = !entry.is_fresh();
        (entry.into_value(), cache_hit)
      }
      Err(error) => {
        let error = (*error).clone();
        // Admission pressure belongs to the current actor/request, not to the
        // document cache key. Caching it defeats Retry-After even after permits
        // are free, and can deny another authorized actor the same document.
        if !matches!(error, PreviewOperationError::Stale | PreviewOperationError::Busy) {
          self.failures.insert(key.clone(), error.clone()).await;
        }
        return Err(error);
      }
    };
    self.validate_cached_assets(&state, workspace_id, &key, &result).await?;
    Ok((result, cache_hit, key))
  }

  /// Revalidate every mutable resource after the final ACL/source check and as
  /// close as possible to response delivery. This prevents a cached image or
  /// prepared theme that changed during the last authorization read from being
  /// served as current.
  pub async fn validate_delivery(
    &self,
    state: &ApiState,
    workspace_id: Uuid,
    key: &PreviewCacheKey,
    result: &CachedPreview,
    color_scheme: Option<PreviewColorScheme>,
  ) -> Result<(), PreviewOperationError> {
    self.validate_cached_assets(state, workspace_id, key, result).await?;
    let theme = resolve_theme_definition(state, workspace_id, color_scheme).await?;
    if theme.revision != key.theme_revision {
      self.output.invalidate(key).await;
      return Err(PreviewOperationError::Stale);
    }
    Ok(())
  }

  async fn validate_cached_assets(
    &self,
    state: &ApiState,
    workspace_id: Uuid,
    key: &PreviewCacheKey,
    result: &CachedPreview,
  ) -> Result<(), PreviewOperationError> {
    for (source, expected_revision) in &result.asset_revisions {
      let revision = state
        .blob()
        .get_blob_metadata(workspace_id, source)
        .await
        .map_err(|error| PreviewOperationError::Unavailable(error.to_string()))?
        .filter(|metadata| {
          metadata.deleted_at.is_none()
            && metadata.status == myoxus_application::ports::blob::BlobStatus::Completed
            && metadata.mime.starts_with("image/")
        })
        .map(|metadata| asset_revision(&metadata));
      if revision != *expected_revision {
        self.output.invalidate(key).await;
        return Err(PreviewOperationError::Stale);
      }
    }
    Ok(())
  }
}

async fn load_font_bytes(
  blob_store: Option<&Arc<myoxus_infrastructure::pdf_export::PdfBlobStore>>,
  asset: &myoxus_domain::repositories::PdfThemeFontAsset,
) -> Result<Vec<u8>, PreviewOperationError> {
  let bytes = if !asset.asset_key.contains('/')
    && !asset.asset_key.contains('\\')
    && asset.asset_key != "."
    && asset.asset_key != ".."
  {
    tokio::fs::read(bundled_static_fonts_path().join(&asset.asset_key))
      .await
      .map_err(|error| PreviewOperationError::Unavailable(error.to_string()))?
  } else {
    blob_store
      .ok_or_else(|| PreviewOperationError::Unavailable("font blob store is not configured".to_string()))?
      .get_template_file(&asset.asset_key)
      .await
      .map_err(|error| PreviewOperationError::Unavailable(error.to_string()))?
  };
  if hex::encode(Sha256::digest(&bytes)) != asset.sha256 {
    return Err(PreviewOperationError::Unavailable(
      "font asset hash mismatch".to_string(),
    ));
  }
  Ok(bytes)
}

fn bundled_static_fonts_path() -> std::path::PathBuf {
  let relative = std::path::PathBuf::from("static/fonts");
  if relative.is_dir() {
    return relative;
  }
  std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("../..")
    .join(relative)
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum PreviewOperationError {
  #[error("preview capacity is busy")]
  Busy,
  #[error("preview operation timed out")]
  Timeout,
  #[error("preview source changed")]
  Stale,
  #[error("preview source is unsupported")]
  Unsupported,
  #[error("preview source exceeds configured limits")]
  Limit,
  #[error("preview source is invalid")]
  Invalid,
  #[error("preview dependency is unavailable: {0}")]
  Unavailable(String),
}

impl PreviewOperationError {
  fn from_render(error: &myoxus_public_render::PreviewRenderError) -> Self {
    use myoxus_public_render::PreviewRenderError;
    match error {
      PreviewRenderError::UnsupportedMode => Self::Unsupported,
      PreviewRenderError::FontLimit | PreviewRenderError::OutputLimit | PreviewRenderError::PngPixelLimit => {
        Self::Limit
      }
      PreviewRenderError::InvalidTheme
      | PreviewRenderError::InvalidFont
      | PreviewRenderError::MissingFontFamily(_)
      | PreviewRenderError::Svg(_)
      | PreviewRenderError::Png(_) => Self::Invalid,
    }
  }
}

impl From<PreviewSourceError> for PreviewOperationError {
  fn from(value: PreviewSourceError) -> Self {
    match value {
      PreviewSourceError::Stale => Self::Stale,
      PreviewSourceError::Limit => Self::Limit,
      PreviewSourceError::Unsupported => Self::Unsupported,
      PreviewSourceError::Invalid => Self::Invalid,
      PreviewSourceError::Unavailable => Self::Unavailable("source load failed".to_string()),
    }
  }
}

struct ThemeDefinition {
  revision: String,
  theme: PreviewTheme,
  font_assets: Vec<myoxus_domain::repositories::PdfThemeFontAsset>,
}

struct PreparedContextEntry {
  context: PreparedPreviewContext,
  weight_bytes: u64,
}

async fn resolve_theme_definition(
  state: &ApiState,
  workspace_id: Uuid,
  color_scheme: Option<PreviewColorScheme>,
) -> Result<ThemeDefinition, PreviewOperationError> {
  let pool = state
    .metrics_pool()
    .ok_or_else(|| PreviewOperationError::Unavailable("database pool is not configured".to_string()))?;
  let profile = myoxus_infrastructure::branding::load_effective_theme_profile(&pool, Some(workspace_id))
    .await
    .map_err(|error| PreviewOperationError::Unavailable(error.to_string()))?;
  // Hydrated clients resolve light/dark just like the runtime CSS data-theme
  // selectors. Only the mode is a hint; palette and font ownership stay here.
  let mode = match color_scheme {
    Some(PreviewColorScheme::Light) => "light",
    Some(PreviewColorScheme::Dark) => "dark",
    None if profile.theme_mode == "dark" => "dark",
    None => "light",
  };
  let colors = profile
    .theme
    .colors
    .get(mode)
    .ok_or_else(|| PreviewOperationError::Unavailable("effective theme colors are incomplete".to_string()))?;
  let color = |key: &str| {
    colors
      .get(key)
      .cloned()
      .ok_or_else(|| PreviewOperationError::Unavailable(format!("effective theme color `{key}` is missing")))
  };
  let font_repo = state
    .pdf_font_repo()
    .ok_or_else(|| PreviewOperationError::Unavailable("font repository is not configured".to_string()))?;
  let mut revision = Sha256::new();
  revision.update(PREVIEW_RENDERER_VERSION.as_bytes());
  revision.update(profile.theme.slug.as_bytes());
  revision.update(mode.as_bytes());
  for (key, value) in colors {
    revision.update(key.as_bytes());
    revision.update(value.as_bytes());
  }
  let mut font_assets = Vec::new();
  let mut seen = BTreeSet::new();
  let mut families = Vec::new();
  for role in ["body", "heading", "mono"] {
    let style = profile
      .theme
      .typography_styles
      .iter()
      .find(|style| style.pdf_role.as_deref() == Some(role))
      .ok_or_else(|| PreviewOperationError::Unavailable(format!("theme typography role `{role}` is missing")))?;
    let asset = font_repo
      .resolve_theme_font_asset(&style.font_family_slug)
      .await
      .map_err(|error| PreviewOperationError::Unavailable(error.to_string()))?
      .ok_or_else(|| PreviewOperationError::Unavailable(format!("font asset for `{role}` is missing")))?;
    revision.update(role.as_bytes());
    revision.update(asset.sha256.as_bytes());
    families.push(asset.family.clone());
    if seen.insert(asset.sha256.clone()) {
      font_assets.push(asset);
    }
  }
  Ok(ThemeDefinition {
    revision: hex::encode(revision.finalize()),
    theme: PreviewTheme {
      background: color("paper")?,
      surface: color("background-code-block")?,
      text: color("ink")?,
      muted: color("ink-soft")?,
      border: color("rule")?,
      accent: color("accent-primary")?,
      body_font_family: families[0].clone(),
      heading_font_family: families[1].clone(),
      mono_font_family: families[2].clone(),
    },
    font_assets,
  })
}

pub fn preview_policy(config: &PreviewConfig) -> PreviewPolicy {
  PreviewPolicy {
    projection: PreviewProjectionLimits {
      max_input_bytes: config.max_input_bytes,
      max_source_blocks: config.max_source_blocks,
      max_projected_blocks: config.max_projected_blocks,
      max_text_chars: config.max_text_chars,
      max_depth: config.max_depth,
      max_table_rows: config.max_table_rows,
      max_table_columns: config.max_table_columns,
      max_visuals: config.max_visuals,
    },
    max_font_bytes: config.max_font_bytes,
    max_media_bytes: config.max_media_bytes,
    max_decoded_image_pixels: config.max_decoded_image_pixels,
    max_svg_input_bytes: config.max_svg_input_bytes,
    max_mermaid_source_bytes: config.max_mermaid_source_bytes,
    max_mermaid_elements: config.max_mermaid_elements,
    max_outlined_paths: config.max_outlined_paths,
    max_output_svg_bytes: config.max_output_svg_bytes,
    max_png_pixels: config.max_png_pixels,
  }
}

pub fn preview_policy_revision(config: &PreviewConfig) -> String {
  let encoded = serde_json::to_vec(config).expect("typed PreviewConfig must serialize");
  hex::encode(Sha256::digest(encoded))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn runtime_enforces_request_and_per_actor_admission() {
    let config = PreviewConfig {
      max_in_flight_requests: 1,
      max_active_global_renders: 2,
      max_active_renders_per_actor: 1,
      ..PreviewConfig::default()
    };
    let runtime = PreviewRuntime::new(&config);

    let request = runtime.try_admit_request().expect("first request admitted");
    assert!(matches!(runtime.try_admit_request(), Err(PreviewOperationError::Busy)));
    drop(request);
    drop(runtime.try_admit_request().expect("released request capacity reused"));

    let actor = Uuid::new_v4();
    let permits = runtime
      .render_permits(actor)
      .await
      .expect("first actor render admitted");
    assert!(matches!(
      runtime.render_permits(actor).await,
      Err(PreviewOperationError::Busy)
    ));
    drop(
      runtime
        .render_permits(Uuid::new_v4())
        .await
        .expect("another actor can use remaining global capacity"),
    );
    drop(permits);
  }
}
