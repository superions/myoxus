// SPDX-License-Identifier: AGPL-3.0-or-later
//! MCP-RV-07c: create_page conversion/persistence and input validation tests.
//!
//! Verifies that `create_page`:
//! - succeeds with valid markdown and returns the new doc ID
//! - returns an error (not silent success) when title is missing or empty
//! - succeeds without content_markdown (title-only page)
//! - succeeds with content_markdown and persists Yjs data

use crate::helpers;

use base64::Engine as _;
use myoxus_api::document_broadcast_outbox::{
  WorkspaceDocumentBroadcastPublisher, process_next_workspace_doc_broadcast,
};
use myoxus_application::audit::AuditRecorder;
use myoxus_application::doc::{DocService, DocSpaceKind, DocSyncClientKind, DocSyncConnectionContext};
use myoxus_application::document_graph::{DocumentGraphLimits, DocumentGraphService};
use myoxus_application::document_metadata::DocumentMetadataService;
use myoxus_application::mcp::McpIdempotencyRepository;
use myoxus_application::metrics::{METRICS_CATEGORIES, MetricsPolicy, MetricsService};
use myoxus_application::permission::PermissionService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_domain::document_key::DocumentKey;
use myoxus_infrastructure::audit::PgAuditLogStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::document_graph::PgDocumentGraphRepository;
use myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository;
use myoxus_infrastructure::document_metadata_policy::PgDocumentMetadataPolicyRepository;
use myoxus_infrastructure::document_version::PgDocumentVersionRepository;
use myoxus_infrastructure::public::PgPublicRepository;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_mcp::auth::McpAuthContext;
use myoxus_mcp::tools::{McpToolState, dispatch_tool};
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::HashMap;
use std::sync::{
  Arc, Mutex,
  atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::Notify;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Array, Doc, Map, ReadTxn, Transact, Update};

pub(super) async fn document_read_rpc(app: &axum::Router, token: &str, method: &str, params: Value) -> Value {
  use http_body_util::BodyExt;
  use tower::ServiceExt;
  let response = app
    .clone()
    .oneshot(
      axum::http::Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("host", "myoxus.test")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-11-25")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(axum::body::Body::from(
          json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string(),
        ))
        .expect("MCP request"),
    )
    .await
    .expect("MCP response");
  assert_eq!(response.status(), axum::http::StatusCode::OK);
  serde_json::from_slice(&response.into_body().collect().await.expect("MCP body").to_bytes()).expect("MCP JSON")
}

pub(super) async fn document_read_key(app: &axum::Router, session: Uuid, scopes: &[&str]) -> String {
  let response = helpers::gql(app, session, json!({
    "query": "mutation($scopes:[String!]!){apiKeys{createApiKey(name:\"document-read-contract\",scopes:$scopes){key}}}",
    "variables": {"scopes": scopes}
  })).await;
  assert!(response.get("errors").is_none(), "key issuance must succeed");
  response["data"]["apiKeys"]["createApiKey"]["key"]
    .as_str()
    .expect("one-time key")
    .to_string()
}

pub(super) fn document_read_router(pool: &sqlx::PgPool, tool_state: McpToolState) -> axum::Router {
  document_read_router_with_hub(pool, tool_state, myoxus_mcp::subscriptions::SubscriptionHub::new())
}

fn document_read_router_with_hub(
  pool: &sqlx::PgPool,
  tool_state: McpToolState,
  hub: myoxus_mcp::subscriptions::SubscriptionHub,
) -> axum::Router {
  // The general API test router deliberately omits document operations. Wire
  // the real PostgreSQL-backed owner while retaining production bearer auth.
  let router = myoxus_mcp::mcp_router(myoxus_mcp::router::McpState {
    key_service: myoxus_application::api_key::ApiKeyService::new(Arc::new(
      myoxus_infrastructure::api_key::SqlxApiKeyStore::new(pool.clone()),
    )),
    tool_state,
    subscriptions: hub,
    availability: Arc::new(myoxus_mcp::router::StaticMcpAvailability(true)),
  });
  axum::Router::new().nest("/mcp", router)
}

// A bounded consumer of the SDK's actual SSE body, not a replacement protocol
// service. Keep bytes buffered across frame boundaries, including split UTF-8.
struct ResourceStream {
  body: axum::body::Body,
  buffer: Vec<u8>,
}
impl ResourceStream {
  async fn next(&mut self) -> Option<Value> {
    use http_body_util::BodyExt;
    loop {
      if let Some(end) = self.buffer.windows(2).position(|window| window == b"\n\n") {
        let record = self.buffer.drain(..end + 2).collect::<Vec<_>>();
        for line in std::str::from_utf8(&record).expect("SDK UTF-8 SSE").lines() {
          if let Some(data) = line.strip_prefix("data:") {
            return Some(serde_json::from_str(data).expect("SDK event JSON"));
          }
        }
        continue;
      }
      let frame = self.body.frame().await?.expect("SDK stream frame");
      if let Ok(bytes) = frame.into_data() {
        self.buffer.extend_from_slice(&bytes);
      }
      assert!(self.buffer.len() <= 2 * 1024 * 1024, "bounded SSE frame");
    }
  }

  async fn update(&mut self) -> String {
    let message = tokio::time::timeout(std::time::Duration::from_secs(20), self.next())
      .await
      .expect("resource update arrives")
      .expect("subscription remains live");
    assert_eq!(message["method"], "notifications/resources/updated", "{message}");
    assert_eq!(message["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"], 71);
    message["params"]["uri"].as_str().expect("resource URI").to_string()
  }
}

async fn resource_stream(app: &axum::Router, token: &str, uris: &[String]) -> ResourceStream {
  use tower::ServiceExt;
  let response = app
    .clone()
    .oneshot(
      axum::http::Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("host", "myoxus.test")
        .header("accept", "application/json, text/event-stream")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .header("mcp-protocol-version", "2026-07-28")
        .header("mcp-method", "subscriptions/listen")
        .body(axum::body::Body::from(
          json!({"jsonrpc":"2.0","id":71,"method":"subscriptions/listen","params":{
            "notifications":{"resourceSubscriptions":uris},"_meta":{
              "io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}
            }
          }})
          .to_string(),
        ))
        .expect("listen request"),
    )
    .await
    .expect("listen HTTP");
  assert_eq!(response.status(), axum::http::StatusCode::OK);
  let mut stream = ResourceStream {
    body: response.into_body(),
    buffer: Vec::new(),
  };
  let ack = tokio::time::timeout(std::time::Duration::from_secs(5), stream.next())
    .await
    .unwrap()
    .unwrap();
  assert_eq!(ack["method"], "notifications/subscriptions/acknowledged");
  stream
}

async fn assert_no_observation_groups(hub: &myoxus_mcp::subscriptions::SubscriptionHub) {
  tokio::time::timeout(std::time::Duration::from_secs(3), async {
    while hub.active_observation_groups() != 0 {
      tokio::task::yield_now().await;
    }
  })
  .await
  .expect("disconnect releases resource bindings");
}

pub(super) async fn document_read_call(app: &axum::Router, token: &str, name: &str, arguments: Value) -> Value {
  let response = document_read_rpc(app, token, "tools/call", json!({"name": name, "arguments": arguments})).await;
  assert!(response.get("error").is_none(), "{name}: {}", response["error"]);
  assert_ne!(
    response["result"]["isError"], true,
    "{name}: {}",
    response["result"]["structuredContent"]
  );
  response["result"]["structuredContent"].clone()
}

// Existing reading-content assertions select visible body blocks. Native empty
// targets remain in the response and are asserted unfiltered in their own contract.
fn reading_blocks(projection: &Value) -> impl Iterator<Item = &Value> {
  projection["document"]["blocks"]
    .as_array()
    .expect("structured blocks")
    .iter()
    .filter(|block| {
      !(matches!(block["kind"].as_str(), Some("paragraph" | "heading" | "quote"))
        && block["text"].as_array().is_some_and(Vec::is_empty))
    })
}

fn reading_block(projection: &Value, index: usize) -> &Value {
  reading_blocks(projection).nth(index).expect("reading content block")
}

#[tokio::test]
async fn inv_mcp_compat_mutation_readback_is_nested_bounded_authorized_and_commit_bound() {
  use futures_util::FutureExt;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "readback-owner").await;
  let (external, external_session) = helpers::seed_user(&pool, &auth_store, "readback-external").await;
  let workspace = create_workspace(&pool, owner).await;
  let mut state = build_tool_state(&pool);
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
  let docs = state.doc_service.clone();
  let app = document_read_router(&pool, state);
  let outcome = std::panic::AssertUnwindSafe(async {
    let token = document_read_key(&key_app, session, &["read:docs", "write:docs"]).await;
    let external_token = document_read_key(&key_app, external_session, &["read:docs", "write:docs"]).await;
    let created = document_read_call(&app, &token, "create_page", json!({
      "workspace_id":workspace,"title":"Readback","content_markdown":(0..205).map(|i|format!("Paragraph {i}")).collect::<Vec<_>>().join("\n\n")
    })).await;
    let external_id = created["externalId"].as_str().expect("external ID");
    let doc: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2")
      .bind(workspace).bind(external_id).fetch_one(&pool).await.expect("leaf ID");
    let read_args = json!({"workspace_id":workspace,"external_id":external_id,"representation":"structured","limit":200});
    let page = document_read_call(&app, &token, "read_doc", read_args.clone()).await;
    assert_eq!(page["document"]["blocks"].as_array().expect("first page").len(),200);
    let mut next_args = read_args.clone();
    next_args["cursor"] = page["page"]["nextCursor"].clone();
    let next = document_read_call(&app, &token, "read_doc", next_args).await;
    let late = next["document"]["blocks"].as_array().unwrap().last().unwrap()["blockId"].as_str().expect("block 205");
    let patch_args = |operation: &str, mut payload: Value| {
      payload["workspace_id"] = json!(workspace);
      payload["external_id"] = json!(external_id);
      payload["operation"] = json!(operation);
      payload["idempotency_key"] = json!(Uuid::new_v4().to_string());
      payload
    };
    let args = patch_args("edit_text",json!({"block_id":late,"start":0,"end":9,"replacement":"Late edit"}));
    let edited = document_read_call(&app,&token,"doc_patch",args).await;
    assert_eq!(edited["readback"],json!({"status":"complete"}));
    assert_eq!(edited["updatedBlocks"][0]["blockId"],late);
    assert!(edited["updatedBlocks"].to_string().contains("Late edit"));
    let nested = document_read_call(&app,&token,"doc_patch",patch_args("append_blocks",json!({"fragment":{
      "schemaVersion":"myoxus.document-fragment.v1","blocks":[
        {"kind":"list_item","listKind":"bulleted","spans":[{"text":"Outer"}],"children":[
          {"kind":"list_item","listKind":"bulleted","spans":[{"text":"Inner"}],"children":[
            {"kind":"paragraph","spans":[{"text":"Deep"}]}
          ]}
        ]},
        {"kind":"list_item","listKind":"bulleted","spans":[{"text":"Sibling"}]}
      ]
    }}))).await;
    assert_eq!(nested["readback"]["status"],"complete");
    assert_eq!(nested["insertedBlockIds"].as_array().expect("all inserted IDs").len(),4);
    for id in nested["insertedBlockIds"].as_array().expect("IDs") {
      assert!(nested["updatedBlocks"].as_array().expect("readback").iter().any(|block|block["blockId"] == *id));
    }
    let deep = nested["updatedBlocks"].as_array().expect("blocks").iter().find(|block|block["kind"] == "paragraph").expect("deep paragraph")["blockId"].as_str().expect("deep ID");
    let deep_edit = document_read_call(&app,&token,"doc_patch",patch_args("edit_text",json!({"block_id":deep,"start":0,"end":4,"replacement":"Deep changed"}))).await;
    assert_eq!(deep_edit["updatedBlocks"][0]["blockId"],deep);
    assert!(deep_edit["updatedBlocks"].to_string().contains("Deep changed"));
    let sibling = nested["insertedBlockIds"][1].as_str().expect("second top-level list item");
    let sibling_edit = document_read_call(&app,&token,"doc_patch",patch_args("edit_text",json!({"block_id":sibling,"start":0,"end":7,"replacement":"Sibling changed"}))).await;
    assert_eq!(sibling_edit["readback"]["status"],"complete");
    assert_eq!(sibling_edit["updatedBlocks"][0]["blockId"],sibling);
    assert!(sibling_edit["updatedBlocks"].to_string().contains("Sibling changed"));

    let gate = Arc::new(CommitReadbackGate { doc, armed:AtomicBool::new(true), entered:Notify::new(), release:Notify::new() });
    docs.set_document_graph_index_hook(gate.clone()).await;
    let first_args = patch_args("edit_text",json!({"block_id":late,"start":0,"end":1,"replacement":"A"}));
    let second_args = patch_args("edit_text",json!({"block_id":late,"start":0,"end":1,"replacement":"B"}));
    // A has committed but cannot return. B must finish before A's projection;
    // rereading the latest state would causally return B's text for both calls.
    let (first, second) = tokio::join!(
      document_read_call(&app,&token,"doc_patch",first_args.clone()),
      async {
        tokio::time::timeout(std::time::Duration::from_secs(10),gate.entered.notified()).await.expect("A committed");
        let second = document_read_call(&app,&token,"doc_patch",second_args).await;
        assert_eq!(docs.load.load_full_doc_with_revision(workspace,doc).await.expect("current head").revision,second["revision"].as_i64().expect("B revision"));
        gate.release.notify_one();
        second
      }
    );
    assert!(first["revision"].as_i64().expect("A") < second["revision"].as_i64().expect("B"));
    assert!(first["updatedBlocks"][0]["text"][0]["text"].as_str().expect("A text").starts_with('A'));
    assert!(second["updatedBlocks"][0]["text"][0]["text"].as_str().expect("B text").starts_with('B'));
    assert_eq!(document_read_call(&app,&token,"doc_patch",first_args.clone()).await,first,"replay keeps A, not the newer B head");
    sqlx::query("UPDATE api_keys SET scopes=ARRAY['write:docs'] WHERE user_id=$1")
      .bind(owner).execute(&pool).await.expect("remove current read scope");
    let hidden = document_read_call(&app,&token,"doc_patch",first_args.clone()).await;
    assert_eq!(hidden["updatedBlocks"],json!([]));
    assert_eq!(hidden["readback"],json!({"status":"unavailable","reason":"read_access_denied"}));
    assert_eq!(hidden["revision"],first["revision"]);
    sqlx::query("UPDATE api_keys SET scopes=ARRAY['read:docs','write:docs'] WHERE user_id=$1")
      .bind(owner).execute(&pool).await.expect("restore read scope");
    assert_eq!(document_read_call(&app,&token,"doc_patch",first_args.clone()).await,first,"redaction does not overwrite durable content");
    let replay_key = first_args["idempotency_key"].as_str().expect("replay key");
    let mut legacy: Value = sqlx::query_scalar("SELECT response_json FROM mcp_idempotency_keys WHERE user_id=$1 AND idempotency_key=$2")
      .bind(owner).bind(replay_key).fetch_one(&pool).await.expect("owned durable response");
    let mut legacy_payload: Value = serde_json::from_str(legacy["content"][0]["text"].as_str().expect("stored payload")).expect("stored JSON");
    legacy_payload.as_object_mut().expect("payload object").remove("readback");
    legacy["content"][0]["text"] = json!(legacy_payload.to_string());
    sqlx::query("UPDATE mcp_idempotency_keys SET response_json=$3 WHERE user_id=$1 AND idempotency_key=$2")
      .bind(owner).bind(replay_key).bind(legacy).execute(&pool).await.expect("pre-upgrade response fixture");
    let legacy = document_read_call(&app,&token,"doc_patch",first_args).await;
    assert_eq!(legacy["updatedBlocks"],json!([]));
    assert_eq!(legacy["readback"],json!({"status":"unavailable","reason":"legacy_commit_unavailable"}));
    assert_eq!(legacy["revision"],first["revision"]);

    sqlx::query("INSERT INTO workspace_memberships (workspace_id,user_id,role,status,joined_at) VALUES ($1,$2,'External','Accepted',now())")
      .bind(workspace).bind(external).execute(&pool).await.expect("External membership");
    sqlx::query("INSERT INTO doc_user_permissions (user_id,doc_id,role) VALUES ($1,$2,'Editor')")
      .bind(external).bind(doc).execute(&pool).await.expect("explicit edit grant");
    gate.armed.store(true,Ordering::SeqCst);
    let external_args = patch_args("edit_text",json!({"block_id":late,"start":0,"end":1,"replacement":"E"}));
    let (revoked, ()) = tokio::join!(
      document_read_call(&app,&external_token,"doc_patch",external_args),
      async {
        tokio::time::timeout(std::time::Duration::from_secs(10),gate.entered.notified()).await.expect("External write committed");
        sqlx::query("DELETE FROM doc_user_permissions WHERE user_id=$1 AND doc_id=$2")
          .bind(external).bind(doc).execute(&pool).await.expect("revoke before readback");
        gate.release.notify_one();
      }
    );
    assert_eq!(revoked["updatedBlocks"],json!([]));
    assert_eq!(revoked["readback"],json!({"status":"unavailable","reason":"read_access_denied"}));
    assert!(revoked["revision"].as_i64().expect("committed External write") > second["revision"].as_i64().expect("B"));
    let removed = document_read_call(&app,&token,"doc_patch",patch_args("delete_block",json!({"block_id":nested["insertedBlockIds"][0]}))).await;
    assert_eq!(removed["readback"]["status"],"complete");
    assert_eq!(removed["updatedBlocks"],json!([]));
    assert_eq!(removed["removedBlockIds"].as_array().expect("removed descendants").len(),3);
    let bounded = document_read_call(&app,&token,"doc_patch",patch_args("append_blocks",json!({
      "content_markdown":(0..201).map(|i|format!("Bounded {i}")).collect::<Vec<_>>().join("\n\n")
    }))).await;
    assert_eq!(bounded["insertedBlockIds"].as_array().expect("all created").len(),201);
    assert_eq!(bounded["updatedBlocks"],json!([]));
    assert_eq!(bounded["readback"],json!({"status":"unavailable","reason":"output_limit"}));
  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner, external]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

/// Uses an existing post-commit port, with no persistence or projection stub.
struct CommitReadbackGate {
  doc: Uuid,
  armed: AtomicBool,
  entered: Notify,
  release: Notify,
}

#[async_trait::async_trait]
impl myoxus_application::doc::DocumentGraphIndexHook for CommitReadbackGate {
  async fn enqueue_document_graph_reindex(
    &self,
    _workspace: Uuid,
    doc: Uuid,
    _reason: myoxus_domain::document_graph::DocumentGraphReindexReason,
  ) -> Result<(), String> {
    if doc == self.doc && self.armed.swap(false, Ordering::SeqCst) {
      self.entered.notify_one();
      tokio::time::timeout(std::time::Duration::from_secs(10), self.release.notified())
        .await
        .expect("release committed writer");
    }
    Ok(())
  }
  async fn mark_document_graph_deleted(&self, _workspace: Uuid, _doc: Uuid) -> Result<(), String> {
    Ok(())
  }
}

#[tokio::test]
async fn inv_mcp_compat_mcp_document_revision_guards_all_content_writes_without_side_effects() {
  use futures_util::FutureExt;
  use myoxus_application::ports::BlobWriteRequest;
  use sha2::{Digest, Sha256};
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "revision-write-owner").await;
  let workspace = create_workspace(&pool, owner).await;
  let (blobs, storage, _storage_dir) = super::mcp_blob_tools_test::blob_test_services(&pool);
  let state = super::mcp_blob_tools_test::build_tool_state(&pool, blobs.clone());
  let docs = state.doc_service.clone();
  let app = document_read_router(&pool, state);
  let outcome = std::panic::AssertUnwindSafe(async {
    let token = document_read_key(&key_app, session, &["read:docs", "write:docs"]).await;
    let created = document_read_call(
      &app,
      &token,
      "create_page",
      json!({
        "workspace_id": workspace, "title": "Original", "content_markdown": "Anchor"
      }),
    )
    .await;
    let external_id = created["externalId"].as_str().expect("external ID");
    let doc: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2")
      .bind(workspace)
      .bind(external_id)
      .fetch_one(&pool)
      .await
      .expect("leaf ID");
    let target = document_read_call(
      &app,
      &token,
      "create_page",
      json!({
        "workspace_id": workspace, "title": "Target", "content_markdown": "Reference target"
      }),
    )
    .await;
    let png = bytes::Bytes::from_static(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR");
    let prepared = document_read_call(
      &app,
      &token,
      "document_asset_upload_prepare",
      json!({
        "workspace_id": workspace, "filename": "fixture.png", "mime": "image/png",
        "byte_size": png.len(), "sha256": hex::encode(Sha256::digest(&png))
      }),
    )
    .await;
    let asset = prepared["assetRef"].as_str().expect("asset");
    storage
      .write_blob(BlobWriteRequest {
        key: format!("{workspace}/{asset}"),
        content_type: Some("image/png".into()),
        body: png,
      })
      .await
      .expect("fixture bytes");
    blobs.complete_upload(workspace, asset).await.expect("complete asset");
    let read_args = json!({"workspace_id":workspace,"external_id":external_id,"representation":"structured"});
    let before = document_read_call(&app, &token, "read_doc", read_args.clone()).await;
    let anchor = (*reading_block(&before, 0))["blockId"].as_str().expect("anchor");
    let revision = before["revision"].as_i64().expect("revision");
    let leaf_before = docs
      .load
      .load_full_doc_with_revision(workspace, doc)
      .await
      .expect("leaf");
    let root_before = docs
      .load
      .load_full_doc_with_revision(workspace, workspace)
      .await
      .expect("root");
    let counts = |pool: sqlx::PgPool| async move {
      sqlx::query_as::<_, (i64, i64, i64)>(
        "SELECT (SELECT count(*) FROM doc_updates WHERE workspace_id=$1),
         (SELECT count(*) FROM doc_histories WHERE workspace_id=$1),
         (SELECT count(*) FROM outbox_events WHERE payload->>'workspaceId'=$1::text)",
      )
      .bind(workspace)
      .fetch_one(&pool)
      .await
      .expect("durable mutation counts")
    };
    let counts_before = counts(pool.clone()).await;
    let writes = [
      ("doc_patch", json!({"operation":"update_title","title":"Guarded title"})),
      (
        "doc_patch",
        json!({"operation":"edit_text","block_id":anchor,"start":0,"end":1,"replacement":"Z"}),
      ),
      (
        "document_image_insert",
        json!({"asset_ref":asset,"caption":"Guarded image"}),
      ),
      (
        "document_reference_insert",
        json!({"target_external_id":target["externalId"],"label":"Guarded reference"}),
      ),
      (
        "update_doc",
        json!({"confirm_replace_all":true,"content_markdown":"Guarded replacement"}),
      ),
    ];
    for (index, (name, payload)) in writes.iter().enumerate() {
      for expected in [
        json!(revision - 1),
        Value::Null,
        json!(-1),
        json!("invalid"),
        json!(0.5),
      ] {
        let mut args = payload.clone();
        args["workspace_id"] = json!(workspace);
        args["external_id"] = json!(external_id);
        args["expected_revision"] = expected.clone();
        args["idempotency_key"] = json!(format!("rejected-{index}-{expected}"));
        let rejected = document_read_rpc(&app, &token, "tools/call", json!({"name":name,"arguments":args})).await;
        assert_eq!(rejected["result"]["isError"], true, "{name} accepted {expected}");
        if expected == json!(revision - 1) {
          let error = rejected["result"].to_string();
          assert!(
            error.contains("CONFLICT") && error.contains(&format!("current revision {revision}")),
            "{error}"
          );
          assert!(!error.contains("Anchor"), "conflict must not expose content");
        }
      }
      assert_eq!(
        docs
          .load
          .load_full_doc_with_revision(workspace, doc)
          .await
          .expect("leaf")
          .payload,
        leaf_before.payload
      );
      let root = docs
        .load
        .load_full_doc_with_revision(workspace, workspace)
        .await
        .expect("root");
      assert_eq!(
        (root.payload, root.revision),
        (root_before.payload.clone(), root_before.revision)
      );
      assert_eq!(
        counts(pool.clone()).await,
        counts_before,
        "rejected writes must create no updates/history/outbox"
      );
      let title: String = sqlx::query_scalar("SELECT title FROM docs WHERE id=$1")
        .bind(doc)
        .fetch_one(&pool)
        .await
        .expect("SQL title");
      assert_eq!(title, "Original");
    }
    for (index, (name, payload)) in writes.iter().enumerate() {
      let current = document_read_call(&app, &token, "read_doc", read_args.clone()).await;
      let mut args = payload.clone();
      args["workspace_id"] = json!(workspace);
      args["external_id"] = json!(external_id);
      args["expected_revision"] = current["revision"].clone();
      args["idempotency_key"] = json!(format!("accepted-{index}"));
      let committed = document_read_call(&app, &token, name, args.clone()).await;
      assert!(committed["revision"].as_i64().expect("committed") > current["revision"].as_i64().expect("current"));
      assert_eq!(document_read_call(&app, &token, name, args.clone()).await, committed);
      let after = document_read_call(&app, &token, "read_doc", read_args.clone()).await;
      assert_eq!(after["revision"], committed["revision"]);
      if index == 0 {
        assert_eq!(after["document"]["title"], "Guarded title");
        let root = docs
          .load
          .load_full_doc_with_revision(workspace, workspace)
          .await
          .expect("renamed root");
        let native = Doc::new();
        native
          .transact_mut()
          .apply_update(Update::decode_v1(&root.payload).expect("root update"))
          .expect("apply root");
        let txn = native.transact();
        let meta = txn.get_map("meta").expect("meta");
        let yrs::Out::YArray(pages) = meta.get(&txn, "pages").expect("pages") else {
          panic!("pages array")
        };
        assert!(
          pages.iter(&txn).any(|page| {
            let yrs::Out::YMap(page) = page else { return false };
            page.get(&txn, "id").is_some_and(|id| id.to_string(&txn) == external_id)
              && page
                .get(&txn, "title")
                .is_some_and(|title| title.to_string(&txn) == "Guarded title")
          }),
          "root and leaf titles must converge atomically"
        );
      }
      args["expected_revision"] = committed["revision"].clone();
      let conflict = document_read_rpc(&app, &token, "tools/call", json!({"name":name,"arguments":args})).await;
      assert_eq!(
        conflict["result"]["isError"], true,
        "precondition participates in replay identity"
      );
      assert_eq!(
        document_read_call(&app, &token, "read_doc", read_args.clone()).await["revision"],
        committed["revision"]
      );
    }
  })
  .catch_unwind()
  .await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_document_discovery_enforces_live_acl_past_denied_candidate_pages() {
  use futures_util::FutureExt;
  use myoxus_domain::repositories::SearchRepository;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, owner_session) = helpers::seed_user(&pool, &auth_store, "discovery-owner").await;
  let (external, external_session) = helpers::seed_user(&pool, &auth_store, "discovery-external").await;
  let workspace = create_workspace(&pool, owner).await;
  let orphan_event = Uuid::new_v4();
  let outcome = std::panic::AssertUnwindSafe(async {
    sqlx::query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'document',$2,'workspace_doc_broadcast',$3)")
      .bind(orphan_event).bind(Uuid::new_v4().to_string())
      .bind(json!({"workspaceId": Uuid::new_v4(), "actorUserId": owner, "docId": Uuid::new_v4(), "sequence": 1}))
      .execute(&pool).await.expect("fixture whose workspace was already deleted");
    sqlx::query("INSERT INTO workspace_memberships (workspace_id,user_id,role,status,joined_at) VALUES ($1,$2,'External','Accepted',now())")
      .bind(workspace).bind(external).execute(&pool).await.expect("External membership");
    let owner_key = document_read_key(&key_app, owner_session, &["read:docs", "write:docs"]).await;
    let external_key = document_read_key(&key_app, external_session, &["read:docs"]).await;
    let mut state = build_tool_state(&pool);
    let search = Arc::new(myoxus_infrastructure::search::SqlxSearchRepository::new(pool.clone()));
    state.search_repository = Some(search.clone());
    state.workspace_tag_service = Some(Arc::new(myoxus_application::workspace_tags::WorkspaceTagService::new(
      Arc::new(myoxus_infrastructure::workspace_tags::PgWorkspaceTagRepository::new(pool.clone(), crate::helpers::database_starter_catalog())),
      state.permission_service.clone(),
    )));
    let doc_service = state.doc_service.clone();
    let app = document_read_router(&pool, state);
    let mut keys = Vec::new();
    // Every candidate is native persisted content, not metadata-only rows.
    // Create granted candidates first so 200 later denied rows precede them.
    for index in 0..263 {
      let title = if index < 63 { format!("needle granted {index}") } else { format!("needle classified {index}") };
      let created = document_read_call(&app, &owner_key, "create_page", json!({
        "workspace_id": workspace, "title": title, "content_markdown": "needle native persisted content"
      })).await;
      keys.push(created["externalId"].as_str().expect("native external key").to_string());
    }
    let rows = sqlx::query("SELECT id,external_id,title FROM docs WHERE workspace_id=$1 AND NOT is_workspace_root")
      .bind(workspace).fetch_all(&pool).await.expect("materialized candidates");
    let identities = rows.iter().map(|row| (row.get::<String,_>("external_id"), row.get::<Uuid,_>("id"))).collect::<HashMap<_,_>>();
    let granted_ids = keys[..63].iter().map(|key| identities[key]).collect::<Vec<_>>();
    let future = chrono::DateTime::parse_from_rfc3339("2099-01-01T00:00:00Z").unwrap().with_timezone(&chrono::Utc);
    sqlx::query("UPDATE docs SET created_at=$1 WHERE workspace_id=$2 AND NOT is_workspace_root AND NOT (id=ANY($3))")
      .bind(future).bind(workspace).bind(&granted_ids).execute(&pool).await.expect("tied denied candidate order");
    for row in &rows {
      let id: Uuid = row.get("id");
      search.upsert_search_doc(&myoxus_domain::entities::SearchDocument {
        workspace_id: workspace, doc_id: id, title: row.get("title"),
        plain_text: "needle native persisted content".to_string(), workspace_tags: Vec::new(), search_vector: None,
        updated_at: if granted_ids.contains(&id) { chrono::Utc::now() } else { future },
      }).await.expect("native search fixture");
    }
    let raw_page = doc_service.list_workspace_docs(workspace, 200, 0).await.expect("candidate page");
    assert_eq!(raw_page.len(), 200);
    assert!(raw_page.iter().all(|doc| !granted_ids.contains(&doc.id)));
    let mut sorted_ids = raw_page.iter().map(|doc| doc.id).collect::<Vec<_>>();
    sorted_ids.sort();
    assert_eq!(raw_page.iter().map(|doc| doc.id).collect::<Vec<_>>(), sorted_ids, "tied pagination must have a stable identity order");
    let raw_search = search.search_docs(myoxus_domain::repositories::SearchPageRequest {
      query: "needle".to_string(), language: None, workspace_id: workspace,
      sort_by: myoxus_domain::repositories::SearchSortBy::Relevance,
      sort_direction: myoxus_domain::repositories::SortDirection::Desc,
      page: myoxus_domain::repositories::PageRequest { limit: 200, offset: 0 },
    }).await.expect("unfiltered search candidates");
    assert_eq!(raw_search.len(), 200);
    assert!(raw_search.iter().all(|doc| !granted_ids.contains(&doc.doc_id)), "fixture must deny the entire first search page");
    assert_eq!(raw_search.iter().map(|doc| doc.doc_id).collect::<Vec<_>>(), sorted_ids);
    let version = document_read_call(&app, &owner_key, "doc_version_create", json!({
      "workspace_id": workspace, "external_id": keys[0], "label": "ACL version"
    })).await;
    let version_label = version["version"]["label"].as_str().expect("persisted version label").to_string();
    let empty = document_read_call(&app, &external_key, "list_pages", json!({"workspace_id": workspace, "limit": 1})).await;
    assert_eq!(empty["pages"], json!([]));
    assert_eq!(document_read_call(&app, &external_key, "search_docs", json!({"workspace_id": workspace, "query": "needle"})).await["total_count"], 0);
    sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) SELECT $1,unnest($2::uuid[]),'Reader'")
      .bind(external).bind(&granted_ids[..3]).execute(&pool).await.expect("grant subset");
    // Keep the indexed row intentionally stale after soft deletion.
    sqlx::query("UPDATE docs SET deleted_at=now() WHERE id=$1").bind(granted_ids[2]).execute(&pool).await.expect("deleted granted document");
    let first = document_read_call(&app, &external_key, "list_pages", json!({"workspace_id": workspace, "limit": 1})).await;
    assert_eq!(first["pages"].as_array().unwrap().len(), 1);
    let second = document_read_call(&app, &external_key, "list_pages", json!({
      "workspace_id": workspace, "limit": 1, "cursor": first["next_cursor"]
    })).await;
    let actual = [first["pages"][0]["externalId"].as_str().unwrap(), second["pages"][0]["externalId"].as_str().unwrap()]
      .into_iter().collect::<std::collections::HashSet<_>>();
    assert_eq!(actual, [&*keys[0], &*keys[1]].into_iter().collect());
    assert!(second.get("next_cursor").is_none());
    let matches = document_read_call(&app, &external_key, "search_docs", json!({"workspace_id": workspace, "query": "needle", "limit": 2})).await;
    assert_eq!(matches["total_count"], 2);
    assert_eq!(matches["results"].as_array().unwrap().iter().map(|row| row["externalId"].as_str().unwrap()).collect::<std::collections::HashSet<_>>(), actual);
    assert!(!matches.to_string().contains("classified"));
    let versions = document_read_call(&app, &external_key, "doc_version_list", json!({"workspace_id": workspace, "external_id": keys[0]})).await;
    assert!(versions["versions"].as_array().unwrap().iter().any(|row| row["label"] == version_label));
    for name in ["doc_metadata_get", "doc_metadata_validate", "document_tags_get", "page_projection_inspect"] {
      let arguments = if name == "page_projection_inspect" { json!({"workspace_id": workspace, "external_doc_id": keys[0]}) }
        else { json!({"workspace_id": workspace, "external_id": keys[0]}) };
      document_read_call(&app, &external_key, name, arguments).await;
    }
    let scan = document_read_call(&app, &external_key, "page_projection_scan", json!({"workspace_id": workspace, "limit": 1})).await;
    assert_eq!(scan["items"].as_array().unwrap().len(), 1);
    assert!(actual.contains(scan["items"][0]["externalDocId"].as_str().unwrap()));
    if let Some(cursor) = scan["nextCursor"].as_str() {
      let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(cursor).expect("diagnostic cursor");
      let decoded: Value = serde_json::from_slice(&decoded).expect("cursor payload");
      if let Some(last) = decoded["lastKey"].as_str() { assert!(actual.contains(last), "cursor must not disclose denied keys"); }
    }
    for denied_key in [&keys[2], &keys[3]] {
      for name in ["doc_version_list", "doc_metadata_get", "doc_metadata_validate", "document_tags_get", "page_projection_inspect"] {
        let arguments = if name == "page_projection_inspect" { json!({"workspace_id": workspace, "external_doc_id": denied_key}) }
          else { json!({"workspace_id": workspace, "external_id": denied_key}) };
        let denied = document_read_rpc(&app, &external_key, "tools/call", json!({"name": name, "arguments": arguments})).await;
        assert_eq!(denied["result"]["isError"], true, "{name} must deny existing ungranted/deleted content");
      }
    }
    sqlx::query("DELETE FROM doc_user_permissions WHERE user_id=$1 AND doc_id=$2")
      .bind(external).bind(granted_ids[0]).execute(&pool).await.expect("revoke first grant");
    for name in ["list_pages", "search_docs"] {
      let arguments = if name == "search_docs" { json!({"workspace_id": workspace, "query": "needle"}) }
        else { json!({"workspace_id": workspace}) };
      let result = document_read_call(&app, &external_key, name, arguments).await;
      let items = result[if name == "list_pages" { "pages" } else { "results" }].as_array().unwrap();
      assert_eq!(items.len(), 1);
      assert_eq!(items[0]["externalId"], keys[1]);
    }
    for name in ["doc_version_list", "doc_metadata_get", "doc_metadata_validate", "document_tags_get", "page_projection_inspect"] {
      let arguments = if name == "page_projection_inspect" { json!({"workspace_id": workspace, "external_doc_id": keys[0]}) }
        else { json!({"workspace_id": workspace, "external_id": keys[0]}) };
      assert_eq!(document_read_rpc(&app, &external_key, "tools/call", json!({"name": name, "arguments": arguments})).await["result"]["isError"], true, "revocation must affect {name}");
    }

    // Continue more than the legacy 50-row maximum through the same native
    // candidates. The deleted granted row remains indexed throughout.
    sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) SELECT $1,unnest($2::uuid[]),'Reader' ON CONFLICT DO NOTHING")
      .bind(external).bind(&granted_ids).execute(&pool).await.expect("grant continuation set");
    let args = json!({"workspace_id": workspace, "query": "needle", "language": "en-US", "limit": 50});
    let page = document_read_call(&app, &external_key, "search_docs", args.clone()).await;
    assert_eq!(page["total_count"], 50);
    assert_eq!(page["exhausted"], false);
    let cursor = page["next_cursor"].as_str().expect("search continuation");
    let mut continued = args.clone(); continued["cursor"] = json!(cursor);
    let tail = document_read_call(&app, &external_key, "search_docs", continued.clone()).await;
    assert_eq!(tail["total_count"], 12);
    assert_eq!(tail["exhausted"], true);
    assert!(tail["next_cursor"].is_null());
    assert_eq!(document_read_call(&app, &external_key, "search_docs", continued.clone()).await, tail, "retry preserves the unchanged result page");
    let traversed = page["results"].as_array().unwrap().iter().chain(tail["results"].as_array().unwrap()).map(|row| row["externalId"].as_str().unwrap()).collect::<Vec<_>>();
    let unique = traversed.iter().copied().collect::<std::collections::HashSet<_>>();
    assert_eq!(traversed.len(), 62);
    assert_eq!(unique.len(), 62, "no duplicate between pages");
    assert_eq!(unique, keys[..63].iter().enumerate().filter(|(index,_)| *index != 2).map(|(_,key)| key.as_str()).collect());
    assert!(!page.to_string().contains("classified"));
    for (field,value) in [("query", json!("different")), ("cursor", json!(42))] {
      let mut mismatch = continued.clone(); mismatch[field] = value;
      let error = document_read_rpc(&app, &external_key, "tools/call", json!({"name":"search_docs", "arguments":mismatch})).await;
      assert_eq!(error["result"]["isError"], true);
      if field == "query" { assert!(error.to_string().contains("MIX_MCP_SEARCH_CURSOR_INVALID")); }
    }
    let mut changed_language = continued.clone(); changed_language["language"] = json!("de-DE");
    assert_eq!(document_read_rpc(&app, &external_key, "tools/call", json!({"name":"search_docs", "arguments":changed_language})).await["result"]["isError"], true);
    // The workspace owner has access, but another user's cursor is still invalid.
    assert_eq!(document_read_rpc(&app, &owner_key, "tools/call", json!({"name":"search_docs", "arguments":continued.clone()})).await["result"]["isError"], true);
    let tail_ids = tail["results"].as_array().unwrap().iter().map(|row| identities[row["externalId"].as_str().unwrap()]).collect::<Vec<_>>();
    sqlx::query("DELETE FROM doc_user_permissions WHERE user_id=$1 AND doc_id=ANY($2)")
      .bind(external).bind(&tail_ids).execute(&pool).await.expect("revoke next-page grants");
    let revoked = document_read_call(&app, &external_key, "search_docs", continued.clone()).await;
    assert_eq!(revoked["total_count"], 0); assert_eq!(revoked["results"], json!([])); assert_eq!(revoked["exhausted"], true);
    sqlx::query("UPDATE workspace_memberships SET status='Pending' WHERE workspace_id=$1 AND user_id=$2")
      .bind(workspace).bind(external).execute(&pool).await.expect("revoke workspace membership");
    assert_eq!(document_read_rpc(&app, &external_key, "tools/call", json!({"name":"search_docs", "arguments":continued})).await["result"]["isError"], true);
  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner, external]).await;
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces WHERE id=$1")
      .bind(workspace)
      .fetch_one(&pool)
      .await
      .expect("cleanup proof"),
    0
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>(
      "SELECT count(*) FROM outbox_events WHERE event_type='workspace_doc_broadcast' AND payload->>'workspaceId'=$1"
    )
    .bind(workspace.to_string())
    .fetch_one(&pool)
    .await
    .expect("outbox cleanup proof"),
    0
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM outbox_events WHERE id=$1")
      .bind(orphan_event)
      .fetch_one(&pool)
      .await
      .expect("already-deleted workspace cleanup proof"),
    0
  );
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_compat_document_resources_enforce_scopes_acl_and_complete_unicode() {
  use futures_util::FutureExt;
  let (app, pool, auth_store) = helpers::setup_app_with_config_override(|config| {
    config.mcp.enabled = true;
    config.mcp.document_export_max_bytes = 128 * 1024;
  })
  .await;
  let (owner, owner_session) = helpers::seed_user(&pool, &auth_store, "resource-owner").await;
  let (external, external_session) = helpers::seed_user(&pool, &auth_store, "resource-external").await;
  let workspace = create_workspace(&pool, owner).await;
  // Clean the isolated workspace and credentials even if a causal assertion fails.
  let outcome = std::panic::AssertUnwindSafe(async {
  sqlx::query("INSERT INTO workspace_memberships (workspace_id,user_id,role,status,joined_at) VALUES ($1,$2,'External','Accepted',now())")
    .bind(workspace).bind(external).execute(&pool).await.expect("External membership");
  let owner_key = document_read_key(&app, owner_session, &["read:workspaces", "read:docs", "write:docs"]).await;
  let limited_key = document_read_key(&app, owner_session, &["read:workspaces"]).await;
    let external_key = document_read_key(&app, external_session, &["read:workspaces", "read:docs"]).await;
    let mut tool_state = build_tool_state(&pool);
    tool_state.document_export_max_bytes = 128 * 1024;
    let updates = myoxus_application::events::WorkspaceResourceUpdates::default();
    let hub = myoxus_mcp::subscriptions::SubscriptionHub::with_updates(updates.clone());
    let other_instance = document_read_router(&pool, build_tool_state(&pool));
    let app = document_read_router_with_hub(&pool, tool_state, hub.clone());
  let text = format!("{}🦀 Überprüfung Ende", "a".repeat(99_999));
  let created = document_read_rpc(
    &app,
    &owner_key,
    "tools/call",
    json!({"name": "create_page", "arguments": {
      "workspace_id": workspace, "title": "Unicode resource", "content_markdown": text
    }}),
  )
  .await;
  assert_ne!(created["result"]["isError"], true, "{created}");
  let key = created["result"]["structuredContent"]["externalId"]
    .as_str()
    .expect("external key");
  let uri = format!("myoxus://{workspace}/{key}");
  let read = |token: String, uri: String| {
    let app = app.clone();
    async move { document_read_rpc(&app, &token, "resources/read", json!({"uri": uri})).await }
  };
  let denied = read(limited_key.clone(), uri.clone()).await;
  assert_eq!(denied["error"]["code"], -32003);
  assert!(
    denied["error"]["message"]
      .as_str()
      .expect("scope error")
      .contains("read:docs")
  );
  let workspace_resource = read(limited_key, format!("myoxus://{workspace}")).await;
  assert_eq!(
    workspace_resource["result"]["contents"][0]["mimeType"],
    "application/json"
  );
  assert_eq!(read(external_key.clone(), uri.clone()).await["error"]["code"], -32003);
  let doc: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2")
    .bind(workspace)
    .bind(key)
    .fetch_one(&pool)
    .await
    .expect("native document");
  sqlx::query("INSERT INTO doc_user_permissions (user_id,doc_id,role) VALUES ($1,$2,'Reader')")
    .bind(external)
    .bind(doc)
    .execute(&pool)
    .await
    .expect("explicit grant");
    let granted = read(external_key.clone(), uri.clone()).await;
    assert!(granted.get("error").is_none(), "granted resource failed: {}", granted["error"]);
  let markdown = granted["result"]["contents"][0]["text"]
    .as_str()
    .expect("authorized Markdown");
  assert!(
    markdown.contains(&text),
    "Unicode must survive the former byte boundary"
  );
  let canonical = document_read_rpc(
    &app,
    &external_key,
    "tools/call",
    json!({"name": "read_doc", "arguments": {
      "workspace_id": workspace, "external_id": key, "representation": "markdown"
    }}),
  )
  .await;
  assert_eq!(
    granted["result"]["contents"][0]["text"],
    canonical["result"]["structuredContent"]["data"]
  );
  let inventory_uri = format!("myoxus-workspace://{workspace}/inventory");
  let selected_uri = myoxus_mcp::resources::document_resource_uri(workspace, &DocumentKey::parse(key).unwrap());
  let targets = vec![inventory_uri.clone(), selected_uri.clone()];
  let mut stream = resource_stream(&app, &external_key, &targets).await;
  let initial = [stream.update().await, stream.update().await].into_iter().collect::<std::collections::HashSet<_>>();
  assert_eq!(initial, targets.iter().cloned().collect());
  assert_eq!(hub.active_observation_groups(), 1, "workspace/document share one comparison");
  let inventory = read(external_key.clone(), inventory_uri.clone()).await;
  let inventory:Value = serde_json::from_str(inventory["result"]["contents"][0]["text"].as_str().unwrap()).unwrap();
  assert_eq!(inventory["mode"], "current_state");
  assert_eq!(inventory["documents"].as_array().unwrap().len(), 1);
  let old_revision = inventory["documents"][0]["contentRevision"].as_i64().unwrap();
  let old_metadata = inventory["documents"][0]["metadataRevision"].clone();
  let stamp:chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT updated_at FROM docs WHERE id=$1").bind(doc).fetch_one(&pool).await.unwrap();
  let hidden = document_read_call(&app, &owner_key, "create_page", json!({"workspace_id":workspace,"title":"Hidden page","content_markdown":"Private"})).await;
  updates.wake(workspace);
  assert!(tokio::time::timeout(std::time::Duration::from_secs(17), stream.next()).await.is_err(), "hidden edits/root revisions remain silent through a heartbeat");
  document_read_call(&app, &owner_key, "update_doc", json!({"workspace_id":workspace,"external_id":key,"confirm_replace_all":true,"content_markdown":"Visible committed update","idempotency_key":Uuid::new_v4().to_string()})).await;
  sqlx::query("UPDATE docs SET updated_at=$2 WHERE id=$1").bind(doc).bind(stamp).execute(&pool).await.unwrap();
  // Deliberately omit the wakeup: the shared heartbeat must discover tail-only
  // content changes even when docs.updated_at was restored to its prior value.
  let changed = [stream.update().await, stream.update().await].into_iter().collect::<std::collections::HashSet<_>>();
  assert_eq!(changed, targets.iter().cloned().collect());
  let snapshot = document_read_rpc(&other_instance, &external_key, "resources/read", json!({"uri":inventory_uri})).await;
  let snapshot:Value = serde_json::from_str(snapshot["result"]["contents"][0]["text"].as_str().unwrap()).unwrap();
  assert!(snapshot["documents"][0]["contentRevision"].as_i64().unwrap() > old_revision);
  assert_eq!(snapshot["documents"][0]["metadataRevision"], old_metadata);
  assert!(snapshot.get("revision").is_none() && snapshot["structure"].get("revision").is_none());
  assert!(!snapshot.to_string().contains(hidden["externalId"].as_str().unwrap()));
  let new_page = document_read_call(&app, &owner_key, "create_page", json!({"workspace_id":workspace,"title":"New visible page","content_markdown":"New"})).await;
  sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) SELECT $1,id,'Reader' FROM docs WHERE workspace_id=$2 AND external_id=$3")
    .bind(external).bind(workspace).bind(new_page["externalId"].as_str().unwrap()).execute(&pool).await.unwrap();
  updates.wake(workspace);
  assert_eq!(stream.update().await, inventory_uri, "one workspace binding discovers new visible pages");
  drop(stream);
  assert_no_observation_groups(&hub).await;
  let mut stream = resource_stream(&app, &external_key, &targets).await;
  stream.update().await; stream.update().await;
  let reconnected = read(external_key.clone(), selected_uri).await;
  assert!(reconnected["result"]["contents"][0]["text"].as_str().unwrap().contains("Visible committed update"));
  sqlx::query("DELETE FROM doc_user_permissions WHERE user_id=$1 AND doc_id=$2")
    .bind(external)
    .bind(doc)
    .execute(&pool)
    .await
    .expect("revoke grant");
   assert_eq!(read(external_key.clone(), uri.clone()).await["error"]["code"], -32003);
   updates.wake(workspace);
   assert_eq!(stream.update().await, inventory_uri, "grant loss refreshes inventory, not the inaccessible selected document");
   assert!(tokio::time::timeout(std::time::Duration::from_millis(1200), stream.next()).await.is_err());
   sqlx::query("DELETE FROM api_keys WHERE user_id=$1").bind(external).execute(&pool).await.unwrap();
   updates.wake(workspace);
   let terminal = tokio::time::timeout(std::time::Duration::from_secs(20), stream.next()).await.unwrap().unwrap();
   assert!(terminal.get("error").is_some(), "revoked key must end, not deliver a last resource hint: {terminal}");
   drop(stream);
   assert_no_observation_groups(&hub).await;
  sqlx::query("UPDATE docs SET deleted_at=now() WHERE id=$1")
    .bind(doc)
    .execute(&pool)
    .await
    .expect("soft delete");
  assert_eq!(read(owner_key.clone(), uri).await["error"]["code"], -32004);
  let oversized = document_read_rpc(
    &app,
    &owner_key,
    "tools/call",
    json!({"name": "create_page", "arguments": {
      "workspace_id": workspace, "title": "Oversized resource", "content_markdown": "z".repeat(200_000)
    }}),
  )
  .await;
  let large_key = oversized["result"]["structuredContent"]["externalId"]
    .as_str()
    .expect("oversized native document");
  let rejected = read(owner_key, format!("myoxus://{workspace}/{large_key}")).await;
  assert_eq!(rejected["error"]["code"], -32002);
  assert!(
    rejected["error"]["message"]
      .as_str()
      .expect("safe export error")
      .contains("paginated read_doc")
  );
  assert!(rejected.get("result").is_none(), "no partial body or raw fallback");
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[owner, external]).await;
  let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces WHERE id=$1")
    .bind(workspace)
    .fetch_one(&pool)
    .await
    .expect("verify fixture cleanup");
  assert_eq!(remaining, 0);
  let broadcasts: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE payload->>'workspaceId'=$1")
    .bind(workspace.to_string())
    .fetch_one(&pool)
    .await
    .expect("verify fixture broadcast cleanup");
  assert_eq!(broadcasts, 0, "resource fixture must not leave durable broadcast work");
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

/// Build an `McpToolState` from the test pool.
pub(super) fn build_tool_state(pool: &sqlx::PgPool) -> McpToolState {
  build_tool_state_with_observability(
    pool,
    myoxus_application::audit::AuditRecorder::noop(),
    Arc::new(MetricsService::in_memory_stub()),
  )
}

pub(super) async fn create_workspace(pool: &sqlx::PgPool, user_id: Uuid) -> Uuid {
  let workspace_id = helpers::create_workspace(pool, user_id).await;
  WorkspaceService::new(Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  )))
  .seed_root_doc(
    workspace_id,
    user_id,
    yjs::create_initial_workspace_doc("MCP lifecycle workspace"),
  )
  .await
  .expect("MCP workspace root must be initialized");
  workspace_id
}

