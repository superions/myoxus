//! Causal MCP coverage for bounded workspace Tag reads.

use std::sync::Arc;

use myoxus_application::doc::DocService;
use myoxus_application::permission::PermissionService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_application::workspace_tags::WorkspaceTagService;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_infrastructure::workspace_tags::PgWorkspaceTagRepository;
use myoxus_mcp::auth::McpAuthContext;
use myoxus_mcp::tools::{McpToolState, dispatch_tool};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::helpers;

fn build_tool_state(pool: &sqlx::PgPool) -> (McpToolState, Arc<WorkspaceTagService>) {
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let permission = Arc::new(PermissionService::new(auth_store));
  let tag_service = Arc::new(WorkspaceTagService::new(
    Arc::new(PgWorkspaceTagRepository::new(
      pool.clone(),
      crate::helpers::database_starter_catalog(),
    )),
    permission.clone(),
  ));
  (
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
      permission_service: permission,
      search_indexer: None,
      search_repository: None,
      assistant_packages: None,
      database_services: None,
      calendar: None,
      organization: None,
      users: None,
      workspace_tag_service: Some(tag_service.clone()),
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
      document_cursor_signing_key: Arc::from(&b"mcp-workspace-tag-test-cursor-key"[..]),
      document_export_max_bytes: 8 * 1024 * 1024,
    },
    tag_service,
  )
}

fn auth(user_id: Uuid) -> McpAuthContext {
  auth_with_scopes(user_id, &["read:docs"])
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
     VALUES ($1, $2, 'mcp-workspace-tag-test', $3, $4)",
  )
  .bind(auth.key_id)
  .bind(auth.user_id)
  .bind(format!("mcp-workspace-tag-test-{}", auth.key_id))
  .bind(&auth.scopes)
  .execute(pool)
  .await
  .expect("insert MCP workspace Tag test API key");
}

fn payload(response: Value) -> Value {
  serde_json::from_str(response["content"][0]["text"].as_str().expect("MCP content text"))
    .expect("structured MCP response")
}

