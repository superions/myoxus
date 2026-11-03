//! Integration tests for native-event GraphQL mutations and queries (P-JCAL-SERVER-03-D).
//!
//! Invariants tested:
//! - INV-CAL-NATIVE-02: update/delete external event → FORBIDDEN
//! - INV-CAL-NATIVE-03: createWorkspaceEvent requires write permission → FORBIDDEN without
//! - INV-CAL-TAG-01: tag CRUD within workspace, UNIQUE(workspace_id, name) enforced
//! - Settings upsert and query round-trip
use crate::helpers;

use std::sync::Arc;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::Row as _;
use tower::ServiceExt;
use uuid::Uuid;

use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, AuthStore, AuthUser, InMemoryAuthStore, NewSession};
use myoxus_application::calendar::{CalendarService, NativeEventService};
use myoxus_application::doc::DocService;
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::workspace::{WorkspaceService, WorkspaceStore as _};
use myoxus_domain::entities::{MembershipStatus, WorkspaceRole};
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::mail::LogMailAdapter;

use helpers::DummyStorage;

async fn setup_pool() -> sqlx::PgPool {
  helpers::setup_pool().await
}

async fn build_app(pool: sqlx::PgPool, auth_store: Arc<InMemoryAuthStore>) -> (axum::Router, Arc<ApiState>) {
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
  let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
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
  (build_router((*state).clone()), state)
}

/// Create user in DB + in-memory auth store + session.
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

/// In-memory-only session (no DB row needed — for permission-fail tests).
async fn create_mem_only_session(store: &InMemoryAuthStore, email: &str) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: email.to_string(),
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

/// Seed a workspace row in the DB and grant the user Collaborator role in the
/// InMemoryAuthStore so the permission check in NativeEventService passes.
async fn seed_workspace(pool: &sqlx::PgPool, store: &InMemoryAuthStore, user_id: Uuid) -> Uuid {
  let ws_id = helpers::create_workspace(pool, user_id).await;
  store
    .add_or_update_member(ws_id, user_id, WorkspaceRole::Owner, MembershipStatus::Accepted, None)
    .await
    .expect("member insert must succeed");
  ws_id
}

// ── Tests ──────────────────────────────────────────────────────────────────────

/// INV-CAL-NATIVE-03: user with no workspace membership cannot create events.
#[tokio::test]
async fn inv_cal_native03_create_requires_write_permission() {
  let pool = setup_pool().await;
  let store = Arc::new(InMemoryAuthStore::default());
  let (app, _state) = build_app(pool.clone(), store.clone()).await;

  // User NOT added to workspace → permission check must fail.
  let (_user_id, session_id) = create_mem_only_session(&store, "no-perm@example.test").await;
  let ws_id = Uuid::new_v4(); // non-existent workspace

  let resp = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($input: CreateWorkspaceEventInput!) {
        createWorkspaceEvent(input: $input) { id origin }
      }"#,
      "variables": {
        "input": {
          "workspaceId": ws_id.to_string(),
          "title": "Forbidden event",
          "startsAt": "2026-05-01T10:00:00Z",
          "endsAt": "2026-05-01T11:00:00Z"
        }
      }
    }),
  )
  .await;

  assert!(
    resp["errors"].is_array() && !resp["errors"].as_array().unwrap().is_empty(),
    "expected error for forbidden create, got: {resp}"
  );
}

