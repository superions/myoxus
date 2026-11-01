use crate::database::*;
use crate::repositories::{RepoResult, RepositoryError};
use async_trait::async_trait;
use std::collections::HashMap;
use uuid::Uuid;

/// Native Row, Cell, relation, template and row-content persistence.
#[async_trait]
#[allow(clippy::too_many_arguments)]
pub trait DatabaseEditingRepository: Send + Sync {
  /// Retain this exact proposal outcome and its durable correlated signal together.
  async fn commit_task_correction_confirmation(
    &self,
    actor: UserId,
    input: crate::workspace_automation::TaskCorrectionConfirmationInput,
  ) -> RepoResult<crate::workspace_automation::TaskCorrectionConfirmationReceipt>;

  /// Commit the decision, native completion and signal intent together.
  /// Only a fresh commit returns a Cell outcome for normal postcommit effects;
  /// retained receipt replay returns None and must not republish them.
  async fn commit_document_review_decision(
    &self,
    actor: UserId,
    input: crate::workspace_automation::DocumentReviewDecisionInput,
  ) -> RepoResult<(
    crate::workspace_automation::DocumentReviewDecisionReceipt,
    Option<DatabaseCellWriteOutcome>,
  )>;

  async fn list_row_templates(&self, database_id: DatabaseId) -> RepoResult<Vec<DatabaseRowTemplate>>;

  async fn get_row_template(&self, row_template_id: uuid::Uuid) -> RepoResult<Option<DatabaseRowTemplate>>;

