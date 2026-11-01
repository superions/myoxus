// SPDX-License-Identifier: AGPL-3.0-or-later
//! Public submission/retry with real PostgreSQL, Redis, blob storage and worker recovery.
//! Controlled HTTP responses protect failures; known speech uses the opt-in CPU fixture.

use crate::helpers;
use axum::{Json, body::Bytes, extract::State, http::StatusCode, routing::post};
use futures_util::FutureExt;
use myoxus_api::{config::AppConfig, state::ApiState};
use myoxus_application::{
  admin::AdminService, auth::AuthService, doc::DocService, ports::blob_service::BlobService,
  workspace::WorkspaceService,
};
use myoxus_infrastructure::{
  admin::SqlxAdminStore, auth::SqlxAuthStore, blob::SqlxBlobStore, doc::SqlxDocStore, storage::StorageAdapter,
  workspace::SqlxWorkspaceStore,
};
use myoxus_worker::{
  JobHandler, QueueConfig, RedisQueue, RuntimeConfig, WorkerRuntime,
  job::{Job, JobError},
};
use serde_json::{Value, json};
use std::{
  future::IntoFuture,
  panic::AssertUnwindSafe,
  sync::{
    Arc,
    atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering},
  },
  time::Duration,
};
use uuid::Uuid;

struct Endpoint {
  status: AtomicU16,
  calls: AtomicUsize,
  delay_ms: AtomicU64,
  empty: AtomicBool,
  changed_model_seen: AtomicBool,
}
async fn speech(State(endpoint): State<Arc<Endpoint>>, body: Bytes) -> (StatusCode, Json<Value>) {
  assert!(
    body.windows(4).any(|v| v == b"RIFF"),
    "transport must send actual encoded input"
  );
  assert!(
    body.windows(11).any(|v| v == b"test-speech"),
    "explicit model must reach the endpoint"
  );
  endpoint.calls.fetch_add(1, Ordering::SeqCst);
  if body
    .windows(b"test-speech-changed".len())
    .any(|value| value == b"test-speech-changed")
  {
    endpoint.changed_model_seen.store(true, Ordering::SeqCst);
  }
  tokio::time::sleep(Duration::from_millis(endpoint.delay_ms.load(Ordering::SeqCst))).await;
  let text = if endpoint.empty.load(Ordering::SeqCst) {
    ""
  } else {
    "Kontrollierter Transporttext."
  };
  (
    StatusCode::from_u16(endpoint.status.load(Ordering::SeqCst)).unwrap(),
    Json(
      json!({"text":text,"language":"de","duration":1.0,"segments":[{"text":"Kontrollierter Transporttext.","start":0.0,"end":1.0}]}),
    ),
  )
}

