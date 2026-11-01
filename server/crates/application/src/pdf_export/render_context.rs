// SPDX-License-Identifier: AGPL-3.0-or-later
//! L1/L2/L3 render-context builder for PDF-Export V2 (`P-PDF-TPL-12`).
//!
//! The render pipeline consumes a single [`RenderContext`] struct that
//! collapses every input the renderer needs:
//!
//! | Field          | Layer | Source                                  |
//! |----------------|-------|-----------------------------------------|
//! | `template`     | L2    | `PdfTemplateRegistry::load`             |
//! | `brand`        | L1    | Document branding + PDF settings adapter |
//! | `inputs`       | L3    | Per-render mutation arguments           |
//! | `doc_metadata` | n/a   | Doc + DocHistory + UserRepository       |
//! | `locale`       | mix   | Resolver: input → PDF settings → server-default |
//! | `translations` | n/a   | `i18n/<locale>.json` from the bundle    |
//! | `color_profile`| L1    | PDF settings override or server default |
//! | `image_quality`| L1/L3 | PDF settings default or per-render override |
//! | `dpi`          | const | Resolved from image_quality tier        |
//!
//! See `docs/dev/server/pdf-export-v2-architecture.md` (the L1/L2/L3 model)
//! for the conceptual layer split. This module is the place that resolves
//! every layer into a single Send-able struct so the worker doesn't need
//! to round-trip through repos during the render — by the time
//! `render_to_pdf` is called every input is already in memory.
//!
//! ## Why this is a pure-application module
//!
//! It depends only on the domain layer (entities + repository traits) and
//! `myoxus_pdf_export` (LoadedTemplate). No SQL, no HTTP, no async-graphql.
//! This keeps the layering clean: the GraphQL mutation calls
//! `RenderContextBuilder::build(...)` and hands the result to the worker;
//! tests can build a `RenderContext` from in-memory fixtures without
//! standing up a database.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{debug, instrument, trace, warn};
use uuid::Uuid;

use myoxus_domain::entities::{Doc, PdfWorkspaceBrandAsset};
use myoxus_domain::ids::DocId;
use myoxus_domain::pdf_template_manifest::PdfTemplateManifest;
use myoxus_domain::repositories::{DocRepository, PdfWorkspaceBrandAssetRepository, RepositoryError, UserRepository};
use myoxus_pdf_export::template_v2::{LoadedTemplate, PdfTemplateRegistry, RegistryError};

// ─── Public types ────────────────────────────────────────────────────────────

/// Image quality tier exposed to the renderer. Mirrors the strings stored in
/// `pdf_export_settings.default_image_quality`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageQuality {
  Low,
  Med,
  High,
  Lossless,
}

impl ImageQuality {
  /// Best-effort decode of the L1 column string. `None` returns `High`.
  pub fn from_str_or_default(value: Option<&str>) -> Self {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
      Some("low") => Self::Low,
      Some("high") => Self::High,
      Some("lossless") => Self::Lossless,
      Some("med") => Self::Med,
      _ => Self::High,
    }
  }

  /// Render DPI mapped from the quality tier. `Lossless` keeps the source
  /// resolution; the others target raster output bounds.
  pub fn dpi(self) -> u32 {
    match self {
      Self::Low => 96,
      Self::Med => 150,
      Self::High => 300,
      Self::Lossless => 600,
    }
  }
}

/// Color profile family exposed to the renderer. Mirrors the effective ICC
/// profile selected by `pdf_export_settings.default_color_profile_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorProfile {
  Srgb,
  CmykFogra39,
  CmykSwop,
}

impl ColorProfile {
  /// Decode the L1 column string with the canonical fallback (`sRGB`).
  pub fn from_str_or_default(value: Option<&str>) -> Self {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
      Some("cmyk_fogra39") => Self::CmykFogra39,
      Some("cmyk_swop") => Self::CmykSwop,
      _ => Self::Srgb,
    }
  }

  /// Stable string for round-trips (matches the `default_color_profile` enum).
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::Srgb => "sRGB",
      Self::CmykFogra39 => "CMYK_FOGRA39",
      Self::CmykSwop => "CMYK_SWOP",
    }
  }
}

