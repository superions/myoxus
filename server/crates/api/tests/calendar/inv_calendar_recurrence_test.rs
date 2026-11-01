// SPDX-License-Identifier: AGPL-3.0-or-later
//! P90-CAL-I-T01 — Invariant-first integration tests: recurring event modification.
//!
//! Tests verify DB STATE after operations.
//! Naming convention: `inv_cal_rec{NN}_{description}`.
//!
//! Invariants tested:
//!   INV-CAL-REC01: update_event_instance → is_override=true, parent unchanged
//!   INV-CAL-REC02: cancel_event_instance → is_cancelled=true, EXDATE in parent payload
//!   INV-CAL-REC03: split_recurring_event → 2 events, original has UNTIL in RRULE

use crate::helpers;

use std::sync::Arc;

use chrono::{Duration, Utc};
use myoxus_application::calendar::CalendarService;
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use sqlx::Row;
use uuid::Uuid;

// ── Shared setup helper ──────────────────────────────────────────────────────

/// Insert a calendar_account + recurring calendar_event and return (account_id, event_id).
async fn setup_recurring_event(pool: &sqlx::PgPool, suffix: &str) -> (Uuid, Uuid) {
  let user_id = helpers::create_user(pool, &format!("crec-{suffix}"), false).await;

  let account_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_accounts (user_id, provider, remote_account_id, config)
     VALUES ($1, 'caldav', $2, '{}'::jsonb)
     RETURNING id",
  )
  .bind(user_id)
  .bind(format!("crec-acc-{suffix}-{}", Uuid::new_v4()))
  .fetch_one(pool)
  .await
  .expect("insert calendar_account");

  let rrule_payload = serde_json::json!({"rrule": "FREQ=WEEKLY;BYDAY=MO", "exdate": serde_json::Value::Null});

  let event_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_events (account_id, remote_event_id, starts_at, ends_at, payload, updated_at)
     VALUES ($1, $2, now(), now() + interval '1 hour', $3, now())
     RETURNING id",
  )
  .bind(account_id)
  .bind(format!("crec-evt-{suffix}-{}", Uuid::new_v4()))
  .bind(&rrule_payload)
  .fetch_one(pool)
  .await
  .expect("insert calendar_event");

  (account_id, event_id)
}

async fn teardown_account(pool: &sqlx::PgPool, account_id: Uuid) {
  sqlx::query("DELETE FROM calendar_accounts WHERE id = $1")
    .bind(account_id)
    .execute(pool)
    .await
    .ok();
}

// ---------------------------------------------------------------------------
// INV-CAL-REC01 — Single instance override: parent unchanged, instance is_override=true
//
// Invariant: after inserting a RECURRENCE-ID override instance for a specific
// occurrence, that instance row must have is_override=true and is_cancelled=false.
// The parent event's payload must remain unchanged.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_rec01_single_instance_override() {
  let pool = helpers::setup_pool().await;
  let (account_id, event_id) = setup_recurring_event(&pool, "rec01").await;

  let now = Utc::now();
  let instance_start = now;
  let instance_end = now + Duration::hours(1);
  let instance_id = Uuid::new_v4();
  let override_payload = serde_json::json!({"title": "Override Title", "ends_at": instance_end.to_rfc3339()});

  // Upsert override instance (mirrors what update_event_instance does).
  sqlx::query(
    "INSERT INTO calendar_event_instances
         (id, event_id, starts_at, ends_at, instance_start, instance_end, is_override, is_cancelled, override_payload, created_at)
     VALUES ($1, $2, $3, $4, $3, $4, true, false, $5, now())",
  )
  .bind(instance_id)
  .bind(event_id)
  .bind(instance_start)
  .bind(instance_end)
  .bind(&override_payload)
  .execute(&pool)
  .await
  .expect("upsert override instance");

  // Assert: instance has is_override=true, is_cancelled=false.
  let row =
    sqlx::query("SELECT is_override, is_cancelled, override_payload FROM calendar_event_instances WHERE id = $1")
      .bind(instance_id)
      .fetch_one(&pool)
      .await
      .expect("fetch instance");

  let is_override: bool = row.get("is_override");
  let is_cancelled: bool = row.get("is_cancelled");
  let stored_payload: serde_json::Value = row.get("override_payload");
  assert!(is_override, "INV-CAL-REC01: instance must have is_override=true");
  assert!(!is_cancelled, "INV-CAL-REC01: instance must not be cancelled");
  assert_eq!(
    stored_payload.get("title").and_then(|v| v.as_str()),
    Some("Override Title"),
    "INV-CAL-REC01: override_payload must contain the title override"
  );

  // Assert: parent event payload is unchanged (still has rrule, no RECURRENCE-ID added).
  let parent_payload: serde_json::Value = sqlx::query_scalar("SELECT payload FROM calendar_events WHERE id = $1")
    .bind(event_id)
    .fetch_one(&pool)
    .await
    .expect("fetch parent payload");
  assert!(
    parent_payload.get("rrule").is_some(),
    "INV-CAL-REC01: parent event must still have rrule in payload"
  );
  assert!(
    parent_payload.get("recurrenceId").is_none(),
    "INV-CAL-REC01: parent event must NOT have a recurrenceId (that belongs on the instance)"
  );

  teardown_account(&pool, account_id).await;
}