fn build_tool_state_with_observability(
  pool: &sqlx::PgPool,
  audit_recorder: AuditRecorder,
  metrics_service: Arc<MetricsService>,
) -> McpToolState {
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
    public_repository: Some(Arc::new(PgPublicRepository::new(pool.clone()))),
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
    audit_recorder,
    metrics_service,
    document_cursor_signing_key: Arc::from(&b"mcp-create-page-test-cursor-key"[..]),
    document_export_max_bytes: 8 * 1024 * 1024,
  }
}

fn observed_tool_state(pool: &sqlx::PgPool) -> (McpToolState, Arc<MetricsService>) {
  observed_tool_state_with_mcp_metrics(pool, true)
}

fn observed_tool_state_with_mcp_metrics(
  pool: &sqlx::PgPool,
  mcp_metrics_enabled: bool,
) -> (McpToolState, Arc<MetricsService>) {
  let metrics_service = Arc::new(MetricsService::in_memory_stub());
  let mut policy = MetricsPolicy {
    enabled: true,
    categories: HashMap::new(),
    label_workspace_id_enabled: true,
    cardinality_limit_per_metric: 10_000,
  };
  for category in METRICS_CATEGORIES {
    policy.categories.insert((*category).to_string(), true);
  }
  policy.categories.insert("mcp".to_string(), mcp_metrics_enabled);
  metrics_service.set_policy(policy);

  let audit_recorder = AuditRecorder::new(Arc::new(PgAuditLogStore::new(pool.clone())));
  (
    build_tool_state_with_observability(pool, audit_recorder, metrics_service.clone()),
    metrics_service,
  )
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

async fn persist_auth_key(pool: &sqlx::PgPool, auth: &McpAuthContext) {
  sqlx::query(
    "INSERT INTO api_keys (id, user_id, name, key_hash, scopes)
     VALUES ($1, $2, 'mcp-document-mutation-test', $3, $4)",
  )
  .bind(auth.key_id)
  .bind(auth.user_id)
  .bind(format!("mcp-document-mutation-test-{}", auth.key_id))
  .bind(&auth.scopes)
  .execute(pool)
  .await
  .expect("insert MCP API key for idempotency");
}

fn parse_created_doc_id(result: &serde_json::Value) -> Uuid {
  let text = result["content"][0]["text"]
    .as_str()
    .expect("create response text must be a string");
  let parsed: serde_json::Value = serde_json::from_str(text).expect("create response must be valid JSON");
  let doc_id = parsed["externalId"].as_str().expect("response must contain externalId");
  Uuid::parse_str(doc_id).expect("doc_id must be a UUID")
}

fn parse_tool_text_json(result: &Value) -> Value {
  let text = result["content"][0]["text"]
    .as_str()
    .expect("tool response text must be a string");
  serde_json::from_str(text).expect("tool response text must be JSON")
}

async fn load_doc_update_payloads(pool: &sqlx::PgPool, doc_id: Uuid) -> Vec<Vec<u8>> {
  sqlx::query_scalar("SELECT payload FROM doc_updates WHERE doc_id = $1 ORDER BY sequence")
    .bind(doc_id)
    .fetch_all(pool)
    .await
    .expect("doc_updates payload query must succeed")
}

async fn append_root_update(pool: &sqlx::PgPool, workspace_id: Uuid, payload: Vec<u8>) {
  sqlx::query(
    "INSERT INTO doc_updates (workspace_id, doc_id, payload, sequence)
     VALUES ($1, $1, $2,
       GREATEST(
         COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1), 0),
         COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $1), 0)
       ) + 1)",
  )
  .bind(workspace_id)
  .bind(payload)
  .execute(pool)
  .await
  .expect("root drift update must persist");
}

fn assert_canonical_yjs_block_shape(payloads: &[Vec<u8>]) {
  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");
  {
    let mut txn = doc.transact_mut();
    for payload in payloads {
      txn
        .apply_update(Update::decode_v1(payload).expect("doc_update payload must be valid Yjs update"))
        .expect("apply yjs update");
    }
  }

  let txn = doc.transact();
  let mut block_count = 0;
  for (key, value) in blocks_map.iter(&txn) {
    block_count += 1;
    let block = match value {
      yrs::Out::YMap(block) => block,
      other => panic!("block {key:?} must be a YMap, got {other:?}"),
    };

    match block.get(&txn, "sys:id") {
      Some(yrs::Out::Any(yrs::Any::String(id))) => {
        assert_eq!(id.to_string(), key.to_string(), "sys:id must match block map key");
      }
      other => panic!("block {key:?} is missing canonical sys:id: {other:?}"),
    }
    assert!(
      matches!(block.get(&txn, "sys:flavour"), Some(yrs::Out::Any(yrs::Any::String(_)))),
      "block {key:?} is missing canonical sys:flavour"
    );
    assert!(
      matches!(block.get(&txn, "sys:children"), Some(yrs::Out::YArray(_))),
      "block {key:?} is missing canonical sys:children"
    );
    assert!(
      block.get(&txn, "flavour").is_none(),
      "block {key:?} must not persist legacy flavour"
    );
    assert!(
      block.get(&txn, "children").is_none(),
      "block {key:?} must not persist legacy children"
    );
  }

  assert!(
    block_count >= 3,
    "markdown create_page must persist page, note and content blocks"
  );
}

/// Build the same kind of incremental Yjs update submitted by a connected
/// rich client: start from the server state, append one canonical paragraph,
/// and encode only the local diff.
fn rich_client_append_paragraph_update(state: &[u8], value: &str) -> Vec<u8> {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  doc
    .transact_mut()
    .apply_update(Update::decode_v1(state).expect("canonical state must decode"))
    .expect("canonical state must apply");
  let before = doc.transact().state_vector();

  {
    let mut txn = doc.transact_mut();
    let note_children = blocks
      .iter(&txn)
      .find_map(|(_, candidate)| {
        let yrs::Out::YMap(block) = candidate else {
          return None;
        };
        let is_note = matches!(
          block.get(&txn, "sys:flavour"),
          Some(yrs::Out::Any(yrs::Any::String(flavour))) if flavour.as_ref() == "myoxus:note"
        );
        if !is_note {
          return None;
        }
        match block.get(&txn, "sys:children") {
          Some(yrs::Out::YArray(children)) => Some(children),
          _ => None,
        }
      })
      .expect("canonical document must contain a note content root");
    let block_id = format!("web-block-{}", Uuid::new_v4().simple());
    let paragraph = blocks.insert(&mut txn, block_id.as_str(), yrs::MapPrelim::default());
    paragraph.insert(&mut txn, "sys:id", block_id.as_str());
    paragraph.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
    paragraph.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
    paragraph.insert(&mut txn, "prop:text", yrs::TextPrelim::new(value));
    note_children.push_back(&mut txn, block_id.as_str());
  }

  doc.transact().encode_diff_v1(&before)
}

#[derive(Default)]
struct RecordingBroadcastPublisher {
  failures_remaining: AtomicUsize,
  deliveries: Mutex<Vec<(Uuid, String, Vec<u8>, Uuid)>>,
  outcomes: Mutex<Vec<&'static str>>,
}

#[async_trait::async_trait]
impl WorkspaceDocumentBroadcastPublisher for RecordingBroadcastPublisher {
  async fn publish(&self, workspace_id: Uuid, document_key: &str, update: &[u8], editor: Uuid) -> Result<(), String> {
    if self
      .failures_remaining
      .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| remaining.checked_sub(1))
      .is_ok()
    {
      return Err("injected transport failure".to_string());
    }
    self.deliveries.lock().expect("recording publisher lock").push((
      workspace_id,
      document_key.to_string(),
      update.to_vec(),
      editor,
    ));
    Ok(())
  }

  fn record_outcome(&self, outcome: &'static str) {
    self.outcomes.lock().expect("recording outcome lock").push(outcome);
  }
}

#[derive(Default)]
struct BlockingBroadcastPublisher {
  calls: AtomicUsize,
  entered: Notify,
  release: Notify,
}

#[async_trait::async_trait]
impl WorkspaceDocumentBroadcastPublisher for BlockingBroadcastPublisher {
  async fn publish(
    &self,
    _workspace_id: Uuid,
    _document_key: &str,
    _update: &[u8],
    _editor: Uuid,
  ) -> Result<(), String> {
    if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
      self.entered.notify_one();
      self.release.notified().await;
    }
    Ok(())
  }
}

// ─── MCP-RV-07c-01: create_page with valid markdown succeeds ─────────────────

#[tokio::test]
async fn inv_mcp_rv07c_create_page_with_markdown_succeeds() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-ok").await;
  let workspace = create_workspace(&pool, user).await;

  let state = build_tool_state(&pool);
  let auth = auth_context(user);

  let result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "title": "Test Page With Content",
        "content_markdown": "# Hello\n\nThis is a test page.",
    }),
    &auth,
    &state,
  )
  .await;

  assert!(
    result.is_ok(),
    "create_page with valid markdown must succeed: {:?}",
    result.err()
  );
  let val = result.expect("create_page must return a value");
  let text = val["content"][0]["text"].as_str().expect("text field");
  let parsed: serde_json::Value = serde_json::from_str(text).expect("parse inner JSON");
  assert!(parsed["externalId"].is_string(), "response must contain externalId");
  assert_eq!(
    parsed["title"].as_str().expect("title must be a string"),
    "Test Page With Content"
  );

  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_page_lifecycle_commits_one_ordered_broadcast_event_per_operation() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-page-lifecycle").await;
  let workspace = create_workspace(&pool, user).await;
  let mut state = build_tool_state(&pool);
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
  let auth = auth_context(user);
  persist_auth_key(&pool, &auth).await;
  sqlx::query("UPDATE outbox_events SET processed_at = now() WHERE processed_at IS NULL")
    .execute(&pool)
    .await
    .expect("isolate lifecycle outbox events");

  let create_params = json!({
    "workspace_id": workspace,
    "title": "Lifecycle title",
    "fragment": {
      "schemaVersion": "myoxus.document-fragment.v1",
      "blocks": [{ "kind": "paragraph", "spans": [{ "text": "Initial content" }] }]
    },
    "idempotency_key": "create-lifecycle-once"
  });
  let created = dispatch_tool("create_page", &create_params, &auth, &state)
    .await
    .expect("create lifecycle page");
  let create_replay = dispatch_tool("create_page", &create_params, &auth, &state)
    .await
    .expect("create lifecycle replay");
  assert_eq!(create_replay, created);
  let created_payload = parse_tool_text_json(&created);
  let doc_id = parse_created_doc_id(&created);
  assert!(created_payload["leaf_sequence"].is_i64());
  assert!(created_payload["root_sequence"].is_i64());

  let create_event: Value = sqlx::query_scalar(
    "SELECT payload FROM outbox_events
     WHERE aggregate_id = $1 AND event_type = 'workspace_doc_broadcast' AND processed_at IS NULL",
  )
  .bind(doc_id.to_string())
  .fetch_one(&pool)
  .await
  .expect("load create lifecycle event");
  assert_eq!(create_event["lifecycleOperation"], "create");
  assert_eq!(create_event["updates"].as_array().map(Vec::len), Some(2));
  assert_eq!(create_event["updates"][0]["docId"], doc_id.to_string());
  assert_eq!(create_event["updates"][1]["docId"], workspace.to_string());
  let client_document_key = created_payload["externalId"].as_str().expect("created external key");

  let renamed = dispatch_tool(
    "doc_patch",
    &json!({
      "workspace_id": workspace,
      "external_id": client_document_key,
      "operation": "update_title",
      "title": "Renamed lifecycle title",
      "idempotency_key": "rename-lifecycle-once"
    }),
    &auth,
    &state,
  )
  .await
  .expect("rename lifecycle page");
  let renamed_payload = parse_tool_text_json(&renamed);
  assert_eq!(renamed_payload["operation"], "update_title");
  assert!(renamed_payload["leafSequence"].is_i64());
  assert!(renamed_payload["rootSequence"].is_i64());

  let trash_params = json!({
    "workspace_id": workspace,
    "external_id": client_document_key,
    "idempotency_key": "trash-lifecycle-once"
  });
  let trashed = dispatch_tool("delete_page", &trash_params, &auth, &state)
    .await
    .expect("trash lifecycle page");
  assert_eq!(
    dispatch_tool("delete_page", &trash_params, &auth, &state)
      .await
      .expect("trash lifecycle replay"),
    trashed
  );
  assert!(parse_tool_text_json(&trashed)["root_sequence"].is_i64());
  let restore_params = json!({
    "workspace_id": workspace,
    "external_id": client_document_key,
    "idempotency_key": "restore-lifecycle-once"
  });
  let restored = dispatch_tool("restore_page", &restore_params, &auth, &state)
    .await
    .expect("restore lifecycle page");
  assert_eq!(
    dispatch_tool("restore_page", &restore_params, &auth, &state)
      .await
      .expect("restore lifecycle replay"),
    restored
  );
  assert!(parse_tool_text_json(&restored)["root_sequence"].is_i64());

  let events: Vec<(String, Value)> = sqlx::query_as(
    "SELECT payload->>'lifecycleOperation', payload
     FROM outbox_events
     WHERE aggregate_id = $1 AND event_type = 'workspace_doc_broadcast'
     ORDER BY created_at, id",
  )
  .bind(doc_id.to_string())
  .fetch_all(&pool)
  .await
  .expect("load all lifecycle events");
  assert_eq!(events.len(), 4, "each lifecycle commit needs exactly one event");
  assert_eq!(
    events.iter().map(|event| event.0.as_str()).collect::<Vec<_>>(),
    ["create", "rename", "trash", "restore"]
  );
  assert_eq!(events[1].1["updates"].as_array().map(Vec::len), Some(2));
  assert_eq!(events[2].1["updates"].as_array().map(Vec::len), Some(1));
  assert_eq!(events[3].1["updates"].as_array().map(Vec::len), Some(1));
  let metadata = state
    .doc_service
    .get_metadata(doc_id)
    .await
    .expect("load restored metadata")
    .expect("restored metadata exists");
  assert_eq!(metadata.title, "Renamed lifecycle title");
  assert!(metadata.deleted_at.is_none());

  // Change the lookup key only after lifecycle writes: changing SQL alone
  // deliberately leaves the root projection unchanged. The pending create
  // event must still resolve the current external key when it is delivered.
  let client_document_key = format!("client-key-{}", Uuid::new_v4().simple());
  sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
    .bind(doc_id)
    .bind(&client_document_key)
    .execute(&pool)
    .await
    .expect("set non-UUID client document key");

  let publisher = RecordingBroadcastPublisher::default();
  assert!(
    process_next_workspace_doc_broadcast(&pool, &publisher)
      .await
      .expect("publish create lifecycle event")
  );
  let deliveries = publisher.deliveries.lock().expect("create deliveries");
  assert_eq!(deliveries.len(), 2, "one event must fan out leaf then root");
  assert_eq!(deliveries[0].1, client_document_key);
  assert_eq!(deliveries[1].1, workspace.to_string());
  drop(deliveries);

  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_page_lifecycle_outbox_claim_is_single_worker() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-page-lifecycle-claim").await;
  let workspace = create_workspace(&pool, user).await;
  let state = build_tool_state(&pool);
  let auth = auth_context(user);
  sqlx::query("UPDATE outbox_events SET processed_at = now() WHERE processed_at IS NULL")
    .execute(&pool)
    .await
    .expect("isolate claim event");
  dispatch_tool(
    "create_page",
    &json!({ "workspace_id": workspace, "title": "Single claim" }),
    &auth,
    &state,
  )
  .await
  .expect("create pending lifecycle event");

  let blocking = Arc::new(BlockingBroadcastPublisher::default());
  let first_pool = pool.clone();
  let first_publisher = blocking.clone();
  let first =
    tokio::spawn(async move { process_next_workspace_doc_broadcast(&first_pool, first_publisher.as_ref()).await });
  blocking.entered.notified().await;

  let competing = RecordingBroadcastPublisher::default();
  assert!(
    !process_next_workspace_doc_broadcast(&pool, &competing)
      .await
      .expect("competing worker must complete without claiming the locked row"),
    "FOR UPDATE SKIP LOCKED must keep the lifecycle event single-claimed"
  );
  blocking.release.notify_one();
  assert!(
    first.await.expect("first worker task").expect("first worker claim"),
    "the original worker must complete its claim"
  );
  assert_eq!(blocking.calls.load(Ordering::SeqCst), 2, "leaf and root publish once");
  assert!(competing.deliveries.lock().expect("competing deliveries").is_empty());

  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_create_page_write_emits_audit_and_metrics_without_payload_leak() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-obsv").await;
  let workspace = create_workspace(&pool, user).await;

  let (state, metrics_service) = observed_tool_state(&pool);
  let auth = auth_context(user);
  let key_id = auth.key_id;
  let content = "# Sensitive test heading\n\nThis body must not be stored in audit metadata.";

  let result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "title": "Observable MCP Page",
        "content_markdown": content,
    }),
    &auth,
    &state,
  )
  .await
  .expect("create_page with observability must succeed");
  let created_doc_id = parse_created_doc_id(&result);

  let row = sqlx::query(
    "SELECT event_key, category, actor_user_id, actor_kind, credential_type, credential_id, \
            target_type, target_id, metadata \
       FROM admin_audit_log \
      WHERE event_key = 'mcp.doc.create' AND credential_id = $1 \
      ORDER BY created_at DESC LIMIT 1",
  )
  .bind(key_id.to_string())
  .fetch_optional(&pool)
  .await
  .expect("MCP create audit row must be queryable")
  .expect("MCP create_page must emit an audit row");

  assert_eq!(row.get::<String, _>("category"), "mcp");
  assert_eq!(row.get::<Option<Uuid>, _>("actor_user_id"), Some(user));
  assert_eq!(row.get::<String, _>("actor_kind"), "api_key");
  assert_eq!(
    row.get::<Option<String>, _>("credential_type").as_deref(),
    Some("mcp_api_key")
  );
  assert_eq!(
    row.get::<Option<String>, _>("credential_id").as_deref(),
    Some(key_id.to_string().as_str())
  );
  assert_eq!(row.get::<String, _>("target_type"), "document");
  assert_eq!(row.get::<String, _>("target_id"), created_doc_id.to_string());

  let metadata = row.get::<Option<serde_json::Value>, _>("metadata").expect("metadata");
  assert_eq!(
    metadata.get("tool_name").and_then(serde_json::Value::as_str),
    Some("create_page")
  );
  assert_eq!(
    metadata.get("outcome").and_then(serde_json::Value::as_str),
    Some("success")
  );
  assert_eq!(
    metadata.get("workspace_id").and_then(serde_json::Value::as_str),
    Some(workspace.to_string().as_str())
  );
  assert!(
    !metadata.to_string().contains(content),
    "MCP audit metadata must not persist document content"
  );

  let prometheus = metrics_service.render_prometheus();
  assert!(
    prometheus.contains("myoxus_metric_mcp_tool_call"),
    "MCP tool call counter must be exported: {prometheus}"
  );
  assert!(
    prometheus.contains("myoxus_metric_mcp_write"),
    "MCP write counter must be exported: {prometheus}"
  );
  assert!(
    prometheus.contains("myoxus_metric_mcp_page_lifecycle_tool_total"),
    "MCP lifecycle counter must be exported: {prometheus}"
  );

  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_page_projection_tools_are_bounded_external_scoped_and_audit_only_real_mutation() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-page-repair").await;
  let (non_member, _) = helpers::seed_user(&pool, &auth_store, "mcp-page-repair-denied").await;
  let workspace = create_workspace(&pool, user).await;
  let (mut state, _) = observed_tool_state(&pool);
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
  let auth = auth_context(user);
  persist_auth_key(&pool, &auth).await;

  let created = dispatch_tool(
    "create_page",
    &json!({ "workspace_id": workspace, "title": "Repair target" }),
    &auth,
    &state,
  )
  .await
  .expect("create repair fixture");
  let doc_id = parse_created_doc_id(&created);
  let initial_leaf = state.doc_service.load_full_doc(workspace, doc_id).await.unwrap();
  let empty_title = yjs::update_document_title(&initial_leaf, "").unwrap();
  state
    .doc_service
    .push_update_raw(workspace, doc_id, empty_title, DocSpaceKind::Workspace)
    .await
    .unwrap();
  sqlx::query("UPDATE docs SET title='' WHERE id=$1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .unwrap();
  let leaf_before = state.doc_service.load_full_doc(workspace, doc_id).await.unwrap();
  let root_state = state.doc_service.load_full_doc(workspace, workspace).await.unwrap();
  let removal = yjs::remove_pages_from_root_doc(&root_state, &[doc_id.to_string()]).unwrap();
  append_root_update(&pool, workspace, removal.update).await;

  let audit_rows_before: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
  let scan = dispatch_tool(
    "page_projection_scan",
    &json!({ "workspace_id": workspace, "limit": 1 }),
    &auth,
    &state,
  )
  .await
  .expect("read-only bounded projection scan");
  let scan = parse_tool_text_json(&scan);
  assert!(scan["items"].as_array().is_some_and(|items| items.len() <= 1));
  assert_eq!(scan["completeness"], "incomplete");
  assert_eq!(scan["healthy"], false);
  assert!(scan["nextCursor"].is_string());

  let inspection = dispatch_tool(
    "page_projection_inspect",
    &json!({ "workspace_id": workspace, "external_doc_id": doc_id.to_string() }),
    &auth,
    &state,
  )
  .await
  .expect("read-only exact projection inspection");
  let inspection = parse_tool_text_json(&inspection);
  assert_eq!(inspection["externalDocId"], doc_id.to_string());
  assert_eq!(inspection["normalizedTitle"], "");
  assert!(inspection["findings"].as_array().unwrap().iter().any(|finding| {
    finding["externalDocId"] == doc_id.to_string() && finding["driftClass"] == "missing_root_entry"
  }));
  assert!(
    !inspection.to_string().contains("content"),
    "inspection must not expose page content"
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM admin_audit_log WHERE actor_user_id = $1")
      .bind(user)
      .fetch_one(&pool)
      .await
      .unwrap(),
    audit_rows_before,
    "read-only scan and inspection must not emit mutation audit rows"
  );

  let denied = dispatch_tool(
    "page_projection_inspect",
    &json!({ "workspace_id": workspace, "external_doc_id": doc_id.to_string() }),
    &auth_context(non_member),
    &state,
  )
  .await
  .expect_err("a non-member must not inspect projection state");
  assert_eq!(denied.0, -32003);

  let fingerprint = inspection["fingerprint"].as_str().unwrap();
  let missing_idempotency = dispatch_tool(
    "page_projection_repair",
    &json!({
      "workspace_id": workspace,
      "external_doc_id": doc_id.to_string(),
      "fingerprint": fingerprint,
      "mode": "apply"
    }),
    &auth,
    &state,
  )
  .await
  .expect_err("repair apply requires idempotency");
  assert_eq!(missing_idempotency.0, -32602);

  let preview = dispatch_tool(
    "page_projection_repair",
    &json!({
      "workspace_id": workspace,
      "external_doc_id": doc_id.to_string(),
      "fingerprint": fingerprint,
      "idempotency_key": "page-repair-preview"
    }),
    &auth,
    &state,
  )
  .await
  .expect("repair preview");
  assert_eq!(parse_tool_text_json(&preview)["changed"], false);
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM admin_audit_log WHERE actor_user_id = $1")
      .bind(user)
      .fetch_one(&pool)
      .await
      .unwrap(),
    audit_rows_before,
    "dry-run must not emit a mutation audit row"
  );

  let applied = dispatch_tool(
    "page_projection_repair",
    &json!({
      "workspace_id": workspace,
      "external_doc_id": doc_id.to_string(),
      "fingerprint": fingerprint,
      "mode": "apply",
      "idempotency_key": "page-repair-apply"
    }),
    &auth,
    &state,
  )
  .await
  .expect("apply exact repair");
  assert_eq!(parse_tool_text_json(&applied)["changed"], true);
  assert_eq!(
    state.doc_service.load_full_doc(workspace, doc_id).await.unwrap(),
    leaf_before
  );
  let audit_rows_after_apply: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(audit_rows_after_apply, audit_rows_before + 1);

  let repeated = dispatch_tool(
    "page_projection_repair",
    &json!({
      "workspace_id": workspace,
      "external_doc_id": doc_id.to_string(),
      "fingerprint": fingerprint,
      "mode": "apply",
      "idempotency_key": "page-repair-second-apply"
    }),
    &auth,
    &state,
  )
  .await
  .expect("second exact apply must be a no-op");
  assert_eq!(parse_tool_text_json(&repeated)["changed"], false);
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM admin_audit_log WHERE actor_user_id = $1")
      .bind(user)
      .fetch_one(&pool)
      .await
      .unwrap(),
    audit_rows_after_apply,
    "idempotent no-op must not emit another mutation audit row"
  );

  for retired in ["page_lifecycle_audit", "page_lifecycle_repair"] {
    let error = dispatch_tool(retired, &json!({ "workspace_id": workspace }), &auth, &state)
      .await
      .expect_err("retired tool names must stay unknown");
    assert_eq!(error.0, -32601);
  }

  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = ANY($1)")
    .bind(&[user, non_member])
    .execute(&pool)
    .await
    .expect("repair audit cleanup must succeed");
  helpers::cleanup_users(&pool, &[user, non_member]).await;
}

#[tokio::test]
async fn inv_mcp_metrics_category_disabled_drops_mcp_series() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-metoff").await;
  let workspace = create_workspace(&pool, user).await;

  let (state, metrics_service) = observed_tool_state_with_mcp_metrics(&pool, false);
  let auth = auth_context(user);

  dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "title": "Metrics Off MCP Page",
    }),
    &auth,
    &state,
  )
  .await
  .expect("create_page should still succeed when MCP metrics are disabled");

  let prometheus = metrics_service.render_prometheus();
  assert!(
    !prometheus.contains("myoxus_metric_mcp_"),
    "disabled MCP metrics category must fail closed: {prometheus}"
  );
  assert!(
    prometheus.contains("myoxus_metrics_rejected_disabled_total"),
    "recorder should expose disabled-category rejections"
  );

  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user]).await;
}

// ─── MCP-RV-07c-02: create_page without title returns error ──────────────────

#[tokio::test]
async fn inv_mcp_rv07c_create_page_missing_title_rejected() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-nt").await;
  let workspace = create_workspace(&pool, user).await;

  let state = build_tool_state(&pool);
  let auth = auth_context(user);

  let result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
    }),
    &auth,
    &state,
  )
  .await;

  assert!(result.is_err(), "create_page without title must return error");
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32602, "expected invalid-params error, got {code}: {msg}");
  assert!(msg.contains("title"), "error should mention title: {msg}");

  helpers::cleanup_users(&pool, &[user]).await;
}

// ─── MCP-RV-07c-03: create_page with empty title returns error ───────────────

