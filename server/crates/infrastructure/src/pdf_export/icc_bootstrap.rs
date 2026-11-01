// SPDX-License-Identifier: AGPL-3.0-or-later
//! System-seed bootstrap for the bundled ICC profiles
//! (`P-PDF-TPL-COLOR-01-06`).
//!
//! Startup inserts missing canonical profile names with `uploaded_by = NULL`.
//! Existing rows keep their identity and key. New bytes use an operation-owned
//! immutable key, so a losing seed cleans up only its own staging. No key
//! migration or system-profile deletion guard is introduced here.
//! The sRGB binary is CC0 1.0; CMYK binaries are from Ghostscript under AGPL-3+.
//!
//! Failures are logged at `warn!` by the caller but never abort startup — the
//! system profiles are convenience seeds, not hard prerequisites for the API to
//! come up. Admins can always upload profiles manually if a bundled blob goes
//! missing.

use std::sync::Arc;

use sha2::{Digest, Sha256};
use tracing::{info, instrument, warn};

use myoxus_application::pdf_export::icc_validator::validate_icc_bytes;
use myoxus_domain::entities::PdfIccProfileType;
use myoxus_domain::repositories::PdfIccProfileRepository;

use crate::pdf_export::PdfBlobStore;

/// Canonical name of the system-seeded sRGB profile. Admin uploads cannot
/// reuse an existing row name because of the table-level UNIQUE(name) constraint.
pub const SYSTEM_SRGB_PROFILE_NAME: &str = "sRGB v4 (system)";
/// Bundled Ghostscript SWOP-like CMYK printer profile.
pub const SYSTEM_CMYK_SWOP_PROFILE_NAME: &str = "Artifex CMYK SWOP (system)";
/// Bundled Ghostscript generic PostScript CMYK printer profile.
pub const SYSTEM_POSTSCRIPT_CMYK_PROFILE_NAME: &str = "Artifex PostScript CMYK (system)";

/// Stable system profile names. Tests and docs use this to avoid silently
/// regressing the bootstrap back to a single sRGB-only seed.
pub const SYSTEM_ICC_PROFILE_NAMES: &[&str] = &[
  SYSTEM_SRGB_PROFILE_NAME,
  SYSTEM_CMYK_SWOP_PROFILE_NAME,
  SYSTEM_POSTSCRIPT_CMYK_PROFILE_NAME,
];

/// Embedded sRGB v4 ICC profile (480 bytes, CC0 1.0 — see
/// `server/static/icc/LICENSE` for the public-domain dedication).
const SRGB_V4_ICC_BYTES: &[u8] = include_bytes!("../../../../static/icc/sRGB-v4.icc");
/// Embedded Artifex CMYK SWOP profile (AGPL-3+ — see
/// `docs/dev/server/icc-profile-provenance.md` for provenance).
const ARTIFEX_CMYK_SWOP_ICC_BYTES: &[u8] = include_bytes!("../../../../static/icc/Artifex-CMYK-SWOP.icc");
/// Embedded Artifex generic PostScript CMYK profile (AGPL-3+ — see
/// `docs/dev/server/icc-profile-provenance.md` for provenance).
const ARTIFEX_POSTSCRIPT_CMYK_ICC_BYTES: &[u8] = include_bytes!("../../../../static/icc/Artifex-PostScript-CMYK.icc");

struct SystemIccProfile {
  name: &'static str,
  profile_type: PdfIccProfileType,
  bytes: &'static [u8],
}

fn system_profiles() -> [SystemIccProfile; 3] {
  [
    SystemIccProfile {
      name: SYSTEM_SRGB_PROFILE_NAME,
      profile_type: PdfIccProfileType::Srgb,
      bytes: SRGB_V4_ICC_BYTES,
    },
    SystemIccProfile {
      name: SYSTEM_CMYK_SWOP_PROFILE_NAME,
      profile_type: PdfIccProfileType::Cmyk,
      bytes: ARTIFEX_CMYK_SWOP_ICC_BYTES,
    },
    SystemIccProfile {
      name: SYSTEM_POSTSCRIPT_CMYK_PROFILE_NAME,
      profile_type: PdfIccProfileType::Cmyk,
      bytes: ARTIFEX_POSTSCRIPT_CMYK_ICC_BYTES,
    },
  ]
}

/// Idempotently seed all bundled ICC profiles.
///
/// Returns the number of newly inserted rows. Storage and DB errors are
/// returned as-is so callers can decide whether to log or surface them; the
/// bin/server.rs caller logs and swallows them.
#[instrument(skip(repo, blob_store), err)]
pub async fn seed_system_icc_profiles(
  repo: Arc<dyn PdfIccProfileRepository>,
  blob_store: Arc<PdfBlobStore>,
) -> Result<usize, myoxus_domain::repositories::RepositoryError> {
  let mut inserted = 0usize;

  for profile in system_profiles() {
    if let Some(existing) = repo.get_by_name(profile.name).await? {
      info!(
        icc_id = %existing.id,
        name = %existing.name,
        profile_type = %existing.profile_type,
        sha256 = %existing.sha256,
        "system ICC profile already seeded"
      );
      continue;
    }

    let detected = validate_icc_bytes(profile.bytes).map_err(|err| {
      myoxus_domain::repositories::RepositoryError::Storage(format!(
        "bundled system ICC profile `{}` failed validation: {err}",
        profile.name
      ))
    })?;
    if detected.claimed_type != profile.profile_type {
      return Err(myoxus_domain::repositories::RepositoryError::Storage(format!(
        "bundled system ICC profile `{}` is {:?}, expected {:?}",
        profile.name, detected.claimed_type, profile.profile_type
      )));
    }

    let mut hasher = Sha256::new();
    hasher.update(profile.bytes);
    let sha256 = format!("{:x}", hasher.finalize());
    let blob_key = blob_store.put_icc_profile(&sha256, profile.bytes).await?;

    match repo
      .create(
        profile.name,
        profile.profile_type.clone(),
        &blob_key,
        &sha256,
        None,
        None,
      )
      .await
    {
      Ok(row) => {
        info!(
          icc_id = %row.id,
          name = %row.name,
          profile_type = %row.profile_type,
          sha256 = %row.sha256,
          size = profile.bytes.len(),
          "system ICC profile seeded"
        );
        inserted += 1;
      }
      Err(err) => {
        // This staging key is unique to this seed attempt, even on a hash/name race.
        if let Err(cleanup) = blob_store.delete(&blob_key).await {
          warn!(error=%cleanup,"failed to remove owned ICC seed staging");
        }
        if repo.get_by_name(profile.name).await?.is_some() {
          warn!(
            error = %err,
            name = profile.name,
            "system ICC profile insert raced with another seeder; continuing"
          );
          continue;
        }
        return Err(err);
      }
    }
  }

  Ok(inserted)
}
