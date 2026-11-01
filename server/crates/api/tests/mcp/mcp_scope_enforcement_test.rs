// SPDX-License-Identifier: AGPL-3.0-or-later
//! MCP-RV-08c: API keys with restricted scopes must not access unauthorized resources.
//!
//! Verifies that MCP scope enforcement correctly rejects operations when the
//! `McpAuthContext` lacks the required scope. Each test constructs a restricted
//! auth context and asserts that the corresponding resource/tool call either
//! returns an error or a filtered-empty response.

use crate::helpers;

use myoxus_application::doc::DocService;
use myoxus_application::permission::PermissionService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_mcp::auth::McpAuthContext;
use myoxus_mcp::resources::{list_resources, read_resource};
use myoxus_mcp::tools::{McpToolState, dispatch_tool};
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

/// Build an `McpToolState` from the test pool.
fn build_tool_state(pool: &sqlx::PgPool) -> McpToolState {
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  McpToolState {
    html_catalog: Some(Arc::new(
      myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html"),
      ),
    )),
    workspace_service: WorkspaceService::new(workspace_store),
    workspace_settings_service: None,
    public_repository: None,
    public_delivery_enabled: false,
    document_publication_service: None,
    doc_service: DocService::new(doc_store),
    comment_service: None,
    server_origin: Arc::from("https://myoxus.test"),
    permission_service: Arc::new(PermissionService::new(auth_store)),
    search_indexer: None,
    search_repository: None,
    assistant_packages: None,
    database_services: None,
    calendar: None,
    organization: None,
    users: None,
    workspace_tag_service: None,
    document_graph_service: None,
    document_template_service: None,
    template_registry: None,
    template_suggestions: None,
    workspace_automation_service: None,
    pdf_export_service: None,
    pdf_template_repo: None,
    pdf_assignment_repo: None,
    document_services: Arc::new(myoxus_application::mcp::UnavailableMcpDocumentOperations),
    idempotency: Arc::new(myoxus_application::mcp::InMemoryMcpIdempotencyRepository::default()),
    blob_service: None,
    upload_policy: None,
    audit_recorder: myoxus_application::audit::AuditRecorder::noop(),
    metrics_service: Arc::new(myoxus_application::metrics::MetricsService::in_memory_stub()),
    document_cursor_signing_key: Arc::from(&b"mcp-scope-test-cursor-key"[..]),
    document_export_max_bytes: 8 * 1024 * 1024,
  }
}

/// Build an `McpAuthContext` with only the specified scopes.
fn auth_with_scopes(user_id: Uuid, scopes: &[&str]) -> McpAuthContext {
  McpAuthContext {
    user_id,
    scopes: scopes.iter().map(|s| s.to_string()).collect(),
    key_id: Uuid::new_v4(),
  }
}

// ─── MCP-RV-08c-01: resources/list without read:workspaces returns empty ─────

#[tokio::test]
async fn inv_mcp_rv08c_resources_list_denied_without_read_workspaces() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-sc-rl").await;
  let _workspace = helpers::create_workspace(&pool, user).await;

  let state = build_tool_state(&pool);
  let auth = auth_with_scopes(user, &["write:docs"]);

  let result = list_resources(&state.workspace_service, &auth)
    .await
    .expect("scope-filtered discovery");
  let resources = result.resources;
  assert!(
    resources.is_empty(),
    "resources/list must return empty when missing read:workspaces scope"
  );

  helpers::cleanup_users(&pool, &[user]).await;
}

// ─── MCP-RV-08c-02: resources/read without read:workspaces must fail ─────────

#[tokio::test]
async fn inv_mcp_rv08c_resources_read_denied_without_read_workspaces() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-sc-rr").await;
  let workspace = helpers::create_workspace(&pool, user).await;

  let state = build_tool_state(&pool);
  let auth = auth_with_scopes(user, &["write:docs"]);
  let uri = format!("myoxus://{workspace}");

  let result = read_resource(&uri, &state, &auth).await;
  assert!(
    result.is_err(),
    "resources/read must reject when missing read:workspaces scope"
  );
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32600, "expected invalid-request error, got {code}: {msg}");
  assert!(
    msg.contains("read:workspaces"),
    "error should mention missing scope: {msg}"
  );

  helpers::cleanup_users(&pool, &[user]).await;
}

// ─── MCP-RV-08c-03: list_workspaces tool without read:workspaces must fail ───

#[tokio::test]
async fn inv_mcp_rv08c_list_workspaces_denied_without_scope() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-sc-lw").await;
  let _workspace = helpers::create_workspace(&pool, user).await;

  let state = build_tool_state(&pool);
  let auth = auth_with_scopes(user, &["read:docs"]);

  let result = dispatch_tool("list_workspaces", &json!({}), &auth, &state).await;
  assert!(
    result.is_err(),
    "list_workspaces must reject when missing read:workspaces scope"
  );
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32003, "expected scope-denied error, got {code}: {msg}");

  helpers::cleanup_users(&pool, &[user]).await;
}

