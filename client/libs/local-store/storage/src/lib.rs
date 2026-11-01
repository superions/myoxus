// SPDX-License-Identifier: MIT
//
// # client_storage — Local SQLite document & blob storage engine
//
// This crate implements the local-first storage layer that every Myoxus client
// (Electron, mobile, web worker) uses to persist documents, blobs, and sync
// metadata in per-workspace SQLite databases.
//
// ## Dual-target design
//
// The crate compiles into two distinct targets controlled by Cargo features:
//
// - **NAPI mode** (default) — Compiled as a `cdylib` loaded by Node.js via
//   `napi-rs`. Public types derive `#[napi(object)]` and errors map to
//   `napi::Error`. This is the target used by Electron and web workers.
//
// - **Library mode** (`use-as-lib`) — Compiled as `rlib` for consumption by
//   native Rust callers (currently `myoxus_mobile_native` via UniFFI). Binary
//   data is `Vec<u8>` instead of `Uint8Array`, and errors use `anyhow::Result`.
//
// ## Module structure
//
// | Module         | Responsibility                                      |
// |----------------|-----------------------------------------------------|
// | `storage`      | `SqliteDocStorage` — single-connection storage impl |
// | `pool`         | `SqliteDocStoragePool` — multi-workspace pool       |
// | `doc`          | Document CRUD (snapshots, updates, clocks)          |
// | `doc_sync`     | Peer clock tracking for document sync protocol      |
// | `blob`         | Binary blob CRUD and soft-delete lifecycle          |
// | `blob_sync`    | Peer-scoped blob upload tracking                    |
// | `indexer`      | Full-text search indexing and query                 |
// | `indexer_sync` | Indexed-clock tracking for incremental re-indexing  |
// | `error`        | Unified error type (`Error` enum)                   |
//
// ## Database schema
//
// Migrations are defined in `client_schema` and applied automatically at
// connection time via `sqlx::migrate!`. Each workspace gets its own SQLite
// file; the `SqliteDocStoragePool` manages the connection lifecycle.

/// Binary blob CRUD with soft-delete and upload tracking.
pub mod blob;
/// Peer-scoped blob upload timestamp tracking.
pub mod blob_sync;
/// Document CRUD operations (snapshots, incremental updates, merge tracking).
pub mod doc;
/// Peer-to-peer clock tracking for the document sync protocol.
pub mod doc_sync;
/// Unified error type for storage operations.
pub mod error;
/// Full-text search: indexing, querying, match highlighting.
pub mod indexer;
/// Indexed-clock tracking for incremental FTS re-indexing.
pub mod indexer_sync;
/// Multi-workspace connection pool (`SqliteDocStoragePool`).
pub mod pool;
/// Core `SqliteDocStorage` — single-connection storage implementation.
pub mod storage;

#[cfg(not(feature = "use-as-lib"))]
fn to_napi_error<E: std::fmt::Display + std::fmt::Debug>(err: E, status: napi::Status) -> napi::Error {
  napi::Error::new(status, err.to_string())
}
use chrono::NaiveDateTime;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use pool::{Ref, SqliteDocStoragePool};
use storage::SqliteDocStorage;

/// Result type alias — `napi::Result<T>` in NAPI mode, `anyhow::Result<T>` in
/// library mode. This allows the same function signatures to compile for both
/// the Node.js binding and the mobile uniffi bridge.
#[cfg(feature = "use-as-lib")]
type Result<T> = anyhow::Result<T>;

/// Result type alias — `napi::Result<T>` in NAPI mode.
#[cfg(not(feature = "use-as-lib"))]
type Result<T> = napi::Result<T>;

#[cfg(not(feature = "use-as-lib"))]
impl From<error::Error> for napi::Error {
  fn from(err: error::Error) -> Self {
    to_napi_error(err, napi::Status::GenericFailure)
  }
}

/// Binary data type — `Vec<u8>` when used as a library (mobile), `Uint8Array`
/// when exposed via NAPI (Electron / web worker).
#[cfg(feature = "use-as-lib")]
pub type Data = Vec<u8>;

