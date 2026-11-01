// SPDX-License-Identifier: AGPL-3.0-or-later
//! Durable worker envelope for cross-workspace content operations.
//!
//! Redis carries only an operation identity. Every execution decision is
//! reloaded from PostgreSQL, and the queue's process identity remains
//! diagnostic metadata rather than an ownership key.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use myoxus_domain::ids::WorkspaceContentOperationId;
use myoxus_domain::workspace_content_operation::{
  RedactedWorkspaceContentError, WorkspaceContentErrorCode, WorkspaceContentOperationKind,
  WorkspaceContentOperationRecord, WorkspaceContentOperationStatus,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::WorkspaceContentOperationRepository;
use crate::auth::{AuthError, AuthResult};

pub const WORKSPACE_CONTENT_WORKER_INVALID_JOB: &str = "XWS_WORKER_JOB_INVALID";
pub const WORKSPACE_CONTENT_WORKER_STORAGE_UNAVAILABLE: &str = "XWS_WORKER_STORAGE_UNAVAILABLE";
pub const WORKSPACE_CONTENT_WORKER_OPERATION_NOT_FOUND: &str = "XWS_WORKER_OPERATION_NOT_FOUND";
pub const WORKSPACE_CONTENT_WORKER_STATE_INVALID: &str = "XWS_WORKER_STATE_INVALID";
pub const WORKSPACE_CONTENT_WORKER_EXECUTION_FAILED: &str = "XWS_WORKER_EXECUTION_FAILED";

/// Content-free Redis payload. Unknown fields are rejected so semantic data
/// cannot accidentally turn the queue into a second operation model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceContentWorkerEnvelope {
  pub operation_id: WorkspaceContentOperationId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceContentWorkerDisposition {
  Claimed,
  Resumed,
  Terminal,
}

impl WorkspaceContentWorkerDisposition {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Claimed => "claimed",
      Self::Resumed => "resumed",
      Self::Terminal => "terminal",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentWorkerOutcome {
  pub record: WorkspaceContentOperationRecord,
  pub disposition: WorkspaceContentWorkerDisposition,
}

#[async_trait]
pub trait WorkspaceContentWorkerPort: Send + Sync {
  async fn execute(&self, envelope: WorkspaceContentWorkerEnvelope) -> AuthResult<WorkspaceContentWorkerOutcome>;
  async fn finalize_retry_exhaustion(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<WorkspaceContentOperationRecord>;
}

#[async_trait]
pub trait WorkspaceContentSemanticExecutor: Send + Sync {
  async fn execute(
    &self,
    record: WorkspaceContentOperationRecord,
  ) -> super::diagnostics::WorkspaceContentExecutionResult<WorkspaceContentOperationRecord>;
}

#[async_trait]
pub trait WorkspaceContentSemanticRecovery: Send + Sync {
  /// Remove only unpublished operation-owned state and persist the supplied
  /// safe terminal failure. Published resources must remain untouched.
  async fn recover(
    &self,
    operation_id: WorkspaceContentOperationId,
    failure: RedactedWorkspaceContentError,
  ) -> AuthResult<WorkspaceContentOperationRecord>;
}

/// Completes external metadata only. It must never rerun content publication.
#[async_trait]
pub trait WorkspaceContentGitMetadataExecutor: Send + Sync {
  async fn execute(&self, operation_id: WorkspaceContentOperationId) -> AuthResult<()>;
}

/// Claims and resumes the durable operation envelope.
///
/// Registered operation semantics are delegated only after a durable claim.
/// A missing executor fails before the durable claim. Duplicate delivery reloads
/// the same aggregate and never creates a second operation.
pub struct WorkspaceContentWorkerService {
  repository: Arc<dyn WorkspaceContentOperationRepository>,
  diagnostic_instance_id: String,
  semantic_executors: BTreeMap<WorkspaceContentOperationKind, Arc<dyn WorkspaceContentSemanticExecutor>>,
  recovery_handlers: BTreeMap<WorkspaceContentOperationKind, Arc<dyn WorkspaceContentSemanticRecovery>>,
  git_metadata: Option<Arc<dyn WorkspaceContentGitMetadataExecutor>>,
  queue: Option<Arc<dyn super::coordination::WorkspaceContentQueuePort>>,
}

impl WorkspaceContentWorkerService {
  pub fn new(repository: Arc<dyn WorkspaceContentOperationRepository>, instance_id: Uuid) -> Self {
    Self {
      repository,
      diagnostic_instance_id: instance_id.to_string(),
      semantic_executors: BTreeMap::new(),
      recovery_handlers: BTreeMap::new(),
      git_metadata: None,
      queue: None,
    }
  }

  pub fn with_git_metadata_executor(mut self, executor: Arc<dyn WorkspaceContentGitMetadataExecutor>) -> Self {
    self.git_metadata = Some(executor);
    self
  }

  pub fn with_queue(mut self, queue: Arc<dyn super::coordination::WorkspaceContentQueuePort>) -> Self {
    self.queue = Some(queue);
    self
  }

  pub fn with_recovery_handler(
    mut self,
    kind: WorkspaceContentOperationKind,
    recovery: Arc<dyn WorkspaceContentSemanticRecovery>,
  ) -> Self {
    assert!(
      self.recovery_handlers.insert(kind, recovery).is_none(),
      "workspace content recovery handler registered twice"
    );
    self
  }

  /// Register one operation-family executor.
  ///
  /// Keeping dispatch here prevents a composite executor from silently
  /// accepting a family it does not implement. Re-registering a kind is a
  /// startup programming error and therefore fails immediately.
  pub fn with_semantic_executor(
    mut self,
    kind: WorkspaceContentOperationKind,
    executor: Arc<dyn WorkspaceContentSemanticExecutor>,
  ) -> Self {
    assert!(
      self.semantic_executors.insert(kind, executor).is_none(),
      "workspace content semantic executor registered twice"
    );
    self
  }

  async fn operation(&self, operation_id: WorkspaceContentOperationId) -> AuthResult<WorkspaceContentOperationRecord> {
    self
      .repository
      .get(operation_id)
      .await?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))
  }

  fn existing_outcome(record: WorkspaceContentOperationRecord) -> AuthResult<WorkspaceContentWorkerOutcome> {
    let disposition = match record.status {
      WorkspaceContentOperationStatus::Running => WorkspaceContentWorkerDisposition::Resumed,
      WorkspaceContentOperationStatus::Succeeded
      | WorkspaceContentOperationStatus::Cancelled
      | WorkspaceContentOperationStatus::Failed
      | WorkspaceContentOperationStatus::CleanupRequired => WorkspaceContentWorkerDisposition::Terminal,
      _ => {
        return Err(AuthError::InvalidInput(
          WORKSPACE_CONTENT_WORKER_STATE_INVALID.to_string(),
        ));
      }
    };
    Ok(WorkspaceContentWorkerOutcome { record, disposition })
  }

  async fn reload_after_transition_race(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<WorkspaceContentWorkerOutcome> {
    Self::existing_outcome(self.operation(operation_id).await?)
  }
  async fn persist_semantic_failure(
    &self,
    record: &WorkspaceContentOperationRecord,
    failure: RedactedWorkspaceContentError,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    if let Some(recovery) = self.recovery_handlers.get(&record.kind) {
      return recovery.recover(record.id, failure).await;
    }
    match self
      .repository
      .transition(
        record.id,
        WorkspaceContentOperationStatus::Running,
        WorkspaceContentOperationStatus::Failed,
        Some(failure),
        Some(&self.diagnostic_instance_id),
      )
      .await
    {
      Ok(record) => Ok(record),
      Err(error @ AuthError::InvalidInput(_)) => {
        super::diagnostics::record_failure(record, "failure_persistence", &error);
        let latest = self.operation(record.id).await?;
        if matches!(
          latest.status,
          WorkspaceContentOperationStatus::Succeeded
            | WorkspaceContentOperationStatus::Cancelled
            | WorkspaceContentOperationStatus::Failed
            | WorkspaceContentOperationStatus::CleanupRequired
        ) {
          Ok(latest)
        } else {
          Err(error)
        }
      }
      Err(error) => {
        super::diagnostics::record_failure(record, "failure_persistence", &error);
        Err(error)
      }
    }
  }
}

#[async_trait]
impl WorkspaceContentWorkerPort for WorkspaceContentWorkerService {
  #[tracing::instrument(skip(self), fields(operation_id = %envelope.operation_id))]
  async fn execute(&self, envelope: WorkspaceContentWorkerEnvelope) -> AuthResult<WorkspaceContentWorkerOutcome> {
    let record = self.operation(envelope.operation_id).await?;
    if record.status == WorkspaceContentOperationStatus::Succeeded
      && let Some(git) = self.repository.git_work_status(record.id).await?
      && git.pending
    {
      if git.retry_exhausted {
        return Err(AuthError::InvalidInput(
          git
            .error_code
            .unwrap_or(WorkspaceContentErrorCode::WorkerRetryExhausted)
            .as_str()
            .into(),
        ));
      }
      let completion = match &self.git_metadata {
        Some(executor) => executor.execute(record.id).await,
        None => Err(AuthError::Storage(
          WorkspaceContentErrorCode::GitSyncHandoffUnavailable.as_str().into(),
        )),
      };
      if let Err(error) = completion {
        let code = super::diagnostics::failure_code(&error);
        self
          .repository
          .record_git_failure(record.id, code, !matches!(error, AuthError::Storage(_)))
          .await?;
        return Err(error);
      }
      // An adapter's successful return alone cannot acknowledge pending intent.
      if self
        .repository
        .git_work_status(record.id)
        .await?
        .is_some_and(|state| state.pending)
      {
        return Err(AuthError::Storage(
          WorkspaceContentErrorCode::GitSyncHandoffUnavailable.as_str().into(),
        ));
      }
      return Self::existing_outcome(record);
    }
    // Extract cleanup is compensation, never a new attempt at publication.
    // Keep its durable failure intact across queue delivery and storage retries.
    if record.kind == WorkspaceContentOperationKind::ExtractFolder
      && record.status == WorkspaceContentOperationStatus::CleanupRequired
      && !record
        .error
        .as_ref()
        .is_some_and(|error| error.is_cancellation_cleanup())
    {
      let failure = record
        .error
        .clone()
        .ok_or_else(|| AuthError::InvalidInput(WORKSPACE_CONTENT_WORKER_STATE_INVALID.to_string()))?;
      let recovery = self
        .recovery_handlers
        .get(&record.kind)
        .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string()))?;
      return Ok(WorkspaceContentWorkerOutcome {
        record: recovery.recover(record.id, failure).await?,
        disposition: WorkspaceContentWorkerDisposition::Resumed,
      });
    }
    if matches!(
      record.kind,
      WorkspaceContentOperationKind::Link
        | WorkspaceContentOperationKind::Copy
        | WorkspaceContentOperationKind::Move
        | WorkspaceContentOperationKind::ExtractFolder
    ) && !self.semantic_executors.contains_key(&record.kind)
    {
      // An active semantic operation must not be claimed unless this worker can
      // execute it. Leaving it queued allows another correctly wired node to
      // claim it.
      return Err(AuthError::Storage(
        WorkspaceContentErrorCode::StorageUnavailable.as_str().to_string(),
      ));
    }
    let mut outcome = if record.status != WorkspaceContentOperationStatus::Queued {
      Self::existing_outcome(record)?
    } else {
      match self
        .repository
        .transition(
          envelope.operation_id,
          WorkspaceContentOperationStatus::Queued,
          WorkspaceContentOperationStatus::Running,
          None,
          Some(&self.diagnostic_instance_id),
        )
        .await
      {
        Ok(record) => WorkspaceContentWorkerOutcome {
          record,
          disposition: WorkspaceContentWorkerDisposition::Claimed,
        },
        // A duplicate delivery may race the winning claim. Reloading the
        // aggregate distinguishes that valid replay from an actual invalid edge.
        Err(AuthError::InvalidInput(_)) => self.reload_after_transition_race(envelope.operation_id).await?,
        Err(error) => return Err(error),
      }
    };
    if outcome.record.status == WorkspaceContentOperationStatus::Running
      && let Some(executor) = self.semantic_executors.get(&outcome.record.kind)
    {
      match executor.execute(outcome.record.clone()).await {
        Ok(record) => outcome.record = record,
        Err(error) => {
          super::diagnostics::record_failure(
            &outcome.record,
            error.failure.phase.as_deref().unwrap_or("typed_plan"),
            &error.source,
          );
          if error.retryable {
            // Save the actual cause before returning to the queue. Exhaustion and
            // recovery must not replace it with a retry-budget category.
            match self
              .repository
              .transition(
                outcome.record.id,
                WorkspaceContentOperationStatus::Running,
                WorkspaceContentOperationStatus::Running,
                Some(error.failure.clone()),
                Some(&self.diagnostic_instance_id),
              )
              .await
            {
              Ok(_) => return Err(error.into_source()),
              Err(persistence_error @ AuthError::InvalidInput(_)) => {
                super::diagnostics::record_failure(&outcome.record, "failure_persistence", &persistence_error);
                let latest = self.operation(outcome.record.id).await?;
                if latest.status != WorkspaceContentOperationStatus::Running {
                  return Self::existing_outcome(latest);
                }
                return Err(error.into_source());
              }
              Err(persistence_error) => {
                super::diagnostics::record_failure(&outcome.record, "failure_persistence", &persistence_error);
                return Err(persistence_error);
              }
            }
          }
          outcome.record = self.persist_semantic_failure(&outcome.record, error.failure).await?;
        }
      }
    }
    if outcome.record.status == WorkspaceContentOperationStatus::Succeeded
      && self
        .repository
        .git_work_status(outcome.record.id)
        .await?
        .is_some_and(|state| state.pending)
      && self.repository.has_reconcilable_git_work(outcome.record.id).await?
      && let Some(queue) = &self.queue
    {
      if let Err(error) = queue.wake_git(outcome.record.id).await {
        tracing::warn!(operation_id = %outcome.record.id, dependency = error.dependency(), "Git wake-up deferred to SQL reconciliation");
      }
    }
    Ok(outcome)
  }

  #[tracing::instrument(skip(self), fields(operation_id = %operation_id))]
  async fn finalize_retry_exhaustion(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    let record = self.operation(operation_id).await?;
    if record.status == WorkspaceContentOperationStatus::Succeeded
      && self
        .repository
        .git_work_status(operation_id)
        .await?
        .is_some_and(|state| state.pending)
    {
      let code = self
        .repository
        .git_work_status(operation_id)
        .await?
        .and_then(|state| state.error_code)
        .unwrap_or(WorkspaceContentErrorCode::WorkerRetryExhausted);
      self.repository.record_git_failure(operation_id, code, true).await?;
      return Ok(record);
    }
    if matches!(
      record.status,
      WorkspaceContentOperationStatus::Succeeded
        | WorkspaceContentOperationStatus::Cancelled
        | WorkspaceContentOperationStatus::Failed
        | WorkspaceContentOperationStatus::CleanupRequired
    ) {
      return Ok(record);
    }
    if !matches!(
      record.status,
      WorkspaceContentOperationStatus::Queued | WorkspaceContentOperationStatus::Running
    ) {
      return Err(AuthError::InvalidInput(
        WORKSPACE_CONTENT_WORKER_STATE_INVALID.to_string(),
      ));
    }
    let error = record
      .error
      .clone()
      .map(Ok)
      .unwrap_or_else(|| {
        RedactedWorkspaceContentError::new(
          WorkspaceContentErrorCode::WorkerRetryExhausted,
          "The worker exhausted its retry budget after dependency failures.",
        )
      })
      .map_err(|_| AuthError::InvalidInput(WORKSPACE_CONTENT_WORKER_EXECUTION_FAILED.to_string()))?;
    if self.recovery_handlers.contains_key(&record.kind) {
      return self.persist_semantic_failure(&record, error).await;
    }
    let transition = self
      .repository
      .transition(
        operation_id,
        record.status,
        WorkspaceContentOperationStatus::Failed,
        Some(error),
        Some(&self.diagnostic_instance_id),
      )
      .await;
    match transition {
      Ok(record) => Ok(record),
      Err(AuthError::InvalidInput(_)) => {
        let latest = self.operation(operation_id).await?;
        if matches!(
          latest.status,
          WorkspaceContentOperationStatus::Succeeded
            | WorkspaceContentOperationStatus::Cancelled
            | WorkspaceContentOperationStatus::Failed
            | WorkspaceContentOperationStatus::CleanupRequired
        ) {
          Ok(latest)
        } else {
          Err(AuthError::InvalidInput(
            WORKSPACE_CONTENT_WORKER_STATE_INVALID.to_string(),
          ))
        }
      }
      Err(error) => Err(error),
    }
  }
}

