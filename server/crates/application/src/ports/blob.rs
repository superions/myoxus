//! Blob-domain port types and the [`BlobStore`] trait.
//!
//! This module defines the DTOs and the higher-level `BlobStore` abstraction
//! used by blob application services.  The `BlobStore` operates on domain
//! entities (metadata records, multipart state, comment attachments) while the
//! lower-level [`super::BlobStoragePort`] handles raw byte I/O with the object
//! store.

use crate::auth::AuthResult;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tracing::instrument;
use uuid::Uuid;

/// Lifecycle state of a blob upload.
///
/// New blobs start as `Pending` and progress to `Completed` once the bytes
/// land in the object store.  Failed uploads are recorded with `Failed` so
/// that garbage collection can reclaim any partial data.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BlobStatus {
  /// The metadata record has been created but no bytes have been uploaded yet.
  Pending,
  /// A multipart upload is in progress.
  Uploading,
  /// All bytes have been written and the blob is readable.
  Completed,
  /// The upload was aborted or encountered a non-retryable error.
  Failed,
}

/// Metadata record for a stored binary blob.
///
/// This mirrors the `blobs` database row and is the primary DTO returned by
/// `BlobStore` methods.
#[derive(Debug, Clone)]
pub struct BlobMetadata {
  /// Primary key of the blob record.
  pub blob_id: Uuid,
  /// Workspace that owns this blob.
  pub workspace_id: Uuid,
  /// Object-store key (path) of the blob.
  pub key: String,
  /// Size in bytes.
  pub size: u64,
  /// MIME type.
  pub mime: String,
  /// Optional SHA-256 or other checksum hex string for integrity verification.
  pub checksum: Option<String>,
  /// Current upload lifecycle state.
  pub status: BlobStatus,
  /// Provider-issued multipart upload ID, present while status is `Uploading`.
  pub upload_id: Option<String>,
  /// When the blob metadata record was first created.
  pub created_at: chrono::DateTime<chrono::Utc>,
  /// When the blob metadata was last updated.
  pub updated_at: chrono::DateTime<chrono::Utc>,
  /// Soft-delete timestamp; `None` while the blob is live.
  pub deleted_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Storage projection required to download one authorized comment attachment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentAttachmentDownload {
  pub storage_key: String,
  pub mime_type: String,
  pub size_bytes: u64,
}

/// A single part that has been uploaded as part of a multipart blob upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultipartUploadedPart {
  /// One-based part index.
  pub part_number: i32,
  /// ETag string returned by the object store for this part (used to complete
  /// the upload).
  pub etag: String,
}

/// A soft-deleted blob that is eligible for object-store garbage collection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobGcCandidate {
  /// Workspace that owns the blob.
  pub workspace_id: Uuid,
  /// Object-store key to delete.
  pub key: String,
  /// When the blob was soft-deleted (used to enforce a grace period).
  pub deleted_at: DateTime<Utc>,
}

/// A validated, canonicalised blob object-store key.
///
/// Construction via [`BlobKey::parse`] enforces the path restrictions that
/// prevent path-traversal and other injection attacks against the object store.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BlobKey(String);

impl BlobKey {
  /// Parse and validate a raw key string.
  ///
  /// Returns `Err` if the key is empty, contains `..` segments, starts or
  /// ends with `/`, uses `\` as a separator, or contains any empty path
  /// segment.
  #[instrument]
  pub fn parse(raw: &str) -> Result<Self, String> {
    let key = raw.trim();
    if key.is_empty() {
      return Err("blob key must not be empty".to_string());
    }
    if key.contains('\\') || key.starts_with('/') || key.ends_with('/') || key.contains("..") {
      return Err("blob key contains invalid path segments".to_string());
    }
    if key.split('/').any(|segment| segment.is_empty() || segment == ".") {
      return Err("blob key contains invalid separators".to_string());
    }
    Ok(Self(key.to_string()))
  }

  /// Return the validated key string as a `&str`.
  pub fn as_str(&self) -> &str {
    &self.0
  }

  /// Physical object key used by normal workspace blob reads and writes.
  /// Metadata and document references keep the workspace-relative key.
  pub fn storage_key(&self, workspace_id: Uuid) -> String {
    format!("{workspace_id}/{}", self.0)
  }
}

