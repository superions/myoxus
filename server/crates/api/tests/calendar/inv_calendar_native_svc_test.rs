// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-JCAL-SERVER-02-D: Invariant tests for NativeEventService scope semantics.
//!
//! Invariants tested:
//!   INV-CAL-SCOPE-01   scope=This creates override row + EXDATE on master
//!   INV-CAL-SCOPE-02   scope=All edits master in-place, overrides untouched
//!   INV-CAL-NATIVE-02  scope=This delete adds EXDATE, master survives
//!   (delete scope=All via FK cascade)
//!

use std::sync::Arc;

use chrono::Utc;
use uuid::Uuid;

use myoxus_application::auth::{AuthError, AuthUser, InMemoryAuthStore};
use myoxus_application::calendar::native::{
  DeleteScope, NativeCreateInput, NativeEventService, ReminderInput, UpdateScope,
};
use myoxus_application::workspace::WorkspaceStore;
use myoxus_domain::entities::{MembershipStatus, WorkspaceRole};
use myoxus_domain::repositories::{NativeEventReminderInput, NativeEventUpdate};
use myoxus_infrastructure::calendar::SqlxCalendarRepository;

// ── Shared test helpers ───────────────────────────────────────────────────────

async fn connect_svc() -> Option<(sqlx::PgPool, NativeEventService, Arc<InMemoryAuthStore>, Uuid, Uuid)> {
  let url = std::env::var("TEST_DATABASE_URL").ok()?;
  let pool = sqlx::PgPool::connect(&url)
    .await
    .expect("configured isolated test database must be available");
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrations");

  let user_id = Uuid::new_v4();
  let ws_id = Uuid::new_v4();

  sqlx::query("INSERT INTO users (id, name, email) VALUES ($1, 'svc-test', $2)")
    .bind(user_id)
    .bind(format!("svc-{user_id}@test.local"))
    .execute(&pool)
    .await
    .expect("seed user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'svc-ws')")
    .bind(ws_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("seed workspace");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Collaborator', 'Accepted', NOW())",
  )
  .bind(ws_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("seed membership");

  let auth_store = Arc::new(InMemoryAuthStore::default());
  auth_store.insert_user(AuthUser {
    id: user_id,
    email: format!("svc-{user_id}@test.local"),
    name: Some("svc-test".into()),
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: Some(Utc::now()),
    registered: true,
  });
  auth_store
    .add_or_update_member(
      ws_id,
      user_id,
      WorkspaceRole::Collaborator,
      MembershipStatus::Accepted,
      None,
    )
    .await
    .expect("seed in-memory membership");

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let svc = NativeEventService::new(repo, auth_store.clone());
  Some((pool, svc, auth_store, user_id, ws_id))
}

async fn cleanup(pool: &sqlx::PgPool, ws_id: Uuid, user_id: Uuid) {
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .expect("remove Calendar fixture workspace and timing definitions");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("remove Calendar fixture user");
}

fn base_input(_ws_id: Uuid) -> NativeCreateInput {
  NativeCreateInput {
    imported_recurrence: None,
    recurrence: None,
    title: Some("Test Event".into()),
    description_delta: None,
    starts_at: Utc::now(),
    ends_at: Utc::now() + chrono::Duration::hours(1),
    all_day: false,
    all_members: false,
    tag_id: None,
    source_doc_id: None,
    source_anchor: None,
    reminders: None,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// INV-CAL-SCOPE-01: scope=This creates override row with recurrence_parent_id + EXDATE on master
#[tokio::test]
async fn inv_scope01_this_creates_override_and_exdate() {
  let Some((pool, svc, _auth_store, uid, ws)) = connect_svc().await else {
    return;
  };

  let mut input = base_input(ws);
  input.starts_at = "2031-03-23T08:00:00Z".parse().unwrap();
  input.ends_at = input.starts_at + chrono::Duration::hours(1);
  let rule = myoxus_domain::scheduling::RecurrenceRule {
    selector: myoxus_domain::scheduling::RecurrenceSelector::Weekly {
      weekdays: vec![chrono::Weekday::Sun],
    },
    interval: std::num::NonZeroU32::new(1).unwrap(),
    start: myoxus_domain::scheduling::ScheduleValue::LocalDateTime("2031-03-23T09:00:00".parse().unwrap()),
    end: None,
    zone: myoxus_domain::scheduling::AdmissionZone::try_from("Europe/Berlin".to_owned()).unwrap(),
  };
  input.recurrence = Some(rule.clone());
  let master = svc.create(ws, uid, input).await.expect("create master");
  let repo = myoxus_infrastructure::calendar::SqlxCalendarRepository::new(pool.clone());
  let timing = myoxus_domain::repositories::CalendarRepository::get_calendar_timing(&repo, master.id)
    .await
    .unwrap()
    .unwrap();
  assert_eq!(
    timing.rule,
    Some(myoxus_domain::scheduling::calendar::CalendarTimingRule::Fixed { rule })
  );
  assert_eq!(master.payload["rrule"], "FREQ=WEEKLY;BYDAY=SU;INTERVAL=1");
  let projection_only:bool=sqlx::query_scalar("SELECT next_admission_at IS NULL AND next_due_at IS NULL AND NOT EXISTS(SELECT 1 FROM scheduling_occurrences o WHERE o.schedule_id=s.id) FROM scheduling_schedules s WHERE id=$1")
    .bind(timing.id).fetch_one(&pool).await.unwrap();
  assert!(projection_only, "Calendar definitions do not admit workflow slots");
  let instance_start = master.starts_at;

  let update = NativeEventUpdate {
    title: Some(Some("Override Title".into())),
    ..Default::default()
  };
  let override_event = svc
    .update(master.id, ws, uid, UpdateScope::This { instance_start }, update)
    .await
    .expect("update scope=this");

  assert_eq!(
    override_event.recurrence_parent_id,
    Some(master.id),
    "INV-CAL-SCOPE-01: override must reference master"
  );
  assert_eq!(override_event.title.as_deref(), Some("Override Title"));
  assert!(
    myoxus_domain::repositories::CalendarRepository::get_calendar_timing(&repo, override_event.id)
      .await
      .unwrap()
      .is_none(),
    "an override keeps its original key without another timing owner"
  );

  let exdates: serde_json::Value =
    sqlx::query_scalar("SELECT COALESCE(payload->'exdates', '[]'::jsonb) FROM calendar_events WHERE id = $1")
      .bind(master.id)
      .fetch_one(&pool)
      .await
      .expect("fetch exdates");
  assert!(
    !exdates.as_array().unwrap().is_empty(),
    "INV-CAL-SCOPE-01: master must have EXDATE"
  );

  cleanup(&pool, ws, uid).await;
}

/// Native future edits retain cached originals and out-of-window overrides;
/// truncating at the first original must keep an empty, exportable head.
#[tokio::test]
async fn inv_scope_future_split_retains_originals_and_first_slot_truncates() {
  use myoxus_domain::{
    repositories::CalendarRepository,
    scheduling::{calendar::*, *},
  };
  let Some((pool, svc, auth, uid, ws)) = connect_svc().await else {
    return;
  };
  let recipient = Uuid::new_v4();
  sqlx::query("INSERT INTO users(id,name,email) VALUES($1,'Split recipient',$2)")
    .bind(recipient)
    .bind(format!("split-{recipient}@example.test"))
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'Collaborator','Accepted')",
  )
  .bind(ws)
  .bind(recipient)
  .execute(&pool)
  .await
  .unwrap();
  let mut input = base_input(ws);
  input.all_members = true;
  input.starts_at = "2031-03-23T08:00:00Z".parse().unwrap();
  input.ends_at = input.starts_at + chrono::Duration::hours(1);
  input.recurrence = Some(RecurrenceRule {
    selector: RecurrenceSelector::Weekly {
      weekdays: vec![chrono::Weekday::Sun],
    },
    interval: std::num::NonZeroU32::new(1).unwrap(),
    start: ScheduleValue::LocalDateTime("2031-03-23T09:00:00".parse().unwrap()),
    end: Some(ScheduleValue::LocalDateTime("2036-04-01T09:00:00".parse().unwrap())),
    zone: AdmissionZone::try_from("Europe/Berlin".to_owned()).unwrap(),
  });
  let master = svc.create(ws, uid, input).await.unwrap();
  let repo = SqlxCalendarRepository::new(pool.clone());
  let from = "2034-03-01T00:00:00Z".parse().unwrap();
  let to = "2034-04-01T00:00:00Z".parse().unwrap();
  let cached = repo.list_event_instances(master.id, from, to).await.unwrap();
  assert_eq!(cached.len(), 4);
  let key = "2035-03-25T08:00:00Z".parse().unwrap();
  let exception = svc
    .update(
      master.id,
      ws,
      uid,
      UpdateScope::This { instance_start: key },
      NativeEventUpdate {
        title: Some(Some("Outside requested month".into())),
        ..Default::default()
      },
    )
    .await
    .unwrap();
  let at = cached[2].instance_start;
  auth
    .add_or_update_member(ws, uid, WorkspaceRole::Reader, MembershipStatus::Accepted, None)
    .await
    .unwrap();
  assert!(matches!(
    svc
      .update(
        master.id,
        ws,
        uid,
        UpdateScope::ThisAndFuture { instance_start: at },
        NativeEventUpdate::default()
      )
      .await,
    Err(AuthError::ActionForbidden)
  ));
  auth
    .add_or_update_member(ws, uid, WorkspaceRole::Collaborator, MembershipStatus::Accepted, None)
    .await
    .unwrap();
  let tail = svc
    .update(
      master.id,
      ws,
      uid,
      UpdateScope::ThisAndFuture { instance_start: at },
      NativeEventUpdate {
        title: Some(Some("Split tail".into())),
        ..Default::default()
      },
    )
    .await
    .unwrap();
  let association: Uuid = sqlx::query_scalar("SELECT recurrence_parent_id FROM calendar_events WHERE id=$1")
    .bind(exception.id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(association, tail.id);
  let mail: Vec<serde_json::Value> =
    sqlx::query_scalar("SELECT payload FROM outbox_events WHERE event_type='calendar_mail' AND aggregate_id=$1")
      .bind(exception.id.to_string())
      .fetch_all(&pool)
      .await
      .unwrap();
  let old_cancel = mail
    .iter()
    .find(|intent| {
      intent["template"] == "calendar-cancellation" && intent["event"]["remote_event_id"] == master.id.to_string()
    })
    .expect("old UID cancellation intent");
  let new_invite = mail
    .iter()
    .find(|intent| {
      intent["template"] == "calendar-invitation" && intent["event"]["remote_event_id"] == tail.id.to_string()
    })
    .expect("new UID invitation intent for the retained child");
  assert!(
    new_invite["sequence"].as_i64().unwrap() > old_cancel["sequence"].as_i64().unwrap(),
    "a fresh tail's lower parent sequence must not reset the retained child's sequence"
  );
  assert_eq!(
    new_invite["event"]["payload"]["recurrenceId"],
    exception.payload["recurrenceId"]
  );
  let rows:Vec<(Uuid,Uuid,chrono::DateTime<Utc>)>=sqlx::query_as("SELECT id,event_id,instance_start FROM calendar_event_instances WHERE event_id=ANY($1) AND instance_start>=$2 AND instance_start<$3 ORDER BY instance_start")
    .bind(vec![master.id,tail.id]).bind(from).bind(to).fetch_all(&pool).await.unwrap();
  assert_eq!(
    rows,
    cached
      .iter()
      .map(|slot| (
        slot.id,
        if slot.instance_start < at { master.id } else { tail.id },
        slot.instance_start
      ))
      .collect::<Vec<_>>(),
    "the transaction must move, not recreate, already exposed originals"
  );
  let timing = repo.get_calendar_timing(tail.id).await.unwrap().unwrap();
  let Some(CalendarTimingRule::Fixed { rule }) = timing.rule else {
    panic!("native tail lost its typed rule")
  };
  assert_eq!(
    rule.end,
    Some(ScheduleValue::LocalDateTime("2036-04-01T09:00:00".parse().unwrap()))
  );
  let events = repo.list_workspace_events(ws, from, to).await.unwrap();
  assert_eq!(events.len(), 4);
  svc
    .delete(
      master.id,
      ws,
      uid,
      DeleteScope::ThisAndFuture {
        instance_start: master.starts_at,
      },
    )
    .await
    .unwrap();
  assert!(
    repo.get_calendar_event(master.id).await.unwrap().is_some(),
    "an empty head keeps its original source identity"
  );
  assert!(
    repo
      .list_event_instances(
        master.id,
        master.starts_at,
        master.starts_at + chrono::Duration::days(7)
      )
      .await
      .unwrap()
      .is_empty()
  );
  let final_events = repo.list_workspace_events(ws, from, to).await.unwrap();
  assert_eq!(final_events.len(), 2);
  let head = repo.get_calendar_event(master.id).await.unwrap().unwrap();
  assert!(
    head.payload["rrule"]
      .as_str()
      .unwrap()
      .contains("UNTIL=20310323T075959Z")
  );
  assert!(
    head.payload["exdate"].as_str().unwrap().contains("20310323T080000Z"),
    "standard exports exclude the retained DTSTART of an empty head"
  );
  sqlx::query("DELETE FROM outbox_events WHERE event_type='calendar_mail' AND payload->>'workspaceId'=$1")
    .bind(ws.to_string())
    .execute(&pool)
    .await
    .expect("remove detached split mail fixtures");
  cleanup(&pool, ws, uid).await;
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(recipient)
    .execute(&pool)
    .await
    .expect("remove split recipient");
}

// INV-CAL-SCOPE-02: scope=All edits master in-place
#[tokio::test]
async fn inv_calendar_lifecycle_preserves_base_echoes_and_intentional_pauses() {
  use chrono::{Datelike, Duration, TimeZone};
  use myoxus_application::calendar::native::CalendarTimingControlError;
  use myoxus_domain::{
    repositories::CalendarRepository,
    scheduling::{calendar::*, *},
  };
  let Some((pool, svc, _auth, uid, ws)) = connect_svc().await else {
    return;
  };
  let repo = SqlxCalendarRepository::new(pool.clone());
  let recipient = Uuid::new_v4();
  sqlx::query("INSERT INTO users(id,name,email) VALUES($1,'Lifecycle recipient',$2)")
    .bind(recipient)
    .bind(format!("lifecycle-{recipient}@example.test"))
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'Collaborator','Accepted')",
  )
  .bind(ws)
  .bind(recipient)
  .execute(&pool)
  .await
  .unwrap();
  let zone = chrono_tz::Europe::Berlin;
  let today = Utc::now().with_timezone(&zone).date_naive();
  let civil = |date: chrono::NaiveDate| date.and_hms_opt(9, 0, 0).unwrap();
  let instant = |date: chrono::NaiveDate| {
    zone
      .from_local_datetime(&civil(date))
      .earliest()
      .unwrap()
      .with_timezone(&Utc)
  };
  let input_for = |date: chrono::NaiveDate| {
    let mut input = base_input(ws);
    input.all_members = true;
    input.starts_at = instant(date);
    input.ends_at = input.starts_at + Duration::hours(1);
    input.recurrence = Some(RecurrenceRule {
      selector: RecurrenceSelector::Daily,
      interval: std::num::NonZeroU32::new(1).unwrap(),
      start: ScheduleValue::LocalDateTime(civil(date)),
      end: None,
      zone: AdmissionZone::try_from(zone.name().to_owned()).unwrap(),
    });
    input.reminders = Some(vec![ReminderInput {
      minutes_before: 15,
      channel: "email".into(),
    }]);
    input
  };
  let future = svc.create(ws, uid, input_for(today + Duration::days(1))).await.unwrap();
  let mut initial = repo
    .list_event_instances(future.id, future.starts_at, future.starts_at + Duration::days(3))
    .await
    .unwrap();
  let old = initial[0].id;
  initial[0].id = Uuid::new_v4();
  sqlx::query("UPDATE calendar_event_instances SET id=$2 WHERE id=$1")
    .bind(old)
    .bind(initial[0].id)
    .execute(&pool)
    .await
    .unwrap();
  let revision = repo.get_calendar_timing(future.id).await.unwrap().unwrap().revision;
  svc
    .control_recurrence(future.id, ws, uid, revision, CalendarTimingChange::Pause)
    .await
    .unwrap();
  let paused = repo.get_calendar_timing(future.id).await.unwrap().unwrap();
  assert!(
    repo
      .list_event_instances(future.id, future.starts_at, future.starts_at + Duration::days(3))
      .await
      .unwrap()
      .is_empty()
  );
  let echo = repo.get_calendar_export_event(future.id).await.unwrap().unwrap();
  let ics = myoxus_infrastructure::caldav::calendar_event_to_vcalendar(&echo);
  assert!(ics.contains("DTSTART;TZID=Europe/Berlin:"));
  assert!(ics.contains("UNTIL="));
  assert!(ics.contains(&format!("UID:{}\r\n", future.id)));
  assert!(
    ics.contains(&future.starts_at.format("EXDATE:%Y%m%dT%H%M%SZ").to_string()),
    "a paused source before DTSTART must not export a standalone first occurrence"
  );
  repo
    .save_authored_calendar_event(&echo, &echo.participants, &echo.reminders)
    .await
    .unwrap();
  let reminder = future.reminders[0].id;
  let mut guard = repo.acquire_reminder_delivery_guard(reminder).await.unwrap();
  assert!(
    !guard.begin_dispatch(Uuid::new_v4(), Utc::now(), None).await.unwrap(),
    "an already queued but unstarted reminder is fenced"
  );
  assert!(guard.contexts().await.unwrap().is_empty());
  guard.release().await.unwrap();
  svc
    .control_recurrence(future.id, ws, uid, paused.revision, CalendarTimingChange::Resume)
    .await
    .unwrap();
  assert_eq!(
    repo
      .list_event_instances(future.id, future.starts_at, future.starts_at + Duration::days(3))
      .await
      .unwrap()
      .iter()
      .map(|slot| slot.id)
      .collect::<Vec<_>>(),
    initial.iter().map(|slot| slot.id).collect::<Vec<_>>(),
    "pause/resume retains deployed future instance identities"
  );
  assert!(matches!(
    svc
      .control_recurrence(future.id, ws, uid, paused.revision, CalendarTimingChange::Pause)
      .await,
    Err(CalendarTimingControlError::Conflict)
  ));
  let resumed = repo.get_calendar_export_event(future.id).await.unwrap().unwrap();
  assert_eq!(
    resumed.payload["rrule"], future.payload["rrule"],
    "our temporary exported UNTIL must not replace the base"
  );
  assert!(
    !resumed.payload["exdate"]
      .as_str()
      .unwrap_or_default()
      .contains(&future.starts_at.format("%Y%m%dT%H%M%SZ").to_string()),
    "the temporary DTSTART exclusion echo must not persist after resume"
  );
  let parsed = myoxus_infrastructure::caldav::parse_ical_events(
    &myoxus_infrastructure::caldav::calendar_event_to_vcalendar(&resumed),
  )
  .into_iter()
  .next()
  .expect("standard recurrence must parse after resume");
  assert_eq!(parsed.original_timezone.as_deref(), Some(zone.name()));
  let from = chrono::NaiveDate::from_ymd_opt(today.year() + 1, 3, 1)
    .unwrap()
    .and_hms_opt(0, 0, 0)
    .unwrap()
    .and_utc();
  let to = from + Duration::days(31);
  let exported = myoxus_application::scheduling::rrule::expand_zoned_rrule(
    parsed.rrule.as_deref().unwrap(),
    parsed.starts_at,
    Duration::hours(1),
    from,
    to,
    &[],
    zone,
    CalculationBudget::default(),
  )
  .unwrap();
  assert_eq!(
    exported.iter().map(|slot| slot.0).collect::<Vec<_>>(),
    repo
      .list_event_instances(future.id, from, to)
      .await
      .unwrap()
      .iter()
      .map(|slot| slot.instance_start)
      .collect::<Vec<_>>(),
    "the consuming ICS roundtrip must retain actual civil slots through DST, not only a TZID token"
  );
  // Resume rearms shared admission, not the superseded delivery generation.
  // Clearing only the old row's flag could pass while losing its next wake-up.
  let next: (
    Option<chrono::DateTime<Utc>>,
    Option<chrono::DateTime<Utc>>,
    Option<String>,
  ) = sqlx::query_as("SELECT next_due_at,next_admission_at,blocked_reason FROM scheduling_schedules WHERE id=$1")
    .bind(reminder)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    next,
    (
      Some(future.starts_at),
      Some(future.starts_at - Duration::minutes(15)),
      None
    ),
    "resume must restore the next real reminder admission without reactivating old queued work"
  );

  let source = svc.create(ws, uid, input_for(today - Duration::days(2))).await.unwrap();
  let yesterday = instant(today - Duration::days(1));
  let tomorrow = instant(today + Duration::days(1));
  let elapsed = svc
    .update(
      source.id,
      ws,
      uid,
      UpdateScope::This {
        instance_start: yesterday,
      },
      NativeEventUpdate {
        starts_at: Some(tomorrow + Duration::hours(4)),
        ends_at: Some(tomorrow + Duration::hours(5)),
        title: Some(Some("Elapsed pause exception".into())),
        ..Default::default()
      },
    )
    .await
    .unwrap();
  let retained = svc
    .update(
      source.id,
      ws,
      uid,
      UpdateScope::This {
        instance_start: tomorrow,
      },
      NativeEventUpdate {
        title: Some(Some("Future exception".into())),
        ..Default::default()
      },
    )
    .await
    .unwrap();
  let revision = repo.get_calendar_timing(source.id).await.unwrap().unwrap().revision;
  svc
    .control_recurrence(source.id, ws, uid, revision, CalendarTimingChange::Pause)
    .await
    .unwrap();
  // Model an already persisted open pause from yesterday, without waiting or
  // changing production clocks; this fixture owns its isolated timing row.
  let since = (today - Duration::days(1)).and_hms_opt(0, 0, 0).unwrap().and_utc();
  sqlx::query("UPDATE scheduling_schedules SET paused_at=$2 WHERE id=(SELECT recurrence_schedule_id FROM calendar_events WHERE id=$1)").bind(source.id).bind(since).execute(&pool).await.unwrap();
  let paused = repo.get_calendar_timing(source.id).await.unwrap().unwrap();
  svc
    .control_recurrence(source.id, ws, uid, paused.revision, CalendarTimingChange::Resume)
    .await
    .unwrap();
  let timing = repo.get_calendar_timing(source.id).await.unwrap().unwrap();
  assert_eq!(timing.pauses.len(), 1);
  let mail: Vec<serde_json::Value> =
    sqlx::query_scalar("SELECT payload FROM outbox_events WHERE event_type='calendar_mail' AND aggregate_id=$1")
      .bind(retained.id.to_string())
      .fetch_all(&pool)
      .await
      .unwrap();
  let cancellation = mail
    .iter()
    .find(|intent| intent["template"] == "calendar-cancellation")
    .expect("paused override cancellation");
  let resumed_request = mail
    .iter()
    .find(|intent| {
      intent["template"] == "calendar-update"
        && intent["sequence"].as_i64().unwrap() > cancellation["sequence"].as_i64().unwrap()
    })
    .expect("Resume must not fingerprint away the child REQUEST after CANCEL");
  assert_eq!(resumed_request["event"]["remote_event_id"], source.id.to_string());
  assert_ne!(resumed_request["event"]["payload"]["status"], "CANCELLED");
  let projected = repo.get_calendar_export_event(source.id).await.unwrap().unwrap();
  let resumed_ics = myoxus_infrastructure::caldav::calendar_event_to_vcalendar(&projected);
  assert!(
    !projected.payload["rrule"].as_str().unwrap().contains("UNTIL="),
    "resume restores the unbounded original rule, not the old cutoff"
  );
  assert!(resumed_ics.contains(&yesterday.format("%Y%m%dT%H%M%SZ").to_string()));
  let canonical = repo.get_calendar_event(source.id).await.unwrap().unwrap();
  assert!(
    projected.payload["exdates"]
      .as_array()
      .unwrap()
      .iter()
      .all(|date| canonical.payload["exdates"]
        .as_array()
        .is_some_and(|base| base.contains(date))
        || chrono::DateTime::parse_from_rfc3339(date.as_str().unwrap())
          .unwrap()
          .with_timezone(&Utc)
          < timing.pauses[0].ends_at),
    "new paused exclusions must be elapsed; keep the separately authored future override exclusion"
  );
  let events = repo
    .list_workspace_events(ws, tomorrow, tomorrow + Duration::days(1))
    .await
    .unwrap();
  assert!(
    !events.iter().any(|event| event.id == elapsed.id),
    "original key suppresses an elapsed override even when its display was moved into the future"
  );
  assert!(events.iter().any(|event| event.id == retained.id));
  let elapsed_suppressed: bool = sqlx::query_scalar("SELECT suppressed FROM calendar_reminders WHERE event_id=$1")
    .bind(elapsed.id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert!(elapsed_suppressed);
  svc
    .control_recurrence(source.id, ws, uid, timing.revision, CalendarTimingChange::End)
    .await
    .unwrap();
  let ended = repo.get_calendar_timing(source.id).await.unwrap().unwrap();
  assert_eq!(ended.lifecycle, ScheduleLifecycle::Ended);
  assert!(repo.get_calendar_event(elapsed.id).await.unwrap().is_some());
  assert!(repo.get_calendar_event(retained.id).await.unwrap().is_some());
  assert!(
    !repo
      .list_workspace_events(ws, tomorrow, tomorrow + Duration::days(1))
      .await
      .unwrap()
      .iter()
      .any(|event| event.id == retained.id)
  );
  assert!(
    svc
      .control_recurrence(source.id, ws, uid, ended.revision, CalendarTimingChange::Resume)
      .await
      .is_err()
  );
  let behind = chrono::Timelike::hour(&Utc::now()) < 12;
  let date_zone = if behind { "Etc/GMT+12" } else { "Pacific/Kiritimati" }
    .parse::<chrono_tz::Tz>()
    .unwrap();
  let date = Utc::now().with_timezone(&date_zone).date_naive() + Duration::days(if behind { 1 } else { 0 });
  let mut date_input = base_input(ws);
  date_input.all_day = true;
  date_input.starts_at = date.and_hms_opt(0, 0, 0).unwrap().and_utc();
  date_input.ends_at = date_input.starts_at + Duration::days(1);
  date_input.recurrence = Some(RecurrenceRule {
    selector: RecurrenceSelector::Daily,
    interval: std::num::NonZeroU32::new(1).unwrap(),
    start: ScheduleValue::Date(date),
    end: None,
    zone: AdmissionZone::try_from(date_zone.name().to_owned()).unwrap(),
  });
  let date_source = svc.create(ws, uid, date_input).await.unwrap();
  let revision = repo
    .get_calendar_timing(date_source.id)
    .await
    .unwrap()
    .unwrap()
    .revision;
  svc
    .control_recurrence(date_source.id, ws, uid, revision, CalendarTimingChange::Pause)
    .await
    .unwrap();
  let slots = repo
    .list_event_instances(date_source.id, date_source.starts_at, date_source.ends_at)
    .await
    .unwrap();
  let paused = repo.get_calendar_timing(date_source.id).await.unwrap().unwrap();
  let admission = date_zone
    .from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
    .earliest()
    .unwrap()
    .with_timezone(&Utc);
  assert_eq!(
    slots.len(),
    usize::from(admission < paused.paused_at.unwrap()),
    "pinned local date, not the UTC identity midpoint, decides whether the all-day event already started"
  );
  svc
    .control_recurrence(date_source.id, ws, uid, paused.revision, CalendarTimingChange::Resume)
    .await
    .unwrap();
  let resumed = repo.get_calendar_timing(date_source.id).await.unwrap().unwrap();
  let skipped = resumed
    .pauses
    .iter()
    .any(|pause| admission >= pause.starts_at && admission < pause.ends_at);
  assert_eq!(
    repo
      .list_event_instances(date_source.id, date_source.starts_at, date_source.ends_at)
      .await
      .unwrap()
      .len(),
    usize::from(!skipped)
  );
  sqlx::query("DELETE FROM outbox_events WHERE event_type='calendar_mail' AND payload->>'workspaceId'=$1")
    .bind(ws.to_string())
    .execute(&pool)
    .await
    .expect("remove detached lifecycle mail fixtures");
  cleanup(&pool, ws, uid).await;
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(recipient)
    .execute(&pool)
    .await
    .expect("remove lifecycle recipient");
}

