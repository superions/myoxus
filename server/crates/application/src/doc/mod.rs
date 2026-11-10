//! Document application service and storage port.
//!
//! This module defines [`DocStore`] — the async super-trait combining all six
//! doc sub-traits — together with [`DocService`], which encodes the business
//! logic for loading, updating, snapshotting and rolling back collaborative
//! documents. [`PanicDocStore`] provides a panic-on-call stub for use in tests
//! and in-process wiring where doc operations must not be invoked.
//!
//! **Sub-traits** (defined in `traits.rs`) allow finer-grained dependency
//! injection. Use them in new code instead of the full [`DocStore`].

pub mod compaction;
pub mod content_mutation;
pub mod content_projection;
pub mod delete;
pub mod history;
pub mod lifecycle;
pub mod load;
pub mod preview;
pub mod provenance;
pub mod repair;
pub mod traits;
pub mod write;

pub use compaction::DocCompactionService;
pub use content_mutation::{
  DocumentContentMutationService, DocumentFragment, DocumentFragmentBlock, DocumentFragmentDiagnostic,
  DocumentFragmentDiagnostics, DocumentListKind, DocumentMutation, DocumentTextFormatting, DocumentTextLinkChange,
  DocumentTextRangeUnit, DocumentTextSegment, document_fragment_from_markdown, document_fragment_from_yjs,
  document_fragment_from_yjs_with_diagnostics, normalize_document_mutation, normalize_document_text_segments,
  normalize_text_formatting,
};
pub use content_projection::{
  BlobReadToolCall, DEFAULT_DOCUMENT_EXPORT_MAX_BYTES, DocumentContentProjection, DocumentContentProjectionService,
  DocumentExportEnvelope, DocumentMutationReadback, DocumentPlainTextProjection, DocumentProjectionEnvelope,
  DocumentProjectionError, DocumentProjectionRequest, DocumentRepresentation, DocumentSelector, MutationReadbackStatus,
  MutationReadbackUnavailableReason, PrivateDocumentAsset, project_yjs_plain_text,
};
pub use delete::{
  PermanentDeleteDocumentResult, PermanentDeleteMode, PermanentDeleteRequest, PermanentDeleteStatus,
  PermanentDeleteSummary, SourceRetirementOwnership,
};
pub use history::DocHistoryService;
pub use lifecycle::{CreatedPageSyncUpdates, PageLifecycleService};
pub use load::{DOC_VIEW_DEDUP, DOC_VIEW_DEDUP_DATE, DocLoadService};
pub use preview::{
  DocumentPreviewSource, DocumentPreviewSourceService, PreviewSourceError, PreviewSourceRequest, asset_revision,
};
pub use provenance::{
  InitialDocumentProvenance, InitialDocumentProvenanceMode, InitialDocumentProvenanceSource,
  ResolvedInitialDocumentProvenance, ResolvedInitialDocumentProvenanceMode, resolve_initial_document_provenance,
};
pub use repair::{
  PageLifecycleAuditFinding, PageLifecycleDriftClass, PageLifecycleRepairMode, PageLifecycleRepairService,
  PageProjectionCompleteness, PageProjectionFinding, PageProjectionInspection, PageProjectionPresenceEvidence,
  PageProjectionRepairResult, PageProjectionScanLane, PageProjectionScanResult,
};
pub use traits::{DocAttribution, DocGrantedUser, DocMemberLastAccess, DocViewDaily};
pub use write::{DocWriteService, ExternalUpdateIngressPolicy};

/// Stable rejection code for ordinary destructive writes against a source
/// owned by an active, non-seed Registry assignment.
pub const ASSIGNED_TEMPLATE_SOURCE_PROTECTED: &str = "MIX_ASSIGNED_TEMPLATE_SOURCE_PROTECTED";

/// Content-address one canonical materialization of a Yjs v1 document.
///
/// Maintenance planners and the locked persistence boundary use this same
/// helper so revision comparison cannot drift into transport-specific logic.
pub fn canonical_yjs_revision(payload: &[u8]) -> Result<String, String> {
  let canonical = yjs::merge_updates(vec![payload.to_vec()])?;
  let fingerprint = yjs::document_field::content::fingerprint_input(&canonical).map_err(str::to_owned)?;
  Ok(hex::encode(Sha256::digest(
    fingerprint.as_deref().unwrap_or(&canonical),
  )))
}

// ── P102-CACHE: Doc cache port trait ─────────────────────────────────────────

/// Port trait for Redis-backed doc caches (P102-CACHE-01..05).
///
/// All operations degrade gracefully — implementations must never propagate
/// Redis errors to callers. A `None` return always means "cache miss".
///
/// Implemented by `myoxus_infrastructure::doc_cache::DocCache`.
/// The application crate uses only this trait so it stays free of infrastructure deps.
#[async_trait]
pub trait DocCachePort: Send + Sync {
  /// Get cached merged Yjs snapshot (CACHE-01).
  async fn get_snapshot(&self, ws: Uuid, doc: Uuid) -> Option<Vec<u8>>;
  /// Store merged Yjs snapshot (CACHE-01).
  async fn set_snapshot(&self, ws: Uuid, doc: Uuid, payload: &[u8]);
  /// Invalidate snapshot cache entry (CACHE-01).
  async fn invalidate_snapshot(&self, ws: Uuid, doc: Uuid);

  /// Get cached doc metadata JSON (CACHE-02).
  async fn get_metadata(&self, doc: Uuid) -> Option<serde_json::Value>;
  /// Store doc metadata JSON (CACHE-02).
  async fn set_metadata(&self, doc: Uuid, meta: &serde_json::Value);
  /// Invalidate doc metadata cache entry (CACHE-02).
  async fn invalidate_metadata(&self, doc: Uuid);

  /// Get cached canonical document metadata projection.
  ///
  /// This is intentionally separate from `doc_meta`: `doc_meta` is sync/doc
  /// existence metadata, while this payload is a client projection derived from
  /// canonical metadata sources.
  async fn get_metadata_projection(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _projection_mode: &str,
    _projection_version: &str,
  ) -> Option<DocumentMetadataProjection> {
    None
  }

  /// Store a canonical document metadata projection cache entry.
  async fn set_metadata_projection(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _projection_mode: &str,
    _projection_version: &str,
    _projection: &DocumentMetadataProjection,
  ) {
  }

  /// Record an observed projection-version change separately from cache misses.
  async fn record_metadata_projection_version_change(&self) {}

  /// Get actor-independent document-list facts for one authoritative version.
  async fn get_document_metadata_index(
    &self,
    _workspace_id: Uuid,
    _version: &str,
  ) -> Option<Vec<DocumentMetadataIndexRow>> {
    None
  }

  /// Cache a complete document-list projection, including confirmed emptiness.
  async fn set_document_metadata_index(&self, _workspace_id: Uuid, _version: &str, _rows: &[DocumentMetadataIndexRow]) {
  }

  /// Get one lightweight Database inventory page at an authoritative revision.
  async fn get_database_page_inventory(
    &self,
    _workspace_id: Uuid,
    _lifecycle: &str,
    _limit: i64,
    _offset: i64,
    _version: &str,
  ) -> Option<Vec<myoxus_domain::database::DatabasePageIdentity>> {
    None
  }

  /// Cache a complete lightweight Database inventory page, including emptiness.
  async fn set_database_page_inventory(
    &self,
    _workspace_id: Uuid,
    _lifecycle: &str,
    _limit: i64,
    _offset: i64,
    _version: &str,
    _rows: &[myoxus_domain::database::DatabasePageIdentity],
  ) {
  }

  /// Invalidate all cached metadata projections for one document.
  async fn invalidate_metadata_projection(&self, _workspace_id: Uuid, _doc_id: Uuid) {}

  /// Check-and-set a unique doc view (CACHE-03).
  /// Returns `true` if this is the first view for this (user, ws, doc, date) tuple today.
  async fn check_and_set_view_dedup(&self, user: Uuid, ws: Uuid, doc: &str, date: NaiveDate) -> bool;

  /// Try to acquire the distributed compaction lock (CACHE-04).
  /// Returns `true` if acquired, `false` if already held.
  async fn acquire_compaction_lock(&self, doc: Uuid, instance_id: Uuid) -> bool;
  /// Release the compaction lock (CACHE-04).
  async fn release_compaction_lock(&self, doc: Uuid);

  /// Get cached doc timestamps for a workspace (CACHE-05).
  async fn get_timestamps(&self, ws: Uuid) -> Option<HashMap<String, i64>>;
  /// Store doc timestamps for a workspace (CACHE-05).
  async fn set_timestamps(&self, ws: Uuid, timestamps: &HashMap<String, i64>);
  /// Invalidate doc timestamps cache entry (CACHE-05).
  async fn invalidate_timestamps(&self, ws: Uuid);

  // ── P103-B-04: Admin flush mutations ────────────────────────────────────────

  /// Flush all snapshot cache entries (`doc_snapshot:*`).
  ///
  /// Returns the number of deleted keys. Degrades gracefully: returns 0 on
  /// error or when no Redis backing is available.
  async fn flush_snapshot_cache(&self) -> usize {
    0
  }

  /// Flush all metadata cache entries (`doc_meta:*`).
  ///
  /// Returns the number of deleted keys.
  async fn flush_metadata_cache(&self) -> usize {
    0
  }

  /// Flush all metadata projection cache entries (`doc_metadata_projection:*`).
  async fn flush_metadata_projection_cache(&self) -> usize {
    0
  }

  /// Flush all doc-related caches (snapshot, metadata, timestamps, compaction
  /// locks). Returns the total number of deleted keys.
  async fn flush_all_doc_caches(&self) -> usize {
    0
  }
}

pub use traits::{
  AutomationPageLifecycleResult, AutomationRowContentTarget, DocContentMutationCommit, DocDeleteCandidate,
  DocHistoryStore, DocLoadStore, DocMetadataStore, DocPermissionStore, DocRevisionCheckedUpdateOutcome,
  DocSnapshotStore, DocTitleBackfillCandidate, DocUpdatePersistenceOutcome, DocUpdatePersistenceResult, DocUpdateStore,
  DocViewStore, PageLifecycleAuditState, PageLifecycleCommand, PageLifecycleCommit, PageLifecycleDelta,
  PageLifecycleKind, PageLifecycleRepairCommand, PageLifecycleRepairCommit, PageProjectionSqlRow,
  PageRegistrationState, PanicDocHistoryStore, PanicDocLoadStore, PanicDocMetadataStore, PanicDocPermissionStore,
  PanicDocSnapshotStore, PanicDocUpdateStore, PanicDocViewStore,
};

pub(crate) use traits::AutomationPageContent;

use crate::auth::{AuthError, AuthResult};
use async_trait::async_trait;
use chrono::NaiveDate;
use myoxus_domain::document_graph::DocumentGraphReindexReason;
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::entities::{Doc, DocDefaultRole, DocRole, DocumentMetadataIndexRow, DocumentMetadataProjection};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{
  Arc,
  atomic::{AtomicU8, Ordering},
};
use tokio::sync::RwLock;
use tracing::{info, instrument, trace, warn};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocSpaceKind {
  Workspace,
  Userspace,
}

#[derive(Debug, Clone)]
pub struct DocUpdate {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub payload: Vec<u8>,
  pub sequence: i64,
  pub space_kind: DocSpaceKind,
}

