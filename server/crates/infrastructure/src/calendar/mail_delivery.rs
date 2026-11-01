// SPDX-License-Identifier: AGPL-3.0-or-later
//! Calendar session locks and short receipt, reclaim and completion steps.

use super::*;
use myoxus_domain::repositories::{
  CalendarMailDeliveryGuard, CalendarMailDeliveryScope, CalendarReminderDeliveryGuard,
};

/// One Calendar-owned session lifecycle for scheduling and reminder delivery.
struct CalendarDeliverySession {
  connection: Option<PoolConnection<Postgres>>,
  key: String,
}

impl Drop for CalendarDeliverySession {
  fn drop(&mut self) {
    if let Some(connection) = self.connection.as_mut() {
      connection.close_on_drop();
    }
  }
}

impl CalendarDeliverySession {
  async fn acquire(pool: &PgPool, key: String) -> RepoResult<Self> {
    // Install cleanup before the lock await: an abandoned acquire may still
    // obtain the session lock before PostgreSQL notices the closed connection.
    let mut session = Self {
      connection: Some(pool.acquire().await.map_err(SqlxCalendarRepository::map_db_err)?),
      key,
    };
    let result = sqlx::query("SELECT pg_advisory_lock(hashtextextended($1,0))")
      .bind(session.key.clone())
      .execute(session.connection()?)
      .await;
    if let Err(error) = result {
      let original = SqlxCalendarRepository::map_db_err(error);
      let _release = session.release().await;
      return Err(original);
    }
    Ok(session)
  }

  fn connection(&mut self) -> RepoResult<&mut sqlx::PgConnection> {
    self
      .connection
      .as_mut()
      .map(|connection| &mut **connection)
      .ok_or_else(|| RepositoryError::Storage("Calendar delivery session already released".into()))
  }
  async fn release(mut self) -> RepoResult<()> {
    let unlocked: bool = sqlx::query_scalar("SELECT pg_advisory_unlock(hashtextextended($1,0))")
      .bind(self.key.clone())
      .fetch_one(self.connection()?)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
    if !unlocked {
      let mut connection = self.connection.take().expect("session owns connection during unlock");
      connection.close_on_drop();
      connection.close().await.map_err(SqlxCalendarRepository::map_db_err)?;
      return Err(RepositoryError::Storage(
        "Calendar delivery lock was not held by its connection".into(),
      ));
    }
    drop(self.connection.take());
    Ok(())
  }
}

pub(super) struct PgCalendarMailDeliveryGuard {
  session: CalendarDeliverySession,
  intent_id: Uuid,
}

impl PgCalendarMailDeliveryGuard {
  pub(super) async fn acquire(pool: &PgPool, intent_id: Uuid) -> RepoResult<Box<dyn CalendarMailDeliveryGuard>> {
    Ok(Box::new(Self {
      session: CalendarDeliverySession::acquire(pool, intent_id.to_string()).await?,
      intent_id,
    }))
  }
}

#[async_trait]
impl CalendarMailDeliveryGuard for PgCalendarMailDeliveryGuard {
  async fn completed(&mut self) -> RepoResult<bool> {
    let intent_id = self.intent_id;
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM calendar_mail_receipts WHERE intent_id=$1)")
      .bind(intent_id)
      .fetch_one(self.session.connection()?)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)
  }

  async fn superseded(&mut self, scope: &CalendarMailDeliveryScope) -> RepoResult<bool> {
    sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM outbox_events WHERE event_type='calendar_mail' \
      AND COALESCE(payload->'event'->>'remote_event_id',payload->'event'->>'id')=$1 \
      AND lower(payload->>'to')=lower($2) \
      AND payload->'event'->'payload'->>'recurrenceId' IS NOT DISTINCT FROM $3 \
      AND (payload->>'sequence')::bigint > $4)",
    )
    .bind(&scope.uid)
    .bind(&scope.recipient)
    .bind(&scope.recurrence_id)
    .bind(i64::from(scope.sequence))
    .fetch_one(self.session.connection()?)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)
  }

  async fn complete(&mut self) -> RepoResult<()> {
    let intent_id = self.intent_id;
    sqlx::query("INSERT INTO calendar_mail_receipts(intent_id) VALUES ($1) ON CONFLICT DO NOTHING")
      .bind(intent_id)
      .execute(self.session.connection()?)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
    Ok(())
  }

  async fn release(self: Box<Self>) -> RepoResult<()> {
    self.session.release().await
  }
}

pub(super) struct PgCalendarReminderDeliveryGuard {
  session: CalendarDeliverySession,
  reminder_id: Uuid,
}

impl PgCalendarReminderDeliveryGuard {
  pub(super) async fn acquire(pool: &PgPool, reminder_id: Uuid) -> RepoResult<Box<dyn CalendarReminderDeliveryGuard>> {
    Ok(Box::new(Self {
      session: CalendarDeliverySession::acquire(pool, format!("calendar-reminder:{reminder_id}")).await?,
      reminder_id,
    }))
  }
}

