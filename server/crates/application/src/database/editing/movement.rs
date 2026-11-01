// SPDX-License-Identifier: AGPL-3.0-or-later

//! Explicit content movement between canonical managed Task containers.
use super::*;
impl DatabaseEditingService {
  #[tracing::instrument(skip_all)]
  pub async fn prepare_task_move(
    &self,
    actor: UserId,
    input: DatabaseTaskMoveInput,
  ) -> DatabaseResult<DatabaseTaskMovePreview> {
    access::assert_workspace(&self.permission, actor, input.workspace_id, WorkspaceAction::CreateDoc).await?;
    let result = self.row_repo.prepare_task_move(actor, input.clone()).await?;
    access::assert_workspace(&self.permission, actor, input.workspace_id, WorkspaceAction::CreateDoc).await?;
    Ok(result)
  }
  #[tracing::instrument(skip_all)]
  pub async fn move_tasks(
    &self,
    actor: UserId,
    input: DatabaseTaskMoveInput,
  ) -> DatabaseResult<DatabaseTaskMoveResult> {
    access::assert_workspace(&self.permission, actor, input.workspace_id, WorkspaceAction::CreateDoc).await?;
    let result = self.row_repo.move_tasks(actor, input.clone()).await?;
    // SQL already committed atomically. Publish only native invalidations, not
    // synthetic creation/assignment/completion effects for preserved facts.
    for database_id in [input.source_database_id, input.target_database_id] {
      self
        .effects
        .emit_change(
          input.workspace_id,
          database_id,
          DatabaseChangeKind::DatabaseUpdated,
          actor,
          DatabaseChangeTarget {
            row_id: None,
            field_id: None,
            view_id: None,
          },
        )
        .await;
      if let Err(error) = self
        .projection
        .enqueue_reindex_search(input.workspace_id, database_id)
        .await
      {
        warn!(database_id=%database_id,error=%error,"committed Task move projection enqueue failed");
      }
    }
    Ok(result)
  }
}
