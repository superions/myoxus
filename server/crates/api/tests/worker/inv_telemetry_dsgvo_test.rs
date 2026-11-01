// SPDX-License-Identifier: AGPL-3.0-or-later
//! DSGVO invariants for the telemetry pipeline (P-Telemetry-D).
//!
//! These tests exercise the canonical telemetry schema guarantees:
//!
//! * INV-TEL-05 — deleting a user cascades to `telemetry_events`.
//! * purge-per-user deletes only the target user's rows, leaving other
//!   users' rows and anonymous rows intact.
//! * `telemetry_daily` does not store per-user data, so a user deletion
//!   must NOT wipe any rollup rows.

use crate::helpers;

use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

async fn insert_event(pool: &PgPool, user_id: Option<Uuid>, event_name: &str) -> String {
  let event_id = Uuid::new_v4().to_string();
  sqlx::query(
    r#"INSERT INTO telemetry_events
       (event_id, event_name, category, user_id, schema_version, client_timestamp)
       VALUES ($1, $2, $3, $4, 1, $5)"#,
  )
  .bind(&event_id)
  .bind(event_name)
  .bind("admin_action")
  .bind(user_id)
  .bind(Utc::now())
  .execute(pool)
  .await
  .expect("insert telemetry_events");
  event_id
}

async fn count_for_user(pool: &PgPool, user_id: Uuid) -> i64 {
  let (c,): (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM telemetry_events WHERE user_id = $1")
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("count");
  c
}

async fn count_anonymous(pool: &PgPool) -> i64 {
  let (c,): (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM telemetry_events WHERE user_id IS NULL")
    .fetch_one(pool)
    .await
    .expect("count");
  c
}

/// INV-TEL-08 — deleting the user cascades their telemetry rows (DSGVO Art. 17
/// via FK ON DELETE CASCADE).
#[tokio::test]
async fn inv_tel08_user_delete_cascades_to_events() {
  let pool = helpers::setup_pool().await;
  let alice = helpers::create_user(&pool, "tel_alice", false).await;
  let bob = helpers::create_user(&pool, "tel_bob", false).await;

  insert_event(&pool, Some(alice), "doc.open").await;
  insert_event(&pool, Some(alice), "doc.save").await;
  insert_event(&pool, Some(bob), "doc.open").await;
  let anon_before = count_anonymous(&pool).await;
  insert_event(&pool, None, "page_view").await;

  assert_eq!(count_for_user(&pool, alice).await, 2);
  assert_eq!(count_for_user(&pool, bob).await, 1);

  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(alice)
    .execute(&pool)
    .await
    .expect("delete alice");

  assert_eq!(count_for_user(&pool, alice).await, 0, "cascade deleted alice rows");
  assert_eq!(count_for_user(&pool, bob).await, 1, "bob's rows untouched");
  // Parallel tests may insert anonymous rows concurrently, so only assert the
  // lower bound: at minimum the row we just inserted must survive.
  assert!(
    count_anonymous(&pool).await > anon_before,
    "anonymous rows unaffected by user deletion"
  );

  // Cleanup
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(bob)
    .execute(&pool)
    .await
    .ok();
}

/// Explicit purge-per-user (DSGVO Art. 17) — `DELETE … WHERE user_id = $1`
/// removes only the target user's rows and keeps the user account itself.
#[tokio::test]
async fn inv_tel_purge_user_scoped_and_keeps_account() {
  let pool = helpers::setup_pool().await;
  let alice = helpers::create_user(&pool, "tel_purge_alice", false).await;
  let bob = helpers::create_user(&pool, "tel_purge_bob", false).await;

  insert_event(&pool, Some(alice), "auth.login").await;
  insert_event(&pool, Some(alice), "auth.logout").await;
  insert_event(&pool, Some(bob), "auth.login").await;

  // Simulate the CLI's `telemetry purge-user` path.
  let deleted = sqlx::query("DELETE FROM telemetry_events WHERE user_id = $1")
    .bind(alice)
    .execute(&pool)
    .await
    .expect("purge")
    .rows_affected();
  assert_eq!(deleted, 2);

  assert_eq!(count_for_user(&pool, alice).await, 0);
  assert_eq!(count_for_user(&pool, bob).await, 1);

  // User account must still exist.
  let (still_there,): (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM users WHERE id = $1")
    .bind(alice)
    .fetch_one(&pool)
    .await
    .expect("check user still exists");
  assert_eq!(still_there, 1, "purge-user must not delete the user account");

  // Cleanup
  sqlx::query("DELETE FROM users WHERE id = $1 OR id = $2")
    .bind(alice)
    .bind(bob)
    .execute(&pool)
    .await
    .ok();
}

/// `telemetry_daily` carries only aggregates (no user_id column), so user
/// deletion must not touch any rollup rows.
#[tokio::test]
async fn inv_tel_daily_rollup_has_no_user_column() {
  let pool = helpers::setup_pool().await;

  // Verify schema: telemetry_daily must not have a user_id column.
  let (has_user_col,): (bool,) = sqlx::query_as(
    r#"SELECT EXISTS(
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'telemetry_daily' AND column_name = 'user_id'
       )"#,
  )
  .fetch_one(&pool)
  .await
  .expect("column lookup");
  assert!(!has_user_col, "telemetry_daily must not expose per-user data");

  // Insert a rollup row, delete an unrelated user, confirm rollup survives.
  let day = chrono::Utc::now().date_naive() - chrono::Duration::days(1);
  sqlx::query(
    r#"INSERT INTO telemetry_daily (day, category, event_name, count, unique_users, unique_sessions)
       VALUES ($1, $2, $3, 1, 1, 1)
       ON CONFLICT (day, category, event_name) DO UPDATE SET count = EXCLUDED.count"#,
  )
  .bind(day)
  .bind("test")
  .bind("rollup.guard")
  .execute(&pool)
  .await
  .expect("insert rollup");

  let alice = helpers::create_user(&pool, "tel_rollup_alice", false).await;
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(alice)
    .execute(&pool)
    .await
    .expect("delete alice");

  let (rollup_still_there,): (i64,) =
    sqlx::query_as("SELECT COUNT(*)::bigint FROM telemetry_daily WHERE day = $1 AND event_name = $2")
      .bind(day)
      .bind("rollup.guard")
      .fetch_one(&pool)
      .await
      .expect("count rollup");
  assert_eq!(
    rollup_still_there, 1,
    "user deletion must not affect telemetry_daily aggregates"
  );

  // Cleanup
  sqlx::query("DELETE FROM telemetry_daily WHERE day = $1 AND event_name = $2")
    .bind(day)
    .bind("rollup.guard")
    .execute(&pool)
    .await
    .ok();
}
