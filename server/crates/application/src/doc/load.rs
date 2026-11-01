//! P102-SVC-01: DocLoadService — document loading sub-service.
//!
//! Encapsulates the two doc-load paths extracted from `DocService`:
//! - `load_full_doc` — merge snapshot + all pending updates into a single binary Yjs state.
//! - `load_full_doc_with_meta` — same merge, plus doc existence and snapshot metadata.
//! - `load_full_doc_with_tracking` — `load_full_doc_with_meta` + fire-and-forget view tracking.
//!
//! This module also owns the process-level `DOC_VIEW_DEDUP` / `DOC_VIEW_DEDUP_DATE` statics
//! (moved here from `api::websocket` in P102-VIEW-01) so all call sites (WS, REST, MCP) share
//! the same deduplication set.

use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, NaiveDate, Utc};
use dashmap::DashSet;
use tracing::{debug, instrument, trace};
use uuid::Uuid;
use yrs::{ReadTxn, Transact};

use crate::auth::{AuthError, AuthResult};
use crate::doc::{DocCachePort, DocLoadCancellation, DocLoadDiffResult, DocLoadResult, DocSnapshotMeta, DocStore};
use crate::workspace::WorkspaceService;
use tokio::sync::Semaphore;

// ─── Process-level dedup set for unique doc views ────────────────────────────
//
// Key: `(user_id, workspace_id, doc_id_string, date)`.
// An entry means the user already counted as a unique viewer for that (doc,
// workspace) pair today. `workspace_id` is included so that the same doc
// accessible from two workspaces (e.g. via share link) counts separately.
//
// Concurrency: `DashSet::insert` is atomic — exactly one racing task sees
// `true` (unique) and all others see `false` (duplicate). No double-counting.
//
// Eviction: the `flush_analytics` loop in `api::websocket` calls `retain()` on
// day-change using `DOC_VIEW_DEDUP_DATE` to remove yesterday's entries.
pub static DOC_VIEW_DEDUP: std::sync::LazyLock<DashSet<(Uuid, Uuid, String, NaiveDate)>> =
  std::sync::LazyLock::new(DashSet::new);

/// Tracks the last date on which `DOC_VIEW_DEDUP` was evicted.
/// Compared against `Utc::now().date_naive()` in `flush_analytics`.
pub static DOC_VIEW_DEDUP_DATE: std::sync::LazyLock<std::sync::Mutex<NaiveDate>> =
  std::sync::LazyLock::new(|| std::sync::Mutex::new(chrono::Utc::now().date_naive()));

/// Sub-service responsible for loading (reading) document state.
///
/// Constructed by `DocService::new` and exposed as `DocService::load`.
/// Can also be injected directly into components that only need read access.
#[derive(Clone)]
pub struct DocLoadService {
  pub(crate) store: Arc<dyn DocStore>,
  /// P102-CACHE-01/02/03: Optional doc cache port. When `None`, all cache
  /// lookups are skipped and the service falls back to DB reads.
  pub(crate) doc_cache: Option<Arc<dyn DocCachePort>>,
  /// One server-wide decoder gate shared with external write validation.
  pub(crate) decoder_semaphore: Arc<Semaphore>,
}

impl DocLoadService {
  pub fn new(store: Arc<dyn DocStore>) -> Self {
    Self::new_with_decoder_gate(
      store,
      Arc::new(Semaphore::new(
        myoxus_contracts::effective_config::DEFAULT_DOC_DECODER_CONCURRENCY,
      )),
    )
  }

  pub(crate) fn new_with_decoder_gate(store: Arc<dyn DocStore>, decoder_semaphore: Arc<Semaphore>) -> Self {
    Self {
      store,
      doc_cache: None,
      decoder_semaphore,
    }
  }

  /// Attach a [`DocCachePort`] implementation to enable Redis-backed caching.
  pub fn with_doc_cache(mut self, cache: Arc<dyn DocCachePort>) -> Self {
    self.doc_cache = Some(cache);
    self
  }

