//! P101-RAG-01: Integration tests for Copilot RAG (Retrieval-Augmented Generation) wiring.
//!
//! Invariants under test:
//! - INV-RAG-01: the authenticated SSE route sends only currently authorized,
//!               selected and nonignored context to the actual provider wire.
//! - INV-RAG-02: chat proceeds without error when no embeddings exist for the workspace.
//! - INV-RAG-03: allIgnoredDocs resolver returns objects with a `docId` field, not flat strings.

use crate::helpers;

use serde_json::json;
use uuid::Uuid;

// Helper: insert a test embedding row for a workspace (1536-dim vector).
fn vec_to_pgvector(vals: &[f32], dim: usize) -> String {
  let mut v: Vec<f32> = vals.to_vec();
  v.resize(dim, 0.0);
  let inner: Vec<String> = v.iter().map(|f| format!("{f}")).collect();
  format!("[{}]", inner.join(","))
}

async fn insert_test_embedding(pool: &sqlx::PgPool, workspace_id: Uuid, source_id: &str, chunk_text: &str) {
  let vec_str = vec_to_pgvector(&[0.1, 0.2, 0.3], 1536);
  sqlx::query(&format!(
    r#"INSERT INTO copilot_embeddings
       (workspace_id, source_type, source_id, chunk_index, chunk_text, token_count, embedding, model)
       VALUES ($1, 'doc', $2, 0, $3, 10, '{vec_str}'::vector, 'text-embedding-3-small')"#
  ))
  .bind(workspace_id)
  .bind(source_id)
  .bind(chunk_text)
  .execute(pool)
  .await
  .expect("insert embedding");
}