/// L3 per-render inputs collected from the `exportPdf` mutation.
///
/// Most fields are optional because the manifest's L2 capability matrix
/// declares which switches a given template actually accepts; the validator
/// that runs before this struct is built rejects inputs that target an
/// off-capability.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PdfExportInputV2 {
  /// Workspace selected from the export picker.
  pub workspace_id: Uuid,
  /// The document being exported.
  pub doc_id: DocId,
  /// Slug or UUID of the template chosen by the user; resolved to a UUID
  /// before the registry lookup.
  pub template_id: Uuid,
  /// Override locale (BCP-47). When `None` the locale resolver falls
  /// through to the brand default and finally the server default.
  pub locale: Option<String>,
  /// Per-render override for the paper size (e.g. `"A4"`, `"Letter"`).
  pub paper_size: Option<String>,
  /// Per-render override for image quality (template default otherwise).
  pub image_quality: Option<ImageQuality>,
  /// Optional PDF standards profile (`standard`, `pdfa-1b`, `pdfa-2b`, `pdfa-2u`,
  /// `pdfa-3b`, `pdfua-1`). This is a renderer/output contract, not a
  /// template capability, so it follows the same L1 override model as paper
  /// size and image quality.
  pub compliance_profile: Option<String>,
  /// Cover-page override; the capability default is not an enable/disable gate.
  pub cover_page: Option<bool>,
  /// TOC behavior when `capabilities.tocBehavior` is on.
  pub toc_behavior: Option<String>,
  /// Footer layout from the selected template capability; absence keeps its default.
  pub footer_style: Option<String>,
  /// Page-number format independent of the selected footer layout.
  pub page_numbering: Option<String>,
  /// Color treatment applied to the effective document palette.
  pub color_variant: Option<String>,
  /// Confidentiality watermark label (must be in the manifest's allowed set).
  pub confidentiality_label: Option<String>,
  /// Free-form per-template inputs (e.g. report cover-title, letter
  /// recipient block) — already validated against the manifest's
  /// `inputs_schema`.
  #[serde(default)]
  pub typed_inputs: serde_json::Value,
}

/// Document-level metadata resolved from Yjs / DocHistory + user lookup.
///
/// The renderer puts these into `#let doc-title`/`#let doc-author` /
/// `#let doc-date` bindings before the template is included.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocMetadata {
  pub doc_id: Uuid,
  pub title: String,
  /// One entry per distinct contributor in the doc's history, oldest-first.
  pub authors: Vec<DocAuthor>,
  pub created_at: Option<DateTime<Utc>>,
  pub updated_at: DateTime<Utc>,
  /// H1 / H2 strings for cover-page outline / TOC seeding. `None` while the
  /// V1 IR pipeline is in charge — the V2 builder fills this from
  /// `IrDocument` once the renderer is wired through the registry.
  pub chapter_titles: Option<Vec<String>>,
}

/// One contributor to a document, snapshot-captured at render time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocAuthor {
  pub user_id: Uuid,
  pub display_name: String,
  pub email: String,
}

/// A fully-resolved render context. Send-able and serialisable so the
/// worker can pass it across thread boundaries without re-fetching state.
#[derive(Debug, Clone)]
pub struct RenderContext {
  pub template: LoadedTemplate,
  pub brand: PdfWorkspaceBrandAsset,
  pub inputs: PdfExportInputV2,
  pub doc_metadata: DocMetadata,
  pub locale: ResolvedLocale,
  pub translations: HashMap<String, String>,
  pub color_profile: ColorProfile,
  pub image_quality: ImageQuality,
  pub dpi: u32,
}

/// Result of the locale-fallback resolver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedLocale {
  /// The locale that ended up active after the fallback chain.
  pub effective: String,
  /// Where the resolver ultimately picked the value from.
  pub source: LocaleSource,
}

/// Audit trail showing which layer won the locale resolution race.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LocaleSource {
  /// `inputs.locale` was set and resolved against the manifest.
  Input,
  /// Fell through to `pdf_export_settings.default_locale`.
  PdfSettings,
  /// Fell through to the server-wide default (last layer).
  ServerDefault,
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/// Build-time errors surfaced by the [`RenderContextBuilder`].
#[derive(Debug, Error)]
pub enum RenderContextError {
  #[error("template not found: {0}")]
  TemplateNotFound(Uuid),

