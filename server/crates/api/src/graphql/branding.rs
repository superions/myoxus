// SPDX-License-Identifier: AGPL-3.0-or-later
//! AdminRoot GraphQL surface for server-owned themes, typography, fonts and
//! brand identity.
//!
//! This module is intentionally read/write against the typed PostgreSQL model.
//! It must not proxy through `app_configs` because global theme and branding are
//! server-owned domain model, not frontend-local configuration.

use std::sync::Arc;

use async_graphql::{Context, ID, InputObject, Object, Result, SimpleObject};
use serde_json::Value as JsonValue;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use myoxus_application::auth::AuthError;
use myoxus_domain::repositories::RepositoryError;
use myoxus_infrastructure::branding::{
  AppServerBrandingProjection, AppServerBrandingUpdate, BrandAssetProjection, ColorValueUpdate, FontAssetProjection,
  FontFamilyProjection, OrganizationIdentityProjection, OrganizationIdentityUpdate, ThemeProfileProjection,
  ThemeProjection, TypographyStyleProjection, TypographyStyleUpdate,
};

use crate::graphql::utils::{map_gql_error, require_session};
use crate::state::ApiState;

#[derive(SimpleObject, Clone)]
pub struct ThemeFontAssetType {
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

#[derive(SimpleObject, Clone)]
pub struct ThemeFontFamilyType {
  pub slug: String,
  pub display_name: String,
  pub css_family: String,
  pub generic_class: String,
  pub source: String,
  pub license_spdx: String,
  pub license_status: String,
  pub is_selectable: bool,
  pub assets: Vec<ThemeFontAssetType>,
}

#[derive(SimpleObject, Clone)]
pub struct ThemeTypographyStyleType {
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

#[derive(SimpleObject, Clone)]
pub struct ThemeDefinitionType {
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
  pub colors: JsonValue,
  pub typography_styles: Vec<ThemeTypographyStyleType>,
}

#[derive(SimpleObject, Clone)]
pub struct BrandAssetType {
  pub id: ID,
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

#[derive(SimpleObject, Clone)]
pub struct AppServerBrandingType {
  pub logo: Option<BrandAssetType>,
  pub product_mark: Option<BrandAssetType>,
  pub favicon_pack: Option<BrandAssetType>,
}

#[derive(SimpleObject, Clone)]
pub struct OrganizationIdentityType {
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

#[derive(SimpleObject, Clone)]
pub struct ThemeProfileType {
  pub scope: String,
  pub workspace_id: Option<ID>,
  pub theme_mode: String,
  pub theme: ThemeDefinitionType,
}

#[derive(SimpleObject, Clone)]
pub struct ThemeCatalogType {
  pub catalog_hash: String,
  pub themes: Vec<ThemeDefinitionType>,
  pub font_families: Vec<ThemeFontFamilyType>,
}

/// Existing catalog theme metadata exposed for a canonical personal workspace.
///
/// Theme authoring remains an administrator capability. This surface only
/// exposes the fields needed to select an existing server-owned theme for the
/// workspace; it does not create a user-owned theme or account preference.
#[derive(SimpleObject, Clone)]
pub struct PersonalWorkspaceThemeOptionType {
  pub slug: String,
  pub name: String,
  pub is_default: bool,
}

/// Effective catalog-theme selection for the canonical personal workspace.
#[derive(SimpleObject, Clone)]
pub struct PersonalWorkspaceThemeSelectionType {
  pub workspace_id: ID,
  pub theme_slug: String,
  pub theme_name: String,
  pub inherits_global: bool,
}

#[derive(InputObject, Clone, Debug)]
pub struct SetThemeProfileInput {
  pub workspace_id: Option<ID>,
  pub theme_slug: String,
  pub theme_mode: String,
}

#[derive(InputObject, Clone, Debug)]
pub struct SetPersonalWorkspaceThemeInput {
  pub workspace_id: ID,
  pub theme_slug: String,
}

#[derive(InputObject, Clone, Debug)]
pub struct SetTypographyStylesInput {
  pub workspace_id: Option<ID>,
  pub styles: Vec<TypographyStylePatchInput>,
}

#[derive(InputObject, Clone, Debug)]
pub struct SetColorSchemaValuesInput {
  pub workspace_id: Option<ID>,
  pub colors: Vec<ColorSchemaValuePatchInput>,
}

#[derive(InputObject, Clone, Debug)]
pub struct ResetWorkspaceThemeProfileInput {
  pub workspace_id: ID,
}

#[derive(InputObject, Clone, Debug)]
pub struct UpdateOrganizationIdentityInput {
  pub display_name: Option<String>,
  pub legal_name: Option<String>,
  pub short_name: Option<String>,
  pub jurisdiction: Option<String>,
  pub website_url: Option<String>,
  pub contact_email: Option<String>,
  pub address_lines: Option<Vec<String>>,
  pub tax_id: Option<String>,
  pub registration_id: Option<String>,
}

#[derive(InputObject, Clone, Debug)]
pub struct UpdateAppServerBrandingInput {
  pub logo_asset_id: Option<ID>,
  pub product_mark_asset_id: Option<ID>,
  pub favicon_pack_asset_id: Option<ID>,
}

#[derive(InputObject, Clone, Debug)]
pub struct TypographyStylePatchInput {
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

#[derive(InputObject, Clone, Debug)]
pub struct ColorSchemaValuePatchInput {
  pub mode: String,
  pub token_key: String,
  pub value: String,
}

pub struct BrandingAdminQueryRoot;

#[Object]
impl BrandingAdminQueryRoot {
  #[instrument(skip(self, ctx))]
  pub async fn theme_catalog(&self, ctx: &Context<'_>) -> Result<ThemeCatalogType> {
    let state = require_admin_state(ctx).await?;
    let pool = require_pool(&state)?;
    let themes = myoxus_infrastructure::branding::list_themes(&pool)
      .await
      .map_err(map_repo_err)?;
    let font_families = myoxus_infrastructure::branding::list_font_families(&pool, false)
      .await
      .map_err(map_repo_err)?;
    let catalog_hash = myoxus_infrastructure::branding::bundled_theme_catalog_hash().map_err(map_repo_err)?;
    Ok(ThemeCatalogType {
      catalog_hash,
      themes: themes.into_iter().map(Into::into).collect(),
      font_families: font_families.into_iter().map(Into::into).collect(),
    })
  }

