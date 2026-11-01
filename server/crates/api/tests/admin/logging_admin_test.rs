//! Integration tests for the Myoxus logging admin system (P33-D).
//!
//! Tests cover:
//! 1. Schema-compat: introspection verifies all GQL types, fields, enums exist
//! 2. Functional: updateLogModuleLevel, resetLogLevels, applyLogPreset, updateLogOutput

use crate::helpers;

use myoxus_api::logging::{LogLevel, LoggingService, ReloadFn};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Setup helper: build app WITH a LoggingService wired in
// ---------------------------------------------------------------------------

/// Build the test app and attach a LoggingService with a no-op reload handle.
/// Returns (router, pool, auth_store).
async fn setup_app_with_logging() -> (
  axum::Router,
  sqlx::PgPool,
  Arc<myoxus_infrastructure::auth::SqlxAuthStore>,
) {
  use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
  use myoxus_application::admin::AdminService;
  use myoxus_application::auth::AuthService;
  use myoxus_application::doc::DocService;
  use myoxus_application::ports::blob_service::BlobService;
  use myoxus_application::workspace::WorkspaceService;
  use myoxus_infrastructure::admin::SqlxAdminStore;
  use myoxus_infrastructure::auth::SqlxAuthStore;
  use myoxus_infrastructure::blob::SqlxBlobStore;
  use myoxus_infrastructure::doc::SqlxDocStore;
  use myoxus_infrastructure::mail::LogMailAdapter;
  use myoxus_infrastructure::storage::StorageAdapter;
  use myoxus_infrastructure::workspace::SqlxWorkspaceStore;

  let pool = helpers::setup_pool().await;
  let config = AppConfig::load().expect("config");
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("storage"));
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let blob_service = Arc::new(BlobService::new(blob_store, storage.clone(), "test-key".to_string()));

  let auth_service = AuthService::new(
    auth_store.clone(),
    mailer,
    storage.clone(),
    config.server.session_ttl,
    config.server.session_ttr,
  );
  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);

  // Create a no-op reload function for testing
  let reload_fn: ReloadFn = Arc::new(|_filter: &str| Ok(()));
  let logging_service = Arc::new(LoggingService::new(&HashMap::new(), LogLevel::Info, reload_fn));

  let state = ApiState::with_services(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    blob_service,
    storage,
  )
  .with_metrics_pool(pool.clone())
  .with_logging(logging_service);

  (build_router(state), pool, auth_store)
}

// ===========================================================================
// 1. Schema-Compat Test (P33-D-07, P33-F-02, P33-F-03)
// ===========================================================================

