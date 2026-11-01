//! Unit tests for the calendar domain model (recurrence, reminder scheduling).
use chrono::{Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use myoxus_domain::entities::{
  CalendarAccount, CalendarEvent, CalendarEventParticipant, CalendarReminder, CalendarSubscription, WorkspaceCalendar,
};
use myoxus_domain::repositories::CalendarRepository;
use myoxus_infrastructure::calendar::SqlxCalendarRepository;

async fn setup_pool() -> PgPool {
  let database_url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus:myoxus@localhost:5432/myoxus".to_string());
  let pool = PgPool::connect(&database_url)
    .await
    .expect("postgres must be reachable for calendar model tests");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrations must succeed");
  pool
}

#[tokio::test]
async fn calendar_domain_model_persists_events_participants_and_reminders() {
  let pool = setup_pool().await;
  let repo = SqlxCalendarRepository::new(pool.clone());

  let user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  let account_id = Uuid::new_v4();
  let subscription_id = Uuid::new_v4();
  let event_id = Uuid::new_v4();
  let now = Utc::now();

  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(format!("calendar-{user_id}@example.test"))
    .bind("Calendar User")
    .execute(&pool)
    .await
    .expect("seed user");

  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
    .bind(workspace_id)
    .bind(user_id)
    .bind("Calendar WS")
    .execute(&pool)
    .await
    .expect("seed workspace");

  sqlx::query(
        "INSERT INTO docs (id, workspace_id, title, is_workspace_root, created_by, updated_by) VALUES ($1, $2, $3, false, $4, $4)",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind("Calendar Source")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("seed source doc");

  let account = repo
    .upsert_calendar_account(&CalendarAccount {
      id: account_id,
      user_id,
      provider: "google".to_string(),
      remote_account_id: "acc-1".to_string(),
      access_token_ciphertext: Some("enc-access".to_string()),
      refresh_token_ciphertext: Some("enc-refresh".to_string()),
      expires_at: Some(now + Duration::hours(1)),
      config: serde_json::json!({"timezone":"Europe/Berlin"}),
      created_at: now,
      updated_at: now,
    })
    .await
    .expect("upsert account");

  repo
    .upsert_calendar_subscription(&CalendarSubscription {
      id: subscription_id,
      account_id: account.id,
      remote_calendar_id: "primary".to_string(),
      webhook_channel: Some("chan-1".to_string()),
      webhook_channel_json: None,
      sync_token: Some("sync-1".to_string()),
      updated_at: now,
    })
    .await
    .expect("upsert subscription");

  repo
    .upsert_workspace_calendar(&WorkspaceCalendar {
      workspace_id,
      account_id: account.id,
      remote_calendar_id: "primary".to_string(),
      enabled: true,
      updated_at: now,
    })
    .await
    .expect("upsert workspace calendar");

  repo
    .upsert_calendar_event(&CalendarEvent {
      id: event_id,
      origin: myoxus_domain::entities::CalendarEventOrigin::External,
      account_id: Some(account.id),
      workspace_id: Some(workspace_id),
      remote_event_id: Some("ev-1".to_string()),
      starts_at: now + Duration::hours(2),
      ends_at: now + Duration::hours(3),
      title: Some("Standup".to_string()),
      description: None,
      description_delta: None,
      location: None,
      source_doc_id: Some(doc_id),
      all_day: false,
      all_members: false,
      tag_id: None,
      recurrence_parent_id: None,
      participants: vec![],
      reminders: vec![],
      payload: serde_json::json!({"provider":"google"}),
      updated_at: now,
      etag: None,
      remote_href: None,
    })
    .await
    .expect("upsert event");

  let participants = vec![
    CalendarEventParticipant {
      id: Uuid::new_v4(),
      event_id,
      user_id: Some(user_id),
      email: "calendar-owner@example.test".to_string(),
      display_name: Some("Owner".to_string()),
      response_status: "accepted".to_string(),
      is_organizer: true,
      created_at: now,
      updated_at: now,
    },
    CalendarEventParticipant {
      id: Uuid::new_v4(),
      event_id,
      user_id: None,
      email: "guest@example.test".to_string(),
      display_name: Some("Guest".to_string()),
      response_status: "needsAction".to_string(),
      is_organizer: false,
      created_at: now,
      updated_at: now,
    },
  ];
  repo
    .replace_calendar_event_participants(event_id, &participants)
    .await
    .expect("replace participants");

  let reminders = vec![
    CalendarReminder {
      id: Uuid::new_v4(),
      event_id,
      channel: "in_app".to_string(),
      minutes_before: 30,
      scheduled_for: now + Duration::hours(1) + Duration::minutes(30),
      delivered_at: None,
      created_at: now,
      updated_at: now,
    },
    CalendarReminder {
      id: Uuid::new_v4(),
      event_id,
      channel: "email".to_string(),
      minutes_before: 10,
      scheduled_for: now + Duration::hours(1) + Duration::minutes(50),
      delivered_at: None,
      created_at: now,
      updated_at: now,
    },
  ];
  repo
    .replace_calendar_event_reminders(event_id, &reminders)
    .await
    .expect("replace reminders");

  let events = repo
    .list_workspace_events(workspace_id, now + Duration::hours(1), now + Duration::hours(4))
    .await
    .expect("list workspace events");

  assert_eq!(events.len(), 1);
  assert_eq!(events[0].id, event_id);
  assert_eq!(events[0].source_doc_id, Some(doc_id));
  assert_eq!(events[0].participants.len(), 2);
  assert_eq!(events[0].reminders.len(), 2);
  assert_eq!(events[0].participants[0].response_status, "accepted");
  assert_eq!(events[0].reminders[0].channel, "in_app");

  // Scoped cleanup — only remove data this test created
  sqlx::query("DELETE FROM calendar_reminders WHERE event_id = $1")
    .bind(event_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_event_participants WHERE event_id = $1")
    .bind(event_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_events WHERE id = $1")
    .bind(event_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_calendars WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_subscriptions WHERE id = $1")
    .bind(subscription_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_accounts WHERE id = $1")
    .bind(account_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}