#[tokio::test]
async fn inv_mcp_rv07c_create_page_empty_title_rejected() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-et").await;
  let workspace = create_workspace(&pool, user).await;

  let state = build_tool_state(&pool);
  let auth = auth_context(user);

  let result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "title": "",
    }),
    &auth,
    &state,
  )
  .await;

  assert!(result.is_err(), "create_page with empty title must return error");
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32602, "expected invalid-params error, got {code}: {msg}");
  assert!(msg.contains("title"), "error should mention title: {msg}");

  helpers::cleanup_users(&pool, &[user]).await;
}

// ─── MCP-RV-07c-04: create_page title-only (no content) succeeds ─────────────

#[tokio::test]
async fn inv_mcp_rv07c_create_page_title_only_succeeds() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-to").await;
  let workspace = create_workspace(&pool, user).await;

  let state = build_tool_state(&pool);
  let auth = auth_context(user);

  let result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "title": "Title Only Page",
    }),
    &auth,
    &state,
  )
  .await;

  assert!(
    result.is_ok(),
    "create_page with title only must succeed: {:?}",
    result.err()
  );
  let val = result.expect("create_page must return a value");
  let text = val["content"][0]["text"].as_str().expect("text field");
  let parsed: serde_json::Value = serde_json::from_str(text).expect("parse inner JSON");
  assert!(parsed["externalId"].is_string(), "response must contain externalId");
  assert_eq!(
    parsed["title"].as_str().expect("title must be a string"),
    "Title Only Page"
  );

  helpers::cleanup_users(&pool, &[user]).await;
}

// ─── MCP-RV-07c-05: create_page with non-string title returns error ──────────

#[tokio::test]
async fn inv_mcp_rv07c_create_page_non_string_title_rejected() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-ns").await;
  let workspace = create_workspace(&pool, user).await;

  let state = build_tool_state(&pool);
  let auth = auth_context(user);

  let result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "title": 42,
    }),
    &auth,
    &state,
  )
  .await;

  assert!(result.is_err(), "create_page with non-string title must return error");
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32602, "expected invalid-params error, got {code}: {msg}");
  assert!(msg.contains("title"), "error should mention title: {msg}");

  helpers::cleanup_users(&pool, &[user]).await;
}

// ─── MCP-RV-07c-06: create_page doc is readable after creation ───────────────

#[tokio::test]
async fn inv_mcp_rv07c_create_page_doc_readable_after_creation() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-rd").await;
  let workspace = create_workspace(&pool, user).await;

  let state = build_tool_state(&pool);
  let auth = auth_context(user);

  // Create page with content
  let create_result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "title": "Readable Page",
        "content_markdown": "# Heading\n\nSome body text.",
    }),
    &auth,
    &state,
  )
  .await;

  assert!(create_result.is_ok(), "create must succeed: {:?}", create_result.err());
  let create_text = create_result.expect("create_result must have a value")["content"][0]["text"]
    .as_str()
    .expect("create response text must be a string")
    .to_string();
  let create_parsed: serde_json::Value =
    serde_json::from_str(&create_text).expect("create response must be valid JSON");
  let doc_id = create_parsed["externalId"].as_str().expect("externalId");

  // Read it back via read_doc
  let read_result = dispatch_tool(
    "read_doc",
    &json!({
        "workspace_id": workspace.to_string(),
        "external_id": doc_id,
    }),
    &auth,
    &state,
  )
  .await;

  assert!(
    read_result.is_ok(),
    "read_doc must succeed for newly created page: {:?}",
    read_result.err()
  );

  helpers::cleanup_users(&pool, &[user]).await;
}

// ─── MCP-RV-07c-07: create_page with invalid workspace_id returns error ──────

#[tokio::test]
async fn inv_mcp_rv07c_create_page_invalid_workspace_id_rejected() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-iw").await;

  let state = build_tool_state(&pool);
  let auth = auth_context(user);

  let result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": "not-a-uuid",
        "title": "Should Fail",
    }),
    &auth,
    &state,
  )
  .await;

  assert!(result.is_err(), "create_page with invalid workspace_id must fail");
  let (code, msg) = result.unwrap_err();
  assert_eq!(code, -32602, "expected invalid-params error, got {code}: {msg}");

  helpers::cleanup_users(&pool, &[user]).await;
}

// ─── MCP-RV-07c-08: create_page for non-member workspace returns error, no partial data ─

#[tokio::test]
async fn inv_mcp_rv07c_create_page_nonmember_workspace_no_partial_data() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (owner, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-own").await;
  let (outsider, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-out").await;
  let workspace = create_workspace(&pool, owner).await;

  let state = build_tool_state(&pool);
  let auth = auth_context(outsider);

  let result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "title": "Should Not Exist",
        "content_markdown": "# Ghost page",
    }),
    &auth,
    &state,
  )
  .await;

  assert!(result.is_err(), "non-member must be rejected");
  let (code, _) = result.unwrap_err();
  assert_eq!(code, -32003, "expected permission-denied error");

  // Verify no doc was created in the workspace
  let doc_count: i64 =
    sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1 AND title = 'Should Not Exist'")
      .bind(workspace)
      .fetch_one(&pool)
      .await
      .expect("doc count query must succeed");
  assert_eq!(doc_count, 0, "no partial doc must exist after permission denial");

  helpers::cleanup_users(&pool, &[owner, outsider]).await;
}

// ─── MCP-RV-07c-09: create_page with extreme unicode content does not panic ──

#[tokio::test]
async fn inv_mcp_rv07c_create_page_extreme_unicode_no_panic() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-uc").await;
  let workspace = create_workspace(&pool, user).await;

  let state = build_tool_state(&pool);
  let auth = auth_context(user);

  // Build content with multi-byte chars, emoji, RTL, CJK, zero-width joiners
  let content = "# \u{1F600} Emoji Title\n\n\u{0627}\u{0644}\u{0639}\u{0631}\u{0628}\u{064A}\u{0629} RTL text\n\n\u{4F60}\u{597D}\u{4E16}\u{754C}\n\nZero-width: a\u{200D}b\u{200B}c";

  let result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "title": "\u{1F680} Rocket Page \u{2603}",
        "content_markdown": content,
    }),
    &auth,
    &state,
  )
  .await;

  assert!(
    result.is_ok(),
    "create_page must handle extreme unicode: {:?}",
    result.err()
  );

  helpers::cleanup_users(&pool, &[user]).await;
}

// ─── MCP-RV-07c-10: create_page content round-trip preserves text ─────────────

#[tokio::test]
async fn inv_mcp_compat_targeted_patch_wire_preserves_native_neighbors_and_rejects_unrelated_payloads() {
  use futures_util::FutureExt;
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user, session) = helpers::seed_user(&pool, &auth_store, "mcp-targeted-patch").await;
  let workspace = create_workspace(&pool, user).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    let token = document_read_key(&app, session, &["read:workspaces", "read:docs", "write:docs"]).await;
    let state = build_tool_state(&pool);
    let app = document_read_router(&pool, state.clone());
    let created = document_read_call(
      &app,
      &token,
      "create_page",
      json!({
        "workspace_id": workspace, "title": "Targeted edits", "content_markdown": "First\n\nSecond\n\nThird"
      }),
    )
    .await;
    let external = created["externalId"].as_str().unwrap();
    let read_args = json!({"workspace_id": workspace, "external_id": external});
    let original = document_read_call(&app, &token, "read_doc", read_args.clone()).await;
    let ids: Vec<_> = reading_blocks(&original)
      .map(|block| block["blockId"].as_str().unwrap().to_string())
      .collect();
    let operations = [
      json!({"operation": "edit_text", "block_id": ids[1], "start": 0, "end": 6, "replacement": "Changed"}),
      json!({"operation": "move_block", "block_id": ids[2], "after_block_id": ids[0]}),
      json!({"operation": "update_block_properties", "block_id": ids[1], "properties": {"headingLevel": 2}}),
      json!({"operation": "delete_block", "block_id": ids[2]}),
    ];
    for (index, operation) in operations.into_iter().enumerate() {
      let mut args = read_args.clone();
      args
        .as_object_mut()
        .unwrap()
        .extend(operation.as_object().unwrap().clone());
      args["idempotency_key"] = json!(format!("targeted-{index}"));
      document_read_call(&app, &token, "doc_patch", args).await;
      let read = document_read_call(&app, &token, "read_doc", read_args.clone()).await;
      assert_eq!((*reading_block(&read, 0)), (*reading_block(&original, 0)));
      assert_eq!(
        read["document"]["blocks"][0], original["document"]["blocks"][0],
        "preserve the native empty starter too"
      );
      let blocks = reading_blocks(&read).cloned().collect::<Vec<_>>();
      let order: Vec<_> = blocks.iter().map(|block| block["blockId"].as_str().unwrap()).collect();
      let expected = match index {
        0 => vec![ids[0].as_str(), &ids[1], &ids[2]],
        1 | 2 => vec![ids[0].as_str(), &ids[2], &ids[1]],
        _ => vec![ids[0].as_str(), &ids[1]],
      };
      assert_eq!(order, expected);
      let edited = blocks.iter().find(|block| block["blockId"] == ids[1]).unwrap();
      assert_eq!(edited["text"][0]["text"], "Changed");
      if index >= 2 {
        assert_eq!(edited["kind"], "heading");
        assert_eq!(edited["level"], 2);
      }
    }
    let doc_id: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2")
      .bind(workspace)
      .bind(external)
      .fetch_one(&pool)
      .await
      .unwrap();
    let before = state.doc_service.load_full_doc(workspace, doc_id).await.unwrap();
    let updates_before: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id=$1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
    for (index, invalid) in [
      json!({"operation":"delete_block","block_id":ids[0],"content_markdown":"No write"}),
      json!({"operation":"move_block","block_id":ids[0],"after_block_id":42}),
      json!({"operation":"edit_text","block_id":ids[0],"start":0,"end":1,"replacement":"X","title":"Ignored"}),
      json!({"operation":"update_block_properties","block_id":ids[0],"properties":{"headingLevel":null}}),
      json!({"operation":"append","fragment":{"blocks":[]},"content_markdown":"No write"}),
      json!({"operation":"delete_block","block_id":ids[0],"heading":"Ignored"}),
    ]
    .into_iter()
    .enumerate()
    {
      let mut args = read_args.clone();
      args
        .as_object_mut()
        .unwrap()
        .extend(invalid.as_object().unwrap().clone());
      args["idempotency_key"] = json!(format!("invalid-{index}"));
      let result = document_read_rpc(&app, &token, "tools/call", json!({"name":"doc_patch","arguments":args})).await;
      assert!(result.get("error").is_some() || result["result"]["isError"] == true);
    }
    assert_eq!(
      state.doc_service.load_full_doc(workspace, doc_id).await.unwrap(),
      before
    );
    let updates_after: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id=$1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(updates_after, updates_before);
    let native = Doc::new();
    native
      .transact_mut()
      .apply_update(Update::decode_v1(&before).unwrap())
      .unwrap();
    let txn = native.transact();
    let blocks = txn.get_map("blocks").unwrap();
    assert!(blocks.get(&txn, &ids[2]).is_none());
    for id in &ids[..2] {
      let parents = blocks
        .iter(&txn)
        .filter(|(_, block)| {
          let yrs::Out::YMap(block) = block else {
            return false;
          };
          let Some(yrs::Out::YArray(children)) = block.get(&txn, "sys:children") else {
            return false;
          };
          children.iter(&txn).any(|child| child.to_string(&txn) == *id)
        })
        .count();
      assert_eq!(parents, 1, "edited content keeps exactly one parent");
    }
  })
  .catch_unwind()
  .await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[user]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_compat_read_revision_keeps_snapshot_tail_and_concurrent_compaction_in_one_state() {
  use futures_util::FutureExt;
  use myoxus_application::doc::{DocSnapshotStore, DocumentMutation, document_fragment_from_markdown};
  use std::time::Duration;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (user, session) = helpers::seed_user(&pool, &auth_store, "mcp-read-revision").await;
  let workspace = create_workspace(&pool, user).await;
  let reader_name = format!("mcp-revision-{}", Uuid::new_v4());
  let reader_pool = sqlx::postgres::PgPoolOptions::new()
    .max_connections(4)
    .connect_with(pool.connect_options().as_ref().clone().application_name(&reader_name))
    .await
    .unwrap();
  let outcome = std::panic::AssertUnwindSafe(async {
    let token = document_read_key(&key_app, session, &["read:docs", "write:docs"]).await;
    let state = build_tool_state(&pool);
    let app = document_read_router(&reader_pool, build_tool_state(&reader_pool));
    let created = state.doc_service.create_page_lifecycle(workspace, user, Some("Revision fixture".to_string()), Some(document_fragment_from_markdown("Base").unwrap())).await.unwrap();
    let doc_id = created.document.id;
    let external = created.document.external_id.clone();
    let initial = state.doc_service.load.load_full_doc_with_revision(workspace, doc_id).await.unwrap();
    let store = SqlxDocStore::new(pool.clone());
    store.save_snapshot(doc_id, workspace, initial.payload, initial.revision).await.unwrap();
    let tail = state.doc_service.mutate_content(workspace, doc_id, Some(user), DocumentMutation::AppendBlocks { fragment: document_fragment_from_markdown("Old tail").unwrap() }, false, Some(initial.revision)).await.unwrap();
    let old = state.doc_service.load.load_full_doc_with_revision(workspace, doc_id).await.unwrap();
    assert_eq!(old.revision, tail.sequence);
    let history_before: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_histories WHERE doc_id=$1").bind(doc_id).fetch_one(&pool).await.unwrap();
    let mut compaction = pool.begin().await.unwrap();
    // Freeze the reader after its snapshot query, then commit compaction and a
    // newer tail. A separate head lookup would mislabel the old wire content.
    sqlx::query("LOCK TABLE doc_updates IN ACCESS EXCLUSIVE MODE").execute(&mut *compaction).await.unwrap();
    let read_args = json!({"workspace_id":workspace,"external_id":external,"limit":2});
    let reading = {
      let app = app.clone(); let token = token.clone(); let args = read_args.clone();
      tokio::spawn(async move { document_read_call(&app, &token, "read_doc", args).await })
    };
    tokio::time::timeout(Duration::from_secs(10), async {
      loop {
        let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%FROM doc_updates%')")
          .bind(&reader_name).fetch_one(&pool).await.unwrap();
        if blocked { break; }
        tokio::time::sleep(Duration::from_millis(20)).await;
      }
    }).await.expect("our reader must establish its snapshot before the newer write");
    let future = yjs::apply_document_mutation(&old.payload, &DocumentMutation::AppendBlocks { fragment: document_fragment_from_markdown("Future writer").unwrap() }).unwrap();
    sqlx::query("UPDATE doc_snapshots SET payload=$3,last_sequence=$4 WHERE workspace_id=$1 AND doc_id=$2")
      .bind(workspace).bind(doc_id).bind(&old.payload).bind(old.revision).execute(&mut *compaction).await.unwrap();
    sqlx::query("DELETE FROM doc_updates WHERE workspace_id=$1 AND doc_id=$2 AND sequence<=$3")
      .bind(workspace).bind(doc_id).bind(old.revision).execute(&mut *compaction).await.unwrap();
    sqlx::query("INSERT INTO doc_updates(workspace_id,doc_id,payload,sequence) VALUES($1,$2,$3,$4)")
      .bind(workspace).bind(doc_id).bind(future.delta).bind(old.revision+1).execute(&mut *compaction).await.unwrap();
    compaction.commit().await.unwrap();
    let read = tokio::time::timeout(Duration::from_secs(10), reading).await.unwrap().unwrap();
    assert_eq!(read["revision"], old.revision, "old content cannot carry the newer head");
    assert!(!read["document"]["blocks"].to_string().contains("Future writer"));
    assert_eq!((*reading_block(&read, 0))["text"][0]["text"], "Base");
    let cursor = read["page"]["nextCursor"].as_str().unwrap();
    let stale = document_read_rpc(&app, &token, "tools/call", json!({"name":"read_doc","arguments":{"workspace_id":workspace,"external_id":external,"cursor":cursor}})).await;
    assert_eq!(stale["result"]["isError"], true);
    assert!(stale.to_string().contains("STALE"));
    for representation in ["structured", "html", "markdown", "plain_text", "raw_yjs"] {
      let current = document_read_call(&app, &token, "read_doc", json!({"workspace_id":workspace,"external_id":external,"representation":representation})).await;
      assert_eq!(current["revision"], old.revision+1);
      if representation == "raw_yjs" {
        let bytes = base64::engine::general_purpose::STANDARD.decode(current["data"].as_str().unwrap()).unwrap();
        assert!(yjs::extract_text_from_yjs(&bytes).unwrap().markdown.contains("Future writer"));
      } else { assert!(current.to_string().contains("Future writer")); }
    }
    let current = state.doc_service.load.load_full_doc_with_revision(workspace, doc_id).await.unwrap();
    store.save_snapshot(doc_id, workspace, current.payload, current.revision).await.unwrap();
    let compacted = document_read_call(&app, &token, "read_doc", read_args).await;
    assert_eq!(compacted["revision"], old.revision+1, "compaction must not invent a content revision");
    let history_after: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_histories WHERE doc_id=$1").bind(doc_id).fetch_one(&pool).await.unwrap();
    assert_eq!(history_after, history_before, "reads never capture history");
  }).catch_unwind().await;
  reader_pool.close().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[user]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_compat_document_projection_preserves_structured_html_and_raw_yjs() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-rt").await;
  let workspace = create_workspace(&pool, user).await;

  let html_root = tempfile::tempdir().expect("external private HTML catalog");
  let shipped = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html");
  for name in myoxus_public_render::HTML_CATALOG_FILES {
    let target = html_root.path().join(name);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::copy(shipped.join(name), &target).unwrap();
  }
  let shell = html_root.path().join("private_page.html.tera");
  std::fs::write(
    &shell,
    std::fs::read_to_string(&shell)
      .unwrap()
      .replace("</body>", "<p data-private-catalog>External private shell</p></body>"),
  )
  .unwrap();
  let mut state = build_tool_state(&pool);
  state.html_catalog = Some(Arc::new(
    myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(html_root.path().to_owned()),
  ));
  let auth = auth_context(user);

  let result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "title": "Roundtrip Page",
        "content_markdown": "# Section A\n\nBody paragraph here.",
    }),
    &auth,
    &state,
  )
  .await
  .expect("create must succeed");

  let text = result["content"][0]["text"]
    .as_str()
    .expect("roundtrip response text must be a string");
  let parsed: serde_json::Value = serde_json::from_str(text).expect("roundtrip response must be valid JSON");
  let doc_id = parsed["externalId"]
    .as_str()
    .expect("roundtrip response must contain externalId string");

  // Read back and verify content survived the Yjs round-trip
  let read = dispatch_tool(
    "read_doc",
    &json!({ "workspace_id": workspace.to_string(), "external_id": doc_id }),
    &auth,
    &state,
  )
  .await
  .expect("read must succeed");

  let read_text = read["content"][0]["text"]
    .as_str()
    .expect("read_doc response text must be a string");
  let read_parsed: serde_json::Value = serde_json::from_str(read_text).expect("read_doc response must be valid JSON");
  let content = read_parsed["document"]["blocks"].to_string();
  assert!(
    content.contains("Section A"),
    "heading must survive roundtrip, got: {content}"
  );
  assert!(
    content.contains("Body paragraph here"),
    "body must survive roundtrip, got: {content}"
  );

  let html = dispatch_tool(
    "read_doc",
    &json!({
      "workspace_id": workspace,
      "external_id": doc_id,
      "representation": "html"
    }),
    &auth,
    &state,
  )
  .await
  .expect("HTML read must succeed");
  let html = parse_tool_text_json(&html);
  assert_eq!(html["format"], "html");
  assert_eq!(html["mediaType"], "text/html");
  assert_eq!(html["lossy"], false);
  let rendered = html["data"].as_str().expect("HTML export body");
  assert!(rendered.contains("Section A"));
  assert!(rendered.contains("Body paragraph here"));
  assert!(rendered.contains("data-private-catalog"));
  assert!(rendered.contains("noindex,nofollow"));
  assert!(!rendered.contains("mx-public-nav"));
  assert_eq!(
    html["rendererVersion"],
    state
      .html_catalog
      .as_ref()
      .unwrap()
      .renderer()
      .unwrap()
      .renderer_version(myoxus_application::public::PUBLIC_RENDERER_VERSION)
  );

  let raw = dispatch_tool(
    "read_doc",
    &json!({
      "workspace_id": workspace,
      "external_id": doc_id,
      "representation": "raw_yjs"
    }),
    &auth,
    &state,
  )
  .await
  .expect("raw read must succeed");
  let raw = parse_tool_text_json(&raw);
  let raw_bytes = base64::engine::general_purpose::STANDARD
    .decode(raw["data"].as_str().expect("raw Yjs base64"))
    .expect("decode raw Yjs");
  let expected = yjs::merge_updates(load_doc_update_payloads(&pool, Uuid::parse_str(doc_id).unwrap()).await)
    .expect("merge persisted snapshot tail fixture");
  assert_eq!(raw_bytes, expected, "raw_yjs must include the complete update tail");

  helpers::cleanup_users(&pool, &[user]).await;
}

// ─── MCP-RV-07c-11: create_page persists canonical Yjs block shape ───────────

#[tokio::test]
async fn inv_mcp_rv07c_create_page_persists_canonical_yjs_shape() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-cp-shape").await;
  let workspace = create_workspace(&pool, user).await;

  let state = build_tool_state(&pool);
  let auth = auth_context(user);

  let result = dispatch_tool(
    "create_page",
    &json!({
        "workspace_id": workspace.to_string(),
        "title": "Canonical Shape Page",
        "content_markdown": "# Canonical\n\n- First\n- Second\n\n```rust\nfn main() {}\n```",
    }),
    &auth,
    &state,
  )
  .await
  .expect("create_page must succeed");

  let doc_id = parse_created_doc_id(&result);
  let payloads = load_doc_update_payloads(&pool, doc_id).await;
  assert_eq!(
    payloads.len(),
    1,
    "create_page content push must persist one doc update"
  );
  assert_canonical_yjs_block_shape(&payloads);

  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_doc_patch_replace_heading_section_preserves_unrelated_content() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-patch-ok").await;
  let workspace = create_workspace(&pool, user).await;
  let (mut state, metrics_service) = observed_tool_state(&pool);
  let auth = auth_context(user);
  persist_auth_key(&pool, &auth).await;
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
  let key_id = auth.key_id;

  let created = dispatch_tool(
    "create_page",
    &json!({
      "workspace_id": workspace.to_string(),
      "title": "Patch Target",
      "content_markdown": "# Patch Target\n\nIntro\n\n## Alpha\n\nOld alpha\n\n## Beta\n\nKeep beta",
    }),
    &auth,
    &state,
  )
  .await
  .expect("create target document");
  let doc_id = parse_created_doc_id(&created);

  let patch_params = json!({
    "workspace_id": workspace.to_string(),
    "external_id": doc_id.to_string(),
    "operation": "replace_heading_section",
    "heading": "Alpha",
    "content_markdown": "New alpha",
    "idempotency_key": "replace-alpha-once",
  });
  let patched = dispatch_tool("doc_patch", &patch_params, &auth, &state)
    .await
    .expect("doc_patch must succeed");
  let patch_json = parse_tool_text_json(&patched);
  assert_eq!(patch_json["operation"], "replace_heading_section");
  assert!(patch_json["sequence"].is_i64());
  assert!(
    patch_json["insertedBlockIds"]
      .as_array()
      .is_some_and(|ids| !ids.is_empty())
  );
  let updates_after_commit: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count document updates");
  let replayed = dispatch_tool("doc_patch", &patch_params, &auth, &state)
    .await
    .expect("same idempotency key and payload must replay");
  assert_eq!(replayed, patched, "retry must return the original tool result");
  let rendered_metrics = metrics_service.render_prometheus();
  assert!(rendered_metrics.contains("myoxus_metric_mcp_write"));
  assert!(rendered_metrics.contains("outcome=\"replayed\""));
  let mut conflicting_params = patch_params.clone();
  conflicting_params["content_markdown"] = json!("Different alpha");
  let conflict = dispatch_tool("doc_patch", &conflicting_params, &auth, &state)
    .await
    .expect_err("same key with a different semantic fragment must conflict");
  assert_eq!(conflict.0, -32010);
  assert!(conflict.1.contains("MIX_MCP_IDEMPOTENCY_CONFLICT"));
  let updates_after_replay: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count document updates after replay");
  assert_eq!(
    updates_after_replay, updates_after_commit,
    "retry must not append a delta"
  );
  let broadcast_rows: i64 = sqlx::query_scalar(
    "SELECT count(*) FROM outbox_events
     WHERE aggregate_id = $1 AND event_type = 'workspace_doc_broadcast'",
  )
  .bind(doc_id.to_string())
  .fetch_one(&pool)
  .await
  .expect("count document broadcast rows");
  assert_eq!(
    broadcast_rows, updates_after_commit,
    "every committed update needs one fanout row"
  );

  let read = dispatch_tool(
    "read_doc",
    &json!({ "workspace_id": workspace.to_string(), "external_id": doc_id.to_string() }),
    &auth,
    &state,
  )
  .await
  .expect("read patched doc");
  let read_json = parse_tool_text_json(&read);
  let content = read_json["document"]["blocks"].to_string();
  assert!(content.contains("New alpha"), "patched content missing: {content}");
  assert!(
    content.contains("Keep beta"),
    "unrelated section must survive: {content}"
  );
  assert!(
    !content.contains("Old alpha"),
    "replaced section body must be gone: {content}"
  );

  let audit_row = sqlx::query(
    "SELECT event_key, category, actor_user_id, actor_kind, credential_type, credential_id, \
            target_type, target_id, metadata \
       FROM admin_audit_log \
      WHERE event_key = 'mcp.doc.patch' AND credential_id = $1 \
      ORDER BY created_at DESC LIMIT 1",
  )
  .bind(key_id.to_string())
  .fetch_optional(&pool)
  .await
  .expect("MCP patch audit row must be queryable")
  .expect("doc_patch must emit an audit row");
  assert_eq!(audit_row.get::<String, _>("category"), "mcp");
  assert_eq!(audit_row.get::<Option<Uuid>, _>("actor_user_id"), Some(user));
  assert_eq!(audit_row.get::<String, _>("actor_kind"), "api_key");
  assert_eq!(
    audit_row.get::<Option<String>, _>("credential_type").as_deref(),
    Some("mcp_api_key")
  );
  assert_eq!(
    audit_row.get::<Option<String>, _>("credential_id").as_deref(),
    Some(key_id.to_string().as_str())
  );
  assert_eq!(audit_row.get::<String, _>("target_type"), "document");
  assert_eq!(audit_row.get::<String, _>("target_id"), doc_id.to_string());
  let audit_count: i64 = sqlx::query_scalar(
    "SELECT count(*) FROM admin_audit_log
     WHERE event_key = 'mcp.doc.patch' AND credential_id = $1",
  )
  .bind(key_id.to_string())
  .fetch_one(&pool)
  .await
  .expect("count MCP patch audit rows");
  assert_eq!(audit_count, 1, "replay must not duplicate the MCP mutation audit");
  let (payload_hash, stored_response): (String, serde_json::Value) = sqlx::query_as(
    "SELECT payload_sha256, response_json FROM mcp_idempotency_keys
     WHERE api_key_id = $1 AND tool_name = 'doc_patch' AND idempotency_key = 'replace-alpha-once'",
  )
  .bind(key_id)
  .fetch_one(&pool)
  .await
  .expect("load persisted MCP replay evidence");
  assert_eq!(
    payload_hash.len(),
    64,
    "semantic payload must be retained only as SHA-256"
  );
  // MCP-DOC-06 retains the bounded result of this commit for exact replay;
  // raw request arguments remain hashed and audit metadata remains content-free.
  assert!(!payload_hash.contains("New alpha"));
  let replay_payload = parse_tool_text_json(&stored_response);
  assert_eq!(replay_payload["readback"]["status"], "complete");
  let replay_blocks = replay_payload["updatedBlocks"].to_string();
  assert!(replay_blocks.contains("New alpha"));
  assert!(!replay_blocks.contains("Old alpha"));
  assert!(
    !replay_blocks.contains("Keep beta"),
    "replay must retain only affected content"
  );
  assert!(
    replay_payload.get("fragment").is_none(),
    "raw mutation arguments are not replay metadata"
  );
  let metadata = audit_row
    .get::<Option<serde_json::Value>, _>("metadata")
    .expect("metadata");
  assert_eq!(
    metadata.get("tool_name").and_then(serde_json::Value::as_str),
    Some("doc_patch")
  );
  assert_eq!(
    metadata.get("outcome").and_then(serde_json::Value::as_str),
    Some("success")
  );
  assert!(
    !metadata.to_string().contains("New alpha") && !metadata.to_string().contains("Old alpha"),
    "MCP patch audit metadata must not persist document content"
  );

  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user)
    .execute(&pool)
    .await
    .expect("cleanup audit rows");
  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_doc_patch_missing_heading_fails_without_mutation() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));

  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-patch-miss").await;
  let workspace = create_workspace(&pool, user).await;
  let mut state = build_tool_state(&pool);
  let auth = auth_context(user);
  persist_auth_key(&pool, &auth).await;
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));

  let created = dispatch_tool(
    "create_page",
    &json!({
      "workspace_id": workspace.to_string(),
      "title": "Patch Missing",
      "content_markdown": "# Patch Missing\n\n## Present\n\nOriginal body",
    }),
    &auth,
    &state,
  )
  .await
  .expect("create target document");
  let doc_id = parse_created_doc_id(&created);

  let result = dispatch_tool(
    "doc_patch",
    &json!({
      "workspace_id": workspace.to_string(),
      "external_id": doc_id.to_string(),
      "operation": "append_to_heading",
      "heading": "Absent",
      "content_markdown": "Should not appear",
      "idempotency_key": "append-missing-heading",
    }),
    &auth,
    &state,
  )
  .await;
  let (code, message) = result.expect_err("missing heading must fail");
  assert_eq!(code, -32004, "expected not-found style error: {message}");
  let pending: i64 = sqlx::query_scalar(
    "SELECT count(*) FROM mcp_idempotency_keys
     WHERE api_key_id = $1 AND tool_name = 'doc_patch' AND idempotency_key = 'append-missing-heading'",
  )
  .bind(auth.key_id)
  .fetch_one(&pool)
  .await
  .expect("count aborted idempotency rows");
  assert_eq!(pending, 0, "failed domain mutation must remove its pending guard");

  let read = dispatch_tool(
    "read_doc",
    &json!({ "workspace_id": workspace.to_string(), "external_id": doc_id.to_string() }),
    &auth,
    &state,
  )
  .await
  .expect("read after failed patch");
  let read_json = parse_tool_text_json(&read);
  let content = read_json["document"]["blocks"].to_string();
  assert!(content.contains("Original body"), "original content missing: {content}");
  assert!(
    !content.contains("Should not appear"),
    "failed patch must not mutate content: {content}"
  );

  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_document_reference_insert_is_native_acl_bound_replay_safe_and_graph_visible() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (owner, _) = helpers::seed_user(&pool, &auth_store, "mcp-reference-owner").await;
  let (limited, _) = helpers::seed_user(&pool, &auth_store, "mcp-reference-limited").await;
  let workspace = create_workspace(&pool, owner).await;
  let mut state = build_tool_state(&pool);
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));

  let graph_service = Arc::new(DocumentGraphService::new(
    Arc::new(PgDocumentGraphRepository::new(pool.clone())),
    Arc::new(state.doc_service.clone()),
    state.permission_service.clone(),
    Arc::new(DocumentMetadataService::new(Arc::new(
      PgDocumentMetadataRepository::new(pool.clone()),
    ))),
    None,
    None,
    None,
    DocumentGraphLimits::default(),
  ));
  state
    .doc_service
    .set_document_graph_index_hook(graph_service.clone())
    .await;
  state.document_graph_service = Some(graph_service.clone());

  let owner_auth = auth_context(owner);
  persist_auth_key(&pool, &owner_auth).await;
  let source = dispatch_tool(
    "create_page",
    &json!({
      "workspace_id": workspace,
      "title": "Reference source",
      "content_markdown": "First\n\n[External](https://example.com/unchanged)\n\nLast"
    }),
    &owner_auth,
    &state,
  )
  .await
  .expect("create reference source");
  let source_id = parse_created_doc_id(&source);
  let target = state
    .doc_service
    .create_page(workspace, owner, Some("Reference target".to_string()))
    .await
    .expect("create reference target");
  let collision_occupant = state
    .doc_service
    .create_page(workspace, owner, Some("Collision occupant".to_string()))
    .await
    .expect("create UUID collision occupant");
  sqlx::query("UPDATE docs SET external_id = 'collision-occupant-key' WHERE id = $1")
    .bind(collision_occupant.id)
    .execute(&pool)
    .await
    .expect("free the UUID-shaped external key");
  sqlx::query("UPDATE docs SET external_id = 'reference-source-key' WHERE id = $1")
    .bind(source_id)
    .execute(&pool)
    .await
    .expect("set source external key");
  sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
    .bind(target.id)
    .bind(collision_occupant.id.to_string())
    .execute(&pool)
    .await
    .expect("install UUID-shaped external-key collision fixture");

  let initial = state
    .doc_service
    .load_full_doc(workspace, source_id)
    .await
    .expect("load source before reference insertion");
  let first_block_id = yjs::extract_blocks_from_yjs(&initial)
    .expect("extract source blocks")
    .blocks
    .into_iter()
    .find(|block| block.text == "First")
    .expect("first paragraph")
    .id;
  let append_params = json!({
    "workspace_id": workspace,
    "external_id": "reference-source-key",
    "target_external_id": collision_occupant.id.to_string(),
    "label": "Native target",
    "idempotency_key": "reference-append-once"
  });
  let appended = dispatch_tool("document_reference_insert", &append_params, &owner_auth, &state)
    .await
    .expect("append native reference");
  let appended_payload = parse_tool_text_json(&appended);
  assert_eq!(appended_payload["sourceExternalId"], "reference-source-key");
  assert_eq!(appended_payload["targetExternalId"], collision_occupant.id.to_string());
  assert!(appended_payload["insertedBlockId"].is_string());
  assert!(appended_payload["revision"].is_i64());
  assert_eq!(
    dispatch_tool("document_reference_insert", &append_params, &owner_auth, &state)
      .await
      .expect("replay native reference insertion"),
    appended
  );

  let after_params = json!({
    "workspace_id": workspace,
    "external_id": "reference-source-key",
    "target_external_id": collision_occupant.id.to_string(),
    "label": "Positioned target",
    "after_block_id": first_block_id,
    "idempotency_key": "reference-after-once"
  });
  dispatch_tool("document_reference_insert", &after_params, &owner_auth, &state)
    .await
    .expect("insert native reference after stable block");

  let merged = state
    .doc_service
    .load_full_doc(workspace, source_id)
    .await
    .expect("load mutated source");
  let references = yjs::extract_document_references_from_yjs(&merged).expect("extract native references");
  assert_eq!(references.occurrences.len(), 2);
  assert!(
    references
      .occurrences
      .iter()
      .all(|reference| reference.raw_target_doc_id == collision_occupant.id.to_string())
  );
  let markdown = yjs::extract_text_from_yjs(&merged)
    .expect("extract source text")
    .markdown;
  assert!(markdown.contains("https://example.com/unchanged"));

  graph_service
    .reindex_document_now(workspace, source_id)
    .await
    .expect("project native references through normal graph owner");
  let graph_auth = McpAuthContext {
    scopes: vec!["read:document_graph".to_string(), "read:docs".to_string()],
    ..owner_auth.clone()
  };
  let graph = dispatch_tool(
    "document_graph_read",
    &json!({
      "workspace_id": workspace,
      "external_id": "reference-source-key",
      "direction": "outgoing",
      "include_occurrences": true
    }),
    &graph_auth,
    &state,
  )
  .await
  .expect("read projected graph");
  let graph_payload = parse_tool_text_json(&graph);
  assert!(
    graph_payload["graph"]["edges"]
      .as_array()
      .expect("graph edges")
      .iter()
      .any(|edge| edge["targetExternalId"] == collision_occupant.id.to_string()),
    "native reference must become the normal graph edge: {graph_payload}"
  );

  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'External', 'Accepted', now())",
  )
  .bind(workspace)
  .bind(limited)
  .execute(&pool)
  .await
  .expect("add limited workspace member");
  sqlx::query("INSERT INTO doc_user_permissions (user_id, doc_id, role) VALUES ($1, $2, 'Editor')")
    .bind(limited)
    .bind(source_id)
    .execute(&pool)
    .await
    .expect("grant source-only edit permission");
  let limited_auth = auth_context(limited);
  persist_auth_key(&pool, &limited_auth).await;
  let denied = dispatch_tool(
    "document_reference_insert",
    &json!({
      "workspace_id": workspace,
      "external_id": "reference-source-key",
      "target_external_id": collision_occupant.id.to_string(),
      "label": "Denied target",
      "idempotency_key": "reference-target-denied"
    }),
    &limited_auth,
    &state,
  )
  .await
  .expect_err("source permission must not authorize unreadable target");
  assert_eq!(denied.0, -32003);

  helpers::cleanup_users(&pool, &[owner, limited]).await;
}

// Expired admission is deliberate test clock control, not a weaker production
// lease. It lets a real SQL writer hold the row beyond that lease without sleep.
struct ExpireFirstDocumentAdmission {
  pool: sqlx::PgPool,
  first: AtomicBool,
}

