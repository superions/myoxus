//! Integration tests for production readiness check endpoint.
use crate::helpers;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::AdminService;
use myoxus_application::auth::AuthService;
use myoxus_application::doc::DocService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::admin::SqlxAdminStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::mail::LogMailAdapter;
use myoxus_infrastructure::storage::StorageAdapter;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

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
  )
  .with_metrics_pool(pool.clone());
  (build_router(state), pool)
}

#[tokio::test]
async fn test_production_readiness_check_endpoint_returns_json() {
  let (app, _pool) = setup_app().await;

  let req = Request::builder()
    .uri("/api/admin/config/check")
    .method("GET")
    .body(Body::empty())
    .expect("request should build");

  let res = app.oneshot(req).await.expect("request should execute");

  assert_eq!(res.status(), StatusCode::OK);

  let body = res.into_body().collect().await.expect("body should collect").to_bytes();

  let json: serde_json::Value = serde_json::from_slice(&body).expect("body should be valid JSON");

  // Validate response structure
  assert!(json.get("checks").is_some(), "Response should have 'checks' key");
  assert!(
    json.get("hasCritical").is_some(),
    "Response should have 'hasCritical' key"
  );

  let checks = json.get("checks").unwrap();
  assert!(checks.is_array(), "checks should be an array");

  if let Some(arr) = checks.as_array() {
    for check in arr {
      assert!(check.get("category").is_some(), "Each check should have 'category'");
      assert!(check.get("key").is_some(), "Each check should have 'key'");
      assert!(check.get("message").is_some(), "Each check should have 'message'");

      let category = check.get("category").unwrap().as_str().unwrap();
      assert!(
        ["CRITICAL", "WARNING", "INFO"].contains(&category),
        "category should be CRITICAL, WARNING, or INFO, got: {}",
        category
      );
    }
  }
}

#[tokio::test]
async fn test_production_readiness_includes_database_check() {
  let (app, _pool) = setup_app().await;

  let req = Request::builder()
    .uri("/api/admin/config/check")
    .method("GET")
    .body(Body::empty())
    .expect("request should build");

  let res = app.oneshot(req).await.expect("request should execute");
  let body = res.into_body().collect().await.expect("body should collect").to_bytes();

  let json: serde_json::Value = serde_json::from_slice(&body).expect("body should be valid JSON");
  let checks = json
    .get("checks")
    .and_then(|v| v.as_array())
    .expect("checks should be an array");

  // Find database check
  let db_check = checks
    .iter()
    .find(|c| c.get("key").and_then(|k| k.as_str()) == Some("database.connection"));

  assert!(db_check.is_some(), "Should include database connection check");
  let db_check = db_check.unwrap();
  let category = db_check.get("category").and_then(|c| c.as_str()).unwrap();
  assert_eq!(category, "INFO", "Database check should pass with INFO category");
}

#[tokio::test]
async fn test_production_readiness_includes_redis_check() {
  let (app, _pool) = setup_app().await;

  let req = Request::builder()
    .uri("/api/admin/config/check")
    .method("GET")
    .body(Body::empty())
    .expect("request should build");

  let res = app.oneshot(req).await.expect("request should execute");
  let body = res.into_body().collect().await.expect("body should collect").to_bytes();

  let json: serde_json::Value = serde_json::from_slice(&body).expect("body should be valid JSON");
  let checks = json
    .get("checks")
    .and_then(|v| v.as_array())
    .expect("checks should be an array");

  // Find redis check
  let redis_check = checks
    .iter()
    .find(|c| c.get("key").and_then(|k| k.as_str()) == Some("redis.connection"));

  assert!(redis_check.is_some(), "Should include redis connection check");
}

#[tokio::test]
async fn test_production_readiness_includes_server_url_check() {
  let (app, _pool) = setup_app().await;

  let req = Request::builder()
    .uri("/api/admin/config/check")
    .method("GET")
    .body(Body::empty())
    .expect("request should build");

  let res = app.oneshot(req).await.expect("request should execute");
  let body = res.into_body().collect().await.expect("body should collect").to_bytes();

  let json: serde_json::Value = serde_json::from_slice(&body).expect("body should be valid JSON");
  let checks = json
    .get("checks")
    .and_then(|v| v.as_array())
    .expect("checks should be an array");

  // Find server.origin check
  let url_check = checks
    .iter()
    .find(|c| c.get("key").and_then(|k| k.as_str()) == Some("server.origin"));

  assert!(url_check.is_some(), "Should include server.origin check");
}

#[tokio::test]
async fn test_production_readiness_has_critical_flag() {
  let (app, _pool) = setup_app().await;

  let req = Request::builder()
    .uri("/api/admin/config/check")
    .method("GET")
    .body(Body::empty())
    .expect("request should build");

  let res = app.oneshot(req).await.expect("request should execute");
  let body = res.into_body().collect().await.expect("body should collect").to_bytes();

  let json: serde_json::Value = serde_json::from_slice(&body).expect("body should be valid JSON");
  let has_critical = json.get("hasCritical");

  assert!(has_critical.is_some(), "Response should include hasCritical field");
  assert!(has_critical.unwrap().is_boolean(), "hasCritical should be a boolean");
}
