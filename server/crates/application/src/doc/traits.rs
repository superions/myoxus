//! Doc sub-traits — each covers one responsibility area.
//!
//! `DocStore` (in `mod.rs`) is a super-trait combining all seven for backward
//! compatibility. Use these narrower traits in new code for finer-grained
//! dependency injection (e.g. inject only [`DocSnapshotStore`] into the
//! compaction worker rather than the full `DocStore`).
//!
//! Both `SqlxDocStore` and `PanicDocStore` implement all seven sub-traits.
//! The individual panic stubs (`PanicDocSnapshotStore`, etc.) allow tests to
//! inject only the sub-traits they actually exercise.

use crate::auth::{AuthError, AuthResult};
use crate::doc::{
  DocHistoryEntry, DocHistoryMetadataEntry, DocLoadCancellation, DocSnapshotMeta, DocSpaceKind, DocStateStreamMeta,
  DocUpdate, DocUpdateWrite, SourceRetirementOwnership,
};
use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::entities::{Doc, DocRole};
use std::collections::HashMap;
use uuid::Uuid;

/// Repository projection used by the permanent-delete use-case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocDeleteCandidate {
  /// Normalized database document id.
  pub doc_id: Uuid,
  /// Client-visible key from `docs.external_id` or `docs.id`.
  pub client_doc_id: String,
  pub title: String,
  pub workspace_id: Uuid,
  pub is_workspace_root: bool,
  pub deleted_at: Option<DateTime<Utc>>,
}

/// User profile attached to an explicit document grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocGrantedUser {
  pub user_id: Uuid,
  pub role: DocRole,
  pub name: String,
  pub email: String,
  pub avatar_key: Option<String>,
}

/// Workspace member's most recent access to a specific document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocMemberLastAccess {
  pub user_id: Uuid,
  pub name: String,
  pub email: String,
  pub avatar_key: Option<String>,
  pub last_accessed_at: DateTime<Utc>,
  pub last_doc_id: String,
}

/// One calendar-day bucket in the document-view projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocViewDaily {
  pub date: NaiveDate,
  pub total_views: i64,
  pub unique_views: i64,
  pub guest_views: i64,
}

/// Previous 28 complete analytics days, using the persistence owner's day zone.
#[derive(Debug, Clone)]
pub struct DocViewAnalyticsWindow {
  pub start: NaiveDate,
  pub end: NaiveDate,
  pub from: DateTime<Utc>,
  pub to: DateTime<Utc>,
}

/// Document timestamps and current creator/updater profile projections.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocAttribution {
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub created_by_name: Option<String>,
  pub created_by_avatar_key: Option<String>,
  pub updated_by_name: Option<String>,
  pub updated_by_avatar_key: Option<String>,
}

/// One ordinary workspace document whose missing title can still be repaired
/// from pending Yjs updates.
///
/// Root documents and reserved system documents are not title-bearing pages
/// and therefore never qualify for the title-backfill worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocTitleBackfillCandidate {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
}

/// Durable classification of one accepted Yjs push.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DocUpdatePersistenceOutcome {
  /// New CRDT information was appended and may trigger downstream work.
  #[default]
  Persisted,
  /// The exact payload digest was already present under the document lock.
  ExactReplay,
  /// The payload added neither new struct clocks nor an effective delete set.
  CrdtNoop,
}

impl DocUpdatePersistenceOutcome {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Persisted => "persisted",
      Self::ExactReplay => "exact_replay",
      Self::CrdtNoop => "crdt_noop",
    }
  }

  pub const fn is_persisted(self) -> bool {
    matches!(self, Self::Persisted)
  }
}

/// Outcome of classifying and optionally persisting a Yjs update.
///
/// Only [`DocUpdatePersistenceOutcome::Persisted`] may invalidate caches,
/// trigger compaction/indexing/projections, or broadcast. Replay and CRDT-noop
/// ACKs deliberately retain the resolved server document ID but carry no
/// downstream side effects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DocUpdatePersistenceResult {
  /// Global server-internal document id selected by the SQL identity boundary.
  pub doc_id: Uuid,
  pub auto_created_doc: bool,
  pub outcome: DocUpdatePersistenceOutcome,
  pub page_registration: Option<PageRegistrationState>,
}

/// Registration is separate from durable CRDT bytes. Legacy identity still
/// requires root-membership confirmation; it is never fresh create authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PageRegistrationState {
  Legacy,
  Unresolved,
  Pending,
  Registered,
  Deleted,
}

/// Result of an append guarded by the exact canonical Yjs content revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocRevisionCheckedUpdateOutcome {
  Appended { sequence: i64 },
  Stale { current_revision: String },
}

/// Atomic result of one server-authored semantic content mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocContentMutationCommit {
  pub doc_id: Uuid,
  pub sequence: i64,
  pub delta: Vec<u8>,
  /// Private projection input for exactly `sequence`; never reread a newer head
  /// or serialize this native state into a mutation's public response.
  pub state: Vec<u8>,
  pub inserted_block_ids: Vec<String>,
  pub removed_block_ids: Vec<String>,
  /// Commit-bound indirect changes; never inferred from a later document head.
  pub updated_block_ids: Vec<String>,
  pub recovery_history_id: Option<i64>,
}

/// Page lifecycle operation committed across SQL, leaf Yjs and root Yjs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageLifecycleKind {
  Create,
  Rename,
  Trash,
  Restore,
}

impl PageLifecycleKind {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Create => "create",
      Self::Rename => "rename",
      Self::Trash => "trash",
      Self::Restore => "restore",
    }
  }
}

/// Trusted command produced by the application lifecycle service.
#[derive(Debug, Clone)]
pub enum PageLifecycleCommand {
  Create {
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_user_id: Uuid,
    title: String,
    initial_leaf_update: Vec<u8>,
    /// Registry source classification is committed before the page is discoverable.
    source_purpose: Option<crate::template_registry::bundle::TemplatePurpose>,
    committed_at: DateTime<Utc>,
  },
  Rename {
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_user_id: Uuid,
    title: String,
    /// Checked under the same root/leaf locks before either document changes.
    expected_sequence: Option<i64>,
    committed_at: DateTime<Utc>,
  },
  SetTrash {
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_user_id: Uuid,
    is_trashed: bool,
    committed_at: DateTime<Utc>,
  },
}

impl PageLifecycleCommand {
  pub const fn kind(&self) -> PageLifecycleKind {
    match self {
      Self::Create { .. } => PageLifecycleKind::Create,
      Self::Rename { .. } => PageLifecycleKind::Rename,
      Self::SetTrash { is_trashed: true, .. } => PageLifecycleKind::Trash,
      Self::SetTrash { is_trashed: false, .. } => PageLifecycleKind::Restore,
    }
  }
}

/// One exact persisted Yjs-v1 delta and its server-assigned sequence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageLifecycleDelta {
  pub doc_id: Uuid,
  pub sequence: i64,
  pub delta: Vec<u8>,
}

/// Atomic result returned only after the lifecycle transaction commits.
#[derive(Debug, Clone)]
pub struct PageLifecycleCommit {
  pub kind: PageLifecycleKind,
  pub document: Doc,
  pub leaf: Option<PageLifecycleDelta>,
  pub workspace_root: PageLifecycleDelta,
  pub committed_at: DateTime<Utc>,
}

/// Association admitted by the native Task owner. The document and this binding
/// publish in the same transaction as the workflow effect acknowledgement.
#[derive(Debug, Clone, Copy)]
pub struct AutomationRowContentTarget {
  pub database_id: Uuid,
  pub row_id: Uuid,
  pub expected_edit_revision: i64,
}
/// Prepared native content; no client-controlled snapshot crosses this boundary.
pub(crate) struct AutomationPageContent {
  pub initial_leaf_update: Vec<u8>,
  pub committed_at: DateTime<Utc>,
  pub target: AutomationRowContentTarget,
}

/// Replay returns current authorized metadata without fabricated CRDT deltas.
#[derive(Debug, Clone)]
pub enum AutomationPageLifecycleResult {
  Committed(PageLifecycleCommit),
  Replay(Doc),
}

