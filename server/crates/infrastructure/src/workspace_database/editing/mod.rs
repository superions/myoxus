// SPDX-License-Identifier: AGPL-3.0-or-later
mod automation_events;
mod batches;
mod capture;
mod changes;
mod handover;
mod links;
mod maintenance;
mod movement;
mod relations;
mod review;
mod task_events;
mod templates;
use crate::workspace_database::*;

#[async_trait]
impl DatabaseEditingRepository for PgDatabaseRepository {
  async fn commit_task_correction_confirmation(
    &self,
    actor: UserId,
    input: myoxus_domain::workspace_automation::TaskCorrectionConfirmationInput,
  ) -> RepoResult<myoxus_domain::workspace_automation::TaskCorrectionConfirmationReceipt> {
    self.persist_task_correction_confirmation(actor, input).await
  }

  async fn commit_document_review_decision(
    &self,
    actor: UserId,
    input: myoxus_domain::workspace_automation::DocumentReviewDecisionInput,
  ) -> RepoResult<(
    myoxus_domain::workspace_automation::DocumentReviewDecisionReceipt,
    Option<DatabaseCellWriteOutcome>,
  )> {
    self.persist_document_review_decision(actor, input).await
  }

  async fn list_row_templates(&self, database_id: DatabaseId) -> RepoResult<Vec<DatabaseRowTemplate>> {
    self.persist_list_row_templates(database_id).await
  }

  async fn get_row_template(&self, row_template_id: Uuid) -> RepoResult<Option<DatabaseRowTemplate>> {
    self.persist_get_row_template(row_template_id).await
  }

