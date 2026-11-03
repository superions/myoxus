// SPDX-License-Identifier: AGPL-3.0-or-later
//! P90-CAL-C-T02 — Invariant-first integration tests: calendar event instances.
//!
//! Tests verify DB STATE after operations against calendar_event_instances.
//! Naming convention: `inv_{code}_{description}`.
//!
//! The requested-window journey exercises the consuming CalendarService;
//! remaining schema fixtures protect cancel/delete relationships.

use crate::helpers;

use std::sync::Arc;

use chrono::{Duration, Utc};
use myoxus_application::calendar::{CalendarEventUpsert, CalendarService};
use myoxus_domain::repositories::CalendarRepository;
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use sqlx::Row;
use uuid::Uuid;

// ── Shared setup helper ──────────────────────────────────────────────────────

/// Insert a calendar_account + calendar_event and return (account_id, event_id).
/// Uses a unique suffix to prevent cross-test conflicts.
async fn setup_event(pool: &sqlx::PgPool, suffix: &str) -> (Uuid, Uuid) {
  let user_id = helpers::create_user(pool, &format!("ci-{suffix}"), false).await;

  let account_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_accounts (user_id, provider, remote_account_id, config)
     VALUES ($1, 'caldav', $2, '{}'::jsonb)
     RETURNING id",
  )
  .bind(user_id)
  .bind(format!("ci-acc-{suffix}-{}", Uuid::new_v4()))
  .fetch_one(pool)
  .await
  .expect("insert calendar_account");

  let event_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_events (account_id, remote_event_id, starts_at, ends_at, updated_at)
     VALUES ($1, $2, now(), now() + interval '1 hour', now())
     RETURNING id",
  )
  .bind(account_id)
  .bind(format!("ci-evt-{suffix}-{}", Uuid::new_v4()))
  .fetch_one(pool)
  .await
  .expect("insert calendar_event");

  (account_id, event_id)
}

async fn teardown_account(pool: &sqlx::PgPool, account_id: Uuid) {
  // CASCADE from calendar_accounts covers events + instances.
  sqlx::query("DELETE FROM calendar_accounts WHERE id = $1")
    .bind(account_id)
    .execute(pool)
    .await
    .expect("remove Calendar account/event/instance fixtures");
}