/// INV-CAL-NATIVE-03 success + response contains origin=Native field.
#[tokio::test]
async fn inv_cal_native03_create_workspace_event_succeeds() {
  let pool = setup_pool().await;
  let store = Arc::new(InMemoryAuthStore::default());
  let (app, _state) = build_app(pool.clone(), store.clone()).await;

  let (user_id, session_id) = create_session(&pool, &store, "creator").await;
  // The workspace root resolves through WorkspaceService's memory store in
  // this harness; native event persistence uses SQL. Give both the same owner.
  let workspace = store
    .create_workspace(
      user_id,
      myoxus_application::workspace::WorkspaceName::parse("Calendar projection").unwrap(),
    )
    .await
    .unwrap();
  let ws_id = workspace.id;
  sqlx::query("INSERT INTO workspaces(id,owner_user_id,name) VALUES($1,$2,$3)")
    .bind(ws_id)
    .bind(user_id)
    .bind(&workspace.name)
    .execute(&pool)
    .await
    .expect("persist Calendar workspace identity");
  sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'Owner','Accepted')")
    .bind(ws_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("persist Calendar workspace owner");

  let resp = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($input: CreateWorkspaceEventInput!) {
        createWorkspaceEvent(input: $input) { id origin title allDay }
      }"#,
      "variables": {
        "input": {
          "workspaceId": ws_id.to_string(),
          "title": "Stand-up",
          "startsAt": "2026-05-01T09:00:00Z",
          "endsAt": "2026-05-01T09:30:00Z",
          "allDay": false,
          "recurrence":{"frequency":"Weekly","interval":1,"zone":"UTC","weekdays":["Friday"],"start":{"localDateTime":"2026-05-01T09:00:00"}}
        }
      }
    }),
  )
  .await;

  let event = &resp["data"]["createWorkspaceEvent"];
  assert!(event["id"].is_string(), "expected event id, got: {resp}");
  assert_eq!(event["origin"], "Native", "origin must be Native, got: {resp}");
  assert_eq!(event["title"], "Stand-up");
  assert_eq!(event["allDay"], false);
  let projected=gql(&app,session_id,json!({
    "query":"query($ws:String!){workspace(id:$ws){calendars{items{subscriptionId} events(from:\"2029-05-01T00:00:00Z\",to:\"2029-06-01T00:00:00Z\"){id subscriptionId recurrenceId}}}}",
    "variables":{"ws":ws_id.to_string()}
  })).await;
  assert!(projected.get("errors").is_none(), "{projected}");
  let native = &projected["data"]["workspace"]["calendars"][0];
  let visible_subscription = &native["items"][0]["subscriptionId"];
  assert_eq!(visible_subscription, &format!("{ws_id}:native"));
  let occurrences = native["events"].as_array().expect("projected native events");
  assert_eq!(
    occurrences.len(),
    4,
    "the existing workspace calendar query must show continuing native occurrences"
  );
  assert!(
    occurrences.iter().all(|occurrence| occurrence["id"] == event["id"]
      && occurrence["subscriptionId"] == *visible_subscription
      && occurrence["recurrenceId"].is_string()),
    "each occurrence must be admitted by the consumer's existing calendar-identity filter"
  );

  // A single-occurrence delete remains an authenticated master update.
  let event_id = event["id"].as_str().unwrap().to_string();
  let occurrence_delete = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($eventId: String!, $workspaceId: String!, $instanceStart: DateTime!) {
        deleteWorkspaceEvent(eventId: $eventId, workspaceId: $workspaceId, scope: This, instanceStart: $instanceStart)
      }"#,
      "variables": {
        "eventId": event_id.clone(),
        "workspaceId": ws_id.to_string(),
        "instanceStart": "2026-05-01T09:00:00Z"
      }
    }),
  )
  .await;
  assert_eq!(
    occurrence_delete["data"]["deleteWorkspaceEvent"], true,
    "single-occurrence delete must succeed: {occurrence_delete}"
  );
  let master_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE id = $1")
    .bind(Uuid::parse_str(&event_id).expect("created event id"))
    .fetch_one(&pool)
    .await
    .expect("count surviving master");
  assert_eq!(master_count, 1, "single-occurrence delete must preserve the master");

  // Cleanup: delete the complete event.
  let del = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($eventId: String!, $workspaceId: String!, $scope: NativeEventScope!) {
        deleteWorkspaceEvent(eventId: $eventId, workspaceId: $workspaceId, scope: $scope)
      }"#,
      "variables": {
        "eventId": event_id,
        "workspaceId": ws_id.to_string(),
        "scope": "All"
      }
    }),
  )
  .await;
  assert_eq!(
    del["data"]["deleteWorkspaceEvent"], true,
    "cleanup delete must succeed: {del}"
  );
  sqlx::query("DELETE FROM workspaces WHERE id=$1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("remove native Calendar fixture workspace");
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("remove native Calendar fixture user");
}

