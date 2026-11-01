//! Redis worker handler for Document Graph reindex jobs.
//!
//! This layer validates queue payload shape and delegates all graph work to
//! `DocumentGraphService`; it intentionally contains no extraction, ACL or
//! persistence logic of its own.

use std::sync::Arc;

use myoxus_application::document_graph::{
  DocumentGraphService, DocumentGraphServiceError, ERR_DOC_NOT_FOUND, ERR_QUERY_INVALID, JOB_REINDEX_DOCUMENT,
  JOB_REINDEX_WORKSPACE_BATCH, parse_reindex_reason,
};
use myoxus_worker::{Job, JobError, JobHandler};
use uuid::Uuid;

pub struct DocumentGraphQueueHandler {
  service: Arc<DocumentGraphService>,
}

impl DocumentGraphQueueHandler {
  pub fn new(service: Arc<DocumentGraphService>) -> Self {
    Self { service }
  }
}

#[async_trait::async_trait]
impl JobHandler for DocumentGraphQueueHandler {
  fn queue_name(&self) -> &str {
    myoxus_application::document_graph::DOCUMENT_GRAPH_QUEUE
  }

  async fn process(&self, job: &Job) -> Result<Option<serde_json::Value>, JobError> {
    tracing::info!(job_id = %job.id, job_name = %job.name, queue = self.queue_name(), "processing document graph job");
    match job.name.as_str() {
      JOB_REINDEX_DOCUMENT => {
        let workspace_id = required_uuid(&job.data, "workspace_id")?;
        let doc_id = required_uuid(&job.data, "doc_id")?;
        let reason = required_reason(&job.data)?;
        let outcome = self
          .service
          .reindex_document_now(workspace_id, doc_id)
          .await
          .map_err(classify_reindex_error)?;
        Ok(Some(serde_json::json!({
          "workspace_id": workspace_id,
          "doc_id": doc_id,
          "reason": reason.as_str(),
          "reindexed_count": outcome.reindexed_count,
          "failed_count": outcome.failed_count,
          "skipped_count": outcome.skipped_count,
        })))
      }
      JOB_REINDEX_WORKSPACE_BATCH => {
        let limit = optional_i64(&job.data, "limit").unwrap_or_else(|| self.service.limits().max_reindex_batch);
        let workspace_limit =
          optional_i64(&job.data, "workspace_limit").unwrap_or_else(|| self.service.limits().max_catch_up_workspaces);
        let reason = required_reason(&job.data)?;
        let outcome = match optional_uuid(&job.data, "workspace_id")? {
          Some(workspace_id) => self.service.reindex_workspace_batch_now(workspace_id, limit).await,
          None => {
            self
              .service
              .reindex_due_workspaces_batch_now(limit, workspace_limit)
              .await
          }
        }
        .map_err(classify_reindex_error)?;
        Ok(Some(serde_json::json!({
          "reason": reason.as_str(),
          "requested_count": outcome.requested_count,
          "reindexed_count": outcome.reindexed_count,
          "failed_count": outcome.failed_count,
          "skipped_count": outcome.skipped_count,
        })))
      }
      other => Err(JobError::Permanent(format!(
        "{ERR_QUERY_INVALID}: unknown document graph job name: {other}"
      ))),
    }
  }
}

fn classify_reindex_error(error: DocumentGraphServiceError) -> JobError {
  match error.code {
    ERR_QUERY_INVALID | ERR_DOC_NOT_FOUND => JobError::Permanent(error.to_string()),
    _ => JobError::Retryable(error.to_string()),
  }
}

fn required_uuid(data: &serde_json::Value, key: &str) -> Result<Uuid, JobError> {
  optional_uuid(data, key)?.ok_or_else(|| JobError::Permanent(format!("{ERR_QUERY_INVALID}: missing {key}")))
}

fn optional_uuid(data: &serde_json::Value, key: &str) -> Result<Option<Uuid>, JobError> {
  match data.get(key) {
    Some(serde_json::Value::String(value)) => value
      .parse()
      .map(Some)
      .map_err(|_| JobError::Permanent(format!("{ERR_QUERY_INVALID}: invalid {key}"))),
    Some(serde_json::Value::Null) | None => Ok(None),
    Some(_) => Err(JobError::Permanent(format!("{ERR_QUERY_INVALID}: invalid {key}"))),
  }
}

fn optional_i64(data: &serde_json::Value, key: &str) -> Option<i64> {
  data.get(key).and_then(serde_json::Value::as_i64)
}

fn required_reason(
  data: &serde_json::Value,
) -> Result<myoxus_domain::document_graph::DocumentGraphReindexReason, JobError> {
  let value = data
    .get("reason")
    .and_then(serde_json::Value::as_str)
    .ok_or_else(|| JobError::Permanent(format!("{ERR_QUERY_INVALID}: missing reason")))?;
  parse_reindex_reason(value).map_err(|_| JobError::Permanent(format!("{ERR_QUERY_INVALID}: invalid reason")))
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_application::document_graph::{DocumentGraphServiceError, ERR_SERVICE_UNAVAILABLE};

  #[test]
  fn graph_contract_errors_do_not_enter_retry_loops() {
    let error = DocumentGraphServiceError {
      code: ERR_QUERY_INVALID,
      message: "constraint violation".to_string(),
    };

    assert!(matches!(classify_reindex_error(error), JobError::Permanent(_)));
  }

  #[test]
  fn transient_graph_infrastructure_errors_remain_retryable() {
    let error = DocumentGraphServiceError {
      code: ERR_SERVICE_UNAVAILABLE,
      message: "storage unavailable".to_string(),
    };

    assert!(matches!(classify_reindex_error(error), JobError::Retryable(_)));
  }
}
