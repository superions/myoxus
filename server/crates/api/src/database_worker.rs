//! Redis worker handler for Database background jobs.
//!
//! The handler validates queue payload shape and delegates recomputation to
//! the native Projection and Import/Export owners. It owns no SQL or
//! aggregation logic.

use std::sync::Arc;

use myoxus_application::database::{
  DATABASE_QUEUE, DatabaseImportExportService, DatabaseProjectionService, JOB_BULK_EXPORT, JOB_BULK_IMPORT,
  JOB_INDEX_ROW, JOB_RECOMPUTE_FORMULAS, JOB_RECOMPUTE_ROLLUPS, JOB_RECOMPUTE_STALE_PROJECTIONS, JOB_REINDEX_SEARCH,
};
use myoxus_worker::{Job, JobError, JobHandler};
use uuid::Uuid;

pub struct DatabaseQueueHandler {
  projection: Arc<DatabaseProjectionService>,
  import_export: Arc<DatabaseImportExportService>,
}

impl DatabaseQueueHandler {
  pub fn new(projection: Arc<DatabaseProjectionService>, import_export: Arc<DatabaseImportExportService>) -> Self {
    Self {
      projection,
      import_export,
    }
  }
}

#[async_trait::async_trait]
impl JobHandler for DatabaseQueueHandler {
  fn queue_name(&self) -> &str {
    DATABASE_QUEUE
  }