// INV-CAL-SCOPE-02: scope=All edits master in-place
#[tokio::test]
async fn inv_scope02_all_edits_master_inplace() {
  let Some((pool, svc, _auth_store, uid, ws)) = connect_svc().await else {
    return;
  };

  let mut input = base_input(ws);
  input.starts_at = "2031-03-23T08:00:00Z".parse().unwrap();
  input.ends_at = input.starts_at + chrono::Duration::hours(1);
  input.recurrence = Some(myoxus_domain::scheduling::RecurrenceRule {
    selector: myoxus_domain::scheduling::RecurrenceSelector::Yearly { month: 3, day: 23 },
    interval: std::num::NonZeroU32::new(1).unwrap(),
    start: myoxus_domain::scheduling::ScheduleValue::LocalDateTime(input.starts_at.naive_utc()),
    end: None,
    zone: myoxus_domain::scheduling::AdmissionZone::try_from("UTC".to_owned()).unwrap(),
  });
  let master = svc.create(ws, uid, input).await.expect("create");
  let repo = SqlxCalendarRepository::new(pool.clone());
  let from = "2034-03-01T00:00:00Z".parse().unwrap();
  let to = "2034-04-01T00:00:00Z".parse().unwrap();
  let cached = myoxus_domain::repositories::CalendarRepository::list_event_instances(&repo, master.id, from, to)
    .await
    .unwrap();
  assert_eq!(cached.len(), 1);
  let protected = svc
    .update(
      master.id,
      ws,
      uid,
      UpdateScope::This {
        instance_start: "2038-07-04T08:00:00Z".parse().unwrap(),
      },
      NativeEventUpdate {
        title: Some(Some("Protected outside window".into())),
        ..Default::default()
      },
    )
    .await
    .unwrap();
  let update = NativeEventUpdate {
    title: Some(Some("All-Updated".into())),
    ends_at: Some(master.ends_at + chrono::Duration::hours(1)),
    recurrence: Some(Some(myoxus_domain::scheduling::calendar::ConfirmedCalendarRecurrence {
      rule: myoxus_domain::scheduling::RecurrenceRule {
        selector: myoxus_domain::scheduling::RecurrenceSelector::Daily,
        interval: std::num::NonZeroU32::new(1).unwrap(),
        start: myoxus_domain::scheduling::ScheduleValue::LocalDateTime(master.starts_at.naive_utc()),
        end: None,
        zone: myoxus_domain::scheduling::AdmissionZone::try_from("UTC".to_owned()).unwrap(),
      },
      actor_id: uid,
    })),
    ..Default::default()
  };
  let updated = svc
    .update(master.id, ws, uid, UpdateScope::All, update)
    .await
    .expect("update scope=all");

  assert_eq!(
    updated.title.as_deref(),
    Some("All-Updated"),
    "INV-CAL-SCOPE-02: master title must change"
  );
  let retained: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM calendar_events WHERE recurrence_parent_id = $1")
    .bind(master.id)
    .fetch_all(&pool)
    .await
    .expect("read retained overrides");
  assert_eq!(
    retained,
    vec![protected.id],
    "All retains the out-of-window original exception instead of replacing it"
  );
  let rows:Vec<(Uuid,chrono::DateTime<Utc>,chrono::DateTime<Utc>)>=sqlx::query_as("SELECT id,instance_start,instance_end FROM calendar_event_instances WHERE event_id=$1 AND instance_start>=$2 AND instance_start<$3 ORDER BY instance_start")
    .bind(master.id).bind(from).bind(to).fetch_all(&pool).await.unwrap();
  assert_eq!(
    rows.len(),
    31,
    "sparse yearly slots must not shrink the recorded requested window during a daily edit"
  );
  assert!(
    rows
      .iter()
      .any(|row| row.0 == cached[0].id && row.1 == cached[0].instance_start)
  );
  assert!(
    rows.iter().all(|row| row.2 - row.1 == chrono::Duration::hours(2)),
    "the native write commits reprojected cache, without a repairing read"
  );

  cleanup(&pool, ws, uid).await;
}