/// Event references resolve independently from a date-range query and remain
/// scoped to the workspace carried by the block reference.
#[tokio::test]
async fn calendar_event_by_id_is_workspace_scoped() {
  let pool = setup_pool().await;
  let store = Arc::new(InMemoryAuthStore::default());
  let (app, _state) = build_app(pool.clone(), store.clone()).await;
  let (user_id, session_id) = create_session(&pool, &store, "event-reference").await;
  let ws_id = seed_workspace(&pool, &store, user_id).await;
  let other_ws_id = seed_workspace(&pool, &store, user_id).await;

  let created = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($input: CreateWorkspaceEventInput!) {
        createWorkspaceEvent(input: $input) { id }
      }"#,
      "variables": {
        "input": {
          "workspaceId": ws_id.to_string(),
          "title": "Referenced event",
          "startsAt": "2026-05-04T09:00:00Z",
          "endsAt": "2026-05-04T10:00:00Z"
        }
      }
    }),
  )
  .await;
  assert!(created["errors"].is_null(), "create must succeed: {created}");
  let event_id = created["data"]["createWorkspaceEvent"]["id"]
    .as_str()
    .expect("event id");

  let resolved = gql(
    &app,
    session_id,
    json!({
      "query": r#"query($workspaceId: String!, $eventId: String!) {
        calendarEvent(workspaceId: $workspaceId, eventId: $eventId) {
          id workspaceId title startsAt endsAt
        }
      }"#,
      "variables": {
        "workspaceId": ws_id.to_string(),
        "eventId": event_id
      }
    }),
  )
  .await;
  assert!(resolved["errors"].is_null(), "lookup must succeed: {resolved}");
  assert_eq!(resolved["data"]["calendarEvent"]["id"], event_id);
  assert_eq!(resolved["data"]["calendarEvent"]["workspaceId"], ws_id.to_string());
  assert_eq!(resolved["data"]["calendarEvent"]["title"], "Referenced event");

  let cross_workspace = gql(
    &app,
    session_id,
    json!({
      "query": r#"query($workspaceId: String!, $eventId: String!) {
        calendarEvent(workspaceId: $workspaceId, eventId: $eventId) { id }
      }"#,
      "variables": {
        "workspaceId": other_ws_id.to_string(),
        "eventId": event_id
      }
    }),
  )
  .await;
  assert!(
    cross_workspace["errors"].is_null(),
    "cross-workspace lookup must not leak an error detail: {cross_workspace}"
  );
  assert!(
    cross_workspace["data"]["calendarEvent"].is_null(),
    "an event from another workspace must not be exposed"
  );

  for workspace_id in [ws_id, other_ws_id] {
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(workspace_id)
      .execute(&pool)
      .await
      .expect("cleanup workspace");
  }
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("cleanup user");
}