  #[error("template registry failure: {0}")]
  Registry(String),

  #[error("brand assets storage failure: {0}")]
  Brand(String),

  #[error("doc not found: {0}")]
  DocNotFound(Uuid),

  #[error("doc lookup failed: {0}")]
  Doc(String),

  #[error("user lookup failed: {0}")]
  User(String),

  #[error("manifest is malformed: {0}")]
  ManifestInvalid(String),

  #[error("requested locale `{0}` is not declared by the template")]
  LocaleNotDeclared(String),

  #[error("translations bundle for locale `{0}` is malformed JSON: {1}")]
  TranslationsInvalid(String, String),
}

impl From<RegistryError> for RenderContextError {
  fn from(err: RegistryError) -> Self {
    match err {
      RegistryError::NotFound(id) => Self::TemplateNotFound(id),
      other => Self::Registry(other.to_string()),
    }
  }
}

impl From<RepositoryError> for RenderContextError {
  fn from(err: RepositoryError) -> Self {
    Self::Brand(err.to_string())
  }
}

// ─── Builder ─────────────────────────────────────────────────────────────────

/// Resolves [`RenderContext`] from the four storage ports involved in the L1
/// and document layers. Cheap to clone — every dep is an `Arc`.
#[derive(Clone)]
pub struct RenderContextBuilder {
  registry: Arc<dyn PdfTemplateRegistry>,
  brand: Arc<dyn PdfWorkspaceBrandAssetRepository>,
  docs: Arc<dyn DocRepository>,
  users: Arc<dyn UserRepository>,
  /// Server-wide default locale (e.g. `"en"`). Used as the bottom of the
  /// locale fallback chain.
  server_default_locale: String,
  /// Server-wide default color profile (e.g. `"sRGB"`).
  server_default_color_profile: String,
}

impl RenderContextBuilder {
  /// Construct a builder bound to the given storage ports.
  ///
  /// `server_default_locale` and `server_default_color_profile` come from
  /// the `pdf_export.*` config block.
  pub fn new(
    registry: Arc<dyn PdfTemplateRegistry>,
    brand: Arc<dyn PdfWorkspaceBrandAssetRepository>,
    docs: Arc<dyn DocRepository>,
    users: Arc<dyn UserRepository>,
    server_default_locale: impl Into<String>,
    server_default_color_profile: impl Into<String>,
  ) -> Self {
    Self {
      registry,
      brand,
      docs,
      users,
      server_default_locale: server_default_locale.into(),
      server_default_color_profile: server_default_color_profile.into(),
    }
  }

  /// Resolve the full render context for a given mutation input.
  ///
  /// Order of operations (each step short-circuits on error):
  ///   1. Load the template through the V2 registry.
  ///   2. Read or default-fill the brand-asset row.
  ///   3. Resolve the doc + its metadata via [`resolve_doc_metadata`].
  ///   4. Run the locale-fallback resolver.
  ///   5. Load the matching `i18n/<locale>.json` from the bundle (with
  ///      fallback to less specific locales — `de-AT` → `de` → `en`).
  ///   6. Map the brand color-profile + image-quality strings to the
  ///      typed enums and derive DPI.
  #[instrument(skip(self, inputs), fields(template_id = %inputs.template_id, doc_id = %inputs.doc_id), err)]
  pub async fn build(&self, inputs: PdfExportInputV2) -> Result<RenderContext, RenderContextError> {
    debug!("RenderContextBuilder::build start");

    let template = self.registry.load(inputs.template_id).await?;

    let brand = self
      .brand
      .get(inputs.workspace_id)
      .await?
      .unwrap_or_else(|| Self::default_brand(inputs.workspace_id));

    let doc_metadata = self.resolve_doc_metadata(&inputs.doc_id).await?;

    let locale = resolve_locale(
      inputs.locale.as_deref(),
      brand.default_locale.as_deref(),
      &self.server_default_locale,
      &template.manifest,
    )?;

    let translations = load_translations(&template, &locale.effective)?;

    let color_profile = ColorProfile::from_str_or_default(
      brand
        .default_color_profile
        .as_deref()
        .or(Some(self.server_default_color_profile.as_str())),
    );

    let image_quality = inputs
      .image_quality
      .unwrap_or_else(|| ImageQuality::from_str_or_default(brand.default_image_quality.as_deref()));
    let dpi = image_quality.dpi();

    debug!(
      template = %template.slug,
      locale = %locale.effective,
      locale_source = ?locale.source,
      color_profile = ?color_profile,
      image_quality = ?image_quality,
      dpi,
      translations = translations.len(),
      "RenderContextBuilder::build done"
    );

    Ok(RenderContext {
      template,
      brand,
      inputs,
      doc_metadata,
      locale,
      translations,
      color_profile,
      image_quality,
      dpi,
    })
  }

