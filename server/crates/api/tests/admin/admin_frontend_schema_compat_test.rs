//! Admin frontend schema compatibility test.
//!
//! Verifies that ALL GraphQL operations used by the admin frontend bundle
//! (`client/admin/`) exist in the server schema with correct argument types.
//! This test uses schema introspection — no database required.
//!
//! If this test fails, the admin frontend will break at runtime.  Either:
//! 1. Add the missing field/argument to the Rust GraphQL schema, or
//! 2. Update the admin frontend to match the new schema.
//!
//! The operation list tracks the current admin frontend GraphQL documents.
//! When the frontend adds or removes operations, update this contract in the
//! same change so stale legacy fields cannot mask a broken client/server seam.

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

/// Send a GraphQL introspection query and return the parsed JSON.
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

/// Extract field names from an introspected type.
fn field_names(type_data: &Value) -> Vec<String> {
  type_data["fields"]
    .as_array()
    .unwrap_or(&vec![])
    .iter()
    .filter_map(|f| f["name"].as_str().map(String::from))
    .collect()
}

/// Extract argument names for a specific field from an introspected type.
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

/// Extract the type name (handling NON_NULL wrapping) for a field's argument.
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
        .unwrap_or("unknown")
        .to_string()
    })
}

/// Extract input field names from an introspected input type.
fn input_field_names(type_data: &Value) -> Vec<String> {
  type_data["inputFields"]
    .as_array()
    .unwrap_or(&vec![])
    .iter()
    .filter_map(|f| f["name"].as_str().map(String::from))
    .collect()
}

// ---------------------------------------------------------------------------
// Root-level query fields used by admin frontend
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_admin_schema_root_query_fields_present() {
  let app = build_app().await;

  // Non-admin fields must be on the flat Query root
  let result = introspect(&app, "{ __schema { queryType { fields { name } } } }").await;
  let query_type = &result["data"]["__schema"]["queryType"];
  let root_names = field_names(query_type);

  for field in ["currentUser", "serverConfig", "admin"] {
    assert!(
      root_names.contains(&field.to_string()),
      "Root query field '{}' missing — admin frontend will break. Available: {:?}",
      field,
      root_names
    );
  }

  // Admin-specific fields live under AdminRoot (admin { ... })
  let admin_result = introspect(&app, "{ __type(name: \"AdminRoot\") { fields { name } } }").await;
  let admin_type = &admin_result["data"]["__type"];
  let admin_names = field_names(admin_type);

  let required_admin = [
    "adminDashboard",
    "adminWorkspace",
    "adminWorkspaces",
    "adminWorkspacesCount",
    "adminAllSharedLinks",
    "adminConfigSchema",
    "adminConfigValues",
    "documentRuntimeOverview",
    "orphanedWorkspaces",
    "orphanedWorkspacesCount",
    "users",
    "usersCount",
    "userByEmail",
    "userById",
    "validateAppConfig",
    "metricsStatus",
    "telemetryStatus",
    "themeCatalog",
    "effectiveThemeProfile",
    "appServerBranding",
    "organizationIdentity",
  ];

  for field in required_admin {
    assert!(
      admin_names.contains(&field.to_string()),
      "AdminRoot field '{}' missing — admin frontend will break. Available: {:?}",
      field,
      admin_names
    );
  }
}

#[tokio::test]
async fn inv_admin_schema_root_mutation_fields_present() {
  let app = build_app().await;

  // Non-admin mutations must still be on the flat Mutation root
  let result = introspect(&app, "{ __schema { mutationType { fields { name } } } }").await;
  let mutation_type = &result["data"]["__schema"]["mutationType"];
  let root_names = field_names(mutation_type);

  assert!(
    root_names.contains(&"admin".to_string()),
    "Mutation root must have 'admin' field — all admin mutations go through admin {{ }}. Available: {:?}",
    root_names
  );

  // Admin mutations live under AdminRoot
  let admin_result = introspect(&app, "{ __type(name: \"AdminRoot\") { fields { name } } }").await;
  let admin_type = &admin_result["data"]["__type"];
  let admin_names = field_names(admin_type);

  let required_admin = [
    "adminUpdateWorkspace",
    "banUser",
    "createChangePasswordUrl",
    "createUser",
    "deleteUser",
    "enableUser",
    "importUsers",
    "reassignWorkspaceOwner",
    "sendTestEmail",
    "adminUpdateConfig",
    "updateUser",
    "updateUserFeatures",
    "flushMetrics",
    "flushTelemetry",
    "updateOrganizationIdentity",
    "updateAppServerBranding",
    "setThemeProfile",
    "setTypographyStyles",
    "setColorSchemaValues",
    "resetWorkspaceThemeProfile",
    "adminFlushDocMetadataProjectionCache",
  ];

  for field in required_admin {
    assert!(
      admin_names.contains(&field.to_string()),
      "AdminRoot field '{}' missing — admin frontend will break. Available: {:?}",
      field,
      admin_names
    );
  }
}

