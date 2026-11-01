//! Integration tests for INV-CAL-REALTIME-01 (P-JCAL-SERVER-04-D).
//!
//! INV-CAL-REALTIME-01: Every native-event mutation broadcasts
//! `calendar:event_changed` to all Socket.IO clients in the workspace room.
//!
//! We test this at the service level: a `RecordingCalendarBroadcast` is injected
//! via `NativeEventService::with_broadcast` and we verify that create / update /
//! delete each trigger exactly one `broadcast_event_changed` call with the
//! correct workspace ID and op.

use crate::helpers;

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;

use myoxus_application::auth::{AuthUser, InMemoryAuthStore};
use myoxus_application::calendar::{
  CalendarBroadcastPort, DeleteScope, NativeCreateInput, NativeEventService, UpdateScope,
};
use myoxus_application::workspace::WorkspaceStore as _;
use myoxus_domain::entities::{MembershipStatus, WorkspaceRole};
use myoxus_domain::ids::{CalendarEventId, WorkspaceId};
use myoxus_domain::repositories::NativeEventUpdate;
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use uuid::Uuid;

// ── Recording broadcast ────────────────────────────────────────────────────────

struct RecordingBroadcast {
  calls: Arc<Mutex<Vec<(WorkspaceId, CalendarEventId, String)>>>,
}

impl RecordingBroadcast {
  fn new() -> (Self, Arc<Mutex<Vec<(WorkspaceId, CalendarEventId, String)>>>) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    (Self { calls: calls.clone() }, calls)
  }
}

#[async_trait]
impl CalendarBroadcastPort for RecordingBroadcast {
  async fn broadcast_event_changed(&self, workspace_id: WorkspaceId, event_id: CalendarEventId, op: &str) {
    self
      .calls
      .lock()
      .unwrap()
      .push((workspace_id, event_id, op.to_string()));
  }
}

// ── Test helpers ───────────────────────────────────────────────────────────────

async fn setup(
  suffix: &str,
) -> (
  sqlx::PgPool,
  Arc<InMemoryAuthStore>,
  Uuid,
  Uuid,
  Arc<NativeEventService>,
  Arc<Mutex<Vec<(WorkspaceId, CalendarEventId, String)>>>,
) {
  let pool = helpers::setup_pool().await;
  let store = Arc::new(InMemoryAuthStore::default());
  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));

  let user_id = helpers::create_user(&pool, suffix, false).await;
  store.insert_user(AuthUser {
    id: user_id,
    email: format!("{suffix}_{user_id}@example.test"),
    name: Some("test".to_string()),
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: Some(Utc::now()),
    registered: true,
  });

  let ws_id = helpers::create_workspace(&pool, user_id).await;
  store
    .add_or_update_member(ws_id, user_id, WorkspaceRole::Owner, MembershipStatus::Accepted, None)
    .await
    .expect("member insert");

  let (recording, calls) = RecordingBroadcast::new();
  let svc = Arc::new(NativeEventService::new(repo, store.clone()).with_broadcast(Arc::new(recording)));

  (pool, store, user_id, ws_id, svc, calls)
}

fn make_event_input(_ws_id: Uuid) -> NativeCreateInput {
  NativeCreateInput {
    title: Some("Broadcast test".to_string()),
    description_delta: None,
    starts_at: Utc::now() + chrono::Duration::hours(1),
    ends_at: Utc::now() + chrono::Duration::hours(2),
    all_day: false,
    all_members: false,
    tag_id: None,
    source_doc_id: None,
    source_anchor: None,
    reminders: vec![],
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

/// INV-CAL-REALTIME-01: create triggers one broadcast with op="created".
#[tokio::test]
async fn inv_cal_realtime01_create_triggers_broadcast() {
  let (_pool, _store, user_id, ws_id, svc, calls) = setup("rt-create").await;

  let event = svc
    .create(ws_id, user_id, make_event_input(ws_id))
    .await
    .expect("create must succeed");

  let snapshot = calls.lock().unwrap().clone();
  assert_eq!(snapshot.len(), 1, "exactly one broadcast after create: {snapshot:?}");
  assert_eq!(snapshot[0].0, ws_id, "workspace_id must match");
  assert_eq!(snapshot[0].1, event.id, "event_id must match");
  assert_eq!(snapshot[0].2, "created", "op must be 'created'");

  // cleanup
  svc.delete(event.id, ws_id, user_id, DeleteScope::All).await.ok();
}

/// INV-CAL-REALTIME-01: update (scope=All) triggers one broadcast with op="updated".
#[tokio::test]
async fn inv_cal_realtime01_update_triggers_broadcast() {
  let (_pool, _store, user_id, ws_id, svc, calls) = setup("rt-update").await;

  let event = svc
    .create(ws_id, user_id, make_event_input(ws_id))
    .await
    .expect("create must succeed");

  calls.lock().unwrap().clear();

  svc
    .update(
      event.id,
      ws_id,
      user_id,
      UpdateScope::All,
      NativeEventUpdate {
        title: Some(Some("Updated".to_string())),
        ..Default::default()
      },
    )
    .await
    .expect("update must succeed");

  let snapshot = calls.lock().unwrap().clone();
  assert_eq!(snapshot.len(), 1, "exactly one broadcast after update: {snapshot:?}");
  assert_eq!(snapshot[0].2, "updated", "op must be 'updated'");

  // cleanup
  svc.delete(event.id, ws_id, user_id, DeleteScope::All).await.ok();
}

/// INV-CAL-REALTIME-01: delete (scope=All) triggers one broadcast with op="deleted".
#[tokio::test]
async fn inv_cal_realtime01_delete_triggers_broadcast() {
  let (_pool, _store, user_id, ws_id, svc, calls) = setup("rt-delete").await;

  let event = svc
    .create(ws_id, user_id, make_event_input(ws_id))
    .await
    .expect("create must succeed");

  calls.lock().unwrap().clear();

  svc
    .delete(event.id, ws_id, user_id, DeleteScope::All)
    .await
    .expect("delete must succeed");

  let snapshot = calls.lock().unwrap().clone();
  assert_eq!(snapshot.len(), 1, "exactly one broadcast after delete: {snapshot:?}");
  assert_eq!(snapshot[0].2, "deleted", "op must be 'deleted'");
}
