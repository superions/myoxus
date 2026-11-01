// SPDX-License-Identifier: AGPL-3.0-or-later
//! Reminder generation changes inside the caller-owned edit transaction.
//! These helpers neither commit nor dispatch; stale queued envelopes stay fenced.

use crate::workspace_database::*;

impl PgDatabaseRepository {
  /// Read current Task eligibility from canonical role/config/Cell state.
  /// Writers call this after their Row lock; dispatch uses one read snapshot.
  /// Generic and non-Task Rows retain their existing DateTime capability.
  pub(in crate::workspace_database) async fn task_reminder_is_open(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
  ) -> RepoResult<bool> {
    let row = sqlx::query(
      r#"SELECT profile.profile_kind, target.row_kind, target.deleted_at IS NULL AS live,
          field.field_type, field.config_json, cell.value_json
        FROM workspace_database_rows target
        LEFT JOIN database_profiles profile ON profile.database_id=target.database_id
        LEFT JOIN database_field_roles role ON role.database_id=target.database_id
          AND role.role_key='task.status' AND role.row_kind_scope='task' AND role.profile_kind='project'
        LEFT JOIN workspace_database_fields field ON field.id=role.field_id AND field.database_id=role.database_id
        LEFT JOIN workspace_database_cell_values cell ON cell.row_id=target.id AND cell.field_id=field.id
        WHERE target.id=$1 AND target.database_id=$2"#,
    )
    .bind(row_id)
    .bind(database_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let Some(row) = row else { return Ok(false) };
    let project: Option<String> = row.try_get("profile_kind").map_err(Self::map_sqlx_error)?;
    let kind: String = row.try_get("row_kind").map_err(Self::map_sqlx_error)?;
    if project.as_deref() != Some("project") || kind != "task" {
      return Ok(true);
    }
    let live: bool = row.try_get("live").map_err(Self::map_sqlx_error)?;
    let field_type: Option<String> = row.try_get("field_type").map_err(Self::map_sqlx_error)?;
    let config: Option<Value> = row.try_get("config_json").map_err(Self::map_sqlx_error)?;
    if !live || field_type.as_deref() != Some("status") {
      return Ok(false);
    }
    let Some(Ok(DatabaseFieldConfig::Status(config))) = config.map(serde_json::from_value::<DatabaseFieldConfig>)
    else {
      return Ok(false);
    };
    let value: Option<Value> = row.try_get("value_json").map_err(Self::map_sqlx_error)?;
    let value = match value {
      None | Some(Value::Null) => None,
      Some(Value::String(id)) => Some(DatabaseCellValueData::Status(id)),
      _ => return Ok(false),
    };
    Ok(database_task_status_allows_reminders(&config, value.as_ref()))
  }

  pub(in crate::workspace_database) async fn reschedule_database_row_reminders(
    tx: &mut Transaction<'_, Postgres>,
    targets: &[(DatabaseRowId, DatabaseFieldId)],
    reschedules: Vec<DatabaseRowReminderReschedule>,
  ) -> RepoResult<()> {
    if targets.is_empty() {
      if reschedules.is_empty() {
        return Ok(());
      }
      return Err(RepositoryError::Conflict("database reminder schedule revision"));
    }
    let mut locked = Vec::new();
    for (row_id, field_id) in targets {
      locked.extend(Self::lock_cell_reminder_generations(tx, *row_id, *field_id).await?);
    }
    if locked.len() != reschedules.len() {
      return Err(RepositoryError::Conflict("database reminder schedule revision"));
    }
    let reschedules = reschedules
      .into_iter()
      .map(|reschedule| (reschedule.reminder_id, reschedule))
      .collect::<HashMap<_, _>>();
    for row in locked {
      let reminder_id: Uuid = row.try_get("id").map_err(Self::map_sqlx_error)?;
      let revision: i64 = row.try_get("schedule_revision").map_err(Self::map_sqlx_error)?;
      let Some(reschedule) = reschedules.get(&reminder_id) else {
        return Err(RepositoryError::Conflict("database reminder schedule revision"));
      };
      if reschedule.expected_schedule_revision != revision {
        return Err(RepositoryError::Conflict("database reminder schedule revision"));
      }
      let updated = Self::reschedule_reminder_generation(tx, &reschedule).await?;
      if updated.rows_affected() != 1 {
        return Err(RepositoryError::Conflict("database reminder schedule revision"));
      }
    }
    for (row_id, field_id) in targets {
      // `fired` means enqueued, not necessarily persisted by the notification
      // worker. Invalidate that immutable generation without resurrecting it.
      Self::invalidate_fired_cell_reminders(tx, *row_id, *field_id).await?;
    }
    Ok(())
  }
}

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn cancel_database_task_reminders(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
  ) -> RepoResult<sqlx::postgres::PgQueryResult> {
    Ok(
      sqlx::query(
        "UPDATE database_row_reminders SET status='cancelled', schedule_revision=schedule_revision+1,
         claim_token=NULL, claim_expires_at=NULL, cancelled_at=now(), updated_at=now()
       WHERE database_id=$1 AND status IN ('scheduled','claimed','fired')
         AND EXISTS (SELECT 1 FROM workspace_database_rows target
           JOIN database_profiles profile ON profile.database_id=target.database_id AND profile.profile_kind='project'
           WHERE target.id=database_row_reminders.row_id AND target.database_id=$1 AND target.row_kind='task')",
      )
      .bind(database_id)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?,
    )
  }

