// SPDX-License-Identifier: AGPL-3.0-or-later
//! Calendar definition writes and bounded shared delivery admission. Native
//! reminder rows/guards own presentation, recipients and completion receipts.
use super::*;
use myoxus_domain::{
  entities::{CalendarEvent, CalendarEventInstance},
  scheduling::calendar::CalendarTiming,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

struct Source {
  event: CalendarEvent,
  timing: Option<CalendarTiming>,
  parent_timing: Option<CalendarTiming>,
  parent_cancelled: bool,
  exceptions: Vec<CalendarEventInstance>,
  child_ids: BTreeMap<DateTime<Utc>, Uuid>,
  fingerprint: String,
}

async fn source_in(conn: &mut PgConnection, event: Uuid) -> RepoResult<Option<Source>> {
  let root: Option<Uuid> =
    sqlx::query_scalar("SELECT COALESCE(recurrence_parent_id,id) FROM calendar_events WHERE id=$1")
      .bind(event)
      .fetch_optional(&mut *conn)
      .await
      .map_err(storage)?;
  let Some(root) = root else { return Ok(None) };
  let root_row = sqlx::query("SELECT payload FROM calendar_events WHERE id=$1 FOR UPDATE")
    .bind(root)
    .fetch_one(&mut *conn)
    .await
    .map_err(storage)?;
  let parent_cancelled = root != event
    && root_row.get::<serde_json::Value, _>("payload")["status"]
      .as_str()
      .is_some_and(|status| status.eq_ignore_ascii_case("CANCELLED"));
  let row = sqlx::query("SELECT *,origin::text AS origin FROM calendar_events WHERE id=$1 FOR UPDATE")
    .bind(event)
    .fetch_optional(&mut *conn)
    .await
    .map_err(storage)?;
  let Some(row) = row else { return Ok(None) };
  let event = crate::calendar::SqlxCalendarRepository::map_event_base(row);
  if event.recurrence_parent_id.unwrap_or(event.id) != root {
    return Err(blocked("calendarReminderSourceChanged"));
  }
  let timing = super::calendar::read_in(conn, event.id).await?;
  let parent_timing = if root != event.id {
    super::calendar::read_in(conn, root).await?
  } else {
    None
  };
  let rows=sqlx::query("SELECT * FROM calendar_event_instances WHERE event_id=$1 AND (is_override OR is_cancelled) ORDER BY instance_start LIMIT 10001")
    .bind(event.id).fetch_all(&mut *conn).await.map_err(storage)?;
  if rows.len() > CalculationBudget::default().results {
    return Err(blocked("calendarReminderExceptionBudget"));
  }
  let mut exceptions = rows
    .into_iter()
    .map(crate::calendar::SqlxCalendarRepository::map_instance)
    .map(|instance| (instance.instance_start, instance))
    .collect::<BTreeMap<_, _>>();
  let rows = sqlx::query(
    "SELECT *,origin::text AS origin FROM calendar_events WHERE recurrence_parent_id=$1 ORDER BY id LIMIT 10001",
  )
  .bind(event.id)
  .fetch_all(&mut *conn)
  .await
  .map_err(storage)?;
  if rows.len() > CalculationBudget::default().results {
    return Err(blocked("calendarReminderExceptionBudget"));
  }
  let mut child_ids = BTreeMap::new();
  for row in rows {
    let child = crate::calendar::SqlxCalendarRepository::map_event_base(row);
    let key = myoxus_application::calendar::projection::original_key(
      child.payload["recurrenceId"]
        .as_str()
        .ok_or_else(|| blocked("calendarReminderOriginalKeyUnavailable"))?,
    )
    .map_err(calculation_error)?;
    if child_ids.insert(key, child.id).is_some() {
      return Err(blocked("calendarReminderOriginalKeyConflict"));
    }
    let mut payload = child.payload.clone();
    payload["starts_at"] = serde_json::json!(child.starts_at);
    payload["ends_at"] = serde_json::json!(child.ends_at);
    if let Some(title) = &child.title {
      payload["title"] = serde_json::json!(title)
    }
    // Native This edits snapshot their own effective reminder set (including
    // an explicit empty set). Their one-shot definitions own delivery; inheriting
    // the master's definition again would produce a duplicate reminder.
    let owns_reminders = child.origin == myoxus_domain::entities::CalendarEventOrigin::Native;
    exceptions.insert(
      key,
      CalendarEventInstance {
        id: child.id,
        event_id: event.id,
        instance_start: key,
        instance_end: child.ends_at,
        is_override: true,
        is_cancelled: owns_reminders
          || child.payload["status"]
            .as_str()
            .is_some_and(|status| status.eq_ignore_ascii_case("CANCELLED")),
        override_payload: Some(payload),
        created_at: child.updated_at,
      },
    );
  }
  if exceptions.len() > CalculationBudget::default().results {
    return Err(blocked("calendarReminderExceptionBudget"));
  }
  let exceptions = exceptions.into_values().collect::<Vec<_>>();
  // No viewed cache or volatile creation timestamp may retime a definition.
  let signature = serde_json::json!({"starts":event.starts_at,"ends":event.ends_at,"allDay":event.all_day,"payload":event.payload,
    "timing":timing.as_ref().map(|timing|serde_json::json!({"id":timing.id,"revision":timing.revision,"zone":String::from(timing.zone),"lifecycle":timing.lifecycle,"paused":timing.paused_at,"pauses":timing.pauses,"end":timing.ends_before,"rule":timing.rule,"blocked":timing.blocked_reason})),
    "parentCancelled":parent_cancelled,"parentTiming":parent_timing.as_ref().map(|timing|serde_json::json!([timing.id,timing.revision,timing.paused_at,timing.ends_before,timing.pauses])),
    "exceptions":exceptions.iter().map(|instance|serde_json::json!([instance.instance_start,instance.instance_end,instance.is_cancelled,instance.override_payload,child_ids.get(&instance.instance_start)])).collect::<Vec<_>>()});
  let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&signature).map_err(storage)?));
  Ok(Some(Source {
    event,
    timing,
    parent_timing,
    parent_cancelled,
    exceptions,
    child_ids,
    fingerprint,
  }))
}

