// SPDX-License-Identifier: AGPL-3.0-or-later
//! Content-free diagnostics without replacing the originating failure.

use crate::auth::{AuthError, AuthResult};
use crate::ports::PortError;
use myoxus_domain::workspace_content_operation::{
  RedactedWorkspaceContentError, WorkspaceContentErrorCode, WorkspaceContentOperationRecord,
};
use sha2::{Digest, Sha256};
use std::future::Future;
use tracing::Instrument;

/// Operation-local execution failure. The dependency error never crosses the
/// public boundary; its phase and safe cause survive durable worker retries.
pub struct WorkspaceContentExecutionError {
  pub failure: RedactedWorkspaceContentError,
  pub retryable: bool,
  pub(super) source: AuthError,
}

impl std::fmt::Debug for WorkspaceContentExecutionError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter
      .debug_struct("WorkspaceContentExecutionError")
      .field("failure", &self.failure)
      .field("retryable", &self.retryable)
      .finish_non_exhaustive()
  }
}

impl std::fmt::Display for WorkspaceContentExecutionError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(formatter, "{}", self.failure.code.as_str())?;
    if let Some(phase) = &self.failure.phase {
      write!(formatter, " ({phase})")?;
    }
    Ok(())
  }
}

// Dependency payloads stay private even when a consumer formats an error chain.
impl std::error::Error for WorkspaceContentExecutionError {}

impl WorkspaceContentExecutionError {
  pub fn at_phase(error: AuthError, phase: &'static str) -> Self {
    let code = failure_code(&error);
    let message = code
      .safe_message()
      .unwrap_or("An unexpected operation failure requires diagnostic correlation.");
    let retryable = code.retryable();
    Self {
      failure: RedactedWorkspaceContentError::new(code, message)
        .expect("static safe cause")
        .with_phase(phase),
      retryable,
      source: error,
    }
  }

  pub fn into_source(self) -> AuthError {
    self.source
  }
}

impl From<AuthError> for WorkspaceContentExecutionError {
  fn from(error: AuthError) -> Self {
    Self::at_phase(error, "typed_plan")
  }
}

pub type WorkspaceContentExecutionResult<T> = Result<T, WorkspaceContentExecutionError>;

/// Preserve the existing Organizer variants without formatting row payloads.
pub fn organizer_failure(error: crate::organizer::OrganizerError) -> AuthError {
  use crate::organizer::OrganizerError;
  let code = match error {
    OrganizerError::Storage => WorkspaceContentErrorCode::StorageUnavailable,
    OrganizerError::InvalidDocumentKey => WorkspaceContentErrorCode::OrganizerKeyInvalid,
    OrganizerError::Decode => WorkspaceContentErrorCode::OrganizerDecode,
    OrganizerError::MalformedRow(_) => WorkspaceContentErrorCode::OrganizerMalformedRow,
    OrganizerError::FolderNotFound(_) => WorkspaceContentErrorCode::OrganizerFolderMissing,
    OrganizerError::EntryNotFound(_) => WorkspaceContentErrorCode::OrganizerEntryMissing,
    OrganizerError::BrokenParent(_) => WorkspaceContentErrorCode::OrganizerParentMissing,
    OrganizerError::Cycle(_) => WorkspaceContentErrorCode::OrganizerCycle,
    OrganizerError::DuplicateResource => WorkspaceContentErrorCode::OrganizerDuplicate,
    OrganizerError::InvalidFolderName => WorkspaceContentErrorCode::OrganizerNameInvalid,
    OrganizerError::UnsupportedLinkType => WorkspaceContentErrorCode::OrganizerLinkTypeInvalid,
    OrganizerError::InvalidTarget => WorkspaceContentErrorCode::OrganizerTargetInvalid,
    OrganizerError::InvalidWorkspaceTarget => WorkspaceContentErrorCode::OrganizerWorkspaceTargetInvalid,
    OrganizerError::EntryAtRoot => WorkspaceContentErrorCode::OrganizerEntryAtRoot,
    OrganizerError::EmptyMutation => WorkspaceContentErrorCode::OrganizerMutationEmpty,
    OrganizerError::InvalidOrderKey => WorkspaceContentErrorCode::OrganizerOrderInvalid,
    OrganizerError::ReindexRequired => WorkspaceContentErrorCode::OrganizerReindexRequired,
    OrganizerError::StaleRevision { .. } => WorkspaceContentErrorCode::OrganizerRevisionStale,
  };
  tracing::error!(
    error_kind = error.diagnostic_kind(),
    cause = code.as_str(),
    "workspace_content.organizer_failed"
  );
  if code.retryable() {
    AuthError::Storage(code.as_str().into())
  } else {
    AuthError::InvalidInput(code.as_str().into())
  }
}