/// Introspect the full schema and verify all logging-related types, fields,
/// input types, queries, and mutations exist with correct names.
#[tokio::test]
async fn inv_p33d07_schema_compat_logging_types_and_fields() {
  let (app, pool, _auth) = helpers::setup_app().await;

  // Full introspection query
  let introspection = r#"
    {
      __schema {
        queryType { name fields { name type { name kind ofType { name kind ofType { name kind } } } } }
        mutationType { name fields { name type { name kind ofType { name kind ofType { name kind } } } args { name type { name kind ofType { name kind } } } } }
        types {
          name kind
          fields { name type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } }
          inputFields { name type { name kind ofType { name kind } } }
        }
      }
    }
    "#;

  let resp = helpers::gql_anon(&app, json!({"query": introspection})).await;
  let schema = &resp["data"]["__schema"];
  assert!(schema.is_object(), "introspection must return __schema, got: {resp}");

  let types = schema["types"].as_array().expect("types array");

  // Helper: find a type by name
  let find_type = |name: &str| -> &Value {
    types
      .iter()
      .find(|t| t["name"].as_str() == Some(name))
      .unwrap_or_else(|| panic!("type {name} not found in schema"))
  };

  // Helper: assert a type has a field with given name
  let assert_field = |type_name: &str, field_name: &str| {
    let t = find_type(type_name);
    let fields = t["fields"]
      .as_array()
      .unwrap_or_else(|| panic!("{type_name} has no fields"));
    assert!(
      fields.iter().any(|f| f["name"].as_str() == Some(field_name)),
      "{type_name} missing field '{field_name}'. Available: {:?}",
      fields
        .iter()
        .map(|f| f["name"].as_str().unwrap_or("?"))
        .collect::<Vec<_>>()
    );
  };

  // Helper: assert an input type has an input field
  let assert_input_field = |type_name: &str, field_name: &str| {
    let t = find_type(type_name);
    let fields = t["inputFields"]
      .as_array()
      .unwrap_or_else(|| panic!("{type_name} has no inputFields"));
    assert!(
      fields.iter().any(|f| f["name"].as_str() == Some(field_name)),
      "{type_name} missing inputField '{field_name}'. Available: {:?}",
      fields
        .iter()
        .map(|f| f["name"].as_str().unwrap_or("?"))
        .collect::<Vec<_>>()
    );
  };

  // --- GqlLoggingConfig ---
  assert_field("GqlLoggingConfig", "modules");
  assert_field("GqlLoggingConfig", "output");
  assert_field("GqlLoggingConfig", "recentChanges");
  assert_field("GqlLoggingConfig", "diskUsage");

  // --- GqlLogModuleLevel ---
  assert_field("GqlLogModuleLevel", "group");
  assert_field("GqlLogModuleLevel", "displayName");
  assert_field("GqlLogModuleLevel", "level");
  assert_field("GqlLogModuleLevel", "recommendedDefault");
  assert_field("GqlLogModuleLevel", "description");
  assert_field("GqlLogModuleLevel", "highVolumeWarning");

  // --- GqlLogOutputConfig ---
  assert_field("GqlLogOutputConfig", "filePath");
  assert_field("GqlLogOutputConfig", "rotation");
  assert_field("GqlLogOutputConfig", "maxFiles");
  assert_field("GqlLogOutputConfig", "pathValid");
  assert_field("GqlLogOutputConfig", "pathError");

  // --- GqlLogDiskUsage ---
  assert_field("GqlLogDiskUsage", "totalBytes");
  assert_field("GqlLogDiskUsage", "fileCount");
  assert_field("GqlLogDiskUsage", "freeBytes");

  // --- GqlLogChangeEntry ---
  assert_field("GqlLogChangeEntry", "timestamp");
  assert_field("GqlLogChangeEntry", "group");
  assert_field("GqlLogChangeEntry", "previousLevel");
  assert_field("GqlLogChangeEntry", "newLevel");
  assert_field("GqlLogChangeEntry", "changedBy");
  assert_field("GqlLogChangeEntry", "autoRevertAt");

  // --- AdminRoot: loggingConfig ---
  // loggingConfig is under admin { }, not at flat query root.
  let admin_type = types
    .iter()
    .find(|t| t["name"].as_str() == Some("AdminRoot"))
    .expect("AdminRoot type must exist");
  let admin_fields = admin_type["fields"].as_array().expect("AdminRoot fields");
  assert!(
    admin_fields.iter().any(|f| f["name"].as_str() == Some("loggingConfig")),
    "AdminRoot missing 'loggingConfig'. Available: {:?}",
    admin_fields
      .iter()
      .map(|f| f["name"].as_str().unwrap_or("?"))
      .collect::<Vec<_>>()
  );

  // --- AdminRoot: mutation fields for logging ---
  // These are under admin { } too.
  for name in &[
    "updateLogModuleLevel",
    "resetLogLevels",
    "applyLogPreset",
    "updateLogOutput",
  ] {
    assert!(
      admin_fields.iter().any(|f| f["name"].as_str() == Some(name)),
      "AdminRoot missing '{name}'. Available: {:?}",
      admin_fields
        .iter()
        .map(|f| f["name"].as_str().unwrap_or("?"))
        .collect::<Vec<_>>()
    );
  }

  // --- Input types ---
  assert_input_field("UpdateLogModuleLevelInput", "group");
  assert_input_field("UpdateLogModuleLevelInput", "level");
  assert_input_field("UpdateLogModuleLevelInput", "autoRevertMinutes");

  assert_input_field("UpdateLogOutputInput", "filePath");
  assert_input_field("UpdateLogOutputInput", "rotation");
  assert_input_field("UpdateLogOutputInput", "maxFiles");

  let _ = pool;
}

