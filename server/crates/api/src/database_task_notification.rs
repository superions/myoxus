// SPDX-License-Identifier: AGPL-3.0-or-later
//! Recoverable Task-intent handoff on the existing notification queue.

use crate::state::ApiState;
use myoxus_application::auth::AuthError;
use myoxus_application::notification::mail::NotificationMailProjector;
use myoxus_domain::database::{DatabaseTaskNotificationIntent, DatabaseTaskNotificationKind};
use myoxus_worker::{JobError, JobOptions, RedisQueue};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone, Copy)]
enum TaskNotificationDropReason {
  CurrentTargetOrSubscriptionUnavailable,
}
impl TaskNotificationDropReason {
  fn as_str(self) -> &'static str {
    match self {
      Self::CurrentTargetOrSubscriptionUnavailable => "current_target_or_subscription_unavailable",
    }
  }
}

fn retry(message: &str) -> JobError {
  JobError::Retryable(message.to_owned())
}
fn intent(payload: &Value) -> Result<DatabaseTaskNotificationIntent, JobError> {
  let value: DatabaseTaskNotificationIntent = serde_json::from_value(payload.clone())
    .map_err(|_| JobError::Permanent("invalid Task notification intent".into()))?;
  let mut recipients = std::collections::BTreeSet::new();
  if value.revisions.is_empty()
    || value.recipients.is_empty()
    || value
      .recipients
      .iter()
      .any(|recipient| recipient.user_id == value.actor_id || !recipients.insert(recipient.user_id))
  {
    return Err(JobError::Permanent("invalid Task notification identities".into()));
  }
  Ok(value)
}

/// Queue identity contains only immutable intent. Completed work and durable
/// terminal receipts acknowledge a replay after enqueue-success/SQL-ack failure.
/// Acknowledge accepted handoff. Processed-event retention preserves the
/// SQL receipt until delivery completes; queue retry ownership stays unchanged.
#[tracing::instrument(skip_all)]
pub async fn enqueue(pool: &PgPool, queue: &RedisQueue, event_id: Uuid, payload: &Value) -> Result<(), AuthError> {
  intent(&payload["intent"]).map_err(|_| AuthError::InvalidInput("invalid Task notification intent".into()))?;
  if payload["deliveryComplete"] == true {
    return Ok(());
  }
  let key = format!("task-notification:{event_id}");
  let data = json!({"eventId":event_id,"intent":payload["intent"]});
  if let Some(job) = queue
    .get_job("notification", &key)
    .await
    .map_err(|_| AuthError::Storage("Task notification queue lookup failed".into()))?
  {
    if job.name != "notification.sendDatabaseTaskNotification" || job.data != data {
      return Err(AuthError::Storage("Task notification queue identity conflict".into()));
    }
    // A matching job already owns delivery and all retries, including a
    // terminal failure awaiting an explicit queue retry. Never reset it here.
    return Ok(());
  }
  // SQL receipt read also covers a completed job already removed by retention.
  let completed: bool = sqlx::query_scalar(
    "SELECT COALESCE(payload->'deliveryComplete' = 'true'::jsonb, false)
     FROM outbox_events WHERE id=$1 AND event_type='database_task_notification'",
  )
  .bind(event_id)
  .fetch_one(pool)
  .await
  .map_err(|_| AuthError::Storage("Task notification receipt lookup failed".into()))?;
  if !completed {
    queue
      .enqueue_idempotent(
        "notification",
        &key,
        "notification.sendDatabaseTaskNotification",
        data,
        JobOptions::default(),
      )
      .await
      .map_err(|_| AuthError::Storage("Task notification queue admission failed".into()))?;
  }
  Ok(())
}

