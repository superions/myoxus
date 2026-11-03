//! SQLx-backed calendar repository implementation.
//!
//! [`SqlxCalendarRepository`] implements the [`CalendarRepository`] domain trait
//! against PostgreSQL. It covers calendar accounts, subscriptions, events,
//! participants, reminders, and workspace-level calendar associations.

mod lifecycle;
mod mail_delivery;
mod mail_intent;
mod projection;
mod reminders;

#[cfg(test)]
pub(crate) mod test_support;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::pool::PoolConnection;
use sqlx::{Acquire, PgPool, Postgres, Row};
use tracing::{error, instrument};
use uuid::Uuid;

use myoxus_domain::entities::{
  CalendarAccount, CalendarDeleteSnapshot, CalendarEvent, CalendarEventInstance, CalendarEventOrigin,
  CalendarEventParticipant, CalendarEventTag, CalendarPendingWrite, CalendarReminder, CalendarReminderContext,
  CalendarSubscription, WorkspaceCalendar, WorkspaceCalendarSettings,
};
use myoxus_domain::repositories::{
  CalendarEventSourceAnchor, CalendarPendingWriteGuard, CalendarRepository, CalendarSplitWrite, NativeEventInput,
  NativeEventUpdate, RepoResult, RepositoryError,
};

struct PgCalendarPendingWriteGuard {
  connection: Option<PoolConnection<Postgres>>,
  event_id: Uuid,
}

impl Drop for PgCalendarPendingWriteGuard {
  fn drop(&mut self) {
    if let Some(connection) = self.connection.as_mut() {
      connection.close_on_drop();
    }
  }
}

#[async_trait]
impl CalendarPendingWriteGuard for PgCalendarPendingWriteGuard {
  async fn detach_delete_intent_and_delete_event(
    &mut self,
    event_id: Uuid,
    snapshot: &CalendarDeleteSnapshot,
  ) -> RepoResult<CalendarPendingWrite> {
    snapshot
      .validate()
      .map_err(|message| RepositoryError::Validation(message.to_string()))?;
    if snapshot.source_event_id != event_id || self.event_id != event_id {
      return Err(RepositoryError::Validation(
        "calendar delete snapshot source does not match guarded event".to_string(),
      ));
    }
    let payload = serde_json::to_value(snapshot).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let connection = self
      .connection
      .as_mut()
      .ok_or_else(|| RepositoryError::Storage("calendar pending-write guard already released".to_string()))?;
    let mut tx = connection.begin().await.map_err(SqlxCalendarRepository::map_db_err)?;
    let row = sqlx::query(
      r#"
      INSERT INTO calendar_pending_writes (event_id, operation, payload, next_retry_at)
      VALUES (NULL, 'delete', $1, now())
      RETURNING id, event_id, operation, payload, created_at, retry_count, next_retry_at, last_error
      "#,
    )
    .bind(payload)
    .fetch_one(&mut *tx)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?;
    if let Some(event) = mail_intent::load_event(&mut tx, event_id).await? {
      mail_intent::enqueue(&mut tx, &event, "calendar-cancellation", None).await?;
    }
    let deleted = sqlx::query("DELETE FROM calendar_events WHERE id = $1")
      .bind(event_id)
      .execute(&mut *tx)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
    if deleted.rows_affected() != 1 {
      return Err(RepositoryError::NotFound("calendar_event"));
    }
    tx.commit().await.map_err(SqlxCalendarRepository::map_db_err)?;
    Ok(SqlxCalendarRepository::map_pending_write(row))
  }

  async fn delete_calendar_event(&mut self, event_id: Uuid) -> RepoResult<()> {
    if self.event_id != event_id {
      return Err(RepositoryError::Validation(
        "calendar delete target does not match guarded event".to_string(),
      ));
    }
    let connection = self
      .connection
      .as_mut()
      .ok_or_else(|| RepositoryError::Storage("calendar pending-write guard already released".to_string()))?;
    let mut tx = connection.begin().await.map_err(SqlxCalendarRepository::map_db_err)?;
    if let Some(event) = mail_intent::load_event(&mut tx, event_id).await? {
      mail_intent::enqueue(&mut tx, &event, "calendar-cancellation", None).await?;
    }
    sqlx::query("DELETE FROM calendar_events WHERE id = $1")
      .bind(event_id)
      .execute(&mut *tx)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
    tx.commit().await.map_err(SqlxCalendarRepository::map_db_err)?;
    Ok(())
  }

  async fn release(mut self: Box<Self>) -> RepoResult<()> {
    let connection = self
      .connection
      .as_mut()
      .ok_or_else(|| RepositoryError::Storage("calendar pending-write guard already released".to_string()))?;
    let lock_key = format!("myoxus:calendar:event:{}", self.event_id);
    let unlocked: bool = sqlx::query_scalar("SELECT pg_advisory_unlock(hashtextextended($1, 0))")
      .bind(lock_key)
      .fetch_one(&mut **connection)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
    if !unlocked {
      self
        .connection
        .as_mut()
        .expect("calendar pending-write guard retains its connection through unlock")
        .close_on_drop();
      let connection = self
        .connection
        .take()
        .expect("calendar pending-write guard retains its connection through unlock");
      connection.close().await.map_err(SqlxCalendarRepository::map_db_err)?;
      return Err(RepositoryError::Storage(
        "calendar pending-write guard was not held by its connection".to_string(),
      ));
    }
    drop(self.connection.take());
    Ok(())
  }
}

/// PostgreSQL-backed implementation of [`CalendarRepository`].
pub struct SqlxCalendarRepository {
  /// Database connection pool.
  pool: PgPool,
}

