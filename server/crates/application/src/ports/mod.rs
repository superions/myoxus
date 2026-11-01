//! Application-layer port traits — the "driven" side of the hexagonal
//! architecture.
//!
//! Each trait in this module abstracts over a piece of external infrastructure
//! that the application services depend on.  Concrete implementations live in
//! `myoxus-infrastructure` and are injected at startup via `AppState`.
//!
//! Sub-modules:
//! - [`blob`] — higher-level blob service helpers
//! - [`blob_service`] — blob service port (re-exported)
//! - [`database_change`] — Database change-event notification port
//!   (P-DB-29B-C).

use async_trait::async_trait;
pub mod blob;
pub mod blob_service;
pub mod database_change;
pub mod mail;
use bytes::Bytes;
use chrono::{DateTime, Utc};
pub use mail::{MailPresentation, MailTemplate, TemplateMail};
use std::path::PathBuf;
use thiserror::Error;
use uuid::Uuid;

/// Errors returned by port adapters.
///
/// These are intentionally independent of any particular infrastructure SDK so
/// application services can react to failure categories without binding to
/// adapter-specific error types.
#[derive(Debug, Error)]
pub enum PortError {
  /// The caller supplied data that the port cannot process.
  #[error("invalid input: {0}")]
  InvalidInput(String),
  /// The requested resource could not be found in the external system.
  #[error("not found: {0}")]
  NotFound(String),
  /// The operation conflicts with existing state in the external system.
  #[error("conflict: {0}")]
  Conflict(String),
  /// A network or I/O error prevented the operation from completing.
  #[error("transport failure: {0}")]
  Transport(String),
}

/// Convenience alias used by every port method.
pub type PortResult<T> = Result<T, PortError>;

// ─── Blob storage DTOs ────────────────────────────────────────────────────────

/// Parameters for writing a blob to the object store.
#[derive(Debug, Clone)]
pub struct BlobWriteRequest {
  /// Object-store key (path) to write to.
  pub key: String,
  /// MIME type of the payload (forwarded as `Content-Type` in S3/opendal).
  pub content_type: Option<String>,
  /// Raw byte payload.
  pub body: Bytes,
}

/// Parameters for streaming a protected local file into object storage.
#[derive(Debug, Clone)]
pub struct BlobPathWriteRequest {
  pub key: String,
  pub content_type: Option<String>,
  pub path: PathBuf,
  pub expected_size: u64,
}

/// Response from a successful blob read.
#[derive(Debug, Clone)]
pub struct BlobReadResponse {
  /// Object-store key that was read.
  pub key: String,
  /// MIME type as stored.
  pub content_type: Option<String>,
  /// Full file contents.
  pub data: Bytes,
  /// Last-modified timestamp reported by the object store.
  pub last_modified: Option<DateTime<Utc>>,
  /// Content length in bytes.
  pub content_length: u64,
}

/// Parameters for initiating a multipart upload session.
#[derive(Debug, Clone)]
pub struct MultipartCreateRequest {
  /// Object-store key that will receive the assembled object.
  pub key: String,
  /// MIME type of the final assembled object.
  pub content_type: Option<String>,
}

/// Response from a successful multipart upload creation.
#[derive(Debug, Clone)]
pub struct MultipartCreateResponse {
  /// Myoxus-internal upload session identifier.
  pub upload_id: Uuid,
  /// Opaque upload identifier returned by the underlying object store (e.g.
  /// the S3 `UploadId` string).
  pub provider_upload_id: String,
}

/// Parameters for generating a pre-signed URL for a single multipart part.
#[derive(Debug, Clone)]
pub struct MultipartPartUrlRequest {
  /// The upload session identifier.
  pub upload_id: Uuid,
  /// One-based part number (S3 range: 1–10000).
  pub part_number: i32,
}

/// Response containing the pre-signed URL the client must `PUT` to.
#[derive(Debug, Clone)]
pub struct MultipartPartUrlResponse {
  /// The upload session identifier (echoed back for correlation).
  pub upload_id: Uuid,
  /// The part number this URL covers.
  pub part_number: i32,
  /// Pre-signed URL the client should use to upload the part bytes.
  pub upload_url: String,
}

/// Parameters for finalising a multipart upload.
#[derive(Debug, Clone)]
pub struct MultipartCompleteRequest {
  /// The upload session identifier.
  pub upload_id: Uuid,
  /// Ordered list of ETag strings returned by the object store for each part.
  pub e_tags: Vec<String>,
}

