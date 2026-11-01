// SPDX-License-Identifier: AGPL-3.0-or-later
//! Revisioned Task findings and deterministic, explicitly confirmed corrections.
use super::*;
use myoxus_domain::workspace_automation::*;
use sha2::{Digest, Sha256};

pub fn task_correction_proposal_digest(proposal: &TaskCorrectionProposal) -> DatabaseResult<String> {
  let mut input = proposal.clone();
  input.digest.clear();
  Ok(format!(
    "{:x}",
    Sha256::digest(
      serde_json::to_vec(&input)
        .map_err(|_| DatabaseServiceError::new(ERR_CELL_INVALID, "correction proposal unavailable"))?
    )
  ))
}
impl DatabaseEditingService {
  #[instrument(skip_all)]
  pub(crate) async fn apply_task_corrections(
    &self,
    actor: UserId,
    proposal: &TaskCorrectionProposal,
    fence: AutomationEffectFence,
  ) -> DatabaseResult<DatabaseBulkOperationResult> {
    if actor != proposal.actor_id
      || proposal.digest != task_correction_proposal_digest(proposal)?
      || proposal.patches.is_empty()
    {
      return Err(DatabaseServiceError::new(ERR_FORBIDDEN, "correction proposal changed"));
    }
    let mut rows = std::collections::BTreeMap::<DatabaseRowId, Vec<DatabaseBulkCellUpdate>>::new();
    let mut expected = HashMap::new();
    for patch in &proposal.patches {
      rows.entry(patch.row_id).or_default().push(DatabaseBulkCellUpdate {
        field_id: patch.field_id,
        intent: patch.intent.clone(),
      });
      expected.insert((patch.row_id, patch.field_id), patch.expected_edit_revision);
    }
    let patches = rows
      .into_iter()
      .map(|(row_id, cells)| DatabaseBulkRowPatch { row_id, cells })
      .collect::<Vec<_>>();
    self
      .bulk_apply_cell_patches_guarded(actor, proposal.database_id, &patches, &expected, false, Some(fence))
      .await
  }

  #[instrument(skip_all)]
  pub async fn confirm_task_corrections(
    &self,
    actor: UserId,
    input: TaskCorrectionConfirmationInput,
  ) -> DatabaseResult<TaskCorrectionConfirmationReceipt> {
    self
      .row_repo
      .commit_task_correction_confirmation(actor, input)
      .await
      .map_err(DatabaseServiceError::from)
  }

