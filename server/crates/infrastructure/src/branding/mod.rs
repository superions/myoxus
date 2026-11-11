// SPDX-License-Identifier: AGPL-3.0-or-later
//! Server-owned theme, typography, font and branding seed infrastructure.
//!
//! The JSON catalog included here is generated from the current client theme
//! presets and bundled font manifest as a one-time cut-over source. Runtime
//! code must read the PostgreSQL tables seeded by this module, not the client
//! preset files.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{PgPool, Postgres, Row, Transaction};
use tracing::{debug, info, instrument};
use uuid::Uuid;

use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::branding::{
  BrandingAssetRepository, GlobalBrandAssetSlot, GlobalBrandAssetUpsert, PublicBrandAsset,
};
use myoxus_domain::repositories::RepositoryError;

const THEME_CATALOG_JSON: &str = include_str!("../../../../static/branding/theme-catalog.json");
const THEME_BRANDING_SEED_LOCK: &str = "myoxus:theme-branding-seed:v1";

#[derive(Clone)]
pub struct PgBrandingAssetRepository {
  pool: PgPool,
}

impl PgBrandingAssetRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn metadata(slot: GlobalBrandAssetSlot) -> (&'static str, &'static str, &'static str, &'static str) {
    match slot {
      GlobalBrandAssetSlot::Logo => ("logo", "large", "web", "logo_asset_id"),
      GlobalBrandAssetSlot::ProductMark => ("product_mark", "mark", "web", "product_mark_asset_id"),
      GlobalBrandAssetSlot::FaviconPack => ("favicon_pack", "pack", "favicon", "favicon_pack_asset_id"),
    }
  }

  fn map_error(error: sqlx::Error) -> AuthError {
    AuthError::Storage(error.to_string())
  }
}

#[async_trait::async_trait]
impl BrandingAssetRepository for PgBrandingAssetRepository {
  async fn upsert_global_asset(&self, asset: GlobalBrandAssetUpsert) -> AuthResult<()> {
    let (slot, variant, quality_class, target_column) = Self::metadata(asset.slot);
    let result = sqlx::query(
      r#"
      WITH asset AS (
        INSERT INTO brand_assets (
          scope, slot, variant, quality_class, storage_kind, storage_key,
          public_path, mime, sha256, byte_size, created_by, updated_at
        )
        VALUES ('global', $1, $2, $3, 'style_static', $4, $5, $6, $7, $8, $9, now())
        ON CONFLICT (slot, variant, quality_class) WHERE scope = 'global'
        DO UPDATE SET
          storage_key = EXCLUDED.storage_key,
          public_path = EXCLUDED.public_path,
          mime = EXCLUDED.mime,
          sha256 = EXCLUDED.sha256,
          byte_size = EXCLUDED.byte_size,
          created_by = EXCLUDED.created_by,
          updated_at = now()
        RETURNING id
      ),
      ensured AS (
        INSERT INTO app_server_branding (id)
        VALUES (TRUE)
        ON CONFLICT (id) DO NOTHING
      )
      UPDATE app_server_branding
      SET
        logo_asset_id = CASE WHEN $10 = 'logo_asset_id' THEN (SELECT id FROM asset) ELSE logo_asset_id END,
        product_mark_asset_id = CASE WHEN $10 = 'product_mark_asset_id' THEN (SELECT id FROM asset) ELSE product_mark_asset_id END,
        favicon_pack_asset_id = CASE WHEN $10 = 'favicon_pack_asset_id' THEN (SELECT id FROM asset) ELSE favicon_pack_asset_id END,
        updated_by = $9,
        updated_at = now()
      WHERE id = TRUE
      "#,
    )
    .bind(slot)
    .bind(variant)
    .bind(quality_class)
    .bind(asset.storage_key)
    .bind(asset.public_path)
    .bind(asset.mime)
    .bind(asset.sha256)
    .bind(asset.byte_size)
    .bind(asset.created_by)
    .bind(target_column)
    .execute(&self.pool)
    .await
    .map_err(Self::map_error)?;
    if result.rows_affected() == 0 {
      return Err(AuthError::Storage("app/server branding row is missing".to_string()));
    }
    Ok(())
  }

