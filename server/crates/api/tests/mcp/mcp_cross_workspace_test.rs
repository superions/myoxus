// SPDX-License-Identifier: AGPL-3.0-or-later
//! MCP-RV-01d: Cross-workspace doc access must fail through MCP.
//!
//! Verifies that a user who is a member of workspace_b cannot access
//! documents belonging to workspace_a through MCP tool calls, even when
//! they know an external document key. The workspace isolation boundary must hold for
//! all doc-scoped MCP tools: read_doc, update_doc, delete_page.
//! Additionally, a non-member must be denied workspace-level access.

use crate::helpers;

use myoxus_application::doc::DocService;
use myoxus_application::permission::PermissionService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_mcp::auth::McpAuthContext;
use myoxus_mcp::resources::read_resource;
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
    document_cursor_signing_key: Arc::from(&b"mcp-cross-workspace-test-cursor-key"[..]),
    document_export_max_bytes: 8 * 1024 * 1024,
  }
}

/// Build an `McpAuthContext` with full read+write scopes for the given user.
fn auth_context(user_id: Uuid) -> McpAuthContext {
  McpAuthContext {
    user_id,
    scopes: vec![
      "read:workspaces".to_string(),
      "read:docs".to_string(),
      "write:docs".to_string(),
    ],
    key_id: Uuid::new_v4(),
  }
}

// ─── MCP-RV-01d-01: read_doc with cross-workspace doc_id must fail ───────────

#[tokio::test]
async fn inv_mcp_rv01d_read_doc_cross_workspace_denied() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user_a, _) = helpers::seed_user(&pool, &auth_store, "mcp-xws-a").await;
  let (user_b, _) = helpers::seed_user(&pool, &auth_store, "mcp-xws-b").await;

  let workspace_a = helpers::create_workspace(&pool, user_a).await;
  let workspace_b = helpers::create_workspace(&pool, user_b).await;
  let doc_in_a = helpers::create_doc(&pool, workspace_a, user_a).await;

  let state = build_tool_state(&pool);
  let auth_b = auth_context(user_b);

  // user_b calls read_doc with workspace_b but doc_in_a's ID
  let result = dispatch_tool(
    "read_doc",
    &json!({
        "workspace_id": workspace_b.to_string(),
        "external_id": doc_in_a.to_string(),
    }),
    &auth_b,
    &state,
  )
  .await;

  assert!(result.is_err(), "read_doc must reject cross-workspace doc access");
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32004, "expected 'not found' error code, got {code}: {msg}");

  helpers::cleanup_users(&pool, &[user_a, user_b]).await;
}

// ─── MCP-RV-01d-02: update_doc with cross-workspace doc_id must fail ─────────

#[tokio::test]
async fn inv_mcp_rv01d_update_doc_cross_workspace_denied() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user_a, _) = helpers::seed_user(&pool, &auth_store, "mcp-xws-ua").await;
  let (user_b, _) = helpers::seed_user(&pool, &auth_store, "mcp-xws-ub").await;

  let workspace_a = helpers::create_workspace(&pool, user_a).await;
  let workspace_b = helpers::create_workspace(&pool, user_b).await;
  let doc_in_a = helpers::create_doc(&pool, workspace_a, user_a).await;

  let state = build_tool_state(&pool);
  let auth_b = auth_context(user_b);

  let result = dispatch_tool(
    "update_doc",
    &json!({
        "workspace_id": workspace_b.to_string(),
        "external_id": doc_in_a.to_string(),
        "content_markdown": "# Injected content",
    }),
    &auth_b,
    &state,
  )
  .await;

  assert!(result.is_err(), "update_doc must reject cross-workspace doc access");
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32004, "expected 'not found' error code, got {code}: {msg}");

  helpers::cleanup_users(&pool, &[user_a, user_b]).await;
}

// ─── MCP-RV-01d-03: delete_page with cross-workspace doc_id must fail ────────

