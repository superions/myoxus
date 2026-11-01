//! MCP document-version tools.
//!
//! These tests exercise the tool dispatcher directly so scope/membership
//! checks and DB side-effects stay visible without requiring an HTTP server.

use std::sync::Arc;

use futures_util::FutureExt;
use serde_json::{Value, json};
use uuid::Uuid;

use myoxus_application::doc::DocService;
use myoxus_application::document_metadata::DocumentMetadataService;
use myoxus_application::mcp::McpIdempotencyRepository;
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
    document_cursor_signing_key: Arc::from(&b"mcp-version-test-cursor-key"[..]),
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
     VALUES ($1, $2, 'mcp-version-idempotency-test', $3, $4)",
  )
  .bind(auth.key_id)
  .bind(auth.user_id)
  .bind(format!("mcp-version-idempotency-test-{}", auth.key_id))
  .bind(&auth.scopes)
  .execute(pool)
  .await
  .expect("insert MCP version test API key");
}

fn inner_json(value: Value) -> Value {
  let text = value["content"][0]["text"].as_str().expect("content text");
  serde_json::from_str(text).expect("inner JSON")
}

#[tokio::test]
async fn inv_mcp_docver01_unauthorized_user_rejected() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (alice_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-docver01-alice").await;
  let (bobby_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-docver01-bobby").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    let state = build_tool_state(&pool);
    let auth = auth_with_scopes(bobby_id, &["read:docs", "write:docs"]);

    let result = dispatch_tool(
      "doc_version_create",
      &json!({
        "workspace_id": workspace_id.to_string(),
        "external_id": doc_id.to_string(),
        "label": "must-not-exist"
      }),
      &auth,
      &state,
    )
    .await;

    assert!(
      result.is_err(),
      "INV-MCP-DOCVER-01: non-member must not create document versions"
    );
    let (code, msg) = result.unwrap_err();
    assert_eq!(code, -32003, "expected membership-denied error, got {code}: {msg}");

    let versions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_version WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("count versions");
    let histories: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_histories WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("count histories");
    assert_eq!(versions, 0, "unauthorized MCP create must not write label rows");
    assert_eq!(histories, 0, "unauthorized MCP create must not capture history");
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[alice_id, bobby_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_docver02_list_and_create_versions() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (alice_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-docver02").await;
  let workspace_id = helpers::create_workspace(&pool, alice_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, alice_id).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    let mut state = build_tool_state(&pool);
    let auth = auth_with_scopes(alice_id, &["read:docs", "write:docs"]);
    persist_auth_key(&pool, &auth).await;
    state.idempotency =
      Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));

    let create_params = json!({
      "workspace_id": workspace_id.to_string(),
      "external_id": doc_id.to_string(),
      "label": "mcp-v1",
      "description": "created by MCP invariant",
      "idempotency_key": "doc-version-create-once"
    });
    let created = dispatch_tool("doc_version_create", &create_params, &auth, &state)
      .await
      .expect("authorized create must succeed");
    assert_eq!(
      dispatch_tool("doc_version_create", &create_params, &auth, &state)
        .await
        .expect("replay version create"),
      created
    );
    let created_inner = inner_json(created);
    let alice_id_s = alice_id.to_string();
    let created_label = created_inner
      .pointer("/version/label")
      .and_then(Value::as_str)
      .expect("server-authoritative version label");
    assert!(!created_label.is_empty());
    assert_eq!(
      created_inner.pointer("/version/event").and_then(Value::as_str),
      Some("manual")
    );
    assert_eq!(
      created_inner.pointer("/version/kind").and_then(Value::as_str),
      Some("checkpoint")
    );
    assert_eq!(
      created_inner
        .pointer("/version/isCurrentDocumentVersion")
        .and_then(Value::as_bool),
      Some(true)
    );
    assert_eq!(
      created_inner.pointer("/version/createdBy").and_then(Value::as_str),
      Some(alice_id_s.as_str())
    );
    assert_eq!(created_inner.pointer("/version/externalId"), Some(&json!(doc_id)));
    assert!(created_inner.pointer("/version/docId").is_none());

    let listed = dispatch_tool(
      "doc_version_list",
      &json!({
        "workspace_id": workspace_id.to_string(),
        "external_id": doc_id.to_string(),
      }),
      &auth,
      &state,
    )
    .await
    .expect("authorized list must succeed");
    let listed_inner = inner_json(listed);
    assert_eq!(
      listed_inner.pointer("/versions/0/label").and_then(Value::as_str),
      Some(created_label)
    );
    assert_eq!(
      listed_inner.pointer("/versions/0/event").and_then(Value::as_str),
      Some("manual")
    );

    let versions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_version WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("count versions");
    let histories: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_histories WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("count histories");
    assert_eq!(versions, 1);
    assert_eq!(histories, 1);
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[alice_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_document_named_version_read_is_exact_bounded_and_currently_authorized() {
  use yrs::updates::decoder::Decode;
  use yrs::{Map, ReadTxn, StateVector, Transact};
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner, _) = helpers::seed_user(&pool, &auth_store, "mcp-version-read-owner").await;
  let (reader, _) = helpers::seed_user(&pool, &auth_store, "mcp-version-read-reader").await;
  let workspace = super::mcp_create_page_test::create_workspace(&pool, owner).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status,joined_at) VALUES($1,$2,'External','Accepted',now())")
      .bind(workspace).bind(reader).execute(&pool).await.unwrap();
    let mut state = build_tool_state(&pool);
    let auth = auth_with_scopes(owner, &["read:docs", "write:docs"]);
    persist_auth_key(&pool, &auth).await;
    state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let payload = myoxus_application::markdown::prepare_markdown_import("Snapshot title", "## Original\n\nSecret **café 😀**\n\nThird paragraph").unwrap().yjs_binary;
    let (doc, _) = state.doc_service.create_page_from_snapshot_with_sync_updates(workspace, owner, Some("Snapshot title".into()), payload).await.unwrap();
    let other_payload = myoxus_application::markdown::prepare_markdown_import("Other", "Other body").unwrap().yjs_binary;
    let native = yrs::Doc::new();
    let blocks = native.get_or_insert_map("blocks");
    let mut txn = native.transact_mut();
    txn.apply_update(yrs::Update::decode_v1(&other_payload).unwrap()).unwrap();
    let paragraph = blocks.iter(&txn).find_map(|(_, value)| {
      let yrs::Out::YMap(block) = value else { return None };
      matches!(block.get(&txn, "sys:flavour"), Some(yrs::Out::Any(yrs::Any::String(ref flavour))) if flavour.as_ref() == "myoxus:paragraph").then_some(block)
    }).unwrap();
    paragraph.insert(&mut txn, "sys:flavour", "myoxus:future-test");
    let other_payload = txn.encode_state_as_update_v1(&StateVector::default());
    drop(txn);
    let (other, _) = state.doc_service.create_page_from_snapshot_with_sync_updates(workspace, owner, Some("Other".into()), other_payload).await.unwrap();
    let base = json!({"workspace_id":workspace,"external_id":doc.external_id});
    let created = inner_json(dispatch_tool("doc_version_create", &json!({"workspace_id":workspace,"external_id":doc.external_id,"label":"version-read-original","idempotency_key":"version-read-create"}), &auth, &state).await.unwrap());
    let version = created["version"]["id"].clone();
    let args = json!({"workspace_id":workspace,"external_id":doc.external_id,"version_id":version,"limit":1});
    let first = inner_json(dispatch_tool("doc_version_read", &args, &auth, &state).await.unwrap());
    assert_eq!(first["versionId"], version);
    assert_eq!(first["docHistoryId"], created["version"]["docHistoryId"]);
    assert_eq!(first["document"]["title"], "Snapshot title");
    assert_eq!(first["document"]["blocks"].as_array().unwrap().len(), 1);
    assert!(first.get("revision").is_none(), "historical content must not advertise a live write revision");
    assert_eq!(first["projection"]["source"], "named_version_snapshot");
    assert_eq!(first["projection"]["complete"], true);
    assert_eq!(first["projection"]["diagnostics"], json!([]));
    let mut next_args = args.clone();next_args["cursor"] = first["page"]["nextCursor"].clone();
    let second = inner_json(dispatch_tool("doc_version_read", &next_args, &auth, &state).await.unwrap());
    assert!(second["document"]["blocks"].to_string().contains("Secret"));
    assert!(second["document"]["blocks"].to_string().contains("café 😀"));
    let current = inner_json(dispatch_tool("read_doc", &base, &auth, &state).await.unwrap());
    dispatch_tool("doc_patch", &json!({"workspace_id":workspace,"external_id":doc.external_id,"operation":"append_blocks","content_markdown":"Later live content","expected_revision":current["revision"],"idempotency_key":"version-read-later"}), &auth, &state).await.unwrap();
    dispatch_tool("doc_patch", &json!({"workspace_id":workspace,"external_id":doc.external_id,"operation":"update_title","title":"Live title changed","idempotency_key":"version-read-title"}), &auth, &state).await.unwrap();
    assert_eq!(inner_json(dispatch_tool("doc_version_read", &args, &auth, &state).await.unwrap()), first);
    assert_eq!(inner_json(dispatch_tool("doc_version_read", &next_args, &auth, &state).await.unwrap()), second, "live edits cannot stale an immutable continuation");
    let live = inner_json(dispatch_tool("read_doc", &base, &auth, &state).await.unwrap());
    assert!(live["document"].to_string().contains("Later live content"));
    assert_eq!(live["document"]["title"], "Live title changed");
    let mut wrong_doc = args.clone();wrong_doc["external_id"] = json!(other.external_id);
    assert_eq!(dispatch_tool("doc_version_read", &wrong_doc, &auth, &state).await.unwrap_err().0, -32004);
    let mut missing = args.clone();missing["version_id"] = json!(Uuid::new_v4());
    assert_eq!(dispatch_tool("doc_version_read", &missing, &auth, &state).await.unwrap_err().0, -32004);
    for limit in [0, 201] {let mut invalid=args.clone();invalid["limit"]=json!(limit);assert_eq!(dispatch_tool("doc_version_read", &invalid, &auth, &state).await.unwrap_err().0,-32602);}
    let mut small = state.clone();small.document_export_max_bytes=100;
    assert!(dispatch_tool("doc_version_read", &args, &auth, &small).await.unwrap_err().1.contains("EXPORT_TOO_LARGE"));
    let read_auth = auth_with_scopes(reader, &["read:docs"]);
    assert_eq!(dispatch_tool("doc_version_read", &args, &read_auth, &state).await.unwrap_err().0,-32003);
    sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) VALUES($1,$2,'Reader')").bind(reader).bind(doc.id).execute(&pool).await.unwrap();
    let reader_first = inner_json(dispatch_tool("doc_version_read", &args, &read_auth, &state).await.unwrap());
    assert_eq!(reader_first["document"],first["document"]);
    assert!(dispatch_tool("doc_version_read", &next_args, &read_auth, &state).await.unwrap_err().1.contains("CURSOR_INVALID"));
    let mut reader_next=args.clone();reader_next["cursor"]=reader_first["page"]["nextCursor"].clone();
    assert_eq!(inner_json(dispatch_tool("doc_version_read", &reader_next, &read_auth, &state).await.unwrap())["document"],second["document"]);
    sqlx::query("DELETE FROM doc_user_permissions WHERE user_id=$1 AND doc_id=$2").bind(reader).bind(doc.id).execute(&pool).await.unwrap();
    assert_eq!(dispatch_tool("doc_version_read", &reader_next, &read_auth, &state).await.unwrap_err().0,-32003);
    assert_eq!(dispatch_tool("doc_version_read", &args, &auth_with_scopes(owner,&["write:docs"]), &state).await.unwrap_err().0,-32003);
    // A second named version of different state cannot consume the first cursor.
    let newer = inner_json(dispatch_tool("doc_version_create", &json!({"workspace_id":workspace,"external_id":doc.external_id,"label":"version-read-newer","idempotency_key":"version-read-create-newer"}), &auth, &state).await.unwrap());
    let mut newer_args=next_args.clone();newer_args["version_id"]=newer["version"]["id"].clone();
    assert!(dispatch_tool("doc_version_read", &newer_args, &auth, &state).await.unwrap_err().1.contains("CURSOR_INVALID"));
    let partial = inner_json(dispatch_tool("doc_version_create", &json!({"workspace_id":workspace,"external_id":other.external_id,"label":"version-read-partial","idempotency_key":"version-read-create-partial"}), &auth, &state).await.unwrap());
    let partial_read = inner_json(dispatch_tool("doc_version_read", &json!({"workspace_id":workspace,"external_id":other.external_id,"version_id":partial["version"]["id"]}), &auth, &state).await.unwrap());
    assert_eq!(partial_read["projection"]["complete"], false);
    assert!(!partial_read["projection"]["diagnostics"].as_array().unwrap().is_empty(), "unsupported native content must not be reported as complete");
    let stored = state.document_services.version_snapshot(workspace,doc.id,Uuid::parse_str(version.as_str().unwrap()).unwrap()).await.unwrap().unwrap();
    assert_eq!(myoxus_public_render::document_from_yjs(workspace,doc.id,"","Private",&stored.1).unwrap().document.title,"Snapshot title");
  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner, reader]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