  /// Resolve the document title, contributors, and timestamps.
  ///
  /// Contributors are derived from `doc.created_by` + `doc.updated_by` —
  /// the only author info the relational schema retains today. Pulling
  /// distinct contributors from the Yjs `DocHistory` snapshot bytes would
  /// require CRDT introspection and is left for a future delivery package.
  /// (`P-PDF-TPL-AUTHOR-FROM-YJS`).
  ///
  /// Resulting list is oldest-first: `created_by` precedes `updated_by`,
  /// duplicates are deduped.
  #[instrument(skip(self), fields(doc_id = %doc_id), err)]
  async fn resolve_doc_metadata(&self, doc_id: &DocId) -> Result<DocMetadata, RenderContextError> {
    let doc: Doc = self
      .docs
      .get_doc(*doc_id)
      .await
      .map_err(|e| RenderContextError::Doc(e.to_string()))?
      .ok_or(RenderContextError::DocNotFound(*doc_id))?;

    let mut seen: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
    let mut authors: Vec<DocAuthor> = Vec::new();
    for uid in [doc.created_by, doc.updated_by].into_iter().flatten() {
      if !seen.insert(uid) {
        continue;
      }
      match self.users.get_user_by_id(uid).await {
        Ok(Some(user)) => authors.push(DocAuthor {
          user_id: uid,
          display_name: if user.name.trim().is_empty() {
            user.email.clone()
          } else {
            user.name.clone()
          },
          email: user.email,
        }),
        Ok(None) => {
          trace!(user_id = %uid, "doc author user not found; skipping");
        }
        Err(err) => {
          warn!(user_id = %uid, error = %err, "doc author lookup failed; skipping");
        }
      }
    }

    Ok(DocMetadata {
      doc_id: *doc_id,
      title: doc.title.clone(),
      authors,
      created_at: Some(doc.created_at),
      updated_at: doc.updated_at,
      chapter_titles: None,
    })
  }

  /// A brand row populated entirely with column defaults. Used when no
  /// admin has yet configured the workspace — the renderer must always
  /// see a valid row.
  fn default_brand(workspace_id: Uuid) -> PdfWorkspaceBrandAsset {
    PdfWorkspaceBrandAsset {
      workspace_id,
      logo_large_blob: None,
      logo_large_sha256: None,
      logo_small_blob: None,
      logo_small_sha256: None,
      company_name: None,
      legal_text: None,
      footer_text: None,
      color_policy: "theme_palette".to_owned(),
      color_palette_key: Some("balanced".to_owned()),
      brand_color_primary: None,
      brand_color_accent: None,
      brand_color_rule: None,
      brand_color_text: None,
      brand_color_background: None,
      default_paper_size: None,
      default_locale: None,
      default_color_profile: None,
      default_image_quality: None,
      ligatures_enabled: true,
      default_template_id: None,
      updated_at: Utc::now(),
      // The "system" sentinel — admin-side mutations always carry a real
      // user id. Reading the default row never goes back into the DB so
      // this never round-trips through the `updated_by` FK.
      updated_by: Uuid::nil(),
    }
  }
}

// ─── Locale resolver ─────────────────────────────────────────────────────────

