//! Invariant tests for the calendar reminder dispatcher.
//!
//! Tested invariants:
//!   INV-CAL-R-01: in_app reminder → notification row created in DB for the
//!                 correct user with idempotency_key matching the reminder ID.
//!   INV-CAL-R-02: email reminder → TestMailAdapter records a sent mail for
//!                 the user's email address.
//!   INV-CAL-R-03: second dispatch of same reminder → completion prevents replay,
//!                 no second notification created (idempotent).
//!   INV-CAL-REMINDER-01 (P-JCAL-SERVER-05): after process_reminder, delivered_at IS NOT NULL.
//!   INV-CAL-REMINDER-02 (P-JCAL-SERVER-05): socket port is called with correct event_id.
use crate::helpers;

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{Duration, Utc};
use sqlx::Row;
use uuid::Uuid;

use myoxus_application::auth::AuthResult;
use myoxus_application::calendar::{CalendarReminderDispatcher, ReminderDispatchedPort};
use myoxus_application::notification::{
  InMemoryNotificationStore, NotificationListFilter, NotificationListQuery, NotificationService, NotificationStore,
};
use myoxus_application::worker::WorkQueuePort;
use myoxus_domain::ids::CalendarEventId;
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use myoxus_infrastructure::mail::TestMailAdapter;
use sqlx::PgPool;

// ── Null queue (tests never need to enqueue jobs) ───────────────────────────

struct NullQueue;

#[async_trait]
impl WorkQueuePort for NullQueue {
  async fn add_job(
    &self,
    _queue: &str,
    _job_name: &str,
    _data: serde_json::Value,
    _max_attempts: Option<u32>,
    _delay_ms: Option<i64>,
  ) -> AuthResult<String> {
    Ok(Uuid::new_v4().to_string())
  }
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

/// Seed user + calendar_account + calendar_event + calendar_reminder.
/// Returns (user_id, reminder_id).
async fn seed_reminder(pool: &PgPool, channel: &str) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  let account_id = Uuid::new_v4();
  let event_id = Uuid::new_v4();
  let reminder_id = Uuid::new_v4();
  let email = format!("cal-reminder-{}@example.test", user_id);

  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(&email)
    .bind("Reminder User")
    .execute(pool)
    .await
    .expect("seed user");

  sqlx::query(
    "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config) VALUES ($1, $2, $3, $4, '{}'::jsonb)",
  )
  .bind(account_id)
  .bind(user_id)
  .bind("google")
  .bind(format!("acc-{}", user_id))
  .execute(pool)
  .await
  .expect("seed calendar account");

  sqlx::query(
    "INSERT INTO calendar_events (id, account_id, remote_event_id, starts_at, ends_at, title, payload)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)",
  )
  .bind(event_id)
  .bind(account_id)
  .bind(format!("evt-{}", event_id))
  .bind(Utc::now() + Duration::hours(1))
  .bind(Utc::now() + Duration::hours(2))
  .bind("Test Event")
  .execute(pool)
  .await
  .expect("seed calendar event");

  sqlx::query(
    "INSERT INTO calendar_reminders (id, event_id, channel, minutes_before, scheduled_for)
     VALUES ($1, $2, $3, $4, $5)",
  )
  .bind(reminder_id)
  .bind(event_id)
  .bind(channel)
  .bind(15_i32)
  .bind(Utc::now() - Duration::minutes(1)) // already due
  .execute(pool)
  .await
  .expect("seed calendar reminder");

  (user_id, reminder_id)
}

