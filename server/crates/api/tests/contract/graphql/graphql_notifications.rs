//! Integration tests for the notification GraphQL resolvers (list, mark-read, subscribe).
use crate::helpers;

use std::sync::Arc;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, AuthStore, AuthUser, InMemoryAuthStore, NewSession};
use myoxus_application::doc::{DocService, PanicDocStore};
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::mail::LogMailAdapter;

use helpers::DummyStorage;

async fn setup_test_app() -> (axum::Router, Arc<ApiState>, Arc<InMemoryAuthStore>) {
  let config = AppConfig::load().expect("load app config");
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

  let state = Arc::new(ApiState::with_services(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    blob_service,
    storage,
  ));

  (build_router((*state).clone()), state, auth_store)
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
    .expect("create session");

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
        .expect("build graphql request"),
    )
    .await
    .expect("graphql request");

  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect graphql body")
    .to_bytes();
  serde_json::from_slice(&body).expect("parse graphql response")
}

#[tokio::test]
async fn graphql_notifications_list_and_read_flow() {
  let (app, state, auth_store) = setup_test_app().await;
  let (user_id, session_id) = create_user_session(&auth_store, "notify-user@example.com").await;
  let first = state
    .notification()
    .create_notification(
      user_id,
      "mention".to_string(),
      Some("default".to_string()),
      None,
      json!({"message":"one"}),
    )
    .await
    .expect("first notification");
  state
    .notification()
    .create_notification(
      user_id,
      "comment".to_string(),
      Some("default".to_string()),
      None,
      json!({"message":"two"}),
    )
    .await
    .expect("second notification");

  let list = graphql(
        &app,
        session_id,
        json!({
            "query": "query List($pagination: PaginationInput!) { currentUser { notifications(pagination: $pagination) { totalCount edges { node { id type level read body } } pageInfo { hasNextPage } } } }",
            "variables": {"pagination": {"first": 10}}
        }),
    )
    .await;
  assert!(list.get("errors").is_none(), "unexpected errors: {list}");
  assert_eq!(list["data"]["currentUser"]["notifications"]["totalCount"], 2);
  assert_eq!(
    list["data"]["currentUser"]["notifications"]["edges"]
      .as_array()
      .expect("notifications edges array")
      .len(),
    2
  );
  assert_eq!(
    list["data"]["currentUser"]["notifications"]["edges"][0]["node"]["read"],
    false
  );

  let read_one = graphql(
    &app,
    session_id,
    json!({
        "query": "mutation ReadOne($id: String!) { readNotification(id: $id) }",
        "variables": {"id": first.id.to_string()}
    }),
  )
  .await;
  assert!(read_one.get("errors").is_none(), "unexpected errors: {read_one}");
  assert_eq!(read_one["data"]["readNotification"], true);

  let after_read_one = graphql(
        &app,
        session_id,
        json!({
            "query": "query Count($pagination: PaginationInput!) { currentUser { notifications(pagination: $pagination) { totalCount } } }",
            "variables": {"pagination": {"first": 1}}
        }),
    )
    .await;
  assert!(
    after_read_one.get("errors").is_none(),
    "unexpected errors: {after_read_one}"
  );
  assert_eq!(after_read_one["data"]["currentUser"]["notifications"]["totalCount"], 1);

  let filtered_history = graphql(
    &app,
    session_id,
    json!({
      "query": "query Filtered($pagination: PaginationInput!, $filter: NotificationListFilterInput) { currentUser { notifications(pagination: $pagination, filter: $filter) { totalCount edges { node { id type read } } } } }",
      "variables": {
        "pagination": {"first": 10},
        "filter": {"includeRead": true, "types": ["Mention", "Mention"]}
      }
    }),
  )
  .await;
  assert!(
    filtered_history.get("errors").is_none(),
    "unexpected filtered history errors: {filtered_history}"
  );
  assert_eq!(
    filtered_history["data"]["currentUser"]["notifications"]["totalCount"],
    1
  );
  assert_eq!(
    filtered_history["data"]["currentUser"]["notifications"]["edges"][0]["node"]["id"],
    first.id.to_string()
  );
  assert_eq!(
    filtered_history["data"]["currentUser"]["notifications"]["edges"][0]["node"]["read"],
    true
  );

  let multi_type = graphql(
    &app,
    session_id,
    json!({
      "query": "query Filtered($pagination: PaginationInput!, $filter: NotificationListFilterInput) { currentUser { notifications(pagination: $pagination, filter: $filter) { totalCount edges { node { type } } } } }",
      "variables": {
        "pagination": {"first": 10},
        "filter": {"includeRead": true, "types": ["Mention", "Comment"]}
      }
    }),
  )
  .await;
  assert!(
    multi_type.get("errors").is_none(),
    "unexpected multi-type errors: {multi_type}"
  );
  assert_eq!(multi_type["data"]["currentUser"]["notifications"]["totalCount"], 2);

  let empty_types = graphql(
    &app,
    session_id,
    json!({
      "query": "query Filtered($pagination: PaginationInput!, $filter: NotificationListFilterInput) { currentUser { notifications(pagination: $pagination, filter: $filter) { totalCount } } }",
      "variables": {
        "pagination": {"first": 10},
        "filter": {"types": []}
      }
    }),
  )
  .await;
  assert!(
    empty_types.get("errors").is_some(),
    "empty notification type filters must fail: {empty_types}"
  );

  let read_all = graphql(&app, session_id, json!({"query":"mutation { readAllNotifications }"})).await;
  assert!(read_all.get("errors").is_none(), "unexpected errors: {read_all}");
  assert_eq!(read_all["data"]["readAllNotifications"], true);

  let after_read_all = graphql(
        &app,
        session_id,
        json!({
            "query": "query Count($pagination: PaginationInput!) { currentUser { notifications(pagination: $pagination) { totalCount } } }",
            "variables": {"pagination": {"first": 1}}
        }),
    )
    .await;
  assert!(
    after_read_all.get("errors").is_none(),
    "unexpected errors: {after_read_all}"
  );
  assert_eq!(after_read_all["data"]["currentUser"]["notifications"]["totalCount"], 0);

  // Reminder type filtering and read ownership must consume the same neutral
  // projection even when persisted payloads are malformed or no target exists.
  let workspace = Uuid::new_v4();
  let database = Uuid::new_v4();
  let field = Uuid::new_v4();
  let mut reminder_ids = Vec::new();
  for (label, row) in [
    ("malformed", json!("PRIVATE REMINDER ID SECRET")),
    ("missing", json!(Uuid::new_v4())),
  ] {
    let notice=state.notification().create_in_app_notification(
      user_id,"database_row_reminder".into(),None,format!("reminder-owner-{label}-{}",Uuid::new_v4()),
      json!({"workspaceId":workspace,"databaseId":database,"rowId":row,"fieldId":field,
        "rowTitle":"PRIVATE REMINDER TITLE SECRET","fieldName":"PRIVATE FIELD SECRET","scheduledFor":"PRIVATE DATE SECRET","sourceText":"PRIVATE SOURCE SECRET"}),
    ).await.unwrap();
    reminder_ids.push(notice.id);
  }
  let reminder_query = "query{currentUser{notifications(pagination:{first:10},filter:{types:[DatabaseRowReminder],includeRead:true}){totalCount edges{node{id type read body}}}}}";
  let reminders = graphql(&app, session_id, json!({"query":reminder_query})).await;
  assert!(reminders.get("errors").is_none(), "{reminders}");
  let feed = &reminders["data"]["currentUser"]["notifications"];
  assert_eq!(feed["totalCount"], 2);
  let mut actual = Vec::new();
  for edge in feed["edges"].as_array().unwrap() {
    let node = &edge["node"];
    actual.push(node["id"].as_str().unwrap().parse::<Uuid>().unwrap());
    assert_eq!(node["type"], "DatabaseRowReminder");
    assert_eq!(node["read"], false);
    let body = &node["body"];
    assert_eq!(body["state"], "Unavailable");
    assert_eq!(body["workspaceId"], workspace.to_string());
    assert_eq!(body["databaseId"], database.to_string());
    assert_eq!(body["fieldId"], field.to_string());
    for key in [
      "rowTitle",
      "fieldName",
      "scheduledFor",
      "allDay",
      "timeZone",
      "targetKind",
    ] {
      assert!(body[key].is_null(), "{key}: {body}");
    }
    assert!(body.get("sourceText").is_none());
  }
  actual.sort_unstable();
  reminder_ids.sort_unstable();
  assert_eq!(actual, reminder_ids);
  assert!(!reminders.to_string().contains("PRIVATE"));
  let (_, foreign_session) = create_user_session(&auth_store, "foreign-reminder-reader@example.com").await;
  let foreign_feed = graphql(&app, foreign_session, json!({"query":reminder_query})).await;
  assert!(foreign_feed.get("errors").is_none(), "{foreign_feed}");
  assert_eq!(foreign_feed["data"]["currentUser"]["notifications"]["totalCount"], 0);
  let read_query = "mutation($id:String!){readNotification(id:$id)}";
  let foreign_read = graphql(
    &app,
    foreign_session,
    json!({"query":read_query,"variables":{"id":reminder_ids[0].to_string()}}),
  )
  .await;
  assert!(foreign_read.get("errors").is_none(), "{foreign_read}");
  assert_eq!(foreign_read["data"]["readNotification"], false);
  let owner_read = graphql(
    &app,
    session_id,
    json!({"query":read_query,"variables":{"id":reminder_ids[0].to_string()}}),
  )
  .await;
  assert!(owner_read.get("errors").is_none(), "{owner_read}");
  assert_eq!(owner_read["data"]["readNotification"], true);
}