#[cfg(test)]
mod tests {
  use std::sync::Mutex;
  use std::sync::atomic::{AtomicUsize, Ordering};

  use chrono::Utc;
  use myoxus_domain::workspace_content_operation::WorkspaceContentOperationKind;

  use super::*;
  use crate::workspace_content_operation::{
    WorkspaceContentCompensationIntent, WorkspaceContentCreateResult, WorkspaceContentRecipientIntent,
    WorkspaceContentRedirect,
  };

  struct Repository {
    record: Mutex<WorkspaceContentOperationRecord>,
    transitions: Mutex<usize>,
  }

  struct SemanticExecutor {
    calls: AtomicUsize,
  }

  struct FailingSemanticExecutor {
    storage: bool,
  }

  struct CleanupRecovery {
    repository: Arc<Repository>,
  }

  #[async_trait]
  impl WorkspaceContentSemanticRecovery for CleanupRecovery {
    async fn recover(
      &self,
      operation_id: WorkspaceContentOperationId,
      failure: RedactedWorkspaceContentError,
    ) -> AuthResult<WorkspaceContentOperationRecord> {
      self
        .repository
        .transition(
          operation_id,
          WorkspaceContentOperationStatus::CleanupRequired,
          WorkspaceContentOperationStatus::Failed,
          Some(failure),
          None,
        )
        .await
    }
  }

