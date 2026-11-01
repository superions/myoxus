// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL adapter for bounded cross-capability retention rules.

use async_trait::async_trait;
use sqlx::PgPool;

use myoxus_application::{
  auth::{AuthError, AuthResult},
  maintenance::RetentionRepository,
};

const BATCH_LIMIT: i64 = 5000;

pub struct SqlxRetentionRepository {
  pool: PgPool,
}

impl SqlxRetentionRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  async fn drain_document_histories(&self, days: i64) -> AuthResult<u64> {
    let days = i32::try_from(days).unwrap_or(i32::MAX);
    let mut total = 0;
    let mut contended_retries = 0;
    loop {
      let result = sqlx::query(
        "WITH candidates AS (
           SELECT h.id
           FROM doc_histories h
           WHERE h.created_at < NOW() - make_interval(days => $1)
             AND NOT EXISTS (
               SELECT 1 FROM document_version v WHERE v.doc_history_id = h.id
             )
           ORDER BY h.id
           FOR UPDATE OF h SKIP LOCKED
           LIMIT $2
         )
         DELETE FROM doc_histories h
         USING candidates c
         WHERE h.id = c.id",
      )
      .bind(days)
      .bind(BATCH_LIMIT)
      .execute(&self.pool)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
      let affected = result.rows_affected();
      total += affected;
      if affected > 0 {
        contended_retries = 0;
      } else {
        let remaining: bool = sqlx::query_scalar(
          "SELECT EXISTS (
             SELECT 1 FROM doc_histories h
             WHERE h.created_at < NOW() - make_interval(days => $1)
               AND NOT EXISTS (
                 SELECT 1 FROM document_version v WHERE v.doc_history_id = h.id
               )
           )",
        )
        .bind(days)
        .fetch_one(&self.pool)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()))?;
        if !remaining || contended_retries >= 2 {
          return Ok(total);
        }
        contended_retries += 1;
      }
      tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
  }

  async fn drain(&self, operation: RetentionOperation) -> AuthResult<u64> {
    let mut total = 0;
    loop {
      let result = match operation {
        RetentionOperation::Sessions => {
          sqlx::query("DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at < NOW() LIMIT $1)")
            .bind(BATCH_LIMIT)
            .execute(&self.pool)
            .await
        }
        RetentionOperation::Notifications(days) => {
          // Preserve inserted-only Task delivery evidence until its outbox
          // receipt is terminal, including a crash after optional SMTP delivery.
          sqlx::query(
            "DELETE FROM notifications WHERE id IN (SELECT id FROM notifications \
           WHERE created_at < NOW() - make_interval(days => $1) \
             AND NOT (notification_type IN ('database.row.assigned', 'database.task.changed') \
               AND EXISTS (SELECT 1 FROM outbox_events event \
                 WHERE event.id::text = notifications.payload->>'taskNotificationEventId' \
                   AND event.event_type='database_task_notification' \
                   AND event.payload->'deliveryComplete' IS DISTINCT FROM 'true'::jsonb)) LIMIT $2)",
          )
          .bind(i32::try_from(days).unwrap_or(i32::MAX))
          .bind(BATCH_LIMIT)
          .execute(&self.pool)
          .await
        }
        RetentionOperation::PendingBlobs(hours) => {
          sqlx::query(
            "DELETE FROM blobs WHERE ctid IN (SELECT ctid FROM blobs WHERE status = 'pending' \
           AND created_at < NOW() - make_interval(hours => $1) LIMIT $2)",
          )
          .bind(i32::try_from(hours).unwrap_or(i32::MAX))
          .bind(BATCH_LIMIT)
          .execute(&self.pool)
          .await
        }
        RetentionOperation::ProcessedOutbox(days) => {
          // Task handoff is acknowledged before delivery. Preserve its replay
          // receipt until the worker durably records delivery or terminal drop.
          sqlx::query(
            "DELETE FROM outbox_events WHERE id IN (SELECT id FROM outbox_events \
           WHERE processed_at IS NOT NULL AND processed_at < NOW() - make_interval(days => $1) \
           AND (event_type <> 'database_task_notification' OR payload->'deliveryComplete' = 'true'::jsonb) LIMIT $2)",
          )
          .bind(i32::try_from(days).unwrap_or(i32::MAX))
          .bind(BATCH_LIMIT)
          .execute(&self.pool)
          .await
        }
        RetentionOperation::MergedDocumentUpdates => {
          sqlx::query(
            "DELETE FROM doc_updates WHERE id IN (SELECT du.id FROM doc_updates du \
           JOIN doc_snapshots ds ON du.doc_id = ds.doc_id WHERE du.sequence <= ds.last_sequence LIMIT $1)",
          )
          .bind(BATCH_LIMIT)
          .execute(&self.pool)
          .await
        }
        RetentionOperation::OrphanedSessionLinks => {
          sqlx::query(
            "DELETE FROM session_links WHERE session_id IN (SELECT sl.session_id FROM session_links sl \
           WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = sl.session_id) \
              OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = sl.root_session_id) LIMIT $1)",
          )
          .bind(BATCH_LIMIT)
          .execute(&self.pool)
          .await
        }
      }
      .map_err(|error| AuthError::Storage(error.to_string()))?;
      let affected = result.rows_affected();
      total += affected;
      if affected == 0 {
        return Ok(total);
      }
      tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
  }
}

#[derive(Clone, Copy)]
enum RetentionOperation {
  Sessions,
  Notifications(i64),
  PendingBlobs(i64),
  ProcessedOutbox(i64),
  MergedDocumentUpdates,
  OrphanedSessionLinks,
}

#[async_trait]
impl RetentionRepository for SqlxRetentionRepository {
  async fn clean_expired_sessions(&self) -> AuthResult<u64> {
    self.drain(RetentionOperation::Sessions).await
  }

  async fn clean_document_histories(&self, retention_days: i64) -> AuthResult<u64> {
    self.drain_document_histories(retention_days).await
  }

  async fn clean_notifications(&self, retention_days: i64) -> AuthResult<u64> {
    self.drain(RetentionOperation::Notifications(retention_days)).await
  }

  async fn clean_pending_blobs(&self, retention_hours: i64) -> AuthResult<u64> {
    self.drain(RetentionOperation::PendingBlobs(retention_hours)).await
  }

  async fn clean_processed_outbox_events(&self, retention_days: i64) -> AuthResult<u64> {
    self.drain(RetentionOperation::ProcessedOutbox(retention_days)).await
  }

  async fn clean_merged_document_updates(&self) -> AuthResult<u64> {
    self.drain(RetentionOperation::MergedDocumentUpdates).await
  }

  async fn clean_orphaned_session_links(&self) -> AuthResult<u64> {
    self.drain(RetentionOperation::OrphanedSessionLinks).await
  }
}