  async fn public_style_asset(&self, public_path: &str) -> AuthResult<Option<PublicBrandAsset>> {
    let row = sqlx::query(
      r#"
      SELECT ba.storage_key, ba.mime, ba.sha256
      FROM app_server_branding asb
      JOIN brand_assets ba ON ba.id IN (asb.logo_asset_id, asb.product_mark_asset_id)
      WHERE ba.scope = 'global'
        AND ba.storage_kind = 'style_static'
        AND ba.public_path = $1
      LIMIT 1
      "#,
    )
    .bind(public_path)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_error)?;
    Ok(row.map(|row| PublicBrandAsset {
      storage_key: row.get("storage_key"),
      mime: row.get("mime"),
      sha256: row.get("sha256"),
    }))
  }

  async fn favicon_pack_asset(&self) -> AuthResult<Option<PublicBrandAsset>> {
    let row = sqlx::query(
      r#"
      SELECT ba.storage_key, ba.mime, ba.sha256
      FROM app_server_branding asb
      JOIN brand_assets ba ON ba.id = asb.favicon_pack_asset_id
      WHERE ba.scope = 'global'
        AND ba.slot = 'favicon_pack'
        AND ba.storage_kind = 'style_static'
      LIMIT 1
      "#,
    )
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_error)?;
    Ok(row.map(|row| PublicBrandAsset {
      storage_key: row.get("storage_key"),
      mime: row.get("mime"),
      sha256: row.get("sha256"),
    }))
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeBrandingSeedStats {
  pub font_families: usize,
  pub font_assets: usize,
  pub color_schemas: usize,
  pub color_values: usize,
  pub typography_sets: usize,
  pub typography_styles: usize,
  pub themes: usize,
  pub global_profile_created: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontAssetProjection {
  pub usage: String,
  pub format: String,
  pub style: String,
  pub weight_min: i32,
  pub weight_max: i32,
  pub weight_default: i32,
  pub asset_key: String,
  pub sha256: String,
  pub mime: String,
  pub unicode_ranges: Vec<String>,
  pub subset_tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamilyProjection {
  pub slug: String,
  pub display_name: String,
  pub css_family: String,
  pub generic_class: String,
  pub source: String,
  pub license_spdx: String,
  pub license_status: String,
  pub is_selectable: bool,
  pub assets: Vec<FontAssetProjection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypographyStyleProjection {
  pub style_key: String,
  pub font_family_slug: String,
  pub font_family: String,
  pub css_family: String,
  pub font_weight: i32,
  pub font_style: String,
  pub size_px: Option<f64>,
  pub line_height: Option<f64>,
  pub letter_spacing_em: Option<f64>,
  pub text_transform: Option<String>,
  pub decoration: Option<String>,
  pub hover_decoration: Option<String>,
  pub font_features: JsonValue,
  pub font_variations: JsonValue,
  pub pdf_role: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeProjection {
  pub slug: String,
  pub name: String,
  pub category: Option<String>,
  pub preview_group: Option<String>,
  pub preview_order: i32,
  pub tagline_key: Option<String>,
  pub description_key: Option<String>,
  pub origin: String,
  pub locked: bool,
  pub is_default: bool,
  pub color_schema_slug: String,
  pub typography_slug: String,
  pub colors: BTreeMap<String, BTreeMap<String, String>>,
  pub typography_styles: Vec<TypographyStyleProjection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandAssetProjection {
  pub id: Uuid,
  pub slot: String,
  pub variant: String,
  pub quality_class: String,
  pub storage_kind: String,
  pub storage_key: String,
  pub public_url: Option<String>,
  pub mime: String,
  pub sha256: String,
  pub byte_size: Option<i64>,
  pub width_px: Option<i32>,
  pub height_px: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppServerBrandingProjection {
  pub logo: Option<BrandAssetProjection>,
  pub product_mark: Option<BrandAssetProjection>,
  pub favicon_pack: Option<BrandAssetProjection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationIdentityProjection {
  pub display_name: Option<String>,
  pub legal_name: Option<String>,
  pub short_name: Option<String>,
  pub jurisdiction: Option<String>,
  pub website_url: Option<String>,
  pub contact_email: Option<String>,
  pub address_lines: JsonValue,
  pub tax_id: Option<String>,
  pub registration_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeProfileProjection {
  pub scope: String,
  pub workspace_id: Option<Uuid>,
  pub theme_mode: String,
  pub theme: ThemeProjection,
}

#[derive(Debug, Clone)]
pub struct TypographyStyleUpdate {
  pub style_key: String,
  pub font_family_slug: Option<String>,
  pub font_weight: Option<i32>,
  pub font_style: Option<String>,
  pub size_px: Option<f64>,
  pub line_height: Option<f64>,
  pub letter_spacing_em: Option<f64>,
  pub text_transform: Option<String>,
  pub decoration: Option<String>,
  pub hover_decoration: Option<String>,
  pub font_features: Option<JsonValue>,
  pub font_variations: Option<JsonValue>,
  pub pdf_role: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ColorValueUpdate {
  pub mode: String,
  pub token_key: String,
  pub value: String,
}

#[derive(Debug, Clone)]
pub struct OrganizationIdentityUpdate {
  pub display_name: Option<String>,
  pub legal_name: Option<String>,
  pub short_name: Option<String>,
  pub jurisdiction: Option<String>,
  pub website_url: Option<String>,
  pub contact_email: Option<String>,
  pub address_lines: JsonValue,
  pub tax_id: Option<String>,
  pub registration_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AppServerBrandingUpdate {
  pub logo_asset_id: Option<Uuid>,
  pub product_mark_asset_id: Option<Uuid>,
  pub favicon_pack_asset_id: Option<Uuid>,
}

impl ThemeBrandingSeedStats {
  pub fn total_rows_materialized(&self) -> usize {
    self.font_families
      + self.font_assets
      + self.color_schemas
      + self.color_values
      + self.typography_sets
      + self.typography_styles
      + self.themes
      + usize::from(self.global_profile_created)
  }
}

/// Build the server-owned runtime theme CSS projection used by Web/Admin and public HTML.
///
/// `theme_mode` controls the default cascade for standalone consumers such as
/// dynamic public HTML: `system` keeps the browser preference media query,
/// while explicit `light` and `dark` profiles make `:root` deterministic.
/// The `data-theme` selectors remain available for hydrated clients that
/// resolve their own UI mode before mounting.
pub fn build_runtime_theme_css(profile: &ThemeProfileProjection, fonts: &[FontFamilyProjection]) -> String {
  build_runtime_theme_css_with_font_urls(profile, fonts, &|asset| {
    format!(
      "/api/fonts/{}?v={}",
      url_file_escape(&asset.asset_key),
      css_escape(&asset.sha256.chars().take(8).collect::<String>())
    )
  })
}

/// Portable consumers supply verified data URLs through the same font emitter.
pub fn build_runtime_theme_css_with_font_urls(
  profile: &ThemeProfileProjection,
  fonts: &[FontFamilyProjection],
  source: &dyn Fn(&FontAssetProjection) -> String,
) -> String {
  let mut css = String::with_capacity(16384);
  emit_db_font_faces(&mut css, fonts, source);

  let empty = BTreeMap::new();
  let light_tokens = profile.theme.colors.get("light").unwrap_or(&empty);
  let dark_tokens = profile.theme.colors.get("dark").unwrap_or(&empty);
  let theme_mode = match profile.theme_mode.as_str() {
    "light" | "dark" | "system" => profile.theme_mode.as_str(),
    _ => "system",
  };
  let root_tokens = if theme_mode == "dark" {
    dark_tokens
  } else {
    light_tokens
  };

  css.push_str(":root {\n");
  emit_color_scheme(&mut css, "  ", theme_mode);
  emit_theme_identity(&mut css, "  ", &profile.theme.slug);
  emit_theme_color_tokens(
    &mut css,
    "  ",
    root_tokens,
    if theme_mode == "dark" { "dark" } else { "light" },
  );
  emit_typography_style_vars(&mut css, "  ", &profile.theme.typography_styles);
  css.push_str("}\n\n");

  if theme_mode == "system" {
    css.push_str("@media (prefers-color-scheme: dark) {\n  :root {\n");
    emit_color_scheme(&mut css, "    ", "dark");
    emit_theme_identity(&mut css, "    ", &profile.theme.slug);
    emit_theme_color_tokens(&mut css, "    ", dark_tokens, "dark");
    emit_typography_style_vars(&mut css, "    ", &profile.theme.typography_styles);
    css.push_str("  }\n}\n\n");
  }

  css.push_str("[data-theme='light'] {\n");
  emit_color_scheme(&mut css, "  ", "light");
  emit_theme_identity(&mut css, "  ", &profile.theme.slug);
  emit_theme_color_tokens(&mut css, "  ", light_tokens, "light");
  emit_typography_style_vars(&mut css, "  ", &profile.theme.typography_styles);
  css.push_str("}\n\n");

  css.push_str("[data-theme='dark'] {\n");
  emit_color_scheme(&mut css, "  ", "dark");
  emit_theme_identity(&mut css, "  ", &profile.theme.slug);
  emit_theme_color_tokens(&mut css, "  ", dark_tokens, "dark");
  emit_typography_style_vars(&mut css, "  ", &profile.theme.typography_styles);
  css.push_str("}\n");
  css.push_str(":root {\n");
  for (reference, value) in &content_colors().fixed {
    css.push_str(&format!("  {reference}: {value};\n"));
  }
  css.push_str("}\n");
  css
}

fn emit_color_scheme(css: &mut String, indent: &str, theme_mode: &str) {
  let value = match theme_mode {
    "light" => "light",
    "dark" => "dark",
    _ => "light dark",
  };
  css.push_str(&format!("{indent}color-scheme: {value};\n"));
}

fn emit_theme_identity(css: &mut String, indent: &str, theme_slug: &str) {
  css.push_str(&format!(
    "{indent}--myoxus-theme-slug: \"{}\";\n",
    css_escape(theme_slug)
  ));
}

fn emit_db_font_faces(
  css: &mut String,
  fonts: &[FontFamilyProjection],
  source: &dyn Fn(&FontAssetProjection) -> String,
) {
  for family in fonts {
    for asset in family
      .assets
      .iter()
      .filter(|asset| asset.usage == "web" && asset.format == "woff2")
    {
      css.push_str("@font-face {\n");
      css.push_str(&format!("  font-family: \"{}\";\n", css_escape(&family.css_family)));
      css.push_str(&format!(
        "  src: url('{}') format('woff2');\n",
        css_escape(&source(asset))
      ));
      css.push_str(&format!("  font-weight: {} {};\n", asset.weight_min, asset.weight_max));
      css.push_str(&format!("  font-style: {};\n", sanitize_css_ident(&asset.style)));
      css.push_str("  font-display: swap;\n");
      css.push_str("}\n\n");
    }
  }
}

/// The established table swatches live at the global theme boundary so browser
/// rendering and captured PDF paint resolve the same native references.
pub(crate) fn native_table_color_values<'a>(
  tokens: &'a BTreeMap<String, String>,
  mode: &str,
) -> BTreeMap<&'static str, Option<&'a str>> {
  let mut values = BTreeMap::new();
  for (token, reference, light, dark) in [
    ("tag-blue", "--myoxus-tag-blue", "#e1eeff", "#084388"),
    ("tag-green", "--myoxus-tag-green", "#def4e7", "#2c6c3f"),
    ("tag-gray", "--myoxus-tag-gray", "#e3e2e0", "#292929"),
    ("tag-orange", "--myoxus-tag-orange", "#ffe9c9", "#b9812e"),
    ("tag-purple", "--myoxus-tag-purple", "#f3f0ff", "#2f1e71"),
    ("tag-red", "--myoxus-tag-red", "#ffe1e1", "#6f3232"),
    ("tag-teal", "--myoxus-tag-teal", "#def4f3", "#1a736e"),
    ("tag-yellow", "--myoxus-tag-yellow", "#fff3d7", "#968431"),
  ] {
    values.insert(
      reference,
      Some(
        tokens
          .get(token)
          .map(String::as_str)
          .unwrap_or(if mode == "dark" { dark } else { light }),
      ),
    );
  }
  for (token, reference) in [
    ("paper-deep", "--myoxus-background-secondary-color"),
    ("status-success-paper", "--myoxus-sem-status-success-paper"),
    ("status-preset-paper", "--myoxus-sem-status-preset-paper"),
    ("status-error-paper", "--myoxus-sem-status-error-paper"),
  ] {
    values.insert(reference, tokens.get(token).map(String::as_str));
  }
  values
}

fn emit_theme_color_tokens(css: &mut String, indent: &str, tokens: &BTreeMap<String, String>, mode: &str) {
  let primary = tokens.get("accent-primary").map(String::as_str).unwrap_or("#1e96eb");
  let secondary = tokens.get("accent-secondary").map(String::as_str).unwrap_or("#44b931");
  let mut emitted = BTreeSet::new();
  emit_derived_button_foregrounds(css, indent, primary, secondary, &mut emitted);

  for (token, value) in tokens {
    if value.trim().is_empty() {
      continue;
    }
    emit_theme_color_token(css, indent, token, value, &mut emitted);
  }
  for (reference, value) in native_table_color_values(tokens, mode) {
    if let Some(value) = value {
      emit_projection_variable(css, indent, reference, value, &mut emitted);
    }
  }
  let content = content_colors();
  let colors = if mode == "dark" { &content.dark } else { &content.light };
  for (reference, value) in colors {
    emit_projection_variable(css, indent, reference, value, &mut emitted);
  }
  if !tokens.contains_key("accent-primary") {
    emit_theme_color_token(css, indent, "accent-primary", primary, &mut emitted);
  }
  if !tokens.contains_key("accent-secondary") {
    emit_theme_color_token(css, indent, "accent-secondary", secondary, &mut emitted);
  }
}

fn emit_theme_color_token(css: &mut String, indent: &str, token: &str, value: &str, emitted: &mut BTreeSet<String>) {
  // The persisted key intentionally projects to one unversioned public
  // variable. Do not manufacture a second semantic alias for this surface.
  if token != "background-code-block" {
    emit_projection_variable(
      css,
      indent,
      &format!("--myoxus-sem-{}", to_kebab_case(token)),
      value,
      emitted,
    );
  }
  for css_var in p_ar_theme_css_vars(token) {
    emit_projection_variable(css, indent, css_var, value, emitted);
  }
}

fn emit_projection_variable(css: &mut String, indent: &str, name: &str, value: &str, emitted: &mut BTreeSet<String>) {
  if emitted.insert(name.to_owned()) {
    css.push_str(&format!("{indent}{name}: {value};\n"));
  }
}

fn emit_derived_button_foregrounds(
  css: &mut String,
  indent: &str,
  primary: &str,
  secondary: &str,
  emitted: &mut BTreeSet<String>,
) {
  // The persisted color schema stores P-AR accent tokens, not duplicated
  // button foreground fields. Runtime CSS still has to expose atomic bg/fg
  // pairs because hover derivation and button components consume them together.
  let primary_fg = adaptive_foreground(primary);
  let secondary_fg = adaptive_foreground(secondary);
  emit_projection_variable(css, indent, "--myoxus-sem-button-primary-fg", primary_fg, emitted);
  emit_projection_variable(css, indent, "--myoxus-sem-button-secondary-fg", secondary_fg, emitted);
  emit_projection_variable(css, indent, "--myoxus-branding-button-primary-fg", primary_fg, emitted);
}

pub(crate) use myoxus_domain::color::adaptive_foreground;
#[cfg(test)]
use myoxus_domain::color::contrast_ratio;

fn emit_typography_style_vars(css: &mut String, indent: &str, styles: &[TypographyStyleProjection]) {
  for style in styles {
    let Some(slot) = typography_slot_name(&style.style_key) else {
      continue;
    };
    let family = quoted_font_family(&style.css_family);
    css.push_str(&format!("{indent}--myoxus-typography-{slot}-family: {family};\n"));
    css.push_str(&format!(
      "{indent}--myoxus-typography-{slot}-weight: {};\n",
      style.font_weight
    ));
    css.push_str(&format!(
      "{indent}--myoxus-typography-{slot}-font-style: {};\n",
      sanitize_css_ident(&style.font_style)
    ));
    if let Some(size_px) = style.size_px {
      css.push_str(&format!(
        "{indent}--myoxus-typography-{slot}-size: {}px;\n",
        format_css_number(size_px)
      ));
    }
    if let Some(line_height) = style.line_height {
      css.push_str(&format!(
        "{indent}--myoxus-typography-{slot}-line-height: {};\n",
        format_css_number(line_height)
      ));
    }
    if let Some(letter_spacing_em) = style.letter_spacing_em {
      css.push_str(&format!(
        "{indent}--myoxus-typography-{slot}-letter-spacing: {}em;\n",
        format_css_number(letter_spacing_em)
      ));
    }
    if let Some(value) = style.decoration.as_deref().filter(|value| !value.trim().is_empty()) {
      css.push_str(&format!(
        "{indent}--myoxus-typography-{slot}-decoration: {};\n",
        sanitize_css_ident(value)
      ));
    }
    if let Some(value) = style
      .hover_decoration
      .as_deref()
      .filter(|value| !value.trim().is_empty())
    {
      css.push_str(&format!(
        "{indent}--myoxus-typography-{slot}-hover-decoration: {};\n",
        sanitize_css_ident(value)
      ));
    }
    if let Some(value) = style.text_transform.as_deref().filter(|value| !value.trim().is_empty()) {
      css.push_str(&format!(
        "{indent}--myoxus-typography-{slot}-text-transform: {};\n",
        sanitize_css_ident(value)
      ));
    }

    match slot {
      "body" => {
        css.push_str(&format!("{indent}--myoxus-typography-ui-font-family: {family};\n"));
        css.push_str(&format!("{indent}--myoxus-font-family: {family};\n"));
        if let Some(size_px) = style.size_px {
          css.push_str(&format!(
            "{indent}--myoxus-typography-base-size: {}px;\n",
            format_css_number(size_px)
          ));
          css.push_str(&format!(
            "{indent}--myoxus-font-base: {}px;\n",
            format_css_number(size_px)
          ));
        }
        if let Some(line_height) = style.line_height {
          css.push_str(&format!(
            "{indent}--myoxus-typography-base-line-height: {};\n",
            format_css_number(line_height)
          ));
          css.push_str(&format!(
            "{indent}--myoxus-line-height: {};\n",
            format_css_number(line_height)
          ));
        }
      }
      "mono" => {
        css.push_str(&format!("{indent}--myoxus-typography-mono-font-family: {family};\n"));
        css.push_str(&format!("{indent}--myoxus-font-code-family: {family};\n"));
        css.push_str(&format!("{indent}--myoxus-font-family-mono: {family};\n"));
      }
      _ => {}
    }
  }
}

fn typography_slot_name(style_key: &str) -> Option<&'static str> {
  match style_key {
    "page.title" => Some("page-title"),
    "section.title" => Some("section-title"),
    "card.title" => Some("card-title"),
    "modal.title" => Some("modal-title"),
    "heading.h1" => Some("h1"),
    "heading.h2" => Some("h2"),
    "heading.h3" => Some("h3"),
    "heading.h4" => Some("h4"),
    "heading.h5" => Some("h5"),
    "body.default" => Some("body"),
    "body.small" => Some("body-small"),
    "label.compact" => Some("label-compact"),
    "quote.block" => Some("blockquote"),
    "link.default" => Some("link"),
    "code.inline" => Some("mono"),
    "code.block" => Some("code-block"),
    _ => None,
  }
}

fn quoted_font_family(family: &str) -> String {
  format!("\"{}\"", css_escape(family))
}

fn css_escape(value: &str) -> String {
  value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " ")
}

fn url_file_escape(value: &str) -> String {
  value
    .chars()
    .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    .collect()
}

fn sanitize_css_ident(value: &str) -> String {
  value
    .chars()
    .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    .collect::<String>()
}

fn format_css_number(value: f64) -> String {
  let rounded = (value * 1000.0).round() / 1000.0;
  if (rounded.fract()).abs() < f64::EPSILON {
    format!("{rounded:.0}")
  } else {
    rounded.to_string()
  }
}

pub(crate) fn p_ar_theme_css_vars(token: &str) -> &'static [&'static str] {
  match token {
    "paper" => &["--myoxus-background-primary-color", "--myoxus-sem-surface-page"],
    "paper-deep" => &[
      "--myoxus-background-secondary-color",
      "--myoxus-background-tertiary-color",
      "--myoxus-background-overlay-panel-color",
      "--myoxus-hover-color",
      "--myoxus-sem-surface-card",
      "--myoxus-sem-surface-elevated",
      "--myoxus-sem-surface-muted",
      "--myoxus-selfhost-sidebar-bg",
    ],
    "background-code-block" => &["--myoxus-background-code-block"],
    "ink" => &["--myoxus-text-primary-color", "--myoxus-sem-text-primary"],
    "ink-soft" => &[
      "--myoxus-text-secondary-color",
      "--myoxus-icon-color",
      "--myoxus-sem-text-secondary",
    ],
    "ink-mute" => &[
      "--myoxus-placeholder-color",
      "--myoxus-text-disable-color",
      "--myoxus-icon-secondary",
      "--myoxus-sem-text-muted",
    ],
    "rule" => &[
      "--myoxus-border-color",
      "--myoxus-divider-color",
      "--myoxus-sem-border-default",
    ],
    "accent-primary" => &[
      "--myoxus-accent-primary",
      "--myoxus-primary-color",
      "--myoxus-brand-color",
      "--myoxus-text-emphasis-color",
      "--myoxus-sem-button-primary-bg",
    ],
    "link-default" => &["--myoxus-link-color", "--myoxus-sem-link-default"],
    "accent-secondary" => &[
      "--myoxus-accent-secondary",
      "--myoxus-secondary-color",
      "--myoxus-sem-button-secondary-bg",
    ],
    "status-success-paper" => &["--myoxus-background-success-color", "--myoxus-sem-status-success-paper"],
    "status-success-deep" => &[
      "--myoxus-success-color",
      "--myoxus-sem-status-success",
      "--myoxus-sem-status-success-deep",
    ],
    "status-pending-paper" => &["--myoxus-background-warning-color", "--myoxus-sem-status-pending-paper"],
    "status-pending-deep" => &[
      "--myoxus-warning-color",
      "--myoxus-sem-status-warning",
      "--myoxus-sem-status-pending-deep",
    ],
    "status-error-paper" => &["--myoxus-background-error-color", "--myoxus-sem-status-error-paper"],
    "status-error-deep" => &[
      "--myoxus-sem-status-error",
      "--myoxus-sem-status-error-deep",
      "--myoxus-error-color",
    ],
    "status-preset-paper" => &["--myoxus-sem-status-preset-paper"],
    "status-preset-deep" => &["--myoxus-sem-status-preset-deep"],
    "status-info-paper" => &["--myoxus-background-processing-color", "--myoxus-sem-status-info-paper"],
    "status-info-deep" => &[
      "--myoxus-processing-color",
      "--myoxus-sem-status-info",
      "--myoxus-sem-status-info-deep",
    ],
    _ => &[],
  }
}

fn to_kebab_case(input: &str) -> String {
  let mut out = String::with_capacity(input.len() + 4);
  for (index, ch) in input.chars().enumerate() {
    if ch.is_ascii_uppercase() {
      if index > 0 {
        out.push('-');
      }
      out.push(ch.to_ascii_lowercase());
    } else if ch == '_' || ch == ' ' {
      out.push('-');
    } else {
      out.push(ch.to_ascii_lowercase());
    }
  }
  out
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThemeCatalog {
  catalog_hash: String,
  schema_version: i32,
  content_colors: ContentColors,
  required_color_keys: Vec<String>,
  font_families: Vec<FontFamilySeed>,
  themes: Vec<ThemeSeed>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ContentColors {
  pub light: BTreeMap<String, String>,
  pub dark: BTreeMap<String, String>,
  pub fixed: BTreeMap<String, String>,
}

/// Shared content colours come from the existing catalog, not export-owned assets.
pub(crate) fn content_colors() -> &'static ContentColors {
  static COLORS: std::sync::OnceLock<ContentColors> = std::sync::OnceLock::new();
  COLORS.get_or_init(|| catalog().expect("bundled theme catalog").content_colors)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FontFamilySeed {
  slug: String,
  display_name: String,
  css_family: String,
  generic_class: String,
  source: String,
  license_spdx: String,
  license_status: String,
  is_selectable: bool,
  assets: Vec<FontAssetSeed>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FontAssetSeed {
  usage: String,
  format: String,
  style: String,
  weight_min: i32,
  weight_max: i32,
  weight_default: i32,
  asset_key: String,
  sha256: String,
  mime: String,
  unicode_ranges: Vec<String>,
  subset_tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThemeSeed {
  slug: String,
  name: String,
  category: String,
  preview_group: String,
  preview_order: i32,
  tagline_key: String,
  description_key: String,
  color_schema_slug: String,
  typography_slug: String,
  is_default: bool,
  colors: BTreeMap<String, BTreeMap<String, String>>,
  typography_styles: Vec<TypographyStyleSeed>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypographyStyleSeed {
  style_key: String,
  font_family: String,
  font_weight: i32,
  font_style: String,
  size_px: Option<f64>,
  line_height: Option<f64>,
  letter_spacing_em: Option<f64>,
  text_transform: Option<String>,
  decoration: Option<String>,
  hover_decoration: Option<String>,
  font_features: JsonValue,
  font_variations: JsonValue,
  pdf_role: Option<String>,
}

fn repo_error(context: &str, err: impl std::fmt::Display) -> RepositoryError {
  RepositoryError::Storage(format!("{context}: {err}"))
}

fn catalog() -> Result<ThemeCatalog, RepositoryError> {
  let catalog: ThemeCatalog = serde_json::from_str(THEME_CATALOG_JSON)
    .map_err(|err| repo_error("theme branding catalog cannot be parsed", err))?;
  if catalog.schema_version != 1 {
    return Err(RepositoryError::Validation(format!(
      "unsupported theme branding catalog schema version {}",
      catalog.schema_version
    )));
  }
  Ok(catalog)
}

pub fn bundled_theme_catalog_hash() -> Result<String, RepositoryError> {
  Ok(catalog()?.catalog_hash)
}

pub fn bundled_theme_count() -> Result<usize, RepositoryError> {
  Ok(catalog()?.themes.len())
}

pub fn bundled_font_family_count() -> Result<usize, RepositoryError> {
  Ok(catalog()?.font_families.len())
}

#[instrument(skip(pool), err)]
pub async fn seed_system_theme_branding(pool: &PgPool) -> Result<ThemeBrandingSeedStats, RepositoryError> {
  let catalog = catalog()?;
  let mut tx = pool
    .begin()
    .await
    .map_err(|err| repo_error("begin theme branding seed transaction", err))?;

  // Every API process materializes the same server-owned catalog at startup.
  // Serialize the transaction across processes so conflict fallbacks never
  // read a pre-commit statement snapshot from a concurrent first writer.
  sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
    .bind(THEME_BRANDING_SEED_LOCK)
    .execute(&mut *tx)
    .await
    .map_err(|err| repo_error("lock theme branding seed transaction", err))?;

  let mut stats = ThemeBrandingSeedStats {
    font_families: 0,
    font_assets: 0,
    color_schemas: 0,
    color_values: 0,
    typography_sets: 0,
    typography_styles: 0,
    themes: 0,
    global_profile_created: false,
  };

  let family_ids = seed_font_families(&mut tx, &catalog.font_families, &mut stats).await?;
  seed_color_schemas(&mut tx, &catalog, &mut stats).await?;
  seed_typography_sets(&mut tx, &catalog, &family_ids, &mut stats).await?;
  let default_theme_id = seed_themes(&mut tx, &catalog, &mut stats).await?;
  seed_document_theme_color_palettes(&mut tx).await?;
  stats.global_profile_created = seed_global_theme_profile(&mut tx, default_theme_id).await?;
  seed_global_brand_identity_boundaries(&mut tx).await?;

  tx.commit()
    .await
    .map_err(|err| repo_error("commit theme branding seed transaction", err))?;

  if stats.total_rows_materialized() == 0 {
    debug!(catalog_hash = %catalog.catalog_hash, "theme branding catalog already materialized");
  } else {
    info!(
      catalog_hash = %catalog.catalog_hash,
      font_families = stats.font_families,
      font_assets = stats.font_assets,
      color_schemas = stats.color_schemas,
      color_values = stats.color_values,
      typography_sets = stats.typography_sets,
      typography_styles = stats.typography_styles,
      themes = stats.themes,
      global_profile_created = stats.global_profile_created,
      "theme branding catalog materialized"
    );
  }

  Ok(stats)
}

async fn seed_font_families(
  tx: &mut Transaction<'_, Postgres>,
  families: &[FontFamilySeed],
  stats: &mut ThemeBrandingSeedStats,
) -> Result<HashMap<String, Uuid>, RepositoryError> {
  let mut family_ids = HashMap::new();
  for family in families {
    let (id, changed): (Uuid, bool) = sqlx::query_as(
      r#"
      WITH upsert AS (
      INSERT INTO font_families (
        slug, display_name, css_family, generic_class, source, license_spdx,
        license_status, is_selectable, approved_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
        CASE WHEN $7 = 'approved' THEN now() ELSE NULL END,
        now()
      )
      ON CONFLICT (slug) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        css_family = EXCLUDED.css_family,
        generic_class = EXCLUDED.generic_class,
        source = EXCLUDED.source,
        license_spdx = EXCLUDED.license_spdx,
        license_status = EXCLUDED.license_status,
        is_selectable = EXCLUDED.is_selectable,
        approved_at = CASE WHEN EXCLUDED.license_status = 'approved'
          THEN COALESCE(font_families.approved_at, now())
          ELSE NULL
        END,
        updated_at = now()
      WHERE font_families.display_name IS DISTINCT FROM EXCLUDED.display_name
         OR font_families.css_family IS DISTINCT FROM EXCLUDED.css_family
         OR font_families.generic_class IS DISTINCT FROM EXCLUDED.generic_class
         OR font_families.source IS DISTINCT FROM EXCLUDED.source
         OR font_families.license_spdx IS DISTINCT FROM EXCLUDED.license_spdx
         OR font_families.license_status IS DISTINCT FROM EXCLUDED.license_status
         OR font_families.is_selectable IS DISTINCT FROM EXCLUDED.is_selectable
      RETURNING id, true AS changed
      )
      SELECT id, changed FROM upsert
      UNION ALL
      SELECT id, false AS changed FROM font_families
      WHERE slug = $1 AND NOT EXISTS (SELECT 1 FROM upsert)
      LIMIT 1
      "#,
    )
    .bind(&family.slug)
    .bind(&family.display_name)
    .bind(&family.css_family)
    .bind(&family.generic_class)
    .bind(&family.source)
    .bind(&family.license_spdx)
    .bind(&family.license_status)
    .bind(family.is_selectable)
    .fetch_one(&mut **tx)
    .await
    .map_err(|err| repo_error("upsert font family", err))?;

    family_ids.insert(family.display_name.clone(), id);
    if changed {
      stats.font_families += 1;
    }

    for asset in &family.assets {
      let done = sqlx::query(
        r#"
        INSERT INTO font_assets (
          family_id, usage, format, style, weight_min, weight_max,
          weight_default, asset_key, sha256, mime, unicode_ranges, subset_tags
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
        ON CONFLICT (family_id, usage, format, style, weight_min, weight_max, asset_key)
        DO UPDATE SET
          weight_default = EXCLUDED.weight_default,
          sha256 = EXCLUDED.sha256,
          mime = EXCLUDED.mime,
          unicode_ranges = EXCLUDED.unicode_ranges,
          subset_tags = EXCLUDED.subset_tags
        WHERE font_assets.weight_default IS DISTINCT FROM EXCLUDED.weight_default
           OR font_assets.sha256 IS DISTINCT FROM EXCLUDED.sha256
           OR font_assets.mime IS DISTINCT FROM EXCLUDED.mime
           OR font_assets.unicode_ranges IS DISTINCT FROM EXCLUDED.unicode_ranges
           OR font_assets.subset_tags IS DISTINCT FROM EXCLUDED.subset_tags
        "#,
      )
      .bind(id)
      .bind(&asset.usage)
      .bind(&asset.format)
      .bind(&asset.style)
      .bind(asset.weight_min)
      .bind(asset.weight_max)
      .bind(asset.weight_default)
      .bind(&asset.asset_key)
      .bind(&asset.sha256)
      .bind(&asset.mime)
      .bind(JsonValue::Array(asset.unicode_ranges.iter().cloned().map(JsonValue::String).collect()).to_string())
      .bind(JsonValue::Array(asset.subset_tags.iter().cloned().map(JsonValue::String).collect()).to_string())
      .execute(&mut **tx)
      .await
      .map_err(|err| repo_error("insert font asset", err))?;
      if done.rows_affected() > 0 {
        stats.font_assets += 1;
      }
    }
  }
  Ok(family_ids)
}

async fn seed_color_schemas(
  tx: &mut Transaction<'_, Postgres>,
  catalog: &ThemeCatalog,
  stats: &mut ThemeBrandingSeedStats,
) -> Result<(), RepositoryError> {
  for theme in &catalog.themes {
    let (schema_id, changed): (Uuid, bool) = sqlx::query_as(
      r#"
      WITH upsert AS (
      INSERT INTO color_schemas (slug, name, origin, locked, updated_at)
      VALUES ($1, $2, 'system', true, now())
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        origin = 'system',
        locked = true,
        updated_at = now()
      WHERE color_schemas.name IS DISTINCT FROM EXCLUDED.name
         OR color_schemas.origin IS DISTINCT FROM 'system'
         OR color_schemas.locked IS DISTINCT FROM true
      RETURNING id, true AS changed
      )
      SELECT id, changed FROM upsert
      UNION ALL
      SELECT id, false AS changed FROM color_schemas
      WHERE slug = $1 AND NOT EXISTS (SELECT 1 FROM upsert)
      LIMIT 1
      "#,
    )
    .bind(&theme.color_schema_slug)
    .bind(&theme.name)
    .fetch_one(&mut **tx)
    .await
    .map_err(|err| repo_error("upsert color schema", err))?;
    if changed {
      stats.color_schemas += 1;
    }

    for mode in ["light", "dark"] {
      let Some(values) = theme.colors.get(mode) else {
        return Err(RepositoryError::Validation(format!(
          "theme `{}` misses {mode} color values",
          theme.slug
        )));
      };
      for key in &catalog.required_color_keys {
        let Some(value) = values.get(key) else {
          return Err(RepositoryError::Validation(format!(
            "theme `{}` misses required color `{}` for mode {mode}",
            theme.slug, key
          )));
        };
        let done = sqlx::query(
          r#"
          INSERT INTO color_schema_values (schema_id, mode, token_key, value)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (schema_id, mode, token_key) DO UPDATE SET value = EXCLUDED.value
          WHERE color_schema_values.value IS DISTINCT FROM EXCLUDED.value
          "#,
        )
        .bind(schema_id)
        .bind(mode)
        .bind(key)
        .bind(value)
        .execute(&mut **tx)
        .await
        .map_err(|err| repo_error("insert color schema value", err))?;
        if done.rows_affected() > 0 {
          stats.color_values += 1;
        }
      }
    }
  }
  Ok(())
}

async fn seed_typography_sets(
  tx: &mut Transaction<'_, Postgres>,
  catalog: &ThemeCatalog,
  family_ids: &HashMap<String, Uuid>,
  stats: &mut ThemeBrandingSeedStats,
) -> Result<(), RepositoryError> {
  for theme in &catalog.themes {
    let (typography_id, changed): (Uuid, bool) = sqlx::query_as(
      r#"
      WITH upsert AS (
      INSERT INTO typography_sets (slug, name, origin, locked, updated_at)
      VALUES ($1, $2, 'system', true, now())
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        origin = 'system',
        locked = true,
        updated_at = now()
      WHERE typography_sets.name IS DISTINCT FROM EXCLUDED.name
         OR typography_sets.origin IS DISTINCT FROM 'system'
         OR typography_sets.locked IS DISTINCT FROM true
      RETURNING id, true AS changed
      )
      SELECT id, changed FROM upsert
      UNION ALL
      SELECT id, false AS changed FROM typography_sets
      WHERE slug = $1 AND NOT EXISTS (SELECT 1 FROM upsert)
      LIMIT 1
      "#,
    )
    .bind(&theme.typography_slug)
    .bind(&theme.name)
    .fetch_one(&mut **tx)
    .await
    .map_err(|err| repo_error("upsert typography set", err))?;
    if changed {
      stats.typography_sets += 1;
    }

    for style in &theme.typography_styles {
      let Some(font_family_id) = family_ids.get(&style.font_family) else {
        return Err(RepositoryError::Validation(format!(
          "theme `{}` style `{}` references unknown font family `{}`",
          theme.slug, style.style_key, style.font_family
        )));
      };
      let done = sqlx::query(
        r#"
        INSERT INTO typography_styles (
          typography_id, style_key, font_family_id, font_weight, font_style,
          size_px, line_height, letter_spacing_em, text_transform, decoration,
          hover_decoration, font_features, font_variations, pdf_role
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14)
        ON CONFLICT (typography_id, style_key) DO UPDATE SET
          font_family_id = EXCLUDED.font_family_id,
          font_weight = EXCLUDED.font_weight,
          font_style = EXCLUDED.font_style,
          size_px = EXCLUDED.size_px,
          line_height = EXCLUDED.line_height,
          letter_spacing_em = EXCLUDED.letter_spacing_em,
          text_transform = EXCLUDED.text_transform,
          decoration = EXCLUDED.decoration,
          hover_decoration = EXCLUDED.hover_decoration,
          font_features = EXCLUDED.font_features,
          font_variations = EXCLUDED.font_variations,
          pdf_role = EXCLUDED.pdf_role
        WHERE typography_styles.font_family_id IS DISTINCT FROM EXCLUDED.font_family_id
           OR typography_styles.font_weight IS DISTINCT FROM EXCLUDED.font_weight
           OR typography_styles.font_style IS DISTINCT FROM EXCLUDED.font_style
           OR typography_styles.size_px IS DISTINCT FROM EXCLUDED.size_px
           OR typography_styles.line_height IS DISTINCT FROM EXCLUDED.line_height
           OR typography_styles.letter_spacing_em IS DISTINCT FROM EXCLUDED.letter_spacing_em
           OR typography_styles.text_transform IS DISTINCT FROM EXCLUDED.text_transform
           OR typography_styles.decoration IS DISTINCT FROM EXCLUDED.decoration
           OR typography_styles.hover_decoration IS DISTINCT FROM EXCLUDED.hover_decoration
           OR typography_styles.font_features IS DISTINCT FROM EXCLUDED.font_features
           OR typography_styles.font_variations IS DISTINCT FROM EXCLUDED.font_variations
           OR typography_styles.pdf_role IS DISTINCT FROM EXCLUDED.pdf_role
        "#,
      )
      .bind(typography_id)
      .bind(&style.style_key)
      .bind(*font_family_id)
      .bind(style.font_weight)
      .bind(&style.font_style)
      .bind(style.size_px)
      .bind(style.line_height)
      .bind(style.letter_spacing_em)
      .bind(&style.text_transform)
      .bind(&style.decoration)
      .bind(&style.hover_decoration)
      .bind(style.font_features.to_string())
      .bind(style.font_variations.to_string())
      .bind(&style.pdf_role)
      .execute(&mut **tx)
      .await
      .map_err(|err| repo_error("insert typography style", err))?;
      if done.rows_affected() > 0 {
        stats.typography_styles += 1;
      }
    }
  }
  Ok(())
}

async fn seed_themes(
  tx: &mut Transaction<'_, Postgres>,
  catalog: &ThemeCatalog,
  stats: &mut ThemeBrandingSeedStats,
) -> Result<Uuid, RepositoryError> {
  let mut default_theme_id = None;
  for theme in &catalog.themes {
    let color_schema_id: Uuid = sqlx::query_scalar("SELECT id FROM color_schemas WHERE slug = $1")
      .bind(&theme.color_schema_slug)
      .fetch_one(&mut **tx)
      .await
      .map_err(|err| repo_error("select color schema for theme", err))?;
    let typography_id: Uuid = sqlx::query_scalar("SELECT id FROM typography_sets WHERE slug = $1")
      .bind(&theme.typography_slug)
      .fetch_one(&mut **tx)
      .await
      .map_err(|err| repo_error("select typography set for theme", err))?;
    let (theme_id, changed): (Uuid, bool) = sqlx::query_as(
      r#"
      WITH upsert AS (
      INSERT INTO themes (
        slug, name, origin, locked, color_schema_id, typography_id, is_default,
        category, preview_group, preview_order, tagline_key, description_key,
        updated_at
      )
      VALUES ($1, $2, 'system', true, $3, $4, $5, $6, $7, $8, $9, $10, now())
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        origin = 'system',
        locked = true,
        color_schema_id = EXCLUDED.color_schema_id,
        typography_id = EXCLUDED.typography_id,
        is_default = EXCLUDED.is_default,
        category = EXCLUDED.category,
        preview_group = EXCLUDED.preview_group,
        preview_order = EXCLUDED.preview_order,
        tagline_key = EXCLUDED.tagline_key,
        description_key = EXCLUDED.description_key,
        updated_at = now()
      WHERE themes.name IS DISTINCT FROM EXCLUDED.name
         OR themes.origin IS DISTINCT FROM 'system'
         OR themes.locked IS DISTINCT FROM true
         OR themes.color_schema_id IS DISTINCT FROM EXCLUDED.color_schema_id
         OR themes.typography_id IS DISTINCT FROM EXCLUDED.typography_id
         OR themes.is_default IS DISTINCT FROM EXCLUDED.is_default
         OR themes.category IS DISTINCT FROM EXCLUDED.category
         OR themes.preview_group IS DISTINCT FROM EXCLUDED.preview_group
         OR themes.preview_order IS DISTINCT FROM EXCLUDED.preview_order
         OR themes.tagline_key IS DISTINCT FROM EXCLUDED.tagline_key
         OR themes.description_key IS DISTINCT FROM EXCLUDED.description_key
      RETURNING id, true AS changed
      )
      SELECT id, changed FROM upsert
      UNION ALL
      SELECT id, false AS changed FROM themes
      WHERE slug = $1 AND NOT EXISTS (SELECT 1 FROM upsert)
      LIMIT 1
      "#,
    )
    .bind(&theme.slug)
    .bind(&theme.name)
    .bind(color_schema_id)
    .bind(typography_id)
    .bind(theme.is_default)
    .bind(&theme.category)
    .bind(&theme.preview_group)
    .bind(theme.preview_order)
    .bind(&theme.tagline_key)
    .bind(&theme.description_key)
    .fetch_one(&mut **tx)
    .await
    .map_err(|err| repo_error("upsert theme", err))?;
    if changed {
      stats.themes += 1;
    }
    if theme.is_default {
      default_theme_id = Some(theme_id);
    }
  }
  default_theme_id.ok_or_else(|| RepositoryError::Validation("theme catalog has no default theme".to_string()))
}

async fn seed_global_theme_profile(
  tx: &mut Transaction<'_, Postgres>,
  default_theme_id: Uuid,
) -> Result<bool, RepositoryError> {
  let existing: Option<Uuid> = sqlx::query_scalar("SELECT id FROM theme_profiles WHERE scope = 'global' LIMIT 1")
    .fetch_optional(&mut **tx)
    .await
    .map_err(|err| repo_error("select global theme profile", err))?;
  if existing.is_some() {
    return Ok(false);
  }
  sqlx::query("INSERT INTO theme_profiles (scope, theme_id, theme_mode) VALUES ('global', $1, 'system')")
    .bind(default_theme_id)
    .execute(&mut **tx)
    .await
    .map_err(|err| repo_error("insert global theme profile", err))?;
  Ok(true)
}

async fn seed_global_brand_identity_boundaries(tx: &mut Transaction<'_, Postgres>) -> Result<(), RepositoryError> {
  sqlx::query("INSERT INTO organization_identity (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING")
    .execute(&mut **tx)
    .await
    .map_err(|err| repo_error("ensure organization identity singleton", err))?;
  sqlx::query("INSERT INTO app_server_branding (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING")
    .execute(&mut **tx)
    .await
    .map_err(|err| repo_error("ensure app/server branding singleton", err))?;
  sqlx::query(
    r#"
    INSERT INTO document_brand_profiles (scope, color_policy, color_palette_key)
    VALUES ('global', 'theme_palette', 'balanced')
    ON CONFLICT DO NOTHING
    "#,
  )
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("ensure global document brand profile", err))?;
  sqlx::query(
    r#"
    INSERT INTO pdf_export_settings (scope)
    VALUES ('global')
    ON CONFLICT DO NOTHING
    "#,
  )
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("ensure global pdf export settings", err))?;
  Ok(())
}

async fn seed_document_theme_color_palettes(tx: &mut Transaction<'_, Postgres>) -> Result<(), RepositoryError> {
  sqlx::query(
    r#"
    WITH palette_defs(palette_key, name, primary_token, accent_token, rule_token, text_token, background_token, is_default) AS (
      VALUES
        ('balanced', 'Balanced', 'accent-primary', 'accent-secondary', 'rule', 'ink', 'paper', TRUE),
        ('muted', 'Muted', 'ink-soft', 'accent-secondary', 'rule', 'ink', 'paper', FALSE),
        ('accent_line', 'Accent line', 'accent-primary', 'accent-primary', 'accent-primary', 'ink', 'paper', FALSE),
        ('plain', 'Plain', 'ink', 'ink-soft', 'rule', 'ink', 'paper', FALSE)
    )
    INSERT INTO document_theme_color_palettes (
      theme_id, palette_key, name, primary_color, accent_color, rule_color,
      text_color, background_color, is_default, updated_at
    )
    SELECT
      t.id,
      d.palette_key,
      d.name,
      MAX(csv.value) FILTER (WHERE csv.token_key = d.primary_token),
      MAX(csv.value) FILTER (WHERE csv.token_key = d.accent_token),
      MAX(csv.value) FILTER (WHERE csv.token_key = d.rule_token),
      MAX(csv.value) FILTER (WHERE csv.token_key = d.text_token),
      MAX(csv.value) FILTER (WHERE csv.token_key = d.background_token),
      d.is_default,
      now()
    FROM themes t
    JOIN color_schema_values csv ON csv.schema_id = t.color_schema_id AND csv.mode = 'light'
    CROSS JOIN palette_defs d
    GROUP BY t.id, d.palette_key, d.name, d.is_default
    HAVING MAX(csv.value) FILTER (WHERE csv.token_key = d.primary_token) IS NOT NULL
       AND MAX(csv.value) FILTER (WHERE csv.token_key = d.accent_token) IS NOT NULL
       AND MAX(csv.value) FILTER (WHERE csv.token_key = d.rule_token) IS NOT NULL
       AND MAX(csv.value) FILTER (WHERE csv.token_key = d.text_token) IS NOT NULL
       AND MAX(csv.value) FILTER (WHERE csv.token_key = d.background_token) IS NOT NULL
    ON CONFLICT (theme_id, palette_key) DO UPDATE SET
      name = EXCLUDED.name,
      primary_color = EXCLUDED.primary_color,
      accent_color = EXCLUDED.accent_color,
      rule_color = EXCLUDED.rule_color,
      text_color = EXCLUDED.text_color,
      background_color = EXCLUDED.background_color,
      is_default = EXCLUDED.is_default,
      updated_at = now()
    WHERE document_theme_color_palettes.name IS DISTINCT FROM EXCLUDED.name
       OR document_theme_color_palettes.primary_color IS DISTINCT FROM EXCLUDED.primary_color
       OR document_theme_color_palettes.accent_color IS DISTINCT FROM EXCLUDED.accent_color
       OR document_theme_color_palettes.rule_color IS DISTINCT FROM EXCLUDED.rule_color
       OR document_theme_color_palettes.text_color IS DISTINCT FROM EXCLUDED.text_color
       OR document_theme_color_palettes.background_color IS DISTINCT FROM EXCLUDED.background_color
       OR document_theme_color_palettes.is_default IS DISTINCT FROM EXCLUDED.is_default
    "#,
  )
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("seed document theme color palettes", err))?;
  Ok(())
}

#[instrument(skip(pool), err)]
pub async fn list_font_families(
  pool: &PgPool,
  selectable_only: bool,
) -> Result<Vec<FontFamilyProjection>, RepositoryError> {
  let families = sqlx::query(
    r#"
    SELECT slug, display_name, css_family, generic_class, source, license_spdx,
           license_status, is_selectable
    FROM font_families
    WHERE ($1 = FALSE OR is_selectable = TRUE)
    ORDER BY display_name ASC
    "#,
  )
  .bind(selectable_only)
  .fetch_all(pool)
  .await
  .map_err(|err| repo_error("list font families", err))?;

  let mut out = Vec::with_capacity(families.len());
  for family in families {
    let slug: String = family.get("slug");
    let assets = sqlx::query(
      r#"
      SELECT fa.usage, fa.format, fa.style, fa.weight_min, fa.weight_max,
             fa.weight_default, fa.asset_key, fa.sha256, fa.mime,
             fa.unicode_ranges, fa.subset_tags
      FROM font_assets fa
      JOIN font_families ff ON ff.id = fa.family_id
      WHERE ff.slug = $1
      ORDER BY fa.usage, fa.style, fa.weight_min, fa.weight_max, fa.asset_key
      "#,
    )
    .bind(&slug)
    .fetch_all(pool)
    .await
    .map_err(|err| repo_error("list font assets", err))?
    .into_iter()
    .map(|row| FontAssetProjection {
      usage: row.get("usage"),
      format: row.get("format"),
      style: row.get("style"),
      weight_min: row.get("weight_min"),
      weight_max: row.get("weight_max"),
      weight_default: row.get("weight_default"),
      asset_key: row.get("asset_key"),
      sha256: row.get("sha256"),
      mime: row.get("mime"),
      unicode_ranges: jsonb_string_array(row.get("unicode_ranges")),
      subset_tags: jsonb_string_array(row.get("subset_tags")),
    })
    .collect();

    out.push(FontFamilyProjection {
      slug,
      display_name: family.get("display_name"),
      css_family: family.get("css_family"),
      generic_class: family.get("generic_class"),
      source: family.get("source"),
      license_spdx: family.get("license_spdx"),
      license_status: family.get("license_status"),
      is_selectable: family.get("is_selectable"),
      assets,
    });
  }

  debug!(
    count = out.len(),
    selectable_only, "loaded font family catalog from database"
  );
  Ok(out)
}

#[instrument(skip(pool), err)]
pub async fn load_effective_theme_profile(
  pool: &PgPool,
  workspace_id: Option<Uuid>,
) -> Result<ThemeProfileProjection, RepositoryError> {
  ensure_workspace_exists(pool, workspace_id).await?;

  let profile = sqlx::query(
    r#"
    SELECT bp.id, bp.scope, bp.workspace_id, bp.theme_mode,
           t.slug AS theme_slug, t.name AS theme_name, t.origin AS theme_origin,
           t.category AS theme_category, t.preview_group AS theme_preview_group,
           t.preview_order AS theme_preview_order, t.tagline_key AS theme_tagline_key,
           t.description_key AS theme_description_key,
           t.locked AS theme_locked, t.is_default,
           cs.slug AS color_schema_slug, ts.slug AS typography_slug
    FROM theme_profiles bp
    JOIN themes t ON t.id = bp.theme_id
    JOIN color_schemas cs ON cs.id = t.color_schema_id
    JOIN typography_sets ts ON ts.id = t.typography_id
    WHERE (bp.scope = 'workspace' AND bp.workspace_id = $1)
       OR (bp.scope = 'global' AND $1::uuid IS NULL)
       OR (bp.scope = 'global' AND NOT EXISTS (
            SELECT 1 FROM theme_profiles wbp
            WHERE wbp.scope = 'workspace' AND wbp.workspace_id = $1
          ))
    ORDER BY CASE WHEN bp.scope = 'workspace' THEN 0 ELSE 1 END
    LIMIT 1
    "#,
  )
  .bind(workspace_id)
  .fetch_optional(pool)
  .await
  .map_err(|err| repo_error("load effective theme profile", err))?
  .ok_or(RepositoryError::NotFound("theme profile"))?;

  let color_schema_slug: String = profile.get("color_schema_slug");
  let typography_slug: String = profile.get("typography_slug");
  let colors = load_color_values(pool, &color_schema_slug).await?;
  let typography_styles = load_typography_styles(pool, &typography_slug).await?;

  Ok(ThemeProfileProjection {
    scope: profile.get("scope"),
    workspace_id: profile.get("workspace_id"),
    theme_mode: profile.get("theme_mode"),
    theme: ThemeProjection {
      slug: profile.get("theme_slug"),
      name: profile.get("theme_name"),
      category: profile.get("theme_category"),
      preview_group: profile.get("theme_preview_group"),
      preview_order: profile.get("theme_preview_order"),
      tagline_key: profile.get("theme_tagline_key"),
      description_key: profile.get("theme_description_key"),
      origin: profile.get("theme_origin"),
      locked: profile.get("theme_locked"),
      is_default: profile.get("is_default"),
      color_schema_slug,
      typography_slug,
      colors,
      typography_styles,
    },
  })
}

#[instrument(skip(pool), err)]
async fn ensure_workspace_exists(pool: &PgPool, workspace_id: Option<Uuid>) -> Result<(), RepositoryError> {
  let Some(workspace_id) = workspace_id else {
    return Ok(());
  };
  let exists: bool = sqlx::query_scalar(
    "SELECT EXISTS(
       SELECT 1 FROM workspaces
        WHERE id = $1
          AND lifecycle_state = 'active'
          AND deleted_at IS NULL
     )",
  )
  .bind(workspace_id)
  .fetch_one(pool)
  .await
  .map_err(|err| repo_error("check workspace before theme profile lookup", err))?;
  if !exists {
    return Err(RepositoryError::NotFound("workspace"));
  }
  Ok(())
}

#[instrument(skip(pool), err)]
pub async fn list_themes(pool: &PgPool) -> Result<Vec<ThemeProjection>, RepositoryError> {
  let rows = sqlx::query(
    r#"
    SELECT t.slug, t.name, t.category, t.preview_group, t.preview_order,
           t.tagline_key, t.description_key, t.origin, t.locked, t.is_default,
           cs.slug AS color_schema_slug, ts.slug AS typography_slug
    FROM themes t
    JOIN color_schemas cs ON cs.id = t.color_schema_id
    JOIN typography_sets ts ON ts.id = t.typography_id
    WHERE t.origin <> 'workspace'
    ORDER BY CASE WHEN t.origin = 'system' THEN 0 ELSE 1 END,
             NULLIF(t.preview_order, 0) ASC NULLS LAST,
             t.name ASC
    "#,
  )
  .fetch_all(pool)
  .await
  .map_err(|err| repo_error("list themes", err))?;

  let mut out = Vec::with_capacity(rows.len());
  for row in rows {
    let color_schema_slug: String = row.get("color_schema_slug");
    let typography_slug: String = row.get("typography_slug");
    out.push(ThemeProjection {
      slug: row.get("slug"),
      name: row.get("name"),
      category: row.get("category"),
      preview_group: row.get("preview_group"),
      preview_order: row.get("preview_order"),
      tagline_key: row.get("tagline_key"),
      description_key: row.get("description_key"),
      origin: row.get("origin"),
      locked: row.get("locked"),
      is_default: row.get("is_default"),
      color_schema_slug: color_schema_slug.clone(),
      typography_slug: typography_slug.clone(),
      colors: load_color_values(pool, &color_schema_slug).await?,
      typography_styles: load_typography_styles(pool, &typography_slug).await?,
    });
  }
  debug!(count = out.len(), "loaded theme catalog from database");
  Ok(out)
}

#[instrument(skip(pool), err)]
pub async fn set_theme_profile(
  pool: &PgPool,
  workspace_id: Option<Uuid>,
  theme_slug: &str,
  theme_mode: &str,
  updated_by: Option<Uuid>,
) -> Result<ThemeProfileProjection, RepositoryError> {
  ensure_workspace_exists(pool, workspace_id).await?;

  if !matches!(theme_mode, "light" | "dark" | "system") {
    return Err(RepositoryError::Validation(format!(
      "theme_mode `{theme_mode}` is invalid; expected light, dark or system"
    )));
  }
  let theme_row = sqlx::query("SELECT id, origin FROM themes WHERE slug = $1")
    .bind(theme_slug)
    .fetch_optional(pool)
    .await
    .map_err(|err| repo_error("select branding theme", err))?
    .ok_or(RepositoryError::NotFound("theme"))?;
  let theme_id: Uuid = theme_row.get("id");
  let theme_origin: String = theme_row.get("origin");
  validate_selectable_theme(pool, workspace_id, theme_id, &theme_origin).await?;

  match workspace_id {
    None => {
      let updated = sqlx::query(
        r#"
        UPDATE theme_profiles
        SET theme_id = $1, theme_mode = $2, updated_by = $3, updated_at = now()
        WHERE scope = 'global'
        "#,
      )
      .bind(theme_id)
      .bind(theme_mode)
      .bind(updated_by)
      .execute(pool)
      .await
      .map_err(|err| repo_error("update global theme profile", err))?;
      if updated.rows_affected() == 0 {
        sqlx::query(
          "INSERT INTO theme_profiles (scope, theme_id, theme_mode, updated_by) VALUES ('global', $1, $2, $3)",
        )
        .bind(theme_id)
        .bind(theme_mode)
        .bind(updated_by)
        .execute(pool)
        .await
        .map_err(|err| repo_error("insert global theme profile", err))?;
      }
    }
    Some(workspace_id) => {
      sqlx::query(
        r#"
        INSERT INTO theme_profiles (scope, workspace_id, theme_id, theme_mode, updated_by)
        VALUES ('workspace', $1, $2, $3, $4)
        ON CONFLICT (workspace_id) WHERE scope = 'workspace'
        DO UPDATE SET
          theme_id = EXCLUDED.theme_id,
          theme_mode = EXCLUDED.theme_mode,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
        "#,
      )
      .bind(workspace_id)
      .bind(theme_id)
      .bind(theme_mode)
      .bind(updated_by)
      .execute(pool)
      .await
      .map_err(|err| repo_error("upsert workspace theme profile", err))?;
    }
  }

  load_effective_theme_profile(pool, workspace_id).await
}

/// Select an existing catalog theme without changing the workspace profile's
/// color-mode policy.
///
/// User-facing personal-workspace selection owns only `theme_id`. If no
/// workspace profile exists yet, the insert inherits the current global
/// profile mode; later selections retain the workspace row's existing mode.
#[instrument(skip(pool), err)]
pub async fn select_workspace_theme(
  pool: &PgPool,
  workspace_id: Uuid,
  theme_slug: &str,
  updated_by: Option<Uuid>,
) -> Result<ThemeProfileProjection, RepositoryError> {
  ensure_workspace_exists(pool, Some(workspace_id)).await?;
  let theme_row = sqlx::query("SELECT id, origin FROM themes WHERE slug = $1")
    .bind(theme_slug)
    .fetch_optional(pool)
    .await
    .map_err(|err| repo_error("select workspace theme", err))?
    .ok_or(RepositoryError::NotFound("theme"))?;
  let theme_id: Uuid = theme_row.get("id");
  let theme_origin: String = theme_row.get("origin");
  validate_selectable_theme(pool, Some(workspace_id), theme_id, &theme_origin).await?;

  sqlx::query(
    r#"
    INSERT INTO theme_profiles (scope, workspace_id, theme_id, theme_mode, updated_by)
    VALUES (
      'workspace',
      $1,
      $2,
      COALESCE(
        (SELECT theme_mode
         FROM theme_profiles
         WHERE scope = 'global'
         LIMIT 1),
        'system'
      ),
      $3
    )
    ON CONFLICT (workspace_id) WHERE scope = 'workspace'
    DO UPDATE SET
      theme_id = EXCLUDED.theme_id,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
    "#,
  )
  .bind(workspace_id)
  .bind(theme_id)
  .bind(updated_by)
  .execute(pool)
  .await
  .map_err(|err| repo_error("select workspace theme profile", err))?;

  load_effective_theme_profile(pool, Some(workspace_id)).await
}

async fn validate_selectable_theme(
  pool: &PgPool,
  workspace_id: Option<Uuid>,
  theme_id: Uuid,
  theme_origin: &str,
) -> Result<(), RepositoryError> {
  if theme_origin != "workspace" {
    return Ok(());
  }
  let Some(workspace_id) = workspace_id else {
    return Err(RepositoryError::Validation(
      "workspace-origin themes are not selectable for the global theme profile".to_string(),
    ));
  };
  let owns_theme: bool = sqlx::query_scalar(
    r#"
    SELECT EXISTS(
      SELECT 1
      FROM theme_profiles
      WHERE scope = 'workspace'
        AND workspace_id = $1
        AND theme_id = $2
    )
    "#,
  )
  .bind(workspace_id)
  .bind(theme_id)
  .fetch_one(pool)
  .await
  .map_err(|err| repo_error("validate workspace theme ownership", err))?;
  if owns_theme {
    return Ok(());
  }
  Err(RepositoryError::Validation(
    "workspace-origin themes are private clone-on-write records and cannot be selected by another scope".to_string(),
  ))
}

#[instrument(skip(pool), err)]
pub async fn reset_workspace_theme_profile(
  pool: &PgPool,
  workspace_id: Uuid,
  updated_by: Option<Uuid>,
) -> Result<ThemeProfileProjection, RepositoryError> {
  ensure_workspace_exists(pool, Some(workspace_id)).await?;
  let mut tx = pool
    .begin()
    .await
    .map_err(|err| repo_error("begin workspace theme profile reset", err))?;
  let deleted = sqlx::query(
    r#"
    DELETE FROM theme_profiles
    WHERE scope = 'workspace' AND workspace_id = $1
    "#,
  )
  .bind(workspace_id)
  .execute(&mut *tx)
  .await
  .map_err(|err| repo_error("reset workspace theme profile", err))?;
  let cleanup = cleanup_orphaned_workspace_theme_override_rows(&mut tx).await?;
  tx.commit()
    .await
    .map_err(|err| repo_error("commit workspace theme profile reset", err))?;

  info!(
    workspace_id = %workspace_id,
    updated_by = ?updated_by,
    deleted_profiles = deleted.rows_affected(),
    deleted_themes = cleanup.themes,
    deleted_color_schemas = cleanup.color_schemas,
    deleted_typography_sets = cleanup.typography_sets,
    "workspace theme profile reset to global inheritance"
  );

  load_effective_theme_profile(pool, Some(workspace_id)).await
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct OrphanThemeOverrideCleanup {
  pub(crate) themes: u64,
  pub(crate) color_schemas: u64,
  pub(crate) typography_sets: u64,
}

pub(crate) async fn cleanup_orphaned_workspace_theme_override_rows(
  tx: &mut Transaction<'_, Postgres>,
) -> Result<OrphanThemeOverrideCleanup, RepositoryError> {
  // Workspace overrides are clone-on-write rows. Once the workspace profile is
  // deleted, those rows must not linger as pseudo-catalog entries.
  let themes = sqlx::query(
    r#"
    DELETE FROM themes t
    WHERE t.origin = 'workspace'
      AND NOT EXISTS (
        SELECT 1
        FROM theme_profiles bp
        WHERE bp.theme_id = t.id
      )
    "#,
  )
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("delete orphaned workspace themes", err))?
  .rows_affected();

  let color_schemas = sqlx::query(
    r#"
    DELETE FROM color_schemas cs
    WHERE cs.origin = 'workspace'
      AND NOT EXISTS (
        SELECT 1
        FROM themes t
        WHERE t.color_schema_id = cs.id
      )
    "#,
  )
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("delete orphaned workspace color schemas", err))?
  .rows_affected();

  let typography_sets = sqlx::query(
    r#"
    DELETE FROM typography_sets ts
    WHERE ts.origin = 'workspace'
      AND NOT EXISTS (
        SELECT 1
        FROM themes t
        WHERE t.typography_id = ts.id
      )
    "#,
  )
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("delete orphaned workspace typography sets", err))?
  .rows_affected();

  Ok(OrphanThemeOverrideCleanup {
    themes,
    color_schemas,
    typography_sets,
  })
}

#[instrument(skip(pool, updates), fields(update_count = updates.len()), err)]
pub async fn set_theme_profile_typography_styles(
  pool: &PgPool,
  workspace_id: Option<Uuid>,
  updates: Vec<TypographyStyleUpdate>,
  updated_by: Option<Uuid>,
) -> Result<ThemeProfileProjection, RepositoryError> {
  ensure_workspace_exists(pool, workspace_id).await?;

  if updates.is_empty() {
    return Err(RepositoryError::Validation(
      "at least one typography style update is required".to_string(),
    ));
  }

  let mut seen = std::collections::BTreeSet::new();
  for update in &updates {
    let style_key = update.style_key.trim();
    if style_key.is_empty() {
      return Err(RepositoryError::Validation(
        "typography style_key must not be empty".to_string(),
      ));
    }
    if !seen.insert(style_key.to_string()) {
      return Err(RepositoryError::Validation(format!(
        "duplicate typography style_key `{style_key}` in update request"
      )));
    }
  }

  let mut tx = pool
    .begin()
    .await
    .map_err(|err| repo_error("begin typography style update", err))?;
  ensure_target_theme_profile(&mut tx, workspace_id, updated_by).await?;
  let target = load_target_typography_for_update(&mut tx, workspace_id).await?;
  let target_origin = if workspace_id.is_some() { "workspace" } else { "custom" };
  let editable = ensure_editable_typography_set(&mut tx, &target, target_origin, updated_by).await?;

  for update in &updates {
    apply_typography_style_update(&mut tx, editable.typography_id, update).await?;
  }

  tx.commit()
    .await
    .map_err(|err| repo_error("commit typography style update", err))?;

  let profile = load_effective_theme_profile(pool, workspace_id).await?;
  info!(
    workspace_id = ?workspace_id,
    theme_slug = %profile.theme.slug,
    typography_slug = %profile.theme.typography_slug,
    update_count = updates.len(),
    "theme profile typography styles updated"
  );
  Ok(profile)
}

#[instrument(skip(pool, updates), fields(update_count = updates.len()), err)]
pub async fn set_theme_profile_color_values(
  pool: &PgPool,
  workspace_id: Option<Uuid>,
  updates: Vec<ColorValueUpdate>,
  updated_by: Option<Uuid>,
) -> Result<ThemeProfileProjection, RepositoryError> {
  ensure_workspace_exists(pool, workspace_id).await?;

  if updates.is_empty() {
    return Err(RepositoryError::Validation(
      "at least one color schema update is required".to_string(),
    ));
  }

  let allowed_tokens = required_color_tokens()?;
  let mut seen = BTreeSet::new();
  let mut normalized = Vec::with_capacity(updates.len());
  for update in updates {
    let mode = validate_color_mode(&update.mode)?;
    let token_key = validate_color_token(&update.token_key, &allowed_tokens)?;
    let value = validate_color_value(&update.value)?;
    if !seen.insert((mode.clone(), token_key.clone())) {
      return Err(RepositoryError::Validation(format!(
        "duplicate color token `{mode}.{token_key}` in update request"
      )));
    }
    normalized.push(ColorValueUpdate { mode, token_key, value });
  }

  let mut tx = pool
    .begin()
    .await
    .map_err(|err| repo_error("begin color schema update", err))?;
  ensure_target_theme_profile(&mut tx, workspace_id, updated_by).await?;
  let target = load_target_color_schema_for_update(&mut tx, workspace_id).await?;
  let target_origin = if workspace_id.is_some() { "workspace" } else { "custom" };
  let editable = ensure_editable_color_schema(&mut tx, &target, target_origin, updated_by).await?;

  for update in &normalized {
    apply_color_value_update(&mut tx, editable.color_schema_id, update).await?;
  }

  tx.commit()
    .await
    .map_err(|err| repo_error("commit color schema update", err))?;

  let profile = load_effective_theme_profile(pool, workspace_id).await?;
  info!(
    workspace_id = ?workspace_id,
    theme_slug = %profile.theme.slug,
    color_schema_slug = %profile.theme.color_schema_slug,
    update_count = normalized.len(),
    "theme profile color schema values updated"
  );
  Ok(profile)
}

#[derive(Debug, Clone)]
struct TargetTypographyContext {
  profile_id: Uuid,
  theme_id: Uuid,
  theme_slug: String,
  theme_name: String,
  theme_category: Option<String>,
  theme_preview_group: Option<String>,
  theme_preview_order: i32,
  theme_tagline_key: Option<String>,
  theme_description_key: Option<String>,
  theme_origin: String,
  theme_locked: bool,
  color_schema_id: Uuid,
  typography_id: Uuid,
  typography_slug: String,
  typography_name: String,
  typography_origin: String,
  typography_locked: bool,
}

#[derive(Debug, Clone)]
struct TargetColorSchemaContext {
  profile_id: Uuid,
  theme_id: Uuid,
  theme_slug: String,
  theme_name: String,
  theme_category: Option<String>,
  theme_preview_group: Option<String>,
  theme_preview_order: i32,
  theme_tagline_key: Option<String>,
  theme_description_key: Option<String>,
  theme_origin: String,
  theme_locked: bool,
  color_schema_id: Uuid,
  color_schema_slug: String,
  color_schema_name: String,
  color_schema_origin: String,
  color_schema_locked: bool,
  typography_id: Uuid,
}

#[derive(Debug, Clone)]
struct EditableTypographyTarget {
  typography_id: Uuid,
}

#[derive(Debug, Clone)]
struct EditableColorSchemaTarget {
  color_schema_id: Uuid,
}

async fn ensure_target_theme_profile(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: Option<Uuid>,
  updated_by: Option<Uuid>,
) -> Result<(), RepositoryError> {
  if let Some(workspace_id) = workspace_id {
    let inserted = sqlx::query(
      r#"
      INSERT INTO theme_profiles (scope, workspace_id, theme_id, theme_mode, updated_by)
      SELECT 'workspace', $1, theme_id, theme_mode, $2
      FROM theme_profiles
      WHERE scope = 'global'
      ON CONFLICT (workspace_id) WHERE scope = 'workspace'
      DO NOTHING
      "#,
    )
    .bind(workspace_id)
    .bind(updated_by)
    .execute(&mut **tx)
    .await
    .map_err(|err| repo_error("ensure workspace theme profile", err))?;
    debug!(
      workspace_id = %workspace_id,
      inserted = inserted.rows_affected(),
      "ensured workspace theme profile before typography edit"
    );
  }
  Ok(())
}

async fn load_target_typography_for_update(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: Option<Uuid>,
) -> Result<TargetTypographyContext, RepositoryError> {
  let row = sqlx::query(
    r#"
    SELECT bp.id AS profile_id,
           t.id AS theme_id, t.slug AS theme_slug, t.name AS theme_name,
           t.category AS theme_category, t.preview_group AS theme_preview_group,
           t.preview_order AS theme_preview_order, t.tagline_key AS theme_tagline_key,
           t.description_key AS theme_description_key,
           t.origin AS theme_origin, t.locked AS theme_locked,
           t.color_schema_id,
           ts.id AS typography_id, ts.slug AS typography_slug,
           ts.name AS typography_name, ts.origin AS typography_origin,
           ts.locked AS typography_locked
    FROM theme_profiles bp
    JOIN themes t ON t.id = bp.theme_id
    JOIN typography_sets ts ON ts.id = t.typography_id
    WHERE ($1::uuid IS NULL AND bp.scope = 'global')
       OR ($1::uuid IS NOT NULL AND bp.scope = 'workspace' AND bp.workspace_id = $1)
    LIMIT 1
    FOR UPDATE OF bp
    "#,
  )
  .bind(workspace_id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(|err| repo_error("load target typography profile", err))?
  .ok_or(RepositoryError::NotFound("theme profile"))?;

  Ok(TargetTypographyContext {
    profile_id: row.get("profile_id"),
    theme_id: row.get("theme_id"),
    theme_slug: row.get("theme_slug"),
    theme_name: row.get("theme_name"),
    theme_category: row.get("theme_category"),
    theme_preview_group: row.get("theme_preview_group"),
    theme_preview_order: row.get("theme_preview_order"),
    theme_tagline_key: row.get("theme_tagline_key"),
    theme_description_key: row.get("theme_description_key"),
    theme_origin: row.get("theme_origin"),
    theme_locked: row.get("theme_locked"),
    color_schema_id: row.get("color_schema_id"),
    typography_id: row.get("typography_id"),
    typography_slug: row.get("typography_slug"),
    typography_name: row.get("typography_name"),
    typography_origin: row.get("typography_origin"),
    typography_locked: row.get("typography_locked"),
  })
}

async fn load_target_color_schema_for_update(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: Option<Uuid>,
) -> Result<TargetColorSchemaContext, RepositoryError> {
  let row = sqlx::query(
    r#"
    SELECT bp.id AS profile_id,
           t.id AS theme_id, t.slug AS theme_slug, t.name AS theme_name,
           t.category AS theme_category, t.preview_group AS theme_preview_group,
           t.preview_order AS theme_preview_order, t.tagline_key AS theme_tagline_key,
           t.description_key AS theme_description_key,
           t.origin AS theme_origin, t.locked AS theme_locked,
           cs.id AS color_schema_id, cs.slug AS color_schema_slug,
           cs.name AS color_schema_name, cs.origin AS color_schema_origin,
           cs.locked AS color_schema_locked,
           t.typography_id
    FROM theme_profiles bp
    JOIN themes t ON t.id = bp.theme_id
    JOIN color_schemas cs ON cs.id = t.color_schema_id
    WHERE ($1::uuid IS NULL AND bp.scope = 'global')
       OR ($1::uuid IS NOT NULL AND bp.scope = 'workspace' AND bp.workspace_id = $1)
    LIMIT 1
    FOR UPDATE OF bp
    "#,
  )
  .bind(workspace_id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(|err| repo_error("load target color schema profile", err))?
  .ok_or(RepositoryError::NotFound("theme profile"))?;

  Ok(TargetColorSchemaContext {
    profile_id: row.get("profile_id"),
    theme_id: row.get("theme_id"),
    theme_slug: row.get("theme_slug"),
    theme_name: row.get("theme_name"),
    theme_category: row.get("theme_category"),
    theme_preview_group: row.get("theme_preview_group"),
    theme_preview_order: row.get("theme_preview_order"),
    theme_tagline_key: row.get("theme_tagline_key"),
    theme_description_key: row.get("theme_description_key"),
    theme_origin: row.get("theme_origin"),
    theme_locked: row.get("theme_locked"),
    color_schema_id: row.get("color_schema_id"),
    color_schema_slug: row.get("color_schema_slug"),
    color_schema_name: row.get("color_schema_name"),
    color_schema_origin: row.get("color_schema_origin"),
    color_schema_locked: row.get("color_schema_locked"),
    typography_id: row.get("typography_id"),
  })
}

async fn ensure_editable_typography_set(
  tx: &mut Transaction<'_, Postgres>,
  target: &TargetTypographyContext,
  target_origin: &str,
  updated_by: Option<Uuid>,
) -> Result<EditableTypographyTarget, RepositoryError> {
  let profile_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM theme_profiles WHERE theme_id = $1")
    .bind(target.theme_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|err| repo_error("count theme profiles using theme", err))?;

  let can_update_in_place = !target.theme_locked
    && !target.typography_locked
    && target.theme_origin == target_origin
    && target.typography_origin == target_origin
    && profile_count == 1;

  if can_update_in_place {
    debug!(
      profile_id = %target.profile_id,
      theme_slug = %target.theme_slug,
      typography_slug = %target.typography_slug,
      "using existing unlocked typography set for edit"
    );
    return Ok(EditableTypographyTarget {
      typography_id: target.typography_id,
    });
  }

  let suffix = Uuid::new_v4().simple().to_string();
  let short = &suffix[..12];
  let typography_id = Uuid::new_v4();
  let typography_slug = format!("{}-{}-{}", target.typography_slug, target_origin, short);
  let typography_name = format!("{} Typography Override", target.typography_name);
  let theme_id = Uuid::new_v4();
  let theme_slug = format!("{}-{}-typography-{}", target.theme_slug, target_origin, short);
  let theme_name = format!("{} Typography Override", target.theme_name);

  sqlx::query(
    r#"
    INSERT INTO typography_sets (id, slug, name, origin, locked, created_by)
    VALUES ($1, $2, $3, $4, FALSE, $5)
    "#,
  )
  .bind(typography_id)
  .bind(&typography_slug)
  .bind(&typography_name)
  .bind(target_origin)
  .bind(updated_by)
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("insert typography clone", err))?;

  sqlx::query(
    r#"
    INSERT INTO typography_styles (
      typography_id, style_key, font_family_id, font_weight, font_style,
      font_stretch, size_px, line_height, letter_spacing_em, text_transform,
      decoration, hover_decoration, font_features, font_variations, pdf_role
    )
    SELECT $1, style_key, font_family_id, font_weight, font_style, font_stretch,
           size_px, line_height, letter_spacing_em, text_transform,
           decoration, hover_decoration, font_features, font_variations, pdf_role
    FROM typography_styles
    WHERE typography_id = $2
    "#,
  )
  .bind(typography_id)
  .bind(target.typography_id)
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("clone typography styles", err))?;

  sqlx::query(
    r#"
    INSERT INTO themes (
      id, slug, name, origin, locked, color_schema_id, typography_id,
      is_default, category, preview_group, preview_order, tagline_key,
      description_key, created_by
    )
    VALUES ($1, $2, $3, $4, FALSE, $5, $6, FALSE, $7, $8, $9, $10, $11, $12)
    "#,
  )
  .bind(theme_id)
  .bind(&theme_slug)
  .bind(&theme_name)
  .bind(target_origin)
  .bind(target.color_schema_id)
  .bind(typography_id)
  .bind(&target.theme_category)
  .bind(&target.theme_preview_group)
  .bind(target.theme_preview_order)
  .bind(&target.theme_tagline_key)
  .bind(&target.theme_description_key)
  .bind(updated_by)
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("insert typography override theme", err))?;

  sqlx::query("UPDATE theme_profiles SET theme_id = $1, updated_by = $2, updated_at = now() WHERE id = $3")
    .bind(theme_id)
    .bind(updated_by)
    .bind(target.profile_id)
    .execute(&mut **tx)
    .await
    .map_err(|err| repo_error("point theme profile at typography override", err))?;

  info!(
    profile_id = %target.profile_id,
    previous_theme_slug = %target.theme_slug,
    new_theme_slug = %theme_slug,
    previous_typography_slug = %target.typography_slug,
    new_typography_slug = %typography_slug,
    target_origin,
    "created clone-on-write typography override"
  );

  Ok(EditableTypographyTarget { typography_id })
}

async fn ensure_editable_color_schema(
  tx: &mut Transaction<'_, Postgres>,
  target: &TargetColorSchemaContext,
  target_origin: &str,
  updated_by: Option<Uuid>,
) -> Result<EditableColorSchemaTarget, RepositoryError> {
  let profile_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM theme_profiles WHERE theme_id = $1")
    .bind(target.theme_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|err| repo_error("count theme profiles using color theme", err))?;
  let theme_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM themes WHERE color_schema_id = $1")
    .bind(target.color_schema_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|err| repo_error("count themes using color schema", err))?;

  let can_update_in_place = !target.theme_locked
    && !target.color_schema_locked
    && target.theme_origin == target_origin
    && target.color_schema_origin == target_origin
    && profile_count == 1
    && theme_count == 1;

  if can_update_in_place {
    debug!(
      profile_id = %target.profile_id,
      theme_slug = %target.theme_slug,
      color_schema_slug = %target.color_schema_slug,
      profile_count,
      theme_count,
      "using existing unlocked color schema for edit"
    );
    return Ok(EditableColorSchemaTarget {
      color_schema_id: target.color_schema_id,
    });
  }

  let suffix = Uuid::new_v4().simple().to_string();
  let short = &suffix[..12];
  let color_schema_id = Uuid::new_v4();
  let color_schema_slug = format!("{}-{}-colors-{}", target.color_schema_slug, target_origin, short);
  let color_schema_name = format!("{} Color Override", target.color_schema_name);
  let theme_id = Uuid::new_v4();
  let theme_slug = format!("{}-{}-colors-{}", target.theme_slug, target_origin, short);
  let theme_name = format!("{} Color Override", target.theme_name);

  sqlx::query(
    r#"
    INSERT INTO color_schemas (id, slug, name, origin, locked, created_by)
    VALUES ($1, $2, $3, $4, FALSE, $5)
    "#,
  )
  .bind(color_schema_id)
  .bind(&color_schema_slug)
  .bind(&color_schema_name)
  .bind(target_origin)
  .bind(updated_by)
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("insert color schema clone", err))?;

  sqlx::query(
    r#"
    INSERT INTO color_schema_values (schema_id, mode, token_key, value)
    SELECT $1, mode, token_key, value
    FROM color_schema_values
    WHERE schema_id = $2
    "#,
  )
  .bind(color_schema_id)
  .bind(target.color_schema_id)
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("clone color schema values", err))?;

  sqlx::query(
    r#"
    INSERT INTO themes (
      id, slug, name, origin, locked, color_schema_id, typography_id,
      is_default, category, preview_group, preview_order, tagline_key,
      description_key, created_by
    )
    VALUES ($1, $2, $3, $4, FALSE, $5, $6, FALSE, $7, $8, $9, $10, $11, $12)
    "#,
  )
  .bind(theme_id)
  .bind(&theme_slug)
  .bind(&theme_name)
  .bind(target_origin)
  .bind(color_schema_id)
  .bind(target.typography_id)
  .bind(&target.theme_category)
  .bind(&target.theme_preview_group)
  .bind(target.theme_preview_order)
  .bind(&target.theme_tagline_key)
  .bind(&target.theme_description_key)
  .bind(updated_by)
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("insert color override theme", err))?;

  sqlx::query("UPDATE theme_profiles SET theme_id = $1, updated_by = $2, updated_at = now() WHERE id = $3")
    .bind(theme_id)
    .bind(updated_by)
    .bind(target.profile_id)
    .execute(&mut **tx)
    .await
    .map_err(|err| repo_error("point theme profile at color override", err))?;

  info!(
    profile_id = %target.profile_id,
    previous_theme_slug = %target.theme_slug,
    new_theme_slug = %theme_slug,
    previous_color_schema_slug = %target.color_schema_slug,
    new_color_schema_slug = %color_schema_slug,
    target_origin,
    "created clone-on-write color schema override"
  );

  Ok(EditableColorSchemaTarget { color_schema_id })
}

async fn apply_color_value_update(
  tx: &mut Transaction<'_, Postgres>,
  color_schema_id: Uuid,
  update: &ColorValueUpdate,
) -> Result<(), RepositoryError> {
  let updated = sqlx::query(
    r#"
    UPDATE color_schema_values
    SET value = $4
    WHERE schema_id = $1 AND mode = $2 AND token_key = $3
    "#,
  )
  .bind(color_schema_id)
  .bind(&update.mode)
  .bind(&update.token_key)
  .bind(&update.value)
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("update color schema value", err))?;
  if updated.rows_affected() != 1 {
    return Err(RepositoryError::NotFound("color schema value"));
  }
  Ok(())
}

async fn apply_typography_style_update(
  tx: &mut Transaction<'_, Postgres>,
  typography_id: Uuid,
  update: &TypographyStyleUpdate,
) -> Result<(), RepositoryError> {
  let style_key = update.style_key.trim();
  let current = sqlx::query(
    r#"
    SELECT style_key, font_family_id, font_weight, font_style,
           size_px::float8 AS size_px, line_height::float8 AS line_height,
           letter_spacing_em::float8 AS letter_spacing_em,
           text_transform, decoration, hover_decoration,
           font_features, font_variations, pdf_role
    FROM typography_styles
    WHERE typography_id = $1 AND style_key = $2
    "#,
  )
  .bind(typography_id)
  .bind(style_key)
  .fetch_optional(&mut **tx)
  .await
  .map_err(|err| repo_error("load typography style for update", err))?
  .ok_or(RepositoryError::NotFound("typography style"))?;

  let font_family_id = if let Some(slug) = update.font_family_slug.as_deref() {
    resolve_selectable_font_family(tx, slug).await?
  } else {
    current.get("font_family_id")
  };
  let font_weight = update.font_weight.unwrap_or_else(|| current.get("font_weight"));
  validate_font_weight(font_weight)?;
  let font_style = update
    .font_style
    .as_deref()
    .map(validate_font_style)
    .transpose()?
    .unwrap_or_else(|| current.get("font_style"));
  let size_px = update
    .size_px
    .map(validate_size_px)
    .transpose()?
    .or_else(|| current.get("size_px"));
  let line_height = update
    .line_height
    .map(validate_line_height)
    .transpose()?
    .or_else(|| current.get("line_height"));
  let letter_spacing_em = update
    .letter_spacing_em
    .map(validate_letter_spacing)
    .transpose()?
    .or_else(|| current.get("letter_spacing_em"));
  let text_transform = update
    .text_transform
    .as_deref()
    .map(validate_text_transform)
    .transpose()?
    .or_else(|| current.get("text_transform"));
  let decoration = update
    .decoration
    .as_deref()
    .map(validate_decoration)
    .transpose()?
    .or_else(|| current.get("decoration"));
  let hover_decoration = update
    .hover_decoration
    .as_deref()
    .map(validate_decoration)
    .transpose()?
    .or_else(|| current.get("hover_decoration"));
  let font_features = match update.font_features.as_ref() {
    Some(value) => validate_json_object(value, "font_features")?.clone(),
    None => current.get("font_features"),
  };
  let font_variations = match update.font_variations.as_ref() {
    Some(value) => validate_json_object(value, "font_variations")?.clone(),
    None => current.get("font_variations"),
  };
  let pdf_role = update
    .pdf_role
    .as_deref()
    .map(validate_pdf_role)
    .transpose()?
    .or_else(|| current.get("pdf_role"));

  ensure_font_asset_covers_weight(tx, font_family_id, "web", &font_style, font_weight).await?;
  if pdf_role.is_some() {
    ensure_font_asset_covers_weight(tx, font_family_id, "pdf", &font_style, font_weight).await?;
  }

  sqlx::query(
    r#"
    UPDATE typography_styles
    SET font_family_id = $3,
        font_weight = $4,
        font_style = $5,
        size_px = $6,
        line_height = $7,
        letter_spacing_em = $8,
        text_transform = $9,
        decoration = $10,
        hover_decoration = $11,
        font_features = $12,
        font_variations = $13,
        pdf_role = $14
    WHERE typography_id = $1 AND style_key = $2
    "#,
  )
  .bind(typography_id)
  .bind(style_key)
  .bind(font_family_id)
  .bind(font_weight)
  .bind(&font_style)
  .bind(size_px)
  .bind(line_height)
  .bind(letter_spacing_em)
  .bind(text_transform)
  .bind(decoration)
  .bind(hover_decoration)
  .bind(font_features)
  .bind(font_variations)
  .bind(pdf_role)
  .execute(&mut **tx)
  .await
  .map_err(|err| repo_error("update typography style", err))?;

  Ok(())
}

async fn resolve_selectable_font_family(
  tx: &mut Transaction<'_, Postgres>,
  slug: &str,
) -> Result<Uuid, RepositoryError> {
  let slug = slug.trim();
  if slug.is_empty() {
    return Err(RepositoryError::Validation(
      "font_family_slug must not be empty".to_string(),
    ));
  }
  let row = sqlx::query("SELECT id, is_selectable, license_status FROM font_families WHERE slug = $1")
    .bind(slug)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|err| repo_error("resolve selectable font family", err))?
    .ok_or(RepositoryError::NotFound("font family"))?;

  let is_selectable: bool = row.get("is_selectable");
  let license_status: String = row.get("license_status");
  if !is_selectable || license_status != "approved" {
    return Err(RepositoryError::Validation(format!(
      "font family `{slug}` is not approved/selectable"
    )));
  }
  Ok(row.get("id"))
}