#[tokio::test]
async fn inv_mcp_workspace_tag_reads_are_bounded_ordered_acl_scoped_and_external() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-tag-owner").await;
  let (reader_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-tag-reader").await;
  let (outsider_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-tag-outsider").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let other_workspace_id = helpers::create_workspace(&pool, owner_id).await;
  helpers::add_workspace_member(&pool, workspace_id, reader_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let external_id = format!("mcp-tag-doc-{}", Uuid::new_v4());
  sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
    .bind(doc_id)
    .bind(&external_id)
    .execute(&pool)
    .await
    .expect("set distinct external document key");
  let (state, tags) = build_tool_state(&pool);

  let alpha = tags
    .create_tag(
      owner_id,
      workspace_id,
      "Alpha",
      "tag.blue",
      Some("Archived Tag".to_string()),
    )
    .await
    .expect("create Alpha Tag");
  let beta = tags
    .create_tag(owner_id, workspace_id, "Beta", "tag.green", None)
    .await
    .expect("create Beta Tag");
  let gamma = tags
    .create_tag(owner_id, workspace_id, "Gamma", "tag.red", None)
    .await
    .expect("create Gamma Tag");
  tags
    .archive_tag(owner_id, workspace_id, alpha.id)
    .await
    .expect("archive Alpha Tag");
  tags
    .set_document_tags(owner_id, workspace_id, doc_id, &[gamma.id, beta.id])
    .await
    .expect("assign Tags in explicit order");

  let reader_auth = auth(reader_id);
  let first_page = payload(
    dispatch_tool(
      "workspace_tag_list",
      &json!({ "workspace_id": workspace_id, "limit": 1 }),
      &reader_auth,
      &state,
    )
    .await
    .expect("Reader lists active Tags"),
  );
  assert_eq!(
    first_page["items"],
    json!([{
      "id": beta.id, "name": "Beta", "colorRole": "tag.green", "archived": false
    }])
  );
  assert_eq!(first_page["nextOffset"], 1);
  assert!(first_page["items"][0].get("slug").is_none());

  let second_page = payload(
    dispatch_tool(
      "workspace_tag_list",
      &json!({ "workspace_id": workspace_id, "offset": 1, "limit": 1 }),
      &reader_auth,
      &state,
    )
    .await
    .expect("Reader advances bounded Tag pagination"),
  );
  assert_eq!(second_page["items"][0]["id"], gamma.id.to_string());
  assert_eq!(second_page["nextOffset"], Value::Null);

  let with_archived = payload(
    dispatch_tool(
      "workspace_tag_list",
      &json!({ "workspace_id": workspace_id, "include_archived": true }),
      &reader_auth,
      &state,
    )
    .await
    .expect("Reader explicitly includes archived Tags"),
  );
  assert_eq!(with_archived["items"].as_array().expect("Tag rows").len(), 3);
  assert!(
    with_archived["items"]
      .as_array()
      .unwrap()
      .iter()
      .any(|tag| tag["id"] == alpha.id.to_string() && tag["archived"] == true)
  );

  let tag = payload(
    dispatch_tool(
      "workspace_tag_get",
      &json!({ "workspace_id": workspace_id, "tag_id": alpha.id }),
      &reader_auth,
      &state,
    )
    .await
    .expect("Reader gets an archived Tag"),
  );
  assert_eq!(tag["description"], "Archived Tag");
  assert!(tag.get("slug").is_none());

  let document_tags = payload(
    dispatch_tool(
      "document_tags_get",
      &json!({ "workspace_id": workspace_id, "external_id": external_id }),
      &reader_auth,
      &state,
    )
    .await
    .expect("Reader gets ordered document Tag assignments"),
  );
  assert_eq!(document_tags["externalId"], external_id);
  assert_eq!(document_tags["tags"][0]["id"], gamma.id.to_string());
  assert_eq!(document_tags["tags"][1]["id"], beta.id.to_string());
  assert!(!document_tags.to_string().contains(&doc_id.to_string()));

  let cross_workspace = dispatch_tool(
    "workspace_tag_get",
    &json!({ "workspace_id": other_workspace_id, "tag_id": beta.id }),
    &auth(owner_id),
    &state,
  )
  .await
  .expect_err("Tag IDs must stay workspace-scoped");
  assert_eq!(cross_workspace.0, -32004);

  let nonmember = dispatch_tool(
    "workspace_tag_list",
    &json!({ "workspace_id": workspace_id }),
    &auth(outsider_id),
    &state,
  )
  .await
  .expect_err("read:docs must not bypass workspace membership");
  assert_eq!(nonmember.0, -32003);

  helpers::cleanup_users(&pool, &[owner_id, reader_id, outsider_id]).await;
}

#[tokio::test]
async fn inv_mcp_workspace_tag_lifecycle_is_service_authorized_idempotent_and_compact() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-tag-write-owner").await;
  let (reader_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-tag-write-reader").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  helpers::add_workspace_member(&pool, workspace_id, reader_id).await;
  sqlx::query("UPDATE workspace_memberships SET role = 'Reader' WHERE workspace_id = $1 AND user_id = $2")
    .bind(workspace_id)
    .bind(reader_id)
    .execute(&pool)
    .await
    .expect("restrict Tag lifecycle test member to Reader");

  let (mut state, tags) = build_tool_state(&pool);
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
  let owner_auth = auth_with_scopes(owner_id, &["read:docs", "write:docs"]);
  persist_auth_key(&pool, &owner_auth).await;

  let create_params = json!({
    "workspace_id": workspace_id,
    "name": "Lifecycle",
    "color_role": "tag.blue",
    "description": "  Initial description  ",
    "idempotency_key": "tag-create-sequential"
  });
  let created_response = dispatch_tool("workspace_tag_create", &create_params, &owner_auth, &state)
    .await
    .expect("create workspace Tag through service");
  let created = payload(created_response.clone());
  let created_id = Uuid::parse_str(created["id"].as_str().expect("created Tag id")).expect("UUID Tag id");
  assert_eq!(
    created,
    json!({
      "id": created_id,
      "name": "Lifecycle",
      "colorRole": "tag.blue",
      "archived": false,
      "description": "Initial description"
    })
  );
  assert!(!created.to_string().contains("tag-create-sequential"));
  assert!(created.get("slug").is_none());
  let sequential_replay = dispatch_tool("workspace_tag_create", &create_params, &owner_auth, &state)
    .await
    .expect("completed create replays durably");
  assert_eq!(payload(sequential_replay), created);

  let same_name = payload(
    dispatch_tool(
      "workspace_tag_create",
      &json!({
        "workspace_id": workspace_id,
        "name": "Lifecycle",
        "color_role": "tag.green",
        "idempotency_key": "tag-create-collision"
      }),
      &owner_auth,
      &state,
    )
    .await
    .expect("server allocates collision suffix"),
  );
  let same_name_id = Uuid::parse_str(same_name["id"].as_str().unwrap()).unwrap();
  let first_internal = tags
    .get_tag(owner_id, workspace_id, created_id)
    .await
    .expect("read first Tag through service")
    .expect("first Tag");
  let second_internal = tags
    .get_tag(owner_id, workspace_id, same_name_id)
    .await
    .expect("read second Tag through service")
    .expect("second Tag");
  assert_eq!(first_internal.slug, "lifecycle");
  assert_eq!(second_internal.slug, "lifecycle-2");

  let concurrent_params = json!({
    "workspace_id": workspace_id,
    "name": "Concurrent",
    "color_role": "tag.teal",
    "idempotency_key": "tag-create-concurrent"
  });
  let (left, right) = tokio::join!(
    dispatch_tool("workspace_tag_create", &concurrent_params, &owner_auth, &state),
    dispatch_tool("workspace_tag_create", &concurrent_params, &owner_auth, &state)
  );
  let concurrent_success = match (left, right) {
    (Ok(left), Ok(right)) => {
      assert_eq!(payload(left.clone()), payload(right));
      left
    }
    (Ok(success), Err(pending)) | (Err(pending), Ok(success)) => {
      assert_eq!(pending.0, -32010);
      assert!(pending.1.contains("MIX_MCP_IDEMPOTENCY_IN_PROGRESS"));
      success
    }
    outcome => panic!("a concurrent create must execute exactly once: {outcome:?}"),
  };
  let concurrent_replay = dispatch_tool("workspace_tag_create", &concurrent_params, &owner_auth, &state)
    .await
    .expect("concurrent caller can replay after completion");
  assert_eq!(payload(concurrent_replay), payload(concurrent_success));
  let concurrent_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM workspace_tags WHERE workspace_id = $1 AND name = 'Concurrent'")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("count concurrent Tags");
  assert_eq!(concurrent_count, 1);

  let renamed = payload(
    dispatch_tool(
      "workspace_tag_rename",
      &json!({
        "workspace_id": workspace_id, "tag_id": created_id,
        "name": "Renamed", "idempotency_key": "tag-rename"
      }),
      &owner_auth,
      &state,
    )
    .await
    .expect("rename workspace Tag"),
  );
  assert_eq!(renamed["name"], "Renamed");

  let invalid_color = dispatch_tool(
    "workspace_tag_recolor",
    &json!({
      "workspace_id": workspace_id, "tag_id": created_id,
      "color_role": "#ffffff", "idempotency_key": "tag-recolor-invalid"
    }),
    &owner_auth,
    &state,
  )
  .await
  .expect_err("unapproved color role must fail before persistence");
  assert_eq!(invalid_color.0, -32602);
  let recolored = payload(
    dispatch_tool(
      "workspace_tag_recolor",
      &json!({
        "workspace_id": workspace_id, "tag_id": created_id,
        "color_role": "tag.purple", "idempotency_key": "tag-recolor"
      }),
      &owner_auth,
      &state,
    )
    .await
    .expect("recolor workspace Tag"),
  );
  assert_eq!(recolored["colorRole"], "tag.purple");

  let described = payload(
    dispatch_tool(
      "workspace_tag_description_update",
      &json!({
        "workspace_id": workspace_id, "tag_id": created_id,
        "description": "  Updated  ", "idempotency_key": "tag-description-update"
      }),
      &owner_auth,
      &state,
    )
    .await
    .expect("update workspace Tag description"),
  );
  assert_eq!(described["description"], "Updated");
  let cleared = payload(
    dispatch_tool(
      "workspace_tag_description_update",
      &json!({
        "workspace_id": workspace_id, "tag_id": created_id,
        "description": null, "idempotency_key": "tag-description-clear"
      }),
      &owner_auth,
      &state,
    )
    .await
    .expect("clear workspace Tag description"),
  );
  assert_eq!(cleared["description"], Value::Null);

  let archived = payload(
    dispatch_tool(
      "workspace_tag_archive",
      &json!({
        "workspace_id": workspace_id, "tag_id": created_id,
        "idempotency_key": "tag-archive"
      }),
      &owner_auth,
      &state,
    )
    .await
    .expect("archive workspace Tag"),
  );
  assert_eq!(archived["archived"], true);
  dispatch_tool(
    "workspace_tag_create",
    &json!({
      "workspace_id": workspace_id, "name": "Renamed", "color_role": "tag.red",
      "idempotency_key": "tag-create-restore-conflict"
    }),
    &owner_auth,
    &state,
  )
  .await
  .expect("occupy archived Tag slug");
  let restore_conflict = dispatch_tool(
    "workspace_tag_restore",
    &json!({
      "workspace_id": workspace_id, "tag_id": created_id,
      "idempotency_key": "tag-restore-conflict"
    }),
    &owner_auth,
    &state,
  )
  .await
  .expect_err("restore must preserve active slug conflict");
  assert_eq!(restore_conflict.0, -32009);

  dispatch_tool(
    "workspace_tag_archive",
    &json!({
      "workspace_id": workspace_id, "tag_id": same_name_id,
      "idempotency_key": "tag-second-archive"
    }),
    &owner_auth,
    &state,
  )
  .await
  .expect("archive second Tag");
  let restored = payload(
    dispatch_tool(
      "workspace_tag_restore",
      &json!({
        "workspace_id": workspace_id, "tag_id": same_name_id,
        "idempotency_key": "tag-second-restore"
      }),
      &owner_auth,
      &state,
    )
    .await
    .expect("restore unconflicted Tag"),
  );
  assert_eq!(restored["archived"], false);

  let reader_auth = auth_with_scopes(reader_id, &["write:docs"]);
  persist_auth_key(&pool, &reader_auth).await;
  let forbidden = dispatch_tool(
    "workspace_tag_rename",
    &json!({
      "workspace_id": workspace_id, "tag_id": same_name_id,
      "name": "Bypassed", "idempotency_key": "tag-reader-forbidden"
    }),
    &reader_auth,
    &state,
  )
  .await
  .expect_err("write:docs scope must not bypass service CreateDoc authorization");
  assert_eq!(forbidden.0, -32003);
  assert_eq!(
    tags
      .get_tag(owner_id, workspace_id, same_name_id)
      .await
      .expect("verify forbidden write")
      .expect("second Tag")
      .name,
    "Lifecycle"
  );

  let unconfirmed = dispatch_tool(
    "workspace_tag_delete_permanently",
    &json!({
      "workspace_id": workspace_id, "tag_id": created_id,
      "confirm_permanent_delete": false, "idempotency_key": "tag-delete-unconfirmed"
    }),
    &owner_auth,
    &state,
  )
  .await
  .expect_err("permanent deletion requires explicit true confirmation");
  assert_eq!(unconfirmed.0, -32602);

  let active_delete = dispatch_tool(
    "workspace_tag_delete_permanently",
    &json!({
      "workspace_id": workspace_id, "tag_id": same_name_id,
      "confirm_permanent_delete": true, "idempotency_key": "tag-delete-active"
    }),
    &owner_auth,
    &state,
  )
  .await
  .expect_err("active Tag must not be permanently deleted");
  assert_eq!(active_delete.0, -32009);
  assert!(active_delete.1.contains("MIX_WORKSPACE_TAG_NOT_ARCHIVED"));

  let forbidden_delete = dispatch_tool(
    "workspace_tag_delete_permanently",
    &json!({
      "workspace_id": workspace_id, "tag_id": created_id,
      "confirm_permanent_delete": true, "idempotency_key": "tag-reader-delete-forbidden"
    }),
    &reader_auth,
    &state,
  )
  .await
  .expect_err("write:docs must not bypass service PropertiesDelete authorization");
  assert_eq!(forbidden_delete.0, -32003);

  let delete_params = json!({
    "workspace_id": workspace_id, "tag_id": created_id,
    "confirm_permanent_delete": true, "idempotency_key": "tag-delete-permanent"
  });
  let deleted = payload(
    dispatch_tool("workspace_tag_delete_permanently", &delete_params, &owner_auth, &state)
      .await
      .expect("delete archived Tag permanently"),
  );
  assert_eq!(deleted, json!({ "tagId": created_id, "deleted": true }));
  assert_eq!(
    payload(
      dispatch_tool("workspace_tag_delete_permanently", &delete_params, &owner_auth, &state,)
        .await
        .expect("replay permanent Tag deletion"),
    ),
    deleted
  );
  let mismatch = dispatch_tool(
    "workspace_tag_delete_permanently",
    &json!({
      "workspace_id": workspace_id, "tag_id": same_name_id,
      "confirm_permanent_delete": true, "idempotency_key": "tag-delete-permanent"
    }),
    &owner_auth,
    &state,
  )
  .await
  .expect_err("an idempotency key cannot be reused for another Tag");
  assert_eq!(mismatch.0, -32010);
  assert!(mismatch.1.contains("MIX_MCP_IDEMPOTENCY_CONFLICT"));
  assert!(
    tags
      .get_tag(owner_id, workspace_id, created_id)
      .await
      .expect("verify permanent deletion")
      .is_none()
  );

  helpers::cleanup_users(&pool, &[owner_id, reader_id]).await;
}

#[tokio::test]
async fn inv_mcp_document_tags_set_replaces_explicit_ids_with_archived_delta_and_external_identity() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-document-tags-set-owner").await;
  use futures_util::FutureExt;
  let journey = async {
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    let other_workspace_id = helpers::create_workspace(&pool, owner_id).await;
    let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
    let external_id = format!("document-tags-set-{}", Uuid::new_v4());
    sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
      .bind(doc_id)
      .bind(&external_id)
      .execute(&pool)
      .await
      .expect("set actor-facing document key");

    let (mut state, tags) = build_tool_state(&pool);
    state.idempotency =
      Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let owner_auth = auth_with_scopes(owner_id, &["read:docs", "write:docs"]);
    persist_auth_key(&pool, &owner_auth).await;
    // Exercise the same paginated, scope/service-filtered announcement as /mcp.
    let mut discovered = std::collections::HashMap::new();
    let mut cursor = None;
    loop {
      let page = myoxus_mcp::tool_registry::list_tools(
        &cursor
          .as_ref()
          .map_or_else(|| json!({}), |cursor: &String| json!({"cursor": cursor})),
        &owner_auth,
        state.tool_availability(),
      )
      .expect("discover the wired MCP tools");
      for tool in page.tools {
        let tool = serde_json::to_value(tool).expect("serialize SDK tool");
        assert!(
          discovered
            .insert(tool["name"].as_str().unwrap().to_owned(), tool.clone())
            .is_none()
        );
      }
      cursor = page.next_cursor;
      if cursor.is_none() {
        break;
      }
    }
    for name in [
      "workspace_tag_list",
      "workspace_tag_create",
      "document_tags_get",
      "document_tags_set",
    ] {
      let tool = discovered
        .get(name)
        .expect("required Label workflow tool is discoverable");
      assert!(tool["description"].as_str().unwrap().contains("Label"));
      assert_eq!(
        tool["annotations"]["readOnlyHint"],
        matches!(name, "workspace_tag_list" | "document_tags_get")
      );
      assert_eq!(tool["annotations"]["idempotentHint"], true);
    }
    assert_eq!(
      discovered["workspace_tag_create"]["annotations"]["destructiveHint"],
      false
    );
    assert_eq!(discovered["document_tags_set"]["annotations"]["destructiveHint"], true);

    let retained = tags
      .create_tag(owner_id, workspace_id, "Retained", "tag.blue", None)
      .await
      .expect("create retained Tag");
    let create_params = json!({"workspace_id":workspace_id,"name":"Active","color_role":"tag.green","description":"Discovered workflow","idempotency_key":"discovered-active-create"});
    let created = payload(
      dispatch_tool("workspace_tag_create", &create_params, &owner_auth, &state)
        .await
        .expect("create through discovered tool"),
    );
    let active_id = Uuid::parse_str(created["id"].as_str().expect("canonical Tag UUID")).unwrap();
    assert_eq!(created["description"], "Discovered workflow");
    let created_replay = payload(
      dispatch_tool("workspace_tag_create", &create_params, &owner_auth, &state)
        .await
        .expect("replay create"),
    );
    assert_eq!(created_replay, created);
    let listed = payload(
      dispatch_tool(
        "workspace_tag_list",
        &json!({"workspace_id":workspace_id}),
        &owner_auth,
        &state,
      )
      .await
      .expect("list canonical catalog"),
    );
    assert_eq!(
      listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|tag| tag["id"] == json!(active_id))
        .count(),
      1
    );
    let newly_archived = tags
      .create_tag(owner_id, workspace_id, "Newly archived", "tag.orange", None)
      .await
      .expect("create unassigned Tag");
    let foreign = tags
      .create_tag(owner_id, other_workspace_id, "Foreign", "tag.red", None)
      .await
      .expect("create foreign Tag");

    tags
      .set_document_tags(owner_id, workspace_id, doc_id, &[retained.id])
      .await
      .expect("establish historical assignment");
    tags
      .archive_tag(owner_id, workspace_id, retained.id)
      .await
      .expect("archive retained Tag");
    tags
      .archive_tag(owner_id, workspace_id, newly_archived.id)
      .await
      .expect("archive never-assigned Tag");

    let replace_params = json!({
      "workspace_id": workspace_id,
      "external_id": external_id,
      "tag_ids": [retained.id, active_id],
      "idempotency_key": "document-tags-replace"
    });
    let replaced = payload(
      dispatch_tool("document_tags_set", &replace_params, &owner_auth, &state)
        .await
        .expect("retain archived Tag and add active Tag"),
    );
    assert_eq!(replaced["externalId"], external_id);
    assert_eq!(
      replaced["tags"],
      json!([
        { "id": retained.id, "name": "Retained", "colorRole": "tag.blue", "archived": true },
        { "id": active_id, "name": "Active", "colorRole": "tag.green", "archived": false }
      ])
    );
    assert!(!replaced.to_string().contains(&doc_id.to_string()));
    assert!(!replaced.to_string().contains("document-tags-replace"));
    let replay = payload(
      dispatch_tool("document_tags_set", &replace_params, &owner_auth, &state)
        .await
        .expect("replacement replays without another mutation"),
    );
    assert_eq!(replay, replaced);
    let read_params = json!({"workspace_id":workspace_id,"external_id":external_id});
    let readback = payload(
      dispatch_tool("document_tags_get", &read_params, &owner_auth, &state)
        .await
        .expect("get committed ordered assignment"),
    );
    assert_eq!(readback, replaced);
    for (name, output) in [
      ("workspace_tag_create", &created),
      ("workspace_tag_list", &listed),
      ("document_tags_set", &replaced),
      ("document_tags_get", &readback),
    ] {
      let schema = &discovered[name]["outputSchema"];
      for required in schema["required"].as_array().unwrap() {
        assert!(
          output.get(required.as_str().unwrap()).is_some(),
          "{name} omits advertised result field"
        );
      }
      assert!(
        output
          .as_object()
          .unwrap()
          .keys()
          .all(|key| schema["properties"].get(key).is_some())
      );
    }
    let mut changed_retry_params = replace_params.clone();
    changed_retry_params["tag_ids"] = json!([]);
    assert!(
      dispatch_tool("document_tags_set", &changed_retry_params, &owner_auth, &state)
        .await
        .is_err(),
      "same key with changed arguments must fail"
    );

    let duplicate = dispatch_tool(
      "document_tags_set",
      &json!({
        "workspace_id": workspace_id, "external_id": external_id,
        "tag_ids": [active_id, active_id], "idempotency_key": "document-tags-duplicate"
      }),
      &owner_auth,
      &state,
    )
    .await
    .expect_err("duplicate canonical Tag IDs must be rejected");
    assert_eq!(duplicate.0, -32602);

    let archived_add = dispatch_tool(
      "document_tags_set",
      &json!({
        "workspace_id": workspace_id, "external_id": external_id,
        "tag_ids": [retained.id, newly_archived.id], "idempotency_key": "document-tags-archived-add"
      }),
      &owner_auth,
      &state,
    )
    .await
    .expect_err("an archived Tag cannot be newly added");
    assert_eq!(archived_add.0, -32009);

    let wrong_workspace = dispatch_tool(
      "document_tags_set",
      &json!({
        "workspace_id": workspace_id, "external_id": external_id,
        "tag_ids": [foreign.id], "idempotency_key": "document-tags-foreign"
      }),
      &owner_auth,
      &state,
    )
    .await
    .expect_err("foreign canonical Tag ID must not cross workspace boundary");
    assert_eq!(wrong_workspace.0, -32602);

    let still_assigned = tags
      .document_tag_ids(owner_id, workspace_id, doc_id)
      .await
      .expect("failed replacements preserve prior assignment");
    assert_eq!(still_assigned, vec![retained.id, active_id]);

    let omitted = payload(dispatch_tool("document_tags_set", &json!({"workspace_id":workspace_id,"external_id":external_id,"tag_ids":[active_id],"idempotency_key":"document-tags-omit-retained"}), &owner_auth, &state).await.expect("omitted archived ID is removed"));
    assert_eq!(
      omitted["tags"],
      json!([{"id":active_id,"name":"Active","colorRole":"tag.green","archived":false}])
    );
    assert_eq!(
      tags.document_tag_ids(owner_id, workspace_id, doc_id).await.unwrap(),
      vec![active_id]
    );

    let cleared = payload(
      dispatch_tool(
        "document_tags_set",
        &json!({
          "workspace_id": workspace_id, "external_id": external_id,
          "tag_ids": [], "idempotency_key": "document-tags-clear"
        }),
        &owner_auth,
        &state,
      )
      .await
      .expect("clear complete document Tag assignment"),
    );
    assert_eq!(cleared, json!({ "externalId": external_id, "tags": [] }));
    assert!(
      tags
        .document_tag_ids(owner_id, workspace_id, doc_id)
        .await
        .expect("read cleared assignments")
        .is_empty()
    );

    // Replay returns the original acknowledgement without restoring cleared IDs.
    let stale_replay = payload(
      dispatch_tool("document_tags_set", &replace_params, &owner_auth, &state)
        .await
        .expect("replay after an intervening clear"),
    );
    assert_eq!(stale_replay, replaced);
    let current = payload(
      dispatch_tool("document_tags_get", &read_params, &owner_auth, &state)
        .await
        .expect("read current state after replay"),
    );
    assert_eq!(current, cleared);
    assert!(
      tags
        .document_tag_ids(owner_id, workspace_id, doc_id)
        .await
        .unwrap()
        .is_empty()
    );
  };
  let outcome = std::panic::AssertUnwindSafe(journey).catch_unwind().await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
