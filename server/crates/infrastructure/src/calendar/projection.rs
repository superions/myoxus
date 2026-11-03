// SPDX-License-Identifier: AGPL-3.0-or-later
//! Window cache writes share the master lock with authored/provider mutations.

use super::*;
use myoxus_application::calendar::projection::{occurrence_event, occurrences, validate_window};
use myoxus_domain::scheduling::CalculationError;

fn calculation(error: CalculationError) -> RepositoryError {
  let prefix = if matches!(
    error,
    CalculationError::ScanBudgetExceeded | CalculationError::ResultBudgetExceeded
  ) {
    "RESULT_TOO_LARGE: "
  } else {
    ""
  };
  RepositoryError::Validation(format!("{prefix}Calendar projection: {error}"))
}

/// Attach a fresh, disposable export/mail snapshot from canonical SQL timing.
/// Import/write paths strip this field rather than accepting it as authority.
pub(super) async fn attach_timing_in(connection: &mut sqlx::PgConnection, event: &mut CalendarEvent) -> RepoResult<()> {
  if let Some(payload) = event.payload.as_object_mut() {
    payload.remove("_myoxusCalendarTiming");
  }
  let Some(timing) =
    crate::scheduling::calendar::read_in(connection, event.recurrence_parent_id.unwrap_or(event.id)).await?
  else {
    return Ok(());
  };
  if timing.blocked_reason.is_some() {
    return Ok(());
  }
  let projection = if event.recurrence_parent_id.is_some() {
    myoxus_domain::scheduling::calendar::CalendarExportProjection {
      rrule: None,
      excluded_slots: vec![],
      suppressed: timing.suppresses(
        myoxus_application::calendar::projection::original_key(
          event.payload["recurrenceId"].as_str().unwrap_or_default(),
        )
        .map_err(calculation)?,
      ),
    }
  } else {
    myoxus_application::calendar::projection::export_projection(event.starts_at, event.all_day, &timing)
      .map_err(calculation)?
  };
  event.payload["originalTimezone"] = serde_json::json!(String::from(timing.zone));
  event.payload["_myoxusCalendarTiming"] =
    serde_json::to_value(projection).map_err(|error| RepositoryError::Storage(error.to_string()))?;
  Ok(())
}

pub(super) async fn child_suppressed_in(
  connection: &mut sqlx::PgConnection,
  event: &CalendarEvent,
) -> RepoResult<bool> {
  let Some(parent) = event.recurrence_parent_id else {
    return Ok(false);
  };
  let Some(timing) = crate::scheduling::calendar::read_in(connection, parent).await? else {
    return Ok(false);
  };
  let key =
    myoxus_application::calendar::projection::original_key(event.payload["recurrenceId"].as_str().unwrap_or_default())
      .map_err(calculation)?;
  Ok(timing.suppresses(key))
}

/// Protected cache overrides are authored source exceptions, not virtual
/// ordinary copies. Export all their original keys, including outside the view.
pub(super) async fn source_overrides_in(
  connection: &mut sqlx::PgConnection,
  master: &CalendarEvent,
) -> RepoResult<Vec<CalendarEvent>> {
  let rows=sqlx::query("SELECT * FROM calendar_event_instances WHERE event_id=$1 AND (is_override OR is_cancelled) ORDER BY instance_start LIMIT 10001")
    .bind(master.id).fetch_all(&mut *connection).await.map_err(SqlxCalendarRepository::map_db_err)?;
  if rows.len() > 10000 {
    return Err(calculation(CalculationError::ResultBudgetExceeded));
  }
  let mut events = Vec::new();
  for row in rows {
    let instance = SqlxCalendarRepository::map_instance(row);
    let mut event = occurrence_event(master, &instance);
    event.id = instance.id;
    event.recurrence_parent_id = Some(master.id);
    event.payload["recurrenceId"] = serde_json::json!(
      instance
        .instance_start
        .format(if event.all_day { "%Y%m%d" } else { "%Y%m%dT%H%M%SZ" })
        .to_string()
    );
    let source = instance
      .override_payload
      .as_ref()
      .and_then(|payload| payload.get("sourceRecurrence"))
      .cloned();
    if let Some(payload) = event.payload.as_object_mut() {
      for key in [
        "rrule",
        "exdate",
        "exdates",
        "sourceRecurrence",
        "_myoxusCalendarTiming",
      ] {
        payload.remove(key);
      }
      if let Some(source) = source {
        payload.insert("sourceRecurrence".into(), source);
      }
    }
    if instance.is_cancelled {
      event.payload["status"] = serde_json::json!("CANCELLED");
    }
    attach_timing_in(connection, &mut event).await?;
    events.push(event);
  }
  Ok(events)
}

