// SPDX-License-Identifier: AGPL-3.0-or-later
//! End-to-end MCP coverage for workspace and document publication adapters.

use std::sync::Arc;

use async_trait::async_trait;
use myoxus_application::doc::DocService;
use myoxus_application::permission::PermissionService;
use myoxus_application::public::{DocumentPublicationService, PublicRepository};
use myoxus_application::workspace::{WorkspaceService, WorkspaceSettingsInvalidation, WorkspaceSettingsService};
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::public::PgPublicRepository;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_mcp::auth::McpAuthContext;
use myoxus_mcp::tools::{McpToolState, dispatch_tool};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::helpers;

#[derive(Clone, Default)]
struct NoopSettingsInvalidation;

#[async_trait]
impl WorkspaceSettingsInvalidation for NoopSettingsInvalidation {
  async fn invalidate_workspace_settings(&self, _workspace_id: Uuid) {}
}

fn build_tool_state(pool: &sqlx::PgPool) -> McpToolState {
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let workspace_service = WorkspaceService::new(workspace_store);
  let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let permission = Arc::new(PermissionService::new(Arc::new(SqlxAuthStore::from_pool(pool.clone()))));
  let public_repository: Arc<dyn PublicRepository> = Arc::new(PgPublicRepository::new(pool.clone()));
  let workspace_settings_service = Arc::new(WorkspaceSettingsService::new(
    workspace_service.clone(),
    permission.clone(),
    Arc::new(NoopSettingsInvalidation),
    public_repository.clone(),
    doc_service.clone(),
    None,
  ));
  let document_publication_service = Arc::new(DocumentPublicationService::new(
    permission.clone(),
    Arc::new(doc_service.clone()),
    public_repository.clone(),
    true,
  ));
  McpToolState {
    html_catalog: Some(Arc::new(
      myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html"),
      ),
    )),
    workspace_service,
    workspace_settings_service: Some(workspace_settings_service),
    public_repository: Some(public_repository),
    public_delivery_enabled: true,
    document_publication_service: Some(document_publication_service),
    doc_service,
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
    document_cursor_signing_key: Arc::from(&b"mcp-publication-test-cursor-key"[..]),
    document_export_max_bytes: 8 * 1024 * 1024,
  }
}

fn auth(user_id: Uuid, scopes: &[&str]) -> McpAuthContext {
  McpAuthContext {
    user_id,
    scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
    key_id: Uuid::new_v4(),
  }
}

fn payload(response: Value) -> Value {
  serde_json::from_str(response["content"][0]["text"].as_str().expect("MCP content text"))
    .expect("structured MCP response")
}