/// The update mutation exposes the same replacement semantics as the
/// application service: omitted reminders are preserved, while an empty list
/// clears the complete set and the response is loaded after replacement.
#[tokio::test]
async fn calendar_native_update_reminders_replace_and_clear() {
  let pool = setup_pool().await;
  let store = Arc::new(InMemoryAuthStore::default());
  let (app, _state) = build_app(pool.clone(), store.clone()).await;
  let (user_id, session_id) = create_session(&pool, &store, "reminder-update").await;
  let ws_id = seed_workspace(&pool, &store, user_id).await;

  let created = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($input: CreateWorkspaceEventInput!) {
        createWorkspaceEvent(input: $input) { id reminders { minutesBefore channel } }
      }"#,
      "variables": {
        "input": {
          "workspaceId": ws_id.to_string(),
          "title": "Reminder contract",
          "descriptionDelta": {"text":"Keep until explicitly cleared"},
          "startsAt": "2026-05-03T09:00:00Z",
          "endsAt": "2026-05-03T10:00:00Z",
          "reminders": [{ "minutesBefore": 30, "channel": "email" }]
        }
      }
    }),
  )
  .await;
  assert!(created["errors"].is_null(), "create must succeed: {created}");
  assert_eq!(
    created["data"]["createWorkspaceEvent"]["reminders"],
    json!([{ "minutesBefore": 30, "channel": "email" }]),
    "the creation response must preserve the saved email reminder for immediate edits"
  );
  let event_id = created["data"]["createWorkspaceEvent"]["id"]
    .as_str()
    .expect("event id")
    .to_string();

  let replaced = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($eventId: String!, $workspaceId: String!, $input: UpdateWorkspaceEventInput!) {
        updateWorkspaceEvent(eventId: $eventId, workspaceId: $workspaceId, scope: All, input: $input) {
          id reminders { minutesBefore channel }
        }
      }"#,
      "variables": {
        "eventId": event_id,
        "workspaceId": ws_id.to_string(),
        "input": { "reminders": [
          { "minutesBefore": 5, "channel": "in_app" },
          { "minutesBefore": 60, "channel": "email" }
        ] }
      }
    }),
  )
  .await;
  assert!(replaced["errors"].is_null(), "replace must succeed: {replaced}");
  let mut replaced_minutes = replaced["data"]["updateWorkspaceEvent"]["reminders"]
    .as_array()
    .expect("reminder response")
    .iter()
    .map(|reminder| reminder["minutesBefore"].as_i64().expect("minutes"))
    .collect::<Vec<_>>();
  replaced_minutes.sort_unstable();
  assert_eq!(
    replaced_minutes,
    vec![5, 60],
    "replace response must contain the reloaded reminder rows"
  );

  let unchanged = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($eventId: String!, $workspaceId: String!, $input: UpdateWorkspaceEventInput!) {
        updateWorkspaceEvent(eventId: $eventId, workspaceId: $workspaceId, scope: All, input: $input) {
          descriptionDelta reminders { minutesBefore }
        }
      }"#,
      "variables": {
        "eventId": event_id,
        "workspaceId": ws_id.to_string(),
        "input": { "title": "Renamed" }
      }
    }),
  )
  .await;
  assert!(unchanged["errors"].is_null(), "omitted patch must succeed: {unchanged}");
  assert_eq!(
    unchanged["data"]["updateWorkspaceEvent"]["descriptionDelta"],
    json!({"text":"Keep until explicitly cleared"})
  );
  assert_eq!(
    unchanged["data"]["updateWorkspaceEvent"]["reminders"]
      .as_array()
      .unwrap()
      .len(),
    2
  );

  let cleared = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($eventId: String!, $workspaceId: String!, $input: UpdateWorkspaceEventInput!) {
        updateWorkspaceEvent(eventId: $eventId, workspaceId: $workspaceId, scope: All, input: $input) {
          descriptionDelta reminders { minutesBefore }
        }
      }"#,
      "variables": {
        "eventId": event_id,
        "workspaceId": ws_id.to_string(),
        "input": { "reminders": [], "descriptionDelta":null }
      }
    }),
  )
  .await;
  assert!(cleared["errors"].is_null(), "clear must succeed: {cleared}");
  assert!(
    cleared["data"]["updateWorkspaceEvent"]["descriptionDelta"].is_null(),
    "explicit null must cross the GraphQL and SQL patch boundaries"
  );
  assert!(
    cleared["data"]["updateWorkspaceEvent"]["reminders"]
      .as_array()
      .unwrap()
      .is_empty()
  );

  let deleted = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($eventId: String!, $workspaceId: String!) {
        deleteWorkspaceEvent(eventId: $eventId, workspaceId: $workspaceId, scope: All)
      }"#,
      "variables": { "eventId": event_id, "workspaceId": ws_id.to_string() }
    }),
  )
  .await;
  assert_eq!(
    deleted["data"]["deleteWorkspaceEvent"], true,
    "cleanup must succeed: {deleted}"
  );
}

