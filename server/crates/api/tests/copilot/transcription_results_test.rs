// SPDX-License-Identifier: AGPL-3.0-or-later
//! Real GraphQL readback and canonical repository transitions; no provider is invoked.

use crate::helpers;
use futures_util::FutureExt;
use myoxus_application::transcription::results::TranscriptionResultsService;
use myoxus_domain::transcription::{TranscriptionResponse, TranscriptionSegment};
use myoxus_infrastructure::transcription::results::PgTranscriptionResultRepository;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{panic::AssertUnwindSafe, sync::Arc};
use uuid::Uuid;

fn deadline() -> chrono::DateTime<chrono::Utc> {
  chrono::Utc::now() + chrono::Duration::seconds(60)
}

async fn ready_attempt(
  service: &TranscriptionResultsService,
  id: Uuid,
) -> myoxus_domain::transcription::AudioJobAttempt {
  let repository = service.repository();
  let mut attempt = repository.attempt(id).await.unwrap().unwrap();
  if attempt.job.state != myoxus_domain::entities::CopilotJobState::Pending {
    attempt = repository
      .retry_attempt(&attempt, attempt.job.payload.clone(), deadline())
      .await
      .unwrap()
      .unwrap();
  }
  repository.claim_attempt(id, attempt.id, 30).await.unwrap().unwrap()
}

async fn complete(
  service: &TranscriptionResultsService,
  id: Uuid,
  workspace: Uuid,
  blob: &str,
  model: &str,
  response: &TranscriptionResponse,
) -> Result<(), myoxus_application::auth::AuthError> {
  let attempt = ready_attempt(service, id).await;
  assert!(
    service
      .complete(id, workspace, blob, model, response, attempt.id)
      .await?
  );
  Ok(())
}

const FIELDS: &str = "id status title summary actions text segments { text startSeconds endSeconds speaker } transcription { transcription start end speaker }";

async fn claim(app: &axum::Router, session: Uuid, job: Uuid) -> Value {
  let response = helpers::gql(
    app,
    session,
    json!({"query":format!("mutation {{ claimAudioTranscription(jobId:\"{job}\") {{ {FIELDS} }} }}")}),
  )
  .await;
  assert!(response.get("errors").is_none(), "claim failed: {response}");
  response["data"]["claimAudioTranscription"].clone()
}

async fn list(app: &axum::Router, session: Uuid, workspace: Uuid, job: Option<Uuid>, blob: &str) -> Value {
  let response = helpers::gql(app, session, json!({
    "query":"query($workspace:String!,$job:String,$blob:String){currentUser{copilot(workspaceId:$workspace){audioTranscription(jobId:$job,blobId:$blob){RESULT_FIELDS}}}}".replace("RESULT_FIELDS",FIELDS),
    "variables":{"workspace":workspace.to_string(),"job":job.map(|id|id.to_string()),"blob":blob}
  })).await;
  assert!(response.get("errors").is_none(), "list failed: {response}");
  response["data"]["currentUser"]["copilot"]["audioTranscription"].clone()
}

pub(super) async fn cleanup(pool: &PgPool, workspaces: &[Uuid], users: &[Uuid]) {
  sqlx::query("DELETE FROM workspaces WHERE id = ANY($1)")
    .bind(workspaces)
    .execute(pool)
    .await
    .expect("delete owned workspaces");
  sqlx::query("DELETE FROM users WHERE id = ANY($1)")
    .bind(users)
    .execute(pool)
    .await
    .expect("delete owned users and sessions");
}