struct Candidate {
  key: DateTime<Utc>,
  starts: DateTime<Utc>,
  ends: DateTime<Utc>,
  all_day: bool,
  event: Uuid,
  title: Option<String>,
  scheduled: Option<DateTime<Utc>>,
}
impl Candidate {
  fn delivery_at(&self, minutes: i32) -> RepoResult<DateTime<Utc>> {
    self
      .scheduled
      .or_else(|| self.starts.checked_sub_signed(Duration::minutes(i64::from(minutes))))
      .ok_or_else(|| blocked("calendarReminderDateOutOfRange"))
  }
}

fn definition_fingerprint(source: &Source, definition: &sqlx::postgres::PgRow) -> RepoResult<String> {
  let value = serde_json::json!([
    source.fingerprint,
    definition.get::<String, _>("channel"),
    definition.get::<i32, _>("minutes_before"),
    definition.get::<DateTime<Utc>, _>("scheduled_for")
  ]);
  Ok(format!(
    "{:x}",
    Sha256::digest(serde_json::to_vec(&value).map_err(storage)?)
  ))
}

fn suppresses_accepted(source: &Source, key: DateTime<Utc>) -> RepoResult<bool> {
  if source.parent_cancelled
    || source.event.payload["status"]
      .as_str()
      .is_some_and(|status| status.eq_ignore_ascii_case("CANCELLED"))
  {
    return Ok(true);
  }
  if source
    .parent_timing
    .as_ref()
    .or(source.timing.as_ref())
    .is_some_and(|timing| timing.suppresses(key))
  {
    return Ok(true);
  }
  if let Some(instance) = source.exceptions.iter().find(|instance| instance.instance_start == key) {
    return Ok(instance.is_cancelled);
  }
  let zone = source
    .timing
    .as_ref()
    .map_or(AdmissionZone::try_from("UTC".to_owned()).map_err(storage)?, |timing| {
      timing.zone
    });
  myoxus_application::calendar::projection::original_key_is_excluded(&source.event, zone, key)
    .map_err(calculation_error)
}

