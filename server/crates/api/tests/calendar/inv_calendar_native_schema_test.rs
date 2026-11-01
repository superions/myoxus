// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-JCAL-SHARED-01-B: Invariant tests for the native Calendar schema
//! events + tags + workspace calendar settings).
//!
//! These run against a real PostgreSQL (TEST_DATABASE_URL) and verify the
//! DB-level invariants in the canonical baseline:
//!   INV-CAL-NATIVE-01  native ↔ no external identity, external ↔ both set
//!   INV-CAL-TAG-01     tags are workspace-scoped (UNIQUE (workspace_id, name))
//!
//! Run: TEST_DATABASE_URL=... cargo test -p myoxus-api inv_cal_native_schema

use chrono::{Duration, Utc};
use uuid::Uuid;

async fn connect() -> Option<sqlx::PgPool> {
  let url = std::env::var("TEST_DATABASE_URL").ok()?;
  let pool = sqlx::PgPool::connect(&url).await.ok()?;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrations must apply cleanly");
  Some(pool)
}

/// Seed one user + workspace + calendar_account + calendar_subscription so
/// that FK-bearing inserts can reference valid parents. Returns their IDs.
async fn seed_fixture(pool: &sqlx::PgPool) -> (Uuid, Uuid, Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  let ws_id = Uuid::new_v4();
  let account_id = Uuid::new_v4();
  let sub_id = Uuid::new_v4();

  sqlx::query("INSERT INTO users (id, name, email) VALUES ($1, 'native-schema', $2)")
    .bind(user_id)
    .bind(format!("native-schema-{user_id}@test.local"))
    .execute(pool)
    .await
    .expect("seed user");

  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'native-ws')")
    .bind(ws_id)
    .bind(user_id)
    .execute(pool)
    .await
    .expect("seed workspace");

  sqlx::query(
    "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id)
         VALUES ($1, $2, 'caldav', $3)",
  )
  .bind(account_id)
  .bind(user_id)
  .bind(format!("acct-{account_id}"))
  .execute(pool)
  .await
  .expect("seed account");

  sqlx::query(
    "INSERT INTO calendar_subscriptions (id, account_id, remote_calendar_id)
         VALUES ($1, $2, $3)",
  )
  .bind(sub_id)
  .bind(account_id)
  .bind(format!("cal-{sub_id}"))
  .execute(pool)
  .await
  .expect("seed subscription");

  (user_id, ws_id, account_id, sub_id)
}