#[async_trait]
impl CalendarReminderDeliveryGuard for PgCalendarReminderDeliveryGuard {
  async fn begin_dispatch(&mut self, worker_job_id: Uuid, at: DateTime<Utc>) -> RepoResult<bool> {
    let reminder = self.reminder_id;
    let mut tx = self
      .session
      .connection()?
      .begin()
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
    // The session guard is the exclusive owner. A stored pending claim is only
    // recovery bookkeeping; successful recipient receipts remain untouched.
    let pending: Option<bool> =
      sqlx::query_scalar("SELECT delivered_at IS NULL FROM calendar_reminders WHERE id=$1 FOR UPDATE")
        .bind(reminder)
        .fetch_optional(&mut *tx)
        .await
        .map_err(SqlxCalendarRepository::map_db_err)?;
    if pending != Some(true) {
      tx.commit().await.map_err(SqlxCalendarRepository::map_db_err)?;
      return Ok(false);
    }
    sqlx::query(
      "INSERT INTO calendar_reminder_dispatch_log(reminder_id,worker_job_id,dispatched_at) VALUES ($1,$2,$3) \
      ON CONFLICT(reminder_id) DO UPDATE SET worker_job_id=EXCLUDED.worker_job_id,dispatched_at=EXCLUDED.dispatched_at",
    )
    .bind(reminder)
    .bind(worker_job_id)
    .bind(at)
    .execute(&mut *tx)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?;
    tx.commit().await.map_err(SqlxCalendarRepository::map_db_err)?;
    Ok(true)
  }

  async fn contexts(&mut self) -> RepoResult<Vec<CalendarReminderContext>> {
    let reminder = self.reminder_id;
    reminder_contexts(self.session.connection()?, reminder).await
  }

  async fn email_completed(&mut self, user: Uuid) -> RepoResult<bool> {
    let reminder = self.reminder_id;
    sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM calendar_reminder_mail_receipts WHERE reminder_id=$1 AND user_id=$2)",
    )
    .bind(reminder)
    .bind(user)
    .fetch_one(self.session.connection()?)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)
  }

  async fn complete_email(&mut self, user: Uuid) -> RepoResult<()> {
    let reminder = self.reminder_id;
    sqlx::query(
      "INSERT INTO calendar_reminder_mail_receipts(reminder_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    )
    .bind(reminder)
    .bind(user)
    .execute(self.session.connection()?)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?;
    Ok(())
  }

  async fn complete(&mut self, at: DateTime<Utc>) -> RepoResult<()> {
    let reminder = self.reminder_id;
    let mut tx = self
      .session
      .connection()?
      .begin()
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
    let updated =
      sqlx::query("UPDATE calendar_reminders SET delivered_at=$2,updated_at=$2 WHERE id=$1 AND delivered_at IS NULL")
        .bind(reminder)
        .bind(at)
        .execute(&mut *tx)
        .await
        .map_err(SqlxCalendarRepository::map_db_err)?;
    if updated.rows_affected() != 0 {
      let logged = sqlx::query("UPDATE calendar_reminder_dispatch_log SET dispatched_at=$2 WHERE reminder_id=$1")
        .bind(reminder)
        .bind(at)
        .execute(&mut *tx)
        .await
        .map_err(SqlxCalendarRepository::map_db_err)?;
      if logged.rows_affected() != 1 {
        return Err(RepositoryError::Storage(
          "Calendar reminder dispatch log disappeared before completion".into(),
        ));
      }
    }
    tx.commit().await.map_err(SqlxCalendarRepository::map_db_err)?;
    Ok(())
  }

  async fn release(self: Box<Self>) -> RepoResult<()> {
    self.session.release().await
  }
}

pub(super) async fn reminder_contexts(
  connection: &mut sqlx::PgConnection,
  reminder_id: Uuid,
) -> RepoResult<Vec<CalendarReminderContext>> {
  let rows = sqlx::query(
      r#"
      SELECT
          r.id            AS reminder_id,
          r.event_id,
          r.channel,
          r.minutes_before,
          r.scheduled_for,
          r.delivered_at,
          r.created_at    AS r_created_at,
          r.updated_at    AS r_updated_at,
          e.title         AS event_title,
          e.starts_at,
          u.id AS user_id,
          u.email         AS user_email
      FROM calendar_reminders r
      JOIN calendar_events    e ON e.id = r.event_id
      LEFT JOIN calendar_accounts a ON a.id = e.account_id
      LEFT JOIN workspaces w ON w.id = e.workspace_id
      JOIN users u ON u.id = a.user_id OR (e.origin = 'native' AND (
        (e.all_members AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=e.workspace_id AND m.user_id=u.id AND m.status='Accepted'))
        OR (NOT e.all_members AND (u.id=w.owner_user_id OR EXISTS (SELECT 1 FROM calendar_event_participants p WHERE p.event_id=e.id AND (p.user_id=u.id OR lower(p.email)=lower(u.email)))))))
      WHERE r.id = $1 AND u.status = 'active' AND (w.id IS NULL OR w.deleted_at IS NULL)
      ORDER BY u.id
      "#,
    )
    .bind(reminder_id)
    .fetch_all(connection)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?;

  Ok(
    rows
      .into_iter()
      .map(|row| {
        let reminder = CalendarReminder {
          id: row.get("reminder_id"),
          event_id: row.get("event_id"),
          channel: row.get("channel"),
          minutes_before: row.get("minutes_before"),
          scheduled_for: row.get("scheduled_for"),
          delivered_at: row.get("delivered_at"),
          created_at: row.get("r_created_at"),
          updated_at: row.get("r_updated_at"),
        };
        CalendarReminderContext {
          reminder,
          user_id: row.get("user_id"),
          user_email: row.get("user_email"),
          event_title: row.try_get("event_title").unwrap_or_default(),
          starts_at: row.get("starts_at"),
        }
      })
      .collect(),
  )
}