#[tokio::test]
async fn inv_mcp_compat_mcp_document_normalization_loss_is_explicit_and_strictly_atomic() {
  use futures_util::FutureExt;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "mcp-normalization-loss").await;
  let workspace = create_workspace(&pool, owner).await;
  let suffix = Uuid::new_v4().simple().to_string();
  let function = format!("mcp_loss_ack_{suffix}");
  let trigger = format!("mcp_loss_ack_trigger_{suffix}");
  let outcome = std::panic::AssertUnwindSafe(async {
    let token = document_read_key(&key_app, session, &["read:docs", "write:docs"]).await;
    let read_token = document_read_key(&key_app, session, &["read:docs"]).await;
    let mut state = observed_tool_state(&pool).0;
    state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let native_source = myoxus_application::markdown::prepare_markdown_import("Existing native callout", "> [!note] Preserved\n> Body **bold**\n>\n> - Parent\n>   - Child").unwrap();
    let (native_doc, _) = state.doc_service.create_page_from_snapshot_with_sync_updates(workspace, owner, Some("Existing native callout".into()), native_source.yjs_binary).await.expect("canonical pre-existing native callout fixture");
    let app = document_read_router(&pool, state);
    let native_structured = document_read_call(&app, &token, "read_doc", json!({"workspace_id":workspace,"external_id":native_doc.external_id,"representation":"structured"})).await;
    assert!(native_structured["document"]["blocks"].as_array().unwrap().iter().any(|block| block["kind"] == "callout"));
    let native_export = document_read_call(&app, &token, "read_doc", json!({"workspace_id":workspace,"external_id":native_doc.external_id,"representation":"markdown"})).await;
    let export = native_export.to_string();
    assert!(export.contains("[!note] Preserved") && export.contains("**bold**"));
    assert!(export.find("Parent").unwrap() < export.find("Child").unwrap());
    document_read_call(&app, &token, "folder_path_ensure", json!({"workspace_id":workspace,"path":["Imports"],"idempotency_key":"loss-folder"})).await;
    let lossy = "Before\n\n> [!note] Title\n> **Body café 😀**\n>\n> - Parent\n>   - Child\n\nAfter\n\n[formula $x$](https://example.test)";
    let create = json!({"workspace_id":workspace,"title":"Lossy source","content_markdown":lossy,"idempotency_key":"lossy-create"});
    let created = document_read_call(&app, &token, "create_page", create.clone()).await;
    assert!(created["normalizationDiagnostics"].as_array().unwrap().iter().any(|finding| finding["code"] == "markdown_UnsupportedMath"));
    assert!(created["normalizationDiagnosticCount"].as_u64().unwrap() >= 1);
    assert_eq!(created["normalizationDiagnosticsTruncated"], false);
    let external = created["externalId"].as_str().unwrap();
    let target = json!({"workspace_id":workspace,"external_id":external,"representation":"structured"});
    let initial = document_read_call(&app, &token, "read_doc", target.clone()).await;
    let serialized = initial.to_string();
    assert!(serialized.find("Title").unwrap() < serialized.find("Body café 😀").unwrap());
    let callout = initial["document"]["blocks"].as_array().unwrap().iter().find(|block| block["kind"] == "callout").unwrap();
    let list = callout["children"].as_array().unwrap().iter().find(|block| block["kind"] == "list").unwrap();
    assert!(list["list"]["items"][0]["text"].to_string().contains("Parent"));
    assert!(list["list"]["items"][0]["children"].to_string().contains("Child"));
    assert_eq!(callout["title"],"Title");
    let before = document_write_effect_counts(&pool, workspace).await;
    assert_eq!(document_read_call(&app, &token, "create_page", create.clone()).await, created);
    assert_eq!(document_write_effect_counts(&pool, workspace).await, before);
    let import = json!({"workspace_id":workspace,"title":"Imported loss","content_markdown":lossy,"folder_path":["Imports"],"idempotency_key":"lossy-import"});
    let patch = json!({"workspace_id":workspace,"external_id":external,"operation":"append_blocks","content_markdown":lossy,"expected_revision":initial["revision"],"idempotency_key":"lossy-patch"});
    let update = json!({"workspace_id":workspace,"external_id":external,"content_markdown":lossy,"confirm_replace_all":true,"expected_revision":initial["revision"],"idempotency_key":"lossy-replace"});
    for (name, original) in [("create_page", create.clone()), ("document_import", import.clone()), ("doc_patch", patch.clone()), ("update_doc", update)] {
      let mut strict = original.clone(); strict["strict_loss"] = json!(true);
      strict["idempotency_key"] = json!(format!("strict-{name}"));
      let failed = document_read_rpc(&app, &token, "tools/call", json!({"name":name,"arguments":strict})).await;
      assert_eq!(failed["result"]["structuredContent"]["code"], "INVALID_ARGUMENT", "{name}: {failed}");
      assert!(failed["result"]["structuredContent"]["message"].as_str().unwrap().starts_with("MIX_MCP_DOCUMENT_NORMALIZATION_LOSS"));
      assert_eq!(document_write_effect_counts(&pool, workspace).await, before, "strict {name} cannot create or change content/history/outbox/audit");
      assert_eq!(document_read_call(&app, &token, "read_doc", target.clone()).await, initial);
    }
    for name in ["create_page", "doc_patch"] {
      let mut malformed = if name == "create_page" { create.clone() } else { patch.clone() };
      malformed.as_object_mut().unwrap().remove("content_markdown");
      malformed["fragment"] = json!({"schemaVersion":"myoxus.document-fragment.v1","blocks":[{"kind":"callout","title":"private unsupported input"}]});
      malformed["idempotency_key"] = json!(format!("unsupported-{name}"));
      let failed = document_read_rpc(&app, &token, "tools/call", json!({"name":name,"arguments":malformed})).await;
      assert_eq!(failed["result"]["structuredContent"]["code"], "INVALID_ARGUMENT");
      assert!(!failed["result"]["structuredContent"]["message"].as_str().unwrap().contains("private unsupported input"));
      assert_eq!(document_write_effect_counts(&pool, workspace).await, before);
    }
    assert_eq!(document_read_rpc(&app, &read_token, "tools/call", json!({"name":"doc_patch","arguments":patch})).await["result"]["structuredContent"]["code"], "SCOPE_DENIED");
    assert_eq!(document_write_effect_counts(&pool, workspace).await, before);
    let changed = document_read_call(&app, &token, "doc_patch", patch.clone()).await;
    assert!(changed["normalizationDiagnostics"].as_array().unwrap().iter().any(|finding| finding["code"] == "markdown_UnsupportedMath"));
    let current = document_read_call(&app, &token, "read_doc", target.clone()).await;
    let blocks = current["document"]["blocks"].as_array().unwrap();
    let original_blocks = initial["document"]["blocks"].as_array().unwrap();
    assert_eq!(&blocks[..original_blocks.len()], original_blocks.as_slice(), "append must preserve every original native block");
    let after = document_write_effect_counts(&pool, workspace).await;
    assert_eq!(document_read_call(&app, &token, "doc_patch", patch.clone()).await, changed);
    assert_eq!(document_write_effect_counts(&pool, workspace).await, after);
    let mut stale = patch.clone(); stale["idempotency_key"] = json!("lossy-stale");
    assert_eq!(document_read_rpc(&app, &token, "tools/call", json!({"name":"doc_patch","arguments":stale})).await["result"]["structuredContent"]["code"], "CONFLICT");
    assert_eq!(document_write_effect_counts(&pool, workspace).await, after);
    sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.unwrap();
    assert_eq!(document_read_rpc(&app, &token, "tools/call", json!({"name":"doc_patch","arguments":patch})).await["result"]["structuredContent"]["code"], "PERMISSION_DENIED");
    assert_eq!(document_write_effect_counts(&pool, workspace).await, after);
    sqlx::query("UPDATE workspace_memberships SET role='Owner' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.unwrap();
    let imported = document_read_call(&app, &token, "document_import", import.clone()).await;
    assert_eq!(imported["markdownDiagnosticCount"], imported["normalizationDiagnosticCount"]);
    assert!(imported["normalizationDiagnosticCount"].as_u64().unwrap() > 0);
    let after_import = document_write_effect_counts(&pool, workspace).await;
    assert_eq!(document_read_call(&app, &token, "document_import", import).await, imported);
    assert_eq!(document_write_effect_counts(&pool, workspace).await, after_import);
    // A real SQL acknowledgement fault leaves the atomic fallback receipt.
    // It must retain the loss warnings and cannot authorize a second mutation.
    sqlx::query(&format!("CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.mutation_committed AND NEW.user_id='{owner}'::uuid AND NEW.idempotency_key='lossy-after-commit' THEN RAISE EXCEPTION 'owned normalization acknowledgement interruption'; END IF; RETURN NEW; END $$")).execute(&pool).await.expect("install owned completion fault");
    sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE UPDATE ON mcp_idempotency_keys FOR EACH ROW EXECUTE FUNCTION {function}()")).execute(&pool).await.expect("install owned trigger");
    let crash = json!({"workspace_id":workspace,"external_id":external,"operation":"append_blocks","content_markdown":lossy,"idempotency_key":"lossy-after-commit"});
    let failure = document_read_rpc(&app, &token, "tools/call", json!({"name":"doc_patch","arguments":crash})).await;
    assert_eq!(failure["result"]["structuredContent"]["code"], "RECOVERY_REQUIRED");
    let committed_counts = document_write_effect_counts(&pool, workspace).await;
    sqlx::query(&format!("DROP TRIGGER {trigger} ON mcp_idempotency_keys")).execute(&pool).await.expect("remove owned fault");
    let receipt = document_read_call(&app, &token, "doc_patch", crash.clone()).await;
    assert_eq!(receipt["readback"]["status"], "unavailable");
    assert!(receipt["normalizationDiagnostics"].as_array().unwrap().iter().any(|finding| finding["code"] == "markdown_UnsupportedMath"));
    assert_eq!(document_write_effect_counts(&pool, workspace).await, committed_counts);
    assert_eq!(document_read_call(&app, &token, "doc_patch", crash).await, receipt);
    assert_eq!(document_write_effect_counts(&pool, workspace).await, committed_counts);
    let math_source = "Inline $a+b$ formula.\n\n$$\nc+d\n$$";
    let math_args = json!({"workspace_id":workspace,"title":"Native formulas","content_markdown":math_source,"strict_loss":true,"idempotency_key":"native-math-create"});
    let math_before = document_write_effect_counts(&pool, workspace).await;
    let denied_math = document_read_rpc(&app, &read_token, "tools/call", json!({"name":"create_page","arguments":math_args})).await;
    assert_eq!(denied_math["result"]["structuredContent"]["code"], "SCOPE_DENIED");
    assert_eq!(document_write_effect_counts(&pool, workspace).await, math_before);
    let math = document_read_call(&app, &token, "create_page", math_args.clone()).await;
    assert!(math.get("normalizationDiagnostics").is_none());
    let math_created = document_write_effect_counts(&pool, workspace).await;
    assert_eq!(document_read_call(&app, &token, "create_page", math_args.clone()).await, math);
    assert_eq!(document_write_effect_counts(&pool, workspace).await, math_created);
    let mut code_collision = math_args;
    code_collision["content_markdown"] = json!("Inline `a+b` formula.\n\n```latex\nc+d\n```");
    let conflict = document_read_rpc(&app, &token, "tools/call", json!({"name":"create_page","arguments":code_collision})).await;
    assert_eq!(conflict["result"]["structuredContent"]["code"], "CONFLICT");
    assert_eq!(document_write_effect_counts(&pool, workspace).await, math_created);
    let math_import = document_read_call(&app, &token, "document_import", json!({"workspace_id":workspace,"title":"Native formula import","folder_path":["Imports"],"content_markdown":math_source,"strict_loss":true,"idempotency_key":"native-math-import"})).await;
    assert!(math_import.get("normalizationDiagnostics").is_none());
    let patch_math = json!({"workspace_id":workspace,"external_id":native_doc.external_id,"operation":"append_blocks","content_markdown":math_source,"strict_loss":true,"idempotency_key":"native-math-patch"});
    let math_patch = document_read_call(&app, &token, "doc_patch", patch_math.clone()).await;
    assert!(math_patch.get("normalizationDiagnostics").is_none());
    let math_patched = document_write_effect_counts(&pool, workspace).await;
    assert_eq!(document_read_call(&app, &token, "doc_patch", patch_math).await, math_patch);
    assert_eq!(document_write_effect_counts(&pool, workspace).await, math_patched);
    let math_update = document_read_call(&app, &token, "update_doc", json!({"workspace_id":workspace,"external_id":external,"content_markdown":math_source,"strict_loss":true,"confirm_replace_all":true,"idempotency_key":"native-math-update"})).await;
    assert!(math_update.get("normalizationDiagnostics").is_none());
    for key in [math["externalId"].as_str().unwrap(), math_import["externalId"].as_str().unwrap(), &native_doc.external_id, external] {
      let exported = document_read_call(&app, &token, "read_doc", json!({"workspace_id":workspace,"external_id":key,"representation":"markdown"})).await;
      let export = exported.to_string();
      assert!(export.contains("$a+b$") && export.contains("c+d"), "native formula codec survives persisted MCP writes: {export}");
      assert!(!export.contains("```latex"), "native display formula must not become code");
    }
    let clean = document_read_call(&app, &token, "create_page", json!({"workspace_id":workspace,"title":"Lossless","content_markdown":"**café 😀**\n\n- Parent\n  - Child","strict_loss":true,"idempotency_key":"clean-strict-create"})).await;
    assert!(clean.get("normalizationDiagnostics").is_none());
    let clean_read = document_read_call(&app, &token, "read_doc", json!({"workspace_id":workspace,"external_id":clean["externalId"],"representation":"markdown"})).await;
    assert!(clean_read.to_string().contains("café 😀") && clean_read.to_string().contains("Child"));
  }).catch_unwind().await;
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger} ON mcp_idempotency_keys"))
    .execute(&pool)
    .await
    .expect("clean owned completion trigger");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {function}()"))
    .execute(&pool)
    .await
    .expect("clean owned completion function");
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1")
    .bind(owner)
    .execute(&pool)
    .await
    .expect("clean owned audits");
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_compat_mcp_native_table_headers_survive_authoring_and_historical_replay() {
  use futures_util::FutureExt;
  use sha2::{Digest, Sha256};
  let hash = |value: &Value| {
    let mut canonical = value.clone();
    // Dependency feature unification may enable preserve_order in this target.
    canonical.sort_all_objects();
    hex::encode(Sha256::digest(serde_json::to_vec(&canonical).unwrap()))
  };
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "native-headers").await;
  let workspace = create_workspace(&pool, owner).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    let token = document_read_key(&key_app, session, &["read:docs", "write:docs"]).await;
    let mut state = observed_tool_state(&pool).0;
    state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let docs = state.doc_service.clone(); let app = document_read_router(&pool, state);
    let table = |count: Option<usize>| {
      let mut table = json!({"kind":"table","rows":[[[{"text":"Labels","bold":true}]],[[{"text":"Body","italic":true}]],[[{"text":""}]]]});
      if let Some(count) = count { table["headerRows"] = json!(count); }
      json!({"schemaVersion":yjs::DOCUMENT_FRAGMENT_SCHEMA,"blocks":[table]})
    };
    let assert_native = |state: Vec<u8>, count: Option<usize>| {
      let native = Doc::new(); native.transact_mut().apply_update(Update::decode_v1(&state).unwrap()).unwrap();
      let blocks = native.get_or_insert_map("blocks"); let txn = native.transact();
      let tables = blocks.iter(&txn).filter_map(|(_, value)| match value { yrs::Out::YMap(block) if block.get(&txn,"sys:flavour").is_some_and(|value| value.to_string(&txn)=="myoxus:table") => Some(block), _=>None }).collect::<Vec<_>>();
      assert!(!tables.is_empty());
      for table in tables { assert_eq!(table.get(&txn,"prop:headerRows"),count.map(|count|yrs::Out::Any(yrs::Any::from(count as f64)))); }
    };
    let listed = document_read_rpc(&app,&token,"tools/list",json!({})).await;
    let create_schema = listed["result"]["tools"].as_array().unwrap().iter().find(|tool|tool["name"]=="create_page").unwrap();
    assert!(create_schema["inputSchema"].to_string().contains("headerRows"));
    for count in [None,Some(0),Some(1),Some(2)] {
      let args=json!({"workspace_id":workspace,"title":format!("Structured {count:?}"),"fragment":table(count),"strict_loss":true,"idempotency_key":format!("structured-{count:?}")});
      let created=document_read_call(&app,&token,"create_page",args.clone()).await;
      let read_args=json!({"workspace_id":workspace,"external_id":created["externalId"]});
      let read=document_read_call(&app,&token,"read_doc",read_args).await;
      assert_eq!((*reading_block(&read, 0)).get("headerRows"),count.map(Value::from).as_ref());
      let id:Uuid=sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2").bind(workspace).bind(created["externalId"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
      assert_native(docs.load_full_doc(workspace,id).await.unwrap(),count);
      let before=document_write_effect_counts(&pool,workspace).await;
      assert_eq!(document_read_call(&app,&token,"create_page",args).await,created);
      assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
      let exported=document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":created["externalId"],"representation":"markdown"})).await;
      // Markdown retains its shipped lossy-format flag; representable tables add no finding.
      assert_eq!(exported["complete"],true,"native {count:?} export: {exported}");assert_eq!(exported["diagnostics"],json!([]));
      let source=exported["data"].as_str().unwrap();
      if count==Some(1) {assert!(source.contains("| --- |"));} else {assert!(source.contains("<table>"));assert_eq!(source.contains("<thead>"),count.is_some_and(|count|count>0));}
      let imported=document_read_call(&app,&token,"create_page",json!({"workspace_id":workspace,"title":format!("Roundtrip {count:?}"),"content_markdown":source,"strict_loss":true,"idempotency_key":format!("roundtrip-{count:?}")})).await;
      let roundtrip=document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":imported["externalId"]})).await;
      assert_eq!((*reading_block(&roundtrip, 0))["headerRows"],count.unwrap_or(0));assert_eq!((*reading_block(&roundtrip, 0))["rows"],(*reading_block(&read, 0))["rows"]);

    }
    for count in [Value::Null,json!(-1),json!(0.5),json!(18446744073709551616.0),json!(4)] {
      let mut fragment=table(None);fragment["blocks"][0]["headerRows"]=count;
      let before=document_write_effect_counts(&pool,workspace).await;
      assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"create_page","arguments":{"workspace_id":workspace,"title":"Invalid","fragment":fragment,"idempotency_key":"invalid-header"}})).await["result"]["isError"],true);
      assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
      let admissions:i64=sqlx::query_scalar("SELECT count(*) FROM mcp_idempotency_keys WHERE user_id=$1 AND idempotency_key='invalid-header'").bind(owner).fetch_one(&pool).await.unwrap();assert_eq!(admissions,0);
    }
    for content in ["<table><tbody><tr><td onclick=\"private()\">Bad</td></tr></tbody></table>","<table><tbody><tr><td><a href=\"javascript:private()\">Bad</a></td></tr></tbody></table>"] {
      let before=document_write_effect_counts(&pool,workspace).await;
      let failure=document_read_rpc(&app,&token,"tools/call",json!({"name":"create_page","arguments":{"workspace_id":workspace,"title":"Rejected HTML","content_markdown":content,"strict_loss":true,"idempotency_key":"unsafe-table"}})).await;
      assert_eq!(failure["result"]["isError"],true);assert!(!failure.to_string().contains("private"));assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
      let admissions:i64=sqlx::query_scalar("SELECT count(*) FROM mcp_idempotency_keys WHERE user_id=$1 AND idempotency_key='unsafe-table'").bind(owner).fetch_one(&pool).await.unwrap();assert_eq!(admissions,0);
    }
    let markdown="| **Labels** | Empty |\n| --- | --- |\n| *Body* | |\n";
    let args=json!({"workspace_id":workspace,"title":"GFM headers","content_markdown":markdown,"strict_loss":true,"idempotency_key":"gfm-headers"});
    let created=document_read_call(&app,&token,"create_page",args.clone()).await;
    let external=created["externalId"].as_str().unwrap();
    let id:Uuid=sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2").bind(workspace).bind(external).fetch_one(&pool).await.unwrap();
    let target=json!({"workspace_id":workspace,"external_id":external});
    let read=document_read_call(&app,&token,"read_doc",target.clone()).await;
    assert_eq!((*reading_block(&read, 0))["headerRows"],1);
    let state=docs.load_full_doc(workspace,id).await.unwrap();assert_native(state.clone(),Some(1));
    let fragment=myoxus_application::doc::document_fragment_from_yjs_with_diagnostics(&state).unwrap().0;
    let mut previous=json!({"workspaceId":workspace,"title":"GFM headers","initialContent":fragment});
    let current_hash:String=sqlx::query_scalar("SELECT payload_sha256 FROM mcp_idempotency_keys WHERE user_id=$1 AND idempotency_key='gfm-headers'").bind(owner).fetch_one(&pool).await.unwrap();
    assert_eq!(current_hash,hash(&previous),"independent canonical current payload");
    previous["initialContent"]["blocks"][0].as_object_mut().unwrap().remove("headerRows");
    let old_hash=hash(&previous);
    let before=document_write_effect_counts(&pool,workspace).await;
    assert_eq!(document_read_call(&app,&token,"create_page",args.clone()).await,created);
    let mut different=args.clone();different.as_object_mut().unwrap().remove("content_markdown");different["fragment"]=serde_json::to_value(&fragment).unwrap();different["fragment"]["blocks"][0]["headerRows"]=json!(0);
    assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"create_page","arguments":different})).await["result"]["structuredContent"]["code"],"CONFLICT");
    sqlx::query("UPDATE mcp_idempotency_keys SET payload_sha256=$2 WHERE user_id=$1 AND idempotency_key='gfm-headers'").bind(owner).bind(&old_hash).execute(&pool).await.unwrap();
    assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"create_page","arguments":args.clone()})).await["result"]["structuredContent"]["code"],"CONFLICT","format-one receipts never match the previous normalization");
    sqlx::query("UPDATE mcp_idempotency_keys SET document_payload_format=0,payload_sha256=$2 WHERE user_id=$1 AND idempotency_key='gfm-headers'").bind(owner).bind(&old_hash).execute(&pool).await.unwrap();
    assert_eq!(document_read_call(&app,&token,"create_page",args.clone()).await,created,"completed historical Markdown replays without mutation");
    let mut structured=args.clone();structured.as_object_mut().unwrap().remove("content_markdown");structured["fragment"]=serde_json::to_value(&fragment).unwrap();
    assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"create_page","arguments":structured})).await["result"]["structuredContent"]["code"],"CONFLICT","explicit structured count never falls back");
    let admission:Uuid=sqlx::query_scalar("UPDATE mcp_idempotency_keys SET response_json=NULL,mutation_committed=false,lease_until=now()-interval '1 second' WHERE user_id=$1 AND idempotency_key='gfm-headers' RETURNING id").bind(owner).fetch_one(&pool).await.unwrap();
    assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"create_page","arguments":args})).await["result"]["structuredContent"]["code"],"CONFLICT");
    let retained:Uuid=sqlx::query_scalar("SELECT id FROM mcp_idempotency_keys WHERE user_id=$1 AND idempotency_key='gfm-headers'").bind(owner).fetch_one(&pool).await.unwrap();assert_eq!(retained,admission,"old changed normalization must not acquire a new lease");
    assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
    let patch_args=json!({"workspace_id":workspace,"external_id":external,"operation":"append_blocks","content_markdown":markdown,"strict_loss":true,"idempotency_key":"headers-patch"});
    let patched=document_read_call(&app,&token,"doc_patch",patch_args.clone()).await;
    assert_eq!(patched["updatedBlocks"].as_array().unwrap().last().unwrap()["headerRows"],1);
    let replace_args=json!({"workspace_id":workspace,"external_id":external,"content_markdown":markdown,"strict_loss":true,"confirm_replace_all":true,"idempotency_key":"headers-replace"});
    let replaced=document_read_call(&app,&token,"update_doc",replace_args.clone()).await;
    assert_eq!(replaced["updatedBlocks"].as_array().unwrap()[0]["headerRows"],1);
    let folder=document_read_call(&app,&token,"folder_path_ensure",json!({"workspace_id":workspace,"path":["Header imports"],"idempotency_key":"header-folder"})).await;
    let import_args=json!({"workspace_id":workspace,"title":"Imported GFM","folder_path":["Header imports"],"content_markdown":markdown,"strict_loss":true,"idempotency_key":"headers-import"});
    let imported=document_read_call(&app,&token,"document_import",import_args.clone()).await;
    let imported_read=document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":imported["externalId"]})).await;
    assert_eq!((*reading_block(&imported_read, 0))["headerRows"],1);
    for (tool,args,response,payload,path) in [
      ("doc_patch",patch_args,patched,json!({"workspaceId":workspace,"internalDocId":id,"mutation":yjs::DocumentMutation::AppendBlocks{fragment:fragment.clone()},"confirmReplaceAll":null,"expectedRevision":null}),"/mutation/fragment"),
      ("update_doc",replace_args,replaced,json!({"workspaceId":workspace,"internalDocId":id,"mutation":yjs::DocumentMutation::ReplaceAll{fragment:fragment.clone()},"confirmReplaceAll":true,"expectedRevision":null}),"/mutation/fragment"),
      ("document_import",import_args,imported,json!({"workspaceId":workspace,"title":"Imported GFM","fragment":fragment,"folderId":folder["folderId"],"inputMode":"markdown"}),"/fragment")
    ] {
      let key=args["idempotency_key"].as_str().unwrap();
      let stored:(String,i16)=sqlx::query_as("SELECT payload_sha256,document_payload_format FROM mcp_idempotency_keys WHERE user_id=$1 AND idempotency_key=$2").bind(owner).bind(key).fetch_one(&pool).await.unwrap();
      assert_eq!(stored,(hash(&payload),1),"{tool} canonical format-one admission");
      let before=document_write_effect_counts(&pool,workspace).await;
      assert_eq!(document_read_call(&app,&token,tool,args.clone()).await,response);
      let mut previous=payload;previous.pointer_mut(&format!("{path}/blocks/0")).unwrap().as_object_mut().unwrap().remove("headerRows");
      let previous_hash=hash(&previous);
      sqlx::query("UPDATE mcp_idempotency_keys SET document_payload_format=0,payload_sha256=$3 WHERE user_id=$1 AND idempotency_key=$2").bind(owner).bind(key).bind(previous_hash).execute(&pool).await.unwrap();
      assert_eq!(document_read_call(&app,&token,tool,args.clone()).await,response,"{tool} historical completed replay");
      let mut explicit=args.clone();explicit.as_object_mut().unwrap().remove("content_markdown");explicit["fragment"]=serde_json::to_value(&fragment).unwrap();
      assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":tool,"arguments":explicit})).await["result"]["structuredContent"]["code"],"CONFLICT");
      let row:Uuid=sqlx::query_scalar("UPDATE mcp_idempotency_keys SET response_json=NULL,mutation_committed=false,lease_until=now()-interval '1 second' WHERE user_id=$1 AND idempotency_key=$2 RETURNING id").bind(owner).bind(key).fetch_one(&pool).await.unwrap();
      let pending=document_read_rpc(&app,&token,"tools/call",json!({"name":tool,"arguments":args})).await;
      assert_eq!(pending["result"]["structuredContent"]["code"],"CONFLICT");assert_eq!(pending["result"]["structuredContent"]["retryable"],true);
      assert!(pending["result"]["structuredContent"]["message"].as_str().unwrap().starts_with("MIX_MCP_IDEMPOTENCY_IN_PROGRESS"));
      let retained:Uuid=sqlx::query_scalar("SELECT id FROM mcp_idempotency_keys WHERE user_id=$1 AND idempotency_key=$2").bind(owner).bind(key).fetch_one(&pool).await.unwrap();assert_eq!(retained,row,"{tool} changed historical fragment stays fenced");
      assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
    }
  }).catch_unwind().await;
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1")
    .bind(owner)
    .execute(&pool)
    .await
    .expect("clean owned audit");
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  let retained:i64=sqlx::query_scalar("SELECT (SELECT count(*) FROM workspaces WHERE id=$1)+(SELECT count(*) FROM users WHERE id=$2)+(SELECT count(*) FROM api_keys WHERE user_id=$2)+(SELECT count(*) FROM mcp_idempotency_keys WHERE user_id=$2)").bind(workspace).bind(owner).fetch_one(&pool).await.unwrap();
  assert_eq!(retained, 0, "owned fixture cleanup");
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_compat_mcp_native_table_cell_edit_preserves_geometry_and_live_write_guards() {
  use futures_util::FutureExt;
  use yrs::{GetString, Text, types::ToJson};
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "native-cell").await;
  let workspace = create_workspace(&pool, owner).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    let token = document_read_key(&key_app, session, &["read:docs", "write:docs"]).await;
    let reader = document_read_key(&key_app, session, &["read:docs"]).await;
    let mut state = observed_tool_state(&pool).0;
    state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let docs = state.doc_service.clone();
    let app = document_read_router(&pool, state);
    let created = document_read_call(&app, &token, "create_page", json!({"workspace_id":workspace,"title":"Native cells","content_markdown":"Before\n\n| H1 | H2 | H3 |\n| --- | --- | --- |\n| A1 | Prefix **café 😀 é** suffix [keep](https://example.test/keep) | A3 |\n| B1 | B2 | |\n\nAfter $x^2$","idempotency_key":"native-cell-create"})).await;
    let external = created["externalId"].as_str().unwrap();
    let target = json!({"workspace_id":workspace,"external_id":external});
    let read = document_read_call(&app, &token, "read_doc", target.clone()).await;
    let block = (*reading_block(&read, 1))["blockId"].as_str().unwrap();
    let identities = &read["document"]["tableIdentities"][block];
    assert_eq!(identities["rowIds"].as_array().unwrap().len(), 3);
    assert_eq!(identities["columnIds"].as_array().unwrap().len(), 3);
    let row = identities["rowIds"][1].as_str().unwrap();
    let column = identities["columnIds"][1].as_str().unwrap();
    let missing_row = identities["rowIds"][2].as_str().unwrap();
    let missing_column = identities["columnIds"][2].as_str().unwrap();
    let cell_key = format!("prop:cells.{row}:{column}.text");
    let doc_id: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2").bind(workspace).bind(external).fetch_one(&pool).await.unwrap();
    let native = Doc::new();
    native.transact_mut().apply_update(Update::decode_v1(&docs.load_full_doc(workspace, doc_id).await.unwrap()).unwrap()).unwrap();
    let native_blocks = native.get_or_insert_map("blocks");
    let before_vector = native.transact().state_vector();
    let mut txn = native.transact_mut();
    let yrs::Out::YMap(table) = native_blocks.get(&txn, block).unwrap() else { panic!("native table") };
    table.insert(&mut txn, "prop:headerRows", 1);
    table.insert(&mut txn, "prop:appearance", "ruled");
    table.insert(&mut txn, "prop:density", "compact");
    table.insert(&mut txn, format!("prop:columns.{column}.width"), 237);
    table.insert(&mut txn, format!("prop:columns.{column}.textAlign"), "right");
    // A declared coordinate with no TextRef must fail, never create a cell.
    table.remove(&mut txn, &format!("prop:cells.{missing_row}:{missing_column}.text"));
    let delta = txn.encode_diff_v1(&before_vector);
    drop(txn);
    let pushed = docs.push_external_update_with_context(Uuid::new_v4(), Some(DocSyncConnectionContext { client_kind: DocSyncClientKind::Web }), workspace, DocumentKey::parse(external.to_string()).unwrap(), delta, chrono::Utc::now().timestamp_millis(), DocSpaceKind::Workspace, Some(owner), Some("myoxus-native".into()), None, None).await.unwrap();
    assert!(pushed.outcome.is_persisted());
    let initial = document_read_call(&app, &token, "read_doc", target.clone()).await;
    let original = docs.load_full_doc(workspace, doc_id).await.unwrap();
    let protected = |state: &[u8]| {
      let native = Doc::new();
      native.transact_mut().apply_update(Update::decode_v1(state).unwrap()).unwrap();
      let blocks = native.get_or_insert_map("blocks");
      let txn = native.transact();
      let yrs::Out::YMap(table) = blocks.get(&txn, block).unwrap() else { panic!("same table") };
      let mut properties = std::collections::BTreeMap::new();
      let mut rich = std::collections::BTreeMap::new();
      for (key, value) in table.iter(&txn) {
        if key == cell_key { continue; }
        if let yrs::Out::YText(text) = &value { rich.insert(key.to_owned(), text.diff(&txn, |_| ())); }
        properties.insert(key.to_owned(), value.to_json(&txn));
      }
      (properties, rich)
    };
    let protected_before = protected(&original);
    let source = "Prefix café 😀 é suffix keep";
    let selected = "afé 😀 é";
    let start = source.find(selected).unwrap();
    let end = start + selected.len();
    let args = json!({"workspace_id":workspace,"external_id":external,"operation":"edit_table_cell","block_id":block,"row_id":row,"column_id":column,"start":source[..start].encode_utf16().count(),"end":source[..end].encode_utf16().count(),"range_unit":"utf16_code_units","expected_text":selected,"replacement":"A𝛽","expected_revision":initial["revision"],"idempotency_key":"native-cell-edit"});
    let before = document_write_effect_counts(&pool, workspace).await;
    assert_eq!(document_read_rpc(&app,&reader,"tools/call",json!({"name":"doc_patch","arguments":args.clone()})).await["result"]["structuredContent"]["code"], "SCOPE_DENIED");
    assert_eq!(document_write_effect_counts(&pool, workspace).await, before);
    for (name, changes) in [("missing",json!({"row_id":missing_row,"column_id":missing_column,"start":0,"end":0,"expected_text":"","idempotency_key":"native-cell-missing"})),("mismatch",json!({"expected_text":"wrong","idempotency_key":"native-cell-mismatch"})),("unused",json!({"formatting":{"bold":true},"idempotency_key":"native-cell-unused"}))] {
      let mut bad = args.clone();
      bad.as_object_mut().unwrap().extend(changes.as_object().unwrap().clone());
      assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":bad})).await["result"]["isError"], true, "{name}");
      assert_eq!(document_write_effect_counts(&pool, workspace).await, before);
      assert_eq!(document_read_call(&app,&token,"read_doc",target.clone()).await, initial);
    }
    let changed = document_read_call(&app,&token,"doc_patch",args.clone()).await;
    assert_eq!(changed["operation"], "edit_table_cell");
    assert_eq!(changed["affectedBlockIds"], json!([block]));
    assert_eq!(changed["insertedBlockIds"], json!([]));
    assert_eq!(changed["removedBlockIds"], json!([]));
    let before = document_write_effect_counts(&pool, workspace).await;
    assert_eq!(document_read_call(&app,&token,"doc_patch",args.clone()).await, changed);
    assert_eq!(document_write_effect_counts(&pool,workspace).await, before);
    let mut stale = args.clone();
    stale["idempotency_key"] = json!("native-cell-stale");
    stale["start"] = json!(0); stale["end"] = json!(6);
    stale["expected_text"] = json!("Prefix"); stale["replacement"] = json!("STALE");
    assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":stale})).await["result"]["isError"], true);
    assert_eq!(document_write_effect_counts(&pool,workspace).await, before);
    let read = document_read_call(&app,&token,"read_doc",target.clone()).await;
    assert_eq!(read["document"]["tableIdentities"], initial["document"]["tableIdentities"]);
    assert_eq!((*reading_block(&read, 0)), (*reading_block(&initial, 0)));
    assert_eq!((*reading_block(&read, 2)), (*reading_block(&initial, 2)));
    let cell = (*reading_block(&read, 1))["rows"][1][1].as_array().unwrap();
    assert!(cell.iter().any(|span| span["text"].as_str().is_some_and(|text| text.contains("cA𝛽")) && span["bold"] == true));
    assert!(cell.iter().any(|span| span["text"] == "keep" && span["link"] == "https://example.test/keep"));
    assert_eq!(protected(&docs.load_full_doc(workspace, doc_id).await.unwrap()), protected_before);
    let client = Doc::new();
    client.transact_mut().apply_update(Update::decode_v1(&docs.load_full_doc(workspace, doc_id).await.unwrap()).unwrap()).unwrap();
    let client_blocks = client.get_or_insert_map("blocks");
    let vector = client.transact().state_vector();
    let mut txn = client.transact_mut();
    let yrs::Out::YMap(table) = client_blocks.get(&txn,block).unwrap() else { panic!("editable table") };
    let yrs::Out::YText(text) = table.get(&txn,&cell_key).unwrap() else { panic!("editable cell") };
    assert_eq!(text.get_string(&txn), "Prefix cA𝛽 suffix keep");
    text.insert(&mut txn,0,"Client ");
    let delta = txn.encode_diff_v1(&vector); drop(txn);
    let pushed = docs.push_external_update_with_context(Uuid::new_v4(), Some(DocSyncConnectionContext { client_kind: DocSyncClientKind::Web }), workspace, DocumentKey::parse(external.to_string()).unwrap(), delta, chrono::Utc::now().timestamp_millis(), DocSpaceKind::Workspace, Some(owner), Some("myoxus-native".into()), None, None).await.unwrap();
    assert!(pushed.outcome.is_persisted());
    let reloaded = docs.load_full_doc(workspace, doc_id).await.unwrap();
    assert_eq!(protected(&reloaded), protected_before);
    let read = document_read_call(&app,&token,"read_doc",target.clone()).await;
    assert!(read.to_string().contains("Client Prefix"));
    assert_eq!(read["document"]["tableIdentities"], initial["document"]["tableIdentities"]);
    let before = document_write_effect_counts(&pool,workspace).await;
    assert_eq!(document_read_call(&app,&token,"doc_patch",args.clone()).await, changed, "retry after a newer native edit must retain the original committed result");
    assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
    // Correct the same native table without replacing its cell TextRefs or
    // presentation. The cell-edit guard above protects all existing neighbors.
    let header_protected = |state: &[u8]| {
      let mut snapshot = protected(state);
      snapshot.0.remove("prop:headerRows");
      snapshot
    };
    let header_before = header_protected(&reloaded);
    let identities_before = read["document"]["tableIdentities"].clone();
    let mut latest = read.clone();
    for count in [0, 1, 2] {
      let args = json!({"workspace_id":workspace,"external_id":external,"operation":"update_block_properties","block_id":block,"properties":{"headerRows":count},"expected_revision":latest["revision"],"idempotency_key":format!("header-correction-{count}")});
      let before = document_write_effect_counts(&pool,workspace).await;
      assert_eq!(document_read_rpc(&app,&reader,"tools/call",json!({"name":"doc_patch","arguments":args.clone()})).await["result"]["structuredContent"]["code"],"SCOPE_DENIED");
      assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
      let changed = document_read_call(&app,&token,"doc_patch",args.clone()).await;
      assert_eq!(changed["updatedBlocks"][0]["headerRows"],count);
      let before = document_write_effect_counts(&pool,workspace).await;
      assert_eq!(document_read_call(&app,&token,"doc_patch",args.clone()).await,changed);
      let mut stale = args.clone(); stale["idempotency_key"] = json!(format!("header-stale-{count}"));
      assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":stale})).await["result"]["isError"],true);
      assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
      latest = document_read_call(&app,&token,"read_doc",target.clone()).await;
      assert_eq!((*reading_block(&latest, 1))["headerRows"],count);
      assert_eq!(latest["document"]["tableIdentities"],identities_before);
      assert_eq!((*reading_block(&latest, 1))["rows"],(*reading_block(&read, 1))["rows"],"all cell spans, including the previously edited cell, remain intact");
      assert_eq!(header_protected(&docs.load_full_doc(workspace,doc_id).await.unwrap()),header_before);
    }
    for (case, properties, block_id) in [("bounds",json!({"headerRows":4}),block),("mixed",json!({"headerRows":1,"title":"invalid"}),block),("kind",json!({"headerRows":0}),(*reading_block(&latest, 0))["blockId"].as_str().unwrap()),("null",json!({"headerRows":null}),block),("negative",json!({"headerRows":-1}),block),("fraction",json!({"headerRows":0.5}),block)] {
      let before = document_write_effect_counts(&pool,workspace).await;
      assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":{"workspace_id":workspace,"external_id":external,"operation":"update_block_properties","block_id":block_id,"properties":properties,"expected_revision":latest["revision"],"idempotency_key":format!("header-invalid-{case}")}})).await["result"]["isError"],true,"{case}");
      assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
      assert_eq!(document_read_call(&app,&token,"read_doc",target.clone()).await,latest);
    }
    let client = Doc::new(); client.transact_mut().apply_update(Update::decode_v1(&docs.load_full_doc(workspace,doc_id).await.unwrap()).unwrap()).unwrap();
    let blocks = client.get_or_insert_map("blocks"); let vector = client.transact().state_vector();
    let mut txn = client.transact_mut(); let yrs::Out::YMap(table) = blocks.get(&txn,block).unwrap() else { panic!("table") };
    table.insert(&mut txn,format!("prop:rows.{missing_row}.repeat.source"),"items");
    table.insert(&mut txn,format!("prop:rows.{missing_row}.repeat.alias"),"item");
    let delta = txn.encode_diff_v1(&vector); drop(txn);
    docs.push_external_update_with_context(Uuid::new_v4(),Some(DocSyncConnectionContext { client_kind: DocSyncClientKind::Web }),workspace,DocumentKey::parse(external.to_string()).unwrap(),delta,chrono::Utc::now().timestamp_millis(),DocSpaceKind::Workspace,Some(owner),Some("myoxus-native".into()),None,None).await.unwrap();
    latest = document_read_call(&app,&token,"read_doc",target.clone()).await;
    let repeat_args = json!({"workspace_id":workspace,"external_id":external,"operation":"update_block_properties","block_id":block,"properties":{"headerRows":3},"expected_revision":latest["revision"],"idempotency_key":"header-repeat"});
    let before = document_write_effect_counts(&pool,workspace).await;
    assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":repeat_args.clone()})).await["result"]["isError"],true);
    assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
    assert_eq!(document_read_call(&app,&token,"read_doc",target.clone()).await,latest);
    sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.unwrap();
    assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":repeat_args})).await["result"]["structuredContent"]["code"],"PERMISSION_DENIED");
    assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
    sqlx::query("UPDATE workspace_memberships SET role='Owner' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.unwrap();
    sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.unwrap();
    assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":args})).await["result"]["structuredContent"]["code"], "PERMISSION_DENIED");
    assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
    sqlx::query("UPDATE workspace_memberships SET role='Owner' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.unwrap();
  }).catch_unwind().await;
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1")
    .bind(owner)
    .execute(&pool)
    .await
    .expect("remove owned native-table audit fixtures");
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_compat_mcp_document_text_formatting_preserves_native_content_and_live_write_guards() {
  use futures_util::FutureExt;
  use yrs::{GetString, Text};
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "native-formatting").await;
  let workspace = create_workspace(&pool, owner).await;
  let outcome=std::panic::AssertUnwindSafe(async {
    let token=document_read_key(&key_app,session,&["read:docs","write:docs"]).await;
    let reader=document_read_key(&key_app,session,&["read:docs"]).await;
    let mut state=observed_tool_state(&pool).0;
    state.idempotency=Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let docs=state.doc_service.clone();let app=document_read_router(&pool,state);
    for (index,unit) in [None,Some("utf8_bytes"),Some("utf16_code_units"),Some("unicode_scalars")].into_iter().enumerate() {
      let created=document_read_call(&app,&token,"create_page",json!({"workspace_id":workspace,"title":"Native marks","content_markdown":"Before\n\nPrefix **café 😀 é** [keep](https://example.test/keep)\n\nAfter $x^2$","idempotency_key":format!("format-create-{index}")})).await;
      let external=created["externalId"].as_str().unwrap();let target=json!({"workspace_id":workspace,"external_id":external});
      let initial=document_read_call(&app,&token,"read_doc",target.clone()).await;
      let block=(*reading_block(&initial, 1))["blockId"].as_str().unwrap();
      let text="Prefix café 😀 é keep";let selected="café 😀 é";let start=text.find(selected).unwrap();let end=start+selected.len();
      let count=|text:&str|match unit{Some("utf16_code_units")=>text.encode_utf16().count(),Some("unicode_scalars")=>text.chars().count(),_=>text.len()};
      let mut args=json!({"workspace_id":workspace,"external_id":external,"operation":"format_text","block_id":block,"start":count(&text[..start]),"end":count(&text[..end]),"expected_text":selected,"expected_revision":initial["revision"],"formatting":{"bold":false,"italic":true,"strike":true,"code":true,"link":{"action":"set","href":" HTTPS://example.test/new "}},"idempotency_key":format!("format-set-{index}")});
      if let Some(unit)=unit{args["range_unit"]=json!(unit);}
      let before=document_write_effect_counts(&pool,workspace).await;
      assert_eq!(document_read_rpc(&app,&reader,"tools/call",json!({"name":"doc_patch","arguments":args.clone()})).await["result"]["structuredContent"]["code"],"SCOPE_DENIED");
      assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
      let changed=document_read_call(&app,&token,"doc_patch",args.clone()).await;
      assert_eq!(changed["operation"],"format_text");assert_eq!(changed["affectedBlockIds"],json!([block]));
      assert_eq!(changed["insertedBlockIds"],json!([]));assert_eq!(changed["removedBlockIds"],json!([]));
      let before=document_write_effect_counts(&pool,workspace).await;
      assert_eq!(document_read_call(&app,&token,"doc_patch",args.clone()).await,changed);
      let mut normalized=args.clone();normalized["formatting"]["link"]["href"]=json!("https://example.test/new");
      assert_eq!(document_read_call(&app,&token,"doc_patch",normalized).await,changed,"canonical href participates in durable replay identity");
      assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
      let read=document_read_call(&app,&token,"read_doc",target.clone()).await;
      assert_eq!((*reading_block(&read, 0)),(*reading_block(&initial, 0)));assert_eq!((*reading_block(&read, 2)),(*reading_block(&initial, 2)));
      let spans=(*reading_block(&read, 1))["text"].as_array().unwrap();let selected_span=spans.iter().find(|span|span["text"]==selected).unwrap();
      assert_eq!(selected_span["bold"],false);for mark in ["italic","strike","code"]{assert_eq!(selected_span[mark],true);}
      assert_eq!(selected_span["link"],"https://example.test/new");assert!(spans.iter().any(|span|span["text"]=="keep"&&span["link"]=="https://example.test/keep"));
      for (case,extra) in [("stale",json!({"idempotency_key":format!("format-stale-{index}")})),("unsafe",json!({"expected_revision":read["revision"],"formatting":{"link":{"action":"set","href":"javascript:privatePayload"}},"idempotency_key":format!("format-unsafe-{index}")})),("unknown",json!({"formatting":{"latex":"privatePayload"},"idempotency_key":format!("format-unknown-{index}")})),("empty",json!({"formatting":{},"idempotency_key":format!("format-empty-{index}")}))] {
        let mut bad=args.clone();bad.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let failure=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":bad})).await;
        assert_eq!(failure["result"]["isError"],true,"{case}");assert!(!failure.to_string().contains("privatePayload"));
        assert_eq!(document_write_effect_counts(&pool,workspace).await,before);assert_eq!(document_read_call(&app,&token,"read_doc",target.clone()).await,read);
      }
      let mut removal=args.clone();removal["expected_revision"]=read["revision"].clone();removal["idempotency_key"]=json!(format!("format-remove-{index}"));removal["formatting"]=json!({"bold":false,"italic":false,"strike":false,"code":false,"link":{"action":"remove"}});
      document_read_call(&app,&token,"doc_patch",removal.clone()).await;
      let restored=document_read_call(&app,&token,"read_doc",target.clone()).await;
      let selected_span=(*reading_block(&restored, 1))["text"].as_array().unwrap().iter().find(|span|span["text"].as_str().is_some_and(|text|text.contains(selected))).unwrap();
      for mark in ["bold","italic","strike","code"]{assert_eq!(selected_span[mark],false);}assert!(selected_span["link"].is_null());
      assert_eq!((*reading_block(&restored, 1))["blockId"],block);
      let doc_id:Uuid=sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2").bind(workspace).bind(external).fetch_one(&pool).await.unwrap();
      // Reload through the native rich-text consumer and send a normal Web
      // sync delta, independent of the semantic mutation implementation.
      let state=docs.load_full_doc(workspace,doc_id).await.unwrap();let client=Doc::new();client.transact_mut().apply_update(Update::decode_v1(&state).unwrap()).unwrap();
      let blocks=client.get_or_insert_map("blocks");let before_vector=client.transact().state_vector();
      let mut txn=client.transact_mut();let yrs::Out::YMap(native_block)=blocks.get(&txn,block).unwrap()else{panic!("native block")};let yrs::Out::YText(native_text)=native_block.get(&txn,"prop:text").unwrap()else{panic!("native text")};
      assert_eq!(native_text.get_string(&txn),text);native_text.insert(&mut txn,0,"Client ");let delta=txn.encode_diff_v1(&before_vector);drop(txn);
      let persisted=docs.push_external_update_with_context(Uuid::new_v4(),Some(DocSyncConnectionContext{client_kind:DocSyncClientKind::Web}),workspace,DocumentKey::parse(external.to_string()).unwrap(),delta,chrono::Utc::now().timestamp_millis(),DocSpaceKind::Workspace,Some(owner),Some("myoxus-native".into()),None,None).await.unwrap();assert!(persisted.outcome.is_persisted());
      let reloaded=document_read_call(&app,&token,"read_doc",target.clone()).await;assert!(reloaded.to_string().contains("Client Prefix"));assert_eq!((*reading_block(&reloaded, 0)),(*reading_block(&initial, 0)));assert_eq!((*reading_block(&reloaded, 2)),(*reading_block(&initial, 2)));assert_eq!((*reading_block(&reloaded, 1))["blockId"],block);
      let before=document_write_effect_counts(&pool,workspace).await;
      sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.unwrap();
      assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":removal})).await["result"]["structuredContent"]["code"],"PERMISSION_DENIED");assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
      sqlx::query("UPDATE workspace_memberships SET role='Owner' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.unwrap();
    }
  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_compat_rich_replacements_and_named_fields_preserve_native_neighbors() {
  use futures_util::FutureExt;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "native-rich-fields").await;
  let workspace = create_workspace(&pool, owner).await;
  let outcome=std::panic::AssertUnwindSafe(async {
    let token = document_read_key(&key_app, session, &["read:docs", "write:docs"]).await;
    let mut state=observed_tool_state(&pool).0;
    state.idempotency=Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let app=document_read_router(&pool,state);
    let created=document_read_call(&app,&token,"create_page",json!({"workspace_id":workspace,"title":"Native rich fields","idempotency_key":"rich-fields-create","fragment":{"schemaVersion":"myoxus.document-fragment.v1","blocks":[
      {"kind":"paragraph","spans":[{"text":"ABCDE","bold":true}]},
      {"kind":"callout","spans":[{"text":"Body remains"}],"title":"Callout Title","calloutType":"info"},
      {"kind":"table","rows":[[[{"text":"Cell","italic":true}],[{"text":"Neighbor"}]]]},
      {"kind":"callout","spans":[{"text":"Absent title"}]}
    ]}})).await;
    let external=created["externalId"].as_str().unwrap();let target=json!({"workspace_id":workspace,"external_id":external});
    let initial=document_read_call(&app,&token,"read_doc",target.clone()).await;
    let ids:Vec<_>=reading_blocks(&initial).map(|block|block["blockId"].as_str().unwrap().to_string()).collect();
    let mut current=initial.clone();
    for (index,operation) in [
      json!({"operation":"edit_text","block_id":ids[0],"start":2,"end":3,"expected_text":"C","replacement_spans":[{"text":"é"},{"text":"😀","underline":true,"link":" HTTPS://example.test/path "}]}),
      json!({"operation":"edit_text","block_id":ids[1],"text_field":"title","start":8,"end":13,"expected_text":"Title","replacement":"Updated"}),
      json!({"operation":"edit_table_cell","block_id":ids[2],"row_id":"row-0000","column_id":"col-0000","start":1,"end":3,"expected_text":"el","replacement_spans":[{"text":"Ω","bold":true}]}),
      json!({"operation":"format_text","block_id":ids[2],"row_id":"row-0000","column_id":"col-0000","start":0,"end":4,"expected_text":"CΩl","formatting":{"underline":true}}),
      json!({"operation":"edit_text","block_id":ids[3],"text_field":"title","start":0,"end":0,"expected_text":"","replacement":"New title"}),
    ].into_iter().enumerate() {
      let mut args=operation;for (key,value) in target.as_object().unwrap(){args[key]=value.clone();}
      args["expected_revision"]=current["revision"].clone();args["idempotency_key"]=json!(format!("rich-fields-{index}"));
      let changed=document_read_call(&app,&token,"doc_patch",args.clone()).await;
      let counts=document_write_effect_counts(&pool,workspace).await;
      assert_eq!(document_read_call(&app,&token,"doc_patch",args.clone()).await,changed);assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
      let next=document_read_call(&app,&token,"read_doc",target.clone()).await;
      let changed_id=args["block_id"].as_str().unwrap();let updated=reading_blocks(&next).find(|block|block["blockId"]==changed_id).unwrap();
      assert_eq!(changed["updatedBlocks"],json!([updated]));assert_eq!(changed["insertedBlockIds"],json!([]));assert_eq!(changed["removedBlockIds"],json!([]));
      for block in reading_blocks(&current).filter(|block|block["blockId"]!=changed_id){assert_eq!(reading_blocks(&next).find(|next|next["blockId"]==block["blockId"]).unwrap(),block);}
      current=next;
    }
    let p=reading_block(&current,0);let runs=p["native"]["fields"][0]["spans"].as_array().unwrap();
    let plain=runs.iter().find(|run|run["text"]=="é").unwrap();assert_eq!(plain["bold"],false);assert_eq!(plain["link"],Value::Null);
    let linked=runs.iter().find(|run|run["text"]=="😀").unwrap();assert_eq!(linked["link"],"https://example.test/path");assert_eq!(linked["underline"],true);
    assert_eq!(reading_block(&current,1)["native"]["fields"][0],reading_block(&initial,1)["native"]["fields"][0]);
    let table=reading_block(&current,2);assert_eq!(table["native"]["fields"][1],reading_block(&initial,2)["native"]["fields"][1]);
    let counts=document_write_effect_counts(&pool,workspace).await;
    for (index,invalid) in [
      json!({"operation":"edit_text","block_id":ids[0],"start":0,"end":0,"replacement":"","replacement_spans":[]}),
      json!({"operation":"edit_text","block_id":ids[0],"start":0,"end":0,"replacement_spans":[{"text":"x","link":"javascript:alert(1)"}]}),
      json!({"operation":"edit_text","block_id":ids[0],"start":0,"end":1,"expected_text":"wrong","replacement_spans":[]}),
      json!({"operation":"edit_text","block_id":ids[0],"text_field":"title","start":0,"end":0,"replacement":"bad"}),
      json!({"operation":"edit_text","block_id":ids[1],"text_field":"title","start":0,"end":0,"replacement_spans":[{"text":"rich","bold":true}]}),
      json!({"operation":"edit_text","block_id":ids[1],"text_field":"title","start":0,"end":0,"replacement":"two\nlines"}),
      json!({"operation":"format_text","block_id":ids[1],"text_field":"title","start":0,"end":1,"formatting":{"bold":true}}),
      json!({"operation":"format_text","block_id":ids[2],"row_id":"row-0000","start":0,"end":1,"formatting":{"bold":true}}),
      json!({"operation":"edit_text","block_id":ids[0],"start":0,"end":0,"replacement_spans":[{"text":" ","footnote":{"label":"missing","definitionId":"absent"}}]}),
      json!({"operation":"edit_text","block_id":ids[0],"start":0,"end":0,"replacement":"stale","expected_revision":initial["revision"]})
    ].into_iter().enumerate() {
      let mut args=invalid;for (key,value) in target.as_object().unwrap(){args[key]=value.clone();}args["idempotency_key"]=json!(format!("rich-fields-invalid-{index}"));
      let result=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":args})).await;assert_eq!(result["result"]["isError"],true,"{result}");
      assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);assert_eq!(document_read_call(&app,&token,"read_doc",target.clone()).await,current);
    }
  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_compat_mcp_document_unicode_text_ranges_are_native_atomic_and_replay_safe() {
  use futures_util::FutureExt;
  use sqlx::Connection;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "mcp-unicode-ranges").await;
  let workspace = create_workspace(&pool, owner).await;
  let mut pending_edit: Option<tokio::task::JoinHandle<Value>> = None;
  let mut concurrent_writer: Option<tokio::task::JoinHandle<myoxus_application::doc::DocContentMutationCommit>> = None;
  let outcome=std::panic::AssertUnwindSafe(async {
    let token=document_read_key(&key_app,session,&["read:docs","write:docs"]).await;
    let read_token=document_read_key(&key_app,session,&["read:docs"]).await;
    let mut state=observed_tool_state(&pool).0;
    state.idempotency=Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let doc_service=state.doc_service.clone();
    let app=document_read_router(&pool,state);
    for (index,unit) in [None,Some("utf8_bytes"),Some("utf16_code_units"),Some("unicode_scalars")].into_iter().enumerate() {
      let created=document_read_call(&app,&token,"create_page",json!({"workspace_id":workspace,"title":format!("Unicode case {index}"),"idempotency_key":format!("unicode-create-{index}"),"fragment":{"schemaVersion":"myoxus.document-fragment.v1","blocks":[
        {"kind":"paragraph","spans":[{"text":"Neighbor before","italic":true}]},
        {"kind":"paragraph","spans":[{"text":"Prefix "},{"text":"café 😀 e\u{301}","bold":true},{"text":" link","link":"https://example.test/keep"}]},
        {"kind":"paragraph","spans":[{"text":"Neighbor after","strike":true}]}
      ]}})).await;
      let external=created["externalId"].as_str().expect("external identity");
      let target=json!({"workspace_id":workspace,"external_id":external,"representation":"structured"});
      let initial=document_read_call(&app,&token,"read_doc",target.clone()).await;
      let block=(*reading_block(&initial, 1))["blockId"].as_str().expect("native target block");
      let mut current_text="Prefix café 😀 e\u{301} link".to_string();
      let mut revision=initial["revision"].as_i64().expect("source sequence");
      let mut first_call=None;
      for (edit,(selected,replacement)) in [("é","è"),("😀","🌿"),("\u{301}","\u{308}")].into_iter().enumerate() {
        let start=current_text.find(selected).expect("selected original text");
        let end=start+selected.len();
        let count=|text:&str| match unit {Some("utf16_code_units")=>text.encode_utf16().count(),Some("unicode_scalars")=>text.chars().count(),_=>text.len()};
        let mut args=json!({"workspace_id":workspace,"external_id":external,"operation":"edit_text","block_id":block,"start":count(&current_text[..start]),"end":count(&current_text[..end]),"replacement":replacement,"expected_text":selected,"expected_revision":revision,"idempotency_key":format!("unicode-edit-{index}-{edit}")});
        if let Some(unit)=unit{args["range_unit"]=json!(unit);}
        let counts=document_write_effect_counts(&pool,workspace).await;
        assert_eq!(document_read_rpc(&app,&read_token,"tools/call",json!({"name":"doc_patch","arguments":args})).await["result"]["structuredContent"]["code"],"SCOPE_DENIED");
        assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
        let changed=document_read_call(&app,&token,"doc_patch",args.clone()).await;
        assert_eq!(changed["affectedBlockIds"],json!([block]));
        revision=changed["revision"].as_i64().expect("committed sequence");
        let counts=document_write_effect_counts(&pool,workspace).await;
        assert_eq!(document_read_call(&app,&token,"doc_patch",args.clone()).await,changed);
        assert_eq!(document_write_effect_counts(&pool,workspace).await,counts,"exact retry cannot append content/history/outbox/audit");
        current_text.replace_range(start..end,replacement);
        if first_call.is_none(){first_call=Some((args,changed));}
      }
      let final_read=document_read_call(&app,&token,"read_doc",target.clone()).await;
      let blocks=reading_blocks(&final_read).cloned().collect::<Vec<_>>();
      assert_eq!(blocks[0],(*reading_block(&initial, 0)));assert_eq!(blocks[2],(*reading_block(&initial, 2)));
      assert_eq!(blocks[1]["blockId"],block);
      assert!(blocks[1]["text"].as_array().expect("native spans").iter().any(|span|span["text"]=="cafè 🌿 e\u{308}"&&span["bold"]==true));
      assert!(blocks[1]["text"].as_array().expect("native spans").iter().any(|span|span["text"]==" link"&&span["link"]=="https://example.test/keep"));
      let before=document_write_effect_counts(&pool,workspace).await;
      let baseline=json!({"workspace_id":workspace,"external_id":external,"operation":"edit_text","block_id":block,"start":0,"end":6,"replacement":"No write","idempotency_key":format!("unicode-failure-{index}")});
      for (case,fields,code) in [
        ("mismatch",json!({"expected_text":"private mismatched original"}),"INVALID_ARGUMENT"),
        ("utf8-boundary",json!({"range_unit":"utf8_bytes","start":10,"end":11}),"INVALID_ARGUMENT"),
        ("utf16-boundary",json!({"range_unit":"utf16_code_units","start":12,"end":13}),"INVALID_ARGUMENT"),
        ("scalar-bounds",json!({"range_unit":"unicode_scalars","start":100,"end":101}),"INVALID_ARGUMENT"),
        ("stale",json!({"expected_revision":initial["revision"]}),"CONFLICT"),
        ("unknown-unit",json!({"range_unit":"graphemes"}),"INVALID_ARGUMENT"),
        ("null-unit",json!({"range_unit":null}),"INVALID_ARGUMENT"),
        ("null-expected",json!({"expected_text":null}),"INVALID_ARGUMENT"),
      ] {
        let mut args=baseline.clone();args["idempotency_key"]=json!(format!("unicode-failure-{index}-{case}"));
        args.as_object_mut().expect("arguments").extend(fields.as_object().expect("case fields").clone());
        let failed=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":args})).await;
        assert_eq!(failed["result"]["structuredContent"]["code"],code,"{case}");
        assert!(!failed["result"]["structuredContent"]["message"].as_str().expect("redacted error").contains("private mismatched original"));
        assert_eq!(document_write_effect_counts(&pool,workspace).await,before,"{case} must fail before durable effects");
        assert_eq!(document_read_call(&app,&token,"read_doc",target.clone()).await,final_read,"{case} must preserve native state and revision");
      }
      let (args,first)=first_call.expect("original admitted write");
      assert_eq!(document_read_call(&app,&token,"doc_patch",args).await,first,"a later head must not replace the exact earlier receipt");
      assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
      sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.expect("revoke current write access");
      assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":baseline})).await["result"]["structuredContent"]["code"],"PERMISSION_DENIED");
      assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
      sqlx::query("UPDATE workspace_memberships SET role='Owner' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.expect("restore owned fixture authority");
      if index==3 {
        let doc_id:Uuid=sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2").bind(workspace).bind(external).fetch_one(&pool).await.expect("owned native identity");
        let before=document_write_effect_counts(&pool,workspace).await;
        let mut gate_connection=sqlx::PgConnection::connect_with(pool.connect_options().as_ref()).await.expect("owned lock connection");
        let mut gate=gate_connection.begin().await.expect("owned gate transaction");
        let holder:i32=sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut *gate).await.expect("owned holder PID");
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)").bind(format!("workspace-document:{workspace}:{doc_id}")).execute(&mut *gate).await.expect("hold actual canonical document lock");
        let service=doc_service.clone();let block_id=block.to_string();
        concurrent_writer=Some(tokio::spawn(async move {service.mutate_content(workspace,doc_id,Some(owner),yjs::DocumentMutation::EditText{block_id,start:0,end:6,replacement:"Other!".into(),replacement_spans:None,text_field:None,range_unit:None,expected_text:Some("Prefix".into())},false,None).await.expect("first canonical writer commits")}));
        // Queue the real canonical writer first, then the MCP request. Both
        // preview the old text; the later locked state must decide admission.
        for wanted in [1_i64,2] {
          if wanted==2 {
            let task_app=app.clone();let task_token=token.clone();let args=json!({"workspace_id":workspace,"external_id":external,"operation":"edit_text","block_id":block,"start":0,"end":6,"range_unit":"unicode_scalars","expected_text":"Prefix","replacement":"Must not overwrite newer text","idempotency_key":"unicode-locked-mismatch"});
            pending_edit=Some(tokio::spawn(async move{document_read_rpc(&task_app,&task_token,"tools/call",json!({"name":"doc_patch","arguments":args})).await}));
          }
          tokio::time::timeout(std::time::Duration::from_secs(10),async{
            loop{let waiting:i64=sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))").bind(holder).fetch_one(&mut *gate).await.expect("owned queued writers");if waiting==wanted{break;}tokio::time::sleep(std::time::Duration::from_millis(20)).await;}
          }).await.expect("writers must queue on the canonical lock");
        }
        gate.commit().await.expect("release owned gate");
        let committed=concurrent_writer.take().expect("queued canonical writer").await.expect("canonical writer task");
        let rejected=pending_edit.take().expect("queued MCP writer").await.expect("MCP writer task");
        assert_eq!(rejected["result"]["structuredContent"]["code"],"INVALID_ARGUMENT");
        assert_eq!(rejected["result"]["structuredContent"]["message"],"MIX_DOCUMENT_MUTATION_EXPECTED_TEXT_MISMATCH");
        let after=document_write_effect_counts(&pool,workspace).await;
        assert_eq!(after,(before.0,before.1+1,before.2,before.3+1,before.4),"only the first canonical writer may persist an update/outbox event");
        let locked_read=document_read_call(&app,&token,"read_doc",target.clone()).await;
        assert_eq!(locked_read["revision"],committed.sequence);
        assert!(locked_read.to_string().contains("Other!"));assert!(!locked_read.to_string().contains("Must not overwrite newer text"));
      }
    }
  }).catch_unwind().await;
  if let Some(task) = pending_edit {
    task.abort();
    let stopped = task.await;
    assert!(stopped.is_err());
  }
  if let Some(task) = concurrent_writer {
    task.abort();
    let stopped = task.await;
    assert!(stopped.is_err());
  }
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1")
    .bind(owner)
    .execute(&pool)
    .await
    .expect("remove owned audit fixtures");
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_document_import_persisted_interruptions_never_duplicate_or_orphan_placement() {
  use futures_util::FutureExt;
  use sqlx::Connection;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "mcp-import-interruption").await;
  let workspace = create_workspace(&pool, owner).await;
  let suffix = Uuid::new_v4().simple().to_string();
  let function = format!("mcp_import_gate_{suffix}");
  let trigger = format!("mcp_import_gate_trigger_{suffix}");
  let mut installed_table = None;
  let mut pending_task = None;
  let mut writer_pid = None;
  let outcome = std::panic::AssertUnwindSafe(async {
    let token = document_read_key(&key_app, session, &["read:docs", "write:docs"]).await;
    let read_token = document_read_key(&key_app, session, &["read:docs"]).await;
    let mut state = observed_tool_state(&pool).0;
    state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let app = document_read_router(&pool, state.clone());
    let destination = document_read_call(&app, &token, "folder_path_ensure", json!({"workspace_id":workspace,"path":["Imports"],"idempotency_key":"import-gate-folder"})).await;
    let blocked = document_read_call(&app, &token, "folder_path_ensure", json!({"workspace_id":workspace,"path":["Blocked","Bad sibling"],"idempotency_key":"import-gate-blocked"})).await;
    let blocked_parent = document_read_call(&app, &token, "folder_path_ensure", json!({"workspace_id":workspace,"path":["Blocked"],"idempotency_key":"import-gate-blocked-parent"})).await;
    crate::mcp_folder_tools_test::corrupt_organizer_order_key(&state, workspace, blocked["folderId"].as_str().expect("bad sibling")).await;

    // The gates block real SQL boundaries, not only mock futures. Aborting the
    // HTTP task and its exact backend simulates loss of the owning process.
    for (stage, table) in [("created", "doc_updates"), ("placed", "mcp_idempotency_keys"), ("cleanup", "docs")] {
      let key = format!("import-interrupted-{stage}");
      let title = format!("Owned import {stage}");
      let args = json!({"workspace_id":workspace,"title":title,"content_markdown":"Keep **bold** café 😀 and untouched content.",
        "folder_id": if stage=="cleanup" { &blocked_parent["folderId"] } else { &destination["folderId"] }, "idempotency_key":key});
      let gate_key = i64::from_le_bytes(Uuid::new_v4().as_bytes()[..8].try_into().expect("gate bytes"));
      let condition = match stage {
        "created" => format!("NEW.workspace_id='{workspace}'::uuid AND EXISTS(SELECT 1 FROM docs WHERE id=NEW.doc_id AND external_id='db${workspace}$folders')"),
        "placed" => format!("NEW.user_id='{owner}'::uuid AND NEW.tool_name='document_import' AND NEW.idempotency_key='{key}' AND NOT (NEW.response_json ? '_mcpImportRecovery')"),
        _ => format!("NEW.workspace_id='{workspace}'::uuid AND NEW.title='{title}' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL"),
      };
      sqlx::query(&format!("CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF {condition} THEN PERFORM pg_advisory_xact_lock({gate_key}); END IF; RETURN NEW; END $$"))
        .execute(&pool).await.expect("install owned crash-point function");
      sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE {} ON {table} FOR EACH ROW EXECUTE FUNCTION {function}()", if stage=="created" {"INSERT"} else {"UPDATE"}))
        .execute(&pool).await.expect("install owned crash-point trigger");
      installed_table = Some(table);
      let mut connection = sqlx::PgConnection::connect_with(pool.connect_options().as_ref()).await.expect("owned gate connection");
      let mut gate = connection.begin().await.expect("owned gate transaction");
      let holder: i32 = sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut *gate).await.expect("gate backend");
      sqlx::query("SELECT pg_advisory_xact_lock($1)").bind(gate_key).execute(&mut *gate).await.expect("hold owned gate");
      let task_app=app.clone();let task_token=token.clone();let task_args=args.clone();
      pending_task = Some(tokio::spawn(async move {document_read_rpc(&task_app,&task_token,"tools/call",json!({"name":"document_import","arguments":task_args})).await}));
      let pid = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
          if let Some(pid) = sqlx::query_scalar::<_,i32>("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))")
            .bind(holder).fetch_optional(&pool).await.expect("owned blocked backend") {break pid;}
          tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
      }).await.expect("import must reach persisted crash point");
      writer_pid=Some(pid);
      let receipt: Value = sqlx::query_scalar("SELECT response_json FROM mcp_idempotency_keys WHERE user_id=$1 AND tool_name='document_import' AND idempotency_key=$2 AND mutation_committed")
        .bind(owner).bind(&key).fetch_one(&pool).await.expect("creation receipt predates the blocked step");
      assert_eq!(receipt["_mcpImportRecovery"]["step"], if stage=="cleanup" {"compensating"} else {"created"});
      assert!(!receipt.to_string().contains("untouched content"), "receipt must contain no private input");
      let external=receipt["_mcpImportRecovery"]["externalId"].as_str().expect("existing page");
      let entry=receipt["_mcpImportRecovery"]["entryId"].as_str().expect("preallocated entry");
      let task=pending_task.take().expect("owned HTTP task");task.abort();assert!(task.await.expect_err("request stopped").is_cancelled());
      assert!(sqlx::query_scalar::<_,bool>("SELECT pg_terminate_backend($1)").bind(pid).fetch_one(&pool).await.expect("terminate exact interrupted backend"));
      writer_pid=None;gate.rollback().await.expect("release gate");
      sqlx::query(&format!("DROP TRIGGER {trigger} ON {table}")).execute(&pool).await.expect("remove gate trigger");
      sqlx::query(&format!("DROP FUNCTION {function}()")).execute(&pool).await.expect("remove gate function");installed_table=None;
      let counts=document_write_effect_counts(&pool,workspace).await;
      let mut restarted_state=observed_tool_state(&pool).0;
      restarted_state.idempotency=Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
      let restarted_app=document_read_router(&pool,restarted_state);
      for _ in 0..2 {
        let replay=document_read_rpc(&restarted_app,&token,"tools/call",json!({"name":"document_import","arguments":args})).await;
        assert_eq!(replay["result"]["isError"],true);
        assert_eq!(replay["result"]["structuredContent"]["code"],"RECOVERY_REQUIRED");
        assert_eq!(replay["result"]["structuredContent"]["retryable"],false);
        let message=replay["result"]["structuredContent"]["message"].as_str().expect("safe actionable recovery");
        assert!(message.contains(external)&&message.contains(entry));assert!(!message.contains("untouched content"));
        assert_eq!(document_write_effect_counts(&pool,workspace).await,counts,"recovery must never duplicate any durable effect");
      }
      let page_count:i64=sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1 AND title=$2 AND deleted_at IS NULL")
        .bind(workspace).bind(&title).fetch_one(&pool).await.expect("one live page");assert_eq!(page_count,1);
      let native=document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":external,"representation":"structured"})).await;
      assert!(native.to_string().contains("untouched content")&&native.to_string().contains("bold"));
      let entries=document_read_call(&app,&token,"folder_entry_list",json!({"workspace_id":workspace,"parent_id":args["folder_id"]})).await;
      let placements=entries["entries"].as_array().expect("entries").iter().filter(|row|row["targetId"]==external).count();
      assert_eq!(placements,usize::from(stage=="placed"),"interrupted cleanup must not leave orphan visible entries");
      let mut conflict=args.clone();conflict["title"]=json!("Different payload");
      assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"document_import","arguments":conflict})).await["result"]["structuredContent"]["code"],"CONFLICT");
      assert_eq!(document_read_rpc(&app,&read_token,"tools/call",json!({"name":"document_import","arguments":args})).await["result"]["structuredContent"]["code"],"SCOPE_DENIED");
      let current_doc=Uuid::parse_str(receipt["_mcpInternalDocumentId"].as_str().expect("current native identity")).expect("UUID");
      sqlx::query("UPDATE docs SET blocked=true WHERE id=$1").bind(current_doc).execute(&pool).await.expect("administratively block only the owned fixture");
      let blocked_replay=document_read_rpc(&restarted_app,&token,"tools/call",json!({"name":"document_import","arguments":args})).await;
      assert_eq!(blocked_replay["result"]["structuredContent"]["code"],"PERMISSION_DENIED","an old workspace role must not authorize a currently blocked target");
      assert!(!blocked_replay["result"]["structuredContent"]["message"].as_str().expect("safe denial").contains(external));
      sqlx::query("UPDATE docs SET blocked=false WHERE id=$1").bind(current_doc).execute(&pool).await.expect("restore the fixture's current access state");
      sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.expect("revoke authority");
      assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"document_import","arguments":args})).await["result"]["structuredContent"]["code"],"PERMISSION_DENIED");
      sqlx::query("UPDATE workspace_memberships SET role='Owner' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.expect("restore fixture authority");
      let leaf_before_repair=load_doc_update_payloads(&pool,current_doc).await;
      let snapshot_before_repair:Option<Vec<u8>>=sqlx::query_scalar("SELECT payload FROM doc_snapshots WHERE doc_id=$1").bind(current_doc).fetch_optional(&pool).await.expect("owned leaf snapshot before repair");
      // Recovery uses existing owners and identities, never another creation.
      if stage=="cleanup" {
        document_read_call(&app,&token,"delete_page",json!({"workspace_id":workspace,"external_id":external,"idempotency_key":"finish-existing-import-cleanup"})).await;
      } else {
        let repair_args=json!({"workspace_id":workspace,"external_id":external,"folder_id":args["folder_id"],"idempotency_key":format!("repair-existing-{stage}")});
        let repaired=document_read_call(&app,&token,"folder_entry_place",repair_args.clone()).await;
        let repair_counts=document_write_effect_counts(&pool,workspace).await;
        if stage=="placed" {assert_eq!(repaired["entryId"],entry,"repair must preserve an already published entry identity");assert_eq!((repair_counts.0,repair_counts.1,repair_counts.2,repair_counts.3),(counts.0,counts.1,counts.2,counts.3),"correct existing placement must not write domain/history/outbox state");}
        assert_eq!(document_read_call(&app,&token,"folder_entry_place",repair_args).await,repaired);
        assert_eq!(document_write_effect_counts(&pool,workspace).await,repair_counts,"repeated repair must not write or audit again");
      }
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM docs WHERE workspace_id=$1 AND title=$2").bind(workspace).bind(&title).fetch_one(&pool).await.expect("recovery keeps exactly the original page"),1);
      // Trash intentionally excludes normal live reads. Inspect this owned
      // fixture's persisted native state without weakening product read ACLs.
      let leaf_after_repair=load_doc_update_payloads(&pool,current_doc).await;
      let snapshot_after_repair:Option<Vec<u8>>=sqlx::query_scalar("SELECT payload FROM doc_snapshots WHERE doc_id=$1").bind(current_doc).fetch_optional(&pool).await.expect("owned leaf snapshot after repair");
      assert_eq!(leaf_after_repair,leaf_before_repair,"repair/trash must preserve every native leaf update");assert_eq!(snapshot_after_repair,snapshot_before_repair);
      let native_after_repair=yjs::merge_updates(snapshot_after_repair.into_iter().chain(leaf_after_repair).collect()).expect("stored native state after repair");
      assert!(yjs::extract_text_from_yjs(&native_after_repair).expect("native projection after repair").markdown.contains("untouched content"));
      let repaired_counts=document_write_effect_counts(&pool,workspace).await;
      assert_eq!(document_read_rpc(&restarted_app,&token,"tools/call",json!({"name":"document_import","arguments":args})).await["result"]["structuredContent"]["code"],"RECOVERY_REQUIRED");
      assert_eq!(document_write_effect_counts(&pool,workspace).await,repaired_counts,"retry after repair must not recreate a page");
    }
    let compensated_args=json!({"workspace_id":workspace,"title":"Completed cleanup","content_markdown":"Preserved trashed content","folder_id":blocked_parent["folderId"],"idempotency_key":"import-cleanup-completed"});
    let compensated=document_read_rpc(&app,&token,"tools/call",json!({"name":"document_import","arguments":compensated_args})).await;
    assert_eq!(compensated["result"]["structuredContent"]["code"],"RECOVERY_REQUIRED");
    assert_eq!(compensated["result"]["structuredContent"]["retryable"],false);
    let receipt:Value=sqlx::query_scalar("SELECT response_json FROM mcp_idempotency_keys WHERE user_id=$1 AND tool_name='document_import' AND idempotency_key='import-cleanup-completed'").bind(owner).fetch_one(&pool).await.expect("completed compensation proof");
    assert_eq!(receipt["_mcpImportRecovery"]["step"],"compensated");
    let trashed:bool=sqlx::query_scalar("SELECT deleted_at IS NOT NULL FROM docs WHERE id=$1").bind(Uuid::parse_str(receipt["_mcpInternalDocumentId"].as_str().expect("doc identity")).expect("UUID")).fetch_one(&pool).await.expect("trash uses lifecycle owner");assert!(trashed);
    let counts=document_write_effect_counts(&pool,workspace).await;
    assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"document_import","arguments":compensated_args})).await["result"]["structuredContent"]["code"],"RECOVERY_REQUIRED");
    assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
    let success_args=json!({"workspace_id":workspace,"title":"Completed composed import","fragment":{"schemaVersion":"myoxus.document-fragment.v1","blocks":[{"kind":"paragraph","spans":[{"text":"Lossless structured","bold":true}]}]},"folder_id":destination["folderId"],"idempotency_key":"import-completed"});
    let success=document_read_call(&app,&token,"document_import",success_args.clone()).await;
    let schema=&myoxus_mcp::tool_registry::find_tool("document_import").expect("advertised import tool").output_schema;
    assert_eq!(schema["additionalProperties"],false);
    for field in schema["required"].as_array().expect("required output fields") {
      assert!(success.get(field.as_str().expect("field name")).is_some(),"successful import must satisfy advertised required fields");
    }
    for (field,value) in success.as_object().expect("import output"){assert!(schema["properties"].get(field).is_some(),"unadvertised import result field: {field}");if field=="markdownDiagnosticCount"{assert!(value.as_u64().is_some(),"diagnostic count must be a nonnegative integer");}}
    let counts=document_write_effect_counts(&pool,workspace).await;
    assert_eq!(document_read_call(&app,&token,"document_import",success_args.clone()).await,success);
    assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
    let success_doc:Uuid=sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2").bind(workspace).bind(success["externalId"].as_str().expect("completed external identity")).fetch_one(&pool).await.expect("completed import identity");
    sqlx::query("UPDATE docs SET blocked=true WHERE id=$1").bind(success_doc).execute(&pool).await.expect("block completed import target");
    assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"document_import","arguments":success_args})).await["result"]["structuredContent"]["code"],"PERMISSION_DENIED","completed replay must check current target access too");
    assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
  }).catch_unwind().await;
  if let Some(task) = pending_task {
    task.abort();
    let stopped = task.await;
    assert!(stopped.is_err());
  }
  if let Some(pid) = writer_pid {
    sqlx::query("SELECT pg_terminate_backend($1)")
      .bind(pid)
      .execute(&pool)
      .await
      .expect("clean exact owned backend");
  }
  if let Some(table) = installed_table {
    sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger} ON {table}"))
      .execute(&pool)
      .await
      .expect("clean owned gate trigger");
  }
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {function}()"))
    .execute(&pool)
    .await
    .expect("clean owned gate function");
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1")
    .bind(owner)
    .execute(&pool)
    .await
    .expect("clean own audit rows");
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[async_trait::async_trait]
impl myoxus_application::mcp::McpIdempotencyRepository for ExpireFirstDocumentAdmission {
  fn document_transaction_recovery(&self) -> bool {
    true
  }
  async fn begin(
    &self,
    row_id: Uuid,
    key_id: Uuid,
    user_id: Uuid,
    tool: &str,
    key: &str,
    hash: &str,
    document_payload_format: i16,
  ) -> myoxus_application::auth::AuthResult<myoxus_application::mcp::McpIdempotencyAdmission> {
    use myoxus_application::mcp::McpIdempotencyAdmission;
    let result = myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(self.pool.clone())
      .begin(row_id, key_id, user_id, tool, key, hash, document_payload_format)
      .await?;
    if matches!(result, McpIdempotencyAdmission::Started { .. }) && self.first.swap(false, Ordering::SeqCst) {
      sqlx::query("UPDATE mcp_idempotency_keys SET lease_until=now()-interval '1 second' WHERE id=$1")
        .bind(row_id)
        .execute(&self.pool)
        .await
        .map_err(|e| myoxus_application::auth::AuthError::Storage(e.to_string()))?;
    }
    Ok(result)
  }
  async fn complete(&self, row_id: Uuid, response: &Value) -> myoxus_application::auth::AuthResult<bool> {
    myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(self.pool.clone())
      .complete(row_id, response)
      .await
  }
  async fn abort(&self, row_id: Uuid) -> myoxus_application::auth::AuthResult<()> {
    myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(self.pool.clone())
      .abort(row_id)
      .await
  }
}