async fn cleanup(pool: &sqlx::PgPool, user_id: Uuid, ws_id: Uuid, account_id: Uuid) {
  // Cascades take care of everything hanging off these.
  let _ = sqlx::query("DELETE FROM workspace_calendar_settings WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM calendar_events WHERE workspace_id = $1 OR account_id = $2")
    .bind(ws_id)
    .bind(account_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM calendar_event_tags WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM calendar_accounts WHERE id = $1")
    .bind(account_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await;
}

// ─── INV-CAL-NATIVE-01 — native row rejects non-null account_id ───────────────

#[tokio::test]
async fn inv_cal_native_schema_01a_native_rejects_account_id() {
  let Some(pool) = connect().await else {
    eprintln!("TEST_DATABASE_URL not set, skipping");
    return;
  };
  let (user_id, ws_id, account_id, _sub_id) = seed_fixture(&pool).await;

  let event_id = Uuid::new_v4();
  let now = Utc::now();

  let err = sqlx::query(
    "INSERT INTO calendar_events
       (id, origin, workspace_id, account_id, remote_event_id, starts_at, ends_at)
     VALUES ($1, 'native', $2, $3, NULL, $4, $5)",
  )
  .bind(event_id)
  .bind(ws_id)
  .bind(account_id) // <-- violates CHECK: native row must have account_id NULL
  .bind(now)
  .bind(now + Duration::hours(1))
  .execute(&pool)
  .await;

  assert!(
    err.is_err(),
    "INV-CAL-NATIVE-01: native + account_id must be rejected by CHECK constraint"
  );
  let msg = err.unwrap_err().to_string();
  assert!(
    msg.contains("ck_calendar_events_origin_consistency"),
    "expected CHECK constraint name in error, got: {msg}"
  );

  cleanup(&pool, user_id, ws_id, account_id).await;
}

// ─── INV-CAL-NATIVE-01 — external row rejects null account_id ────────────────

#[tokio::test]
async fn inv_cal_native_schema_01b_external_requires_account_id() {
  let Some(pool) = connect().await else {
    return;
  };
  let (user_id, ws_id, account_id, _) = seed_fixture(&pool).await;

  let event_id = Uuid::new_v4();
  let now = Utc::now();

  let err = sqlx::query(
    "INSERT INTO calendar_events
       (id, origin, workspace_id, account_id, remote_event_id, starts_at, ends_at)
     VALUES ($1, 'external', $2, NULL, NULL, $3, $4)",
  )
  .bind(event_id)
  .bind(ws_id)
  .bind(now)
  .bind(now + Duration::hours(1))
  .execute(&pool)
  .await;

  assert!(
    err.is_err(),
    "INV-CAL-NATIVE-01: external event without account_id/remote_event_id must be rejected"
  );

  cleanup(&pool, user_id, ws_id, account_id).await;
}

// ─── INV-CAL-NATIVE-01 — both shapes accepted ────────────────────────────────

#[tokio::test]
async fn inv_cal_native_schema_01c_both_valid_shapes_insert_cleanly() {
  let Some(pool) = connect().await else {
    return;
  };
  let (user_id, ws_id, account_id, _) = seed_fixture(&pool).await;

  let native_id = Uuid::new_v4();
  let external_id = Uuid::new_v4();
  let now = Utc::now();

  sqlx::query(
    "INSERT INTO calendar_events
       (id, origin, workspace_id, starts_at, ends_at, title)
     VALUES ($1, 'native', $2, $3, $4, 'native event')",
  )
  .bind(native_id)
  .bind(ws_id)
  .bind(now)
  .bind(now + Duration::hours(1))
  .execute(&pool)
  .await
  .expect("INV-CAL-NATIVE-01: valid native insert must succeed");

  sqlx::query(
    "INSERT INTO calendar_events
       (id, origin, workspace_id, account_id, remote_event_id, starts_at, ends_at, title)
     VALUES ($1, 'external', $2, $3, $4, $5, $6, 'external event')",
  )
  .bind(external_id)
  .bind(ws_id)
  .bind(account_id)
  .bind(format!("remote-{external_id}"))
  .bind(now)
  .bind(now + Duration::hours(1))
  .execute(&pool)
  .await
  .expect("INV-CAL-NATIVE-01: valid external insert must succeed");

  // Sanity: both rows visible, with correct origin column value.
  use sqlx::Row as _;
  let rows = sqlx::query(
    "SELECT id, origin::TEXT AS origin_text FROM calendar_events
      WHERE workspace_id = $1 ORDER BY title",
  )
  .bind(ws_id)
  .fetch_all(&pool)
  .await
  .unwrap();
  assert_eq!(rows.len(), 2);
  let origins: Vec<String> = rows.iter().map(|r| r.get::<String, _>("origin_text")).collect();
  assert_eq!(origins, vec!["external".to_string(), "native".to_string()]);

  cleanup(&pool, user_id, ws_id, account_id).await;
}

// ─── INV-CAL-TAG-01 — tag names are workspace-scoped ─────────────────────────

#[tokio::test]
async fn inv_cal_native_schema_tag01_unique_name_per_workspace() {
  let Some(pool) = connect().await else {
    return;
  };
  let (user_id, ws_id, account_id, _) = seed_fixture(&pool).await;

  // Two tags with the same name in the same workspace → second must fail.
  sqlx::query(
    "INSERT INTO calendar_event_tags (id, workspace_id, name, color)
     VALUES (gen_random_uuid(), $1, 'Meeting', '#ff0000')",
  )
  .bind(ws_id)
  .execute(&pool)
  .await
  .expect("first tag insert must succeed");

  let err = sqlx::query(
    "INSERT INTO calendar_event_tags (id, workspace_id, name, color)
     VALUES (gen_random_uuid(), $1, 'Meeting', '#00ff00')",
  )
  .bind(ws_id)
  .execute(&pool)
  .await;
  assert!(
    err.is_err(),
    "INV-CAL-TAG-01: duplicate (workspace_id, name) must be rejected"
  );

  // Same name in a different workspace → allowed.
  let user2 = Uuid::new_v4();
  let ws2 = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, name, email) VALUES ($1, 'tag-user-2', $2)")
    .bind(user2)
    .bind(format!("tag-user-2-{user2}@test.local"))
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'ws2')")
    .bind(ws2)
    .bind(user2)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query(
    "INSERT INTO calendar_event_tags (id, workspace_id, name, color)
     VALUES (gen_random_uuid(), $1, 'Meeting', '#0000ff')",
  )
  .bind(ws2)
  .execute(&pool)
  .await
  .expect("INV-CAL-TAG-01: same tag name in different workspace must succeed");

  // Cleanup ws2 fixture.
  let _ = sqlx::query("DELETE FROM calendar_event_tags WHERE workspace_id = $1")
    .bind(ws2)
    .execute(&pool)
    .await;
  let _ = sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws2)
    .execute(&pool)
    .await;
  let _ = sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user2)
    .execute(&pool)
    .await;

  cleanup(&pool, user_id, ws_id, account_id).await;
}