async fn candidate_in(
  conn: &mut PgConnection,
  source: &Source,
  definition: Uuid,
  generation: i64,
  minutes: i32,
) -> RepoResult<Option<Candidate>> {
  let keys:Vec<DateTime<Utc>>=sqlx::query_scalar("SELECT instance_start FROM calendar_reminders WHERE definition_id=$1 AND delivered_at IS NOT NULL UNION SELECT nominal_due_at FROM scheduling_occurrences WHERE schedule_id=$1 AND generation=$2 ORDER BY 1 LIMIT 100001")
    .bind(definition).bind(generation).fetch_all(&mut *conn).await.map_err(storage)?;
  if keys.len() > CalculationBudget::default().scans {
    return Err(blocked("calendarReminderReceiptBudget"));
  }
  let mut consumed = keys.into_iter().collect::<BTreeSet<_>>();
  let event = &source.event;
  if source.parent_cancelled
    || event.payload["status"]
      .as_str()
      .is_some_and(|status| status.eq_ignore_ascii_case("CANCELLED"))
  {
    return Ok(None);
  }
  if let Some(parent) = &source.parent_timing {
    let key = myoxus_application::calendar::projection::original_key(
      event.payload["recurrenceId"]
        .as_str()
        .ok_or_else(|| blocked("calendarReminderOriginalKeyUnavailable"))?,
    )
    .map_err(calculation_error)?;
    if parent.suppresses(key) {
      return Ok(None);
    }
  }
  // A transferred pending first delivery retains its accepted actual time,
  // even if the old native source had moved without rewriting that receipt.
  let legacy=sqlx::query("SELECT instance_start,occurrence_start,occurrence_end,occurrence_all_day,event_id,override_title,scheduled_for FROM calendar_reminders r WHERE definition_id=$1 AND imported_delivery AND scheduling_generation=$2 AND delivered_at IS NULL AND NOT suppressed AND NOT EXISTS(SELECT 1 FROM scheduling_occurrences o WHERE o.schedule_id=$1 AND o.generation=$2 AND o.nominal_due_at=r.instance_start) ORDER BY instance_start LIMIT 2")
    .bind(definition).bind(generation).fetch_all(&mut *conn).await.map_err(storage)?;
  if legacy.len() > 1 {
    return Err(blocked("calendarReminderLegacyReceiptConflict"));
  }
  let legacy = legacy.into_iter().next().map(|row| Candidate {
    key: row.get("instance_start"),
    starts: row.get("occurrence_start"),
    ends: row.get("occurrence_end"),
    all_day: row.get("occurrence_all_day"),
    event: row.get("event_id"),
    title: row.get("override_title"),
    scheduled: Some(row.get("scheduled_for")),
  });
  let legacy = match legacy {
    Some(legacy) if !suppresses_accepted(source, legacy.key)? => Some(legacy),
    _ => None,
  };
  if let Some(legacy) = &legacy {
    consumed.insert(legacy.key);
  }
  let generated = if let Some(timing) = &source.timing {
    // Pause excludes future original keys, not already due historical delivery.
    // This disposable upper bound does not rewrite the canonical rule/pause.
    let mut delivery_timing = timing.clone();
    if let Some(start) = delivery_timing.paused_at {
      let bound = delivery_timing.pause_key_bound(start);
      delivery_timing.ends_before = Some(delivery_timing.ends_before.map_or(bound, |end| end.min(bound)));
      delivery_timing.paused_at = None;
    }
    match myoxus_application::calendar::projection::next_reminder_instance(
      event,
      &delivery_timing,
      &source.exceptions,
      &consumed,
    ) {
      Ok(Some(instance)) => {
        let shown = myoxus_application::calendar::projection::occurrence_event(event, &instance);
        Some(Candidate {
          key: instance.instance_start,
          starts: shown.starts_at,
          ends: shown.ends_at,
          all_day: shown.all_day,
          event: source
            .child_ids
            .get(&instance.instance_start)
            .copied()
            .unwrap_or(event.id),
          title: if instance.is_override { shown.title } else { None },
          scheduled: None,
        })
      }
      Ok(None) => None,
      Err(_) if legacy.is_some() => None,
      Err(error) => return Err(calculation_error(error)),
    }
  } else {
    let key = if event.recurrence_parent_id.is_some() {
      myoxus_application::calendar::projection::original_key(
        event.payload["recurrenceId"]
          .as_str()
          .ok_or_else(|| blocked("calendarReminderOriginalKeyUnavailable"))?,
      )
      .map_err(calculation_error)?
    } else {
      event.starts_at
    };
    (!consumed.contains(&key)).then_some(Candidate {
      key,
      starts: event.starts_at,
      ends: event.ends_at,
      all_day: event.all_day,
      event: event.id,
      title: None,
      scheduled: None,
    })
  };
  Ok(match (legacy, generated) {
    (Some(legacy), Some(next)) => Some(
      if (legacy.delivery_at(minutes)?, legacy.key) <= (next.delivery_at(minutes)?, next.key) {
        legacy
      } else {
        next
      },
    ),
    (legacy, next) => legacy.or(next),
  })
}