  async fn create_row_template(
    &self,
    template: DatabaseRowTemplate,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowTemplate>;

  async fn update_row_template(
    &self,
    row_template_id: uuid::Uuid,
    name: Option<String>,
    description: Option<Option<String>>,
    position: Option<i32>,
    enabled: Option<bool>,
    is_default: Option<bool>,
    initial_cell_values: Option<std::collections::BTreeMap<DatabaseFieldId, DatabaseCellValueData>>,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowTemplate>;

  async fn delete_row_template(
    &self,
    row_template_id: uuid::Uuid,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<()>;

  async fn prepare_task_move(
    &self,
    _actor: UserId,
    _input: DatabaseTaskMoveInput,
  ) -> RepoResult<DatabaseTaskMovePreview> {
    Err(RepositoryError::Storage(
      "native Task move repository unavailable".into(),
    ))
  }
  async fn move_tasks(&self, _actor: UserId, _input: DatabaseTaskMoveInput) -> RepoResult<DatabaseTaskMoveResult> {
    Err(RepositoryError::Storage(
      "native Task move repository unavailable".into(),
    ))
  }

  async fn create_row(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    row_kind: DatabaseRowKind,
    title: String,
    created_by: UserId,
    cells: Vec<DatabaseCellValue>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord>;

  /// Publish an already prepared same-workspace content document atomically
  /// with its Row, initial Cells, native references and notification intent.
  async fn create_row_with_content_document(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    row_kind: DatabaseRowKind,
    title: String,
    created_by: UserId,
    cells: Vec<DatabaseCellValue>,
    precondition: DatabaseEditPrecondition,
    content_document_id: DocId,
  ) -> RepoResult<DatabaseRowRecord> {
    let _ = (
      database_id,
      row_id,
      row_kind,
      title,
      created_by,
      cells,
      precondition,
      content_document_id,
    );
    Err(RepositoryError::Storage(
      "atomic Row content creation unavailable".into(),
    ))
  }

  async fn get_task_capture_receipt(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
  ) -> RepoResult<Option<DatabaseTaskCaptureReceipt>> {
    let _ = (actor, workspace, request);
    Err(RepositoryError::Storage("capture receipts unavailable".into()))
  }

  async fn get_task_source(&self, row: DatabaseRowId) -> RepoResult<Option<DatabaseTaskSource>> {
    let _ = row;
    Err(RepositoryError::Storage("task sources unavailable".into()))
  }

  /// Commit the native Row, capture admission and optional effect ACK in the
  /// same transaction; callers must retain the creation precondition.
  async fn create_task_capture(
    &self,
    title: String,
    cells: Vec<DatabaseCellValue>,
    receipt: DatabaseTaskCaptureReceipt,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord> {
    let _ = (title, cells, receipt, precondition);
    Err(RepositoryError::Storage("task capture unavailable".into()))
  }

  async fn get_row(&self, row_id: DatabaseRowId) -> RepoResult<Option<DatabaseRowRecord>>;

  /// Move a row to a zero-based database-local position and keep row positions dense.
  async fn update_row_position(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    position: i32,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord>;

  async fn update_cell_value(
    &self,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
    reminder_reschedules: Option<Vec<DatabaseRowReminderReschedule>>,
  ) -> RepoResult<DatabaseCellWriteOutcome>;

  /// Clear one cell while retaining a revision tombstone. The returned
  /// revision is the baseline required by the caller's next edit.
  async fn clear_cell_value(
    &self,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseCellClearOutcome>;

  async fn update_row_title(
    &self,
    row_id: DatabaseRowId,
    title: String,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord>;

  /// Attach an optional content document to a Database Row.
  ///
  /// Implementations MUST:
  /// - validate that the row and document live in the same workspace
  /// - reject the link if the row already has a different content document
  /// - never delete the attached content document
  async fn attach_row_content_document(
    &self,
    row_id: DatabaseRowId,
    content_document_id: Uuid,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord>;

  /// Detach the optional content document without deleting it.
  ///
  /// Implementations MUST NOT delete the previously attached content document.
  async fn detach_row_content_document(
    &self,
    row_id: DatabaseRowId,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord>;

  async fn delete_row(&self, row_id: DatabaseRowId, precondition: DatabaseEditPrecondition) -> RepoResult<()>;

  // ───────────────────────────────────────────────────────────────────────────
  // P-DB-26: bulk operations
  //
  // Every method in this block must satisfy three contracts:
  //   1. **Atomicity** — within a single transaction. Either every provided
  //      row is updated / deleted / restored / reordered, or none is.
  //      Callers receive per-row `RepoResult` outcomes **only** to describe
  //      *individual* validation failures that are detected and reported
  //      before the row enters the transaction. A storage failure mid-batch
  //      rolls the whole batch back; this is intentional, because partial
  //      commits are exactly the silent corruption that motivates P-DB-26.
  //   2. **Stable ordering** — outcomes are returned in the same order as the
  //      input rows (or, for positions, in `(position, id)` order after the
  //      rewrite).
  //   3. **Side effects** — FTS search rows are dropped alongside deleted or
  //      restored rows so search hits never reference tombstones.
  //
  // Implementations are expected to use a transaction-scoped `FOR UPDATE`
  // lock on the target rows to prevent concurrent reorders from racing the
  // batch.
  // ───────────────────────────────────────────────────────────────────────────

  /// P-DB-26: soft-delete a list of rows in one transaction.
  async fn bulk_delete_rows(
    &self,
    row_ids: &[DatabaseRowId],
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseRowId>>>;

  /// P-DB-26: restore previously-soft-deleted rows in one transaction.
  ///
  /// Returns the restored `DatabaseRowRecord` for each row that was
  /// un-deleted (with `deleted_at` cleared).
  async fn bulk_restore_rows(
    &self,
    row_ids: &[DatabaseRowId],
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseRowRecord>>>;

  /// P-DB-26: set a single cell value on many rows in one transaction.
  ///
  /// `value` must be normalized by the caller. The method exists so a UI
  /// "bulk assign" or "bulk status change" can issue a single transactional
  /// batch instead of N independent mutations.
  async fn bulk_set_cell_value(
    &self,
    row_ids: &[DatabaseRowId],
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    reminder_reschedules: Vec<DatabaseRowReminderReschedule>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseCellWriteOutcome>>>;

  /// P-DB-26: clear a single cell on many rows in one transaction. Used by
  /// "bulk clear" affordances.
  async fn bulk_clear_cell_value(
    &self,
    row_ids: &[DatabaseRowId],
    field_id: DatabaseFieldId,
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseCommittedCellChange>>>;

  /// P-DB-26: rewrite many cell values across many rows in one transaction.
  ///
  /// `None` is an explicit Clear, not an absent patch. All target revisions
  /// must be checked before the first write. Implementations must
  /// serialize concurrent reorders by taking `FOR UPDATE` locks on the
  /// touched rows before issuing writes.
  async fn bulk_apply_cell_patches(
    &self,
    database_id: DatabaseId,
    patches: &[(DatabaseRowId, DatabaseFieldId, Option<DatabaseCellValueData>)],
    updated_by: UserId,
    expected_edit_revisions: &HashMap<(DatabaseRowId, DatabaseFieldId), i64>,
    force: bool,
    reminder_reschedules: Vec<DatabaseRowReminderReschedule>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseCommittedCellChange>>>;

  /// P-DB-26: rewrite the `position` column for many rows in one transaction.
  ///
  /// `updates` is `Vec<(row_id, position)>`. Implementations must reject
  /// (and roll back the whole batch) if any row id does not belong to
  /// `database_id`. The returned records are sorted by `(position, id)` so
  /// clients can use them to re-render an ordered Kanban or List.
  async fn bulk_update_row_positions(
    &self,
    database_id: DatabaseId,
    updates: &[(DatabaseRowId, i32)],
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseRowRecord>>>;
}

pub mod movement;
pub use movement::*;

pub mod task_events;
pub use task_events::*;

mod models;
pub use models::*;

mod values;
pub use values::*;
pub mod capture;
pub use capture::*;