async fn ensure_font_asset_covers_weight(
  tx: &mut Transaction<'_, Postgres>,
  family_id: Uuid,
  usage: &str,
  font_style: &str,
  font_weight: i32,
) -> Result<(), RepositoryError> {
  let exists: bool = sqlx::query_scalar(
    r#"
    SELECT EXISTS (
      SELECT 1
      FROM font_assets
      WHERE family_id = $1
        AND usage = $2
        AND style = $3
        AND weight_min <= $4
        AND weight_max >= $4
        AND (
          ($2 = 'pdf' AND format IN ('ttf', 'otf', 'variable_ttf'))
          OR ($2 = 'web' AND format = 'woff2')
        )
    )
    "#,
  )
  .bind(family_id)
  .bind(usage)
  .bind(font_style)
  .bind(font_weight)
  .fetch_one(&mut **tx)
  .await
  .map_err(|err| repo_error("validate font asset coverage", err))?;
  if exists {
    return Ok(());
  }
  Err(RepositoryError::Validation(format!(
    "font family does not provide {usage} asset for style `{font_style}` and weight {font_weight}"
  )))
}

fn validate_font_weight(value: i32) -> Result<(), RepositoryError> {
  if (1..=1000).contains(&value) {
    Ok(())
  } else {
    Err(RepositoryError::Validation(format!(
      "font_weight `{value}` is outside 1..1000"
    )))
  }
}

