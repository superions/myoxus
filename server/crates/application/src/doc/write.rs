//! P102-SVC-02: DocWriteService — document write sub-service.
//!
//! Encapsulates the write paths extracted from `DocService`:
//! - `push_update` — write a Yjs binary update, then auto-compact if threshold reached.
//! - external writes resolve an opaque document key inside its authorized space.
//! - `push_update_raw` — convenience wrapper for server-authored updates.
//!
//! After every successful update `DocCompactionService::maybe_compact` is called.
//! Compaction failures are non-fatal (WARN-logged, never propagated).

use std::sync::Arc;

use tracing::{instrument, trace, warn};

use crate::auth::{AuthError, AuthResult};
use crate::doc::compaction::DocCompactionService;
use crate::doc::{
  DocCachePort, DocRevisionCheckedUpdateOutcome, DocSpaceKind, DocStore, DocSyncConnectionContext,
  DocUpdatePersistenceResult, DocUpdateWrite, DocWriteTarget, InitialDocumentProvenance, ValidatedExternalYjsUpdate,
};
use crate::metrics::{MetricsCategory, MetricsService};

use myoxus_domain::document_key::DocumentKey;
use tokio::sync::Semaphore;
use uuid::Uuid;

/// Default decoded Yjs-v1 payload limit for external client updates.
pub const DEFAULT_EXTERNAL_UPDATE_MAX_BYTES: usize = 32 * 1024 * 1024;
/// Maximum number of blocking Yjs decoders allowed to run concurrently.
pub const DEFAULT_EXTERNAL_VALIDATION_PERMITS: usize =
  myoxus_contracts::effective_config::DEFAULT_DOC_DECODER_CONCURRENCY;

/// Immutable configuration shared by every external-update write path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExternalUpdateIngressPolicy {
  pub max_update_bytes: usize,
  pub validation_permits: usize,
}

impl Default for ExternalUpdateIngressPolicy {
  fn default() -> Self {
    Self {
      max_update_bytes: DEFAULT_EXTERNAL_UPDATE_MAX_BYTES,
      validation_permits: DEFAULT_EXTERNAL_VALIDATION_PERMITS,
    }
  }
}

impl ExternalUpdateIngressPolicy {
  pub fn new(max_update_bytes: usize, validation_permits: usize) -> Result<Self, &'static str> {
    if max_update_bytes == 0 {
      return Err("max_update_bytes must be greater than zero");
    }
    myoxus_contracts::effective_config::validate_doc_decoder_concurrency(validation_permits)?;
    Ok(Self {
      max_update_bytes,
      validation_permits,
    })
  }
}

/// Sub-service responsible for writing document updates.
///
/// Constructed by `DocService::new` and exposed as `DocService::write`.
#[derive(Clone)]
pub struct DocWriteService {
  pub(crate) store: Arc<dyn DocStore>,
  pub(crate) compaction: Arc<DocCompactionService>,
  /// P102-CACHE-01: optional doc cache for snapshot invalidation on write.
  pub(crate) doc_cache: Option<Arc<dyn DocCachePort>>,
  /// P0-04: shared policy for client-controlled Yjs ingress.
  pub(crate) external_update_ingress_policy: ExternalUpdateIngressPolicy,
  /// P0-04: bounded blocking decoders shared across all rebuilt builders.
  pub(crate) decoder_semaphore: Arc<Semaphore>,
  /// The existing server-wide metrics service, when production wiring provides it.
  pub(crate) metrics: Option<Arc<MetricsService>>,
}

impl DocWriteService {
  pub fn new(store: Arc<dyn DocStore>, compaction: Arc<DocCompactionService>) -> Self {
    let policy = ExternalUpdateIngressPolicy::default();
    Self::new_with_external_ingress(
      store,
      compaction,
      policy.clone(),
      Arc::new(Semaphore::new(policy.validation_permits)),
    )
  }

  pub(crate) fn new_with_external_ingress(
    store: Arc<dyn DocStore>,
    compaction: Arc<DocCompactionService>,
    external_update_ingress_policy: ExternalUpdateIngressPolicy,
    decoder_semaphore: Arc<Semaphore>,
  ) -> Self {
    Self {
      store,
      compaction,
      doc_cache: None,
      external_update_ingress_policy,
      decoder_semaphore,
      metrics: None,
    }
  }

  /// Attach a [`DocCachePort`] to enable cache invalidation on writes.
  pub fn with_doc_cache(mut self, cache: Arc<dyn DocCachePort>) -> Self {
    self.doc_cache = Some(cache);
    self
  }

  /// Change only the decoded-byte limit while retaining the shared semaphore.
  pub fn with_external_update_ingress_max_bytes(mut self, max_update_bytes: usize) -> Self {
    self.external_update_ingress_policy.max_update_bytes = max_update_bytes;
    self
  }

  /// Install the existing server-wide metrics service without creating a
  /// feature-local recorder or changing metric policy.
  pub fn with_metrics_service(mut self, metrics: Arc<MetricsService>) -> Self {
    self.metrics = Some(metrics);
    self
  }

  #[instrument(skip(self, payload))]
  pub async fn push_update(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    payload: Vec<u8>,
    sequence: i64,
    space_kind: DocSpaceKind,
  ) -> AuthResult<DocUpdatePersistenceResult> {
    self
      .push_update_target(
        workspace_id,
        DocWriteTarget::Internal(doc_id),
        payload,
        sequence,
        space_kind,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
      )
      .await
  }

  /// Append one server-authored maintenance delta against an exact revision.
  /// This path deliberately does not compact: the maintenance operation's one
  /// append-only update remains the explicit recovery boundary.
  pub async fn push_revision_checked_update(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    expected_revision: &str,
    payload: Vec<u8>,
  ) -> AuthResult<DocRevisionCheckedUpdateOutcome> {
    let outcome = self
      .store
      .push_revision_checked_update(workspace_id, doc_id, expected_revision, payload)
      .await?;
    if matches!(outcome, DocRevisionCheckedUpdateOutcome::Appended { .. })
      && let Some(cache) = &self.doc_cache
    {
      cache.invalidate_snapshot(workspace_id, doc_id).await;
      cache.invalidate_metadata(doc_id).await;
      cache.invalidate_timestamps(workspace_id).await;
    }
    Ok(outcome)
  }

