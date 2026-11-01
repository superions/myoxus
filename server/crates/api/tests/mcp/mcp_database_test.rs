// SPDX-License-Identifier: AGPL-3.0-or-later
//! MCP Database tools.
//!
//! These tests exercise the dispatcher against the same
//! Database capability owners used by GraphQL. They are intentionally focused on
//! contract behavior that plain service tests cannot cover: MCP scopes,
//! response shape and write-tool idempotency.

use crate::helpers;
use myoxus_domain::database::{DatabaseDefinitionRepository, DatabaseEditingRepository};

#[path = "../../../mcp/src/output_schema_test_support.rs"]
mod output_schema_test_support;

fn assert_database_output(tool: &str, result: &Value) -> Value {
  let value = parse_tool_text_json(result);
  assert_eq!(
    result["structuredContent"], value,
    "{tool}: text/structured output drift"
  );
  let descriptor = myoxus_mcp::tool_registry::tools()
    .iter()
    .find(|item| item.name == tool)
    .expect("registered Database tool");
  let schema = &descriptor.output_schema;
  assert!(
    output_schema_test_support::projection_schema_accepts(schema, schema, &value),
    "{tool}: actual output violates schema: {value}"
  );
  for field in schema["required"].as_array().expect("required output fields") {
    let field = field.as_str().expect("field name");
    let mut missing = value.clone();
    missing.as_object_mut().expect("object output").remove(field);
    assert!(
      !output_schema_test_support::projection_schema_accepts(schema, schema, &missing),
      "{tool}: missing {field} accepted"
    );
    let mut invalid = value.clone();
    // False is valid for unconstrained booleans such as canEditShared.
    invalid[field] = if value[field].is_boolean() && schema["properties"][field].get("const").is_none() {
      serde_json::json!("invalid boolean")
    } else {
      serde_json::json!(false)
    };
    assert!(
      !output_schema_test_support::projection_schema_accepts(schema, schema, &invalid),
      "{tool}: malformed {field} accepted"
    );
  }
  value
}

async fn database_wire_result(name: &str, params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Value {
  let result = myoxus_mcp::tools::call_tool(name, params, auth, state)
    .await
    .expect("MCP wire result");
  assert!(
    result.is_error != Some(true),
    "{name}: unexpected error code {:?}",
    result.structured_content.as_ref().and_then(|value| value.get("code"))
  );
  serde_json::to_value(result).expect("MCP wire serialization")
}

use std::sync::Arc;

use myoxus_application::audit::AuditRecorder;
use myoxus_application::database::{DatabaseLimits, DatabaseServices, InitialDatabaseViewKind};
use myoxus_application::doc::DocService;
use myoxus_application::document_graph::DocumentGraphService;
use myoxus_application::metrics::MetricsService;
use myoxus_application::permission::PermissionService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_domain::database::{
  DatabaseFieldConfig, DatabaseFieldType, DatabaseFilterOperator, DatabaseFilterRule, DatabaseFilterValue,
  DatabaseTableViewConfig, DatabaseViewConfig,
};

use myoxus_infrastructure::audit::PgAuditLogStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_infrastructure::workspace_database::PgDatabaseRepository;
use myoxus_mcp::auth::McpAuthContext;
use myoxus_mcp::tools::{McpToolState, dispatch_tool};
use serde_json::{Value, json};
use uuid::Uuid;

fn build_tool_state(pool: &sqlx::PgPool) -> McpToolState {
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let permission = Arc::new(PermissionService::new(auth_store));
  let doc_service = DocService::new(doc_store);
  let database_repo = Arc::new(PgDatabaseRepository::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  // File validation reads real SQL metadata; this fixture never writes blob bytes.
  let blob_service = Arc::new(myoxus_application::ports::blob_service::BlobService::new(
    Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(pool.clone())),
    Arc::new(myoxus_application::ports::NullBlobStorage),
    "mcp-database-test".into(),
  ));
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
    doc_service: doc_service.clone(),
    comment_service: None,
    server_origin: Arc::from("https://myoxus.test"),
    permission_service: permission.clone(),
    search_indexer: None,
    search_repository: None,
    assistant_packages: None,
    database_services: Some(Arc::new(DatabaseServices::new(
      database_repo,
      doc_service,
      permission,
      DatabaseLimits::default(),
      Arc::new(myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(
        pool.clone(),
        crate::helpers::database_starter_catalog(),
      )),
      crate::helpers::database_starter_catalog(),
      myoxus_application::database::DatabaseServiceDependencies::disabled().with_blob_service(blob_service),
    ))),
    calendar: None,
    organization: None,
    users: None,
    workspace_tag_service: None,
    document_graph_service: None::<Arc<DocumentGraphService>>,
    document_template_service: None,
    template_registry: None,
    template_suggestions: None,
    workspace_automation_service: None,
    pdf_export_service: None,
    pdf_template_repo: None,
    pdf_assignment_repo: None,
    document_services: Arc::new(myoxus_application::mcp::UnavailableMcpDocumentOperations),
    idempotency: Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone())),
    blob_service: None,
    upload_policy: None,
    audit_recorder: AuditRecorder::new(Arc::new(PgAuditLogStore::new(pool.clone()))),
    metrics_service: Arc::new(MetricsService::in_memory_stub()),
    document_cursor_signing_key: Arc::from(&b"mcp-database-test-cursor-key"[..]),
    document_export_max_bytes: 8 * 1024 * 1024,
  }
}

async fn auth_context(pool: &sqlx::PgPool, user_id: Uuid) -> McpAuthContext {
  let key_id = Uuid::new_v4();
  let scopes = vec!["read:databases".to_string(), "write:databases".to_string()];
  sqlx::query(
    r#"
    INSERT INTO api_keys (id, user_id, name, key_hash, scopes)
    VALUES ($1, $2, 'mcp-db-idempotency-test', $3, $4)
    "#,
  )
  .bind(key_id)
  .bind(user_id)
  .bind(format!("mcp-db-idempotency-test-{key_id}"))
  .bind(&scopes)
  .execute(pool)
  .await
  .expect("insert MCP API key");
  McpAuthContext {
    user_id,
    scopes,
    key_id,
  }
}

fn parse_tool_text_json(result: &Value) -> Value {
  let text = result["content"][0]["text"]
    .as_str()
    .expect("tool response text must be a string");
  serde_json::from_str(text).expect("tool response text must be JSON")
}

