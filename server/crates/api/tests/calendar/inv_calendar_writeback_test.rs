// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-JCAL-SERVER-06: Writeback invariant tests.
//!
//! Invariants tested:
//!   INV-CAL-WRITEBACK-01: create with writeback_subscription_id configured
//!                         → calendar_pending_writes row with op="create".
//!   INV-CAL-WRITEBACK-02: create WITHOUT writeback_subscription_id
//!                         → no pending_write row created.

use std::sync::Arc;

use chrono::Utc;
use uuid::Uuid;

use myoxus_application::auth::{AuthUser, InMemoryAuthStore};
use myoxus_application::calendar::native::{NativeCreateInput, NativeEventService};
use myoxus_application::workspace::WorkspaceStore;
use myoxus_domain::entities::{MembershipStatus, WorkspaceRole};
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use sqlx::PgPool;

// ── Setup helpers ─────────────────────────────────────────────────────────────

async fn connect() -> Option<PgPool> {
  let url = std::env::var("TEST_DATABASE_URL").ok()?;
  let pool = sqlx::PgPool::connect(&url).await.ok()?;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrations");
  Some(pool)
}

/// Seeds user + workspace + in-memory membership + optional writeback sub ID.
/// Returns (pool, svc, user_id, ws_id).
async fn setup(pool: PgPool, writeback_subscription_id: Option<Uuid>) -> (PgPool, NativeEventService, Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  let ws_id = Uuid::new_v4();

  sqlx::query("INSERT INTO users (id, name, email) VALUES ($1, 'wb-test', $2)")
    .bind(user_id)
    .bind(format!("wb-{user_id}@test.local"))
    .execute(&pool)
    .await
    .expect("seed user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'wb-ws')")
    .bind(ws_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("seed workspace");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Collaborator', 'Accepted', NOW())",
  )
  .bind(ws_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("seed membership");

  if let Some(sub_id) = writeback_subscription_id {
    // calendar_subscriptions FK → calendar_accounts FK → users
    let account_id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config)
       VALUES ($1, $2, 'caldav', $3, '{}'::jsonb)",
    )
    .bind(account_id)
    .bind(user_id)
    .bind(format!("wb-acc-{user_id}"))
    .execute(&pool)
    .await
    .expect("seed calendar account");
    sqlx::query(
      "INSERT INTO calendar_subscriptions (id, account_id, remote_calendar_id)
       VALUES ($1, $2, 'wb-cal')",
    )
    .bind(sub_id)
    .bind(account_id)
    .execute(&pool)
    .await
    .expect("seed calendar subscription");
    sqlx::query(
      "INSERT INTO workspace_calendar_settings (workspace_id, writeback_subscription_id, updated_at)
       VALUES ($1, $2, NOW())",
    )
    .bind(ws_id)
    .bind(sub_id)
    .execute(&pool)
    .await
    .expect("seed calendar settings");
  }

  let auth_store = Arc::new(InMemoryAuthStore::default());
  auth_store.insert_user(AuthUser {
    id: user_id,
    email: format!("wb-{user_id}@test.local"),
    name: Some("wb-test".into()),
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: Some(Utc::now()),
    registered: true,
  });
  auth_store
    .add_or_update_member(
      ws_id,
      user_id,
      WorkspaceRole::Collaborator,
      MembershipStatus::Accepted,
      None,
    )
    .await
    .expect("seed in-memory membership");

  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let svc = NativeEventService::new(repo, auth_store);
  (pool, svc, user_id, ws_id)
}

async fn cleanup(pool: &PgPool, ws_id: Uuid, user_id: Uuid) {
  let _ = sqlx::query("DELETE FROM workspace_calendar_settings WHERE workspace_id = $1")
    .bind(ws_id)
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

fn base_input() -> NativeCreateInput {
  NativeCreateInput {
    imported_recurrence: None,
    recurrence: None,
    title: Some("Writeback test".into()),
    description_delta: None,
    starts_at: Utc::now() + chrono::Duration::hours(1),
    ends_at: Utc::now() + chrono::Duration::hours(2),
    all_day: false,
    all_members: false,
    tag_id: None,
    source_doc_id: None,
    source_anchor: None,
    reminders: None,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// INV-CAL-WRITEBACK-01: create with writeback_subscription_id → pending_write row.
#[tokio::test]
async fn inv_cal_writeback01_create_enqueues_pending_write() {
  let Some(pool) = connect().await else { return };
  let sub_id = Uuid::new_v4();
  let (pool, svc, user_id, ws_id) = setup(pool, Some(sub_id)).await;

  let event = svc
    .create(ws_id, user_id, base_input())
    .await
    .expect("create must succeed");

  use sqlx::Row as _;
  let row = sqlx::query("SELECT operation FROM calendar_pending_writes WHERE event_id = $1")
    .bind(event.id)
    .fetch_optional(&pool)
    .await
    .expect("query pending_writes");

  assert!(
    row.is_some(),
    "INV-CAL-WRITEBACK-01: calendar_pending_writes row must exist after create"
  );
  let op: String = row.unwrap().get("operation");
  assert_eq!(op, "create", "INV-CAL-WRITEBACK-01: operation must be 'create'");

  cleanup(&pool, ws_id, user_id).await;
}

/// INV-CAL-WRITEBACK-02: create WITHOUT writeback_subscription_id → no pending_write.
#[tokio::test]
async fn inv_cal_writeback02_no_writeback_without_subscription() {
  let Some(pool) = connect().await else { return };
  let (pool, svc, user_id, ws_id) = setup(pool, None).await;

  let event = svc
    .create(ws_id, user_id, base_input())
    .await
    .expect("create must succeed");

  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_pending_writes WHERE event_id = $1")
    .bind(event.id)
    .fetch_one(&pool)
    .await
    .expect("count query");

  assert_eq!(
    count, 0,
    "INV-CAL-WRITEBACK-02: no pending_write row when writeback_subscription_id is not configured"
  );

  cleanup(&pool, ws_id, user_id).await;
}
