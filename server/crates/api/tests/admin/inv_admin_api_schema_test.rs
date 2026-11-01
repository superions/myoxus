//! Invariant tests for admin GraphQL API schema structure (P95-API-19).
//!
//! **Invariant INV-API-01**: ALL admin operations MUST be accessible exclusively
//! via `{ admin { ... } }` — never at the flat root level.
//!
//! **Invariant INV-API-02**: The `admin` field MUST exist on both Query and Mutation.
//!
//! **Invariant INV-API-03**: Key admin operations MUST be accessible via `admin { }`.
//!
//! These tests prevent regression of the P95-API restructuring where admin ops
//! were scattered across flat root, teams { }, and templateRegistry { }.

use crate::helpers;

use serde_json::json;

async fn root_fields(app: &axum::Router, session: uuid::Uuid) -> (Vec<String>, Vec<String>) {
  let resp = helpers::gql(
    app,
    session,
    json!({
      "query": "{ __schema { queryType { fields(includeDeprecated: true) { name } } mutationType { fields(includeDeprecated: true) { name } } } }"
    }),
  )
  .await;

  let q: Vec<String> = resp["data"]["__schema"]["queryType"]["fields"]
    .as_array()
    .unwrap_or(&vec![])
    .iter()
    .filter_map(|f| f["name"].as_str().map(String::from))
    .collect();

  let m: Vec<String> = resp["data"]["__schema"]["mutationType"]["fields"]
    .as_array()
    .unwrap_or(&vec![])
    .iter()
    .filter_map(|f| f["name"].as_str().map(String::from))
    .collect();

  (q, m)
}

async fn admin_root_fields(app: &axum::Router, session: uuid::Uuid) -> Vec<String> {
  let resp = helpers::gql(
    app,
    session,
    // Deprecated AdminRoot fields still belong to the contract until the
    // corresponding domain migration removes them. Without includeDeprecated
    // GraphQL introspection silently hides those fields and this invariant can
    // report false negatives.
    json!({ "query": r#"{ __type(name: "AdminRoot") { fields(includeDeprecated: true) { name } } }"# }),
  )
  .await;

  resp["data"]["__type"]["fields"]
    .as_array()
    .unwrap_or(&vec![])
    .iter()
    .filter_map(|f| f["name"].as_str().map(String::from))
    .collect()
}

/// INV-API-02: admin field must exist on both Query and Mutation roots.
#[tokio::test]
async fn inv_api02_admin_field_on_both_roots() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session) = helpers::seed_admin(&pool, &auth_store).await;

  let (query_fields, mutation_fields) = root_fields(&app, session).await;

  helpers::cleanup_users(&pool, &[admin_id]).await;

  assert!(
    query_fields.contains(&"admin".to_string()),
    "INV-API-02 FAIL: Query root missing 'admin' field"
  );
  assert!(
    mutation_fields.contains(&"admin".to_string()),
    "INV-API-02 FAIL: Mutation root missing 'admin' field"
  );
}

/// INV-API-01: Former flat-root admin query operations must NOT be at query root.
#[tokio::test]
async fn inv_api01_no_flat_root_admin_queries() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session) = helpers::seed_admin(&pool, &auth_store).await;

  let (query_fields, _) = root_fields(&app, session).await;

  helpers::cleanup_users(&pool, &[admin_id]).await;

  // These ops MUST be under admin { } — NOT at flat root.
  let forbidden_at_root = [
    "adminWorkspaces",
    "adminWorkspacesCount",
    "adminWorkspace",
    "orphanedWorkspaces",
    "orphanedWorkspacesCount",
    "adminAllSharedLinks",
    "adminDashboard",
    "adminConfigSchema",
    "adminConfigValues",
    "validateAppConfig",
    "adminCacheTuningStatus",
    "adminCacheTuningHistory",
    "loggingConfig",
    "storageQuotaConfig",
    "configChangelog",
    "userByEmail",
    "userById",
    "teamMembers",
    "templateCatalog",
    "templateCatalogCount",
    "templateRevisions",
    "templateAssignments",
    "workspaceTemplateInstances",
    "templateJobs",
    "metricsStatus",
    "telemetryStatus",
    "themeCatalog",
    "effectiveThemeProfile",
    "appServerBranding",
    "organizationIdentity",
    "flushMetrics",
    "flushTelemetry",
  ];

  for op in &forbidden_at_root {
    assert!(
      !query_fields.contains(&op.to_string()),
      "INV-API-01 FAIL: Admin query '{op}' is at flat root — must be under admin {{ }}"
    );
  }
}