  pub(in crate::workspace_database) async fn cancel_field_reminders(
    tx: &mut Transaction<'_, Postgres>,
    field_id: DatabaseFieldId,
  ) -> RepoResult<sqlx::postgres::PgQueryResult> {
    Ok(sqlx::query(
        r#"
          UPDATE database_row_reminders
          SET status = 'cancelled', schedule_revision = schedule_revision + 1,
              claim_token = NULL, claim_expires_at = NULL,
              cancelled_at = now(), updated_at = now()
          WHERE field_id = $1 AND (status IN ('scheduled', 'claimed') OR
            (status='fired' AND EXISTS (SELECT 1 FROM workspace_database_rows target
              JOIN database_profiles profile ON profile.database_id=target.database_id AND profile.profile_kind='project'
              WHERE target.id=database_row_reminders.row_id AND target.row_kind='task')))
        "#,
      )
      .bind(field_id)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?)
  }

  pub(in crate::workspace_database) async fn cancel_rows_reminders(
    tx: &mut Transaction<'_, Postgres>,
    row_ids: &[DatabaseRowId],
  ) -> RepoResult<sqlx::postgres::PgQueryResult> {
    Ok(
      sqlx::query(
        r#"
        UPDATE database_row_reminders
        SET status = 'cancelled', schedule_revision = schedule_revision + 1,
            claim_token = NULL, claim_expires_at = NULL,
            cancelled_at = now(), updated_at = now()
        WHERE row_id = ANY($1) AND (status IN ('scheduled', 'claimed') OR
          (status='fired' AND EXISTS (SELECT 1 FROM workspace_database_rows target
            JOIN database_profiles profile ON profile.database_id=target.database_id AND profile.profile_kind='project'
            WHERE target.id=database_row_reminders.row_id AND target.row_kind='task')))
      "#,
      )
      .bind(row_ids)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?,
    )
  }

  pub(in crate::workspace_database) async fn cancel_cell_reminders(
    tx: &mut Transaction<'_, Postgres>,
    row_ids: &[DatabaseRowId],
    field_id: DatabaseFieldId,
  ) -> RepoResult<sqlx::postgres::PgQueryResult> {
    Ok(
      sqlx::query(
        r#"
        UPDATE database_row_reminders
        SET status = 'cancelled', schedule_revision = schedule_revision + 1,
            claim_token = NULL, claim_expires_at = NULL,
            cancelled_at = now(), updated_at = now()
        WHERE row_id = ANY($1) AND field_id = $2
          AND status IN ('scheduled', 'claimed')
      "#,
      )
      .bind(row_ids)
      .bind(field_id)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?,
    )
  }

