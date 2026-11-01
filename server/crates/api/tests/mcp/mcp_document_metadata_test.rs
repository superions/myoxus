//! MCP document-metadata tool coverage.
//!
//! These tests call the dispatcher directly and keep the focus on authz,
//! server-side validation, and structured tool output.

use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

use myoxus_application::doc::DocService;
use myoxus_application::document_metadata::DocumentMetadataService;
use myoxus_application::permission::PermissionService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository;
use myoxus_infrastructure::document_metadata_policy::PgDocumentMetadataPolicyRepository;
use myoxus_infrastructure::document_version::PgDocumentVersionRepository;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_mcp::auth::McpAuthContext;
use myoxus_mcp::tools::{McpToolState, dispatch_tool as unchecked_dispatch_tool};

use crate::helpers;
use futures_util::FutureExt;
#[path = "../../../mcp/src/output_schema_test_support.rs"]
mod output_schema_test_support;

#[tokio::test]
async fn mcp_document_okf_reads_use_current_native_facts_without_writes() {
  use crate::mcp_create_page_test::{
    build_tool_state, create_workspace, document_read_call, document_read_key, document_read_router, document_read_rpc,
  };
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "okf-owner").await;
  let (denied, denied_session) = helpers::seed_user(&pool, &auth_store, "okf-denied").await;
  let workspace = create_workspace(&pool, owner).await;
  let forbidden_workspace = create_workspace(&pool, denied).await;
  let source_workspace = create_workspace(&pool, owner).await;
  let schema_id = Uuid::new_v4();
  let status_id = Uuid::new_v4();
  let mut state = build_tool_state(&pool);
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
  state.workspace_tag_service = Some(Arc::new(myoxus_application::workspace_tags::WorkspaceTagService::new(
    Arc::new(myoxus_infrastructure::workspace_tags::PgWorkspaceTagRepository::new(
      pool.clone(),
      crate::helpers::database_starter_catalog(),
    )),
    state.permission_service.clone(),
  )));
  let search = Arc::new(myoxus_infrastructure::search::SqlxSearchRepository::new(pool.clone()));
  state.search_repository = Some(search.clone());
  let docs = state.doc_service.clone();
  let app = document_read_router(&pool, state);
  let result = std::panic::AssertUnwindSafe(async {
    let token = document_read_key(&key_app, session, &["read:docs", "write:docs"]).await;
    let denied_token = document_read_key(&key_app, denied_session, &["read:docs"]).await;
    let (mut source, _) = docs.create_page_from_snapshot_with_sync_updates(workspace, owner, Some("Source title".into()),
      yjs::markdown_to_yjs("Source title", "Actual source body").unwrap()).await.unwrap();
    // Resource URIs retain opaque keys; URL decoding or fragment removal resolves another identity.
    source.external_id = format!("blob/opaque%2F?世界#{}",source.id);
    sqlx::query("UPDATE docs SET external_id=$2 WHERE id=$1")
      .bind(source.id).bind(&source.external_id).execute(&pool).await.unwrap();
    let (forbidden_source, _) = docs.create_page_from_snapshot_with_sync_updates(forbidden_workspace, denied, Some("Private source title".into()),
      yjs::markdown_to_yjs("Private source title", "Private body").unwrap()).await.unwrap();
    let (cross_source, _) = docs.create_page_from_snapshot_with_sync_updates(source_workspace, owner, Some("Cross-workspace canonical source".into()),
      yjs::markdown_to_yjs("Cross-workspace canonical source", "Cross-workspace evidence").unwrap()).await.unwrap();
    // The same opaque key exists locally: a scope fallback must never substitute it.
    sqlx::query("UPDATE docs SET external_id=$2 WHERE id=$1")
      .bind(cross_source.id).bind(&source.external_id).execute(&pool).await.unwrap();
    let body = format!("# Context\n\nOpening summary. More context 日本語.[^native][^cross][^private-native]\n\n[^native]: {{\"type\":\"doc\",\"docId\":\"{}\"}}\n\n[^cross]: {{\"type\":\"doc\",\"docId\":\"{}\",\"workspaceId\":\"{source_workspace}\",\"title\":\"Declared cross source\"}}\n\n[^private-native]: {{\"type\":\"doc\",\"docId\":\"{}\",\"workspaceId\":\"{forbidden_workspace}\",\"title\":\"Declared private source\"}}\n\n# Decision\n\nProtected section.",source.external_id,source.external_id,forbidden_source.external_id);
    let (target, _) = docs.create_page_from_snapshot_with_sync_updates(workspace, owner, Some("Native title".into()),
      yjs::markdown_to_yjs("Native title", &body).unwrap()).await.unwrap();
    sqlx::query("UPDATE docs SET meta=$2, status_source='workspace', document_type_source='workspace' WHERE id=$1")
      .bind(target.id).bind(json!({"unrelated-secret":"not forwarded","obsidian":{"properties":{
        "type":"Custom knowledge","status":"deprecated","title":"Imported title","resource":"postgres://asset/table",
        "verified":{"by":"human:verifier","at":"2026-09-01T00:00:00Z"},"generated":{"by":"process:imported-producer"},
        "sources":[{"id":"native","resource":format!("myoxus://{workspace}/{}",source.external_id),"title":"Imported source title"},
          {"id":"private","resource":format!("myoxus://{forbidden_workspace}/{}",forbidden_source.external_id)}],
        "retained_frontmatter":{"extension":"value"},"custom":{"日本語":true}}}}))
      .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO workspace_doc_view_daily(workspace_id,doc_id,date,total_views,unique_views,guest_views) VALUES($1,$2,CURRENT_DATE-1,9,4,0)")
      .bind(workspace).bind(source.id.to_string()).execute(&pool).await.unwrap();
    let before: Value = sqlx::query_scalar("SELECT to_jsonb(docs) FROM docs WHERE id=$1").bind(target.id).fetch_one(&pool).await.unwrap();
    let views_before: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(total_views),0)::BIGINT FROM workspace_doc_view_daily WHERE workspace_id=$1")
      .bind(workspace).fetch_one(&pool).await.unwrap();
    let args = json!({"workspace_id":workspace,"external_id":target.external_id,"representation":"markdown","include_okf_frontmatter":true});
    let read = document_read_call(&app,&token,"read_doc",args.clone()).await;
    output_schema_test_support::assert_required_output(&myoxus_mcp::tool_registry::find_tool("read_doc").unwrap().output_schema,&read);
    let okf = &read["okf"];
    assert_eq!(okf["frontmatter"]["type"],"Custom knowledge");
    assert_eq!(okf["frontmatter"]["status"],"deprecated");
    assert_eq!(okf["frontmatter"]["title"],"Native title");
    assert_eq!(okf["retained_frontmatter"]["title"],"Imported title");
    assert_eq!(okf["frontmatter"]["description"],"Opening summary.");
    assert_eq!(okf["frontmatter"]["resource"],"postgres://asset/table");
    assert_eq!(okf["frontmatter"]["sources"][0]["id"],"native");
    assert_eq!(okf["frontmatter"]["sources"][0]["title"],"Source title");
    assert_eq!(okf["frontmatter"]["sources"][0]["usage_count"],9);
    assert_eq!(okf["retained_frontmatter"]["sources"][0]["title"],"Imported source title");
    assert!(okf["frontmatter"]["sources"][1].get("title").is_none());
    assert!(okf["frontmatter"]["sources"][1].get("last_modified").is_none());
    assert!(okf["frontmatter"]["sources"][1].get("usage_count").is_none());
    let sources = okf["frontmatter"]["sources"].as_array().unwrap();
    let cross = sources.iter().find(|source| source["id"] == "cross").unwrap();
    assert_eq!(cross["resource"], format!("myoxus://{source_workspace}/{}", source.external_id));
    assert_eq!(cross["title"], "Cross-workspace canonical source");
    assert!(cross["last_modified"].as_str().is_some());
    let private = sources.iter().find(|source| source["id"] == "private-native").unwrap();
    assert_eq!(private["resource"], format!("myoxus://{forbidden_workspace}/{}", forbidden_source.external_id));
    assert_eq!(private["title"], "Declared private source");
    assert!(private.get("last_modified").is_none());
    assert!(private.get("usage_count").is_none());
    assert!(okf["diagnostics"].as_array().unwrap().contains(&json!("source_facts_unavailable")));
    let window = docs.analytics_window().await.unwrap().unwrap();
    assert_eq!(okf["frontmatter"]["sources"][0]["usage_window"],json!({"from":window.from.to_rfc3339(),"to":window.to.to_rfc3339()}));
    assert!(okf["frontmatter"]["generated"].get("at").is_none());
    assert_eq!(okf["frontmatter"]["verified"].as_array().unwrap().len(),1);
    assert_eq!(okf["frontmatter"]["retained_frontmatter"]["extension"],"value");
    assert!(okf["frontmatter"].get("unrelated-secret").is_none());
    assert!(read["data"].as_str().unwrap().contains("[^native]"));
    assert_eq!(before, sqlx::query_scalar::<_,Value>("SELECT to_jsonb(docs) FROM docs WHERE id=$1").bind(target.id).fetch_one(&pool).await.unwrap());
    assert_eq!(views_before, sqlx::query_scalar::<_,i64>("SELECT COALESCE(SUM(total_views),0)::BIGINT FROM workspace_doc_view_daily WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap());
    let refused = document_read_rpc(&app,&denied_token,"tools/call",json!({"name":"read_doc","arguments":args})).await;
    assert_eq!(refused["result"]["isError"],true);
    let invalid = document_read_rpc(&app,&token,"tools/call",json!({"name":"read_doc","arguments":{"workspace_id":workspace,"external_id":target.external_id,"include_okf_frontmatter":true}})).await;
    assert_eq!(invalid["result"]["isError"],true);
    sqlx::query("INSERT INTO document_status_schema(id,key,label,complexity) VALUES($1,$2,'OKF test','custom')")
      .bind(schema_id).bind(format!("okf-{schema_id}")).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO document_status_value(id,schema_id,key,label,okf_status) VALUES($1,$2,'custom','Custom','draft')")
      .bind(status_id).bind(schema_id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE docs SET status_id=$2,status_source='document',document_type_id=(SELECT id FROM document_type_definition WHERE key='decision_record'),document_type_source='document',review_due_at='2026-12-12T00:00:00Z',valid_until='2026-12-01T00:00:00Z' WHERE id=$1")
      .bind(target.id).bind(status_id).execute(&pool).await.unwrap();
    let explicit = document_read_call(&app,&token,"read_doc",args.clone()).await;
    assert_eq!(explicit["okf"]["frontmatter"]["type"],"decision_record");
    assert_eq!(explicit["okf"]["frontmatter"]["status"],"draft");
    assert_eq!(explicit["okf"]["frontmatter"]["stale_after"],"2026-12-01T00:00:00+00:00");
    sqlx::query("UPDATE document_status_value SET key='renamed',label='Renamed',terminal=true,okf_status='stable' WHERE id=$1")
      .bind(status_id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE docs SET valid_until=NULL WHERE id=$1").bind(target.id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE docs SET title='Source renamed',updated_at=now() WHERE id=$1").bind(source.id).execute(&pool).await.unwrap();
    let changed = document_read_call(&app,&token,"read_doc",args).await;
    assert_eq!(changed["okf"]["frontmatter"]["status"],"stable");
    assert_eq!(changed["okf"]["frontmatter"]["stale_after"],"2026-12-12T00:00:00+00:00");
    assert_eq!(changed["okf"]["frontmatter"]["sources"][0]["title"],"Source renamed");
    assert_ne!(changed["okf"]["metadata_projection_version"],explicit["okf"]["metadata_projection_version"]);
    assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT status_id FROM docs WHERE id=$1").bind(target.id).fetch_one(&pool).await.unwrap(),status_id);
    // Search selection still comes from the index, but enrichment reads current native owners.
    use myoxus_domain::repositories::SearchRepository;
    let indexed_at = chrono::DateTime::parse_from_rfc3339("2001-01-01T00:00:00Z").unwrap().with_timezone(&chrono::Utc);
    search.upsert_search_doc(&myoxus_domain::entities::SearchDocument {
      workspace_id:workspace, doc_id:target.id, title:target.title.clone(),
      plain_text:format!("Opening summary 世界. {} middlekeyword evidence", "context ".repeat(60)),
      workspace_tags:Vec::new(), search_vector:None, updated_at:indexed_at,
    }).await.unwrap();
    let search_args = json!({"workspace_id":workspace,"query":"middlekeyword"});
    let found = document_read_call(&app,&token,"search_docs",search_args.clone()).await;
    output_schema_test_support::assert_required_output(&myoxus_mcp::tool_registry::find_tool("search_docs").unwrap().output_schema,&found);
    let hit = &found["results"][0];
    assert_eq!(hit["externalId"],target.external_id);
    assert_eq!(hit["okf_type"],"decision_record");
    assert_eq!(hit["description"],"Opening summary 世界.");
    assert!(hit["snippet"].as_str().unwrap().contains("middlekeyword"));
    assert!(!hit["snippet"].as_str().unwrap().contains("Opening summary"));
    assert_eq!(hit["description_source"],"indexed_content");
    assert_eq!(hit["description_index_updated_at"],json!(indexed_at));
    assert_eq!(hit["updated_at"].as_str().unwrap(),indexed_at.to_rfc3339());
    assert!(hit["document_updated_at"].as_str().unwrap() > hit["updated_at"].as_str().unwrap());
    assert_eq!(hit["tags"],json!([]));
    assert!(hit.get("verified").is_none());
    let mut unavailable_state = build_tool_state(&pool);
    unavailable_state.search_repository = Some(search.clone());
    let unavailable_app = document_read_router(&pool,unavailable_state);
    let unavailable = document_read_call(&unavailable_app,&token,"search_docs",search_args.clone()).await;
    assert!(unavailable["results"][0].get("tags").is_none());
    assert!(unavailable["results"][0]["enrichment_diagnostics"].as_array().unwrap().contains(&json!("canonical_tags_unavailable")));
    let mut bounded_state = build_tool_state(&pool);
    bounded_state.search_repository = Some(search.clone());
    bounded_state.document_export_max_bytes = 128;
    let bounded_app = document_read_router(&pool,bounded_state);
    let bounded = document_read_rpc(&bounded_app,&token,"tools/call",json!({"name":"search_docs","arguments":search_args})).await;
    assert_eq!(bounded["result"]["isError"],true,"the whole enriched result participates in the output bound");
    let tag = document_read_call(&app,&token,"workspace_tag_create",json!({
      "workspace_id":workspace,"name":"Knowledge","color_role":"tag.blue","idempotency_key":"search-tag-create"
    })).await;
    document_read_call(&app,&token,"document_tags_set",json!({
      "workspace_id":workspace,"external_id":target.external_id,"tag_ids":[tag["id"]],"idempotency_key":"search-tag-set"
    })).await;
    document_read_call(&app,&token,"workspace_tag_rename",json!({
      "workspace_id":workspace,"tag_id":tag["id"],"name":"Renamed 世界","idempotency_key":"search-tag-rename"
    })).await;
    // Canonical tag mutations already refresh their index projection. Keep an
    // intentionally stale indexed snapshot to prove enrichment uses current owners.
    search.upsert_search_doc(&myoxus_domain::entities::SearchDocument {
      workspace_id:workspace,doc_id:target.id,title:target.title.clone(),
      plain_text:format!("Opening summary 世界. {} middlekeyword evidence", "context ".repeat(60)),
      workspace_tags:Vec::new(),search_vector:None,updated_at:indexed_at,
    }).await.unwrap();
    let renamed = document_read_call(&app,&token,"search_docs",search_args.clone()).await;
    assert_eq!(renamed["results"][0]["tags"],json!([{"id":tag["id"],"label":"Renamed 世界"}]));
    assert_eq!(renamed["results"][0]["updated_at"],hit["updated_at"]);
    let native_before = document_read_call(&app,&token,"doc_metadata_get",json!({"workspace_id":workspace,"external_id":target.external_id})).await;
    document_read_call(&app,&token,"doc_metadata_update",json!({"workspace_id":workspace,"external_id":target.external_id,
      "patch":{"expectedMetadataRevision":native_before["documentMetadata"]["metadata_revision"],"reviewDueAt":"2026-12-13T00:00:00Z"},"idempotency_key":"search-native-deadline"})).await;
    let updated = document_read_call(&app,&token,"search_docs",search_args.clone()).await;
    let current_metadata = document_read_call(&app,&token,"doc_metadata_get",json!({"workspace_id":workspace,"external_id":target.external_id})).await;
    assert_eq!(updated["results"][0]["metadata_updated_at"],current_metadata["documentMetadata"]["metadata_updated_at"]);
    let before_time=chrono::DateTime::parse_from_rfc3339(native_before["documentMetadata"]["metadata_updated_at"].as_str().unwrap()).unwrap();
    let after_time=chrono::DateTime::parse_from_rfc3339(updated["results"][0]["metadata_updated_at"].as_str().unwrap()).unwrap();
    assert!(after_time>before_time,"a real native metadata change advances its own modification fact");
    assert_eq!(updated["results"][0]["updated_at"],hit["updated_at"],"native metadata does not reindex body content");
    document_read_call(&app,&token,"doc_metadata_update",json!({"workspace_id":workspace,"external_id":target.external_id,
      "patch":{"expectedMetadataRevision":current_metadata["documentMetadata"]["metadata_revision"],"reviewDueAt":"2026-12-13T00:00:00Z"},"idempotency_key":"search-native-deadline-noop"})).await;
    let noop=document_read_call(&app,&token,"search_docs",search_args.clone()).await;
    assert_eq!(noop["results"][0]["metadata_updated_at"],updated["results"][0]["metadata_updated_at"],"no-op metadata patches do not invent freshness");
    let latest = docs.get_metadata(target.id).await.unwrap().unwrap();
    assert_eq!(renamed["results"][0]["document_updated_at"],json!(latest.updated_at));
    let meta_revision: i64 = sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id=$1").bind(target.id).fetch_one(&pool).await.unwrap();
    let state = docs.load_full_doc(workspace,target.id).await.unwrap();
    let mutation: yjs::document_mutation::DocumentMutation = serde_json::from_value(json!({
      "operation":"append_blocks","fragment":{"schemaVersion":yjs::document_mutation::DOCUMENT_FRAGMENT_SCHEMA,"blocks":[{"kind":"paragraph","spans":[{"text":"Native sync body update 世界"}]}]}
    })).unwrap();
    let delta = yjs::document_mutation::apply_document_mutation(&state,&mutation).unwrap();
    docs.push_update(workspace,target.id,delta.delta,0,myoxus_application::doc::DocSpaceKind::Workspace).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT metadata_revision FROM docs WHERE id=$1").bind(target.id).fetch_one(&pool).await.unwrap(),meta_revision,
      "the native sync path does not change the metadata revision without a new document timestamp");
    let synced = document_read_call(&app,&token,"search_docs",search_args.clone()).await;
    assert_eq!(synced["results"][0]["document_updated_at"],json!(docs.get_metadata(target.id).await.unwrap().unwrap().updated_at));
    assert_eq!(synced["results"][0]["updated_at"],hit["updated_at"]);
    assert!(docs.load_full_doc(workspace,target.id).await.unwrap() != state);
    let denied_search = document_read_rpc(&app,&denied_token,"tools/call",json!({"name":"search_docs","arguments":search_args})).await;
    assert_eq!(denied_search["result"]["isError"],true);
    search.upsert_search_doc(&myoxus_domain::entities::SearchDocument {
      workspace_id:workspace,doc_id:target.id,title:target.title.clone(),plain_text:target.title.clone(),
      workspace_tags:Vec::new(),search_vector:None,updated_at:indexed_at,
    }).await.unwrap();
    let title_only_args = json!({"workspace_id":workspace,"query":"Native"});
    let title_only = document_read_call(&app,&token,"search_docs",title_only_args.clone()).await;
    assert!(title_only["results"][0].get("description").is_none(),"title-only indexing invents no summary");
    sqlx::query("UPDATE docs SET meta=jsonb_set(meta,'{obsidian,properties,description}',to_jsonb('Declared abstract 世界'::text)) WHERE id=$1")
      .bind(target.id).execute(&pool).await.unwrap();
    let declared = document_read_call(&app,&token,"search_docs",title_only_args).await;
    assert_eq!(declared["results"][0]["description"],"Declared abstract 世界");
    assert_eq!(declared["results"][0]["description_source"],"imported_declaration");
    assert!(declared["results"][0].get("description_index_updated_at").is_none());
    let outline = document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":target.external_id,"outline":true})).await;
    let heading = outline["document"]["blocks"][1]["blockId"].as_str().unwrap();
    let section = document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":target.external_id,"heading_block_id":heading})).await;
    // The existing linked-document source card has no structured IR renderer.
    // Selected text remains readable, but OKF must preserve that loss signal.
    assert_eq!(section["selection"]["complete"], false);
    assert!(section["projection"]["diagnostics"].as_array().unwrap().iter().any(|item| item["code"] == "unsupported_block"));
    assert!(serde_json::to_string(&section).unwrap().contains("Protected section."));
    assert!(!serde_json::to_string(&section["document"]["blocks"]).unwrap().contains("Opening summary."));
  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace, forbidden_workspace, source_workspace]).await;
  sqlx::query("DELETE FROM document_status_schema WHERE id=$1")
    .bind(schema_id)
    .execute(&pool)
    .await
    .expect("catalog cleanup");
  helpers::cleanup_users(&pool, &[owner, denied]).await;
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

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

fn build_tool_state(pool: &sqlx::PgPool) -> McpToolState {
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let doc_service = DocService::new(doc_store);
  let document_services = myoxus_application::mcp::ApplicationMcpDocumentOperations::new(
    DocumentMetadataService::new(Arc::new(PgDocumentMetadataRepository::new(pool.clone()))),
    Arc::new(PgDocumentMetadataPolicyRepository::new(pool.clone())),
    Arc::new(PgDocumentVersionRepository::new(pool.clone())),
    Arc::new(doc_service.clone()),
  );
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
    doc_service,
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
    document_services: Arc::new(document_services),
    idempotency: Arc::new(myoxus_application::mcp::InMemoryMcpIdempotencyRepository::default()),
    blob_service: None,
    upload_policy: None,
    audit_recorder: myoxus_application::audit::AuditRecorder::noop(),
    metrics_service: Arc::new(myoxus_application::metrics::MetricsService::in_memory_stub()),
    document_cursor_signing_key: Arc::from(&b"mcp-metadata-test-cursor-key"[..]),
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
     VALUES ($1, $2, 'mcp-metadata-idempotency-test', $3, $4)",
  )
  .bind(auth.key_id)
  .bind(auth.user_id)
  .bind(format!("mcp-metadata-idempotency-test-{}", auth.key_id))
  .bind(&auth.scopes)
  .execute(pool)
  .await
  .expect("insert MCP metadata test API key");
}