// ─── Ports ────────────────────────────────────────────────────────────────────

/// Object-storage port for reading, writing, and deleting blobs.
///
/// Implementations back this with opendal (local FS, S3, GCS, etc.) without
/// exposing the opendal API to the application layer.
#[async_trait]
pub trait BlobStoragePort: Send + Sync {
  /// Write `req.body` at `req.key`.  Overwrites any existing object.
  async fn write_blob(&self, req: BlobWriteRequest) -> PortResult<()>;
  /// Stream a protected server-local file to storage without one full-payload
  /// allocation. Production storage adapters must implement this for imports.
  async fn write_blob_from_path(&self, req: BlobPathWriteRequest) -> PortResult<()> {
    let _ = req;
    Err(PortError::InvalidInput(
      "path-backed blob writes are not supported by this adapter".to_string(),
    ))
  }
  /// Read the full contents of the object at `key`.
  async fn read_blob(&self, key: &str) -> PortResult<BlobReadResponse>;
  /// Read at most `max_bytes`, including when stored metadata understates size.
  /// Adapters must bound the storage read itself, rather than truncate afterward.
  async fn read_blob_bounded(&self, _key: &str, _max_bytes: u64) -> PortResult<BlobReadResponse> {
    Err(PortError::InvalidInput(
      "bounded blob reads are not supported by this adapter".into(),
    ))
  }
  /// Delete the object at `key`.  Silently succeeds if the object does not
  /// exist.
  async fn delete_blob(&self, key: &str) -> PortResult<()>;

  /// Store a user avatar image and return its public URL.
  async fn put_avatar(&self, key: &str, data: Bytes, content_type: &str) -> PortResult<String>;
  /// Read a stored avatar by key.
  async fn get_avatar(&self, key: &str) -> PortResult<BlobReadResponse>;
  /// Delete a stored avatar.
  async fn delete_avatar(&self, key: &str) -> PortResult<()>;

  /// Initiate a multipart upload and return session metadata.
  async fn create_multipart_upload(&self, req: MultipartCreateRequest) -> PortResult<MultipartCreateResponse>;
  /// Generate a short-lived pre-signed URL for the client to upload a single
  /// part directly to the object store.
  async fn create_multipart_part_url(&self, req: MultipartPartUrlRequest) -> PortResult<MultipartPartUrlResponse>;
  /// Assemble all uploaded parts and complete the multipart upload.
  async fn complete_multipart_upload(&self, req: MultipartCompleteRequest) -> PortResult<()>;
  /// Discard an in-progress multipart upload and free any already-uploaded
  /// parts from the object store.
  async fn abort_multipart_upload(&self, upload_id: Uuid) -> PortResult<()>;
}

/// No-op [`BlobStoragePort`] that succeeds silently for writes/deletes and
/// returns `NotFound` for reads.  Used as the default in `ApiState::new()` so
/// that no real filesystem or object-store connection is required.
pub struct NullBlobStorage;

#[async_trait]
impl BlobStoragePort for NullBlobStorage {
  async fn write_blob(&self, _req: BlobWriteRequest) -> PortResult<()> {
    Ok(())
  }
  async fn read_blob(&self, key: &str) -> PortResult<BlobReadResponse> {
    Err(PortError::NotFound(key.to_string()))
  }
  async fn delete_blob(&self, _key: &str) -> PortResult<()> {
    Ok(())
  }
  async fn put_avatar(&self, key: &str, _data: Bytes, _content_type: &str) -> PortResult<String> {
    Ok(key.to_string())
  }
  async fn get_avatar(&self, key: &str) -> PortResult<BlobReadResponse> {
    Err(PortError::NotFound(key.to_string()))
  }
  async fn delete_avatar(&self, _key: &str) -> PortResult<()> {
    Ok(())
  }
  async fn create_multipart_upload(&self, _req: MultipartCreateRequest) -> PortResult<MultipartCreateResponse> {
    Err(PortError::InvalidInput(
      "NullBlobStorage: multipart not supported".into(),
    ))
  }
  async fn create_multipart_part_url(&self, _req: MultipartPartUrlRequest) -> PortResult<MultipartPartUrlResponse> {
    Err(PortError::InvalidInput(
      "NullBlobStorage: multipart not supported".into(),
    ))
  }
  async fn complete_multipart_upload(&self, _req: MultipartCompleteRequest) -> PortResult<()> {
    Err(PortError::InvalidInput(
      "NullBlobStorage: multipart not supported".into(),
    ))
  }
  async fn abort_multipart_upload(&self, _upload_id: Uuid) -> PortResult<()> {
    Err(PortError::InvalidInput(
      "NullBlobStorage: multipart not supported".into(),
    ))
  }
}

