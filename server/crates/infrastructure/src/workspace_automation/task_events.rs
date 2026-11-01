// SPDX-License-Identifier: AGPL-3.0-or-later
//! Caller-transaction workflow facts and committed signal intents.
use super::*;
use crate::workspace_database::PgDatabaseRepository;
use chrono::{DateTime, Utc};
use myoxus_domain::database::{DatabaseCellValueData, DatabaseFieldConfig, DatabaseFieldType, DatabaseStatusGroup};
use myoxus_domain::ids::DatabaseRowId;
use myoxus_domain::workspace_automation::{
  AcceptedAutomationRun, TaskHandoverCompletion, TaskHandoverState, WorkflowSignalEnvelope, WorkflowSignalOutcome,
  WorkflowWaitKey,
};
use serde_json::Value;
use sqlx::{PgConnection, Postgres, Transaction};

impl PgWorkspaceAutomationRepository {
  /// Ordinary writers take interested Run locks before Database/Row locks.
  /// NOWAIT also closes competing legacy effect lock orders without waiting
  /// while holding another run's native claim.
  pub(crate) async fn lock_document_review_tasks(
    tx: &mut Transaction<'_, Postgres>,
    rows: &[DatabaseRowId],
  ) -> RepoResult<()> {
    sqlx::query("SELECT id FROM workspace_automation_runs WHERE origin_kind='task_handover' AND status IN ('queued','running') AND EXISTS(SELECT 1 FROM jsonb_array_elements(accepted_json->'taskHandover'->'plan'->'prerequisites') task WHERE (task->>'rowId')::uuid=ANY($1)) ORDER BY id FOR UPDATE NOWAIT").bind(rows).fetch_all(&mut **tx).await.map_err(PgDatabaseRepository::map_sqlx_error)?;
    sqlx::query("SELECT id FROM workspace_automation_runs WHERE origin_kind='document_review' AND review_task_id=ANY($1) AND status IN ('queued','running') ORDER BY id FOR UPDATE NOWAIT").bind(rows).fetch_all(&mut **tx).await.map_err(PgDatabaseRepository::map_sqlx_error)?;
    Ok(())
  }

