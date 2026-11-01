// SPDX-License-Identifier: AGPL-3.0-or-later
//! P90-CAL-F-T01 / P92-CAL-FIX-C-02: Invariant tests for calendar conflict
//! detection, three-way merge, and offline pending-write queue.
//!
//! These tests run against a real PostgreSQL database (TEST_DATABASE_URL).
//! Start the test stack first: `build/scripts/test/stack-up.sh`
//!
//! Run: TEST_DATABASE_URL=... cargo test -p myoxus-api inv_cal_cf

use chrono::{Duration, Utc};
use uuid::Uuid;

use myoxus_application::calendar::{MergeResult, merge_calendar_events};
use myoxus_domain::entities::CalendarEvent;

// ─── Helper ───────────────────────────────────────────────────────────────────

fn make_event(id: Uuid) -> CalendarEvent {
  use myoxus_domain::entities::CalendarEventOrigin;
  CalendarEvent {
    id,
    origin: CalendarEventOrigin::External,
    account_id: Some(Uuid::new_v4()),
    workspace_id: None,
    remote_event_id: Some(format!("uid-{id}")),
    starts_at: Utc::now(),
    ends_at: Utc::now() + Duration::hours(1),
    title: Some("Base Title".to_string()),
    description: Some("Base description".to_string()),
    description_delta: None,
    location: Some("Berlin".to_string()),
    source_doc_id: None,
    all_day: false,
    all_members: false,
    tag_id: None,
    recurrence_parent_id: None,
    participants: vec![],
    reminders: vec![],
    payload: serde_json::json!({ "status": "confirmed" }),
    updated_at: Utc::now(),
    etag: Some("etag-abc123".to_string()),
    remote_href: Some("/cal/events/uid.ics".to_string()),
  }
}

// ─── inv_cal_cf01: independent fields auto-merged ─────────────────────────────

/// Invariant: When local changed title and remote changed time independently,
/// a three-way merge produces a unified result with both changes applied.
/// Neither field should be lost.
#[test]
fn inv_cal_cf01_three_way_merge_independent_fields() {
  let id = Uuid::new_v4();
  let base = make_event(id);

  // Local: only title changed.
  let mut ours = base.clone();
  ours.title = Some("Our Updated Title".to_string());

  // Remote: only start time changed.
  let mut theirs = base.clone();
  let new_time = base.starts_at + Duration::hours(2);
  theirs.starts_at = new_time;
  theirs.ends_at = new_time + Duration::hours(1);

  let result = merge_calendar_events(&base, &ours, &theirs);

  match result {
    MergeResult::Merged(merged) => {
      // Our title change must survive.
      assert_eq!(
        merged.title.as_deref(),
        Some("Our Updated Title"),
        "INV-CAL-CF01: local title change must be preserved in merge"
      );
      // Their time change must also survive.
      assert_eq!(
        merged.starts_at, new_time,
        "INV-CAL-CF01: remote time change must be preserved in merge"
      );
    }
    MergeResult::Conflicts(cs) => {
      let fields: Vec<&str> = cs.iter().map(|c| c.field.as_str()).collect();
      panic!("INV-CAL-CF01: expected auto-merge, got conflicts on {:?}", fields);
    }
  }
}

// ─── inv_cal_cf02: same field conflict ───────────────────────────────────────

/// Invariant: When both local and remote changed the same field to different
/// values, the merge must signal a conflict and identify the conflicting field.
#[test]
fn inv_cal_cf02_true_conflict_same_field() {
  let id = Uuid::new_v4();
  let base = make_event(id);

  let mut ours = base.clone();
  ours.title = Some("Our Title Version".to_string());

  let mut theirs = base.clone();
  theirs.title = Some("Their Title Version".to_string());

  let result = merge_calendar_events(&base, &ours, &theirs);

  match result {
    MergeResult::Conflicts(cs) => {
      assert!(!cs.is_empty(), "INV-CAL-CF02: conflicts list must not be empty");
      let title_conflict = cs
        .iter()
        .find(|c| c.field == "title")
        .expect("INV-CAL-CF02: conflict field must include 'title'");
      assert!(
        !title_conflict.local_value.is_empty(),
        "INV-CAL-CF02: local_value must not be empty"
      );
      assert!(
        !title_conflict.remote_value.is_empty(),
        "INV-CAL-CF02: remote_value must not be empty"
      );
      assert_ne!(
        title_conflict.local_value, title_conflict.remote_value,
        "INV-CAL-CF02: conflicting values must differ"
      );
    }
    MergeResult::Merged(_) => {
      panic!("INV-CAL-CF02: expected Conflicts, got Merged");
    }
  }
}

