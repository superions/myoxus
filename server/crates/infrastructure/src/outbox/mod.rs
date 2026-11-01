//! PostgreSQL-backed transactional outbox: repository and event publisher.
//!
//! [`SqlxOutboxRepository`] implements the low-level persistence operations
//! (enqueue, list unprocessed, mark processed).  [`SqlxOutboxEventPublisher`]
//! wraps the repository and implements the application-layer
//! [`EventPublisher`] port, mapping domain event types to their string
//! representations in the `outbox_events` table.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use tracing::{error, instrument};
use uuid::Uuid;

use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::events::{EventPublisher, WorkspaceDocumentBroadcastPublisher};
use myoxus_domain::entities::{OutboxEvent, OutboxEventType};
use myoxus_domain::repositories::{OutboxRepository, PageRequest, RepoResult, RepositoryError};

/// PostgreSQL-backed implementation of [`OutboxRepository`].
pub struct SqlxOutboxRepository {
  /// Database connection pool.
  pool: PgPool,
}

impl SqlxOutboxRepository {
  /// Construct a `SqlxOutboxRepository` from an existing pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in outbox repository");
    RepositoryError::Storage(err.to_string())
  }

  fn map_row(row: sqlx::postgres::PgRow) -> RepoResult<OutboxEvent> {
    let raw_event_type: String = row.get("event_type");
    let event_type = match raw_event_type.as_str() {
      "mention" => OutboxEventType::Mention,
      "invite" => OutboxEventType::Invite,
      "comment_reply" => OutboxEventType::CommentReply,
      "access_change" => OutboxEventType::AccessChange,
      "doc_updated" => OutboxEventType::DocUpdated,
      "workspace_doc_broadcast" => OutboxEventType::WorkspaceDocBroadcast,
      "workspace_content_published" => OutboxEventType::WorkspaceContentPublished,
      "history_captured" => OutboxEventType::HistoryCaptured,
      "calendar_mail" => OutboxEventType::CalendarMail,
      "database_task_notification" => OutboxEventType::DatabaseTaskNotification,
      "workspace_automation_trigger" => OutboxEventType::WorkspaceAutomationTrigger,
      "workspace_automation_signal" => OutboxEventType::WorkspaceAutomationSignal,
      _ => {
        return Err(RepositoryError::Validation(format!(
          "unknown outbox event type: {raw_event_type}"
        )));
      }
    };
    Ok(OutboxEvent {
      id: row.get("id"),
      aggregate_type: row.get("aggregate_type"),
      aggregate_id: row.get("aggregate_id"),
      event_type,
      payload: row.get("payload"),
      created_at: row.get("created_at"),
      processed_at: row.get("processed_at"),
    })
  }

  /// Deliver one committed page-change event to the existing search queue.
  ///
  /// Holding the outbox claim through enqueue makes an unavailable Redis retryable.
  /// A lost enqueue acknowledgement may deliver twice; deferred jobs read the same
  /// current native leaf and upsert its single search row. No editor open is needed.
  #[instrument(skip_all, fields(%event_id), err)]
  pub async fn process_document_search_update(
    &self,
    event_id: Uuid,
    publisher: &dyn myoxus_application::events::DocumentSearchUpdatePublisher,
  ) -> AuthResult<()> {
    let mut transaction = self
      .pool
      .begin()
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    let event = sqlx::query(
      "SELECT payload FROM outbox_events WHERE id=$1 AND event_type='doc_updated'
       AND processed_at IS NULL FOR UPDATE SKIP LOCKED",
    )
    .bind(event_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    if let Some(event) = event {
      let payload: serde_json::Value = event.get("payload");
      let parse_identity = |name: &str| {
        payload[name]
          .as_str()
          .and_then(|value| value.parse::<Uuid>().ok())
          .ok_or_else(|| AuthError::Storage("document search event has an invalid identity".into()))
      };
      let workspace_id = parse_identity("workspaceId")?;
      let doc_id = parse_identity("docId")?;
      // Snapshot events also cover technical roots and Organizer state. Only a
      // current ordinary workspace page may enter document search; historical
      // source-workspace events after a move must not index the new owner's data.
      let eligible: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM docs d LEFT JOIN page_registration_evidence e
         ON e.workspace_id=d.workspace_id AND e.doc_id=d.id WHERE d.workspace_id=$1 AND d.id=$2
         AND d.userspace_owner_id IS NULL AND d.deleted_at IS NULL AND NOT d.is_workspace_root
         AND d.id<>d.workspace_id AND d.external_id NOT LIKE 'db$%'
         AND d.external_id NOT LIKE 'userdata$%' AND COALESCE(e.state,'legacy')<>'deleted')",
      )
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_one(&mut *transaction)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
      if eligible {
        publisher.enqueue_search_update(workspace_id, doc_id).await?;
      }
      sqlx::query("UPDATE outbox_events SET processed_at=now() WHERE id=$1")
        .bind(event_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()))?;
    }
    transaction
      .commit()
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))
  }

  /// Process one workspace-document broadcast while retaining its row lock
  /// through canonical update resolution, publication and completion.
  pub async fn process_next_workspace_document_broadcast(
    &self,
    publisher: &dyn WorkspaceDocumentBroadcastPublisher,
  ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let mut transaction = self.pool.begin().await?;
    let row = sqlx::query(
      "SELECT id, payload FROM outbox_events \
       WHERE processed_at IS NULL AND event_type = 'workspace_doc_broadcast' \
       ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1",
    )
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(row) = row else {
      transaction.commit().await?;
      return Ok(false);
    };

    let event_id: Uuid = row.get("id");
    let payload: serde_json::Value = row.get("payload");
    let workspace_id = required_uuid(&payload, "workspaceId")?;
    let updates = broadcast_update_references(&payload)?;
    let actor_user_id = payload
      .get("actorUserId")
      .and_then(serde_json::Value::as_str)
      .map(str::parse::<Uuid>)
      .transpose()?
      .unwrap_or_else(Uuid::nil);
    let lifecycle_operation = payload.get("lifecycleOperation").and_then(serde_json::Value::as_str);
    let prior_attempts = payload
      .get("deliveryAttempts")
      .and_then(serde_json::Value::as_u64)
      .unwrap_or(0);

    let mut resolved_updates = Vec::with_capacity(updates.len());
    for reference in &updates {
      let row = sqlx::query(
        "SELECT doc_updates.payload, docs.external_id FROM doc_updates \
         INNER JOIN docs ON docs.id = doc_updates.doc_id AND docs.workspace_id = doc_updates.workspace_id \
         WHERE doc_updates.workspace_id = $1 AND doc_updates.doc_id = $2 AND doc_updates.sequence = $3",
      )
      .bind(workspace_id)
      .bind(reference.doc_id)
      .bind(reference.sequence)
      .fetch_optional(&mut *transaction)
      .await?;
      let Some(row) = row else {
        sqlx::query("UPDATE outbox_events SET processed_at = now() WHERE id = $1")
          .bind(event_id)
          .execute(&mut *transaction)
          .await?;
        transaction.commit().await?;
        publisher.record_outcome("dropped");
        tracing::warn!(%event_id, %workspace_id, "dropped stale workspace document broadcast");
        if let Some(operation) = lifecycle_operation {
          tracing::warn!(
            operation,
            update_count = updates.len(),
            outcome = "dropped",
            "page_lifecycle.broadcast"
          );
        }
        return Ok(true);
      };
      resolved_updates.push((row.get::<String, _>("external_id"), row.get::<Vec<u8>, _>("payload")));
    }

    for (document_key, update) in &resolved_updates {
      if let Err(error) = publisher
        .publish(workspace_id, document_key, update, actor_user_id)
        .await
      {
        transaction.rollback().await?;
        sqlx::query(
          "UPDATE outbox_events SET payload = jsonb_set(payload, '{deliveryAttempts}', \
           to_jsonb(COALESCE((payload->>'deliveryAttempts')::bigint, 0) + 1), true) \
           WHERE id = $1 AND processed_at IS NULL",
        )
        .bind(event_id)
        .execute(&self.pool)
        .await?;
        publisher.record_outcome("failed");
        if let Some(operation) = lifecycle_operation {
          tracing::warn!(
            operation,
            update_count = updates.len(),
            outcome = "failed",
            "page_lifecycle.broadcast"
          );
        }
        return Err(std::io::Error::other(error).into());
      }
    }

    sqlx::query("UPDATE outbox_events SET processed_at = now() WHERE id = $1")
      .bind(event_id)
      .execute(&mut *transaction)
      .await?;
    transaction.commit().await?;
    let outcome = if prior_attempts > 0 { "replayed" } else { "published" };
    publisher.record_outcome(outcome);
    if let Some(operation) = lifecycle_operation {
      tracing::info!(
        operation,
        update_count = updates.len(),
        outcome,
        "page_lifecycle.broadcast"
      );
    }
    Ok(true)
  }
}