/// Binary data type — `Uint8Array` in NAPI mode for zero-copy JS interop.
#[cfg(not(feature = "use-as-lib"))]
pub type Data = Uint8Array;

/// A single incremental Yjs update for a document.
///
/// Updates are appended after each user edit and later merged into a snapshot
/// via `mark_updates_merged`. The `timestamp` is assigned server-side (or
/// locally on first write) and serves as the update's identity for merge
/// deduplication.
#[napi(object)]
pub struct DocUpdate {
  pub doc_id: String,
  pub timestamp: NaiveDateTime,
  #[napi(ts_type = "Uint8Array")]
  pub bin: Data,
}

/// A full document snapshot (the merge of all updates up to `timestamp`).
///
/// Snapshots are the canonical state of a document. The sync protocol sends
/// the snapshot first, then streams incremental updates on top of it.
#[napi(object)]
pub struct DocRecord {
  pub doc_id: String,
  #[napi(ts_type = "Uint8Array")]
  pub bin: Data,
  pub timestamp: NaiveDateTime,
}

/// Logical clock for a document — the latest known mutation timestamp.
///
/// Used by the sync protocol to determine which updates a peer is missing.
/// A peer compares its local clock with the remote clock to decide what to
/// pull or push.
#[derive(Debug)]
#[napi(object)]
pub struct DocClock {
  pub doc_id: String,
  pub timestamp: NaiveDateTime,
}

/// Clock for the FTS indexer — tracks which version of a document has been
/// indexed so that only changed documents are re-indexed.
#[derive(Debug)]
#[napi(object)]
pub struct DocIndexedClock {
  pub doc_id: String,
  pub timestamp: NaiveDateTime,
  /// Monotonically increasing version of the indexer schema. When the indexer
  /// version changes, all documents are re-indexed from scratch.
  pub indexer_version: i64,
}

/// Input payload for storing a new blob (image, attachment, etc.).
#[napi(object)]
pub struct SetBlob {
  /// Unique blob key (typically a content-hash or UUID).
  pub key: String,
  #[napi(ts_type = "Uint8Array")]
  pub data: Data,
  /// MIME type (e.g. `image/png`, `application/pdf`).
  pub mime: String,
}

/// A stored blob with its full binary payload and metadata.
#[napi(object)]
pub struct Blob {
  pub key: String,
  #[napi(ts_type = "Uint8Array")]
  pub data: Data,
  pub mime: String,
  /// Byte size of the blob data.
  pub size: i64,
  pub created_at: NaiveDateTime,
}

/// Lightweight blob metadata without the binary payload (for listing).
#[napi(object)]
pub struct ListedBlob {
  pub key: String,
  pub size: i64,
  pub mime: String,
  pub created_at: NaiveDateTime,
}

/// Multi-workspace document storage pool exposed to JavaScript via NAPI.
///
/// Each workspace is identified by a `universal_id` (a globally unique string
/// such as `<user_id>:<workspace_id>`) and backed by its own SQLite database
/// file. The pool manages connection lifecycle: `connect` opens a database and
/// runs migrations, `disconnect` closes it and releases the file handle.
///
/// All document, blob, clock, and FTS operations are dispatched through this
/// pool. The pool is thread-safe and designed for concurrent access from
/// multiple async tasks (e.g. parallel sync + UI reads).
#[napi]
pub struct DocStoragePool {
  pool: SqliteDocStoragePool,
}

#[napi]
impl DocStoragePool {
  #[napi(constructor)]
  pub fn new() -> Result<Self> {
    Ok(Self {
      pool: SqliteDocStoragePool::default(),
    })
  }

  /// Retrieve the storage handle for a connected workspace. Returns an error
  /// if the workspace has not been connected yet.
  async fn get(&self, universal_id: String) -> Result<Ref<SqliteDocStorage>> {
    Ok(self.pool.get(universal_id).await?)
  }

  #[napi]
  /// Open (or create) the SQLite database at `path` for the given workspace,
  /// run pending schema migrations, and register the connection in the pool.
  pub async fn connect(&self, universal_id: String, path: String) -> Result<()> {
    self.pool.connect(universal_id, path).await?;
    Ok(())
  }

