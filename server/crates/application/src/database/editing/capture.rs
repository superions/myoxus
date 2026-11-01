// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native Task capture admission, replay authorization and immutable source reads.
use super::access;
use super::*;
use sha2::{Digest, Sha256};

pub const ERR_CAPTURE_REQUEST_CONFLICT: &str = "MIX_DATABASE_TASK_CAPTURE_REQUEST_CONFLICT";

#[derive(Debug, Clone, Serialize)]
pub struct DatabaseTaskCaptureInput {
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub request_id: Uuid,
  pub source_document_id: DocId,
  pub source_external_id: String,
  pub block_id: Option<String>,
  pub selection_anchor: Option<String>,
  pub title: String,
  pub cells: Vec<(DatabaseFieldId, DatabaseCellValueData)>,
}

pub struct DatabaseTaskCaptureResult {
  pub receipt: DatabaseTaskCaptureReceipt,
  pub record: Option<DatabaseRowRecord>,
  pub replayed: bool,
  pub target_trashed: bool,
}

impl DatabaseEditingService {
  /// A receipt is an admission identity, not permission to read its current targets.
  #[instrument(skip_all)]
  pub async fn task_capture_receipt(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
  ) -> DatabaseResult<Option<DatabaseTaskCaptureResult>> {
    access::assert_workspace(&self.permission, actor, workspace, WorkspaceAction::Read).await?;
    let Some(receipt) = self
      .row_repo
      .get_task_capture_receipt(actor, workspace, request)
      .await?
    else {
      return Ok(None);
    };
    // Receipt admission/source facts remain immutable; navigation follows this same
    // Row identity's current authorized owner after an explicit native move.
    let mut row = self.row_repo.get_row(receipt.row_id).await?;
    let current_database_id = row
      .as_ref()
      .map(|record| record.row.database_id)
      .unwrap_or(receipt.database_id);
    let database = self.schema_repo.get_database_for_lifecycle(current_database_id).await?;
    let mut target_trashed = false;
    let record = if let Some(database) = database {
      if database.database.workspace_id != workspace {
        return Err(DatabaseServiceError::new(ERR_FORBIDDEN, "capture target unavailable"));
      }
      access::assert_workspace(&self.permission, actor, workspace, WorkspaceAction::CreateDoc).await?;
      target_trashed = database.database.deleted_at.is_some();
      if target_trashed {
        None
      } else {
        if let Some(row) = row.as_mut() {
          crate::database::views::projection::attach_projection_cells(row, &database.fields);
          target_trashed = row.row.deleted_at.is_some();
        }
        row
      }
    } else {
      None
    };
    self.assert_capture_replay_source(actor, &receipt.source).await?;
    Ok(Some(DatabaseTaskCaptureResult {
      receipt,
      record,
      replayed: true,
      target_trashed,
    }))
  }

