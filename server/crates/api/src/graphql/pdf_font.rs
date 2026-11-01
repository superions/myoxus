// SPDX-License-Identifier: AGPL-3.0-or-later
//! GraphQL surface for the admin font library
//! (`P-PDF-TPL-FONT-01-{01,02,04,05}`).
//!
//! Admin-only upload add-on surface backed by
//! [`myoxus_domain::repositories::PdfFontRepository`] and the shared
//! [`myoxus_infrastructure::pdf_export::PdfBlobStore`]. Upload validates the
//! font binary via [`myoxus_application::pdf_export::font_validator`] which
//! accepts only SFNT TTF/OTF containers, extracts family/style/weight from
//! the `name` and `OS/2` tables, and auto-detects the license from `name`
//! table ids 13 and 14 when possible. The detected license can be overridden
//! by an explicit `license` argument (SPDX-style identifier).
//!
//! Bundled fonts are not listed here anymore. They are server-owned Theme DB
//! rows (`font_families`/`font_assets`) and reach PDF rendering exclusively
//! through `theme_font_assets`. This surface remains for operator-uploaded
//! PDF add-on fonts; approve/reject mutations move those uploads through the
//! [`PdfFontLicenseStatus`] lifecycle. Only `Approved` uploaded add-ons are
//! materialized as optional extra fonts by the worker.
//!
//! All upload, approve, reject and delete actions emit
//! `pdf_export_config` events in the owning row transaction.

use std::sync::Arc;

use async_graphql::{Context, ID, Object, Result, SimpleObject, Upload};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use tracing::{info, instrument, warn};
use uuid::Uuid;

use myoxus_application::auth::AuthError;
use myoxus_application::pdf_export::font_validator::{FontValidationError, validate_font_bytes};
use myoxus_domain::entities::{PdfFont, PdfFontLicense, PdfFontLicenseStatus};
use myoxus_domain::repositories::RepositoryError;
use myoxus_domain::repositories::{PdfFontStatusAudit, PdfFontUploadAudit};

use crate::graphql::admin::resolve_audit_actor;
use crate::graphql::utils::{map_gql_error, require_session};
use crate::state::ApiState;

#[derive(async_graphql::Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(rename_items = "PascalCase")]
pub enum PdfFontLicenseStatusEnum {
  Pending,
  Approved,
  Rejected,
}

impl From<PdfFontLicenseStatus> for PdfFontLicenseStatusEnum {
  fn from(value: PdfFontLicenseStatus) -> Self {
    match value {
      PdfFontLicenseStatus::Pending => Self::Pending,
      PdfFontLicenseStatus::Approved => Self::Approved,
      PdfFontLicenseStatus::Rejected => Self::Rejected,
    }
  }
}

impl From<PdfFontLicenseStatusEnum> for PdfFontLicenseStatus {
  fn from(value: PdfFontLicenseStatusEnum) -> Self {
    match value {
      PdfFontLicenseStatusEnum::Pending => Self::Pending,
      PdfFontLicenseStatusEnum::Approved => Self::Approved,
      PdfFontLicenseStatusEnum::Rejected => Self::Rejected,
    }
  }
}

/// GraphQL projection of a font row. The `license` field is the SPDX-style
/// identifier (`"OFL-1.1"`, `"Apache-2.0"`, `"MIT"`, `"GPL"`,
/// `"Proprietary"`, or any free-form string for `Other`).
#[derive(SimpleObject, Clone)]
pub struct PdfFontType {
  pub id: ID,
  pub family_name: String,
  pub style: String,
  pub weight: i32,
  pub sha256: String,
  pub license: String,
  pub license_status: PdfFontLicenseStatusEnum,
  /// Always set for rows returned by this add-on upload surface.
  pub uploaded_by: Option<ID>,
  pub uploaded_at: DateTime<Utc>,
  pub approved_by: Option<ID>,
  pub approved_at: Option<DateTime<Utc>>,
}