  #[napi]
  pub async fn disconnect(&self, universal_id: String) -> Result<()> {
    self.pool.disconnect(universal_id).await?;
    Ok(())
  }

  #[napi]
  pub async fn checkpoint(&self, universal_id: String) -> Result<()> {
    self.pool.get(universal_id).await?.checkpoint().await?;
    Ok(())
  }

  #[napi]
  pub async fn crawl_doc_data(&self, universal_id: String, doc_id: String) -> Result<indexer::NativeCrawlResult> {
    let result = self.get(universal_id).await?.crawl_doc_data(&doc_id).await?;
    Ok(result)
  }

  #[napi]
  pub async fn set_space_id(&self, universal_id: String, space_id: String) -> Result<()> {
    self.get(universal_id).await?.set_space_id(space_id).await?;
    Ok(())
  }

  #[napi]
  pub async fn push_update(&self, universal_id: String, doc_id: String, update: Uint8Array) -> Result<NaiveDateTime> {
    Ok(self.get(universal_id).await?.push_update(doc_id, update).await?)
  }

  #[napi]
  pub async fn get_doc_snapshot(&self, universal_id: String, doc_id: String) -> Result<Option<DocRecord>> {
    Ok(self.get(universal_id).await?.get_doc_snapshot(doc_id).await?)
  }

  #[napi]
  pub async fn set_doc_snapshot(&self, universal_id: String, snapshot: DocRecord) -> Result<bool> {
    Ok(self.get(universal_id).await?.set_doc_snapshot(snapshot).await?)
  }

  #[napi]
  pub async fn get_doc_updates(&self, universal_id: String, doc_id: String) -> Result<Vec<DocUpdate>> {
    Ok(self.get(universal_id).await?.get_doc_updates(doc_id).await?)
  }

  #[napi]
  pub async fn mark_updates_merged(
    &self,
    universal_id: String,
    doc_id: String,
    updates: Vec<NaiveDateTime>,
  ) -> Result<u32> {
    Ok(
      self
        .get(universal_id)
        .await?
        .mark_updates_merged(doc_id, updates)
        .await?,
    )
  }

  #[napi]
  pub async fn delete_doc(&self, universal_id: String, doc_id: String) -> Result<()> {
    self.get(universal_id).await?.delete_doc(doc_id).await?;
    Ok(())
  }

  #[napi]
  pub async fn get_doc_clocks(&self, universal_id: String, after: Option<NaiveDateTime>) -> Result<Vec<DocClock>> {
    Ok(self.get(universal_id).await?.get_doc_clocks(after).await?)
  }

  #[napi]
  pub async fn get_doc_clock(&self, universal_id: String, doc_id: String) -> Result<Option<DocClock>> {
    Ok(self.get(universal_id).await?.get_doc_clock(doc_id).await?)
  }

  #[napi]
  pub async fn get_doc_indexed_clock(&self, universal_id: String, doc_id: String) -> Result<Option<DocIndexedClock>> {
    Ok(self.get(universal_id).await?.get_doc_indexed_clock(doc_id).await?)
  }

  #[napi]
  pub async fn set_doc_indexed_clock(
    &self,
    universal_id: String,
    doc_id: String,
    indexed_clock: NaiveDateTime,
    indexer_version: i64,
  ) -> Result<()> {
    self
      .get(universal_id)
      .await?
      .set_doc_indexed_clock(doc_id, indexed_clock, indexer_version)
      .await?;
    Ok(())
  }

  #[napi]
  pub async fn clear_doc_indexed_clock(&self, universal_id: String, doc_id: String) -> Result<()> {
    self.get(universal_id).await?.clear_doc_indexed_clock(doc_id).await?;
    Ok(())
  }

  #[napi(async_runtime)]
  pub async fn get_blob(&self, universal_id: String, key: String) -> Result<Option<Blob>> {
    Ok(self.get(universal_id).await?.get_blob(key).await?)
  }

  #[napi]
  pub async fn set_blob(&self, universal_id: String, blob: SetBlob) -> Result<()> {
    self.get(universal_id).await?.set_blob(blob).await?;
    Ok(())
  }