fn inner_json(value: Value) -> Value {
  let text = value["content"][0]["text"].as_str().expect("content text");
  serde_json::from_str(text).expect("inner JSON")
}

async fn reference_id(pool: &sqlx::PgPool, table: &str, key: &str) -> Uuid {
  let sql = format!("SELECT id FROM {table} WHERE key = $1");
  sqlx::query_scalar(&sql)
    .bind(key)
    .fetch_one(pool)
    .await
    .expect("reference id")
}

async fn set_effective_org_field_enabled(
  pool: &sqlx::PgPool,
  workspace_id: Uuid,
  actor_id: Uuid,
  field_key: &str,
  enabled: bool,
) {
  let org_id: Uuid = sqlx::query_scalar("SELECT document_metadata_effective_organization_id($1)")
    .bind(workspace_id)
    .fetch_one(pool)
    .await
    .expect("effective organization id");
  sqlx::query(
    "INSERT INTO organization_document_metadata_policy \
       (organization_id, field_key, enabled, visible_in_properties, visible_in_header, updated_by) \
     VALUES ($1, $2, $3, true, true, $4) \
     ON CONFLICT (organization_id, field_key) DO UPDATE \
       SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()",
  )
  .bind(org_id)
  .bind(field_key)
  .bind(enabled)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("set organization field policy");
}