/// P33-F-03: LogLevel and LogRotation enum values must match the frontend's
/// expected values exactly. If the server exposes different enum variants,
/// the admin frontend dropdowns/selects will silently break.
///
/// Invariant: GraphQL introspection exposes the PascalCase enum values
/// generated by `GqlLogLevel` and `GqlLogRotation`. Runtime mutation inputs
/// remain strings for compatibility and are covered by functional tests below.
#[tokio::test]
async fn inv_p33f03_logging_enum_values_match_frontend() {
  let (app, pool, _auth) = helpers::setup_app().await;

  // Introspect LogLevel enum
  let resp = helpers::gql_anon(
    &app,
    json!({"query": "{ __type(name: \"LogLevel\") { kind enumValues { name } } }"}),
  )
  .await;
  let log_level_type = &resp["data"]["__type"];
  assert_eq!(
    log_level_type["kind"].as_str(),
    Some("ENUM"),
    "LogLevel must be an ENUM type, got: {resp}"
  );
  let level_values: Vec<&str> = log_level_type["enumValues"]
    .as_array()
    .expect("LogLevel enumValues")
    .iter()
    .filter_map(|v| v["name"].as_str())
    .collect();
  let expected_levels = ["Trace", "Debug", "Info", "Warn", "Error"];
  for expected in &expected_levels {
    assert!(
      level_values.contains(expected),
      "LogLevel missing variant '{expected}'. Has: {level_values:?}"
    );
  }
  assert_eq!(
    level_values.len(),
    expected_levels.len(),
    "LogLevel has unexpected extra variants. Expected: {expected_levels:?}, got: {level_values:?}"
  );

  // Introspect LogRotation enum
  let resp = helpers::gql_anon(
    &app,
    json!({"query": "{ __type(name: \"LogRotation\") { kind enumValues { name } } }"}),
  )
  .await;
  let log_rotation_type = &resp["data"]["__type"];
  assert_eq!(
    log_rotation_type["kind"].as_str(),
    Some("ENUM"),
    "LogRotation must be an ENUM type, got: {resp}"
  );
  let rotation_values: Vec<&str> = log_rotation_type["enumValues"]
    .as_array()
    .expect("LogRotation enumValues")
    .iter()
    .filter_map(|v| v["name"].as_str())
    .collect();
  let expected_rotations = ["Never", "Hourly", "Daily", "Weekly"];
  for expected in &expected_rotations {
    assert!(
      rotation_values.contains(expected),
      "LogRotation missing variant '{expected}'. Has: {rotation_values:?}"
    );
  }
  assert_eq!(
    rotation_values.len(),
    expected_rotations.len(),
    "LogRotation has unexpected extra variants. Expected: {expected_rotations:?}, got: {rotation_values:?}"
  );

  let _ = pool;
}

// ===========================================================================
// 2. Functional Integration Tests (P33-D-04, P33-D-05, P33-D-06)
// ===========================================================================