fn license_to_string(license: &PdfFontLicense) -> String {
  match license {
    PdfFontLicense::Ofl11 => "OFL-1.1".to_owned(),
    PdfFontLicense::Apache20 => "Apache-2.0".to_owned(),
    PdfFontLicense::Mit => "MIT".to_owned(),
    PdfFontLicense::Gpl => "GPL".to_owned(),
    PdfFontLicense::Proprietary => "Proprietary".to_owned(),
    PdfFontLicense::Other(v) => v.clone(),
  }
}

fn license_from_string(value: &str) -> PdfFontLicense {
  match value {
    "OFL-1.1" => PdfFontLicense::Ofl11,
    "Apache-2.0" => PdfFontLicense::Apache20,
    "MIT" => PdfFontLicense::Mit,
    "GPL" => PdfFontLicense::Gpl,
    "Proprietary" => PdfFontLicense::Proprietary,
    other => PdfFontLicense::Other(other.to_owned()),
  }
}

impl From<PdfFont> for PdfFontType {
  fn from(f: PdfFont) -> Self {
    Self {
      id: ID(f.id.to_string()),
      family_name: f.family_name,
      style: f.style,
      weight: f.weight,
      sha256: f.sha256,
      license: license_to_string(&f.license),
      license_status: f.license_status.into(),
      uploaded_by: f.uploaded_by.map(|id| ID(id.to_string())),
      uploaded_at: f.uploaded_at,
      approved_by: f.approved_by.map(|id| ID(id.to_string())),
      approved_at: f.approved_at,
    }
  }
}

/// Verify that the current session belongs to an admin and return their user ID.
async fn ensure_admin_user_id(ctx: &Context<'_>) -> Result<Uuid> {
  let (_, snapshot) = require_session(ctx).await?;
  if !snapshot.user.is_admin {
    warn!(user_id = %snapshot.user.id, "unauthorized admin access attempt on pdfFont surface");
    return Err(map_gql_error(AuthError::ActionForbidden));
  }
  Ok(snapshot.user.id)
}

fn require_font_repo(state: &ApiState) -> Result<Arc<dyn myoxus_domain::repositories::PdfFontRepository>> {
  state
    .pdf_font_repo()
    .ok_or_else(|| async_graphql::Error::new("pdf font repository is not configured on this server"))
}

fn require_blob_store(state: &ApiState) -> Result<Arc<myoxus_infrastructure::pdf_export::PdfBlobStore>> {
  state
    .pdf_blob_store()
    .ok_or_else(|| async_graphql::Error::new("pdf blob store is not configured on this server"))
}

fn map_repo_err(err: RepositoryError) -> async_graphql::Error {
  match err {
    RepositoryError::Conflict(msg) => async_graphql::Error::new(format!("conflict: {msg}")),
    RepositoryError::NotFound(what) => async_graphql::Error::new(format!("{what} not found")),
    other => async_graphql::Error::new(other.to_string()),
  }
}

fn map_validation_err(err: FontValidationError) -> async_graphql::Error {
  match err {
    FontValidationError::Empty => async_graphql::Error::new("font binary is empty"),
    FontValidationError::UnknownFormat(msg) => async_graphql::Error::new(format!("unsupported font format: {msg}")),
    FontValidationError::UnsupportedWebFont(format) => async_graphql::Error::new(format!(
      "{format} fonts are not supported for PDF export; upload TTF or OTF"
    )),
    FontValidationError::InvalidSfnt(msg) => async_graphql::Error::new(format!("invalid SFNT data: {msg}")),
    FontValidationError::InvalidWeight(w) => {
      async_graphql::Error::new(format!("font weight {} is outside the legal range 1..=1000", w))
    }
    FontValidationError::MissingNameEntries(msg) => {
      async_graphql::Error::new(format!("font is missing required metadata: {msg}"))
    }
  }
}

pub struct PdfFontQueryRoot;