#[tokio::test]
async fn managed_workspace_tasks_mcp_protects_structure_and_container_but_allows_rows() {
  use futures_util::FutureExt;
  let (_app, pool, store) = helpers::setup_app().await;
  let (owner, _) = helpers::seed_user(&pool, &store, "mcp-managed-default").await;
  let result = std::panic::AssertUnwindSafe(async {
    let workspace = helpers::create_workspace(&pool, owner).await;
    let state = build_tool_state(&pool);
    let auth = auth_context(&pool, owner).await;
    let services = state.database_services.as_ref().unwrap();
    let default = services.views.task_destinations(owner, workspace, 1, None).await.unwrap()
      .default_destination.expect("canonical default");
    let projection = assert_database_output("database_get", &database_wire_result("database_get",
      &json!({"database_id":default.database_id}), &auth, &state).await);
    assert_eq!(projection["database"]["managed_schema"]["readiness"],"ready");
    assert_eq!(projection["database"]["database"]["system_role"],"workspace_tasks");
    let field = default.managed_schema.task_bindings.iter().find(|binding| binding.role_key == "task.title").unwrap().field_id;
    for (tool, mut args) in [
      ("database_update", json!({"database_id":default.database_id,"title":"Forbidden root","expected_edit_revision":default.edit_revision})),
      ("database_trash", json!({"database_id":default.database_id,"expected_edit_revision":default.edit_revision})),
      ("database_field_update", json!({"database_id":default.database_id,"field_id":field,"name":"Forbidden schema","expected_edit_revision":1})),
    ] {
      args["idempotency_key"] = json!(format!("managed-guard-{tool}"));
      let error = dispatch_tool(tool, &args, &auth, &state).await.expect_err("MCP must use protected native owner");
      assert!(error.1.contains("MIX_DATABASE_"), "transport/unknown tool rejection is insufficient: {tool}: {error:?}");
    }
    let row = dispatch_tool("database_row_create", &json!({"database_id":default.database_id,"title":"No Project required","idempotency_key":"managed-default-row"}), &auth, &state).await.unwrap();
    let row = parse_tool_text_json(&row);
    assert_eq!(row["row"]["row"]["database_id"],default.database_id.to_string());
    assert_eq!(row["row"]["row"]["title"],"No Project required");
    let inventory = services.views.task_destinations(owner,workspace,1,None).await.unwrap();
    assert!(inventory.projects.is_empty());
    assert_eq!(inventory.default_destination.unwrap().database_id,default.database_id);
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[owner]).await;
  let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id=$1")
    .bind(owner)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    remaining, 0,
    "MCP fixture cleanup must finish even on a failed assertion"
  );
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_database_write_is_service_backed_and_idempotent() {
  let (_app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-db-idem").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let state = build_tool_state(&pool);
  let auth = auth_context(&pool, user_id).await;
  let database = state
    .database_services
    .as_ref()
    .expect("database service")
    .definition
    .create_database(
      user_id,
      workspace_id,
      "MCP Database".to_string(),
      None,
      InitialDatabaseViewKind::Table,
    )
    .await
    .expect("create database");
  let database_id = database.database.id;

  let first = dispatch_tool(
    "database_row_create",
    &json!({
      "database_id": database_id.to_string(),
      "title": "MCP Row",
      "idempotency_key": "mcp-db-row-create-1"
    }),
    &auth,
    &state,
  )
  .await
  .expect("first MCP row create should succeed");
  let first_json = parse_tool_text_json(&first);
  let row_id = first_json["row"]["row"]["id"].as_str().expect("row id").to_string();

  let replay = dispatch_tool(
    "database_row_create",
    &json!({
      "database_id": database_id.to_string(),
      "title": "MCP Row",
      "idempotency_key": "mcp-db-row-create-1"
    }),
    &auth,
    &state,
  )
  .await
  .expect("same MCP row create idempotency key should replay");
  let replay_json = parse_tool_text_json(&replay);
  assert_eq!(
    replay_json["row"]["row"]["id"].as_str(),
    Some(row_id.as_str()),
    "idempotent replay must return the original row response"
  );

  let conflict = dispatch_tool(
    "database_row_create",
    &json!({
      "database_id": database_id.to_string(),
      "title": "Changed MCP Row",
      "idempotency_key": "mcp-db-row-create-1"
    }),
    &auth,
    &state,
  )
  .await
  .expect_err("same key with changed payload must fail");
  assert_eq!(conflict.0, -32010);
  assert!(conflict.1.contains("MIX_MCP_IDEMPOTENCY_CONFLICT"));

  let rows_table = ["workspace", "database", "rows"].join("_");
  let count: i64 = sqlx::query_scalar(&format!(
    "SELECT COUNT(*)::BIGINT FROM {rows_table} WHERE database_id = $1"
  ))
  .bind(database_id)
  .fetch_one(&pool)
  .await
  .expect("count rows");
  assert_eq!(count, 1, "idempotent replay and conflict must not create extra rows");

  let title_field_id = database
    .fields
    .iter()
    .find(|field| field.field_type == DatabaseFieldType::Title)
    .expect("title field")
    .id;
  let cell_params = json!({
    "database_id": database_id.to_string(),
    "row_id": row_id,
    "field_id": title_field_id,
    "value": { "kind": "text", "value": "Updated once" },
    "idempotency_key": "mcp-db-cell-update-1"
  });
  let updated = dispatch_tool("database_cell_update", &cell_params, &auth, &state)
    .await
    .expect("first MCP cell update should succeed");
  assert_eq!(
    dispatch_tool("database_cell_update", &cell_params, &auth, &state)
      .await
      .expect("same MCP cell update should replay"),
    updated
  );
  let row_title: String = sqlx::query_scalar(&format!("SELECT title FROM {rows_table} WHERE id = $1"))
    .bind(Uuid::parse_str(&row_id).expect("row UUID"))
    .fetch_one(&pool)
    .await
    .expect("load updated row title");
  assert_eq!(row_title, "Updated once");
  let mut changed_cell = cell_params;
  changed_cell["value"]["value"] = json!("Different value");
  let conflict = dispatch_tool("database_cell_update", &changed_cell, &auth, &state)
    .await
    .expect_err("same cell key with a changed value must conflict");
  assert!(conflict.1.contains("MIX_MCP_IDEMPOTENCY_CONFLICT"));

  let row_template_params = json!({
    "database_id": database_id,
    "row_template_id": Uuid::new_v4(),
    "title": "Template retry after abort",
    "idempotency_key": "mcp-db-template-abort-1",
  });
  let unavailable = dispatch_tool("database_row_from_template", &row_template_params, &auth, &state)
    .await
    .expect_err("missing template service must abort after guard admission");
  assert!(unavailable.1.contains("Template Registry is not enabled"));
  let aborted_rows: i64 = sqlx::query_scalar(
    "SELECT count(*) FROM mcp_idempotency_keys
     WHERE api_key_id = $1 AND tool_name = 'database_row_from_template'
       AND idempotency_key = 'mcp-db-template-abort-1'",
  )
  .bind(auth.key_id)
  .fetch_one(&pool)
  .await
  .expect("count aborted template replay guards");
  assert_eq!(aborted_rows, 0, "failed template apply must remove its pending guard");
  let retry = dispatch_tool("database_row_from_template", &row_template_params, &auth, &state)
    .await
    .expect_err("aborted template apply must remain safely retryable");
  assert!(retry.1.contains("Template Registry is not enabled"));

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_mcp_database_query_applies_saved_view_search_cursor_and_row_acl() {
  let (_app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-db-query-owner").await;
  let (outsider_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-db-query-outsider").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let state = build_tool_state(&pool);
  let auth = auth_context(&pool, owner_id).await;
  let outsider_auth = auth_context(&pool, outsider_id).await;
  let service = state.database_services.as_ref().expect("database service");
  let database = service
    .definition
    .create_database(
      owner_id,
      workspace_id,
      "MCP Query Database".to_string(),
      None,
      InitialDatabaseViewKind::Table,
    )
    .await
    .expect("create database");
  let database_id = database.database.id;
  let title_field_id = database
    .fields
    .iter()
    .find(|field| field.field_type == DatabaseFieldType::Title)
    .expect("title field")
    .id;
  let table_view = database.views.first().expect("initial Table view");
  service
    .views
    .update_view(
      owner_id,
      database_id,
      table_view.id,
      None,
      None,
      Some(DatabaseViewConfig::Table(DatabaseTableViewConfig {
        title_field_id,
        visible_field_ids: vec![title_field_id],
        field_widths: Default::default(),
        search_field_ids: vec![title_field_id],
        sort: Vec::new(),
        filter: vec![DatabaseFilterRule {
          field_id: title_field_id,
          operator: DatabaseFilterOperator::Contains,
          value: DatabaseFilterValue::Text("Keep".to_string()),
        }],
        filter_tree: None,
        group: None,
        subgroup: None,
      })),
    )
    .await
    .expect("configure saved view");

  for title in ["Keep alpha one", "Keep alpha two", "Keep beta", "Drop alpha"] {
    service
      .editing
      .create_row(owner_id, database_id, Some(title.to_string()), Vec::new())
      .await
      .expect("seed searchable row");
  }

  let first = dispatch_tool(
    "database_query",
    &json!({
      "database_id": database_id,
      "view_id": table_view.id,
      "search": "alpha",
      "limit": 1,
    }),
    &auth,
    &state,
  )
  .await
  .expect("query first cursor page");
  let first = parse_tool_text_json(&first);
  assert_eq!(first["totalCount"], 2);
  assert_eq!(first["rows"].as_array().map(Vec::len), Some(1));
  let first_row_id = first["rows"][0]["row"]["id"].as_str().expect("first row id");
  assert!(
    first["rows"][0]["row"]["title"]
      .as_str()
      .is_some_and(|title| title.contains("Keep alpha"))
  );
  let cursor = first["nextCursor"].as_str().expect("next cursor");

  let second = dispatch_tool(
    "database_query",
    &json!({
      "database_id": database_id,
      "view_id": table_view.id,
      "search": "alpha",
      "limit": 1,
      "cursor": cursor,
    }),
    &auth,
    &state,
  )
  .await
  .expect("query second cursor page");
  let second = parse_tool_text_json(&second);
  let second_row_id = second["rows"][0]["row"]["id"].as_str().expect("second row id");
  assert_ne!(first_row_id, second_row_id, "cursor pages must not duplicate rows");

  let row = dispatch_tool(
    "database_row_get",
    &json!({ "database_id": database_id, "row_id": second_row_id }),
    &auth,
    &state,
  )
  .await
  .expect("read one row");
  assert_eq!(parse_tool_text_json(&row)["row"]["row"]["id"], second_row_id);
  let denied = dispatch_tool(
    "database_row_get",
    &json!({ "database_id": database_id, "row_id": second_row_id }),
    &outsider_auth,
    &state,
  )
  .await
  .expect_err("non-member row read must fail");
  assert_eq!(denied.0, -32003);
  let missing = dispatch_tool(
    "database_row_get",
    &json!({ "database_id": database_id, "row_id": Uuid::new_v4() }),
    &auth,
    &state,
  )
  .await
  .expect_err("missing row must fail");
  assert_eq!(missing.0, -32004);

  helpers::cleanup_users(&pool, &[owner_id, outsider_id]).await;
}

#[tokio::test]
async fn inv_mcp_database_row_lifecycle_is_atomic_retry_safe_and_redacted() {
  let (_app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-db-row-lifecycle").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let state = build_tool_state(&pool);
  let auth = auth_context(&pool, user_id).await;
  let service = state.database_services.as_ref().expect("database service");
  let database = service
    .definition
    .create_database(
      user_id,
      workspace_id,
      "MCP Row Lifecycle".to_string(),
      None,
      InitialDatabaseViewKind::Table,
    )
    .await
    .expect("create database");
  let database_id = database.database.id;
  let notes_field = service
    .definition
    .create_field(
      user_id,
      database_id,
      "Notes".to_string(),
      DatabaseFieldType::Text,
      DatabaseFieldConfig::empty_for(DatabaseFieldType::Text),
      false,
    )
    .await
    .expect("create notes field");
  let summary_field = service
    .definition
    .create_field(
      user_id,
      database_id,
      "Summary".to_string(),
      DatabaseFieldType::Text,
      DatabaseFieldConfig::empty_for(DatabaseFieldType::Text),
      false,
    )
    .await
    .expect("create summary field");
  let row = service
    .editing
    .create_row(user_id, database_id, Some("Original".to_string()), Vec::new())
    .await
    .expect("create row");
  let row_id = row.row.id;

  let update = json!({
    "database_id": database_id,
    "row_id": row_id,
    "patches": [
      { "field_id": summary_field.id, "value": { "kind": "text", "value": "Atomic summary" } },
      { "field_id": notes_field.id, "value": { "kind": "text", "value": "redaction-sentinel" } }
    ],
    "idempotency_key": "mcp-db-row-update-1"
  });
  let updated = dispatch_tool("database_row_update", &update, &auth, &state)
    .await
    .expect("atomic row update");
  assert_eq!(
    dispatch_tool("database_row_update", &update, &auth, &state)
      .await
      .expect("identical update must replay"),
    updated
  );
  let mut changed_replay = update.clone();
  changed_replay["patches"][0]["value"]["value"] = json!("changed replay");
  assert!(
    dispatch_tool("database_row_update", &changed_replay, &auth, &state)
      .await
      .expect_err("changed replay payload must conflict")
      .1
      .contains("MIX_MCP_IDEMPOTENCY_CONFLICT")
  );

  let invalid_batch = json!({
    "database_id": database_id,
    "row_id": row_id,
    "patches": [
      { "field_id": summary_field.id, "value": { "kind": "text", "value": "must roll back" } },
      { "field_id": Uuid::new_v4(), "value": { "kind": "text", "value": "invalid" } }
    ],
    "idempotency_key": "mcp-db-row-update-invalid"
  });
  dispatch_tool("database_row_update", &invalid_batch, &auth, &state)
    .await
    .expect_err("one invalid patch must reject the whole batch");
  let after_invalid = service
    .views
    .get_row(user_id, database_id, row_id)
    .await
    .expect("read row after rejected batch")
    .expect("row remains live");
  assert!(after_invalid.cells.iter().any(|cell| {
    cell.field_id == summary_field.id
      && cell.value == myoxus_domain::database::DatabaseCellValueData::Text("Atomic summary".to_string())
  }));
  assert!(
    after_invalid
      .cells
      .iter()
      .all(|cell| cell.value != myoxus_domain::database::DatabaseCellValueData::Text("must roll back".to_string())),
    "valid sibling patch must roll back"
  );

  let summary_update = json!({
    "database_id": database_id,
    "row_id": row_id,
    "patches": [{ "field_id": summary_field.id, "value": { "kind": "text", "value": "Concurrent summary" } }],
    "idempotency_key": "mcp-db-row-update-concurrent-summary"
  });
  let notes_update = json!({
    "database_id": database_id,
    "row_id": row_id,
    "patches": [{ "field_id": notes_field.id, "value": { "kind": "text", "value": "Concurrent notes" } }],
    "idempotency_key": "mcp-db-row-update-concurrent-notes"
  });
  let (summary_result, notes_result) = tokio::join!(
    dispatch_tool("database_row_update", &summary_update, &auth, &state),
    dispatch_tool("database_row_update", &notes_update, &auth, &state)
  );
  summary_result.expect("concurrent summary patch");
  notes_result.expect("concurrent notes patch");
  let after_concurrent = service
    .views
    .get_row(user_id, database_id, row_id)
    .await
    .expect("read concurrent row")
    .expect("row remains live");
  assert!(after_concurrent.cells.iter().any(|cell| {
    cell.field_id == summary_field.id
      && cell.value == myoxus_domain::database::DatabaseCellValueData::Text("Concurrent summary".to_string())
  }));
  assert!(after_concurrent.cells.iter().any(|cell| {
    cell.field_id == notes_field.id
      && cell.value == myoxus_domain::database::DatabaseCellValueData::Text("Concurrent notes".to_string())
  }));

  let delete = json!({
    "database_id": database_id,
    "row_id": row_id,
    "idempotency_key": "mcp-db-row-delete-1"
  });
  let deleted = dispatch_tool("database_row_delete", &delete, &auth, &state)
    .await
    .expect("soft-delete row");
  assert_eq!(
    dispatch_tool("database_row_delete", &delete, &auth, &state)
      .await
      .expect("delete replay"),
    deleted
  );
  assert!(
    service
      .views
      .get_row(user_id, database_id, row_id)
      .await
      .expect("read deleted row")
      .is_none()
  );
  let deleted_update = dispatch_tool(
    "database_row_update",
    &json!({
      "database_id": database_id,
      "row_id": row_id,
      "patches": [{ "field_id": notes_field.id, "value": { "kind": "text", "value": "must stay deleted" } }],
      "idempotency_key": "mcp-db-row-update-deleted"
    }),
    &auth,
    &state,
  )
  .await
  .expect_err("deleted rows must reject cell patches");
  assert!(deleted_update.1.contains("MIX_DATABASE"));
  let deleted_at: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT deleted_at FROM workspace_database_rows WHERE id = $1")
      .bind(row_id)
      .fetch_one(&pool)
      .await
      .expect("load soft-delete timestamp");
  assert!(deleted_at.is_some(), "MCP delete must remain a recoverable soft-delete");

  dispatch_tool(
    "database_row_restore",
    &json!({
      "database_id": database_id,
      "row_id": row_id,
      "idempotency_key": "mcp-db-row-restore-1"
    }),
    &auth,
    &state,
  )
  .await
  .expect("restore row");
  assert!(
    service
      .views
      .get_row(user_id, database_id, row_id)
      .await
      .expect("read restored row")
      .is_some()
  );

  let audit_payloads: Vec<Value> = sqlx::query_scalar(
    "SELECT metadata FROM admin_audit_log WHERE credential_id = $1 AND event_key LIKE 'mcp.database.row.%'",
  )
  .bind(auth.key_id.to_string())
  .fetch_all(&pool)
  .await
  .expect("load MCP Database audit metadata");
  assert!(audit_payloads.len() >= 5, "each committed row mutation must be audited");
  for metadata in audit_payloads {
    let serialized = metadata.to_string();
    assert!(serialized.contains(&database_id.to_string()));
    assert!(serialized.contains(&row_id.to_string()));
    assert!(!serialized.contains("redaction-sentinel"));
    assert!(!serialized.contains("Concurrent notes"));
    assert!(!serialized.contains("Atomic summary"));
  }

  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// All shipped Database outputs are validated after the real dispatcher and
/// shared services, including empty collections, nullable associations and
/// UUID-keyed template defaults, with canonical migrations and owned teardown.
#[tokio::test]
async fn inv_mcp_database_outputs_match_registered_schemas() {
  use futures_util::FutureExt;
  let pool = helpers::setup_pool().await;
  use myoxus_application::database::editing::templates::CreateDatabaseRowTemplate;
  use myoxus_application::template_registry::TemplateRegistryService;
  use myoxus_domain::database::{DatabaseCellValueData, DatabaseRowKind};
  use myoxus_infrastructure::template_registry::SqlxTemplateRegistryStore;
  use std::collections::BTreeMap;

  async fn call(name: &str, params: Value, auth: &McpAuthContext, state: &McpToolState) -> Value {
    assert_database_output(name, &database_wire_result(name, &params, auth, state).await)
  }

  let user = helpers::create_user(&pool, "mcp-output-schema", false).await;
  let workspace = helpers::create_workspace(&pool, user).await;
  let template = Uuid::new_v4();
  let outcome = std::panic::AssertUnwindSafe(async {
  let mut state = build_tool_state(&pool);
  let registry = Arc::new(TemplateRegistryService::new(Arc::new(SqlxTemplateRegistryStore::new(
    pool.clone(),
  ))));
  state.template_registry = Some(registry.as_ref().clone());
  let mut auth = auth_context(&pool, user).await;
  auth.scopes.push("read:templates".into());
  let empty = call("database_list", json!({"workspace_id":workspace}), &auth, &state).await;
  assert_eq!(empty["databases"], json!([]));
  let service = state.database_services.as_ref().expect("Database services");
  let database = service
    .definition
    .create_database(
      user,
      workspace,
      "MCP output schemas".into(),
      None,
      InitialDatabaseViewKind::Table,
    )
    .await
    .expect("fixture Database");
  let id = database.database.id;
  let field = database
    .fields
    .iter()
    .find(|field| field.field_type == DatabaseFieldType::Title)
    .expect("title field")
    .id;
  let text_field = service
    .definition
    .create_field(
      user,
      id,
      "Schema text".into(),
      DatabaseFieldType::Text,
      DatabaseFieldConfig::empty_for(DatabaseFieldType::Text),
      false,
    )
    .await
    .expect("editable text field")
    .id;
  let listed = call("database_list", json!({"workspace_id":workspace}), &auth, &state).await;
  assert_eq!(listed["databases"].as_array().expect("summaries").len(), 1);
  let empty = call("database_query", json!({"database_id":id}), &auth, &state).await;
  assert_eq!(empty["rows"], json!([]));
  assert!(empty["nextCursor"].is_null());
  let bindings = call("database_row_templates_list", json!({"database_id":id}), &auth, &state).await;
  assert_eq!(bindings["bindings"], json!([]));

  let created = call(
    "database_row_create",
    json!({"database_id":id,"title":"First","idempotency_key":"schema-create"}),
    &auth,
    &state,
  )
  .await;
  let row = created["row"]["row"]["id"].as_str().expect("row UUID").to_owned();
  assert!(created["row"]["row"]["content_document_id"].is_null());
  call(
    "database_row_get",
    json!({"database_id":id,"row_id":row}),
    &auth,
    &state,
  )
  .await;
  call("database_cell_update", json!({"database_id":id,"row_id":row,"field_id":field,"value":{"kind":"text","value":"Cell edit"},"idempotency_key":"schema-cell"}), &auth, &state).await;
  call("database_row_update", json!({"database_id":id,"row_id":row,"patches":[{"field_id":text_field,"value":{"kind":"text","value":"Row edit"}}],"idempotency_key":"schema-update"}), &auth, &state).await;
  call(
    "database_row_delete",
    json!({"database_id":id,"row_id":row,"idempotency_key":"schema-delete"}),
    &auth,
    &state,
  )
  .await;
  call(
    "database_row_restore",
    json!({"database_id":id,"row_id":row,"idempotency_key":"schema-restore"}),
    &auth,
    &state,
  )
  .await;
  let page = call("database_query", json!({"database_id":id}), &auth, &state).await;
  assert_eq!(page["rows"].as_array().expect("rows").len(), 1);
  call("database_csv_export", json!({"database_id":id}), &auth, &state).await;
  let export = call("database_json_export", json!({"database_id":id}), &auth, &state).await;
  let content = export["export"]["content"].as_str().expect("JSON export text");
  call(
    "database_json_import_preview",
    json!({"workspace_id":workspace,"content_text":content}),
    &auth,
    &state,
  )
  .await;
  call(
    "database_json_import",
    json!({"workspace_id":workspace,"content_text":content,"idempotency_key":"schema-json-import"}),
    &auth,
    &state,
  )
  .await;
  let notion = call("database_notion_export", json!({"database_id":id}), &auth, &state).await;
  let html = notion["export"]["pages"][0]["content"]
    .as_str()
    .expect("Notion HTML text");
  call(
    "database_notion_import_preview",
    json!({"workspace_id":workspace,"content_text":html}),
    &auth,
    &state,
  )
  .await;
  call(
    "database_notion_import",
    json!({"workspace_id":workspace,"content_text":html,"idempotency_key":"schema-notion-import"}),
    &auth,
    &state,
  )
  .await;

  sqlx::query("INSERT INTO template_catalog_entries(id,slug,title,source,builder_version,category) VALUES($1,$2,'Schema cell-only preset','builtin',1,'database-row-template')")
    .bind(template).bind(format!("schema-cell-only-{template}")).execute(&pool).await.expect("owned cell-only catalog fixture");
  let binding = service
    .editing
    .create_row_template(
      user,
      CreateDatabaseRowTemplate {
        database_id: id,
        template_id: template,
        row_kind: DatabaseRowKind::Record,
        name: "Schema preset".into(),
        description: None,
        position: None,
        enabled: true,
        is_default: false,
        initial_cell_values: BTreeMap::from([(text_field, DatabaseCellValueData::Text("Template value".into()))]),
      },
      &registry,
    )
    .await
    .expect("shared row-template owner");
  let bindings = call("database_row_templates_list", json!({"database_id":id}), &auth, &state).await;
  let defaults = &bindings["bindings"][0]["rowTemplate"]["initialCellValues"];
  assert!(
    defaults.get(text_field.to_string()).is_some(),
    "field UUIDs remain dynamic keys"
  );
  let schema = &myoxus_mcp::tool_registry::tools()
    .iter()
    .find(|tool| tool.name == "database_row_templates_list")
    .expect("template schema")
    .output_schema;
  assert_eq!(bindings["bindings"][0]["rowTemplate"]["editRevision"], 1);
  for revision in [Value::Null, json!(0), json!("1")] {
    let mut invalid = bindings.clone();
    invalid["bindings"][0]["rowTemplate"]["editRevision"] = revision;
    assert!(
      !output_schema_test_support::projection_schema_accepts(schema, schema, &invalid),
      "invalid native row-template revision must fail"
    );
  }
  let mut missing_revision = bindings.clone();
  missing_revision["bindings"][0]["rowTemplate"]
    .as_object_mut()
    .expect("native row-template output")
    .remove("editRevision");
  assert!(
    !output_schema_test_support::projection_schema_accepts(schema, schema, &missing_revision),
    "missing native row-template revision must fail"
  );
  let mut invalid = bindings.clone();
  invalid["bindings"][0]["rowTemplate"]["initialCellValues"][text_field.to_string()] = Value::Null;
  assert!(
    !output_schema_test_support::projection_schema_accepts(schema, schema, &invalid),
    "invalid dynamic cell value must fail"
  );
  let mut invalid = bindings.clone();
  let values = invalid["bindings"][0]["rowTemplate"]["initialCellValues"]
    .as_object_mut()
    .expect("default map");
  let value = values.remove(&text_field.to_string()).expect("default");
  values.insert("not-a-field-uuid".into(), value);
  assert!(
    !output_schema_test_support::projection_schema_accepts(schema, schema, &invalid),
    "invalid dynamic field key must fail"
  );
  call(
    "database_row_from_template",
    json!({"database_id":id,"row_template_id":binding.row_template.id,"idempotency_key":"schema-template"}),
    &auth,
    &state,
  )
  .await;
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[user]).await;
  sqlx::query("DELETE FROM template_catalog_entries WHERE id=$1")
    .bind(template)
    .execute(&pool)
    .await
    .expect("delete owned catalog fixture");
  let remaining: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1) OR EXISTS(SELECT 1 FROM workspaces WHERE id=$2)",
  )
  .bind(user)
  .bind(workspace)
  .fetch_one(&pool)
  .await
  .expect("verify owned fixture teardown");
  assert!(!remaining, "Database output fixture must leave no user or workspace");
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

/// The adapter must preserve populated aggregates and authorize completed purges anew.
#[tokio::test]
async fn inv_mcp_database_schema_lifecycle_preserves_content_and_current_authority() {
  use futures_util::FutureExt;
  use myoxus_domain::database::{DatabaseCellValueData, DatabaseFileReference, DatabaseFilesValue};
  let (app, pool, store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &store, "mcp-schema-owner").await;
  let (manager, _) = helpers::seed_user(&pool, &store, "mcp-schema-manager").await;
  let (reader, _) = helpers::seed_user(&pool, &store, "mcp-schema-reader").await;
  let (outside, _) = helpers::seed_user(&pool, &store, "mcp-schema-outside").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let state = build_tool_state(&pool);
  let journey = std::panic::AssertUnwindSafe(async {
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'Manager','Accepted'),($1,$3,'Reader','Accepted')")
        .bind(workspace).bind(manager).bind(reader).execute(&pool).await.unwrap();
    let auth = auth_context(&pool, owner).await;
    let manager_auth = auth_context(&pool, manager).await;
    let reader_auth = auth_context(&pool, reader).await;
    let outside_auth = auth_context(&pool, outside).await;
    let read_only = McpAuthContext {
      scopes: vec!["read:databases".into()],
      ..reader_auth.clone()
    };
    let before_create: Vec<serde_json::Value> = sqlx::query_scalar(
      "SELECT to_jsonb(database) FROM workspace_databases database WHERE workspace_id=$1 ORDER BY id"
    ).bind(workspace).fetch_all(&pool).await.unwrap();
    assert_eq!(before_create.len(), 1, "one canonical default precedes user Database creation");
    assert_eq!(before_create[0]["system_role"], "workspace_tasks");
    let create =
      json!({"workspace_id":workspace,"title":"Schema lifecycle","description":"retained","idempotency_key":"create"});
    for denied in [&reader_auth, &outside_auth, &read_only] {
      dispatch_tool("database_create", &create, denied, &state)
        .await
        .expect_err("scope/ACL denial");
    }
    let mut invalid = create.clone();
    invalid["title"] = json!("  ");
    dispatch_tool("database_create", &invalid, &auth, &state)
      .await
      .expect_err("blank title");
    invalid = create.clone();
    invalid["initial_view_kind"] = json!("calendar");
    dispatch_tool("database_create", &invalid, &auth, &state)
      .await
      .expect_err("unsupported initial kind");
    assert_eq!(
      sqlx::query_scalar::<_, serde_json::Value>("SELECT to_jsonb(database) FROM workspace_databases database WHERE workspace_id=$1 ORDER BY id")
        .bind(workspace).fetch_all(&pool).await.unwrap(),
      before_create,
      "denied and invalid creation leave the canonical default unchanged and allocate nothing"
    );
    let created = assert_database_output(
      "database_create",
      &database_wire_result("database_create", &create, &auth, &state).await,
    );
    assert_eq!(
      assert_database_output(
        "database_create",
        &database_wire_result("database_create", &create, &auth, &state).await
      ),
      created
    );
    let id: Uuid = created["database"]["database"]["id"].as_str().unwrap().parse().unwrap();
    let services = state.database_services.as_ref().unwrap();
    let files = services
      .definition
      .create_field(
        owner,
        id,
        "Files".into(),
        DatabaseFieldType::Files,
        DatabaseFieldConfig::empty_for(DatabaseFieldType::Files),
        false,
      )
      .await
      .unwrap();
    let blob = format!("mcp-schema/{id}");
    sqlx::query("INSERT INTO blobs(workspace_id,key,size,mime,status,created_at,updated_at) VALUES($1,$2,7,'text/plain','completed',now(),now())")
      .bind(workspace)
      .bind(&blob)
      .execute(&pool)
      .await
      .unwrap();
    let row = services
      .editing
      .create_row(
        owner,
        id,
        Some("Retained row".into()),
        vec![(
          files.id,
          DatabaseCellValueData::Files(DatabaseFilesValue {
            files: vec![DatabaseFileReference {
              blob_key: blob.clone(),
              name: Some("retained.txt".into()),
              mime: Some("text/plain".into()),
              size: Some(7),
              caption: None,
              cover: false,
            }],
          }),
        )],
      )
      .await
      .unwrap();
    let snapshot = services.definition.get_database(owner, id).await.unwrap();
    let before_row = services.views.get_row(owner, id, row.row.id).await.unwrap().unwrap();
    let get = json!({"database_id":id});
    let read = assert_database_output(
      "database_get",
      &database_wire_result("database_get", &get, &read_only, &state).await,
    );
    assert_eq!(read["database"], serde_json::to_value(&snapshot).unwrap());
    dispatch_tool("database_get", &get, &outside_auth, &state)
      .await
      .expect_err("unreadable record");
    let update = json!({"database_id":id,"title":"Renamed schema","expected_edit_revision":snapshot.database.edit_revision,"idempotency_key":"rename"});
    let before = serde_json::to_value(&snapshot).unwrap();
    for denied in [&reader_auth, &outside_auth, &read_only] {
      dispatch_tool("database_update", &update, denied, &state)
        .await
        .expect_err("metadata denial");
    }
    for revision in [json!(null), json!(0), json!(-1), json!(1.5)] {
      let mut bad = update.clone();
      bad["expected_edit_revision"] = revision;
      dispatch_tool("database_update", &bad, &auth, &state)
        .await
        .expect_err("invalid revision");
    }
    let mut bad = update.clone();
    bad["title"] = json!("");
    dispatch_tool("database_update", &bad, &auth, &state)
      .await
      .expect_err("invalid title");
    assert_eq!(
      serde_json::to_value(services.definition.get_database(owner, id).await.unwrap()).unwrap(),
      before
    );
    let renamed = assert_database_output(
      "database_update",
      &database_wire_result("database_update", &update, &auth, &state).await,
    );
    assert_eq!(
      assert_database_output(
        "database_update",
        &database_wire_result("database_update", &update, &auth, &state).await
      ),
      renamed
    );
    assert_eq!(renamed["database"]["database"]["description"], "retained");
    let mut changed = update.clone();
    changed["description"] = json!(null);
    assert_eq!(dispatch_tool("database_update", &changed, &auth, &state).await.expect_err("omitted description and explicit null have different effects").0, -32010);
    let mut stale = update.clone();
    stale["idempotency_key"] = json!("stale");
    stale["title"] = json!("Overwrite");
    let error = dispatch_tool("database_update", &stale, &auth, &state)
      .await
      .expect_err("stale update");
    assert!(error.1.contains("MIX_DATABASE_CONFLICT"));
    assert_eq!(
      assert_database_output(
        "database_get",
        &database_wire_result("database_get", &get, &auth, &state).await
      ),
      renamed
    );
    let graph=helpers::gql(&app,session,json!({"query":"query($w:String!,$id:String!){workspace(id:$w){database(databaseId:$id){database{id title description editRevision} fields{id} views{id}}}}","variables":{"w":workspace,"id":id}})).await;
    assert!(graph.get("errors").is_none(), "{graph}");
    assert_eq!(
      graph["data"]["workspace"]["database"]["database"]["title"],
      "Renamed schema"
    );
    assert_eq!(
      graph["data"]["workspace"]["database"]["fields"]
        .as_array()
        .unwrap()
        .len(),
      snapshot.fields.len()
    );
    let revision = renamed["database"]["database"]["edit_revision"].as_i64().unwrap();
    let live_purge = json!({"workspace_id":workspace,"database_id":id,"expected_edit_revision":revision,"confirm":true,"idempotency_key":"live-purge"});
    dispatch_tool("database_delete_permanently", &live_purge, &auth, &state)
      .await
      .expect_err("must be trashed");
    let trash = json!({"database_id":id,"expected_edit_revision":revision,"idempotency_key":"trash"});
    let trashed = assert_database_output(
      "database_trash",
      &database_wire_result("database_trash", &trash, &manager_auth, &state).await,
    );
    assert_eq!(
      assert_database_output(
        "database_trash",
        &database_wire_result("database_trash", &trash, &manager_auth, &state).await
      ),
      trashed
    );
    dispatch_tool("database_get", &get, &auth, &state)
      .await
      .expect_err("normal reads omit trash");
    let restore = json!({"database_id":id,"expected_edit_revision":trashed["database"]["database"]["edit_revision"],"idempotency_key":"restore"});
    dispatch_tool("database_restore", &restore, &reader_auth, &state)
      .await
      .expect_err("trash-aware ACL");
    let restored = assert_database_output(
      "database_restore",
      &database_wire_result("database_restore", &restore, &auth, &state).await,
    );
    assert_eq!(
      assert_database_output(
        "database_restore",
        &database_wire_result("database_restore", &restore, &auth, &state).await
      ),
      restored
    );
    let final_record = services.definition.get_database(owner, id).await.unwrap();
    assert_eq!(serde_json::to_value(&final_record.fields).unwrap(), serde_json::to_value(&snapshot.fields).unwrap());
    assert_eq!(serde_json::to_value(&final_record.views).unwrap(), serde_json::to_value(&snapshot.views).unwrap());
    let after_row = services.views.get_row(owner, id, row.row.id).await.unwrap().unwrap();
    assert_eq!(serde_json::to_value((&after_row.row, &after_row.cells, &after_row.cell_revisions)).unwrap(), serde_json::to_value((&before_row.row, &before_row.cells, &before_row.cell_revisions)).unwrap());
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT count(*) FROM blobs WHERE workspace_id=$1 AND key=$2")
        .bind(workspace)
        .bind(&blob)
        .fetch_one(&pool)
        .await
        .unwrap(),
      1
    );
    let trash = json!({"database_id":id,"expected_edit_revision":restored["database"]["database"]["edit_revision"],"idempotency_key":"trash-final"});
    let trashed = assert_database_output(
      "database_trash",
      &database_wire_result("database_trash", &trash, &auth, &state).await,
    );
    let purge = json!({"workspace_id":workspace,"database_id":id,"expected_edit_revision":trashed["database"]["database"]["edit_revision"],"confirm":true,"idempotency_key":"purge"});
    let mut unconfirmed = purge.clone();
    unconfirmed["confirm"] = json!(false);
    dispatch_tool("database_delete_permanently", &unconfirmed, &manager_auth, &state)
      .await
      .expect_err("explicit confirmation");
    let mut stale = purge.clone();
    stale["expected_edit_revision"] = json!(1);
    dispatch_tool("database_delete_permanently", &stale, &manager_auth, &state)
      .await
      .expect_err("stale purge");
    let removed = assert_database_output(
      "database_delete_permanently",
      &database_wire_result("database_delete_permanently", &purge, &manager_auth, &state).await,
    );
    assert_eq!(removed["deleted"], true);
    assert_eq!(
      assert_database_output(
        "database_delete_permanently",
        &database_wire_result("database_delete_permanently", &purge, &manager_auth, &state).await
      ),
      removed
    );
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_databases WHERE id=$1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap(),
      0
    );
    let mut changed = purge.clone();
    changed["expected_edit_revision"] = json!(999);
    assert_eq!(
      dispatch_tool("database_delete_permanently", &changed, &manager_auth, &state)
        .await
        .expect_err("changed payload conflicts with committed purge")
        .0,
      -32010
    );
    let graph = helpers::gql(&app, session, json!({"query":"query($w:String!,$id:String!){workspace(id:$w){database(databaseId:$id){database{id}}}}","variables":{"w":workspace,"id":id}})).await;
    assert!(graph.get("errors").is_none(), "{graph}");
    assert!(graph["data"]["workspace"]["database"].is_null(), "normal GraphQL must no longer read the purged Database");
    sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2")
      .bind(workspace)
      .bind(manager)
      .execute(&pool)
      .await
      .unwrap();
    dispatch_tool("database_delete_permanently", &purge, &manager_auth, &state)
      .await
      .expect_err("purge receipt requires fresh manager authority");
    let mut changed = purge.clone();
    changed["expected_edit_revision"] = json!(999);
    dispatch_tool("database_delete_permanently", &changed, &auth, &state)
      .await
      .expect_err("new key owner cannot use another key receipt");
    // A committed schema whose readback exceeds the transport bound cannot be
    // created again by retrying the same key after the bound is increased.
    let mut bounded_state = build_tool_state(&pool);
    bounded_state.document_export_max_bytes = 200;
    let uncertain = json!({"workspace_id": workspace, "title": "Uncertain readback", "idempotency_key": "uncertain"});
    let error = dispatch_tool("database_create", &uncertain, &auth, &bounded_state).await.expect_err("post-commit readback bound");
    assert!(error.1.starts_with("MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED_UNCERTAIN"));
    let error = dispatch_tool("database_create", &uncertain, &auth, &state).await.expect_err("same-key replay fences uncertain effects");
    assert!(error.1.starts_with("MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED_UNCERTAIN"));
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_databases WHERE workspace_id=$1 AND title='Uncertain readback'").bind(workspace).fetch_one(&pool).await.unwrap(),1);
    let audit:Value=sqlx::query_scalar("SELECT coalesce(json_agg(row_to_json(a)),'[]') FROM admin_audit_log a WHERE target_id=$1 AND event_key='mcp.database.update'").bind(id.to_string()).fetch_one(&pool).await.unwrap();
    assert!(!audit.as_array().unwrap().is_empty());
    assert!(!audit.to_string().contains("Renamed schema"));
  }).catch_unwind().await;
  let users = [owner, manager, reader, outside];
  // Audit intentionally survives production user deletion. Fixture events must
  // be removed while their original actor IDs still identify our owned rows.
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=ANY($1)")
    .bind(&users[..])
    .execute(&pool)
    .await
    .expect("remove owned schema-lifecycle audit events");
  helpers::cleanup_users(&pool, &users).await;
  let remaining: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM users WHERE id=ANY($1))
       OR EXISTS(SELECT 1 FROM workspaces WHERE id=$2)
       OR EXISTS(SELECT 1 FROM workspace_databases WHERE workspace_id=$2)
       OR EXISTS(SELECT 1 FROM blobs WHERE workspace_id=$2)
       OR EXISTS(SELECT 1 FROM api_keys WHERE user_id=ANY($1))
       OR EXISTS(SELECT 1 FROM mcp_idempotency_keys WHERE user_id=ANY($1))
       OR EXISTS(SELECT 1 FROM sessions WHERE user_id=ANY($1))",
  )
  .bind(&users[..])
  .bind(workspace)
  .fetch_one(&pool)
  .await
  .expect("verify complete schema fixture cleanup");
  assert!(!remaining, "schema fixture must not leave records or credentials");
  if let Err(panic) = journey {
    std::panic::resume_unwind(panic);
  }
}

/// Observe only our writer, refreshing PostgreSQL's transaction-local activity
/// snapshot after each unsuccessful probe. Reuse the held connection, so a
/// two-slot pool can support the blocker and writer without a third checkout.
async fn wait_for_database_writer(
  blocker: &mut sqlx::Transaction<'_, sqlx::Postgres>,
  blocker_pid: i32,
  table: &str,
) -> bool {
  for _ in 0..100 {
    sqlx::query("SELECT pg_stat_clear_snapshot()")
      .execute(&mut **blocker)
      .await
      .expect("refresh own activity snapshot");
    if sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%' || $2 || '%')").bind(blocker_pid).bind(table).fetch_one(&mut **blocker).await.expect("observe owned writer") {return true;}
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
  }
  false
}

/// Field adapters preserve populated typed values and delegate concurrency/ACL.
#[tokio::test]
async fn inv_mcp_database_fields_preserve_values_options_and_current_authority() {
  use futures_util::FutureExt;
  use myoxus_application::database::DatabaseRowRead;
  use myoxus_domain::database::DatabaseCellValueData;
  fn stable_row(mut row: DatabaseRowRead) -> Value {
    // Reorder intentionally changes cell projection order, not identity/value.
    row.cells.sort_by_key(|cell| cell.field_id);
    row.cell_revisions.sort_by_key(|cell| cell.field_id);
    serde_json::to_value((row.row, row.cells, row.cell_revisions, row.group_keys, row.redacted)).unwrap()
  }
  let (app, pool, store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &store, "mcp-fields-owner").await;
  let (manager, _) = helpers::seed_user(&pool, &store, "mcp-fields-manager").await;
  let (reader, _) = helpers::seed_user(&pool, &store, "mcp-fields-reader").await;
  let (outside, _) = helpers::seed_user(&pool, &store, "mcp-fields-outside").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let state = build_tool_state(&pool);
  let outcome = std::panic::AssertUnwindSafe(async {
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'Manager','Accepted'),($1,$3,'Reader','Accepted')").bind(workspace).bind(manager).bind(reader).execute(&pool).await.unwrap();
    let auth = auth_context(&pool, owner).await;
    let manager_auth = auth_context(&pool, manager).await;
    let reader_auth = auth_context(&pool, reader).await;
    let outside_auth = auth_context(&pool, outside).await;
    let read_only = McpAuthContext {scopes:vec!["read:databases".into()], ..reader_auth.clone()};
    let services = state.database_services.as_ref().unwrap();
    let record = services.definition.create_database(owner, workspace, "Field schema".into(), None, InitialDatabaseViewKind::Table).await.unwrap();
    let id = record.database.id;
    let target = services.definition.create_database(owner, workspace, "Relation target".into(), None, InitialDatabaseViewKind::Table).await.unwrap();
    let target_row = services.editing.create_row(owner, target.database.id, Some("Referenced target".into()), vec![]).await.unwrap();
    let create = json!({"database_id":id,"name":"Notes","field_type":"text","idempotency_key":"notes"});
    for denied in [&reader_auth, &outside_auth, &read_only] {
      dispatch_tool("database_field_create", &create, denied, &state).await.expect_err("creation authority/scope");
    }
    for patch in [json!({"field_type":"unknown"}), json!({"name":"  "}), json!({"required":null}), json!({"config":{"kind":"text","multiline":false,"unknown":true}}), json!({"field_type":"select","config":{"kind":"select","options":[{"id":"x","name":"One","position":0,"colorRole":"neutral"},{"id":"x","name":"Duplicate","position":1,"colorRole":"neutral"}]}})] {
      let mut invalid = create.clone(); invalid.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
      dispatch_tool("database_field_create", &invalid, &auth, &state).await.expect_err("invalid definition");
    }
    let private_formula = json!({"database_id":id,"name":"Formula","field_type":"formula","config":{"kind":"formula","expression":"sensitive_fixture_formula_name()","resultType":"text","dependencyFieldIds":[],"stalePolicy":"async","format":null},"idempotency_key":"invalid-formula"});
    let error=dispatch_tool("database_field_create",&private_formula,&auth,&state).await.expect_err("unsupported formula must not echo its content");assert!(error.1.starts_with("MIX_DATABASE_FORMULA_PARSE_FAILED:"));assert!(!error.1.contains("sensitive_fixture_formula_name"));
    assert_eq!(serde_json::to_value(services.definition.get_database(owner, id).await.unwrap()).unwrap(), serde_json::to_value(&record).unwrap());
    let notes = assert_database_output("database_field_create", &database_wire_result("database_field_create", &create, &manager_auth, &state).await)["field"].clone();
    assert_eq!(assert_database_output("database_field_create", &database_wire_result("database_field_create", &create, &manager_auth, &state).await)["field"], notes);
    let notes_id: Uuid = notes["id"].as_str().unwrap().parse().unwrap();
    let select_config = json!({"kind":"select","options":[{"id":"open","name":"Open","position":0,"colorRole":"neutral"}]});
    let select = assert_database_output("database_field_create", &database_wire_result("database_field_create", &json!({"database_id":id,"name":"Stage","field_type":"select","config":select_config,"idempotency_key":"select"}), &manager_auth, &state).await)["field"].clone();
    let select_id: Uuid = select["id"].as_str().unwrap().parse().unwrap();
    let relation = assert_database_output("database_field_create", &database_wire_result("database_field_create", &json!({"database_id":id,"name":"Related","field_type":"relation","config":{"kind":"relation","targetDatabaseId":target.database.id,"allowMultiple":true,"reciprocalFieldId":null,"maxTargets":null},"idempotency_key":"relation"}), &manager_auth, &state).await)["field"].clone();
    let relation_id: Uuid = relation["id"].as_str().unwrap().parse().unwrap();
    let row = services.editing.create_row(owner, id, Some("Populated row".into()), vec![(notes_id, DatabaseCellValueData::Text("retained text".into())),(select_id, DatabaseCellValueData::Select("open".into())),(relation_id, DatabaseCellValueData::Relation(vec![target_row.row.id]))]).await.unwrap();
    let before_row = stable_row(services.views.get_row(owner, id, row.row.id).await.unwrap().unwrap());
    let update = json!({"database_id":id,"field_id":select_id,"name":"Workflow","config":{"kind":"select","options":[{"id":"open","name":"In progress","position":0,"colorRole":"neutral"},{"id":"done","name":"Done","position":1,"colorRole":"success"}]},"expected_edit_revision":select["edit_revision"],"idempotency_key":"option-label"});
    for denied in [&reader_auth, &outside_auth, &read_only] {dispatch_tool("database_field_update", &update, denied, &state).await.expect_err("field update denial");}
    let updated = assert_database_output("database_field_update", &database_wire_result("database_field_update", &update, &manager_auth, &state).await)["field"].clone();
    assert_eq!(updated["edit_revision"], select["edit_revision"].as_i64().unwrap()+1);
    assert_eq!(assert_database_output("database_field_update", &database_wire_result("database_field_update", &update, &manager_auth, &state).await)["field"],updated);
    let snapshot = serde_json::to_value(services.definition.get_database(owner, id).await.unwrap()).unwrap();
    for (tool, params) in [
      ("database_field_update", json!({"database_id":id,"field_id":select_id,"name":"stale","expected_edit_revision":select["edit_revision"],"idempotency_key":"stale"})),
      ("database_field_update", json!({"database_id":id,"field_id":target.fields[0].id,"name":"foreign","expected_edit_revision":1,"idempotency_key":"foreign"})),
      ("database_field_update", json!({"database_id":id,"field_id":notes_id,"field_type":"number","expected_edit_revision":1,"idempotency_key":"no-type-replacement"})),
      ("database_field_delete", json!({"database_id":id,"field_id":record.fields[0].id,"expected_edit_revision":1,"idempotency_key":"protected"})),
    ] {dispatch_tool(tool,&params,&auth,&state).await.expect_err("invalid/stale/protected field mutation");}
    assert_eq!(serde_json::to_value(services.definition.get_database(owner, id).await.unwrap()).unwrap(),snapshot);
    assert_eq!(stable_row(services.views.get_row(owner, id, row.row.id).await.unwrap().unwrap()),before_row);
    // Hold the exact field row until the writer has passed Application ACL.
    // Moving its Database then must roll back the write in the SQL boundary.
    let foreign_workspace = helpers::create_workspace(&pool, outside).await;
    let mut blocker = pool.begin().await.unwrap();
    let blocker_pid:i32=sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut *blocker).await.unwrap();
    sqlx::query("SELECT id FROM workspace_database_fields WHERE id=$1 FOR UPDATE").bind(notes_id).fetch_one(&mut *blocker).await.unwrap();
    let concurrent_state=build_tool_state(&pool);let concurrent_auth=manager_auth.clone();
    let contested=json!({"database_id":id,"field_id":notes_id,"name":"must not cross Workspace","expected_edit_revision":notes["edit_revision"],"idempotency_key":"workspace-race"});
    // Seed a negative snapshot before polling the writer; removing the refresh
    // must fail even when the first concurrent observation would see the lock.
    sqlx::query("SELECT pid FROM pg_stat_activity").fetch_all(&mut *blocker).await.unwrap();
    let writer=dispatch_tool("database_field_update",&contested,&concurrent_auth,&concurrent_state);
    // Joined futures cancel together on unwind; no writer may outlive cleanup.
    let scope_change=async {
    let waiting=wait_for_database_writer(&mut blocker,blocker_pid,"workspace_database_fields").await;
    if !waiting {blocker.rollback().await.unwrap();panic!("writer did not reach owned row lock");}
    sqlx::query("UPDATE workspace_databases SET workspace_id=$2 WHERE id=$1").bind(id).bind(foreign_workspace).execute(&mut *blocker).await.unwrap();
    blocker.commit().await.unwrap();
    };
    let (rejected,())=tokio::join!(writer,scope_change);
    // Restore the fault-injected scope before checking content or rethrowing.
    sqlx::query("UPDATE workspace_databases SET workspace_id=$2 WHERE id=$1").bind(id).bind(workspace).execute(&pool).await.unwrap();
    rejected.expect_err("a Database moved after authorization must reject the field write");
    assert_eq!(serde_json::to_value(services.definition.get_database(owner,id).await.unwrap().fields).unwrap(),snapshot["fields"]);
    let current = services.definition.get_database(owner, id).await.unwrap();
    let ids: Vec<_> = current.fields.iter().rev().map(|field|field.id).collect();
    let revisions: serde_json::Map<String, Value> = current.fields.iter().map(|field|(field.id.to_string(),json!(field.edit_revision))).collect();
    let reorder = json!({"database_id":id,"field_ids":ids,"expected_edit_revisions":revisions,"idempotency_key":"order"});
    let mut invalid = reorder.clone(); invalid["expected_edit_revisions"][notes_id.to_string()] = json!(999);
    dispatch_tool("database_field_reorder",&invalid,&manager_auth,&state).await.expect_err("stale order rolls back every field");
    let mut invalid = reorder.clone(); invalid["field_ids"] = json!([notes_id, notes_id]);
    dispatch_tool("database_field_reorder",&invalid,&manager_auth,&state).await.expect_err("duplicate/incomplete order");
    assert_eq!(serde_json::to_value(services.definition.get_database(owner,id).await.unwrap()).unwrap(),snapshot);
    let ordered = assert_database_output("database_field_reorder",&database_wire_result("database_field_reorder",&reorder,&manager_auth,&state).await);
    assert_eq!(assert_database_output("database_field_reorder",&database_wire_result("database_field_reorder",&reorder,&manager_auth,&state).await),ordered);
    assert_eq!(ordered["fields"].as_array().unwrap().iter().map(|field|field["id"].as_str().unwrap().parse::<Uuid>().unwrap()).collect::<Vec<_>>(),ids);
    assert_eq!(stable_row(services.views.get_row(owner,id,row.row.id).await.unwrap().unwrap()),before_row);
    let graph=helpers::gql(&app,session,json!({"query":"query($w:String!,$id:String!,$row:String!){workspace(id:$w){database(databaseId:$id){fields{id name position editRevision config{kind select{options{id name}}}}} databaseRow(databaseId:$id,rowId:$row){row{id} cells{fieldId value{text select relation}}}}}","variables":{"w":workspace,"id":id,"row":row.row.id}})).await;
    assert!(graph.get("errors").is_none(),"{graph}");
    let fields = graph["data"]["workspace"]["database"]["fields"].as_array().unwrap();
    assert_eq!(fields.iter().map(|field|field["id"].as_str().unwrap().parse::<Uuid>().unwrap()).collect::<Vec<_>>(),ids);
    let selected=fields.iter().find(|field|field["id"]==select["id"]).unwrap();
    assert_eq!(selected["config"]["select"]["options"][0]["name"],"In progress");
    let cells = graph["data"]["workspace"]["databaseRow"]["cells"].as_array().unwrap();
    assert_eq!(cells.iter().find(|cell|cell["fieldId"]==select["id"]).unwrap()["value"]["select"],"open");
    assert_eq!(cells.iter().find(|cell|cell["fieldId"]==notes["id"]).unwrap()["value"]["text"],"retained text");
    assert_eq!(cells.iter().find(|cell|cell["fieldId"]==relation["id"]).unwrap()["value"]["relation"],json!([target_row.row.id]));
    let current = services.definition.get_database(owner,id).await.unwrap();
    let field=current.fields.iter().find(|field|field.id==select_id).unwrap();
    let delete=json!({"database_id":id,"field_id":select_id,"expected_edit_revision":field.edit_revision,"idempotency_key":"remove-select"});
    let removed=assert_database_output("database_field_delete",&database_wire_result("database_field_delete",&delete,&manager_auth,&state).await);
    assert_eq!(assert_database_output("database_field_delete",&database_wire_result("database_field_delete",&delete,&manager_auth,&state).await),removed);
    let after=services.views.get_row(owner,id,row.row.id).await.unwrap().unwrap();
    assert!(!after.cells.iter().any(|cell|cell.field_id==select_id));
    for field in [notes_id,relation_id] {assert_eq!(after.cells.iter().find(|cell|cell.field_id==field).unwrap().value,row.cells.iter().find(|cell|cell.field_id==field).unwrap().value);}
    let graph=helpers::gql(&app,session,json!({"query":"query($w:String!,$id:String!){workspace(id:$w){database(databaseId:$id){fields{id}}}}","variables":{"w":workspace,"id":id}})).await;
    assert!(graph.get("errors").is_none(),"{graph}");
    assert!(!graph["data"]["workspace"]["database"]["fields"].as_array().unwrap().iter().any(|field|field["id"]==select["id"]));
    sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(manager).execute(&pool).await.unwrap();
    for (tool,params) in [("database_field_create",&create),("database_field_update",&update),("database_field_reorder",&reorder),("database_field_delete",&delete)] {assert_eq!(dispatch_tool(tool,params,&manager_auth,&state).await.expect_err("completed field receipts require current authority").0,-32003);}
    let audit:Value=sqlx::query_scalar("SELECT coalesce(json_agg(row_to_json(a)),'[]') FROM admin_audit_log a WHERE actor_user_id=$1 AND event_key LIKE 'mcp.database.field.%'").bind(manager).fetch_one(&pool).await.unwrap();
    assert!(!audit.as_array().unwrap().is_empty());assert!(!audit.to_string().contains("In progress"));assert!(!audit.to_string().contains("retained text"));
    let mut bounded = build_tool_state(&pool); bounded.document_export_max_bytes = 200;
    let uncertain = json!({"database_id":id,"name":"Ambiguous readback","field_type":"text","idempotency_key":"uncertain-field"});
    let error = dispatch_tool("database_field_create",&uncertain,&auth,&bounded).await.expect_err("committed field exceeds readback bound");assert!(error.1.starts_with("MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED_UNCERTAIN"));
    let error = dispatch_tool("database_field_create",&uncertain,&auth,&state).await.expect_err("same key must not duplicate unknown field effects");assert!(error.1.starts_with("MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED_UNCERTAIN"));
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM workspace_database_fields WHERE database_id=$1 AND name='Ambiguous readback'").bind(id).fetch_one(&pool).await.unwrap(),1);
  }).catch_unwind().await;
  let users = [owner, manager, reader, outside];
  let owned_workspaces: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM workspaces WHERE owner_user_id=ANY($1)")
    .bind(&users[..])
    .fetch_all(&pool)
    .await
    .expect("inventory every owned field fixture workspace");
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=ANY($1)")
    .bind(&users[..])
    .execute(&pool)
    .await
    .expect("remove owned field audit events");
  helpers::cleanup_users(&pool, &users).await;
  let remaining:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=ANY($1)) OR EXISTS(SELECT 1 FROM workspaces WHERE id=ANY($2)) OR EXISTS(SELECT 1 FROM api_keys WHERE user_id=ANY($1)) OR EXISTS(SELECT 1 FROM mcp_idempotency_keys WHERE user_id=ANY($1)) OR EXISTS(SELECT 1 FROM sessions WHERE user_id=ANY($1))").bind(&users[..]).bind(&owned_workspaces[..]).fetch_one(&pool).await.expect("verify field fixture cleanup");
  assert!(!remaining);
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

