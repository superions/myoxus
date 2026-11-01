// SPDX-License-Identifier: AGPL-3.0-or-later
//! Workspace-scoped read-only GraphQL surface for the PDF-Export V2 stack
//! (`P-PDF-TPL-10`).
//!
//! These queries are the bridge between the admin-only template registry
//! (admin uploads templates, ICC profiles, fonts) and the workspace-facing
//! export picker. A workspace user must never see templates that an admin
//! has not explicitly assigned to their workspace, and must never see
//! another workspace's brand assets.
//!
//! Queries:
//!
//! - `availablePdfTemplates(workspaceId)` — assigned-only template list.
//! - `documentBrandingProfile(workspaceId)` — document-visible branding row
//!   stripped of audit metadata (`updated_at`, `updated_by`).
//! - `pdfExportSettings(workspaceId)` — flat view of the export-time
//!   defaults (default template, locale, paper size, color profile, image
//!   quality, ligatures).
//!
//! Permission model: all three queries reject non-members of the target
//! workspace with [`AuthError::ActionForbidden`]. Membership is resolved via
//! [`PermissionService::get_workspace_role`] — any role other than
//! `External` (which the service maps to `None`) grants read access.

use std::io::Read;
use std::sync::Arc;

use async_graphql::{Context, Enum, ID, Object, Result, SimpleObject, Upload};
use chrono::{DateTime, Utc};
use tracing::{info, instrument, warn};
use uuid::Uuid;

use myoxus_application::auth::AuthError;
use myoxus_application::pdf_export::svg_sanitizer::{SvgSanitizeError, sanitize_svg};
use myoxus_domain::entities::{
  PdfDocumentBrandLogoSlot, PdfTemplate, PdfWorkspaceBrandAsset, PdfWorkspaceTemplateAssignment,
};
use myoxus_domain::repositories::{
  PdfDocumentBrandLogoAsset, PdfTemplateRepository, PdfWorkspaceBrandAssetRepository,
  PdfWorkspaceTemplateAssignmentRepository, RepositoryError,
};

use crate::graphql::admin::resolve_audit_actor;
use crate::graphql::utils::{map_gql_error, require_session};
use crate::state::ApiState;

/// Public, workspace-facing projection of a PDF template. Compared to the
/// internal [`PdfTemplate`] this:
///
/// - Drops `created_by`, `created_at`, `deleted_at` (admin metadata).
/// - Carries the `is_default` flag from the workspace's assignment row so
///   the export picker can pre-select it.
/// - Surfaces `manifest.capabilities` as a JSON sub-object so the picker
///   can render capability inputs (toggle / enum / color / array<string>)
///   without an extra round-trip.
/// - Surfaces `manifest.inputs_schema` so the picker can prefill required
///   `typed_inputs` before the mutation hits the server-side validator.
#[derive(SimpleObject, Clone)]
pub struct PdfTemplatePublic {
  pub id: ID,
  pub slug: String,
  pub name: String,
  pub version: String,
  pub schema_version: String,
  /// `manifest.capabilities` slice as JSON. Empty object if the manifest
  /// has no capabilities block (defensive — schema validation rejects this
  /// at upload time, but we don't trust DB-state invariants here).
  pub capabilities: serde_json::Value,
  /// `manifest.inputs_schema` slice as JSON. Empty object if the manifest
  /// does not constrain typed inputs.
  pub inputs_schema: serde_json::Value,
  /// Whether this template is the workspace's default selection in the
  /// export picker.
  pub is_default: bool,
}

fn template_public(template: PdfTemplate, assignment: &PdfWorkspaceTemplateAssignment) -> PdfTemplatePublic {
  let capabilities = template
    .manifest
    .get("capabilities")
    .cloned()
    .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
  let inputs_schema = template
    .manifest
    .get("inputs_schema")
    .cloned()
    .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
  PdfTemplatePublic {
    id: ID(template.id.to_string()),
    slug: template.slug,
    name: template.name,
    version: template.version,
    schema_version: template.schema_version,
    capabilities,
    inputs_schema,
    is_default: assignment.is_default,
  }
}

/// Workspace document-branding row without audit fields. Document branding is
/// intentionally limited to document-visible identity: logos, footer text and
/// document color policy. Render defaults live in [`PdfExportSettings`].
#[derive(SimpleObject, Clone, Default)]
#[graphql(name = "DocumentBrandingProfile")]
pub struct DocumentBrandingProfilePublic {
  pub workspace_id: ID,
  pub logo_large_blob: Option<String>,
  pub logo_small_blob: Option<String>,
  pub footer_text: Option<String>,
  pub color_policy: String,
  pub color_palette_key: Option<String>,
  pub brand_color_primary: Option<String>,
  pub brand_color_accent: Option<String>,
  pub brand_color_rule: Option<String>,
  pub brand_color_text: Option<String>,
  pub brand_color_background: Option<String>,
}

impl DocumentBrandingProfilePublic {
  fn from_entity(asset: PdfWorkspaceBrandAsset) -> Self {
    Self {
      workspace_id: ID(asset.workspace_id.to_string()),
      logo_large_blob: asset.logo_large_blob,
      logo_small_blob: asset.logo_small_blob,
      footer_text: asset.footer_text,
      color_policy: asset.color_policy,
      color_palette_key: asset.color_palette_key,
      brand_color_primary: asset.brand_color_primary,
      brand_color_accent: asset.brand_color_accent,
      brand_color_rule: asset.brand_color_rule,
      brand_color_text: asset.brand_color_text,
      brand_color_background: asset.brand_color_background,
    }
  }