  #[napi]
  pub async fn delete_blob(&self, universal_id: String, key: String, permanently: bool) -> Result<()> {
    self.get(universal_id).await?.delete_blob(key, permanently).await?;
    Ok(())
  }

  #[napi]
  pub async fn release_blobs(&self, universal_id: String) -> Result<()> {
    self.get(universal_id).await?.release_blobs().await?;
    Ok(())
  }

  #[napi]
  pub async fn list_blobs(&self, universal_id: String) -> Result<Vec<ListedBlob>> {
    Ok(self.get(universal_id).await?.list_blobs().await?)
  }

  #[napi]
  pub async fn get_peer_remote_clocks(&self, universal_id: String, peer: String) -> Result<Vec<DocClock>> {
    Ok(self.get(universal_id).await?.get_peer_remote_clocks(peer).await?)
  }

  #[napi]
  pub async fn get_peer_remote_clock(
    &self,
    universal_id: String,
    peer: String,
    doc_id: String,
  ) -> Result<Option<DocClock>> {
    Ok(
      self
        .get(universal_id)
        .await?
        .get_peer_remote_clock(peer, doc_id)
        .await?,
    )
  }

  #[napi]
  pub async fn set_peer_remote_clock(
    &self,
    universal_id: String,
    peer: String,
    doc_id: String,
    clock: NaiveDateTime,
  ) -> Result<()> {
    self
      .get(universal_id)
      .await?
      .set_peer_remote_clock(peer, doc_id, clock)
      .await?;
    Ok(())
  }

  #[napi]
  pub async fn get_peer_pulled_remote_clocks(&self, universal_id: String, peer: String) -> Result<Vec<DocClock>> {
    Ok(
      self
        .get(universal_id)
        .await?
        .get_peer_pulled_remote_clocks(peer)
        .await?,
    )
  }

  #[napi]
  pub async fn get_peer_pulled_remote_clock(
    &self,
    universal_id: String,
    peer: String,
    doc_id: String,
  ) -> Result<Option<DocClock>> {
    Ok(
      self
        .get(universal_id)
        .await?
        .get_peer_pulled_remote_clock(peer, doc_id)
        .await?,
    )
  }

  #[napi]
  pub async fn set_peer_pulled_remote_clock(
    &self,
    universal_id: String,
    peer: String,
    doc_id: String,
    clock: NaiveDateTime,
  ) -> Result<()> {
    self
      .get(universal_id)
      .await?
      .set_peer_pulled_remote_clock(peer, doc_id, clock)
      .await?;
    Ok(())
  }

  #[napi]
  pub async fn get_peer_pushed_clocks(&self, universal_id: String, peer: String) -> Result<Vec<DocClock>> {
    Ok(self.get(universal_id).await?.get_peer_pushed_clocks(peer).await?)
  }

  #[napi]
  pub async fn get_peer_pushed_clock(
    &self,
    universal_id: String,
    peer: String,
    doc_id: String,
  ) -> Result<Option<DocClock>> {
    Ok(
      self
        .get(universal_id)
        .await?
        .get_peer_pushed_clock(peer, doc_id)
        .await?,
    )
  }

  #[napi]
  pub async fn set_peer_pushed_clock(
    &self,
    universal_id: String,
    peer: String,
    doc_id: String,
    clock: NaiveDateTime,
  ) -> Result<()> {
    self
      .get(universal_id)
      .await?
      .set_peer_pushed_clock(peer, doc_id, clock)
      .await?;
    Ok(())
  }

  #[napi]
  pub async fn clear_clocks(&self, universal_id: String) -> Result<()> {
    self.get(universal_id).await?.clear_clocks().await?;
    Ok(())
  }

  #[napi]
  pub async fn set_blob_uploaded_at(
    &self,
    universal_id: String,
    peer: String,
    blob_id: String,
    uploaded_at: Option<NaiveDateTime>,
  ) -> Result<()> {
    self
      .get(universal_id)
      .await?
      .set_blob_uploaded_at(peer, blob_id, uploaded_at)
      .await?;
    Ok(())
  }

