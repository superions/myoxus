// SPDX-License-Identifier: AGPL-3.0-or-later
//! Opendal-backed PDF blob store.
//!
//! [`PdfBlobStore`] provides typed upload/download helpers for the three
//! PDF-Export V2 storage namespaces:
//!
//! - `pdf-templates/<template_id>/<filename>` — initial template source files
//! - `pdf-templates/<template_id>/revisions/<sha256>/<filename>` — atomic replacements
//! - `pdf-brand/<workspace_id>/<operation_id>/<asset_kind>` — workspace brand assets (logo, etc.)
//! - `pdf-fonts/<sha256>.<ext>` — font binaries (deduped by content hash)
//!
//! SHA-256 is computed over the raw bytes **before** upload using the `sha2`
//! crate. The hex digest is returned alongside the blob key so callers can
//! persist the hash in the database.
//!
//! The `Operator` is injected at construction time. Use `opendal::services::Memory`
//! in tests and the existing `StorageAdapter` operator in production.

use sha2::{Digest, Sha256};
use tracing::{debug, error, instrument};
use uuid::Uuid;

use myoxus_domain::repositories::RepositoryError;

/// Typed blob store for PDF-Export V2 artifacts.
///
/// Wraps an [`opendal::Operator`] and enforces the path conventions documented
/// in `docs/dev/server/pdf-export-v2-architecture.md §1 — Blob-Store Pfad-Konventionen`.
#[derive(Clone)]
pub struct PdfBlobStore {
  op: opendal::Operator,
}

impl PdfBlobStore {
  /// Construct from any configured opendal operator.
  pub fn new(op: opendal::Operator) -> Self {
    Self { op }
  }

  fn map_opendal_err(key: &str, err: opendal::Error) -> RepositoryError {
    error!(key, error = %err, "opendal error in pdf blob store");
    if err.kind() == opendal::ErrorKind::NotFound {
      return RepositoryError::NotFound("pdf_blob");
    }
    RepositoryError::Storage(err.to_string())
  }

  fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
  }

  /// Upload a template source file and return `(blob_key, sha256_hex)`.
  ///
  /// Path: `pdf-templates/<template_id>/<path>`.
  #[instrument(skip(self, bytes), fields(template_id = %template_id, path), err)]
  pub async fn put_template_file(
    &self,
    template_id: Uuid,
    path: &str,
    bytes: &[u8],
  ) -> Result<(String, String), RepositoryError> {
    let sha = Self::sha256_hex(bytes);
    let blob_key = format!("pdf-templates/{}/{}", template_id, path);
    debug!(blob_key, size = bytes.len(), "uploading template file");
    self
      .op
      .write(&blob_key, bytes.to_vec())
      .await
      .map_err(|e| Self::map_opendal_err(&blob_key, e))?;
    Ok((blob_key, sha))
  }

  /// Upload a replacement template file under a content-addressed revision
  /// key and return `(blob_key, sha256_hex)`.
  ///
  /// Replacement bundles must not overwrite the blobs referenced by the
  /// currently active database rows before their DB transaction commits.
  #[instrument(skip(self, bytes), fields(template_id = %template_id, path), err)]
  pub async fn put_template_revision_file(
    &self,
    template_id: Uuid,
    path: &str,
    bytes: &[u8],
  ) -> Result<(String, String), RepositoryError> {
    let sha = Self::sha256_hex(bytes);
    let blob_key = format!("pdf-templates/{template_id}/revisions/{sha}/{path}");
    debug!(blob_key, size = bytes.len(), "uploading template revision file");
    self
      .op
      .write(&blob_key, bytes.to_vec())
      .await
      .map_err(|error| Self::map_opendal_err(&blob_key, error))?;
    Ok((blob_key, sha))
  }

  /// Download a blob by its opendal key.
  #[instrument(skip(self), err)]
  pub async fn get_template_file(&self, blob_key: &str) -> Result<Vec<u8>, RepositoryError> {
    debug!(blob_key, "downloading template file");
    let data = self
      .op
      .read(blob_key)
      .await
      .map_err(|e| Self::map_opendal_err(blob_key, e))?;
    Ok(data.to_vec())
  }

  /// Upload a workspace brand asset and return `(blob_key, sha256_hex)`.
  ///
  /// Each call owns a new immutable key, so failure cleanup cannot remove
  /// another writer's bytes. Committed predecessors remain available to exports.
  #[instrument(skip(self, bytes), fields(workspace_id = %workspace_id, asset_kind), err)]
  pub async fn put_brand_asset(
    &self,
    workspace_id: Uuid,
    asset_kind: &str,
    bytes: &[u8],
  ) -> Result<(String, String), RepositoryError> {
    let sha = Self::sha256_hex(bytes);
    let blob_key = format!("pdf-brand/{}/{}/{}", workspace_id, Uuid::new_v4(), asset_kind);
    debug!(blob_key, size = bytes.len(), "uploading brand asset");
    self
      .op
      .write(&blob_key, bytes.to_vec())
      .await
      .map_err(|e| Self::map_opendal_err(&blob_key, e))?;
    Ok((blob_key, sha))
  }

  /// Stage a font binary under a fresh operation-owned immutable key. Row SHA-256
  /// deduplication remains authoritative; a losing upload owns only this key.
  ///
  /// Path: `pdf-fonts/<operation_id>/<sha256>.<ext>`; legacy keys stay readable.
  ///
  /// Returns the `blob_key`. Callers should call `get_by_sha256` first to
  /// short-circuit if the font already exists in the database.
  #[instrument(skip(self, bytes), fields(sha256, ext), err)]
  pub async fn put_font(&self, sha256: &str, ext: &str, bytes: &[u8]) -> Result<String, RepositoryError> {
    let blob_key = format!("pdf-fonts/{}/{}.{}", uuid::Uuid::new_v4(), sha256, ext);
    debug!(blob_key, size = bytes.len(), "uploading font binary");
    self
      .op
      .write(&blob_key, bytes.to_vec())
      .await
      .map_err(|e| Self::map_opendal_err(&blob_key, e))?;
    Ok(blob_key)
  }

  /// Stage an ICC profile under a fresh operation-owned immutable key. A row
  /// conflict can remove this key without touching an existing profile.
  ///
  /// Path: `pdf-icc/<operation_id>/<sha256>.icc`; legacy keys stay readable.
  ///
  /// Returns the owned `blob_key`; database rows still deduplicate content.
  #[instrument(skip(self, bytes), fields(sha256), err)]
  pub async fn put_icc_profile(&self, sha256: &str, bytes: &[u8]) -> Result<String, RepositoryError> {
    let blob_key = format!("pdf-icc/{}/{}.icc", uuid::Uuid::new_v4(), sha256);
    debug!(blob_key, size = bytes.len(), "uploading icc profile");
    self
      .op
      .write(&blob_key, bytes.to_vec())
      .await
      .map_err(|e| Self::map_opendal_err(&blob_key, e))?;
    Ok(blob_key)
  }

  /// Delete a blob by its opendal key. Idempotent (missing key is not an error).
  #[instrument(skip(self), err)]
  pub async fn delete(&self, blob_key: &str) -> Result<(), RepositoryError> {
    debug!(blob_key, "deleting pdf blob");
    match self.op.delete(blob_key).await {
      Ok(()) => Ok(()),
      Err(e) if e.kind() == opendal::ErrorKind::NotFound => {
        debug!(blob_key, "blob already absent; treating delete as idempotent");
        Ok(())
      }
      Err(e) => Err(Self::map_opendal_err(blob_key, e)),
    }
  }
}