/// Reconcile the last actual requested window before committing a mutation.
/// Sparse slots cannot reveal the original view bounds; exception rows and
/// other cached windows stay retained and repair on their next explicit read.
pub(super) async fn reproject_cached_in(tx: &mut sqlx::Transaction<'_, Postgres>, event_id: Uuid) -> RepoResult<()> {
  let Some(event) = mail_intent::load_event(tx, event_id).await? else {
    return Err(RepositoryError::NotFound("calendar_event"));
  };
  let timing = crate::scheduling::calendar::read_in(tx, event_id).await?;
  if timing.is_none() {
    sqlx::query("DELETE FROM calendar_event_instances WHERE event_id=$1 AND NOT is_override AND NOT is_cancelled")
      .bind(event_id)
      .execute(&mut **tx)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
    super::lifecycle::refresh_reminders_in(tx, &event).await?;
    return Ok(());
  }
  if timing.as_ref().is_some_and(|timing| timing.blocked_reason.is_some()) {
    super::lifecycle::refresh_reminders_in(tx, &event).await?;
    return Ok(());
  }
  let (from, to): (Option<DateTime<Utc>>, Option<DateTime<Utc>>) =
    sqlx::query_as("SELECT projection_from,projection_to FROM calendar_events WHERE id=$1")
      .bind(event_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(SqlxCalendarRepository::map_db_err)?;
  let (from, to) = match (from, to) {
    (Some(from), Some(to)) => (from, to),
    _ => {
      let from = chrono::Datelike::with_day(&Utc::now().date_naive(), 1)
        .ok_or_else(|| calculation(CalculationError::DateOutOfRange))?
        .and_time(chrono::NaiveTime::MIN)
        .and_utc();
      let to = from
        .checked_add_months(chrono::Months::new(1))
        .ok_or_else(|| calculation(CalculationError::DateOutOfRange))?;
      (from, to)
    }
  };
  instances_in(tx, &event, from, to).await?;
  super::lifecycle::refresh_reminders_in(tx, &event).await?;
  Ok(())
}

pub(super) async fn instances_in(
  tx: &mut sqlx::Transaction<'_, Postgres>,
  event: &CalendarEvent,
  from: DateTime<Utc>,
  to: DateTime<Utc>,
) -> RepoResult<Vec<CalendarEventInstance>> {
  validate_window(from, to).map_err(calculation)?;
  let timing = crate::scheduling::calendar::read_in(tx, event.id).await?;
  if let Some(timing) = &timing {
    let projected = occurrences(event, &timing, from, to).map_err(calculation)?;
    let keys = projected
      .iter()
      .map(|instance| instance.instance_start)
      .collect::<Vec<_>>();
    // Only the successfully calculated window is reconciled. An unsupported
    // rule/budget failure rolls back without erasing old cache or exceptions.
    sqlx::query("DELETE FROM calendar_event_instances WHERE event_id=$1 AND instance_start<$3 AND (instance_end>$5 OR instance_start>=$2) AND NOT is_override AND NOT is_cancelled AND NOT(instance_start=ANY($4))")
      .bind(event.id).bind(from.checked_sub_signed(event.ends_at-event.starts_at).ok_or_else(||calculation(CalculationError::DateOutOfRange))?).bind(to).bind(&keys).bind(from).execute(&mut **tx).await.map_err(SqlxCalendarRepository::map_db_err)?;
    for instance in projected {
      sqlx::query("INSERT INTO calendar_event_instances(id,event_id,starts_at,ends_at,instance_start,instance_end,is_override,is_cancelled,created_at) VALUES($1,$2,$3,$4,$3,$4,false,false,$5) ON CONFLICT(event_id,instance_start) DO UPDATE SET instance_end=EXCLUDED.instance_end,ends_at=EXCLUDED.ends_at WHERE NOT calendar_event_instances.is_override AND NOT calendar_event_instances.is_cancelled")
        .bind(instance.id).bind(event.id).bind(instance.instance_start).bind(instance.instance_end).bind(instance.created_at)
        .execute(&mut **tx).await.map_err(SqlxCalendarRepository::map_db_err)?;
    }
  }
  let rows=sqlx::query("SELECT * FROM calendar_event_instances WHERE event_id=$1 AND ((instance_start<$3 AND instance_end>$2) OR (is_override AND override_payload->>'starts_at' IS NOT NULL)) ORDER BY instance_start LIMIT 10001")
    .bind(event.id).bind(from).bind(to).fetch_all(&mut **tx).await.map_err(SqlxCalendarRepository::map_db_err)?;
  if rows.len() > 10000 {
    return Err(calculation(CalculationError::ResultBudgetExceeded));
  }
  // This cache write must not change the authored source revision.
  sqlx::query("UPDATE calendar_events SET projection_from=$2,projection_to=$3 WHERE id=$1")
    .bind(event.id)
    .bind(from)
    .bind(to)
    .execute(&mut **tx)
    .await
    .map_err(SqlxCalendarRepository::map_db_err)?;
  Ok(
    rows
      .into_iter()
      .map(SqlxCalendarRepository::map_instance)
      .filter(|instance| {
        if timing
          .as_ref()
          .is_some_and(|timing| timing.suppresses(instance.instance_start))
        {
          return false;
        }
        let projected = occurrence_event(event, instance);
        projected.starts_at < to && projected.ends_at > from
      })
      .collect(),
  )
}

pub(super) async fn workspace_in(
  tx: &mut sqlx::Transaction<'_, Postgres>,
  workspace: Uuid,
  from: DateTime<Utc>,
  to: DateTime<Utc>,
) -> RepoResult<(Vec<CalendarEvent>, Vec<CalendarEventInstance>)> {
  validate_window(from, to).map_err(calculation)?;
  // Native This/split writers lock master before child. UUID-only ordering
  // would invert that order whenever a child's random UUID sorts first.
  let rows=sqlx::query("SELECT *,origin::text AS origin FROM calendar_events WHERE workspace_id=$1 AND (recurrence_schedule_id IS NOT NULL OR (starts_at<$3 AND ends_at>$2) OR EXISTS(SELECT 1 FROM calendar_event_instances i WHERE i.event_id=calendar_events.id AND i.instance_start<$3 AND i.instance_end>$2)) ORDER BY COALESCE(recurrence_parent_id,id),(recurrence_parent_id IS NOT NULL),id LIMIT 501 FOR UPDATE")
    .bind(workspace).bind(from).bind(to).fetch_all(&mut **tx).await.map_err(SqlxCalendarRepository::map_db_err)?;
  if rows.len() > 500 {
    return Err(calculation(CalculationError::ResultBudgetExceeded));
  }
  let mut events = Vec::new();
  let mut instances = Vec::new();
  for row in rows {
    let recurring: Option<Uuid> = row.get("recurrence_schedule_id");
    let event = SqlxCalendarRepository::map_event_base(row);
    if child_suppressed_in(tx, &event).await? {
      continue;
    }
    let projected = instances_in(tx, &event, from, to).await?;
    if recurring.is_some() || !projected.is_empty() {
      for instance in projected.into_iter().filter(|instance| !instance.is_cancelled) {
        let displayed = occurrence_event(&event, &instance);
        if displayed.payload["status"]
          .as_str()
          .is_some_and(|status| status.eq_ignore_ascii_case("cancelled"))
        {
          continue;
        }
        let mut busy = instance;
        busy.instance_start = displayed.starts_at;
        busy.instance_end = displayed.ends_at;
        instances.push(busy);
        events.push(displayed);
      }
    } else if !myoxus_application::calendar::projection::source_excluded(&event).map_err(calculation)?
      && event.starts_at < to
      && event.ends_at > from
      && !event.payload["status"]
        .as_str()
        .is_some_and(|status| status.eq_ignore_ascii_case("cancelled"))
    {
      instances.push(CalendarEventInstance {
        id: Uuid::new_v5(&event.id, event.starts_at.to_rfc3339().as_bytes()),
        event_id: event.id,
        instance_start: event.starts_at,
        instance_end: event.ends_at,
        is_override: event.recurrence_parent_id.is_some(),
        is_cancelled: false,
        override_payload: None,
        created_at: event.updated_at,
      });
      events.push(event);
    }
    if events.len() > 10000 {
      return Err(calculation(CalculationError::ResultBudgetExceeded));
    }
  }
  events.sort_by_key(|event| (event.starts_at, event.id));
  instances.sort_by_key(|instance| (instance.instance_start, instance.id));
  Ok((events, instances))
}