// ─── MCP-RV-08c-04: read_doc tool without read:docs must fail ────────────────

#[tokio::test]
async fn inv_mcp_rv08c_read_doc_denied_without_read_docs() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-sc-rd").await;
  let workspace = helpers::create_workspace(&pool, user).await;
  let doc = helpers::create_doc(&pool, workspace, user).await;

  let state = build_tool_state(&pool);
  let auth = auth_with_scopes(user, &["write:docs"]);

  let result = dispatch_tool(
    "read_doc",
    &json!({
        "workspace_id": workspace.to_string(),
        "external_id": doc.to_string(),
    }),
    &auth,
    &state,
  )
  .await;

  assert!(result.is_err(), "read_doc must reject when missing read:docs scope");
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32003, "expected scope-denied error, got {code}: {msg}");

  helpers::cleanup_users(&pool, &[user]).await;
}

// ─── MCP-RV-08c-05: create_page tool without write:docs must fail ────────────

#[tokio::test]
async fn inv_mcp_rv08c_create_page_denied_without_write_docs() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-sc-cp").await;
  let workspace = helpers::create_workspace(&pool, user).await;

  let state = build_tool_state(&pool);
  let auth = auth_with_scopes(user, &["read:workspaces", "read:docs"]);

  let result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "title": "Should Not Be Created",
    }),
    &auth,
    &state,
  )
  .await;

  assert!(result.is_err(), "create_page must reject when missing write:docs scope");
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32003, "expected scope-denied error, got {code}: {msg}");

  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_rv08c_create_page_denied_when_workspace_role_cannot_create_docs() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-acl-cp-reader").await;
  let workspace = helpers::create_workspace(&pool, user).await;
  sqlx::query("UPDATE workspace_memberships SET role = 'Reader' WHERE workspace_id = $1 AND user_id = $2")
    .bind(workspace)
    .bind(user)
    .execute(&pool)
    .await
    .expect("downgrade workspace role to Reader");

  let state = build_tool_state(&pool);
  let auth = auth_with_scopes(user, &["read:workspaces", "read:docs", "write:docs"]);

  let result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "title": "Must Not Be Created",
    }),
    &auth,
    &state,
  )
  .await;

  assert!(
    result.is_err(),
    "write:docs scope must not bypass workspace CreateDoc ACL"
  );
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32003, "expected permission-denied error, got {code}: {msg}");
  assert!(
    msg.contains("CreateDoc"),
    "error should name the missing workspace action: {msg}"
  );

  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_rv08c_update_doc_denied_when_doc_role_cannot_update() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (owner, _) = helpers::seed_user(&pool, &auth_store, "mcp-acl-up-owner").await;
  let (reader, _) = helpers::seed_user(&pool, &auth_store, "mcp-acl-up-reader").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let doc = helpers::create_doc(&pool, workspace, owner).await;
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
     VALUES ($1, $2, 'Reader', 'Accepted', now())",
  )
  .bind(workspace)
  .bind(reader)
  .execute(&pool)
  .await
  .expect("add Reader member");

  let state = build_tool_state(&pool);
  let auth = auth_with_scopes(reader, &["read:workspaces", "read:docs", "write:docs"]);

  let result = dispatch_tool(
    "update_doc",
    &json!({
        "workspace_id": workspace.to_string(),
        "external_id": doc.to_string(),
        "content_markdown": "Reader must not write",
    }),
    &auth,
    &state,
  )
  .await;

  assert!(result.is_err(), "write:docs scope must not bypass document Update ACL");
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32003, "expected permission-denied error, got {code}: {msg}");
  assert!(
    msg.contains("Update"),
    "error should name the missing doc action: {msg}"
  );

  helpers::cleanup_users(&pool, &[owner, reader]).await;
}

#[tokio::test]
async fn inv_mcp_rv08c_delete_page_denied_when_doc_role_cannot_trash() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (owner, _) = helpers::seed_user(&pool, &auth_store, "mcp-acl-del-owner").await;
  let (reader, _) = helpers::seed_user(&pool, &auth_store, "mcp-acl-del-reader").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let doc = helpers::create_doc(&pool, workspace, owner).await;
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
     VALUES ($1, $2, 'Reader', 'Accepted', now())",
  )
  .bind(workspace)
  .bind(reader)
  .execute(&pool)
  .await
  .expect("add Reader member");

  let state = build_tool_state(&pool);
  let auth = auth_with_scopes(reader, &["read:workspaces", "read:docs", "write:docs"]);

  let result = dispatch_tool(
    "delete_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "external_id": doc.to_string(),
    }),
    &auth,
    &state,
  )
  .await;

  assert!(result.is_err(), "write:docs scope must not bypass document Trash ACL");
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32003, "expected permission-denied error, got {code}: {msg}");
  assert!(msg.contains("Trash"), "error should name the missing doc action: {msg}");

  helpers::cleanup_users(&pool, &[owner, reader]).await;
}