  #[tokio::test]
  async fn extract_cleanup_delivery_preserves_failure_without_executing_publication() {
    let mut operation = record(WorkspaceContentOperationStatus::CleanupRequired);
    operation.kind = WorkspaceContentOperationKind::ExtractFolder;
    let failure = RedactedWorkspaceContentError::new(
      WorkspaceContentErrorCode::PreflightStale,
      "workspace content publication snapshot is stale",
    )
    .unwrap()
    .with_phase("publication");
    operation.error = Some(failure.clone());
    let operation_id = operation.id;
    let repository = Arc::new(Repository {
      record: Mutex::new(operation),
      transitions: Mutex::new(0),
    });
    let executor = Arc::new(SemanticExecutor {
      calls: AtomicUsize::new(0),
    });
    let service = WorkspaceContentWorkerService::new(repository.clone(), Uuid::new_v4())
      .with_semantic_executor(WorkspaceContentOperationKind::ExtractFolder, executor.clone())
      .with_recovery_handler(
        WorkspaceContentOperationKind::ExtractFolder,
        Arc::new(CleanupRecovery {
          repository: repository.clone(),
        }),
      );
    for _ in 0..2 {
      let outcome = service
        .execute(WorkspaceContentWorkerEnvelope { operation_id })
        .await
        .unwrap();
      assert_eq!(outcome.record.status, WorkspaceContentOperationStatus::Failed);
      assert_eq!(outcome.record.error, Some(failure.clone()));
    }
    assert_eq!(executor.calls.load(Ordering::SeqCst), 0);
    assert_eq!(*repository.transitions.lock().unwrap(), 1);
  }