  pub(crate) async fn invalidate_document_review_tasks(
    tx: &mut Transaction<'_, Postgres>,
    rows: &[DatabaseRowId],
  ) -> RepoResult<()> {
    Self::record_interested_handovers(tx, rows).await?;
    use myoxus_domain::workspace_automation::*;
    let runs=sqlx::query("SELECT id,accepted_json FROM workspace_automation_runs WHERE origin_kind='document_review' AND review_task_id=ANY($1) AND review_outcome_json IS NULL AND review_invalid_reason IS NULL AND status IN ('queued','running') ORDER BY id FOR UPDATE NOWAIT").bind(rows).fetch_all(&mut **tx).await.map_err(PgDatabaseRepository::map_sqlx_error)?;
    for run in runs {
      let accepted: AcceptedAutomationRun = serde_json::from_value(
        run
          .try_get("accepted_json")
          .map_err(PgDatabaseRepository::map_sqlx_error)?,
      )
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
      let review = accepted
        .document_review
        .as_ref()
        .ok_or_else(|| RepositoryError::Validation("review acceptance unavailable".into()))?;
      let row = sqlx::query("SELECT database_id,deleted_at,row_kind FROM workspace_database_rows WHERE id=$1")
        .bind(review.review_task_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(PgDatabaseRepository::map_sqlx_error)?;
      let mut reason = None;
      match row {
        None => reason = Some("REVIEW_TASK_DELETED"),
        Some(row)
          if row
            .try_get::<Uuid, _>("database_id")
            .map_err(PgDatabaseRepository::map_sqlx_error)?
            != review.plan.destination_database_id =>
        {
          reason = Some("REVIEW_TASK_MOVED")
        }
        Some(row)
          if row
            .try_get::<Option<DateTime<Utc>>, _>("deleted_at")
            .map_err(PgDatabaseRepository::map_sqlx_error)?
            .is_some() =>
        {
          reason = Some("REVIEW_TASK_DELETED")
        }
        Some(_) => {
          let cells=sqlx::query("SELECT role.role_key,f.field_type,f.config_json,c.value_json FROM database_field_roles role JOIN workspace_database_fields f ON f.id=role.field_id AND f.database_id=role.database_id LEFT JOIN workspace_database_cell_values c ON c.row_id=$2 AND c.field_id=f.id WHERE role.database_id=$1 AND role.role_key IN ('task.assignees','task.status') AND role.row_kind_scope='task'").bind(review.plan.destination_database_id).bind(review.review_task_id).fetch_all(&mut **tx).await.map_err(PgDatabaseRepository::map_sqlx_error)?;
          for cell in cells {
            let role: String = cell.try_get("role_key").map_err(PgDatabaseRepository::map_sqlx_error)?;
            let value: Option<Value> = cell
              .try_get("value_json")
              .map_err(PgDatabaseRepository::map_sqlx_error)?;
            if role == "task.assignees" {
              if value
                .map(|value| PgDatabaseRepository::map_cell_value_from_json(DatabaseFieldType::Users, value))
                .transpose()?
                .is_none_or(
                  |value| !matches!(value,DatabaseCellValueData::Users(ids) if ids==vec![review.plan.reviewer_id]),
                )
              {
                reason = Some("REVIEW_TASK_REASSIGNED");
              }
            } else if let Some(value) = value {
              if let DatabaseCellValueData::Status(id) =
                PgDatabaseRepository::map_cell_value_from_json(DatabaseFieldType::Status, value)?
              {
                let config: DatabaseFieldConfig = serde_json::from_value(
                  cell
                    .try_get("config_json")
                    .map_err(PgDatabaseRepository::map_sqlx_error)?,
                )
                .map_err(|error| RepositoryError::Storage(error.to_string()))?;
                if matches!(config,DatabaseFieldConfig::Status(config) if config.options.iter().any(|option|option.id==id && matches!(option.group,DatabaseStatusGroup::Complete|DatabaseStatusGroup::Archived)))
                {
                  reason = Some("REVIEW_TASK_COMPLETED_OUTSIDE_DECISION");
                }
              }
            }
          }
        }
      }
      if let Some(reason) = reason {
        let accepted_at: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
          .fetch_one(&mut **tx)
          .await
          .map_err(PgDatabaseRepository::map_sqlx_error)?;
        sqlx::query("UPDATE workspace_automation_runs SET review_invalid_reason=$2,error_code='MIX_AUTOMATION_RUN_NOT_RETRYABLE',error_message=NULL,execution_generation=execution_generation+1,claim_owner=NULL WHERE id=$1").bind(accepted.run_id).bind(reason).execute(&mut **tx).await.map_err(PgDatabaseRepository::map_sqlx_error)?;
        let signal = WorkflowSignalEnvelope {
          format_version: 1,
          event_id: Uuid::new_v4(),
          key: WorkflowWaitKey {
            run_id: accepted.run_id,
            wait_id: review.wait_id.clone(),
          },
          accepted_at,
          outcome: WorkflowSignalOutcome::Invalidated {
            reason_code: reason.into(),
          },
        };
        Self::insert_workflow_signal_intent(tx, &signal).await?;
      }
    }
    Ok(())
  }

  /// This final interested-Run lock is deliberately NOWAIT: admission may have
  /// committed between the writer's early scan and its native Row lock.
  pub(crate) async fn record_interested_handovers(
    tx: &mut Transaction<'_, Postgres>,
    rows: &[DatabaseRowId],
  ) -> RepoResult<()> {
    let runs=sqlx::query("SELECT accepted_json FROM workspace_automation_runs WHERE origin_kind='task_handover' AND status IN ('queued','running') AND EXISTS(SELECT 1 FROM jsonb_array_elements(accepted_json->'taskHandover'->'plan'->'prerequisites') task WHERE (task->>'rowId')::uuid=ANY($1)) ORDER BY id FOR UPDATE NOWAIT").bind(rows).fetch_all(&mut **tx).await.map_err(PgDatabaseRepository::map_sqlx_error)?;
    for run in runs {
      let accepted: AcceptedAutomationRun = serde_json::from_value(
        run
          .try_get("accepted_json")
          .map_err(PgDatabaseRepository::map_sqlx_error)?,
      )
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
      Self::record_handover_tasks(tx, &accepted, rows).await?;
    }
    Ok(())
  }

  pub(crate) async fn record_handover_tasks(
    tx: &mut PgConnection,
    accepted: &AcceptedAutomationRun,
    changed: &[DatabaseRowId],
  ) -> RepoResult<TaskHandoverState> {
    let handover = accepted
      .task_handover
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("handover acceptance unavailable".into()))?;
    let raw: Value =
      sqlx::query_scalar("SELECT task_handover_state FROM workspace_automation_runs WHERE id=$1 FOR UPDATE NOWAIT")
        .bind(accepted.run_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(PgDatabaseRepository::map_sqlx_error)?;
    let mut state: TaskHandoverState =
      serde_json::from_value(raw).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    state.validate(&handover.plan).map_err(RepositoryError::Validation)?;
    if state.invalid_reason.is_some() || state.expired_at.is_some() {
      return Ok(state);
    }
    let authority = crate::workflow_runtime::effects::lock_runtime_authority(
      tx,
      handover.plan.actor_id,
      accepted.workspace_id,
      false,
    )
    .await;
    match authority {
      Ok(()) => {}
      Err(RepositoryError::Validation(_)) => state.invalid_reason = Some("TASK_HANDOVER_AUTHORITY_UNAVAILABLE".into()),
      Err(error) => return Err(error),
    }
    for (index, task) in handover
      .plan
      .prerequisites
      .iter()
      .enumerate()
      .filter(|(_, task)| changed.contains(&task.row_id))
    {
      let group = PgDatabaseRepository::handover_task_state(tx, accepted.workspace_id, task).await?;
      match group {
        None => state.invalid_reason = Some("TASK_HANDOVER_PREREQUISITE_UNAVAILABLE".into()),
        Some(DatabaseStatusGroup::Archived) => {
          state.invalid_reason = Some("TASK_HANDOVER_PREREQUISITE_CANCELLED".into())
        }
        Some(DatabaseStatusGroup::Complete) if !state.completions.contains_key(&task.row_id) => {
          let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&mut *tx)
            .await
            .map_err(PgDatabaseRepository::map_sqlx_error)?;
          if now >= handover.plan.deadline_at {
            state.expired_at = Some(now);
            break;
          }
          let completion = TaskHandoverCompletion {
            task: task.clone(),
            event_id: Uuid::new_v4(),
            accepted_at: now,
          };
          let signal = WorkflowSignalEnvelope {
            format_version: 1,
            event_id: completion.event_id,
            key: WorkflowWaitKey {
              run_id: accepted.run_id,
              wait_id: myoxus_application::workspace_automation::handover::handover_wait_id(
                &accepted.definition,
                index,
              )
              .map_err(|_| RepositoryError::Validation("handover wait unavailable".into()))?,
            },
            accepted_at: now,
            outcome: WorkflowSignalOutcome::Accepted {
              outcome_key: "complete".into(),
              result: serde_json::to_value(&completion).map_err(|error| RepositoryError::Storage(error.to_string()))?,
            },
          };
          Self::insert_workflow_signal_intent(tx, &signal).await?;
          state.completions.insert(task.row_id, completion);
        }
        Some(DatabaseStatusGroup::Complete) => {}
        Some(_) if state.completions.contains_key(&task.row_id) => {
          state.invalid_reason = Some("TASK_HANDOVER_PREREQUISITE_REOPENED".into())
        }
        Some(_) => {}
      }
      if state.invalid_reason.is_some() {
        break;
      }
    }
    sqlx::query("UPDATE workspace_automation_runs SET task_handover_state=$2 WHERE id=$1")
      .bind(accepted.run_id)
      .bind(serde_json::to_value(&state).map_err(|error| RepositoryError::Storage(error.to_string()))?)
      .execute(&mut *tx)
      .await
      .map_err(PgDatabaseRepository::map_sqlx_error)?;
    if state.invalid_reason.is_some() || state.expired_at.is_some() {
      sqlx::query("UPDATE workspace_automation_runs SET error_code='MIX_AUTOMATION_RUN_NOT_RETRYABLE',execution_generation=execution_generation+1,claim_owner=NULL WHERE id=$1").bind(accepted.run_id).execute(&mut *tx).await.map_err(PgDatabaseRepository::map_sqlx_error)?;
      let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await
        .map_err(PgDatabaseRepository::map_sqlx_error)?;
      for index in 0..handover.plan.prerequisites.len() {
        Self::insert_workflow_signal_intent(
          tx,
          &WorkflowSignalEnvelope {
            format_version: 1,
            event_id: Uuid::new_v4(),
            key: WorkflowWaitKey {
              run_id: accepted.run_id,
              wait_id: myoxus_application::workspace_automation::handover::handover_wait_id(
                &accepted.definition,
                index,
              )
              .map_err(|_| RepositoryError::Validation("handover wait unavailable".into()))?,
            },
            accepted_at: now,
            outcome: WorkflowSignalOutcome::Invalidated {
              reason_code: state
                .invalid_reason
                .clone()
                .unwrap_or_else(|| "TASK_HANDOVER_EXPIRED".into()),
            },
          },
        )
        .await?;
      }
    }
    Ok(state)
  }

  pub(crate) async fn insert_workflow_signal_intent(
    tx: &mut PgConnection,
    signal: &WorkflowSignalEnvelope,
  ) -> RepoResult<()> {
    sqlx::query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,created_at) VALUES($1,'workspace_automation',$2,'workspace_automation_signal',$3,now()) ON CONFLICT(id) DO NOTHING").bind(signal.event_id).bind(signal.key.run_id.to_string()).bind(serde_json::to_value(signal).map_err(|error|RepositoryError::Storage(error.to_string()))?).execute(&mut *tx).await.map_err(PgDatabaseRepository::map_sqlx_error)?;
    Ok(())
  }
}