/// Identity used when appending a document update.
#[derive(Debug, Clone)]
pub enum DocWriteTarget {
  /// A server-internal call that already owns an authorized `docs.id`.
  Internal(Uuid),
  /// A client/API boundary that must resolve its workspace-local key in SQL.
  External(DocumentKey),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DocSyncClientKind {
  Web,
  Electron,
  Mobile,
  Unknown,
}

impl DocSyncClientKind {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Web => "web",
      Self::Electron => "electron",
      Self::Mobile => "mobile",
      Self::Unknown => "unknown",
    }
  }
}

/// Server-derived, connection-owned client class for one external sync write.
/// It cannot authorize offline provenance or replace document state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocSyncConnectionContext {
  pub client_kind: DocSyncClientKind,
}

/// Decoder-owned context retained between external ingress validation and the
/// transactional replay gate.
///
/// The send-safe decoder handle owns the shared permit until persistence has
/// selected either the fast struct-clock path or bounded materialization.
pub struct ValidatedExternalYjsUpdate {
  decoded: yjs::ValidatedYjsUpdate,
  max_materialization_bytes: usize,
}

impl std::fmt::Debug for ValidatedExternalYjsUpdate {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter
      .debug_struct("ValidatedExternalYjsUpdate")
      .field("decoded", &self.decoded)
      .field("max_materialization_bytes", &self.max_materialization_bytes)
      .finish_non_exhaustive()
  }
}

impl ValidatedExternalYjsUpdate {
  pub fn new(decoded: yjs::ValidatedYjsUpdate, max_materialization_bytes: usize) -> Self {
    Self {
      decoded,
      max_materialization_bytes,
    }
  }

  /// Split the validated decoder result from its bounded-execution context at
  /// the infrastructure boundary.
  pub fn into_parts(self) -> (yjs::ValidatedYjsUpdate, usize) {
    (self.decoded, self.max_materialization_bytes)
  }
}

/// Write-only document update command.
#[derive(Debug)]
pub struct DocUpdateWrite {
  /// Ephemeral outer-handler correlation ID. Never persisted or used as a
  /// metric label.
  pub sync_operation_id: Option<Uuid>,
  pub connection_context: Option<DocSyncConnectionContext>,
  pub workspace_id: Uuid,
  pub target: DocWriteTarget,
  pub payload: Vec<u8>,
  pub space_kind: DocSpaceKind,
  pub actor_user_id: Option<Uuid>,
  pub client_format: Option<String>,
  pub client_capabilities: Option<String>,
  pub initial_provenance: Option<InitialDocumentProvenance>,
  /// Present only for client/API writes that passed the bounded external Yjs
  /// ingress decoder. Internal server-authored writes deliberately leave it
  /// absent and invalidate the derived state-vector acceleration value.
  pub validated_external_update: Option<ValidatedExternalYjsUpdate>,
}

/// Metadaten eines Doc-Snapshots, kombiniert mit dem Snapshot-Payload.
/// Wird von `load_full_doc_with_meta` verwendet.
#[derive(Debug, Clone)]
pub struct DocSnapshotMeta {
  /// Der kompaktierte Yjs-Payload.
  pub payload: Vec<u8>,
  /// `updated_at` reflects the latest client update timestamp
  /// (`MAX(server_timestamp)` of the merged updates), not the compaction time.
  /// It is used for the `X-Doc-Timestamp` response header.
  pub updated_at: chrono::DateTime<chrono::Utc>,
  /// Sequence number of the last update merged into the snapshot.
  pub last_sequence: i64,
}

/// Result of `load_full_doc_with_meta`, including the merged Yjs payload and metadata.
#[derive(Debug, Clone)]
pub struct DocLoadResult {
  /// Fully merged Yjs payload (snapshot plus all updates via `yrs::merge_updates`).
  /// Empty when neither a snapshot nor updates exist (`has_real_content = false`).
  pub payload: Vec<u8>,
  /// `doc_snapshots.updated_at`, used as the millisecond timestamp for the
  /// `X-Doc-Timestamp` header. `None` when only pending updates exist.
  pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
  /// `true` when the document exists and `deleted_at IS NULL`.
  pub exists: bool,
  /// `true` when the database contains at least one snapshot or update.
  /// A created document without Yjs content returns an empty REST body for API
  /// compatibility.
  pub has_real_content: bool,
}

/// Cooperative cancellation shared by the owning socket and one load worker.
///
/// The flag is intentionally process-local and never persisted. Repository
/// producers and the blocking Yjs consumer both inspect the same value between
/// updates, ensuring a disconnected socket cannot leave detached materializers.
#[derive(Debug, Default)]
struct DocLoadCancellationInner {
  reason: AtomicU8,
  notify: tokio::sync::Notify,
}

#[derive(Clone, Debug, Default)]
pub struct DocLoadCancellation(Arc<DocLoadCancellationInner>);

/// Fixed, low-cardinality reason attached to cooperative load cancellation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum DocLoadCancellationReason {
  Disconnect = 1,
  SessionRevoked = 2,
  Shutdown = 3,
  Explicit = 4,
}

impl DocLoadCancellationReason {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Disconnect => "disconnect",
      Self::SessionRevoked => "session_revoked",
      Self::Shutdown => "shutdown",
      Self::Explicit => "explicit",
    }
  }
}

impl DocLoadCancellation {
  pub fn cancel(&self) {
    self.cancel_with_reason(DocLoadCancellationReason::Explicit);
  }

  pub fn cancel_with_reason(&self, reason: DocLoadCancellationReason) {
    if self
      .0
      .reason
      .compare_exchange(0, reason as u8, Ordering::AcqRel, Ordering::Acquire)
      .is_ok()
    {
      self.0.notify.notify_waiters();
    }
  }

  pub fn is_cancelled(&self) -> bool {
    self.0.reason.load(Ordering::Acquire) != 0
  }

  pub fn reason(&self) -> Option<DocLoadCancellationReason> {
    match self.0.reason.load(Ordering::Acquire) {
      1 => Some(DocLoadCancellationReason::Disconnect),
      2 => Some(DocLoadCancellationReason::SessionRevoked),
      3 => Some(DocLoadCancellationReason::Shutdown),
      4 => Some(DocLoadCancellationReason::Explicit),
      _ => None,
    }
  }

  pub async fn cancelled(&self) {
    if self.is_cancelled() {
      return;
    }
    let notified = self.0.notify.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();
    if self.is_cancelled() {
      return;
    }
    notified.await;
  }
}

/// Bounded repository streaming counters for one document load.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DocUpdateStreamStats {
  pub update_count: usize,
  pub input_bytes: usize,
}

/// Metadata returned after one consistent snapshot/tail repository stream.
#[derive(Debug, Clone, Default)]
pub struct DocStateStreamMeta {
  /// Highest committed sequence included in this same database snapshot.
  pub revision: i64,
  pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
  pub exists: bool,
  pub has_real_content: bool,
  pub stats: DocUpdateStreamStats,
}

/// Diff response derived from exactly one Yjs document materialization.
#[derive(Debug, Clone)]
pub struct DocLoadDiffResult {
  pub revision: i64,
  pub missing: Vec<u8>,
  pub state_vector: Vec<u8>,
  pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
  pub exists: bool,
  pub has_real_content: bool,
  pub input_bytes: usize,
  pub update_count: usize,
  pub decoder_wait_ms: u64,
  pub materialize_ms: u64,
}

/// Full native content and the committed sequence from one consistent read.
/// Never construct this by pairing a cached payload with a separate head query.
#[derive(Debug, Clone)]
pub struct DocContentState {
  pub payload: Vec<u8>,
  pub revision: i64,
  pub has_real_content: bool,
}

/// Cheap cache-validation identity for one current document source.
///
/// The committed sequence includes update-only edits while `metadata_revision`
/// covers title, mode and lifecycle changes that do not alter Yjs bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocPreviewSourceIdentity {
  pub revision: i64,
  pub metadata_revision: i64,
  pub title: String,
  pub public_mode: String,
  pub deleted: bool,
}

/// Super-trait combining all DocStore sub-traits for backward compatibility.
///
/// Existing code using `Arc<dyn DocStore>` continues to work unchanged.
/// New code should prefer the narrower sub-traits defined in [`traits`] for
/// finer-grained dependency injection.
pub trait DocStore:
  DocSnapshotStore
  + DocUpdateStore
  + DocLoadStore
  + DocMetadataStore
  + DocViewStore
  + DocHistoryStore
  + DocPermissionStore
{
}

/// Optional, non-fatal hook used by the Document Graph service.
///
/// `DocService` owns all document write/delete entry points, while the graph
/// service owns queueing and index state. Keeping this as a tiny application
/// port avoids GraphQL-only side effects and prevents Yjs graph extraction from
/// running synchronously in user write paths.
#[async_trait]
pub trait DocumentGraphIndexHook: Send + Sync {
  async fn enqueue_document_graph_reindex(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    reason: DocumentGraphReindexReason,
  ) -> Result<(), String>;

  async fn mark_document_graph_deleted(&self, workspace_id: Uuid, doc_id: Uuid) -> Result<(), String>;