/// Shared view administration preserves actor overrides and canonical row data.
#[tokio::test]
async fn inv_mcp_database_views_preserve_rows_personal_state_and_current_authority() {
  use futures_util::FutureExt;
  use myoxus_domain::database::{
    DatabaseListDensity, DatabaseListViewConfig, DatabaseSortDirection, DatabaseSortRule, DatabaseViewKind,
  };
  use std::collections::{BTreeMap, HashMap};
  fn row_value(row: myoxus_application::database::DatabaseRowRead) -> Value {
    serde_json::to_value((row.row, row.cells, row.cell_revisions, row.group_keys, row.redacted)).unwrap()
  }
  let (app, pool, store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &store, "mcp-views-owner").await;
  let (manager, _) = helpers::seed_user(&pool, &store, "mcp-views-manager").await;
  let (reader, _) = helpers::seed_user(&pool, &store, "mcp-views-reader").await;
  let (outside, _) = helpers::seed_user(&pool, &store, "mcp-views-outside").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let state = build_tool_state(&pool);
  let outcome=std::panic::AssertUnwindSafe(async {
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'Manager','Accepted'),($1,$3,'Reader','Accepted')").bind(workspace).bind(manager).bind(reader).execute(&pool).await.unwrap();
    let auth=auth_context(&pool,owner).await;let ma=auth_context(&pool,manager).await;let ra=auth_context(&pool,reader).await;let oa=auth_context(&pool,outside).await;
    let ro=McpAuthContext{scopes:vec!["read:databases".into()],..ra.clone()};
    let services=state.database_services.as_ref().unwrap();
    let record=services.definition.create_database(owner,workspace,"Shared views".into(),None,InitialDatabaseViewKind::Table).await.unwrap();
    let id=record.database.id;let title=record.fields[0].id;let original=record.views[0].clone();
    let first=services.editing.create_row(owner,id,Some("Alpha".into()),vec![]).await.unwrap();
    let second=services.editing.create_row(owner,id,Some("Beta".into()),vec![]).await.unwrap();
    let rows_before=(row_value(services.views.get_row(owner,id,first.row.id).await.unwrap().unwrap()),row_value(services.views.get_row(owner,id,second.row.id).await.unwrap().unwrap()));
    let foreign=services.definition.create_database(owner,workspace,"Foreign view references".into(),None,InitialDatabaseViewKind::Table).await.unwrap();
    let initial_snapshot=serde_json::to_value(services.definition.get_database(owner,id).await.unwrap()).unwrap();
    let table_config=serde_json::to_value(&original.config).unwrap();
    let create=json!({"database_id":id,"name":"Table copy","view_kind":"table","config":table_config,"icon":{"kind":"system","value":"table"},"idempotency_key":"table"});
    for denied in [&ra,&ro,&oa] {dispatch_tool("database_view_create",&create,denied,&state).await.expect_err("no write authority");}
    for patch in [json!({"view_kind":"unknown"}),json!({"name":" "}),json!({"config":null}),json!({"icon":{"kind":"emoji","value":"two words"}}),json!({"view_kind":"list"}),json!({"config":{"kind":"table","titleFieldId":title,"unrecognized":true}})] {
      let mut invalid=create.clone();invalid.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());dispatch_tool("database_view_create",&invalid,&auth,&state).await.expect_err("invalid view input");
    }
    assert_eq!(serde_json::to_value(services.definition.get_database(owner,id).await.unwrap()).unwrap(),initial_snapshot);
    let table=assert_database_output("database_view_create",&database_wire_result("database_view_create",&create,&ma,&state).await)["view"].clone();
    assert_eq!(assert_database_output("database_view_create",&database_wire_result("database_view_create",&create,&ma,&state).await)["view"],table);
    let table_id:Uuid=table["id"].as_str().unwrap().parse().unwrap();
    let list_config=serde_json::to_value(DatabaseViewConfig::List(DatabaseListViewConfig{title_field_id:title,visible_field_ids:vec![title],sort:vec![],filter:vec![DatabaseFilterRule{field_id:title,operator:DatabaseFilterOperator::Contains,value:DatabaseFilterValue::Text("Alpha".into())}],filter_tree:None,density:DatabaseListDensity::Default,show_field_labels:true,group:None,subgroup:None})).unwrap();
    let list_create=json!({"database_id":id,"name":"List copy","view_kind":"list","config":list_config,"idempotency_key":"list"});
    let list=assert_database_output("database_view_create",&database_wire_result("database_view_create",&list_create,&ma,&state).await)["view"].clone();let list_id:Uuid=list["id"].as_str().unwrap().parse().unwrap();
    let personal=services.views.upsert_view_user_state(reader,id,table_id,"Beta".into(),Some(vec![DatabaseSortRule{field_id:title,direction:DatabaseSortDirection::Desc}]),None,BTreeMap::from([(title,275)]),vec!["retained-personal".into()],None).await.unwrap();
    // Another actor's override must never leak into this read projection.
    let owner_effective=assert_database_output("database_view_get",&database_wire_result("database_view_get",&json!({"database_id":id,"view_id":table_id}),&auth,&state).await);
    assert_eq!(owner_effective["searchText"],"");assert!(owner_effective["canEditShared"].as_bool().unwrap());
    let effective=assert_database_output("database_view_get",&database_wire_result("database_view_get",&json!({"database_id":id,"view_id":table_id}),&ro,&state).await);
    let descriptor=myoxus_mcp::tool_registry::tools().iter().find(|tool|tool.name=="database_view_get").unwrap();
    let mut invalid_effective=effective.clone();invalid_effective["effectiveFilterTree"]=json!("invalid tree");assert!(!output_schema_test_support::projection_schema_accepts(&descriptor.output_schema,&descriptor.output_schema,&invalid_effective));
    assert_eq!(effective["view"],table);assert_eq!(effective["searchText"],"Beta");assert_eq!(effective["effectiveFieldWidths"][title.to_string()],275);assert_eq!(effective["canEditShared"],false);assert_eq!(effective["effectiveSort"][0]["direction"],"desc");
    dispatch_tool("database_view_get",&json!({"database_id":id,"view_id":table_id}),&oa,&state).await.expect_err("outside read");
    dispatch_tool("database_view_get",&json!({"database_id":id,"view_id":foreign.views[0].id}),&auth,&state).await.expect_err("foreign view read");
    let mut next=table_config.clone();next["fieldWidths"]=json!({title.to_string():180});next["sort"]=json!([{"fieldId":title,"direction":"asc"}]);
    let update=json!({"database_id":id,"view_id":table_id,"name":"Updated shared table","config":next,"icon":null,"expected_edit_revision":table["edit_revision"],"idempotency_key":"update"});
    let updated=assert_database_output("database_view_update",&database_wire_result("database_view_update",&update,&ma,&state).await)["view"].clone();
    assert_eq!(updated["edit_revision"].as_i64().unwrap(),table["edit_revision"].as_i64().unwrap()+1);assert!(updated["icon"].is_null());
    assert_eq!(assert_database_output("database_view_update",&database_wire_result("database_view_update",&update,&ma,&state).await)["view"],updated);
    let mut icon_omitted=update.clone();icon_omitted.as_object_mut().unwrap().remove("icon");dispatch_tool("database_view_update",&icon_omitted,&ma,&state).await.expect_err("null and omission have distinct semantic hashes");
    let snapshot=serde_json::to_value(services.definition.get_database(owner,id).await.unwrap()).unwrap();
    let mut foreign_config=table_config.clone();foreign_config["titleFieldId"]=json!(foreign.fields[0].id);
    for invalid in [json!({"database_id":id,"view_id":table_id,"name":"stale","expected_edit_revision":table["edit_revision"],"idempotency_key":"stale"}),json!({"database_id":id,"view_id":foreign.views[0].id,"name":"foreign","expected_edit_revision":1,"idempotency_key":"foreign"}),json!({"database_id":id,"view_id":table_id,"config":foreign_config,"expected_edit_revision":updated["edit_revision"],"idempotency_key":"foreign-config"}),json!({"database_id":id,"view_id":table_id,"view_kind":"list","expected_edit_revision":updated["edit_revision"],"idempotency_key":"mismatched-retained-config"})] {dispatch_tool("database_view_update",&invalid,&ma,&state).await.expect_err("stale/foreign/invalid config refusal");}
    assert_eq!(serde_json::to_value(services.definition.get_database(owner,id).await.unwrap()).unwrap(),snapshot);
    // The same retained-config invariant also protects GraphQL/direct callers.
    assert!(services.views.update_view_with_precondition(owner,id,table_id,None,Some(DatabaseViewKind::List),None,Some(updated["edit_revision"].as_i64().unwrap()),false).await.is_err());
    let effective_after=services.views.effective_view_state(reader,id,table_id).await.unwrap();assert_eq!(effective_after.personal_state.as_ref(),Some(&personal));assert_eq!(effective_after.effective_field_widths[&title],275);
    for view in [table_id,list_id] {
      let query=assert_database_output("database_query",&database_wire_result("database_query",&json!({"database_id":id,"view_id":view,"limit":10}),&auth,&state).await);
      assert_eq!(query["rows"].as_array().unwrap().len(),if view == table_id {2} else {1});
      if view == list_id {assert_eq!(query["rows"][0]["row"]["id"],first.row.id.to_string());}
    }
    let reader_query=assert_database_output("database_query",&database_wire_result("database_query",&json!({"database_id":id,"view_id":table_id,"limit":10}),&ro,&state).await);assert_eq!(reader_query["rows"].as_array().unwrap().len(),1);assert_eq!(reader_query["rows"][0]["row"]["id"],second.row.id.to_string());
    let kind_change=json!({"database_id":id,"view_id":list_id,"view_kind":"table","config":table_config,"expected_edit_revision":list["edit_revision"],"idempotency_key":"kind-change"});
    let converted=assert_database_output("database_view_update",&database_wire_result("database_view_update",&kind_change,&ma,&state).await);assert_eq!(converted["view"]["view_kind"],"table");
    // Replaying the original create must not revalidate against its changed kind.
    assert_eq!(assert_database_output("database_view_create",&database_wire_result("database_view_create",&list_create,&ma,&state).await)["view"],list);
    assert_eq!(assert_database_output("database_view_get",&database_wire_result("database_view_get",&json!({"database_id":id,"view_id":list_id}),&auth,&state).await)["view"]["view_kind"],"table");
    let current=services.definition.get_database(owner,id).await.unwrap();let ids:Vec<_>=current.views.iter().rev().map(|view|view.id).collect();let revisions:HashMap<_,_>=current.views.iter().map(|view|(view.id,view.edit_revision)).collect();
    let order=json!({"database_id":id,"view_ids":ids,"expected_edit_revisions":revisions,"idempotency_key":"order"});
    let mut stale_order=order.clone();stale_order["expected_edit_revisions"][table_id.to_string()]=json!(999);dispatch_tool("database_view_reorder",&stale_order,&ma,&state).await.expect_err("SQL revision refusal");
    let mut partial=order.clone();partial["view_ids"]=json!([table_id]);dispatch_tool("database_view_reorder",&partial,&ma,&state).await.expect_err("partial revision map refusal");
    assert_eq!(serde_json::to_value(services.definition.get_database(owner,id).await.unwrap()).unwrap(),serde_json::to_value(&current).unwrap());
    let ordered=assert_database_output("database_view_reorder",&database_wire_result("database_view_reorder",&order,&ma,&state).await);assert_eq!(assert_database_output("database_view_reorder",&database_wire_result("database_view_reorder",&order,&ma,&state).await),ordered);assert_eq!(ordered["views"].as_array().unwrap().iter().map(|v|v["id"].as_str().unwrap().parse::<Uuid>().unwrap()).collect::<Vec<_>>(),ids);
    let gql=helpers::gql(&app,session,json!({"query":"query($w:String!,$id:String!){workspace(id:$w){database(databaseId:$id){views{id name position editRevision viewKind icon{system emoji}}}}}","variables":{"w":workspace,"id":id}})).await;assert!(gql.get("errors").is_none(),"{gql}");assert_eq!(gql["data"]["workspace"]["database"]["views"].as_array().unwrap().iter().map(|v|v["id"].as_str().unwrap().parse::<Uuid>().unwrap()).collect::<Vec<_>>(),ids);
    let row1=services.views.get_row(owner,id,first.row.id).await.unwrap().unwrap();let row2=services.views.get_row(owner,id,second.row.id).await.unwrap().unwrap();assert_eq!((row_value(row1),row_value(row2)),rows_before);
    // Reuse the two-connection race observation without a third pool checkout.
    let foreign_workspace=helpers::create_workspace(&pool,outside).await;let mut blocker=pool.begin().await.unwrap();let blocker_pid:i32=sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut *blocker).await.unwrap();sqlx::query("SELECT id FROM workspace_database_views WHERE id=$1 FOR UPDATE").bind(table_id).fetch_one(&mut *blocker).await.unwrap();
    let moved_state=build_tool_state(&pool);let moved_auth=ma.clone();let contested=json!({"database_id":id,"view_id":table_id,"name":"forbidden scope write","expected_edit_revision":ordered["views"].as_array().unwrap().iter().find(|v|v["id"]==table_id.to_string()).unwrap()["edit_revision"],"idempotency_key":"scope-race"});
    sqlx::query("SELECT pid FROM pg_stat_activity").fetch_all(&mut *blocker).await.unwrap();
    let writer=dispatch_tool("database_view_update",&contested,&moved_auth,&moved_state);let scope_change=async {
      let waiting=wait_for_database_writer(&mut blocker,blocker_pid,"workspace_database_views").await;
      if !waiting {blocker.rollback().await.unwrap();panic!("view writer did not reach owned row lock");}
      sqlx::query("UPDATE workspace_databases SET workspace_id=$2 WHERE id=$1").bind(id).bind(foreign_workspace).execute(&mut *blocker).await.unwrap();blocker.commit().await.unwrap();
    };let (rejected,())=tokio::join!(writer,scope_change);sqlx::query("UPDATE workspace_databases SET workspace_id=$2 WHERE id=$1").bind(id).bind(workspace).execute(&pool).await.unwrap();rejected.expect_err("Workspace-bound update must roll back");
    assert_eq!(serde_json::to_value(services.definition.get_database(owner,id).await.unwrap().views).unwrap(),ordered["views"]);
    let disposable=ordered["views"].as_array().unwrap().iter().find(|view|view["id"]==list_id.to_string()).unwrap();let delete=json!({"database_id":id,"view_id":list_id,"expected_edit_revision":disposable["edit_revision"],"idempotency_key":"delete"});
    let deleted=assert_database_output("database_view_delete",&database_wire_result("database_view_delete",&delete,&ma,&state).await);assert_eq!(deleted["deleted"],true);assert_eq!(assert_database_output("database_view_delete",&database_wire_result("database_view_delete",&delete,&ma,&state).await),deleted);
    assert_eq!(services.views.effective_view_state(reader,id,table_id).await.unwrap().personal_state.as_ref(),Some(&personal));
    let row1=services.views.get_row(owner,id,first.row.id).await.unwrap().unwrap();let row2=services.views.get_row(owner,id,second.row.id).await.unwrap().unwrap();assert_eq!((row_value(row1),row_value(row2)),rows_before);
    sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(manager).execute(&pool).await.unwrap();
    for (tool,args) in [("database_view_create",create),("database_view_update",update),("database_view_reorder",order),("database_view_delete",delete)] {dispatch_tool(tool,&args,&ma,&state).await.expect_err("downgrade denies completed replay");}
    let audit:Value=sqlx::query_scalar("SELECT coalesce(jsonb_agg(metadata),'[]'::jsonb) FROM admin_audit_log WHERE actor_user_id=$1 AND event_key LIKE 'mcp.database.view.%'").bind(manager).fetch_one(&pool).await.unwrap();assert_ne!(audit,json!([]));assert!(!audit.to_string().contains("Updated shared table"));assert!(!audit.to_string().contains("Beta"));
  }).catch_unwind().await;
  let users = [owner, manager, reader, outside];
  let workspaces: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM workspaces WHERE owner_user_id=ANY($1)")
    .bind(&users[..])
    .fetch_all(&pool)
    .await
    .expect("inventory owned view workspaces");
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=ANY($1)")
    .bind(&users[..])
    .execute(&pool)
    .await
    .expect("remove owned view audits");
  helpers::cleanup_users(&pool, &users).await;
  let remaining:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=ANY($1)) OR EXISTS(SELECT 1 FROM workspaces WHERE id=ANY($2)) OR EXISTS(SELECT 1 FROM api_keys WHERE user_id=ANY($1)) OR EXISTS(SELECT 1 FROM mcp_idempotency_keys WHERE user_id=ANY($1)) OR EXISTS(SELECT 1 FROM sessions WHERE user_id=ANY($1))").bind(&users[..]).bind(&workspaces[..]).fetch_one(&pool).await.expect("verify view fixture cleanup");
  assert!(!remaining);
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