  #[async_trait]
  impl WorkspaceContentSemanticExecutor for SemanticExecutor {
    async fn execute(
      &self,
      mut record: WorkspaceContentOperationRecord,
    ) -> super::super::diagnostics::WorkspaceContentExecutionResult<WorkspaceContentOperationRecord> {
      self.calls.fetch_add(1, Ordering::SeqCst);
      record.status = WorkspaceContentOperationStatus::Succeeded;
      Ok(record)
    }
  }

  #[async_trait]
  impl WorkspaceContentSemanticExecutor for FailingSemanticExecutor {
    async fn execute(
      &self,
      _record: WorkspaceContentOperationRecord,
    ) -> super::super::diagnostics::WorkspaceContentExecutionResult<WorkspaceContentOperationRecord> {
      if self.storage {
        Err(super::super::diagnostics::WorkspaceContentExecutionError::at_phase(
          AuthError::Storage("credential-adjacent storage detail".to_string()),
          "blob_materialization",
        ))
      } else {
        Err(super::super::diagnostics::WorkspaceContentExecutionError::at_phase(
          AuthError::InvalidInput(WorkspaceContentErrorCode::TagAssignmentConstraint.as_str().into()),
          "publication",
        ))
      }
    }
  }

  #[async_trait]
  impl WorkspaceContentOperationRepository for Repository {
    async fn pending_git_operation_ids(&self, _workspace_id: Uuid, _actor_id: Uuid) -> AuthResult<Vec<Uuid>> {
      Ok(Vec::new())
    }
    async fn create_or_get(
      &self,
      _record: WorkspaceContentOperationRecord,
    ) -> AuthResult<WorkspaceContentCreateResult> {
      unreachable!()
    }

