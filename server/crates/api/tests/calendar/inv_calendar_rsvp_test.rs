//! Invariant tests for P90-CAL-H RSVP, free/busy, and iMIP token logic.
//!
//! Tested invariants:
//!   INV-CAL-H-01: update_rsvp changes the participant's response_status in DB.
//!   INV-CAL-H-02: free_busy returns instances that overlap the query window.
//!   INV-CAL-H-03: iMIP token sign + verify roundtrip succeeds; tampered token fails.
use crate::helpers;

use std::sync::Arc;

use chrono::{Duration, Utc};
use uuid::Uuid;

use myoxus_application::calendar::{CalendarService, RsvpStatus};
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use sqlx::PgPool;

// ── Seed helpers ──────────────────────────────────────────────────────────────

/// Returns (user_id, account_id, event_id, participant_id).
async fn seed_event_with_participant(pool: &PgPool) -> (Uuid, Uuid, Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  let account_id = Uuid::new_v4();
  let event_id = Uuid::new_v4();
  let participant_id = Uuid::new_v4();
  let email = format!("rsvp-{}@example.test", user_id);

  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(&email)
    .bind("RSVP User")
    .execute(pool)
    .await
    .expect("seed user");

  sqlx::query(
    "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config) VALUES ($1, $2, $3, $4, '{}'::jsonb)",
  )
  .bind(account_id)
  .bind(user_id)
  .bind("caldav")
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
  .bind("RSVP Test Event")
  .execute(pool)
  .await
  .expect("seed calendar event");

  sqlx::query(
    "INSERT INTO calendar_event_participants (id, event_id, user_id, email, response_status)
     VALUES ($1, $2, $3, $4, 'needsAction')",
  )
  .bind(participant_id)
  .bind(event_id)
  .bind(user_id)
  .bind(&email)
  .execute(pool)
  .await
  .expect("seed participant");

  (user_id, account_id, event_id, participant_id)
}

async fn cleanup_event(pool: &PgPool, user_id: Uuid, event_id: Uuid) {
  sqlx::query("DELETE FROM calendar_event_participants WHERE event_id = $1")
    .bind(event_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_events WHERE id = $1")
    .bind(event_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_accounts WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .ok();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// INV-CAL-H-01: update_rsvp persists the new response_status in the DB.
///
/// After calling CalendarService::update_rsvp with RsvpStatus::Accepted,
/// the participant row must show response_status = 'ACCEPTED'.
#[tokio::test]
async fn inv_cal_h01_update_rsvp_changes_partstat() {
  let pool = helpers::setup_pool().await;
  let (user_id, _account_id, event_id, _participant_id) = seed_event_with_participant(&pool).await;

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let svc = CalendarService::new(repo);

  svc
    .update_rsvp(event_id, user_id, RsvpStatus::Accepted)
    .await
    .expect("update_rsvp must succeed");

  let row: (String,) =
    sqlx::query_as("SELECT response_status FROM calendar_event_participants WHERE event_id = $1 AND user_id = $2")
      .bind(event_id)
      .bind(user_id)
      .fetch_one(&pool)
      .await
      .expect("participant row must exist");

  assert_eq!(row.0, "ACCEPTED", "response_status must be ACCEPTED after update_rsvp");

  cleanup_event(&pool, user_id, event_id).await;
}

/// INV-CAL-H-02: free_busy returns calendar event instances within query window.
///
/// An event instance overlapping [from, to) must appear in the free/busy result.
#[tokio::test]
async fn inv_cal_h02_freebusy_returns_busy_instances() {
  let pool = helpers::setup_pool().await;

  let workspace_id = Uuid::new_v4();
  let user_id = Uuid::new_v4();
  let account_id = Uuid::new_v4();
  let event_id = Uuid::new_v4();
  let instance_id = Uuid::new_v4();
  let email = format!("freebusy-{}@example.test", user_id);

  let from = Utc::now() + Duration::hours(1);
  let to = from + Duration::hours(4);
  let inst_start = from + Duration::minutes(30);
  let inst_end = inst_start + Duration::hours(1);

  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(&email)
    .bind("FB User")
    .execute(&pool)
    .await
    .expect("seed user");

  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name, public) VALUES ($1, $2, $3, false)")
    .bind(workspace_id)
    .bind(user_id)
    .bind("FB Workspace")
    .execute(&pool)
    .await
    .expect("seed workspace");

  sqlx::query(
    "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config) VALUES ($1, $2, $3, $4, '{}'::jsonb)",
  )
  .bind(account_id).bind(user_id).bind("caldav").bind(format!("acc-{}", user_id))
  .execute(&pool).await.expect("seed account");

  sqlx::query(
    "INSERT INTO calendar_events (id, account_id, workspace_id, remote_event_id, starts_at, ends_at, title, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)",
  )
  .bind(event_id)
  .bind(account_id)
  .bind(workspace_id)
  .bind(format!("evt-{}", event_id))
  .bind(inst_start)
  .bind(inst_end)
  .bind("FB Event")
  .execute(&pool)
  .await
  .expect("seed event");

  sqlx::query(
    "INSERT INTO calendar_event_instances (id, event_id, starts_at, ends_at, instance_start, instance_end)
     VALUES ($1, $2, $3, $4, $5, $6)",
  )
  .bind(instance_id)
  .bind(event_id)
  .bind(inst_start)
  .bind(inst_end)
  .bind(inst_start)
  .bind(inst_end)
  .execute(&pool)
  .await
  .expect("seed instance");

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let svc = CalendarService::new(repo);

  let instances = svc
    .free_busy(workspace_id, from, to)
    .await
    .expect("free_busy must succeed");

  assert!(
    instances.iter().any(|i| i.id == instance_id),
    "busy instance must appear in free_busy result"
  );

  // Cleanup (reverse order of FK deps)
  sqlx::query("DELETE FROM calendar_event_instances WHERE id = $1")
    .bind(instance_id)
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

/// INV-CAL-H-03: iMIP RSVP token sign+verify roundtrip; tampered token rejected.
///
/// A freshly signed token must decode to the original (event_id, user_id, status).
/// A token with a modified payload must not verify.
#[test]
fn inv_cal_h03_imip_token_roundtrip_and_tamper_rejection() {
  use myoxus_api::handlers::calendar::{imip_sign_token, imip_verify_token};

  let event_id = Uuid::new_v4();
  let user_id = Uuid::new_v4();
  let status = "accepted";
  let secret = "test-secret-key";
  let expires_ts = (Utc::now() + Duration::days(30)).timestamp();

  let token = imip_sign_token(event_id, user_id, status, expires_ts, secret);
  let result = imip_verify_token(&token, secret);

  assert!(result.is_some(), "valid token must verify");
  let (ev, us, st) = result.unwrap();
  assert_eq!(ev, event_id, "event_id must round-trip");
  assert_eq!(us, user_id, "user_id must round-trip");
  assert_eq!(st, status, "status must round-trip");

  // Tampered token: flip one character in the base64
  let mut tampered = token.clone();
  let bad_char = if tampered.ends_with('A') { 'B' } else { 'A' };
  tampered.pop();
  tampered.push(bad_char);
  assert!(
    imip_verify_token(&tampered, secret).is_none(),
    "tampered token must be rejected"
  );
}
