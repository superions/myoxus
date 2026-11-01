// SPDX-License-Identifier: AGPL-3.0-or-later
//! Proposal confirmation shares native Run, Database and signal intent locks.
use crate::workspace_automation::PgWorkspaceAutomationRepository;
use crate::workspace_database::*;
use myoxus_domain::workspace_automation::*;
use sqlx::PgConnection;
impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn assert_correction_bulk_input(
    tx: &mut PgConnection,
    fence: AutomationEffectFence,
    database: DatabaseId,
    patches: &[(DatabaseRowId, DatabaseFieldId, Option<DatabaseCellValueData>)],
    actor: UserId,
    expected: &HashMap<(DatabaseRowId, DatabaseFieldId), i64>,
    force: bool,
  ) -> RepoResult<()> {
    let value: Value = sqlx::query_scalar("SELECT accepted_json FROM workspace_automation_runs WHERE id=$1")
      .bind(fence.run_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let accepted: AcceptedAutomationRun =
      serde_json::from_value(value).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let plan = &accepted
      .task_maintenance
      .as_ref()
      .ok_or_else(|| RepositoryError::Conflict("correction acceptance unavailable"))?
      .plan;
    if force
      || actor != plan.actor_id
      || database != plan.proposal.database_id
      || patches.len() != plan.proposal.patches.len()
      || expected.len() != patches.len()
    {
      return Err(RepositoryError::Conflict("correction bulk input changed"));
    }
    Self::assert_task_correction_proposal_in_tx(tx, &plan.proposal, true).await?;
    for patch in &plan.proposal.patches {
      let value = match &patch.intent {
        DatabaseBulkCellIntent::Set(value) => Some(value),
        DatabaseBulkCellIntent::Clear => None,
      };
      let expected_value = serde_json::to_value(value).map_err(|error| RepositoryError::Storage(error.to_string()))?;
      let actual_value = patches
        .iter()
        .find(|(row, field, _)| *row == patch.row_id && *field == patch.field_id)
        .map(|(_, _, actual)| serde_json::to_value(actual))
        .transpose()
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
      if actual_value.as_ref() != Some(&expected_value)
        || expected.get(&(patch.row_id, patch.field_id)) != Some(&patch.expected_edit_revision)
      {
        return Err(RepositoryError::Conflict("correction bulk input changed"));
      }
    }
    Ok(())
  }

  pub(crate) async fn assert_task_correction_proposal_in_tx(
    tx: &mut PgConnection,
    proposal: &TaskCorrectionProposal,
    check_revisions: bool,
  ) -> RepoResult<()> {
    Self::lock_managed_admission(tx, proposal.database_id).await?;
    let workspace: Uuid =
      sqlx::query_scalar("SELECT workspace_id FROM workspace_databases WHERE id=$1 AND deleted_at IS NULL FOR SHARE")
        .bind(proposal.database_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
    if workspace != proposal.workspace_id || proposal.tasks.is_empty() || proposal.tasks.len() > 64 {
      return Err(RepositoryError::Conflict("correction proposal scope"));
    }
    let mut expected = std::collections::BTreeMap::new();
    for row in &proposal.row_preconditions {
      if expected.insert(row.row_id, row.expected_edit_revision).is_some() {
        return Err(RepositoryError::Conflict("duplicate correction row"));
      }
    }
    let mut selected = std::collections::BTreeSet::new();
    for task in &proposal.tasks {
      if task.database_id != proposal.database_id || !selected.insert(task.row_id) {
        return Err(RepositoryError::Conflict("correction proposal scope"));
      }
    }
    if selected.len() != expected.len() || selected.iter().any(|row| !expected.contains_key(row)) {
      return Err(RepositoryError::Conflict("correction proposal preconditions"));
    }
    let ids = selected.into_iter().collect::<Vec<_>>();
    let rows=sqlx::query("SELECT id,edit_revision FROM workspace_database_rows WHERE database_id=$1 AND id=ANY($2) AND row_kind='task' AND deleted_at IS NULL ORDER BY id FOR UPDATE")
      .bind(proposal.database_id).bind(&ids).fetch_all(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    if rows.len() != ids.len() {
      return Err(RepositoryError::Conflict("correction Task unavailable"));
    }
    for row in rows {
      let id: Uuid = row.try_get("id").map_err(Self::map_sqlx_error)?;
      if check_revisions
        && expected.get(&id) != Some(&row.try_get::<i64, _>("edit_revision").map_err(Self::map_sqlx_error)?)
      {
        return Err(RepositoryError::Conflict("database row edit revision"));
      }
    }
    let mut targets = std::collections::BTreeSet::new();
    for patch in &proposal.patches {
      if !expected.contains_key(&patch.row_id) || !targets.insert((patch.row_id, patch.field_id)) {
        return Err(RepositoryError::Conflict("correction patch target"));
      }
      let current: Option<i64> =
        sqlx::query_scalar("SELECT edit_revision FROM workspace_database_cell_values WHERE row_id=$1 AND field_id=$2")
          .bind(patch.row_id)
          .bind(patch.field_id)
          .fetch_optional(&mut *tx)
          .await
          .map_err(Self::map_sqlx_error)?;
      if check_revisions && current.unwrap_or(0) != patch.expected_edit_revision {
        return Err(RepositoryError::Conflict("database cell edit revision"));
      }
      if check_revisions {
        if let (
          Some(DatabaseCellValueData::Users(old)),
          DatabaseBulkCellIntent::Set(DatabaseCellValueData::Users(new)),
        ) = (&patch.old_value, &patch.intent)
        {
          let roles = Self::list_field_roles_for(&mut *tx, proposal.database_id).await?;
          if !roles
            .iter()
            .any(|role| role.role_key == "task.assignees" && role.field_id == patch.field_id)
          {
            return Err(RepositoryError::Conflict("correction assignment role changed"));
          }
          // An absent membership cannot be row-locked. The existing Workspace
          // FK parent lock also excludes reinsertion, while membership locks
          // exclude Pending/Revoked -> Accepted. NOWAIT avoids reversing the
          // governance writer's Workspace-before-membership lock order.
          sqlx::query("SELECT id FROM workspaces WHERE id=$1 AND lifecycle_state='active' AND deleted_at IS NULL FOR UPDATE NOWAIT")
            .bind(proposal.workspace_id).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
          let members = sqlx::query("SELECT user_id,status::text AS status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=ANY($2) ORDER BY user_id FOR SHARE NOWAIT")
            .bind(proposal.workspace_id).bind(old).fetch_all(&mut *tx).await.map_err(Self::map_sqlx_error)?;
          let mut accepted = std::collections::BTreeSet::new();
          for member in members {
            if member.try_get::<String, _>("status").map_err(Self::map_sqlx_error)? == "Accepted" {
              accepted.insert(member.try_get::<Uuid, _>("user_id").map_err(Self::map_sqlx_error)?);
            }
          }
          let current = old
            .iter()
            .copied()
            .filter(|id| accepted.contains(id))
            .collect::<Vec<_>>();
          if &current != new || current.len() == old.len() {
            return Err(RepositoryError::Conflict("correction assignment membership changed"));
          }
        }
      }
    }
    Ok(())
  }
  pub(in crate::workspace_database) async fn persist_task_correction_confirmation(
    &self,
    actor: UserId,
    input: TaskCorrectionConfirmationInput,
  ) -> RepoResult<TaskCorrectionConfirmationReceipt> {
    let mut tx = self.begin_write().await?;
    let value:Value=sqlx::query_scalar("SELECT accepted_json FROM workspace_automation_runs WHERE id=$1 AND (origin_kind='task_maintenance' OR (origin_kind='rule' AND accepted_json->'taskMaintenance' IS NOT NULL))")
      .bind(input.run_id).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    let accepted: AcceptedAutomationRun =
      serde_json::from_value(value).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let maintenance = accepted
      .task_maintenance
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("correction acceptance unavailable".into()))?;
    if actor != maintenance.plan.actor_id
      || accepted.actor_id != Some(actor)
      || input.request_id.is_nil()
      || input.wait_id != maintenance.wait_id
      || input.proposal_digest != maintenance.plan.proposal.digest
    {
      return Err(RepositoryError::Validation(
        "correction confirmation permission unavailable".into(),
      ));
    }
    crate::workflow_runtime::effects::lock_runtime_authority(&mut tx, actor, accepted.workspace_id, false).await?;
    // No engine claim is held by a human command. Stop and effects take Run
    // before Database roots; the retained outcome wins a lost-response replay.
    let row=sqlx::query("SELECT status,task_correction_outcome_json,task_maintenance_invalid_reason FROM workspace_automation_runs WHERE id=$1 FOR UPDATE")
      .bind(input.run_id).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    if let Some(value) = row
      .try_get::<Option<Value>, _>("task_correction_outcome_json")
      .map_err(Self::map_sqlx_error)?
    {
      let receipt: TaskCorrectionConfirmationReceipt =
        serde_json::from_value(value).map_err(|error| RepositoryError::Storage(error.to_string()))?;
      if receipt.actor_id != actor
        || receipt.request_id != input.request_id
        || receipt.wait_id != input.wait_id
        || receipt.proposal_digest != input.proposal_digest
        || receipt.outcome != input.outcome
      {
        return Err(RepositoryError::Conflict("correction confirmation input changed"));
      }
      tx.commit().await.map_err(Self::map_sqlx_error)?;
      return Ok(receipt);
    }
    if !matches!(
      row
        .try_get::<String, _>("status")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
      "queued" | "running"
    ) || row
      .try_get::<Option<String>, _>("task_maintenance_invalid_reason")
      .map_err(Self::map_sqlx_error)?
      .is_some()
    {
      return Err(RepositoryError::Conflict("correction proposal terminal"));
    }
    if accepted.personal_rule.is_some() {
      crate::workflow_runtime::effects::lock_personal_automation(&mut tx, &accepted).await?;
    }
    // Decline never writes Task content and remains possible for a stale draft.
    Self::assert_task_correction_proposal_in_tx(&mut tx, &maintenance.plan.proposal, false).await?;
    if input.outcome == TaskCorrectionOutcome::Apply {
      if maintenance.plan.proposal.patches.is_empty() {
        return Err(RepositoryError::Validation(
          "correction proposal has no applicable changes".into(),
        ));
      }
      Self::assert_task_correction_proposal_in_tx(&mut tx, &maintenance.plan.proposal, true).await?;
    }
    let inspected:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_automation_actions WHERE run_id=$1 AND node_key='action:0' AND effect_key='apply' AND status='succeeded')")
      .bind(input.run_id).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    if !inspected {
      return Err(RepositoryError::Conflict("correction inspection not committed"));
    }
    let accepted_at: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let receipt = TaskCorrectionConfirmationReceipt {
      run_id: input.run_id,
      actor_id: actor,
      request_id: input.request_id,
      wait_id: input.wait_id,
      proposal_digest: input.proposal_digest,
      outcome: input.outcome,
      event_id: Uuid::new_v4(),
      accepted_at,
    };
    sqlx::query("UPDATE workspace_automation_runs SET task_correction_outcome_json=$2 WHERE id=$1")
      .bind(input.run_id)
      .bind(serde_json::to_value(&receipt).map_err(|error| RepositoryError::Storage(error.to_string()))?)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let signal = WorkflowSignalEnvelope {
      format_version: 1,
      event_id: receipt.event_id,
      key: WorkflowWaitKey {
        run_id: input.run_id,
        wait_id: receipt.wait_id.clone(),
      },
      accepted_at,
      outcome: WorkflowSignalOutcome::Accepted {
        outcome_key: match receipt.outcome {
          TaskCorrectionOutcome::Apply => "apply",
          TaskCorrectionOutcome::Decline => "decline",
        }
        .into(),
        result: serde_json::to_value(&receipt).map_err(|error| RepositoryError::Storage(error.to_string()))?,
      },
    };
    PgWorkspaceAutomationRepository::insert_workflow_signal_intent(&mut tx, &signal).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(receipt)
  }
}
