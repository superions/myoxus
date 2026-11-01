// SPDX-License-Identifier: AGPL-3.0-or-later
//! Manual/API document-version creation orchestration.
//!
//! GraphQL, CLI and MCP must not duplicate label allocation or partial-snapshot
//! cleanup. Label rules are prepared without writes; the history owner captures
//! one locked server state and commits its version and metadata head atomically.

use std::sync::Arc;

use sha2::{Digest, Sha256};
use thiserror::Error;
use tracing::{info, instrument};
use uuid::Uuid;

use myoxus_domain::entities::{DocumentVersion, DocumentVersionEvent, DocumentVersionKind};
use myoxus_domain::repositories::DocumentVersionRepository;

use crate::doc::history::{
  DocHistoryOrigin, HistoryCapture, HistoryCaptureIdempotency, HistoryCaptureProvenance, HistoryNameRequest,
  HistorySaveRequest, NamedHistoryCapture,
};
use crate::document_version::label_service::MAX_LABEL_LEN;
use crate::document_version::{
  DocumentVersionHistoryPort, DocumentVersionLabelError, DocumentVersionLabelRequest, DocumentVersionLabelService,
};

#[derive(Debug, Error)]
pub enum DocumentVersionCreateError {
  #[error(transparent)]
  Label(#[from] DocumentVersionLabelError),
  #[error("document history snapshot failure: {0}")]
  History(#[from] crate::doc::history::HistoryCaptureError),
  #[error("{0}")]
  InvalidInput(String),
}

#[derive(Debug, Clone)]
pub struct DocumentHistorySaveRequest {
  pub doc_id: Uuid,
  pub workspace_id: Uuid,
  pub actor_id: Uuid,
  pub request_key: Uuid,
  pub name: Option<String>,
  pub description: Option<String>,
}

#[derive(Debug)]
pub struct DocumentHistorySaveResult {
  pub history_id: i64,
  pub version: Option<DocumentVersion>,
  pub replayed: bool,
}

#[derive(Debug, Clone)]
pub struct DocumentHistoryNameRequest {
  pub doc_id: Uuid,
  pub workspace_id: Uuid,
  pub history_id: i64,
  pub expected_version_ids: Vec<Uuid>,
  pub actor_id: Uuid,
  pub name: String,
  pub description: Option<String>,
}

#[derive(Debug)]
pub struct DocumentHistoryNameResult {
  pub version: DocumentVersion,
  pub replayed: bool,
}

#[derive(Debug, Clone)]
pub struct DocumentVersionCreateRequest {
  pub doc_id: Uuid,
  pub workspace_id: Uuid,
  pub actor_id: Uuid,
  pub requested_label: Option<String>,
  pub description: Option<String>,
  pub event: DocumentVersionEvent,
  pub kind: DocumentVersionKind,
}

impl DocumentVersionCreateRequest {
  pub fn manual(
    doc_id: Uuid,
    workspace_id: Uuid,
    actor_id: Uuid,
    requested_label: Option<String>,
    description: Option<String>,
  ) -> Self {
    Self {
      doc_id,
      workspace_id,
      actor_id,
      requested_label,
      description,
      event: DocumentVersionEvent::Manual,
      kind: DocumentVersionKind::Checkpoint,
    }
  }
}

#[derive(Clone)]
pub struct DocumentVersionCreateService {
  history: Arc<dyn DocumentVersionHistoryPort>,
  label_service: DocumentVersionLabelService,
}

impl DocumentVersionCreateService {
  pub fn new(history: Arc<dyn DocumentVersionHistoryPort>, version_repo: Arc<dyn DocumentVersionRepository>) -> Self {
    Self {
      history,
      label_service: DocumentVersionLabelService::new(version_repo.clone()),
    }
  }

  #[instrument(skip(self, request), fields(doc_id = %request.doc_id, workspace_id = %request.workspace_id, event = request.event.as_str()), err)]
  pub async fn create(
    &self,
    request: DocumentVersionCreateRequest,
  ) -> Result<DocumentVersion, DocumentVersionCreateError> {
    self.capture(request, false).await?.ok_or_else(|| {
      DocumentVersionCreateError::History(
        crate::auth::AuthError::Storage("explicit capture unexpectedly skipped".into()).into(),
      )
    })
  }

  /// Capture a named operation source once through the existing history request ledger.
  /// The caller fingerprints the semantic request, never the policy-generated label.
  #[instrument(skip_all, fields(doc_id = %request.doc_id, workspace_id = %request.workspace_id))]
  pub async fn create_idempotent(
    &self,
    request: DocumentVersionCreateRequest,
    request_key: Uuid,
    fingerprint: Vec<u8>,
  ) -> Result<DocumentVersion, DocumentVersionCreateError> {
    let label = self
      .label_service
      .prepare(DocumentVersionLabelRequest {
        doc_id: request.doc_id,
        workspace_id: Some(request.workspace_id),
        event: request.event,
        requested_label: normalize_requested_label(request.requested_label)?,
        force_requested_label: false,
        doc_slug: None,
        workspace_slug: None,
        author_slug: None,
      })
      .await?;
    let committed = self
      .history
      .save_current(HistorySaveRequest {
        workspace_id: request.workspace_id,
        doc_id: request.doc_id,
        provenance: HistoryCaptureProvenance {
          origin: DocHistoryOrigin::from_version_event(request.event),
          actor_id: Some(request.actor_id),
        },
        named: Some(NamedHistoryCapture {
          actor_id: request.actor_id,
          label,
          description: normalize_description(request.description),
          event: request.event,
          kind: request.kind,
          skip_unchanged: false,
        }),
        idempotency: HistoryCaptureIdempotency {
          actor_id: request.actor_id,
          request_key,
          fingerprint,
        },
      })
      .await?;
    match committed.capture {
      HistoryCapture::Version(version) => Ok(version),
      _ => Err(DocumentVersionCreateError::InvalidInput(
        "named capture returned no version".into(),
      )),
    }
  }

  /// Daily callers may skip unchanged content, but comparison and capture are
  /// indivisible at the history store. Explicit saves always create a checkpoint.
  pub async fn capture(
    &self,
    request: DocumentVersionCreateRequest,
    skip_unchanged: bool,
  ) -> Result<Option<DocumentVersion>, DocumentVersionCreateError> {
    let requested_label = normalize_requested_label(request.requested_label)?;
    let label = self
      .label_service
      .prepare(DocumentVersionLabelRequest {
        doc_id: request.doc_id,
        workspace_id: Some(request.workspace_id),
        event: request.event,
        requested_label,
        force_requested_label: false,
        doc_slug: None,
        workspace_slug: None,
        author_slug: None,
      })
      .await?;

    let version = self
      .history
      .capture_named(
        request.workspace_id,
        request.doc_id,
        NamedHistoryCapture {
          actor_id: request.actor_id,
          label,
          description: normalize_description(request.description),
          event: request.event,
          kind: request.kind,
          skip_unchanged,
        },
      )
      .await
      .map_err(DocumentVersionCreateError::History)?;
    if let Some(version) = &version {
      info!(
        doc_id = %version.doc_id,
        workspace_id = %version.workspace_id,
        actor_id = %request.actor_id,
        version_id = %version.id,
        history_id = version.doc_history_id,
        label = %version.label,
        "document version created"
      );
    }
    Ok(version)
  }

  /// Save the current state with an optional explicit name. Unlike the legacy
  /// named-version API, blank input means an unnamed history entry and a
  /// supplied name is never replaced by a policy-generated counter.
  #[instrument(skip(self, request), fields(doc_id = %request.doc_id, workspace_id = %request.workspace_id), err)]
  pub async fn save_current(
    &self,
    request: DocumentHistorySaveRequest,
  ) -> Result<DocumentHistorySaveResult, DocumentVersionCreateError> {
    let name = request.name.and_then(|value| {
      let value = value.trim().to_string();
      (!value.is_empty()).then_some(value)
    });
    if name.as_ref().is_some_and(|name| name.len() > MAX_LABEL_LEN) {
      return Err(DocumentVersionCreateError::InvalidInput(format!(
        "document state name must be at most {MAX_LABEL_LEN} bytes"
      )));
    }
    let description = normalize_description(request.description);
    if name.is_none() && description.is_some() {
      return Err(DocumentVersionCreateError::InvalidInput(
        "a description is only valid for a named document state".into(),
      ));
    }

    let named = if let Some(name) = name.as_ref() {
      let label = self
        .label_service
        .prepare(DocumentVersionLabelRequest {
          doc_id: request.doc_id,
          workspace_id: Some(request.workspace_id),
          event: DocumentVersionEvent::Manual,
          requested_label: Some(name.clone()),
          force_requested_label: true,
          doc_slug: None,
          workspace_slug: None,
          author_slug: None,
        })
        .await?;
      Some(NamedHistoryCapture {
        actor_id: request.actor_id,
        label,
        description: description.clone(),
        event: DocumentVersionEvent::Manual,
        kind: DocumentVersionKind::Checkpoint,
        skip_unchanged: false,
      })
    } else {
      None
    };
    let fingerprint = capture_fingerprint(name.as_deref(), description.as_deref());
    let committed = self
      .history
      .save_current(HistorySaveRequest {
        workspace_id: request.workspace_id,
        doc_id: request.doc_id,
        provenance: HistoryCaptureProvenance {
          origin: DocHistoryOrigin::Manual,
          actor_id: Some(request.actor_id),
        },
        named,
        idempotency: HistoryCaptureIdempotency {
          actor_id: request.actor_id,
          request_key: request.request_key,
          fingerprint,
        },
      })
      .await?;
    let (history_id, version) = match committed.capture {
      HistoryCapture::Snapshot(history_id) => (history_id, None),
      HistoryCapture::Version(version) => (version.doc_history_id, Some(version)),
      HistoryCapture::Unchanged => {
        return Err(DocumentVersionCreateError::History(
          crate::auth::AuthError::Storage("explicit history save unexpectedly skipped".into()).into(),
        ));
      }
    };
    Ok(DocumentHistorySaveResult {
      history_id,
      version,
      replayed: committed.replayed,
    })
  }

  /// Attach a deliberate name to an existing immutable history state. The
  /// history store owns the row lock and never changes current document state.
  #[instrument(skip(self, request), fields(doc_id = %request.doc_id, workspace_id = %request.workspace_id, history_id = request.history_id), err)]
  pub async fn name_history(
    &self,
    request: DocumentHistoryNameRequest,
  ) -> Result<DocumentHistoryNameResult, DocumentVersionCreateError> {
    let name = normalize_requested_label(Some(request.name))?
      .ok_or(DocumentVersionCreateError::Label(DocumentVersionLabelError::EmptyLabel))?;
    if name.len() > MAX_LABEL_LEN {
      return Err(DocumentVersionCreateError::InvalidInput(format!(
        "document state name must be at most {MAX_LABEL_LEN} bytes"
      )));
    }
    let label = self
      .label_service
      .prepare(DocumentVersionLabelRequest {
        doc_id: request.doc_id,
        workspace_id: Some(request.workspace_id),
        event: DocumentVersionEvent::Manual,
        requested_label: Some(name),
        force_requested_label: true,
        doc_slug: None,
        workspace_slug: None,
        author_slug: None,
      })
      .await?;
    let committed = self
      .history
      .name_history(HistoryNameRequest {
        workspace_id: request.workspace_id,
        doc_id: request.doc_id,
        history_id: request.history_id,
        expected_version_ids: request.expected_version_ids,
        named: NamedHistoryCapture {
          actor_id: request.actor_id,
          label,
          description: normalize_description(request.description),
          event: DocumentVersionEvent::Manual,
          kind: DocumentVersionKind::Checkpoint,
          skip_unchanged: false,
        },
      })
      .await?;
    Ok(DocumentHistoryNameResult {
      version: committed.version,
      replayed: committed.replayed,
    })
  }
}

fn capture_fingerprint(name: Option<&str>, description: Option<&str>) -> Vec<u8> {
  let mut digest = Sha256::new();
  for value in [name, description] {
    match value {
      Some(value) => {
        digest.update([1]);
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
      }
      None => digest.update([0]),
    }
  }
  digest.finalize().to_vec()
}

fn normalize_requested_label(label: Option<String>) -> Result<Option<String>, DocumentVersionCreateError> {
  label
    .map(|value| {
      let trimmed = value.trim().to_string();
      if trimmed.is_empty() {
        Err(DocumentVersionCreateError::Label(DocumentVersionLabelError::EmptyLabel))
      } else {
        Ok(trimmed)
      }
    })
    .transpose()
}

fn normalize_description(description: Option<String>) -> Option<String> {
  description.and_then(|value| {
    let trimmed = value.trim();
    if trimmed.is_empty() {
      None
    } else {
      Some(trimmed.chars().take(2048).collect::<String>())
    }
  })
}