async fn create_required_transition_schema(
  pool: &sqlx::PgPool,
  workspace_id: Uuid,
  actor_id: Uuid,
  doc_id: Uuid,
) -> (Uuid, Uuid, Uuid) {
  let suffix = Uuid::new_v4().simple().to_string();
  let schema_id: Uuid = sqlx::query_scalar(
    "INSERT INTO document_status_schema (key, label, complexity, is_preset, is_active) \
     VALUES ($1, $2, 'custom', false, true) RETURNING id",
  )
  .bind(format!("mcp_required_{suffix}"))
  .bind(format!("MCP required {suffix}"))
  .fetch_one(pool)
  .await
  .expect("insert custom schema");
  let from_id: Uuid = sqlx::query_scalar(
    "INSERT INTO document_status_value (schema_id, key, label, sort_order) VALUES ($1, 'from', 'From', 10) RETURNING id",
  )
  .bind(schema_id)
  .fetch_one(pool)
  .await
  .expect("insert source status");
  let to_id: Uuid = sqlx::query_scalar(
    "INSERT INTO document_status_value (schema_id, key, label, sort_order) VALUES ($1, 'to', 'To', 20) RETURNING id",
  )
  .bind(schema_id)
  .fetch_one(pool)
  .await
  .expect("insert target status");
  sqlx::query(
    "INSERT INTO document_status_transition (from_status_id, to_status_id, required_metadata_fields) \
     VALUES ($1, $2, ARRAY['classification']::text[])",
  )
  .bind(from_id)
  .bind(to_id)
  .execute(pool)
  .await
  .expect("insert required transition");
  sqlx::query(
    "INSERT INTO document_workspace_settings (workspace_id, status_schema_id, updated_by) \
     VALUES ($1, $2, $3) \
     ON CONFLICT (workspace_id) DO UPDATE SET status_schema_id = EXCLUDED.status_schema_id, updated_by = EXCLUDED.updated_by, updated_at = now()",
  )
  .bind(workspace_id)
  .bind(schema_id)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("set workspace schema");
  sqlx::query("UPDATE docs SET status_id = $2, status_source = 'document', metadata_updated_by = $3 WHERE id = $1")
    .bind(doc_id)
    .bind(from_id)
    .bind(actor_id)
    .execute(pool)
    .await
    .expect("set source status");
  (schema_id, from_id, to_id)
}