  #[napi]
  pub async fn get_blob_uploaded_at(
    &self,
    universal_id: String,
    peer: String,
    blob_id: String,
  ) -> Result<Option<NaiveDateTime>> {
    let result = self
      .get(universal_id)
      .await?
      .get_blob_uploaded_at(peer, blob_id)
      .await?;

    Ok(result)
  }

  #[napi]
  pub async fn fts_add_document(
    &self,
    id: String,
    index_name: String,
    doc_id: String,
    text: String,
    index: bool,
  ) -> Result<()> {
    let storage = self.pool.get(id).await?;
    storage.fts_add(&index_name, &doc_id, &text, index).await?;
    Ok(())
  }

  #[napi]
  pub async fn fts_flush_index(&self, id: String) -> Result<()> {
    let storage = self.pool.get(id).await?;
    storage.flush_index().await?;
    Ok(())
  }

  #[napi]
  pub async fn fts_index_state(&self, id: String) -> Result<String> {
    Ok(self.pool.get(id).await?.index_state().to_string())
  }

  #[napi]
  pub async fn fts_complete_rebuild(&self, id: String) -> Result<()> {
    self.pool.get(id).await?.complete_index_rebuild().await?;
    Ok(())
  }

  #[napi]
  pub async fn fts_fail_rebuild(&self, id: String) -> Result<()> {
    self.pool.get(id).await?.fail_index_rebuild();
    Ok(())
  }

  #[napi]
  pub async fn fts_index_version(&self) -> Result<u32> {
    Ok(SqliteDocStorage::index_version())
  }

  #[napi]
  pub async fn fts_delete_document(&self, id: String, index_name: String, doc_id: String) -> Result<()> {
    let storage = self.pool.get(id).await?;
    storage.fts_delete(&index_name, &doc_id).await?;
    Ok(())
  }

  #[napi]
  pub async fn fts_get_document(&self, id: String, index_name: String, doc_id: String) -> Result<Option<String>> {
    let storage = self.pool.get(id).await?;
    Ok(storage.fts_get(&index_name, &doc_id).await?)
  }

  #[napi]
  pub async fn fts_search(
    &self,
    id: String,
    index_name: String,
    query: String,
  ) -> Result<Vec<indexer::NativeSearchHit>> {
    let storage = self.pool.get(id).await?;
    Ok(storage.fts_search(&index_name, &query).await?)
  }

  #[napi]
  pub async fn fts_get_matches(
    &self,
    id: String,
    index_name: String,
    doc_id: String,
    query: String,
  ) -> Result<Vec<indexer::NativeMatch>> {
    let storage = self.pool.get(id).await?;
    Ok(storage.fts_get_matches(&index_name, &doc_id, &query).await?)
  }
}

/// Single-workspace document storage handle (standalone, not pooled).
///
/// This is a simpler wrapper around `SqliteDocStorage` for use cases where
/// only one workspace is needed (e.g. validation tooling, one-off imports).
/// For multi-workspace scenarios, prefer `DocStoragePool`.
#[napi]
pub struct DocStorage {
  storage: SqliteDocStorage,
}

#[napi]
impl DocStorage {
  #[napi(constructor, async_runtime)]
  pub fn new(path: String) -> Self {
    Self {
      storage: SqliteDocStorage::new(path),
    }
  }

  #[napi]
  pub async fn validate(&self) -> Result<bool> {
    Ok(self.storage.validate().await?)
  }

  #[napi]
  pub async fn set_space_id(&self, space_id: String) -> Result<()> {
    self.storage.connect().await?;
    self.storage.set_space_id(space_id).await?;
    self.storage.close().await;
    Ok(())
  }
}

#[cfg(all(test, not(feature = "use-as-lib")))]
mod tests {
  use super::error;

  #[test]
  fn napi_error_mapping_preserves_reason() {
    let err: napi::Error = error::Error::InvalidOperation.into();
    assert_eq!(err.status, napi::Status::GenericFailure);
    assert!(err.reason.contains("Invalid operation"));
  }

  #[test]
  fn napi_error_mapping_connection_in_progress() {
    let err: napi::Error = error::Error::ConnectionInProgress.into();
    assert_eq!(err.status, napi::Status::GenericFailure);
    assert!(err.reason.contains("Connection in progress"));
  }
}