/// Key–value cache port backed by Redis (or an in-process stub for tests).
///
/// Most methods have a default implementation that returns
/// [`PortError::InvalidInput`] so that minimal test stubs only need to
/// override the operations they exercise.
#[async_trait]
pub trait RedisPort: Send + Sync {
  /// Retrieve a UTF-8 string value.  Returns `None` if the key does not exist
  /// or has expired.
  async fn get_string(&self, key: &str) -> PortResult<Option<String>>;
  /// Store a UTF-8 string value.  `ttl_seconds` sets expiry; `None` means
  /// no expiry.
  async fn set_string(&self, key: &str, value: &str, ttl_seconds: Option<u64>) -> PortResult<()>;
  /// Delete a key.  Silently succeeds if the key does not exist.
  async fn delete_key(&self, key: &str) -> PortResult<()>;

  /// Set the key only if it does not already exist (`SET NX`).  Returns
  /// `true` if the key was written, `false` if it already existed.
  async fn setnx_string(&self, _key: &str, _value: &str, _ttl_seconds: Option<u64>) -> PortResult<bool> {
    Err(PortError::InvalidInput("setnx_string not implemented".to_string()))
  }

  /// Atomically replace a string (or create a missing key) only if its value
  /// matches `expected_value`. `None` means absent, distinct from empty text.
  /// Used to claim/release an owned authentication epoch without unblocking a
  /// concurrent mutation. A false result has no effect, including on TTL.
  async fn compare_and_set(
    &self,
    _key: &str,
    _expected_value: Option<&str>,
    _value: &str,
    _ttl_seconds: u64,
  ) -> PortResult<bool> {
    Err(PortError::InvalidInput("compare_and_set not implemented".to_string()))
  }

  /// Atomically delete `key` only if its current value equals `expected_value`.
  ///
  /// Returns `true` if the key was deleted, `false` if it did not exist or
  /// the value differed.  Used to release distributed locks safely: if our
  /// SETNX-acquired lock has already expired and another instance has
  /// re-acquired it (with a different `instance_value`), we must NOT delete
  /// the foreign lock.  Implementations MUST perform the comparison and the
  /// delete atomically (Lua script on Redis, in-memory mutex on stubs).
  async fn compare_and_delete(&self, _key: &str, _expected_value: &str) -> PortResult<bool> {
    Err(PortError::InvalidInput(
      "compare_and_delete not implemented".to_string(),
    ))
  }

  /// Atomically reset the TTL of `key` only if its current value equals
  /// `expected_value`.
  ///
  /// Returns `true` if the TTL was refreshed, `false` if the key did not
  /// exist or the value differed.  Used by the distributed-lock heartbeat:
  /// a long-running sync periodically refreshes its lock TTL so it does not
  /// expire mid-flight, but it must not refresh a foreign lock.
  /// Implementations MUST perform the comparison and the EXPIRE atomically.
  async fn compare_and_refresh(&self, _key: &str, _expected_value: &str, _ttl_seconds: u64) -> PortResult<bool> {
    Err(PortError::InvalidInput(
      "compare_and_refresh not implemented".to_string(),
    ))
  }

  /// Return `true` if the key exists in the store.
  async fn has_key(&self, _key: &str) -> PortResult<bool> {
    Err(PortError::InvalidInput("has_key not implemented".to_string()))
  }

  /// Return the remaining TTL in seconds, or `None` if the key has no expiry.
  async fn ttl_seconds(&self, _key: &str) -> PortResult<Option<u64>> {
    Err(PortError::InvalidInput("ttl_seconds not implemented".to_string()))
  }

  /// Reset the TTL on an existing key.  Returns `true` if the key existed.
  async fn expire_key(&self, _key: &str, _ttl_seconds: u64) -> PortResult<bool> {
    Err(PortError::InvalidInput("expire_key not implemented".to_string()))
  }

  /// Atomically increment a counter by `count` and return the new value.
  async fn increase(&self, _key: &str, _count: i64) -> PortResult<i64> {
    Err(PortError::InvalidInput("increase not implemented".to_string()))
  }