  /// The document-branding row for a workspace is optional. The export picker
  /// still needs a stable reply, so we emit a default-filled object keyed on
  /// the workspace id with all optional document-branding fields `null`.
  fn empty_for(workspace_id: Uuid) -> Self {
    Self {
      workspace_id: ID(workspace_id.to_string()),
      color_policy: "theme_palette".to_owned(),
      color_palette_key: Some("balanced".to_owned()),
      ..Default::default()
    }
  }
}

/// Flat view of the per-workspace export-time defaults. This is the only
/// workspace-facing contract for paper, locale, ICC profile, image quality,
/// ligatures and default template.
#[derive(SimpleObject, Clone, Default)]
#[graphql(name = "PdfExportSettings")]
pub struct PdfExportSettings {
  pub workspace_id: ID,
  pub default_template_id: Option<ID>,
  pub default_locale: Option<String>,
  pub default_paper_size: Option<String>,
  pub default_color_profile: Option<String>,
  pub default_image_quality: Option<String>,
  pub ligatures_enabled: bool,
}

impl PdfExportSettings {
  fn from_brand(asset: &PdfWorkspaceBrandAsset) -> Self {
    Self {
      workspace_id: ID(asset.workspace_id.to_string()),
      default_template_id: asset.default_template_id.map(|id| ID(id.to_string())),
      default_locale: asset.default_locale.clone(),
      default_paper_size: asset.default_paper_size.clone(),
      default_color_profile: asset.default_color_profile.clone(),
      default_image_quality: asset.default_image_quality.clone(),
      ligatures_enabled: asset.ligatures_enabled,
    }
  }

  fn empty_for(workspace_id: Uuid) -> Self {
    Self {
      workspace_id: ID(workspace_id.to_string()),
      ligatures_enabled: true,
      ..Default::default()
    }
  }

  fn with_effective_defaults(mut self, main_web_locale: &str, config: &crate::config::PdfExportConfig) -> Self {
    let fallback = |value: Option<String>, default: &str| {
      value
        .filter(|value| !value.trim().is_empty())
        .or_else(|| Some(default.to_owned()))
    };
    self.default_locale = fallback(
      self.default_locale,
      if main_web_locale.trim().is_empty() {
        "en"
      } else {
        main_web_locale
      },
    );
    self.default_paper_size = fallback(self.default_paper_size, &config.default_paper_size);
    self.default_color_profile = fallback(self.default_color_profile, &config.default_color_profile);
    self.default_image_quality = fallback(self.default_image_quality, &config.default_image_quality);
    self
  }
}

fn map_repo_err(err: RepositoryError) -> async_graphql::Error {
  match err {
    RepositoryError::NotFound(what) => async_graphql::Error::new(format!("{what} not found")),
    other => async_graphql::Error::new(other.to_string()),
  }
}

/// Reject non-members of `workspace_id`. Returns the resolved
/// `(state, user_id)` pair on success.
async fn require_workspace_member(ctx: &Context<'_>, workspace_id: Uuid) -> Result<(Arc<ApiState>, Uuid)> {
  let (state, snapshot) = require_session(ctx).await?;
  let role = state
    .permission_service()
    .get_effective_workspace_role(snapshot.user.id, workspace_id)
    .await
    .ok()
    .flatten();
  if role.is_none() {
    warn!(
      user_id = %snapshot.user.id,
      workspace_id = %workspace_id,
      "non-member tried to read workspace-scoped pdf surface"
    );
    return Err(map_gql_error(AuthError::ActionForbidden));
  }
  Ok((state, snapshot.user.id))
}

fn require_template_repo(state: &ApiState) -> Result<Arc<dyn PdfTemplateRepository>> {
  state
    .pdf_template_repo()
    .ok_or_else(|| async_graphql::Error::new("pdf template repository is not configured on this server"))
}

fn require_assignment_repo(state: &ApiState) -> Result<Arc<dyn PdfWorkspaceTemplateAssignmentRepository>> {
  state
    .pdf_assignment_repo()
    .ok_or_else(|| async_graphql::Error::new("pdf assignment repository is not configured on this server"))
}

fn require_brand_repo(state: &ApiState) -> Result<Arc<dyn PdfWorkspaceBrandAssetRepository>> {
  state
    .pdf_brand_repo()
    .ok_or_else(|| async_graphql::Error::new("pdf brand asset repository is not configured on this server"))
}

pub struct PdfWorkspaceQueryRoot;