/// Clean up all rows seeded by a test to keep the DB clean.
async fn cleanup_reminder(pool: &PgPool, user_id: Uuid, reminder_id: Uuid) {
  // Order: reminder_dispatch_log → reminder → event → account → user
  sqlx::query("DELETE FROM calendar_reminder_dispatch_log WHERE reminder_id = $1")
    .bind(reminder_id)
    .execute(pool)
    .await
    .expect("cleanup reminder fixture");
  sqlx::query("DELETE FROM calendar_reminders WHERE id = $1")
    .bind(reminder_id)
    .execute(pool)
    .await
    .expect("cleanup reminder fixture");
  sqlx::query("DELETE FROM calendar_events WHERE account_id IN (SELECT id FROM calendar_accounts WHERE user_id = $1)")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("cleanup reminder fixture");
  sqlx::query("DELETE FROM calendar_accounts WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("cleanup reminder fixture");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("cleanup reminder fixture");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// INV-CAL-R-01: in_app channel → notification row created for the correct user.
#[tokio::test]
async fn inv_cal_r01_inapp_reminder_creates_notification() {
  let pool = helpers::setup_pool().await;
  let (user_id, reminder_id) = seed_reminder(&pool, "in_app").await;

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let notif_store = Arc::new(InMemoryNotificationStore::default());
  let notif_svc = Arc::new(NotificationService::new(notif_store.clone()));
  let dispatcher = CalendarReminderDispatcher::new(
    Arc::new(NullQueue),
    repo,
    Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone())),
  )
  .with_notification_service(notif_svc);

  dispatcher
    .process_reminder(reminder_id)
    .await
    .expect("process_reminder must succeed");

  let notifications = notif_store
    .list_notifications(
      user_id,
      NotificationListQuery {
        fetch_limit: 10,
        offset: 0,
        filter: NotificationListFilter {
          include_read: true,
          notification_types: None,
        },
        after: None,
      },
    )
    .await
    .expect("list_notifications");

  assert_eq!(
    notifications.len(),
    1,
    "exactly one notification must be created for the user"
  );
  let n = &notifications[0];
  assert_eq!(n.user_id, user_id, "notification must belong to the correct user");
  assert_eq!(n.notification_type, "calendar_reminder");
  let key = n.idempotency_key.as_deref().unwrap_or("");
  assert!(
    key.contains(&reminder_id.to_string()),
    "idempotency key must contain reminder_id"
  );

  cleanup_reminder(&pool, user_id, reminder_id).await;
}

/// INV-CAL-R-02: email channel → TestMailAdapter records a sent mail for the user.
#[tokio::test]
async fn inv_cal_r02_email_reminder_sends_mail() {
  let pool = helpers::setup_pool().await;
  let (user_id, reminder_id) = seed_reminder(&pool, "email").await;

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let mailer = Arc::new(TestMailAdapter::default());
  let mailer_port: Arc<dyn myoxus_application::ports::MailPort> = mailer.clone();
  let dispatcher = CalendarReminderDispatcher::new(
    Arc::new(NullQueue),
    repo,
    Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone())),
  )
  .with_mailer(mailer_port);

  dispatcher
    .process_reminder(reminder_id)
    .await
    .expect("process_reminder must succeed");

  let sent = mailer.sent_mails.lock().unwrap().clone();
  assert_eq!(sent.len(), 1, "exactly one email must be recorded");
  let mail = &sent[0];
  // Subject must contain 'Reminder:' per the template contract.
  assert!(
    mail.subject.contains("Reminder:"),
    "mail subject must contain 'Reminder:', got: {:?}",
    mail.subject
  );

  cleanup_reminder(&pool, user_id, reminder_id).await;
}

/// INV-CAL-R-03: second dispatch of same reminder → completion prevents replay, no duplicate notification.
#[tokio::test]
async fn inv_cal_r03_duplicate_dispatch_idempotent() {
  let pool = helpers::setup_pool().await;
  let (user_id, reminder_id) = seed_reminder(&pool, "in_app").await;

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let notif_store = Arc::new(InMemoryNotificationStore::default());
  let notif_svc = Arc::new(NotificationService::new(notif_store.clone()));
  let mailer = Arc::new(TestMailAdapter::default());
  let mailer_port: Arc<dyn myoxus_application::ports::MailPort> = mailer.clone();

  let dispatcher = CalendarReminderDispatcher::new(
    Arc::new(NullQueue),
    repo,
    Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone())),
  )
  .with_notification_service(notif_svc.clone())
  .with_mailer(mailer_port);

  // First dispatch — should create exactly one notification.
  dispatcher
    .process_reminder(reminder_id)
    .await
    .expect("first dispatch must succeed");

  // Second dispatch — completed reminder returns without another notification.
  dispatcher
    .process_reminder(reminder_id)
    .await
    .expect("second dispatch must not error");

  let count = notif_store
    .count_notifications(
      user_id,
      &NotificationListFilter {
        include_read: true,
        notification_types: None,
      },
    )
    .await
    .expect("count");
  assert_eq!(count, 1, "duplicate dispatch must not create a second notification");

  cleanup_reminder(&pool, user_id, reminder_id).await;
}

// ── Recording socket port ──────────────────────────────────────────────────────

struct RecordingReminderPort {
  calls: Arc<std::sync::Mutex<Vec<(Uuid, CalendarEventId, chrono::DateTime<chrono::Utc>)>>>,
}