#[tokio::test]
async fn mcp_workspace_and_document_publication_share_authoritative_state_and_replay() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-publication-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let external_id = "project brief";
  sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
    .bind(doc_id)
    .bind(external_id)
    .execute(&pool)
    .await
    .expect("set external document key");

  let mut state = build_tool_state(&pool);
  let full_auth = auth(
    owner_id,
    &["read:workspaces", "write:workspaces", "read:docs", "write:docs"],
  );

  let initial = payload(
    dispatch_tool(
      "workspace_get",
      &json!({"workspace_id": workspace_id}),
      &full_auth,
      &state,
    )
    .await
    .expect("read initial workspace state"),
  );
  assert_eq!(initial["publicly_accessible"], false);
  assert!(initial["public_url"].is_null());

  let missing_read = auth(owner_id, &["write:workspaces"]);
  let denied = dispatch_tool(
    "workspace_update",
    &json!({"workspace_id": workspace_id, "public": true, "idempotency_key": "missing-read"}),
    &missing_read,
    &state,
  )
  .await
  .expect_err("write readback requires read:workspaces");
  assert_eq!(denied.0, -32003);

  let update = json!({
    "workspace_id": workspace_id,
    "name": "  Published workspace  ",
    "description": "Public overview",
    "public": true,
    "enable_sharing": true,
    "idempotency_key": "workspace-publish-1"
  });
  let updated = dispatch_tool("workspace_update", &update, &full_auth, &state)
    .await
    .expect("update workspace publication");
  let replayed = dispatch_tool("workspace_update", &update, &full_auth, &state)
    .await
    .expect("replay workspace publication");
  assert_eq!(replayed, updated, "completed replay must return its original result");
  let updated = payload(updated);
  assert_eq!(updated["name"], "Published workspace");
  assert_eq!(updated["description"], "Public overview");
  assert_eq!(updated["publicly_accessible"], true);
  assert_eq!(
    updated["public_url"],
    format!("https://myoxus.test/public/{workspace_id}")
  );

  let publish = json!({
    "workspace_id": workspace_id,
    "external_id": external_id,
    "public": true,
    "idempotency_key": "document-publish-1"
  });
  let published = dispatch_tool("doc_publication_set", &publish, &full_auth, &state)
    .await
    .expect("publish document");
  let replayed = dispatch_tool("doc_publication_set", &publish, &full_auth, &state)
    .await
    .expect("replay document publish");
  assert_eq!(
    replayed, published,
    "replay must not create a second publication result"
  );
  let published = payload(published);
  assert_eq!(published["public"], true);
  assert_eq!(published["mode"], "Page");
  assert_eq!(published["publiclyAccessible"], true);
  assert_eq!(
    published["publicUrl"],
    format!("https://myoxus.test/public/{workspace_id}/project%20brief")
  );

  let conflict = dispatch_tool(
    "doc_publication_set",
    &json!({
      "workspace_id": workspace_id,
      "external_id": external_id,
      "public": false,
      "idempotency_key": "document-publish-1"
    }),
    &full_auth,
    &state,
  )
  .await
  .expect_err("changed payload with the same key must conflict");
  assert_eq!(conflict.0, -32010);

  let invalid_revoke = dispatch_tool(
    "doc_publication_set",
    &json!({
      "workspace_id": workspace_id,
      "external_id": external_id,
      "public": false,
      "mode": "Page",
      "idempotency_key": "invalid-revoke"
    }),
    &full_auth,
    &state,
  )
  .await
  .expect_err("revocation rejects a mode");
  assert_eq!(invalid_revoke.0, -32602);

  state.public_delivery_enabled = false;
  let revoked = payload(
    dispatch_tool(
      "doc_publication_set",
      &json!({
        "workspace_id": workspace_id,
        "external_id": external_id,
        "public": false,
        "idempotency_key": "document-revoke-1"
      }),
      &full_auth,
      &state,
    )
    .await
    .expect("revoke while delivery is unavailable"),
  );
  assert_eq!(revoked["public"], false);
  assert!(revoked["mode"].is_null());
  assert_eq!(revoked["publiclyAccessible"], false);
  assert!(revoked["publicUrl"].is_null());

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn mcp_publication_handlers_reject_null_unknown_and_missing_read_scope_before_mutation() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-publication-validation").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let external_id = doc_id.to_string();
  sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
    .bind(doc_id)
    .bind(&external_id)
    .execute(&pool)
    .await
    .expect("set external document key");
  let state = build_tool_state(&pool);
  let full_auth = auth(owner_id, &["read:docs", "write:docs"]);

  for arguments in [
    json!({"workspace_id": workspace_id, "external_id": external_id, "extra": true}),
    json!({"workspace_id": workspace_id, "external_id": external_id, "public": null, "idempotency_key": "null"}),
  ] {
    let result = dispatch_tool("doc_publication_set", &arguments, &full_auth, &state)
      .await
      .expect_err("invalid arguments must fail");
    assert_eq!(result.0, -32602);
  }

  let write_only = auth(owner_id, &["write:docs"]);
  let result = dispatch_tool(
    "doc_publication_set",
    &json!({
      "workspace_id": workspace_id,
      "external_id": external_id,
      "public": true,
      "idempotency_key": "missing-read"
    }),
    &write_only,
    &state,
  )
  .await
  .expect_err("publication write readback requires read:docs");
  assert_eq!(result.0, -32003);

  let stored_mode: Option<String> = sqlx::query_scalar("SELECT public_mode FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read publication state");
  assert!(
    stored_mode.is_none(),
    "rejected calls must not mutate publication state"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[path = "../../../mcp/src/output_schema_test_support.rs"]
mod output_schema_test_support;

#[tokio::test]
async fn inv_workspace_creation_http_preserves_principals_roots_and_fresh_replay_authority() {
  use crate::helpers::mcp::{invoke, key, request};
  use futures_util::FutureExt;
  let (app, pool, store) = helpers::setup_app_with_mcp_and_audit().await;
  let (admin, session) = helpers::seed_admin(&pool, &store).await;
  let (user, user_session) = helpers::seed_user(&pool, &store, "mcp-workspace-create").await;
  let unit = Uuid::new_v4();
  let journey = std::panic::AssertUnwindSafe(async {
    sqlx::query("INSERT INTO organization_unit(id,organization_id,unit_type_id,name,slug,status,max_members) SELECT $1,organization_id,id,'MCP creation unit',$2,'active',150 FROM organization_unit_type WHERE is_active AND can_be_root_level AND can_own_workspaces ORDER BY key LIMIT 1")
      .bind(unit).bind(format!("mcp-create-{unit}")).execute(&pool).await.expect("create fixture unit");
    let token = key(&app, user_session, &["write:workspaces"]).await;
    let admin_token = key(&app, session, &["write:workspaces"]).await;
    let reader = key(&app, session, &["read:workspaces"]).await;
    let (_, discovery) = request(&app, &token, "tools/list", json!({})).await;
    let descriptor = discovery["result"]["tools"].as_array().unwrap().iter()
      .find(|tool| tool["name"] == "workspace_create").expect("write-scoped creation discovery");
    assert_eq!(descriptor["annotations"]["readOnlyHint"], false);
    assert_eq!(descriptor["annotations"]["idempotentHint"], true);
    let (_, discovery) = request(&app, &reader, "tools/list", json!({})).await;
    assert!(!discovery["result"]["tools"].as_array().unwrap().iter().any(|t|t["name"] == "workspace_create"));
    assert_eq!(invoke(&app,&reader,"workspace_create",json!({"idempotency_key":"no-scope"}),false).await["code"], "SCOPE_DENIED");
    for input in [json!({}), json!({"owner_user_id":admin,"idempotency_key":"impersonation"}), json!({"name":null,"idempotency_key":"null"})] {
      invoke(&app,&token,"workspace_create",input,false).await;
    }
    let creation = json!({"name":"  MCP   Workspace  ","idempotency_key":"create"});
    let created = invoke(&app,&token,"workspace_create",creation.clone(),true).await;
    let schema = &myoxus_mcp::tool_registry::find_tool("workspace_create").unwrap().output_schema;
    output_schema_test_support::assert_required_output(schema, &created);
    assert_eq!(created["classification"],"user_owned");
    assert_eq!(created["initialized"],true);
    assert_eq!(invoke(&app,&token,"workspace_create",creation.clone(),true).await,created);
    invoke(&app,&token,"workspace_create",json!({"name":"Changed","idempotency_key":"create"}),false).await;
    let id = Uuid::parse_str(created["id"].as_str().unwrap()).unwrap();
    let persisted: (Uuid,String,bool) = sqlx::query_as("SELECT owner_user_id,name,is_personal_workspace FROM workspaces WHERE id=$1")
      .bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(persisted,(user,"MCP Workspace".into(),false));
    let graph = helpers::gql(&app,user_session,json!({"query":"query($id:String!){workspace(id:$id){id name workspaceType owner{id}}}","variables":{"id":id}})).await;
    assert!(graph.get("errors").is_none(),"{graph}");
    assert_eq!(graph["data"]["workspace"]["owner"]["id"],user.to_string());
    let audit_count: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE event_key='mcp.workspace.create' AND target_id=$1 AND actor_user_id=$2")
      .bind(id.to_string()).bind(user).fetch_one(&pool).await.unwrap();
    assert!(audit_count > 0, "durable MCP creation audit identifies the created Workspace");
    let conflict = invoke(&app,&token,"workspace_create",json!({"name":"MCP Workspace","idempotency_key":"conflict"}),false).await;
    assert!(conflict["message"].as_str().unwrap().contains("suggested name:"));
    let default1=invoke(&app,&token,"workspace_create",json!({"idempotency_key":"default1"}),true).await;
    let default2=invoke(&app,&token,"workspace_create",json!({"idempotency_key":"default2"}),true).await;
    assert_ne!(default1["id"],default2["id"]);
    let shared_input=json!({"name":"Shared MCP Workspace","owner_unit_id":unit,"idempotency_key":"shared"});
    assert_eq!(invoke(&app,&token,"workspace_create",shared_input.clone(),false).await["code"],"PERMISSION_DENIED");
    let shared=invoke(&app,&admin_token,"workspace_create",shared_input.clone(),true).await;
    output_schema_test_support::assert_required_output(schema,&shared);
    assert_eq!(shared["classification"],"shared");
    let shared_id=Uuid::parse_str(shared["id"].as_str().unwrap()).unwrap();
    let principal:(String,Uuid,Option<Uuid>)=sqlx::query_as("SELECT owner_principal_type::text,owner_principal_id,owner_user_id FROM workspaces WHERE id=$1")
      .bind(shared_id).fetch_one(&pool).await.unwrap();
    assert_eq!(principal,("ou".into(),unit,None));
    for value in [&created,&default1,&default2,&shared] {
      let workspace=Uuid::parse_str(value["id"].as_str().unwrap()).unwrap();
      let initialized:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE workspace_id=$1 AND is_workspace_root) AND EXISTS(SELECT 1 FROM doc_updates WHERE workspace_id=$1 AND octet_length(payload)>0)")
        .bind(workspace).fetch_one(&pool).await.unwrap();
      assert!(initialized,"persisted initialized root");
    }
    sqlx::query("UPDATE organization_unit SET status='disabled' WHERE id=$1").bind(unit).execute(&pool).await.unwrap();
    for input in [shared_input.clone(),json!({"owner_unit_id":unit,"idempotency_key":"disabled-unit"})] {
      assert_eq!(invoke(&app,&admin_token,"workspace_create",input,false).await["code"],"PERMISSION_DENIED");
    }
    sqlx::query("UPDATE organization_unit SET status='active' WHERE id=$1").bind(unit).execute(&pool).await.unwrap();
    sqlx::query("UPDATE users SET is_admin=false WHERE id=$1").bind(admin).execute(&pool).await.unwrap();
    assert_eq!(invoke(&app,&admin_token,"workspace_create",shared_input,false).await["code"],"PERMISSION_DENIED");
    sqlx::query("UPDATE users SET status='disabled' WHERE id=$1").bind(user).execute(&pool).await.unwrap();
    assert_eq!(request(&app,&token,"tools/call",json!({"name":"workspace_create","arguments":creation})).await.0,axum::http::StatusCode::UNAUTHORIZED);
  }).catch_unwind().await;
  let shared_ids: Vec<Uuid> =
    sqlx::query_scalar("SELECT id FROM workspaces WHERE owner_principal_type='ou' AND owner_principal_id=$1")
      .bind(unit)
      .fetch_all(&pool)
      .await
      .expect("find owned fixture Workspaces");
  helpers::cleanup_workspaces(&pool, &shared_ids).await;
  helpers::cleanup_users(&pool, &[admin, user]).await;
  sqlx::query("DELETE FROM organization_unit WHERE id=$1")
    .bind(unit)
    .execute(&pool)
    .await
    .expect("cleanup unit");
  let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id=ANY($1)")
    .bind(&[admin, user][..])
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(remaining, 0, "fixture cleanup");
  if let Err(panic) = journey {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_workspace_partial_provisioning_fences_same_key_after_durable_creation() {
  use crate::helpers::mcp::{invoke, key};
  use futures_util::FutureExt;
  let (app, pool, store) = helpers::setup_app_with_mcp_and_audit().await;
  let (user, session) = helpers::seed_user(&pool, &store, "mcp-workspace-partial").await;
  let trigger = format!("mcp_workspace_partial_{}", Uuid::new_v4().simple());
  let journey=std::panic::AssertUnwindSafe(async {
    // Like the user-create fixture, fault only this disposable principal after
    // the Workspace insert. Concurrent unrelated owners remain unaffected.
    sqlx::query(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM workspaces WHERE id=NEW.workspace_id AND owner_user_id='{user}') THEN RAISE EXCEPTION 'private-workspace-root-failure'; END IF; RETURN NEW; END $$"))
      .execute(&pool).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE INSERT ON doc_updates FOR EACH ROW EXECUTE FUNCTION {trigger}()"))
      .execute(&pool).await.unwrap();
    let token=key(&app,session,&["write:workspaces"]).await;
    let input=json!({"name":"Partial Workspace","idempotency_key":"partial"});
    let failure=invoke(&app,&token,"workspace_create",input.clone(),false).await;
    assert_eq!(failure["code"],"RECOVERY_REQUIRED");
    assert_eq!(failure["retryable"],false);
    assert!(failure["message"].as_str().unwrap().starts_with("MIX_MCP_WORKSPACE_CREATE_PARTIAL:"));
    assert!(!failure.to_string().contains("private-workspace-root-failure"));
    sqlx::query(&format!("DROP TRIGGER {trigger} ON doc_updates")).execute(&pool).await.unwrap();
    let retry=invoke(&app,&token,"workspace_create",input,false).await;
    assert_eq!(retry["code"],"RECOVERY_REQUIRED");
    assert_eq!(retry["retryable"],false);
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM workspaces WHERE owner_user_id=$1").bind(user).fetch_one(&pool).await.unwrap();
    assert_eq!(count,1,"uncertain replay must neither provision nor repair");
    let updates:i64=sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id=$1)").bind(user).fetch_one(&pool).await.unwrap();
    assert_eq!(updates,0);
    // An empty update already present makes the shared seed owner preserve it.
    // The adapter must read initialization rather than reporting success.
    sqlx::query(&format!("CREATE FUNCTION {trigger}_empty() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.is_workspace_root AND EXISTS(SELECT 1 FROM workspaces WHERE id=NEW.workspace_id AND owner_user_id='{user}') THEN INSERT INTO doc_updates(doc_id,workspace_id,payload,sequence) VALUES(NEW.id,NEW.workspace_id,decode('','hex'),1); END IF; RETURN NEW; END $$"))
      .execute(&pool).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER {trigger}_empty AFTER INSERT ON docs FOR EACH ROW EXECUTE FUNCTION {trigger}_empty()"))
      .execute(&pool).await.unwrap();
    let empty_input=json!({"name":"Empty root Workspace","idempotency_key":"empty-root"});
    let failure=invoke(&app,&token,"workspace_create",empty_input.clone(),false).await;
    assert_eq!(failure["code"],"RECOVERY_REQUIRED");
    assert_eq!(failure["retryable"],false);
    assert!(failure["message"].as_str().unwrap().contains("root is not initialized"));
    assert_eq!(invoke(&app,&token,"workspace_create",empty_input,false).await["code"],"RECOVERY_REQUIRED");
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM workspaces WHERE owner_user_id=$1").bind(user).fetch_one(&pool).await.unwrap();
    assert_eq!(count,2,"empty-root retries cannot create another Workspace");

  }).catch_unwind().await;
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger} ON doc_updates"))
    .execute(&pool)
    .await
    .expect("remove scoped fault");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {trigger}()"))
    .execute(&pool)
    .await
    .expect("remove scoped function");
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger}_empty ON docs"))
    .execute(&pool)
    .await
    .expect("remove empty-root fixture");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {trigger}_empty()"))
    .execute(&pool)
    .await
    .expect("remove empty-root function");
  helpers::cleanup_users(&pool, &[user]).await;
  let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id=$1")
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(remaining, 0, "fixture cleanup");
  if let Err(panic) = journey {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_workspace_trash_and_privileged_restore_preserve_identity_content_and_personal_classification() {
  use crate::helpers::mcp::{invoke, key, request};
  use futures_util::FutureExt;
  let (app, pool, store) = helpers::setup_app_with_mcp_and_audit().await;
  let (owner, session) = helpers::seed_user(&pool, &store, "mcp-trash-owner").await;
  let (other, other_session) = helpers::seed_user(&pool, &store, "mcp-trash-other").await;
  let (admin, admin_session) = helpers::seed_admin(&pool, &store).await;
  let journey=std::panic::AssertUnwindSafe(async {
    let token=key(&app,session,&["read:workspaces","write:workspaces"]).await;
    let other_token=key(&app,other_session,&["write:workspaces"]).await;
    let recovery=key(&app,admin_session,&["write:workspaces"]).await;
    let reader=key(&app,admin_session,&["read:workspaces"]).await;
    let (_,discovery)=request(&app,&token,"tools/list",json!({})).await;
    for (name,destructive) in [("workspace_delete",true),("workspace_restore",false)] {
      let descriptor=discovery["result"]["tools"].as_array().unwrap().iter().find(|t|t["name"]==name).unwrap();
      assert_eq!(descriptor["annotations"]["destructiveHint"],destructive);
      assert_eq!(descriptor["annotations"]["idempotentHint"],true);
    }
    let created=invoke(&app,&token,"workspace_create",json!({"name":"Retained content","idempotency_key":"create"}),true).await;
    let id=Uuid::parse_str(created["id"].as_str().unwrap()).unwrap();
    sqlx::query("UPDATE workspaces SET is_personal_workspace=true WHERE id=$1").bind(id).execute(&pool).await.unwrap();
    let root:Vec<u8>=sqlx::query_scalar("SELECT payload FROM doc_updates WHERE workspace_id=$1 AND doc_id=$1 AND sequence=1").bind(id).fetch_one(&pool).await.unwrap();
    let blob_key=format!("mcp-retained-{id}");
    sqlx::query("INSERT INTO blobs(workspace_id,key,size,mime,status) VALUES($1,$2,42,'application/octet-stream','completed')").bind(id).bind(&blob_key).execute(&pool).await.unwrap();
    let deletion=json!({"workspace_id":id,"confirm":true,"idempotency_key":"delete"});
    for confirmation in [json!(null),json!(false)] {
      invoke(&app,&token,"workspace_delete",json!({"workspace_id":id,"confirm":confirmation,"idempotency_key":"unconfirmed"}),false).await;
    }
    invoke(&app,&other_token,"workspace_delete",deletion.clone(),false).await;
    assert_eq!(invoke(&app,&reader,"workspace_delete",deletion.clone(),false).await["code"],"SCOPE_DENIED");
    let deleted=invoke(&app,&token,"workspace_delete",deletion.clone(),true).await;
    assert_eq!(deleted,json!({"id":id,"deleted":true}));
    output_schema_test_support::assert_required_output(&myoxus_mcp::tool_registry::find_tool("workspace_delete").unwrap().output_schema,&deleted);
    invoke(&app,&token,"workspace_get",json!({"workspace_id":id}),false).await;
    invoke(&app,&token,"workspace_delete",deletion.clone(),false).await;
    let restore=json!({"workspace_id":id,"idempotency_key":"restore"});
    assert_eq!(invoke(&app,&token,"workspace_restore",restore.clone(),false).await["code"],"PERMISSION_DENIED");
    let conflict=invoke(&app,&token,"workspace_create",json!({"name":"Retained content","idempotency_key":"collision"}),true).await;
    let blocked=invoke(&app,&recovery,"workspace_restore",restore.clone(),false).await;
    assert!(blocked["message"].as_str().unwrap().contains("XWS_WORKSPACE_NAME_CONFLICT"));
    let collision=Uuid::parse_str(conflict["id"].as_str().unwrap()).unwrap();
    invoke(&app,&token,"workspace_delete",json!({"workspace_id":collision,"confirm":true,"idempotency_key":"delete-collision"}),true).await;
    // The rejected admission is retained; a corrected recovery is a new operation.
    let restore=json!({"workspace_id":id,"idempotency_key":"restore-after-conflict"});
    let restored=invoke(&app,&recovery,"workspace_restore",restore.clone(),true).await;
    assert_eq!(restored,json!({"id":id,"restored":true}));
    output_schema_test_support::assert_required_output(&myoxus_mcp::tool_registry::find_tool("workspace_restore").unwrap().output_schema,&restored);
    assert_eq!(invoke(&app,&recovery,"workspace_restore",restore.clone(),true).await,restored);
    assert_eq!(invoke(&app,&recovery,"workspace_restore",json!({"workspace_id":id,"idempotency_key":"already-active"}),true).await,restored);
    let after:Vec<u8>=sqlx::query_scalar("SELECT payload FROM doc_updates WHERE workspace_id=$1 AND doc_id=$1 AND sequence=1").bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(after,root);
    let retained:(bool,bool,i64)=sqlx::query_as("SELECT is_personal_workspace,deleted_at IS NULL,(SELECT count(*) FROM blobs WHERE workspace_id=$1 AND key=$2) FROM workspaces WHERE id=$1").bind(id).bind(&blob_key).fetch_one(&pool).await.unwrap();
    assert_eq!(retained,(true,true,1));
    invoke(&app,&token,"workspace_get",json!({"workspace_id":id}),true).await;
    sqlx::query("UPDATE users SET is_admin=false WHERE id=$1").bind(admin).execute(&pool).await.unwrap();
    assert_eq!(invoke(&app,&recovery,"workspace_restore",restore,false).await["code"],"PERMISSION_DENIED");
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[owner, other, admin]).await;
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users WHERE id=ANY($1)")
      .bind(&[owner, other, admin][..])
      .fetch_one(&pool)
      .await
      .unwrap(),
    0
  );
  if let Err(panic) = journey {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_workspace_member_http_preserves_effective_authority_protected_roles_and_replay() {
  use crate::helpers::mcp::{invoke, key, request};
  use futures_util::FutureExt;
  let (app, pool, store) = helpers::setup_app_with_mcp_and_audit().await;
  let (owner, owner_session) = helpers::seed_user(&pool, &store, "member-owner").await;
  let (admin, admin_session) = helpers::seed_admin(&pool, &store).await;
  let (member, member_session) = helpers::seed_user(&pool, &store, "member-target").await;
  let (manager, manager_session) = helpers::seed_user(&pool, &store, "unit-manager").await;
  let (outsider, outsider_session) = helpers::seed_user(&pool, &store, "member-outsider").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let org = helpers::default_organization_id(&pool).await;
  let kind = sqlx::query_scalar::<_,Uuid>("SELECT id FROM organization_unit_type WHERE is_active AND can_be_root_level AND can_own_workspaces ORDER BY key LIMIT 1").fetch_one(&pool).await.unwrap();
  let unit = helpers::create_organization_unit(&pool, org, kind, None, "MCP member governance").await;
  let journey = std::panic::AssertUnwindSafe(async {
    let owner_key = key(&app, owner_session, &["read:workspaces","write:workspaces"]).await;
    let admin_key = key(&app, admin_session, &["read:workspaces","write:workspaces","write:organization"]).await;
    let member_key = key(&app, member_session, &["read:workspaces","write:workspaces"]).await;
    let manager_key = key(&app, manager_session, &["read:workspaces","write:workspaces"]).await;
    let outsider_key = key(&app, outsider_session, &["read:workspaces","write:workspaces"]).await;
    let reader = key(&app, owner_session, &["read:workspaces"]).await;
    let (_, discovery) = request(&app,&reader,"tools/list",json!({})).await;
    let names = discovery["result"]["tools"].as_array().unwrap();
    assert!(names.iter().any(|t|t["name"]=="workspace_member_list"));
    assert!(names.iter().all(|t|t["name"]!="workspace_member_add"));
    let add = json!({"workspace_id":workspace,"user_id":member,"role":"Reader","idempotency_key":"add"});
    assert_eq!(invoke(&app,&owner_key,"workspace_member_add",add.clone(),false).await["code"],"PERMISSION_DENIED");
    assert_eq!(invoke(&app,&reader,"workspace_member_add",add.clone(),false).await["code"],"SCOPE_DENIED");
    for role in ["Owner","External"] {
      invoke(&app,&admin_key,"workspace_member_add",json!({"workspace_id":workspace,"user_id":member,"role":role,"idempotency_key":"bad-role"}),false).await;
    }
    let saved = invoke(&app,&admin_key,"workspace_member_add",add.clone(),true).await;
    assert_eq!(saved["status"],"Accepted"); assert_eq!(saved["role"],"Reader");
    assert_eq!(invoke(&app,&admin_key,"workspace_member_add",add.clone(),true).await,saved);
    output_schema_test_support::assert_required_output(&myoxus_mcp::tool_registry::find_tool("workspace_member_add").unwrap().output_schema,&saved);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='Accepted'").bind(workspace).bind(member).fetch_one(&pool).await.unwrap(),1);
    invoke(&app,&member_key,"workspace_member_list",json!({"workspace_id":workspace}),false).await;
    let first = invoke(&app,&owner_key,"workspace_member_list",json!({"workspace_id":workspace,"limit":1}),true).await;
    assert_eq!(first["members"].as_array().unwrap().len(),1); assert_eq!(first["next_offset"],1);
    let second = invoke(&app,&owner_key,"workspace_member_list",json!({"workspace_id":workspace,"limit":1,"offset":1}),true).await;
    assert_eq!(second["next_offset"],json!(null));assert_ne!(first["members"][0]["userId"],second["members"][0]["userId"]);
    output_schema_test_support::assert_required_output(&myoxus_mcp::tool_registry::find_tool("workspace_member_list").unwrap().output_schema,&first);
    let empty=invoke(&app,&owner_key,"workspace_member_list",json!({"workspace_id":workspace,"query":"no matching member"}),true).await;
    assert!(empty["members"].as_array().unwrap().is_empty()); assert!(empty["next_offset"].is_null());
    invoke(&app,&outsider_key,"workspace_member_list",json!({"workspace_id":workspace}),false).await;
    for input in [json!({"workspace_id":workspace,"limit":201}),json!({"workspace_id":workspace,"offset":-1}),json!({"workspace_id":workspace,"limit":null})] {
      invoke(&app,&owner_key,"workspace_member_list",input,false).await;
    }
    let change=json!({"workspace_id":workspace,"user_id":member,"role":"Admin","idempotency_key":"promote"});
    invoke(&app,&member_key,"workspace_member_set_role",change.clone(),false).await;
    let changed=invoke(&app,&owner_key,"workspace_member_set_role",change.clone(),true).await;
    assert_eq!(invoke(&app,&owner_key,"workspace_member_set_role",change.clone(),true).await,changed);
    output_schema_test_support::assert_required_output(&myoxus_mcp::tool_registry::find_tool("workspace_member_set_role").unwrap().output_schema,&changed);
    invoke(&app,&member_key,"workspace_member_set_role",json!({"workspace_id":workspace,"user_id":member,"role":"Reader","idempotency_key":"weak-admin"}),false).await;
    invoke(&app,&owner_key,"workspace_member_set_role",json!({"workspace_id":workspace,"user_id":owner,"role":"Reader","idempotency_key":"owner-demote"}),false).await;
    invoke(&app,&owner_key,"workspace_member_set_role",json!({"workspace_id":workspace,"user_id":member,"role":"Owner","idempotency_key":"owner-promote"}),false).await;
    invoke(&app,&owner_key,"workspace_member_remove",json!({"workspace_id":workspace,"user_id":owner,"idempotency_key":"self"}),false).await;
    let self_revoke=helpers::gql(&app,owner_session,json!({"query":"mutation($w:String!,$u:String!){revokeMember(workspaceId:$w,userId:$u)}","variables":{"w":workspace,"u":owner}})).await;
    assert!(self_revoke["errors"][0]["message"].as_str().unwrap().contains("CanNotRevokeYourself"));
    let demote=helpers::gql(&app,owner_session,json!({"query":"mutation($w:String!,$u:String!){grantMember(workspaceId:$w,userId:$u,permission:Reader)}","variables":{"w":workspace,"u":member}})).await;
    assert!(demote.get("errors").is_none(),"{demote}");assert_eq!(demote["data"]["grantMember"],true);
    let removed=invoke(&app,&owner_key,"workspace_member_remove",json!({"workspace_id":workspace,"user_id":member,"idempotency_key":"remove"}),true).await;
    assert_eq!(removed["removed"],true);
    output_schema_test_support::assert_required_output(&myoxus_mcp::tool_registry::find_tool("workspace_member_remove").unwrap().output_schema,&removed);
    invoke(&app,&member_key,"workspace_member_list",json!({"workspace_id":workspace}),false).await;
    invoke(&app,&owner_key,"workspace_member_remove",json!({"workspace_id":workspace,"user_id":member,"idempotency_key":"remove"}),false).await;
    invoke(&app,&admin_key,"organization_unit_member_add",json!({"unit_id":unit,"user_id":manager,"role":"manager","idempotency_key":"unit-manager"}),true).await;
    let shared=invoke(&app,&admin_key,"workspace_create",json!({"owner_unit_id":unit,"name":"Member authority","idempotency_key":"shared"}),true).await;
    let shared=Uuid::parse_str(shared["id"].as_str().unwrap()).unwrap();
    invoke(&app,&admin_key,"workspace_member_add",json!({"workspace_id":shared,"user_id":member,"role":"Reader","idempotency_key":"shared-member"}),true).await;
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2").bind(shared).bind(manager).fetch_one(&pool).await.unwrap(),0,"OU authority does not fabricate direct membership");
    invoke(&app,&manager_key,"workspace_member_list",json!({"workspace_id":shared}),true).await;
    invoke(&app,&manager_key,"workspace_member_set_role",json!({"workspace_id":shared,"user_id":member,"role":"Commenter","idempotency_key":"manager-change"}),true).await;
    invoke(&app,&manager_key,"workspace_member_set_role",json!({"workspace_id":shared,"user_id":member,"role":"Admin","idempotency_key":"manager-escalate"}),false).await;
    invoke(&app,&manager_key,"workspace_member_remove",json!({"workspace_id":shared,"user_id":admin,"idempotency_key":"protected-admin"}),false).await;
    invoke(&app,&manager_key,"workspace_member_remove",json!({"workspace_id":shared,"user_id":member,"idempotency_key":"manager-remove"}),true).await;
    sqlx::query("UPDATE users SET status='disabled' WHERE id=$1").bind(member).execute(&pool).await.unwrap();
    invoke(&app,&admin_key,"workspace_member_add",add.clone(),false).await;
    sqlx::query("UPDATE users SET status='active' WHERE id=$1").bind(member).execute(&pool).await.unwrap();
    invoke(&app,&admin_key,"workspace_member_add",json!({"workspace_id":workspace,"user_id":Uuid::new_v4(),"idempotency_key":"missing"}),false).await;
    sqlx::query("UPDATE users SET is_admin=false WHERE id=$1").bind(admin).execute(&pool).await.unwrap();
    invoke(&app,&admin_key,"workspace_member_add",add,false).await;
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM organization_unit_member WHERE user_id=$1").bind(member).fetch_one(&pool).await.unwrap(),0,"Workspace roles never grant OU manager capabilities");
  }).catch_unwind().await;
  sqlx::query("DELETE FROM workspaces WHERE owner_principal_type='ou' AND owner_principal_id=$1")
    .bind(unit)
    .execute(&pool)
    .await
    .expect("cleanup owned OU workspaces");
  sqlx::query("DELETE FROM organization_unit_member WHERE unit_id=$1")
    .bind(unit)
    .execute(&pool)
    .await
    .expect("cleanup owned unit memberships");
  sqlx::query("DELETE FROM organization_unit WHERE id=$1")
    .bind(unit)
    .execute(&pool)
    .await
    .expect("cleanup owned unit");
  helpers::cleanup_users(&pool, &[owner, admin, member, manager, outsider]).await;
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users WHERE id=ANY($1)")
      .bind(&[owner, admin, member, manager, outsider][..])
      .fetch_one(&pool)
      .await
      .unwrap(),
    0
  );
  if let Err(panic) = journey {
    std::panic::resume_unwind(panic);
  }
}

#[derive(Clone, Default)]
struct InvitationTraceCapture(Arc<std::sync::Mutex<Vec<u8>>>);
impl std::io::Write for InvitationTraceCapture {
  fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
    self.0.lock().expect("invitation trace lock").extend_from_slice(bytes);
    Ok(bytes.len())
  }
  fn flush(&mut self) -> std::io::Result<()> {
    Ok(())
  }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for InvitationTraceCapture {
  type Writer = Self;
  fn make_writer(&'a self) -> Self {
    self.clone()
  }
}

// Invitation results can contain join credentials; test failures must report
// the violated invariant without dumping the response containing that secret.
async fn workspace_admin_call(app: &axum::Router, token: &str, name: &str, params: Value, success: bool) -> Value {
  let (status, reply) = helpers::mcp::request(app, token, "tools/call", json!({"name":name,"arguments":params})).await;
  assert!(
    status == axum::http::StatusCode::OK && reply.get("error").is_none(),
    "MCP ingress failed for {name}: HTTP {status}"
  );
  let reply = &reply["result"];
  assert!(
    reply["isError"].as_bool().unwrap_or(false) != success,
    "unexpected MCP outcome for {name}: isError={}, code={}",
    reply["isError"],
    reply["structuredContent"]["code"]
  );
  let body = reply["structuredContent"].clone();
  if success {
    assert!(
      serde_json::from_str::<Value>(reply["content"][0]["text"].as_str().unwrap()).unwrap() == body,
      "MCP projections differ for {name}"
    );
    let schema = &myoxus_mcp::tool_registry::find_tool(name).unwrap().output_schema;
    assert!(
      output_schema_test_support::projection_schema_accepts(schema, schema, &body),
      "invalid MCP output schema for {name}"
    );
  }
  body
}

#[tokio::test]
async fn inv_workspace_invitation_http_preserves_pending_acceptance_outbox_replay_and_join_secrecy() {
  use crate::helpers::mcp::{invoke, key};
  use futures_util::FutureExt;
  use tracing::instrument::WithSubscriber as _;
  let (app, pool, store) = helpers::setup_app_with_mcp_and_audit().await;
  let (owner, session) = helpers::seed_user(&pool, &store, "invite-owner").await;
  let (recipient, recipient_session) = helpers::seed_user(&pool, &store, "invite-recipient").await;
  let (outsider, outsider_session) = helpers::seed_user(&pool, &store, "invite-outsider").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let token = key(&app, session, &["read:workspaces", "write:workspaces"]).await;
  let reader = key(&app, session, &["read:workspaces"]).await;
  let recipient_key = key(&app, recipient_session, &["read:workspaces"]).await;
  let outsider_key = key(&app, outsider_session, &["read:workspaces", "write:workspaces"]).await;
  let capture = InvitationTraceCapture::default();
  let subscriber=tracing_subscriber::fmt().with_env_filter("off,myoxus_application::workspace=trace,myoxus_infrastructure::workspace=trace,myoxus_mcp::tools::workspace=trace")
    .with_span_events(tracing_subscriber::fmt::format::FmtSpan::NEW).with_ansi(false).without_time().with_writer(capture.clone()).finish();
  let mut secrets = Vec::new();
  let journey=std::panic::AssertUnwindSafe(async {
    let empty=workspace_admin_call(&app,&token,"workspace_invite_link_get",json!({"workspace_id":workspace}),true).await;
    assert_eq!(empty,json!({"workspaceId":workspace,"active":false,"expiresAt":null}));
    let invite=json!({"workspace_id":workspace,"user_id":recipient,"idempotency_key":"invite"});
    workspace_admin_call(&app,&reader,"workspace_member_invite",invite.clone(),false).await;
    workspace_admin_call(&app,&outsider_key,"workspace_member_invite",invite.clone(),false).await;
    let pending=workspace_admin_call(&app,&token,"workspace_member_invite",invite.clone(),true).await;
    assert_eq!(pending["status"],"Pending");assert_eq!(pending["role"],"Collaborator");
    assert!(workspace_admin_call(&app,&token,"workspace_member_invite",invite.clone(),true).await==pending);
    let intents:Vec<Value>=sqlx::query_scalar("SELECT payload FROM outbox_events WHERE event_type='invite' AND aggregate_id=$1").bind(workspace.to_string()).fetch_all(&pool).await.unwrap();
    assert_eq!(intents.len(),1);assert_eq!(intents[0]["kind"],"direct_invite");assert_eq!(intents[0]["invitedUserId"],recipient.to_string());
    invoke(&app,&recipient_key,"workspace_get",json!({"workspace_id":workspace}),false).await;
    let stolen=helpers::gql(&app,session,json!({"query":"mutation($w:String!,$i:String!){acceptInviteById(workspaceId:$w,inviteId:$i)}","variables":{"w":workspace,"i":pending["inviteId"]}})).await;
    assert!(stolen.get("errors").is_some());
    assert_eq!(sqlx::query_scalar::<_,String>("SELECT status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(recipient).fetch_one(&pool).await.unwrap(),"Pending");
    let accepted=helpers::gql(&app,recipient_session,json!({"query":"mutation($w:String!,$i:String!){acceptInviteById(workspaceId:$w,inviteId:$i)}","variables":{"w":workspace,"i":pending["inviteId"]}})).await;
    assert!(accepted.get("errors").is_none());assert_eq!(accepted["data"]["acceptInviteById"],true);
    invoke(&app,&recipient_key,"workspace_get",json!({"workspace_id":workspace}),true).await;
    assert!(workspace_admin_call(&app,&token,"workspace_member_invite",invite,true).await==pending,"replay does not change accepted membership");
    assert_eq!(sqlx::query_scalar::<_,String>("SELECT status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(recipient).fetch_one(&pool).await.unwrap(),"Accepted");
    let create=json!({"workspace_id":workspace,"expire_time":"OneDay","idempotency_key":"link"});
    for expiry in [json!(null),json!(0),json!("Never")] {
      workspace_admin_call(&app,&token,"workspace_invite_link_create",json!({"workspace_id":workspace,"expire_time":expiry,"idempotency_key":"bad-expiry"}),false).await;
    }
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM workspace_invite_links WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap(),0);
    workspace_admin_call(&app,&outsider_key,"workspace_invite_link_get",json!({"workspace_id":workspace}),false).await;
    let before=chrono::Utc::now();
    let created=workspace_admin_call(&app,&token,"workspace_invite_link_create",create.clone(),true).await;
    let expires=chrono::DateTime::parse_from_rfc3339(created["expiresAt"].as_str().unwrap()).unwrap();
    assert!(expires>=before+chrono::Duration::days(1) && expires<=chrono::Utc::now()+chrono::Duration::days(1));
    let link=created["link"].as_str().unwrap().to_owned();
    let raw=link.rsplit('/').next().unwrap().to_owned();secrets.extend([raw.clone(),link.clone()]);
    assert!(workspace_admin_call(&app,&token,"workspace_invite_link_create",create.clone(),true).await==created);
    let state=workspace_admin_call(&app,&token,"workspace_invite_link_get",json!({"workspace_id":workspace}),true).await;
    assert_eq!(state["active"],true);assert!(state["expiresAt"]==created["expiresAt"]);assert!(state.get("link").is_none() && state.get("token").is_none());
    let projected=helpers::gql(&app,session,json!({"query":"query($id:String!){workspace(id:$id){inviteLink{link expireTime}}}","variables":{"id":workspace}})).await;
    assert!(projected.get("errors").is_none());assert!(projected["data"]["workspace"]["inviteLink"]["link"].as_str()==Some(link.as_str()));
    let rows:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_invite_links WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap();assert_eq!(rows,1);
    let intents:Vec<Value>=sqlx::query_scalar("SELECT payload FROM outbox_events WHERE event_type='invite' AND aggregate_id=$1").bind(workspace.to_string()).fetch_all(&pool).await.unwrap();assert_eq!(intents.len(),2);
    assert!(intents.iter().all(|v|!v.to_string().contains(&raw) && !v.to_string().contains(&link)));
    let audit:Vec<String>=sqlx::query_scalar("SELECT row_to_json(a)::text FROM admin_audit_log a WHERE target_id=$1").bind(workspace.to_string()).fetch_all(&pool).await.unwrap();assert!(audit.iter().any(|v|v.contains("mcp.workspace.invite_link.create")));
    assert!(audit.iter().all(|v|!v.contains(&raw) && !v.contains(&link)),"audit must not retain join credentials");
    let revoke=json!({"workspace_id":workspace,"idempotency_key":"revoke"});
    let revoked=workspace_admin_call(&app,&token,"workspace_invite_link_revoke",revoke.clone(),true).await;
    assert!(workspace_admin_call(&app,&token,"workspace_invite_link_revoke",revoke,true).await==revoked);
    assert_eq!(workspace_admin_call(&app,&token,"workspace_invite_link_get",json!({"workspace_id":workspace}),true).await["active"],false);
    let refused=helpers::gql(&app,outsider_session,json!({"query":"mutation($w:String!,$i:String!){acceptWorkspaceInvite(workspaceId:$w,inviteId:$i)}","variables":{"w":workspace,"i":raw}})).await;assert!(refused.get("errors").is_some());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(outsider).fetch_one(&pool).await.unwrap(),0);
    assert!(workspace_admin_call(&app,&token,"workspace_invite_link_create",create,true).await==created,"historical receipt cannot reopen a revoked link");
    let expiring=workspace_admin_call(&app,&token,"workspace_invite_link_create",json!({"workspace_id":workspace,"expire_time":"OneWeek","idempotency_key":"expire"}),true).await;
    let expiring_link=expiring["link"].as_str().unwrap().to_owned();let expiring_raw=expiring_link.rsplit('/').next().unwrap().to_owned();secrets.extend([expiring_link,expiring_raw.clone()]);
    sqlx::query("UPDATE workspace_invite_links SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND revoked_at IS NULL").bind(workspace).execute(&pool).await.unwrap();
    let expired=helpers::gql(&app,outsider_session,json!({"query":"mutation($w:String!,$i:String!){acceptWorkspaceInvite(workspaceId:$w,inviteId:$i)}","variables":{"w":workspace,"i":expiring_raw}})).await;assert!(expired.get("errors").is_some());
    assert_eq!(workspace_admin_call(&app,&token,"workspace_invite_link_get",json!({"workspace_id":workspace}),true).await["active"],false);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(outsider).fetch_one(&pool).await.unwrap(),0);
    sqlx::query("UPDATE users SET status='disabled' WHERE id=$1").bind(recipient).execute(&pool).await.unwrap();
    workspace_admin_call(&app,&token,"workspace_member_invite",json!({"workspace_id":workspace,"user_id":recipient,"idempotency_key":"invite"}),false).await;
    sqlx::query("UPDATE users SET status='active' WHERE id=$1").bind(recipient).execute(&pool).await.unwrap();
    sqlx::query("UPDATE workspaces SET deleted_at=now() WHERE id=$1").bind(workspace).execute(&pool).await.unwrap();
    workspace_admin_call(&app,&token,"workspace_invite_link_create",json!({"workspace_id":workspace,"expire_time":"OneWeek","idempotency_key":"expire"}),false).await;
  }.with_subscriber(subscriber)).catch_unwind().await;
  helpers::cleanup_users(&pool, &[owner, recipient, outsider]).await;
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users WHERE id=ANY($1)")
      .bind(&[owner, recipient, outsider][..])
      .fetch_one(&pool)
      .await
      .unwrap(),
    0
  );
  if let Err(panic) = journey {
    std::panic::resume_unwind(panic);
  }
  let logs = String::from_utf8(capture.0.lock().expect("invitation trace lock").clone()).unwrap();
  assert!(
    logs.contains("get_invite_link_by_token") && logs.contains("creating invite link"),
    "capture must observe the credential paths"
  );
  assert!(
    secrets.iter().all(|secret| !logs.contains(secret)),
    "invitation tokens and URLs must not enter tracing"
  );
}

async fn workspace_governance_snapshot(pool: &sqlx::PgPool, workspace: Uuid) -> Value {
  sqlx::query_scalar("SELECT jsonb_build_object('workspace',to_jsonb(w),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.user_id) FROM workspace_memberships m WHERE m.workspace_id=w.id),'links',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.unit_id) FROM organization_unit_workspace l WHERE l.workspace_id=w.id)) FROM workspaces w WHERE w.id=$1")
    .bind(workspace).fetch_one(pool).await.expect("read exact governance snapshot")
}

#[tokio::test]
async fn inv_workspace_governance_http_preserves_explicit_modes_atomic_principals_and_management() {
  use crate::helpers::mcp::{invoke, key};
  use futures_util::FutureExt;
  let (app, pool, store) = helpers::setup_app_with_mcp_and_audit().await;
  let (owner, owner_session) = helpers::seed_user(&pool, &store, "transfer-owner").await;
  let (target, target_session) = helpers::seed_user(&pool, &store, "transfer-target").await;
  let (admin, admin_session) = helpers::seed_admin(&pool, &store).await;
  let (manager, manager_session) = helpers::seed_user(&pool, &store, "transfer-manager").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let conflict = helpers::create_workspace(&pool, target).await;
  let fault = helpers::create_workspace(&pool, owner).await;
  let org = helpers::default_organization_id(&pool).await;
  let kind=sqlx::query_scalar::<_,Uuid>("SELECT id FROM organization_unit_type WHERE is_active AND can_be_root_level AND can_own_workspaces ORDER BY key LIMIT 1").fetch_one(&pool).await.unwrap();
  let unit = helpers::create_organization_unit(&pool, org, kind, None, "MCP owner unit").await;
  let management = helpers::create_organization_unit(&pool, org, kind, None, "MCP management unit").await;
  let journey=std::panic::AssertUnwindSafe(async {
    let actor=key(&app,owner_session,&["read:workspaces","write:workspaces"]).await;
    let recipient=key(&app,target_session,&["read:workspaces","write:workspaces"]).await;
    let operator=key(&app,admin_session,&["read:workspaces","write:workspaces","write:organization"]).await;
    let effective=key(&app,manager_session,&["read:workspaces","write:workspaces"]).await;
    let reader=key(&app,owner_session,&["read:workspaces"]).await;
    invoke(&app,&operator,"workspace_member_add",json!({"workspace_id":workspace,"user_id":target,"role":"Reader","idempotency_key":"member"}),true).await;
    invoke(&app,&operator,"organization_unit_member_add",json!({"unit_id":unit,"user_id":manager,"role":"manager","idempotency_key":"manager"}),true).await;
    let human=json!({"workspace_id":workspace,"mode":"member","user_id":target,"idempotency_key":"human"});
    let principal=json!({"workspace_id":workspace,"mode":"principal","owner_unit_id":unit,"idempotency_key":"unit"});
    let before=workspace_governance_snapshot(&pool,workspace).await;
    workspace_admin_call(&app,&reader,"workspace_owner_transfer",human.clone(),false).await;
    workspace_admin_call(&app,&recipient,"workspace_owner_transfer",human.clone(),false).await;
    workspace_admin_call(&app,&actor,"workspace_owner_transfer",principal.clone(),false).await;
    for args in [json!({"workspace_id":workspace,"mode":"member","owner_unit_id":unit,"idempotency_key":"wrong-mode"}),json!({"workspace_id":workspace,"mode":"principal","user_id":target,"owner_unit_id":unit,"idempotency_key":"two-targets"}),json!({"workspace_id":workspace,"mode":"principal","idempotency_key":"no-target"})] {
      workspace_admin_call(&app,&operator,"workspace_owner_transfer",args,false).await;
    }
    assert_eq!(workspace_governance_snapshot(&pool,workspace).await,before,"denied/invalid modes are zero-write");
    // Keep the deliberately failed admission separate from the valid journey.
    // The shared non-document guard conservatively retains failed admissions.
    invoke(&app,&operator,"workspace_member_add",json!({"workspace_id":fault,"user_id":target,"role":"Reader","idempotency_key":"conflict-member"}),true).await;
    sqlx::query("UPDATE workspaces SET name=(SELECT name FROM workspaces WHERE id=$1) WHERE id=$2").bind(fault).bind(conflict).execute(&pool).await.unwrap();
    let conflict_before=workspace_governance_snapshot(&pool,fault).await;
    let conflicting=json!({"workspace_id":fault,"mode":"member","user_id":target,"idempotency_key":"conflict"});
    let refused=workspace_admin_call(&app,&actor,"workspace_owner_transfer",conflicting.clone(),false).await;
    assert!(refused["message"].as_str().unwrap().contains("XWS_WORKSPACE_NAME_CONFLICT"));
    let fenced=workspace_admin_call(&app,&actor,"workspace_owner_transfer",conflicting,false).await;
    assert_eq!(fenced["code"],"RECOVERY_REQUIRED");assert_eq!(fenced["retryable"],false);
    assert_eq!(workspace_governance_snapshot(&pool,fault).await,conflict_before,"name conflict rolls back principal and roles");
    let transferred=workspace_admin_call(&app,&actor,"workspace_owner_transfer",human.clone(),true).await;
    assert_eq!(transferred["ownerPrincipalId"],target.to_string());
    let roles:Vec<(Uuid,String)>=sqlx::query_as("SELECT user_id,role FROM workspace_memberships WHERE workspace_id=$1 ORDER BY user_id").bind(workspace).fetch_all(&pool).await.unwrap();
    assert!(roles.contains(&(owner,"Admin".into())) && roles.contains(&(target,"Owner".into())));
    let after=workspace_governance_snapshot(&pool,workspace).await;
    workspace_admin_call(&app,&actor,"workspace_owner_transfer",human.clone(),false).await;
    assert_eq!(workspace_governance_snapshot(&pool,workspace).await,after,"former owner cannot replay TransferOwner");
    let returned=helpers::gql(&app,target_session,json!({"query":"mutation($w:String!,$u:String!){grantMember(workspaceId:$w,userId:$u,permission:Owner)}","variables":{"w":workspace,"u":owner}})).await;
    assert!(returned.get("errors").is_none());assert_eq!(returned["data"]["grantMember"],true);
    let restored=workspace_governance_snapshot(&pool,workspace).await;
    assert_eq!(workspace_admin_call(&app,&actor,"workspace_owner_transfer",human,true).await,transferred);
    assert_eq!(workspace_governance_snapshot(&pool,workspace).await,restored,"authorized historical replay never transfers again");
    let owned=workspace_admin_call(&app,&operator,"workspace_owner_transfer",principal.clone(),true).await;
    assert_eq!(owned["ownerPrincipalType"],"ou");assert_eq!(owned["ownerPrincipalId"],unit.to_string());
    assert_eq!(workspace_admin_call(&app,&operator,"workspace_owner_transfer",principal.clone(),true).await,owned);
    let classified=helpers::gql(&app,owner_session,json!({"query":"query($id:String!){workspace(id:$id){workspaceType}}","variables":{"id":workspace}})).await;
    assert!(classified.get("errors").is_none());assert_eq!(classified["data"]["workspace"]["workspaceType"],"Shared");
    let state=workspace_governance_snapshot(&pool,workspace).await;
    assert_eq!(state["workspace"]["owner_user_id"],json!(null));assert_eq!(state["workspace"]["management_unit_id"],unit.to_string());
    assert!(state["members"].as_array().unwrap().iter().all(|m|m["role"]!="Owner"));
    assert_eq!(state["links"][0]["relationship"],"owner");
    invoke(&app,&effective,"workspace_member_list",json!({"workspace_id":workspace}),true).await;
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(manager).fetch_one(&pool).await.unwrap(),0);
    workspace_admin_call(&app,&effective,"workspace_owner_transfer",principal.clone(),false).await;
    let set=json!({"workspace_id":workspace,"unit_id":management,"idempotency_key":"manage"});
    workspace_admin_call(&app,&effective,"workspace_management_unit_set",set.clone(),false).await;
    workspace_admin_call(&app,&actor,"workspace_management_unit_set",set.clone(),false).await;
    assert_eq!(workspace_governance_snapshot(&pool,workspace).await,state,"OU and Workspace roles do not confer global authority");
    let managed=workspace_admin_call(&app,&operator,"workspace_management_unit_set",set.clone(),true).await;
    assert_eq!(managed["managementUnitId"],management.to_string());assert_eq!(workspace_admin_call(&app,&operator,"workspace_management_unit_set",set,true).await,managed);
    let state=workspace_governance_snapshot(&pool,workspace).await;
    assert_eq!(state["workspace"]["owner_principal_id"],unit.to_string());assert_eq!(state["links"].as_array().unwrap().len(),2);
    workspace_admin_call(&app,&operator,"workspace_management_unit_set",json!({"workspace_id":workspace,"unit_id":null,"idempotency_key":"clear"}),true).await;
    let state=workspace_governance_snapshot(&pool,workspace).await;
    assert_eq!(state["workspace"]["management_unit_id"],json!(null));assert_eq!(state["links"].as_array().unwrap().len(),1);assert_eq!(state["links"][0]["relationship"],"owner");
    invoke(&app,&effective,"workspace_member_list",json!({"workspace_id":workspace}),true).await;
    let back=json!({"workspace_id":workspace,"mode":"principal","user_id":target,"idempotency_key":"back"});
    workspace_admin_call(&app,&operator,"workspace_owner_transfer",back.clone(),true).await;
    let state=workspace_governance_snapshot(&pool,workspace).await;
    assert_eq!(state["workspace"]["owner_principal_type"],"user");assert_eq!(state["workspace"]["owner_principal_id"],target.to_string());assert_eq!(state["links"],json!(null));
    invoke(&app,&effective,"workspace_member_list",json!({"workspace_id":workspace}),false).await;
    let projected=helpers::gql(&app,admin_session,json!({"query":"query($id:String!){admin{adminWorkspace(id:$id){ownerPrincipalType ownerPrincipalId}}}","variables":{"id":workspace}})).await;
    assert!(projected.get("errors").is_none());assert_eq!(projected["data"]["admin"]["adminWorkspace"]["ownerPrincipalId"],target.to_string());
    sqlx::query("UPDATE organization_unit SET status='disabled' WHERE id=$1").bind(unit).execute(&pool).await.unwrap();
    workspace_admin_call(&app,&operator,"workspace_owner_transfer",principal.clone(),false).await;
    workspace_admin_call(&app,&operator,"workspace_management_unit_set",json!({"workspace_id":workspace,"unit_id":unit,"idempotency_key":"inactive-unit"}),false).await;
    assert_eq!(workspace_governance_snapshot(&pool,workspace).await,state,"inactive units are zero-write including replay");
    sqlx::query("UPDATE organization_unit SET status='active' WHERE id=$1").bind(unit).execute(&pool).await.unwrap();
    sqlx::query("UPDATE users SET status='disabled' WHERE id=$1").bind(target).execute(&pool).await.unwrap();
    workspace_admin_call(&app,&operator,"workspace_owner_transfer",back,false).await;
    assert_eq!(workspace_governance_snapshot(&pool,workspace).await,state,"inactive owner target cannot authorize replay");
    sqlx::query("UPDATE users SET status='active' WHERE id=$1").bind(target).execute(&pool).await.unwrap();
    // A disabled sole human owner cannot supply an active Admin to OU transfer.
    sqlx::query("UPDATE users SET status='disabled' WHERE id=$1").bind(owner).execute(&pool).await.unwrap();
    let empty_admin=workspace_governance_snapshot(&pool,fault).await;
    workspace_admin_call(&app,&operator,"workspace_owner_transfer",json!({"workspace_id":fault,"mode":"principal","owner_unit_id":unit,"idempotency_key":"last-admin"}),false).await;
    assert_eq!(workspace_governance_snapshot(&pool,fault).await,empty_admin,"last active Admin refusal rolls back the aggregate");
    sqlx::query("UPDATE users SET status='active' WHERE id=$1").bind(owner).execute(&pool).await.unwrap();
    sqlx::query("UPDATE workspaces SET is_personal_workspace=true WHERE id=$1").bind(fault).execute(&pool).await.unwrap();
    let personal=workspace_governance_snapshot(&pool,fault).await;
    workspace_admin_call(&app,&operator,"workspace_owner_transfer",json!({"workspace_id":fault,"mode":"principal","user_id":target,"idempotency_key":"personal"}),false).await;
    assert_eq!(workspace_governance_snapshot(&pool,fault).await,personal,"personal ownership cannot be transferred");
    sqlx::query("UPDATE users SET is_admin=false WHERE id=$1").bind(admin).execute(&pool).await.unwrap();
    workspace_admin_call(&app,&operator,"workspace_owner_transfer",principal,false).await;
    workspace_admin_call(&app,&operator,"workspace_management_unit_set",json!({"workspace_id":workspace,"unit_id":null,"idempotency_key":"clear"}),false).await;
    assert_eq!(workspace_governance_snapshot(&pool,workspace).await,state,"demoted admin cannot execute or replay governance writes");
  }).catch_unwind().await;
  sqlx::query("DELETE FROM outbox_events WHERE aggregate_id=ANY($1)")
    .bind(&[workspace.to_string(), conflict.to_string(), fault.to_string()][..])
    .execute(&pool)
    .await
    .expect("cleanup governance intents");
  sqlx::query("DELETE FROM workspaces WHERE id=ANY($1)")
    .bind(&[workspace, conflict, fault][..])
    .execute(&pool)
    .await
    .expect("cleanup governance workspaces");
  sqlx::query("DELETE FROM organization_unit_member WHERE unit_id=ANY($1)")
    .bind(&[unit, management][..])
    .execute(&pool)
    .await
    .expect("cleanup governance OU memberships");
  sqlx::query("DELETE FROM organization_unit WHERE id=ANY($1)")
    .bind(&[unit, management][..])
    .execute(&pool)
    .await
    .expect("cleanup governance units");
  helpers::cleanup_users(&pool, &[owner, target, admin, manager]).await;
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users WHERE id=ANY($1)")
      .bind(&[owner, target, admin, manager][..])
      .fetch_one(&pool)
      .await
      .unwrap(),
    0
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM organization_unit WHERE id=ANY($1)")
      .bind(&[unit, management][..])
      .fetch_one(&pool)
      .await
      .unwrap(),
    0
  );
  if let Err(panic) = journey {
    std::panic::resume_unwind(panic);
  }
}