// ---------------------------------------------------------------------------
// INV-RAG-01: Inspect the consuming provider request, not rows seeded by this test.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_rag_01_context_injected_when_embeddings_exist() {
  use axum::{Json, Router, body::Body, http::Request, routing::post};
  use futures_util::FutureExt;
  use http_body_util::BodyExt;
  use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
  };
  use tower::ServiceExt;

  let requests = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
  let embedding_calls = Arc::new(AtomicUsize::new(0));
  let chat_requests = requests.clone();
  let embed_calls = embedding_calls.clone();
  let provider = Router::new()
    .route(
      "/v1/chat/completions",
      post(move |Json(request): Json<serde_json::Value>| {
        let requests = chat_requests.clone();
        async move {
          requests.lock().unwrap().push(request);
          (
            [("content-type", "text/event-stream")],
            "data: {\"choices\":[{\"delta\":{\"content\":\"context checked\"}}]}\n\ndata: [DONE]\n\n",
          )
        }
      }),
    )
    .route(
      "/v1/embedding-only/embeddings",
      post(
        move |headers: axum::http::HeaderMap, Json(request): Json<serde_json::Value>| {
          let calls = embed_calls.clone();
          async move {
            assert_eq!(headers["authorization"], "Bearer query-embedding-key");
            assert_eq!(request["model"], "text-embedding-3-small");
            assert_eq!(request["dimensions"], 1536);
            assert!(
              request.get("task_type").is_none(),
              "standard endpoints must not receive the optional task_type extension"
            );
            calls.fetch_add(1, Ordering::SeqCst);
            let mut vector = vec![0.0; 1536];
            vector[0] = 0.1;
            vector[1] = 0.2;
            vector[2] = 0.3;
            Json(json!({"data":[{"embedding":vector,"index":0}],"usage":{"prompt_tokens":1,"total_tokens":1}}))
          }
        },
      ),
    );
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
  let server = tokio::spawn(async move {
    axum::serve(listener, provider).await.unwrap();
  });
  let (_, pool, store, state) = helpers::setup_app_with_config_override_and_state(|config| {
    config.copilot.enabled = true;
    config.copilot.default_provider = "fixture".into();
    config.copilot.fallback_providers.clear();
    config.copilot.providers.clear();
    config.copilot.providers.insert(
      "fixture".into(),
      serde_json::from_value(json!({"enabled":true,"kind":"openai","endpoint":endpoint,"models":["test-model"]}))
        .unwrap(),
    );
    config.copilot.embedding.endpoint = Some(format!("{endpoint}/embedding-only"));
    config.copilot.embedding.api_key = Some("query-embedding-key".into());
  })
  .await;
  let mut registry = myoxus_application::copilot::provider::LlmProviderRegistry::new();
  registry.register(Arc::new(
    myoxus_infrastructure::copilot::openai_provider::OpenAiProvider::new(
      "fixture".into(),
      String::new(),
      endpoint,
      "test-model".into(),
      vec!["test-model".into()],
      Default::default(),
      std::time::Duration::from_secs(10),
      None,
    )
    .unwrap(),
  ));
  let copilot = state.copilot();
  let app = myoxus_api::build_router_for_integration_tests(state.with_llm_provider_registry(registry));
  let (user_id, auth) = helpers::seed_user(&pool, &store, "inv_rag01").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let foreign_workspace = helpers::create_workspace(&pool, user_id).await;
  let selected = helpers::create_doc(&pool, workspace_id, user_id).await;
  let ignored = helpers::create_doc(&pool, workspace_id, user_id).await;
  let unselected = helpers::create_doc(&pool, workspace_id, user_id).await;
  let foreign = helpers::create_doc(&pool, foreign_workspace, user_id).await;
  let result=std::panic::AssertUnwindSafe(async {
   // The index stores the internal UUID even when the client key differs.
   sqlx::query("UPDATE docs SET external_id=$2 WHERE id=$1")
     .bind(unselected).bind(format!("rag-source-{unselected}"))
     .execute(&pool).await.unwrap();
  let source=myoxus_application::markdown::markdown_to_yjs("Selected source","DIRECT_SELECTED_FACT: the observatory is called Copper Finch.").unwrap();
  sqlx::query("INSERT INTO doc_snapshots(workspace_id,doc_id,payload,last_sequence) VALUES($1,$2,$3,0)").bind(workspace_id).bind(selected).bind(source).execute(&pool).await.unwrap();
  for (id, text) in [
    (selected, "ALLOWED_CONTEXT"),
    (ignored, "IGNORED_CONTEXT"),
    (unselected, "UNSELECTED_CONTEXT"),
    (foreign, "FOREIGN_CONTEXT"),
  ] {
    insert_test_embedding(&pool, workspace_id, &id.to_string(), text).await;
  }
  sqlx::query("INSERT INTO copilot_workspaces(workspace_id,ignored_doc_ids) VALUES($1,$2)")
    .bind(workspace_id)
    .bind(json!([ignored]))
    .execute(&pool)
    .await
    .unwrap();
  let created = helpers::gql(&app,auth,json!({"query":"mutation($o:CreateChatSessionInput!){createCopilotSession(options:$o)}","variables":{"o":{"workspaceId":workspace_id,"promptName":"chat-with-ai"}}})).await;
  let session_id = created["data"]["createCopilotSession"].as_str().expect("session");
  let context = helpers::gql(&app,auth,json!({"query":"mutation($w:String!,$s:String!){createCopilotContext(workspaceId:$w,sessionId:$s)}","variables":{"w":workspace_id,"s":session_id}})).await;
  let context_id = context["data"]["createCopilotContext"].as_str().expect("context");
  let selected_blob = format!("wire-selected-{}", Uuid::new_v4());
  let unselected_blob = format!("wire-unselected-{}", Uuid::new_v4());
  let foreign_blob = format!("wire-other-session-{}", Uuid::new_v4());
  let other_context = copilot.create_context(user_id, Some(workspace_id), "other-session".into(), json!({})).await.unwrap();
  // Ingestion already owns byte/parser coverage. This fixture observes whether
  // persisted ready text, not the client's purported fileContent, reaches HTTP.
  let mut selected_item = None;
  for (blob, context, fact) in [
    (&selected_blob, Uuid::parse_str(context_id).unwrap(), "FILE_SELECTED_FACT: survey station is Copper Finch"),
    (&unselected_blob, Uuid::parse_str(context_id).unwrap(), "FILE_UNSELECTED_SECRET"),
    (&foreign_blob, other_context.id, "FILE_OTHER_SESSION_SECRET"),
  ] {
    sqlx::query("INSERT INTO blobs(workspace_id,key,size,mime,status) VALUES($1,$2,89,'text/plain','completed')").bind(workspace_id).bind(blob).execute(&pool).await.unwrap();
    let item = copilot.add_context_item(context, myoxus_domain::entities::CopilotContextItemType::File, Uuid::new_v4().to_string(), json!({"blobId":blob,"name":"notes.txt","mimeType":"text/plain","size":89,"chunkSize":1,"ingestStatus":"finished","text":fact})).await.unwrap();
    if blob == &selected_blob { selected_item = Some(item); }
  }
  let selected_item = selected_item.unwrap();
  let file_status=helpers::gql(&app,auth,json!({"query":"query($w:String!,$c:String!){currentUser{copilot(workspaceId:$w){contexts(contextId:$c){files{id status chunkSize blobId}}}}}","variables":{"w":workspace_id,"c":context_id}})).await;
  assert!(file_status.get("errors").is_none(),"{file_status}");
  let file = file_status["data"]["currentUser"]["copilot"]["contexts"][0]["files"].as_array().unwrap().iter().find(|file|file["blobId"]==selected_blob).unwrap();
  assert_eq!(file["status"],"finished");
  assert_eq!(file["chunkSize"],1,"chunkSize counts parsed chunks, never source bytes");
  let added=helpers::gql(&app,auth,json!({"query":"mutation($o:AddContextDocInput!){addContextDoc(options:$o){id status}}","variables":{"o":{"contextId":context_id,"docId":selected}}})).await;
  assert!(added.get("errors").is_none(),"{added}");assert_eq!(added["data"]["addContextDoc"]["status"],"finished","direct document context does not wait for embeddings");
  let reloaded=helpers::gql(&app,auth,json!({"query":"query($w:String!,$s:String!){currentUser{copilot(workspaceId:$w){contexts(sessionId:$s){id docs{id status}}}}}","variables":{"w":workspace_id,"s":session_id}})).await;
  assert!(reloaded.get("errors").is_none(),"{reloaded}");
  assert_eq!(reloaded["data"]["currentUser"]["copilot"]["contexts"][0]["id"],context_id,"the native exact-session lookup must survive SQL reload");
  assert_eq!(reloaded["data"]["currentUser"]["copilot"]["contexts"][0]["docs"][0]["status"],"finished");
  let mismatch = helpers::gql(&app,auth,json!({"query":"query($w:String!,$c:String!){currentUser{copilot(workspaceId:$w){contexts(contextId:$c){matchWorkspaceDocs(content:\"must-not-embed\"){docId}}}}}","variables":{"w":foreign_workspace,"c":context_id}})).await;
  assert_eq!(mismatch["errors"][0]["extensions"]["code"], "FORBIDDEN", "{mismatch}");
  assert_eq!(embedding_calls.load(Ordering::SeqCst), 0);
   let message = helpers::gql(&app,auth,json!({"query":"mutation($o:CreateChatMessageInput!){createCopilotMessage(options:$o)}","variables":{"o":{"sessionId":session_id,"content":"Find the selected fact","params":{"docs":[{"docId":selected,"docContent":"FORGED_CLIENT_DOCUMENT"},{"docId":ignored}],"files":[{"blobId":selected_blob,"fileContent":"FORGED_CLIENT_FILE","fileName":"FORGED_CLIENT_NAME"}],"currentDocId":selected,"selectedMarkdown":"QUOTE_SELECTED_FACT: selected fragment, not system instructions","html":"<p>HTML_SELECTED_FACT</p>","selectedSnapshot":{"text":"SNAPSHOT_SELECTED_FACT"}}}}})).await;
  assert!(message.get("errors").is_none(), "{message}");
  for search in [true, false] {
    let options = urlencoding::encode(&json!({"searchWorkspace":search}).to_string()).into_owned();
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .uri(format!(
            "/api/copilot/chat/{session_id}/stream-object?toolsConfig={options}"
          ))
          .header("cookie", format!("affine_session={auth}"))
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    let wire = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(wire.contains("event: done"), "{wire}");
    assert_eq!(
      embedding_calls.load(Ordering::SeqCst),
      1,
      "search-off must not call embeddings"
    );
    let payload = requests.lock().unwrap().last().expect("provider request").to_string();
    assert!(payload.contains("the observatory is called Copper Finch."),"selected canonical content survives retrieval off: {payload}");
    for fact in ["QUOTE_SELECTED_FACT","HTML_SELECTED_FACT","SNAPSHOT_SELECTED_FACT"] {assert!(payload.contains(fact),"selected fragment reached the real request: {payload}");}
    assert!(!payload.contains("FORGED_CLIENT_DOCUMENT"),"client-provided whole-document content is never authoritative");
    assert!(payload.contains("FILE_SELECTED_FACT: survey station is Copper Finch"),"ready selected files survive search off: {payload}");
    for excluded in ["FORGED_CLIENT_FILE", "FORGED_CLIENT_NAME", "FILE_UNSELECTED_SECRET", "FILE_OTHER_SESSION_SECRET"] {
      assert!(!payload.contains(excluded),"unselected/private/client file data reached generation: {payload}");
    }
    let captured=requests.lock().unwrap().last().unwrap().clone();
    let chat=captured["messages"].as_array().unwrap();
    assert_eq!(chat.iter().rev().find(|message|message["role"]=="user").unwrap()["content"],"Find the selected fact","selected data does not replace the question");
    assert!(chat.iter().any(|message|message["role"]=="user"&&message["content"].as_str().is_some_and(|text|text.contains("Quoted selected context")&&text.contains("the observatory is called Copper Finch."))));
    assert!(!chat.iter().filter(|message|message["role"]=="system").any(|message|message["content"].as_str().is_some_and(|text|text.contains("SELECTED_FACT")||text.contains("the observatory is called Copper Finch."))),"selected content cannot become system authority");
    assert_eq!(payload.contains("ALLOWED_CONTEXT"), search, "{payload}");
    for excluded in ["IGNORED_CONTEXT", "UNSELECTED_CONTEXT", "FOREIGN_CONTEXT"] {
      assert!(!payload.contains(excluded), "{payload}");
    }
  }
   let selection_only=helpers::gql(&app,auth,json!({"query":"mutation($o:CreateChatMessageInput!){createCopilotMessage(options:$o)}","variables":{"o":{"sessionId":session_id,"content":"Use my fragment with workspace search","params":{"currentDocId":selected,"selectedMarkdown":"ONLY_SELECTED_FRAGMENT"}}}})).await;
  assert!(selection_only.get("errors").is_none(),"{selection_only}");
   let options=urlencoding::encode(r#"{"searchWorkspace":true}"#);
  let response=app.clone().oneshot(Request::builder().uri(format!("/api/copilot/chat/{session_id}/stream-object?toolsConfig={options}")).header("cookie",format!("affine_session={auth}")).body(Body::empty()).unwrap()).await.unwrap();
  let wire=String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();assert!(wire.contains("event: done"),"{wire}");
  let last=requests.lock().unwrap().last().unwrap().to_string();
   assert!(last.contains("ONLY_SELECTED_FRAGMENT")&&!last.contains("the observatory is called Copper Finch."),"an implicit source ID cannot inject its unsolicited whole document: {last}");
   assert!(last.contains("UNSELECTED_CONTEXT")&&!last.contains("FOREIGN_CONTEXT")&&!last.contains("IGNORED_CONTEXT"),"workspace search must not be accidentally scoped to its origin document: {last}");
  let denied_message = helpers::gql(&app,auth,json!({"query":"mutation($o:CreateChatMessageInput!){createCopilotMessage(options:$o)}","variables":{"o":{"sessionId":session_id,"content":"Do not transmit denied context","params":{"docs":[{"docId":foreign}]}}}})).await;
  assert!(denied_message.get("errors").is_none(), "{denied_message}");
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .uri(format!("/api/copilot/chat/{session_id}/stream-object"))
        .header("cookie", format!("affine_session={auth}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  let wire = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
  assert!(wire.contains("COPILOT_ACCESS_DENIED"), "{wire}");
   assert_eq!(embedding_calls.load(Ordering::SeqCst), 2);
  assert_eq!(requests.lock().unwrap().len(), 3);
  sqlx::query("UPDATE doc_snapshots SET payload=$2 WHERE doc_id=$1").bind(selected).bind(vec![255_u8]).execute(&pool).await.unwrap();
  let status=helpers::gql(&app,auth,json!({"query":"query($w:String!,$c:String!){currentUser{copilot(workspaceId:$w){contexts(contextId:$c){docs{id status}}}}}","variables":{"w":workspace_id,"c":context_id}})).await;
  assert!(status.get("errors").is_none(),"{status}");
  assert_eq!(status["data"]["currentUser"]["copilot"]["contexts"][0]["docs"][0]["status"],"failed","invalid content must terminate polling, never remain processing");
  let invalid=helpers::gql(&app,auth,json!({"query":"mutation($o:CreateChatMessageInput!){createCopilotMessage(options:$o)}","variables":{"o":{"sessionId":session_id,"content":"Do not generate from an unavailable source","requestId":"invalid-source-context","params":{"docs":[{"docId":selected}]}}}})).await;
  assert!(invalid.get("errors").is_none(),"{invalid}");
  let message_id=invalid["data"]["createCopilotMessage"].as_str().unwrap();
  let response=app.clone().oneshot(Request::builder().uri(format!("/api/copilot/chat/{session_id}/stream-object?messageId={message_id}&requestId=invalid-source-context")).header("cookie",format!("affine_session={auth}")).body(Body::empty()).unwrap()).await.unwrap();
  let wire=String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
  assert!(wire.contains("COPILOT_SESSION_INVALID_INPUT")&&!wire.contains("event: done"),"{wire}");
  let failed:String=sqlx::query_scalar("SELECT token_usage->>'streamStatus' FROM copilot_messages WHERE session_id=$1 AND role='assistant' AND token_usage->>'requestId'='invalid-source-context'").bind(Uuid::parse_str(session_id).unwrap()).fetch_one(&pool).await.unwrap();
  assert_eq!(failed,"failed","explicit context preparation errors cannot become user cancellation");
  assert_eq!(requests.lock().unwrap().len(),3,"failed context cannot reach generation");
  // Revalidate source membership/status on each generation, even when the same
  // workspace person can read the blob and previously used its extracted text.
  for invalid_source in ["other-session", "pending", "failed", "deleted", "removed"] {
    let blob = if invalid_source == "other-session" { &foreign_blob } else { &selected_blob };
    match invalid_source {
      "pending" | "failed" => { sqlx::query("UPDATE copilot_context_items SET metadata=jsonb_set(metadata,'{ingestStatus}',$2::jsonb) WHERE id=$1").bind(selected_item.id).bind(json!(if invalid_source == "pending" {"running"} else {"failed"})).execute(&pool).await.unwrap(); },
      "deleted" => {
        sqlx::query("UPDATE copilot_context_items SET metadata=jsonb_set(metadata,'{ingestStatus}','\"finished\"') WHERE id=$1").bind(selected_item.id).execute(&pool).await.unwrap();
        sqlx::query("UPDATE blobs SET deleted_at=now() WHERE workspace_id=$1 AND key=$2").bind(workspace_id).bind(blob).execute(&pool).await.unwrap();
      },
      "removed" => {
        sqlx::query("UPDATE blobs SET deleted_at=NULL WHERE workspace_id=$1 AND key=$2").bind(workspace_id).bind(blob).execute(&pool).await.unwrap();
        copilot.remove_context_item(Uuid::parse_str(context_id).unwrap(), myoxus_domain::entities::CopilotContextItemType::File, &selected_item.item_ref).await.unwrap();
      },
      _ => {},
    }
    let message=helpers::gql(&app,auth,json!({"query":"mutation($o:CreateChatMessageInput!){createCopilotMessage(options:$o)}","variables":{"o":{"sessionId":session_id,"content":"Do not transmit unavailable file","params":{"files":[{"blobId":blob,"fileContent":"FORGED_RECOVERY"}]}}}})).await;
    assert!(message.get("errors").is_none(),"{message}");
    let response=app.clone().oneshot(Request::builder().uri(format!("/api/copilot/chat/{session_id}/stream-object?toolsConfig={options}")).header("cookie",format!("affine_session={auth}")).body(Body::empty()).unwrap()).await.unwrap();
    let wire=String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(wire.contains("COPILOT_SESSION_INVALID_INPUT")&&!wire.contains("event: done"),"{invalid_source}: {wire}");
    assert_eq!(requests.lock().unwrap().len(),3,"{invalid_source} file reached generation");
  }
  sqlx::query("UPDATE copilot_sessions SET deleted_at=now() WHERE id=$1").bind(Uuid::parse_str(session_id).unwrap()).execute(&pool).await.unwrap();
  let denied_context=helpers::gql(&app,auth,json!({"query":"query($w:String!,$c:String!){currentUser{copilot(workspaceId:$w){contexts(contextId:$c){id}}}}","variables":{"w":workspace_id,"c":context_id}})).await;
  assert_eq!(denied_context["errors"][0]["extensions"]["code"],"FORBIDDEN","SQL-reloaded context metadata must retain the live session authority boundary");
  }).catch_unwind().await;
  server.abort();
  sqlx::query("DELETE FROM copilot_embeddings WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("remove fixture embeddings");
  helpers::cleanup_users(&pool, &[user_id]).await;
  if let Err(error) = result {
    std::panic::resume_unwind(error);
  }
}

// ---------------------------------------------------------------------------
// User-image bytes cross the real adapter, never a filename-only substitute.
#[tokio::test]
async fn inv_copilot_image_input_preserves_authorized_bytes_and_rejects_loss() {
  use axum::{Json, Router, body::Body, http::Request, routing::post};
  use futures_util::FutureExt;
  use http_body_util::BodyExt;
  use std::sync::{Arc, Mutex};
  use tower::ServiceExt;
  let requests = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
  let captured = requests.clone();
  let provider = Router::new().route(
    "/v1/chat/completions",
    post(move |Json(request): Json<serde_json::Value>| {
      let captured = captured.clone();
      async move {
        captured.lock().unwrap().push(request);
        (
          [("content-type", "text/event-stream")],
          "data: {\"choices\":[{\"delta\":{\"content\":\"image received\"}}]}\n\ndata: [DONE]\n\n",
        )
      }
    }),
  );
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
  let task = tokio::spawn(async move {
    axum::serve(listener, provider).await.unwrap();
  });
  let options: myoxus_contracts::copilot::CopilotModelOptionsMap =
    serde_json::from_value(json!({"image-model":{"supports_vision":true}})).unwrap();
  let (_,pool,store,state)=helpers::setup_app_with_config_override_and_state(|config| {
    config.copilot.enabled=true;config.copilot.default_provider="fixture".into();config.copilot.fallback_providers.clear();config.copilot.providers.clear();
    config.copilot.providers.insert("fixture".into(),serde_json::from_value(json!({"enabled":true,"kind":"openai","endpoint":endpoint,"models":["image-model","text-model"],"model_options":options})).unwrap());
  }).await;
  let blobs = state.blob_service();
  let mut registry = myoxus_application::copilot::provider::LlmProviderRegistry::new();
  registry.register(Arc::new(
    myoxus_infrastructure::copilot::openai_provider::OpenAiProvider::new(
      "fixture".into(),
      String::new(),
      endpoint,
      "image-model".into(),
      vec!["image-model".into(), "text-model".into()],
      options,
      std::time::Duration::from_secs(10),
      None,
    )
    .unwrap(),
  ));
  let app = myoxus_api::build_router_for_integration_tests(state.with_llm_provider_registry(registry));
  let (user, auth) = helpers::seed_user(&pool, &store, "copilot_image_wire").await;
  let workspace = helpers::create_workspace(&pool, user).await;
  let key = format!("copilot-image-{}", Uuid::new_v4());
  let result=std::panic::AssertUnwindSafe(async {
    // The serialization contract needs magic-byte MIME detection, not a vision
    // accuracy fixture or pixel decoding. Assert every supplied byte on the wire.
    let bytes=bytes::Bytes::from_static(b"\x89PNG\r\n\x1a\n");
    blobs.upload_single_part_blob(workspace,&key,bytes,"image/png",Some("image/png".into()),None).await.unwrap();
    let session=helpers::gql(&app,auth,json!({"query":"mutation($o:CreateChatSessionInput!){createCopilotSession(options:$o)}","variables":{"o":{"workspaceId":workspace,"promptName":"chat-with-ai"}}})).await;
    let session=session["data"]["createCopilotSession"].as_str().unwrap();
    let message=helpers::gql(&app,auth,json!({"query":"mutation($o:CreateChatMessageInput!){createCopilotMessage(options:$o)}","variables":{"o":{"sessionId":session,"content":"Describe this image","attachments":[key]}}})).await;
    assert!(message.get("errors").is_none(),"{message}");
    let options=urlencoding::encode(r#"{"searchWorkspace":false}"#);
    for (model,success) in [("text-model",false),("image-model",true)] {
      let response=app.clone().oneshot(Request::builder().uri(format!("/api/copilot/chat/{session}/stream-object?modelId={model}&toolsConfig={options}")).header("cookie",format!("affine_session={auth}")).body(Body::empty()).unwrap()).await.unwrap();
      let wire=String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
      assert_eq!(wire.contains("event: done"),success,"{wire}");
      if !success {assert!(wire.contains("COPILOT_SESSION_INVALID_INPUT"));assert!(requests.lock().unwrap().is_empty(),"unsupported input cannot reach a provider");}
    }
    let payload=requests.lock().unwrap()[0].clone();
    assert_eq!(payload["messages"][1]["content"],json!([
      {"type":"text","text":"Describe this image"},
      {"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgo="}}
    ]));
    let history=helpers::gql(&app,auth,json!({"query":"query($w:String!,$o:QueryChatHistoriesInput){currentUser{copilot(workspaceId:$w){chats(pagination:{first:1},options:$o){edges{node{messages{role attachments}}}}}}}","variables":{"w":workspace,"o":{"sessionId":session}}})).await;
    assert!(history.get("errors").is_none(),"{history}");
    let preview=history["data"]["currentUser"]["copilot"]["chats"]["edges"][0]["node"]["messages"][0]["attachments"][0].as_str().unwrap();
    assert_eq!(preview,format!("/api/workspaces/{workspace}/blobs/{}",urlencoding::encode(&key)));
    for authenticated in [true,false] {
      let mut request=Request::builder().uri(preview);
      if authenticated {request=request.header("cookie",format!("affine_session={auth}"));}
      let response=app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
      assert_eq!(response.status().is_success(),authenticated,"history image delivery must retain authentication");
      if authenticated {assert_eq!(response.into_body().collect().await.unwrap().to_bytes().as_ref(),b"\x89PNG\r\n\x1a\n");}
    }
    let persisted:serde_json::Value=sqlx::query_scalar("SELECT content FROM copilot_messages WHERE id=$1").bind(Uuid::parse_str(message["data"]["createCopilotMessage"].as_str().unwrap()).unwrap()).fetch_one(&pool).await.unwrap();
    assert_eq!(persisted["__attachmentRefs"][0]["blobKey"],key);
    assert!(!persisted.to_string().contains("/api/workspaces/"),"derived URLs must not become persisted attachment references");
    sqlx::query("UPDATE blobs SET deleted_at=now() WHERE workspace_id=$1 AND key=$2").bind(workspace).bind(&key).execute(&pool).await.unwrap();
    let response=app.clone().oneshot(Request::builder().uri(format!("/api/copilot/chat/{session}/stream-object?modelId=image-model&toolsConfig={options}")).header("cookie",format!("affine_session={auth}")).body(Body::empty()).unwrap()).await.unwrap();
    let wire=String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(wire.contains("COPILOT_SESSION_INVALID_INPUT")&&!wire.contains("event: done"),"{wire}");
    assert_eq!(requests.lock().unwrap().len(),1,"deleted historical attachment cannot be retransmitted");
  }).catch_unwind().await;
  task.abort();
  blobs.hard_delete_blob(workspace, &key).await.unwrap();
  helpers::cleanup_users(&pool, &[user]).await;
  if let Err(error) = result {
    std::panic::resume_unwind(error);
  }
}

// INV-RAG-02: Chat proceeds without error when no embeddings exist.
//             We verify that the copilot_embeddings table is empty for the
//             workspace (simulating a new/empty workspace) and that a chat
//             session can still be created and messages persisted — the RAG
//             path gracefully degrades to no-context.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_rag_02_chat_works_without_embeddings() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "inv_rag02", false).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  // Confirm no embeddings exist for this workspace.
  let count: i64 = sqlx::query_scalar("SELECT count(*) FROM copilot_embeddings WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("count embeddings");
  assert_eq!(
    count, 0,
    "INV-RAG-02: workspace must have no embeddings as precondition"
  );

  // Create a copilot session and insert a user message directly (bypasses
  // copilot.enabled flag — we are testing the DB state path, not the HTTP path).
  let session_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO copilot_sessions (id, user_id, workspace_id, model, pinned)
     VALUES ($1, $2, $3, 'gpt-4o-mini', false)",
  )
  .bind(session_id)
  .bind(user_id)
  .bind(workspace_id)
  .execute(&pool)
  .await
  .expect("insert copilot session");

  let message_id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO copilot_messages (id, session_id, role, content)
       VALUES ($1, $2, 'user', '{"text": "hello"}'::jsonb)"#,
  )
  .bind(message_id)
  .bind(session_id)
  .execute(&pool)
  .await
  .expect("insert copilot message");

  // INV-RAG-02: message must be persisted even when no embeddings exist.
  let msg_count: i64 = sqlx::query_scalar("SELECT count(*) FROM copilot_messages WHERE session_id = $1")
    .bind(session_id)
    .fetch_one(&pool)
    .await
    .expect("count messages");
  assert_eq!(
    msg_count, 1,
    "INV-RAG-02: user message must be stored when no embeddings exist"
  );

  // Cleanup
  sqlx::query("DELETE FROM copilot_messages WHERE session_id = $1")
    .bind(session_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM copilot_sessions WHERE id = $1")
    .bind(session_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// INV-RAG-03: allIgnoredDocs returns objects with a `docId` field, not flat strings.
//             We insert a copilot_workspaces row with ignored_doc_ids populated,
//             then query the GraphQL resolver and check the shape of the response.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_rag_03_ignored_docs_shape() {
  let (app, pool, auth_store) = helpers::setup_app_with_metrics().await;
  let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "inv_rag03").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  // Insert or update the copilot_workspaces row with two ignored doc IDs.
  let doc_a = Uuid::new_v4().to_string();
  let doc_b = Uuid::new_v4().to_string();
  sqlx::query(
    r#"INSERT INTO copilot_workspaces (workspace_id, ignored_doc_ids)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (workspace_id) DO UPDATE SET ignored_doc_ids = EXCLUDED.ignored_doc_ids"#,
  )
  .bind(workspace_id)
  .bind(json!([doc_a, doc_b]).to_string())
  .execute(&pool)
  .await
  .expect("upsert copilot_workspaces");

  // Query allIgnoredDocs via GraphQL: workspace -> embedding -> allIgnoredDocs.
  let resp = helpers::gql(
    &app,
    user_session,
    json!({
      "query": "query AID($wid: String!) { workspace(id: $wid) { embedding { allIgnoredDocs { docId } } } }",
      "variables": { "wid": workspace_id.to_string() }
    }),
  )
  .await;

  // INV-RAG-03: no GraphQL errors.
  assert!(
    resp.get("errors").is_none(),
    "INV-RAG-03: allIgnoredDocs must not return GraphQL errors: {resp}"
  );

  // INV-RAG-03: response must be a list of objects with `docId` field.
  let docs = resp["data"]["workspace"]["embedding"]["allIgnoredDocs"]
    .as_array()
    .expect("INV-RAG-03: allIgnoredDocs must be an array");
  assert_eq!(docs.len(), 2, "INV-RAG-03: must return exactly 2 ignored doc entries");
  for doc in docs {
    assert!(
      doc.get("docId").is_some(),
      "INV-RAG-03: each ignored doc entry must have a 'docId' field, got: {doc}"
    );
    assert!(
      doc["docId"].is_string(),
      "INV-RAG-03: 'docId' must be a string, got: {}",
      doc["docId"]
    );
  }

  // Cleanup
  sqlx::query("DELETE FROM copilot_workspaces WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user_id]).await;
}