/// Raw SQL/leaf/root projection for one page identity.
///
/// The audit service classifies this read-only snapshot. `source_id` retains
/// the established evidence selector, `doc_id` is the internal UUID when one
/// is known, and `external_doc_id` names the exact workspace-root key without
/// inferring either identity from string shape.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageLifecycleAuditState {
  pub source_id: String,
  pub doc_id: Option<Uuid>,
  pub external_doc_id: Option<String>,
  /// Duplicate/non-bijective root observation or an internal UUID collision.
  pub identity_conflict: bool,
  pub sql_title: Option<String>,
  pub sql_trashed: Option<bool>,
  pub root_title: Option<String>,
  pub root_trashed: Option<bool>,
  pub leaf_exists: bool,
  pub leaf_title: Option<String>,
}

/// Bounded SQL metadata evidence used by page-projection discovery.
///
/// This repository shape is deliberately transport-neutral. The application
/// owner joins it with one bounded root projection and set-based leaf presence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageProjectionSqlRow {
  pub doc_id: Uuid,
  pub external_doc_id: String,
  pub title: String,
  pub is_trashed: bool,
}

/// Explicit repair intent produced from a current audit report.
#[derive(Debug, Clone)]
pub struct PageLifecycleRepairCommand {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub external_doc_id: String,
  pub actor_user_id: Uuid,
  pub title: String,
  pub is_trashed: bool,
  pub ensure_sql_metadata: bool,
  pub ensure_leaf: bool,
  pub ensure_root_entry: bool,
  /// Projection observed by the confirmed audit. Infrastructure compares it
  /// after acquiring the lifecycle locks so repair cannot overwrite a
  /// concurrent page mutation.
  pub expected_state: PageLifecycleAuditState,
}

/// Durable effects of one repair command.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageLifecycleRepairCommit {
  pub changed: bool,
  pub leaf_sequence: Option<i64>,
  pub root_sequence: Option<i64>,
}

// ── 1. Snapshot ───────────────────────────────────────────────────────────────