  async fn database_reference_refreshes_before_delete(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> Result<Vec<myoxus_domain::database::DatabaseDocumentReferenceRefresh>, String> {
    let _ = (workspace_id, doc_id);
    Ok(Vec::new())
  }

  async fn enqueue_database_reference_refreshes(
    &self,
    refreshes: Vec<myoxus_domain::database::DatabaseDocumentReferenceRefresh>,
  ) -> Result<(), String> {
    let _ = refreshes;
    Ok(())
  }
}

/// Capture identity and provenance only; listing never requires snapshot decoding.
#[derive(Debug, Clone)]
pub struct DocHistoryMetadataEntry {
  pub id: i64,
  pub doc_id: Uuid,
  pub workspace_id: Uuid,
  pub created_at: chrono::DateTime<chrono::Utc>,
  /// `None` identifies a row created before provenance tracking.
  pub origin: Option<history::DocHistoryOrigin>,
  pub actor_id: Option<Uuid>,
  pub actor_name: Option<String>,
  pub actor_avatar_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DocHistoryEntry {
  pub id: i64,
  pub doc_id: Uuid,
  pub workspace_id: Uuid,
  pub snapshot: Vec<u8>,
  pub created_at: chrono::DateTime<chrono::Utc>,
  /// `None` identifies a row created before provenance tracking.
  pub origin: Option<history::DocHistoryOrigin>,
  pub actor_id: Option<Uuid>,
  pub actor_name: Option<String>,
  pub actor_avatar_key: Option<String>,
}

/// Panic-on-call stub for `DocStore`. Used as default in `ApiState` and in tests
/// that do not exercise doc-storage paths.
///
/// If a test calls any doc method when using this stub, it panics immediately
/// with a clear message — making the missing dependency visible rather than
/// silently returning empty results.
pub struct PanicDocStore;

// P102-MOD-03: PanicDocStore implements all 6 sub-traits separately.
// impl DocStore for PanicDocStore {} is a marker — all methods live in sub-traits.

#[async_trait]
impl DocSnapshotStore for PanicDocStore {
  async fn get_snapshot(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<Option<Vec<u8>>> {
    panic!("PanicDocStore: get_snapshot called — configure a real DocStore in this test")
  }
  async fn get_snapshot_with_meta(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<Option<DocSnapshotMeta>> {
    panic!("PanicDocStore: get_snapshot_with_meta called — configure a real DocStore in this test")
  }
  async fn save_snapshot(
    &self,
    _doc_id: Uuid,
    _workspace_id: Uuid,
    _payload: Vec<u8>,
    _last_sequence: i64,
  ) -> AuthResult<()> {
    panic!("PanicDocStore: save_snapshot called — configure a real DocStore in this test")
  }
}

#[async_trait]
impl DocUpdateStore for PanicDocStore {
  async fn push_update(&self, _update: DocUpdateWrite) -> AuthResult<DocUpdatePersistenceResult> {
    panic!("PanicDocStore: push_update called — configure a real DocStore in this test")
  }
  async fn get_updates_after(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _after_sequence: i64,
  ) -> AuthResult<Vec<DocUpdate>> {
    panic!("PanicDocStore: get_updates_after called — configure a real DocStore in this test")
  }
  async fn count_pending_updates(&self, _doc_id: Uuid) -> AuthResult<i64> {
    panic!("PanicDocStore: count_pending_updates called — configure a real DocStore in this test")
  }
  async fn count_all_pending_updates(&self) -> AuthResult<i64> {
    panic!("PanicDocStore: count_all_pending_updates called — configure a real DocStore in this test")
  }
  async fn max_update_sequence(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<i64> {
    panic!("PanicDocStore: max_update_sequence called — configure a real DocStore in this test")
  }
}

#[async_trait]
impl DocLoadStore for PanicDocStore {
  async fn stream_doc_state(
    &self,
    _sync_operation_id: Uuid,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _sender: tokio::sync::mpsc::Sender<Vec<u8>>,
    _cancellation: DocLoadCancellation,
  ) -> AuthResult<DocStateStreamMeta> {
    panic!("PanicDocStore: stream_doc_state called — configure a real DocStore in this test")
  }
}

#[async_trait]
impl DocMetadataStore for PanicDocStore {
  async fn resolve_external_doc_id(
    &self,
    _space_id: Uuid,
    _space_kind: DocSpaceKind,
    _external_id: &str,
  ) -> AuthResult<Option<Uuid>> {
    panic!("PanicDocStore: resolve_external_doc_id called — configure a real DocStore in this test")
  }

  async fn create_doc_metadata(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _title: String,
    _is_root: bool,
    _created_by: Uuid,
  ) -> AuthResult<Doc> {
    panic!("PanicDocStore: create_doc_metadata called — configure a real DocStore in this test")
  }
  async fn create_userspace_doc_metadata(&self, _owner_id: Uuid, _doc_id: Uuid, _title: String) -> AuthResult<Doc> {
    panic!("PanicDocStore: create_userspace_doc_metadata called — configure a real DocStore in this test")
  }
  async fn get_doc_metadata(&self, _doc_id: Uuid) -> AuthResult<Option<Doc>> {
    panic!("PanicDocStore: get_doc_metadata called — configure a real DocStore in this test")
  }
  async fn get_doc_metadata_batch(&self, _doc_ids: &[Uuid]) -> AuthResult<HashMap<Uuid, Doc>> {
    panic!("PanicDocStore: get_doc_metadata_batch requires a real store")
  }
  async fn get_doc_attribution(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<Option<DocAttribution>> {
    panic!("PanicDocStore: get_doc_attribution called — configure a real DocStore in this test")
  }
  async fn resolve_external_doc_ids(
    &self,
    _workspace_id: Uuid,
    _doc_ids: &[Uuid],
  ) -> AuthResult<HashMap<Uuid, String>> {
    panic!("PanicDocStore: resolve_external_doc_ids called — configure a real DocStore in this test")
  }
  async fn list_public_docs(&self, _workspace_id: Uuid) -> AuthResult<Vec<Doc>> {
    panic!("PanicDocStore: list_public_docs called — configure a real DocStore in this test")
  }
  async fn update_doc_default_role(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _role: DocDefaultRole,
    _actor_id: Uuid,
  ) -> AuthResult<Option<Doc>> {
    panic!("PanicDocStore: update_doc_default_role called — configure a real DocStore in this test")
  }
  async fn update_doc_public_mode(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _public_mode: Option<String>,
    _actor_id: Uuid,
  ) -> AuthResult<Option<Doc>> {
    panic!("PanicDocStore: update_doc_public_mode called — configure a real DocStore in this test")
  }
  async fn soft_delete_doc(&self, _doc_id: Uuid) -> AuthResult<()> {
    panic!("PanicDocStore: soft_delete_doc called — configure a real DocStore in this test")
  }
  async fn hard_delete_doc(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<()> {
    panic!("PanicDocStore: hard_delete_doc called — configure a real DocStore in this test")
  }
  async fn list_delete_candidates(
    &self,
    _workspace_id: Uuid,
    _external_ids: &[String],
  ) -> AuthResult<Vec<DocDeleteCandidate>> {
    panic!("PanicDocStore: list_delete_candidates called — configure a real DocStore in this test")
  }
  async fn list_trashed_delete_candidates(
    &self,
    _workspace_id: Uuid,
    _limit: i64,
  ) -> AuthResult<Vec<DocDeleteCandidate>> {
    panic!("PanicDocStore: list_trashed_delete_candidates called — configure a real DocStore in this test")
  }
  async fn hard_delete_doc_scoped(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<bool> {
    panic!("PanicDocStore: hard_delete_doc_scoped called — configure a real DocStore in this test")
  }
  async fn find_docs_without_title(&self, _workspace_id: Uuid, _limit: i64) -> AuthResult<Vec<Uuid>> {
    panic!("PanicDocStore: find_docs_without_title called — configure a real DocStore in this test")
  }
  async fn find_title_backfill_candidates(&self, _limit: i64) -> AuthResult<Vec<DocTitleBackfillCandidate>> {
    panic!("PanicDocStore: find_title_backfill_candidates called — configure a real DocStore in this test")
  }
  async fn list_docs_in_workspace(&self, _workspace_id: Uuid, _limit: i64, _offset: i64) -> AuthResult<Vec<Doc>> {
    panic!("PanicDocStore: list_docs_in_workspace called — configure a real DocStore in this test")
  }
  async fn list_content_docs_in_workspace(&self, _workspace_id: Uuid, _limit: i64) -> AuthResult<Vec<Doc>> {
    panic!("PanicDocStore: list_content_docs_in_workspace called — configure a real DocStore in this test")
  }
  async fn count_workspace_documents(&self, _workspace_id: Uuid) -> AuthResult<i64> {
    panic!("PanicDocStore: count_workspace_documents called — configure a real DocStore in this test")
  }
  async fn get_space_doc_timestamps(
    &self,
    _workspace_id: Uuid,
    _after: Option<i64>,
  ) -> AuthResult<HashMap<String, i64>> {
    panic!("PanicDocStore: get_space_doc_timestamps called — configure a real DocStore in this test")
  }
}

#[async_trait]
impl DocViewStore for PanicDocStore {
  async fn record_doc_view(
    &self,
    _workspace_id: Uuid,
    _doc_id: &str,
    _is_unique: bool,
    _is_guest: bool,
  ) -> AuthResult<()> {
    panic!("PanicDocStore: record_doc_view called — configure a real DocStore in this test")
  }
  async fn upsert_member_last_access(&self, _workspace_id: Uuid, _user_id: Uuid, _doc_id: &str) -> AuthResult<()> {
    panic!("PanicDocStore: upsert_member_last_access called — configure a real DocStore in this test")
  }
  async fn list_member_last_access(
    &self,
    _workspace_id: Uuid,
    _doc_id: &str,
    _query: Option<&str>,
    _limit: i64,
    _offset: i64,
  ) -> AuthResult<Vec<DocMemberLastAccess>> {
    panic!("PanicDocStore: list_member_last_access called — configure a real DocStore in this test")
  }
  async fn count_member_last_access(&self, _workspace_id: Uuid, _doc_id: &str) -> AuthResult<i64> {
    panic!("PanicDocStore: count_member_last_access called — configure a real DocStore in this test")
  }
  async fn list_doc_view_daily(
    &self,
    _workspace_id: Uuid,
    _doc_id: &str,
    _start: NaiveDate,
    _end: NaiveDate,
  ) -> AuthResult<Vec<DocViewDaily>> {
    panic!("PanicDocStore: list_doc_view_daily called — configure a real DocStore in this test")
  }
}

#[async_trait]
impl DocHistoryStore for PanicDocStore {
  async fn capture_history(
    &self,
    _: Uuid,
    _: Uuid,
    _: history::HistoryCaptureProvenance,
    _: Option<history::NamedHistoryCapture>,
  ) -> Result<history::HistoryCapture, history::HistoryCaptureError> {
    panic!("DocHistoryStore::capture_history must not be called");
  }
  async fn list_history_before(
    &self,
    _: Uuid,
    _: Uuid,
    _: Option<chrono::DateTime<chrono::Utc>>,
    _: Option<i64>,
    _: i64,
  ) -> AuthResult<Vec<DocHistoryMetadataEntry>> {
    panic!("PanicDocStore: configure real history storage")
  }
  async fn create_history_entry(&self, _doc_id: Uuid, _workspace_id: Uuid, _snapshot: Vec<u8>) -> AuthResult<i64> {
    panic!("PanicDocStore: create_history_entry called — configure a real DocStore in this test")
  }
  async fn list_history(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _skip: i64,
    _take: i64,
  ) -> AuthResult<Vec<DocHistoryMetadataEntry>> {
    panic!("PanicDocStore: list_history called — configure a real DocStore in this test")
  }
  async fn get_history_metadata(&self, _: Uuid, _: Uuid, _: i64) -> AuthResult<Option<DocHistoryMetadataEntry>> {
    panic!("history metadata storage is not configured");
  }
  async fn get_history_entry(&self, _history_id: i64) -> AuthResult<Option<DocHistoryEntry>> {
    panic!("PanicDocStore: get_history_entry called — configure a real DocStore in this test")
  }
  async fn find_history_at_or_before(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _timestamp: chrono::DateTime<chrono::Utc>,
  ) -> AuthResult<Option<DocHistoryEntry>> {
    panic!("PanicDocStore: find_history_at_or_before called — configure a real DocStore in this test")
  }
  async fn delete_history_entry(&self, _history_id: i64) -> AuthResult<bool> {
    panic!("PanicDocStore: delete_history_entry called — configure a real DocStore in this test")
  }
}

#[async_trait]
impl DocPermissionStore for PanicDocStore {
  async fn get_user_doc_role(&self, _user_id: Uuid, _doc_id: Uuid) -> AuthResult<Option<DocRole>> {
    panic!("PanicDocStore: get_user_doc_role called — configure a real DocStore in this test")
  }
  async fn upsert_user_doc_role(&self, _user_id: Uuid, _doc_id: Uuid, _role: DocRole) -> AuthResult<()> {
    panic!("PanicDocStore: upsert_user_doc_role called — configure a real DocStore in this test")
  }
  async fn delete_user_doc_role(&self, _user_id: Uuid, _doc_id: Uuid) -> AuthResult<()> {
    panic!("PanicDocStore: delete_user_doc_role called — configure a real DocStore in this test")
  }
  async fn bulk_upsert_user_doc_roles(
    &self,
    _user_ids: &[Uuid],
    _doc_id: Uuid,
    _role: DocRole,
    _actor: Option<Uuid>,
  ) -> AuthResult<()> {
    panic!("PanicDocStore: bulk_upsert_user_doc_roles called — configure a real DocStore in this test")
  }
  async fn bulk_delete_user_doc_roles(&self, _user_ids: &[Uuid], _doc_id: Uuid) -> AuthResult<()> {
    panic!("PanicDocStore: bulk_delete_user_doc_roles called — configure a real DocStore in this test")
  }
  async fn list_doc_permissions(&self, _doc_id: Uuid) -> AuthResult<Vec<(Uuid, DocRole)>> {
    panic!("PanicDocStore: list_doc_permissions called — configure a real DocStore in this test")
  }
  async fn list_granted_users(&self, _doc_id: Uuid) -> AuthResult<Vec<DocGrantedUser>> {
    panic!("PanicDocStore: list_granted_users called — configure a real DocStore in this test")
  }
}

/// Blanket impl — all methods live in the six sub-trait impls above.
impl DocStore for PanicDocStore {}

#[derive(Clone)]
pub struct DocService {
  store: std::sync::Arc<dyn DocStore>,
  /// P103-B-01: cache handle retained so facade methods (soft_delete_doc) can invalidate.
  doc_cache: Option<std::sync::Arc<dyn DocCachePort>>,
  /// P0-04: startup-resolved external client ingress policy.
  external_update_ingress_policy: ExternalUpdateIngressPolicy,
  /// P0-04: one bounded validator semaphore shared by all write builders.
  decoder_semaphore: Arc<tokio::sync::Semaphore>,
  /// P0-04: existing server-wide metrics service, shared with API state.
  metrics: Option<Arc<crate::metrics::MetricsService>>,
  /// P103-A-03: compaction threshold for regular docs (default: 500).
  compaction_threshold_default: usize,
  /// P103-A-03: compaction threshold for root docs (doc_id == workspace_id, default: 50).
  compaction_threshold_root_doc: usize,
  /// P102-SVC-01: document loading sub-service (snapshot + update merge).
  pub load: std::sync::Arc<DocLoadService>,
  /// P102-SVC-02: document update write sub-service.
  pub write: std::sync::Arc<DocWriteService>,
  /// P102-SVC-03: snapshot compaction sub-service (maybe_compact, merge_pending_updates).
  pub compaction: std::sync::Arc<DocCompactionService>,
  /// P102-SVC-04: history sub-service (capture, list, rollback).
  pub history: std::sync::Arc<DocHistoryService>,
  /// Canonical direct block mutation service shared by MCP and future server writers.
  pub content_mutation: std::sync::Arc<DocumentContentMutationService>,
  /// Atomic metadata/leaf/root lifecycle shared by all normal page writers.
  pub page_lifecycle: std::sync::Arc<PageLifecycleService>,
  /// Read-only projection audit and explicit repair for existing page drift.
  pub page_lifecycle_repair: std::sync::Arc<PageLifecycleRepairService>,
  document_graph_index_hook: Arc<RwLock<Option<Arc<dyn DocumentGraphIndexHook>>>>,
}

impl DocService {
  /// Requires source workspace access; reveals no destination identity or content.
  pub async fn is_page_moved(&self, workspace_id: Uuid, key: &DocumentKey) -> AuthResult<bool> {
    self.store.is_page_moved(workspace_id, key).await
  }
  pub async fn has_committed_transfer_from(&self, doc_id: Uuid, workspace_id: Uuid) -> AuthResult<bool> {
    self.store.has_committed_transfer_from(doc_id, workspace_id).await
  }
  /// The caller must authorize workspace access before exposing this decision.
  pub async fn is_page_permanently_deleted(&self, workspace_id: Uuid, key: &DocumentKey) -> AuthResult<bool> {
    self.store.is_page_permanently_deleted(workspace_id, key).await
  }

  pub async fn page_registration_state(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<Option<PageRegistrationState>> {
    self.store.page_registration_state(workspace_id, doc_id).await
  }
  pub fn new(store: std::sync::Arc<dyn DocStore>) -> Self {
    Self::new_with_decoder_concurrency(
      store,
      myoxus_contracts::effective_config::DEFAULT_DOC_DECODER_CONCURRENCY,
    )
    .expect("default document decoder capacity is valid")
  }

  /// Create one immutable gate shared by pulls, external writes and all builders.
  /// Changing persisted configuration takes effect when the process restarts.
  pub fn new_with_decoder_concurrency(
    store: Arc<dyn DocStore>,
    decoder_concurrency: usize,
  ) -> Result<Self, &'static str> {
    let compaction = std::sync::Arc::new(DocCompactionService::new(store.clone()));
    let external_update_ingress_policy =
      ExternalUpdateIngressPolicy::new(write::DEFAULT_EXTERNAL_UPDATE_MAX_BYTES, decoder_concurrency)?;
    let decoder_semaphore = Arc::new(tokio::sync::Semaphore::new(
      external_update_ingress_policy.validation_permits,
    ));
    let load = std::sync::Arc::new(DocLoadService::new_with_decoder_gate(
      store.clone(),
      decoder_semaphore.clone(),
    ));
    let write = std::sync::Arc::new(DocWriteService::new_with_external_ingress(
      store.clone(),
      compaction.clone(),
      external_update_ingress_policy.clone(),
      decoder_semaphore.clone(),
    ));
    let history = std::sync::Arc::new(DocHistoryService::new(store.clone(), load.clone()));
    let content_mutation = std::sync::Arc::new(DocumentContentMutationService::new(store.clone(), compaction.clone()));
    let page_lifecycle = std::sync::Arc::new(PageLifecycleService::new(store.clone()));
    let page_lifecycle_repair = std::sync::Arc::new(PageLifecycleRepairService::new_with_load(
      store.clone(),
      load.clone(),
      external_update_ingress_policy.max_update_bytes,
    ));
    Ok(Self {
      store,
      doc_cache: None,
      external_update_ingress_policy,
      decoder_semaphore,
      metrics: None,
      compaction_threshold_default: 500,
      compaction_threshold_root_doc: 50,
      load,
      write,
      compaction,
      history,
      content_mutation,
      page_lifecycle,
      page_lifecycle_repair,
      document_graph_index_hook: Arc::new(RwLock::new(None)),
    })
  }

  /// P103-A-03: Override compaction thresholds (typically from config).
  ///
  /// Must be called before `with_doc_cache`. Rebuilds the compaction sub-service
  /// so the new thresholds take effect.
  pub fn with_compaction_thresholds(mut self, threshold_default: usize, threshold_root_doc: usize) -> Self {
    self.compaction_threshold_default = threshold_default;
    self.compaction_threshold_root_doc = threshold_root_doc;
    let compaction = std::sync::Arc::new(
      DocCompactionService::new(self.store.clone()).with_thresholds(threshold_default, threshold_root_doc),
    );
    let write = self.build_write_service(compaction.clone());
    self.compaction = compaction;
    self.write = write;
    self.content_mutation = std::sync::Arc::new(DocumentContentMutationService::new(
      self.store.clone(),
      self.compaction.clone(),
    ));
    self.page_lifecycle = self.build_page_lifecycle_service();
    self.page_lifecycle_repair = self.build_page_lifecycle_repair_service();
    self
  }

  /// Apply the startup-validated decoded-byte limit without replacing the
  /// shared semaphore or any other ingress policy field.
  pub fn with_external_update_ingress_max_bytes(mut self, max_update_bytes: usize) -> Self {
    self.external_update_ingress_policy.max_update_bytes = max_update_bytes;
    self.write = self.build_write_service(self.compaction.clone());
    self.page_lifecycle_repair = self.build_page_lifecycle_repair_service();
    self
  }

  /// The configured snapshot ingress limit also applies to template and DOCX
  /// page creation; check it before writing assets that would be left unused.
  pub fn snapshot_ingress_max_bytes(&self) -> usize {
    self.external_update_ingress_policy.max_update_bytes
  }

  /// Attach the existing server-wide metrics service to external ingress
  /// rejection accounting. No feature-local recorder is created.
  pub fn with_metrics_service(mut self, metrics: Arc<crate::metrics::MetricsService>) -> Self {
    self.metrics = Some(metrics);
    self.write = self.build_write_service(self.compaction.clone());
    self.page_lifecycle = self.build_page_lifecycle_service();
    self.page_lifecycle_repair = self.build_page_lifecycle_repair_service();
    self
  }

  fn build_write_service(&self, compaction: Arc<DocCompactionService>) -> Arc<DocWriteService> {
    let mut write = DocWriteService::new_with_external_ingress(
      self.store.clone(),
      compaction,
      self.external_update_ingress_policy.clone(),
      self.decoder_semaphore.clone(),
    );
    if let Some(cache) = &self.doc_cache {
      write = write.with_doc_cache(cache.clone());
    }
    if let Some(metrics) = &self.metrics {
      write = write.with_metrics_service(metrics.clone());
    }
    Arc::new(write)
  }

  fn build_page_lifecycle_service(&self) -> Arc<PageLifecycleService> {
    let mut lifecycle = PageLifecycleService::new(self.store.clone());
    if let Some(cache) = &self.doc_cache {
      lifecycle = lifecycle.with_doc_cache(cache.clone());
    }
    if let Some(metrics) = &self.metrics {
      lifecycle = lifecycle.with_metrics_service(metrics.clone());
    }
    Arc::new(lifecycle)
  }

  fn build_page_lifecycle_repair_service(&self) -> Arc<PageLifecycleRepairService> {
    let mut repair = PageLifecycleRepairService::new_with_load(
      self.store.clone(),
      self.load.clone(),
      self.external_update_ingress_policy.max_update_bytes,
    );
    if let Some(metrics) = &self.metrics {
      repair = repair.with_metrics_service(metrics.clone());
    }
    Arc::new(repair)
  }

  /// Wire a [`DocCachePort`] into all sub-services that benefit from caching.
  ///
  /// Must be called after `new()` and `with_compaction_thresholds()`. The cache is
  /// shared (clone of `Arc`) across all sub-services.
  pub fn with_doc_cache(self, cache: std::sync::Arc<dyn DocCachePort>) -> Self {
    let mut this = self;
    let load = std::sync::Arc::new(
      DocLoadService::new_with_decoder_gate(this.store.clone(), this.decoder_semaphore.clone())
        .with_doc_cache(cache.clone()),
    );
    let compaction = std::sync::Arc::new(
      DocCompactionService::new(this.store.clone())
        .with_doc_cache(cache.clone())
        .with_thresholds(this.compaction_threshold_default, this.compaction_threshold_root_doc),
    );
    this.doc_cache = Some(cache.clone());
    let write = this.build_write_service(compaction.clone());
    let history = std::sync::Arc::new(DocHistoryService::new(this.store.clone(), load.clone()));
    let content_mutation = std::sync::Arc::new(
      DocumentContentMutationService::new(this.store.clone(), compaction.clone()).with_doc_cache(cache.clone()),
    );
    let page_lifecycle = this.build_page_lifecycle_service();
    let mut page_lifecycle_repair = PageLifecycleRepairService::new_with_load(
      this.store.clone(),
      load.clone(),
      this.external_update_ingress_policy.max_update_bytes,
    );
    if let Some(metrics) = &this.metrics {
      page_lifecycle_repair = page_lifecycle_repair.with_metrics_service(metrics.clone());
    }
    let page_lifecycle_repair = Arc::new(page_lifecycle_repair);
    Self {
      store: this.store,
      doc_cache: this.doc_cache,
      external_update_ingress_policy: this.external_update_ingress_policy,
      decoder_semaphore: this.decoder_semaphore,
      metrics: this.metrics,
      compaction_threshold_default: this.compaction_threshold_default,
      compaction_threshold_root_doc: this.compaction_threshold_root_doc,
      load,
      write,
      compaction,
      history,
      content_mutation,
      page_lifecycle,
      page_lifecycle_repair,
      document_graph_index_hook: this.document_graph_index_hook,
    }
  }

  /// Attach the server-authoritative Document Graph index hook.
  ///
  /// The hook is set after API wiring has built `DocumentGraphService`, because
  /// that service itself needs `DocService` for full Yjs loads. Clones of
  /// `DocService` share this mutable slot.
  pub async fn set_document_graph_index_hook(&self, hook: Arc<dyn DocumentGraphIndexHook>) {
    *self.document_graph_index_hook.write().await = Some(hook);
  }

  /// Apply one semantic content mutation through the normal document-write
  /// facade and enqueue the derived Document Graph projection afterwards.
  #[instrument(skip(self, mutation), fields(%workspace_id, %doc_id, operation = mutation.name()))]
  pub async fn mutate_content(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_user_id: Option<Uuid>,
    mutation: DocumentMutation,
    confirm_replace_all: bool,
    expected_sequence: Option<i64>,
  ) -> AuthResult<DocContentMutationCommit> {
    let committed = self
      .content_mutation
      .mutate(
        workspace_id,
        doc_id,
        actor_user_id,
        mutation,
        confirm_replace_all,
        expected_sequence,
      )
      .await?;
    self
      .notify_document_graph_reindex(workspace_id, doc_id, true, DocumentGraphReindexReason::DocUpdated)
      .await;
    Ok(committed)
  }

  /// Access the underlying store for direct analytics writes (P73-C).
  pub fn store(&self) -> &dyn DocStore {
    &*self.store
  }

  /// Expose the doc cache handle so admin mutations can flush it (P103-B-04).
  pub fn doc_cache(&self) -> Option<&std::sync::Arc<dyn DocCachePort>> {
    self.doc_cache.as_ref()
  }

  /// Load a document as a complete Yjs binary state.
  /// Delegate to [`DocLoadService::load_full_doc`].
  #[instrument(skip(self))]
  pub async fn load_full_doc(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Vec<u8>> {
    self.load.load_full_doc(workspace_id, doc_id).await
  }

  /// Read authoritative content for revision-fenced operations from the
  /// repository's coherent snapshot/tail stream, never separate legacy reads.
  #[instrument(skip(self))]
  pub async fn load_full_doc_consistent(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Vec<u8>> {
    Ok(
      self
        .load
        .load_full_doc_with_revision(workspace_id, doc_id)
        .await?
        .payload,
    )
  }

  /// Load a document and return metadata alongside the merged payload.
  /// Delegate to [`DocLoadService::load_full_doc_with_meta`].
  #[instrument(skip(self))]
  pub async fn load_full_doc_with_meta(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<DocLoadResult> {
    self.load.load_full_doc_with_meta(workspace_id, doc_id).await
  }

  /// Delegate to [`DocWriteService::push_update`] and synchronize root-document
  /// CRDT metadata to the database projection.
  ///
  /// Root metadata synchronization is non-fatal: failures are logged while the
  /// persisted update remains successful.
  #[instrument(skip(self, payload))]
  pub async fn push_update(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    payload: Vec<u8>,
    sequence: i64,
    space_kind: DocSpaceKind,
  ) -> AuthResult<()> {
    self
      .push_internal_update_with_context(
        workspace_id,
        doc_id,
        payload,
        sequence,
        space_kind,
        None,
        None,
        None,
        None,
      )
      .await
      .map(|_| ())
  }

  /// Persist a server-authored update when the caller already owns the
  /// authorized internal `docs.id`. External API input must never call this
  /// path; it uses [`Self::push_external_update_with_context`].
  #[allow(clippy::too_many_arguments)]
  #[instrument(skip(self, payload, initial_provenance))]
  pub async fn push_internal_update_with_context(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    payload: Vec<u8>,
    sequence: i64,
    space_kind: DocSpaceKind,
    actor_user_id: Option<Uuid>,
    client_format: Option<String>,
    client_capabilities: Option<String>,
    initial_provenance: Option<InitialDocumentProvenance>,
  ) -> AuthResult<Uuid> {
    let is_workspace_space = matches!(space_kind, DocSpaceKind::Workspace);
    let persistence = self
      .write
      .push_internal_update_with_context(
        workspace_id,
        doc_id,
        payload,
        sequence,
        space_kind,
        actor_user_id,
        client_format,
        client_capabilities,
        initial_provenance,
      )
      .await?;
    Ok(
      self
        .finish_persisted_update(workspace_id, is_workspace_space, persistence)
        .await
        .doc_id,
    )
  }

  #[allow(clippy::too_many_arguments)]
  #[instrument(skip(self, payload, initial_provenance))]
  pub async fn push_external_update_with_context(
    &self,
    sync_operation_id: Uuid,
    connection_context: Option<DocSyncConnectionContext>,
    workspace_id: Uuid,
    document_key: DocumentKey,
    payload: Vec<u8>,
    sequence: i64,
    space_kind: DocSpaceKind,
    actor_user_id: Option<Uuid>,
    client_format: Option<String>,
    client_capabilities: Option<String>,
    initial_provenance: Option<InitialDocumentProvenance>,
  ) -> AuthResult<DocUpdatePersistenceResult> {
    let is_workspace_space = matches!(space_kind, DocSpaceKind::Workspace);
    let persistence = self
      .write
      .push_external_update_with_context(
        sync_operation_id,
        connection_context,
        workspace_id,
        document_key,
        payload,
        sequence,
        space_kind,
        actor_user_id,
        client_format,
        client_capabilities,
        initial_provenance,
      )
      .await?;
    Ok(
      self
        .finish_persisted_update(workspace_id, is_workspace_space, persistence)
        .await,
    )
  }

  async fn finish_persisted_update(
    &self,
    workspace_id: Uuid,
    is_workspace_space: bool,
    persistence: DocUpdatePersistenceResult,
  ) -> DocUpdatePersistenceResult {
    let doc_id = persistence.doc_id;

    if !persistence.outcome.is_persisted() {
      return persistence;
    }

    self
      .notify_document_graph_reindex(
        workspace_id,
        doc_id,
        is_workspace_space,
        DocumentGraphReindexReason::DocUpdated,
      )
      .await;

    persistence
  }

  /// Create a normal workspace page through the atomic page lifecycle.
  #[instrument(skip(self))]
  pub async fn create_page(&self, workspace_id: Uuid, created_by: Uuid, title: Option<String>) -> AuthResult<Doc> {
    let (doc, _) = self
      .create_page_with_sync_updates(workspace_id, created_by, title)
      .await?;
    Ok(doc)
  }

  /// Create a normal page and return its exact persisted leaf/root deltas.
  #[instrument(skip(self, title))]
  pub async fn create_page_with_sync_updates(
    &self,
    workspace_id: Uuid,
    created_by: Uuid,
    title: Option<String>,
  ) -> AuthResult<(Doc, CreatedPageSyncUpdates)> {
    let committed = self
      .page_lifecycle
      .create(workspace_id, created_by, title, None)
      .await?;
    let leaf = committed
      .leaf
      .as_ref()
      .ok_or_else(|| AuthError::Storage("created page commit omitted its leaf delta".to_string()))?;
    let sync_updates = CreatedPageSyncUpdates {
      document: leaf.delta.clone(),
      document_sequence: leaf.sequence,
      workspace_root: committed.workspace_root.delta.clone(),
      workspace_root_sequence: committed.workspace_root.sequence,
    };
    let doc = committed.document;
    self
      .notify_document_graph_reindex(workspace_id, doc.id, true, DocumentGraphReindexReason::DocUpdated)
      .await;
    Ok((doc, sync_updates))
  }

  /// Admit an explicit complete content capture, not an incremental sync update.
  /// Normalization uses only that capture and retains the existing wire bounds.
  #[instrument(skip_all)]
  pub(crate) async fn prepare_captured_document_fields(
    &self,
    snapshot: Vec<u8>,
  ) -> AuthResult<yjs::document_field::content::FieldContentUpdate> {
    let (snapshot, _) = self.write.validate_snapshot_ingress(snapshot).await?;
    let mut normalized = crate::document_fields::normalize_snapshot(&snapshot)?;
    if normalized.delta.is_some() {
      normalized.state = self.write.validate_snapshot_ingress(normalized.state).await?.0;
    }
    Ok(normalized)
  }

  /// A complete snapshot used to create a new editable document is a copy,
  /// not an archive read. Rebind field identities and reactivate captured text
  /// only here; generic capture admission and synchronization remain unchanged.
  #[instrument(skip_all)]
  pub(crate) async fn prepare_editable_document_copy(&self, snapshot: Vec<u8>) -> AuthResult<Vec<u8>> {
    let normalized = self.prepare_captured_document_fields(snapshot).await?;
    let copy = yjs::document_field::content::copy_for_editable_document(&normalized.state)
      .map_err(|_| AuthError::InvalidInput("MIX_DOCUMENT_FIELD_INVALID".into()))?;
    if copy.delta.is_some() {
      return self
        .write
        .validate_snapshot_ingress(copy.state)
        .await
        .map(|(snapshot, _)| snapshot);
    }
    Ok(copy.state)
  }

  /// Create a normal workspace page whose initial leaf state is a trusted,
  /// complete Yjs snapshot, returning the exact committed sync deltas.
  ///
  /// Template application uses this path so content, SQL metadata and root
  /// discovery are one lifecycle commit rather than two competing page roots.
  #[instrument(skip(self, title, source_snapshot))]
  pub async fn create_page_from_snapshot_with_sync_updates(
    &self,
    workspace_id: Uuid,
    created_by: Uuid,
    title: Option<String>,
    source_snapshot: Vec<u8>,
  ) -> AuthResult<(Doc, CreatedPageSyncUpdates)> {
    self
      .create_page_from_snapshot_with_purpose(workspace_id, created_by, title, source_snapshot, None)
      .await
  }

  /// Registry materialization supplies its purpose to the atomic leaf/root commit.
  #[instrument(skip(self, title, source_snapshot))]
  pub(crate) async fn create_page_from_snapshot_with_purpose(
    &self,
    workspace_id: Uuid,
    created_by: Uuid,
    title: Option<String>,
    source_snapshot: Vec<u8>,
    source_purpose: Option<crate::template_registry::bundle::TemplatePurpose>,
  ) -> AuthResult<(Doc, CreatedPageSyncUpdates)> {
    self
      .create_page_from_snapshot_at(
        workspace_id,
        created_by,
        title,
        source_snapshot,
        source_purpose,
        chrono::Utc::now(),
      )
      .await
  }

  /// Publish already prepared content with the same authoritative creation time
  /// used for its point-in-time substitutions. There is no provisional source leaf.
  #[instrument(skip_all)]
  pub(crate) async fn create_page_from_snapshot_at(
    &self,
    workspace_id: Uuid,
    created_by: Uuid,
    title: Option<String>,
    source_snapshot: Vec<u8>,
    source_purpose: Option<crate::template_registry::bundle::TemplatePurpose>,
    committed_at: chrono::DateTime<chrono::Utc>,
  ) -> AuthResult<(Doc, CreatedPageSyncUpdates)> {
    let source_snapshot = self.prepare_editable_document_copy(source_snapshot).await?;
    let committed = self
      .page_lifecycle
      .create_from_snapshot(
        workspace_id,
        created_by,
        title,
        source_snapshot,
        source_purpose,
        committed_at,
      )
      .await?;
    let leaf = committed
      .leaf
      .as_ref()
      .ok_or_else(|| AuthError::Storage("created page commit omitted its leaf delta".to_string()))?;
    let sync_updates = CreatedPageSyncUpdates {
      document: leaf.delta.clone(),
      document_sequence: leaf.sequence,
      workspace_root: committed.workspace_root.delta.clone(),
      workspace_root_sequence: committed.workspace_root.sequence,
    };
    let doc = committed.document;
    self
      .notify_document_graph_reindex(workspace_id, doc.id, true, DocumentGraphReindexReason::DocUpdated)
      .await;
    Ok((doc, sync_updates))
  }

  /// Reserved setup copies use the same validated page lifecycle and native
  /// document-graph notification as ordinary template-created pages. Search
  /// refresh intent is persisted by the common lifecycle transaction.
  pub(crate) async fn create_project_page_from_snapshot(
    &self,
    workspace: Uuid,
    actor: Uuid,
    reserved: Uuid,
    title: String,
    snapshot: Vec<u8>,
    committed_at: chrono::DateTime<chrono::Utc>,
    ack: crate::workspace::ProjectDocumentAck,
  ) -> AuthResult<PageLifecycleCommit> {
    let snapshot = self.prepare_editable_document_copy(snapshot).await?;
    let commit = self
      .page_lifecycle
      .create_project_from_snapshot(workspace, actor, reserved, title, snapshot, committed_at, ack)
      .await?;
    self
      .notify_document_graph_reindex(
        workspace,
        commit.document.id,
        true,
        DocumentGraphReindexReason::DocUpdated,
      )
      .await;
    Ok(commit)
  }

  #[tracing::instrument(skip_all)]
  pub(crate) async fn create_automation_page(
    &self,
    workspace: Uuid,
    actor: Uuid,
    reserved: Uuid,
    title: String,
    content: Option<AutomationPageContent>,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> AuthResult<Doc> {
    let content = if let Some(mut content) = content {
      content.initial_leaf_update = self.prepare_editable_document_copy(content.initial_leaf_update).await?;
      Some(content)
    } else {
      None
    };
    match self
      .page_lifecycle
      .create_automation(workspace, actor, reserved, title, content, fence)
      .await?
    {
      AutomationPageLifecycleResult::Committed(commit) => {
        self
          .notify_document_graph_reindex(
            workspace,
            commit.document.id,
            true,
            DocumentGraphReindexReason::DocUpdated,
          )
          .await;
        Ok(commit.document)
      }
      AutomationPageLifecycleResult::Replay(doc) => Ok(doc),
    }
  }

  /// Create a page with optional typed initial content in the same commit.
  #[instrument(skip(self, title, initial_content), fields(%workspace_id, %created_by))]
  pub async fn create_page_lifecycle(
    &self,
    workspace_id: Uuid,
    created_by: Uuid,
    title: Option<String>,
    initial_content: Option<DocumentFragment>,
  ) -> AuthResult<PageLifecycleCommit> {
    let committed = self
      .page_lifecycle
      .create(workspace_id, created_by, title, initial_content)
      .await?;
    self
      .notify_document_graph_reindex(
        workspace_id,
        committed.document.id,
        true,
        DocumentGraphReindexReason::DocUpdated,
      )
      .await;
    Ok(committed)
  }

  #[instrument(skip(self, title), fields(%workspace_id, %doc_id, %actor_user_id))]
  pub async fn rename_page(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_user_id: Uuid,
    title: String,
    expected_sequence: Option<i64>,
  ) -> AuthResult<PageLifecycleCommit> {
    let committed = self
      .page_lifecycle
      .rename(workspace_id, doc_id, actor_user_id, title, expected_sequence)
      .await?;
    self
      .notify_document_graph_reindex(workspace_id, doc_id, true, DocumentGraphReindexReason::DocUpdated)
      .await;
    Ok(committed)
  }

  #[instrument(skip(self), fields(%workspace_id, %doc_id, %actor_user_id))]
  pub async fn trash_page(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_user_id: Uuid,
  ) -> AuthResult<PageLifecycleCommit> {
    let refreshes = self
      .database_reference_refreshes_before_delete(workspace_id, doc_id)
      .await;
    let committed = self.page_lifecycle.trash(workspace_id, doc_id, actor_user_id).await?;
    self.notify_document_graph_deleted(workspace_id, doc_id).await;
    self
      .enqueue_database_reference_refreshes(workspace_id, doc_id, refreshes)
      .await;
    Ok(committed)
  }

  #[instrument(skip(self), fields(%workspace_id, %doc_id, %actor_user_id))]
  pub async fn restore_page(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_user_id: Uuid,
  ) -> AuthResult<PageLifecycleCommit> {
    let committed = self.page_lifecycle.restore(workspace_id, doc_id, actor_user_id).await?;
    self
      .notify_document_graph_reindex(workspace_id, doc_id, true, DocumentGraphReindexReason::DocUpdated)
      .await;
    Ok(committed)
  }

  #[instrument(skip(self))]
  pub async fn get_metadata(&self, doc_id: Uuid) -> AuthResult<Option<Doc>> {
    self.store.get_doc_metadata(doc_id).await
  }

  /// Batch current metadata for permission-safe feed projection.
  #[instrument(skip_all)]
  pub async fn get_metadata_batch(&self, doc_ids: &[Uuid]) -> AuthResult<HashMap<Uuid, Doc>> {
    if doc_ids.is_empty() {
      return Ok(HashMap::new());
    }
    self.store.get_doc_metadata_batch(doc_ids).await
  }

  /// Load metadata for lifecycle authorization, including soft-deleted rows.
  ///
  /// This must not be used as a general document read: the shared API guard
  /// calls it only for actions that operate on the trash lifecycle.
  #[instrument(skip(self))]
  pub async fn get_metadata_including_deleted(&self, doc_id: Uuid) -> AuthResult<Option<Doc>> {
    self.store.get_doc_metadata_including_deleted(doc_id).await
  }

  /// Resolve a client-visible key inside one authorized space.
  #[instrument(skip(self), fields(external_id = %document_key))]
  pub async fn resolve_document_key(
    &self,
    space_id: Uuid,
    space_kind: DocSpaceKind,
    document_key: &DocumentKey,
  ) -> AuthResult<Option<Uuid>> {
    self
      .store
      .resolve_external_doc_id(space_id, space_kind, document_key.as_str())
      .await
  }

  /// Creates a document in a private userspace.
  #[instrument(skip(self))]
  pub async fn create_userspace_doc(&self, owner_id: Uuid, title: Option<String>) -> AuthResult<Doc> {
    let doc_id = Uuid::new_v4();
    let title_str = title.unwrap_or_else(|| "Private Note".to_string());
    info!(%owner_id, %doc_id, "creating userspace document");
    self
      .store
      .create_userspace_doc_metadata(owner_id, doc_id, title_str)
      .await
  }

  #[instrument(skip(self))]
  pub async fn soft_delete_doc(&self, doc_id: Uuid) -> AuthResult<()> {
    let workspace_id = self
      .store
      .get_doc_metadata(doc_id)
      .await?
      .and_then(|doc| doc.workspace_id);
    let database_reference_refreshes = if let Some(workspace_id) = workspace_id {
      self
        .database_reference_refreshes_before_delete(workspace_id, doc_id)
        .await
    } else {
      Vec::new()
    };
    self.store.soft_delete_doc(doc_id).await?;
    // P103-B-01: invalidate metadata cache immediately so next load sees exists=false.
    // Without this, a cached entry would serve the old exists=true state until TTL expires.
    if let Some(cache) = &self.doc_cache {
      cache.invalidate_metadata(doc_id).await;
      trace!(%doc_id, "metadata cache invalidated after soft_delete_doc");
    }
    if let Some(workspace_id) = workspace_id {
      self.notify_document_graph_deleted(workspace_id, doc_id).await;
      self
        .enqueue_database_reference_refreshes(workspace_id, doc_id, database_reference_refreshes)
        .await;
    }
    Ok(())
  }

  /// Grants or updates a user's role on a document.
  #[instrument(skip(self))]
  pub async fn grant_doc_permission(&self, doc_id: Uuid, user_id: Uuid, role: DocRole) -> AuthResult<()> {
    info!(%doc_id, %user_id, ?role, "granting doc permission");
    self.store.upsert_user_doc_role(user_id, doc_id, role).await
  }

  /// Revokes a user's role on a document.
  #[instrument(skip(self))]
  pub async fn revoke_doc_permission(&self, doc_id: Uuid, user_id: Uuid) -> AuthResult<()> {
    info!(%doc_id, %user_id, "revoking doc permission");
    self.store.delete_user_doc_role(user_id, doc_id).await
  }

  /// Batch-grant a role to multiple users on a single document.
  #[instrument(skip(self))]
  pub async fn bulk_grant_doc_permission(
    &self,
    doc_id: Uuid,
    user_ids: &[Uuid],
    role: DocRole,
    actor: Uuid,
  ) -> AuthResult<()> {
    info!(%doc_id, count = user_ids.len(), ?role, "bulk granting doc permissions");
    self
      .store
      .bulk_upsert_user_doc_roles(user_ids, doc_id, role, Some(actor))
      .await
  }

  /// Batch-revoke roles from multiple users on a single document.
  #[instrument(skip(self))]
  pub async fn bulk_revoke_doc_permission(&self, doc_id: Uuid, user_ids: &[Uuid]) -> AuthResult<()> {
    info!(%doc_id, count = user_ids.len(), "bulk revoking doc permissions");
    self.store.bulk_delete_user_doc_roles(user_ids, doc_id).await
  }

  /// Lists all explicit permissions for a document.
  #[instrument(skip(self))]
  pub async fn list_doc_permissions(&self, doc_id: Uuid) -> AuthResult<Vec<(Uuid, DocRole)>> {
    self.store.list_doc_permissions(doc_id).await
  }

  /// Return explicit document grants enriched with user profile fields.
  pub async fn list_granted_users(&self, doc_id: Uuid) -> AuthResult<Vec<DocGrantedUser>> {
    self.store.list_granted_users(doc_id).await
  }

  /// Return a page of active members whose latest access was to the document.
  pub async fn list_member_last_access(
    &self,
    workspace_id: Uuid,
    doc_id: &str,
    query: Option<&str>,
    limit: i64,
    offset: i64,
  ) -> AuthResult<Vec<DocMemberLastAccess>> {
    self
      .store
      .list_member_last_access(workspace_id, doc_id, query, limit, offset)
      .await
  }

  /// Count active members whose latest access was to the document.
  pub async fn count_member_last_access(&self, workspace_id: Uuid, doc_id: &str) -> AuthResult<i64> {
    self.store.count_member_last_access(workspace_id, doc_id).await
  }

  /// Return zero-filled daily view buckets for an inclusive date range.
  pub async fn list_doc_view_daily(
    &self,
    workspace_id: Uuid,
    doc_id: &str,
    start: chrono::NaiveDate,
    end: chrono::NaiveDate,
  ) -> AuthResult<Vec<DocViewDaily>> {
    self.store.list_doc_view_daily(workspace_id, doc_id, start, end).await
  }

  pub async fn analytics_window(&self) -> AuthResult<Option<traits::DocViewAnalyticsWindow>> {
    self.store.analytics_window().await
  }

  /// Delegate to [`DocHistoryService::capture_history_snapshot`].
  #[instrument(skip(self))]
  pub async fn capture_history_snapshot(&self, doc_id: Uuid) -> AuthResult<i64> {
    self.history.capture_history_snapshot(doc_id).await
  }

  /// Delegate to [`DocHistoryService::list_history`].
  #[instrument(skip(self))]
  pub async fn list_history(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<DocHistoryMetadataEntry>> {
    self.history.list_history(workspace_id, doc_id, skip, take).await
  }

  /// Return one immutable history snapshot for a trusted internal consumer.
  /// Callers must still validate the workspace/document tuple before use.
  pub async fn history_entry(&self, history_id: i64) -> AuthResult<Option<DocHistoryEntry>> {
    self.store.get_history_entry(history_id).await
  }

  pub async fn history_page(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    before: Option<chrono::DateTime<chrono::Utc>>,
    before_id: Option<i64>,
    take: i64,
    named_only: bool,
  ) -> AuthResult<Vec<DocHistoryMetadataEntry>> {
    self
      .store
      .list_history_before_filtered(workspace_id, doc_id, before, before_id, take, named_only)
      .await
  }

  /// Resolve an exact capture independently of the currently loaded pages.
  pub async fn history_metadata(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    history_id: i64,
  ) -> AuthResult<Option<DocHistoryMetadataEntry>> {
    self.store.get_history_metadata(workspace_id, doc_id, history_id).await
  }

  /// Compare a selected capture with the current persisted head without writing.
  pub async fn history_diff(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    history_id: i64,
  ) -> AuthResult<history::DocHistoryComparison> {
    self
      .history_diff_with_fields(workspace_id, doc_id, history_id, None, None)
      .await
  }

  /// The transport authorizes this document before supplying its current field
  /// resolver and actor. Field-free callers need neither metadata nor identity.
  pub async fn history_diff_with_fields(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    history_id: i64,
    field_resolver: Option<&crate::document_fields::context::DocumentFieldResolver>,
    actor_id: Option<Uuid>,
  ) -> AuthResult<history::DocHistoryComparison> {
    self
      .history
      .compare_current(
        workspace_id,
        doc_id,
        history_id,
        self.external_update_ingress_policy.max_update_bytes,
        field_resolver,
        actor_id,
      )
      .await
  }

  /// Delegate to [`DocHistoryService::rollback_to_history`].
  #[instrument(skip(self))]
  pub async fn rollback_to_history(&self, doc_id: Uuid, history_id: i64) -> AuthResult<bool> {
    self.history.rollback_to_history(doc_id, history_id).await
  }

  /// Find the newest history entry at or before a timestamp.
  pub async fn history_at_or_before(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    timestamp: chrono::DateTime<chrono::Utc>,
  ) -> AuthResult<Option<DocHistoryEntry>> {
    self
      .store
      .find_history_at_or_before(workspace_id, doc_id, timestamp)
      .await
  }

  /// Remove a captured history row after its owning compound operation fails.
  pub async fn delete_history_entry(&self, history_id: i64) -> AuthResult<bool> {
    self.store.delete_history_entry(history_id).await
  }

  /// Update the default role of one active workspace document.
  pub async fn update_default_role(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    role: myoxus_domain::entities::DocDefaultRole,
    actor_id: Uuid,
  ) -> AuthResult<Option<Doc>> {
    self
      .store
      .update_doc_default_role(workspace_id, doc_id, role, actor_id)
      .await
  }

  /// Update the public mode of one active workspace document.
  pub async fn update_public_mode(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    public_mode: Option<String>,
    actor_id: Uuid,
  ) -> AuthResult<Option<Doc>> {
    self
      .store
      .update_doc_public_mode(workspace_id, doc_id, public_mode, actor_id)
      .await
  }

  #[instrument(skip(self))]
  pub async fn get_space_doc_timestamps(
    &self,
    workspace_id: Uuid,
    after: Option<i64>,
  ) -> AuthResult<HashMap<String, i64>> {
    // P103-A-02: timestamps cache-first. Cache holds the full map; filter by `after` in-memory.
    if let Some(cache) = &self.doc_cache {
      if let Some(cached) = cache.get_timestamps(workspace_id).await {
        trace!(%workspace_id, "timestamps cache HIT");
        return Ok(if let Some(after_ms) = after {
          cached.into_iter().filter(|(_, ts)| *ts > after_ms).collect()
        } else {
          cached
        });
      }
      trace!(%workspace_id, "timestamps cache MISS — querying DB");
      let all = self.store.get_space_doc_timestamps(workspace_id, None).await?;
      cache.set_timestamps(workspace_id, &all).await;
      return Ok(if let Some(after_ms) = after {
        all.into_iter().filter(|(_, ts)| *ts > after_ms).collect()
      } else {
        all
      });
    }
    self.store.get_space_doc_timestamps(workspace_id, after).await
  }

  /// Count pending updates across all documents (for monitoring).
  #[instrument(skip(self))]
  pub async fn count_all_pending_updates(&self) -> AuthResult<i64> {
    self.store.count_all_pending_updates().await
  }

  /// List docs without titles in a workspace.
  #[instrument(skip(self))]
  pub async fn find_docs_without_title(&self, workspace_id: Uuid, limit: i64) -> AuthResult<Vec<Uuid>> {
    self.store.find_docs_without_title(workspace_id, limit).await
  }

  /// List the globally bounded set of ordinary documents whose pending Yjs
  /// updates may repair an absent title.
  #[instrument(skip(self))]
  pub async fn find_title_backfill_candidates(&self, limit: i64) -> AuthResult<Vec<DocTitleBackfillCandidate>> {
    self.store.find_title_backfill_candidates(limit).await
  }

  // ─── MCP helpers ────────────────────────────────────────────────────────────

  /// Fetch document metadata by ID (delegates to the store).
  #[instrument(skip(self))]
  pub async fn get_doc_metadata(&self, doc_id: Uuid) -> AuthResult<Option<Doc>> {
    self.store.get_doc_metadata(doc_id).await
  }

  /// Fetch document metadata together with creator/updater profiles.
  pub async fn get_doc_attribution(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Option<DocAttribution>> {
    self.store.get_doc_attribution(workspace_id, doc_id).await
  }

  /// Resolve client-visible keys for normalized document IDs.
  pub async fn resolve_external_doc_ids(
    &self,
    workspace_id: Uuid,
    doc_ids: &[Uuid],
  ) -> AuthResult<HashMap<Uuid, String>> {
    self.store.resolve_external_doc_ids(workspace_id, doc_ids).await
  }

  /// List active, unblocked public documents by latest update.
  pub async fn list_public_docs(&self, workspace_id: Uuid) -> AuthResult<Vec<Doc>> {
    self.store.list_public_docs(workspace_id).await
  }

  /// Fetch the current merged snapshot for a document.
  ///
  /// This is the MCP-facing convenience path. It must use the same
  /// snapshot-aware sequence contract as `load_full_doc_with_meta`: compacted
  /// `doc_snapshots` are only a base state, and every `doc_updates` row with a
  /// sequence greater than the snapshot's `last_sequence` is part of the
  /// current document. Returning the snapshot alone would make MCP reads stale
  /// immediately after a write to a compacted document.
  #[instrument(skip(self))]
  pub async fn get_snapshot(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Option<Vec<u8>>> {
    trace!(%workspace_id, %doc_id, "get_snapshot: loading");
    let loaded = self.load.load_full_doc_with_meta(workspace_id, doc_id).await?;
    if loaded.has_real_content {
      Ok(Some(loaded.payload))
    } else {
      Ok(None)
    }
  }

  /// List workspace documents (paginated).
  #[instrument(skip(self))]
  pub async fn list_workspace_docs(&self, workspace_id: Uuid, limit: i64, offset: i64) -> AuthResult<Vec<Doc>> {
    self.store.list_docs_in_workspace(workspace_id, limit, offset).await
  }

  /// Resolve live workspace-local keys for batched visibility projections.
  pub async fn metadata_by_external_keys(
    &self,
    workspace_id: Uuid,
    keys: &[String],
  ) -> AuthResult<HashMap<String, Doc>> {
    self.store.metadata_by_external_keys(workspace_id, keys).await
  }

  /// Read durable metadata/content watermarks without loading document bodies.
  pub async fn preview_source_identities(
    &self,
    workspace_id: Uuid,
    doc_ids: &[Uuid],
  ) -> AuthResult<HashMap<Uuid, DocPreviewSourceIdentity>> {
    self.store.preview_source_identities(workspace_id, doc_ids).await
  }

  /// List active content-bearing documents ordered by latest update.
  pub async fn list_content_docs_in_workspace(&self, workspace_id: Uuid, limit: i64) -> AuthResult<Vec<Doc>> {
    self.store.list_content_docs_in_workspace(workspace_id, limit).await
  }

  /// Count active ordinary documents without materializing the document list.
  pub async fn count_workspace_documents(&self, workspace_id: Uuid) -> AuthResult<i64> {
    self.store.count_workspace_documents(workspace_id).await
  }

  /// Create a document with a pre-specified doc_id (for MCP use).
  #[instrument(skip(self))]
  pub async fn create_doc(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    title: String,
    is_root: bool,
    created_by: Uuid,
  ) -> AuthResult<Doc> {
    self
      .store
      .create_doc_metadata(workspace_id, doc_id, title, is_root, created_by)
      .await
  }

  /// Idempotently create a page in an unpublished workspace import target.
  pub async fn create_imported_doc(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    title: String,
    created_by: Uuid,
  ) -> AuthResult<Doc> {
    self
      .store
      .create_imported_doc_metadata(workspace_id, doc_id, title, created_by)
      .await
  }

  /// Apply portable metadata to a document while its import target is hidden.
  pub async fn apply_imported_doc_metadata(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    title: String,
    meta: serde_json::Value,
    source_timestamp_ms: Option<i64>,
    is_trashed: bool,
  ) -> AuthResult<()> {
    self
      .store
      .apply_imported_doc_metadata(workspace_id, doc_id, title, meta, source_timestamp_ms, is_trashed)
      .await
  }

  /// Idempotent compensation removal for an unpublished import target.
  pub async fn hard_delete_imported_doc(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<()> {
    self.store.hard_delete_doc(workspace_id, doc_id).await
  }

  /// Delegate to [`DocWriteService::push_update_raw`].
  #[instrument(skip(self, payload))]
  pub async fn push_update_raw(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    payload: Vec<u8>,
    space_kind: DocSpaceKind,
  ) -> AuthResult<()> {
    self.push_update(workspace_id, doc_id, payload, 0, space_kind).await
  }

  /// Commit one native accepted Organizer projection through the existing
  /// system-document writer, then retain ordinary cache/compaction behavior.
  pub(crate) async fn commit_project_placement(
    &self,
    projection: crate::organizer::ProjectStarterPlacementProjection,
    ack: crate::workspace::ProjectPlacementAck,
  ) -> AuthResult<()> {
    let workspace = ack.workspace_id;
    let (payload, validated) = self.write.validate_snapshot_ingress(projection.update).await?;
    let result = self
      .store
      .commit_project_placement(
        DocUpdateWrite {
          sync_operation_id: None,
          connection_context: None,
          workspace_id: workspace,
          target: DocWriteTarget::External(
            DocumentKey::parse(format!("db${workspace}$folders"))
              .map_err(|_| AuthError::InvalidInput("invalid Organizer key".into()))?,
          ),
          payload,
          space_kind: DocSpaceKind::Workspace,
          actor_user_id: Some(ack.actor_id),
          client_format: None,
          client_capabilities: None,
          initial_provenance: None,
          validated_external_update: Some(validated),
        },
        ack,
      )
      .await?;
    if let Some(cache) = &self.write.doc_cache {
      cache.invalidate_snapshot(workspace, result.doc_id).await;
      cache.invalidate_metadata(result.doc_id).await;
      cache.invalidate_timestamps(workspace).await;
    }
    if let Err(error) = self.write.compaction.maybe_compact(workspace, result.doc_id).await {
      tracing::warn!(%workspace,doc_id=%result.doc_id,error=%error,"accepted Project Organizer compaction failed");
    }
    Ok(())
  }

  /// Push a raw Yjs update through the workspace-local external-key boundary.
  #[instrument(skip(self, payload))]
  pub async fn push_external_update_raw(
    &self,
    workspace_id: Uuid,
    document_key: DocumentKey,
    payload: Vec<u8>,
    space_kind: DocSpaceKind,
  ) -> AuthResult<Uuid> {
    self
      .push_external_update_with_context(
        Uuid::new_v4(),
        None,
        workspace_id,
        document_key,
        payload,
        0,
        space_kind,
        None,
        None,
        None,
        None,
      )
      .await
      .map(|result| result.doc_id)
  }

  /// Append one trusted maintenance delta only if the canonical document
  /// revision still matches the caller's plan.
  pub async fn push_revision_checked_external_update(
    &self,
    workspace_id: Uuid,
    document_key: DocumentKey,
    expected_revision: &str,
    payload: Vec<u8>,
  ) -> AuthResult<DocRevisionCheckedUpdateOutcome> {
    let Some(doc_id) = self
      .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &document_key)
      .await?
    else {
      return Err(AuthError::NotFound("document".to_string()));
    };
    self
      .write
      .push_revision_checked_update(workspace_id, doc_id, expected_revision, payload)
      .await
  }

  /// Append one trusted server-authored delta to an already resolved document
  /// only while the canonical document revision still matches the caller's
  /// read. Internal maintenance owners use this to join their final conflict
  /// check and publication under the normal document write lock.
  pub async fn push_revision_checked_update(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    expected_revision: &str,
    payload: Vec<u8>,
  ) -> AuthResult<DocRevisionCheckedUpdateOutcome> {
    self
      .write
      .push_revision_checked_update(workspace_id, doc_id, expected_revision, payload)
      .await
  }

  /// Delegate to [`DocCompactionService::merge_pending_updates`].
  #[instrument(skip(self))]
  pub async fn merge_pending_updates(&self, workspace_id: Uuid, doc_id: Uuid, min_updates: usize) -> AuthResult<usize> {
    let merged = self
      .compaction
      .merge_pending_updates(workspace_id, doc_id, min_updates)
      .await?;
    if merged > 0 {
      self
        .notify_document_graph_reindex(
          workspace_id,
          doc_id,
          doc_id != workspace_id,
          DocumentGraphReindexReason::SnapshotCompacted,
        )
        .await;
    }
    Ok(merged)
  }

  async fn notify_document_graph_reindex(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    is_workspace_space: bool,
    reason: DocumentGraphReindexReason,
  ) {
    if !is_workspace_space || doc_id == workspace_id {
      return;
    }
    let Some(hook) = self.document_graph_index_hook.read().await.clone() else {
      return;
    };
    if let Err(error) = hook
      .enqueue_document_graph_reindex(workspace_id, doc_id, reason.clone())
      .await
    {
      warn!(
        %workspace_id,
        %doc_id,
        reason = reason.as_str(),
        error = %error,
        "document graph reindex hook failed after document write (non-fatal)"
      );
    }
  }

  async fn notify_document_graph_deleted(&self, workspace_id: Uuid, doc_id: Uuid) {
    let Some(hook) = self.document_graph_index_hook.read().await.clone() else {
      return;
    };
    if let Err(error) = hook.mark_document_graph_deleted(workspace_id, doc_id).await {
      warn!(
        %workspace_id,
        %doc_id,
        error = %error,
        "document graph delete hook failed after document delete (non-fatal)"
      );
    }
  }

  async fn database_reference_refreshes_before_delete(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> Vec<myoxus_domain::database::DatabaseDocumentReferenceRefresh> {
    let Some(hook) = self.document_graph_index_hook.read().await.clone() else {
      return Vec::new();
    };
    match hook
      .database_reference_refreshes_before_delete(workspace_id, doc_id)
      .await
    {
      Ok(refreshes) => refreshes,
      Err(error) => {
        warn!(%workspace_id, %doc_id, error = %error, "database reference lookup failed before document delete");
        Vec::new()
      }
    }
  }

  async fn enqueue_database_reference_refreshes(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    refreshes: Vec<myoxus_domain::database::DatabaseDocumentReferenceRefresh>,
  ) {
    if refreshes.is_empty() {
      return;
    }
    let Some(hook) = self.document_graph_index_hook.read().await.clone() else {
      return;
    };
    if let Err(error) = hook.enqueue_database_reference_refreshes(refreshes).await {
      warn!(%workspace_id, %doc_id, error = %error, "database reference refresh enqueue failed after document delete");
    }
  }
}

#[cfg(test)]
mod ingress_tests {
  #[test]
  fn canonical_revision_is_stable_across_organizer_compaction() {
    let mut payload =
      hex::decode(include_str!("fixtures/organizer-history.hex").trim()).expect("synthetic QA organizer history");
    let expected = super::canonical_yjs_revision(&payload).expect("initial revision");
    for _ in 0..32 {
      assert_eq!(
        super::canonical_yjs_revision(&payload).expect("repeat revision"),
        expected
      );
      payload = yjs::merge_updates(vec![payload]).expect("compact organizer");
      assert_eq!(
        super::canonical_yjs_revision(&payload).expect("compacted revision"),
        expected
      );
    }
  }

  #[test]
  fn canonical_revision_is_stable_for_multiclient_organizer_history() {
    let mut payload = hex::decode(include_str!("fixtures/organizer-target-history.hex").trim())
      .expect("synthetic target organizer history");
    let expected = super::canonical_yjs_revision(&payload).expect("initial revision");
    for _ in 0..32 {
      let materialized =
        yjs::materialize_diff_v1([&payload], None, usize::MAX, || false).expect("coherent organizer materialization");
      assert_eq!(super::canonical_yjs_revision(&materialized.missing).unwrap(), expected);
      payload = yjs::merge_updates(vec![payload]).expect("compact organizer");
      assert_eq!(super::canonical_yjs_revision(&payload).unwrap(), expected);
    }
  }

  #[test]
  fn canonical_revision_is_stable_for_nested_json_objects() {
    use yrs::{Any, Doc, Map, ReadTxn, StateVector, Transact};
    // Previously persisted map entries need not be alphabetically encoded.
    let legacy = [118, 2, 1, b'b', 125, 2, 1, b'a', 125, 1];
    assert_eq!(
      Any::decode(&mut yrs::encoding::read::Cursor::new(&legacy)).expect("decode legacy map"),
      Any::from_json(r#"{"a":1,"b":2}"#).expect("legacy map semantics"),
    );
    let doc = Doc::with_client_id(17);
    let map = doc.get_or_insert_map("folders");
    let object = Any::from_json(
      r#"{"id":"folder","name":"Folder","parentId":null,"index":"a0","type":"folder","metadata":{"b":2,"a":1}}"#,
    )
    .expect("valid nested organizer object");
    map.insert(&mut doc.transact_mut(), "folder", object);
    let text = doc.get_or_insert_text("body");
    use yrs::Text;
    text.insert_with_attributes(
      &mut doc.transact_mut(),
      0,
      " ",
      yrs::types::Attrs::from([(
        "documentField".into(),
        Any::from_json(r#"{"type":"metadata","id":"status","key":"status","format":"text"}"#).unwrap(),
      )]),
    );
    let payload = doc.transact().encode_state_as_update_v1(&StateVector::default());
    let expected = super::canonical_yjs_revision(&payload).expect("first canonical revision");
    for _ in 0..32 {
      assert_eq!(
        super::canonical_yjs_revision(&payload).expect("repeat canonical revision"),
        expected
      );
    }
    map.insert(&mut doc.transact_mut(), "changed", true);
    let changed = doc.transact().encode_state_as_update_v1(&StateVector::default());
    assert_ne!(
      super::canonical_yjs_revision(&changed).expect("changed revision"),
      expected
    );
  }
  use super::*;

  #[test]
  fn doc_service_builders_preserve_ingress_policy() {
    let configured = DocService::new_with_decoder_concurrency(Arc::new(PanicDocStore), 16)
      .expect("selected decoder capacity")
      .with_external_update_ingress_max_bytes(4096);
    let semaphore = configured.decoder_semaphore.clone();
    let rebuilt = configured.with_compaction_thresholds(17, 3);

    assert_eq!(rebuilt.external_update_ingress_policy.max_update_bytes, 4096);
    assert_eq!(rebuilt.external_update_ingress_policy.validation_permits, 16);
    assert_eq!(semaphore.available_permits(), 16);
    assert!(
      Arc::ptr_eq(&semaphore, &rebuilt.decoder_semaphore),
      "rebuilding compaction must not replace the shared decoder semaphore"
    );
    assert!(Arc::ptr_eq(&rebuilt.decoder_semaphore, &rebuilt.load.decoder_semaphore));
    assert!(Arc::ptr_eq(
      &rebuilt.decoder_semaphore,
      &rebuilt.write.decoder_semaphore
    ));
    assert_eq!(rebuilt.write.external_update_ingress_policy.max_update_bytes, 4096);
    assert_eq!(rebuilt.write.external_update_ingress_policy.validation_permits, 16);
  }

  #[test]
  fn decoder_capacity_matches_the_semaphore_platform_bound() {
    use myoxus_contracts::effective_config::MAX_DOC_DECODER_CONCURRENCY;
    assert_eq!(MAX_DOC_DECODER_CONCURRENCY, tokio::sync::Semaphore::MAX_PERMITS);
    for invalid in [0, MAX_DOC_DECODER_CONCURRENCY + 1, usize::MAX] {
      assert!(DocService::new_with_decoder_concurrency(Arc::new(PanicDocStore), invalid).is_err());
    }
  }

  #[tokio::test]
  async fn doc_load_cancellation_wakes_every_registered_worker() {
    let cancellation = DocLoadCancellation::default();
    let mut workers = Vec::new();
    for _ in 0..8 {
      let cancellation = cancellation.clone();
      workers.push(tokio::spawn(async move { cancellation.cancelled().await }));
    }
    tokio::task::yield_now().await;
    cancellation.cancel();

    for worker in workers {
      tokio::time::timeout(std::time::Duration::from_secs(1), worker)
        .await
        .expect("all socket-owned workers must observe cancellation")
        .expect("cancellation waiter must not panic");
    }
  }
}