/// Resolve the effective locale by walking the fallback chain
/// `input → PDF settings → server-default`, then validating the result against
/// the template's `capabilities.language.values` set.
///
/// Returns the **first locale in the chain that the template declares
/// support for**. If the manifest declares neither the chosen locale nor
/// the server default, [`RenderContextError::LocaleNotDeclared`] is
/// returned — better to fail loudly than silently render in a language
/// the template author never approved.
pub fn resolve_locale(
  input: Option<&str>,
  pdf_settings: Option<&str>,
  server: &str,
  manifest: &PdfTemplateManifest,
) -> Result<ResolvedLocale, RenderContextError> {
  let declared: &[String] = &manifest.capabilities.language.values;
  let candidates: [(Option<&str>, LocaleSource); 3] = [
    (input, LocaleSource::Input),
    (pdf_settings, LocaleSource::PdfSettings),
    (Some(server), LocaleSource::ServerDefault),
  ];

  for (value, source) in candidates {
    let Some(raw) = value else { continue };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
      continue;
    }
    if declared.iter().any(|v| v == trimmed) {
      trace!(locale = trimmed, source = ?source, "locale resolved");
      return Ok(ResolvedLocale {
        effective: trimmed.to_owned(),
        source,
      });
    }
    // Narrow → broad fallback within a single chain entry. `de-AT` should
    // also accept `de` if the template declares the broader form.
    if let Some(base) = trimmed.split('-').next()
      && base != trimmed
      && declared.iter().any(|v| v == base)
    {
      trace!(locale = base, requested = trimmed, source = ?source, "locale resolved via broader fallback");
      return Ok(ResolvedLocale {
        effective: base.to_owned(),
        source,
      });
    }
  }

  warn!(
    requested_input = ?input,
    requested_pdf_settings = ?pdf_settings,
    requested_server = server,
    declared = ?declared,
    "no candidate locale matched the template's declared values"
  );
  Err(RenderContextError::LocaleNotDeclared(
    input.or(pdf_settings).unwrap_or(server).to_owned(),
  ))
}

// ─── Translations loader ─────────────────────────────────────────────────────

/// Load `i18n/<locale>.json` from a [`LoadedTemplate`].
///
/// Falls back through `<locale>` → `<base>` (e.g. `de-AT` → `de`) → `en`
/// if the more specific file is missing. Returns an empty map (with a
/// `warn!`) when no fallback exists — render must continue, but the UI
/// surfaces will show the raw label keys.
///
/// The JSON must be a flat `{ string: string }` object. Nested objects
/// are stringified by their JSON representation, which is enough for
/// debug surfacing without crashing the render.
#[instrument(skip(template), fields(template = %template.slug, requested = locale))]
pub fn load_translations(
  template: &LoadedTemplate,
  locale: &str,
) -> Result<HashMap<String, String>, RenderContextError> {
  let mut tried: Vec<String> = Vec::with_capacity(3);

  let mut try_file = |loc: &str| -> Result<Option<HashMap<String, String>>, RenderContextError> {
    let path = format!("i18n/{loc}.json");
    let Some(bytes) = template.files.get(&path) else {
      tried.push(path);
      return Ok(None);
    };
    let parsed: serde_json::Value = serde_json::from_slice(bytes)
      .map_err(|e| RenderContextError::TranslationsInvalid(loc.to_owned(), e.to_string()))?;
    let obj = parsed
      .as_object()
      .ok_or_else(|| RenderContextError::TranslationsInvalid(loc.to_owned(), "expected JSON object".into()))?;
    let map: HashMap<String, String> = obj
      .iter()
      .map(|(k, v)| {
        let value = match v {
          serde_json::Value::String(s) => s.clone(),
          other => other.to_string(),
        };
        (k.clone(), value)
      })
      .collect();
    Ok(Some(map))
  };

  if let Some(map) = try_file(locale)? {
    debug!(locale, entries = map.len(), "translations loaded");
    return Ok(map);
  }

  if let Some((base, _)) = locale.split_once('-')
    && base != locale
    && let Some(map) = try_file(base)?
  {
    debug!(
      locale,
      base,
      entries = map.len(),
      "translations loaded via broader locale"
    );
    return Ok(map);
  }

  if locale != "en"
    && let Some(map) = try_file("en")?
  {
    warn!(locale, "translations missing — falling back to en");
    return Ok(map);
  }

  warn!(locale, tried = ?tried, "no translations bundle found; renderer will surface raw keys");
  Ok(HashMap::new())
}