struct Handler(Arc<ApiState>);
#[async_trait::async_trait]
impl JobHandler for Handler {
  fn queue_name(&self) -> &str {
    "copilot"
  }
  async fn process(&self, job: &Job) -> Result<Option<Value>, JobError> {
    self
      .0
      .transcription_pipeline()
      .map_err(|e| JobError::Retryable(e.to_string()))?
      .process_queued(
        job
          .name
          .strip_prefix("copilot.transcript.")
          .expect("audio delivery action"),
        &job.id,
        &job.data,
        self.0.transcription_service().await,
        self.0.transcription_job_policy(),
      )
      .await
      .map_err(|e| JobError::Retryable(e.to_string()))?;
    Ok(None)
  }
  async fn recover(&self, attempts: u32, dispatch: u32) -> Result<(), String> {
    self
      .0
      .transcription_pipeline()
      .map_err(|e| e.to_string())?
      .recover(myoxus_application::transcription::pipeline::TranscriptionJobPolicy {
        max_attempts: attempts,
        dispatch_seconds: dispatch,
      })
      .await
      .map_err(|e| e.to_string())
  }
}
fn run_worker(state: Arc<ApiState>) -> (tokio::sync::watch::Sender<bool>, Vec<tokio::task::JoinHandle<()>>) {
  let (tx, rx) = tokio::sync::watch::channel(false);
  let mut runtime = WorkerRuntime::new(
    state.redis_queue().unwrap(),
    RuntimeConfig {
      poll_timeout_seconds: 1,
      stall_check_interval_ms: 1000,
      shutdown_timeout_seconds: 3,
      ..Default::default()
    },
    rx,
  );
  runtime.register(
    Handler(state),
    QueueConfig {
      concurrency: 1,
      max_attempts: 2,
      ..Default::default()
    },
  );
  (tx, runtime.spawn())
}
async fn stop_worker(tx: tokio::sync::watch::Sender<bool>, handles: Vec<tokio::task::JoinHandle<()>>) {
  tx.send(true).expect("request owned worker shutdown");
  for task in handles {
    tokio::time::timeout(Duration::from_secs(5), task)
      .await
      .expect("bounded worker shutdown")
      .expect("worker task");
  }
}
fn wav() -> Vec<u8> {
  let size = 16000_u32;
  let mut v = Vec::new();
  v.extend_from_slice(b"RIFF");
  v.extend_from_slice(&(36 + size).to_le_bytes());
  v.extend_from_slice(b"WAVEfmt ");
  v.extend_from_slice(&16_u32.to_le_bytes());
  v.extend_from_slice(&1_u16.to_le_bytes());
  v.extend_from_slice(&1_u16.to_le_bytes());
  v.extend_from_slice(&8000_u32.to_le_bytes());
  v.extend_from_slice(&16000_u32.to_le_bytes());
  v.extend_from_slice(&2_u16.to_le_bytes());
  v.extend_from_slice(&16_u16.to_le_bytes());
  v.extend_from_slice(b"data");
  v.extend_from_slice(&size.to_le_bytes());
  v.resize(44 + size as usize, 0);
  v
}
fn build_state(
  pool: sqlx::PgPool,
  auth: Arc<SqlxAuthStore>,
  root: &std::path::Path,
  queue: RedisQueue,
  endpoint: &str,
) -> ApiState {
  let mut config = AppConfig::load().unwrap();
  config.copilot.enabled = false;
  config.transcription.enabled = true;
  config.transcription.endpoint = endpoint.into();
  config.transcription.model = "test-speech".into();
  config.transcription.api_key = None;
  config.transcription.language = Some("de".into());
  config.transcription.request_timeout_ms = 1000;
  config.transcription.max_input_bytes = 100000;
  config.transcription.max_response_bytes = 10000;
  config.transcription.max_duration_seconds = 10;
  config.transcription.max_concurrency = 1;
  config.job.queue.attempts = 2;
  let storage = Arc::new(StorageAdapter::new_fs(root.to_str().unwrap()).unwrap());
  let blob = Arc::new(BlobService::new(
    Arc::new(SqlxBlobStore::new(pool.clone())),
    storage.clone(),
    "fixture-key".into(),
  ));
  let baseline = config.clone();
  ApiState::with_services(
    config,
    AuthService::new(
      auth,
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
    blob,
    storage,
  )
  .with_metrics_pool(pool)
  .with_config_file_baseline(baseline)
  .with_redis_queue(queue)
}
async fn result(app: &axum::Router, session: Uuid, id: Uuid) -> Value {
  let r=helpers::gql(app,session,json!({"query":format!("mutation{{claimAudioTranscription(jobId:\"{id}\"){{id status errorMessage text segments{{text startSeconds endSeconds speaker}}}}}}") })).await;
  assert!(r.get("errors").is_none(), "claim: {r}");
  r["data"]["claimAudioTranscription"].clone()
}
async fn wait(app: &axum::Router, session: Uuid, id: Uuid, status: &str) -> Value {
  tokio::time::timeout(Duration::from_secs(15), async {
    loop {
      let r = result(app, session, id).await;
      if r["status"] == status {
        return r;
      }
      tokio::time::sleep(Duration::from_millis(50)).await;
    }
  })
  .await
  .expect("job must reach its terminal state")
}
async fn submit(app: &axum::Router, session: Uuid, workspace: Uuid, blob: &str) -> Value {
  helpers::gql(app,session,json!({"query":"mutation($w:String!,$b:String!){submitAudioTranscription(workspaceId:$w,blobId:$b){id status}}","variables":{"w":workspace.to_string(),"b":blob}})).await
}

#[tokio::test]
async fn deployed_opus_mp4_input_is_inspected_without_transcoding() {
  use myoxus_application::transcription::{TranscriptionService, TranscriptionTransport, input::AudioInputInspector};
  struct NoTransport;
  #[async_trait::async_trait]
  impl TranscriptionTransport for NoTransport {
    fn provider_id(&self) -> &str {
      "inspection-test"
    }
  }
  let mut config = AppConfig::load().unwrap().transcription;
  config.endpoint = "http://inspection-test/v1".into();
  config.model = "inspection-test".into();
  config.request_timeout_ms = 2000;
  config.max_duration_seconds = 3;
  let service = TranscriptionService::new(true, config.execution_snapshot(), Arc::new(NoTransport), Arc::default());
  let admission = service.admit_job(None).unwrap();
  // This owned two-second sine fixture uses the same Opus/faststart MP4
  // container as deployed clients, without production decoding or FFmpeg.
  let audio = Bytes::from_static(include_bytes!("../fixtures/audio/opus-faststart-tone.mp4"));
  let input = myoxus_infrastructure::transcription::input::EncodedAudioInspector
    .inspect(audio.clone(), admission.input_work())
    .await
    .unwrap();
  assert_eq!(input.format, "mp4");
  assert!((input.duration_seconds - 2.0).abs() < 0.1);
  drop(admission);
  let mut short = config.execution_snapshot();
  short.max_duration_seconds = 1;
  let service = TranscriptionService::new(true, short, Arc::new(NoTransport), Arc::default());
  assert!(
    myoxus_infrastructure::transcription::input::EncodedAudioInspector
      .inspect(audio, service.admit_job(None).unwrap().input_work())
      .await
      .is_err()
  );
}

#[tokio::test]
async fn copilot_off_public_source_dispatch_recovery_and_retry_preserve_audio_and_text() {
  let pool = helpers::setup_pool().await;
  let auth = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let root = tempfile::tempdir().unwrap();
  let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".into());
  let prefix = format!("transcription-pipeline-{}", Uuid::new_v4());
  let queue = RedisQueue::new(&redis_url, &prefix).unwrap();
  let endpoint = Arc::new(Endpoint {
    status: AtomicU16::new(200),
    calls: AtomicUsize::new(0),
    delay_ms: AtomicU64::new(0),
    empty: AtomicBool::new(false),
    changed_model_seen: AtomicBool::new(false),
  });
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let origin = format!("http://{}/v1", listener.local_addr().unwrap());
  let http = tokio::spawn(
    axum::serve(
      listener,
      axum::Router::new()
        .route("/v1/audio/transcriptions", post(speech))
        .with_state(endpoint.clone()),
    )
    .into_future(),
  );
  let state = Arc::new(build_state(
    pool.clone(),
    auth.clone(),
    root.path(),
    queue.clone(),
    &origin,
  ));
  let app = myoxus_api::build_router_for_integration_tests((*state).clone());
  let mut users = Vec::new();
  let mut workspaces = Vec::new();
  let mut worker = None;
  let outcome = AssertUnwindSafe(async {
    let user = helpers::create_user(&pool, "pipeline-owner", false).await;
    users.push(user);
    let other = helpers::create_user(&pool, "pipeline-stranger", false).await;
    users.push(other);
    let session = helpers::create_session(&auth, user).await;
    let stranger = helpers::create_session(&auth, other).await;
    let workspace = helpers::create_workspace(&pool, user).await;
    workspaces.push(workspace);
    let foreign = helpers::create_workspace(&pool, other).await;
    workspaces.push(foreign);
    let bytes = wav();
    let blob = helpers::upload_blob(&app, session, workspace, "source.wav", "audio/wav", &bytes).await;
    assert!(submit(&app, stranger, workspace, &blob).await.get("errors").is_some());
    assert!(submit(&app, session, foreign, &blob).await.get("errors").is_some());
    assert!(
      submit(&app, session, workspace, "missing.wav")
        .await
        .get("errors")
        .is_some()
    );
    assert_eq!(
      endpoint.calls.load(Ordering::SeqCst),
      0,
      "invalid admission must never contact a provider"
    );
    let submitted = submit(&app, session, workspace, &blob).await;
    assert!(submitted.get("errors").is_none(), "submit: {submitted}");
    let id = Uuid::parse_str(submitted["data"]["submitAudioTranscription"]["id"].as_str().unwrap()).unwrap();
    assert_eq!(submitted["data"]["submitAudioTranscription"]["status"], "Pending");
    clear_queue(&redis_url, &prefix).await;
    worker = Some(run_worker(state.clone()));
    let done = wait(&app, session, id, "Finished").await;
    assert_eq!(done["text"], "Kontrollierter Transporttext.");
    assert_eq!(done["segments"][0]["startSeconds"], 0.0);
    assert_eq!(result(&app, session, id).await, done, "claim is repeatable");
    for (status,empty,delay) in [(401,false,0),(404,false,0),(200,true,0),(200,false,1500)] {
      endpoint.status.store(status,Ordering::SeqCst);
      endpoint.empty.store(empty,Ordering::SeqCst);
      endpoint.delay_ms.store(delay,Ordering::SeqCst);
      let retried=helpers::gql(&app,session,json!({"query":"mutation($w:String!,$j:String!){retryAudioTranscription(workspaceId:$w,jobId:$j){id status}}","variables":{"w":workspace.to_string(),"j":id.to_string()}})).await;
      assert!(retried.get("errors").is_none(),"retry: {retried}");
      let failed=wait(&app,session,id,"Failed").await;
      assert_eq!(failed["text"],done["text"],"failed refresh retains prior content");
      assert!(failed["errorMessage"].as_str().is_some_and(|message| !message.is_empty()), "public consumers need the existing durable failure explanation");
      assert_eq!(state.blob_service().get_blob_bounded(workspace,&blob,100000).await.unwrap().data.as_ref(),bytes);
    }
    endpoint.empty.store(false,Ordering::SeqCst);
    endpoint.delay_ms.store(0,Ordering::SeqCst);
    state.config_overrides.write().await.overrides.insert("transcription.endpoint".into(),json!("http://127.0.0.1:1/v1"));
    let retried=helpers::gql(&app,session,json!({"query":"mutation($w:String!,$j:String!){retryAudioTranscription(workspaceId:$w,jobId:$j){id status}}","variables":{"w":workspace.to_string(),"j":id.to_string()}})).await;
    assert!(retried.get("errors").is_none());
    assert_eq!(wait(&app,session,id,"Failed").await["text"],done["text"],"endpoint loss retains content");
    {
      let mut settings=state.config_overrides.write().await;
      settings.overrides.insert("transcription.endpoint".into(),json!(&origin));
      settings.overrides.insert("transcription.model".into(),json!("test-speech-changed"));
    }
    endpoint.status.store(200, Ordering::SeqCst);
    let r = helpers::gql(
      &app,
      stranger,
      json!({"query":format!("mutation{{retryAudioTranscription(workspaceId:\"{workspace}\",jobId:\"{id}\"){{id}}}}") }),
    )
    .await;
    assert!(r.get("errors").is_some());
    let r = helpers::gql(
      &app,
      session,
      json!({"query":format!("mutation{{retryAudioTranscription(workspaceId:\"{workspace}\",jobId:\"{id}\"){{id}}}}") }),
    )
    .await;
    assert!(r.get("errors").is_none());
    assert_eq!(wait(&app, session, id, "Finished").await["text"], done["text"]);
    assert!(endpoint.changed_model_seen.load(Ordering::SeqCst),"retry sends the explicitly current model");
    let stored_model:String=sqlx::query_scalar("SELECT payload#>>'{transcriptionConfig,model}' FROM copilot_jobs WHERE id=$1").bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(stored_model,"test-speech-changed");
    let restart = myoxus_api::build_router_for_integration_tests(build_state(
      pool.clone(),
      auth.clone(),
      root.path(),
      queue.clone(),
      &origin,
    ));
    assert_eq!(result(&restart, session, id).await["text"], done["text"]);
  })
  .catch_unwind()
  .await;
  if let Some((shutdown, handles)) = worker {
    stop_worker(shutdown, handles).await;
  }
  http.abort();
  assert!(http.await.unwrap_err().is_cancelled());
  crate::transcription_results_test::cleanup(&pool, &workspaces, &users).await;
  clear_queue(&redis_url, &prefix).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

// Remove only this fixture's delivery namespace, simulating loss of Redis data.
async fn clear_queue(redis_url: &str, prefix: &str) {
  let mut connection = redis::Client::open(redis_url)
    .unwrap()
    .get_multiplexed_async_connection()
    .await
    .unwrap();
  let mut cursor = 0_u64;
  loop {
    let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
      .arg(cursor)
      .arg("MATCH")
      .arg(format!("{prefix}:*"))
      .arg("COUNT")
      .arg(100)
      .query_async(&mut connection)
      .await
      .unwrap();
    if !keys.is_empty() {
      let _: usize = redis::cmd("DEL").arg(keys).query_async(&mut connection).await.unwrap();
    }
    cursor = next;
    if cursor == 0 {
      break;
    }
  }
}
