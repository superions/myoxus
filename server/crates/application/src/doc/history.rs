//! P102-SVC-04: DocHistoryService — document history sub-service.
//!
//! Encapsulates the history paths extracted from `DocService`:
//! - `capture_history_snapshot` — persist a history entry for rollback.
//! - `restore` — derive fresh operations against the locked current document.
//! - `rollback_to_history` — legacy entry into the same atomic restore owner.
//! - `list_history` — list history entries for a document.
//!
//! Capture materializes content inside the store's document transaction, not
//! through the live read cache. `DocLoadService` supplies post-commit cache
//! invalidation. Recovery, content, version head, audit and sync outbox commit
//! together; business metadata is never restored from historical Yjs content.

use std::sync::Arc;

use tracing::{debug, info, instrument};

use crate::auth::{AuthError, AuthResult};
use crate::doc::load::DocLoadService;
use crate::doc::{DocHistoryMetadataEntry, DocStore};

use crate::document_version::label_service::PreparedDocumentVersionLabel;
use myoxus_domain::entities::{DocumentVersion, DocumentVersionEvent, DocumentVersionKind};
use uuid::Uuid;

/// Selected lineage-projected history and the current snapshot/tail revision
/// from one current-owner database read. This port performs no capture or ack.
pub struct DocHistoryComparisonRead {
  pub history_id: i64,
  pub history_snapshot: Vec<u8>,
  pub current_snapshot: Vec<u8>,
  pub current_revision: i64,
  pub read_at: chrono::DateTime<chrono::Utc>,
}

pub struct DocHistoryComparison {
  pub history_id: i64,
  pub current_revision: i64,
  pub read_at: chrono::DateTime<chrono::Utc>,
  pub diff: crate::document_version::DocumentVersionDiff,
}

/// Exact, content-free reference projection retained in the transfer manifest.
/// A missing lineage is not inferred from timestamps or another snapshot.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DocHistoryReferenceLineage {
  pub history_id: i64,
  pub doc_id: Uuid,
  /// Causal predecessor for this immutable snapshot, never timestamp order.
  pub previous_operation_id: Option<Uuid>,
  /// The plan binds the original immutable snapshot hash and source identity.
  pub plan: crate::workspace_content_operation::WorkspaceContentNativeReferencePlan,
}

/// Persisted provenance for history created after provenance tracking was
/// introduced. A missing value denotes an older row and must not be guessed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocHistoryOrigin {
  Manual,
  Automatic,
  Publish,
  PdfExport,
  Daily,
  Api,
  Restore,
  Recovery,
}