  /// Append an update for a server-owned internal document identity while
  /// retaining initial-sync provenance. Client/API code must use the external
  /// key variant instead.
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
  ) -> AuthResult<DocUpdatePersistenceResult> {
    self
      .push_update_target(
        workspace_id,
        DocWriteTarget::Internal(doc_id),
        payload,
        sequence,
        space_kind,
        actor_user_id,
        client_format,
        client_capabilities,
        initial_provenance,
        None,
        None,
        None,
      )
      .await
  }

  /// Append a client/API update through the workspace-local SQL key boundary.
  #[instrument(skip(self, payload))]
  #[expect(
    clippy::too_many_arguments,
    reason = "sync ingress keeps authenticated provenance and replay fields explicit"
  )]
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
    let (payload, validated_external_update) = self
      .validate_external_update(workspace_id, &document_key, payload)
      .await?;
    self
      .push_update_target(
        workspace_id,
        DocWriteTarget::External(document_key),
        payload,
        sequence,
        space_kind,
        actor_user_id,
        client_format,
        client_capabilities,
        initial_provenance,
        Some(validated_external_update),
        Some(sync_operation_id),
        connection_context,
      )
      .await
  }

  /// Enforce the external ingress boundary before a store, cache, compactor,
  /// indexer or broadcaster can observe the payload.
  async fn validate_external_update(
    &self,
    workspace_id: Uuid,
    document_key: &DocumentKey,
    payload: Vec<u8>,
  ) -> AuthResult<(Vec<u8>, ValidatedExternalYjsUpdate)> {
    let payload_size = payload.len();
    let result = self.validate_snapshot_ingress(payload).await;
    if let Err(error) = &result {
      let reason = match error {
        AuthError::UpdateTooLarge { .. } => "too_large",
        AuthError::InvalidYjsUpdate => "invalid",
        _ => "validator_unavailable",
      };
      self.record_ingress_rejection(workspace_id, document_key, payload_size, reason);
    }
    result
  }

  /// Expanded snapshots obey the same byte and bounded-decoder limits as
  /// document ingress, both before creation and during late materialization.
  /// Keep that policy here rather than duplicating limits in the instantiator.
  pub(crate) async fn validate_snapshot_ingress(
    &self,
    payload: Vec<u8>,
  ) -> AuthResult<(Vec<u8>, ValidatedExternalYjsUpdate)> {
    let max_bytes = self.external_update_ingress_policy.max_update_bytes;
    if payload.len() > max_bytes {
      return Err(AuthError::UpdateTooLarge { max_bytes });
    }

    let permit = self
      .decoder_semaphore
      .clone()
      .acquire_owned()
      .await
      .map_err(|_| AuthError::YjsValidationUnavailable)?;
    match yjs::decode_update_v1_guarded(payload, permit).await {
      Ok((payload, decoded)) => Ok((payload, ValidatedExternalYjsUpdate::new(decoded, max_bytes))),
      Err(yjs::YjsGuardedDecodeError::InvalidUpdate) => Err(AuthError::InvalidYjsUpdate),
      Err(yjs::YjsGuardedDecodeError::WorkerUnavailable) => Err(AuthError::YjsValidationUnavailable),
    }
  }

  fn record_ingress_rejection(
    &self,
    workspace_id: Uuid,
    document_key: &DocumentKey,
    payload_size: usize,
    reason: &str,
  ) {
    warn!(
      %workspace_id,
      external_id = %document_key,
      payload_size,
      reason,
      "external Yjs update rejected before persistence"
    );
    if let Some(metrics) = &self.metrics {
      metrics.record(MetricsCategory::Collab, "yjs_ingress_rejected", &[("reason", reason)]);
    }
  }

  #[allow(clippy::too_many_arguments)]
  async fn push_update_target(
    &self,
    workspace_id: Uuid,
    target: DocWriteTarget,
    payload: Vec<u8>,
    sequence: i64,
    space_kind: DocSpaceKind,
    actor_user_id: Option<Uuid>,
    client_format: Option<String>,
    client_capabilities: Option<String>,
    initial_provenance: Option<InitialDocumentProvenance>,
    validated_external_update: Option<ValidatedExternalYjsUpdate>,
    sync_operation_id: Option<Uuid>,
    connection_context: Option<DocSyncConnectionContext>,
  ) -> AuthResult<DocUpdatePersistenceResult> {
    trace!(%workspace_id, ?target, ?sync_operation_id, sequence, payload_size = payload.len(), "pushing document update");
    let result = self
      .store
      .push_update(DocUpdateWrite {
        sync_operation_id,
        connection_context,
        workspace_id,
        target,
        payload,
        space_kind,
        actor_user_id,
        client_format,
        client_capabilities,
        initial_provenance,
        validated_external_update,
      })
      .await?;
    let doc_id = result.doc_id;

    if !result.outcome.is_persisted() {
      return Ok(result);
    }

    // P102-CACHE-01: invalidate snapshot cache after each write (update makes cached snapshot stale).
    if let Some(cache) = &self.doc_cache {
      cache.invalidate_snapshot(workspace_id, doc_id).await;
      cache.invalidate_metadata(doc_id).await;
      // Also invalidate timestamps cache since this write changes the doc timestamp.
      cache.invalidate_timestamps(workspace_id).await;
    }

    // Auto-compaction: if accumulated updates exceed threshold, merge into snapshot.
    // Runs inline but failures are non-fatal (next push_update will retry).
    if let Err(e) = self.compaction.maybe_compact(workspace_id, doc_id).await {
      warn!(%workspace_id, %doc_id, error = %e, "auto-compaction failed (non-fatal)");
    }

    Ok(result)
  }

  /// Push a Yjs update by parts (workspace_id, doc_id, payload, etc.).
  #[instrument(skip(self, payload))]
  pub async fn push_update_raw(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    payload: Vec<u8>,
    space_kind: DocSpaceKind,
  ) -> AuthResult<()> {
    // Sequence assignment is owned by the persistence layer so every write path
    // shares the same snapshot-aware ordering contract.
    self
      .push_update(workspace_id, doc_id, payload, 0, space_kind)
      .await
      .map(|_| ())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::auth::{AuthError, AuthResult};
  use crate::doc::traits::{
    DocHistoryStore, DocLoadStore, DocMetadataStore, DocPermissionStore, DocSnapshotStore, DocUpdateStore, DocViewStore,
  };
  use crate::doc::{
    DocAttribution, DocDeleteCandidate, DocGrantedUser, DocHistoryEntry, DocHistoryMetadataEntry, DocLoadCancellation,
    DocMemberLastAccess, DocSnapshotMeta, DocStateStreamMeta, DocTitleBackfillCandidate, DocUpdate,
    DocUpdatePersistenceOutcome, DocUpdateStreamStats, DocViewDaily,
  };
  use crate::metrics::{InMemoryMetricsRecorder, MetricsPolicy, MetricsRecorder};
  use async_trait::async_trait;
  use chrono::{NaiveDate, Utc};
  use myoxus_domain::entities::{Doc, DocDefaultRole, DocRole};
  use std::collections::HashMap;
  use std::sync::atomic::{AtomicUsize, Ordering};
  use tokio::sync::Mutex;

  async fn assert_decoder_permits_returned(semaphore: &Arc<Semaphore>, capacity: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
      while semaphore.available_permits() != capacity {
        // The blocking decoder sends its result before its stack drops the
        // owned permit. Wait for that documented hand-off instead of racing
        // the blocking-worker epilogue in the same scheduler tick.
        tokio::task::yield_now().await;
      }
    })
    .await
    .expect("decoder permits must return after the guarded operation");
  }

  #[derive(Default)]
  struct RecordingDocCache {
    invalidations: AtomicUsize,
  }

  #[async_trait]
  impl DocCachePort for RecordingDocCache {
    async fn get_snapshot(&self, _ws: Uuid, _doc: Uuid) -> Option<Vec<u8>> {
      None
    }

    async fn set_snapshot(&self, _ws: Uuid, _doc: Uuid, _payload: &[u8]) {}

    async fn invalidate_snapshot(&self, _ws: Uuid, _doc: Uuid) {
      self.invalidations.fetch_add(1, Ordering::Relaxed);
    }

    async fn get_metadata(&self, _doc: Uuid) -> Option<serde_json::Value> {
      None
    }

    async fn set_metadata(&self, _doc: Uuid, _meta: &serde_json::Value) {}

    async fn invalidate_metadata(&self, _doc: Uuid) {
      self.invalidations.fetch_add(1, Ordering::Relaxed);
    }

    async fn check_and_set_view_dedup(&self, _user: Uuid, _ws: Uuid, _doc: &str, _date: NaiveDate) -> bool {
      true
    }

    async fn acquire_compaction_lock(&self, _doc: Uuid, _instance_id: Uuid) -> bool {
      true
    }

    async fn release_compaction_lock(&self, _doc: Uuid) {}

    async fn get_timestamps(&self, _ws: Uuid) -> Option<HashMap<String, i64>> {
      None
    }

    async fn set_timestamps(&self, _ws: Uuid, _timestamps: &HashMap<String, i64>) {}

    async fn invalidate_timestamps(&self, _ws: Uuid) {
      self.invalidations.fetch_add(1, Ordering::Relaxed);
    }
  }

  #[derive(Default)]
  struct RecordingDocStore {
    docs: Mutex<HashMap<Uuid, Doc>>,
    updates: Mutex<HashMap<(Uuid, Uuid), Vec<DocUpdate>>>,
    update_payload_reads: AtomicUsize,
    pending_count_reads: AtomicUsize,
    persistence_outcome: AtomicUsize,
  }

  impl RecordingDocStore {
    fn with_persistence_outcome(outcome: DocUpdatePersistenceOutcome) -> Self {
      Self {
        persistence_outcome: AtomicUsize::new(match outcome {
          DocUpdatePersistenceOutcome::Persisted => 0,
          DocUpdatePersistenceOutcome::ExactReplay => 1,
          DocUpdatePersistenceOutcome::CrdtNoop => 2,
        }),
        ..Self::default()
      }
    }
  }

  #[async_trait]
  impl DocSnapshotStore for RecordingDocStore {
    async fn get_snapshot(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<Option<Vec<u8>>> {
      Ok(None)
    }

    async fn get_snapshot_with_meta(&self, _workspace_id: Uuid, _doc_id: Uuid) -> AuthResult<Option<DocSnapshotMeta>> {
      Ok(None)
    }

    async fn save_snapshot(
      &self,
      _doc_id: Uuid,
      _workspace_id: Uuid,
      _payload: Vec<u8>,
      _last_sequence: i64,
    ) -> AuthResult<()> {
      Ok(())
    }
  }

  #[async_trait]
  impl DocUpdateStore for RecordingDocStore {
    async fn push_update(&self, update: DocUpdateWrite) -> AuthResult<DocUpdatePersistenceResult> {
      let doc_id = match &update.target {
        DocWriteTarget::Internal(doc_id) => *doc_id,
        DocWriteTarget::External(document_key) => self
          .resolve_external_doc_id(update.workspace_id, update.space_kind.clone(), document_key.as_str())
          .await?
          .unwrap_or_else(Uuid::new_v4),
      };
      let outcome = match self.persistence_outcome.load(Ordering::Relaxed) {
        1 => DocUpdatePersistenceOutcome::ExactReplay,
        2 => DocUpdatePersistenceOutcome::CrdtNoop,
        _ => DocUpdatePersistenceOutcome::Persisted,
      };
      if !outcome.is_persisted() {
        return Ok(DocUpdatePersistenceResult {
          doc_id,
          auto_created_doc: false,
          outcome,
          page_registration: None,
        });
      }
      let sequence = self
        .updates
        .lock()
        .await
        .get(&(update.workspace_id, doc_id))
        .map_or(1, |updates| updates.len() as i64 + 1);
      let persisted = DocUpdate {
        workspace_id: update.workspace_id,
        doc_id,
        payload: update.payload,
        sequence,
        space_kind: update.space_kind,
      };
      self
        .updates
        .lock()
        .await
        .entry((persisted.workspace_id, doc_id))
        .or_default()
        .push(persisted);
      Ok(DocUpdatePersistenceResult {
        doc_id,
        auto_created_doc: true,
        outcome,
        page_registration: None,
      })
    }

    async fn get_updates_after(
      &self,
      workspace_id: Uuid,
      doc_id: Uuid,
      _after_sequence: i64,
    ) -> AuthResult<Vec<DocUpdate>> {
      self.update_payload_reads.fetch_add(1, Ordering::Relaxed);
      Ok(
        self
          .updates
          .lock()
          .await
          .get(&(workspace_id, doc_id))
          .cloned()
          .unwrap_or_default(),
      )
    }

    async fn count_pending_updates(&self, doc_id: Uuid) -> AuthResult<i64> {
      self.pending_count_reads.fetch_add(1, Ordering::Relaxed);
      Ok(
        self
          .updates
          .lock()
          .await
          .iter()
          .filter(|((_, candidate_doc_id), _)| *candidate_doc_id == doc_id)
          .map(|(_, updates)| updates.len() as i64)
          .sum(),
      )
    }

    async fn count_all_pending_updates(&self) -> AuthResult<i64> {
      Ok(
        self
          .updates
          .lock()
          .await
          .values()
          .map(|updates| updates.len() as i64)
          .sum(),
      )
    }

    async fn max_update_sequence(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<i64> {
      Ok(
        self
          .updates
          .lock()
          .await
          .get(&(workspace_id, doc_id))
          .and_then(|updates| updates.iter().map(|update| update.sequence).max())
          .unwrap_or(0),
      )
    }
  }

  #[async_trait]
  impl DocLoadStore for RecordingDocStore {
    async fn stream_doc_state(
      &self,
      _sync_operation_id: Uuid,
      workspace_id: Uuid,
      doc_id: Uuid,
      sender: tokio::sync::mpsc::Sender<Vec<u8>>,
      cancellation: DocLoadCancellation,
    ) -> AuthResult<DocStateStreamMeta> {
      let updates = self
        .updates
        .lock()
        .await
        .get(&(workspace_id, doc_id))
        .cloned()
        .unwrap_or_default();
      let mut stats = DocUpdateStreamStats::default();
      for update in updates {
        if cancellation.is_cancelled() {
          return Err(AuthError::DocSyncCancelled);
        }
        stats.update_count += 1;
        stats.input_bytes = stats.input_bytes.saturating_add(update.payload.len());
        sender
          .send(update.payload)
          .await
          .map_err(|_| AuthError::DocSyncCancelled)?;
      }
      Ok(DocStateStreamMeta {
        exists: true,
        has_real_content: stats.update_count > 0,
        stats,
        ..DocStateStreamMeta::default()
      })
    }
  }

  #[async_trait]
  impl DocMetadataStore for RecordingDocStore {
    async fn resolve_external_doc_id(
      &self,
      space_id: Uuid,
      space_kind: DocSpaceKind,
      external_id: &str,
    ) -> AuthResult<Option<Uuid>> {
      Ok(self.docs.lock().await.values().find_map(|doc| {
        let scope_matches = match space_kind {
          DocSpaceKind::Workspace => doc.workspace_id == Some(space_id),
          DocSpaceKind::Userspace => doc.userspace_owner_id == Some(space_id),
        };
        (scope_matches && doc.external_id == external_id).then_some(doc.id)
      }))
    }

    async fn create_doc_metadata(
      &self,
      workspace_id: Uuid,
      doc_id: Uuid,
      title: String,
      is_root: bool,
      created_by: Uuid,
    ) -> AuthResult<Doc> {
      let now = Utc::now();
      let doc = Doc {
        id: doc_id,
        external_id: doc_id.to_string(),
        workspace_id: Some(workspace_id),
        userspace_owner_id: None,
        title,
        meta: serde_json::Value::Null,
        blocked: false,
        is_workspace_root: is_root,
        public_mode: None,
        default_role: DocDefaultRole::Viewer,
        created_by: Some(created_by),
        updated_by: Some(created_by),
        created_at: now,
        updated_at: now,
        deleted_at: None,
      };
      self.docs.lock().await.insert(doc_id, doc.clone());
      Ok(doc)
    }

    async fn create_userspace_doc_metadata(&self, owner_id: Uuid, doc_id: Uuid, title: String) -> AuthResult<Doc> {
      let now = Utc::now();
      let doc = Doc {
        id: doc_id,
        external_id: doc_id.to_string(),
        workspace_id: None,
        userspace_owner_id: Some(owner_id),
        title,
        meta: serde_json::Value::Null,
        blocked: false,
        is_workspace_root: false,
        public_mode: None,
        default_role: DocDefaultRole::Viewer,
        created_by: Some(owner_id),
        updated_by: Some(owner_id),
        created_at: now,
        updated_at: now,
        deleted_at: None,
      };
      self.docs.lock().await.insert(doc_id, doc.clone());
      Ok(doc)
    }

    async fn get_doc_metadata(&self, doc_id: Uuid) -> AuthResult<Option<Doc>> {
      Ok(self.docs.lock().await.get(&doc_id).cloned())
    }

    async fn get_doc_metadata_batch(&self, doc_ids: &[Uuid]) -> AuthResult<HashMap<Uuid, Doc>> {
      let docs = self.docs.lock().await;
      Ok(
        doc_ids
          .iter()
          .filter_map(|id| docs.get(id).cloned().map(|doc| (*id, doc)))
          .collect(),
      )
    }

    async fn get_doc_attribution(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Option<DocAttribution>> {
      Ok(
        self
          .docs
          .lock()
          .await
          .get(&doc_id)
          .filter(|doc| doc.workspace_id == Some(workspace_id))
          .map(|doc| DocAttribution {
            created_at: doc.created_at,
            updated_at: doc.updated_at,
            created_by_name: None,
            created_by_avatar_key: None,
            updated_by_name: None,
            updated_by_avatar_key: None,
          }),
      )
    }

    async fn resolve_external_doc_ids(
      &self,
      workspace_id: Uuid,
      doc_ids: &[Uuid],
    ) -> AuthResult<HashMap<Uuid, String>> {
      Ok(
        self
          .docs
          .lock()
          .await
          .values()
          .filter(|doc| doc.workspace_id == Some(workspace_id) && doc_ids.contains(&doc.id))
          .map(|doc| (doc.id, doc.external_id.clone()))
          .collect(),
      )
    }

    async fn list_public_docs(&self, workspace_id: Uuid) -> AuthResult<Vec<Doc>> {
      let mut docs = self
        .docs
        .lock()
        .await
        .values()
        .filter(|doc| {
          doc.workspace_id == Some(workspace_id)
            && doc.deleted_at.is_none()
            && !doc.blocked
            && doc.public_mode.is_some()
        })
        .cloned()
        .collect::<Vec<_>>();
      docs.sort_by_key(|doc| std::cmp::Reverse(doc.updated_at));
      Ok(docs)
    }

    async fn update_doc_default_role(
      &self,
      workspace_id: Uuid,
      doc_id: Uuid,
      role: DocDefaultRole,
      actor_id: Uuid,
    ) -> AuthResult<Option<Doc>> {
      let mut docs = self.docs.lock().await;
      let Some(doc) = docs
        .get_mut(&doc_id)
        .filter(|doc| doc.workspace_id == Some(workspace_id) && doc.deleted_at.is_none())
      else {
        return Ok(None);
      };
      doc.default_role = role;
      doc.updated_by = Some(actor_id);
      doc.updated_at = Utc::now();
      Ok(Some(doc.clone()))
    }

    async fn update_doc_public_mode(
      &self,
      workspace_id: Uuid,
      doc_id: Uuid,
      public_mode: Option<String>,
      actor_id: Uuid,
    ) -> AuthResult<Option<Doc>> {
      let mut docs = self.docs.lock().await;
      let Some(doc) = docs
        .get_mut(&doc_id)
        .filter(|doc| doc.workspace_id == Some(workspace_id) && doc.deleted_at.is_none())
      else {
        return Ok(None);
      };
      doc.public_mode = public_mode;
      doc.updated_by = Some(actor_id);
      doc.updated_at = Utc::now();
      Ok(Some(doc.clone()))
    }

    async fn soft_delete_doc(&self, doc_id: Uuid) -> AuthResult<()> {
      if let Some(doc) = self.docs.lock().await.get_mut(&doc_id) {
        doc.deleted_at = Some(Utc::now());
      }
      Ok(())
    }

    async fn hard_delete_doc(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<()> {
      self.docs.lock().await.remove(&doc_id);
      self.updates.lock().await.remove(&(workspace_id, doc_id));
      Ok(())
    }

    async fn list_delete_candidates(
      &self,
      workspace_id: Uuid,
      external_ids: &[String],
    ) -> AuthResult<Vec<DocDeleteCandidate>> {
      Ok(
        self
          .docs
          .lock()
          .await
          .values()
          .filter(|doc| doc.workspace_id == Some(workspace_id) && external_ids.contains(&doc.external_id))
          .map(|doc| DocDeleteCandidate {
            doc_id: doc.id,
            client_doc_id: doc.external_id.clone(),
            title: doc.title.clone(),
            workspace_id,
            is_workspace_root: doc.is_workspace_root,
            deleted_at: doc.deleted_at,
          })
          .collect(),
      )
    }

    async fn list_trashed_delete_candidates(
      &self,
      workspace_id: Uuid,
      _limit: i64,
    ) -> AuthResult<Vec<DocDeleteCandidate>> {
      Ok(
        self
          .docs
          .lock()
          .await
          .values()
          .filter(|doc| doc.workspace_id == Some(workspace_id) && doc.deleted_at.is_some() && !doc.is_workspace_root)
          .map(|doc| DocDeleteCandidate {
            doc_id: doc.id,
            client_doc_id: doc.external_id.clone(),
            title: doc.title.clone(),
            workspace_id,
            is_workspace_root: doc.is_workspace_root,
            deleted_at: doc.deleted_at,
          })
          .collect(),
      )
    }

    async fn hard_delete_doc_scoped(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<bool> {
      self.hard_delete_doc(workspace_id, doc_id).await?;
      Ok(true)
    }

    async fn find_docs_without_title(&self, _workspace_id: Uuid, _limit: i64) -> AuthResult<Vec<Uuid>> {
      Ok(Vec::new())
    }

    async fn find_title_backfill_candidates(&self, _limit: i64) -> AuthResult<Vec<DocTitleBackfillCandidate>> {
      Ok(Vec::new())
    }

    async fn list_docs_in_workspace(&self, workspace_id: Uuid, _limit: i64, _offset: i64) -> AuthResult<Vec<Doc>> {
      Ok(
        self
          .docs
          .lock()
          .await
          .values()
          .filter(|doc| doc.workspace_id == Some(workspace_id) && doc.deleted_at.is_none())
          .cloned()
          .collect(),
      )
    }

    async fn list_content_docs_in_workspace(&self, workspace_id: Uuid, limit: i64) -> AuthResult<Vec<Doc>> {
      let mut docs = self
        .docs
        .lock()
        .await
        .values()
        .filter(|doc| doc.workspace_id == Some(workspace_id) && doc.deleted_at.is_none() && !doc.blocked)
        .cloned()
        .collect::<Vec<_>>();
      docs.sort_by_key(|doc| std::cmp::Reverse(doc.updated_at));
      docs.truncate(limit.max(0) as usize);
      Ok(docs)
    }

    async fn count_workspace_documents(&self, workspace_id: Uuid) -> AuthResult<i64> {
      Ok(
        self
          .docs
          .lock()
          .await
          .values()
          .filter(|doc| doc.workspace_id == Some(workspace_id) && doc.deleted_at.is_none() && !doc.is_workspace_root)
          .count() as i64,
      )
    }

    async fn get_space_doc_timestamps(
      &self,
      _workspace_id: Uuid,
      _after: Option<i64>,
    ) -> AuthResult<HashMap<String, i64>> {
      Ok(HashMap::new())
    }
  }

  #[async_trait]
  impl DocViewStore for RecordingDocStore {
    async fn record_doc_view(
      &self,
      _workspace_id: Uuid,
      _doc_id: &str,
      _is_unique: bool,
      _is_guest: bool,
    ) -> AuthResult<()> {
      Ok(())
    }

    async fn upsert_member_last_access(&self, _workspace_id: Uuid, _user_id: Uuid, _doc_id: &str) -> AuthResult<()> {
      Ok(())
    }

    async fn list_member_last_access(
      &self,
      _workspace_id: Uuid,
      _doc_id: &str,
      _query: Option<&str>,
      _limit: i64,
      _offset: i64,
    ) -> AuthResult<Vec<DocMemberLastAccess>> {
      Ok(Vec::new())
    }

    async fn count_member_last_access(&self, _workspace_id: Uuid, _doc_id: &str) -> AuthResult<i64> {
      Ok(0)
    }

    async fn list_doc_view_daily(
      &self,
      _workspace_id: Uuid,
      _doc_id: &str,
      _start: chrono::NaiveDate,
      _end: chrono::NaiveDate,
    ) -> AuthResult<Vec<DocViewDaily>> {
      Ok(Vec::new())
    }
  }

  #[async_trait]
  impl DocHistoryStore for RecordingDocStore {
    async fn capture_history(
      &self,
      _: Uuid,
      _: Uuid,
      _: crate::doc::history::HistoryCaptureProvenance,
      _: Option<crate::doc::history::NamedHistoryCapture>,
    ) -> Result<crate::doc::history::HistoryCapture, crate::doc::history::HistoryCaptureError> {
      panic!("history capture is not part of the write fixture");
    }
    async fn list_history_before(
      &self,
      _: Uuid,
      _: Uuid,
      _: Option<chrono::DateTime<Utc>>,
      _: Option<i64>,
      _: i64,
    ) -> AuthResult<Vec<DocHistoryMetadataEntry>> {
      panic!("RecordingDocStore does not model history pagination")
    }
    async fn create_history_entry(&self, _doc_id: Uuid, _workspace_id: Uuid, _snapshot: Vec<u8>) -> AuthResult<i64> {
      Ok(1)
    }

    async fn list_history(
      &self,
      _workspace_id: Uuid,
      _doc_id: Uuid,
      _skip: i64,
      _take: i64,
    ) -> AuthResult<Vec<DocHistoryMetadataEntry>> {
      Ok(Vec::new())
    }

    async fn get_history_metadata(&self, _: Uuid, _: Uuid, _: i64) -> AuthResult<Option<DocHistoryMetadataEntry>> {
      panic!("history metadata storage is not configured");
    }
    async fn get_history_entry(&self, _history_id: i64) -> AuthResult<Option<DocHistoryEntry>> {
      Ok(None)
    }

    async fn find_history_at_or_before(
      &self,
      _workspace_id: Uuid,
      _doc_id: Uuid,
      _timestamp: chrono::DateTime<Utc>,
    ) -> AuthResult<Option<DocHistoryEntry>> {
      Ok(None)
    }

    async fn delete_history_entry(&self, _history_id: i64) -> AuthResult<bool> {
      Ok(false)
    }
  }

  #[async_trait]
  impl DocPermissionStore for RecordingDocStore {
    async fn get_user_doc_role(&self, _user_id: Uuid, _doc_id: Uuid) -> AuthResult<Option<DocRole>> {
      Ok(None)
    }

    async fn upsert_user_doc_role(&self, _user_id: Uuid, _doc_id: Uuid, _role: DocRole) -> AuthResult<()> {
      Ok(())
    }

    async fn delete_user_doc_role(&self, _user_id: Uuid, _doc_id: Uuid) -> AuthResult<()> {
      Ok(())
    }

    async fn bulk_upsert_user_doc_roles(
      &self,
      _user_ids: &[Uuid],
      _doc_id: Uuid,
      _role: DocRole,
      _actor: Option<Uuid>,
    ) -> AuthResult<()> {
      Ok(())
    }

    async fn bulk_delete_user_doc_roles(&self, _user_ids: &[Uuid], _doc_id: Uuid) -> AuthResult<()> {
      Ok(())
    }

    async fn list_doc_permissions(&self, _doc_id: Uuid) -> AuthResult<Vec<(Uuid, DocRole)>> {
      Ok(Vec::new())
    }

    async fn list_granted_users(&self, _doc_id: Uuid) -> AuthResult<Vec<DocGrantedUser>> {
      Ok(Vec::new())
    }
  }

  impl DocStore for RecordingDocStore {}

  #[tokio::test]
  async fn external_update_at_limit_is_persisted() {
    let store = Arc::new(RecordingDocStore::default());
    let compaction = Arc::new(DocCompactionService::new(store.clone()));
    let write_service = DocWriteService::new(store.clone(), compaction).with_external_update_ingress_max_bytes(2);

    write_service
      .push_external_update_with_context(
        Uuid::new_v4(),
        None,
        Uuid::new_v4(),
        DocumentKey::parse("external-doc").unwrap(),
        vec![0, 0],
        0,
        DocSpaceKind::Workspace,
        None,
        None,
        None,
        None,
      )
      .await
      .expect("the valid update at the exact limit must be persisted");

    assert_eq!(
      store.updates.lock().await.values().map(Vec::len).sum::<usize>(),
      1,
      "a valid external update must reach the store exactly once"
    );
  }

  #[tokio::test]
  async fn external_update_over_limit_has_no_side_effects() {
    let store = Arc::new(RecordingDocStore::default());
    let compaction = Arc::new(DocCompactionService::new(store.clone()));
    let write_service = DocWriteService::new(store.clone(), compaction).with_external_update_ingress_max_bytes(2);

    let error = write_service
      .push_external_update_with_context(
        Uuid::new_v4(),
        None,
        Uuid::new_v4(),
        DocumentKey::parse("external-doc").unwrap(),
        vec![0, 0, 0],
        0,
        DocSpaceKind::Workspace,
        None,
        None,
        None,
        None,
      )
      .await
      .expect_err("an update over the decoded-byte limit must be rejected");

    assert!(matches!(error, AuthError::UpdateTooLarge { max_bytes: 2 }));
    assert!(
      store.updates.lock().await.is_empty(),
      "oversized input must not reach persistence"
    );
  }

  #[tokio::test]
  async fn invalid_external_update_has_no_side_effects() {
    let store = Arc::new(RecordingDocStore::default());
    let compaction = Arc::new(DocCompactionService::new(store.clone()));
    let write_service = DocWriteService::new(store.clone(), compaction);

    let error = write_service
      .push_external_update_with_context(
        Uuid::new_v4(),
        None,
        Uuid::new_v4(),
        DocumentKey::parse("external-doc").unwrap(),
        vec![0xff],
        0,
        DocSpaceKind::Workspace,
        None,
        None,
        None,
        None,
      )
      .await
      .expect_err("malformed Yjs input must be rejected");

    assert!(matches!(error, AuthError::InvalidYjsUpdate));
    assert!(
      store.updates.lock().await.is_empty(),
      "invalid input must not reach persistence"
    );
  }

  #[test]
  fn external_ingress_policy_preserves_default_decoder_capacity() {
    let store = Arc::new(RecordingDocStore::default());
    let compaction = Arc::new(DocCompactionService::new(store.clone()));
    let write_service = DocWriteService::new(store, compaction).with_external_update_ingress_max_bytes(4096);

    assert_eq!(write_service.external_update_ingress_policy.max_update_bytes, 4096);
    assert_eq!(
      write_service.external_update_ingress_policy.validation_permits,
      DEFAULT_EXTERNAL_VALIDATION_PERMITS
    );
    assert_eq!(
      write_service.decoder_semaphore.available_permits(),
      DEFAULT_EXTERNAL_VALIDATION_PERMITS
    );
  }

  #[tokio::test]
  async fn external_validation_concurrency_never_exceeds_selected_capacity() {
    let store = Arc::new(RecordingDocStore::default());
    let compaction = Arc::new(DocCompactionService::new(store.clone()));
    let write_service = Arc::new(DocWriteService::new(store.clone(), compaction));
    let semaphore = write_service.decoder_semaphore.clone();
    let mut held_permits = Vec::new();

    for _ in 0..DEFAULT_EXTERNAL_VALIDATION_PERMITS {
      held_permits.push(semaphore.clone().acquire_owned().await.expect("permit remains open"));
    }
    assert!(
      semaphore.clone().try_acquire_owned().is_err(),
      "another decoder must not be admitted while the configured capacity is occupied"
    );

    let blocked_write = {
      let write_service = write_service.clone();
      tokio::spawn(async move {
        write_service
          .push_external_update_with_context(
            Uuid::new_v4(),
            None,
            Uuid::new_v4(),
            DocumentKey::parse("external-doc").unwrap(),
            vec![0, 0],
            0,
            DocSpaceKind::Workspace,
            None,
            None,
            None,
            None,
          )
          .await
      })
    };
    for _ in 0..16 {
      tokio::task::yield_now().await;
    }
    assert!(
      !blocked_write.is_finished(),
      "an external validator must wait when the configured gate is full"
    );
    assert!(
      store.updates.lock().await.is_empty(),
      "a blocked validator must not persist early"
    );

    drop(held_permits);
    blocked_write
      .await
      .expect("the blocked external write task must finish after a permit is released")
      .expect("the valid update must persist after validation");
    assert_decoder_permits_returned(&semaphore, DEFAULT_EXTERNAL_VALIDATION_PERMITS).await;
  }

  #[tokio::test]
  async fn load_and_external_write_compete_for_the_same_decoder_permits() {
    for capacity in [8, 16] {
      let store = Arc::new(RecordingDocStore::default());
      let service = Arc::new(
        crate::doc::DocService::new_with_decoder_concurrency(store.clone(), capacity)
          .expect("configured decoder capacity")
          .with_compaction_thresholds(17, 3)
          .with_doc_cache(Arc::new(RecordingDocCache::default()))
          .with_external_update_ingress_max_bytes(4096),
      );
      let semaphore = service.decoder_semaphore.clone();
      assert!(Arc::ptr_eq(&semaphore, &service.load.decoder_semaphore));
      assert!(Arc::ptr_eq(&semaphore, &service.write.decoder_semaphore));
      let mut held_permits = Vec::new();
      for _ in 0..capacity {
        held_permits.push(semaphore.clone().acquire_owned().await.expect("permit remains open"));
      }

      let workspace_id = Uuid::new_v4();
      let doc_id = Uuid::new_v4();
      let blocked_load = {
        let service = service.clone();
        tokio::spawn(async move {
          service
            .load
            .load_diff_with_meta(
              Uuid::new_v4(),
              workspace_id,
              doc_id,
              None,
              4096,
              DocLoadCancellation::default(),
            )
            .await
        })
      };
      let blocked_write = {
        let service = service.clone();
        tokio::spawn(async move {
          service
            .write
            .push_external_update_with_context(
              Uuid::new_v4(),
              None,
              workspace_id,
              DocumentKey::parse("shared-decoder-doc").unwrap(),
              vec![0, 0],
              0,
              DocSpaceKind::Workspace,
              None,
              None,
              None,
              None,
            )
            .await
        })
      };
      for _ in 0..16 {
        tokio::task::yield_now().await;
      }
      assert!(
        !blocked_load.is_finished(),
        "load must wait behind the shared decoder gate"
      );
      assert!(
        !blocked_write.is_finished(),
        "write must wait behind the shared decoder gate"
      );

      drop(held_permits);
      blocked_load
        .await
        .expect("load task joins")
        .expect("load completes after a permit is released");
      blocked_write
        .await
        .expect("write task joins")
        .expect("write completes after a permit is released");
      assert_decoder_permits_returned(&semaphore, capacity).await;
    }
  }

  #[tokio::test]
  async fn replay_and_crdt_noop_skip_compaction_and_update_log_side_effects() {
    for expected in [
      DocUpdatePersistenceOutcome::ExactReplay,
      DocUpdatePersistenceOutcome::CrdtNoop,
    ] {
      let store = Arc::new(RecordingDocStore::with_persistence_outcome(expected));
      let compaction = Arc::new(DocCompactionService::new(store.clone()));
      let cache = Arc::new(RecordingDocCache::default());
      let write_service = DocWriteService::new(store.clone(), compaction).with_doc_cache(cache.clone());

      let result = write_service
        .push_update(Uuid::new_v4(), Uuid::new_v4(), vec![0, 0], 0, DocSpaceKind::Workspace)
        .await
        .expect("non-persisted outcome is acknowledged");
      assert_eq!(result.outcome, expected);
      assert!(store.updates.lock().await.is_empty());
      assert_eq!(
        store.pending_count_reads.load(Ordering::Relaxed),
        0,
        "non-persisted outcomes must not enter the compaction threshold path"
      );
      assert_eq!(
        cache.invalidations.load(Ordering::Relaxed),
        0,
        "non-persisted outcomes must not invalidate any document cache"
      );
    }
  }

  #[tokio::test]
  async fn compaction_threshold_checks_do_not_load_update_payloads() {
    let store = Arc::new(RecordingDocStore::default());
    let workspace_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let compaction = DocCompactionService::new(store.clone()).with_thresholds(2, 2);
    store.updates.lock().await.insert(
      (workspace_id, doc_id),
      vec![DocUpdate {
        workspace_id,
        doc_id,
        payload: vec![0, 0],
        sequence: 1,
        space_kind: DocSpaceKind::Workspace,
      }],
    );

    compaction
      .maybe_compact(workspace_id, doc_id)
      .await
      .expect("one pending update is below the threshold");
    assert_eq!(
      store.update_payload_reads.load(Ordering::Relaxed),
      0,
      "the threshold decision must use COUNT instead of materializing payloads"
    );

    let merged = compaction
      .merge_pending_updates(workspace_id, doc_id, 2)
      .await
      .expect("explicit merge below its minimum is a no-op");
    assert_eq!(merged, 0);
    assert_eq!(
      store.update_payload_reads.load(Ordering::Relaxed),
      0,
      "the explicit minimum check must also avoid loading payloads"
    );
  }

  #[tokio::test]
  async fn rejection_metric_uses_only_allowlisted_reason_labels() {
    let store = Arc::new(RecordingDocStore::default());
    let compaction = Arc::new(DocCompactionService::new(store.clone()));
    let mut policy = MetricsPolicy {
      enabled: true,
      ..Default::default()
    };
    policy
      .categories
      .insert(MetricsCategory::Collab.as_str().to_string(), true);
    let metrics = Arc::new(crate::metrics::MetricsService::new(
      Arc::new(InMemoryMetricsRecorder::new(policy)),
      Arc::new(crate::metrics::service::InMemoryMetricsRepo),
    ));
    let write_service = DocWriteService::new(store, compaction)
      .with_external_update_ingress_max_bytes(2)
      .with_metrics_service(metrics.clone());
    let key = || DocumentKey::parse("external-doc").unwrap();

    let _ = write_service
      .push_external_update_with_context(
        Uuid::new_v4(),
        None,
        Uuid::new_v4(),
        key(),
        vec![0, 0, 0],
        0,
        DocSpaceKind::Workspace,
        None,
        None,
        None,
        None,
      )
      .await;
    let _ = write_service
      .push_external_update_with_context(
        Uuid::new_v4(),
        None,
        Uuid::new_v4(),
        key(),
        vec![0xff],
        0,
        DocSpaceKind::Workspace,
        None,
        None,
        None,
        None,
      )
      .await;
    write_service.decoder_semaphore.close();
    let _ = write_service
      .push_external_update_with_context(
        Uuid::new_v4(),
        None,
        Uuid::new_v4(),
        key(),
        vec![0, 0],
        0,
        DocSpaceKind::Workspace,
        None,
        None,
        None,
        None,
      )
      .await;

    let samples = metrics.recorder().inspect_series(Utc::now());
    assert_eq!(samples.len(), 3);
    for sample in samples {
      assert_eq!(sample.metric_name, "yjs_ingress_rejected");
      let labels = sample.labels.as_object().expect("metric labels are an object");
      assert_eq!(labels.len(), 1);
      assert!(matches!(
        labels.get("reason").and_then(serde_json::Value::as_str),
        Some("too_large" | "invalid" | "validator_unavailable")
      ));
    }
  }
}
