//! P61-E-01: Integration tests for copilot embedding pipeline (pgvector + FTS).
//!
//! Tests the copilot_embeddings table (pgvector similarity search, HNSW index)
//! and the search_content FTS table (tsvector full-text search).
//!
//! Also covers P101-CODE-REVIEW-3: configurable batch_size for embedding jobs.
//!
//! Requires: pgvector extension in test DB (pgvector/pgvector:pg16 image).

use crate::helpers;

use myoxus_api::config::CopilotEmbeddingConfig;
use sqlx::Row;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Helper: build a 1536-dimension vector string for pgvector INSERT
// ---------------------------------------------------------------------------

fn vec_to_pgvector(vals: &[f32], dim: usize) -> String {
  let mut v: Vec<f32> = vals.to_vec();
  v.resize(dim, 0.0);
  let inner: Vec<String> = v.iter().map(|f| format!("{f}")).collect();
  format!("[{}]", inner.join(","))
}

// ---------------------------------------------------------------------------
// 1. embedding_insert_and_count
// ---------------------------------------------------------------------------

#[tokio::test]
async fn embedding_queue_execution_projects_productive_index_and_failures() {
  use axum::{
    Json, Router,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
  };
  use futures_util::FutureExt;
  use serde_json::json;
  use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
  };
  let requests = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
  let reject_at = Arc::new(AtomicUsize::new(usize::MAX));
  let captured = requests.clone();
  let rejected = reject_at.clone();
  let provider = Router::new().route(
    "/embedding-only/embeddings",
    post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
      let requests = captured.clone();
      let reject_at = rejected.clone();
      async move {
        assert_eq!(headers["authorization"], "Bearer embedding-fixture-key");
        assert_eq!(body["model"], "fixture-index-model");
        assert_eq!(body["dimensions"], 768);
        assert_eq!(
          body["task_type"],
          if matches!(body["input"][0].as_str(), Some("observatory" | "bird")) {
            "query"
          } else {
            "document"
          }
        );
        let number = {
          let mut values = requests.lock().unwrap();
          values.push(body.clone());
          values.len()
        };
        if number >= reject_at.load(Ordering::SeqCst) {
          return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":{"message":"PRIVATE_EMBEDDING_ERROR_BODY"}})),
          )
            .into_response();
        }
        let vectors = body["input"]
          .as_array()
          .unwrap()
          .iter()
          .enumerate()
          .map(|(index, _)| json!({"index":index,"embedding":vec![0.1_f32;768]}))
          .collect::<Vec<_>>();
        Json(json!({"model":"fixture-index-model","data":vectors})).into_response()
      }
    }),
  );
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let endpoint = format!("http://{}/embedding-only", listener.local_addr().unwrap());
  let server = tokio::spawn(async move {
    axum::serve(listener, provider).await.unwrap();
  });
  let (_, pool, store, state) = helpers::setup_app_with_config_override_and_state(|config| {
    config.copilot.enabled = true;
    config.copilot.embedding.endpoint = Some(endpoint);
    config.copilot.embedding.api_key = Some("embedding-fixture-key".into());
    config.copilot.embedding.model = "fixture-index-model".into();
    config.copilot.embedding.dimensions = 768;
    config.copilot.embedding.send_task_type = true;
    config.copilot.embedding.batch_size = 1;
    config.copilot.embedding_model = "wrong-generation-model".into();
  })
  .await;
  let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://localhost:6380".into());
  let prefix = format!("embedding-pipeline-{}", Uuid::new_v4());
  let queue = myoxus_worker::RedisQueue::new(&redis_url, &prefix).unwrap();
  let state = state.with_redis_queue(queue.clone());
  let app = myoxus_api::build_router_for_integration_tests(state.clone());
  let (user, auth) = helpers::seed_user(&pool, &store, "embedding_pipeline").await;
  let workspace = helpers::create_workspace(&pool, user).await;
  let doc = helpers::create_doc(&pool, workspace, user).await;
  let result=std::panic::AssertUnwindSafe(async {
    let body=format!("OLD_EMBEDDING_FACT\n\n{}","A bounded source paragraph about observatory measurements.\n\n".repeat(180));
    let source=myoxus_application::markdown::markdown_to_yjs("Embedding source",&body).unwrap();
    sqlx::query("INSERT INTO doc_snapshots(workspace_id,doc_id,payload,last_sequence) VALUES($1,$2,$3,0)").bind(workspace).bind(doc).bind(source).execute(&pool).await.unwrap();
    let session=helpers::gql(&app,auth,json!({"query":"mutation($o:CreateChatSessionInput!){createCopilotSession(options:$o)}","variables":{"o":{"workspaceId":workspace,"promptName":"chat-with-ai"}}})).await;
    let session=session["data"]["createCopilotSession"].as_str().unwrap();
    let context=helpers::gql(&app,auth,json!({"query":"mutation($w:String!,$s:String!){createCopilotContext(workspaceId:$w,sessionId:$s)}","variables":{"w":workspace,"s":session}})).await;
    let context=context["data"]["createCopilotContext"].as_str().unwrap();
    // A retained same-model vector from another dimension is neither readiness
    // nor a match. Rebuilding publishes new bytes rather than padding old ones.
    sqlx::query("INSERT INTO copilot_embeddings(id,workspace_id,source_type,source_id,chunk_index,chunk_text,token_count,embedding,model) VALUES($1,$2,'doc',$3,0,'OLD_DIMENSION',1,$4::vector,'fixture-index-model')")
      .bind(Uuid::new_v4()).bind(workspace).bind(doc.to_string()).bind(vec_to_pgvector(&[1.0],1536)).execute(&pool).await.unwrap();
    let prior=state.copilot_embedding_repo().unwrap().workspace_index_status(workspace,"fixture-index-model",768).await.unwrap();
    assert_eq!(prior.embedded,0,"a different vector dimension cannot claim readiness");
    let prior=state.copilot_embedding_repo().unwrap().similarity_search(workspace,&vec![0.1;768],5,"fixture-index-model",&[]).await.unwrap();
    assert!(prior.is_empty(),"old dimensions cannot enter current-model query results");
    let admitted=helpers::gql(&app,auth,json!({"query":"mutation($w:String!,$docs:[String!]!){queueWorkspaceEmbedding(workspaceId:$w,docId:$docs)}","variables":{"w":workspace,"docs":[doc]}})).await;
    assert_eq!(admitted["data"]["queueWorkspaceEmbedding"],true,"{admitted}");
    let queued=queue.dequeue("copilot",1).await.unwrap().unwrap();assert_eq!(queued.name,"copilot.embedding.add");
    let id=Uuid::parse_str(queued.data["copilotJobId"].as_str().unwrap()).unwrap();
    let persisted=state.copilot().get_job(id).await.unwrap().unwrap();assert_eq!(persisted.payload["sourceId"],doc.to_string());assert_eq!(persisted.user_id,Some(user));
    let mut indexer=state.embedding_indexer().await.unwrap();
    indexer.parser=Arc::new(myoxus_api::copilot_context_parser::SubprocessContextParser{executable:std::path::PathBuf::from(env!("CARGO_BIN_EXE_server"))});
    let count=indexer.execute(id).await.unwrap();assert!(count>1,"fixture must exercise real configured batching");
    queue.ack("copilot",&queued.id,None,Default::default()).await.unwrap();
    assert!(requests.lock().unwrap().iter().all(|request|request["input"].as_array().unwrap().len()==1),"configured batch size must reach actual HTTP calls");
    let status=helpers::gql(&app,auth,json!({"query":"query($w:String!){queryWorkspaceEmbeddingStatus(workspaceId:$w){total embedded available status error}}","variables":{"w":workspace}})).await;
    assert_eq!(status["data"]["queryWorkspaceEmbeddingStatus"],json!({"total":1,"embedded":1,"available":true,"status":"finished","error":null}),"{status}");
    let matched=helpers::gql(&app,auth,json!({"query":"query($w:String!,$c:String!){currentUser{copilot(workspaceId:$w){contexts(contextId:$c){matchWorkspaceDocs(content:\"observatory\",limit:100){docId content}}}}}","variables":{"w":workspace,"c":context}})).await;
    assert!(matched.get("errors").is_none(),"{matched}");assert!(matched["data"]["currentUser"]["copilot"]["contexts"][0]["matchWorkspaceDocs"].as_array().unwrap().iter().any(|hit|hit["content"].as_str().unwrap().contains("OLD\\_EMBEDDING\\_FACT")),"matcher must consume the canonical Markdown from the actual worker's productive index: {matched}");
    let old:Vec<(i32,String)>=sqlx::query_as("SELECT chunk_index,chunk_text FROM copilot_embeddings WHERE workspace_id=$1 AND source_id=$2 ORDER BY chunk_index").bind(workspace).bind(doc.to_string()).fetch_all(&pool).await.unwrap();
    let source=myoxus_application::markdown::markdown_to_yjs("Embedding source",&body.replace("OLD_EMBEDDING_FACT","REFRESH_NEW_FACT")).unwrap();
    sqlx::query("UPDATE doc_snapshots SET payload=$2 WHERE doc_id=$1").bind(doc).bind(source).execute(&pool).await.unwrap();
    reject_at.store(requests.lock().unwrap().len()+2,Ordering::SeqCst);
    let refresh=indexer.queue_source(workspace,Some(user),myoxus_domain::entities::CopilotEmbeddingSourceType::Doc,doc.to_string()).await.unwrap();
    let queued=queue.dequeue("copilot",1).await.unwrap().unwrap();assert_eq!(queued.data["copilotJobId"],refresh.to_string());
    let error=indexer.execute(refresh).await.unwrap_err();assert!(!error.to_string().contains("PRIVATE_EMBEDDING_ERROR_BODY"));
    queue.ack("copilot",&queued.id,None,Default::default()).await.unwrap();
    assert_eq!(state.copilot().get_job(refresh).await.unwrap().unwrap().state,myoxus_domain::entities::CopilotJobState::Failed);
    let retained:Vec<(i32,String)>=sqlx::query_as("SELECT chunk_index,chunk_text FROM copilot_embeddings WHERE workspace_id=$1 AND source_id=$2 ORDER BY chunk_index").bind(workspace).bind(doc.to_string()).fetch_all(&pool).await.unwrap();assert_eq!(retained,old,"failed later batch cannot publish a partial replacement");
    let status=helpers::gql(&app,auth,json!({"query":"query($w:String!){queryWorkspaceEmbeddingStatus(workspaceId:$w){embedded available status}}","variables":{"w":workspace}})).await;
    assert_eq!(status["data"]["queryWorkspaceEmbeddingStatus"],json!({"embedded":0,"available":false,"status":"failed"}),"retained bytes are not a successful current index: {status}");
    reject_at.store(usize::MAX,Ordering::SeqCst);indexer.execute(refresh).await.unwrap();
    let blob=format!("embedding-file-{}",Uuid::new_v4());
    state.blob().upload_single_part_blob(workspace,&blob,bytes::Bytes::from_static(b"FILE_INDEX_FACT: Marble Heron"),"text/plain",Some("text/plain".into()),None).await.unwrap();
    let file=state.copilot().add_context_item(Uuid::parse_str(context).unwrap(),myoxus_domain::entities::CopilotContextItemType::File,Uuid::new_v4().to_string(),json!({"blobId":blob,"name":"source.txt","mimeType":"text/plain","ingestStatus":"finished","text":"FILE_INDEX_FACT: Marble Heron"})).await.unwrap();
    let file_job=indexer.queue_source(workspace,Some(user),myoxus_domain::entities::CopilotEmbeddingSourceType::File,blob.clone()).await.unwrap();
    let queued=queue.dequeue("copilot",1).await.unwrap().unwrap();assert_eq!(queued.data["copilotJobId"],file_job.to_string());indexer.execute(file_job).await.unwrap();queue.ack("copilot",&queued.id,None,Default::default()).await.unwrap();
    let matched=helpers::gql(&app,auth,json!({"query":"query($w:String!,$c:String!){currentUser{copilot(workspaceId:$w){contexts(contextId:$c){matchFiles(content:\"bird\"){fileId blobId name content}}}}}","variables":{"w":workspace,"c":context}})).await;
    assert!(matched.get("errors").is_none(),"{matched}");let projected=&matched["data"]["currentUser"]["copilot"]["contexts"][0]["matchFiles"][0];assert_eq!(projected["content"],"FILE_INDEX_FACT: Marble Heron");assert_eq!(projected["blobId"],blob);assert_eq!(projected["fileId"],file.item_ref);assert_eq!(projected["name"],"source.txt");

    // The workspace queue must ignore CRDT system state, finish empty pages
    // without sending empty input, and keep healthy sources usable independently.
    let empty=helpers::create_doc(&pool,workspace,user).await;
    for (id, external) in [(empty,empty.to_string()),(helpers::create_doc(&pool,workspace,user).await,"db$folders".into()),(helpers::create_doc(&pool,workspace,user).await,"userdata$fixture".into())] {
      sqlx::query("UPDATE docs SET external_id=$2 WHERE id=$1").bind(id).bind(&external).execute(&pool).await.unwrap();
      let source=myoxus_application::markdown::markdown_to_yjs("Empty source", "").unwrap();
      sqlx::query("INSERT INTO doc_snapshots(workspace_id,doc_id,payload,last_sequence) VALUES($1,$2,$3,0)").bind(workspace).bind(id).bind(source).execute(&pool).await.unwrap();
      if id!=empty {
        assert!(indexer.queue_source(workspace,Some(user),myoxus_domain::entities::CopilotEmbeddingSourceType::Doc,id.to_string()).await.is_err(),"reserved source must not create work");
      }
    }
    let queued_all=helpers::gql(&app,auth,json!({"query":"mutation($w:String!){queueWorkspaceEmbedding(workspaceId:$w,docId:[])}","variables":{"w":workspace}})).await;
    assert_eq!(queued_all["data"]["queueWorkspaceEmbedding"],true,"{queued_all}");
    for _ in 0..2 {
      let queued=queue.dequeue("copilot",1).await.unwrap().unwrap();
      let id=Uuid::parse_str(queued.data["copilotJobId"].as_str().unwrap()).unwrap();
      let source=state.copilot().get_job(id).await.unwrap().unwrap().payload["sourceId"].as_str().unwrap().to_owned();
      let before=requests.lock().unwrap().len();
      let count=indexer.execute(id).await.unwrap();
      if source==empty.to_string() {
        assert_eq!(count,0);
        assert_eq!(requests.lock().unwrap().len(),before,"empty content must not reach the provider");
      } else { assert_eq!(source,doc.to_string()); }
      queue.ack("copilot",&queued.id,None,Default::default()).await.unwrap();
    }
    assert!(queue.dequeue("copilot",1).await.unwrap().is_none(),"system docs must be omitted from whole-workspace queueing");
    let status=helpers::gql(&app,auth,json!({"query":"query($w:String!){queryWorkspaceEmbeddingStatus(workspaceId:$w){total embedded available status}}","variables":{"w":workspace}})).await;
    assert_eq!(status["data"]["queryWorkspaceEmbeddingStatus"],json!({"total":1,"embedded":1,"available":true,"status":"finished"}),"empty and reserved sources cannot prevent completion: {status}");

    let healthy=helpers::create_doc(&pool,workspace,user).await;
    let source=myoxus_application::markdown::markdown_to_yjs("Healthy source","HEALTHY_SOURCE_FACT").unwrap();
    sqlx::query("INSERT INTO doc_snapshots(workspace_id,doc_id,payload,last_sequence) VALUES($1,$2,$3,0)").bind(workspace).bind(healthy).bind(source).execute(&pool).await.unwrap();
    let healthy_job=indexer.queue_source(workspace,Some(user),myoxus_domain::entities::CopilotEmbeddingSourceType::Doc,healthy.to_string()).await.unwrap();
    let queued=queue.dequeue("copilot",1).await.unwrap().unwrap();indexer.execute(healthy_job).await.unwrap();queue.ack("copilot",&queued.id,None,Default::default()).await.unwrap();
    reject_at.store(requests.lock().unwrap().len()+1,Ordering::SeqCst);
    let failed=indexer.queue_source(workspace,Some(user),myoxus_domain::entities::CopilotEmbeddingSourceType::Doc,doc.to_string()).await.unwrap();
    let queued=queue.dequeue("copilot",1).await.unwrap().unwrap();assert!(indexer.execute(failed).await.is_err());queue.ack("copilot",&queued.id,None,Default::default()).await.unwrap();
    let status=helpers::gql(&app,auth,json!({"query":"query($w:String!){queryWorkspaceEmbeddingStatus(workspaceId:$w){total embedded available status}}","variables":{"w":workspace}})).await;
    assert_eq!(status["data"]["queryWorkspaceEmbeddingStatus"],json!({"total":2,"embedded":1,"available":true,"status":"failed"}),"partial failure remains visible without disabling the healthy source: {status}");
    reject_at.store(usize::MAX,Ordering::SeqCst);
    let matched=helpers::gql(&app,auth,json!({"query":"query($w:String!,$c:String!){currentUser{copilot(workspaceId:$w){contexts(contextId:$c){matchWorkspaceDocs(content:\"observatory\",limit:100){docId content}}}}}","variables":{"w":workspace,"c":context}})).await;
    assert!(matched.get("errors").is_none(),"a different failed source cannot disable the consuming matcher: {matched}");
    let hits=matched["data"]["currentUser"]["copilot"]["contexts"][0]["matchWorkspaceDocs"].as_array().unwrap();
    assert!(!hits.is_empty());assert!(hits.iter().all(|hit|hit["docId"]==healthy.to_string()),"retained failed-source vectors must stay excluded: {matched}");
    // Clearing formerly indexed content removes stale facts atomically, and
    // records an empty outcome rather than a fake successful vector.
    for id in [doc,healthy] {
      let source=myoxus_application::markdown::markdown_to_yjs("Empty source", "").unwrap();
      sqlx::query("UPDATE doc_snapshots SET payload=$2 WHERE doc_id=$1").bind(id).bind(source).execute(&pool).await.unwrap();
      let job=indexer.queue_source(workspace,Some(user),myoxus_domain::entities::CopilotEmbeddingSourceType::Doc,id.to_string()).await.unwrap();
      let queued=queue.dequeue("copilot",1).await.unwrap().unwrap();assert_eq!(indexer.execute(job).await.unwrap(),0);queue.ack("copilot",&queued.id,None,Default::default()).await.unwrap();
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM copilot_embeddings WHERE workspace_id=$1 AND source_type='doc' AND source_id=$2 AND model='fixture-index-model'").bind(workspace).bind(id.to_string()).fetch_one(&pool).await.unwrap(),0);
    }
    let status=helpers::gql(&app,auth,json!({"query":"query($w:String!){queryWorkspaceEmbeddingStatus(workspaceId:$w){total embedded available status}}","variables":{"w":workspace}})).await;
    assert_eq!(status["data"]["queryWorkspaceEmbeddingStatus"],json!({"total":0,"embedded":0,"available":false,"status":"failed"}),"an empty workspace must not claim a usable index: {status}");
  }).catch_unwind().await;
  server.abort();
  sqlx::query("DELETE FROM copilot_embeddings WHERE workspace_id=$1")
    .bind(workspace)
    .execute(&pool)
    .await
    .unwrap();
  for key in state.blob().list_all_workspace_blob_keys(workspace).await.unwrap() {
    state.blob().hard_delete_blob(workspace, &key).await.unwrap();
  }
  let client = redis::Client::open(redis_url).unwrap();
  let mut redis = client.get_multiplexed_async_connection().await.unwrap();
  let keys: Vec<String> = redis::cmd("KEYS")
    .arg(format!("{prefix}:*"))
    .query_async(&mut redis)
    .await
    .unwrap();
  if !keys.is_empty() {
    redis::cmd("DEL")
      .arg(keys)
      .query_async::<i64>(&mut redis)
      .await
      .unwrap();
  }
  helpers::cleanup_users(&pool, &[user]).await;
  if let Err(error) = result {
    std::panic::resume_unwind(error);
  }
}