    async fn get(
      &self,
      operation_id: WorkspaceContentOperationId,
    ) -> AuthResult<Option<WorkspaceContentOperationRecord>> {
      let record = self.record.lock().unwrap().clone();
      Ok((record.id == operation_id).then_some(record))
    }

    async fn transition(
      &self,
      operation_id: WorkspaceContentOperationId,
      expected: WorkspaceContentOperationStatus,
      next: WorkspaceContentOperationStatus,
      error: Option<RedactedWorkspaceContentError>,
      diagnostic_instance_id: Option<&str>,
    ) -> AuthResult<WorkspaceContentOperationRecord> {
      let mut record = self.record.lock().unwrap();
      if record.id != operation_id || record.status != expected {
        return Err(AuthError::InvalidInput("transition conflict".to_string()));
      }
      record.status = next;
      record.error = error;
      record.diagnostic_instance_id = diagnostic_instance_id.map(str::to_string);
      record.updated_at = Utc::now();
      *self.transitions.lock().unwrap() += 1;
      Ok(record.clone())
    }

    async fn insert_redirect(&self, _redirect: WorkspaceContentRedirect) -> AuthResult<bool> {
      unreachable!()
    }

    async fn list_reconcilable_operation_ids(&self, _limit: usize) -> AuthResult<Vec<WorkspaceContentOperationId>> {
      unreachable!()
    }