impl DocHistoryOrigin {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Manual => "manual",
      Self::Automatic => "automatic",
      Self::Publish => "publish",
      Self::PdfExport => "pdf_export",
      Self::Daily => "daily",
      Self::Api => "api",
      Self::Restore => "restore",
      Self::Recovery => "recovery",
    }
  }

  pub fn parse(value: &str) -> Option<Self> {
    match value {
      "manual" => Some(Self::Manual),
      "automatic" => Some(Self::Automatic),
      "publish" => Some(Self::Publish),
      "pdf_export" => Some(Self::PdfExport),
      "daily" => Some(Self::Daily),
      "api" => Some(Self::Api),
      "restore" => Some(Self::Restore),
      "recovery" => Some(Self::Recovery),
      _ => None,
    }
  }

  pub fn from_version_event(event: DocumentVersionEvent) -> Self {
    match event {
      DocumentVersionEvent::Manual => Self::Manual,
      DocumentVersionEvent::Publish => Self::Publish,
      DocumentVersionEvent::PdfExport => Self::PdfExport,
      DocumentVersionEvent::Daily => Self::Daily,
      DocumentVersionEvent::Api => Self::Api,
      DocumentVersionEvent::Restore => Self::Restore,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryCaptureProvenance {
  pub origin: DocHistoryOrigin,
  pub actor_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
pub struct NamedHistoryCapture {
  pub actor_id: Uuid,
  pub label: PreparedDocumentVersionLabel,
  pub description: Option<String>,
  pub event: DocumentVersionEvent,
  pub kind: DocumentVersionKind,
  /// Compare with the latest named snapshot while holding the document lock.
  pub skip_unchanged: bool,
}

/// Replay protection for explicit history saves and immutable operation sources.
/// The caller fingerprints the normalized request, excluding generated label counters.
#[derive(Debug, Clone)]
pub struct HistoryCaptureIdempotency {
  pub actor_id: Uuid,
  pub request_key: Uuid,
  pub fingerprint: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct HistorySaveRequest {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub provenance: HistoryCaptureProvenance,
  pub named: Option<NamedHistoryCapture>,
  pub idempotency: HistoryCaptureIdempotency,
}

#[derive(Debug)]
pub struct HistorySaveCommit {
  pub capture: HistoryCapture,
  pub replayed: bool,
}

/// Bind a deliberate name to one already captured immutable state.
/// `expected_version_ids` prevents two stale naming dialogs from silently
/// creating competing references while retaining existing multi-label states.
#[derive(Debug, Clone)]
pub struct HistoryNameRequest {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub history_id: i64,
  pub expected_version_ids: Vec<Uuid>,
  pub named: NamedHistoryCapture,
}

#[derive(Debug)]
pub struct HistoryNameCommit {
  pub version: DocumentVersion,
  pub replayed: bool,
}

#[derive(Debug)]
pub enum HistoryCapture {
  Snapshot(i64),
  Version(DocumentVersion),
  Unchanged,
}

/// A restore binds its expected sequence under the same lock as the appended
/// delta. Legacy callers may omit it; interactive clients must supply it.
pub struct HistoryRestoreRequest {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub history_id: i64,
  pub expected_sequence: Option<i64>,
  pub actor: myoxus_domain::audit::AuditActor,
  pub named: Option<(Uuid, NamedHistoryCapture)>,
}

pub struct HistoryRestoreCommit {
  pub sequence: i64,
  pub recovery_history_id: i64,
  pub version: Option<DocumentVersion>,
  pub committed_at: chrono::DateTime<chrono::Utc>,
}

/// Preserve repository conflicts across the history transaction boundary so API
/// callers do not mistake a rejected label for an unknown capture outcome.
#[derive(Debug, thiserror::Error)]
pub enum HistoryCaptureError {
  #[error(transparent)]
  Document(#[from] AuthError),
  #[error(transparent)]
  Repository(#[from] myoxus_domain::repositories::RepositoryError),
  #[error(transparent)]
  Label(#[from] crate::document_version::DocumentVersionLabelError),
  #[error("the selected document history entry is no longer available")]
  StaleEntry,
  #[error("the history capture request key was already used with different input")]
  IdempotencyConflict,
  #[error("the selected document history references changed")]
  ReferenceConflict,
}

/// Sub-service responsible for capturing, listing, and restoring doc history snapshots.
///
/// Constructed by `DocService::new` and exposed as `DocService::history`.
#[derive(Clone)]
pub struct DocHistoryService {
  pub(crate) store: Arc<dyn DocStore>,
  pub(crate) load: Arc<DocLoadService>,
}

impl DocHistoryService {
  /// Fixed direction: selected historical content to current persisted content.
  /// The existing decoder permit bounds both read buffers and blocking diff work.
  #[instrument(skip(self, field_resolver), fields(%workspace_id, %doc_id, history_id))]
  pub async fn compare_current(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    history_id: i64,
    max_input_bytes: usize,
    field_resolver: Option<&crate::document_fields::context::DocumentFieldResolver>,
    actor_id: Option<Uuid>,
  ) -> AuthResult<DocHistoryComparison> {
    let permit = self
      .load
      .decoder_semaphore
      .clone()
      .acquire_owned()
      .await
      .map_err(|_| AuthError::YjsDecoderUnavailable)?;
    let read = self
      .store
      .read_history_comparison(workspace_id, doc_id, history_id, max_input_bytes)
      .await?;
    // Comparing an old live atom as a blank would falsely claim a meaningful
    // historical value. Field-free legacy bytes retain the prior diff path.
    if read
      .history_snapshot
      .windows(yjs::document_field::FIELD_ATTRIBUTE.len())
      .any(|bytes| bytes == yjs::document_field::FIELD_ATTRIBUTE.as_bytes())
    {
      crate::document_fields::output::historical_snapshot(&read.history_snapshot)
        .map_err(|_| AuthError::InvalidInput("historical field values unavailable".into()))?;
    }
    let may_have_fields = read
      .current_snapshot
      .windows(yjs::document_field::FIELD_ATTRIBUTE.len())
      .any(|bytes| bytes == yjs::document_field::FIELD_ATTRIBUTE.as_bytes());
    let has_fields = if may_have_fields {
      !yjs::document_field::content::inspect(&read.current_snapshot)
        .map_err(|_| AuthError::Storage("current document field state is invalid".into()))?
        .is_empty()
    } else {
      false
    };
    let current_reading = if has_fields {
      let resolver = field_resolver.ok_or_else(|| AuthError::Storage("document field context unavailable".into()))?;
      let revision = crate::doc::canonical_yjs_revision(&read.current_snapshot)
        .map_err(|_| AuthError::Storage("current document revision unavailable".into()))?;
      resolver
        .project_authorized(workspace_id, doc_id, revision, &read.current_snapshot, actor_id)
        .await?
        .0
    } else {
      read.current_snapshot.clone()
    };
    if current_reading.len() > max_input_bytes {
      return Err(AuthError::DocSyncPayloadTooLarge {
        max_bytes: max_input_bytes,
      });
    }
    let diff = tokio::task::spawn_blocking(move || {
      let _permit = permit;
      crate::document_version::diff::diff_snapshots_with_current_reading(
        &read.history_snapshot,
        &read.current_snapshot,
        &current_reading,
      )
      .map(|diff| DocHistoryComparison {
        history_id: read.history_id,
        current_revision: read.current_revision,
        read_at: read.read_at,
        diff,
      })
    })
    .await
    .map_err(|_| AuthError::YjsDecoderUnavailable)?
    .map_err(|error| match error {
      crate::document_version::DocumentVersionDiffError::Limit(_) => AuthError::InvalidInput(error.to_string()),
      crate::document_version::DocumentVersionDiffError::Yjs(_) => {
        AuthError::Storage("persisted history comparison state is invalid".into())
      }
    })?;
    Ok(diff)
  }
  /// Includes the compacted sequence and pending tail in one consistent read.
  pub async fn revision(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<i64> {
    self.store.history_revision(workspace_id, doc_id).await
  }
  pub fn new(store: Arc<dyn DocStore>, load: Arc<DocLoadService>) -> Self {
    Self { store, load }
  }

  #[instrument(skip_all, fields(workspace_id = %request.workspace_id, doc_id = %request.doc_id, history_id = request.history_id), err)]
  pub async fn restore(&self, request: HistoryRestoreRequest) -> Result<HistoryRestoreCommit, HistoryCaptureError> {
    let workspace_id = request.workspace_id;
    let doc_id = request.doc_id;
    let committed = self.store.restore_history(request).await?;
    info!(
      sequence = committed.sequence,
      recovery_history_id = committed.recovery_history_id,
      "document history restored"
    );
    // The durable outbox owns publication. Cache degradation after commit must
    // not turn a successful restore into an invitation to repeat the write.
    if let Some(cache) = &self.load.doc_cache {
      cache.invalidate_snapshot(workspace_id, doc_id).await;
      cache.invalidate_metadata(doc_id).await;
      cache.invalidate_timestamps(workspace_id).await;
    }
    Ok(committed)
  }

  /// Explicitly captures a history snapshot for a document.
  #[instrument(skip(self))]
  pub async fn capture_history_snapshot(&self, doc_id: Uuid) -> AuthResult<i64> {
    info!(%doc_id, "capturing history snapshot");
    let meta = self
      .store
      .get_doc_metadata(doc_id)
      .await?
      .ok_or_else(|| AuthError::Storage("Document not found".into()))?;

    let workspace_id = meta
      .workspace_id
      .ok_or_else(|| AuthError::Storage("Userspace history not yet supported".into()))?;

    let HistoryCapture::Snapshot(history_id) = self
      .store
      .capture_history(
        workspace_id,
        doc_id,
        HistoryCaptureProvenance {
          origin: DocHistoryOrigin::Manual,
          actor_id: None,
        },
        None,
      )
      .await
      .map_err(|error| match error {
        HistoryCaptureError::Document(error) => error,
        error => AuthError::Storage(error.to_string()),
      })?
    else {
      return Err(AuthError::Storage("invalid unnamed history capture result".into()));
    };
    debug!(%doc_id, %history_id, "history snapshot captured");
    Ok(history_id)
  }

  pub async fn capture_named(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    request: NamedHistoryCapture,
  ) -> Result<Option<DocumentVersion>, HistoryCaptureError> {
    let provenance = HistoryCaptureProvenance {
      origin: DocHistoryOrigin::from_version_event(request.event),
      actor_id: Some(request.actor_id),
    };
    match self
      .store
      .capture_history(workspace_id, doc_id, provenance, Some(request))
      .await?
    {
      HistoryCapture::Version(version) => {
        // Capture has committed. Cache failure must never make callers repeat a
        // successful durable write; this existing cache port degrades to misses.
        if let Some(cache) = &self.load.doc_cache {
          cache.invalidate_metadata(doc_id).await;
        }
        Ok(Some(version))
      }
      HistoryCapture::Unchanged => Ok(None),
      HistoryCapture::Snapshot(_) => Err(AuthError::Storage("invalid named history capture result".into()).into()),
    }
  }

  /// Save the current state through the history store's request-key transaction.
  pub async fn save_current(&self, request: HistorySaveRequest) -> Result<HistorySaveCommit, HistoryCaptureError> {
    let doc_id = request.doc_id;
    let committed = self.store.save_history(request).await?;
    if !committed.replayed
      && matches!(&committed.capture, HistoryCapture::Version(_))
      && let Some(cache) = &self.load.doc_cache
    {
      cache.invalidate_metadata(doc_id).await;
    }
    Ok(committed)
  }

  /// Attach version metadata to an existing history row without recapturing
  /// content or moving the document's current named-version head.
  pub async fn name_history(&self, request: HistoryNameRequest) -> Result<HistoryNameCommit, HistoryCaptureError> {
    self.store.name_history(request).await
  }

  /// Returns the history versions for a document.
  #[instrument(skip(self))]
  pub async fn list_history(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<DocHistoryMetadataEntry>> {
    self.store.list_history(workspace_id, doc_id, skip, take).await
  }

  /// Legacy callers bind the latest revision while holding the document lock.
  /// Interactive callers use `restore` with their acknowledged expected sequence.
  #[instrument(skip(self))]
  pub async fn rollback_to_history(&self, doc_id: Uuid, history_id: i64) -> AuthResult<bool> {
    let entry = self
      .store
      .get_history_entry(history_id)
      .await?
      .filter(|entry| entry.doc_id == doc_id)
      .ok_or_else(|| AuthError::NotFound("document history".into()))?;
    self
      .restore(HistoryRestoreRequest {
        workspace_id: entry.workspace_id,
        doc_id,
        history_id,
        expected_sequence: None,
        actor: myoxus_domain::audit::AuditActor::system(),
        named: None,
      })
      .await
      .map_err(|error| match error {
        HistoryCaptureError::Document(error) => error,
        error => AuthError::Storage(error.to_string()),
      })?;
    Ok(true)
  }
}
