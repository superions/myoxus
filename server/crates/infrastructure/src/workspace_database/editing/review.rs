// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native review decision publication shares the ordinary Task Cell writer.
use crate::workspace_automation::PgWorkspaceAutomationRepository;
use crate::workspace_database::*;
use myoxus_domain::workspace_automation::*;
impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn persist_document_review_decision(
    &self,
    actor: UserId,
    input: DocumentReviewDecisionInput,
  ) -> RepoResult<(DocumentReviewDecisionReceipt, Option<DatabaseCellWriteOutcome>)> {
    let mut tx = self.begin_write().await?;
    let value: Value = sqlx::query_scalar(
      "SELECT accepted_json FROM workspace_automation_runs WHERE id=$1 AND origin_kind='document_review'",
    )
    .bind(input.run_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let accepted: AcceptedAutomationRun =
      serde_json::from_value(value).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let review = accepted
      .document_review
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("review acceptance unavailable".into()))?;
    if actor != review.plan.reviewer_id || input.wait_id != review.wait_id {
      return Err(RepositoryError::Validation(
        "review decision permission unavailable".into(),
      ));
    }
    crate::workflow_runtime::effects::lock_runtime_authority(&mut tx, actor, accepted.workspace_id, false).await?;
    // Decisions never hold an engine claim. Stop holds claim then Run; this
    // command takes only Run before native Database/document locks.
    let run=sqlx::query("SELECT status,review_outcome_json,review_invalid_reason,review_expired_at FROM workspace_automation_runs WHERE id=$1 FOR UPDATE").bind(input.run_id).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    if let Some(value) = run
      .try_get::<Option<Value>, _>("review_outcome_json")
      .map_err(Self::map_sqlx_error)?
    {
      let receipt: DocumentReviewDecisionReceipt =
        serde_json::from_value(value).map_err(|error| RepositoryError::Storage(error.to_string()))?;
      if receipt.request_id != input.request_id
        || receipt.actor_id != actor
        || receipt.source_revision != input.expected_document_revision
        || receipt.expected_task_edit_revision != input.expected_task_edit_revision
        || receipt.expected_status_edit_revision != input.expected_status_edit_revision
        || serde_json::to_value(&receipt.decision).map_err(|error| RepositoryError::Storage(error.to_string()))?
          != serde_json::to_value(&input.decision).map_err(|error| RepositoryError::Storage(error.to_string()))?
      {
        return Err(RepositoryError::Conflict("review decision request"));
      }
      tx.commit().await.map_err(Self::map_sqlx_error)?;
      return Ok((receipt, None));
    }
    if !matches!(
      run
        .try_get::<String, _>("status")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
      "queued" | "running"
    ) || run
      .try_get::<Option<String>, _>("review_invalid_reason")
      .map_err(Self::map_sqlx_error)?
      .is_some()
      || run
        .try_get::<Option<DateTime<Utc>>, _>("review_expired_at")
        .map_err(Self::map_sqlx_error)?
        .is_some()
      || input.expected_document_revision != review.plan.source_revision
    {
      return Err(RepositoryError::Validation(
        "review decision is no longer applicable".into(),
      ));
    }
    let policy = Self::prepare_project_mutation(&mut tx, review.plan.destination_database_id, &[], false)
      .await?
      .ok_or_else(|| RepositoryError::Validation("review native Task container unavailable".into()))?;
    let status = Self::project_role_field(&policy, "task.status")
      .ok_or_else(|| RepositoryError::Validation("review Task status unavailable".into()))?;
    let assignees = Self::project_role_field(&policy, "task.assignees")
      .ok_or_else(|| RepositoryError::Validation("review Task assignment unavailable".into()))?;
    let row=sqlx::query("SELECT edit_revision FROM workspace_database_rows WHERE id=$1 AND database_id=$2 AND row_kind='task' AND deleted_at IS NULL FOR UPDATE").bind(review.review_task_id).bind(review.plan.destination_database_id).fetch_optional(&mut *tx).await.map_err(Self::map_sqlx_error)?.ok_or(RepositoryError::NotFound("review Task"))?;
    if row.try_get::<i64, _>("edit_revision").map_err(Self::map_sqlx_error)? != input.expected_task_edit_revision {
      return Err(RepositoryError::Conflict("database row edit revision"));
    }
    let users: Option<Value> = sqlx::query_scalar(
      "SELECT value_json FROM workspace_database_cell_values WHERE row_id=$1 AND field_id=$2 FOR UPDATE",
    )
    .bind(review.review_task_id)
    .bind(assignees)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if users
      .map(|value| Self::map_cell_value_from_json(DatabaseFieldType::Users, value))
      .transpose()?
      .is_none_or(|value| !matches!(value,DatabaseCellValueData::Users(ids) if ids==vec![actor]))
    {
      return Err(RepositoryError::Validation("review Task reassigned".into()));
    }
    let current: Option<Value> = sqlx::query_scalar(
      "SELECT value_json FROM workspace_database_cell_values WHERE row_id=$1 AND field_id=$2 FOR UPDATE",
    )
    .bind(review.review_task_id)
    .bind(status)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let config = policy
      .semantics
      .status_config
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("review Task status unavailable".into()))?;
    let current = current
      .map(|value| Self::map_cell_value_from_json(DatabaseFieldType::Status, value))
      .transpose()?;
    if matches!(current,Some(DatabaseCellValueData::Status(id)) if config.options.iter().any(|option|option.id==id && matches!(option.group,DatabaseStatusGroup::Complete | DatabaseStatusGroup::Archived)))
    {
      return Err(RepositoryError::Validation(
        "review Task already completed outside decision".into(),
      ));
    }
    let complete = config
      .options
      .iter()
      .find(|option| option.group == DatabaseStatusGroup::Complete)
      .ok_or_else(|| RepositoryError::Validation("native completion status unavailable".into()))?
      .id
      .clone();
    let revision = crate::doc::SqlxDocStore::review_source_revision_in_tx(
      &mut tx,
      accepted.workspace_id,
      review.plan.source_document_id,
      &review.plan.source_external_id,
    )
    .await
    .map_err(review_source_error)?;
    if revision != review.plan.source_revision {
      return Err(RepositoryError::Validation("review source revision changed".into()));
    }
    if matches!(&input.decision,DocumentReviewDecision::RequestChanges{reason} if reason.trim().is_empty()||reason.len()>65536)
    {
      return Err(RepositoryError::Validation(
        "review changes require a bounded reason".into(),
      ));
    }
    // Sample acceptance only after all native locks and revision checks: time
    // spent waiting for a writer must not backdate a decision past its deadline.
    let accepted_at: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    if accepted_at > review.plan.deadline_at {
      return Err(RepositoryError::Validation("review decision deadline elapsed".into()));
    }
    let receipt = DocumentReviewDecisionReceipt {
      workspace_id: accepted.workspace_id,
      database_id: review.plan.destination_database_id,
      review_task_id: review.review_task_id,
      run_id: accepted.run_id,
      wait_id: review.wait_id.clone(),
      event_id: Uuid::new_v4(),
      request_id: input.request_id,
      actor_id: actor,
      source_revision: revision,
      expected_task_edit_revision: input.expected_task_edit_revision,
      expected_status_edit_revision: input.expected_status_edit_revision,
      decision: input.decision,
      accepted_at,
    };
    // The native outcome is visible to the ordinary committed Task-event hook
    // inside this transaction, distinguishing our own completion from Done.
    sqlx::query("UPDATE workspace_automation_runs SET review_outcome_json=$2 WHERE id=$1")
      .bind(accepted.run_id)
      .bind(serde_json::to_value(&receipt).map_err(|error| RepositoryError::Storage(error.to_string()))?)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let cell_outcome = self
      .update_cell_value_in_tx(
        &mut tx,
        review.review_task_id,
        status,
        DatabaseCellValueData::Status(complete),
        actor,
        DatabaseEditPrecondition::new(Some(input.expected_status_edit_revision), false)
          .in_workspace(accepted.workspace_id)
          .in_database(review.plan.destination_database_id),
        None,
      )
      .await?;
    let outcome_key = match receipt.decision {
      DocumentReviewDecision::Approve => "approve",
      DocumentReviewDecision::RequestChanges { .. } => "requestChanges",
    };
    let signal = WorkflowSignalEnvelope {
      format_version: 1,
      event_id: receipt.event_id,
      key: WorkflowWaitKey {
        run_id: receipt.run_id,
        wait_id: receipt.wait_id.clone(),
      },
      accepted_at,
      outcome: WorkflowSignalOutcome::Accepted {
        outcome_key: outcome_key.into(),
        result: serde_json::to_value(&receipt).map_err(|error| RepositoryError::Storage(error.to_string()))?,
      },
    };
    PgWorkspaceAutomationRepository::insert_workflow_signal_intent(&mut tx, &signal).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok((receipt, Some(cell_outcome)))
  }
}

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn assert_review_capture_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    database: DatabaseId,
    row: DatabaseRowId,
    actor: UserId,
    capture: Option<&DatabaseTaskCaptureReceipt>,
    fence: AutomationEffectFence,
  ) -> RepoResult<()> {
    let value: Value = sqlx::query_scalar("SELECT accepted_json FROM workspace_automation_runs WHERE id=$1")
      .bind(fence.run_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let accepted: AcceptedAutomationRun =
      serde_json::from_value(value).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    if let Some(handover) = &accepted.task_handover {
      let capture =
        capture.ok_or_else(|| RepositoryError::Validation("handover requires its native source receipt".into()))?;
      if row != handover.result_task_id
        || database != handover.plan.destination_database_id
        || actor != handover.plan.actor_id
        || capture.source.document_id != handover.plan.source_document_id
        || capture.source.external_id != handover.plan.source_external_id
        || capture.workspace_id != accepted.workspace_id
      {
        return Err(RepositoryError::Validation(
          "handover Task/source identity changed".into(),
        ));
      }
      // Only the normal Database writer seeds canonical node admission into
      // this transaction. Reservation/receipt reads cannot fabricate that set.
      let mut databases = handover
        .plan
        .prerequisites
        .iter()
        .map(|task| task.database_id)
        .collect::<std::collections::BTreeSet<_>>();
      databases.insert(handover.plan.destination_database_id);
      for database in databases {
        Self::lock_managed_admission(tx, database).await?;
      }
      // Unlike a review decision, handover freezes document identity, not its body.
      return Self::assert_handover_effect(tx, &accepted).await;
    }
    let Some(review) = &accepted.document_review else {
      return Ok(());
    };
    let capture =
      capture.ok_or_else(|| RepositoryError::Validation("review Task requires its native source receipt".into()))?;
    let reserved: Uuid =
      sqlx::query_scalar("SELECT reserved_id FROM workspace_automation_actions WHERE id=$1 AND run_id=$2")
        .bind(fence.action_id)
        .bind(fence.run_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?;
    if row != reserved
      || database != review.plan.destination_database_id
      || actor != review.plan.actor_id
      || capture.source.document_id != review.plan.source_document_id
      || capture.source.external_id != review.plan.source_external_id
      || capture.workspace_id != accepted.workspace_id
    {
      return Err(RepositoryError::Validation(
        "review Task/source identity changed".into(),
      ));
    }
    let revision = crate::doc::SqlxDocStore::review_source_revision_in_tx(
      tx,
      accepted.workspace_id,
      review.plan.source_document_id,
      &review.plan.source_external_id,
    )
    .await
    .map_err(review_source_error)?;
    if revision != review.plan.source_revision {
      return Err(RepositoryError::Validation("review source revision changed".into()));
    }
    Ok(())
  }
}
fn review_source_error(error: myoxus_application::auth::AuthError) -> RepositoryError {
  match error {
    myoxus_application::auth::AuthError::Storage(message) => RepositoryError::Storage(message),
    _ => RepositoryError::Validation("review source permission unavailable".into()),
  }
}
