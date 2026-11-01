// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native effect fences share the caller's transaction; an engine checkpoint
//! never substitutes for the committed native result.
use myoxus_domain::{
  repositories::{RepoResult, RepositoryError},
  workspace_automation::{AcceptedAutomationRun, AutomationEffectFence},
};
use serde_json::Value;
use sqlx::{PgConnection, Row};

fn storage(error: impl std::fmt::Display) -> RepositoryError {
  RepositoryError::Storage(error.to_string())
}
fn stale() -> RepositoryError {
  RepositoryError::Validation("automation execution is no longer authorized".into())
}

/// Reuse canonical effective workspace authority for native effects and
/// explicit run controls. A different actor needs current Manager authority.
pub(crate) async fn lock_runtime_authority(
  tx: &mut PgConnection,
  actor: uuid::Uuid,
  workspace: uuid::Uuid,
  manager_only: bool,
) -> RepoResult<()> {
  // OU membership writers lock OU before user; workspace ownership/import
  // writers can lock workspace before OU. Never wait while acquiring these
  // authority locks in a competing order: contention fails this attempt closed.
  let workspace_row = sqlx::query(
    "SELECT id FROM workspaces WHERE id=$1 AND deleted_at IS NULL AND lifecycle_state='active' FOR SHARE NOWAIT",
  )
  .bind(workspace)
  .fetch_optional(&mut *tx)
  .await
  .map_err(storage)?;
  if workspace_row.is_none() {
    return Err(stale());
  }
  let direct = sqlx::query("SELECT u.id FROM users u JOIN workspace_memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.workspace_id=$2 AND u.status='active' AND m.status='Accepted' AND (m.role IN ('Owner','Admin','Manager') OR (NOT $3 AND m.role='Collaborator')) FOR SHARE OF u,m NOWAIT")
    .bind(actor).bind(workspace).bind(manager_only).fetch_optional(&mut *tx).await.map_err(storage)?;
  if direct.is_none() {
    // Match can_manage_ou_workspace: one active exact Manager membership,
    // the global Manager capability, and any relationship to this workspace.
    let unit: Option<uuid::Uuid> = sqlx::query_scalar("SELECT ou.id FROM organization_unit ou JOIN organization_unit_member m ON m.unit_id=ou.id JOIN organization_unit_workspace l ON l.unit_id=ou.id JOIN user_features f ON f.user_id=m.user_id WHERE m.user_id=$1 AND l.workspace_id=$2 AND ou.status='active' AND m.role='manager' AND f.feature_name='manager' AND f.activated ORDER BY ou.id LIMIT 1")
      .bind(actor).bind(workspace).fetch_optional(&mut *tx).await.map_err(storage)?;
    let unit = unit.ok_or_else(stale)?;
    let active = sqlx::query("SELECT id FROM organization_unit WHERE id=$1 AND status='active' FOR SHARE NOWAIT")
      .bind(unit)
      .fetch_optional(&mut *tx)
      .await
      .map_err(storage)?;
    if active.is_none() {
      return Err(stale());
    }
    let manager = sqlx::query("SELECT u.id FROM users u JOIN user_features f ON f.user_id=u.id JOIN organization_unit_member m ON m.user_id=u.id JOIN organization_unit_workspace l ON l.unit_id=m.unit_id WHERE u.id=$1 AND l.workspace_id=$2 AND m.unit_id=$3 AND u.status='active' AND m.role='manager' AND f.feature_name='manager' AND f.activated FOR SHARE OF u,f,m,l NOWAIT")
      .bind(actor).bind(workspace).bind(unit).fetch_optional(&mut *tx).await.map_err(storage)?;
    if manager.is_none() {
      return Err(stale());
    }
  }
  Ok(())
}

