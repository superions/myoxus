mod models;
pub use models::*;

use crate::database::*;
use crate::repositories::{PageRequest, RepoResult};
use crate::workspace_tags::WorkspaceTagSearchProjection;
use async_trait::async_trait;

/// Search, document-reference, Formula, and Rollup projection persistence.
#[async_trait]
#[allow(clippy::too_many_arguments)]
pub trait DatabaseProjectionRepository: Send + Sync {
  /// Return the workspace's typed Database-to-document reference projection.
  /// The projection contains no body or snippet data.
  async fn list_document_references_for_workspace(
    &self,
    workspace_id: WorkspaceId,
    page: PageRequest,
  ) -> RepoResult<Vec<DatabaseDocumentReference>>;

  /// Return typed Database references whose canonical target is one of the
  /// requested documents. The projection contains no body or snippet data.
  async fn list_document_references_for_targets(
    &self,
    workspace_id: WorkspaceId,
    target_doc_ids: &[DocId],
    page: PageRequest,
  ) -> RepoResult<Vec<DatabaseDocumentReference>>;

  /// Capture affected Rows before canonical document deletion. Callers enqueue
  /// the normal `database.indexRow` job only after the delete commits.
  async fn list_document_reference_refreshes_for_target(
    &self,
    workspace_id: WorkspaceId,
    target_doc_id: DocId,
  ) -> RepoResult<Vec<DatabaseDocumentReferenceRefresh>>;

  /// Queue-unavailable fallback for document deletion. Production refreshes
  /// through `database.indexRow`; this invokes the identical repository
  /// replacement without rebuilding unrelated search text.
  async fn refresh_document_references_for_row(&self, row_id: DatabaseRowId) -> RepoResult<()>;

  /// P-DB-25: full-text search over rows using the workspace's FTS index.
  async fn search_rows(&self, filter: DatabaseSearchFilter) -> RepoResult<Vec<DatabaseSearchHit>>;

  /// P-DB-25: refresh the FTS row for one row. Implementations must be
  /// idempotent; captured owner/Row revision must still match at commit.
  async fn upsert_search_row(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    expected_row_edit_revision: i64,
    title: String,
    tsv_text: String,
    workspace_tags: Vec<WorkspaceTagSearchProjection>,
  ) -> RepoResult<()>;

  /// P-DB-25: remove the FTS row when the source row is deleted.
  async fn delete_search_row(&self, row_id: DatabaseRowId) -> RepoResult<()>;

  async fn list_stale_rollup_projection_tasks(
    &self,
    workspace_id: Option<WorkspaceId>,
    limit: i64,
    database_limit: i64,
  ) -> RepoResult<Vec<DatabaseRollupProjectionTask>>;

  async fn list_rollup_target_values(
    &self,
    source_row_id: DatabaseRowId,
    source_relation_field_id: DatabaseFieldId,
    target_field_id: DatabaseFieldId,
  ) -> RepoResult<Vec<DatabaseRollupTargetValue>>;

  async fn upsert_rollup_projection_value(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: Option<DatabaseRollupScalarValue>,
    source_hash: Option<String>,
    stale_state: DatabaseRollupStaleState,
    error_code: Option<String>,
    error_message: Option<String>,
  ) -> RepoResult<()>;

  async fn replace_formula_dependencies(
    &self,
    formula_field_id: DatabaseFieldId,
    dependency_field_ids: Vec<DatabaseFieldId>,
  ) -> RepoResult<()>;

  async fn list_stale_formula_projection_tasks(
    &self,
    workspace_id: Option<WorkspaceId>,
    limit: i64,
    database_limit: i64,
  ) -> RepoResult<Vec<DatabaseFormulaProjectionTask>>;

  async fn list_formula_source_values(
    &self,
    row_id: DatabaseRowId,
    dependency_field_ids: Vec<DatabaseFieldId>,
  ) -> RepoResult<Vec<DatabaseFormulaSourceValue>>;

  async fn upsert_formula_projection_value(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: Option<DatabaseFormulaScalarValue>,
    source_hash: Option<String>,
    stale_state: DatabaseFormulaStaleState,
    error_code: Option<String>,
    error_message: Option<String>,
  ) -> RepoResult<()>;
}