/// Native writers hold their event lock. Refresh source ownership and the next
/// actual delivery in that same transaction, without contacting Redis.
#[tracing::instrument(skip_all,fields(event_id=%event))]
pub(crate) async fn refresh_event_in(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, event: Uuid) -> RepoResult<()> {
  let root: Option<Uuid> =
    sqlx::query_scalar("SELECT COALESCE(recurrence_parent_id,id) FROM calendar_events WHERE id=$1")
      .bind(event)
      .fetch_optional(&mut **tx)
      .await
      .map_err(storage)?;
  let Some(root) = root else { return Ok(()) };
  // A detached event can also own explicit one-shot reminder definitions.
  let ids:Vec<Uuid>=sqlx::query_scalar("SELECT e.id FROM calendar_events e WHERE (e.id=$1 OR e.id=$2 OR e.recurrence_parent_id=$1) AND EXISTS(SELECT 1 FROM calendar_reminder_definitions d WHERE d.event_id=e.id) ORDER BY e.id LIMIT 10001")
    .bind(root).bind(event).fetch_all(&mut **tx).await.map_err(storage)?;
  if ids.len() > CalculationBudget::default().results {
    return Err(blocked("calendarReminderDefinitionBudget"));
  }
  for id in ids {
    let Some(source) = source_in(&mut **tx, id).await? else {
      continue;
    };
    let definitions =
      sqlx::query("SELECT * FROM calendar_reminder_definitions WHERE event_id=$1 ORDER BY id LIMIT 10001 FOR UPDATE")
        .bind(id)
        .fetch_all(&mut **tx)
        .await
        .map_err(storage)?;
    if definitions.len() > CalculationBudget::default().results {
      return Err(blocked("calendarReminderDefinitionBudget"));
    }
    for definition in definitions {
      let definition_id: Uuid = definition.get("id");
      let fingerprint = definition_fingerprint(&source, &definition)?;
      let target = ScheduleTarget::CalendarReminder {
        definition_id,
        event_id: id,
        source_fingerprint: Some(fingerprint.clone()),
      };
      let old = sqlx::query("SELECT target_json,generation FROM scheduling_schedules WHERE id=$1 FOR UPDATE")
        .bind(definition_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(storage)?;
      let changed = old.as_ref().is_some_and(|old| {
        old.get::<serde_json::Value, _>("target_json")["source_fingerprint"]
          .as_str()
          .is_some_and(|previous| previous != fingerprint)
      });
      if let Some(old) = &old {
        let previous: ScheduleTarget = serde_json::from_value(old.get("target_json")).map_err(storage)?;
        if !matches!(previous,ScheduleTarget::CalendarReminder{definition_id:owner,event_id:owner_event,..} if owner==definition_id&&owner_event==id)
        {
          return Err(blocked("calendarReminderScheduleOwnerMismatch"));
        }
        if old.get::<serde_json::Value, _>("target_json")["source_fingerprint"].is_null()
          && source.event.recurrence_parent_id.is_some()
        {
          let original = myoxus_application::calendar::projection::original_key(
            source.event.payload["recurrenceId"]
              .as_str()
              .ok_or_else(|| blocked("calendarReminderOriginalKeyUnavailable"))?,
          )
          .map_err(calculation_error)?;
          sqlx::query("UPDATE calendar_reminder_definitions SET first_instance_start=$2 WHERE id=$1")
            .bind(definition_id)
            .bind(original)
            .execute(&mut **tx)
            .await
            .map_err(storage)?;
          sqlx::query(
            "UPDATE calendar_reminders SET instance_start=$2 WHERE id=$1 AND definition_id=$1 AND imported_delivery",
          )
          .bind(definition_id)
          .bind(original)
          .execute(&mut **tx)
          .await
          .map_err(storage)?;
        }
      }
      let generation = old
        .as_ref()
        .map_or(1, |old| old.get::<i64, _>("generation") + i64::from(changed));
      let actor: Option<Uuid> = sqlx::query_scalar("SELECT user_id FROM calendar_accounts WHERE id=$1")
        .bind(source.event.account_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(storage)?;
      sqlx::query("INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,generation) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,actor_id=EXCLUDED.actor_id,admission_zone=EXCLUDED.admission_zone,target_json=EXCLUDED.target_json,generation=EXCLUDED.generation,revision=scheduling_schedules.revision+CASE WHEN $7 THEN 1 ELSE 0 END,updated_at=clock_timestamp()")
        .bind(definition_id).bind(source.event.workspace_id).bind(actor).bind(source.timing.as_ref().map_or("UTC".into(),|timing|String::from(timing.zone))).bind(serde_json::to_value(target).map_err(storage)?).bind(generation).bind(changed).execute(&mut **tx).await.map_err(storage)?;
      if changed {
        sqlx::query("UPDATE calendar_reminders SET suppressed=true WHERE definition_id=$1 AND delivered_at IS NULL")
          .bind(definition_id)
          .execute(&mut **tx)
          .await
          .map_err(storage)?;
      }
      let legacy_keys:Vec<DateTime<Utc>>=sqlx::query_scalar("SELECT instance_start FROM calendar_reminders WHERE definition_id=$1 AND imported_delivery AND delivered_at IS NULL AND NOT suppressed LIMIT 2")
        .bind(definition_id).fetch_all(&mut **tx).await.map_err(storage)?;
      for key in legacy_keys {
        // Malformed current cancellation source also fails closed. Its typed
        // calculation reason remains visible on the shared planning row.
        if !matches!(suppresses_accepted(&source, key), Ok(false)) {
          sqlx::query("UPDATE calendar_reminders SET suppressed=true WHERE definition_id=$1 AND instance_start=$2 AND delivered_at IS NULL")
            .bind(definition_id).bind(key).execute(&mut **tx).await.map_err(storage)?;
        }
      }
      update_cursor_in(
        &mut **tx,
        &source,
        definition_id,
        generation,
        definition.get("minutes_before"),
      )
      .await?;
    }
  }
  Ok(())
}

async fn update_cursor_in(
  conn: &mut PgConnection,
  source: &Source,
  id: Uuid,
  generation: i64,
  minutes: i32,
) -> RepoResult<()> {
  // Unavailable rules remain visibly blocked, without turning an ordinary
  // metadata/settings write into an invented supported recurrence.
  let (candidate, reason) = match candidate_in(conn, source, id, generation, minutes).await {
    Ok(candidate) => (candidate, None),
    Err(RepositoryError::Validation(reason)) => (None, Some(reason)),
    Err(error) => return Err(error),
  };
  let key = candidate
    .as_ref()
    .map(|candidate| candidate.key)
    .or_else(|| reason.as_ref().map(|_| source.event.starts_at));
  let admission = candidate
    .as_ref()
    .map(|candidate| candidate.delivery_at(minutes))
    .transpose()?;
  sqlx::query(
    "UPDATE scheduling_schedules SET next_nominal=$2,next_due_at=$3,next_admission_at=CASE WHEN $5::text IS NOT NULL THEN clock_timestamp()+interval '30 seconds' ELSE $4 END,blocked_reason=$5 WHERE id=$1",
  )
  .bind(id)
  .bind(
    key
      .map(|key| serde_json::to_value(ScheduleValue::LocalDateTime(key.naive_utc())))
      .transpose()
      .map_err(storage)?,
  )
  .bind(candidate.as_ref().map(|candidate|candidate.starts).or_else(||reason.as_ref().map(|_|source.event.starts_at)))
  .bind(admission)
  .bind(reason)
  .execute(conn)
  .await
  .map_err(storage)?;
  Ok(())
}

impl PgSchedulingRepository {
  #[tracing::instrument(skip_all,fields(schedule_id=%id))]
  pub(super) async fn admit_calendar_reminder(
    &self,
    id: Uuid,
    generation: i64,
    revision: i64,
    now: DateTime<Utc>,
  ) -> RepoResult<Option<usize>> {
    let definition = sqlx::query("SELECT event_id FROM calendar_reminder_definitions WHERE id=$1")
      .bind(id)
      .fetch_optional(&self.pool)
      .await
      .map_err(storage)?;
    let Some(definition) = definition else { return Ok(None) };
    let mut tx = self.pool.begin().await.map_err(storage)?;
    let Some(source) = source_in(&mut tx, definition.get("event_id")).await? else {
      return Ok(None);
    };
    let definition = sqlx::query("SELECT * FROM calendar_reminder_definitions WHERE id=$1 FOR UPDATE")
      .bind(id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(storage)?;
    let Some(definition) = definition else { return Ok(None) };
    let current=sqlx::query("SELECT * FROM scheduling_schedules WHERE id=$1 AND generation=$2 AND revision=$3 AND lifecycle='active' AND next_admission_at<=$4 FOR UPDATE")
      .bind(id).bind(generation).bind(revision).bind(now).fetch_optional(&mut *tx).await.map_err(storage)?;
    let Some(current) = current else { return Ok(None) };
    let minutes: i32 = definition.get("minutes_before");
    let fingerprint = definition_fingerprint(&source, &definition)?;
    let target: ScheduleTarget = serde_json::from_value(current.get("target_json")).map_err(storage)?;
    let ScheduleTarget::CalendarReminder {
      definition_id,
      event_id,
      source_fingerprint,
    } = target
    else {
      return Err(blocked("calendarReminderScheduleOwnerMismatch"));
    };
    if definition_id != id || event_id != source.event.id {
      return Err(blocked("calendarReminderScheduleOwnerMismatch"));
    }
    if source_fingerprint.as_deref() != Some(fingerprint.as_str()) {
      refresh_event_in(&mut tx, source.event.id).await?;
      tx.commit().await.map_err(storage)?;
      return Ok(None);
    }
    let Some(candidate) = candidate_in(&mut tx, &source, id, generation, minutes).await? else {
      update_cursor_in(&mut tx, &source, id, generation, minutes).await?;
      tx.commit().await.map_err(storage)?;
      return Ok(Some(0));
    };
    let scheduled = candidate.delivery_at(minutes)?;
    if scheduled > now {
      update_cursor_in(&mut tx, &source, id, generation, minutes).await?;
      tx.commit().await.map_err(storage)?;
      return Ok(Some(0));
    }
    let first: DateTime<Utc> = definition.get("first_instance_start");
    let delivery = if candidate.key == first {
      id
    } else {
      Uuid::new_v5(&id, candidate.key.to_rfc3339().as_bytes())
    };
    let receipt=sqlx::query("INSERT INTO calendar_reminders(id,event_id,channel,minutes_before,scheduled_for,created_at,updated_at,definition_id,instance_start,occurrence_start,occurrence_end,occurrence_all_day,override_title,scheduling_generation) VALUES($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp(),$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO UPDATE SET event_id=EXCLUDED.event_id,channel=EXCLUDED.channel,minutes_before=EXCLUDED.minutes_before,scheduled_for=EXCLUDED.scheduled_for,updated_at=EXCLUDED.updated_at,occurrence_start=EXCLUDED.occurrence_start,occurrence_end=EXCLUDED.occurrence_end,occurrence_all_day=EXCLUDED.occurrence_all_day,override_title=EXCLUDED.override_title,scheduling_generation=EXCLUDED.scheduling_generation,suppressed=false,imported_delivery=false WHERE calendar_reminders.definition_id=EXCLUDED.definition_id AND calendar_reminders.instance_start=EXCLUDED.instance_start AND calendar_reminders.delivered_at IS NULL")
      .bind(delivery).bind(candidate.event).bind(definition.get::<String,_>("channel")).bind(minutes).bind(scheduled).bind(id).bind(candidate.key).bind(candidate.starts).bind(candidate.ends).bind(candidate.all_day).bind(candidate.title).bind(generation)
      .execute(&mut *tx).await.map_err(storage)?;
    if receipt.rows_affected() == 0 {
      let completed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM calendar_reminders WHERE id=$1 AND definition_id=$2 AND instance_start=$3 AND delivered_at IS NOT NULL)")
        .bind(delivery).bind(id).bind(candidate.key).fetch_one(&mut *tx).await.map_err(storage)?;
      if !completed {
        return Err(blocked("calendarReminderDeliveryOwnerMismatch"));
      }
      update_cursor_in(&mut tx, &source, id, generation, minutes).await?;
      tx.commit().await.map_err(storage)?;
      return Ok(Some(0));
    }
    let nominal = ScheduleValue::LocalDateTime(candidate.key.naive_utc());
    let occurrence = occurrence_id(id, nominal);
    let dispatch = Uuid::new_v5(&occurrence, format!("calendar-reminder:{generation}").as_bytes());
    let inserted=sqlx::query("INSERT INTO scheduling_occurrences(id,schedule_id,nominal_json,nominal_due_at,generation,dispatch_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET generation=EXCLUDED.generation,dispatch_id=EXCLUDED.dispatch_id WHERE scheduling_occurrences.schedule_id=EXCLUDED.schedule_id AND scheduling_occurrences.nominal_json=EXCLUDED.nominal_json AND scheduling_occurrences.generation<EXCLUDED.generation AND scheduling_occurrences.run_id IS NULL")
      .bind(occurrence).bind(id).bind(serde_json::to_value(nominal).map_err(storage)?).bind(candidate.key).bind(generation).bind(dispatch).execute(&mut *tx).await.map_err(storage)?;
    if inserted.rows_affected() != 1 {
      return Err(blocked("calendarReminderOccurrenceConflict"));
    }
    let payload = myoxus_application::calendar::ReminderDispatchPayload {
      reminder_id: delivery,
      admission: Some(myoxus_domain::entities::CalendarReminderAdmission {
        version: 1,
        schedule_id: id,
        generation,
      }),
    };
    sqlx::query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,created_at) VALUES($1,'calendar_reminder',$2,'calendar_reminder_due',$3,clock_timestamp()) ON CONFLICT(id) DO NOTHING")
      .bind(dispatch).bind(delivery.to_string()).bind(serde_json::to_value(payload).map_err(storage)?).execute(&mut *tx).await.map_err(storage)?;
    update_cursor_in(&mut tx, &source, id, generation, minutes).await?;
    tx.commit().await.map_err(storage)?;
    Ok(Some(1))
  }
}

/// The outbox transport checks the native receipt again before enqueue. Worker
/// admission repeats this fence; no network call holds this read transaction.
pub async fn delivery_is_current(
  pool: &PgPool,
  delivery: Uuid,
  fence: &myoxus_domain::entities::CalendarReminderAdmission,
) -> RepoResult<bool> {
  if fence.version != 1 || fence.generation < 1 {
    return Err(blocked("calendarReminderTransportVersion"));
  }
  sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM calendar_reminders r JOIN scheduling_schedules s ON s.id=r.definition_id WHERE r.id=$1 AND r.definition_id=$2 AND r.scheduling_generation=$3 AND s.generation=$3 AND s.lifecycle='active' AND NOT r.suppressed AND r.delivered_at IS NULL)")
    .bind(delivery).bind(fence.schedule_id).bind(fence.generation).fetch_one(pool).await.map_err(storage)
}

