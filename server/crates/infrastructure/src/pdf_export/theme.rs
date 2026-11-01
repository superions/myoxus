// SPDX-License-Identifier: AGPL-3.0-or-later
//! PDF materialization of the authoritative theme, document brand and approved fonts.
use myoxus_application::pdf_export::dispatch::{PdfThemeContext, PdfThemeFontAssetRef};
use myoxus_application::pdf_export::error::{PdfExportError, PdfExportErrorDetails, Result};
use myoxus_pdf_export::ir::{
  Branding, NativeTablePaint, NativeTablePalette, ThemeFontSelection, ThemeTypographySelection, ThemeTypographyStyle,
};
use std::{collections::BTreeMap, sync::Arc};
use tracing::{debug, warn};
use uuid::Uuid;
fn pdf_font_config_error(role: &'static str, source: &'static str, requested: Option<&str>) -> PdfExportError {
  let requested = requested.unwrap_or("<missing>");
  let mut err = PdfExportError::new(format!(
    "effective PDF font for role '{role}' from {source} has no approved PDF font asset"
  ));
  err.extensions = Some({
    let mut ext = PdfExportErrorDetails::default();
    ext.set("class", "ConfigurationError");
    ext.set("role", role);
    ext.set("source", source);
    ext.set("requested", requested);
    ext
  });
  err
}

fn pdf_typography_config_error(role: &'static str, field: &'static str) -> PdfExportError {
  let mut err = PdfExportError::new(format!(
    "effective PDF typography role '{role}' has an invalid or missing '{field}' value"
  ));
  err.extensions = Some({
    let mut ext = PdfExportErrorDetails::default();
    ext.set("class", "ConfigurationError");
    ext.set("role", role);
    ext.set("source", "theme_db");
    ext.set("field", field);
    ext
  });
  err
}

pub fn resolve_pdf_typography_role(
  role: &'static str,
  style: Option<&crate::branding::TypographyStyleProjection>,
) -> Result<ThemeTypographyStyle> {
  let style = style.ok_or_else(|| pdf_typography_config_error(role, "role"))?;
  let weight = u16::try_from(style.font_weight)
    .ok()
    .filter(|weight| (1..=1000).contains(weight))
    .ok_or_else(|| pdf_typography_config_error(role, "font_weight"))?;
  let font_style = match style.font_style.as_str() {
    "normal" | "italic" | "oblique" => style.font_style.clone(),
    _ => return Err(pdf_typography_config_error(role, "font_style")),
  };
  let bounded = |value: Option<f64>, min: f64, max: f64, field| {
    value
      .filter(|value| value.is_finite() && (min..=max).contains(value))
      .ok_or_else(|| pdf_typography_config_error(role, field))
  };

  Ok(ThemeTypographyStyle {
    font_weight: weight,
    font_style,
    size_px: bounded(style.size_px, 6.0, 200.0, "size_px")?,
    line_height: bounded(style.line_height, 0.5, 4.0, "line_height")?,
    letter_spacing_em: bounded(style.letter_spacing_em, -0.5, 1.0, "letter_spacing_em")?,
    text_transform: match style.text_transform.as_deref().unwrap_or("none") {
      value @ ("none" | "uppercase" | "lowercase" | "capitalize") => value.into(),
      _ => return Err(pdf_typography_config_error(role, "text_transform")),
    },
    decoration: match style.decoration.as_deref().unwrap_or("none") {
      value @ ("none" | "underline" | "line-through") => value.into(),
      _ => return Err(pdf_typography_config_error(role, "decoration")),
    },
  })
}

async fn resolve_pdf_font_role(
  repository: &dyn myoxus_domain::repositories::PdfFontRepository,
  role: &'static str,
  style: Option<&crate::branding::TypographyStyleProjection>,
) -> Result<(String, PdfThemeFontAssetRef)> {
  let Some(style) = style else {
    warn!(role, source = "theme_db", "pdf export: effective font role is missing");
    return Err(pdf_font_config_error(role, "theme_db", None));
  };

  let asset = repository
    .resolve_theme_font_asset(&style.font_family_slug)
    .await
    .map_err(|err| PdfExportError::new(err.to_string()))?;

  let Some(asset) = asset else {
    warn!(
      role,
      family_slug = %style.font_family_slug,
      requested = %style.font_family,
      "pdf export: effective font role has no approved PDF font asset"
    );
    return Err(pdf_font_config_error(role, "theme_db", Some(&style.font_family)));
  };

  let family = asset.family;
  let asset_ref = PdfThemeFontAssetRef {
    family_slug: asset.family_slug,
    family: family.clone(),
    asset_key: asset.asset_key,
    sha256: asset.sha256,
    format: asset.format,
  };
  Ok((family, asset_ref))
}