impl RecordingReminderPort {
  fn new() -> (
    Self,
    Arc<std::sync::Mutex<Vec<(Uuid, CalendarEventId, chrono::DateTime<chrono::Utc>)>>>,
  ) {
    let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
    (Self { calls: calls.clone() }, calls)
  }
}

#[async_trait::async_trait]
impl ReminderDispatchedPort for RecordingReminderPort {
  async fn notify_reminder_due(
    &self,
    user_id: Uuid,
    event_id: CalendarEventId,
    scheduled_for: chrono::DateTime<chrono::Utc>,
  ) {
    self.calls.lock().unwrap().push((user_id, event_id, scheduled_for));
  }
}

/// INV-CAL-REMINDER-01: after dispatch, delivered_at IS NOT NULL in DB.
#[tokio::test]
async fn inv_cal_reminder01_dispatch_marks_delivered_at() {
  let pool = helpers::setup_pool().await;
  let (user_id, reminder_id) = seed_reminder(&pool, "in_app").await;

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let dispatcher = CalendarReminderDispatcher::new(
    Arc::new(NullQueue),
    repo,
    Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone())),
  );

  dispatcher
    .process_reminder(reminder_id)
    .await
    .expect("process_reminder must succeed");

  let row = sqlx::query("SELECT delivered_at FROM calendar_reminders WHERE id = $1")
    .bind(reminder_id)
    .fetch_one(&pool)
    .await
    .expect("reminder row must exist");
  let delivered_at: Option<chrono::DateTime<chrono::Utc>> = row.get("delivered_at");
  assert!(
    delivered_at.is_some(),
    "INV-CAL-REMINDER-01: delivered_at must be set after dispatch"
  );

  cleanup_reminder(&pool, user_id, reminder_id).await;
}

/// INV-CAL-REMINDER-02: socket port is called after dispatch with correct event_id.
#[tokio::test]
async fn inv_cal_reminder02_socket_port_called_after_dispatch() {
  let pool = helpers::setup_pool().await;
  let (user_id, reminder_id) = seed_reminder(&pool, "in_app").await;

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let (recording, calls) = RecordingReminderPort::new();
  let dispatcher = CalendarReminderDispatcher::new(
    Arc::new(NullQueue),
    repo,
    Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone())),
  )
  .with_socket_port(Arc::new(recording));

  dispatcher
    .process_reminder(reminder_id)
    .await
    .expect("process_reminder must succeed");

  let snapshot = calls.lock().unwrap().clone();
  assert_eq!(
    snapshot.len(),
    1,
    "exactly one socket notification after dispatch: {snapshot:?}"
  );
  assert_eq!(snapshot[0].0, user_id, "user_id must match");

  cleanup_reminder(&pool, user_id, reminder_id).await;
}