/// Persisted comment pages share GraphQL filtering, attribution and document ACLs.
#[tokio::test]
async fn inv_comment_reads_http_share_filtered_pages_history_and_document_binding() {
  use crate::helpers::mcp::key;
  use futures_util::FutureExt;
  let (app, pool, store) = helpers::setup_comment_app(true).await;
  let (owner, session) = helpers::seed_user(&pool, &store, "mcp-comments-owner").await;
  let (writer, writer_session) = helpers::seed_user(&pool, &store, "mcp-comments-writer").await;
  let (outsider, outside_session) = helpers::seed_user(&pool, &store, "mcp-comments-outsider").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let foreign_workspace = helpers::create_workspace(&pool, outsider).await;
  let doc = helpers::create_doc(&pool, workspace, owner).await;
  let second = helpers::create_doc(&pool, workspace, owner).await;
  let foreign = helpers::create_doc(&pool, foreign_workspace, outsider).await;
  let journey=std::panic::AssertUnwindSafe(async {
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'Collaborator','Accepted')").bind(workspace).bind(writer).execute(&pool).await.unwrap();
    sqlx::query("UPDATE docs SET external_id='comments-external' WHERE id=$1").bind(doc).execute(&pool).await.unwrap();
    // Administrative scopes are issued only to a current global administrator.
    sqlx::query("UPDATE users SET is_admin=true WHERE id=$1").bind(owner).execute(&pool).await.unwrap();
    let token=key(&app,session,&["read:docs","write:users"]).await;
    let wrong_scope=key(&app,session,&["read:workspaces"]).await;
    let outside_key=key(&app,outside_session,&["read:docs"]).await;
    async fn create(app:&axum::Router,session:Uuid,w:Uuid,doc:&str,parent:Option<&str>,text:&str)->String {
      let response=helpers::gql(app,session,json!({"query":"mutation($w:String!,$d:String!,$p:String,$b:JSON!){createComment(workspaceId:$w,docId:$d,parentCommentId:$p,body:$b){id}}","variables":{"w":w,"d":doc,"p":parent,"b":{"text":text}}})).await;
      assert!(response.get("errors").is_none(),"comment creation failed: {response}");response["data"]["createComment"]["id"].as_str().unwrap().to_owned()
    }
    let resolved=create(&app,writer_session,workspace,"comments-external",None,"first resolved").await;
    let edited=helpers::gql(&app,writer_session,json!({"query":"mutation($id:String!){updateComment(commentId:$id,body:{text:\"historical edit\"})}","variables":{"id":resolved}})).await;
    assert!(edited.get("errors").is_none());assert_eq!(edited["data"]["updateComment"],true);
    let closed=helpers::gql(&app,session,json!({"query":"mutation($id:String!){resolveComment(commentId:$id)}","variables":{"id":resolved}})).await;assert_eq!(closed["data"]["resolveComment"],true);
    let open1=create(&app,session,workspace,"comments-external",None,"second open").await;
    let open2=create(&app,session,workspace,"comments-external",None,"third open").await;
    let reply=create(&app,writer_session,workspace,"comments-external",Some(&open1),"reply body").await;
    let foreign_id=create(&app,outside_session,foreign_workspace,&foreign.to_string(),None,"foreign secret").await;
    let same_ws_id=create(&app,session,workspace,&second.to_string(),None,"other document secret").await;
    let input=json!({"workspace_id":workspace,"external_id":"comments-external","limit":1});
    for (filter,ids) in [("all",vec![resolved.clone(),open1.clone(),open2.clone()]),("open",vec![open1.clone(),open2.clone()]),("resolved",vec![resolved.clone()]),("mine",vec![open1.clone(),open2.clone()])] {
      for (offset,id) in ids.iter().enumerate() {
        let page=workspace_admin_call(&app,&token,"comment_thread_list",json!({"workspace_id":workspace,"external_id":"comments-external","filter":filter,"offset":offset,"limit":1}),true).await;
        assert_eq!(page["threads"].as_array().unwrap().len(),1);assert_eq!(page["threads"][0]["id"],*id);assert_eq!(page["next_offset"],offset+1);
        let graph=helpers::gql(&app,session,json!({"query":"query($w:String!,$d:String!,$f:CommentThreadFilter!,$s:Int!){commentThreads(workspaceId:$w,docId:$d,filter:$f,skip:$s,take:1){id body resolved unread}}","variables":{"w":workspace,"d":"comments-external","f":format!("{}{}",filter[..1].to_uppercase(),&filter[1..]),"s":offset}})).await;
        assert!(graph.get("errors").is_none(),"{graph}");assert_eq!(graph["data"]["commentThreads"][0]["id"],page["threads"][0]["id"]);assert_eq!(graph["data"]["commentThreads"][0]["body"],page["threads"][0]["body"]);
      }
      let end=workspace_admin_call(&app,&token,"comment_thread_list",json!({"workspace_id":workspace,"external_id":"comments-external","filter":filter,"offset":ids.len(),"limit":1}),true).await;assert_eq!(end["threads"],json!([]));assert_eq!(end["next_offset"],Value::Null);
    }
    let replies=workspace_admin_call(&app,&token,"comment_reply_list",json!({"workspace_id":workspace,"external_id":"comments-external","parent_comment_id":open1}),true).await;
    assert_eq!(replies["replies"][0]["id"],reply);assert_eq!(replies["replies"][0]["body"],json!({"text":"reply body"}));
    let history=workspace_admin_call(&app,&token,"comment_history_list",json!({"workspace_id":workspace,"external_id":"comments-external","comment_id":resolved}),true).await;
    assert_eq!(history["history"][0]["body"],json!({"text":"first resolved"}));assert_eq!(history["history"][0]["editor"]["id"],writer.to_string());
    let graph=helpers::gql(&app,session,json!({"query":"query($w:String!,$d:String!,$id:String!){commentEditHistory(workspaceId:$w,docId:$d,commentId:$id){body editedAt}}","variables":{"w":workspace,"d":"comments-external","id":resolved}})).await;assert!(graph.get("errors").is_none(),"{graph}");assert_eq!(graph["data"]["commentEditHistory"][0]["body"],history["history"][0]["body"]);
    for target in [foreign_id,same_ws_id] {
      for (tool,param) in [("comment_reply_list","parent_comment_id"),("comment_history_list","comment_id")] {
        let mut args=input.clone();args[param]=json!(target);
        let denied=workspace_admin_call(&app,&token,tool,args,false).await;assert_eq!(denied["code"],"PERMISSION_DENIED");assert!(!denied.to_string().contains("secret"));
      }
    }
    workspace_admin_call(&app,&wrong_scope,"comment_thread_list",input.clone(),false).await;
    workspace_admin_call(&app,&outside_key,"comment_thread_list",input.clone(),false).await;
    for bad in [json!({"limit":0}),json!({"limit":201}),json!({"offset":-1}),json!({"filter":null}),json!({"unknown":true})] {
      let mut args=input.clone();args.as_object_mut().unwrap().extend(bad.as_object().unwrap().clone());workspace_admin_call(&app,&token,"comment_thread_list",args,false).await;
    }
    // Terminal identity retains display attribution, while its operational
    // credentials/account details disappear through the shipped deletion owner.
    sqlx::query("UPDATE users SET is_admin=true WHERE id=$1").bind(owner).execute(&pool).await.unwrap();
    let name:String=sqlx::query_scalar("SELECT name FROM users WHERE id=$1").bind(writer).fetch_one(&pool).await.unwrap();
    workspace_admin_call(&app,&token,"user_delete",json!({"user_id":writer,"confirmed_user_id":writer,"idempotency_key":"delete-author"}),true).await;
    let page=workspace_admin_call(&app,&token,"comment_thread_list",input.clone(),true).await;
    assert_eq!(page["threads"][0]["author"],json!({"id":writer,"name":name}));assert!(!page["threads"][0]["author"].to_string().contains("email"));
    let nested=helpers::gql(&app,session,json!({"query":"query($w:String!,$d:String!){workspace(id:$w){comments(docId:$d,pagination:{first:10}){edges{node{id user{id name}}}}}}","variables":{"w":workspace,"d":"comments-external"}})).await;assert!(nested.get("errors").is_none(),"{nested}");assert_eq!(nested["data"]["workspace"]["comments"]["edges"][0]["node"]["user"]["name"],name);
    sqlx::query("UPDATE docs SET deleted_at=now() WHERE id=$1").bind(doc).execute(&pool).await.unwrap();workspace_admin_call(&app,&token,"comment_thread_list",input,false).await;
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[owner, writer, outsider]).await;
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users WHERE id=ANY($1)")
      .bind(&[owner, writer, outsider][..])
      .fetch_one(&pool)
      .await
      .unwrap(),
    0
  );
  if let Err(panic) = journey {
    std::panic::resume_unwind(panic);
  }
}