/// Check standing consent on the existing Rule. Root locks precede preference
/// and Registry locks; preference writers invalidate the same Rule generation.
pub(crate) async fn lock_personal_automation(
  tx: &mut PgConnection,
  accepted: &AcceptedAutomationRun,
) -> RepoResult<()> {
  let proof = accepted.personal_rule.as_ref().ok_or_else(stale)?;
  let actor = accepted.actor_id.ok_or_else(stale)?;
  let trigger = accepted.trigger.as_ref().ok_or_else(stale)?;
  if proof.actor_id != actor
    || proof.config.actor_id != actor
    || trigger.actor_user_id != Some(actor)
    || proof.database_id != trigger.database_id
    || proof.config.database_id != trigger.database_id
  {
    return Err(stale());
  }
  let row=sqlx::query("SELECT personal_config,execution_revision,created_by,status,actions_json FROM workspace_automations WHERE id=$1 AND workspace_id=$2 FOR SHARE NOWAIT")
    .bind(accepted.automation_id).bind(accepted.workspace_id).fetch_optional(&mut *tx).await.map_err(storage)?.ok_or_else(stale)?;
  if row.try_get::<String, _>("status").map_err(storage)? != "enabled"
    || row.try_get::<i64, _>("execution_revision").map_err(storage)? != proof.execution_revision
    || row.try_get::<Option<uuid::Uuid>, _>("created_by").map_err(storage)? != Some(actor)
    || row.try_get::<Value, _>("personal_config").map_err(storage)?
      != serde_json::to_value(&proof.config).map_err(storage)?
    || row.try_get::<Value, _>("actions_json").map_err(storage)?
      != serde_json::to_value(&accepted.definition.actions).map_err(storage)?
    || accepted
      .definition
      .workflow
      .as_ref()
      .is_none_or(|workflow| workflow.source.identity != proof.config.workflow.identity)
  {
    return Err(stale());
  }
  let actual:Option<Value>=sqlx::query_scalar("SELECT managed_installation FROM workspace_databases WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL FOR UPDATE")
    .bind(proof.database_id).bind(accepted.workspace_id).fetch_optional(&mut *tx).await.map_err(storage)?.flatten();
  if proof.installation.readiness != myoxus_domain::database::DatabaseManagedSchemaReadiness::Ready
    || actual != Some(serde_json::to_value(&proof.installation).map_err(storage)?)
  {
    return Err(stale());
  }
  let assistance =
    crate::auth::SqlxAuthStore::personal_assistance_in_tx(tx, actor, accepted.workspace_id, proof.database_id)
      .await
      .map_err(|error| match error {
        myoxus_application::auth::AuthError::Storage(message) => RepositoryError::Storage(message),
        _ => stale(),
      })?;
  if assistance.mode != myoxus_application::auth::AssistanceMode::Automatic {
    return Err(stale());
  }
  // Maintenance locks the complete selected set in UUID order below; do not
  // pre-lock its triggering Row ahead of that same set.
  if accepted.task_maintenance.is_none() {
    let task:Option<uuid::Uuid>=sqlx::query_scalar("SELECT id FROM workspace_database_rows WHERE id=$1 AND database_id=$2 AND row_kind='task' AND deleted_at IS NULL FOR SHARE")
    .bind(trigger.row_id).bind(trigger.database_id).fetch_optional(&mut *tx).await.map_err(storage)?;
    if task.is_none() {
      return Err(stale());
    }
  } else if !accepted.task_maintenance.as_ref().is_some_and(|maintenance| {
    maintenance
      .plan
      .proposal
      .tasks
      .iter()
      .any(|task| task.database_id == trigger.database_id && task.row_id == trigger.row_id)
  }) {
    return Err(stale());
  }
  for action in &accepted.definition.actions {
    if let myoxus_domain::workspace_automation::WorkspaceAutomationActionConfig::CreateLinkedDocument {
      source: Some(source),
      ..
    } = &action.config
    {
      crate::template_registry::SqlxTemplateRegistryStore::lock_automation_source_in_tx(
        tx,
        source,
        proof.config.client_version,
        false,
      )
      .await
      .map_err(|error| match error {
        myoxus_application::auth::AuthError::Storage(message) => RepositoryError::Storage(message),
        _ => stale(),
      })?;
    }
  }
  Ok(())
}

