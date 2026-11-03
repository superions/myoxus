// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! PostgreSQL repository for server-owned Workspace Automations.
//!
//! JSON is intentionally contained at this boundary: trigger/action/event
//! payloads are stored as JSONB, while application code receives typed domain
//! structs.

mod task_events;

use std::str::FromStr;
use uuid::Uuid;

use async_trait::async_trait;
#[cfg(test)]
use hmac::{Hmac, Mac};
use myoxus_application::workspace_automation::webhook::{
  WorkspaceAutomationWebhookError, WorkspaceAutomationWebhookPort, WorkspaceAutomationWebhookRequest,
  WorkspaceAutomationWebhookResponse,
};
use myoxus_domain::repositories::{PageRequest, RepoResult, RepositoryError, WorkspaceAutomationRepository};
use myoxus_domain::workspace_automation::{
  WorkspaceAutomation, WorkspaceAutomationActionDefinition, WorkspaceAutomationRun, WorkspaceAutomationRunStatus,
  WorkspaceAutomationStatus, WorkspaceAutomationTrigger, WorkspaceAutomationTriggerEvent,
};
use sqlx::{PgPool, Row};
use tokio::time::Duration;

#[cfg(test)]
type HmacSha256 = Hmac<sha2::Sha256>;

#[derive(Clone)]
pub struct PgWorkspaceAutomationRepository {
  pool: PgPool,
  database_templates: Option<std::sync::Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>>,
}

impl PgWorkspaceAutomationRepository {
  pub fn new(pool: PgPool) -> Self {
    Self {
      pool,
      database_templates: None,
    }
  }

  pub fn with_database_templates(
    mut self,
    catalog: std::sync::Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
  ) -> Self {
    self.database_templates = Some(catalog);
    self
  }

  async fn capture_maintenance_admission(&self, tx: &mut sqlx::PgConnection) -> RepoResult<()> {
    let catalog = self
      .database_templates
      .as_deref()
      .ok_or_else(|| RepositoryError::Validation("native Task maintenance catalog unavailable".into()))?;
    crate::workspace_database::PgDatabaseRepository::capture_catalog_admission(tx, catalog).await
  }