fn validate_font_style(value: &str) -> Result<String, RepositoryError> {
  let value = value.trim().to_lowercase();
  match value.as_str() {
    "normal" | "italic" => Ok(value),
    _ => Err(RepositoryError::Validation(format!(
      "font_style `{value}` is invalid; expected normal or italic"
    ))),
  }
}

fn validate_size_px(value: f64) -> Result<f64, RepositoryError> {
  if value.is_finite() && (6.0..=200.0).contains(&value) {
    Ok(value)
  } else {
    Err(RepositoryError::Validation(format!(
      "size_px `{value}` is outside 6..200"
    )))
  }
}

fn validate_line_height(value: f64) -> Result<f64, RepositoryError> {
  if value.is_finite() && (0.5..=4.0).contains(&value) {
    Ok(value)
  } else {
    Err(RepositoryError::Validation(format!(
      "line_height `{value}` is outside 0.5..4.0"
    )))
  }
}

fn validate_letter_spacing(value: f64) -> Result<f64, RepositoryError> {
  if value.is_finite() && (-0.5..=1.0).contains(&value) {
    Ok(value)
  } else {
    Err(RepositoryError::Validation(format!(
      "letter_spacing_em `{value}` is outside -0.5..1.0"
    )))
  }
}

fn validate_text_transform(value: &str) -> Result<String, RepositoryError> {
  let value = value.trim().to_lowercase();
  match value.as_str() {
    "none" | "uppercase" | "lowercase" | "capitalize" => Ok(value),
    _ => Err(RepositoryError::Validation(format!(
      "text_transform `{value}` is invalid"
    ))),
  }
}