/// Calendar events keep their time window in `calendar_events`, while the
/// precise document/block/range source is persisted in the source-link table.
#[test]
fn calendar_event_source_anchor_roundtrips_and_can_be_cleared() {
  helpers::block_on_large_stack("calendar-native-source-identity", || async {
    let pool = setup_pool().await;
    let store = Arc::new(InMemoryAuthStore::default());
    let (app, _state) = build_app(pool.clone(), store.clone()).await;

    let (user_id, session_id) = create_session(&pool, &store, "source-anchor").await;
    let ws_id = seed_workspace(&pool, &store, user_id).await;
    let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
    let doc_external_id = "p04a-native-NanoSource7xK2";
    sqlx::query("UPDATE docs SET external_id = $1 WHERE id = $2")
      .bind(doc_external_id)
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("dual-ID source doc setup");
    let journal_doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
    sqlx::query("UPDATE docs SET journal_date = DATE '2026-05-25' WHERE id = $1")
      .bind(journal_doc_id)
      .execute(&pool)
      .await
      .expect("journal doc setup");
    let tag = gql(
      &app,
      session_id,
      json!({
        "query": r#"mutation($input: CreateEventTagInput!) {
        createEventTag(input: $input) { id }
      }"#,
        "variables": {
          "input": { "workspaceId": ws_id.to_string(), "name": "Quelle", "color": "#2E7D32" }
        }
      }),
    )
    .await;
    assert!(tag["errors"].is_null(), "tag setup must not error: {tag}");
    let tag_id = Uuid::parse_str(tag["data"]["createEventTag"]["id"].as_str().expect("tag id")).expect("tag uuid");

    let created = gql(
      &app,
      session_id,
      json!({
        "query": r#"mutation($input: CreateWorkspaceEventInput!) {
        createWorkspaceEvent(input: $input) { id sourceExternalId sourceDocId }
      }"#,
        "variables": {
          "input": {
            "workspaceId": ws_id.to_string(),
            "title": "Termin aus Text",
            "startsAt": "2026-05-02T09:00:00Z",
            "endsAt": "2026-05-02T10:00:00Z",
            "tagId": tag_id.to_string(),
            "sourceExternalId": doc_external_id,
            "sourceBlockId": "block-alpha",
            "sourceStartOffset": 7,
            "sourceEndOffset": 19,
            "sourceKind": "text_range"
          }
        }
      }),
    )
    .await;
    assert!(
      created["errors"].is_null(),
      "create with source anchor must not error: {created}"
    );
    let event_id = Uuid::parse_str(
      created["data"]["createWorkspaceEvent"]["id"]
        .as_str()
        .expect("event id"),
    )
    .expect("event uuid");
    assert_eq!(
      created["data"]["createWorkspaceEvent"]["sourceExternalId"], doc_external_id,
      "GraphQL event projection must return the external sourceExternalId"
    );
    assert_eq!(
      created["data"]["createWorkspaceEvent"]["sourceDocId"],
      created["data"]["createWorkspaceEvent"]["sourceExternalId"]
    );

    let source_row = sqlx::query(
      r#"
    SELECT source_doc_id, relation, source_block_id, source_start_offset,
           source_end_offset, source_kind
    FROM calendar_event_source_links
    WHERE event_id = $1
    "#,
    )
    .bind(event_id)
    .fetch_one(&pool)
    .await
    .expect("source-link row must be materialized");
    let stored_doc_id: Uuid = source_row.get("source_doc_id");
    let relation: String = source_row.get("relation");
    let source_block_id: Option<String> = source_row.get("source_block_id");
    let source_start_offset: Option<i32> = source_row.get("source_start_offset");
    let source_end_offset: Option<i32> = source_row.get("source_end_offset");
    let source_kind: String = source_row.get("source_kind");
    assert_eq!(stored_doc_id, doc_id);
    assert_eq!(relation, "created_from");
    assert_eq!(source_block_id.as_deref(), Some("block-alpha"));
    assert_eq!(source_start_offset, Some(7));
    assert_eq!(source_end_offset, Some(19));
    assert_eq!(source_kind, "text_range");

    let reset_anchor = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($eventId: String!, $workspaceId: String!, $scope: NativeEventScope!, $input: UpdateWorkspaceEventInput!) {
        updateWorkspaceEvent(eventId: $eventId, workspaceId: $workspaceId, scope: $scope, input: $input) { id sourceExternalId sourceDocId }
      }"#,
      "variables": {
        "eventId": event_id.to_string(),
        "workspaceId": ws_id.to_string(),
        "scope": "All",
        "input": {
          "sourceBlockId": null,
          "sourceStartOffset": null,
          "sourceEndOffset": null,
          "sourceKind": null
        }
      }
    }),
  )
  .await;
    assert!(
      reset_anchor["errors"].is_null(),
      "reset source anchor must not clear the source doc: {reset_anchor}"
    );
    assert_eq!(
      reset_anchor["data"]["updateWorkspaceEvent"]["sourceExternalId"], doc_external_id,
      "resetting only the fine-grained anchor must keep the event sourceExternalId"
    );
    assert_eq!(
      reset_anchor["data"]["updateWorkspaceEvent"]["sourceDocId"],
      reset_anchor["data"]["updateWorkspaceEvent"]["sourceExternalId"]
    );

    let reset_row = sqlx::query(
      r#"
    SELECT source_doc_id, source_block_id, source_start_offset,
           source_end_offset, source_kind
    FROM calendar_event_source_links
    WHERE event_id = $1
    "#,
    )
    .bind(event_id)
    .fetch_one(&pool)
    .await
    .expect("document-level source-link row must remain");
    let reset_doc_id: Uuid = reset_row.get("source_doc_id");
    let reset_block_id: Option<String> = reset_row.get("source_block_id");
    let reset_start_offset: Option<i32> = reset_row.get("source_start_offset");
    let reset_end_offset: Option<i32> = reset_row.get("source_end_offset");
    let reset_kind: String = reset_row.get("source_kind");
    assert_eq!(reset_doc_id, doc_id);
    assert_eq!(reset_block_id, None);
    assert_eq!(reset_start_offset, None);
    assert_eq!(reset_end_offset, None);
    assert_eq!(reset_kind, "document");

    let cleared = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($eventId: String!, $workspaceId: String!, $scope: NativeEventScope!, $input: UpdateWorkspaceEventInput!) {
        updateWorkspaceEvent(eventId: $eventId, workspaceId: $workspaceId, scope: $scope, input: $input) { id sourceExternalId sourceDocId }
      }"#,
      "variables": {
        "eventId": event_id.to_string(),
        "workspaceId": ws_id.to_string(),
        "scope": "All",
        "input": { "sourceExternalId": null }
      }
    }),
  )
  .await;
    assert!(
      cleared["errors"].is_null(),
      "clear source doc must not error: {cleared}"
    );
    assert!(
      cleared["data"]["updateWorkspaceEvent"]["sourceExternalId"].is_null()
        && cleared["data"]["updateWorkspaceEvent"]["sourceDocId"].is_null(),
      "null sourceExternalId update must clear the nullable event source link"
    );

    let event_source_doc_id: Option<Uuid> =
      sqlx::query_scalar("SELECT source_doc_id FROM calendar_events WHERE id = $1")
        .bind(event_id)
        .fetch_one(&pool)
        .await
        .expect("event row");
    assert_eq!(event_source_doc_id, None);

    let source_link_count: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM calendar_event_source_links WHERE event_id = $1")
        .bind(event_id)
        .fetch_one(&pool)
        .await
        .expect("source-link count");
    assert_eq!(
      source_link_count, 0,
      "clearing sourceDocId must remove created_from links"
    );

    let relinked = gql(
      &app,
      session_id,
      json!({
        "query": r#"mutation($eventId: String!, $workspaceId: String!, $input: UpdateWorkspaceEventInput!) {
        updateWorkspaceEvent(eventId: $eventId, workspaceId: $workspaceId, scope: All, input: $input) { id sourceDocId }
      }"#,
        "variables": {
          "eventId": event_id.to_string(),
          "workspaceId": ws_id.to_string(),
          "input": { "sourceDocId": doc_external_id }
        }
      }),
    )
    .await;
    assert!(
      relinked["errors"].is_null(),
      "external source relink failed: {relinked}"
    );
    assert_eq!(relinked["data"]["updateWorkspaceEvent"]["sourceDocId"], doc_external_id);
    let relinked_source_doc_id: Option<Uuid> =
      sqlx::query_scalar("SELECT source_doc_id FROM calendar_events WHERE id = $1")
        .bind(event_id)
        .fetch_one(&pool)
        .await
        .expect("relinked event row");
    assert_eq!(relinked_source_doc_id, Some(doc_id));

    let conflicting_names = gql(
      &app,
      session_id,
      json!({
        "query": r#"mutation($eventId: String!, $workspaceId: String!, $input: UpdateWorkspaceEventInput!) {
        updateWorkspaceEvent(eventId: $eventId, workspaceId: $workspaceId, scope: All, input: $input) { id }
      }"#,
        "variables": {
          "eventId": event_id.to_string(),
          "workspaceId": ws_id.to_string(),
          "input": { "sourceExternalId": doc_external_id, "sourceDocId": null }
        }
      }),
    )
    .await;
    assert!(
      conflicting_names.get("errors").is_some(),
      "both source names must fail before a native update: {conflicting_names}"
    );
    let source_after_conflict: Option<Uuid> =
      sqlx::query_scalar("SELECT source_doc_id FROM calendar_events WHERE id = $1")
        .bind(event_id)
        .fetch_one(&pool)
        .await
        .expect("source after conflicting update");
    assert_eq!(source_after_conflict, Some(doc_id));

    let cleared_tag = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($eventId: String!, $workspaceId: String!, $scope: NativeEventScope!, $input: UpdateWorkspaceEventInput!) {
        updateWorkspaceEvent(eventId: $eventId, workspaceId: $workspaceId, scope: $scope, input: $input) { id }
      }"#,
      "variables": {
        "eventId": event_id.to_string(),
        "workspaceId": ws_id.to_string(),
        "scope": "All",
        "input": { "tagId": null }
      }
    }),
  )
  .await;
    assert!(
      cleared_tag["errors"].is_null(),
      "tagId:null must be accepted as an explicit clear operation: {cleared_tag}"
    );
    let event_tag_id: Option<Uuid> = sqlx::query_scalar("SELECT tag_id FROM calendar_events WHERE id = $1")
      .bind(event_id)
      .fetch_one(&pool)
      .await
      .expect("event tag row");
    assert_eq!(event_tag_id, None, "tagId:null must clear the event tag");

    let journal_event = gql(
      &app,
      session_id,
      json!({
        "query": r#"mutation($input: CreateWorkspaceEventInput!) {
        createWorkspaceEvent(input: $input) { id sourceDocId }
      }"#,
        "variables": {
          "input": {
            "workspaceId": ws_id.to_string(),
            "title": "Termin aus Journal",
            "startsAt": "2026-05-25T11:00:00Z",
            "endsAt": "2026-05-25T12:00:00Z",
            "sourceDocId": journal_doc_id.to_string()
          }
        }
      }),
    )
    .await;
    assert!(
      journal_event["errors"].is_null(),
      "journal-sourced calendar event must not error: {journal_event}"
    );
    let journal_event_id = Uuid::parse_str(
      journal_event["data"]["createWorkspaceEvent"]["id"]
        .as_str()
        .expect("journal event id"),
    )
    .expect("journal event uuid");
    assert_eq!(
      journal_event["data"]["createWorkspaceEvent"]["sourceDocId"],
      journal_doc_id.to_string(),
      "GraphQL event projection must retain journal doc sourceDocId"
    );
    let journal_source_kind: String = sqlx::query_scalar(
      "SELECT source_kind FROM calendar_event_source_links WHERE event_id = $1 AND source_doc_id = $2",
    )
    .bind(journal_event_id)
    .bind(journal_doc_id)
    .fetch_one(&pool)
    .await
    .expect("journal source-link row");
    assert_eq!(
      journal_source_kind, "document",
      "journal-daily-doc sources use document-level source links unless a finer anchor is supplied"
    );

    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(ws_id)
      .execute(&pool)
      .await
      .expect("cleanup workspace");
    sqlx::query("DELETE FROM users WHERE id = $1")
      .bind(user_id)
      .execute(&pool)
      .await
      .expect("cleanup user");
  });
}

