// SPDX-License-Identifier: AGPL-3.0-or-later
//! Redis worker adapter for durable cross-workspace content operations.

use std::sync::Arc;

use myoxus_application::audit::{AuditActor, AuditCategory, AuditEvent, AuditRecorder, AuditTarget};
use myoxus_application::auth::AuthError;
use myoxus_application::workspace_content_operation::coordination::{
  WORKSPACE_CONTENT_QUEUE, WORKSPACE_CONTENT_RESUME_JOB,
};
use myoxus_application::workspace_content_operation::worker::{
  WORKSPACE_CONTENT_WORKER_EXECUTION_FAILED, WORKSPACE_CONTENT_WORKER_INVALID_JOB, WorkspaceContentWorkerEnvelope,
  WorkspaceContentWorkerPort,
};
use myoxus_application::workspace_content_operation::{failure_code, record_operation_failure};
use myoxus_domain::workspace_content_operation::{
  WorkspaceContentErrorCode, WorkspaceContentOperationRecord, WorkspaceContentOperationStatus,
};
use myoxus_worker::{Job, JobError, JobHandler};

pub struct WorkspaceContentQueueHandler {
  service: Arc<dyn WorkspaceContentWorkerPort>,
  audit: AuditRecorder,
}

impl WorkspaceContentQueueHandler {
  pub fn new(service: Arc<dyn WorkspaceContentWorkerPort>) -> Self {
    Self {
      service,
      audit: AuditRecorder::noop(),
    }
  }

  pub fn with_audit_recorder(mut self, audit: AuditRecorder) -> Self {
    self.audit = audit;
    self
  }

  fn permanent(code: &str) -> JobError {
    JobError::Permanent(code.to_string())
  }

  async fn record_terminal_failure(&self, record: &WorkspaceContentOperationRecord) {
    if !matches!(
      record.status,
      WorkspaceContentOperationStatus::Failed | WorkspaceContentOperationStatus::CleanupRequired
    ) {
      return;
    }
    self
      .audit
      .record(
        AuditEvent::mutation(
          "workspace_content.terminal_failure",
          AuditCategory::Workspace,
          Some(AuditTarget::entity(
            "workspace_content_operation",
            record.id,
            None::<String>,
          )),
          AuditActor::user(record.actor_id, None),
          None,
          Some(serde_json::json!({
            "operationId": record.id,
            "operationKind": record.kind.as_str(),
            "sourceWorkspaceId": record.source_workspace_id,
            "targetWorkspaceId": record.target_workspace_id,
            "status": record.status.as_str(),
            "errorCode": record.error.as_ref().map(|error| error.code.as_str()),
            "errorPhase": record.error.as_ref().and_then(|error| error.phase.as_deref()),
          })),
        )
        .with_metadata(serde_json::json!({
          "diagnosticInstanceId": record.diagnostic_instance_id,
        })),
      )
      .await;
  }
}

#[async_trait::async_trait]
impl JobHandler for WorkspaceContentQueueHandler {
  fn queue_name(&self) -> &str {
    WORKSPACE_CONTENT_QUEUE
  }

  #[tracing::instrument(skip_all, fields(queue = WORKSPACE_CONTENT_QUEUE, operation_id = tracing::field::Empty))]
  async fn process(&self, job: &Job) -> Result<Option<serde_json::Value>, JobError> {
    if job.name != WORKSPACE_CONTENT_RESUME_JOB {
      return Err(Self::permanent(WORKSPACE_CONTENT_WORKER_INVALID_JOB));
    }
    let envelope: WorkspaceContentWorkerEnvelope =
      serde_json::from_value(job.data.clone()).map_err(|_| Self::permanent(WORKSPACE_CONTENT_WORKER_INVALID_JOB))?;
    tracing::Span::current().record("operation_id", tracing::field::display(envelope.operation_id));

    let execution = self.service.execute(envelope).await;
    if let Err(error) = &execution {
      record_operation_failure(envelope.operation_id, None, "worker_dispatch", error);
    }
    match execution {
      Ok(outcome) => {
        self.record_terminal_failure(&outcome.record).await;
        if matches!(
          outcome.record.status,
          WorkspaceContentOperationStatus::Failed | WorkspaceContentOperationStatus::CleanupRequired
        ) {
          return Err(Self::permanent(
            outcome
              .record
              .error
              .as_ref()
              .map(|error| error.code.as_str())
              .unwrap_or(WORKSPACE_CONTENT_WORKER_EXECUTION_FAILED),
          ));
        }
        Ok(Some(serde_json::json!({
          "operationId": outcome.record.id,
          "status": outcome.record.status.as_str(),
          "disposition": outcome.disposition.as_str(),
        })))
      }
      Err(AuthError::Storage(code)) if job.attempts_made + 1 < job.opts.max_attempts => Err(JobError::Retryable(
        WorkspaceContentErrorCode::parse(&code)
          .unwrap_or(WorkspaceContentErrorCode::StorageUnavailable)
          .as_str()
          .to_string(),
      )),
      Err(AuthError::Storage(code)) => {
        let fallback = WorkspaceContentErrorCode::parse(&code).unwrap_or(WorkspaceContentErrorCode::StorageUnavailable);
        let code = match self.service.finalize_retry_exhaustion(envelope.operation_id).await {
          Ok(record) => {
            self.record_terminal_failure(&record).await;
            record.error.map(|failure| failure.code).unwrap_or(fallback)
          }
          Err(error) => {
            record_operation_failure(envelope.operation_id, None, "failure_persistence", &error);
            tracing::warn!(operation_id = %envelope.operation_id, cause = fallback.as_str(),
              "XWS retry exhaustion could not be persisted; SQL reconciliation will recover the non-terminal operation");
            fallback
          }
        };
        Err(Self::permanent(code.as_str()))
      }
      Err(error) => Err(Self::permanent(failure_code(&error).as_str())),
    }
  }
}

