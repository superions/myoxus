// SPDX-License-Identifier: AGPL-3.0-or-later
//! P90-CAL-C-T02 — Invariant-first integration tests: calendar event instances.
//!
//! Tests verify DB STATE after operations against calendar_event_instances.
//! Naming convention: `inv_{code}_{description}`.
//!
//! These tests exercise the repository methods added in P90-CAL-C-02 via direct
//! SQL, mirroring exactly what the infrastructure implementation does, to ensure
//! the schema supports the upsert / cancel / delete invariants.

use crate::helpers;

use std::sync::Arc;

use chrono::{Duration, Utc};
use myoxus_application::calendar::{CalendarEventUpsert, CalendarService};
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
    .ok();
}

// ---------------------------------------------------------------------------
// INV-CAL-INST01 — Upsert then list returns the instance
//
// Invariant: after upserting a calendar_event_instance, list_event_instances
// for the same event_id and overlapping time range must return that instance
// with the stored fields intact.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_inst01_create_and_list_instance() {
  let pool = helpers::setup_pool().await;
  let (account_id, event_id) = setup_event(&pool, "inst01").await;

  let now = Utc::now();
  let instance_start = now;
  let instance_end = now + Duration::hours(1);
  let instance_id = Uuid::new_v4();

  // Upsert an instance (mirrors what the RRULE expansion engine would produce).
  sqlx::query(
    "INSERT INTO calendar_event_instances
         (id, event_id, starts_at, ends_at, instance_start, instance_end, is_override, is_cancelled, created_at)
     VALUES ($1, $2, $3, $4, $3, $4, false, false, now())",
  )
  .bind(instance_id)
  .bind(event_id)
  .bind(instance_start)
  .bind(instance_end)
  .execute(&pool)
  .await
  .expect("upsert instance");

  // List instances for a range that covers the instance.
  let rows = sqlx::query(
    "SELECT id, event_id, instance_start, instance_end, is_override, is_cancelled
     FROM calendar_event_instances
     WHERE event_id = $1
       AND instance_start >= $2
       AND instance_start < $3
     ORDER BY instance_start ASC",
  )
  .bind(event_id)
  .bind(now - Duration::minutes(1))
  .bind(now + Duration::hours(2))
  .fetch_all(&pool)
  .await
  .expect("list instances");

  assert_eq!(rows.len(), 1, "INV-CAL-INST01: exactly one instance must be returned");
  let row = &rows[0];
  let stored_id: Uuid = row.get("id");
  let stored_event_id: Uuid = row.get("event_id");
  let stored_is_cancelled: bool = row.get("is_cancelled");
  assert_eq!(stored_id, instance_id, "INV-CAL-INST01: instance id must round-trip");
  assert_eq!(stored_event_id, event_id, "INV-CAL-INST01: event_id FK must be correct");
  assert!(
    !stored_is_cancelled,
    "INV-CAL-INST01: new instance must not be cancelled"
  );

  teardown_account(&pool, account_id).await;
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
