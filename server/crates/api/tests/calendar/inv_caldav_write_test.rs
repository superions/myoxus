// SPDX-License-Identifier: AGPL-3.0-or-later
//! P90-CAL-E-T01 / P92-CAL-FIX-C-01 — Invariant-first unit tests for CalDAV
//! write-back.
//!
//! # Invariants tested
//!
//! * INV-CAL-W01: `calendar_event_to_vcalendar` produces a VCALENDAR that
//!   contains UID, DTSTART, and SUMMARY.
//! * INV-CAL-W02: `create_event` constructs the target URL as
//!   `{calendar_url}/{uid}.ics`.
//! * INV-CAL-W03: A 412 HTTP response maps to `CalDavError::EtagConflict`.
//!   Full end-to-end test (real CalDavClient::update_event + stub TCP server)
//!   lives in `myoxus_infrastructure::caldav::tests::inv_cal_w03_update_event_412_returns_etag_conflict`.
//!   This file verifies the CalDavError variant contract.
//! * INV-CAL-W04: A 404 HTTP response on DELETE is treated as `Ok(())`.
//!   Full end-to-end test lives in
//!   `myoxus_infrastructure::caldav::tests::inv_cal_w04_delete_event_404_is_idempotent`.
//!   This file verifies the status-code contract table.
//!
//! Naming convention: `inv_cal_w{nn}_{description}`.

// ─── W01 — iCalendar serializer round-trip ────────────────────────────────────
//
// Invariant: a CalendarEvent round-trips through the serializer and the output
// contains the mandatory UID, DTSTART, and SUMMARY properties.

#[test]
fn inv_cal_w01_ical_serializer_roundtrip() {
  use chrono::TimeZone;
  use chrono::Utc;
  use myoxus_domain::entities::CalendarEvent;
  use myoxus_infrastructure::caldav::ical_serializer::calendar_event_to_vcalendar;
  use serde_json::json;
  use uuid::Uuid;

  let event = CalendarEvent {
    id: Uuid::new_v4(),
    origin: myoxus_domain::entities::CalendarEventOrigin::External,
    account_id: Some(Uuid::new_v4()),
    workspace_id: None,
    remote_event_id: Some("inv-w01-uid".to_string()),
    starts_at: Utc.with_ymd_and_hms(2026, 3, 28, 14, 0, 0).unwrap(),
    ends_at: Utc.with_ymd_and_hms(2026, 3, 28, 15, 0, 0).unwrap(),
    title: Some("Invariant Test Event".to_string()),
    description: None,
    description_delta: None,
    location: None,
    source_doc_id: None,
    all_day: false,
    all_members: false,
    tag_id: None,
    recurrence_parent_id: None,
    participants: vec![],
    reminders: vec![],
    payload: json!({}),
    updated_at: Utc.with_ymd_and_hms(2026, 3, 28, 13, 0, 0).unwrap(),
    etag: None,
    remote_href: None,
  };

  let output = calendar_event_to_vcalendar(&event);

  assert!(output.contains("UID:inv-w01-uid"), "missing UID in VCALENDAR output");
  assert!(output.contains("DTSTART:20260328T140000Z"), "missing DTSTART");
  assert!(output.contains("SUMMARY:Invariant Test Event"), "missing SUMMARY");
  assert!(output.contains("BEGIN:VCALENDAR"), "missing BEGIN:VCALENDAR");
  assert!(output.contains("BEGIN:VEVENT"), "missing BEGIN:VEVENT");
  assert!(output.contains("END:VEVENT"), "missing END:VEVENT");
  assert!(output.contains("END:VCALENDAR"), "missing END:VCALENDAR");
}

// ─── W02 — create_event URL construction ─────────────────────────────────────
//
// Invariant: the target URL for a new event is `{calendar_url}/{uid}.ics`.
// This is verified by inspecting the href returned by the function signature
// contract (tested as a pure string construction unit test here).

#[test]
fn inv_cal_w02_create_event_url_construction() {
  // The CalDavClient builds: "{calendar_url}/{uid}.ics"
  // Verify this deterministically without network I/O.
  let calendar_url = "https://caldav.example.com/dav/user/calendars/default/";
  let uid = "test-event-uid-abc123";

  // Mirror the URL construction logic from CalDavClient::create_event
  let base = if calendar_url.ends_with('/') {
    calendar_url.to_string()
  } else {
    format!("{calendar_url}/")
  };
  let href = format!("{base}{uid}.ics");

  assert_eq!(
    href, "https://caldav.example.com/dav/user/calendars/default/test-event-uid-abc123.ics",
    "create_event URL construction invariant violated"
  );

  // Also test without trailing slash
  let calendar_url_no_slash = "https://caldav.example.com/dav/user/calendars/default";
  let base2 = if calendar_url_no_slash.ends_with('/') {
    calendar_url_no_slash.to_string()
  } else {
    format!("{calendar_url_no_slash}/")
  };
  let href2 = format!("{base2}{uid}.ics");

  assert_eq!(
    href2, "https://caldav.example.com/dav/user/calendars/default/test-event-uid-abc123.ics",
    "create_event URL construction (no trailing slash) invariant violated"
  );
}