/// Port for reading and writing compacted Yjs snapshots.
#[async_trait]
pub trait DocSnapshotStore: Send + Sync {
  /// Load the current compacted Yjs snapshot payload for a document.
  ///
  /// Returns the single `doc_snapshots` row for `(workspace_id, doc_id)` if one
  /// exists. The snapshot represents the full merged document state up to
  /// `last_sequence`; callers must additionally load updates with
  /// `sequence > last_sequence` and merge them to reconstruct the live state.
  ///
  /// Returns `None` when no snapshot has been written yet (new document or a
  /// document that has never been compacted). Callers should fall back to
  /// loading all updates via `get_updates_after(workspace_id, doc_id, -1)`.
  ///
  /// # Workspace isolation
  /// Scope is a workspace UUID or userspace owner UUID. Private reads resolve
  /// the deployed workspace FK through document ownership; a wrong scope
  /// returns `None` rather than another owner's snapshot.
  ///
  /// # Errors
  /// Returns `AuthError::Storage` on database connectivity failures.
  /// Does NOT return `AuthError::NotFound`; absence is expressed as `None`.
  async fn get_snapshot(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Option<Vec<u8>>>;

  /// Load snapshot payload together with metadata in a single database round-trip.
  ///
  /// Returns a [`DocSnapshotMeta`] containing the raw Yjs binary `payload`,
  /// the `updated_at` timestamp (set to `MAX(server_timestamp)` of the merged
  /// updates rather than `now()`, for NestJS-compatible `X-Doc-Timestamp`
  /// header generation), and `last_sequence` (the highest update sequence
  /// number included in the snapshot).
  ///
  /// Prefer this method over `get_snapshot` when the caller also needs
  /// `updated_at` or `last_sequence` (e.g. `DocLoadService::load_full_doc_with_meta`).
  ///
  /// Returns `None` when no snapshot exists for the document.
  ///
  /// # Space isolation
  /// Scope is a workspace UUID or userspace owner UUID. Wrong scope yields `None`.
  ///
  /// # Errors
  /// Returns `AuthError::Storage` on database connectivity failures.
  async fn get_snapshot_with_meta(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Option<DocSnapshotMeta>>;

  /// Persist a compacted Yjs snapshot and execute all follow-on side effects atomically.
  ///
  /// All operations execute in a single database transaction:
  /// 1. Storage quota check (cache-first via `QuotaCache`, falls back to DB).
  ///    Rejects with `AuthError::StorageQuotaExceeded` if projected usage exceeds limit.
  /// 2. UPSERT into `doc_snapshots` (`ON CONFLICT (doc_id)` overwrites the prior row).
  ///    `updated_at` is set to `MAX(server_timestamp)` of merged updates, not `now()`.
  /// 3. DELETE `doc_updates` with `sequence <= last_sequence` (consumed by this snapshot).
  /// 4. INSERT an `outbox_events` row for Git-sync integration (transactional outbox).
  /// 5. UPSERT `workspace_storage_stats` with updated `snapshot_size`.
  /// 6. Title backfill: if the doc has no title, extract and write one from the Yjs content.
  ///
  /// Cache invalidation (snapshot cache, timestamps cache) is performed after the
  /// commit, outside the transaction.
  ///
  /// # Arguments
  /// - `doc_id` — document whose updates are being compacted.
  /// - `workspace_id` — workspace UUID or userspace owner UUID; private snapshots
  ///   retain the resolved existing workspace FK for technical storage accounting.
  /// - `payload` — the merged Yjs binary covering all updates up to `last_sequence`.
  /// - `last_sequence` — highest update sequence included in `payload`; all
  ///   `doc_updates` rows with `sequence <= last_sequence` will be deleted.
  ///
  /// # Errors
  /// - `AuthError::StorageQuotaExceeded` if the workspace storage limit would be exceeded.
  /// - `AuthError::Storage` on any database failure; the transaction is rolled back.
  async fn save_snapshot(
    &self,
    doc_id: Uuid,
    workspace_id: Uuid,
    payload: Vec<u8>,
    last_sequence: i64,
  ) -> AuthResult<()>;
}

// ── 2. Updates ────────────────────────────────────────────────────────────────

/// Port for appending and reading Yjs binary update log entries.
#[async_trait]
pub trait DocUpdateStore: Send + Sync {
  /// Persist the existing Organizer system-document update and final placement
  /// ACK atomically under current authority and receipt/Organizer fences.
  async fn commit_project_placement(
    &self,
    _update: DocUpdateWrite,
    _ack: crate::workspace::ProjectPlacementAck,
  ) -> AuthResult<DocUpdatePersistenceResult> {
    Err(AuthError::Storage("accepted Project placement unavailable".into()))
  }

  /// Append a Yjs binary update to the update log for a document.
  ///
  /// The server assigns the sequence number from the current persisted document
  /// state. The
  /// assigned value must be greater than both pending `doc_updates.sequence`
  /// and `doc_snapshots.last_sequence`; otherwise writes after compaction would
  /// be invisible to `load_full_doc`, which intentionally reads only updates
  /// newer than the snapshot.
  ///
  /// Auto-creates a `docs` row for the document if one does not exist yet
  /// (the storage protocol sends updates before any explicit create command).
  /// For userspace docs, the personal workspace UUID is resolved from the
  /// owner's user ID to satisfy the `doc_updates.workspace_id` FK constraint.
  ///
  /// # Arguments
  /// - `update.workspace_id` — workspace UUID (or owner user UUID for userspace).
  /// - `update.target` — either an already-authorized internal UUID or an
  ///   opaque external key that is resolved inside `update.workspace_id`.
  /// - `update.payload` — raw Yjs update binary; external commands already
  ///   passed the configured decoded-byte bound and one guarded decode.
  /// - `update.space_kind` — determines whether the doc belongs to a workspace
  ///   or a user's personal space.
  ///
  /// Exact external payload digests and semantic CRDT no-ops return a
  /// non-persisted [`DocUpdatePersistenceOutcome`] under the same document
  /// lock. They consume no sequence and must trigger no downstream work.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database failures or FK constraint violations.
  async fn push_update(&self, update: DocUpdateWrite) -> AuthResult<DocUpdatePersistenceResult>;

  /// Append one trusted maintenance delta only when the locked, fully
  /// materialized document still has `expected_revision`.
  ///
  /// Implementations must acquire the canonical document lock, reconstruct
  /// snapshot plus ordered tail under that lock and write no row on mismatch.
  async fn push_revision_checked_update(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _expected_revision: &str,
    _payload: Vec<u8>,
  ) -> AuthResult<DocRevisionCheckedUpdateOutcome> {
    Err(AuthError::Storage(
      "revision-checked document updates are not configured".to_string(),
    ))
  }

  /// Apply a semantic mutation under the canonical document lock and append
  /// its minimal Yjs delta in the same transaction.
  ///
  /// Implementations must reconstruct snapshot plus ordered tail while holding
  /// the lock, and may capture a recovery history entry before destructive
  /// replacement. The default fails closed for reduced test stores.
  async fn mutate_content(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _actor_user_id: Option<Uuid>,
    _mutation: yjs::DocumentMutation,
    _capture_recovery_history: bool,
    _expected_sequence: Option<i64>,
  ) -> AuthResult<DocContentMutationCommit> {
    Err(AuthError::Storage(
      "semantic document mutations are not configured".to_string(),
    ))
  }

  /// Return all update log entries for a document with `sequence > after_sequence`.
  ///
  /// Results are ordered by `sequence ASC` — the merge pipeline requires
  /// chronological order to produce a consistent CRDT state.
  ///
  /// Use `after_sequence = -1` to fetch all updates from the beginning
  /// (sequence numbers start at 1). Use `after_sequence = last_sequence` from
  /// a [`DocSnapshotMeta`] to fetch only the updates not yet covered by a snapshot.
  ///
  /// # Workspace isolation
  /// Scoped to `(workspace_id, doc_id)`. The `workspace_id` filter is mandatory
  /// (P102-UNIFY-01) to prevent cross-workspace data leaks.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database connectivity failures.
  async fn get_updates_after(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    after_sequence: i64,
  ) -> AuthResult<Vec<DocUpdate>>;

  /// Count the pending (not yet compacted) updates for a single document.
  ///
  /// Returns the number of rows in `doc_updates` for `doc_id`. Used by the
  /// compaction threshold check: when the count exceeds
  /// `COMPACTION_UPDATE_THRESHOLD` (500 for regular docs, 50 for root docs),
  /// `DocCompactionService::maybe_compact` merges all pending updates into a
  /// new snapshot.
  ///
  /// Does not filter by `workspace_id`; `doc_id` is unique across workspaces.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database connectivity failures.
  async fn count_pending_updates(&self, doc_id: Uuid) -> AuthResult<i64>;

  /// Count all pending updates across every document in the entire instance.
  ///
  /// Global monitoring metric for alerting and backlog observability. A very
  /// high count indicates that the compaction pipeline is falling behind.
  ///
  /// No `workspace_id` filter is applied. On large instances this may perform a
  /// sequential scan; use only in monitoring contexts, never in the hot path.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database connectivity failures.
  async fn count_all_pending_updates(&self) -> AuthResult<i64>;

  /// Return the highest update sequence number for a document.
  ///
  /// Executes `SELECT COALESCE(MAX(sequence), 0)` on `doc_updates` for
  /// `(workspace_id, doc_id)`. Returns `0` when no updates exist yet.
  ///
  /// Used by `DocHistoryService::rollback_to_history` to determine the next
  /// sequence number for the rollback update without loading all update payloads
  /// into memory (avoiding an OOM risk on documents with many pending updates).
  ///
  /// # Workspace isolation
  /// Scoped to `(workspace_id, doc_id)`. Returns `0` rather than a cross-workspace value.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database connectivity failures.
  async fn max_update_sequence(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<i64>;
}

/// Port for a consistent, bounded snapshot plus update-tail read.
#[async_trait]
pub trait DocLoadStore: Send + Sync {
  /// Stream one document state in snapshot-then-sequence order.
  ///
  /// Production implementations must hold one consistent database snapshot
  /// across both tables. The capacity-one sender is owned by the application
  /// load service; collecting either the tail or a second full payload before
  /// sending violates this contract.
  async fn stream_doc_state(
    &self,
    sync_operation_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    sender: tokio::sync::mpsc::Sender<Vec<u8>>,
    cancellation: DocLoadCancellation,
  ) -> AuthResult<DocStateStreamMeta>;
}

// ── 3. Metadata ───────────────────────────────────────────────────────────────

/// Port for document metadata CRUD (docs table), including workspace doc listings.
#[async_trait]
pub trait DocMetadataStore: Send + Sync {
  /// A published source redirect is retirement evidence, never cache-purge authority.
  async fn is_page_moved(&self, _workspace_id: Uuid, _key: &DocumentKey) -> AuthResult<bool> {
    Err(AuthError::Storage("page move evidence is not configured".into()))
  }
  /// Proves a SQL document identity previously belonged to this workspace through
  /// a committed transfer. Route-key redirects cannot prove SQL identity.
  async fn has_committed_transfer_from(&self, _doc_id: Uuid, _workspace_id: Uuid) -> AuthResult<bool> {
    Err(AuthError::Storage(
      "document transfer origin evidence is not configured".into(),
    ))
  }
  /// Only durable permanent-deletion evidence authorizes a client cache purge.
  async fn is_page_permanently_deleted(&self, _workspace_id: Uuid, _key: &DocumentKey) -> AuthResult<bool> {
    Err(AuthError::Storage("page deletion evidence is not configured".into()))
  }
  async fn page_registration_state(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
  ) -> AuthResult<Option<PageRegistrationState>> {
    Err(AuthError::Storage("page registration is not configured".into()))
  }
  /// Read only the fields needed to validate a preview cache candidate.
  /// Implementations must include the maximum pending-update sequence so a
  /// content edit cannot remain hidden behind unchanged document metadata.
  async fn preview_source_identity(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
  ) -> AuthResult<Option<super::DocPreviewSourceIdentity>> {
    Err(AuthError::Storage(
      "preview source identity is not configured".to_string(),
    ))
  }

  /// Batched snapshot-plus-tail identities for current-state inventory. Never
  /// substitute docs.updated_at for the maximum durable content sequence.
  async fn preview_source_identities(
    &self,
    _workspace_id: Uuid,
    _doc_ids: &[Uuid],
  ) -> AuthResult<HashMap<Uuid, super::DocPreviewSourceIdentity>> {
    Err(AuthError::Storage(
      "batched document source identities are not configured".into(),
    ))
  }

  /// Resolve live external keys in batches for permission-filtered projections.
  async fn metadata_by_external_keys(&self, _workspace_id: Uuid, _keys: &[String]) -> AuthResult<HashMap<String, Doc>> {
    Err(AuthError::Storage(
      "batched external document metadata is not configured".into(),
    ))
  }

  /// Create a reserved native page and acknowledge that component in the same
  /// leaf/root transaction. Ordinary lifecycle callers cannot reserve IDs.
  async fn commit_project_page_lifecycle(
    &self,
    _command: PageLifecycleCommand,
    _ack: crate::workspace::ProjectDocumentAck,
  ) -> AuthResult<PageLifecycleCommit> {
    Err(AuthError::Storage(
      "accepted Project page publication unavailable".into(),
    ))
  }
  async fn commit_automation_page_lifecycle(
    &self,
    _command: PageLifecycleCommand,
    _row_content: Option<AutomationRowContentTarget>,
    _fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> AuthResult<AutomationPageLifecycleResult> {
    Err(AuthError::Storage("native automation lifecycle unavailable".into()))
  }
  /// Commit one page lifecycle command atomically.
  ///
  /// Implementations lock the workspace root and leaf in deterministic order,
  /// derive deltas from the locked current state and commit metadata plus every
  /// update in one transaction. Reduced test stores fail closed by default.
  async fn commit_page_lifecycle(&self, _command: PageLifecycleCommand) -> AuthResult<PageLifecycleCommit> {
    Err(AuthError::Storage("page lifecycle is not configured".to_string()))
  }

  /// Current sequence of the workspace-root projection.
  async fn page_projection_root_sequence(&self, _workspace_id: Uuid) -> AuthResult<i64> {
    Err(AuthError::Storage(
      "page projection discovery is not configured".to_string(),
    ))
  }

  /// Keyset page of SQL documents ordered by their unique external key.
  async fn scan_page_projection_sql(
    &self,
    _workspace_id: Uuid,
    _after_external_doc_id: Option<&str>,
    _limit: usize,
  ) -> AuthResult<Vec<PageProjectionSqlRow>> {
    Err(AuthError::Storage(
      "page projection discovery is not configured".to_string(),
    ))
  }

  /// Keyset page of leaf identifiers ordered by internal UUID evidence.
  async fn scan_page_projection_leaf_ids(
    &self,
    _workspace_id: Uuid,
    _after_doc_id: Option<Uuid>,
    _limit: usize,
  ) -> AuthResult<Vec<Uuid>> {
    Err(AuthError::Storage(
      "page projection discovery is not configured".to_string(),
    ))
  }

  /// Batch SQL lookup for the current bounded external-key page.
  async fn page_projection_sql_by_external_ids(
    &self,
    _workspace_id: Uuid,
    _external_doc_ids: &[String],
  ) -> AuthResult<Vec<PageProjectionSqlRow>> {
    Err(AuthError::Storage(
      "page projection inspection is not configured".to_string(),
    ))
  }

  /// Batch SQL lookup for the current bounded internal leaf page.
  async fn page_projection_sql_by_doc_ids(
    &self,
    _workspace_id: Uuid,
    _doc_ids: &[Uuid],
  ) -> AuthResult<Vec<PageProjectionSqlRow>> {
    Err(AuthError::Storage(
      "page projection inspection is not configured".to_string(),
    ))
  }

  /// Global UUID existence evidence used only to refuse ambiguous orphan repair.
  async fn page_projection_existing_doc_ids(&self, _doc_ids: &[Uuid]) -> AuthResult<Vec<Uuid>> {
    Err(AuthError::Storage(
      "page projection inspection is not configured".to_string(),
    ))
  }

  /// Set-based leaf presence for one bounded page of internal identifiers.
  async fn page_projection_leaf_presence(&self, _workspace_id: Uuid, _doc_ids: &[Uuid]) -> AuthResult<Vec<Uuid>> {
    Err(AuthError::Storage(
      "page projection inspection is not configured".to_string(),
    ))
  }

  /// Reconcile one explicitly selected page under the canonical lifecycle locks.
  async fn commit_page_lifecycle_repair(
    &self,
    _command: PageLifecycleRepairCommand,
  ) -> AuthResult<PageLifecycleRepairCommit> {
    Err(AuthError::Storage(
      "page lifecycle repair is not configured".to_string(),
    ))
  }

  /// Resolve a client-visible key inside exactly one workspace/userspace.
  ///
  /// Soft-deleted rows remain resolvable so trash, restore and permanent-delete
  /// flows use the same identity as live reads.
  async fn resolve_external_doc_id(
    &self,
    space_id: Uuid,
    space_kind: DocSpaceKind,
    external_id: &str,
  ) -> AuthResult<Option<Uuid>>;

  /// Insert a new document metadata row into the `docs` table for a workspace document.
  ///
  /// Creates a row with `workspace_id` set and `userspace_owner_id` NULL. Set
  /// `is_root = true` only for the workspace's root document (the one whose UUID
  /// equals the workspace UUID). All other pages use `is_root = false`.
  ///
  /// `created_by` and `updated_by` are both set to the given user UUID on creation.
  ///
  /// # Arguments
  /// - `workspace_id` — workspace that owns this document.
  /// - `doc_id` — pre-generated UUID for the new document.
  /// - `title` — initial document title (may be empty).
  /// - `is_root` — whether this is the workspace root document.
  /// - `created_by` — user UUID of the creator.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database failure or unique-key violation
  ///   (e.g. a doc with this UUID already exists).
  async fn create_doc_metadata(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    title: String,
    is_root: bool,
    created_by: Uuid,
  ) -> AuthResult<Doc>;

  /// Idempotently create metadata inside a hidden import target.
  ///
  /// Production implementations must reject active workspaces and an existing
  /// document identity owned by another workspace. The default preserves test
  /// doubles that do not exercise workspace import retries.
  async fn create_imported_doc_metadata(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    title: String,
    created_by: Uuid,
  ) -> AuthResult<Doc> {
    self
      .create_doc_metadata(workspace_id, doc_id, title, false, created_by)
      .await
  }

  /// Apply portable metadata during a hidden workspace import. Implementations
  /// must scope the update to both workspace and document identities.
  async fn apply_imported_doc_metadata(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    title: String,
    meta: serde_json::Value,
    source_timestamp_ms: Option<i64>,
    is_trashed: bool,
  ) -> AuthResult<()> {
    let _ = (workspace_id, doc_id, title, meta, source_timestamp_ms, is_trashed);
    Err(AuthError::InvalidInput(
      "document store does not support imported metadata".to_string(),
    ))
  }

  /// Insert a document metadata row in the personal space (userspace) of a user.
  ///
  /// Creates a row with `userspace_owner_id` set to `owner_id` and `workspace_id`
  /// NULL. This is used for documents in a user's private space that are not
  /// associated with any shared workspace. Both `created_by` and `updated_by`
  /// are set to `owner_id`.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database failure or unique-key violation.
  async fn create_userspace_doc_metadata(&self, owner_id: Uuid, doc_id: Uuid, title: String) -> AuthResult<Doc>;

  /// Fetch a document's metadata row by its UUID.
  ///
  /// Filters on `deleted_at IS NULL` — soft-deleted documents are not returned.
  /// Returns `None` when no row exists or when the document has been soft-deleted.
  ///
  /// Note: this method does not scope by `workspace_id`. The caller must
  /// check `doc.workspace_id` if workspace isolation is required.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database connectivity failures.
  async fn get_doc_metadata(&self, doc_id: Uuid) -> AuthResult<Option<Doc>>;

  /// Load active metadata in one repository read. Callers still enforce scope
  /// and read access; this port must not fall back to per-document queries.
  async fn get_doc_metadata_batch(&self, doc_ids: &[Uuid]) -> AuthResult<HashMap<Uuid, Doc>>;

  /// Fetch document metadata together with current creator/updater profiles.
  async fn get_doc_attribution(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Option<DocAttribution>>;

  /// Resolve client-visible document keys for normalized IDs in one workspace.
  async fn resolve_external_doc_ids(&self, workspace_id: Uuid, doc_ids: &[Uuid]) -> AuthResult<HashMap<Uuid, String>>;

  /// List active, unblocked public documents by latest update.
  async fn list_public_docs(&self, workspace_id: Uuid) -> AuthResult<Vec<Doc>>;

  /// Fetch document metadata including soft-deleted rows.
  ///
  /// This narrow lifecycle read is reserved for authorization of operations
  /// that address the trash itself, such as permanent delete and restore.
  /// Ordinary document reads must continue to use [`Self::get_doc_metadata`]
  /// and therefore cannot observe trashed documents.
  async fn get_doc_metadata_including_deleted(&self, doc_id: Uuid) -> AuthResult<Option<Doc>> {
    self.get_doc_metadata(doc_id).await
  }

  /// Update the workspace-scoped default sharing role and return the current
  /// document projection.
  async fn update_doc_default_role(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _role: myoxus_domain::entities::DocDefaultRole,
    _actor_id: Uuid,
  ) -> AuthResult<Option<Doc>>;

  /// Publish or revoke one workspace document and return its updated metadata.
  async fn update_doc_public_mode(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _public_mode: Option<String>,
    _actor_id: Uuid,
  ) -> AuthResult<Option<Doc>>;

  /// Soft-delete a document by setting `deleted_at = now()`.
  ///
  /// The row remains in the database and all Yjs data (snapshots, updates) is
  /// preserved. The document is excluded from `get_doc_metadata`,
  /// `list_docs_in_workspace`, and `get_space_doc_timestamps` after this call.
  ///
  /// Does not cascade — Yjs data in `doc_updates` and `doc_snapshots` is not
  /// removed. Use `hard_delete_doc` for complete removal.
  ///
  /// Idempotent: calling multiple times on the same doc is safe (the timestamp
  /// is only written once; subsequent calls are no-ops in practice).
  ///
  /// # Errors
  /// - `AuthError::Storage` on database failure.
  async fn soft_delete_doc(&self, doc_id: Uuid) -> AuthResult<()>;

  /// Permanently delete a document and all its Yjs data.
  ///
  /// Deletes rows in the following order to respect FK constraints:
  /// 1. `doc_updates` — update log entries for this document.
  /// 2. `doc_snapshots` — compacted snapshot rows.
  /// 3. `docs` — the metadata row itself.
  ///
  /// All three deletes execute inside a single transaction; if any step fails,
  /// the entire operation is rolled back.
  ///
  /// Known `docs(id)` dependents such as `doc_histories`, ACL, comments,
  /// search rows, document metadata and document versions are removed by FK
  /// cascade when the `docs` row is deleted.
  ///
  /// # Workspace isolation
  /// `workspace_id` scopes update/snapshot deletes and the final `docs` delete.
  /// Cross-workspace IDs must not be deleted through this port.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database failure; the transaction is rolled back.
  async fn hard_delete_doc(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<()>;

  /// Fetch delete candidates by normalized doc ids, including soft-deleted rows.
  ///
  /// This is intentionally workspace-scoped and returns the client-visible id
  /// because root `meta.pages` uses the client key, not always the UUID.
  async fn list_delete_candidates(
    &self,
    workspace_id: Uuid,
    external_ids: &[String],
  ) -> AuthResult<Vec<DocDeleteCandidate>>;

  /// List trashed non-root docs in a workspace for `emptyTrash`.
  async fn list_trashed_delete_candidates(&self, workspace_id: Uuid, limit: i64)
  -> AuthResult<Vec<DocDeleteCandidate>>;

  /// Workspace-scoped hard delete returning whether the `docs` row existed and
  /// was deleted. Existing legacy callers can keep using `hard_delete_doc`.
  async fn hard_delete_doc_scoped(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<bool>;

  /// Source retirement must fence content and the selected native ownership
  /// under canonical document locks before changing root, Organizer or leaf data.
  async fn hard_delete_doc_scoped_at_revision(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _revision: i64,
    _ownership: SourceRetirementOwnership,
  ) -> AuthResult<bool> {
    Err(AuthError::Storage("revision-fenced deletion is unavailable".into()))
  }

  /// Return the UUIDs of documents in a workspace that have no title yet.
  ///
  /// Matches rows where `title IS NULL OR title = ''`. Used by the title-backfill
  /// job (P48-A) to discover documents that need their title extracted from Yjs
  /// content. Soft-deleted documents (`deleted_at IS NOT NULL`) may also be
  /// returned; the backfill is harmless for them.
  ///
  /// `limit` caps the batch size; typical values are 50–100.
  /// Results are returned in database default order (no ordering guarantee).
  ///
  /// # Workspace isolation
  /// Scoped to `workspace_id`. Results never cross workspace boundaries.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database connectivity failures.
  async fn find_docs_without_title(&self, workspace_id: Uuid, limit: i64) -> AuthResult<Vec<Uuid>>;

  /// Find active, ordinary workspace documents with an absent title and at
  /// least one pending update from which a title may be recovered.
  ///
  /// The pending-update predicate makes the periodic worker convergent: after
  /// one compaction attempt, an intrinsically untitled document is not queued
  /// again until it receives new content.
  async fn find_title_backfill_candidates(&self, limit: i64) -> AuthResult<Vec<DocTitleBackfillCandidate>>;

  /// List all non-deleted documents in a workspace, newest first.
  ///
  /// Filters on `workspace_id = $1 AND deleted_at IS NULL`. Results are sorted by
  /// `created_at DESC`. Supports offset-based pagination via `limit` and `offset`.
  ///
  /// Does not include userspace documents (those have `workspace_id IS NULL`).
  ///
  /// # Errors
  /// - `AuthError::Storage` on database connectivity failures.
  async fn list_docs_in_workspace(&self, workspace_id: Uuid, limit: i64, offset: i64) -> AuthResult<Vec<Doc>>;

  /// List active content-bearing documents by latest metadata update.
  async fn list_content_docs_in_workspace(&self, workspace_id: Uuid, limit: i64) -> AuthResult<Vec<Doc>>;

  /// Count active non-root workspace documents for status projections.
  async fn count_workspace_documents(&self, workspace_id: Uuid) -> AuthResult<i64>;

  /// Return the latest modification timestamps for all documents in a workspace.
  ///
  /// Combines two sources to build the timestamp map:
  /// 1. `doc_snapshots.updated_at` — timestamp of the last compacted update batch
  ///    (set to `MAX(server_timestamp)` of the merged updates, not `now()`).
  /// 2. `MAX(doc_updates.server_timestamp)` per document — covers pending updates
  ///    not yet compacted into a snapshot.
  ///
  /// When a document has both a snapshot and pending updates, the higher timestamp wins.
  ///
  /// `after` is an exclusive lower bound in milliseconds (Unix epoch). Only documents
  /// modified strictly after this timestamp are included. When `after = None`, all
  /// documents are returned (full sync). An `after` value newer than all known
  /// documents triggers a safety-net retry without the filter to prevent an empty
  /// response from leaving the client in a broken state.
  ///
  /// Soft-deleted documents (`deleted_at IS NOT NULL`) are excluded.
  ///
  /// Return type: `HashMap<doc_id_string, timestamp_millis>`. System doc keys
  /// (e.g. `"db$ws-id$folders"`) are preserved as their original string form
  /// (via `COALESCE(external_id, doc_id::text)`) for client IndexedDB compatibility.
  ///
  /// # Workspace isolation
  /// Scoped to `workspace_id`. Results never include documents from other workspaces.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database connectivity failures.
  async fn get_space_doc_timestamps(&self, workspace_id: Uuid, after: Option<i64>) -> AuthResult<HashMap<String, i64>>;
}

// ── 4. Views ─────────────────────────────────────────────────────────────────

/// Port for recording document view events and member last-access entries.
#[async_trait]
pub trait DocViewStore: Send + Sync {
  /// Record a document page view in the daily aggregation table.
  ///
  /// Upserts a row in `workspace_doc_view_daily` for the `(workspace_id, doc_id, date)`
  /// bucket. Increments `total_count` unconditionally; increments `unique_count`
  /// only when `is_unique = true` (caller is responsible for deduplication via
  /// `DOC_VIEW_DEDUP` or the Redis cache).
  ///
  /// `is_guest` determines whether the view is counted in the guest column.
  /// Guest views are tracked separately for analytics purposes.
  ///
  /// Fire-and-forget usage: callers spawn this in a background task and never
  /// await it on the critical path.
  ///
  /// # Workspace isolation
  /// Scoped to `workspace_id`. Rows are only written for the given workspace.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database connectivity failures.
  async fn record_doc_view(&self, workspace_id: Uuid, doc_id: &str, is_unique: bool, is_guest: bool) -> AuthResult<()>;

  /// Update the last-access timestamp for a workspace member on a specific document.
  ///
  /// Upserts a row in `workspace_member_last_access` for `(workspace_id, user_id)`.
  /// Records the `doc_id` and sets `accessed_at = now()`. This is used to populate
  /// the "recently visited" list on the workspace home screen.
  ///
  /// Must only be called for workspace members. Userspace docs do not have
  /// `workspace_member_last_access` rows (FK constraints would fail).
  ///
  /// Fire-and-forget usage: callers spawn this in a background task.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database failure or FK constraint violation.
  async fn upsert_member_last_access(&self, workspace_id: Uuid, user_id: Uuid, doc_id: &str) -> AuthResult<()>;

  /// List active workspace members whose latest access was to `doc_id`.
  async fn list_member_last_access(
    &self,
    workspace_id: Uuid,
    doc_id: &str,
    query: Option<&str>,
    limit: i64,
    offset: i64,
  ) -> AuthResult<Vec<DocMemberLastAccess>>;

  /// Count active workspace members whose latest access was to `doc_id`.
  async fn count_member_last_access(&self, workspace_id: Uuid, doc_id: &str) -> AuthResult<i64>;

  /// Return zero-filled daily view buckets for the inclusive date range.
  async fn list_doc_view_daily(
    &self,
    workspace_id: Uuid,
    doc_id: &str,
    start: NaiveDate,
    end: NaiveDate,
  ) -> AuthResult<Vec<DocViewDaily>>;

  /// Unknown when this adapter cannot establish the timezone of stored buckets.
  async fn analytics_window(&self) -> AuthResult<Option<DocViewAnalyticsWindow>> {
    Ok(None)
  }
}

// ── 5. History ────────────────────────────────────────────────────────────────

/// Port for creating and reading rollback history snapshots.
#[async_trait]
pub trait DocHistoryStore: Send + Sync {
  /// One bounded, read-only snapshot binds current ownership, selected history
  /// lineage, compacted current state, its tail and its lossless revision.
  async fn read_history_comparison(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _history_id: i64,
    _max_input_bytes: usize,
  ) -> AuthResult<crate::doc::history::DocHistoryComparisonRead> {
    Err(AuthError::Storage("history comparison is not configured".into()))
  }
  async fn history_revision(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<i64> {
    Err(AuthError::Storage("history revision is not configured".into()))
  }
  /// Atomically restore content, preserve recovery history and commit its audit
  /// and sync outbox. Reduced stores must reject unsupported durable writes.
  async fn restore_history(
    &self,
    _request: crate::doc::history::HistoryRestoreRequest,
  ) -> Result<crate::doc::history::HistoryRestoreCommit, crate::doc::history::HistoryCaptureError> {
    Err(AuthError::Storage("history restore is not configured".into()).into())
  }
  /// Capture one locked server materialization. Optional naming, counters and
  /// the canonical metadata head commit atomically with the history row.
  async fn capture_history(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    provenance: crate::doc::history::HistoryCaptureProvenance,
    named: Option<crate::doc::history::NamedHistoryCapture>,
  ) -> Result<crate::doc::history::HistoryCapture, crate::doc::history::HistoryCaptureError>;
  /// Idempotent interactive capture. Implementations must commit the request
  /// key and its history/version result in the same document transaction.
  async fn save_history(
    &self,
    _request: crate::doc::history::HistorySaveRequest,
  ) -> Result<crate::doc::history::HistorySaveCommit, crate::doc::history::HistoryCaptureError> {
    Err(AuthError::Storage("idempotent history capture is not configured".into()).into())
  }
  /// Name an existing immutable history row without materializing current
  /// content or updating the document's current version metadata.
  async fn name_history(
    &self,
    _request: crate::doc::history::HistoryNameRequest,
  ) -> Result<crate::doc::history::HistoryNameCommit, crate::doc::history::HistoryCaptureError> {
    Err(AuthError::Storage("history naming is not configured".into()).into())
  }
  /// Persist a history snapshot entry for a document.
  ///
  /// Inserts a row into `doc_histories` containing the full merged Yjs binary
  /// at the time of capture. History entries are created either explicitly via
  /// `DocHistoryService::capture_history_snapshot` or as a side effect of certain
  /// admin operations. Returns the auto-generated integer history ID.
  ///
  /// History entries are append-only. The server retention owner may remove
  /// expired, unreferenced rows but never current snapshots or referenced
  /// named-version history.
  ///
  /// # Arguments
  /// - `doc_id` — document this history entry belongs to.
  /// - `workspace_id` — workspace containing the document.
  /// - `snapshot` — the full merged Yjs binary at the captured point in time.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database failure.
  async fn create_history_entry(&self, doc_id: Uuid, workspace_id: Uuid, snapshot: Vec<u8>) -> AuthResult<i64>;

  /// Return history entries for a document, ordered newest first.
  ///
  /// Uses offset pagination: `skip` entries are skipped (0 = start from the
  /// most recent), then at most `take` entries are returned.
  ///
  /// Metadata is scoped to the current workspace/document owner.
  /// Snapshot bytes and lineage projection remain on exact read paths.
  ///
  /// # Errors
  /// - `AuthError::NotFound` when the workspace/document tuple is no longer current.
  /// - `AuthError::Storage` on database connectivity failures.
  async fn list_history(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<DocHistoryMetadataEntry>>;

  /// Keyset pagination in descending (created_at, id) order. A missing ID
  /// retains the legacy exclusive timestamp boundary, never an offset filter.
  async fn list_history_before(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    before: Option<DateTime<Utc>>,
    before_id: Option<i64>,
    take: i64,
  ) -> AuthResult<Vec<DocHistoryMetadataEntry>>;

  /// Keyset pagination with the optional named-reference predicate applied in
  /// storage before the page limit. Reduced stores retain legacy all-history
  /// behavior and must opt in before accepting the named-only mode.
  async fn list_history_before_filtered(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    before: Option<DateTime<Utc>>,
    before_id: Option<i64>,
    take: i64,
    named_only: bool,
  ) -> AuthResult<Vec<DocHistoryMetadataEntry>> {
    if named_only {
      return Err(AuthError::Storage("named history filtering is not configured".into()));
    }
    self
      .list_history_before(workspace_id, doc_id, before, before_id, take)
      .await
  }

  /// Exact metadata in the same current-owner scope as history pagination.
  /// Returns `None` for an absent or foreign snapshot; ownership/read failures
  /// remain errors. This method does not read or project snapshot bytes.
  async fn get_history_metadata(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    history_id: i64,
  ) -> AuthResult<Option<DocHistoryMetadataEntry>>;

  /// Fetch a single history entry by its integer ID.
  ///
  /// Returns `None` when no entry with that ID exists. The caller should
  /// validate that `entry.doc_id` matches the expected document UUID to
  /// prevent cross-document history access.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database connectivity failures.
  async fn get_history_entry(&self, history_id: i64) -> AuthResult<Option<DocHistoryEntry>>;

  /// Find the newest history entry at or before a requested timestamp.
  async fn find_history_at_or_before(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    timestamp: DateTime<Utc>,
  ) -> AuthResult<Option<DocHistoryEntry>>;

  /// Delete one history row captured for a failed compound operation.
  async fn delete_history_entry(&self, history_id: i64) -> AuthResult<bool>;
}

// ── 6. Permissions ────────────────────────────────────────────────────────────

/// Port for per-document user role management.
#[async_trait]
pub trait DocPermissionStore: Send + Sync {
  /// Return the explicit per-document role for a user.
  ///
  /// Looks up the `doc_user_permissions` table for `(user_id, doc_id)`.
  /// Returns `None` when no explicit role has been granted (the caller should
  /// fall back to workspace-level permission resolution in that case).
  ///
  /// Note: this is an explicit, per-document grant only. Inherited workspace
  /// roles are not considered here — permission resolution lives in
  /// `AccessController`.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database connectivity failures.
  async fn get_user_doc_role(&self, user_id: Uuid, doc_id: Uuid) -> AuthResult<Option<DocRole>>;

  /// Insert or update a user's explicit per-document role (UPSERT).
  ///
  /// Uses `ON CONFLICT (user_id, doc_id) DO UPDATE SET role = EXCLUDED.role`
  /// with `updated_at = now()`. Safe to call when a row already exists; the
  /// existing role is overwritten with the new value.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database failure.
  async fn upsert_user_doc_role(&self, user_id: Uuid, doc_id: Uuid, role: DocRole) -> AuthResult<()>;

  /// Revoke a user's explicit per-document role grant.
  ///
  /// Deletes the row from `doc_user_permissions` for `(user_id, doc_id)`.
  /// Idempotent: no error is returned when no such row exists.
  ///
  /// After this call, `get_user_doc_role` returns `None` for the same pair.
  /// Workspace-level permissions are not affected.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database failure.
  async fn delete_user_doc_role(&self, user_id: Uuid, doc_id: Uuid) -> AuthResult<()>;

  /// Grant a role to multiple users on a single document in one SQL round-trip.
  ///
  /// Only actual role transitions enqueue document-sharing outbox intent, in
  /// the same transaction as the grant. `actor` identifies the authenticated
  /// sharing user; `None` supports trusted server writers without inventing an
  /// actor. Repeated unchanged grants do not send another message.
  ///
  /// A no-op when `user_ids` is empty (returns `Ok(())` immediately without
  /// touching the database).
  ///
  /// # Errors
  /// - `AuthError::Storage` on database failure.
  async fn bulk_upsert_user_doc_roles(
    &self,
    user_ids: &[Uuid],
    doc_id: Uuid,
    role: DocRole,
    actor: Option<Uuid>,
  ) -> AuthResult<()>;

  /// Revoke roles from multiple users on a single document in one SQL round-trip.
  ///
  /// Deletes all `doc_user_permissions` rows where `user_id = ANY($1) AND doc_id = $2`.
  /// Idempotent: users without an existing grant are silently ignored.
  ///
  /// A no-op when `user_ids` is empty (returns `Ok(())` immediately).
  ///
  /// # Errors
  /// - `AuthError::Storage` on database failure.
  async fn bulk_delete_user_doc_roles(&self, user_ids: &[Uuid], doc_id: Uuid) -> AuthResult<()>;

  /// Return all explicit permission entries for a document.
  ///
  /// Returns a list of `(user_id, role)` pairs from `doc_user_permissions`
  /// for the given `doc_id`. No workspace-level permissions are included.
  ///
  /// Useful for permission management UI to display and edit per-document grants.
  /// Does not include inherited workspace roles.
  ///
  /// # Errors
  /// - `AuthError::Storage` on database connectivity failures.
  async fn list_doc_permissions(&self, doc_id: Uuid) -> AuthResult<Vec<(Uuid, DocRole)>>;

  /// Return explicit document grants together with their current user profiles.
  async fn list_granted_users(&self, doc_id: Uuid) -> AuthResult<Vec<DocGrantedUser>>;
}

// ── Panic stubs (P102-MOD-04) ─────────────────────────────────────────────────
// Each stub implements exactly one sub-trait, allowing tests to inject only the
// sub-traits they actually exercise without pulling in a full DocStore.

/// Panics on every call. Use in tests that must not touch snapshots.
pub struct PanicDocSnapshotStore;

#[async_trait]
impl DocSnapshotStore for PanicDocSnapshotStore {
  async fn get_snapshot(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<Option<Vec<u8>>> {
    panic!("PanicDocSnapshotStore: get_snapshot called — configure a real DocSnapshotStore in this test")
  }
  async fn get_snapshot_with_meta(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<Option<DocSnapshotMeta>> {
    panic!("PanicDocSnapshotStore: get_snapshot_with_meta called — configure a real DocSnapshotStore in this test")
  }
  async fn save_snapshot(
    &self,
    _doc_id: Uuid,
    _workspace_id: Uuid,
    _payload: Vec<u8>,
    _last_sequence: i64,
  ) -> AuthResult<()> {
    panic!("PanicDocSnapshotStore: save_snapshot called — configure a real DocSnapshotStore in this test")
  }
}

/// Panics on every call. Use in tests that must not touch the update log.
pub struct PanicDocUpdateStore;

#[async_trait]
impl DocUpdateStore for PanicDocUpdateStore {
  async fn push_update(&self, _update: DocUpdateWrite) -> AuthResult<DocUpdatePersistenceResult> {
    panic!("PanicDocUpdateStore: push_update called — configure a real DocUpdateStore in this test")
  }
  async fn get_updates_after(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _after_sequence: i64,
  ) -> AuthResult<Vec<DocUpdate>> {
    panic!("PanicDocUpdateStore: get_updates_after called — configure a real DocUpdateStore in this test")
  }
  async fn count_pending_updates(&self, _doc_id: Uuid) -> AuthResult<i64> {
    panic!("PanicDocUpdateStore: count_pending_updates called — configure a real DocUpdateStore in this test")
  }
  async fn count_all_pending_updates(&self) -> AuthResult<i64> {
    panic!("PanicDocUpdateStore: count_all_pending_updates called — configure a real DocUpdateStore in this test")
  }
  async fn max_update_sequence(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<i64> {
    panic!("PanicDocUpdateStore: max_update_sequence called — configure a real DocUpdateStore in this test")
  }
}

/// Panics on every call. Use in tests that must not load document state.
pub struct PanicDocLoadStore;

#[async_trait]
impl DocLoadStore for PanicDocLoadStore {
  async fn stream_doc_state(
    &self,
    _sync_operation_id: Uuid,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _sender: tokio::sync::mpsc::Sender<Vec<u8>>,
    _cancellation: DocLoadCancellation,
  ) -> AuthResult<DocStateStreamMeta> {
    panic!("PanicDocLoadStore: stream_doc_state called — configure a real DocLoadStore in this test")
  }
}

/// Panics on every call. Use in tests that must not touch document metadata.
pub struct PanicDocMetadataStore;

#[async_trait]
impl DocMetadataStore for PanicDocMetadataStore {
  async fn resolve_external_doc_id(
    &self,
    _space_id: Uuid,
    _space_kind: DocSpaceKind,
    _external_id: &str,
  ) -> AuthResult<Option<Uuid>> {
    panic!("PanicDocMetadataStore: resolve_external_doc_id called — configure a real DocMetadataStore in this test")
  }

  async fn create_doc_metadata(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _title: String,
    _is_root: bool,
    _created_by: Uuid,
  ) -> AuthResult<Doc> {
    panic!("PanicDocMetadataStore: create_doc_metadata called — configure a real DocMetadataStore in this test")
  }
  async fn create_userspace_doc_metadata(&self, _owner_id: Uuid, _doc_id: Uuid, _title: String) -> AuthResult<Doc> {
    panic!(
      "PanicDocMetadataStore: create_userspace_doc_metadata called — configure a real DocMetadataStore in this test"
    )
  }
  async fn get_doc_metadata(&self, _doc_id: Uuid) -> AuthResult<Option<Doc>> {
    panic!("PanicDocMetadataStore: get_doc_metadata called — configure a real DocMetadataStore in this test")
  }
  async fn get_doc_metadata_batch(&self, _doc_ids: &[Uuid]) -> AuthResult<HashMap<Uuid, Doc>> {
    panic!("PanicDocMetadataStore: get_doc_metadata_batch requires a real store")
  }
  async fn get_doc_attribution(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<Option<DocAttribution>> {
    panic!("PanicDocMetadataStore: get_doc_attribution called — configure a real DocMetadataStore in this test")
  }
  async fn resolve_external_doc_ids(
    &self,
    _workspace_id: Uuid,
    _doc_ids: &[Uuid],
  ) -> AuthResult<HashMap<Uuid, String>> {
    panic!("PanicDocMetadataStore: resolve_external_doc_ids called — configure a real DocMetadataStore in this test")
  }
  async fn list_public_docs(&self, _workspace_id: Uuid) -> AuthResult<Vec<Doc>> {
    panic!("PanicDocMetadataStore: list_public_docs called — configure a real DocMetadataStore in this test")
  }
  async fn update_doc_default_role(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _role: myoxus_domain::entities::DocDefaultRole,
    _actor_id: Uuid,
  ) -> AuthResult<Option<Doc>> {
    panic!("PanicDocMetadataStore: update_doc_default_role called — configure a real DocMetadataStore in this test")
  }
  async fn update_doc_public_mode(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _public_mode: Option<String>,
    _actor_id: Uuid,
  ) -> AuthResult<Option<Doc>> {
    panic!("PanicDocMetadataStore: update_doc_public_mode called — configure a real DocMetadataStore in this test")
  }
  async fn soft_delete_doc(&self, _doc_id: Uuid) -> AuthResult<()> {
    panic!("PanicDocMetadataStore: soft_delete_doc called — configure a real DocMetadataStore in this test")
  }
  async fn hard_delete_doc(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<()> {
    panic!("PanicDocMetadataStore: hard_delete_doc called — configure a real DocMetadataStore in this test")
  }
  async fn list_delete_candidates(
    &self,
    _workspace_id: Uuid,
    _external_ids: &[String],
  ) -> AuthResult<Vec<DocDeleteCandidate>> {
    panic!("PanicDocMetadataStore: list_delete_candidates called — configure a real DocMetadataStore in this test")
  }
  async fn list_trashed_delete_candidates(
    &self,
    _workspace_id: Uuid,
    _limit: i64,
  ) -> AuthResult<Vec<DocDeleteCandidate>> {
    panic!(
      "PanicDocMetadataStore: list_trashed_delete_candidates called — configure a real DocMetadataStore in this test"
    )
  }
  async fn hard_delete_doc_scoped(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<bool> {
    panic!("PanicDocMetadataStore: hard_delete_doc_scoped called — configure a real DocMetadataStore in this test")
  }
  async fn find_docs_without_title(&self, _workspace_id: Uuid, _limit: i64) -> AuthResult<Vec<Uuid>> {
    panic!("PanicDocMetadataStore: find_docs_without_title called — configure a real DocMetadataStore in this test")
  }
  async fn find_title_backfill_candidates(&self, _limit: i64) -> AuthResult<Vec<DocTitleBackfillCandidate>> {
    panic!(
      "PanicDocMetadataStore: find_title_backfill_candidates called — configure a real DocMetadataStore in this test"
    )
  }
  async fn list_docs_in_workspace(&self, _workspace_id: Uuid, _limit: i64, _offset: i64) -> AuthResult<Vec<Doc>> {
    panic!("PanicDocMetadataStore: list_docs_in_workspace called — configure a real DocMetadataStore in this test")
  }
  async fn list_content_docs_in_workspace(&self, _workspace_id: Uuid, _limit: i64) -> AuthResult<Vec<Doc>> {
    panic!(
      "PanicDocMetadataStore: list_content_docs_in_workspace called — configure a real DocMetadataStore in this test"
    )
  }
  async fn count_workspace_documents(&self, _workspace_id: Uuid) -> AuthResult<i64> {
    panic!("PanicDocMetadataStore: count_workspace_documents called — configure a real DocMetadataStore in this test")
  }
  async fn get_space_doc_timestamps(
    &self,
    _workspace_id: Uuid,
    _after: Option<i64>,
  ) -> AuthResult<HashMap<String, i64>> {
    panic!("PanicDocMetadataStore: get_space_doc_timestamps called — configure a real DocMetadataStore in this test")
  }
}

/// Panics on every call. Use in tests that must not touch view analytics.
pub struct PanicDocViewStore;

#[async_trait]
impl DocViewStore for PanicDocViewStore {
  async fn record_doc_view(
    &self,
    _workspace_id: Uuid,
    _doc_id: &str,
    _is_unique: bool,
    _is_guest: bool,
  ) -> AuthResult<()> {
    panic!("PanicDocViewStore: record_doc_view called — configure a real DocViewStore in this test")
  }
  async fn upsert_member_last_access(&self, _workspace_id: Uuid, _user_id: Uuid, _doc_id: &str) -> AuthResult<()> {
    panic!("PanicDocViewStore: upsert_member_last_access called — configure a real DocViewStore in this test")
  }
  async fn list_member_last_access(
    &self,
    _workspace_id: Uuid,
    _doc_id: &str,
    _query: Option<&str>,
    _limit: i64,
    _offset: i64,
  ) -> AuthResult<Vec<DocMemberLastAccess>> {
    panic!("PanicDocViewStore: list_member_last_access called — configure a real DocViewStore in this test")
  }
  async fn count_member_last_access(&self, _workspace_id: Uuid, _doc_id: &str) -> AuthResult<i64> {
    panic!("PanicDocViewStore: count_member_last_access called — configure a real DocViewStore in this test")
  }
  async fn list_doc_view_daily(
    &self,
    _workspace_id: Uuid,
    _doc_id: &str,
    _start: NaiveDate,
    _end: NaiveDate,
  ) -> AuthResult<Vec<DocViewDaily>> {
    panic!("PanicDocViewStore: list_doc_view_daily called — configure a real DocViewStore in this test")
  }
}

/// Panics on every call. Use in tests that must not touch doc history.
pub struct PanicDocHistoryStore;

#[async_trait]
impl DocHistoryStore for PanicDocHistoryStore {
  async fn capture_history(
    &self,
    _: Uuid,
    _: Uuid,
    _: crate::doc::history::HistoryCaptureProvenance,
    _: Option<crate::doc::history::NamedHistoryCapture>,
  ) -> Result<crate::doc::history::HistoryCapture, crate::doc::history::HistoryCaptureError> {
    panic!("DocHistoryStore::capture_history must not be called");
  }
  async fn list_history_before(
    &self,
    _: Uuid,
    _: Uuid,
    _: Option<DateTime<Utc>>,
    _: Option<i64>,
    _: i64,
  ) -> AuthResult<Vec<DocHistoryMetadataEntry>> {
    panic!("PanicDocHistoryStore: configure real history storage")
  }
  async fn create_history_entry(&self, _doc_id: Uuid, _workspace_id: Uuid, _snapshot: Vec<u8>) -> AuthResult<i64> {
    panic!("PanicDocHistoryStore: create_history_entry called — configure a real DocHistoryStore in this test")
  }
  async fn list_history(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _skip: i64,
    _take: i64,
  ) -> AuthResult<Vec<DocHistoryMetadataEntry>> {
    panic!("PanicDocHistoryStore: list_history called — configure a real DocHistoryStore in this test")
  }
  async fn get_history_metadata(&self, _: Uuid, _: Uuid, _: i64) -> AuthResult<Option<DocHistoryMetadataEntry>> {
    panic!("history metadata storage is not configured");
  }
  async fn get_history_entry(&self, _history_id: i64) -> AuthResult<Option<DocHistoryEntry>> {
    panic!("PanicDocHistoryStore: get_history_entry called — configure a real DocHistoryStore in this test")
  }
  async fn find_history_at_or_before(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _timestamp: DateTime<Utc>,
  ) -> AuthResult<Option<DocHistoryEntry>> {
    panic!("PanicDocHistoryStore: find_history_at_or_before called — configure a real DocHistoryStore in this test")
  }
  async fn delete_history_entry(&self, _history_id: i64) -> AuthResult<bool> {
    panic!("PanicDocHistoryStore: delete_history_entry called — configure a real DocHistoryStore in this test")
  }
}

/// Panics on every call. Use in tests that must not touch doc permissions.
pub struct PanicDocPermissionStore;

#[async_trait]
impl DocPermissionStore for PanicDocPermissionStore {
  async fn get_user_doc_role(&self, _user_id: Uuid, _doc_id: Uuid) -> AuthResult<Option<DocRole>> {
    panic!("PanicDocPermissionStore: get_user_doc_role called — configure a real DocPermissionStore in this test")
  }
  async fn upsert_user_doc_role(&self, _user_id: Uuid, _doc_id: Uuid, _role: DocRole) -> AuthResult<()> {
    panic!("PanicDocPermissionStore: upsert_user_doc_role called — configure a real DocPermissionStore in this test")
  }
  async fn delete_user_doc_role(&self, _user_id: Uuid, _doc_id: Uuid) -> AuthResult<()> {
    panic!("PanicDocPermissionStore: delete_user_doc_role called — configure a real DocPermissionStore in this test")
  }
  async fn bulk_upsert_user_doc_roles(
    &self,
    _user_ids: &[Uuid],
    _doc_id: Uuid,
    _role: DocRole,
    _actor: Option<Uuid>,
  ) -> AuthResult<()> {
    panic!(
      "PanicDocPermissionStore: bulk_upsert_user_doc_roles called — configure a real DocPermissionStore in this test"
    )
  }
  async fn bulk_delete_user_doc_roles(&self, _user_ids: &[Uuid], _doc_id: Uuid) -> AuthResult<()> {
    panic!(
      "PanicDocPermissionStore: bulk_delete_user_doc_roles called — configure a real DocPermissionStore in this test"
    )
  }
  async fn list_doc_permissions(&self, _doc_id: Uuid) -> AuthResult<Vec<(Uuid, DocRole)>> {
    panic!("PanicDocPermissionStore: list_doc_permissions called — configure a real DocPermissionStore in this test")
  }
  async fn list_granted_users(&self, _doc_id: Uuid) -> AuthResult<Vec<DocGrantedUser>> {
    panic!("PanicDocPermissionStore: list_granted_users called — configure a real DocPermissionStore in this test")
  }
}