// ─── inv_cal_cf03: pending write created on simulated remote error ────────────

/// Invariant: When the write-through layer encounters a simulated remote error,
/// a `calendar_pending_writes` row must be created.
///
/// This test verifies the repository-level enqueue method directly — it uses
/// the test DB connection string from TEST_DATABASE_URL.
#[tokio::test]
async fn inv_cal_cf03_pending_write_created_on_error() {
  let db_url = match std::env::var("TEST_DATABASE_URL") {
    Ok(u) => u,
    Err(_) => {
      eprintln!("inv_cal_cf03: TEST_DATABASE_URL not set, skipping DB test");
      return;
    }
  };

  let pool = sqlx::PgPool::connect(&db_url)
    .await
    .expect("failed to connect to test DB");

  // Run migrations so pending-writes table exists.
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migration failed");

  use myoxus_domain::repositories::CalendarRepository;
  use myoxus_infrastructure::calendar::SqlxCalendarRepository;

  let repo = SqlxCalendarRepository::new(pool.clone());

  // Create a throwaway user + calendar account + event to satisfy FK constraints.
  let user_id = Uuid::new_v4();
  let account_id = Uuid::new_v4();
  let event_id = Uuid::new_v4();
  let now = Utc::now();

  sqlx::query("INSERT INTO users (id, name, email) VALUES ($1, 'cf03-test', $2)")
    .bind(user_id)
    .bind(format!("cf03-test-{}@test.local", user_id))
    .execute(&pool)
    .await
    .expect("failed to insert test user");

  sqlx::query(
    "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config, created_at, updated_at)
     VALUES ($1, $2, 'caldav', $3, '{}'::jsonb, $4, $4)",
  )
  .bind(account_id)
  .bind(user_id)
  .bind(format!("test-{account_id}"))
  .bind(now)
  .execute(&pool)
  .await
  .expect("failed to insert test account");

  sqlx::query(
    "INSERT INTO calendar_events (id, account_id, remote_event_id, starts_at, ends_at, payload, updated_at)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $4)",
  )
  .bind(event_id)
  .bind(account_id)
  .bind(format!("test-uid-{event_id}"))
  .bind(now)
  .bind(now + Duration::hours(1))
  .execute(&pool)
  .await
  .expect("failed to insert test event");

  // Enqueue a pending write to simulate a failed remote operation.
  let pending = repo
    .enqueue_pending_write(
      event_id,
      "update",
      Some(serde_json::json!({ "reason": "simulated_error" })),
    )
    .await
    .expect("enqueue_pending_write must succeed");

  // INV-CAL-CF03: the pending write row must exist in the DB.
  assert_eq!(
    pending.event_id,
    Some(event_id),
    "INV-CAL-CF03: pending_write.event_id must match"
  );
  assert_eq!(pending.operation, "update", "INV-CAL-CF03: operation must be 'update'");
  assert_eq!(pending.retry_count, 0, "INV-CAL-CF03: initial retry_count must be 0");
  assert!(
    pending.next_retry_at.is_some(),
    "INV-CAL-CF03: next_retry_at must be set for initial entry"
  );

  // Verify DB state directly.
  use sqlx::Row as _;
  let row = sqlx::query("SELECT id, retry_count FROM calendar_pending_writes WHERE id = $1")
    .bind(pending.id)
    .fetch_one(&pool)
    .await
    .expect("INV-CAL-CF03: pending_write row must be in DB");
  let db_retry: i32 = row.try_get("retry_count").unwrap();
  assert_eq!(db_retry, 0, "INV-CAL-CF03: DB retry_count must be 0");

  // Cleanup.
  sqlx::query("DELETE FROM calendar_pending_writes WHERE id = $1")
    .bind(pending.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_events WHERE id = $1")
    .bind(event_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_accounts WHERE id = $1")
    .bind(account_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

// ─── inv_cal_cf05: MERGE_AUTO incorporates remote-only changes ────────────────

/// Invariant (P92-CAL-FIX-C-02): three-way merge with base=local=same title,
/// remote having an additional location change → merged result includes the
/// remote-only location change.
///
/// This exercises the exact scenario exposed by the MERGE_AUTO no-op bug
/// (P92-CAL-FIX-A-01): if `ours` and `theirs` are the same object, the merge
/// is a guaranteed no-op. This test confirms the merge algorithm DOES pick up
/// remote-only changes when `theirs` differs from `base`.
#[test]
fn inv_cal_cf05_merge_auto_uses_remote_version() {
  let id = uuid::Uuid::new_v4();
  let base = make_event(id);

  // Local version: title changed (ours changed), location unchanged (= base).
  let mut ours = base.clone();
  ours.title = Some("LocalTitle".to_string());
  ours.location = Some("Berlin".to_string()); // same as base

  // Remote version: title unchanged (= base), location changed (only remote).
  let mut theirs = base.clone();
  theirs.title = Some("Base Title".to_string()); // same as base
  theirs.location = Some("RemoteLocation".to_string()); // remote-only change

  let result = merge_calendar_events(&base, &ours, &theirs);

  match result {
    MergeResult::Merged(merged) => {
      assert_eq!(
        merged.title.as_deref(),
        Some("LocalTitle"),
        "INV-CAL-CF05: local title change must survive the merge"
      );
      assert_eq!(
        merged.location.as_deref(),
        Some("RemoteLocation"),
        "INV-CAL-CF05: remote-only location change must be incorporated (MERGE_AUTO invariant)"
      );
    }
    MergeResult::Conflicts(cs) => {
      let fields: Vec<&str> = cs.iter().map(|c| c.field.as_str()).collect();
      panic!("INV-CAL-CF05: expected auto-merge, got conflicts on {:?}", fields);
    }
  }
}

// ─── inv_cal_cf06: merge returns ALL conflicting fields ───────────────────────

/// Invariant (P92-CAL-FIX-D-02): when both local and remote changed multiple
/// fields to different values, the merge result must list ALL conflicting
/// fields — not just the first one encountered.
#[test]
fn inv_cal_cf06_merge_returns_all_conflicts() {
  let id = Uuid::new_v4();
  let base = make_event(id);

  // Local changed both title AND location.
  let mut ours = base.clone();
  ours.title = Some("OurTitle".to_string());
  ours.location = Some("OurLocation".to_string());

  // Remote also changed both title AND location to different values.
  let mut theirs = base.clone();
  theirs.title = Some("TheirTitle".to_string());
  theirs.location = Some("TheirLocation".to_string());

  let result = merge_calendar_events(&base, &ours, &theirs);

  match result {
    MergeResult::Conflicts(cs) => {
      let fields: Vec<&str> = cs.iter().map(|c| c.field.as_str()).collect();
      assert!(
        fields.contains(&"title"),
        "INV-CAL-CF06: conflict list must contain 'title'; got {fields:?}"
      );
      assert!(
        fields.contains(&"location"),
        "INV-CAL-CF06: conflict list must contain 'location'; got {fields:?}"
      );
      assert_eq!(
        cs.len(),
        2,
        "INV-CAL-CF06: must report exactly 2 conflicts (title + location)"
      );
    }
    MergeResult::Merged(_) => {
      panic!("INV-CAL-CF06: expected Conflicts, got Merged");
    }
  }
}
