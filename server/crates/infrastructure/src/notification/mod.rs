//! PostgreSQL-backed notification repository and notification store.
//!
//! [`SqlxNotificationRepository`] implements both [`NotificationRepository`]
//! (the lower-level domain repository trait) and [`NotificationStore`] (the
//! application-layer service port).  The `NotificationStore` implementation
//! uses an `ON CONFLICT (idempotency_key) DO NOTHING`-style upsert to ensure
//! duplicate notifications are never inserted.

pub mod document_change;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use tracing::{error, instrument};
use uuid::Uuid;

use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::notification::{
  NotificationCreateOutcome, NotificationCursor, NotificationListFilter, NotificationListQuery, NotificationStore,
};
use myoxus_domain::entities::Notification;
use myoxus_domain::repositories::{NotificationRepository, PageRequest, RepoResult, RepositoryError};

/// PostgreSQL-backed implementation of [`NotificationRepository`] and
/// [`NotificationStore`].
pub struct SqlxNotificationRepository {
  /// Database connection pool.
  pool: PgPool,
}

impl SqlxNotificationRepository {
  /// Construct a `SqlxNotificationRepository` from an existing pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  /// Adopt only an already-persisted row associated with a deployed pending
  /// comment event. Its read state, ID and timestamps remain unchanged; replay
  /// then follows the ordinary inserted/existing outcome without another email.
  pub async fn adopt_pending_comment_notification(&self, data: &serde_json::Value) -> AuthResult<()> {
    let parse = |field: &str| {
      data[field]
        .as_str()
        .and_then(|value| value.parse::<Uuid>().ok())
        .ok_or_else(|| AuthError::InvalidInput(format!("invalid comment notification {field}")))
    };
    let user_id = parse("userId")?;
    let doc_id = parse("docId")?;
    let comment_id = parse("commentId")?;
    let author_id = parse("authorId")?;
    let keys = vec![
      format!("mention:{user_id}:{doc_id}:{comment_id}:{author_id}"),
      format!("comment_reply:{user_id}:{comment_id}"),
    ];
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err_auth)?;
    let rows = sqlx::query(
      "SELECT id, idempotency_key, notification_type, read_at FROM notifications
      WHERE user_id = $1 AND (idempotency_key = $2 OR idempotency_key = ANY($3))
      ORDER BY id FOR UPDATE",
    )
    .bind(user_id)
    .bind(data["idempotencyKey"].as_str())
    .bind(&keys)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_db_err_auth)?;
    if let Some(row) = rows
      .iter()
      .find(|row| row.get::<Option<String>, _>("idempotency_key").as_deref() == data["idempotencyKey"].as_str())
      .or_else(|| {
        rows
          .iter()
          .find(|row| row.get::<String, _>("notification_type") == "mention")
      })
      .or_else(|| rows.first())
    {
      let notification_id: Uuid = row.get("id");
      let read_at = rows
        .iter()
        .filter_map(|row| row.get::<Option<DateTime<Utc>>, _>("read_at"))
        .min();
      let mut payload = data.clone();
      if rows.iter().any(|row| {
        matches!(
          row.get::<String, _>("notification_type").as_str(),
          "mention" | "comment_mention"
        )
      }) {
        payload["notificationType"] = serde_json::json!("comment_mention");
      }
      sqlx::query(
        "UPDATE notifications SET idempotency_key = $2, notification_type = $3,
          payload = $4, read_at = COALESCE(read_at, $5) WHERE id = $1",
      )
      .bind(notification_id)
      .bind(data["idempotencyKey"].as_str())
      .bind(payload["notificationType"].as_str())
      .bind(&payload)
      .bind(read_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err_auth)?;
      // Only this pending comment/recipient's exact deployed keys are merged.
      // Reading either duplicate preserves a read canonical row.
      sqlx::query("DELETE FROM notifications WHERE user_id = $1 AND id <> $2 AND idempotency_key = ANY($3)")
        .bind(user_id)
        .bind(notification_id)
        .bind(keys)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err_auth)?;
    }
    tx.commit().await.map_err(Self::map_db_err_auth)?;
    Ok(())
  }

  /// Share the canonical INSERT with transaction-owned in-app completion.
  pub(crate) async fn insert_notification<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Postgres>,
    user_id: Uuid,
    notification_type: String,
    notification_level: String,
    idempotency_key: Option<String>,
    payload: serde_json::Value,
    now: DateTime<Utc>,
  ) -> AuthResult<NotificationCreateOutcome> {
    let inserted_id = Uuid::new_v4();
    let row = sqlx::query(
            r#"
            INSERT INTO notifications (
                id, user_id, notification_type, notification_level, idempotency_key, payload, read_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $7)
            ON CONFLICT (idempotency_key) DO UPDATE
                SET idempotency_key = notifications.idempotency_key
            RETURNING id, user_id, notification_type, notification_level, idempotency_key, payload, read_at, created_at, updated_at
            "#
        )
        .bind(inserted_id)
        .bind(user_id)
        .bind(notification_type)
        .bind(notification_level)
        .bind(idempotency_key)
        .bind(payload)
        .bind(now)
        .fetch_one(executor)
        .await
        .map_err(Self::map_db_err_auth)?;
    let notification = Self::map_row(row);
    let inserted = notification.id == inserted_id;
    Ok(NotificationCreateOutcome { notification, inserted })
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in notification repository");
    RepositoryError::Storage(err.to_string())
  }

  fn map_db_err_auth(err: sqlx::Error) -> AuthError {
    error!(error = %err, "database error in notification store");
    AuthError::Storage(err.to_string())
  }

  fn map_row(row: sqlx::postgres::PgRow) -> Notification {
    Notification {
      id: row.get("id"),
      user_id: row.get("user_id"),
      notification_type: row.get("notification_type"),
      notification_level: row.get("notification_level"),
      idempotency_key: row.get("idempotency_key"),
      payload: row.get("payload"),
      read_at: row.get("read_at"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    }
  }
}