/// Preserve canonical service causes at the transfer boundary without exposing
/// dependency messages or changing their public GraphQL contracts.
pub(super) fn tag_service_failure(error: crate::workspace_tags::WorkspaceTagServiceError) -> AuthError {
  use crate::workspace_tags::*;
  let code = match error.code {
    ERR_TAG_FORBIDDEN => WorkspaceContentErrorCode::TransferForbidden,
    ERR_TAG_NOT_FOUND => WorkspaceContentErrorCode::SourceTagMissing,
    ERR_TAG_STORAGE => WorkspaceContentErrorCode::DatabaseUnavailable,
    ERR_TAG_DUPLICATE_SLUG => WorkspaceContentErrorCode::DatabaseUniqueConstraint,
    ERR_TAG_CROSS_WORKSPACE | ERR_TAG_ARCHIVED_WRITE => WorkspaceContentErrorCode::TagAssignmentConstraint,
    _ => WorkspaceContentErrorCode::SourceTagInvalid,
  };
  tracing::error!(
    dependency_code = error.code,
    cause = code.as_str(),
    "workspace_content.tag_failed"
  );
  cause_error(code)
}

pub(super) fn database_service_failure(error: crate::database::DatabaseServiceError) -> AuthError {
  use crate::database::*;
  let code = if let Some(code) = WorkspaceContentErrorCode::parse(error.code) {
    code
  } else if error.is_retryable_storage_failure() {
    WorkspaceContentErrorCode::DatabaseUnavailable
  } else {
    match error.code {
      ERR_FORBIDDEN | ERR_RELATION_TARGET_FORBIDDEN | ERR_ROW_TEMPLATE_FORBIDDEN => {
        WorkspaceContentErrorCode::TransferForbidden
      }
      ERR_NOT_FOUND => WorkspaceContentErrorCode::SourceDatabaseMissing,
      crate::workspace_tags::ERR_TAG_FORBIDDEN => WorkspaceContentErrorCode::TransferForbidden,
      crate::workspace_tags::ERR_TAG_NOT_FOUND => WorkspaceContentErrorCode::SourceTagMissing,
      crate::workspace_tags::ERR_TAG_STORAGE => WorkspaceContentErrorCode::DatabaseUnavailable,
      crate::workspace_tags::ERR_TAG_INVALID_REQUEST
      | crate::workspace_tags::ERR_TAG_INVALID_NAME
      | crate::workspace_tags::ERR_TAG_INVALID_COLOR => WorkspaceContentErrorCode::SourceTagInvalid,
      ERR_JSON_MISSING_FILE => WorkspaceContentErrorCode::SourceBlobMissing,
      ERR_DATABASE_CONFLICT => WorkspaceContentErrorCode::DatabaseEditConflict,
      ERR_JSON_CONFLICT => WorkspaceContentErrorCode::DatabaseImportConflict,
      _ => WorkspaceContentErrorCode::DatabaseSnapshotInvalid,
    }
  };
  tracing::error!(
    dependency_code = error.code,
    cause = code.as_str(),
    "workspace_content.database_failed"
  );
  cause_error(code)
}

fn cause_error(code: WorkspaceContentErrorCode) -> AuthError {
  if code.retryable() {
    AuthError::Storage(code.as_str().into())
  } else {
    AuthError::InvalidInput(code.as_str().into())
  }
}

pub(super) fn record_port_failure(error: &PortError, phase: &'static str) {
  let error_kind = match error {
    PortError::InvalidInput(_) => "invalid_input",
    PortError::NotFound(_) => "not_found",
    PortError::Conflict(_) => "conflict",
    PortError::Transport(_) => "transport",
  };
  tracing::error!(phase, error_kind, "workspace_content.storage_failed");
}

