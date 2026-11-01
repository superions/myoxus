// SPDX-License-Identifier: AGPL-3.0-or-later
//! Calendar writeback processor integration coverage.
//!
//! The journey covers ordinary live-event dispatch, durable delete failure and
//! restart, atomic intent rollback, and serialization of an in-flight update
//! against final deletion.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use tokio::sync::Notify;
use uuid::Uuid;

use myoxus_application::calendar::CalendarService;
use myoxus_application::ports::{
  PortError, PortResult, RemoteCalendarWritePort, RemoteCreateResult, RemoteEventInput, RemoteUpdateResult,
};
use myoxus_domain::entities::{CalendarDeleteSnapshot, CalendarPendingWrite};
use myoxus_domain::repositories::CalendarRepository;
use myoxus_infrastructure::calendar::SqlxCalendarRepository;

// ── Recording write port ───────────────────────────────────────────────────────

struct RecordingWritePort {
  calls: Arc<Mutex<Vec<String>>>,
  delete_failures: Mutex<VecDeque<PortError>>,
}

impl RecordingWritePort {
  fn new(delete_failures: impl IntoIterator<Item = PortError>) -> (Self, Arc<Mutex<Vec<String>>>) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    (
      Self {
        calls: calls.clone(),
        delete_failures: Mutex::new(delete_failures.into_iter().collect()),
      },
      calls,
    )
  }
}

#[async_trait]
impl RemoteCalendarWritePort for RecordingWritePort {
  async fn create_event(&self, input: &RemoteEventInput) -> PortResult<RemoteCreateResult> {
    self
      .calls
      .lock()
      .unwrap()
      .push(format!("create:{}:{}", input.account_id, input.calendar_id));
    Ok(RemoteCreateResult {
      remote_href: format!("{}/{}.ics", input.calendar_id.trim_end_matches('/'), input.uid),
      etag: Some("mock-etag".to_string()),
      remote_event_id: Some(input.uid.clone()),
    })
  }

  async fn update_event(
    &self,
    remote_href: &str,
    _etag: &str,
    input: &RemoteEventInput,
  ) -> PortResult<RemoteUpdateResult> {
    self
      .calls
      .lock()
      .unwrap()
      .push(format!("update:{}:{}", input.account_id, remote_href));
    Ok(RemoteUpdateResult { etag: None })
  }

  async fn delete_event(&self, remote_href: &str, etag: &str, input: &RemoteEventInput) -> PortResult<()> {
    self
      .calls
      .lock()
      .unwrap()
      .push(format!("delete:{}:{remote_href}:{etag}", input.account_id));
    self.delete_failures.lock().unwrap().pop_front().map_or(Ok(()), Err)
  }
}

struct BlockingUpdatePort {
  calls: Arc<Mutex<Vec<String>>>,
  update_started: Arc<Notify>,
  release_update: Arc<Notify>,
}

#[async_trait]
impl RemoteCalendarWritePort for BlockingUpdatePort {
  async fn create_event(&self, _input: &RemoteEventInput) -> PortResult<RemoteCreateResult> {
    unreachable!("race fixture starts with an existing remote event")
  }

  async fn update_event(
    &self,
    remote_href: &str,
    etag: &str,
    _input: &RemoteEventInput,
  ) -> PortResult<RemoteUpdateResult> {
    self
      .calls
      .lock()
      .unwrap()
      .push(format!("update-start:{remote_href}:{etag}"));
    self.update_started.notify_one();
    self.release_update.notified().await;
    self.calls.lock().unwrap().push("update-finish".to_string());
    Ok(RemoteUpdateResult {
      etag: Some("etag-after-update".to_string()),
    })
  }

  async fn delete_event(&self, remote_href: &str, etag: &str, _input: &RemoteEventInput) -> PortResult<()> {
    self.calls.lock().unwrap().push(format!("delete:{remote_href}:{etag}"));
    Ok(())
  }
}

// ── Test ───────────────────────────────────────────────────────────────────────