  #[instrument(skip(self, ctx))]
  pub async fn effective_theme_profile(&self, ctx: &Context<'_>, workspace_id: Option<ID>) -> Result<ThemeProfileType> {
    let state = require_admin_state(ctx).await?;
    let pool = require_pool(&state)?;
    let workspace_id = parse_optional_uuid(workspace_id, "workspace_id")?;
    let profile = myoxus_infrastructure::branding::load_effective_theme_profile(&pool, workspace_id)
      .await
      .map_err(map_repo_err)?;
    Ok(profile.into())
  }

  #[instrument(skip(self, ctx))]
  pub async fn app_server_branding(&self, ctx: &Context<'_>) -> Result<AppServerBrandingType> {
    let state = require_admin_state(ctx).await?;
    let pool = require_pool(&state)?;
    let branding = myoxus_infrastructure::branding::load_app_server_branding(&pool)
      .await
      .map_err(map_repo_err)?;
    Ok(branding.into())
  }

  #[instrument(skip(self, ctx))]
  pub async fn organization_identity(&self, ctx: &Context<'_>) -> Result<OrganizationIdentityType> {
    let state = require_admin_state(ctx).await?;
    let pool = require_pool(&state)?;
    let identity = myoxus_infrastructure::branding::load_organization_identity(&pool)
      .await
      .map_err(map_repo_err)?;
    Ok(identity.into())
  }
}

pub struct BrandingAdminMutationRoot;

#[Object]
impl BrandingAdminMutationRoot {
  #[instrument(skip(self, ctx))]
  pub async fn set_theme_profile(&self, ctx: &Context<'_>, input: SetThemeProfileInput) -> Result<ThemeProfileType> {
    let (state, actor_id) = require_admin_actor(ctx).await?;
    let pool = require_pool(&state)?;
    let workspace_id = parse_optional_uuid(input.workspace_id, "workspace_id")?;
    let profile = myoxus_infrastructure::branding::set_theme_profile(
      &pool,
      workspace_id,
      input.theme_slug.trim(),
      input.theme_mode.trim(),
      Some(actor_id),
    )
    .await
    .map_err(map_repo_err)?;
    info!(
      actor_id = %actor_id,
      workspace_id = ?workspace_id,
      theme_slug = %profile.theme.slug,
      theme_mode = %profile.theme_mode,
      "theme profile updated"
    );
    Ok(profile.into())
  }

