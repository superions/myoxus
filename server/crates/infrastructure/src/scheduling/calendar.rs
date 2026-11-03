// SPDX-License-Identifier: AGPL-3.0-or-later
//! Calendar definition writes participate in the native event transaction.

use chrono::{DateTime, Utc};
use myoxus_domain::{
  repositories::{RepoResult, RepositoryError},
  scheduling::{calendar::*, *},
};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use super::storage;

pub async fn read_in(tx: &mut PgConnection, event_id: Uuid) -> RepoResult<Option<CalendarTiming>> {
  let row = sqlx::query(
    "SELECT s.*,e.payload AS source_payload FROM calendar_events e JOIN scheduling_schedules s ON s.id=e.recurrence_schedule_id WHERE e.id=$1",
  )
  .bind(event_id)
  .fetch_optional(&mut *tx)
  .await
  .map_err(storage)?;
  let pauses = if let Some(row) = &row {
    let rows = sqlx::query(
      "SELECT starts_at,ends_at FROM scheduling_pause_intervals WHERE schedule_id=$1 ORDER BY starts_at LIMIT 1001",
    )
    .bind(row.get::<Uuid, _>("id"))
    .fetch_all(&mut *tx)
    .await
    .map_err(storage)?;
    if rows.len() > 1000 {
      return Err(RepositoryError::Validation(
        "Calendar pause interval budget exceeded".into(),
      ));
    }
    rows
      .into_iter()
      .map(|row| CalendarPauseInterval {
        starts_at: row.get("starts_at"),
        ends_at: row.get("ends_at"),
      })
      .collect()
  } else {
    vec![]
  };
  row
    .map(|row| {
      let rule = row
        .try_get::<Option<serde_json::Value>, _>("rule_json")
        .map_err(storage)?
        .map(serde_json::from_value)
        .transpose()
        .map_err(storage)?;
      let mut blocked_reason = row.try_get("blocked_reason").map_err(storage)?;
      if let Some(CalendarTimingRule::ImportedCalendar { rrule, zone, .. }) = &rule {
        if myoxus_application::calendar::projection::validate_imported_source(
          rrule,
          &row.get::<serde_json::Value, _>("source_payload"),
          *zone,
        )
        .is_err()
        {
          blocked_reason = Some("unsupportedCalendarRule".to_owned());
        } else if blocked_reason.as_deref() == Some("unsupportedCalendarRule") {
          blocked_reason = None;
        }
      }
      Ok(CalendarTiming {
        id: row.try_get("id").map_err(storage)?,
        zone: AdmissionZone::try_from(row.try_get::<String, _>("admission_zone").map_err(storage)?).map_err(storage)?,
        revision: row.try_get("revision").map_err(storage)?,
        ends_before: row.try_get("ends_before").map_err(storage)?,
        paused_at: row.try_get("paused_at").map_err(storage)?,
        pauses,
        lifecycle: match row.try_get::<String, _>("lifecycle").map_err(storage)?.as_str() {
          "active" => ScheduleLifecycle::Active,
          "paused" => ScheduleLifecycle::Paused,
          "ended" => ScheduleLifecycle::Ended,
          _ => return Err(RepositoryError::Validation("invalid Calendar lifecycle".into())),
        },
        rule,
        blocked_reason,
      })
    })
    .transpose()
}