/// INV-CAL-WRITEBACK-01 (end-to-end): execute_pending_write calls the write
/// port with the correct account_id and calendar_id from workspace settings.
#[tokio::test]
async fn inv_caldav_writeback01_execute_pending_write_calls_port() {
  let url = match std::env::var("TEST_DATABASE_URL") {
    Ok(u) => u,
    Err(_) => return,
  };
  let pool = sqlx::PgPool::connect(&url).await.expect("connect");
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrations");

  let user_id = Uuid::new_v4();
  let ws_id = Uuid::new_v4();
  let account_id = Uuid::new_v4();
  let sub_id = Uuid::new_v4();
  let event_id = Uuid::new_v4();
  let now = Utc::now();

  // Seed user + workspace + calendar infra.
  sqlx::query("INSERT INTO users (id, name, email) VALUES ($1, 'wb-proc', $2)")
    .bind(user_id)
    .bind(format!("wbp-{user_id}@test.local"))
    .execute(&pool)
    .await
    .expect("seed user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'wbp-ws')")
    .bind(ws_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("seed workspace");
  sqlx::query(
    "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config)
     VALUES ($1, $2, 'caldav', $3, '{}'::jsonb)",
  )
  .bind(account_id)
  .bind(user_id)
  .bind(format!("wbp-acc-{user_id}"))
  .execute(&pool)
  .await
  .expect("seed account");
  sqlx::query(
    "INSERT INTO calendar_subscriptions (id, account_id, remote_calendar_id)
     VALUES ($1, $2, 'http://caldav.example/cal/')",
  )
  .bind(sub_id)
  .bind(account_id)
  .execute(&pool)
  .await
  .expect("seed subscription");
  sqlx::query(
    "INSERT INTO workspace_calendar_settings (workspace_id, writeback_subscription_id, updated_at)
     VALUES ($1, $2, NOW())",
  )
  .bind(ws_id)
  .bind(sub_id)
  .execute(&pool)
  .await
  .expect("seed settings");

  // Native event (origin='native', workspace_id set, no account_id).
  sqlx::query(
    "INSERT INTO calendar_events
     (id, origin, workspace_id, starts_at, ends_at, title, payload, updated_at)
     VALUES ($1, 'native', $2, $3, $4, 'WB Test', '{}'::jsonb, $5)",
  )
  .bind(event_id)
  .bind(ws_id)
  .bind(now + chrono::Duration::hours(1))
  .bind(now + chrono::Duration::hours(2))
  .bind(now)
  .execute(&pool)
  .await
  .expect("seed native event");

  // Manually insert a pending write row.
  let pending_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO calendar_pending_writes (id, event_id, operation, next_retry_at)
     VALUES ($1, $2, 'create', NOW())",
  )
  .bind(pending_id)
  .bind(event_id)
  .execute(&pool)
  .await
  .expect("seed pending write");

  // Build CalendarService with the recording write port.
  let (recording_port, calls) =
    RecordingWritePort::new([PortError::Transport("isolated provider unavailable".to_string())]);
  let recording_port = Arc::new(recording_port);
  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let svc = CalendarService::new(repo.clone()).with_remote_write(recording_port.clone());

  // Fetch the pending write and execute it.
  use sqlx::Row as _;
  let row = sqlx::query(
    "SELECT id, event_id, operation, payload, created_at, retry_count, next_retry_at, last_error
     FROM calendar_pending_writes WHERE id = $1",
  )
  .bind(pending_id)
  .fetch_one(&pool)
  .await
  .expect("fetch pending write");

  let write = CalendarPendingWrite {
    id: row.get("id"),
    event_id: row.get("event_id"),
    operation: row.get("operation"),
    payload: row.get("payload"),
    created_at: row.get("created_at"),
    retry_count: row.get("retry_count"),
    next_retry_at: row.get("next_retry_at"),
    last_error: row.get("last_error"),
  };

  svc
    .execute_pending_write(&write)
    .await
    .expect("execute_pending_write must succeed");

  let snapshot = calls.lock().unwrap().clone();
  assert_eq!(
    snapshot.len(),
    1,
    "write port must be called exactly once: {snapshot:?}"
  );
  assert!(
    snapshot[0].starts_with("create:"),
    "INV-CAL-WRITEBACK-01: port must receive create call, got: {:?}",
    snapshot[0]
  );
  assert!(
    snapshot[0].contains(&account_id.to_string()),
    "port call must use the correct account_id"
  );
  assert!(
    snapshot[0].contains("http://caldav.example/cal/"),
    "port call must use the correct calendar_id"
  );

  svc
    .delete_remote_event(event_id)
    .await
    .expect("durable local delete succeeds while provider is unavailable");
  let event_id_string = event_id.to_string();
  let detached_id: Uuid = sqlx::query_scalar(
    "SELECT id FROM calendar_pending_writes
     WHERE operation = 'delete' AND payload->>'sourceEventId' = $1
     ORDER BY created_at DESC LIMIT 1",
  )
  .bind(&event_id_string)
  .fetch_one(&pool)
  .await
  .expect("find retained delete intent by source identity");
  let detached = repo
    .get_pending_write(detached_id)
    .await
    .expect("read retained delete intent")
    .expect("failed provider delete must retain its detached intent");
  assert_eq!(detached.event_id, None);
  assert_eq!(detached.retry_count, 1);
  let delete_snapshot: CalendarDeleteSnapshot = serde_json::from_value(
    detached
      .payload
      .clone()
      .expect("detached delete carries its routing snapshot"),
  )
  .expect("deserialize detached delete snapshot");
  assert_eq!(delete_snapshot.source_event_id, event_id);
  assert_eq!(delete_snapshot.account_id, account_id);
  assert_eq!(delete_snapshot.calendar_id, "http://caldav.example/cal/");
  assert_eq!(
    delete_snapshot.remote_href,
    format!("http://caldav.example/cal/{event_id}.ics")
  );
  assert_eq!(delete_snapshot.etag, "mock-etag");
  assert!(
    repo
      .get_calendar_event(event_id)
      .await
      .expect("read deleted event")
      .is_none(),
    "local event must be absent while its detached intent survives"
  );
  let restarted = CalendarService::new(repo.clone()).with_remote_write(recording_port);
  restarted
    .execute_pending_write(&detached)
    .await
    .expect("restarted executor must replay the retained delete");
  assert!(
    repo
      .get_pending_write(detached.id)
      .await
      .expect("read acknowledged delete")
      .is_none(),
    "successful replay must acknowledge the detached intent"
  );
  let calls = calls.lock().unwrap().clone();
  assert_eq!(calls.len(), 3, "create, failed delete and replayed delete must execute");
  assert_eq!(
    calls[1],
    format!("delete:{account_id}:http://caldav.example/cal/{event_id}.ics:mock-etag")
  );
  assert_eq!(calls[2], calls[1], "replay must preserve the exact routing and ETag");

  let missing_event_id = Uuid::new_v4();
  let rejected_snapshot = CalendarDeleteSnapshot {
    schema_version: CalendarDeleteSnapshot::SCHEMA_VERSION,
    source_event_id: missing_event_id,
    provider: "caldav".to_string(),
    account_id,
    calendar_id: "http://caldav.example/cal/".to_string(),
    remote_href: "http://caldav.example/cal/missing.ics".to_string(),
    remote_uid: "missing".to_string(),
    etag: "missing-etag".to_string(),
  };
  repo
    .detach_delete_intent_and_delete_event(missing_event_id, &rejected_snapshot)
    .await
    .expect_err("failed local deletion must roll back the inserted intent");
  let rejected_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM calendar_pending_writes WHERE payload->>'sourceEventId' = $1")
      .bind(missing_event_id.to_string())
      .fetch_one(&pool)
      .await
      .expect("count rolled-back delete intents");
  assert_eq!(rejected_count, 0, "the atomic operation must not retain half an intent");

  let racing_event_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO calendar_events
     (id, origin, workspace_id, starts_at, ends_at, title, payload, updated_at, remote_href, etag)
     VALUES ($1, 'native', $2, $3, $4, 'Racing write', '{}'::jsonb, $5, $6, 'etag-before-update')",
  )
  .bind(racing_event_id)
  .bind(ws_id)
  .bind(now + chrono::Duration::hours(3))
  .bind(now + chrono::Duration::hours(4))
  .bind(now)
  .bind(format!("http://caldav.example/cal/{racing_event_id}.ics"))
  .execute(&pool)
  .await
  .expect("seed racing event");
  let pending_update = repo
    .enqueue_pending_write(racing_event_id, "update", None)
    .await
    .expect("enqueue racing update");
  let race_calls = Arc::new(Mutex::new(Vec::new()));
  let update_started = Arc::new(Notify::new());
  let release_update = Arc::new(Notify::new());
  let blocking_port = Arc::new(BlockingUpdatePort {
    calls: race_calls.clone(),
    update_started: update_started.clone(),
    release_update: release_update.clone(),
  });
  let worker = CalendarService::new(repo.clone()).with_remote_write(blocking_port.clone());
  let worker_task = tokio::spawn(async move { worker.execute_pending_write(&pending_update).await });
  tokio::time::timeout(Duration::from_secs(5), update_started.notified())
    .await
    .expect("racing update must reach the provider");
  let deleter = CalendarService::new(repo.clone()).with_remote_write(blocking_port);
  let delete_task = tokio::spawn(async move { deleter.delete_remote_event(racing_event_id).await });
  tokio::task::yield_now().await;
  release_update.notify_one();
  tokio::time::timeout(Duration::from_secs(5), worker_task)
    .await
    .expect("racing update must finish within its bounded provider window")
    .expect("join racing update worker")
    .expect("racing update completes before deletion");
  tokio::time::timeout(Duration::from_secs(5), delete_task)
    .await
    .expect("serialized delete must finish after the update")
    .expect("join racing delete")
    .expect("serialized delete succeeds");
  assert!(
    repo
      .get_calendar_event(racing_event_id)
      .await
      .expect("read racing event")
      .is_none(),
    "the final delete must remove the local event"
  );
  assert_eq!(
    race_calls.lock().unwrap().as_slice(),
    [
      format!("update-start:http://caldav.example/cal/{racing_event_id}.ics:etag-before-update"),
      "update-finish".to_string(),
      format!("delete:http://caldav.example/cal/{racing_event_id}.ics:etag-after-update"),
    ],
    "delete must wait for the in-flight update and use its committed ETag"
  );

  // Cleanup.
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("delete fixture workspace");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("delete fixture user");
}