/// Persisted run states and real queue metadata remain content-free on MCP reads.
#[tokio::test]
async fn inv_mcp_automation_inventory_is_read_only_scoped_and_content_free() {
  use futures_util::FutureExt;
  use myoxus_application::workspace_automation::{WorkspaceAutomationLimits, WorkspaceAutomationService};
  use myoxus_domain::repositories::PageRequest;
  use myoxus_domain::workspace_automation::*;
  use std::sync::Mutex;
  #[derive(Default)]
  struct Queue {
    jobs: Mutex<Vec<String>>,
  }
  #[async_trait::async_trait]
  impl myoxus_application::worker::WorkQueuePort for Queue {
    async fn add_job(
      &self,
      _queue: &str,
      _name: &str,
      _data: Value,
      _attempts: Option<u32>,
      _delay: Option<i64>,
    ) -> myoxus_application::auth::AuthResult<String> {
      let id = Uuid::new_v4().to_string();
      self.jobs.lock().unwrap().push(id.clone());
      Ok(id)
    }
  }
  let (app, pool, store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &store, "mcp-automation-owner").await;
  let (reader, _) = helpers::seed_user(&pool, &store, "mcp-automation-reader").await;
  let (outside, _) = helpers::seed_user(&pool, &store, "mcp-automation-outside").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let outcome=std::panic::AssertUnwindSafe(async {
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'Reader','Accepted')").bind(workspace).bind(reader).execute(&pool).await.unwrap();
    let mut state=build_tool_state(&pool);
    let repo=Arc::new(myoxus_infrastructure::workspace_automation::PgWorkspaceAutomationRepository::new(pool.clone()));
    let database_repo=Arc::new(PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog()));
    let queue=Arc::new(Queue::default());
    let service=WorkspaceAutomationService::new(
      repo.clone(),
      database_repo.clone(),
      database_repo.clone(),
      state.doc_service.clone(),
      state.permission_service.clone(),
      AuditRecorder::new(Arc::new(PgAuditLogStore::new(pool.clone()))),
      Some(queue.clone()),
      None,
      WorkspaceAutomationLimits::default(),
      state.database_services.as_ref().unwrap().editing.clone(),
    );
    let runtime=Arc::new(myoxus_infrastructure::workflow_runtime::GlirulusWorkspaceAutomationRuntime::new(pool.clone(),service.native_executor()));
    let service=Arc::new(service.with_runtime(runtime));
    state.workspace_automation_service=Some(service.clone());
    let record=state.database_services.as_ref().unwrap().definition.create_database(owner,workspace,"Automation source".into(),None,InitialDatabaseViewKind::Table).await.unwrap();
    let row=state.database_services.as_ref().unwrap().editing.create_row(owner,record.database.id,Some("Private source content".into()),vec![]).await.unwrap();
    let trigger=WorkspaceAutomationTrigger {trigger_type:WorkspaceAutomationTriggerType::RowCreated,database_id:record.database.id,field_id:None,select_option_id:None};
    let success=service.create_automation(owner,workspace,"Follow-up".into(),Some("private description".into()),trigger.clone(),vec![WorkspaceAutomationActionDefinition {position:0,config:WorkspaceAutomationActionConfig::CreateRow {database_id:record.database.id,title_template:Some("private action content".into()),cells:vec![]}}]).await.unwrap();
    let failure=service.create_automation(owner,workspace,"Webhook".into(),None,trigger,vec![WorkspaceAutomationActionDefinition {position:0,config:WorkspaceAutomationActionConfig::NotifyWebhook {url:"https://example.invalid/private-token".into(),secret_ref:Some("private credential".into())}}]).await.unwrap();
    let event=WorkspaceAutomationTriggerEvent {workspace_id:workspace,database_id:record.database.id,row_id:row.row.id,trigger_type:WorkspaceAutomationTriggerType::RowCreated,actor_user_id:Some(owner),field_id:None,old_value:None,new_value:None,row_content_document_id:None,occurred_at:chrono::Utc::now()};
    assert_eq!(service.enqueue_database_event(event.clone()).await.unwrap().enqueued_count,2);
    let runs=service.list_runs(owner,workspace,None,true,PageRequest{limit:50,offset:0}).await.unwrap();
    assert_eq!(runs.len(),2);
    for run in &runs {assert!(queue.jobs.lock().unwrap().contains(run.job_id.as_ref().unwrap()));assert_eq!(run.status,WorkspaceAutomationRunStatus::Queued);}
    let successful=runs.iter().find(|r|r.automation_id==Some(success.id)).unwrap();
    let failed=runs.iter().find(|r|r.automation_id==Some(failure.id)).unwrap();
    let mut auth=auth_context(&pool,reader).await;auth.scopes=vec!["read:automations".into()];
    sqlx::query("UPDATE api_keys SET scopes=$2 WHERE id=$1").bind(auth.key_id).bind(&auth.scopes).execute(&pool).await.unwrap();
    let get=|id|json!({"run_id":id});
    let queued=assert_database_output("automation_run_get",&database_wire_result("automation_run_get",&get(successful.id),&auth,&state).await);
    assert_eq!(queued["run"]["status"],"queued");assert_eq!(queued["run"]["jobId"],successful.job_id.as_ref().unwrap().as_str());
    // Execution is covered by the native Database/worker owner. This consuming
    // MCP check supplies terminal fixtures and verifies only authorized projection.
    sqlx::query("UPDATE workspace_automation_runs SET status='succeeded',attempt_count=attempt_count+1,started_at=now(),finished_at=now(),error_code=NULL,error_message=NULL,dead_letter=false WHERE id=$1")
      .bind(successful.id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE workspace_automation_runs SET status='failed',attempt_count=attempt_count+1,started_at=now(),finished_at=now(),error_code='MIX_AUTOMATION_WEBHOOK_FAILED',error_message='private remote response',dead_letter=false WHERE id=$1")
      .bind(failed.id).execute(&pool).await.unwrap();
    let failure_read=assert_database_output("automation_run_get",&database_wire_result("automation_run_get",&get(failed.id),&auth,&state).await);
    assert_eq!(failure_read["run"]["status"],"failed");assert!(failure_read["run"]["errorSummary"].is_string());
    sqlx::query("UPDATE workspace_automation_runs SET error_code='private-error-code',error_message='private webhook URL and credential' WHERE id=$1").bind(failed.id).execute(&pool).await.unwrap();
    let sanitized=assert_database_output("automation_run_get",&database_wire_result("automation_run_get",&get(failed.id),&auth,&state).await);
    assert_eq!(sanitized["run"]["errorCode"],"MIX_AUTOMATION_RUN_FAILED");assert!(!sanitized.to_string().contains("private"));
    sqlx::query("UPDATE workspace_automation_runs SET status='dead_letter',attempt_count=5,dead_letter=true WHERE id=$1").bind(failed.id).execute(&pool).await.unwrap();
    let dead=assert_database_output("automation_run_get",&database_wire_result("automation_run_get",&get(failed.id),&auth,&state).await);
    assert_eq!(dead["run"]["status"],"dead_letter");assert_eq!(dead["run"]["attemptCount"],5);assert_eq!(dead["run"]["deadLetter"],true);
    let inventory=assert_database_output("automation_list",&database_wire_result("automation_list",&json!({"workspace_id":workspace,"limit":1}),&auth,&state).await);
    assert_eq!(inventory["automations"].as_array().unwrap().len(),1);assert_eq!(inventory["has_more"],true);assert_eq!(inventory["next_offset"],1);
    let page=assert_database_output("automation_list",&database_wire_result("automation_list",&json!({"workspace_id":workspace,"limit":1,"offset":1}),&auth,&state).await);
    assert_ne!(page["automations"][0]["id"],inventory["automations"][0]["id"]);assert_eq!(page["next_offset"],Value::Null);
    let count=queue.jobs.lock().unwrap().len();
    for name in ["automation_run_list","automation_dead_letter_list"] {
      let result=assert_database_output(name,&database_wire_result(name,&json!({"workspace_id":workspace}),&auth,&state).await);
      assert_eq!(result["runs"].as_array().unwrap().len(),1);
      let text=result.to_string();for sensitive in ["triggerEvent","errorMessage","private","secret","config","idempotencyKey"] {assert!(!text.contains(sensitive));}
    }
    let list=assert_database_output("automation_run_list",&database_wire_result("automation_run_list",&json!({"workspace_id":workspace,"include_dead_letter":true}),&auth,&state).await);assert_eq!(list["runs"].as_array().unwrap().len(),2);
    let foreign_workspace=helpers::create_workspace(&pool,outside).await;
    let foreign_record=state.database_services.as_ref().unwrap().definition.create_database(outside,foreign_workspace,"Foreign automation".into(),None,InitialDatabaseViewKind::Table).await.unwrap();
    let foreign_automation=service.create_automation(outside,foreign_workspace,"Foreign automation".into(),None,WorkspaceAutomationTrigger{database_id:foreign_record.database.id,..success.trigger.clone()},vec![WorkspaceAutomationActionDefinition{position:0,config:WorkspaceAutomationActionConfig::CreateRow{database_id:foreign_record.database.id,title_template:None,cells:vec![]}}]).await.unwrap();
    let foreign=assert_database_output("automation_run_list",&database_wire_result("automation_run_list",&json!({"workspace_id":workspace,"automation_id":foreign_automation.id}),&auth,&state).await);assert_eq!(foreign["runs"],json!([]));
    let gql=helpers::gql(&app,session,json!({"query":"query($id:String!){workspace(id:$id){automationRuns(includeDeadLetter:true){id status attemptCount deadLetter}}}","variables":{"id":workspace}})).await;
    assert!(gql.get("errors").is_none());let graph=gql["data"]["workspace"]["automationRuns"].as_array().unwrap();assert_eq!(graph.len(),2);assert!(graph.iter().any(|r|r["id"]==failed.id.to_string()&&r["status"]=="DeadLetter"&&r["attemptCount"]==5));
    assert_eq!(dispatch_tool("automation_run_retry",&json!({"run_id":failed.id,"idempotency_key":"no-write"}),&auth,&state).await.unwrap_err().0,-32003);
    for scopes in [vec![],vec!["write:automations".into()]] {let denied=McpAuthContext{scopes,..auth.clone()};for name in ["automation_list","automation_run_list","automation_run_get","automation_dead_letter_list"] {let params=if name=="automation_run_get" {get(failed.id)} else {json!({"workspace_id":workspace})};assert_eq!(dispatch_tool(name,&params,&denied,&state).await.unwrap_err().0,-32003);}}
    let denied=McpAuthContext{user_id:outside,..auth.clone()};
    for name in ["automation_list","automation_run_list","automation_run_get","automation_dead_letter_list"] {
      let params=if name=="automation_run_get" {get(failed.id)} else {json!({"workspace_id":workspace})};
      assert_eq!(dispatch_tool(name,&params,&denied,&state).await.unwrap_err().0,-32003);
    }
    assert_eq!(dispatch_tool("automation_run_get",&get(Uuid::new_v4()),&auth,&state).await.unwrap_err().0,-32004);
    let mut bounded=state.clone();bounded.document_export_max_bytes=100;
    assert_eq!(dispatch_tool("automation_run_get",&get(failed.id),&auth,&bounded).await.unwrap_err().0,-32002);
    for invalid in [json!({"workspace_id":workspace,"limit":0}),json!({"workspace_id":workspace,"limit":201}),json!({"workspace_id":workspace,"limit":null}),json!({"workspace_id":workspace,"offset":-1}),json!({"workspace_id":workspace,"limit":1.5}),json!({"workspace_id":workspace,"unknown":true})] {assert_eq!(dispatch_tool("automation_list",&invalid,&auth,&state).await.unwrap_err().0,-32602);}
    assert_eq!(queue.jobs.lock().unwrap().len(),count,"reading or denied retry enqueued a job");
    sqlx::query("UPDATE workspace_automation_runs SET job_id=NULL WHERE id=$1").bind(failed.id).execute(&pool).await.unwrap();
    // An unavailable optional Redis wake identity stays null; no queue scan manufactures IDs.
    let without_wake=assert_database_output("automation_run_get",&database_wire_result("automation_run_get",&get(failed.id),&auth,&state).await);assert_eq!(without_wake["run"]["jobId"],Value::Null);
    sqlx::query("UPDATE workspace_memberships SET role='External' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(reader).execute(&pool).await.unwrap();
    // External retains Workspace Read in the canonical role model. Removing
    // membership, rather than changing its name, withdraws this capability.
    assert_database_output("automation_run_get",&database_wire_result("automation_run_get",&get(successful.id),&auth,&state).await);
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(reader).execute(&pool).await.unwrap();
    for name in ["automation_list","automation_run_list","automation_run_get","automation_dead_letter_list"] {
      let params=if name=="automation_run_get" {get(successful.id)} else {json!({"workspace_id":workspace})};
      assert_eq!(dispatch_tool(name,&params,&auth,&state).await.unwrap_err().0,-32003);
    }
  }).catch_unwind().await;
  let users = [owner, reader, outside];
  let workspaces: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM workspaces WHERE owner_user_id=ANY($1)")
    .bind(&users[..])
    .fetch_all(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=ANY($1)")
    .bind(&users[..])
    .execute(&pool)
    .await
    .unwrap();
  helpers::cleanup_users(&pool, &users).await;
  let remaining:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=ANY($1)) OR EXISTS(SELECT 1 FROM workspaces WHERE id=ANY($2)) OR EXISTS(SELECT 1 FROM api_keys WHERE user_id=ANY($1)) OR EXISTS(SELECT 1 FROM mcp_idempotency_keys WHERE user_id=ANY($1)) OR EXISTS(SELECT 1 FROM sessions WHERE user_id=ANY($1))").bind(&users[..]).bind(&workspaces[..]).fetch_one(&pool).await.unwrap();
  assert!(!remaining);
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