pub async fn resolve_effective_pdf_theme_context(
  pool: &sqlx::PgPool,
  workspace_id: Uuid,
  brand_repository: Option<Arc<dyn myoxus_domain::repositories::PdfWorkspaceBrandAssetRepository>>,
  font_repository: Option<Arc<dyn myoxus_domain::repositories::PdfFontRepository>>,
) -> Result<PdfThemeContext> {
  let profile = crate::branding::load_effective_theme_profile(pool, Some(workspace_id))
    .await
    .map_err(|err| PdfExportError::new(err.to_string()))?;
  let brand = brand_repository
    .ok_or_else(|| PdfExportError::new("PDF document branding repository is not configured"))?
    .get(workspace_id)
    .await
    .map_err(|error| PdfExportError::new(error.to_string()))?
    .ok_or_else(|| PdfExportError::new("effective PDF document branding is unavailable"))?;
  let font_repository = font_repository.ok_or_else(|| PdfExportError::new("PDF font repository is not configured"))?;

  let role_style = |role: &str| -> Option<&crate::branding::TypographyStyleProjection> {
    profile
      .theme
      .typography_styles
      .iter()
      .find(|style| style.pdf_role.as_deref() == Some(role))
  };

  let heading_style = role_style("heading");
  let body_style = role_style("body");
  let mono_style = role_style("mono");
  let symbol_style = role_style("symbol");
  let (heading, heading_asset) = resolve_pdf_font_role(font_repository.as_ref(), "heading", heading_style).await?;
  let (body, body_asset) = resolve_pdf_font_role(font_repository.as_ref(), "body", body_style).await?;
  let (mono, mono_asset) = resolve_pdf_font_role(font_repository.as_ref(), "mono", mono_style).await?;
  let (symbol, symbol_asset) = resolve_pdf_font_role(font_repository.as_ref(), "symbol", symbol_style).await?;
  let typography = ThemeTypographySelection {
    heading: Some(resolve_pdf_typography_role("heading", heading_style)?),
    body: Some(resolve_pdf_typography_role("body", body_style)?),
    mono: Some(resolve_pdf_typography_role("mono", mono_style)?),
    symbol: Some(resolve_pdf_typography_role("symbol", symbol_style)?),
  };

  let color_mode = if profile.theme_mode == "dark" { "dark" } else { "light" };
  let branding = effective_document_branding(&brand, &profile.theme.colors, color_mode);
  let native_table_palette = resolve_native_table_palette(
    profile
      .theme
      .colors
      .get(color_mode)
      .ok_or_else(|| PdfExportError::new("effective PDF theme colours are unavailable"))?,
    color_mode,
  )?;

  let mut font_assets = BTreeMap::new();
  font_assets.insert("heading".to_owned(), heading_asset);
  font_assets.insert("body".to_owned(), body_asset);
  font_assets.insert("mono".to_owned(), mono_asset);
  font_assets.insert("symbol".to_owned(), symbol_asset);

  debug!(
    heading = %heading,
    body = %body,
    mono = %mono,
    symbol = %symbol,
    theme_slug = %profile.theme.slug,
    scope = %profile.scope,
    color_mode,
    default_color_profile = brand.default_color_profile.as_deref().unwrap_or("sRGB"),
    ligatures_enabled = brand.ligatures_enabled,
    "pdf export: resolved effective document colors and font roles from server models"
  );

  Ok(PdfThemeContext {
    fonts: ThemeFontSelection {
      heading: Some(heading),
      body: Some(body),
      mono: Some(mono),
      symbol: Some(symbol),
    },
    typography,
    native_table_palette: Some(native_table_palette),
    font_assets,
    branding,
    theme_slug: profile.theme.slug,
    profile_scope: profile.scope,
    default_paper_size: brand.default_paper_size,
    default_locale: brand.default_locale,
    default_color_profile: brand.default_color_profile,
    default_image_quality: brand.default_image_quality,
    ligatures_enabled: brand.ligatures_enabled,
  })
}

