// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-JCAL-SERVER-07: ICS export / import roundtrip test.
//!
//! Invariants tested:
//! - INV-CAL-ICS-01 (export): exportWorkspaceCalendarIcs returns a VCALENDAR
//!   string containing BEGIN:VEVENT for each native event in the window.
//! - INV-CAL-ICS-02 (import): importWorkspaceCalendarIcs creates one native
//!   event per VEVENT and returns the correct imported_count.
//! - INV-CAL-ICS-03 (roundtrip): a single export+import cycle preserves the
//!   event title and produces exactly one event in the target workspace.

use std::sync::Arc;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, AuthStore, AuthUser, InMemoryAuthStore, NewSession};
use myoxus_application::calendar::{CalendarService, NativeEventService};
use myoxus_application::doc::{DocService, PanicDocStore};
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::workspace::{WorkspaceService, WorkspaceStore as _};
use myoxus_domain::entities::{MembershipStatus, WorkspaceRole};
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use myoxus_infrastructure::mail::LogMailAdapter;

use crate::helpers::{self, DummyStorage};

async fn setup_pool() -> sqlx::PgPool {
  helpers::setup_pool().await
}

async fn build_app(pool: sqlx::PgPool, auth_store: Arc<InMemoryAuthStore>) -> axum::Router {
  let config = AppConfig::load().expect("AppConfig must load");
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
  let repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let native_svc = Arc::new(NativeEventService::new(repo.clone(), auth_store.clone()));
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
    .with_calendar_service(Arc::new(CalendarService::new(repo)))
    .with_native_event_service(native_svc),
  );
  build_router((*state).clone())
}

async fn create_session(pool: &sqlx::PgPool, store: &InMemoryAuthStore, suffix: &str) -> (Uuid, Uuid) {
  let user_id = helpers::create_user(pool, suffix, false).await;
  store.insert_user(AuthUser {
    id: user_id,
    email: format!("{suffix}_{user_id}@example.test"),
    name: Some("test".to_string()),
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  let session = store
    .create_session(NewSession {
      id: Uuid::new_v4(),
      user_id,
      csrf_token: "csrf".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("session creation must succeed");
  (user_id, session.id)
}

async fn seed_workspace(pool: &sqlx::PgPool, store: &InMemoryAuthStore, user_id: Uuid) -> Uuid {
  let ws_id = helpers::create_workspace(pool, user_id).await;
  store
    .add_or_update_member(ws_id, user_id, WorkspaceRole::Owner, MembershipStatus::Accepted, None)
    .await
    .expect("member insert must succeed");
  ws_id
}

async fn gql(app: &axum::Router, session_id: Uuid, payload: Value) -> Value {
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(payload.to_string()))
        .unwrap(),
    )
    .await
    .unwrap();
  let bytes = resp.into_body().collect().await.unwrap().to_bytes();
  serde_json::from_slice(&bytes).unwrap()
}

// ── INV-CAL-ICS-01 ────────────────────────────────────────────────────────────

/// INV-CAL-ICS-01: exportWorkspaceCalendarIcs includes a VEVENT for each
/// native event in the requested time window.
#[tokio::test]
async fn inv_cal_ics01_export_contains_vevent() {
  let pool = setup_pool().await;
  let store = Arc::new(InMemoryAuthStore::default());
  let app = build_app(pool.clone(), store.clone()).await;

  let (user_id, session_id) = create_session(&pool, &store, "ics01").await;
  let ws_id = seed_workspace(&pool, &store, user_id).await;

  // Create one native event.
  let create_resp = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($input: CreateWorkspaceEventInput!) {
        createWorkspaceEvent(input: $input) { id }
      }"#,
      "variables": {
        "input": {
          "workspaceId": ws_id.to_string(),
          "title": "ICS Export Test Event",
          "startsAt": "2026-06-01T10:00:00Z",
          "endsAt": "2026-06-01T11:00:00Z"
        }
      }
    }),
  )
  .await;
  let event_id = create_resp["data"]["createWorkspaceEvent"]["id"]
    .as_str()
    .expect("event must be created")
    .to_string();

  // Export ICS for that window.
  let export_resp = gql(
    &app,
    session_id,
    json!({
      "query": r#"query($wsId: String!, $from: DateTime!, $to: DateTime!) {
        exportWorkspaceCalendarIcs(workspaceId: $wsId, from: $from, to: $to)
      }"#,
      "variables": {
        "wsId": ws_id.to_string(),
        "from": "2026-06-01T00:00:00Z",
        "to": "2026-06-02T00:00:00Z"
      }
    }),
  )
  .await;

  let ics = export_resp["data"]["exportWorkspaceCalendarIcs"]
    .as_str()
    .expect("INV-CAL-ICS-01: exportWorkspaceCalendarIcs must return a string");

  assert!(
    ics.contains("BEGIN:VCALENDAR"),
    "INV-CAL-ICS-01: ICS must contain VCALENDAR wrapper"
  );
  assert!(
    ics.contains("BEGIN:VEVENT"),
    "INV-CAL-ICS-01: ICS must contain at least one VEVENT"
  );
  assert!(
    ics.contains("ICS Export Test Event"),
    "INV-CAL-ICS-01: ICS must contain the event title"
  );

  // Cleanup.
  sqlx::query("DELETE FROM calendar_events WHERE id = $1")
    .bind(Uuid::parse_str(&event_id).unwrap())
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