  pub(in crate::workspace_database) async fn lock_cell_reminder_generations(
    tx: &mut Transaction<'_, Postgres>,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
  ) -> RepoResult<Vec<sqlx::postgres::PgRow>> {
    Ok(
      sqlx::query(
        r#"
          SELECT id, schedule_revision
          FROM database_row_reminders
          WHERE row_id = $1 AND field_id = $2 AND status IN ('scheduled', 'claimed')
          ORDER BY id
          FOR UPDATE
        "#,
      )
      .bind(row_id)
      .bind(field_id)
      .fetch_all(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?,
    )
  }

  pub(in crate::workspace_database) async fn reschedule_reminder_generation(
    tx: &mut Transaction<'_, Postgres>,
    reschedule: &DatabaseRowReminderReschedule,
  ) -> RepoResult<sqlx::postgres::PgQueryResult> {
    Ok(
      sqlx::query(
        r#"
          UPDATE database_row_reminders
          SET trigger_at = $3, status = 'scheduled',
              schedule_revision = schedule_revision + 1,
              claim_token = NULL, claim_expires_at = NULL,
              fired_at = NULL, cancelled_at = NULL, updated_at = now()
          WHERE id = $1 AND schedule_revision = $2
            AND status IN ('scheduled', 'claimed')
        "#,
      )
      .bind(reschedule.reminder_id)
      .bind(reschedule.expected_schedule_revision)
      .bind(reschedule.trigger_at)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?,
    )
  }

  pub(in crate::workspace_database) async fn invalidate_fired_cell_reminders(
    tx: &mut Transaction<'_, Postgres>,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
  ) -> RepoResult<sqlx::postgres::PgQueryResult> {
    Ok(
      sqlx::query(
        r#"
          UPDATE database_row_reminders
          SET schedule_revision = schedule_revision + 1, updated_at = now()
          WHERE row_id = $1 AND field_id = $2 AND status = 'fired'
        "#,
      )
      .bind(row_id)
      .bind(field_id)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?,
    )
  }

  pub(in crate::workspace_database) async fn remap_moved_reminders(
    tx: &mut Transaction<'_, Postgres>,
    source_fields: &[DatabaseFieldId],
    target_fields: &[DatabaseFieldId],
    target_database_id: DatabaseId,
    row_ids: &[DatabaseRowId],
  ) -> RepoResult<sqlx::postgres::PgQueryResult> {
    Ok(sqlx::query("UPDATE database_row_reminders reminder SET database_id=$3,field_id=mapped.target,schedule_revision=CASE WHEN status IN('scheduled','claimed') THEN schedule_revision+1 ELSE schedule_revision END,status=CASE WHEN status='claimed' THEN 'scheduled' ELSE status END,claim_token=NULL,claim_expires_at=NULL,updated_at=now() FROM unnest($1::uuid[],$2::uuid[]) mapped(source,target) WHERE reminder.row_id=ANY($4) AND reminder.field_id=mapped.source")
      .bind(source_fields).bind(target_fields).bind(target_database_id).bind(row_ids).execute(&mut **tx).await.map_err(Self::map_sqlx_error)?)
  }

  pub(in crate::workspace_database) async fn cancel_moved_closed_task_reminders(
    tx: &mut Transaction<'_, Postgres>,
    row_id: DatabaseRowId,
  ) -> RepoResult<sqlx::postgres::PgQueryResult> {
    Ok(sqlx::query("UPDATE database_row_reminders SET status='cancelled',cancelled_at=now(),updated_at=now() WHERE row_id=$1 AND status='scheduled'").bind(row_id).execute(&mut **tx).await.map_err(Self::map_sqlx_error)?)
  }

  pub(in crate::workspace_database) async fn cancel_closed_task_reminders(
    tx: &mut Transaction<'_, Postgres>,
    row_id: DatabaseRowId,
  ) -> RepoResult<sqlx::postgres::PgQueryResult> {
    Ok(
      sqlx::query(
        "UPDATE database_row_reminders SET status='cancelled', schedule_revision=schedule_revision+1,
           claim_token=NULL, claim_expires_at=NULL, cancelled_at=now(), updated_at=now()
         WHERE row_id=$1 AND status IN ('scheduled','claimed','fired')",
      )
      .bind(row_id)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?,
    )
  }
}
