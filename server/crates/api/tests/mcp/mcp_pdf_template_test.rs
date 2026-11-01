// SPDX-License-Identifier: AGPL-3.0-or-later
//! `P-PDF-TPL-27` MCP integration tests for the read-only PDF tooling.
//!
//! Invariants:
//!
//! - `INV-MCP-PDF-01`: a workspace member with `read:workspaces` scope
//!   gets the assigned-template list back from `pdf_template_list`.
//! - `INV-MCP-PDF-02` (`P-PDF-TPL-27-04`): a non-member of the workspace
//!   is rejected with `-32004` (workspace forbidden) — the tool never
//!   returns templates to outsiders.

use crate::helpers;
use futures_util::FutureExt;
#[path = "../../../mcp/src/output_schema_test_support.rs"]
mod output_schema_test_support;

// Preserve the legacy dispatch assertions while checking their real serialized
// success bodies against the productive discovery contract.
async fn dispatch_tool(
  name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let result = unchecked_dispatch_tool(name, params, auth, state).await?;
  if output_schema_test_support::has_core_contract(name) {
    let text = result["content"][0]["text"].as_str().expect("legacy text projection");
    let body = serde_json::from_str(text).unwrap_or_else(|_| json!({"message":text}));
    let schema = &myoxus_mcp::tool_registry::find_tool(name).unwrap().output_schema;
    output_schema_test_support::assert_required_output(schema, &body);
  }
  Ok(result)
}

use myoxus_application::doc::DocService;
use myoxus_application::permission::PermissionService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::pdf_export::{PgPdfTemplateRepository, PgPdfWorkspaceTemplateAssignmentRepository};
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_mcp::auth::McpAuthContext;
use myoxus_mcp::tools::{McpToolState, dispatch_tool as unchecked_dispatch_tool};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

fn build_tool_state(pool: &PgPool) -> McpToolState {
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let template_repo: Arc<dyn myoxus_domain::repositories::PdfTemplateRepository> =
    Arc::new(PgPdfTemplateRepository::new(pool.clone()));
  let assignment_repo: Arc<dyn myoxus_domain::repositories::PdfWorkspaceTemplateAssignmentRepository> =
    Arc::new(PgPdfWorkspaceTemplateAssignmentRepository::new(pool.clone()));
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
    pdf_template_repo: Some(template_repo),
    pdf_assignment_repo: Some(assignment_repo),
    document_services: Arc::new(myoxus_application::mcp::UnavailableMcpDocumentOperations),
    idempotency: Arc::new(myoxus_application::mcp::InMemoryMcpIdempotencyRepository::default()),
    blob_service: None,
    upload_policy: None,
    audit_recorder: myoxus_application::audit::AuditRecorder::noop(),
    metrics_service: Arc::new(myoxus_application::metrics::MetricsService::in_memory_stub()),
    document_cursor_signing_key: Arc::from(&b"mcp-pdf-test-cursor-key"[..]),
    document_export_max_bytes: 8 * 1024 * 1024,
  }
}

fn auth_with_scopes(user_id: Uuid, scopes: &[&str]) -> McpAuthContext {
  McpAuthContext {
    user_id,
    scopes: scopes.iter().map(|s| s.to_string()).collect(),
    key_id: Uuid::new_v4(),
  }
}

async fn insert_template(pool: &PgPool, slug: &str, created_by: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  let manifest = json!({
    "schema_version": "2.0",
    "id": slug,
    "name": slug,
    "description": "MCP PDF template test fixture.",
    "version": "1.0.0",
    "engine": { "name": "typst", "version": "0.15.x" },
    "provenance": {
      "license_spdx": "AGPL-3.0-or-later",
      "copyright_notice": "Copyright 2026 Myoxus test contributors",
      "source_url": "https://example.test/templates/mcp-pdf",
      "source_revision": "1.0.0"
    },
    "entry": "main.typ",
    "assets": ["main.typ"],
    "capabilities": { "language": { "kind": "enum", "values": ["en"], "default": "en" } }
  });
  sqlx::query(
    r#"INSERT INTO pdf_templates (id, slug, name, version, schema_version, manifest, created_by, created_at)
       VALUES ($1, $2, $3, '1.0.0', '2.0', $4, $5, now())"#,
  )
  .bind(id)
  .bind(slug)
  .bind(slug)
  .bind(&manifest)
  .bind(created_by)
  .execute(pool)
  .await
  .expect("insert template");
  id
}