#[Object]
impl PdfFontQueryRoot {
  /// List fonts in the font library, optionally filtered by license status.
  /// Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn pdf_fonts(
    &self,
    ctx: &Context<'_>,
    status: Option<PdfFontLicenseStatusEnum>,
  ) -> Result<Vec<PdfFontType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    ensure_admin_user_id(ctx).await?;
    let repo = require_font_repo(state)?;
    let rows = repo.list(status.map(Into::into)).await.map_err(map_repo_err)?;
    Ok(rows.into_iter().map(Into::into).collect())
  }

  /// Fetch a single font by id. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn pdf_font(&self, ctx: &Context<'_>, id: ID) -> Result<Option<PdfFontType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    ensure_admin_user_id(ctx).await?;
    let uuid = Uuid::parse_str(id.as_str()).map_err(|_| "invalid UUID")?;
    let repo = require_font_repo(state)?;
    let row = repo.get(uuid).await.map_err(map_repo_err)?;
    Ok(row.map(Into::into))
  }
}

pub struct PdfFontMutationRoot;

#[Object]
impl PdfFontMutationRoot {
  /// Upload a new font to the library. The binary is validated (container,
  /// `name` table, `OS/2` weight) before any blob is written and the license
  /// is auto-detected from the `name` table when possible. Pass `license` to
  /// override the auto-detected value (or to set one when no detection was
  /// possible). Admin-only. New fonts start in `PENDING` status.
  #[instrument(skip_all)]
  pub async fn upload_pdf_font(&self, ctx: &Context<'_>, file: Upload, license: Option<String>) -> Result<PdfFontType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let user_id = ensure_admin_user_id(ctx).await?;
    let actor = resolve_audit_actor(ctx).await;

    let upload = file
      .value(ctx)
      .map_err(|e| async_graphql::Error::new(format!("invalid upload: {e}")))?;
    let mut data = Vec::new();
    use std::io::Read;
    let mut reader = upload.content;
    reader
      .read_to_end(&mut data)
      .map_err(|e| async_graphql::Error::new(format!("failed to read uploaded file: {e}")))?;
    if data.is_empty() {
      return Err(async_graphql::Error::new("font binary is empty"));
    }
    let max_font_bytes = state.config.pdf_export.max_font_bytes();
    if data.len() > max_font_bytes {
      return Err(async_graphql::Error::new(format!(
        "font binary exceeds {} byte limit",
        max_font_bytes
      )));
    }

    let metadata = validate_font_bytes(&data).map_err(map_validation_err)?;

    let resolved_license = match (license, metadata.detected_license.clone()) {
      (Some(explicit), _) => {
        let trimmed = explicit.trim();
        if trimmed.is_empty() {
          return Err(async_graphql::Error::new("license override must not be empty"));
        }
        license_from_string(trimmed)
      }
      (None, Some(detected)) => detected,
      (None, None) => {
        return Err(async_graphql::Error::new(
          "could not auto-detect a license — pass `license` explicitly with an SPDX-style identifier (e.g. \"OFL-1.1\", \"Apache-2.0\", \"MIT\", \"GPL\", \"Proprietary\")",
        ));
      }
    };

    let mut hasher = Sha256::new();
    hasher.update(&data);
    let sha256 = format!("{:x}", hasher.finalize());

    let blob_store = require_blob_store(state)?;
    let repo = require_font_repo(state)?;

    if let Some(existing) = repo.get_by_sha256(&sha256).await.map_err(map_repo_err)? {
      info!(
        font_id = %existing.id,
        sha256 = %existing.sha256,
        "font upload deduplicated against existing row"
      );
      return Err(async_graphql::Error::new(format!(
        "conflict: font with this content (sha256={}) already exists as id={}",
        existing.sha256, existing.id
      )));
    }

    let blob_key = blob_store
      .put_font(&sha256, metadata.container.extension(), &data)
      .await
      .map_err(map_repo_err)?;

    let row = PdfFont {
      id: Uuid::new_v4(),
      family_name: metadata.family_name.clone(),
      style: metadata.style.clone(),
      weight: i32::from(metadata.weight),
      blob_key: blob_key.clone(),
      sha256: sha256.clone(),
      license: resolved_license,
      license_status: PdfFontLicenseStatus::Pending,
      uploaded_by: Some(user_id),
      uploaded_at: Utc::now(),
      approved_by: None,
      approved_at: None,
    };

    if let Err(err) = repo
      .create(
        &row,
        Some(PdfFontUploadAudit {
          actor,
          license_description: metadata.license_description,
          license_url: metadata.license_url,
        }),
      )
      .await
    {
      // Best-effort cleanup: if the DB insert failed (e.g. UNIQUE conflict
      // on sha256 raced past our pre-check), drop the blob we just wrote.
      let _ = blob_store.delete(&blob_key).await;
      return Err(map_repo_err(err));
    }

    info!(
      font_id = %row.id,
      family_name = %row.family_name,
      style = %row.style,
      weight = row.weight,
      sha256 = %row.sha256,
      "font uploaded"
    );

    Ok(row.into())
  }