  // Caller-owned effect transactions must carry this node's catalog just like
  // Database begin_write. Accepted installation facts are not an admission list.
  async fn capture_run_maintenance_admission(&self, tx: &mut sqlx::PgConnection, run: Uuid) -> RepoResult<()> {
    let maintenance: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_automation_runs WHERE id=$1 AND accepted_json->'taskMaintenance' IS NOT NULL)")
      .bind(run).fetch_one(&mut *tx).await.map_err(Self::storage_error)?;
    if maintenance {
      self.capture_maintenance_admission(tx).await?;
    }
    Ok(())
  }

  fn storage_error(error: impl std::fmt::Display) -> RepositoryError {
    RepositoryError::Storage(error.to_string())
  }

  /// Native expiry also releases a changed metadata deadline when a retryable
  /// Run failed before parking at the engine wait. Caller holds the native Run.
  pub(crate) async fn expire_document_review_in(
    conn: &mut sqlx::PgConnection,
    run: Uuid,
    now: chrono::DateTime<chrono::Utc>,
  ) -> RepoResult<bool> {
    let result=sqlx::query("UPDATE workspace_automation_runs SET review_expired_at=$2,error_code='MIX_AUTOMATION_RUN_NOT_RETRYABLE',execution_generation=execution_generation+1,claim_owner=NULL WHERE id=$1 AND origin_kind='document_review' AND review_outcome_json IS NULL AND review_invalid_reason IS NULL AND review_expired_at IS NULL AND status<>'skipped' AND review_deadline_at<=$2")
      .bind(run).bind(now).execute(conn).await.map_err(Self::storage_error)?;
    Ok(result.rows_affected() == 1)
  }

  /// Native acceptance participates in the caller's slot/Run/snapshot commit.
  /// Replay returns the persisted frozen identity, never the losing proposal.
  pub(crate) async fn accept_document_review_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    accepted: &myoxus_domain::workspace_automation::AcceptedAutomationRun,
  ) -> RepoResult<WorkspaceAutomationRun> {
    // Rejected accepted_json rows can include document content and answers.
    // This boundary must not retain PostgreSQL DETAIL in errors or spans.
    fn storage(error: impl std::error::Error + 'static) -> RepositoryError {
      let error = &error as &dyn std::error::Error;
      let metadata = match error.downcast_ref::<sqlx::Error>() {
        Some(sqlx::Error::Database(error)) => format!(
          "sqlstate={} constraint={}",
          error.code().as_deref().unwrap_or("unknown"),
          error.constraint().unwrap_or("none")
        ),
        Some(_) => "databaseTransport".into(),
        None => "typedDecode".into(),
      };
      RepositoryError::Storage(format!("review admission: {metadata}"))
    }
    let review = accepted
      .document_review
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("review acceptance missing".into()))?;
    let actor = accepted
      .actor_id
      .ok_or_else(|| RepositoryError::Validation("review actor missing".into()))?;
    if actor != review.plan.actor_id
      || accepted.workspace_id != review.plan.workspace_id
      || accepted.confirmed_request.is_some()
      || accepted.automation_id.is_some()
      || accepted.trigger.is_some()
      || accepted.recurring_task.is_some()
      || accepted.workspace_setup.is_some()
      || accepted.task_handover.is_some()
      || accepted.task_maintenance.is_some()
      || accepted.personal_rule.is_some()
    {
      return Err(RepositoryError::Validation("review acceptance mismatch".into()));
    }
    crate::workflow_runtime::effects::lock_runtime_authority(tx, actor, accepted.workspace_id, false).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(format!(
        "document-review:{actor}:{}:{}",
        accepted.workspace_id, review.request_id
      ))
      .execute(&mut **tx)
      .await
      .map_err(storage)?;
    if let Some(row)=sqlx::query("SELECT * FROM workspace_automation_runs WHERE review_actor_id=$1 AND workspace_id=$2 AND review_request_id=$3 FOR UPDATE").bind(actor).bind(accepted.workspace_id).bind(review.request_id).fetch_optional(&mut **tx).await.map_err(storage)?{
      let run=Self::map_run(row)?;
      if run.idempotency_key!=review.fingerprint{return Err(RepositoryError::Conflict("review request input"))}
      return Ok(run);
    }
    let member: Option<bool> = sqlx::query_scalar(
      "SELECT true FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='Accepted' FOR SHARE",
    )
    .bind(accepted.workspace_id)
    .bind(review.plan.reviewer_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(storage)?;
    if member != Some(true) || review.plan.deadline_at <= chrono::Utc::now() {
      return Err(RepositoryError::Validation(
        "review admission expired or reviewer unavailable".into(),
      ));
    }
    let revision = crate::doc::SqlxDocStore::review_source_revision_in_tx(
      tx,
      accepted.workspace_id,
      review.plan.source_document_id,
      &review.plan.source_external_id,
    )
    .await
    .map_err(|error| match error {
      myoxus_application::auth::AuthError::Storage(_) => {
        RepositoryError::Storage("review source storage unavailable".into())
      }
      _ => RepositoryError::Validation("review source unavailable".into()),
    })?;
    if revision != review.plan.source_revision {
      return Err(RepositoryError::Validation("review source revision changed".into()));
    }
    let now: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
      .fetch_one(&mut **tx)
      .await
      .map_err(storage)?;
    if now >= review.plan.deadline_at {
      return Err(RepositoryError::Validation("review admission expired".into()));
    }
    let occurrence = review.plan.source_metadata_deadline.map(|deadline| {
      myoxus_domain::scheduling::document_review_occurrence_id(review.plan.source_document_id, deadline)
    });
    if let (Some(occurrence), Some(deadline)) = (occurrence, review.plan.source_metadata_deadline) {
      let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduling_occurrences o JOIN scheduling_schedules s ON s.id=o.schedule_id WHERE o.id=$1 AND o.nominal_due_at=$2 AND o.generation=s.generation AND s.workspace_id=$3 AND s.actor_id=$4 AND s.lifecycle='active' AND s.target_json->>'kind'='document_review' AND s.target_json->>'document_id'=$5 AND s.target_json->>'enabled'='true')")
        .bind(occurrence).bind(deadline).bind(accepted.workspace_id).bind(actor).bind(review.plan.source_document_id.to_string()).fetch_one(&mut **tx).await.map_err(storage)?;
      if !valid {
        return Err(RepositoryError::Validation("review cycle receipt unavailable".into()));
      }
      let generation: Option<i64> = sqlx::query_scalar("SELECT generation FROM scheduling_occurrences WHERE id=$1")
        .bind(occurrence)
        .fetch_optional(&mut **tx)
        .await
        .map_err(storage)?;
      if generation != review.scheduling_generation {
        return Err(RepositoryError::Validation("review cycle generation mismatch".into()));
      }
    } else if review.scheduling_generation.is_some() {
      return Err(RepositoryError::Validation(
        "manual review carries a scheduling generation".into(),
      ));
    }
    let row=sqlx::query("INSERT INTO workspace_automation_runs(id,workspace_id,origin_kind,review_actor_id,review_request_id,review_task_id,review_follow_up_id,review_wait_id,review_deadline_at,idempotency_key,status,accepted_json,scheduling_occurrence_id) VALUES($1,$2,'document_review',$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11) RETURNING *")
      .bind(accepted.run_id).bind(accepted.workspace_id).bind(actor).bind(review.request_id).bind(review.review_task_id).bind(review.follow_up_task_id).bind(&review.wait_id).bind(review.plan.deadline_at).bind(&review.fingerprint).bind(serde_json::to_value(accepted).map_err(storage)?).bind(occurrence).fetch_one(&mut **tx).await.map_err(storage)?;
    Self::map_run(row)
  }

  fn parse_enum<T: FromStr>(value: String, label: &'static str) -> RepoResult<T> {
    value
      .parse::<T>()
      .map_err(|_| RepositoryError::Validation(format!("invalid workspace automation {label}: {value}")))
  }

  fn map_automation(row: sqlx::postgres::PgRow) -> RepoResult<WorkspaceAutomation> {
    let status =
      Self::parse_enum::<WorkspaceAutomationStatus>(row.try_get("status").map_err(Self::storage_error)?, "status")?;
    let trigger_json: serde_json::Value = row.try_get("trigger_json").map_err(Self::storage_error)?;
    let actions_json: serde_json::Value = row.try_get("actions_json").map_err(Self::storage_error)?;
    Ok(WorkspaceAutomation {
      id: row.try_get("id").map_err(Self::storage_error)?,
      workspace_id: row.try_get("workspace_id").map_err(Self::storage_error)?,
      name: row.try_get("name").map_err(Self::storage_error)?,
      description: row.try_get("description").map_err(Self::storage_error)?,
      status,
      trigger: serde_json::from_value::<WorkspaceAutomationTrigger>(trigger_json)
        .map_err(|err| RepositoryError::Validation(format!("invalid workspace automation trigger json: {err}")))?,
      personal_config: row
        .try_get::<Option<serde_json::Value>, _>("personal_config")
        .map_err(Self::storage_error)?
        .map(serde_json::from_value)
        .transpose()
        .map_err(Self::storage_error)?,
      execution_revision: row.try_get("execution_revision").map_err(Self::storage_error)?,
      actions: serde_json::from_value::<Vec<WorkspaceAutomationActionDefinition>>(actions_json)
        .map_err(|err| RepositoryError::Validation(format!("invalid workspace automation actions json: {err}")))?,
      created_by: row.try_get("created_by").map_err(Self::storage_error)?,
      updated_by: row.try_get("updated_by").map_err(Self::storage_error)?,
      created_at: row.try_get("created_at").map_err(Self::storage_error)?,
      updated_at: row.try_get("updated_at").map_err(Self::storage_error)?,
    })
  }

  pub(crate) fn map_run(row: sqlx::postgres::PgRow) -> RepoResult<WorkspaceAutomationRun> {
    let raw: Option<serde_json::Value> = row.try_get("accepted_json").map_err(Self::storage_error)?;
    let (accepted, unavailable): (Option<myoxus_domain::workspace_automation::AcceptedAutomationRun>, bool) = match raw
    {
      Some(value) => match serde_json::from_value(value) {
        Ok(value) => (Some(value), false),
        Err(_) => (None, true),
      },
      None => (None, false),
    };
    Ok(WorkspaceAutomationRun {
      id: row.try_get("id").map_err(Self::storage_error)?,
      job_id: row.try_get("job_id").map_err(Self::storage_error)?,
      origin: match row
        .try_get::<String, _>("origin_kind")
        .map_err(Self::storage_error)?
        .as_str()
      {
        "rule" => myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::Rule,
        "recurring_task" => {
          let task = accepted
            .as_ref()
            .and_then(|run| run.recurring_task.as_ref())
            .ok_or_else(|| RepositoryError::Validation("recurring Task acceptance unavailable".into()))?;
          if row
            .try_get::<Option<Uuid>, _>("scheduling_occurrence_id")
            .map_err(Self::storage_error)?
            != Some(task.occurrence_id)
            || accepted.as_ref().and_then(|run| run.actor_id)
              != row.try_get("confirmed_actor_id").map_err(Self::storage_error)?
          {
            return Err(RepositoryError::Validation("recurring Task acceptance mismatch".into()));
          }
          myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::RecurringTask {
            schedule_id: task.schedule_id,
            occurrence_id: task.occurrence_id,
          }
        }
        "task_maintenance" => {
          let request_id: Uuid = row.try_get("confirmed_request_id").map_err(Self::storage_error)?;
          let fingerprint: String = row.try_get("idempotency_key").map_err(Self::storage_error)?;
          let facts = accepted
            .as_ref()
            .and_then(|run| run.task_maintenance.as_ref())
            .ok_or_else(|| RepositoryError::Validation("correction acceptance unavailable".into()))?;
          if facts.request_id != request_id
            || facts.fingerprint != fingerprint
            || accepted.as_ref().and_then(|run| run.actor_id)
              != row.try_get("confirmed_actor_id").map_err(Self::storage_error)?
          {
            return Err(RepositoryError::Validation("correction request mismatch".into()));
          }
          myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::TaskMaintenance {
            request_id,
            fingerprint,
          }
        }
        "task_handover" => {
          let request_id: Uuid = row.try_get("confirmed_request_id").map_err(Self::storage_error)?;
          let fingerprint: String = row.try_get("idempotency_key").map_err(Self::storage_error)?;
          let facts = accepted
            .as_ref()
            .and_then(|run| run.task_handover.as_ref())
            .ok_or_else(|| RepositoryError::Validation("handover acceptance unavailable".into()))?;
          if facts.request_id != request_id
            || facts.fingerprint != fingerprint
            || accepted.as_ref().and_then(|run| run.actor_id)
              != row.try_get("confirmed_actor_id").map_err(Self::storage_error)?
          {
            return Err(RepositoryError::Validation("handover request mismatch".into()));
          }
          myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::TaskHandover {
            request_id,
            fingerprint,
          }
        }
        "document_review" => {
          let request_id: uuid::Uuid = row.try_get("review_request_id").map_err(Self::storage_error)?;
          let fingerprint: String = row.try_get("idempotency_key").map_err(Self::storage_error)?;
          if let Some(run) = &accepted {
            let review = run
              .document_review
              .as_ref()
              .ok_or_else(|| RepositoryError::Validation("review acceptance unavailable".into()))?;
            if review.request_id != request_id
              || review.fingerprint != fingerprint
              || run.actor_id != row.try_get("review_actor_id").map_err(Self::storage_error)?
              || review.review_task_id
                != row
                  .try_get::<uuid::Uuid, _>("review_task_id")
                  .map_err(Self::storage_error)?
              || review.follow_up_task_id
                != row
                  .try_get::<uuid::Uuid, _>("review_follow_up_id")
                  .map_err(Self::storage_error)?
            {
              return Err(RepositoryError::Validation("review identity mismatch".into()));
            }
          }
          myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::DocumentReview {
            request_id,
            fingerprint,
          }
        }
        "workspace_setup" => {
          let request_id: uuid::Uuid = row.try_get("confirmed_request_id").map_err(Self::storage_error)?;
          let fingerprint: String = row.try_get("idempotency_key").map_err(Self::storage_error)?;
          let owner: uuid::Uuid = row.try_get("confirmed_actor_id").map_err(Self::storage_error)?;
          let run = accepted
            .as_ref()
            .ok_or_else(|| RepositoryError::Validation("Workspace setup acceptance missing".into()))?;
          if run.actor_id != Some(owner)
            || run.automation_id.is_some()
            || run.trigger.is_some()
            || !run
              .workspace_setup
              .as_ref()
              .is_some_and(|origin| origin.request_id == request_id && origin.fingerprint == fingerprint)
          {
            return Err(RepositoryError::Validation(
              "Workspace setup acceptance mismatch".into(),
            ));
          }
          myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::WorkspaceSetup {
            request_id,
            fingerprint,
          }
        }
        "confirmed_context_documents" => {
          let request_id: uuid::Uuid = row.try_get("confirmed_request_id").map_err(Self::storage_error)?;
          let fingerprint: String = row.try_get("idempotency_key").map_err(Self::storage_error)?;
          if let Some(accepted) = &accepted {
            let origin = accepted
              .confirmed_request
              .as_ref()
              .ok_or_else(|| RepositoryError::Validation("confirmed workflow origin unavailable".into()))?;
            let owner: uuid::Uuid = row.try_get("confirmed_actor_id").map_err(Self::storage_error)?;
            if origin.request_id != request_id
              || origin.fingerprint != fingerprint
              || accepted.actor_id != Some(owner)
              || accepted.automation_id.is_some()
              || accepted.trigger.is_some()
            {
              return Err(RepositoryError::Validation("confirmed workflow origin mismatch".into()));
            }
          }
          myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::ConfirmedContextDocuments {
            request_id,
            fingerprint,
          }
        }
        _ => return Err(RepositoryError::Validation("invalid automation origin".into())),
      },
      automation_id: row.try_get("automation_id").map_err(Self::storage_error)?,
      workspace_id: row.try_get("workspace_id").map_err(Self::storage_error)?,
      trigger_type: row
        .try_get::<Option<String>, _>("trigger_type")
        .map_err(Self::storage_error)?
        .map(|value| Self::parse_enum(value, "trigger type"))
        .transpose()?,
      trigger_event: row
        .try_get::<Option<serde_json::Value>, _>("trigger_event_json")
        .map_err(Self::storage_error)?
        .map(serde_json::from_value::<WorkspaceAutomationTriggerEvent>)
        .transpose()
        .map_err(Self::storage_error)?,
      accepted,
      execution_generation: row.try_get("execution_generation").map_err(Self::storage_error)?,
      idempotency_key: row.try_get("idempotency_key").map_err(Self::storage_error)?,
      status: if unavailable {
        WorkspaceAutomationRunStatus::Failed
      } else {
        Self::parse_enum(row.try_get("status").map_err(Self::storage_error)?, "run status")?
      },
      attempt_count: row.try_get("attempt_count").map_err(Self::storage_error)?,
      error_code: if unavailable {
        Some("MIX_AUTOMATION_INPUTS_UNAVAILABLE".into())
      } else {
        row.try_get("error_code").map_err(Self::storage_error)?
      },
      error_message: row.try_get("error_message").map_err(Self::storage_error)?,
      dead_letter: row.try_get("dead_letter").map_err(Self::storage_error)?,
      queued_at: row.try_get("queued_at").map_err(Self::storage_error)?,
      started_at: row.try_get("started_at").map_err(Self::storage_error)?,
      finished_at: row.try_get("finished_at").map_err(Self::storage_error)?,
    })
  }

  pub(crate) async fn stop_personal_runs_in_tx(tx: &mut sqlx::PgConnection, rule: Uuid) -> RepoResult<()> {
    let runs:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM workspace_automation_runs WHERE automation_id=$1 AND status IN ('queued','running','failed','dead_letter') ORDER BY id")
      .bind(rule).fetch_all(&mut *tx).await.map_err(Self::storage_error)?;
    let instances = runs.iter().map(ToString::to_string).collect::<Vec<_>>();
    sqlx::query(
      "SELECT instance_id FROM sayiir_workflow_claims WHERE instance_id=ANY($1) ORDER BY instance_id FOR UPDATE NOWAIT",
    )
    .bind(&instances)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::storage_error)?;
    sqlx::query("SELECT id FROM workspace_automation_runs WHERE id=ANY($1) ORDER BY id FOR UPDATE NOWAIT")
      .bind(&runs)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::storage_error)?;
    sqlx::query("UPDATE workspace_automation_runs SET execution_generation=execution_generation+1,claim_owner=NULL,status='skipped',error_code='MIX_AUTOMATION_RUN_NOT_RETRYABLE',error_message=NULL,dead_letter=false,finished_at=now() WHERE id=ANY($1)")
      .bind(&runs).execute(&mut *tx).await.map_err(Self::storage_error)?;
    // Only these stopped personal Runs wake the existing parked-wait scheduler.
    sqlx::query("UPDATE sayiir_workflow_snapshots SET delay_wake_at=clock_timestamp() WHERE instance_id=ANY($1) AND signal_name IS NOT NULL")
      .bind(&instances).execute(&mut *tx).await.map_err(Self::storage_error)?;
    Ok(())
  }

  fn map_effect(
    row: sqlx::postgres::PgRow,
  ) -> RepoResult<myoxus_domain::workspace_automation::WorkspaceAutomationEffectReceipt> {
    Ok(myoxus_domain::workspace_automation::WorkspaceAutomationEffectReceipt {
      action_id: row.try_get("id").map_err(Self::storage_error)?,
      run_id: row.try_get("run_id").map_err(Self::storage_error)?,
      position: row.try_get("position").map_err(Self::storage_error)?,
      node_key: row.try_get("node_key").map_err(Self::storage_error)?,
      effect_key: row.try_get("effect_key").map_err(Self::storage_error)?,
      input_fingerprint: row.try_get("input_fingerprint").map_err(Self::storage_error)?,
      reserved_id: row.try_get("reserved_id").map_err(Self::storage_error)?,
      expected_edit_revision: row.try_get("expected_edit_revision").map_err(Self::storage_error)?,
      status: Self::parse_enum(row.try_get("status").map_err(Self::storage_error)?, "effect status")?,
      result_json: row.try_get("result_json").map_err(Self::storage_error)?,
    })
  }

  async fn assert_webhook_effect(
    connection: &mut sqlx::PgConnection,
    fence: &myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> RepoResult<()> {
    let accepted: serde_json::Value =
      sqlx::query_scalar("SELECT accepted_json FROM workspace_automation_runs WHERE id=$1")
        .bind(fence.run_id)
        .fetch_one(&mut *connection)
        .await
        .map_err(Self::storage_error)?;
    let accepted: myoxus_domain::workspace_automation::AcceptedAutomationRun =
      serde_json::from_value(accepted).map_err(Self::storage_error)?;
    let position: i32 =
      sqlx::query_scalar("SELECT position FROM workspace_automation_actions WHERE id=$1 AND run_id=$2")
        .bind(fence.action_id)
        .bind(fence.run_id)
        .fetch_one(&mut *connection)
        .await
        .map_err(Self::storage_error)?;
    if !accepted.definition.actions.iter().any(|action| {
      action.position == position
        && matches!(
          &action.config,
          myoxus_domain::workspace_automation::WorkspaceAutomationActionConfig::NotifyWebhook { .. }
        )
    }) {
      return Err(RepositoryError::Validation("invalid webhook effect".into()));
    }
    Ok(())
  }
}