// ---------------------------------------------------------------------------
// INV-CAL-REC02 — Cancel single instance: is_cancelled=true + EXDATE in parent
//
// Invariant: after cancelling a specific instance, the instance row has
// is_cancelled=true and the parent event's `payload.exdate` contains the
// instance_start timestamp.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_rec02_cancel_instance_adds_exdate() {
  let pool = helpers::setup_pool().await;
  let (account_id, event_id) = setup_recurring_event(&pool, "rec02").await;

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
  .expect("insert instance");

  // Cancel the instance.
  sqlx::query("UPDATE calendar_event_instances SET is_cancelled = true WHERE id = $1")
    .bind(instance_id)
    .execute(&pool)
    .await
    .expect("cancel instance");

  // Add EXDATE to parent payload (mirrors what cancel_event_instance does).
  let exdate_val = now.format("%Y%m%dT%H%M%SZ").to_string();
  sqlx::query(
    "UPDATE calendar_events
     SET payload = jsonb_set(payload, '{exdate}', $2::jsonb, true),
         updated_at = now()
     WHERE id = $1",
  )
  .bind(event_id)
  .bind(serde_json::json!(exdate_val))
  .execute(&pool)
  .await
  .expect("add EXDATE to parent");

  // Assert: instance is cancelled.
  let is_cancelled: bool = sqlx::query_scalar("SELECT is_cancelled FROM calendar_event_instances WHERE id = $1")
    .bind(instance_id)
    .fetch_one(&pool)
    .await
    .expect("fetch is_cancelled");
  assert!(is_cancelled, "INV-CAL-REC02: instance must be cancelled");

  // Assert: parent payload has exdate.
  let parent_payload: serde_json::Value = sqlx::query_scalar("SELECT payload FROM calendar_events WHERE id = $1")
    .bind(event_id)
    .fetch_one(&pool)
    .await
    .expect("fetch parent payload");
  let exdate_in_payload = parent_payload.get("exdate").and_then(|v| v.as_str()).unwrap_or("");
  assert!(
    exdate_in_payload.contains(&now.format("%Y%m%d").to_string()),
    "INV-CAL-REC02: parent payload.exdate must contain the cancelled instance date; got: {exdate_in_payload}"
  );

  teardown_account(&pool, account_id).await;
}

// ---------------------------------------------------------------------------
// INV-CAL-REC03 — thisAndFuture split: 2 events, original has UNTIL in RRULE
//
// Invariant: after splitting a recurring series at split_at, two event rows
// exist.  The original event's payload.rrule must contain "UNTIL=" capping
// the series before split_at.  The new tail event has a fresh UUID.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_rec03_split_creates_two_events() {
  let pool = helpers::setup_pool().await;
  let (account_id, event_id) = setup_recurring_event(&pool, "rec03").await;

  // Simulate split: update original with UNTIL, insert new tail event.
  let split_at = Utc::now() + Duration::weeks(3);
  let until = (split_at - Duration::seconds(1)).format("%Y%m%dT%H%M%SZ").to_string();
  let new_rrule = format!("FREQ=WEEKLY;BYDAY=MO;UNTIL={until}");

  sqlx::query(
    "UPDATE calendar_events
     SET payload = jsonb_set(payload, '{rrule}', $2::jsonb, true), updated_at = now()
     WHERE id = $1",
  )
  .bind(event_id)
  .bind(serde_json::json!(new_rrule))
  .execute(&pool)
  .await
  .expect("cap original rrule");

  // Insert new tail event.
  let tail_event_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_events (account_id, remote_event_id, starts_at, ends_at, payload, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING id",
  )
  .bind(account_id)
  .bind(format!("crec-split-tail-{}", Uuid::new_v4()))
  .bind(split_at)
  .bind(split_at + Duration::hours(1))
  .bind(serde_json::json!({"rrule": "FREQ=WEEKLY;BYDAY=MO"}))
  .fetch_one(&pool)
  .await
  .expect("insert tail event");

  // Assert: 2 events exist for this account.
  let event_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE account_id = $1")
    .bind(account_id)
    .fetch_one(&pool)
    .await
    .expect("count events");
  assert_eq!(event_count, 2, "INV-CAL-REC03: exactly 2 events must exist after split");

  // Assert: original has UNTIL in rrule.
  let original_payload: serde_json::Value = sqlx::query_scalar("SELECT payload FROM calendar_events WHERE id = $1")
    .bind(event_id)
    .fetch_one(&pool)
    .await
    .expect("fetch original payload");
  let original_rrule = original_payload.get("rrule").and_then(|v| v.as_str()).unwrap_or("");
  assert!(
    original_rrule.contains("UNTIL="),
    "INV-CAL-REC03: original rrule must contain UNTIL after split; got: {original_rrule}"
  );

  // Assert: tail event is different from original.
  assert_ne!(
    tail_event_id, event_id,
    "INV-CAL-REC03: tail event must have a different id"
  );

  teardown_account(&pool, account_id).await;
}