/// Reminder update patches replace atomically, clear explicitly, and leave the
/// existing rows untouched when the patch is omitted.
#[tokio::test]
async fn inv_calendar_reminder_update_replaces_clears_and_preserves_on_omission() {
  use myoxus_domain::repositories::CalendarRepository;
  let Some((pool, svc, _auth_store, uid, ws)) = connect_svc().await else {
    return;
  };

  let mut input = base_input(ws);
  let repo = SqlxCalendarRepository::new(pool.clone());
  repo
    .upsert_workspace_calendar_settings(&myoxus_domain::entities::WorkspaceCalendarSettings {
      workspace_id: ws,
      writeback_subscription_id: None,
      default_reminder_offset_minutes: Some(45),
      updated_at: Utc::now(),
    })
    .await
    .unwrap();
  let inherited = svc.create(ws, uid, base_input(ws)).await.unwrap();
  assert_eq!(
    inherited.reminders[0].minutes_before, 45,
    "omission inherits the workspace default"
  );
  let mut none = base_input(ws);
  none.reminders = Some(vec![]);
  assert!(
    svc.create(ws, uid, none).await.unwrap().reminders.is_empty(),
    "an explicit No reminder must not silently restore the workspace default"
  );
  input.description_delta = Some(serde_json::json!({"text":"Description to clear"}));
  input.reminders = Some(vec![ReminderInput {
    minutes_before: 30,
    channel: "in_app".to_string(),
  }]);
  let master = svc.create(ws, uid, input).await.expect("create with reminder");
  assert_eq!(master.reminders.len(), 1, "creation must return its persisted reminder");
  assert_eq!(master.reminders[0].minutes_before, 30);
  assert_eq!(master.reminders[0].channel, "in_app");
  let created_reminder: (i64, Option<i32>) =
    sqlx::query_as("SELECT COUNT(*)::bigint, MIN(minutes_before) FROM calendar_reminders WHERE event_id = $1")
      .bind(master.id)
      .fetch_one(&pool)
      .await
      .expect("created reminder row");
  assert_eq!(created_reminder, (1, Some(30)));

  let replaced = svc
    .update(
      master.id,
      ws,
      uid,
      UpdateScope::All,
      NativeEventUpdate {
        description_delta: Some(None),
        reminders: Some(vec![
          NativeEventReminderInput {
            minutes_before: 5,
            channel: "in_app".to_string(),
          },
          NativeEventReminderInput {
            minutes_before: 60,
            channel: "email".to_string(),
          },
        ]),
        ..Default::default()
      },
    )
    .await
    .expect("replace reminders");
  assert_eq!(
    replaced.description_delta, None,
    "an explicit cleared description is not an omitted patch"
  );
  let mut replaced_minutes = replaced
    .reminders
    .iter()
    .map(|reminder| reminder.minutes_before)
    .collect::<Vec<_>>();
  replaced_minutes.sort_unstable();
  assert_eq!(
    replaced_minutes,
    vec![5, 60],
    "replace must return the reloaded reminder rows"
  );

  let delivered_id = replaced.reminders[0].id;
  sqlx::query("UPDATE calendar_reminders SET delivered_at = now() WHERE id = $1")
    .bind(delivered_id)
    .execute(&pool)
    .await
    .expect("mark reminder delivered");
  let repeated = svc
    .update(
      master.id,
      ws,
      uid,
      UpdateScope::All,
      NativeEventUpdate {
        reminders: Some(
          replaced
            .reminders
            .iter()
            .rev()
            .map(|reminder| NativeEventReminderInput {
              minutes_before: reminder.minutes_before,
              channel: reminder.channel.clone(),
            })
            .collect(),
        ),
        ..Default::default()
      },
    )
    .await
    .expect("repeat unchanged reminder patch");
  let ids = |event: &myoxus_domain::entities::CalendarEvent| {
    event
      .reminders
      .iter()
      .map(|r| r.id)
      .collect::<std::collections::BTreeSet<_>>()
  };
  assert_eq!(
    ids(&repeated),
    ids(&replaced),
    "identical patches must retain reminder identities"
  );
  assert!(
    repeated
      .reminders
      .iter()
      .find(|r| r.id == delivered_id)
      .unwrap()
      .delivered_at
      .is_some(),
    "identical patches must not rearm a delivered reminder"
  );

  let unchanged = svc
    .update(
      master.id,
      ws,
      uid,
      UpdateScope::All,
      NativeEventUpdate {
        title: Some(Some("Renamed".to_string())),
        ..Default::default()
      },
    )
    .await
    .expect("update without reminder patch");
  let mut unchanged_minutes = unchanged
    .reminders
    .iter()
    .map(|reminder| reminder.minutes_before)
    .collect::<Vec<_>>();
  unchanged_minutes.sort_unstable();
  assert_eq!(
    unchanged_minutes,
    vec![5, 60],
    "omitting reminders must preserve existing rows"
  );

  let cleared = svc
    .update(
      master.id,
      ws,
      uid,
      UpdateScope::All,
      NativeEventUpdate {
        reminders: Some(Vec::new()),
        ..Default::default()
      },
    )
    .await
    .expect("clear reminders");
  assert!(cleared.reminders.is_empty(), "empty replacement must clear reminders");
  let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_reminders WHERE event_id = $1")
    .bind(master.id)
    .fetch_one(&pool)
    .await
    .expect("count reminder rows");
  assert_eq!(row_count, 0);

  cleanup(&pool, ws, uid).await;
}