  #[instrument(skip(self, ctx, input), fields(style_count = input.styles.len()))]
  pub async fn set_typography_styles(
    &self,
    ctx: &Context<'_>,
    input: SetTypographyStylesInput,
  ) -> Result<ThemeProfileType> {
    let (state, actor_id) = require_admin_actor(ctx).await?;
    let pool = require_pool(&state)?;
    let workspace_id = parse_optional_uuid(input.workspace_id, "workspace_id")?;
    let updates = input
      .styles
      .into_iter()
      .map(TypographyStyleUpdate::from)
      .collect::<Vec<_>>();
    let profile = myoxus_infrastructure::branding::set_theme_profile_typography_styles(
      &pool,
      workspace_id,
      updates,
      Some(actor_id),
    )
    .await
    .map_err(map_repo_err)?;
    info!(
      actor_id = %actor_id,
      workspace_id = ?workspace_id,
      theme_slug = %profile.theme.slug,
      typography_slug = %profile.theme.typography_slug,
      "theme typography profile updated"
    );
    Ok(profile.into())
  }

  #[instrument(skip(self, ctx, input), fields(color_count = input.colors.len()))]
  pub async fn set_color_schema_values(
    &self,
    ctx: &Context<'_>,
    input: SetColorSchemaValuesInput,
  ) -> Result<ThemeProfileType> {
    let (state, actor_id) = require_admin_actor(ctx).await?;
    let pool = require_pool(&state)?;
    let workspace_id = parse_optional_uuid(input.workspace_id, "workspace_id")?;
    let updates = input.colors.into_iter().map(ColorValueUpdate::from).collect::<Vec<_>>();
    let profile =
      myoxus_infrastructure::branding::set_theme_profile_color_values(&pool, workspace_id, updates, Some(actor_id))
        .await
        .map_err(map_repo_err)?;
    info!(
      actor_id = %actor_id,
      workspace_id = ?workspace_id,
      theme_slug = %profile.theme.slug,
      color_schema_slug = %profile.theme.color_schema_slug,
      "theme color schema profile updated"
    );
    Ok(profile.into())
  }

  #[instrument(skip(self, ctx))]
  pub async fn reset_workspace_theme_profile(
    &self,
    ctx: &Context<'_>,
    input: ResetWorkspaceThemeProfileInput,
  ) -> Result<ThemeProfileType> {
    let (state, actor_id) = require_admin_actor(ctx).await?;
    let pool = require_pool(&state)?;
    let workspace_id = parse_required_uuid(input.workspace_id, "workspace_id")?;
    let profile = myoxus_infrastructure::branding::reset_workspace_theme_profile(&pool, workspace_id, Some(actor_id))
      .await
      .map_err(map_repo_err)?;
    info!(
      actor_id = %actor_id,
      workspace_id = %workspace_id,
      inherited_theme_slug = %profile.theme.slug,
      "workspace theme profile reset to global inheritance"
    );
    Ok(profile.into())
  }

  #[instrument(skip(self, ctx, input))]
  pub async fn update_organization_identity(
    &self,
    ctx: &Context<'_>,
    input: UpdateOrganizationIdentityInput,
  ) -> Result<OrganizationIdentityType> {
    let (state, actor_id) = require_admin_actor(ctx).await?;
    let pool = require_pool(&state)?;
    let update = OrganizationIdentityUpdate::from(input);
    let identity = myoxus_infrastructure::branding::update_organization_identity(&pool, update, Some(actor_id))
      .await
      .map_err(map_repo_err)?;
    info!(actor_id = %actor_id, "organization identity updated");
    Ok(identity.into())
  }

