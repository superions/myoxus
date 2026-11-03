// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-JCAL-SERVER-01-D: Invariant tests for native calendar event repository
//! methods (insert_native_event, update_native_event, tag CRUD, settings).
//!
//! Invariants tested:
//!   INV-CAL-NATIVE-01      insert_native_event stores origin='native', account_id IS NULL
//!   INV-CAL-NATIVE-02      update_native_event on external event_id returns None
//!   INV-CAL-ALL-MEMBERS-01 all_members=true event has no calendar_event_participants rows
//!   tag-CRUD               insert/update/list/delete cycle, UNIQUE(workspace_id, name)
//!   settings-RT            upsert + get round-trip for workspace_calendar_settings
//!
//! Run: TEST_DATABASE_URL=... cargo test -p myoxus-api calendar_native_repo

use chrono::Utc;
use uuid::Uuid;

use myoxus_domain::entities::{CalendarEventTag, WorkspaceCalendarSettings};
use myoxus_domain::repositories::{CalendarRepository, NativeEventInput, NativeEventUpdate};
use myoxus_infrastructure::calendar::SqlxCalendarRepository;

async fn connect() -> Option<(sqlx::PgPool, SqlxCalendarRepository)> {
  let url = std::env::var("TEST_DATABASE_URL").ok()?;
  let pool = sqlx::PgPool::connect(&url).await.ok()?;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrations must apply cleanly");
  let repo = SqlxCalendarRepository::new(pool.clone());
  Some((pool, repo))
}

async fn seed_workspace(pool: &sqlx::PgPool) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  let ws_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, name, email) VALUES ($1, 'repo-test', $2)")
    .bind(user_id)
    .bind(format!("repo-test-{user_id}@test.local"))
    .execute(pool)
    .await
    .expect("seed user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'repo-ws')")
    .bind(ws_id)
    .bind(user_id)
    .execute(pool)
    .await
    .expect("seed workspace");
  (user_id, ws_id)
}

async fn seed_external_event(pool: &sqlx::PgPool, ws_id: Uuid) -> Uuid {
  let account_id = Uuid::new_v4();
  let user_id: Uuid = sqlx::query_scalar("SELECT owner_user_id FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .fetch_one(pool)
    .await
    .expect("get owner");
  sqlx::query("INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id) VALUES ($1, $2, 'caldav', $3)")
    .bind(account_id)
    .bind(user_id)
    .bind(format!("acc-{account_id}"))
    .execute(pool)
    .await
    .expect("seed account");

  let event_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO calendar_events (id, account_id, remote_event_id, starts_at, ends_at, payload, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW() + interval '1 hour', '{}', NOW())",
  )
  .bind(event_id)
  .bind(account_id)
  .bind(format!("uid-{event_id}"))
  .execute(pool)
  .await
  .expect("seed external event");
  event_id
}