/// Suspend only the post-commit acknowledgement. The production SQL adapter
/// still owns admission and the receipt in the actual history transaction.
struct RestoreAcknowledgementGate {
  pool: sqlx::PgPool,
  entered: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl myoxus_application::mcp::McpIdempotencyRepository for RestoreAcknowledgementGate {
  fn document_transaction_recovery(&self) -> bool {
    true
  }
  async fn begin(
    &self,
    row: Uuid,
    key: Uuid,
    user: Uuid,
    tool: &str,
    request: &str,
    hash: &str,
    document_payload_format: i16,
  ) -> myoxus_application::auth::AuthResult<myoxus_application::mcp::McpIdempotencyAdmission> {
    myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(self.pool.clone())
      .begin(row, key, user, tool, request, hash, document_payload_format)
      .await
  }
  async fn complete(&self, _row: Uuid, _response: &Value) -> myoxus_application::auth::AuthResult<bool> {
    self.entered.notify_one();
    std::future::pending().await
  }
  async fn abort(&self, row: Uuid) -> myoxus_application::auth::AuthResult<()> {
    myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(self.pool.clone())
      .abort(row)
      .await
  }
}

async fn restore_effects(pool: &sqlx::PgPool, workspace: Uuid, doc: Uuid, owner: Uuid) -> (i64, i64, i64, i64, i64) {
  sqlx::query_as(
    "SELECT
    (SELECT count(*) FROM doc_updates WHERE doc_id=$2),
    (SELECT count(*) FROM doc_histories WHERE doc_id=$2),
    (SELECT count(*) FROM document_version WHERE doc_id=$2),
    (SELECT count(*) FROM outbox_events WHERE payload->>'workspaceId'=$1::text),
    (SELECT count(*) FROM admin_audit_log WHERE actor_user_id=$3 AND event_key='document_version.restore')",
  )
  .bind(workspace)
  .bind(doc)
  .bind(owner)
  .fetch_one(pool)
  .await
  .expect("count restore effects")
}

#[tokio::test]
async fn inv_mcp_named_restore_survives_cancelled_acknowledgement_without_rewinding_metadata_or_replaying_content() {
  use myoxus_application::doc::{DocSpaceKind, DocSyncClientKind, DocSyncConnectionContext};
  use myoxus_domain::document_key::DocumentKey;
  use yrs::updates::decoder::Decode;
  use yrs::{Doc, Map, ReadTxn, Text, Transact, Update, types::ToJson};
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner, _) = helpers::seed_user(&pool, &auth_store, "mcp-version-restore-owner").await;
  let workspace = super::mcp_create_page_test::create_workspace(&pool, owner).await;
  let mut pending = None;
  let outcome = std::panic::AssertUnwindSafe(async {
    let mut state = build_tool_state(&pool);
    let auth = auth_with_scopes(owner, &["read:docs", "write:docs"]);
    persist_auth_key(&pool, &auth).await;
    state.idempotency=Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let source_payload=myoxus_application::markdown::prepare_markdown_import("Original title", "Original **café 😀** $x^2$\n\n| A | B |\n| --- | --- |\n| one | two |\n\n$$\nx^2+y^2\n$$").unwrap().yjs_binary;
    let (doc, _)=state.doc_service.create_page_from_snapshot_with_sync_updates(workspace,owner,Some("Original title".into()),source_payload).await.unwrap();
    let base=json!({"workspace_id":workspace,"external_id":doc.external_id});
    let original_projection=inner_json(dispatch_tool("read_doc",&base,&auth,&state).await.unwrap());
    let created=inner_json(dispatch_tool("doc_version_create",&json!({"workspace_id":workspace,"external_id":doc.external_id,"label":"restore-source","idempotency_key":"restore-source"}),&auth,&state).await.unwrap());
    let version=created["version"]["id"].clone();
    let source_history=created["version"]["docHistoryId"].as_i64().unwrap();
    let source:Vec<u8>=sqlx::query_scalar("SELECT snapshot FROM doc_histories WHERE id=$1").bind(source_history).fetch_one(&pool).await.unwrap();
    let revision=state.doc_service.history.revision(workspace,doc.id).await.unwrap();
    dispatch_tool("doc_patch",&json!({"workspace_id":workspace,"external_id":doc.external_id,"operation":"append_blocks","content_markdown":"Preserve me in recovery","expected_revision":revision,"idempotency_key":"restore-live-edit"}),&auth,&state).await.unwrap();
    dispatch_tool("doc_patch",&json!({"workspace_id":workspace,"external_id":doc.external_id,"operation":"update_title","title":"Current business title","idempotency_key":"restore-live-title"}),&auth,&state).await.unwrap();
    dispatch_tool("doc_metadata_update",&json!({"workspace_id":workspace,"external_id":doc.external_id,"patch":{"documentNumber":"current-after-snapshot"},"idempotency_key":"restore-current-metadata"}),&auth,&state).await.unwrap();
    let prestate=state.doc_service.load_full_doc(workspace,doc.id).await.unwrap();
    let revision=state.doc_service.history.revision(workspace,doc.id).await.unwrap();
    let business_sql="SELECT to_jsonb(d) - ARRAY['title','updated_at','sync_state_vector_v1','current_version_id','dirty_since_current_version','last_versioned_at','metadata_updated_by','metadata_updated_at','metadata_revision'] FROM docs d WHERE id=$1";
    let business:Value=sqlx::query_scalar(business_sql).bind(doc.id).fetch_one(&pool).await.unwrap();
    let args=json!({"workspace_id":workspace,"external_id":doc.external_id,"version_id":version,"confirm_restore":true,"expected_revision":revision,"idempotency_key":"restore-once"});
    let other_payload=myoxus_application::markdown::prepare_markdown_import("Other document", "Unrelated").unwrap().yjs_binary;
    let (other,_)=state.doc_service.create_page_from_snapshot_with_sync_updates(workspace,owner,Some("Other document".into()),other_payload).await.unwrap();
    let mut cross_doc=args.clone();cross_doc["external_id"]=json!(other.external_id);cross_doc["idempotency_key"]=json!("restore-wrong-document");
    assert_eq!(dispatch_tool("doc_version_restore",&cross_doc,&auth,&state).await.unwrap_err().0,-32004);
    let before=restore_effects(&pool,workspace,doc.id,owner).await;
    for (field,value,code) in [("confirm_restore",json!(false),-32602),("expected_revision",json!(revision-1),-32009),("version_id",json!(Uuid::new_v4()),-32004)] {
      let mut invalid=args.clone();invalid[field]=value;invalid["idempotency_key"]=json!(format!("restore-invalid-{field}"));
      assert_eq!(dispatch_tool("doc_version_restore",&invalid,&auth,&state).await.unwrap_err().0,code);
      assert_eq!(restore_effects(&pool,workspace,doc.id,owner).await,before);
    }
    for field in ["confirm_restore","expected_revision","idempotency_key"] {
      let mut invalid=args.clone();invalid.as_object_mut().unwrap().remove(field);
      assert_eq!(dispatch_tool("doc_version_restore",&invalid,&auth,&state).await.unwrap_err().0,-32602);
    }
    assert_eq!(dispatch_tool("doc_version_restore",&args,&auth_with_scopes(owner,&["read:docs"]),&state).await.unwrap_err().0,-32003);
    let gate=Arc::new(RestoreAcknowledgementGate{pool:pool.clone(),entered:tokio::sync::Notify::new()});
    let mut interrupted=state.clone();interrupted.idempotency=gate.clone();
    let task_auth=auth.clone();let task_args=args.clone();
    pending=Some(tokio::spawn(async move {dispatch_tool("doc_version_restore",&task_args,&task_auth,&interrupted).await}));
    tokio::time::timeout(std::time::Duration::from_secs(15),gate.entered.notified()).await.expect("restore must commit before acknowledgement");
    let task=pending.take().unwrap();task.abort();assert!(task.await.unwrap_err().is_cancelled());
    let mut receipt:Value=sqlx::query_scalar("SELECT response_json FROM mcp_idempotency_keys WHERE api_key_id=$1 AND tool_name='doc_version_restore' AND idempotency_key='restore-once' AND mutation_committed AND recovery_enabled").bind(auth.key_id).fetch_one(&pool).await.unwrap();
    receipt.as_object_mut().unwrap().remove("_mcpInternalDocumentId");
    let restored=inner_json(receipt.clone());
    assert_eq!(restored["sequence"],revision+1);assert_eq!(restored["revision"],revision+1);
    assert_eq!(restored["sourceVersionId"],version);
    assert!(restored["label"].as_str().unwrap().starts_with(&format!("restore-from-{}-",created["version"]["label"].as_str().unwrap())),"restore label must derive from the actual server-labelled source");
    let restored_id=Uuid::parse_str(restored["versionId"].as_str().unwrap()).unwrap();
    let recovery=restored["recoveryHistoryId"].as_i64().unwrap();
    let head:(Uuid,bool)=sqlx::query_as("SELECT current_version_id,dirty_since_current_version FROM docs WHERE id=$1").bind(doc.id).fetch_one(&pool).await.unwrap();
    assert_eq!(head,(restored_id,false));
    let business_after:Value=sqlx::query_scalar(business_sql).bind(doc.id).fetch_one(&pool).await.unwrap();assert_eq!(business_after,business);
    let relation:i64=sqlx::query_scalar("SELECT count(*) FROM document_version_relation WHERE from_version_id=$1 AND to_version_id=$2 AND relation='restored_from'").bind(restored_id).bind(Uuid::parse_str(version.as_str().unwrap()).unwrap()).fetch_one(&pool).await.unwrap();assert_eq!(relation,1);
    let audit:(String,String,String,Value)=sqlx::query_as("SELECT actor_kind,credential_type,credential_id,new_value FROM admin_audit_log WHERE actor_user_id=$1 AND event_key='document_version.restore'").bind(owner).fetch_one(&pool).await.unwrap();
    assert_eq!((&audit.0,&audit.1,&audit.2),(&"api_key".to_owned(),&"mcp_api_key".to_owned(),&auth.key_id.to_string()));assert_eq!(audit.3["sequence"],revision+1);assert_eq!(audit.3["recoveryHistoryId"],recovery);
    let committed=restore_effects(&pool,workspace,doc.id,owner).await;
    assert_eq!(committed,(before.0+1,before.1+2,before.2+1,before.3+1,before.4+1));
    let content=|bytes:&[u8]| {let native=Doc::new();native.transact_mut().apply_update(Update::decode_v1(bytes).unwrap()).unwrap();let blocks=native.get_or_insert_map("blocks");blocks.to_json(&native.transact())};
    let recovery_bytes:Vec<u8>=sqlx::query_scalar("SELECT snapshot FROM doc_histories WHERE id=$1").bind(recovery).fetch_one(&pool).await.unwrap();assert_eq!(content(&recovery_bytes),content(&prestate));
    let source_after:Vec<u8>=sqlx::query_scalar("SELECT snapshot FROM doc_histories WHERE id=$1").bind(source_history).fetch_one(&pool).await.unwrap();assert_eq!(source_after,source);
    let loaded=state.doc_service.load_full_doc(workspace,doc.id).await.unwrap();assert_eq!(content(&loaded),content(&source));
    let restored_projection=inner_json(dispatch_tool("read_doc",&base,&auth,&state).await.unwrap());
    assert_eq!(restored_projection["document"]["blocks"],original_projection["document"]["blocks"],"consumer must retain native formula and rich-text semantics");
    assert_eq!(restored_projection["document"]["tableIdentities"],original_projection["document"]["tableIdentities"]);
    assert_eq!(dispatch_tool("doc_version_restore",&args,&auth,&state).await.unwrap(),receipt);
    assert_eq!(restore_effects(&pool,workspace,doc.id,owner).await,committed);
    // Reload through the native consumer and edit the restored TextRef, not an
    // MCP reconstruction. A later retry must keep its original committed facts.
    let native=Doc::new();native.transact_mut().apply_update(Update::decode_v1(&loaded).unwrap()).unwrap();
    let blocks=native.get_or_insert_map("blocks");let vector=native.transact().state_vector();
    let mut txn=native.transact_mut();
    let text=blocks.iter(&txn).find_map(|(_,value)| {let yrs::Out::YMap(block)=value else{return None};match block.get(&txn,"prop:text") {Some(yrs::Out::YText(text))=>Some(text),_=>None}}).expect("restored native paragraph");
    text.insert(&mut txn,0,"Native edit after restore ");let delta=txn.encode_diff_v1(&vector);drop(txn);
    let persisted=state.doc_service.push_external_update_with_context(Uuid::new_v4(),Some(DocSyncConnectionContext{client_kind:DocSyncClientKind::Web}),workspace,DocumentKey::parse(doc.external_id.to_string()).unwrap(),delta,chrono::Utc::now().timestamp_millis(),DocSpaceKind::Workspace,Some(owner),Some("myoxus-native".into()),None,None).await.unwrap();assert!(persisted.outcome.is_persisted());
    let edited=state.doc_service.load_full_doc(workspace,doc.id).await.unwrap();assert!(content(&edited).to_string().contains("Native edit after restore"));
    let current=inner_json(dispatch_tool("read_doc",&base,&auth,&state).await.unwrap());assert!(current["revision"].as_i64().unwrap()>restored["revision"].as_i64().unwrap());
    let after_edit=restore_effects(&pool,workspace,doc.id,owner).await;
    assert_eq!(dispatch_tool("doc_version_restore",&args,&auth,&state).await.unwrap(),receipt);assert_eq!(restore_effects(&pool,workspace,doc.id,owner).await,after_edit);assert_eq!(state.doc_service.load_full_doc(workspace,doc.id).await.unwrap(),edited);
    for (field,value) in [("expected_revision",current["revision"].clone()),("version_id",json!(Uuid::new_v4()))] {
      let mut changed=args.clone();changed[field]=value;
      let conflict=dispatch_tool("doc_version_restore",&changed,&auth,&state).await.unwrap_err();
      assert_eq!(conflict.0,-32010,"same key must bind the exact source and revision");
      assert!(conflict.1.starts_with("MIX_MCP_IDEMPOTENCY_CONFLICT:"));
      assert_eq!(restore_effects(&pool,workspace,doc.id,owner).await,after_edit);
    }
    sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.unwrap();
    assert_eq!(dispatch_tool("doc_version_restore",&args,&auth,&state).await.unwrap_err().0,-32003);
    let mut fresh=args.clone();fresh["idempotency_key"]=json!("restore-revoked");fresh["expected_revision"]=current["revision"].clone();assert_eq!(dispatch_tool("doc_version_restore",&fresh,&auth,&state).await.unwrap_err().0,-32003);
    assert_eq!(restore_effects(&pool,workspace,doc.id,owner).await,after_edit);
    sqlx::query("UPDATE workspace_memberships SET role='Owner' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.unwrap();
    assert_eq!(dispatch_tool("doc_version_restore",&args,&auth,&state).await.unwrap(),receipt);
  }).catch_unwind().await;
  if let Some(task) = pending {
    task.abort();
    // Reap even a prematurely failed request before fixture cleanup; the caught
    // assertion below retains the original failure instead of hiding it here.
    let _joined = task.await;
  }
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1")
    .bind(owner)
    .execute(&pool)
    .await
    .expect("clean owned audit rows");
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}