    async fn has_reconcilable_git_work(&self, _operation_id: WorkspaceContentOperationId) -> AuthResult<bool> {
      unreachable!()
    }

    async fn git_work_status(
      &self,
      _operation_id: WorkspaceContentOperationId,
    ) -> AuthResult<Option<super::super::WorkspaceContentGitSyncPending>> {
      Ok(None)
    }
    async fn record_git_failure(
      &self,
      _operation_id: WorkspaceContentOperationId,
      _code: WorkspaceContentErrorCode,
      _exhausted: bool,
    ) -> AuthResult<()> {
      unreachable!()
    }
    async fn retry_git_work(&self, _operation_id: WorkspaceContentOperationId, _actor_id: Uuid) -> AuthResult<()> {
      unreachable!()
    }

    async fn enqueue_recipient(&self, _intent: WorkspaceContentRecipientIntent) -> AuthResult<bool> {
      unreachable!()
    }

    async fn append_compensation(&self, _intent: WorkspaceContentCompensationIntent) -> AuthResult<bool> {
      unreachable!()
    }
  }

  fn record(status: WorkspaceContentOperationStatus) -> WorkspaceContentOperationRecord {
    let now = Utc::now();
    WorkspaceContentOperationRecord {
      id: Uuid::new_v4(),
      idempotency_id: Uuid::new_v4(),
      actor_id: Uuid::new_v4(),
      kind: WorkspaceContentOperationKind::Move,
      source_workspace_id: Uuid::new_v4(),
      target_workspace_id: Some(Uuid::new_v4()),
      status,
      preview_revision: Some("revision".to_string()),
      manifest_hash: "a".repeat(64),
      error: None,
      diagnostic_instance_id: None,
      created_at: now,
      updated_at: now,
    }
  }