/// INV-API-01: Former flat-root admin mutation operations must NOT be at mutation root.
#[tokio::test]
async fn inv_api01_no_flat_root_admin_mutations() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session) = helpers::seed_admin(&pool, &auth_store).await;

  let (_, mutation_fields) = root_fields(&app, session).await;

  helpers::cleanup_users(&pool, &[admin_id]).await;

  let forbidden_at_root = [
    "createUser",
    "updateUser",
    "deleteUser",
    "banUser",
    "enableUser",
    "importUsers",
    "updateUserFeatures",
    "createChangePasswordUrl",
    "adminUpdateWorkspace",
    "addWorkspaceFeature",
    "removeWorkspaceFeature",
    "reassignWorkspaceOwner",
    "triggerWorkspaceReindex",
    "triggerFullReindex",
    "adminUpdateConfig",
    "adminFlushDocMetadataProjectionCache",
    "sendTestEmail",
    "updateLogModuleLevel",
    "resetLogLevels",
    "applyLogPreset",
    "updateLogOutput",
    "createTeam",
    "updateTeam",
    "deleteTeam",
    "addTeamMember",
    "updateTeamMemberRole",
    "removeTeamMember",
    "importTemplate",
    "publishRevision",
    "assignTemplateToWorkspace",
    "removeTemplateAssignment",
    "triggerReconcile",
    "retireTemplateAssignment",
    "archiveTemplate",
    "disableTemplate",
    "enableTemplate",
    "exportRevision",
    "triggerDriftScan",
    "metricsStatus",
    "telemetryStatus",
    "setThemeProfile",
    "setTypographyStyles",
    "setColorSchemaValues",
    "resetWorkspaceThemeProfile",
    "updateOrganizationIdentity",
    "updateAppServerBranding",
    "flushMetrics",
    "flushTelemetry",
  ];

  for op in &forbidden_at_root {
    assert!(
      !mutation_fields.contains(&op.to_string()),
      "INV-API-01 FAIL: Admin mutation '{op}' is at flat root — must be under admin {{ }}"
    );
  }
}

/// INV-API-03: Key admin operations MUST be accessible via admin { }.
#[tokio::test]
async fn inv_api03_admin_root_has_required_operations() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session) = helpers::seed_admin(&pool, &auth_store).await;

  let admin_fields = admin_root_fields(&app, session).await;

  helpers::cleanup_users(&pool, &[admin_id]).await;

  let required = [
    "adminWorkspaces",
    "adminWorkspace",
    "orphanedWorkspaces",
    "orphanedWorkspacesCount",
    "adminAllSharedLinks",
    "adminDashboard",
    "adminConfigSchema",
    "adminConfigValues",
    "validateAppConfig",
    "documentRuntimeOverview",
    "adminUpdateConfig",
    "loggingConfig",
    "storageQuotaConfig",
    "userByEmail",
    "userById",
    "users",
    "usersCount",
    "serverInfo",
    "metricsStatus",
    "telemetryStatus",
    "themeCatalog",
    "effectiveThemeProfile",
    "appServerBranding",
    "organizationIdentity",
    "setThemeProfile",
    "setTypographyStyles",
    "setColorSchemaValues",
    "resetWorkspaceThemeProfile",
    "updateOrganizationIdentity",
    "updateAppServerBranding",
    "flushMetrics",
    "flushTelemetry",
    "createUser",
    "updateUser",
    "deleteUser",
    "banUser",
    "enableUser",
    "importUsers",
    "updateUserFeatures",
    "createChangePasswordUrl",
    "adminUpdateWorkspace",
    "reassignWorkspaceOwner",
    "triggerWorkspaceReindex",
    "triggerFullReindex",
    "adminUpdateConfig",
    "sendTestEmail",
    "updateLogModuleLevel",
    "resetLogLevels",
    "applyLogPreset",
    "updateLogOutput",
    "importTemplate",
    "publishRevision",
    "archiveTemplate",
    "enableTemplate",
    "disableTemplate",
  ];

  for op in &required {
    assert!(
      admin_fields.contains(&op.to_string()),
      "INV-API-03 FAIL: AdminRoot missing required operation '{op}'. Has: {admin_fields:?}"
    );
  }
}
