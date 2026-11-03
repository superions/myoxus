// SPDX-License-Identifier: AGPL-3.0-or-later
//! Intentional Calendar pauses retain source rules, history and child identities.
use super::*;
use myoxus_domain::scheduling::{ScheduleLifecycle, calendar::*};

/// Our temporary UNTIL/DTSTART exclusion echo is not a new base definition or
/// a newly authored EXDATE. Restore the source exclusion properties together.
pub(super) async fn normalize_export_echo_in(
  tx: &mut sqlx::Transaction<'_, Postgres>,
  incoming: &mut CalendarEvent,
) -> RepoResult<()> {
  let Some(old) = mail_intent::load_event(tx, incoming.id).await? else {
    return Ok(());
  };
  let Some(timing) = crate::scheduling::calendar::read_in(tx, incoming.id).await? else {
    return Ok(());
  };
  if timing.paused_at.is_none() || timing.blocked_reason.is_some() {
    return Ok(());
  }
  let projected = myoxus_application::calendar::projection::export_projection(old.starts_at, old.all_day, &timing)
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
  if incoming.payload["rrule"] != old.payload["rrule"]
    && incoming.payload["rrule"].as_str() == projected.rrule.as_deref()
  {
    for key in ["exdate", "exdates", "sourceRecurrence"] {
      if let Some(value) = old.payload.get(key) {
        incoming.payload[key] = value.clone();
      } else if let Some(payload) = incoming.payload.as_object_mut() {
        payload.remove(key);
      }
    }
  }
  Ok(())
}

pub(super) async fn refresh_reminders_in(
  tx: &mut sqlx::Transaction<'_, Postgres>,
  event: &CalendarEvent,
) -> RepoResult<()> {
  crate::scheduling::reminders::refresh_event_in(tx, event.id).await
}

