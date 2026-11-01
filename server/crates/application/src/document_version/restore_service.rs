// SPDX-License-Identifier: AGPL-3.0-or-later
//! Named restore prepares policy only. The document owner commits the content
//! delta, recovery snapshot, new version, relation, metadata, audit and outbox.

use crate::doc::DocService;
use crate::doc::history::{
  HistoryCaptureError, HistoryNameCommit, HistoryNameRequest, HistoryRestoreCommit, HistoryRestoreRequest,
  HistorySaveCommit, HistorySaveRequest, NamedHistoryCapture,
};
use crate::document_version::{DocumentVersionLabelError, DocumentVersionLabelRequest, DocumentVersionLabelService};
use async_trait::async_trait;
use myoxus_domain::audit::AuditActor;
use myoxus_domain::entities::{DocumentVersion, DocumentVersionEvent, DocumentVersionKind};
use myoxus_domain::repositories::DocumentVersionRepository;
use std::sync::Arc;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum DocumentVersionRestoreError {
  #[error(transparent)]
  Label(#[from] DocumentVersionLabelError),
  #[error(transparent)]
  History(#[from] HistoryCaptureError),
}

#[async_trait]
pub trait DocumentVersionHistoryPort: Send + Sync {
  async fn capture_named(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    request: NamedHistoryCapture,
  ) -> Result<Option<DocumentVersion>, HistoryCaptureError>;
  async fn restore_history(&self, request: HistoryRestoreRequest) -> Result<HistoryRestoreCommit, HistoryCaptureError>;
  async fn save_current(&self, request: HistorySaveRequest) -> Result<HistorySaveCommit, HistoryCaptureError> {
    let _ = request;
    Err(crate::auth::AuthError::Storage("idempotent history capture is not configured".into()).into())
  }
  async fn name_history(&self, request: HistoryNameRequest) -> Result<HistoryNameCommit, HistoryCaptureError> {
    let _ = request;
    Err(crate::auth::AuthError::Storage("history naming is not configured".into()).into())
  }
}

#[async_trait]
impl DocumentVersionHistoryPort for DocService {
  async fn capture_named(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    request: NamedHistoryCapture,
  ) -> Result<Option<DocumentVersion>, HistoryCaptureError> {
    self.history.capture_named(workspace_id, doc_id, request).await
  }
  async fn restore_history(&self, request: HistoryRestoreRequest) -> Result<HistoryRestoreCommit, HistoryCaptureError> {
    self.history.restore(request).await
  }
  async fn save_current(&self, request: HistorySaveRequest) -> Result<HistorySaveCommit, HistoryCaptureError> {
    self.history.save_current(request).await
  }
  async fn name_history(&self, request: HistoryNameRequest) -> Result<HistoryNameCommit, HistoryCaptureError> {
    self.history.name_history(request).await
  }
}

#[derive(Clone)]
pub struct DocumentVersionRestoreService {
  history: Arc<dyn DocumentVersionHistoryPort>,
  label_service: DocumentVersionLabelService,
}

impl DocumentVersionRestoreService {
  pub fn new(history: Arc<dyn DocumentVersionHistoryPort>, repo: Arc<dyn DocumentVersionRepository>) -> Self {
    Self {
      history,
      label_service: DocumentVersionLabelService::new(repo),
    }
  }

  /// Trusted legacy callers bind the current sequence under the document lock.
  pub async fn restore(
    &self,
    source: &DocumentVersion,
    actor_id: Uuid,
    requested_label: Option<String>,
  ) -> Result<DocumentVersion, DocumentVersionRestoreError> {
    self
      .restore_at_revision(source, AuditActor::user(actor_id, None), requested_label, None)
      .await
  }

  pub async fn restore_at_revision(
    &self,
    source: &DocumentVersion,
    actor: AuditActor,
    requested_label: Option<String>,
    expected_sequence: Option<i64>,
  ) -> Result<DocumentVersion, DocumentVersionRestoreError> {
    let committed = self
      .restore_committed(source, actor, requested_label, expected_sequence)
      .await?;
    committed.version.ok_or_else(|| {
      HistoryCaptureError::Document(crate::auth::AuthError::Storage(
        "named restore returned no version".into(),
      ))
      .into()
    })
  }

  /// Preserve the exact transaction outcome for remote admission/replay adapters.
  /// GraphQL keeps its existing version-only result through `restore_at_revision`.
  #[tracing::instrument(skip_all)]
  pub async fn restore_committed(
    &self,
    source: &DocumentVersion,
    actor: AuditActor,
    requested_label: Option<String>,
    expected_sequence: Option<i64>,
  ) -> Result<HistoryRestoreCommit, DocumentVersionRestoreError> {
    let actor_id = actor
      .user_id
      .ok_or_else(|| HistoryCaptureError::Document(crate::auth::AuthError::ActionForbidden))?;
    let requested_label = requested_label.or_else(|| {
      let suffix = Uuid::new_v4().simple().to_string();
      Some(format!("restore-from-{}-{}", source.label, &suffix[..8]))
    });
    let label = self
      .label_service
      .prepare(DocumentVersionLabelRequest {
        doc_id: source.doc_id,
        workspace_id: Some(source.workspace_id),
        event: DocumentVersionEvent::Restore,
        requested_label,
        force_requested_label: true,
        doc_slug: None,
        workspace_slug: None,
        author_slug: None,
      })
      .await?;
    let committed = self
      .history
      .restore_history(HistoryRestoreRequest {
        workspace_id: source.workspace_id,
        doc_id: source.doc_id,
        history_id: source.doc_history_id,
        expected_sequence,
        actor,
        named: Some((
          source.id,
          NamedHistoryCapture {
            actor_id,
            label,
            description: Some(format!("Restored from {}", source.label)),
            event: DocumentVersionEvent::Restore,
            kind: DocumentVersionKind::Restored,
            skip_unchanged: false,
          },
        )),
      })
      .await?;
    Ok(committed)
  }
}