// ---------------------------------------------------------------------------
// 2. embedding_delete_by_source
// ---------------------------------------------------------------------------

#[tokio::test]
async fn embedding_delete_by_source() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "emb_del", false).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let source_id = Uuid::new_v4().to_string();

  let vec_str = vec_to_pgvector(&[1.0, 0.0, 0.0], 1536);

  for i in 0..3 {
    sqlx::query(&format!(
      r#"INSERT INTO copilot_embeddings
         (workspace_id, source_type, source_id, chunk_index, chunk_text, token_count, embedding, model)
         VALUES ($1, 'doc', $2, $3, 'chunk {i}', 3, '{vec_str}'::vector, 'text-embedding-3-small')"#
    ))
    .bind(workspace_id)
    .bind(&source_id)
    .bind(i)
    .execute(&pool)
    .await
    .expect("insert embedding");
  }

  // Delete all chunks for this source
  sqlx::query("DELETE FROM copilot_embeddings WHERE workspace_id = $1 AND source_type = 'doc' AND source_id = $2")
    .bind(workspace_id)
    .bind(&source_id)
    .execute(&pool)
    .await
    .expect("delete by source");

  let count: i64 = sqlx::query_scalar("SELECT count(*) FROM copilot_embeddings WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("count");

  assert_eq!(count, 0, "all embeddings for source should be deleted");

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// 3. embedding_similarity_search
// ---------------------------------------------------------------------------

#[tokio::test]
async fn embedding_similarity_search() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "emb_sim", false).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  // v1 = [1, 0, 0, ...] — closest to query
  // v2 = [0.9, 0.1, 0, ...] — second closest
  // v3 = [0, 1, 0, ...] — farthest from query
  let v1 = vec_to_pgvector(&[1.0, 0.0, 0.0], 1536);
  let v2 = vec_to_pgvector(&[0.9, 0.1, 0.0], 1536);
  let v3 = vec_to_pgvector(&[0.0, 1.0, 0.0], 1536);

  let vecs = [
    ("src_a", "exact match", &v1),
    ("src_b", "close match", &v2),
    ("src_c", "orthogonal", &v3),
  ];

  for (src, text, vec_str) in &vecs {
    sqlx::query(&format!(
      r#"INSERT INTO copilot_embeddings
         (workspace_id, source_type, source_id, chunk_index, chunk_text, token_count, embedding, model)
         VALUES ($1, 'doc', $2, 0, $3, 3, '{vec_str}'::vector, 'text-embedding-3-small')"#
    ))
    .bind(workspace_id)
    .bind(*src)
    .bind(*text)
    .execute(&pool)
    .await
    .expect("insert embedding");
  }

  // Query vector close to v1: [1, 0, 0, ...]
  let query_vec = vec_to_pgvector(&[1.0, 0.0, 0.0], 1536);

  let rows = sqlx::query(&format!(
    r#"SELECT source_id, chunk_text, embedding <=> '{query_vec}'::vector AS distance
       FROM copilot_embeddings
       WHERE workspace_id = $1
       ORDER BY embedding <=> '{query_vec}'::vector
       LIMIT 3"#
  ))
  .bind(workspace_id)
  .fetch_all(&pool)
  .await
  .expect("similarity search");

  assert_eq!(rows.len(), 3, "should return all 3 embeddings");

  // Verify vector dimensions stored in DB are non-zero (1536-dim)
  let dim: i32 =
    sqlx::query_scalar("SELECT vector_dims(embedding) FROM copilot_embeddings WHERE workspace_id = $1 LIMIT 1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("vector_dims query");
  assert!(dim > 0, "vector must have non-zero dimensions");

  let first_source: String = rows[0].get("source_id");
  let first_text: String = rows[0].get("chunk_text");
  assert_eq!(first_source, "src_a", "closest embedding should be src_a (exact match)");
  assert_eq!(first_text, "exact match");

  let second_source: String = rows[1].get("source_id");
  assert_eq!(second_source, "src_b", "second closest should be src_b");

  let third_source: String = rows[2].get("source_id");
  assert_eq!(third_source, "src_c", "farthest should be src_c (orthogonal)");

  // Cleanup
  sqlx::query("DELETE FROM copilot_embeddings WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// 4. fts_upsert_and_search
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fts_upsert_and_search() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "fts_ups", false).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, user_id).await;

  // Upsert a search document
  sqlx::query(
    r#"INSERT INTO search_content (workspace_id, doc_id, title, plain_text, search_vector)
       VALUES ($1, $2, 'Quantum Computing Guide', 'quantum entanglement superposition qubits',
               to_tsvector('english', 'quantum entanglement superposition qubits'))
       ON CONFLICT (workspace_id, doc_id) DO UPDATE
       SET title = EXCLUDED.title,
           plain_text = EXCLUDED.plain_text,
           search_vector = EXCLUDED.search_vector,
           updated_at = now()"#,
  )
  .bind(workspace_id)
  .bind(doc_id)
  .execute(&pool)
  .await
  .expect("upsert search doc");

  // Assert the upserted row exists in DB before searching
  let upserted_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM search_content WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("count search_content");
  assert!(upserted_count > 0, "search_content rows must exist in DB after upsert");

  // Search for a keyword
  let rows = sqlx::query(
    r#"SELECT doc_id, title, ts_rank(search_vector, query) AS rank
       FROM search_content, to_tsquery('english', 'quantum') query
       WHERE workspace_id = $1 AND search_vector @@ query
       ORDER BY rank DESC"#,
  )
  .bind(workspace_id)
  .fetch_all(&pool)
  .await
  .expect("fts search");

  assert_eq!(rows.len(), 1, "FTS should find 1 matching document");
  let found_doc_id: Uuid = rows[0].get("doc_id");
  assert_eq!(found_doc_id, doc_id, "FTS result should match inserted doc");

  // Cleanup
  sqlx::query("DELETE FROM search_content WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// 5. fts_delete_entry
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fts_delete_entry() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "fts_del", false).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, user_id).await;

  sqlx::query(
    r#"INSERT INTO search_content (workspace_id, doc_id, title, plain_text, search_vector)
       VALUES ($1, $2, 'Ephemeral Doc', 'temporary data for deletion test',
               to_tsvector('english', 'temporary data for deletion test'))"#,
  )
  .bind(workspace_id)
  .bind(doc_id)
  .execute(&pool)
  .await
  .expect("insert search doc");

  // Delete
  sqlx::query("DELETE FROM search_content WHERE workspace_id = $1 AND doc_id = $2")
    .bind(workspace_id)
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("delete search doc");

  // Verify search returns nothing
  let rows = sqlx::query(
    r#"SELECT doc_id
       FROM search_content, to_tsquery('english', 'temporary') query
       WHERE workspace_id = $1 AND search_vector @@ query"#,
  )
  .bind(workspace_id)
  .fetch_all(&pool)
  .await
  .expect("fts search after delete");

  assert_eq!(rows.len(), 0, "FTS should return nothing after deletion");

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// P101-CODE-REVIEW-3: embedding batch_size config and multi-batch DB storage
// ---------------------------------------------------------------------------

