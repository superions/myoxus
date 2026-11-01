// SPDX-License-Identifier: AGPL-3.0-or-later
mod hooks;
use crate::workspace_database::*;

impl PgDatabaseRepository {
  pub(in crate::workspace_database) fn map_database_row_reminder(
    row: sqlx::postgres::PgRow,
  ) -> RepoResult<DatabaseRowReminder> {
    let status = DatabaseRowReminderStatus::from_db(
      row
        .try_get::<String, _>("status")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Ok(DatabaseRowReminder {
      id: row.try_get("id").map_err(Self::map_sqlx_error)?,
      workspace_id: row.try_get("workspace_id").map_err(Self::map_sqlx_error)?,
      database_id: row.try_get("database_id").map_err(Self::map_sqlx_error)?,
      row_id: row.try_get("row_id").map_err(Self::map_sqlx_error)?,
      field_id: row.try_get("field_id").map_err(Self::map_sqlx_error)?,
      user_id: row.try_get("user_id").map_err(Self::map_sqlx_error)?,
      offset_minutes: row.try_get("offset_minutes").map_err(Self::map_sqlx_error)?,
      trigger_at: row.try_get("trigger_at").map_err(Self::map_sqlx_error)?,
      status,
      schedule_revision: row.try_get("schedule_revision").map_err(Self::map_sqlx_error)?,
      claim_token: row.try_get("claim_token").map_err(Self::map_sqlx_error)?,
      claim_expires_at: row.try_get("claim_expires_at").map_err(Self::map_sqlx_error)?,
      claim_attempts: row.try_get("claim_attempts").map_err(Self::map_sqlx_error)?,
      fired_at: row.try_get("fired_at").map_err(Self::map_sqlx_error)?,
      cancelled_at: row.try_get("cancelled_at").map_err(Self::map_sqlx_error)?,
      created_at: row.try_get("created_at").map_err(Self::map_sqlx_error)?,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
    })
  }
}
#[async_trait]
impl DatabaseReminderRepository for PgDatabaseRepository {
  #[instrument(skip(self, reminder), fields(reminder_id = %reminder.id, workspace_id = %reminder.workspace_id, database_id = %reminder.database_id, row_id = %reminder.row_id, field_id = %reminder.field_id, user_id = %reminder.user_id, trigger_at = %reminder.trigger_at))]
  async fn upsert_database_row_reminder(&self, reminder: DatabaseRowReminder) -> RepoResult<DatabaseRowReminder> {
    let mut tx = self.begin_write().await?;
    Self::lock_managed_admission(&mut tx, reminder.database_id).await?;
    sqlx::query("SELECT id FROM workspace_databases WHERE id=$1 ORDER BY id FOR NO KEY UPDATE")
      .bind(reminder.database_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    sqlx::query(
      "SELECT id FROM workspace_database_fields WHERE database_id=$1 AND
        (id=$2 OR id IN (SELECT field_id FROM database_field_roles WHERE database_id=$1
          AND role_key='task.status' AND row_kind_scope='task' AND profile_kind='project'))
       ORDER BY id FOR SHARE",
    )
    .bind(reminder.database_id)
    .bind(reminder.field_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    sqlx::query("SELECT id FROM workspace_database_rows WHERE id=$1 AND database_id=$2 FOR UPDATE")
      .bind(reminder.row_id)
      .bind(reminder.database_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    if !Self::task_reminder_is_open(&mut tx, reminder.database_id, reminder.row_id).await? {
      return Err(RepositoryError::Validation("database reminder Task is not open".into()));
    }
    let task: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM workspace_database_rows target JOIN database_profiles profile
       ON profile.database_id=target.database_id AND profile.profile_kind='project'
       WHERE target.id=$1 AND target.row_kind='task')",
    )
    .bind(reminder.row_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if task {
      let raw: Option<Value> =
        sqlx::query_scalar("SELECT value_json FROM workspace_database_cell_values WHERE row_id=$1 AND field_id=$2")
          .bind(reminder.row_id)
          .bind(reminder.field_id)
          .fetch_optional(&mut *tx)
          .await
          .map_err(Self::map_sqlx_error)?
          .flatten();
      let value = raw.and_then(|raw| serde_json::from_value::<DatabaseDateTimeValue>(raw).ok());
      if value
        .as_ref()
        .and_then(|value| database_row_reminder_trigger_at(value, reminder.offset_minutes).ok())
        != Some(reminder.trigger_at)
      {
        return Err(RepositoryError::Conflict("database reminder schedule revision"));
      }
    }
    let row = sqlx::query(
      r#"
        WITH valid_target AS (
          SELECT database.id
          FROM workspace_databases AS database
          JOIN workspaces workspace ON workspace.id=database.workspace_id AND workspace.deleted_at IS NULL
          JOIN workspace_database_rows AS target_row
            ON target_row.database_id = database.id
           AND target_row.id = $3
           AND target_row.deleted_at IS NULL
          JOIN workspace_database_fields AS field
            ON field.database_id = database.id
           AND field.id = $4
           AND field.field_type = 'date_time'
           AND COALESCE((field.config_json->>'allowReminders')::boolean,false)
          WHERE database.id = $2
            AND database.workspace_id = $1
            AND database.deleted_at IS NULL
          FOR UPDATE OF target_row
        )
        INSERT INTO database_row_reminders (
          id, workspace_id, database_id, row_id, field_id, user_id,
          offset_minutes, trigger_at, status, schedule_revision,
          claim_token, claim_expires_at, claim_attempts, fired_at,
          cancelled_at, created_at, updated_at
        )
        SELECT $5, $1, $2, $3, $4, $6, $7, $8, 'scheduled', 1,
               NULL, NULL, 0, NULL, NULL, $9, $9
        FROM valid_target
        ON CONFLICT (user_id, row_id, field_id, offset_minutes)
          WHERE status IN ('scheduled', 'claimed')
        DO UPDATE SET
          trigger_at = EXCLUDED.trigger_at,
          status = 'scheduled',
          schedule_revision = database_row_reminders.schedule_revision + 1,
          claim_token = NULL,
          claim_expires_at = NULL,
          fired_at = NULL,
          cancelled_at = NULL,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      "#,
    )
    .bind(reminder.workspace_id)
    .bind(reminder.database_id)
    .bind(reminder.row_id)
    .bind(reminder.field_id)
    .bind(reminder.id)
    .bind(reminder.user_id)
    .bind(reminder.offset_minutes)
    .bind(reminder.trigger_at)
    .bind(reminder.updated_at)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database reminder target"))?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Self::map_database_row_reminder(row)
  }

  async fn list_database_row_reminders(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    user_id: UserId,
  ) -> RepoResult<Vec<DatabaseRowReminder>> {
    let rows = sqlx::query(
      r#"
        SELECT *
        FROM database_row_reminders
        WHERE database_id = $1 AND row_id = $2 AND field_id = $3
          AND user_id = $4 AND status IN ('scheduled', 'claimed')
        ORDER BY trigger_at ASC, offset_minutes ASC, id ASC
      "#,
    )
    .bind(database_id)
    .bind(row_id)
    .bind(field_id)
    .bind(user_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    rows.into_iter().map(Self::map_database_row_reminder).collect()
  }

  async fn list_live_database_row_reminders_for_cell(
    &self,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
  ) -> RepoResult<Vec<DatabaseRowReminder>> {
    let rows = sqlx::query(
      r#"
        SELECT *
        FROM database_row_reminders
        WHERE row_id = $1 AND field_id = $2
          AND status IN ('scheduled', 'claimed')
        ORDER BY id
      "#,
    )
    .bind(row_id)
    .bind(field_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    rows.into_iter().map(Self::map_database_row_reminder).collect()
  }

  #[instrument(skip(self), fields(database_id = %database_id, reminder_id = %reminder_id, user_id = %user_id))]
  async fn cancel_database_row_reminder(
    &self,
    database_id: DatabaseId,
    reminder_id: Uuid,
    user_id: UserId,
    cancelled_at: DateTime<Utc>,
  ) -> RepoResult<bool> {
    let result = sqlx::query(
      r#"
        UPDATE database_row_reminders
        SET status = 'cancelled', schedule_revision = schedule_revision + 1,
            claim_token = NULL, claim_expires_at = NULL,
            cancelled_at = $4, updated_at = $4
        WHERE database_id = $1 AND id = $2 AND user_id = $3
          AND status IN ('scheduled', 'claimed')
      "#,
    )
    .bind(database_id)
    .bind(reminder_id)
    .bind(user_id)
    .bind(cancelled_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(result.rows_affected() == 1)
  }

  #[instrument(skip(self), fields(limit, claim_expires_at = %claim_expires_at))]
  async fn claim_due_database_row_reminders(
    &self,
    now: DateTime<Utc>,
    claim_expires_at: DateTime<Utc>,
    limit: i64,
  ) -> RepoResult<Vec<DatabaseRowReminder>> {
    let mut tx = self.begin_write().await?;
    let rows = sqlx::query(
      r#"
        WITH due AS (
          SELECT reminder.id
          FROM database_row_reminders reminder
          JOIN workspace_databases database
            ON database.id = reminder.database_id
           AND database.deleted_at IS NULL
          WHERE reminder.status = 'scheduled' AND reminder.trigger_at <= $1
            AND NOT EXISTS(SELECT 1 FROM workspace_databases d JOIN database_profiles p ON p.database_id=d.id AND p.profile_kind='project'
              WHERE d.id=reminder.database_id AND NOT myoxus_database_source_admitted(d.managed_installation))
          ORDER BY reminder.trigger_at ASC, reminder.id ASC
          FOR UPDATE OF reminder SKIP LOCKED
          LIMIT $2
        )
        UPDATE database_row_reminders AS reminder
        SET status = 'claimed', claim_token = gen_random_uuid(),
            claim_expires_at = $3, claim_attempts = claim_attempts + 1,
            updated_at = $1
        FROM due
        WHERE reminder.id = due.id
        RETURNING reminder.*
      "#,
    )
    .bind(now)
    .bind(limit.clamp(1, 1_000))
    .bind(claim_expires_at)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    rows.into_iter().map(Self::map_database_row_reminder).collect()
  }

  async fn release_expired_database_row_reminder_claims(&self, now: DateTime<Utc>) -> RepoResult<u64> {
    let result = sqlx::query(
      r#"
        UPDATE database_row_reminders
        SET status = 'scheduled', claim_token = NULL, claim_expires_at = NULL,
            updated_at = $1
        WHERE status = 'claimed' AND claim_expires_at <= $1
      "#,
    )
    .bind(now)
    .execute(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(result.rows_affected())
  }

  async fn release_database_row_reminder_claim(
    &self,
    reminder_id: Uuid,
    schedule_revision: i64,
    claim_token: Uuid,
  ) -> RepoResult<bool> {
    let result = sqlx::query(
      r#"
        UPDATE database_row_reminders
        SET status = 'scheduled', claim_token = NULL, claim_expires_at = NULL,
            updated_at = now()
        WHERE id = $1 AND schedule_revision = $2 AND claim_token = $3
          AND status = 'claimed'
      "#,
    )
    .bind(reminder_id)
    .bind(schedule_revision)
    .bind(claim_token)
    .execute(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(result.rows_affected() == 1)
  }

  async fn mark_database_row_reminder_enqueued(
    &self,
    reminder_id: Uuid,
    schedule_revision: i64,
    claim_token: Uuid,
    fired_at: DateTime<Utc>,
  ) -> RepoResult<bool> {
    let result = sqlx::query(
      r#"
        UPDATE database_row_reminders
        SET status = 'fired', claim_token = NULL, claim_expires_at = NULL,
            fired_at = $4, updated_at = $4
        WHERE id = $1 AND schedule_revision = $2 AND claim_token = $3
          AND status = 'claimed'
      "#,
    )
    .bind(reminder_id)
    .bind(schedule_revision)
    .bind(claim_token)
    .bind(fired_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(result.rows_affected() == 1)
  }

  async fn get_database_row_reminder_dispatch(
    &self,
    reminder_id: Uuid,
    schedule_revision: i64,
    trigger_at: DateTime<Utc>,
    user_id: UserId,
  ) -> RepoResult<Option<DatabaseRowReminderDispatch>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    self.capture_managed_admission(&mut tx).await?;
    // An unavailable local descriptor is not terminal target denial. Returning
    // an error preserves the generation instead of letting dispatch cancel it.
    let unavailable: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM database_row_reminders reminder JOIN workspace_databases d ON d.id=reminder.database_id JOIN database_profiles p ON p.database_id=d.id AND p.profile_kind='project' WHERE reminder.id=$1 AND reminder.schedule_revision=$2 AND reminder.trigger_at=$3 AND reminder.user_id=$4 AND reminder.status IN('claimed','fired') AND NOT myoxus_database_source_admitted(d.managed_installation))")
      .bind(reminder_id).bind(schedule_revision).bind(trigger_at).bind(user_id).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    if unavailable {
      return Err(RepositoryError::Validation(
        "managed reminder schema unavailable on this node".into(),
      ));
    }
    let row = sqlx::query(
      r#"
        SELECT reminder.*, target_row.title AS row_title,
               field.name AS field_name,
               (cell.value_json ->> 'start')::timestamptz AS scheduled_for
        FROM database_row_reminders AS reminder
        JOIN workspace_databases AS database
          ON database.id = reminder.database_id
         AND database.deleted_at IS NULL
         AND database.workspace_id=reminder.workspace_id
         AND (NOT EXISTS(SELECT 1 FROM database_profiles profile WHERE profile.database_id=database.id AND profile.profile_kind='project')
           OR myoxus_database_source_admitted(database.managed_installation))
        JOIN workspaces workspace ON workspace.id=database.workspace_id AND workspace.deleted_at IS NULL
        JOIN workspace_database_rows AS target_row
          ON target_row.id = reminder.row_id
         AND target_row.database_id = reminder.database_id
         AND target_row.deleted_at IS NULL
        JOIN workspace_database_fields AS field
          ON field.id = reminder.field_id
         AND field.database_id = reminder.database_id
         AND field.field_type = 'date_time'
         AND COALESCE((field.config_json ->> 'allowReminders')::boolean, false)
        JOIN workspace_database_cell_values AS cell
          ON cell.row_id = reminder.row_id
         AND cell.field_id = reminder.field_id
         AND cell.value_json IS NOT NULL
        JOIN workspace_memberships AS membership
          ON membership.workspace_id = reminder.workspace_id
         AND membership.user_id = reminder.user_id
         AND membership.status = 'Accepted'
        JOIN users recipient ON recipient.id=reminder.user_id AND recipient.status='active'
        WHERE reminder.id = $1
          AND reminder.schedule_revision = $2
          AND reminder.trigger_at = $3
          AND reminder.user_id = $4
          AND reminder.status IN ('claimed', 'fired')
      "#,
    )
    .bind(reminder_id)
    .bind(schedule_revision)
    .bind(trigger_at)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if let Some(row) = row.as_ref() {
      let database_id = row.try_get("database_id").map_err(Self::map_sqlx_error)?;
      let row_id = row.try_get("row_id").map_err(Self::map_sqlx_error)?;
      if !Self::task_reminder_is_open(&mut tx, database_id, row_id).await? {
        return Ok(None);
      }
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    row
      .map(|row| {
        let row_title = row.try_get("row_title").map_err(Self::map_sqlx_error)?;
        let field_name = row.try_get("field_name").map_err(Self::map_sqlx_error)?;
        let scheduled_for = row.try_get("scheduled_for").map_err(Self::map_sqlx_error)?;
        Ok(DatabaseRowReminderDispatch {
          reminder: Self::map_database_row_reminder(row)?,
          row_title,
          field_name,
          scheduled_for,
        })
      })
      .transpose()
  }

  async fn cancel_database_row_reminder_generation(
    &self,
    reminder_id: Uuid,
    schedule_revision: i64,
    cancelled_at: DateTime<Utc>,
  ) -> RepoResult<bool> {
    let result = sqlx::query(
      r#"
        UPDATE database_row_reminders
        SET status = 'cancelled', schedule_revision = schedule_revision + 1,
            claim_token = NULL, claim_expires_at = NULL,
            cancelled_at = $3, updated_at = $3
        WHERE id = $1 AND schedule_revision = $2
          AND status IN ('scheduled', 'claimed', 'fired')
      "#,
    )
    .bind(reminder_id)
    .bind(schedule_revision)
    .bind(cancelled_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(result.rows_affected() == 1)
  }
}
