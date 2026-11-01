// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Redis worker handler for Workspace Automations.
//!
//! The worker owns queue payload validation only. Trigger matching, run
//! idempotency, audit evidence and action state transitions live in the
//! application service.

use std::sync::Arc;

use myoxus_application::workspace_automation::{
  JOB_EVALUATE_TRIGGER, WORKSPACE_AUTOMATION_QUEUE, WorkspaceAutomationService,
};
use myoxus_worker::{Job, JobError, JobHandler};
use uuid::Uuid;

pub struct WorkspaceAutomationQueueHandler {
  service: Arc<WorkspaceAutomationService>,
}

impl WorkspaceAutomationQueueHandler {
  pub fn new(service: Arc<WorkspaceAutomationService>) -> Self {
    Self { service }
  }
}

#[async_trait::async_trait]
impl JobHandler for WorkspaceAutomationQueueHandler {
  fn queue_name(&self) -> &str {
    WORKSPACE_AUTOMATION_QUEUE
  }

  async fn process(&self, job: &Job) -> Result<Option<serde_json::Value>, JobError> {
    tracing::info!(job_id = %job.id, job_name = %job.name, queue = self.queue_name(), "processing workspace automation job");
    match job.name.as_str() {
      JOB_EVALUATE_TRIGGER => {
        let run_id = required_uuid(&job.data, "run_id")?;
        let run = self
          .service
          .process_run(run_id)
          .await
          .map_err(|error| JobError::Retryable(error.to_string()))?;
        Ok(Some(serde_json::json!({
          "run_id": run.id,
          "automation_id": run.automation_id,
          "workspace_id": run.workspace_id,
          "status": run.status.as_str(),
          "dead_letter": run.dead_letter,
          "error_code": run.error_code,
        })))
      }
      other => Err(JobError::Permanent(format!(
        "MIX_AUTOMATION_RUN_FAILED: unknown workspace automation job name: {other}"
      ))),
    }
  }
}

fn required_uuid(data: &serde_json::Value, key: &str) -> Result<Uuid, JobError> {
  match data.get(key) {
    Some(serde_json::Value::String(value)) => value
      .parse()
      .map_err(|_| JobError::Permanent(format!("MIX_AUTOMATION_TRIGGER_INVALID: invalid {key}"))),
    _ => Err(JobError::Permanent(format!(
      "MIX_AUTOMATION_TRIGGER_INVALID: missing {key}"
    ))),
  }
}

/// Dispatch one committed automation intent without acknowledging any other
/// subscriber's event. Native admission deduplicates concurrent/lost handoffs.
/// Do not hold an outbox connection across the service's calls into the same
/// pool: the runtime listener also retains a connection for its lifetime.
pub async fn dispatch_committed_trigger(
  pool: &sqlx::PgPool,
  service: &WorkspaceAutomationService,
  event_id: Uuid,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
  let payload: Option<serde_json::Value> = sqlx::query_scalar(
    "SELECT payload FROM outbox_events WHERE id=$1 AND event_type='workspace_automation_trigger'
     AND processed_at IS NULL",
  )
  .bind(event_id)
  .fetch_optional(pool)
  .await?;
  if let Some(payload) = payload {
    let event = serde_json::from_value(payload)?;
    service.enqueue_database_event(event).await?;
    sqlx::query(
      "UPDATE outbox_events SET processed_at=now() WHERE id=$1
       AND event_type='workspace_automation_trigger' AND processed_at IS NULL",
    )
    .bind(event_id)
    .execute(pool)
    .await?;
  }
  Ok(())
}

/// The native producer commits acceptance and this intent together. Delivery is
/// retryable; only the correlated engine acknowledgement retires this intent.
pub async fn dispatch_committed_signal(
  pool: &sqlx::PgPool,
  service: &WorkspaceAutomationService,
  event_id: Uuid,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
  let payload: Option<serde_json::Value> = sqlx::query_scalar(
    "SELECT payload FROM outbox_events WHERE id=$1 AND event_type='workspace_automation_signal'
     AND processed_at IS NULL",
  )
  .bind(event_id)
  .fetch_optional(pool)
  .await?;
  if let Some(payload) = payload {
    let signal: myoxus_domain::workspace_automation::WorkflowSignalEnvelope = serde_json::from_value(payload)?;
    if signal.event_id != event_id {
      return Err("workflow signal intent correlation mismatch".into());
    }
    service.deliver_workflow_signal(signal).await?;
    sqlx::query(
      "UPDATE outbox_events SET processed_at=now() WHERE id=$1
       AND event_type='workspace_automation_signal' AND processed_at IS NULL",
    )
    .bind(event_id)
    .execute(pool)
    .await?;
  }
  Ok(())
}