  /// Atomically decrement a counter by `count` and return the new value.
  async fn decrease(&self, _key: &str, _count: i64) -> PortResult<i64> {
    Err(PortError::InvalidInput("decrease not implemented".to_string()))
  }

  /// Append values to the tail of a list.  Returns the new list length.
  async fn list_push_back(&self, _key: &str, _values: &[String]) -> PortResult<usize> {
    Err(PortError::InvalidInput("list_push_back not implemented".to_string()))
  }

  /// Prepend values to the head of a list.  Returns the new list length.
  async fn list_push_front(&self, _key: &str, _values: &[String]) -> PortResult<usize> {
    Err(PortError::InvalidInput("list_push_front not implemented".to_string()))
  }

  /// Return the number of elements in a list.
  async fn list_len(&self, _key: &str) -> PortResult<usize> {
    Err(PortError::InvalidInput("list_len not implemented".to_string()))
  }

  /// Return a sub-range of list elements (inclusive, zero-based).
  async fn list_range(&self, _key: &str, _start: isize, _end: isize) -> PortResult<Vec<String>> {
    Err(PortError::InvalidInput("list_range not implemented".to_string()))
  }

  /// Pop and return up to `count` elements from the front of a list.
  async fn list_pop_front(&self, _key: &str, _count: usize) -> PortResult<Vec<String>> {
    Err(PortError::InvalidInput("list_pop_front not implemented".to_string()))
  }

  /// Pop and return up to `count` elements from the back of a list.
  async fn list_pop_back(&self, _key: &str, _count: usize) -> PortResult<Vec<String>> {
    Err(PortError::InvalidInput("list_pop_back not implemented".to_string()))
  }

  /// Set a string field inside a hash map.  Returns `true` if the field was
  /// newly created.
  async fn hash_set_string(&self, _map: &str, _field: &str, _value: &str) -> PortResult<bool> {
    Err(PortError::InvalidInput("hash_set_string not implemented".to_string()))
  }

  /// Get a string field from a hash map.
  async fn hash_get_string(&self, _map: &str, _field: &str) -> PortResult<Option<String>> {
    Err(PortError::InvalidInput("hash_get_string not implemented".to_string()))
  }

  /// Delete a field from a hash map.  Returns `true` if the field existed.
  async fn hash_delete_key(&self, _map: &str, _field: &str) -> PortResult<bool> {
    Err(PortError::InvalidInput("hash_delete_key not implemented".to_string()))
  }

  /// Return all field names in a hash map.
  async fn hash_keys(&self, _map: &str) -> PortResult<Vec<String>> {
    Err(PortError::InvalidInput("hash_keys not implemented".to_string()))
  }

  /// Return a random field name from a hash map, or `None` if empty.
  async fn hash_random_key(&self, _map: &str) -> PortResult<Option<String>> {
    Err(PortError::InvalidInput("hash_random_key not implemented".to_string()))
  }

  /// Return the number of fields in a hash map.
  async fn hash_len(&self, _map: &str) -> PortResult<usize> {
    Err(PortError::InvalidInput("hash_len not implemented".to_string()))
  }

  /// Atomically increment a numeric field inside a hash map.
  async fn hash_increase(&self, _map: &str, _field: &str, _count: i64) -> PortResult<i64> {
    Err(PortError::InvalidInput("hash_increase not implemented".to_string()))
  }

  /// Atomically decrement a numeric field inside a hash map.
  async fn hash_decrease(&self, _map: &str, _field: &str, _count: i64) -> PortResult<i64> {
    Err(PortError::InvalidInput("hash_decrease not implemented".to_string()))
  }

  /// Delete all keys matching a logical-key glob pattern (P103-B-04).
  ///
  /// The pattern uses standard Redis glob syntax (for example,
  /// `myoxus:doc_snapshot:*`) and must not contain an adapter namespace. Each
  /// adapter scopes the pattern to its configured namespace exactly once, so
  /// even `*` cannot delete keys owned by another Redis role or deployment.
  /// Returns the number of keys that were deleted.
  ///
  /// Default implementation returns [`PortError::InvalidInput`] — concrete
  /// adapters should override this.
  async fn delete_by_pattern(&self, _pattern: &str) -> PortResult<usize> {
    Err(PortError::InvalidInput("delete_by_pattern not implemented".to_string()))
  }
}