fn validate_decoration(value: &str) -> Result<String, RepositoryError> {
  let value = value.trim().to_lowercase();
  match value.as_str() {
    "none" | "underline" | "line-through" => Ok(value),
    _ => Err(RepositoryError::Validation(format!("decoration `{value}` is invalid"))),
  }
}

fn validate_pdf_role(value: &str) -> Result<String, RepositoryError> {
  let value = value.trim().to_lowercase();
  match value.as_str() {
    "heading" | "body" | "mono" | "symbol" => Ok(value),
    _ => Err(RepositoryError::Validation(format!("pdf_role `{value}` is invalid"))),
  }
}

fn required_color_tokens() -> Result<BTreeSet<String>, RepositoryError> {
  Ok(catalog()?.required_color_keys.into_iter().collect())
}

fn validate_color_mode(value: &str) -> Result<String, RepositoryError> {
  let value = value.trim().to_lowercase();
  match value.as_str() {
    "light" | "dark" => Ok(value),
    _ => Err(RepositoryError::Validation(format!(
      "color mode `{value}` is invalid; expected light or dark"
    ))),
  }
}

fn validate_color_token(value: &str, allowed_tokens: &BTreeSet<String>) -> Result<String, RepositoryError> {
  let value = value.trim();
  if allowed_tokens.contains(value) {
    Ok(value.to_string())
  } else {
    Err(RepositoryError::Validation(format!(
      "color token `{value}` is not part of the server theme contract"
    )))
  }
}

