//! Integration contract for fail-closed search without the canonical repository.

use std::sync::Arc;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

use crate::helpers::DummyStorage;
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, AuthStore, AuthUser, InMemoryAuthStore};
use myoxus_application::doc::DocService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::mail::LogMailAdapter;

async fn setup_test_app() -> (axum::Router, Arc<InMemoryAuthStore>) {
  let config = AppConfig::load().expect("config should load");
  let store = Arc::new(InMemoryAuthStore::default());
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(DummyStorage);

  let auth_service = AuthService::new(store.clone(), mailer, storage.clone(), 3600, 3600);
  let workspace_service = WorkspaceService::new(store.clone());
  let admin_service = AdminService::new(Arc::new(InMemoryAdminStore));
  let doc_service = DocService::new(Arc::new(myoxus_application::doc::PanicDocStore));
  let blob_store = Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(
    sqlx::PgPool::connect_lazy("postgres://localhost").expect("lazy pool"),
  ));
  let blob_service = Arc::new(myoxus_application::ports::blob_service::BlobService::new(
    blob_store,
    storage.clone(),
    "test-key".to_string(),
  ));

  let state = ApiState::with_services(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    blob_service,
    storage,
  );

  (build_router(state), store)
}

async fn gql(app: &axum::Router, session_id: Uuid, payload: Value) -> Value {
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
    .expect("response");
  let body = response.into_body().collect().await.expect("body").to_bytes();
  serde_json::from_slice(&body).expect("json body")
}

fn assert_missing_repository_error(response: &Value, field: &str) {
  assert_eq!(
    response["data"][field],
    Value::Null,
    "{field} must fail closed: {response}"
  );
  let errors = response["errors"]
    .as_array()
    .unwrap_or_else(|| panic!("{field} must return a GraphQL error: {response}"));
  assert_eq!(
    errors.len(),
    1,
    "{field} must return one deterministic error: {response}"
  );
  assert_eq!(
    errors[0]["message"],
    "storage failure: search repository is not configured"
  );
  assert_eq!(errors[0]["extensions"]["name"], "INTERNAL_SERVER_ERROR");
}

#[tokio::test]
async fn search_fields_fail_closed_when_repository_is_missing() {
  let (app, store) = setup_test_app().await;
  let user_id = Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: "search-missing@example.com".to_string(),
    name: Some("Search Missing".to_string()),
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: None,
    registered: true,
  });

  let session = store
    .create_session(myoxus_application::auth::NewSession {
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
    .expect("session");

  let created = gql(
    &app,
    session.id,
    json!({
      "query": "mutation { createWorkspace { id } }"
    }),
  )
  .await;
  let workspace_id = created["data"]["createWorkspace"]["id"]
    .as_str()
    .expect("workspace id")
    .to_string();

  let search = gql(
    &app,
    session.id,
    json!({
      "query": "query($workspaceId:String!){ search(workspaceId:$workspaceId, query:\"rust\") { docId title } }",
      "variables": { "workspaceId": workspace_id }
    }),
  )
  .await;
  assert_missing_repository_error(&search, "search");

  let aggregate = gql(
    &app,
    session.id,
    json!({
      "query": "query($workspaceId:String!){ aggregate(workspaceId:$workspaceId, query:\"rust\") { total } }",
      "variables": { "workspaceId": workspace_id }
    }),
  )
  .await;
  assert_missing_repository_error(&aggregate, "aggregate");
}