#[Object]
impl PdfWorkspaceQueryRoot {
  /// List the PDF templates assigned to `workspace_id`. Each row carries
  /// the workspace's per-assignment `is_default` flag and the template's
  /// `manifest.capabilities` block as JSON.
  ///
  /// Permission: caller must be a member of the workspace. Soft-deleted
  /// templates are filtered out — a leftover assignment to a tombstoned
  /// template is silently dropped.
  #[instrument(skip(self, ctx))]
  pub async fn available_pdf_templates(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    locale: Option<String>,
  ) -> Result<Vec<PdfTemplatePublic>> {
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let (state, _user_id) = require_workspace_member(ctx, ws).await?;

    let template_repo = require_template_repo(&state)?;
    let assignment_repo = require_assignment_repo(&state)?;

    let assignments = assignment_repo.list_for_workspace(ws).await.map_err(map_repo_err)?;
    let mut out = Vec::with_capacity(assignments.len());
    for assignment in assignments {
      let Some(template) = template_repo
        .get_by_id(assignment.template_id)
        .await
        .map_err(map_repo_err)?
      else {
        // Stale assignment row for a soft-deleted/missing template — skip
        // silently so the picker stays consistent until an admin cleans up.
        continue;
      };
      if template.deleted_at.is_some() {
        continue;
      }
      let mut public = template_public(template, &assignment);
      if let Some(locale) = locale.as_deref() {
        use myoxus_pdf_export::template_v2::PdfTemplateRegistry;
        let blobs = state
          .pdf_blob_store()
          .ok_or_else(|| async_graphql::Error::new("PDF blob store unavailable"))?;
        let pool = state
          .metrics_pool()
          .ok_or_else(|| async_graphql::Error::new("DB unavailable"))?;
        let registry =
          myoxus_infrastructure::pdf_export::PgPdfTemplateRegistry::new(pool.clone(), template_repo.clone(), blobs);
        let bundle = registry
          .load(assignment.template_id)
          .await
          .map_err(|e| async_graphql::Error::new(e.to_string()))?;
        // Bundle translations are template-owned for both system and uploaded templates.
        let labels = myoxus_application::pdf_export::render_context::load_translations(&bundle, locale)
          .map_err(|e| async_graphql::Error::new(e.to_string()))?;
        if let Some(name) = labels.get("template_name").filter(|name| !name.trim().is_empty()) {
          public.name = name.clone();
        }
      }
      out.push(public);
    }
    Ok(out)
  }