#[cfg(test)]
mod tests {
  use std::sync::atomic::{AtomicBool, Ordering};

  use chrono::Utc;
  use myoxus_application::audit::{AuditEntry, AuditError, AuditFilter, AuditLogStore};
  use myoxus_application::auth::AuthResult;
  use myoxus_application::workspace_content_operation::worker::{
    WorkspaceContentWorkerDisposition, WorkspaceContentWorkerOutcome,
  };
  use myoxus_domain::ids::WorkspaceContentOperationId;
  use myoxus_domain::workspace_content_operation::{
    RedactedWorkspaceContentError, WorkspaceContentErrorCode, WorkspaceContentOperationKind,
    WorkspaceContentOperationRecord,
  };
  use myoxus_worker::JobOptions;
  use uuid::Uuid;

  use super::*;

  struct StorageFailure {
    finalized: AtomicBool,
  }

  #[async_trait::async_trait]
  impl WorkspaceContentWorkerPort for StorageFailure {
    async fn execute(&self, _envelope: WorkspaceContentWorkerEnvelope) -> AuthResult<WorkspaceContentWorkerOutcome> {
      Err(AuthError::Storage(
        "redis-password=must-not-reach-job-errors".to_string(),
      ))
    }

    async fn finalize_retry_exhaustion(
      &self,
      _operation_id: WorkspaceContentOperationId,
    ) -> AuthResult<WorkspaceContentOperationRecord> {
      self.finalized.store(true, Ordering::SeqCst);
      Err(AuthError::Storage("database-url=must-not-leak".to_string()))
    }
  }

  struct TerminalFailure {
    record: WorkspaceContentOperationRecord,
  }

  #[async_trait::async_trait]
  impl WorkspaceContentWorkerPort for TerminalFailure {
    async fn execute(&self, _envelope: WorkspaceContentWorkerEnvelope) -> AuthResult<WorkspaceContentWorkerOutcome> {
      Ok(WorkspaceContentWorkerOutcome {
        record: self.record.clone(),
        disposition: WorkspaceContentWorkerDisposition::Terminal,
      })
    }

    async fn finalize_retry_exhaustion(
      &self,
      _operation_id: WorkspaceContentOperationId,
    ) -> AuthResult<WorkspaceContentOperationRecord> {
      unreachable!("terminal outcomes do not enter retry exhaustion")
    }
  }

  #[derive(Default)]
  struct RecordingAuditStore {
    events: std::sync::Mutex<Vec<AuditEvent>>,
  }

  #[async_trait::async_trait]
  impl AuditLogStore for RecordingAuditStore {
    async fn record(&self, event: AuditEvent) -> Result<(), AuditError> {
      self.events.lock().expect("audit event lock").push(event);
      Ok(())
    }

    async fn list(&self, _filter: AuditFilter, _skip: i64, _take: i64) -> Result<Vec<AuditEntry>, AuditError> {
      Ok(Vec::new())
    }

    async fn count(&self, _filter: AuditFilter) -> Result<i64, AuditError> {
      Ok(0)
    }

    async fn get_by_id(&self, _id: Uuid) -> Result<Option<AuditEntry>, AuditError> {
      Ok(None)
    }
  }