#[derive(Clone)]
pub struct ReqwestWorkspaceAutomationWebhookClient {
  client: reqwest::Client,
}

impl ReqwestWorkspaceAutomationWebhookClient {
  pub fn new(client: reqwest::Client) -> Self {
    Self { client }
  }
}

#[async_trait]
impl WorkspaceAutomationWebhookPort for ReqwestWorkspaceAutomationWebhookClient {
  async fn deliver(
    &self,
    request: WorkspaceAutomationWebhookRequest,
  ) -> Result<WorkspaceAutomationWebhookResponse, WorkspaceAutomationWebhookError> {
    // Each admitted native effect attempt performs exactly one HTTP request.
    // Sayiir owns retries; transport failures must not expose URL or payload.
    let mut builder = self
      .client
      .post(&request.url)
      .timeout(Duration::from_secs(request.timeout_seconds.max(1)))
      .header(reqwest::header::CONTENT_TYPE, "application/json")
      .header("x-myoxus-timestamp", request.timestamp.to_string())
      .header("x-myoxus-delivery", &request.delivery_id);
    if let Some(signature) = &request.signature {
      builder = builder.header("x-myoxus-signature", signature);
    }
    let response = builder
      .body(request.body)
      .send()
      .await
      .map_err(|_| WorkspaceAutomationWebhookError::new(None, "webhook request failed"))?;
    let status = response.status();
    if !status.is_success() {
      return Err(WorkspaceAutomationWebhookError::new(
        Some(status.as_u16()),
        "non-success webhook response",
      ));
    }
    Ok(WorkspaceAutomationWebhookResponse {
      status: status.as_u16(),
    })
  }
}

#[cfg(test)]
fn sign_webhook(secret: &str, timestamp: i64, body: &[u8]) -> String {
  let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
  mac.update(timestamp.to_string().as_bytes());
  mac.update(b".");
  mac.update(body);
  format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
  use std::sync::{Arc, Mutex};

  use myoxus_application::workspace_automation::webhook::{
    WorkspaceAutomationWebhookPayload, WorkspaceAutomationWebhookPort, WorkspaceAutomationWebhookRequest,
  };
  use tokio::io::{AsyncReadExt, AsyncWriteExt};
  use tokio::net::TcpListener;

  use super::{ReqwestWorkspaceAutomationWebhookClient, sign_webhook};

  #[tokio::test]
  async fn workspace_automation_webhook_single_attempt_and_signs_delivery() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind webhook stub");
    let url = format!("http://{}", listener.local_addr().expect("stub addr"));
    let seen = Arc::new(Mutex::new(Vec::<(String, Vec<u8>)>::new()));
    let server_seen = seen.clone();
    let server = tokio::spawn(async move {
      {
        let (mut socket, _) = listener.accept().await.expect("accept webhook request");
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        let header_end = loop {
          let read = socket.read(&mut chunk).await.expect("read request");
          assert!(read > 0, "client closed before headers");
          buffer.extend_from_slice(&chunk[..read]);
          if let Some(pos) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break pos + 4;
          }
        };
        let headers = String::from_utf8_lossy(&buffer[..header_end]).to_string();
        let content_length = headers
          .lines()
          .find_map(|line| {
            line
              .strip_prefix("content-length:")
              .or_else(|| line.strip_prefix("Content-Length:"))
              .and_then(|raw| raw.trim().parse::<usize>().ok())
          })
          .expect("content length header");
        while buffer.len() < header_end + content_length {
          let read = socket.read(&mut chunk).await.expect("read body");
          assert!(read > 0, "client closed before body");
          buffer.extend_from_slice(&chunk[..read]);
        }
        let body = buffer[header_end..header_end + content_length].to_vec();
        server_seen.lock().expect("seen lock").push((headers, body));
        let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
        socket.write_all(response.as_bytes()).await.expect("write response");
      }
    });

    let client = ReqwestWorkspaceAutomationWebhookClient::new(reqwest::Client::new());
    let response = client
      .deliver(
        WorkspaceAutomationWebhookRequest::new(
          url,
          WorkspaceAutomationWebhookPayload {
            workspace_id: "workspace".into(),
            automation_id: "automation".into(),
            run_id: "run".into(),
            action_id: "action".into(),
            trigger_type: "row_created".into(),
            event: serde_json::json!({ "rowId": "row" }),
          },
          Some("automation-webhook-secret".into()),
          2,
        )
        .expect("prepare signed webhook"),
      )
      .await
      .expect("webhook succeeds in one attempt");
    server.await.expect("server task");

    assert_eq!(response.status, 204);
    let seen = seen.lock().expect("seen lock");
    assert_eq!(seen.len(), 1);
    let (headers, body) = seen.last().expect("single request");
    let timestamp = headers
      .lines()
      .find_map(|line| line.strip_prefix("x-myoxus-timestamp:"))
      .expect("timestamp header")
      .trim()
      .parse::<i64>()
      .expect("timestamp value");
    let signature = headers
      .lines()
      .find_map(|line| line.strip_prefix("x-myoxus-signature:"))
      .expect("signature header")
      .trim();
    assert_eq!(signature, sign_webhook("automation-webhook-secret", timestamp, body));
  }
}