/// Only owned static causes cross the public boundary. Free-form dependency
/// messages may contain payloads or credentials and are never formatted.
pub fn failure_code(error: &AuthError) -> WorkspaceContentErrorCode {
  match error {
    AuthError::StorageQuotaExceeded { .. } => WorkspaceContentErrorCode::TargetStorageLimit,
    AuthError::WorkspaceNameConflict { .. } => WorkspaceContentErrorCode::WorkspaceNameConflict,
    AuthError::ActionForbidden => WorkspaceContentErrorCode::TransferForbidden,
    AuthError::InvalidInput(code) | AuthError::NotFound(code) => {
      WorkspaceContentErrorCode::parse(code).unwrap_or(WorkspaceContentErrorCode::UnexpectedValidation)
    }
    AuthError::Storage(code) => {
      WorkspaceContentErrorCode::parse(code).unwrap_or(WorkspaceContentErrorCode::StorageUnavailable)
    }
    AuthError::InvalidYjsUpdate | AuthError::InvalidYjsStateVector => {
      WorkspaceContentErrorCode::DocumentSnapshotInvalid
    }
    AuthError::YjsValidationUnavailable | AuthError::YjsDecoderUnavailable => {
      WorkspaceContentErrorCode::StorageUnavailable
    }
    AuthError::UpdateTooLarge { .. } | AuthError::DocSyncPayloadTooLarge { .. } => {
      WorkspaceContentErrorCode::BlobSizeLimit
    }
    _ => WorkspaceContentErrorCode::UnexpectedValidation,
  }
}

pub(super) fn record_failure(record: &WorkspaceContentOperationRecord, phase: &str, error: &AuthError) {
  record_operation_failure(record.id, Some(record.kind), phase, error);
}

/// Queue/recovery boundaries sometimes have only the durable identity, not a
/// loaded aggregate. They use the same classifier and central tracing target.
pub fn record_operation_failure(
  operation_id: myoxus_domain::ids::WorkspaceContentOperationId,
  operation_kind: Option<myoxus_domain::workspace_content_operation::WorkspaceContentOperationKind>,
  phase: &str,
  error: &AuthError,
) {
  let error_kind = match error {
    AuthError::InvalidInput(_) => "invalid_input",
    AuthError::Storage(_) => "storage",
    AuthError::NotFound(_) => "not_found",
    AuthError::ActionForbidden => "action_forbidden",
    AuthError::WorkspaceNameConflict { .. } => "workspace_name_conflict",
    AuthError::WorkspaceOverviewRevisionConflict { .. } => "workspace_overview_revision_conflict",
    AuthError::StorageQuotaExceeded { .. } => "storage_quota_exceeded",
    AuthError::UpdateTooLarge { .. } => "update_too_large",
    AuthError::InvalidYjsUpdate => "invalid_yjs_update",
    AuthError::YjsValidationUnavailable => "yjs_validation_unavailable",
    AuthError::InvalidYjsStateVector => "invalid_yjs_state_vector",
    AuthError::DocSyncPayloadTooLarge { .. } => "doc_sync_payload_too_large",
    AuthError::DocSyncCancelled => "doc_sync_cancelled",
    AuthError::YjsDecoderUnavailable => "yjs_decoder_unavailable",
    AuthError::InvalidEmail => "invalid_email",
    AuthError::WrongSignInCredentials => "wrong_sign_in_credentials",
    AuthError::InvalidToken => "invalid_token",
    AuthError::ExpiredToken => "expired_token",
    AuthError::TokenNotFound => "token_not_found",
    AuthError::OauthStateExpired => "oauth_state_expired",
    AuthError::SignUpForbidden => "sign_up_forbidden",
    AuthError::AuthenticationRequired => "authentication_required",
  };
  let code = failure_code(error);
  // A fingerprint correlates unforeseen messages without revealing their bytes.
  // Known conditions must have a registered code; this is not a success fallback.
  let fingerprint = match error {
    AuthError::InvalidInput(message) | AuthError::Storage(message) | AuthError::NotFound(message) => {
      Some(hex::encode(Sha256::digest(message.as_bytes())))
    }
    _ => None,
  };
  tracing::error!(
    %operation_id, operation_kind = operation_kind.map(|kind| kind.as_str()), phase,
    error_kind, cause = code.as_str(), reason = code.safe_message(), diagnostic_fingerprint = fingerprint,
    "workspace_content.execution_failed"
  );
}