#[tokio::test]
async fn inv_mcp_rv01d_delete_page_cross_workspace_denied() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user_a, _) = helpers::seed_user(&pool, &auth_store, "mcp-xws-da").await;
  let (user_b, _) = helpers::seed_user(&pool, &auth_store, "mcp-xws-db").await;

  let workspace_a = helpers::create_workspace(&pool, user_a).await;
  let workspace_b = helpers::create_workspace(&pool, user_b).await;
  let doc_in_a = helpers::create_doc(&pool, workspace_a, user_a).await;

  let state = build_tool_state(&pool);
  let auth_b = auth_context(user_b);

  let result = dispatch_tool(
    "delete_page",
    &json!({
        "workspace_id": workspace_b.to_string(),
        "external_id": doc_in_a.to_string(),
    }),
    &auth_b,
    &state,
  )
  .await;

  assert!(result.is_err(), "delete_page must reject cross-workspace doc access");
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32004, "expected 'not found' error code, got {code}: {msg}");

  helpers::cleanup_users(&pool, &[user_a, user_b]).await;
}

// ─── MCP-RV-01d-04: non-member workspace access must fail ────────────────────

#[tokio::test]
async fn inv_mcp_rv01d_non_member_workspace_denied() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user_a, _) = helpers::seed_user(&pool, &auth_store, "mcp-xws-na").await;
  let (user_b, _) = helpers::seed_user(&pool, &auth_store, "mcp-xws-nb").await;

  let workspace_a = helpers::create_workspace(&pool, user_a).await;
  let doc_in_a = helpers::create_doc(&pool, workspace_a, user_a).await;

  let state = build_tool_state(&pool);
  let auth_b = auth_context(user_b);

  // user_b tries to read_doc using workspace_a directly (not a member)
  let result = dispatch_tool(
    "read_doc",
    &json!({
        "workspace_id": workspace_a.to_string(),
        "external_id": doc_in_a.to_string(),
    }),
    &auth_b,
    &state,
  )
  .await;

  assert!(result.is_err(), "read_doc must deny non-member workspace access");
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32003, "expected permission denied error, got {code}: {msg}");

  helpers::cleanup_users(&pool, &[user_a, user_b]).await;
}

#[tokio::test]
async fn inv_mcp_compat_external_keys_are_workspace_scoped_without_uuid_syntax_guessing() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-external-key-collision").await;
  let workspace_a = super::mcp_create_page_test::create_workspace(&pool, user).await;
  let workspace_b = super::mcp_create_page_test::create_workspace(&pool, user).await;
  let state = super::mcp_create_page_test::build_tool_state(&pool);
  let mut native_ids = Vec::new();
  for workspace in [workspace_a, workspace_b] {
    let page = state
      .doc_service
      .create_page_lifecycle(
        workspace,
        user,
        Some("Native key collision fixture".to_string()),
        Some(
          myoxus_application::doc::document_fragment_from_markdown("Native workspace-local content")
            .expect("native fragment"),
        ),
      )
      .await
      .expect("persist native document");
    native_ids.push(page.document.id);
  }
  let [doc_a, doc_b] = [native_ids[0], native_ids[1]];
  let nanoid_external = "V1StGXR8_Z5jdHi6B-myT";
  let uuid_shaped_external = doc_a.to_string();
  sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
    .bind(doc_a)
    .bind(nanoid_external)
    .execute(&pool)
    .await
    .expect("set NanoID-shaped external key");
  sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
    .bind(doc_b)
    .bind(&uuid_shaped_external)
    .execute(&pool)
    .await
    .expect("set colliding UUID-shaped external key");

  let auth = auth_context(user);
  for (workspace_id, external_id) in [
    (workspace_a, nanoid_external),
    (workspace_b, uuid_shaped_external.as_str()),
  ] {
    let result = dispatch_tool(
      "read_doc",
      &json!({ "workspace_id": workspace_id, "external_id": external_id }),
      &auth,
      &state,
    )
    .await
    .expect("workspace-scoped external key must resolve");
    assert_eq!(
      result.pointer("/structuredContent/document/externalId"),
      Some(&json!(external_id))
    );
    assert!(result.pointer("/structuredContent/document/docId").is_none());

    let uri = format!("myoxus://{workspace_id}/{external_id}");
    let resource = read_resource(&uri, &state, &auth)
      .await
      .expect("resource URI must use the same external key resolution");
    let resource = serde_json::to_value(resource).expect("serialize SDK resource");
    assert_eq!(resource.pointer("/contents/0/uri"), Some(&json!(uri)));
  }

  helpers::cleanup_users(&pool, &[user]).await;
}