async fn document_write_effect_counts(pool: &sqlx::PgPool, workspace: Uuid) -> (i64, i64, i64, i64, i64) {
  sqlx::query_as("SELECT
    (SELECT count(*) FROM docs WHERE workspace_id=$1),
    (SELECT count(*) FROM doc_updates WHERE workspace_id=$1),
    (SELECT count(*) FROM doc_histories WHERE workspace_id=$1),
    (SELECT count(*) FROM outbox_events WHERE payload->>'workspaceId'=$1::text),
    (SELECT count(*) FROM admin_audit_log WHERE metadata->>'workspace_id'=$1::text AND category='mcp' AND metadata->>'outcome'='success')")
    .bind(workspace).fetch_one(pool).await.expect("count isolated document effects")
}

#[tokio::test]
async fn inv_mcp_document_write_recovery_is_atomic_fenced_and_authenticated() {
  use futures_util::FutureExt;
  use myoxus_application::mcp::{McpDocumentWriteReplay, with_mcp_document_write};
  use sqlx::Connection;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "mcp-write-crash-recovery").await;
  let workspace = create_workspace(&pool, owner).await;
  let suffix = Uuid::new_v4().simple().to_string();
  let function = format!("mcp_receipt_fault_{suffix}");
  let trigger = format!("mcp_receipt_fault_trigger_{suffix}");
  let mut pending_task: Option<tokio::task::JoinHandle<Value>> = None;
  let mut writer_pid = None;
  let outcome=std::panic::AssertUnwindSafe(async {
    let token=document_read_key(&key_app,session,&["read:docs","write:docs"]).await;
    let read_token=document_read_key(&key_app,session,&["read:docs"]).await;
    let mut interrupted_state=observed_tool_state(&pool).0;
    interrupted_state.idempotency=Arc::new(ExpireFirstDocumentAdmission {pool:pool.clone(),first:AtomicBool::new(true)});
    let docs=interrupted_state.doc_service.clone();
    let interrupted_app=document_read_router(&pool,interrupted_state);
    // Keep the diagnostic gate outside the two-connection application pool;
    // its second connection must remain available for authenticated retries.
    let mut gate_connection=sqlx::PgConnection::connect_with(pool.connect_options().as_ref()).await.expect("owned diagnostic connection");
    let mut gate=gate_connection.begin().await.expect("own root-lock transaction");
    let holder:i32=sqlx::query_scalar("SELECT pg_backend_pid()")
      .fetch_one(&mut *gate).await.expect("own lock-holder PID");
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(format!("workspace-document:{workspace}:{workspace}"))
      .execute(&mut *gate).await.expect("hold only this fixture's root");
    let args=json!({"workspace_id":workspace,"title":"Recovered before commit","idempotency_key":"crash-before-commit"});
    let task_app=interrupted_app.clone();let task_token=token.clone();let task_args=args.clone();
    pending_task=Some(tokio::spawn(async move {
      document_read_rpc(&task_app,&task_token,"tools/call",json!({"name":"create_page","arguments":task_args})).await
    }));
    let (old_row,key_id)=tokio::time::timeout(std::time::Duration::from_secs(10),async {
      loop {
        let pid:Option<i32>=sqlx::query_scalar("SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
          AND query LIKE 'SELECT pg_advisory_xact_lock%'")
          .bind(holder).fetch_optional(&pool).await.expect("identify owned blocked writer");
        if let Some(pid)=pid {
          writer_pid=Some(pid);
          break sqlx::query_as::<_,(Uuid,Uuid)>("SELECT id,api_key_id FROM mcp_idempotency_keys
            WHERE user_id=$1 AND tool_name='create_page' AND idempotency_key='crash-before-commit'
            AND recovery_enabled AND NOT mutation_committed AND response_json IS NULL AND lease_until<now()")
            .bind(owner).fetch_one(&pool).await.expect("persisted expired pre-commit admission");
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
      }
    }).await.expect("writer must reach the real locked transaction");
    let before=document_write_effect_counts(&pool,workspace).await;
    let mut recovered_state=observed_tool_state(&pool).0;
    recovered_state.idempotency=Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let app=document_read_router(&pool,recovered_state);
    let overlap=tokio::time::timeout(std::time::Duration::from_secs(3),document_read_rpc(
      &app,&token,"tools/call",json!({"name":"create_page","arguments":args}))).await
      .expect("overlap must be bounded even while the writer holds its ledger row");
    assert_eq!(overlap["result"]["isError"],true);
    assert_eq!(overlap["result"]["structuredContent"]["code"],"CONFLICT");
    assert_eq!(overlap["result"]["structuredContent"]["retryable"],true);
    assert_eq!(document_write_effect_counts(&pool,workspace).await,before);

    // Lose the caller and terminate its exact blocked database backend. This
    // rolls back a real transaction, while its separately admitted key survives.
    let task=pending_task.take().expect("owned request task");task.abort();
    assert!(task.await.expect_err("caller must be cancelled").is_cancelled());
    let killed:bool=sqlx::query_scalar("SELECT pg_terminate_backend($1)")
      .bind(writer_pid.expect("owned writer PID")).fetch_one(&pool).await.expect("terminate only owned backend");
    assert!(killed);writer_pid=None;gate.rollback().await.expect("release owned root gate");
    let created=document_read_call(&app,&token,"create_page",args.clone()).await;
    let new_row:Uuid=sqlx::query_scalar("SELECT id FROM mcp_idempotency_keys WHERE user_id=$1 AND idempotency_key='crash-before-commit'")
      .bind(owner).fetch_one(&pool).await.expect("recovered admission ID");
    assert_ne!(new_row,old_row,"recovery must rotate the writer fence");
    let committed=document_write_effect_counts(&pool,workspace).await;
    assert_eq!(committed.0,before.0+1);
    assert_eq!(committed.4,before.4+1,"successful creation emits one real mutation audit");
    assert_eq!(document_read_call(&app,&token,"create_page",args).await,created);
    assert_eq!(document_write_effect_counts(&pool,workspace).await,committed);
    let old_writer=with_mcp_document_write(McpDocumentWriteReplay {
      row_id:old_row,api_key_id:key_id,user_id:owner,response:Arc::new(|_|Ok(json!({"unreachable":true}))),
    },docs.create_page_lifecycle(workspace,owner,Some("Must not duplicate".into()),None)).await;
    assert!(matches!(old_writer,Err(myoxus_application::auth::AuthError::InvalidInput(code)) if code=="MIX_MCP_IDEMPOTENCY_WRITER_FENCED"));
    assert_eq!(document_write_effect_counts(&pool,workspace).await,committed);

    // The first receipt update belongs to the document transaction and passes.
    // Its post-commit acknowledgement update fails persistently at the SQL
    // boundary, including after rebuilding the application/router below.
    sqlx::query(&format!("CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.mutation_committed AND NEW.user_id='{owner}'::uuid THEN
        RAISE EXCEPTION 'owned post-commit acknowledgement interrupted'; END IF; RETURN NEW; END $$"))
      .execute(&pool).await.expect("install owned acknowledgement fault");
    sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE UPDATE ON mcp_idempotency_keys
      FOR EACH ROW EXECUTE FUNCTION {function}()"))
      .execute(&pool).await.expect("install owned ledger trigger");
    let recover=|name:&'static str,args:Value| {
      let app=&app;let pool=&pool;let token=&token;
      async move {
        let failed=document_read_rpc(app,token,"tools/call",json!({"name":name,"arguments":args})).await;
        assert_eq!(failed["result"]["isError"],true);
        assert_eq!(failed["result"]["structuredContent"]["code"],"RECOVERY_REQUIRED");
        assert_eq!(failed["result"]["structuredContent"]["retryable"],true);
        let response:Value=sqlx::query_scalar("SELECT response_json FROM mcp_idempotency_keys
          WHERE user_id=$1 AND tool_name=$2 AND idempotency_key=$3 AND mutation_committed")
          .bind(owner).bind(name).bind(args["idempotency_key"].as_str().expect("key"))
          .fetch_one(pool).await.expect("atomic committed receipt survives failed acknowledgement");
        let receipt:Value=serde_json::from_str(response["content"][0]["text"].as_str().expect("receipt payload")).expect("receipt JSON");
        let counts=document_write_effect_counts(pool,workspace).await;
        let mut restarted=observed_tool_state(pool).0;
        restarted.idempotency=Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
        let restarted=document_read_router(pool,restarted);
        let replay=document_read_call(&restarted,token,name,args.clone()).await;
        assert_eq!(replay,receipt,"recovery must return the exact committed outcome");
        assert_eq!(document_write_effect_counts(pool,workspace).await,counts,"replay must not add updates/history/outbox");
        replay
      }
    };
    let created=recover("create_page",json!({"workspace_id":workspace,"title":"After-commit source",
      "content_markdown":"# Heading\n\nKeep **bold neighbor** café 😀.\n\nUntouched tail.","idempotency_key":"crash-after-create"})).await;
    let external=created["externalId"].as_str().expect("external key");
    let doc=Uuid::parse_str(external).expect("created external UUID");
    let read=document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":external,"representation":"structured"})).await;
    let block=read["document"]["blocks"].as_array().expect("blocks").iter().find(|b|b.to_string().contains("Keep")).expect("target paragraph")["blockId"].as_str().expect("block ID");
    let patch=json!({"workspace_id":workspace,"external_id":format!(" {external} "),"operation":"edit_text","block_id":block,
      "start":0,"end":4,"replacement":"Kept","expected_revision":read["revision"],"idempotency_key":"crash-after-patch"});
    let patched=recover("doc_patch",patch.clone()).await;
    assert_eq!(patched["readback"]["status"],"unavailable");
    assert_eq!(patched["externalId"],external,"recovery preserves accepted identity normalization");
    let mut normalized_patch=patch.clone();normalized_patch["external_id"]=json!(external);
    assert_eq!(document_read_call(&app,&token,"doc_patch",normalized_patch).await,patched,"semantic replay accepts the normalized identity");
    let now=document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":external})).await;
    assert!(now.to_string().contains("Kept"));assert!(now.to_string().contains("bold neighbor"));assert!(now.to_string().contains("Untouched tail."));
    let mut conflict=patch.clone();conflict["replacement"]=json!("Different");
    let rejected=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":conflict})).await;
    assert_eq!(rejected["result"]["structuredContent"]["code"],"CONFLICT");
    assert_eq!(rejected["result"]["structuredContent"]["retryable"],false);
    let denied=document_read_rpc(&app,&read_token,"tools/call",json!({"name":"doc_patch","arguments":patch})).await;
    assert_eq!(denied["result"]["structuredContent"]["code"],"SCOPE_DENIED");
    sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.expect("revoke current document write permission");
    let denied=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":patch})).await;
    assert_eq!(denied["result"]["isError"],true,"replay must check current document access");
    sqlx::query("UPDATE workspace_memberships SET role='Owner' WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(owner).execute(&pool).await.expect("restore fixture write permission");
    recover("doc_patch",json!({"workspace_id":workspace,"external_id":external,"operation":"update_title",
      "title":"Renamed exact outcome","expected_revision":patched["revision"],"idempotency_key":"crash-after-rename"})).await;
    let current=document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":external})).await;
    let replaced=recover("update_doc",json!({"workspace_id":workspace,"external_id":external,"content_markdown":"# Replacement\n\nRecovered new content.",
      "confirm_replace_all":true,"expected_revision":current["revision"],"idempotency_key":"crash-after-replace"})).await;
    let history:i64=replaced["recoveryHistoryId"].as_i64().expect("recovery history ID");
    let snapshot:Vec<u8>=sqlx::query_scalar("SELECT snapshot FROM doc_histories WHERE id=$1 AND doc_id=$2")
      .bind(history).bind(doc).fetch_one(&pool).await.expect("exact pre-replace snapshot");
    assert!(myoxus_public_render::document_from_yjs(workspace,doc,"History","Private",&snapshot)
      .expect("native recovery extraction").document.blocks.iter().any(|b|format!("{b:?}").contains("Kept")));
    recover("delete_page",json!({"workspace_id":workspace,"external_id":external,"idempotency_key":"crash-after-trash"})).await;
    recover("restore_page",json!({"workspace_id":workspace,"external_id":external,"idempotency_key":"crash-after-restore"})).await;
    let final_read=document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":external})).await;
    assert!(final_read.to_string().contains("Recovered new content."));
  }).catch_unwind().await;
  if let Some(task) = pending_task {
    task.abort();
    let result = task.await;
    assert!(result.is_err(), "owned abandoned request must be stopped");
  }
  if let Some(pid) = writer_pid {
    sqlx::query("SELECT pg_terminate_backend($1)")
      .bind(pid)
      .execute(&pool)
      .await
      .expect("clean owned blocked backend");
  }
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger} ON mcp_idempotency_keys"))
    .execute(&pool)
    .await
    .expect("remove owned ledger trigger");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {function}()"))
    .execute(&pool)
    .await
    .expect("remove owned fault function");
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1")
    .bind(owner)
    .execute(&pool)
    .await
    .expect("remove owned audit fixtures");
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_parallel_page_retries_admit_one_mutation() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-parallel-create").await;
  let workspace = create_workspace(&pool, user).await;
  let mut state = build_tool_state(&pool);
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
  let auth = auth_context(user);
  persist_auth_key(&pool, &auth).await;
  let params = json!({
    "workspace_id": workspace,
    "title": "Created exactly once",
    "idempotency_key": "parallel-create-page",
  });
  let docs_before: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1")
    .bind(workspace)
    .fetch_one(&pool)
    .await
    .expect("count documents before parallel create");

  // Delay the first domain write after it has inserted its replay guard. A
  // trigger keeps the small integration-test connection pool available for
  // the concurrent admission probe and does not add a production test hook.
  sqlx::query(
    "CREATE OR REPLACE FUNCTION mcp_test_delay_doc_insert() RETURNS trigger
       LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$",
  )
  .execute(&pool)
  .await
  .expect("create document-insert delay function");
  sqlx::query(
    "CREATE TRIGGER mcp_test_delay_doc_insert_trigger
       BEFORE INSERT ON docs FOR EACH ROW
       EXECUTE FUNCTION mcp_test_delay_doc_insert()",
  )
  .execute(&pool)
  .await
  .expect("create document-insert delay trigger");
  let first_state = state.clone();
  let first_auth = auth.clone();
  let first_params = params.clone();
  let first = tokio::spawn(async move { dispatch_tool("create_page", &first_params, &first_auth, &first_state).await });

  let mut pending_seen = false;
  for _ in 0..100 {
    let pending: i64 = sqlx::query_scalar(
      "SELECT count(*) FROM mcp_idempotency_keys
       WHERE api_key_id = $1 AND tool_name = 'create_page'
         AND idempotency_key = 'parallel-create-page' AND response_json IS NULL",
    )
    .bind(auth.key_id)
    .fetch_one(&pool)
    .await
    .expect("poll pending idempotency row");
    if pending == 1 {
      pending_seen = true;
      break;
    }
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
  }
  assert!(
    pending_seen,
    "first call must publish its pending guard before mutation"
  );

  let concurrent = dispatch_tool("create_page", &params, &auth, &state)
    .await
    .expect_err("overlapping retry must not execute a second mutation");
  assert_eq!(concurrent.0, -32010);
  assert!(concurrent.1.contains("MIX_MCP_IDEMPOTENCY_IN_PROGRESS"));

  let first_result = first
    .await
    .expect("parallel create task must complete")
    .expect("admitted create must succeed");
  let replay = dispatch_tool("create_page", &params, &auth, &state)
    .await
    .expect("retry after completion must replay");
  assert_eq!(replay, first_result);
  let docs_after: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1")
    .bind(workspace)
    .fetch_one(&pool)
    .await
    .expect("count documents after parallel create");
  assert_eq!(docs_after, docs_before + 1, "parallel retry must create one page");

  sqlx::query("DROP TRIGGER mcp_test_delay_doc_insert_trigger ON docs")
    .execute(&pool)
    .await
    .expect("drop document-insert delay trigger");
  sqlx::query("DROP FUNCTION mcp_test_delay_doc_insert()")
    .execute(&pool)
    .await
    .expect("drop document-insert delay function");

  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_update_doc_replace_all_is_confirmed_recoverable_and_retry_safe() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-replace-all").await;
  let workspace = create_workspace(&pool, user).await;
  let mut state = build_tool_state(&pool);
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
  let auth = auth_context(user);
  persist_auth_key(&pool, &auth).await;

  let created = dispatch_tool(
    "create_page",
    &json!({
      "workspace_id": workspace,
      "title": "Replace target",
      "content_markdown": "## Original\n\nKeep as recovery evidence",
    }),
    &auth,
    &state,
  )
  .await
  .expect("create replacement target");
  let doc_id = parse_created_doc_id(&created);
  let params = json!({
    "workspace_id": workspace,
    "external_id": doc_id,
    "idempotency_key": "replace-all-once",
    "confirm_replace_all": true,
    "fragment": {
      "schemaVersion": "myoxus.document-fragment.v1",
      "blocks": [
        { "kind": "heading", "level": 2, "spans": [{ "text": "Replacement", "bold": true }] },
        { "kind": "paragraph", "spans": [{ "text": "New body" }] }
      ]
    }
  });
  let replaced = dispatch_tool("update_doc", &params, &auth, &state)
    .await
    .expect("confirmed replace_all must succeed");
  let payload = parse_tool_text_json(&replaced);
  assert_eq!(payload["operation"], "replace_all");
  let history_id = payload["recoveryHistoryId"]
    .as_i64()
    .expect("replace_all must return its recovery history id");
  let recovery: Vec<u8> = sqlx::query_scalar("SELECT snapshot FROM doc_histories WHERE id = $1 AND doc_id = $2")
    .bind(history_id)
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("atomic recovery history must exist");
  let recovery_text = yjs::extract_text_from_yjs(&recovery).expect("decode recovery history");
  assert!(recovery_text.markdown.contains("Keep as recovery evidence"));

  let update_count: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count updates");
  let mut equivalent_params = params.clone();
  equivalent_params["fragment"]["blocks"][1]["spans"][0]["bold"] = json!(false);
  equivalent_params["fragment"]["blocks"][1]["spans"][0]["italic"] = json!(false);
  equivalent_params["fragment"]["blocks"][1]["spans"][0]["strike"] = json!(false);
  equivalent_params["fragment"]["blocks"][1]["spans"][0]["code"] = json!(false);
  equivalent_params["fragment"]["blocks"][1]["spans"][0]["link"] = Value::Null;
  assert_eq!(
    dispatch_tool("update_doc", &equivalent_params, &auth, &state)
      .await
      .unwrap(),
    replaced,
    "typed canonicalization must replay semantically identical default marks"
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
    update_count,
    "idempotent replay must not create a second delta"
  );
  let mut changed_marks = equivalent_params.clone();
  changed_marks["fragment"]["blocks"][1]["spans"][0]["bold"] = json!(true);
  let mark_conflict = dispatch_tool("update_doc", &changed_marks, &auth, &state)
    .await
    .expect_err("different rich-text marks must not share a payload hash");
  assert!(mark_conflict.1.contains("MIX_MCP_IDEMPOTENCY_CONFLICT"));
  let mut changed_order = equivalent_params;
  changed_order["fragment"]["blocks"]
    .as_array_mut()
    .expect("fragment blocks")
    .reverse();
  let order_conflict = dispatch_tool("update_doc", &changed_order, &auth, &state)
    .await
    .expect_err("different block order must not share a payload hash");
  assert!(order_conflict.1.contains("MIX_MCP_IDEMPOTENCY_CONFLICT"));

  let read = dispatch_tool(
    "read_doc",
    &json!({ "workspace_id": workspace, "external_id": doc_id }),
    &auth,
    &state,
  )
  .await
  .expect("read replaced document");
  let read = parse_tool_text_json(&read);
  assert_eq!(read["schemaVersion"], "myoxus.document-projection.v1");
  let blocks = read["document"]["blocks"].to_string();
  assert!(blocks.contains("Replacement") && blocks.contains("New body"));
  assert!(!blocks.contains("Keep as recovery evidence"));

  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_parallel_semantic_mutations_converge_and_stale_targets_fail_atomically() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-parallel-mutations").await;
  let workspace = create_workspace(&pool, user).await;
  let mut state = build_tool_state(&pool);
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
  let auth = auth_context(user);
  persist_auth_key(&pool, &auth).await;
  let created = dispatch_tool(
    "create_page",
    &json!({
      "workspace_id": workspace,
      "title": "Parallel target",
      "content_markdown": "## Alpha\n\nOld A\n\n## Beta\n\nOld B",
    }),
    &auth,
    &state,
  )
  .await
  .expect("create parallel target");
  let doc_id = parse_created_doc_id(&created);

  let alpha = json!({
    "workspace_id": workspace, "external_id": doc_id, "operation": "replace_heading_section",
    "heading": "Alpha", "idempotency_key": "parallel-alpha",
    "fragment": { "schemaVersion": "myoxus.document-fragment.v1", "blocks": [
      { "kind": "paragraph", "spans": [{ "text": "New A" }] }
    ] }
  });
  let beta = json!({
    "workspace_id": workspace, "external_id": doc_id, "operation": "replace_heading_section",
    "heading": "Beta", "idempotency_key": "parallel-beta",
    "fragment": { "schemaVersion": "myoxus.document-fragment.v1", "blocks": [
      { "kind": "paragraph", "spans": [{ "text": "New B" }] }
    ] }
  });
  let (alpha_result, beta_result) = tokio::join!(
    dispatch_tool("doc_patch", &alpha, &auth, &state),
    dispatch_tool("doc_patch", &beta, &auth, &state)
  );
  alpha_result.expect("Alpha mutation must commit");
  beta_result.expect("Beta mutation must commit");

  let read = dispatch_tool(
    "read_doc",
    &json!({ "workspace_id": workspace, "external_id": doc_id }),
    &auth,
    &state,
  )
  .await
  .expect("read converged parallel document");
  let projection = parse_tool_text_json(&read);
  let blocks = projection["document"]["blocks"].as_array().expect("structured blocks");
  let wire = serde_json::to_string(blocks).unwrap();
  assert!(wire.contains("New A") && wire.contains("New B"));
  let target_id = blocks
    .iter()
    .find(|block| block["kind"] == "paragraph" && block.to_string().contains("New A"))
    .and_then(|block| block["blockId"].as_str())
    .expect("stable paragraph block id")
    .to_string();
  let updates_before_race: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let race = |key: &str, text: &str| {
    json!({
      "workspace_id": workspace, "external_id": doc_id, "operation": "replace_block",
      "block_id": target_id.clone(), "idempotency_key": key,
      "fragment": { "schemaVersion": "myoxus.document-fragment.v1", "blocks": [
        { "kind": "paragraph", "spans": [{ "text": text }] }
      ] }
    })
  };
  let left = race("same-target-left", "Left won");
  let right = race("same-target-right", "Right won");
  let (left_result, right_result) = tokio::join!(
    dispatch_tool("doc_patch", &left, &auth, &state),
    dispatch_tool("doc_patch", &right, &auth, &state)
  );
  assert_eq!(usize::from(left_result.is_ok()) + usize::from(right_result.is_ok()), 1);
  let conflict = left_result.err().or_else(|| right_result.err()).expect("one conflict");
  assert_eq!(conflict.0, -32004);
  let updates_after_race: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    updates_after_race,
    updates_before_race + 1,
    "stale target must not partially write"
  );

  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_compat_semantic_mutation_and_rich_clients_converge_after_reconnect() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-rich-client-convergence").await;
  let workspace = create_workspace(&pool, user).await;
  let mut state = build_tool_state(&pool);
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
  let auth = auth_context(user);
  persist_auth_key(&pool, &auth).await;

  let created = dispatch_tool(
    "create_page",
    &json!({
      "workspace_id": workspace,
      "title": "Client convergence target",
      "content_markdown": "## MCP section\n\nOriginal MCP body\n\n## Rich-client section\n\nOriginal rich-client body",
    }),
    &auth,
    &state,
  )
  .await
  .expect("create convergence target");
  let doc_id = parse_created_doc_id(&created);
  let external_id: String = sqlx::query_scalar("SELECT external_id FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("load client-visible document key");
  let document_key = DocumentKey::parse(external_id).expect("client-visible document key must be valid");
  let baseline = state
    .doc_service
    .load_full_doc(workspace, doc_id)
    .await
    .expect("load baseline for rich-client diff");
  let rich_client_update = rich_client_append_paragraph_update(&baseline, "Concurrent rich-client paragraph");
  let updates_before: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count baseline updates");
  let outbox_before: i64 = sqlx::query_scalar(
    "SELECT count(*) FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'workspace_doc_broadcast'",
  )
  .bind(doc_id.to_string())
  .fetch_one(&pool)
  .await
  .expect("count baseline broadcast rows");
  let mcp_patch = json!({
    "workspace_id": workspace,
    "external_id": doc_id,
    "operation": "replace_heading_section",
    "heading": "MCP section",
    "idempotency_key": "mcp-rich-client-convergence-once",
    "fragment": {
      "schemaVersion": "myoxus.document-fragment.v1",
      "blocks": [{ "kind": "paragraph", "spans": [{ "text": "Concurrent MCP paragraph" }] }]
    }
  });

  let client_write = state.doc_service.push_external_update_with_context(
    Uuid::new_v4(),
    Some(DocSyncConnectionContext {
      client_kind: DocSyncClientKind::Web,
    }),
    workspace,
    document_key,
    rich_client_update,
    chrono::Utc::now().timestamp_millis(),
    DocSpaceKind::Workspace,
    Some(user),
    Some("myoxus-native".to_string()),
    None,
    None,
  );
  let (client_result, mcp_result) = tokio::join!(client_write, dispatch_tool("doc_patch", &mcp_patch, &auth, &state));
  assert!(
    client_result
      .expect("rich-client push must complete")
      .outcome
      .is_persisted(),
    "rich-client delta must be persisted"
  );
  mcp_result.expect("parallel MCP mutation must commit");

  let reconnected_state = state
    .doc_service
    .load_full_doc(workspace, doc_id)
    .await
    .expect("reconnect must load the fully merged document state");
  let reconnected_text = yjs::extract_text_from_yjs(&reconnected_state)
    .expect("reconnected state must remain a valid canonical document")
    .markdown;
  assert!(
    reconnected_text.contains("Concurrent rich-client paragraph"),
    "rich-client update must survive MCP mutation: {reconnected_text}"
  );
  assert!(
    reconnected_text.contains("Concurrent MCP paragraph"),
    "MCP update must survive rich-client update: {reconnected_text}"
  );
  assert!(
    reconnected_text.contains("Original rich-client body"),
    "the unrelated rich-client section must survive: {reconnected_text}"
  );
  assert!(
    !reconnected_text.contains("Original MCP body"),
    "the targeted heading body must be replaced: {reconnected_text}"
  );

  // Two reconnecting rich clients must materialize the identical canonical
  // state; MCP has no parallel revision or Markdown synchronization model.
  let first_client = Doc::new();
  first_client
    .transact_mut()
    .apply_update(Update::decode_v1(&reconnected_state).expect("first client decodes state"))
    .expect("first client applies state");
  let second_client = Doc::new();
  second_client
    .transact_mut()
    .apply_update(Update::decode_v1(&reconnected_state).expect("second client decodes state"))
    .expect("second client applies state");
  let first_state = first_client
    .transact()
    .encode_state_as_update_v1(&yrs::StateVector::default());
  let second_state = second_client
    .transact()
    .encode_state_as_update_v1(&yrs::StateVector::default());
  assert_eq!(first_state, second_state, "reconnected rich clients must converge");

  let updates_after: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count converged updates");
  assert_eq!(
    updates_after,
    updates_before + 2,
    "both writers must commit exactly once"
  );
  let outbox_after: i64 = sqlx::query_scalar(
    "SELECT count(*) FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'workspace_doc_broadcast'",
  )
  .bind(doc_id.to_string())
  .fetch_one(&pool)
  .await
  .expect("count converged broadcast rows");
  assert_eq!(
    outbox_after,
    outbox_before + 2,
    "each persisted update must have exactly one fanout event"
  );

  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_document_broadcast_outbox_retries_before_marking_processed() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let (user, _) = helpers::seed_user(&pool, &auth_store, "mcp-broadcast-outbox-retry").await;
  let workspace = create_workspace(&pool, user).await;
  let mut state = build_tool_state(&pool);
  state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
  let auth = auth_context(user);
  persist_auth_key(&pool, &auth).await;
  let created = dispatch_tool(
    "create_page",
    &json!({
      "workspace_id": workspace,
      "title": "Broadcast retry target",
      "content_markdown": "## Retry\n\nOriginal",
    }),
    &auth,
    &state,
  )
  .await
  .expect("create broadcast retry target");
  let doc_id = parse_created_doc_id(&created);
  let patched = dispatch_tool(
    "doc_patch",
    &json!({
      "workspace_id": workspace,
      "external_id": doc_id,
      "operation": "append_to_heading",
      "heading": "Retry",
      "idempotency_key": "broadcast-retry-once",
      "fragment": {
        "schemaVersion": "myoxus.document-fragment.v1",
        "blocks": [{ "kind": "paragraph", "spans": [{ "text": "Persisted for delivery" }] }]
      }
    }),
    &auth,
    &state,
  )
  .await
  .expect("create broadcast event");
  let sequence = parse_tool_text_json(&patched)["sequence"]
    .as_i64()
    .expect("mutation sequence");
  let event_id: Uuid = sqlx::query_scalar(
    "SELECT id FROM outbox_events
     WHERE aggregate_id = $1 AND event_type = 'workspace_doc_broadcast'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(payload->'updates') AS update
         WHERE update->>'docId' = $1 AND (update->>'sequence')::bigint = $2
       )",
  )
  .bind(doc_id.to_string())
  .bind(sequence)
  .fetch_one(&pool)
  .await
  .expect("load mutation broadcast event");
  sqlx::query("UPDATE outbox_events SET created_at = '1970-01-01T00:00:00Z' WHERE id = $1")
    .bind(event_id)
    .execute(&pool)
    .await
    .expect("make fixture the next deterministic claim");
  let expected_update: Vec<u8> =
    sqlx::query_scalar("SELECT payload FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2 AND sequence = $3")
      .bind(workspace)
      .bind(doc_id)
      .bind(sequence)
      .fetch_one(&pool)
      .await
      .expect("load referenced update");
  let publisher = RecordingBroadcastPublisher {
    failures_remaining: AtomicUsize::new(1),
    ..Default::default()
  };

  assert!(
    process_next_workspace_doc_broadcast(&pool, &publisher).await.is_err(),
    "transport failure must fail the claim"
  );
  let processed_after_failure: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT processed_at FROM outbox_events WHERE id = $1")
      .bind(event_id)
      .fetch_one(&pool)
      .await
      .expect("read failed event marker");
  assert!(
    processed_after_failure.is_none(),
    "failed publish must remain pending for retry"
  );

  assert!(
    process_next_workspace_doc_broadcast(&pool, &publisher)
      .await
      .expect("retry must succeed"),
    "retry must claim the pending event"
  );
  let processed_after_retry: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT processed_at FROM outbox_events WHERE id = $1")
      .bind(event_id)
      .fetch_one(&pool)
      .await
      .expect("read successful event marker");
  assert!(
    processed_after_retry.is_some(),
    "successful publish must mark the event"
  );
  let deliveries = publisher.deliveries.lock().expect("recording publisher lock");
  assert_eq!(deliveries.len(), 1, "retry must publish the referenced update once");
  assert_eq!(deliveries[0], (workspace, doc_id.to_string(), expected_update, user));
  drop(deliveries);
  assert_eq!(
    *publisher.outcomes.lock().expect("broadcast outcomes"),
    ["failed", "replayed"]
  );

  helpers::cleanup_users(&pool, &[user]).await;
}

#[tokio::test]
async fn inv_mcp_compat_targeted_document_reads_keep_native_identity_bounds_and_live_acl() {
  use futures_util::FutureExt;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, owner_session) = helpers::seed_user(&pool, &auth_store, "selector-owner").await;
  let (external, external_session) = helpers::seed_user(&pool, &auth_store, "selector-external").await;
  let workspace = create_workspace(&pool, owner).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status,joined_at) VALUES($1,$2,'External','Accepted',now())")
      .bind(workspace).bind(external).execute(&pool).await.unwrap();
    let token = document_read_key(&key_app, owner_session, &["read:docs", "write:docs"]).await;
    let external_token = document_read_key(&key_app, external_session, &["read:docs"]).await;
    let state = build_tool_state(&pool);
    let prefix = (0..240).map(|i| format!("Unselected {i}")).collect::<Vec<_>>().join("\n\n");
    let markdown = format!("## Duplicate\n\nearly\n\n{prefix}\n\n## Duplicate\n\nlate secret body\n\n- Parent\n  - Nested secret target\n\n### Child\n\nchild body\n\n## Stop\n\nprotected end");
    let native = myoxus_application::markdown::prepare_markdown_import("Selectors", &markdown).unwrap();
    let (doc, _) = state.doc_service.create_page_from_snapshot_with_sync_updates(workspace, owner, Some("Selectors".into()), native.yjs_binary).await.unwrap();
    let payload = state.doc_service.load_full_doc(workspace, doc.id).await.unwrap();
    let ir = myoxus_public_render::document_from_yjs(workspace, doc.id, "Selectors", "Private", &payload).unwrap();
    let heading_ids = ir.document.blocks.iter().filter(|block| matches!(block, myoxus_public_render::Block::Heading { .. })).map(|block| block.block_id().to_string()).collect::<Vec<_>>();
    assert_eq!(heading_ids.len(), 4);
    let parent = ir.document.blocks.iter().find_map(|block| match block { myoxus_public_render::Block::List { list, .. } => Some(&list.items[0]), _ => None }).unwrap();
    let myoxus_public_render::Block::List { list, .. } = &parent.children[0] else { panic!("nested native list") };
    let nested_id = list.items[0].block_id.clone();
    let insecure_source = myoxus_application::markdown::prepare_markdown_import("Insecure image", "![Insecure](http://example.test/image.png)").unwrap();
    let (insecure_doc, _) = state.doc_service.create_page_from_snapshot_with_sync_updates(workspace, owner, Some("Insecure image".into()), insecure_source.yjs_binary).await.unwrap();
    let app = document_read_router(&pool, state);
    let base = json!({"workspace_id":workspace,"external_id":doc.external_id});
    let mut section_args = base.clone(); section_args["heading_block_id"] = json!(heading_ids[1]); section_args["limit"] = json!(2);
    let section = document_read_call(&app, &token, "read_doc", section_args.clone()).await;
    assert_eq!((*reading_block(&section, 0))["blockId"], heading_ids[1]);
    assert_eq!(section["document"]["blocks"].as_array().unwrap().len(), 2);
    assert_eq!(section["selection"]["complete"], false);
    assert!(!section["document"].to_string().contains("Unselected 239"));
    let cursor = section["page"]["nextCursor"].as_str().unwrap().to_string();
    let mut continuation = section_args.clone(); continuation["cursor"] = json!(cursor);
    let again = document_read_call(&app, &token, "read_doc", section_args.clone()).await;
    assert_eq!(again, section, "read repetition remains stable without mutations");
    let next = document_read_call(&app, &token, "read_doc", continuation.clone()).await;
    assert_ne!((*reading_block(&next, 0))["blockId"], (*reading_block(&section, 0))["blockId"]);
    let mut target = base.clone(); target["block_id"] = json!(nested_id); target["neighbor_context"] = json!(1); target["limit"] = json!(3);
    let nested = document_read_call(&app, &token, "read_doc", target.clone()).await;
    assert!(nested["document"]["blocks"].to_string().contains("Nested secret target"));
    assert_eq!(nested["selection"]["identities"][1]["parentIds"], json!([parent.block_id]));
    assert_eq!(nested["selection"]["identities"][1]["context"], false);
    assert_eq!(nested["selection"]["complete"], true);
    let outline = document_read_call(&app, &token, "read_doc", json!({"workspace_id":workspace,"external_id":doc.external_id,"outline":true,"limit":2})).await;
    assert_eq!(outline["selection"]["totalBlocks"], 4); assert_eq!(outline["selection"]["complete"], false);
    assert!(outline["document"]["blocks"].as_array().unwrap().iter().all(|block|block["kind"]=="heading"));
    for arguments in [section_args.clone(), target.clone(), continuation.clone()] {
      let denied = document_read_rpc(&app, &external_token, "tools/call", json!({"name":"read_doc","arguments":arguments})).await;
      assert_eq!(denied["result"]["isError"], true);
      assert!(!denied.to_string().contains("secret"));
    }
    sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) VALUES($1,$2,'Reader')").bind(external).bind(doc.id).execute(&pool).await.unwrap();
    assert_eq!(document_read_call(&app, &external_token, "read_doc", target.clone()).await, nested);
    sqlx::query("DELETE FROM doc_user_permissions WHERE user_id=$1 AND doc_id=$2").bind(external).bind(doc.id).execute(&pool).await.unwrap();
    let revoked = document_read_rpc(&app, &external_token, "tools/call", json!({"name":"read_doc","arguments":continuation})).await;
    assert_eq!(revoked["result"]["isError"], true); assert!(!revoked.to_string().contains("secret"));
    let mut missing = base.clone(); missing["block_id"] = json!("missing");
    let missing = document_read_rpc(&app, &token, "tools/call", json!({"name":"read_doc","arguments":missing})).await;
    assert!(missing.to_string().contains("BLOCK_NOT_FOUND"));
    let mut mismatch = section_args.clone(); mismatch["heading_block_id"] = json!(heading_ids[0]); mismatch["cursor"] = json!(cursor);
    let mismatch = document_read_rpc(&app, &token, "tools/call", json!({"name":"read_doc","arguments":mismatch})).await;
    assert!(mismatch.to_string().contains("CURSOR_STALE"));
    document_read_call(&app, &token, "doc_patch", json!({"workspace_id":workspace,"external_id":doc.external_id,"operation":"append_blocks","content_markdown":"New content","expected_revision":section["revision"],"idempotency_key":"selector-new-head"})).await;
    section_args["cursor"] = json!(cursor);
    let stale = document_read_rpc(&app, &token, "tools/call", json!({"name":"read_doc","arguments":section_args})).await;
    assert!(stale.to_string().contains("CURSOR_STALE"));
    let html = document_read_call(&app, &token, "read_doc", json!({"workspace_id":workspace,"external_id":doc.external_id,"representation":"html"})).await;
    assert_eq!(html["format"], "html"); assert!(html["data"].as_str().unwrap().contains("Nested secret target"));
    let insecure_whole = document_read_call(&app, &token, "read_doc", json!({"workspace_id":workspace,"external_id":insecure_doc.external_id})).await;
    let insecure_id = (*reading_block(&insecure_whole, 0))["blockId"].as_str().unwrap();
    sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) VALUES($1,$2,'Reader')").bind(external).bind(insecure_doc.id).execute(&pool).await.unwrap();
    let insecure_selected = document_read_call(&app, &external_token, "read_doc", json!({"workspace_id":workspace,"external_id":insecure_doc.external_id,"block_id":insecure_id})).await;
    assert!(insecure_selected["document"]["assets"].as_array().unwrap().is_empty());
    assert_eq!(insecure_selected["projection"]["diagnostics"], insecure_whole["projection"]["diagnostics"]);
    assert_eq!(insecure_selected["selection"]["complete"], false);
    assert_eq!((*reading_block(&insecure_selected, 0))["asset"]["source"], "");

  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner, external]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_compat_citation_workspace_identity_is_authorized_and_persisted_canonically() {
  use futures_util::FutureExt;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "citation-workspace").await;
  let (outsider, outsider_session) = helpers::seed_user(&pool, &auth_store, "citation-outsider").await;
  let workspace = create_workspace(&pool, owner).await;
  let target_workspace = create_workspace(&pool, owner).await;
  let denied_workspace = create_workspace(&pool, outsider).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    let token = document_read_key(&key_app, session, &["read:docs", "write:docs"]).await;
    let denied_token = document_read_key(&key_app, outsider_session, &["read:docs", "write:docs"]).await;
    let mut state = build_tool_state(&pool);
    state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let docs = state.doc_service.clone();
    let app = document_read_router(&pool, state);
    let target = document_read_call(&app, &token, "create_page", json!({"workspace_id":target_workspace,"title":"Target"})).await;
    let denied = document_read_call(&app, &denied_token, "create_page", json!({"workspace_id":denied_workspace,"title":"Denied"})).await;
    let created = document_read_call(&app, &token, "create_page", json!({"workspace_id":workspace,"title":"Citations","content_markdown":"Claim[^Ref].\n\n[^Ref]: {\"type\":\"url\",\"url\":\"https://example.test/source\"}"})).await;
    let external = created["externalId"].as_str().unwrap();
    let doc: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2").bind(workspace).bind(external).fetch_one(&pool).await.unwrap();
    let read = json!({"workspace_id":workspace,"external_id":external});
    let original = document_read_call(&app, &token, "read_doc", read.clone()).await;
    let before = document_write_effect_counts(&pool, workspace).await;
    let updates = load_doc_update_payloads(&pool, doc).await;
    for (index, value) in [Value::Null, json!(""), json!("  "), json!("invalid"), json!(false), json!(format!(" {target_workspace} ")), json!(denied_workspace)].into_iter().enumerate() {
      let reference = json!({"type":"doc","docId":if value == json!(denied_workspace) { &denied["externalId"] } else { &target["externalId"] },"workspaceId":value});
      let rejected = document_read_rpc(&app, &token, "tools/call", json!({"name":"doc_patch","arguments":{"workspace_id":workspace,"external_id":external,"operation":"update_citation","label":"Ref","reference":reference,"idempotency_key":format!("citation-invalid-workspace-{index}")}})).await;
      assert_eq!(rejected["result"]["isError"], true, "{rejected}");
      assert_eq!(document_write_effect_counts(&pool, workspace).await, before);
      assert_eq!(load_doc_update_payloads(&pool, doc).await, updates);
    }
    // Malformed optional fields must fail even beside an otherwise valid edit.
    for (index, extra) in [
      json!({"new_label":null}), json!({"new_label":false}), json!({"new_label":7}), json!({"new_label":[]}),
      json!({"reference":null}), json!({"reference":false}), json!({"reference":[]}),
      json!({"reference":{"type":"url","url":"https://example.test/new","unknown":"discarded"}}),
      json!({"reference":{"type":"url","url":"https://example.test/new","docId":"incompatible"}}),
      json!({"reference":{"type":"url","url":"https://example.test/new","title":5}}),
      json!({"reference":{"type":"doc","docId":target["externalId"],"workspaceId":target_workspace,"url":"https://example.test/incompatible"}}),
    ].into_iter().enumerate() {
      let mut arguments = json!({"workspace_id":workspace,"external_id":external,"operation":"update_citation","label":"Ref","new_label":"renamed","reference":{"type":"url","url":"https://example.test/new"},"idempotency_key":format!("citation-invalid-fields-{index}")});
      arguments.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
      let rejected = document_read_rpc(&app, &token, "tools/call", json!({"name":"doc_patch","arguments":arguments})).await;
      assert_eq!(rejected["result"]["isError"], true, "{rejected}");
      assert_eq!(document_write_effect_counts(&pool, workspace).await, before);
      assert_eq!(load_doc_update_payloads(&pool, doc).await, updates);
    }
    assert_eq!(document_read_call(&app, &token, "read_doc", read).await, original);
    let card = original["document"]["blocks"].as_array().unwrap().iter().find(|block| block["native"]["properties"].get("citation").is_some()).unwrap();
    for (index, properties) in [json!({"title":"Valid source title","latex":null}), json!({"url":"https://example.test/new","title":null})].into_iter().enumerate() {
      let rejected = document_read_rpc(&app, &token, "tools/call", json!({"name":"doc_patch","arguments":{"workspace_id":workspace,"external_id":external,"operation":"update_block_properties","block_id":card["blockId"],"properties":properties,"idempotency_key":format!("citation-invalid-card-{index}")}})).await;
      assert_eq!(rejected["result"]["isError"], true, "{rejected}");
      assert_eq!(document_write_effect_counts(&pool, workspace).await, before);
      assert_eq!(load_doc_update_payloads(&pool, doc).await, updates);
    }
    let mut patch = json!({"workspace_id":workspace,"external_id":external,"operation":"update_citation","label":"Ref","reference":{"type":"doc","docId":target["externalId"],"workspaceId":target_workspace.simple().to_string().to_uppercase()},"idempotency_key":"citation-workspace-canonical"});
    let changed = document_read_call(&app, &token, "doc_patch", patch.clone()).await;
    let counts = document_write_effect_counts(&pool, workspace).await;
    patch["reference"]["workspaceId"] = json!(target_workspace);
    assert_eq!(document_read_call(&app, &token, "doc_patch", patch).await, changed);
    assert_eq!(document_write_effect_counts(&pool, workspace).await, counts);
    let native = docs.load_full_doc(workspace, doc).await.unwrap();
    let fragment = serde_json::to_value(myoxus_application::doc::document_fragment_from_yjs(&native).unwrap()).unwrap();
    let spans = &fragment["blocks"][0]["spans"];
    let citation = spans.as_array().unwrap().iter().find(|span| span.get("footnote").is_some()).unwrap();
    assert_eq!(citation["footnote"]["reference"]["workspaceId"], json!(target_workspace));
    // Omission selects the document workspace but must remain omitted on disk.
    document_read_call(&app, &token, "doc_patch", json!({"workspace_id":workspace,"external_id":external,"operation":"update_citation","label":"Ref","reference":{"type":"doc","docId":external},"idempotency_key":"citation-workspace-omitted"})).await;
    let native = docs.load_full_doc(workspace, doc).await.unwrap();
    let fragment = serde_json::to_value(myoxus_application::doc::document_fragment_from_yjs(&native).unwrap()).unwrap();
    let citation = fragment["blocks"][0]["spans"].as_array().unwrap().iter().find(|span| span.get("footnote").is_some()).unwrap();
    assert!(citation["footnote"]["reference"].get("workspaceId").is_none());
  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace, target_workspace, denied_workspace]).await;
  helpers::cleanup_users(&pool, &[owner, outsider]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_compat_sourced_fragments_retain_native_identity_and_reject_destination_collisions() {
  use futures_util::FutureExt;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "sourced-fragments").await;
  let workspace = create_workspace(&pool, owner).await;
  let outcome=std::panic::AssertUnwindSafe(async {
    let token=document_read_key(&key_app,session,&["read:docs","write:docs"]).await;
    let mut state=build_tool_state(&pool);
    state.idempotency=Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let docs=state.doc_service.clone();
    let app=document_read_router(&pool,state);
    let source="Protected [neighbor](https://example.test/keep) 世界\n\nClaim[^Ref]. Again[^Ref]. Local[^local]. Local again[^local].\n\n> [!warning]- Grüße 世界\n> Folded body[^Ref].\n>\n> - First\n> - Second\n\n[^Ref]: {\"type\":\"url\",\"url\":\"https://example.test/evidence\",\"title\":\"証拠\"}\n[^local]: Supporting local text with [source](https://example.test/local).";
    let created=document_read_call(&app,&token,"create_page",json!({"workspace_id":workspace,"title":"Sourced 世界","content_markdown":source,"strict_loss":true,"idempotency_key":"sourced-create"})).await;
    assert!(created.get("normalizationDiagnostics").is_none(),"{created}");
    let external=created["externalId"].as_str().unwrap();
    let doc:Uuid=sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2").bind(workspace).bind(external).fetch_one(&pool).await.unwrap();
    let args=json!({"workspace_id":workspace,"external_id":external,"representation":"structured"});
    let original=document_read_call(&app,&token,"read_doc",args.clone()).await;
    let protected=(*reading_block(&original, 0)).clone();
    let native_before=docs.load_full_doc(workspace,doc).await.unwrap();
    let ir=myoxus_public_render::document_from_yjs(workspace,doc,"Sourced","Private",&native_before).unwrap();
    let callout=ir.document.blocks.iter().find(|block|matches!(block,myoxus_public_render::Block::Callout{..})).unwrap();
    let myoxus_public_render::Block::Callout {native_callout,children,..}=callout else {unreachable!()};
    assert_eq!(native_callout.kind.as_deref(),Some("warning"));assert_eq!(native_callout.title.as_deref(),Some("Grüße 世界"));
    assert_eq!(native_callout.foldable,Some(true));assert_eq!(native_callout.default_open,Some(false));
    let children=serde_json::to_string(children).unwrap();assert!(children.find("First").unwrap()<children.find("Second").unwrap());
    let normalized=myoxus_application::doc::document_fragment_from_yjs(&native_before).unwrap();
    let normalized=serde_json::to_value(normalized).unwrap();
    assert!(normalized.to_string().contains("https://example.test/evidence"));
    assert!(normalized.to_string().contains("definitionId"));
    let append=json!({"workspace_id":workspace,"external_id":external,"operation":"append_blocks","expected_revision":original["revision"],"strict_loss":true,"idempotency_key":"sourced-append","content_markdown":"New claim[^ref]. Repeated[^ref].\n\n[^ref]: {\"type\":\"url\",\"url\":\"https://example.test/evidence\",\"title\":\"証拠\"}"});
    document_read_call(&app,&token,"doc_patch",append).await;
    let current=document_read_call(&app,&token,"read_doc",args.clone()).await;
    assert_eq!((*reading_block(&current, 0)),protected);
    for block in original["document"]["blocks"].as_array().unwrap() {
      assert_eq!(current["document"]["blocks"].as_array().unwrap().iter().find(|candidate|candidate["blockId"]==block["blockId"]).unwrap(),block);
    }
    // Structured reading places definitions after body content. Protect actual
    // native note order rather than confusing presentation order with mutation.
    let (note,original_order)=ir.native_children.iter().find(|(_,children)|children.contains(&protected["blockId"].as_str().unwrap().to_string())).unwrap();
    let current_payload=docs.load_full_doc(workspace,doc).await.unwrap();
    let current_ir=myoxus_public_render::document_from_yjs(workspace,doc,"Sourced","Private",&current_payload).unwrap();
    assert_eq!(&current_ir.native_children[note][..original_order.len()],original_order.as_slice());
    for block in &ir.document.blocks {assert_eq!(current_ir.document.blocks.iter().find(|candidate|candidate.block_id()==block.block_id()).unwrap(),block);}
    for (id,reference) in &ir.native_citations {assert_eq!(&current_ir.native_citations[id],reference);}
    let native=docs.load_full_doc(workspace,doc).await.unwrap();
    let exported=myoxus_application::markdown::yjs_to_markdown(&native).unwrap().unwrap();
    assert_eq!(exported.markdown.matches("[^Ref]").count()+exported.markdown.matches("[^ref]").count(),6);
    assert_eq!(exported.markdown.matches("[^local]").count(),3);
    assert!(exported.markdown.contains("[!warning]- Grüße 世界"));
    let before=document_write_effect_counts(&pool,workspace).await;
    let persisted=load_doc_update_payloads(&pool,doc).await;
    for (key,fragment) in [
      ("typed-collision",json!({"schemaVersion":"myoxus.document-fragment.v1","blocks":[{"kind":"paragraph","spans":[{"text":" ","footnote":{"label":"REF","reference":{"type":"url","url":"https://example.test/redirect"}}}]}]})),
      ("card-collision",json!({"schemaVersion":"myoxus.document-fragment.v1","blocks":[{"kind":"citation_definition","label":"ref","reference":{"type":"url","url":"https://example.test/redirect"}}]})),
      ("dangling-local",json!({"schemaVersion":"myoxus.document-fragment.v1","blocks":[{"kind":"paragraph","spans":[{"text":" ","footnote":{"label":"local","definitionId":"missing"}}]}]})),
      ("duplicate-local",json!({"schemaVersion":"myoxus.document-fragment.v1","blocks":[{"kind":"footnote_definition","definitionId":"new-local","label":"LOCAL","children":[{"kind":"paragraph","spans":[{"text":"redirect"}]}]}]})),
    ] {
      let rejected=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":{"workspace_id":workspace,"external_id":external,"operation":"append_blocks","fragment":fragment,"expected_revision":current["revision"],"idempotency_key":key}})).await;
      assert_eq!(rejected["result"]["isError"],true,"{key}: {rejected}");
      assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
      assert_eq!(load_doc_update_payloads(&pool,doc).await,persisted,"rejected input cannot change durable native updates");
      assert_eq!(document_read_call(&app,&token,"read_doc",args.clone()).await,current);
    }
    let replace=document_read_rpc(&app,&token,"tools/call",json!({"name":"update_doc","arguments":{"workspace_id":workspace,"external_id":external,"confirm_replace_all":true,"expected_revision":current["revision"],"idempotency_key":"replacement-collision","content_markdown":"Redirected claim[^ref].\n\n[^ref]: {\"type\":\"url\",\"url\":\"https://example.test/redirect\"}"}})).await;
    assert_eq!(replace["result"]["isError"],true,"replacement must inspect the destination before removing old claims");
    assert_eq!(document_write_effect_counts(&pool,workspace).await,before);
    assert_eq!(document_read_call(&app,&token,"read_doc",args).await,current);

  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_compat_native_block_conversion_preserves_children_and_replays_actual_replacements() {
  use futures_util::FutureExt;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "native-conversion").await;
  let workspace = create_workspace(&pool, owner).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    let token = document_read_key(&key_app, session, &["read:docs", "write:docs"]).await;
    let mut state = observed_tool_state(&pool).0;
    state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let app = document_read_router(&pool, state);
    let tools = document_read_rpc(&app, &token, "tools/list", json!({})).await;
    let schema = tools["result"]["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == "doc_patch").unwrap()["inputSchema"].clone();
    let created = document_read_call(&app, &token, "create_page", json!({"workspace_id":workspace,"title":"Convert native","idempotency_key":"convert-create","fragment":{"schemaVersion":"myoxus.document-fragment.v1","blocks":[
      {"kind":"list_item","listKind":"bulleted","spans":[{"text":"é😀 styled","bold":true}],"children":[{"kind":"paragraph","spans":[{"text":"Keep child","italic":true}]},{"kind":"mermaid","source":"flowchart LR\nA --> B"}]},
      {"kind":"paragraph","spans":[{"text":"Neighbor"}]}
    ]}})).await;
    let target = json!({"workspace_id":workspace,"external_id":created["externalId"]});
    let mut current = document_read_call(&app, &token, "read_doc", target.clone()).await;
    let mut id = reading_block(&current, 0)["blockId"].as_str().unwrap().to_string();
    let fields = reading_block(&current, 0)["native"]["fields"].clone();
    let selected = document_read_call(&app, &token, "read_doc", json!({"workspace_id":workspace,"external_id":created["externalId"],"block_id":id})).await;
    let children = selected["selection"]["identities"][0]["childIds"].clone();
    assert_eq!(children.as_array().unwrap().len(), 2);
    let neighbor = reading_block(&current, 1).clone();
    for (index, (kind, replaces)) in [("paragraph",true),("heading2",false),("todo",true),("numbered",false),("paragraph",true)].into_iter().enumerate() {
      let args = json!({"workspace_id":workspace,"external_id":created["externalId"],"operation":"convert_block","block_id":id,"block_kind":kind,"expected_revision":current["revision"],"idempotency_key":format!("convert-{index}")});
      assert!(schema["properties"]["block_kind"]["enum"].as_array().unwrap().contains(&json!(kind)));
      let changed = document_read_call(&app,&token,"doc_patch",args.clone()).await;
      let counts = document_write_effect_counts(&pool,workspace).await;
      assert_eq!(document_read_call(&app,&token,"doc_patch",args).await,changed);
      assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
      if replaces {
        assert_eq!(changed["removedBlockIds"],json!([id]));
        assert_eq!(changed["insertedBlockIds"].as_array().unwrap().len(),1);
        id = changed["insertedBlockIds"][0].as_str().unwrap().to_string();
      } else {
        assert_eq!(changed["insertedBlockIds"],json!([]));
        assert_eq!(changed["removedBlockIds"],json!([]));
      }
      current = document_read_call(&app,&token,"read_doc",target.clone()).await;
      let block = reading_block(&current,0);
      assert_eq!(block["blockId"],id);
      assert_eq!(block["native"]["properties"]["type"],match kind { "paragraph"=>"text", "heading2"=>"h2", other=>other });
      assert_eq!(block["native"]["kind"],if matches!(kind,"paragraph"|"heading2") { "myoxus:paragraph" } else { "myoxus:list" });
      assert_eq!(block["native"]["fields"],fields);
      let selected = document_read_call(&app, &token, "read_doc", json!({"workspace_id":workspace,"external_id":created["externalId"],"block_id":id})).await;
      let identity=selected["selection"]["identities"].as_array().unwrap().iter().find(|v|v["blockId"]==id).unwrap();
      assert_eq!(identity["childIds"],children);
      assert_eq!(reading_blocks(&current).find(|b|b["blockId"]==neighbor["blockId"]).unwrap(),&neighbor);
      assert_eq!(changed["updatedBlocks"],json!([block]));
    }
    let counts = document_write_effect_counts(&pool,workspace).await;
    for (index,extra) in [json!({"block_kind":"unknown"}),json!({"block_kind":"todo","properties":{"checked":true}}),json!({"block_kind":"todo","expected_revision":0})].into_iter().enumerate() {
      let mut args=json!({"workspace_id":workspace,"external_id":created["externalId"],"operation":"convert_block","block_id":id,"block_kind":"todo","expected_revision":current["revision"],"idempotency_key":format!("convert-invalid-{index}")});
      args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
      let rejected=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":args})).await;
      assert_eq!(rejected["result"]["isError"],true,"{rejected}");
      assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
      assert_eq!(document_read_call(&app,&token,"read_doc",target.clone()).await,current);
    }
  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(error) = outcome {
    std::panic::resume_unwind(error);
  }
}

#[tokio::test]
async fn inv_mcp_compat_native_split_join_preserves_marks_children_and_replays() {
  use futures_util::FutureExt;
  fn native_text_block<'a>(value: &'a Value, text: &str) -> Option<&'a Value> {
    if value["native"]["fields"][0]["spans"][0]["text"] == text {
      return Some(value);
    }
    match value {
      Value::Array(values) => values.iter().find_map(|v| native_text_block(v, text)),
      Value::Object(values) => values.values().find_map(|v| native_text_block(v, text)),
      _ => None,
    }
  }
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "native-split-join").await;
  let workspace = create_workspace(&pool, owner).await;
  let outcome = std::panic::AssertUnwindSafe(async {
    let token = document_read_key(&key_app, session, &["read:docs", "write:docs"]).await;
    let mut state = observed_tool_state(&pool).0;
    state.idempotency = Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let app = document_read_router(&pool, state);
    let tools = document_read_rpc(&app, &token, "tools/list", json!({})).await;
    let schema = tools["result"]["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == "doc_patch").unwrap()["inputSchema"].clone();
    for operation in ["split_block", "join_blocks"] { assert!(schema["properties"]["operation"]["enum"].as_array().unwrap().contains(&json!(operation))); }
    let created = document_read_call(&app, &token, "create_page", json!({"workspace_id":workspace,"title":"Split native","idempotency_key":"split-create","fragment":{"schemaVersion":"myoxus.document-fragment.v1","blocks":[
      {"kind":"list_item","listKind":"numbered","properties":{"order":{"action":"set","value":7}},"spans":[{"text":"é😀 styled","bold":true}],"children":[{"kind":"paragraph","spans":[{"text":"Retained child","italic":true}]}]},
      {"kind":"list_item","listKind":"numbered","properties":{"order":{"action":"set","value":8}},"spans":[{"text":"Following numbered"}]},
      {"kind":"paragraph","spans":[{"text":"Neighbor"}]}
    ]}})).await;
    let target = json!({"workspace_id":workspace,"external_id":created["externalId"]});
    let mut current = document_read_call(&app, &token, "read_doc", target.clone()).await;
    let id = reading_block(&current,0)["blockId"].as_str().unwrap().to_string();
    let neighbor = native_text_block(&current["document"]["blocks"],"Neighbor").unwrap().clone();
    let following = native_text_block(&current["document"]["blocks"],"Following numbered").unwrap()["blockId"].clone();
    let selected = document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":created["externalId"],"block_id":id})).await;
    let children = selected["selection"]["identities"][0]["childIds"].clone();
    // Start split transfers children to the fresh sibling, making an explicit
    // adjacent join possible without conflating nested and sibling structure.
    let split = json!({"workspace_id":workspace,"external_id":created["externalId"],"operation":"split_block","block_id":id,"position":0,"expected_revision":current["revision"],"idempotency_key":"split-start"});
    let changed = document_read_call(&app,&token,"doc_patch",split.clone()).await;
    assert_eq!(changed["insertedBlockIds"].as_array().unwrap().len(),1);
    assert_eq!(changed["removedBlockIds"],json!([]));
    let right = changed["insertedBlockIds"][0].clone();
    let left_selected = document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":created["externalId"],"block_id":id})).await;
    assert_eq!(left_selected["selection"]["identities"][0]["blockId"],id);
    assert_eq!(left_selected["selection"]["identities"][0]["childIds"],json!([]));
    assert_eq!(reading_block(&left_selected,0)["native"]["fields"][0]["length"],0);
    assert!(changed["affectedBlockIds"].as_array().unwrap().contains(&following));
    assert_eq!(native_text_block(&changed["updatedBlocks"],"Following numbered").unwrap()["native"]["properties"]["order"].as_f64(),Some(9.0));
    let counts = document_write_effect_counts(&pool,workspace).await;
    assert_eq!(document_read_call(&app,&token,"doc_patch",split).await,changed);
    assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
    let selected = document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":created["externalId"],"block_id":right})).await;
    assert_eq!(selected["selection"]["identities"][0]["childIds"],children);
    assert!(selected.to_string().contains("é😀 styled"));
    current = document_read_call(&app,&token,"read_doc",target.clone()).await;
    let join = json!({"workspace_id":workspace,"external_id":created["externalId"],"operation":"join_blocks","block_id":id,"source_block_id":right,"expected_revision":current["revision"],"idempotency_key":"join-siblings"});
    let changed = document_read_call(&app,&token,"doc_patch",join.clone()).await;
    assert_eq!(changed["removedBlockIds"],json!([right]));
    assert_eq!(changed["insertedBlockIds"],json!([]));
    assert_eq!(document_read_call(&app,&token,"doc_patch",join).await,changed);
    current=document_read_call(&app,&token,"read_doc",target.clone()).await;
    assert_eq!(reading_block(&current,0)["blockId"],id);
    assert_eq!(reading_block(&current,0)["native"]["fields"][0]["spans"][0]["text"],"é😀 styled");
    assert_eq!(reading_block(&current,0)["native"]["fields"][0]["spans"][0]["bold"],true);
    assert_eq!(reading_blocks(&current).find(|b|b["blockId"]==neighbor["blockId"]).unwrap(),&neighbor);
    let counts=document_write_effect_counts(&pool,workspace).await;
    for (index,patch) in [json!({"operation":"split_block","position":1}),json!({"operation":"split_block","position":0,"replacement":"ignored"}),json!({"operation":"join_blocks","source_block_id":right})].into_iter().enumerate() {
      let mut args=json!({"workspace_id":workspace,"external_id":created["externalId"],"block_id":id,"expected_revision":current["revision"],"idempotency_key":format!("split-invalid-{index}")});
      args.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
      let rejected=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":args})).await;
      assert_eq!(rejected["result"]["isError"],true,"{rejected}");
      assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
      assert_eq!(document_read_call(&app,&token,"read_doc",target.clone()).await,current);
    }
  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(error) = outcome {
    std::panic::resume_unwind(error);
  }
}

#[tokio::test]
async fn inv_mcp_compat_native_copy_nesting_and_explicit_unwrap_preserve_semantic_identities() {
  use futures_util::FutureExt;
  fn visit(value: &Value, f: &mut impl FnMut(&Value)) {
    f(value);
    match value {
      Value::Array(values) => {
        for value in values {
          visit(value, f);
        }
      }
      Value::Object(values) => {
        for value in values.values() {
          visit(value, f);
        }
      }
      _ => {}
    }
  }
  fn annotations(value: &Value) -> std::collections::BTreeSet<String> {
    let mut ids = std::collections::BTreeSet::new();
    visit(value, &mut |v| {
      if let Some(id) = v.get("annotationId").and_then(Value::as_str) {
        ids.insert(id.to_string());
      }
    });
    ids
  }
  fn footnotes(value: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    visit(value, &mut |v| {
      if let Some(id) = v
        .get("local_footnote")
        .and_then(|n| n.get("definition_id"))
        .and_then(Value::as_str)
      {
        ids.push(id.to_string());
      }
    });
    ids
  }
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "native-copy").await;
  let workspace = create_workspace(&pool, owner).await;
  let outcome=std::panic::AssertUnwindSafe(async {
    let token=document_read_key(&key_app,session,&["read:docs","write:docs"]).await;
    let mut state=observed_tool_state(&pool).0;
    state.idempotency=Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let docs=state.doc_service.clone();
    // Use the existing Rust import owner as a fixture producer. MCP mutation
    // never roundtrips this source through its Markdown compatibility bridge.
    let imported=myoxus_application::markdown::prepare_markdown_import("Native copy","Protected neighbor\n\nClaim **é😀** [^local].\n\n- Child %%annotation body%% tail\n  - Retained descendant\n\n```text\nProtected code\n```\n\n[^local]: Keep original definition.").unwrap();
    let (doc,_)=docs.create_page_from_snapshot_with_sync_updates(workspace,owner,Some("Native copy".into()),imported.yjs_binary).await.unwrap();
    let app=document_read_router(&pool,state);
    let tools=document_read_rpc(&app,&token,"tools/list",json!({})).await;
    let schema=&tools["result"]["tools"].as_array().unwrap().iter().find(|tool|tool["name"]=="doc_patch").unwrap()["inputSchema"];
    assert!(schema["properties"]["operation"]["enum"].as_array().unwrap().contains(&json!("duplicate_block")));
    let target=json!({"workspace_id":workspace,"external_id":doc.id});
    let mut current=document_read_call(&app,&token,"read_doc",target.clone()).await;
    let protected=reading_block(&current,0).clone();let claim=reading_block(&current,1)["blockId"].clone();let list=reading_block(&current,2)["blockId"].clone();
    let protected_code=reading_blocks(&current).find(|v|v["native"]["kind"]=="myoxus:code").unwrap().clone();
    let definition=footnotes(&current["document"]["blocks"]);assert_eq!(definition.len(),1);let definition=&definition[0];
    let mut args=json!({"workspace_id":workspace,"external_id":doc.id,"operation":"insert_after_block","block_id":protected["blockId"],"expected_revision":current["revision"],"idempotency_key":"copy-container","fragment":{"schemaVersion":"myoxus.document-fragment.v1","blocks":[{"kind":"callout","title":"Copy title","spans":[{"text":"Wrapper body","bold":true}],"children":[]}]}});
    let created=document_read_call(&app,&token,"doc_patch",args.clone()).await;
    let root=created["insertedBlockIds"][0].clone();let mut after:Option<Value>=None;
    for (index,child) in [claim,list].into_iter().enumerate() {
      current=document_read_call(&app,&token,"read_doc",target.clone()).await;
      args=json!({"workspace_id":workspace,"external_id":doc.id,"operation":"move_block","block_id":child,"parent_block_id":root,"expected_revision":current["revision"],"idempotency_key":format!("copy-nest-{index}")});
      if let Some(previous)=after {args["after_block_id"]=previous;}
      document_read_call(&app,&token,"doc_patch",args).await;after=Some(child);
    }
    let selected=document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":doc.id,"block_id":root})).await;
    current=document_read_call(&app,&token,"read_doc",target.clone()).await;
    let original=reading_blocks(&current).find(|block|block["blockId"]==root).unwrap().clone();
    let title=original["native"]["fields"].as_array().unwrap().iter().find(|field|field["field"]=="title").unwrap();
    assert_eq!(title["spans"].as_array().unwrap().iter().map(|span|span["text"].as_str().unwrap()).collect::<String>(),"Copy title");
    let source_ids=selected["selection"]["identities"].as_array().unwrap().iter().map(|v|v["blockId"].as_str().unwrap().to_string()).collect::<std::collections::BTreeSet<_>>();
    let old_annotations=annotations(&selected["document"]["blocks"]);assert_eq!(old_annotations.len(),1);
    current=document_read_call(&app,&token,"read_doc",target.clone()).await;
    let copy_args=json!({"workspace_id":workspace,"external_id":doc.id,"operation":"duplicate_block","block_id":root,"expected_revision":current["revision"],"idempotency_key":"copy-subtree"});
    let copied=document_read_call(&app,&token,"doc_patch",copy_args.clone()).await;
    let counts=document_write_effect_counts(&pool,workspace).await;
    assert_eq!(document_read_call(&app,&token,"doc_patch",copy_args).await,copied);
    assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
    assert_eq!(copied["removedBlockIds"],json!([]));assert_eq!(copied["insertedBlockIds"].as_array().unwrap().len(),source_ids.len());
    let copy=copied["insertedBlockIds"][0].clone();
    let copied_read=document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":doc.id,"block_id":copy})).await;
    let copy_ids=copied_read["selection"]["identities"].as_array().unwrap().iter().map(|v|v["blockId"].as_str().unwrap().to_string()).collect::<std::collections::BTreeSet<_>>();assert_eq!(copy_ids.len(),source_ids.len());assert!(copy_ids.is_disjoint(&source_ids));
    let new_annotations=annotations(&copied_read["document"]["blocks"]);assert_eq!(new_annotations.len(),1);assert!(old_annotations.is_disjoint(&new_annotations));
    assert_eq!(footnotes(&copied_read["document"]["blocks"]),vec![definition.clone()]);
    current=document_read_call(&app,&token,"read_doc",target.clone()).await;
    assert_eq!(reading_blocks(&current).find(|v|v["blockId"]==root).unwrap(),&original);
    assert_eq!(reading_blocks(&current).find(|v|v["blockId"]==protected["blockId"]).unwrap(),&protected);
    assert_eq!(footnotes(&current["document"]["blocks"]),vec![definition.clone(),definition.clone()]);
    let counts=document_write_effect_counts(&pool,workspace).await;
    for (index,payload) in [json!({"operation":"duplicate_block","block_id":root,"position":0}),json!({"operation":"move_block","block_id":copy,"parent_block_id":protected_code["blockId"]}),json!({"operation":"duplicate_block","block_id":root,"expected_revision":0}),json!({"operation":"insert_after_block","block_id":protected["blockId"],"fragment":{"schemaVersion":"myoxus.document-fragment.v1","blocks":[{"kind":"list_item","listKind":"bulleted","spans":[],"children":[{"kind":"table","rows":[[[]]]}]}]}})].into_iter().enumerate() {
      let mut args=json!({"workspace_id":workspace,"external_id":doc.id,"expected_revision":current["revision"],"idempotency_key":format!("copy-invalid-{index}")});args.as_object_mut().unwrap().extend(payload.as_object().unwrap().clone());
      let rejected=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":args})).await;assert_eq!(rejected["result"]["isError"],true,"{rejected}");assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);assert_eq!(document_read_call(&app,&token,"read_doc",target.clone()).await,current);
    }
    let root_identity=selected["selection"]["identities"].as_array().unwrap().iter().find(|v|v["blockId"]==root).unwrap();let note=root_identity["parentIds"][0].clone();
    // Nest/unnest the new container through the existing command, retaining all
    // copied identities. Moving the ancestor into its descendant must fail.
    let nested=document_read_call(&app,&token,"doc_patch",json!({"workspace_id":workspace,"external_id":doc.id,"operation":"move_block","block_id":copy,"parent_block_id":root,"expected_revision":current["revision"],"idempotency_key":"copy-nested"})).await;
    let counts=document_write_effect_counts(&pool,workspace).await;
    let cycle=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":{"workspace_id":workspace,"external_id":doc.id,"operation":"move_block","block_id":root,"parent_block_id":copy,"expected_revision":nested["revision"],"idempotency_key":"copy-cycle"}})).await;
    assert_eq!(cycle["result"]["isError"],true);assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
    document_read_call(&app,&token,"doc_patch",json!({"workspace_id":workspace,"external_id":doc.id,"operation":"move_block","block_id":copy,"parent_block_id":note,"after_block_id":root,"expected_revision":nested["revision"],"idempotency_key":"copy-unnested"})).await;
    // Explicit unwrap: preserve the known wrapper title and attributed body,
    // move each child out, then delete only the now-empty wrapper.
    current=document_read_call(&app,&token,"read_doc",target.clone()).await;
    let preserved=document_read_call(&app,&token,"doc_patch",json!({"workspace_id":workspace,"external_id":doc.id,"operation":"insert_after_block","block_id":copy,"expected_revision":current["revision"],"idempotency_key":"copy-preserve-wrapper","fragment":{"schemaVersion":"myoxus.document-fragment.v1","blocks":[{"kind":"paragraph","spans":[{"text":"Copy title"}]},{"kind":"paragraph","spans":[{"text":"Wrapper body","bold":true}]}]}})).await;
    let mut after=preserved["insertedBlockIds"][1].clone();
    let children=copied_read["selection"]["identities"].as_array().unwrap().iter().find(|v|v["blockId"]==copy).unwrap()["childIds"].as_array().unwrap();
    for (index,child) in children.iter().enumerate() {current=document_read_call(&app,&token,"read_doc",target.clone()).await;document_read_call(&app,&token,"doc_patch",json!({"workspace_id":workspace,"external_id":doc.id,"operation":"move_block","block_id":child,"parent_block_id":note,"after_block_id":after,"expected_revision":current["revision"],"idempotency_key":format!("copy-unwrap-child-{index}")})).await;after=child.clone();}
    current=document_read_call(&app,&token,"read_doc",target.clone()).await;
    let removed=document_read_call(&app,&token,"doc_patch",json!({"workspace_id":workspace,"external_id":doc.id,"operation":"delete_block","block_id":copy,"expected_revision":current["revision"],"idempotency_key":"copy-remove-wrapper"})).await;assert_eq!(removed["removedBlockIds"],json!([copy]));
    current=document_read_call(&app,&token,"read_doc",target.clone()).await;
    assert_eq!(footnotes(&current["document"]["blocks"]),vec![definition.clone(),definition.clone()]);
    assert_eq!(annotations(&current["document"]["blocks"]),old_annotations.union(&new_annotations).cloned().collect::<std::collections::BTreeSet<_>>());
    for id in copy_ids.iter().filter(|id|Some(id.as_str())!=copy.as_str()) {let selected=document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":doc.id,"block_id":id})).await;assert_eq!(selected["selection"]["identities"][0]["blockId"],*id);}
    for id in preserved["insertedBlockIds"].as_array().unwrap() {assert!(reading_blocks(&current).any(|v|v["blockId"]==*id));}
    assert_eq!(reading_blocks(&current).find(|v|v["blockId"]==root).unwrap(),&original);
    assert_eq!(reading_blocks(&current).find(|v|v["blockId"]==protected["blockId"]).unwrap(),&protected);
    assert_eq!(reading_blocks(&current).find(|v|v["blockId"]==protected_code["blockId"]).unwrap(),&protected_code);
  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(error) = outcome {
    std::panic::resume_unwind(error);
  }
}

#[tokio::test]
async fn inv_mcp_compat_native_table_axes_and_presentation_preserve_headers_coordinates_and_empty_table() {
  use futures_util::FutureExt;
  async fn edit(app: &axum::Router, token: &str, target: &Value, operation: &str, fields: Value) -> Value {
    let current = document_read_call(app, token, "read_doc", target.clone()).await;
    let mut args = target.clone();
    args
      .as_object_mut()
      .unwrap()
      .extend(fields.as_object().unwrap().clone());
    args["operation"] = json!(operation);
    args["expected_revision"] = current["revision"].clone();
    args["idempotency_key"] = json!(Uuid::new_v4());
    document_read_call(app, token, "doc_patch", args).await
  }
  fn table(read: &Value) -> &Value {
    reading_blocks(read).find(|v| v["kind"] == "table").unwrap()
  }
  fn axis(read: &Value, name: &str) -> Vec<String> {
    let id = table(read)["blockId"].as_str().unwrap();
    read["document"]["tableIdentities"][id][name]
      .as_array()
      .unwrap_or_else(|| panic!("missing {name} for table {id}: {read}"))
      .iter()
      .map(|v| v.as_str().unwrap().to_string())
      .collect()
  }
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "native-table-axes").await;
  let workspace = create_workspace(&pool, owner).await;
  let outcome=std::panic::AssertUnwindSafe(async {
    let token=document_read_key(&key_app,session,&["read:docs","write:docs"]).await;let mut state=observed_tool_state(&pool).0;state.idempotency=Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));let docs=state.doc_service.clone();let app=document_read_router(&pool,state);
    let created=document_read_call(&app,&token,"create_page",json!({"workspace_id":workspace,"title":"Native table axes","idempotency_key":"native-table-created","fragment":{"schemaVersion":"myoxus.document-fragment.v1","blocks":[{"kind":"paragraph","spans":[{"text":"Protected neighbor","italic":true}]},{"kind":"table","properties":{"appearance":{"action":"set","value":"ruled"},"density":{"action":"set","value":"compact"},"textAlign":{"action":"set","value":"center"}},"headerRows":2,"rows":[[[{"text":"é😀","bold":true}],[{"text":"Header"}]],[[{"text":"Second"}],[{"text":"Row"}]],[[{"text":"Body"}],[{"text":"Tail"}]]]},{"kind":"paragraph","spans":[{"text":"Protected tail","bold":true}]}]}})).await;
    let target=json!({"workspace_id":workspace,"external_id":created["externalId"]});let original=document_read_call(&app,&token,"read_doc",target.clone()).await;let protected=[reading_block(&original,0).clone(),reading_block(&original,2).clone()];let block=table(&original)["blockId"].clone();let rows=axis(&original,"rowIds");let columns=axis(&original,"columnIds");assert_eq!(rows.len(),3);assert_eq!(columns.len(),2);
    assert_eq!(table(&original)["appearance"],"ruled");assert_eq!(table(&original)["density"],"compact");assert_eq!(table(&original)["native"]["properties"]["textAlign"],"center");
    let original_fields=table(&original)["native"]["fields"].clone();
    edit(&app,&token,&target,"update_block_properties",json!({"block_id":block,"properties":{"table":{"appearance":{"action":"set","value":"plain"},"density":{"action":"set","value":"normal"},"textAlign":{"action":"set","value":"right"}}}})).await;
    edit(&app,&token,&target,"update_table_row_properties",json!({"block_id":block,"row_id":rows[0],"properties":{"backgroundColor":{"action":"set","value":"blue"}}})).await;
    edit(&app,&token,&target,"update_table_column_properties",json!({"block_id":block,"column_id":columns[0],"properties":{"backgroundColor":{"action":"set","value":"green"},"textAlign":{"action":"set","value":"center"},"width":{"action":"set","value":511.25}}})).await;
    let styled=document_read_call(&app,&token,"read_doc",target.clone()).await;assert_eq!(table(&styled)["native"]["fields"],original_fields);assert_eq!(axis(&styled,"rowIds"),rows);assert_eq!(axis(&styled,"columnIds"),columns);assert_eq!(table(&styled)["headerRows"],2);assert_eq!(table(&styled)["appearance"],"plain");assert_eq!(table(&styled)["density"],"normal");assert_eq!(table(&styled)["native"]["properties"]["textAlign"],"right");assert_eq!(table(&styled)["native"]["properties"]["columns"][&columns[0]]["width"],511.25);
    for(axis_id,color)in[(&rows[0],yjs::document_mutation::DocumentPaletteColor::Blue),(&columns[0],yjs::document_mutation::DocumentPaletteColor::Green)]{let native=yjs::YjsTextSegment::from(&yjs::DocumentTextSegment{background:Some(color),..Default::default()}).background.unwrap();let collection=if axis_id==&rows[0]{"rows"}else{"columns"};assert_eq!(table(&styled)["native"]["properties"][collection][axis_id]["backgroundColor"],native);}
    edit(&app,&token,&target,"update_table_row_properties",json!({"block_id":block,"row_id":rows[0],"properties":{"backgroundColor":{"action":"remove"}}})).await;
    edit(&app,&token,&target,"update_table_column_properties",json!({"block_id":block,"column_id":columns[0],"properties":{"backgroundColor":{"action":"remove"},"textAlign":{"action":"remove"},"width":{"action":"remove"}}})).await;
    edit(&app,&token,&target,"update_block_properties",json!({"block_id":block,"properties":{"table":{"appearance":{"action":"remove"},"density":{"action":"remove"},"textAlign":{"action":"remove"}}}})).await;
    let original=document_read_call(&app,&token,"read_doc",target.clone()).await;assert_eq!(table(&original)["native"]["fields"],original_fields);assert_eq!(table(&original)["headerRows"],2);for field in["appearance","density","textAlign"]{assert!(table(&original)["native"]["properties"].get(field).is_none());}for field in["width","textAlign","backgroundColor"]{assert!(table(&original)["native"]["properties"]["columns"][&columns[0]].get(field).is_none());}
    let args=json!({"workspace_id":workspace,"external_id":created["externalId"],"operation":"duplicate_table_row","block_id":block,"row_id":rows[0],"expected_revision":original["revision"],"idempotency_key":"native-table-copy-row"});let duplicated=document_read_call(&app,&token,"doc_patch",args.clone()).await;let counts=document_write_effect_counts(&pool,workspace).await;assert_eq!(document_read_call(&app,&token,"doc_patch",args).await,duplicated);assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);assert_eq!(duplicated["readback"]["status"],"complete");
    let mut current=document_read_call(&app,&token,"read_doc",target.clone()).await;let copy=axis(&current,"rowIds")[1].clone();assert!(!rows.contains(&copy));assert_eq!(table(&current)["headerRows"],3);assert_eq!(axis(&current,"columnIds"),columns);
    for(index,fields)in[json!({"operation":"delete_table_row","row_id":"foreign"}),json!({"operation":"move_table_row","row_id":copy,"after_row_id":"foreign"}),json!({"operation":"delete_table_column","column_id":columns[0],"expected_revision":0}),json!({"operation":"insert_table_row","column_id":columns[0]}),json!({"operation":"update_table_column_properties","column_id":columns[0],"properties":{"width":{"action":"set","value":59.9}}}),json!({"operation":"update_table_row_properties","row_id":rows[0],"properties":{"width":{"action":"set","value":60}}}),json!({"operation":"update_table_column_properties","column_id":columns[0],"properties":{"backgroundColor":{"action":"set","value":"#ff0000"}}})].into_iter().enumerate(){let mut args=target.clone();args["block_id"]=block.clone();args["expected_revision"]=current["revision"].clone();args["idempotency_key"]=json!(format!("native-table-rejected-{index}"));args.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());let result=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":args})).await;assert_eq!(result["result"]["isError"],true);assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);assert_eq!(document_read_call(&app,&token,"read_doc",target.clone()).await,current);}
    edit(&app,&token,&target,"move_table_row",json!({"block_id":block,"row_id":copy,"after_row_id":rows[2]})).await;
    edit(&app,&token,&target,"insert_table_column",json!({"block_id":block,"after_column_id":columns[0]})).await;
    current=document_read_call(&app,&token,"read_doc",target.clone()).await;let inserted=axis(&current,"columnIds")[1].clone();assert!(!columns.contains(&inserted));assert_eq!(table(&current)["headerRows"],3);assert!(table(&current)["rows"].as_array().unwrap().iter().all(|row|row.as_array().unwrap().len()==3));
    edit(&app,&token,&target,"duplicate_table_column",json!({"block_id":block,"column_id":columns[0]})).await;current=document_read_call(&app,&token,"read_doc",target.clone()).await;let copy_column=axis(&current,"columnIds")[1].clone();assert!(!columns.contains(&copy_column));assert_ne!(copy_column,inserted);
    edit(&app,&token,&target,"move_table_column",json!({"block_id":block,"column_id":copy_column,"after_column_id":columns[1]})).await;edit(&app,&token,&target,"clear_table_column",json!({"block_id":block,"column_id":copy_column})).await;edit(&app,&token,&target,"clear_table_row",json!({"block_id":block,"row_id":copy})).await;
    current=document_read_call(&app,&token,"read_doc",target.clone()).await;for row in axis(&current,"rowIds"){let result=edit(&app,&token,&target,"delete_table_row",json!({"block_id":block,"row_id":row})).await;assert_eq!(result["readback"]["status"],"complete");}
    current=document_read_call(&app,&token,"read_doc",target.clone()).await;assert!(axis(&current,"rowIds").is_empty());assert_eq!(axis(&current,"columnIds").len(),4);assert_eq!(table(&current)["rows"],json!([]));assert_eq!(table(&current)["headerRows"],0);assert_eq!(table(&current)["native"]["fields"],json!([]));
    edit(&app,&token,&target,"insert_table_row",json!({"block_id":block})).await;current=document_read_call(&app,&token,"read_doc",target.clone()).await;let new_row=axis(&current,"rowIds")[0].clone();assert!(!rows.contains(&new_row));for column in axis(&current,"columnIds"){edit(&app,&token,&target,"delete_table_column",json!({"block_id":block,"column_id":column})).await;}
    current=document_read_call(&app,&token,"read_doc",target.clone()).await;assert_eq!(axis(&current,"rowIds"),[new_row]);assert!(axis(&current,"columnIds").is_empty());assert_eq!(table(&current)["rows"],json!([[]]));assert_eq!(table(&current)["native"]["fields"],json!([]));edit(&app,&token,&target,"insert_table_column",json!({"block_id":block})).await;
    current=document_read_call(&app,&token,"read_doc",target.clone()).await;assert_eq!(table(&current)["blockId"],block);assert_eq!(table(&current)["rows"],json!([[[]]]));assert_eq!(table(&current)["headerRows"],0);assert_eq!(reading_block(&current,0),&protected[0]);assert_eq!(reading_block(&current,2),&protected[1]);
    // Authored repeat fixture uses the existing Rust import/native snapshot
    // owner; MCP only restructures it and never expands a template here.
    let imported=myoxus_application::markdown::prepare_markdown_import("Repeat table","| Member |\n| --- |\n| {{member.name}} %%axis annotation%% |").unwrap();let native=Doc::new();native.transact_mut().apply_update(Update::decode_v1(&imported.yjs_binary).unwrap()).unwrap();let blocks=native.get_or_insert_map("blocks");let mut txn=native.transact_mut();let(table_id,repeat_table)=blocks.iter(&txn).find_map(|(id,value)|match value{yrs::Out::YMap(block)if matches!(block.get(&txn,"sys:flavour"),Some(yrs::Out::Any(yrs::Any::String(kind)))if kind.as_ref()=="myoxus:table")=>Some((id.to_string(),block)),_=>None}).unwrap();
    repeat_table.insert(&mut txn,"prop:rows.row-0001.repeat.source","workspace.members");repeat_table.insert(&mut txn,"prop:rows.row-0001.repeat.alias","member");let state=txn.encode_diff_v1(&yrs::StateVector::default());drop(txn);let(repeat_doc,_)=docs.create_page_from_snapshot_with_sync_updates(workspace,owner,Some("Repeat table".into()),state).await.unwrap();let repeat_target=json!({"workspace_id":workspace,"external_id":repeat_doc.id});let repeated=document_read_call(&app,&token,"read_doc",repeat_target.clone()).await;let counts=document_write_effect_counts(&pool,workspace).await;
    for(index,fields)in[json!({"operation":"move_table_row","row_id":"row-0001"}),json!({"operation":"clear_table_row","row_id":"row-0001"}),json!({"operation":"delete_table_column","column_id":"col-0000"})].into_iter().enumerate(){let mut args=repeat_target.clone();args["block_id"]=json!(table_id);args["expected_revision"]=repeated["revision"].clone();args["idempotency_key"]=json!(format!("repeat-table-invalid-{index}"));args.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());let rejected=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":args})).await;assert_eq!(rejected["result"]["isError"],true);assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);assert_eq!(document_read_call(&app,&token,"read_doc",repeat_target.clone()).await,repeated);}
    let original_annotation=table(&repeated)["native"]["fields"].as_array().unwrap().iter().flat_map(|field|field["spans"].as_array().unwrap()).find_map(|span|span["annotationId"].as_str()).unwrap().to_string();
    edit(&app,&token,&repeat_target,"duplicate_table_row",json!({"block_id":table_id,"row_id":"row-0001"})).await;let repeated=document_read_call(&app,&token,"read_doc",repeat_target).await;let row_ids=axis(&repeated,"rowIds");assert_eq!(row_ids.len(),3);assert_eq!(table(&repeated)["headerRows"],1);assert_eq!(table(&repeated)["native"]["properties"]["rows"][&row_ids[2]]["repeat"],json!({"source":"workspace.members","alias":"member"}));
    let annotations=table(&repeated)["native"]["fields"].as_array().unwrap().iter().flat_map(|field|field["spans"].as_array().unwrap()).filter_map(|span|span["annotationId"].as_str().map(str::to_string)).collect::<std::collections::BTreeSet<_>>();assert_eq!(annotations.len(),2);assert!(annotations.contains(&original_annotation));
    edit(&app,&token,&json!({"workspace_id":workspace,"external_id":repeat_doc.id}),"duplicate_table_column",json!({"block_id":table_id,"column_id":"col-0000"})).await;let repeated=document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":repeat_doc.id})).await;let after_annotations=table(&repeated)["native"]["fields"].as_array().unwrap().iter().flat_map(|field|field["spans"].as_array().unwrap()).filter_map(|span|span["annotationId"].as_str().map(str::to_string)).collect::<std::collections::BTreeSet<_>>();assert_eq!(after_annotations.len(),4);assert!(annotations.is_subset(&after_annotations));

  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_compat_inline_references_are_native_target_authorized_and_replay_safe() {
  use futures_util::FutureExt;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "inline-reference-owner").await;
  let (limited, limited_session) = helpers::seed_user(&pool, &auth_store, "inline-reference-editor").await;
  let workspace = create_workspace(&pool, owner).await;
  let outcome=std::panic::AssertUnwindSafe(async {
    let owner_key=document_read_key(&key_app,session,&["read:docs","write:docs"]).await;
    let limited_key=document_read_key(&key_app,limited_session,&["read:docs","write:docs"]).await;
    let mut state=observed_tool_state(&pool).0;
    state.idempotency=Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let app=document_read_router(&pool,state);
    let target=document_read_call(&app,&owner_key,"create_page",json!({"workspace_id":workspace,"title":"Target","idempotency_key":"inline-target"})).await;
    let source=document_read_call(&app,&owner_key,"create_page",json!({"workspace_id":workspace,"title":"Source","idempotency_key":"inline-source","fragment":{"schemaVersion":yjs::DOCUMENT_FRAGMENT_SCHEMA,"blocks":[
      {"kind":"paragraph","spans":[{"text":"Before é😀 "},{"text":" ","reference":{"pageId":target["externalId"],"title":"First label"}},{"text":" after","bold":true}]},
      {"kind":"paragraph","spans":[{"text":"Protected neighbor","italic":true}]}
    ]}})).await;
    let target_doc:Uuid=sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2").bind(workspace).bind(target["externalId"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
    let source_doc:Uuid=sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2").bind(workspace).bind(source["externalId"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO workspace_memberships (workspace_id,user_id,role,status,joined_at) VALUES ($1,$2,'External','Accepted',now())").bind(workspace).bind(limited).execute(&pool).await.unwrap();
    for (id,role) in [(source_doc,"Editor"),(target_doc,"Reader")] {
      sqlx::query("INSERT INTO doc_user_permissions (user_id,doc_id,role) VALUES ($1,$2,$3)").bind(limited).bind(id).bind(role).execute(&pool).await.unwrap();
    }
    let read_args=json!({"workspace_id":workspace,"external_id":source["externalId"]});
    let original=document_read_call(&app,&owner_key,"read_doc",read_args.clone()).await;
    let id=reading_block(&original,0)["blockId"].as_str().unwrap();
    let spans=reading_block(&original,0)["native"]["fields"][0]["spans"].as_array().unwrap();
    let atom=spans.iter().find(|s|s.get("reference").is_some()).unwrap();
    assert_eq!(atom["text"]," ");assert_eq!(atom["end"].as_u64().unwrap()-atom["start"].as_u64().unwrap(),1);
    assert_eq!(atom["reference"]["pageId"],target["externalId"]);
    let args=json!({"workspace_id":workspace,"external_id":source["externalId"],"operation":"edit_text","block_id":id,"start":atom["start"],"end":atom["end"],"expected_text":" ","replacement_spans":[{"text":" ","reference":{"pageId":target["externalId"],"title":"Revised label"}}],"expected_revision":original["revision"],"idempotency_key":"inline-retarget"});
    let changed=document_read_call(&app,&limited_key,"doc_patch",args.clone()).await;
    let counts=document_write_effect_counts(&pool,workspace).await;
    assert_eq!(document_read_call(&app,&limited_key,"doc_patch",args.clone()).await,changed);
    assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
    let current=document_read_call(&app,&owner_key,"read_doc",read_args.clone()).await;
    assert_eq!(reading_block(&current,1),reading_block(&original,1));
    assert_eq!(reading_block(&current,0)["native"]["fields"][0]["spans"][0],spans[0]);
    assert!(reading_block(&current,0)["native"]["fields"][0]["spans"].as_array().unwrap().iter().any(|s|s["reference"]["title"]=="Revised label"));
    sqlx::query("DELETE FROM doc_user_permissions WHERE user_id=$1 AND doc_id=$2").bind(limited).bind(target_doc).execute(&pool).await.unwrap();
    let denied=document_read_rpc(&app,&limited_key,"tools/call",json!({"name":"doc_patch","arguments":args})).await;
    assert_eq!(denied["result"]["isError"],true,"Target Read is rechecked on replay");
    assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
    for (i,reference) in [json!({"pageId":target["externalId"],"params":{"blockIds":["forged"]}}),json!({"pageId":"missing-target"}),json!({"pageId":null})].into_iter().enumerate() {
      let bad=document_read_rpc(&app,&owner_key,"tools/call",json!({"name":"doc_patch","arguments":{"workspace_id":workspace,"external_id":source["externalId"],"operation":"edit_text","block_id":id,"start":0,"end":0,"replacement_spans":[{"text":" ","reference":reference}],"idempotency_key":format!("inline-invalid-{i}")}})).await;
      assert_eq!(bad["result"]["isError"],true);assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
    }
    document_read_call(&app,&owner_key,"doc_patch",json!({"workspace_id":workspace,"external_id":source["externalId"],"operation":"edit_text","block_id":id,"start":atom["start"],"end":atom["end"],"expected_text":" ","replacement_spans":[],"expected_revision":current["revision"],"idempotency_key":"inline-remove"})).await;
    let after=document_read_call(&app,&owner_key,"read_doc",read_args).await;
    assert!(reading_block(&after,0)["native"]["fields"][0]["spans"].as_array().unwrap().iter().all(|s|s.get("reference").is_none()));
    assert_eq!(reading_block(&after,1),reading_block(&original,1));
  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner, limited]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
#[tokio::test]
async fn inv_mcp_compat_annotations_are_literal_private_edit_targets_and_replay_safe() {
  use futures_util::FutureExt;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "native-annotations").await;
  let workspace = create_workspace(&pool, owner).await;
  let outcome=std::panic::AssertUnwindSafe(async {
    let token=document_read_key(&key_app,session,&["read:docs","write:docs"]).await;
    let read_token=document_read_key(&key_app,session,&["read:docs"]).await;
    let mut state=observed_tool_state(&pool).0;
    state.idempotency=Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let app=document_read_router(&pool,state);
    let literal="literal https://example.test/$x$ %%inside%% [[page]] é😀";
    let created=document_read_call(&app,&token,"create_page",json!({"workspace_id":workspace,"title":"Native annotations","idempotency_key":"annotation-create","fragment":{"schemaVersion":yjs::DOCUMENT_FRAGMENT_SCHEMA,"blocks":[
      {"kind":"paragraph","spans":[{"text":"Prefix é😀 ","bold":true},{"text":literal,"annotationId":"a"},{"text":" second literal","annotationId":"b"},{"text":" tail","italic":true}]},
      {"kind":"divider"},
      {"kind":"annotation","text":"standalone $formula$ %%literal%%"},
      {"kind":"table","rows":[[[{"text":"cell $source$","annotationId":"cell"}]]]},
      {"kind":"paragraph","spans":[{"text":"Protected neighbor","strike":true}]}
    ]}})).await;
    let target=json!({"workspace_id":workspace,"external_id":created["externalId"]});
    let original=document_read_call(&app,&token,"read_doc",target.clone()).await;
    let blocks=original["document"]["blocks"].as_array().unwrap();
    let paragraph=blocks.iter().find(|b|b["native"]["fields"][0]["spans"].as_array().is_some_and(|spans|spans.iter().any(|s|s["annotationId"].is_string()))&&b["native"]["kind"]=="myoxus:paragraph").unwrap();
    let id=paragraph["blockId"].as_str().unwrap();
    let marker=paragraph["native"]["fields"][0]["spans"].as_array().unwrap().iter().find(|s|s["text"]==literal).unwrap();
    let identity=marker["annotationId"].as_str().unwrap();assert_ne!(identity,"a");
    assert_eq!(marker["end"].as_u64().unwrap()-marker["start"].as_u64().unwrap(),literal.len() as u64);
    assert!(!paragraph["text"].to_string().contains(literal),"public reading spans still omit literal annotations");
    let standalone=blocks.iter().find(|b|b["native"]["kind"]=="myoxus:annotation").unwrap();
    let standalone_id=standalone["blockId"].as_str().unwrap();
    assert!(blocks.iter().position(|b|b["kind"]=="divider").unwrap()<blocks.iter().position(|b|b["blockId"]==standalone_id).unwrap(),"hidden native targets retain their order after non-text siblings");
    let selected=document_read_call(&app,&token,"read_doc",json!({"workspace_id":workspace,"external_id":created["externalId"],"block_id":standalone_id})).await;
    assert_eq!(selected["document"]["blocks"][0]["blockId"],standalone_id);assert_eq!(selected["document"]["blocks"][0]["native"],standalone["native"]);
    let args=json!({"workspace_id":workspace,"external_id":created["externalId"],"operation":"edit_annotation","block_id":id,"annotation_id":identity,"start":marker["start"],"replacement":"revised $literal$ é😀","expected_text":literal,"expected_revision":original["revision"],"idempotency_key":"annotation-edit"});
    let counts=document_write_effect_counts(&pool,workspace).await;
    let denied=document_read_rpc(&app,&read_token,"tools/call",json!({"name":"doc_patch","arguments":args})).await;
    assert_eq!(denied["result"]["isError"],true);assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
    let changed=document_read_call(&app,&token,"doc_patch",args.clone()).await;
    let counts=document_write_effect_counts(&pool,workspace).await;
    assert_eq!(document_read_call(&app,&token,"doc_patch",args.clone()).await,changed);assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
    let current=document_read_call(&app,&token,"read_doc",target.clone()).await;
    let paragraph_after=current["document"]["blocks"].as_array().unwrap().iter().find(|b|b["blockId"]==id).unwrap();
    let spans=paragraph_after["native"]["fields"][0]["spans"].as_array().unwrap();
    assert!(spans.iter().any(|s|s["annotationId"]==identity&&s["text"]=="revised $literal$ é😀"));
    assert_eq!(spans[0],paragraph["native"]["fields"][0]["spans"][0]);
    assert!(spans.iter().any(|s|s["text"]==" tail"&&s["italic"]==true));
    for (index,extra) in [json!({"expected_text":"stale literal"}),json!({"annotation_id":"missing"}),json!({"row_id":"unpaired"}),json!({"start":0}),json!({"end":0})].into_iter().enumerate() {
      let mut invalid=args.clone();invalid["expected_text"]=json!("revised $literal$ é😀");invalid["replacement"]=json!("must not replace");invalid["expected_revision"]=current["revision"].clone();invalid["idempotency_key"]=json!(format!("annotation-invalid-{index}"));invalid.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
      assert_eq!(document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":invalid})).await["result"]["isError"],true);
      assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
    }
    let invalid=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":{"workspace_id":workspace,"external_id":created["externalId"],"operation":"append_blocks","idempotency_key":"annotation-ignored-style","fragment":{"schemaVersion":yjs::DOCUMENT_FRAGMENT_SCHEMA,"blocks":[{"kind":"paragraph","spans":[{"text":"literal","annotationId":"ignored-style","bold":true}]}]}}})).await;
    assert_eq!(invalid["result"]["isError"],true);assert_eq!(document_write_effect_counts(&pool,workspace).await,counts);
    let table=blocks.iter().find(|b|b["native"]["kind"]=="myoxus:table").unwrap();let cell=&table["native"]["fields"][0];
    document_read_call(&app,&token,"doc_patch",json!({"workspace_id":workspace,"external_id":created["externalId"],"operation":"edit_annotation","block_id":table["blockId"],"row_id":cell["rowId"],"column_id":cell["columnId"],"annotation_id":cell["spans"][0]["annotationId"],"start":cell["spans"][0]["start"],"replacement":"cell revised $literal$","expected_text":"cell $source$","idempotency_key":"annotation-cell"})).await;
    document_read_call(&app,&token,"doc_patch",json!({"workspace_id":workspace,"external_id":created["externalId"],"operation":"edit_text","block_id":standalone_id,"start":0,"end":"standalone $formula$ %%literal%%".len(),"replacement":"standalone revised literal","expected_text":"standalone $formula$ %%literal%%","idempotency_key":"annotation-standalone"})).await;
    document_read_call(&app,&token,"doc_patch",json!({"workspace_id":workspace,"external_id":created["externalId"],"operation":"edit_annotation","block_id":id,"annotation_id":identity,"start":marker["start"],"replacement":"","expected_text":"revised $literal$ é😀","idempotency_key":"annotation-remove"})).await;
    let final_read=document_read_call(&app,&token,"read_doc",target).await;
    let final_blocks=final_read["document"]["blocks"].as_array().unwrap();
    let p=final_blocks.iter().find(|b|b["blockId"]==id).unwrap();assert!(p["native"]["fields"][0]["spans"].as_array().unwrap().iter().all(|s|s["annotationId"]!=identity));
    assert_eq!(final_blocks.iter().find(|b|b["blockId"]==standalone_id).unwrap()["native"]["fields"][0]["spans"][0]["text"],"standalone revised literal");
    let final_cell=&final_blocks.iter().find(|b|b["blockId"]==table["blockId"]).unwrap()["native"]["fields"][0];assert_eq!(final_cell["rowId"],cell["rowId"]);assert_eq!(final_cell["columnId"],cell["columnId"]);assert_eq!(final_cell["spans"][0]["annotationId"],cell["spans"][0]["annotationId"]);assert_eq!(final_cell["spans"][0]["text"],"cell revised $literal$");
    let neighbor=blocks.iter().find(|b|b["text"].to_string().contains("Protected neighbor")).unwrap();assert_eq!(final_blocks.iter().find(|b|b["blockId"]==neighbor["blockId"]).unwrap(),neighbor);
  }).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_compat_mentions_use_current_members_native_atoms_and_private_readback() {
  use futures_util::FutureExt;
  use yrs::Text;
  let (key_app, pool, auth_store) = helpers::setup_app().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "mention-owner").await;
  let (member, _) = helpers::seed_user(&pool, &auth_store, "mention-member").await;
  let (editor, editor_session) = helpers::seed_user(&pool, &auth_store, "mention-editor").await;
  let (foreign, _) = helpers::seed_user(&pool, &auth_store, "mention-foreign").await;
  let workspace = create_workspace(&pool, owner).await;
  let task = async {
    for user in [member, editor] {
      sqlx::query("INSERT INTO workspace_memberships (workspace_id,user_id,role,status,joined_at) VALUES ($1,$2,'Collaborator','Accepted',now())").bind(workspace).bind(user).execute(&pool).await.unwrap();
    }
    let token = document_read_key(&key_app, session, &["read:docs", "write:docs", "read:workspaces"]).await;
    let editor_key = document_read_key(&key_app, editor_session, &["read:docs", "write:docs"]).await;
    let mut state = observed_tool_state(&pool).0;
    state.idempotency =
      Arc::new(myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone()));
    let docs = state.doc_service.clone();
    let app = document_read_router(&pool, state);
    let notifications = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM notifications WHERE user_id=ANY($1)")
      .bind(vec![owner, member, editor, foreign])
      .fetch_one(&pool)
      .await
      .unwrap();
    let inventory = document_read_call(&app, &token, "workspace_member_list", json!({"workspace_id":workspace})).await;
    assert!(
      inventory["members"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["userId"] == member.to_string())
    );
    let create_args = json!({"workspace_id":workspace,"title":"Native member atoms","idempotency_key":"mention-create","fragment":{"schemaVersion":yjs::DOCUMENT_FRAGMENT_SCHEMA,"blocks":[
      {"kind":"paragraph","spans":[{"text":"Before é😀 ","bold":true},{"text":" ","mention":{"member":member}},{"text":" tail","italic":true}]},
      {"kind":"table","rows":[[[{"text":" ","mention":{"member":member}}]]]},
      {"kind":"paragraph","spans":[{"text":"Protected neighbor","strike":true}]}
    ]}});
    let created = document_read_call(&app, &token, "create_page", create_args.clone()).await;
    let target = json!({"workspace_id":workspace,"external_id":created["externalId"]});
    let original = document_read_call(&app, &token, "read_doc", target.clone()).await;
    let block = reading_block(&original, 0);
    let id = block["blockId"].as_str().unwrap();
    let spans = block["native"]["fields"][0]["spans"].as_array().unwrap();
    let atom = spans.iter().find(|s| s.get("mention").is_some()).unwrap();
    assert_eq!(atom["mention"], json!({"member":member}));
    assert_eq!(atom["text"], " ");
    assert_eq!(atom["end"].as_u64().unwrap() - atom["start"].as_u64().unwrap(), 1);
    assert_eq!(atom["start"], "Before é😀 ".len());
    let doc_id: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2")
      .bind(workspace)
      .bind(created["externalId"].as_str().unwrap())
      .fetch_one(&pool)
      .await
      .unwrap();
    sqlx::query("INSERT INTO doc_user_permissions (user_id,doc_id,role) VALUES ($1,$2,'Editor')")
      .bind(editor)
      .bind(doc_id)
      .execute(&pool)
      .await
      .unwrap();
    let args = json!({"workspace_id":workspace,"external_id":created["externalId"],"operation":"edit_text","block_id":id,"start":atom["start"],"end":atom["end"],"replacement_spans":[{"text":" ","mention":{"member":owner}}],"expected_text":" ","expected_revision":original["revision"],"idempotency_key":"mention-retarget"});
    let changed = document_read_call(&app, &editor_key, "doc_patch", args.clone()).await;
    assert!(changed["updatedBlocks"].to_string().contains(&owner.to_string()));
    let counts = document_write_effect_counts(&pool, workspace).await;
    assert_eq!(
      document_read_call(&app, &editor_key, "doc_patch", args.clone()).await,
      changed
    );
    assert_eq!(document_write_effect_counts(&pool, workspace).await, counts);
    // No global user-service is installed in observed_tool_state: membership is
    // resolved through the existing workspace owner, including current status.
    let invalid_mentions = [
      json!({"member":foreign}),
      json!({"member":Uuid::new_v4()}),
      json!({"member":member,"notification":Uuid::new_v4()}),
      json!({"member":"not-a-uuid"}),
    ];
    for (index, mention) in invalid_mentions.into_iter().enumerate() {
      let bad=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":{"workspace_id":workspace,"external_id":created["externalId"],"operation":"edit_text","block_id":id,"start":atom["start"],"end":atom["end"],"replacement_spans":[{"text":" ","mention":mention}],"expected_text":" ","idempotency_key":format!("mention-invalid-{index}")}})).await;
      assert_eq!(bad["result"]["isError"], true);
      assert_eq!(document_write_effect_counts(&pool, workspace).await, counts);
    }
    for status in ["Pending", "Revoked"] {
      sqlx::query("UPDATE workspace_memberships SET status=$1 WHERE workspace_id=$2 AND user_id=$3")
        .bind(status)
        .bind(workspace)
        .bind(member)
        .execute(&pool)
        .await
        .unwrap();
      let hidden = document_read_call(&app, &token, "read_doc", target.clone()).await;
      assert!(
        reading_block(&hidden, 1)["native"]["fields"][0]["spans"][0]
          .get("mention")
          .is_none(),
        "Inactive member metadata is omitted without deleting the native atom"
      );
      assert_eq!(reading_block(&hidden, 1)["native"]["fields"][0]["length"], 1);
      let replay = document_read_rpc(
        &app,
        &token,
        "tools/call",
        json!({"name":"create_page","arguments":create_args}),
      )
      .await;
      assert_eq!(
        replay["result"]["isError"], true,
        "Replay rechecks current target membership"
      );
      assert_eq!(document_write_effect_counts(&pool, workspace).await, counts);
      let bad=document_read_rpc(&app,&token,"tools/call",json!({"name":"create_page","arguments":{"workspace_id":workspace,"title":"Rejected member","idempotency_key":format!("mention-status-{status}"),"fragment":{"schemaVersion":yjs::DOCUMENT_FRAGMENT_SCHEMA,"blocks":[{"kind":"paragraph","spans":[{"text":" ","mention":{"member":member}}]}]}}})).await;
      assert_eq!(bad["result"]["isError"], true);
      assert_eq!(document_write_effect_counts(&pool, workspace).await, counts);
    }
    sqlx::query("UPDATE workspace_memberships SET status='Accepted' WHERE workspace_id=$1 AND user_id=$2")
      .bind(workspace)
      .bind(member)
      .execute(&pool)
      .await
      .unwrap();
    sqlx::query("UPDATE users SET status='disabled' WHERE id=$1")
      .bind(member)
      .execute(&pool)
      .await
      .unwrap();
    let disabled=document_read_rpc(&app,&token,"tools/call",json!({"name":"doc_patch","arguments":{"workspace_id":workspace,"external_id":created["externalId"],"operation":"edit_text","block_id":id,"start":0,"end":0,"replacement_spans":[{"text":" ","mention":{"member":member}}],"idempotency_key":"mention-disabled"}})).await;
    assert_eq!(disabled["result"]["isError"], true);
    assert_eq!(document_write_effect_counts(&pool, workspace).await, counts);
    sqlx::query("UPDATE users SET status='active' WHERE id=$1")
      .bind(member)
      .execute(&pool)
      .await
      .unwrap();
    // An ordinary edit's cached receipt must not retain an obsolete UsersRead
    // grant. The document remains readable/editable through its explicit ACL.
    let plain = json!({"workspace_id":workspace,"external_id":created["externalId"],"operation":"edit_text","block_id":id,"start":0,"end":0,"replacement":"X","idempotency_key":"mention-neighbor"});
    let receipt = document_read_call(&app, &editor_key, "doc_patch", plain.clone()).await;
    assert!(receipt["updatedBlocks"].to_string().contains("mention"));
    sqlx::query("UPDATE workspace_memberships SET role='External' WHERE workspace_id=$1 AND user_id=$2")
      .bind(workspace)
      .bind(editor)
      .execute(&pool)
      .await
      .unwrap();
    let after_counts = document_write_effect_counts(&pool, workspace).await;
    let private = document_read_call(&app, &editor_key, "read_doc", target.clone()).await;
    assert!(!private["document"]["blocks"].to_string().contains("\"mention\""));
    let replay = document_read_call(&app, &editor_key, "doc_patch", plain).await;
    assert!(!replay["updatedBlocks"].to_string().contains("\"mention\""));
    assert_eq!(replay["revision"], receipt["revision"]);
    assert_eq!(
      document_write_effect_counts(&pool, workspace).await,
      after_counts,
      "Visibility-filtered replay does not write"
    );
    let fresh=document_read_call(&app,&editor_key,"doc_patch",json!({"workspace_id":workspace,"external_id":created["externalId"],"operation":"edit_text","block_id":id,"start":0,"end":1,"replacement":"Y","expected_text":"X","idempotency_key":"mention-private-fresh"})).await;
    assert!(!fresh["updatedBlocks"].to_string().contains("\"mention\""));
    let fresh_counts = document_write_effect_counts(&pool, workspace).await;
    let denied = document_read_rpc(
      &app,
      &editor_key,
      "tools/call",
      json!({"name":"doc_patch","arguments":args}),
    )
    .await;
    assert_eq!(
      denied["result"]["isError"], true,
      "New mention replay requires current UsersRead before admission"
    );
    assert_eq!(document_write_effect_counts(&pool, workspace).await, fresh_counts);
    let current = document_read_call(&app, &token, "read_doc", target.clone()).await;
    let p = reading_block(&current, 0);
    let mention = p["native"]["fields"][0]["spans"]
      .as_array()
      .unwrap()
      .iter()
      .find(|s| s.get("mention").is_some())
      .unwrap();
    assert_eq!(mention["mention"]["member"], owner.to_string());
    document_read_call(&app,&token,"doc_patch",json!({"workspace_id":workspace,"external_id":created["externalId"],"operation":"edit_text","block_id":id,"start":mention["start"],"end":mention["end"],"expected_text":" ","replacement_spans":[],"idempotency_key":"mention-remove"})).await;
    let final_read = document_read_call(&app, &token, "read_doc", target).await;
    assert!(
      !reading_block(&final_read, 0)["native"]["fields"][0]["spans"]
        .to_string()
        .contains("\"mention\"")
    );
    assert_eq!(reading_block(&final_read, 2), reading_block(&original, 2));
    // The table's untouched native atom survives every ordinary edit/removal.
    let full = docs.load.load_full_doc_with_revision(workspace, doc_id).await.unwrap();
    let native = Doc::new();
    native
      .transact_mut()
      .apply_update(Update::decode_v1(&full.payload).unwrap())
      .unwrap();
    let blocks = native.get_or_insert_map("blocks");
    let txn = native.transact();
    let stored = blocks
      .iter(&txn)
      .filter_map(|(_, v)| if let yrs::Out::YMap(b) = v { Some(b) } else { None })
      .flat_map(|b| {
        b.iter(&txn)
          .filter_map(|(_, v)| if let yrs::Out::YText(t) = v { Some(t) } else { None })
          .collect::<Vec<_>>()
      })
      .flat_map(|t| t.diff(&txn, |_| ()))
      .filter_map(|r| r.attributes.and_then(|a| a.get("mention").cloned()))
      .collect::<Vec<_>>();
    assert_eq!(stored.len(), 1);
    assert!(format!("{:?}", stored[0]).contains(&member.to_string()));
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT count(*) FROM notifications WHERE user_id=ANY($1)")
        .bind(vec![owner, member, editor, foreign])
        .fetch_one(&pool)
        .await
        .unwrap(),
      notifications,
      "Native mention text never dispatches notifications"
    );
  };
  let outcome = std::panic::AssertUnwindSafe(task).catch_unwind().await;
  helpers::cleanup_workspaces(&pool, &[workspace]).await;
  helpers::cleanup_users(&pool, &[owner, member, editor, foreign]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
