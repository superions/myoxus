// SPDX-License-Identifier: AGPL-3.0-or-later
//! Decision publication uses normal native Task editing authority and SQL rules.
use super::*;
use myoxus_domain::workspace_automation::{
  DocumentReviewDecision, DocumentReviewDecisionInput, DocumentReviewDecisionReceipt,
};

/// Decisions and follow-up creation must encode the same ordinary Description
/// value, so pre-commit validation protects the later native Task write.
pub(crate) fn task_description_value(field: &DatabaseField, text: String) -> DatabaseResult<DatabaseCellValueData> {
  match field.field_type {
    DatabaseFieldType::Text => Ok(DatabaseCellValueData::Text(text)),
    DatabaseFieldType::RichText => Ok(DatabaseCellValueData::RichText(DatabaseRichTextValue {
      plain_text: text.clone(),
      document: serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]}),
    })),
    _ => Err(DatabaseServiceError::new(
      ERR_FIELD_INVALID,
      "native Task description field unavailable",
    )),
  }
}

impl DatabaseEditingService {
  #[instrument(skip_all)]
  pub(crate) async fn decide_document_review(
    &self,
    actor: UserId,
    input: DocumentReviewDecisionInput,
    database: DatabaseId,
    row: DatabaseRowId,
  ) -> DatabaseResult<DocumentReviewDecisionReceipt> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database).await?;
    access::assert_workspace(
      &self.permission,
      actor,
      record.database.workspace_id,
      WorkspaceAction::CreateDoc,
    )
    .await?;
    if let DocumentReviewDecision::RequestChanges { reason } = &input.decision {
      let field_id = record
        .field_roles
        .iter()
        .find(|role| role.role_key == "task.description")
        .map(|role| role.field_id)
        .ok_or_else(|| DatabaseServiceError::new(ERR_FIELD_INVALID, "native Task description field unavailable"))?;
      let field = record
        .fields
        .iter()
        .find(|field| field.id == field_id)
        .ok_or_else(|| DatabaseServiceError::new(ERR_FIELD_INVALID, "native Task description field unavailable"))?;
      let value = task_description_value(field, reason.clone())?;
      rules::validate_cell_value(field, &value, &self.limits)?;
    }
    let status_field_id = record
      .field_roles
      .iter()
      .find(|role| role.role_key == "task.status")
      .map(|role| role.field_id)
      .ok_or_else(|| DatabaseServiceError::new(ERR_FIELD_INVALID, "native Task status field unavailable"))?;
    let status_field = record
      .fields
      .iter()
      .find(|field| field.id == status_field_id)
      .ok_or_else(|| DatabaseServiceError::new(ERR_FIELD_INVALID, "native Task status field unavailable"))?;
    let row_record = self
      .row_repo
      .get_row(row)
      .await?
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "review Task unavailable"))?;
    let (receipt, cell_outcome) = self.row_repo.commit_document_review_decision(actor, input).await?;
    if receipt.review_task_id != row
      || receipt.database_id != database
      || receipt.workspace_id != record.database.workspace_id
    {
      return Err(DatabaseServiceError::new(ERR_FORBIDDEN, "review result scope changed"));
    }
    if let Some(outcome) = cell_outcome {
      self
        .publish_committed_cell_update(actor, &record, &row_record, status_field, &outcome)
        .await;
    }
    Ok(receipt)
  }
}