impl SqlxCalendarRepository {
  /// Construct a `SqlxCalendarRepository` from an existing pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  async fn persist_authored_event_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event: &CalendarEvent,
    participants: &[CalendarEventParticipant],
    reminders: &[CalendarReminder],
  ) -> RepoResult<CalendarEvent> {
    let mut event = event.clone();
    if let Some(payload) = event.payload.as_object_mut() {
      payload.remove("_myoxusCalendarTiming");
    }
    lifecycle::normalize_export_echo_in(tx, &mut event).await?;
    let row = if event.origin == CalendarEventOrigin::Native {
      sqlx::query(r#"
  INSERT INTO calendar_events(id,origin,workspace_id,title,description_delta,starts_at,ends_at,all_members,tag_id,source_doc_id,recurrence_parent_id,payload,updated_at)
  VALUES ($1,'native',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,description_delta=EXCLUDED.description_delta,
    starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,all_members=EXCLUDED.all_members,tag_id=EXCLUDED.tag_id,
    source_doc_id=EXCLUDED.source_doc_id,payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at
  RETURNING *,origin::text AS origin
"#).bind(event.id).bind(event.workspace_id).bind(&event.title).bind(&event.description_delta)
.bind(event.starts_at).bind(event.ends_at).bind(event.all_members).bind(event.tag_id).bind(event.source_doc_id)
.bind(event.recurrence_parent_id).bind(&event.payload).bind(event.updated_at)
.fetch_one(&mut **tx).await.map_err(Self::map_db_err)?
    } else {
      sqlx::query(
            r#"
            INSERT INTO calendar_events (
                id,
                account_id,
                workspace_id,
                remote_event_id,
                starts_at,
                ends_at,
                title,
                source_doc_id,
                payload,
                updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (account_id, remote_event_id)
            DO UPDATE SET
                workspace_id = EXCLUDED.workspace_id,
                starts_at = EXCLUDED.starts_at,
                ends_at = EXCLUDED.ends_at,
                title = EXCLUDED.title,
                source_doc_id = EXCLUDED.source_doc_id,
                payload = EXCLUDED.payload,
                updated_at = EXCLUDED.updated_at
            RETURNING id, account_id, workspace_id, remote_event_id, starts_at, ends_at, title, source_doc_id, payload, updated_at, etag, remote_href
            "#,
        )
        .bind(event.id)
        .bind(event.account_id)
        .bind(event.workspace_id)
        .bind(&event.remote_event_id)
        .bind(event.starts_at)
        .bind(event.ends_at)
        .bind(&event.title)
        .bind(event.source_doc_id)
        .bind(&event.payload)
        .bind(event.updated_at)
        .fetch_one(&mut **tx)
        .await
        .map_err(Self::map_db_err)?
    };
    let mut saved = Self::map_event_base(row);
    let event_id = saved.id;
    crate::scheduling::calendar::bind_imported_in(tx, event_id).await?;
    sqlx::query("DELETE FROM calendar_event_participants WHERE event_id = $1")
      .bind(event_id)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;

    for participant in participants {
      sqlx::query(
        r#"
                INSERT INTO calendar_event_participants (
                    id, event_id, user_id, email, display_name, response_status, is_organizer, created_at, updated_at
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                "#,
      )
      .bind(participant.id)
      .bind(event_id)
      .bind(participant.user_id)
      .bind(&participant.email)
      .bind(&participant.display_name)
      .bind(&participant.response_status)
      .bind(participant.is_organizer)
      .bind(participant.created_at)
      .bind(participant.updated_at)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
    }

    saved.participants = participants.to_vec();
    saved.reminders = reminders::replace_in(tx, &saved, reminders).await?;

    Ok(saved)
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    if crate::auth::is_terminal_account_error(&err) {
      return RepositoryError::NotFound("user");
    }
    error!(error = %err, "calendar repository database error");
    RepositoryError::Storage(err.to_string())
  }

  fn map_account(row: sqlx::postgres::PgRow) -> CalendarAccount {
    CalendarAccount {
      id: row.get("id"),
      user_id: row.get("user_id"),
      provider: row.get("provider"),
      remote_account_id: row.get("remote_account_id"),
      access_token_ciphertext: row.get("access_token_ciphertext"),
      refresh_token_ciphertext: row.get("refresh_token_ciphertext"),
      expires_at: row.get("expires_at"),
      config: row.get("config"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    }
  }

  fn map_subscription(row: sqlx::postgres::PgRow) -> CalendarSubscription {
    // Deserialise the structured webhook channel JSON if present.
    let webhook_channel_json: Option<myoxus_domain::entities::WebhookChannelInfo> = row
      .try_get::<Option<serde_json::Value>, _>("webhook_channel_json")
      .ok()
      .flatten()
      .and_then(|v| serde_json::from_value(v).ok());
    CalendarSubscription {
      id: row.get("id"),
      account_id: row.get("account_id"),
      remote_calendar_id: row.get("remote_calendar_id"),
      webhook_channel: row.get("webhook_channel"),
      webhook_channel_json,
      sync_token: row.get("sync_token"),
      updated_at: row.get("updated_at"),
    }
  }

  fn map_workspace_calendar(row: sqlx::postgres::PgRow) -> WorkspaceCalendar {
    WorkspaceCalendar {
      workspace_id: row.get("workspace_id"),
      account_id: row.get("account_id"),
      remote_calendar_id: row.get("remote_calendar_id"),
      enabled: row.get("enabled"),
      updated_at: row.get("updated_at"),
    }
  }

  pub(crate) fn map_event_base(row: sqlx::postgres::PgRow) -> CalendarEvent {
    let origin_str: String = row.try_get("origin").unwrap_or_else(|_| "external".to_string());
    let origin = if origin_str == "native" {
      CalendarEventOrigin::Native
    } else {
      CalendarEventOrigin::External
    };
    CalendarEvent {
      id: row.get("id"),
      origin,
      account_id: row.try_get("account_id").unwrap_or(None),
      workspace_id: row.get("workspace_id"),
      remote_event_id: row.try_get("remote_event_id").unwrap_or(None),
      starts_at: row.get("starts_at"),
      ends_at: row.get("ends_at"),
      title: row.get("title"),
      description: None,
      description_delta: row.try_get("description_delta").unwrap_or(None),
      location: None,
      source_doc_id: row.get("source_doc_id"),
      all_day: {
        let p: serde_json::Value = row.try_get("payload").unwrap_or(serde_json::Value::Null);
        p.get("allDay").and_then(|v| v.as_bool()).unwrap_or(false)
      },
      all_members: row.try_get("all_members").unwrap_or(false),
      tag_id: row.try_get("tag_id").unwrap_or(None),
      recurrence_parent_id: row.try_get("recurrence_parent_id").unwrap_or(None),
      participants: Vec::new(),
      reminders: Vec::new(),
      payload: row.get("payload"),
      updated_at: row.get("updated_at"),
      etag: row.try_get("etag").unwrap_or(None),
      remote_href: row.try_get("remote_href").unwrap_or(None),
    }
  }

  fn map_event_tag(row: sqlx::postgres::PgRow) -> CalendarEventTag {
    CalendarEventTag {
      id: row.get("id"),
      workspace_id: row.get("workspace_id"),
      name: row.get("name"),
      color: row.get("color"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    }
  }

  fn map_pending_write(row: sqlx::postgres::PgRow) -> CalendarPendingWrite {
    CalendarPendingWrite {
      id: row.get("id"),
      event_id: row.get("event_id"),
      operation: row.get("operation"),
      payload: row.get("payload"),
      created_at: row.get("created_at"),
      retry_count: row.get("retry_count"),
      next_retry_at: row.get("next_retry_at"),
      last_error: row.get("last_error"),
    }
  }

  fn source_anchor_kind(anchor: Option<&CalendarEventSourceAnchor>) -> String {
    anchor
      .and_then(|anchor| anchor.kind.as_deref())
      .filter(|kind| !kind.trim().is_empty())
      .map(str::to_string)
      .or_else(|| {
        anchor.and_then(|anchor| {
          if anchor.start_offset.is_some() || anchor.end_offset.is_some() {
            Some("text_range".to_string())
          } else if anchor.block_id.is_some() {
            Some("block".to_string())
          } else {
            None
          }
        })
      })
      .unwrap_or_else(|| "document".to_string())
  }

  async fn delete_created_from_source_link(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    event_id: Uuid,
  ) -> Result<(), sqlx::Error> {
    sqlx::query(
      r#"
      DELETE FROM calendar_event_source_links
      WHERE event_id = $1 AND relation = 'created_from'
      "#,
    )
    .bind(event_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
  }

  async fn replace_created_from_source_link(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    event_id: Uuid,
    source_doc_id: Uuid,
    anchor: Option<&CalendarEventSourceAnchor>,
  ) -> Result<(), sqlx::Error> {
    Self::delete_created_from_source_link(tx, event_id).await?;
    let kind = Self::source_anchor_kind(anchor);
    sqlx::query(
      r#"
      INSERT INTO calendar_event_source_links (
        event_id, source_doc_id, relation,
        source_block_id, source_start_offset, source_end_offset, source_kind
      )
      VALUES ($1, $2, 'created_from', $3, $4, $5, $6)
      "#,
    )
    .bind(event_id)
    .bind(source_doc_id)
    .bind(anchor.and_then(|anchor| anchor.block_id.as_deref()))
    .bind(anchor.and_then(|anchor| anchor.start_offset))
    .bind(anchor.and_then(|anchor| anchor.end_offset))
    .bind(kind)
    .execute(&mut **tx)
    .await?;
    Ok(())
  }

  pub(crate) fn map_instance(row: sqlx::postgres::PgRow) -> CalendarEventInstance {
    CalendarEventInstance {
      id: row.get("id"),
      event_id: row.get("event_id"),
      instance_start: row.get("instance_start"),
      instance_end: row.get("instance_end"),
      is_override: row.get("is_override"),
      is_cancelled: row.get("is_cancelled"),
      override_payload: row.get("override_payload"),
      created_at: row.get("created_at"),
    }
  }

  async fn list_participants(&self, event_id: Uuid) -> RepoResult<Vec<CalendarEventParticipant>> {
    let rows = sqlx::query(
      r#"
            SELECT id, event_id, user_id, email, display_name, response_status, is_organizer, created_at, updated_at
            FROM calendar_event_participants
            WHERE event_id = $1
            ORDER BY created_at ASC
            "#,
    )
    .bind(event_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(
      rows
        .into_iter()
        .map(|row| CalendarEventParticipant {
          id: row.get("id"),
          event_id: row.get("event_id"),
          user_id: row.get("user_id"),
          email: row.get("email"),
          display_name: row.get("display_name"),
          response_status: row.get("response_status"),
          is_organizer: row.get("is_organizer"),
          created_at: row.get("created_at"),
          updated_at: row.get("updated_at"),
        })
        .collect(),
    )
  }

  async fn list_reminders(&self, event_id: Uuid) -> RepoResult<Vec<CalendarReminder>> {
    let mut connection = self.pool.acquire().await.map_err(Self::map_db_err)?;
    reminders::definitions_in(&mut connection, event_id).await
  }
}

#[async_trait]
impl CalendarRepository for SqlxCalendarRepository {
  #[instrument(skip_all)]
  async fn control_calendar_timing(
    &self,
    event_id: Uuid,
    actor: Uuid,
    expected: i64,
    change: myoxus_domain::scheduling::calendar::CalendarTimingChange,
  ) -> RepoResult<CalendarEvent> {
    lifecycle::control(self, event_id, actor, expected, change).await
  }
  /// Insert or update a calendar account (upserts on `provider + remote_account_id`).
  #[instrument(skip(self, account))]
  async fn upsert_calendar_account(&self, account: &CalendarAccount) -> RepoResult<CalendarAccount> {
    let row = sqlx::query(
      r#"
            INSERT INTO calendar_accounts (
                id,
                user_id,
                provider,
                remote_account_id,
                access_token_ciphertext,
                refresh_token_ciphertext,
                expires_at,
                config,
                created_at,
                updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (provider, remote_account_id)
            DO UPDATE SET
                access_token_ciphertext = EXCLUDED.access_token_ciphertext,
                refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
                expires_at = EXCLUDED.expires_at,
                config = EXCLUDED.config,
                updated_at = EXCLUDED.updated_at
            RETURNING id, user_id, provider, remote_account_id, access_token_ciphertext,
                      refresh_token_ciphertext, expires_at, config, created_at, updated_at
            "#,
    )
    .bind(account.id)
    .bind(account.user_id)
    .bind(&account.provider)
    .bind(&account.remote_account_id)
    .bind(&account.access_token_ciphertext)
    .bind(&account.refresh_token_ciphertext)
    .bind(account.expires_at)
    .bind(&account.config)
    .bind(account.created_at)
    .bind(account.updated_at)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(Self::map_account(row))
  }

  /// Update mutable fields of an existing calendar account row.
  #[instrument(skip(self, account))]
  async fn update_calendar_account(&self, account: &CalendarAccount) -> RepoResult<CalendarAccount> {
    let row = sqlx::query(
      r#"
            UPDATE calendar_accounts
            SET access_token_ciphertext = $2,
                refresh_token_ciphertext = $3,
                expires_at = $4,
                config = $5,
                updated_at = $6
            WHERE id = $1
            RETURNING id, user_id, provider, remote_account_id, access_token_ciphertext,
                      refresh_token_ciphertext, expires_at, config, created_at, updated_at
            "#,
    )
    .bind(account.id)
    .bind(&account.access_token_ciphertext)
    .bind(&account.refresh_token_ciphertext)
    .bind(account.expires_at)
    .bind(&account.config)
    .bind(account.updated_at)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(Self::map_account(row))
  }

  /// Delete a calendar account, scoped to the owning user for safety.
  #[instrument(skip(self))]
  async fn delete_calendar_account(&self, account_id: Uuid, user_id: Uuid) -> RepoResult<()> {
    let result = sqlx::query("DELETE FROM calendar_accounts WHERE id = $1 AND user_id = $2")
      .bind(account_id)
      .bind(user_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("calendar_account"));
    }
    Ok(())
  }

  /// List all calendar accounts owned by a user.
  #[instrument(skip(self))]
  async fn list_user_calendar_accounts(&self, user_id: Uuid) -> RepoResult<Vec<CalendarAccount>> {
    let rows = sqlx::query(
            "SELECT id, user_id, provider, remote_account_id, access_token_ciphertext, refresh_token_ciphertext, expires_at, config, created_at, updated_at FROM calendar_accounts WHERE user_id = $1 ORDER BY updated_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_account).collect())
  }

  /// Insert or update a calendar subscription.
  #[instrument(skip(self, subscription))]
  async fn upsert_calendar_subscription(
    &self,
    subscription: &CalendarSubscription,
  ) -> RepoResult<CalendarSubscription> {
    let channel_json = subscription
      .webhook_channel_json
      .as_ref()
      .and_then(|c| serde_json::to_value(c).ok());
    let row = sqlx::query(
            r#"
            INSERT INTO calendar_subscriptions (id, account_id, remote_calendar_id, webhook_channel, webhook_channel_json, sync_token, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (account_id, remote_calendar_id)
            DO UPDATE SET
                webhook_channel = EXCLUDED.webhook_channel,
                webhook_channel_json = EXCLUDED.webhook_channel_json,
                sync_token = EXCLUDED.sync_token,
                updated_at = EXCLUDED.updated_at
            RETURNING id, account_id, remote_calendar_id, webhook_channel, webhook_channel_json, sync_token, updated_at
            "#,
        )
        .bind(subscription.id)
        .bind(subscription.account_id)
        .bind(&subscription.remote_calendar_id)
        .bind(&subscription.webhook_channel)
        .bind(channel_json)
        .bind(&subscription.sync_token)
        .bind(subscription.updated_at)
        .fetch_one(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    Ok(Self::map_subscription(row))
  }

  /// List all subscriptions belonging to a calendar account.
  #[instrument(skip(self))]
  async fn list_account_calendar_subscriptions(&self, account_id: Uuid) -> RepoResult<Vec<CalendarSubscription>> {
    let rows = sqlx::query(
            "SELECT id, account_id, remote_calendar_id, webhook_channel, webhook_channel_json, sync_token, updated_at FROM calendar_subscriptions WHERE account_id = $1 ORDER BY updated_at DESC",
        )
        .bind(account_id)
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_subscription).collect())
  }

  /// Insert or update the workspace-to-calendar association.
  #[instrument(skip(self, workspace_calendar))]
  async fn upsert_workspace_calendar(&self, workspace_calendar: &WorkspaceCalendar) -> RepoResult<WorkspaceCalendar> {
    let row = sqlx::query(
      r#"
            INSERT INTO workspace_calendars (workspace_id, account_id, remote_calendar_id, enabled, updated_at)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (workspace_id, account_id, remote_calendar_id)
            DO UPDATE SET
                enabled = EXCLUDED.enabled,
                updated_at = EXCLUDED.updated_at
            RETURNING workspace_id, account_id, remote_calendar_id, enabled, updated_at
            "#,
    )
    .bind(workspace_calendar.workspace_id)
    .bind(workspace_calendar.account_id)
    .bind(&workspace_calendar.remote_calendar_id)
    .bind(workspace_calendar.enabled)
    .bind(workspace_calendar.updated_at)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(Self::map_workspace_calendar(row))
  }

  /// List all calendar associations for a workspace.
  #[instrument(skip(self))]
  async fn list_workspace_calendars(&self, workspace_id: Uuid) -> RepoResult<Vec<WorkspaceCalendar>> {
    let rows = sqlx::query(
            "SELECT workspace_id, account_id, remote_calendar_id, enabled, updated_at FROM workspace_calendars WHERE workspace_id = $1 ORDER BY updated_at DESC",
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_workspace_calendar).collect())
  }

  /// Insert or update a calendar event (upserts on `(subscription_id, remote_event_id)`).
  #[instrument(skip(self, event))]
  async fn upsert_calendar_event(&self, event: &CalendarEvent) -> RepoResult<CalendarEvent> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let row = sqlx::query(
            r#"
            INSERT INTO calendar_events (
                id,
                account_id,
                workspace_id,
                remote_event_id,
                starts_at,
                ends_at,
                title,
                source_doc_id,
                payload,
                updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (account_id, remote_event_id)
            DO UPDATE SET
                workspace_id = EXCLUDED.workspace_id,
                starts_at = EXCLUDED.starts_at,
                ends_at = EXCLUDED.ends_at,
                title = EXCLUDED.title,
                source_doc_id = EXCLUDED.source_doc_id,
                payload = EXCLUDED.payload,
                updated_at = EXCLUDED.updated_at
            RETURNING id, account_id, workspace_id, remote_event_id, starts_at, ends_at, title, source_doc_id, payload, updated_at, etag, remote_href
            "#,
        )
        .bind(event.id)
        .bind(event.account_id)
        .bind(event.workspace_id)
        .bind(&event.remote_event_id)
        .bind(event.starts_at)
        .bind(event.ends_at)
        .bind(&event.title)
        .bind(event.source_doc_id)
        .bind(&event.payload)
        .bind(event.updated_at)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;

    let mut mapped = Self::map_event_base(row);
    crate::scheduling::calendar::bind_imported_in(&mut tx, mapped.id).await?;
    lifecycle::refresh_reminders_in(&mut tx, &mapped).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    mapped.participants = self.list_participants(mapped.id).await?;
    mapped.reminders = self.list_reminders(mapped.id).await?;
    Ok(mapped)
  }

  async fn get_calendar_timing(
    &self,
    event_id: Uuid,
  ) -> RepoResult<Option<myoxus_domain::scheduling::calendar::CalendarTiming>> {
    let mut connection = self.pool.acquire().await.map_err(Self::map_db_err)?;
    crate::scheduling::calendar::read_in(&mut connection, event_id).await
  }

  #[instrument(skip_all)]
  async fn save_authored_calendar_event(
    &self,
    event: &CalendarEvent,
    participants: &[CalendarEventParticipant],
    reminders: &[CalendarReminder],
  ) -> RepoResult<CalendarEvent> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let saved = Self::persist_authored_event_tx(&mut tx, event, participants, reminders).await?;
    projection::reproject_cached_in(&mut tx, saved.id).await?;
    mail_intent::enqueue(&mut tx, &saved, "calendar-update", None).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(saved)
  }

  #[instrument(skip_all)]
  async fn save_authored_calendar_instance(
    &self,
    instance: &CalendarEventInstance,
  ) -> RepoResult<CalendarEventInstance> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let mut event = mail_intent::load_event(&mut tx, instance.event_id)
      .await?
      .ok_or(RepositoryError::NotFound("calendar_event"))?;
    let previous = sqlx::query("SELECT * FROM calendar_event_instances WHERE event_id=$1 AND instance_start=$2")
      .bind(instance.event_id)
      .bind(instance.instance_start)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    if let Some(previous) = previous {
      let previous = Self::map_instance(previous);
      if previous.override_payload == instance.override_payload
        && previous.instance_end == instance.instance_end
        && !previous.is_cancelled
      {
        return Ok(previous);
      }
    }
    let row = sqlx::query(
      r#"
      INSERT INTO calendar_event_instances (
          id, event_id,
          starts_at, ends_at,
          instance_start, instance_end,
          is_override, is_cancelled, override_payload, created_at
      )
      VALUES ($1, $2, $3, $4, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (event_id, instance_start)
          DO UPDATE SET
              instance_end      = EXCLUDED.instance_end,
              ends_at           = EXCLUDED.ends_at,
              is_override       = EXCLUDED.is_override,
              is_cancelled      = EXCLUDED.is_cancelled,
              override_payload  = EXCLUDED.override_payload
      RETURNING id, event_id, instance_start, instance_end,
                is_override, is_cancelled, override_payload, created_at
      "#,
    )
    .bind(instance.id)
    .bind(instance.event_id)
    .bind(instance.instance_start)
    .bind(instance.instance_end)
    .bind(instance.is_override)
    .bind(instance.is_cancelled)
    .bind(&instance.override_payload)
    .bind(instance.created_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    let saved = Self::map_instance(row);
    crate::scheduling::reminders::refresh_event_in(&mut tx, instance.event_id).await?;
    let changes = instance.override_payload.as_ref().cloned().unwrap_or_default();
    event.title = changes["title"].as_str().map(str::to_owned).or(event.title);
    event.starts_at = changes["starts_at"]
      .as_str()
      .and_then(|s| s.parse().ok())
      .unwrap_or(instance.instance_start);
    event.ends_at = instance.instance_end;
    for key in ["description", "location", "allDay"] {
      if let Some(value) = changes.get(key) {
        event.payload[key] = value.clone();
      }
    }
    mail_intent::enqueue(&mut tx, &event, "calendar-update", Some(instance.instance_start)).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(saved)
  }

  #[instrument(skip_all)]
  async fn save_calendar_split(
    &self,
    command: &CalendarSplitWrite,
  ) -> RepoResult<(CalendarEvent, Option<CalendarEvent>)> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let current = mail_intent::load_event(&mut tx, command.original.id)
      .await?
      .ok_or(RepositoryError::NotFound("calendar_event"))?;
    if current.updated_at != command.expected_updated_at {
      return Err(RepositoryError::Conflict("calendar source revision"));
    }
    crate::scheduling::calendar::narrow_end_in(&mut tx, current.id, command.split_at).await?;
    if let Some(rules) = &command.native_rules {
      crate::scheduling::calendar::set_native_in(&mut tx, current.id, Some(&rules.original)).await?;
    }
    let protected=sqlx::query("SELECT * FROM calendar_event_instances WHERE event_id=$1 AND instance_start>=$2 AND is_override AND NOT is_cancelled ORDER BY instance_start LIMIT 10001 FOR UPDATE")
      .bind(current.id).bind(command.split_at).fetch_all(&mut *tx).await.map_err(Self::map_db_err)?;
    if protected.len() > 10000 {
      return Err(RepositoryError::Validation("Calendar exception budget exceeded".into()));
    }
    let protected = protected.into_iter().map(Self::map_instance).collect::<Vec<_>>();
    // Lock children before parent mail state: a direct child edit locks its
    // row first, then reads that state. Reversing this order can deadlock.
    let children=sqlx::query("SELECT id,payload->>'recurrenceId' AS original_key FROM calendar_events WHERE recurrence_parent_id=$1 ORDER BY id LIMIT 10001 FOR UPDATE")
      .bind(current.id).fetch_all(&mut *tx).await.map_err(Self::map_db_err)?;
    if children.len() > 10000 {
      return Err(RepositoryError::Validation("Calendar exception budget exceeded".into()));
    }
    let mut future_children = Vec::new();
    for child in children {
      let key: Option<String> = child.try_get("original_key").map_err(Self::map_db_err)?;
      let key = myoxus_application::calendar::projection::original_key(key.as_deref().unwrap_or_default())
        .map_err(|error| RepositoryError::Validation(error.to_string()))?;
      if key >= command.split_at {
        future_children.push(
          mail_intent::load_event(&mut tx, child.get::<Uuid, _>("id"))
            .await?
            .ok_or(RepositoryError::NotFound("calendar_event"))?,
        );
      }
    }
    for child in &future_children {
      mail_intent::enqueue(&mut tx, child, "calendar-cancellation", None).await?;
    }
    for instance in &protected {
      let old = myoxus_application::calendar::projection::occurrence_event(&current, instance);
      mail_intent::enqueue(&mut tx, &old, "calendar-cancellation", Some(instance.instance_start)).await?;
    }
    let mut moved_children = Vec::new();
    let original = Self::persist_authored_event_tx(
      &mut tx,
      &command.original,
      &command.original.participants,
      &command.original.reminders,
    )
    .await?;
    let tail = if let Some(tail) = &command.tail {
      if tail.origin == CalendarEventOrigin::Native {
        if command.source_anchor.as_ref().is_some_and(|anchor| anchor.is_some()) && tail.source_doc_id.is_none() {
          return Err(RepositoryError::Validation(
            "Calendar source anchor needs a document".into(),
          ));
        }
        if let Some(tag) = tail.tag_id {
          let valid: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM calendar_event_tags WHERE id=$1 AND workspace_id=$2)")
              .bind(tag)
              .bind(tail.workspace_id)
              .fetch_one(&mut *tx)
              .await
              .map_err(Self::map_db_err)?;
          if !valid {
            return Err(RepositoryError::Validation(
              "Calendar tag is outside the workspace".into(),
            ));
          }
        }
        if let Some(doc) = tail.source_doc_id {
          let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id=$1 AND workspace_id=$2)")
            .bind(doc)
            .bind(tail.workspace_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(Self::map_db_err)?;
          if !valid {
            return Err(RepositoryError::Validation(
              "Calendar document is outside the workspace".into(),
            ));
          }
        }
      }
      let tail = Self::persist_authored_event_tx(&mut tx, tail, &tail.participants, &tail.reminders).await?;
      sqlx::query("UPDATE calendar_events t SET projection_from=e.projection_from,projection_to=e.projection_to FROM calendar_events e WHERE e.id=$1 AND t.id=$2")
        .bind(original.id).bind(tail.id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      if let Some(cutoff) = command.tail_ends_before {
        crate::scheduling::calendar::narrow_end_in(&mut tx, tail.id, cutoff).await?;
      }
      if let Some(rules) = &command.native_rules {
        crate::scheduling::calendar::set_native_in(&mut tx, tail.id, rules.tail.as_ref()).await?;
      }
      // A split is not a Resume. The tail inherits intentional suppression,
      // while the head keeps the same intervals for its historical originals.
      sqlx::query("UPDATE scheduling_schedules t SET lifecycle=s.lifecycle,paused_at=s.paused_at FROM calendar_events a,calendar_events b,scheduling_schedules s WHERE a.id=$1 AND b.id=$2 AND a.recurrence_schedule_id=s.id AND b.recurrence_schedule_id=t.id")
        .bind(original.id).bind(tail.id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      sqlx::query("INSERT INTO scheduling_pause_intervals(schedule_id,starts_at,ends_at) SELECT b.recurrence_schedule_id,p.starts_at,p.ends_at FROM calendar_events a JOIN scheduling_pause_intervals p ON p.schedule_id=a.recurrence_schedule_id CROSS JOIN calendar_events b WHERE a.id=$1 AND b.id=$2 AND b.recurrence_schedule_id IS NOT NULL ON CONFLICT DO NOTHING")
        .bind(original.id).bind(tail.id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      // Association changes preserve deployed instance IDs and original keys.
      sqlx::query("UPDATE calendar_event_instances SET event_id=$2 WHERE event_id=$1 AND instance_start>=$3")
        .bind(original.id)
        .bind(tail.id)
        .bind(command.split_at)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      for child in &future_children {
        sqlx::query("UPDATE calendar_events SET recurrence_parent_id=$2,updated_at=now() WHERE id=$1")
          .bind(child.id)
          .bind(tail.id)
          .execute(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
        moved_children.push(
          mail_intent::load_event(&mut tx, child.id)
            .await?
            .ok_or(RepositoryError::NotFound("calendar_event"))?,
        );
      }
      if let Some(doc) = tail.source_doc_id {
        if let Some(anchor) = &command.source_anchor {
          Self::replace_created_from_source_link(&mut tx, tail.id, doc, anchor.as_ref())
            .await
            .map_err(Self::map_db_err)?;
        } else {
          let copied=sqlx::query("INSERT INTO calendar_event_source_links(event_id,source_doc_id,relation,source_block_id,source_start_offset,source_end_offset,source_kind) SELECT $2,source_doc_id,relation,source_block_id,source_start_offset,source_end_offset,source_kind FROM calendar_event_source_links WHERE event_id=$1 AND source_doc_id=$3 AND relation='created_from' ON CONFLICT DO NOTHING")
            .bind(original.id).bind(tail.id).bind(doc).execute(&mut *tx).await.map_err(Self::map_db_err)?;
          if copied.rows_affected() == 0 {
            Self::replace_created_from_source_link(&mut tx, tail.id, doc, None)
              .await
              .map_err(Self::map_db_err)?;
          }
        }
      }
      projection::reproject_cached_in(&mut tx, tail.id).await?;
      Some(
        mail_intent::load_event(&mut tx, tail.id)
          .await?
          .ok_or(RepositoryError::NotFound("calendar_event"))?,
      )
    } else {
      None
    };
    if tail.is_none() {
      for child in &future_children {
        sqlx::query("DELETE FROM calendar_reminders WHERE event_id=$1 AND delivered_at IS NULL")
          .bind(child.id)
          .execute(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
      }
    }
    // Move originals before either window is reconciled: projecting the head
    // first would delete ordinary future cache rows and lose their IDs.
    projection::reproject_cached_in(&mut tx, original.id).await?;
    if current.starts_at >= command.split_at {
      sqlx::query("DELETE FROM calendar_reminders WHERE event_id=$1 AND delivered_at IS NULL")
        .bind(original.id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    mail_intent::enqueue(&mut tx, &original, "calendar-update", None).await?;
    if let Some(tail) = &tail {
      mail_intent::enqueue(&mut tx, tail, "calendar-invitation", None).await?;
      for instance in &protected {
        let mut instance = instance.clone();
        instance.event_id = tail.id;
        let moved = myoxus_application::calendar::projection::occurrence_event(tail, &instance);
        mail_intent::enqueue(&mut tx, &moved, "calendar-update", Some(instance.instance_start)).await?;
      }
      for child in &moved_children {
        mail_intent::enqueue(&mut tx, child, "calendar-invitation", None).await?;
      }
    }
    let original_id = original.id;
    let tail_id = tail.as_ref().map(|event| event.id);
    tx.commit().await.map_err(Self::map_db_err)?;
    let original = self
      .get_calendar_event(original_id)
      .await?
      .ok_or(RepositoryError::NotFound("calendar_event"))?;
    let tail = if let Some(id) = tail_id {
      Some(
        self
          .get_calendar_event(id)
          .await?
          .ok_or(RepositoryError::NotFound("calendar_event"))?,
      )
    } else {
      None
    };
    Ok((original, tail))
  }

  #[instrument(skip_all)]
  async fn cancel_calendar_occurrence(&self, event_id: Uuid, instance_start: DateTime<Utc>) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let Some(mut event) = mail_intent::load_event(&mut tx, event_id).await? else {
      return Err(RepositoryError::NotFound("calendar_event"));
    };
    let excluded = instance_start.to_rfc3339();
    let mut exdates = event.payload["exdates"].as_array().cloned().unwrap_or_default();
    if exdates.iter().any(|value| value.as_str() == Some(excluded.as_str())) {
      return Ok(());
    }
    exdates.push(serde_json::json!(excluded));
    event.payload["exdates"] = serde_json::json!(exdates);
    sqlx::query("UPDATE calendar_events SET payload=$2, updated_at=now() WHERE id=$1")
      .bind(event_id)
      .bind(&event.payload)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let excluded_value = instance_start
      .format(if event.all_day { "%Y%m%d" } else { "%Y%m%dT%H%M%SZ" })
      .to_string();
    let mut exdate = event.payload["exdate"]
      .as_str()
      .unwrap_or_default()
      .split(',')
      .filter(|value| !value.is_empty())
      .map(str::to_owned)
      .collect::<Vec<_>>();
    if !exdate.contains(&excluded_value) {
      exdate.push(excluded_value);
    }
    event.payload["exdate"] = serde_json::json!(exdate.join(","));
    sqlx::query("UPDATE calendar_events SET payload=$2 WHERE id=$1")
      .bind(event_id)
      .bind(&event.payload)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query("UPDATE calendar_event_instances SET is_cancelled=true WHERE event_id=$1 AND instance_start=$2")
      .bind(event_id)
      .bind(instance_start)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    mail_intent::enqueue(&mut tx, &event, "calendar-cancellation", Some(instance_start)).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Atomically replace all participants for an event (delete + re-insert).
  #[instrument(skip(self, participants))]
  async fn replace_calendar_event_participants(
    &self,
    event_id: Uuid,
    participants: &[CalendarEventParticipant],
  ) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("DELETE FROM calendar_event_participants WHERE event_id = $1")
      .bind(event_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;

    for participant in participants {
      sqlx::query(
        r#"
                INSERT INTO calendar_event_participants (
                    id, event_id, user_id, email, display_name, response_status, is_organizer, created_at, updated_at
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                "#,
      )
      .bind(participant.id)
      .bind(event_id)
      .bind(participant.user_id)
      .bind(&participant.email)
      .bind(&participant.display_name)
      .bind(&participant.response_status)
      .bind(participant.is_organizer)
      .bind(participant.created_at)
      .bind(participant.updated_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }

    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Update the RSVP response_status of a single participant.
  #[instrument(skip(self, status))]
  async fn update_participant_response_status(
    &self,
    participant_id: Uuid,
    status: &str,
  ) -> RepoResult<Option<CalendarEventParticipant>> {
    let now = chrono::Utc::now();
    let row = sqlx::query(
      r#"
      UPDATE calendar_event_participants
      SET response_status = $2, updated_at = $3
      WHERE id = $1
      RETURNING id, event_id, user_id, email, display_name, response_status, is_organizer, created_at, updated_at
      "#,
    )
    .bind(participant_id)
    .bind(status)
    .bind(now)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(|r| CalendarEventParticipant {
      id: r.get("id"),
      event_id: r.get("event_id"),
      user_id: r.get("user_id"),
      email: r.get("email"),
      display_name: r.get("display_name"),
      response_status: r.get("response_status"),
      is_organizer: r.get("is_organizer"),
      created_at: r.get("created_at"),
      updated_at: r.get("updated_at"),
    }))
  }

  /// Replace native definitions atomically, retaining unchanged delivery IDs.
  #[instrument(skip(self, reminders))]
  async fn replace_calendar_event_reminders(&self, event_id: Uuid, reminders: &[CalendarReminder]) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let event = mail_intent::load_event(&mut tx, event_id)
      .await?
      .ok_or(RepositoryError::NotFound("calendar_event"))?;
    reminders::replace_in(&mut tx, &event, reminders).await?;

    lifecycle::refresh_reminders_in(&mut tx, &event).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Update the dispatch status of a calendar reminder.
  #[instrument(skip(self))]
  async fn mark_calendar_reminder_status(
    &self,
    reminder_id: Uuid,
    delivered: bool,
    delivered_at: DateTime<Utc>,
  ) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let source:Option<Uuid>=sqlx::query_scalar("SELECT d.event_id FROM calendar_reminders r JOIN calendar_reminder_definitions d ON d.id=r.definition_id WHERE r.id=$1")
      .bind(reminder_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
    let source = source.ok_or(RepositoryError::NotFound("calendar_reminder"))?;
    let event = mail_intent::load_event(&mut tx, source)
      .await?
      .ok_or(RepositoryError::NotFound("calendar_event"))?;
    let previous: Option<DateTime<Utc>> =
      sqlx::query_scalar("SELECT delivered_at FROM calendar_reminders WHERE id=$1 FOR UPDATE")
        .bind(reminder_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    let delivered_value = if delivered { Some(delivered_at) } else { None };
    sqlx::query("UPDATE calendar_reminders SET delivered_at = $2, updated_at = now() WHERE id = $1")
      .bind(reminder_id)
      .bind(delivered_value)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    if !delivered && previous.is_some() {
      // The existing explicit reset command rearms native work, not a second
      // timing sweep. Completed recipient receipts still protect re-delivery.
      sqlx::query("UPDATE scheduling_schedules SET generation=generation+1,revision=revision+1 WHERE id=(SELECT definition_id FROM calendar_reminders WHERE id=$1)")
        .bind(reminder_id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      sqlx::query("UPDATE calendar_reminders SET suppressed=true WHERE id=$1")
        .bind(reminder_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    lifecycle::refresh_reminders_in(&mut tx, &event).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip(self), fields(%reminder_id))]
  async fn acquire_reminder_delivery_guard(
    &self,
    reminder_id: Uuid,
  ) -> RepoResult<Box<dyn myoxus_domain::repositories::CalendarReminderDeliveryGuard>> {
    mail_delivery::PgCalendarReminderDeliveryGuard::acquire(&self.pool, reminder_id).await
  }

  /// List calendar events visible to a workspace within a time range.
  #[instrument(skip(self))]
  async fn list_workspace_events(
    &self,
    workspace_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> RepoResult<Vec<CalendarEvent>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let (mut events, _) = projection::workspace_in(&mut tx, workspace_id, from, to).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    for event in &mut events {
      event.participants = self.list_participants(event.id).await?;
      event.reminders = self.list_reminders(event.id).await?;
    }

    Ok(events)
  }

  #[instrument(skip_all)]
  async fn list_workspace_event_sources(
    &self,
    workspace_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> RepoResult<Vec<CalendarEvent>> {
    myoxus_application::calendar::projection::validate_window(from, to)
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let rows=sqlx::query("SELECT *,origin::text AS origin FROM calendar_events WHERE workspace_id=$1 AND (recurrence_schedule_id IS NOT NULL OR recurrence_parent_id IN(SELECT id FROM calendar_events WHERE workspace_id=$1 AND recurrence_schedule_id IS NOT NULL) OR (starts_at<$3 AND ends_at>$2)) ORDER BY starts_at,id LIMIT 501")
      .bind(workspace_id).bind(from).bind(to).fetch_all(&self.pool).await.map_err(Self::map_db_err)?;
    if rows.len() > 500 {
      return Err(RepositoryError::Validation(
        "Calendar source result budget exceeded".into(),
      ));
    }
    let mut sources = Vec::new();
    for row in rows {
      let mut event = Self::map_event_base(row);
      let mut connection = self.pool.acquire().await.map_err(Self::map_db_err)?;
      if projection::child_suppressed_in(&mut connection, &event).await? {
        continue;
      }
      projection::attach_timing_in(&mut connection, &mut event).await?;
      let mut overrides = if event.recurrence_parent_id.is_none() {
        projection::source_overrides_in(&mut connection, &event).await?
      } else {
        vec![]
      };
      drop(connection);
      event.participants = self.list_participants(event.id).await?;
      event.reminders = self.list_reminders(event.id).await?;
      for source in &mut overrides {
        source.participants = event.participants.clone();
      }
      sources.push(event);
      sources.extend(overrides);
      if sources.len() > 10000 {
        return Err(RepositoryError::Validation(
          "Calendar source result budget exceeded".into(),
        ));
      }
    }
    Ok(sources)
  }

  #[instrument(skip_all)]
  async fn list_workspace_calendar_series(&self, workspace_id: Uuid) -> RepoResult<Vec<CalendarEvent>> {
    let rows=sqlx::query("SELECT *,origin::text AS origin FROM calendar_events WHERE workspace_id=$1 AND origin='native' AND recurrence_parent_id IS NULL AND recurrence_schedule_id IS NOT NULL ORDER BY title,id LIMIT 501")
      .bind(workspace_id).fetch_all(&self.pool).await.map_err(Self::map_db_err)?;
    if rows.len() > 500 {
      return Err(RepositoryError::Validation(
        "Calendar series result budget exceeded".into(),
      ));
    }
    Ok(rows.into_iter().map(Self::map_event_base).collect())
  }

  async fn list_caldav_accounts(&self) -> RepoResult<Vec<CalendarAccount>> {
    let rows = sqlx::query(
      r#"
      SELECT id, user_id, provider, remote_account_id,
             access_token_ciphertext, refresh_token_ciphertext,
             expires_at, config, created_at, updated_at
      FROM calendar_accounts
      WHERE provider = 'caldav'
      ORDER BY updated_at DESC
      "#,
    )
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(rows.into_iter().map(Self::map_account).collect())
  }

  #[instrument(skip(self))]
  async fn list_google_accounts(&self) -> RepoResult<Vec<CalendarAccount>> {
    let rows = sqlx::query(
      r#"
      SELECT id, user_id, provider, remote_account_id,
             access_token_ciphertext, refresh_token_ciphertext,
             expires_at, config, created_at, updated_at
      FROM calendar_accounts
      WHERE provider = 'google'
      ORDER BY updated_at DESC
      "#,
    )
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(rows.into_iter().map(Self::map_account).collect())
  }

  #[instrument(skip(self))]
  async fn get_calendar_account_by_id(&self, id: uuid::Uuid) -> RepoResult<Option<CalendarAccount>> {
    let row = sqlx::query(
      r#"
      SELECT id, user_id, provider, remote_account_id,
             access_token_ciphertext, refresh_token_ciphertext,
             expires_at, config, created_at, updated_at
      FROM calendar_accounts
      WHERE id = $1
      "#,
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(Self::map_account))
  }

  #[instrument(skip(self))]
  async fn get_calendar_subscription_by_id(
    &self,
    subscription_id: uuid::Uuid,
  ) -> RepoResult<Option<CalendarSubscription>> {
    let row = sqlx::query(
      r#"
      SELECT id, account_id, remote_calendar_id, webhook_channel,
             webhook_channel_json, sync_token, updated_at
      FROM calendar_subscriptions
      WHERE id = $1
      "#,
    )
    .bind(subscription_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(Self::map_subscription))
  }

  /// Find a subscription by the `channel_id` stored in `webhook_channel_json`.
  #[instrument(skip(self))]
  async fn find_subscription_by_channel_id(&self, channel_id: &str) -> RepoResult<Option<CalendarSubscription>> {
    let row = sqlx::query(
      r#"
      SELECT id, account_id, remote_calendar_id, webhook_channel,
             webhook_channel_json, sync_token, updated_at
      FROM calendar_subscriptions
      WHERE webhook_channel_json->>'channel_id' = $1
      LIMIT 1
      "#,
    )
    .bind(channel_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(Self::map_subscription))
  }

  #[instrument(skip(self))]
  async fn touch_calendar_subscription(&self, subscription_id: Uuid) -> RepoResult<()> {
    sqlx::query("UPDATE calendar_subscriptions SET updated_at = now() WHERE id = $1")
      .bind(subscription_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Return subscriptions whose webhook channel expires within `within_hours`.
  #[instrument(skip(self))]
  async fn list_subscriptions_expiring_within(&self, within_hours: i64) -> RepoResult<Vec<CalendarSubscription>> {
    let rows = sqlx::query(
      r#"
      SELECT id, account_id, remote_calendar_id, webhook_channel,
             webhook_channel_json, sync_token, updated_at
      FROM calendar_subscriptions
      WHERE webhook_channel_json IS NOT NULL
        AND (webhook_channel_json->>'expiry')::timestamptz < now() + ($1 * interval '1 hour')
      ORDER BY (webhook_channel_json->>'expiry')::timestamptz ASC
      "#,
    )
    .bind(within_hours)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(rows.into_iter().map(Self::map_subscription).collect())
  }

  /// Atomically update `webhook_channel_json` on a subscription.
  #[instrument(skip(self, channel))]
  async fn update_subscription_webhook_channel(
    &self,
    subscription_id: Uuid,
    channel: Option<&myoxus_domain::entities::WebhookChannelInfo>,
  ) -> RepoResult<()> {
    let channel_json = match channel {
      Some(c) => Some(serde_json::to_value(c).map_err(|e| RepositoryError::Storage(e.to_string()))?),
      None => None,
    };
    sqlx::query("UPDATE calendar_subscriptions SET webhook_channel_json = $1, updated_at = now() WHERE id = $2")
      .bind(channel_json)
      .bind(subscription_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Legacy single-recipient callers see the first deterministic current recipient.
  #[instrument(skip_all)]
  async fn get_calendar_reminder_context(&self, reminder_id: Uuid) -> RepoResult<Option<CalendarReminderContext>> {
    Ok(
      self
        .get_calendar_reminder_contexts(reminder_id)
        .await?
        .into_iter()
        .next(),
    )
  }

  #[instrument(skip_all)]
  async fn get_calendar_reminder_contexts(&self, reminder_id: Uuid) -> RepoResult<Vec<CalendarReminderContext>> {
    let mut connection = self.pool.acquire().await.map_err(Self::map_db_err)?;
    mail_delivery::reminder_contexts(&mut connection, reminder_id).await
  }

  // ── Event-instance methods ────────────────────────────────────────────

  /// Insert or update a single expanded recurrence instance.
  ///
  /// Conflict target: `(event_id, instance_start)`.
  #[instrument(skip(self, instance))]
  async fn upsert_event_instance(&self, instance: &CalendarEventInstance) -> RepoResult<CalendarEventInstance> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    mail_intent::load_event(&mut tx, instance.event_id)
      .await?
      .ok_or(RepositoryError::NotFound("calendar_event"))?;
    let row = sqlx::query(
      r#"
      INSERT INTO calendar_event_instances (
          id, event_id,
          starts_at, ends_at,
          instance_start, instance_end,
          is_override, is_cancelled, override_payload, created_at
      )
      VALUES ($1, $2, $3, $4, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (event_id, instance_start)
          DO UPDATE SET
              instance_end      = EXCLUDED.instance_end,
              ends_at           = EXCLUDED.ends_at,
              is_override       = EXCLUDED.is_override,
              is_cancelled      = EXCLUDED.is_cancelled,
              override_payload  = EXCLUDED.override_payload
      RETURNING id, event_id, instance_start, instance_end,
                is_override, is_cancelled, override_payload, created_at
      "#,
    )
    .bind(instance.id)
    .bind(instance.event_id)
    .bind(instance.instance_start)
    .bind(instance.instance_end)
    .bind(instance.is_override)
    .bind(instance.is_cancelled)
    .bind(&instance.override_payload)
    .bind(instance.created_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    crate::scheduling::reminders::refresh_event_in(&mut tx, instance.event_id).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(Self::map_instance(row))
  }

  /// Project/read one window while holding its master mutation lock.
  #[instrument(skip(self))]
  async fn list_event_instances(
    &self,
    event_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> RepoResult<Vec<CalendarEventInstance>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let Some(event) = mail_intent::load_event(&mut tx, event_id).await? else {
      return Ok(vec![]);
    };
    let instances = projection::instances_in(&mut tx, &event, from, to).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(instances)
  }

  /// The busy projection uses the same canonical windows as event display.
  #[instrument(skip(self))]
  async fn list_instances_by_time_range(
    &self,
    workspace_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> RepoResult<Vec<CalendarEventInstance>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let (_, instances) = projection::workspace_in(&mut tx, workspace_id, from, to).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(instances)
  }

  /// Mark a specific recurrence occurrence as cancelled.
  #[instrument(skip(self))]
  async fn cancel_event_instance(&self, instance_id: Uuid) -> RepoResult<()> {
    let result = sqlx::query("UPDATE calendar_event_instances SET is_cancelled = true WHERE id = $1")
      .bind(instance_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("calendar_event_instance"));
    }
    Ok(())
  }

  /// Delete all expanded instances for an event (e.g. before re-expansion).
  #[instrument(skip(self))]
  async fn delete_event_instances_by_event(&self, event_id: Uuid) -> RepoResult<()> {
    sqlx::query("DELETE FROM calendar_event_instances WHERE event_id = $1")
      .bind(event_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  // ── ETag / write-back helpers ─────────────────────────────────────────

  /// Store the ETag and remote href returned by the CalDAV / Google server.
  #[instrument(skip(self))]
  async fn update_event_etag(&self, event_id: Uuid, etag: &str, remote_href: &str) -> RepoResult<()> {
    sqlx::query("UPDATE calendar_events SET etag = $2, remote_href = $3, updated_at = now() WHERE id = $1")
      .bind(event_id)
      .bind(etag)
      .bind(remote_href)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  // ── Offline pending-write queue ───────────────────────────────────────

  #[instrument(skip(self, payload))]
  async fn enqueue_pending_write(
    &self,
    event_id: Uuid,
    operation: &str,
    payload: Option<serde_json::Value>,
  ) -> RepoResult<CalendarPendingWrite> {
    // First retry in 1 minute.
    let next_retry_at = chrono::Utc::now() + chrono::Duration::minutes(1);
    let row = sqlx::query(
      r#"
      INSERT INTO calendar_pending_writes (event_id, operation, payload, next_retry_at)
      VALUES ($1, $2, $3, $4)
      RETURNING id, event_id, operation, payload, created_at, retry_count, next_retry_at, last_error
      "#,
    )
    .bind(event_id)
    .bind(operation)
    .bind(&payload)
    .bind(next_retry_at)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(Self::map_pending_write(row))
  }

  #[instrument(skip(self, snapshot), fields(%event_id))]
  async fn detach_delete_intent_and_delete_event(
    &self,
    event_id: Uuid,
    snapshot: &CalendarDeleteSnapshot,
  ) -> RepoResult<CalendarPendingWrite> {
    let mut guard = self.acquire_pending_write_guard(event_id).await?;
    let result = guard.detach_delete_intent_and_delete_event(event_id, snapshot).await;
    let release = guard.release().await;
    match (result, release) {
      (Ok(write), Ok(())) => Ok(write),
      (Err(error), _) | (Ok(_), Err(error)) => Err(error),
    }
  }

  #[instrument(skip(self), fields(%intent_id))]
  async fn acquire_mail_delivery_guard(
    &self,
    intent_id: Uuid,
  ) -> RepoResult<Box<dyn myoxus_domain::repositories::CalendarMailDeliveryGuard>> {
    mail_delivery::PgCalendarMailDeliveryGuard::acquire(&self.pool, intent_id).await
  }

  #[instrument(skip(self), fields(%event_id))]
  async fn acquire_pending_write_guard(&self, event_id: Uuid) -> RepoResult<Box<dyn CalendarPendingWriteGuard>> {
    let connection = self.pool.acquire().await.map_err(Self::map_db_err)?;
    let mut guard = PgCalendarPendingWriteGuard {
      connection: Some(connection),
      event_id,
    };
    let lock_key = format!("myoxus:calendar:event:{event_id}");
    sqlx::query("SELECT pg_advisory_lock(hashtextextended($1, 0))")
      .bind(lock_key)
      .execute(
        &mut **guard
          .connection
          .as_mut()
          .expect("new calendar pending-write guard owns its connection"),
      )
      .await
      .map_err(Self::map_db_err)?;
    Ok(Box::new(guard))
  }

  #[instrument(skip(self))]
  async fn get_pending_write(&self, id: Uuid) -> RepoResult<Option<CalendarPendingWrite>> {
    let row = sqlx::query(
      r#"
      SELECT id, event_id, operation, payload, created_at, retry_count, next_retry_at, last_error
      FROM calendar_pending_writes
      WHERE id = $1
      "#,
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(Self::map_pending_write))
  }

  #[instrument(skip(self))]
  async fn list_due_pending_writes(&self, now: DateTime<Utc>, limit: i64) -> RepoResult<Vec<CalendarPendingWrite>> {
    let rows = sqlx::query(
      r#"
      SELECT id, event_id, operation, payload, created_at, retry_count, next_retry_at, last_error
      FROM calendar_pending_writes
      WHERE retry_count < 10
        AND (next_retry_at IS NULL OR next_retry_at <= $1)
      ORDER BY next_retry_at ASC NULLS FIRST
      LIMIT $2
      "#,
    )
    .bind(now)
    .bind(limit.clamp(1, 500))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_pending_write).collect())
  }

  #[instrument(skip(self, last_error))]
  async fn update_pending_write_retry(
    &self,
    id: uuid::Uuid,
    retry_count: i32,
    next_retry_at: Option<DateTime<Utc>>,
    last_error: &str,
  ) -> RepoResult<()> {
    sqlx::query(
      "UPDATE calendar_pending_writes SET retry_count = $2, next_retry_at = $3, last_error = $4 WHERE id = $1",
    )
    .bind(id)
    .bind(retry_count)
    .bind(next_retry_at)
    .bind(last_error)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip(self))]
  async fn delete_pending_write(&self, id: uuid::Uuid) -> RepoResult<()> {
    sqlx::query("DELETE FROM calendar_pending_writes WHERE id = $1")
      .bind(id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip(self))]
  async fn get_calendar_event(&self, event_id: Uuid) -> RepoResult<Option<CalendarEvent>> {
    let row = sqlx::query(
      r#"
      SELECT id, origin::text AS origin, account_id, workspace_id, remote_event_id, starts_at, ends_at, title,
             source_doc_id, payload, updated_at, etag, remote_href,
             all_members, description_delta, tag_id, recurrence_parent_id
      FROM calendar_events
      WHERE id = $1
      "#,
    )
    .bind(event_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    if let Some(row) = row {
      let mut event = Self::map_event_base(row);
      event.participants = self.list_participants(event.id).await?;
      event.reminders = self.list_reminders(event.id).await?;
      Ok(Some(event))
    } else {
      Ok(None)
    }
  }

  /// Delete a calendar event (instances cascade via FK).
  #[instrument(skip_all)]
  async fn get_calendar_export_event(&self, event_id: Uuid) -> RepoResult<Option<CalendarEvent>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let Some(mut event) = mail_intent::load_event(&mut tx, event_id).await? else {
      return Ok(None);
    };
    projection::attach_timing_in(&mut tx, &mut event).await?;
    event.payload = myoxus_domain::scheduling::calendar::export_payload(&event.payload, event.all_day);
    if let Some(payload) = event.payload.as_object_mut() {
      payload.remove("_myoxusCalendarTiming");
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(Some(event))
  }

  #[instrument(skip_all)]
  async fn find_calendar_event_by_source(
    &self,
    account_id: Uuid,
    remote_event_id: &str,
  ) -> RepoResult<Option<CalendarEvent>> {
    let id: Option<Uuid> =
      sqlx::query_scalar("SELECT id FROM calendar_events WHERE account_id=$1 AND remote_event_id=$2")
        .bind(account_id)
        .bind(remote_event_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    match id {
      Some(id) => self.get_calendar_event(id).await,
      None => Ok(None),
    }
  }

  /// Delete a calendar event (instances cascade via FK).
  #[instrument(skip(self))]
  async fn delete_calendar_event(&self, event_id: Uuid) -> RepoResult<()> {
    sqlx::query("DELETE FROM calendar_events WHERE id = $1")
      .bind(event_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Find a single instance by (event_id, instance_start) exact match.
  #[instrument(skip(self))]
  async fn find_instance_by_event_and_start(
    &self,
    event_id: Uuid,
    instance_start: DateTime<Utc>,
  ) -> RepoResult<Option<CalendarEventInstance>> {
    let row = sqlx::query(
      r#"
      SELECT id, event_id, instance_start, instance_end,
             is_override, is_cancelled, override_payload, created_at
      FROM calendar_event_instances
      WHERE event_id = $1 AND instance_start = $2
      "#,
    )
    .bind(event_id)
    .bind(instance_start)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(Self::map_instance))
  }

  // ── Native event CRUD (P-JCAL-SERVER-01-B) ──────────────────────────────

  #[instrument(skip(self, input))]
  async fn insert_native_event(&self, input: &NativeEventInput) -> RepoResult<CalendarEvent> {
    if input.recurrence.is_some() && input.recurrence_parent_id.is_some() {
      return Err(RepositoryError::Validation(
        "Calendar override cannot own a timing definition".into(),
      ));
    }
    let mut id = Uuid::new_v4();
    let now = Utc::now();
    // all_day and recurrenceId are stored in payload JSONB, not dedicated columns.
    let mut payload = serde_json::json!({
      "allDay": input.all_day,
      "recurrenceId": input.recurrence_ical_id,
    });
    if let Some(source) = &input.imported_recurrence {
      if input.recurrence.is_some() {
        return Err(RepositoryError::Validation(
          "Calendar recurrence has two source owners".into(),
        ));
      }
      payload["sourceUid"] = serde_json::json!(source.uid);
      payload["rrule"] = serde_json::json!(source.rrule);
      payload["originalTimezone"] = serde_json::json!(source.original_timezone);
      payload["recurrenceId"] = serde_json::json!(source.recurrence_id);
      payload["sourceRecurrence"] = serde_json::json!(source.lines);
      payload["status"] = serde_json::json!(source.status);
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    if let Some(parent) = input.recurrence_parent_id {
      // Serialize overrides with their master and preserve one identity per
      // original occurrence. The exclusion rolls back if the override fails.
      let master: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM calendar_events WHERE id=$1 AND workspace_id=$2 AND origin='native' FOR UPDATE",
      )
      .bind(parent)
      .bind(input.workspace_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if master.is_none() {
        return Err(RepositoryError::NotFound("native calendar master"));
      }
      let recurrence = input
        .recurrence_ical_id
        .as_deref()
        .ok_or_else(|| RepositoryError::Validation("Calendar recurrence ID missing".into()))?;
      let start = chrono::NaiveDateTime::parse_from_str(recurrence, "%Y%m%dT%H%M%SZ")
        .map_err(|_| RepositoryError::Validation("Invalid calendar recurrence ID".into()))?
        .and_utc()
        .to_rfc3339();
      let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM calendar_events WHERE recurrence_parent_id=$1 AND payload->>'recurrenceId'=$2 ORDER BY updated_at DESC,id LIMIT 1",
      ).bind(parent).bind(recurrence).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
      if let Some(existing) = existing {
        id = existing;
      }
      sqlx::query(
        "UPDATE calendar_events SET payload=jsonb_set(COALESCE(payload,'{}'),'{exdates}', \
        CASE WHEN COALESCE(payload->'exdates','[]') ? $2 THEN COALESCE(payload->'exdates','[]') \
        ELSE COALESCE(payload->'exdates','[]') || to_jsonb($2::text) END) WHERE id=$1",
      )
      .bind(parent)
      .bind(start)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    let row = sqlx::query(
      r#"
      INSERT INTO calendar_events (
        id, origin, workspace_id, title, description_delta,
        starts_at, ends_at, all_members, tag_id,
        source_doc_id, recurrence_parent_id, payload, updated_at
      )
      VALUES (
        $1, 'native', $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12
      )
      ON CONFLICT (id) DO UPDATE SET
        title=EXCLUDED.title, description_delta=EXCLUDED.description_delta,
        starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at,
        all_members=EXCLUDED.all_members, tag_id=EXCLUDED.tag_id,
        source_doc_id=EXCLUDED.source_doc_id,
        payload=calendar_events.payload || EXCLUDED.payload, updated_at=EXCLUDED.updated_at
      RETURNING
        id, origin::text AS origin, account_id, workspace_id, remote_event_id,
        starts_at, ends_at, title, description_delta, source_doc_id,
        all_members, tag_id, recurrence_parent_id,
        payload, updated_at, etag, remote_href
      "#,
    )
    .bind(id)
    .bind(input.workspace_id)
    .bind(&input.title)
    .bind(&input.description_delta)
    .bind(input.starts_at)
    .bind(input.ends_at)
    .bind(input.all_members)
    .bind(input.tag_id)
    .bind(input.source_doc_id)
    .bind(input.recurrence_parent_id)
    .bind(&payload)
    .bind(now)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if let Some(recurrence) = &input.recurrence {
      crate::scheduling::calendar::set_native_in(&mut tx, id, Some(recurrence)).await?;
    } else if input.imported_recurrence.is_some() {
      crate::scheduling::calendar::bind_imported_in(&mut tx, id).await?;
    }
    if let Some(master) = input.recurrence_parent_id {
      projection::reproject_cached_in(&mut tx, master).await?;
    }
    if let Some(source_doc_id) = input.source_doc_id {
      Self::replace_created_from_source_link(&mut tx, id, source_doc_id, input.source_anchor.as_ref())
        .await
        .map_err(Self::map_db_err)?;
    }
    if let Some(event) = mail_intent::load_event(&mut tx, id).await? {
      let kind = if event.recurrence_parent_id.is_some() {
        "calendar-update"
      } else {
        "calendar-invitation"
      };
      mail_intent::enqueue(&mut tx, &event, kind, None).await?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(Self::map_event_base(row))
  }

  #[instrument(skip(self, input))]
  async fn update_native_event(&self, event_id: Uuid, input: &NativeEventUpdate) -> RepoResult<Option<CalendarEvent>> {
    let now = Utc::now();
    // all_day is stored in payload JSONB — patch it when the caller provides a new value.
    let all_day_patch = input.all_day.map(|v| serde_json::json!({ "allDay": v }));
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let row = sqlx::query(
      r#"
      UPDATE calendar_events SET
        title             = COALESCE($2, title),
        description_delta = CASE WHEN $13::boolean THEN $3 ELSE description_delta END,
        starts_at         = COALESCE($4, starts_at),
        ends_at           = COALESCE($5, ends_at),
        payload           = CASE WHEN $6::jsonb IS NOT NULL
                                 THEN payload || $6::jsonb
                                 ELSE payload END,
        all_members       = COALESCE($7, all_members),
        tag_id            = CASE WHEN $8::boolean THEN $9 ELSE tag_id END,
        source_doc_id     = CASE WHEN $10::boolean THEN $11 ELSE source_doc_id END,
        updated_at        = $12
      WHERE id = $1 AND origin = 'native'
      RETURNING
        id, origin::text AS origin, account_id, workspace_id, remote_event_id,
        starts_at, ends_at, title, description_delta, source_doc_id,
        all_members, tag_id, recurrence_parent_id,
        payload, updated_at, etag, remote_href
      "#,
    )
    .bind(event_id)
    .bind(input.title.as_ref().map(|o| o.as_deref()))
    .bind(input.description_delta.as_ref().and_then(|o| o.as_ref()))
    .bind(input.starts_at)
    .bind(input.ends_at)
    .bind(all_day_patch)
    .bind(input.all_members)
    .bind(input.tag_id.is_some())
    .bind(input.tag_id.as_ref().and_then(|o| *o))
    .bind(input.source_doc_id.is_some())
    .bind(input.source_doc_id.as_ref().and_then(|o| *o))
    .bind(now)
    .bind(input.description_delta.is_some())
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let event = row.map(Self::map_event_base);
    if event.is_some()
      && let Some(recurrence) = &input.recurrence
    {
      crate::scheduling::calendar::set_native_in(&mut tx, event_id, recurrence.as_ref()).await?;
    }
    if event.is_some() {
      projection::reproject_cached_in(&mut tx, event_id).await?;
    }
    if let Some(event) = event.as_ref() {
      match (&input.source_doc_id, &input.source_anchor) {
        (Some(Some(source_doc_id)), _) => {
          Self::replace_created_from_source_link(
            &mut tx,
            event.id,
            *source_doc_id,
            input.source_anchor.as_ref().and_then(|anchor| anchor.as_ref()),
          )
          .await
          .map_err(Self::map_db_err)?;
        }
        (Some(None), _) | (None, Some(None)) => {
          Self::delete_created_from_source_link(&mut tx, event.id)
            .await
            .map_err(Self::map_db_err)?;
        }
        (None, Some(Some(anchor))) => {
          if let Some(source_doc_id) = event.source_doc_id {
            Self::replace_created_from_source_link(&mut tx, event.id, source_doc_id, Some(anchor))
              .await
              .map_err(Self::map_db_err)?;
          }
        }
        (None, None) => {}
      }
    }
    if let Some(event) = mail_intent::load_event(&mut tx, event_id).await? {
      mail_intent::enqueue(&mut tx, &event, "calendar-update", None).await?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(event)
  }

  // ── Workspace calendar settings (P-JCAL-SERVER-01-B) ────────────────────

  #[instrument(skip(self))]
  async fn upsert_workspace_calendar_settings(
    &self,
    settings: &WorkspaceCalendarSettings,
  ) -> RepoResult<WorkspaceCalendarSettings> {
    let row = sqlx::query(
      r#"
      INSERT INTO workspace_calendar_settings
        (workspace_id, writeback_subscription_id, default_reminder_offset_minutes, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (workspace_id) DO UPDATE SET
        writeback_subscription_id      = EXCLUDED.writeback_subscription_id,
        default_reminder_offset_minutes = EXCLUDED.default_reminder_offset_minutes,
        updated_at                     = EXCLUDED.updated_at
      RETURNING workspace_id, writeback_subscription_id, default_reminder_offset_minutes, updated_at
      "#,
    )
    .bind(settings.workspace_id)
    .bind(settings.writeback_subscription_id)
    .bind(settings.default_reminder_offset_minutes)
    .bind(settings.updated_at)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(WorkspaceCalendarSettings {
      workspace_id: row.get("workspace_id"),
      writeback_subscription_id: row.get("writeback_subscription_id"),
      default_reminder_offset_minutes: row.get("default_reminder_offset_minutes"),
      updated_at: row.get("updated_at"),
    })
  }

  #[instrument(skip(self))]
  async fn get_workspace_calendar_settings(&self, workspace_id: Uuid) -> RepoResult<Option<WorkspaceCalendarSettings>> {
    let row = sqlx::query(
      "SELECT workspace_id, writeback_subscription_id, default_reminder_offset_minutes, updated_at
       FROM workspace_calendar_settings WHERE workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(|r| WorkspaceCalendarSettings {
      workspace_id: r.get("workspace_id"),
      writeback_subscription_id: r.get("writeback_subscription_id"),
      default_reminder_offset_minutes: r.get("default_reminder_offset_minutes"),
      updated_at: r.get("updated_at"),
    }))
  }

  // ── Event tag CRUD (P-JCAL-SERVER-01-C) ─────────────────────────────────

  #[instrument(skip(self))]
  async fn insert_calendar_event_tag(&self, tag: &CalendarEventTag) -> RepoResult<CalendarEventTag> {
    let row = sqlx::query(
      r#"
      INSERT INTO calendar_event_tags (id, workspace_id, name, color, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, workspace_id, name, color, created_at, updated_at
      "#,
    )
    .bind(tag.id)
    .bind(tag.workspace_id)
    .bind(&tag.name)
    .bind(&tag.color)
    .bind(tag.created_at)
    .bind(tag.updated_at)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(Self::map_event_tag(row))
  }

  #[instrument(skip(self))]
  async fn update_calendar_event_tag(
    &self,
    tag_id: Uuid,
    workspace_id: Uuid,
    name: &str,
    color: &str,
  ) -> RepoResult<Option<CalendarEventTag>> {
    let now = Utc::now();
    let row = sqlx::query(
      r#"
      UPDATE calendar_event_tags
         SET name = $3, color = $4, updated_at = $5
       WHERE id = $1 AND workspace_id = $2
      RETURNING id, workspace_id, name, color, created_at, updated_at
      "#,
    )
    .bind(tag_id)
    .bind(workspace_id)
    .bind(name)
    .bind(color)
    .bind(now)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(Self::map_event_tag))
  }

  #[instrument(skip(self))]
  async fn delete_calendar_event_tag(&self, tag_id: Uuid, workspace_id: Uuid) -> RepoResult<()> {
    sqlx::query("DELETE FROM calendar_event_tags WHERE id = $1 AND workspace_id = $2")
      .bind(tag_id)
      .bind(workspace_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip(self))]
  async fn list_calendar_event_tags(&self, workspace_id: Uuid) -> RepoResult<Vec<CalendarEventTag>> {
    let rows = sqlx::query(
      "SELECT id, workspace_id, name, color, created_at, updated_at
       FROM calendar_event_tags WHERE workspace_id = $1 ORDER BY name",
    )
    .bind(workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_event_tag).collect())
  }

  #[instrument(skip(self))]
  async fn add_event_exdate(&self, event_id: Uuid, instance_start: DateTime<Utc>) -> RepoResult<()> {
    // Append the ISO-8601 timestamp to payload.exdates (a JSON array).
    // No-ops on external events because of the `AND origin = 'native'` guard.
    sqlx::query(
      r#"
      UPDATE calendar_events
         SET payload = jsonb_set(
               COALESCE(payload, '{}'),
               '{exdates}',
               COALESCE(payload->'exdates', '[]'::jsonb) || to_jsonb($2::text)
             )
       WHERE id = $1 AND origin = 'native'
      "#,
    )
    .bind(event_id)
    .bind(instance_start.to_rfc3339())
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }
}