#[tokio::test]
async fn inv_mcp_docmeta01_non_member_cannot_read_metadata() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (alice_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-docmeta01-alice").await;
  let (bobby_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-docmeta01-bobby").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    let state = build_tool_state(&pool);
    let auth = auth_with_scopes(bobby_id, &["read:docs"]);

    let result = dispatch_tool(
      "doc_metadata_get",
      &json!({ "workspace_id": workspace_id.to_string(), "external_id": doc_id.to_string() }),
      &auth,
      &state,
    )
    .await;

    assert!(result.is_err(), "non-member must not read document metadata");
    let (code, msg) = result.unwrap_err();
    assert_eq!(code, -32003, "expected membership-denied error, got {code}: {msg}");
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[alice_id, bobby_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_docmeta03_get_returns_native_document_metadata_projection() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (alice_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-docmeta03-alice").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    let state = build_tool_state(&pool);
    let auth = auth_with_scopes(alice_id, &["read:docs"]);

    let result = dispatch_tool(
      "doc_metadata_get",
      &json!({ "workspace_id": workspace_id.to_string(), "external_id": doc_id.to_string() }),
      &auth,
      &state,
    )
    .await
    .expect("member can read native document metadata");
    let inner = inner_json(result);

    assert_eq!(
      inner
        .pointer("/documentMetadata/externalId")
        .and_then(Value::as_str)
        .map(str::to_string),
      Some(doc_id.to_string()),
      "MCP doc_metadata_get must expose the external key without the internal UUID field"
    );
    assert!(inner.pointer("/documentMetadata/doc_id").is_none());
    assert!(
      inner.get("documentAttributes").is_none(),
      "MCP doc_metadata_get must not return the retired documentAttributes shape"
    );
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[alice_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_docmeta04_update_patches_editable_metadata_and_subsystems() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (alice_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-docmeta04-alice").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  set_effective_org_field_enabled(&pool, workspace_id, alice_id, "documentNumber", true).await;
  let document_type_id = reference_id(&pool, "document_type_definition", "concept").await;
  let classification_id = reference_id(&pool, "document_classification_definition", "internal").await;
  let language_id = reference_id(&pool, "language_definition", "de").await;
  let retention_policy_id = reference_id(&pool, "document_retention_policy_definition", "short_lived").await;
  let audience_id = reference_id(&pool, "document_audience_definition", "customer").await;
  let outcome = std::panic::AssertUnwindSafe(async {
  let mut state = build_tool_state(&pool);
  let auth = auth_with_scopes(alice_id, &["read:docs", "write:docs"]);
  persist_auth_key(&pool, &auth).await;
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));

  let update_params = json!({
    "workspace_id": workspace_id.to_string(),
    "external_id": doc_id.to_string(),
    "idempotency_key": "doc-metadata-update-once",
    "patch": {
        "documentTypeId": document_type_id.to_string(),
        "classificationId": classification_id.to_string(),
        "retentionPolicyId": retention_policy_id.to_string(),
        "languageId": language_id.to_string(),
        "responsibleUserId": alice_id.to_string(),
        "documentNumber": "MCP-DOC-42",
        "reviewDueAt": "2026-07-01T12:30:00Z",
        "validFrom": "2026-06-01T00:00:00Z",
        "validUntil": "2026-12-31T23:59:59Z",
        "audienceIds": [audience_id.to_string()],
        "templateState": "managed",
        "templateId": null,
        "templateRevisionId": null,
        "templateInstanceId": null,
        "primaryMode": "edgeless",
        "pageWidth": "fullWidth",
        "edgelessColorTheme": "system",
        "integrationType": "readwise"
    }
  });
  let result = dispatch_tool("doc_metadata_update", &update_params, &auth, &state)
    .await
    .expect("MCP metadata update must accept the editable SetDocumentMetadata patch shape");
  assert_eq!(
    dispatch_tool("doc_metadata_update", &update_params, &auth, &state)
      .await
      .expect("replay metadata update"),
    result
  );
  let inner = inner_json(result);
  assert_eq!(inner.pointer("/validation/valid").and_then(Value::as_bool), Some(true));

  let row = sqlx::query(
    "SELECT document_type_id, classification_id, retention_policy_id, language_id, responsible_user_id, \
            document_number, review_due_at, valid_from, valid_until \
     FROM docs WHERE id = $1",
  )
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("load patched document row");
  assert_eq!(row.get::<Option<Uuid>, _>("document_type_id"), Some(document_type_id));
  assert_eq!(row.get::<Option<Uuid>, _>("classification_id"), Some(classification_id));
  assert_eq!(
    row.get::<Option<Uuid>, _>("retention_policy_id"),
    Some(retention_policy_id)
  );
  assert_eq!(row.get::<Option<Uuid>, _>("language_id"), Some(language_id));
  assert_eq!(row.get::<Option<Uuid>, _>("responsible_user_id"), Some(alice_id));
  assert_eq!(
    row.get::<Option<String>, _>("document_number").as_deref(),
    Some("MCP-DOC-42")
  );
  assert!(
    row
      .get::<Option<chrono::DateTime<chrono::Utc>>, _>("review_due_at")
      .is_some()
  );
  assert!(
    row
      .get::<Option<chrono::DateTime<chrono::Utc>>, _>("valid_from")
      .is_some()
  );
  assert!(
    row
      .get::<Option<chrono::DateTime<chrono::Utc>>, _>("valid_until")
      .is_some()
  );

  let audience_count: i64 =
    sqlx::query_scalar("SELECT count(*) FROM doc_audience_assignment WHERE doc_id = $1 AND audience_id = $2")
      .bind(doc_id)
      .bind(audience_id)
      .fetch_one(&pool)
      .await
      .expect("audience assignment count");
  assert_eq!(
    audience_count, 1,
    "MCP metadata update must persist audience assignments"
  );
  let subsystem = sqlx::query(
    "SELECT tmpl.state AS template_state, pres.primary_mode, pres.page_width, pres.edgeless_color_theme, integ.integration_type \
     FROM document_template_state tmpl \
     JOIN document_presentation_state pres ON pres.doc_id = tmpl.doc_id \
     JOIN document_integration_state integ ON integ.doc_id = tmpl.doc_id \
     WHERE tmpl.doc_id = $1",
  )
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("load subsystem metadata");
  assert_eq!(
    subsystem.get::<Option<String>, _>("template_state").as_deref(),
    Some("managed")
  );
  assert_eq!(
    subsystem.get::<Option<String>, _>("primary_mode").as_deref(),
    Some("edgeless")
  );
  assert_eq!(
    subsystem.get::<Option<String>, _>("page_width").as_deref(),
    Some("fullWidth")
  );
  assert_eq!(
    subsystem.get::<Option<String>, _>("edgeless_color_theme").as_deref(),
    Some("system")
  );
  assert_eq!(
    subsystem.get::<Option<String>, _>("integration_type").as_deref(),
    Some("readwise")
  );

  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[alice_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_docmeta05_update_writes_journal_calendar_subsystem_metadata() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (alice_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-docmeta05-alice").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    let state = build_tool_state(&pool);
    let auth = auth_with_scopes(alice_id, &["read:docs", "write:docs"]);

    let result = dispatch_tool(
      "doc_metadata_update",
      &json!({
        "workspace_id": workspace_id.to_string(),
        "external_id": doc_id.to_string(),
        "patch": {
          "journalDate": "2026-05-25"
        }
      }),
      &auth,
      &state,
    )
    .await
    .expect("MCP metadata update must accept journal calendar subsystem writes");
    let inner = inner_json(result);
    assert_eq!(
      inner
        .pointer("/documentMetadata/journal/journal_date")
        .and_then(Value::as_str),
      Some("2026-05-25"),
      "MCP response must expose the persisted journal date in the native metadata projection: {inner}"
    );
    assert_eq!(inner.pointer("/validation/valid").and_then(Value::as_bool), Some(true));

    let persisted: Option<String> = sqlx::query_scalar("SELECT journal_date::text FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("read persisted journal date");
    assert_eq!(
      persisted.as_deref(),
      Some("2026-05-25"),
      "MCP journal calendar subsystem write must persist docs.journal_date"
    );
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[alice_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_docmeta02_transition_returns_structured_validation_errors() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (alice_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-docmeta02").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let (schema_id, from_id, to_id) = create_required_transition_schema(&pool, workspace_id, alice_id, doc_id).await;
  sqlx::query("UPDATE docs SET classification_id = NULL, classification_source = 'document' WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("clear default classification to exercise required-metadata validation");
  let outcome = std::panic::AssertUnwindSafe(async {
    let mut state = build_tool_state(&pool);
    let auth = auth_with_scopes(alice_id, &["read:docs", "write:docs"]);
    persist_auth_key(&pool, &auth).await;
    state.idempotency =
      Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));

    let blocked_params = json!({
      "workspace_id": workspace_id.to_string(),
      "external_id": doc_id.to_string(),
      "to": "to",
      "idempotency_key": "doc-metadata-transition-blocked"
    });
    let result = dispatch_tool("doc_metadata_transition", &blocked_params, &auth, &state)
      .await
      .expect("blocked transition still returns structured validation");
    assert_eq!(
      dispatch_tool("doc_metadata_transition", &blocked_params, &auth, &state)
        .await
        .expect("replay blocked transition"),
      result
    );
    let inner = inner_json(result);
    assert_eq!(inner.pointer("/validation/valid").and_then(Value::as_bool), Some(false));
    assert_eq!(
      inner
        .pointer("/validation/missing_required_metadata_fields")
        .and_then(Value::as_array)
        .and_then(|values| values.first())
        .and_then(Value::as_str),
      Some("classification")
    );

    let persisted_status: Option<Uuid> = sqlx::query_scalar("SELECT status_id FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("load persisted status");
    assert_eq!(
      persisted_status,
      Some(from_id),
      "blocked MCP transition must not persist target status"
    );

    let classification_id = reference_id(&pool, "document_classification_definition", "internal").await;
    sqlx::query("UPDATE docs SET classification_id = $2, classification_source = 'document' WHERE id = $1")
      .bind(doc_id)
      .bind(classification_id)
      .execute(&pool)
      .await
      .expect("satisfy transition metadata requirement");
    let apply_params = json!({
      "workspace_id": workspace_id.to_string(),
      "external_id": doc_id.to_string(),
      "to": "to",
      "idempotency_key": "doc-metadata-transition-apply-once"
    });
    let applied = dispatch_tool("doc_metadata_transition", &apply_params, &auth, &state)
      .await
      .expect("valid transition applies");
    assert_eq!(
      dispatch_tool("doc_metadata_transition", &apply_params, &auth, &state)
        .await
        .expect("replay applied transition"),
      applied
    );
    let status_after_replay: Option<Uuid> = sqlx::query_scalar("SELECT status_id FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("load replayed status");
    assert_eq!(status_after_replay, Some(to_id));
  })
  .catch_unwind()
  .await;
  sqlx::query("UPDATE docs SET status_id = NULL WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("clear fixture status");
  sqlx::query("DELETE FROM document_status_schema WHERE id = $1")
    .bind(schema_id)
    .execute(&pool)
    .await
    .expect("delete fixture status schema");

  helpers::cleanup_users(&pool, &[alice_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
