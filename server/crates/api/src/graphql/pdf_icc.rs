// SPDX-License-Identifier: AGPL-3.0-or-later
//! GraphQL surface for PDF ICC color profile management
//! (`P-PDF-TPL-COLOR-01-{02,03,04}`).
//!
//! Admin-only. Lists, uploads, and deletes ICC profiles backed by
//! [`myoxus_domain::repositories::PdfIccProfileRepository`] and the shared
//! [`myoxus_infrastructure::pdf_export::PdfBlobStore`]. Upload validates the
//! ICC header via [`myoxus_application::pdf_export::icc_validator`] and
//! refuses everything that is not an RGB or CMYK profile of class
//! Display/Input/Output. Both upload and delete emit
//! `pdf_export_config` events in the owning row transaction.

use std::sync::Arc;

use async_graphql::{Context, ID, Object, Result, SimpleObject, Upload};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use tracing::{info, instrument, warn};
use uuid::Uuid;

use myoxus_application::auth::AuthError;
use myoxus_application::pdf_export::icc_validator::{IccValidationError, validate_icc_bytes};

use myoxus_domain::entities::{PdfIccProfile, PdfIccProfileType};
use myoxus_domain::repositories::RepositoryError;

use crate::graphql::admin::resolve_audit_actor;
use crate::graphql::utils::{map_gql_error, require_session};
use crate::state::ApiState;

/// Maximum accepted ICC profile size. ICC v4 profiles in the wild rarely
/// exceed 4 MB; 8 MB leaves comfortable headroom while keeping memory
/// pressure bounded.
const MAX_ICC_PROFILE_BYTES: usize = 8 * 1024 * 1024;

#[derive(async_graphql::Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum PdfIccProfileTypeEnum {
  #[graphql(name = "sRGB")]
  Srgb,
  #[graphql(name = "CMYK")]
  Cmyk,
}

impl From<PdfIccProfileType> for PdfIccProfileTypeEnum {
  fn from(value: PdfIccProfileType) -> Self {
    match value {
      PdfIccProfileType::Srgb => Self::Srgb,
      PdfIccProfileType::Cmyk => Self::Cmyk,
    }
  }
}

impl From<PdfIccProfileTypeEnum> for PdfIccProfileType {
  fn from(value: PdfIccProfileTypeEnum) -> Self {
    match value {
      PdfIccProfileTypeEnum::Srgb => Self::Srgb,
      PdfIccProfileTypeEnum::Cmyk => Self::Cmyk,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct PdfIccProfileType_ {
  pub id: ID,
  pub name: String,
  pub profile_type: PdfIccProfileTypeEnum,
  pub sha256: String,
  /// `None` for system-seeded profiles (e.g. bundled sRGB/CMYK defaults).
  pub uploaded_by: Option<ID>,
  pub uploaded_at: DateTime<Utc>,
}

impl From<PdfIccProfile> for PdfIccProfileType_ {
  fn from(p: PdfIccProfile) -> Self {
    Self {
      id: ID(p.id.to_string()),
      name: p.name,
      profile_type: p.profile_type.into(),
      sha256: p.sha256,
      uploaded_by: p.uploaded_by.map(|id| ID(id.to_string())),
      uploaded_at: p.uploaded_at,
    }
  }
}

/// Verify that the current session belongs to an admin and return their user ID.
async fn ensure_admin_user_id(ctx: &Context<'_>) -> Result<Uuid> {
  let (_, snapshot) = require_session(ctx).await?;
  if !snapshot.user.is_admin {
    warn!(user_id = %snapshot.user.id, "unauthorized admin access attempt on pdfIcc surface");
    return Err(map_gql_error(AuthError::ActionForbidden));
  }
  Ok(snapshot.user.id)
}

fn require_icc_repo(state: &ApiState) -> Result<Arc<dyn myoxus_domain::repositories::PdfIccProfileRepository>> {
  state
    .pdf_icc_repo()
    .ok_or_else(|| async_graphql::Error::new("pdf icc profile repository is not configured on this server"))
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

pub struct PdfIccQueryRoot;

#[Object]
impl PdfIccQueryRoot {
  /// List all ICC profiles, ordered by name. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn pdf_icc_profiles(&self, ctx: &Context<'_>) -> Result<Vec<PdfIccProfileType_>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    ensure_admin_user_id(ctx).await?;
    let repo = require_icc_repo(state)?;
    let rows = repo.list().await.map_err(map_repo_err)?;
    Ok(rows.into_iter().map(Into::into).collect())
  }

  /// Fetch a single ICC profile by id. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn pdf_icc_profile(&self, ctx: &Context<'_>, id: ID) -> Result<Option<PdfIccProfileType_>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    ensure_admin_user_id(ctx).await?;
    let uuid = Uuid::parse_str(id.as_str()).map_err(|_| "invalid UUID")?;
    let repo = require_icc_repo(state)?;
    let row = repo.get(uuid).await.map_err(map_repo_err)?;
    Ok(row.map(Into::into))
  }
}

pub struct PdfIccMutationRoot;

#[Object]
impl PdfIccMutationRoot {
  /// Upload a new ICC profile. The file is validated against the ICC header
  /// (`moxcms`) before any blob is written. Admin-only.
  #[instrument(skip_all)]
  pub async fn upload_icc_profile(
    &self,
    ctx: &Context<'_>,
    name: String,
    profile_type: PdfIccProfileTypeEnum,
    file: Upload,
  ) -> Result<PdfIccProfileType_> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let user_id = ensure_admin_user_id(ctx).await?;
    let actor = resolve_audit_actor(ctx).await;
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
      return Err(async_graphql::Error::new("profile name must not be empty"));
    }

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
      return Err(async_graphql::Error::new("ICC profile is empty"));
    }
    if data.len() > MAX_ICC_PROFILE_BYTES {
      return Err(async_graphql::Error::new(format!(
        "ICC profile exceeds {} byte limit",
        MAX_ICC_PROFILE_BYTES
      )));
    }