  #[instrument(skip(self, ctx, input))]
  pub async fn update_app_server_branding(
    &self,
    ctx: &Context<'_>,
    input: UpdateAppServerBrandingInput,
  ) -> Result<AppServerBrandingType> {
    let (state, actor_id) = require_admin_actor(ctx).await?;
    let pool = require_pool(&state)?;
    let update = AppServerBrandingUpdate::try_from(input)?;
    let branding = myoxus_infrastructure::branding::update_app_server_branding(&pool, update, Some(actor_id))
      .await
      .map_err(map_repo_err)?;
    info!(actor_id = %actor_id, "app/server branding updated");
    Ok(branding.into())
  }
}

pub struct PersonalWorkspaceThemeQueryRoot;

#[Object]
impl PersonalWorkspaceThemeQueryRoot {
  /// List existing catalog themes selectable for the canonical personal workspace.
  #[instrument(skip(self, ctx))]
  pub async fn personal_workspace_theme_catalog(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Vec<PersonalWorkspaceThemeOptionType>> {
    let (state, _, _) = require_personal_workspace_actor(ctx, workspace_id).await?;
    let pool = require_pool(&state)?;
    let themes = myoxus_infrastructure::branding::list_themes(&pool)
      .await
      .map_err(map_repo_err)?;
    Ok(
      themes
        .into_iter()
        .map(|theme| PersonalWorkspaceThemeOptionType {
          slug: theme.slug,
          name: theme.name,
          is_default: theme.is_default,
        })
        .collect(),
    )
  }

  /// Return the effective catalog-theme selection for the personal workspace.
  #[instrument(skip(self, ctx))]
  pub async fn personal_workspace_theme_selection(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<PersonalWorkspaceThemeSelectionType> {
    let (state, _, workspace_id) = require_personal_workspace_actor(ctx, workspace_id).await?;
    let pool = require_pool(&state)?;
    let profile = myoxus_infrastructure::branding::load_effective_theme_profile(&pool, Some(workspace_id))
      .await
      .map_err(map_repo_err)?;
    Ok(personal_workspace_theme_selection(workspace_id, profile))
  }
}

pub struct PersonalWorkspaceThemeMutationRoot;

#[Object]
impl PersonalWorkspaceThemeMutationRoot {
  /// Select an existing server-owned theme for the canonical personal workspace.
  #[instrument(skip(self, ctx, input))]
  pub async fn set_personal_workspace_theme(
    &self,
    ctx: &Context<'_>,
    input: SetPersonalWorkspaceThemeInput,
  ) -> Result<PersonalWorkspaceThemeSelectionType> {
    let (state, actor_id, workspace_id) = require_personal_workspace_actor(ctx, input.workspace_id).await?;
    let pool = require_pool(&state)?;
    let profile = myoxus_infrastructure::branding::select_workspace_theme(
      &pool,
      workspace_id,
      input.theme_slug.trim(),
      Some(actor_id),
    )
    .await
    .map_err(map_repo_err)?;
    info!(
      actor_id = %actor_id,
      workspace_id = %workspace_id,
      theme_slug = %profile.theme.slug,
      "theme selected for canonical personal workspace"
    );
    Ok(personal_workspace_theme_selection(workspace_id, profile))
  }

  /// Remove the canonical personal workspace override and inherit the global theme.
  #[instrument(skip(self, ctx))]
  pub async fn reset_personal_workspace_theme(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<PersonalWorkspaceThemeSelectionType> {
    let (state, actor_id, workspace_id) = require_personal_workspace_actor(ctx, workspace_id).await?;
    let pool = require_pool(&state)?;
    let profile = myoxus_infrastructure::branding::reset_workspace_theme_profile(&pool, workspace_id, Some(actor_id))
      .await
      .map_err(map_repo_err)?;
    info!(
      actor_id = %actor_id,
      workspace_id = %workspace_id,
      inherited_theme_slug = %profile.theme.slug,
      "canonical personal workspace theme reset to global inheritance"
    );
    Ok(personal_workspace_theme_selection(workspace_id, profile))
  }
}

async fn require_admin_state(ctx: &Context<'_>) -> Result<Arc<ApiState>> {
  Ok(require_admin_actor(ctx).await?.0)
}

async fn require_admin_actor(ctx: &Context<'_>) -> Result<(Arc<ApiState>, Uuid)> {
  let (state, snapshot) = require_session(ctx).await?;
  if !snapshot.user.is_admin {
    warn!(user_id = %snapshot.user.id, "unauthorized global theme access attempt");
    return Err(map_gql_error(AuthError::ActionForbidden));
  }
  Ok((state, snapshot.user.id))
}

async fn require_personal_workspace_actor(ctx: &Context<'_>, workspace_id: ID) -> Result<(Arc<ApiState>, Uuid, Uuid)> {
  let (state, snapshot) = require_session(ctx).await?;
  let requested_workspace_id = parse_required_uuid(workspace_id, "workspace_id")?;
  let personal_workspace = state
    .workspace()
    .find_personal_workspace(snapshot.user.id)
    .await
    .map_err(map_gql_error)?;
  if personal_workspace.map(|workspace| workspace.id) != Some(requested_workspace_id) {
    warn!(
      actor_id = %snapshot.user.id,
      workspace_id = %requested_workspace_id,
      "rejected theme access outside the actor's canonical personal workspace"
    );
    return Err(map_gql_error(AuthError::ActionForbidden));
  }
  Ok((state, snapshot.user.id, requested_workspace_id))
}

fn require_pool(state: &ApiState) -> Result<sqlx::PgPool> {
  state
    .metrics_pool()
    .ok_or_else(|| async_graphql::Error::new("theme database pool is not configured"))
}

fn parse_optional_uuid(id: Option<ID>, field: &'static str) -> Result<Option<Uuid>> {
  id.map(|id| Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new(format!("invalid {field}"))))
    .transpose()
}

fn parse_required_uuid(id: ID, field: &'static str) -> Result<Uuid> {
  Uuid::parse_str(id.as_str()).map_err(|_| async_graphql::Error::new(format!("invalid {field}")))
}

fn map_repo_err(err: RepositoryError) -> async_graphql::Error {
  match err {
    RepositoryError::Validation(message) => async_graphql::Error::new(format!("validation failed: {message}")),
    RepositoryError::NotFound(entity) => async_graphql::Error::new(format!("{entity} not found")),
    RepositoryError::Conflict(message) => async_graphql::Error::new(format!("conflict: {message}")),
    other => async_graphql::Error::new(other.to_string()),
  }
}

fn personal_workspace_theme_selection(
  workspace_id: Uuid,
  profile: ThemeProfileProjection,
) -> PersonalWorkspaceThemeSelectionType {
  PersonalWorkspaceThemeSelectionType {
    workspace_id: ID(workspace_id.to_string()),
    theme_slug: profile.theme.slug,
    theme_name: profile.theme.name,
    inherits_global: profile.scope != "workspace",
  }
}

impl From<FontAssetProjection> for ThemeFontAssetType {
  fn from(value: FontAssetProjection) -> Self {
    Self {
      usage: value.usage,
      format: value.format,
      style: value.style,
      weight_min: value.weight_min,
      weight_max: value.weight_max,
      weight_default: value.weight_default,
      asset_key: value.asset_key,
      sha256: value.sha256,
      mime: value.mime,
      unicode_ranges: value.unicode_ranges,
      subset_tags: value.subset_tags,
    }
  }
}

impl From<BrandAssetProjection> for BrandAssetType {
  fn from(value: BrandAssetProjection) -> Self {
    Self {
      id: ID(value.id.to_string()),
      slot: value.slot,
      variant: value.variant,
      quality_class: value.quality_class,
      storage_kind: value.storage_kind,
      storage_key: value.storage_key,
      public_url: value.public_url,
      mime: value.mime,
      sha256: value.sha256,
      byte_size: value.byte_size,
      width_px: value.width_px,
      height_px: value.height_px,
    }
  }
}

impl From<AppServerBrandingProjection> for AppServerBrandingType {
  fn from(value: AppServerBrandingProjection) -> Self {
    Self {
      logo: value.logo.map(Into::into),
      product_mark: value.product_mark.map(Into::into),
      favicon_pack: value.favicon_pack.map(Into::into),
    }
  }
}

impl From<OrganizationIdentityProjection> for OrganizationIdentityType {
  fn from(value: OrganizationIdentityProjection) -> Self {
    Self {
      display_name: value.display_name,
      legal_name: value.legal_name,
      short_name: value.short_name,
      jurisdiction: value.jurisdiction,
      website_url: value.website_url,
      contact_email: value.contact_email,
      address_lines: value.address_lines,
      tax_id: value.tax_id,
      registration_id: value.registration_id,
    }
  }
}

impl From<FontFamilyProjection> for ThemeFontFamilyType {
  fn from(value: FontFamilyProjection) -> Self {
    Self {
      slug: value.slug,
      display_name: value.display_name,
      css_family: value.css_family,
      generic_class: value.generic_class,
      source: value.source,
      license_spdx: value.license_spdx,
      license_status: value.license_status,
      is_selectable: value.is_selectable,
      assets: value.assets.into_iter().map(Into::into).collect(),
    }
  }
}

impl From<TypographyStyleProjection> for ThemeTypographyStyleType {
  fn from(value: TypographyStyleProjection) -> Self {
    Self {
      style_key: value.style_key,
      font_family_slug: value.font_family_slug,
      font_family: value.font_family,
      css_family: value.css_family,
      font_weight: value.font_weight,
      font_style: value.font_style,
      size_px: value.size_px,
      line_height: value.line_height,
      letter_spacing_em: value.letter_spacing_em,
      text_transform: value.text_transform,
      decoration: value.decoration,
      hover_decoration: value.hover_decoration,
      font_features: value.font_features,
      font_variations: value.font_variations,
      pdf_role: value.pdf_role,
    }
  }
}

impl From<ThemeProjection> for ThemeDefinitionType {
  fn from(value: ThemeProjection) -> Self {
    Self {
      slug: value.slug,
      name: value.name,
      category: value.category,
      preview_group: value.preview_group,
      preview_order: value.preview_order,
      tagline_key: value.tagline_key,
      description_key: value.description_key,
      origin: value.origin,
      locked: value.locked,
      is_default: value.is_default,
      color_schema_slug: value.color_schema_slug,
      typography_slug: value.typography_slug,
      colors: serde_json::to_value(value.colors).unwrap_or_else(|_| JsonValue::Object(Default::default())),
      typography_styles: value.typography_styles.into_iter().map(Into::into).collect(),
    }
  }
}

impl From<ThemeProfileProjection> for ThemeProfileType {
  fn from(value: ThemeProfileProjection) -> Self {
    Self {
      scope: value.scope,
      workspace_id: value.workspace_id.map(|id| ID(id.to_string())),
      theme_mode: value.theme_mode,
      theme: value.theme.into(),
    }
  }
}

impl From<TypographyStylePatchInput> for TypographyStyleUpdate {
  fn from(value: TypographyStylePatchInput) -> Self {
    Self {
      style_key: value.style_key,
      font_family_slug: value.font_family_slug,
      font_weight: value.font_weight,
      font_style: value.font_style,
      size_px: value.size_px,
      line_height: value.line_height,
      letter_spacing_em: value.letter_spacing_em,
      text_transform: value.text_transform,
      decoration: value.decoration,
      hover_decoration: value.hover_decoration,
      font_features: value.font_features,
      font_variations: value.font_variations,
      pdf_role: value.pdf_role,
    }
  }
}

impl From<ColorSchemaValuePatchInput> for ColorValueUpdate {
  fn from(value: ColorSchemaValuePatchInput) -> Self {
    Self {
      mode: value.mode,
      token_key: value.token_key,
      value: value.value,
    }
  }
}

impl From<UpdateOrganizationIdentityInput> for OrganizationIdentityUpdate {
  fn from(value: UpdateOrganizationIdentityInput) -> Self {
    Self {
      display_name: value.display_name,
      legal_name: value.legal_name,
      short_name: value.short_name,
      jurisdiction: value.jurisdiction,
      website_url: value.website_url,
      contact_email: value.contact_email,
      address_lines: JsonValue::Array(
        value
          .address_lines
          .unwrap_or_default()
          .into_iter()
          .map(JsonValue::String)
          .collect(),
      ),
      tax_id: value.tax_id,
      registration_id: value.registration_id,
    }
  }
}

impl TryFrom<UpdateAppServerBrandingInput> for AppServerBrandingUpdate {
  type Error = async_graphql::Error;

  fn try_from(value: UpdateAppServerBrandingInput) -> Result<Self> {
    Ok(Self {
      logo_asset_id: parse_optional_uuid(value.logo_asset_id, "logo_asset_id")?,
      product_mark_asset_id: parse_optional_uuid(value.product_mark_asset_id, "product_mark_asset_id")?,
      favicon_pack_asset_id: parse_optional_uuid(value.favicon_pack_asset_id, "favicon_pack_asset_id")?,
    })
  }
}