pub(crate) fn validate_color_value(value: &str) -> Result<String, RepositoryError> {
  let value = value.trim();
  let valid =
    value.len() == 7 && value.starts_with('#') && value.as_bytes().iter().skip(1).all(|byte| byte.is_ascii_hexdigit());
  if valid {
    Ok(value.to_ascii_lowercase())
  } else {
    Err(RepositoryError::Validation(format!(
      "color value `{value}` is invalid; expected #RRGGBB"
    )))
  }
}

fn validate_json_object<'a>(value: &'a JsonValue, field: &'static str) -> Result<&'a JsonValue, RepositoryError> {
  if value.is_object() {
    Ok(value)
  } else {
    Err(RepositoryError::Validation(format!("{field} must be a JSON object")))
  }
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
  value
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

fn validate_address_lines(value: JsonValue) -> Result<JsonValue, RepositoryError> {
  let Some(lines) = value.as_array() else {
    return Err(RepositoryError::Validation(
      "address_lines must be an array of strings".to_string(),
    ));
  };

  let normalized = lines
    .iter()
    .map(|line| {
      line
        .as_str()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| JsonValue::String(line.to_string()))
        .ok_or_else(|| RepositoryError::Validation("address_lines must contain only non-empty strings".to_string()))
    })
    .collect::<Result<Vec<_>, _>>()?;
  Ok(JsonValue::Array(normalized))
}