    let detected = validate_icc_bytes(&data).map_err(|e| match e {
      IccValidationError::Empty => async_graphql::Error::new("ICC profile is empty"),
      IccValidationError::InvalidHeader(msg) => async_graphql::Error::new(format!("invalid ICC header: {msg}")),
      IccValidationError::UnsupportedColorSpace(msg) => {
        async_graphql::Error::new(format!("unsupported ICC color space: {msg}"))
      }
    })?;

    let claimed: PdfIccProfileType = profile_type.into();
    if detected.claimed_type != claimed {
      return Err(async_graphql::Error::new(format!(
        "uploaded profile is {:?} but caller claimed {:?}",
        detected.claimed_type, claimed
      )));
    }

    let mut hasher = Sha256::new();
    hasher.update(&data);
    let sha256 = format!("{:x}", hasher.finalize());

    let blob_store = require_blob_store(state)?;
    let repo = require_icc_repo(state)?;

    let blob_key = blob_store.put_icc_profile(&sha256, &data).await.map_err(map_repo_err)?;

    let row = match repo
      .create(&trimmed, claimed, &blob_key, &sha256, Some(user_id), Some(actor))
      .await
    {
      Ok(row) => row,
      Err(err) => {
        // Best-effort cleanup: if the DB insert failed (e.g. UNIQUE conflict
        // on name), drop the blob we just wrote so we don't leak storage.
        let _ = blob_store.delete(&blob_key).await;
        return Err(map_repo_err(err));
      }
    };

    info!(
      icc_id = %row.id,
      profile_type = ?row.profile_type,
      sha256 = %row.sha256,
      "icc profile uploaded"
    );

    Ok(row.into())
  }

  /// Delete an ICC profile by id. Returns `true` when the row existed and
  /// was removed, `false` when the id was unknown. Admin-only.
  #[instrument(skip_all)]
  pub async fn delete_icc_profile(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    ensure_admin_user_id(ctx).await?;
    let actor = resolve_audit_actor(ctx).await;
    let uuid = Uuid::parse_str(id.as_str()).map_err(|_| "invalid UUID")?;
    let repo = require_icc_repo(state)?;
    let blob_store = require_blob_store(state)?;

    let removed = repo.delete(uuid, Some(actor)).await.map_err(map_repo_err)?;
    if let Some(profile) = removed.as_ref() {
      // Existing default references were cleared with the audited row delete.
      let _ = blob_store.delete(&profile.blob_key).await;
      info!(icc_id = %uuid, "icc profile deleted");
    }
    Ok(removed.is_some())
  }
}