#[tokio::test]
async fn inv_mcp_resource_discovery_distinguishes_empty_scope_and_backend_failure() {
  use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
  };
  use futures_util::FutureExt;
  use myoxus_application::api_key::ApiKeyService;
  use myoxus_infrastructure::api_key::SqlxApiKeyStore;
  use myoxus_mcp::router::{McpState, StaticMcpAvailability, mcp_router};
  use myoxus_mcp::subscriptions::SubscriptionHub;
  use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
  use tower::ServiceExt;

  async fn request(app: &Router, token: &str) -> serde_json::Value {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("POST")
          .uri("/")
          .header("authorization", format!("Bearer {token}"))
          .header("content-type", "application/json")
          .body(Body::from(
            json!({"jsonrpc":"2.0","id":9,"method":"resources/list"}).to_string(),
          ))
          .unwrap(),
      )
      .await
      .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 65536).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["id"], 9);
    body
  }

  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner, _) = helpers::seed_user(&pool, &auth_store, "mcp-resource-owner").await;
  let (empty_user, _) = helpers::seed_user(&pool, &auth_store, "mcp-resource-empty").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  // Only the Workspace adapter fails. API-key authentication keeps its real SQL
  // store and no shared test table or server-owned configuration is changed.
  let unavailable = PgPoolOptions::new()
    .max_connections(1)
    .acquire_timeout(std::time::Duration::from_millis(50))
    .connect_lazy_with(
      PgConnectOptions::new()
        .host("127.0.0.1")
        .port(1)
        .username("mcp_unreachable")
        .database("mcp_unreachable"),
    );
  let outcome = std::panic::AssertUnwindSafe(async {
    let keys = ApiKeyService::new(Arc::new(SqlxApiKeyStore::new(pool.clone())));
    let (_, owner_key) = keys
      .generate(owner, "mcp:inventory".into(), vec!["read:workspaces".into()], None)
      .await
      .unwrap();
    let (_, empty_key) = keys
      .generate(empty_user, "mcp:empty".into(), vec!["read:workspaces".into()], None)
      .await
      .unwrap();
    let (_, missing_scope_key) = keys
      .generate(owner, "mcp:no-scope".into(), vec!["write:docs".into()], None)
      .await
      .unwrap();
    let normal = McpState {
      key_service: keys,
      tool_state: build_tool_state(&pool),
      subscriptions: SubscriptionHub::new(),
      availability: Arc::new(StaticMcpAvailability(true)),
    };
    let app = mcp_router(normal.clone());
    let success = request(&app, &owner_key).await;
    assert!(success.get("error").is_none());
    assert!(
      success["result"]["resources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|resource| resource["uri"] == format!("myoxus://{workspace}"))
    );
    let empty = request(&app, &empty_key).await;
    assert_eq!(empty["result"], json!({"resources":[]}));
    assert!(empty.get("error").is_none());
    let mut broken = normal;
    broken.tool_state.workspace_service = WorkspaceService::new(Arc::new(SqlxWorkspaceStore::new(
      unavailable.clone(),
      crate::helpers::database_starter_catalog(),
    )));
    let broken_app = mcp_router(broken);
    let no_scope = request(&broken_app, &missing_scope_key).await;
    assert_eq!(no_scope["result"], json!({"resources":[]}));
    assert!(no_scope.get("error").is_none());
    let failure = request(&broken_app, &owner_key).await;
    assert!(failure.get("result").is_none());
    assert_eq!(
      failure["error"],
      json!({"code":-32002,"message":"Workspace resource discovery is unavailable"})
    );
  })
  .catch_unwind()
  .await;
  unavailable.close().await;
  helpers::cleanup_users(&pool, &[owner, empty_user]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_automation_read_scope_does_not_follow_write_scope() {
  let pool = helpers::setup_pool().await;
  let state = build_tool_state(&pool);
  for scopes in [&[][..], &["write:automations"][..]] {
    let auth = auth_with_scopes(Uuid::new_v4(), scopes);
    for name in [
      "automation_list",
      "automation_run_list",
      "automation_run_get",
      "automation_dead_letter_list",
    ] {
      let error = dispatch_tool(
        name,
        &json!({"run_id":Uuid::new_v4(),"workspace_id":Uuid::new_v4()}),
        &auth,
        &state,
      )
      .await
      .expect_err("scope must precede service and data lookup");
      assert_eq!(error.0, -32003);
    }
  }
  let reader = auth_with_scopes(Uuid::new_v4(), &["read:automations"]);
  assert_eq!(
    dispatch_tool(
      "automation_run_retry",
      &json!({"run_id":Uuid::new_v4(),"idempotency_key":"denied"}),
      &reader,
      &state
    )
    .await
    .unwrap_err()
    .0,
    -32003
  );
}
