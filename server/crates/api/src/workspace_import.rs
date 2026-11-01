// SPDX-License-Identifier: AGPL-3.0-or-later
//! Runtime policy projection and Redis worker adapter for workspace imports.

use std::sync::Arc;

use myoxus_application::auth::AuthError;
use myoxus_application::workspace_import::{
  WORKSPACE_IMPORT_JOB, WORKSPACE_IMPORT_QUEUE, WorkspaceImportPolicy, WorkspaceImportPolicyProvider,
  WorkspaceImportService, WorkspaceImportWorkerEnvelope,
};
use myoxus_worker::{Job, JobError, JobHandler};

use crate::config::AppConfig;
use crate::config_reload::{ConfigOverrides, EffectiveConfig};

pub struct ApiWorkspaceImportPolicyProvider {
  base: Arc<AppConfig>,
  overrides: Arc<tokio::sync::RwLock<ConfigOverrides>>,
}

impl ApiWorkspaceImportPolicyProvider {
  pub fn new(base: AppConfig, overrides: Arc<tokio::sync::RwLock<ConfigOverrides>>) -> Self {
    Self {
      base: Arc::new(base),
      overrides,
    }
  }
}

#[async_trait::async_trait]
impl WorkspaceImportPolicyProvider for ApiWorkspaceImportPolicyProvider {
  async fn current_policy(&self) -> WorkspaceImportPolicy {
    let overrides = Arc::new(self.overrides.read().await.clone());
    let effective = EffectiveConfig::new(self.base.clone(), overrides);
    let config = effective.workspace_import();
    WorkspaceImportPolicy {
      limits: config.decoder_limits(
        self.base.storage.max_upload_bytes(),
        self.base.websocket.max_http_buffer_size(),
        self.base.databases.max_fields_per_database,
        self.base.databases.max_views_per_database,
      ),
      staging_retention_hours: config.staging_retention_hours,
      job_timeout_seconds: config.job_timeout_seconds,
    }
  }
}

pub struct WorkspaceImportQueueHandler {
  service: Arc<WorkspaceImportService>,
}

impl WorkspaceImportQueueHandler {
  pub fn new(service: Arc<WorkspaceImportService>) -> Self {
    Self { service }
  }
}

#[async_trait::async_trait]
impl JobHandler for WorkspaceImportQueueHandler {
  fn queue_name(&self) -> &str {
    WORKSPACE_IMPORT_QUEUE
  }

  async fn process(&self, job: &Job) -> Result<Option<serde_json::Value>, JobError> {
    if job.name != WORKSPACE_IMPORT_JOB {
      return Err(JobError::Permanent(format!(
        "MIX_WORKSPACE_IMPORT_JOB_INVALID: unsupported job {}",
        job.name
      )));
    }
    let envelope: WorkspaceImportWorkerEnvelope = serde_json::from_value(job.data.clone())
      .map_err(|_| JobError::Permanent("MIX_WORKSPACE_IMPORT_JOB_INVALID: invalid envelope".to_string()))?;
    let started = std::time::Instant::now();
    let queue_latency_ms = (chrono::Utc::now().timestamp_millis() - job.timestamp).max(0) as f64;
    let timeout_seconds = self.service.current_policy().await.job_timeout_seconds.max(1);
    let result = tokio::time::timeout(
      std::time::Duration::from_secs(timeout_seconds),
      self.service.run_worker_operation(envelope.clone()),
    )
    .await
    .map_err(|_| AuthError::Storage("workspace import job timed out".to_string()))
    .and_then(|result| result);

    match result {
      Ok(record) => {
        self.service.record_worker_observation(
          envelope.operation,
          Some(record.status),
          started.elapsed().as_secs_f64() * 1_000.0,
          queue_latency_ms,
          job.attempts_made > 0,
        );
        Ok(Some(serde_json::json!({
          "workspaceImportId": record.id,
          "status": record.status.as_str(),
          "operation": envelope.operation.as_str(),
        })))
      }
      Err(error) if job.attempts_made + 1 < job.opts.max_attempts => {
        self.service.record_worker_observation(
          envelope.operation,
          None,
          started.elapsed().as_secs_f64() * 1_000.0,
          queue_latency_ms,
          true,
        );
        Err(JobError::Retryable(redacted_worker_error(&error)))
      }
      Err(error) => {
        let terminal = self
          .service
          .finalize_retry_exhaustion(envelope.import_id)
          .await
          .map_err(|finalize_error| JobError::Permanent(redacted_worker_error(&finalize_error)))?;
        self.service.record_worker_observation(
          envelope.operation,
          Some(terminal.status),
          started.elapsed().as_secs_f64() * 1_000.0,
          queue_latency_ms,
          true,
        );
        Err(JobError::Permanent(redacted_worker_error(&error)))
      }
    }
  }
}

fn redacted_worker_error(error: &AuthError) -> String {
  match error {
    AuthError::Storage(_) => "MIX_WORKSPACE_IMPORT_STORAGE_FAILED".to_string(),
    AuthError::InvalidInput(code) if code.starts_with("MIX_WORKSPACE_IMPORT_") => code.clone(),
    AuthError::ActionForbidden | AuthError::AuthenticationRequired => {
      "MIX_WORKSPACE_IMPORT_PERMISSION_DENIED".to_string()
    }
    _ => "MIX_WORKSPACE_IMPORT_APPLY_BLOCKED".to_string(),
  }
}