async fn cleanup(pool: &sqlx::PgPool, ws_id: Uuid) {
  let _ = sqlx::query("DELETE FROM workspace_calendar_settings WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM calendar_events WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM calendar_event_tags WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await;
  let owner: Option<Uuid> = sqlx::query_scalar("SELECT owner_user_id FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
  let _ = sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(pool)
    .await;
  if let Some(u) = owner {
    let _ = sqlx::query("DELETE FROM users WHERE id = $1")
      .bind(u)
      .execute(pool)
      .await;
  }
}

// INV-CAL-NATIVE-01: insert_native_event stores origin='native', NULL identity
#[tokio::test]
async fn inv_cal_native01_insert_native_has_null_identity() {
  let Some((pool, repo)) = connect().await else { return };
  let (_, ws_id) = seed_workspace(&pool).await;

  let input = NativeEventInput {
    workspace_id: ws_id,
    title: Some("Standup".to_string()),
    imported_recurrence: None,
    recurrence: None,
    description_delta: None,
    starts_at: Utc::now(),
    ends_at: Utc::now() + chrono::Duration::hours(1),
    all_day: false,
    all_members: false,
    tag_id: None,
    source_doc_id: None,
    source_anchor: None,
    recurrence_parent_id: None,
    recurrence_ical_id: None,
  };
  let event = repo.insert_native_event(&input).await.expect("insert_native_event");

  assert_eq!(
    event.account_id, None,
    "INV-CAL-NATIVE-01: account_id must be NULL for native"
  );
  assert_eq!(
    event.remote_event_id, None,
    "INV-CAL-NATIVE-01: remote_event_id must be NULL for native"
  );

  // Confirm origin='native' at DB level
  let origin: String = sqlx::query_scalar("SELECT origin::text FROM calendar_events WHERE id = $1")
    .bind(event.id)
    .fetch_one(&pool)
    .await
    .expect("fetch origin");
  assert_eq!(origin, "native");

  cleanup(&pool, ws_id).await;
}

// INV-CAL-NATIVE-02: update_native_event on external event returns None
#[tokio::test]
async fn inv_cal_native02_update_external_returns_none() {
  let Some((pool, repo)) = connect().await else { return };
  let (_, ws_id) = seed_workspace(&pool).await;
  let ext_event_id = seed_external_event(&pool, ws_id).await;

  let update = NativeEventUpdate {
    title: Some(Some("Hijacked".to_string())),
    ..Default::default()
  };
  let result = repo
    .update_native_event(ext_event_id, &update)
    .await
    .expect("update call");

  assert!(
    result.is_none(),
    "INV-CAL-NATIVE-02: update on external event must return None"
  );

  // Confirm the external event row still exists (was not touched).
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE id = $1 AND origin = 'external'")
    .bind(ext_event_id)
    .fetch_one(&pool)
    .await
    .expect("count");
  assert_eq!(count, 1, "external event must still exist and have origin=external");

  cleanup(&pool, ws_id).await;
}

// INV-CAL-TAG-01: tag CRUD + UNIQUE(workspace_id, name)
#[tokio::test]
async fn inv_cal_tag01_tag_crud_and_uniqueness() {
  let Some((pool, repo)) = connect().await else { return };
  let (_, ws_id) = seed_workspace(&pool).await;
  let now = Utc::now();

  let tag = CalendarEventTag {
    id: Uuid::new_v4(),
    workspace_id: ws_id,
    name: "Work".to_string(),
    color: "#4CAF50".to_string(),
    created_at: now,
    updated_at: now,
  };
  let inserted = repo.insert_calendar_event_tag(&tag).await.expect("insert_tag");
  assert_eq!(inserted.name, "Work");
  assert_eq!(inserted.color, "#4CAF50");

  // Duplicate name in same workspace must fail
  let dup = CalendarEventTag {
    id: Uuid::new_v4(),
    name: "Work".to_string(),
    ..tag.clone()
  };
  assert!(
    repo.insert_calendar_event_tag(&dup).await.is_err(),
    "duplicate name must fail"
  );

  // Update color
  let updated = repo
    .update_calendar_event_tag(inserted.id, ws_id, "Work", "#E53935")
    .await
    .expect("update_tag");
  assert_eq!(updated.unwrap().color, "#E53935");

  // List returns the tag
  let tags = repo.list_calendar_event_tags(ws_id).await.expect("list_tags");
  assert_eq!(tags.len(), 1);
  assert_eq!(tags[0].name, "Work");

  // Delete
  repo
    .delete_calendar_event_tag(inserted.id, ws_id)
    .await
    .expect("delete_tag");
  let tags_after = repo.list_calendar_event_tags(ws_id).await.expect("list_after");
  assert!(tags_after.is_empty());

  cleanup(&pool, ws_id).await;
}

// workspace_calendar_settings: upsert + get round-trip
#[tokio::test]
async fn settings_upsert_round_trip() {
  let Some((pool, repo)) = connect().await else { return };
  let (_, ws_id) = seed_workspace(&pool).await;

  let settings = WorkspaceCalendarSettings {
    workspace_id: ws_id,
    writeback_subscription_id: None,
    default_reminder_offset_minutes: Some(15),
    updated_at: Utc::now(),
  };
  let saved = repo
    .upsert_workspace_calendar_settings(&settings)
    .await
    .expect("upsert_settings");
  assert_eq!(saved.default_reminder_offset_minutes, Some(15));

  let fetched = repo.get_workspace_calendar_settings(ws_id).await.expect("get_settings");
  assert_eq!(fetched.unwrap().default_reminder_offset_minutes, Some(15));

  // Upsert again with different value
  let updated = WorkspaceCalendarSettings {
    default_reminder_offset_minutes: Some(30),
    updated_at: Utc::now(),
    ..settings
  };
  repo
    .upsert_workspace_calendar_settings(&updated)
    .await
    .expect("re-upsert");
  let re_fetched = repo.get_workspace_calendar_settings(ws_id).await.expect("re-get");
  assert_eq!(re_fetched.unwrap().default_reminder_offset_minutes, Some(30));

  cleanup(&pool, ws_id).await;
}

// INV-CAL-ALL-MEMBERS-01: all_members=true → calendar_event_participants has no rows
#[tokio::test]
async fn inv_cal_all_members01_no_participants_row_when_all_members() {
  let Some((pool, repo)) = connect().await else {
    return;
  };
  let (_, ws_id) = seed_workspace(&pool).await;

  let input = NativeEventInput {
    workspace_id: ws_id,
    title: Some("Team All-Hands".to_string()),
    imported_recurrence: None,
    recurrence: None,
    description_delta: None,
    starts_at: Utc::now(),
    ends_at: Utc::now() + chrono::Duration::hours(1),
    all_day: false,
    all_members: true,
    tag_id: None,
    source_doc_id: None,
    source_anchor: None,
    recurrence_parent_id: None,
    recurrence_ical_id: None,
  };
  let event = repo.insert_native_event(&input).await.expect("insert_native_event");

  assert!(event.all_members, "INV-CAL-ALL-MEMBERS-01: all_members must be true");

  let participant_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM calendar_event_participants WHERE event_id = $1")
      .bind(event.id)
      .fetch_one(&pool)
      .await
      .expect("count participants");
  assert_eq!(
    participant_count, 0,
    "INV-CAL-ALL-MEMBERS-01: calendar_event_participants must be empty for all_members=true event"
  );

  cleanup(&pool, ws_id).await;
}

/// Authored mutations retain scheduling intent after deletion and suppress replay.
#[sqlx::test]
async fn authored_calendar_mail_has_stable_uid_sequence_and_atomic_cancellation(pool: sqlx::PgPool) {
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrate isolated database");
  let (_, workspace) = seed_workspace(&pool).await;
  let recipient = Uuid::new_v4();
  sqlx::query("INSERT INTO users(id,email,name) VALUES($1,$2,'Recipient')")
    .bind(recipient)
    .bind(format!("calendar-{recipient}@example.test"))
    .execute(&pool)
    .await
    .expect("recipient");
  sqlx::query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'Collaborator','Accepted')",
  )
  .bind(workspace)
  .bind(recipient)
  .execute(&pool)
  .await
  .expect("membership");
  let repo = SqlxCalendarRepository::new(pool.clone());
  let start = "2026-10-12T09:00:00Z".parse().expect("date");
  let event = repo
    .insert_native_event(&NativeEventInput {
      imported_recurrence: None,
      recurrence: None,
      workspace_id: workspace,
      title: Some("Review".into()),
      description_delta: None,
      starts_at: start,
      ends_at: start + chrono::Duration::hours(1),
      all_day: false,
      all_members: true,
      tag_id: None,
      source_doc_id: None,
      source_anchor: None,
      recurrence_parent_id: None,
      recurrence_ical_id: None,
    })
    .await
    .expect("authored create");
  let first: serde_json::Value =
    sqlx::query_scalar("SELECT payload FROM outbox_events WHERE event_type='calendar_mail' AND aggregate_id=$1")
      .bind(event.id.to_string())
      .fetch_one(&pool)
      .await
      .expect("invitation intent");
  assert_eq!(first["template"], "calendar-invitation");
  assert_eq!(first["sequence"], 0);
  repo
    .update_native_event(
      event.id,
      &NativeEventUpdate {
        title: Some(Some("Review".into())),
        ..Default::default()
      },
    )
    .await
    .expect("unchanged save");
  let count: i64 =
    sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE event_type='calendar_mail' AND aggregate_id=$1")
      .bind(event.id.to_string())
      .fetch_one(&pool)
      .await
      .expect("count replay");
  assert_eq!(count, 1, "unchanged save must not invite twice");
  repo
    .update_native_event(
      event.id,
      &NativeEventUpdate {
        title: Some(Some("Updated review".into())),
        ..Default::default()
      },
    )
    .await
    .expect("update");
  let mut guard = repo.acquire_pending_write_guard(event.id).await.expect("delete guard");
  guard.delete_calendar_event(event.id).await.expect("atomic delete");
  guard.release().await.expect("unlock");
  assert!(
    repo
      .get_calendar_event(event.id)
      .await
      .expect("lookup deleted")
      .is_none()
  );
  let intents: Vec<serde_json::Value> = sqlx::query_scalar("SELECT payload FROM outbox_events WHERE event_type='calendar_mail' AND aggregate_id=$1 ORDER BY (payload->>'sequence')::int")
    .bind(event.id.to_string()).fetch_all(&pool).await.expect("detached intent");
  assert_eq!(intents.len(), 3);
  assert_eq!(intents[1]["template"], "calendar-update");
  assert_eq!(intents[2]["template"], "calendar-cancellation");
  for (index, intent) in intents.iter().enumerate() {
    assert_eq!(intent["sequence"], index);
    let snapshot: myoxus_domain::entities::CalendarEvent =
      serde_json::from_value(intent["event"].clone()).expect("snapshot");
    let ics = myoxus_infrastructure::caldav::ical_serializer::calendar_event_to_scheduling(
      &snapshot,
      index as i32,
      index == 2,
      intent["to"].as_str().unwrap(),
      intent["organizerEmail"].as_str().unwrap(),
    )
    .expect("scheduling ICS");
    assert!(ics.contains(&format!("UID:{}\r\n", event.id)));
    assert!(ics.contains(&format!("SEQUENCE:{index}\r\n")));
    assert!(ics.contains(if index == 2 { "METHOD:CANCEL" } else { "METHOD:REQUEST" }));
  }
}