  fn terminal_failure_record() -> WorkspaceContentOperationRecord {
    let now = Utc::now();
    WorkspaceContentOperationRecord {
      id: Uuid::new_v4(),
      idempotency_id: Uuid::new_v4(),
      actor_id: Uuid::new_v4(),
      kind: WorkspaceContentOperationKind::Move,
      source_workspace_id: Uuid::new_v4(),
      target_workspace_id: Some(Uuid::new_v4()),
      status: WorkspaceContentOperationStatus::Failed,
      preview_revision: Some("preview-does-not-belong-in-audit".to_string()),
      manifest_hash: "a".repeat(64),
      error: Some(
        RedactedWorkspaceContentError::new(
          WorkspaceContentErrorCode::TagAssignmentConstraint,
          "title=private blob=s3://secret token=must-not-leak",
        )
        .expect("valid bounded redacted test error")
        .with_phase("publication"),
      ),
      diagnostic_instance_id: Some("api-worker-2".to_string()),
      created_at: now,
      updated_at: now,
    }
  }

  fn job(data: serde_json::Value, attempts_made: i32) -> Job {
    Job {
      id: "1".to_string(),
      name: WORKSPACE_CONTENT_RESUME_JOB.to_string(),
      data,
      opts: JobOptions::default(),
      timestamp: 0,
      attempts_made,
      finished_on: None,
      failed_reason: None,
      heartbeat: None,
      return_value: None,
    }
  }

  #[tokio::test]
  async fn poison_envelope_is_permanent_and_does_not_enter_the_service() {
    let service = Arc::new(StorageFailure {
      finalized: AtomicBool::new(false),
    });
    let handler = WorkspaceContentQueueHandler::new(service.clone());

    let error = handler
      .process(&job(
        serde_json::json!({ "operationId": Uuid::new_v4(), "content": "forbidden" }),
        0,
      ))
      .await
      .unwrap_err();

    assert_eq!(error.to_string(), "permanent: XWS_WORKER_JOB_INVALID");
    assert!(!service.finalized.load(Ordering::SeqCst));
  }

  #[tokio::test]
  async fn storage_details_are_redacted_and_last_attempt_terminalizes_the_queue_job() {
    let service = Arc::new(StorageFailure {
      finalized: AtomicBool::new(false),
    });
    let handler = WorkspaceContentQueueHandler::new(service.clone());
    let operation_id = Uuid::new_v4();

    let retry = handler
      .process(&job(serde_json::json!({ "operationId": operation_id }), 0))
      .await
      .unwrap_err();
    let exhausted = handler
      .process(&job(serde_json::json!({ "operationId": operation_id }), 2))
      .await
      .unwrap_err();

    assert_eq!(retry.to_string(), "retryable: XWS_STORAGE_UNAVAILABLE");
    assert_eq!(exhausted.to_string(), "permanent: XWS_STORAGE_UNAVAILABLE");
    assert!(service.finalized.load(Ordering::SeqCst));
    assert!(!retry.to_string().contains("password"));
    assert!(!exhausted.to_string().contains("database-url"));
  }

  #[tokio::test]
  async fn terminal_failure_audit_contains_only_stable_operation_metadata() {
    let record = terminal_failure_record();
    let audit_store = Arc::new(RecordingAuditStore::default());
    let handler = WorkspaceContentQueueHandler::new(Arc::new(TerminalFailure { record: record.clone() }))
      .with_audit_recorder(AuditRecorder::new(audit_store.clone()));

    let failure = handler
      .process(&job(serde_json::json!({ "operationId": record.id }), 0))
      .await
      .expect_err("a failed product operation must appear in the failed queue, not completed");
    assert_eq!(failure.to_string(), "permanent: XWS_TAG_ASSIGNMENT_CONSTRAINT");

    let events = audit_store.events.lock().expect("audit event lock");
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.event_key, "workspace_content.terminal_failure");
    assert_eq!(event.actor.user_id, Some(record.actor_id));
    assert_eq!(
      event.new_value,
      Some(serde_json::json!({
        "operationId": record.id,
        "operationKind": "move",
        "sourceWorkspaceId": record.source_workspace_id,
        "targetWorkspaceId": record.target_workspace_id,
        "status": "failed",
        "errorCode": "XWS_TAG_ASSIGNMENT_CONSTRAINT",
        "errorPhase": "publication",
      }))
    );
    assert_eq!(
      event.metadata,
      Some(serde_json::json!({ "diagnosticInstanceId": "api-worker-2" }))
    );
    let serialized = serde_json::to_string(&serde_json::json!({
      "before": event.old_value,
      "after": event.new_value,
      "metadata": event.metadata,
    }))
    .expect("serialize audit projection");
    for forbidden in ["private", "s3://", "token", "preview-does-not-belong-in-audit"] {
      assert!(!serialized.contains(forbidden), "audit leaked {forbidden}");
    }
  }
}