  /// Return the workspace's document-branding row. Returns a default-filled
  /// object when it has not yet been configured by an admin.
  ///
  /// Permission: caller must be a member of the workspace.
  #[instrument(skip(self, ctx))]
  pub async fn document_branding_profile(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<DocumentBrandingProfilePublic> {
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let (state, _user_id) = require_workspace_member(ctx, ws).await?;

    let brand_repo = require_brand_repo(&state)?;
    let asset = brand_repo.get(ws).await.map_err(map_repo_err)?;
    Ok(match asset {
      Some(row) => DocumentBrandingProfilePublic::from_entity(row),
      None => DocumentBrandingProfilePublic::empty_for(ws),
    })
  }

  /// Return the workspace's export-time defaults with a single round-trip.
  ///
  /// Permission: caller must be a member of the workspace.
  #[instrument(skip(self, ctx))]
  pub async fn pdf_export_settings(&self, ctx: &Context<'_>, workspace_id: ID) -> Result<PdfExportSettings> {
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let (state, _user_id) = require_workspace_member(ctx, ws).await?;

    let brand_repo = require_brand_repo(&state)?;
    let asset = brand_repo.get(ws).await.map_err(map_repo_err)?;
    Ok(
      match asset {
        Some(row) => PdfExportSettings::from_brand(&row),
        None => PdfExportSettings::empty_for(ws),
      }
      .with_effective_defaults(&state.config.i18n.default_locale, &state.config.pdf_export),
    )
  }
}

// ===========================================================================
// Admin-side surfaces (P-PDF-TPL-08)
//
// Workspace ↔ template assignment management. Admin-only — every resolver
// rejects non-admin sessions with `AuthError::ActionForbidden`. Mutations
// emit `AuditCategory::PdfExportConfig` events so admin actions are
// reproducible from the audit log alone.
// ===========================================================================

/// Full workspace ↔ template assignment row, with the per-row audit metadata
/// the admin UI needs to show "who assigned this template, and when". Compare
/// to [`PdfTemplatePublic`] which is intentionally minimal for workspace
/// members.
#[derive(SimpleObject, Clone)]
pub struct PdfWorkspaceTemplateAssignmentType {
  pub workspace_id: ID,
  pub template_id: ID,
  pub is_default: bool,
  pub assigned_by: Option<ID>,
  pub assigned_at: DateTime<Utc>,
}

impl From<PdfWorkspaceTemplateAssignment> for PdfWorkspaceTemplateAssignmentType {
  fn from(a: PdfWorkspaceTemplateAssignment) -> Self {
    Self {
      workspace_id: ID(a.workspace_id.to_string()),
      template_id: ID(a.template_id.to_string()),
      is_default: a.is_default,
      assigned_by: a.assigned_by.map(|user_id| ID(user_id.to_string())),
      assigned_at: a.assigned_at,
    }
  }
}

/// Admin projection of document-visible branding including the audit fields
/// (`updated_at`, `updated_by`). PDF export defaults are exposed through
/// [`PdfExportSettings`] and deliberately do not appear here.
#[derive(SimpleObject, Clone)]
#[graphql(name = "DocumentBrandingProfileAdmin")]
pub struct DocumentBrandingProfileType {
  pub workspace_id: ID,
  pub logo_large_blob: Option<String>,
  pub logo_small_blob: Option<String>,
  pub footer_text: Option<String>,
  pub color_policy: String,
  pub color_palette_key: Option<String>,
  pub brand_color_primary: Option<String>,
  pub brand_color_accent: Option<String>,
  pub brand_color_rule: Option<String>,
  pub brand_color_text: Option<String>,
  pub brand_color_background: Option<String>,
  pub updated_at: DateTime<Utc>,
  pub updated_by: ID,
}

impl From<PdfWorkspaceBrandAsset> for DocumentBrandingProfileType {
  fn from(a: PdfWorkspaceBrandAsset) -> Self {
    Self {
      workspace_id: ID(a.workspace_id.to_string()),
      logo_large_blob: a.logo_large_blob,
      logo_small_blob: a.logo_small_blob,
      footer_text: a.footer_text,
      color_policy: a.color_policy,
      color_palette_key: a.color_palette_key,
      brand_color_primary: a.brand_color_primary,
      brand_color_accent: a.brand_color_accent,
      brand_color_rule: a.brand_color_rule,
      brand_color_text: a.brand_color_text,
      brand_color_background: a.brand_color_background,
      updated_at: a.updated_at,
      updated_by: ID(a.updated_by.to_string()),
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum DocumentBrandColorPolicy {
  #[graphql(name = "theme_palette")]
  ThemePalette,
  #[graphql(name = "plain")]
  Plain,
}

impl DocumentBrandColorPolicy {
  fn as_db_str(self) -> &'static str {
    match self {
      Self::ThemePalette => "theme_palette",
      Self::Plain => "plain",
    }
  }
}

/// Reduced document/PDF color proposal derived from the effective app theme.
/// The admin UI may present these as choices, but the mapping from theme to
/// document-safe colors stays server-owned.
#[derive(SimpleObject, Clone)]
pub struct DocumentBrandColorPaletteType {
  pub theme_slug: String,
  pub theme_name: String,
  pub palette_key: String,
  pub name: String,
  pub primary_color: String,
  pub accent_color: String,
  pub rule_color: String,
  pub text_color: String,
  pub background_color: String,
  pub is_default: bool,
}

/// Reject non-admin sessions with `ActionForbidden`. Returns the resolved
/// `(state, admin_user_id)` pair on success.
async fn require_admin(ctx: &Context<'_>) -> Result<(Arc<ApiState>, Uuid)> {
  let (state, snapshot) = require_session(ctx).await?;
  if !snapshot.user.is_admin {
    warn!(
      user_id = %snapshot.user.id,
      "non-admin tried to access pdf workspace admin surface"
    );
    return Err(map_gql_error(AuthError::ActionForbidden));
  }
  Ok((state, snapshot.user.id))
}

/// Read the current split document-branding / PDF-settings projection for
/// `ws`, or build a default-filled row keyed on `ws` with `ligatures_enabled =
/// true` matching the settings default. `updated_by` is set to `actor` only for
/// first writes; the default object itself is never persisted.
async fn brand_asset_or_default(
  brand_repo: &Arc<dyn PdfWorkspaceBrandAssetRepository>,
  ws: Uuid,
  actor: Uuid,
) -> Result<PdfWorkspaceBrandAsset> {
  if let Some(existing) = brand_repo.get(ws).await.map_err(map_repo_err)? {
    return Ok(existing);
  }
  Ok(PdfWorkspaceBrandAsset {
    workspace_id: ws,
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
    updated_by: actor,
  })
}

pub struct PdfWorkspaceAdminQueryRoot;

#[Object]
impl PdfWorkspaceAdminQueryRoot {
  /// List every template assigned to `workspace_id`, ordered by `assigned_at`.
  /// Admin-only — workspace members must use `availablePdfTemplates` instead,
  /// which strips audit metadata and joins template details.
  #[instrument(skip(self, ctx))]
  pub async fn pdf_workspace_assignments(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Vec<PdfWorkspaceTemplateAssignmentType>> {
    let (state, _admin_id) = require_admin(ctx).await?;
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let repo = require_assignment_repo(&state)?;
    let rows = repo.list_for_workspace(ws).await.map_err(map_repo_err)?;
    Ok(rows.into_iter().map(Into::into).collect())
  }

  /// List every workspace that currently has `template_id` assigned.
  /// Admin-only. Used by the template detail view to surface "this template
  /// is currently used by N workspaces — unassign before delete".
  #[instrument(skip(self, ctx))]
  pub async fn pdf_template_assigned_workspaces(
    &self,
    ctx: &Context<'_>,
    template_id: ID,
  ) -> Result<Vec<PdfWorkspaceTemplateAssignmentType>> {
    let (state, _admin_id) = require_admin(ctx).await?;
    let tpl = Uuid::parse_str(template_id.as_str()).map_err(|_| async_graphql::Error::new("invalid template id"))?;
    let repo = require_assignment_repo(&state)?;
    let rows = repo.list_for_template(tpl).await.map_err(map_repo_err)?;
    Ok(rows.into_iter().map(Into::into).collect())
  }
}

async fn validate_document_color_policy(
  state: &ApiState,
  ws: Uuid,
  policy: DocumentBrandColorPolicy,
  palette_key: &str,
) -> Result<String> {
  let palette_key = palette_key.trim();
  if palette_key.is_empty() {
    return Err(async_graphql::Error::new(
      "document branding palette key must not be empty",
    ));
  }
  match policy {
    DocumentBrandColorPolicy::Plain if palette_key != "plain" => {
      return Err(async_graphql::Error::new(
        "plain document branding must use palette key `plain`",
      ));
    }
    DocumentBrandColorPolicy::ThemePalette if palette_key == "plain" => {
      return Err(async_graphql::Error::new(
        "plain is its own document branding color policy, not a theme palette",
      ));
    }
    _ => {}
  }

  let exists = require_brand_repo(state)?
    .document_color_palette_exists(ws, palette_key)
    .await
    .map_err(|err| {
      warn!(workspace_id = %ws, palette_key, error = %err, "failed to validate document brand color palette");
      async_graphql::Error::new("failed to validate document brand color palette")
    })?;
  if !exists {
    return Err(async_graphql::Error::new(format!(
      "document branding palette `{palette_key}` is not available for the workspace's effective theme"
    )));
  }
  Ok(palette_key.to_owned())
}

pub struct PdfWorkspaceAdminMutationRoot;

#[Object]
impl PdfWorkspaceAdminMutationRoot {
  /// Grant `workspace_id` access to `template_id`. Idempotent: a no-op if the
  /// assignment already exists. Admin-only; emits a `pdf_workspace.assign`
  /// audit event.
  ///
  /// The new assignment is created with `is_default = false`. To make it the
  /// workspace's pre-selected default, call `setWorkspaceDefaultPdfTemplate`
  /// next.
  #[instrument(skip_all)]
  pub async fn assign_pdf_template_to_workspace(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    template_id: ID,
  ) -> Result<PdfWorkspaceTemplateAssignmentType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let audit_actor = Some(resolve_audit_actor(ctx).await);
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let tpl = Uuid::parse_str(template_id.as_str()).map_err(|_| async_graphql::Error::new("invalid template id"))?;

    let template_repo = require_template_repo(&state)?;
    let template = template_repo
      .get_by_id(tpl)
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("pdf template not found"))?;
    if template.deleted_at.is_some() {
      return Err(async_graphql::Error::new(
        "pdf template has been soft-deleted and cannot be assigned",
      ));
    }

    let repo = require_assignment_repo(&state)?;
    repo
      .assign(ws, tpl, admin_id, audit_actor)
      .await
      .map_err(map_repo_err)?;

    let row = repo
      .get(ws, tpl)
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("assignment row missing after upsert"))?;

    info!(
      workspace_id = %ws,
      template_id = %tpl,
      admin_id = %admin_id,
      "pdf template assigned to workspace"
    );

    Ok(row.into())
  }

