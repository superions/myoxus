// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native acceptance/deadline arbitration, before any engine snapshot lock.
//! The engine consumes the resulting correlated bytes and owns continuation.
use super::*;
use glirulus_postgres::{WaitArbitrator, WaitFuture, WaitResolution};
use myoxus_domain::workspace_automation::*;

pub(super) struct NativeWaitArbitrator {
  database_templates: Option<Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>>,
}
impl NativeWaitArbitrator {
  pub(super) fn new(
    database_templates: Option<Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>>,
  ) -> Self {
    Self { database_templates }
  }
}
fn unavailable_wait() -> BackendError {
  BackendError::Backend("native workflow wait unavailable".into())
}
impl WaitArbitrator for NativeWaitArbitrator {
  fn resolve<'a>(
    &'a self,
    connection: &'a mut sqlx::PgConnection,
    instance_id: &'a str,
    signal_name: &'a str,
    _observed_deadline: Option<chrono::DateTime<chrono::Utc>>,
  ) -> WaitFuture<'a> {
    Box::pin(async move {
      let id = uuid::Uuid::parse_str(instance_id).map_err(|_| unavailable_wait())?;
      // Native decision and ordinary Task invalidation acquire this same Run
      // before Database/document locks. Stop acquires claim then Run. We never
      // hold an engine snapshot lock while waiting for this native boundary.
      let row=sqlx::query("SELECT accepted_json,status,review_wait_id,review_deadline_at,review_outcome_json,review_invalid_reason,review_expired_at,task_handover_state,task_correction_outcome_json,task_maintenance_invalid_reason FROM workspace_automation_runs WHERE id=$1 FOR UPDATE")
        .bind(id).fetch_optional(&mut *connection).await.map_err(|_|unavailable_wait())?;
      // Native lifecycle deletion removes authority, not other runs' ability to
      // poll. Terminal/unavailable native inputs cannot revive a parked wait.
      let Some(row) = row else {
        return Ok(WaitResolution::Stopped);
      };
      let state: String = row.try_get("status").map_err(|_| unavailable_wait())?;
      if !matches!(state.as_str(), "queued" | "running") {
        return Ok(WaitResolution::Stopped);
      }
      let accepted: AcceptedAutomationRun =
        serde_json::from_value(row.try_get("accepted_json").map_err(|_| unavailable_wait())?)
          .map_err(|_| unavailable_wait())?;
      if let Some(maintenance) = &accepted.task_maintenance {
        if maintenance.wait_id != signal_name
          || maintenance.plan.actor_id != accepted.actor_id.ok_or_else(unavailable_wait)?
        {
          return Err(unavailable_wait());
        }
        if row
          .try_get::<Option<String>, _>("task_maintenance_invalid_reason")
          .map_err(|_| unavailable_wait())?
          .is_some()
        {
          return Ok(WaitResolution::Expired);
        }
        if let Some(value) = row
          .try_get::<Option<serde_json::Value>, _>("task_correction_outcome_json")
          .map_err(|_| unavailable_wait())?
        {
          let receipt: TaskCorrectionConfirmationReceipt =
            serde_json::from_value(value).map_err(|_| unavailable_wait())?;
          if receipt.run_id != id
            || receipt.actor_id != maintenance.plan.actor_id
            || receipt.wait_id != maintenance.wait_id
            || receipt.proposal_digest != maintenance.plan.proposal.digest
          {
            return Err(unavailable_wait());
          }
          let signal = WorkflowSignalEnvelope {
            format_version: 1,
            event_id: receipt.event_id,
            key: WorkflowWaitKey {
              run_id: id,
              wait_id: signal_name.into(),
            },
            accepted_at: receipt.accepted_at,
            outcome: WorkflowSignalOutcome::Accepted {
              outcome_key: match receipt.outcome {
                TaskCorrectionOutcome::Apply => "apply",
                TaskCorrectionOutcome::Decline => "decline",
              }
              .into(),
              result: serde_json::to_value(&receipt).map_err(|_| unavailable_wait())?,
            },
          };
          let input = RuntimeInput::for_signal(&accepted, signal).map_err(|_| unavailable_wait())?;
          return Ok(WaitResolution::Accepted {
            event_id: receipt.event_id.to_string(),
            accepted_at: receipt.accepted_at,
            payload: Bytes::from(serde_json::to_vec(&input).map_err(|_| unavailable_wait())?),
          });
        }
        let catalog = self.database_templates.as_deref().ok_or_else(unavailable_wait)?;
        crate::workspace_database::PgDatabaseRepository::capture_catalog_admission(connection, catalog)
          .await
          .map_err(|_| unavailable_wait())?;
        // A value edit can make Apply stale without preventing Decline. Only
        // lost authority/ownership/lifecycle makes this human wait unavailable.
        let authority =
          effects::lock_runtime_authority(connection, maintenance.plan.actor_id, accepted.workspace_id, false).await;
        let scope = match authority {
          Ok(()) => {
            let consent = if accepted.personal_rule.is_some() {
              effects::lock_personal_automation(connection, &accepted).await
            } else {
              Ok(())
            };
            match consent {
              Ok(()) => {
                crate::workspace_database::PgDatabaseRepository::assert_task_correction_proposal_in_tx(
                  connection,
                  &maintenance.plan.proposal,
                  false,
                )
                .await
              }
              Err(error) => Err(error),
            }
          }
          Err(error) => Err(error),
        };
        match scope {
          Ok(()) => return Ok(WaitResolution::Pending { deadline_at: None }),
          Err(myoxus_domain::repositories::RepositoryError::Storage(_)) => return Err(unavailable_wait()),
          Err(_) => {
            sqlx::query("UPDATE workspace_automation_runs SET task_maintenance_invalid_reason='unavailable',error_code='MIX_AUTOMATION_RUN_NOT_RETRYABLE',execution_generation=execution_generation+1,claim_owner=NULL WHERE id=$1").bind(id).execute(&mut *connection).await.map_err(|_|unavailable_wait())?;
            return Ok(WaitResolution::Expired);
          }
        }
      }
      if accepted.task_handover.is_some() {
        return resolve_handover(
          connection,
          &accepted,
          signal_name,
          row.try_get("task_handover_state").map_err(|_| unavailable_wait())?,
        )
        .await;
      }
      let review = accepted.document_review.as_ref().ok_or_else(unavailable_wait)?;
      let wait: String = row.try_get("review_wait_id").map_err(|_| unavailable_wait())?;
      let deadline: chrono::DateTime<chrono::Utc> =
        row.try_get("review_deadline_at").map_err(|_| unavailable_wait())?;
      if signal_name != review.wait_id || wait != review.wait_id || deadline != review.plan.deadline_at {
        return Err(unavailable_wait());
      }
      if row
        .try_get::<Option<String>, _>("review_invalid_reason")
        .map_err(|_| unavailable_wait())?
        .is_some()
      {
        return Ok(WaitResolution::Expired);
      }
      if let Some(value) = row
        .try_get::<Option<serde_json::Value>, _>("review_outcome_json")
        .map_err(|_| unavailable_wait())?
      {
        let receipt: DocumentReviewDecisionReceipt = serde_json::from_value(value).map_err(|_| unavailable_wait())?;
        if receipt.run_id != id
          || receipt.wait_id != wait
          || receipt.accepted_at > deadline
          || receipt.actor_id != review.plan.reviewer_id
          || receipt.source_revision != review.plan.source_revision
        {
          return Err(unavailable_wait());
        }
        let outcome_key = match receipt.decision {
          DocumentReviewDecision::Approve => "approve",
          DocumentReviewDecision::RequestChanges { .. } => "requestChanges",
        };
        let signal = WorkflowSignalEnvelope {
          format_version: 1,
          event_id: receipt.event_id,
          key: WorkflowWaitKey {
            run_id: id,
            wait_id: wait,
          },
          accepted_at: receipt.accepted_at,
          outcome: WorkflowSignalOutcome::Accepted {
            outcome_key: outcome_key.into(),
            result: serde_json::to_value(&receipt).map_err(|_| unavailable_wait())?,
          },
        };
        let input = RuntimeInput::for_signal(&accepted, signal).map_err(|_| unavailable_wait())?;
        return Ok(WaitResolution::Accepted {
          event_id: receipt.event_id.to_string(),
          accepted_at: receipt.accepted_at,
          payload: Bytes::from(serde_json::to_vec(&input).map_err(|_| unavailable_wait())?),
        });
      }
      let now: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| unavailable_wait())?;
      if now >= deadline {
        // The accepted native outcome was checked while holding the same Run;
        // delayed outbox delivery cannot convert an on-time acceptance to expiry.
        sqlx::query("UPDATE workspace_automation_runs SET review_expired_at=COALESCE(review_expired_at,$2),error_code='MIX_AUTOMATION_RUN_NOT_RETRYABLE',execution_generation=execution_generation+1,claim_owner=NULL WHERE id=$1 AND review_expired_at IS NULL")
          .bind(id).bind(now).execute(&mut *connection).await.map_err(|_|unavailable_wait())?;
        return Ok(WaitResolution::Expired);
      }
      Ok(WaitResolution::Pending {
        deadline_at: Some(deadline),
      })
    })
  }
}