// ---------------------------------------------------------------------------
// Input types used by admin frontend
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_admin_schema_list_user_input_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"ListUserInput\") { inputFields { name } } }").await;
  let fields = input_field_names(&result["data"]["__type"]);

  for required in ["first", "skip", "keyword", "features"] {
    assert!(
      fields.contains(&required.to_string()),
      "ListUserInput missing field '{}' — admin user list will break. Has: {:?}",
      required,
      fields
    );
  }
}

#[tokio::test]
async fn inv_admin_schema_list_workspace_input_fields() {
  let app = build_app().await;
  let result = introspect(
    &app,
    "{ __type(name: \"ListWorkspaceInput\") { inputFields { name } } }",
  )
  .await;
  let fields = input_field_names(&result["data"]["__type"]);

  for required in ["first", "skip", "keyword", "isPersonal", "orderBy"] {
    assert!(
      fields.contains(&required.to_string()),
      "ListWorkspaceInput missing field '{}' — admin workspace list will break. Has: {:?}",
      required,
      fields
    );
  }
}

#[tokio::test]
async fn inv_admin_schema_admin_dashboard_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"AdminDashboardType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "syncActiveUsers",
    "syncActiveUsersTimeline",
    "syncWindow",
    "copilotConversations",
    "workspaceStorageBytes",
    "blobStorageBytes",
    "workspaceStorageHistory",
    "blobStorageHistory",
    "storageWindow",
    "topSharedLinks",
    "topSharedLinksWindow",
    "generatedAt",
  ];

  for field in required {
    assert!(
      fields.contains(&field.to_string()),
      "AdminDashboardType missing field '{}' — dashboard page will break. Has: {:?}",
      field,
      fields
    );
  }
}

#[tokio::test]
async fn inv_admin_schema_admin_workspace_compat_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"AdminWorkspaceType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  // Fields requested by adminWorkspaces query in the frontend bundle
  let required = [
    "id",
    "public",
    "createdAt",
    "name",
    "avatarKey",
    "enableAi",
    "enableSharing",
    "enableUrlPreview",
    "enableDocEmbedding",
    "features",
    "owner",
    "ownerPrincipalType",
    "ownerPrincipalId",
    "ownerPrincipalName",
    "memberCount",
    "publicPageCount",
    "snapshotCount",
    "snapshotSize",
    "blobCount",
    "blobSize",
    "isPersonal",
    "gitSyncEnabled",
    "gitSyncLastStatus",
  ];

  for field in required {
    assert!(
      fields.contains(&field.to_string()),
      "AdminWorkspaceType missing field '{}' — workspace list will break. Has: {:?}",
      field,
      fields
    );
  }
}

// ---------------------------------------------------------------------------
// Organization admin fields used by the current admin frontend
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_admin_schema_organization_admin_query_fields() {
  let app = build_app().await;
  // Organization query ops are directly on AdminRoot, not on a separate sub-root.
  let result = introspect(
    &app,
    "{ __type(name: \"AdminRoot\") { fields { name args { name } } } }",
  )
  .await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "organization",
    "organizationUnits",
    "organizationUnit",
    "organizationUnitTypes",
    "organizationUnitMembers",
    "organizationUnitWorkspaces",
    "workspaceOrganizationUnitWorkspaces",
    "organizationPolicy",
    "organizationProjectRequests",
    "organizationExport",
  ];
  for field in required {
    assert!(
      fields.contains(&field.to_string()),
      "AdminRoot missing organization query field '{}' — organization admin page will break. Has: {:?}",
      field,
      fields
    );
  }
}