  /// Revoke `workspace_id`'s access to `template_id`. Returns `true` if the
  /// assignment existed and was removed, `false` if no row matched.
  ///
  /// **Refused** when the assignment is the workspace's current default —
  /// the caller must first set a different default (or unset it) via
  /// `setWorkspaceDefaultPdfTemplate`. This guard keeps the
  /// `pdf_export_settings.default_template_id` consistent with the assignment
  /// table.
  ///
  /// Admin-only; emits a `pdf_workspace.unassign` audit event when a row is
  /// actually removed.
  #[instrument(skip_all)]
  pub async fn unassign_pdf_template_from_workspace(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    template_id: ID,
  ) -> Result<bool> {
    let (state, admin_id) = require_admin(ctx).await?;
    let audit_actor = Some(resolve_audit_actor(ctx).await);
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let tpl = Uuid::parse_str(template_id.as_str()).map_err(|_| async_graphql::Error::new("invalid template id"))?;

    let repo = require_assignment_repo(&state)?;
    if !repo.unassign(ws, tpl, audit_actor).await.map_err(map_repo_err)? {
      return Ok(false);
    }

    info!(
      workspace_id = %ws,
      template_id = %tpl,
      admin_id = %admin_id,
      "pdf template unassigned from workspace"
    );

    Ok(true)
  }

  /// Atomically designate `template_id` as `workspace_id`'s default PDF
  /// template. Both the partial-unique-indexed assignment row and the
  /// `pdf_export_settings.default_template_id` owner are updated.
  ///
  /// The assignment must already exist — call
  /// `assignPdfTemplateToWorkspace` first. If no brand-asset row exists for
  /// the workspace yet, the effective settings are captured in its override.
  /// Assignment, settings and the authenticated audit commit together.
  ///
  /// Admin-only; emits a `pdf_workspace.set_default` audit event.
  #[instrument(skip_all)]
  pub async fn set_workspace_default_pdf_template(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    template_id: ID,
  ) -> Result<PdfExportSettings> {
    let (state, admin_id) = require_admin(ctx).await?;
    let audit_actor = Some(resolve_audit_actor(ctx).await);
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let tpl = Uuid::parse_str(template_id.as_str()).map_err(|_| async_graphql::Error::new("invalid template id"))?;

    let assignment_repo = require_assignment_repo(&state)?;
    let brand_repo = require_brand_repo(&state)?;

    assignment_repo
      .set_default(ws, tpl, admin_id, audit_actor)
      .await
      .map_err(|err| match err {
        RepositoryError::NotFound(_) => async_graphql::Error::new(
          "pdf template is not assigned to this workspace — assign it before setting as default",
        ),
        other => map_repo_err(other),
      })?;
    let brand = brand_asset_or_default(&brand_repo, ws, admin_id).await?;

    Ok(PdfExportSettings::from_brand(&brand))
  }
}

// ===========================================================================
// Document-branding and PDF export settings admin surface.
//
// The UI presents both concerns inside the PDF export configuration area, but
// the GraphQL contract keeps the owners separate: document-visible identity
// flows through `documentBrandingProfile` and renderer defaults flow through
// `pdfExportSettings`. Logos go to the [`PdfBlobStore`]; SVG uploads are
// sanitised through [`sanitize_svg`] before any blob is written.
// ===========================================================================

/// Identifies which logo slot a brand-asset upload/delete targets. The two
/// slots are mirrored on the entity as `logo_large_blob` / `logo_small_blob`.
#[derive(async_graphql::Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(rename_items = "PascalCase")]
pub enum BrandLogoKind {
  /// Cover-page / hero logo. Maps to `logo_large_blob`.
  Large,
  /// Header / footer mark. Maps to `logo_small_blob`.
  Small,
}

impl BrandLogoKind {
  fn slot(self) -> &'static str {
    match self {
      Self::Large => "large",
      Self::Small => "small",
    }
  }
}