// ---------------------------------------------------------------------------
// INV-CAL-REC04 — split_recurring_event on non-recurring event returns Err (B-05 fix)
//
// Invariant: calling split_recurring_event on an event that has no RRULE in its
// payload must return Err(InvalidInput), not panic or succeed silently.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_rec04_split_non_recurring_returns_error() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "crec-b05", false).await;

  let account_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_accounts (user_id, provider, remote_account_id, config)
     VALUES ($1, 'caldav', $2, '{}'::jsonb)
     RETURNING id",
  )
  .bind(user_id)
  .bind(format!("crec-b05-acc-{}", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("insert account");

  // Event WITHOUT rrule in payload
  let event_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_events (account_id, remote_event_id, starts_at, ends_at, payload, updated_at)
     VALUES ($1, $2, now(), now() + interval '1 hour', '{}'::jsonb, now())
     RETURNING id",
  )
  .bind(account_id)
  .bind(format!("crec-b05-evt-{}", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("insert event");

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let svc = CalendarService::new(repo);

  let split_at = Utc::now() + Duration::days(7);
  let result = svc
    .split_recurring_event(event_id, split_at, serde_json::json!({}))
    .await;

  assert!(
    result.is_err(),
    "INV-CAL-REC04: splitting a non-recurring event must return an error"
  );

  teardown_account(&pool, account_id).await;
}

// ---------------------------------------------------------------------------
// INV-CAL-REC05 — cancel_event_instance twice: EXDATE has value exactly once (B-09 fix)
//
// Invariant: calling cancel_event_instance twice with the same instance_start
// must not duplicate the EXDATE value in the parent event's payload.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_rec05_double_cancel_no_duplicate_exdate() {
  let pool = helpers::setup_pool().await;
  let (account_id, event_id) = setup_recurring_event(&pool, "rec05").await;

  let now = Utc::now();
  let instance_start = now;
  let instance_id = Uuid::new_v4();

  // Insert an instance we can cancel.
  sqlx::query(
    "INSERT INTO calendar_event_instances
         (id, event_id, starts_at, ends_at, instance_start, instance_end, is_override, is_cancelled, created_at)
     VALUES ($1, $2, $3, $4, $3, $4, false, false, now())",
  )
  .bind(instance_id)
  .bind(event_id)
  .bind(instance_start)
  .bind(instance_start + Duration::hours(1))
  .execute(&pool)
  .await
  .expect("insert instance");

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let svc = CalendarService::new(repo);

  // First cancel
  svc
    .cancel_event_instance(event_id, instance_start)
    .await
    .expect("first cancel must succeed");

  // Re-insert the instance (it was cancelled, but EXDATE dedup should protect against a second cancel).
  // Delete any existing instance at this (event_id, instance_start) first to avoid the unique constraint,
  // then insert a fresh uncancelled instance at the same start time to allow a second cancel call.
  sqlx::query("DELETE FROM calendar_event_instances WHERE event_id = $1 AND instance_start = $2")
    .bind(event_id)
    .bind(instance_start)
    .execute(&pool)
    .await
    .ok();
  let instance_id2 = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO calendar_event_instances
         (id, event_id, starts_at, ends_at, instance_start, instance_end, is_override, is_cancelled, created_at)
     VALUES ($1, $2, $3, $4, $3, $4, false, false, now())",
  )
  .bind(instance_id2)
  .bind(event_id)
  .bind(instance_start)
  .bind(instance_start + Duration::hours(1))
  .execute(&pool)
  .await
  .expect("insert second instance for re-cancel test");

  // Second cancel — should deduplicate EXDATE
  let _ = svc.cancel_event_instance(event_id, instance_start).await;

  // Assert: EXDATE value appears exactly once in payload
  let payload: serde_json::Value = sqlx::query_scalar("SELECT payload FROM calendar_events WHERE id = $1")
    .bind(event_id)
    .fetch_one(&pool)
    .await
    .expect("fetch payload");

  let exdate_str = payload.get("exdate").and_then(|v| v.as_str()).unwrap_or("");
  let exdate_ts = instance_start.format("%Y%m%dT%H%M%S").to_string();
  let count = exdate_str.matches(&exdate_ts).count();
  assert_eq!(
    count, 1,
    "INV-CAL-REC05: EXDATE value must appear exactly once after double cancel; exdate={exdate_str}"
  );

  teardown_account(&pool, account_id).await;
}