#[derive(Clone, Copy)]
struct BroadcastUpdateReference {
  doc_id: Uuid,
  sequence: i64,
}

fn broadcast_update_references(
  payload: &serde_json::Value,
) -> Result<Vec<BroadcastUpdateReference>, Box<dyn std::error::Error + Send + Sync>> {
  if let Some(updates) = payload.get("updates").and_then(serde_json::Value::as_array) {
    if updates.is_empty() {
      return Err(invalid_broadcast_payload("updates").into());
    }
    return updates
      .iter()
      .map(|reference| {
        Ok(BroadcastUpdateReference {
          doc_id: required_uuid(reference, "docId")?,
          sequence: reference
            .get("sequence")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| invalid_broadcast_payload("updates[].sequence"))?,
        })
      })
      .collect();
  }
  Ok(vec![BroadcastUpdateReference {
    doc_id: required_uuid(payload, "docId")?,
    sequence: payload
      .get("sequence")
      .and_then(serde_json::Value::as_i64)
      .ok_or_else(|| invalid_broadcast_payload("sequence"))?,
  }])
}

fn required_uuid(
  payload: &serde_json::Value,
  field: &'static str,
) -> Result<Uuid, Box<dyn std::error::Error + Send + Sync>> {
  Ok(
    payload
      .get(field)
      .and_then(serde_json::Value::as_str)
      .ok_or_else(|| invalid_broadcast_payload(field))?
      .parse::<Uuid>()?,
  )
}