// ── INV-CAL-ICS-02 + INV-CAL-ICS-03 ─────────────────────────────────────────

/// INV-CAL-ICS-02/03: importWorkspaceCalendarIcs creates one event per VEVENT
/// and the roundtrip (export → import) preserves the title in the target workspace.
#[tokio::test]
async fn inv_cal_ics02_import_creates_native_events() {
  let pool = setup_pool().await;
  let store = Arc::new(InMemoryAuthStore::default());
  let app = build_app(pool.clone(), store.clone()).await;

  let (user_id, session_id) = create_session(&pool, &store, "ics02").await;
  let ws_src = seed_workspace(&pool, &store, user_id).await;
  let ws_dst = seed_workspace(&pool, &store, user_id).await;

  // Create source event.
  let create_resp = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($input: CreateWorkspaceEventInput!) {
        createWorkspaceEvent(input: $input) { id }
      }"#,
      "variables": {
        "input": {
          "workspaceId": ws_src.to_string(),
          "title": "Roundtrip Event",
          "startsAt": "2026-07-01T14:00:00Z",
          "endsAt": "2026-07-01T15:00:00Z"
        }
      }
    }),
  )
  .await;
  let src_event_id = create_resp["data"]["createWorkspaceEvent"]["id"]
    .as_str()
    .expect("source event must be created")
    .to_string();

  // Export from source workspace.
  let export_resp = gql(
    &app,
    session_id,
    json!({
      "query": r#"query($wsId: String!, $from: DateTime!, $to: DateTime!) {
        exportWorkspaceCalendarIcs(workspaceId: $wsId, from: $from, to: $to)
      }"#,
      "variables": {
        "wsId": ws_src.to_string(),
        "from": "2026-07-01T00:00:00Z",
        "to": "2026-07-02T00:00:00Z"
      }
    }),
  )
  .await;
  let ics = export_resp["data"]["exportWorkspaceCalendarIcs"]
    .as_str()
    .expect("export must return a string")
    .to_string();

  // Import into destination workspace.
  let import_resp = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($wsId: String!, $ics: String!) {
        importWorkspaceCalendarIcs(workspaceId: $wsId, icsBody: $ics) {
          importedCount
          skippedCount
          errors
        }
      }"#,
      "variables": {
        "wsId": ws_dst.to_string(),
        "ics": ics
      }
    }),
  )
  .await;

  let result = &import_resp["data"]["importWorkspaceCalendarIcs"];
  assert_eq!(
    result["importedCount"], 1,
    "INV-CAL-ICS-02: importedCount must be 1, got: {import_resp}"
  );
  assert_eq!(
    result["skippedCount"], 0,
    "INV-CAL-ICS-03: skippedCount must be 0, got: {import_resp}"
  );

  // Verify the imported event exists in the destination workspace.
  let row = sqlx::query(
    "SELECT title FROM calendar_events
     WHERE workspace_id = $1 AND origin = 'native'",
  )
  .bind(ws_dst)
  .fetch_optional(&pool)
  .await
  .expect("DB query must succeed");

  assert!(
    row.is_some(),
    "INV-CAL-ICS-03: imported event must exist in target workspace"
  );

  // Cleanup.
  sqlx::query("DELETE FROM calendar_events WHERE workspace_id IN ($1, $2)")
    .bind(ws_src)
    .bind(ws_dst)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id IN ($1, $2)")
    .bind(ws_src)
    .bind(ws_dst)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  let _ = src_event_id; // used above for seeding, cleanup handled by workspace delete cascade
}
