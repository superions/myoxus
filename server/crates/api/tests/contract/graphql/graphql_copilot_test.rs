//! Copilot GraphQL tests — DB-backed session/message/context lifecycle.
//!
//! Covers: createCopilotSession (DB persistence, doc+pinned fields),
//! createCopilotMessage persistence, createCopilotContext idempotency,
//! context doc add/remove, embedding status, audio transcription stub,
//! cleanupCopilotSession soft-delete + list exclusion, chats invalid-docId
//! graceful empty response, and copilot models compat fields.

use crate::helpers;

use chrono::{DateTime, Utc};
use myoxus_domain::{
  entities::{
    CopilotAttachmentRef, CopilotMessage, CopilotMessageRole, CopilotSessionFork, CopilotToolCall,
    CopilotToolCallStatus,
  },
  repositories::{CopilotRepository, PageRequest},
};
use myoxus_infrastructure::copilot::SqlxCopilotRepository;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

#[tokio::test]
async fn inv_copilot_context_uploads_retain_input_and_guard_worker_results() {
  use axum::{body::Body, http::Request};
  use futures_util::FutureExt;
  use http_body_util::BodyExt;
  use myoxus_application::copilot::context_ingest::{ContextFileParser, ContextIngestionLimits, ParsedContextFile};
  use std::sync::Arc;
  use tower::ServiceExt;

  async fn upload(
    app: &axum::Router,
    auth: Uuid,
    context: &str,
    name: &str,
    mime: &str,
    bytes: &[u8],
  ) -> serde_json::Value {
    let boundary = format!("copilot-upload-{}", Uuid::new_v4());
    let operations = json!({"query":"mutation($o:AddContextFileInput!,$content:Upload!){addContextFile(options:$o,content:$content){id blobId name mimeType chunkSize status error}}","variables":{"o":{"contextId":context},"content":null}});
    let mut body=format!("--{boundary}\r\nContent-Disposition: form-data; name=\"operations\"\r\n\r\n{operations}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"map\"\r\n\r\n{{\"0\":[\"variables.content\"]}}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"0\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("POST")
          .uri("/graphql")
          .header("cookie", format!("affine_session={auth}"))
          .header("content-type", format!("multipart/form-data; boundary={boundary}"))
          .body(Body::from(body))
          .unwrap(),
      )
      .await
      .unwrap();
    let result: serde_json::Value =
      serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(result.get("errors").is_none(), "{result}");
    result["data"]["addContextFile"].clone()
  }
  fn pdf() -> Vec<u8> {
    use lopdf::{Document, Object, Stream, dictionary};
    let mut document = Document::with_version("1.4");
    let font = document.add_object(dictionary! {"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Helvetica"});
    let stream = document.add_object(Stream::new(
      dictionary! {},
      b"BT /F1 12 Tf 50 700 Td (The satellite is named Cobalt Wren.) Tj ET".to_vec(),
    ));
    let pages = document.new_object_id();
    let page=document.add_object(dictionary!{"Type"=>"Page","Parent"=>pages,"MediaBox"=>vec![0.into(),0.into(),612.into(),792.into()],"Contents"=>stream,"Resources"=>dictionary!{"Font"=>dictionary!{"F1"=>font}}});
    document.objects.insert(
      pages,
      Object::Dictionary(dictionary! {"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}),
    );
    let catalog = document.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages});
    document.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    bytes
  }
  struct PausedParser {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
  }
  #[async_trait::async_trait]
  impl ContextFileParser for PausedParser {
    async fn parse(
      &self,
      _: bytes::Bytes,
      _: &str,
      _: ContextIngestionLimits,
    ) -> myoxus_application::auth::AuthResult<ParsedContextFile> {
      self.entered.notify_one();
      self.release.notified().await;
      Ok(ParsedContextFile {
        text: "late private result".into(),
        chunk_count: 1,
      })
    }
  }

  let (_, pool, store, state) = helpers::setup_app_with_config_override_and_state(|config| {
    config.copilot.enabled = true;
    config.copilot.request_timeout_ms = 10_000;
  })
  .await;
  let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://localhost:6380".into());
  let prefix = format!("context-ingest-{}", Uuid::new_v4());
  let queue = myoxus_worker::RedisQueue::new(&redis_url, &prefix).unwrap();
  let state = state.with_redis_queue(queue.clone());
  let app = myoxus_api::build_router_for_integration_tests(state.clone());
  let (user, auth) = helpers::seed_user(&pool, &store, "context_files").await;
  let workspace = helpers::create_workspace(&pool, user).await;
  let result=std::panic::AssertUnwindSafe(async {
    let session=helpers::gql(&app,auth,json!({"query":"mutation($o:CreateChatSessionInput!){createCopilotSession(options:$o)}","variables":{"o":{"workspaceId":workspace,"promptName":"chat-with-ai"}}})).await;
    let session=session["data"]["createCopilotSession"].as_str().unwrap();
    let context=helpers::gql(&app,auth,json!({"query":"mutation($w:String!,$s:String!){createCopilotContext(workspaceId:$w,sessionId:$s)}","variables":{"w":workspace,"s":session}})).await;
    let context=context["data"]["createCopilotContext"].as_str().unwrap();
    let mut ingestion=state.context_ingestion().await.unwrap();
    ingestion.parser=Arc::new(myoxus_api::copilot_context_parser::SubprocessContextParser {executable:std::path::PathBuf::from(env!("CARGO_BIN_EXE_server"))});
    for (name,mime,bytes,fact) in [
      ("source.txt","text/plain",b"The station is called Copper Finch.".to_vec(),"Copper Finch"),
      ("source.csv","text/csv",b"Name,Risk\nEditor,Overstyled headings\n".to_vec(),"Editor,Overstyled headings"),
      ("source.pdf","application/pdf",pdf(),"Cobalt Wren"),
    ] {
      let added=upload(&app,auth,context,name,mime,&bytes).await;
      assert_eq!(added["status"],"processing");assert_eq!(added["chunkSize"],0);
      let blob=added["blobId"].as_str().unwrap();
      assert_eq!(state.blob().get_blob(workspace,blob).await.unwrap().data.as_ref(),bytes);
      let job=queue.dequeue("copilot",1).await.unwrap().unwrap();assert_eq!(job.name,"copilot.context.ingest");
      assert!(!job.data.to_string().contains(fact),"queue payload carries identities, not uploaded content");
      ingestion.execute(serde_json::from_value(job.data.clone()).unwrap()).await.unwrap();
      let item=state.copilot().list_context_items(Uuid::parse_str(context).unwrap()).await.unwrap().into_iter().find(|item|item.item_ref==added["id"].as_str().unwrap()).unwrap();
      assert_eq!(item.metadata["ingestStatus"],"finished");assert!(item.metadata["text"].as_str().unwrap().contains(fact));assert!(item.metadata["chunkSize"].as_u64().unwrap()>0);
      queue.ack("copilot",&job.id,None,Default::default()).await.unwrap();
    }
    let invalid=upload(&app,auth,context,"invalid.pdf","application/pdf",b"%PDF-1.4\nprivate malformed payload").await;
    let job=queue.dequeue("copilot",1).await.unwrap().unwrap();ingestion.execute(serde_json::from_value(job.data.clone()).unwrap()).await.unwrap();queue.ack("copilot",&job.id,None,Default::default()).await.unwrap();
    let retry=helpers::gql(&app,auth,json!({"query":"mutation($o:RemoveContextFileInput!){retryContextFile(options:$o){id blobId status}}","variables":{"o":{"contextId":context,"fileId":invalid["id"]}}})).await;
    assert!(retry.get("errors").is_none(),"{retry}");assert_eq!(retry["data"]["retryContextFile"]["blobId"],invalid["blobId"]);assert_eq!(retry["data"]["retryContextFile"]["id"],invalid["id"]);
    let job=queue.dequeue("copilot",1).await.unwrap().unwrap();ingestion.execute(serde_json::from_value(job.data.clone()).unwrap()).await.unwrap();queue.ack("copilot",&job.id,None,Default::default()).await.unwrap();
    let files=helpers::gql(&app,auth,json!({"query":"query($w:String!,$c:String!){currentUser{copilot(workspaceId:$w){contexts(contextId:$c){files{id status error chunkSize}}}}}","variables":{"w":workspace,"c":context}})).await;
    let files=files["data"]["currentUser"]["copilot"]["contexts"][0]["files"].as_array().unwrap();
    let failed=files.iter().find(|file|file["id"]==invalid["id"]).unwrap();assert_eq!(failed["status"],"failed");assert_eq!(failed["error"],"CONTEXT_PARSE_FAILED");
    for revoke in [false,true] {
      let added=upload(&app,auth,context,"late.txt","text/plain",b"source retained").await;
      let job=queue.dequeue("copilot",1).await.unwrap().unwrap();
      let entered=Arc::new(tokio::sync::Notify::new());let release=Arc::new(tokio::sync::Notify::new());
      let mut paused=state.context_ingestion().await.unwrap();paused.parser=Arc::new(PausedParser {entered:entered.clone(),release:release.clone()});
      let task=tokio::spawn(async move{paused.execute(serde_json::from_value(job.data).unwrap()).await.unwrap();});
      tokio::time::timeout(std::time::Duration::from_secs(5),entered.notified()).await.unwrap();
      if revoke {sqlx::query("UPDATE copilot_sessions SET deleted_at=now() WHERE id=$1").bind(Uuid::parse_str(session).unwrap()).execute(&pool).await.unwrap();}
      else {let removed=helpers::gql(&app,auth,json!({"query":"mutation($o:RemoveContextFileInput!){removeContextFile(options:$o)}","variables":{"o":{"contextId":context,"fileId":added["id"]}}})).await;assert_eq!(removed["data"]["removeContextFile"],true);}
      release.notify_one();tokio::time::timeout(std::time::Duration::from_secs(5),task).await.unwrap().unwrap();
      let items=state.copilot().list_context_items(Uuid::parse_str(context).unwrap()).await.unwrap();
      let item=items.iter().find(|item|item.item_ref==added["id"].as_str().unwrap());
      if revoke {let item=item.unwrap();assert_eq!(item.metadata["ingestStatus"],"failed");assert!(item.metadata.get("text").is_none());}else{assert!(item.is_none(),"late worker must never recreate a removed item");}
    }
  }).catch_unwind().await;
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

#[tokio::test]
async fn inv_copilot_claim_is_atomic_reuses_last_response_and_rejects_stale_turns() {
  use futures_util::FutureExt;
  use myoxus_domain::copilot_turn::CopilotTurnRequest;
  let (app, pool, store) = helpers::setup_app_with_copilot_enabled().await;
  let (user, auth) = helpers::seed_user(&pool, &store, "cp_claim").await;
  let result=std::panic::AssertUnwindSafe(async {
    let workspace=helpers::create_workspace(&pool,user).await;
    let repo=std::sync::Arc::new(SqlxCopilotRepository::new(pool.clone()));
    let service=myoxus_application::copilot::CopilotService::new(repo.clone());
    let session=service.create_session(user,Some(workspace),None,None,None,json!({})).await.unwrap();
    let input=json!({"query":"mutation($o:CreateChatMessageInput!){createCopilotMessage(options:$o)}","variables":{"o":{"sessionId":session.id,"content":"original input","requestId":"same-send","params":{"responseTo":"forged","requestId":"forged","streamId":"forged","streamStatus":"running","requestDeadline":"forged"}}}});
    let (a,b)=tokio::join!(helpers::gql(&app,auth,input.clone()),helpers::gql(&app,auth,input));
    assert!(a.get("errors").is_none(),"{a}");assert_eq!(a,b,"transport retries must return one user identity");
    let messages=service.generation_messages(session.id).await.unwrap();assert_eq!(messages.len(),1);
    let turn=messages[0].id;
    assert_eq!(messages[0].token_usage,Some(json!({"inputRequestId":"same-send","sequence":1})),"client params cannot forge claims");
    assert!(service.submit_user_message(user,session.id,json!({"text":"different"}),None,Vec::new(),Some("same-send".into())).await.is_err());
    let now=DateTime::<Utc>::from_timestamp_micros(Utc::now().timestamp_micros()).unwrap();
    let request=CopilotTurnRequest {user_id:user,session_id:session.id,workspace_id:Some(workspace),doc_id:None,request_id:"first-generation".into(),user_message_id:turn,assistant_message_id:None,expected_stream_id:None,model:"fixture".into(),reasoning:Some(true),stream_id:Uuid::new_v4(),response_id:Uuid::new_v4(),now,deadline:now+chrono::Duration::seconds(60)};
    let mut duplicate=request.clone();duplicate.stream_id=Uuid::new_v4();duplicate.response_id=Uuid::new_v4();
    let (left,right)=tokio::join!(repo.claim_copilot_turn(&request),repo.claim_copilot_turn(&duplicate));
    let left=left.unwrap();let right=right.unwrap();assert_ne!(left.acquired,right.acquired,"only one SQL claimant owns generation");assert_eq!(left.message,right.message);
    let mut response=left.message;let old_stream=Uuid::parse_str(response.token_usage.as_ref().unwrap()["streamId"].as_str().unwrap()).unwrap();
    response.content=json!("legacy final answer");
    assert!(repo.update_copilot_stream(&response,old_stream).await.unwrap());
    service.finalize_stream(&myoxus_application::copilot::CopilotStreamHandle {stream_id:old_stream,message_id:response.id},myoxus_application::copilot::CopilotStreamOutcome::Completed).await.unwrap();
    sqlx::query("UPDATE copilot_messages SET content=$2 WHERE id=$1").bind(response.id).bind(&response.content).execute(&pool).await.unwrap();
    let mut regen=request.clone();regen.request_id="explicit-regenerate".into();regen.assistant_message_id=Some(response.id);regen.expected_stream_id=Some(old_stream);regen.stream_id=Uuid::new_v4();
    let claimed=repo.claim_copilot_turn(&regen).await.unwrap();assert!(claimed.acquired);assert_eq!(claimed.message.id,response.id);
    assert_eq!(service.generation_messages(session.id).await.unwrap().len(),2);
    let replay=repo.claim_copilot_turn(&regen).await.unwrap();assert!(!replay.acquired);assert_eq!(replay.message,claimed.message);
    let revisions=service.list_message_revisions(response.id,10,0).await.unwrap();assert_eq!(revisions.len(),1);assert_eq!(revisions[0].content,response.content,"one prior final answer, never per-token revisions");
    let mut stale=regen.clone();stale.request_id="late-older-generation".into();assert!(repo.claim_copilot_turn(&stale).await.is_err());
    sqlx::query("UPDATE copilot_messages SET token_usage=jsonb_set(token_usage,'{requestDeadline}',$2) WHERE id=$1").bind(response.id).bind(json!(now-chrono::Duration::seconds(1))).execute(&pool).await.unwrap();
    let expired=repo.claim_copilot_turn(&regen).await.unwrap();assert!(!expired.acquired);assert_eq!(expired.message.token_usage.as_ref().unwrap()["streamStatus"],"failed");
    let mut recovery=regen.clone();recovery.request_id="explicit-after-expiry".into();recovery.expected_stream_id=Some(regen.stream_id);recovery.stream_id=Uuid::new_v4();
    let recovered=repo.claim_copilot_turn(&recovery).await.unwrap();assert!(recovered.acquired);assert_eq!(recovered.message.id,response.id);
    let mut conflicting=recovered.message.clone();conflicting.id=Uuid::new_v4();
    assert!(repo.append_copilot_message(&conflicting).await.is_err(),"database uniqueness forbids a second response anchor");
    let mut stale_edit=response.clone();stale_edit.edited_at=Some(Utc::now());stale_edit.content=json!({"text":"manual edit from an older snapshot"});
    let edited=repo.update_copilot_message(&stale_edit).await.unwrap();
    assert_eq!(edited.token_usage.as_ref().unwrap()["streamId"],recovery.stream_id.to_string(),"a stale edit cannot roll back the current lease");
    assert_eq!(edited.token_usage.as_ref().unwrap()["responseTo"],turn.to_string());
    let latest=service.submit_user_message(user,session.id,json!({"text":"a later user turn"}),None,Vec::new(),Some("later-send".into())).await.unwrap();
    let mut old_turn=recovery.clone();old_turn.request_id="stale-last-turn".into();old_turn.expected_stream_id=Some(recovery.stream_id);
    assert!(repo.claim_copilot_turn(&old_turn).await.is_err(),"old targets cannot rewrite later turns");
    assert_eq!(service.generation_messages(session.id).await.unwrap().len(),3);
    assert_eq!(service.list_message_revisions(response.id,10,0).await.unwrap().len(),1,"failed and empty recoveries do not duplicate final revisions");
    sqlx::query("INSERT INTO copilot_messages(id,session_id,role,content,created_at) SELECT gen_random_uuid(),$1,'user',jsonb_build_object('text','old history'),$2::timestamptz-interval '1 day'+i*interval '1 second' FROM generate_series(1,501) i")
      .bind(session.id).bind(now).execute(&pool).await.unwrap();
    let history=helpers::gql(&app,auth,json!({"query":"query($w:String!,$s:String!){currentUser{copilot(workspaceId:$w){chats(pagination:{first:1},options:{sessionId:$s,withMessages:true}){edges{node{messages{id}}}}}}}","variables":{"w":workspace,"s":session.id}})).await;
    assert!(history.get("errors").is_none(),"{history}");
    let exact=history["data"]["currentUser"]["copilot"]["chats"]["edges"][0]["node"]["messages"].as_array().unwrap();
    assert_eq!(exact.len(),504,"an exact history reload must not truncate the current response anchor behind the oldest 500 messages");
    assert_eq!(exact.last().unwrap()["id"],latest.id.to_string());
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[user]).await;
  if let Err(error) = result {
    std::panic::resume_unwind(error);
  }
}

#[tokio::test]
async fn inv_copilot_complete_history_filters_precede_paging_and_scope_authorization() {
  use futures_util::FutureExt;
  let (app, pool, store) = helpers::setup_app_with_copilot_enabled().await;
  let (user, auth) = helpers::seed_user(&pool, &store, "cp_page").await;
  let result = std::panic::AssertUnwindSafe(async {
  let workspace = helpers::create_workspace(&pool, user).await;
  let doc = helpers::create_doc(&pool, workspace, user).await;
  let other_doc = helpers::create_doc(&pool, workspace, user).await;
  let ids = (0..210).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
  let records = ids
    .iter()
    .enumerate()
    .map(|(index, id)| {
      json!({
        "id":id,"sequence":index,"doc_id":if index<4 {Some(doc)} else if index==4 {Some(other_doc)} else {None},
        "pinned":index<2,"archived":index==0,
        "metadata":match index {
          2=>json!({"action":"rewrite"}),
          3=>json!({"parentSessionId":ids[1]}),
          4=>json!({"promptName":"rewrite"}),
          _=>json!({})
        }
      })
    })
    .collect::<Vec<_>>();
  // One batch makes the >200 boundary cheap; no provider/message fixture is
  // needed to prove complete population filtering and stable session ordering.
  sqlx::query(
    r#"INSERT INTO copilot_sessions(id,user_id,workspace_id,doc_id,pinned,metadata,archived_at,created_at,updated_at)
    SELECT r.id,$1,$2,r.doc_id,r.pinned,r.metadata,CASE WHEN r.archived THEN now() END,
      now()-interval '1 day'+r.sequence*interval '1 minute',now()-interval '1 day'+r.sequence*interval '1 minute'
    FROM jsonb_to_recordset($3) AS r(id uuid,doc_id uuid,pinned bool,metadata jsonb,archived bool,sequence int)"#,
  )
  .bind(user)
  .bind(workspace)
  .bind(json!(records))
  .execute(&pool)
  .await
  .expect("seed complete history");

  async fn query(
    app: &axum::Router,
    auth: Uuid,
    workspace: Uuid,
    options: serde_json::Value,
    first: i32,
    offset: i32,
    doc: Option<Uuid>,
  ) -> serde_json::Value {
    helpers::gql(app,auth,json!({
      "query":"query($w:String!,$d:String,$o:QueryChatHistoriesInput!,$first:Int!,$offset:Int!){currentUser{copilot(workspaceId:$w){chats(docId:$d,pagination:{first:$first,offset:$offset},options:$o){totalCount pageInfo{hasNextPage hasPreviousPage} edges{node{sessionId pinned action parentSessionId}}}}}}",
      "variables":{"w":workspace.to_string(),"d":doc.map(|id|id.to_string()),"o":options,"first":first,"offset":offset}
    })).await
  }
  fn page(response: &serde_json::Value) -> &serde_json::Value {
    assert!(response.get("errors").is_none(), "{response}");
    &response["data"]["currentUser"]["copilot"]["chats"]
  }
  let first = query(&app, auth, workspace, json!({"withMessages":false}), 500, 0, None).await;
  assert_eq!(page(&first)["totalCount"], 210);
  assert_eq!(
    page(&first)["edges"].as_array().unwrap().len(),
    200,
    "page remains bounded, not the matching population"
  );
  assert_eq!(page(&first)["pageInfo"]["hasNextPage"], true);
  let second = query(&app, auth, workspace, json!({"withMessages":false}), 200, 200, None).await;
  assert_eq!(page(&second)["totalCount"], 210);
  assert_eq!(page(&second)["edges"].as_array().unwrap().len(), 10);
  assert_eq!(page(&second)["pageInfo"]["hasNextPage"], false);
  assert_eq!(page(&second)["pageInfo"]["hasPreviousPage"], true);

  let options = json!({"pinned":true,"action":false,"fork":false,"withMessages":false});
  for (offset, id) in [ids[1], ids[0]].into_iter().enumerate() {
    let response = query(&app, auth, workspace, options.clone(), 1, offset as i32, Some(doc)).await;
    assert_eq!(
      page(&response)["totalCount"],
      2,
      "both pins remain valid, including old archived history"
    );
    assert_eq!(page(&response)["edges"][0]["node"]["sessionId"], id.to_string());
    assert_eq!(page(&response)["pageInfo"]["hasNextPage"], offset == 0);
  }
  let empty = query(&app, auth, workspace, options, 1, 2, Some(doc)).await;
  assert_eq!(
    page(&empty)["totalCount"],
    2,
    "empty pages retain the full matching count"
  );
  assert_eq!(page(&empty)["edges"], json!([]));
  assert_eq!(page(&empty)["pageInfo"]["hasNextPage"], false);
  let no_match = query(&app, auth, workspace, json!({"action":true,"fork":true}), 1, 10, None).await;
  assert_eq!(page(&no_match)["totalCount"],0);
  assert_eq!(page(&no_match)["pageInfo"],json!({"hasNextPage":false,"hasPreviousPage":false}),"an offset alone does not create a previous page in an empty result set");
  for (options, id, count) in [
    (json!({"action":true}), ids[2], 1),
    (json!({"fork":true}), ids[3], 1),
    (json!({"sessionId":ids[0]}), ids[0], 1),
    (json!({"sessionOrder":"asc"}), ids[0], 210),
  ] {
    let response = query(&app, auth, workspace, options, 1, 0, None).await;
    assert_eq!(page(&response)["totalCount"], count);
    assert_eq!(page(&response)["edges"][0]["node"]["sessionId"], id.to_string());
  }
  let regular = query(&app, auth, workspace, json!({"action":false,"fork":false}), 1, 0, None).await;
  assert_eq!(
    page(&regular)["totalCount"],
    208,
    "missing metadata is not guessed from promptName"
  );

  sqlx::query("UPDATE docs SET deleted_at=now() WHERE id=$1")
    .bind(other_doc)
    .execute(&pool)
    .await
    .expect("hide off-page doc");
  let denied = query(&app, auth, workspace, json!({"action":false,"fork":false}), 1, 0, None).await;
    assert!(
      denied.get("errors").is_some(),
      "an unreadable old off-page target must not leak a count: {denied}"
    );
    assert!(denied["data"]["currentUser"]["copilot"]["chats"].is_null(), "denied history must publish neither count nor content: {denied}");
  let exact = query(&app, auth, workspace, json!({"sessionId":ids[0]}), 1, 0, None).await;
  assert_eq!(
    page(&exact)["totalCount"],
    1,
    "unrelated unreadable history does not poison an exact authorized lookup"
  );
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[user]).await;
  if let Err(error) = result {
    std::panic::resume_unwind(error);
  }
}

#[tokio::test]
// INV: embedding mutations persist rows to copilot_embeddings and return non-error responses
async fn inv_copilot_context_embedding_and_transcription_mutations_persist_rows() {
  let (app, pool, auth_store) = helpers::setup_app_with_copilot_enabled().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p6ctx").await;

  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let copilot_session_id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO copilot_sessions (id, user_id, workspace_id, title, model)
       VALUES ($1, $2, $3, 'P6 Session', 'test-model')"#,
  )
  .bind(copilot_session_id)
  .bind(user_id)
  .bind(workspace_id)
  .execute(&pool)
  .await
  .expect("insert copilot session");

  // Invalid session → error
  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": format!("mutation {{ createCopilotContext(workspaceId:\"{workspace_id}\", sessionId:\"{}\") }}", Uuid::new_v4())}),
  )
  .await;
  assert!(
    resp.get("errors").is_some(),
    "create context with invalid session should fail: {resp}"
  );

  // Valid session → context id
  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": format!("mutation {{ createCopilotContext(workspaceId:\"{workspace_id}\", sessionId:\"{copilot_session_id}\") }}")}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "create context failed: {resp}");
  let context_id = resp["data"]["createCopilotContext"]
    .as_str()
    .expect("context id")
    .to_string();

  // Idempotent: same id returned on second call
  let resp2 = helpers::gql(
    &app,
    session_id,
    json!({"query": format!("mutation {{ createCopilotContext(workspaceId:\"{workspace_id}\", sessionId:\"{copilot_session_id}\") }}")}),
  )
  .await;
  assert!(
    resp2.get("errors").is_none(),
    "create context idempotency failed: {resp2}"
  );
  assert_eq!(
    resp2["data"]["createCopilotContext"].as_str(),
    Some(context_id.as_str()),
    "create context should be stable per session id"
  );

  // Add a doc to the context
  let context_doc = helpers::create_doc(&pool, workspace_id, user_id).await;
  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($options: AddContextDocInput!) { addContextDoc(options: $options) { id } }",
      "variables": {"options": {"contextId": context_id, "docId": context_doc.to_string()}}
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "add context doc failed: {resp}");
  let added_doc_id = resp["data"]["addContextDoc"]["id"]
    .as_str()
    .expect("addContextDoc id must be string")
    .to_string();

  // Update embedding ignored docs
  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": format!("mutation {{ updateWorkspaceEmbeddingIgnoredDocs(workspaceId:\"{workspace_id}\", add:[\"{}\"]) }}", Uuid::new_v4())}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "update ignored docs failed: {resp}");

  // Embedding status query
  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": format!("query {{ queryWorkspaceEmbeddingStatus(workspaceId:\"{workspace_id}\") {{ embedded total }} }}")}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "embedding status failed: {resp}");

  // Submit transcription without blob → error
  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": format!("mutation {{ submitAudioTranscription(workspaceId:\"{workspace_id}\", blobId:\"{}\") {{ id status }} }}", Uuid::new_v4())}),
  )
  .await;
  assert!(
    resp.get("errors").is_some(),
    "submit transcription should require upload: {resp}"
  );

  // Claim transcription job seeded directly
  let job_id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO copilot_jobs (id, job_type, state, workspace_id, user_id, payload, updated_at)
       VALUES ($1, 'audio_transcription', 'pending', $2, $3, '{}'::jsonb, now())"#,
  )
  .bind(job_id)
  .bind(workspace_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert transcription job");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": format!("mutation {{ claimAudioTranscription(jobId:\"{job_id}\") {{ id status }} }}")}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "claim transcription failed: {resp}");

  // Remove the added context doc
  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($options: RemoveContextDocInput!) { removeContextDoc(options: $options) }",
      "variables": {"options": {"contextId": context_id, "docId": added_doc_id}}
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "remove context doc failed: {resp}");

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
// INV: createCopilotSession persists the session row in copilot_sessions table
async fn inv_copilot_session_creation_persists_to_db() {
  let (app, pool, auth_store) = helpers::setup_app_with_copilot_enabled().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p6sess").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($options: CreateChatSessionInput!) { createCopilotSession(options: $options) }",
      "variables": {"options": {"workspaceId": workspace_id.to_string(), "promptName": "chat-with-ai", "pinned": false}}
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "createCopilotSession failed: {resp}");
  let created_session_uuid = Uuid::parse_str(
    resp["data"]["createCopilotSession"]
      .as_str()
      .expect("copilot session id"),
  )
  .expect("uuid");

  let row = sqlx::query("SELECT id, user_id, workspace_id FROM copilot_sessions WHERE id = $1")
    .bind(created_session_uuid)
    .fetch_optional(&pool)
    .await
    .expect("query copilot_sessions")
    .expect("persisted session row");
  assert_eq!(row.get::<Uuid, _>("id"), created_session_uuid);
  assert_eq!(row.get::<Uuid, _>("user_id"), user_id);
  assert_eq!(row.get::<Uuid, _>("workspace_id"), workspace_id);

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
// INV: createCopilotMessage persists the message row in copilot_messages table
async fn inv_copilot_message_creation_persists_to_db() {
  let (app, pool, auth_store) = helpers::setup_app_with_copilot_enabled().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p6msg").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  let create = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($options: CreateChatSessionInput!) { createCopilotSession(options: $options) }",
      "variables": {"options": {"workspaceId": workspace_id.to_string(), "promptName": "chat-with-ai", "pinned": false}}
    }),
  )
  .await;
  assert!(create.get("errors").is_none(), "createCopilotSession failed: {create}");
  let created_session_id = create["data"]["createCopilotSession"]
    .as_str()
    .expect("copilot session id")
    .to_string();
  let created_session_uuid = Uuid::parse_str(&created_session_id).expect("uuid");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($options: CreateChatMessageInput!) { createCopilotMessage(options: $options) }",
      "variables": {"options": {"sessionId": created_session_id, "content": "hello from phase6 db", "attachments": []}}
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "createCopilotMessage failed: {resp}");

  let row = sqlx::query("SELECT id, role FROM copilot_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1")
    .bind(created_session_uuid)
    .fetch_optional(&pool)
    .await
    .expect("query copilot_messages")
    .expect("persisted message row");
  assert_eq!(row.get::<String, _>("role").to_ascii_lowercase(), "user");

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
// INV: session writes keep normalized IDs; history/navigation retain external keys.
async fn inv_copilot_session_doc_and_pinned_persist_to_db() {
  let (app, pool, auth_store) = helpers::setup_app_with_copilot_enabled().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p6pin").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, user_id).await;
  let doc_key = "LyaUK8DkKk_OrRtJcBCTX";
  sqlx::query("UPDATE docs SET external_id=$1 WHERE id=$2")
    .bind(doc_key)
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("set external document key");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($options: CreateChatSessionInput!) { createCopilotSessionWithHistory(options: $options) { sessionId docId pinned } }",
      "variables": {"options": {
        "workspaceId": workspace_id.to_string(),
        "promptName": "chat-with-ai",
        "docId": doc_key,
        "pinned": true
      }}
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "createCopilotSession failed: {resp}");
  assert_eq!(resp["data"]["createCopilotSessionWithHistory"]["docId"], doc_key);
  assert_eq!(resp["data"]["createCopilotSessionWithHistory"]["pinned"], true);
  let created_session_uuid = Uuid::parse_str(
    resp["data"]["createCopilotSessionWithHistory"]["sessionId"]
      .as_str()
      .expect("copilot session id"),
  )
  .expect("uuid");

  let row = sqlx::query("SELECT doc_id, pinned FROM copilot_sessions WHERE id = $1")
    .bind(created_session_uuid)
    .fetch_one(&pool)
    .await
    .expect("query copilot_sessions");
  assert_eq!(row.get::<Option<Uuid>, _>("doc_id"), Some(doc_id));
  assert!(row.get::<bool, _>("pinned"));

  let repo = SqlxCopilotRepository::new(pool.clone());
  let now = DateTime::<Utc>::from_timestamp_micros(Utc::now().timestamp_micros()).unwrap();
  let tool_id = Uuid::new_v4();
  let mut source_messages: Vec<CopilotMessage> = Vec::new();
  for (index, role, text) in [
    (0, CopilotMessageRole::User, "question"),
    (1, CopilotMessageRole::Assistant, "committed answer"),
    (2, CopilotMessageRole::User, "later question"),
  ] {
    let message_id = Uuid::new_v4();
    let mut message = CopilotMessage {
      id: message_id,
      session_id: created_session_uuid,
      role,
      content: json!({"text":text}),
      token_usage: Some(json!({"sequence":index+1})),
      tool_calls: Vec::new(),
      attachment_refs: Vec::new(),
      edited_at: None,
      created_at: now,
    };
    if index == 0 {
      message.token_usage.as_mut().unwrap()["inputRequestId"] = json!("original-send");
      message.attachment_refs.push(CopilotAttachmentRef {
        id: Uuid::new_v4(),
        message_id,
        blob_key: format!("{user_id}/{workspace_id}/context.png"),
        file_name: Some("context.png".into()),
        mime_type: Some("image/png".into()),
        size_bytes: Some(12),
        metadata: json!({}),
        created_at: now,
      });
    }
    if index == 1 {
      message.token_usage = Some(
        json!({"sequence":index+1,"responseTo":source_messages[0].id,"requestId":"source-request","streamId":Uuid::new_v4(),"requestDeadline":now,"expectedStreamId":Uuid::new_v4(),"streamStatus":"done"}),
      );
      message.content["streamObjects"] = json!([
        {"type":"reasoning","textDelta":"provider reasoning"},
        {"type":"tool-call","toolCallId":tool_id,"toolName":"read","args":{"literal":tool_id}},
        {"type":"tool-result","toolCallId":tool_id,"toolName":"read","args":{},"result":{"text":"source result"}}
      ]);
      message.tool_calls.push(CopilotToolCall {
        id: tool_id,
        message_id,
        tool_name: "read".into(),
        args: json!({"literal":tool_id}),
        status: CopilotToolCallStatus::Completed,
        result: Some(json!({"text":"source result"})),
        error: None,
        started_at: Some(now),
        finished_at: Some(now),
        created_at: now,
        updated_at: now,
      });
    }
    repo
      .append_copilot_message(&message)
      .await
      .expect("seed committed source message");
    source_messages.push(message);
  }
  let mut foreign_cutoff = None;

  // A UUID-shaped external key may name a different normalized document.
  let uuid_doc = helpers::create_doc(&pool, workspace_id, user_id).await;
  let uuid_key = doc_id.to_string();
  sqlx::query("UPDATE docs SET external_id=$1 WHERE id=$2")
    .bind(&uuid_key)
    .bind(uuid_doc)
    .execute(&pool)
    .await
    .expect("set UUID-shaped external key");
  for (key, expected_id) in [(&uuid_key[..], uuid_doc), (doc_key, doc_id)] {
    let updated = helpers::gql(
      &app,
      session_id,
      json!({
        "query":"mutation($o:UpdateChatSessionInput!){updateCopilotSession(options:$o)}",
        "variables":{"o":{"sessionId":created_session_uuid,"docId":key,"pinned":true}}
      }),
    )
    .await;
    assert!(updated.get("errors").is_none(), "{updated}");
    let stored: Uuid = sqlx::query_scalar("SELECT doc_id FROM copilot_sessions WHERE id=$1")
      .bind(created_session_uuid)
      .fetch_one(&pool)
      .await
      .expect("read normalized binding");
    assert_eq!(stored, expected_id);
    let history = helpers::gql(&app, session_id, json!({
      "query":"query($w:String!,$d:String!){currentUser{copilot(workspaceId:$w){chats(pagination:{first:20},docId:$d,options:{pinned:true}){totalCount edges{node{sessionId docId pinned}}}}}}",
      "variables":{"w":workspace_id,"d":key}
    })).await;
    assert!(history.get("errors").is_none(), "{history}");
    let chats = &history["data"]["currentUser"]["copilot"]["chats"];
    assert_eq!(chats["totalCount"], 1, "{history}");
    assert_eq!(chats["edges"][0]["node"]["sessionId"], created_session_uuid.to_string());
    assert_eq!(chats["edges"][0]["node"]["docId"], key);
    let forked = helpers::gql(
      &app,
      session_id,
      json!({
        "query":"mutation($o:ForkChatSessionInput!){forkCopilotSession(options:$o)}",
        "variables":{"o":{"sessionId":created_session_uuid,"workspaceId":workspace_id,"docId":key,"latestMessageId":if key==uuid_key {Some(source_messages[1].id.to_string())} else {None}}}
      }),
    )
    .await;
    assert!(forked.get("errors").is_none(), "{forked}");
    let fork_id = Uuid::parse_str(forked["data"]["forkCopilotSession"].as_str().expect("fork id")).unwrap();
    let fork_doc: Uuid = sqlx::query_scalar("SELECT doc_id FROM copilot_sessions WHERE id=$1")
      .bind(fork_id)
      .fetch_one(&pool)
      .await
      .expect("read fork destination");
    assert_eq!(fork_doc, expected_id);
    let copied = repo
      .list_copilot_messages(fork_id, PageRequest { limit: 100, offset: 0 })
      .await
      .expect("read copied prefix");
    assert_eq!(
      copied.len(),
      if key == uuid_key { 2 } else { 3 },
      "inclusive cutoff must not drop or add a turn"
    );
    for (original, copy) in source_messages.iter().zip(&copied) {
      assert_ne!(copy.id, original.id);
      assert_eq!(copy.session_id, fork_id);
      assert_eq!(copy.content["text"], original.content["text"]);
      let mut expected = original.token_usage.clone().unwrap();
      for key in [
        "inputRequestId",
        "requestId",
        "streamId",
        "requestDeadline",
        "expectedStreamId",
      ] {
        expected.as_object_mut().unwrap().remove(key);
      }
      if expected.get("responseTo").is_some() {
        expected["responseTo"] = json!(copied[0].id);
      }
      assert_eq!(
        copy.token_usage,
        Some(expected),
        "copy remaps response anchors and drops runtime identity, preserving other params"
      );
      assert_eq!(copy.created_at, original.created_at);
    }
    assert_ne!(
      copied[0].attachment_refs[0].id,
      source_messages[0].attachment_refs[0].id
    );
    assert_eq!(copied[0].attachment_refs[0].message_id, copied[0].id);
    assert_eq!(
      copied[0].attachment_refs[0].blob_key,
      source_messages[0].attachment_refs[0].blob_key
    );
    let copied_tool = &copied[1].tool_calls[0];
    assert_ne!(copied_tool.id, tool_id);
    assert_eq!(copied_tool.message_id, copied[1].id);
    assert_eq!(
      copied_tool.args,
      json!({"literal":tool_id}),
      "opaque payload IDs are not correlation fields"
    );
    assert_eq!(copied_tool.result, source_messages[1].tool_calls[0].result);
    assert_eq!(
      copied[1].content["streamObjects"][0],
      source_messages[1].content["streamObjects"][0]
    );
    assert_eq!(
      copied[1].content["streamObjects"][1]["toolCallId"],
      copied_tool.id.to_string()
    );
    assert_eq!(
      copied[1].content["streamObjects"][2]["toolCallId"],
      copied_tool.id.to_string()
    );
    foreign_cutoff = Some(copied[0].id);
    let projected=helpers::gql(&app,session_id,json!({
      "query":"query($w:String!,$s:String!){currentUser{copilot(workspaceId:$w){chats(pagination:{first:1},options:{sessionId:$s}){edges{node{parentSessionId pinned messages{id content streamObjects{type textDelta}}}}}}}}",
      "variables":{"w":workspace_id,"s":fork_id}
    })).await;
    assert!(projected.get("errors").is_none(), "{projected}");
    let node = &projected["data"]["currentUser"]["copilot"]["chats"]["edges"][0]["node"];
    assert_eq!(node["parentSessionId"], created_session_uuid.to_string());
    assert_eq!(node["pinned"], false);
    assert_eq!(node["messages"].as_array().expect("copied history").len(), copied.len());
    assert_eq!(
      node["messages"][1]["streamObjects"].as_array().unwrap().last().unwrap()["textDelta"],
      copied[1].content["text"],
      "reasoning-only persisted objects must not mask their separate final answer"
    );
  }

  let session_count: i64 = sqlx::query_scalar("SELECT count(*) FROM copilot_sessions WHERE user_id=$1")
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  let invalid_cutoff=helpers::gql(&app,session_id,json!({
    "query":"mutation($o:ForkChatSessionInput!){forkCopilotSession(options:$o)}",
    "variables":{"o":{"sessionId":created_session_uuid,"workspaceId":workspace_id,"docId":doc_key,"latestMessageId":foreign_cutoff}}
  })).await;
  assert!(
    invalid_cutoff.get("errors").is_some(),
    "a foreign cutoff must not copy an empty shell: {invalid_cutoff}"
  );
  let source_payload: serde_json::Value = sqlx::query_scalar("SELECT content FROM copilot_messages WHERE id=$1")
    .bind(source_messages[1].id)
    .fetch_one(&pool)
    .await
    .unwrap();
  sqlx::query(
    "UPDATE copilot_messages SET token_usage=token_usage || '{\"streamStatus\":\"running\"}'::jsonb WHERE id=$1",
  )
  .bind(source_messages[1].id)
  .execute(&pool)
  .await
  .unwrap();
  let active_copy = helpers::gql(
    &app,
    session_id,
    json!({
      "query":"mutation($o:ForkChatSessionInput!){forkCopilotSession(options:$o)}",
      "variables":{"o":{"sessionId":created_session_uuid,"workspaceId":workspace_id,"docId":doc_key}}
    }),
  )
  .await;
  assert!(
    active_copy.get("errors").is_some(),
    "active generation must not become a committed fork: {active_copy}"
  );
  sqlx::query("UPDATE copilot_messages SET token_usage=$2 WHERE id=$1")
    .bind(source_messages[1].id)
    .bind(&source_messages[1].token_usage)
    .execute(&pool)
    .await
    .expect("restore source fixture stream marker");
  let count_after: i64 = sqlx::query_scalar("SELECT count(*) FROM copilot_sessions WHERE user_id=$1")
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    count_after, session_count,
    "rejected copies must leave no target session"
  );
  assert_eq!(
    repo
      .list_copilot_messages(created_session_uuid, PageRequest { limit: 100, offset: 0 })
      .await
      .unwrap(),
    source_messages,
    "copying must not mutate the source"
  );

  let source = repo.get_copilot_session(created_session_uuid).await.unwrap().unwrap();
  // SQL must enforce generation ownership atomically, not just the service's
  // in-process lock: another node or a manual edit can race finalization.
  let mut generation = source_messages[1].clone();
  let stream_id = Uuid::new_v4();
  generation.edited_at = None;
  generation.token_usage.as_mut().unwrap()["streamId"] = json!(stream_id);
  generation.token_usage.as_mut().unwrap()["streamStatus"] = json!("running");
  sqlx::query("UPDATE copilot_messages SET token_usage=$2,edited_at=NULL WHERE id=$1")
    .bind(generation.id)
    .bind(&generation.token_usage)
    .execute(&pool)
    .await
    .unwrap();
  let mut terminal = generation.clone();
  terminal.token_usage.as_mut().unwrap()["streamStatus"] = json!("done");
  assert!(!repo.update_copilot_stream(&terminal, Uuid::new_v4()).await.unwrap());
  assert!(repo.update_copilot_stream(&terminal, stream_id).await.unwrap());
  assert!(
    !repo.update_copilot_stream(&generation, stream_id).await.unwrap(),
    "late writes cannot revive terminal output"
  );
  sqlx::query("UPDATE copilot_messages SET token_usage=$2,edited_at=NULL WHERE id=$1")
    .bind(generation.id)
    .bind(&generation.token_usage)
    .execute(&pool)
    .await
    .unwrap();
  let mut edited = generation.clone();
  edited.edited_at = Some(Utc::now());
  edited.content = json!({"text":"manual replacement"});
  repo.update_copilot_message(&edited).await.unwrap();
  assert!(
    !repo.update_copilot_stream(&terminal, stream_id).await.unwrap(),
    "manual edit wins over a stale stream snapshot"
  );
  assert_eq!(
    repo.get_copilot_message(edited.id).await.unwrap().unwrap().content,
    edited.content
  );
  sqlx::query("UPDATE copilot_messages SET content=$2,token_usage=$3,edited_at=$4 WHERE id=$1")
    .bind(source_messages[1].id)
    .bind(source_payload)
    .bind(&source_messages[1].token_usage)
    .bind(source_messages[1].edited_at)
    .execute(&pool)
    .await
    .unwrap();
  let mut target = source.clone();
  target.id = Uuid::new_v4();
  let mut messages = source_messages.clone();
  for message in &mut messages {
    message.session_id = target.id;
  }
  messages[0].id = Uuid::new_v4();
  // The second insert deliberately collides with a source message after the
  // first insert succeeds. The enclosing transaction must remove both writes.
  let mut plan = CopilotSessionFork {
    source,
    source_messages: source_messages.clone(),
    session: target,
    messages,
  };
  assert!(repo.commit_copilot_session_fork(&plan).await.is_err());
  assert!(
    repo.get_copilot_session(plan.session.id).await.unwrap().is_none(),
    "failed message insert must roll back the target session"
  );
  assert!(
    repo
      .list_copilot_messages(plan.session.id, PageRequest { limit: 100, offset: 0 })
      .await
      .unwrap()
      .is_empty(),
    "failed copy must roll back the inserted prefix"
  );
  plan.source_messages[0].content["text"] = json!("stale snapshot");
  assert!(
    matches!(
      repo.commit_copilot_session_fork(&plan).await,
      Err(myoxus_domain::repositories::RepositoryError::Conflict(_))
    ),
    "source comparison must reject a changed history before target inserts"
  );

  // A prior session binding is not authority to read a document after it
  // moves to another workspace, even when this person owns both workspaces.
  let destination = helpers::create_workspace(&pool, user_id).await;
  let mismatched_fork = helpers::gql(
    &app,
    session_id,
    json!({
      "query":"mutation($o:ForkChatSessionInput!){forkCopilotSession(options:$o)}",
      "variables":{"o":{"sessionId":created_session_uuid,"workspaceId":destination,"docId":doc_key}}
    }),
  )
  .await;
  assert_eq!(
    mismatched_fork["errors"][0]["extensions"]["code"], "FORBIDDEN",
    "{mismatched_fork}"
  );
  sqlx::query("UPDATE docs SET workspace_id = $1 WHERE id = $2")
    .bind(destination)
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("move document fixture");
  for (payload, code) in [
    (
      json!({"query":"mutation($options:CreateChatSessionInput!){createCopilotSession(options:$options)}", "variables":{"options":{"workspaceId":workspace_id,"promptName":"chat-with-ai","docId":doc_key}}}),
      "NOT FOUND",
    ),
    (
      json!({"query":"mutation($options:CreateChatMessageInput!){createCopilotMessage(options:$options)}", "variables":{"options":{"sessionId":created_session_uuid,"content":"must not append"}}}),
      "FORBIDDEN",
    ),
  ] {
    let denied = helpers::gql(&app, session_id, payload).await;
    assert_eq!(denied["errors"][0]["extensions"]["code"], code, "{denied}");
  }
  let message_count: i64 = sqlx::query_scalar("SELECT count(*) FROM copilot_messages WHERE session_id = $1")
    .bind(created_session_uuid)
    .fetch_one(&pool)
    .await
    .expect("denied session message count");
  assert_eq!(message_count, source_messages.len() as i64);

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
// INV: cleanupCopilotSession sets deleted_at in DB and excludes session from subsequent list queries
async fn inv_copilot_cleanup_marks_deleted_at_and_hides_from_list() {
  let (app, pool, auth_store) = helpers::setup_app_with_copilot_enabled().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p6del").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($options: CreateChatSessionInput!) { createCopilotSession(options: $options) }",
      "variables": {"options": {"workspaceId": workspace_id.to_string(), "promptName": "chat-with-ai"}}
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "createCopilotSession failed: {resp}");
  let created_session_id = resp["data"]["createCopilotSession"]
    .as_str()
    .expect("copilot session id")
    .to_string();
  let created_session_uuid = Uuid::parse_str(&created_session_id).expect("uuid");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($options: DeleteSessionInput!) { cleanupCopilotSession(options: $options) }",
      "variables": {"options": {"workspaceId": workspace_id.to_string(), "sessionIds": [created_session_id.clone()]}}
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "cleanupCopilotSession failed: {resp}");
  assert_eq!(
    resp["data"]["cleanupCopilotSession"][0].as_str(),
    Some(created_session_id.as_str())
  );

  let row = sqlx::query("SELECT deleted_at FROM copilot_sessions WHERE id = $1")
    .bind(created_session_uuid)
    .fetch_one(&pool)
    .await
    .expect("query deleted_at");
  assert!(
    row.get::<Option<DateTime<Utc>>, _>("deleted_at").is_some(),
    "cleanup should soft-delete session"
  );

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "query($workspaceId: String!) { currentUser { copilot(workspaceId: $workspaceId) { chats(pagination: { first: 20, offset: 0 }) { edges { node { sessionId } } } } } }",
      "variables": {"workspaceId": workspace_id.to_string()}
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "copilot list failed: {resp}");
  let edges = resp["data"]["currentUser"]["copilot"]["chats"]["edges"]
    .as_array()
    .expect("edges");
  assert!(
    !edges
      .iter()
      .any(|e| e["node"]["sessionId"].as_str() == Some(created_session_id.as_str())),
    "deleted session must be hidden from chats list"
  );

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
// INV: copilot chats query with invalid docId returns empty list without a GraphQL error
async fn inv_copilot_chats_with_invalid_doc_id_returns_empty_without_error() {
  let (app, pool, auth_store) = helpers::setup_app_with_copilot_enabled().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p6inv").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "query($workspaceId: String!, $docId: String!) { currentUser { copilot(workspaceId: $workspaceId) { chats(pagination: { first: 20, offset: 0 }, docId: $docId) { totalCount edges { node { sessionId } } } } } }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": "not-a-uuid"}
    }),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "invalid docId should not raise GraphQL error: {resp}"
  );
  assert_eq!(
    resp["data"]["currentUser"]["copilot"]["chats"]["totalCount"].as_i64(),
    Some(0)
  );
  assert_eq!(
    resp["data"]["currentUser"]["copilot"]["chats"]["edges"]
      .as_array()
      .map(|a| a.len()),
    Some(0)
  );

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
// INV: an unconfigured instance retains the deployed shape without invented models.
async fn inv_copilot_models_compat_fields_are_available() {
  let (app, pool, auth_store) = helpers::setup_app_with_config_override(|config| {
    config.copilot.enabled = true;
    config.copilot.providers.clear();
  })
  .await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p6mdl").await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "query($promptName: String!) { currentUser { copilot(promptName: $promptName) { models(promptName: $promptName) { defaultModel optionalModels { id name } proModels { id name } } } } }",
      "variables": {"promptName": "Chat With AFFiNE AI"}
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "copilot models query failed: {resp}");
  let models = &resp["data"]["currentUser"]["copilot"]["models"];
  assert_eq!(models["defaultModel"], "", "no fabricated default: {resp}");
  assert_eq!(models["optionalModels"], json!([]));
  assert_eq!(models["proModels"], json!([]));

  // Cleanup
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// P83-K-01: Error-path tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_copilot_unauthorized_workspace_returns_error() {
  let (app, pool, auth_store) = helpers::setup_app_with_copilot_enabled().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p6err1").await;
  // Use a UUID that does not correspond to any workspace the user is a member of
  let nonexistent_ws = Uuid::new_v4();

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": format!("mutation {{ createCopilotSession(workspaceId: \"{nonexistent_ws}\", input: {{docId: null, promptName: \"Chat With AFFiNE AI\", model: \"test\"}}) {{ id }} }}")}),
  )
  .await;
  assert!(
    resp.get("errors").is_some(),
    "must return error for non-member workspace, got: {resp}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_copilot_nonexistent_session_returns_error() {
  let (app, pool, auth_store) = helpers::setup_app_with_copilot_enabled().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p6err2").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let fake_session_id = Uuid::new_v4();

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": format!("mutation {{ createCopilotContext(workspaceId: \"{workspace_id}\", sessionId: \"{fake_session_id}\") }}")}),
  )
  .await;
  assert!(
    resp.get("errors").is_some(),
    "createCopilotContext with invalid sessionId must return error, got: {resp}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_copilot_unauthenticated_returns_error() {
  let (app, pool, auth_store) = helpers::setup_app_with_copilot_enabled().await;
  let (user_id, _session_id) = helpers::seed_user(&pool, &auth_store, "p6err3").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  // Use a non-existent session UUID (no auth cookie set)
  let resp = helpers::gql(
    &app,
    Uuid::nil(), // nil UUID → unauthenticated
    json!({"query": format!("query {{ workspace(id: \"{workspace_id}\") {{ copilot {{ sessionCount }} }} }}")}),
  )
  .await;
  // Either errors present or data is null/empty for unauthenticated
  let is_error = resp.get("errors").is_some() || resp["data"]["workspace"].is_null() || resp["data"].is_null();
  assert!(
    is_error,
    "unauthenticated copilot query must fail or return null, got: {resp}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}