  async fn create_row_template(
    &self,
    template: DatabaseRowTemplate,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowTemplate> {
    self.persist_create_row_template(template, precondition).await
  }

  async fn update_row_template(
    &self,
    row_template_id: Uuid,
    name: Option<String>,
    description: Option<Option<String>>,
    position: Option<i32>,
    enabled: Option<bool>,
    is_default: Option<bool>,
    initial_cell_values: Option<BTreeMap<DatabaseFieldId, DatabaseCellValueData>>,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowTemplate> {
    self
      .persist_update_row_template(
        row_template_id,
        name,
        description,
        position,
        enabled,
        is_default,
        initial_cell_values,
        updated_by,
        precondition,
      )
      .await
  }

  async fn delete_row_template(&self, row_template_id: Uuid, precondition: DatabaseEditPrecondition) -> RepoResult<()> {
    self.persist_delete_row_template(row_template_id, precondition).await
  }

  async fn prepare_task_move(
    &self,
    actor: UserId,
    input: DatabaseTaskMoveInput,
  ) -> RepoResult<DatabaseTaskMovePreview> {
    self.task_move_preview(actor, input).await
  }

  async fn move_tasks(&self, actor: UserId, input: DatabaseTaskMoveInput) -> RepoResult<DatabaseTaskMoveResult> {
    self.task_move_commit(actor, input).await
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
  ) -> RepoResult<DatabaseRowRecord> {
    self
      .persist_create_row(database_id, row_id, row_kind, title, created_by, cells, precondition)
      .await
  }

  async fn get_row(&self, row_id: DatabaseRowId) -> RepoResult<Option<DatabaseRowRecord>> {
    self.persist_get_row(row_id).await
  }

  async fn update_row_position(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    position: i32,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord> {
    self
      .persist_update_row_position(database_id, row_id, position, updated_by, precondition)
      .await
  }

  async fn update_cell_value(
    &self,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
    reminder_reschedules: Option<Vec<DatabaseRowReminderReschedule>>,
  ) -> RepoResult<DatabaseCellWriteOutcome> {
    self
      .persist_update_cell_value(row_id, field_id, value, updated_by, precondition, reminder_reschedules)
      .await
  }

  async fn clear_cell_value(
    &self,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseCellClearOutcome> {
    self
      .persist_clear_cell_value(row_id, field_id, updated_by, precondition)
      .await
  }

  async fn update_row_title(
    &self,
    row_id: DatabaseRowId,
    title: String,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord> {
    self
      .persist_update_row_title(row_id, title, updated_by, precondition)
      .await
  }

  async fn delete_row(&self, row_id: DatabaseRowId, precondition: DatabaseEditPrecondition) -> RepoResult<()> {
    self.persist_delete_row(row_id, precondition).await
  }

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
    self
      .persist_create_row_with_content_document(
        database_id,
        row_id,
        row_kind,
        title,
        created_by,
        cells,
        precondition,
        content_document_id,
      )
      .await
  }

  async fn attach_row_content_document(
    &self,
    row_id: DatabaseRowId,
    content_document_id: Uuid,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord> {
    self
      .persist_attach_row_content_document(row_id, content_document_id, updated_by, precondition)
      .await
  }

  async fn detach_row_content_document(
    &self,
    row_id: DatabaseRowId,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord> {
    self
      .persist_detach_row_content_document(row_id, updated_by, precondition)
      .await
  }

  async fn get_task_capture_receipt(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
  ) -> RepoResult<Option<DatabaseTaskCaptureReceipt>> {
    self.persist_get_task_capture_receipt(actor, workspace, request).await
  }

  async fn get_task_source(&self, row: DatabaseRowId) -> RepoResult<Option<DatabaseTaskSource>> {
    self.persist_get_task_source(row).await
  }

  async fn create_task_capture(
    &self,
    title: String,
    cells: Vec<DatabaseCellValue>,
    receipt: DatabaseTaskCaptureReceipt,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord> {
    self
      .persist_create_task_capture(title, cells, receipt, precondition)
      .await
  }

  async fn bulk_delete_rows(
    &self,
    row_ids: &[DatabaseRowId],
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseRowId>>> {
    self
      .persist_bulk_delete_rows(row_ids, updated_by, expected_edit_revisions, force, precondition)
      .await
  }

  async fn bulk_restore_rows(
    &self,
    row_ids: &[DatabaseRowId],
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseRowRecord>>> {
    self
      .persist_bulk_restore_rows(row_ids, updated_by, expected_edit_revisions, force, precondition)
      .await
  }

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
  ) -> RepoResult<Vec<RepoResult<DatabaseCellWriteOutcome>>> {
    self
      .persist_bulk_set_cell_value(
        row_ids,
        field_id,
        value,
        updated_by,
        expected_edit_revisions,
        force,
        reminder_reschedules,
        precondition,
      )
      .await
  }

  async fn bulk_clear_cell_value(
    &self,
    row_ids: &[DatabaseRowId],
    field_id: DatabaseFieldId,
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseCommittedCellChange>>> {
    self
      .persist_bulk_clear_cell_value(
        row_ids,
        field_id,
        updated_by,
        expected_edit_revisions,
        force,
        precondition,
      )
      .await
  }

  async fn bulk_apply_cell_patches(
    &self,
    database_id: DatabaseId,
    patches: &[(DatabaseRowId, DatabaseFieldId, Option<DatabaseCellValueData>)],
    updated_by: UserId,
    expected_edit_revisions: &HashMap<(DatabaseRowId, DatabaseFieldId), i64>,
    force: bool,
    reminder_reschedules: Vec<DatabaseRowReminderReschedule>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseCommittedCellChange>>> {
    self
      .persist_bulk_apply_cell_patches(
        database_id,
        patches,
        updated_by,
        expected_edit_revisions,
        force,
        reminder_reschedules,
        precondition,
      )
      .await
  }

  async fn bulk_update_row_positions(
    &self,
    database_id: DatabaseId,
    updates: &[(DatabaseRowId, i32)],
    updated_by: UserId,
    expected_edit_revisions: &HashMap<DatabaseRowId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<RepoResult<DatabaseRowRecord>>> {
    self
      .persist_bulk_update_row_positions(
        database_id,
        updates,
        updated_by,
        expected_edit_revisions,
        force,
        precondition,
      )
      .await
  }
}
