//! Integration tests for admin HTTP endpoints (user management, workspace CRUD).
use crate::helpers;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::AdminService;
use myoxus_application::auth::AuthService;
use myoxus_application::auth::AuthStore;
use myoxus_application::doc::DocService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::admin::SqlxAdminStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::mail::LogMailAdapter;
use myoxus_infrastructure::storage::StorageAdapter;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

async fn setup_app() -> (axum::Router, PgPool) {
  let pool = helpers::setup_pool().await;

  let config = AppConfig::load().expect("AppConfig should load successfully");
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));

  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("test-storage FS adapter should initialise"));

  let auth_service = AuthService::new(auth_store, mailer, storage.clone(), 3600, 3600);
  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);
  let blob_store = Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(pool.clone()));
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
  (build_router(state), pool)
}

// ---------------------------------------------------------------------------
// Shared test data produced by `seed_admin_test_data`.
// ---------------------------------------------------------------------------

struct AdminTestData {
  /// All user IDs created during seeding (pass to `cleanup_users` at the end).
  user_ids: Vec<Uuid>,
  /// The ID of user[0], who has `is_admin = true`.
  admin_id: Uuid,
  /// The ID of user[1], a plain non-admin user useful for mutation tests.
  plain_user_id: Uuid,
  /// The run-specific e-mail prefix used so assertions can locate the admin row.
  admin_email: String,
  /// One workspace ID seeded alongside user[0] — used for single-ws and delete tests.
  workspace_id: Uuid,
  /// `affine_session=<id>` cookie string for the admin session.
  cookie: String,
}

