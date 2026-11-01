//! Integration tests for the calendar GraphQL resolvers (event listing, reminder ack).
use crate::helpers;

use std::sync::Arc;

use axum::{
  body::Body,
  http::{Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, AuthStore, AuthUser, InMemoryAuthStore, NewSession};
use myoxus_application::calendar::CalendarService;
use myoxus_application::doc::DocService;
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::mail::LogMailAdapter;

use helpers::DummyStorage;

async fn setup_pool() -> sqlx::PgPool {
  helpers::setup_pool().await
}

async fn setup_test_app(pool: sqlx::PgPool) -> (axum::Router, Arc<ApiState>, Arc<InMemoryAuthStore>) {
  let config = AppConfig::load().expect("AppConfig must load successfully");
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
  let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
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
    .with_html_catalog(Arc::new(
      myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html"),
      ),
    ))
    .with_calendar_service(Arc::new(CalendarService::new(Arc::new(SqlxCalendarRepository::new(
      pool,
    ))))),
  );

  (build_router((*state).clone()), state, auth_store)
}

/// Create a user in both the real DB (satisfies FK on calendar_accounts) and
/// the in-memory auth store (satisfies session middleware), returning (user_id, session_id).
async fn seed_user_db_and_mem(pool: &sqlx::PgPool, store: &InMemoryAuthStore, suffix: &str) -> (Uuid, Uuid) {
  let user_id = helpers::create_user(pool, suffix, false).await;
  store.insert_user(AuthUser {
    id: user_id,
    email: format!("{suffix}_{user_id}@example.test"),
    name: Some(suffix.to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
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

async fn create_user_session(store: &InMemoryAuthStore, email: &str) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: email.to_string(),
    name: Some(email.to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
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
        .expect("request body must be constructible"),
    )
    .await
    .expect("GraphQL request must not fail at transport level");

  let body = response
    .into_body()
    .collect()
    .await
    .expect("response body must be collectable")
    .to_bytes();
  serde_json::from_slice(&body).expect("response body must be valid JSON")
}

async fn calendar_rest(
  app: &axum::Router,
  session_id: Uuid,
  method: Method,
  uri: &str,
  payload: Option<Value>,
) -> (StatusCode, Value) {
  let mut request = Request::builder()
    .method(method)
    .uri(uri)
    .header("cookie", format!("affine_session={session_id}"));
  let body = match payload {
    Some(payload) => {
      request = request.header("content-type", "application/json");
      Body::from(payload.to_string())
    }
    None => Body::empty(),
  };
  let response = app
    .clone()
    .oneshot(request.body(body).expect("REST request must be constructible"))
    .await
    .expect("REST request must not fail at transport level");
  let status = response.status();
  let body = response
    .into_body()
    .collect()
    .await
    .expect("REST response body must be collectable")
    .to_bytes();
  let value = if body.is_empty() {
    Value::Null
  } else {
    serde_json::from_slice(&body).expect("REST response body must be valid JSON")
  };
  (status, value)
}

#[test]
fn graphql_calendar_crud_and_reminder_status_flow() {
  helpers::block_on_large_stack("graphql-calendar-crud-source-identity", || async {
    let pool = setup_pool().await;
    let (app, state, auth_store) = setup_test_app(pool.clone()).await;
    // Upsert the test user so the test is idempotent across runs.
    let user_id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active') \
     ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    )
    .bind(user_id)
    .bind("calendar-owner@example.com")
    .bind("Owner")
    .execute(&pool)
    .await
    .expect("upsert user");
    // Re-fetch the canonical user_id in case the email already existed.
    let user_id: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE lower(email) = lower($1)")
      .bind("calendar-owner@example.com")
      .fetch_one(&pool)
      .await
      .expect("fetch user id");
    let session_id = {
      auth_store.insert_user(AuthUser {
        id: user_id,
        email: "calendar-owner@example.com".to_string(),
        name: Some("Owner".to_string()),
        avatar_url: None,
        password_hash: Some("hash".to_string()),
        is_admin: false,
        disabled: false,
        email_verified_at: Some(chrono::Utc::now()),
        registered: true,
      });
      auth_store
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
        .expect("session")
        .id
    };
    let workspace = state
      .workspace()
      .create_workspace(user_id, Some("Calendar WS".to_string()), None)
      .await
      .expect("workspace creation");

    let doc_id = Uuid::new_v4();
    let doc_external_id = "p04a-upsert-NanoSource8mQ4";
    sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
      .bind(workspace.id)
      .bind(user_id)
      .bind("Calendar WS")
      .execute(&pool)
      .await
      .expect("seed workspace");
    sqlx::query(
        "INSERT INTO docs (id, external_id, workspace_id, title, is_workspace_root, created_by, updated_by) VALUES ($1, $2, $3, $4, false, $5, $5)",
    )
    .bind(doc_id)
    .bind(doc_external_id)
    .bind(workspace.id)
    .bind("Calendar Source")
    .bind(user_id)
    .execute(&pool)
  .await
  .expect("seed doc");
    let collision_decoy_id = Uuid::new_v4();
    let collision_target_id = Uuid::new_v4();
    let collision_external_id = collision_decoy_id.to_string();
    for (id, external_id, title) in [
      (collision_decoy_id, "p04a-calendar-decoy", "Collision Decoy"),
      (collision_target_id, collision_external_id.as_str(), "Collision Target"),
    ] {
      sqlx::query(
        "INSERT INTO docs (id, external_id, workspace_id, title, is_workspace_root, created_by, updated_by)
       VALUES ($1, $2, $3, $4, false, $5, $5)",
      )
      .bind(id)
      .bind(external_id)
      .bind(workspace.id)
      .bind(title)
      .bind(user_id)
      .execute(&pool)
      .await
      .expect("seed collision document");
    }
    let cross_workspace_id = helpers::create_workspace(&pool, user_id).await;
    let cross_source_id = Uuid::new_v4();
    let cross_external_id = "p04a-cross-workspace-source";
    sqlx::query(
      "INSERT INTO docs (id, external_id, workspace_id, title, is_workspace_root, created_by, updated_by)
     VALUES ($1, $2, $3, 'Cross Workspace Source', false, $4, $4)",
    )
    .bind(cross_source_id)
    .bind(cross_external_id)
    .bind(cross_workspace_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("seed cross-workspace source");

    let oauth_link = graphql(
        &app,
        session_id,
        json!({"query":"mutation($input: LinkCalendarAccountInput!){ linkCalendarAccount(input:$input) }","variables":{"input":{"provider":"Google","redirectUri":"https://example.com/calendar/callback"}}}),
    )
    .await;
    assert!(oauth_link.get("errors").is_none(), "unexpected errors: {oauth_link}");
    assert!(
      oauth_link["data"]["linkCalendarAccount"]
        .as_str()
        .unwrap_or_default()
        .contains("oauth/google/authorize")
    );

    let linked = graphql(
        &app,
        session_id,
        json!({"query":"mutation($input: LinkCalDAVAccountInput!){ linkCalDAVAccount(input:$input){ id provider providerAccountId status refreshIntervalMinutes calendarsCount } }","variables":{"input":{"providerPresetId":"generic","username":"owner@example.test","password":"secret","displayName":"Owner CalDAV"}}}),
    )
    .await;
    assert!(linked.get("errors").is_none(), "unexpected errors: {linked}");
    let account_id = linked["data"]["linkCalDAVAccount"]["id"]
      .as_str()
      .expect("account id")
      .to_string();
    // Upsert foreign user + canonical account so the test is idempotent.
    let _foreign_user_seed_id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active') \
     ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name",
    )
    .bind(_foreign_user_seed_id)
    .bind("calendar-foreign@example.com")
    .bind("Foreign")
    .execute(&pool)
    .await
    .expect("upsert foreign user");
    let foreign_user_id: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE lower(email) = lower($1)")
      .bind("calendar-foreign@example.com")
      .fetch_one(&pool)
      .await
      .expect("fetch foreign user id");
    let _foreign_account_seed_id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config) \
     VALUES ($1, $2, $3, $4, '{}'::jsonb) \
     ON CONFLICT (provider, remote_account_id) DO NOTHING",
    )
    .bind(_foreign_account_seed_id)
    .bind(foreign_user_id)
    .bind("google")
    .bind("acc-foreign")
    .execute(&pool)
    .await
    .expect("seed foreign calendar account");
    let foreign_account_id: Uuid =
      sqlx::query_scalar("SELECT id FROM calendar_accounts WHERE provider = $1 AND remote_account_id = $2")
        .bind("google")
        .bind("acc-foreign")
        .fetch_one(&pool)
        .await
        .expect("fetch foreign account id");
    sqlx::query(
      "INSERT INTO calendar_subscriptions \
       (id, account_id, remote_calendar_id, webhook_channel, sync_token, updated_at) \
     VALUES ($1, $2, $3, NULL, NULL, now()) \
     ON CONFLICT (account_id, remote_calendar_id) DO NOTHING",
    )
    .bind(Uuid::new_v4())
    .bind(Uuid::parse_str(&account_id).expect("valid account id"))
    .bind("primary")
    .execute(&pool)
    .await
    .expect("seed calendar subscription");

    let providers = graphql(
        &app,
        session_id,
        json!({"query":"query { serverConfig { calendarProviders calendarCalDAVProviders { id label requiresAppPassword docsUrl } } }"}),
    )
    .await;
    assert!(providers.get("errors").is_none(), "unexpected errors: {providers}");
    assert!(
      providers["data"]["serverConfig"]["calendarProviders"]
        .as_array()
        .expect("calendarProviders must be an array")
        .iter()
        .any(|v| v == "CalDAV")
    );
    assert_eq!(
      providers["data"]["serverConfig"]["calendarCalDAVProviders"][0]["id"],
      "generic"
    );

    let accounts_query = graphql(
        &app,
        session_id,
        json!({"query":"query { currentUser { calendarAccounts { id provider providerAccountId calendarsCount calendars { id accountId externalCalendarId enabled } } } }"}),
    )
    .await;
    assert!(
      accounts_query.get("errors").is_none(),
      "unexpected errors: {accounts_query}"
    );
    let subscription_id = accounts_query["data"]["currentUser"]["calendarAccounts"][0]["calendars"][0]["id"]
      .as_str()
      .expect("subscription id")
      .to_string();

    let updated_account = graphql(
        &app,
        session_id,
        json!({
            "query":"mutation($accountId: String!, $refreshIntervalMinutes: Int!){ updateCalendarAccount(accountId:$accountId, refreshIntervalMinutes:$refreshIntervalMinutes){ id refreshIntervalMinutes } }",
            "variables":{
                "accountId": account_id,
                "refreshIntervalMinutes": 30
            }
        }),
    )
    .await;
    assert!(
      updated_account.get("errors").is_none(),
      "unexpected errors: {updated_account}"
    );
    assert_eq!(
      updated_account["data"]["updateCalendarAccount"]["refreshIntervalMinutes"],
      30
    );

    let foreign_upsert = graphql(
      &app,
      session_id,
      json!({
          "query":"mutation($input: CalendarEventInput!){ upsertCalendarEvent(input:$input){ id } }",
          "variables":{
              "input":{
                  "accountId": foreign_account_id.to_string(),
                  "workspaceId": workspace.id.to_string(),
                  "remoteEventId":"evt-foreign",
                  "startsAt": (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
                  "endsAt": (chrono::Utc::now() + chrono::Duration::hours(2)).to_rfc3339(),
                  "title":"Foreign",
                  "participants":[],
                  "reminders":[]
              }
          }
      }),
    )
    .await;
    assert!(
      foreign_upsert.get("errors").is_some(),
      "expected ownership error: {foreign_upsert}"
    );

    let foreign_workspace_calendars = graphql(
      &app,
      session_id,
      json!({
          "query":"mutation($input: UpdateWorkspaceCalendarsInput!){ updateWorkspaceCalendars(input:$input){ id } }",
          "variables":{
              "input":{
                  "workspaceId": workspace.id.to_string(),
                  "items":[{"subscriptionId": format!("{}:foreign", foreign_account_id), "sortOrder": 0}]
              }
          }
      }),
    )
    .await;
    assert!(
      foreign_workspace_calendars.get("errors").is_some(),
      "expected ownership error: {foreign_workspace_calendars}"
    );

    let invalid_upsert_range = graphql(
      &app,
      session_id,
      json!({
          "query":"mutation($input: CalendarEventInput!){ upsertCalendarEvent(input:$input){ id } }",
          "variables":{
              "input":{
                  "accountId": account_id,
                  "workspaceId": workspace.id.to_string(),
                  "remoteEventId":"evt-invalid-range",
                  "startsAt": (chrono::Utc::now() + chrono::Duration::hours(3)).to_rfc3339(),
                  "endsAt": (chrono::Utc::now() + chrono::Duration::hours(2)).to_rfc3339(),
                  "title":"Invalid Range",
                  "participants":[],
                  "reminders":[]
              }
          }
      }),
    )
    .await;
    assert!(
      invalid_upsert_range.get("errors").is_some(),
      "expected range validation error: {invalid_upsert_range}"
    );

    let upsert = graphql(
        &app,
        session_id,
        json!({
            "query":"mutation($input: CalendarEventInput!){ upsertCalendarEvent(input:$input){ id title sourceExternalId sourceDocId reminders { id channel deliveredAt } participants { email } } }",
            "variables":{
                "input":{
                    "accountId": account_id,
                    "workspaceId": workspace.id.to_string(),
                    "remoteEventId":"evt-1",
                    "startsAt": (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
                    "endsAt": (chrono::Utc::now() + chrono::Duration::hours(2)).to_rfc3339(),
                    "title":"Planning",
                    "sourceExternalId": doc_external_id,
                    "participants":[{"email":"guest@example.test","isOrganizer":false}],
                    "reminders":[{"channel":"in_app","minutesBefore":30,"scheduledFor":(chrono::Utc::now() + chrono::Duration::minutes(30)).to_rfc3339()}]
                }
            }
        }),
    )
    .await;
    assert!(upsert.get("errors").is_none(), "unexpected errors: {upsert}");
    assert_eq!(
      upsert["data"]["upsertCalendarEvent"]["sourceExternalId"],
      doc_external_id
    );
    assert_eq!(
      upsert["data"]["upsertCalendarEvent"]["sourceDocId"],
      upsert["data"]["upsertCalendarEvent"]["sourceExternalId"]
    );
    let upsert_event_id = Uuid::parse_str(
      upsert["data"]["upsertCalendarEvent"]["id"]
        .as_str()
        .expect("upsert event id"),
    )
    .expect("upsert event UUID");
    let stored_source_doc_id: Option<Uuid> =
      sqlx::query_scalar("SELECT source_doc_id FROM calendar_events WHERE id = $1")
        .bind(upsert_event_id)
        .fetch_one(&pool)
        .await
        .expect("upserted calendar event");
    assert_eq!(stored_source_doc_id, Some(doc_id));

    let conflicting_names = graphql(
      &app,
      session_id,
      json!({
        "query": "mutation($input: CalendarEventInput!){ upsertCalendarEvent(input:$input){ id } }",
        "variables": {"input": {
          "accountId": account_id,
          "workspaceId": workspace.id.to_string(),
          "remoteEventId": "evt-both-names",
          "startsAt": (chrono::Utc::now() + chrono::Duration::hours(3)).to_rfc3339(),
          "endsAt": (chrono::Utc::now() + chrono::Duration::hours(4)).to_rfc3339(),
          "title": "Conflicting Source Names",
          "sourceExternalId": doc_external_id,
          "sourceDocId": null,
          "participants": [],
          "reminders": []
        }}
      }),
    )
    .await;
    assert!(
      conflicting_names.get("errors").is_some(),
      "both source names must fail even when the alias is null: {conflicting_names}"
    );
    let conflicting_write_count: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE remote_event_id = 'evt-both-names'")
        .fetch_one(&pool)
        .await
        .expect("conflicting source write count");
    assert_eq!(conflicting_write_count, 0, "conflicting source names wrote an event");

    for (index, rejected_source) in [doc_id.to_string(), cross_external_id.to_string()]
      .into_iter()
      .enumerate()
    {
      let rejected = graphql(
        &app,
        session_id,
        json!({
          "query": "mutation($input: CalendarEventInput!){ upsertCalendarEvent(input:$input){ id } }",
          "variables": {"input": {
            "accountId": account_id,
            "workspaceId": workspace.id.to_string(),
            "remoteEventId": format!("evt-rejected-{index}"),
            "startsAt": (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            "endsAt": (chrono::Utc::now() + chrono::Duration::hours(2)).to_rfc3339(),
            "title": "Rejected Source",
            "sourceExternalId": rejected_source,
            "participants": [],
            "reminders": []
          }}
        }),
      )
      .await;
      assert!(
        rejected.get("errors").is_some(),
        "internal-only/cross-workspace source unexpectedly resolved: {rejected}"
      );
    }

    let collision = graphql(
      &app,
      session_id,
      json!({
        "query": "mutation($input: CalendarEventInput!){ upsertCalendarEvent(input:$input){ id sourceExternalId sourceDocId } }",
        "variables": {"input": {
          "accountId": account_id,
          "workspaceId": workspace.id.to_string(),
          "remoteEventId": "evt-collision",
          "startsAt": (chrono::Utc::now() + chrono::Duration::hours(12)).to_rfc3339(),
          "endsAt": (chrono::Utc::now() + chrono::Duration::hours(13)).to_rfc3339(),
          "title": "Collision Source",
          "sourceDocId": collision_external_id,
          "participants": [],
          "reminders": []
        }}
      }),
    )
    .await;
    assert!(
      collision.get("errors").is_none(),
      "collision source failed: {collision}"
    );
    assert_eq!(
      collision["data"]["upsertCalendarEvent"]["sourceExternalId"],
      collision_external_id
    );
    assert_eq!(
      collision["data"]["upsertCalendarEvent"]["sourceDocId"],
      collision["data"]["upsertCalendarEvent"]["sourceExternalId"]
    );
    let collision_event_id = Uuid::parse_str(
      collision["data"]["upsertCalendarEvent"]["id"]
        .as_str()
        .expect("collision event id"),
    )
    .expect("collision event UUID");
    let collision_stored_source: Option<Uuid> =
      sqlx::query_scalar("SELECT source_doc_id FROM calendar_events WHERE id = $1")
        .bind(collision_event_id)
        .fetch_one(&pool)
        .await
        .expect("collision event row");
    assert_eq!(collision_stored_source, Some(collision_target_id));

    let conflict = graphql(
    &app,
    session_id,
    json!({
      "query": "mutation($eventId:String!){ resolveCalendarConflict(eventId:$eventId,resolution:KeepLocal){ id sourceExternalId sourceDocId } }",
      "variables": {"eventId": upsert_event_id.to_string()}
    }),
  )
  .await;
    assert!(conflict.get("errors").is_none(), "conflict readback failed: {conflict}");
    assert_eq!(
      conflict["data"]["resolveCalendarConflict"]["sourceExternalId"],
      doc_external_id
    );
    assert_eq!(
      conflict["data"]["resolveCalendarConflict"]["sourceDocId"],
      conflict["data"]["resolveCalendarConflict"]["sourceExternalId"]
    );
    let reminder_id = upsert["data"]["upsertCalendarEvent"]["reminders"][0]["id"]
      .as_str()
      .expect("reminder id")
      .to_string();

    let workspace_calendars = graphql(
        &app,
        session_id,
        json!({
            "query":"mutation($input: UpdateWorkspaceCalendarsInput!){ updateWorkspaceCalendars(input:$input){ id workspaceId enabled items { subscriptionId enabled } } }",
            "variables":{
                "input":{
                    "workspaceId": workspace.id.to_string(),
                    "items":[{"subscriptionId": subscription_id, "sortOrder": 0, "colorOverride": "#00aa00"}]
                }
            }
        }),
    )
    .await;
    assert!(
      workspace_calendars.get("errors").is_none(),
      "unexpected errors: {workspace_calendars}"
    );
    assert_eq!(
      workspace_calendars["data"]["updateWorkspaceCalendars"]["workspaceId"],
      workspace.id.to_string()
    );

    let list = graphql(
        &app,
        session_id,
        json!({
            "query":"query($workspaceId:String!,$from:DateTime!,$to:DateTime!){ workspace(id:$workspaceId){ calendars { id events(from:$from,to:$to){ id externalEventId startAtUtc endAtUtc reminders { id channel minutesBefore scheduledFor deliveredAt } } } } }",
            "variables":{
                "workspaceId": workspace.id.to_string(),
                "from": (chrono::Utc::now()).to_rfc3339(),
                "to": (chrono::Utc::now() + chrono::Duration::hours(6)).to_rfc3339()
            }
        }),
    )
    .await;
    assert!(list.get("errors").is_none(), "unexpected errors: {list}");
    // workspace.calendars now always begins with the virtual native calendar (index 0).
    // The CalDAV subscription calendar is at index 1+. Sum events across all calendars.
    let total_events: usize = list["data"]["workspace"]["calendars"]
      .as_array()
      .expect("calendars must be an array")
      .iter()
      .flat_map(|cal| cal["events"].as_array().unwrap_or(&vec![]).to_vec())
      .count();
    assert_eq!(
      total_events, 1,
      "expected exactly 1 event across all workspace calendars"
    );
    let listed_reminders = list["data"]["workspace"]["calendars"]
      .as_array()
      .expect("calendars must be an array")
      .iter()
      .flat_map(|calendar| calendar["events"].as_array().expect("events must be an array").iter())
      .flat_map(|event| {
        event["reminders"]
          .as_array()
          .expect("reminders must be an array")
          .iter()
      })
      .collect::<Vec<_>>();
    assert_eq!(listed_reminders.len(), 1);
    assert_eq!(listed_reminders[0]["minutesBefore"], 30);
    assert_eq!(listed_reminders[0]["channel"], "in_app");

    let invalid_list_range = graphql(
        &app,
        session_id,
        json!({
            "query":"query($workspaceId:String!,$from:DateTime!,$to:DateTime!){ workspace(id:$workspaceId){ calendars { events(from:$from,to:$to){ id } } } }",
            "variables":{
                "workspaceId": workspace.id.to_string(),
                "from": (chrono::Utc::now() + chrono::Duration::hours(6)).to_rfc3339(),
                "to": (chrono::Utc::now()).to_rfc3339()
            }
        }),
    )
    .await;
    assert!(
      invalid_list_range.get("errors").is_some(),
      "expected query range validation error: {invalid_list_range}"
    );

    let workspace_calendars_list = graphql(
        &app,
        session_id,
        json!({
            "query":"query($workspaceId:String!){ workspace(id:$workspaceId){ calendars { id items { subscriptionId } enabled } } }",
            "variables":{"workspaceId": workspace.id.to_string()}
        }),
    )
    .await;
    assert!(
      workspace_calendars_list.get("errors").is_none(),
      "unexpected errors: {workspace_calendars_list}"
    );
    // workspace.calendars always begins with the virtual native calendar; find the CalDAV one.
    let caldav_calendar = workspace_calendars_list["data"]["workspace"]["calendars"]
      .as_array()
      .expect("calendars must be an array")
      .iter()
      .find(|cal| {
        cal["items"]
          .as_array()
          .map(|items| items.iter().any(|item| item["subscriptionId"] == subscription_id))
          .unwrap_or(false)
      })
      .expect("CalDAV calendar with subscription_id must be present");
    assert_eq!(caldav_calendar["items"][0]["subscriptionId"], subscription_id);

    let status = app
      .clone()
      .oneshot(
        Request::builder()
          .method("PUT")
          .uri(format!(
            "/api/workspaces/{}/calendar/reminders/{}/status",
            workspace.id, reminder_id
          ))
          .header("content-type", "application/json")
          .header("cookie", format!("affine_session={session_id}"))
          .body(Body::from("{\"delivered\":true}"))
          .expect("reminder status request body must be constructible"),
      )
      .await
      .expect("reminder status request must not fail at transport level");
    assert_eq!(status.status(), axum::http::StatusCode::OK);

    let after = graphql(
        &app,
        session_id,
        json!({
            "query":"query($workspaceId:String!,$from:DateTime!,$to:DateTime!){ calendarEvents(workspaceId:$workspaceId, from:$from, to:$to){ id sourceExternalId sourceDocId reminders { id deliveredAt } } }",
            "variables":{
                "workspaceId": workspace.id.to_string(),
                "from": (chrono::Utc::now()).to_rfc3339(),
                "to": (chrono::Utc::now() + chrono::Duration::hours(6)).to_rfc3339()
            }
        }),
    )
    .await;
    assert!(after.get("errors").is_none(), "unexpected errors: {after}");
    let upsert_readback = after["data"]["calendarEvents"]
      .as_array()
      .expect("calendar event list")
      .iter()
      .find(|event| event["id"] == upsert_event_id.to_string())
      .expect("upsert event readback");
    assert_eq!(upsert_readback["sourceExternalId"], doc_external_id);
    assert_eq!(upsert_readback["sourceDocId"], upsert_readback["sourceExternalId"]);
    assert!(upsert_readback["reminders"][0]["deliveredAt"].is_string());

    sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("soft-delete source document");
    let missing_source = graphql(
    &app,
    session_id,
    json!({
      "query": "query($workspaceId:String!,$eventId:String!){ calendarEvent(workspaceId:$workspaceId,eventId:$eventId){ id sourceExternalId sourceDocId } }",
      "variables": {
        "workspaceId": workspace.id.to_string(),
        "eventId": upsert_event_id.to_string()
      }
    }),
  )
  .await;
    assert!(
      missing_source.get("errors").is_none(),
      "missing-source projection failed: {missing_source}"
    );
    assert!(
      missing_source["data"]["calendarEvent"]["sourceExternalId"].is_null()
        && missing_source["data"]["calendarEvent"]["sourceDocId"].is_null(),
      "deleted source must project null without UUID fallback: {missing_source}"
    );

    let unlink = graphql(
      &app,
      session_id,
      json!({
          "query":"mutation($id:String!){ unlinkCalendarAccount(accountId:$id) }",
          "variables":{"id": account_id}
      }),
    )
    .await;
    assert!(unlink.get("errors").is_none(), "unexpected errors: {unlink}");
    assert_eq!(unlink["data"]["unlinkCalendarAccount"], true);

    // ── Cleanup ────────────────────────────────────────────────────────────────
    sqlx::query(
      "DELETE FROM calendar_reminders WHERE event_id IN (SELECT id FROM calendar_events WHERE workspace_id = $1)",
    )
    .bind(workspace.id)
    .execute(&pool)
    .await
    .expect("cleanup calendar reminders");
    sqlx::query("DELETE FROM calendar_event_participants WHERE event_id IN (SELECT id FROM calendar_events WHERE workspace_id = $1)")
    .bind(workspace.id).execute(&pool).await.expect("cleanup calendar participants");
    sqlx::query("DELETE FROM calendar_events WHERE workspace_id = $1")
      .bind(workspace.id)
      .execute(&pool)
      .await
      .expect("cleanup calendar events");
    sqlx::query("DELETE FROM workspace_calendars WHERE workspace_id = $1")
      .bind(workspace.id)
      .execute(&pool)
      .await
      .expect("cleanup workspace calendars");
    sqlx::query(
    "DELETE FROM calendar_subscriptions WHERE account_id IN (SELECT id FROM calendar_accounts WHERE user_id = ANY($1))",
  )
  .bind(&[user_id, foreign_user_id][..])
  .execute(&pool)
  .await
  .expect("cleanup calendar subscriptions");
    sqlx::query("DELETE FROM calendar_accounts WHERE user_id = ANY($1)")
      .bind(&[user_id, foreign_user_id][..])
      .execute(&pool)
      .await
      .expect("cleanup calendar accounts");
    sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
      .bind(workspace.id)
      .execute(&pool)
      .await
      .expect("cleanup workspace documents");
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(workspace.id)
      .execute(&pool)
      .await
      .expect("cleanup workspace");
    helpers::cleanup_workspaces(&pool, &[cross_workspace_id]).await;
    sqlx::query("DELETE FROM users WHERE id = ANY($1)")
      .bind(&[user_id, foreign_user_id][..])
      .execute(&pool)
      .await
      .expect("cleanup calendar users");
  });
}

#[test]
fn calendar_rest_source_document_key_roundtrip() {
  helpers::block_on_large_stack("calendar-rest-source-identity", || async {
    let pool = setup_pool().await;
    let (app, state, auth_store) = setup_test_app(pool.clone()).await;
    let (user_id, session_id) = seed_user_db_and_mem(&pool, &auth_store, "calendar_rest_identity").await;
    let workspace = state
      .workspace()
      .create_workspace(user_id, Some("Calendar REST Identity".to_string()), None)
      .await
      .expect("workspace creation");
    sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
      .bind(workspace.id)
      .bind(user_id)
      .bind("Calendar REST Identity")
      .execute(&pool)
      .await
      .expect("seed REST workspace");

    let nano_doc_id = Uuid::new_v4();
    let nano_external_id = "p04b-rest-NanoSource7rX9";
    let uuid_default_doc_id = Uuid::new_v4();
    let uuid_default_external_id = uuid_default_doc_id.to_string();
    let collision_decoy_id = Uuid::new_v4();
    let collision_target_id = Uuid::new_v4();
    let collision_external_id = collision_decoy_id.to_string();
    for (id, external_id, title) in [
      (nano_doc_id, nano_external_id, "Nano source"),
      (
        uuid_default_doc_id,
        uuid_default_external_id.as_str(),
        "UUID-default source",
      ),
      (collision_decoy_id, "p04b-rest-collision-decoy", "Collision decoy"),
      (collision_target_id, collision_external_id.as_str(), "Collision target"),
    ] {
      sqlx::query(
        "INSERT INTO docs (id, external_id, workspace_id, title, is_workspace_root, created_by, updated_by)
         VALUES ($1, $2, $3, $4, false, $5, $5)",
      )
      .bind(id)
      .bind(external_id)
      .bind(workspace.id)
      .bind(title)
      .bind(user_id)
      .execute(&pool)
      .await
      .expect("seed REST source document");
    }
    let cross_workspace_id = helpers::create_workspace(&pool, user_id).await;
    let cross_doc_id = Uuid::new_v4();
    let cross_external_id = "p04b-rest-cross-workspace";
    sqlx::query(
      "INSERT INTO docs (id, external_id, workspace_id, title, is_workspace_root, created_by, updated_by)
       VALUES ($1, $2, $3, 'Cross source', false, $4, $4)",
    )
    .bind(cross_doc_id)
    .bind(cross_external_id)
    .bind(cross_workspace_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("seed cross-workspace REST source");

    let account_id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config)
       VALUES ($1, $2, 'caldav', $3, '{}'::jsonb)",
    )
    .bind(account_id)
    .bind(user_id)
    .bind(format!("p04b-rest-{account_id}"))
    .execute(&pool)
    .await
    .expect("seed REST calendar account");

    let event_id = Uuid::new_v4();
    let events_uri = format!("/api/workspaces/{}/calendar/events", workspace.id);
    let event_uri = format!("{events_uri}/{event_id}");
    let event_body = |id: Uuid, remote_event_id: &str, title: &str| {
      json!({
        "id": id.to_string(),
        "accountId": account_id.to_string(),
        "remoteEventId": remote_event_id,
        "startsAt": "2035-05-01T10:00:00Z",
        "endsAt": "2035-05-01T11:00:00Z",
        "title": title
      })
    };
    let with_source = |mut body: Value, field: &str, value: Value| {
      body[field] = value;
      body
    };

    let (status, created) = calendar_rest(
      &app,
      session_id,
      Method::POST,
      &events_uri,
      Some(with_source(
        event_body(event_id, "p04b-rest-nano", "REST Nano create"),
        "sourceExternalId",
        Value::String(nano_external_id.to_string()),
      )),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "Nano create failed: {created}");
    assert_eq!(created["source_external_id"], nano_external_id);
    assert_eq!(created["source_doc_id"], created["source_external_id"]);
    assert_eq!(created["id"], event_id.to_string());
    assert_eq!(created["account_id"], account_id.to_string());
    assert_eq!(created["workspace_id"], workspace.id.to_string());
    assert_eq!(created["remote_event_id"], "p04b-rest-nano");
    assert_eq!(created["title"], "REST Nano create");
    assert_eq!(created["origin"], "external");
    assert_eq!(created["payload"], json!({}));
    assert_eq!(created["participants"], json!([]));
    assert_eq!(created["reminders"], json!([]));
    let mut response_fields = created
      .as_object()
      .expect("REST event must be an object")
      .keys()
      .map(String::as_str)
      .collect::<Vec<_>>();
    response_fields.sort_unstable();
    let mut expected_fields = vec![
      "account_id",
      "all_day",
      "all_members",
      "description",
      "description_delta",
      "ends_at",
      "etag",
      "id",
      "location",
      "origin",
      "participants",
      "payload",
      "recurrence_parent_id",
      "reminders",
      "remote_event_id",
      "remote_href",
      "source_doc_id",
      "source_external_id",
      "starts_at",
      "tag_id",
      "title",
      "updated_at",
      "workspace_id",
    ];
    expected_fields.sort_unstable();
    assert_eq!(response_fields, expected_fields, "REST event JSON shape changed");
    assert!(created.get("sourceExternalId").is_none());
    assert!(created.get("sourceDocId").is_none());
    let stored_source: Option<Uuid> = sqlx::query_scalar("SELECT source_doc_id FROM calendar_events WHERE id = $1")
      .bind(event_id)
      .fetch_one(&pool)
      .await
      .expect("created REST event row");
    assert_eq!(stored_source, Some(nano_doc_id));
    let stored_event = state
      .calendar()
      .expect("calendar service")
      .get_event(event_id)
      .await
      .expect("load stored REST event")
      .expect("stored REST event must exist");
    let mut expected_created = serde_json::to_value(stored_event).expect("serialize stored REST event");
    expected_created["source_doc_id"] = Value::String(nano_external_id.to_string());
    expected_created["source_external_id"] = Value::String(nano_external_id.to_string());
    assert_eq!(
      created, expected_created,
      "REST projection must preserve every unrelated event field and value"
    );

    let (status, collision) = calendar_rest(
      &app,
      session_id,
      Method::PUT,
      &event_uri,
      Some(with_source(
        event_body(event_id, "p04b-rest-nano", "REST collision update"),
        "sourceExternalId",
        Value::String(collision_external_id.clone()),
      )),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "collision update failed: {collision}");
    assert_eq!(collision["source_external_id"], collision_external_id);
    assert_eq!(collision["source_doc_id"], collision["source_external_id"]);
    assert_eq!(collision["title"], "REST collision update");
    let stored_collision: Option<Uuid> = sqlx::query_scalar("SELECT source_doc_id FROM calendar_events WHERE id = $1")
      .bind(event_id)
      .fetch_one(&pool)
      .await
      .expect("collision REST event row");
    assert_eq!(stored_collision, Some(collision_target_id));

    let (status, cleared) = calendar_rest(
      &app,
      session_id,
      Method::PUT,
      &event_uri,
      Some(with_source(
        event_body(event_id, "p04b-rest-nano", "REST clear"),
        "sourceExternalId",
        Value::Null,
      )),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "clear failed: {cleared}");
    assert!(cleared["source_external_id"].is_null() && cleared["source_doc_id"].is_null());
    let stored_clear: Option<Uuid> = sqlx::query_scalar("SELECT source_doc_id FROM calendar_events WHERE id = $1")
      .bind(event_id)
      .fetch_one(&pool)
      .await
      .expect("cleared REST event row");
    assert_eq!(stored_clear, None);

    let (status, relinked) = calendar_rest(
      &app,
      session_id,
      Method::PUT,
      &event_uri,
      Some(with_source(
        event_body(event_id, "p04b-rest-nano", "REST legacy relink"),
        "sourceDocId",
        Value::String(nano_external_id.to_string()),
      )),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "relink failed: {relinked}");
    assert_eq!(relinked["source_external_id"], nano_external_id);
    assert_eq!(relinked["source_doc_id"], relinked["source_external_id"]);

    let (status, omitted) = calendar_rest(
      &app,
      session_id,
      Method::PUT,
      &event_uri,
      Some(event_body(event_id, "p04b-rest-nano", "REST omitted source")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "omitted source update failed: {omitted}");
    assert!(omitted["source_external_id"].is_null() && omitted["source_doc_id"].is_null());

    let (status, relinked) = calendar_rest(
      &app,
      session_id,
      Method::PUT,
      &event_uri,
      Some(with_source(
        event_body(event_id, "p04b-rest-nano", "REST canonical relink"),
        "sourceExternalId",
        Value::String(nano_external_id.to_string()),
      )),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "canonical relink failed: {relinked}");
    assert_eq!(relinked["source_external_id"], nano_external_id);
    assert_eq!(relinked["source_doc_id"], relinked["source_external_id"]);

    let uuid_event_id = Uuid::new_v4();
    let (status, uuid_created) = calendar_rest(
      &app,
      session_id,
      Method::POST,
      &events_uri,
      Some(with_source(
        event_body(uuid_event_id, "p04b-rest-uuid-default", "REST legacy UUID-default"),
        "sourceDocId",
        Value::String(uuid_default_external_id.clone()),
      )),
    )
    .await;
    assert_eq!(
      status,
      StatusCode::CREATED,
      "UUID-default create failed: {uuid_created}"
    );
    assert_eq!(uuid_created["source_external_id"], uuid_default_external_id);
    assert_eq!(uuid_created["source_doc_id"], uuid_created["source_external_id"]);
    let stored_uuid_default: Option<Uuid> =
      sqlx::query_scalar("SELECT source_doc_id FROM calendar_events WHERE id = $1")
        .bind(uuid_event_id)
        .fetch_one(&pool)
        .await
        .expect("UUID-default REST event row");
    assert_eq!(stored_uuid_default, Some(uuid_default_doc_id));

    let conflicting_event_id = Uuid::new_v4();
    let mut conflicting_body = with_source(
      event_body(conflicting_event_id, "p04b-rest-both-names", "REST both names"),
      "sourceExternalId",
      Value::String(nano_external_id.to_string()),
    );
    conflicting_body["sourceDocId"] = Value::Null;
    let (status, conflicting) =
      calendar_rest(&app, session_id, Method::POST, &events_uri, Some(conflicting_body)).await;
    assert_eq!(
      status,
      StatusCode::BAD_REQUEST,
      "both source names must fail even when the alias is null: {conflicting}"
    );
    let conflicting_write_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE id = $1")
      .bind(conflicting_event_id)
      .fetch_one(&pool)
      .await
      .expect("conflicting REST source write count");
    assert_eq!(
      conflicting_write_count, 0,
      "conflicting REST source names wrote an event"
    );

    for (index, rejected_source) in [nano_doc_id.to_string(), cross_external_id.to_string()]
      .into_iter()
      .enumerate()
    {
      let rejected_event_id = Uuid::new_v4();
      let (status, body) = calendar_rest(
        &app,
        session_id,
        Method::POST,
        &events_uri,
        Some(with_source(
          event_body(
            rejected_event_id,
            &format!("p04b-rest-rejected-{index}"),
            "REST rejected",
          ),
          "sourceExternalId",
          Value::String(rejected_source),
        )),
      )
      .await;
      assert_eq!(status, StatusCode::BAD_REQUEST, "source unexpectedly resolved: {body}");
      let written: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE id = $1")
        .bind(rejected_event_id)
        .fetch_one(&pool)
        .await
        .expect("count rejected REST event");
      assert_eq!(written, 0, "rejected source must not write an event");
    }

    let list_uri = format!("{events_uri}?from=2035-05-01T00:00:00Z&to=2035-05-02T00:00:00Z");
    let (status, listed) = calendar_rest(&app, session_id, Method::GET, &list_uri, None).await;
    assert_eq!(status, StatusCode::OK, "REST list failed: {listed}");
    let listed = listed.as_array().expect("REST list must be an array");
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().any(|event| {
      event["id"] == event_id.to_string()
        && event["source_external_id"] == nano_external_id
        && event["source_doc_id"] == event["source_external_id"]
    }));
    assert!(listed.iter().any(|event| {
      event["id"] == uuid_event_id.to_string()
        && event["source_external_id"] == uuid_default_external_id
        && event["source_doc_id"] == event["source_external_id"]
    }));

    sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
      .bind(nano_doc_id)
      .execute(&pool)
      .await
      .expect("soft-delete REST source");
    let (status, listed_after_delete) = calendar_rest(&app, session_id, Method::GET, &list_uri, None).await;
    assert_eq!(status, StatusCode::OK, "REST list after source deletion failed");
    let deleted_projection = listed_after_delete
      .as_array()
      .expect("REST list must be an array")
      .iter()
      .find(|event| event["id"] == event_id.to_string())
      .expect("Nano event must remain listed");
    assert!(
      deleted_projection["source_external_id"].is_null() && deleted_projection["source_doc_id"].is_null(),
      "missing source must not fall back to internal UUID: {deleted_projection}"
    );

    sqlx::query("DELETE FROM calendar_events WHERE workspace_id = $1")
      .bind(workspace.id)
      .execute(&pool)
      .await
      .expect("cleanup REST events");
    sqlx::query("DELETE FROM calendar_accounts WHERE id = $1")
      .bind(account_id)
      .execute(&pool)
      .await
      .expect("cleanup REST account");
    sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
      .bind(workspace.id)
      .execute(&pool)
      .await
      .expect("cleanup REST documents");
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(workspace.id)
      .execute(&pool)
      .await
      .expect("cleanup REST workspace");
    helpers::cleanup_workspaces(&pool, &[cross_workspace_id]).await;
    helpers::cleanup_users(&pool, &[user_id]).await;
  });
}

// ---------------------------------------------------------------------------
// P83-K-04: Error-path tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_calendar_query_unauthenticated_returns_error() {
  let pool = setup_pool().await;
  let (app, _state, _auth_store) = setup_test_app(pool.clone()).await;

  // Query with nil UUID = unauthenticated
  let resp = helpers::gql(
    &app,
    Uuid::nil(),
    json!({
      "query": "query { currentUser { calendars { accounts { id } } } }"
    }),
  )
  .await;

  let is_error = resp.get("errors").is_some() || resp["data"]["currentUser"].is_null() || resp["data"].is_null();
  assert!(
    is_error,
    "unauthenticated calendar query must fail or return null, got: {resp}"
  );
}

#[tokio::test]
async fn inv_calendar_query_foreign_user_returns_empty_or_error() {
  let pool = setup_pool().await;
  let (app, _state, auth_store) = setup_test_app(pool.clone()).await;
  let (user_id, _user_session) = seed_user_db_and_mem(&pool, &auth_store, "cal_own").await;
  let (foreign_id, foreign_session) = seed_user_db_and_mem(&pool, &auth_store, "cal_for").await;

  // Create a calendar account for user_id
  let account_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config) VALUES ($1, $2, 'caldav', 'test', '{}'::jsonb)"
  )
  .bind(account_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert calendar account");

  // Foreign user queries their own calendar — should see their (empty) list, not user_id's
  let resp = helpers::gql(
    &app,
    foreign_session,
    json!({
      "query": "query { currentUser { calendars { accounts { id } } } }"
    }),
  )
  .await;

  let accounts = &resp["data"]["currentUser"]["calendars"]["accounts"];
  assert!(
    accounts.is_null() || accounts.as_array().is_none_or(|a| a.is_empty()),
    "foreign user must not see other user's calendar accounts, got: {resp}"
  );

  sqlx::query("DELETE FROM calendar_accounts WHERE id = $1")
    .bind(account_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user_id, foreign_id]).await;
}