  async fn process(&self, job: &Job) -> Result<Option<serde_json::Value>, JobError> {
    tracing::info!(job_id = %job.id, job_name = %job.name, queue = self.queue_name(), "processing database job");
    match job.name.as_str() {
      JOB_RECOMPUTE_ROLLUPS | JOB_RECOMPUTE_FORMULAS | JOB_RECOMPUTE_STALE_PROJECTIONS => {
        let limit = optional_i64(&job.data, "limit").unwrap_or(100);
        let database_limit = optional_i64(&job.data, "database_limit").unwrap_or(25);
        let reason = optional_string(&job.data, "reason").unwrap_or("manual");
        let workspace_id = optional_uuid(&job.data, "workspace_id")?;
        tracing::debug!(
          workspace_id = ?workspace_id,
          job_name = %job.name,
          limit,
          database_limit,
          reason,
          "database recompute job starting"
        );
        let rollup_outcome = if job.name == JOB_RECOMPUTE_FORMULAS {
          Default::default()
        } else {
          self
            .projection
            .recompute_stale_rollups(workspace_id, limit, database_limit, reason)
            .await
            .map_err(|error| {
              tracing::warn!(
                workspace_id = ?workspace_id,
                job_name = %job.name,
                error = %error,
                "database recompute rollups failed"
              );
              JobError::Retryable(error.to_string())
            })?
        };
        let formula_outcome = if job.name == JOB_RECOMPUTE_ROLLUPS {
          Default::default()
        } else {
          self
            .projection
            .recompute_stale_formulas(workspace_id, limit, database_limit, reason)
            .await
            .map_err(|error| {
              tracing::warn!(
                workspace_id = ?workspace_id,
                job_name = %job.name,
                error = %error,
                "database recompute formulas failed"
              );
              JobError::Retryable(error.to_string())
            })?
        };
        tracing::info!(
          workspace_id = ?workspace_id,
          job_name = %job.name,
          rollup_recomputed = rollup_outcome.recomputed_count,
          rollup_failed = rollup_outcome.failed_count,
          formula_recomputed = formula_outcome.recomputed_count,
          formula_failed = formula_outcome.failed_count,
          "database recompute job complete"
        );
        Ok(Some(serde_json::json!({
          "workspace_id": workspace_id,
          "reason": reason,
          "rollup_requested_count": rollup_outcome.requested_count,
          "rollup_recomputed_count": rollup_outcome.recomputed_count,
          "rollup_failed_count": rollup_outcome.failed_count,
          "rollup_skipped_count": rollup_outcome.skipped_count,
          "formula_requested_count": formula_outcome.requested_count,
          "formula_recomputed_count": formula_outcome.recomputed_count,
          "formula_failed_count": formula_outcome.failed_count,
          "formula_skipped_count": formula_outcome.skipped_count,
        })))
      }
      JOB_INDEX_ROW => {
        // Refreshing the same derived row is idempotent, so repository
        // outages use the queue's bounded retry policy. Invalid payloads and
        // domain failures remain terminal.
        let workspace_id = optional_uuid(&job.data, "workspace_id")?;
        let database_id = required_uuid(&job.data, "database_id")?;
        let row_id = required_uuid(&job.data, "row_id")?;
        tracing::debug!(
          workspace_id = ?workspace_id,
          database_id = %database_id,
          row_id = %row_id,
          "database index row job starting"
        );
        self
          .projection
          .refresh_search_index_inline_job(workspace_id, database_id, row_id)
          .await
          .map_err(|error| {
            tracing::warn!(
              workspace_id = ?workspace_id,
              database_id = %database_id,
              row_id = %row_id,
              error_code = error.code,
              retryable = error.is_retryable_storage_failure(),
              "database index row job failed"
            );
            classify_database_job_error(error, "MIX_DATABASE_INDEX_ROW_FAILED")
          })?;
        tracing::info!(
          workspace_id = ?workspace_id,
          database_id = %database_id,
          row_id = %row_id,
          "database index row job complete"
        );
        Ok(Some(serde_json::json!({
          "workspace_id": workspace_id,
          "database_id": database_id,
          "row_id": row_id,
        })))
      }
      JOB_REINDEX_SEARCH => {
        // A retry resumes the idempotent upserts from the beginning. Rows
        // written by an earlier partial attempt are safely replaced.
        let workspace_id = optional_uuid(&job.data, "workspace_id")?;
        let database_id = required_uuid(&job.data, "database_id")?;
        tracing::debug!(
          workspace_id = ?workspace_id,
          database_id = %database_id,
          "database reindex search job starting"
        );
        self
          .projection
          .reindex_database_search(workspace_id, database_id)
          .await
          .map_err(|error| {
            tracing::warn!(
              workspace_id = ?workspace_id,
              database_id = %database_id,
              error_code = error.code,
              retryable = error.is_retryable_storage_failure(),
              "database reindex search job failed"
            );
            classify_database_job_error(error, "MIX_DATABASE_REINDEX_FAILED")
          })?;
        tracing::info!(
          workspace_id = ?workspace_id,
          database_id = %database_id,
          "database reindex search job complete"
        );
        Ok(Some(serde_json::json!({
          "workspace_id": workspace_id,
          "database_id": database_id,
        })))
      }
      JOB_BULK_IMPORT | JOB_BULK_EXPORT => {
        // The native job record owns identity, authorization and terminal
        // arbitration. Import commits its result with the created data; export
        // reads back the retained terminal result after its conditional write.
        // This handler only decodes each operation's actual queue envelope.
        let import_job_id = required_uuid(&job.data, "import_job_id")?;
        let workspace_id = optional_uuid(&job.data, "workspace_id")?;
        let actor_id = optional_uuid(&job.data, "actor_id")?;
        let database_title = optional_string(&job.data, "database_title")
          .unwrap_or("Imported database")
          .to_string();
        tracing::debug!(
          import_job_id = %import_job_id,
          workspace_id = ?workspace_id,
          actor_id = ?actor_id,
          job_name = %job.name,
          content_bytes = job.data.get("content_base64").and_then(|v| v.as_str()).map(|s| s.len()).unwrap_or(0),
          "database bulk job starting"
        );
        let actor = actor_id.ok_or_else(|| {
          JobError::Permanent(
            "MIX_DATABASE_BULK_PAYLOAD_INVALID: actor_id is required for bulk import/export jobs".to_string(),
          )
        })?;
        if job.name == JOB_BULK_EXPORT {
          let summary = self
            .import_export
            .run_bulk_export_job(import_job_id, actor)
            .await
            .map_err(|error| {
              tracing::warn!(
                import_job_id = %import_job_id,
                workspace_id = ?workspace_id,
                actor_id = %actor,
                error = %error,
                "database bulk export job failed"
              );
              classify_database_job_error(error, "MIX_DATABASE_BULK_EXPORT_FAILED")
            })?;
          tracing::info!(
            import_job_id = %import_job_id,
            workspace_id = ?workspace_id,
            actor_id = %actor,
            "database bulk export job complete"
          );
          return Ok(Some(summary));
        }
        let content_base64 = optional_string(&job.data, "content_base64").ok_or_else(|| {
          JobError::Permanent("MIX_DATABASE_BULK_PAYLOAD_INVALID: missing content_base64".to_string())
        })?;
        use base64::Engine as _;
        let content = base64::engine::general_purpose::STANDARD
          .decode(content_base64)
          .map_err(|error| {
            JobError::Permanent(format!(
              "MIX_DATABASE_BULK_PAYLOAD_INVALID: content_base64 is not valid base64: {error}"
            ))
          })?;
        let options_value = job
          .data
          .get("options")
          .cloned()
          .unwrap_or_else(|| serde_json::json!({}));
        let options: myoxus_domain::database::DatabaseCsvImportOptions = serde_json::from_value(options_value)
          .map_err(|error| {
            JobError::Permanent(format!("MIX_DATABASE_BULK_PAYLOAD_INVALID: invalid options: {error}"))
          })?;
        let summary = self
          .import_export
          .run_bulk_import_job(import_job_id, actor, database_title, content, options)
          .await
          .map_err(|error| {
            tracing::warn!(
              import_job_id = %import_job_id,
              workspace_id = ?workspace_id,
              actor_id = %actor,
              error = %error,
              "database bulk import job failed"
            );
            classify_database_job_error(error, "MIX_DATABASE_BULK_IMPORT_FAILED")
          })?;
        let _ = workspace_id;
        tracing::info!(
          import_job_id = %import_job_id,
          workspace_id = ?workspace_id,
          actor_id = %actor,
          "database bulk import job complete"
        );
        Ok(Some(summary))
      }
      other => {
        tracing::warn!(
          job_id = %job.id,
          job_name = %other,
          queue = self.queue_name(),
          "unknown database job name; dropping"
        );
        Err(JobError::Permanent(format!(
          "MIX_DATABASE_ROLLUP_RECOMPUTE_FAILED: unknown database job name: {other}"
        )))
      }
    }
  }
}