/// PNG magic number (8 bytes). Used to detect PNG inputs without decoding.
const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// Recognise the upload format from the leading bytes. Anything that isn't
/// PNG falls through to the SVG sanitizer, which rejects non-SVG payloads
/// during parse.
fn detect_logo_kind(bytes: &[u8]) -> LogoFormat {
  if bytes.len() >= 8 && bytes[..8] == PNG_SIGNATURE {
    LogoFormat::Png
  } else {
    LogoFormat::Svg
  }
}

#[derive(Copy, Clone, Eq, PartialEq, Debug)]
enum LogoFormat {
  Png,
  Svg,
}

impl LogoFormat {
  fn extension(self) -> &'static str {
    match self {
      Self::Png => "png",
      Self::Svg => "svg",
    }
  }

  fn mime(self) -> &'static str {
    match self {
      Self::Png => "image/png",
      Self::Svg => "image/svg+xml",
    }
  }
}

/// Validate a `#RRGGBB` colour literal. Trims surrounding whitespace.
/// Returns the normalised lowercase form on success.
fn normalise_hex_color(input: &str) -> Result<String, &'static str> {
  let trimmed = input.trim();
  if trimmed.len() != 7 || !trimmed.starts_with('#') {
    return Err("color must be a 7-character hex literal like #RRGGBB");
  }
  if !trimmed[1..].chars().all(|c| c.is_ascii_hexdigit()) {
    return Err("color must be a hex literal like #RRGGBB");
  }
  Ok(trimmed.to_ascii_lowercase())
}

/// Read the upload to bytes, enforcing the configured per-asset cap. Returns
/// the raw bytes ready for format detection / sanitization.
fn read_upload_capped(ctx: &Context<'_>, upload: Upload, max_bytes: u64) -> Result<Vec<u8>> {
  let value = upload
    .value(ctx)
    .map_err(|e| async_graphql::Error::new(format!("invalid upload: {e}")))?;
  let mut data = Vec::new();
  let cap = max_bytes.saturating_add(1);
  let mut limited = value.content.take(cap);
  limited
    .read_to_end(&mut data)
    .map_err(|e| async_graphql::Error::new(format!("failed to read uploaded file: {e}")))?;
  if data.is_empty() {
    return Err(async_graphql::Error::new("brand logo is empty"));
  }
  if data.len() as u64 > max_bytes {
    return Err(async_graphql::Error::new(format!(
      "brand logo exceeds the {} MiB size limit",
      max_bytes / 1_048_576
    )));
  }
  Ok(data)
}

pub struct PdfWorkspaceBrandAdminQueryRoot;

#[Object]
impl PdfWorkspaceBrandAdminQueryRoot {
  /// Return the workspace's document-branding profile including audit
  /// metadata (`updated_at`, `updated_by`). Admin-only — the workspace-facing
  /// projection is `documentBrandingProfile`.
  ///
  /// When no row has been configured yet, a default-filled row is returned
  /// so the admin UI can display the form without a separate "create" step.
  #[instrument(skip(self, ctx))]
  pub async fn document_branding_profile(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<DocumentBrandingProfileType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let brand_repo = require_brand_repo(&state)?;
    let asset = brand_asset_or_default(&brand_repo, ws, admin_id).await?;
    Ok(asset.into())
  }

  /// Return the document-safe color palettes for the workspace's effective
  /// theme. This is deliberately a server query: clients must not duplicate
  /// theme-token-to-document-palette rules.
  #[instrument(skip(self, ctx))]
  pub async fn document_brand_color_palettes(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Vec<DocumentBrandColorPaletteType>> {
    let (state, _admin_id) = require_admin(ctx).await?;
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let rows = require_brand_repo(&state)?
      .list_document_color_palettes(ws)
      .await
      .map_err(|err| {
        warn!(workspace_id = %ws, error = %err, "failed to load document brand color palettes");
        async_graphql::Error::new("failed to load document brand color palettes")
      })?;

    Ok(
      rows
        .into_iter()
        .map(|palette| DocumentBrandColorPaletteType {
          theme_slug: palette.theme_slug,
          theme_name: palette.theme_name,
          palette_key: palette.palette_key,
          name: palette.name,
          primary_color: palette.primary_color,
          accent_color: palette.accent_color,
          rule_color: palette.rule_color,
          text_color: palette.text_color,
          background_color: palette.background_color,
          is_default: palette.is_default,
        })
        .collect(),
    )
  }

  /// Return the workspace's PDF export settings. These settings are not
  /// document branding; they control renderer defaults such as paper size,
  /// locale, ICC profile, image quality, ligatures and the default template.
  #[instrument(skip(self, ctx))]
  pub async fn pdf_export_settings(&self, ctx: &Context<'_>, workspace_id: ID) -> Result<PdfExportSettings> {
    let (state, admin_id) = require_admin(ctx).await?;
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let brand_repo = require_brand_repo(&state)?;
    let asset = brand_asset_or_default(&brand_repo, ws, admin_id).await?;
    Ok(
      PdfExportSettings::from_brand(&asset)
        .with_effective_defaults(&state.config.i18n.default_locale, &state.config.pdf_export),
    )
  }
}

pub struct PdfWorkspaceBrandAdminMutationRoot;

#[Object]
impl PdfWorkspaceBrandAdminMutationRoot {
  /// Upload a logo for `workspace_id` in slot `kind`. Accepts PNG or SVG
  /// payloads up to `pdf_export.max_brand_asset_size_mb`. SVG inputs are
  /// re-serialised through usvg, which strips `<script>`, on-* event
  /// handlers, `xlink:href` JS-schemes, and `<foreignObject>` HTML.
  ///
  /// New bytes have an operation-owned key; committed previous bytes remain
  /// readable for captured exports. Metadata and audit commit together. Admin-only.
  #[instrument(skip_all)]
  pub async fn upload_document_brand_logo(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    kind: BrandLogoKind,
    file: Upload,
  ) -> Result<DocumentBrandingProfileType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let audit_actor = Some(resolve_audit_actor(ctx).await);
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let max_bytes = state.config.pdf_export.max_brand_asset_bytes();
    let raw = read_upload_capped(ctx, file, max_bytes)?;