#[async_trait]
impl NotificationRepository for SqlxNotificationRepository {
  #[instrument(skip(self, notification))]
  async fn create_notification(&self, notification: &Notification) -> RepoResult<Notification> {
    let row = sqlx::query(
            r#"
            INSERT INTO notifications (
                id, user_id, notification_type, notification_level, idempotency_key, payload, read_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, user_id, notification_type, notification_level, idempotency_key, payload, read_at, created_at, updated_at
            "#
        )
        .bind(notification.id)
        .bind(notification.user_id)
        .bind(&notification.notification_type)
        .bind(&notification.notification_level)
        .bind(&notification.idempotency_key)
        .bind(notification.payload.clone())
        .bind(notification.read_at)
        .bind(notification.created_at)
        .bind(notification.updated_at)
        .fetch_one(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    Ok(Self::map_row(row))
  }

  #[instrument(skip(self))]
  async fn list_notifications(&self, user_id: Uuid, page: PageRequest) -> RepoResult<Vec<Notification>> {
    let rows = sqlx::query(
            r#"
            SELECT id, user_id, notification_type, notification_level, idempotency_key, payload, read_at, created_at, updated_at
            FROM notifications
            WHERE user_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT $2 OFFSET $3
            "#
        )
        .bind(user_id)
        .bind(page.limit)
        .bind(page.offset)
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self))]
  async fn mark_notification_read(&self, notification_id: Uuid, at: DateTime<Utc>) -> RepoResult<()> {
    let result = sqlx::query(
      r#"
            UPDATE notifications
            SET read_at = COALESCE(read_at, $2), updated_at = GREATEST(updated_at, $2)
            WHERE id = $1
            "#,
    )
    .bind(notification_id)
    .bind(at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("notification"));
    }
    Ok(())
  }

  #[instrument(skip(self))]
  async fn mark_all_notifications_read(&self, user_id: Uuid, at: DateTime<Utc>) -> RepoResult<()> {
    sqlx::query(
      r#"
            UPDATE notifications
            SET read_at = COALESCE(read_at, $2), updated_at = GREATEST(updated_at, $2)
            WHERE user_id = $1 AND read_at IS NULL
            "#,
    )
    .bind(user_id)
    .bind(at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }
}

