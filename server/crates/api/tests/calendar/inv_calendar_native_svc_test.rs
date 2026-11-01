// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-JCAL-SERVER-02-D: Invariant tests for NativeEventService scope semantics.
//!
//! Invariants tested:
//!   INV-CAL-SCOPE-01   scope=This creates override row + EXDATE on master
//!   INV-CAL-SCOPE-02   scope=All edits master in-place, overrides untouched
//!   INV-CAL-NATIVE-02  scope=This delete adds EXDATE, master survives
//!   (delete scope=All via FK cascade)
//!
//! Run: TEST_DATABASE_URL=... cargo test -p myoxus-api inv_calendar_native_svc

use std::sync::Arc;

use chrono::Utc;
use uuid::Uuid;

use myoxus_application::auth::{AuthError, AuthUser, InMemoryAuthStore};
use myoxus_application::calendar::native::{
  DeleteScope, NativeCreateInput, NativeEventService, ReminderInput, UpdateScope,
};
use myoxus_application::workspace::WorkspaceStore;
use myoxus_domain::entities::{MembershipStatus, WorkspaceRole};
use myoxus_domain::repositories::{NativeEventReminderInput, NativeEventUpdate};
use myoxus_infrastructure::calendar::SqlxCalendarRepository;

// ── Shared test helpers ───────────────────────────────────────────────────────

