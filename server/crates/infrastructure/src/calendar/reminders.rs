// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native reminder configuration is separate from per-original-slot delivery.
//! Callers retain the event transaction; no queue call belongs in these writes.
use super::*;

pub(super) async fn definitions_in(conn: &mut sqlx::PgConnection, event: Uuid) -> RepoResult<Vec<CalendarReminder>> {
  let rows=sqlx::query("SELECT d.*,r.delivered_at FROM calendar_reminder_definitions d LEFT JOIN calendar_reminders r ON r.id=d.id WHERE d.event_id=$1 ORDER BY d.scheduled_for,d.id")
    .bind(event).fetch_all(conn).await.map_err(SqlxCalendarRepository::map_db_err)?;
  Ok(
    rows
      .into_iter()
      .map(|row| CalendarReminder {
        id: row.get("id"),
        event_id: row.get("event_id"),
        channel: row.get("channel"),
        minutes_before: row.get("minutes_before"),
        scheduled_for: row.get("scheduled_for"),
        delivered_at: row.get("delivered_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
      })
      .collect(),
  )
}

/// An unchanged channel/offset retains the original native ID even when an
/// authoring/import request allocated a fresh draft ID. Completed recipient
/// receipts must not disappear merely because the settings were re-saved.
#[tracing::instrument(skip_all,fields(event_id=%event.id))]
pub(super) async fn replace_in(
  tx: &mut sqlx::Transaction<'_, Postgres>,
  event: &CalendarEvent,
  requested: &[CalendarReminder],
) -> RepoResult<Vec<CalendarReminder>> {
  if requested.len() > myoxus_domain::scheduling::CalculationBudget::default().results {
    return Err(RepositoryError::Validation(
      "Calendar reminder definition budget exceeded".into(),
    ));
  }
  let existing = definitions_in(&mut **tx, event.id).await?;
  let mut retained = std::collections::BTreeSet::new();
  let first = if event.recurrence_parent_id.is_some() {
    myoxus_application::calendar::projection::original_key(
      event.payload["recurrenceId"]
        .as_str()
        .ok_or_else(|| RepositoryError::Validation("Calendar exception original key missing".into()))?,
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?
  } else {
    event.starts_at
  };
  for reminder in requested {
    let id = existing
      .iter()
      .find(|old| old.id == reminder.id && !retained.contains(&old.id))
      .or_else(|| {
        existing.iter().find(|old| {
          old.channel == reminder.channel
            && old.minutes_before == reminder.minutes_before
            && !retained.contains(&old.id)
        })
      })
      .map_or(reminder.id, |old| old.id);
    if !retained.insert(id) {
      return Err(RepositoryError::Validation(
        "duplicate Calendar reminder definition".into(),
      ));
    }
    let inserted=sqlx::query("INSERT INTO calendar_reminder_definitions(id,event_id,channel,minutes_before,first_instance_start,scheduled_for,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET channel=EXCLUDED.channel,minutes_before=EXCLUDED.minutes_before,scheduled_for=EXCLUDED.scheduled_for,updated_at=EXCLUDED.updated_at WHERE calendar_reminder_definitions.event_id=EXCLUDED.event_id")
      .bind(id).bind(event.id).bind(&reminder.channel).bind(reminder.minutes_before).bind(first).bind(reminder.scheduled_for).bind(reminder.created_at).bind(reminder.updated_at)
      .execute(&mut **tx).await.map_err(SqlxCalendarRepository::map_db_err)?;
    if inserted.rows_affected() != 1 {
      return Err(RepositoryError::Conflict("Calendar reminder definition owner mismatch"));
    }
    // The first delivery keeps the deployed ID. New recurring deliveries use
    // stable children; re-saving configuration never resets this receipt.
    sqlx::query("INSERT INTO calendar_reminders(id,event_id,channel,minutes_before,scheduled_for,delivered_at,created_at,updated_at,definition_id,instance_start,occurrence_start,occurrence_end,occurrence_all_day) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$1,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING")
      .bind(id).bind(event.id).bind(&reminder.channel).bind(reminder.minutes_before).bind(reminder.scheduled_for).bind(reminder.delivered_at).bind(reminder.created_at).bind(reminder.updated_at).bind(first).bind(event.starts_at).bind(event.ends_at).bind(event.all_day)
      .execute(&mut **tx).await.map_err(SqlxCalendarRepository::map_db_err)?;
    let owner: Uuid = sqlx::query_scalar("SELECT definition_id FROM calendar_reminders WHERE id=$1")
      .bind(id)
      .fetch_one(&mut **tx)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
    if owner != id {
      return Err(RepositoryError::Conflict("Calendar reminder delivery owner mismatch"));
    }
  }
  sqlx::query("DELETE FROM calendar_reminder_definitions WHERE event_id=$1 AND NOT(id=ANY($2))")
    .bind(event.id)
    .bind(retained.into_iter().collect::<Vec<_>>())
    .execute(&mut **tx)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?;
  definitions_in(&mut **tx, event.id).await
}