async fn assign(pool: &PgPool, ws: Uuid, tpl: Uuid, by: Uuid, is_default: bool) {
  sqlx::query(
    r#"INSERT INTO pdf_workspace_template_assignments
         (workspace_id, template_id, is_default, assigned_by, assigned_at)
       VALUES ($1, $2, $3, $4, now())"#,
  )
  .bind(ws)
  .bind(tpl)
  .bind(is_default)
  .bind(by)
  .execute(pool)
  .await
  .expect("assign");
}

async fn cleanup(pool: &PgPool, ws: Uuid, tpls: &[Uuid], users: &[Uuid]) {
  let _ = sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  for &t in tpls {
    let _ = sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
      .bind(t)
      .execute(pool)
      .await;
  }
  let _ = sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  for &u in users {
    let _ = sqlx::query("DELETE FROM users WHERE id = $1")
      .bind(u)
      .execute(pool)
      .await;
  }
}

#[tokio::test]
async fn inv_mcp_pdf01_member_sees_assigned_templates() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (admin, _) = helpers::seed_user(&pool, &auth_store, "mcp-pdf01-admin").await;
  let (alice, _) = helpers::seed_user(&pool, &auth_store, "mcp-pdf01-alice").await;
  let ws = helpers::create_workspace(&pool, alice).await;
  let tpl1 = insert_template(&pool, &format!("mcp-pdf01-a-{}", Uuid::new_v4().simple()), admin).await;
  // Workspace creation already assigns the canonical system default. Add one
  // non-default template so the tool must return both assignment kinds.
  assign(&pool, ws, tpl1, admin, false).await;

  let outcome = std::panic::AssertUnwindSafe(async {
    let state = build_tool_state(&pool);
    let auth = auth_with_scopes(alice, &["read:workspaces"]);

    let result = dispatch_tool(
      "pdf_template_list",
      &json!({ "workspace_id": ws.to_string() }),
      &auth,
      &state,
    )
    .await
    .expect("dispatch ok");

    let body: Value = result
      .pointer("/content/0/text")
      .and_then(Value::as_str)
      .map(serde_json::from_str)
      .expect("text payload")
      .expect("json parse");

    let templates = body
      .get("templates")
      .and_then(Value::as_array)
      .expect("templates array");
    assert_eq!(
      templates.len(),
      2,
      "INV-MCP-PDF-01: member must see both assigned templates: {body}"
    );

    let default_count = templates
      .iter()
      .filter(|t| t.get("isDefault").and_then(Value::as_bool).unwrap_or(false))
      .count();
    assert_eq!(
      default_count, 1,
      "INV-MCP-PDF-01: exactly one template must be marked default"
    );

    let mut disabled = build_tool_state(&pool);
    disabled.pdf_template_repo = None;
    disabled.pdf_assignment_repo = None;
    for name in [
      "template_list_for_workspace",
      "template_request_reconcile",
      "pdf_template_list",
    ] {
      let result = myoxus_mcp::tools::call_tool(name, &json!({"workspace_id":ws}), &auth, &disabled)
        .await
        .expect("disabled registry response");
      assert_ne!(result.is_error, Some(true));
      let body = result.structured_content.as_ref().expect("structured diagnostic");
      output_schema_test_support::assert_required_output(
        &myoxus_mcp::tool_registry::find_tool(name).unwrap().output_schema,
        body,
      );
      let text = serde_json::to_value(&result).unwrap()["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned();
      assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), *body);
    }
  })
  .catch_unwind()
  .await;
  cleanup(&pool, ws, &[tpl1], &[admin, alice]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_pdf02_non_member_rejected() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (admin, _) = helpers::seed_user(&pool, &auth_store, "mcp-pdf02-admin").await;
  let (alice, _) = helpers::seed_user(&pool, &auth_store, "mcp-pdf02-alice").await;
  let (eve, _) = helpers::seed_user(&pool, &auth_store, "mcp-pdf02-eve").await;
  // Workspace owned by Alice; Eve has no membership.
  let ws = helpers::create_workspace(&pool, alice).await;
  let tpl = insert_template(&pool, &format!("mcp-pdf02-{}", Uuid::new_v4().simple()), admin).await;
  assign(&pool, ws, tpl, admin, false).await;

  let state = build_tool_state(&pool);
  let eve_auth = auth_with_scopes(eve, &["read:workspaces"]);

  let result = dispatch_tool(
    "pdf_template_list",
    &json!({ "workspace_id": ws.to_string() }),
    &eve_auth,
    &state,
  )
  .await;
  assert!(
    result.is_err(),
    "INV-MCP-PDF-02: non-member must be rejected, got Ok: {result:?}"
  );

  cleanup(&pool, ws, &[tpl], &[admin, alice, eve]).await;
}