  /// Stream snapshot and ordered tail into one bounded Yjs materialization.
  ///
  /// A capacity-one Tokio channel is the ownership boundary between the async
  /// repository cursor and one `spawn_blocking` consumer. The consumer holds a
  /// permit from the same configured decoder semaphore used by external writes,
  /// applies every update directly to one Yrs document, then derives both the
  /// server state vector and client diff from that document. Decode, size or
  /// cancellation failures never return a full-document fallback.
  #[instrument(skip(self, client_state_vector, cancellation), fields(%sync_operation_id, %workspace_id, %doc_id))]
  pub async fn load_diff_with_meta(
    &self,
    sync_operation_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    client_state_vector: Option<Vec<u8>>,
    max_payload_bytes: usize,
    cancellation: DocLoadCancellation,
  ) -> AuthResult<DocLoadDiffResult> {
    if cancellation.is_cancelled() {
      return Err(AuthError::DocSyncCancelled);
    }
    if client_state_vector
      .as_ref()
      .is_some_and(|state| state.len() > max_payload_bytes)
    {
      return Err(AuthError::DocSyncPayloadTooLarge {
        max_bytes: max_payload_bytes,
      });
    }

    let wait_started = Instant::now();
    let permit = tokio::select! {
      _ = cancellation.cancelled() => return Err(AuthError::DocSyncCancelled),
      permit = self.decoder_semaphore.clone().acquire_owned() => {
        permit.map_err(|_| AuthError::YjsDecoderUnavailable)?
      }
    };
    let decoder_wait_ms = wait_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let materialize_started = Instant::now();
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
    let consumer_cancellation = cancellation.clone();
    let consumer = tokio::task::spawn_blocking(move || {
      let _permit = permit;
      yjs::materialize_diff_v1(
        std::iter::from_fn(move || receiver.blocking_recv()),
        client_state_vector.as_deref(),
        max_payload_bytes,
        || consumer_cancellation.is_cancelled(),
      )
    });

    let stream_result = self
      .store
      .stream_doc_state(
        sync_operation_id,
        workspace_id,
        doc_id,
        sender.clone(),
        cancellation.clone(),
      )
      .await;
    drop(sender);
    let materialized = consumer.await.map_err(|_| AuthError::YjsDecoderUnavailable)?;
    let materialized = match materialized {
      Ok(result) => result,
      Err(yjs::YjsDiffMaterializationError::Cancelled) => return Err(AuthError::DocSyncCancelled),
      Err(yjs::YjsDiffMaterializationError::InvalidStateVector) => {
        return Err(AuthError::InvalidYjsStateVector);
      }
      Err(yjs::YjsDiffMaterializationError::InputTooLarge) => {
        return Err(AuthError::DocSyncPayloadTooLarge {
          max_bytes: max_payload_bytes,
        });
      }
      Err(yjs::YjsDiffMaterializationError::WorkerUnavailable) => {
        return Err(AuthError::YjsDecoderUnavailable);
      }
      Err(yjs::YjsDiffMaterializationError::InvalidUpdate | yjs::YjsDiffMaterializationError::ApplyFailed) => {
        return Err(AuthError::Storage(
          "persisted Yjs document state is invalid".to_string(),
        ));
      }
    };
    let stream_meta = stream_result?;
    debug_assert_eq!(
      materialized.update_count, stream_meta.stats.update_count,
      "materializer and repository stream accounting diverged"
    );
    debug_assert_eq!(
      materialized.input_bytes, stream_meta.stats.input_bytes,
      "materializer and repository byte accounting diverged"
    );
    let output_bytes = materialized
      .missing
      .len()
      .saturating_add(materialized.state_vector.len());
    if output_bytes > max_payload_bytes {
      return Err(AuthError::DocSyncPayloadTooLarge {
        max_bytes: max_payload_bytes,
      });
    }
    let materialize_ms = materialize_started.elapsed().as_millis().min(u64::MAX as u128) as u64;

    Ok(DocLoadDiffResult {
      revision: stream_meta.revision,
      has_real_content: stream_meta.has_real_content,
      missing: materialized.missing,
      state_vector: materialized.state_vector,
      updated_at: stream_meta.updated_at,
      exists: stream_meta.exists,
      input_bytes: materialized.input_bytes,
      update_count: materialized.update_count,
      decoder_wait_ms,
      materialize_ms,
    })
  }