/// The existing outbox Row serializes replay/drop decisions. Inbox insertion
/// is independently idempotent, including a crash before its terminal receipt.
/// Assignment mail keeps the existing inserted-only, best-effort SMTP policy.
#[tracing::instrument(skip_all)]
pub async fn dispatch(
  pool: &PgPool,
  state: &ApiState,
  data: &Value,
  repo: Arc<myoxus_infrastructure::workspace_database::PgDatabaseRepository>,
) -> Result<Value, JobError> {
  let event_id = data["eventId"]
    .as_str()
    .and_then(|id| id.parse::<Uuid>().ok())
    .ok_or_else(|| JobError::Permanent("invalid Task notification event ID".into()))?;
  let intent = intent(&data["intent"])?;
  let mut tx = pool
    .begin()
    .await
    .map_err(|_| retry("Task notification receipt transaction failed"))?;
  let row =
    sqlx::query("SELECT payload FROM outbox_events WHERE id=$1 AND event_type='database_task_notification' FOR UPDATE")
      .bind(event_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(|_| retry("Task notification receipt lock failed"))?;
  let Some(row) = row else {
    return Ok(json!({"deliveredCount":0,"droppedCount":0,"reason":"intent_missing"}));
  };
  let mut payload: Value = row
    .try_get("payload")
    .map_err(|_| retry("Task notification receipt decode failed"))?;
  if payload["intent"] != data["intent"] {
    return Err(JobError::Permanent("Task notification intent identity mismatch".into()));
  }
  if payload["deliveryComplete"] == true {
    return Ok(json!({"replayed":true}));
  }
  let projector = NotificationMailProjector::new(state.auth().store.clone())
    .with_services(
      state.workspace().clone(),
      state.doc().clone(),
      state.permission_service(),
    )
    .with_database_repository(repo.clone(), repo);
  let mut delivered = 0;
  let mut dropped = 0;
  for recipient in &intent.recipients {
    let receipt_key = recipient.user_id.to_string();
    if payload["deliveries"].get(&receipt_key).is_some() {
      continue;
    }
    let key = format!("database-task:{event_id}:{}", recipient.user_id);
    let persisted: bool =
      sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM notifications WHERE user_id=$1 AND idempotency_key=$2)")
        .bind(recipient.user_id)
        .bind(&key)
        .fetch_one(pool)
        .await
        .map_err(|_| retry("Task notification Inbox receipt lookup failed"))?;
    if persisted {
      payload["deliveries"][&receipt_key] = json!({"outcome":"delivered"});
      delivered += 1;
      continue;
    }
    let active = state
      .auth()
      .get_user_by_id(recipient.user_id)
      .await
      .map_err(|_| retry("Task notification recipient lookup failed"))?
      .is_some_and(|user| !user.disabled);
    let changed = recipient.kind == DatabaseTaskNotificationKind::Changed;
    let eligible = if active {
      projector
        .current_database_target(
          recipient.user_id,
          intent.workspace_id,
          intent.database_id,
          intent.row_id,
          changed,
          true,
        )
        .await
        .map_err(|_| retry("Task notification eligibility lookup failed"))?
        .is_some()
    } else {
      false
    };
    if !eligible {
      let reason = TaskNotificationDropReason::CurrentTargetOrSubscriptionUnavailable;
      payload["deliveries"][&receipt_key] = json!({"outcome":"dropped","reason":reason.as_str()});
      dropped += 1;
      tracing::info!(%event_id,recipient_id=%recipient.user_id,reason=reason.as_str(),outcome="dropped","database_task_notification");
      continue;
    }
    let body = json!({"workspaceId":intent.workspace_id,"databaseId":intent.database_id,"rowId":intent.row_id,
      "taskNotificationEventId":event_id});
    let notification = if changed {
      state
        .notification()
        .create_in_app_notification(
          recipient.user_id,
          "database.task.changed".into(),
          Some("info".into()),
          key,
          body,
        )
        .await
    } else {
      state
        .notification()
        .create_notification(
          recipient.user_id,
          "database.row.assigned".into(),
          Some("info".into()),
          Some(key),
          body,
        )
        .await
    }
    .map_err(|_| retry("Task notification Inbox persistence failed"))?;
    payload["deliveries"][&receipt_key] = json!({"outcome":"delivered"});
    delivered += 1;
    crate::websocket::publish_user_notification(
      state.redis_ws_adapter().map(AsRef::as_ref),
      recipient.user_id,
      "notification_new",
      json!({"notificationId":notification.id}),
    )
    .await;
  }
  payload["deliveryComplete"] = json!(true);
  sqlx::query("UPDATE outbox_events SET payload=$2 WHERE id=$1")
    .bind(event_id)
    .bind(payload)
    .execute(&mut *tx)
    .await
    .map_err(|_| retry("Task notification outcome write failed"))?;
  tx.commit()
    .await
    .map_err(|_| retry("Task notification outcome commit failed"))?;
  tracing::info!(%event_id,delivered_count=delivered,dropped_count=dropped,"database_task_notification_complete");
  Ok(json!({"deliveredCount":delivered,"droppedCount":dropped}))
}