/// P33-D-04: Updating a module level is reflected in the config query.
#[tokio::test]
async fn inv_p33d04_update_log_level_reflected_in_config() {
  let (app, pool, auth) = setup_app_with_logging().await;
  let (user_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  // Update "api" group to DEBUG
  let mutation = r#"
    mutation {
      admin {
        updateLogModuleLevel(input: { group: "api", level: "DEBUG" }) {
          group level
        }
      }
    }
    "#;
  let resp = helpers::gql(&app, session_id, json!({"query": mutation})).await;
  assert!(resp["errors"].is_null(), "updateLogModuleLevel returned errors: {resp}");
  assert_eq!(
    resp["data"]["admin"]["updateLogModuleLevel"]["level"].as_str(),
    Some("debug")
  );

  // Query loggingConfig and verify api group shows debug
  let query = r#"
    {
      admin {
        loggingConfig {
          modules { group level }
        }
      }
    }
    "#;
  let resp = helpers::gql(&app, session_id, json!({"query": query})).await;
  assert!(resp["errors"].is_null(), "loggingConfig returned errors: {resp}");
  let modules = resp["data"]["admin"]["loggingConfig"]["modules"]
    .as_array()
    .expect("modules");
  let api_module = modules
    .iter()
    .find(|m| m["group"].as_str() == Some("api"))
    .expect("api group");
  assert_eq!(api_module["level"].as_str(), Some("debug"));

  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// P33-D-05: Updating log output with an invalid path returns pathValid=false
/// and a non-empty pathError message. The filePath field echoes back the
/// submitted value.
#[tokio::test]
async fn inv_p33d05_update_log_output_invalid_path() {
  let (app, pool, auth) = setup_app_with_logging().await;
  let (user_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  const INVALID_PATH: &str = "/nonexistent/deeply/nested/impossible/path/test.log";
  let mutation = r#"
    mutation {
      admin {
        updateLogOutput(input: { filePath: "/nonexistent/deeply/nested/impossible/path/test.log" }) {
          pathValid pathError filePath
        }
      }
    }
    "#;
  let resp = helpers::gql(&app, session_id, json!({"query": mutation})).await;
  assert!(resp["errors"].is_null(), "updateLogOutput returned errors: {resp}");
  let output = &resp["data"]["admin"]["updateLogOutput"];
  assert_eq!(
    output["pathValid"].as_bool(),
    Some(false),
    "pathValid must be false for an unwritable path, got: {output}"
  );
  let path_error = output["pathError"]
    .as_str()
    .unwrap_or_else(|| panic!("pathError must be a non-null string for invalid path, got: {output}"));
  assert!(
    !path_error.is_empty(),
    "pathError must not be an empty string for invalid path, got: {output}"
  );
  // filePath must echo back the submitted value so the frontend can display it.
  assert_eq!(
    output["filePath"].as_str(),
    Some(INVALID_PATH),
    "filePath must echo back the submitted path, got: {output}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// P33-D-06: Applying "production" preset sets all groups to recommended defaults.
/// Invariant: modules list is non-empty and every entry has level == recommendedDefault.
#[tokio::test]
async fn inv_p33d06_apply_preset_production() {
  let (app, pool, auth) = setup_app_with_logging().await;
  let (user_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  // First change a level away from default to confirm the preset actually resets it.
  let mutation = r#"
    mutation {
      admin {
        updateLogModuleLevel(input: { group: "api", level: "TRACE" }) {
          group level
        }
      }
    }
    "#;
  let resp = helpers::gql(&app, session_id, json!({"query": mutation})).await;
  assert!(resp["errors"].is_null(), "pre-change failed: {resp}");
  assert_eq!(
    resp["data"]["admin"]["updateLogModuleLevel"]["level"].as_str(),
    Some("trace"),
    "pre-change must set api to trace"
  );

  // Apply "production" preset
  let mutation = r#"
    mutation {
      admin {
        applyLogPreset(preset: "production") {
          group level recommendedDefault
        }
      }
    }
    "#;
  let resp = helpers::gql(&app, session_id, json!({"query": mutation})).await;
  assert!(resp["errors"].is_null(), "applyLogPreset returned errors: {resp}");
  let modules = resp["data"]["admin"]["applyLogPreset"].as_array().expect("modules");
  assert!(
    !modules.is_empty(),
    "applyLogPreset must return at least one module entry"
  );
  // Every module must have level == recommendedDefault.
  for m in modules {
    assert_eq!(
      m["level"].as_str(),
      m["recommendedDefault"].as_str(),
      "after production preset, group '{}' level must match recommendedDefault",
      m["group"].as_str().unwrap_or("?")
    );
  }

  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// P33-D-04: Reset after change restores all groups to defaults.
/// Invariant: modules list is non-empty and every entry has level == recommendedDefault.
/// The two specific groups we dirtied must also appear in the reset result.
#[tokio::test]
async fn inv_p33d04_reset_after_change() {
  let (app, pool, auth) = setup_app_with_logging().await;
  let (user_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  // Change api to TRACE and database to DEBUG — dirty two groups so reset is meaningful.
  let m1 = r#"mutation { admin { updateLogModuleLevel(input: { group: "api", level: "TRACE" }) { group level } } }"#;
  let m2 =
    r#"mutation { admin { updateLogModuleLevel(input: { group: "database", level: "DEBUG" }) { group level } } }"#;
  let r1 = helpers::gql(&app, session_id, json!({"query": m1})).await;
  assert!(r1["errors"].is_null(), "change api failed: {r1}");
  assert_eq!(
    r1["data"]["admin"]["updateLogModuleLevel"]["level"].as_str(),
    Some("trace"),
    "api must be set to trace before reset"
  );
  let r2 = helpers::gql(&app, session_id, json!({"query": m2})).await;
  assert!(r2["errors"].is_null(), "change database failed: {r2}");
  assert_eq!(
    r2["data"]["admin"]["updateLogModuleLevel"]["level"].as_str(),
    Some("debug"),
    "database must be set to debug before reset"
  );

  // Reset all
  let reset = r#"
    mutation {
      admin {
        resetLogLevels {
          group level recommendedDefault
        }
      }
    }
    "#;
  let resp = helpers::gql(&app, session_id, json!({"query": reset})).await;
  assert!(resp["errors"].is_null(), "resetLogLevels returned errors: {resp}");
  let modules = resp["data"]["admin"]["resetLogLevels"].as_array().expect("modules");
  assert!(
    !modules.is_empty(),
    "resetLogLevels must return at least one module entry"
  );
  for m in modules {
    assert_eq!(
      m["level"].as_str(),
      m["recommendedDefault"].as_str(),
      "after reset, group '{}' must be at recommendedDefault",
      m["group"].as_str().unwrap_or("?")
    );
  }
  // The two groups we dirtied must appear in the reset result.
  assert!(
    modules.iter().any(|m| m["group"].as_str() == Some("api")),
    "reset result must include the 'api' group"
  );
  assert!(
    modules.iter().any(|m| m["group"].as_str() == Some("database")),
    "reset result must include the 'database' group"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// P33-D-04: Changing a level records the change in recentChanges history.
#[tokio::test]
async fn inv_p33d04_history_records_change() {
  let (app, pool, auth) = setup_app_with_logging().await;
  let (user_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  // Change websocket to DEBUG
  let mutation = r#"
    mutation {
      admin {
        updateLogModuleLevel(input: { group: "websocket", level: "DEBUG" }) {
          group level
        }
      }
    }
    "#;
  let resp = helpers::gql(&app, session_id, json!({"query": mutation})).await;
  assert!(resp["errors"].is_null(), "updateLogModuleLevel failed: {resp}");

  // Query recentChanges
  let query = r#"
    {
      admin {
        loggingConfig {
          recentChanges {
            group previousLevel newLevel changedBy
          }
        }
      }
    }
    "#;
  let resp = helpers::gql(&app, session_id, json!({"query": query})).await;
  assert!(resp["errors"].is_null(), "loggingConfig query failed: {resp}");
  let changes = resp["data"]["admin"]["loggingConfig"]["recentChanges"]
    .as_array()
    .expect("recentChanges array");
  assert!(
    !changes.is_empty(),
    "recentChanges must not be empty after a level change"
  );

  // Find the websocket change entry — must record exact before/after levels.
  let ws_change = changes
    .iter()
    .find(|c| c["group"].as_str() == Some("websocket") && c["newLevel"].as_str() == Some("debug"))
    .expect("must find websocket->debug change in history");
  assert_eq!(
    ws_change["previousLevel"].as_str(),
    Some("info"),
    "previousLevel must be 'info' (the default) before the change"
  );
  assert_eq!(
    ws_change["newLevel"].as_str(),
    Some("debug"),
    "newLevel must be 'debug' as requested"
  );
  // changedBy must be a non-empty string identifying the actor.
  let changed_by = ws_change["changedBy"]
    .as_str()
    .unwrap_or_else(|| panic!("changedBy must be a non-null string, got: {ws_change}"));
  assert!(
    !changed_by.is_empty(),
    "changedBy must not be an empty string, got: {ws_change}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}