  fn service(
    status: WorkspaceContentOperationStatus,
  ) -> (
    WorkspaceContentWorkerService,
    Arc<Repository>,
    WorkspaceContentWorkerEnvelope,
  ) {
    let record = record(status);
    let envelope = WorkspaceContentWorkerEnvelope {
      operation_id: record.id,
    };
    let repository = Arc::new(Repository {
      record: Mutex::new(record),
      transitions: Mutex::new(0),
    });
    let executor = Arc::new(SemanticExecutor {
      calls: AtomicUsize::new(0),
    });
    (
      WorkspaceContentWorkerService::new(repository.clone(), Uuid::new_v4())
        .with_semantic_executor(WorkspaceContentOperationKind::Move, executor),
      repository,
      envelope,
    )
  }

  #[tokio::test]
  async fn link_delivery_runs_semantics_once_and_terminal_replay_is_read_only() {
    let mut link = record(WorkspaceContentOperationStatus::Queued);
    link.kind = WorkspaceContentOperationKind::Link;
    let operation_id = link.id;
    let repository = Arc::new(Repository {
      record: Mutex::new(link),
      transitions: Mutex::new(0),
    });
    let executor = Arc::new(SemanticExecutor {
      calls: AtomicUsize::new(0),
    });
    let service = WorkspaceContentWorkerService::new(repository.clone(), Uuid::new_v4())
      .with_semantic_executor(WorkspaceContentOperationKind::Link, executor.clone());

    let first = service
      .execute(WorkspaceContentWorkerEnvelope { operation_id })
      .await
      .expect("execute Link semantics");
    assert_eq!(first.disposition, WorkspaceContentWorkerDisposition::Claimed);
    assert_eq!(first.record.status, WorkspaceContentOperationStatus::Succeeded);
    // Simulate the semantic executor's durable terminal update in this
    // isolated worker-envelope repository.
    repository.record.lock().unwrap().status = WorkspaceContentOperationStatus::Succeeded;
    let replay = service
      .execute(WorkspaceContentWorkerEnvelope { operation_id })
      .await
      .expect("terminal replay");
    assert_eq!(replay.disposition, WorkspaceContentWorkerDisposition::Terminal);
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
  }

  #[tokio::test]
  async fn semantic_operation_without_executor_remains_queued_for_another_node() {
    for kind in [
      WorkspaceContentOperationKind::Link,
      WorkspaceContentOperationKind::Copy,
      WorkspaceContentOperationKind::Move,
      WorkspaceContentOperationKind::ExtractFolder,
    ] {
      let mut record = record(WorkspaceContentOperationStatus::Queued);
      record.kind = kind;
      let operation_id = record.id;
      let repository = Arc::new(Repository {
        record: Mutex::new(record),
        transitions: Mutex::new(0),
      });
      let service = WorkspaceContentWorkerService::new(repository.clone(), Uuid::new_v4());

      assert!(matches!(
        service
          .execute(WorkspaceContentWorkerEnvelope { operation_id })
          .await,
        Err(AuthError::Storage(message)) if message == WorkspaceContentErrorCode::StorageUnavailable.as_str()
      ));
      assert_eq!(
        repository.record.lock().unwrap().status,
        WorkspaceContentOperationStatus::Queued
      );
      assert_eq!(*repository.transitions.lock().unwrap(), 0);
    }
  }