async fn resolve_handover(
  connection: &mut sqlx::PgConnection,
  accepted: &AcceptedAutomationRun,
  signal_name: &str,
  raw: serde_json::Value,
) -> Result<WaitResolution, BackendError> {
  let handover = accepted.task_handover.as_ref().ok_or_else(unavailable_wait)?;
  let index = (0..handover.plan.prerequisites.len())
    .find(|index| {
      myoxus_application::workspace_automation::handover::handover_wait_id(&accepted.definition, *index)
        .is_ok_and(|wait| wait == signal_name)
    })
    .ok_or_else(unavailable_wait)?;
  let mut state: TaskHandoverState = serde_json::from_value(raw).map_err(|_| unavailable_wait())?;
  state.validate(&handover.plan).map_err(|_| unavailable_wait())?;
  match super::effects::lock_runtime_authority(connection, handover.plan.actor_id, accepted.workspace_id, false).await {
    Ok(()) => {}
    Err(myoxus_domain::repositories::RepositoryError::Validation(_)) => {
      state.invalid_reason = Some("TASK_HANDOVER_AUTHORITY_UNAVAILABLE".into());
      sqlx::query("UPDATE workspace_automation_runs SET task_handover_state=$2,error_code='MIX_AUTOMATION_RUN_NOT_RETRYABLE',execution_generation=execution_generation+1,claim_owner=NULL WHERE id=$1").bind(accepted.run_id).bind(serde_json::to_value(&state).map_err(|_|unavailable_wait())?).execute(&mut *connection).await.map_err(|_|unavailable_wait())?;
    }
    Err(_) => return Err(unavailable_wait()),
  }
  if state.invalid_reason.is_none() && state.expired_at.is_none() {
    for task in &handover.plan.prerequisites {
      let group =
        crate::workspace_database::PgDatabaseRepository::handover_task_state(connection, accepted.workspace_id, task)
          .await
          .map_err(|_| unavailable_wait())?;
      if group.is_none()
        || group == Some(myoxus_domain::database::DatabaseStatusGroup::Archived)
        || (state.completions.contains_key(&task.row_id)
          && group != Some(myoxus_domain::database::DatabaseStatusGroup::Complete))
      {
        state.invalid_reason = Some("TASK_HANDOVER_PREREQUISITE_UNAVAILABLE".into());
        break;
      }
    }
    let source:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id=$1 AND workspace_id=$2 AND external_id=$3 AND deleted_at IS NULL AND blocked=false AND is_workspace_root=false)").bind(handover.plan.source_document_id).bind(accepted.workspace_id).bind(&handover.plan.source_external_id).fetch_one(&mut *connection).await.map_err(|_|unavailable_wait())?;
    let destination:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_databases WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND managed_installation->>'readiness'='ready')").bind(handover.plan.destination_database_id).bind(accepted.workspace_id).fetch_one(&mut *connection).await.map_err(|_|unavailable_wait())?;
    if !source || !destination {
      state.invalid_reason = Some("TASK_HANDOVER_TARGET_UNAVAILABLE".into())
    }
    if state.invalid_reason.is_some() {
      sqlx::query("UPDATE workspace_automation_runs SET task_handover_state=$2,error_code='MIX_AUTOMATION_RUN_NOT_RETRYABLE',execution_generation=execution_generation+1,claim_owner=NULL WHERE id=$1").bind(accepted.run_id).bind(serde_json::to_value(&state).map_err(|_|unavailable_wait())?).execute(&mut *connection).await.map_err(|_|unavailable_wait())?;
    }
  }
  if state.invalid_reason.is_some() || state.expired_at.is_some() {
    return Ok(WaitResolution::Expired);
  }
  let task = &handover.plan.prerequisites[index];
  if let Some(completion) = state.completions.get(&task.row_id) {
    if completion.task != *task || completion.accepted_at >= handover.plan.deadline_at {
      return Err(unavailable_wait());
    }
    let signal = WorkflowSignalEnvelope {
      format_version: 1,
      event_id: completion.event_id,
      key: WorkflowWaitKey {
        run_id: accepted.run_id,
        wait_id: signal_name.into(),
      },
      accepted_at: completion.accepted_at,
      outcome: WorkflowSignalOutcome::Accepted {
        outcome_key: "complete".into(),
        result: serde_json::to_value(completion).map_err(|_| unavailable_wait())?,
      },
    };
    let input = RuntimeInput::for_signal(accepted, signal).map_err(|_| unavailable_wait())?;
    return Ok(WaitResolution::Accepted {
      event_id: completion.event_id.to_string(),
      accepted_at: completion.accepted_at,
      payload: Bytes::from(serde_json::to_vec(&input).map_err(|_| unavailable_wait())?),
    });
  }
  let now: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| unavailable_wait())?;
  if now >= handover.plan.deadline_at {
    state.expired_at = Some(now);
    sqlx::query("UPDATE workspace_automation_runs SET task_handover_state=$2,error_code='MIX_AUTOMATION_RUN_NOT_RETRYABLE',execution_generation=execution_generation+1,claim_owner=NULL WHERE id=$1").bind(accepted.run_id).bind(serde_json::to_value(&state).map_err(|_|unavailable_wait())?).execute(&mut *connection).await.map_err(|_|unavailable_wait())?;
    return Ok(WaitResolution::Expired);
  }
  Ok(WaitResolution::Pending {
    deadline_at: Some(handover.plan.deadline_at),
  })
}