#[async_trait]
impl NotificationStore for SqlxNotificationRepository {
  #[instrument(skip(self, payload))]
  async fn create_notification(
    &self,
    user_id: Uuid,
    notification_type: String,
    notification_level: String,
    idempotency_key: Option<String>,
    payload: serde_json::Value,
    now: DateTime<Utc>,
  ) -> AuthResult<NotificationCreateOutcome> {
    Self::insert_notification(
      &self.pool,
      user_id,
      notification_type,
      notification_level,
      idempotency_key,
      payload,
      now,
    )
    .await
  }

  #[instrument(skip(self))]
  async fn list_notifications(&self, user_id: Uuid, query: NotificationListQuery) -> AuthResult<Vec<Notification>> {
    let after_created_at = query
      .after
      .as_ref()
      .map(|cursor: &NotificationCursor| cursor.created_at);
    let after_id = query.after.as_ref().map(|cursor: &NotificationCursor| cursor.id);
    let notification_types = query.filter.notification_types;

    let rows = sqlx::query(
            r#"
            SELECT id, user_id, notification_type, notification_level, idempotency_key, payload, read_at, created_at, updated_at
            FROM notifications
            WHERE user_id = $1
              AND ($2::bool OR read_at IS NULL)
              AND ($3::text[] IS NULL OR notification_type = ANY($3))
              AND (
                $4::timestamptz IS NULL
                OR (created_at, id) < ($4, $5)
              )
            ORDER BY created_at DESC, id DESC
            LIMIT $6 OFFSET $7
            "#
        )
        .bind(user_id)
        .bind(query.filter.include_read)
        .bind(notification_types)
        .bind(after_created_at)
        .bind(after_id)
        .bind(query.fetch_limit)
        .bind(query.offset)
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err_auth)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self))]
  async fn count_notifications(&self, user_id: Uuid, filter: &NotificationListFilter) -> AuthResult<i64> {
    let count: i64 = sqlx::query_scalar(
      r#"
            SELECT COUNT(*)::bigint
            FROM notifications
            WHERE user_id = $1
              AND ($2::bool OR read_at IS NULL)
              AND ($3::text[] IS NULL OR notification_type = ANY($3))
            "#,
    )
    .bind(user_id)
    .bind(filter.include_read)
    .bind(&filter.notification_types)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;
    Ok(count)
  }

  #[instrument(skip(self))]
  async fn mark_notification_read(
    &self,
    user_id: Uuid,
    notification_id: Uuid,
    read_at: DateTime<Utc>,
  ) -> AuthResult<bool> {
    let result = sqlx::query(
      r#"
            UPDATE notifications
            SET read_at = COALESCE(read_at, $3), updated_at = GREATEST(updated_at, $3)
            WHERE id = $1 AND user_id = $2
            "#,
    )
    .bind(notification_id)
    .bind(user_id)
    .bind(read_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;
    Ok(result.rows_affected() > 0)
  }

  #[instrument(skip(self))]
  async fn mark_all_notifications_read(&self, user_id: Uuid, read_at: DateTime<Utc>) -> AuthResult<i64> {
    let result = sqlx::query(
      r#"
            UPDATE notifications
            SET read_at = COALESCE(read_at, $2), updated_at = GREATEST(updated_at, $2)
            WHERE user_id = $1 AND read_at IS NULL
            "#,
    )
    .bind(user_id)
    .bind(read_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err_auth)?;
    Ok(result.rows_affected() as i64)
  }
}
