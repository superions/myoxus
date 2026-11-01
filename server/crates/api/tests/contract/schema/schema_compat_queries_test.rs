// SPDX-License-Identifier: AGPL-3.0-or-later
//! Web frontend schema compatibility — query field shapes.
//!
//! Verifies root query fields, query argument types, and nested resolver
//! signatures used by the web frontend bundle (`client/web/`).
//! Uses schema introspection only — no database required.

use std::sync::Arc;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_api::config::AppConfig;
use myoxus_api::state::ApiState;
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, InMemoryAuthStore};
use myoxus_application::doc::{DocService, PanicDocStore};
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::mail::LogMailAdapter;
use myoxus_infrastructure::storage::StorageAdapter;
use serde_json::{Value, json};
use tower::ServiceExt;

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

async fn build_app() -> axum::Router {
  let config = AppConfig::load().expect("config");
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

async fn introspect(app: &axum::Router, query: &str) -> Value {
  let body = json!({ "query": query }).to_string();
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .expect("request"),
    )
    .await
    .expect("response");
  let bytes = response.into_body().collect().await.expect("body").to_bytes();
  serde_json::from_slice(&bytes).expect("json")
}

fn field_names(type_data: &Value) -> Vec<String> {
  type_data["fields"]
    .as_array()
    .unwrap_or(&vec![])
    .iter()
    .filter_map(|f| f["name"].as_str().map(String::from))
    .collect()
}

fn arg_names(type_data: &Value, field_name: &str) -> Vec<String> {
  type_data["fields"]
    .as_array()
    .unwrap_or(&vec![])
    .iter()
    .find(|f| f["name"].as_str() == Some(field_name))
    .map(|f| {
      f["args"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|a| a["name"].as_str().map(String::from))
        .collect()
    })
    .unwrap_or_default()
}

fn arg_type_name(type_data: &Value, field_name: &str, arg_name: &str) -> Option<String> {
  type_data["fields"]
    .as_array()?
    .iter()
    .find(|f| f["name"].as_str() == Some(field_name))?["args"]
    .as_array()?
    .iter()
    .find(|a| a["name"].as_str() == Some(arg_name))
    .map(|a| {
      let t = &a["type"];
      t["name"]
        .as_str()
        .or_else(|| t["ofType"]["name"].as_str())
        .or_else(|| t["ofType"]["ofType"]["name"].as_str())
        .unwrap_or("unknown")
        .to_string()
    })
}

fn assert_fields_present(type_name: &str, fields: &[String], required: &[&str]) {
  for r in required {
    assert!(
      fields.contains(&r.to_string()),
      "{} missing field '{}' — web frontend will break. Available: {:?}",
      type_name,
      r,
      fields
    );
  }
}

fn assert_fields_absent(type_name: &str, fields: &[String], forbidden: &[&str]) {
  for field in forbidden {
    assert!(
      !fields.contains(&field.to_string()),
      "{} must not expose retired field '{}' — available: {:?}",
      type_name,
      field,
      fields
    );
  }
}

// ===========================================================================
// Root-level query fields
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_root_query_fields_present() {
  let app = build_app().await;
  let result = introspect(&app, "{ __schema { queryType { fields { name } } } }").await;
  let names = field_names(&result["data"]["__schema"]["queryType"]);

  let required = [
    "currentUser",
    "documentMetadata",
    "documentMetadataValidation",
    "getInviteInfo",
    "prices",
    "publicUserById",
    "queryWorkspaceEmbeddingStatus",
    "serverConfig",
    "workspace",
    "workspaces",
  ];
  assert_fields_present("Root query", &names, &required);
  assert_fields_absent("Root query", &names, &["documentAttributes"]);
}