// ─── Typst variable builder ──────────────────────────────────────────────────

/// Convert the render context into a flat `kebab-case` dictionary suitable
/// for a Typst `#let` block. Each key is wrapped in `#let <key> = <value>`
/// by the renderer; nested structures are JSON-stringified.
///
/// Naming convention: every binding is lowercase kebab-case (`doc-title`,
/// `brand-primary-color`). The keys mirror the existing V1 pipeline's
/// preamble bindings so the V1 path can keep working until V2 is wired.
pub fn typst_variables(ctx: &RenderContext) -> serde_json::Map<String, serde_json::Value> {
  let mut out: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();

  // ── Document layer ────────────────────────────────────────────────────────
  out.insert("doc-id".into(), ctx.doc_metadata.doc_id.to_string().into());
  out.insert("doc-title".into(), ctx.doc_metadata.title.clone().into());
  let primary_author = ctx
    .doc_metadata
    .authors
    .first()
    .map(|a| a.display_name.as_str())
    .unwrap_or("")
    .to_owned();
  out.insert("doc-author".into(), primary_author.into());
  out.insert(
    "doc-authors".into(),
    serde_json::Value::Array(
      ctx
        .doc_metadata
        .authors
        .iter()
        .map(|a| serde_json::Value::String(a.display_name.clone()))
        .collect(),
    ),
  );
  if let Some(created_at) = ctx.doc_metadata.created_at {
    out.insert("doc-created-at".into(), created_at.to_rfc3339().into());
  }
  out.insert("doc-updated-at".into(), ctx.doc_metadata.updated_at.to_rfc3339().into());

  // ── Locale ────────────────────────────────────────────────────────────────
  out.insert("locale".into(), ctx.locale.effective.clone().into());

  // ── Brand layer ───────────────────────────────────────────────────────────
  out.insert(
    "brand-company-name".into(),
    ctx.brand.company_name.clone().unwrap_or_default().into(),
  );
  out.insert(
    "brand-footer-text".into(),
    ctx.brand.footer_text.clone().unwrap_or_default().into(),
  );
  out.insert(
    "brand-primary-color".into(),
    ctx.brand.brand_color_primary.clone().unwrap_or_default().into(),
  );
  out.insert(
    "brand-accent-color".into(),
    ctx.brand.brand_color_accent.clone().unwrap_or_default().into(),
  );
  out.insert("brand-ligatures-enabled".into(), ctx.brand.ligatures_enabled.into());

  // ── Render-time inputs (L3) ───────────────────────────────────────────────
  out.insert(
    "paper-size".into(),
    ctx
      .inputs
      .paper_size
      .clone()
      .or_else(|| ctx.brand.default_paper_size.clone())
      .unwrap_or_else(|| "A4".into())
      .into(),
  );
  if let Some(label) = ctx.inputs.confidentiality_label.as_deref() {
    out.insert("confidentiality-label".into(), label.to_owned().into());
  }
  if let Some(toc) = ctx.inputs.toc_behavior.as_deref() {
    out.insert("toc-behavior".into(), toc.to_owned().into());
  }
  if let Some(cover) = ctx.inputs.cover_page {
    out.insert("cover-page".into(), cover.into());
  }

  // ── Color + DPI ───────────────────────────────────────────────────────────
  out.insert("color-profile".into(), ctx.color_profile.as_str().into());
  out.insert(
    "image-quality".into(),
    format!("{:?}", ctx.image_quality).to_lowercase().into(),
  );
  out.insert("dpi".into(), ctx.dpi.into());

  // ── Translations as a sub-object so the template can do
  //   `let t = sys.inputs.translations` and key into it. ──────────────────────
  out.insert(
    "translations".into(),
    serde_json::Value::Object(
      ctx
        .translations
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
        .collect(),
    ),
  );

  // ── Free-form L3 typed inputs are appended as-is so the template
  //    author can read them from `sys.inputs.typed_inputs`. ──────────────────
  if !ctx.inputs.typed_inputs.is_null() {
    out.insert("typed-inputs".into(), ctx.inputs.typed_inputs.clone());
  }

  out
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use uuid::Uuid;

  /// Build a minimal in-memory manifest for the locale tests. Every field
  /// is populated with the smallest valid value via JSON deserialisation
  /// (avoids hand-spelling every typed-enum variant — the manifest types
  /// already validate correctness at deserialise time).
  fn manifest_with_languages(values: &[&str], default: &str) -> PdfTemplateManifest {
    let values_json = serde_json::Value::Array(
      values
        .iter()
        .map(|v| serde_json::Value::String((*v).to_owned()))
        .collect(),
    );
    let raw = serde_json::json!({
      "schema_version": "2.0",
      "id": "tpl-test",
      "name": "Test",
      "description": "",
      "version": "1.0.0",
      "engine": { "name": "typst", "version": "0.15.x" },
      "provenance": {
        "license_spdx": "AGPL-3.0-or-later",
        "copyright_notice": "Copyright 2026 Myoxus test contributors",
        "source_url": "https://example.test/templates/locale-test",
        "source_revision": "1.0.0"
      },
      "entry": "main.typ",
      "assets": ["main.typ"],
      "capabilities": {
        "colorVariant": { "kind": "enum", "values": ["mono","accent","brand"], "default": "mono" },
        "headerStyle":  { "kind": "enum", "values": ["none","minimal","branded"], "default": "minimal" },
        "footerStyle":  { "kind": "enum", "values": ["none","minimal","page-only","brand-and-page"], "default": "page-only" },
        "coverPage":    { "kind": "boolean", "default": false },
        "tocBehavior":  { "kind": "enum", "values": ["off","auto","force"], "default": "off" },
        "pageNumbering":{ "kind": "enum", "values": ["arabic","roman","none"], "default": "arabic" },
        "customMargins":{ "kind": "boolean", "default": false },
        "accentColor":  { "kind": "color", "default": "#000000" },
        "confidentialityLabels": {
          "kind": "array<string>", "min_items": 0, "max_items": 0,
          "item_pattern": "^.*$", "default": []
        },
        "language": { "kind": "enum", "values": values_json, "default": default }
      },
      "inputs_schema": {"type":"object","additionalProperties":false,"properties":{}}
    });
    serde_json::from_value(raw).expect("manifest deserialise must succeed")
  }

  /// INV-CTX-01: input → PDF settings → server-default fallback resolution.
  #[test]
  fn inv_ctx01_locale_fallback_chain() {
    let manifest = manifest_with_languages(&["en", "de", "fr"], "en");

    // Input wins when it's a valid declared locale.
    let r = resolve_locale(Some("de"), Some("fr"), "en", &manifest).expect("ok");
    assert_eq!(r.effective, "de");
    assert_eq!(r.source, LocaleSource::Input);

    // Input is unknown → fall through to PDF settings.
    let r = resolve_locale(Some("xx"), Some("fr"), "en", &manifest).expect("ok");
    assert_eq!(r.effective, "fr");
    assert_eq!(r.source, LocaleSource::PdfSettings);

    // PDF settings are also unknown → fall through to server.
    let r = resolve_locale(Some("xx"), Some("yy"), "en", &manifest).expect("ok");
    assert_eq!(r.effective, "en");
    assert_eq!(r.source, LocaleSource::ServerDefault);

    // Narrow → broad fallback (`de-AT` not declared but `de` is).
    let r = resolve_locale(Some("de-AT"), None, "en", &manifest).expect("ok");
    assert_eq!(r.effective, "de");
    assert_eq!(r.source, LocaleSource::Input);

    // Nothing matches → error.
    let err = resolve_locale(Some("xx"), Some("yy"), "zz", &manifest).expect_err("err");
    assert!(matches!(err, RenderContextError::LocaleNotDeclared(_)));
  }

  /// INV-CTX-02: translation loader walks the bundle's i18n folder with
  /// the same fallback chain (`<locale>` → `<base>` → `en`).
  #[test]
  fn inv_ctx02_translations_fallback_chain() {
    let manifest = manifest_with_languages(&["en", "de"], "en");
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    files.insert(
      "i18n/de.json".into(),
      br#"{"toc_heading":"Inhaltsverzeichnis"}"#.to_vec(),
    );
    files.insert(
      "i18n/en.json".into(),
      br#"{"toc_heading":"Table of Contents"}"#.to_vec(),
    );
    let template = LoadedTemplate {
      id: Uuid::new_v4(),
      slug: "tpl-test".into(),
      version: "1.0.0".into(),
      manifest: manifest.clone(),
      files,
    };

    // Direct match.
    let de = load_translations(&template, "de").expect("ok");
    assert_eq!(de.get("toc_heading").map(String::as_str), Some("Inhaltsverzeichnis"));

    // Narrow → broad: `de-AT` falls back to `de`.
    let de_at = load_translations(&template, "de-AT").expect("ok");
    assert_eq!(de_at.get("toc_heading").map(String::as_str), Some("Inhaltsverzeichnis"));

    // Unknown locale → falls back to en.
    let xx = load_translations(&template, "xx").expect("ok");
    assert_eq!(xx.get("toc_heading").map(String::as_str), Some("Table of Contents"));
  }

  /// INV-CTX-03: malformed translation JSON is surfaced as an error
  /// instead of silently falling through (otherwise a broken template
  /// would render with English labels and never get fixed).
  #[test]
  fn inv_ctx03_malformed_translations_are_rejected() {
    let manifest = manifest_with_languages(&["en", "de"], "en");
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    files.insert("i18n/de.json".into(), b"{ this is not json".to_vec());
    let template = LoadedTemplate {
      id: Uuid::new_v4(),
      slug: "tpl-test".into(),
      version: "1.0.0".into(),
      manifest,
      files,
    };
    let err = load_translations(&template, "de").expect_err("err");
    assert!(matches!(err, RenderContextError::TranslationsInvalid(_, _)));
  }

  /// INV-CTX-04: Typst variable builder covers every documented binding
  /// and round-trips kebab-case names. Catches accidental rename of any
  /// preamble.typ binding.
  #[test]
  fn inv_ctx04_typst_dict_round_trip() {
    let manifest = manifest_with_languages(&["en"], "en");
    let template = LoadedTemplate {
      id: Uuid::new_v4(),
      slug: "tpl-test".into(),
      version: "1.0.0".into(),
      manifest,
      files: HashMap::new(),
    };
    let workspace_id = Uuid::new_v4();
    let ctx = RenderContext {
      template,
      brand: RenderContextBuilder::default_brand(workspace_id),
      inputs: PdfExportInputV2 {
        workspace_id,
        doc_id: Uuid::new_v4(),
        template_id: Uuid::new_v4(),
        locale: Some("en".into()),
        paper_size: Some("A4".into()),
        image_quality: Some(ImageQuality::High),
        compliance_profile: None,
        cover_page: Some(true),
        toc_behavior: Some("auto".into()),
        footer_style: None,
        page_numbering: None,
        color_variant: None,
        confidentiality_label: Some("Internal".into()),
        typed_inputs: serde_json::json!({"title":"Hi"}),
      },
      doc_metadata: DocMetadata {
        doc_id: Uuid::new_v4(),
        title: "Quarterly Report".into(),
        authors: vec![DocAuthor {
          user_id: Uuid::new_v4(),
          display_name: "Alice".into(),
          email: "alice@example.test".into(),
        }],
        created_at: Some(Utc::now()),
        updated_at: Utc::now(),
        chapter_titles: None,
      },
      locale: ResolvedLocale {
        effective: "en".into(),
        source: LocaleSource::Input,
      },
      translations: HashMap::new(),
      color_profile: ColorProfile::Srgb,
      image_quality: ImageQuality::High,
      dpi: 300,
    };
    let dict = typst_variables(&ctx);

    for required in [
      "doc-title",
      "doc-author",
      "doc-authors",
      "locale",
      "brand-company-name",
      "brand-primary-color",
      "paper-size",
      "color-profile",
      "image-quality",
      "dpi",
      "translations",
      "confidentiality-label",
      "toc-behavior",
      "cover-page",
      "typed-inputs",
    ] {
      assert!(dict.contains_key(required), "INV-CTX-04: missing binding `{required}`");
    }
    assert_eq!(dict["doc-title"], serde_json::Value::String("Quarterly Report".into()));
    assert_eq!(dict["doc-author"], serde_json::Value::String("Alice".into()));
    assert_eq!(dict["dpi"], serde_json::Value::from(300u32));
  }
}
