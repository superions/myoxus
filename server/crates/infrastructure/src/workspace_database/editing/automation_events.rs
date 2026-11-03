// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::workspace_automation::PgWorkspaceAutomationRepository;
use crate::workspace_database::*;
use myoxus_domain::workspace_automation::{WorkspaceAutomationTriggerEvent, WorkspaceAutomationTriggerType};

impl PgDatabaseRepository {
  /// Persist independent subscriber intent while the native Row/Cell transaction
  /// still owns its locks. No Redis response is needed to commit user content.
  pub(in crate::workspace_database) async fn insert_automation_event(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    actor: UserId,
    trigger_type: WorkspaceAutomationTriggerType,
    field_id: Option<DatabaseFieldId>,
    old_value: Option<DatabaseCellValueData>,
    new_value: Option<DatabaseCellValueData>,
  ) -> RepoResult<()> {
    let row = sqlx::query(
      "SELECT d.workspace_id,r.doc_id,clock_timestamp() AS committed_at
       FROM workspace_database_rows r JOIN workspace_databases d ON d.id=r.database_id
       WHERE r.id=$1 AND r.database_id=$2 AND r.deleted_at IS NULL AND d.deleted_at IS NULL",
    )
    .bind(row_id)
    .bind(database_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let Some(row) = row else {
      return Ok(());
    };
    let event = WorkspaceAutomationTriggerEvent {
      workspace_id: row.try_get("workspace_id").map_err(Self::map_sqlx_error)?,
      database_id,
      row_id,
      trigger_type,
      actor_user_id: Some(actor),
      field_id,
      old_value,
      new_value,
      row_content_document_id: row.try_get("doc_id").map_err(Self::map_sqlx_error)?,
      occurred_at: row.try_get("committed_at").map_err(Self::map_sqlx_error)?,
    };
    let payload = serde_json::to_value(event).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    sqlx::query(
      "INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,created_at)
       VALUES($1,'workspace_automation',$2,'workspace_automation_trigger',$3,now())",
    )
    .bind(Uuid::new_v4())
    .bind(row_id.to_string())
    .bind(payload)
    .execute(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  pub(in crate::workspace_database) async fn insert_row_change_intents(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    actor: UserId,
    changes: &[DatabaseCommittedCellChange],
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<()> {
    Self::insert_task_notification_intents(tx, database_id, actor, changes, false).await?;
    Self::insert_task_recurrence_completion_intents(tx, database_id, changes).await?;
    PgWorkspaceAutomationRepository::invalidate_document_review_tasks(
      tx,
      &changes.iter().map(|change| change.row_id).collect::<Vec<_>>(),
    )
    .await?;
    // Existing action lists do not recursively trigger themselves. Preserve
    // their native notification effects without creating a second automation.
    if precondition.automation_effect.is_some() {
      return Ok(());
    }
    for change in changes {
      let kind: String =
        sqlx::query_scalar("SELECT field_type FROM workspace_database_fields WHERE id=$1 AND database_id=$2")
          .bind(change.field_id)
          .bind(database_id)
          .fetch_one(&mut **tx)
          .await
          .map_err(Self::map_sqlx_error)?;
      let mut triggers = vec![WorkspaceAutomationTriggerType::RowUpdated];
      match kind.as_str() {
        "relation" => triggers.push(WorkspaceAutomationTriggerType::RelationChanged),
        "select" | "status" => triggers.push(WorkspaceAutomationTriggerType::StatusSelectChanged),
        _ => {}
      }
      for trigger in triggers {
        Self::insert_automation_event(
          tx,
          database_id,
          change.row_id,
          actor,
          trigger,
          Some(change.field_id),
          change.previous_value.clone(),
          change.value.clone(),
        )
        .await?;
      }
    }
    Ok(())
  }
}