// Delete scope=This: master survives, EXDATE added
#[tokio::test]
async fn inv_scope_this_delete_adds_exdate() {
  let Some((pool, svc, _auth_store, uid, ws)) = connect_svc().await else {
    return;
  };

  let account_id = Uuid::new_v4();
  let subscription_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config)
     VALUES ($1, $2, 'caldav', $3, '{}'::jsonb)",
  )
  .bind(account_id)
  .bind(uid)
  .bind(format!("scope-this-{uid}"))
  .execute(&pool)
  .await
  .expect("seed writeback account");
  sqlx::query(
    "INSERT INTO calendar_subscriptions (id, account_id, remote_calendar_id)
     VALUES ($1, $2, 'http://caldav.example/scope-this/')",
  )
  .bind(subscription_id)
  .bind(account_id)
  .execute(&pool)
  .await
  .expect("seed writeback subscription");
  sqlx::query(
    "INSERT INTO workspace_calendar_settings (workspace_id, writeback_subscription_id, updated_at)
     VALUES ($1, $2, NOW())",
  )
  .bind(ws)
  .bind(subscription_id)
  .execute(&pool)
  .await
  .expect("configure writeback");

  let master = svc.create(ws, uid, base_input(ws)).await.expect("create");
  sqlx::query("DELETE FROM calendar_pending_writes WHERE event_id = $1")
    .bind(master.id)
    .execute(&pool)
    .await
    .expect("clear create write before scope assertion");
  let instance_start = master.starts_at;

  svc
    .delete(master.id, ws, uid, DeleteScope::This { instance_start })
    .await
    .expect("delete scope=this");

  // Master must still exist
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE id = $1")
    .bind(master.id)
    .fetch_one(&pool)
    .await
    .expect("count master");
  assert_eq!(count, 1, "scope=This delete must NOT remove the master event");

  let exdates: serde_json::Value =
    sqlx::query_scalar("SELECT COALESCE(payload->'exdates', '[]'::jsonb) FROM calendar_events WHERE id = $1")
      .bind(master.id)
      .fetch_one(&pool)
      .await
      .expect("fetch exdates");
  assert!(
    !exdates.as_array().unwrap().is_empty(),
    "scope=This delete must add EXDATE to master"
  );
  let operations: Vec<String> =
    sqlx::query_scalar("SELECT operation FROM calendar_pending_writes WHERE event_id = $1 ORDER BY created_at")
      .bind(master.id)
      .fetch_all(&pool)
      .await
      .expect("read occurrence writeback");
  assert_eq!(
    operations,
    ["update".to_string()],
    "scope=This must serialize the EXDATE as a master update, never a remote delete"
  );

  cleanup(&pool, ws, uid).await;
}