  #[tokio::test]
  async fn exhausted_retry_budget_records_only_a_stable_redacted_failure() {
    let (service, repository, envelope) = service(WorkspaceContentOperationStatus::Running);

    let failed = service.finalize_retry_exhaustion(envelope.operation_id).await.unwrap();

    assert_eq!(failed.status, WorkspaceContentOperationStatus::Failed);
    assert_eq!(
      failed.error.as_ref().map(|error| error.code),
      Some(WorkspaceContentErrorCode::WorkerRetryExhausted)
    );
    assert_eq!(
      failed.error.as_ref().map(|error| error.message()),
      Some("The worker exhausted its retry budget after dependency failures.")
    );
    assert_eq!(*repository.transitions.lock().unwrap(), 1);
  }

  #[tokio::test]
  async fn permanent_semantic_failure_is_terminalized_with_a_safe_reason() {
    let operation = record(WorkspaceContentOperationStatus::Queued);
    let operation_id = operation.id;
    let repository = Arc::new(Repository {
      record: Mutex::new(operation),
      transitions: Mutex::new(0),
    });
    let service = WorkspaceContentWorkerService::new(repository.clone(), Uuid::new_v4()).with_semantic_executor(
      WorkspaceContentOperationKind::Move,
      Arc::new(FailingSemanticExecutor { storage: false }),
    );

    let outcome = service
      .execute(WorkspaceContentWorkerEnvelope { operation_id })
      .await
      .expect("persist permanent semantic failure");

    assert_eq!(outcome.record.status, WorkspaceContentOperationStatus::Failed);
    assert_eq!(
      outcome.record.error.as_ref().map(|error| error.code),
      Some(WorkspaceContentErrorCode::TagAssignmentConstraint)
    );
    assert_eq!(
      outcome.record.error.as_ref().map(|error| error.message()),
      WorkspaceContentErrorCode::TagAssignmentConstraint.safe_message()
    );
    assert_eq!(*repository.transitions.lock().unwrap(), 2);
  }

  #[tokio::test]
  async fn transient_storage_failure_stays_running_for_bounded_queue_retry() {
    let operation = record(WorkspaceContentOperationStatus::Queued);
    let operation_id = operation.id;
    let repository = Arc::new(Repository {
      record: Mutex::new(operation),
      transitions: Mutex::new(0),
    });
    let service = WorkspaceContentWorkerService::new(repository.clone(), Uuid::new_v4()).with_semantic_executor(
      WorkspaceContentOperationKind::Move,
      Arc::new(FailingSemanticExecutor { storage: true }),
    );

    assert!(matches!(
      service.execute(WorkspaceContentWorkerEnvelope { operation_id }).await,
      Err(AuthError::Storage(_))
    ));
    assert_eq!(
      repository.record.lock().unwrap().status,
      WorkspaceContentOperationStatus::Running
    );
    assert_eq!(*repository.transitions.lock().unwrap(), 2);
    let original = repository.record.lock().unwrap().error.clone().unwrap();
    assert_eq!(original.code, WorkspaceContentErrorCode::StorageUnavailable);
    assert_eq!(original.phase.as_deref(), Some("blob_materialization"));
    let exhausted = service.finalize_retry_exhaustion(operation_id).await.unwrap();
    assert_eq!(exhausted.error.as_ref(), Some(&original));
    assert_eq!(exhausted.status, WorkspaceContentOperationStatus::Failed);
  }
}