async fn ensure_global_brand_asset_slot(
  pool: &PgPool,
  asset_id: Option<Uuid>,
  slot: &'static str,
  quality_class: &'static str,
) -> Result<Option<Uuid>, RepositoryError> {
  let Some(asset_id) = asset_id else {
    return Ok(None);
  };
  let row = sqlx::query(
    r#"
    SELECT scope, slot, quality_class
    FROM brand_assets
    WHERE id = $1
    "#,
  )
  .bind(asset_id)
  .fetch_optional(pool)
  .await
  .map_err(|err| repo_error("validate app/server brand asset", err))?;
  let Some(row) = row else {
    return Err(RepositoryError::NotFound("brand asset"));
  };
  let actual_scope: String = row.get("scope");
  let actual_slot: String = row.get("slot");
  let actual_quality: String = row.get("quality_class");
  if actual_scope == "global" && actual_slot == slot && actual_quality == quality_class {
    Ok(Some(asset_id))
  } else {
    Err(RepositoryError::Validation(format!(
      "brand asset {asset_id} is {actual_scope}/{actual_slot}/{actual_quality}; expected global/{slot}/{quality_class}"
    )))
  }
}

#[instrument(skip(pool), err)]
pub async fn load_app_server_branding(pool: &PgPool) -> Result<AppServerBrandingProjection, RepositoryError> {
  let rows = sqlx::query(
    r#"
    SELECT slots.asset_type,
           ba.id,
           ba.slot,
           ba.variant,
           ba.quality_class,
           ba.storage_kind,
           ba.storage_key,
           ba.public_path,
           ba.mime,
           ba.sha256,
           ba.byte_size,
           ba.width_px,
           ba.height_px
    FROM app_server_branding asb
    JOIN LATERAL (
      VALUES
        ('logo'::text, asb.logo_asset_id),
        ('product_mark'::text, asb.product_mark_asset_id),
        ('favicon_pack'::text, asb.favicon_pack_asset_id)
    ) AS slots(asset_type, asset_id) ON TRUE
    LEFT JOIN brand_assets ba ON ba.id = slots.asset_id
    WHERE asb.id = TRUE
    ORDER BY slots.asset_type ASC
    "#,
  )
  .fetch_all(pool)
  .await
  .map_err(|err| repo_error("load app/server branding", err))?;

  let mut logo = None;
  let mut product_mark = None;
  let mut favicon_pack = None;
  for row in rows {
    let asset_type: String = row.get("asset_type");
    let asset = brand_asset_from_row(&row);
    match asset_type.as_str() {
      "logo" => logo = asset,
      "product_mark" => product_mark = asset,
      "favicon_pack" => favicon_pack = asset,
      _ => {}
    }
  }

  Ok(AppServerBrandingProjection {
    logo,
    product_mark,
    favicon_pack,
  })
}