async fn connect_svc() -> Option<(sqlx::PgPool, NativeEventService, Arc<InMemoryAuthStore>, Uuid, Uuid)> {
  let url = std::env::var("TEST_DATABASE_URL").ok()?;
  let pool = sqlx::PgPool::connect(&url).await.ok()?;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrations");

  let user_id = Uuid::new_v4();
  let ws_id = Uuid::new_v4();

  sqlx::query("INSERT INTO users (id, name, email) VALUES ($1, 'svc-test', $2)")
    .bind(user_id)
    .bind(format!("svc-{user_id}@test.local"))
    .execute(&pool)
    .await
    .expect("seed user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'svc-ws')")
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

  let auth_store = Arc::new(InMemoryAuthStore::default());
  auth_store.insert_user(AuthUser {
    id: user_id,
    email: format!("svc-{user_id}@test.local"),
    name: Some("svc-test".into()),
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
  let svc = NativeEventService::new(repo, auth_store.clone());
  Some((pool, svc, auth_store, user_id, ws_id))
}

async fn cleanup(pool: &sqlx::PgPool, ws_id: Uuid, user_id: Uuid) {
  let _ = sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await;
}

fn base_input(_ws_id: Uuid) -> NativeCreateInput {
  NativeCreateInput {
    title: Some("Test Event".into()),
    description_delta: None,
    starts_at: Utc::now(),
    ends_at: Utc::now() + chrono::Duration::hours(1),
    all_day: false,
    all_members: false,
    tag_id: None,
    source_doc_id: None,
    source_anchor: None,
    reminders: vec![],
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// INV-CAL-SCOPE-01: scope=This creates override row with recurrence_parent_id + EXDATE on master
#[tokio::test]
async fn inv_scope01_this_creates_override_and_exdate() {
  let Some((pool, svc, _auth_store, uid, ws)) = connect_svc().await else {
    return;
  };

  let master = svc.create(ws, uid, base_input(ws)).await.expect("create master");
  let instance_start = master.starts_at;

  let update = NativeEventUpdate {
    title: Some(Some("Override Title".into())),
    ..Default::default()
  };
  let override_event = svc
    .update(master.id, ws, uid, UpdateScope::This { instance_start }, update)
    .await
    .expect("update scope=this");

  assert_eq!(
    override_event.recurrence_parent_id,
    Some(master.id),
    "INV-CAL-SCOPE-01: override must reference master"
  );
  assert_eq!(override_event.title.as_deref(), Some("Override Title"));

  let exdates: serde_json::Value =
    sqlx::query_scalar("SELECT COALESCE(payload->'exdates', '[]'::jsonb) FROM calendar_events WHERE id = $1")
      .bind(master.id)
      .fetch_one(&pool)
      .await
      .expect("fetch exdates");
  assert!(
    !exdates.as_array().unwrap().is_empty(),
    "INV-CAL-SCOPE-01: master must have EXDATE"
  );

  cleanup(&pool, ws, uid).await;
}

// INV-CAL-SCOPE-02: scope=All edits master in-place
#[tokio::test]
async fn inv_scope02_all_edits_master_inplace() {
  let Some((pool, svc, _auth_store, uid, ws)) = connect_svc().await else {
    return;
  };

  let master = svc.create(ws, uid, base_input(ws)).await.expect("create");
  let update = NativeEventUpdate {
    title: Some(Some("All-Updated".into())),
    ..Default::default()
  };
  let updated = svc
    .update(master.id, ws, uid, UpdateScope::All, update)
    .await
    .expect("update scope=all");

  assert_eq!(
    updated.title.as_deref(),
    Some("All-Updated"),
    "INV-CAL-SCOPE-02: master title must change"
  );
  // No new override row should exist
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE recurrence_parent_id = $1")
    .bind(master.id)
    .fetch_one(&pool)
    .await
    .expect("count overrides");
  assert_eq!(count, 0, "INV-CAL-SCOPE-02: scope=All must not create override rows");

  cleanup(&pool, ws, uid).await;
}

/// Reminder update patches replace atomically, clear explicitly, and leave the
/// existing rows untouched when the patch is omitted.
#[tokio::test]
async fn inv_calendar_reminder_update_replaces_clears_and_preserves_on_omission() {
  let Some((pool, svc, _auth_store, uid, ws)) = connect_svc().await else {
    return;
  };

  let mut input = base_input(ws);
  input.reminders = vec![ReminderInput {
    minutes_before: 30,
    channel: "in_app".to_string(),
  }];
  let master = svc.create(ws, uid, input).await.expect("create with reminder");
  assert_eq!(master.reminders.len(), 1, "creation must return its persisted reminder");
  assert_eq!(master.reminders[0].minutes_before, 30);
  assert_eq!(master.reminders[0].channel, "in_app");
  let created_reminder: (i64, Option<i32>) =
    sqlx::query_as("SELECT COUNT(*)::bigint, MIN(minutes_before) FROM calendar_reminders WHERE event_id = $1")
      .bind(master.id)
      .fetch_one(&pool)
      .await
      .expect("created reminder row");
  assert_eq!(created_reminder, (1, Some(30)));

  let replaced = svc
    .update(
      master.id,
      ws,
      uid,
      UpdateScope::All,
      NativeEventUpdate {
        reminders: Some(vec![
          NativeEventReminderInput {
            minutes_before: 5,
            channel: "in_app".to_string(),
          },
          NativeEventReminderInput {
            minutes_before: 60,
            channel: "email".to_string(),
          },
        ]),
        ..Default::default()
      },
    )
    .await
    .expect("replace reminders");
  let mut replaced_minutes = replaced
    .reminders
    .iter()
    .map(|reminder| reminder.minutes_before)
    .collect::<Vec<_>>();
  replaced_minutes.sort_unstable();
  assert_eq!(
    replaced_minutes,
    vec![5, 60],
    "replace must return the reloaded reminder rows"
  );

  let delivered_id = replaced.reminders[0].id;
  sqlx::query("UPDATE calendar_reminders SET delivered_at = now() WHERE id = $1")
    .bind(delivered_id)
    .execute(&pool)
    .await
    .expect("mark reminder delivered");
  let repeated = svc
    .update(
      master.id,
      ws,
      uid,
      UpdateScope::All,
      NativeEventUpdate {
        reminders: Some(
          replaced
            .reminders
            .iter()
            .rev()
            .map(|reminder| NativeEventReminderInput {
              minutes_before: reminder.minutes_before,
              channel: reminder.channel.clone(),
            })
            .collect(),
        ),
        ..Default::default()
      },
    )
    .await
    .expect("repeat unchanged reminder patch");
  let ids = |event: &myoxus_domain::entities::CalendarEvent| {
    event
      .reminders
      .iter()
      .map(|r| r.id)
      .collect::<std::collections::BTreeSet<_>>()
  };
  assert_eq!(
    ids(&repeated),
    ids(&replaced),
    "identical patches must retain reminder identities"
  );
  assert!(
    repeated
      .reminders
      .iter()
      .find(|r| r.id == delivered_id)
      .unwrap()
      .delivered_at
      .is_some(),
    "identical patches must not rearm a delivered reminder"
  );

  let unchanged = svc
    .update(
      master.id,
      ws,
      uid,
      UpdateScope::All,
      NativeEventUpdate {
        title: Some(Some("Renamed".to_string())),
        ..Default::default()
      },
    )
    .await
    .expect("update without reminder patch");
  let mut unchanged_minutes = unchanged
    .reminders
    .iter()
    .map(|reminder| reminder.minutes_before)
    .collect::<Vec<_>>();
  unchanged_minutes.sort_unstable();
  assert_eq!(
    unchanged_minutes,
    vec![5, 60],
    "omitting reminders must preserve existing rows"
  );

  let cleared = svc
    .update(
      master.id,
      ws,
      uid,
      UpdateScope::All,
      NativeEventUpdate {
        reminders: Some(Vec::new()),
        ..Default::default()
      },
    )
    .await
    .expect("clear reminders");
  assert!(cleared.reminders.is_empty(), "empty replacement must clear reminders");
  let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_reminders WHERE event_id = $1")
    .bind(master.id)
    .fetch_one(&pool)
    .await
    .expect("count reminder rows");
  assert_eq!(row_count, 0);

  cleanup(&pool, ws, uid).await;
}

// Delete scope=This: master survives, EXDATE added
#[tokio::test]
async fn inv_scope_this_delete_adds_exdate() {
  let Some((pool, svc, _auth_store, uid, ws)) = connect_svc().await else {
    return;
  };

  let account_id = Uuid::new_v4();
  let subscription_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config)
     VALUES ($1, $2, 'caldav', $3, '{}'::jsonb)",
  )
  .bind(account_id)
  .bind(uid)
  .bind(format!("scope-this-{uid}"))
  .execute(&pool)
  .await
  .expect("seed writeback account");
  sqlx::query(
    "INSERT INTO calendar_subscriptions (id, account_id, remote_calendar_id)
     VALUES ($1, $2, 'http://caldav.example/scope-this/')",
  )
  .bind(subscription_id)
  .bind(account_id)
  .execute(&pool)
  .await
  .expect("seed writeback subscription");
  sqlx::query(
    "INSERT INTO workspace_calendar_settings (workspace_id, writeback_subscription_id, updated_at)
     VALUES ($1, $2, NOW())",
  )
  .bind(ws)
  .bind(subscription_id)
  .execute(&pool)
  .await
  .expect("configure writeback");

  let master = svc.create(ws, uid, base_input(ws)).await.expect("create");
  sqlx::query("DELETE FROM calendar_pending_writes WHERE event_id = $1")
    .bind(master.id)
    .execute(&pool)
    .await
    .expect("clear create write before scope assertion");
  let instance_start = master.starts_at;

  svc
    .delete(master.id, ws, uid, DeleteScope::This { instance_start })
    .await
    .expect("delete scope=this");

  // Master must still exist
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE id = $1")
    .bind(master.id)
    .fetch_one(&pool)
    .await
    .expect("count master");
  assert_eq!(count, 1, "scope=This delete must NOT remove the master event");

  let exdates: serde_json::Value =
    sqlx::query_scalar("SELECT COALESCE(payload->'exdates', '[]'::jsonb) FROM calendar_events WHERE id = $1")
      .bind(master.id)
      .fetch_one(&pool)
      .await
      .expect("fetch exdates");
  assert!(
    !exdates.as_array().unwrap().is_empty(),
    "scope=This delete must add EXDATE to master"
  );
  let operations: Vec<String> =
    sqlx::query_scalar("SELECT operation FROM calendar_pending_writes WHERE event_id = $1 ORDER BY created_at")
      .bind(master.id)
      .fetch_all(&pool)
      .await
      .expect("read occurrence writeback");
  assert_eq!(
    operations,
    ["update".to_string()],
    "scope=This must serialize the EXDATE as a master update, never a remote delete"
  );

  cleanup(&pool, ws, uid).await;
}

// Delete scope=All: event removed from DB (FK cascade takes overrides)
#[tokio::test]
async fn inv_scope_all_delete_removes_event() {
  let Some((pool, svc, _auth_store, uid, ws)) = connect_svc().await else {
    return;
  };

  let master = svc.create(ws, uid, base_input(ws)).await.expect("create");

  svc
    .delete(master.id, ws, uid, DeleteScope::All)
    .await
    .expect("delete scope=all");

  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE id = $1")
    .bind(master.id)
    .fetch_one(&pool)
    .await
    .expect("count after delete");
  assert_eq!(count, 0, "scope=All delete must remove the event from DB");

  cleanup(&pool, ws, uid).await;
}

/// An authorized member of two workspaces must not be able to disguise an
/// event from one workspace as an update or delete in the other workspace.
#[tokio::test]
async fn inv_native_event_mutations_bind_the_event_to_the_authorized_workspace() {
  let Some((pool, svc, auth_store, uid, workspace)) = connect_svc().await else {
    return;
  };
  let other_workspace = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'svc-other-ws')")
    .bind(other_workspace)
    .bind(uid)
    .execute(&pool)
    .await
    .expect("seed second workspace");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Collaborator', 'Accepted', NOW())",
  )
  .bind(other_workspace)
  .bind(uid)
  .execute(&pool)
  .await
  .expect("seed second workspace membership");
  auth_store
    .add_or_update_member(
      other_workspace,
      uid,
      WorkspaceRole::Collaborator,
      MembershipStatus::Accepted,
      None,
    )
    .await
    .expect("seed second in-memory membership");

  let event = svc
    .create(workspace, uid, base_input(workspace))
    .await
    .expect("create event");
  let update_error = svc
    .update(
      event.id,
      other_workspace,
      uid,
      UpdateScope::All,
      NativeEventUpdate {
        title: Some(Some("cross-workspace mutation".to_string())),
        ..Default::default()
      },
    )
    .await
    .expect_err("cross-workspace update must fail");
  assert!(matches!(update_error, AuthError::ActionForbidden));

  let delete_error = svc
    .delete(event.id, other_workspace, uid, DeleteScope::All)
    .await
    .expect_err("cross-workspace delete must fail");
  assert!(matches!(delete_error, AuthError::ActionForbidden));
  let persisted_title: Option<String> = sqlx::query_scalar("SELECT title FROM calendar_events WHERE id = $1")
    .bind(event.id)
    .fetch_one(&pool)
    .await
    .expect("event must remain in its original workspace");
  assert_eq!(persisted_title.as_deref(), Some("Test Event"));

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(other_workspace)
    .execute(&pool)
    .await
    .expect("delete second workspace");
  cleanup(&pool, workspace, uid).await;
}