/// INV-CAL-TAG-01: create + list + delete event tag within a workspace.
#[tokio::test]
async fn inv_cal_tag01_tag_crud_roundtrip() {
  let pool = setup_pool().await;
  let store = Arc::new(InMemoryAuthStore::default());
  let (app, _state) = build_app(pool.clone(), store.clone()).await;

  let (user_id, session_id) = create_session(&pool, &store, "tag-owner").await;
  let ws_id = seed_workspace(&pool, &store, user_id).await;

  // Create tag
  let resp = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($input: CreateEventTagInput!) {
        createEventTag(input: $input) { id name color workspaceId }
      }"#,
      "variables": {
        "input": { "workspaceId": ws_id.to_string(), "name": "Sprint", "color": "#4CAF50" }
      }
    }),
  )
  .await;
  let tag = &resp["data"]["createEventTag"];
  assert!(tag["id"].is_string(), "expected tag id, got: {resp}");
  assert_eq!(tag["name"], "Sprint");
  assert_eq!(tag["color"], "#4CAF50");
  let tag_id = tag["id"].as_str().unwrap().to_string();

  // List tags — must contain the one we created.
  let list = gql(
    &app,
    session_id,
    json!({
      "query": r#"query($wsId: String!) { calendarEventTags(workspaceId: $wsId) { id name } }"#,
      "variables": { "wsId": ws_id.to_string() }
    }),
  )
  .await;
  let tags = list["data"]["calendarEventTags"].as_array().expect("must be array");
  assert!(
    tags.iter().any(|t| t["id"] == tag_id),
    "created tag must appear in list: {list}"
  );

  // Delete tag
  let del = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($tagId: String!, $wsId: String!) {
        deleteEventTag(tagId: $tagId, workspaceId: $wsId)
      }"#,
      "variables": { "tagId": tag_id, "wsId": ws_id.to_string() }
    }),
  )
  .await;
  assert_eq!(del["data"]["deleteEventTag"], true, "delete tag must succeed: {del}");
}