fn classify_database_job_error(
  error: myoxus_application::database::DatabaseServiceError,
  failure_code: &'static str,
) -> JobError {
  if error.is_retryable_storage_failure() {
    JobError::Retryable(format!("{failure_code}: {}", error.code))
  } else {
    JobError::Permanent(format!("{failure_code}: {error}"))
  }
}

fn required_uuid(data: &serde_json::Value, key: &str) -> Result<Uuid, JobError> {
  match data.get(key) {
    Some(serde_json::Value::String(value)) => value
      .parse()
      .map_err(|_| JobError::Permanent(format!("MIX_DATABASE_ROLLUP_CONFIG_INVALID: invalid {key}"))),
    Some(_) => Err(JobError::Permanent(format!(
      "MIX_DATABASE_ROLLUP_CONFIG_INVALID: invalid {key}"
    ))),
    None => Err(JobError::Permanent(format!(
      "MIX_DATABASE_ROLLUP_CONFIG_INVALID: missing {key}"
    ))),
  }
}

fn optional_uuid(data: &serde_json::Value, key: &str) -> Result<Option<Uuid>, JobError> {
  match data.get(key) {
    Some(serde_json::Value::String(value)) => value
      .parse()
      .map(Some)
      .map_err(|_| JobError::Permanent(format!("MIX_DATABASE_ROLLUP_CONFIG_INVALID: invalid {key}"))),
    Some(serde_json::Value::Null) | None => Ok(None),
    Some(_) => Err(JobError::Permanent(format!(
      "MIX_DATABASE_ROLLUP_CONFIG_INVALID: invalid {key}"
    ))),
  }
}

fn optional_i64(data: &serde_json::Value, key: &str) -> Option<i64> {
  data.get(key).and_then(serde_json::Value::as_i64)
}

fn optional_string<'a>(data: &'a serde_json::Value, key: &str) -> Option<&'a str> {
  data.get(key).and_then(serde_json::Value::as_str)
}

#[cfg(test)]
mod tests {
  use super::classify_database_job_error;
  use myoxus_application::database::{
    DATABASE_QUEUE, JOB_BULK_EXPORT, JOB_BULK_IMPORT, JOB_INDEX_ROW, JOB_RECOMPUTE_FORMULAS, JOB_RECOMPUTE_ROLLUPS,
    JOB_RECOMPUTE_STALE_PROJECTIONS, JOB_REINDEX_SEARCH,
  };
  use myoxus_domain::repositories::RepositoryError;
  use myoxus_worker::JobError;

  #[test]
  fn database_worker_uses_canonical_operational_names() {
    assert_eq!(DATABASE_QUEUE, "database");
    assert_eq!(JOB_RECOMPUTE_ROLLUPS, "database.recomputeRollups");
    assert_eq!(JOB_RECOMPUTE_FORMULAS, "database.recomputeFormulas");
    assert_eq!(JOB_RECOMPUTE_STALE_PROJECTIONS, "database.recomputeStaleProjections");
    assert_eq!(JOB_INDEX_ROW, "database.indexRow");
    assert_eq!(JOB_REINDEX_SEARCH, "database.reindexSearch");
    assert_eq!(JOB_BULK_IMPORT, "database.bulkImport");
    assert_eq!(JOB_BULK_EXPORT, "database.bulkExport");

    for name in [
      DATABASE_QUEUE,
      JOB_RECOMPUTE_ROLLUPS,
      JOB_RECOMPUTE_FORMULAS,
      JOB_RECOMPUTE_STALE_PROJECTIONS,
      JOB_INDEX_ROW,
      JOB_REINDEX_SEARCH,
      JOB_BULK_IMPORT,
      JOB_BULK_EXPORT,
    ] {
      assert!(
        !name.contains("workspace"),
        "Database worker operational name must not keep the legacy Database prefix: {name}"
      );
    }
  }

  #[test]
  fn search_projection_retry_policy_uses_typed_repository_category() {
    let storage = RepositoryError::Storage("private infrastructure detail".to_string()).into();
    let retryable = classify_database_job_error(storage, "MIX_DATABASE_INDEX_ROW_FAILED");
    assert!(matches!(
      retryable,
      JobError::Retryable(ref message)
        if message == "MIX_DATABASE_INDEX_ROW_FAILED: MIX_DATABASE_STORAGE"
          && !message.contains("private infrastructure detail")
    ));

    let invalid = RepositoryError::Validation("invalid projection value".to_string()).into();
    assert!(matches!(
      classify_database_job_error(invalid, "MIX_DATABASE_REINDEX_FAILED"),
      JobError::Permanent(message) if message.starts_with("MIX_DATABASE_REINDEX_FAILED:")
    ));
  }
}
