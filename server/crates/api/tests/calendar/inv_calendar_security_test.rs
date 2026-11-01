// SPDX-License-Identifier: AGPL-3.0-or-later
//! P92-CAL-FIX-C-03 — Security invariant tests for calendar mutations.
//!
//! # Invariants tested
//!
//! * INV-CAL-SEC01: `updateCalendarEventRsvp` requires the caller to be a
//!   participant or member of the workspace that owns the event.  A user who
//!   does not own or share the event must receive an error.
//! * INV-CAL-SEC02: `updateCalendarEventInstance` requires workspace
//!   membership.  A foreign user must receive an error.
//! * INV-CAL-SEC03: `deleteCalendarEventInstance` requires workspace
//!   membership.  A foreign user must receive an error.
//!
//! # Status
//!
//! Ownership checks implemented in P92-CAL-FIX-B-04. Tests are green.

use crate::helpers;

use std::sync::Arc;

use axum::{body::Body, http::Request};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, AuthStore, AuthUser, InMemoryAuthStore, NewSession};
use myoxus_application::calendar::CalendarService;
use myoxus_application::doc::{DocService, PanicDocStore};
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use myoxus_infrastructure::mail::LogMailAdapter;

use helpers::DummyStorage;

// ── App factory ──────────────────────────────────────────────────────────────

async fn setup_test_app(pool: sqlx::PgPool) -> (axum::Router, Arc<InMemoryAuthStore>) {
  let config = AppConfig::load().expect("AppConfig must load");
  let auth_store = Arc::new(InMemoryAuthStore::default());
  let storage = Arc::new(DummyStorage);
  let auth_service = AuthService::new(
    auth_store.clone(),
    Arc::new(LogMailAdapter),
    storage.clone(),
    3600,
    3600,
  );
  let workspace_service = WorkspaceService::new(auth_store.clone());
  let admin_service = AdminService::new(Arc::new(InMemoryAdminStore));
  let doc_service = DocService::new(Arc::new(PanicDocStore));
  let blob_service = Arc::new(BlobService::new(
    Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(
      sqlx::PgPool::connect_lazy("postgres://localhost").expect("lazy pool"),
    )),
    storage.clone(),
    "test-sign-key".to_string(),
  ));

  let state = Arc::new(
    ApiState::with_services(
      config,
      auth_service,
      workspace_service,
      admin_service,
      doc_service,
      blob_service,
      storage,
    )
    .with_calendar_service(Arc::new(CalendarService::new(Arc::new(SqlxCalendarRepository::new(
      pool,
    ))))),
  );

  (build_router((*state).clone()), auth_store)
}

// ── Session factory ───────────────────────────────────────────────────────────

async fn create_session(store: &InMemoryAuthStore, email: &str) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: email.to_string(),
    name: Some(email.to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(Utc::now()),
    registered: true,
  });
  let session = store
    .create_session(NewSession {
      id: Uuid::new_v4(),
      user_id,
      csrf_token: "csrf".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: Utc::now() + Duration::hours(1),
      refresh_after: Utc::now() + Duration::minutes(30),
      created_at: Utc::now(),
    })
    .await
    .expect("session creation must succeed");
  (user_id, session.id)
}

// ── GraphQL helper ────────────────────────────────────────────────────────────

async fn graphql(app: &axum::Router, session_id: Uuid, payload: Value) -> Value {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(payload.to_string()))
        .expect("request"),
    )
    .await
    .expect("transport must not fail");
  let body = response.into_body().collect().await.expect("body").to_bytes();
  serde_json::from_slice(&body).expect("JSON")
}

// ── Seed helper ───────────────────────────────────────────────────────────────

/// Seed User A's calendar event in the DB; returns (user_a_id, account_id, event_id).
async fn seed_owner_event(pool: &sqlx::PgPool) -> (Uuid, Uuid, Uuid) {
  let user_a_id = Uuid::new_v4();
  let account_id = Uuid::new_v4();
  let event_id = Uuid::new_v4();
  let now = Utc::now();
  let email = format!("owner-{user_a_id}@sec.test");

  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_a_id)
    .bind(&email)
    .bind("Owner A")
    .execute(pool)
    .await
    .expect("seed owner");

  sqlx::query(
    "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config) VALUES ($1, $2, 'caldav', $3, '{}'::jsonb)",
  )
  .bind(account_id)
  .bind(user_a_id)
  .bind(format!("acc-{account_id}"))
  .execute(pool)
  .await
  .expect("seed account");

  sqlx::query(
    "INSERT INTO calendar_events (id, account_id, remote_event_id, starts_at, ends_at, title, payload)
     VALUES ($1, $2, $3, $4, $5, 'Owner Event', '{}'::jsonb)",
  )
  .bind(event_id)
  .bind(account_id)
  .bind(format!("uid-{event_id}"))
  .bind(now + Duration::hours(1))
  .bind(now + Duration::hours(2))
  .execute(pool)
  .await
  .expect("seed event");

  (user_a_id, account_id, event_id)
}