/// Real SMTP consumption proves scheduling MIME, current opt-out and receipt replay.
#[sqlx::test]
async fn calendar_mail_worker_delivers_mime_and_suppresses_replay_and_opt_out(pool: sqlx::PgPool) {
  use myoxus_application::auth::{AuthStore, UserPreferencesPatch};
  use myoxus_application::calendar::mail::CalendarSchedulingMailIntent;
  use myoxus_application::ports::MailPort;
  use myoxus_infrastructure::mail::{MailConfig, SmtpMailAdapter, SmtpTransportMode};
  use myoxus_tests::smtp_fixture::{SmtpFixture, SmtpFixtureAuth, SmtpFixtureOptions};
  use std::sync::Arc;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("isolated migrations");
  let auth = Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone()));
  let (owner, workspace) = seed_workspace(&pool).await;
  let recipient = crate::helpers::create_user(&pool, "calendar_mail_recipient", false).await;
  crate::helpers::add_workspace_member(&pool, workspace, recipient).await;
  auth
    .patch_user_preferences(
      recipient,
      UserPreferencesPatch {
        locale: Some(Some("it".into())),
        ..Default::default()
      },
    )
    .await
    .expect("recipient language");
  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let sink = SmtpFixture::start(SmtpFixtureOptions::plain(SmtpFixtureAuth::None)).await;
  let sender = SmtpMailAdapter::new(
    MailConfig {
      smtp_host: sink.host().into(),
      smtp_port: sink.port(),
      smtp_name: None,
      smtp_user: None,
      smtp_pass: None,
      smtp_transport: SmtpTransportMode::Plain,
      smtp_verify_certificate: true,
      fallback_smtp: None,
      fallback_domains: vec![],
      from_email: "Myoxus <noreply@example.test>".into(),
      template_dir: concat!(env!("CARGO_MANIFEST_DIR"), "/../../templates/mail").into(),
    },
    None,
  )
  .expect("sender")
  .with_rendering_config("https://myoxus.example.test".into(), "en".into());
  let sender: Arc<dyn MailPort> = Arc::new(sender);
  let dispatcher = scheduling_dispatcher(&pool, sender);
  let input = NativeEventInput {
    workspace_id: workspace,
    title: Some("Review".into()),
    imported_recurrence: None,
    recurrence: None,
    description_delta: None,
    starts_at: Utc::now(),
    ends_at: Utc::now() + chrono::Duration::hours(1),
    all_day: false,
    all_members: true,
    tag_id: None,
    source_doc_id: None,
    source_anchor: None,
    recurrence_parent_id: None,
    recurrence_ical_id: None,
  };
  let event = repo.insert_native_event(&input).await.expect("event");
  let (id, mut payload): (Uuid, serde_json::Value) =
    sqlx::query_as("SELECT id,payload FROM outbox_events WHERE event_type='calendar_mail' AND aggregate_id=$1")
      .bind(event.id.to_string())
      .fetch_one(&pool)
      .await
      .expect("authored intent");
  payload["intentId"] = serde_json::json!(id);
  dispatcher
    .dispatch(&CalendarSchedulingMailIntent::from_payload(&payload).expect("decode intent"))
    .await
    .expect("SMTP delivery");
  dispatcher
    .dispatch(&CalendarSchedulingMailIntent::from_payload(&payload).expect("decode intent"))
    .await
    .expect("completed replay");
  let messages = sink.messages().await;
  assert_eq!(messages.len(), 1, "replay cannot resend");
  for marker in [
    "multipart/alternative",
    "text/html",
    "text/plain",
    "text/calendar",
    "method=REQUEST",
    "event.ics",
  ] {
    assert!(messages[0].contains(marker), "missing MIME {marker}");
  }
  auth
    .patch_user_preferences(
      recipient,
      UserPreferencesPatch {
        receive_invitation_email: Some(Some(false)),
        ..Default::default()
      },
    )
    .await
    .expect("current opt-out");
  let other = repo.insert_native_event(&input).await.expect("next event");
  let (id, mut payload): (Uuid, serde_json::Value) =
    sqlx::query_as("SELECT id,payload FROM outbox_events WHERE event_type='calendar_mail' AND aggregate_id=$1")
      .bind(other.id.to_string())
      .fetch_one(&pool)
      .await
      .expect("next intent");
  payload["intentId"] = serde_json::json!(id);
  dispatcher
    .dispatch(&CalendarSchedulingMailIntent::from_payload(&payload).expect("decode intent"))
    .await
    .expect("suppressed opt-out");
  assert_eq!(
    sink.messages().await.len(),
    1,
    "current preference suppresses queued mail"
  );
  auth
    .patch_user_preferences(
      recipient,
      UserPreferencesPatch {
        receive_invitation_email: Some(Some(true)),
        ..Default::default()
      },
    )
    .await
    .expect("enable invitations");
  // Reverse-order queue delivery must suppress only an older edit of the same
  // occurrence. A later sequence belonging to another occurrence still permits
  // the independent earlier change to reach the recipient.
  let mut occurrence_intents = Vec::new();
  let base: serde_json::Value = sqlx::query_scalar("SELECT payload FROM outbox_events WHERE id=$1")
    .bind(id)
    .fetch_one(&pool)
    .await
    .expect("base delivery projection");
  for (sequence, recurrence) in [
    (4, "20261012T090000Z"),
    (6, "20261012T090000Z"),
    (8, "20261013T090000Z"),
  ] {
    let mut intent = base.clone();
    intent["event"]["id"] = serde_json::json!(event.id);
    intent["sequence"] = serde_json::json!(sequence);
    intent["template"] = serde_json::json!("calendar-update");
    intent["event"]["payload"]["recurrenceId"] = serde_json::json!(recurrence);
    let intent_id = Uuid::new_v4();
    sqlx::query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'calendar',$2,'calendar_mail',$3)")
      .bind(intent_id).bind(event.id.to_string()).bind(&intent).execute(&pool).await.expect("queue ordering fixture");
    intent["intentId"] = serde_json::json!(intent_id);
    occurrence_intents.push(intent);
  }
  dispatcher
    .dispatch(&CalendarSchedulingMailIntent::from_payload(&occurrence_intents[0]).expect("decode occurrence"))
    .await
    .expect("stale occurrence suppressed");
  assert_eq!(
    sink.messages().await.len(),
    1,
    "older occurrence copy must not reach SMTP"
  );
  for intent in &occurrence_intents[1..] {
    dispatcher
      .dispatch(&CalendarSchedulingMailIntent::from_payload(intent).expect("decode occurrence"))
      .await
      .expect("independent occurrence delivery");
  }
  assert_eq!(
    sink.messages().await.len(),
    3,
    "different occurrences retain both changes"
  );
  let mut guard = repo.acquire_pending_write_guard(event.id).await.expect("guard");
  guard.delete_calendar_event(event.id).await.expect("delete");
  guard.release().await.expect("release");
  let (id,mut payload):(Uuid,serde_json::Value)=sqlx::query_as("SELECT id,payload FROM outbox_events WHERE event_type='calendar_mail' AND aggregate_id=$1 AND payload->>'template'='calendar-cancellation'").bind(event.id.to_string()).fetch_one(&pool).await.expect("detached cancellation");
  payload["intentId"] = serde_json::json!(id);
  dispatcher
    .dispatch(&CalendarSchedulingMailIntent::from_payload(&payload).expect("decode intent"))
    .await
    .expect("deleted-event cancellation SMTP");
  assert_eq!(sink.messages().await.len(), 4);
  assert!(sink.messages().await[3].contains("method=CANCEL"));
  assert!(
    repo
      .get_calendar_event(event.id)
      .await
      .expect("deleted lookup")
      .is_none()
  );
  assert_ne!(owner, recipient);
}