  /// Approve a font for use in PDF exports. Admin-only.
  #[instrument(skip_all)]
  pub async fn approve_pdf_font(&self, ctx: &Context<'_>, id: ID) -> Result<PdfFontType> {
    transition_status(ctx, id, PdfFontLicenseStatus::Approved, "pdf_font.approve", None).await
  }

  /// Reject a font (mark it as not usable for PDF exports). Admin-only.
  #[instrument(skip_all)]
  pub async fn reject_pdf_font(&self, ctx: &Context<'_>, id: ID, reason: String) -> Result<PdfFontType> {
    let reason = reason.trim().to_string();
    if reason.chars().count() < 8 {
      return Err(async_graphql::Error::new(
        "rejection reason must contain at least 8 characters",
      ));
    }
    transition_status(ctx, id, PdfFontLicenseStatus::Rejected, "pdf_font.reject", Some(reason)).await
  }

  /// Delete a font from the library. Returns `true` when the row existed
  /// and was removed, `false` when the id was unknown. Admin-only.
  #[instrument(skip_all)]
  pub async fn delete_pdf_font(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    ensure_admin_user_id(ctx).await?;
    let actor = resolve_audit_actor(ctx).await;
    let uuid = Uuid::parse_str(id.as_str()).map_err(|_| "invalid UUID")?;
    let repo = require_font_repo(state)?;
    let blob_store = require_blob_store(state)?;

    let removed = repo.delete(uuid, Some(actor)).await.map_err(map_repo_err)?;
    if let Some(font) = removed.as_ref() {
      // Cleanup follows the committed delete and uses the locked row's key.
      let _ = blob_store.delete(&font.blob_key).await;
      info!(font_id = %uuid, "font deleted");
    }
    Ok(removed.is_some())
  }
}

async fn transition_status(
  ctx: &Context<'_>,
  id: ID,
  new_status: PdfFontLicenseStatus,
  audit_action: &'static str,
  rejection_reason: Option<String>,
) -> Result<PdfFontType> {
  let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
  let approver = ensure_admin_user_id(ctx).await?;
  let actor = resolve_audit_actor(ctx).await;
  let uuid = Uuid::parse_str(id.as_str()).map_err(|_| "invalid UUID")?;
  let repo = require_font_repo(state)?;

  let after = repo
    .set_status(
      uuid,
      new_status,
      Some(approver),
      None,
      Some(PdfFontStatusAudit {
        actor,
        rejection_reason,
      }),
    )
    .await
    .map_err(map_repo_err)?;
  info!(font_id = %uuid, action=audit_action, "font license status changed");

  Ok(after.into())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn woff2_validation_error_maps_to_pdf_rejection_message() {
    let err = map_validation_err(FontValidationError::UnsupportedWebFont("WOFF2"));
    let message = err.message;

    assert!(
      message.contains("WOFF2") && message.contains("not supported for PDF export"),
      "unexpected error message: {message}"
    );
  }
}