    let detected = detect_logo_kind(&raw);
    let payload = match detected {
      LogoFormat::Png => raw,
      LogoFormat::Svg => {
        sanitize_svg(&raw)
          .map_err(|e| match e {
            SvgSanitizeError::Empty => async_graphql::Error::new("brand logo is empty"),
            SvgSanitizeError::NotUtf8 => async_graphql::Error::new("svg upload must be UTF-8 encoded"),
            SvgSanitizeError::Parse(msg) => async_graphql::Error::new(format!("invalid svg upload: {msg}")),
          })?
          .bytes
      }
    };

    let blob_store = state
      .pdf_blob_store()
      .ok_or_else(|| async_graphql::Error::new("pdf blob store is not configured on this server"))?;
    let brand_repo = require_brand_repo(&state)?;

    let asset_kind = format!("{}.{}", kind.slot(), detected.extension());
    let (blob_key, sha256) = blob_store
      .put_brand_asset(ws, &asset_kind, &payload)
      .await
      .map_err(map_repo_err)?;

    let updated_at = Utc::now();
    let slot = match kind {
      BrandLogoKind::Large => PdfDocumentBrandLogoSlot::Large,
      BrandLogoKind::Small => PdfDocumentBrandLogoSlot::Small,
    };
    if let Err(err) = brand_repo
      .set_document_logo_blob(
        ws,
        slot,
        Some(PdfDocumentBrandLogoAsset {
          blob_key: blob_key.clone(),
          sha256: sha256.clone(),
          mime: detected.mime().to_string(),
          byte_size: payload.len() as i64,
        }),
        admin_id,
        updated_at,
        audit_actor,
      )
      .await
      .map_err(map_repo_err)
    {
      // Best-effort cleanup so we don't leak a freshly uploaded blob when
      // the row write fails.
      let _ = blob_store.delete(&blob_key).await;
      return Err(err);
    }
    // Committed predecessors remain readable for already admitted exports.
    let brand = brand_asset_or_default(&brand_repo, ws, admin_id).await?;

    info!(workspace_id = %ws, kind = ?kind, format = ?detected, "document brand logo uploaded");

    Ok(brand.into())
  }

  /// Remove a logo from `workspace_id`'s `kind` slot. Idempotent — calling
  /// twice is a no-op for the second call. Admin-only.
  #[instrument(skip_all)]
  pub async fn delete_document_brand_logo(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    kind: BrandLogoKind,
  ) -> Result<DocumentBrandingProfileType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let audit_actor = Some(resolve_audit_actor(ctx).await);
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;

    let brand_repo = require_brand_repo(&state)?;
    let updated_at = Utc::now();
    let slot = match kind {
      BrandLogoKind::Large => PdfDocumentBrandLogoSlot::Large,
      BrandLogoKind::Small => PdfDocumentBrandLogoSlot::Small,
    };
    let removed = brand_repo
      .set_document_logo_blob(ws, slot, None, admin_id, updated_at, audit_actor)
      .await
      .map_err(map_repo_err)?;

    let brand = brand_asset_or_default(&brand_repo, ws, admin_id).await?;

    info!(workspace_id = %ws, kind = ?kind, removed = removed.is_some(), "document brand logo deleted");

