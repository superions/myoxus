// SPDX-License-Identifier: AGPL-3.0-or-later
//! MCP-RV-06c: Cursor pagination in list_pages produces disjoint, stable pages.
//!
//! Creates 6 documents in a workspace, then paginates through them with
//! limit=2. Asserts that every returned page ID is unique (no duplicates
//! across pages) and that the total count matches the number created.

use crate::helpers;
use futures_util::FutureExt;
#[path = "../../../mcp/src/output_schema_test_support.rs"]
mod output_schema_test_support;

use myoxus_application::doc::DocService;
use myoxus_application::permission::PermissionService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_mcp::auth::McpAuthContext;
use myoxus_mcp::tools::{McpToolState, dispatch_tool};
use serde_json::json;
use std::collections::HashSet;
use std::sync::Arc;
use uuid::Uuid;

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
    document_cursor_signing_key: Arc::from(&b"mcp-pagination-test-cursor-key"[..]),
    document_export_max_bytes: 8 * 1024 * 1024,
  }
}

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

/// Extract the parsed result object from an MCP tool response envelope.
fn extract_result(value: &serde_json::Value) -> serde_json::Value {
  let text = value["content"][0]["text"]
    .as_str()
    .expect("MCP response must contain content[0].text");
  serde_json::from_str(text).expect("content text must be valid JSON")
}

// ─── MCP-RV-06c: cursor pagination produces disjoint, stable pages ──────────

#[tokio::test]
async fn inv_mcp_rv06c_cursor_pagination_disjoint_stable() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-pg").await;
  let workspace = helpers::create_workspace(&pool, user).await;
  WorkspaceService::new(Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  )))
  .seed_root_doc(
    workspace,
    user,
    yjs::create_initial_workspace_doc("MCP pagination workspace"),
  )
  .await
  .expect("MCP pagination workspace root must be initialized");
  let outcome = std::panic::AssertUnwindSafe(async {
    let state = build_tool_state(&pool);
    let auth = auth_context(user);

    // Create 6 documents through the same MCP write path that makes pages
    // visible to `list_pages` (metadata-only fixture rows are intentionally
    // filtered by the production list path).
    const DOC_COUNT: usize = 6;
    let mut created_ids: HashSet<String> = HashSet::new();
    for i in 0..DOC_COUNT {
      let result = dispatch_tool(
        "create_page",
        &json!({
            "workspace_id": workspace.to_string(),
            "title": format!("MCP pagination page {i}"),
            "content_markdown": format!("Body for pagination page {i}"),
        }),
        &auth,
        &state,
      )
      .await
      .expect("create_page fixture setup must succeed");
      let parsed = extract_result(&result);
      let doc_id = parsed["externalId"]
        .as_str()
        .expect("create_page response must contain externalId");
      created_ids.insert(doc_id.to_string());
      assert!(created_ids.len() == i + 1, "created doc IDs must be unique");
    }

    let mut all_returned_ids: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut page_count = 0;
    let max_pages = 10; // safety limit to avoid infinite loops

    loop {
      assert!(
        page_count < max_pages,
        "pagination did not terminate within {max_pages} pages"
      );

      let mut params = json!({
          "workspace_id": workspace.to_string(),
          "limit": 2,
      });
      if let Some(ref c) = cursor {
        params["cursor"] = json!(c);
      }

      let result = dispatch_tool("list_pages", &params, &auth, &state)
        .await
        .expect("list_pages must succeed");

      let parsed = extract_result(&result);
      output_schema_test_support::assert_required_output(
        &myoxus_mcp::tool_registry::find_tool("list_pages")
          .unwrap()
          .output_schema,
        &parsed,
      );
      let pages = parsed["pages"].as_array().expect("response must contain pages array");

      // Each page should have at most `limit` entries
      assert!(
        pages.len() <= 2,
        "page must contain at most 2 entries, got {}",
        pages.len()
      );

      for page in pages {
        let doc_id = page["externalId"]
          .as_str()
          .expect("page entry must have externalId")
          .to_string();
        all_returned_ids.push(doc_id);
      }

      cursor = parsed.get("next_cursor").and_then(|v| v.as_str()).map(String::from);
      page_count += 1;

      if cursor.is_none() {
        break;
      }
    }

    // Assert: no duplicate page IDs across all pages
    let unique_ids: HashSet<&String> = all_returned_ids.iter().collect();
    assert_eq!(
      unique_ids.len(),
      all_returned_ids.len(),
      "pagination returned duplicate doc IDs: {:?}",
      all_returned_ids
    );

    // Assert: total returned == total created
    assert_eq!(
      all_returned_ids.len(),
      DOC_COUNT,
      "expected {DOC_COUNT} docs from pagination, got {}",
      all_returned_ids.len()
    );

    // Verify we actually paginated (more than 1 page for 6 docs with limit=2)
    assert!(
      page_count >= 3,
      "expected at least 3 pages for {DOC_COUNT} docs with limit=2, got {page_count}"
    );
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[user]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