fn resolve_native_table_palette(tokens: &BTreeMap<String, String>, mode: &str) -> Result<NativeTablePalette> {
  crate::branding::native_table_color_values(tokens, mode)
    .into_iter()
    .map(|(reference, value)| {
      let fill = value
        .and_then(|value| crate::branding::validate_color_value(value).ok())
        .ok_or_else(|| {
          let mut error = PdfExportError::new("effective PDF native table colour is missing or invalid");
          let mut details = PdfExportErrorDetails::default();
          details.set("class", "ConfigurationError");
          details.set("field", reference);
          error.extensions = Some(details);
          error
        })?;
      let foreground = crate::branding::adaptive_foreground(&fill).to_owned();
      Ok((reference.to_owned(), NativeTablePaint { fill, foreground }))
    })
    .collect()
}
fn effective_document_branding(
  brand: &myoxus_domain::entities::PdfWorkspaceBrandAsset,
  theme_colors: &BTreeMap<String, BTreeMap<String, String>>,
  color_mode: &str,
) -> Branding {
  let fallback_colors = theme_colors.get(color_mode);
  let fallback_primary = fallback_colors.and_then(|values| values.get("accent-primary")).cloned();
  let fallback_text = fallback_colors.and_then(|values| values.get("ink")).cloned();
  let fallback_background = fallback_colors.and_then(|values| values.get("paper")).cloned();
  // Document palettes are print-oriented and are seeded from the light theme
  // mode. Keep their code surface on that same palette instead of mixing a
  // dark application surface into an otherwise light PDF.
  let fallback_code_background = theme_colors
    .get("light")
    .or(fallback_colors)
    .and_then(|values| values.get("background-code-block"))
    .cloned();

  Branding {
    organization_name: brand.company_name.clone(),
    legal_text: brand.legal_text.clone(),
    footer_text: brand.footer_text.clone(),
    logo_large_blob: brand.logo_large_blob.clone(),
    logo_large_sha256: brand.logo_large_sha256.clone(),
    logo_small_blob: brand.logo_small_blob.clone(),
    logo_small_sha256: brand.logo_small_sha256.clone(),
    color_policy: Some(brand.color_policy.clone()),
    color_palette_key: brand.color_palette_key.clone(),
    primary: brand.brand_color_primary.clone().or_else(|| fallback_primary.clone()),
    accent: brand.brand_color_accent.clone().or_else(|| fallback_primary.clone()),
    rule: brand.brand_color_rule.clone().or_else(|| fallback_primary.clone()),
    text_primary: brand.brand_color_text.clone().or(fallback_text),
    background: brand.brand_color_background.clone().or(fallback_background),
    code_background: fallback_code_background,
    ..Branding::default()
  }
}

#[cfg(test)]
mod tests {
  #[test]
  fn native_table_palette_matches_runtime_theme_css_in_both_modes() {
    use crate::branding::{ThemeProfileProjection, ThemeProjection};
    use std::collections::BTreeMap;

    let tokens = BTreeMap::from([
      ("paper-deep".into(), "#e5dfd3".into()),
      ("status-success-paper".into(), "#c7e5d2".into()),
      ("status-preset-paper".into(), "#f8dd8e".into()),
      ("status-error-paper".into(), "#f4c7c7".into()),
    ]);
    let mut profile = ThemeProfileProjection {
      scope: "global".into(),
      workspace_id: None,
      theme_mode: "light".into(),
      theme: ThemeProjection {
        slug: "palette-test".into(),
        name: "Palette".into(),
        category: None,
        preview_group: None,
        preview_order: 0,
        tagline_key: None,
        description_key: None,
        origin: "system".into(),
        locked: true,
        is_default: true,
        color_schema_slug: "palette-test".into(),
        typography_slug: "palette-test".into(),
        colors: BTreeMap::from([("light".into(), tokens.clone()), ("dark".into(), tokens.clone())]),
        typography_styles: vec![],
      },
    };
    for (mode, blue) in [("light", "#e1eeff"), ("dark", "#084388")] {
      profile.theme_mode = mode.into();
      let palette = super::resolve_native_table_palette(&tokens, mode).expect("valid palette");
      assert_eq!(palette.len(), 12);
      assert_eq!(palette["--myoxus-background-secondary-color"].fill, "#e5dfd3");
      assert_eq!(palette["--myoxus-tag-blue"].fill, blue);
      assert_eq!(palette["--myoxus-sem-status-success-paper"].fill, "#c7e5d2");
      let css = crate::branding::build_runtime_theme_css(&profile, &[]);
      let root = css.split("}\n").next().unwrap();
      for (reference, paint) in palette {
        assert!(root.contains(&format!("{reference}: {};", paint.fill)));
        assert_eq!(paint.foreground, crate::branding::adaptive_foreground(&paint.fill));
      }
    }
    let mut invalid = tokens;
    invalid.insert("status-success-paper".into(), "var(--unresolved)".into());
    let error = super::resolve_native_table_palette(&invalid, "light").expect_err("invalid theme paint");
    assert!(error.extensions.is_some());
  }

  #[test]
  fn typography_display_style_is_validated_at_dispatch() {
    let style = crate::branding::TypographyStyleProjection {
      style_key: "heading".into(),
      font_family_slug: "lora".into(),
      font_family: "Lora".into(),
      css_family: "Lora".into(),
      font_weight: 600,
      font_style: "normal".into(),
      size_px: Some(32.0),
      line_height: Some(1.2),
      letter_spacing_em: Some(-0.005),
      text_transform: Some("uppercase".into()),
      decoration: Some("underline".into()),
      hover_decoration: None,
      font_features: serde_json::json!({}),
      font_variations: serde_json::json!({}),
      pdf_role: Some("heading".into()),
    };

    let resolved = super::resolve_pdf_typography_role("heading", Some(&style)).expect("valid style");
    assert_eq!(resolved.text_transform, "uppercase");
    assert_eq!(resolved.decoration, "underline");

    let mut invalid = style;
    invalid.text_transform = Some("full-width".into());
    assert!(super::resolve_pdf_typography_role("heading", Some(&invalid)).is_err());
  }
}