async fn cleanup_owner_event(pool: &sqlx::PgPool, user_a_id: Uuid, account_id: Uuid, event_id: Uuid) {
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
  sqlx::query("DELETE FROM calendar_accounts WHERE id = $1")
    .bind(account_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_a_id)
    .execute(pool)
    .await
    .ok();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// INV-CAL-SEC01: `updateCalendarEventRsvp` must reject callers who are not
/// participants/members of the event's workspace.
///
/// A foreign user (User B) who has a valid session but NO relationship to User
/// A's calendar event must receive an error, not a successful RSVP update.
///
/// Ownership check implemented in P92-CAL-FIX-B-04.
#[tokio::test]
async fn inv_cal_sec01_rsvp_requires_workspace_membership() {
  let pool = helpers::setup_pool().await;
  let (app, auth_store) = setup_test_app(pool.clone()).await;

  let (user_a_id, account_id, event_id) = seed_owner_event(&pool).await;

  // User B: valid session but unrelated to the event.
  let (_user_b_id, session_b) = create_session(&auth_store, "user-b-sec01@sec.test").await;

  let resp = graphql(
    &app,
    session_b,
    json!({
      "query": "mutation($eventId: String!, $status: CalendarRsvpStatus!) { updateCalendarEventRsvp(eventId: $eventId, status: $status) { id } }",
      "variables": { "eventId": event_id.to_string(), "status": "ACCEPTED" }
    }),
  )
  .await;

  // INV-CAL-SEC01: foreign user must receive an error.
  assert!(
    resp.get("errors").is_some(),
    "INV-CAL-SEC01: updateCalendarEventRsvp by foreign user must return errors, got: {resp}"
  );

  cleanup_owner_event(&pool, user_a_id, account_id, event_id).await;
}

/// INV-CAL-SEC02: `updateCalendarEventInstance` must reject callers who do not
/// own or share the event.
///
/// Ownership check implemented in P92-CAL-FIX-B-04.
#[tokio::test]
async fn inv_cal_sec02_instance_update_requires_membership() {
  let pool = helpers::setup_pool().await;
  let (app, auth_store) = setup_test_app(pool.clone()).await;

  let (user_a_id, account_id, event_id) = seed_owner_event(&pool).await;

  let (_user_b_id, session_b) = create_session(&auth_store, "user-b-sec02@sec.test").await;
  let instance_start = (Utc::now() + Duration::hours(1)).to_rfc3339();

  let resp = graphql(
    &app,
    session_b,
    json!({
      "query": "mutation($input: UpdateCalendarEventInstanceInput!) { updateCalendarEventInstance(input: $input) { ok } }",
      "variables": {
        "input": {
          "eventId": event_id.to_string(),
          "instanceStart": instance_start,
          "scope": "THIS_ONLY",
          "changes": {}
        }
      }
    }),
  )
  .await;

  // INV-CAL-SEC02: foreign user must receive an error.
  assert!(
    resp.get("errors").is_some(),
    "INV-CAL-SEC02: updateCalendarEventInstance by foreign user must return errors, got: {resp}"
  );

  cleanup_owner_event(&pool, user_a_id, account_id, event_id).await;
}

/// INV-CAL-SEC03: `deleteCalendarEventInstance` must reject callers who do not
/// own or share the event.
///
/// Ownership check implemented in P92-CAL-FIX-B-04.
#[tokio::test]
async fn inv_cal_sec03_delete_instance_requires_membership() {
  let pool = helpers::setup_pool().await;
  let (app, auth_store) = setup_test_app(pool.clone()).await;

  let (user_a_id, account_id, event_id) = seed_owner_event(&pool).await;

  let (_user_b_id, session_b) = create_session(&auth_store, "user-b-sec03@sec.test").await;
  let instance_start = (Utc::now() + Duration::hours(1)).to_rfc3339();

  let resp = graphql(
    &app,
    session_b,
    json!({
      "query": "mutation($eventId: String!, $instanceStart: DateTime!, $scope: InstanceEditScope!) { deleteCalendarEventInstance(eventId: $eventId, instanceStart: $instanceStart, scope: $scope) }",
      "variables": {
        "eventId": event_id.to_string(),
        "instanceStart": instance_start,
        "scope": "THIS_ONLY"
      }
    }),
  )
  .await;

  // INV-CAL-SEC03: foreign user must receive an error.
  assert!(
    resp.get("errors").is_some(),
    "INV-CAL-SEC03: deleteCalendarEventInstance by foreign user must return errors, got: {resp}"
  );

  cleanup_owner_event(&pool, user_a_id, account_id, event_id).await;
}