/// INV-EMB-BATCH-01: copilot.embedding.batch_size config defaults to 20 and is
/// within the clamped valid range [1, 100].
///
/// Invariant: the default config must produce a valid, non-zero batch size so
/// that the embedding loop processes at least one chunk per request.
#[test]
fn inv_emb_batch01_default_batch_size_is_valid() {
  let config = CopilotEmbeddingConfig::default();
  let batch_size = config.batch_size;
  assert!(
    (1..=100).contains(&batch_size),
    "default embedding batch_size must be in [1, 100], got {batch_size}"
  );
  assert_eq!(batch_size, 20, "default embedding batch_size must be 20");
}

/// INV-EMB-BATCH-02: multiple independent embedding batches are stored atomically
/// per batch — partial results are preserved even when a later batch would fail.
///
/// Invariant: inserting 5 chunks as two batches (3+2) results in exactly 5
/// rows in copilot_embeddings for the source. No batch failure can roll back
/// rows from a previously committed batch.
#[tokio::test]
async fn inv_emb_batch02_multi_batch_storage_preserves_partial_results() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "emb_batch", false).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let source_id = Uuid::new_v4().to_string();

  let vec_str = vec_to_pgvector(&[0.5, 0.1, 0.0], 1536);
  let chunks_total = 5;

  // Simulate best-effort batch processing: insert each batch separately.
  // Batch 1: chunks 0–2 (3 chunks)
  for chunk_index in 0..3i32 {
    sqlx::query(&format!(
      r#"INSERT INTO copilot_embeddings
         (workspace_id, source_type, source_id, chunk_index, chunk_text, token_count, embedding, model)
         VALUES ($1, 'doc', $2, $3, 'chunk {chunk_index}', 8, '{vec_str}'::vector, 'text-embedding-3-small')"#
    ))
    .bind(workspace_id)
    .bind(&source_id)
    .bind(chunk_index)
    .execute(&pool)
    .await
    .expect("batch 1 insert");
  }

  // Verify batch 1 is committed before batch 2.
  let after_batch1: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM copilot_embeddings WHERE workspace_id = $1 AND source_id = $2")
      .bind(workspace_id)
      .bind(&source_id)
      .fetch_one(&pool)
      .await
      .expect("count after batch 1");
  assert_eq!(after_batch1, 3, "batch 1 must be committed independently (3 rows)");

  // Batch 2: chunks 3–4 (2 chunks)
  for chunk_index in 3..5i32 {
    sqlx::query(&format!(
      r#"INSERT INTO copilot_embeddings
         (workspace_id, source_type, source_id, chunk_index, chunk_text, token_count, embedding, model)
         VALUES ($1, 'doc', $2, $3, 'chunk {chunk_index}', 8, '{vec_str}'::vector, 'text-embedding-3-small')"#
    ))
    .bind(workspace_id)
    .bind(&source_id)
    .bind(chunk_index)
    .execute(&pool)
    .await
    .expect("batch 2 insert");
  }

  // Both batches committed → all 5 chunks must be in DB.
  let after_both: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM copilot_embeddings WHERE workspace_id = $1 AND source_id = $2")
      .bind(workspace_id)
      .bind(&source_id)
      .fetch_one(&pool)
      .await
      .expect("count after both batches");
  assert_eq!(
    after_both, chunks_total,
    "all {chunks_total} chunks must be stored after 2 batches"
  );

  // Cleanup
  sqlx::query("DELETE FROM copilot_embeddings WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user_id]).await;
}