// ---------------------------------------------------------------------------
// A later requested window must project a continuing source without replacing
// existing identities/exceptions or erasing a previously requested window.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_inst01_create_and_list_instance() {
  let pool = helpers::setup_pool().await;
  let (account_id, event_id) = setup_event(&pool, "inst01").await;

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let user: Uuid = sqlx::query_scalar("SELECT user_id FROM calendar_accounts WHERE id=$1")
    .bind(account_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let workspace = helpers::create_workspace(&pool, user).await;
  let mut event = repo.get_calendar_event(event_id).await.unwrap().unwrap();
  event.workspace_id = Some(workspace);
  event.starts_at = "2025-03-02T08:00:00Z".parse().unwrap();
  event.ends_at = event.starts_at + Duration::hours(1);
  event.payload = serde_json::json!({"rrule":"FREQ=WEEKLY;COUNT=400","originalTimezone":"Europe/Berlin"});
  repo.upsert_calendar_event(&event).await.unwrap();
  let service = CalendarService::new(repo.clone());
  let from = "2028-03-01T00:00:00Z".parse().unwrap();
  let to = "2028-04-01T00:00:00Z".parse().unwrap();
  let initial = service.list_event_instances(event_id, from, to).await.unwrap();
  assert_eq!(initial.len(), 4, "continuing series remains visible beyond two years");
  let mut preserved = initial[0].clone();
  preserved.id = Uuid::new_v4();
  // Simulate an already deployed random cache identity; conflict must retain it.
  sqlx::query("UPDATE calendar_event_instances SET id=$2 WHERE id=$1")
    .bind(initial[0].id)
    .bind(preserved.id)
    .execute(&pool)
    .await
    .unwrap();
  service
    .update_event_instance(
      event_id,
      initial[1].instance_start,
      serde_json::json!({"title":"Local override"}),
    )
    .await
    .unwrap();
  service
    .cancel_event_instance(event_id, initial[2].instance_start)
    .await
    .unwrap();
  let earlier = service
    .list_event_instances(event_id, event.starts_at, event.starts_at + Duration::days(14))
    .await
    .unwrap();
  assert_eq!(earlier.len(), 2);
  let final_instances = service.list_event_instances(event_id, from, to).await.unwrap();
  assert_eq!(final_instances[0].id, preserved.id);
  assert!(
    final_instances
      .iter()
      .any(|item| item.is_override && item.override_payload.as_ref().unwrap()["title"] == "Local override")
  );
  assert!(
    final_instances
      .iter()
      .any(|item| item.is_cancelled && item.instance_start == initial[2].instance_start)
  );
  service
    .update_recurring_series(
      event_id,
      serde_json::json!({"ends_at":(event.ends_at+Duration::hours(1)).to_rfc3339()}),
    )
    .await
    .unwrap();
  let reprojected:bool=sqlx::query_scalar("SELECT bool_and(instance_end-instance_start=interval '2 hours') FROM calendar_event_instances WHERE event_id=$1 AND instance_start>=$2 AND instance_start<$3 AND NOT is_override AND NOT is_cancelled")
    .bind(event_id).bind(from).bind(to).fetch_one(&pool).await.unwrap();
  assert!(
    reprojected,
    "generic series writes must commit their projection without waiting for provider sync or a repairing API read"
  );
  let displayed = service.list_workspace_events(workspace, from, to).await.unwrap();
  assert_eq!(
    displayed.len(),
    3,
    "cancelled original is not resurrected by projection"
  );
  assert!(
    displayed
      .iter()
      .any(|event| event.title.as_deref() == Some("Local override"))
  );
  let busy = service.free_busy(workspace, from, to).await.unwrap();
  assert_eq!(
    busy.len(),
    3,
    "free/busy uses the same projected, exception-aware window"
  );
  let sources = service
    .workspace_event_sources(workspace, event.starts_at, event.starts_at + Duration::days(14))
    .await
    .unwrap();
  let refs = sources.iter().collect::<Vec<_>>();
  let parsed =
    myoxus_infrastructure::caldav::parse_ical_events(&myoxus_infrastructure::caldav::events_to_vcalendar(&refs));
  assert_eq!(
    parsed.len(),
    3,
    "export retains one authored master and both protected exceptions outside the requested source window, not virtual ordinary instances"
  );
  assert!(
    parsed
      .iter()
      .any(|source| source.summary.as_deref() == Some("Local override")
        && source.recurrence_id.as_deref()
          == Some(initial[1].instance_start.format("%Y%m%dT%H%M%SZ").to_string().as_str()))
  );
  assert!(parsed.iter().any(|source| source.status.as_deref() == Some("CANCELLED")
    && source.recurrence_id.as_deref()
      == Some(initial[2].instance_start.format("%Y%m%dT%H%M%SZ").to_string().as_str())));
  assert_eq!(
    service
      .list_event_instances(event_id, event.starts_at, event.starts_at + Duration::days(14))
      .await
      .unwrap()
      .iter()
      .map(|item| item.id)
      .collect::<Vec<_>>(),
    earlier.iter().map(|item| item.id).collect::<Vec<_>>(),
    "other windows keep their instance IDs"
  );
  let slots:i64=sqlx::query_scalar("SELECT count(*) FROM scheduling_occurrences o JOIN scheduling_schedules s ON s.id=o.schedule_id WHERE s.target_json->>'event_id'=$1").bind(event_id.to_string()).fetch_one(&pool).await.unwrap();
  assert_eq!(slots, 0, "view projection cannot admit workflow execution");
  teardown_account(&pool, account_id).await;
  sqlx::query("DELETE FROM workspaces WHERE id=$1")
    .bind(workspace)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(user)
    .execute(&pool)
    .await
    .unwrap();
}

// ---------------------------------------------------------------------------
// INV-CAL-INST02 — Cancel instance sets is_cancelled = true
//
// Invariant: after setting is_cancelled = true on a specific instance, the row
// must reflect that flag while the event row remains unchanged.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_inst02_cancel_instance() {
  let pool = helpers::setup_pool().await;
  let (account_id, event_id) = setup_event(&pool, "inst02").await;

  let now = Utc::now();
  let instance_id = Uuid::new_v4();

  sqlx::query(
    "INSERT INTO calendar_event_instances
         (id, event_id, starts_at, ends_at, instance_start, instance_end, is_override, is_cancelled, created_at)
     VALUES ($1, $2, $3, $4, $3, $4, false, false, now())",
  )
  .bind(instance_id)
  .bind(event_id)
  .bind(now)
  .bind(now + Duration::hours(1))
  .execute(&pool)
  .await
  .expect("upsert instance for cancel test");

  // Cancel the instance.
  sqlx::query("UPDATE calendar_event_instances SET is_cancelled = true WHERE id = $1")
    .bind(instance_id)
    .execute(&pool)
    .await
    .expect("cancel instance");

  // Assert: is_cancelled is now true.
  let is_cancelled: bool = sqlx::query_scalar("SELECT is_cancelled FROM calendar_event_instances WHERE id = $1")
    .bind(instance_id)
    .fetch_one(&pool)
    .await
    .expect("fetch is_cancelled");

  assert!(
    is_cancelled,
    "INV-CAL-INST02: is_cancelled must be true after cancellation"
  );

  // Assert: the parent event is unaffected.
  let event_exists: Option<Uuid> = sqlx::query_scalar("SELECT id FROM calendar_events WHERE id = $1")
    .bind(event_id)
    .fetch_optional(&pool)
    .await
    .expect("event existence query");
  assert!(
    event_exists.is_some(),
    "INV-CAL-INST02: parent event must survive instance cancellation"
  );

  teardown_account(&pool, account_id).await;
}