/// Domain-level blob persistence and business-logic port.
///
/// Unlike [`super::BlobStoragePort`] (which deals with raw bytes), this trait
/// manages metadata rows, multipart upload bookkeeping, comment attachment
/// linking, and garbage-collection helpers.
#[async_trait]
pub trait BlobStore: Send + Sync {
  /// Insert a new blob metadata record with status [`BlobStatus::Pending`].
  async fn create_blob_metadata(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    size: u64,
    mime: &str,
    checksum: Option<&str>,
  ) -> AuthResult<BlobMetadata>;
  /// Register metadata for bytes already committed by a trusted server-side
  /// producer. The row is immediately readable and therefore starts in the
  /// completed state.
  async fn register_completed_blob_metadata(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    size: u64,
    mime: &str,
  ) -> AuthResult<()>;
  /// Retrieve the metadata for a workspace blob by key, or `None` if not
  /// found.
  async fn get_blob_metadata(&self, workspace_id: Uuid, key: &BlobKey) -> AuthResult<Option<BlobMetadata>>;
  /// Update the upload lifecycle status of a blob.
  async fn update_blob_status(&self, workspace_id: Uuid, key: &BlobKey, status: BlobStatus) -> AuthResult<()>;
  /// Persist the provider-issued multipart upload ID for tracking purposes.
  async fn set_upload_id(&self, workspace_id: Uuid, key: &BlobKey, upload_id: &str) -> AuthResult<()>;
  /// Hard-delete the metadata record for a blob (used on upload abort).
  async fn delete_blob_metadata(&self, workspace_id: Uuid, key: &BlobKey) -> AuthResult<()>;
  /// Record that a part has been uploaded (upsert by part number).
  async fn upsert_multipart_part(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    upload_id: &str,
    part_number: i32,
    etag: &str,
  ) -> AuthResult<()>;
  /// Return all uploaded parts for a multipart session, ordered by part
  /// number.
  async fn list_multipart_parts(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    upload_id: &str,
  ) -> AuthResult<Vec<MultipartUploadedPart>>;
  /// Remove all part tracking records for a multipart session (called after
  /// completion or abort).
  async fn clear_multipart_parts(&self, workspace_id: Uuid, key: &BlobKey, upload_id: &str) -> AuthResult<()>;
  /// Create a `comment_attachments` row linking a blob key to a workspace /
  /// document.  Called before a comment is posted so the attachment can be
  /// validated.
  async fn bind_comment_attachment(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    key: &BlobKey,
    mime: &str,
    size: u64,
    created_by: Uuid,
  ) -> AuthResult<()>;
  /// Associate a previously bound comment attachment with a specific comment
  /// ID.  Returns `true` if the attachment was updated, `false` if not found.
  async fn attach_comment_attachment_to_comment(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    comment_id: Uuid,
    key: &BlobKey,
    user_id: Uuid,
  ) -> AuthResult<bool>;
  /// Resolve attachment storage metadata within its workspace/document scope.
  async fn get_comment_attachment_download(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    key: &BlobKey,
  ) -> AuthResult<Option<CommentAttachmentDownload>>;
  /// Soft-delete a blob by setting `deleted_at`.  Returns `true` if the blob
  /// was found and marked deleted.
  async fn soft_delete_blob_metadata(&self, workspace_id: Uuid, key: &BlobKey, when: DateTime<Utc>)
  -> AuthResult<bool>;
  /// Remove the metadata record entirely from the database (called by GC after
  /// the object-store object has been removed).  Returns `true` if a row was
  /// deleted.
  async fn hard_delete_blob_metadata(&self, workspace_id: Uuid, key: &BlobKey) -> AuthResult<bool>;
  /// Return blobs whose `deleted_at` is older than `deleted_before`, up to
  /// `limit` results.  Used by the GC worker to find objects to purge.
  async fn list_retention_gc_candidates(
    &self,
    deleted_before: DateTime<Utc>,
    limit: i64,
  ) -> AuthResult<Vec<BlobGcCandidate>>;
  /// List blobs for a workspace.  Pass `include_deleted = true` to include
  /// soft-deleted entries.
  async fn list_workspace_blobs(
    &self,
    workspace_id: Uuid,
    limit: i64,
    offset: i64,
    include_deleted: bool,
  ) -> AuthResult<Vec<BlobMetadata>>;
  /// Return every object-store key that must be removed with a workspace.
  /// This administrative projection is intentionally not paginated.
  async fn list_workspace_blob_keys_for_deletion(&self, workspace_id: Uuid) -> AuthResult<Vec<String>>;
  /// Return the total byte count of all blobs in a workspace.  Pass
  /// `include_deleted = true` to include soft-deleted blobs in the sum.
  async fn sum_workspace_blob_size(&self, workspace_id: Uuid, include_deleted: bool) -> AuthResult<u64>;
  /// Return active blob bytes across all active workspaces linked to a user.
  async fn sum_user_workspace_blob_size(&self, _user_id: Uuid) -> AuthResult<u64> {
    Ok(0)
  }
  /// Remove both the object-store object and the metadata row for a blob.
  /// Returns `true` if anything was removed.
  async fn hard_delete_blob(&self, workspace_id: Uuid, key: &BlobKey) -> AuthResult<bool>;
  /// Soft-delete all blobs in a workspace whose `deleted_at` is before
  /// `deleted_before`, then return them as [`BlobGcCandidate`] entries so the
  /// caller can remove the corresponding object-store objects.
  async fn release_deleted_blobs_in_workspace(
    &self,
    workspace_id: Uuid,
    deleted_before: DateTime<Utc>,
    limit: i64,
  ) -> AuthResult<Vec<BlobGcCandidate>>;
}

// ─── Null Store (for ApiState::new() and tests that don't exercise blobs) ────

/// No-op [`BlobStore`] that returns empty results for reads and succeeds
/// silently for writes.  Used as the default in `ApiState::new()` so that
/// no real database connection is required.
pub struct NullBlobStore;