/// Insert 5 users (user[0] is admin) each with one workspace, create an admin
/// session, and return all IDs + the session cookie.
async fn seed_admin_test_data(pool: &PgPool) -> AdminTestData {
  let run_id = Uuid::new_v4().to_string()[..8].to_string();
  let mut user_ids: Vec<Uuid> = Vec::new();
  let mut admin_id = Uuid::nil();
  let mut plain_user_id = Uuid::nil();
  let mut admin_workspace_id = Uuid::nil();

  for i in 0..5u32 {
    let uid = Uuid::new_v4();
    user_ids.push(uid);
    if i == 0 {
      admin_id = uid;
    } else if i == 1 {
      plain_user_id = uid;
    }

    sqlx::query("INSERT INTO users (id, email, name, is_admin) VALUES ($1, $2, $3, $4)")
      .bind(uid)
      .bind(format!("admin_test_{}_{}@example.com", run_id, i))
      .bind(format!("User {}", i))
      .bind(i == 0)
      .execute(pool)
      .await
      .expect("seeding test user should succeed");

    let ws_id = Uuid::new_v4();
    if i == 0 {
      admin_workspace_id = ws_id;
    }
    sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
      .bind(ws_id)
      .bind(uid)
      .bind(format!("Workspace {}", i))
      .execute(pool)
      .await
      .expect("seeding test workspace should succeed");
  }

  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let session = auth_store
    .create_session(myoxus_application::auth::NewSession {
      id: Uuid::new_v4(),
      user_id: admin_id,
      csrf_token: "csrf123".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("creating admin session should succeed");

  AdminTestData {
    admin_email: format!("admin_test_{}_0@example.com", run_id),
    cookie: format!("affine_session={}", session.id),
    user_ids,
    admin_id,
    plain_user_id,
    workspace_id: admin_workspace_id,
  }
}

// ---------------------------------------------------------------------------
// Helper: fire a single GraphQL POST and return the parsed JSON body.
// ---------------------------------------------------------------------------

async fn gql(app: axum::Router, cookie: &str, body: impl Into<String>) -> Value {
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", cookie)
        .body(Body::from(body.into()))
        .expect("building GraphQL request should not fail"),
    )
    .await
    .expect("sending GraphQL request should not fail");

  assert_eq!(response.status(), 200, "GraphQL endpoint must return HTTP 200");

  let bytes = response
    .into_body()
    .collect()
    .await
    .expect("collecting GraphQL response body should not fail")
    .to_bytes();

  serde_json::from_slice(&bytes).expect("GraphQL response should be valid JSON")
}

// ---------------------------------------------------------------------------
// INV: admin list-users returns ≥5 seeded rows; the admin user has isAdmin=true
// ---------------------------------------------------------------------------

#[test]
fn inv_admin_list_users_returns_seeded_rows() {
  helpers::block_on_large_stack("inv-admin-list-users", || async {
    let (app, pool) = setup_app().await;
    let data = seed_admin_test_data(&pool).await;

    let json = gql(
      app,
      &data.cookie,
      r#"{"query": "{ admin { users(filter: { skip: 0, first: 100 }) { id email name isAdmin } } }"}"#,
    )
    .await;

    let users = json["data"]["admin"]["users"]
      .as_array()
      .expect("admin.users must be an array");
    assert!(users.len() >= 5, "at least 5 users must be returned");

    let admin_user = users
      .iter()
      .find(|u| u["email"].as_str() == Some(&data.admin_email))
      .expect("seeded admin user must appear in the user list");
    assert_eq!(
      admin_user["isAdmin"], true,
      "seeded admin user must have isAdmin = true"
    );

    helpers::cleanup_users(&pool, &data.user_ids).await;
  });
}

// ---------------------------------------------------------------------------
// INV: admin list-workspaces returns ≥5 seeded rows
// ---------------------------------------------------------------------------

#[test]
fn inv_admin_list_workspaces_returns_seeded_rows() {
  helpers::block_on_large_stack("inv-admin-list-workspaces", || async {
    let (app, pool) = setup_app().await;
    let data = seed_admin_test_data(&pool).await;

    let json = gql(
      app,
      &data.cookie,
      r#"{"query": "{ admin { adminWorkspaces(filter: { skip: 0, first: 10 }) { id name public owner { id } } } }"}"#,
    )
    .await;

    let workspaces = json["data"]["admin"]["adminWorkspaces"]
      .as_array()
      .expect("admin.adminWorkspaces must be an array");
    assert!(workspaces.len() >= 5, "at least 5 workspaces must be returned");

    helpers::cleanup_users(&pool, &data.user_ids).await;
  });
}

// ---------------------------------------------------------------------------
// INV: admin can fetch a single workspace by ID
// ---------------------------------------------------------------------------

#[test]
fn inv_admin_single_workspace_by_id() {
  helpers::block_on_large_stack("inv-admin-single-workspace", || async {
    let (app, pool) = setup_app().await;
    let data = seed_admin_test_data(&pool).await;

    let query = format!(
      r#"{{"query": "{{ admin {{ adminWorkspace(id: \"{}\") {{ id name }} }} }}"}}"#,
      data.workspace_id
    );
    let json = gql(app, &data.cookie, query).await;

    let ws = &json["data"]["admin"]["adminWorkspace"];
    assert!(
      !ws.is_null(),
      "admin.workspace must not be null for the seeded workspace ID"
    );
    assert_eq!(
      ws["id"].as_str().expect("workspace id must be a string"),
      data.workspace_id.to_string(),
      "returned workspace ID must match the requested ID"
    );

    helpers::cleanup_users(&pool, &data.user_ids).await;
  });
}

// ---------------------------------------------------------------------------
// INV: admin can promote a plain user to admin via setUserAdmin
// ---------------------------------------------------------------------------

#[test]
fn inv_admin_set_user_admin_flag() {
  helpers::block_on_large_stack("inv-admin-set-user-admin", || async {
    let (app, pool) = setup_app().await;
    let data = seed_admin_test_data(&pool).await;

    let mutation = format!(
      r#"{{"query": "mutation {{ admin {{ setUserAdmin(userId: \"{}\", isAdmin: true) }} }}"}}"#,
      data.plain_user_id
    );
    let json = gql(app, &data.cookie, mutation).await;

    assert!(
      json["errors"].is_null(),
      "setUserAdmin mutation must not return errors; got: {}",
      json["errors"]
    );

    helpers::cleanup_users(&pool, &data.user_ids).await;
  });
}

// ---------------------------------------------------------------------------
// INV: admin can delete a workspace via deleteWorkspace
// ---------------------------------------------------------------------------

#[test]
fn inv_admin_delete_workspace() {
  helpers::block_on_large_stack("inv-admin-delete-workspace", || async {
    let (app, pool) = setup_app().await;
    let data = seed_admin_test_data(&pool).await;

    let mutation = format!(
      r#"{{"query": "mutation {{ admin {{ deleteWorkspace(id: \"{}\") }} }}"}}"#,
      data.workspace_id
    );
    let json = gql(app, &data.cookie, mutation).await;

    assert!(
      json["errors"].is_null(),
      "deleteWorkspace mutation must not return errors; got: {}",
      json["errors"]
    );

    helpers::cleanup_users(&pool, &data.user_ids).await;
  });
}