#[instrument(skip(pool), err)]
pub async fn load_organization_identity(pool: &PgPool) -> Result<OrganizationIdentityProjection, RepositoryError> {
  let row = sqlx::query(
    r#"
    SELECT display_name, legal_name, short_name, jurisdiction, website_url,
           contact_email, address_lines, tax_id, registration_id
    FROM organization_identity
    WHERE id = TRUE
    "#,
  )
  .fetch_optional(pool)
  .await
  .map_err(|err| repo_error("load organization identity", err))?;

  Ok(match row {
    Some(row) => OrganizationIdentityProjection {
      display_name: row.get("display_name"),
      legal_name: row.get("legal_name"),
      short_name: row.get("short_name"),
      jurisdiction: row.get("jurisdiction"),
      website_url: row.get("website_url"),
      contact_email: row.get("contact_email"),
      address_lines: row.get("address_lines"),
      tax_id: row.get("tax_id"),
      registration_id: row.get("registration_id"),
    },
    None => OrganizationIdentityProjection {
      display_name: None,
      legal_name: None,
      short_name: None,
      jurisdiction: None,
      website_url: None,
      contact_email: None,
      address_lines: JsonValue::Array(Vec::new()),
      tax_id: None,
      registration_id: None,
    },
  })
}

#[instrument(skip(pool, update), err)]
pub async fn update_organization_identity(
  pool: &PgPool,
  update: OrganizationIdentityUpdate,
  updated_by: Option<Uuid>,
) -> Result<OrganizationIdentityProjection, RepositoryError> {
  let address_lines = validate_address_lines(update.address_lines)?;
  sqlx::query(
    r#"
    INSERT INTO organization_identity (
      id, display_name, legal_name, short_name, jurisdiction, website_url,
      contact_email, address_lines, tax_id, registration_id, updated_at,
      updated_by
    )
    VALUES (TRUE, $1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)
    ON CONFLICT (id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      legal_name = EXCLUDED.legal_name,
      short_name = EXCLUDED.short_name,
      jurisdiction = EXCLUDED.jurisdiction,
      website_url = EXCLUDED.website_url,
      contact_email = EXCLUDED.contact_email,
      address_lines = EXCLUDED.address_lines,
      tax_id = EXCLUDED.tax_id,
      registration_id = EXCLUDED.registration_id,
      updated_at = now(),
      updated_by = EXCLUDED.updated_by
    "#,
  )
  .bind(normalize_optional_text(update.display_name))
  .bind(normalize_optional_text(update.legal_name))
  .bind(normalize_optional_text(update.short_name))
  .bind(normalize_optional_text(update.jurisdiction))
  .bind(normalize_optional_text(update.website_url))
  .bind(normalize_optional_text(update.contact_email))
  .bind(address_lines)
  .bind(normalize_optional_text(update.tax_id))
  .bind(normalize_optional_text(update.registration_id))
  .bind(updated_by)
  .execute(pool)
  .await
  .map_err(|err| repo_error("update organization identity", err))?;

  load_organization_identity(pool).await
}

#[instrument(skip(pool), err)]
pub async fn update_app_server_branding(
  pool: &PgPool,
  update: AppServerBrandingUpdate,
  updated_by: Option<Uuid>,
) -> Result<AppServerBrandingProjection, RepositoryError> {
  let logo_asset_id = ensure_global_brand_asset_slot(pool, update.logo_asset_id, "logo", "web").await?;
  let product_mark_asset_id =
    ensure_global_brand_asset_slot(pool, update.product_mark_asset_id, "product_mark", "web").await?;
  let favicon_pack_asset_id =
    ensure_global_brand_asset_slot(pool, update.favicon_pack_asset_id, "favicon_pack", "favicon").await?;

  sqlx::query(
    r#"
    INSERT INTO app_server_branding (
      id, logo_asset_id, product_mark_asset_id, favicon_pack_asset_id,
      updated_at, updated_by
    )
    VALUES (TRUE, $1, $2, $3, now(), $4)
    ON CONFLICT (id) DO UPDATE SET
      logo_asset_id = EXCLUDED.logo_asset_id,
      product_mark_asset_id = EXCLUDED.product_mark_asset_id,
      favicon_pack_asset_id = EXCLUDED.favicon_pack_asset_id,
      updated_at = now(),
      updated_by = EXCLUDED.updated_by
    "#,
  )
  .bind(logo_asset_id)
  .bind(product_mark_asset_id)
  .bind(favicon_pack_asset_id)
  .bind(updated_by)
  .execute(pool)
  .await
  .map_err(|err| repo_error("update app/server branding", err))?;

  load_app_server_branding(pool).await
}

fn brand_asset_from_row(row: &sqlx::postgres::PgRow) -> Option<BrandAssetProjection> {
  let id = row.try_get("id").ok()?;
  let sha256: String = row.get("sha256");
  let public_path: Option<String> = row.get("public_path");
  Some(BrandAssetProjection {
    id,
    slot: row.get("slot"),
    variant: row.get("variant"),
    quality_class: row.get("quality_class"),
    storage_kind: row.get("storage_kind"),
    storage_key: row.get("storage_key"),
    public_url: public_path.map(|path| public_branding_asset_url(&path, &sha256)),
    mime: row.get("mime"),
    sha256,
    byte_size: row.get("byte_size"),
    width_px: row.get("width_px"),
    height_px: row.get("height_px"),
  })
}

fn public_branding_asset_url(public_path: &str, sha256: &str) -> String {
  let base = public_path.to_string();
  if !sha256.is_empty() && sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
    format!("{base}?v={sha256}")
  } else {
    base
  }
}

async fn load_color_values(
  pool: &PgPool,
  color_schema_slug: &str,
) -> Result<BTreeMap<String, BTreeMap<String, String>>, RepositoryError> {
  let rows = sqlx::query(
    r#"
    SELECT csv.mode, csv.token_key, csv.value
    FROM color_schema_values csv
    JOIN color_schemas cs ON cs.id = csv.schema_id
    WHERE cs.slug = $1
    ORDER BY csv.mode, csv.token_key
    "#,
  )
  .bind(color_schema_slug)
  .fetch_all(pool)
  .await
  .map_err(|err| repo_error("load color schema values", err))?;

  let mut colors = BTreeMap::<String, BTreeMap<String, String>>::new();
  for row in rows {
    colors
      .entry(row.get("mode"))
      .or_default()
      .insert(row.get("token_key"), row.get("value"));
  }
  Ok(colors)
}

async fn load_typography_styles(
  pool: &PgPool,
  typography_slug: &str,
) -> Result<Vec<TypographyStyleProjection>, RepositoryError> {
  sqlx::query(
    r#"
    SELECT s.style_key, ff.slug AS font_family_slug, ff.display_name AS font_family,
           ff.css_family, s.font_weight, s.font_style, s.size_px::float8 AS size_px,
           s.line_height::float8 AS line_height,
           s.letter_spacing_em::float8 AS letter_spacing_em,
           s.text_transform, s.decoration, s.hover_decoration,
           s.font_features, s.font_variations, s.pdf_role
    FROM typography_styles s
    JOIN typography_sets ts ON ts.id = s.typography_id
    JOIN font_families ff ON ff.id = s.font_family_id
    WHERE ts.slug = $1
    ORDER BY s.style_key
    "#,
  )
  .bind(typography_slug)
  .fetch_all(pool)
  .await
  .map_err(|err| repo_error("load typography styles", err))
  .map(|rows| {
    rows
      .into_iter()
      .map(|row| TypographyStyleProjection {
        style_key: row.get("style_key"),
        font_family_slug: row.get("font_family_slug"),
        font_family: row.get("font_family"),
        css_family: row.get("css_family"),
        font_weight: row.get("font_weight"),
        font_style: row.get("font_style"),
        size_px: row.get("size_px"),
        line_height: row.get("line_height"),
        letter_spacing_em: row.get("letter_spacing_em"),
        text_transform: row.get("text_transform"),
        decoration: row.get("decoration"),
        hover_decoration: row.get("hover_decoration"),
        font_features: row.get("font_features"),
        font_variations: row.get("font_variations"),
        pdf_role: row.get("pdf_role"),
      })
      .collect()
  })
}

fn jsonb_string_array(value: JsonValue) -> Vec<String> {
  value
    .as_array()
    .map(|items| {
      items
        .iter()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect()
    })
    .unwrap_or_default()
}

#[cfg(test)]
mod color_projection_tests {
  use super::*;

  #[test]
  fn links_and_filled_accents_project_independently() {
    let catalog: serde_json::Value = serde_json::from_str(THEME_CATALOG_JSON).expect("catalog");
    let stuttgart = catalog["themes"]
      .as_array()
      .expect("themes")
      .iter()
      .find(|theme| theme["slug"] == "stuttgart")
      .expect("default theme");
    for (mode, accent, link, foreground) in [
      ("light", "#1f3a52", "#1f3a52", "#ffffff"),
      ("dark", "#7fa6c8", "#7fa6c8", "#000000"),
    ] {
      let mut tokens: BTreeMap<String, String> =
        serde_json::from_value(stuttgart["colors"][mode].clone()).expect("colors");
      assert_eq!(tokens["accent-primary"], accent);
      assert_eq!(tokens["link-default"], link);
      assert!(contrast_ratio(link, &tokens["paper"]).expect("contrast") >= 4.5);
      tokens.insert("link-default".into(), "#123456".into());
      let mut css = String::new();
      emit_theme_color_tokens(&mut css, "", &tokens, mode);
      assert!(css.contains(&format!("--myoxus-primary-color: {accent};")));
      assert!(css.contains("--myoxus-link-color: #123456;"));
      assert!(css.contains(&format!("--myoxus-text-emphasis-color: {accent};")));
      assert!(css.contains(&format!("--myoxus-sem-button-primary-fg: {};", foreground)));
      assert_eq!(css.matches("--myoxus-sem-link-default:").count(), 1);
    }
  }
}