/// Lock current authority, engine claim, native run and effect in that order.
/// A committed result is read back, never applied to the target a second time.
pub(crate) async fn lock_runtime_execution(
  tx: &mut PgConnection,
  fence: &AutomationEffectFence,
  node_key: &str,
) -> RepoResult<AcceptedAutomationRun> {
  let accepted: Option<Value> = sqlx::query_scalar("SELECT accepted_json FROM workspace_automation_runs WHERE id=$1")
    .bind(fence.run_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(storage)?
    .flatten();
  let accepted: AcceptedAutomationRun = serde_json::from_value(accepted.ok_or_else(stale)?).map_err(|_| stale())?;
  let actor = accepted.actor_id.ok_or_else(stale)?;
  lock_runtime_authority(tx, actor, accepted.workspace_id, false).await?;
  let claim = sqlx::query(
    "SELECT worker_id,expires_at>now() AS live FROM sayiir_workflow_claims WHERE instance_id=$1 FOR UPDATE",
  )
  .bind(fence.run_id.to_string())
  .fetch_optional(&mut *tx)
  .await
  .map_err(storage)?
  .ok_or_else(stale)?;
  let run = sqlx::query("SELECT execution_generation,claim_owner,status,accepted_json FROM workspace_automation_runs WHERE id=$1 FOR UPDATE")
    .bind(fence.run_id).fetch_one(&mut *tx).await.map_err(storage)?;
  if !claim
    .try_get::<Option<bool>, _>("live")
    .map_err(storage)?
    .unwrap_or(false)
    || claim.try_get::<String, _>("worker_id").map_err(storage)? != fence.claim.owner.to_string()
    || run.try_get::<i64, _>("execution_generation").map_err(storage)? != fence.claim.generation
    || run.try_get::<Option<uuid::Uuid>, _>("claim_owner").map_err(storage)? != Some(fence.claim.owner)
    || !matches!(
      run.try_get::<String, _>("status").map_err(storage)?.as_str(),
      "queued" | "running"
    )
    || run.try_get::<Value, _>("accepted_json").map_err(storage)? != serde_json::to_value(&accepted).map_err(storage)?
  {
    return Err(stale());
  }
  if let Some(origin) = &accepted.workspace_setup {
    if accepted.automation_id.is_some()
      || accepted.trigger.is_some()
      || accepted.confirmed_request.is_some()
      || accepted.document_review.is_some()
      || accepted.task_handover.is_some()
      || accepted.task_maintenance.is_some()
      || accepted.personal_rule.is_some()
    {
      return Err(stale());
    }
    myoxus_application::workspace_automation::setup::workspace_setup_stage_count(&accepted.definition)
      .map_err(|_| stale())?;
    let position = node_key
      .strip_prefix("action:")
      .and_then(|value| value.parse::<usize>().ok())
      .filter(|position| node_key == format!("action:{position}"))
      .ok_or_else(stale)?;
    let stage = accepted
      .definition
      .workflow
      .as_ref()
      .and_then(|workflow| workflow.stages.get(position))
      .ok_or_else(stale)?;
    let receipt = crate::workspace::SqlxWorkspaceStore::setup_receipt(
      tx,
      actor,
      accepted.workspace_id,
      origin.request_id,
      Some(&origin.fingerprint),
    )
    .await
    .map_err(storage)?
    .ok_or_else(stale)?;
    if receipt.run_id != accepted.run_id
      || receipt.plan.is_none()
      || (receipt.state != myoxus_application::workspace::ProjectStarterState::Accepted
        && !(matches!(
          stage,
          myoxus_domain::workspace_automation::ContextDocumentWorkflowStage::Complete
        ) && receipt.state == myoxus_application::workspace::ProjectStarterState::Complete))
    {
      return Err(stale());
    }
    let saved:bool=sqlx::query_scalar("SELECT assistance_saved_at IS NOT NULL FROM workspace_starter_applications WHERE actor_id=$1 AND operation='create_workspace' AND request_id=$2")
      .bind(actor).bind(origin.request_id).fetch_one(&mut *tx).await.map_err(storage)?;
    if !saved {
      return Err(stale());
    }
    let definition = myoxus_application::workspace_automation::setup::compile_workspace_setup(
      &receipt.original,
      accepted.definition.policy.clone(),
    )
    .map_err(|_| stale())?;
    if definition.hash != accepted.definition.hash {
      return Err(stale());
    }
    crate::workspace::SqlxWorkspaceStore::setup_result_fence(tx, &receipt)
      .await
      .map_err(|error| match error {
        myoxus_application::auth::AuthError::Storage(message) => RepositoryError::Storage(message),
        _ => stale(),
      })?;
    return Ok(accepted);
  }
  if accepted.personal_rule.is_some() {
    lock_personal_automation(tx, &accepted).await?;
  }
  if let Some(maintenance) = &accepted.task_maintenance {
    if accepted.confirmed_request.is_some()
      || accepted.document_review.is_some()
      || accepted.task_handover.is_some()
      || ((accepted.automation_id.is_some() || accepted.trigger.is_some()) && accepted.personal_rule.is_none())
      || maintenance.plan.actor_id != actor
      || maintenance.plan.workspace_id != accepted.workspace_id
    {
      return Err(stale());
    }
    let apply =
      myoxus_application::workspace_automation::maintenance::maintenance_effect_kind(&accepted.definition, node_key)
        .map_err(|_| stale())?;
    if apply {
      let value: Option<Value> =
        sqlx::query_scalar("SELECT task_correction_outcome_json FROM workspace_automation_runs WHERE id=$1")
          .bind(accepted.run_id)
          .fetch_one(&mut *tx)
          .await
          .map_err(storage)?;
      let receipt: myoxus_domain::workspace_automation::TaskCorrectionConfirmationReceipt =
        serde_json::from_value(value.ok_or_else(stale)?).map_err(|_| stale())?;
      if receipt.run_id != accepted.run_id
        || receipt.actor_id != actor
        || receipt.wait_id != maintenance.wait_id
        || receipt.proposal_digest != maintenance.plan.proposal.digest
        || receipt.outcome != myoxus_domain::workspace_automation::TaskCorrectionOutcome::Apply
      {
        return Err(stale());
      }
    }
    // Revision checks belong immediately before the native mutation. The ACK
    // re-enters this authority guard after that mutation has advanced revisions.
    crate::workspace_database::PgDatabaseRepository::assert_task_correction_proposal_in_tx(
      tx,
      &maintenance.plan.proposal,
      false,
    )
    .await?;
    return Ok(accepted);
  }
  if let Some(handover) = &accepted.task_handover {
    if accepted.confirmed_request.is_some()
      || accepted.document_review.is_some()
      || accepted.automation_id.is_some()
      || accepted.trigger.is_some()
      || handover.plan.actor_id != actor
      || handover.plan.workspace_id != accepted.workspace_id
    {
      return Err(stale());
    }
    myoxus_application::workspace_automation::handover::handover_effect_component(&accepted.definition, node_key)
      .map_err(|_| stale())?;
    // lock_runtime_authority retains at least Collaborator (or an OU Manager).
    // Canonical fixup_doc_role makes that an additive Editor floor: explicit
    // Doc grants cannot revoke Copy below it. The shared capture writer locks
    // the exact live, unblocked source Row before its same-Tx effect ACK.
    crate::workspace_database::PgDatabaseRepository::assert_handover_effect(tx, &accepted).await?;
    return Ok(accepted);
  }
  if let Some(review) = &accepted.document_review {
    if accepted.confirmed_request.is_some()
      || accepted.automation_id.is_some()
      || accepted.trigger.is_some()
      || review.plan.actor_id != actor
      || review.plan.workspace_id != accepted.workspace_id
    {
      return Err(stale());
    }
    let (_, branch) =
      myoxus_application::workspace_automation::review::review_effect_component(&accepted.definition, node_key)
        .map_err(|_| stale())?;
    let native = sqlx::query(
      "SELECT review_outcome_json,review_invalid_reason,review_expired_at FROM workspace_automation_runs WHERE id=$1",
    )
    .bind(accepted.run_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(storage)?;
    if native
      .try_get::<Option<String>, _>("review_invalid_reason")
      .map_err(storage)?
      .is_some()
      || native
        .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("review_expired_at")
        .map_err(storage)?
        .is_some()
    {
      return Err(stale());
    }
    if let Some(branch) = branch {
      let decision: myoxus_domain::workspace_automation::DocumentReviewDecisionReceipt = serde_json::from_value(
        native
          .try_get::<Option<Value>, _>("review_outcome_json")
          .map_err(storage)?
          .ok_or_else(stale)?,
      )
      .map_err(storage)?;
      let expected = match decision.decision {
        myoxus_domain::workspace_automation::DocumentReviewDecision::Approve => "approve",
        myoxus_domain::workspace_automation::DocumentReviewDecision::RequestChanges { .. } => "requestChanges",
      };
      if branch != expected
        || decision.accepted_at > review.plan.deadline_at
        || decision.source_revision != review.plan.source_revision
      {
        return Err(stale());
      }
    } else {
      let member: Option<bool> = sqlx::query_scalar(
        "SELECT true FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='Accepted' FOR SHARE NOWAIT",
      )
      .bind(accepted.workspace_id)
      .bind(review.plan.reviewer_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(storage)?;
      if member != Some(true) || review.plan.deadline_at <= chrono::Utc::now() {
        return Err(stale());
      }
    }
    return Ok(accepted);
  }
  if let Some(origin) = &accepted.confirmed_request {
    if accepted.automation_id.is_some() || accepted.trigger.is_some() {
      return Err(stale());
    }
    let position: usize = node_key
      .strip_prefix("action:")
      .and_then(|value| value.parse().ok())
      .filter(|position| node_key == format!("action:{position}"))
      .ok_or_else(stale)?;
    let stage = accepted
      .definition
      .workflow
      .as_ref()
      .and_then(|workflow| workflow.stages.get(position))
      .ok_or_else(stale)?;
    let receipt = crate::workspace::SqlxWorkspaceStore::context_receipt(
      tx,
      actor,
      accepted.workspace_id,
      origin.request_id,
      Some(&origin.fingerprint),
    )
    .await
    .map_err(storage)?
    .ok_or_else(stale)?;
    let completing = matches!(
      stage,
      myoxus_domain::workspace_automation::ContextDocumentWorkflowStage::Complete
    ) && receipt.state == myoxus_application::workspace::ProjectStarterState::Complete
      && receipt.progress.placement_complete;
    if receipt.run_id != Some(accepted.run_id)
      || receipt.plan.target != origin.target
      || (receipt.state != myoxus_application::workspace::ProjectStarterState::Accepted && !completing)
    {
      return Err(stale());
    }
    crate::workspace::SqlxWorkspaceStore::context_target_fence(
      tx,
      accepted.workspace_id,
      &origin.target,
      &receipt.admission.installation,
    )
    .await
    .map_err(storage)?;
    return Ok(accepted);
  }
  let trigger = accepted.trigger.as_ref().ok_or_else(stale)?;
  let rule =
    sqlx::query("SELECT id FROM workspace_automations WHERE id=$1 AND workspace_id=$2 AND status='enabled' FOR SHARE")
      .bind(accepted.automation_id)
      .bind(accepted.workspace_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(storage)?;
  let position: usize = node_key
    .strip_prefix("action:")
    .and_then(|value| value.parse().ok())
    .ok_or_else(stale)?;
  let action = accepted
    .definition
    .actions
    .get(position)
    .filter(|action| action.position == position as i32)
    .ok_or_else(stale)?;
  use myoxus_domain::workspace_automation::WorkspaceAutomationActionConfig;
  let target = match &action.config {
    WorkspaceAutomationActionConfig::CreateRow { database_id, .. } => Some(*database_id),
    WorkspaceAutomationActionConfig::UpdateCell { row_id, .. } => Some(
      sqlx::query_scalar::<_, uuid::Uuid>(
        "SELECT database_id FROM workspace_database_rows WHERE id=$1 AND deleted_at IS NULL",
      )
      .bind(row_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(storage)?
      .ok_or_else(stale)?,
    ),
    _ => None,
  };
  // Acquire every participating root in UUID order before any row lock. SHARE
  // followed by a writer upgrade would deadlock opposing cross-database effects.
  let mut roots = vec![trigger.database_id];
  roots.extend(target);
  roots.sort_unstable();
  roots.dedup();
  let locked = sqlx::query("SELECT id FROM workspace_databases WHERE id=ANY($1) AND workspace_id=$2 AND deleted_at IS NULL ORDER BY id FOR UPDATE")
    .bind(&roots).bind(accepted.workspace_id).fetch_all(&mut *tx).await.map_err(storage)?;
  if locked.len() != roots.len() {
    return Err(stale());
  }
  let source = sqlx::query(
    "SELECT id FROM workspace_database_rows WHERE database_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE",
  )
  .bind(trigger.database_id)
  .bind(trigger.row_id)
  .fetch_optional(&mut *tx)
  .await
  .map_err(storage)?;
  if let WorkspaceAutomationActionConfig::UpdateCell { row_id, .. } = &action.config {
    let current: Option<uuid::Uuid> = sqlx::query_scalar(
      "SELECT database_id FROM workspace_database_rows WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(row_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(storage)?;
    if current != target {
      return Err(stale());
    }
  }
  if rule.is_none() || source.is_none() || trigger.workspace_id != accepted.workspace_id {
    return Err(stale());
  }
  Ok(accepted)
}

pub async fn lock_runtime_effect(tx: &mut PgConnection, fence: &AutomationEffectFence) -> RepoResult<Option<Value>> {
  let node: String = sqlx::query_scalar("SELECT node_key FROM workspace_automation_actions WHERE id=$1 AND run_id=$2")
    .bind(fence.action_id)
    .bind(fence.run_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(storage)?
    .ok_or_else(stale)?;
  lock_runtime_execution(tx, fence, &node).await?;
  let action =
    sqlx::query("SELECT status,result_json FROM workspace_automation_actions WHERE id=$1 AND run_id=$2 FOR UPDATE")
      .bind(fence.action_id)
      .bind(fence.run_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(storage)?
      .ok_or_else(stale)?;
  if action.try_get::<String, _>("status").map_err(storage)? == "succeeded" {
    return action
      .try_get::<Option<Value>, _>("result_json")
      .map_err(storage)?
      .map(Some)
      .ok_or_else(stale);
  }
  if action.try_get::<String, _>("status").map_err(storage)? != "running" {
    return Err(stale());
  }
  Ok(None)
}

/// Called only after the native write, before committing that same transaction.
pub async fn acknowledge_runtime_effect(
  tx: &mut PgConnection,
  fence: &AutomationEffectFence,
  result: Value,
) -> RepoResult<()> {
  if lock_runtime_effect(tx, fence).await?.is_some() {
    return Ok(());
  }
  let changed = sqlx::query("UPDATE workspace_automation_actions SET status='succeeded',result_json=$3 WHERE id=$1 AND run_id=$2 AND status='running'")
    .bind(fence.action_id).bind(fence.run_id).bind(result).execute(&mut *tx).await.map_err(storage)?;
  if changed.rows_affected() != 1 {
    return Err(stale());
  }
  Ok(())
}

/// Bind the native writer to this exact compiled stage before any component
/// mutation. A claim for another component cannot authorize a receipt write.
pub(crate) async fn lock_context_effect(
  tx: &mut PgConnection,
  fence: &AutomationEffectFence,
  expected: &myoxus_domain::workspace_automation::ContextDocumentWorkflowStage,
) -> RepoResult<Option<Value>> {
  let prior = lock_runtime_effect(tx, fence).await?;
  let row=sqlx::query("SELECT r.accepted_json,a.position FROM workspace_automation_runs r JOIN workspace_automation_actions a ON a.run_id=r.id WHERE r.id=$1 AND a.id=$2")
    .bind(fence.run_id).bind(fence.action_id).fetch_one(&mut *tx).await.map_err(storage)?;
  let accepted: AcceptedAutomationRun =
    serde_json::from_value(row.try_get("accepted_json").map_err(storage)?).map_err(storage)?;
  let position: i32 = row.try_get("position").map_err(storage)?;
  if position < 0
    || accepted
      .definition
      .workflow
      .as_ref()
      .and_then(|workflow| workflow.stages.get(position as usize))
      != Some(expected)
  {
    return Err(stale());
  }
  Ok(prior)
}

/// Validate every caller acknowledgement field and the reserved native result
/// before either an early replay read or a write to the shared receipt.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn lock_context_receipt_effect(
  tx: &mut PgConnection,
  fence: &AutomationEffectFence,
  stage: &myoxus_domain::workspace_automation::ContextDocumentWorkflowStage,
  actor: uuid::Uuid,
  workspace: uuid::Uuid,
  request: uuid::Uuid,
  fingerprint: &str,
  doc_id: Option<uuid::Uuid>,
) -> RepoResult<Option<Value>> {
  use myoxus_domain::workspace_automation::{ContextDocumentWorkflowStage as Stage, ContextWorkflowResult as Result};
  let setup: bool =
    sqlx::query_scalar("SELECT accepted_json->'workspaceSetup' IS NOT NULL FROM workspace_automation_runs WHERE id=$1")
      .bind(fence.run_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(storage)?;
  if setup {
    return lock_setup_receipt_effect(tx, fence, stage, actor, workspace, request, fingerprint, doc_id).await;
  }
  let prior = lock_context_effect(tx, fence, stage).await?;
  let value: Value = sqlx::query_scalar("SELECT accepted_json FROM workspace_automation_runs WHERE id=$1")
    .bind(fence.run_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(storage)?;
  let accepted: AcceptedAutomationRun = serde_json::from_value(value).map_err(storage)?;
  let origin = accepted.confirmed_request.as_ref().ok_or_else(stale)?;
  if accepted.actor_id != Some(actor)
    || accepted.workspace_id != workspace
    || origin.request_id != request
    || origin.fingerprint != fingerprint
  {
    return Err(stale());
  }
  let receipt = crate::workspace::SqlxWorkspaceStore::context_receipt(tx, actor, workspace, request, Some(fingerprint))
    .await
    .map_err(storage)?
    .ok_or_else(stale)?;
  if receipt.run_id != Some(fence.run_id) {
    return Err(stale());
  }
  let reserved = match stage {
    Stage::CreateDocument { component } | Stage::PlaceDocument { component, .. } => Some(
      receipt
        .ids
        .documents
        .iter()
        .find(|ids| &ids.component_id == component)
        .ok_or_else(stale)?
        .doc_id,
    ),
    _ => None,
  };
  match stage {
    Stage::CreateDocument { .. } if doc_id != reserved => return Err(stale()),
    Stage::CreateDocument { .. } => {}
    _ if doc_id.is_some() => return Err(stale()),
    _ => {}
  }
  if let Some(value) = prior.as_ref() {
    let result: Result = serde_json::from_value(value.clone()).map_err(|_| stale())?;
    let valid = match (stage, result) {
      (Stage::Folder, Result::Folder { folder_id }) => {
        receipt.progress.folder_ready && folder_id == receipt.ids.folder_id
      }
      (
        Stage::CreateDocument { component },
        Result::Created {
          component: actual,
          doc_id,
        },
      ) => {
        actual == *component
          && Some(doc_id) == reserved
          && receipt
            .progress
            .documents
            .get(component)
            .is_some_and(|created| created.doc_id == doc_id)
      }
      (
        Stage::PlaceDocument { component, .. },
        Result::Placed {
          component: actual,
          doc_id,
        },
      ) => {
        actual == *component
          && Some(doc_id) == reserved
          && receipt
            .progress
            .documents
            .get(component)
            .is_some_and(|created| created.doc_id == doc_id && created.placed)
      }
      (Stage::Complete, Result::Complete) => receipt.progress.placement_complete,
      _ => false,
    };
    if !valid {
      return Err(stale());
    }
  }
  Ok(prior)
}

/// Native receipt progress and the effect ACK are committed by the same writer.
pub(crate) async fn acknowledge_context_effect(
  tx: &mut PgConnection,
  fence: &AutomationEffectFence,
  stage: &myoxus_domain::workspace_automation::ContextDocumentWorkflowStage,
) -> RepoResult<()> {
  use myoxus_domain::workspace_automation::{ContextDocumentWorkflowStage as Stage, ContextWorkflowResult as Result};
  let setup: bool =
    sqlx::query_scalar("SELECT accepted_json->'workspaceSetup' IS NOT NULL FROM workspace_automation_runs WHERE id=$1")
      .bind(fence.run_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(storage)?;
  if setup {
    return acknowledge_setup_effect(tx, fence, stage).await;
  }
  if lock_context_effect(tx, fence, stage).await?.is_some() {
    return Ok(());
  }
  let value: Value = sqlx::query_scalar("SELECT accepted_json FROM workspace_automation_runs WHERE id=$1")
    .bind(fence.run_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(storage)?;
  let accepted: AcceptedAutomationRun = serde_json::from_value(value).map_err(storage)?;
  let origin = accepted.confirmed_request.as_ref().ok_or_else(stale)?;
  let actor = accepted.actor_id.ok_or_else(stale)?;
  let receipt = crate::workspace::SqlxWorkspaceStore::context_receipt(
    tx,
    actor,
    accepted.workspace_id,
    origin.request_id,
    Some(&origin.fingerprint),
  )
  .await
  .map_err(storage)?
  .ok_or_else(stale)?;
  let result = match stage {
    Stage::Folder if receipt.progress.folder_ready => Result::Folder {
      folder_id: receipt.ids.folder_id,
    },
    Stage::CreateDocument { component } => {
      let created = receipt.progress.documents.get(component).ok_or_else(stale)?;
      Result::Created {
        component: component.clone(),
        doc_id: created.doc_id,
      }
    }
    Stage::PlaceDocument { component, .. } => {
      let created = receipt
        .progress
        .documents
        .get(component)
        .filter(|created| created.placed)
        .ok_or_else(stale)?;
      Result::Placed {
        component: component.clone(),
        doc_id: created.doc_id,
      }
    }
    Stage::Complete if receipt.progress.placement_complete => Result::Complete,
    _ => return Err(stale()),
  };
  acknowledge_runtime_effect(tx, fence, serde_json::to_value(result).map_err(storage)?).await
}

/// A Workspace setup shares its allocation key and native component identities.
/// Validate those before replay, as well as the live engine generation.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn lock_setup_receipt_effect(
  tx: &mut PgConnection,
  fence: &AutomationEffectFence,
  stage: &myoxus_domain::workspace_automation::ContextDocumentWorkflowStage,
  actor: uuid::Uuid,
  workspace: uuid::Uuid,
  request: uuid::Uuid,
  fingerprint: &str,
  doc_id: Option<uuid::Uuid>,
) -> RepoResult<Option<Value>> {
  use myoxus_domain::workspace_automation::{
    ContextDocumentWorkflowStage as Stage, WorkspaceSetupResult, WorkspaceSetupStageResult as Result,
  };
  let prior = lock_context_effect(tx, fence, stage).await?;
  let value: Value = sqlx::query_scalar("SELECT accepted_json FROM workspace_automation_runs WHERE id=$1")
    .bind(fence.run_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(storage)?;
  let run: AcceptedAutomationRun = serde_json::from_value(value).map_err(storage)?;
  let origin = run.workspace_setup.as_ref().ok_or_else(stale)?;
  if run.actor_id != Some(actor)
    || run.workspace_id != workspace
    || origin.request_id != request
    || origin.fingerprint != fingerprint
  {
    return Err(stale());
  }
  let receipt = crate::workspace::SqlxWorkspaceStore::setup_receipt(tx, actor, workspace, request, Some(fingerprint))
    .await
    .map_err(storage)?
    .ok_or_else(stale)?;
  if receipt.run_id != fence.run_id {
    return Err(stale());
  }
  match stage {
    Stage::CreateWorkingDocument { component }
      if receipt
        .reservations
        .iter()
        .find(|reserved| reserved.component_id == *component)
        .map(|reserved| reserved.result_id)
        != doc_id =>
    {
      return Err(stale());
    }
    Stage::CreateWorkingDocument { .. } => {}
    _ if doc_id.is_some() => return Err(stale()),
    _ => {}
  }
  if let Some(value) = &prior {
    let result: Result = serde_json::from_value(value.clone()).map_err(|_| stale())?;
    let valid = match (stage, result) {
      (Stage::Folder, Result::Folder { folder_id }) => {
        receipt.document_progress.folder_ready && receipt.folder_id.as_ref() == Some(&folder_id)
      }
      (Stage::Complete, Result::Complete) => {
        receipt.document_progress.placement_complete
          && receipt.state == myoxus_application::workspace::ProjectStarterState::Complete
      }
      (
        Stage::CreateDatabaseFromDefinition { component }
        | Stage::CreateWorkingDocument { component }
        | Stage::PlaceNativeLink { component },
        Result::Component { component_id, result },
      ) => {
        component == &component_id
          && receipt
            .progress
            .results
            .get(component)
            .is_some_and(|expected| serde_json::to_value(expected).ok() == serde_json::to_value(&result).ok())
          && matches!(
            (stage, &result),
            (
              Stage::CreateDatabaseFromDefinition { .. },
              WorkspaceSetupResult::Database { .. }
            ) | (
              Stage::CreateWorkingDocument { .. },
              WorkspaceSetupResult::Document { .. }
            ) | (Stage::PlaceNativeLink { .. }, WorkspaceSetupResult::NativeLink { .. })
          )
      }
      _ => false,
    };
    if !valid {
      return Err(stale());
    }
  }
  Ok(prior)
}

pub(crate) async fn acknowledge_setup_effect(
  tx: &mut PgConnection,
  fence: &AutomationEffectFence,
  stage: &myoxus_domain::workspace_automation::ContextDocumentWorkflowStage,
) -> RepoResult<()> {
  use myoxus_domain::workspace_automation::{
    ContextDocumentWorkflowStage as Stage, WorkspaceSetupStageResult as Result,
  };
  let run: Value = sqlx::query_scalar("SELECT accepted_json FROM workspace_automation_runs WHERE id=$1")
    .bind(fence.run_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(storage)?;
  let run: AcceptedAutomationRun = serde_json::from_value(run).map_err(storage)?;
  let origin = run.workspace_setup.as_ref().ok_or_else(stale)?;
  let receipt = crate::workspace::SqlxWorkspaceStore::setup_receipt(
    tx,
    run.actor_id.ok_or_else(stale)?,
    run.workspace_id,
    origin.request_id,
    Some(&origin.fingerprint),
  )
  .await
  .map_err(storage)?
  .ok_or_else(stale)?;
  let doc = match stage {
    Stage::CreateWorkingDocument { component } => receipt
      .reservations
      .iter()
      .find(|reserved| reserved.component_id == *component)
      .map(|reserved| reserved.result_id),
    _ => None,
  };
  if lock_setup_receipt_effect(
    tx,
    fence,
    stage,
    receipt.actor_id,
    receipt.workspace_id,
    receipt.request_id,
    &receipt.fingerprint,
    doc,
  )
  .await?
  .is_some()
  {
    return Ok(());
  }
  let result = match stage {
    Stage::Folder if receipt.document_progress.folder_ready => Result::Folder {
      folder_id: receipt.folder_id.ok_or_else(stale)?,
    },
    Stage::CreateWorkingDocument { component }
    | Stage::CreateDatabaseFromDefinition { component }
    | Stage::PlaceNativeLink { component } => Result::Component {
      component_id: component.clone(),
      result: receipt.progress.results.get(component).ok_or_else(stale)?.clone(),
    },
    Stage::Complete if receipt.document_progress.placement_complete => Result::Complete,
    _ => return Err(stale()),
  };
  acknowledge_runtime_effect(tx, fence, serde_json::to_value(result).map_err(storage)?).await
}