#[async_trait]
impl WorkspaceAutomationRepository for PgWorkspaceAutomationRepository {
  async fn get_rule_run(&self, workspace: Uuid, rule: Uuid, key: &str) -> RepoResult<Option<WorkspaceAutomationRun>> {
    sqlx::query(
      "SELECT * FROM workspace_automation_runs WHERE workspace_id=$1 AND automation_id=$2 AND idempotency_key=$3",
    )
    .bind(workspace)
    .bind(rule)
    .bind(key)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage_error)?
    .map(Self::map_run)
    .transpose()
  }
  async fn get_personal_automation(
    &self,
    actor: Uuid,
    workspace: Uuid,
    database: Uuid,
    trigger: myoxus_domain::workspace_automation::WorkspaceAutomationTriggerType,
  ) -> RepoResult<Option<WorkspaceAutomation>> {
    sqlx::query("SELECT * FROM workspace_automations WHERE workspace_id=$1 AND personal_config->>'actorId'=$2 AND personal_config->>'databaseId'=$3 AND trigger_type=$4")
      .bind(workspace).bind(actor.to_string()).bind(database.to_string()).bind(trigger.as_str()).fetch_optional(&self.pool).await.map_err(Self::storage_error)?.map(Self::map_automation).transpose()
  }
  async fn configure_personal_automation(
    &self,
    rule: WorkspaceAutomation,
    expected_execution_revision: Option<i64>,
  ) -> RepoResult<WorkspaceAutomation> {
    let config = rule
      .personal_config
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("personal configuration unavailable".into()))?;
    if rule.created_by != Some(config.actor_id)
      || rule.updated_by != Some(config.actor_id)
      || rule.trigger.database_id != config.database_id
    {
      return Err(RepositoryError::Validation(
        "personal configuration scope changed".into(),
      ));
    }
    let mut tx = self.pool.begin().await.map_err(Self::storage_error)?;
    crate::workflow_runtime::effects::lock_runtime_authority(&mut tx, config.actor_id, rule.workspace_id, false)
      .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(format!(
        "personal-automation:{}:{}:{}",
        config.actor_id,
        config.database_id,
        rule.trigger.trigger_type.as_str()
      ))
      .execute(&mut *tx)
      .await
      .map_err(Self::storage_error)?;
    let existing=sqlx::query("SELECT * FROM workspace_automations WHERE workspace_id=$1 AND personal_config->>'actorId'=$2 AND personal_config->>'databaseId'=$3 AND trigger_type=$4 FOR UPDATE")
      .bind(rule.workspace_id).bind(config.actor_id.to_string()).bind(config.database_id.to_string()).bind(rule.trigger.trigger_type.as_str()).fetch_optional(&mut *tx).await.map_err(Self::storage_error)?.map(Self::map_automation).transpose()?;
    let actions = serde_json::to_value(&rule.actions).map_err(Self::storage_error)?;
    let personal = serde_json::to_value(config).map_err(Self::storage_error)?;
    if rule.status == WorkspaceAutomationStatus::Enabled {
      let assistance = crate::auth::SqlxAuthStore::personal_assistance_in_tx(
        &mut tx,
        config.actor_id,
        rule.workspace_id,
        config.database_id,
      )
      .await
      .map_err(Self::storage_error)?;
      if assistance.mode != myoxus_application::auth::AssistanceMode::Automatic {
        return Err(RepositoryError::Validation(
          "personal preparation requires confirmed Automatic mode".into(),
        ));
      }
      for action in &rule.actions {
        if let myoxus_domain::workspace_automation::WorkspaceAutomationActionConfig::CreateLinkedDocument {
          source: Some(source),
          ..
        } = &action.config
        {
          crate::template_registry::SqlxTemplateRegistryStore::lock_automation_source_in_tx(
            &mut tx,
            source,
            config.client_version,
            true,
          )
          .await
          .map_err(Self::storage_error)?;
        }
      }
    }
    if let Some(existing) = &existing {
      let identical = existing.status == rule.status
        && serde_json::to_value(&existing.personal_config).map_err(Self::storage_error)?
          == serde_json::to_value(&rule.personal_config).map_err(Self::storage_error)?
        && serde_json::to_value(&existing.actions).map_err(Self::storage_error)? == actions;
      // Even an unchanged revisioned command fences older in-flight intent.
      // Only initial, unrevisioned response-loss replay keeps the generation.
      if identical && expected_execution_revision.is_none() {
        tx.commit().await.map_err(Self::storage_error)?;
        return Ok(existing.clone());
      }
      if existing.id != rule.id || expected_execution_revision != Some(existing.execution_revision) {
        return Err(RepositoryError::Conflict("personal configuration revision changed"));
      }
    } else if expected_execution_revision.is_some() {
      return Err(RepositoryError::Conflict("personal configuration unavailable"));
    }
    if let Some(existing) = &existing {
      Self::stop_personal_runs_in_tx(&mut tx, existing.id).await?;
    }
    let row = if let Some(existing) = existing {
      sqlx::query("UPDATE workspace_automations SET status=$2,trigger_json=$3,actions_json=$4,personal_config=$5,execution_revision=execution_revision+1,updated_by=$6,updated_at=now() WHERE id=$1 RETURNING *")
        .bind(existing.id).bind(rule.status.as_str()).bind(serde_json::to_value(&rule.trigger).map_err(Self::storage_error)?).bind(actions).bind(personal).bind(config.actor_id).fetch_one(&mut *tx).await.map_err(Self::storage_error)?
    } else {
      sqlx::query("INSERT INTO workspace_automations(id,workspace_id,name,description,status,trigger_type,trigger_json,actions_json,created_by,updated_by,created_at,updated_at,personal_config) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,now(),now(),$10) RETURNING *")
        .bind(rule.id).bind(rule.workspace_id).bind(rule.name).bind(rule.description).bind(rule.status.as_str()).bind(rule.trigger.trigger_type.as_str()).bind(serde_json::to_value(&rule.trigger).map_err(Self::storage_error)?).bind(actions).bind(config.actor_id).bind(personal).fetch_one(&mut *tx).await.map_err(Self::storage_error)?
    };
    tx.commit().await.map_err(Self::storage_error)?;
    Self::map_automation(row)
  }

  async fn accept_task_maintenance(
    &self,
    accepted: myoxus_domain::workspace_automation::AcceptedAutomationRun,
  ) -> RepoResult<WorkspaceAutomationRun> {
    let maintenance = accepted
      .task_maintenance
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("correction acceptance missing".into()))?;
    if accepted.actor_id != Some(maintenance.plan.actor_id)
      || accepted.workspace_id != maintenance.plan.workspace_id
      || accepted.automation_id.is_some()
      || accepted.trigger.is_some()
      || accepted.confirmed_request.is_some()
      || accepted.document_review.is_some()
      || accepted.task_handover.is_some()
      || maintenance.plan.proposal.patches.is_empty()
    {
      return Err(RepositoryError::Validation("correction acceptance mismatch".into()));
    }
    let mut tx = self.pool.begin().await.map_err(Self::storage_error)?;
    crate::workflow_runtime::effects::lock_runtime_authority(
      &mut tx,
      maintenance.plan.actor_id,
      accepted.workspace_id,
      false,
    )
    .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(format!(
        "task-maintenance:{}:{}",
        maintenance.plan.actor_id, maintenance.request_id
      ))
      .execute(&mut *tx)
      .await
      .map_err(Self::storage_error)?;
    if let Some(row)=sqlx::query("SELECT * FROM workspace_automation_runs WHERE origin_kind='task_maintenance' AND confirmed_actor_id=$1 AND confirmed_request_id=$2 FOR UPDATE")
      .bind(maintenance.plan.actor_id).bind(maintenance.request_id).fetch_optional(&mut *tx).await.map_err(Self::storage_error)? {
      let run=Self::map_run(row)?;if run.workspace_id!=accepted.workspace_id || run.idempotency_key!=maintenance.fingerprint {return Err(RepositoryError::Conflict("correction request input changed"))}
      tx.commit().await.map_err(Self::storage_error)?;return Ok(run)
    }
    self.capture_maintenance_admission(&mut tx).await?;
    crate::workspace_database::PgDatabaseRepository::assert_task_correction_proposal_in_tx(
      &mut tx,
      &maintenance.plan.proposal,
      true,
    )
    .await?;
    let row=sqlx::query("INSERT INTO workspace_automation_runs(id,workspace_id,origin_kind,confirmed_actor_id,confirmed_operation,confirmed_request_id,idempotency_key,status,accepted_json) VALUES($1,$2,'task_maintenance',$3,'task_maintenance',$4,$5,'queued',$6) RETURNING *")
      .bind(accepted.run_id).bind(accepted.workspace_id).bind(maintenance.plan.actor_id).bind(maintenance.request_id).bind(&maintenance.fingerprint).bind(serde_json::to_value(&accepted).map_err(Self::storage_error)?).fetch_one(&mut *tx).await.map_err(Self::storage_error)?;
    tx.commit().await.map_err(Self::storage_error)?;
    Self::map_run(row)
  }
  async fn get_task_maintenance_request(
    &self,
    actor: Uuid,
    workspace: Uuid,
    request: Uuid,
  ) -> RepoResult<Option<WorkspaceAutomationRun>> {
    sqlx::query("SELECT * FROM workspace_automation_runs WHERE origin_kind='task_maintenance' AND confirmed_actor_id=$1 AND workspace_id=$2 AND confirmed_request_id=$3")
      .bind(actor).bind(workspace).bind(request).fetch_optional(&self.pool).await.map_err(Self::storage_error)?.map(Self::map_run).transpose()
  }
  async fn task_correction_confirmation(
    &self,
    run: Uuid,
  ) -> RepoResult<Option<myoxus_domain::workspace_automation::TaskCorrectionConfirmationReceipt>> {
    let value:Option<serde_json::Value>=sqlx::query_scalar("SELECT task_correction_outcome_json FROM workspace_automation_runs WHERE id=$1 AND (origin_kind='task_maintenance' OR (origin_kind='rule' AND accepted_json->'taskMaintenance' IS NOT NULL))")
      .bind(run).fetch_optional(&self.pool).await.map_err(Self::storage_error)?.flatten();
    value
      .map(serde_json::from_value)
      .transpose()
      .map_err(Self::storage_error)
  }
  async fn commit_task_inspection(
    &self,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> RepoResult<serde_json::Value> {
    let mut tx = self.pool.begin().await.map_err(Self::storage_error)?;
    self.capture_maintenance_admission(&mut tx).await?;
    if let Some(result) = crate::workflow_runtime::lock_runtime_effect(&mut tx, &fence).await? {
      tx.commit().await.map_err(Self::storage_error)?;
      return Ok(result);
    }
    let value: serde_json::Value =
      sqlx::query_scalar("SELECT accepted_json FROM workspace_automation_runs WHERE id=$1")
        .bind(fence.run_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::storage_error)?;
    let accepted: myoxus_domain::workspace_automation::AcceptedAutomationRun =
      serde_json::from_value(value).map_err(Self::storage_error)?;
    let maintenance = accepted
      .task_maintenance
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("correction acceptance missing".into()))?;
    let node: String = sqlx::query_scalar("SELECT node_key FROM workspace_automation_actions WHERE id=$1")
      .bind(fence.action_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::storage_error)?;
    if myoxus_application::workspace_automation::maintenance::maintenance_effect_kind(&accepted.definition, &node)
      .map_err(Self::storage_error)?
    {
      return Err(RepositoryError::Validation("invalid inspection effect".into()));
    }
    crate::workspace_database::PgDatabaseRepository::assert_task_correction_proposal_in_tx(
      &mut tx,
      &maintenance.plan.proposal,
      true,
    )
    .await?;
    let result = serde_json::to_value(&maintenance.plan.proposal).map_err(Self::storage_error)?;
    crate::workflow_runtime::acknowledge_runtime_effect(&mut tx, &fence, result.clone()).await?;
    tx.commit().await.map_err(Self::storage_error)?;
    Ok(result)
  }

  async fn accept_task_handover(
    &self,
    accepted: myoxus_domain::workspace_automation::AcceptedAutomationRun,
  ) -> RepoResult<WorkspaceAutomationRun> {
    let handover = accepted
      .task_handover
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("handover acceptance missing".into()))?;
    if accepted.actor_id != Some(handover.plan.actor_id)
      || accepted.workspace_id != handover.plan.workspace_id
      || accepted.automation_id.is_some()
      || accepted.trigger.is_some()
      || accepted.confirmed_request.is_some()
      || accepted.document_review.is_some()
    {
      return Err(RepositoryError::Validation("handover acceptance mismatch".into()));
    }
    let mut tx = self.pool.begin().await.map_err(Self::storage_error)?;
    crate::workflow_runtime::effects::lock_runtime_authority(
      &mut tx,
      handover.plan.actor_id,
      accepted.workspace_id,
      false,
    )
    .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(format!(
        "task-handover:{}:{}",
        handover.plan.actor_id, handover.request_id
      ))
      .execute(&mut *tx)
      .await
      .map_err(Self::storage_error)?;
    if let Some(row)=sqlx::query("SELECT * FROM workspace_automation_runs WHERE origin_kind='task_handover' AND confirmed_actor_id=$1 AND confirmed_request_id=$2 FOR UPDATE").bind(handover.plan.actor_id).bind(handover.request_id).fetch_optional(&mut *tx).await.map_err(Self::storage_error)? {
      let run=Self::map_run(row)?;if run.workspace_id!=accepted.workspace_id||run.idempotency_key!=handover.fingerprint{return Err(RepositoryError::Conflict("handover request input"))}tx.commit().await.map_err(Self::storage_error)?;return Ok(run)
    }
    let member:Option<Uuid>=sqlx::query_scalar("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='Accepted' FOR SHARE NOWAIT").bind(accepted.workspace_id).bind(handover.plan.responsible_id).fetch_optional(&mut *tx).await.map_err(Self::storage_error)?;
    let source:Option<Uuid>=sqlx::query_scalar("SELECT id FROM docs WHERE id=$1 AND workspace_id=$2 AND external_id=$3 AND deleted_at IS NULL AND blocked=false AND is_workspace_root=false FOR SHARE NOWAIT").bind(handover.plan.source_document_id).bind(accepted.workspace_id).bind(&handover.plan.source_external_id).fetch_optional(&mut *tx).await.map_err(Self::storage_error)?;
    if member.is_none() || source.is_none() {
      return Err(RepositoryError::Validation(
        "handover source or responsible member unavailable".into(),
      ));
    }
    // Publish the entire interest set before locking/reading any prerequisite.
    sqlx::query("INSERT INTO workspace_automation_runs(id,workspace_id,origin_kind,confirmed_actor_id,confirmed_operation,confirmed_request_id,idempotency_key,status,accepted_json,task_handover_state) VALUES($1,$2,'task_handover',$3,'task_handover',$4,$5,'queued',$6,$7)").bind(accepted.run_id).bind(accepted.workspace_id).bind(handover.plan.actor_id).bind(handover.request_id).bind(&handover.fingerprint).bind(serde_json::to_value(&accepted).map_err(Self::storage_error)?).bind(serde_json::to_value(myoxus_domain::workspace_automation::TaskHandoverState::default()).map_err(Self::storage_error)?).execute(&mut *tx).await.map_err(Self::storage_error)?;
    crate::workspace_database::PgDatabaseRepository::lock_handover_prerequisites(&mut tx, &handover.plan).await?;
    let state = Self::record_handover_tasks(
      &mut tx,
      &accepted,
      &handover
        .plan
        .prerequisites
        .iter()
        .map(|task| task.row_id)
        .collect::<Vec<_>>(),
    )
    .await?;
    if state.invalid_reason.is_some() || state.expired_at.is_some() {
      return Err(RepositoryError::Validation("handover prerequisites unavailable".into()));
    }
    let now: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::storage_error)?;
    if now >= handover.plan.deadline_at {
      return Err(RepositoryError::Validation("handover admission expired".into()));
    }
    let row = sqlx::query("SELECT * FROM workspace_automation_runs WHERE id=$1")
      .bind(accepted.run_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::storage_error)?;
    tx.commit().await.map_err(Self::storage_error)?;
    Self::map_run(row)
  }
  async fn get_task_handover_request(
    &self,
    actor: Uuid,
    workspace: Uuid,
    request: Uuid,
  ) -> RepoResult<Option<WorkspaceAutomationRun>> {
    sqlx::query("SELECT * FROM workspace_automation_runs WHERE origin_kind='task_handover' AND confirmed_actor_id=$1 AND workspace_id=$2 AND confirmed_request_id=$3").bind(actor).bind(workspace).bind(request).fetch_optional(&self.pool).await.map_err(Self::storage_error)?.map(Self::map_run).transpose()
  }
  async fn task_handover_state(&self, run: Uuid) -> RepoResult<myoxus_domain::workspace_automation::TaskHandoverState> {
    let value: serde_json::Value = sqlx::query_scalar(
      "SELECT task_handover_state FROM workspace_automation_runs WHERE id=$1 AND origin_kind='task_handover'",
    )
    .bind(run)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::storage_error)?;
    serde_json::from_value(value).map_err(Self::storage_error)
  }
  async fn get_document_review_request(
    &self,
    actor: uuid::Uuid,
    workspace: uuid::Uuid,
    request: uuid::Uuid,
  ) -> RepoResult<Option<WorkspaceAutomationRun>> {
    sqlx::query(
      "SELECT * FROM workspace_automation_runs WHERE review_actor_id=$1 AND workspace_id=$2 AND review_request_id=$3",
    )
    .bind(actor)
    .bind(workspace)
    .bind(request)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage_error)?
    .map(Self::map_run)
    .transpose()
  }
  async fn get_document_review_for_task(
    &self,
    workspace: uuid::Uuid,
    database: uuid::Uuid,
    row: uuid::Uuid,
  ) -> RepoResult<Option<WorkspaceAutomationRun>> {
    sqlx::query("SELECT * FROM workspace_automation_runs WHERE origin_kind='document_review' AND workspace_id=$1 AND (review_task_id=$3 OR review_follow_up_id=$3) AND EXISTS(SELECT 1 FROM workspace_database_rows row JOIN workspace_databases database ON database.id=row.database_id WHERE row.id=$3 AND row.database_id=$2 AND database.workspace_id=$1 AND row.deleted_at IS NULL AND database.deleted_at IS NULL)").bind(workspace).bind(database).bind(row).fetch_optional(&self.pool).await.map_err(Self::storage_error)?.map(Self::map_run).transpose()
  }
  async fn document_review_decision(
    &self,
    run: uuid::Uuid,
  ) -> RepoResult<Option<myoxus_domain::workspace_automation::DocumentReviewDecisionReceipt>> {
    let value: Option<serde_json::Value> = sqlx::query_scalar(
      "SELECT review_outcome_json FROM workspace_automation_runs WHERE id=$1 AND origin_kind='document_review'",
    )
    .bind(run)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage_error)?
    .flatten();
    value
      .map(serde_json::from_value)
      .transpose()
      .map_err(Self::storage_error)
  }
  async fn validate_workflow_signal(
    &self,
    signal: &myoxus_domain::workspace_automation::WorkflowSignalEnvelope,
  ) -> RepoResult<()> {
    let payload = serde_json::to_value(signal).map_err(Self::storage_error)?;
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM outbox_events WHERE id=$1 AND event_type='workspace_automation_signal' AND payload=$2)").bind(signal.event_id).bind(payload).fetch_one(&self.pool).await.map_err(Self::storage_error)?;
    if !exists {
      return Err(RepositoryError::Validation(
        "workflow signal has no committed native intent".into(),
      ));
    }
    Ok(())
  }
  async fn stop_runtime_run(
    &self,
    actor: uuid::Uuid,
    run_id: uuid::Uuid,
  ) -> RepoResult<(WorkspaceAutomationRun, bool)> {
    let observed = self
      .get_run(run_id)
      .await?
      .ok_or(RepositoryError::NotFound("automation run"))?;
    let initiator = observed.accepted.as_ref().and_then(|accepted| accepted.actor_id);
    let manager_only = matches!(
      observed.origin,
      myoxus_domain::workspace_automation::WorkspaceAutomationRunOrigin::Rule
    ) && !observed
      .accepted
      .as_ref()
      .and_then(|accepted| accepted.personal_rule.as_ref())
      .is_some_and(|proof| proof.actor_id == actor)
      || initiator != Some(actor);
    let mut tx = self.pool.begin().await.map_err(Self::storage_error)?;
    crate::workflow_runtime::effects::lock_runtime_authority(&mut tx, actor, observed.workspace_id, manager_only)
      .await?;
    sqlx::query("SELECT instance_id FROM sayiir_workflow_claims WHERE instance_id=$1 FOR UPDATE")
      .bind(run_id.to_string())
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::storage_error)?;
    let row = sqlx::query("SELECT * FROM workspace_automation_runs WHERE id=$1 FOR UPDATE")
      .bind(run_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::storage_error)?;
    let run = Self::map_run(row)?;
    let mut changed = false;
    if matches!(
      run.status,
      WorkspaceAutomationRunStatus::Queued
        | WorkspaceAutomationRunStatus::Running
        | WorkspaceAutomationRunStatus::Failed
        | WorkspaceAutomationRunStatus::DeadLetter
    ) {
      if let Some(origin) = run
        .accepted
        .as_ref()
        .and_then(|accepted| accepted.confirmed_request.as_ref())
      {
        let owner = run
          .accepted
          .as_ref()
          .and_then(|accepted| accepted.actor_id)
          .ok_or(RepositoryError::Conflict("automation actor"))?;
        crate::workspace::SqlxWorkspaceStore::project_request_lock(
          &mut tx,
          owner,
          myoxus_application::workspace::StarterOperation::PrepareDocuments,
          origin.request_id,
        )
        .await
        .map_err(Self::storage_error)?;
        let receipt = crate::workspace::SqlxWorkspaceStore::context_receipt(
          &mut tx,
          owner,
          run.workspace_id,
          origin.request_id,
          Some(&origin.fingerprint),
        )
        .await
        .map_err(Self::storage_error)?
        .ok_or(RepositoryError::Conflict("context receipt"))?;
        if receipt.run_id != Some(run_id) {
          return Err(RepositoryError::Conflict("context run identity"));
        }
        if receipt.state == myoxus_application::workspace::ProjectStarterState::Complete {
          tx.commit().await.map_err(Self::storage_error)?;
          return Ok((run, false));
        }
        sqlx::query("UPDATE workspace_starter_applications SET project_state='stopped' WHERE actor_id=$1 AND operation='prepare_documents' AND request_id=$2 AND project_state IN ('accepted','stop_requested')")
          .bind(owner).bind(origin.request_id).execute(&mut *tx).await.map_err(Self::storage_error)?;
      }
      if let Some(origin) = run
        .accepted
        .as_ref()
        .and_then(|accepted| accepted.workspace_setup.as_ref())
      {
        let owner = run
          .accepted
          .as_ref()
          .and_then(|accepted| accepted.actor_id)
          .ok_or(RepositoryError::Conflict("Workspace setup actor"))?;
        let receipt = crate::workspace::SqlxWorkspaceStore::setup_receipt(
          &mut tx,
          owner,
          run.workspace_id,
          origin.request_id,
          Some(&origin.fingerprint),
        )
        .await
        .map_err(Self::storage_error)?
        .ok_or(RepositoryError::Conflict("Workspace setup receipt"))?;
        if receipt.run_id != run_id {
          return Err(RepositoryError::Conflict("Workspace setup run"));
        }
        if receipt.state == myoxus_application::workspace::ProjectStarterState::Complete {
          tx.commit().await.map_err(Self::storage_error)?;
          return Ok((run, false));
        }
        sqlx::query("UPDATE workspace_starter_applications SET project_state='stopped' WHERE actor_id=$1 AND operation='create_workspace' AND request_id=$2 AND project_state IN ('accepted','stop_requested')")
          .bind(owner).bind(origin.request_id).execute(&mut *tx).await.map_err(Self::storage_error)?;
      }
      changed = true;
      sqlx::query("UPDATE workspace_automation_runs SET execution_generation=execution_generation+1,claim_owner=NULL,status='skipped',error_code=NULL,error_message=NULL,dead_letter=false,finished_at=now() WHERE id=$1")
        .bind(run_id).execute(&mut *tx).await.map_err(Self::storage_error)?;
    }
    let row = sqlx::query("SELECT * FROM workspace_automation_runs WHERE id=$1")
      .bind(run_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::storage_error)?;
    tx.commit().await.map_err(Self::storage_error)?;
    Ok((Self::map_run(row)?, changed))
  }

  async fn fail_confirmed_run(
    &self,
    run_id: uuid::Uuid,
    claim: myoxus_domain::workspace_automation::AutomationExecutionClaim,
    reason: myoxus_domain::workspace_automation::ContextWorkflowFailure,
  ) -> RepoResult<Option<WorkspaceAutomationRun>> {
    let mut tx = self.pool.begin().await.map_err(Self::storage_error)?;
    let live = sqlx::query(
      "SELECT worker_id,expires_at>now() AS live FROM sayiir_workflow_claims WHERE instance_id=$1 FOR UPDATE",
    )
    .bind(run_id.to_string())
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage_error)?;
    let Some(live) = live else { return Ok(None) };
    if live.try_get::<String, _>("worker_id").map_err(Self::storage_error)? != claim.owner.to_string()
      || !live
        .try_get::<Option<bool>, _>("live")
        .map_err(Self::storage_error)?
        .unwrap_or(false)
    {
      return Ok(None);
    }
    let row=sqlx::query("UPDATE workspace_automation_runs SET status='failed',error_code=$4,error_message=NULL,finished_at=now() WHERE id=$1 AND claim_owner=$2 AND execution_generation=$3 AND (origin_kind IN ('confirmed_context_documents','document_review','task_handover','task_maintenance','workspace_setup') OR (origin_kind='rule' AND accepted_json->'personalRule' IS NOT NULL)) AND status IN ('queued','running') RETURNING *")
      .bind(run_id).bind(claim.owner).bind(claim.generation).bind(reason.code()).fetch_optional(&mut *tx).await.map_err(Self::storage_error)?;
    tx.commit().await.map_err(Self::storage_error)?;
    row.map(Self::map_run).transpose()
  }

  async fn get_effect(
    &self,
    run_id: uuid::Uuid,
    node_key: &str,
    effect_key: &str,
  ) -> RepoResult<Option<myoxus_domain::workspace_automation::WorkspaceAutomationEffectReceipt>> {
    sqlx::query("SELECT * FROM workspace_automation_actions WHERE run_id=$1 AND node_key=$2 AND effect_key=$3")
      .bind(run_id)
      .bind(node_key)
      .bind(effect_key)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::storage_error)?
      .map(Self::map_effect)
      .transpose()
  }

  async fn reserve_effect(
    &self,
    run_id: uuid::Uuid,
    node_key: &str,
    effect_key: &str,
    fingerprint: &str,
    claim: myoxus_domain::workspace_automation::AutomationExecutionClaim,
    expected_edit_revision: Option<i64>,
  ) -> RepoResult<myoxus_domain::workspace_automation::WorkspaceAutomationEffectReceipt> {
    use myoxus_domain::workspace_automation::AutomationEffectFence;
    let mut tx = self.pool.begin().await.map_err(Self::storage_error)?;
    self.capture_run_maintenance_admission(&mut tx, run_id).await?;
    let accepted = crate::workflow_runtime::effects::lock_runtime_execution(
      &mut tx,
      &AutomationEffectFence {
        run_id,
        action_id: uuid::Uuid::nil(),
        claim,
      },
      node_key,
    )
    .await?;
    let position = node_key
      .strip_prefix("action:")
      .and_then(|value| value.parse::<i32>().ok())
      .filter(|position| node_key == format!("action:{position}"))
      .ok_or_else(|| RepositoryError::Validation("invalid native action identity".into()))?;
    // The existing document action history also records the finite native
    // stages of that capability; the retained workflow identifies each stage.
    let mut reserved = uuid::Uuid::new_v4();
    if let Some(task) = &accepted.recurring_task {
      myoxus_application::workspace_automation::recurring_task::validate(&accepted).map_err(Self::storage_error)?;
      if node_key != "action:0" {
        return Err(RepositoryError::Validation("invalid recurring Task effect".into()));
      }
      reserved = task.row_id;
    } else if accepted.task_maintenance.is_some() {
      myoxus_application::workspace_automation::maintenance::maintenance_effect_kind(&accepted.definition, node_key)
        .map_err(Self::storage_error)?;
    } else if let Some(handover) = &accepted.task_handover {
      myoxus_application::workspace_automation::handover::handover_effect_component(&accepted.definition, node_key)
        .map_err(|_| RepositoryError::Validation("invalid handover effect".into()))?;
      reserved = handover.result_task_id;
    } else if let Some(review) = &accepted.document_review {
      let (_, branch) =
        myoxus_application::workspace_automation::review::review_effect_component(&accepted.definition, node_key)
          .map_err(|_| RepositoryError::Validation("invalid review effect".into()))?;
      reserved = if branch.is_none() {
        review.review_task_id
      } else {
        review.follow_up_task_id
      };
    } else if let Some(origin) = &accepted.workspace_setup {
      let receipt = crate::workspace::SqlxWorkspaceStore::setup_receipt(
        &mut tx,
        accepted
          .actor_id
          .ok_or_else(|| RepositoryError::Validation("Workspace setup actor unavailable".into()))?,
        accepted.workspace_id,
        origin.request_id,
        Some(&origin.fingerprint),
      )
      .await
      .map_err(Self::storage_error)?
      .ok_or_else(|| RepositoryError::Validation("Workspace setup receipt unavailable".into()))?;
      use myoxus_domain::workspace_automation::ContextDocumentWorkflowStage as Stage;
      let stage = accepted
        .definition
        .workflow
        .as_ref()
        .and_then(|workflow| workflow.stages.get(position as usize))
        .ok_or_else(|| RepositoryError::Validation("Workspace setup stage unavailable".into()))?;
      if let Stage::CreateDatabaseFromDefinition { component }
      | Stage::CreateWorkingDocument { component }
      | Stage::PlaceNativeLink { component } = stage
      {
        reserved = receipt
          .reservations
          .iter()
          .find(|reserved| reserved.component_id == *component)
          .ok_or_else(|| RepositoryError::Validation("Workspace setup reservation unavailable".into()))?
          .result_id;
      }
    } else if accepted.confirmed_request.is_some() {
      if accepted
        .definition
        .workflow
        .as_ref()
        .and_then(|workflow| workflow.stages.get(position as usize))
        .is_none()
      {
        return Err(RepositoryError::Validation("unknown native stage".into()));
      }
    } else {
      accepted
        .definition
        .actions
        .iter()
        .find(|action| action.position == position)
        .ok_or_else(|| RepositoryError::Validation("unknown native action".into()))?;
    };
    if myoxus_application::workspace_automation::runtime::effect_input_fingerprint(&accepted, node_key, effect_key)
      .map_err(|_| RepositoryError::Validation("invalid effect fingerprint".into()))?
      != fingerprint
    {
      return Err(RepositoryError::Validation("effect fingerprint changed".into()));
    }
    sqlx::query("INSERT INTO workspace_automation_actions(id,run_id,position,status,node_key,effect_key,input_fingerprint,reserved_id,expected_edit_revision) VALUES($1,$2,$3,'running',$4,$5,$6,$7,$8) ON CONFLICT(run_id,node_key,effect_key) DO NOTHING")
      .bind(uuid::Uuid::new_v4()).bind(run_id).bind(position)
      .bind(node_key).bind(effect_key).bind(fingerprint).bind(reserved).bind(expected_edit_revision)
      .execute(&mut *tx).await.map_err(Self::storage_error)?;
    let row = sqlx::query(
      "SELECT * FROM workspace_automation_actions WHERE run_id=$1 AND node_key=$2 AND effect_key=$3 FOR UPDATE",
    )
    .bind(run_id)
    .bind(node_key)
    .bind(effect_key)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::storage_error)?;
    let receipt = Self::map_effect(row)?;
    if receipt.input_fingerprint != fingerprint {
      return Err(RepositoryError::Validation("effect fingerprint changed".into()));
    }
    tx.commit().await.map_err(Self::storage_error)?;
    Ok(receipt)
  }

  async fn authorize_webhook_dispatch(
    &self,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> RepoResult<Option<serde_json::Value>> {
    let mut tx = self.pool.begin().await.map_err(Self::storage_error)?;
    self.capture_run_maintenance_admission(&mut tx, fence.run_id).await?;
    let committed = crate::workflow_runtime::lock_runtime_effect(&mut tx, &fence).await?;
    Self::assert_webhook_effect(&mut tx, &fence).await?;
    if let Some(result) = committed {
      tx.commit().await.map_err(Self::storage_error)?;
      return Ok(Some(result));
    }
    // The action is the sole receipt. Admission is durable before HTTP, but an
    // unknown response still permits at-least-once delivery on a runtime retry.
    let previous: Option<serde_json::Value> =
      sqlx::query_scalar("SELECT webhook_delivery_json FROM workspace_automation_actions WHERE id=$1")
        .bind(fence.action_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::storage_error)?;
    let attempts = match previous {
      None => 1i64,
      Some(previous) => {
        if previous.get("formatVersion").and_then(serde_json::Value::as_i64) != Some(1) {
          return Err(RepositoryError::Validation("invalid webhook diagnostics".into()));
        }
        previous
          .get("admittedAttempts")
          .and_then(serde_json::Value::as_i64)
          .filter(|attempts| *attempts > 0)
          .and_then(|attempts| attempts.checked_add(1))
          .ok_or_else(|| RepositoryError::Validation("invalid webhook diagnostics".into()))?
      }
    };
    sqlx::query("UPDATE workspace_automation_actions SET webhook_delivery_json=jsonb_build_object('formatVersion',1,'admittedAttempts',$2::bigint,'lastStartedAt',clock_timestamp(),'lastFinishedAt',NULL,'responseStatus',NULL,'errorSummary',NULL) WHERE id=$1")
      .bind(fence.action_id).bind(attempts).execute(&mut *tx).await.map_err(Self::storage_error)?;
    tx.commit().await.map_err(Self::storage_error)?;
    Ok(None)
  }

  async fn record_webhook_failure(
    &self,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
    response_status: Option<i32>,
    safe_error_summary: String,
  ) -> RepoResult<()> {
    // The application supplies a static, content-free summary, never a raw
    // transport error or response body. Bound diagnostics independently of HTTP.
    if safe_error_summary.len() > 512
      || safe_error_summary.chars().any(char::is_control)
      || response_status.is_some_and(|status| !(100..=599).contains(&status))
    {
      return Err(RepositoryError::Validation(
        "invalid webhook failure diagnostics".into(),
      ));
    }
    let mut tx = self.pool.begin().await.map_err(Self::storage_error)?;
    self.capture_run_maintenance_admission(&mut tx, fence.run_id).await?;
    let committed = crate::workflow_runtime::lock_runtime_effect(&mut tx, &fence).await?;
    Self::assert_webhook_effect(&mut tx, &fence).await?;
    if committed.is_some() {
      tx.commit().await.map_err(Self::storage_error)?;
      return Ok(());
    }
    let changed = sqlx::query("UPDATE workspace_automation_actions SET webhook_delivery_json=webhook_delivery_json || jsonb_build_object('lastFinishedAt',clock_timestamp(),'responseStatus',$2::integer,'errorSummary',$3::text) WHERE id=$1 AND webhook_delivery_json->>'formatVersion'='1' AND (webhook_delivery_json->>'admittedAttempts')::bigint>0")
      .bind(fence.action_id).bind(response_status).bind(safe_error_summary)
      .execute(&mut *tx).await.map_err(Self::storage_error)?.rows_affected();
    if changed != 1 {
      return Err(RepositoryError::Validation("webhook dispatch was not admitted".into()));
    }
    tx.commit().await.map_err(Self::storage_error)?;
    Ok(())
  }

  async fn finish_webhook_effect(
    &self,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
    result: serde_json::Value,
  ) -> RepoResult<()> {
    let status = result
      .get("status")
      .and_then(serde_json::Value::as_i64)
      .filter(|status| (200..=299).contains(status))
      .ok_or_else(|| RepositoryError::Validation("invalid webhook success result".into()))?;
    if result.get("delivery_id").and_then(serde_json::Value::as_str) != Some(fence.action_id.to_string().as_str())
      || result.as_object().is_none_or(|object| object.len() != 2)
    {
      return Err(RepositoryError::Validation("invalid webhook success identity".into()));
    }
    let mut tx = self.pool.begin().await.map_err(Self::storage_error)?;
    self.capture_run_maintenance_admission(&mut tx, fence.run_id).await?;
    let committed = crate::workflow_runtime::lock_runtime_effect(&mut tx, &fence).await?;
    Self::assert_webhook_effect(&mut tx, &fence).await?;
    if let Some(committed) = committed {
      if committed != result {
        return Err(RepositoryError::Validation("webhook result changed".into()));
      }
      tx.commit().await.map_err(Self::storage_error)?;
      return Ok(());
    }
    let changed = sqlx::query("UPDATE workspace_automation_actions SET webhook_delivery_json=webhook_delivery_json || jsonb_build_object('lastFinishedAt',clock_timestamp(),'responseStatus',$2::integer,'errorSummary',NULL) WHERE id=$1 AND webhook_delivery_json->>'formatVersion'='1' AND (webhook_delivery_json->>'admittedAttempts')::bigint>0")
      .bind(fence.action_id).bind(status as i32).execute(&mut *tx).await.map_err(Self::storage_error)?.rows_affected();
    if changed != 1 {
      return Err(RepositoryError::Validation("webhook dispatch was not admitted".into()));
    }
    // Success diagnostics and the native effect ACK have one commit boundary.
    crate::workflow_runtime::acknowledge_runtime_effect(&mut tx, &fence, result).await?;
    tx.commit().await.map_err(Self::storage_error)?;
    Ok(())
  }

  async fn synchronize_runtime_status(
    &self,
    run_id: uuid::Uuid,
    status: WorkspaceAutomationRunStatus,
    reason: Option<String>,
  ) -> RepoResult<Option<WorkspaceAutomationRun>> {
    let terminal = !matches!(
      status,
      WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
    );
    let row = sqlx::query("UPDATE workspace_automation_runs SET status=$2,error_code=CASE WHEN (origin_kind='document_review' AND (review_invalid_reason IS NOT NULL OR review_expired_at IS NOT NULL)) OR (origin_kind='task_handover' AND (task_handover_state->>'invalidReason' IS NOT NULL OR task_handover_state->>'expiredAt' IS NOT NULL)) OR task_maintenance_invalid_reason IS NOT NULL THEN 'MIX_AUTOMATION_RUN_NOT_RETRYABLE' ELSE $3 END,dead_letter=($2='dead_letter'),started_at=COALESCE(started_at,now()),finished_at=CASE WHEN $4 THEN now() ELSE finished_at END WHERE id=$1 AND status IN ('queued','running') AND status<>$2 RETURNING *")
      .bind(run_id).bind(status.as_str()).bind(reason).bind(terminal).fetch_optional(&self.pool).await.map_err(Self::storage_error)?;
    row.map(Self::map_run).transpose()
  }

  async fn create_automation(&self, automation: WorkspaceAutomation) -> RepoResult<WorkspaceAutomation> {
    if automation.personal_config.is_some()
      || automation.actions.iter().any(|action| {
        matches!(
          &action.config,
          myoxus_domain::workspace_automation::WorkspaceAutomationActionConfig::CreateLinkedDocument {
            source: Some(_),
            ..
          }
        )
      })
    {
      return Err(RepositoryError::Validation(
        "source-backed actions require explicit personal configuration".into(),
      ));
    }
    let trigger_json = serde_json::to_value(&automation.trigger).map_err(Self::storage_error)?;
    let actions_json = serde_json::to_value(&automation.actions).map_err(Self::storage_error)?;
    let row = sqlx::query(
      r#"
      INSERT INTO workspace_automations
        (id, workspace_id, name, description, status, trigger_type, trigger_json,
         actions_json, created_by, updated_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
      "#,
    )
    .bind(automation.id)
    .bind(automation.workspace_id)
    .bind(&automation.name)
    .bind(&automation.description)
    .bind(automation.status.as_str())
    .bind(automation.trigger.trigger_type.as_str())
    .bind(trigger_json)
    .bind(actions_json)
    .bind(automation.created_by)
    .bind(automation.updated_by)
    .bind(automation.created_at)
    .bind(automation.updated_at)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::storage_error)?;
    Self::map_automation(row)
  }

  async fn update_automation(
    &self,
    automation_id: myoxus_domain::ids::WorkspaceAutomationId,
    name: Option<String>,
    description: Option<Option<String>>,
    status: Option<WorkspaceAutomationStatus>,
    trigger: Option<WorkspaceAutomationTrigger>,
    actions: Option<Vec<WorkspaceAutomationActionDefinition>>,
    updated_by: Option<myoxus_domain::ids::UserId>,
  ) -> RepoResult<WorkspaceAutomation> {
    let current = self
      .get_automation(automation_id)
      .await?
      .ok_or(RepositoryError::NotFound("workspace_automation"))?;
    if current.personal_config.is_some()
      || actions.as_ref().is_some_and(|actions| {
        actions.iter().any(|action| {
          matches!(
            &action.config,
            myoxus_domain::workspace_automation::WorkspaceAutomationActionConfig::CreateLinkedDocument {
              source: Some(_),
              ..
            }
          )
        })
      })
    {
      return Err(RepositoryError::Validation(
        "personal configuration requires its owner revisioned command".into(),
      ));
    }
    let trigger = trigger.unwrap_or(current.trigger);
    let actions = actions.unwrap_or(current.actions);
    let trigger_json = serde_json::to_value(&trigger).map_err(Self::storage_error)?;
    let actions_json = serde_json::to_value(&actions).map_err(Self::storage_error)?;
    let row = sqlx::query(
      r#"
      UPDATE workspace_automations
      SET name = COALESCE($2, name),
          description = CASE WHEN $3 THEN $4 ELSE description END,
          execution_revision=execution_revision+CASE WHEN status IS DISTINCT FROM COALESCE($5,status) OR trigger_json IS DISTINCT FROM $7 OR actions_json IS DISTINCT FROM $8 THEN 1 ELSE 0 END,
          status = COALESCE($5, status),
          trigger_type = $6,
          trigger_json = $7,
          actions_json = $8,
          updated_by = $9,
          updated_at = now()
      WHERE id = $1
      RETURNING *
      "#,
    )
    .bind(automation_id)
    .bind(name)
    .bind(description.is_some())
    .bind(description.flatten())
    .bind(status.map(|status| status.as_str().to_string()))
    .bind(trigger.trigger_type.as_str())
    .bind(trigger_json)
    .bind(actions_json)
    .bind(updated_by)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage_error)?
    .ok_or(RepositoryError::NotFound("workspace_automation"))?;
    Self::map_automation(row)
  }

  async fn get_automation(
    &self,
    automation_id: myoxus_domain::ids::WorkspaceAutomationId,
  ) -> RepoResult<Option<WorkspaceAutomation>> {
    sqlx::query("SELECT * FROM workspace_automations WHERE id = $1")
      .bind(automation_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::storage_error)?
      .map(Self::map_automation)
      .transpose()
  }

  async fn list_automations(
    &self,
    workspace_id: myoxus_domain::ids::WorkspaceId,
    page: PageRequest,
  ) -> RepoResult<Vec<WorkspaceAutomation>> {
    let rows = sqlx::query(
      r#"
      SELECT * FROM workspace_automations
      WHERE workspace_id = $1
      ORDER BY updated_at DESC, id DESC
      LIMIT $2 OFFSET $3
      "#,
    )
    .bind(workspace_id)
    .bind(page.limit)
    .bind(page.offset)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage_error)?;
    rows.into_iter().map(Self::map_automation).collect()
  }

  async fn list_matching_automations(
    &self,
    event: &WorkspaceAutomationTriggerEvent,
    limit: i64,
  ) -> RepoResult<Vec<WorkspaceAutomation>> {
    let rows = sqlx::query(
      r#"
      SELECT * FROM workspace_automations
      WHERE workspace_id = $1
        AND status = 'enabled'
        AND trigger_type = $2
        AND trigger_json->>'databaseId' = $3
      ORDER BY updated_at ASC, id ASC
      LIMIT $4
      "#,
    )
    .bind(event.workspace_id)
    .bind(event.trigger_type.as_str())
    .bind(event.database_id.to_string())
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage_error)?;
    let mut automations = Vec::new();
    for row in rows {
      let automation = Self::map_automation(row)?;
      if automation.trigger.field_id.is_some() && automation.trigger.field_id != event.field_id {
        continue;
      }
      if let Some(option_id) = automation.trigger.select_option_id.as_ref() {
        let matches_option = event.new_value.as_ref().and_then(|value| match value {
          myoxus_domain::database::DatabaseCellValueData::Select(value) => Some(value),
          _ => None,
        }) == Some(option_id);
        if !matches_option {
          continue;
        }
      }
      automations.push(automation);
    }
    Ok(automations)
  }

  async fn disable_automation(
    &self,
    automation_id: myoxus_domain::ids::WorkspaceAutomationId,
    updated_by: Option<myoxus_domain::ids::UserId>,
  ) -> RepoResult<WorkspaceAutomation> {
    self
      .update_automation(
        automation_id,
        None,
        None,
        Some(WorkspaceAutomationStatus::Disabled),
        None,
        None,
        updated_by,
      )
      .await
  }

  async fn create_run_if_absent(&self, mut run: WorkspaceAutomationRun) -> RepoResult<(WorkspaceAutomationRun, bool)> {
    let accepted = run
      .accepted
      .clone()
      .ok_or_else(|| RepositoryError::Validation("accepted automation input unavailable".into()))?;
    let mut tx = self.pool.begin().await.map_err(Self::storage_error)?;
    if accepted.personal_rule.is_some() {
      sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(format!(
          "personal-event:{}:{}",
          run
            .automation_id
            .ok_or(RepositoryError::Conflict("personal rule unavailable"))?,
          run.idempotency_key
        ))
        .execute(&mut *tx)
        .await
        .map_err(Self::storage_error)?;
      if let Some(existing) = sqlx::query(
        "SELECT * FROM workspace_automation_runs WHERE workspace_id=$1 AND automation_id=$2 AND idempotency_key=$3",
      )
      .bind(run.workspace_id)
      .bind(run.automation_id)
      .bind(&run.idempotency_key)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::storage_error)?
      {
        tx.commit().await.map_err(Self::storage_error)?;
        return Ok((Self::map_run(existing)?, false));
      }
      if accepted.task_maintenance.is_some() {
        self.capture_maintenance_admission(&mut tx).await?;
      }
      let actor = accepted
        .actor_id
        .ok_or(RepositoryError::Conflict("personal actor unavailable"))?;
      let admission =
        match crate::workflow_runtime::effects::lock_runtime_authority(&mut tx, actor, run.workspace_id, false).await {
          Ok(()) => crate::workflow_runtime::effects::lock_personal_automation(&mut tx, &accepted).await,
          Err(error) => Err(error),
        };
      match admission {
        Ok(()) => {}
        Err(RepositoryError::Storage(error)) => return Err(RepositoryError::Storage(error)),
        Err(_) => {
          run.status = WorkspaceAutomationRunStatus::Failed;
          run.error_code = Some("MIX_AUTOMATION_RUN_NOT_RETRYABLE".into());
          run.error_message = None;
          run.finished_at = Some(chrono::Utc::now());
        }
      }
      if run.status != WorkspaceAutomationRunStatus::Failed {
        if let Some(maintenance) = &accepted.task_maintenance {
          match crate::workspace_database::PgDatabaseRepository::assert_task_correction_proposal_in_tx(
            &mut tx,
            &maintenance.plan.proposal,
            true,
          )
          .await
          {
            Ok(()) => {}
            Err(RepositoryError::Storage(error)) => return Err(RepositoryError::Storage(error)),
            Err(_) => {
              run.status = WorkspaceAutomationRunStatus::Failed;
              run.error_code = Some("MIX_AUTOMATION_RUN_NOT_RETRYABLE".into());
              run.error_message = None;
              run.finished_at = Some(chrono::Utc::now());
            }
          }
        }
      }
    }
    let event_json = run
      .trigger_event
      .as_ref()
      .map(serde_json::to_value)
      .transpose()
      .map_err(Self::storage_error)?;
    let inserted = sqlx::query(
      r#"
      INSERT INTO workspace_automation_runs
        (id, automation_id, workspace_id, trigger_type, trigger_event_json,
         idempotency_key, status, attempt_count, error_code, error_message,
         dead_letter, queued_at, started_at, finished_at, job_id, accepted_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (workspace_id, automation_id, idempotency_key) DO NOTHING
      RETURNING *
      "#,
    )
    .bind(run.id)
    .bind(run.automation_id)
    .bind(run.workspace_id)
    .bind(run.trigger_type.map(|kind| kind.as_str()))
    .bind(event_json)
    .bind(&run.idempotency_key)
    .bind(run.status.as_str())
    .bind(run.attempt_count)
    .bind(&run.error_code)
    .bind(&run.error_message)
    .bind(run.dead_letter)
    .bind(run.queued_at)
    .bind(run.started_at)
    .bind(run.finished_at)
    .bind(&run.job_id)
    .bind(serde_json::to_value(&accepted).map_err(Self::storage_error)?)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage_error)?;
    if let Some(row) = inserted {
      tx.commit().await.map_err(Self::storage_error)?;
      return Ok((Self::map_run(row)?, true));
    }
    let row = sqlx::query(
      r#"
      SELECT * FROM workspace_automation_runs
      WHERE workspace_id = $1 AND automation_id = $2 AND idempotency_key = $3
      "#,
    )
    .bind(run.workspace_id)
    .bind(run.automation_id)
    .bind(&run.idempotency_key)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::storage_error)?;
    tx.commit().await.map_err(Self::storage_error)?;
    Ok((Self::map_run(row)?, false))
  }

  async fn count_recent_runs(
    &self,
    workspace_id: myoxus_domain::ids::WorkspaceId,
    since: chrono::DateTime<chrono::Utc>,
  ) -> RepoResult<i64> {
    sqlx::query_scalar(
      r#"
      SELECT COUNT(*)::bigint
      FROM workspace_automation_runs
      WHERE workspace_id = $1 AND queued_at >= $2
      "#,
    )
    .bind(workspace_id)
    .bind(since)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::storage_error)
  }

  async fn get_run(
    &self,
    run_id: myoxus_domain::ids::WorkspaceAutomationRunId,
  ) -> RepoResult<Option<WorkspaceAutomationRun>> {
    sqlx::query("SELECT * FROM workspace_automation_runs WHERE id = $1")
      .bind(run_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::storage_error)?
      .map(Self::map_run)
      .transpose()
  }

  async fn record_run_job(&self, run_id: myoxus_domain::ids::WorkspaceAutomationRunId, job_id: &str) -> RepoResult<()> {
    let updated = sqlx::query("UPDATE workspace_automation_runs SET job_id=$2 WHERE id=$1")
      .bind(run_id)
      .bind(job_id)
      .execute(&self.pool)
      .await
      .map_err(Self::storage_error)?;
    if updated.rows_affected() != 1 {
      return Err(RepositoryError::NotFound("workspace_automation_run"));
    }
    Ok(())
  }

  async fn list_runs(
    &self,
    workspace_id: myoxus_domain::ids::WorkspaceId,
    automation_id: Option<myoxus_domain::ids::WorkspaceAutomationId>,
    include_dead_letter: bool,
    page: PageRequest,
  ) -> RepoResult<Vec<WorkspaceAutomationRun>> {
    let rows = sqlx::query(
      r#"
      SELECT * FROM workspace_automation_runs
      WHERE workspace_id = $1
        AND ($2::uuid IS NULL OR automation_id = $2)
        AND ($3 OR dead_letter = FALSE)
      ORDER BY queued_at DESC, id DESC
      LIMIT $4 OFFSET $5
      "#,
    )
    .bind(workspace_id)
    .bind(automation_id)
    .bind(include_dead_letter)
    .bind(page.limit)
    .bind(page.offset)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage_error)?;
    rows.into_iter().map(Self::map_run).collect()
  }

  async fn list_dead_letter_runs(
    &self,
    workspace_id: Option<myoxus_domain::ids::WorkspaceId>,
    page: PageRequest,
  ) -> RepoResult<Vec<WorkspaceAutomationRun>> {
    let rows = sqlx::query(
      r#"
      SELECT * FROM workspace_automation_runs
      WHERE dead_letter = TRUE
        AND ($1::uuid IS NULL OR workspace_id = $1)
      ORDER BY queued_at DESC, id DESC
      LIMIT $2 OFFSET $3
      "#,
    )
    .bind(workspace_id)
    .bind(page.limit)
    .bind(page.offset)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage_error)?;
    rows.into_iter().map(Self::map_run).collect()
  }
}