/// Transactional email delivery port.
///
/// Implementations may call an SMTP relay, SendGrid, Resend, or any other
/// email provider without the application layer being aware of the choice.
#[async_trait]
pub trait MailPort: Send + Sync {
  /// Deliver a catalog entry without logging its context, tokens or attachments.
  async fn send_template(&self, mail: TemplateMail) -> PortResult<()>;
}

/// Distributed mutual-exclusion lock port.
///
/// Used to serialise actions that must not run concurrently across multiple
/// server instances (e.g. worker job dispatch, reminder claiming).
#[async_trait]
pub trait DistributedLockPort: Send + Sync {
  /// Try to acquire the named lock for `ttl_seconds`.  Returns `true` if the
  /// lock was successfully acquired, `false` if it was already held.
  async fn acquire(&self, key: &str, ttl_seconds: u64) -> PortResult<bool>;
  /// Release a previously acquired lock.
  async fn release(&self, key: &str) -> PortResult<()>;
}

// ─── Remote calendar write port ──────────────────────────────────────────────

/// Input payload for a remote calendar event create / update operation.
#[derive(Debug, Clone)]
pub struct RemoteEventInput {
  /// Local calendar account ID (used to look up provider credentials).
  pub account_id: Uuid,
  /// The calendar (collection) on the remote server to write into.
  pub calendar_id: String,
  /// Stable UID that identifies this event on the remote server.
  pub uid: String,
  /// Start timestamp.
  pub starts_at: DateTime<Utc>,
  /// End timestamp.
  pub ends_at: DateTime<Utc>,
  /// Optional human-readable title.
  pub title: Option<String>,
  /// Optional rich-text description.
  pub description: Option<String>,
  /// Optional physical location.
  pub location: Option<String>,
  /// Provider-specific extra data (merged into the iCalendar payload / Google body).
  pub extra_payload: serde_json::Value,
}

/// Result returned by a successful remote event creation.
#[derive(Debug, Clone)]
pub struct RemoteCreateResult {
  /// The canonical remote resource URL (CalDAV href / Google `{calId}/{evtId}`).
  pub remote_href: String,
  /// ETag returned by the server (if any).
  pub etag: Option<String>,
  /// Provider-assigned event ID (if different from the supplied UID).
  pub remote_event_id: Option<String>,
}

/// Result returned by a successful remote event update.
#[derive(Debug, Clone)]
pub struct RemoteUpdateResult {
  /// New ETag returned by the server (if any).
  pub etag: Option<String>,
}

/// Port for writing calendar events to remote CalDAV / Google Calendar servers.
#[async_trait]
pub trait RemoteCalendarWritePort: Send + Sync {
  /// Create a new event on the remote server.
  async fn create_event(&self, input: &RemoteEventInput) -> PortResult<RemoteCreateResult>;

  /// Update an existing event identified by `remote_href` (optimistic-lock via `etag`).
  async fn update_event(
    &self,
    remote_href: &str,
    etag: &str,
    input: &RemoteEventInput,
  ) -> PortResult<RemoteUpdateResult>;

  /// Delete the event at `remote_href` (optimistic-lock via `etag`).
  async fn delete_event(&self, remote_href: &str, etag: &str, input: &RemoteEventInput) -> PortResult<()>;
}

/// No-op [`RemoteCalendarWritePort`] that silently succeeds.
///
/// Used as the default in `CalendarService::new()` when no write-through
/// adapter is configured, so that the application layer never has to deal
/// with an `Option<Arc<dyn RemoteCalendarWritePort>>`.
pub struct NullRemoteCalendarWrite;

#[async_trait]
impl RemoteCalendarWritePort for NullRemoteCalendarWrite {
  async fn create_event(&self, _input: &RemoteEventInput) -> PortResult<RemoteCreateResult> {
    Ok(RemoteCreateResult {
      remote_href: String::new(),
      etag: None,
      remote_event_id: None,
    })
  }
  async fn update_event(
    &self,
    _remote_href: &str,
    _etag: &str,
    _input: &RemoteEventInput,
  ) -> PortResult<RemoteUpdateResult> {
    Ok(RemoteUpdateResult { etag: None })
  }
  async fn delete_event(&self, _remote_href: &str, _etag: &str, _input: &RemoteEventInput) -> PortResult<()> {
    Ok(())
  }
}

pub mod provider_error;