#[tokio::test]
async fn graphql_mention_creates_notification_and_read_state_flow() {
  let (app, pool, auth_store, state) = crate::notification_mail_e2e_test::setup_app_with_real_notifications().await;
  let (owner_id, owner_session_id) = helpers::seed_user(&pool, &auth_store, "mention-owner").await;
  let (mentioned_id, mentioned_session_id) = helpers::seed_user(&pool, &auth_store, "mention-target").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  helpers::add_workspace_member(&pool, workspace_id, mentioned_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let mentioned_email: String = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
    .bind(mentioned_id)
    .fetch_one(&pool)
    .await
    .expect("mentioned user's email");

  let mention_user = helpers::gql(
    &app,
    owner_session_id,
    json!({
        "query":"mutation MentionUser($input: MentionInput!){ mentionUser(input:$input) }",
        "variables":{
            "input":{
                "workspaceId": workspace_id.to_string(),
                "userId": mentioned_id.to_string(),
                "doc":{"id": doc_id.to_string(), "mode":"page", "title":"Mention Doc"}
            }
        }
    }),
  )
  .await;
  assert!(
    mention_user.get("errors").is_none(),
    "unexpected errors: {mention_user}"
  );
  assert!(mention_user["data"]["mentionUser"].is_string());

  let create_comment = helpers::gql(
        &app,
        owner_session_id,
        json!({
            "query": format!(
              "mutation Mentioned($workspaceId: String!, $docId: String!) {{ createComment(workspaceId: $workspaceId, docId: $docId, body: {{ text: \"Ping @{mentioned_email}\" }}) {{ id }} }}"
            ),
            "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id.to_string()}
        }),
    )
    .await;
  assert!(
    create_comment.get("errors").is_none(),
    "unexpected errors: {create_comment}"
  );

  let pending: serde_json::Value = sqlx::query_scalar("SELECT payload FROM outbox_events WHERE aggregate_id=$1")
    .bind(create_comment["data"]["createComment"]["id"].as_str().unwrap())
    .fetch_one(&pool)
    .await
    .expect("durable comment intent");
  myoxus_api::comment_notification::dispatch_comment_notification(&state, &pending)
    .await
    .expect("worker dispatch")
    .expect("recipient notification");

  let list = helpers::gql(
        &app,
        mentioned_session_id,
        json!({
            "query": "query List($pagination: PaginationInput!) { currentUser { notifications(pagination: $pagination) { totalCount edges { node { id type read body } } } } }",
            "variables": {"pagination": {"first": 10}}
        }),
    )
    .await;
  assert!(list.get("errors").is_none(), "unexpected errors: {list}");
  assert_eq!(
    list["data"]["currentUser"]["notifications"]["totalCount"], 2,
    "a legitimate editor mention and comment mention remain separate events"
  );
  let comment_id = create_comment["data"]["createComment"]["id"]
    .as_str()
    .expect("comment ID");
  let comment_notification = list["data"]["currentUser"]["notifications"]["edges"]
    .as_array()
    .expect("notification edges")
    .iter()
    .map(|edge| &edge["node"])
    .find(|node| node["body"]["commentId"].as_str() == Some(comment_id))
    .expect("persisted comment mention must reach the consuming payload");
  assert_eq!(comment_notification["body"]["doc"]["id"], doc_id.to_string());
  assert_eq!(comment_notification["body"]["doc"]["mode"], "page");
  assert_eq!(comment_notification["body"]["doc"]["title"], format!("doc-{doc_id}"));
  assert!(comment_notification["body"]["createdByUser"]["name"].is_string());
  sqlx::query("UPDATE docs SET blocked = TRUE WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("block document");
  let blocked = helpers::gql(
    &app,
    mentioned_session_id,
    json!({
      "query": "query { currentUser { notifications(pagination:{first:10}) { edges { node { body } } } } }"
    }),
  )
  .await;
  assert!(blocked.get("errors").is_none(), "unexpected errors: {blocked}");
  let blocked_comment = blocked["data"]["currentUser"]["notifications"]["edges"]
    .as_array()
    .expect("edges")
    .iter()
    .map(|edge| &edge["node"]["body"])
    .find(|body| body["commentId"].as_str() == Some(comment_id))
    .expect("comment notification");
  assert!(
    blocked_comment["doc"].is_null(),
    "blocked document must not be projected into the Inbox"
  );
  sqlx::query("UPDATE docs SET blocked = FALSE WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("unblock document");
  let notification_id = list["data"]["currentUser"]["notifications"]["edges"][0]["node"]["id"]
    .as_str()
    .expect("notification id should exist")
    .to_string();

  let read = graphql(
    &app,
    mentioned_session_id,
    json!({
        "query": "mutation Read($id: String!) { readNotification(id: $id) }",
        "variables": {"id": notification_id}
    }),
  )
  .await;
  assert!(read.get("errors").is_none(), "unexpected errors: {read}");
  assert_eq!(read["data"]["readNotification"], true);

  let after_read = graphql(
        &app,
        mentioned_session_id,
        json!({
            "query": "query Count($pagination: PaginationInput!) { currentUser { notifications(pagination: $pagination) { totalCount } } }",
            "variables": {"pagination": {"first": 1}}
        }),
    )
    .await;
  assert!(after_read.get("errors").is_none(), "unexpected errors: {after_read}");
  assert!(
    after_read["data"]["currentUser"]["notifications"]["totalCount"]
      .as_i64()
      .unwrap_or(0)
      <= 1
  );
  sqlx::query("DELETE FROM outbox_events WHERE payload->>'workspaceId'=$1")
    .bind(workspace_id.to_string())
    .execute(&pool)
    .await
    .expect("outbox cleanup");
  helpers::cleanup_users(&pool, &[owner_id, mentioned_id]).await;
}

// ---------------------------------------------------------------------------
// P83-K-05: Error-path tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_notifications_unauthenticated_returns_error() {
  let (app, _state, _auth_store) = setup_test_app().await;

  let resp = graphql(
    &app,
    Uuid::nil(), // no auth
    json!({
      "query": "query { currentUser { notifications(pagination: {first: 5}) { totalCount edges { node { id } } } } }"
    }),
  )
  .await;

  let is_error = resp.get("errors").is_some() || resp["data"]["currentUser"].is_null() || resp["data"].is_null();
  assert!(
    is_error,
    "unauthenticated notifications query must fail or return null, got: {resp}"
  );
}

#[tokio::test]
async fn inv_notifications_foreign_user_sees_empty_list() {
  let (app, state, auth_store) = setup_test_app().await;
  let (user_id, _user_session) = create_user_session(&auth_store, "notif-own2@example.invalid").await;
  let (_foreign_id, foreign_session) = create_user_session(&auth_store, "notif-for2@example.invalid").await;

  // Create a notification for user_id via the in-memory notification service.
  state
    .notification()
    .create_notification(user_id, "mention".to_string(), None, None, serde_json::json!({}))
    .await
    .expect("create notification for user_id");

  // Foreign user queries their own notifications — must NOT see user_id's notification.
  let resp = graphql(
    &app,
    foreign_session,
    json!({
      "query": "query { currentUser { notifications(pagination: {first: 10}) { totalCount } } }"
    }),
  )
  .await;

  assert!(
    resp.get("errors").is_none(),
    "notification query must not error: {resp}"
  );
  // Foreign user's count must be 0 (they have no notifications).
  let count = resp["data"]["currentUser"]["notifications"]["totalCount"]
    .as_i64()
    .unwrap_or(-1);
  assert_eq!(count, 0, "foreign user must see 0 notifications, got: {resp}");
}

#[tokio::test]
async fn document_changed_projects_current_targets_and_redacts_unavailable_rows() {
  use futures_util::FutureExt;
  let (app, pool, auth_store, state) = crate::notification_mail_e2e_test::setup_app_with_real_notifications().await;
  let (creator, session) = helpers::seed_user(&pool, &auth_store, "change-creator").await;
  let (actor, _) = helpers::seed_user(&pool, &auth_store, "change-actor").await;
  let workspace = helpers::create_workspace(&pool, creator).await;
  helpers::add_workspace_member(&pool, workspace, actor).await;
  let doc = helpers::create_doc(&pool, workspace, creator).await;
  let key = Uuid::new_v4().to_string();
  let outcome = std::panic::AssertUnwindSafe(async {
    sqlx::query("UPDATE docs SET external_id=$2, title='Current readable title' WHERE id=$1").bind(doc).bind(&key).execute(&pool).await.unwrap();
    let notification = state.notification().create_in_app_notification(creator, "document_changed".into(), None, format!("projection:{}",Uuid::new_v4()), json!({
      "batchId":Uuid::new_v4(),"docId":doc,"workspaceId":workspace,"latestActorId":actor,"actorCount":3,
      "firstChangedAt":"2026-10-07T00:00:00Z","lastChangedAt":"2026-10-07T00:01:00Z"
    })).await.unwrap();
    let query = "query{currentUser{notifications(pagination:{first:20},filter:{types:[DocumentChanged],includeRead:true}){totalCount edges{node{id type body}}}}}";
    let initial = helpers::gql(&app, session, json!({"query":query})).await;
    assert!(initial.get("errors").is_none(), "{initial}");
    assert_eq!(initial["data"]["currentUser"]["notifications"]["totalCount"], 1);
    let row = &initial["data"]["currentUser"]["notifications"]["edges"][0]["node"];
    assert_eq!(row["id"], notification.id.to_string());
    assert_eq!(row["type"], "DocumentChanged");
    assert_eq!(row["body"]["doc"]["id"], key);
    assert_eq!(row["body"]["doc"]["title"], "Current readable title");
    assert_eq!(row["body"]["otherActorCount"], 2);
    assert!(row["body"].get("latestActorId").is_none());
    assert!(row["body"]["createdByUser"].is_object());
    sqlx::query("UPDATE docs SET title='' WHERE id=$1").bind(doc).execute(&pool).await.unwrap();
    let unnamed = helpers::gql(&app, session, json!({"query":query})).await;
    assert_eq!(unnamed["data"]["currentUser"]["notifications"]["edges"][0]["node"]["body"]["doc"]["title"], "");
    sqlx::query("UPDATE docs SET blocked=true WHERE id=$1").bind(doc).execute(&pool).await.unwrap();
    let revoked = helpers::gql(&app, session, json!({"query":query})).await;
    assert_eq!(revoked["data"]["currentUser"]["notifications"]["edges"][0]["node"]["body"],json!({"doc":null,"createdByUser":null}));
    sqlx::query("UPDATE docs SET blocked=false, deleted_at=now() WHERE id=$1").bind(doc).execute(&pool).await.unwrap();
    let trashed = helpers::gql(&app, session, json!({"query":query})).await;
    assert_eq!(trashed["data"]["currentUser"]["notifications"]["edges"][0]["node"]["body"],json!({"doc":null,"createdByUser":null}));
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[creator, actor]).await;
  let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id=ANY($1)")
    .bind(&[creator, actor] as &[Uuid])
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(remaining, 0);
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

async fn change_sync_delta(state: &ApiState, workspace: Uuid, doc: Uuid, text: &str) -> Vec<u8> {
  use myoxus_application::doc::content_mutation::{DocumentMutation, document_fragment_from_markdown};
  let current = state.doc().load_full_doc(workspace, doc).await.unwrap();
  yjs::apply_document_mutation(
    &current,
    &DocumentMutation::AppendBlocks {
      fragment: document_fragment_from_markdown(text).unwrap(),
    },
  )
  .unwrap()
  .delta
}

async fn push_change_sync(
  state: &ApiState,
  workspace: Uuid,
  key: &str,
  actor: Option<Uuid>,
  payload: Vec<u8>,
) -> myoxus_application::doc::DocUpdatePersistenceResult {
  state
    .doc()
    .push_external_update_with_context(
      Uuid::new_v4(),
      None,
      workspace,
      myoxus_domain::document_key::DocumentKey::parse(key).unwrap(),
      payload,
      0,
      myoxus_application::doc::DocSpaceKind::Workspace,
      actor,
      None,
      None,
      None,
    )
    .await
    .unwrap()
}

#[sqlx::test(migrations = false)]
async fn document_change_batches_dispatch_atomically_retry_and_project_safe_targets(pool: sqlx::PgPool) {
  use chrono::{Duration, Utc};
  use futures_util::FutureExt;
  use myoxus_application::notification::document_change::{
    DocumentChangeDispatcher, DocumentChangeStore, creator_recipient,
  };
  use myoxus_infrastructure::notification::document_change::SqlxDocumentChangeStore;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("isolated batch schema");
  let (app, pool, auth_store, state) = crate::notification_mail_e2e_test::setup_app_with_notification_pool(pool).await;
  let (creator, session) = helpers::seed_user(&pool, &auth_store, "batch-creator").await;
  let (actor, _) = helpers::seed_user(&pool, &auth_store, "batch-actor").await;
  let (other_actor, _) = helpers::seed_user(&pool, &auth_store, "batch-other").await;
  let workspace = helpers::create_workspace(&pool, creator).await;
  helpers::add_workspace_member(&pool, workspace, actor).await;
  helpers::add_workspace_member(&pool, workspace, other_actor).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    state.workspace().seed_root_doc(workspace,creator,yjs::create_initial_workspace_doc("Batch fixture")).await.unwrap();
    let doc = state.doc().create_page_lifecycle(workspace,creator,Some("Batch target".into()),None).await.unwrap().document;
    let store = Arc::new(SqlxDocumentChangeStore::new(pool.clone()));
    let dispatcher = || DocumentChangeDispatcher::new(store.clone(),state.auth().clone(),state.doc().clone(),state.permission_service());
    let defaults = state.user_preference_defaults().await;
    let mut first_due = None;
    for (user, text) in [(actor,"First foreign edit"),(other_actor,"Latest foreign edit"),(creator,"Creator also edits")] {
      let delta = change_sync_delta(&state,workspace,doc.id,text).await;
      let result = push_change_sync(&state,workspace,&doc.external_id,Some(user),delta.clone()).await;
      assert_eq!(result.outcome,myoxus_application::doc::DocUpdatePersistenceOutcome::Persisted);
      let timing: (chrono::DateTime<Utc>,chrono::DateTime<Utc>) = sqlx::query_as("SELECT started_at,due_at FROM document_change_batches WHERE doc_id=$1 AND sealed_at IS NULL")
        .bind(doc.id).fetch_one(&pool).await.unwrap();
      assert_eq!(timing.1-timing.0,Duration::seconds(600));
      if let Some(due) = first_due { assert_eq!(timing.1,due,"later edits must not extend the window"); } else { first_due=Some(timing.1); }
      let replay = push_change_sync(&state,workspace,&doc.external_id,Some(user),delta).await;
      assert_eq!(replay.outcome,myoxus_application::doc::DocUpdatePersistenceOutcome::ExactReplay);
    }
    let full = state.doc().load_full_doc(workspace,doc.id).await.unwrap();
    let no_op = push_change_sync(&state,workspace,&doc.external_id,Some(actor),full).await;
    assert_eq!(no_op.outcome,myoxus_application::doc::DocUpdatePersistenceOutcome::CrdtNoop);
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM document_change_batches WHERE doc_id=$1").bind(doc.id).fetch_one(&pool).await.unwrap();
    assert_eq!(count,1);
    let due=first_due.unwrap();
    assert!(dispatcher().dispatch_due(due-Duration::milliseconds(1),50,&defaults).await.unwrap().is_empty());
    let batch=store.due_batches(due,50).await.unwrap().into_iter().find(|batch|batch.doc_id==doc.id).unwrap();
    assert_eq!(batch.actors.len(),3);
    let recipient=creator_recipient(creator,&batch.actors).unwrap();
    assert_eq!(recipient.actor_count,2);
    assert_eq!(recipient.latest_actor_id,other_actor,"a later self edit never replaces the foreign actor");
    let mut tx=pool.begin().await.unwrap();
    let inserted=SqlxDocumentChangeStore::complete_in_tx(&mut tx,&batch,Some(&recipient),due).await.unwrap().unwrap();
    assert!(inserted.inserted);
    tx.rollback().await.unwrap();
    let pending:i64=sqlx::query_scalar("SELECT count(*) FROM document_change_batches WHERE id=$1").bind(batch.id).fetch_one(&pool).await.unwrap();
    assert_eq!(pending,1,"rollback preserves durable pending state");
    let rows:i64=sqlx::query_scalar("SELECT count(*) FROM notifications WHERE idempotency_key=$1").bind(format!("document_changed:{}:{creator}",batch.id)).fetch_one(&pool).await.unwrap();
    assert_eq!(rows,0,"notification insertion rolled back with completion");
    // Fresh dispatchers simulate restart and race without Redis or a fanout port.
    let left=dispatcher();let right=dispatcher();
    let (left,right)=tokio::join!(left.dispatch_due(due,50,&defaults),right.dispatch_due(due,50,&defaults));
    let mut delivered=left.unwrap();delivered.extend(right.unwrap());
    assert_eq!(delivered.len(),1);
    assert_eq!(delivered[0].payload["actorCount"],2);
    assert_eq!(delivered[0].payload["latestActorId"],other_actor.to_string());
    assert!(dispatcher().dispatch_due(due,50,&defaults).await.unwrap().is_empty());
    let actors:i64=sqlx::query_scalar("SELECT count(*) FROM document_change_batch_actors WHERE batch_id=$1").bind(batch.id).fetch_one(&pool).await.unwrap();
    assert_eq!(actors,0,"completion cascades transient actor facts");
    let query="query{currentUser{notifications(pagination:{first:10},filter:{types:[DocumentChanged],includeRead:true}){totalCount edges{node{id body}}}}}";
    let response=helpers::gql(&app,session,json!({"query":query})).await;
    assert!(response.get("errors").is_none(),"{response}");
    assert_eq!(response["data"]["currentUser"]["notifications"]["totalCount"],1);
    assert_eq!(response["data"]["currentUser"]["notifications"]["edges"][0]["node"]["body"]["doc"]["id"],doc.external_id);
    sqlx::query("UPDATE docs SET blocked=true WHERE id=$1").bind(doc.id).execute(&pool).await.unwrap();
    let revoked=helpers::gql(&app,session,json!({"query":query})).await;
    assert_eq!(revoked["data"]["currentUser"]["notifications"]["edges"][0]["node"]["body"],json!({"doc":null,"createdByUser":null}));
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[creator, actor, other_actor]).await;
  let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id=ANY($1)")
    .bind(&[creator, actor, other_actor] as &[Uuid])
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(remaining, 0);
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[sqlx::test(migrations = false)]
async fn document_change_rotation_current_policy_and_bootstrap_exclusions(pool: sqlx::PgPool) {
  use chrono::{Duration, Utc};
  use futures_util::FutureExt;
  use myoxus_application::{
    auth::UserPreferencesPatch,
    doc::{DocSpaceKind, DocUpdatePersistenceOutcome},
    notification::document_change::{DocumentChangeDispatcher, DocumentChangeStore},
  };
  use myoxus_infrastructure::notification::document_change::SqlxDocumentChangeStore;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("isolated rotation schema");
  let (_, pool, auth_store, state) = crate::notification_mail_e2e_test::setup_app_with_notification_pool(pool).await;
  let (creator, _) = helpers::seed_user(&pool, &auth_store, "rotation-creator").await;
  let (actor, _) = helpers::seed_user(&pool, &auth_store, "rotation-actor").await;
  let workspace = helpers::create_workspace(&pool, creator).await;
  helpers::add_workspace_member(&pool, workspace, actor).await;
  let outcome=std::panic::AssertUnwindSafe(async {
    state.workspace().seed_root_doc(workspace,creator,yjs::create_initial_workspace_doc("Rotation fixture")).await.unwrap();
    let doc=state.doc().create_page_lifecycle(workspace,creator,Some("Rotation".into()),None).await.unwrap().document;
    let store=Arc::new(SqlxDocumentChangeStore::new(pool.clone()));
    let dispatcher=||DocumentChangeDispatcher::new(store.clone(),state.auth().clone(),state.doc().clone(),state.permission_service());
    let defaults=state.user_preference_defaults().await;
    let initial:i64=sqlx::query_scalar("SELECT count(*) FROM document_change_batches WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap();
    assert_eq!(initial,0,"creation is not a change window");
    let bootstrap=format!("bootstrap-{}",Uuid::new_v4());
    push_change_sync(&state,workspace,&bootstrap,Some(actor),vec![0,0]).await;
    // Finishing first-sync registration is still bootstrap, not an edit.
    use yrs::{Map, ReadTxn, Transact};
    let leaf=yrs::Doc::new();
    { let mut tx=leaf.transact_mut(); tx.apply_update(yrs::Update::decode_v1(&myoxus_application::markdown::empty_page_to_yjs("Bootstrap")).unwrap()).unwrap(); }
    { let meta=leaf.get_or_insert_map("meta");let mut tx=leaf.transact_mut();meta.insert(&mut tx,"pageCreationId",bootstrap.as_str());meta.insert(&mut tx,"pageCreationIntent",Uuid::new_v4().to_string()); }
    use yrs::updates::decoder::Decode;
    let registered=push_change_sync(&state,workspace,&bootstrap,Some(actor),leaf.transact().encode_state_as_update_v1(&Default::default())).await;
    assert_eq!(registered.page_registration,Some(myoxus_application::doc::PageRegistrationState::Registered));
    let root_delta={let root=yrs::Doc::new();let text=root.get_or_insert_text("dnot-root-maintenance");let mut tx=root.transact_mut();yrs::Text::insert(&text,&mut tx,0,"root projection");tx.encode_update_v1()};
    push_change_sync(&state,workspace,&workspace.to_string(),Some(actor),root_delta).await;
    let system=format!("db${workspace}$dnot-system");
    let raw=yrs::Doc::new();let text=raw.get_or_insert_text("body");
    use yrs::Text;
    let first={let mut tx=raw.transact_mut();text.insert(&mut tx,0,"system");tx.encode_update_v1()};
    push_change_sync(&state,workspace,&system,Some(actor),first).await;
    let next={let mut tx=raw.transact_mut();text.insert(&mut tx,6," record");tx.encode_update_v1()};
    push_change_sync(&state,workspace,&system,Some(actor),next).await;
    let delta=change_sync_delta(&state,workspace,doc.id,"Unauthenticated maintenance").await;
    let maintenance=state.doc().write.push_update(workspace,doc.id,delta,0,DocSpaceKind::Workspace).await.unwrap();
    assert_eq!(maintenance.outcome,DocUpdatePersistenceOutcome::Persisted);
    let excluded:i64=sqlx::query_scalar("SELECT count(*) FROM document_change_batches WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap();
    assert_eq!(excluded,0,"bootstrap, system and unauthenticated writes must not accumulate");
    let moved_workspace=helpers::create_workspace(&pool,creator).await;
    for (index,user) in [(0,creator),(1,actor),(2,actor),(3,actor),(4,actor),(5,actor),(6,actor),(7,actor)] {
      let delta=change_sync_delta(&state,workspace,doc.id,&format!("Policy edit {index}")).await;
      push_change_sync(&state,workspace,&doc.external_id,Some(user),delta).await;
      let due:chrono::DateTime<Utc>=sqlx::query_scalar("SELECT due_at FROM document_change_batches WHERE doc_id=$1 AND sealed_at IS NULL").bind(doc.id).fetch_one(&pool).await.unwrap();
      if index==1 {
        state.auth().patch_user_preferences(creator,UserPreferencesPatch{notify_created_documents:Some(Some(false)),..Default::default()}).await.unwrap();
      } else if index==2 {
        // An opt-in can admit this still-pending window, without replaying completed windows.
        state.auth().patch_user_preferences(creator,UserPreferencesPatch{notify_created_documents:Some(Some(false)),..Default::default()}).await.unwrap();
        state.auth().patch_user_preferences(creator,UserPreferencesPatch{notify_created_documents:Some(Some(true)),..Default::default()}).await.unwrap();
      } else if index==3 {
        sqlx::query("UPDATE docs SET blocked=true WHERE id=$1").bind(doc.id).execute(&pool).await.unwrap();
      } else if index==4 {
        sqlx::query("UPDATE docs SET deleted_at=now() WHERE id=$1").bind(doc.id).execute(&pool).await.unwrap();
      } else if index==5 {
        sqlx::query("UPDATE docs SET workspace_id=$2 WHERE id=$1").bind(doc.id).bind(moved_workspace).execute(&pool).await.unwrap();
      } else if index==6 {
        state.auth().store.set_user_disabled(actor,true).await.unwrap();
      } else if index==7 {
        state.auth().store.set_user_disabled(creator,true).await.unwrap();
      }
      let delivered=dispatcher().dispatch_due(due,50,&defaults).await.unwrap();
      assert_eq!(delivered.len(),usize::from(index==2),"current policy for case {index}");
      sqlx::query("UPDATE docs SET blocked=false,deleted_at=NULL,workspace_id=$2 WHERE id=$1").bind(doc.id).bind(workspace).execute(&pool).await.unwrap();
      state.auth().store.set_user_disabled(actor,false).await.unwrap();
      state.auth().store.set_user_disabled(creator,false).await.unwrap();
      let pending:i64=sqlx::query_scalar("SELECT count(*) FROM document_change_batches WHERE doc_id=$1").bind(doc.id).fetch_one(&pool).await.unwrap();
      assert_eq!(pending,0,"no recipients is a completed window");
    }
    // Creator read access is independent from the acting editor's membership.
    let access_doc=state.doc().create_page_lifecycle(workspace,actor,Some("Revoked creator".into()),None).await.unwrap().document;
    let delta=change_sync_delta(&state,workspace,access_doc.id,"Before creator access revocation").await;
    push_change_sync(&state,workspace,&access_doc.external_id,Some(creator),delta).await;
    let access_due:chrono::DateTime<Utc>=sqlx::query_scalar("SELECT due_at FROM document_change_batches WHERE doc_id=$1").bind(access_doc.id).fetch_one(&pool).await.unwrap();
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(actor).execute(&pool).await.unwrap();
    assert!(dispatcher().dispatch_due(access_due,50,&defaults).await.unwrap().is_empty());
    helpers::add_workspace_member(&pool,workspace,actor).await;
    let delta=change_sync_delta(&state,workspace,doc.id,"Before delayed dispatch").await;
    push_change_sync(&state,workspace,&doc.external_id,Some(actor),delta).await;
    let old_id:Uuid=sqlx::query_scalar("SELECT id FROM document_change_batches WHERE doc_id=$1 AND sealed_at IS NULL").bind(doc.id).fetch_one(&pool).await.unwrap();
    // Controlled SQL time ages only this fixture; the production interval stays 600s.
    sqlx::query("UPDATE document_change_batches SET started_at=started_at-interval '11 minutes',last_changed_at=last_changed_at-interval '11 minutes',due_at=due_at-interval '11 minutes' WHERE id=$1").bind(old_id).execute(&pool).await.unwrap();
    let delta=change_sync_delta(&state,workspace,doc.id,"After the fixed deadline").await;
    push_change_sync(&state,workspace,&doc.external_id,Some(creator),delta).await;
    let batches=store.due_batches(Utc::now(),50).await.unwrap();
    let old=batches.iter().find(|batch|batch.id==old_id).unwrap();
    assert_eq!(old.actors.len(),1,"the late self edit cannot alter the expired window");
    assert_eq!(old.actors[0].user_id,actor);
    let active:i64=sqlx::query_scalar("SELECT count(*) FROM document_change_batches WHERE doc_id=$1 AND sealed_at IS NULL").bind(doc.id).fetch_one(&pool).await.unwrap();
    assert_eq!(active,1,"a later write opens a fresh active window before old dispatch");
    assert_eq!(dispatcher().dispatch_due(Utc::now(),50,&defaults).await.unwrap().len(),1);
    assert!(dispatcher().dispatch_due(Utc::now()+Duration::minutes(11),50,&defaults).await.unwrap().is_empty(),"new self-only window is suppressed");
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[creator, actor]).await;
  let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id=ANY($1)")
    .bind(&[creator, actor] as &[Uuid])
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(remaining, 0);
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[sqlx::test(migrations = false)]
async fn intentional_content_producers_share_one_window_and_preserve_noop_history(pool: sqlx::PgPool) {
  use chrono::{Duration, Utc};
  use futures_util::FutureExt;
  use myoxus_application::doc::{
    content_mutation::{DocumentMutation, document_fragment_from_markdown},
    history::HistoryRestoreRequest,
  };
  use myoxus_application::notification::document_change::DocumentChangeDispatcher;
  use myoxus_domain::audit::AuditActor;
  use myoxus_infrastructure::notification::document_change::SqlxDocumentChangeStore;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("isolated intentional-write schema");
  let (app, pool, auth, state) = crate::notification_mail_e2e_test::setup_app_with_notification_pool(pool).await;
  let (creator, session) = helpers::seed_user(&pool, &auth, "intentional-creator").await;
  let (actor, _) = helpers::seed_user(&pool, &auth, "intentional-actor").await;
  let workspace = helpers::create_workspace(&pool, creator).await;
  helpers::add_workspace_member(&pool, workspace, actor).await;
  let result = std::panic::AssertUnwindSafe(async {
    state.workspace().seed_root_doc(workspace, creator, yjs::create_initial_workspace_doc("Intentional writes")).await.unwrap();
    let doc = state.doc().create_page_lifecycle(workspace, creator, Some("Initial".into()), Some(document_fragment_from_markdown("Original body").unwrap())).await.unwrap().document;
    let baseline = state.doc().capture_history_snapshot(doc.id).await.unwrap();
    let restore = |history_id| HistoryRestoreRequest { workspace_id:workspace, doc_id:doc.id, history_id, expected_sequence:None, actor:AuditActor::user(actor, None), named:None };
    let unchanged = state.doc().history.restore(restore(baseline)).await.unwrap();
    assert!(unchanged.recovery_history_id > 0, "intentional no-op restore still records recovery history");
    state.doc().rename_page(workspace, doc.id, actor, "Initial".into(), None).await.unwrap();
    let pending:i64=sqlx::query_scalar("SELECT count(*) FROM document_change_batches WHERE doc_id=$1").bind(doc.id).fetch_one(&pool).await.unwrap();
    assert_eq!(pending,0,"creation, identical rename and current-state restore do not subscribe");
    let appended = state.doc().mutate_content(workspace, doc.id, Some(actor), DocumentMutation::AppendBlocks { fragment:document_fragment_from_markdown("Added by semantic write").unwrap() }, false, None).await.unwrap();
    let timing:(Uuid,chrono::DateTime<Utc>,i64)=sqlx::query_as("SELECT id,due_at,last_sequence FROM document_change_batches WHERE doc_id=$1").bind(doc.id).fetch_one(&pool).await.unwrap();
    assert_eq!(timing.2,appended.sequence);
    let renamed = state.doc().rename_page(workspace, doc.id, creator, "Renamed".into(), None).await.unwrap();
    let renamed_sequence = renamed.leaf.unwrap().sequence;
    state.doc().mutate_content(workspace, doc.id, Some(actor), DocumentMutation::EditText { block_id:appended.inserted_block_ids[0].clone(), start:0,end:0,replacement:String::new(),replacement_spans: None,
text_field: None,
range_unit:None,expected_text:Some(String::new()) }, false, None).await.unwrap();
    let sequence:i64=sqlx::query_scalar("SELECT last_sequence FROM document_change_batches WHERE id=$1").bind(timing.0).fetch_one(&pool).await.unwrap();
    assert_eq!(sequence,renamed_sequence,"a no-op after a title delete set must not alter the window");
    let restored = state.doc().history.restore(restore(baseline)).await.unwrap();
    let current = state.doc().load_full_doc(workspace,doc.id).await.unwrap();
    let text = yjs::extract_text_from_yjs(&current).unwrap();
    assert_eq!(text.title.as_deref(),Some("Initial"));
    assert!(text.markdown.contains("Original body"));
    assert!(!text.markdown.contains("Added by semantic write"));
    let current_history = state.doc().capture_history_snapshot(doc.id).await.unwrap();
    state.doc().history.restore(restore(current_history)).await.unwrap();
    state.doc().trash_page(workspace,doc.id,creator).await.unwrap();
    state.doc().restore_page(workspace,doc.id,creator).await.unwrap();
    let final_window:(Uuid,chrono::DateTime<Utc>,i64)=sqlx::query_as("SELECT id,due_at,last_sequence FROM document_change_batches WHERE doc_id=$1").bind(doc.id).fetch_one(&pool).await.unwrap();
    assert_eq!(final_window,(timing.0,timing.1,restored.sequence),"all meaningful producers share the fixed window; no-op restore/trash lifecycle leave it intact");
    let roots:i64=sqlx::query_scalar("SELECT count(*) FROM document_change_batches WHERE doc_id=$1").bind(workspace).fetch_one(&pool).await.unwrap();
    assert_eq!(roots,0,"companion root projections never count");
    let dispatcher=DocumentChangeDispatcher::new(Arc::new(SqlxDocumentChangeStore::new(pool.clone())),state.auth().clone(),state.doc().clone(),state.permission_service());
    let rows=dispatcher.dispatch_due(timing.1+Duration::milliseconds(1),50,&state.user_preference_defaults().await).await.unwrap();
    assert_eq!(rows.len(),1);
    assert_eq!(rows[0].user_id,creator);
    assert_eq!(rows[0].payload["actorCount"],1);
    assert_eq!(rows[0].payload["latestActorId"],actor.to_string());
    let query="query{currentUser{notifications(pagination:{first:10},filter:{types:[DocumentChanged],includeRead:true}){totalCount edges{node{type body}}}}}";
    let response=helpers::gql(&app,session,json!({"query":query})).await;
    assert!(response.get("errors").is_none(),"{response}");
    assert_eq!(response["data"]["currentUser"]["notifications"]["totalCount"],1);
    assert_eq!(response["data"]["currentUser"]["notifications"]["edges"][0]["node"]["body"]["doc"]["id"],doc.external_id);
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[creator, actor]).await;
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users WHERE id=ANY($1)")
      .bind([creator, actor])
      .fetch_one(&pool)
      .await
      .unwrap(),
    0
  );
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}