/// The actual response tier must render every state and write only valid tokens.
#[tokio::test]
async fn calendar_rsvp_external_pages_preserve_http_and_participant_state() {
  use myoxus_api::handlers::calendar::imip_sign_token;
  let pool = setup_pool().await;
  let (app, state, _) = setup_test_app(pool.clone()).await;
  let user = helpers::create_user(&pool, "external-rsvp", false).await;
  let account = Uuid::new_v4();
  let event = Uuid::new_v4();
  let participant = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO calendar_accounts(id,user_id,provider,remote_account_id,config) VALUES($1,$2,'caldav',$3,'{}')",
  )
  .bind(account)
  .bind(user)
  .bind(account.to_string())
  .execute(&pool)
  .await
  .expect("seed account");
  sqlx::query("INSERT INTO calendar_events(id,account_id,remote_event_id,title,starts_at,ends_at,payload) VALUES($1,$2,$3,$4,now(),now()+interval '1 hour','{}')")
    .bind(event).bind(account).bind(event.to_string()).bind("<Event & owner>").execute(&pool).await.expect("seed event");
  sqlx::query("INSERT INTO calendar_event_participants(id,event_id,user_id,email,response_status) VALUES($1,$2,$3,'rsvp@example.test','NEEDS-ACTION')")
    .bind(participant).bind(event).bind(user).execute(&pool).await.expect("seed participant");
  let expiry = chrono::Utc::now().timestamp() + 300;
  let token = |event_id, status: &str, expires| {
    imip_sign_token(event_id, user, status, expires, &state.config.crypto.private_key)
  };
  for (link, code, expected, partstat) in [
    (
      "invalid".to_string(),
      StatusCode::BAD_REQUEST,
      "invalid or has expired",
      "NEEDS-ACTION",
    ),
    (
      token(event, "accepted", expiry - 600),
      StatusCode::BAD_REQUEST,
      "invalid or has expired",
      "NEEDS-ACTION",
    ),
    (
      token(event, "<unknown>", expiry),
      StatusCode::BAD_REQUEST,
      "&lt;unknown&gt;",
      "NEEDS-ACTION",
    ),
    (
      token(Uuid::new_v4(), "accepted", expiry),
      StatusCode::BAD_REQUEST,
      "Could not process RSVP",
      "NEEDS-ACTION",
    ),
    (
      token(event, "accepted", expiry),
      StatusCode::OK,
      "accepted the invitation",
      "ACCEPTED",
    ),
    (
      token(event, "declined", expiry),
      StatusCode::OK,
      "declined the invitation",
      "DECLINED",
    ),
    (
      token(event, "tentative", expiry),
      StatusCode::OK,
      "tentatively accepted",
      "TENTATIVE",
    ),
    (
      token(event, "needs_action", expiry),
      StatusCode::OK,
      "marked as pending",
      "NEEDS-ACTION",
    ),
  ] {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .uri(format!("/api/calendar/rsvp/{link}"))
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    assert_eq!(response.status(), code);
    assert_eq!(response.headers()["content-type"], "text/html; charset=utf-8");
    let html = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(html.starts_with("<!doctype html>"));
    assert!(html.contains(expected), "missing expected response state");
    assert!(html.contains("noindex,nofollow") && html.contains("/api/branding/theme.css"));
    assert!((link == "invalid" || !html.contains(&link)) && !html.contains("<Event & owner>"));
    if code == StatusCode::OK {
      assert!(html.contains("&lt;Event &amp; owner&gt;"));
    }
    let stored: String = sqlx::query_scalar("SELECT response_status FROM calendar_event_participants WHERE id=$1")
      .bind(participant)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(stored, partstat);
  }
  let unavailable = ApiState::new(state.config.clone()).with_html_catalog(Arc::new(
    myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(
      std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html"),
    ),
  ));
  let response = build_router(unavailable)
    .oneshot(
      Request::builder()
        .uri(format!("/api/calendar/rsvp/{}", token(event, "accepted", expiry)))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
  let html = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
  assert!(html.starts_with("<!doctype html>") && html.contains("Calendar service is not available"));
  sqlx::query("DELETE FROM calendar_accounts WHERE id=$1")
    .bind(account)
    .execute(&pool)
    .await
    .expect("cleanup account and dependent calendar rows");
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(user)
    .execute(&pool)
    .await
    .expect("cleanup RSVP user");
}