/// Shared context creation preserves actual bindings, notification intents and
/// conservative recovery after a storage failure following durable creation.
#[tokio::test]
async fn inv_comment_creation_http_preserves_context_outbox_and_uncertain_replay() {
  use crate::helpers::mcp::key;
  use futures_util::FutureExt;
  let (app, pool, store) = helpers::setup_comment_app(true).await;
  let (owner, session) = helpers::seed_user(&pool, &store, "comment-create-owner").await;
  let (recipient, recipient_session) = helpers::seed_user(&pool, &store, "comment-create-recipient").await;
  let (outsider, outside_session) = helpers::seed_user(&pool, &store, "comment-create-outsider").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let doc = helpers::create_doc(&pool, workspace, owner).await;
  let fault = helpers::create_doc(&pool, workspace, owner).await;
  let trigger = format!("mcp_comment_partial_{}", Uuid::new_v4().simple());
  let journey=std::panic::AssertUnwindSafe(async {
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'Collaborator','Accepted')").bind(workspace).bind(recipient).execute(&pool).await.unwrap();
    sqlx::query("UPDATE docs SET external_id=CASE WHEN id=$1 THEN 'comments-create' ELSE 'comments-fault' END WHERE id=ANY($2)").bind(doc).bind(&[doc,fault][..]).execute(&pool).await.unwrap();
    let token=key(&app,session,&["read:docs","write:docs"]).await;
    let recipient_key=key(&app,recipient_session,&["read:docs","write:docs"]).await;
    let reader=key(&app,session,&["read:docs"]).await;
    let outside_key=key(&app,outside_session,&["write:docs"]).await;
    async fn upload(app:&axum::Router,session:Uuid,w:Uuid,doc:&str)->String {
      use axum::{body::Body,http::Request};use http_body_util::BodyExt;use tower::ServiceExt;
      let boundary=format!("attachment-{}",Uuid::new_v4());
      let operations=json!({"query":"mutation($w:String!,$d:String!,$a:Upload!){uploadCommentAttachment(workspaceId:$w,docId:$d,attachment:$a)}","variables":{"w":w,"d":doc,"a":null}});
      let body=format!("--{boundary}\r\nContent-Disposition: form-data; name=\"operations\"\r\n\r\n{operations}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"map\"\r\n\r\n{{\"0\":[\"variables.a\"]}}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"0\"; filename=\"comment.txt\"\r\nContent-Type: text/plain\r\n\r\nattachment content\r\n--{boundary}--\r\n");
      let response=app.clone().oneshot(Request::builder().method("POST").uri("/graphql").header("cookie",format!("affine_session={session}")).header("content-type",format!("multipart/form-data; boundary={boundary}")).body(Body::from(body)).unwrap()).await.unwrap();
      let response:Value=serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();assert!(response.get("errors").is_none(),"{response}");response["data"]["uploadCommentAttachment"].as_str().unwrap().to_owned()
    }
    let attachment=upload(&app,session,workspace,"comments-create").await;
    let foreign_attachment=upload(&app,session,workspace,"comments-fault").await;
    let foreign_parent=helpers::gql(&app,session,json!({"query":r#"mutation($w:String!,$d:String!){createComment(workspaceId:$w,docId:$d,body:{text:"other document parent"}){id}}"#,"variables":{"w":workspace,"d":"comments-fault"}})).await;
    assert!(foreign_parent.get("errors").is_none(),"{foreign_parent}");
    let parent_id=foreign_parent["data"]["createComment"]["id"].as_str().unwrap();
    let input=json!({"workspace_id":workspace,"external_id":"comments-create","body":{"text":"canonical private creation body"},"attachment_keys":[attachment],"selection_anchor":{"quote":"selected","start":7,"end":15},"doc_text":"prefix selected suffix","idempotency_key":"root"});
    workspace_admin_call(&app,&reader,"comment_create",input.clone(),false).await;
    workspace_admin_call(&app,&outside_key,"comment_create",input.clone(),false).await;
    let mut keyless=input.clone();keyless.as_object_mut().unwrap().remove("idempotency_key");workspace_admin_call(&app,&token,"comment_create",keyless,false).await;
    for patch in [json!({"parent_comment_id":parent_id}),json!({"parent_comment_id":Uuid::new_v4()}),json!({"attachment_keys":[foreign_attachment]}),json!({"selection_anchor":{"quote":"missing"}}),json!({"attachment_keys":[attachment,attachment]}),json!({"extra":true})] {
      let mut bad=input.clone();bad.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());workspace_admin_call(&app,&token,"comment_create",bad,false).await;
    }
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM comments WHERE doc_id=$1").bind(doc).fetch_one(&pool).await.unwrap(),0,"available preconditions fail before creation");
    let created=workspace_admin_call(&app,&token,"comment_create",input.clone(),true).await;
    assert_eq!(created["attachmentKeys"],json!([attachment]));assert_eq!(created["selectionAnchor"]["quote"],"selected");assert_eq!(created["selectionAnchor"]["strategy"],"direct_range");
    assert_eq!(workspace_admin_call(&app,&token,"comment_create",input.clone(),true).await,created);
    let id=Uuid::parse_str(created["commentId"].as_str().unwrap()).unwrap();
    assert_eq!(sqlx::query_scalar::<_,Option<Uuid>>("SELECT comment_id FROM comment_attachments WHERE workspace_id=$1 AND storage_key=$2").bind(workspace).bind(&attachment).fetch_one(&pool).await.unwrap(),Some(id));
    let anchor:Value=sqlx::query_scalar("SELECT selection_anchor FROM comments WHERE id=$1").bind(id).fetch_one(&pool).await.unwrap();assert_eq!(anchor,created["selectionAnchor"]);
    let graph=helpers::gql(&app,session,json!({"query":"query($w:String!,$d:String!){workspace(id:$w){comments(docId:$d,pagination:{first:10}){edges{node{id content}}}}}","variables":{"w":workspace,"d":"comments-create"}})).await;assert!(graph.get("errors").is_none(),"{graph}");assert_eq!(graph["data"]["workspace"]["comments"]["edges"][0]["node"]["content"],input["body"]);
    let graph_attachment=upload(&app,session,workspace,"comments-create").await;
    let composed=helpers::gql(&app,session,json!({"query":r#"mutation($w:String!,$d:String!,$keys:[String!]){createComment(workspaceId:$w,docId:$d,body:{text:"shared GraphQL creation"},attachmentKeys:$keys,selectionAnchor:{quote:"selected",start:7,end:15},docText:"prefix selected suffix"){id content}}"#,"variables":{"w":workspace,"d":"comments-create","keys":[graph_attachment]}})).await;
    assert!(composed.get("errors").is_none(),"{composed}");assert_eq!(composed["data"]["createComment"]["content"],json!({"text":"shared GraphQL creation"}));
    let graph_id=Uuid::parse_str(composed["data"]["createComment"]["id"].as_str().unwrap()).unwrap();
    assert_eq!(sqlx::query_scalar::<_,Option<Uuid>>("SELECT comment_id FROM comment_attachments WHERE workspace_id=$1 AND storage_key=$2").bind(workspace).bind(&graph_attachment).fetch_one(&pool).await.unwrap(),Some(graph_id));
    assert_eq!(sqlx::query_scalar::<_,Value>("SELECT selection_anchor FROM comments WHERE id=$1").bind(graph_id).fetch_one(&pool).await.unwrap(),created["selectionAnchor"]);
    let rejected=helpers::gql(&app,session,json!({"query":r#"mutation($w:String!,$d:String!,$keys:[String!]){createComment(workspaceId:$w,docId:$d,body:{text:"reject foreign attachment"},attachmentKeys:$keys){id}}"#,"variables":{"w":workspace,"d":"comments-create","keys":[foreign_attachment]}})).await;assert!(rejected.get("errors").is_some());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM comments WHERE doc_id=$1").bind(doc).fetch_one(&pool).await.unwrap(),2);
    let reply=workspace_admin_call(&app,&recipient_key,"comment_create",json!({"workspace_id":workspace,"external_id":"comments-create","parent_comment_id":id,"body":{"text":"canonical reply"},"idempotency_key":"reply"}),true).await;
    let reply_id=Uuid::parse_str(reply["commentId"].as_str().unwrap()).unwrap();
    let mention_input=json!({"workspace_id":workspace,"external_id":"comments-create","body":{"ops":[{"insert":"mention","attributes":{"mention":{"member":recipient}}}]},"idempotency_key":"mention"});
    let mention=workspace_admin_call(&app,&token,"comment_create",mention_input.clone(),true).await;assert_eq!(workspace_admin_call(&app,&token,"comment_create",mention_input,true).await,mention);
    let intents:Vec<(String,String)>=sqlx::query_as("SELECT event_type::text,payload->>'userId' FROM outbox_events WHERE payload->>'commentId' IN ($1,$2) ORDER BY event_type").bind(reply_id.to_string()).bind(mention["commentId"].as_str().unwrap()).fetch_all(&pool).await.unwrap();assert_eq!(intents.len(),2,"one durable intent per recipient/comment");
    assert!(intents.contains(&("comment_reply".into(),owner.to_string())));assert!(intents.contains(&("mention".into(),recipient.to_string())));
    let combined=workspace_admin_call(&app,&token,"comment_create",json!({"workspace_id":workspace,"external_id":"comments-create","parent_comment_id":reply_id,"body":{"ops":[{"insert":"mention reply","attributes":{"mention":{"member":recipient}}}]},"idempotency_key":"combined"}),true).await;
    let combined_intents:Vec<(String,String)>=sqlx::query_as("SELECT event_type::text,payload->>'userId' FROM outbox_events WHERE payload->>'commentId'=$1").bind(combined["commentId"].as_str().unwrap()).fetch_all(&pool).await.unwrap();assert_eq!(combined_intents,vec![("mention".into(),recipient.to_string())],"reply/mention union is deduplicated through its owner");
    let audit:Value=sqlx::query_scalar("SELECT coalesce(json_agg(row_to_json(a)),'[]') FROM admin_audit_log a WHERE event_key='mcp.comment.create' AND target_id=$1").bind(id.to_string()).fetch_one(&pool).await.unwrap();assert!(!audit.as_array().unwrap().is_empty());assert!(!audit.to_string().contains("canonical private creation body"));assert!(!audit.to_string().contains("prefix selected suffix"));assert!(!audit.to_string().contains(&attachment));
    let mut changed=input.clone();changed["body"]=json!({"text":"changed body"});assert_eq!(workspace_admin_call(&app,&token,"comment_create",changed,false).await["code"],"CONFLICT");
    // Fail only this disposable document's attachment update, after the
    // comment/outbox commit, then prove retry cannot create or repair it.
    sqlx::query(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.doc_id='{fault}' THEN RAISE EXCEPTION 'private-comment-attachment-failure'; END IF; RETURN NEW; END $$")).execute(&pool).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE UPDATE ON comment_attachments FOR EACH ROW EXECUTE FUNCTION {trigger}()")).execute(&pool).await.unwrap();
    let partial=json!({"workspace_id":workspace,"external_id":"comments-fault","body":{"text":"uncertain body"},"attachment_keys":[foreign_attachment],"idempotency_key":"partial"});
    let failed=workspace_admin_call(&app,&token,"comment_create",partial.clone(),false).await;assert_eq!(failed["code"],"RECOVERY_REQUIRED");assert_eq!(failed["retryable"],false);assert!(!failed.to_string().contains("private-comment-attachment-failure"));
    sqlx::query(&format!("DROP TRIGGER {trigger} ON comment_attachments")).execute(&pool).await.unwrap();
    assert_eq!(workspace_admin_call(&app,&token,"comment_create",partial,false).await["code"],"RECOVERY_REQUIRED");
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM comments WHERE doc_id=$1 AND body->>'text'='uncertain body'").bind(fault).fetch_one(&pool).await.unwrap(),1);
    assert_eq!(sqlx::query_scalar::<_,Option<Uuid>>("SELECT comment_id FROM comment_attachments WHERE workspace_id=$1 AND storage_key=$2").bind(workspace).bind(&foreign_attachment).fetch_one(&pool).await.unwrap(),None);
    sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(recipient).execute(&pool).await.unwrap();
    let retry=json!({"workspace_id":workspace,"external_id":"comments-create","parent_comment_id":id,"body":{"text":"canonical reply"},"idempotency_key":"reply"});workspace_admin_call(&app,&recipient_key,"comment_create",retry,false).await;
  }).catch_unwind().await;
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger} ON comment_attachments"))
    .execute(&pool)
    .await
    .expect("cleanup trigger");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {trigger}()"))
    .execute(&pool)
    .await
    .expect("cleanup function");
  helpers::cleanup_users(&pool, &[owner, recipient, outsider]).await;
  let files = std::path::PathBuf::from("test-storage").join(workspace.to_string());
  if files.exists() {
    std::fs::remove_dir_all(files).expect("cleanup owned uploaded attachments");
  }
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users WHERE id=ANY($1)")
      .bind(&[owner, recipient, outsider][..])
      .fetch_one(&pool)
      .await
      .unwrap(),
    0
  );
  if let Err(panic) = journey {
    std::panic::resume_unwind(panic);
  }
}

/// Lifecycle and read-state writes share the persisted GraphQL comment owner.
#[tokio::test]
async fn inv_comment_lifecycle_http_preserves_author_history_and_unbounded_read_state() {
  use crate::helpers::mcp::key;
  use futures_util::FutureExt;
  let (app, pool, store) = helpers::setup_comment_app(true).await;
  let (owner, session) = helpers::seed_user(&pool, &store, "comment-life-owner").await;
  let (author, author_session) = helpers::seed_user(&pool, &store, "comment-life-author").await;
  let (reader, reader_session) = helpers::seed_user(&pool, &store, "comment-life-reader").await;
  let (outside, outside_session) = helpers::seed_user(&pool, &store, "comment-life-outside").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let doc = helpers::create_doc(&pool, workspace, owner).await;
  let other = helpers::create_doc(&pool, workspace, owner).await;
  let foreign_ws = helpers::create_workspace(&pool, outside).await;
  let foreign_doc = helpers::create_doc(&pool, foreign_ws, outside).await;
  let journey = std::panic::AssertUnwindSafe(async {
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'External','Accepted'),($1,$3,'Reader','Accepted')").bind(workspace).bind(author).bind(reader).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) VALUES($1,$2,'Commenter')").bind(author).bind(doc).execute(&pool).await.unwrap();
    sqlx::query("UPDATE docs SET external_id=CASE WHEN id=$1 THEN 'lifecycle' ELSE 'other' END WHERE id=ANY($2)").bind(doc).bind(&[doc,other][..]).execute(&pool).await.unwrap();
    let token = key(&app, session, &["read:docs","write:docs"]).await;
    let author_key = key(&app, author_session, &["read:docs","write:docs"]).await;
    let read_write = key(&app, reader_session, &["read:docs","write:docs"]).await;
    let read_only = key(&app, reader_session, &["read:docs"]).await;
    let outside_key = key(&app, outside_session, &["write:docs"]).await;
    let created = workspace_admin_call(&app,&author_key,"comment_create",json!({"workspace_id":workspace,"external_id":"lifecycle","body":{"text":"author original"},"idempotency_key":"create"}),true).await;
    let id = Uuid::parse_str(created["commentId"].as_str().unwrap()).unwrap();
    let reply = workspace_admin_call(&app,&author_key,"comment_create",json!({"workspace_id":workspace,"external_id":"lifecycle","parent_comment_id":id,"body":{"text":"author reply"},"idempotency_key":"reply"}),true).await;
    let reply_id = Uuid::parse_str(reply["commentId"].as_str().unwrap()).unwrap();
    let input = json!({"workspace_id":workspace,"external_id":"lifecycle","comment_id":id,"body":{"text":"author edit"},"idempotency_key":"edit"});
    for denied in [&token,&read_only,&read_write,&outside_key] { workspace_admin_call(&app,denied,"comment_update",input.clone(),false).await; }
    let mut foreign = input.clone();foreign["external_id"]=json!("other");workspace_admin_call(&app,&author_key,"comment_update",foreign,false).await;
    let mut keyless = input.clone();keyless.as_object_mut().unwrap().remove("idempotency_key");workspace_admin_call(&app,&author_key,"comment_update",keyless,false).await;
    let mut extra = input.clone();extra["extra"]=json!(true);workspace_admin_call(&app,&author_key,"comment_update",extra,false).await;
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM comment_edit_history WHERE comment_id=$1").bind(id).fetch_one(&pool).await.unwrap(),0);
    let updated = workspace_admin_call(&app,&author_key,"comment_update",input.clone(),true).await;
    assert_eq!(workspace_admin_call(&app,&author_key,"comment_update",input.clone(),true).await,updated);
    let history = workspace_admin_call(&app,&author_key,"comment_history_list",json!({"workspace_id":workspace,"external_id":"lifecycle","comment_id":id}),true).await;
    assert_eq!(history["history"].as_array().unwrap().len(),1);assert_eq!(history["history"][0]["body"],json!({"text":"author original"}));
    let mut changed = input.clone();changed["body"]=json!({"text":"conflict"});assert_eq!(workspace_admin_call(&app,&author_key,"comment_update",changed,false).await["code"],"CONFLICT");
    for flag in [true,false] {
      let args = json!({"workspace_id":workspace,"external_id":"lifecycle","comment_id":id,"resolved":flag,"idempotency_key":format!("resolve-{flag}")});
      workspace_admin_call(&app,&read_write,"comment_set_resolved",args.clone(),false).await;
      let outcome = workspace_admin_call(&app,&author_key,"comment_set_resolved",args.clone(),true).await;assert_eq!(outcome["resolved"],flag);
      assert_eq!(workspace_admin_call(&app,&author_key,"comment_set_resolved",args,true).await,outcome);
      assert_eq!(sqlx::query_scalar::<_,bool>("SELECT resolved FROM comments WHERE id=$1").bind(id).fetch_one(&pool).await.unwrap(),flag);
    }
    // SQL fixtures exercise the real bulk owner past both historical limits.
    sqlx::query("INSERT INTO comments(id,workspace_id,doc_id,author_id,body) SELECT gen_random_uuid(),$1,$2,$3,'{}'::jsonb FROM generate_series(1,205)").bind(workspace).bind(doc).bind(owner).execute(&pool).await.unwrap();
    let other_thread = Uuid::new_v4();let foreign_thread = Uuid::new_v4();let deleted = Uuid::new_v4();
    sqlx::query("INSERT INTO comments(id,workspace_id,doc_id,author_id,body) VALUES($1,$2,$3,$4,'{}'),($5,$6,$7,$8,'{}'),($9,$2,$10,$4,'{}')").bind(other_thread).bind(workspace).bind(other).bind(owner).bind(foreign_thread).bind(foreign_ws).bind(foreign_doc).bind(outside).bind(deleted).bind(doc).execute(&pool).await.unwrap();
    sqlx::query("UPDATE comments SET deleted_at=now() WHERE id=$1").bind(deleted).execute(&pool).await.unwrap();
    let mark = json!({"workspace_id":workspace,"external_id":"lifecycle","comment_id":id,"idempotency_key":"read"});
    for bad in [other_thread,foreign_thread,reply_id,deleted,Uuid::new_v4()] {
      let mut args = mark.clone();args["comment_id"]=json!(bad);
      workspace_admin_call(&app,&read_write,"comment_thread_mark_read",args,false).await;
      let graph = helpers::gql(&app,reader_session,json!({"query":"mutation($w:String!,$d:String!,$id:String!){markCommentThreadRead(workspaceId:$w,docId:$d,commentId:$id)}","variables":{"w":workspace,"d":"lifecycle","id":bad}})).await;
      assert!(graph.get("errors").is_some(),"foreign/reply/deleted/missing thread must fail through GraphQL");
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM comment_thread_read_state WHERE user_id=$1 AND thread_comment_id=$2").bind(reader).bind(bad).fetch_one(&pool).await.unwrap(),0);
    }
    workspace_admin_call(&app,&read_only,"comment_thread_mark_read",mark.clone(),false).await;
    let single = workspace_admin_call(&app,&read_write,"comment_thread_mark_read",mark.clone(),true).await;assert_eq!(single["userId"],reader.to_string());
    let stamp:chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT read_at FROM comment_thread_read_state WHERE user_id=$1 AND thread_comment_id=$2").bind(reader).bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(workspace_admin_call(&app,&read_write,"comment_thread_mark_read",mark,true).await,single);
    assert_eq!(sqlx::query_scalar::<_,chrono::DateTime<chrono::Utc>>("SELECT read_at FROM comment_thread_read_state WHERE user_id=$1 AND thread_comment_id=$2").bind(reader).bind(id).fetch_one(&pool).await.unwrap(),stamp);
    let owner_mark = json!({"workspace_id":workspace,"external_id":"lifecycle","comment_id":id,"idempotency_key":"owner-read"});workspace_admin_call(&app,&token,"comment_thread_mark_read",owner_mark,true).await;
    let owner_stamp:chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT read_at FROM comment_thread_read_state WHERE user_id=$1 AND thread_comment_id=$2").bind(owner).bind(id).fetch_one(&pool).await.unwrap();
    let bulk = json!({"workspace_id":workspace,"external_id":"lifecycle","idempotency_key":"all-read"});
    workspace_admin_call(&app,&read_only,"comment_threads_mark_all_read",bulk.clone(),false).await;
    let all = workspace_admin_call(&app,&read_write,"comment_threads_mark_all_read",bulk.clone(),true).await;assert_eq!(all["affectedThreads"],206);assert_eq!(all["userId"],reader.to_string());
    assert_eq!(workspace_admin_call(&app,&read_write,"comment_threads_mark_all_read",bulk.clone(),true).await,all);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM comment_thread_read_state WHERE user_id=$1").bind(reader).fetch_one(&pool).await.unwrap(),206);
    assert_eq!(sqlx::query_scalar::<_,chrono::DateTime<chrono::Utc>>("SELECT read_at FROM comment_thread_read_state WHERE user_id=$1 AND thread_comment_id=$2").bind(owner).bind(id).fetch_one(&pool).await.unwrap(),owner_stamp);
    let graph_all = helpers::gql(&app,session,json!({"query":"mutation($w:String!,$d:String!){markAllCommentThreadsRead(workspaceId:$w,docId:$d)}","variables":{"w":workspace,"d":"lifecycle"}})).await;assert!(graph_all.get("errors").is_none(),"{graph_all}");assert_eq!(graph_all["data"]["markAllCommentThreadsRead"],206);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM comment_thread_read_state WHERE thread_comment_id=ANY($1)").bind(&[other_thread,foreign_thread,reply_id,deleted][..]).fetch_one(&pool).await.unwrap(),0);
    let deletion = json!({"workspace_id":workspace,"external_id":"lifecycle","comment_id":id,"idempotency_key":"delete"});
    workspace_admin_call(&app,&read_write,"comment_delete",deletion.clone(),false).await;
    let removed = workspace_admin_call(&app,&author_key,"comment_delete",deletion.clone(),true).await;assert_eq!(removed["deleted"],true);assert_eq!(workspace_admin_call(&app,&author_key,"comment_delete",deletion,true).await,removed);
    assert_eq!(workspace_admin_call(&app,&author_key,"comment_history_list",json!({"workspace_id":workspace,"external_id":"lifecycle","comment_id":id}),true).await["history"],history["history"]);
    let graph = helpers::gql(&app,session,json!({"query":"query($w:String!,$d:String!){workspace(id:$w){comments(docId:$d,pagination:{first:200}){edges{node{id}}}}}","variables":{"w":workspace,"d":"lifecycle"}})).await;assert!(graph.get("errors").is_none(),"{graph}");assert!(!graph.to_string().contains(&id.to_string()));
    let audit:Value = sqlx::query_scalar("SELECT coalesce(json_agg(row_to_json(a)),'[]') FROM admin_audit_log a WHERE event_key='mcp.comment.update' AND target_id=$1").bind(id.to_string()).fetch_one(&pool).await.unwrap();assert!(!audit.as_array().unwrap().is_empty());assert!(!audit.to_string().contains("author edit"));
    sqlx::query("UPDATE doc_user_permissions SET role='Reader' WHERE user_id=$1 AND doc_id=$2").bind(author).bind(doc).execute(&pool).await.unwrap();
    workspace_admin_call(&app,&author_key,"comment_update",input,false).await;
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(reader).execute(&pool).await.unwrap();
    workspace_admin_call(&app,&read_write,"comment_threads_mark_all_read",bulk,false).await;
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[owner, author, reader, outside]).await;
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users WHERE id=ANY($1)")
      .bind(&[owner, author, reader, outside][..])
      .fetch_one(&pool)
      .await
      .unwrap(),
    0
  );
  if let Err(panic) = journey {
    std::panic::resume_unwind(panic);
  }
}
