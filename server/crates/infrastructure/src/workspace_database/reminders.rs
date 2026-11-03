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
          offset_minutes, status, fired_at, cancelled_at, created_at, updated_at
        )
        SELECT $5, $1, $2, $3, $4, $6, $7, 'scheduled', NULL, NULL, $8, $8
        FROM valid_target
        ON CONFLICT (user_id, row_id, field_id, offset_minutes)
          WHERE status IN ('scheduled', 'claimed')
        DO UPDATE SET
          status = 'scheduled',
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
    .bind(reminder.updated_at)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database reminder target"))?;
    let id: Uuid = row.try_get("id").map_err(Self::map_sqlx_error)?;
    crate::scheduling::database_reminders::set_in(
      &mut tx,
      id,
      reminder.workspace_id,
      reminder.user_id,
      reminder.trigger_at,
      None,
    )
    .await?;
    let row=sqlx::query("SELECT r.*,s.next_due_at AS trigger_at,s.generation AS schedule_revision FROM database_row_reminders r JOIN scheduling_schedules s ON s.id=r.id WHERE r.id=$1")
      .bind(id).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
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
        SELECT r.*,s.next_due_at AS trigger_at,s.generation AS schedule_revision
        FROM database_row_reminders r JOIN scheduling_schedules s ON s.id=r.id
        WHERE r.database_id = $1 AND r.row_id = $2 AND r.field_id = $3
          AND r.user_id = $4 AND r.status IN ('scheduled', 'claimed')
        ORDER BY s.next_due_at ASC, r.offset_minutes ASC, r.id ASC
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
        SELECT r.*,s.next_due_at AS trigger_at,s.generation AS schedule_revision
        FROM database_row_reminders r JOIN scheduling_schedules s ON s.id=r.id
        WHERE r.row_id = $1 AND r.field_id = $2
          AND r.status IN ('scheduled', 'claimed')
        ORDER BY r.id
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
    let mut tx = self.begin_write().await?;
    let changed: Option<Uuid> = sqlx::query_scalar(
      r#"
        UPDATE database_row_reminders
        SET status = 'cancelled', cancelled_at = $4, updated_at = $4
        WHERE database_id = $1 AND id = $2 AND user_id = $3
          AND status IN ('scheduled', 'claimed')
        RETURNING id
      "#,
    )
    .bind(database_id)
    .bind(reminder_id)
    .bind(user_id)
    .bind(cancelled_at)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if let Some(id) = changed {
      crate::scheduling::database_reminders::end_in(&mut tx, &[id], true).await?;
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(changed.is_some())
  }

  async fn get_database_row_reminder_dispatch(
    &self,
    reminder_id: Uuid,
    schedule_revision: i64,
    trigger_at: DateTime<Utc>,
    user_id: UserId,
  ) -> RepoResult<Option<DatabaseRowReminderDispatch>> {
    self
      .read_reminder_dispatch(reminder_id, schedule_revision, trigger_at, user_id, false)
      .await
  }

  async fn prepare_database_row_reminder_dispatch(
    &self,
    reminder_id: Uuid,
    schedule_revision: i64,
    trigger_at: DateTime<Utc>,
    user_id: UserId,
  ) -> RepoResult<Option<DatabaseRowReminderDispatch>> {
    self
      .read_reminder_dispatch(reminder_id, schedule_revision, trigger_at, user_id, true)
      .await
  }

  async fn cancel_database_row_reminder_generation(
    &self,
    reminder_id: Uuid,
    schedule_revision: i64,
    cancelled_at: DateTime<Utc>,
  ) -> RepoResult<bool> {
    self
      .cancel_reminder_generation(reminder_id, schedule_revision, cancelled_at)
      .await
  }
}

impl PgDatabaseRepository {
  /// Preparation and queued delivery share validation, but not eligibility:
  /// scheduled work can be prepared without authorizing its premature delivery.
  async fn read_reminder_dispatch(
    &self,
    reminder_id: Uuid,
    schedule_revision: i64,
    trigger_at: DateTime<Utc>,
    user_id: UserId,
    admission: bool,
  ) -> RepoResult<Option<DatabaseRowReminderDispatch>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    self.capture_managed_admission(&mut tx).await?;
    // An unavailable local descriptor is not terminal target denial. Returning
    // an error preserves the generation instead of letting dispatch cancel it.
    let unavailable: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM database_row_reminders reminder JOIN scheduling_schedules schedule ON schedule.id=reminder.id JOIN workspace_databases d ON d.id=reminder.database_id JOIN database_profiles p ON p.database_id=d.id AND p.profile_kind='project' WHERE reminder.id=$1 AND schedule.generation=$2 AND schedule.next_due_at=$3 AND reminder.user_id=$4 AND (($5 AND reminder.status IN('scheduled','claimed')) OR (NOT $5 AND reminder.status IN('claimed','fired'))) AND NOT myoxus_database_source_admitted(d.managed_installation))")
      .bind(reminder_id).bind(schedule_revision).bind(trigger_at).bind(user_id).bind(admission).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    if unavailable {
      return Err(RepositoryError::Validation(
        "managed reminder schema unavailable on this node".into(),
      ));
    }
    let row = sqlx::query(
      r#"
        SELECT reminder.*,schedule.next_due_at AS trigger_at,schedule.generation AS schedule_revision,
               target_row.title AS row_title,
               field.name AS field_name,
               (cell.value_json ->> 'start')::timestamptz AS scheduled_for
        FROM database_row_reminders AS reminder
        JOIN scheduling_schedules schedule ON schedule.id=reminder.id
          AND schedule.target_json->>'kind'='database_reminder'
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
          AND schedule.generation = $2
          AND schedule.next_due_at = $3
          AND reminder.user_id = $4
          AND (($5 AND reminder.status IN ('scheduled','claimed'))
            OR (NOT $5 AND reminder.status IN ('claimed','fired')))
      "#,
    )
    .bind(reminder_id)
    .bind(schedule_revision)
    .bind(trigger_at)
    .bind(user_id)
    .bind(admission)
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

  async fn cancel_reminder_generation(
    &self,
    reminder_id: Uuid,
    schedule_revision: i64,
    cancelled_at: DateTime<Utc>,
  ) -> RepoResult<bool> {
    let mut tx = self.begin_write().await?;
    let native: Option<Uuid> = sqlx::query_scalar(
      "SELECT id FROM database_row_reminders WHERE id=$1 AND status IN('scheduled','claimed','fired') FOR UPDATE",
    )
    .bind(reminder_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if native.is_none() {
      return Ok(false);
    }
    // Read the fence after native ownership, in the same order as admission
    // and edits. A snapshot taken before waiting for a new edit cannot cancel it.
    let generation: Option<i64> = sqlx::query_scalar(
      "SELECT generation FROM scheduling_schedules WHERE id=$1 AND target_json->>'kind'='database_reminder' FOR UPDATE",
    )
    .bind(reminder_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if generation != Some(schedule_revision) {
      return Ok(false);
    }
    let changed: Option<Uuid> = sqlx::query_scalar(
      r#"
        UPDATE database_row_reminders reminder
        SET status = 'cancelled',
            cancelled_at = $2, updated_at = $2
        WHERE reminder.id = $1
          AND reminder.status IN ('scheduled', 'claimed', 'fired')
        RETURNING reminder.id
      "#,
    )
    .bind(reminder_id)
    .bind(cancelled_at)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if let Some(id) = changed {
      crate::scheduling::database_reminders::end_in(&mut tx, &[id], true).await?;
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(changed.is_some())
  }
}
