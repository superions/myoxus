//! MCP organizer folder tool coverage.
//!
//! Folder rows live in the workspace DB Yjs system document
//! `db$<workspace>$folders`, not in a dedicated SQL table. These tests exercise
//! the MCP dispatcher and then read back through MCP again so failures catch
//! CRDT-shape drift, not just response formatting mistakes.

use std::sync::Arc;

use serde_json::{Value, json};
use uuid::Uuid;

use myoxus_application::doc::{DocService, DocSpaceKind};
use myoxus_application::permission::PermissionService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_domain::document_key::DocumentKey;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_mcp::auth::McpAuthContext;
use myoxus_mcp::tools::{McpToolState, call_tool as unchecked_call_tool, dispatch_tool as unchecked_dispatch_tool};
use sqlx::Row;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Map, ReadTxn, Transact, Update};

use crate::helpers;
use futures_util::FutureExt;
use tower::ServiceExt;
#[path = "../../../mcp/src/output_schema_test_support.rs"]
mod output_schema_test_support;

// Preserve the legacy dispatch assertions while checking their real serialized
// success bodies against the productive discovery contract.
async fn call_tool(
  name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<myoxus_mcp::protocol::CallToolResult, myoxus_mcp::protocol::McpToolError> {
  let result = unchecked_call_tool(name, params, auth, state).await?;
  if result.is_error != Some(true) && output_schema_test_support::has_core_contract(name) {
    let body = result.structured_content.as_ref().expect("structured success");
    output_schema_test_support::assert_required_output(
      &myoxus_mcp::tool_registry::find_tool(name).unwrap().output_schema,
      body,
    );
  }
  Ok(result)
}

async fn dispatch_tool(
  name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let result = unchecked_dispatch_tool(name, params, auth, state).await?;
  if output_schema_test_support::has_core_contract(name) {
    let body = match result["content"][0]["text"].as_str() {
      Some(text) => serde_json::from_str(text).unwrap_or_else(|_| json!({"message":text})),
      None => result.clone(),
    };
    let schema = &myoxus_mcp::tool_registry::find_tool(name).unwrap().output_schema;
    output_schema_test_support::assert_required_output(schema, &body);
  }
  Ok(result)
}

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
    document_cursor_signing_key: Arc::from(&b"mcp-folder-test-cursor-key"[..]),
    document_export_max_bytes: 8 * 1024 * 1024,
  }
}

fn auth_with_scopes(user_id: Uuid, scopes: &[&str]) -> McpAuthContext {
  McpAuthContext {
    user_id,
    scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
    key_id: Uuid::new_v4(),
  }
}

async fn persist_auth_key(pool: &sqlx::PgPool, auth: &McpAuthContext) {
  sqlx::query(
    "INSERT INTO api_keys (id, user_id, name, key_hash, scopes)
     VALUES ($1, $2, 'mcp-folder-idempotency-test', $3, $4)",
  )
  .bind(auth.key_id)
  .bind(auth.user_id)
  .bind(format!("mcp-folder-idempotency-test-{}", auth.key_id))
  .bind(&auth.scopes)
  .execute(pool)
  .await
  .expect("insert MCP folder test API key");
}

fn inner_json(value: Value) -> Value {
  let text = value["content"][0]["text"].as_str().expect("content text");
  serde_json::from_str(text).expect("inner JSON")
}

/// Exercise the productive SDK transport, collecting request-scoped progress
/// before its one terminal result. No token must retain the ordinary JSON reply.
async fn sdk_rpc(router: &axum::Router, token: &str, method: &str, params: Value) -> (Vec<Value>, Value) {
  let progress = params.get("_meta").and_then(|meta| meta.get("progressToken")).is_some();
  let response = router
    .clone()
    .oneshot(
      axum::http::Request::builder()
        .method("POST")
        .uri("/")
        .header("host", "myoxus.test")
        .header("accept", "application/json, text/event-stream")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(axum::body::Body::from(
          json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string(),
        ))
        .expect("SDK request"),
    )
    .await
    .expect("SDK response");
  assert_eq!(response.status(), axum::http::StatusCode::OK);
  let sse = response
    .headers()
    .get("content-type")
    .expect("SDK response type")
    .to_str()
    .unwrap()
    .starts_with("text/event-stream");
  assert_eq!(sse, progress, "progress-bearing calls stream; ordinary calls keep JSON");
  let body = tokio::time::timeout(
    std::time::Duration::from_secs(10),
    axum::body::to_bytes(response.into_body(), 8 * 1024 * 1024),
  )
  .await
  .expect("SDK response terminates")
  .expect("SDK response body");
  let mut messages = if sse {
    std::str::from_utf8(&body)
      .expect("UTF-8 SSE")
      .lines()
      .filter_map(|line| line.strip_prefix("data:"))
      .map(|data| serde_json::from_str::<Value>(data).expect("SDK SSE message"))
      .collect::<Vec<_>>()
  } else {
    vec![serde_json::from_slice(&body).expect("SDK JSON response")]
  };
  let terminal = messages.pop().expect("terminal SDK message");
  assert_eq!(terminal["id"], 1);
  (messages, terminal)
}

fn folder_id(value: &Value) -> String {
  value["folder"]["id"].as_str().expect("folder id").to_string()
}

fn entry_id(value: &Value) -> String {
  value["entry"]["id"].as_str().expect("entry id").to_string()
}

pub(super) async fn corrupt_organizer_order_key(state: &McpToolState, workspace_id: Uuid, row_id: &str) {
  let key = DocumentKey::parse(format!("db${workspace_id}$folders")).expect("organizer document key");
  let internal_id = state
    .doc_service
    .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &key)
    .await
    .expect("resolve organizer document")
    .expect("organizer document must exist");
  let current = state
    .doc_service
    .load_full_doc(workspace_id, internal_id)
    .await
    .expect("load organizer document");
  let doc = Doc::new();
  doc
    .transact_mut()
    .apply_update(Update::decode_v1(&current).expect("decode organizer document"))
    .expect("apply organizer document");
  let before = doc.transact().state_vector();
  {
    let row = doc.get_or_insert_map(row_id);
    let mut txn = doc.transact_mut();
    row.insert(&mut txn, "index", "0000");
  }
  let update = doc.transact().encode_diff_v1(&before);
  state
    .doc_service
    .push_external_update_raw(workspace_id, key, update, DocSpaceKind::Workspace)
    .await
    .expect("persist isolated malformed-order fixture");
}