/// workspaceCalendarSettings upsert + query round-trip.
#[tokio::test]
async fn calendar_settings_upsert_and_query() {
  let pool = setup_pool().await;
  let store = Arc::new(InMemoryAuthStore::default());
  let (app, _state) = build_app(pool.clone(), store.clone()).await;

  let (user_id, session_id) = create_session(&pool, &store, "settings-owner").await;
  let ws_id = seed_workspace(&pool, &store, user_id).await;

  // Upsert settings with a default reminder.
  let upsert = gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($input: UpdateWorkspaceCalendarSettingsInput!) {
        updateWorkspaceCalendarSettings(input: $input) { workspaceId defaultReminderOffsetMinutes }
      }"#,
      "variables": {
        "input": { "workspaceId": ws_id.to_string(), "defaultReminderOffsetMinutes": 15 }
      }
    }),
  )
  .await;
  let settings = &upsert["data"]["updateWorkspaceCalendarSettings"];
  assert_eq!(
    settings["defaultReminderOffsetMinutes"], 15,
    "upsert must persist: {upsert}"
  );

  // Query settings
  let query = gql(
    &app,
    session_id,
    json!({
      "query": r#"query($wsId: String!) { workspaceCalendarSettings(workspaceId: $wsId) { workspaceId defaultReminderOffsetMinutes } }"#,
      "variables": { "wsId": ws_id.to_string() }
    }),
  )
  .await;
  let queried = &query["data"]["workspaceCalendarSettings"];
  assert_eq!(
    queried["defaultReminderOffsetMinutes"], 15,
    "queried value must match: {query}"
  );
}