#[tokio::test]
async fn inv_admin_schema_organization_mutation_fields() {
  let app = build_app().await;
  // Organization mutation ops are directly on AdminRoot, not on a separate sub-root.
  let result = introspect(
    &app,
    "{ __type(name: \"AdminRoot\") { fields { name args { name } } } }",
  )
  .await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "updateOrganization",
    "upsertOrganizationUnitType",
    "deactivateOrganizationUnitType",
    "upsertOrganizationUnit",
    "setOrganizationUnitParent",
    "deactivateOrganizationUnit",
    "updateOrganizationPolicy",
    "assignOrganizationManager",
    "unassignOrganizationManager",
    "assignOrganizationUnitWorkspace",
    "unassignOrganizationUnitWorkspace",
    "decideOrganizationProjectRequest",
    "organizationImportDryRun",
    "organizationImportApply",
  ];

  for field in required {
    assert!(
      fields.contains(&field.to_string()),
      "AdminRoot missing organization mutation field '{}' — organization admin page will break. Has: {:?}",
      field,
      fields
    );
  }
}

// ---------------------------------------------------------------------------
// Argument type correctness (most common schema drift source)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_admin_schema_query_argument_types_correct() {
  let app = build_app().await;
  // Admin operations are on AdminRoot, not the flat query root
  let result = introspect(
    &app,
    "{ __type(name: \"AdminRoot\") { fields { name args { name type { name kind ofType { name } } } } } }",
  )
  .await;
  let admin_root = &result["data"]["__type"];

  // users(filter: ListUserInput!)
  assert_eq!(
    arg_type_name(admin_root, "users", "filter"),
    Some("ListUserInput".to_string()),
    "users() must accept ListUserInput"
  );

  // usersCount(filter: ListUserInput!)
  assert_eq!(
    arg_type_name(admin_root, "usersCount", "filter"),
    Some("ListUserInput".to_string()),
    "usersCount() must accept ListUserInput"
  );

  // adminWorkspaces(filter: ListWorkspaceInput!)
  assert_eq!(
    arg_type_name(admin_root, "adminWorkspaces", "filter"),
    Some("ListWorkspaceInput".to_string()),
    "adminWorkspaces() must accept ListWorkspaceInput"
  );

  // adminWorkspacesCount(filter: ListWorkspaceInput!)
  assert_eq!(
    arg_type_name(admin_root, "adminWorkspacesCount", "filter"),
    Some("ListWorkspaceInput".to_string()),
    "adminWorkspacesCount() must accept ListWorkspaceInput"
  );

  // adminDashboard(input: AdminDashboardInput)
  assert_eq!(
    arg_type_name(admin_root, "adminDashboard", "input"),
    Some("AdminDashboardInput".to_string()),
    "adminDashboard() must accept AdminDashboardInput"
  );

  // effectiveThemeProfile(workspaceId: ID)
  assert_eq!(
    arg_type_name(admin_root, "effectiveThemeProfile", "workspaceId"),
    Some("ID".to_string()),
    "effectiveThemeProfile() must accept workspaceId: ID"
  );

  // setThemeProfile(input: SetThemeProfileInput!)
  assert_eq!(
    arg_type_name(admin_root, "setThemeProfile", "input"),
    Some("SetThemeProfileInput".to_string()),
    "setThemeProfile() must accept SetThemeProfileInput"
  );

  // setTypographyStyles(input: SetTypographyStylesInput!)
  assert_eq!(
    arg_type_name(admin_root, "setTypographyStyles", "input"),
    Some("SetTypographyStylesInput".to_string()),
    "setTypographyStyles() must accept SetTypographyStylesInput"
  );

  // setColorSchemaValues(input: SetColorSchemaValuesInput!)
  assert_eq!(
    arg_type_name(admin_root, "setColorSchemaValues", "input"),
    Some("SetColorSchemaValuesInput".to_string()),
    "setColorSchemaValues() must accept SetColorSchemaValuesInput"
  );

  // resetWorkspaceThemeProfile(input: ResetWorkspaceThemeProfileInput!)
  assert_eq!(
    arg_type_name(admin_root, "resetWorkspaceThemeProfile", "input"),
    Some("ResetWorkspaceThemeProfileInput".to_string()),
    "resetWorkspaceThemeProfile() must accept ResetWorkspaceThemeProfileInput"
  );

  // orphanedWorkspaces(skip, take)
  let args = arg_names(admin_root, "orphanedWorkspaces");
  assert!(args.contains(&"skip".to_string()), "orphanedWorkspaces needs skip arg");
  assert!(args.contains(&"take".to_string()), "orphanedWorkspaces needs take arg");
}

// Functional dashboard smoke test is in websocket_protocol_test.rs (needs real DB)