// ---------------------------------------------------------------------------
// INV-CAL-INST03 — Deleting the parent event cascades to instances
//
// Invariant: when a calendar_event row is deleted, all its associated
// calendar_event_instances rows must also be removed (ON DELETE CASCADE).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_inst03_delete_instances_cascade() {
  let pool = helpers::setup_pool().await;
  let (account_id, event_id) = setup_event(&pool, "inst03").await;

  let now = Utc::now();

  // Insert two instances for the event.
  for i in 0..2_i64 {
    let start = now + Duration::days(i);
    sqlx::query(
      "INSERT INTO calendar_event_instances
           (id, event_id, starts_at, ends_at, instance_start, instance_end, is_override, is_cancelled, created_at)
       VALUES ($1, $2, $3, $4, $3, $4, false, false, now())",
    )
    .bind(Uuid::new_v4())
    .bind(event_id)
    .bind(start)
    .bind(start + Duration::hours(1))
    .execute(&pool)
    .await
    .expect("insert instance for cascade test");
  }

  // Confirm instances exist before deletion.
  let count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_event_instances WHERE event_id = $1")
    .bind(event_id)
    .fetch_one(&pool)
    .await
    .expect("count before");
  assert_eq!(
    count_before, 2,
    "INV-CAL-INST03: two instances must exist before event deletion"
  );

  // Delete the parent event (instances should cascade).
  sqlx::query("DELETE FROM calendar_events WHERE id = $1")
    .bind(event_id)
    .execute(&pool)
    .await
    .expect("delete parent event");

  // Assert: no orphan instances remain.
  let count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_event_instances WHERE event_id = $1")
    .bind(event_id)
    .fetch_one(&pool)
    .await
    .expect("count after");
  assert_eq!(
    count_after, 0,
    "INV-CAL-INST03: instances must be deleted when parent event is deleted (CASCADE)"
  );

  teardown_account(&pool, account_id).await;
}

// ---------------------------------------------------------------------------
// INV-CAL-INST04 — Instance inherits parent duration (B-02 fix)
//
// Invariant: when update_event_instance is called without explicit ends_at in
// the override_payload, the resulting instance_end = instance_start +
// parent_duration (not hardcoded 1 hour).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_inst04_instance_inherits_parent_duration() {
  let pool = helpers::setup_pool().await;
  let (account_id, event_id) = setup_event(&pool, "inst04").await;

  // Update the event to have a 90-minute duration.
  let base_start = Utc::now();
  let base_end = base_start + Duration::minutes(90);
  sqlx::query("UPDATE calendar_events SET starts_at = $1, ends_at = $2 WHERE id = $3")
    .bind(base_start)
    .bind(base_end)
    .bind(event_id)
    .execute(&pool)
    .await
    .expect("set 90min duration on parent");

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let svc = CalendarService::new(repo);

  let instance_start = base_start + Duration::days(7);
  // No ends_at in override — should inherit 90min from parent
  let override_payload = serde_json::json!({ "title": "Override" });
  let instance = svc
    .update_event_instance(event_id, instance_start, override_payload)
    .await
    .expect("update_event_instance must succeed");

  let duration = instance.instance_end - instance.instance_start;
  assert_eq!(
    duration,
    Duration::minutes(90),
    "INV-CAL-INST04: instance duration must equal parent duration (90min), got {:?}",
    duration
  );

  teardown_account(&pool, account_id).await;
}

// ---------------------------------------------------------------------------
// INV-CAL-EVT01 — upsert_event without workspace_id succeeds (B-10 fix)
//
// Invariant: creating an event with workspace_id = None must succeed and return
// the event (not an error about missing workspace_id).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_evt01_create_event_without_workspace() {
  let pool = helpers::setup_pool().await;
  let (account_id, _) = setup_event(&pool, "evt01").await;

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let svc = CalendarService::new(repo);

  let event_id = Uuid::new_v4();
  let now = Utc::now();
  let result = svc
    .upsert_event(CalendarEventUpsert {
      id: event_id,
      account_id,
      workspace_id: None,
      remote_event_id: format!("test-no-ws-{}", event_id),
      starts_at: now,
      ends_at: now + Duration::hours(1),
      title: Some("No Workspace Event".to_string()),
      source_doc_id: None,
      payload: serde_json::json!({}),
      participants: vec![],
      reminders: vec![],
    })
    .await;

  assert!(
    result.is_ok(),
    "INV-CAL-EVT01: upsert_event with workspace_id=None must succeed; got: {:?}",
    result.err()
  );
  let event = result.unwrap();
  assert_eq!(event.id, event_id, "INV-CAL-EVT01: returned event id must match");
  assert!(
    event.workspace_id.is_none(),
    "INV-CAL-EVT01: workspace_id must remain None"
  );

  // Cleanup
  sqlx::query("DELETE FROM calendar_events WHERE id = $1")
    .bind(event_id)
    .execute(&pool)
    .await
    .ok();
  teardown_account(&pool, account_id).await;
}