#[tokio::test]
async fn readback_and_claim_keep_complete_content_scoped_repeatable_and_restart_safe() {
  let (app, pool, store) = helpers::setup_app_with_copilot_enabled().await;
  let mut users = Vec::new();
  let mut workspaces = Vec::new();
  let result = AssertUnwindSafe(async {
    let owner = helpers::create_user(&pool,"audio-result-owner",false).await; users.push(owner);
    let stranger = helpers::create_user(&pool,"audio-result-stranger",false).await; users.push(stranger);
    let session = helpers::create_session(&store,owner).await;
    let other_session = helpers::create_session(&store,stranger).await;
    let workspace = helpers::create_workspace(&pool,owner).await; workspaces.push(workspace);
    let other_workspace = helpers::create_workspace(&pool,owner).await; workspaces.push(other_workspace);
    let service = TranscriptionResultsService::new(Arc::new(PgTranscriptionResultRepository::new(pool.clone())));
    let first = service.create_job(workspace,owner,json!({"blobId":"source-a"}), deadline()).await.expect("first audio job");
    let response = TranscriptionResponse { text:"Heute planen wir den Test.\nZweiter Satz.".into(), language:Some("de".into()),duration_seconds:Some(4.0),segments:vec![
      TranscriptionSegment {text:"Heute planen wir den Test.".into(),start_seconds:Some(1.5),end_seconds:Some(3.0),speaker:None},
      TranscriptionSegment {text:"Zweiter Satz.".into(),start_seconds:None,end_seconds:None,speaker:None},
    ]};
    complete(&service,first.id,workspace,"source-a","model-a",&response).await.expect("complete audio job");
    let expected = claim(&app,session,first.id).await;
    assert_eq!(expected["text"],response.text);
    assert_eq!(expected["segments"],json!([
      {"text":"Heute planen wir den Test.","startSeconds":1.5,"endSeconds":3.0,"speaker":null},
      {"text":"Zweiter Satz.","startSeconds":null,"endSeconds":null,"speaker":null},
    ]));
    assert_eq!(expected["transcription"],json!([
      {"transcription":"Heute planen wir den Test.","start":"1.5","end":"3","speaker":""},
      {"transcription":"Zweiter Satz.","start":"","end":"","speaker":""},
    ]));
    assert_eq!(expected["summary"],Value::Null,"speech content must not become a generated summary");
    assert_eq!(claim(&app,session,first.id).await,expected,"claim is not consumption");
    assert_eq!(list(&app,session,workspace,Some(first.id),"source-a").await,json!([expected.clone()]));
    assert_eq!(list(&app,session,other_workspace,Some(first.id),"source-a").await,json!([]));
    assert_eq!(list(&app,session,workspace,Some(first.id),"wrong-source").await,json!([]));
    let denied = helpers::gql(&app,other_session,json!({"query":format!("mutation{{claimAudioTranscription(jobId:\"{}\"){{text}}}}",first.id)})).await;
    assert_eq!(denied["errors"][0]["message"],"job not found");
    let non_audio = Uuid::new_v4();
    sqlx::query("INSERT INTO copilot_jobs (id,job_type,state,workspace_id,user_id,payload) VALUES ($1,'embedding','finished',$2,$3,$4)")
      .bind(non_audio).bind(workspace).bind(owner).bind(json!({"blobId":"source-a"})).execute(&pool).await.expect("non-audio job");
    assert!(service.complete(non_audio,workspace,"source-a","wrong-model",&response,Uuid::nil()).await.is_err());
    let denied = helpers::gql(&app,session,json!({"query":format!("mutation{{claimAudioTranscription(jobId:\"{non_audio}\"){{text}}}}") })).await;
    assert_eq!(denied["errors"][0]["message"],"job not found");

    let second = service.create_job(workspace,owner,json!({"blobId":"source-a"}), deadline()).await.expect("second recording job");
    complete(&service,second.id,workspace,"source-a","model-b",&TranscriptionResponse {text:"Zweite Aufnahme.".into(),language:None,duration_seconds:None,segments:vec![]}).await.expect("text-only completion");
    sqlx::query("UPDATE copilot_jobs SET updated_at = CASE WHEN id = $1 THEN '2026-01-01'::timestamptz ELSE '2026-01-02'::timestamptz END WHERE id IN ($1,$2)")
      .bind(first.id).bind(second.id).execute(&pool).await.expect("stable history order");
    sqlx::query("INSERT INTO copilot_jobs (id,job_type,state,workspace_id,user_id,payload) SELECT gen_random_uuid(),'embedding','finished',$1,$2,$3 FROM generate_series(1,55)")
      .bind(workspace).bind(owner).bind(json!({"blobId":"source-a"})).execute(&pool).await.expect("unrelated newer jobs");
    let all = list(&app,session,workspace,None,"source-a").await;
    assert_eq!(all.as_array().expect("result list").len(),2);
    assert_eq!(all[0]["id"],second.id.to_string());
    assert_eq!(all[1]["id"],first.id.to_string());
    assert_eq!(all[0]["transcription"],json!([{ "transcription":"Zweite Aufnahme.","start":"","end":"","speaker":"" }]));
    assert_eq!(all[0]["segments"],json!([]));
    assert_eq!(claim(&app,session,first.id).await,expected,"a later source result cannot replace job identity");

    // A fresh production-shaped state reads the same durable result and session.
    let (restarted,_,_) = helpers::setup_app_with_copilot_enabled().await;
    assert_eq!(claim(&restarted,session,first.id).await,expected);
    let foreign_workspace = helpers::create_workspace(&pool,stranger).await;workspaces.push(foreign_workspace);
    let foreign_job = service.create_job(foreign_workspace,stranger,json!({"blobId":"source-a"}), deadline()).await.expect("foreign job");
    complete(&service,foreign_job.id,foreign_workspace,"source-a","model-a",&TranscriptionResponse {text:"Private foreign transcript.".into(),..response.clone()}).await.expect("foreign result");
    let rightful: Uuid = sqlx::query_scalar("SELECT transcription_result_id FROM copilot_jobs WHERE id = $1").bind(first.id).fetch_one(&pool).await.expect("rightful result identity");
    let foreign: Uuid = sqlx::query_scalar("SELECT transcription_result_id FROM copilot_jobs WHERE id = $1").bind(foreign_job.id).fetch_one(&pool).await.expect("foreign result identity");
    sqlx::query("UPDATE copilot_jobs SET transcription_result_id = $2 WHERE id = $1").bind(first.id).bind(foreign).execute(&pool).await.expect("malformed cross-workspace pointer fixture");
    assert_eq!(claim(&app,session,first.id).await["text"],Value::Null,"a pointer cannot cross the job's workspace/source scope");
    sqlx::query("UPDATE copilot_jobs SET transcription_result_id = $2 WHERE id = $1").bind(first.id).bind(rightful).execute(&pool).await.expect("restore rightful identity");

    // Post-upgrade fixtures cover both deployed storage shapes. The migration
    // owner separately proves that normal startup produces these bindings.
    for (source, payload, content, segments, metadata) in [
      ("legacy-payload", json!({"text":"Alter vollständiger Text.","segments":[]}), "Alter vollständiger Text.", json!([]), json!({})),
      ("legacy-row", json!({"text":"Conflicting historical payload"}), "Kanonischer vollständiger Text.", json!([{ "text":"Kanonischer vollständiger Text.","start":0.5,"end":1.5 }]), json!({"title":"Stored title","summary":"Stored historical notes","action_items":"Stored historical action"})),
    ] {
      let legacy = service.create_job(workspace,owner,json!({"blobId":source,"transcription":payload}), deadline()).await.expect("legacy job shape");
      let result: Uuid = sqlx::query_scalar("INSERT INTO copilot_transcripts (workspace_id,source_type,source_id,content,segments,model,metadata,status) VALUES ($1,'audio',$2,$3,$4,'historical-model',$5,'completed') RETURNING id")
        .bind(workspace).bind(if source == "legacy-payload" { legacy.id.to_string() } else { source.to_string() }).bind(content).bind(&segments).bind(&metadata).fetch_one(&pool).await.expect("canonical historical row");
      sqlx::query("UPDATE copilot_jobs SET transcription_result_id = $2,state = 'finished' WHERE id = $1").bind(legacy.id).bind(result).execute(&pool).await.expect("migrated result binding");
      let stored = claim(&app,session,legacy.id).await;
      assert_eq!(stored["text"],content);
      assert_eq!(stored["summary"],metadata.get("summary").cloned().unwrap_or(Value::Null));
      assert_eq!(stored["title"],metadata.get("title").cloned().unwrap_or(Value::Null));
      assert_eq!(stored["actions"],metadata.get("action_items").cloned().unwrap_or(Value::Null));
      assert_eq!(stored["transcription"][0]["transcription"],content);
      assert_eq!(stored["transcription"][0]["speaker"],"");
      assert_eq!(stored["transcription"][0]["start"],if segments.as_array().expect("segments").is_empty() { "" } else { "0.5" });
      assert_eq!(claim(&app,session,legacy.id).await,stored);
      assert_eq!(claim(&restarted,session,legacy.id).await,stored);
      assert_eq!(list(&app,session,workspace,Some(legacy.id),source).await,json!([stored]));
      assert_eq!(list(&app,session,other_workspace,Some(legacy.id),source).await,json!([]));
      assert_eq!(list(&app,session,workspace,Some(legacy.id),"wrong-source").await,json!([]));
      let denied = helpers::gql(&app,other_session,json!({"query":format!("mutation{{claimAudioTranscription(jobId:\"{}\"){{text}}}}",legacy.id)})).await;
      assert_eq!(denied["errors"][0]["message"],"job not found");
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM copilot_transcripts WHERE workspace_id = $1").bind(workspace).fetch_one(&pool).await.expect("canonical count");
    assert_eq!(count,4,"readback and restart must create no results");
  }).catch_unwind().await;
  cleanup(&pool, &workspaces, &users).await;
  if let Err(panic) = result {
    std::panic::resume_unwind(panic)
  }
}

#[tokio::test]
async fn failed_refresh_keeps_prior_text_and_deletion_retains_source_and_other_models() {
  let (app, pool, store) = helpers::setup_app_with_copilot_enabled().await;
  let mut users = Vec::new();
  let mut workspaces = Vec::new();
  let result = AssertUnwindSafe(async {
    let user = helpers::create_user(&pool, "audio-refresh-owner", false).await;
    users.push(user);
    let session = helpers::create_session(&store, user).await;
    let workspace = helpers::create_workspace(&pool, user).await;
    workspaces.push(workspace);
    let service = TranscriptionResultsService::new(Arc::new(PgTranscriptionResultRepository::new(pool.clone())));
    sqlx::query(
      "INSERT INTO blobs (workspace_id,key,size,mime,status) VALUES ($1,'source-a',42,'audio/wav','completed')",
    )
    .bind(workspace)
    .execute(&pool)
    .await
    .expect("existing audio metadata");
    let job = service
      .create_job(workspace, user, json!({"blobId":"source-a"}), deadline())
      .await
      .expect("audio job");
    let original = TranscriptionResponse {
      text: "Erhaltenes Protokoll.".into(),
      language: None,
      duration_seconds: None,
      segments: vec![],
    };
    complete(&service, job.id, workspace, "source-a", "model-a", &original)
      .await
      .expect("initial result");
    assert!(
      service
        .complete(job.id, workspace, "wrong-source", "wrong-model", &original, Uuid::nil())
        .await
        .is_err()
    );
    assert!(
      service
        .complete(job.id, Uuid::new_v4(), "source-a", "wrong-model", &original, Uuid::nil())
        .await
        .is_err()
    );
    let replacement = ready_attempt(&service, job.id).await;
    service
      .fail(
        job.id,
        workspace,
        "source-a",
        "timeout: speech request deadline exceeded",
        replacement.id,
        1,
      )
      .await
      .expect("failed replacement");
    let failed = claim(&app, session, job.id).await;
    assert_eq!(failed["status"], "Failed");
    assert_eq!(failed["text"], original.text);
    let new = TranscriptionResponse {
      text: "Neues Protokoll.".into(),
      ..original.clone()
    };
    complete(&service, job.id, workspace, "source-a", "model-b", &new)
      .await
      .expect("successful replacement");
    assert_eq!(claim(&app, session, job.id).await["text"], new.text);
    service
      .delete_result(job.id, workspace)
      .await
      .expect("delete active result");
    let deleted = claim(&app, session, job.id).await;
    assert_eq!(deleted["text"], Value::Null);
    assert_eq!(deleted["transcription"], Value::Null);
    let retained: Vec<(String, String)> =
      sqlx::query_as("SELECT model,content FROM copilot_transcripts WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_all(&pool)
        .await
        .expect("preserved models");
    assert_eq!(retained, vec![("model-a".into(), original.text)]);
    // Several migrated jobs can share one historical blob-scoped result.
    let old_result: Uuid = sqlx::query_scalar("UPDATE copilot_transcripts SET source_id = 'source-a' WHERE workspace_id = $1 AND model = 'model-a' RETURNING id")
      .bind(workspace).fetch_one(&pool).await.expect("historical shared result");
    let mut shared = Vec::new();
    for _ in 0..3 {
      let linked = service.create_job(workspace,user,json!({"blobId":"source-a"}), deadline()).await.expect("shared legacy job");
      sqlx::query("UPDATE copilot_jobs SET transcription_result_id = $2,state = 'finished' WHERE id = $1").bind(linked.id).bind(old_result).execute(&pool).await.expect("legacy shared binding");
      shared.push(linked.id);
    }
    service.delete_result(shared[0],workspace).await.expect("detach one shared result");
    assert_eq!(claim(&app,session,shared[1]).await["text"],"Erhaltenes Protokoll.");
    let (first,last) = tokio::join!(service.delete_result(shared[1],workspace),service.delete_result(shared[2],workspace));
    first.expect("first concurrent detach");last.expect("last concurrent detach");
    service.delete_result(shared[0],workspace).await.expect("repeat deletion");
    let results: i64 = sqlx::query_scalar("SELECT count(*) FROM copilot_transcripts WHERE workspace_id = $1").bind(workspace).fetch_one(&pool).await.expect("shared result cleanup");
    assert_eq!(results,0,"only the last explicit detach removes a shared result");
    let other_source = service.create_job(workspace,user,json!({"blobId":"another-source"}), deadline()).await.expect("other source job");
    complete(&service,other_source.id,workspace,"another-source","model-a",&new).await.expect("other source result");
    let other_result: Uuid = sqlx::query_scalar("SELECT transcription_result_id FROM copilot_jobs WHERE id = $1").bind(other_source.id).fetch_one(&pool).await.expect("other source identity");
    sqlx::query("UPDATE copilot_jobs SET transcription_result_id = CASE WHEN id = $1 THEN $3 ELSE NULL END WHERE id IN ($1,$2)").bind(job.id).bind(other_source.id).bind(other_result).execute(&pool).await.expect("malformed same-workspace source fixture");
    service.delete_result(job.id,workspace).await.expect("detach malformed pointer");
    let preserved: String = sqlx::query_scalar("SELECT content FROM copilot_transcripts WHERE id = $1").bind(other_result).fetch_one(&pool).await.expect("wrong-source content retained");
    assert_eq!(preserved,new.text,"a malformed result pointer cannot authorize deletion of another audio source");
    let source: (i64, String, Option<chrono::DateTime<chrono::Utc>>) =
      sqlx::query_as("SELECT size,status,deleted_at FROM blobs WHERE workspace_id = $1 AND key = 'source-a'")
        .bind(workspace)
        .fetch_one(&pool)
        .await
        .expect("original source remains");
    assert_eq!(source, (42, "completed".into(), None));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM copilot_jobs WHERE id = $1")
      .bind(job.id)
      .fetch_one(&pool)
      .await
      .expect("retained durable job");
    assert_eq!(count, 1);
  })
  .catch_unwind()
  .await;
  cleanup(&pool, &workspaces, &users).await;
  if let Err(panic) = result {
    std::panic::resume_unwind(panic)
  }
}

#[tokio::test]
async fn postgres_attempt_identity_recovery_and_delete_reject_late_writes() {
  let pool = helpers::setup_pool().await;
  let mut users = Vec::new();
  let mut workspaces = Vec::new();
  let outcome = AssertUnwindSafe(async {
    let user = helpers::create_user(&pool, "audio-attempt-owner", false).await;
    users.push(user);
    let workspace = helpers::create_workspace(&pool, user).await;
    workspaces.push(workspace);
    let service = TranscriptionResultsService::new(Arc::new(PgTranscriptionResultRepository::new(pool.clone())));
    let repository = service.repository();
    let job = service
      .create_job(workspace, user, json!({"blobId":"source"}), deadline())
      .await
      .unwrap();
    let first = ready_attempt(&service, job.id).await;
    assert!(
      repository.claim_attempt(job.id, first.id, 1).await.unwrap().is_none(),
      "duplicate delivery cannot claim running work"
    );
    let text = TranscriptionResponse {
      text: "Erhaltener Text.".into(),
      language: None,
      duration_seconds: None,
      segments: vec![],
    };
    assert!(
      service
        .complete(job.id, workspace, "source", "model-a", &text, first.id)
        .await
        .unwrap()
    );
    let prior = repository.attempt(job.id).await.unwrap().unwrap();
    let (one, two) = tokio::join!(
      repository.retry_attempt(&prior, prior.job.payload.clone(), deadline()),
      repository.retry_attempt(&prior, prior.job.payload.clone(), deadline())
    );
    assert_eq!(
      usize::from(one.unwrap().is_some()) + usize::from(two.unwrap().is_some()),
      1,
      "only one concurrent retry wins"
    );
    let second = ready_attempt(&service, job.id).await;
    assert!(
      !service
        .complete(
          job.id,
          workspace,
          "source",
          "model-a",
          &TranscriptionResponse {
            text: "Late old text".into(),
            ..text.clone()
          },
          first.id
        )
        .await
        .unwrap()
    );
    assert!(
      !service
        .fail(job.id, workspace, "source", "late old error", first.id, 2)
        .await
        .unwrap()
    );
    sqlx::query("UPDATE copilot_jobs SET transcription_lease_until=now()-interval '1 second' WHERE id=$1")
      .bind(job.id)
      .execute(&pool)
      .await
      .unwrap();
    let recovered = repository.recover(2, 1).await.unwrap();
    let pending = recovered
      .iter()
      .find(|a| a.job.id == job.id)
      .expect("stale running attempt is redispatched");
    assert_ne!(pending.id, second.id);
    let third = repository.claim_attempt(job.id, pending.id, 1).await.unwrap().unwrap();
    assert_eq!(third.attempts, 2);
    assert!(
      service
        .fail(job.id, workspace, "source", "request timeout", third.id, 2)
        .await
        .unwrap()
    );
    assert_eq!(
      repository.attempt(job.id).await.unwrap().unwrap().job.state,
      myoxus_domain::entities::CopilotJobState::Failed
    );
    assert_eq!(
      repository
        .query(&myoxus_domain::transcription::TranscriptionResultQuery {
          user_id: user,
          workspace_id: Some(workspace),
          job_id: Some(job.id),
          blob_id: Some("source".into())
        })
        .await
        .unwrap()[0]
        .transcript
        .as_ref()
        .unwrap()
        .response
        .text,
      text.text
    );
    let refresh = ready_attempt(&service, job.id).await;
    service.delete_result(job.id, workspace).await.unwrap();
    assert!(
      !service
        .complete(job.id, workspace, "source", "model-b", &text, refresh.id)
        .await
        .unwrap(),
      "delete must invalidate a running publisher"
    );
    assert!(
      repository
        .query(&myoxus_domain::transcription::TranscriptionResultQuery {
          user_id: user,
          workspace_id: Some(workspace),
          job_id: Some(job.id),
          blob_id: None
        })
        .await
        .unwrap()[0]
        .transcript
        .is_none()
    );
    let legacy = service.create_job(workspace,user,json!({"blobId":"legacy-source","transcriptionConfig":{"request_timeout_ms":1000}}),deadline()).await.unwrap();
    sqlx::query("UPDATE copilot_jobs SET transcription_deadline=NULL, transcription_attempt_id=NULL, created_at=now()-interval '3 days' WHERE id=$1").bind(legacy.id).execute(&pool).await.unwrap();
    let upgraded=repository.recover(2,1).await.unwrap();
    let admitted=upgraded.iter().find(|a|a.job.id==legacy.id).expect("deployed valid work receives a bounded first execution window");
    assert!(admitted.deadline>chrono::Utc::now());
    assert!(admitted.deadline<=chrono::Utc::now()+chrono::Duration::seconds(5));
    assert_eq!(admitted.job.payload["blobId"],"legacy-source");
    let expired = service
      .create_job(
        workspace,
        user,
        json!({"blobId":"missing"}),
        chrono::Utc::now() - chrono::Duration::seconds(1),
      )
      .await
      .unwrap();
    repository.recover(2, 1).await.unwrap();
    assert_eq!(
      repository.attempt(expired.id).await.unwrap().unwrap().job.state,
      myoxus_domain::entities::CopilotJobState::Failed
    );
  })
  .catch_unwind()
  .await;
  cleanup(&pool, &workspaces, &users).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

struct EnrichmentProviderFixture {
  calls: std::sync::atomic::AtomicUsize,
  fail: std::sync::atomic::AtomicBool,
}
#[async_trait::async_trait]
impl myoxus_application::copilot::provider::LlmProvider for EnrichmentProviderFixture {
  fn provider_id(&self) -> &str {
    "openai"
  }
  async fn list_models(
    &self,
  ) -> Result<
    Vec<myoxus_application::copilot::provider::LlmModelInfo>,
    myoxus_application::copilot::provider::LlmProviderError,
  > {
    Ok(vec![])
  }
  async fn complete(
    &self,
    request: &myoxus_application::copilot::provider::LlmRequest,
  ) -> Result<myoxus_application::copilot::provider::LlmResponse, myoxus_application::copilot::provider::LlmProviderError>
  {
    use myoxus_application::copilot::provider::{LlmProviderError, LlmResponse};
    use std::sync::atomic::Ordering;
    self.calls.fetch_add(1, Ordering::SeqCst);
    assert_eq!(
      request.messages[1].content.as_text(),
      Some("Wir treffen uns am Montag.")
    );
    if self.fail.load(Ordering::SeqCst) {
      return Err(LlmProviderError::InvalidRequest("sensitive provider body".into()));
    }
    Ok(LlmResponse {
      model: request.model.clone(),
      output_text: if request.messages[0].content.as_text().unwrap().starts_with("Summarize") {
        "Treffen am Montag.".into()
      } else {
        "- Treffen vorbereiten.".into()
      },
      finish_reason: None,
      reasoning: None,
      tool_calls: vec![],
      usage: None,
      raw_payload: json!({}),
    })
  }
}

#[tokio::test]
async fn enrichment_is_explicit_scoped_and_failure_cannot_regress_speech() {
  use myoxus_application::{
    admin::AdminService, auth::AuthService, copilot::provider::LlmProviderRegistry, doc::DocService,
    ports::blob_service::BlobService, workspace::WorkspaceService,
  };
  use myoxus_infrastructure::{
    admin::SqlxAdminStore, blob::SqlxBlobStore, doc::SqlxDocStore, storage::StorageAdapter,
    workspace::SqlxWorkspaceStore,
  };
  use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
  let (_, pool, store) = helpers::setup_app().await;
  let root = tempfile::tempdir().unwrap();
  let storage = Arc::new(StorageAdapter::new_fs(root.path().to_str().unwrap()).unwrap());
  let mut config = myoxus_api::config::AppConfig::load().unwrap();
  config.copilot.enabled = true;
  config.copilot.providers.get_mut("openai").unwrap().enabled = true;
  config.copilot.fallback_providers.clear();
  let baseline = config.clone();
  let provider = Arc::new(EnrichmentProviderFixture {
    calls: AtomicUsize::new(0),
    fail: AtomicBool::new(false),
  });
  let mut registry = LlmProviderRegistry::new();
  registry.register(provider.clone());
  let state = myoxus_api::state::ApiState::with_services(
    config,
    AuthService::new(
      store.clone(),
      Arc::new(myoxus_infrastructure::mail::LogMailAdapter),
      storage.clone(),
      86400,
      3600,
    ),
    WorkspaceService::new(Arc::new(SqlxWorkspaceStore::new(
      pool.clone(),
      crate::helpers::database_starter_catalog(),
    ))),
    AdminService::new(Arc::new(SqlxAdminStore::new(pool.clone()))),
    DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))),
    Arc::new(BlobService::new(
      Arc::new(SqlxBlobStore::new(pool.clone())),
      storage.clone(),
      "test-key".into(),
    )),
    storage,
  )
  .with_metrics_pool(pool.clone())
  .with_config_file_baseline(baseline)
  .with_llm_provider_registry(registry);
  let app = myoxus_api::build_router_for_integration_tests(state.clone());
  let owner = helpers::create_user(&pool, "enrichment-owner", false).await;
  let stranger = helpers::create_user(&pool, "enrichment-stranger", false).await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let other_workspace = helpers::create_workspace(&pool, owner).await;
  let result = AssertUnwindSafe(async {
    sqlx::query("UPDATE workspaces SET enable_ai = true WHERE id = $1").bind(workspace).execute(&pool).await.unwrap();
    let session = helpers::create_session(&store, owner).await;
    let stranger_session = helpers::create_session(&store, stranger).await;
    let service = TranscriptionResultsService::new(Arc::new(PgTranscriptionResultRepository::new(pool.clone())));
    let job = service.create_job(workspace, owner, json!({"blobId":"retained-source"}), deadline()).await.unwrap();
    let speech = TranscriptionResponse { text: "Wir treffen uns am Montag.".into(), language: Some("de".into()), duration_seconds: None, segments: vec![] };
    complete(&service, job.id, workspace, "retained-source", "speech-test", &speech).await.unwrap();
    let before = claim(&app, session, job.id).await;
    let count = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM copilot_jobs WHERE workspace_id = $1 AND job_type = 'audio_enrichment'").bind(workspace).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 0, "speech and readback must not invoke enrichment");
    let request = |workspace: Uuid| json!({"query":"mutation($workspace:String!,$job:String!){enrichAudioTranscription(workspaceId:$workspace,jobId:$job,summary:true,actions:true){id status errorMessage summary actions}}", "variables":{"workspace":workspace.to_string(),"job":job.id.to_string()}});
    let denied = helpers::gql(&app, stranger_session, request(workspace)).await;
    assert!(denied.get("errors").is_some(), "foreign owner must be rejected");
    let denied = helpers::gql(&app, session, request(other_workspace)).await;
    assert!(denied.get("errors").is_some(), "wrong workspace must be rejected");
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0, "readback and rejected operations cannot call an LLM");
    let success = helpers::gql(&app, session, request(workspace)).await;
    assert!(success.get("errors").is_none(), "{success}");
    assert_eq!(success["data"]["enrichAudioTranscription"]["status"], "Finished");
    assert_eq!(success["data"]["enrichAudioTranscription"]["summary"], "Treffen am Montag.");
    assert_eq!(success["data"]["enrichAudioTranscription"]["actions"], "- Treffen vorbereiten.");
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    assert_eq!(claim(&app, session, job.id).await, before);
    provider.fail.store(true, Ordering::SeqCst);
    let response = helpers::gql(&app, session, request(workspace)).await;
    assert!(response.get("errors").is_none(), "{response}");
    assert_eq!(response["data"]["enrichAudioTranscription"]["status"], "Failed");
    assert_eq!(response["data"]["enrichAudioTranscription"]["summary"], "Treffen am Montag.");
    assert_eq!(response["data"]["enrichAudioTranscription"]["actions"], "- Treffen vorbereiten.");
    assert!(!response.to_string().contains("sensitive provider body"));
    assert_eq!(claim(&app, session, job.id).await, before, "LLM failure cannot alter speech content or state");
    let enrichment = helpers::gql(&app, session, json!({"query":format!("mutation {{claimAudioTranscription(jobId:\"{}\"){{status text enrichment{{status errorMessage}}}}}}",job.id)})).await;
    assert!(enrichment.get("errors").is_none(), "{enrichment}");
    assert_eq!(enrichment["data"]["claimAudioTranscription"]["enrichment"]["status"], "Failed");
    let source = service.repository().query(&myoxus_domain::transcription::TranscriptionResultQuery {
      user_id: owner, workspace_id: Some(workspace), job_id: Some(job.id), blob_id: Some("retained-source".into())
    }).await.unwrap().remove(0);
    let mut pending = service.repository().enrichment(&source).await.unwrap().unwrap();
    pending.id = Uuid::new_v4();
    pending.state = myoxus_domain::entities::CopilotJobState::Running;
    pending.created_at = chrono::Utc::now();
    pending.payload["deadline"] = json!(chrono::Utc::now().timestamp_millis() + 10000);
    let mut competing = pending.clone(); competing.id = Uuid::new_v4();
    let repository = service.repository();
    let (first, second) = tokio::join!(repository.begin_enrichment(&source, &pending), repository.begin_enrichment(&source, &competing));
    assert_ne!(first.unwrap(), second.unwrap(), "exactly one competing request is admitted");
    let mut active = repository.enrichment(&source).await.unwrap().unwrap();
    assert_eq!(active.state, myoxus_domain::entities::CopilotJobState::Running);
    sqlx::query("UPDATE copilot_jobs SET payload = jsonb_set(payload, '{deadline}', '0') WHERE id = $1").bind(active.id).execute(&pool).await.unwrap();
    active.state = myoxus_domain::entities::CopilotJobState::Finished;
    assert!(!repository.finish_enrichment(&source, &active).await.unwrap(), "expired attempt cannot publish");
    assert_eq!(repository.enrichment(&source).await.unwrap().unwrap().state, myoxus_domain::entities::CopilotJobState::Failed);
    let mut late = pending.clone(); late.id = Uuid::new_v4(); late.created_at = chrono::Utc::now();
    assert!(repository.begin_enrichment(&source, &late).await.unwrap());
    complete(&service, job.id, workspace, "retained-source", "speech-test", &speech).await.unwrap();
    late.state = myoxus_domain::entities::CopilotJobState::Finished;
    assert!(!repository.finish_enrichment(&source, &late).await.unwrap(), "refreshed speech rejects old LLM output even with the same result ID");
    let refreshed = repository.query(&myoxus_domain::transcription::TranscriptionResultQuery {
      user_id: owner, workspace_id: Some(workspace), job_id: Some(job.id), blob_id: None
    }).await.unwrap().remove(0);
    assert!(repository.enrichment(&refreshed).await.unwrap().is_none());
    let payload: Value = sqlx::query_scalar("SELECT payload FROM copilot_jobs WHERE id = $1").bind(job.id).fetch_one(&pool).await.unwrap();
    assert_eq!(payload["blobId"], "retained-source");
    sqlx::query("UPDATE workspaces SET enable_ai = false WHERE id = $1").bind(workspace).execute(&pool).await.unwrap();
    assert!(helpers::gql(&app, session, request(workspace)).await.get("errors").is_some(), "disabled workspace cannot transfer transcript to LLM");
    assert_eq!(claim(&app, session, job.id).await, before);
  }).catch_unwind().await;
  cleanup(&pool, &[workspace, other_workspace], &[owner, stranger]).await;
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}
