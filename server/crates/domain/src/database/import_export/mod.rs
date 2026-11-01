mod workspace_content;
pub use workspace_content::{
  rewrite_workspace_content_value, rewrite_workspace_content_view_blobs, rewrite_workspace_content_view_tags,
  workspace_content_view_tag_ids,
};

mod csv;
mod jobs;
mod json;

pub use csv::*;
pub use jobs::*;
pub use json::*;

use crate::database::*;
use crate::ids::DatabaseImportJobId;
use crate::repositories::RepoResult;
use crate::workspace_tags::WorkspaceTag;
use async_trait::async_trait;
use serde_json::Value;

#[async_trait]
#[allow(clippy::too_many_arguments)]
pub trait DatabaseImportExportRepository: Send + Sync {
  /// Apply a JSON/Notion import and its planned workspace-tag creations in one
  /// storage transaction. `updated_rows` is used only by merge/overwrite.
  /// A prepared bulk CSV result commits to the existing job with the native
  /// write. Replays retain that result and its Database identity; a lost commit
  /// response must be resolved through the job rather than replaying the write.
  async fn apply_database_snapshot_import(
    &self,
    mode: DatabaseJsonImportMode,
    target_database_id: Option<DatabaseId>,
    target_precondition: Option<DatabaseEditPrecondition>,
    database: Database,
    fields: Vec<DatabaseField>,
    views: Vec<DatabaseView>,
    field_roles: Vec<DatabaseFieldRole>,
    view_roles: Vec<DatabaseViewRole>,
    rows: Vec<DatabaseRowRecord>,
    updated_rows: Vec<DatabaseRowRecord>,
    row_templates: Vec<DatabaseRowTemplate>,
    row_sources: Vec<(DatabaseRowId, DatabaseTaskSource)>,
    workspace_tags: Vec<WorkspaceTag>,
    import_job_id: Option<DatabaseImportJobId>,
    import_job_result: Option<Value>,
  ) -> RepoResult<DatabaseRecord>;

  // ───────────────────────────────────────────────────────────────────────────
  // P-DB-26 (reopen 2026-07-08): background import/export job persistence,
  // idempotency, cancellation and compensation.
  //
  // The traits below give the application service a transactional handle on
  // `database_import_jobs` and the per-row `created_by_job_id` provenance
  // needed for safe cancel/compensation. Implementations MUST:
  //   * reject a duplicate `(workspace_id, idempotency_key)` insert while a
  //     live row (`queued | running | succeeded`) already exists;
  //   * write `cancellation_requested_at` exactly once per cancel and
  //     transition `cancelled_at` only after compensation has finished;
  //   * delete rows tagged with a job id in `created_by_job_id` atomically
  //     (cascading to cells) so the cancelled import leaves no partial data.
  // ───────────────────────────────────────────────────────────────────────────

  /// Insert a new `database_import_jobs` row in `queued` state.
  ///
  /// Implementations MUST honour the partial UNIQUE index
  /// `(workspace_id, idempotency_key) WHERE status IN ('queued','running',
  /// 'succeeded')` and return [`crate::repositories::RepositoryError::Conflict`] when a live row
  /// already exists for the same key.
  async fn create_import_job(&self, job: &DatabaseImportJobRecord) -> RepoResult<DatabaseImportJobRecord>;

  /// Look up an import job by primary key.
  async fn get_import_job(&self, job_id: DatabaseImportJobId) -> RepoResult<Option<DatabaseImportJobRecord>>;

  /// Look up the most-recent live row for an idempotency key. Returns
  /// `Ok(None)` if no row is currently `queued | running | succeeded`.
  async fn get_live_import_job_by_idempotency_key(
    &self,
    workspace_id: WorkspaceId,
    idempotency_key: &str,
  ) -> RepoResult<Option<DatabaseImportJobRecord>>;

  /// Transition a queued/imported job to `running`, stamping `started_at`.
  async fn mark_import_job_running(
    &self,
    job_id: DatabaseImportJobId,
    database_id: Option<DatabaseId>,
  ) -> RepoResult<()>;

  /// Mark an import job succeeded with the worker-supplied result summary.
  async fn mark_import_job_succeeded(&self, job_id: DatabaseImportJobId, result: &Value) -> RepoResult<()>;

  /// Mark an import job failed with the terminal error code and message.
  async fn mark_import_job_failed(
    &self,
    job_id: DatabaseImportJobId,
    error_code: &str,
    error_message: &str,
    attempt_count: i32,
  ) -> RepoResult<()>;

  /// Request cancellation. Sets `cancellation_requested_at = now()` exactly
  /// once (idempotent on repeated calls). Returns the resulting row so the
  /// caller can confirm the marker landed.
  async fn request_import_job_cancellation(&self, job_id: DatabaseImportJobId) -> RepoResult<DatabaseImportJobRecord>;

  /// Mark an import job cancelled AFTER compensation has finished cleaning
  /// up every row/cell/database the job created.
  async fn mark_import_job_cancelled(&self, job_id: DatabaseImportJobId, result: &Value) -> RepoResult<()>;

  /// Read the cancellation flag for mid-run checks. Returns `true` if the
  /// operator (or another worker) has requested cancellation since the
  /// worker last polled.
  async fn is_import_job_cancellation_requested(&self, job_id: DatabaseImportJobId) -> RepoResult<bool>;

  /// Compensate an import job by deleting every row tagged with this job id
  /// (cascading to cells). Returns the number of rows removed.
  async fn delete_rows_by_job_id(&self, job_id: DatabaseImportJobId) -> RepoResult<usize>;

  /// P-DB-27: save a CSV mapping template. Implementations must
  /// enforce "exactly one current revision per (workspace, name)" —
  /// saving under an existing name promotes the new row to
  /// `is_current = TRUE` and demotes the previous row. The returned
  /// record is the freshly inserted row including its server-side
  /// `id`, `revision`, and timestamps.
  async fn save_csv_mapping_template(
    &self,
    template: NewDatabaseCsvMappingTemplate,
  ) -> RepoResult<DatabaseCsvMappingTemplate>;

  /// P-DB-27: list the current revision for every template in the
  /// workspace, ordered most-recently-updated first. Used by the
  /// wizard's "reuse template" dropdown.
  async fn list_csv_mapping_templates(&self, workspace_id: WorkspaceId) -> RepoResult<Vec<DatabaseCsvMappingTemplate>>;

  /// P-DB-27: fetch the current revision of a template by name, or
  /// `None` if no template exists under that name. Lookup is
  /// case-sensitive.
  async fn get_csv_mapping_template_by_name(
    &self,
    workspace_id: WorkspaceId,
    name: &str,
  ) -> RepoResult<Option<DatabaseCsvMappingTemplate>>;

  /// P-DB-27: delete every revision of a template by name. Returns
  /// the number of rows actually deleted so callers can surface a
  /// useful error when the name did not exist.
  async fn delete_csv_mapping_template(&self, workspace_id: WorkspaceId, name: &str) -> RepoResult<u64>;
}
