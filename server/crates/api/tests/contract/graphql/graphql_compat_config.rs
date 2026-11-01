//! Compatibility tests verifying the config GraphQL fields match the original AFFiNE schema.
use std::sync::Arc;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_api::config::{AppConfig, CompatibilityFeature, QuotaPlan};
use myoxus_api::state::ApiState;
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, AuthStore, AuthUser, InMemoryAuthStore, NewSession};
use myoxus_application::doc::{DocService, PanicDocStore};
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::mail::LogMailAdapter;
use myoxus_infrastructure::storage::StorageAdapter;
use serde_json::Value;
use tower::ServiceExt;

async fn setup_test_app(config: AppConfig) -> (axum::Router, Arc<InMemoryAuthStore>) {
  let store = Arc::new(InMemoryAuthStore::default());
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("storage"));

  let auth_service = AuthService::new(store.clone(), mailer, storage.clone(), 3600, 3600);
  let workspace_service = WorkspaceService::new(store.clone());
  let admin_service = AdminService::new(Arc::new(InMemoryAdminStore));
  let doc_service = DocService::new(Arc::new(PanicDocStore));
  let blob_store = Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(
    sqlx::PgPool::connect_lazy("postgres://localhost").expect("pool"),
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
  (myoxus_api::build_router_for_integration_tests(state), store)
}

#[tokio::test]
async fn current_user_compat_outputs_follow_quota_and_feature_config() {
  let mut config = AppConfig::load().expect("config");
  config.compat.quota_plan = QuotaPlan::Free;
  config.compat.quota.blob_limit = 1024;
  config.compat.quota.storage_quota = 123_456;
  config.compat.quota.history_period = 365;
  config.compat.quota.member_limit = 55;
  config.compat.quota.copilot_limit = 77;
  config.compat.quota.copilot_used = 3;
  config.compat.features.user = vec![
    CompatibilityFeature::FreePlan,
    CompatibilityFeature::EarlyAccess,
    CompatibilityFeature::UnlimitedCopilot,
  ];

  let (app, store) = setup_test_app(config).await;

  let user_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: "compat-config@example.com".to_string(),
    name: Some("Compat User".to_string()),
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: None,
    registered: true,
  });

  let session = store
    .create_session(NewSession {
      id: uuid::Uuid::new_v4(),
      user_id,
      csrf_token: "csrf123".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("session");

  let query = r#"{"query":"query { currentUser { id features quota { name blobLimit storageQuota historyPeriod memberLimit humanReadable { name blobLimit storageQuota historyPeriod memberLimit } } copilot { quota { limit used } } } }"}"#;
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(query))
        .expect("request"),
    )
    .await
    .expect("response");

  let body = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("json");
  assert!(json.get("errors").is_none(), "graphql errors: {}", json);

  let user = &json["data"]["currentUser"];
  assert_eq!(user["quota"]["name"], "Free");
  assert_eq!(user["quota"]["blobLimit"], 1024);
  assert_eq!(user["quota"]["storageQuota"], 123_456);
  assert_eq!(user["quota"]["historyPeriod"], 365);
  assert_eq!(user["quota"]["memberLimit"], 55);
  assert_eq!(user["quota"]["humanReadable"]["name"], "Free");
  // humanReadable returns formatted strings: bytes→KB/MB/GB, days → "N days", members → "N"
  assert_eq!(user["quota"]["humanReadable"]["blobLimit"], "1 KB");
  assert_eq!(user["quota"]["humanReadable"]["storageQuota"], "120.6 KB");
  assert_eq!(user["quota"]["humanReadable"]["historyPeriod"], "365 days");
  assert_eq!(user["quota"]["humanReadable"]["memberLimit"], "55");

  assert_eq!(user["copilot"]["quota"]["limit"], 77);
  assert_eq!(user["copilot"]["quota"]["used"], 3);

  let features = user["features"].as_array().expect("features array");
  let feature_names: Vec<&str> = features.iter().filter_map(|value| value.as_str()).collect();
  assert_eq!(feature_names, vec!["EarlyAccess", "UnlimitedCopilot"]);
}