// ─── workspace_calendar_settings is keyed by workspace_id ─────────────────────

#[tokio::test]
async fn inv_cal_native_schema_settings_pk_per_workspace() {
  let Some(pool) = connect().await else {
    return;
  };
  let (user_id, ws_id, account_id, sub_id) = seed_fixture(&pool).await;

  sqlx::query(
    "INSERT INTO workspace_calendar_settings
       (workspace_id, writeback_subscription_id, default_reminder_offset_minutes)
     VALUES ($1, $2, 15)",
  )
  .bind(ws_id)
  .bind(sub_id)
  .execute(&pool)
  .await
  .expect("first settings upsert must succeed");

  let err = sqlx::query("INSERT INTO workspace_calendar_settings (workspace_id) VALUES ($1)")
    .bind(ws_id)
    .execute(&pool)
    .await;
  assert!(
    err.is_err(),
    "workspace_calendar_settings.workspace_id must be PK — duplicate insert rejected"
  );

  cleanup(&pool, user_id, ws_id, account_id).await;
}

// ─── FK: writeback_subscription_id SET NULL on subscription delete ────────────

#[tokio::test]
async fn inv_cal_native_schema_settings_writeback_fk_set_null() {
  let Some(pool) = connect().await else {
    return;
  };
  let (user_id, ws_id, account_id, sub_id) = seed_fixture(&pool).await;

  sqlx::query(
    "INSERT INTO workspace_calendar_settings (workspace_id, writeback_subscription_id)
     VALUES ($1, $2)",
  )
  .bind(ws_id)
  .bind(sub_id)
  .execute(&pool)
  .await
  .unwrap();

  sqlx::query("DELETE FROM calendar_subscriptions WHERE id = $1")
    .bind(sub_id)
    .execute(&pool)
    .await
    .expect("subscription delete must succeed (FK is SET NULL)");

  use sqlx::Row as _;
  let row = sqlx::query("SELECT writeback_subscription_id FROM workspace_calendar_settings WHERE workspace_id = $1")
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let sub: Option<Uuid> = row.get("writeback_subscription_id");
  assert!(
    sub.is_none(),
    "FK SET NULL on calendar_subscriptions delete must NULL writeback_subscription_id"
  );

  cleanup(&pool, user_id, ws_id, account_id).await;
}