  #[instrument(skip_all)]
  pub async fn inspect_task_content(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    database: DatabaseId,
    tasks: &[DatabaseRowId],
  ) -> DatabaseResult<TaskCorrectionProposal> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database).await?;
    if record.database.workspace_id != workspace
      || tasks.is_empty()
      || tasks.len() > 64
      || record.database.profile_kind != DatabaseProfileKind::Project
      || !record
        .managed_schema
        .as_ref()
        .is_some_and(|schema| schema.readiness == DatabaseManagedSchemaReadiness::Ready)
    {
      return Err(DatabaseServiceError::new(
        ERR_ROW_INVALID,
        "current Task container and selected Tasks required",
      ));
    }
    access::assert_workspace(&self.permission, actor, workspace, WorkspaceAction::CreateDoc).await?;
    let mut selected = std::collections::BTreeSet::new();
    let mut proposal = TaskCorrectionProposal {
      actor_id: actor,
      workspace_id: workspace,
      database_id: database,
      tasks: Vec::new(),
      findings: Vec::new(),
      patches: Vec::new(),
      row_preconditions: Vec::new(),
      digest: String::new(),
    };
    let role = |name: &str| {
      record
        .field_roles
        .iter()
        .find(|role| role.role_key == name)
        .map(|role| role.field_id)
    };
    for id in tasks {
      if !selected.insert(*id) {
        return Err(DatabaseServiceError::new(ERR_ROW_INVALID, "duplicate correction Task"));
      }
      let row = self
        .row_repo
        .get_row(*id)
        .await?
        .filter(|row| {
          row.row.database_id == database && row.row.deleted_at.is_none() && row.row.row_kind == DatabaseRowKind::Task
        })
        .ok_or_else(|| DatabaseServiceError::new(ERR_ROW_INVALID, "correction Task unavailable"))?;
      let task = myoxus_domain::assistant_package::AssistantTaskReference {
        database_id: database,
        row_id: *id,
      };
      proposal.tasks.push(task.clone());
      proposal.row_preconditions.push(TaskCorrectionRowPrecondition {
        row_id: *id,
        expected_edit_revision: row.row.edit_revision,
      });
      for field in &record.fields {
        let cell = row.cells.iter().find(|cell| cell.field_id == field.id);
        // Required semantic roles protect the schema, not every Task Cell.
        // Only an ordinary required field makes an absent value a finding.
        if field.required
          && !record.field_roles.iter().any(|role| role.field_id == field.id)
          && field.field_type != DatabaseFieldType::Title
          && cell.is_none()
        {
          proposal.findings.push(TaskContentFinding {
            task: task.clone(),
            field_id: field.id,
            kind: TaskContentFindingKind::RequiredValueMissing,
          });
        }
        let Some(cell) = cell else { continue };
        let reference_check = match &cell.value {
          DatabaseCellValueData::User(_) | DatabaseCellValueData::Users(_)
            if !record
              .field_roles
              .iter()
              .any(|role| role.field_id == field.id && role.role_key != "task.assignees") =>
          {
            access::validate_user_cell_membership(&self.workspace_store, workspace, &cell.value).await
          }
          DatabaseCellValueData::DocumentLink(value) => {
            access::validate_document_link_value(&self.doc_service, workspace, value).await
          }
          DatabaseCellValueData::Relation(ids) => self.validate_relation_targets(actor, workspace, field, ids).await,
          DatabaseCellValueData::Files(value) => self.validate_files_value(workspace, field, value).await,
          DatabaseCellValueData::Tags(_) => {
            self
              .validate_workspace_tag_references(workspace, Some(&cell.value), &cell.value)
              .await
          }
          _ => Ok(()),
        };
        if let Err(error) = reference_check {
          if error.is_retryable_storage_failure() {
            return Err(error);
          }
          proposal.findings.push(TaskContentFinding {
            task: task.clone(),
            field_id: field.id,
            kind: TaskContentFindingKind::ReferenceUnavailable,
          });
          if role("task.assignees") == Some(field.id) {
            if let DatabaseCellValueData::Users(ids) = &cell.value {
              let mut accepted = Vec::new();
              for id in ids {
                if self
                  .workspace_store
                  .has_accepted_member(workspace, *id)
                  .await
                  .map_err(|_| {
                    DatabaseServiceError::from(RepositoryError::Storage("workspace membership lookup failed".into()))
                  })?
                {
                  accepted.push(*id);
                }
              }
              // Remove only unavailable assignees. Empty assignment is a valid
              // draft; attribution roles and replacement people are untouched.
              let value = DatabaseCellValueData::Users(accepted);
              rules::validate_cell_value(field, &value, &self.limits)?;
              proposal.patches.push(TaskCorrectionPatch {
                old_value: Some(cell.value.clone()),
                row_id: *id,
                field_id: field.id,
                intent: DatabaseBulkCellIntent::Set(value),
                expected_edit_revision: cell.edit_revision,
              });
            }
          }
        }
      }
      if let Some(field_id) = role("task.assignees") {
        if !row.cells.iter().any(|cell| {
          cell.field_id == field_id
            && match &cell.value {
              DatabaseCellValueData::User(_) => true,
              DatabaseCellValueData::Users(ids) => !ids.is_empty(),
              _ => false,
            }
        }) {
          proposal.findings.push(TaskContentFinding {
            task: task.clone(),
            field_id,
            kind: TaskContentFindingKind::AssignmentSuggestion,
          });
        }
      }
      if let (Some(start), Some(due)) = (role("task.startDate"), role("task.dueDate")) {
        let start_value = row
          .cells
          .iter()
          .find(|cell| cell.field_id == start)
          .map(|cell| &cell.value);
        let due_cell = row.cells.iter().find(|cell| cell.field_id == due);
        let correction = match (start_value, due_cell.map(|cell| &cell.value)) {
          (Some(DatabaseCellValueData::DateTime(start)), Some(DatabaseCellValueData::DateTime(due)))
            if due.start < start.start =>
          {
            Some(DatabaseCellValueData::DateTime(start.clone()))
          }
          (Some(DatabaseCellValueData::Date(start)), Some(DatabaseCellValueData::Date(due)))
            if due.start < start.start =>
          {
            Some(DatabaseCellValueData::Date(start.clone()))
          }
          _ => None,
        };
        if let Some(value) = correction {
          let field = record
            .fields
            .iter()
            .find(|field| field.id == due)
            .ok_or_else(|| DatabaseServiceError::new(ERR_FIELD_INVALID, "native Due field unavailable"))?;
          rules::validate_cell_value(field, &value, &self.limits)?;
          proposal.findings.push(TaskContentFinding {
            task: task.clone(),
            field_id: due,
            kind: TaskContentFindingKind::DueBeforeStart,
          });
          proposal.patches.push(TaskCorrectionPatch {
            old_value: due_cell.map(|cell| cell.value.clone()),
            row_id: *id,
            field_id: due,
            intent: DatabaseBulkCellIntent::Set(value),
            expected_edit_revision: due_cell.map_or(0, |cell| cell.edit_revision),
          });
        }
      }
    }
    proposal.digest = task_correction_proposal_digest(&proposal)?;
    Ok(proposal)
  }
}
