//! Compatibility stub tests ensuring billing-related GraphQL fields exist and return expected no-op values.
use std::sync::Arc;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_api::config::{AppConfig, BillingPlan, QuotaPlan};
use myoxus_api::state::ApiState;
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, InMemoryAuthStore};
use myoxus_application::doc::{DocService, PanicDocStore};
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::mail::LogMailAdapter;
use myoxus_infrastructure::storage::StorageAdapter;
use serde_json::Value;
use tower::ServiceExt;

async fn setup_test_app(quota_plan: QuotaPlan, billing_plan: BillingPlan) -> axum::Router {
  let mut config = AppConfig::load().expect("config");
  config.compat.quota_plan = quota_plan;
  config.compat.billing.plan = billing_plan;

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
  myoxus_api::build_router_for_integration_tests(state)
}

#[tokio::test]
async fn billing_queries_and_mutations_are_available_and_neutral() {
  let app = setup_test_app(QuotaPlan::Pro, BillingPlan::SelfHostedTeam).await;

  let query = r#"{"query":"query { prices { type plan currency amount yearlyAmount lifetimeAmount } }"}"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(query))
        .expect("request"),
    )
    .await
    .expect("response");
  let body = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("json");
  assert!(json.get("errors").is_none(), "prices failed: {}", json);
  assert_eq!(json["data"]["prices"][0]["plan"], "SelfHostedTeam");

  let cancel = r#"{"query":"mutation { cancelSubscription { status plan } }"}"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(cancel))
        .expect("request"),
    )
    .await
    .expect("response");
  let body = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("json");
  assert!(json.get("errors").is_none(), "cancelSubscription failed: {}", json);
  assert_eq!(json["data"]["cancelSubscription"]["status"], "Canceled");
  assert_eq!(json["data"]["cancelSubscription"]["plan"], "SelfHostedTeam");

  let resume = r#"{"query":"mutation { resumeSubscription { status recurring plan } }"}"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(resume))
        .expect("request"),
    )
    .await
    .expect("response");
  let body = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("json");
  assert!(json.get("errors").is_none(), "resumeSubscription failed: {}", json);
  assert_eq!(json["data"]["resumeSubscription"]["status"], "Active");
  assert_eq!(json["data"]["resumeSubscription"]["recurring"], "Lifetime");
  assert_eq!(json["data"]["resumeSubscription"]["plan"], "SelfHostedTeam");
}

#[tokio::test]
async fn billing_plan_is_independent_from_quota_plan_config() {
  let app = setup_test_app(QuotaPlan::Free, BillingPlan::SelfHostedTeam).await;
  let query = r#"{"query":"query { prices { plan } }"}"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(query))
        .expect("request"),
    )
    .await
    .expect("response");
  let body = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("json");
  assert!(json.get("errors").is_none(), "prices failed: {}", json);
  assert_eq!(json["data"]["prices"][0]["plan"], "SelfHostedTeam");
}

#[tokio::test]
async fn license_mutations_return_valid_payloads() {
  let app = setup_test_app(QuotaPlan::Pro, BillingPlan::SelfHostedTeam).await;
  let query = r#"{"query":"mutation { activateLicense(workspaceId:\"w\", license:\"k\") { quantity recurring variant } deactivateLicense(workspaceId:\"w\") }"}"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(query))
        .expect("request"),
    )
    .await
    .expect("response");
  let body = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("json");
  assert!(json.get("errors").is_none(), "license mutations failed: {}", json);
  assert_eq!(json["data"]["activateLicense"]["quantity"], i32::MAX);
  assert_eq!(json["data"]["activateLicense"]["recurring"], "Lifetime");
  assert_eq!(json["data"]["deactivateLicense"], true);
}
