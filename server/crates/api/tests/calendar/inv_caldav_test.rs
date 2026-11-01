//! P83 — Invariant-first integration tests: CalDAV subscription domain.
//!
//! Tests verify DB STATE after operations, not just GraphQL responses.
//! Naming convention: `inv_{code}_{description}`.
//!
//! CalDAV subscriptions live in `calendar_subscriptions`, which hangs off
//! `calendar_accounts`.  A real external CalDAV server is not required:
//! these tests exercise the DB invariants via direct SQL INSERT/DELETE,
//! matching the `linkCalDAVAccount` / `unlinkCalendarAccount` mutation
//! postconditions.

use crate::helpers;

use uuid::Uuid;

// ---------------------------------------------------------------------------
// INV-CAL-01 — A created CalDAV subscription row persists in the database
//
// Invariant: after inserting a calendar_account + calendar_subscriptions row,
// both rows are retrievable from the DB with correct foreign-key linkage.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal01_subscription_created_in_db() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "inv-cal01", false).await;

  // Create a calendar_account owned by the user (provider = 'caldav').
  let account_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_accounts (user_id, provider, remote_account_id, config)
     VALUES ($1, 'caldav', $2, '{}'::jsonb)
     RETURNING id",
  )
  .bind(user_id)
  .bind(format!("inv-cal01-{}", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("insert calendar_account");

  // Create a subscription for that account.
  let sub_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_subscriptions (account_id, remote_calendar_id, updated_at)
     VALUES ($1, 'primary', now())
     RETURNING id",
  )
  .bind(account_id)
  .fetch_one(&pool)
  .await
  .expect("insert calendar_subscription");

  // Assert: the subscription row exists with the correct account linkage.
  let row = sqlx::query(
    "SELECT cs.id, ca.user_id
     FROM calendar_subscriptions cs
     JOIN calendar_accounts ca ON ca.id = cs.account_id
     WHERE cs.id = $1",
  )
  .bind(sub_id)
  .fetch_optional(&pool)
  .await
  .expect("subscription query");

  assert!(row.is_some(), "INV-CAL-01: subscription row must exist after insert");
  let row = row.expect("caldav row must exist");
  use sqlx::Row;
  let stored_user_id: Uuid = row.get("user_id");
  assert_eq!(
    stored_user_id, user_id,
    "INV-CAL-01: subscription must be linked to the creating user via calendar_account"
  );

  // Cleanup — cascade from calendar_accounts covers subscriptions.
  sqlx::query("DELETE FROM calendar_subscriptions WHERE id = $1")
    .bind(sub_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_accounts WHERE id = $1")
    .bind(account_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// INV-CAL-02 — Deleting a CalDAV subscription removes its row from the DB
//
// Invariant: after DELETE from calendar_subscriptions, the row must no longer
// be present.  The parent calendar_account row must remain intact.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal02_deleted_subscription_removed() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "inv-cal02", false).await;

  let account_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_accounts (user_id, provider, remote_account_id, config)
     VALUES ($1, 'caldav', $2, '{}'::jsonb)
     RETURNING id",
  )
  .bind(user_id)
  .bind(format!("inv-cal02-{}", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("insert calendar_account");

  let sub_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_subscriptions (account_id, remote_calendar_id, updated_at)
     VALUES ($1, 'primary', now())
     RETURNING id",
  )
  .bind(account_id)
  .fetch_one(&pool)
  .await
  .expect("insert calendar_subscription");

  // Confirm it exists before deletion.
  let before: Option<Uuid> = sqlx::query_scalar("SELECT id FROM calendar_subscriptions WHERE id = $1")
    .bind(sub_id)
    .fetch_optional(&pool)
    .await
    .expect("pre-delete query");
  assert!(before.is_some(), "INV-CAL-02: subscription must exist before deletion");

  // Delete the subscription (mirrors unlinkCalendarAccount cascade path).
  sqlx::query("DELETE FROM calendar_subscriptions WHERE id = $1")
    .bind(sub_id)
    .execute(&pool)
    .await
    .expect("delete calendar_subscription");

  // Assert: row is gone.
  let after: Option<Uuid> = sqlx::query_scalar("SELECT id FROM calendar_subscriptions WHERE id = $1")
    .bind(sub_id)
    .fetch_optional(&pool)
    .await
    .expect("post-delete query");
  assert!(
    after.is_none(),
    "INV-CAL-02: subscription row must be absent after deletion"
  );

  // Assert: account row still present (only the subscription was removed).
  let account_still_exists: Option<Uuid> = sqlx::query_scalar("SELECT id FROM calendar_accounts WHERE id = $1")
    .bind(account_id)
    .fetch_optional(&pool)
    .await
    .expect("account existence query");
  assert!(
    account_still_exists.is_some(),
    "INV-CAL-02: parent calendar_account must survive subscription deletion"
  );

  // Cleanup.
  sqlx::query("DELETE FROM calendar_accounts WHERE id = $1")
    .bind(account_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user_id]).await;
}