/// Repeated authored occurrence saves retain identity, EXDATE and mail intent.
#[sqlx::test]
async fn native_occurrence_save_is_atomic_and_suppresses_duplicate_mail(pool: sqlx::PgPool) {
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("isolated migrations");
  let (_, workspace) = seed_workspace(&pool).await;
  let recipient = Uuid::new_v4();
  sqlx::query("INSERT INTO users(id,email) VALUES($1,$2)")
    .bind(recipient)
    .bind(format!("occurrence-{recipient}@example.test"))
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'Collaborator','Accepted')",
  )
  .bind(workspace)
  .bind(recipient)
  .execute(&pool)
  .await
  .unwrap();
  let repo = SqlxCalendarRepository::new(pool.clone());
  let start = "2026-10-12T09:00:00Z".parse::<chrono::DateTime<Utc>>().unwrap();
  let mut input = NativeEventInput {
    imported_recurrence: None,
    recurrence: None,
    workspace_id: workspace,
    title: Some("Series review".into()),
    description_delta: None,
    starts_at: start,
    ends_at: start + chrono::Duration::hours(1),
    all_day: false,
    all_members: true,
    tag_id: None,
    source_doc_id: None,
    source_anchor: None,
    recurrence_parent_id: None,
    recurrence_ical_id: None,
  };
  let master = repo.insert_native_event(&input).await.expect("master");
  input.recurrence_parent_id = Some(master.id);
  input.recurrence_ical_id = Some("20261012T090000Z".into());
  input.title = Some("Occurrence review".into());
  let first = repo.insert_native_event(&input).await.expect("occurrence");
  let again = repo.insert_native_event(&input).await.expect("occurrence replay");
  assert_eq!(first.id, again.id);
  let before: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE event_type='calendar_mail'")
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(before, 2);
  input.title = Some("Updated occurrence".into());
  let updated = repo.insert_native_event(&input).await.expect("occurrence update");
  assert_eq!(first.id, updated.id);
  let intents:Vec<serde_json::Value>=sqlx::query_scalar("SELECT payload FROM outbox_events WHERE event_type='calendar_mail' AND aggregate_id=$1 ORDER BY (payload->>'sequence')::int").bind(first.id.to_string()).fetch_all(&pool).await.unwrap();
  assert_eq!(intents.len(), 2);
  assert_eq!(intents[0]["template"], "calendar-update");
  assert_eq!(intents[0]["sequence"], 1);
  assert_eq!(intents[1]["sequence"], 2);
  assert_eq!(intents[1]["event"]["remote_event_id"], master.id.to_string());
  let exclusions: serde_json::Value = sqlx::query_scalar("SELECT payload->'exdates' FROM calendar_events WHERE id=$1")
    .bind(master.id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(exclusions.as_array().unwrap().len(), 1);
  input.recurrence_ical_id = Some("20261013T090000Z".into());
  input.tag_id = Some(Uuid::new_v4());
  assert!(
    repo.insert_native_event(&input).await.is_err(),
    "invalid tag must fail the entire occurrence save"
  );
  let after: serde_json::Value = sqlx::query_scalar("SELECT payload->'exdates' FROM calendar_events WHERE id=$1")
    .bind(master.id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    exclusions, after,
    "failed override must not hide another master occurrence"
  );
  let children: i64 = sqlx::query_scalar("SELECT count(*) FROM calendar_events WHERE recurrence_parent_id=$1")
    .bind(master.id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(children, 1);
  let after: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE event_type='calendar_mail'")
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(after, 3, "only create and a changed projection generate mail");
}

fn scheduling_dispatcher(
  pool: &sqlx::PgPool,
  sender: std::sync::Arc<dyn myoxus_application::ports::MailPort>,
) -> myoxus_application::calendar::mail::CalendarSchedulingMailDispatcher {
  use std::sync::Arc;
  myoxus_application::calendar::mail::CalendarSchedulingMailDispatcher::new(
    Arc::new(SqlxCalendarRepository::new(pool.clone())),
    Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone())),
    Arc::new(myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(
      pool.clone(),
      crate::helpers::database_starter_catalog(),
    )),
    sender,
    true,
    "Myoxus <noreply@example.test>".into(),
    myoxus_infrastructure::caldav::ical_serializer::calendar_event_to_scheduling,
    myoxus_infrastructure::caldav::ical_serializer::normalize_scheduling_mailbox,
  )
}