    Ok(brand.into())
  }

  /// Remove all workspace-owned document-branding overrides so the workspace
  /// inherits the global document-branding profile again. PDF export settings
  /// are a separate owner and are intentionally preserved.
  #[instrument(skip_all)]
  pub async fn reset_workspace_document_branding(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<DocumentBrandingProfileType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let audit_actor = Some(resolve_audit_actor(ctx).await);
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let brand_repo = require_brand_repo(&state)?;

    let reset = brand_repo
      .reset_workspace_document_branding(ws, audit_actor)
      .await
      .map_err(map_repo_err)?;

    let after = brand_asset_or_default(&brand_repo, ws, admin_id).await?;
    info!(
      workspace_id = %ws,
      admin_id = %admin_id,
      removed_profile = reset.removed_profile,
      removed_asset_rows = reset.removed_asset_rows,
      removed_logo_blobs = reset.removed_logo_blobs.len(),
      "workspace document branding reset to global inheritance"
    );

    Ok(after.into())
  }

  /// Update document-facing footer text. Organisation identity is global and
  /// is not mutated through workspace document branding.
  #[instrument(skip_all)]
  pub async fn update_document_branding_text(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    footer_text: Option<String>,
  ) -> Result<DocumentBrandingProfileType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let audit_actor = Some(resolve_audit_actor(ctx).await);
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let brand_repo = require_brand_repo(&state)?;
    let footer_text = footer_text.and_then(|s| {
      let t = s.trim().to_string();
      if t.is_empty() { None } else { Some(t) }
    });
    let updated_at = Utc::now();
    brand_repo
      .set_document_branding_text(ws, footer_text, admin_id, updated_at, audit_actor)
      .await
      .map_err(map_repo_err)?;

    Ok(brand_asset_or_default(&brand_repo, ws, admin_id).await?.into())
  }

  /// Update the document colour pair. Custom document colours are an atomic
  /// primary/accent pair in the DB model: callers either provide both
  /// `#RRGGBB` literals or clear both. Accepting half a pair would silently
  /// downgrade the profile back to the theme palette in the repository layer.
  #[instrument(skip_all)]
  pub async fn update_document_branding_colors(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    primary: Option<String>,
    accent: Option<String>,
  ) -> Result<DocumentBrandingProfileType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let audit_actor = Some(resolve_audit_actor(ctx).await);
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let validated_primary = match primary {
      None => None,
      Some(s) => Some(normalise_hex_color(&s).map_err(|e| async_graphql::Error::new(format!("primary {e}")))?),
    };
    let validated_accent = match accent {
      None => None,
      Some(s) => Some(normalise_hex_color(&s).map_err(|e| async_graphql::Error::new(format!("accent {e}")))?),
    };
    if validated_primary.is_some() != validated_accent.is_some() {
      return Err(async_graphql::Error::new(
        "document branding colors must provide both primary and accent or clear both",
      ));
    }

    let brand_repo = require_brand_repo(&state)?;
    let updated_at = Utc::now();
    brand_repo
      .set_document_branding_colors(
        ws,
        validated_primary,
        validated_accent,
        admin_id,
        updated_at,
        audit_actor,
      )
      .await
      .map_err(map_repo_err)?;

    Ok(brand_asset_or_default(&brand_repo, ws, admin_id).await?.into())
  }

  /// Select a document-safe colour policy resolved by the server from the
  /// effective theme. Use `updateDocumentBrandingColors` only for explicit
  /// custom colours; palette and plain choices stay referenced by key so theme
  /// changes can update document previews without duplicated colour literals.
  #[instrument(skip_all)]
  pub async fn set_document_branding_color_policy(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    policy: DocumentBrandColorPolicy,
    palette_key: String,
  ) -> Result<DocumentBrandingProfileType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let audit_actor = Some(resolve_audit_actor(ctx).await);
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let palette_key = validate_document_color_policy(&state, ws, policy, &palette_key).await?;
    let brand_repo = require_brand_repo(&state)?;
    let updated_at = Utc::now();
    brand_repo
      .set_document_branding_color_policy(ws, policy.as_db_str(), &palette_key, admin_id, updated_at, audit_actor)
      .await
      .map_err(map_repo_err)?;
    let after = brand_asset_or_default(&brand_repo, ws, admin_id).await?;

    info!(
      workspace_id = %ws,
      policy = policy.as_db_str(),
      palette_key,
      admin_id = %admin_id,
      "document branding color policy selected"
    );

    Ok(after.into())
  }

  /// Update the workspace's per-export defaults (paper size, locale, color
  /// profile, image quality, ligatures). Each argument is optional; `null`
  /// preserves the prior value. Renderer-controlled enums are validated
  /// before persistence. `ligatures_enabled` is the
  /// only argument that toggles a non-null column. Admin-only.
  #[instrument(skip_all)]
  #[allow(clippy::too_many_arguments)]
  pub async fn update_pdf_export_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    paper_size: Option<String>,
    locale: Option<String>,
    color_profile: Option<String>,
    image_quality: Option<String>,
    ligatures_enabled: Option<bool>,
  ) -> Result<PdfExportSettings> {
    let (state, admin_id) = require_admin(ctx).await?;
    let audit_actor = Some(resolve_audit_actor(ctx).await);
    let ws = Uuid::parse_str(workspace_id.as_str()).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let brand_repo = require_brand_repo(&state)?;
    let mut patch = myoxus_domain::repositories::PdfExportSettingsPatch {
      workspace_id: ws,
      updated_by: admin_id,
      updated_at: Utc::now(),
      ..Default::default()
    };
    let normalize = |s: Option<String>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if let Some(v) = normalize(paper_size) {
      if !matches!(v.as_str(), "A4" | "Letter" | "A3" | "A5") {
        return Err(async_graphql::Error::new("paper_size must be one of A4|Letter|A3|A5"));
      }
      patch.default_paper_size = Some(Some(v));
    }
    if let Some(v) = normalize(locale) {
      if v.len() > 64 {
        return Err(async_graphql::Error::new("locale must be at most 64 characters"));
      }
      patch.default_locale = Some(Some(v));
    }
    if let Some(v) = normalize(color_profile) {
      if !matches!(v.as_str(), "sRGB" | "CMYK_FOGRA39" | "CMYK_SWOP") {
        return Err(async_graphql::Error::new(
          "color_profile must be one of sRGB|CMYK_FOGRA39|CMYK_SWOP",
        ));
      }
      patch.default_color_profile = Some(Some(v));
    }
    if let Some(v) = normalize(image_quality) {
      if !matches!(v.as_str(), "low" | "med" | "high" | "lossless") {
        return Err(async_graphql::Error::new(
          "image_quality must be one of low|med|high|lossless",
        ));
      }
      patch.default_image_quality = Some(Some(v));
    }
    if let Some(v) = ligatures_enabled {
      patch.ligatures_enabled = Some(v);
    }
    brand_repo
      .upsert_pdf_export_settings(&patch, audit_actor)
      .await
      .map_err(map_repo_err)?;

    let brand = brand_asset_or_default(&brand_repo, ws, admin_id).await?;
    Ok(
      PdfExportSettings::from_brand(&brand)
        .with_effective_defaults(&state.config.i18n.default_locale, &state.config.pdf_export),
    )
  }
}