pub(super) async fn control(
  repo: &SqlxCalendarRepository,
  event_id: Uuid,
  actor: Uuid,
  expected: i64,
  change: CalendarTimingChange,
) -> RepoResult<CalendarEvent> {
  let mut tx = repo.pool.begin().await.map_err(SqlxCalendarRepository::map_db_err)?;
  let mut event = mail_intent::load_event(&mut tx, event_id)
    .await?
    .ok_or(RepositoryError::NotFound("calendar_event"))?;
  if event.origin != CalendarEventOrigin::Native || event.recurrence_parent_id.is_some() {
    return Err(RepositoryError::Validation(
      "Calendar lifecycle requires a native master".into(),
    ));
  }
  let before = crate::scheduling::calendar::read_in(&mut tx, event_id)
    .await?
    .ok_or(RepositoryError::NotFound("Calendar timing"))?;
  if before.revision != expected {
    return Err(RepositoryError::Conflict("Calendar timing revision"));
  }
  if before.blocked_reason.is_some() {
    return Err(RepositoryError::Validation(
      "unsupported Calendar timing is read-only".into(),
    ));
  }
  let target = match change {
    CalendarTimingChange::Pause => ScheduleLifecycle::Paused,
    CalendarTimingChange::Resume => ScheduleLifecycle::Active,
    CalendarTimingChange::End => ScheduleLifecycle::Ended,
  };
  if before.lifecycle == target {
    tx.commit().await.map_err(SqlxCalendarRepository::map_db_err)?;
    return Ok(event);
  }
  if before.lifecycle == ScheduleLifecycle::Ended {
    return Err(RepositoryError::Validation(
      "ended Calendar timing cannot resume".into(),
    ));
  }
  let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
    .fetch_one(&mut *tx)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?;
  if let Some(start) = before.paused_at {
    if before.pauses.len() >= 1000 {
      return Err(RepositoryError::Validation(
        "Calendar pause interval budget exceeded".into(),
      ));
    }
    if now > start {
      sqlx::query("INSERT INTO scheduling_pause_intervals(schedule_id,starts_at,ends_at) VALUES($1,$2,$3)")
        .bind(before.id)
        .bind(start)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(SqlxCalendarRepository::map_db_err)?;
    }
  }
  let cutoff = if target == ScheduleLifecycle::Ended {
    let bound = before.pause_key_bound(now);
    Some(before.ends_before.map_or(bound, |cutoff| cutoff.min(bound)))
  } else {
    before.ends_before
  };
  let paused = if target == ScheduleLifecycle::Paused {
    Some(now)
  } else {
    None
  };
  sqlx::query("UPDATE scheduling_schedules SET lifecycle=$2,paused_at=$3,ends_before=$4,actor_id=$5,revision=revision+1,generation=generation+1,updated_at=$6 WHERE id=$1")
    .bind(before.id).bind(match target{ScheduleLifecycle::Active=>"active",ScheduleLifecycle::Paused=>"paused",ScheduleLifecycle::Ended=>"ended"}).bind(paused).bind(cutoff).bind(actor).bind(now).execute(&mut *tx).await.map_err(SqlxCalendarRepository::map_db_err)?;
  event.updated_at = now;
  // End changes the finite native projection, never its valid retained rule.
  if target == ScheduleLifecycle::Ended
    && let Some(CalendarTimingRule::Fixed { rule }) = &before.rule
  {
    event.payload["rrule"] = serde_json::json!(
      myoxus_application::scheduling::rrule::project_calendar_rrule(rule, cutoff)
        .map_err(|error| RepositoryError::Validation(error.to_string()))?
    );
  }
  sqlx::query("UPDATE calendar_events SET payload=$2,updated_at=$3 WHERE id=$1")
    .bind(event_id)
    .bind(&event.payload)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?;
  let after = crate::scheduling::calendar::read_in(&mut tx, event_id)
    .await?
    .ok_or(RepositoryError::NotFound("Calendar timing"))?;
  // Complete export calculation before committing. Exhaustion/budget errors
  // cannot commit a misleading partial EXDATE list or release a paused source.
  myoxus_application::calendar::projection::export_projection(event.starts_at, event.all_day, &after)
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
  let children = sqlx::query_scalar::<_, Uuid>(
    "SELECT id FROM calendar_events WHERE recurrence_parent_id=$1 ORDER BY id LIMIT 10001 FOR UPDATE",
  )
  .bind(event_id)
  .fetch_all(&mut *tx)
  .await
  .map_err(SqlxCalendarRepository::map_db_err)?;
  if children.len() > 10000 {
    return Err(RepositoryError::Validation("Calendar exception budget exceeded".into()));
  }
  for id in children {
    let child = mail_intent::load_event(&mut tx, id)
      .await?
      .ok_or(RepositoryError::NotFound("calendar_event"))?;
    let key = myoxus_application::calendar::projection::original_key(
      child.payload["recurrenceId"].as_str().unwrap_or_default(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    refresh_reminders_in(&mut tx, &child).await?;
    if before.suppresses(key) != after.suppresses(key) {
      mail_intent::enqueue(
        &mut tx,
        &child,
        if after.suppresses(key) {
          "calendar-cancellation"
        } else {
          "calendar-update"
        },
        None,
      )
      .await?;
    }
  }
  let overrides=sqlx::query("SELECT * FROM calendar_event_instances WHERE event_id=$1 AND is_override AND NOT is_cancelled ORDER BY instance_start LIMIT 10001 FOR UPDATE")
    .bind(event_id).fetch_all(&mut *tx).await.map_err(SqlxCalendarRepository::map_db_err)?;
  if overrides.len() > 10000 {
    return Err(RepositoryError::Validation("Calendar exception budget exceeded".into()));
  }
  for row in overrides {
    let instance = SqlxCalendarRepository::map_instance(row);
    let key = instance.instance_start;
    if before.suppresses(key) != after.suppresses(key) {
      let snapshot = myoxus_application::calendar::projection::occurrence_event(&event, &instance);
      mail_intent::enqueue(
        &mut tx,
        &snapshot,
        if after.suppresses(key) {
          "calendar-cancellation"
        } else {
          "calendar-update"
        },
        Some(key),
      )
      .await?;
    }
  }
  refresh_reminders_in(&mut tx, &event).await?;
  projection::reproject_cached_in(&mut tx, event_id).await?;
  mail_intent::enqueue(&mut tx, &event, "calendar-update", None).await?;
  tx.commit().await.map_err(SqlxCalendarRepository::map_db_err)?;
  Ok(event)
}