async fn save_in(
  tx: &mut PgConnection,
  event_id: Uuid,
  rule: Option<CalendarTimingRule>,
  zone: AdmissionZone,
  actor: Option<Uuid>,
  blocked: Option<&str>,
) -> RepoResult<()> {
  let row = sqlx::query("SELECT recurrence_schedule_id,workspace_id FROM calendar_events WHERE id=$1 FOR UPDATE")
    .bind(event_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(storage)?;
  let existing: Option<Uuid> = row.try_get("recurrence_schedule_id").map_err(storage)?;
  let workspace: Option<Uuid> = row.try_get("workspace_id").map_err(storage)?;
  let id = existing.unwrap_or_else(Uuid::new_v4);
  let value = rule.map(serde_json::to_value).transpose().map_err(storage)?;
  sqlx::query("INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,rule_json,blocked_reason) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,actor_id=EXCLUDED.actor_id,admission_zone=EXCLUDED.admission_zone,rule_json=EXCLUDED.rule_json,blocked_reason=EXCLUDED.blocked_reason,revision=scheduling_schedules.revision+1,generation=scheduling_schedules.generation+1,updated_at=now() WHERE scheduling_schedules.rule_json IS DISTINCT FROM EXCLUDED.rule_json OR scheduling_schedules.admission_zone IS DISTINCT FROM EXCLUDED.admission_zone OR scheduling_schedules.actor_id IS DISTINCT FROM EXCLUDED.actor_id OR scheduling_schedules.workspace_id IS DISTINCT FROM EXCLUDED.workspace_id OR scheduling_schedules.blocked_reason IS DISTINCT FROM EXCLUDED.blocked_reason")
    .bind(id).bind(workspace).bind(actor).bind(String::from(zone))
    .bind(serde_json::json!({"kind":"calendar_master","event_id":event_id})).bind(value).bind(blocked)
    .execute(&mut *tx).await.map_err(storage)?;
  sqlx::query(
    "UPDATE calendar_events SET recurrence_schedule_id=$2 WHERE id=$1 AND recurrence_schedule_id IS DISTINCT FROM $2",
  )
  .bind(event_id)
  .bind(id)
  .execute(tx)
  .await
  .map_err(storage)?;
  Ok(())
}

pub async fn set_native_in(
  tx: &mut PgConnection,
  event_id: Uuid,
  confirmation: Option<&ConfirmedCalendarRecurrence>,
) -> RepoResult<()> {
  if let Some(input) = confirmation {
    let rule = canonical_rule(input.rule.clone());
    rule.validate().map_err(storage)?;
    let exception:bool =
      sqlx::query_scalar("SELECT recurrence_parent_id IS NOT NULL OR NULLIF(payload->>'recurrenceId','') IS NOT NULL FROM calendar_events WHERE id=$1 FOR UPDATE")
        .bind(event_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(storage)?;
    if exception {
      return Err(RepositoryError::Validation(
        "Calendar override cannot own a timing definition".into(),
      ));
    }
    let source = sqlx::query("SELECT starts_at,payload->>'allDay'='true' AS all_day FROM calendar_events WHERE id=$1")
      .bind(event_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(storage)?;
    validate_native_rule(
      &rule,
      source.try_get("starts_at").map_err(storage)?,
      source
        .try_get::<Option<bool>, _>("all_day")
        .map_err(storage)?
        .unwrap_or(false),
    )
    .map_err(storage)?;
    let cutoff = read_in(tx, event_id).await?.and_then(|timing| timing.ends_before);
    let rrule = myoxus_application::scheduling::rrule::project_calendar_rrule(&rule, cutoff).map_err(storage)?;
    save_in(
      tx,
      event_id,
      Some(CalendarTimingRule::Fixed { rule }),
      input.rule.zone,
      Some(input.actor_id),
      None,
    )
    .await?;
    sqlx::query("UPDATE calendar_events SET payload=jsonb_set(jsonb_set(payload,'{rrule}',to_jsonb($2::text)),'{originalTimezone}',to_jsonb($3::text)) WHERE id=$1")
      .bind(event_id).bind(rrule).bind(String::from(input.rule.zone)).execute(tx).await.map_err(storage)?;
  } else {
    let id: Option<Uuid> =
      sqlx::query_scalar("SELECT recurrence_schedule_id FROM calendar_events WHERE id=$1 FOR UPDATE")
        .bind(event_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(storage)?;
    sqlx::query("UPDATE calendar_events SET recurrence_schedule_id=NULL,payload=payload-'rrule' WHERE id=$1")
      .bind(event_id)
      .execute(&mut *tx)
      .await
      .map_err(storage)?;
    if let Some(id) = id {
      sqlx::query("DELETE FROM scheduling_schedules WHERE id=$1")
        .bind(id)
        .execute(tx)
        .await
        .map_err(storage)?;
    }
  }
  Ok(())
}

/// A split/truncate narrows an existing source; later edits cannot extend that
/// head back across its committed tail. New tails inherit the previous bound.
pub async fn narrow_end_in(tx: &mut PgConnection, event_id: Uuid, cutoff: DateTime<Utc>) -> RepoResult<()> {
  sqlx::query("UPDATE scheduling_schedules s SET ends_before=$2,revision=revision+1,generation=generation+1,updated_at=now() FROM calendar_events e WHERE e.id=$1 AND e.recurrence_schedule_id=s.id AND (s.ends_before IS NULL OR s.ends_before>$2)")
    .bind(event_id).bind(cutoff).execute(tx).await.map_err(storage)?;
  Ok(())
}

/// Import only at the event writer, never lazily from a window read. Existing
/// source identifiers, exception payloads and instance rows are not rewritten.
pub async fn bind_imported_in(tx: &mut PgConnection, event_id: Uuid) -> RepoResult<()> {
  let row=sqlx::query("SELECT e.starts_at,e.payload,e.recurrence_parent_id,a.user_id FROM calendar_events e LEFT JOIN calendar_accounts a ON a.id=e.account_id WHERE e.id=$1 FOR UPDATE OF e")
    .bind(event_id).fetch_one(&mut *tx).await.map_err(storage)?;
  let payload: serde_json::Value = row.try_get("payload").map_err(storage)?;
  let parent: Option<Uuid> = row.try_get("recurrence_parent_id").map_err(storage)?;
  if parent.is_some()
    || payload["recurrenceId"].as_str().is_some_and(|v| !v.is_empty())
    || payload["recurringEventId"].as_str().is_some_and(|v| !v.is_empty())
  {
    return Ok(());
  }
  // An authored native projection/own export echo cannot replace its rule.
  if let Some(timing) = read_in(tx, event_id).await? {
    let fixed = matches!(timing.rule, Some(CalendarTimingRule::Fixed { .. }));
    if fixed || timing.paused_at.is_some() || !timing.pauses.is_empty() || timing.lifecycle == ScheduleLifecycle::Ended
    {
      let base = match &timing.rule {
        Some(CalendarTimingRule::Fixed { rule }) => {
          myoxus_application::scheduling::rrule::project_calendar_rrule(rule, timing.ends_before).map_err(storage)?
        }
        Some(CalendarTimingRule::ImportedCalendar { rrule, .. }) => rrule.clone(),
        None => return Err(RepositoryError::Validation("Calendar timing unavailable".into())),
      };
      let projected = myoxus_application::calendar::projection::export_projection(
        row.get("starts_at"),
        payload["allDay"].as_bool().unwrap_or(false),
        &timing,
      )
      .map_err(storage)?;
      let incoming = payload["rrule"].as_str();
      if incoming != Some(base.as_str()) && incoming != projected.rrule.as_deref() {
        return Err(RepositoryError::Validation(
          "managed Calendar recurrence must retain its canonical base".into(),
        ));
      }
      // Accept our current standard export echo, but never bind its temporary
      // UNTIL as the retained base rule. Stale/foreign rule changes fail closed.
      sqlx::query("UPDATE calendar_events SET payload=jsonb_set(payload-'_myoxusCalendarTiming','{rrule}',to_jsonb($2::text)) WHERE id=$1")
        .bind(event_id).bind(base).execute(tx).await.map_err(storage)?;
      return Ok(());
    }
  }
  let zone = AdmissionZone::try_from(
    payload["originalTimezone"]
      .as_str()
      .filter(|s| !s.is_empty())
      .unwrap_or("UTC")
      .to_owned(),
  );
  let invalid_zone = zone.is_err();
  let zone = zone.unwrap_or_else(|_| AdmissionZone::try_from("UTC".to_owned()).expect("UTC is built in"));
  let Some(raw) = payload["rrule"].as_str().filter(|value| !value.is_empty()) else {
    if myoxus_application::calendar::projection::unsupported_unruled_source(&payload, zone) {
      return save_in(
        tx,
        event_id,
        None,
        zone,
        row.try_get("user_id").map_err(storage)?,
        Some("unsupportedCalendarRule"),
      )
      .await;
    }
    return set_native_in(tx, event_id, None).await;
  };
  let invalid_rule = raw.len() > 8192
    || myoxus_application::calendar::projection::validate_imported_source(raw, &payload, zone).is_err();
  let blocked = if invalid_zone {
    Some("invalidCalendarZone")
  } else if invalid_rule {
    Some("unsupportedCalendarRule")
  } else {
    None
  };
  let rule = if raw.len() <= 8192 {
    Some(CalendarTimingRule::ImportedCalendar {
      rrule: raw.to_owned(),
      starts_at: row.try_get::<DateTime<Utc>, _>("starts_at").map_err(storage)?,
      all_day: payload["allDay"].as_bool().unwrap_or(false),
      zone,
    })
  } else {
    None
  };
  save_in(
    tx,
    event_id,
    rule,
    zone,
    row.try_get("user_id").map_err(storage)?,
    blocked,
  )
  .await
}