fn invalid_broadcast_payload(field: &'static str) -> std::io::Error {
  std::io::Error::new(
    std::io::ErrorKind::InvalidData,
    format!("workspace_doc_broadcast missing {field}"),
  )
}

#[async_trait]
impl OutboxRepository for SqlxOutboxRepository {
  #[instrument(skip(self, event))]
  async fn enqueue_event(&self, event: &OutboxEvent) -> RepoResult<OutboxEvent> {
    let event_type = match event.event_type {
      OutboxEventType::Mention => "mention",
      OutboxEventType::Invite => "invite",
      OutboxEventType::CommentReply => "comment_reply",
      OutboxEventType::AccessChange => "access_change",
      OutboxEventType::DocUpdated => "doc_updated",
      OutboxEventType::WorkspaceDocBroadcast => "workspace_doc_broadcast",
      OutboxEventType::WorkspaceContentPublished => "workspace_content_published",
      OutboxEventType::HistoryCaptured => "history_captured",
      OutboxEventType::CalendarMail => "calendar_mail",
      OutboxEventType::DatabaseTaskNotification => "database_task_notification",
      OutboxEventType::WorkspaceAutomationTrigger => "workspace_automation_trigger",
      OutboxEventType::WorkspaceAutomationSignal => "workspace_automation_signal",
    };
    let row = sqlx::query(
      r#"
            INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, created_at, processed_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, aggregate_type, aggregate_id, event_type, payload, created_at, processed_at
            "#,
    )
    .bind(event.id)
    .bind(&event.aggregate_type)
    .bind(&event.aggregate_id)
    .bind(event_type)
    .bind(event.payload.clone())
    .bind(event.created_at)
    .bind(event.processed_at)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Self::map_row(row)
  }

  #[instrument(skip(self))]
  async fn list_unprocessed_events(&self, page: PageRequest) -> RepoResult<Vec<OutboxEvent>> {
    let rows = sqlx::query(
      r#"
            SELECT id, aggregate_type, aggregate_id, event_type, payload, created_at, processed_at
            FROM outbox_events
            WHERE processed_at IS NULL
            ORDER BY created_at ASC
            LIMIT $1 OFFSET $2
            "#,
    )
    .bind(page.limit)
    .bind(page.offset)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    rows.into_iter().map(Self::map_row).collect()
  }

  #[instrument(skip(self))]
  async fn list_unprocessed_non_document_broadcast_events(&self, page: PageRequest) -> RepoResult<Vec<OutboxEvent>> {
    let rows = sqlx::query(
      r#"
      SELECT id, aggregate_type, aggregate_id, event_type, payload, created_at, processed_at
      FROM outbox_events
      WHERE processed_at IS NULL AND event_type <> 'workspace_doc_broadcast'
      ORDER BY created_at ASC
      LIMIT $1 OFFSET $2
      "#,
    )
    .bind(page.limit)
    .bind(page.offset)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    rows.into_iter().map(Self::map_row).collect()
  }

  #[instrument(skip(self))]
  async fn mark_event_processed(&self, event_id: Uuid, processed_at: DateTime<Utc>) -> RepoResult<()> {
    let result = sqlx::query("UPDATE outbox_events SET processed_at = $2 WHERE id = $1")
      .bind(event_id)
      .bind(processed_at)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("outbox_event"));
    }
    Ok(())
  }
}

/// [`EventPublisher`] port backed by [`SqlxOutboxRepository`].
///
/// Translates domain event types to string tags stored in the
/// `outbox_events.event_type` column.
#[derive(Clone)]
pub struct SqlxOutboxEventPublisher {
  /// Shared reference to the underlying outbox repository.
  repo: std::sync::Arc<SqlxOutboxRepository>,
}

impl SqlxOutboxEventPublisher {
  /// Construct a `SqlxOutboxEventPublisher` around a new repository wrapping
  /// `pool`.
  pub fn new(pool: PgPool) -> Self {
    Self {
      repo: std::sync::Arc::new(SqlxOutboxRepository::new(pool)),
    }
  }
}

#[async_trait]
impl EventPublisher for SqlxOutboxEventPublisher {
  #[instrument(skip(self, payload))]
  async fn publish(
    &self,
    aggregate_type: &str,
    aggregate_id: &str,
    event_type: OutboxEventType,
    payload: serde_json::Value,
  ) -> AuthResult<()> {
    self
      .repo
      .enqueue_event(&OutboxEvent {
        id: Uuid::new_v4(),
        aggregate_type: aggregate_type.to_string(),
        aggregate_id: aggregate_id.to_string(),
        event_type,
        payload,
        created_at: Utc::now(),
        processed_at: None,
      })
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?;
    Ok(())
  }
}