// ===========================================================================
// Query argument type correctness
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_query_argument_types_correct() {
  let app = build_app().await;
  let result = introspect(
    &app,
    "{ __schema { queryType { fields { name args { name type { name kind ofType { name kind ofType { name } } } } } } } }",
  )
  .await;
  let qt = &result["data"]["__schema"]["queryType"];

  assert_eq!(
    arg_type_name(qt, "workspace", "id"),
    Some("String".to_string()),
    "workspace() must accept id: String!"
  );

  assert_eq!(
    arg_type_name(qt, "getInviteInfo", "inviteId"),
    Some("String".to_string()),
    "getInviteInfo() must accept inviteId: String!"
  );

  assert_eq!(
    arg_type_name(qt, "publicUserById", "id"),
    Some("String".to_string()),
    "publicUserById() must accept id: String!"
  );

  assert_eq!(
    arg_type_name(qt, "queryWorkspaceEmbeddingStatus", "workspaceId"),
    Some("String".to_string()),
    "queryWorkspaceEmbeddingStatus() must accept workspaceId: String!"
  );

  assert_eq!(
    arg_type_name(qt, "documentMetadata", "workspaceId"),
    Some("ID".to_string()),
    "documentMetadata() must accept workspaceId: ID!"
  );
  assert_eq!(
    arg_type_name(qt, "documentMetadata", "docId"),
    Some("ID".to_string()),
    "documentMetadata() must accept docId: ID!"
  );
  assert_eq!(
    arg_type_name(qt, "documentMetadata", "requestedProjectionMode"),
    Some("DocumentMetadataProjectionModeType".to_string()),
    "documentMetadata() must accept requestedProjectionMode: DocumentMetadataProjectionModeType"
  );

  assert_eq!(
    arg_type_name(qt, "documentMetadataValidation", "workspaceId"),
    Some("ID".to_string()),
    "documentMetadataValidation() must accept workspaceId: ID!"
  );
  assert_eq!(
    arg_type_name(qt, "documentMetadataValidation", "docId"),
    Some("ID".to_string()),
    "documentMetadataValidation() must accept docId: ID!"
  );
  assert_eq!(
    arg_type_name(qt, "documentMetadataValidation", "action"),
    Some("DocumentMetadataValidationActionType".to_string()),
    "documentMetadataValidation() must accept action: DocumentMetadataValidationActionType"
  );
}

// ===========================================================================
// Workspace sub-field argument checks (nested resolver signatures)
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_workspace_nested_resolver_args() {
  let app = build_app().await;
  let result = introspect(
    &app,
    "{ __type(name: \"WorkspaceType\") { fields { name args { name type { name kind ofType { name } } } } } }",
  )
  .await;
  let wt = &result["data"]["__type"];

  assert_eq!(
    arg_type_name(wt, "doc", "docId"),
    Some("String".to_string()),
    "workspace.doc() must accept docId: String!"
  );

  let m_args = arg_names(wt, "members");
  assert!(m_args.contains(&"skip".to_string()), "workspace.members needs skip");
  assert!(m_args.contains(&"take".to_string()), "workspace.members needs take");

  let h_args = arg_names(wt, "histories");
  assert!(h_args.contains(&"guid".to_string()), "workspace.histories needs guid");
  assert!(h_args.contains(&"take".to_string()), "workspace.histories needs take");

  assert_eq!(
    arg_type_name(wt, "docs", "pagination"),
    Some("PaginationInput".to_string()),
    "workspace.docs() must accept PaginationInput"
  );

  let c_args = arg_names(wt, "comments");
  assert!(c_args.contains(&"docId".to_string()), "workspace.comments needs docId");

  let cc_args = arg_names(wt, "commentChanges");
  assert!(
    cc_args.contains(&"docId".to_string()),
    "workspace.commentChanges needs docId"
  );
  assert!(
    cc_args.contains(&"pagination".to_string()),
    "workspace.commentChanges needs pagination"
  );

  let pm_args = arg_names(wt, "pageMeta");
  assert!(
    pm_args.contains(&"pageId".to_string()),
    "workspace.pageMeta needs pageId"
  );
}

// ===========================================================================
// WorkspaceDocType sub-field argument checks
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_doc_nested_resolver_args() {
  let app = build_app().await;
  let result = introspect(
    &app,
    "{ __type(name: \"WorkspaceDocType\") { fields { name args { name type { name kind ofType { name } } } } } }",
  )
  .await;
  let dt = &result["data"]["__type"];

  assert_eq!(
    arg_type_name(dt, "grantedUsersList", "pagination"),
    Some("PaginationInput".to_string()),
    "WorkspaceDocType.grantedUsersList() must accept PaginationInput"
  );

  let la_args = arg_names(dt, "lastAccessedMembers");
  assert!(
    la_args.contains(&"pagination".to_string()),
    "WorkspaceDocType.lastAccessedMembers needs pagination"
  );
  assert!(
    la_args.contains(&"query".to_string()),
    "WorkspaceDocType.lastAccessedMembers needs query"
  );

  let a_args = arg_names(dt, "analytics");
  assert!(
    a_args.contains(&"input".to_string()),
    "WorkspaceDocType.analytics needs input"
  );
}