/// Observe the actual advisory session, including waiters, without borrowing
/// the dispatcher's connection or deriving acceptance from a sender spy.
async fn wait_for_mail_lock(pool: &sqlx::PgPool, intent: Uuid, granted: bool) -> i32 {
  tokio::time::timeout(std::time::Duration::from_secs(10), async {
    loop {
      let pid: Option<i32> = sqlx::query_scalar(
        "SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted=$2 \
        AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid \
        AND objid=(hashtextextended($1,0)&4294967295)::oid AND objsubid=1",
      )
      .bind(intent.to_string())
      .bind(granted)
      .fetch_optional(pool)
      .await
      .expect("lock inventory");
      if let Some(pid) = pid {
        return pid;
      }
      tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
  })
  .await
  .expect("intent session reaches expected lock state")
}

#[sqlx::test]
async fn scheduling_smtp_session_guard_releases_after_cancel_failure_and_completion(pool: sqlx::PgPool) {
  use myoxus_application::calendar::mail::CalendarSchedulingMailIntent;
  use myoxus_infrastructure::mail::{MailConfig, SmtpMailAdapter, SmtpTransportMode};
  use myoxus_tests::smtp_fixture::{SmtpFixture, SmtpFixtureAuth, SmtpFixtureOptions};
  use std::sync::Arc;
  use std::time::Duration;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("isolated migrations");
  let (_, workspace) = seed_workspace(&pool).await;
  let recipient = crate::helpers::create_user(&pool, "calendar_guard_recipient", false).await;
  crate::helpers::add_workspace_member(&pool, workspace, recipient).await;
  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let input = NativeEventInput {
    workspace_id: workspace,
    title: Some("Guard lifecycle".into()),
    imported_recurrence: None,
    recurrence: None,
    description_delta: None,
    starts_at: Utc::now(),
    ends_at: Utc::now() + chrono::Duration::hours(1),
    all_day: false,
    all_members: true,
    tag_id: None,
    source_doc_id: None,
    source_anchor: None,
    recurrence_parent_id: None,
    recurrence_ical_id: None,
  };
  let event = repo.insert_native_event(&input).await.expect("authored event");
  let (id, mut payload): (Uuid, serde_json::Value) =
    sqlx::query_as("SELECT id,payload FROM outbox_events WHERE event_type='calendar_mail' AND aggregate_id=$1")
      .bind(event.id.to_string())
      .fetch_one(&pool)
      .await
      .expect("authored intent");
  payload["intentId"] = serde_json::json!(id);
  let intent = CalendarSchedulingMailIntent::from_payload(&payload).expect("decode existing job");
  let sink = SmtpFixture::start(SmtpFixtureOptions::plain(SmtpFixtureAuth::None)).await;
  sink.pause_deliveries();
  let sender = SmtpMailAdapter::new(
    MailConfig {
      smtp_host: sink.host().into(),
      smtp_port: sink.port(),
      smtp_name: None,
      smtp_user: None,
      smtp_pass: None,
      smtp_transport: SmtpTransportMode::Plain,
      smtp_verify_certificate: true,
      fallback_smtp: None,
      fallback_domains: vec![],
      from_email: "Myoxus <noreply@example.test>".into(),
      template_dir: concat!(env!("CARGO_MANIFEST_DIR"), "/../../templates/mail").into(),
    },
    None,
  )
  .expect("SMTP sender")
  .with_rendering_config("https://myoxus.example.test".into(), "en".into());
  let dispatcher = scheduling_dispatcher(&pool, Arc::new(sender));
  let first_dispatcher = dispatcher.clone();
  let first_intent = intent.clone();
  let mut workers = tokio::task::JoinSet::new();
  let first = workers.spawn(async move { first_dispatcher.dispatch(&first_intent).await });
  let paused = tokio::time::timeout(Duration::from_secs(10), sink.next_paused_delivery())
    .await
    .expect("SMTP DATA pending");
  let pid = wait_for_mail_lock(&pool, id, true).await;
  let (state, xact_start): (String, Option<chrono::DateTime<Utc>>) =
    sqlx::query_as("SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1")
      .bind(pid)
      .fetch_one(&pool)
      .await
      .expect("SMTP-time connection state");
  assert_eq!(
    state, "idle",
    "delivery holds an idle SQL session, not an open transaction"
  );
  assert!(xact_start.is_none(), "no SMTP-time SQL transaction");
  let competing_dispatcher = dispatcher.clone();
  let competing_intent = intent.clone();
  workers.spawn(async move { competing_dispatcher.dispatch(&competing_intent).await });
  wait_for_mail_lock(&pool, id, false).await;
  assert_eq!(
    sink.messages().await.len(),
    1,
    "same intent cannot reach concurrent SMTP"
  );
  first.abort();
  assert!(
    workers
      .join_next()
      .await
      .expect("cancelled worker")
      .expect_err("worker cancelled")
      .is_cancelled()
  );
  drop(paused);
  let resumed = tokio::time::timeout(Duration::from_secs(10), sink.next_paused_delivery())
    .await
    .expect("retry acquires cancelled owner's lock");
  let completed_dispatcher = dispatcher.clone();
  let completed_intent = intent.clone();
  workers.spawn(async move { completed_dispatcher.dispatch(&completed_intent).await });
  wait_for_mail_lock(&pool, id, false).await;
  assert_eq!(
    sink.messages().await.len(),
    2,
    "normal concurrent replay waits before SMTP"
  );
  resumed.send(true).expect("accept retry SMTP");
  for _ in 0..2 {
    tokio::time::timeout(Duration::from_secs(10), workers.join_next())
      .await
      .expect("concurrent worker exits")
      .expect("concurrent worker result")
      .expect("concurrent worker join")
      .expect("delivery or completed replay");
  }
  let mut completed = tokio::time::timeout(Duration::from_secs(10), repo.acquire_mail_delivery_guard(id))
    .await
    .expect("completed lock released")
    .expect("completion guard");
  assert!(completed.completed().await.expect("completion receipt"));
  completed.release().await.expect("completion unlock");
  dispatcher.dispatch(&intent).await.expect("receipt replay");
  assert_eq!(sink.messages().await.len(), 2, "completed replay does not resend");
  // SMTP rejection leaves the receipt absent and releases ownership for retry.
  let failed_event = repo.insert_native_event(&input).await.expect("failure authored event");
  let (failed_id, mut failed_payload): (Uuid, serde_json::Value) =
    sqlx::query_as("SELECT id,payload FROM outbox_events WHERE event_type='calendar_mail' AND aggregate_id=$1")
      .bind(failed_event.id.to_string())
      .fetch_one(&pool)
      .await
      .expect("failure authored intent");
  failed_payload["intentId"] = serde_json::json!(failed_id);
  let failed_intent = CalendarSchedulingMailIntent::from_payload(&failed_payload).expect("failure intent");
  let failed_dispatcher = dispatcher.clone();
  let failed_copy = failed_intent.clone();
  workers.spawn(async move { failed_dispatcher.dispatch(&failed_copy).await });
  tokio::time::timeout(Duration::from_secs(10), sink.next_paused_delivery())
    .await
    .expect("failed delivery reaches SMTP")
    .send(false)
    .expect("reject SMTP");
  assert!(
    tokio::time::timeout(Duration::from_secs(10), workers.join_next())
      .await
      .expect("failure exits")
      .expect("failed worker result")
      .expect("failed worker join")
      .is_err()
  );
  let mut released = tokio::time::timeout(
    Duration::from_secs(10),
    repo.acquire_mail_delivery_guard(failed_intent.id),
  )
  .await
  .expect("failed lock released")
  .expect("failed receipt guard");
  assert!(!released.completed().await.expect("no failed receipt"));
  released.release().await.expect("failed unlock");
  let retry_dispatcher = dispatcher.clone();
  let retry_intent = failed_intent.clone();
  workers.spawn(async move { retry_dispatcher.dispatch(&retry_intent).await });
  tokio::time::timeout(Duration::from_secs(10), sink.next_paused_delivery())
    .await
    .expect("failed intent retries")
    .send(true)
    .expect("accept failed retry");
  tokio::time::timeout(Duration::from_secs(10), workers.join_next())
    .await
    .expect("retry exits")
    .expect("retry result")
    .expect("retry join")
    .expect("retry delivery");
  // Cancellation while waiting must close that waiter's connection before it
  // can later acquire the lock and accidentally return it to the pool.
  let acquire_id = Uuid::new_v4();
  let held = repo
    .acquire_mail_delivery_guard(acquire_id)
    .await
    .expect("acquisition blocker");
  let waiting_repo = repo.clone();
  let waiting = workers.spawn(async move {
    waiting_repo
      .acquire_mail_delivery_guard(acquire_id)
      .await
      .map(drop)
      .map_err(|_| myoxus_application::auth::AuthError::Storage("fixture acquire failed".into()))
  });
  let waiting_pid = wait_for_mail_lock(&pool, acquire_id, false).await;
  waiting.abort();
  assert!(matches!(workers.join_next().await.expect("cancelled acquire result"), Err(error) if error.is_cancelled()));
  held.release().await.expect("release acquisition blocker");
  let third = tokio::time::timeout(Duration::from_secs(10), repo.acquire_mail_delivery_guard(acquire_id))
    .await
    .expect("cancelled acquire cannot leak lock")
    .expect("third guard");
  third.release().await.expect("third unlock");
  tokio::time::timeout(Duration::from_secs(10), async {
    loop {
      let still_waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1)")
        .bind(waiting_pid)
        .fetch_one(&pool)
        .await
        .expect("cancelled connection cleanup");
      if !still_waiting {
        break;
      }
      tokio::time::sleep(Duration::from_millis(10)).await;
    }
  })
  .await
  .expect("cancelled lock-acquire connection must close");
}