  /// Read content and its sequence from the repository's single consistent
  /// snapshot/tail stream. The legacy payload-only cache has no revision and
  /// therefore cannot satisfy this boundary. Reads never create history.
  #[instrument(skip(self), fields(%workspace_id, %doc_id))]
  pub async fn load_full_doc_with_revision(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<super::DocContentState> {
    let loaded = self
      .load_diff_with_meta(
        Uuid::new_v4(),
        workspace_id,
        doc_id,
        None,
        usize::MAX,
        DocLoadCancellation::default(),
      )
      .await?;
    if !loaded.exists {
      return Err(AuthError::NotFound("document".to_string()));
    }
    Ok(super::DocContentState {
      payload: loaded.missing,
      revision: loaded.revision,
      has_real_content: loaded.has_real_content,
    })
  }

  /// Load one complete source/revision pair while bounding bytes before Yjs
  /// projection. Exceeding the limit aborts materialization; callers never
  /// receive or render a truncated CRDT update.
  #[instrument(skip(self), fields(%workspace_id, %doc_id, max_input_bytes))]
  pub async fn load_full_doc_with_revision_bounded(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    max_input_bytes: usize,
  ) -> AuthResult<super::DocContentState> {
    let loaded = self
      .load_diff_with_meta(
        Uuid::new_v4(),
        workspace_id,
        doc_id,
        None,
        max_input_bytes,
        DocLoadCancellation::default(),
      )
      .await?;
    if !loaded.exists {
      return Err(AuthError::NotFound("document".to_string()));
    }
    Ok(super::DocContentState {
      payload: loaded.missing,
      revision: loaded.revision,
      has_real_content: loaded.has_real_content,
    })
  }

  /// Lädt ein Dokument als fertigen Yjs-Binary-State (Snapshot + alle pending Updates gemergt).
  ///
  /// **Merge-Strategie** (entspricht NestJS storage-Verhalten):
  /// 1. Snapshot mit `last_sequence` aus `DocStore::get_snapshot_with_meta` holen.
  /// 2. Nur Updates nach `last_sequence` via `get_updates_after` holen.
  /// 3. Wenn keine Updates vorhanden: Snapshot direkt zurückgeben (kein Merge nötig).
  ///    Wenn Snapshot und Updates leer: leeren initialen Yjs-State erzeugen.
  /// 4. Snapshot + Updates werden via `yrs::merge_updates` zusammengeführt
  ///    (LRN-20260405-290/292: yrs-basierter Merge ist korrekter als y-octo für diesen Pfad).
  ///
  /// `doc_snapshots.payload` ist bereits bis `doc_snapshots.last_sequence`
  /// kompaktiert. Ein erneutes Mergen mit allen historischen Updates kann bei
  /// Root-Metadaten alte CRDT-Werte wieder sichtbar machen; deshalb muss dieser
  /// Pfad denselben Sequenzvertrag wie `load_full_doc_with_meta` einhalten.
  ///
  /// **Hinweis (P102-UNIFY-03)**: `workspace_id` wird jetzt an die Store-Methoden
  /// weitergegeben für Defense-in-Depth (kein Cross-Workspace-Datenleck).
  /// - `deleted_at` wird **nicht** geprüft — auch soft-gelöschte Docs werden geladen.
  ///   Die aufrufende API-Schicht muss diese Prüfung selbst durchführen.
  #[instrument(skip(self))]
  pub async fn load_full_doc(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Vec<u8>> {
    trace!(%workspace_id, %doc_id, "loading full document");
    let snap_meta = self.store.get_snapshot_with_meta(workspace_id, doc_id).await?;
    let (snapshot, last_sequence) = match snap_meta {
      Some(meta) => (meta.payload, meta.last_sequence),
      None => (Vec::new(), -1),
    };
    let updates = self
      .store
      .get_updates_after(workspace_id, doc_id, last_sequence)
      .await?;

    if updates.is_empty() {
      if snapshot.is_empty() {
        debug!(%workspace_id, %doc_id, "document is empty, generating initial state");
        return Ok(yrs::Doc::new().transact().encode_diff_v1(&yrs::StateVector::default()));
      }
      // Return snapshot directly — matches NestJS behavior (storage getDoc
      // returns snapshot as-is when no pending updates exist).
      trace!(%workspace_id, %doc_id, snapshot_size = snapshot.len(), "returning snapshot directly (no pending updates)");
      return Ok(snapshot);
    }

    let update_count = updates.len();
    let update_payloads: Vec<Vec<u8>> = updates.into_iter().map(|u| u.payload).collect();
    let mut all_updates = vec![snapshot];
    all_updates.extend(update_payloads);

    debug!(%workspace_id, %doc_id, update_count, "merging snapshot and updates for document");
    let merge_start = std::time::Instant::now();
    let result = yjs::merge_updates(all_updates).map_err(AuthError::Storage)?;
    let merge_ms = merge_start.elapsed().as_millis();
    debug!(%workspace_id, %doc_id, update_count, merged_size = result.len(), merge_ms, "merge complete");
    Ok(result)
  }

  /// Lädt ein Dokument und gibt neben dem gemergten Payload auch Metadaten zurück.
  ///
  /// Im Gegensatz zu `load_full_doc` prüft diese Methode auch die Existenz des
  /// Dokuments (`docs`-Tabelle) und gibt `updated_at` aus dem Snapshot zurück.
  /// Wird für den X-Doc-Timestamp Response-Header benötigt.
  ///
  /// P102-CACHE-01: Checks the snapshot cache first. On a cache hit, the merged
  /// payload is returned immediately; metadata (exists, updated_at) is assumed
  /// valid (document is live). This trades a small metadata-staleness window for
  /// reduced DB load on the hot read path.
  #[instrument(skip(self))]
  pub async fn load_full_doc_with_meta(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<DocLoadResult> {
    trace!(%workspace_id, %doc_id, "loading full document with metadata");

    // P102-CACHE-01: snapshot cache-first
    if let Some(cache) = &self.doc_cache
      && let Some(cached_payload) = cache.get_snapshot(workspace_id, doc_id).await
    {
      trace!(%workspace_id, %doc_id, bytes = cached_payload.len(), "snapshot cache HIT — skipping DB merge");
      // PFLICHT-6: read updated_at_ms from metadata cache so x-doc-timestamp header is set
      // even on cache hits. Written by the snapshot write-through paths below.
      let updated_at = cache
        .get_metadata(doc_id)
        .await
        .and_then(|m| m.get("updated_at_ms").and_then(|v| v.as_i64()))
        .and_then(DateTime::from_timestamp_millis);
      return Ok(DocLoadResult {
        payload: cached_payload,
        updated_at,
        exists: true,
        has_real_content: true,
      });
    }

    // P103-A-01: metadata cache-first — avoids a DB round-trip per load_with_meta call.
    // Cache stores exists + deleted_at status as JSON. Miss → DB + write-through.
    // LRN-20260424-USERSPACE-LOAD: cache HIT must respect BOTH exists and deleted_at;
    // earlier revisions read only deleted_at, which flipped the result between cache
    // miss and hit for docs that legitimately have no row (userspace personal docs).
    let exists = if let Some(cache) = &self.doc_cache {
      if let Some(meta_json) = cache.get_metadata(doc_id).await {
        trace!(%doc_id, "metadata cache HIT");
        let found = meta_json.get("exists").and_then(|v| v.as_bool()).unwrap_or(true);
        let deleted = meta_json.get("deleted_at").and_then(|v| v.as_bool()).unwrap_or(false);
        if found && !deleted {
          true
        } else {
          // Negative metadata is correctness-sensitive: a document can be created
          // after an earlier DOC_NOT_FOUND cache entry, especially through the
          // Webclient sync auto-create path. Verify negative hits against the DB
          // instead of serving stale DOC_NOT_FOUND until the Redis TTL expires.
          debug!(%doc_id, "negative metadata cache HIT — verifying against DB");
          let doc_meta = self.store.get_doc_metadata(doc_id).await?;
          let deleted = doc_meta.as_ref().and_then(|m| m.deleted_at).is_some();
          let found = doc_meta.is_some();
          cache
            .set_metadata(doc_id, &serde_json::json!({ "exists": found, "deleted_at": deleted }))
            .await;
          found && !deleted
        }
      } else {
        trace!(%doc_id, "metadata cache MISS — querying DB");
        let doc_meta = self.store.get_doc_metadata(doc_id).await?;
        let deleted = doc_meta.as_ref().and_then(|m| m.deleted_at).is_some();
        let found = doc_meta.is_some();
        // write-through: cache exists + deleted status for next call
        cache
          .set_metadata(doc_id, &serde_json::json!({ "exists": found, "deleted_at": deleted }))
          .await;
        found && !deleted
      }
    } else {
      let doc_meta = self.store.get_doc_metadata(doc_id).await?;
      doc_meta.map(|m| m.deleted_at.is_none()).unwrap_or(false)
    };

    let snap_meta: Option<DocSnapshotMeta> = self.store.get_snapshot_with_meta(workspace_id, doc_id).await?;
    let (last_seq, updated_at, snapshot_payload) = match snap_meta {
      Some(m) => (m.last_sequence, Some(m.updated_at), m.payload),
      None => (-1i64, None, vec![]),
    };

    let updates = self.store.get_updates_after(workspace_id, doc_id, last_seq).await?;

    if updates.is_empty() && snapshot_payload.is_empty() {
      debug!(%workspace_id, %doc_id, "document is empty (no snapshot, no updates)");
      return Ok(DocLoadResult {
        payload: vec![],
        updated_at,
        exists,
        has_real_content: false,
      });
    }

    if updates.is_empty() {
      trace!(%workspace_id, %doc_id, snapshot_size = snapshot_payload.len(), "returning snapshot directly (no pending updates)");
      // P102-CACHE-01: write-through on snapshot-only path.
      // PFLICHT-6: also store updated_at_ms in metadata cache for x-doc-timestamp on future cache hits.
      if let Some(cache) = &self.doc_cache {
        cache.set_snapshot(workspace_id, doc_id, &snapshot_payload).await;
        let updated_at_ms = updated_at.map(|dt: DateTime<Utc>| dt.timestamp_millis());
        cache
          .set_metadata(
            doc_id,
            &serde_json::json!({ "exists": exists, "deleted_at": false, "updated_at_ms": updated_at_ms }),
          )
          .await;
      }
      return Ok(DocLoadResult {
        payload: snapshot_payload,
        updated_at,
        exists,
        has_real_content: true,
      });
    }

    let update_count = updates.len();
    let mut all = vec![snapshot_payload];
    all.extend(updates.into_iter().map(|u| u.payload));

    debug!(%workspace_id, %doc_id, update_count, "merging snapshot and updates");
    let merge_start = std::time::Instant::now();
    let payload = yjs::merge_updates(all).map_err(AuthError::Storage)?;
    let merge_ms = merge_start.elapsed().as_millis();
    debug!(%workspace_id, %doc_id, update_count, merged_size = payload.len(), merge_ms, "merge complete");
    // P102-CACHE-01: write-through after merge.
    // PFLICHT-6: also store updated_at_ms in metadata cache for x-doc-timestamp on future cache hits.
    if exists && let Some(cache) = &self.doc_cache {
      cache.set_snapshot(workspace_id, doc_id, &payload).await;
      let updated_at_ms = updated_at.map(|dt: DateTime<Utc>| dt.timestamp_millis());
      cache
        .set_metadata(
          doc_id,
          &serde_json::json!({ "exists": true, "deleted_at": false, "updated_at_ms": updated_at_ms }),
        )
        .await;
    }
    Ok(DocLoadResult {
      payload,
      updated_at,
      exists,
      has_real_content: true,
    })
  }

  /// Loads a document **and** fires view tracking in the background (P102-VIEW-01).
  ///
  /// Combines `load_full_doc_with_meta` with fire-and-forget analytics so that
  /// REST, WebSocket, and MCP call sites all record views via a single path.
  ///
  /// # Parameters
  ///
  /// - `is_workspace_space` — must be `false` for userspace docs (P96-F1). When
  ///   `false`, view tracking is silently skipped (FK constraints on
  ///   `workspace_doc_view_daily` / `workspace_member_last_access` would fail for
  ///   the user's personal space UUID which has no row in `workspaces`).
  /// - `workspace_service` — used for guest detection: a user who passes auth but
  ///   has no membership record is counted as a guest (P80-K-01).
  ///
  /// # Tracking invariants
  ///
  /// - Fire-and-forget: view tracking NEVER blocks the doc response.
  /// - Dedup: same `(user, workspace, doc, day)` → only the first call is unique.
  /// - Guest detection: `workspace_service.get_member` returning `None` → `is_guest=true`.
  #[instrument(skip(self, workspace_service))]
  pub async fn load_full_doc_with_tracking(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    user_id: Uuid,
    is_workspace_space: bool,
    workspace_service: WorkspaceService,
  ) -> AuthResult<DocLoadResult> {
    let result = self.load_full_doc_with_meta(workspace_id, doc_id).await?;

    if is_workspace_space && result.exists {
      let store = self.store.clone();
      let doc_id_str = doc_id.to_string();
      let ws_svc = workspace_service;
      // P102-CACHE-03: clone the cache handle for the spawned task.
      let view_cache = self.doc_cache.clone();
      tokio::spawn(async move {
        let today = chrono::Utc::now().date_naive();
        // P102-CACHE-03: use Redis dedup when cache is available, fall back to DashSet.
        let is_unique = if let Some(cache) = &view_cache {
          cache
            .check_and_set_view_dedup(user_id, workspace_id, &doc_id_str, today)
            .await
        } else {
          DOC_VIEW_DEDUP.insert((user_id, workspace_id, doc_id_str.clone(), today))
        };

        // P80-K-01: A user who passed auth but has no membership is a guest
        // (e.g. public workspace or share link access).
        let is_guest = match ws_svc.get_member(workspace_id, user_id).await {
          Ok(Some(_)) => false,
          Ok(None) => true,
          Err(e) => {
            trace!(%workspace_id, %user_id, error = %e, "guest detection failed, defaulting to non-guest");
            false
          }
        };

        if let Err(e) = store
          .record_doc_view(workspace_id, &doc_id_str, is_unique, is_guest)
          .await
        {
          tracing::warn!(%workspace_id, doc_id = %doc_id_str, error = %e, "failed to record doc view");
        }
        if let Err(e) = store
          .upsert_member_last_access(workspace_id, user_id, &doc_id_str)
          .await
        {
          tracing::warn!(%workspace_id, %user_id, doc_id = %doc_id_str, error = %e, "failed to upsert member last access");
        }
      });
    }

    Ok(result)
  }

  /// Fire-and-forget view tracking **without** reloading the document (P102-VIEW-04).
  ///
  /// Use this when the caller already has the document content and only needs to
  /// record the view event (e.g. MCP `read_doc` which loads via `get_snapshot`).
  ///
  /// The tracking is spawned on the current Tokio runtime and returns immediately.
  /// If `is_workspace_space` is `false` the call is a no-op.
  pub fn fire_view_tracking(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    user_id: Uuid,
    is_workspace_space: bool,
    workspace_service: WorkspaceService,
  ) {
    if !is_workspace_space {
      return;
    }
    let store = self.store.clone();
    let doc_id_str = doc_id.to_string();
    let ws_svc = workspace_service;
    let view_cache = self.doc_cache.clone();
    tokio::spawn(async move {
      let today = chrono::Utc::now().date_naive();
      // P102-CACHE-03: use Redis dedup when cache is available, fall back to DashSet.
      let is_unique = if let Some(cache) = &view_cache {
        cache
          .check_and_set_view_dedup(user_id, workspace_id, &doc_id_str, today)
          .await
      } else {
        DOC_VIEW_DEDUP.insert((user_id, workspace_id, doc_id_str.clone(), today))
      };

      let is_guest = match ws_svc.get_member(workspace_id, user_id).await {
        Ok(Some(_)) => false,
        Ok(None) => true,
        Err(e) => {
          trace!(%workspace_id, %user_id, error = %e, "guest detection failed, defaulting to non-guest");
          false
        }
      };

      if let Err(e) = store
        .record_doc_view(workspace_id, &doc_id_str, is_unique, is_guest)
        .await
      {
        tracing::warn!(%workspace_id, doc_id = %doc_id_str, error = %e, "failed to record doc view");
      }
      if let Err(e) = store
        .upsert_member_last_access(workspace_id, user_id, &doc_id_str)
        .await
      {
        tracing::warn!(%workspace_id, %user_id, doc_id = %doc_id_str, error = %e, "failed to upsert member last access");
      }
    });
  }
}