/// Log the original dependency variant, then carry its safe cause and actual
/// boundary through the operation-local executor result.
pub(super) async fn in_phase<T>(
  record: &WorkspaceContentOperationRecord,
  phase: &'static str,
  work: impl Future<Output = AuthResult<T>>,
) -> WorkspaceContentExecutionResult<T> {
  work
    .instrument(tracing::info_span!("workspace_content.phase",
    operation_id = %record.id, operation_kind = record.kind.as_str(), phase))
    .await
    .map_err(|error| {
      record_failure(record, phase, &error);
      WorkspaceContentExecutionError::at_phase(error, phase)
    })
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::Utc;
  use myoxus_domain::workspace_content_operation::{WorkspaceContentOperationKind, WorkspaceContentOperationStatus};
  use std::io::Write;
  use std::sync::{Arc, Mutex};
  use uuid::Uuid;

  #[derive(Clone, Default)]
  struct LogBuffer(Arc<Mutex<Vec<u8>>>);
  impl Write for LogBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
      self.0.lock().unwrap().extend_from_slice(bytes);
      Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
      Ok(())
    }
  }

  #[test]
  fn failures_keep_operation_phase_and_variant_without_free_form_payloads() {
    let now = Utc::now();
    let record = WorkspaceContentOperationRecord {
      id: Uuid::new_v4(),
      idempotency_id: Uuid::new_v4(),
      actor_id: Uuid::new_v4(),
      kind: WorkspaceContentOperationKind::ExtractFolder,
      source_workspace_id: Uuid::new_v4(),
      target_workspace_id: Some(Uuid::new_v4()),
      status: WorkspaceContentOperationStatus::Running,
      preview_revision: None,
      manifest_hash: "a".repeat(64),
      error: None,
      diagnostic_instance_id: None,
      created_at: now,
      updated_at: now,
    };
    let output = LogBuffer::default();
    let writer = output.clone();
    let subscriber = tracing_subscriber::fmt()
      .without_time()
      .with_ansi(false)
      .with_writer(move || writer.clone())
      .finish();
    tracing::subscriber::with_default(subscriber, || {
      for code in [
        WorkspaceContentErrorCode::OrganizerMalformedRow,
        WorkspaceContentErrorCode::TagAssignmentConstraint,
      ] {
        record_failure(&record, "publication", &AuthError::InvalidInput(code.as_str().into()));
      }
      record_failure(
        &record,
        "blob_staging",
        &AuthError::Storage("secret-token-and-document-content".into()),
      );
      record_port_failure(
        &PortError::Transport("secret-token-and-document-content".into()),
        "blob_staging",
      );
      for (dependency, expected) in [
        (
          crate::workspace_tags::ERR_TAG_NOT_FOUND,
          WorkspaceContentErrorCode::SourceTagMissing,
        ),
        (
          crate::workspace_tags::ERR_TAG_FORBIDDEN,
          WorkspaceContentErrorCode::TransferForbidden,
        ),
        (
          crate::workspace_tags::ERR_TAG_STORAGE,
          WorkspaceContentErrorCode::DatabaseUnavailable,
        ),
      ] {
        let error = tag_service_failure(crate::workspace_tags::WorkspaceTagServiceError {
          code: dependency,
          message: "secret-token-and-document-content".into(),
        });
        let failure = WorkspaceContentExecutionError::at_phase(error, "source_read");
        assert_eq!(failure.failure.code, expected);
        assert_eq!(failure.failure.phase.as_deref(), Some("source_read"));
        assert_eq!(failure.retryable, expected.retryable());
      }
    });
    let log = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
    assert!(
      log.contains(&record.id.to_string()),
      "missing operation correlation: {log}"
    );
    assert!(log.contains("blob_staging"));
    assert!(log.contains("storage"));
    assert!(log.contains("transport"));
    assert!(log.contains("XWS_ORGANIZER_MALFORMED_ROW"));
    assert!(log.contains("XWS_TAG_ASSIGNMENT_CONSTRAINT"));
    assert!(!log.contains("secret-token-and-document-content"));
  }
}