  #[instrument(skip_all)]
  pub async fn create_task_from_source(
    &self,
    actor: UserId,
    input: DatabaseTaskCaptureInput,
  ) -> DatabaseResult<DatabaseTaskCaptureResult> {
    self.create_task_from_source_impl(actor, input, None).await
  }
  pub(crate) async fn create_task_from_source_with_effect(
    &self,
    actor: UserId,
    input: DatabaseTaskCaptureInput,
    row: DatabaseRowId,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> DatabaseResult<DatabaseTaskCaptureResult> {
    self
      .create_task_from_source_impl(actor, input, Some((row, fence)))
      .await
  }
  async fn create_task_from_source_impl(
    &self,
    actor: UserId,
    mut input: DatabaseTaskCaptureInput,
    effect: Option<(
      DatabaseRowId,
      myoxus_domain::workspace_automation::AutomationEffectFence,
    )>,
  ) -> DatabaseResult<DatabaseTaskCaptureResult> {
    input.title = input.title.trim().to_string();
    // Normalize from the typed payload, independently of today's schema. A
    // purged Database or removed optional field must not prevent exact replay.
    input.cells = input
      .cells
      .into_iter()
      .map(|(id, value)| {
        let kind = match &value {
          DatabaseCellValueData::Url(_) => Some(DatabaseFieldType::Url),
          DatabaseCellValueData::Email(_) => Some(DatabaseFieldType::Email),
          DatabaseCellValueData::Phone(_) => Some(DatabaseFieldType::Phone),
          DatabaseCellValueData::Files(_) => Some(DatabaseFieldType::Files),
          DatabaseCellValueData::RichText(_) => Some(DatabaseFieldType::RichText),
          _ => None,
        };
        let normalized = match kind {
          Some(kind) => crate::database::editing::rules::normalize_editable_cell_value(kind, value, &self.limits)?,
          None => Some(value),
        };
        Ok(normalized.map(|value| (id, value)))
      })
      .collect::<DatabaseResult<Vec<_>>>()?
      .into_iter()
      .flatten()
      .collect();
    input.cells.sort_by_key(|(id, _)| *id);
    if input.title.is_empty()
      || input.title.chars().count() > self.limits.max_cell_text_bytes
      || input.cells.windows(2).any(|p| p[0].0 == p[1].0)
      || input.block_id.as_ref().is_some_and(|s| s.len() > 512)
      || input.selection_anchor.as_ref().is_some_and(|s| s.len() > 8192)
    {
      return Err(DatabaseServiceError::new(ERR_ROW_INVALID, "invalid task capture input"));
    }
    let key = myoxus_domain::document_key::DocumentKey::parse(input.source_external_id.clone())
      .map_err(|_| DatabaseServiceError::new(ERR_ROW_INVALID, "invalid source document key"))?;
    let fingerprint = format!(
      "{:x}",
      Sha256::digest(
        serde_json::to_vec(&input)
          .map_err(|_| DatabaseServiceError::new(ERR_ROW_INVALID, "invalid capture payload"))?
      )
    );
    if let Some(result) = self
      .task_capture_receipt(actor, input.workspace_id, input.request_id)
      .await?
    {
      if result.receipt.fingerprint != fingerprint {
        return Err(DatabaseServiceError::new(
          ERR_CAPTURE_REQUEST_CONFLICT,
          "capture request already admitted different work",
        ));
      }
      return Ok(result);
    }
    let database = access::get_database(&self.permission, &self.schema_repo, actor, input.database_id).await?;
    if database.database.workspace_id != input.workspace_id
      || database.database.profile_kind != DatabaseProfileKind::Project
    {
      return Err(DatabaseServiceError::new(
        ERR_FORBIDDEN,
        "capture destination unavailable",
      ));
    }
    access::assert_workspace(&self.permission, actor, input.workspace_id, WorkspaceAction::CreateDoc).await?;
    let document_id = self
      .doc_service
      .resolve_document_key(input.workspace_id, crate::doc::DocSpaceKind::Workspace, &key)
      .await
      .map_err(|_| DatabaseServiceError::new(ERR_STORAGE, "source lookup failed"))?
      .ok_or_else(|| DatabaseServiceError::new(ERR_FORBIDDEN, "capture source unavailable"))?;
    if input.source_document_id != document_id {
      return Err(DatabaseServiceError::new(ERR_FORBIDDEN, "capture source unavailable"));
    }
    let source = DatabaseTaskSource {
      source_workspace_id: input.workspace_id,
      document_id,
      external_id: input.source_external_id,
      block_id: input.block_id,
      selection_anchor: input.selection_anchor,
    };
    self.assert_capture_source(actor, &source).await?;
    let receipt = DatabaseTaskCaptureReceipt {
      actor_id: actor,
      workspace_id: input.workspace_id,
      request_id: input.request_id,
      fingerprint,
      database_id: input.database_id,
      row_id: Uuid::nil(),
      edit_revision: 1,
      source,
    };
    let created = self
      .create_row_with_kind_impl(
        actor,
        database,
        DatabaseRowKind::Task,
        Some(input.title),
        input.cells,
        None,
        None,
        Some(receipt.clone()),
        None,
        effect,
      )
      .await;
    match created {
      Ok(record) => {
        let mut receipt = receipt;
        receipt.row_id = record.row.id;
        Ok(DatabaseTaskCaptureResult {
          receipt,
          record: Some(record),
          replayed: false,
          target_trashed: false,
        })
      }
      Err(error) if error.code == "MIX_DATABASE_TASK_CAPTURE_REPLAY" => {
        let result = self
          .task_capture_receipt(actor, input.workspace_id, input.request_id)
          .await?
          .ok_or_else(|| DatabaseServiceError::new(ERR_STORAGE, "capture outcome uncertain"))?;
        if result.receipt.fingerprint != receipt.fingerprint {
          return Err(DatabaseServiceError::new(
            ERR_CAPTURE_REQUEST_CONFLICT,
            "capture request already admitted different work",
          ));
        }
        Ok(result)
      }
      Err(error) => Err(error),
    }
  }

  pub(in crate::database) async fn assert_capture_source(
    &self,
    actor: UserId,
    source: &DatabaseTaskSource,
  ) -> DatabaseResult<()> {
    let projection = self
      .resolve_document_target(actor, source.source_workspace_id, Some(source.document_id), false)
      .await?;
    let readable = projection.is_some_and(|p| {
      p.state == DatabaseRowContentDocumentState::Available
        && p.external_id.as_deref() == Some(source.external_id.as_str())
    });
    let resource = DocResource {
      user_id: actor,
      workspace_id: source.source_workspace_id,
      doc_id: source.document_id,
    };
    if !readable || !self.permission.can(&resource, DocAction::Copy).await {
      return Err(DatabaseServiceError::new(ERR_FORBIDDEN, "capture source unavailable"));
    }
    Ok(())
  }

  pub(in crate::database) async fn assert_capture_replay_source(
    &self,
    actor: UserId,
    source: &DatabaseTaskSource,
  ) -> DatabaseResult<()> {
    let metadata = self
      .doc_service
      .get_metadata_including_deleted(source.document_id)
      .await
      .map_err(|_| DatabaseServiceError::new(ERR_STORAGE, "source lookup failed"))?;
    // Deletion/purge retains a neutral identity result. Existing targets still
    // require current Read/Copy; their presence never grants access to the Task.
    if metadata.is_some_and(|d| d.deleted_at.is_none() && d.workspace_id == Some(source.source_workspace_id)) {
      self.assert_capture_source(actor, source).await?;
    }
    Ok(())
  }

  pub async fn task_source(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    row_id: DatabaseRowId,
  ) -> DatabaseResult<Option<(DatabaseTaskSource, Option<DatabaseRowContentDocument>)>> {
    let Some(row) = self.row_repo.get_row(row_id).await? else {
      return Ok(None);
    };
    let database = access::get_database(&self.permission, &self.schema_repo, actor, row.row.database_id).await?;
    if database.database.workspace_id != workspace {
      return Err(DatabaseServiceError::new(ERR_FORBIDDEN, "source unavailable"));
    }
    let Some(source) = self.row_repo.get_task_source(row_id).await? else {
      return Ok(None);
    };
    // A Task move preserves its origin identity but does not admit a foreign
    // source into the Task's new workspace, even for actors reading both scopes.
    let projection = if source.source_workspace_id == workspace {
      self.capture_source_projection(actor, &source).await?
    } else {
      None
    };
    Ok(Some((source, projection)))
  }

  pub async fn capture_source_projection(
    &self,
    actor: UserId,
    source: &DatabaseTaskSource,
  ) -> DatabaseResult<Option<DatabaseRowContentDocument>> {
    let p = self
      .resolve_document_target(actor, source.source_workspace_id, Some(source.document_id), false)
      .await?;
    Ok(p.filter(|p| {
      p.state == DatabaseRowContentDocumentState::Available
        && p.external_id.as_deref() == Some(source.external_id.as_str())
    }))
  }
}