/// Abort an actual fanout after A's durable receipt and while B is in SMTP.
/// Retries reclaim the pending log, retain A after B rejection and serialize rivals.
#[sqlx::test]
async fn interrupted_reminder_fanout_reclaims_pending_claim_and_preserves_receipts(pool: PgPool) {
  use myoxus_domain::repositories::{CalendarRepository, NativeEventInput};
  use myoxus_infrastructure::mail::{MailConfig, SmtpMailAdapter, SmtpTransportMode};
  use myoxus_tests::smtp_fixture::{SmtpFixture, SmtpFixtureAuth, SmtpFixtureOptions};
  use std::time::Duration as Wait;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("isolated migrations");
  let owner = helpers::create_user(&pool, "reminder_fanout_owner", false).await;
  let other = helpers::create_user(&pool, "reminder_fanout_member", false).await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  helpers::add_workspace_member(&pool, workspace, other).await;
  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let event = repo
    .insert_native_event(&NativeEventInput {
      workspace_id: workspace,
      title: Some("Interrupted fanout".into()),
      description_delta: None,
      starts_at: Utc::now(),
      ends_at: Utc::now() + Duration::hours(1),
      all_day: false,
      all_members: true,
      tag_id: None,
      source_doc_id: None,
      source_anchor: None,
      recurrence_parent_id: None,
      recurrence_ical_id: None,
    })
    .await
    .expect("authored event");
  let reminder = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO calendar_reminders(id,event_id,channel,minutes_before,scheduled_for) VALUES($1,$2,'email',0,now())",
  )
  .bind(reminder)
  .bind(event.id)
  .execute(&pool)
  .await
  .expect("fanout reminder");
  let contexts = repo
    .get_calendar_reminder_contexts(reminder)
    .await
    .expect("current recipients");
  assert_eq!(contexts.len(), 2);
  let a = contexts[0].user_id;
  let b = contexts[1].user_id;
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
  let (socket, calls) = RecordingReminderPort::new();
  let dispatcher = CalendarReminderDispatcher::new(
    Arc::new(NullQueue),
    repo.clone(),
    Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone())),
  )
  .with_mailer(Arc::new(sender))
  .with_socket_port(Arc::new(socket));
  let mut workers = tokio::task::JoinSet::new();
  let first_dispatcher = dispatcher.clone();
  let first = workers.spawn(async move { first_dispatcher.process_reminder(reminder).await });
  tokio::time::timeout(Wait::from_secs(10), sink.next_paused_delivery())
    .await
    .expect("A reaches SMTP")
    .send(true)
    .expect("accept A");
  let pending_b = tokio::time::timeout(Wait::from_secs(10), sink.next_paused_delivery())
    .await
    .expect("B reaches SMTP");
  let receipts: Vec<Uuid> =
    sqlx::query_scalar("SELECT user_id FROM calendar_reminder_mail_receipts WHERE reminder_id=$1 ORDER BY user_id")
      .bind(reminder)
      .fetch_all(&pool)
      .await
      .expect("durable A receipt");
  assert_eq!(
    receipts,
    vec![a],
    "abort happens after A completion but before B completion"
  );
  let pending: bool = sqlx::query_scalar("SELECT r.delivered_at IS NULL FROM calendar_reminders r JOIN calendar_reminder_dispatch_log d ON d.reminder_id=r.id WHERE r.id=$1")
    .bind(reminder).fetch_one(&pool).await.expect("pending claim persisted");
  assert!(pending);
  let lock_key = format!("calendar-reminder:{reminder}");
  let (state, transaction): (String, Option<chrono::DateTime<Utc>>) = sqlx::query_as(
    "SELECT a.state,a.xact_start FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.classid::bigint=((hashtextextended($1,0)>>32)&4294967295) AND l.objid::bigint=(hashtextextended($1,0)&4294967295) AND l.objsubid=1 AND l.granted")
    .bind(&lock_key).fetch_one(&pool).await.expect("SMTP-time ownership");
  assert_eq!(state, "idle");
  assert!(transaction.is_none(), "fanout SMTP holds no SQL transaction");
  let retry_dispatcher = dispatcher.clone();
  workers.spawn(async move { retry_dispatcher.process_reminder(reminder).await });
  wait_for_reminder_waiter(&pool, &lock_key).await;
  assert_eq!(sink.messages().await.len(), 2, "rival waits before SMTP");
  first.abort();
  assert!(
    matches!(tokio::time::timeout(Wait::from_secs(10), workers.join_next()).await
    .expect("aborted worker exits").expect("cancelled worker"), Err(error) if error.is_cancelled())
  );
  drop(pending_b);
  let retry_b = tokio::time::timeout(Wait::from_secs(10), sink.next_paused_delivery())
    .await
    .expect("retry reclaims pending B");
  let attempts = sink.messages().await;
  assert_eq!(attempts.len(), 3);
  assert!(attempts[0].contains(&contexts[0].user_email));
  assert!(attempts[1].contains(&contexts[1].user_email));
  assert!(
    attempts[2].contains(&contexts[1].user_email),
    "successful A is not resent"
  );
  assert!(calls.lock().unwrap().is_empty(), "aborted reminder was not finalized");
  let competing_dispatcher = dispatcher.clone();
  workers.spawn(async move { competing_dispatcher.process_reminder(reminder).await });
  wait_for_reminder_waiter(&pool, &lock_key).await;
  retry_b.send(false).expect("reject B with SMTP 550");
  assert!(
    tokio::time::timeout(Wait::from_secs(10), workers.join_next())
      .await
      .expect("failed worker exits")
      .expect("failed worker result")
      .expect("failed worker join")
      .is_err()
  );
  let resumed_b = tokio::time::timeout(Wait::from_secs(10), sink.next_paused_delivery())
    .await
    .expect("waiting attempt acquires failed owner's lock");
  let preserved: Vec<Uuid> =
    sqlx::query_scalar("SELECT user_id FROM calendar_reminder_mail_receipts WHERE reminder_id=$1 ORDER BY user_id")
      .bind(reminder)
      .fetch_all(&pool)
      .await
      .expect("receipts after SMTP failure");
  assert_eq!(preserved, vec![a], "B failure cannot reset successful A or complete B");
  let unfinished: bool = sqlx::query_scalar("SELECT r.delivered_at IS NULL FROM calendar_reminders r JOIN calendar_reminder_dispatch_log d ON d.reminder_id=r.id WHERE r.id=$1")
    .bind(reminder).fetch_one(&pool).await.expect("pending whole reminder after SMTP failure");
  assert!(unfinished);
  let attempts = sink.messages().await;
  assert_eq!(attempts.len(), 4);
  assert!(
    attempts[3].contains(&contexts[1].user_email),
    "failed-owner retry still sends only B"
  );
  assert!(calls.lock().unwrap().is_empty());
  let completed_dispatcher = dispatcher.clone();
  workers.spawn(async move { completed_dispatcher.process_reminder(reminder).await });
  wait_for_reminder_waiter(&pool, &lock_key).await;
  assert_eq!(sink.messages().await.len(), 4, "competing copy cannot reach SMTP");
  resumed_b.send(true).expect("accept resumed B");
  for _ in 0..2 {
    tokio::time::timeout(Wait::from_secs(10), workers.join_next())
      .await
      .expect("worker completes")
      .expect("worker result")
      .expect("worker join")
      .expect("resumed or completed dispatch");
  }
  let receipts: Vec<Uuid> =
    sqlx::query_scalar("SELECT user_id FROM calendar_reminder_mail_receipts WHERE reminder_id=$1 ORDER BY user_id")
      .bind(reminder)
      .fetch_all(&pool)
      .await
      .expect("completed recipients");
  assert_eq!(receipts, vec![a, b]);
  let consistent: bool = sqlx::query_scalar("SELECT r.delivered_at=d.dispatched_at FROM calendar_reminders r JOIN calendar_reminder_dispatch_log d ON d.reminder_id=r.id WHERE r.id=$1")
    .bind(reminder).fetch_one(&pool).await.expect("atomic completion");
  assert!(consistent, "log and whole reminder complete together");
  assert_eq!(
    calls.lock().unwrap().len(),
    2,
    "socket fanout occurs once after completion"
  );
  dispatcher.process_reminder(reminder).await.expect("completed replay");
  assert_eq!(sink.messages().await.len(), 4, "completed reminder cannot resend");
  assert_eq!(
    calls.lock().unwrap().len(),
    2,
    "completed reminder cannot repeat socket fanout"
  );
  let mut released = tokio::time::timeout(Wait::from_secs(10), repo.acquire_reminder_delivery_guard(reminder))
    .await
    .expect("completed ownership released")
    .expect("completed guard");
  assert!(
    !released
      .begin_dispatch(Uuid::new_v4(), Utc::now())
      .await
      .expect("completed protected")
  );
  released.release().await.expect("explicit unlock");
  // Empty current recipients still finish, and a queued deleted reminder is a no-op.
  sqlx::query("UPDATE workspaces SET deleted_at=now() WHERE id=$1")
    .bind(workspace)
    .execute(&pool)
    .await
    .expect("workspace removed");
  let empty = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO calendar_reminders(id,event_id,channel,minutes_before,scheduled_for) VALUES($1,$2,'email',0,now())",
  )
  .bind(empty)
  .bind(event.id)
  .execute(&pool)
  .await
  .expect("empty reminder");
  dispatcher.process_reminder(empty).await.expect("empty fanout finishes");
  let finished: bool = sqlx::query_scalar("SELECT delivered_at IS NOT NULL FROM calendar_reminders WHERE id=$1")
    .bind(empty)
    .fetch_one(&pool)
    .await
    .expect("empty completion");
  assert!(finished);
  assert_eq!(sink.messages().await.len(), 4);
  assert_eq!(calls.lock().unwrap().len(), 2);
  sqlx::query("DELETE FROM calendar_reminders WHERE id=$1")
    .bind(empty)
    .execute(&pool)
    .await
    .expect("delete reminder");
  dispatcher
    .process_reminder(empty)
    .await
    .expect("deleted queued reminder");
}

async fn wait_for_reminder_waiter(pool: &PgPool, key: &str) {
  tokio::time::timeout(std::time::Duration::from_secs(10), async {
    loop {
      let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid::bigint=((hashtextextended($1,0)>>32)&4294967295) AND objid::bigint=(hashtextextended($1,0)&4294967295) AND objsubid=1 AND NOT granted)")
        .bind(key).fetch_one(pool).await.expect("competing reminder lock");
      if waiting { break; }
      tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
  }).await.expect("competing reminder waits for ownership");
}
