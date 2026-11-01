// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Canonical consumption and recoverable enqueue of durable comment intent.

use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::comment::{CommentNotificationIntent, CommentNotificationKind};
use myoxus_domain::entities::Notification;
use myoxus_worker::{JobError, JobOptions, RedisQueue};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::state::ApiState;

fn id(data: &Value, field: &str) -> AuthResult<Uuid> {
  data[field]
    .as_str()
    .and_then(|value| value.parse().ok())
    .ok_or_else(|| AuthError::InvalidInput(format!("comment notification {field} is missing or invalid")))
}

/// Normalize only deployed comment payload shapes. The persisted comment owns
/// its internal document/scope identity, even when the external key is UUID-shaped.
#[tracing::instrument(skip_all)]
pub async fn normalize_pending_comment(state: &ApiState, data: &Value) -> AuthResult<Option<Value>> {
  let Some(comment) = state
    .comment()
    .get_comment(id(data, "commentId")?)
    .await?
    .filter(|comment| comment.deleted_at.is_none())
  else {
    return Ok(None);
  };
  if data["workspaceId"]
    .as_str()
    .is_some_and(|value| value != comment.workspace_id.to_string())
  {
    return Ok(None);
  }
  let canonical_kind = match data["notificationType"].as_str() {
    Some("comment_mention") => Some(CommentNotificationKind::Mention),
    Some("comment_reply") if data.get("parentCommentId").is_none() => Some(CommentNotificationKind::Reply),
    _ => None,
  };
  let intent = if let Some(kind) = canonical_kind {
    CommentNotificationIntent {
      user_id: id(data, "userId")?,
      kind,
    }
  } else {
    let mentioned = data
      .get("mentionedUserId")
      .or_else(|| data.get("userId"))
      .and_then(Value::as_str)
      .and_then(|value| value.parse::<Uuid>().ok());
    if data["isMention"].as_bool() == Some(true) || data.get("mentionedUserId").is_some() {
      let Some(user_id) = mentioned else {
        return Ok(None);
      };
      CommentNotificationIntent {
        user_id,
        kind: CommentNotificationKind::Mention,
      }
    } else {
      let Some(parent_id) = comment.parent_comment_id else {
        return Ok(None);
      };
      let Some(parent) = state.comment().get_comment(parent_id).await?.filter(|parent| {
        parent.deleted_at.is_none() && parent.doc_id == comment.doc_id && parent.workspace_id == comment.workspace_id
      }) else {
        return Ok(None);
      };
      // An old reply and mention may overlap. Apply the same union policy only
      // for this known pending event; unrelated editor mentions stay independent.
      let intents = state
        .comment()
        .notification_intents(
          comment.author_id,
          comment.workspace_id,
          comment.doc_id,
          comment.parent_comment_id,
          &comment.body,
        )
        .await?;
      let Some(intent) = intents.into_iter().find(|intent| intent.user_id == parent.author_id) else {
        return Ok(None);
      };
      intent
    }
  };
  if intent.user_id == comment.author_id {
    return Ok(None);
  }
  Ok(Some(intent.payload(&comment)))
}

async fn persisted_id(pool: &PgPool, data: &Value) -> AuthResult<Option<Uuid>> {
  sqlx::query_scalar("SELECT id FROM notifications WHERE user_id = $1 AND idempotency_key = $2")
    .bind(id(data, "userId")?)
    .bind(data["idempotencyKey"].as_str())
    .fetch_optional(pool)
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))
}

/// A stable Redis job is only a wakeup owner. SQL persistence or an explicit
/// completed suppression reconciles an earlier enqueue/SQL-completion failure.
#[tracing::instrument(skip_all)]
pub async fn enqueue_comment_notification(
  pool: &PgPool,
  queue: &RedisQueue,
  state: &ApiState,
  data: &Value,
) -> AuthResult<()> {
  let Some(data) = normalize_pending_comment(state, data).await? else {
    return Ok(());
  };
  if persisted_id(pool, &data).await?.is_some() {
    return Ok(());
  }
  let key = data["idempotencyKey"]
    .as_str()
    .ok_or_else(|| AuthError::InvalidInput("comment notification key is missing".into()))?;
  if let Some(job) = queue
    .get_job("notification", key)
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?
    && job.finished_on.is_some()
    && job.failed_reason.is_none()
  {
    if job
      .return_value
      .as_ref()
      .is_some_and(|value| value["suppressed"].as_bool() == Some(true))
    {
      return Ok(());
    }
    return Err(AuthError::Storage(
      "completed comment job has no persisted notification outcome".into(),
    ));
  }
  queue
    .enqueue_idempotent(
      "notification",
      key,
      "notification.sendComment",
      data.clone(),
      JobOptions::default(),
    )
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
  Ok(())
}

/// Current recipient access is checked immediately before the single Inbox/mail
/// handoff. No queued title, author name, or client-selected route is persisted.
#[tracing::instrument(skip_all)]
pub async fn dispatch_comment_notification(state: &ApiState, data: &Value) -> Result<Option<Notification>, JobError> {
  let data = normalize_pending_comment(state, data).await.map_err(job_error)?;
  let Some(data) = data else {
    return Ok(None);
  };
  let user_id = id(&data, "userId").map_err(job_error)?;
  if state
    .auth()
    .get_user_by_id(user_id)
    .await
    .map_err(job_error)?
    .is_none_or(|user| user.disabled)
  {
    return Ok(None);
  }
  let workspace_id = id(&data, "workspaceId").map_err(job_error)?;
  let document = state
    .doc()
    .get_metadata(id(&data, "docId").map_err(job_error)?)
    .await
    .map_err(job_error)?;
  let readable = crate::document_access::filter_readable_workspace_documents(
    state,
    user_id,
    workspace_id,
    document.into_iter().collect(),
  )
  .await
  .map_err(job_error)?;
  if readable.is_empty() {
    return Ok(None);
  }
  if let Some(pool) = state.metrics_pool() {
    myoxus_infrastructure::notification::SqlxNotificationRepository::new(pool)
      .adopt_pending_comment_notification(&data)
      .await
      .map_err(job_error)?;
  }
  let notification = state
    .notification()
    .create_notification(
      user_id,
      data["notificationType"].as_str().unwrap_or("comment_reply").into(),
      Some("default".into()),
      data["idempotencyKey"].as_str().map(str::to_string),
      data,
    )
    .await
    .map_err(job_error)?;
  crate::websocket::publish_user_notification(
    state.redis_ws_adapter().map(|adapter| adapter.as_ref()),
    user_id,
    "notification_new",
    json!({"notificationId":notification.id,"notificationType":notification.notification_type}),
  )
  .await;
  Ok(Some(notification))
}

fn job_error(error: AuthError) -> JobError {
  match error {
    AuthError::InvalidInput(message) => JobError::Permanent(message),
    other => JobError::Retryable(other.to_string()),
  }
}