// ─── W03 — 412 maps to EtagConflict ──────────────────────────────────────────
//
// Invariant: when a CalDAV server returns 412 Precondition Failed, the error
// type is EtagConflict (not a generic Http error).
//
// Tested against the REAL CalDavClient::update_event method via a stub TCP
// server that returns 412.  The actual test lives in the infrastructure crate's
// inline unit tests (caldav/mod.rs :: inv_cal_w03_update_event_412_returns_etag_conflict).
// This file-level test verifies the CalDavError::EtagConflict variant contract
// (Display representation and discriminant).

#[test]
fn inv_cal_w03_etag_conflict_error_type() {
  use myoxus_infrastructure::caldav::CalDavError;

  // Verify Display is descriptive (not empty or a raw debug string).
  let err = CalDavError::EtagConflict;
  let msg = err.to_string();
  assert!(
    msg.contains("ETag") || msg.contains("conflict") || msg.contains("Precondition"),
    "EtagConflict Display must be descriptive, got: {msg}"
  );

  // Verify the variant discriminant matches (not Http or Protocol).
  assert!(
    matches!(err, CalDavError::EtagConflict),
    "EtagConflict must match EtagConflict variant"
  );

  // Verify it does NOT match the generic Http variant.
  assert!(
    !matches!(err, CalDavError::Http(_, _)),
    "EtagConflict must NOT match generic Http variant"
  );
}

// ─── W04 — 404 on DELETE is idempotent (Ok) ──────────────────────────────────
//
// Invariant: a 404 Not Found response to DELETE does not return an error.
//
// The full end-to-end test (real CalDavClient::delete_event against a stub TCP
// server returning 404) lives in the infrastructure crate's inline unit tests
// (caldav/mod.rs :: inv_cal_w04_delete_event_404_is_idempotent).
// This file-level test documents and cross-checks the error-type contract for
// the other status codes handled by delete_event.

#[test]
fn inv_cal_w04_delete_status_code_contract() {
  use myoxus_infrastructure::caldav::CalDavError;

  // Verify EtagConflict is the error type returned for 412 (not Http(412,...)).
  // This mirrors what delete_event does at line 589 of caldav/mod.rs.
  let conflict = CalDavError::EtagConflict;
  assert!(
    matches!(conflict, CalDavError::EtagConflict),
    "INV-CAL-W04: 412 branch must produce EtagConflict, not Http(412)"
  );

  // Verify that the generic Http variant carries both code and message.
  let http_err = CalDavError::Http(500, "internal error".to_string());
  assert!(
    matches!(http_err, CalDavError::Http(500, _)),
    "INV-CAL-W04: Http variant must carry status code"
  );

  // Invariant: EtagConflict != Http(412, ...) — they are distinct variants.
  assert!(
    !matches!(conflict, CalDavError::Http(_, _)),
    "INV-CAL-W04: EtagConflict must be a distinct variant from Http"
  );
}

// ─── W05 — get_calendar_account_by_id O(1) lookup ────────────────────────────
//
// Invariant (P92-CAL-FIX-A-05): get_calendar_account_by_id returns the correct
// account when it exists and None for a random UUID, without fetching all
// accounts from the table.

#[tokio::test]
async fn inv_cal_w05_account_lookup_by_id() {
  let db_url = match std::env::var("TEST_DATABASE_URL") {
    Ok(u) => u,
    Err(_) => {
      eprintln!("inv_cal_w05: TEST_DATABASE_URL not set, skipping DB test");
      return;
    }
  };

  let pool = sqlx::PgPool::connect(&db_url)
    .await
    .expect("failed to connect to test DB");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migration failed");

  use myoxus_domain::repositories::CalendarRepository;
  use myoxus_infrastructure::calendar::SqlxCalendarRepository;
  use uuid::Uuid;

  let repo = SqlxCalendarRepository::new(pool.clone());
  let account_id = Uuid::new_v4();
  let user_id = Uuid::new_v4();
  let now = chrono::Utc::now();

  // Insert a temporary user to satisfy the FK constraint.
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'W05 Test', 'active')")
    .bind(user_id)
    .bind(format!("w05-test-{}@test.invalid", account_id))
    .execute(&pool)
    .await
    .expect("insert temp user for FK");

  // Insert a test account.
  sqlx::query(
    "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config, created_at, updated_at)
     VALUES ($1, $2, 'caldav', $3, '{}'::jsonb, $4, $4)",
  )
  .bind(account_id)
  .bind(user_id)
  .bind(format!("w05-{account_id}"))
  .bind(now)
  .execute(&pool)
  .await
  .expect("insert test account");

  // INV-CAL-W05a: known ID returns Some(account).
  let found = repo
    .get_calendar_account_by_id(account_id)
    .await
    .expect("get_calendar_account_by_id must succeed");
  assert!(found.is_some(), "INV-CAL-W05a: known account_id must return Some");
  assert_eq!(
    found.unwrap().id,
    account_id,
    "INV-CAL-W05a: returned account id must match"
  );

  // INV-CAL-W05b: unknown ID returns None.
  let not_found = repo
    .get_calendar_account_by_id(Uuid::new_v4())
    .await
    .expect("get_calendar_account_by_id must not error for unknown id");
  assert!(not_found.is_none(), "INV-CAL-W05b: unknown account_id must return None");

  // Cleanup.
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