// Delete scope=All: event removed from DB (FK cascade takes overrides)
#[tokio::test]
async fn inv_scope_all_delete_removes_event() {
  let Some((pool, svc, _auth_store, uid, ws)) = connect_svc().await else {
    return;
  };

  let master = svc.create(ws, uid, base_input(ws)).await.expect("create");

  svc
    .delete(master.id, ws, uid, DeleteScope::All)
    .await
    .expect("delete scope=all");

  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE id = $1")
    .bind(master.id)
    .fetch_one(&pool)
    .await
    .expect("count after delete");
  assert_eq!(count, 0, "scope=All delete must remove the event from DB");

  cleanup(&pool, ws, uid).await;
}

/// An authorized member of two workspaces must not be able to disguise an
/// event from one workspace as an update or delete in the other workspace.
#[tokio::test]
async fn inv_native_event_mutations_bind_the_event_to_the_authorized_workspace() {
  let Some((pool, svc, auth_store, uid, workspace)) = connect_svc().await else {
    return;
  };
  let other_workspace = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'svc-other-ws')")
    .bind(other_workspace)
    .bind(uid)
    .execute(&pool)
    .await
    .expect("seed second workspace");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Collaborator', 'Accepted', NOW())",
  )
  .bind(other_workspace)
  .bind(uid)
  .execute(&pool)
  .await
  .expect("seed second workspace membership");
  auth_store
    .add_or_update_member(
      other_workspace,
      uid,
      WorkspaceRole::Collaborator,
      MembershipStatus::Accepted,
      None,
    )
    .await
    .expect("seed second in-memory membership");

  let event = svc
    .create(workspace, uid, base_input(workspace))
    .await
    .expect("create event");
  let update_error = svc
    .update(
      event.id,
      other_workspace,
      uid,
      UpdateScope::All,
      NativeEventUpdate {
        title: Some(Some("cross-workspace mutation".to_string())),
        ..Default::default()
      },
    )
    .await
    .expect_err("cross-workspace update must fail");
  assert!(matches!(update_error, AuthError::ActionForbidden));

  let delete_error = svc
    .delete(event.id, other_workspace, uid, DeleteScope::All)
    .await
    .expect_err("cross-workspace delete must fail");
  assert!(matches!(delete_error, AuthError::ActionForbidden));
  let persisted_title: Option<String> = sqlx::query_scalar("SELECT title FROM calendar_events WHERE id = $1")
    .bind(event.id)
    .fetch_one(&pool)
    .await
    .expect("event must remain in its original workspace");
  assert_eq!(persisted_title.as_deref(), Some("Test Event"));

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(other_workspace)
    .execute(&pool)
    .await
    .expect("delete second workspace");
  cleanup(&pool, workspace, uid).await;
}