#[async_trait]
impl BlobStore for NullBlobStore {
  async fn create_blob_metadata(
    &self,
    _workspace_id: Uuid,
    _key: &BlobKey,
    _size: u64,
    _mime: &str,
    _checksum: Option<&str>,
  ) -> AuthResult<BlobMetadata> {
    Err(crate::auth::AuthError::Storage("NullBlobStore: not connected".into()))
  }
  async fn register_completed_blob_metadata(
    &self,
    _workspace_id: Uuid,
    _key: &BlobKey,
    _size: u64,
    _mime: &str,
  ) -> AuthResult<()> {
    Ok(())
  }
  async fn get_blob_metadata(&self, _workspace_id: Uuid, _key: &BlobKey) -> AuthResult<Option<BlobMetadata>> {
    Ok(None)
  }
  async fn update_blob_status(&self, _workspace_id: Uuid, _key: &BlobKey, _status: BlobStatus) -> AuthResult<()> {
    Ok(())
  }
  async fn set_upload_id(&self, _workspace_id: Uuid, _key: &BlobKey, _upload_id: &str) -> AuthResult<()> {
    Ok(())
  }
  async fn delete_blob_metadata(&self, _workspace_id: Uuid, _key: &BlobKey) -> AuthResult<()> {
    Ok(())
  }
  async fn upsert_multipart_part(
    &self,
    _workspace_id: Uuid,
    _key: &BlobKey,
    _upload_id: &str,
    _part_number: i32,
    _etag: &str,
  ) -> AuthResult<()> {
    Ok(())
  }
  async fn list_multipart_parts(
    &self,
    _workspace_id: Uuid,
    _key: &BlobKey,
    _upload_id: &str,
  ) -> AuthResult<Vec<MultipartUploadedPart>> {
    Ok(vec![])
  }
  async fn clear_multipart_parts(&self, _workspace_id: Uuid, _key: &BlobKey, _upload_id: &str) -> AuthResult<()> {
    Ok(())
  }
  async fn bind_comment_attachment(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _key: &BlobKey,
    _mime: &str,
    _size: u64,
    _created_by: Uuid,
  ) -> AuthResult<()> {
    Ok(())
  }
  async fn attach_comment_attachment_to_comment(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _comment_id: Uuid,
    _key: &BlobKey,
    _user_id: Uuid,
  ) -> AuthResult<bool> {
    Ok(false)
  }
  async fn get_comment_attachment_download(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _key: &BlobKey,
  ) -> AuthResult<Option<CommentAttachmentDownload>> {
    Ok(None)
  }
  async fn soft_delete_blob_metadata(
    &self,
    _workspace_id: Uuid,
    _key: &BlobKey,
    _when: DateTime<Utc>,
  ) -> AuthResult<bool> {
    Ok(false)
  }
  async fn hard_delete_blob_metadata(&self, _workspace_id: Uuid, _key: &BlobKey) -> AuthResult<bool> {
    Ok(false)
  }
  async fn list_retention_gc_candidates(
    &self,
    _deleted_before: DateTime<Utc>,
    _limit: i64,
  ) -> AuthResult<Vec<BlobGcCandidate>> {
    Ok(vec![])
  }
  async fn list_workspace_blobs(
    &self,
    _workspace_id: Uuid,
    _limit: i64,
    _offset: i64,
    _include_deleted: bool,
  ) -> AuthResult<Vec<BlobMetadata>> {
    Ok(vec![])
  }
  async fn list_workspace_blob_keys_for_deletion(&self, _workspace_id: Uuid) -> AuthResult<Vec<String>> {
    Ok(vec![])
  }
  async fn sum_workspace_blob_size(&self, _workspace_id: Uuid, _include_deleted: bool) -> AuthResult<u64> {
    Ok(0)
  }
  async fn hard_delete_blob(&self, _workspace_id: Uuid, _key: &BlobKey) -> AuthResult<bool> {
    Ok(false)
  }
  async fn release_deleted_blobs_in_workspace(
    &self,
    _workspace_id: Uuid,
    _deleted_before: DateTime<Utc>,
    _limit: i64,
  ) -> AuthResult<Vec<BlobGcCandidate>> {
    Ok(vec![])
  }
}

#[cfg(test)]
mod tests {
  use super::BlobKey;

  #[test]
  fn blob_key_parser_accepts_canonical_keys() {
    assert!(BlobKey::parse("hello.txt").is_ok());
    assert!(BlobKey::parse("workspace/a/b/c.bin").is_ok());
  }

  #[test]
  fn blob_key_parser_rejects_path_tricks_and_empty_values() {
    assert!(BlobKey::parse("").is_err());
    assert!(BlobKey::parse("   ").is_err());
    assert!(BlobKey::parse("../secret").is_err());
    assert!(BlobKey::parse("/abs/path").is_err());
    assert!(BlobKey::parse("a//b").is_err());
    assert!(BlobKey::parse("a/./b").is_err());
    assert!(BlobKey::parse("a\\b").is_err());
  }
}