/// Startup follows normal migrations and precedes queue workers/admission.
/// Each native root commits independently, so interruption resumes without a
/// second ledger. The session lock serializes replicas; closing it releases on
/// cancellation as well as error. No Redis call occurs in these transactions.
#[tracing::instrument(skip_all)]
pub async fn initialize(pool: &PgPool) -> RepoResult<usize> {
  let mut ownership = pool.acquire().await.map_err(storage)?;
  ownership.close_on_drop();
  sqlx::query("SELECT pg_advisory_lock(hashtextextended('myoxus:calendar-reminder-cutover',0))")
    .execute(&mut *ownership)
    .await
    .map_err(storage)?;
  let result=async{
    let mut after=None::<Uuid>;let mut count=0;
    loop{
      let events:Vec<Uuid>=sqlx::query_scalar("SELECT DISTINCT COALESCE(e.recurrence_parent_id,e.id) AS root FROM calendar_reminder_definitions d JOIN calendar_events e ON e.id=d.event_id JOIN scheduling_schedules s ON s.id=d.id WHERE s.target_json->>'source_fingerprint' IS NULL AND ($1::uuid IS NULL OR COALESCE(e.recurrence_parent_id,e.id)>$1) ORDER BY root LIMIT 100")
        .bind(after).fetch_all(&mut *ownership).await.map_err(storage)?;
      if events.is_empty(){break}
      for event in events{
        let mut tx=pool.begin().await.map_err(storage)?;
        refresh_event_in(&mut tx,event).await?;
        tx.commit().await.map_err(storage)?;
        after=Some(event);count+=1;
      }
    }
    Ok(count)
  }.await;
  let released = sqlx::query("SELECT pg_advisory_unlock(hashtextextended('myoxus:calendar-reminder-cutover',0))")
    .execute(&mut *ownership)
    .await
    .map_err(storage);
  match (result, released) {
    (Ok(count), Ok(_)) => Ok(count),
    (Err(error), _) | (_, Err(error)) => Err(error),
  }
}