#[tokio::test]
async fn inv_mcp_folder01_folder_crud_roundtrips_through_workspace_db_doc() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-folder01-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    let mut state = build_tool_state(&pool);
    let auth = auth_with_scopes(owner_id, &["read:docs", "write:docs"]);
    persist_auth_key(&pool, &auth).await;
    state.idempotency =
      Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));

    let root_params = json!({
      "workspace_id": workspace_id.to_string(),
      "name": "Projects",
      "idempotency_key": "folder-root-create-once",
    });
    let root_response = dispatch_tool("folder_create", &root_params, &auth, &state)
      .await
      .expect("create root folder");
    assert_eq!(
      dispatch_tool("folder_create", &root_params, &auth, &state)
        .await
        .expect("replay root folder create"),
      root_response
    );
    let root = inner_json(root_response);
    let root_id = folder_id(&root);
    let root_index = root["folder"]["index"]
      .as_str()
      .expect("generated root index")
      .to_string();
    assert!(root_index.len() > 34 && root_index.as_bytes()[0].is_ascii_alphabetic());
    assert_eq!(root.pointer("/folder/parentId"), Some(&Value::Null));
    let after_root_create = inner_json(
      dispatch_tool(
        "folder_list",
        &json!({
          "workspace_id": workspace_id.to_string(),
        }),
        &auth,
        &state,
      )
      .await
      .expect("list after root create"),
    );
    assert!(
      after_root_create["folders"]
        .as_array()
        .expect("folders array")
        .iter()
        .any(|folder| folder["id"].as_str() == Some(root_id.as_str())),
      "root folder must be readable before a child can be created: {after_root_create}"
    );

    let child_params = json!({
      "workspace_id": workspace_id.to_string(),
      "parent_id": root_id,
      "name": "Drafts",
      "idempotency_key": "folder-child-create-once",
    });
    let child_response = dispatch_tool("folder_create", &child_params, &auth, &state)
      .await
      .expect("create child folder");
    assert_eq!(
      dispatch_tool("folder_create", &child_params, &auth, &state)
        .await
        .expect("replay child folder create"),
      child_response
    );
    let child = inner_json(child_response);
    let child_id = folder_id(&child);

    let update_params = json!({
      "workspace_id": workspace_id.to_string(),
      "folder_id": child_id,
      "name": "Archive",
      "parent_id": null,
      "idempotency_key": "folder-update-once",
    });
    let update_response = dispatch_tool("folder_update", &update_params, &auth, &state)
      .await
      .expect("update child folder");
    assert_eq!(
      dispatch_tool("folder_update", &update_params, &auth, &state)
        .await
        .expect("replay child folder update"),
      update_response
    );
    let updated = inner_json(update_response);
    assert_eq!(updated.pointer("/folder/name").and_then(Value::as_str), Some("Archive"));
    assert_eq!(updated.pointer("/folder/parentId"), Some(&Value::Null));
    assert!(
      root_index.as_str()
        < updated
          .pointer("/folder/index")
          .and_then(Value::as_str)
          .expect("reparent-generated root append index")
    );

    let before_invalid = inner_json(
      dispatch_tool("folder_list", &json!({ "workspace_id": workspace_id }), &auth, &state)
        .await
        .expect("list before invalid order key"),
    );
    let invalid = dispatch_tool(
      "folder_create",
      &json!({
        "workspace_id": workspace_id,
        "name": "Invalid order",
        "index": "0000",
        "idempotency_key": "folder-invalid-order-no-write",
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("numeric timestamp-style order key must be rejected");
    assert_eq!(invalid.0, -32602);
    let after_invalid = inner_json(
      dispatch_tool("folder_list", &json!({ "workspace_id": workspace_id }), &auth, &state)
        .await
        .expect("list after invalid order key"),
    );
    assert_eq!(before_invalid["folders"], after_invalid["folders"]);

    let root_list = inner_json(
      dispatch_tool(
        "folder_list",
        &json!({
          "workspace_id": workspace_id.to_string(),
          "parent_id": null,
        }),
        &auth,
        &state,
      )
      .await
      .expect("list root folders"),
    );
    let names = root_list["folders"]
      .as_array()
      .expect("folders array")
      .iter()
      .filter_map(|folder| folder["name"].as_str())
      .collect::<Vec<_>>();
    assert!(
      names.contains(&"Projects") && names.contains(&"Archive"),
      "root list must include MCP-created and MCP-moved folders: {root_list}"
    );

    let delete_params = json!({
      "workspace_id": workspace_id.to_string(),
      "folder_id": child_id,
      "idempotency_key": "folder-delete-once",
    });
    let delete_response = dispatch_tool("folder_delete", &delete_params, &auth, &state)
      .await
      .expect("delete child folder");
    assert_eq!(
      dispatch_tool("folder_delete", &delete_params, &auth, &state)
        .await
        .expect("replay child folder delete"),
      delete_response
    );
    let deleted = inner_json(delete_response);
    assert_eq!(
      deleted["deletedIds"].as_array().expect("deleted ids").len(),
      1,
      "delete returns the exact deleted subtree"
    );

    let after_delete = inner_json(
      dispatch_tool(
        "folder_list",
        &json!({
          "workspace_id": workspace_id.to_string(),
        }),
        &auth,
        &state,
      )
      .await
      .expect("list folders after delete"),
    );
    assert!(
      after_delete["folders"]
        .as_array()
        .expect("folders array")
        .iter()
        .all(|folder| folder["name"].as_str() != Some("Archive")),
      "deleted folder must no longer be visible through folder_list: {after_delete}"
    );
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_folder02_reader_cannot_write_folders() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-folder02-owner").await;
  let (reader_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-folder02-reader").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
     VALUES ($1, $2, 'Reader', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(reader_id)
  .execute(&pool)
  .await
  .expect("add Reader member");
  let outcome = std::panic::AssertUnwindSafe(async {
    let state = build_tool_state(&pool);
    let owner_auth = auth_with_scopes(owner_id, &["read:docs", "write:docs"]);
    dispatch_tool(
      "folder_create",
      &json!({
        "workspace_id": workspace_id,
        "name": "Reader-visible folder",
      }),
      &owner_auth,
      &state,
    )
    .await
    .expect("seed folder through the normal owner path");
    let auth = auth_with_scopes(reader_id, &["read:docs", "write:docs"]);

    let readable = dispatch_tool("folder_tree", &json!({ "workspace_id": workspace_id }), &auth, &state)
      .await
      .expect("Reader with normal workspace Read can navigate folders");
    assert!(
      readable["folders"]
        .as_array()
        .is_some_and(|folders| folders.iter().any(|folder| folder["name"] == "Reader-visible folder"))
    );

    let result = dispatch_tool(
      "folder_create",
      &json!({
        "workspace_id": workspace_id.to_string(),
        "name": "Reader write attempt",
      }),
      &auth,
      &state,
    )
    .await;

    assert!(result.is_err(), "write:docs scope must not bypass folder write ACL");
    let (code, msg) = result.unwrap_err();
    assert_eq!(code, -32003, "expected permission-denied error, got {code}: {msg}");
    assert!(
      msg.contains("CreateDoc"),
      "folder writes use the normal workspace CreateDoc permission: {msg}"
    );
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[owner_id, reader_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_folder03_entry_links_crud_without_deleting_targets() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-folder03-owner").await;
  let (editor_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-folder03-editor").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Collaborator', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(editor_id)
  .execute(&pool)
  .await
  .expect("add editor without Organizer administration");
  let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let second_doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let doc_id_string = doc_id.to_string();
  let second_doc_id_string = second_doc_id.to_string();
  let outcome = std::panic::AssertUnwindSafe(async {
    let mut state = build_tool_state(&pool);
    let auth = auth_with_scopes(editor_id, &["read:docs", "write:docs"]);
    persist_auth_key(&pool, &auth).await;
    state.idempotency =
      Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));

    let root = inner_json(
      dispatch_tool(
        "folder_create",
        &json!({
          "workspace_id": workspace_id.to_string(),
          "name": "Linked docs",
          "idempotency_key": "entry-parent-create-once",
        }),
        &auth,
        &state,
      )
      .await
      .expect("create containing folder"),
    );
    let root_id = folder_id(&root);

    let create_params = json!({
      "workspace_id": workspace_id.to_string(),
      "parent_id": root_id.clone(),
      "target_type": "doc",
      "target_id": doc_id_string.clone(),
      "idempotency_key": "folder-entry-create-once",
    });
    let create_response = dispatch_tool("folder_entry_create", &create_params, &auth, &state)
      .await
      .expect("create document entry");
    assert_eq!(
      dispatch_tool("folder_entry_create", &create_params, &auth, &state)
        .await
        .expect("replay document entry create"),
      create_response
    );
    let created = inner_json(create_response);
    let link_id = entry_id(&created);
    assert_eq!(
      created.pointer("/entry/targetId").and_then(Value::as_str),
      Some(doc_id_string.as_str())
    );
    assert_eq!(
      created.pointer("/entry/targetType").and_then(Value::as_str),
      Some("doc")
    );
    let generated_entry_index = created
      .pointer("/entry/index")
      .and_then(Value::as_str)
      .expect("generated entry index");
    assert!(generated_entry_index.len() > 34 && generated_entry_index.as_bytes()[0].is_ascii_alphabetic());

    let listed = inner_json(
      dispatch_tool(
        "folder_entry_list",
        &json!({
          "workspace_id": workspace_id.to_string(),
          "parent_id": root_id,
          "target_type": "doc",
        }),
        &auth,
        &state,
      )
      .await
      .expect("list document entries"),
    );
    assert!(
      listed["entries"]
        .as_array()
        .expect("entries array")
        .iter()
        .any(|entry| entry["id"].as_str() == Some(link_id.as_str())),
      "created entry must roundtrip through the workspace folders Yjs doc: {listed}"
    );

    let update_params = json!({
      "workspace_id": workspace_id.to_string(),
      "entry_id": link_id,
      "target_type": "doc",
      "target_id": second_doc_id_string,
      "index": "a1",
      "idempotency_key": "folder-entry-update-once",
    });
    let update_response = dispatch_tool("folder_entry_update", &update_params, &auth, &state)
      .await
      .expect("retarget entry");
    assert_eq!(
      dispatch_tool("folder_entry_update", &update_params, &auth, &state)
        .await
        .expect("replay entry update"),
      update_response
    );
    let updated = inner_json(update_response);
    assert_eq!(
      updated.pointer("/entry/targetType").and_then(Value::as_str),
      Some("doc")
    );
    assert_eq!(
      updated.pointer("/entry/targetId").and_then(Value::as_str),
      Some(second_doc_id_string.as_str())
    );

    let delete_params = json!({
      "workspace_id": workspace_id.to_string(),
      "entry_id": updated["entry"]["id"].as_str().expect("updated entry id"),
      "idempotency_key": "folder-entry-delete-once",
    });
    let delete_response = dispatch_tool("folder_entry_delete", &delete_params, &auth, &state)
      .await
      .expect("delete entry");
    assert_eq!(
      dispatch_tool("folder_entry_delete", &delete_params, &auth, &state)
        .await
        .expect("replay entry delete"),
      delete_response
    );
    inner_json(delete_response);

    let after_delete = inner_json(
      dispatch_tool(
        "folder_entry_list",
        &json!({
          "workspace_id": workspace_id.to_string(),
        }),
        &auth,
        &state,
      )
      .await
      .expect("list entries after delete"),
    );
    assert!(
      after_delete["entries"].as_array().expect("entries array").is_empty(),
      "deleting an entry must remove only the organizer link: {after_delete}"
    );

    let doc_exists: Option<Uuid> = sqlx::query_scalar("SELECT id FROM docs WHERE id = $1 AND deleted_at IS NULL")
      .bind(doc_id)
      .fetch_optional(&pool)
      .await
      .expect("read target doc");
    assert_eq!(
      doc_exists,
      Some(doc_id),
      "folder_entry_delete must not delete the linked document"
    );
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[owner_id, editor_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_folder04_cross_workspace_links_recheck_target_access_on_every_node() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (source_owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-folder04-source-owner").await;
  let (container_owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-folder04-container-owner").await;
  let (actor_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-folder04-actor").await;
  let source_workspace_id = helpers::create_workspace(&pool, source_owner_id).await;
  let containing_workspace_id = helpers::create_workspace(&pool, container_owner_id).await;
  let doc_id = helpers::create_doc(&pool, source_workspace_id, source_owner_id).await;

  for (workspace_id, role) in [
    (source_workspace_id, "Reader"),
    (containing_workspace_id, "Collaborator"),
  ] {
    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'Accepted', now())",
    )
    .bind(workspace_id)
    .bind(actor_id)
    .bind(role)
    .execute(&pool)
    .await
    .expect("add actor membership");
  }

  let outcome = std::panic::AssertUnwindSafe(async {
    let state_a = build_tool_state(&pool);
    let auth = auth_with_scopes(actor_id, &["read:docs", "write:docs"]);
    let root = inner_json(
      dispatch_tool(
        "folder_create",
        &json!({
          "workspace_id": containing_workspace_id,
          "name": "External references",
        }),
        &auth,
        &state_a,
      )
      .await
      .expect("editor creates containing folder without Organizer administration"),
    );
    let root_id = folder_id(&root);

    let created = inner_json(
      dispatch_tool(
        "folder_entry_create",
        &json!({
          "workspace_id": containing_workspace_id,
          "parent_id": root_id,
          "target_type": "doc",
          "target_id": doc_id,
          "target_workspace_id": source_workspace_id,
        }),
        &auth,
        &state_a,
      )
      .await
      .expect("readable cross-workspace target can be linked"),
    );
    let link_id = entry_id(&created);

    // A separately constructed service instance must resolve the durable row,
    // proving that no process-local cache is authoritative.
    let state_b = build_tool_state(&pool);
    let visible = inner_json(
      dispatch_tool(
        "folder_entry_list",
        &json!({ "workspace_id": containing_workspace_id }),
        &auth,
        &state_b,
      )
      .await
      .expect("second node lists link"),
    );
    assert!(
      visible["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .any(|entry| entry["id"].as_str() == Some(link_id.as_str())),
      "second node must project the readable link: {visible}"
    );

    sqlx::query(
      "UPDATE workspace_memberships
     SET status = 'Revoked'
     WHERE workspace_id = $1 AND user_id = $2",
    )
    .bind(source_workspace_id)
    .bind(actor_id)
    .execute(&pool)
    .await
    .expect("revoke target access");
    let hidden_after_revoke = inner_json(
      dispatch_tool(
        "folder_entry_list",
        &json!({ "workspace_id": containing_workspace_id }),
        &auth,
        &state_b,
      )
      .await
      .expect("list remains neutral after target revocation"),
    );
    assert!(
      hidden_after_revoke["entries"].as_array().expect("entries").is_empty(),
      "revoked target access must hide the complete row: {hidden_after_revoke}"
    );

    sqlx::query(
      "UPDATE workspace_memberships
     SET status = 'Accepted'
     WHERE workspace_id = $1 AND user_id = $2",
    )
    .bind(source_workspace_id)
    .bind(actor_id)
    .execute(&pool)
    .await
    .expect("restore target access");
    sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("delete linked target");
    let hidden_after_delete = inner_json(
      dispatch_tool(
        "folder_entry_list",
        &json!({ "workspace_id": containing_workspace_id }),
        &auth,
        &state_a,
      )
      .await
      .expect("list remains neutral after target deletion"),
    );
    assert!(
      hidden_after_delete["entries"].as_array().expect("entries").is_empty(),
      "deleted target must not leak a stale organizer row: {hidden_after_delete}"
    );
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[source_owner_id, container_owner_id, actor_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_folder05_folder_tree_is_ordered_bounded_permission_filtered_and_compact() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-folder05-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let visible_doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let hidden_doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let visible_external_id = "V1StGXR8_Z5jdHi6B-myT";
  let hidden_external_id = "hidden-document-key";
  for (doc_id, external_id) in [
    (visible_doc_id, visible_external_id),
    (hidden_doc_id, hidden_external_id),
  ] {
    sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
      .bind(doc_id)
      .bind(external_id)
      .execute(&pool)
      .await
      .expect("set external document key");
  }

  let outcome = std::panic::AssertUnwindSafe(async {
    let state = build_tool_state(&pool);
    let auth = auth_with_scopes(owner_id, &["read:docs", "write:docs"]);
    let first_root = inner_json(
      dispatch_tool(
        "folder_create",
        &json!({ "workspace_id": workspace_id, "name": "Duplicate" }),
        &auth,
        &state,
      )
      .await
      .expect("create first duplicate root"),
    );
    let first_root_id = folder_id(&first_root);
    let second_root = inner_json(
      dispatch_tool(
        "folder_create",
        &json!({ "workspace_id": workspace_id, "name": "Duplicate" }),
        &auth,
        &state,
      )
      .await
      .expect("create second duplicate root"),
    );
    let second_root_id = folder_id(&second_root);
    let child = inner_json(
      dispatch_tool(
        "folder_create",
        &json!({
          "workspace_id": workspace_id,
          "parent_id": first_root_id,
          "name": "Child",
        }),
        &auth,
        &state,
      )
      .await
      .expect("create child folder"),
    );
    let child_id = folder_id(&child);
    let deep = inner_json(
      dispatch_tool(
        "folder_create",
        &json!({
          "workspace_id": workspace_id,
          "parent_id": child_id,
          "name": "Deep",
        }),
        &auth,
        &state,
      )
      .await
      .expect("create deep folder"),
    );
    let deep_id = folder_id(&deep);

    dispatch_tool(
      "folder_entry_create",
      &json!({
        "workspace_id": workspace_id,
        "parent_id": child_id,
        "target_type": "doc",
        "target_id": visible_external_id,
      }),
      &auth,
      &state,
    )
    .await
    .expect("link visible NanoID document");
    dispatch_tool(
      "folder_entry_create",
      &json!({
        "workspace_id": workspace_id,
        "parent_id": deep_id,
        "target_type": "doc",
        "target_id": hidden_external_id,
      }),
      &auth,
      &state,
    )
    .await
    .expect("link document before it becomes hidden");
    sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
      .bind(hidden_doc_id)
      .execute(&pool)
      .await
      .expect("hide linked document through normal target visibility rules");

    let unknown = dispatch_tool(
      "folder_tree",
      &json!({ "workspace_id": workspace_id, "unexpected": true }),
      &auth,
      &state,
    )
    .await
    .expect_err("typed request must reject unknown fields");
    assert_eq!(unknown.0, -32602);

    let result = call_tool("folder_tree", &json!({ "workspace_id": workspace_id }), &auth, &state)
      .await
      .expect("folder tree call");
    let wire = serde_json::to_value(result).expect("serialize tool result");
    let tree = &wire["structuredContent"];
    let roots = tree["folders"].as_array().expect("root folders");
    assert_eq!(roots.len(), 2, "duplicate names remain separate roots: {tree}");
    assert_eq!(roots[0]["id"], first_root_id);
    assert_eq!(roots[1]["id"], second_root_id);
    assert_eq!(roots[0]["name"], "Duplicate");
    assert_eq!(roots[1]["name"], "Duplicate");
    assert_eq!(roots[0]["path"], json!(["Duplicate"]));
    assert_eq!(roots[0]["children"][0]["path"], json!(["Duplicate", "Child"]));
    assert_eq!(
      roots[0]["children"][0]["children"][0]["path"],
      json!(["Duplicate", "Child", "Deep"])
    );
    let visible_entry = &roots[0]["children"][0]["entries"][0];
    assert_eq!(visible_entry["externalId"], visible_external_id);
    assert!(visible_entry.get("targetId").is_none());
    let encoded_tree = serde_json::to_string(tree).expect("encode tree");
    assert!(!encoded_tree.contains(hidden_external_id));
    assert!(!encoded_tree.contains("myoxus$mcp_folder_index"));

    let summary = wire["content"][0]["text"].as_str().expect("compact summary");
    assert_eq!(summary, "Folder tree contains 4 folders and 1 visible entry.");
    assert!(!summary.contains(visible_external_id));
    assert!(serde_json::from_str::<Value>(summary).is_err());
    assert!(summary.len() < encoded_tree.len());

    let bounded = call_tool(
      "folder_tree",
      &json!({ "workspace_id": workspace_id, "max_depth": 1 }),
      &auth,
      &state,
    )
    .await
    .expect("bounded folder tree");
    let bounded = bounded.structured_content.expect("bounded structured content");
    assert_eq!(bounded["folders"].as_array().map(Vec::len), Some(2));
    assert_eq!(bounded["folders"][0]["children"], json!([]));
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_folder06_exact_paths_and_document_placement_are_replay_safe_and_acl_bound() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-folder06-owner").await;
  let (reader_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-folder06-reader").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Reader', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(reader_id)
  .execute(&pool)
  .await
  .expect("add Reader member");

  let selected_doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let collision_doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  sqlx::query("UPDATE docs SET external_id = 'collision-other-key' WHERE id = $1")
    .bind(collision_doc_id)
    .execute(&pool)
    .await
    .expect("move collision document external key");
  let uuid_shaped_external_id = collision_doc_id.to_string();
  sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
    .bind(selected_doc_id)
    .bind(&uuid_shaped_external_id)
    .execute(&pool)
    .await
    .expect("assign UUID-shaped external document key");

  let outcome = std::panic::AssertUnwindSafe(async {
    let mut state = build_tool_state(&pool);
    let auth = auth_with_scopes(owner_id, &["read:docs", "write:docs"]);
    persist_auth_key(&pool, &auth).await;
    state.idempotency =
      Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));

    let ensure_params = json!({
      "workspace_id": workspace_id,
      "path": ["Projects", "2026"],
      "idempotency_key": "folder-path-projects-2026",
    });
    let ensured_response = dispatch_tool("folder_path_ensure", &ensure_params, &auth, &state)
      .await
      .expect("ensure missing folder path");
    assert_eq!(
      dispatch_tool("folder_path_ensure", &ensure_params, &auth, &state)
        .await
        .expect("replay ensured folder path"),
      ensured_response
    );
    let ensured = inner_json(ensured_response);
    assert_eq!(ensured["path"], json!(["Projects", "2026"]));
    assert_eq!(ensured["createdSegments"].as_array().map(Vec::len), Some(2));
    let projects_2026_id = ensured["folderId"].as_str().expect("ensured folder id").to_string();

    let existing = call_tool(
      "folder_path_ensure",
      &json!({
        "workspace_id": workspace_id,
        "path": ["Projects", "2026"],
        "idempotency_key": "folder-path-projects-2026-existing",
      }),
      &auth,
      &state,
    )
    .await
    .expect("ensure existing path");
    assert_eq!(
      existing.structured_content.as_ref().unwrap()["createdSegments"],
      json!([])
    );
    let existing_summary = serde_json::to_value(&existing).unwrap()["content"][0]["text"]
      .as_str()
      .unwrap()
      .to_string();
    assert_eq!(existing_summary, "Folder path resolved; 0 segment(s) created.");
    assert!(serde_json::from_str::<Value>(&existing_summary).is_err());

    dispatch_tool(
      "folder_create",
      &json!({ "workspace_id": workspace_id, "name": "Interrupted" }),
      &auth,
      &state,
    )
    .await
    .expect("create interrupted prefix");
    let recovered = inner_json(
      dispatch_tool(
        "folder_path_ensure",
        &json!({
          "workspace_id": workspace_id,
          "path": ["Interrupted", "Recovered"],
          "idempotency_key": "folder-path-interrupted-recovery",
        }),
        &auth,
        &state,
      )
      .await
      .expect("reuse prefix left by interrupted workflow"),
    );
    assert_eq!(recovered["createdSegments"].as_array().map(Vec::len), Some(1));

    let duplicate_a = inner_json(
      dispatch_tool(
        "folder_create",
        &json!({ "workspace_id": workspace_id, "name": "Ambiguous" }),
        &auth,
        &state,
      )
      .await
      .expect("create first ambiguous root"),
    );
    let duplicate_b = inner_json(
      dispatch_tool(
        "folder_create",
        &json!({ "workspace_id": workspace_id, "name": "Ambiguous" }),
        &auth,
        &state,
      )
      .await
      .expect("create second ambiguous root"),
    );
    let ambiguity = call_tool(
      "folder_path_ensure",
      &json!({
        "workspace_id": workspace_id,
        "path": ["Ambiguous", "Must not be created"],
        "idempotency_key": "folder-path-ambiguous",
      }),
      &auth,
      &state,
    )
    .await
    .expect("known tool returns typed execution error");
    assert_eq!(ambiguity.is_error, Some(true));
    let ambiguity_payload = ambiguity.structured_content.expect("ambiguity payload");
    assert_eq!(ambiguity_payload["code"], "FOLDER_PATH_AMBIGUOUS");
    let ambiguity_message = ambiguity_payload["message"].as_str().unwrap();
    assert!(ambiguity_message.contains(duplicate_a["folder"]["id"].as_str().unwrap()));
    assert!(ambiguity_message.contains(duplicate_b["folder"]["id"].as_str().unwrap()));
    let after_ambiguity = call_tool("folder_tree", &json!({ "workspace_id": workspace_id }), &auth, &state)
      .await
      .expect("read tree after ambiguity")
      .structured_content
      .expect("tree payload");
    assert!(
      !serde_json::to_string(&after_ambiguity)
        .expect("serialize tree")
        .contains("Must not be created"),
      "ambiguous existing prefix must fail before creating the suffix"
    );

    let place_params = json!({
      "workspace_id": workspace_id,
      "folder_path": ["Projects", "2026"],
      "external_id": uuid_shaped_external_id,
      "idempotency_key": "folder-place-create",
    });
    let placed_response = dispatch_tool("folder_entry_place", &place_params, &auth, &state)
      .await
      .expect("place UUID-shaped external document key");
    assert_eq!(
      dispatch_tool("folder_entry_place", &place_params, &auth, &state)
        .await
        .expect("replay placement"),
      placed_response
    );
    let placed = inner_json(placed_response);
    assert_eq!(placed["outcome"], "created");
    assert_eq!(placed["folderId"], projects_2026_id);
    assert_eq!(placed["externalId"], collision_doc_id.to_string());
    let entry_id = placed["entryId"].as_str().expect("placed entry id").to_string();

    let unchanged = inner_json(
      dispatch_tool(
        "folder_entry_place",
        &json!({
          "workspace_id": workspace_id,
          "folder_id": projects_2026_id,
          "external_id": collision_doc_id,
          "idempotency_key": "folder-place-unchanged",
        }),
        &auth,
        &state,
      )
      .await
      .expect("return unchanged for existing exact placement"),
    );
    assert_eq!(unchanged["outcome"], "already_placed");
    assert_eq!(unchanged["entryId"], entry_id);

    let moved = inner_json(
      dispatch_tool(
        "folder_entry_place",
        &json!({
          "workspace_id": workspace_id,
          "folder_path": ["Interrupted", "Recovered"],
          "external_id": collision_doc_id,
          "idempotency_key": "folder-place-move",
        }),
        &auth,
        &state,
      )
      .await
      .expect("move unique placement"),
    );
    assert_eq!(moved["outcome"], "moved");
    assert_eq!(moved["entryId"], entry_id);

    let mismatch = dispatch_tool(
      "folder_entry_place",
      &json!({
        "workspace_id": workspace_id,
        "folder_id": projects_2026_id,
        "external_id": "collision-other-key",
        "idempotency_key": "folder-place-unchanged",
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("reusing one idempotency key with another payload must fail");
    assert_eq!(mismatch.0, -32010);
    assert!(mismatch.1.contains("MIX_MCP_IDEMPOTENCY_CONFLICT"));

    let reader_auth = auth_with_scopes(reader_id, &["read:docs", "write:docs"]);
    let denied = dispatch_tool(
      "folder_entry_place",
      &json!({
        "workspace_id": workspace_id,
        "folder_id": projects_2026_id,
        "external_id": collision_doc_id,
        "idempotency_key": "folder-place-reader-denied",
      }),
      &reader_auth,
      &state,
    )
    .await
    .expect_err("write scope must not bypass organizer ACL");
    assert_eq!(denied.0, -32003);
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[owner_id, reader_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_document_import_existing_folder_is_compact_replay_safe_and_compensated() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-document-import-owner").await;
  let (editor_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-document-import-editor").await;
  let (reader_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-document-import-reader").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES
       ($1, $2, 'Collaborator', 'Accepted', now()),
       ($1, $3, 'Reader', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(editor_id)
  .bind(reader_id)
  .execute(&pool)
  .await
  .expect("add editor and Reader members");

  let outcome = std::panic::AssertUnwindSafe(async {
    let mut state = super::mcp_create_page_test::build_tool_state(&pool);
    state
      .workspace_service
      .seed_root_doc(
        workspace_id,
        owner_id,
        yjs::create_initial_workspace_doc("MCP document import workspace"),
      )
      .await
      .expect("seed workspace root document");
    state.idempotency =
      Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let key_service = myoxus_application::api_key::ApiKeyService::new(Arc::new(
      myoxus_infrastructure::api_key::SqlxApiKeyStore::new(pool.clone()),
    ));
    let (key, token) = key_service.generate(editor_id, "mcp-import-sdk-test".into(),
      vec!["read:workspaces".into(), "read:docs".into(), "write:docs".into()], None).await.expect("SDK key");
    let auth = McpAuthContext { user_id: editor_id, key_id: key.id, scopes: key.scopes };
    let router = myoxus_mcp::router::mcp_router::<()>(myoxus_mcp::router::McpState {
      key_service: key_service.clone(), tool_state: state.clone(),
      subscriptions: myoxus_mcp::subscriptions::SubscriptionHub::new(),
      availability: Arc::new(myoxus_mcp::router::StaticMcpAvailability(true)),
    });

    let destination = inner_json(
      dispatch_tool(
        "folder_path_ensure",
        &json!({
          "workspace_id": workspace_id,
          "path": ["Imports", "Ready"],
          "idempotency_key": "document-import-destination",
        }),
        &auth,
        &state,
      )
      .await
      .expect("create import destination"),
    );
    let destination_id = destination["folderId"]
      .as_str()
      .expect("destination folder id")
      .to_string();

    let markdown_params = json!({
      "workspace_id": workspace_id,
      "title": "Imported Markdown",
      "content_markdown": "# Imported heading\n\nImported body that must not be echoed. [[Missing target]]",
      "folder_path": ["Imports", "Ready"],
      "idempotency_key": "document-import-markdown-once",
    });
    let (progress, wire) = sdk_rpc(&router, &token, "tools/call", json!({
      "name": "document_import", "arguments": markdown_params, "_meta": {"progressToken": "import-test"},
    })).await;
    assert_eq!(progress.iter().map(|message| message["params"]["progress"].as_f64().unwrap()).collect::<Vec<_>>(), vec![1.0, 2.0, 3.0, 4.0]);
    assert!(progress.iter().all(|message| message["method"] == "notifications/progress"
      && message["params"]["progressToken"] == "import-test" && message["params"]["total"].as_f64() == Some(4.0)));
    let markdown_result: myoxus_mcp::protocol::CallToolResult = serde_json::from_value(wire["result"].clone()).expect("SDK import result");
    assert_ne!(markdown_result.is_error, Some(true));
    let markdown = markdown_result
      .structured_content
      .clone()
      .expect("structured import response");
    assert_eq!(markdown["title"], "Imported Markdown");
    assert_eq!(markdown["inputMode"], "markdown");
    assert_eq!(markdown["folderId"], destination_id);
    assert_eq!(markdown["folderPath"], json!(["Imports", "Ready"]));
    assert!(markdown["documentRevision"].as_i64().is_some_and(|value| value > 0));
    assert!(markdown["rootRevision"].as_i64().is_some_and(|value| value > 0));
    assert!(markdown["blockCount"].as_u64().is_some_and(|value| value >= 2));
    assert_eq!(markdown["markdownDiagnosticCount"], 1);
    assert!(markdown.get("docId").is_none());
    assert!(markdown.get("content").is_none());
    assert!(markdown.get("contentMarkdown").is_none());
    let markdown_wire = serde_json::to_value(&markdown_result).expect("serialize MCP import result");
    let summary = markdown_wire["content"][0]["text"]
      .as_str()
      .expect("compact import summary");
    assert!(summary.starts_with("Document imported with "));
    assert!(serde_json::from_str::<Value>(summary).is_err());
    assert!(
      !markdown_wire
        .to_string()
        .contains("Imported body that must not be echoed.")
    );

    output_schema_test_support::assert_required_output(&myoxus_mcp::tool_registry::find_tool("document_import").unwrap().output_schema, &markdown);
    let (progress, wire) = sdk_rpc(&router, &token, "tools/call", json!({
      "name": "document_import", "arguments": markdown_params, "_meta": {"progressToken": "replay-test"},
    })).await;
    assert_eq!(progress.iter().map(|message| message["params"]["progress"].as_f64().unwrap()).collect::<Vec<_>>(), vec![1.0, 4.0]);
    assert!(progress[1]["params"]["message"].as_str().unwrap().contains("replayed"));
    let replay: myoxus_mcp::protocol::CallToolResult = serde_json::from_value(wire["result"].clone()).expect("SDK replay result");
    assert_eq!(replay.structured_content, Some(markdown.clone()));
    let markdown_external_id = markdown["externalId"]
      .as_str()
      .expect("external document key")
      .to_string();
    let markdown_internal_id: Uuid =
      sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id = $1 AND external_id = $2 AND deleted_at IS NULL")
        .bind(workspace_id)
        .bind(&markdown_external_id)
        .fetch_one(&pool)
        .await
        .expect("resolve imported document internally for fixture verification");
    let markdown_state = state
      .doc_service
      .load_full_doc(workspace_id, markdown_internal_id)
      .await
      .expect("load imported document");
    let imported_markdown = yjs::extract_text_from_yjs(&markdown_state)
      .expect("project imported Markdown")
      .markdown;
    assert!(imported_markdown.contains("Imported heading"));
    assert!(imported_markdown.contains("Imported body that must not be echoed."));

    let (progress, fragment_wire) = sdk_rpc(&router, &token, "tools/call", json!({
      "name": "document_import", "arguments": {
        "workspace_id": workspace_id,
        "title": "Imported Fragment",
        "fragment": {
          "schemaVersion": "myoxus.document-fragment.v1",
          "blocks": [
            { "kind": "heading", "level": 2, "spans": [{ "text": "Structured" }] },
            {
              "kind": "list_item",
              "listKind": "bulleted",
              "spans": [{ "text": "Parent" }],
              "children": [
                { "kind": "paragraph", "spans": [{ "text": "Child" }] }
              ]
            }
          ]
        },
        "folder_id": destination_id,
        "idempotency_key": "document-import-fragment-once",
      },
    })).await;
    assert!(progress.is_empty(), "no token means no progress notifications");
    let fragment_result: myoxus_mcp::protocol::CallToolResult = serde_json::from_value(fragment_wire["result"].clone()).expect("SDK fragment import");
    let fragment = fragment_result.structured_content.expect("fragment import payload");
    assert_eq!(fragment["inputMode"], "fragment");
    assert_eq!(fragment["blockCount"], 3);

    let document_count_before_rejections: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("count documents before rejected imports");
    for (title, fragment, expected_code) in [(
      "Unsupported reference",
      json!({
        "schemaVersion": "myoxus.document-fragment.v1",
        "blocks": [{
          "kind": "paragraph",
          "spans": [{ "text": "Reference", "reference": { "pageId": "other" } }]
        }]
      }),
      "MIX_MCP_DOCUMENT_IMPORT_REFERENCE_UNSUPPORTED",
    )] {
      let rejected = call_tool(
        "document_import",
        &json!({
          "workspace_id": workspace_id,
          "title": title,
          "fragment": fragment,
          "folder_id": destination_id,
          "idempotency_key": format!("document-import-reject-{title}"),
        }),
        &auth,
        &state,
      )
      .await
      .expect("known import tool returns a typed execution error");
      assert_eq!(rejected.is_error, Some(true));
      assert!(
        rejected.structured_content.expect("typed rejection payload")["message"]
          .as_str()
          .is_some_and(|message| message.contains(expected_code))
      );
    }

    for (title, selector) in [
      ("Missing destination", json!({ "folder_path": ["Missing"] })),
      ("Unknown folder id", json!({ "folder_id": "missing-folder" })),
    ] {
      let mut params = json!({
        "workspace_id": workspace_id,
        "title": title,
        "content_markdown": "Must not be created",
        "idempotency_key": format!("document-import-missing-{title}"),
      });
      params
        .as_object_mut()
        .expect("import params object")
        .extend(selector.as_object().expect("selector object").clone());
      let rejected = dispatch_tool("document_import", &params, &auth, &state)
        .await
        .expect_err("missing destination must fail before document creation");
      assert_eq!(rejected.0, -32004);
    }
    let ambiguous_a = inner_json(
      dispatch_tool(
        "folder_create",
        &json!({ "workspace_id": workspace_id, "name": "Duplicate import" }),
        &auth,
        &state,
      )
      .await
      .expect("create first ambiguous folder"),
    );
    let ambiguous_b = inner_json(
      dispatch_tool(
        "folder_create",
        &json!({ "workspace_id": workspace_id, "name": "Duplicate import" }),
        &auth,
        &state,
      )
      .await
      .expect("create second ambiguous folder"),
    );
    let ambiguous = dispatch_tool(
      "document_import",
      &json!({
        "workspace_id": workspace_id,
        "title": "Ambiguous destination",
        "content_markdown": "Must not be created",
        "folder_path": ["Duplicate import"],
        "idempotency_key": "document-import-ambiguous",
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("ambiguous destination must fail before document creation");
    assert!(ambiguous.1.contains("FOLDER_PATH_AMBIGUOUS"));
    assert!(ambiguous.1.contains(ambiguous_a["folder"]["id"].as_str().unwrap()));
    assert!(ambiguous.1.contains(ambiguous_b["folder"]["id"].as_str().unwrap()));

    let reader_auth = auth_with_scopes(reader_id, &["read:docs", "write:docs"]);
    let denied = dispatch_tool(
      "document_import",
      &json!({
        "workspace_id": workspace_id,
        "title": "Reader must not import",
        "content_markdown": "Must not be created",
        "folder_id": destination_id,
        "idempotency_key": "document-import-reader-denied",
      }),
      &reader_auth,
      &state,
    )
    .await
    .expect_err("write scope must not bypass document and organizer ACL");
    assert_eq!(denied.0, -32003);
    let document_count_after_rejections: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("count documents after rejected imports");
    assert_eq!(document_count_after_rejections, document_count_before_rejections);

    let mismatch = dispatch_tool(
      "document_import",
      &json!({
        "workspace_id": workspace_id,
        "title": "Changed replay payload",
        "content_markdown": "# Imported heading\n\nImported body that must not be echoed.",
        "folder_path": ["Imports", "Ready"],
        "idempotency_key": "document-import-markdown-once",
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("changed payload must not reuse an import idempotency key");
    assert_eq!(mismatch.0, -32010);
    assert!(mismatch.1.contains("MIX_MCP_IDEMPOTENCY_CONFLICT"));

    let (_, templates) = sdk_rpc(&router, &token, "resources/templates/list", json!({})).await;
    assert_eq!(templates["result"]["resourceTemplates"].as_array().unwrap().len(), 3);
    let template = templates["result"]["resourceTemplates"].as_array().unwrap().iter()
      .find_map(|template| template["uriTemplate"].as_str().filter(|uri| uri.starts_with("myoxus-document://")))
      .expect("published document template");
    let key = DocumentKey::parse(&markdown_external_id).unwrap();
    let uri = myoxus_mcp::resources::document_resource_uri(workspace_id, &key);
    assert!(uri.starts_with(&template.replace("{workspace_id}", &workspace_id.to_string()).replace("{external_id}", "")));
    let (_, resource) = sdk_rpc(&router, &token, "resources/read", json!({"uri": uri})).await;
    assert!(resource["result"]["contents"][0]["text"].as_str().unwrap().contains("Imported heading"));

    // An External member can discover only explicitly granted live documents.
    // Revoking the grant must affect completion immediately, not a cached list.
    sqlx::query("UPDATE workspace_memberships SET role = 'External' WHERE workspace_id=$1 AND user_id=$2")
      .bind(workspace_id).bind(reader_id).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) VALUES($1,$2,'Reader')")
      .bind(reader_id).bind(markdown_internal_id).execute(&pool).await.unwrap();
    let (_, reader_token) = key_service.generate(reader_id, "mcp-completion-test".into(),
      vec!["read:workspaces".into(), "read:docs".into()], None).await.unwrap();
    let completion = json!({"ref": {"type": "ref/resource", "uri": template}, "argument": {"name": "external_id", "value": ""},
      "context": {"arguments": {"workspace_id": workspace_id}}});
    let (_, granted) = sdk_rpc(&router, &reader_token, "completion/complete", completion.clone()).await;
    assert_eq!(granted["result"]["completion"]["values"], json!([markdown_external_id]));
    sqlx::query("DELETE FROM doc_user_permissions WHERE user_id=$1 AND doc_id=$2")
      .bind(reader_id).bind(markdown_internal_id).execute(&pool).await.unwrap();
    let (_, revoked) = sdk_rpc(&router, &reader_token, "completion/complete", completion).await;
    assert_eq!(revoked["result"]["completion"]["values"], json!([]));
    let (_, denied) = sdk_rpc(&router, &reader_token, "resources/read", json!({"uri": uri})).await;
    assert_eq!(denied["error"]["code"], -32003);

    let blocked = inner_json(
      dispatch_tool(
        "folder_create",
        &json!({ "workspace_id": workspace_id, "name": "Blocked import" }),
        &auth,
        &state,
      )
      .await
      .expect("create compensation destination"),
    );
    let blocked_id = blocked["folder"]["id"]
      .as_str()
      .expect("compensation destination id")
      .to_string();
    let malformed_sibling = inner_json(
      dispatch_tool(
        "folder_create",
        &json!({
          "workspace_id": workspace_id,
          "parent_id": blocked_id,
          "name": "Malformed sibling"
        }),
        &auth,
        &state,
      )
      .await
      .expect("create sibling for isolated placement failure fixture"),
    );
    corrupt_organizer_order_key(
      &state,
      workspace_id,
      malformed_sibling["folder"]["id"].as_str().expect("fixture row id"),
    )
    .await;
    let compensated = dispatch_tool(
      "document_import",
      &json!({
        "workspace_id": workspace_id,
        "title": "Compensated import",
        "content_markdown": "This page must be trashed after placement fails.",
        "folder_id": blocked_id,
        "idempotency_key": "document-import-compensated",
      }),
      &auth,
      &state,
    )
    .await
    .expect_err("invalid sibling order must fail organizer placement after page creation");
    assert_eq!(compensated.0, -32002);
    assert!(compensated.1.contains("MIX_MCP_DOCUMENT_IMPORT_COMPENSATED"));
    let compensated_row =
      sqlx::query("SELECT external_id, deleted_at FROM docs WHERE workspace_id = $1 AND title = 'Compensated import'")
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("compensated page remains as a trashed lifecycle record");
    let compensated_external_id: String = compensated_row.get("external_id");
    let compensated_deleted_at: Option<chrono::DateTime<chrono::Utc>> = compensated_row.get("deleted_at");
    assert!(compensated_deleted_at.is_some());
    let visible_entries = inner_json(
      dispatch_tool(
        "folder_entry_list",
        &json!({ "workspace_id": workspace_id, "parent_id": blocked_id }),
        &auth,
        &state,
      )
      .await
      .expect("list destination after compensation"),
    );
    assert!(
      visible_entries["entries"]
        .as_array()
        .expect("entries array")
        .iter()
        .all(|entry| entry["targetId"].as_str() != Some(compensated_external_id.as_str()))
    );
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[owner_id, editor_id, reader_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
