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
  contexts: Option<Vec<CalendarReminderContext>>,
  generation: Option<i64>,
}

impl PgCalendarReminderDeliveryGuard {
  pub(super) async fn acquire(pool: &PgPool, reminder_id: Uuid) -> RepoResult<Box<dyn CalendarReminderDeliveryGuard>> {
    Ok(Box::new(Self {
      session: CalendarDeliverySession::acquire(pool, format!("calendar-reminder:{reminder_id}")).await?,
      reminder_id,
      contexts: None,
      generation: None,
    }))
  }
}

#[async_trait]
impl CalendarReminderDeliveryGuard for PgCalendarReminderDeliveryGuard {
  async fn begin_dispatch(
    &mut self,
    worker_job_id: Uuid,
    at: DateTime<Utc>,
    admission: Option<&myoxus_domain::entities::CalendarReminderAdmission>,
  ) -> RepoResult<bool> {
    self.contexts = None;
    self.generation = None;
    let reminder = self.reminder_id;
    let mut tx = self
      .session
      .connection()?
      .begin()
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
    // The session guard is the exclusive owner. A stored pending claim is only
    // recovery bookkeeping; successful recipient receipts remain untouched.
    let source:Option<Uuid>=sqlx::query_scalar("SELECT COALESCE(e.recurrence_parent_id,e.id) FROM calendar_reminders r JOIN calendar_reminder_definitions d ON d.id=r.definition_id JOIN calendar_events e ON e.id=d.event_id WHERE r.id=$1")
      .bind(reminder).fetch_optional(&mut *tx).await.map_err(SqlxCalendarRepository::map_db_err)?;
    let Some(source) = source else {
      tx.commit().await.map_err(SqlxCalendarRepository::map_db_err)?;
      return Ok(false);
    };
    let source = sqlx::query("SELECT payload FROM calendar_events WHERE id=$1 FOR SHARE")
      .bind(source)
      .fetch_one(&mut *tx)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
    if source.get::<serde_json::Value, _>("payload")["status"]
      .as_str()
      .is_some_and(|status| status.eq_ignore_ascii_case("CANCELLED"))
    {
      tx.commit().await.map_err(SqlxCalendarRepository::map_db_err)?;
      return Ok(false);
    }
    let pending: Option<bool> = sqlx::query_scalar(
      "SELECT r.delivered_at IS NULL AND NOT r.suppressed AND r.scheduled_for<=$4 AND r.scheduling_generation=s.generation AND s.lifecycle='active' AND NOT COALESCE(upper(e.payload->>'status')='CANCELLED',false) AND (($2::bigint IS NULL AND r.id=r.definition_id AND r.imported_delivery) OR ($2=r.scheduling_generation AND $3::uuid=r.definition_id AND EXISTS(SELECT 1 FROM scheduling_occurrences o WHERE o.schedule_id=$3 AND o.generation=$2 AND o.nominal_due_at=r.instance_start))) FROM calendar_reminders r JOIN scheduling_schedules s ON s.id=r.definition_id JOIN calendar_reminder_definitions d ON d.id=r.definition_id JOIN calendar_events e ON e.id=d.event_id WHERE r.id=$1 FOR UPDATE OF r",
    )
    .bind(reminder)
    .bind(admission.map(|fence|fence.generation))
    .bind(admission.map(|fence|fence.schedule_id))
    .bind(at)
    .fetch_optional(&mut *tx)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?;
    if pending != Some(true) || admission.is_some_and(|fence| fence.version != 1 || fence.generation < 1) {
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
    // Freeze the accepted generation's actual times and recipient view before
    // releasing SQL locks. A concurrent edit must not retime this SMTP attempt.
    self.contexts = Some(reminder_contexts(&mut *tx, reminder).await?);
    self.generation = Some(
      sqlx::query_scalar("SELECT scheduling_generation FROM calendar_reminders WHERE id=$1")
        .bind(reminder)
        .fetch_one(&mut *tx)
        .await
        .map_err(SqlxCalendarRepository::map_db_err)?,
    );
    tx.commit().await.map_err(SqlxCalendarRepository::map_db_err)?;
    Ok(true)
  }

  async fn contexts(&mut self) -> RepoResult<Vec<CalendarReminderContext>> {
    Ok(self.contexts.clone().unwrap_or_default())
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

  async fn is_current(&mut self) -> RepoResult<bool> {
    let reminder = self.reminder_id;
    let generation = self.generation;
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM calendar_reminders r JOIN scheduling_schedules s ON s.id=r.definition_id WHERE r.id=$1 AND r.scheduling_generation=$2 AND s.generation=$2 AND NOT r.suppressed AND r.delivered_at IS NULL AND s.lifecycle='active')")
      .bind(reminder).bind(generation).fetch_one(self.session.connection()?).await.map_err(SqlxCalendarRepository::map_db_err)
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

  async fn complete(&mut self, at: DateTime<Utc>) -> RepoResult<bool> {
    let reminder = self.reminder_id;
    let generation = self.generation;
    let mut tx = self
      .session
      .connection()?
      .begin()
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
    let updated =
       sqlx::query("UPDATE calendar_reminders r SET delivered_at=$2,updated_at=$2 WHERE id=$1 AND delivered_at IS NULL AND scheduling_generation=$3 AND NOT suppressed AND EXISTS(SELECT 1 FROM scheduling_schedules s WHERE s.id=r.definition_id AND s.generation=$3 AND s.lifecycle='active')")
         .bind(reminder)
         .bind(at)
         .bind(generation)
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
    Ok(updated.rows_affected() != 0)
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
           COALESCE(r.override_title,e.title) AS event_title,
           r.occurrence_start AS starts_at,
           r.occurrence_end AS ends_at,
           r.occurrence_all_day AS all_day,
           e.workspace_id,
           CASE WHEN jsonb_typeof(e.payload->'location')='string' THEN e.payload->>'location' END AS location,
          u.id AS user_id,
          u.email         AS user_email
      FROM calendar_reminders r
      JOIN calendar_events    e ON e.id = r.event_id
      LEFT JOIN calendar_accounts a ON a.id = e.account_id
      LEFT JOIN workspaces w ON w.id = e.workspace_id
      JOIN users u ON u.id = a.user_id OR (e.origin = 'native' AND (
        (e.all_members AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=e.workspace_id AND m.user_id=u.id AND m.status='Accepted'))
        OR (NOT e.all_members AND (u.id=w.owner_user_id OR EXISTS (SELECT 1 FROM calendar_event_participants p WHERE p.event_id=e.id AND (p.user_id=u.id OR lower(p.email)=lower(u.email)))))))
       WHERE r.id = $1 AND NOT r.suppressed AND u.status = 'active' AND (w.id IS NULL OR w.deleted_at IS NULL)
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
          ends_at: row.get("ends_at"),
          all_day: row.get("all_day"),
          workspace_id: row.get("workspace_id"),
          location: row.get("location"),
        }
      })
      .collect(),
  )
}
